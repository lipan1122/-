/**
 * 微信小程序 / 会员端验收（整改清单 F12）
 *
 * 覆盖清单（与任务书一一对应）：
 *   1. mini_program_config / mini_program_users 两张表存在；idx_mini_users_openid / idx_mini_users_token 索引存在
 *   2. 未配置 AppID 时 /api/mini/login 返回 NOT_CONFIGURED（源码分支 + 真实库判定）
 *   3. requireMiniToken 对无效 / 过期 token 返回 null（7 天有效期）
 *   4. 房量算法：物理房间数 − 在住 − 已排预订 − 维修房，能算出正确的可订数
 *   5. 小程序目录结构完整（5 个页面 × wxml/js/json/wxss + app 三件套 + utils）
 *   6. project.config.json 的 appid 是占位符（不是真实值）
 *   7. 全项目没有硬编码的微信 AppSecret / 真实 AppID
 *
 * 实现说明：
 *   测试脚本是纯 .mjs（没有 ts-node / tsx），无法 import 项目里的 .ts 路由。
 *   所以采用本项目既有测试的两种手法：
 *     · 静态校验：读源码确认关键分支存在（NOT_CONFIGURED / token 过期判定 / Bearer 解析）
 *     · 真实数据校验：在临时 SQLite 库里造场景，跑与 src/app/api/mini/_shared.ts
 *       完全相同的 SQL，验证房量 / token / 配置门槛的计算结果
 *   临时库放在系统临时目录，跑完即删，绝不污染 data/pms.db。
 *
 * 用法：node scripts/test-miniprogram.mjs
 */

import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB_PATH = process.env.PMS_DB_PATH ?? join(ROOT, "data", "pms.db");

let pass = 0;
let fail = 0;
/** 失败项名字，最后统一列出来（方便一眼看到哪几条没通过） */
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

/** 读文本文件，读不到返回空串（缺失文件由目录结构检查负责报错） */
function readText(relPath) {
  const p = join(ROOT, relPath);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** 递归收集目录下的文件（相对路径），用于「全项目扫描」 */
function walk(dir, out = [], skip = new Set(["node_modules", ".next", ".next-build", ".next-devcheck", ".git", "data", ".tmp"])) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, skip);
    else out.push(full);
  }
  return out;
}

/* ========================================================================== */
/* 1. 表与索引（真实库 data/pms.db）                                            */
/* ========================================================================== */

console.log("── 1. 数据表与索引 ──");

const realDb = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : null;
const sqliteMaster = (name, type) =>
  realDb ? realDb.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name).n > 0 : false;

check("数据库文件存在（先跑 node scripts/migrate-all.mjs）", Boolean(realDb), DB_PATH);
check("mini_program_config 表存在", sqliteMaster("mini_program_config", "table"));
check("mini_program_users 表存在", sqliteMaster("mini_program_users", "table"));
check("索引 idx_mini_users_openid 存在", sqliteMaster("idx_mini_users_openid", "index"));
check("索引 idx_mini_users_token 存在", sqliteMaster("idx_mini_users_token", "index"));

