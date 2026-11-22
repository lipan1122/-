// 初始化 PMS 数据库：建表 + 种子数据
// 用法: node scripts/init-db.mjs [--reset]
//
// 为什么末尾要调用 runMigrations（整改 P0-1「建表与迁移不同步」）：
//   原来本脚本自己写死一份建表 SQL，后来散落在 scripts/migrate-all.mjs 的增量变更
//   （booking_rooms / shifts / room_anomalies 三张表、payments 与 housekeeping 的新列、
//   一批索引、biz_day_cutoff 默认配置）根本没有回填进来，导致全新部署跑 npm run db:init
//   出来的库是残缺的，入住 / 收款 / 渠道 / 夜审直接报 no such table / no such column。
//   现在改成：本脚本只负责「基础表 + 演示种子」，收尾调用 migrate-all 导出的
//   runMigrations(db) 把库推到迁移脚本定义的目标状态。以后新增迁移只改 migrate-all 一处，
//   本脚本自动跟着走，从根上消掉两份 schema 漂移。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrate-all.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const dbFile = process.env.PMS_DB_PATH ?? path.join(dataDir, "pms.db");

if (process.argv.includes("--reset") && fs.existsSync(dbFile)) {
  fs.rmSync(dbFile, { force: true });
  for (const ext of ["-wal", "-shm"]) {
    fs.rmSync(dbFile + ext, { force: true });
  }
}

fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const schema = `
CREATE TABLE IF NOT EXISTS hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  address TEXT, phone TEXT, logo TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  -- 旧明文列：保留列是为了让还没升级的老代码 SELECT 不报错，
  -- 值由收尾的 runMigrations 一次性迁到 password_hash 并清成空串。
  password TEXT NOT NULL,
  real_name TEXT,
  role TEXT NOT NULL DEFAULT 'frontdesk',
  status INTEGER DEFAULT 1,
  -- 整改清单 P2-2（建表与迁移同步）：这三列原来只在 migrate-all 里 addColumn，
  -- 全新部署要等迁移跑完才有；直接在建表语句里一次建全，新库结构 = 老库迁移后的结构。
  --   password_hash        登录唯一可信的密码来源（scrypt）
  --   must_change_password 管理员重置密码后要求本人改密的标记（P2-30）
  --   position_id          岗位归属（员工管理页）
  password_hash TEXT,
  must_change_password INTEGER DEFAULT 0,
  position_id INTEGER,
  mobile TEXT,
  last_login_at TEXT,
  UNIQUE(hotel_id, username)
);
-- 第九轮《微信小程序专项》：房型详情展示字段（images / facilities / breakfast_note /
-- cancellation_policy / check_in_time / check_out_time / deposit_note）。
-- 全新库在这里就把列建全；老库由 scripts/migrate-all.mjs 第 12.3 段的 addColumn 补齐，
-- 两处列名/顺序必须一致（scripts/schema-fingerprint.json 里是同一份结构）。
CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  bed_type TEXT, area REAL,
  max_occupancy INTEGER DEFAULT 2,
  base_price REAL DEFAULT 0,
  sort INTEGER DEFAULT 0,
  images TEXT, facilities TEXT, breakfast_note TEXT, cancellation_policy TEXT,
  check_in_time TEXT, check_out_time TEXT, deposit_note TEXT
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_no TEXT NOT NULL,
  floor INTEGER,
  room_type_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'VC',
  feature TEXT,
  sort INTEGER DEFAULT 0,
  UNIQUE(hotel_id, room_no)
);
CREATE TABLE IF NOT EXISTS rate_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_type_id INTEGER,
  name TEXT, price REAL,
  start_date TEXT, end_date TEXT,
  is_default INTEGER DEFAULT 0
);
-- 房价日历 rate_calendar 故意不在这里建：
-- 它原来只靠 src/app/(main)/settings/actions.ts 懒创建（且缺 allotment 列），
-- 现在统一由 migrate-all 的第 4 节建表（含 allotment），init-db 收尾跑迁移即得完整表，
-- 老库升级也走同一段 DDL —— 避免这里和迁移脚本各存一份建表语句将来又漂移。
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT, commission REAL DEFAULT 0,
  channel_type TEXT DEFAULT 'direct',
  store_id TEXT, app_key TEXT, app_secret TEXT,
  enabled INTEGER DEFAULT 0,
  last_sync_at TEXT, auto_import INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  channel_type TEXT NOT NULL,
  channel_order_no TEXT NOT NULL,
  room_type_id INTEGER, guest_name TEXT, mobile TEXT,
  check_in_date TEXT, check_out_date TEXT, nights INTEGER,
  room_count INTEGER DEFAULT 1, amount REAL DEFAULT 0,
  status TEXT DEFAULT 'NEW',
  booking_id INTEGER, raw TEXT,
  created_at TEXT, imported_at TEXT
);
CREATE TABLE IF NOT EXISTS channel_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  channel_type TEXT, action TEXT, status TEXT, message TEXT, created_at TEXT,
  -- 整改报告第 8 节：失败必须能追溯原因和重试次数，新建库直接带这三列，
  -- 老库由 scripts/migrate-all.mjs 的 addColumn 补齐
  error_code TEXT,
  retry_count INTEGER DEFAULT 0,
  next_retry_at TEXT
);
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  gender TEXT, id_type TEXT, id_no TEXT, mobile TEXT,
  company TEXT, vip_level INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0,
  note TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT, contact TEXT, phone TEXT,
  discount REAL DEFAULT 1.0, credit_limit REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  booking_no TEXT NOT NULL,
  guest_id INTEGER, guest_name TEXT, mobile TEXT,
  room_type_id INTEGER, room_id INTEGER,
  channel_id INTEGER, company_id INTEGER,
  check_in_date TEXT NOT NULL, check_out_date TEXT NOT NULL,
  nights INTEGER, room_count INTEGER DEFAULT 1, guest_count INTEGER DEFAULT 1,
  rate REAL DEFAULT 0, deposit REAL DEFAULT 0,
  -- 房费总价（整改 P1-12）：日租 = rate × 晚数 × 间数，钟点 = rate（nights = 0）。
  -- rate 是「每晚价」，钟点房的总价没有列可放，曾经直接混写进 rate 导致报表口径错误；
  -- 这里升成正式列，新建库一次建全，老库由 scripts/migrate-all.mjs 的 addColumn 补齐。
  total_price REAL,
  -- 小程序下单幂等键（整改清单第 109 行）：同一 (hotel_id, mini_request_id) 只建一张订单。
  -- NULL = 历史单 / 非小程序单；部分唯一索引见 scripts/migrate-all.mjs 的 12.5 段
  -- （全新库由 runMigrations 收尾建好，与 schema-full.sql / 运行时 ensureBookingRequestSchema 一致）。
  mini_request_id TEXT,
  status TEXT DEFAULT 'PENDING',
  guarantee TEXT, remark TEXT,
  booking_type TEXT DEFAULT 'guest',
  team_name TEXT, member_card TEXT, member_type TEXT,
  arrival_time TEXT, rate_code TEXT, salesman TEXT,
  package_code TEXT, invoice_party TEXT DEFAULT '酒店',
  retain_time TEXT, pay_type TEXT DEFAULT '到店付款',
  breakfast INTEGER DEFAULT 0, channel_order_no TEXT,
  created_by INTEGER, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  stay_no TEXT NOT NULL,
  booking_id INTEGER, room_id INTEGER NOT NULL,
  guest_id INTEGER, guest_name TEXT, mobile TEXT,
  check_in_time TEXT, expect_check_out TEXT, actual_check_out TEXT,
  nights INTEGER, rate REAL NOT NULL, deposit REAL DEFAULT 0,
  guest_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'INHOUSE',
  channel_id INTEGER, remark TEXT,
  team_name TEXT, member_card TEXT, member_type TEXT,
  rate_code TEXT, salesman TEXT, package_code TEXT,
  invoice_party TEXT DEFAULT '酒店', pay_type TEXT DEFAULT '到店付款',
  breakfast INTEGER DEFAULT 0,
  created_by INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS folios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_no TEXT NOT NULL,
  stay_id INTEGER, guest_name TEXT, room_no TEXT,
  total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, balance REAL DEFAULT 0,
  status TEXT DEFAULT 'OPEN',
  created_at TEXT, settled_at TEXT
);
CREATE TABLE IF NOT EXISTS folio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  description TEXT,
  qty REAL DEFAULT 1, price REAL DEFAULT 0, amount REAL DEFAULT 0,
  biz_date TEXT, created_at TEXT, created_by INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_id INTEGER, stay_id INTEGER,
  pay_no TEXT, method TEXT, amount REAL,
  biz_date TEXT, remark TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS room_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_id INTEGER, from_status TEXT, to_status TEXT,
  reason TEXT, operator TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS housekeeping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_id INTEGER, task_type TEXT,
  status TEXT DEFAULT 'PENDING',
  assignee TEXT, note TEXT, created_at TEXT, done_at TEXT
);
-- 夜审（P0-1）：原建表把 biz_date 写成全局 UNIQUE，一晚只能有一家酒店夜审；
-- migrate-all 早把唯一键改成 (hotel_id, biz_date)（夜审按酒店隔离，多店共用才会不打架）。
-- 这里直接按目标形态建，全新库就不必再被迁移脚本「建新表→搬数据→改名」重建一次，
-- migrate-all --check 也不会报「night_audits 唯一键待改」。
CREATE TABLE IF NOT EXISTS night_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  biz_date TEXT NOT NULL,
  status TEXT,
  rooms_sold INTEGER DEFAULT 0,
  revenue REAL DEFAULT 0,
  occupancy REAL DEFAULT 0,
  operator TEXT,
  created_at TEXT,
  UNIQUE(hotel_id, biz_date)
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  key TEXT NOT NULL, value TEXT
);
CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  operator TEXT, action TEXT, detail TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_json TEXT NOT NULL,
  created_at TEXT,
  expires_at TEXT
);
/* 上线加固：登录失败计数（与 migrate-all.mjs 第 17 段保持一致） */
CREATE TABLE IF NOT EXISTS login_attempts (
  login_key    TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT
);

-- 商超库存流水（第九轮清单 二.7「shop_stock_flows 纳入正式 schema」）
-- 以前这张表只在 src/app/(main)/shop/actions.ts 的 ensureShopStockFlowTable 里懒建：
-- 老库点过一次商超页面就有了，但全新部署跑完 init-db + migrate-all 仍然缺表，
-- 依赖「先访问一次页面」才可用，交付部署不可接受。
-- 列定义与 ensureShopStockFlowTable 的 CREATE TABLE 逐列一致
-- （scripts/test-shop-schema-fresh-install.mjs 会解析源码逐列比对，漂移即红）。
CREATE TABLE IF NOT EXISTS shop_stock_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sale_id INTEGER,
  request_id TEXT,
  note TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
);
-- 查询索引：按「酒店 + 商品 + 类型」查某件商品的出入库流水（与运行时同名同列）
CREATE INDEX IF NOT EXISTS idx_shop_stock_flows_item ON shop_stock_flows (hotel_id, item_id, type);
-- 唯一索引：同一 request_id 下同一个商品只允许一条同类流水 —— 双击 / 重试不会重复扣库存
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_stock_flows_request
  ON shop_stock_flows(hotel_id, request_id, item_id, type) WHERE request_id IS NOT NULL;

-- 小程序服务请求（第九轮清单第六节 / 微信小程序专项第三节「订单与在住」）
-- 与 scripts/schema-full.sql、scripts/migrate-all.mjs（第 12.3 段）、
-- 运行时 src/app/api/mini/_shared.ts 的 ensureMiniServiceSchema() 四处逐列一致。
-- mini_program_config / mini_program_users / mini_program_bookings 三张表沿用既有约定，
-- 只由 migrate-all 建（收尾的 runMigrations 会把它们补齐）；本表被显式写进来是因为
-- 「在住服务」是全新库一装好就要用的主流程，不能等迁移段兜底才有。
CREATE TABLE IF NOT EXISTS mini_service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  mini_user_id INTEGER NOT NULL,
  guest_id INTEGER,
  stay_id INTEGER,
  booking_id INTEGER,
  service_type TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  request_id TEXT,
  note TEXT,
  operator TEXT,
  created_at TEXT,
  updated_at TEXT,
  completed_at TEXT
);
-- request_id 幂等：同一家店同一 request_id 只能落一行（部分唯一，NULL 不进索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_mini_service_requests_req
  ON mini_service_requests(hotel_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mini_service_requests_user
  ON mini_service_requests(hotel_id, mini_user_id, id);
CREATE INDEX IF NOT EXISTS idx_mini_service_requests_stay
  ON mini_service_requests(hotel_id, stay_id);
CREATE INDEX IF NOT EXISTS idx_mini_service_requests_status
  ON mini_service_requests(hotel_id, status, id);

-- 小程序站内通知（第九轮 第三节 / 第 302 行「通知必须只发给对应 mini_user_id」）
-- 与 scripts/schema-full.sql、scripts/migrate-all.mjs（第 12.4 段）、
-- 运行时 src/app/api/mini/notifications/_notify.ts 的 ensureMiniNotificationsSchema() 四处逐列一致。
-- 收件人唯一键 mini_user_id；刻意不存 mobile / guest_id —— 有手机号列就一定有人写出
-- 「按手机号群发」的 SQL（清单明文禁止），这里连列都不给。
-- mini_program_config / mini_program_users / mini_program_bookings 三张表沿用既有约定，
-- 只由 migrate-all 建（收尾的 runMigrations 会补齐）；通知被显式写进来是因为
-- 「订单/服务/发票」三条业务链路都要在动作成功后落通知，全新库装好就该有表。
CREATE TABLE IF NOT EXISTS mini_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  mini_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_at TEXT,
  created_at TEXT,
  ref_type TEXT,
  ref_id INTEGER
);
-- 消息列表 / 未读角标固定按 (hotel_id, mini_user_id, read_at) 过滤
CREATE INDEX IF NOT EXISTS idx_mini_notifications_user
  ON mini_notifications(hotel_id, mini_user_id, read_at);
`;

