#!/usr/bin/env node
/**
 * 协议单位（companies）Server Action 运行时权限验收
 * —— 第七轮清单 §一.1 + §五 + §六：scripts/test-companies-permissions.mjs
 *
 * ── 清单要求（第 23-31 行）──
 *   · admin 允许（调用成功，数据真的变了）
 *   · frontdesk 拒绝
 *   · cashier 拒绝
 *   · housekeeping 拒绝
 *   · 跨酒店对象拒绝（hotel 2 的对象，hotel 1 的用户改不动）
 *   · 修改和删除均写操作日志
 *   · action 直接调用也被拒绝（不是页面隐藏按钮，是真调 action 函数）
 *
 * ── 为什么拆出独立文件 ──
 * 第六轮把 companies 和 cleaners 合在 scripts/test-quote-permissions.mjs 里，
 * 清单要求「各自独立成测试文件」，本文件只测协议单位，可单独执行：
 *     node scripts/test-companies-permissions.mjs
 *
 * ── 验法（与 test-quote-permissions.mjs / test-member-permissions.mjs 同一套）──
 *   1. `VACUUM INTO` 把真库 data/pms.db 复制到 .tmp/companies-permissions-<时间戳>/，
 *      本进程打开副本并注入 `globalThis.__pmsDb` —— src/lib/db.ts 的 getDb() 优先返回它，
 *      所以**执行的是仓库里真实的 src/app/(main)/companies/actions.ts**，
 *      写的却是副本库，真库一个字节都不动（收尾用只读连接复查行数与文件 mtime）。
 *   2. 用 node:module 的 registerHooks 只把 next/headers、next/navigation、next/cache
 *      换成最小桩，session.ts 与 actions.ts 全部是仓库原文件。
 *   3. 给 admin / frontdesk / cashier / housekeeping 各造一条真实 sessions 行，
 *      直接 import action 函数调用（不渲染任何页面、不 mock 表单组件）。
 *   4. 断言：谁被拒（FORBIDDEN settings.manage）/ 谁放行、数据是否真的变、
 *      op_logs 是否留下旧值 / 新值 / 原因 / 操作人、跨酒店对象是否改不动。
 *
 * 用法：node scripts/test-companies-permissions.mjs
 *      PMS_DB_PATH=... 可指向别的真库（默认项目内 data/pms.db）
 * 退出码：有 ❌ 时 1，全绿 0。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = path.join(ROOT, ".tmp");
const TAG = "companies-permissions";
const STAMP = Date.now();
const ISO_DIR = path.join(TMP_DIR, `${TAG}-${STAMP}`);
const ISO_DB = path.join(ISO_DIR, "data", "pms.db");
const STUB_FILE = path.join(ISO_DIR, "next-stub.mjs");
const HOTEL = 1; // 1 号店（当前登录酒店）
const HOTEL_B = 999; // 2 号店：跨酒店用例的「别人家的对象」
const ROLES = ["admin", "frontdesk", "cashier", "housekeeping"];
const B_ADMIN_ID = 90002;
const B_COMPANY_ID = 990001;

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${extra ? ` :: ${extra}` : ""}`);
    console.log(`  ❌ ${label}${extra ? `  ${extra}` : ""}`);
  }
};
const section = (title) => console.log(`\n=== ${title} ===`);

/** 清单第 213-222 行：这些环境错误绝不能当成通过 */
const ENV_ERROR_RE = /unable to open database file|EPERM|database is locked|SQLITE_BUSY|fetch failed/i;
const envErrors = [];
const noteEnvError = (where, message) => {
  if (ENV_ERROR_RE.test(message)) envErrors.push(`${where} :: ${message}`);
};

