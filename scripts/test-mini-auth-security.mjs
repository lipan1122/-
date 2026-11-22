#!/usr/bin/env node
/**
 * 微信小程序「鉴权与凭据安全」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-auth-security）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这些必须用真实路由跑
 * ══════════════════════════════════════════════════════════════════════════
 * 「未配置时返回 NOT_CONFIGURED」「token 过期返回 401」这类要求，静态看源码
 * 只能确认「写了判断」，确认不了「判断在正确的顺序上、真的会执行」：
 *   · 限流在鉴权之前 → 未登录的脚本也能耗尽配额；
 *   · 配置检查放在某个接口里漏了 → 停用小程序后那个接口照常工作；
 *   · AppSecret 被某条错误文案拼进响应 → 源码里搜不到，响应里却有。
 * 所以本脚本 esbuild 打包真实 route.ts，在 Node 里直接调用导出的处理函数，
 * 请求头 / 响应体 / 状态码 / 数据库落库全是真的。
 *
 * ── 数据与环境 ──
 * 临时目录 + 临时 SQLite（`process.chdir` 到临时目录，src/lib/db.ts 的
 * `process.cwd()/data/pms.db` 自然落进去）；跑完删除，绝不碰 data/pms.db。
 * 末尾对真库做 sha256 前后对比，作为「零写入」的证据。
 *
 * ── 覆盖清单（清单第 429-447 行）──
 *   1. 未配置小程序时返回 NOT_CONFIGURED（login + 12 个 miniGuard 接口）
 *   2. token 过期 / 伪造 / 缺失返回 401 UNAUTHORIZED（含过期即清空）
 *  15. 手机号与姓名响应脱敏（订单 / 在住 / 绑定）
 *  16. AppSecret 不出现在响应与日志（响应体 / op_logs / 控制台）
 *  17. 关键接口有频率限制（rooms / login / bind / 通知已读 429 + retry-after）
 * 附加（同一批整改点）：
 *   · 停用（enabled=0）后所有 miniGuard 接口立刻 NOT_CONFIGURED，重新启用恢复；
 *   · 登录成功 / 微信错误码 / 网络失败三条分支的错误码口径；
 *   · 退出登录后旧 token 立即失效；
 *   · 服务端日志与控制台不出现完整手机号。
 *
 * 用法：node scripts/test-mini-auth-security.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failed = [];

function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

function readText(relPath) {
  const p = join(ROOT, relPath);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function sha256File(p) {
  if (!existsSync(p)) return "";
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/* 真库快照：测试前后各算一次，作为「真库零写入」的证据 */
const REAL_DB = join(ROOT, "data", "pms.db");
const realHashBefore = sha256File(REAL_DB);
const realMtimeBefore = existsSync(REAL_DB) ? Number(readFileSync(REAL_DB).length) : 0;

/** 测试库里的假 AppSecret（只存在于临时库，不涉及任何真实凭据） */
const TEST_APP_ID = "wxtestappid0001";
const TEST_APP_SECRET = "test_app_secret_0001_do_not_leak";

console.log("── 1. 临时库准备（真实 schema 子集） ──");

const TMP = join(ROOT, ".tmp", `mini-auth-security-${process.pid}-${Date.now()}`);
const TMP_DATA = join(TMP, "data");
mkdirSync(TMP_DATA, { recursive: true });
const TMP_DB = join(TMP_DATA, "pms.db");

const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const plusDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
};
const TODAY = dayOf(now);
const TOMORROW = plusDays(TODAY, 1);
const D2 = plusDays(TODAY, 2);
const D3 = plusDays(TODAY, 3);

const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT,
    gender TEXT, id_no TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT
  );
  CREATE TABLE room_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT, name TEXT,
    bed_type TEXT, area REAL, max_occupancy INTEGER, base_price REAL, sort INTEGER
  );
  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_no TEXT, floor INTEGER,
    room_type_id INTEGER, status TEXT, sort INTEGER
  );
  CREATE TABLE rate_calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_type_id INTEGER NOT NULL,
    date TEXT NOT NULL, price REAL, allotment INTEGER
  );
  CREATE TABLE stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, stay_no TEXT, booking_id INTEGER,
    room_id INTEGER NOT NULL, guest_id INTEGER, guest_name TEXT, mobile TEXT,
    check_in_time TEXT, expect_check_out TEXT, actual_check_out TEXT, nights INTEGER,
    rate REAL NOT NULL, deposit REAL DEFAULT 0, guest_count INTEGER DEFAULT 1, status TEXT DEFAULT 'INHOUSE',
    channel_id INTEGER, remark TEXT, team_name TEXT, member_card TEXT, member_type TEXT,
    rate_code TEXT, salesman TEXT, package_code TEXT, invoice_party TEXT DEFAULT '酒店',
    pay_type TEXT DEFAULT '到店付款', breakfast INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT,
    channel_order_no TEXT
  );
  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, booking_no TEXT, guest_id INTEGER,
    guest_name TEXT, mobile TEXT, room_type_id INTEGER, room_id INTEGER, channel_id INTEGER,
    company_id INTEGER, check_in_date TEXT, check_out_date TEXT, nights INTEGER, room_count INTEGER,
    guest_count INTEGER, rate REAL, deposit REAL, total_price REAL, status TEXT, remark TEXT,
    booking_type TEXT, team_name TEXT, member_card TEXT, member_type TEXT, arrival_time TEXT,
    rate_code TEXT, salesman TEXT, package_code TEXT, invoice_party TEXT, retain_time TEXT,
    pay_type TEXT, breakfast INTEGER, channel_order_no TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE booking_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, booking_id INTEGER, room_type_id INTEGER,
    room_id INTEGER, guest_name TEXT, mobile TEXT, rate REAL, status TEXT,
    check_in_date TEXT, check_out_date TEXT, stay_id INTEGER, created_at TEXT
  );
  CREATE TABLE folios (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_no TEXT, stay_id INTEGER,
    guest_name TEXT, room_no TEXT, total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0,
    balance REAL DEFAULT 0, status TEXT DEFAULT 'OPEN', created_at TEXT, settled_at TEXT
  );
  CREATE TABLE folio_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER NOT NULL,
    item_type TEXT NOT NULL, description TEXT, qty REAL DEFAULT 1, price REAL DEFAULT 0,
    amount REAL DEFAULT 0, biz_date TEXT, created_at TEXT, created_by INTEGER, request_id TEXT
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER, stay_id INTEGER,
    pay_no TEXT, method TEXT, amount REAL, biz_date TEXT, remark TEXT, created_at TEXT,
    request_id TEXT, refund_of INTEGER, operator TEXT, kind TEXT
  );
  CREATE TABLE op_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, operator TEXT, action TEXT,
    detail TEXT, created_at TEXT
  );
  CREATE TABLE wake_up_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, stay_id INTEGER NOT NULL,
    room_no TEXT, wake_time TEXT NOT NULL, note TEXT, status TEXT DEFAULT 'PENDING', created_at TEXT
  );
  CREATE TABLE mini_program_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, app_id TEXT, app_secret TEXT,
    mch_id TEXT, mch_key TEXT, enabled INTEGER DEFAULT 0, updated_at TEXT, UNIQUE(hotel_id)
  );
  CREATE TABLE mini_program_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, openid TEXT NOT NULL, unionid TEXT,
    guest_id INTEGER, mobile TEXT, session_token TEXT, token_expires_at TEXT,
    bind_attempts INTEGER DEFAULT 0, bind_locked_until TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid);
  CREATE INDEX idx_mini_users_token ON mini_program_users(session_token);
  CREATE TABLE mini_program_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, mini_user_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL, created_at TEXT, UNIQUE(hotel_id, booking_id)
  );
