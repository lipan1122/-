#!/usr/bin/env node
/**
 * 微信小程序「绑定身份与解绑」安全验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-bind-security）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的几件事（清单第 434-435 行）
 * ══════════════════════════════════════════════════════════════════════════
 *   · **只凭手机号 / 姓名不能绑定**：手机号是用户自填的自由文本，不是凭证。
 *     必须再加一条「只有本人或前台知道」的单据信息（预订号 / 在住房间号），
 *     且单据上登记的手机号要与提交的一致。
 *   · **小程序自助单不能作为证明**：下单接口里的 mobile 是攻击者可控的输入
 *     （他可以给受害者手机号下张单），所以只认「客户端写不进去」的单据：
 *     前台代建（created_by 非空）或渠道单（channel_id 非空）。
 *   · **失败次数有限制**：连续失败 5 次锁 30 分钟（落库，重启不清零）。
 *   · **解绑要二次确认**：有效 token + 一次性 confirmToken + 手输「解绑」，
 *     并且解绑后旧 token 立即失效（不是等 7 天自然过期）。
 *
 * ── 怎么做的（与 test-mini-order-access / test-mini-member-wallet 同一套）──
 *   VACUUM 出来的临时库 → process.chdir 到临时目录（db.ts 用 cwd/data/pms.db）
 *   → esbuild 把真实 route.ts 打成 CJS → 直接调用导出的 GET/POST
 *   → 断言响应 + 断言数据库最终状态 → 删临时目录。
 * 真库只做一次 sha256 前后对比，全程不写。
 *
 * 用法：node scripts/test-mini-bind-security.mjs
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

const TMP = join(ROOT, ".tmp", `mini-bind-security-${process.pid}-${Date.now()}`);
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
const TOMORROW = plusDays(TODAY, 1);
const D3 = plusDays(TODAY, 3);

const db = new DatabaseSync(TMP_DB);
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT, mobile TEXT,
    gender TEXT, id_no TEXT, vip_level INTEGER, blacklist INTEGER, deleted INTEGER DEFAULT 0, created_at TEXT
  );
  CREATE UNIQUE INDEX idx_guests_hotel_mobile ON guests(hotel_id, mobile);
  CREATE TABLE room_types (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT, name TEXT, base_price REAL, max_occupancy INTEGER, sort INTEGER);
  CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_no TEXT, floor INTEGER, room_type_id INTEGER, status TEXT, sort INTEGER);
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
    check_in_date TEXT, check_out_date TEXT, nights INTEGER, room_count INTEGER, rate REAL,
    total_price REAL, status TEXT, created_by INTEGER, created_at TEXT, updated_at TEXT
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
  CREATE TABLE mini_program_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, openid TEXT NOT NULL, unionid TEXT,
    guest_id INTEGER, mobile TEXT, session_token TEXT, token_expires_at TEXT,
    bind_attempts INTEGER DEFAULT 0, bind_locked_until TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid);
  CREATE INDEX idx_mini_users_token ON mini_program_users(session_token);
  CREATE TABLE mini_program_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, mini_user_id INTEGER NOT NULL, booking_id INTEGER NOT NULL, created_at TEXT, UNIQUE(hotel_id, booking_id));
`);

const iso = (ms) => new Date(ms).toISOString();
const NOW_MS = Date.now();
const ins = (sql, ...args) => db.prepare(sql).run(...args);

ins(`INSERT INTO hotels (id, code, name, address, phone) VALUES (1, 'H1', '测试酒店一号', '测试路 1 号', '0571-88880001')`);
ins(`INSERT INTO room_types (id, hotel_id, code, name, base_price, max_occupancy, sort) VALUES (11, 1, 'STD', '标准间', 300, 2, 1)`);
for (const [id, no, status] of [
  [3001, "3001", "OC"],
  [3002, "3002", "OC"],
  [3003, "3003", "VC"],
]) {
  ins(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, id, 1, no, 11, status, id);
}

/* 客史：张三 / 李四 / 分店王五 */
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (100, 1, '张三', '13800000001', 1, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (101, 1, '李四', '13800000002', 3, 0)`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile, vip_level, blacklist) VALUES (102, 1, '王五', '13800000003', 0, 0)`);

ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-bind-0001', 1, ?)`, iso(NOW_MS));

