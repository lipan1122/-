#!/usr/bin/env node
/**
 * 微信小程序「续住与换房」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-extend-stay）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的事（清单第 439-440 行）
 * ══════════════════════════════════════════════════════════════════════════
 * 续住：
 *   · **必须检查远期冲突**：续住的本质是把这间房在新增日期上再卖一次。
 *     只看「现在有人住」就放行，会出现 22 号那间房同时卖给 A（续住）和 B（预订）——
 *     客人到店才发现没房。冲突区间是半开区间 [原离店日, 新离店日)，
 *     相等不算冲突（12:00 退房 / 14:00 入住可以接续）。
 *   · 维修房（OOO）/ 锁房（LOCK）不能续住；
 *   · 单次最多 30 晚；
 *   · 房费按入住单上的 rate 由服务端算，逐晚补明细，账单统一重算。
 * 换房：
 *   · **不能跨酒店**（拿别家酒店的 roomId 一律 ROOM_NOT_FOUND，不做房间号探测器）；
 *   · 不能换成本房；
 *   · 目标房间必须 VC / VD（空净 / 空脏）；
 *   · 目标房间在客人剩余在住期内不能已有占用；
 *   · 只建 PENDING 申请，不直接改 stays.room_id（现场处置权在前台）。
 * 幂等：同一个 requestId 重放只处理一次（同一个 requestId 不能换内容重用）。
 *
 * 用法：node scripts/test-mini-extend-stay.mjs
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

const TMP = join(ROOT, ".tmp", `mini-extend-${process.pid}-${Date.now()}`);
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
const D3 = plusDays(TODAY, 3);
const D4 = plusDays(TODAY, 4);
const D34 = plusDays(TODAY, 34);
const D35 = plusDays(TODAY, 35);

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
    channel_id INTEGER, remark TEXT, channel_order_no TEXT, breakfast INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT
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
  CREATE TABLE folio_items (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER NOT NULL, item_type TEXT NOT NULL, description TEXT, qty REAL DEFAULT 1, price REAL DEFAULT 0, amount REAL DEFAULT 0, biz_date TEXT, created_at TEXT, created_by INTEGER, request_id TEXT);
  CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER, stay_id INTEGER, amount REAL, created_at TEXT);
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
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (21, 2, 'STD2', '别家标准间', 200, 2, 1)`);

/**
 * 房间布局（换房断言逐个对应一个状态）：
 *   3001 OC  A 在住（续住对象）
 *   3002 VC  可换入
 *   3003 VD  可换入（空脏也允许，前台会先打扫）
 *   3004 OC  有人住/已占 → 不可换入
 *   3005 OOO 维修 → 不可换入、不可续住
 *   3006 LOCK 锁房 → 不可换入、不可续住
 *   3007 VC  空房，但剩余在住期内已被预订 → 换房应冲突
 *   3008 OC  B 在住（别人的单）
 *   9001 VC  别家酒店 → 换房应 ROOM_NOT_FOUND
 */
for (const [id, hotel, no, type, status] of [
  [3001, 1, "3001", 11, "OC"],
  [3002, 1, "3002", 11, "VC"],
  [3003, 1, "3003", 11, "VD"],
  [3004, 1, "3004", 11, "OC"],
  [3005, 1, "3005", 11, "OOO"],
  [3006, 1, "3006", 11, "LOCK"],
  [3007, 1, "3007", 11, "VC"],
  [3008, 1, "3008", 11, "OC"],
  [9001, 2, "9001", 21, "VC"],
]) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, id, hotel, no, type, status, id);
}

ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (100, 1, '张三', '13800000001')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (101, 1, '李四', '13800000002')`);

ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-extend-0001', 1, ?)`, iso(NOW_MS));
ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (2, 'wxtestappid0002', 'secret-extend-0002', 1, ?)`, iso(NOW_MS));

for (const [id, hotel, openid, guestId, token] of [
  [1, 1, "openid-a", 100, "token-a"],
  [2, 1, "openid-b", 101, "token-b"],
  [3, 1, "openid-unbound", null, "token-unbound"],
  [4, 2, "openid-h2", null, "token-h2"],
]) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, hotel, openid, guestId, token, iso(NOW_MS + 6 * 86400000), iso(NOW_MS), iso(NOW_MS)
  );
}

/* 在住单：500 = A（3001，rate 300，TODAY~D2，2 晚）/ 501 = B（3008） */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, deposit, status, created_at)
   VALUES (500, 1, 'S500', 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 0, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, D2, iso(NOW_MS)
);
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, deposit, status, created_at)
   VALUES (501, 1, 'S501', 3008, 101, '李四', '13800000002', ?, ?, 2, 300, 0, 'INHOUSE', ?)`,
  `${TODAY}T15:00:00.000+08:00`, D2, iso(NOW_MS)
);