db.exec(schema);

const now = new Date();
const iso = (d) => d.toISOString();
const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const today = ymd(now);

const ins = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);

// ---------- 酒店 ----------
const hotelId = ins(
  `INSERT INTO hotels (code, name, address, phone, created_at) VALUES (?,?,?,?,?)`,
  "YQ", "云栖国际酒店", "杭州市西湖区文三路 88 号", "0571-8888 6666", iso(now)
);

// ---------- 用户 ----------
const users = [
  ["admin", "admin123", "张经理", "admin"],
  ["front", "123456", "李前台", "frontdesk"],
  ["cashier", "123456", "王收银", "cashier"],
  ["housekeeper", "123456", "赵阿姨", "housekeeping"],
];
for (const [u, p, n, r] of users) {
  ins(`INSERT INTO users (hotel_id, username, password, real_name, role) VALUES (?,?,?,?,?)`, hotelId, u, p, n, r);
}

// ---------- 房型 ----------
const roomTypes = [
  ["STD", "标准双床房", "双床", 25, 2, 268],
  ["DLX", "高级大床房", "大床", 28, 2, 328],
  ["SUI", "豪华套房", "大床", 45, 3, 588],
  ["FAM", "家庭房", "双床", 38, 4, 468],
];
const rtIds = {};
for (let i = 0; i < roomTypes.length; i++) {
  const [code, name, bed, area, occ, price] = roomTypes[i];
  rtIds[code] = ins(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, area, max_occupancy, base_price, sort) VALUES (?,?,?,?,?,?,?,?)`,
    hotelId, code, name, bed, area, occ, price, i
  );
}

// ---------- 房间 ----------
const roomPlan = [
  { floor: 3, prefix: "3", type: "STD", count: 10 },
  { floor: 4, prefix: "4", type: "DLX", count: 10 },
  { floor: 5, prefix: "5", type: "SUI", count: 6 },
  { floor: 6, prefix: "6", type: "FAM", count: 4 },
];
const roomIds = [];
let sort = 0;
for (const p of roomPlan) {
  for (let i = 1; i <= p.count; i++) {
    const no = `${p.prefix}${String(i).padStart(2, "0")}`;
    const id = ins(
      `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`,
      hotelId, no, p.floor, rtIds[p.type], "VC", ++sort
    );
    roomIds.push({ id, no, type: p.type, floor: p.floor });
  }
}

// ---------- 客源渠道 ----------
const channelDefs = [
  ["散客", "direct", 0],
  ["携程", "ctrip", 0.1],
  ["美团", "meituan", 0.12],
  ["去哪儿", "qunar", 0.08],
  ["艺龙", "elong", 0.1],
  ["协议单位", "direct", 0],
  ["会员直订", "direct", 0],
];
const channelIds = {};
for (const [name, type, commission] of channelDefs) {
  const storeId = type === "ctrip" ? "CTRIP-HZ-0088" : type === "meituan" ? "MT-HZ-7712" : type === "qunar" ? "QNR-HZ-3301" : "";
  channelIds[name] = ins(
    `INSERT INTO channels (hotel_id, name, commission, channel_type, store_id, app_key, app_secret, enabled) VALUES (?,?,?,?,?,?,?,?)`,
    hotelId, name, commission, type, storeId || null,
    type === "direct" ? null : `${type.toUpperCase()}_AK_8f3a2c`,
    type === "direct" ? null : "••••••••••••",
    type === "direct" ? 0 : 1
  );
}

// 抖音渠道（单独一条，name 即"抖音"）
channelIds["抖音"] = ins(
  `INSERT INTO channels (hotel_id, name, commission, channel_type, store_id, app_key, app_secret, enabled) VALUES (?,?,?,?,?,?,?,?)`,
  hotelId, "抖音", 0.15, "douyin", "DY-HZ-5620", "DOUYIN_AK_51bd9e", "••••••••••••", 1
);

// ---------- 协议单位 ----------
const companies = [
  ["杭州云启科技有限公司", "陈总", "13800001111", 0.85, 50000],
  ["西湖旅行社", "刘导", "13900002222", 0.8, 20000],
  ["东方航空杭州分公司", "周经理", "13700003333", 0.9, 30000],
];
const companyIds = [];
for (const [name, contact, phone, discount, credit] of companies) {
  companyIds.push(ins(
    `INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`,
    hotelId, name, contact, phone, discount, credit
  ));
}

// ---------- 价格方案 ----------
ins(`INSERT INTO rate_plans (hotel_id, room_type_id, name, price, is_default) VALUES (?,?,?,?,?)`, hotelId, null, "门市价", 0, 1);
ins(`INSERT INTO rate_plans (hotel_id, room_type_id, name, price, is_default) VALUES (?,?,?,?,?)`, hotelId, null, "协议价（8.5折）", 0, 0);

// ---------- 客人 ----------
const guestSeed = [
  ["陈立", "男", "身份证", "330106199001011234", "13811112222", "", 1],
  ["王芳", "女", "身份证", "330106199202022345", "13922223333", "", 0],
  ["刘洋", "男", "身份证", "330106198803033456", "13633334444", "杭州云启科技有限公司", 2],
  ["赵敏", "女", "身份证", "330106199505054567", "13544445555", "", 0],
  ["孙强", "男", "身份证", "330106198706065678", "13755556666", "西湖旅行社", 0],
  ["周杰", "男", "护照", "E12345678", "13666667777", "", 0],
  ["吴静", "女", "身份证", "330106199808087890", "13477778888", "", 1],
  ["郑凯", "男", "身份证", "330106199909099012", "13388889999", "东方航空杭州分公司", 0],
];
const guestIds = [];
for (const [name, gender, idType, idNo, mobile, company, vip] of guestSeed) {
  guestIds.push(ins(
    `INSERT INTO guests (hotel_id, name, gender, id_type, id_no, mobile, company, vip_level, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    hotelId, name, gender, idType, idNo, mobile, company, vip, iso(now)
  ));
}

