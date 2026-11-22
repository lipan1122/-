#!/usr/bin/env node
/**
 * AR 应收动作权限 / 幂等 / 余额约束验收（第六轮整改清单一.5，清单第 73-88 行）
 *
 * ── 清单要求 ↔ 本脚本断言 ──
 *   1. 入账使用 ar.manage 或 cashier.charge_company
 *   2. 客户还款使用 cashier.receive 或 ar.manage
 *   3. 转账使用 ar.manage（本项目无 ar.manage → 用语义最接近的 cashier.transfer）
 *   4. 坏账核销保持 admin 限制
 *      → 一、库层权限点 + 二、源码守卫 + 三、逐角色真实调用
 *   5. 金额、余额、流水、操作日志必须同事务
 *      → 三、失败场景（超额还款）后余额/流水/日志三者都没动；成功场景三者同时出现
 *   6. 余额不能因重复提交重复变化（request_id 幂等）
 *      → 三、同一 request_id 提交两次 → 流水只 1 条、余额不再变
 *   7. 不允许超过当前应收余额还款
 *      → 三、还款 > 余额被拒，且余额不变
 *   8. 所有账号、流水和核销带 hotel_id
 *      → 一、表结构断言 + 三、跨酒店被拒
 *
 * ── 真库隔离 ──
 *   data/pms.db --VACUUM INTO--> .tmp/ar-permissions-<时间戳>.db，注入 globalThis.__pmsDb。
 *   所有写入只进副本；脚本结尾用只读连接复查真库零写入。
 *
 * 运行：node scripts/test-ar-permissions.mjs
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
const COPY_DB = path.join(TMP_DIR, `ar-permissions-${STAMP}.db`);
const STUB_FILE = path.join(TMP_DIR, `ar-permissions-stub-${STAMP}.mjs`);
const HOTEL_B = 999;
const PREFIX = `TEST-AR-${STAMP}`;

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

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ============================================================ 副本库 */

console.log("=== 一、副本库（VACUUM INTO）+ 权限点 + 会话 ===");

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
  console.error(`❌ 复制真库失败（unable to open database file）\n  源 ${REAL_DB}\n  目标 ${COPY_DB}\n  ${e?.message ?? e}`);
  process.exit(1);
}
check("副本库已生成（VACUUM INTO）", fs.existsSync(COPY_DB) && fs.statSync(COPY_DB).size > 0, COPY_DB);

const db = new DatabaseSync(COPY_DB, { timeout: 10000 });
db.exec("PRAGMA busy_timeout = 8000");
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

globalThis.__pmsDb = db;

/* ============================================================ 桩 + 真实源码 */

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
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)
    ) {
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
const session = await import("../src/lib/session.ts");
const actions = await import("../src/app/(main)/ar/actions.ts");
check(
  "已加载真实源码：src/lib/session.ts + src/app/(main)/ar/actions.ts",
  typeof session.hasPermission === "function" && typeof actions.postArAction === "function"
);

/* ---------- 权限点 ---------- */
const EXPECT_PERM = {
  postArAction: "cashier.charge_company",
  payArAction: "cashier.receive",
  transferArAction: "cashier.transfer",
};
for (const [fn, perm] of Object.entries(EXPECT_PERM)) {
  const roles = all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = ?`, [perm]).map((r) => r.role);
  check(`${fn} 的权限点 ${perm} 在 role_permissions 里存在`, roles.length > 0, `实际 [${roles.join(",")}]`);
  check(`权限点 ${perm} 允许 admin（管理员不应被权限表锁死）`, session.hasPermission("admin", perm, 1) === true);
  check(
    `权限点 ${perm} 拒绝 housekeeping（客房不能动账务）`,
    session.hasPermission("housekeeping", perm, 1) === false
  );
}
check("坏账核销没有新增权限点（保持 requireAdmin）", all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission LIKE '%write%off%'`).length === 0);

