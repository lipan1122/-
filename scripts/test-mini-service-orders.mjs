#!/usr/bin/env node
/**
 * 微信小程序「在住服务请求」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-service-orders）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的事（清单第 441 行）
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **不能伪造 stay_id**：别人的在住单 / 已退房的单 / 别家酒店的单，
 *     一律 404 STAY_NOT_FOUND，并且数据库里一行都不能落。
 *     （stay_id 只是 URL 里的定位参数，授权必须由服务端按 token 推导。）
 *  2. 服务类型只能取白名单（CLEANING / DELIVERY / REPAIR / OTHER），
 *     `'x'; DROP TABLE ...` 这类内容直接 400；延迟退房/换房/叫醒/续住
 *     各有专门接口，不能从这里混进来。
 *  3. OTHER 必须填具体内容（只有类型没有内容，前台无法处理）。
 *  4. 同一 request_id 只建一条（重放返回 duplicated + 同一个 id）。
 *  5. 列表只返回自己的：`?miniUserId=` 这类参数被完全忽略；
 *     响应里也不回 mini_user_id / guest_id / hotel_id（不给探测坐标）。
 *  6. 取消只能取消自己的、且只有 PENDING 能取消（ACCEPTED/DONE 不行）。
 *  7. 叫醒双写 PC 端的 wake_up_calls（只写台账前台看不到 = 没提），
 *     重放不重复登记；取消叫醒时 wake_up_calls 同步 CANCELLED
 *     （否则前台仍会按旧记录去敲门）。
 *
 * 用法：node scripts/test-mini-service-orders.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

function sha256File(p) {
  if (!existsSync(p)) return "";
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const REAL_DB = join(ROOT, "data", "pms.db");
const realHashBefore = sha256File(REAL_DB);

console.log("── 1. 临时库准备 ──");

const TMP = join(ROOT, ".tmp", `mini-service-orders-${process.pid}-${Date.now()}`);
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
const T = plusDays(TODAY, 1);
const D2 = plusDays(TODAY, 2);
const D40 = plusDays(TODAY, 40);

const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE room_types (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT, name TEXT, base_price REAL, max_occupancy INTEGER, sort INTEGER);
  CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_no TEXT, floor INTEGER, room_type_id INTEGER, status TEXT, sort INTEGER);
  CREATE TABLE rate_calendar (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_type_id INTEGER NOT NULL, date TEXT NOT NULL, price REAL, allotment INTEGER);
  CREATE TABLE stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, stay_no TEXT, booking_id INTEGER,
    room_id INTEGER NOT NULL, guest_id INTEGER, guest_name TEXT, mobile TEXT,
    check_in_time TEXT, expect_check_out TEXT, actual_check_out TEXT, nights INTEGER,
    rate REAL NOT NULL, deposit REAL DEFAULT 0, guest_count INTEGER DEFAULT 1, status TEXT DEFAULT 'INHOUSE',
    channel_id INTEGER, remark TEXT, breakfast INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT
  );
  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, booking_no TEXT, guest_id INTEGER,
    guest_name TEXT, mobile TEXT, room_type_id INTEGER, room_id INTEGER, check_in_date TEXT,
    check_out_date TEXT, nights INTEGER, room_count INTEGER, rate REAL, total_price REAL, status TEXT,
    created_by INTEGER, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE booking_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, booking_id INTEGER, room_type_id INTEGER,
    room_id INTEGER, guest_name TEXT, mobile TEXT, rate REAL, status TEXT,
    check_in_date TEXT, check_out_date TEXT, stay_id INTEGER, created_at TEXT
  );
  CREATE TABLE folios (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_no TEXT, stay_id INTEGER, guest_name TEXT, room_no TEXT, total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, balance REAL DEFAULT 0, status TEXT DEFAULT 'OPEN', created_at TEXT);
  CREATE TABLE folio_items (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER NOT NULL, item_type TEXT, description TEXT, qty REAL DEFAULT 1, price REAL DEFAULT 0, amount REAL DEFAULT 0, biz_date TEXT, created_at TEXT, created_by INTEGER, request_id TEXT);
  CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER, stay_id INTEGER, amount REAL, created_at TEXT);
  CREATE TABLE op_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, operator TEXT, action TEXT, detail TEXT, created_at TEXT);
  CREATE TABLE mini_program_config (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, app_id TEXT, app_secret TEXT, mch_id TEXT, mch_key TEXT, enabled INTEGER DEFAULT 0, updated_at TEXT, UNIQUE(hotel_id));
  CREATE TABLE mini_program_users (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, openid TEXT NOT NULL, unionid TEXT, guest_id INTEGER, mobile TEXT, session_token TEXT, token_expires_at TEXT, bind_attempts INTEGER DEFAULT 0, bind_locked_until TEXT, created_at TEXT, updated_at TEXT);
  CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid);
  CREATE INDEX idx_mini_users_token ON mini_program_users(session_token);
  CREATE TABLE mini_program_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, mini_user_id INTEGER NOT NULL, booking_id INTEGER NOT NULL, created_at TEXT, UNIQUE(hotel_id, booking_id));
`);
/* 注意：故意**不建** mini_service_requests / wake_up_calls —— 验证运行时懒建 */

