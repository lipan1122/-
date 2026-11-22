#!/usr/bin/env node
/**
 * 押金结构化识别验收（第九轮整改清单一、2「押金不能再靠备注识别」）
 *
 * ── 缺陷 ──
 * payments 只有 remark：押金靠「备注里含押金/预收」识别。于是
 *   · 备注写成「订金」→ 退房找不到原押金（refund_of 为空、押金退不回去）；
 *   · 手动退款与退房退款各写一套 remark 判断 → 口径不一致，可能重复退款；
 *   · 押金退款报表按备注 LIKE 匹配 → 漏记。
 *
 * ── 修法 ──
 * payments 加结构化列 kind（ROOM_PAYMENT / DEPOSIT / DEPOSIT_REFUND / ROOM_REFUND /
 * OTHER_PAYMENT）：收押金写 DEPOSIT、手动退押金与退房退押金写 DEPOSIT_REFUND、
 * 房费退款写 ROOM_REFUND；退房/退款找原押金时 **kind 优先、备注只对旧数据兜底**。
 *
 * ── 本脚本验什么（清单第 75-82 行）──
 *   A. 结构：payments.kind 列与索引存在；lib/folio 的判定口径存在；写入点都带 kind
 *   B. 备注为「押金」→ DEPOSIT
 *   C. 备注为「预收」→ DEPOSIT
 *   D. 备注为「订金」（旧口径识别不出来的关键场景）→ DEPOSIT，退款写 DEPOSIT_REFUND
 *   E. 备注为空 → 仍然写 DEPOSIT；旧数据无判定依据时**不猜**
 *   F. 多笔押金分行退款：每笔退款 refund_of 指向各自原押金，冲销金额正确
 *   G. 手动退押金后再次退房：只退剩余押金，不能重复退款
 *   H. 旧数据兜底：kind 为空的「入住押金」仍能按备注识别并退款
 *
 * ── 隔离 ──
 * data/pms.db --VACUUM INTO--> .tmp/deposit-kind-<时间戳>.db 注入 globalThis.__pmsDb，
 * 所有写入只进副本；脚本结尾用只读连接复查真库零写入（本脚本不改业务库）。
 *
 * 运行：node scripts/test-deposit-kind.mjs
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
const COPY_DB = path.join(TMP_DIR, `deposit-kind-${STAMP}.db`);
const STUB_FILE = path.join(TMP_DIR, `deposit-kind-stub-${STAMP}.mjs`);
const H = 1;
const PREFIX = `T-DEP-${STAMP}`;

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
const folioLib = await import("../src/lib/folio.ts");
const cashier = await import("../src/app/(main)/cashier/actions.ts");
check(
  "已加载真实源码：src/lib/folio.ts + cashier/actions.ts",
  typeof folioLib.isDepositPayment === "function" && typeof cashier.addDepositAction === "function"
);

/* ============================================================ 结构断言 */
console.log("\n=== 二、结构：kind 列 / 索引 / 判定口径 / 写入点 ===");