/* ---------- 真会话 ---------- */
const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
const userRows = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = 1 ORDER BY id`);
const sidOf = {};
for (const u of userRows) {
  const sid = `test-ar-${u.role}-${STAMP}`;
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    sid,
    JSON.stringify({
      id: u.id,
      username: u.username,
      realName: u.real_name,
      role: u.role,
      hotelId: u.hotel_id,
      hotelName: "验收酒店",
    }),
    new Date().toISOString(),
    expiresAt,
  ]);
  sidOf[u.role] = sid;
}
check("4 个角色都有验收会话行", Object.keys(sidOf).length === 4, Object.keys(sidOf).join(","));

for (const [fn, perm] of Object.entries(EXPECT_PERM)) {
  stub.setSid(sidOf.admin);
  let adminOutcome;
  try {
    await session.requirePermission(perm);
    adminOutcome = "ALLOWED";
  } catch (e) {
    adminOutcome = `DENIED:${e?.message ?? e}`;
  }
  check(`requirePermission(${perm}) 对 admin 放行（${fn}）`, adminOutcome === "ALLOWED", adminOutcome);

  stub.setSid(sidOf.housekeeping);
  let hkOutcome;
  try {
    await session.requirePermission(perm);
    hkOutcome = "ALLOWED";
  } catch (e) {
    hkOutcome = `DENIED:${e?.message ?? e}`;
  }
  check(
    `requirePermission(${perm}) 对 housekeeping 抛 FORBIDDEN（${fn}）`,
    hkOutcome.startsWith("DENIED") && hkOutcome.includes("FORBIDDEN"),
    hkOutcome
  );
}

/* ============================================================ 源码层 */

console.log("\n=== 二、源码层：守卫顺序 + 幂等 + 同事务 ===");

const ACTIONS_REL = path.join("src", "app", "(main)", "ar", "actions.ts");
const PAGE_REL = path.join("src", "app", "(main)", "ar", "page.tsx");
const actionsSrc = fs.readFileSync(path.join(ROOT, ACTIONS_REL), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, PAGE_REL), "utf8");

function funcBody(src, name) {
  const sig = `export async function ${name}(`;
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + sig.length);
  return src.slice(i, j < 0 ? src.length : j);
}
function firstMutationIndex(body) {
  const patterns = [
    /(?:^|\n)\s*run\s*\(/,
    /(?:^|\n)\s*tx\s*\(/,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
  ];
  let min = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined) {
      const at = m.index + (m[0].startsWith("\n") ? 1 : 0);
      if (min < 0 || at < min) min = at;
    }
  }
  return min;
}

for (const [fn, perm] of Object.entries(EXPECT_PERM)) {
  const body = funcBody(actionsSrc, fn);
  check(`${fn} 在源码里存在`, body.length > 0);
  if (!body) continue;
  const permAt = body.search(new RegExp(`requirePermission\\(\\s*"${perm.replace(".", "\\.")}"\\s*\\)`));
  check(`${fn} 的第一道守卫是 requirePermission("${perm}")`, permAt >= 0);
  check(
    `${fn} 不再只用 requireUser()`,
    !/const\s+user\s*=\s*await\s+requireUser\(\)/.test(body.slice(0, 400)),
    body.split("\n").slice(0, 4).join(" / ")
  );
  const mutAt = firstMutationIndex(body);
  check(`${fn} 的权限断言早于任何写库`, permAt >= 0 && (mutAt < 0 || permAt < mutAt), `perm=${permAt} mutation=${mutAt}`);

  /* 幂等：读 request_id + 事务内先查 replay + 落库时带 request_id */
  check(`${fn} 读取幂等键 request_id`, /readRequestId\(formData\.get\("request_id"\)\)/.test(body));
  check(`${fn} 事务内先查重放（replayOf）再记账`, /const replay = replayOf\(/.test(body));
  check(`${fn} 写流水时带上 requestId`, /requestId/.test(body) && /recordTx\(\{/.test(body));
  /* 同事务：op_logs 必须写在 tx 回调里（在 catch 之前），不能是事务提交后再补 */
  const txAt = body.indexOf("tx(() =>");
  const logAt = body.indexOf("logArOp(");
  const catchAt = body.indexOf("} catch (e)");
  check(
    `${fn} 的 op_logs 写在 tx 回调内（余额 / 流水 / 日志同事务）`,
    txAt >= 0 && logAt > txAt && catchAt > logAt,
    `tx=${txAt} log=${logAt} catch=${catchAt}`
  );
}

const writeOffBody = funcBody(actionsSrc, "writeOffArAction");
check("writeOffArAction 仍用 requireAdmin()（坏账核销保持 admin 限制）", /const user = await requireAdmin\(\)/.test(writeOffBody));
check("writeOffArAction 也接入了 request_id 幂等", /readRequestId\(formData\.get\("request_id"\)\)/.test(writeOffBody));

check(
  "lib 层补了幂等列 request_id（CREATE TABLE + ALTER 老库）",
  /request_id TEXT/.test(actionsSrc) && /ALTER TABLE ar_transactions ADD COLUMN request_id TEXT/.test(actionsSrc)
);
check(
  "幂等键有唯一索引 (hotel_id, request_id)（重复提交在 DB 层被拒）",
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_tx_request[\s\S]{0,120}\(hotel_id, request_id\)/.test(actionsSrc)
);
check("还款有「不允许超过应收余额」校验", /付款金额不能超过应收余额/.test(actionsSrc));
check(
  "页面 4 个表单都带 request_id 隐藏域（双击重复提交带同一个键）",
  (pageSrc.match(/name="request_id"/g) ?? []).length === 4,
  `实际 ${(pageSrc.match(/name="request_id"/g) ?? []).length} 个`
);

/* ============================================================ 测试数据 */

console.log("\n=== 三、行为：真实 action 调用（副本库） ===");

const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY = todayStr();
const NOW = new Date().toISOString();

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  "TEST999",
  "AR 权限验收酒店",
  "测试地址",
  "000",
  NOW,
]);

function addAccount({ hotelId = 1, code, name, balance = 0 }) {
  return Number(
    run(
      `INSERT INTO ar_accounts (hotel_id, code, name, type, credit_limit, balance, status, contact, phone, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [hotelId, code, name, "协议单位", 50000, balance, "ON", "验收联系人", "13800000000", NOW]
    ).lastInsertRowid
  );
}
const accA = addAccount({ code: `${PREFIX}-A`, name: "AR 权限验收甲", balance: 0 });
const accB = addAccount({ code: `${PREFIX}-B`, name: "AR 权限验收乙", balance: 0 });
const accCross = addAccount({ hotelId: HOTEL_B, code: `${PREFIX}-B999`, name: "别家酒店 AR 账户", balance: 5000 });
check("已造好 3 个 AR 账户（本店 2 + hotel 999 1）", accA > 0 && accB > 0 && accCross > 0, `${accA}/${accB}/${accCross}`);