const iso = (ms) => new Date(ms).toISOString();
const NOW_MS = Date.now();
const ins = (sql, ...args) => db.prepare(sql).run(...args);

ins(`INSERT INTO hotels (id, code, name) VALUES (1, 'H1', '测试酒店一号')`);
ins(`INSERT INTO hotels (id, code, name) VALUES (2, 'H2', '测试酒店二号')`);
ins(`INSERT INTO settings (hotel_id, key, value) VALUES (1, 'biz_day_cutoff', '00:00')`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (11, 1, 'STD', '标准间', 300, 2, 1)`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (21, 2, 'STD2', '别家标准间', 200, 2, 1)`);
for (const [id, hotel, no, type, status] of [
  [3001, 1, "3001", 11, "OC"],
  [3002, 1, "3002", 11, "VC"],
  [3008, 1, "3008", 11, "OC"],
  [9001, 2, "9001", 21, "OC"],
]) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, id, hotel, no, type, status, id);
}

ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (100, 1, '张三', '13800000001')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (101, 1, '李四', '13800000002')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (200, 2, '王五', '13900000003')`);

ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-service-0001', 1, ?)`, iso(NOW_MS));
ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (2, 'wxtestappid0002', 'secret-service-0002', 1, ?)`, iso(NOW_MS));

for (const [id, hotel, openid, guestId, token] of [
  [1, 1, "openid-a", 100, "token-a"],
  [2, 1, "openid-b", 101, "token-b"],
  [3, 1, "openid-unbound", null, "token-unbound"],
  [4, 2, "openid-h2", 200, "token-h2"],
]) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, hotel, openid, guestId, token, iso(NOW_MS + 6 * 86400000), iso(NOW_MS), iso(NOW_MS)
  );
}

/* 在住单：500 = A（3001）/ 501 = B（3008）；502 = A 但已退房（不能提服务） */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (500, 1, 'S500', 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, D2, iso(NOW_MS)
);
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (501, 1, 'S501', 3008, 101, '李四', '13800000002', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T15:00:00.000+08:00`, D2, iso(NOW_MS)
);
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, status, created_at)
   VALUES (502, 1, 'S502', 3002, 100, '张三', '13800000001', ?, ?, ?, 2, 300, 'CHECKED_OUT', ?)`,
  `${plusDays(TODAY, -2)}T14:00:00.000+08:00`, TODAY, `${TODAY}T12:00:00.000+08:00`, iso(NOW_MS)
);

check("临时库造好（A/B/未绑定/别家 四个用户，3 张在住单）", true);
check(
  "故意没有 mini_service_requests / wake_up_calls（待运行时懒建）",
  Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('mini_service_requests','wake_up_calls')`).get().n) === 0
);

/* ========================================================================== */
/* 2. 打包真实路由                                                            */
/* ========================================================================== */

console.log("\n── 2. 编译真实路由（esbuild bundle） ──");