const payCols = all(`PRAGMA table_info(payments)`).map((c) => c.name);
check("payments 有 kind 列（结构化收款性质）", payCols.includes("kind"), payCols.join(","));
check(
  "kind 索引存在（押金报表 / 退款按 kind 查询）",
  all(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payments_kind'`).length === 1
);
check(
  "lib/folio.ts 定义五种收款性质（单一口径）",
  folioLib.PAYMENT_KINDS.length === 5 && folioLib.PAYMENT_KINDS.includes("DEPOSIT_REFUND"),
  folioLib.PAYMENT_KINDS.join(",")
);

const cashierSrc = fs.readFileSync(path.join("src", "app", "(main)", "cashier", "actions.ts"), "utf8");
const frontdeskSrc = fs.readFileSync(path.join("src", "app", "(main)", "frontdesk", "actions.ts"), "utf8");
const folioSrc = fs.readFileSync(path.join("src", "lib", "folio.ts"), "utf8");
const checkoutBody = (() => {
  const i = cashierSrc.indexOf("export async function checkoutAction(");
  const j = cashierSrc.indexOf("\nexport ", i + 10);
  return cashierSrc.slice(i, j < 0 ? cashierSrc.length : j);
})();
/** 去掉注释再断言 SQL 文案：注释里举例说明旧写法的字符串不算「还在用」 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const checkoutCode = stripComments(checkoutBody);

check("addDepositAction 写 kind=DEPOSIT", /"DEPOSIT"/.test(cashierSrc));
check(
  "refundPaymentAction / checkoutAction 写 kind=DEPOSIT_REFUND",
  /refundKindOf\(/.test(cashierSrc) && (cashierSrc.match(/"DEPOSIT_REFUND"/g) ?? []).length >= 1,
  "退款流水未写 DEPOSIT_REFUND / 未走 refundKindOf"
);
check("收款/补收/部分结账写 kind=ROOM_PAYMENT", (cashierSrc.match(/"ROOM_PAYMENT"/g) ?? []).length >= 3);
check("入住押金（frontdesk）写 kind=DEPOSIT", /"DEPOSIT"/.test(frontdeskSrc));
check(
  "退房找原押金不再用 remark LIKE '%押金%'（改 findDepositPayment：kind 优先）",
  !/remark\s+LIKE\s+'%押金%'/.test(checkoutCode) && /findDepositPayment\(/.test(checkoutCode),
  "checkoutAction 仍靠备注找押金"
);
check(
  "押金判定集中到 lib/folio（kind 优先 + 旧备注兜底）",
  /export function isDepositPayment/.test(folioSrc) && /export function findDepositPayment/.test(folioSrc)
);
check(
  "旧数据回填在迁移脚本里（remark 押金/预收 → DEPOSIT）",
  /refund_of IS NULL[\s\S]{0,120}remark LIKE '%押金%'/.test(
    fs.readFileSync(path.join("scripts", "migrate-all.mjs"), "utf8")
  )
);

/* ============================================================ 会话 / 夹具 */
console.log("\n=== 三、备注任意写法都能认出押金（B/C/D/E）===");

const admin = one(`SELECT id, username, real_name, role FROM users WHERE hotel_id = ? AND role = 'admin' ORDER BY id LIMIT 1`, [H]);
check("找到 admin 验收账号", Boolean(admin), JSON.stringify(admin));
const SID = `test-dep-kind-${STAMP}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  SID,
  JSON.stringify({ id: admin.id, username: admin.username, realName: admin.real_name, role: "admin", hotelId: H, hotelName: "验收酒店" }),
  new Date().toISOString(),
  new Date(Date.now() + 3600 * 1000).toISOString(),
]);
stub.setSid(SID);

const roomTypeId = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [H])?.id ?? 1;
let seq = 0;
/** 造一张「在住单 + 空账单」，可选预置押金明细 / 押金流水 */
function fixture({ deposit = 0, depositRemark = "入住押金", depositKind = "DEPOSIT", roomStatus = "OC" } = {}) {
  seq += 1;
  const tag = `${PREFIX}-${seq}`;
  const now = new Date().toISOString();
  const roomId = Number(
    run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
      H,
      tag,
      9,
      roomTypeId,
      roomStatus,
      900 + seq,
    ]).lastInsertRowid
  );
  const stayId = Number(
    run(
      `INSERT INTO stays
         (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, deposit, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [H, `S${tag}`, roomId, `押金验收客${seq}`, now, now.slice(0, 10), 1, 0, deposit, "INHOUSE", now]
    ).lastInsertRowid
  );
  const folioId = Number(
    run(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, `F${tag}`, stayId, `押金验收客${seq}`, tag, 0, deposit, -deposit, "OPEN", now]
    ).lastInsertRowid
  );
  let paymentId = null;
  if (deposit > 0) {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, folioId, "DEPOSIT", depositRemark, 1, deposit, deposit, now.slice(0, 10), now, admin.id]
    );
    paymentId = Number(
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [H, folioId, stayId, `P${tag}`, "现金", deposit, now.slice(0, 10), depositRemark, now, "验收", depositKind]
      ).lastInsertRowid
    );
  }
  return { roomId, stayId, folioId, paymentId, tag };
}