function cleanupTmp() {
  try {
    globalThis.__pmsDb?.close?.();
  } catch {
    /* 已关闭 */
  }
  try {
    if (fs.existsSync(ISO_DIR)) {
      fs.rmSync(ISO_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch {
    /* 清理失败不掩盖结论 */
  }
}

function abandon(message, detail = "") {
  console.error(`\n❌ ${message}${detail ? `\n   ${detail}` : ""}`);
  cleanupTmp();
  process.exit(1);
}

/* ============================================================ 0. 副本库 + 真库只读快照 */

if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs）`);

/**
 * 真库只读快照：行数 + 文件 size/mtime + WAL 大小。
 * 只读连接不会 checkpoint、不会写 -wal，所以脚本跑完这几项必须一模一样。
 */
function realDbSnapshot() {
  const st = fs.statSync(REAL_DB);
  const wal = `${REAL_DB}-wal`;
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const one = (sql) => db.prepare(sql).get()?.c ?? 0;
    return {
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      walSize: fs.existsSync(wal) ? fs.statSync(wal).size : -1,
      companies: one(`SELECT COUNT(*) AS c FROM companies`),
      op_logs: one(`SELECT COUNT(*) AS c FROM op_logs`),
      sessions: one(`SELECT COUNT(*) AS c FROM sessions`),
      users: one(`SELECT COUNT(*) AS c FROM users`),
      hotels: one(`SELECT COUNT(*) AS c FROM hotels`),
    };
  } finally {
    db.close();
  }
}
const REAL_BEFORE = realDbSnapshot();

try {
  fs.mkdirSync(path.join(ISO_DIR, "data"), { recursive: true });
} catch (e) {
  abandon(`临时目录不可写：${ISO_DIR}`, String(e?.message ?? e));
}

try {
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${ISO_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
} catch (e) {
  const msg = String(e?.message ?? e);
  noteEnvError("VACUUM INTO", msg);
  abandon(`VACUUM INTO 复制真库失败：${REAL_DB} → ${ISO_DB}`, msg);
}
check("真库副本已生成（VACUUM INTO，脚本只在副本上写）", fs.existsSync(ISO_DB) && fs.statSync(ISO_DB).size > 0);
check(
  "副本路径与真库不同，且落在 .tmp/ 下（写入目标受控）",
  ISO_DB !== REAL_DB && ISO_DB.startsWith(ISO_DIR) && ISO_DIR.startsWith(TMP_DIR)
);

const conn = new DatabaseSync(ISO_DB);
conn.exec("PRAGMA busy_timeout = 8000");
const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);
const one = (sql, params = []) => conn.prepare(sql).get(...params);

function closeAndCleanup() {
  try {
    conn.close();
  } catch {
    /* 已关闭 */
  }
  cleanupTmp();
}
process.on("exit", closeAndCleanup);
process.on("SIGINT", () => {
  closeAndCleanup();
  process.exit(1);
});

/* ============================================================ 1. 桩 + 装载真实模块 */

/**
 * next/* 最小桩：
 *   cookies() 只实现 session.ts 用到的 get()，sid 由 setSid 切换；
 *   redirect() 抛 NEXT_REDIRECT（与 Next 内部机制一致，action 的回跳都能被捕获）；
 *   revalidatePath() 无操作。
 */
fs.writeFileSync(
  STUB_FILE,
  `let sid = null;
export function setSid(v) { sid = v; }
export function cookies() {
  return { get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined) };
}
export function headers() { return new Map(); }
export function redirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export function revalidatePath() {}
export function revalidateTag() {}
`
);
const stubUrl = pathToFileURL(STUB_FILE).href;

process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

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
        /* 不是 .ts，交给默认解析 */
      }
    }
    return next(specifier, context);
  },
});

globalThis.__pmsDb = conn;

let session;
let companies;
let stub;
try {
  session = await import("../src/lib/session.ts");
  companies = await import("../src/app/(main)/companies/actions.ts");
  stub = await import(stubUrl);
} catch (e) {
  const msg = String(e?.stack ?? e?.message ?? e);
  noteEnvError("装载模块", msg);
  abandon("装载 src/lib/session.ts 或 companies/actions.ts 失败", msg);
}

/* ============================================================ 2. 会话行 + 权限数据 */

check(
  "真实 actions.ts 导出了 3 个写操作函数（后面 all 是直接调用真实函数）",
  typeof companies.createCompanyAction === "function" &&
    typeof companies.updateCompanyAction === "function" &&
    typeof companies.deleteCompanyAction === "function",
  Object.keys(companies).join(",")
);

const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const users = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
const sidOf = {};
const realNameOf = {};
for (const u of users) {
  const sid = `test-companies-${u.role}-${STAMP}-${u.id}`;
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
    NOW,
    EXPIRES,
  ]);
  sidOf[u.role] = sid;
  realNameOf[u.role] = u.real_name;
}
check(
  "4 个岗位各有 1 条真实 sessions 行（admin / frontdesk / cashier / housekeeping）",
  ROLES.every((r) => !!sidOf[r]),
  Object.keys(sidOf).join(",")
);

/* 2 号店（hotel_id = 999）：一个 admin 账号 + 一个属于 2 号店的协议单位 */
run(`INSERT OR REPLACE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [
  HOTEL_B,
  `TB${STAMP}`.slice(0, 20),
  "验收酒店B",
  NOW,
]);
run(
  `INSERT OR REPLACE INTO users (id, hotel_id, username, password, real_name, role, status)
   VALUES (?,?,?,?,?,?,?)`,
  [B_ADMIN_ID, HOTEL_B, `testadmin_b_${STAMP}`, "x", "B店管理员", "admin", 1]
);
const sidB = `test-companies-hotelB-${STAMP}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  sidB,
  JSON.stringify({
    id: B_ADMIN_ID,
    username: `testadmin_b_${STAMP}`,
    realName: "B店管理员",
    role: "admin",
    hotelId: HOTEL_B,
    hotelName: "验收酒店B",
  }),
  NOW,
  EXPIRES,
]);
sidOf["admin@999"] = sidB;
realNameOf["admin@999"] = "B店管理员";

/* 跨酒店用例的「别人家的对象」：hotel_id = 999 的协议单位 */
run(
  `INSERT OR REPLACE INTO companies (id, hotel_id, name, contact, phone, discount, credit_limit)
   VALUES (?,?,?,?,?,?,?)`,
  [B_COMPANY_ID, HOTEL_B, `B店协议单位${String(STAMP).slice(-6)}`, "B店联系人", "0571-9999", 0.9, 12345]
);
check(
  "已就绪：2 号店（hotel_id=999）的会话 + 2 号店协议单位对象（跨酒店用例）",
  !!one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [B_COMPANY_ID, HOTEL_B]) && Number(HOTEL_B) !== HOTEL
);

/* 权限数据来自真库：settings.manage 只授予 admin */
const grantedRoles = all(`SELECT role FROM role_permissions WHERE hotel_id = ? AND permission = 'settings.manage'`, [
  HOTEL,
]).map((r) => r.role);
check(
  "副本 role_permissions 里 settings.manage 只授予 admin（配置级最严档）",
  grantedRoles.length === 1 && grantedRoles[0] === "admin",
  grantedRoles.join(",")
);
const matrix = Object.fromEntries(ROLES.map((r) => [r, session.hasPermission(r, "settings.manage", HOTEL)]));
check(
  "真实 hasPermission 矩阵：admin=true，frontdesk / cashier / housekeeping=false",
  matrix.admin === true && matrix.frontdesk === false && matrix.cashier === false && matrix.housekeeping === false,
  JSON.stringify(matrix)
);
check(
  "housekeeping 的库内权限点不含 settings.manage（客房岗位没有任何档案配置权）",
  !all(`SELECT permission FROM role_permissions WHERE hotel_id = ? AND role = 'housekeeping'`, [HOTEL])
    .map((r) => r.permission)
    .includes("settings.manage"),
  JSON.stringify(
    all(`SELECT permission FROM role_permissions WHERE hotel_id = ? AND role = 'housekeeping'`, [HOTEL]).map(
      (r) => r.permission
    )
  )
);

/* ============================================================ 调用工具 */

const fd = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) f.append(k, String(v));
  }
  return f;
};

function flashOf(res) {
  if (res.status !== "redirect") return { type: "", text: "" };
  const u = new URL(res.url, "http://local");
  const err = u.searchParams.get("err") ?? "";
  const msg = u.searchParams.get("msg") ?? "";
  return { type: err ? "err" : "msg", text: err || msg };
}

function isDenied(res, permission) {
  return (
    res.status === "throw" &&
    /FORBIDDEN/.test(res.message) &&
    (!permission || res.message.includes(permission))
  );
}

async function as(role, fn) {
  stub.setSid(sidOf[role]);
  try {
    const value = await fn();
    return { status: "resolved", value };
  } catch (e) {
    const message = String((e && e.message) || e);
    noteEnvError(`as(${role})`, message);
    if (message.startsWith("NEXT_REDIRECT:")) {
      return { status: "redirect", url: message.slice("NEXT_REDIRECT:".length) };
    }
    return { status: "throw", message };
  }
}

const like = (s, ...parts) => parts.every((p) => String(s).includes(p));
const opLogs = (action) =>
  all(`SELECT * FROM op_logs WHERE hotel_id = ? AND action = ? ORDER BY id DESC`, [HOTEL, action]);
const opLogCount = (hotel = HOTEL) =>
  one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ?`, [hotel]).c;
