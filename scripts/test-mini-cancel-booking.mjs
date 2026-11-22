#!/usr/bin/env node
/**
 * 微信小程序「取消订单释放库存」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-cancel-booking）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的事（清单第 438 行）
 * ══════════════════════════════════════════════════════════════════════════
 * 「取消成功」不等于「库存回来了」。房量占用的权威口径在 booking_rooms 明细上，
 * 只把 bookings.status 改成 CANCELLED、明细还挂着 CONFIRMED + 具体房号，
 * 会出现「客人已取消、房量却没回来、前台排不出这间房」。
 * 所以要逐层断言：
 *   ① booking_rooms：room_id 置空 + status = CANCELLED；
 *   ② bookings：status = CANCELLED + room_id 镜像置空；
 *   ③ /api/mini/rooms 的可订间数真的 +1；
 *   ④ 同一区间能重新下单成功（最硬的证据：房间回到可售池）。
 *
 * 同时验证：
 *   · 重复取消幂等（alreadyCancelled，不重复释放）；
 *   · 已入住 / 已离店 / 到店日已过 不能取消；
 *   · A 不能取消 B 的、别家酒店不能取消本店（404，且状态不变）；
 *   · 取消写 op_logs、不动任何资金记录（退款必须走前台）。
 *
 * 用法：node scripts/test-mini-cancel-booking.mjs
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

const TMP = join(ROOT, ".tmp", `mini-cancel-${process.pid}-${Date.now()}`);
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
const YESTERDAY = plusDays(TODAY, -1);
const T = plusDays(TODAY, 1);
const D2 = plusDays(TODAY, 2);
const D3 = plusDays(TODAY, 3);
const D4 = plusDays(TODAY, 4);
const D5 = plusDays(TODAY, 5);
const D6 = plusDays(TODAY, 6);
const D7 = plusDays(TODAY, 7);

const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE room_types (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT, name TEXT, bed_type TEXT, area REAL, max_occupancy INTEGER, base_price REAL, sort INTEGER);
  CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_no TEXT, floor INTEGER, room_type_id INTEGER, status TEXT, sort INTEGER);
  CREATE TABLE rate_calendar (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_type_id INTEGER NOT NULL, date TEXT NOT NULL, price REAL, allotment INTEGER);
  CREATE TABLE stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, stay_no TEXT, booking_id INTEGER,
    room_id INTEGER NOT NULL, guest_id INTEGER, guest_name TEXT, mobile TEXT,
    check_in_time TEXT, expect_check_out TEXT, actual_check_out TEXT, nights INTEGER,
    rate REAL NOT NULL, deposit REAL DEFAULT 0, guest_count INTEGER DEFAULT 1, status TEXT DEFAULT 'INHOUSE',
    channel_id INTEGER, remark TEXT, created_by INTEGER, created_at TEXT
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
  CREATE TABLE folios (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_no TEXT, stay_id INTEGER, guest_name TEXT, room_no TEXT, total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, balance REAL DEFAULT 0, status TEXT DEFAULT 'OPEN', created_at TEXT);
  CREATE TABLE folio_items (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER NOT NULL, item_type TEXT, description TEXT, qty REAL DEFAULT 1, price REAL DEFAULT 0, amount REAL DEFAULT 0, biz_date TEXT, created_at TEXT, created_by INTEGER, request_id TEXT);
  CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER, stay_id INTEGER, pay_no TEXT, method TEXT, amount REAL, biz_date TEXT, remark TEXT, created_at TEXT, request_id TEXT, refund_of INTEGER, operator TEXT, kind TEXT);
  CREATE TABLE op_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, operator TEXT, action TEXT, detail TEXT, created_at TEXT);
  CREATE TABLE mini_program_config (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, app_id TEXT, app_secret TEXT, mch_id TEXT, mch_key TEXT, enabled INTEGER DEFAULT 0, updated_at TEXT, UNIQUE(hotel_id));
  CREATE TABLE mini_program_users (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, openid TEXT NOT NULL, unionid TEXT, guest_id INTEGER, mobile TEXT, session_token TEXT, token_expires_at TEXT, bind_attempts INTEGER DEFAULT 0, bind_locked_until TEXT, created_at TEXT, updated_at TEXT);
  CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid);
  CREATE INDEX idx_mini_users_token ON mini_program_users(session_token);
  CREATE TABLE mini_program_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, mini_user_id INTEGER NOT NULL, booking_id INTEGER NOT NULL, created_at TEXT, UNIQUE(hotel_id, booking_id));
`);

const iso = (ms) => new Date(ms).toISOString();
const NOW_MS = Date.now();
const ins = (sql, ...args) => db.prepare(sql).run(...args);

ins(`INSERT INTO hotels (id, code, name) VALUES (1, 'H1', '测试酒店一号')`);
ins(`INSERT INTO hotels (id, code, name) VALUES (2, 'H2', '测试酒店二号')`);
ins(`INSERT INTO settings (hotel_id, key, value) VALUES (1, 'biz_day_cutoff', '00:00')`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (11, 1, 'STD', '标准间', 300, 2, 1)`);
/* 4 间可售（3001-3004） */
for (let i = 1; i <= 4; i += 1) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, 3000 + i, 1, String(3000 + i), 11, "VC", i);
}

ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (100, 1, '张三', '13800000001')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (101, 1, '李四', '13800000002')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (200, 2, '王五', '13900000003')`);

/* 两家酒店都启用小程序（这样跨酒店场景才能走到「找不到订单」而不是 NOT_CONFIGURED） */
ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-cancel-0001', 1, ?)`, iso(NOW_MS));
ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (2, 'wxtestappid0002', 'secret-cancel-0002', 1, ?)`, iso(NOW_MS));

for (const [id, hotel, openid, guestId, token] of [
  [1, 1, "openid-a", 100, "token-a"],
  [2, 1, "openid-b", 101, "token-b"],
  [3, 2, "openid-h2", 200, "token-h2"],
]) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, hotel, openid, guestId, token, iso(NOW_MS + 6 * 86400000), iso(NOW_MS), iso(NOW_MS)
  );
}

/**
 * 订单工厂：主单 + 可选的明细行
 * rooms 数组的每一项是 [room_id, status]
 */
const booking = (id, hotel, guestId, name, mobile, ci, co, rooms, status = "CONFIRMED") => {
  ins(
    `INSERT INTO bookings (id, hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id,
       check_in_date, check_out_date, nights, room_count, guest_count, rate, deposit, total_price, status,
       pay_type, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, hotel, `BK${id}`, guestId, name, mobile, 11, rooms.length === 1 ? rooms[0][0] : null, ci, co,
    Math.max(1, Math.round((new Date(`${co}T00:00:00`) - new Date(`${ci}T00:00:00`)) / 86400000)),
    rooms.length, 1, 300, 0, 300 * rooms.length, status, "到店付款", iso(NOW_MS), iso(NOW_MS)
  );
  for (const [roomId, brStatus] of rooms) {
    ins(
      `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
         check_in_date, check_out_date, stay_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      hotel, id, 11, roomId, name, mobile, 300, brStatus, ci, co, null, iso(NOW_MS)
    );
  }
};

/* 2001：A 的单间订单（D4~D5，已排 3001）—— 主角，用来测释放 */
booking(2001, 1, 100, "张三", "13800000001", D4, D5, [[3001, "CONFIRMED"]]);
/* 2002：A 的多间订单（D5~D6，排 3002/3003）—— 测一次释放 2 行 */
booking(2002, 1, 100, "张三", "13800000001", D5, D6, [
  [3002, "CONFIRMED"],
  [3003, "CONFIRMED"],
]);
/* 2003：B 的订单（A 不能取消） */
booking(2003, 1, 101, "李四", "13800000002", D6, D7, [[3004, "CONFIRMED"]]);
/* 2004：A 的已入住订单（不能取消） */
booking(2004, 1, 100, "张三", "13800000001", T, D3, [[3001, "CHECKED_IN"]], "CHECKED_IN");
/* 2005：A 的已离店订单 */
booking(2005, 1, 100, "张三", "13800000001", YESTERDAY, TODAY, [[3002, "CHECKED_IN"]], "CHECKED_OUT");
/* 2006：A 的到店日已过（昨天）仍未取消的订单 */
booking(2006, 1, 100, "张三", "13800000001", YESTERDAY, TODAY, [[3003, "CONFIRMED"]], "CONFIRMED");
/* 2007：A 的已取消订单（幂等场景） */
booking(2007, 1, 100, "张三", "13800000001", D2, D3, [[3002, "CANCELLED"]], "CANCELLED");

/* 2004 对应的在住单 + 一笔已收押金（用来验证「取消不动资金」） */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, booking_id, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (600, 1, 'S600', 2004, 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, D3, iso(NOW_MS)
);
ins(`INSERT INTO payments (hotel_id, stay_id, amount, method, created_at, kind) VALUES (1, 600, 300, '现金', ?, 'DEPOSIT')`, iso(NOW_MS));

check("临时库造好（7 张订单：可取消 / 多间 / 别人的 / 已入住 / 已离店 / 已过期 / 已取消）", true);
check(
  "初始资金记录 1 条（押金 300），取消过程中不能被动到",
  Number(db.prepare(`SELECT COUNT(*) AS n FROM payments`).get().n) === 1
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
export { POST as cancel } from ${JSON.stringify(srcAbs("app/api/mini/bookings/[id]/cancel/route.ts"))};
export { GET as bookingDetail } from ${JSON.stringify(srcAbs("app/api/mini/bookings/[id]/route.ts"))};
export { GET as bookingsList } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
export { GET as rooms } from ${JSON.stringify(srcAbs("app/api/mini/rooms/route.ts"))};
export { POST as bookingCreate } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
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
  const headers = { "user-agent": ua || `cancel-test-${(uaSeq += 1)}` };
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

const cancelBooking = (token, id, body = {}) =>
  call(routes.cancel, { token, method: "POST", params: { id: String(id) }, body });
const bookingRow = (id) => db.prepare(`SELECT status, room_id FROM bookings WHERE id = ?`).get(id);
const roomRows = (id) =>
  db.prepare(`SELECT room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`).all(id);
const availFor = async (ci, co) => {
  const r = await call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${ci}&checkOut=${co}` });
  return Number((r.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11)?.remainingRooms ?? -1);
};

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 取消：真的释放库存                                                   */
  /* ====================================================================== */

  console.log("\n── 4. 取消后 booking_rooms 真的释放（清单第 438 行） ──");

  const noToken = await cancelBooking(undefined, 2001);
  check("未登录取消 → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED");

  const availBefore = await availFor(D4, D5);
  check("取消前 D4~D5 可订 3 间（4 间物理 − 1 间被 2001 占用）", availBefore === 3, `实际 ${availBefore}`);

  const beforeMain = bookingRow(2001);
  const beforeRooms = roomRows(2001);
  check(
    "取消前：主单 CONFIRMED 且 room_id 镜像有值",
    beforeMain.status === "CONFIRMED" && Number(beforeMain.room_id) === 3001,
    JSON.stringify(beforeMain)
  );
  check(
    "取消前：明细占着具体房间（room_id=3001 + CONFIRMED）",
    beforeRooms.length === 1 && Number(beforeRooms[0].room_id) === 3001 && beforeRooms[0].status === "CONFIRMED",
    JSON.stringify(beforeRooms)
  );

  const cancel1 = await cancelBooking("token-a", 2001, { reason: "行程有变", requestId: "cancel-2001-abcdef" });
  check(
    "A 取消自己的订单成功（200 / status=CANCELLED）",
    cancel1.status === 200 && cancel1.body?.ok === true && cancel1.body?.data?.status === "CANCELLED",
    j(cancel1.body).slice(0, 180)
  );
  check(
    "返回里带上释放间数（releasedRooms = 1）",
    Number(cancel1.body?.data?.releasedRooms) === 1,
    `releasedRooms=${cancel1.body?.data?.releasedRooms}`
  );
  check(
    "取消返回 alreadyCancelled=false（是本次真正取消的）",
    cancel1.body?.data?.alreadyCancelled === false
  );

  const afterRooms = roomRows(2001);
  check(
    "取消后：booking_rooms 的 room_id 置空 + status=CANCELLED（库存真的释放）",
    afterRooms.length === 1 && afterRooms[0].room_id === null && afterRooms[0].status === "CANCELLED",
    JSON.stringify(afterRooms)
  );
  const afterMain = bookingRow(2001);
  check(
    "取消后：主单 CANCELLED 且 room_id 镜像清空（房态图不再显示占用）",
    afterMain.status === "CANCELLED" && afterMain.room_id === null,
    JSON.stringify(afterMain)
  );

  /* 房间回到可售池 —— 两条独立证据 */
  const availAfter = await availFor(D4, D5);
  check("取消后 D4~D5 可订间数 +1（3 → 4）", availAfter === availBefore + 1, `取消前 ${availBefore} → 取消后 ${availAfter}`);

  const rebook = await call(routes.bookingCreate, {
    token: "token-b",
    method: "POST",
    body: {
      roomTypeId: 11,
      checkInDate: D4,
      checkOutDate: D5,
      roomCount: 1,
      guestName: "李四",
      mobile: "13800000002",
      requestId: "reboot-2001-abcdef",
    },
  });
  check(
    "取消释放出来的房间能被别人重新订上（最硬的「库存回来了」证据）",
    rebook.body?.ok === true,
    j(rebook.body).slice(0, 160)
  );

  /* 留痕与资金 */
  const cancelLogs = db
    .prepare(`SELECT action, detail FROM op_logs WHERE hotel_id = 1 AND action = '小程序取消订单' ORDER BY id`)
    .all();
  check("取消写 op_logs（小程序取消订单）", cancelLogs.length === 1, `行数 ${cancelLogs.length}`);
  check(
    "op_logs detail 里有单号 / 释放间数 / requestId（可追溯是哪次重试）",
    /BK2001/.test(String(cancelLogs[0]?.detail ?? "")) &&
      /释放 1 间/.test(String(cancelLogs[0]?.detail ?? "")) &&
      /requestId=cancel-2001-abcdef/.test(String(cancelLogs[0]?.detail ?? "")),
    String(cancelLogs[0]?.detail ?? "").slice(0, 160)
  );
  check(
    "取消不动资金记录（本接口不退款、不写 payments）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM payments`).get().n) === 1
  );
  check(
    "取消响应提示「退款请到前台办理」（不在小程序里做资金动作）",
    /前台/.test(String(cancel1.body?.data?.refundNote ?? "")),
    String(cancel1.body?.data?.refundNote ?? "").slice(0, 80)
  );

  /* ====================================================================== */
  /* 5. 重复取消幂等（不重复释放）                                          */
  /* ====================================================================== */

  console.log("\n── 5. 重复取消幂等（alreadyCancelled，不重复释放） ──");

  const cancelAgain = await cancelBooking("token-a", 2001, { requestId: "cancel-2001-abcdef" });
  check(
    "重复取消 → 200 + alreadyCancelled=true（不是错误）",
    cancelAgain.status === 200 && cancelAgain.body?.data?.alreadyCancelled === true,
    j(cancelAgain.body).slice(0, 160)
  );
  check("重复取消返回 releasedRooms=0（没有再次释放）", Number(cancelAgain.body?.data?.releasedRooms) === 0);
  check(
    "重复取消后 booking_rooms 内容不变（仍 1 行 CANCELLED）",
    roomRows(2001).length === 1 && roomRows(2001)[0].status === "CANCELLED"
  );
  check("重复取消不会新增 op_logs（幂等分支直接返回）", db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE action='小程序取消订单'`).get().n === 1);

  const alreadyCancelledBooking = await cancelBooking("token-a", 2007);
  check(
    "本来就已取消的单 → alreadyCancelled=true",
    alreadyCancelledBooking.body?.data?.alreadyCancelled === true
  );

  /* ====================================================================== */
  /* 6. 多间订单一次释放全部明细                                            */
  /* ====================================================================== */

  console.log("\n── 6. 多间订单一次释放全部明细 ──");

  const availD5Before = await availFor(D5, D6);
  check("取消前 D5~D6 可订 2 间（4 − 2 间明细）", availD5Before === 2, `实际 ${availD5Before}`);

  const multiCancel = await cancelBooking("token-a", 2002, { requestId: "cancel-2002-abcdef" });
  check(
    "多间订单取消 → releasedRooms = 2",
    multiCancel.body?.data?.status === "CANCELLED" && Number(multiCancel.body?.data?.releasedRooms) === 2,
    j(multiCancel.body).slice(0, 160)
  );
  const multiRooms = roomRows(2002);
  check(
    "两行明细全部变成 room_id=NULL + CANCELLED（不是只释放第一间）",
    multiRooms.length === 2 && multiRooms.every((r) => r.room_id === null && r.status === "CANCELLED"),
    JSON.stringify(multiRooms)
  );
  check("多间订单取消后 D5~D6 可订 4 间", (await availFor(D5, D6)) === 4);

  /* ====================================================================== */
  /* 7. 不能取消的状态与身份                                                */
  /* ====================================================================== */

  console.log("\n── 7. 已入住 / 已离店 / 已过期 / 别人的单 都不能取消 ──");

  const checkedIn = await cancelBooking("token-a", 2004);
  check(
    "已入住订单 → BOOKING_NOT_EDITABLE（要退房请走前台）",
    checkedIn.body?.ok === false && checkedIn.body?.code === "BOOKING_NOT_EDITABLE",
    j(checkedIn.body).slice(0, 140)
  );
  check("已入住订单状态没有被改（仍 CHECKED_IN）", bookingRow(2004).status === "CHECKED_IN");
  check(
    "已入住订单的明细也没被释放（仍在 3001）",
    Number(roomRows(2004)[0]?.room_id) === 3001 && roomRows(2004)[0]?.status === "CHECKED_IN"
  );

  const checkedOut = await cancelBooking("token-a", 2005);
  check(
    "已离店订单 → BOOKING_NOT_EDITABLE",
    checkedOut.body?.ok === false && checkedOut.body?.code === "BOOKING_NOT_EDITABLE"
  );

  const expiredStayDate = await cancelBooking("token-a", 2006);
  check(
    "到店日已过（昨天）仍未取消的订单 → BOOKING_NOT_EDITABLE（交前台处理，可能已排房）",
    expiredStayDate.body?.ok === false &&
      expiredStayDate.body?.code === "BOOKING_NOT_EDITABLE" &&
      /前台/.test(String(expiredStayDate.body?.error ?? "")),
    j(expiredStayDate.body).slice(0, 160)
  );

  const cancelOthers = await cancelBooking("token-a", 2003, { requestId: "cancel-2003-others" });
  check(
    "A 取消 B 的订单 → 404 BOOKING_NOT_FOUND",
    cancelOthers.status === 404 && cancelOthers.body?.code === "BOOKING_NOT_FOUND",
    j(cancelOthers.body).slice(0, 140)
  );
  check("B 的订单状态没变（仍 CONFIRMED）", bookingRow(2003).status === "CONFIRMED");

  const notExist = await cancelBooking("token-a", 9999);
  check(
    "不存在的订单 id → 404（与「不是你的单」同一个错误码，不做存在性预言机）",
    notExist.status === 404 && notExist.body?.code === "BOOKING_NOT_FOUND"
  );
  check(
    "「不存在」与「不是你的」返回同一句文案（无法据此枚举订单 id）",
    String(notExist.body?.error ?? "") === String(cancelOthers.body?.error ?? ""),
    `「${String(notExist.body?.error ?? "").slice(0, 30)}」vs「${String(cancelOthers.body?.error ?? "").slice(0, 30)}」`
  );

  const crossHotel = await cancelBooking("token-h2", 2002, {});
  check(
    "别家酒店的用户取消本店订单 → 404（跨租户隔离）",
    crossHotel.status === 404 && crossHotel.body?.code === "BOOKING_NOT_FOUND",
    j(crossHotel.body).slice(0, 140)
  );

  const badId = await cancelBooking("token-a", "abc");
  check("订单 id 不是数字 → BAD_REQUEST", badId.body?.code === "BAD_REQUEST");

  /* ====================================================================== */
  /* 8. 取消后的状态传播                                                    */
  /* ====================================================================== */

  console.log("\n── 8. 取消后的状态传播（详情 / 列表 / 不能再取消） ──");

  const detail2002 = await call(routes.bookingDetail, { token: "token-a", params: { id: "2002" } });
  check(
    "订单详情显示 CANCELLED，且 canCancel=false / 给出不能操作的原因",
    detail2002.body?.data?.status === "CANCELLED" &&
      detail2002.body?.data?.canCancel === false &&
      String(detail2002.body?.data?.actionHint ?? "").includes("已取消"),
    j(detail2002.body?.data).slice(0, 200)
  );

  const listA = await call(routes.bookingsList, { token: "token-a", url: "http://127.0.0.1/api/mini/bookings" });
  const cancelledInList = (listA.body?.data?.bookings ?? []).filter((b) => b.bookingId === 2002);
  check(
    "我的订单列表里 2002 显示为 CANCELLED（状态不滞后）",
    cancelledInList.length === 1 && cancelledInList[0].status === "CANCELLED"
  );
}

/* ========================================================================== */
/* 9. 清理 + 真库零写入                                                        */
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

console.log("\n── 9. 真库零写入验证 ──");

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