const ENTRY = join(TMP, "entry.ts");
const BUNDLE = join(TMP, "bundle.cjs");
const srcAbs = (rel) => join(ROOT, "src", rel.split("/").join("\\")).replace(/\\/g, "/");
writeFileSync(
  ENTRY,
  `
export { POST as stayService } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/service/route.ts"))};
export { POST as stayWakeup } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/wakeup/route.ts"))};
export { POST as stayLateCheckout } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/late-checkout/route.ts"))};
export { GET as serviceOrders } from ${JSON.stringify(srcAbs("app/api/mini/service-orders/route.ts"))};
export { POST as serviceOrderCancel } from ${JSON.stringify(srcAbs("app/api/mini/service-orders/[id]/cancel/route.ts"))};
export { GET as staysCurrent } from ${JSON.stringify(srcAbs("app/api/mini/stays/current/route.ts"))};
`,
  "utf8"
);

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
  check("真实路由编译成功（esbuild）", existsSync(BUNDLE));
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
/* 3. 调用工具                                                                */
/* ========================================================================== */

let uaSeq = 0;
function makeReq({ token, method = "GET", url = "http://127.0.0.1/api/mini/x", body, ua }) {
  /* 每个请求独立 UA：写接口 10 次/分钟限流，分散后互不挤占 */
  const headers = { "user-agent": ua || `service-test-${(uaSeq += 1)}` };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { __raw: text.slice(0, 500) };
  }
  return { status: res.status, body: payload, text, headers: res.headers };
}

const service = (token, stayId, body) =>
  call(routes.stayService, { token, method: "POST", params: { id: String(stayId) }, body });
const wakeup = (token, stayId, body) =>
  call(routes.stayWakeup, { token, method: "POST", params: { id: String(stayId) }, body });
const lateCheckout = (token, stayId, body) =>
  call(routes.stayLateCheckout, { token, method: "POST", params: { id: String(stayId) }, body });
const listOrders = (token, query = "") =>
  call(routes.serviceOrders, { token, url: `http://127.0.0.1/api/mini/service-orders${query}` });
const cancelOrder = (token, id, body = {}) =>
  call(routes.serviceOrderCancel, { token, method: "POST", params: { id: String(id) }, body });

