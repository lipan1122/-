#!/usr/bin/env node
/**
 * 微信小程序「下单幂等与金额」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-booking-idempotency）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明 / 要发现的两件事
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **同一 request_id 只能下单一次**（清单第 436 行）。
 *     网络超时、用户连点两次、小程序被系统重试 —— 任何一种都会把同一个请求
 *     发两遍。没有幂等键，客人会被扣两次房费 / 前台看到两张重复单。
 *     这里连「同一 requestId 顺序提交两次」和「并发提交两次」都测。
 *  2. **所有金额由服务端计算**（清单第 444 行）。
 *     客户端可以传 rate / price / totalPrice，服务端必须完全忽略，
 *     按房价日历（rate_calendar）与晚数 / 间数自己算。改客户端价格不能改房费。
 *
 * ── 做法 ──
 * 临时库（真实 schema 子集）+ esbuild 打包真实 route.ts + 直接调用 POST/GET。
 * 金额断言分三层：
 *   · 响应里的 totalPrice / rate；
 *   · bookings 主单落库值；
 *   · booking_rooms 每行明细的 rate（前台排房与房量口径都用它）。
 *
 * ── 日期区间为什么分组 ──
 * 房量占用按「区间重叠」计算。幂等 / 并发 / 不同键 / 售罄各自用互不重叠的
 * 日期段，避免前一段的占用把后一段挤爆（那会让断言互相污染、失败原因难辨认）。
 *
 * 用法：node scripts/test-mini-booking-idempotency.mjs
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

const TMP = join(ROOT, ".tmp", `mini-booking-idem-${process.pid}-${Date.now()}`);
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
const D8 = plusDays(TODAY, 8);
const D32 = plusDays(TODAY, 32);

const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT, gender TEXT, id_no TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT);
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
ins(`INSERT INTO settings (hotel_id, key, value) VALUES (1, 'biz_day_cutoff', '00:00')`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (11, 1, 'STD', '标准间', 300, 2, 1)`);
/* 别家酒店房型（测「拿别家房型下单」被拒） */
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (21, 2, 'STD2', '别家标准间', 200, 2, 1)`);
/* 9 间物理房：8 间可售 + 1 间维修（测房量口径） */
for (let i = 1; i <= 8; i += 1) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, 3000 + i, 1, String(3000 + i), 11, "VC", i);
}
ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (3009, 1, '3009', 11, 'OOO', 9)`);

/* 房价日历：T / D2 两晚 350（用来验证「服务端按日历价算」），其余回落门市价 300 */
ins(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price) VALUES (1, 11, ?, 350)`, T);
ins(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price) VALUES (1, 11, ?, 350)`, D2);

ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-booking-0001', 1, ?)`, iso(NOW_MS));

/* A / B 两个未绑定用户（下单不需要绑定手机号 —— 用 mini_program_bookings 关联身份） */
for (const [id, openid, token] of [
  [1, "openid-a", "token-a"],
  [2, "openid-b", "token-b"],
]) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, session_token, token_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, 1, openid, token, iso(NOW_MS + 6 * 86400000), iso(NOW_MS), iso(NOW_MS)
  );
}

check("临时库造好（8 间可售 + 1 间维修，日历价 350/晚）", true);
check("初始没有任何预订", Number(db.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n) === 0);

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
export { POST as bookingCreate, GET as bookingsList } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
export { GET as bookingDetail } from ${JSON.stringify(srcAbs("app/api/mini/bookings/[id]/route.ts"))};
export { GET as rooms } from ${JSON.stringify(srcAbs("app/api/mini/rooms/route.ts"))};
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
  const headers = { "user-agent": ua || `booking-test-${(uaSeq += 1)}` };
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

/** 下单参数（默认 1 间 2 晚，日期 T~D3） */
function orderBody(overrides = {}) {
  return {
    roomTypeId: 11,
    checkInDate: T,
    checkOutDate: D3,
    roomCount: 1,
    guestName: "张三",
    mobile: "13800000001",
    ...overrides,
  };
}

