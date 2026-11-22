#!/usr/bin/env node
/**
 * 发票红冲动作权限 / 原因必填 / 只能红冲一次 验收（第六轮整改清单一.6，清单第 90-104 行）
 *
 * ── 清单要求 ↔ 本脚本断言 ──
 *   1. 使用 invoice.manage 或 admin 权限
 *      → 本项目没有 invoice.manage，本轮新增更窄的 invoice.void（admin / cashier）
 *      → 一、库层权限点 + 二、源码守卫 + 三、逐角色真实调用（frontdesk / housekeeping 被拒）
 *   2. 必须填写红冲原因 → 三、服务端不带原因直接构造请求必须被拒（前端 requireReason 只拦按钮）
 *   3. 必须二次确认 → 二、页面 ConfirmForm + requireReason="红冲原因"
 *   4. 原发票只能红冲一次 → 三、重复红冲被拒；把原票状态人工改回 ISSUED 后仍然红冲不出第二张
 *   5. 生成负数票和原票状态更新必须同事务 → 二、lib 的 SAVEPOINT 包住 INSERT + UPDATE；
 *      三、被拒场景下负数票数与 op_logs 条数都不变
 *   6. 写入操作人、原因和时间 → 三、红冲票 operator / remark / created_at + op_logs
 *   7. 不能跨酒店红冲 → 三、admin(1) 红冲 hotel 999 的发票被拒且状态不变
 *
 * ── 真库隔离 ──
 *   data/pms.db --VACUUM INTO--> .tmp/invoice-permissions-<时间戳>.db，注入 globalThis.__pmsDb。
 *   所有写入只进副本；结尾用只读连接复查真库零写入。
 *
 * 运行：node scripts/test-invoice-permissions.mjs
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
const COPY_DB = path.join(TMP_DIR, `invoice-permissions-${STAMP}.db`);
const STUB_FILE = path.join(TMP_DIR, `invoice-permissions-stub-${STAMP}.mjs`);
const HOTEL_B = 999;
const PREFIX = `TEST-INVPERM-${STAMP}`;

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
const actions = await import("../src/app/(main)/invoices/actions.ts");
check(
  "已加载真实源码：src/lib/session.ts + src/app/(main)/invoices/actions.ts",
  typeof session.hasPermission === "function" && typeof actions.redFlushInvoiceAction === "function"
);

/* ---------- 权限点 invoice.void ---------- */
const PERM = "invoice.void";
const roles = all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = ?`, [PERM]).map((r) => r.role);
check(`role_permissions(hotel 1, ${PERM}) 存在且只授予 admin / cashier`, roles.length > 0 && roles.every((r) => r === "admin" || r === "cashier"), `实际 [${roles.join(",")}]`);
check(`role_permissions 里 ${PERM} 包含 admin`, roles.includes("admin"));
check(`role_permissions 里 ${PERM} 包含 cashier`, roles.includes("cashier"));
check(`role_permissions 里 ${PERM} 不含 frontdesk`, !roles.includes("frontdesk"));
check(`role_permissions 里 ${PERM} 不含 housekeeping`, !roles.includes("housekeeping"));
const dictRow = one(`SELECT label, module FROM permission_dict WHERE permission = ?`, [PERM]);
check(`permission_dict 有 ${PERM} 的中文名与归属模块`, Boolean(dictRow?.label) && Boolean(dictRow?.module), JSON.stringify(dictRow));

for (const role of ["admin", "frontdesk", "cashier", "housekeeping"]) {
  const expected = role === "admin" || role === "cashier";
  const actual = session.hasPermission(role, PERM, 1);
  check(`hasPermission(${role}, ${PERM}) = ${expected}`, actual === expected, `实际 ${actual}`);
}

const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
const userRows = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = 1 ORDER BY id`);
const sidOf = {};
for (const u of userRows) {
  const sid = `test-invperm-${u.role}-${STAMP}`;
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

for (const [role, expectAllowed] of [
  ["admin", true],
  ["cashier", true],
  ["frontdesk", false],
  ["housekeeping", false],
]) {
  stub.setSid(sidOf[role]);
  let outcome;
  try {
    const u = await session.requirePermission(PERM);
    outcome = `ALLOWED:${u.role}`;
  } catch (e) {
    outcome = `DENIED:${e?.message ?? e}`;
  }
  if (expectAllowed) {
    check(`requirePermission(${PERM}) 对 ${role} 放行`, outcome === `ALLOWED:${role}`, outcome);
  } else {
    check(
      `requirePermission(${PERM}) 对 ${role} 抛 FORBIDDEN`,
      outcome.startsWith("DENIED") && outcome.includes("FORBIDDEN") && outcome.includes(PERM),
      outcome
    );
  }
}

/* ============================================================ 源码层 */

console.log("\n=== 二、源码层：守卫 + 原因必填 + 同事务 + 页面二次确认 ===");

const ACTIONS_REL = path.join("src", "app", "(main)", "invoices", "actions.ts");
const PAGE_REL = path.join("src", "app", "(main)", "invoices", "page.tsx");
const LIB_REL = path.join("src", "lib", "invoice.ts");
const actionsSrc = fs.readFileSync(path.join(ROOT, ACTIONS_REL), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, PAGE_REL), "utf8");
const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), "utf8");