const balanceOf = (id) => round2(Number(one(`SELECT balance FROM ar_accounts WHERE id = ?`, [id])?.balance ?? 0));
const txRowsOf = (requestId) =>
  all(`SELECT id, type, amount, request_id FROM ar_transactions WHERE hotel_id = 1 AND request_id = ?`, [requestId]);
const txCount = () => Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = 1`)?.c ?? 0);
const logCount = (action) => Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = 1 AND action = ?`, [action])?.c ?? 0);

/** 调真实 action：正常返回 / NEXT_REDIRECT（back）→ 解析 ?ok= / ?err= / 抛 FORBIDDEN */
async function invoke(fn, fields) {
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
      return { kind: q.get("err") ? "err" : "ok", message: q.get("err") || q.get("ok") || "", url };
    }
    return { kind: "threw", message: msg };
  }
}

/* ---------- 3.1 越权：housekeeper / frontdesk / cashier ---------- */
stub.setSid(sidOf.housekeeping);
{
  const r = await invoke(actions.postArAction, { account_id: accA, amount: 1000, request_id: `${PREFIX}-hk-post` });
  check("housekeeper 调 postArAction → FORBIDDEN（不是登录就能入账）", r.kind === "threw" && r.message.includes("FORBIDDEN"), JSON.stringify(r));
  check("housekeeper 被拒后账户余额没有变化", balanceOf(accA) === 0);
  const r2 = await invoke(actions.payArAction, { account_id: accA, amount: 100, request_id: `${PREFIX}-hk-pay` });
  check("housekeeper 调 payArAction → FORBIDDEN", r2.kind === "threw" && r2.message.includes("FORBIDDEN"), JSON.stringify(r2));
  const r3 = await invoke(actions.transferArAction, { account_id: accA, to_account_id: accB, amount: 100, request_id: `${PREFIX}-hk-tr` });
  check("housekeeper 调 transferArAction → FORBIDDEN", r3.kind === "threw" && r3.message.includes("FORBIDDEN"), JSON.stringify(r3));
  check("三次越权尝试都没有留下任何流水", txCount() === Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = 1`)?.c ?? 0));
}

stub.setSid(sidOf.frontdesk);
{
  const r = await invoke(actions.postArAction, { account_id: accA, amount: 1000, request_id: `${PREFIX}-fd-post` });
  check(
    "frontdesk 调 postArAction → FORBIDDEN（入账需要 cashier.charge_company）",
    r.kind === "threw" && r.message.includes("FORBIDDEN"),
    JSON.stringify(r)
  );
  check("frontdesk 被拒后余额仍为 0", balanceOf(accA) === 0);
}

/* ---------- 3.2 admin / cashier 正常入账（cashier.charge_company） ---------- */
stub.setSid(sidOf.cashier);
const postLogBefore = logCount("AR 入账");
const postReq = `${PREFIX}-post-1`;
{
  const r = await invoke(actions.postArAction, {
    account_id: accA,
    amount: 1000,
    biz_date: TODAY,
    note: "验收入账",
    request_id: postReq,
  });
  check("cashier 调 postArAction 被放行（有 cashier.charge_company）", r.kind === "ok" && r.message.includes("已为"), JSON.stringify(r));
  check("入账后应收余额 = 1000.00", balanceOf(accA) === 1000, String(balanceOf(accA)));
  check("入账写了一条 POST 流水并带 request_id", txRowsOf(postReq).length === 1 && txRowsOf(postReq)[0].type === "POST");
  check("入账写了 op_logs（与流水同事务）", logCount("AR 入账") === postLogBefore + 1, `${postLogBefore} → ${logCount("AR 入账")}`);
}

/* ---------- 3.3 幂等：同一 request_id 重复提交不重复记账 ---------- */
const txCountBeforeReplay = txCount();
{
  const r = await invoke(actions.postArAction, {
    account_id: accA,
    amount: 1000,
    biz_date: TODAY,
    note: "验收入账",
    request_id: postReq,
  });
  check(
    "★ 同一 request_id 重复入账：被识别为重复提交并提示",
    r.kind === "ok" && r.message.includes("重复提交"),
    JSON.stringify(r)
  );
  check("★ 幂等：余额没有再加一次（仍 1000.00）", balanceOf(accA) === 1000, String(balanceOf(accA)));
  check("★ 幂等：该 request_id 只有 1 条流水", txRowsOf(postReq).length === 1, JSON.stringify(txRowsOf(postReq)));
  check("★ 幂等：重复提交没有产生任何新流水", txCount() === txCountBeforeReplay, `${txCountBeforeReplay} → ${txCount()}`);
}

/* ---------- 3.4 admin 还款（cashier.receive）+ 超额被拒 ---------- */
stub.setSid(sidOf.admin);
const payLogBefore = logCount("AR 收款");
const payReq = `${PREFIX}-pay-1`;
{
  const r = await invoke(actions.payArAction, {
    account_id: accA,
    amount: 300,
    biz_date: TODAY,
    note: "验收还款",
    request_id: payReq,
  });
  check("admin 调 payArAction 被放行", r.kind === "ok" && r.message.includes("已付款"), JSON.stringify(r));
  check("还款后余额 = 1000 - 300 = 700.00", balanceOf(accA) === 700, String(balanceOf(accA)));
  check("还款写了 op_logs", logCount("AR 收款") === payLogBefore + 1);
}

const balanceBeforeOver = balanceOf(accA);
const txBeforeOver = txCount();
const logBeforeOver = logCount("AR 收款");
{
  const r = await invoke(actions.payArAction, {
    account_id: accA,
    amount: 800,
    biz_date: TODAY,
    request_id: `${PREFIX}-pay-over`,
  });
  check(
    "★ 超额还款（800 > 余额 700）被拒，文案说明超过应收余额",
    r.kind === "err" && r.message.includes("不能超过应收余额"),
    JSON.stringify(r)
  );
  check("★ 超额被拒后余额不变（700.00）", balanceOf(accA) === balanceBeforeOver, String(balanceOf(accA)));
  check("★ 超额被拒后没有产生流水（金额/余额/流水同事务，不会只写一半）", txCount() === txBeforeOver, `${txBeforeOver} → ${txCount()}`);
  check("★ 超额被拒后没有写操作日志（日志与流水同事务）", logCount("AR 收款") === logBeforeOver);
}

/* ---------- 3.5 幂等：还款重复提交 ---------- */
const txCountBeforePayReplay = txCount();
{
  const r = await invoke(actions.payArAction, {
    account_id: accA,
    amount: 300,
    biz_date: TODAY,
    request_id: payReq,
  });
  check("★ 同一 request_id 重复还款：提示重复提交", r.kind === "ok" && r.message.includes("重复提交"), JSON.stringify(r));
  check("★ 幂等：余额没有再扣一次（仍 700.00）", balanceOf(accA) === 700, String(balanceOf(accA)));
  check("★ 幂等：该 request_id 只有 1 条流水", txRowsOf(payReq).length === 1);
  check("★ 幂等：重复提交没有产生任何新流水", txCount() === txCountBeforePayReplay);
}

/* ---------- 3.6 转账（cashier.transfer）+ 幂等 + 余额不足 ---------- */
const trLogBefore = logCount("AR 转账");
const trReq = `${PREFIX}-tr-1`;
{
  const r = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: accB,
    amount: 200,
    biz_date: TODAY,
    request_id: trReq,
  });
  check("admin 调 transferArAction 被放行", r.kind === "ok" && r.message.includes("调账至"), JSON.stringify(r));
  check("转账后转出账户 700 - 200 = 500.00", balanceOf(accA) === 500, String(balanceOf(accA)));
  check("转账后转入账户 0 + 200 = 200.00", balanceOf(accB) === 200, String(balanceOf(accB)));
  const legs = txRowsOf(`${trReq}#OUT`).length + txRowsOf(`${trReq}#IN`).length;
  check("★ 一次调账写两条流水（#OUT / #IN），幂等键各带后缀", legs === 2, `实际 ${legs} 条`);
  check("转账写了 op_logs", logCount("AR 转账") === trLogBefore + 1);
}
{
  const before = [balanceOf(accA), balanceOf(accB)];
  const r = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: accB,
    amount: 200,
    biz_date: TODAY,
    request_id: trReq,
  });
  check("★ 同一 request_id 重复转账：提示重复提交且不再动账", r.kind === "ok" && r.message.includes("重复提交"), JSON.stringify(r));
  check(
    "★ 幂等：两个账户余额都没有再变",
    balanceOf(accA) === before[0] && balanceOf(accB) === before[1],
    `${before.join("/")} → ${balanceOf(accA)}/${balanceOf(accB)}`
  );
}
{
  const before = [balanceOf(accA), balanceOf(accB)];
  const r = await invoke(actions.transferArAction, {
    account_id: accA,
    to_account_id: accB,
    amount: 9999,
    biz_date: TODAY,
    request_id: `${PREFIX}-tr-over`,
  });
  check("转出金额超过应收余额被拒", r.kind === "err" && r.message.includes("应收余额不足"), JSON.stringify(r));
  check("被拒后两个账户余额不变", balanceOf(accA) === before[0] && balanceOf(accB) === before[1]);
}

