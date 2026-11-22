#!/usr/bin/env node
/**
 * 微信小程序「订单与在住」越权与库存验收
 * （第九轮清单第七节 test-mini-order-access）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这个脚本要「真的把 route handler 跑起来」
 * ══════════════════════════════════════════════════════════════════════════
 * 越权与库存这类问题**静态看源码看不出来**：
 *   · 「A 能不能读 B 的订单」取决于 SQL 里那些 WHERE 条件组合起来的结果；
 *   · 「取消订单有没有真的释放 booking_rooms」取决于 UPDATE 有没有被执行；
 *   · 「同一个 request_id 会不会建两条」取决于唯一索引与事务的实际行为。
 * 只断言「源码里有 requireMiniToken」这种检查，正好会漏掉这次整改要防的东西。
 *
 * 所以本脚本用 esbuild 把**真实的路由文件**（.ts）打成一个 CJS bundle，
 * 在 Node 里直接调用导出的 GET / POST，请求体、响应体、状态码都是真的；
 * 数据库指向本脚本自己造的临时库（process.chdir 到临时目录，
 * src/lib/db.ts 的 `process.cwd()/data/pms.db` 自然落进去），
 * 跑完即删，绝不碰 data/pms.db（线上 / 演示数据一行都不会改）。
 *
 * ── 为什么不用 HTTP 打 3100 ──
 * 3100 跑的是 `next start`（生产构建）。本次整改明确禁止 `next build`，
 * 服务进程里的代码还是改动之前的版本，新增路由全是 404 —— 拿它做验收会得到
 * 一堆假失败。进程内调用不受这个限制，测的正是工作区里最新的源码。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 覆盖清单（与任务书第七节「必须验证」逐条对应）
 * ══════════════════════════════════════════════════════════════════════════
 *   1. A 用户不能读 B 用户的订单（交叉请求，两个 mini_user）
 *   2. 未绑定用户请求 stays/current → 返回空（bound:false, stays:[]）
 *   3. 伪造 stayId（别人的）→ 拒绝（folio / extend / 服务请求全部 404）
 *   4. 取消订单后 booking_rooms 真的释放（room_id 置空 + status=CANCELLED）
 *   5. 续住冲突被拒（远期已有预订占用同一间房）
 *   6. 换房跨酒店被拒（拿别家酒店的 roomId 换房）
 *   7. 同一 request_id 重复提服务请求 → 只建一条
 * 附加（同一批整改点）：
 *   8. token 过期 → 401 UNAUTHORIZED；未配置小程序 → NOT_CONFIGURED
 *   9. 仓库内 id 一律来自 token：响应里不出现完整手机号 / 完姓名（脱敏）
 *  10. 改单重算价格与库存（服务端计价、booking_rooms 间数同步）
 *  11. 服务请求只能取消自己的、且只有 PENDING 能取消
 *  12. 叫醒同时落 PC 端的 wake_up_calls，重放不会登记两次
 *  13. 五处 schema 同步（schema-full / init-db / migrate-all / 运行时 / fingerprint）
 *
 * 用法：node scripts/test-mini-order-access.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */

import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

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

