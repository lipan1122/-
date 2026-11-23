#!/usr/bin/env node
/**
 * 微信小程序「房量与并发防超售」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-availability）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的事（清单第 437 / 444 行）
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **房量由服务端算**：客户端传 remaining / totalRooms 之类的参数一律无效。
 *     可订 = 物理房间数 − 该区间在住 − 该区间已排预订明细 − 维修房，
 *     三个占用来源都要算对（少算一个就会超卖）。
 *  2. **并发下单不能超售**：只剩 1 间时，两个不同用户同时提交，
 *     必须恰好一个成功、一个 ROOM_NOT_ENOUGH，库里 booking_rooms 只多 1 行。
 *  3. 日期非法（格式错 / 离店≤入住 / 超 30 晚）被拒；售罄返回 remaining=0 +
 *     soldOut=true，并且不能再下单。
 *
 * ── 并发是怎么做的（这个脚本与其它几个的区别）──
 * 同一个 Node 进程内调用 route handler 是**串行**的（node:sqlite 是同步 API），
 * 那样测不出「两个请求同时读到 1 间再各自插入」的经典超卖。
 * 所以这里真的起两个子进程：
 *   · 两个子进程各自 chdir 到临时库、加载同一份 bundle；
 *   · 各自输出 READY，父进程收到两个 READY 后**同时**发 GO；
 *   · 两个请求几乎同时进入事务（SQLite WAL + BEGIN IMMEDIATE + busy_timeout），
 *     跨进程的写锁竞争是真实发生的。
 * 这样得到的「一成功一失败」才有说服力。进程内 Promise.all 也顺带测一次，
 * 作为对照（同步实现下它天然串行）。
 *
 * 用法：node scripts/test-mini-availability.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

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

const TMP = join(ROOT, ".tmp", `mini-availability-${process.pid}-${Date.now()}`);
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
const D5 = plusDays(TODAY, 5);
const D6 = plusDays(TODAY, 6);
const D7 = plusDays(TODAY, 7);
const D31 = plusDays(TODAY, 31);
const D32 = plusDays(TODAY, 32);

const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE room_types (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT, name TEXT, bed_type TEXT, area REAL, max_occupancy INTEGER, base_price REAL, sort INTEGER, images TEXT, facilities TEXT, breakfast_note TEXT, cancellation_policy TEXT, check_in_time TEXT, check_out_time TEXT, deposit_note TEXT);
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
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (12, 1, 'DLX', '豪华间', 500, 2, 2)`);

/* 房型 11：3 间物理房，其中 4003 维修（OOO）；房型 12：2 间，全部可售 */
for (const [id, no, type, status] of [
  [4001, "4001", 11, "OC"],
  [4002, "4002", 11, "VC"],
  [4003, "4003", 11, "OOO"],
  [5001, "5001", 12, "VC"],
  [5002, "5002", 12, "VC"],
]) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, id, 1, no, type, status, id);
}

/* 房价日历：T / D2 两晚 350（其余回落门市价） */
ins(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price) VALUES (1, 11, ?, 350)`, T);
ins(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price) VALUES (1, 11, ?, 350)`, D2);

ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-avail-0001', 1, ?)`, iso(NOW_MS));
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

/*
 * 三个占用来源各造一条（用来验证 loadAvailability 的口径）：
 *   1. 在住：4001（TODAY ~ D2）→ 覆盖 T~D3
 *   2. 预订明细：4002 的 booking_rooms（D4~D5）→ 只覆盖 D4~D5
 *   3. 历史主单兜底：BK4003 没有 booking_rooms，room_count=1（D6~D7）
 */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (700, 1, 'S700', 4001, null, '住客甲', '13800000011', ?, ?, 1, 300, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, D2, iso(NOW_MS)
);
ins(
  `INSERT INTO bookings (id, hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, nights, room_count, rate, total_price, status, created_at, updated_at)
   VALUES (4002, 1, 'BK4002', '预订客乙', '13800000012', 11, ?, ?, 1, 1, 300, 300, 'CONFIRMED', ?, ?)`,
  D4, D5, iso(NOW_MS), iso(NOW_MS)
);
ins(
  `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, stay_id, created_at)
   VALUES (1, 4002, 11, 4002, '预订客乙', '13800000012', 300, 'CONFIRMED', ?, ?, NULL, ?)`,
  D4, D5, iso(NOW_MS)
);
ins(
  `INSERT INTO bookings (id, hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, nights, room_count, rate, total_price, status, created_at, updated_at)
   VALUES (4003, 1, 'BK4003', '历史单丙', '13800000013', 11, ?, ?, 1, 1, 300, 300, 'CONFIRMED', ?, ?)`,
  D6, D7, iso(NOW_MS), iso(NOW_MS)
);

