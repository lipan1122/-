/**
 * 小程序会员储值 / 解绑 / 通知 / 早餐 / 发票 验收（codex 第九轮《微信小程序专项》第七节）
 *
 * ── 为什么这个测试能断言「余额一致」而不仅是「 fórmula 一致」 ──
 *
 * 项目里已有的 mini 测试（test-miniprogram.mjs）是在临时库里**重跑路由里的 SQL**，
 * 再拿结果和预期比 —— 那只能证明「这段 SQL 算得对」，不能证明「路由真的调用了这段 SQL」。
 * 本测试更进一步：**直接 import 真实的路由模块并调用它的 GET / POST 处理函数**，
 * 断言真实的 HTTP 响应体。做法：
 *   1. 临时目录里造一个干净的 SQLite 库（data/pms.db），process.chdir 过去，
 *      于是 src/lib/db.ts 打开的就是这个临时库（它按 cwd/data/pms.db 找库）；
 *   2. Node 24 原生支持直接 import .ts（类型剥离），再用一个极小的 ESM resolve hook
 *      把 `@/xxx` 解析到 src/xxx、把无扩展名的相对导入补成 .ts；
 *   3. `await import(route.ts)` 拿到 { GET, POST }，用标准 Request 调用，
 *      读 res.status + res.json()。
 *   → 全程不依赖 3100 那个 next start 进程（它是别的构建产物，新路由要重新 build 才有），
 *     真正被测的是**当前源码**。
 *
 * ── 覆盖的断言（清单第七节点名的五条 + 相关安全项）──
 *   1. 小程序读到的余额 = getWalletBalance() = PC 端余额（不是旧表 member_wallet 的缓存）
 *   2. 流水条数与 member_wallet_ledger 完全一致
 *   3. 解绑后旧 token 立即失效（401）
 *   4. 未绑定用户读 ledger → NOT_BOUND（不是空列表，也不是别人的数据）
 *   5. A 用户看不到 B 用户的流水（双向验证）
 *   附加：解绑二次确认（错误明文 / 篡改 token / 正确 token 三种分支）、
 *         通知只发给对应 mini_user_id（结构 + 读写两个方向）、
 *         早餐金额服务端计算 + request_id 幂等、发票只能给自己已结清账单开、
 *         酒店 / 房型公开接口不编造未配置字段、不泄漏房量等经营数据。
 *
 * 跑完删除临时目录，绝不污染 data/pms.db。
 *
 * 用法：node scripts/test-mini-member-wallet.mjs
 */

/* 直接调用路由处理函数要用标准 Request（Node ≥ 18 全局提供；这里显式声明给 ESLint） */
/* global Request */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let pass = 0;
let fail = 0;
const failed = [];

/** 断言：名称 + 布尔 + 失败时的补充信息 */
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

/* ========================================================================== */
/* 0. 临时库 + 造数                                                           */
/* ========================================================================== */

const TMP_ROOT = join(ROOT, ".tmp");
mkdirSync(TMP_ROOT, { recursive: true });
const TMP = join(TMP_ROOT, `mini-wallet-${process.pid}-${Date.now()}`);
const TMP_DATA = join(TMP, "data");
mkdirSync(TMP_DATA, { recursive: true });
const DB_PATH = join(TMP_DATA, "pms.db");