// ---------- 在住客人（房间 + 入住单 + 账单） ----------
const inhouse = [
  { roomNo: "301", guest: 0, channel: "携程", nights: 2, offset: -1, rate: 268, deposit: 500 },
  { roomNo: "304", guest: 2, channel: "协议单位", nights: 3, offset: -2, rate: 328, deposit: 1000 },
  { roomNo: "402", guest: 1, channel: "美团", nights: 1, offset: 0, rate: 328, deposit: 400 },
  { roomNo: "405", guest: 3, channel: "散客", nights: 2, offset: -1, rate: 328, deposit: 800 },
  { roomNo: "501", guest: 6, channel: "会员直订", nights: 3, offset: -2, rate: 588, deposit: 1500 },
  { roomNo: "601", guest: 4, channel: "去哪儿", nights: 2, offset: 0, rate: 468, deposit: 600 },
];

let staySeq = 1001;
let folioSeq = 2001;
for (const it of inhouse) {
  const room = roomIds.find((r) => r.no === it.roomNo);
  const checkIn = addDays(now, it.offset);
  const expectOut = addDays(now, it.offset + it.nights);
  const g = guestSeed[it.guest];
  const stayNo = `SI${staySeq++}`;
  const stayId = ins(
    `INSERT INTO stays (hotel_id, stay_no, booking_id, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, nights, rate, deposit, guest_count, status, channel_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, stayNo, null, room.id, guestIds[it.guest], g[0], g[4], iso(checkIn), ymd(expectOut), it.nights, it.rate, it.deposit, 1, "INHOUSE", channelIds[it.channel], iso(checkIn)
  );
  db.prepare(`UPDATE rooms SET status = 'OC' WHERE id = ?`).run(room.id);

  const folioNo = `F${folioSeq++}`;
  const folioId = ins(
    `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, folioNo, stayId, g[0], it.roomNo, 0, it.deposit, 0, "OPEN", iso(checkIn)
  );
  // 押金
  ins(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, folioId, "DEPOSIT", "入住押金", 1, it.deposit, it.deposit, today, iso(checkIn), 2
  );
  ins(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    hotelId, folioId, stayId, `P${folioId}`, "微信", it.deposit, today, "入住押金", iso(checkIn)
  );
  // 已过夜房费
  const nightsConsumed = Math.max(1, Math.min(it.nights, it.offset + 1));
  for (let n = 0; n < nightsConsumed; n++) {
    const biz = ymd(addDays(checkIn, n));
    ins(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      hotelId, folioId, "ROOM", `房费 ${biz}`, 1, it.rate, it.rate, biz, iso(addDays(checkIn, n)), 2
    );
  }
  // 部分散费
  if (it.guest === 2) {
    ins(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      hotelId, folioId, "FOOD", "中餐厅晚餐", 1, 168, 168, today, iso(now), 2
    );
  }
  const total = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM folio_items WHERE folio_id = ?`).get(folioId).t;
  db.prepare(`UPDATE folios SET total_amount = ?, balance = ? WHERE id = ?`).run(total, total - it.deposit, folioId);
}

// ---------- 脏房 / 维修 / 锁房 ----------
const dirtyRooms = ["306", "403", "502", "604"];
for (const no of dirtyRooms) {
  const room = roomIds.find((r) => r.no === no);
  if (room) db.prepare(`UPDATE rooms SET status = 'VD' WHERE id = ?`).run(room.id);
}
const maintRoom = roomIds.find((r) => r.no === "508");
if (maintRoom) db.prepare(`UPDATE rooms SET status = 'OOO', feature = '空调维修' WHERE id = ?`).run(maintRoom.id);
const lockRoom = roomIds.find((r) => r.no === "505");
if (lockRoom) db.prepare(`UPDATE rooms SET status = 'LOCK', feature = '内部预留' WHERE id = ?`).run(lockRoom.id);

// ---------- 预订 ----------
const bookingSeed = [
  { guest: 5, type: "SUI", channel: "去哪儿", in: 1, out: 3, rate: 588, status: "CONFIRMED", room: "502" },
  { guest: 7, type: "DLX", channel: "协议单位", in: 0, out: 2, rate: 328, status: "PENDING", room: null },
  { guest: 1, type: "STD", channel: "携程", in: 2, out: 4, rate: 268, status: "CONFIRMED", room: "308" },
  { guest: 3, type: "FAM", channel: "美团", in: 1, out: 2, rate: 468, status: "PENDING", room: null },
  { guest: 6, type: "DLX", channel: "散客", in: -1, out: 1, rate: 328, status: "NOSHOW", room: null },
];
let bkSeq = 3001;
for (const b of bookingSeed) {
  const g = guestSeed[b.guest];
  const roomId = b.room ? roomIds.find((r) => r.no === b.room)?.id : null;
  ins(
    `INSERT INTO bookings (hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id, channel_id, check_in_date, check_out_date, nights, room_count, guest_count, rate, deposit, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, `BK${bkSeq++}`, guestIds[b.guest], g[0], g[4], rtIds[b.type], roomId, channelIds[b.channel],
    ymd(addDays(now, b.in)), ymd(addDays(now, b.out)), b.out - b.in, 1, 1, b.rate, 0, b.status, "", 2, iso(now), iso(now)
  );
}