const companyCount = (hotel = HOTEL) =>
  one(`SELECT COUNT(*) AS c FROM companies WHERE hotel_id = ?`, [hotel]).c;

/** 源码侧的守卫位置（运行时行为已在上面证明，这里只补「守卫早于写库」） */
function guardOf(src, fnName, permission) {
  const i = src.indexOf(`export async function ${fnName}(`);
  if (i < 0) return { found: false };
  const j = src.indexOf("\nexport ", i + 10);
  const body = src.slice(i, j < 0 ? src.length : j);
  const permAt = body.indexOf(`requirePermission("${permission}")`);
  const mutateAt = Math.min(
    ...[
      body.search(/\brun\s*\(/),
      body.search(/\bINSERT\s+INTO\b/i),
      body.search(/\bUPDATE\s+\w+\s+SET\b/i),
      body.search(/\bDELETE\s+FROM\b/i),
    ].filter((n) => n >= 0)
  );
  return { found: true, permAt, mutateAt };
}

const companiesSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "companies", "actions.ts"), "utf8");
const companiesPageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "companies", "page.tsx"), "utf8");

/* ============================================================ 3. 新增协议单位 */

section("3. createCompanyAction：admin 放行且真的落库；其他岗位直调即被拒");

const companyName = `验收协议单位${String(STAMP).slice(-6)}`;
const companiesBefore = companyCount();
const opBeforeCreate = opLogCount();