const now = new Date();
const iso = (d = new Date()) => d.toISOString();
const isoNext = (ms) => new Date(Date.now() + ms).toISOString();
const isoPast = (ms) => new Date(Date.now() - ms).toISOString();
/** 本地日期 YYYY-MM-DD（与 biz-date 的 bizToday 口径一致：默认 cutoff 00:00 → 自然日） */
const ymd = (offsetDays = 0) => {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------- 身份种子 ---------- */
const HOTEL = 1;
const GUEST_A = 101; // 张三：流水 3 条（+500 / -120.5 / -50）
const GUEST_B = 202; // 李四：流水 1 条（+1000）
const GUEST_E = 303; // 王五：只用于解绑流程
const USER_A = 1;
const USER_B = 2;
const USER_C = 3; // 已登录但未绑定手机号
const USER_D = 4; // token 已过期
const USER_E = 5; // 解绑测试对象
const TOKEN_A = "testtokena00000000000000000000a1";
const TOKEN_B = "testtokenb00000000000000000000b1";
const TOKEN_C = "testtokenc00000000000000000000c1";
const TOKEN_D = "testtokend00000000000000000000d1";
const TOKEN_E = "testtokene00000000000000000000e1";

const BALANCE_A = 329.5; // 500 - 120.5 - 50
const BAD_CACHE_A = 999; // 旧表 member_wallet.balance：故意写错，用来证明路由没读它
const BREAKFAST_PRICE = 68;

const db = new DatabaseSync(DB_PATH);

/* 只建本测试用到的表；结构与 scripts/schema-full.sql 一致（列数/列名不能少，
   路由里的 SELECT 会直接点名取列）。钱包表、mini 表、invoices 表由路由自己 ensure，
   这里先建出来是为了「路由跑之前就能造数」。 */
db.exec(`
  CREATE TABLE hotels (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, address TEXT, phone TEXT, logo TEXT, created_at TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT);
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT NOT NULL,
    gender TEXT, id_type TEXT, id_no TEXT, mobile TEXT, company TEXT,
    vip_level INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0, note TEXT, created_at TEXT, deleted INTEGER DEFAULT 0
  );
  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_no TEXT NOT NULL,
    floor INTEGER, room_type_id INTEGER NOT NULL, status TEXT DEFAULT 'VC', feature TEXT, sort INTEGER DEFAULT 0
  );
  CREATE TABLE room_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
    bed_type TEXT, area REAL, max_occupancy INTEGER DEFAULT 2, base_price REAL DEFAULT 0, sort INTEGER DEFAULT 0,
    images TEXT, facilities TEXT, breakfast_note TEXT, cancellation_policy TEXT,
    check_in_time TEXT, check_out_time TEXT, deposit_note TEXT
  );
  CREATE TABLE rate_calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, room_type_id INTEGER NOT NULL,
    date TEXT NOT NULL, price REAL, allotment INTEGER
  );
  CREATE TABLE stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, stay_no TEXT, booking_id INTEGER,
    room_id INTEGER NOT NULL, guest_id INTEGER, guest_name TEXT, mobile TEXT,
    check_in_time TEXT, expect_check_out TEXT, actual_check_out TEXT, nights INTEGER,
    rate REAL, deposit REAL DEFAULT 0, guest_count INTEGER DEFAULT 1, status TEXT DEFAULT 'INHOUSE',
    channel_id INTEGER, remark TEXT, team_name TEXT, member_card TEXT, member_type TEXT,
    rate_code TEXT, salesman TEXT, package_code TEXT, invoice_party TEXT, pay_type TEXT,
    breakfast INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT, channel_order_no TEXT
  );
  CREATE TABLE folios (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_no TEXT NOT NULL,
    stay_id INTEGER, guest_name TEXT, room_no TEXT,
    total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, balance REAL DEFAULT 0,
    status TEXT DEFAULT 'OPEN', created_at TEXT, settled_at TEXT
  );
  CREATE TABLE folio_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, folio_id INTEGER NOT NULL,
    item_type TEXT NOT NULL, description TEXT, qty REAL DEFAULT 1, price REAL DEFAULT 0, amount REAL DEFAULT 0,
    biz_date TEXT, created_at TEXT, created_by INTEGER, request_id TEXT
  );
  CREATE TABLE op_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, operator TEXT, action TEXT, detail TEXT, created_at TEXT);
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
  CREATE TABLE mini_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, mini_user_id INTEGER NOT NULL,
    type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, read_at TEXT, created_at TEXT,
    ref_type TEXT, ref_id INTEGER
  );
  CREATE INDEX idx_mini_notifications_user ON mini_notifications(hotel_id, mini_user_id, read_at);
  CREATE TABLE member_wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
    biz_type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
    ref_type TEXT, ref_id INTEGER, request_id TEXT, operator TEXT, remark TEXT, created_at TEXT
  );
  CREATE TABLE member_wallet (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, member_id INTEGER,
    guest_name TEXT, balance REAL DEFAULT 0, amount REAL DEFAULT 0, type TEXT DEFAULT 'RECHARGE',
    note TEXT, updated_at TEXT, created_at TEXT
  );
`);

/* ---------- 酒店 / 设置 / 联系人 ---------- */
db.prepare(`INSERT INTO hotels (id, code, name, address, phone, logo, created_at) VALUES (?,?,?,?,?,?,?)`).run(
  HOTEL,
  "YQ",
  "云栖国际酒店",
  "杭州市西湖区文三路 1 号",
  "0571-88886666",
  null,
  iso()
);
const settingStmt = db.prepare(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`);
for (const [k, v] of [
  ["check_in_time", "14:00"],
  ["check_out_time", "12:00"],
  ["biz_day_cutoff", "00:00"],
  ["breakfast_price", String(BREAKFAST_PRICE)],
]) {
  settingStmt.run(HOTEL, k, v);
}

/* ---------- 小程序配置（enabled + AppID/AppSecret ⇒ miniConfigured = true） ----------
   注意：这里刻意用一个「不像真实 AppID」的占位串（带连字符，命中不了 wx+16 位字母数字
   的扫描规则）——scripts/test-miniprogram.mjs 会全项目扫描真实 AppID 字面量，
   测试文件里写 wx 开头的合成值会误报。 */
db.prepare(
  `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, mch_id, mch_key, enabled, updated_at) VALUES (?,?,?,?,?,?,?)`
).run(HOTEL, "wx-placeholder-test-appid", "placeholder-test-secret", "", "", 1, iso());

/* ---------- 客史 ---------- */
const guestStmt = db.prepare(
  `INSERT INTO guests (id, hotel_id, name, mobile, vip_level, created_at, deleted) VALUES (?,?,?,?,?,?,0)`
);
guestStmt.run(GUEST_A, HOTEL, "张三", "13800001111", 1, iso());
guestStmt.run(GUEST_B, HOTEL, "李四", "13900002222", 0, iso());
guestStmt.run(GUEST_E, HOTEL, "王五", "13700003333", 0, iso());

/* ---------- 小程序用户（token ↔ 客史绑定） ---------- */
const userStmt = db.prepare(
  `INSERT INTO mini_program_users
     (id, hotel_id, openid, unionid, guest_id, mobile, session_token, token_expires_at,
      bind_attempts, bind_locked_until, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,0,NULL,?,?)`
);
userStmt.run(USER_A, HOTEL, "openid-a", null, GUEST_A, "13800001111", TOKEN_A, isoNext(3_600_000), iso(), iso());
userStmt.run(USER_B, HOTEL, "openid-b", null, GUEST_B, "13900002222", TOKEN_B, isoNext(3_600_000), iso(), iso());
userStmt.run(USER_C, HOTEL, "openid-c", null, null, null, TOKEN_C, isoNext(3_600_000), iso(), iso());
userStmt.run(USER_D, HOTEL, "openid-d", null, GUEST_A, "13800001111", TOKEN_D, isoPast(60_000), iso(), iso());
userStmt.run(USER_E, HOTEL, "openid-e", null, GUEST_E, "13700003333", TOKEN_E, isoNext(3_600_000), iso(), iso());

/* ---------- 储值流水（唯一记账明细） ----------
   余额恒等于 SUM(amount)：500 - 120.5 - 50 = 329.5
   同时把 member_wallet.balance 写成 999（旧缓存列，故意错），用来证明小程序没读它。 */
const ledgerStmt = db.prepare(
  `INSERT INTO member_wallet_ledger (hotel_id, member_id, biz_type, amount, balance_after, operator, remark, created_at)
   VALUES (?,?,?,?,?,?,?,?)`
);
ledgerStmt.run(HOTEL, GUEST_A, "RECHARGE", 500, 500, "前台小李", "现金充值", iso(new Date(now.getTime() - 3 * 86400_000)));
ledgerStmt.run(HOTEL, GUEST_A, "CONSUME", -120.5, 379.5, "收银台", "房费抵扣", iso(new Date(now.getTime() - 2 * 86400_000)));
ledgerStmt.run(HOTEL, GUEST_A, "REFUND", -50, 329.5, "前台小李", "余额退款", iso(new Date(now.getTime() - 86400_000)));
ledgerStmt.run(HOTEL, GUEST_B, "RECHARGE", 1000, 1000, "前台小张", "转账充值", iso(new Date(now.getTime() - 86400_000)));
db.prepare(`INSERT INTO member_wallet (hotel_id, member_id, guest_name, balance) VALUES (?,?,?,?)`).run(
  HOTEL,
  GUEST_A,
  "张三",
  BAD_CACHE_A
);
db.prepare(`INSERT INTO member_wallet (hotel_id, member_id, guest_name, balance) VALUES (?,?,?,?)`).run(
  HOTEL,
  GUEST_B,
  "李四",
  1000
);

/* ---------- 通知（A 两条：一条已读一条未读；B 一条未读） ---------- */
const notifyStmt = db.prepare(
  `INSERT INTO mini_notifications (hotel_id, mini_user_id, type, title, body, read_at, created_at, ref_type, ref_id)
   VALUES (?,?,?,?,?,?,?,?,?)`
);
notifyStmt.run(HOTEL, USER_A, "BOOKING_CONFIRMED", "订单已确认 A1", "您的预订已确认", null, iso(new Date(now.getTime() - 7200_000)), "booking", 1);
notifyStmt.run(HOTEL, USER_A, "INVOICE_ISSUED", "发票已开具 A2", "发票已开具（历史）", iso(new Date(now.getTime() - 3600_000)), iso(new Date(now.getTime() - 5400_000)), "invoice", 1);
notifyStmt.run(HOTEL, USER_B, "BOOKING_CONFIRMED", "订单已确认 B1", "B 的预订已确认", null, iso(new Date(now.getTime() - 3600_000)), "booking", 2);

/* ---------- 房型 / 房间 / 房价日历（公开接口用） ---------- */
db.prepare(
  `INSERT INTO room_types
     (id, hotel_id, code, name, bed_type, area, max_occupancy, base_price, sort,
      images, facilities, breakfast_note, cancellation_policy, check_in_time, check_out_time, deposit_note)
   VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`
).run(1, HOTEL, "STD", "标准大床房", "大床", 25, 2, 328, 0);
db.prepare(`INSERT INTO rooms (id, hotel_id, room_no, room_type_id, status) VALUES (?,?,?,?,?)`).run(1, HOTEL, "8801", 1, "VC");
/* 只给「明天」配一个日历价 358，其余日子没有配置 → 应回落门市价 328 且 source=BASE */
db.prepare(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, allotment) VALUES (?,?,?,?,?)`).run(
  HOTEL,
  1,
  ymd(1),
  358,
  3
);

