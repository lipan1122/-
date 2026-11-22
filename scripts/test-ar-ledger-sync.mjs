#!/usr/bin/env node
/**
 * AR 账户总账 ↔ 协议单位逐笔台账 同步验收（第九轮整改清单一、3）
 *
 * ── 缺陷 ──
 * 挂账写 ar_ledgers（协议单位逐笔台账），账户汇总读 ar_accounts + ar_transactions。
 * 第八轮把「挂账」做成了双写，但「收款 / 转账 / 坏账核销」仍然只动账户总账：
 *   · 收款后账户余额减少，协议单位台账未结一动不动；
 *   · 核销后账户核销了坏账，台账仍显示未结；
 *   · 转账两个账户一增一减，两个协议单位的台账都没动。
 * 结果：账户余额与逐笔台账两个数，财务和协议客户对账必然失败。
 *
 * ── 修法（清单第 100-113 行）──
 * 入账、还款、转账、核销在**同一事务**内同步四张表：
 *   ar_ledgers / ar_accounts / ar_transactions / ar_write_offs
 *   · 挂账（+账户入账）：ledger 新增 CHARGE，账户余额增加
 *   · 收款：ledger.settled_amount 增加（FIFO），账户余额减少
 *   · 转账：源单位 FIFO 冲减 + TRANSFER_OUT 审计行；目标单位新增 TRANSFER_IN；两边账户各一条流水
 *   · 核销：ledger.settled_amount 增加，ar_write_offs 逐条记到 ar_ledger_id，账户余额减少
 *   · 失败 / 拒绝：整体回滚（四张表都不动）
 *
 * ── 本脚本断言（清单第 115-122 行）──
 *   1. 挂账后账户与逐笔台账一致
 *   2. 收款后两边同时减少
 *   3. 转账前后两边余额一致（含两条腿的明细）
 *   4. 核销后两边余额一致（含核销记录指向台账）
 *   5. 重复 request_id 不重复记账
 *   6. 跨酒店账户不能操作
 *
 * ── 隔离 ──
 * data/pms.db --VACUUM INTO--> .tmp/ar-ledger-sync-<时间戳>.db 注入 globalThis.__pmsDb，
 * 写入只进副本；结尾只读复查真库零写入。
 *
 * 运行：node scripts/test-ar-ledger-sync.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
const STAMP = `${Date.now()}`;
const COPY_DB = path.join(TMP_DIR, `ar-ledger-sync-${STAMP}.db`);
const STUB_FILE = path.join(TMP_DIR, `ar-ledger-sync-stub-${STAMP}.mjs`);
const H = 1;
const HOTEL_B = 998;
const PREFIX = `T-ARS-${STAMP}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function cleanup() {
  for (const f of [COPY_DB, `${COPY_DB}-wal`, `${COPY_DB}-shm`, STUB_FILE]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 已删 / 被占用 */
    }
  }
}
process.on("exit", cleanup);
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* ============================================================ 副本库 */
console.log("=== 一、副本库 + 真实源码加载 ===");

if (!fs.existsSync(REAL_DB)) {
  console.error(`❌ 真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs，或设 PMS_DB_PATH）`);
  process.exit(1);
}
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${COPY_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
} catch (e) {
  console.error(`❌ 复制真库失败\n  源 ${REAL_DB}\n  目标 ${COPY_DB}\n  ${e?.message ?? e}`);
  process.exit(1);
}

const db = new DatabaseSync(COPY_DB, { timeout: 10000 });
db.exec("PRAGMA busy_timeout = 8000");
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);
globalThis.__pmsDb = db;

fs.writeFileSync(
  STUB_FILE,
  `let sid = null;
export function cookies() {
  return {
    get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined),
    set: () => {},
    delete: () => {},
  };
}
export function headers() { return new Map(); }
export function redirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export function revalidatePath() {}
export function revalidateTag() {}
export function setSid(v) { sid = v; }
`
);
const stubUrl = pathToFileURL(STUB_FILE).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/headers" || specifier === "next/navigation" || specifier === "next/cache") {
      return { url: stubUrl, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* 交给默认解析 */
      }
    }
    return next(specifier, context);
  },
});