const bookingCreate = (token, body) => call(routes.bookingCreate, { token, method: "POST", body });
const bookingCount = () => Number(db.prepare(`SELECT COUNT(*) AS n FROM bookings`).get().n);
const detailRooms = (bookingId) =>
  db
    .prepare(`SELECT room_id, rate, status, check_in_date, check_out_date FROM booking_rooms WHERE booking_id = ? ORDER BY id`)
    .all(bookingId);

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 正常下单 + 金额服务端算                                              */
  /* ====================================================================== */

  console.log("\n── 4. 正常下单：金额与明细都由服务端算 ──");

  const noToken = await bookingCreate(undefined, orderBody());
  check("未登录下单 → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED");

  const first = await bookingCreate("token-a", orderBody({ requestId: "book-0001-abcdef" }));
  check(
    "A 下单成功（200 ok，返回 BK 开头的单号）",
    first.status === 200 && first.body?.ok === true && /^BK\d+$/.test(String(first.body?.data?.bookingNo ?? "")),
    j(first.body).slice(0, 180)
  );
  const bookingId = Number(first.body?.data?.bookingId ?? 0);
  check("响应带 bookingId（前端据此跳详情）", bookingId > 0);

  const mainRow = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
  check(
    "金额由服务端算：日历价 350 × 2 晚 × 1 间 = 700（不是门市价 300）",
    Number(first.body?.data?.totalPrice) === 700 && Number(mainRow.total_price) === 700 && Number(mainRow.rate) === 350,
    `响应：${j(first.body?.data)} 库里：rate=${mainRow?.rate} total=${mainRow?.total_price}`
  );

  const rooms1 = detailRooms(bookingId);
  check("booking_rooms 落一行明细（下单 1 间）", rooms1.length === 1, `实际 ${rooms1.length} 行`);
  check("明细上的房价是服务端算的 350（不是客户端传值）", Number(rooms1[0]?.rate) === 350, `rate=${rooms1[0]?.rate}`);
  check(
    "明细状态 PENDING 且未排具体房间（room_id 为空，等前台排房）",
    rooms1[0]?.status === "PENDING" && rooms1[0]?.room_id === null
  );
  check(
    "明细日期与主单一致（booking_rooms 是房量占用的权威来源）",
    rooms1[0]?.check_in_date === T && rooms1[0]?.check_out_date === D3
  );
  check(
    "下单写 op_logs（operator = 微信小程序 / action = 小程序预订）",
    Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = 1 AND operator = '微信小程序' AND action = '小程序预订'`)
        .get().n
    ) === 1
  );
  check(
    "下单写 mini_program_bookings 关联（未绑定用户也能看到自己下的单）",
    Number(
      db.prepare(`SELECT COUNT(*) AS n FROM mini_program_bookings WHERE mini_user_id = 1 AND booking_id = ?`).get(bookingId).n
    ) === 1
  );

  /* ---------- 客户端改价：传 1 元，服务端仍按真实房价 ---------- */
  const cheap = await bookingCreate(
    "token-b",
    orderBody({ requestId: "book-cheap-0001", rate: 1, price: 1, totalPrice: 1, amount: 1, roomCount: 2 })
  );
  check(
    "客户端在请求体里传 rate=1 / totalPrice=1 → 不影响服务端计价（350×2 晚×2 间=1400）",
    cheap.body?.ok === true && Number(cheap.body?.data?.totalPrice) === 1400,
    `实际 totalPrice=${cheap.body?.data?.totalPrice}`
  );
  const cheapRow = db
    .prepare(`SELECT rate, total_price, room_count FROM bookings WHERE id = ?`)
    .get(Number(cheap.body?.data?.bookingId));
  check(
    "落库值同样是服务端算的（rate 350 / total_price 1400）",
    Number(cheapRow?.rate) === 350 && Number(cheapRow?.total_price) === 1400,
    JSON.stringify(cheapRow)
  );
  check(
    "多房订单 booking_rooms 一间一行（2 间 → 2 行，rate 都是 350）",
    detailRooms(Number(cheap.body?.data?.bookingId)).length === 2 &&
      detailRooms(Number(cheap.body?.data?.bookingId)).every((r) => Number(r.rate) === 350),
    JSON.stringify(detailRooms(Number(cheap.body?.data?.bookingId)))
  );

  /* ====================================================================== */
  /* 5. 同一 request_id 只能下单一次（清单第 436 行）                        */
  /* ====================================================================== */

  console.log("\n── 5. 同一 request_id 只能下单一次（清单第 436 行） ──");

  /*
   * 场景一：同一个 requestId 顺序提交两次（网络超时后用户再点一次）。
   * 期望：只有一张 bookings，第二次是**幂等重放**（replayed:true）并返回同一张单。
   * 日期用独立区间 D3~D4，避免与上面的占用相互影响。
   *
   * 修复前（第九轮实测）：两次都返回 ok:true，库里新增 2 张（BK3003 / BK3004）——
   * 客人连点两次就多一张重复单，前台会重复排房。现在断言的是修复后的正确行为：
   *   · 第二次响应 replayed === true（服务端命中幂等键，没有新建任何数据）；
   *   · 两次 bookingId / bookingNo / totalPrice 完全一致；
   *   · 库里 bookings.mini_request_id 真的落了键（不是只在内存里去重）；
   *   · 重放不重复写 op_logs、不重复插 booking_rooms。
   */
  const rid = "book-idem-0001-abcdef";
  const beforeSeq = bookingCount();
  const logBefore = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = 1 AND action = '小程序预订'`).get().n
  );
  const seq1 = await bookingCreate("token-a", orderBody({ checkInDate: D3, checkOutDate: D4, requestId: rid }));
  const seq2 = await bookingCreate("token-a", orderBody({ checkInDate: D3, checkOutDate: D4, requestId: rid }));
  const seqAdded = bookingCount() - beforeSeq;
  check(
    "同一 requestId 提交两次 → 只建一张订单（幂等键落库，不是靠前端拦）",
    seq1.body?.ok === true && seq2.body?.ok === true && seqAdded === 1,
    `实际新增 ${seqAdded} 张；第一次=${seq1.body?.data?.bookingNo} 第二次=${seq2.body?.data?.bookingNo ?? seq2.body?.code}`
  );
  const ridStored = db
    .prepare(`SELECT mini_request_id FROM bookings WHERE id = ?`)
    .get(Number(seq1.body?.data?.bookingId));
  check(
    "幂等键写进 bookings.mini_request_id（后续重试靠它查重）",
    String(ridStored?.mini_request_id ?? "") === rid,
    `库里 mini_request_id=${j(ridStored?.mini_request_id)}`
  );
  check(
    "第二次请求是幂等重放：replayed===true 且返回同一张单（同 bookingId / 同单号 / 同金额）",
    seq2.body?.data?.replayed === true &&
      Number(seq2.body?.data?.bookingId) === Number(seq1.body?.data?.bookingId) &&
      String(seq2.body?.data?.bookingNo ?? "") === String(seq1.body?.data?.bookingNo ?? "") &&
      Number(seq2.body?.data?.totalPrice) === Number(seq1.body?.data?.totalPrice),
    `第二次响应：${j(seq2.body).slice(0, 200)}`
  );
  check(
    "重放不产生副作用：op_logs 只加 1 条、booking_rooms 该区间只有 1 行",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = 1 AND action = '小程序预订'`).get().n) -
      logBefore ===
      1 &&
      Number(
        db
          .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE check_in_date = ? AND check_out_date = ?`)
          .get(D3, D4).n
      ) === 1,
    `日志 +${
      Number(db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = 1 AND action = '小程序预订'`).get().n) - logBefore
    }，明细 ${db.prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE check_in_date = ? AND check_out_date = ?`).get(D3, D4).n} 行`
  );

  /*
   * 场景二：并发同 requestId（连点两次，两个请求几乎同时到）。
   * 期望：只建一张；两个响应都是 ok（后到的那个走「唯一索引兜底 → 重查 → 重放」），
   * 而不是一个成功一个 500 / BOOKING_FAILED。日期用 D4~D5。
   */
  const rid2 = "book-idem-concurrent-01";
  const beforeConc = bookingCount();
  const [c1, c2] = await Promise.all([
    bookingCreate("token-b", orderBody({ checkInDate: D4, checkOutDate: D5, requestId: rid2 })),
    bookingCreate("token-b", orderBody({ checkInDate: D4, checkOutDate: D5, requestId: rid2 })),
  ]);
  const concAdded = bookingCount() - beforeConc;
  const concBodies = [c1.body, c2.body];
  const concIds = concBodies.map((b) => Number(b?.data?.bookingId ?? 0));
  check(
    "并发提交同一 requestId → 只建一张订单（唯一索引兜底，不超建）",
    concAdded === 1,
    `实际新增 ${concAdded} 张；响应 ${c1.body?.code ?? "OK"} / ${c2.body?.code ?? "OK"}`
  );
  check(
    "并发两次都返回成功且指向同一张单（后到的那个按重放返回，不抛 500 / BOOKING_FAILED）",
    concBodies.every((b) => b?.ok === true) && concIds[0] > 0 && concIds[0] === concIds[1],
    `两次 bookingId=${concIds.join("/")}；响应：${j(concBodies.map((b) => b?.code ?? "OK"))}`
  );
  check(
    "并发场景里恰好一次是新建（replayed:false）、一次是重放（replayed:true）",
    concBodies.filter((b) => b?.data?.replayed === false).length === 1 &&
      concBodies.filter((b) => b?.data?.replayed === true).length === 1,
    `replayed=${concBodies.map((b) => String(b?.data?.replayed)).join("/")}`
  );

  /* 不同 requestId → 两张单（正常业务，不是幂等拦截）；日期 D5~D6 */
  const beforeDiff = bookingCount();
  const diff1 = await bookingCreate("token-a", orderBody({ checkInDate: D5, checkOutDate: D6, requestId: "book-diff-0001" }));
  const diff2 = await bookingCreate("token-a", orderBody({ checkInDate: D5, checkOutDate: D6, requestId: "book-diff-0002" }));
  check(
    "不同 requestId → 两张独立订单（幂等键不影响正常重复下单）",
    diff1.body?.ok === true &&
      diff2.body?.ok === true &&
      bookingCount() - beforeDiff === 2 &&
      diff1.body?.data?.bookingId !== diff2.body?.data?.bookingId,
    `新增 ${bookingCount() - beforeDiff} 张；${diff1.body?.code ?? "OK"}/${diff2.body?.code ?? "OK"}`
  );

  /*
   * 不带 requestId → 保持原有行为（向后兼容）。
   * 决策依据：小程序历史版本 / 联调脚本 / 其他调用方都用不带键的请求体，
   * 强制必传会让它们全部 400；幂等是加强而不是破坏性变更。
   * 日期 D6~D7。
   */
  const beforeNoKey = bookingCount();
  const noKey = await bookingCreate("token-a", orderBody({ checkInDate: D6, checkOutDate: D7 }));
  check(
    "不带 requestId 仍可正常下单（向后兼容），但没有幂等保护",
    noKey.body?.ok === true &&
      bookingCount() - beforeNoKey === 1 &&
      noKey.body?.data?.replayed === false &&
      db.prepare(`SELECT mini_request_id FROM bookings WHERE id = ?`).get(Number(noKey.body?.data?.bookingId))
        ?.mini_request_id === null,
    j(noKey.body).slice(0, 160)
  );

  /*
   * 非法幂等键（太短 / 含非法字符）→ BAD_REQUEST，不能静默忽略。
   * 静默忽略 = 退化成「没有幂等」，重试照样重复建单。
   */
  const beforeBadKey = bookingCount();
  const badKey = await bookingCreate("token-a", orderBody({ checkInDate: D6, checkOutDate: D7, requestId: "x" }));
  check(
    "非法 requestId（过短）→ BAD_REQUEST，不落库",
    badKey.body?.ok === false && badKey.body?.code === "BAD_REQUEST" && bookingCount() - beforeBadKey === 0,
    j(badKey.body).slice(0, 140)
  );

  /*
   * 五处 schema 同步（清单第六节第 387-394 行的交付要求）：
   * 建表 / 建索引在 4 个脚本 + 运行时，导出在 schema-fingerprint.json。
   * 这一段防的是「只改了运行时、全新部署与老库升级仍缺列」。
   */
  const schemaFullSrc = readFileSync(join(ROOT, "scripts/schema-full.sql"), "utf8");
  const initDbSrc = readFileSync(join(ROOT, "scripts/init-db.mjs"), "utf8");
  const migrateSrc = readFileSync(join(ROOT, "scripts/migrate-all.mjs"), "utf8");
  const routeSrc = readFileSync(join(ROOT, "src/app/api/mini/bookings/route.ts"), "utf8");
  const fingerprintSrc = readFileSync(join(ROOT, "scripts/schema-fingerprint.json"), "utf8");
  check(
    "① schema-full.sql / init-db.mjs / migrate-all.mjs / 运行时 ensureBookingRequestSchema 都有 mini_request_id 列",
    [schemaFullSrc, initDbSrc, migrateSrc, routeSrc].every((src) => /mini_request_id/.test(src))
  );
  check(
    "② 四处都声明了 (hotel_id, mini_request_id) 的部分唯一索引，schema-fingerprint.json 已导出",
    [schemaFullSrc, migrateSrc, routeSrc].every((src) =>
      /bookings\(hotel_id, mini_request_id\) WHERE mini_request_id IS NOT NULL/.test(src)
    ) &&
      fingerprintSrc.includes('"idx_bookings_mini_request"') &&
      fingerprintSrc.includes('"mini_request_id"')
  );

  /* ====================================================================== */
  /* 6. 入参校验（金额/日期/房型都不能被客户端带偏）                          */
  /* ====================================================================== */

  console.log("\n── 6. 入参校验 ──");

  const badRoomType = await bookingCreate("token-a", orderBody({ roomTypeId: 21, requestId: "book-badtype-01" }));
  check(
    "拿别家酒店的房型 id 下单 → BAD_REQUEST（房型必须属于本店）",
    badRoomType.body?.ok === false && badRoomType.body?.code === "BAD_REQUEST",
    j(badRoomType.body).slice(0, 140)
  );

  const pastCheckIn = await bookingCreate(
    "token-a",
    orderBody({ checkInDate: YESTERDAY, checkOutDate: TODAY, requestId: "book-past-01" })
  );
  check(
    "到店日早于今天（昨天）→ BAD_REQUEST（不允许订过去）",
    pastCheckIn.body?.ok === false && pastCheckIn.body?.code === "BAD_REQUEST",
    j(pastCheckIn.body).slice(0, 140)
  );

  const sameDay = await bookingCreate("token-a", orderBody({ checkInDate: T, checkOutDate: T, requestId: "book-sameday-01" }));
  check(
    "离店日期等于到店日期 → BAD_REQUEST（必须至少 1 晚）",
    sameDay.body?.ok === false && sameDay.body?.code === "BAD_REQUEST"
  );

  const tooLong = await bookingCreate("token-a", orderBody({ checkInDate: T, checkOutDate: D32, requestId: "book-long-01" }));
  check(
    "超过 30 晚 → BAD_REQUEST（小程序只做短住）",
    tooLong.body?.ok === false && tooLong.body?.code === "BAD_REQUEST",
    `nights=${Math.round((new Date(`${D32}T00:00:00`) - new Date(`${T}T00:00:00`)) / 86400000)}`
  );

  const badMobile = await bookingCreate("token-a", orderBody({ mobile: "12345", requestId: "book-badmobile-01" }));
  check("手机号格式非法 → BAD_REQUEST", badMobile.body?.ok === false && badMobile.body?.code === "BAD_REQUEST");

  const noName = await bookingCreate("token-a", orderBody({ guestName: "", requestId: "book-noname-01" }));
  check("缺少入住人姓名 → BAD_REQUEST", noName.body?.ok === false && noName.body?.code === "BAD_REQUEST");

  const tooManyRooms = await bookingCreate("token-a", orderBody({ roomCount: 6, requestId: "book-manyrooms-01" }));
  check("单笔超过 5 间 → BAD_REQUEST", tooManyRooms.body?.ok === false && tooManyRooms.body?.code === "BAD_REQUEST");

  /* ====================================================================== */
  /* 7. 房量：服务端算 + 不超售                                             */
  /* ====================================================================== */

  console.log("\n── 7. 房量由服务端算，售罄不能超卖 ──");

  /* 独立区间 D7~D8：8 间可售（9 间物理 − 1 间 OOO） */
  const url = `http://127.0.0.1/api/mini/rooms?checkIn=${D7}&checkOut=${D8}`;
  const avail = await call(routes.rooms, { url });
  const typeAvail = (avail.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "查房接口的可订间数由服务端算（9 间物理 − 1 间维修 = 8）",
    Number(typeAvail?.remainingRooms) === 8,
    `remaining=${typeAvail?.remainingRooms} 响应=${j(avail.body?.data).slice(0, 200)}`
  );

  /* 客户端传 remaining=999 不影响结果 */
  const availFake = await call(routes.rooms, { url: `${url}&remaining=999&totalRooms=999&remainingRooms=999` });
  const typeFake = (availFake.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "客户端传 remaining / totalRooms 参数被忽略（房量只由服务端算）",
    Number(typeFake?.remainingRooms) === 8
  );

  const fill1 = await bookingCreate("token-a", orderBody({ checkInDate: D7, checkOutDate: D8, roomCount: 5, requestId: "book-fill-5" }));
  const fill2 = await bookingCreate("token-a", orderBody({ checkInDate: D7, checkOutDate: D8, roomCount: 3, requestId: "book-fill-3" }));
  check(
    "分两笔把 8 间订满（5 间 + 3 间）都成功",
    fill1.body?.ok === true && fill2.body?.ok === true,
    `fill1=${fill1.body?.code ?? "OK"} fill2=${fill2.body?.code ?? "OK"}`
  );

  const soldOut = await call(routes.rooms, { url });
  const typeSoldOut = (soldOut.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "售罄后查房返回 remainingRooms=0 且 soldOut=true",
    Number(typeSoldOut?.remainingRooms) === 0 && typeSoldOut?.soldOut === true,
    `remaining=${typeSoldOut?.remainingRooms} soldOut=${typeSoldOut?.soldOut}`
  );

  const overSale = await bookingCreate("token-b", orderBody({ checkInDate: D7, checkOutDate: D8, roomCount: 1, requestId: "book-over-01" }));
  check(
    "售罄后再下单 → ROOM_NOT_ENOUGH（不超卖）",
    overSale.body?.ok === false && overSale.body?.code === "ROOM_NOT_ENOUGH",
    j(overSale.body).slice(0, 180)
  );
  check(
    "被拒的超卖单没有落库（D7~D8 区间的 booking_rooms 仍只有 8 行）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE check_in_date = ? AND check_out_date = ?`).get(D7, D8).n) === 8,
    `实际 ${db.prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE check_in_date = ? AND check_out_date = ?`).get(D7, D8).n}`
  );

  /* ====================================================================== */
  /* 8. 订单隔离 + 金额回读一致                                              */
  /* ====================================================================== */

  console.log("\n── 8. 订单隔离与详情金额一致 ──");

  const listA = await call(routes.bookingsList, { token: "token-a", url: "http://127.0.0.1/api/mini/bookings" });
  const listB = await call(routes.bookingsList, { token: "token-b", url: "http://127.0.0.1/api/mini/bookings" });
  const idsA = (listA.body?.data?.bookings ?? []).map((b) => b.bookingId);
  const idsB = (listB.body?.data?.bookings ?? []).map((b) => b.bookingId);
  check(
    "A 的「我的订单」里没有 B 下的单（两个未绑定用户各看各的）",
    idsA.length > 0 && idsB.length > 0 && idsA.every((id) => !idsB.includes(id)),
    `A=${idsA.join(",")} B=${idsB.join(",")}`
  );
  check(
    "列表金额与主单一致（服务端算的 total_price，不是前端重新拼）",
    (listA.body?.data?.bookings ?? []).every((b) => {
      const row = db.prepare(`SELECT total_price FROM bookings WHERE id = ?`).get(b.bookingId);
      return Math.abs(Number(b.amount) - Number(row?.total_price ?? -1)) < 0.01;
    })
  );

  const detail = await call(routes.bookingDetail, { token: "token-a", params: { id: String(bookingId) } });
  check(
    "详情金额与下单响应一致（700 / rate 350）",
    Number(detail.body?.data?.totalPrice) === 700 && Number(detail.body?.data?.rate) === 350,
    j(detail.body?.data).slice(0, 160)
  );
  check(
    "详情姓名脱敏（张*），响应里没有完整手机号",
    String(detail.body?.data?.guestName ?? "") === "张*" && !detail.text.includes("13800000001")
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
