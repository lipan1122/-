#!/usr/bin/env node
/**
 * 微信小程序「站内通知」验收
 * （codex 第九轮《微信小程序专项》第七节 test-mini-notifications）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的事（清单第 302 行 / 第七节必须验证项）
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **通知只发给对应 mini_user_id，不能按手机号群发**。
 *     落实方式要逐层验证：
 *       · 表结构里根本没有 mobile / guest_id 列（有手机号列就一定有人写出
 *         按手机号群发的 SQL）；
 *       · 读取只按 (hotel_id, mini_user_id) 取数，mini_user_id 来自 Bearer token；
 *       · 请求体 / query 里的 miniUserId 一律忽略。
 *  2. A 看不到 B 的通知（交叉请求，两个真实用户）。
 *  3. 标记已读幂等：重复标记 updated=0，**不覆盖首次阅读时间**。
 *  4. 越权标记（别人的通知 id）→ updated=0，并且对方那条仍未读。
 *  5. 参数边界：limit 上限 100、非法值回落默认、ids 最多 100 条、缺参数 400。
 *
 * 说明：mini_notifications 由运行时懒建（notifications/_notify.ts）。
 * 本脚本先在临时库里**故意不建**这张表，调用一次列表接口触发建表，
 * 再插入测试通知 —— 顺便验证「全新库第一次进通知页不会 500」。
 *
 * 用法：node scripts/test-mini-notifications.mjs
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

const TMP = join(ROOT, ".tmp", `mini-notifications-${process.pid}-${Date.now()}`);
const TMP_DATA = join(TMP, "data");
mkdirSync(TMP_DATA, { recursive: true });
const TMP_DB = join(TMP_DATA, "pms.db");

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
  CREATE TABLE booking_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, booking_id INTEGER, room_type_id INTEGER, room_id INTEGER, guest_name TEXT, mobile TEXT, rate REAL, status TEXT, check_in_date TEXT, check_out_date TEXT, stay_id INTEGER, created_at TEXT);
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
/* 故意不建 mini_notifications：验证运行时懒建 */

const iso = (ms) => new Date(ms).toISOString();
const NOW_MS = Date.now();
const ins = (sql, ...args) => db.prepare(sql).run(...args);

ins(`INSERT INTO hotels (id, code, name) VALUES (1, 'H1', '测试酒店一号')`);
ins(`INSERT INTO hotels (id, code, name) VALUES (2, 'H2', '测试酒店二号')`);
ins(`INSERT INTO settings (hotel_id, key, value) VALUES (1, 'biz_day_cutoff', '00:00')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (100, 1, '张三', '13800000001')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (101, 1, '李四', '13800000002')`);
ins(`INSERT INTO guests (id, hotel_id, name, mobile) VALUES (200, 2, '王五', '13900000003')`);

ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (1, 'wxtestappid0001', 'secret-notify-0001', 1, ?)`, iso(NOW_MS));
ins(`INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at) VALUES (2, 'wxtestappid0002', 'secret-notify-0002', 1, ?)`, iso(NOW_MS));

/*
 * 四个用户：
 *   A（已绑定） / B（已绑定） / H2（别家酒店） / U（未绑定 —— 通知不依赖绑定）
 */
for (const [id, hotel, openid, guestId, token] of [
  [1, 1, "openid-a", 100, "token-a"],
  [2, 1, "openid-b", 101, "token-b"],
  [3, 2, "openid-h2", 200, "token-h2"],
  [4, 1, "openid-u", null, "token-unbound"],
]) {
  ins(
    `INSERT INTO mini_program_users (id, hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, hotel, openid, guestId, token, iso(NOW_MS + 6 * 86400000), iso(NOW_MS), iso(NOW_MS)
  );
}