let r = await as("frontdesk", () => companies.createCompanyAction(fd({ name: "越权单位F", credit_limit: 1000 })));
check("frontdesk 直调 createCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("cashier", () => companies.createCompanyAction(fd({ name: "越权单位C", credit_limit: 1000 })));
check("cashier 直调 createCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("housekeeping", () => companies.createCompanyAction(fd({ name: "越权单位H", credit_limit: 1000 })));
check("housekeeping 直调 createCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check(
  "三个岗位被拒后协议单位行数不变（没有任何半截写入）",
  companyCount() === companiesBefore,
  `${companiesBefore} → ${companyCount()}`
);
check("被拒的新增没有写 op_logs", opLogCount() === opBeforeCreate, `${opBeforeCreate} → ${opLogCount()}`);

r = await as("admin", () =>
  companies.createCompanyAction(
    fd({ name: companyName, contact: "验收联系人", phone: "0571-88886666", discount: 0.78, credit_limit: 26000 })
  )
);
check("admin 直调 createCompanyAction 放行（redirect 回 /companies 且带成功文案）", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);

const newCompany = one(`SELECT * FROM companies WHERE hotel_id = ? AND name = ?`, [HOTEL, companyName]);
check(
  "新增的数据真的写进副本库：hotel_id / 联系人 / 电话 / 折扣 / 信用额度全部正确",
  !!newCompany &&
    Number(newCompany.hotel_id) === HOTEL &&
    newCompany.contact === "验收联系人" &&
    newCompany.phone === "0571-88886666" &&
    Number(newCompany.discount) === 0.78 &&
    Number(newCompany.credit_limit) === 26000,
  newCompany ? JSON.stringify(newCompany) : "无行"
);
check("admin 新增后协议单位行数 +1", companyCount() === companiesBefore + 1, `${companiesBefore} → ${companyCount()}`);

const createLog = opLogs("新增协议单位")[0];
check(
  "新增写 op_logs（action=新增协议单位，detail 含名称 / 折扣 / 信用额度）",
  !!createLog && like(createLog.detail, companyName, "0.78", "26,000"),
  createLog ? createLog.detail : "无日志"
);
check(
  "新增日志的 operator 列就是当前操作人（admin 的真实姓名）",
  !!createLog && createLog.operator === realNameOf.admin,
  createLog ? `${createLog.operator} vs ${realNameOf.admin}` : "无日志"
);

/* 跨店写入隔离：2 号店 admin 建的单位带 999，不会出现在 1 号店 */
const bAdminName = `B店自建单位${String(STAMP).slice(-6)}`;
r = await as("admin@999", () => companies.createCompanyAction(fd({ name: bAdminName, credit_limit: 500 })));
const bAdminCompany = one(`SELECT * FROM companies WHERE name = ?`, [bAdminName]);
check("2 号店 admin 在自己店里新增放行，落库 hotel_id=999", r.status === "redirect" && !!bAdminCompany && Number(bAdminCompany.hotel_id) === HOTEL_B, bAdminCompany ? String(bAdminCompany.hotel_id) : "无行");
check("2 号店新建的单位不出现在 1 号店列表（hotel_id 隔离）", !one(`SELECT id FROM companies WHERE hotel_id = ? AND name = ?`, [HOTEL, bAdminName]));

/* ============================================================ 4. 修改协议单位（含信用额度） */

section("4. updateCompanyAction：改档案与授信都要 settings.manage；额度变更记旧值 / 新值 / 原因 / 操作人");

const sample = one(`SELECT * FROM companies WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL]);
check("副本里有可用的协议单位样本（改档 / 改额度用）", !!sample, sample ? sample.name : "无");
const sampleId = sample.id;
const oldCredit = Number(sample.credit_limit);
const oldContact = String(sample.contact ?? "");

const opBeforeUpdate = opLogCount();
r = await as("frontdesk", () =>
  companies.updateCompanyAction(fd({ id: sampleId, name: sample.name, contact: "越权F", phone: "", discount: 1, credit_limit: 99999 }))
);
check("frontdesk 直调 updateCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("cashier", () =>
  companies.updateCompanyAction(fd({ id: sampleId, name: sample.name, contact: "越权C", phone: "", discount: 1, credit_limit: 99999 }))
);
check("cashier 直调 updateCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("housekeeping", () =>
  companies.updateCompanyAction(fd({ id: sampleId, name: sample.name, contact: "越权H", phone: "", discount: 1, credit_limit: 99999 }))
);
check("housekeeping 直调 updateCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
const afterDeniedUpdate = one(`SELECT contact, credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]);
check(
  "三个岗位被拒后档案与信用额度都没变",
  String(afterDeniedUpdate.contact ?? "") === oldContact && Number(afterDeniedUpdate.credit_limit) === oldCredit,
  JSON.stringify(afterDeniedUpdate)
);
check("被拒的修改没有写 op_logs", opLogCount() === opBeforeUpdate, `${opBeforeUpdate} → ${opLogCount()}`);

/* 跨酒店方向 A：1 号店 admin 改 2 号店的对象 → 查不到本店对象，拒绝 */
r = await as("admin", () =>
  companies.updateCompanyAction(fd({ id: B_COMPANY_ID, name: "跨店改名", contact: "x", phone: "", discount: 1, credit_limit: 1, reason: "跨店" }))
);
check("1 号店 admin 改 2 号店（hotel_id=999）的协议单位被拒（不属于本店）", r.status === "redirect" && flashOf(r).type === "err", `${r.status} ${flashOf(r).text || r.message}`);
const bCompanyStill = one(`SELECT * FROM companies WHERE id = ? AND hotel_id = ?`, [B_COMPANY_ID, HOTEL_B]);
check(
  "2 号店对象一个字段都没变（名称 / 额度仍是 12345）",
  String(bCompanyStill.name).startsWith("B店协议单位") && Number(bCompanyStill.credit_limit) === 12345,
  JSON.stringify(bCompanyStill)
);

/* 跨酒店方向 B：2 号店 admin 改 1 号店的对象 → 同样拒绝 */
r = await as("admin@999", () =>
  companies.updateCompanyAction(fd({ id: sampleId, name: "B店越权改名", contact: "x", phone: "", discount: 1, credit_limit: 1, reason: "越权" }))
);
check("2 号店 admin 改 1 号店的协议单位被拒（跨酒店反向同样拒）", r.status === "redirect" && flashOf(r).type === "err", `${r.status} ${flashOf(r).text || r.message}`);
check(
  "1 号店样本对象的名称与额度没被跨店请求改动",
  String(one(`SELECT name FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).name) === String(sample.name) &&
    Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).credit_limit) === oldCredit
);

/* admin 改信用额度：必须带原因，额度真的变，日志含旧值/新值/原因/操作人 */
const NEW_CREDIT = 77777;
r = await as("admin", () =>
  companies.updateCompanyAction(
    fd({
      id: sampleId,
      name: sample.name,
      contact: oldContact,
      phone: sample.phone ?? "",
      discount: sample.discount,
      credit_limit: NEW_CREDIT,
      reason: "年度合同续签，授信提额",
    })
  )
);
check("admin 改信用额度（带原因）放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check(
  "信用额度真的从旧值改成新值（数据层验证，不是只看返回值）",
  Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).credit_limit) === NEW_CREDIT,
  `${oldCredit} → ${one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).credit_limit}`
);

const creditLog = opLogs("变更信用额度")[0];
check("修改信用额度写 op_logs（action=变更信用额度）", !!creditLog, creditLog ? creditLog.detail : "无日志");
const creditDigits = String((creditLog && creditLog.detail) || "").replace(/,/g, "");
check(
  "授信日志含旧值与新值（旧值 ¥x → 新值 ¥y）",
  !!creditLog && like(creditLog.detail, "旧值", "新值", "→") && creditDigits.includes(String(oldCredit)) && creditDigits.includes(String(NEW_CREDIT)),
  creditLog ? creditLog.detail : "无日志"
);
check(
  "授信日志含变更原因",
  !!creditLog && like(creditLog.detail, "原因：年度合同续签，授信提额"),
  creditLog ? creditLog.detail : "无日志"
);
check(
  "授信日志含操作人（detail 与 operator 列各一份）",
  !!creditLog && creditLog.operator === realNameOf.admin && String(creditLog.detail).includes(`操作人：${creditLog.operator}`),
  creditLog ? `${creditLog.operator} / ${creditLog.detail}` : "无日志"
);

/* 无原因改额度 → 服务端拒绝（页面兜不住的边界） */
r = await as("admin", () =>
  companies.updateCompanyAction(fd({ id: sampleId, name: sample.name, contact: oldContact, phone: sample.phone ?? "", discount: sample.discount, credit_limit: 1234 }))
);
check(
  "admin 改信用额度但不填原因被拒（授信变更强制说明原因）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "原因"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check(
  "无原因的额度调整没有落库（仍是 77777）",
  Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).credit_limit) === NEW_CREDIT
);

/* 只改档案不动额度 → 不需要原因，但也要留痕 */
const opBeforeProfile = opLogCount();
r = await as("admin", () =>
  companies.updateCompanyAction(
    fd({ id: sampleId, name: sample.name, contact: "验收新联系人", phone: sample.phone ?? "", discount: sample.discount, credit_limit: NEW_CREDIT })
  )
);
check("只改联系人（不动额度）放行且不要求原因", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check(
  "联系人真的改成新值、额度保持不变",
  String(one(`SELECT contact FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).contact) === "验收新联系人" &&
    Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).credit_limit) === NEW_CREDIT
);
const profileLog = opLogs("修改协议单位")[0];
check(
  "只改档案写 op_logs（action=修改协议单位，含旧联系人 → 新联系人）",
  !!profileLog && like(profileLog.detail, "联系人", oldContact, "验收新联系人") && opLogCount() === opBeforeProfile + 1,
  profileLog ? profileLog.detail : "无日志"
);