check("临时库造好（房型 11：3 间含 1 间维修；房型 12：2 间）", true);
check(
  "三种占用来源各一条（在住 1 / 预订明细 1 / 无明细历史主单 1）",
  Number(db.prepare(`SELECT COUNT(*) AS n FROM stays`).get().n) === 1 &&
    Number(db.prepare(`SELECT COUNT(*) AS n FROM booking_rooms`).get().n) === 1 &&
    Number(db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE id = 4003`).get().n) === 1
);

/* ========================================================================== */
/* 2. 打包真实路由 + 并发 runner                                              */
/* ========================================================================== */

console.log("\n── 2. 编译真实路由（esbuild bundle） ──");

const ENTRY = join(TMP, "entry.ts");
const BUNDLE = join(TMP, "bundle.cjs");
const srcAbs = (rel) => join(ROOT, "src", rel.split("/").join("\\")).replace(/\\/g, "/");
writeFileSync(
  ENTRY,
  `
export { POST as bookingCreate, GET as bookingsList } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
export { GET as rooms } from ${JSON.stringify(srcAbs("app/api/mini/rooms/route.ts"))};
export { GET as roomTypeDetail } from ${JSON.stringify(srcAbs("app/api/mini/room-types/[id]/route.ts"))};
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

/**
 * 子进程 runner：加载同一份 bundle，READY 后等父进程 GO，再发下单请求。
 * 输出两行：READY / 一行 JSON 结果。
 */
const RUNNER = join(TMP, "runner.mjs");
writeFileSync(
  RUNNER,
  `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const [bundlePath, cwd, token, checkIn, checkOut, roomCount, requestId] = process.argv.slice(2);
process.chdir(cwd);
const routes = require(bundlePath);

process.stdout.write("READY\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));

const req = new Request("http://127.0.0.1/api/mini/bookings", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + token,
    "user-agent": "concurrent-runner-" + token,
  },
  body: JSON.stringify({
    roomTypeId: 11,
    checkInDate: checkIn,
    checkOutDate: checkOut,
    roomCount: Number(roomCount),
    guestName: "并发测试客",
    mobile: "13800000001",
    requestId,
  }),
});
const res = await routes.bookingCreate(req, { params: Promise.resolve({}) });
const text = await res.text();
let body = null;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 200) };
}
/* 等 stdout 真正 flush 完再退出，避免管道丢数据
 *
 * 合法的 exit(0)：这段是写进临时文件、由父进程 spawn 的**内嵌子脚本**，
 * 它只负责发一次并发请求并把结果 JSON 打回 stdout；父进程解析后自己 check。
 * 不是「跳过当通过」。 */
await new Promise((resolve) => process.stdout.write(JSON.stringify({ status: res.status, body }) + "\\n", resolve));
process.exit(0);
`,
  "utf8"
);

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
/* 3. 调用工具 + 跨进程并发                                                   */
/* ========================================================================== */

let uaSeq = 0;
function makeReq({ token, method = "GET", url = "http://127.0.0.1/api/mini/x", body, ua }) {
  const headers = { "user-agent": ua || `avail-test-${(uaSeq += 1)}` };
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

const bookingCreate = (token, body) => call(routes.bookingCreate, { token, method: "POST", body });

/**
 * 启动一个子进程，等到它 READY，返回 { go(), done }。
 * 父进程先把两个都 READY，再同时 go —— 这样两个请求才会真正撞在一起。
 */
function startRunner(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, BUNDLE, TMP, ...args], {
      cwd: TMP,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    const done = new Promise((res) => {
      child.on("close", (code) => {
        const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        const jsonLine = [...lines].reverse().find((l) => l.startsWith("{"));
        let parsed = null;
        try {
          parsed = jsonLine ? JSON.parse(jsonLine) : null;
        } catch {
          parsed = null;
        }
        res({ code, parsed, stdout, stderr });
      });
    });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!ready && stdout.includes("READY")) {
        ready = true;
        resolve({ go: () => child.stdin.write("GO\n"), done, pid: child.pid });
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    setTimeout(() => {
      if (!ready) reject(new Error(`runner 启动超时：${stderr.slice(0, 200)}`));
    }, 30000);
  });
}

/** 同时放行两个 runner，返回两边的结果 */
async function runConcurrent(pairs) {
  const handles = await Promise.all(pairs.map((args) => startRunner(args)));
  /* 先让两个都加载完 bundle、连上库，再同时发请求（毫秒级内撞上） */
  handles.forEach((h) => h.go());
  return Promise.all(handles.map((h) => h.done));
}

const avail = async (checkIn, checkOut, extra = "") =>
  call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${checkIn}&checkOut=${checkOut}${extra}` });

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 房量口径：物理 − 在住 − 预订明细 − 维修房                            */
  /* ====================================================================== */

  console.log("\n── 4. 房量口径（三个占用来源都要扣减） ──");

  const fresh = await avail(T, D3);
  check("查房接口匿名可访问（不需要登录，首页核心功能）", fresh.status === 200 && fresh.body?.ok === true);
  check(
    "响应结构完整（checkIn / checkOut / nights / days / currency / roomTypes）",
    fresh.body?.data?.checkIn === T &&
      fresh.body?.data?.checkOut === D3 &&
      Number(fresh.body?.data?.nights) === 2 &&
      Array.isArray(fresh.body?.data?.days) &&
      fresh.body?.data?.days.length === 2 &&
      fresh.body?.data?.currency === "CNY" &&
      Array.isArray(fresh.body?.data?.roomTypes)
  );

  const type11 = (fresh.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "可订 = 3 间物理 − 1 间在住 − 1 间维修 = 1（T~D3）",
    Number(type11?.remainingRooms) === 1,
    `实际 remaining=${type11?.remainingRooms}；${j(type11).slice(0, 200)}`
  );
  check(
    "响应只回可订间数，不暴露 totalRooms / occupiedRooms / maintenanceRooms（P1-24 经营数据）",
    type11 &&
      !("totalRooms" in type11) &&
      !("occupiedRooms" in type11) &&
      !("maintenanceRooms" in type11) &&
      !fresh.text.includes("totalRooms"),
    j(type11).slice(0, 200)
  );

  /* 客户端传参无效 */
  const fakeParams = await avail(T, D3, "&remaining=999&remainingRooms=999&totalRooms=999&soldOut=false");
  const fakeType11 = (fakeParams.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "客户端传 remaining=999 / totalRooms=999 → 被忽略，仍按服务端算的 1",
    Number(fakeType11?.remainingRooms) === 1,
    `实际 ${fakeType11?.remainingRooms}`
  );

  /* 预订明细占用（D4~D5） */
  const availD4 = await avail(D4, D5);
  const type11D4 = (availD4.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "预订明细占用的房间也被扣减（D4~D5：3 − 1 明细 − 1 维修 = 1）",
    Number(type11D4?.remainingRooms) === 1,
    `实际 ${type11D4?.remainingRooms}`
  );

  /* 无明细历史主单兜底（D6~D7） */
  const availD6 = await avail(D6, D7);
  const type11D6 = (availD6.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "没有 booking_rooms 的历史主单也按 room_count 兜底扣减（D6~D7 = 1）",
    Number(type11D6?.remainingRooms) === 1,
    `实际 ${type11D6?.remainingRooms}`
  );

  /* 不同房型互不影响 */
  const type12D4 = (availD4.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 12);
  check("另一个房型不受影响（房型 12 在 D4~D5 可订 2 间）", Number(type12D4?.remainingRooms) === 2);

  /* 房型详情接口与列表口径一致 */
  const detail = await call(routes.roomTypeDetail, {
    params: { id: "11" },
    url: `http://127.0.0.1/api/mini/room-types/11?checkIn=${T}&checkOut=${D3}`,
  });
  check(
    "房型详情里的 availability.remainingRooms 与查房列表一致（同一 loadAvailability）",
    Number(detail.body?.data?.availability?.remainingRooms) ===
      Number((fresh.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11)?.remainingRooms),
    `详情=${detail.body?.data?.availability?.remainingRooms} 列表=${type11?.remainingRooms}`
  );
  check(
    "房型详情不返回 rate_calendar.allotment（当日分配房量属于经营数据）",
    !detail.text.includes("allotment") && !("allotment" in (detail.body?.data?.availability ?? {}))
  );
  check(
    "房型详情对别家酒店 / 不存在的房型 → NOT_FOUND（不区分，防探测）",
    (await call(routes.roomTypeDetail, { params: { id: "21" }, url: "http://127.0.0.1/api/mini/room-types/21" })).body?.code ===
      "NOT_FOUND"
  );

  /* ====================================================================== */
  /* 5. 日期非法被拒                                                         */
  /* ====================================================================== */

  console.log("\n── 5. 日期非法被拒 ──");

  const cases = [
    ["缺少日期参数", `http://127.0.0.1/api/mini/rooms`, "缺少日期参数"],
    ["格式不是 YYYY-MM-DD", `http://127.0.0.1/api/mini/rooms?checkIn=${T.replace(/-/g, "/")}&checkOut=${D2}`, "格式"],
    ["不存在的日期（2026-13-01）", `http://127.0.0.1/api/mini/rooms?checkIn=2026-13-01&checkOut=2026-13-02`, "不存在"],
    ["离店日等于到店日", `http://127.0.0.1/api/mini/rooms?checkIn=${T}&checkOut=${T}`, "等于"],
    ["离店日早于到店日", `http://127.0.0.1/api/mini/rooms?checkIn=${D3}&checkOut=${T}`, "早于"],
    ["超过 30 晚", `http://127.0.0.1/api/mini/rooms?checkIn=${T}&checkOut=${D32}`, "30 晚"],
  ];
  const badDateFails = [];
  for (const [label, url] of cases) {
    const r = await call(routes.rooms, { url });
    if (!(r.status === 400 && r.body?.code === "BAD_REQUEST")) badDateFails.push(`${label}:${r.status}/${r.body?.code}`);
  }
  check("六类日期非法输入全部 400 BAD_REQUEST", badDateFails.length === 0, badDateFails.join(","));

  const overNights = await call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${T}&checkOut=${D32}` });
  check(
    "超 30 晚的报错文案说明上限（可展示给客人）",
    /30 晚/.test(String(overNights.body?.error ?? "")),
    String(overNights.body?.error ?? "").slice(0, 80)
  );

  /* ====================================================================== */
  /* 6. 并发下单不能超售（跨进程，真实撞锁）                                  */
  /* ====================================================================== */

  console.log("\n── 6. 并发下单不能超售（两个进程同时抢最后一间） ──");

  check(
    "并发前：T~D3 只剩 1 间（两个用户都要订 1 间）",
    Number((await avail(T, D3)).body?.data?.roomTypes?.find((t) => t.roomTypeId === 11)?.remainingRooms) === 1
  );

  let concurrentPass = false;
  let concurrentDetail = "";
  try {
    const results = await runConcurrent([
      ["token-a", T, D3, "1", "concurrent-a-0001"],
      ["token-b", T, D3, "1", "concurrent-b-0001"],
    ]);
    const bodies = results.map((r) => r.parsed?.body ?? null);
    const okCount = bodies.filter((b) => b?.ok === true).length;
    const rejected = bodies.filter((b) => b?.ok === false && b?.code === "ROOM_NOT_ENOUGH").length;
    concurrentPass = okCount === 1 && rejected === 1;
    concurrentDetail = bodies
      .map((b) => (b?.ok ? `OK:${b?.data?.bookingNo}` : `ERR:${b?.code}`))
      .join(" / ");
  } catch (e) {
    concurrentDetail = `子进程执行失败：${String(e?.message ?? e).slice(0, 160)}`;
  }
  check(
    "两个不同用户并发下单 → 恰好一个成功、一个 ROOM_NOT_ENOUGH（不超售）",
    concurrentPass,
    concurrentDetail
  );

  /* 库里落库核对：该区间只多 1 行明细，且房间数与可订数一致 */
  const concRows = db
    .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE room_type_id = 11 AND check_in_date = ? AND check_out_date = ?`)
    .get(T, D3).n;
  check("并发后该区间 booking_rooms 只新增 1 行（另一个请求没有落库）", Number(concRows) === 1, `实际 ${concRows} 行`);

  const afterConc = await avail(T, D3);
  const afterType11 = (afterConc.body?.data?.roomTypes ?? []).find((t) => t.roomTypeId === 11);
  check(
    "并发后 T~D3 售罄（remaining=0 + soldOut=true）",
    Number(afterType11?.remainingRooms) === 0 && afterType11?.soldOut === true,
    `remaining=${afterType11?.remainingRooms} soldOut=${afterType11?.soldOut}`
  );

  const overSale = await bookingCreate("token-a", {
    roomTypeId: 11,
    checkInDate: T,
    checkOutDate: D3,
    roomCount: 1,
    guestName: "张三",
    mobile: "13800000001",
    requestId: "avail-oversale-01",
  });
  check(
    "售罄后再下单 → ROOM_NOT_ENOUGH，且不落库",
    overSale.body?.ok === false && overSale.body?.code === "ROOM_NOT_ENOUGH",
    j(overSale.body).slice(0, 160)
  );
  check(
    "被拒的订单没有产生 booking_rooms（仍是 1 行）",
    Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE room_type_id = 11 AND check_in_date = ? AND check_out_date = ?`)
        .get(T, D3).n
    ) === 1
  );

  /* 进程内 Promise.all 对照组（同步实现下必然串行；仍然必须只成功一个） */
  const inProcBefore = Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE room_type_id = 11 AND check_in_date = ? AND check_out_date = ?`)
      .get(D4, D5).n
  );
  const [p1, p2] = await Promise.all([
    bookingCreate("token-a", {
      roomTypeId: 11,
      checkInDate: D4,
      checkOutDate: D5,
      roomCount: 1,
      guestName: "张三",
      mobile: "13800000001",
      requestId: "avail-inproc-01",
    }),
    bookingCreate("token-b", {
      roomTypeId: 11,
      checkInDate: D4,
      checkOutDate: D5,
      roomCount: 1,
      guestName: "李四",
      mobile: "13800000002",
      requestId: "avail-inproc-02",
    }),
  ]);
  const inProcOk = [p1, p2].filter((r) => r.body?.ok === true).length;
  check(
    "进程内并发（对照组）：D4~D5 只剩 1 间时也是恰好一个成功",
    inProcOk === 1,
    `成功 ${inProcOk} 个：${p1.body?.code ?? "OK"} / ${p2.body?.code ?? "OK"}`
  );
  check(
    "进程内并发后该区间 booking_rooms 只新增 1 行",
    Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE room_type_id = 11 AND check_in_date = ? AND check_out_date = ?`)
        .get(D4, D5).n
    ) ===
      inProcBefore + 1,
    `前 ${inProcBefore} 行，后 ${Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM booking_rooms WHERE room_type_id = 11 AND check_in_date = ? AND check_out_date = ?`)
        .get(D4, D5).n
    )} 行`
  );

  /* ====================================================================== */
  /* 7. 金额也由服务端算（与房量同一口径的房价日历）                          */
  /* ====================================================================== */

  console.log("\n── 7. 金额由服务端算（房价日历优先，缺日回落门市价） ──");

  /* 房型 12 在 D4~D5 可订 2 间、没有日历价 → 门市价 500/晚 */
  const book12 = await bookingCreate("token-a", {
    roomTypeId: 12,
    checkInDate: D4,
    checkOutDate: D5,
    roomCount: 1,
    rate: 1,
    totalPrice: 1,
    guestName: "张三",
    mobile: "13800000001",
    requestId: "avail-money-01",
  });
  check(
    "没有日历价的日期按门市价算（500 × 1 晚 = 500），客户端传 1 元无效",
    book12.body?.ok === true && Number(book12.body?.data?.totalPrice) === 500,
    j(book12.body?.data).slice(0, 160)
  );

  const avail11Detail = (await avail(T, D3)).body?.data?.roomTypes?.find((t) => t.roomTypeId === 11);
  check(
    "查房接口的区间均价来自日历价（T~D3 两晚都是 350 → avgPrice 350）",
    Number(avail11Detail?.avgPrice) === 350 && Number(avail11Detail?.totalPrice) === 700,
    `avg=${avail11Detail?.avgPrice} total=${avail11Detail?.totalPrice}`
  );
}

/* ========================================================================== */
/* 8. 清理 + 真库零写入                                                        */
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

console.log("\n── 8. 真库零写入验证 ──");

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