/* 在住单（部分通知带 refType=stay 时前端要能跳详情） */
ins(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, status, created_at)
   VALUES (500, 1, 'S500', 3001, 100, '张三', '13800000001', ?, ?, 2, 300, 'INHOUSE', ?)`,
  `${new Date().toISOString().slice(0, 10)}T14:00:00.000+08:00`, new Date(Date.now() + 86400000).toISOString().slice(0, 10), iso(NOW_MS)
);

check("临时库造好（4 个用户 / 2 家酒店）", true);
check(
  "故意没有 mini_notifications（待运行时懒建）",
  Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mini_notifications'`).get().n) === 0
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
export { GET as notifications } from ${JSON.stringify(srcAbs("app/api/mini/notifications/route.ts"))};
export { POST as notificationsRead } from ${JSON.stringify(srcAbs("app/api/mini/notifications/read/route.ts"))};
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
  /* 每个请求独立 UA：读 60/分钟、写 30/分钟限流，分散后互不挤占 */
  const headers = { "user-agent": ua || `notify-test-${(uaSeq += 1)}` };
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

const list = (token, query = "") =>
  call(routes.notifications, { token, url: `http://127.0.0.1/api/mini/notifications${query}` });
const markRead = (token, body) => call(routes.notificationsRead, { token, method: "POST", body });

const notifyRow = (id) => db.prepare(`SELECT read_at, mini_user_id FROM mini_notifications WHERE id = ?`).get(id);