const stub = await import(stubUrl);
const arLib = await import("../src/lib/ar.ts");
const actions = await import("../src/app/(main)/ar/actions.ts");
check(
  "已加载真实源码：src/lib/ar.ts + ar/actions.ts",
  typeof arLib.postArCharge === "function" && typeof actions.payArAction === "function"
);

/* ============================================================ 结构断言 */
console.log("\n=== 二、结构：四张表 + 同步原语 ===");

for (const t of ["ar_ledgers", "ar_accounts", "ar_transactions", "ar_write_offs"]) {
  check(`${t} 表存在`, all(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [t]).length === 1);
}
const ledgerCols = all(`PRAGMA table_info(ar_ledgers)`).map((c) => c.name);
check("ar_ledgers 有 kind 列（CHARGE / TRANSFER_IN / TRANSFER_OUT）", ledgerCols.includes("kind"), ledgerCols.join(","));
const woCols = all(`PRAGMA table_info(ar_write_offs)`).map((c) => c.name);
check("ar_write_offs 有 ar_ledger_id 列（核销记录指向台账行）", woCols.includes("ar_ledger_id"), woCols.join(","));
check(
  "核销记录 → 台账 的索引存在",
  all(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ar_wo_ledger'`).length === 1
);
for (const fn of ["settleCompanyLedgers", "syncAccountSettlement", "syncAccountTransfer", "postAccountLedgerCharge", "arAccountCompanyId"]) {
  check(`lib/ar.ts 提供双边同步原语 ${fn}`, typeof arLib[fn] === "function");
}

/* ============================================================ 会话 / 夹具 */
console.log("\n=== 三、夹具：两个协议单位 + 各自的 AR 账户 ===");

const admin = one(`SELECT id, username, real_name FROM users WHERE hotel_id = ? AND role = 'admin' ORDER BY id LIMIT 1`, [H]);
const SID = `test-ar-sync-${STAMP}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  SID,
  JSON.stringify({ id: admin.id, username: admin.username, realName: admin.real_name, role: "admin", hotelId: H, hotelName: "验收酒店" }),
  new Date().toISOString(),
  new Date(Date.now() + 3600 * 1000).toISOString(),
]);
stub.setSid(SID);

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const invoke = async (fn, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  try {
    await fn(fd);
    return { kind: "returned" };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (msg.startsWith("NEXT_REDIRECT:")) {
      const url = msg.slice("NEXT_REDIRECT:".length);
      const q = new URL(url, "http://localhost").searchParams;
      return { kind: q.get("err") ? "err" : "ok", message: q.get("err") || q.get("ok") || q.get("msg") || "", url };
    }
    return { kind: "threw", message: msg };
  }
};

const companyA = Number(
  run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
    H,
    `${PREFIX}-甲方`,
    "甲",
    "13800000001",
    1,
    100000,
  ]).lastInsertRowid
);
const companyB = Number(
  run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
    H,
    `${PREFIX}-乙方`,
    "乙",
    "13800000002",
    1,
    100000,
  ]).lastInsertRowid
);
check("已造两个协议单位", companyA > 0 && companyB > 0, `${companyA}/${companyB}`);

/* 挂账：postArCharge 会懒建／绑定 AR 账户（company_id 精确绑定） */
const chargeA = arLib.postArCharge(H, {
  companyId: companyA,
  amount: 1000,
  bizDate: TODAY,
  operator: "验收",
  remark: `${PREFIX} 甲方挂账`,
});
const chargeB = arLib.postArCharge(H, {
  companyId: companyB,
  amount: 500,
  bizDate: TODAY,
  operator: "验收",
  remark: `${PREFIX} 乙方挂账`,
});
check("两个单位的挂账都成功", "ok" in chargeA && "ok" in chargeB, `${JSON.stringify(chargeA)} / ${JSON.stringify(chargeB)}`);

const accountOfCompany = (companyId) =>
  Number(one(`SELECT id FROM ar_accounts WHERE hotel_id = ? AND company_id = ? ORDER BY id LIMIT 1`, [H, companyId])?.id ?? 0);
const accA = accountOfCompany(companyA);
const accB = accountOfCompany(companyB);
check("挂账自动为两个协议单位绑定 AR 账户", accA > 0 && accB > 0, `${accA}/${accB}`);

const balanceOf = (id) => round2(Number(one(`SELECT COALESCE(balance, 0) AS b FROM ar_accounts WHERE id = ?`, [id])?.b ?? 0));
const txSumOf = (id) =>
  round2(Number(one(`SELECT COALESCE(SUM(amount), 0) AS s FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ?`, [H, id])?.s ?? 0));
const ledgerOutstandingOf = (companyId) =>
  round2(
    Number(
      one(
        `SELECT COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS s
           FROM ar_ledgers WHERE hotel_id = ? AND company_id = ? AND status IN ('OPEN', 'PARTIAL')`,
        [H, companyId]
      )?.s ?? 0
    )
  );
const txCount = () => Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = ?`, [H])?.c ?? 0);
const woCount = () => Number(one(`SELECT COUNT(*) AS c FROM ar_write_offs WHERE hotel_id = ?`, [H])?.c ?? 0);
const ledgerCount = () => Number(one(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE hotel_id = ?`, [H])?.c ?? 0);

/** 账户余额 = 流水合计 = 该单位台账未结（三个数必须同时成立） */
function triad(accountId, companyId) {
  const bal = balanceOf(accountId);
  const tx = txSumOf(accountId);
  const ledger = ledgerOutstandingOf(companyId);
  return { ok: bal === tx && bal === ledger, bal, tx, ledger };
}

/* ============================================================ 1. 挂账后一致 */
console.log("\n=== 四、挂账后账户与逐笔台账一致 ===");
{
  const a = triad(accA, companyA);
  const b = triad(accB, companyB);
  check(
    "★ 挂账后：账户余额 = 流水合计 = 台账未结（甲方 1000）",
    a.ok && a.bal === 1000,
    JSON.stringify(a)
  );
  check(
    "★ 挂账后：乙方 500 同样三数一致",
    b.ok && b.bal === 500,
    JSON.stringify(b)
  );
  const ledger = one(`SELECT id, amount, settled_amount, status, kind FROM ar_ledgers WHERE hotel_id = ? AND company_id = ? ORDER BY id DESC LIMIT 1`, [H, companyA]);
  check("挂账台账行 kind=CHARGE、status=OPEN、未结 1000", ledger?.kind === "CHARGE" && ledger?.status === "OPEN" && round2(Number(ledger.amount)) === 1000, JSON.stringify(ledger));
}

/* ============================================================ 2. 收款后两边同时减少 */
console.log("\n=== 五、收款后两边同时减少 ===");
const payReq = `${PREFIX}-pay-1`;
{
  const before = triad(accA, companyA);
  const r = await invoke(actions.payArAction, { account_id: accA, amount: 300, biz_date: TODAY, note: "验收还款", request_id: payReq });
  const after = triad(accA, companyA);
  const ledger = one(`SELECT amount, settled_amount, status FROM ar_ledgers WHERE hotel_id = ? AND company_id = ? ORDER BY id DESC LIMIT 1`, [H, companyA]);
  check("收款成功", r.kind === "ok" && r.message.includes("已付款"), JSON.stringify(r));
  check(
    "★ 收款后：账户余额与台账未结同时减少 300（1000 → 700）",
    before.bal === 1000 && after.bal === 700 && after.ledger === 700 && after.ok,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );
  check(
    "★ 收款后：台账 settled_amount 增加 300、状态推进为 PARTIAL",
    round2(Number(ledger?.settled_amount)) === 300 && ledger?.status === "PARTIAL",
    JSON.stringify(ledger)
  );
  check(
    "收款写了一条 PAY 负数流水（与台账同事务）",
    all(`SELECT id, amount, type FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ? AND request_id = ?`, [H, accA, payReq]).length === 1 &&
      round2(Number(one(`SELECT amount FROM ar_transactions WHERE hotel_id = ? AND request_id = ?`, [H, payReq])?.amount)) === -300
  );
}

/* ============================================================ 3. 转账前后两边一致 */
console.log("\n=== 六、转账前后两边余额一致 ===");
const trReq = `${PREFIX}-tr-1`;
{
  const beforeA = triad(accA, companyA);
  const beforeB = triad(accB, companyB);
  const r = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: accB,
    amount: 200,
    biz_date: TODAY,
    note: "验收调账",
    request_id: trReq,
  });
  const afterA = triad(accA, companyA);
  const afterB = triad(accB, companyB);
  check("转账成功", r.kind === "ok" && r.message.includes("调账至"), JSON.stringify(r));
  check(
    "★ 转账后：甲方 700 → 500、乙方 500 → 700，两边三数一致",
    afterA.ok && afterB.ok && afterA.bal === 500 && afterB.bal === 700,
    `${JSON.stringify(beforeA)}→${JSON.stringify(afterA)} | ${JSON.stringify(beforeB)}→${JSON.stringify(afterB)}`
  );
  check(
    "★ 转账两条腿都写了流水（#OUT −200 / #IN +200）",
    round2(Number(one(`SELECT amount FROM ar_transactions WHERE hotel_id = ? AND request_id = ?`, [H, `${trReq}#OUT`])?.amount)) === -200 &&
      round2(Number(one(`SELECT amount FROM ar_transactions WHERE hotel_id = ? AND request_id = ?`, [H, `${trReq}#IN`])?.amount)) === 200
  );
  const outRow = one(`SELECT amount, settled_amount, status, kind FROM ar_ledgers WHERE hotel_id = ? AND company_id = ? AND kind = 'TRANSFER_OUT' ORDER BY id DESC LIMIT 1`, [H, companyA]);
  const inRow = one(`SELECT amount, settled_amount, status, kind FROM ar_ledgers WHERE hotel_id = ? AND company_id = ? AND kind = 'TRANSFER_IN' ORDER BY id DESC LIMIT 1`, [H, companyB]);
  check(
    "★ 转出单位留了 TRANSFER_OUT 明细（amount = settled = 200，净额 0 只留痕）",
    outRow?.kind === "TRANSFER_OUT" && round2(Number(outRow.amount)) === 200 && round2(Number(outRow.settled_amount)) === 200,
    JSON.stringify(outRow)
  );
  check(
    "★ 转入单位新增 TRANSFER_IN 台账（未结 200，账龄从转账营业日开始）",
    inRow?.kind === "TRANSFER_IN" && round2(Number(inRow.amount)) === 200 && round2(Number(inRow.settled_amount)) === 0 && inRow.status === "OPEN",
    JSON.stringify(inRow)
  );
  check(
    "转账后源单位台账未结 = 500（1000 − 收款 300 − 转出 200）",
    ledgerOutstandingOf(companyA) === 500,
    String(ledgerOutstandingOf(companyA))
  );
}