/* 非法额度兜底 */
r = await as("admin", () =>
  companies.updateCompanyAction(fd({ id: sampleId, name: sample.name, contact: "验收新联系人", phone: "", discount: sample.discount, credit_limit: -1, reason: "负数" }))
);
check(
  "负数信用额度被拒且不落库",
  r.status === "redirect" &&
    flashOf(r).type === "err" &&
    Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [sampleId, HOTEL]).credit_limit) === NEW_CREDIT,
  `${r.status} ${flashOf(r).text || r.message}`
);

/* 守卫位置补充：requirePermission 在第一次写库之前 */
for (const fnName of ["createCompanyAction", "updateCompanyAction", "deleteCompanyAction"]) {
  const g = guardOf(companiesSrc, fnName, "settings.manage");
  check(
    `${fnName} 的 requirePermission("settings.manage") 在第一次写库之前（源码位置补充，行为已由运行时证明）`,
    g.found && g.permAt >= 0 && (Number.isNaN(g.mutateAt) || g.permAt < g.mutateAt),
    JSON.stringify(g)
  );
}
const exportedFns = [...companiesSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort();
check(
  "actions.ts 的全部导出函数都被本测试覆盖（未来新增写 action 必须补测，否则这里会先红）",
  JSON.stringify(exportedFns) === JSON.stringify(["createCompanyAction", "deleteCompanyAction", "updateCompanyAction"]),
  exportedFns.join(",")
);
check(
  "companies/actions.ts 没有残留作权限用的 requireUser() 调用（注释里的说明不算）",
  !/\brequireUser\s*\(/.test(companiesSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))
);

/* ============================================================ 5. 删除协议单位 */

section("5. deleteCompanyAction：admin 放行且真的删；其他岗位 / 跨店 / 无原因均拒绝");

const opBeforeDelete = opLogCount();
const delCountBefore = companyCount();
r = await as("frontdesk", () => companies.deleteCompanyAction(fd({ id: newCompany.id, reason: "越权删除F" })));
check("frontdesk 直调 deleteCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("cashier", () => companies.deleteCompanyAction(fd({ id: newCompany.id, reason: "越权删除C" })));
check("cashier 直调 deleteCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("housekeeping", () => companies.deleteCompanyAction(fd({ id: newCompany.id, reason: "越权删除H" })));
check("housekeeping 直调 deleteCompanyAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check(
  "三个岗位被拒后协议单位仍在、行数与 op_logs 都没变",
  !!one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [newCompany.id, HOTEL]) &&
    companyCount() === delCountBefore &&
    opLogCount() === opBeforeDelete,
  `${delCountBefore} → ${companyCount()}`
);

/* 跨酒店：两个方向都不能删别人家的对象 */
r = await as("admin", () => companies.deleteCompanyAction(fd({ id: B_COMPANY_ID, reason: "跨店删除A" })));
check("1 号店 admin 删 2 号店的协议单位被拒", r.status === "redirect" && flashOf(r).type === "err", `${r.status} ${flashOf(r).text || r.message}`);
check("2 号店对象仍在（跨店删除没有生效）", !!one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [B_COMPANY_ID, HOTEL_B]));

r = await as("admin@999", () => companies.deleteCompanyAction(fd({ id: newCompany.id, reason: "跨店删除B" })));
check("2 号店 admin 删 1 号店的协议单位被拒", r.status === "redirect" && flashOf(r).type === "err", `${r.status} ${flashOf(r).text || r.message}`);
check("1 号店对象仍在（跨店删除反向也没有生效）", !!one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [newCompany.id, HOTEL]));