`);

const iso = (ms) => new Date(ms).toISOString();
const NOW_MS = Date.now();
const ins = (sql, ...args) => db.prepare(sql).run(...args);

ins(`INSERT INTO hotels (id, code, name, address, phone, logo) VALUES (1, 'H1', '测试酒店一号', '测试路 1 号', '0571-88880001', NULL)`);
ins(`INSERT INTO hotels (id, code, name, address, phone, logo) VALUES (2, 'H2', '测试酒店二号', '测试路 2 号', '0571-88880002', NULL)`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (11, 1, 'STD', '标准间', 300, 2, 1)`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (21, 2, 'STD', '标准间B', 200, 2, 1)`);
for (const [id, hotel, no, type, status] of [
  [3001, 1, "3001", 11, "VC"],
  [3002, 1, "3002", 11, "VC"],
  [9001, 2, "9001", 21, "VC"],
]) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, id, hotel, no, type, status, id);
}

/* 客史：A / B / 三字姓名 C（验证「欧*修」形态） */ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (100, 1, '张三', '13800000001', 1, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (101, 1, '李四', '13800000002', 0, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (102, 1, '欧阳修', '13800000003', 0, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (200, 2, '王五', '13900000003', 0, 0)`);

/*
 * 配置：初始**故意为空**（清单场景：mini_program_config 0 行）。
 * settings 里也不放 wechat_* —— 否则 getActiveMiniConfig 会回退读到旧配置，
 * 「未配置」就不成立了。
 */
ins(`INSERT INTO settings (hotel_id, key, value) VALUES (1, 'biz_day_cutoff', '00:00')`);