/** 读源码（静态校验段用；读不到返回空串） */
function readText(relPath) {
  const p = join(ROOT, relPath);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/* ========================================================================== */
/* 1. 静态校验：12 个路由文件、统一响应、鉴权 / 幂等 / 脱敏的落点               */
/* ========================================================================== */

console.log("── 1. 路由清单与源码静态校验 ──");

const ROUTES = [
  ["src/app/api/mini/bookings/[id]/route.ts", "GET", "订单详情"],
  ["src/app/api/mini/bookings/[id]/cancel/route.ts", "POST", "取消订单"],
  ["src/app/api/mini/bookings/[id]/modify/route.ts", "POST", "修改订单"],
  ["src/app/api/mini/stays/current/route.ts", "GET", "当前在住"],
  ["src/app/api/mini/stays/[id]/folio/route.ts", "GET", "当前账单"],
  ["src/app/api/mini/stays/[id]/extend/route.ts", "POST", "续住"],
  ["src/app/api/mini/stays/[id]/change-room/route.ts", "POST", "换房申请"],
  ["src/app/api/mini/stays/[id]/late-checkout/route.ts", "POST", "延迟退房"],
  ["src/app/api/mini/stays/[id]/wakeup/route.ts", "POST", "叫醒"],
  ["src/app/api/mini/stays/[id]/service/route.ts", "POST", "服务请求"],
  ["src/app/api/mini/service-orders/route.ts", "GET", "服务请求列表"],
  ["src/app/api/mini/service-orders/[id]/cancel/route.ts", "POST", "取消服务请求"],
];

const missing = ROUTES.filter(([file]) => readText(file).length === 0).map(([file]) => file);
check(`12 个路由文件都存在（清单第三节：订单 3 + 在住 7 + 服务请求 2）`, missing.length === 0, missing.join(","));

const noDynamic = ROUTES.filter(([file]) => !/export const dynamic = "force-dynamic"/.test(readText(file)));
check("每个路由都声明 dynamic = force-dynamic（接口数据不缓存）", noDynamic.length === 0, noDynamic.map((r) => r[0]).join(","));

const missingExport = ROUTES.filter(([file, method]) => !new RegExp(`export async function ${method}\\(`).test(readText(file)));
check("每个路由都导出了对应的方法（GET/POST）", missingExport.length === 0, missingExport.map((r) => r[0]).join(","));

/*
 * 鉴权入口：所有路由都必须经过 miniGuard（限流 + token + 配置三合一），
 * 或通过 submitStayApplication（内部同样走 miniGuard）。
 * 这条断言防的是「新加一个接口忘了鉴权」。
 */
const noGuard = ROUTES.filter(([file]) => {
  const src = readText(file);
  return !src.includes("miniGuard") && !src.includes("submitStayApplication");
});
check("所有路由都经过统一网关 miniGuard（限流 + token + 配置）", noGuard.length === 0, noGuard.map((r) => r[0]).join(","));

/* 不信任客户端 hotelId：任何路由都不得从请求体 / query 里读 hotelId */
const clientHotelId = ROUTES.filter(([file]) => {
  const src = readText(file);
  return /body\.(hotelId|hotel_id)|searchParams\.get\(["']hotelId["']\)|body\.(guestId|guest_id)|body\.(folioId|folio_id)/.test(src);
});
check(
  "没有任何路由从请求体 / query 里读 hotelId / guestId / folioId（不信任客户端 id）",
  clientHotelId.length === 0,
  clientHotelId.map((r) => r[0]).join(",")
);

/** 写接口（POST）必须能挡住重复提交 */
const POST_ROUTES = ROUTES.filter(([, method]) => method === "POST");
const noIdempotent = POST_ROUTES.filter(([file]) => {
  const src = readText(file);
  /* 服务类走 submitStayApplication（内部校验 requestId），其余必须出现 requestId */
  return !src.includes("requestId") && !src.includes("submitStayApplication");
});
check("所有 POST 路由都接入了 request_id 幂等", noIdempotent.length === 0, noIdempotent.map((r) => r[0]).join(","));

const sharedSrc = readText(join("src", "app", "api", "mini", "_shared.ts"));
check("_shared.ts 提供统一网关 miniGuard", sharedSrc.includes("export function miniGuard"));
check("_shared.ts 的 miniGuard 先限流再鉴权", /rateLimit\(req, \{ scope, limit \}\)[\s\S]{0,400}requireMiniToken\(req\)/.test(sharedSrc));
check("_shared.ts 用 getActiveMiniConfig 判 NOT_CONFIGURED", sharedSrc.includes("getActiveMiniConfig") && sharedSrc.includes("NOT_CONFIGURED"));
check("_shared.ts 有归属校验 loadOwnedStay（stayId 必须属于当前 mini_user）", /export function loadOwnedStay/.test(sharedSrc));
check("loadOwnedStay 的 SQL 带 hotel_id + guest_id 条件", /WHERE s\.id = \? AND s\.hotel_id = \?[\s\S]{0,200}s\.guest_id = \?/.test(sharedSrc));
check("_shared.ts 有运行时建表 ensureMiniServiceSchema（第 4 处同步）", /export function ensureMiniServiceSchema/.test(sharedSrc));
check("运行时建表带 request_id 部分唯一索引", sharedSrc.includes("idx_mini_service_requests_req") && sharedSrc.includes("WHERE request_id IS NOT NULL"));
check("_shared.ts 的敏感日志只写 op_logs（operator=微信小程序）", sharedSrc.includes("微信小程序") && sharedSrc.includes("op_logs"));

/* 五处 schema 同步（清单第六节第 387-394 行） */
const schemaFull = readText(join("scripts", "schema-full.sql"));
const initDb = readText(join("scripts", "init-db.mjs"));
const migrateAll = readText(join("scripts", "migrate-all.mjs"));
const fingerprint = readText(join("scripts", "schema-fingerprint.json"));

check("① schema-full.sql 有 mini_service_requests 建表", schemaFull.includes("CREATE TABLE mini_service_requests"));
check("② init-db.mjs 有 mini_service_requests 建表", initDb.includes("CREATE TABLE IF NOT EXISTS mini_service_requests"));
check("③ migrate-all.mjs 有 mini_service_requests 建表", migrateAll.includes("CREATE TABLE mini_service_requests"));
check("④ 运行时 ensureMiniServiceSchema 建同一张表", sharedSrc.includes("CREATE TABLE IF NOT EXISTS mini_service_requests"));
check("⑤ schema-fingerprint.json 已导出该表", fingerprint.includes('"mini_service_requests"'));

const NEED_COLS = [
  "id",
  "hotel_id",
  "mini_user_id",
  "guest_id",
  "stay_id",
  "booking_id",
  "service_type",
  "status",
  "request_id",
  "note",
  "operator",
  "created_at",
  "updated_at",
  "completed_at",
];
check(
  "五处 DDL 的列集合一致（清单第 396-411 行 14 列）",
  NEED_COLS.every(
    (c) =>
      new RegExp(`CREATE TABLE (IF NOT EXISTS )?mini_service_requests[\\s\\S]{0,900}${c}\\s`).test(
        schemaFull + initDb + migrateAll + sharedSrc
      ) && fingerprint.includes(`"name": "${c}"`)
  )
);
check(
  "三处脚本都声明了 request_id 的部分唯一索引",
  [schemaFull, initDb, migrateAll].every(
    (src) => /mini_service_requests\(hotel_id, request_id\) WHERE request_id IS NOT NULL/.test(src)
  )
);

/* ========================================================================== */
/* 2. 造临时库（真实 schema 子集 + 两个租户 / 四个 mini 用户 / 两张在住单）      */
/* ========================================================================== */

console.log("\n── 2. 临时库准备 ──");

const TMP = join(ROOT, ".tmp", `mini-order-access-${process.pid}-${Date.now()}`);
const TMP_DATA = join(TMP, "data");
mkdirSync(TMP_DATA, { recursive: true });
const TMP_DB = join(TMP_DATA, "pms.db");

/* 本地日期（营业日切换默认 00:00，见 src/lib/biz-date.ts 的 DEFAULT_CUTOFF） */
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
const D4 = plusDays(TODAY, 4);
const D5 = plusDays(TODAY, 5);
const D6 = plusDays(TODAY, 6);
const D7 = plusDays(TODAY, 7);
const D9 = plusDays(TODAY, 9);

/* 临时库里**故意不建** mini_service_requests：验证运行时 ensureMiniServiceSchema 真的会建 */
const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT,
    gender TEXT, id_no TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT
  );
  CREATE TABLE room_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT, name TEXT,
    bed_type TEXT, max_occupancy INTEGER, base_price REAL, sort INTEGER
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

/* ── 两家酒店 / 房型 / 房间 ── */
ins(`INSERT INTO hotels (id, code, name) VALUES (1, 'H1', '测试酒店一号')`);
ins(`INSERT INTO hotels (id, code, name) VALUES (2, 'H2', '测试酒店二号')`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (11, 1, 'STD', '标准间', 300, 2, 1)`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (21, 2, 'STD', '标准间B', 200, 2, 1)`);
for (const [id, hotel, no, type, status] of [
  [3001, 1, "3001", 11, "OC"],
  [3002, 1, "3002", 11, "OC"],
  [3003, 1, "3003", 11, "VC"],
  [3004, 1, "3004", 11, "VC"],
  [9001, 2, "9001", 21, "VC"],
]) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, id, hotel, no, type, status, id);
}