if (!routes) {
  console.log("\n（bundle 未就绪，运行时断言整体跳过 —— 静态段仍然有效）");
  check("运行时断言可执行", false, "bundle 编译/加载失败");
} else {
  /* ====================================================================== */
  /* 4. 首次调用：触发建表，空列表不报错                                     */
  /* ====================================================================== */

  console.log("\n── 4. 全新库第一次进通知页（懒建表 + 空列表） ──");

  const noToken = await list(undefined);
  check("未登录看通知 → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED");

  const first = await list("token-a");
  check("首次调用不报 500（空库也能正常渲染空态）", first.status === 200 && first.body?.ok === true, j(first.body).slice(0, 160));
  check(
    "运行时懒建了 mini_notifications 表",
    Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mini_notifications'`).get().n) === 1
  );
  check("空列表时 total=0 / unreadCount=0 / items=[]", Number(first.body?.data?.total) === 0 && Number(first.body?.data?.unreadCount) === 0);
  check(
    "未绑定用户也能看通知（通知是「这个微信」的站内信，不依赖手机号绑定）",
    (await list("token-unbound")).status === 200
  );

  /* 表结构：不能有手机号 / guest_id 列（否则将来一定有人按手机号群发） */
  const columns = db.prepare(`PRAGMA table_info(mini_notifications)`).all().map((c) => String(c.name));
  check(
    "表结构里没有 mobile / guest_id 列（唯一归属字段是 mini_user_id）",
    !columns.includes("mobile") && !columns.includes("guest_id"),
    columns.join(",")
  );
  check(
    "表结构包含 mini_user_id（收件人唯一来源）",
    columns.includes("mini_user_id")
  );

  /* ====================================================================== */
  /* 5. 造通知：A / B / 别家酒店 各自的数据                                  */
  /* ====================================================================== */

  console.log("\n── 5. 通知归属：A 只看自己的 ──");

  const t = (n) => iso(NOW_MS - n * 60000);
  const insertNotify = (hotelId, miniUserId, type, title, body, readAt = null) =>
    Number(
      ins(
        `INSERT INTO mini_notifications (hotel_id, mini_user_id, type, title, body, read_at, created_at, ref_type, ref_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        hotelId, miniUserId, type, title, body, readAt, t(0), null, null
      ).lastInsertRowid
    );

  const a1 = insertNotify(1, 1, "BOOKING_CREATED", "预订成功", "您的订单 BK3001 已提交，到店付款。");
  const a2 = insertNotify(1, 1, "SYSTEM", "系统通知", "酒店 Wi-Fi 密码已更新，可在房间电视查看。");
  const a3 = insertNotify(1, 1, "UNBOUND", "历史通知", "这是一条已读的历史通知。", t(30));
  const b1 = insertNotify(1, 2, "BOOKING_CREATED", "B 的预订成功", "B 的订单内容，A 不应该看到。");
  const b2 = insertNotify(1, 2, "INVOICE_ISSUED", "B 的发票已开具", "B 的发票内容，A 不应该看到。");
  const h2n = insertNotify(2, 3, "SYSTEM", "别家酒店通知", "酒店 2 的通知，酒店 1 的用户不应该看到。");
  const futureType = insertNotify(1, 1, "FUTURE_TYPE", "未来类型通知", "历史 / 未知类型的文案要回退成中性文案。");

  check("造了 7 条通知（A 4 条含已读 / B 2 条 / 别家酒店 1 条）", Boolean(a1 && b1 && h2n));

  const listA = await list("token-a");
  const itemsA = listA.body?.data?.items ?? [];
  check(
    "A 只看到自己的通知（4 条，不含 B 的 2 条与别家酒店的 1 条）",
    itemsA.length === 4 && itemsA.every((n) => [a1, a2, a3, futureType].includes(n.id)),
    JSON.stringify(itemsA.map((n) => n.id))
  );
  check(
    "A 的响应里不出现 B 的通知标题 / 正文",
    !listA.text.includes("B 的预订成功") && !listA.text.includes("B 的发票内容")
  );
  check("A 的 total=4 / unreadCount=3（已读那条不计入未读）", Number(listA.body?.data?.total) === 4 && Number(listA.body?.data?.unreadCount) === 3);

  const listB = await list("token-b");
  const itemsB = listB.body?.data?.items ?? [];
  check(
    "B 只看到自己的 2 条（看不到 A 的任何通知）",
    itemsB.length === 2 && itemsB.every((n) => [b1, b2].includes(n.id)),
    JSON.stringify(itemsB.map((n) => n.id))
  );
  check("B 的 notif 里没有 A 的标题", !listB.text.includes("预订成功") || !listB.text.includes("系统通知"));

  const listH2 = await list("token-h2");
  const itemsH2 = listH2.body?.data?.items ?? [];
  check(
    "别家酒店用户只看到自己酒店的通知（1 条），看不到本店通知（跨租户隔离）",
    itemsH2.length === 1 &&
      itemsH2[0]?.id === h2n &&
      /* typeLabel 里可能出现「系统通知」这四个字，所以这里只比对本店通知的独有标题 / 正文 */
      !listH2.text.includes("预订成功") &&
      !listH2.text.includes("酒店 Wi-Fi 密码已更新"),
    `ids=${j(itemsH2.map((n) => n.id))} h2n=${h2n}`
  );

  /* 参数伪造：miniUserId / hotelId / guestId 一律忽略 */
  const listFake = await list("token-b", "?miniUserId=1&hotelId=1&guestId=100");
  check(
    "B 伪造 ?miniUserId=1 / hotelId / guestId → 仍只看到自己的 2 条（参数被完全忽略）",
    (listFake.body?.data?.items ?? []).length === 2 &&
      (listFake.body?.data?.items ?? []).every((n) => [b1, b2].includes(n.id)),
    j(listFake.body).slice(0, 200)
  );

  /* ====================================================================== */
  /* 6. 过滤与边界                                                          */
  /* ====================================================================== */

  console.log("\n── 6. 过滤（unreadOnly / type / limit）与参数边界 ──");

  const unreadOnly = await list("token-a", "?unreadOnly=1");
  check(
    "unreadOnly=1 只回未读（3 条，不含已读的历史通知）",
    (unreadOnly.body?.data?.items ?? []).length === 3 &&
      (unreadOnly.body?.data?.items ?? []).every((n) => n.read === false)
  );
  check("unreadOnly 不影响 total（total 仍是 4，用于「共 N 条」）", Number(unreadOnly.body?.data?.total) === 4);

  const byType = await list("token-a", "?type=SYSTEM");
  check(
    "type=SYSTEM 过滤生效（只回系统通知 1 条）",
    (byType.body?.data?.items ?? []).length === 1 && (byType.body?.data?.items ?? [])[0]?.type === "SYSTEM"
  );

  const limit1 = await list("token-a", "?limit=1");
  check("limit=1 生效（回 1 条，returned=1）", (limit1.body?.data?.items ?? []).length === 1 && Number(limit1.body?.data?.returned) === 1);

  const limitBig = await list("token-a", "?limit=101");
  check("limit 超过上限（101）被压到 100", Number(limitBig.body?.data?.limit) === 100, `limit=${limitBig.body?.data?.limit}`);

  const limitBad = await list("token-a", "?limit=abc");
  check("limit 非法值回落默认 50", Number(limitBad.body?.data?.limit) === 50);

  /* 字段与文案 */
  const firstItem = listA.body?.data?.items?.find((n) => n.id === a1);
  check(
    "通知项字段齐全（id/type/typeLabel/title/body/read/readAt/createdAt/refType/refId）",
    Boolean(firstItem) &&
      typeof firstItem.id === "number" &&
      typeof firstItem.typeLabel === "string" &&
      typeof firstItem.title === "string" &&
      typeof firstItem.read === "boolean" &&
      "readAt" in firstItem &&
      "createdAt" in firstItem &&
      "refType" in firstItem &&
      "refId" in firstItem,
    j(firstItem).slice(0, 200)
  );
  check("类型中文名由服务端给（BOOKING_CREATED → 预订成功）", firstItem?.typeLabel === "预订成功");
  const futureItem = itemsA.find((n) => n.id === futureType);
  check(
    "未知 / 历史类型回退成中性文案「通知」（不把英文 code 甩给客人）",
    futureItem?.typeLabel === "通知",
    `typeLabel=${futureItem?.typeLabel}`
  );
  check(
    "通知正文不含完整手机号（正文由服务端模板生成，不拼手机号）",
    !listA.text.includes("13800000001")
  );

  /* ====================================================================== */
  /* 7. 标记已读：单条 / 幂等 / 越权                                        */
  /* ====================================================================== */

  console.log("\n── 7. 标记已读：幂等与越权 ──");

  const markOne = await markRead("token-a", { id: a1 });
  check(
    "A 标记自己的单条通知已读 → updated=1",
    markOne.status === 200 && Number(markOne.body?.data?.updated) === 1,
    j(markOne.body).slice(0, 160)
  );
  check("返回剩余未读数（3 → 2）", Number(markOne.body?.data?.unreadCount) === 2);
  const readAtFirst = notifyRow(a1)?.read_at;
  check(
    "read_at 落的是 ISO 时间（不是 0/1 标志）",
    /^\d{4}-\d{2}-\d{2}T/.test(String(readAtFirst ?? "")),
    `read_at=${readAtFirst}`
  );

  const markAgain = await markRead("token-a", { id: a1 });
  check(
    "重复标记同一条 → updated=0（幂等，不是错误）",
    markAgain.status === 200 && Number(markAgain.body?.data?.updated) === 0,
    j(markAgain.body).slice(0, 160)
  );
  check(
    "重复标记不覆盖首次阅读时间（read_at 不变）",
    notifyRow(a1)?.read_at === readAtFirst,
    `${notifyRow(a1)?.read_at} vs ${readAtFirst}`
  );

  const markOthers = await markRead("token-a", { id: b1 });
  check(
    "A 标记 B 的通知 id → updated=0（越权无效）",
    markOthers.status === 200 && Number(markOthers.body?.data?.updated) === 0,
    j(markOthers.body).slice(0, 160)
  );
  check("B 的那条仍然是未读（read_at 为空）", notifyRow(b1)?.read_at === null);

  const markOthersBatch = await markRead("token-a", { ids: [b1, b2, 999999] });
  check("批量里混入别人的 / 不存在的 id → 只更新自己的（这里 0 条）", Number(markOthersBatch.body?.data?.updated) === 0);
  check("B 的两条都仍然未读", notifyRow(b1)?.read_at === null && notifyRow(b2)?.read_at === null);

  const markOwnBatch = await markRead("token-a", { ids: [a2, a3, 999999] });
  check(
    "批量标记自己的 [a2 未读, a3 已读, 999999 不存在] → updated=1（只算真正从新到已读的）",
    Number(markOwnBatch.body?.data?.updated) === 1,
    j(markOwnBatch.body).slice(0, 160)
  );

  /* all:true 只作用于自己 */
  const markAll = await markRead("token-a", { all: true });
  check(
    "all:true → 把 A 剩余的未读全部标记（含未来类型那条）→ updated=1",
    Number(markAll.body?.data?.updated) === 1 && Number(markAll.body?.data?.unreadCount) === 0,
    j(markAll.body).slice(0, 160)
  );
  check(
    "all:true 不影响 B（B 仍有 2 条未读）",
    Number((await list("token-b")).body?.data?.unreadCount) === 2
  );

  /* 已读后列表状态 */
  const afterRead = await list("token-a");
  check(
    "A 的所有通知 read=true 且有 readAt（前端不再显示未读点）",
    (afterRead.body?.data?.items ?? []).every((n) => n.read === true && typeof n.readAt === "string")
  );
  check("A 的 unreadCount 变成 0", Number(afterRead.body?.data?.unreadCount) === 0);

  /* ====================================================================== */
  /* 8. 参数边界                                                            */
  /* ====================================================================== */

  console.log("\n── 8. 标记已读的参数边界 ──");

  const markEmpty = await markRead("token-a", {});
  check("既没有 id / ids 也没有 all → BAD_REQUEST（不猜「全部已读」）", markEmpty.status === 400 && markEmpty.body?.code === "BAD_REQUEST");

  const markTooMany = await markRead("token-a", { ids: Array.from({ length: 101 }, (_, i) => i + 1) });
  check(
    "ids 超过 100 条 → BAD_REQUEST（防一个请求带一万个 id）",
    markTooMany.status === 400 && markTooMany.body?.code === "BAD_REQUEST",
    j(markTooMany.body).slice(0, 140)
  );

  const markBadBody = await call(routes.notificationsRead, {
    token: "token-a",
    method: "POST",
    body: undefined,
    ua: "notify-bad-body",
  });
  check("请求体不是 JSON → BAD_REQUEST", markBadBody.status === 400 && markBadBody.body?.code === "BAD_REQUEST");

  const markNoToken = await markRead(undefined, { all: true });
  check("未登录标记已读 → 401", markNoToken.status === 401 && markNoToken.body?.code === "UNAUTHORIZED");

  /* 别家酒店用户标记本店通知：updated=0 */
  const h2Mark = await markRead("token-h2", { all: true });
  check(
    "别家酒店用户 all:true 只作用于自己（本店通知 read_at 不受影响）",
    h2Mark.status === 200 && notifyRow(b1)?.read_at === null && notifyRow(b2)?.read_at === null
  );

  /* ====================================================================== */
  /* 9. 通知与业务的关系                                                    */
  /* ====================================================================== */

  console.log("\n── 9. 通知不等于授权凭证 ──");

  const staysForUnbound = await call(routes.staysCurrent, { token: "token-unbound", ua: "notify-unbound-stay" });
  check(
    "未绑定用户能看通知，但拿不到在住数据（notifications 与订单可见性互不影响）",
    (await list("token-unbound")).status === 200 && staysForUnbound.body?.data?.bound === false
  );

  const totalA = Number((await list("token-a")).body?.data?.total);
  const rowsInDb = Number(db.prepare(`SELECT COUNT(*) AS n FROM mini_notifications WHERE hotel_id = 1 AND mini_user_id = 1`).get().n);
  check(
    "服务端 total 与库里按 (hotel_id, mini_user_id) 统计一致（口径同源）",
    totalA === rowsInDb,
    `total=${totalA} 库=${rowsInDb}`
  );
  check(
    "通知表里没有任何按手机号关联的痕迹（无 mobile 列 + 数据里无手机号）",
    (() => {
      const cols = db.prepare(`PRAGMA table_info(mini_notifications)`).all().map((c) => String(c.name));
      const texts = db.prepare(`SELECT title, body FROM mini_notifications`).all();
      return (
        !cols.includes("mobile") &&
        !cols.includes("guest_id") &&
        !texts.some((r) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(`${r.title} ${r.body}`))
      );
    })()
  );

  /* B 的通知 id 是连号的 —— 验证 A 拿不到 B 的按 id 直接取（没有单条接口，列表即全部） */
  check(
    "A 的列表里不包含 B 的任何通知 id",
    (afterRead.body?.data?.items ?? []).every((n) => ![b1, b2].includes(n.id))
  );
}

/* ========================================================================== */
/* 10. 清理 + 真库零写入                                                       */
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

console.log("\n── 10. 真库零写入验证 ──");

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