/* 无原因的删除 → 服务端二次确认兜底 */
r = await as("admin", () => companies.deleteCompanyAction(fd({ id: newCompany.id })));
check(
  "admin 删除不填原因被拒（服务端二次确认，防绕过页面）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "原因"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("无原因的删除没有生效", !!one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [newCompany.id, HOTEL]));

/* admin 带原因删除 → 真的删掉 + 留痕 */
const delReason = "单位注销，合作协议到期";
r = await as("admin", () => companies.deleteCompanyAction(fd({ id: newCompany.id, reason: delReason })));
check("admin 带原因删除放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check("数据真的被删除（副本库里查不到了）", !one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [newCompany.id, HOTEL]));
check(
  "删除后协议单位行数比删除前少 1，并回到本脚本开始时的行数",
  companyCount() === delCountBefore - 1 && companyCount() === companiesBefore,
  `${delCountBefore} → ${companyCount()}（初始 ${companiesBefore}）`
);

const deleteLog = opLogs("删除协议单位")[0];
check(
  "删除写 op_logs（action=删除协议单位，detail 含名称 / ID / 原因）",
  !!deleteLog && like(deleteLog.detail, companyName, `ID ${newCompany.id}`, `原因：${delReason}`),
  deleteLog ? deleteLog.detail : "无日志"
);
check(
  "删除日志的 operator 列是 admin 真实姓名、时间戳非空",
  !!deleteLog && deleteLog.operator === realNameOf.admin && String(deleteLog.created_at ?? "").length > 0,
  deleteLog ? `${deleteLog.operator} @ ${deleteLog.created_at}` : "无日志"
);

/* ============================================================ 6. 直调 vs 页面隐藏 */

section("6. 直接调用 action 即被拒（页面隐藏按钮不是安全边界）");

/* 上面的每一次调用都是 `await companies.xxx(fd(...))`，没有经过任何页面组件；
   这里再显式证明：页面侧确实隐藏了入口，但服务端在无权限时独立拒绝。 */
check(
  "本脚本所有调用都是直接 import actions.ts 后调用函数（无页面渲染、无组件 mock）",
  typeof companies.updateCompanyAction === "function" && typeof companies.deleteCompanyAction === "function"
);
check(
  "companies/page.tsx 用 hasPermission(..., \"settings.manage\") 决定 canWrite（页面隐藏入口）",
  /hasPermission\(user\.role,\s*"settings\.manage",\s*user\.hotelId\)/.test(companiesPageSrc) &&
    /\{canWrite \? \(/.test(companiesPageSrc) &&
    companiesPageSrc.includes("action={createCompanyAction}")
);
check(
  "页面隐藏不等于安全：无权限角色直调同一函数仍拿到 FORBIDDEN（本脚本已实测）",
  isDenied(
    await as("frontdesk", () => companies.updateCompanyAction(fd({ id: sampleId, name: sample.name, credit_limit: 1, reason: "x" }))),
    "settings.manage"
  )
);
check(
  "companies/page.tsx 删除入口用 ConfirmForm + requireReason（二次确认 + 原因必填）",
  /import ConfirmForm from "@\/components\/ConfirmForm"/.test(companiesPageSrc) &&
    /<ConfirmForm[\s\S]{0,600}action=\{deleteCompanyAction\}/.test(companiesPageSrc) &&
    /requireReason="删除原因"/.test(companiesPageSrc)
);

/* ============================================================ 7. 收尾：真库零写入 + 环境错误 */

section("7. 收尾：真库零写入复查 + 清单 213-222 环境项");

const REAL_AFTER = realDbSnapshot();
check(
  "真库 companies / op_logs / sessions / users / hotels 行数全部未变",
  REAL_AFTER.companies === REAL_BEFORE.companies &&
    REAL_AFTER.op_logs === REAL_BEFORE.op_logs &&
    REAL_AFTER.sessions === REAL_BEFORE.sessions &&
    REAL_AFTER.users === REAL_BEFORE.users &&
    REAL_AFTER.hotels === REAL_BEFORE.hotels,
  `before=${JSON.stringify(REAL_BEFORE)}\n   after=${JSON.stringify(REAL_AFTER)}`
);
check(
  "真库文件 size / mtime / -wal 大小全部未变（只读打开，写入只发生在 .tmp 副本）",
  REAL_AFTER.size === REAL_BEFORE.size &&
    REAL_AFTER.mtimeMs === REAL_BEFORE.mtimeMs &&
    REAL_AFTER.walSize === REAL_BEFORE.walSize,
  `before=${REAL_BEFORE.size}/${REAL_BEFORE.mtimeMs}/${REAL_BEFORE.walSize} after=${REAL_AFTER.size}/${REAL_AFTER.mtimeMs}/${REAL_AFTER.walSize}`
);
/* 关闭副本连接 → 删临时目录 → 实测确认连 -wal / -shm 都没有残留 */
closeAndCleanup();
const leftovers = fs.existsSync(TMP_DIR) ? fs.readdirSync(TMP_DIR).filter((n) => n.startsWith(TAG)) : [];
check(
  "临时副本目录已清理（目录、-wal、-shm 均无残留）",
  !fs.existsSync(ISO_DIR) && leftovers.length === 0,
  leftovers.join(",")
);
check(
  "本次运行未出现清单 213-222 的环境错误（unable to open database file / EPERM / database is locked / SQLITE_BUSY）",
  envErrors.length === 0,
  envErrors.join(" | ")
);

console.log("\n========== 汇总 ==========");
if (fail > 0) {
  console.log("❌ 未通过项：");
  for (const f of failures) console.log(`   - ${f}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);

process.exit(fail === 0 ? 0 : 1);