const bodyStart = actionsSrc.indexOf("export async function redFlushInvoiceAction(");
const body = bodyStart >= 0 ? actionsSrc.slice(bodyStart) : "";
check("redFlushInvoiceAction 在源码里存在", body.length > 0);
const permAt = body.indexOf('requirePermission("invoice.void")');
check('第一道权限守卫是 requirePermission("invoice.void")', permAt >= 0);
const writeAt = Math.min(
  ...[body.indexOf("redFlushInvoice("), body.indexOf("INSERT INTO op_logs")].filter((n) => n > 0)
);
check("权限断言早于任何写库（redFlushInvoice / op_logs）", permAt >= 0 && !(writeAt > 0 && permAt > writeAt), `perm=${permAt} write=${writeAt}`);
check("服务端校验红冲原因非空（不是只靠前端 requireReason）", /if \(!reason\) back\(filters, "err"/.test(body));
check("红冲与 op_logs 写在同一个 tx() 里", /result = tx\(\(\) => \{/.test(body) && body.indexOf("tx(() =>") < body.indexOf("INSERT INTO op_logs"));
check(
  "事务内先查「是否已存在 red_of = 原票」再红冲（原票只能红冲一次的第二道保险）",
  /SELECT id, invoice_no FROM invoices WHERE hotel_id = \? AND red_of = \?/.test(body)
);

check("lib 的负数票 INSERT 与原票状态 UPDATE 在同一个 SAVEPOINT 里", /withSavepoint\(\(\) => \{/.test(libSrc));
check(
  "lib 红冲只允许 NORMAL + ISSUED（红冲票不能再红冲）",
  /src\.invoice_type !== "NORMAL"/.test(libSrc) && /src\.status === "RED"/.test(libSrc) && /src\.status !== "ISSUED"/.test(libSrc)
);
check("lib 的归属校验带 hotel_id（不能跨酒店红冲）", /WHERE id = \? AND hotel_id = \?/.test(libSrc));

check("页面用 ConfirmForm 二次确认", /import\s+ConfirmForm\s+from\s+"@\/components\/ConfirmForm"/.test(pageSrc) && /<ConfirmForm/.test(pageSrc));
check("页面确认框要求填写红冲原因（requireReason）", /requireReason="红冲原因"/.test(pageSrc));
check("页面把 invoice_id 一起提交", /name="invoice_id"/.test(pageSrc));
check(
  "页面按 invoice.void 权限隐藏红冲按钮（页面隐藏不代替服务端校验）",
  /hasPermission\(\s*user\.role,\s*"invoice\.void"/.test(pageSrc)
);

/* ============================================================ 测试数据 */

console.log("\n=== 三、行为：真实 action 调用（副本库） ===");

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const NOW = now.toISOString();

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  "TEST999",
  "发票权限验收酒店",
  "测试地址",
  "000",
  NOW,
]);

function addInvoice({ hotelId = 1, no, amount, type = "NORMAL", status = "ISSUED", redOf = null, operator = "造数" }) {
  return Number(
    run(
      `INSERT INTO invoices
         (hotel_id, invoice_no, invoice_type, title, tax_no, amount, folio_id, folio_no, stay_id,
          guest_name, room_no, biz_date, operator, remark, red_of, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        no,
        type,
        "发票权限验收抬头",
        null,
        amount,
        null,
        null,
        null,
        "验收客人",
        "9999",
        TODAY,
        operator,
        null,
        redOf,
        status,
        NOW,
      ]
    ).lastInsertRowid
  );
}

const invA = addInvoice({ no: `${PREFIX}-A`, amount: 300 });
const invB = addInvoice({ no: `${PREFIX}-B`, amount: 120 });
const invCross = addInvoice({ hotelId: HOTEL_B, no: `${PREFIX}-H999`, amount: 500 });
check("已造好 3 张发票（本店 2 + hotel 999 1）", invA > 0 && invB > 0 && invCross > 0, `${invA}/${invB}/${invCross}`);

const invOf = (id) => one(`SELECT * FROM invoices WHERE id = ?`, [id]);
const redChildren = (id) => all(`SELECT * FROM invoices WHERE hotel_id = 1 AND red_of = ? ORDER BY id`, [id]);
const logCount = (action) => Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = 1 AND action = ?`, [action])?.c ?? 0);

async function invoke(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  try {
    await actions.redFlushInvoiceAction(fd);
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

/* ---------- 3.1 frontdesk / housekeeping：被拒且无副作用 ---------- */
for (const role of ["frontdesk", "housekeeping"]) {
  stub.setSid(sidOf[role]);
  const before = logCount("红冲发票");
  const r = await invoke({ invoice_id: invA, reason: "越权测试" });
  check(
    `${role} 调 redFlushInvoiceAction → FORBIDDEN（不是登录就能红冲）`,
    r.kind === "threw" && r.message.includes("FORBIDDEN") && r.message.includes(PERM),
    JSON.stringify(r)
  );
  check(`${role} 被拒后原票仍是 ISSUED、没有生成负数票`, invOf(invA)?.status === "ISSUED" && redChildren(invA).length === 0);
  check(`${role} 被拒后没有写 op_logs`, logCount("红冲发票") === before);
}

/* ---------- 3.2 原因必填：cashier 不带原因也红不了 ---------- */
stub.setSid(sidOf.cashier);
{
  const r = await invoke({ invoice_id: invA });
  check(
    "★ 服务端强制红冲原因：不传原因直接构造请求被拒（前端 requireReason 可绕过）",
    r.kind === "err" && r.message.includes("请填写红冲原因"),
    JSON.stringify(r)
  );
  check("被拒后原票状态不变（仍 ISSUED）", invOf(invA)?.status === "ISSUED", String(invOf(invA)?.status));
  check("被拒后没有生成负数票", redChildren(invA).length === 0);
}
{
  const r = await invoke({ invoice_id: invA, reason: "   " });
  check("空白原因同样被拒", r.kind === "err" && r.message.includes("请填写红冲原因"), JSON.stringify(r));
}

/* ---------- 3.3 admin 正常红冲（负数票 + 原票状态 + 留痕） ---------- */
stub.setSid(sidOf.admin);
const logBefore = logCount("红冲发票");
const REASON = "客人退票重开，红冲原票";
{
  const r = await invoke({ invoice_id: invA, reason: REASON, from: TODAY, to: TODAY, status: "ISSUED" });
  check("admin 调 redFlushInvoiceAction 被放行", r.kind === "ok" && r.message.includes("已红冲"), JSON.stringify(r));

  const src = invOf(invA);
  check("★ 原票状态 ISSUED → RED（不能红冲第二次的状态依据）", src?.status === "RED", String(src?.status));

  const children = redChildren(invA);
  check("★ 红冲生成 1 张负数票（invoice_type=RED）", children.length === 1 && children[0].invoice_type === "RED", JSON.stringify(children));
  check("★ 负数票金额 = -原票金额（-300）", Number(children[0]?.amount) === -300, String(children[0]?.amount));
  check("★ 负数票 red_of 指向原票", Number(children[0]?.red_of) === invA);
  check("负数票号是 RED-营业日-序号 格式", /^RED-\d{8}-\d{3,}$/.test(String(children[0]?.invoice_no)), String(children[0]?.invoice_no));

  check("★ 写入操作人", children[0]?.operator === "张经理", String(children[0]?.operator));
  check("★ 写入红冲原因（负数票备注 = 填的原因）", children[0]?.remark === REASON, String(children[0]?.remark));
  check("★ 写入时间", Boolean(children[0]?.created_at), String(children[0]?.created_at));

  check("红冲写了 op_logs", logCount("红冲发票") === logBefore + 1, `${logBefore} → ${logCount("红冲发票")}`);
  const log = one(`SELECT operator, detail FROM op_logs WHERE hotel_id = 1 AND action = '红冲发票' ORDER BY id DESC LIMIT 1`);
  check(
    "op_logs 记了操作人 / 原票 / 红冲票号 / 原因",
    log?.operator === "张经理" && String(log.detail).includes(`#${invA}`) && String(log.detail).includes(REASON),
    JSON.stringify(log)
  );
}

/* ---------- 3.4 只能红冲一次 ---------- */
{
  const before = redChildren(invA).length;
  const logBefore2 = logCount("红冲发票");
  const r = await invoke({ invoice_id: invA, reason: "再红一次" });
  check("★ 同一张发票重复红冲被拒（提示已红冲 / 已红冲过）", r.kind === "err" && /已红冲/.test(r.message), JSON.stringify(r));
  check("★ 重复红冲没有生成第二张负数票", redChildren(invA).length === before, `${before} → ${redChildren(invA).length}`);
  check("★ 重复红冲没有写 op_logs（失败不落日志）", logCount("红冲发票") === logBefore2);
  check("★ 重复红冲没有改动原票状态（仍 RED）", invOf(invA)?.status === "RED");
}

/* 第二道保险：把原票状态人工改回 ISSUED，仍然红冲不出第二张 */
{
  run(`UPDATE invoices SET status = 'ISSUED' WHERE id = ? AND hotel_id = 1`, [invA]);
  check("已把原票状态人工改回 ISSUED（模拟脏数据）", invOf(invA)?.status === "ISSUED");
  const before = redChildren(invA).length;
  const r = await invoke({ invoice_id: invA, reason: "脏数据重复红冲" });
  check(
    "★ 状态被改回 ISSUED 后仍然拒绝重复红冲（以「是否存在 red_of」为准）",
    r.kind === "err" && /已红冲过/.test(r.message),
    JSON.stringify(r)
  );
  check("★ 负数票数量仍然只有 1 张", redChildren(invA).length === before, `${before} → ${redChildren(invA).length}`);
  run(`UPDATE invoices SET status = 'RED' WHERE id = ? AND hotel_id = 1`, [invA]);
}

/* ---------- 3.5 跨酒店红冲 ---------- */
{
  const before = Number(one(`SELECT COUNT(*) AS c FROM invoices WHERE hotel_id = ?`, [HOTEL_B])?.c ?? 0);
  const r = await invoke({ invoice_id: invCross, reason: "跨酒店红冲测试" });
  check(
    "★ admin(1) 红冲 hotel 999 的发票被拒（不属于当前酒店）",
    r.kind === "err" && /不存在或不属于当前酒店/.test(r.message),
    JSON.stringify(r)
  );
  check("★ 跨酒店：hotel 999 的发票状态未变（仍 ISSUED）", invOf(invCross)?.status === "ISSUED", String(invOf(invCross)?.status));
  check(
    "★ 跨酒店：hotel 999 没有多出发票记录（没往别家写负数票）",
    Number(one(`SELECT COUNT(*) AS c FROM invoices WHERE hotel_id = ?`, [HOTEL_B])?.c ?? 0) === before
  );
}

/* ---------- 3.6 cashier 也能红冲（权限点授权范围） ---------- */
stub.setSid(sidOf.cashier);
{
  const r = await invoke({ invoice_id: invB, reason: "收银红冲验收" });
  check("cashier 调 redFlushInvoiceAction 被放行（invoice.void 授权给收银）", r.kind === "ok", JSON.stringify(r));
  check("cashier 红冲后原票状态 = RED", invOf(invB)?.status === "RED");
  check("cashier 红冲生成负数票 -120", Number(redChildren(invB)[0]?.amount) === -120, String(redChildren(invB)[0]?.amount));
  check("负数票操作人是收银本人", redChildren(invB)[0]?.operator === "王收银", String(redChildren(invB)[0]?.operator));
}

/* ---------- 3.7 真库零写入 ---------- */
console.log("\n=== 四、真库零写入 ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const leakedInv = Number(real.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE invoice_no LIKE ?`).get(`${PREFIX}%`).c);
    const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
    const leakedSession = Number(real.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id LIKE ?`).get(`test-invperm-%`).c);
    check(`真库没有测试发票（${PREFIX}* = 0）`, leakedInv === 0, `实际 ${leakedInv}`);
    check("真库没有被写入 999 号测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);
    check("真库没有测试会话行", leakedSession === 0, `实际 ${leakedSession}`);
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
