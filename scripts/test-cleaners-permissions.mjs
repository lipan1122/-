#!/usr/bin/env node
/**
 * 打扫员（cleaners）Server Action 运行时权限验收
 * —— 第七轮清单 §一.1 + §五 + §六：scripts/test-cleaners-permissions.mjs
 *
 * ── 清单要求（第 23-31 行）──
 *   · admin 允许（调用成功，数据真的变了）
 *   · frontdesk 拒绝
 *   · cashier 拒绝
 *   · housekeeping 拒绝 —— 清单特别强调「客房人员不能修改打扫员档案」
 *   · 跨酒店对象拒绝（hotel 2 的对象，hotel 1 的用户改不动）
 *   · 修改和删除均写操作日志
 *   · action 直接调用也被拒绝（不是页面隐藏按钮，是真调 action 函数）
 *
 * ── 打扫员模块的「修改 / 删除」口径 ──
 * 本模块**没有物理删除**：停用只把 cleaners.status 改成 INACTIVE，从不动 DELETE 行，
 * 因为 cleaners 行是 housekeeping 历史业绩汇总的姓名来源。所以清单里的「删除留痕」
 * 在此模块体现为：停用也写 op_logs（含旧状态 → 新状态 + 操作人），且停用后
 * 历史已完成任务数一分不少、行仍在。本脚本两类都验证。
 *
 * ── 为什么拆出独立文件 ──
 * 第六轮把 companies 和 cleaners 合在 scripts/test-quote-permissions.mjs 里，
 * 清单要求「各自独立成测试文件」，本文件只测打扫员，可单独执行：
 *     node scripts/test-cleaners-permissions.mjs
 *
 * ── 验法（与 test-quote-permissions.mjs / test-member-permissions.mjs 同一套）──
 *   1. `VACUUM INTO` 把真库 data/pms.db 复制到 .tmp/cleaners-permissions-<时间戳>/，
 *      本进程打开副本并注入 `globalThis.__pmsDb` —— src/lib/db.ts 的 getDb() 优先返回它，
 *      所以**执行的是仓库里真实的 src/app/(main)/cleaners/actions.ts**，
 *      写的却是副本库，真库一个字节都不动（收尾用只读连接复查行数 + 文件 mtime）。
 *   2. 用 node:module 的 registerHooks 只把 next/headers、next/navigation、next/cache
 *      换成最小桩，session.ts 与 actions.ts 全部是仓库原文件。
 *   3. 给 admin / frontdesk / cashier / housekeeping 各造一条真实 sessions 行，
 *      直接 import action 函数调用（不渲染任何页面、不 mock 表单组件）。
 *      其中 housekeeping 用**本人（赵阿姨）的会话**去新增档案、停用自己 —— 最恶意的越权路径。
 *   4. 断言：谁被拒（FORBIDDEN settings.manage）/ 谁放行、状态与数据是否真的变、
 *      op_logs 是否留下旧状态 / 新状态 / 操作人、跨酒店对象是否改不动、历史业绩是否保留。
 *
 * 用法：node scripts/test-cleaners-permissions.mjs
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
const TAG = "cleaners-permissions";
const STAMP = Date.now();
const ISO_DIR = path.join(TMP_DIR, `${TAG}-${STAMP}`);
const ISO_DB = path.join(ISO_DIR, "data", "pms.db");
const STUB_FILE = path.join(ISO_DIR, "next-stub.mjs");
const HOTEL = 1; // 1 号店（当前登录酒店）
const HOTEL_B = 999; // 2 号店：跨酒店用例的「别人家的对象」
const ROLES = ["admin", "frontdesk", "cashier", "housekeeping"];
const B_ADMIN_ID = 90003;
const B_CLEANER_ID = 990002;

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
      cleaners: one(`SELECT COUNT(*) AS c FROM cleaners`),
      housekeeping: one(`SELECT COUNT(*) AS c FROM housekeeping`),
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
 *   redirect() 抛 NEXT_REDIRECT（与 Next 内部机制一致，cleaners 的 action 全靠 redirect 回跳）；
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
let cleaners;
let stub;
try {
  session = await import("../src/lib/session.ts");
  cleaners = await import("../src/app/(main)/cleaners/actions.ts");
  stub = await import(stubUrl);
} catch (e) {
  const msg = String(e?.stack ?? e?.message ?? e);
  noteEnvError("装载模块", msg);
  abandon("装载 src/lib/session.ts 或 cleaners/actions.ts 失败", msg);
}

/* ============================================================ 2. 会话行 + 权限数据 */