/* ============================================================ 4. 核销后两边一致 */
console.log("\n=== 七、核销后两边余额一致 ===");
const woReq = `${PREFIX}-wo-1`;
{
  const postB = one(`SELECT id, amount FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ? AND type = 'POST' ORDER BY id DESC LIMIT 1`, [H, accB]);
  const before = triad(accB, companyB);
  const woBefore = woCount();
  const r = await invoke(actions.writeOffArAction, {
    account_id: accB,
    transaction_id: postB?.id ?? 0,
    amount: 50,
    biz_date: TODAY,
    note: "验收坏账核销",
    request_id: woReq,
  });
  const after = triad(accB, companyB);
  const wos = all(`SELECT id, amount, ar_ledger_id, note FROM ar_write_offs WHERE hotel_id = ? AND ar_account_id = ? AND ar_ledger_id IS NOT NULL`, [H, accB]);
  check("核销成功", r.kind === "ok" && r.message.includes("已核销"), JSON.stringify(r));
  check(
    "★ 核销后：账户余额与台账未结同时减少 50（700 → 650）",
    before.bal === 700 && after.bal === 650 && after.ledger === 650 && after.ok,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );
  check(
    "★ 核销记录逐条指向被冲减的台账行（ar_ledger_id 非空）",
    wos.length >= 1 && wos.every((w) => Number(w.ar_ledger_id) > 0) && woCount() > woBefore,
    JSON.stringify(wos)
  );
  check(
    "核销记录金额合计 = 本次核销 50（跨多条台账也不会重复计）",
    round2(wos.reduce((s, w) => s + Number(w.amount ?? 0), 0)) === 50
  );
  check(
    "核销流水为 WRITE_OFF −50，且台账 settled 增加了核销额",
    round2(Number(one(`SELECT amount FROM ar_transactions WHERE hotel_id = ? AND request_id = ?`, [H, woReq])?.amount)) === -50 &&
      all(`SELECT id FROM ar_ledgers WHERE hotel_id = ? AND company_id = ?`, [H, companyB]).length >= 1
  );
}