const invoke = async (fn, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  try {
    const out = await fn(fd);
    return { kind: "returned", result: out };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (msg.startsWith("NEXT_REDIRECT:")) {
      const url = msg.slice("NEXT_REDIRECT:".length);
      const q = new URL(url, "http://localhost").searchParams;
      return { kind: q.get("err") ? "err" : "ok", message: q.get("err") || q.get("msg") || q.get("ok") || "", url };
    }
    return { kind: "threw", message: msg };
  }
};

const payRow = (id) => one(`SELECT id, amount, remark, kind, refund_of, folio_id FROM payments WHERE id = ?`, [id]);
const depositLines = (folioId) =>
  round2(
    Number(
      one(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`,
        [H, folioId]
      )?.t ?? 0
    )
  );
const stayDeposit = (stayId) => Number(one(`SELECT COALESCE(deposit, 0) AS d FROM stays WHERE id = ?`, [stayId])?.d ?? 0);

/* ---- B. 备注「押金」 ---- */
{
  const f = fixture();
  const r = await invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 300, remark: "押金" });
  const p = one(`SELECT id, remark, kind FROM payments WHERE folio_id = ? AND amount > 0 ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("B. 备注「押金」：addDepositAction 成功", r.kind === "returned" && r.result?.ok, JSON.stringify(r));
  check("B. 备注「押金」：流水 kind=DEPOSIT", p?.kind === "DEPOSIT", JSON.stringify(p));
  check("B. 押金明细 + stays.deposit 同步", depositLines(f.folioId) === 300 && stayDeposit(f.stayId) === 300);
}

/* ---- C. 备注「预收」 ---- */
{
  const f = fixture();
  await invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 200, remark: "预收" });
  const p = one(`SELECT kind, remark FROM payments WHERE folio_id = ? ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("C. 备注「预收」：流水 kind=DEPOSIT", p?.kind === "DEPOSIT", JSON.stringify(p));
}

/* ---- D. 备注「订金」：旧口径识别不出来的关键场景 ---- */
{
  const f = fixture();
  await invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 400, remark: "订金" });
  const p = one(`SELECT id, remark, kind FROM payments WHERE folio_id = ? ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("D. 备注「订金」：原始 remark 不含押金/预收（旧口径必然漏判）", p && !/押金|预收/.test(String(p.remark)), String(p?.remark));
  check("D. 备注「订金」：kind 仍是 DEPOSIT（不看备注）", p?.kind === "DEPOSIT", JSON.stringify(p));
  const found = folioLib.findDepositPayment(H, f.folioId);
  check("D. findDepositPayment 按 kind 找到这笔「订金」原押金", found?.id === Number(p.id), JSON.stringify(found));

  const r = await invoke(cashier.refundPaymentAction, {
    payment_id: p.id,
    amount: 150,
    reason: "客人离店退押金",
  });
  check("D. 手动退押金成功", r.kind === "returned" && r.result?.ok, JSON.stringify(r));
  const refund = one(`SELECT amount, kind, refund_of, remark FROM payments WHERE folio_id = ? AND amount < 0 ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("D. 退款流水 kind=DEPOSIT_REFUND", refund?.kind === "DEPOSIT_REFUND", JSON.stringify(refund));
  check("D. 退款流水 refund_of 指向原押金收款", Number(refund?.refund_of) === Number(p.id), JSON.stringify(refund));
  check(
    "D. 押金退款摘要带「押金」锚点（旧报表按备注取数时也不会漏记）",
    String(refund?.remark ?? "").includes("押金"),
    String(refund?.remark)
  );
  check(
    "D. 押金负债同步冲减（明细 400→250、stays.deposit 400→250）",
    depositLines(f.folioId) === 250 && stayDeposit(f.stayId) === 250,
    `明细 ${depositLines(f.folioId)} / stay ${stayDeposit(f.stayId)}`
  );
}

/* ---- E. 备注为空 ---- */
{
  const f = fixture();
  await invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 100 });
  const p = one(`SELECT kind, remark FROM payments WHERE folio_id = ? ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("E. 备注为空：流水仍写 kind=DEPOSIT", p?.kind === "DEPOSIT", JSON.stringify(p));

  /* 旧数据：kind 为空且备注为空 → 没有判定依据，不能猜成押金 */
  const legacyFolio = fixture();
  run(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [H, legacyFolio.folioId, legacyFolio.stayId, `PN-${legacyFolio.tag}`, "现金", 100, new Date().toISOString().slice(0, 10), null, new Date().toISOString()]
  );
  const noBasis = one(`SELECT id, kind, remark FROM payments WHERE folio_id = ? ORDER BY id DESC LIMIT 1`, [legacyFolio.folioId]);
  check("E. 旧数据 kind 为空、备注为空：不当押金（不静默归类）", noBasis?.kind === null && folioLib.findDepositPayment(H, legacyFolio.folioId) === undefined, JSON.stringify(noBasis));
  check(
    "E. 旧数据待核对行能被列出（kind IS NULL）",
    Number(one(`SELECT COUNT(*) AS n FROM payments WHERE kind IS NULL`)?.n ?? 0) >= 1
  );
}

/* ---- H. 旧数据兜底：kind 为空但备注「入住押金」 ---- */
{
  const f = fixture({ deposit: 260, depositRemark: "入住押金", depositKind: null });
  const found = folioLib.findDepositPayment(H, f.folioId);
  check("H. kind 为空的旧押金：按备注兜底仍能找到", found?.id === Number(f.paymentId), JSON.stringify(found));
  const r = await invoke(cashier.refundPaymentAction, { payment_id: f.paymentId, amount: 60, reason: "旧数据退押金" });
  const refund = one(`SELECT kind, refund_of FROM payments WHERE folio_id = ? AND amount < 0 ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("H. 旧数据原押金退款：kind=DEPOSIT_REFUND 且 refund_of 指向原行", r.kind === "returned" && refund?.kind === "DEPOSIT_REFUND" && Number(refund.refund_of) === Number(f.paymentId), JSON.stringify(refund));
}

/* ============================================================ F. 多笔押金分行退款 */
console.log("\n=== 四、多笔押金分行退款（F）===");
{
  const f = fixture();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    await invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 100, remark: `押金${i + 1}` });
    ids.push(Number(one(`SELECT id FROM payments WHERE folio_id = ? ORDER BY id DESC LIMIT 1`, [f.folioId]).id));
  }
  check("F. 三笔押金各自一条 DEPOSIT 流水", all(`SELECT id FROM payments WHERE folio_id = ? AND kind='DEPOSIT'`, [f.folioId]).length === 3);

  const r1 = await invoke(cashier.refundPaymentAction, { payment_id: ids[0], amount: 60, reason: "部分退押金" });
  const r2 = await invoke(cashier.refundPaymentAction, { payment_id: ids[1], amount: 90, reason: "部分退押金" });
  check("F. 两笔分行退款都成功", r1.kind === "returned" && r2.kind === "returned", `${JSON.stringify(r1)} / ${JSON.stringify(r2)}`);

  const refunds = all(`SELECT amount, kind, refund_of FROM payments WHERE folio_id = ? AND amount < 0 ORDER BY id ASC`, [f.folioId]);
  check("F. 两条退款流水都是 DEPOSIT_REFUND", refunds.length === 2 && refunds.every((x) => x.kind === "DEPOSIT_REFUND"), JSON.stringify(refunds));
  check(
    "F. 每条退款的 refund_of 各自指向对应的原押金",
    Number(refunds[0]?.refund_of) === ids[0] && Number(refunds[1]?.refund_of) === ids[1],
    JSON.stringify(refunds)
  );
  check(
    "F. 押金明细按退款额累减（300−150=150）、stays.deposit 同步",
    depositLines(f.folioId) === 150 && stayDeposit(f.stayId) === 150,
    `明细 ${depositLines(f.folioId)} / stay ${stayDeposit(f.stayId)}`
  );
  check(
    "F. 单行押金不会被冲成负数（每行 ≥ 0）",
    all(`SELECT amount FROM folio_items WHERE folio_id = ? AND item_type='DEPOSIT'`, [f.folioId]).every(
      (x) => Number(x.amount) >= -0.001
    )
  );
}

/* ============================================================ G. 手动退押金后再次退房不能重复退款 */
console.log("\n=== 五、手动退押金后再次退房不能重复退款（G）===");
{
  const f = fixture();
  /* 押金备注故意写「订金」：旧实现 checkoutAction 用 remark LIKE '%押金%' 找不到它 */
  const r0 = await invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 500, remark: "订金" });
  check("G. 收押金 500（备注「订金」）成功", r0.kind === "returned" && r0.result?.ok, JSON.stringify(r0));
  const dep = one(`SELECT id, method, kind FROM payments WHERE folio_id = ? AND amount > 0 ORDER BY id DESC LIMIT 1`, [f.folioId]);
  check("G. 该押金 kind=DEPOSIT、备注不含押金", dep?.kind === "DEPOSIT" && !/押金|预收/.test(String(one(`SELECT remark FROM payments WHERE id = ?`, [dep.id])?.remark)));

  /* 先手动退 200 */
  const r1 = await invoke(cashier.refundPaymentAction, { payment_id: dep.id, amount: 200, reason: "客人临时用钱" });
  const afterManual = depositLines(f.folioId);
  check("G. 手动退押金 200 成功，押金明细剩 300", r1.kind === "returned" && afterManual === 300, `明细 ${afterManual}`);

  /* 再退房：应只退剩余 300 */
  const co = await invoke(cashier.checkoutAction, {
    stay_id: f.stayId,
    room_id: f.roomId,
    folio_id: f.folioId,
    pay_method: "现金",
    pay_amount: 0,
  });
  const folio = one(`SELECT status, paid_amount, balance FROM folios WHERE id = ?`, [f.folioId]);
  const refunds = all(`SELECT amount, kind, refund_of, remark FROM payments WHERE folio_id = ? AND amount < 0 ORDER BY id ASC`, [f.folioId]);
  const refundTotal = round2(refunds.reduce((s, x) => s + Math.abs(Number(x.amount)), 0));
  const checkoutRefund = refunds.find((x) => String(x.remark) === "退房退还押金");
  const stay = one(`SELECT status, deposit FROM stays WHERE id = ?`, [f.stayId]);

  check("G. 退房成功", co.kind === "ok" || co.kind === "returned", JSON.stringify(co));
  check("G. 退房只退剩余押金 300（不是再退 500）", round2(Math.abs(Number(checkoutRefund?.amount ?? 0))) === 300, JSON.stringify(checkoutRefund));
  check("G. 退房退款 kind=DEPOSIT_REFUND", checkoutRefund?.kind === "DEPOSIT_REFUND", JSON.stringify(checkoutRefund));
  check(
    "G. 退房退款 refund_of 指向「订金」那笔原押金（kind 优先找到）",
    Number(checkoutRefund?.refund_of) === Number(dep.id),
    JSON.stringify(checkoutRefund)
  );
  check("G. 累计退款 = 500，不超过原押金（无重复退款）", refundTotal === 500, `累计 ${refundTotal}`);
  check("G. 押金明细归零、stays.deposit 归零", depositLines(f.folioId) === 0 && Number(stay?.deposit ?? 0) === 0, `明细 ${depositLines(f.folioId)} / stay ${stay?.deposit}`);
  check("G. 账单已结清（paid=0、balance=0、SETTLED）", folio?.status === "SETTLED" && round2(Number(folio.paid_amount)) === 0 && round2(Number(folio.balance)) === 0, JSON.stringify(folio));

  /* 再点一次退房：已退房，必须被拒且不再产生退款流水 */
  const before = all(`SELECT id FROM payments WHERE folio_id = ?`, [f.folioId]).length;
  const co2 = await invoke(cashier.checkoutAction, {
    stay_id: f.stayId,
    room_id: f.roomId,
    folio_id: f.folioId,
    pay_method: "现金",
    pay_amount: 0,
  });
  const afterCount = all(`SELECT id FROM payments WHERE folio_id = ?`, [f.folioId]).length;
  check(
    "G. ★ 手动退押金后再次退房不能重复退款（第二次被拒、流水不增加）",
    (co2.kind === "err" || co2.result?.error) && afterCount === before,
    `${JSON.stringify(co2)} 流水 ${before} → ${afterCount}`
  );
}

/* ============================================================ 押金报表口径（按 kind） */
console.log("\n=== 六、押金报表口径按 kind 汇总 ===");
{
  const today = new Date().toISOString().slice(0, 10);
  const summary = folioLib.depositKindSummary(H, today, today);
  const rowsIn = summary.collectedRows.filter((r) => r.biz_date === today);
  const rowsRefund = summary.refundRows.filter((r) => r.biz_date === today);
  check("押金收取汇总 > 0（按 kind 查到今天的押金）", summary.collected > 0 && rowsIn.length > 0, `收取 ${summary.collected}`);
  check("押金退款汇总 > 0（按 kind 查到今天的押金退款）", summary.refunded > 0 && rowsRefund.length > 0, `退还 ${summary.refunded}`);
  check("汇总里的押金退款全部归类为 DEPOSIT_REFUND", rowsRefund.every((r) => r.kind === "DEPOSIT_REFUND"));
  check(
    "收取与退还金额和逐笔流水一致",
    round2(rowsIn.reduce((s, r) => s + Math.abs(r.amount), 0)) === summary.collected &&
      round2(rowsRefund.reduce((s, r) => s + Math.abs(r.amount), 0)) === summary.refunded,
    `收取 ${summary.collected} / 退还 ${summary.refunded}`
  );

  /*
   * 旧报表口径兼容（reports/page.tsx 的「押金退款流水」仍按备注取数，该文件不在本轮范围）：
   * 新写的押金退款摘要带「押金」锚点，这条**旧 SQL 原样**也必须能查到全部押金退款。
   */
  const legacyRows = all(
    `SELECT p.id FROM payments p LEFT JOIN payments op ON op.id = p.refund_of
      WHERE p.hotel_id = ? AND p.amount < 0 AND p.biz_date BETWEEN ? AND ?
        AND (p.remark LIKE '%押金%' OR COALESCE(op.remark, '') LIKE '%押金%')`,
    [H, today, today]
  );
  const kindRefundIds = new Set(rowsRefund.map((r) => Number(r.id)));
  check(
    "旧报表（按备注）也能查到全部押金退款（kind + 摘要双保险，不漏记）",
    kindRefundIds.size > 0 && [...kindRefundIds].every((id) => legacyRows.some((x) => Number(x.id) === id)),
    `kind ${kindRefundIds.size} 条 / 旧口径 ${legacyRows.length} 条`
  );
}

/* ============================================================ 真库零写入 */
console.log("\n=== 七、真库零写入 ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const leaked = Number(
      real.prepare(`SELECT COUNT(*) AS c FROM payments WHERE pay_no LIKE ?`).get(`${PREFIX}%`).c
    );
    const leakedRooms = Number(real.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE room_no LIKE ?`).get(`${PREFIX}%`).c);
    check("真库没有本脚本写入的收款流水", leaked === 0, `实际 ${leaked}`);
    check("真库没有本脚本写入的房间", leakedRooms === 0, `实际 ${leakedRooms}`);
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