check(
  "真实 actions.ts 导出了 2 个写操作函数（后面全部是直接调用真实函数）",
  typeof cleaners.addCleanerAction === "function" && typeof cleaners.setCleanerStatusAction === "function",
  Object.keys(cleaners).join(",")
);

const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const users = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
const sidOf = {};
const realNameOf = {};
for (const u of users) {
  const sid = `test-cleaners-${u.role}-${STAMP}-${u.id}`;
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

/* 2 号店（hotel_id = 999）：一个 admin 账号 + 一个属于 2 号店的打扫员 */
run(`INSERT OR REPLACE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [
  HOTEL_B,
  `TB${STAMP}`.slice(0, 20),
  "验收酒店B",
  NOW,
]);
run(
  `INSERT OR REPLACE INTO users (id, hotel_id, username, password, real_name, role, status)
   VALUES (?,?,?,?,?,?,?)`,
  [B_ADMIN_ID, HOTEL_B, `testadmin_c_b_${STAMP}`, "x", "B店管理员", "admin", 1]
);
const sidB = `test-cleaners-hotelB-${STAMP}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  sidB,
  JSON.stringify({
    id: B_ADMIN_ID,
    username: `testadmin_c_b_${STAMP}`,
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

/* 跨酒店用例的「别人家的对象」：hotel_id = 999 的打扫员 */
run(
  `INSERT OR REPLACE INTO cleaners (id, hotel_id, name, phone, status, created_at)
   VALUES (?,?,?,?,?,?)`,
  [B_CLEANER_ID, HOTEL_B, `B店阿姨${String(STAMP).slice(-6)}`, "13900009999", "ACTIVE", NOW]
);
check(
  "已就绪：2 号店（hotel_id=999）的会话 + 2 号店打扫员对象（跨酒店用例）",
  !!one(`SELECT id FROM cleaners WHERE id = ? AND hotel_id = ?`, [B_CLEANER_ID, HOTEL_B]) && Number(HOTEL_B) !== HOTEL
);

/* 权限数据来自真库：settings.manage 只授予 admin */
const grantedRoles = all(`SELECT role FROM role_permissions WHERE hotel_id = ? AND permission = 'settings.manage'`, [
  HOTEL,
]).map((r) => r.role);
check(
  "副本 role_permissions 里 settings.manage 只授予 admin（人事档案配置的最严档）",
  grantedRoles.length === 1 && grantedRoles[0] === "admin",
  grantedRoles.join(",")
);
const matrix = Object.fromEntries(ROLES.map((r) => [r, session.hasPermission(r, "settings.manage", HOTEL)]));
check(
  "真实 hasPermission 矩阵：admin=true，frontdesk / cashier / housekeeping=false",
  matrix.admin === true && matrix.frontdesk === false && matrix.cashier === false && matrix.housekeeping === false,
  JSON.stringify(matrix)
);
const hkPerms = all(`SELECT permission FROM role_permissions WHERE hotel_id = ? AND role = 'housekeeping'`, [HOTEL]).map(
  (r) => r.permission
);
check(
  "housekeeping 的库内权限点不含 settings.manage（客房岗位没有任何档案配置权）",
  !hkPerms.includes("settings.manage"),
  JSON.stringify(hkPerms)
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
const opLogCount = (hotel = HOTEL) => one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ?`, [hotel]).c;
const cleanerCount = (hotel = HOTEL) => one(`SELECT COUNT(*) AS c FROM cleaners WHERE hotel_id = ?`, [hotel]).c;
const pendingOf = (name) =>
  Number(
    one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status IN ('PENDING','DOING')`, [
      HOTEL,
      name,
    ]).c
  );
const doneOf = (name) =>
  Number(
    one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status = 'DONE'`, [HOTEL, name]).c
  );

/** 源码侧：requirePermission 是否早于第一次写库（行为已由运行时证明，这里只补位置） */
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

const cleanersSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "cleaners", "actions.ts"), "utf8");
const cleanersPageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "cleaners", "page.tsx"), "utf8");

/* ============================================================ 3. 新增打扫员 */

section("3. addCleanerAction：admin 放行且真的落库；frontdesk / cashier / housekeeping 直调即被拒");

const zhao = one(`SELECT * FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, "赵阿姨"]);
const qian = one(`SELECT * FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, "钱阿姨"]);
check("副本里有赵阿姨 / 钱阿姨两个样本（启停与业绩用）", !!zhao && !!qian, `${!!zhao}/${!!qian}`);
check(
  "前置数据：赵阿姨名下有未完成任务（停用应被拒）",
  !!zhao && pendingOf("赵阿姨") > 0,
  zhao ? `pending=${pendingOf("赵阿姨")}` : "无"
);
check(
  "前置数据：钱阿姨无未完成任务但有历史已完成任务（可停用且业绩应保留）",
  !!qian && pendingOf("钱阿姨") === 0 && doneOf("钱阿姨") > 0,
  qian ? `pending=${pendingOf("钱阿姨")} done=${doneOf("钱阿姨")}` : "无"
);

const newCleanerName = `验收阿姨${String(STAMP).slice(-6)}`;
const cleanersBefore = cleanerCount();
const opBeforeAdd = opLogCount();

let r = await as("frontdesk", () => cleaners.addCleanerAction(fd({ name: "越权阿姨F", phone: "13800001111" })));
check("frontdesk 直调 addCleanerAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("cashier", () => cleaners.addCleanerAction(fd({ name: "越权阿姨C", phone: "13800002222" })));
check("cashier 直调 addCleanerAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("housekeeping", () => cleaners.addCleanerAction(fd({ name: "越权阿姨H", phone: "13800003333" })));
check(
  "housekeeping 直调 addCleanerAction 被拒（清单：客房人员不能修改打扫员档案）",
  isDenied(r, "settings.manage"),
  r.message
);
check("三个岗位被拒后打扫员行数不变（没有任何半截写入）", cleanerCount() === cleanersBefore, `${cleanersBefore} → ${cleanerCount()}`);
check("被拒的新增没有写 op_logs", opLogCount() === opBeforeAdd, `${opBeforeAdd} → ${opLogCount()}`);

r = await as("admin", () => cleaners.addCleanerAction(fd({ name: newCleanerName, phone: "13800008888" })));
check(
  "admin 直调 addCleanerAction 放行（redirect 回 /cleaners 且带成功文案）",
  r.status === "redirect" && flashOf(r).type === "msg",
  `${r.status} ${flashOf(r).text || r.message}`
);
const newCleaner = one(`SELECT * FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, newCleanerName]);
check(
  "新增的数据真的写进副本库：hotel_id / 姓名 / 电话 / 状态 ACTIVE",
  !!newCleaner &&
    Number(newCleaner.hotel_id) === HOTEL &&
    newCleaner.name === newCleanerName &&
    newCleaner.phone === "13800008888" &&
    newCleaner.status === "ACTIVE" &&
    String(newCleaner.created_at ?? "").length > 0,
  newCleaner ? JSON.stringify(newCleaner) : "无行"
);
check("admin 新增后打扫员行数 +1", cleanerCount() === cleanersBefore + 1, `${cleanersBefore} → ${cleanerCount()}`);

const addLog = opLogs("新增打扫员")[0];
check(
  "新增写 op_logs（action=新增打扫员，detail 含姓名 / 电话 / 状态 ACTIVE）",
  !!addLog && like(addLog.detail, newCleanerName, "13800008888", "ACTIVE"),
  addLog ? addLog.detail : "无日志"
);
check(
  "新增日志的 operator 列就是当前操作人（admin 的真实姓名）",
  !!addLog && addLog.operator === realNameOf.admin,
  addLog ? `${addLog.operator} vs ${realNameOf.admin}` : "无日志"
);

/* 业务校验兜底：重名 / 超长 / 电话格式（页面校验绕过后服务端仍拦） */
const afterAddCount = cleanerCount();
r = await as("admin", () => cleaners.addCleanerAction(fd({ name: "赵阿姨", phone: "13800009999" })));
check(
  "重名打扫员被服务端拒绝（已存在同名档案）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "已存在", "赵阿姨"),
  `${r.status} ${flashOf(r).text || r.message}`
);
r = await as("admin", () => cleaners.addCleanerAction(fd({ name: `超长姓名${"长".repeat(18)}`, phone: "13800009999" })));
check(
  "姓名超过 20 个字被拒（服务端长度校验）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "20"),
  `${r.status} ${flashOf(r).text || r.message}`
);
r = await as("admin", () => cleaners.addCleanerAction(fd({ name: "电话错误阿姨", phone: "12" })));
check(
  "电话格式不合法被拒（5-20 位号码）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "电话"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("三条被拒的校验都没有建出打扫员", cleanerCount() === afterAddCount, `${afterAddCount} → ${cleanerCount()}`);

/* 跨店写入隔离：2 号店 admin 建的打扫员带 999，不会出现在 1 号店 */
const bCleanerName = `B店自建阿姨${String(STAMP).slice(-6)}`;
r = await as("admin@999", () => cleaners.addCleanerAction(fd({ name: bCleanerName, phone: "13900001111" })));
const bNewCleaner = one(`SELECT * FROM cleaners WHERE name = ?`, [bCleanerName]);
check(
  "2 号店 admin 在自己店里新增放行，落库 hotel_id=999",
  r.status === "redirect" && !!bNewCleaner && Number(bNewCleaner.hotel_id) === HOTEL_B,
  bNewCleaner ? String(bNewCleaner.hotel_id) : "无行"
);
check("2 号店新建的打扫员不出现在 1 号店列表（hotel_id 隔离）", !one(`SELECT id FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, bCleanerName]));

/* ============================================================ 4. 停用 / 启用打扫员 */

section("4. setCleanerStatusAction：客房岗位停不了任何人（包括自己）；停用前查未完成任务；启停都留痕");

const opBeforeStatus = opLogCount();
r = await as("frontdesk", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check("frontdesk 直调 setCleanerStatusAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("cashier", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check("cashier 直调 setCleanerStatusAction 被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("housekeeping", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check(
  "housekeeping 直调 setCleanerStatusAction 被拒（清单：客房人员不能修改打扫员档案）",
  isDenied(r, "settings.manage"),
  r.message
);
check(
  "三个岗位被拒后赵阿姨仍在岗、op_logs 没有新增",
  one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE" &&
    opLogCount() === opBeforeStatus,
  `status=${one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status}`
);

/* 最恶意路径：客房人员（赵阿姨本人）停用自己 —— 依然被权限层拦下 */
r = await as("housekeeping", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check(
  "客房人员用本人会话停用自己（赵阿姨 → 自己）仍被拒（不是页面按钮隐藏的问题）",
  isDenied(r, "settings.manage"),
  r.message
);
check("自停用被拒后本人仍是 ACTIVE", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE");

/* 跨酒店方向 A：1 号店 admin 停用 2 号店的对象 → 查不到本店对象，拒绝 */
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: B_CLEANER_ID, status: "INACTIVE" })));
check(
  "1 号店 admin 停用 2 号店（hotel_id=999）的打扫员被拒（该打扫员不属于本店）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "不存在"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check(
  "2 号店对象状态一个字段都没变（仍 ACTIVE）",
  one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [B_CLEANER_ID, HOTEL_B]).status === "ACTIVE"
);

/* 跨酒店方向 B：2 号店 admin 停用 1 号店的对象 → 同样拒绝 */
r = await as("admin@999", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check("2 号店 admin 停用 1 号店的打扫员被拒（跨酒店反向同样拒）", r.status === "redirect" && flashOf(r).type === "err", `${r.status} ${flashOf(r).text || r.message}`);
check("1 号店赵阿姨仍是 ACTIVE（跨店请求没有生效）", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE");

/* 停用前检查未完成任务：赵阿姨有 17 条 PENDING */
const zhaoPending = pendingOf("赵阿姨");
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check(
  "赵阿姨名下有未完成任务时停用被拒（提示未完成条数）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "未完成", String(zhaoPending)),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("被拒后赵阿姨仍是 ACTIVE", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE");

/* 钱阿姨没有未完成任务 → 可停用；停用只改状态，历史业绩保留 */
const qianDoneBefore = doneOf("钱阿姨");
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: qian.id, status: "INACTIVE" })));
check(
  "admin 停用无未完成任务的钱阿姨放行",
  r.status === "redirect" && flashOf(r).type === "msg",
  `${r.status} ${flashOf(r).text || r.message}`
);
check(
  "钱阿姨状态真的改为 INACTIVE（数据层验证）",
  one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]).status === "INACTIVE",
  String(one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]).status)
);
check("打扫员行没有被删除（历史业绩的姓名来源保留）", !!one(`SELECT id FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]));
check(
  "停用后历史已完成任务数不变（业绩保留）",
  doneOf("钱阿姨") === qianDoneBefore,
  `${qianDoneBefore} → ${doneOf("钱阿姨")}`
);

const disableLog = opLogs("停用打扫员")[0];
check(
  "停用写 op_logs（action=停用打扫员，detail 含姓名 / ACTIVE → INACTIVE）",
  !!disableLog && like(disableLog.detail, "钱阿姨", "ACTIVE → INACTIVE"),
  disableLog ? disableLog.detail : "无日志"
);
check(
  "停用日志的 operator 列是 admin 真实姓名、时间戳非空",
  !!disableLog && disableLog.operator === realNameOf.admin && String(disableLog.created_at ?? "").length > 0,
  disableLog ? `${disableLog.operator} @ ${disableLog.created_at}` : "无日志"
);
check(
  "停用日志声明历史业绩保留（不改删任务记录）",
  !!disableLog && like(disableLog.detail, "历史业绩保留"),
  disableLog ? disableLog.detail : "无日志"
);

/* 重复停用同一状态 → 拒绝（幂等提示，不重复写日志） */
const opBeforeDup = opLogCount();
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: qian.id, status: "INACTIVE" })));
check(
  "重复停用同一状态被拒（已是停用状态）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "已经是"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("重复停用没有重复写日志（op_logs 未增加）", opLogCount() === opBeforeDup, `${opBeforeDup} → ${opLogCount()}`);

/* 重新启用 */
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: qian.id, status: "ACTIVE" })));
check("admin 重新启用放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check("钱阿姨状态真的恢复 ACTIVE", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]).status === "ACTIVE");
const enableLog = opLogs("启用打扫员")[0];
check(
  "启用写 op_logs（action=启用打扫员，detail 含姓名 / INACTIVE → ACTIVE / 操作人）",
  !!enableLog && like(enableLog.detail, "钱阿姨", "INACTIVE → ACTIVE") && enableLog.operator === realNameOf.admin,
  enableLog ? `${enableLog.detail} @ ${enableLog.operator}` : "无日志"
);
check(
  "启用后历史已完成任务数仍不变（停用 / 启用都不动任务记录）",
  doneOf("钱阿姨") === qianDoneBefore,
  `${qianDoneBefore} → ${doneOf("钱阿姨")}`
);

/* 守卫位置补充（行为已由运行时证明） */
for (const fnName of ["addCleanerAction", "setCleanerStatusAction"]) {
  const g = guardOf(cleanersSrc, fnName, "settings.manage");
  check(
    `${fnName} 的 requirePermission("settings.manage") 在第一次写库之前（源码位置补充，行为已由运行时证明）`,
    g.found && g.permAt >= 0 && (Number.isNaN(g.mutateAt) || g.permAt < g.mutateAt),
    JSON.stringify(g)
  );
}
const exportedFns = [...cleanersSrc.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort();
check(
  "actions.ts 的全部导出函数都被本测试覆盖（未来新增写 action 必须补测，否则这里会先红）",
  JSON.stringify(exportedFns) === JSON.stringify(["addCleanerAction", "setCleanerStatusAction"]),
  exportedFns.join(",")
);
check(
  "cleaners/actions.ts 没有残留作权限用的 requireUser() 调用（注释里的说明不算）",
  !/\brequireUser\s*\(/.test(cleanersSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))
);

/* ============================================================ 5. 直调 vs 页面隐藏 + 无物理删除 */

section("5. 直接调用 action 即被拒（页面隐藏按钮不是安全边界）；打扫员不做物理删除");

check(
  "本脚本所有调用都是直接 import actions.ts 后调用函数（无页面渲染、无组件 mock）",
  typeof cleaners.addCleanerAction === "function" && typeof cleaners.setCleanerStatusAction === "function"
);
check(
  "cleaners/page.tsx 用 hasPermission(..., \"settings.manage\") 决定 canManage（页面隐藏入口）",
  /hasPermission\(user\.role,\s*"settings\.manage",\s*hotelId\)/.test(cleanersPageSrc) &&
    /\{canManage \? \(/.test(cleanersPageSrc)
);
check(
  "页面隐藏不等于安全：无权限角色直调两个 action 都拿到 FORBIDDEN（本脚本已实测）",
  isDenied(await as("frontdesk", () => cleaners.addCleanerAction(fd({ name: "直调越权", phone: "13800000000" }))), "settings.manage") &&
    isDenied(await as("frontdesk", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" }))), "settings.manage")
);
check(
  "打扫员模块没有物理删除（清单的「删除留痕」在这里等价于停用留痕）：源码无 DELETE FROM cleaners",
  !/DELETE\s+FROM\s+cleaners/i.test(cleanersSrc)
);
check(
  "停用前检查未完成任务的守卫在源码里（status IN ('PENDING','DOING') + assignee），运行时已被实测拦下",
  /status IN \('PENDING','DOING'\)/.test(cleanersSrc) && /assignee = \?/.test(cleanersSrc)
);

/* ============================================================ 6. 收尾：真库零写入 + 临时清理 + 环境错误 */

section("6. 收尾：真库零写入复查 + 临时文件清理 + 清单 213-222 环境项");

const REAL_AFTER = realDbSnapshot();
check(
  "真库 cleaners / housekeeping / op_logs / sessions / users / hotels 行数全部未变",
  REAL_AFTER.cleaners === REAL_BEFORE.cleaners &&
    REAL_AFTER.housekeeping === REAL_BEFORE.housekeeping &&
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
const leftovers = fs.existsSync(TMP_DIR)
  ? fs.readdirSync(TMP_DIR).filter((n) => n.startsWith(TAG))
  : [];
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