/* 账单：500 已有 2 晚房费（600），未收款 */
ins(`INSERT INTO folios (id, hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
     VALUES (800, 1, 'F800', 500, '张三', '3001', 600, 0, 600, 'OPEN', ?)`, iso(NOW_MS));
for (const day of [TODAY, T]) {
  ins(`INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
       VALUES (1, 800, 'ROOM', ?, 1, 300, 300, ?, ?)`, `房费 ${day}`, day, iso(NOW_MS));
}

/*
 * 两张冲突预订：
 *   BK5001：3001 在 D2~D4 已被渠道预订 → A 续住到 D3 必须冲突（远期冲突）
 *   BK5002：3007 在 TODAY~D2 已被预订 → 换房到 3007 必须冲突（剩余在住期占用）
 */
const conflictBooking = (id, roomId, guest, mobile, ci, co) => {
  ins(
    `INSERT INTO bookings (id, hotel_id, booking_no, guest_id, room_id, guest_name, mobile, room_type_id,
       check_in_date, check_out_date, nights, room_count, rate, total_price, status, channel_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, 1, `BK${id}`, null, roomId, guest, mobile, 11, ci, co,
    Math.max(1, Math.round((new Date(`${co}T00:00:00`) - new Date(`${ci}T00:00:00`)) / 86400000)),
    1, 300, 300, "CONFIRMED", 1, iso(NOW_MS), iso(NOW_MS)
  );
  ins(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, stay_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`,
    1, id, 11, roomId, guest, mobile, 300, "CONFIRMED", ci, co, iso(NOW_MS)
  );
};
conflictBooking(5001, 3001, "渠道客甲", "13700000001", D2, D4);
conflictBooking(5002, 3007, "渠道客乙", "13700000002", TODAY, D2);