// ---------- 客房任务 ----------
for (const no of dirtyRooms) {
  const room = roomIds.find((r) => r.no === no);
  if (room) {
    ins(`INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, created_at) VALUES (?,?,?,?,?,?)`,
      hotelId, room.id, "打扫", "PENDING", "赵阿姨", iso(now));
  }
}

// ---------- 系统设置 ----------
const settings = [
  ["hotel_name", "云栖国际酒店"],
  ["check_in_time", "14:00"],
  ["check_out_time", "12:00"],
  ["currency", "CNY"],
  ["night_audit_time", "02:00"],
  ["invoice_title", "云栖国际酒店有限公司"],
];
for (const [k, v] of settings) {
  ins(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, hotelId, k, v);
}
// 注意：营业日切换时间 biz_day_cutoff 不在这里再写一份 —— 它由结尾的 runMigrations
// 统一按「每家酒店缺就补 05:00」写入，保持单一来源，避免两处默认值将来又对不上。

// ---------- 夜审历史 ----------
ins(`INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, revenue, occupancy, operator, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  hotelId, ymd(addDays(now, -1)), "DONE", 6, 18240, 0.2, "张经理", iso(now));

// ---------- 渠道直连：待处理订单 ----------
const channelOrderSeed = [
  { type: "ctrip", no: "CT260915001", guest: "马骏", mobile: "13811110001", rt: "DLX", in: 1, out: 3, amount: 656 },
  { type: "ctrip", no: "CT260915002", guest: "何静", mobile: "13811110002", rt: "STD", in: 2, out: 4, amount: 536 },
  { type: "meituan", no: "MT260915088", guest: "林涛", mobile: "13922220001", rt: "SUI", in: 1, out: 2, amount: 588 },
  { type: "meituan", no: "MT260915089", guest: "苏晴", mobile: "13922220002", rt: "FAM", in: 3, out: 5, amount: 936 },
  { type: "douyin", no: "DY260915520", guest: "小鹿", mobile: "13733330001", rt: "DLX", in: 1, out: 2, amount: 328 },
  { type: "douyin", no: "DY260915521", guest: "阿凯", mobile: "13733330002", rt: "STD", in: 2, out: 3, amount: 268 },
];
for (const o of channelOrderSeed) {
  const nights = o.out - o.in;
  ins(
    `INSERT INTO channel_orders (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile, check_in_date, check_out_date, nights, room_count, amount, status, raw, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, o.type, o.no, rtIds[o.rt], o.guest, o.mobile,
    ymd(addDays(now, o.in)), ymd(addDays(now, o.out)), nights, 1, o.amount, "NEW",
    JSON.stringify({ source: o.type, channelOrderNo: o.no, amount: o.amount }), iso(now)
  );
}