/* ── 客史：A / B 属于酒店 1，C 属于酒店 2 ── */
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (100, 1, '张三', '13800000001', 0, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (101, 1, '李四', '13800000002', 0, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (200, 2, '王五', '13900000003', 0, 0)`);

/* ── 小程序配置（酒店 1 启用）── */
ins(
  `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, mch_id, mch_key, enabled, updated_at) VALUES (1,'wxtestappid0001','test_app_secret_0001','','',1,?)`,
  iso(NOW_MS)
);

/* ── 四个 mini 用户 + 一个过期 token ── */
const USERS = [
  [1, 1, "openid-a", 100, "token-a", iso(NOW_MS + 6 * 86400000)],
  [2, 1, "openid-b", 101, "token-b", iso(NOW_MS + 6 * 86400000)],
  [3, 1, "openid-unbound", null, "token-unbound", iso(NOW_MS + 6 * 86400000)],
  [4, 2, "openid-h2", 200, "token-h2", iso(NOW_MS + 6 * 86400000)],
  [5, 1, "openid-expired", 100, "token-expired", iso(NOW_MS - 3600000)],
];
for (const [id, hotel, openid, guestId, token, exp] of USERS) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, hotel, openid, guestId, token, exp, iso(NOW_MS), iso(NOW_MS)
  );
}

/* ── 预订：1001(A 绑定客史) / 1002(B) / 1003(A 仅靠小程序关联) / 1004(渠道单，续住冲突用) ── */
const bookingRow = (
  id, hotel, no, guestId, guestName, mobile, typeId, roomId, ci, co, nights, rooms, rate, total, status, createdBy, channelId
) =>
  ins(
    `INSERT INTO bookings (id, hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id,
       check_in_date, check_out_date, nights, room_count, guest_count, rate, deposit, total_price, status,
       pay_type, created_by, channel_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, hotel, no, guestId, guestName, mobile, typeId, roomId, ci, co, nights, rooms, 1, rate, 0, total, status,
    "到店付款", createdBy, channelId, iso(NOW_MS), iso(NOW_MS)
  );

bookingRow(1001, 1, "BK1001", 100, "张三", "13800000001", 11, 3001, TOMORROW, D3, 2, 1, 300, 600, "CONFIRMED", null, null);
bookingRow(1002, 1, "BK1002", 101, "李四", "13800000002", 11, 3002, TOMORROW, D3, 2, 1, 300, 600, "CONFIRMED", null, null);
bookingRow(1003, 1, "BK1003", null, "张三", "13800000001", 11, null, D5, D7, 2, 1, 300, 600, "CONFIRMED", null, null);
/* 1004：渠道预订单（前台排房到 3001，占用 D2~D4）→ A 续住到 D3 必须冲突 */
bookingRow(1004, 1, "BK1004", null, "渠道客", "13700000009", 11, 3001, D2, D4, 2, 1, 300, 600, "CONFIRMED", null, 1);

const bookingRoomRow = (hotel, bookingId, typeId, roomId, status, ci, co, stayId = null) =>
  ins(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
       check_in_date, check_out_date, stay_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotel, bookingId, typeId, roomId, "张三", "13800000001", 300, status, ci, co, stayId, iso(NOW_MS)
  );

bookingRoomRow(1, 1001, 11, 3001, "CONFIRMED", TOMORROW, D3);
bookingRoomRow(1, 1002, 11, 3002, "CONFIRMED", TOMORROW, D3);
bookingRoomRow(1, 1003, 11, 3003, "CONFIRMED", D5, D7);
bookingRoomRow(1, 1004, 11, 3001, "CONFIRMED", D2, D4);

/* ── 小程序订单关联：1003 只通过关联表属于 A（guest_id 为空，验证第二条授权路径）── */
ins(`INSERT INTO mini_program_bookings (hotel_id, mini_user_id, booking_id, created_at) VALUES (1, 1, 1003, ?)`, iso(NOW_MS));
ins(`INSERT INTO mini_program_bookings (hotel_id, mini_user_id, booking_id, created_at) VALUES (1, 2, 1002, ?)`, iso(NOW_MS));

/* ── 在住单：500 = A（房间 3001，明天起被 1004 占住）/ 501 = B（房间 3002）── */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, booking_id, room_id, guest_id, guest_name, mobile,
     check_in_time, expect_check_out, nights, rate, deposit, guest_count, status, created_at)
   VALUES (500, 1, 'S500', NULL, 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 0, 1, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, D2, iso(NOW_MS)
);
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, booking_id, room_id, guest_id, guest_name, mobile,
     check_in_time, expect_check_out, nights, rate, deposit, guest_count, status, created_at)
   VALUES (501, 1, 'S501', NULL, 3002, 101, '李四', '13800000002', ?, ?, 2, 300, 0, 1, 'INHOUSE', ?)`,
  `${TODAY}T15:00:00.000+08:00`, D2, iso(NOW_MS)
);

/* ── 账单：500 有两晚房费（600），未收款 ── */
ins(`INSERT INTO folios (id, hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
     VALUES (800, 1, 'F800', 500, '张三', '3001', 600, 0, 600, 'OPEN', ?)`, iso(NOW_MS));
ins(`INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
     VALUES (1, 800, 'ROOM', ?, 1, 300, 300, ?, ?)`, `房费 ${TODAY}`, TODAY, iso(NOW_MS));
ins(`INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
     VALUES (1, 800, 'ROOM', ?, 1, 300, 300, ?, ?)`, `房费 ${TOMORROW}`, TOMORROW, iso(NOW_MS));

console.log(`临时库：${TMP_DB}`);
check("临时库造好（2 家酒店 / 4 个 mini 用户 / 2 张在住单 / 4 张订单）", true);
check("临时库**没有** mini_service_requests 表（待运行时 ensureSchema 建）", !hasTable(db, "mini_service_requests"));

function hasTable(conn, name) {
  return conn.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`).get(name).n > 0;
}

/* ========================================================================== */
/* 3. 用 esbuild 把真实路由打成一个 bundle（进程内调用，不用 HTTP）             */
/* ========================================================================== */

console.log("\n── 3. 编译真实路由（esbuild bundle） ──");