/** 表的列清单 */
function columnsOf(table) {
  if (!realDb) return [];
  try {
    return realDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

const configCols = columnsOf("mini_program_config");
const userCols = columnsOf("mini_program_users");
const needConfigCols = ["id", "hotel_id", "app_id", "app_secret", "mch_id", "mch_key", "enabled", "updated_at"];
const needUserCols = [
  "id",
  "hotel_id",
  "openid",
  "unionid",
  "guest_id",
  "mobile",
  "session_token",
  "token_expires_at",
  "created_at",
  "updated_at",
];
check(
  "mini_program_config 列齐全",
  needConfigCols.every((c) => configCols.includes(c)),
  `缺 ${needConfigCols.filter((c) => !configCols.includes(c)).join(",")}`
);
check(
  "mini_program_users 列齐全",
  needUserCols.every((c) => userCols.includes(c)),
  `缺 ${needUserCols.filter((c) => !userCols.includes(c)).join(",")}`
);
check(
  "mini_program_config 有 UNIQUE(hotel_id) 约束",
  realDb ? /UNIQUE\s*\(\s*hotel_id\s*\)/i.test(realDb.prepare(`SELECT sql FROM sqlite_master WHERE name = 'mini_program_config'`).get()?.sql ?? "") : false
);

// 选填：配置表里密钥不得是明文空字段以外的脏值（不校验用户真实数据，仅确认列可读）
if (realDb) {
  const cfgRows = realDb.prepare(`SELECT COUNT(*) AS n FROM mini_program_config`).all();
  check("mini_program_config 可正常查询（0 行代表尚未配置，属正常）", Array.isArray(cfgRows));
}

/* ========================================================================== */
/* 2. 源码静态校验：登录未配置分支 / token 机制                                  */
/* ========================================================================== */

console.log("\n── 2. 源码静态校验 ──");

const loginSrc = readText(join("src", "app", "api", "mini", "login", "route.ts"));
check("login 路由存在", loginSrc.length > 0);
check("login 路由有 NOT_CONFIGURED 分支", loginSrc.includes("NOT_CONFIGURED"));
check("login 路由使用 getActiveMiniConfig 判定配置", loginSrc.includes("getActiveMiniConfig"));
check("login 路由用 jscode2session 换 openid", loginSrc.includes("jscode2session"));
check("login 路由带 10 秒超时（AbortSignal.timeout）", loginSrc.includes("AbortSignal.timeout"));
check("login 路由把网络失败归一成 NETWORK", loginSrc.includes('"NETWORK"'));
check("login 路由把微信拒绝归一成 AUTH_FAILED", loginSrc.includes('"AUTH_FAILED"'));
check("login 路由不把 AppSecret 写进响应（无 appSecret 字段回传）", !/appSecret\s*:\s*cfg\.appSecret/.test(loginSrc));

const authSrc = readText(join("src", "lib", "mini-auth.ts"));
check("mini-auth.ts 存在", authSrc.length > 0);
check("requireMiniToken 从 Authorization 读 Bearer", /requireMiniToken/.test(authSrc) && /Bearer\\s\+/.test(authSrc));
check("token 有效期 7 天", /MINI_TOKEN_TTL_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(authSrc));
check("过期 token 判定（token_expires_at <= now 返回 null）", /expires\s*<=\s*nowIso\(\)/.test(authSrc));
check("查不到 token 时返回 null", /if\s*\(!row\)\s*return\s*null/.test(authSrc));

const configSrc = readText(join("src", "lib", "mini-config.ts"));
check("mini-config.ts 存在", configSrc.length > 0);
check("配置读写走 mini_program_config 表", configSrc.includes("mini_program_config"));
check("getActiveMiniConfig 要求 enabled + appId + appSecret 三项", /cfg\.enabled\s*&&\s*cfg\.appId\s*&&\s*cfg\.appSecret/.test(configSrc));

const routeFiles = [
  join("src", "app", "api", "mini", "login", "route.ts"),
  join("src", "app", "api", "mini", "rooms", "route.ts"),
  join("src", "app", "api", "mini", "bookings", "route.ts"),
  join("src", "app", "api", "mini", "bind", "route.ts"),
  join("src", "app", "api", "mini", "member", "route.ts"),
];
check("5 个接口路由文件都存在", routeFiles.every((f) => readText(f).length > 0));
check(
  "每个接口都声明 dynamic = force-dynamic",
  routeFiles.every((f) => /export const dynamic = "force-dynamic"/.test(readText(f)))
);
check(
  "下单 / 订单 / 绑定 / 会员 都做了 requireMiniToken 鉴权",
  [
    join("src", "app", "api", "mini", "bookings", "route.ts"),
    join("src", "app", "api", "mini", "bind", "route.ts"),
    join("src", "app", "api", "mini", "member", "route.ts"),
  ].every((f) => readText(f).includes("requireMiniToken"))
);

const migrateSrc = readText(join("scripts", "migrate-all.mjs"));
check("迁移脚本包含 mini_program_config 建表", migrateSrc.includes("CREATE TABLE mini_program_config"));
check("迁移脚本包含 mini_program_users 建表", migrateSrc.includes("CREATE TABLE mini_program_users"));
check("迁移脚本建 idx_mini_users_openid", migrateSrc.includes("idx_mini_users_openid"));
check("迁移脚本建 idx_mini_users_token", migrateSrc.includes("idx_mini_users_token"));

const settingsPage = readText(join("src", "app", "(main)", "settings", "page.tsx"));
const settingsActions = readText(join("src", "app", "(main)", "settings", "actions.ts"));
check("设置页有「小程序配置」tab", settingsPage.includes('key: "miniprogram"'));
check("设置页渲染 AppID / AppSecret 输入框", settingsPage.includes('name="app_id"') && settingsPage.includes('name="app_secret"'));
check("设置页有商户号 / 商户密钥输入框", settingsPage.includes('name="mch_id"') && settingsPage.includes('name="mch_key"'));
check("设置页有启用开关", settingsPage.includes('name="enabled"'));
check("设置页显示已配置 / 未配置状态", settingsPage.includes("已配置") && settingsPage.includes("未配置"));
check("设置 action 存在 saveMiniProgramConfigAction", settingsActions.includes("saveMiniProgramConfigAction"));
check("设置 action 只记字段不记密钥内容", settingsActions.includes("只记录动作与字段"));

/* ========================================================================== */
/* 3. 临时库：token 鉴权 / 配置门槛 / 房量算法                                  */
/* ========================================================================== */

console.log("\n── 3. 临时库场景校验（token / 配置门槛 / 房量） ──");

/*
 * 临时库目录：优先项目内 .tmp（部分沙箱里系统临时目录不可写，mkdtemp 会 EPERM），
 * 可用 PMS_TEST_TMPDIR 覆盖。跑完立即删除，不留垃圾。
 */
function makeTempDir() {
  const base = process.env.PMS_TEST_TMPDIR || join(ROOT, ".tmp");
  mkdirSync(base, { recursive: true });
  const name = `mini-test-${process.pid}-${Date.now()}`;
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDir = makeTempDir();
const tmpDbPath = join(tmpDir, "mini-test.db");
const db = new DatabaseSync(tmpDbPath);

/** 与 scripts/migrate-all.mjs 完全一致的 DDL（只建本测试需要的表） */
db.exec(`
  CREATE TABLE mini_program_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    app_id TEXT,
    app_secret TEXT,
    mch_id TEXT,
    mch_key TEXT,
    enabled INTEGER DEFAULT 0,
    updated_at TEXT,
    UNIQUE(hotel_id)
  );
  CREATE TABLE mini_program_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    openid TEXT NOT NULL,
    unionid TEXT,
    guest_id INTEGER,
    mobile TEXT,
    session_token TEXT,
    token_expires_at TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid);
  CREATE INDEX idx_mini_users_token ON mini_program_users(session_token);

  CREATE TABLE room_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    code TEXT,
    name TEXT,
    bed_type TEXT,
    max_occupancy INTEGER,
    base_price REAL,
    sort INTEGER
  );
  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_no TEXT,
    floor INTEGER,
    room_type_id INTEGER,
    status TEXT
  );
  CREATE TABLE stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    stay_no TEXT,
    room_id INTEGER,
    check_in_time TEXT,
    expect_check_out TEXT,
    status TEXT
  );
  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    booking_no TEXT,
    room_type_id INTEGER,
    check_in_date TEXT,
    check_out_date TEXT,
    room_count INTEGER,
    status TEXT
  );
  CREATE TABLE booking_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    booking_id INTEGER,
    room_type_id INTEGER,
    room_id INTEGER,
    status TEXT,
    check_in_date TEXT,
    check_out_date TEXT,
    stay_id INTEGER
  );
  CREATE TABLE rate_calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_type_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    allotment INTEGER
  );
`);

const NOW = new Date();
const iso = (ms) => new Date(ms).toISOString();

/**
 * 与 src/lib/mini-auth.ts 的 resolveMiniUser 等价的 SQL 判定。
 * （纯 .mjs 无法 import .ts，这里刻意复制同一份判定，语义必须一致）
 */
function resolveMiniToken(token) {
  if (!token) return null;
  const row = db
    .prepare(`SELECT id, hotel_id, openid, guest_id, token_expires_at FROM mini_program_users WHERE session_token = ? LIMIT 1`)
    .get(token);
  if (!row) return null;
  const expires = String(row.token_expires_at ?? "");
  if (!expires || expires <= iso(NOW.getTime())) return null;
  return { id: row.id, hotelId: row.hotel_id, openid: row.openid, guestId: row.guest_id ?? null };
}

const INSERT_USER = db.prepare(
  `INSERT INTO mini_program_users (hotel_id, openid, guest_id, session_token, token_expires_at, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`
);

// 有效 token（还有 6 天）
INSERT_USER.run(1, "openid-valid", null, "token-valid", iso(NOW.getTime() + 6 * 86400000), iso(NOW.getTime()), iso(NOW.getTime()));
// 过期 token（1 小时前过期）
INSERT_USER.run(1, "openid-expired", null, "token-expired", iso(NOW.getTime() - 3600000), iso(NOW.getTime()), iso(NOW.getTime()));
// 没有过期时间的 token（缺字段，必须视为无效）
INSERT_USER.run(1, "openid-noexp", null, "token-noexp", null, iso(NOW.getTime()), iso(NOW.getTime()));

check("有效 token 能解析出身份", resolveMiniToken("token-valid")?.openid === "openid-valid");
check("无效 token 返回 null", resolveMiniToken("token-not-exist") === null);
check("空 token 返回 null", resolveMiniToken("") === null);
check("过期 token 返回 null", resolveMiniToken("token-expired") === null);
check("缺少过期时间的 token 返回 null", resolveMiniToken("token-noexp") === null);
check("token 解析出的 hotelId 正确", resolveMiniToken("token-valid")?.hotelId === 1);

/**
 * 与 src/lib/mini-config.ts 的 getActiveMiniConfig 等价的 SQL 判定：
 * enabled = 1 且 app_id / app_secret 都非空。
 */
function activeConfig(hotelId) {
  const rows = db
    .prepare(`SELECT hotel_id, app_id, app_secret, enabled FROM mini_program_config ORDER BY hotel_id`)
    .all();
  for (const cfg of rows) {
    const appId = String(cfg.app_id ?? "").trim();
    const secret = String(cfg.app_secret ?? "").trim();
    if (Number(cfg.enabled ?? 0) === 1 && appId && secret) {
      if (hotelId === undefined || cfg.hotel_id === hotelId) return { hotelId: cfg.hotel_id, appId, secret };
    }
  }
  return null;
}

const INSERT_CFG = db.prepare(
  `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, mch_id, mch_key, enabled, updated_at) VALUES (?,?,?,?,?,?,?)`
);

// 空配置 → 登录必须拒绝
check("配置表为空时判定为「未配置」（login 返回 NOT_CONFIGURED）", activeConfig() === null);

// 只填 AppID、未启用 → 仍然拒绝
INSERT_CFG.run(1001, "wx0000000000000001", "", "", "", 0, iso(NOW.getTime()));
check("只填 AppID 且未启用 → 仍判定未配置", activeConfig(1001) === null);

// 填了 AppID + Secret 但没启用 → 拒绝
INSERT_CFG.run(1002, "wx0000000000000002", "0123456789abcdef0123456789abcdef", "", "", 0, iso(NOW.getTime()));
check("填齐 AppID + Secret 但 enabled = 0 → 仍判定未配置", activeConfig(1002) === null);

// 启用 + 填齐 → 通过
INSERT_CFG.run(1003, "wx0000000000000003", "0123456789abcdef0123456789abcdef", "", "", 1, iso(NOW.getTime()));
check("启用且 AppID + Secret 齐全 → 判定已配置", activeConfig(1003)?.hotelId === 1003);

/* ------------------------------- 房量算法 -------------------------------- */

// 房型：10 间物理房，其中 2 间维修房（OOO），门市价 400
const typeId = Number(
  db
    .prepare(`INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort) VALUES (?,?,?,?,?,?,?)`)
    .run(1, "DLX", "豪华大床房", "1.8m 大床", 2, 400, 1).lastInsertRowid
);
const roomIds = [];
for (let i = 1; i <= 10; i += 1) {
  const status = i <= 8 ? "VC" : "OOO";
  roomIds.push(
    Number(db.prepare(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status) VALUES (?,?,?,?,?)`).run(1, "R" + 100 + i, 1, typeId, status).lastInsertRowid)
  );
}

// 场景：查 2026-11-18 → 2026-11-20（2 晚）
const CHECK_IN = "2026-11-18";
const CHECK_OUT = "2026-11-20";

// ① 3 条在住单，区间与该区间相交
for (let i = 0; i < 3; i += 1) {
  db.prepare(`INSERT INTO stays (hotel_id, stay_no, room_id, check_in_time, expect_check_out, status) VALUES (?,?,?,?,?,?)`).run(
    1,
    "S" + i,
    roomIds[i],
    "2026-11-17T14:00:00",
    "2026-11-19",
    "INHOUSE"
  );
}
// ② 不在区间内的在住单（11-20 → 11-22，半开区间不冲突，不应计入）
db.prepare(`INSERT INTO stays (hotel_id, stay_no, room_id, check_in_time, expect_check_out, status) VALUES (?,?,?,?,?,?)`).run(
  1,
  "S-out",
  roomIds[3],
  "2026-11-20T14:00:00",
  "2026-11-22",
  "INHOUSE"
);

// ③ 一张有明细的预订：2 条 PENDING 明细（应计 2 间）
const bkWithDetail = Number(
  db.prepare(`INSERT INTO bookings (hotel_id, booking_no, room_type_id, check_in_date, check_out_date, room_count, status) VALUES (?,?,?,?,?,?,?)`).run(1, "BK9001", typeId, CHECK_IN, CHECK_OUT, 2, "CONFIRMED").lastInsertRowid
);
for (let i = 0; i < 2; i += 1) {
  db.prepare(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, status, check_in_date, check_out_date, stay_id) VALUES (?,?,?,?,?,?,?,?)`
  ).run(1, bkWithDetail, typeId, null, "PENDING", CHECK_IN, CHECK_OUT, null);
}

// ④ 一张没有明细的历史主单（room_count = 2，应计 2 间）
db.prepare(`INSERT INTO bookings (hotel_id, booking_no, room_type_id, check_in_date, check_out_date, room_count, status) VALUES (?,?,?,?,?,?,?)`).run(1, "BK9002", typeId, CHECK_IN, CHECK_OUT, 2, "PENDING");

// ⑤ 已取消的预订（含明细）：明细仍在，但父单 CANCELLED，不能占房
const bkCancelled = Number(
  db.prepare(`INSERT INTO bookings (hotel_id, booking_no, room_type_id, check_in_date, check_out_date, room_count, status) VALUES (?,?,?,?,?,?,?)`).run(1, "BK9003", typeId, CHECK_IN, CHECK_OUT, 3, "CANCELLED").lastInsertRowid
);
for (let i = 0; i < 3; i += 1) {
  db.prepare(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, status, check_in_date, check_out_date, stay_id) VALUES (?,?,?,?,?,?,?,?)`
  ).run(1, bkCancelled, typeId, null, "PENDING", CHECK_IN, CHECK_OUT, null);
}

// ⑥ 已转入住的明细（stay_id 有值 → 由在住单计数，不能再算一次，否则重复）
const bkCheckedIn = Number(
  db.prepare(`INSERT INTO bookings (hotel_id, booking_no, room_type_id, check_in_date, check_out_date, room_count, status) VALUES (?,?,?,?,?,?,?)`).run(1, "BK9004", typeId, CHECK_IN, CHECK_OUT, 1, "CHECKED_IN").lastInsertRowid
);
db.prepare(
  `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, status, check_in_date, check_out_date, stay_id) VALUES (?,?,?,?,?,?,?,?)`
).run(1, bkCheckedIn, typeId, roomIds[4], "CHECKED_IN", CHECK_IN, CHECK_OUT, 1);

// ⑦ 区间外预订（11-20 → 11-21，不该计入）
db.prepare(`INSERT INTO bookings (hotel_id, booking_no, room_type_id, check_in_date, check_out_date, room_count, status) VALUES (?,?,?,?,?,?,?)`).run(1, "BK9005", typeId, "2026-11-20", "2026-11-21", 1, "PENDING");

// 房价日历：11-18 有 500，11-19 没有 → 回落门市价 400 → 均价 450，2 晚总价 900
db.prepare(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, allotment) VALUES (?,?,?,?,?)`).run(1, typeId, "2026-11-18", 500, null);

/** 与 src/app/api/mini/_shared.ts 的 loadAvailability 完全相同的四条占用 SQL */
function availability(hotelId, checkIn, checkOut) {
  const types = db
    .prepare(
      `SELECT rt.id, COALESCE(rt.base_price, 0) AS base_price,
              (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS total_rooms,
              (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id AND r.status = 'OOO') AS ooo_rooms
         FROM room_types rt WHERE rt.hotel_id = ? ORDER BY rt.sort, rt.id`
    )
    .all(hotelId);

  const stays = db
    .prepare(
      `SELECT r.room_type_id AS room_type_id, COUNT(*) AS n
         FROM stays s JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
          AND COALESCE(substr(s.check_in_time, 1, 10), '') < ?
          AND COALESCE(s.expect_check_out, '') > ?
        GROUP BY r.room_type_id`
    )
    .all(hotelId, checkOut, checkIn);

  const details = db
    .prepare(
      `SELECT br.room_type_id AS room_type_id, COUNT(*) AS n
         FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
        WHERE br.hotel_id = ?
          AND br.stay_id IS NULL
          AND br.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          AND br.check_in_date < ? AND br.check_out_date > ?
        GROUP BY br.room_type_id`
    )
    .all(hotelId, checkOut, checkIn);

  const legacy = db
    .prepare(
      `SELECT b.room_type_id AS room_type_id, COALESCE(SUM(COALESCE(b.room_count, 1)), 0) AS n
         FROM bookings b
        WHERE b.hotel_id = ? AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          AND b.check_in_date < ? AND b.check_out_date > ?
          AND NOT EXISTS (SELECT 1 FROM booking_rooms br2 WHERE br2.booking_id = b.id)
        GROUP BY b.room_type_id`
    )
    .all(hotelId, checkOut, checkIn);

  const occupied = new Map();
  for (const row of [...stays, ...details, ...legacy]) {
    occupied.set(Number(row.room_type_id), (occupied.get(Number(row.room_type_id)) ?? 0) + Number(row.n));
  }

  const nights = Math.round((new Date(checkOut + "T00:00:00") - new Date(checkIn + "T00:00:00")) / 86400000);
  const rates = db
    .prepare(`SELECT room_type_id, date, price FROM rate_calendar WHERE hotel_id = ? AND date >= ? AND date < ?`)
    .all(hotelId, checkIn, checkOut);
  const rateMap = new Map();
  for (const r of rates) rateMap.set(`${r.room_type_id}|${r.date}`, Number(r.price));

  return types.map((t) => {
    let sum = 0;
    for (let i = 0; i < nights; i += 1) {
      const d = new Date(checkIn + "T00:00:00");
      d.setDate(d.getDate() + i);
      const p = (n) => String(n).padStart(2, "0");
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      sum += rateMap.has(`${t.id}|${day}`) ? rateMap.get(`${t.id}|${day}`) : Number(t.base_price);
    }
    const occ = occupied.get(Number(t.id)) ?? 0;
    return {
      roomTypeId: Number(t.id),
      totalRooms: Number(t.total_rooms),
      maintenanceRooms: Number(t.ooo_rooms),
      occupiedRooms: occ,
      remainingRooms: Math.max(0, Number(t.total_rooms) - occ - Number(t.ooo_rooms)),
      nights,
      totalPrice: Math.round(sum * 100) / 100,
      avgPrice: Math.round((sum / nights) * 100) / 100,
    };
  });
}

const [av] = availability(1, CHECK_IN, CHECK_OUT);
check("物理房间数 = 10", av.totalRooms === 10, `实际 ${av.totalRooms}`);
check("维修房扣减 = 2", av.maintenanceRooms === 2, `实际 ${av.maintenanceRooms}`);
/*
 * 占用 = 3 在住 + 2 有明细的预订 + 2 无明细的历史主单 = 7
 * 已取消单（3 间）与已转入住明细（1 间）都不得计入：
 *   · 已取消单被父单状态过滤掉
 *   · 已转入住明细被 stay_id IS NULL 排除（在住单已经算过）
 * 区间外（11-20 起）的在住与预订也不得计入。
 */
check("占用房量 = 7（在住 3 + 明细 2 + 历史主单 2）", av.occupiedRooms === 7, `实际 ${av.occupiedRooms}`);
check("可订房量 = 10 − 7 − 2 = 1", av.remainingRooms === 1, `实际 ${av.remainingRooms}`);
check("晚数 = 2", av.nights === 2);
check("区间总价 = 500 + 400 = 900（缺日历的日子回落门市价）", av.totalPrice === 900, `实际 ${av.totalPrice}`);
check("每晚均价 = 450", av.avgPrice === 450, `实际 ${av.avgPrice}`);

// 相邻区间（11-20 → 11-22）：只应命中区间外那两条（1 在住 + 1 预订）
const [av2] = availability(1, "2026-11-20", "2026-11-22");
check("相邻区间占用 = 2（半开区间：11-20 当天可接续）", av2.occupiedRooms === 2, `实际 ${av2.occupiedRooms}`);
check("相邻区间可订 = 10 − 2 − 2 = 6", av2.remainingRooms === 6, `实际 ${av2.remainingRooms}`);

// 已订满时不得出现负数
db.prepare(`UPDATE rooms SET status = 'OOO' WHERE hotel_id = 1 AND id IN (?,?,?,?,?,?,?,?)`).run(...roomIds.slice(0, 8));
check("房量算不出负数（维修房 ≥ 物理房量时 clamp 到 0）", availability(1, CHECK_IN, CHECK_OUT)[0].remainingRooms === 0);
db.prepare(`UPDATE rooms SET status = 'VC' WHERE hotel_id = 1 AND id IN (?,?,?,?,?,?,?,?)`).run(...roomIds.slice(0, 8));

db.close();
rmSync(tmpDir, { recursive: true, force: true });
console.log(`（临时库已清理：${tmpDir}）`);

/* ========================================================================== */
/* 4. 小程序目录结构                                                            */
/* ========================================================================== */

console.log("\n── 4. 小程序目录结构 ──");

const MP = "miniprogram";
check("miniprogram/ 目录存在", existsSync(join(ROOT, MP)));
check("app.js 存在", existsSync(join(ROOT, MP, "app.js")));
check("app.json 存在", existsSync(join(ROOT, MP, "app.json")));
check("app.wxss 存在", existsSync(join(ROOT, MP, "app.wxss")));
check("project.config.json 存在", existsSync(join(ROOT, MP, "project.config.json")));
check("README.md 存在", existsSync(join(ROOT, MP, "README.md")));
check("utils/api.js 存在", existsSync(join(ROOT, MP, "utils", "api.js")));

const PAGES = ["index", "booking", "orders", "member", "bind"];
let pageOk = true;
const missing = [];
for (const page of PAGES) {
  for (const ext of ["wxml", "js", "json", "wxss"]) {
    const rel = join(MP, "pages", page, `${page}.${ext}`);
    if (!existsSync(join(ROOT, rel))) {
      pageOk = false;
      missing.push(rel);
    }
  }
}
check("5 个页面目录各有 wxml / js / json / wxss", pageOk, missing.join("; "));

const appJson = JSON.parse(readText(join(MP, "app.json")) || "{}");
const registered = (appJson.pages || []).map((p) => String(p).split("/")[1]);
check(
  "app.json 注册了 5 个页面",
  PAGES.every((p) => registered.includes(p)),
  `实际 ${JSON.stringify(appJson.pages)}`
);
check("app.json 有 tabBar（首页 / 订单 / 会员）", Array.isArray(appJson.tabBar?.list) && appJson.tabBar.list.length === 3);

const apiSrc = readText(join(MP, "utils", "api.js"));
check("api.js 用常量 BASE_URL 配置服务端地址", /const BASE_URL = ['"]/.test(apiSrc));
check("api.js 用 Authorization: Bearer 携带 token", apiSrc.includes("'Bearer '"));
check("api.js 处理 401（token 过期重新登录）", apiSrc.includes("UNAUTHORIZED"));
check("api.js 对 POST 不做 401 自动重试（防重复下单）", /method !== 'GET'/.test(apiSrc));

const appSrc = readText(join(MP, "app.js"));
check("app.js 启动时静默登录", appSrc.includes("ensureLogin"));

const readmeSrc = readText(join(MP, "README.md"));
check("README 说明怎么填 AppID", /AppID/.test(readmeSrc) && /mp\.weixin\.qq\.com/.test(readmeSrc));
check("README 说明怎么配服务器域名", readmeSrc.includes("服务器域名"));
check("README 说明改 BASE_URL", readmeSrc.includes("BASE_URL"));

/* ========================================================================== */
/* 5. appid 占位符 + 无硬编码密钥                                               */
/* ========================================================================== */

console.log("\n── 5. appid 占位符与密钥安全 ──");

let projectConfig = {};
try {
  projectConfig = JSON.parse(readText(join(MP, "project.config.json")) || "{}");
} catch {
  projectConfig = {};
}
const appid = String(projectConfig.appid ?? "");
check("project.config.json 可解析", Object.keys(projectConfig).length > 0);
check("project.config.json 的 appid 是占位符（全 0，不是真实 AppID）", /^wx0{16}$/.test(appid), `实际 "${appid}"`);

/** 全项目扫描：wx + 16 位字母数字，只允许占位符 */
const files = walk(ROOT);
const appIdHits = [];
const secretHits = [];
for (const file of files) {
  // 只扫源码 / 文档 / 配置，跳过二进制与数据库
  if (!/\.(ts|tsx|js|mjs|json|md|wxml|wxss|txt|example)$/i.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
  // 跳过依赖与构建产物
  if (rel.startsWith("node_modules/") || rel.startsWith(".next") || rel.startsWith("data/")) continue;
  /*
   * 跳过本脚本自己：里面为了造「启用 / 未启用」场景写了合成 AppID（wx0000...0001 之类）
   * 与合成密钥字面量，不是真实凭据，扫进来会误报。
   */
  if (rel === "scripts/test-miniprogram.mjs") continue;

  // 真实 AppID：wx 开头 + 16 位字母数字（占位符全 0 不算）
  for (const m of text.matchAll(/\bwx[0-9A-Za-z]{16}\b/g)) {
    if (!/^wx0{16}$/.test(m[0])) appIdHits.push(`${rel}: ${m[0]}`);
  }
  // 硬编码密钥：app_secret / appSecret / mch_key / mchKey 后面直接跟 16 位以上字面量
  for (const m of text.matchAll(/["']?(?:app_secret|appSecret|mch_key|mchKey)["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/g)) {
    secretHits.push(`${rel}: ${m[0].slice(0, 60)}`);
  }
}
check("全项目没有真实微信 AppID（只有 wx0000000000000000 占位符）", appIdHits.length === 0, appIdHits.slice(0, 5).join("; "));
check("全项目没有硬编码的 AppSecret / 商户密钥", secretHits.length === 0, secretHits.slice(0, 5).join("; "));
check("路由代码里 AppSecret 只从配置表读取（不出现字面量）", !/app_secret\s*=\s*["'][A-Za-z0-9]{20,}/.test(loginSrc + configSrc));

/* ========================================================================== */

if (realDb) realDb.close();

console.log("\n" + (failed.length ? `失败项：\n  - ${failed.join("\n  - ")}` : "全部通过"));
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