// ---------- 渠道同步日志 ----------
const logSeed = [
  ["ctrip", "PULL_ORDER", "SUCCESS", "拉取到 2 条新订单"],
  ["meituan", "PULL_ORDER", "SUCCESS", "拉取到 2 条新订单"],
  ["douyin", "PULL_ORDER", "SUCCESS", "拉取到 2 条新订单"],
  ["ctrip", "PUSH_INVENTORY", "SUCCESS", "推送 14 天房量成功"],
  ["meituan", "PUSH_RATE", "SUCCESS", "推送房型价格成功"],
];
for (const [type, action, status, msg] of logSeed) {
  ins(
    `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, created_at) VALUES (?,?,?,?,?,?)`,
    hotelId, type, action, status, msg, iso(addDays(now, -1))
  );
}

// ---------- 收尾：把 migrate-all 的增量变更跑一遍，把库推到目标状态 ----------
// 为什么要放在种子数据之后：
//   migrate-all 里除了加表 / 加列 / 建索引，还有几段数据迁移 ——
//   「给没有房间明细的预订补 booking_rooms」「给每家酒店补 biz_day_cutoff」。
//   种子插完再跑，这些数据迁移才能覆盖到刚灌进去的演示数据，
//   全新部署出来的库才和「老库跑完迁移」完全等价（多房预订、营业日偏好都能直接用）。
// 幂等：runMigrations 内部每步都先查 sqlite_master / PRAGMA 再动手，
//   重复执行只会得到 0 处变更，不会重复加列或重复插配置。
const migration = runMigrations(db, { checkOnly: false });

console.log("数据库初始化完成:", dbFile);
console.log("房型", roomTypes.length, "房间", roomIds.length, "在住", inhouse.length, "预订", bookingSeed.length);
if (migration.notes.length > 0) {
  for (const n of migration.notes) console.log("  提醒:", n);
}
// 这里如实打印变更数：全新库这些表/列/索引本来就该在初始化时一次建全，
// 迁移段显示「补齐 N 处」是正常现象；紧接着跑 migrate-all --check 应该报 0 处。
console.log(
  migration.changed === 0
    ? "迁移自检：已是目标状态（0 处变更）"
    : `迁移补齐：${migration.changed} 处（表/列/索引/默认配置，属预期；随后 db:migrate:check 应为 0 处）`
);
db.close();