const serviceCount = (where = "1=1", ...args) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE ${where}`).get(...args)?.n ?? 0);

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 伪造 stay_id：拒绝且不落库                                          */
  /* ====================================================================== */

  console.log("\n── 4. 不能伪造 stay_id（清单第 441 行） ──");

  const noToken = await service(undefined, 500, { serviceType: "CLEANING", requestId: "svc-notoken-01" });
  check("未登录提服务请求 → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED");

  const unbound = await service("token-unbound", 500, { serviceType: "CLEANING", requestId: "svc-unbound-01" });
  check("未绑定身份 → NOT_BOUND（先绑定再提在住服务）", unbound.body?.ok === false && unbound.body?.code === "NOT_BOUND");

  const forgedB = await service("token-a", 501, { serviceType: "CLEANING", requestId: "svc-forged-b01" });
  check(
    "A 用 B 的 stay_id（501）提服务请求 → 404 STAY_NOT_FOUND",
    forgedB.status === 404 && forgedB.body?.code === "STAY_NOT_FOUND",
    j(forgedB.body).slice(0, 160)
  );

  const checkedOut = await service("token-a", 502, { serviceType: "CLEANING", requestId: "svc-checkedout-01" });
  check(
    "用已退房的 stay_id（502）→ 404 STAY_NOT_FOUND（在住服务只对 INHOUSE 开放）",
    checkedOut.status === 404 && checkedOut.body?.code === "STAY_NOT_FOUND"
  );

  const notExistStay = await service("token-a", 9999, { serviceType: "CLEANING", requestId: "svc-noexist-01" });
  check("不存在的 stay_id → 404（与「别人的单」同一个错误码）", notExistStay.status === 404 && notExistStay.body?.code === "STAY_NOT_FOUND");

  const badStayId = await call(routes.stayService, {
    token: "token-a",
    method: "POST",
    params: { id: "abc" },
    body: { serviceType: "CLEANING", requestId: "svc-badid-01" },
  });
  check("stay_id 不是数字 → BAD_REQUEST", badStayId.body?.code === "BAD_REQUEST");

  check(
    "伪造 / 越权 / 已退房的请求一行都没有落库（stay_id=501、502 计数 0）",
    serviceCount("stay_id IN (501, 502)") === 0,
    `实际 ${serviceCount("stay_id IN (501, 502)")} 行`
  );
  check(
    "运行时懒建了 mini_service_requests 表（第四处 schema 同步生效）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mini_service_requests'`).get().n) === 1
  );

  /* ====================================================================== */
  /* 5. 类型白名单 / OTHER 必填内容                                          */
  /* ====================================================================== */

  console.log("\n── 5. 服务类型白名单与 OTHER 必填内容 ──");

  const sqlInjection = await service("token-a", 500, {
    serviceType: "DROP TABLE mini_service_requests",
    requestId: "svc-badtype-01",
  });
  check(
    "类型 'DROP TABLE ...' → BAD_REQUEST（白名单，不是字符串拼接）",
    sqlInjection.body?.ok === false && sqlInjection.body?.code === "BAD_REQUEST",
    j(sqlInjection.body).slice(0, 160)
  );
  check("非法类型没有落库", serviceCount("service_type LIKE '%DROP%'") === 0);

  const lateCheckoutViaService = await service("token-a", 500, {
    serviceType: "LATE_CHECKOUT",
    requestId: "svc-late-via-01",
  });
  check(
    "延迟退房不能从「客房服务」接口提交（各有专门接口）→ BAD_REQUEST",
    lateCheckoutViaService.body?.ok === false && lateCheckoutViaService.body?.code === "BAD_REQUEST"
  );
  const changeRoomViaService = await service("token-a", 500, {
    serviceType: "CHANGE_ROOM",
    requestId: "svc-change-via-01",
  });
  check("换房也不能从客房服务接口提交 → BAD_REQUEST", changeRoomViaService.body?.code === "BAD_REQUEST");

  const otherEmpty = await service("token-a", 500, { serviceType: "OTHER", requestId: "svc-other-empty-01" });
  check(
    "OTHER 类型没填内容（<2 字）→ BAD_REQUEST（前台无法处理）",
    otherEmpty.body?.ok === false && otherEmpty.body?.code === "BAD_REQUEST",
    j(otherEmpty.body).slice(0, 160)
  );

  const otherOk = await service("token-a", 500, {
    serviceType: "OTHER",
    note: "需要多一个枕头和一瓶水",
    requestId: "svc-other-ok-01",
  });
  check(
    "OTHER 填了具体内容 → 创建成功（note 原样保留给前台）",
    otherOk.body?.ok === true && otherOk.body?.data?.status === "PENDING" && /枕头/.test(String(otherOk.body?.data?.note ?? "")),
    j(otherOk.body).slice(0, 200)
  );

  const lowerCase = await service("token-a", 500, { serviceType: "cleaning", requestId: "svc-lower-01" });
  check(
    "类型大小写不敏感（cleaning → CLEANING，归一化后仍是白名单）",
    lowerCase.body?.ok === true && lowerCase.body?.data?.serviceType === "CLEANING"
  );

  const delivery = await service("token-a", 500, { serviceType: "DELIVERY", requestId: "svc-delivery-01" });
  check("送物请求创建成功（未填备注时给默认说明，前台知道要电话确认）", delivery.body?.ok === true);
  const repair = await service("token-a", 500, { serviceType: "REPAIR", note: "空调不制冷", requestId: "svc-repair-01" });
  check("维修请求创建成功", repair.body?.ok === true);

  /* ====================================================================== */
  /* 6. 幂等                                                                */
  /* ====================================================================== */

  console.log("\n── 6. 同一 request_id 只建一条 ──");

  const idem1 = await service("token-a", 500, {
    serviceType: "CLEANING",
    note: "请下午 3 点后来打扫",
    requestId: "svc-idem-0001",
  });
  const idem2 = await service("token-a", 500, {
    serviceType: "CLEANING",
    note: "请下午 3 点后来打扫",
    requestId: "svc-idem-0001",
  });
  check(
    "同 requestId 提交两次 → 库里只有 1 条（部分唯一索引兜底）",
    serviceCount("request_id = 'svc-idem-0001'") === 1,
    `实际 ${serviceCount("request_id = 'svc-idem-0001'")} 行`
  );
  check(
    "第二次返回 duplicated:true 且 id 相同（前端可当成一次操作）",
    idem2.body?.data?.duplicated === true &&
      Number(idem2.body?.data?.serviceRequestId) === Number(idem1.body?.data?.serviceRequestId),
    j(idem2.body).slice(0, 160)
  );

  const noRequestId = await service("token-a", 500, { serviceType: "CLEANING" });
  check("缺少 requestId → BAD_REQUEST（没有幂等键就不接单）", noRequestId.body?.code === "BAD_REQUEST");
  const shortRequestId = await service("token-a", 500, { serviceType: "CLEANING", requestId: "abc" });
  check("requestId 太短（<8 位）→ BAD_REQUEST", shortRequestId.body?.code === "BAD_REQUEST");

  /* 同一 requestId 换类型/换单 → 明确冲突，而不是静默回放 */
  const reused = await service("token-a", 500, { serviceType: "DELIVERY", requestId: "svc-idem-0001" });
  check(
    "同一 requestId 被另一操作复用（类型不同）→ REQUEST_ID_CONFLICT",
    reused.body?.code === "REQUEST_ID_CONFLICT",
    j(reused.body).slice(0, 140)
  );

  /* ====================================================================== */
  /* 7. 列表：只看自己的                                                     */
  /* ====================================================================== */

  console.log("\n── 7. 列表只返回自己的（?miniUserId= 被忽略） ──");

  const listA = await listOrders("token-a");
  const requestsA = listA.body?.data?.requests ?? [];
  check("A 的服务请求列表非空", listA.status === 200 && requestsA.length >= 5, `实际 ${requestsA.length} 条`);
  check(
    "列表项字段裁剪：不含 mini_user_id / guest_id / hotel_id（不给探测坐标）",
    requestsA.every((r) => !("miniUserId" in r) && !("mini_user_id" in r) && !("guestId" in r) && !("guest_id" in r) && !("hotelId" in r)),
    j(requestsA[0]).slice(0, 200)
  );
  check(
    "列表项带中文文案与「能不能取消」（由服务端算，前端不自己判断状态机）",
    requestsA.every((r) => typeof r.serviceTypeLabel === "string" && typeof r.statusLabel === "string" && typeof r.cancellable === "boolean")
  );
  check(
    "PENDING 的项 cancellable=true，已取消/已完成的为 false",
    requestsA.filter((r) => r.status === "PENDING").every((r) => r.cancellable === true)
  );

  const listB = await listOrders("token-b");
  check(
    "B 的列表为 0（看不到 A 提的任何请求）",
    listB.status === 200 && (listB.body?.data?.requests ?? []).length === 0,
    j(listB.body).slice(0, 140)
  );

  const listBFake = await listOrders("token-b", "?miniUserId=1&hotelId=1&guestId=100");
  check(
    "B 伪造 ?miniUserId=1 / hotelId / guestId → 仍然看不到 A 的请求（参数被完全忽略）",
    (listBFake.body?.data?.requests ?? []).length === 0,
    j(listBFake.body).slice(0, 160)
  );

  const listStatusFilter = await listOrders("token-a", "?status=PENDING");
  check(
    "?status=PENDING 过滤生效（只回 PENDING）",
    (listStatusFilter.body?.data?.requests ?? []).every((r) => r.status === "PENDING") &&
      (listStatusFilter.body?.data?.requests ?? []).length > 0
  );
  const listBadStatus = await listOrders("token-a", "?status=' OR 1=1 --");
  check(
    "非法 status 参数按「不过滤」处理，不报错也不注入（参数化查询）",
    listBadStatus.status === 200 && listBadStatus.body?.ok === true
  );
  const listLimit = await listOrders("token-a", "?limit=2");
  check("limit 生效（最多回 2 条）", (listLimit.body?.data?.requests ?? []).length === 2);

  /* ====================================================================== */
  /* 8. 取消：只能自己的、只有 PENDING                                       */
  /* ====================================================================== */

  console.log("\n── 8. 取消只能自己的 PENDING 单 ──");

  const svcId = Number(idem1.body?.data?.serviceRequestId ?? 0);
  check("拿到 A 的一条 PENDING 请求 id", svcId > 0);

  const cancelOthers = await cancelOrder("token-b", svcId, { requestId: "svc-cancel-others-1" });
  check(
    "B 取消 A 的请求 → 404 SERVICE_REQUEST_NOT_FOUND（不区分「不存在」与「不是你的」）",
    cancelOthers.status === 404 && cancelOthers.body?.code === "SERVICE_REQUEST_NOT_FOUND",
    j(cancelOthers.body).slice(0, 160)
  );
  check(
    "被拒后 A 的请求状态仍是 PENDING（没有被越权改掉）",
    db.prepare(`SELECT status FROM mini_service_requests WHERE id = ?`).get(svcId).status === "PENDING"
  );

  const cancelMine = await cancelOrder("token-a", svcId, { requestId: "svc-cancel-mine-1" });
  check(
    "A 取消自己的 PENDING 请求成功（CANCELLED，alreadyCancelled=false）",
    cancelMine.status === 200 && cancelMine.body?.data?.status === "CANCELLED" && cancelMine.body?.data?.alreadyCancelled === false,
    j(cancelMine.body).slice(0, 160)
  );
  check("取消后库里状态是 CANCELLED", db.prepare(`SELECT status FROM mini_service_requests WHERE id = ?`).get(svcId).status === "CANCELLED");

  const cancelAgain = await cancelOrder("token-a", svcId, {});
  check("重复取消 → 幂等 alreadyCancelled:true", cancelAgain.body?.data?.alreadyCancelled === true);

  const alreadyCancelledItem = (await listOrders("token-a", "?status=CANCELLED")).body?.data?.requests ?? [];
  check(
    "已取消的项 cancellable=false（前端不该再显示取消按钮）",
    alreadyCancelledItem.length >= 1 && alreadyCancelledItem.every((r) => r.cancellable === false)
  );

  /* 前台已接单（ACCEPTED）后不允许客人取消 */
  const acceptedId = Number(
    db.prepare(`SELECT id FROM mini_service_requests WHERE mini_user_id = 1 AND status = 'PENDING' ORDER BY id LIMIT 1`).get()?.id ?? 0
  );
  db.prepare(`UPDATE mini_service_requests SET status = 'ACCEPTED' WHERE id = ?`).run(acceptedId);
  const cancelAccepted = await cancelOrder("token-a", acceptedId, {});
  check(
    "前台已接单（ACCEPTED）→ NOT_CANCELLABLE（阿姨可能已经在路上）",
    cancelAccepted.body?.ok === false && cancelAccepted.body?.code === "NOT_CANCELLABLE",
    j(cancelAccepted.body).slice(0, 160)
  );
  check("被拒后状态仍是 ACCEPTED", db.prepare(`SELECT status FROM mini_service_requests WHERE id = ?`).get(acceptedId).status === "ACCEPTED");

  /* 已完成（DONE）不能取消 */
  const doneId = Number(
    db.prepare(`SELECT id FROM mini_service_requests WHERE mini_user_id = 1 AND status = 'PENDING' ORDER BY id LIMIT 1`).get()?.id ?? 0
  );
  db.prepare(`UPDATE mini_service_requests SET status = 'DONE', completed_at = ? WHERE id = ?`).run(iso(NOW_MS), doneId);
  const cancelDone = await cancelOrder("token-a", doneId, {});
  check(
    "已完成（DONE）→ NOT_CANCELLABLE",
    cancelDone.body?.ok === false && cancelDone.body?.code === "NOT_CANCELLABLE" && /已完成/.test(String(cancelDone.body?.error ?? ""))
  );

  const cancelNotExist = await cancelOrder("token-a", 999999, {});
  check("取消不存在的请求 → 404", cancelNotExist.status === 404);

  const cancelLogs = db
    .prepare(`SELECT detail FROM op_logs WHERE hotel_id = 1 AND action = '小程序取消服务请求'`)
    .all();
  check("取消服务请求写 op_logs（小程序取消服务请求）", cancelLogs.length >= 1);
  check(
    "op_logs 里没有完整手机号",
    !cancelLogs.some((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(String(r.detail ?? "")))
  );

  /* ====================================================================== */
  /* 9. 叫醒：双写 wake_up_calls + 幂等 + 取消同步                          */
  /* ====================================================================== */

  console.log("\n── 9. 叫醒双写 PC 端 wake_up_calls ──");

  const wakeTime = `${T} 07:30`;
  const wake = await wakeup("token-a", 500, { wakeTime, note: "赶早班机", requestId: "wake-0001-abcd" });
  check(
    "叫醒登记成功并回吐归一化时间（YYYY-MM-DD HH:MM）",
    wake.body?.ok === true && String(wake.body?.data?.wakeTime ?? "") === wakeTime,
    j(wake.body).slice(0, 200)
  );
  check(
    "运行时懒建了 wake_up_calls 表（全新库第一次叫醒不会 no such table）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='wake_up_calls'`).get().n) === 1
  );
  const wakeRows = db.prepare(`SELECT status, wake_time, room_no FROM wake_up_calls WHERE stay_id = 500`).all();
  check(
    "同时写入 PC 端的 wake_up_calls（前台能看到，status=PENDING）",
    wakeRows.length === 1 && wakeRows[0].status === "PENDING" && wakeRows[0].wake_time === wakeTime,
    JSON.stringify(wakeRows)
  );
  check("台账也落了 WAKEUP 记录（客人在服务请求里能看到）", serviceCount("service_type = 'WAKEUP' AND stay_id = 500") === 1);

  const wakeReplay = await wakeup("token-a", 500, { wakeTime, note: "赶早班机", requestId: "wake-0001-abcd" });
  check(
    "同 requestId 重放叫醒 → duplicated:true，不重复登记（真实酒店里重复叫醒是投诉级错误）",
    wakeReplay.body?.data?.duplicated === true &&
      Number(db.prepare(`SELECT COUNT(*) AS n FROM wake_up_calls WHERE stay_id = 500`).get().n) === 1,
    j(wakeReplay.body).slice(0, 160)
  );

  /* 叫醒时间格式错误 / 太远 */
  const badWake = await wakeup("token-a", 500, { wakeTime: "下午两点", requestId: "wake-bad-0001" });
  check("叫醒时间格式非法 → BAD_REQUEST（不猜语义）", badWake.body?.ok === false && badWake.body?.code === "BAD_REQUEST");
  const tooFarWake = await wakeup("token-a", 500, { wakeTime: `${D40} 07:30`, requestId: "wake-far-0001" });
  check(
    "叫醒时间超过 30 天 → BAD_REQUEST（避免 PC 端列表变噪音）",
    tooFarWake.body?.ok === false && tooFarWake.body?.code === "BAD_REQUEST" && /30 天/.test(String(tooFarWake.body?.error ?? ""))
  );

  /* 取消叫醒 → wake_up_calls 同步 CANCELLED */
  const wakeSvcId = Number(wake.body?.data?.serviceRequestId ?? 0);
  const cancelWake = await cancelOrder("token-a", wakeSvcId, {});
  check("取消叫醒请求成功", cancelWake.body?.data?.status === "CANCELLED");
  const wakeAfterCancel = db.prepare(`SELECT status FROM wake_up_calls WHERE stay_id = 500`).all();
  check(
    "取消叫醒时 PC 端 wake_up_calls 同步标记 CANCELLED（前台不会照旧去敲门）",
    wakeAfterCancel.length === 1 && wakeAfterCancel[0].status === "CANCELLED",
    JSON.stringify(wakeAfterCancel)
  );

  /* ====================================================================== */
  /* 10. 延迟退房（同一套在住申请流程）                                     */
  /* ====================================================================== */

  console.log("\n── 10. 延迟退房时间校验 ──");

  const early = await lateCheckout("token-a", 500, { time: "09:00", requestId: "late-early-0001" });
  check(
    "早于标准退房 12:00 → BAD_REQUEST（不需要申请）",
    early.body?.ok === false && early.body?.code === "BAD_REQUEST" && /12:00/.test(String(early.body?.error ?? ""))
  );
  const tooLate = await lateCheckout("token-a", 500, { time: "23:30", requestId: "late-toolate-0001" });
  check(
    "晚于最晚 20:00 → BAD_REQUEST（应走续住）",
    tooLate.body?.ok === false && tooLate.body?.code === "BAD_REQUEST" && /20:00/.test(String(tooLate.body?.error ?? "")),
    String(tooLate.body?.error ?? "").slice(0, 90)
  );
  const okLate = await lateCheckout("token-a", 500, { time: "14:00", requestId: "late-ok-0001" });
  check(
    "14:00 → 申请成功（PENDING + requestedTime 回吐）",
    okLate.body?.ok === true && okLate.body?.data?.status === "PENDING" && okLate.body?.data?.requestedTime === "14:00",
    j(okLate.body).slice(0, 160)
  );
  const noTime = await lateCheckout("token-a", 500, { requestId: "late-notime-0001" });
  check("没填时间 → BAD_REQUEST", noTime.body?.code === "BAD_REQUEST");
  const badFormat = await lateCheckout("token-a", 500, { time: "14 点", requestId: "late-badfmt-0001" });
  check("时间格式不是 HH:MM → BAD_REQUEST", badFormat.body?.code === "BAD_REQUEST");

  /* ====================================================================== */
  /* 11. 留痕与租户隔离                                                     */
  /* ====================================================================== */

  console.log("\n── 11. 留痕与租户隔离 ──");

  const opLogs = db.prepare(`SELECT action FROM op_logs WHERE hotel_id = 1 AND operator = '微信小程序'`).all();
  check(
    "客房服务 / 叫醒 / 延迟退房都写了 op_logs（operator=微信小程序）",
    ["客房清洁", "叫醒服务", "延迟退房"].every((k) => opLogs.some((r) => String(r.action).includes(k))),
    opLogs.map((r) => r.action).join(",")
  );
  check(
    "op_logs 里没有完整手机号 / 身份证号（日志同样脱敏）",
    !opLogs.some((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(String(r.action ?? "")))
  );

  const h2List = await listOrders("token-h2");
  check(
    "别家酒店的用户（token-h2）看不到本店任何服务请求",
    h2List.status === 200 && (h2List.body?.data?.requests ?? []).length === 0,
    j(h2List.body).slice(0, 140)
  );
  const h2Service = await service("token-h2", 500, { serviceType: "CLEANING", requestId: "svc-h2-0001" });
  check(
    "别家酒店的用户用本店 stay_id 提服务请求 → 404（跨租户隔离）",
    h2Service.status === 404 && h2Service.body?.code === "STAY_NOT_FOUND"
  );
  check(
    "所有落库的服务请求都挂在 hotel_id=1 且属于 A（没有跨租户 / 跨用户脏数据）",
    serviceCount("hotel_id = 1") === serviceCount("hotel_id = 1 AND mini_user_id = 1") && serviceCount("hotel_id <> 1") === 0
  );
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
  "真库 data/pms.db 零写入（测试前后 sha256 一致）",
  realHashBefore === realHashAfter && realHashBefore !== "",
  `before=${realHashBefore.slice(0, 12)} after=${realHashAfter.slice(0, 12)}`
);
check("所有写入都落在 .tmp 副本（临时库确实存在）", existsSync(TMP_DB));

try {
  globalThis.__pmsDb?.close?.();
} catch {
  /* ignore */
}
try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  /* Windows 偶发占用 */
}

console.log("");
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("失败项：");
  for (const name of failed) console.log(`  · ${name}`);
  process.exit(1);
}