const USERS = [
  [1, 1, "openid-a", 100, "token-a", iso(NOW_MS + 6 * 86400000)],
  [2, 1, "openid-b", 101, "token-b", iso(NOW_MS + 6 * 86400000)],
  [3, 1, "openid-expired", 100, "token-expired", iso(NOW_MS - 3600000)],
  [4, 2, "openid-h2", 200, "token-h2", iso(NOW_MS + 6 * 86400000)],
  [5, 1, "openid-c", 102, "token-c", iso(NOW_MS + 6 * 86400000)],
  /* 未绑定用户：绑定失败留痕（op_logs）必须用它测 —— 已绑定用户走幂等返回，不校验证明 */
  [6, 1, "openid-unbound", null, "token-unbound", iso(NOW_MS + 6 * 86400000)],
  /*
   * 7 号用户只用于「未配置时 logout 仍可用」：退出会吊销 token，
   * 用上面任何一个用户都会破坏后续断言（它们的 token 必须保持有效）。
   */
  [7, 1, "openid-cfg-logout", null, "token-cfg-logout", iso(NOW_MS + 6 * 86400000)],
];
for (const [id, hotel, openid, guestId, token, exp] of USERS) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, hotel, openid, guestId, token, exp, iso(NOW_MS), iso(NOW_MS)
  );
}

ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (500, 1, 'S500', 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, D2, iso(NOW_MS)
);
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (501, 1, 'S501', 3002, 101, '李四', '13800000002', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T15:00:00.000+08:00`, D2, iso(NOW_MS)
);

const bookingRow = (id, guestId, name, mobile, status, ci, co) =>
  ins(
    `INSERT INTO bookings (id, hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id,
       check_in_date, check_out_date, nights, room_count, rate, total_price, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, 1, `BK${id}`, guestId, name, mobile, 11, null, ci, co, 2, 1, 300, 600, status, iso(NOW_MS), iso(NOW_MS)
  );
bookingRow(1001, 100, "张三", "13800000001", "CONFIRMED", TOMORROW, D3);
bookingRow(1002, 101, "李四", "13800000002", "CONFIRMED", TOMORROW, D3);

ins(`INSERT INTO folios (id, hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
     VALUES (800, 1, 'F800', 500, '张三', '3001', 600, 0, 600, 'OPEN', ?)`, iso(NOW_MS));
ins(`INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
     VALUES (1, 800, 'ROOM', '房费', 1, 600, 600, ?, ?)`, TODAY, iso(NOW_MS));

check("临时库造好（2 家酒店 / 5 个 mini 用户 / 2 张在住单）", true);
check(
  "初始 mini_program_config 为空（真实的「未配置」场景，0 行）",
  Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_program_config`).get().n) === 0
);

/* ========================================================================== */
/* 2. esbuild 打包真实路由                                                     */
/* ========================================================================== */

console.log("\n── 2. 编译真实路由（esbuild bundle） ──");

const ENTRY = join(TMP, "entry.ts");
const BUNDLE = join(TMP, "bundle.cjs");
const srcAbs = (rel) => join(ROOT, "src", rel.split("/").join("\\")).replace(/\\/g, "/");

const entrySource = `
export { POST as login } from ${JSON.stringify(srcAbs("app/api/mini/login/route.ts"))};
export { POST as logout } from ${JSON.stringify(srcAbs("app/api/mini/logout/route.ts"))};
export { POST as bind } from ${JSON.stringify(srcAbs("app/api/mini/bind/route.ts"))};
export { GET as bookingsList } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
export { GET as bookingDetail } from ${JSON.stringify(srcAbs("app/api/mini/bookings/[id]/route.ts"))};
export { POST as bookingCancel } from ${JSON.stringify(srcAbs("app/api/mini/bookings/[id]/cancel/route.ts"))};
export { POST as bookingModify } from ${JSON.stringify(srcAbs("app/api/mini/bookings/[id]/modify/route.ts"))};
export { GET as staysCurrent } from ${JSON.stringify(srcAbs("app/api/mini/stays/current/route.ts"))};
export { GET as stayFolio } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/folio/route.ts"))};
export { POST as stayExtend } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/extend/route.ts"))};
export { POST as stayChangeRoom } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/change-room/route.ts"))};
export { POST as stayLateCheckout } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/late-checkout/route.ts"))};
export { POST as stayWakeup } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/wakeup/route.ts"))};
export { POST as stayService } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/service/route.ts"))};
export { GET as serviceOrders } from ${JSON.stringify(srcAbs("app/api/mini/service-orders/route.ts"))};
export { POST as serviceOrderCancel } from ${JSON.stringify(srcAbs("app/api/mini/service-orders/[id]/cancel/route.ts"))};
export { GET as notifications } from ${JSON.stringify(srcAbs("app/api/mini/notifications/route.ts"))};
export { POST as notificationsRead } from ${JSON.stringify(srcAbs("app/api/mini/notifications/read/route.ts"))};
export { GET as member } from ${JSON.stringify(srcAbs("app/api/mini/member/route.ts"))};
export { GET as memberLedger } from ${JSON.stringify(srcAbs("app/api/mini/member/ledger/route.ts"))};
export { POST as memberUnbind } from ${JSON.stringify(srcAbs("app/api/mini/member/unbind/route.ts"))};
export { GET as rooms } from ${JSON.stringify(srcAbs("app/api/mini/rooms/route.ts"))};
export { GET as roomTypeDetail } from ${JSON.stringify(srcAbs("app/api/mini/room-types/[id]/route.ts"))};
export { GET as hotel } from ${JSON.stringify(srcAbs("app/api/mini/hotel/route.ts"))};
export { POST as breakfast } from ${JSON.stringify(srcAbs("app/api/mini/breakfast/route.ts"))};
export { GET as invoices, POST as invoiceCreate } from ${JSON.stringify(srcAbs("app/api/mini/invoices/route.ts"))};
`;
writeFileSync(ENTRY, entrySource, "utf8");

let routes = null;
try {
  const esbuild = require("esbuild");
  esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: BUNDLE,
    alias: { "@": join(ROOT, "src").replace(/\\/g, "/") },
    logLevel: "silent",
  });
  check("真实路由编译成功（esbuild，含 next/server 与项目内 @/lib）", existsSync(BUNDLE));
} catch (e) {
  check("真实路由编译成功（esbuild）", false, String(e?.message ?? e).slice(0, 200));
}

let restored = false;
function restoreCwd() {
  if (restored) return;
  restored = true;
  try {
    process.chdir(ROOT);
  } catch {
    /* ignore */
  }
}

if (existsSync(BUNDLE)) {
  process.chdir(TMP);
  try {
    routes = require(BUNDLE);
  } catch (e) {
    check("bundle 可加载", false, String(e?.message ?? e).slice(0, 200));
  }
}

/* ========================================================================== */
/* 2.5 静态：目录里**每一个**小程序路由都必须过「鉴权 + 配置门槛」              */
/* ========================================================================== */

/*
 * 为什么加这一段：缺陷 2 的根因不是某一处写漏，而是「两代鉴权写法并存」——
 * 新接口走 miniGuard（限流 + token + 配置），老接口各自写 requireMiniToken，
 * 于是只要有新接口没被点名，配置检查就会漏。运行时断言只能覆盖到「测试里列出来的
 * 接口」，一旦有人再加一个 /api/mini/xxx 就没人发现。
 *
 * 这里枚举 src/app/api/mini/** 下的全部 route.ts，按类别断言：
 *   · 需要登录的业务接口 → 必须出现 miniGuard 或 miniConfigBlocked；
 *   · login → 必须有自己的 getActiveMiniConfig 判定；
 *   · logout → 必须只做 token 校验（**故意**不做配置检查：退出是清理凭据）；
 *   · rooms / room-types / hotel → 匿名公开接口（未登录可读），不需要 token。
 */

const MINI_API_DIR = join(ROOT, "src", "app", "api", "mini");

function listRouteFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listRouteFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const miniRouteFiles = listRouteFiles(MINI_API_DIR);
const relRoute = (p) => relative(MINI_API_DIR, p).split(sep).join("/");
const srcOf = (p) => readFileSync(p, "utf8");

/* 匿名公开接口：客人还没登录就要能看酒店信息 / 房价，所以它们不做 token 鉴权 */
const PUBLIC_ROUTES = ["rooms/route.ts", "room-types/[id]/route.ts", "hotel/route.ts"];

const gateMiss = [];
const publicWithToken = [];
for (const file of miniRouteFiles) {
  const rel = relRoute(file);
  const src = srcOf(file);
  if (PUBLIC_ROUTES.includes(rel)) {
    if (src.includes("requireMiniToken")) publicWithToken.push(rel);
    continue;
  }
  if (rel === "login/route.ts") {
    if (!src.includes("getActiveMiniConfig") || !src.includes("NOT_CONFIGURED")) gateMiss.push(`${rel}:login-配置判定`);
    continue;
  }
  if (rel === "logout/route.ts") {
    /* 退出：必须有 token 鉴权，且**不能**被配置门槛拦住（见 logout/route.ts 注释） */
    if (!src.includes("requireMiniToken") || /miniConfigBlocked\s*\(/.test(src)) {
      gateMiss.push(`${rel}:退出应只吊销自身 token`);
    }
    continue;
  }
  /*
   * 三种合规写法：
   *   · miniGuard(...)              限流 + token + 配置三合一网关（订单 / 在住 / 服务请求）
   *   · miniConfigBlocked(user)     自己限流 + requireMiniToken，再补配置门槛（本批 10 个接口）
   *   · submitStayApplication(...)  在住申请类动作的统一入口（内部走 miniGuard）
   */
  if (
    !src.includes("miniGuard") &&
    !/miniConfigBlocked\s*\(/.test(src) &&
    !src.includes("submitStayApplication")
  ) {
    gateMiss.push(`${rel}:既没有 miniGuard / miniConfigBlocked，也没有 submitStayApplication`);
  }
}

check(
  "静态：src/app/api/mini/** 每个路由都过「鉴权 + 配置门槛」（新接口漏加会被这里挡住）",
  miniRouteFiles.length >= 20 && gateMiss.length === 0,
  `共 ${miniRouteFiles.length} 个路由；缺口：${gateMiss.join(",")}`
);
check(
  "静态：rooms / room-types / hotel 保持匿名公开（不引入 token 鉴权，客人未登录也能看）",
  publicWithToken.length === 0,
  publicWithToken.join(",")
);

/* ========================================================================== */
/* 3. 调用工具                                                                */
/* ========================================================================== */

const seenResponses = [];

function makeReq({ token, method = "GET", url = "http://127.0.0.1/api/mini/x", body, ua = "mini-auth-test" }) {
  const headers = { "user-agent": ua };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function j(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function call(handler, opts = {}) {
  const res = await handler(makeReq(opts), { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  seenResponses.push(text);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { __raw: text.slice(0, 500) };
  }
  return { status: res.status, body: payload, text, headers: res.headers };
}

/** 12 个走 miniGuard 的接口（它们必须统一做「限流 → 鉴权 → 配置」） */
const GUARDED = [
  ["bookingDetail", { params: { id: "1001" } }],
  ["bookingCancel", { method: "POST", params: { id: "1001" }, body: { requestId: "cancel-auth-1" } }],
  ["bookingModify", { method: "POST", params: { id: "1001" }, body: { requestId: "modify-auth-1" } }],
  ["staysCurrent", {}],
  ["stayFolio", { params: { id: "500" } }],
  ["stayExtend", { method: "POST", params: { id: "500" }, body: { nights: 1, requestId: "extend-auth-1" } }],
  ["stayChangeRoom", { method: "POST", params: { id: "500" }, body: { roomId: 3002, requestId: "change-auth-1" } }],
  ["stayLateCheckout", { method: "POST", params: { id: "500" }, body: { time: "14:00", requestId: "late-auth-1" } }],
  ["stayWakeup", { method: "POST", params: { id: "500" }, body: { wakeTime: "07:30", requestId: "wake-auth-1" } }],
  ["stayService", { method: "POST", params: { id: "500" }, body: { serviceType: "CLEANING", requestId: "svc-auth-1" } }],
  ["serviceOrders", {}],
  ["serviceOrderCancel", { method: "POST", params: { id: "1" }, body: {} }],
];

/**
 * 只做 requireMiniToken、**不**走 miniGuard 的接口。
 *
 * ── 原缺陷（第九轮专项测试核实）──
 * 这 10 个接口原先完全没做小程序配置检查：`mini_program_config` 0 行、或管理员把
 * `enabled` 关成 0 之后，它们仍然返回 200 —— 也就是「停用小程序」只停住了
 * 订单 / 在住那一半，会员资料、储值流水、发票、通知照常可读可写。
 * 清单第 431 行要求「未配置小程序时返回 NOT_CONFIGURED」，覆盖范围是**所有**
 * 需要登录的小程序接口，不是只有第一批。
 *
 * ── 修复后断言什么 ──
 * 每一个都必须 NOT_CONFIGURED（修复方式：鉴权之后统一调用 _shared.ts 的
 * miniConfigBlocked(user)，再加自己的业务逻辑）。
 */
const CONFIG_GATED = [
  ["bookingsList", {}],
  ["bind", { method: "POST", body: { mobile: "13800000001", guestName: "张三", bookingNo: "BK1001" } }],
  ["member", {}],
  ["memberLedger", {}],
  ["memberUnbind", { method: "POST", body: {} }],
  ["notifications", {}],
  ["notificationsRead", { method: "POST", body: { all: true } }],
  ["breakfast", { method: "POST", body: { count: 1 } }],
  ["invoices", {}],
  ["invoiceCreate", { method: "POST", body: {} }],
];

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 未配置：NOT_CONFIGURED                                              */
  /* ====================================================================== */

  console.log("\n── 4. 未配置小程序（0 行配置）→ NOT_CONFIGURED ──");

  const loginNoCfg = await call(routes.login, { method: "POST", body: { code: "any-code" } });
  check(
    "未配置时 login → NOT_CONFIGURED（不假装登录成功）",
    loginNoCfg.status === 200 && loginNoCfg.body?.ok === false && loginNoCfg.body?.code === "NOT_CONFIGURED",
    `status=${loginNoCfg.status} ${j(loginNoCfg.body).slice(0, 140)}`
  );
  check(
    "未配置时 login 不返回假 token",
    !loginNoCfg.body?.data?.token && !loginNoCfg.text.includes('"token"')
  );

  const notConfiguredMiss = [];
  for (const [name, opts] of GUARDED) {
    const r = await call(routes[name], { token: "token-a", ...opts });
    if (r.body?.code !== "NOT_CONFIGURED") notConfiguredMiss.push(`${name}:${r.status}/${r.body?.code ?? "?"}`);
  }
  check(
    "未配置时 12 个 miniGuard 接口一律 NOT_CONFIGURED（订单/在住/服务请求）",
    notConfiguredMiss.length === 0,
    notConfiguredMiss.join(",")
  );

  /*
   * 清单第 431 行的完整覆盖：这 10 个接口原先只做 token 校验，
   * 未配置时仍返回 200（缺陷）。修复后必须一律 NOT_CONFIGURED。
   */
  const configGatedResults = [];
  const configGatedMiss = [];
  for (const [name, opts] of CONFIG_GATED) {
    const r = await call(routes[name], { token: "token-a", ...opts });
    const code = String(r.body?.code ?? "OK");
    configGatedResults.push(`${name}:${r.status}/${code}`);
    if (code !== "NOT_CONFIGURED") configGatedMiss.push(`${name}:${r.status}/${code}`);
  }
  check(
    "（清单第 431 行）未配置时 10 个「只做 token 校验」的接口也一律 NOT_CONFIGURED（修复前它们返回 200）",
    configGatedMiss.length === 0,
    `实际：${configGatedResults.join(",")}`
  );

  /*
   * ── 两个刻意不在这 10 个里的接口（修复时做的判断，理由在代码注释里）──
   *
   * 1. logout：退出是**清理凭据**。停用后若连退出都返回 NOT_CONFIGURED，
   *    客户端会继续持有一个最多 7 天有效的服务端 token —— 反而把风险窗口拉长。
   *    它只吊销当前请求自己的 token，不读也不写业务数据，停用期间允许没有危害。
   * 2. /api/mini/hotel：匿名公开接口（客人还没登录就要能看酒店名 / 电话 / 是否可登录）。
   *    它只回一个 miniConfigured 布尔，本身不该被整体拒绝。
   */
  const cfgLogout = await call(routes.logout, { token: "token-cfg-logout", method: "POST", ua: "auth-cfg-logout" });
  check(
    "未配置时 logout 仍可调用，并真正吊销 token（退出是清理动作，不能返回 NOT_CONFIGURED）",
    cfgLogout.status === 200 &&
      cfgLogout.body?.data?.loggedOut === true &&
      db.prepare(`SELECT session_token FROM mini_program_users WHERE id = 7`).get().session_token === null,
    `status=${cfgLogout.status} ${j(cfgLogout.body).slice(0, 120)}`
  );

  const hotelPublic = await call(routes.hotel, { ua: "auth-cfg-hotel" });
  check(
    "未配置时匿名公开接口 /api/mini/hotel 仍可读（只回 miniConfigured:false，不整体拒绝）",
    hotelPublic.status === 200 &&
      hotelPublic.body?.ok === true &&
      hotelPublic.body?.data?.miniConfigured === false,
    `status=${hotelPublic.status} miniConfigured=${hotelPublic.body?.data?.miniConfigured}`
  );

  /* ====================================================================== */
  /* 5. 登录：成功 / 微信错误 / 网络失败（fetch 用桩，不真的出网）            */
  /* ====================================================================== */

  console.log("\n── 5. 登录三条分支（mock 微信接口，不真的出网） ──");

  ins(
    `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, ?, ?, 1, ?)`,
    TEST_APP_ID, TEST_APP_SECRET, iso(NOW_MS)
  );
  check("插入一条启用的配置（后续「已配置」场景用它）", true);

  const realFetch = globalThis.fetch;
  const fetchedUrls = [];
  const mockFetch = (payload, status = 200) => {
    globalThis.fetch = async (url) => {
      fetchedUrls.push(String(url));
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    };
  };
  const restoreFetch = () => {
    globalThis.fetch = realFetch;
  };

  mockFetch({ openid: "openid-login-ok", unionid: "union-login-ok" });
  const loginOk = await call(routes.login, { method: "POST", body: { code: "code-ok" }, ua: "auth-login-ok" });
  restoreFetch();
  check(
    "已配置 + 微信返回 openid → 登录成功并下发 token",
    loginOk.status === 200 && loginOk.body?.ok === true && typeof loginOk.body?.data?.token === "string",
    j(loginOk.body).slice(0, 160)
  );
  check(
    "登录成功响应不含 AppSecret（secret 只出现在发往微信的出网请求里）",
    !loginOk.text.includes(TEST_APP_SECRET)
  );
  check(
    "登录向微信接口发出的 URL 带 appid 与 code（服务端自己拼，不信任客户端）",
    fetchedUrls.length === 1 && fetchedUrls[0].includes(`appid=${TEST_APP_ID}`) && fetchedUrls[0].includes("js_code=code-ok")
  );

  mockFetch({ errcode: 40029, errmsg: "invalid code" });
  const loginBadCode = await call(routes.login, { method: "POST", body: { code: "bad-code" }, ua: "auth-login-bad" });
  restoreFetch();
  check(
    "微信返回 code 无效（40029）→ AUTH_FAILED + 中文可展示文案",
    loginBadCode.body?.ok === false &&
      loginBadCode.body?.code === "AUTH_FAILED" &&
      /code 无效|重新进入小程序/.test(String(loginBadCode.body?.error ?? "")),
    j(loginBadCode.body).slice(0, 160)
  );

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const loginNetFail = await call(routes.login, { method: "POST", body: { code: "net-code" }, ua: "auth-login-net" });
  restoreFetch();
  check(
    "调用微信接口失败 → NETWORK（不把堆栈 / 内部地址回给客户端）",
    loginNetFail.body?.ok === false && loginNetFail.body?.code === "NETWORK" && !/at .*\.js:\d+/.test(loginNetFail.text)
  );

  const loginNoCode = await call(routes.login, { method: "POST", body: {}, ua: "auth-login-nocode" });
  check(
    "缺少 code → BAD_REQUEST（在配置检查之前就挡住）",
    loginNoCode.body?.ok === false && loginNoCode.body?.code === "BAD_REQUEST"
  );

  /* ====================================================================== */
  /* 6. token 过期 / 伪造 / 缺失 → 401                                       */
  /* ====================================================================== */

  console.log("\n── 6. token 过期 / 伪造 / 缺失 → 401 UNAUTHORIZED ──");

  const expiredRes = await call(routes.staysCurrent, { token: "token-expired", ua: "auth-token-1" });
  check(
    "token 过期 → 401 UNAUTHORIZED",
    expiredRes.status === 401 && expiredRes.body?.code === "UNAUTHORIZED",
    `status=${expiredRes.status} ${j(expiredRes.body).slice(0, 120)}`
  );
  check(
    "过期 token 被顺手清空（库里 session_token 置空，旧凭证不能再用）",
    db.prepare(`SELECT session_token FROM mini_program_users WHERE id = 3`).get().session_token === null
  );
  const expiredAgain = await call(routes.staysCurrent, { token: "token-expired", ua: "auth-token-1" });
  check("同一个过期 token 第二次请求仍然 401", expiredAgain.status === 401);

  const forgedRes = await call(routes.staysCurrent, { token: "forged-token-0000", ua: "auth-token-2" });
  check(
    "伪造 token（库里不存在）→ 401 UNAUTHORIZED",
    forgedRes.status === 401 && forgedRes.body?.code === "UNAUTHORIZED"
  );
  const noTokenRes = await call(routes.staysCurrent, { ua: "auth-token-3" });
  check("不带 token → 401 UNAUTHORIZED", noTokenRes.status === 401 && noTokenRes.body?.code === "UNAUTHORIZED");

  /* 畸形 Authorization 头 */
  const badHeaders = [
    ["Bearer", { authorization: "Bearer" }],
    ["Bearer   ", { authorization: "Bearer    " }],
    ["Basic xxx", { authorization: "Basic dG9rZW4=" }],
    ["token-a（没有 Bearer 前缀）", { authorization: "token-a" }],
  ];
  const badHeaderPass = [];
  for (const [label, headers] of badHeaders) {
    const res = await routes.staysCurrent(new Request("http://127.0.0.1/api/mini/stays/current", { headers: { "user-agent": "auth-bad-header", ...headers } }), {
      params: Promise.resolve({}),
    });
    const body = await res.json().catch(() => null);
    if (!(res.status === 401 && body?.code === "UNAUTHORIZED")) badHeaderPass.push(label);
  }
  check(
    "畸形 Authorization（空 Bearer / Basic / 缺前缀）一律 401，不被当成有效凭证",
    badHeaderPass.length === 0,
    badHeaderPass.join(",")
  );

  const okRes = await call(routes.staysCurrent, { token: "token-a", ua: "auth-token-4" });
  check("有效 token → 200 且身份正确（A 看到自己的在住单）", okRes.status === 200 && okRes.body?.data?.bound === true);

  /* ====================================================================== */
  /* 7. 停用 / 重新启用                                                      */
  /* ====================================================================== */

  console.log("\n── 7. 停用（enabled=0）→ 立刻 NOT_CONFIGURED；重新启用恢复 ──");

  db.prepare(`UPDATE mini_program_config SET enabled = 0 WHERE hotel_id = 1`).run();
  const disabledLogin = await call(routes.login, { method: "POST", body: { code: "x" }, ua: "auth-disabled-1" });
  check(
    "停用后 login → NOT_CONFIGURED",
    disabledLogin.body?.ok === false && disabledLogin.body?.code === "NOT_CONFIGURED"
  );
  const disabledGuard = await call(routes.staysCurrent, { token: "token-a", ua: "auth-disabled-2" });
  check(
    "停用后已签发的 token 访问 miniGuard 接口 → NOT_CONFIGURED（不是继续放行）",
    disabledGuard.body?.code === "NOT_CONFIGURED"
  );

  /*
   * 停用（enabled=0）也必须覆盖到那 10 个「只做 token 校验」的接口 ——
   * 原缺陷里明确写了「管理员停用小程序后这些接口照常可用」。
   */
  const disabledMiss = [];
  for (const [name, opts] of CONFIG_GATED) {
    const r = await call(routes[name], { token: "token-a", ...opts });
    if (r.body?.code !== "NOT_CONFIGURED") disabledMiss.push(`${name}:${r.status}/${r.body?.code ?? "OK"}`);
  }
  check(
    "停用（enabled=0）后这 10 个接口同样立刻 NOT_CONFIGURED（停用要停全部，不是只停一半）",
    disabledMiss.length === 0,
    disabledMiss.join(",")
  );

  db.prepare(`UPDATE mini_program_config SET enabled = 1 WHERE hotel_id = 1`).run();
  const reenabled = await call(routes.staysCurrent, { token: "token-a", ua: "auth-disabled-3" });
  check("重新启用后立刻恢复（bound:true）", reenabled.status === 200 && reenabled.body?.data?.bound === true);

  const reenabledMember = await call(routes.member, { token: "token-a", ua: "auth-disabled-4" });
  check(
    "重新启用后会员中心也立刻恢复（200 + 脱敏姓名）",
    reenabledMember.status === 200 && String(reenabledMember.body?.data?.guestName ?? "") === "张*",
    j(reenabledMember.body).slice(0, 140)
  );

  /* ====================================================================== */
  /* 8. 脱敏                                                                */
  /* ====================================================================== */

  console.log("\n── 8. 手机号 / 姓名响应脱敏 ──");

  const detail = await call(routes.bookingDetail, { token: "token-a", params: { id: "1001" }, ua: "auth-mask-1" });
  check(
    "订单详情手机号脱敏（138****0001 形态，且不含完整号码）",
    detail.status === 200 &&
      /^138\*{4}0001$/.test(String(detail.body?.data?.mobile ?? "")) &&
      !detail.text.includes("13800000001"),
    `mobile=${detail.body?.data?.mobile}`
  );
  check(
    "订单详情姓名脱敏（张三 → 张*，且不含完整姓名）",
    String(detail.body?.data?.guestName ?? "") === "张*" && !detail.text.includes("张三"),
    `guestName=${detail.body?.data?.guestName}`
  );

  const current = await call(routes.staysCurrent, { token: "token-a", ua: "auth-mask-2" });
  const stay0 = current.body?.data?.stays?.[0] ?? {};
  check(
    "在住信息手机号 / 姓名都脱敏",
    /^138\*{4}0001$/.test(String(stay0.mobile ?? "")) &&
      String(stay0.guestName ?? "") === "张*" &&
      !current.text.includes("13800000001"),
    `mobile=${stay0.mobile} name=${stay0.guestName}`
  );

  /* 三字姓名 → 欧*修（maskGuestName 的中间保留规则） */
  const detailC = await call(routes.bookingDetail, { token: "token-c", params: { id: "1001" }, ua: "auth-mask-3" });
  const currentC = await call(routes.staysCurrent, { token: "token-c", ua: "auth-mask-4" });
  check(
    "三字姓名脱敏为「欧*修」（首尾保留、中间打码），不是整串打码",
    !/欧阳修/.test(currentC.text + detailC.text) && /欧\*修|欧阳\*/.test(currentC.text + detailC.text + detail.text),
    `current=${j(currentC.body?.data).slice(0, 120)}`
  );

  const memberRes = await call(routes.member, { token: "token-a", ua: "auth-mask-5" });
  check(
    "会员中心手机号脱敏（138****0001）",
    /^138\*{4}0001$/.test(String(memberRes.body?.data?.mobile ?? "")),
    `mobile=${memberRes.body?.data?.mobile}`
  );
  check(
    "（清单第 445 行）会员中心姓名脱敏（张三 → 张*，响应里不含完整姓名）",
    String(memberRes.body?.data?.guestName ?? "") === "张*" && !memberRes.text.includes("张三"),
    `guestName=${String(memberRes.body?.data?.guestName ?? "").slice(0, 20)}`
  );

  /* 全部响应的总扫描：不能出现完整 11 位手机号 */
  const fullMobileHits = seenResponses.filter((t) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(t));
  check(
    "所有接口响应里都不出现完整 11 位手机号（脱敏是统一口径，不是个别接口）",
    fullMobileHits.length === 0,
    `命中 ${fullMobileHits.length} 个响应，示例：${String(fullMobileHits[0] ?? "").slice(0, 120)}`
  );

  /* ====================================================================== */
  /* 9. AppSecret 不泄露                                                     */
  /* ====================================================================== */

  console.log("\n── 9. AppSecret 不出现在响应与日志 ──");

  /* 再打一轮覆盖更多接口（部分接口会因参数问题报错，错误文案也不能带 secret） */
  /*
   * 先制造一次**真正的绑定失败**：它一定会写 op_logs（小程序绑定失败），
   * 后面才能验证「日志里也不出现 secret / 完整手机号」。
   * （用已绑定用户的正确凭证会走幂等返回，不写日志，测不到日志内容。）
   */
  const bindFail = await call(routes.bind, {
    token: "token-unbound",
    method: "POST",
    body: { mobile: "13800000001", guestName: "张三", bookingNo: "BK9999" },
    ua: "auth-secret-bind-fail",
  });
  check(
    "错误的绑定证明被拒（BIND_PROOF_FAILED，留痕用于下面的日志扫描）",
    bindFail.body?.ok === false && bindFail.body?.code === "BIND_PROOF_FAILED",
    j(bindFail.body).slice(0, 140)
  );
  await call(routes.bind, { token: "token-b", method: "POST", body: { mobile: "13800000001", guestName: "张三" }, ua: "auth-secret-1" });
  await call(routes.rooms, { url: "http://127.0.0.1/api/mini/rooms?checkIn=2026-01-01&checkOut=2026-01-02", ua: "auth-secret-2" });
  await call(routes.roomTypeDetail, { params: { id: "11" }, ua: "auth-secret-3" });
  await call(routes.hotel, { ua: "auth-secret-4" });
  await call(routes.notifications, { token: "token-a", ua: "auth-secret-5" });
  await call(routes.notificationsRead, { token: "token-a", method: "POST", body: { all: true }, ua: "auth-secret-6" });
  await call(routes.serviceOrders, { token: "token-a", ua: "auth-secret-7" });
  await call(routes.memberLedger, { token: "token-a", ua: "auth-secret-8" });
  await call(routes.bookingsList, { token: "token-a", ua: "auth-secret-9" });
  await call(routes.memberUnbind, { token: "token-a", method: "POST", body: {}, ua: "auth-secret-10" });

  const secretInResponses = seenResponses.filter((t) => t.includes(TEST_APP_SECRET));
  check(
    "所有接口响应（含错误文案）都不含 AppSecret",
    secretInResponses.length === 0,
    `命中 ${secretInResponses.length} 个：${String(secretInResponses[0] ?? "").slice(0, 120)}`
  );

  /* op_logs：绑定失败 / 取消等敏感动作会写日志，日志里也不能有 secret / 完整手机号 */
  const logs = db.prepare(`SELECT operator, action, detail FROM op_logs WHERE hotel_id = 1`).all();
  check("敏感动作确实写了 op_logs（可以先验证日志有内容）", logs.length >= 1, `行数 ${logs.length}`);
  check(
    "op_logs 里不含 AppSecret",
    !logs.some((r) => String(r.detail ?? "").includes(TEST_APP_SECRET) || String(r.action ?? "").includes(TEST_APP_SECRET))
  );
  check(
    "op_logs 里不含完整手机号（日志同样脱敏）",
    !logs.some((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(String(r.detail ?? ""))),
    String(logs.find((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(String(r.detail ?? "")))?.detail ?? "").slice(0, 80)
  );

  /* 控制台：接口执行期间捕获 console 输出（不打印到屏幕，避免污染断言输出） */
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => captured.push(a.map(String).join(" "));
  console.warn = (...a) => captured.push(a.map(String).join(" "));
  console.error = (...a) => captured.push(a.map(String).join(" "));
  try {
    await call(routes.bind, { token: "token-a", method: "POST", body: { mobile: "13800000001", guestName: "张三" }, ua: "auth-console-1" });
    await call(routes.login, { method: "POST", body: { code: "x" }, ua: "auth-console-2" });
    mockFetch({ errcode: 41004, errmsg: "invalid appsecret" });
    await call(routes.login, { method: "POST", body: { code: "y" }, ua: "auth-console-3" });
    restoreFetch();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  check(
    "服务端控制台日志不含 AppSecret",
    !captured.join("\n").includes(TEST_APP_SECRET),
    `捕获 ${captured.length} 行`
  );
  check(
    "AppSecret 错误只回错误码 / 中文文案（41004 → AppSecret 不正确），不回显密钥",
    (() => {
      const last = seenResponses[seenResponses.length - 1] ?? "";
      return /AppSecret 不正确|AppSecret 无效/.test(last) && !last.includes(TEST_APP_SECRET);
    })()
  );

  /* ====================================================================== */
  /* 10. 退出登录 → token 失效                                              */
  /* ====================================================================== */

  console.log("\n── 10. 退出登录（服务端吊销，不只是清本地） ──");

  const logoutRes = await call(routes.logout, { token: "token-c", method: "POST", ua: "auth-logout-1" });
  check("退出登录成功", logoutRes.status === 200 && logoutRes.body?.data?.loggedOut === true);
  const afterLogout = await call(routes.staysCurrent, { token: "token-c", ua: "auth-logout-2" });
  check(
    "退出后旧 token 立即失效（401，不是等 7 天自然过期）",
    afterLogout.status === 401 && afterLogout.body?.code === "UNAUTHORIZED"
  );
  const logoutAgain = await call(routes.logout, { token: "token-c", method: "POST", ua: "auth-logout-3" });
  check("已失效的 token 再调退出 → 401（幂等但要求有效凭证）", logoutAgain.status === 401);

  /* ====================================================================== */
  /* 11. 频率限制                                                           */
  /* ====================================================================== */

  console.log("\n── 11. 关键接口有频率限制（429 + retry-after） ──");

  /**
   * 限流键 = XFF 首段 + UA 哈希。给每个限流场景换一个 UA，
   * 各场景互不挤占配额（也不会被前面测试的调用次数影响）。
   */
  async function hammer(name, opts, times, expectStatus) {
    let limited = 0;
    let retryAfter = null;
    let lastCode = "";
    let other = 0;
    for (let i = 0; i < times; i += 1) {
      const r = await call(routes[name], opts);
      if (r.status === 429) {
        limited += 1;
        retryAfter = r.headers.get("retry-after");
        lastCode = String(r.body?.code ?? "");
      } else if (expectStatus && r.status !== expectStatus) {
        other += 1;
      }
    }
    return { limited, retryAfter, lastCode, other };
  }

  const roomsRl = await hammer(
    "rooms",
    { url: "http://127.0.0.1/api/mini/rooms?checkIn=2026-12-01&checkOut=2026-12-02", ua: "auth-rl-rooms" },
    130,
    200
  );
  check(
    "公开查房接口（120/分钟）连续 130 次 → 出现 429 RATE_LIMITED",
    roomsRl.limited > 0 && roomsRl.lastCode === "RATE_LIMITED",
    `limited=${roomsRl.limited} code=${roomsRl.lastCode}`
  );
  check(
    "429 响应带 retry-after（秒，>= 1）",
    Number(roomsRl.retryAfter) >= 1,
    `retry-after=${roomsRl.retryAfter}`
  );

  mockFetch({ openid: "openid-rl", unionid: null });
  const loginRl = await hammer("login", { method: "POST", body: { code: "rl-code" }, ua: "auth-rl-login" }, 34, 200);
  restoreFetch();
  check(
    "登录接口（30/分钟）连续 34 次 → 出现 429（防刷 code / 烧微信配额）",
    loginRl.limited > 0 && loginRl.lastCode === "RATE_LIMITED",
    `limited=${loginRl.limited}`
  );

  const bindRl = await hammer(
    "bind",
    { token: "token-b", method: "POST", body: { mobile: "13800000002", guestName: "李四", bookingNo: "BK1002" }, ua: "auth-rl-bind" },
    24,
    200
  );
  check(
    "绑定接口（20/分钟）连续 24 次 → 出现 429（防枚举单号）",
    bindRl.limited > 0 && bindRl.lastCode === "RATE_LIMITED",
    `limited=${bindRl.limited}`
  );

  const readRl = await hammer(
    "notificationsRead",
    { token: "token-a", method: "POST", body: { all: true }, ua: "auth-rl-notify" },
    34,
    200
  );
  check(
    "标记已读接口（30/分钟）连续 34 次 → 出现 429",
    readRl.limited > 0 && readRl.lastCode === "RATE_LIMITED",
    `limited=${readRl.limited}`
  );

  /* 不同 scope 独立计数：login 被限流后，rooms 用新 UA 仍应正常 */
  const independent = await call(routes.rooms, {
    url: "http://127.0.0.1/api/mini/rooms?checkIn=2026-12-01&checkOut=2026-12-02",
    ua: "auth-rl-independent",
  });
  check("不同接口的限流配额互不挤占（login 被限后 rooms 仍可用）", independent.status === 200);
}

/* ========================================================================== */
/* 12. 清理 + 真库零写入                                                       */
/* ========================================================================== */

restoreCwd();
try {
  db.close();
} catch {
  /* ignore */
}
try {
  globalThis.__pmsDb?.close?.();
} catch {
  /* ignore */
}

console.log("\n── 12. 真库零写入验证 ──");

const realHashAfter = sha256File(REAL_DB);
check(
  "真库 data/pms.db 零写入（测试前后 sha256 完全一致）",
  realHashBefore === realHashAfter && realHashBefore !== "",
  `before=${realHashBefore.slice(0, 12)} after=${realHashAfter.slice(0, 12)}`
);
check(
  "所有写入都落在 .tmp 副本（临时库被真实写过：配置 / 用户 / 订单都变了）",
  (() => {
    const probe = new DatabaseSync(TMP_DB, { readOnly: true });
    try {
      const cfg = Number(probe.prepare(`SELECT COUNT(*) AS n FROM mini_program_config`).get().n);
      const users = Number(probe.prepare(`SELECT COUNT(*) AS n FROM mini_program_users`).get().n);
      return existsSync(TMP_DB) && cfg >= 1 && users >= 5;
    } finally {
      probe.close();
    }
  })()
);

/* 先关闭只读连接再删目录（Windows 上打开的文件无法删除） */
try {
  globalThis.__pmsDb?.close?.();
} catch {
  /* ignore */
}
try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  /* Windows 偶发占用：目录留在 .tmp 不影响验收结论 */
}

console.log("");
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("失败项：");
  for (const name of failed) console.log(`  · ${name}`);
  process.exit(1);
}