/* ============================================================ 5. 重复 request_id 不重复记账 */
console.log("\n=== 八、重复 request_id 不重复记账 ===");
{
  const before = { a: triad(accA, companyA), b: triad(accB, companyB), tx: txCount(), wo: woCount(), ledger: ledgerCount() };

  const r1 = await invoke(actions.payArAction, { account_id: accA, amount: 300, biz_date: TODAY, request_id: payReq });
  const r2 = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: accB,
    amount: 200,
    biz_date: TODAY,
    request_id: trReq,
  });
  const r3 = await invoke(actions.writeOffArAction, {
    account_id: accB,
    transaction_id: Number(one(`SELECT id FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ? AND type='POST' ORDER BY id DESC LIMIT 1`, [H, accB])?.id ?? 0),
    amount: 50,
    biz_date: TODAY,
    request_id: woReq,
  });
  const after = { a: triad(accA, companyA), b: triad(accB, companyB), tx: txCount(), wo: woCount(), ledger: ledgerCount() };
  check(
    "★ 重复收款 request_id：提示重复提交，账户/台账/流水都不变",
    r1.kind === "ok" && r1.message.includes("重复提交") && after.a.bal === before.a.bal && after.a.ledger === before.a.ledger,
    `${JSON.stringify(r1)} ${JSON.stringify(before.a)} → ${JSON.stringify(after.a)}`
  );
  check(
    "★ 重复转账 request_id：提示重复提交，两边余额与流水都不变",
    r2.kind === "ok" &&
      r2.message.includes("重复提交") &&
      after.a.bal === before.a.bal &&
      after.b.bal === before.b.bal &&
      after.tx === before.tx
  );
  check(
    "★ 重复核销 request_id：提示重复提交，核销记录数不变",
    r3.kind === "ok" && r3.message.includes("重复提交") && after.wo === before.wo && after.ledger === before.ledger,
    `${JSON.stringify(r3)} wo ${before.wo} → ${after.wo}`
  );
}