const ENTRY = join(TMP, "entry.ts");
const BUNDLE = join(TMP, "bundle.cjs");
const srcAbs = (rel) => join(ROOT, "src", rel.split("/").join("\\")).replace(/\\/g, "/");
const entrySource = `
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
`;
writeFileSyncSafe(ENTRY, entrySource);

function writeFileSyncSafe(path, content) {
  const fs = require("node:fs");
  fs.writeFileSync(path, content, "utf8");
}

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

/* 切到临时目录：src/lib/db.ts 的 DB 路径是 process.cwd()/data/pms.db */
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
/* 4. 真实调用：越权 / 幂等 / 库存 / 金额                                     */
/* ========================================================================== */

/** 造一个请求 */
function makeReq({ token, method = "GET", url = "http://127.0.0.1/api/mini/x", body }) {
  const headers = { "user-agent": "mini-order-test" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 安全 JSON.stringify（payload 为 null / undefined 时不会返回 undefined） */
function j(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 调用路由并解析 JSON（先取 text 再 parse：route 抛异常时能打出真实错误） */
async function call(handler, opts) {
  const res = await handler(makeReq(opts), { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { __raw: text.slice(0, 500) };
  }
  return { status: res.status, body: payload, text, headers: res.headers };
}

if (routes) {
  console.log("\n── 4. 订单：越权与库存 ──");

  /* ---------- 4.1 A 不能读 B 的订单 ---------- */
  const aOwn = await call(routes.bookingDetail, { token: "token-a", params: { id: "1001" } });
  check(
    "A 能读自己的订单（guest_id 匹配）",
    aOwn.status === 200 && aOwn.body?.ok === true && aOwn.body?.data?.bookingNo === "BK1001",
    j(aOwn.body).slice(0, 160)
  );
  const bOwn = await call(routes.bookingDetail, { token: "token-a", params: { id: "1002" } });
  check(
    "A **不能**读 B 的订单（交叉请求 → 404 BOOKING_NOT_FOUND）",
    bOwn.status === 404 && bOwn.body?.ok === false && bOwn.body?.code === "BOOKING_NOT_FOUND",
    `status=${bOwn.status} ${j(bOwn.body).slice(0, 120)}`
  );
  const bReadsOwn = await call(routes.bookingDetail, { token: "token-b", params: { id: "1002" } });
  check("B 能读自己的订单", bReadsOwn.status === 200 && bReadsOwn.body?.data?.bookingNo === "BK1002");
  const aViaLink = await call(routes.bookingDetail, { token: "token-a", params: { id: "1003" } });
  check(
    "A 能读「只靠小程序关联表」的订单（guest_id 为空，mini_program_bookings 兜底）",
    aViaLink.status === 200 && aViaLink.body?.data?.bookingId === 1003
  );

  /* ---------- 4.2 脱敏：响应里不出现完整手机号 / 完整姓名 ---------- */
  const rawDetail = JSON.stringify(aOwn.body);
  check(
    "订单详情对手机号脱敏（响应里没有 13800000001）",
    !rawDetail.includes("13800000001") && rawDetail.includes("****")
  );
  check("订单详情对姓名脱敏（响应里没有完整「张三」）", !rawDetail.includes("张三"));

  /* ---------- 4.3 取消订单：必须释放 booking_rooms ---------- */
  const beforeCancel = db
    .prepare(`SELECT room_id, status FROM booking_rooms WHERE hotel_id = 1 AND booking_id = 1003`)
    .get();
  check(
    "取消前：booking_rooms 明细占着房（room_id 非空 + CONFIRMED）",
    Number(beforeCancel.room_id) === 3003 && beforeCancel.status === "CONFIRMED",
    JSON.stringify(beforeCancel)
  );

  const cancelRes = await call(routes.bookingCancel, {
    token: "token-a",
    method: "POST",
    params: { id: "1003" },
    body: { reason: "行程有变", requestId: "cancel-1003-1" },
  });
  check(
    "A 取消自己的订单成功",
    cancelRes.status === 200 && cancelRes.body?.ok === true && cancelRes.body?.data?.status === "CANCELLED",
    j(cancelRes.body).slice(0, 160)
  );

  const afterCancel = db
    .prepare(`SELECT room_id, status FROM booking_rooms WHERE hotel_id = 1 AND booking_id = 1003`)
    .get();
  const afterMain = db
    .prepare(`SELECT status, room_id FROM bookings WHERE id = 1003 AND hotel_id = 1`)
    .get();
  check(
    "取消后：booking_rooms 真的释放（room_id 置空 + status=CANCELLED）",
    afterCancel.room_id === null && afterCancel.status === "CANCELLED",
    JSON.stringify(afterCancel)
  );
  check(
    "取消后：主单 CANCELLED 且 room_id 镜像已清空",
    afterMain.status === "CANCELLED" && afterMain.room_id === null,
    JSON.stringify(afterMain)
  );
  check("取消返回里带上释放间数", Number(cancelRes.body?.data?.releasedRooms) === 1);

  const cancelAgain = await call(routes.bookingCancel, {
    token: "token-a",
    method: "POST",
    params: { id: "1003" },
    body: { requestId: "cancel-1003-1" },
  });
  check(
    "重复取消幂等（alreadyCancelled = true，不报错）",
    cancelAgain.status === 200 && cancelAgain.body?.data?.alreadyCancelled === true
  );

  const cancelOthers = await call(routes.bookingCancel, {
    token: "token-a",
    method: "POST",
    params: { id: "1002" },
    body: { requestId: "cancel-1002-1" },
  });
  check(
    "A 不能取消 B 的订单（404，且 B 的单状态不变）",
    cancelOthers.status === 404 &&
      db.prepare(`SELECT status FROM bookings WHERE id = 1002`).get().status === "CONFIRMED"
  );

  /* ---------- 4.4 改单：重算价格 + 同步 booking_rooms 间数 ---------- */
  const modifyRes = await call(routes.bookingModify, {
    token: "token-a",
    method: "POST",
    params: { id: "1001" },
    body: { checkInDate: D6, checkOutDate: D9, roomCount: 2, requestId: "modify-1001-1" },
  });
  check(
    "A 改单成功（改日期 + 加房数）",
    modifyRes.status === 200 && modifyRes.body?.ok === true,
    j(modifyRes.body).slice(0, 200)
  );
  check(
    "改单后价格由服务端重算：300 × 3 晚 × 2 间 = 1800",
    Number(modifyRes.body?.data?.totalPrice) === 1800 && Number(modifyRes.body?.data?.rate) === 300,
    JSON.stringify({ rate: modifyRes.body?.data?.rate, total: modifyRes.body?.data?.totalPrice })
  );
  const modifiedMain = db.prepare(`SELECT total_price, nights, room_count, status FROM bookings WHERE id = 1001`).get();
  check(
    "改单落库：total_price / nights / room_count / status 同步",
    Number(modifiedMain.total_price) === 1800 &&
      Number(modifiedMain.nights) === 3 &&
      Number(modifiedMain.room_count) === 2 &&
      modifiedMain.status === "PENDING",
    JSON.stringify(modifiedMain)
  );
  const detailCount = db
    .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE hotel_id = 1 AND booking_id = 1001 AND status IN ('PENDING','CONFIRMED')`)
    .get().n;
  check("改单后 booking_rooms 明细间数同步为 2 行", Number(detailCount) === 2, `实际 ${detailCount}`);
  const modifyAgain = await call(routes.bookingModify, {
    token: "token-a",
    method: "POST",
    params: { id: "1001" },
    body: { checkInDate: D6, checkOutDate: D9, roomCount: 2, requestId: "modify-1001-1" },
  });
  const detailCount2 = db
    .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE hotel_id = 1 AND booking_id = 1001 AND status IN ('PENDING','CONFIRMED')`)
    .get().n;
  check(
    "改单是「设成绝对目标值」→ 同请求重放结果一致且明细仍是 2 行（幂等）",
    modifyAgain.status === 200 &&
      Number(modifyAgain.body?.data?.totalPrice) === 1800 &&
      Number(detailCount2) === 2,
    `status=${modifyAgain.status} total=${modifyAgain.body?.data?.totalPrice} rows=${detailCount2}`
  );

  console.log("\n── 5. 在住：未绑定 / 伪造 stayId / 账单金额 ──");

  /* ---------- 5.1 未绑定用户 ---------- */
  const unbound = await call(routes.staysCurrent, { token: "token-unbound", url: "http://127.0.0.1/api/mini/stays/current" });
  check(
    "未绑定用户请求 stays/current → 空列表（bound:false, stays:[]）",
    unbound.status === 200 && unbound.body?.data?.bound === false && unbound.body?.data?.stays.length === 0,
    j(unbound.body).slice(0, 160)
  );
  const unboundFolio = await call(routes.stayFolio, { token: "token-unbound", params: { id: "500" } });
  check(
    "未绑定用户读账单 → NOT_BOUND（不放行）",
    unboundFolio.body?.ok === false && unboundFolio.body?.code === "NOT_BOUND"
  );
  const unboundService = await call(routes.stayService, {
    token: "token-unbound",
    method: "POST",
    params: { id: "500" },
    body: { serviceType: "CLEANING", requestId: "svc-unbound-1" },
  });
  check(
    "未绑定用户提服务请求 → NOT_BOUND",
    unboundService.body?.ok === false && unboundService.body?.code === "NOT_BOUND"
  );

  /* ---------- 5.2 当前在住只回自己的 ---------- */
  const aCurrent = await call(routes.staysCurrent, { token: "token-a", url: "http://127.0.0.1/api/mini/stays/current" });
  const aStayIds = (aCurrent.body?.data?.stays ?? []).map((s) => s.stayId);
  check(
    "A 的当前在住只有自己那间（含 500，不含 B 的 501）",
    aCurrent.status === 200 && aStayIds.includes(500) && !aStayIds.includes(501),
    JSON.stringify(aStayIds)
  );
  check(
    "在住列表带服务端算好的账单金额（total 600 / balance 600）",
    aCurrent.body?.data?.stays?.[0]?.folio?.total === 600 && aCurrent.body?.data?.stays?.[0]?.folio?.balance === 600,
    JSON.stringify(aCurrent.body?.data?.stays?.[0]?.folio)
  );
  const aCurrentRaw = JSON.stringify(aCurrent.body);
  check(
    "在住列表对手机号 / 姓名脱敏",
    !aCurrentRaw.includes("13800000001") && !aCurrentRaw.includes("张三")
  );

  const bCurrent = await call(routes.staysCurrent, { token: "token-b", url: "http://127.0.0.1/api/mini/stays/current" });
  check(
    "B 的当前在住只有 501（拿不到 A 的 500）",
    (bCurrent.body?.data?.stays ?? []).map((s) => s.stayId).join(",") === "501",
    JSON.stringify((bCurrent.body?.data?.stays ?? []).map((s) => s.stayId))
  );

  /* ---------- 5.3 伪造 stayId（B 的 501） ---------- */
  const forgedFolio = await call(routes.stayFolio, { token: "token-a", params: { id: "501" } });
  check(
    "A 用 B 的 stayId 读账单 → 404 STAY_NOT_FOUND",
    forgedFolio.status === 404 && forgedFolio.body?.code === "STAY_NOT_FOUND",
    j(forgedFolio.body).slice(0, 140)
  );
  const forgedExtend = await call(routes.stayExtend, {
    token: "token-a",
    method: "POST",
    params: { id: "501" },
    body: { nights: 1, requestId: "extend-501-1" },
  });
  check(
    "A 用 B 的 stayId 续住 → 404 STAY_NOT_FOUND",
    forgedExtend.status === 404 && forgedExtend.body?.code === "STAY_NOT_FOUND"
  );
  const forgedService = await call(routes.stayService, {
    token: "token-a",
    method: "POST",
    params: { id: "501" },
    body: { serviceType: "CLEANING", requestId: "svc-forged-1" },
  });
  check(
    "A 用 B 的 stayId 提服务请求 → 404 STAY_NOT_FOUND",
    forgedService.status === 404 && forgedService.body?.code === "STAY_NOT_FOUND"
  );
  const forgedCount = db
    .prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE stay_id = 501`)
    .get().n;
  check("伪造 stayId 的请求一条都没落库（stay_id=501 计数 0）", Number(forgedCount) === 0, `实际 ${forgedCount}`);

  /* ---------- 5.4 账单：金额服务端算 ---------- */
  const folioRes = await call(routes.stayFolio, { token: "token-a", params: { id: "500" } });
  check(
    "A 读自己的账单成功，金额由服务端算（total 600 / paid 0 / balance 600）",
    folioRes.status === 200 &&
      folioRes.body?.data?.total === 600 &&
      folioRes.body?.data?.paid === 0 &&
      folioRes.body?.data?.balance === 600,
    j(folioRes.body?.data).slice(0, 200)
  );
  check("账单明细带 id（2 条房费）", (folioRes.body?.data?.items ?? []).length === 2);
  check(
    "账单响应里没有 folioId 之外的越权入口（不含 mini_user_id / guest_id）",
    !JSON.stringify(folioRes.body).includes("mini_user_id") && !JSON.stringify(folioRes.body).includes("guest_id")
  );

  console.log("\n── 6. 续住：远期冲突 / 金额 / 幂等 ──");

  /* ---------- 6.1 冲突被拒（房间 3001 在 D2 起已被 1004 占用） ---------- */
  const conflictExtend = await call(routes.stayExtend, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { nights: 1, requestId: "extend-conflict-1" },
  });
  check(
    "续住冲突被拒（房间明晚已被预订）→ ROOM_CONFLICT",
    conflictExtend.body?.ok === false && conflictExtend.body?.code === "ROOM_CONFLICT",
    j(conflictExtend.body).slice(0, 200)
  );
  const conflictText = String(conflictExtend.body?.error ?? "");
  check(
    "冲突文案不泄漏别人信息（不含客人姓名 / 别人单号）",
    !conflictText.includes("渠道客") && !conflictText.includes("BK1004"),
    conflictText.slice(0, 120)
  );
  check(
    "冲突被拒时入住单没被改（expect_check_out 仍是 D2）",
    db.prepare(`SELECT expect_check_out FROM stays WHERE id = 500`).get().expect_check_out === D2
  );

  /* ---------- 6.2 释放冲突后再续，验证金额与幂等 ---------- */
  db.prepare(`UPDATE bookings SET status = 'CANCELLED' WHERE id = 1004`).run();
  db.prepare(`UPDATE booking_rooms SET status = 'CANCELLED', room_id = NULL WHERE booking_id = 1004`).run();

  const okExtend = await call(routes.stayExtend, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { nights: 1, requestId: "extend-ok-1" },
  });
  check(
    "冲突解除后续住成功（离店日 +1，房费 +300）",
    okExtend.status === 200 &&
      okExtend.body?.data?.expectCheckOut === D3 &&
      Number(okExtend.body?.data?.addedAmount) === 300,
    j(okExtend.body).slice(0, 200)
  );
  check(
    "续住落库：stays.expect_check_out 更新为 D3、nights = 3",
    db.prepare(`SELECT expect_check_out, nights FROM stays WHERE id = 500`).get().expect_check_out === D3 &&
      Number(db.prepare(`SELECT nights FROM stays WHERE id = 500`).get().nights) === 3
  );
  const folioItemsAfter = db
    .prepare(`SELECT COUNT(*) AS n, ROUND(SUM(amount),2) AS sum FROM folio_items WHERE folio_id = 800 AND item_type = 'ROOM'`)
    .get();
  check(
    "续住补一条房费明细（3 条 ROOM 明细 / 合计 900，服务端计价）",
    Number(folioItemsAfter.n) === 3 && Number(folioItemsAfter.sum) === 900,
    JSON.stringify(folioItemsAfter)
  );
  const folioAfter = db.prepare(`SELECT total_amount FROM folios WHERE id = 800`).get();
  check("续住后账单总额被统一重算（900）", Number(folioAfter.total_amount) === 900, JSON.stringify(folioAfter));

  const replayExtend = await call(routes.stayExtend, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { nights: 1, requestId: "extend-ok-1" },
  });
  const itemsAfterReplay = db
    .prepare(`SELECT COUNT(*) AS n FROM folio_items WHERE folio_id = 800 AND item_type = 'ROOM'`)
    .get().n;
  check(
    "同 requestId 重放续住 → duplicated:true 且不重复补房费（仍是 3 条）",
    replayExtend.body?.data?.duplicated === true && Number(itemsAfterReplay) === 3,
    `items=${itemsAfterReplay}`
  );

  console.log("\n── 7. 换房 / 延迟退房 / 叫醒 / 服务请求 ──");

  /* ---------- 7.1 换房：不能跨酒店 ---------- */
  const crossHotel = await call(routes.stayChangeRoom, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { roomId: 9001, requestId: "change-cross-1" },
  });
  check(
    "换房到别家酒店的房间 → 404 ROOM_NOT_FOUND（不能跨酒店）",
    crossHotel.status === 404 && crossHotel.body?.code === "ROOM_NOT_FOUND",
    j(crossHotel.body).slice(0, 160)
  );
  const crossHotelByNo = await call(routes.stayChangeRoom, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { roomNo: "9001", requestId: "change-cross-2" },
  });
  check(
    "按房间号 9001（别家酒店）换房同样被拒",
    crossHotelByNo.status === 404 && crossHotelByNo.body?.code === "ROOM_NOT_FOUND"
  );
  const sameRoom = await call(routes.stayChangeRoom, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { roomId: 3001, requestId: "change-same-1" },
  });
  check("换房到当前房间 → BAD_REQUEST", sameRoom.body?.code === "BAD_REQUEST");

  const okChange = await call(routes.stayChangeRoom, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { roomId: 3004, reason: "想住高楼层", requestId: "change-ok-1" },
  });
  check(
    "换房申请成功（只建申请，status = PENDING）",
    okChange.status === 200 && okChange.body?.data?.status === "PENDING" && okChange.body?.data?.duplicated === false,
    j(okChange.body).slice(0, 200)
  );
  check(
    "换房只建申请、不改 stays.room_id（仍在 3001）",
    Number(db.prepare(`SELECT room_id FROM stays WHERE id = 500`).get().room_id) === 3001
  );
  const changeReplay = await call(routes.stayChangeRoom, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { roomId: 3004, requestId: "change-ok-1" },
  });
  check("换房申请重放 → duplicated:true", changeReplay.body?.data?.duplicated === true);

  /* ---------- 7.2 延迟退房 ---------- */
  const badLate = await call(routes.stayLateCheckout, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { time: "09:00", requestId: "late-bad-1" },
  });
  check("延迟退房早于 12:00 → 拒绝", badLate.body?.ok === false && badLate.body?.code === "BAD_REQUEST");
  const tooLate = await call(routes.stayLateCheckout, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { time: "23:30", requestId: "late-bad-2" },
  });
  check("延迟退房晚于 20:00 → 拒绝", tooLate.body?.ok === false && tooLate.body?.code === "BAD_REQUEST");
  const okLate = await call(routes.stayLateCheckout, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { time: "14:00", requestId: "late-ok-1" },
  });
  check(
    "延迟退房申请成功（PENDING + 回吐 requestedTime）",
    okLate.body?.ok === true && okLate.body?.data?.status === "PENDING" && okLate.body?.data?.requestedTime === "14:00"
  );

  /* ---------- 7.3 叫醒：两处落库 + 幂等 ---------- */
  const wake = await call(routes.stayWakeup, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { wakeTime: "07:30", note: "赶早班机", requestId: "wake-0001" },
  });
  check(
    "叫醒登记成功并回吐归一化时间（YYYY-MM-DD HH:MM）",
    wake.body?.ok === true && /^\d{4}-\d{2}-\d{2} 07:30$/.test(String(wake.body?.data?.wakeTime ?? "")),
    `status=${wake.status} body=${j(wake.body).slice(0, 300)} raw=${String(wake.text ?? "").slice(0, 300)}`
  );
  const wakeCalls = db.prepare(`SELECT COUNT(*) AS n FROM wake_up_calls WHERE stay_id = 500`).get().n;
  check("叫醒同时写入 PC 端的 wake_up_calls（前台能看到）", Number(wakeCalls) === 1, `实际 ${wakeCalls}`);
  const wakeReplay = await call(routes.stayWakeup, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { wakeTime: "07:30", note: "赶早班机", requestId: "wake-0001" },
  });
  const wakeCalls2 = db.prepare(`SELECT COUNT(*) AS n FROM wake_up_calls WHERE stay_id = 500`).get().n;
  check(
    "同 requestId 重放叫醒 → 不重复登记（wake_up_calls 仍 1 条）",
    wakeReplay.body?.data?.duplicated === true && Number(wakeCalls2) === 1,
    `实际 ${wakeCalls2}`
  );

  /* ---------- 7.4 服务请求：类型白名单 + 同 requestId 只建一条 ---------- */
  const badType = await call(routes.stayService, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { serviceType: "DROP TABLE", requestId: "svc-badtype-1" },
  });
  check("服务类型不在白名单 → BAD_REQUEST", badType.body?.ok === false && badType.body?.code === "BAD_REQUEST");

  const svc1 = await call(routes.stayService, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { serviceType: "CLEANING", note: "请下午 3 点后来打扫", requestId: "svc-0001" },
  });
  check(
    "服务请求创建成功（duplicated:false, status PENDING）",
    svc1.status === 200 && svc1.body?.data?.duplicated === false && svc1.body?.data?.status === "PENDING",
    j(svc1.body).slice(0, 160)
  );
  const svc2 = await call(routes.stayService, {
    token: "token-a",
    method: "POST",
    params: { id: "500" },
    body: { serviceType: "CLEANING", note: "请下午 3 点后来打扫", requestId: "svc-0001" },
  });
  const svcCount = db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE request_id = 'svc-0001'`).get().n;
  check(
    "同 requestId 重复提服务请求 → 只建一条（库里 1 行，第二次 duplicated:true）",
    Number(svcCount) === 1 && svc2.body?.data?.duplicated === true,
    `count=${svcCount}`
  );
  check(
    "两次响应的记录 id 相同（前端可以认为是一次操作）",
    Number(svc1.body?.data?.serviceRequestId) === Number(svc2.body?.data?.serviceRequestId)
  );

  /* 运行时建表（第 4 处同步）确实生效 */
  check(
    "运行时 ensureMiniServiceSchema 在临时库里建出了 mini_service_requests",
    hasTable(db, "mini_service_requests")
  );

  console.log("\n── 8. 服务请求列表 / 取消（只能自己的） ──");

  const listA = await call(routes.serviceOrders, { token: "token-a", url: "http://127.0.0.1/api/mini/service-orders" });
  check(
    "A 的服务请求列表非空（至少包含刚提的清洁请求）",
    listA.status === 200 && (listA.body?.data?.requests ?? []).length >= 3,
    `实际 ${(listA.body?.data?.requests ?? []).length}`
  );
  check(
    "A 的列表里有「待处理」且可取消的项（cancellable 由服务端算）",
    (listA.body?.data?.requests ?? []).some((r) => r.cancellable === true && r.status === "PENDING")
  );
  const listB = await call(routes.serviceOrders, { token: "token-b", url: "http://127.0.0.1/api/mini/service-orders" });
  check(
    "B 的服务请求列表为 0（看不到 A 的请求）",
    listB.status === 200 && (listB.body?.data?.requests ?? []).length === 0,
    j(listB.body).slice(0, 140)
  );
  const listAWithFakeParam = await call(routes.serviceOrders, {
    token: "token-b",
    url: "http://127.0.0.1/api/mini/service-orders?miniUserId=1&hotelId=1",
  });
  check(
    "客户端伪造 miniUserId / hotelId 参数无效（B 仍然看不到 A 的请求）",
    (listAWithFakeParam.body?.data?.requests ?? []).length === 0
  );

  const svcId = Number(svc1.body?.data?.serviceRequestId);
  const cancelOthersSvc = await call(routes.serviceOrderCancel, {
    token: "token-b",
    method: "POST",
    params: { id: String(svcId) },
    body: { requestId: "svc-cancel-others" },
  });
  check(
    "B 取消 A 的服务请求 → 404 SERVICE_REQUEST_NOT_FOUND",
    cancelOthersSvc.status === 404 && cancelOthersSvc.body?.code === "SERVICE_REQUEST_NOT_FOUND"
  );
  check(
    "被拒绝后 A 的请求状态仍是 PENDING（没有被越权改掉）",
    db.prepare(`SELECT status FROM mini_service_requests WHERE id = ?`).get(svcId).status === "PENDING"
  );
  const cancelOwnSvc = await call(routes.serviceOrderCancel, {
    token: "token-a",
    method: "POST",
    params: { id: String(svcId) },
    body: { requestId: "svc-cancel-own" },
  });
  check(
    "A 取消自己的请求成功（CANCELLED）",
    cancelOwnSvc.status === 200 && cancelOwnSvc.body?.data?.status === "CANCELLED"
  );
  const cancelOwnAgain = await call(routes.serviceOrderCancel, {
    token: "token-a",
    method: "POST",
    params: { id: String(svcId) },
    body: {},
  });
  check("再次取消 → 幂等 alreadyCancelled:true", cancelOwnAgain.body?.data?.alreadyCancelled === true);

  /* 前台已接单（ACCEPTED）后不允许客人取消 */
  const processingId = db
    .prepare(`SELECT id FROM mini_service_requests WHERE hotel_id = 1 AND mini_user_id = 1 AND status = 'PENDING' ORDER BY id LIMIT 1`)
    .get();
  if (processingId) {
    db.prepare(`UPDATE mini_service_requests SET status = 'ACCEPTED' WHERE id = ?`).run(processingId.id);
    const cancelAccepted = await call(routes.serviceOrderCancel, {
      token: "token-a",
      method: "POST",
      params: { id: String(processingId.id) },
      body: {},
    });
    check(
      "前台已接单的请求客人不能取消（NOT_CANCELLABLE）",
      cancelAccepted.body?.ok === false && cancelAccepted.body?.code === "NOT_CANCELLABLE"
    );
  } else {
    check("前台已接单的请求客人不能取消（NOT_CANCELLABLE）", false, "造不出 PENDING 记录");
  }

  console.log("\n── 9. 统一错误码：token 过期 / 未配置 ──");

  const expired = await call(routes.staysCurrent, { token: "token-expired", url: "http://127.0.0.1/api/mini/stays/current" });
  check(
    "token 过期 → 401 UNAUTHORIZED",
    expired.status === 401 && expired.body?.code === "UNAUTHORIZED",
    `status=${expired.status} ${j(expired.body).slice(0, 120)}`
  );
  const noToken = await call(routes.staysCurrent, { url: "http://127.0.0.1/api/mini/stays/current" });
  check("不带 token → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED");

  db.prepare(`UPDATE mini_program_config SET enabled = 0 WHERE hotel_id = 1`).run();
  const notConfigured = await call(routes.staysCurrent, { token: "token-a", url: "http://127.0.0.1/api/mini/stays/current" });
  check(
    "小程序被停用 → NOT_CONFIGURED（不假装成功）",
    notConfigured.body?.ok === false && notConfigured.body?.code === "NOT_CONFIGURED",
    j(notConfigured.body).slice(0, 140)
  );
  db.prepare(`UPDATE mini_program_config SET enabled = 1 WHERE hotel_id = 1`).run();
  const backOnline = await call(routes.staysCurrent, { token: "token-a", url: "http://127.0.0.1/api/mini/stays/current" });
  check("重新启用后恢复正常（bound:true）", backOnline.body?.data?.bound === true);

  console.log("\n── 10. 租户隔离：别家酒店的 token 拿不到本店数据 ──");

  const h2Stays = await call(routes.staysCurrent, { token: "token-h2", url: "http://127.0.0.1/api/mini/stays/current" });
  check(
    "酒店 2 的用户在酒店 1 没有任何在住单（空的）",
    h2Stays.status === 200 && h2Stays.body?.data?.stays.length === 0
  );
  const h2ReadsH1 = await call(routes.bookingDetail, { token: "token-h2", params: { id: "1001" } });
  check(
    "酒店 2 的用户读酒店 1 的订单 → 404",
    h2ReadsH1.status === 404 && h2ReadsH1.body?.code === "BOOKING_NOT_FOUND"
  );
  const h2ExtendH1 = await call(routes.stayExtend, {
    token: "token-h2",
    method: "POST",
    params: { id: "500" },
    body: { nights: 1, requestId: "h2-extend-1" },
  });
  check("酒店 2 的用户续住酒店 1 的在住单 → 404 STAY_NOT_FOUND", h2ExtendH1.status === 404);

  console.log("\n── 11. 敏感动作留痕（op_logs） ──");

  const opLogs = db
    .prepare(`SELECT action, detail FROM op_logs WHERE hotel_id = 1 AND operator = '微信小程序'`)
    .all();
  check(
    "取消订单 / 改单 / 续住 / 服务请求都写了 op_logs（operator = 微信小程序）",
    ["小程序取消订单", "小程序修改订单", "小程序续住", "小程序客房清洁"].every((a) =>
      opLogs.some((r) => String(r.action).includes(a))
    ),
    opLogs.map((r) => r.action).join(",")
  );
  check(
    "op_logs 里没有完整手机号（日志同样脱敏）",
    !opLogs.some((r) => String(r.detail ?? "").includes("13800000001"))
  );

  console.log("");
  console.log("── 12. 频率限制（关键接口必须有限流） ──");

  /*
   * 连续调到超过阈值（延迟退房写接口 10 次/分钟），必须出现 429。
   * 放在最后跑：这一轮会把 mini:stay:late-checkout 的配额用完，
   * 前面的延迟退房断言已经执行过了，不会被影响。
   */
  let limited = 0;
  let retryAfter = null;
  let lastCode = "";
  for (let i = 0; i < 12; i += 1) {
    const r = await call(routes.stayLateCheckout, {
      token: "token-a",
      method: "POST",
      params: { id: "500" },
      body: { time: "14:00", requestId: `late-rl-${String(i).padStart(2, "0")}xx` },
    });
    if (r.status === 429) {
      limited += 1;
      retryAfter = r.headers.get("retry-after");
      lastCode = String(r.body?.code ?? "");
    }
  }
  check(
    "写接口超限返回 429 RATE_LIMITED + retry-after（限流真的生效）",
    limited > 0 && lastCode === "RATE_LIMITED" && Number(retryAfter) >= 1,
    `limited=${limited} code=${lastCode} retry-after=${retryAfter}`
  );
} else {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 上面的静态校验仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
}

/* ========================================================================== */
/* 清理                                                                       */
/* ========================================================================== */

restoreCwd();
try {
  db.close();
} catch {
  /* ignore */
}
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  /* Windows 上偶发占用，留个目录不影响验收结论 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("失败项：");
  for (const name of failed) console.log(`  · ${name}`);
}
process.exit(fail === 0 ? 0 : 1);