/*
 * 用户：U1~U6 未绑定（每个阶段一个，互不干扰失败计数）；
 * A / B 已绑定（测幂等绑定与解绑）。
 */
const USERS = [
  [1, "openid-u1", null, "token-u1"],
  [2, "openid-u2", null, "token-u2"],
  [3, "openid-u3", null, "token-u3"],
  [4, "openid-u4", null, "token-u4"],
  [5, "openid-u5", null, "token-u5"],
  [6, "openid-u6", null, "token-u6"],
  [7, "openid-a", 100, "token-a"],
  [8, "openid-b", 101, "token-b"],
];
for (const [id, openid, guestId, token] of USERS) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, bind_attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,?,?)`,
    id, 1, openid, guestId, token, iso(NOW_MS + 6 * 86400000), iso(NOW_MS), iso(NOW_MS)
  );
}

/* 在住单：500 张三（房间 3001）/ 501 李四（房间 3002） */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (500, 1, 'S500', 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T14:00:00.000+08:00`, TOMORROW, iso(NOW_MS)
);
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (501, 1, 'S501', 3002, 101, '李四', '13800000002', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${TODAY}T15:00:00.000+08:00`, TOMORROW, iso(NOW_MS)
);

/*
 * 四类预订单据（绑定证明的来源）：
 *   BK3001 前台代建（created_by=9）        → 可用
 *   BK3002 渠道单（channel_id=3）          → 可用
 *   BK3003 小程序自助（created_by/channel 都空）→ **不可用**
 *   BK3004 前台代建但已取消                → 不可用
 *   BK3005 前台代建但已过离店日            → 不可用
 */
const bookingRow = (id, msg, mobile, ci, co, status, createdBy, channelId) =>
  ins(
    `INSERT INTO bookings (id, hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id,
       check_in_date, check_out_date, nights, room_count, rate, total_price, status, created_by, channel_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, 1, `BK${id + 3000}`, null, "测试客人", mobile, 11, ci, co, 2, 1, 300, 600, status, createdBy, channelId, iso(NOW_MS), iso(NOW_MS)
  );
bookingRow(1, null, "13800000001", TOMORROW, D3, "CONFIRMED", 9, null); // BK3001 前台代建
bookingRow(2, null, "13800000002", TOMORROW, D3, "CONFIRMED", null, 3); // BK3002 渠道单
bookingRow(3, null, "13800000003", TOMORROW, D3, "PENDING", null, null); // BK3003 小程序自助
bookingRow(4, null, "13800000004", TOMORROW, D3, "CANCELLED", 9, null); // BK3004 已取消
bookingRow(5, null, "13800000005", plusDays(TODAY, -2), YESTERDAY, "CONFIRMED", 9, null); // BK3005 已过离店日

check("临时库造好（8 个小程序用户 / 5 张预订 / 2 张在住单）", true);
check(
  "BK3003 是「小程序自助单」（created_by 与 channel_id 都为空）",
  (() => {
    const r = db.prepare(`SELECT created_by, channel_id FROM bookings WHERE booking_no = 'BK3003'`).get();
    return r.created_by === null && r.channel_id === null;
  })()
);
check(
  "BK3001 是前台代建单（created_by=9），BK3002 是渠道单（channel_id=3）",
  db.prepare(`SELECT created_by FROM bookings WHERE booking_no='BK3001'`).get().created_by === 9 &&
    db.prepare(`SELECT channel_id FROM bookings WHERE booking_no='BK3002'`).get().channel_id === 3
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
export { POST as bind } from ${JSON.stringify(srcAbs("app/api/mini/bind/route.ts"))};
export { POST as unbind } from ${JSON.stringify(srcAbs("app/api/mini/member/unbind/route.ts"))};
export { GET as member } from ${JSON.stringify(srcAbs("app/api/mini/member/route.ts"))};
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
  const headers = { "user-agent": ua || `bind-test-${(uaSeq += 1)}` };
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

const bindWith = (token, body) => call(routes.bind, { token, method: "POST", body });
const userRow = (id) => db.prepare(`SELECT * FROM mini_program_users WHERE id = ?`).get(id);

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 只凭手机号 / 姓名不能绑定                                            */
  /* ====================================================================== */

  console.log("\n── 4. 只凭手机号 / 姓名不能绑定（清单第 434 行） ──");

  const onlyMobile = await bindWith("token-u1", { mobile: "13800000001", guestName: "张三" });
  check(
    "只传「手机号 + 姓名」（无预订号/房号）→ BAD_REQUEST，不绑定",
    onlyMobile.body?.ok === false && onlyMobile.body?.code === "BAD_REQUEST",
    j(onlyMobile.body).slice(0, 140)
  );
  check("只凭手机号失败后没有写入绑定关系（guest_id 仍为空）", userRow(1).guest_id === null);

  const onlyName = await bindWith("token-u1", { guestName: "张三" });
  check("只传姓名 → BAD_REQUEST", onlyName.body?.ok === false && onlyName.body?.code === "BAD_REQUEST");

  const badMobile = await bindWith("token-u1", { mobile: "12345", guestName: "张三", bookingNo: "BK3001" });
  check("手机号格式非法 → BAD_REQUEST（不进入单据校验）", badMobile.body?.code === "BAD_REQUEST");

  const longName = await bindWith("token-u1", { mobile: "13800000001", guestName: "名".repeat(31), bookingNo: "BK3001" });
  check("姓名超长（>30 字）→ BAD_REQUEST", longName.body?.code === "BAD_REQUEST");

  const wrongBookingMobile = await bindWith("token-u1", { mobile: "13800000009", guestName: "张三", bookingNo: "BK3001" });
  check(
    "手机号与预订登记的不一致 → BIND_PROOF_FAILED，不绑定",
    wrongBookingMobile.body?.ok === false && wrongBookingMobile.body?.code === "BIND_PROOF_FAILED",
    j(wrongBookingMobile.body).slice(0, 140)
  );
  check("手机号不一致后仍未绑定", userRow(1).guest_id === null);

  const wrongRoomMobile = await bindWith("token-u1", { mobile: "13800000009", guestName: "张三", roomNo: "3001" });
  check(
    "房间号 3001 存在，但登记的 mobile 不是这个号 → BIND_PROOF_FAILED",
    wrongRoomMobile.body?.code === "BIND_PROOF_FAILED"
  );

  /* 文案不可区分：单号不存在 vs 手机号不一致，不能让枚举者看出「某手机号有没有预订」 */
  const noSuchBooking = await bindWith("token-u1", { mobile: "13800000001", guestName: "张三", bookingNo: "BK8888" });
  check(
    "「单号不存在」与「手机号不一致」返回同一句文案（不做存在性预言机）",
    String(noSuchBooking.body?.error ?? "").startsWith(String(wrongBookingMobile.body?.error ?? "").slice(0, 12)) &&
      String(wrongBookingMobile.body?.error ?? "").startsWith("没查到与该手机号一致的预订记录"),
    `noSuch=${String(noSuchBooking.body?.error ?? "").slice(0, 30)}`
  );

  /* ====================================================================== */
  /* 5. 小程序自助单不能作为手机号归属证明                                    */
  /* ====================================================================== */

  console.log("\n── 5. 小程序自助单不能作为手机号归属证明（清单第 435 行） ──");

  const selfBooking = await bindWith("token-u2", { mobile: "13800000003", guestName: "王五", bookingNo: "BK3003" });
  check(
    "用小程序自助单（BK3003）绑定 → BIND_PROOF_FAILED",
    selfBooking.body?.ok === false && selfBooking.body?.code === "BIND_PROOF_FAILED",
    j(selfBooking.body).slice(0, 180)
  );
  check(
    "拒绝文案明确说明「小程序自助下单的 mobile 不能证明归属」",
    /小程序自助下单/.test(String(selfBooking.body?.error ?? "")),
    String(selfBooking.body?.error ?? "").slice(0, 120)
  );
  check(
    "自助单被拒后没有绑定（guest_id 仍为空）",
    userRow(2).guest_id === null
  );
  check(
    "自助单被拒时也没有把 guest 档案创建出来（不会留下孤儿客史）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM guests WHERE mobile = '13800000003'`).get().n) === 1
  );

  /* 同一张单：即使 mobile 与 guest 档案完全一致，也必须拒绝 */
  ins(`INSERT INTO mini_program_bookings (hotel_id, mini_user_id, booking_id, created_at) VALUES (1, 2, 3, ?)`, iso(NOW_MS));
  const selfBookingAgain = await bindWith("token-u2", { mobile: "13800000003", guestName: "王五", bookingNo: "BK3003" });
  check(
    "即使这张自助单已关联到本微信，仍然不能作为绑定证明（来源不可信与归属无关）",
    selfBookingAgain.body?.code === "BIND_PROOF_FAILED"
  );

  /* ====================================================================== */
  /* 6. 合法单据可以绑定                                                     */
  /* ====================================================================== */

  console.log("\n── 6. 前台代建 / 渠道单 / 在住房间号可以绑定 ──");

  const okBooking = await bindWith("token-u1", { mobile: "13800000001", guestName: "张三", bookingNo: "BK3001" });
  check(
    "前台代建单（BK3001）+ 一致手机号 → 绑定成功",
    okBooking.status === 200 && okBooking.body?.ok === true && okBooking.body?.data?.bound === true,
    j(okBooking.body).slice(0, 160)
  );
  check("绑定成功的返回带证明来源 proof=booking", okBooking.body?.data?.proof === "booking");
  check("绑定成功落库（guest_id = 100）", Number(userRow(1).guest_id) === 100);
  check(
    "绑定响应姓名脱敏（张*，不含完整姓名）",
    String(okBooking.body?.data?.guestName ?? "") === "张*" && !okBooking.text.includes("张三"),
    `guestName=${okBooking.body?.data?.guestName}`
  );
  check(
    "绑定响应手机号脱敏（138****0001，不含完整号码）",
    String(okBooking.body?.data?.mobile ?? "") === "138****0001" && !okBooking.text.includes("13800000001")
  );
  check(
    "绑定响应不泄漏「该手机号在库里有没有档案」（无 matched 字段 / 无 VIP 等级真值）",
    !("matched" in (okBooking.body?.data ?? {})) &&
      !("vipLevel" in (okBooking.body?.data ?? {})) &&
      !("vip_level" in (okBooking.body?.data ?? {}))
  );

  const channelBooking = await bindWith("token-u3", { mobile: "13800000002", guestName: "李四", bookingNo: "BK3002" });
  check(
    "渠道单（channel_id 非空）→ 绑定成功，重名/重号档案按手机号命中（guest 101）",
    channelBooking.body?.ok === true && Number(userRow(3).guest_id) === 101,
    j(channelBooking.body).slice(0, 140)
  );

  const stayByRoom = await bindWith("token-u4", { mobile: "13800000001", guestName: "张三", roomNo: "3001" });
  check(
    "在住房间号（3001）+ 登记的 mobile 一致 → 绑定成功，proof=stay",
    stayByRoom.body?.ok === true && stayByRoom.body?.data?.proof === "stay" && Number(userRow(4).guest_id) === 100,
    j(stayByRoom.body).slice(0, 140)
  );
  const roomMismatch = await bindWith("token-u5", { mobile: "13800000001", guestName: "张三", roomNo: "3002" });
  check(
    "房间号 3002 是在住李四的房，用张三的手机号绑定 → BIND_PROOF_FAILED",
    roomMismatch.body?.code === "BIND_PROOF_FAILED"
  );

  /* ====================================================================== */
  /* 7. 已取消 / 已过离店日的单据不能绑定                                    */
  /* ====================================================================== */

  console.log("\n── 7. 已取消 / 已过离店日的单据不能绑定 ──");

  const cancelled = await bindWith("token-u5", { mobile: "13800000004", guestName: "赵六", bookingNo: "BK3004" });
  check(
    "已取消的预订 → BIND_PROOF_FAILED，文案说明已取消/已结束",
    cancelled.body?.code === "BIND_PROOF_FAILED" && /取消|结束/.test(String(cancelled.body?.error ?? "")),
    String(cancelled.body?.error ?? "").slice(0, 100)
  );
  check("已取消单据被拒后没有绑定", userRow(5).guest_id === null);

  const expiredBooking = await bindWith("token-u5", { mobile: "13800000005", guestName: "钱七", bookingNo: "BK3005" });
  check(
    "已过离店日的预订 → BIND_PROOF_FAILED，文案说明过期",
    expiredBooking.body?.code === "BIND_PROOF_FAILED" && /离店日期/.test(String(expiredBooking.body?.error ?? "")),
    String(expiredBooking.body?.error ?? "").slice(0, 100)
  );

  /* ====================================================================== */
  /* 8. 失败次数锁定（5 次 → 锁 30 分钟）                                    */
  /* ====================================================================== */

  console.log("\n── 8. 绑定失败次数限制（5 次锁 30 分钟，落库） ──");

  const beforeAttempts = Number(userRow(6).bind_attempts ?? 0);
  check("U6 初始失败计数为 0", beforeAttempts === 0);

  let lastFail = null;
  for (let i = 1; i <= 5; i += 1) {
    lastFail = await bindWith("token-u6", { mobile: "13800000001", guestName: "张三", bookingNo: "BK9999" });
  }
  const afterFive = userRow(6);
  check(
    "连续 5 次失败 → bind_attempts = 5",
    Number(afterFive.bind_attempts) === 5,
    `attempts=${afterFive.bind_attempts}`
  );
  check(
    "第 5 次失败后写入锁定截止时间（bind_locked_until 非空）",
    Boolean(String(afterFive.bind_locked_until ?? "").trim()),
    `lockedUntil=${afterFive.bind_locked_until}`
  );
  check(
    "失败文案提示「已锁定 30 分钟」",
    /锁定/.test(String(lastFail.body?.error ?? "")),
    String(lastFail.body?.error ?? "").slice(0, 120)
  );

  const lockedTry = await bindWith("token-u6", { mobile: "13800000001", guestName: "张三", bookingNo: "BK3001" });
  check(
    "锁定期间即使凭证正确也拒绝（BIND_LOCKED），不给枚举者留窗口",
    lockedTry.body?.ok === false && lockedTry.body?.code === "BIND_LOCKED",
    j(lockedTry.body).slice(0, 140)
  );
  check("锁定期间没有绑定成功", userRow(6).guest_id === null);

  const failLogs = db
    .prepare(`SELECT action, detail FROM op_logs WHERE hotel_id = 1 AND action = '小程序绑定失败'`)
    .all();
  check("绑定失败写 op_logs（小程序绑定失败）", failLogs.length >= 5, `行数 ${failLogs.length}`);
  check(
    "失败日志里手机号已脱敏（不含完整号码）",
    !failLogs.some((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(String(r.detail ?? ""))),
    String(failLogs[0]?.detail ?? "").slice(0, 100)
  );

  /* 锁定到期后正确凭证可以绑定，且失败计数被清零 */
  db.prepare(`UPDATE mini_program_users SET bind_locked_until = ? WHERE id = 6`).run(iso(NOW_MS - 60000));
  const unlocked = await bindWith("token-u6", { mobile: "13800000001", guestName: "张三", bookingNo: "BK3001" });
  check(
    "锁定到期后用正确凭证可以绑定（到期自动解锁，不需要人工介入）",
    unlocked.body?.ok === true && Number(userRow(6).guest_id) === 100,
    j(unlocked.body).slice(0, 140)
  );
  check(
    "绑定成功后失败计数与锁定被清零",
    Number(userRow(6).bind_attempts) === 0 && userRow(6).bind_locked_until === null
  );

  /* ====================================================================== */
  /* 9. 已绑定用户：同号幂等、异号拒绝换绑                                    */
  /* ====================================================================== */

  console.log("\n── 9. 已绑定用户不能换绑（越权的另一条路径） ──");

  const logsBefore = Number(db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE action LIKE '小程序绑定会员%'`).get().n);
  /*
   * 注意：bind 的入参校验（必须带预订号/房号）在「已绑定」判断之前，
   * 所以幂等重放也要按真实表单带上单据信息 —— 这里模拟页面把上次用的单号再提交一次。
   */
  const sameMobile = await bindWith("token-a", { mobile: "13800000001", guestName: "张三", bookingNo: "BK3001" });
  check(
    "已绑定同一手机号重复点绑定 → 幂等成功（bound:true，不报错）",
    sameMobile.body?.ok === true && sameMobile.body?.data?.bound === true,
    j(sameMobile.body).slice(0, 140)
  );
  check(
    "幂等重复绑定不重复写日志",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE action LIKE '小程序绑定会员%'`).get().n) === logsBefore
  );

  const changeToOther = await bindWith("token-a", { mobile: "13800000002", guestName: "李四", bookingNo: "BK3002" });
  check(
    "已绑定用户拿别人的手机号 + 正确证明来换绑 → CONFLICT（换绑必须走前台）",
    changeToOther.body?.ok === false && changeToOther.body?.code === "CONFLICT",
    j(changeToOther.body).slice(0, 140)
  );
  check("换绑被拒后 guest_id 没变（仍是 100）", Number(userRow(7).guest_id) === 100);

  /* ====================================================================== */
  /* 10. 解绑：二次确认 + token 立即失效                                     */
  /* ====================================================================== */

  console.log("\n── 10. 解绑需要二次确认，旧 token 立即失效 ──");

  const unbindNoToken = await call(routes.unbind, { method: "POST", body: {} });
  check("未登录调用解绑 → 401 UNAUTHORIZED", unbindNoToken.status === 401 && unbindNoToken.body?.code === "UNAUTHORIZED");

  const unbindUnbound = await call(routes.unbind, { token: "token-u2", method: "POST", body: {} });
  check(
    "未绑定用户调用解绑 → NOT_BOUND（不是异常）",
    unbindUnbound.body?.ok === false && unbindUnbound.body?.code === "NOT_BOUND",
    j(unbindUnbound.body).slice(0, 120)
  );

  /* step 1：只发确认指令，不改任何数据 */
  const step1 = await call(routes.unbind, { token: "token-a", method: "POST", body: {} });
  const confirmToken = String(step1.body?.data?.confirmToken ?? "");
  check(
    "step1（不带 confirmToken）→ stage=CONFIRM_REQUIRED，返回一次性 confirmToken",
    step1.body?.ok === true && step1.body?.data?.stage === "CONFIRM_REQUIRED" && confirmToken.includes("."),
    j(step1.body).slice(0, 200)
  );
  check("step1 不改数据库（guest_id 仍在）", Number(userRow(7).guest_id) === 100);
  check(
    "step1 的确认信息也脱敏（guestName 张* / mobile 138****0001）",
    String(step1.body?.data?.guestName ?? "") === "张*" &&
      String(step1.body?.data?.mobile ?? "") === "138****0001" &&
      !step1.text.includes("13800000001")
  );
  check(
    "step1 要求手输明文「解绑」（confirmText 字段）",
    String(step1.body?.data?.confirmText ?? "") === "解绑"
  );

  /* 只带 confirmText 不带 token → 仍然只到 step1 */
  const step1Again = await call(routes.unbind, { token: "token-a", method: "POST", body: { confirmText: "解绑" } });
  check(
    "只带 confirmText、不带 confirmToken → 回到 step1（CONFIRM_REQUIRED）",
    step1Again.body?.data?.stage === "CONFIRM_REQUIRED" && Number(userRow(7).guest_id) === 100
  );

  /* 明文不对 */
  const wrongText = await call(routes.unbind, {
    token: "token-a",
    method: "POST",
    body: { confirmToken, confirmText: "取消" },
  });
  check(
    "step2 明文不是「解绑」→ CONFIRM_REQUIRED 400，不解绑",
    wrongText.status === 400 && wrongText.body?.code === "CONFIRM_REQUIRED" && Number(userRow(7).guest_id) === 100,
    j(wrongText.body).slice(0, 140)
  );

  /* token 被篡改 */
  const tampered = confirmToken.slice(0, -2) + (confirmToken.endsWith("aa") ? "bb" : "aa");
  const badSig = await call(routes.unbind, {
    token: "token-a",
    method: "POST",
    body: { confirmToken: tampered, confirmText: "解绑" },
  });
  check(
    "confirmToken 被篡改 → CONFIRM_INVALID 400，不解绑",
    badSig.status === 400 && badSig.body?.code === "CONFIRM_INVALID" && Number(userRow(7).guest_id) === 100,
    j(badSig.body).slice(0, 140)
  );

  /* 别人的 confirmToken（B 生成，A 使用） */
  const step1B = await call(routes.unbind, { token: "token-b", method: "POST", body: {} });
  const tokenB = String(step1B.body?.data?.confirmToken ?? "");
  const crossUser = await call(routes.unbind, {
    token: "token-a",
    method: "POST",
    body: { confirmToken: tokenB, confirmText: "解绑" },
  });
  check(
    "用 B 的 confirmToken 解绑 A 的账号 → CONFIRM_INVALID（三元组 h/u/g 校验）",
    crossUser.status === 400 && crossUser.body?.code === "CONFIRM_INVALID" && Number(userRow(7).guest_id) === 100,
    j(crossUser.body).slice(0, 140)
  );

  /* 正确确认 → 解绑 */
  const step2 = await call(routes.unbind, {
    token: "token-a",
    method: "POST",
    body: { confirmToken, confirmText: "解绑" },
  });
  check(
    "step2 正确确认 → stage=UNBOUND + loggedOut",
    step2.body?.ok === true && step2.body?.data?.stage === "UNBOUND" && step2.body?.data?.loggedOut === true,
    j(step2.body).slice(0, 160)
  );
  check("解绑后 guest_id 置空", userRow(7).guest_id === null);
  check(
    "解绑后当前 token 立即吊销（session_token / token_expires_at 都清空）",
    userRow(7).session_token === null && userRow(7).token_expires_at === null
  );

  const afterUnbind = await call(routes.member, { token: "token-a", ua: "bind-after-unbind" });
  check(
    "解绑后旧 token 请求会员信息 → 401（不是继续返回旧数据）",
    afterUnbind.status === 401 && afterUnbind.body?.code === "UNAUTHORIZED"
  );
  const afterUnbindStay = await call(routes.staysCurrent, { token: "token-a", ua: "bind-after-unbind-2" });
  check("解绑后旧 token 请求在住信息 → 401", afterUnbindStay.status === 401);

  check(
    "解绑不删除业务数据（客史 / 在住单 / 账单都还在）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM guests WHERE id = 100`).get().n) === 1 &&
      Number(db.prepare(`SELECT COUNT(*) AS n FROM stays WHERE id = 500`).get().n) === 1
  );
  check(
    "解绑写 op_logs（小程序解绑，操作人标明是微信用户）",
    db.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE action = '小程序解绑'`).get().n >= 1
  );
  check(
    "解绑后发一条站内通知（type = UNBOUND）",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_notifications WHERE mini_user_id = 7 AND type = 'UNBOUND'`).get().n) === 1
  );
  check(
    "解绑日志与通知里都没有完整手机号",
    !db
      .prepare(`SELECT detail FROM op_logs WHERE action = '小程序解绑'`)
      .all()
      .some((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(String(r.detail ?? "")))
  );

  /* 重新登录（模拟 wx.login 换新 token）后可以重新绑定 */
  db.prepare(`UPDATE mini_program_users SET session_token = 'token-a2', token_expires_at = ? WHERE id = 7`).run(
    iso(NOW_MS + 6 * 86400000)
  );
  const rebind = await bindWith("token-a2", { mobile: "13800000001", guestName: "张三", bookingNo: "BK3001" });
  check(
    "解绑后重新绑定同一手机号成功（解绑只解关系，不影响再次绑定）",
    rebind.body?.ok === true && Number(userRow(7).guest_id) === 100,
    j(rebind.body).slice(0, 140)
  );
}

/* ========================================================================== */
/* 11. 清理 + 真库零写入                                                       */
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

console.log("\n── 11. 真库零写入验证 ──");

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