/* ---------- 在住单 + 账单（早餐 / 发票用） ---------- */
db.prepare(
  `INSERT INTO stays (id, hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out,
     nights, rate, deposit, guest_count, status, breakfast, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(1, HOTEL, "SI9001", 1, GUEST_A, "张三", "13800001111", iso(new Date(now.getTime() - 86400_000)), ymd(2), 2, 328, 0, 1, "INHOUSE", 0, iso());
db.prepare(
  `INSERT INTO folios (id, hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
).run(1, HOTEL, "F9001", 1, "张三", "8801", 0, 0, 0, "OPEN", iso());

db.close();

/* ========================================================================== */
/* 1. 加载真实路由模块（临时库 + @/ 别名解析）                                 */
/* ========================================================================== */

const HOOK_PATH = join(TMP, "alias-hook.mjs");
writeFileSync(
  HOOK_PATH,
  `import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = ${JSON.stringify(ROOT)};
const withExt = (base) => [
  base, base + ".ts", base + ".tsx", base + ".mts", base + ".js", base + ".mjs",
  join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js"),
];
function pick(base) {
  for (const cand of withExt(base)) {
    if (existsSync(cand) && !cand.endsWith("/")) return pathToFileURL(cand).href;
  }
  return null;
}
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const href = pick(join(ROOT, "src", specifier.slice(2)));
    if (href) return { url: href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const href = pick(fileURLToPath(new URL(specifier, context.parentURL)));
    if (href) return { url: href, shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (err) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      const href = pick(join(ROOT, "node_modules", specifier));
      if (href) return { url: href, shortCircuit: true };
    }
    throw err;
  }
}
`,
  "utf8"
);
register(pathToFileURL(HOOK_PATH).href);

/* db.ts 在模块加载时按 cwd 找 data/pms.db —— 必须先切到临时目录再 import 路由 */
process.chdir(TMP);

const loadRoute = async (rel) => import(pathToFileURL(join(ROOT, "src/app/api/mini", rel)).href);

const ledgerRoute = await loadRoute("member/ledger/route.ts");
const unbindRoute = await loadRoute("member/unbind/route.ts");
const notifyRoute = await loadRoute("notifications/route.ts");
const notifyReadRoute = await loadRoute("notifications/read/route.ts");
const breakfastRoute = await loadRoute("breakfast/route.ts");
const invoiceRoute = await loadRoute("invoices/route.ts");
const hotelRoute = await loadRoute("hotel/route.ts");
const roomTypeRoute = await loadRoute("room-types/[id]/route.ts");

/** 造一个标准 Request：token / JSON body 都按小程序端的实际写法给（带 body 默认 POST） */
function makeReq(path, { method, token, body } = {}) {
  const verb = method ?? (body !== undefined ? "POST" : "GET");
  const headers = { "user-agent": "MiniProgram-test/1.0.0" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method: verb, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

/** 调用处理函数并读出 { status, body }；ctx 给动态路由（/room-types/[id]）用 */
async function call(handler, path, opts = {}, ctx = undefined) {
  const res = await handler(makeReq(path, opts), ctx);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

console.log("── 0. 环境准备 ──");
console.log(`临时库：${DB_PATH}`);
check("真实路由模块全部加载成功（member/ledger、unbind、notifications、通知已读、breakfast、invoices、hotel、room-types）", Boolean(
  ledgerRoute.GET &&
    unbindRoute.POST &&
    notifyRoute.GET &&
    notifyReadRoute.POST &&
    breakfastRoute.POST &&
    invoiceRoute.GET &&
    invoiceRoute.POST &&
    hotelRoute.GET &&
    roomTypeRoute.GET
));

/* ========================================================================== */
/* 2. 会员储值：与 PC 端同一本账                                               */
/* ========================================================================== */

console.log("\n── 1. 会员储值余额 / 流水（清单第七节：与 PC 端一致） ──");

const ledgerA = await call(ledgerRoute.GET, "/api/mini/member/ledger", { token: TOKEN_A });
const dataA = ledgerA.body?.data ?? {};

check("GET /api/mini/member/ledger（张三）返回 ok:true", ledgerA.status === 200 && ledgerA.body?.ok === true, JSON.stringify(ledgerA.body).slice(0, 160));
check(`储值余额 = ${BALANCE_A}（= SUM(member_wallet_ledger.amount)）`, dataA.balance === BALANCE_A, `实际 ${dataA.balance}`);
check(
  `余额没有读旧表缓存 member_wallet.balance（缓存故意写成 ${BAD_CACHE_A}）`,
  dataA.balance !== BAD_CACHE_A,
  `实际 ${dataA.balance}`
);
check(
  "充值 / 消费 / 退款汇总与流水一致（500 / 120.5 / 50）",
  dataA.summary?.recharge === 500 && dataA.summary?.consume === 120.5 && dataA.summary?.refund === 50,
  JSON.stringify(dataA.summary)
);
check(
  "流水条数与 member_wallet_ledger 完全一致（total = 3）",
  dataA.total === 3 && Array.isArray(dataA.entries) && dataA.entries.length === 3,
  `total=${dataA.total} entries=${dataA.entries?.length}`
);
check(
  "流水按 id 倒序且金额符号正确（-50 / -120.5 / +500）",
  dataA.entries?.[0]?.amount === -50 && dataA.entries?.[1]?.amount === -120.5 && dataA.entries?.[2]?.amount === 500,
  JSON.stringify(dataA.entries?.map((e) => e.amount))
);
check(
  "流水带中文类型名与记账后余额（REFUND → 退款，balanceAfter 329.5）",
  dataA.entries?.[0]?.bizTypeLabel === "退款" && dataA.entries?.[0]?.balanceAfter === BALANCE_A,
  JSON.stringify(dataA.entries?.[0])
);
check("响应标注真相来源 = member_wallet_ledger（不是旧表）", dataA.source === "member_wallet_ledger", String(dataA.source));

/* ========================================================================== */
/* 3. 越权隔离：A 看不到 B，B 看不到 A                                        */
/* ========================================================================== */

console.log("\n── 2. 越权隔离（A 不能读 B 的流水） ──");

const ledgerB = await call(ledgerRoute.GET, "/api/mini/member/ledger", { token: TOKEN_B });
const dataB = ledgerB.body?.data ?? {};

check("李四读自己的储值：余额 1000 / 流水 1 条", dataB.balance === 1000 && dataB.total === 1, `balance=${dataB.balance} total=${dataB.total}`);
const aIds = new Set((dataA.entries ?? []).map((e) => e.id));
const bIds = new Set((dataB.entries ?? []).map((e) => e.id));
check("张三看不到李四的任何一条流水", [...bIds].every((id) => !aIds.has(id)), `A=${[...aIds]} B=${[...bIds]}`);
check("李四看不到张三的任何一条流水", [...aIds].every((id) => !bIds.has(id)), `A=${[...aIds]} B=${[...bIds]}`);

/* ========================================================================== */
/* 4. 未登录 / 未绑定 / token 过期                                            */
/* ========================================================================== */

console.log("\n── 3. 鉴权边界（未登录 / 未绑定 / token 过期） ──");

const noToken = await call(ledgerRoute.GET, "/api/mini/member/ledger");
check("不带 token → 401 UNAUTHORIZED", noToken.status === 401 && noToken.body?.code === "UNAUTHORIZED", `${noToken.status} ${noToken.body?.code}`);

const unbound = await call(ledgerRoute.GET, "/api/mini/member/ledger", { token: TOKEN_C });
check(
  "已登录但未绑定手机号 → NOT_BOUND（不给空列表，也不给别人的数据）",
  unbound.body?.ok === false && unbound.body?.code === "NOT_BOUND",
  JSON.stringify(unbound.body)
);

const expired = await call(ledgerRoute.GET, "/api/mini/member/ledger", { token: TOKEN_D });
check("token 已过期 → 401 UNAUTHORIZED", expired.status === 401 && expired.body?.code === "UNAUTHORIZED", `${expired.status} ${expired.body?.code}`);

/* ========================================================================== */
/* 5. 解绑：二次确认 + 解绑后 token 失效                                      */
/* ========================================================================== */

console.log("\n── 4. 解绑（二次确认 / token 立即失效） ──");

const unbindStep1 = await call(unbindRoute.POST, "/api/mini/member/unbind", { token: TOKEN_E, body: {} });
const confirmToken = unbindStep1.body?.data?.confirmToken ?? "";
check(
  "解绑第一步：返回 CONFIRM_REQUIRED + 一次性确认 token + 脱敏手机号",
  unbindStep1.body?.data?.stage === "CONFIRM_REQUIRED" &&
    typeof confirmToken === "string" &&
    confirmToken.split(".").length === 2 &&
    /^\d{3}\*{4}\d{4}$/.test(unbindStep1.body?.data?.mobile ?? ""),
  JSON.stringify(unbindStep1.body?.data ?? unbindStep1.body).slice(0, 200)
);

const badText = await call(unbindRoute.POST, "/api/mini/member/unbind", {
  token: TOKEN_E,
  body: { confirmToken, confirmText: "随便" },
});
check("解绑第二步：明文不是「解绑」→ 400 CONFIRM_REQUIRED（防误触）", badText.status === 400 && badText.body?.code === "CONFIRM_REQUIRED", `${badText.status} ${badText.body?.code}`);

const tampered = await call(unbindRoute.POST, "/api/mini/member/unbind", {
  token: TOKEN_E,
  body: { confirmToken: `${confirmToken.slice(0, -4)}beef`, confirmText: "解绑" },
});
check("解绑第二步：确认 token 被篡改 → 400 CONFIRM_INVALID（HMAC 校验生效）", tampered.status === 400 && tampered.body?.code === "CONFIRM_INVALID", `${tampered.status} ${tampered.body?.code}`);

const otherUser = await call(unbindRoute.POST, "/api/mini/member/unbind", {
  token: TOKEN_A,
  body: { confirmToken, confirmText: "解绑" },
});
check("解绑第二步：拿别人的确认 token 解绑 → 400 CONFIRM_INVALID（token 绑定到 mini_user_id）", otherUser.status === 400 && otherUser.body?.code === "CONFIRM_INVALID", `${otherUser.status} ${otherUser.body?.code}`);

const unbindOk = await call(unbindRoute.POST, "/api/mini/member/unbind", {
  token: TOKEN_E,
  body: { confirmToken, confirmText: "解绑" },
});
check(
  "解绑成功：stage=UNBOUND / loggedOut=true",
  unbindOk.body?.ok === true && unbindOk.body?.data?.unbind === true && unbindOk.body?.data?.loggedOut === true,
  JSON.stringify(unbindOk.body).slice(0, 200)
);

const afterUnbind = await call(ledgerRoute.GET, "/api/mini/member/ledger", { token: TOKEN_E });
check("解绑后旧 token 立即失效 → 401（清单：解绑后 token 失效）", afterUnbind.status === 401 && afterUnbind.body?.code === "UNAUTHORIZED", `${afterUnbind.status} ${afterUnbind.body?.code}`);

/* ========================================================================== */
/* 6. 通知：只发给对应 mini_user_id                                           */
/* ========================================================================== */

console.log("\n── 5. 通知（第 302 行：只发给对应 mini_user_id） ──");

const notifyA = await call(notifyRoute.GET, "/api/mini/notifications", { token: TOKEN_A });
const notifyB = await call(notifyRoute.GET, "/api/mini/notifications", { token: TOKEN_B });
const itemsA = notifyA.body?.data?.items ?? [];
const itemsB = notifyB.body?.data?.items ?? [];
const bNotifyId = itemsB[0]?.id ?? 0;

check("张三只看到自己的 2 条通知（标题不含 B1）", itemsA.length === 2 && !itemsA.some((n) => String(n.title).includes("B1")), JSON.stringify(itemsA.map((n) => n.title)));
check("李四只看到自己的 1 条通知（标题 B1）", itemsB.length === 1 && String(itemsB[0]?.title).includes("B1"), JSON.stringify(itemsB.map((n) => n.title)));
check("未读角标正确（张三 1 条未读 / 李四 1 条未读）", notifyA.body?.data?.unreadCount === 1 && notifyB.body?.data?.unreadCount === 1, `A=${notifyA.body?.data?.unreadCount} B=${notifyB.body?.data?.unreadCount}`);

const stealRead = await call(notifyReadRoute.POST, "/api/mini/notifications/read", {
  token: TOKEN_A,
  body: { id: bNotifyId },
});
check("张三标记李四的通知已读 → updated=0（越权更新被 WHERE mini_user_id 挡掉）", stealRead.body?.data?.updated === 0, JSON.stringify(stealRead.body?.data));
const notifyBAfter = await call(notifyRoute.GET, "/api/mini/notifications?unreadOnly=1", { token: TOKEN_B });
check("李四的通知仍是未读（没被张三标记）", notifyBAfter.body?.data?.unreadCount === 1, String(notifyBAfter.body?.data?.unreadCount));

const ownRead = await call(notifyReadRoute.POST, "/api/mini/notifications/read", {
  token: TOKEN_A,
  body: { all: true },
});
check("张三「全部已读」→ updated=1 且未读归零", ownRead.body?.data?.updated === 1 && ownRead.body?.data?.unreadCount === 0, JSON.stringify(ownRead.body?.data));

/* 复核 + 造数用的连接（读写：本测试后面要改 folios / settings 来造发票与未配置场景） */
const schema = new DatabaseSync(DB_PATH);
const notifyCols = schema.prepare(`PRAGMA table_info(mini_notifications)`).all().map((c) => c.name);
check(
  "mini_notifications 结构上没有 mobile / guest_id（结构层面禁止按手机号群发）",
  notifyCols.length > 0 && !notifyCols.includes("mobile") && !notifyCols.includes("guest_id"),
  notifyCols.join(",")
);

/* ========================================================================== */
/* 7. 早餐：金额服务端算 + request_id 幂等                                    */
/* ========================================================================== */

console.log("\n── 6. 早餐购买（金额服务端算 / 幂等 / 不吃客户端金额） ──");

const breakfast = await call(breakfastRoute.POST, "/api/mini/breakfast", {
  /* 故意传假金额：服务端必须按 settings.breakfast_price × 份数 自己算 */
  token: TOKEN_A,
  body: { count: 2, price: 1, amount: 1, unitPrice: 1, requestId: "mini-test-bf-0001" },
});
const bf = breakfast.body?.data ?? {};
check(
  `早餐总价 = 服务端单价 ${BREAKFAST_PRICE} × 2 = 136（客户端传的 1 元被丢弃）`,
  breakfast.body?.ok === true && bf.unitPrice === BREAKFAST_PRICE && bf.amount === BREAKFAST_PRICE * 2,
  JSON.stringify(breakfast.body).slice(0, 220)
);

const replay = await call(breakfastRoute.POST, "/api/mini/breakfast", {
  token: TOKEN_A,
  body: { count: 2, requestId: "mini-test-bf-0001" },
});
const bfRows = schema
  .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND request_id = ?`)
  .get(HOTEL, "mini-test-bf-0001");
check(
  "同一 requestId 重复提交 → 幂等重放（replayed=true，账务明细仍只有 1 行 / 136 元）",
  replay.body?.data?.replayed === true && Number(bfRows.n) === 1 && Number(bfRows.s) === 136,
  `replayed=${replay.body?.data?.replayed} rows=${bfRows.n} sum=${bfRows.s}`
);

const stayAfter = schema.prepare(`SELECT breakfast FROM stays WHERE id = 1 AND hotel_id = ?`).get(HOTEL);
const recAfter = schema.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(count),0) AS c FROM breakfast_records WHERE hotel_id = ? AND stay_id = 1`).get(HOTEL);
check(
  "在住单含早份数 +2 且早餐核销记录已生成（与 PC 端 sellBreakfastAction 同一张表）",
  Number(stayAfter?.breakfast) === 2 && Number(recAfter.n) === 1 && Number(recAfter.c) === 2,
  `breakfast=${stayAfter?.breakfast} records=${recAfter.n}/${recAfter.c}`
);

/* 未配置单价时不卖（不编造价格） */
schema.prepare(`DELETE FROM settings WHERE hotel_id = ? AND key = 'breakfast_price'`).run(HOTEL);
const noPrice = await call(breakfastRoute.POST, "/api/mini/breakfast", { token: TOKEN_A, body: { count: 1 } });
check("酒店未配早餐单价 → NOT_CONFIGURED（绝不硬编码假价格）", noPrice.body?.code === "NOT_CONFIGURED", JSON.stringify(noPrice.body).slice(0, 160));
schema.prepare(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`).run(HOTEL, "breakfast_price", String(BREAKFAST_PRICE));

/* ========================================================================== */
/* 8. 发票：只能给自己已结清的账单开                                          */
/* ========================================================================== */

console.log("\n── 7. 发票（只能给自己已结清的账单开 / 金额上限服务端算） ──");

schema.prepare(`UPDATE folios SET status = 'SETTLED', total_amount = 136, paid_amount = 136, balance = 0 WHERE id = 1`).run();

const invoiceA = await call(invoiceRoute.POST, "/api/mini/invoices", {
  token: TOKEN_A,
  body: { folioId: 1, title: "张三（个人）" },
});
check(
  "张三给自己的已结账账单开票 → 成功，金额取服务端算的可开余额 136",
  invoiceA.body?.ok === true && invoiceA.body?.data?.amount === 136 && Boolean(invoiceA.body?.data?.invoiceNo),
  JSON.stringify(invoiceA.body).slice(0, 220)
);

const invoiceB = await call(invoiceRoute.POST, "/api/mini/invoices", {
  token: TOKEN_B,
  body: { folioId: 1, title: "李四（个人）" },
});
check(
  "李四拿张三的账单 id 开票 → NOT_FOUND（按 guest_id 判归属，不是按姓名/手机号）",
  invoiceB.body?.ok === false && invoiceB.body?.code === "NOT_FOUND",
  JSON.stringify(invoiceB.body).slice(0, 160)
);

const invoiceFull = await call(invoiceRoute.POST, "/api/mini/invoices", {
  token: TOKEN_A,
  body: { folioId: 1, title: "张三（个人）" },
});
check("同一张账单已开满后再开 → INVOICE_FULLY_ISSUED", invoiceFull.body?.code === "INVOICE_FULLY_ISSUED", JSON.stringify(invoiceFull.body).slice(0, 160));

const invoiceListA = await call(invoiceRoute.GET, "/api/mini/invoices", { token: TOKEN_A });
const invoiceListB = await call(invoiceRoute.GET, "/api/mini/invoices", { token: TOKEN_B });
check(
  "我的发票列表：张三 1 张 / 李四 0 张（不返回别人的票）",
  invoiceListA.body?.data?.total === 1 && invoiceListB.body?.data?.total === 0,
  `A=${invoiceListA.body?.data?.total} B=${invoiceListB.body?.data?.total}`
);
check(
  "发票响应里姓名已脱敏（张*）",
  /^张\*$/.test(invoiceListA.body?.data?.items?.[0]?.guestName ?? ""),
  String(invoiceListA.body?.data?.items?.[0]?.guestName)
);

/* ========================================================================== */
/* 9. 公开接口：不编造未配置字段、不泄漏经营数据                              */
/* ========================================================================== */

console.log("\n── 8. 酒店 / 房型公开接口（不写死假信息 / 不返回经营数据） ──");

const hotel = await call(hotelRoute.GET, "/api/mini/hotel");
const hotelText = JSON.stringify(hotel.body ?? {});
const hotelData = hotel.body?.data ?? {};
check(
  "GET /api/mini/hotel：名称 / 地址 / 电话 / 入离时间来自真实配置",
  hotel.body?.ok === true &&
    hotelData.name === "云栖国际酒店" &&
    hotelData.address === "杭州市西湖区文三路 1 号" &&
    hotelData.phone === "0571-88886666" &&
    hotelData.checkInTime === "14:00" &&
    hotelData.checkOutTime === "12:00",
  JSON.stringify(hotelData).slice(0, 200)
);
check(
  "未配置的地图坐标 / 押金说明返回 null，并在 unconfigured 里逐项列明",
  hotelData.location?.latitude === null &&
    hotelData.location?.longitude === null &&
    hotelData.depositNote === null &&
    Array.isArray(hotelData.unconfigured) &&
    hotelData.unconfigured.some((t) => String(t).includes("地图")) &&
    hotelData.unconfigured.some((t) => String(t).includes("押金")),
  JSON.stringify(hotelData.unconfigured)
);
check(
  "酒店接口不返回经营数据（无 totalRooms / occupancy / revenue / appSecret）",
  !/totalRooms|occupancy|occupancyRate|revenue|appSecret|app_secret/i.test(hotelText),
  hotelText.slice(0, 160)
);

const roomType = await call(roomTypeRoute.GET, "/api/mini/room-types/1?days=3", {}, {
  params: Promise.resolve({ id: "1" }),
});
const rt = roomType.body?.data ?? {};
const rtText = JSON.stringify(roomType.body ?? {});
check(
  "房型详情：数据库没配图片 / 设施就返回空数组 + configured=false（不写死假图假设施）",
  roomType.body?.ok === true &&
    Array.isArray(rt.images) &&
    rt.images.length === 0 &&
    Array.isArray(rt.facilities) &&
    rt.facilities.length === 0 &&
    rt.configured?.images === false &&
    rt.configured?.facilities === false &&
    rt.unconfigured?.some?.((t) => String(t).includes("图片")),
  JSON.stringify(rt).slice(0, 240)
);
check(
  "价格日历：3 天、明天用 rate_calendar 的 358（source=CALENDAR）、其余回落门市价 328（source=BASE）",
  Array.isArray(rt.priceCalendar) &&
    rt.priceCalendar.length === 3 &&
    rt.priceCalendar[1]?.date === ymd(1) &&
    rt.priceCalendar[1]?.price === 358 &&
    rt.priceCalendar[1]?.source === "CALENDAR" &&
    rt.priceCalendar.filter((d) => d.source === "BASE").length === 2,
  JSON.stringify(rt.priceCalendar)
);
check(
  "房型接口不返回房量 / 库存（无 remainingRooms / allotment / totalRooms；未传日期时 availability=null）",
  !/remainingRooms|allotment|totalRooms/i.test(rtText) && rt.availability === null,
  rtText.slice(0, 200)
);
check(
  "房型接口不返回别的房型 / 全店房型列表（只返回当前 id）",
  rt.roomTypeId === 1 && !Array.isArray(rt.roomTypes),
  JSON.stringify(rt).slice(0, 120)
);

/* ========================================================================== */
/* 10. 落库复核 + 清理                                                        */
/* ========================================================================== */

console.log("\n── 9. 落库复核（解绑 / 审计） ──");

const rowE = schema.prepare(`SELECT guest_id, session_token, token_expires_at FROM mini_program_users WHERE id = ?`).get(USER_E);
check(
  "解绑后：mini_program_users.guest_id / session_token 均已清空（会话不可复用）",
  rowE?.guest_id === null && rowE?.session_token === null && rowE?.token_expires_at === null,
  JSON.stringify(rowE)
);

const opLog = schema.prepare(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = ? AND action = '小程序解绑'`).get(HOTEL);
check("解绑写了审计日志（op_logs.action = 小程序解绑）", Number(opLog?.n) === 1, `n=${opLog?.n}`);

const unboundNotify = schema
  .prepare(`SELECT COUNT(*) AS n FROM mini_notifications WHERE hotel_id = ? AND mini_user_id = ? AND type = 'UNBOUND'`)
  .get(HOTEL, USER_E);
check("解绑给本人留了站内通知（只发给该 mini_user_id）", Number(unboundNotify?.n) === 1, `n=${unboundNotify?.n}`);

const ledgerRows = schema.prepare(`SELECT COUNT(*) AS n FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`).get(HOTEL, GUEST_A);
check(
  "读流水没有副作用：member_wallet_ledger 行数未变（3 行）",
  Number(ledgerRows?.n) === 3,
  `n=${ledgerRows?.n}`
);

schema.close();

/* ---------- 清理 ---------- */
process.chdir(ROOT);
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  /* Windows 上偶发占用：留下的是 .tmp 下的临时目录，不影响仓库 */
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log("失败项：\n  - " + failed.join("\n  - "));
  process.exit(1);
}
console.log("小程序会员储值 / 解绑 / 通知 / 早餐 / 发票 验收通过");