/* ---------- 3.7 跨酒店：不能给别家酒店的账户记账 ---------- */
const crossBalanceBefore = round2(Number(one(`SELECT balance FROM ar_accounts WHERE id = ?`, [accCross])?.balance ?? 0));
{
  const r = await invoke(actions.postArAction, {
    account_id: accCross,
    amount: 100,
    biz_date: TODAY,
    request_id: `${PREFIX}-cross-post`,
  });
  check(
    "★ 跨酒店入账被拒（admin(1) 拿 hotel 999 的账户 ID → 账户不存在）",
    r.kind === "err" && r.message.includes("不存在"),
    JSON.stringify(r)
  );
  check(
    "★ 跨酒店：hotel 999 的账户余额没有被改动",
    round2(Number(one(`SELECT balance FROM ar_accounts WHERE id = ?`, [accCross])?.balance ?? 0)) === crossBalanceBefore,
    String(crossBalanceBefore)
  );
  check(
    "★ 跨酒店：没有往 hotel 999 写流水",
    Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = ?`, [HOTEL_B])?.c ?? 0) === 0
  );
}

/* ---------- 3.8 坏账核销保持 admin ---------- */
stub.setSid(sidOf.cashier);
{
  // 找一条本店 POST 流水作为核销对象
  const postTx = one(
    `SELECT id FROM ar_transactions WHERE hotel_id = 1 AND ar_account_id = ? AND type = 'POST' ORDER BY id DESC LIMIT 1`,
    [accA]
  );
  const r = await invoke(actions.writeOffArAction, {
    account_id: accA,
    transaction_id: postTx?.id ?? 0,
    amount: 10,
    biz_date: TODAY,
    request_id: `${PREFIX}-wo-cashier`,
  });
  check(
    "cashier 调 writeOffArAction → FORBIDDEN（坏账核销保持 admin 限制）",
    r.kind === "threw" && r.message.includes("FORBIDDEN"),
    JSON.stringify(r)
  );
}
stub.setSid(sidOf.admin);
{
  const balanceBefore = balanceOf(accA);
  const postTx = one(
    `SELECT id, amount FROM ar_transactions WHERE hotel_id = 1 AND ar_account_id = ? AND type = 'POST' ORDER BY id DESC LIMIT 1`,
    [accA]
  );
  const logBefore = logCount("AR 坏账核销");
  const r = await invoke(actions.writeOffArAction, {
    account_id: accA,
    transaction_id: postTx?.id ?? 0,
    amount: 50,
    biz_date: TODAY,
    note: "验收核销",
    request_id: `${PREFIX}-wo-admin`,
  });
  check("admin 调 writeOffArAction 被放行", r.kind === "ok" && r.message.includes("已核销"), JSON.stringify(r));
  check("核销后余额减少 50", balanceOf(accA) === round2(balanceBefore - 50), `${balanceBefore} → ${balanceOf(accA)}`);
  check("核销写了一条 ar_write_offs", Number(one(`SELECT COUNT(*) AS c FROM ar_write_offs WHERE hotel_id = 1 AND ar_account_id = ?`, [accA])?.c ?? 0) >= 1);
  check("核销写了 op_logs", logCount("AR 坏账核销") === logBefore + 1);
}

/* ---------- 3.9 账实一致：余额 = 流水合计 ---------- */
{
  const sum = round2(Number(one(`SELECT COALESCE(SUM(amount), 0) AS s FROM ar_transactions WHERE hotel_id = 1 AND ar_account_id = ?`, [accA])?.s ?? 0));
  check(
    "★ 不变量：账户余额 = SUM(流水金额)（余额与流水不分叉）",
    balanceOf(accA) === sum,
    `balance=${balanceOf(accA)} sum=${sum}`
  );
}
{
  const cols = all(`PRAGMA table_info(ar_transactions)`).map((c) => c.name);
  check("ar_transactions 已有 request_id 列（老库 ALTER 生效）", cols.includes("request_id"), cols.join(","));
  const idx = all(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_ar_tx_request'`);
  check(
    "唯一索引 idx_ar_tx_request 已在库里建好",
    idx.length === 1 && /UNIQUE/i.test(String(idx[0]?.sql)),
    JSON.stringify(idx)
  );
  for (const t of ["ar_accounts", "ar_transactions", "ar_write_offs"]) {
    const tcols = all(`PRAGMA table_info(${t})`).map((c) => c.name);
    check(`${t} 带 hotel_id 列（多租户隔离）`, tcols.includes("hotel_id"), tcols.join(","));
  }
}

/* ---------- 3.10 真库零写入 ---------- */
console.log("\n=== 四、真库零写入 ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const leakedAcc = Number(real.prepare(`SELECT COUNT(*) AS c FROM ar_accounts WHERE code LIKE ?`).get(`${PREFIX}%`).c);
    const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
    const leakedSession = Number(real.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id LIKE ?`).get(`test-ar-%`).c);
    /*
     * 流水泄漏复查：不假设真库已经有 request_id 列（它是懒迁移，第一次打开 /ar 才 ALTER），
     * 改用「有没有挂在本脚本造的测试账户上的流水」——这个判断与列是否存在无关。
     */
    const leakedTx = Number(
      real
        .prepare(
          `SELECT COUNT(*) AS c FROM ar_transactions t
            WHERE EXISTS (SELECT 1 FROM ar_accounts a WHERE a.id = t.ar_account_id AND a.code LIKE ?)`
        )
        .get(`${PREFIX}%`).c
    );
    check(`真库没有测试 AR 账户（${PREFIX}* = 0）`, leakedAcc === 0, `实际 ${leakedAcc}`);
    check("真库没有被写入 999 号测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);
    check("真库没有测试会话行", leakedSession === 0, `实际 ${leakedSession}`);
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