/* ============================================================ 6. 跨酒店账户不能操作 */
console.log("\n=== 九、跨酒店账户不能操作 ===");
{
  run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
    HOTEL_B,
    `H${HOTEL_B}`,
    "AR 同步验收酒店",
    "测试地址",
    "000",
    NOW,
  ]);
  const crossCompany = Number(
    run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
      HOTEL_B,
      `${PREFIX}-别家单位`,
      "丙",
      "13800000003",
      1,
      10000,
    ]).lastInsertRowid
  );
  const crossAccount = Number(
    run(
      `INSERT INTO ar_accounts (hotel_id, code, name, type, credit_limit, balance, status, company_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [HOTEL_B, `${PREFIX}-X`, `${PREFIX}-别家账户`, "协议单位", 10000, 500, "ON", crossCompany, NOW]
    ).lastInsertRowid
  );
  run(
    `INSERT INTO ar_ledgers (hotel_id, company_id, folio_id, folio_no, biz_date, amount, settled_amount, due_date, status, kind, operator, remark, created_at)
     VALUES (?,?,NULL,NULL,?,?,0,NULL,'OPEN','CHARGE',?,?,?)`,
    [HOTEL_B, crossCompany, TODAY, 500, "验收", `${PREFIX}-别家挂账`, NOW]
  );

  const crossBefore = round2(Number(one(`SELECT balance FROM ar_accounts WHERE id = ?`, [crossAccount])?.balance ?? 0));
  const crossLedgerBefore = round2(Number(one(`SELECT COALESCE(SUM(amount - COALESCE(settled_amount,0)),0) AS s FROM ar_ledgers WHERE hotel_id = ?`, [HOTEL_B])?.s ?? 0));
  const crossTxBefore = Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = ?`, [HOTEL_B])?.c ?? 0);

  const r1 = await invoke(actions.payArAction, { account_id: crossAccount, amount: 100, biz_date: TODAY, request_id: `${PREFIX}-cross-pay` });
  const r2 = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: crossAccount,
    amount: 100,
    biz_date: TODAY,
    request_id: `${PREFIX}-cross-tr`,
  });
  const r3 = await invoke(actions.writeOffArAction, {
    account_id: crossAccount,
    transaction_id: 1,
    amount: 10,
    biz_date: TODAY,
    request_id: `${PREFIX}-cross-wo`,
  });

  const crossAfter = round2(Number(one(`SELECT balance FROM ar_accounts WHERE id = ?`, [crossAccount])?.balance ?? 0));
  const crossLedgerAfter = round2(Number(one(`SELECT COALESCE(SUM(amount - COALESCE(settled_amount,0)),0) AS s FROM ar_ledgers WHERE hotel_id = ?`, [HOTEL_B])?.s ?? 0));
  const crossTxAfter = Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = ?`, [HOTEL_B])?.c ?? 0);

  check("★ 跨酒店收款被拒（账户不存在于当前酒店）", r1.kind === "err" && r1.message.includes("不存在"), JSON.stringify(r1));
  check("★ 跨酒店转入被拒", r2.kind === "err" && (r2.message.includes("不存在") || r2.message.includes("不存在")), JSON.stringify(r2));
  check("★ 跨酒店核销被拒", r3.kind === "err" && r3.message.includes("不存在"), JSON.stringify(r3));
  check("★ 跨酒店操作后：别家账户余额 / 台账 / 流水都没变", crossAfter === crossBefore && crossLedgerAfter === crossLedgerBefore && crossTxAfter === crossTxBefore, `${crossBefore}/${crossBefore === crossAfter} ledger ${crossLedgerBefore}→${crossLedgerAfter} tx ${crossTxBefore}→${crossTxAfter}`);
}

/* ============================================================ 失败整体回滚 + 账户入账 */
console.log("\n=== 十、失败整体回滚 / 账户入账双边 ===");
{
  const before = { a: triad(accA, companyA), tx: txCount(), wo: woCount(), ledger: ledgerCount() };
  const r = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: accB,
    amount: 99999,
    biz_date: TODAY,
    request_id: `${PREFIX}-tr-over`,
  });
  const after = { a: triad(accA, companyA), b: triad(accB, companyB), tx: txCount(), wo: woCount(), ledger: ledgerCount() };
  check("超额转账被拒（应收余额不足）", r.kind === "err" && r.message.includes("余额不足"), JSON.stringify(r));
  check(
    "★ 失败整体回滚：账户 / 台账 / 流水 / 核销 四张表都没动",
    after.a.bal === before.a.bal &&
      after.a.ledger === before.a.ledger &&
      after.tx === before.tx &&
      after.wo === before.wo &&
      after.ledger === before.ledger &&
      after.b.bal === 650,
    `${JSON.stringify(before)} → tx ${after.tx} wo ${after.wo} ledger ${after.ledger} b=${after.b.bal}`
  );

  /* 账户入账（postArAction）也必须写台账：绑定了协议单位的账户不能只加账户余额 */
  const ledgerBefore = ledgerCount();
  const r2 = await invoke(actions.postArAction, {
    account_id: accA,
    amount: 100,
    biz_date: TODAY,
    note: "验收账户入账",
    request_id: `${PREFIX}-post-1`,
  });
  const afterPost = triad(accA, companyA);
  const newLedger = one(`SELECT kind, amount, status FROM ar_ledgers WHERE hotel_id = ? AND company_id = ? ORDER BY id DESC LIMIT 1`, [H, companyA]);
  check("账户入账成功", r2.kind === "ok" && r2.message.includes("已为"), JSON.stringify(r2));
  check(
    "★ 账户入账同样双边：账户 500 → 600，台账未结同步 600",
    afterPost.ok && afterPost.bal === 600 && afterPost.ledger === 600 && ledgerCount() === ledgerBefore + 1,
    JSON.stringify(afterPost)
  );
  check("账户入账在台账留下 CHARGE 行", newLedger?.kind === "CHARGE" && newLedger?.status === "OPEN", JSON.stringify(newLedger));
}

/* ============================================================ 全局不变量 */
console.log("\n=== 十一、全局不变量 ===");
{
  const badSettle = Number(
    one(
      `SELECT COUNT(*) AS c FROM ar_ledgers
        WHERE COALESCE(settled_amount, 0) < -0.001 OR COALESCE(settled_amount, 0) - amount > 0.001`
    )?.c ?? 0
  );
  check("所有台账 0 ≤ settled_amount ≤ amount", badSettle === 0, `${badSettle} 条越界`);

  const badStatus = Number(
    one(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE status NOT IN ('OPEN','PARTIAL','SETTLED','WRITTEN_OFF')`)?.c ?? 0
  );
  check("所有台账状态合法（OPEN/PARTIAL/SETTLED/WRITTEN_OFF）", badStatus === 0, `${badStatus} 条非法`);

  const badKind = Number(
    one(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE COALESCE(kind, 'CHARGE') NOT IN ('CHARGE','TRANSFER_IN','TRANSFER_OUT')`)?.c ?? 0
  );
  check("所有台账 kind 合法（CHARGE/TRANSFER_IN/TRANSFER_OUT）", badKind === 0, `${badKind} 条非法`);

  /* 本脚本涉及的两个账户：余额 = 流水合计 = 台账未结（最终态复核） */
  const a = triad(accA, companyA);
  const b = triad(accB, companyB);
  check("★ 最终态：甲方账户余额 = 流水合计 = 台账未结", a.ok, JSON.stringify(a));
  check("★ 最终态：乙方账户余额 = 流水合计 = 台账未结", b.ok, JSON.stringify(b));
}

/* ============================================================ 台账不足时的「待核对」口径 */
console.log("\n=== 十二、台账不足时如实报待核对（不静默当成已同步）===");
{
  /* 纯账户：绑定协议单位但没有逐笔台账（历史数据 / 手工建账户），余额 300 */
  const companyC = Number(
    run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
      H,
      `${PREFIX}-丙方`,
      "丙",
      "13800000009",
      1,
      10000,
    ]).lastInsertRowid
  );
  const accC = Number(
    run(
      `INSERT INTO ar_accounts (hotel_id, code, name, type, credit_limit, balance, status, company_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [H, `${PREFIX}-C`, `${PREFIX}-丙方账户`, "协议单位", 10000, 300, "ON", companyC, NOW]
    ).lastInsertRowid
  );
  run(
    `INSERT INTO ar_transactions (hotel_id, ar_account_id, type, amount, balance_after, note, operator, biz_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [H, accC, "POST", 300, 300, `${PREFIX} 期初（无逐笔台账）`, "验收", TODAY, NOW]
  );

  const r = await invoke(actions.payArAction, {
    account_id: accC,
    amount: 100,
    biz_date: TODAY,
    request_id: `${PREFIX}-gap-pay`,
  });
  check("台账不足时收款仍然成功（钱不能拒收）", r.kind === "ok" && r.message.includes("已付款"), JSON.stringify(r));
  check(
    "★ 差额在返回文案里明确「待核对」，不静默当成已同步",
    r.message.includes("待核对") && r.message.includes("100"),
    r.message
  );
  check(
    "账户余额减少、台账未结仍为 0（差额如实体现，不伪造台账）",
    balanceOf(accC) === 200 && ledgerOutstandingOf(companyC) === 0,
    `账户 ${balanceOf(accC)} / 台账 ${ledgerOutstandingOf(companyC)}`
  );
}

/* ============================================================ 真库零写入 */
console.log("\n=== 十三、真库零写入 ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const leakedAcc = Number(real.prepare(`SELECT COUNT(*) AS c FROM ar_accounts WHERE code LIKE ?`).get(`${PREFIX}%`).c);
    const leakedCompany = Number(real.prepare(`SELECT COUNT(*) AS c FROM companies WHERE name LIKE ?`).get(`${PREFIX}%`).c);
    const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
    const leakedTx = Number(
      real
        .prepare(
          `SELECT COUNT(*) AS c FROM ar_transactions t
            WHERE EXISTS (SELECT 1 FROM ar_accounts a WHERE a.id = t.ar_account_id AND a.code LIKE ?)`
        )
        .get(`${PREFIX}%`).c
    );
    check("真库没有本脚本的 AR 账户", leakedAcc === 0, `实际 ${leakedAcc}`);
    check("真库没有本脚本的协议单位", leakedCompany === 0, `实际 ${leakedCompany}`);
    check("真库没有被写入测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);
    check("真库没有挂在测试账户上的流水", leakedTx === 0, `实际 ${leakedTx}`);
  } finally {
    real.close();
  }
}

try {
  db.close();
} catch {
  /* 已关闭 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