check("临时库造好（A 在住 3001 / B 在住 3008 / 5 类房态 + 2 张冲突预订）", true);
check(
  "续住远期冲突已就位（3001 在 D2~D4 被 BK5001 占用）",
  Number(db.prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE room_id = 3001 AND status = 'CONFIRMED'`).get().n) === 1
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
export { POST as stayExtend } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/extend/route.ts"))};
export { POST as changeRoom } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/change-room/route.ts"))};
export { GET as staysCurrent } from ${JSON.stringify(srcAbs("app/api/mini/stays/current/route.ts"))};
export { GET as stayFolio } from ${JSON.stringify(srcAbs("app/api/mini/stays/[id]/folio/route.ts"))};
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
  /* 每个请求一个独立 UA：写接口都是 10 次/分钟限流，分散 UA 后互不挤占配额 */
  const headers = { "user-agent": ua || `extend-test-${(uaSeq += 1)}` };
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

const extend = (token, stayId, body) =>
  call(routes.stayExtend, { token, method: "POST", params: { id: String(stayId) }, body });
const changeRoom = (token, stayId, body) =>
  call(routes.changeRoom, { token, method: "POST", params: { id: String(stayId) }, body });

const stayRow = (id) => db.prepare(`SELECT expect_check_out, nights, rate, room_id FROM stays WHERE id = ?`).get(id);
const roomItemCount = (folioId) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM folio_items WHERE folio_id = ? AND item_type = 'ROOM'`).get(folioId).n);
const folioTotal = (folioId) => Number(db.prepare(`SELECT total_amount FROM folios WHERE id = ?`).get(folioId).total_amount);

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 续住：远期冲突（清单第 439 行）                                      */
  /* ====================================================================== */

  console.log("\n── 4. 续住必须检查远期冲突（清单第 439 行） ──");

  const noToken = await extend(undefined, 500, { nights: 1, requestId: "extend-notoken-01" });
  check("未登录续住 → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED");

  const conflict = await extend("token-a", 500, { nights: 1, requestId: "extend-conflict-01" });
  check(
    "房间在远期已被预订 → ROOM_CONFLICT（不「先续上再说」）",
    conflict.status === 200 && conflict.body?.ok === false && conflict.body?.code === "ROOM_CONFLICT",
    j(conflict.body).slice(0, 220)
  );
  check(
    "冲突被拒时入住单没有被改（expect_check_out 仍是 D2 / nights 仍是 2）",
    stayRow(500).expect_check_out === D2 && Number(stayRow(500).nights) === 2,
    JSON.stringify(stayRow(500))
  );
  check(
    "冲突文案不泄漏别人的姓名与单号（只说「已被安排」）",
    !String(conflict.body?.error ?? "").includes("渠道客甲") && !String(conflict.body?.error ?? "").includes("BK5001"),
    String(conflict.body?.error ?? "").slice(0, 120)
  );
  check(
    "冲突被拒时没有补房费明细（folio_items 仍 2 条）",
    roomItemCount(800) === 2,
    `实际 ${roomItemCount(800)} 条`
  );

  /* 解除冲突 → 续住成功（复核日期半开区间的口径） */
  db.prepare(`UPDATE bookings SET status = 'CANCELLED' WHERE id = 5001`).run();
  db.prepare(`UPDATE booking_rooms SET status = 'CANCELLED', room_id = NULL WHERE booking_id = 5001`).run();

  const okExtend = await extend("token-a", 500, { nights: 1, requestId: "extend-ok-0001" });
  check(
    "冲突解除后续住成功（离店日 +1，房费 +300 = rate × 1 晚）",
    okExtend.body?.ok === true &&
      okExtend.body?.data?.expectCheckOut === D3 &&
      Number(okExtend.body?.data?.addedAmount) === 300 &&
      Number(okExtend.body?.data?.rate) === 300,
    j(okExtend.body).slice(0, 220)
  );
  check(
    "续住落库：stays.expect_check_out 更新为 D3、nights 变成 3",
    stayRow(500).expect_check_out === D3 && Number(stayRow(500).nights) === 3,
    JSON.stringify(stayRow(500))
  );
  check(
    "续住补一条房费明细（3 条 ROOM / 合计 900，服务端逐晚补）",
    roomItemCount(800) === 3 &&
      Number(db.prepare(`SELECT SUM(amount) AS s FROM folio_items WHERE folio_id = 800 AND item_type = 'ROOM'`).get().s) === 900,
    `条数 ${roomItemCount(800)}`
  );
  check("续住后账单总额被统一重算（900）", folioTotal(800) === 900, `total=${folioTotal(800)}`);
  check(
    "续住台账落一条 EXTEND 且 status=DONE（客人能在服务请求里看到）",
    Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type = 'EXTEND' AND status = 'DONE'`)
        .get().n
    ) === 1
  );

  /* 幂等：同 requestId 重放 */
  const replay = await extend("token-a", 500, { nights: 1, requestId: "extend-ok-0001" });
  check(
    "同 requestId 重放续住 → duplicated:true，不重复补房费",
    replay.body?.data?.duplicated === true && roomItemCount(800) === 3,
    `duplicated=${replay.body?.data?.duplicated} 条数=${roomItemCount(800)}`
  );
  check("重放后离店日仍是 D3（没有被多加一晚）", stayRow(500).expect_check_out === D3);

  /*
   * requestId 不能跨操作类型复用：续住用过的键不能被换房接口借走，
   * 否则「一键多用」会让幂等判定失去意义。
   * （同一操作类型下参数变化 → 走回放，由页面的 resetRequest 负责换键；
   *   这是「增量语义 + 回放」的正确组合：加晚数永远不会被重放两次。）
   */
  const conflictRequestId = await changeRoom("token-a", 500, { roomId: 3002, requestId: "extend-ok-0001" });
  check(
    "同一 requestId 被另一种操作（换房）复用 → REQUEST_ID_CONFLICT",
    conflictRequestId.body?.code === "REQUEST_ID_CONFLICT",
    j(conflictRequestId.body).slice(0, 140)
  );

  /* 另一种入参：newCheckOutDate（绝对值） */
  const newCheckout = await extend("token-a", 500, { newCheckOutDate: D4, requestId: "extend-newout-01" });
  check(
    "用 newCheckOutDate 续住（D3 → D4，1 晚）同样按 rate 计费",
    newCheckout.body?.ok === true &&
      newCheckout.body?.data?.expectCheckOut === D4 &&
      Number(newCheckout.body?.data?.addedAmount) === 300,
    j(newCheckout.body).slice(0, 200)
  );
  check("续住两次后账单 1200 / 明细 4 条", folioTotal(800) === 1200 && roomItemCount(800) === 4);

  /* ====================================================================== */
  /* 5. 续住：维修房 / 锁房 / 30 晚上限 / 入参                              */
  /* ====================================================================== */

  console.log("\n── 5. 维修房 / 锁房 / 30 晚上限 ──");

  db.prepare(`UPDATE rooms SET status = 'OOO' WHERE id = 3001`).run();
  const oooExtend = await extend("token-a", 500, { nights: 1, requestId: "extend-ooo-0001" });
  check(
    "房间被设为维修（OOO）→ ROOM_UNAVAILABLE，不能续住",
    oooExtend.body?.ok === false && oooExtend.body?.code === "ROOM_UNAVAILABLE",
    j(oooExtend.body).slice(0, 160)
  );
  check("维修房续住被拒时离店日不变（仍 D4）", stayRow(500).expect_check_out === D4);

  db.prepare(`UPDATE rooms SET status = 'LOCK' WHERE id = 3001`).run();
  const lockExtend = await extend("token-a", 500, { nights: 1, requestId: "extend-lock-0001" });
  check(
    "房间被锁（LOCK）→ ROOM_UNAVAILABLE",
    lockExtend.body?.ok === false && lockExtend.body?.code === "ROOM_UNAVAILABLE"
  );
  db.prepare(`UPDATE rooms SET status = 'OC' WHERE id = 3001`).run();

  const over30 = await extend("token-a", 500, { newCheckOutDate: D35, requestId: "extend-over30-01" });
  check(
    "单次续住超过 30 晚 → BAD_REQUEST（长期住宿走前台）",
    over30.body?.ok === false && over30.body?.code === "BAD_REQUEST" && /30 晚/.test(String(over30.body?.error ?? "")),
    j(over30.body).slice(0, 160)
  );

  const negative = await extend("token-a", 500, { nights: -1, requestId: "extend-neg-0001" });
  check("新增晚数为负 → BAD_REQUEST（不会反向缩短）", negative.body?.ok === false && negative.body?.code === "BAD_REQUEST");

  const sameOut = await extend("token-a", 500, { newCheckOutDate: D4, requestId: "extend-sameout-01" });
  check(
    "新离店日等于当前离店日 → BAD_REQUEST（必须晚于当前）",
    sameOut.body?.ok === false && sameOut.body?.code === "BAD_REQUEST"
  );

  const noRequestId = await extend("token-a", 500, { nights: 1 });
  check(
    "缺少 requestId → BAD_REQUEST（没有幂等键就不接单）",
    noRequestId.body?.ok === false && noRequestId.body?.code === "BAD_REQUEST"
  );

  const shortRequestId = await extend("token-a", 500, { nights: 1, requestId: "abc" });
  check("requestId 太短（<8 位）→ BAD_REQUEST", shortRequestId.body?.code === "BAD_REQUEST");

  const unboundExtend = await extend("token-unbound", 500, { nights: 1, requestId: "extend-unbound-01" });
  check(
    "未绑定身份续住 → NOT_BOUND（先绑定再办在住业务）",
    unboundExtend.body?.ok === false && unboundExtend.body?.code === "NOT_BOUND"
  );

  const othersStay = await extend("token-a", 501, { nights: 1, requestId: "extend-others-01" });
  check(
    "续住别人的在住单（B 的 501）→ 404 STAY_NOT_FOUND",
    othersStay.status === 404 && othersStay.body?.code === "STAY_NOT_FOUND"
  );

  const badStayId = await call(routes.stayExtend, { token: "token-a", method: "POST", params: { id: "abc" }, body: { nights: 1, requestId: "extend-badid-01" } });
  check("stayId 不是数字 → BAD_REQUEST", badStayId.body?.code === "BAD_REQUEST");

  /* ====================================================================== */
  /* 6. 换房：不能跨酒店 / 本房 / 非空房 / 已占用                            */
  /* ====================================================================== */

  console.log("\n── 6. 换房不能跨酒店（清单第 440 行） ──");

  const crossHotel = await changeRoom("token-a", 500, { roomId: 9001, requestId: "change-cross-01" });
  check(
    "换房到别家酒店的房间（roomId=9001）→ 404 ROOM_NOT_FOUND（不能跨店）",
    crossHotel.status === 404 && crossHotel.body?.code === "ROOM_NOT_FOUND",
    j(crossHotel.body).slice(0, 160)
  );
  const crossHotelByNo = await changeRoom("token-a", 500, { roomNo: "9001", requestId: "change-cross-02" });
  check("按房间号 9001（别家酒店）换房同样 404（不区分「不存在」与「别家的」）", crossHotelByNo.body?.code === "ROOM_NOT_FOUND");

  const sameRoom = await changeRoom("token-a", 500, { roomId: 3001, requestId: "change-same-01" });
  check(
    "换到当前房间 → BAD_REQUEST（无意义）",
    sameRoom.body?.ok === false && sameRoom.body?.code === "BAD_REQUEST"
  );

  const occupiedTarget = await changeRoom("token-a", 500, { roomId: 3004, requestId: "change-oc-01" });
  check(
    "目标房间不是空净/空脏（OC）→ ROOM_UNAVAILABLE",
    occupiedTarget.body?.ok === false && occupiedTarget.body?.code === "ROOM_UNAVAILABLE",
    j(occupiedTarget.body).slice(0, 160)
  );
  const oooTarget = await changeRoom("token-a", 500, { roomId: 3005, requestId: "change-ooo-01" });
  check("目标房间是维修房（OOO）→ ROOM_UNAVAILABLE", oooTarget.body?.code === "ROOM_UNAVAILABLE");
  const lockTarget = await changeRoom("token-a", 500, { roomId: 3006, requestId: "change-lock-01" });
  check("目标房间是锁房（LOCK）→ ROOM_UNAVAILABLE", lockTarget.body?.code === "ROOM_UNAVAILABLE");

  const conflictTarget = await changeRoom("token-a", 500, { roomId: 3007, requestId: "change-conflict-01" });
  check(
    "目标房间在客人剩余在住期内已被预订（3007）→ ROOM_UNAVAILABLE（不制造双重占用）",
    conflictTarget.body?.ok === false && conflictTarget.body?.code === "ROOM_UNAVAILABLE",
    j(conflictTarget.body).slice(0, 180)
  );

  const notExistRoom = await changeRoom("token-a", 500, { roomNo: "9999", requestId: "change-noexist-01" });
  check("换到不存在的房间号 → ROOM_NOT_FOUND", notExistRoom.body?.code === "ROOM_NOT_FOUND");

  const noRoom = await changeRoom("token-a", 500, { reason: "随便换换", requestId: "change-noroom-01" });
  check("换房请求没给房间 → BAD_REQUEST", noRoom.body?.ok === false && noRoom.body?.code === "BAD_REQUEST");

  const unboundChange = await changeRoom("token-unbound", 500, { roomId: 3002, requestId: "change-unbound-01" });
  check("未绑定身份换房 → NOT_BOUND", unboundChange.body?.code === "NOT_BOUND");

  /* ====================================================================== */
  /* 7. 换房成功：只建申请，不改房态                                        */
  /* ====================================================================== */

  console.log("\n── 7. 换房成功只建 PENDING 申请（不改 stays.room_id） ──");

  const roomIdBefore = Number(stayRow(500).room_id);
  const okChange = await changeRoom("token-a", 500, { roomId: 3002, reason: "想住低楼层", requestId: "change-ok-0001" });
  check(
    "换到空净房 3002 → 200 + status=PENDING",
    okChange.body?.ok === true && okChange.body?.data?.status === "PENDING" && okChange.body?.data?.duplicated === false,
    j(okChange.body).slice(0, 200)
  );
  check(
    "换房只建申请、不改 stays.room_id（现场处置权在前台）",
    Number(stayRow(500).room_id) === roomIdBefore,
    `room_id=${stayRow(500).room_id}`
  );
  check(
    "换房申请内容包含原房 → 目标房与原因（前台能直接执行）",
    /3001\s*→\s*3002/.test(String(okChange.body?.data?.note ?? "")) &&
      /想住低楼层/.test(String(okChange.body?.data?.note ?? "")),
    String(okChange.body?.data?.note ?? "").slice(0, 120)
  );

  const changeReplay = await changeRoom("token-a", 500, { roomId: 3002, reason: "想住低楼层", requestId: "change-ok-0001" });
  check(
    "同 requestId 重放换房 → duplicated:true（只建一条申请）",
    changeReplay.body?.data?.duplicated === true &&
      Number(changeReplay.body?.data?.serviceRequestId) === Number(okChange.body?.data?.serviceRequestId),
    j(changeReplay.body).slice(0, 160)
  );
  check(
    "库里 CHANGE_ROOM 申请只有 1 条（重放没有新增）",
    Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type = 'CHANGE_ROOM' AND status = 'PENDING'`)
        .get().n
    ) === 1
  );

  /* 按房间号换到 VD（空脏）也应该允许 —— 前台会先打扫 */
  const okChangeVD = await changeRoom("token-a", 500, { roomNo: "3003", requestId: "change-vd-0001" });
  check(
    "按房间号换到空脏房（VD）→ 允许申请（前台先打扫再换）",
    okChangeVD.body?.ok === true && okChangeVD.body?.data?.status === "PENDING",
    j(okChangeVD.body).slice(0, 160)
  );

  /* ====================================================================== */
  /* 8. 留痕                                                                */
  /* ====================================================================== */

  console.log("\n── 8. 留痕（op_logs / 服务请求台账） ──");

  const opLogs = db.prepare(`SELECT action FROM op_logs WHERE hotel_id = 1 AND operator = '微信小程序'`).all();
  check(
    "续住写 op_logs（小程序续住）",
    opLogs.some((r) => String(r.action).includes("小程序续住")),
    opLogs.map((r) => r.action).join(",")
  );
  check(
    "换房写 op_logs（小程序换房申请）",
    opLogs.some((r) => String(r.action).includes("小程序换房申请")),
    opLogs.map((r) => r.action).join(",")
  );
  check(
    "失败的换房 / 续住没有落台账（只有成功与幂等回放会建记录：EXTEND 2 + CHANGE_ROOM 2）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type IN ('CHANGE_ROOM','EXTEND')`).get().n) === 4 &&
      Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type = 'EXTEND'`).get().n) === 2 &&
      Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type = 'CHANGE_ROOM'`).get().n) === 2,
    `实际 EXTEND=${Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type='EXTEND'`).get().n)} CHANGE_ROOM=${Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE service_type='CHANGE_ROOM'`).get().n)}`
  );
  check(
    "服务请求台账都挂在当前 mini_user（别人看不到）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_service_requests WHERE mini_user_id <> 1`).get().n) === 0
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
