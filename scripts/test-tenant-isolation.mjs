/**
 * 多租户隔离验收（整改报告 P1-9）
 *
 * 1. 所有业务表都有 hotel_id 列
 * 2. 关键唯一约束是「酒店内唯一」而非全局唯一
 * 3. 造第二家酒店的数据，验证查询不会串号
 * 4. 越权访问被拒（拿不到别家酒店的房间/账单/客人）
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);

/* 1. 业务表都有 hotel_id */
const TABLES = [
  "bookings", "stays", "folios", "folio_items", "payments", "rooms", "room_types",
  "guests", "companies", "channels", "channel_orders", "settings", "op_logs",
  "room_logs", "housekeeping", "night_audits",
];
const missingHotel = [];
for (const t of TABLES) {
  const cols = all(`PRAGMA table_info(${t})`).map((c) => c.name);
  if (cols.length > 0 && !cols.includes("hotel_id")) missingHotel.push(t);
}
check("所有业务表都有 hotel_id 列", missingHotel.length === 0, missingHotel.join(", "));

/* 2. 唯一约束是酒店内唯一 */
const uniChecks = [
  { name: "night_audits 唯一键含 hotel_id", sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='night_audits'`, want: /UNIQUE\s*\(\s*hotel_id\s*,\s*biz_date\s*\)/i },
  { name: "channel_orders 唯一索引含 hotel_id", sql: `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_channel_orders_key'`, want: /hotel_id/i },
  { name: "payments 幂等索引含 hotel_id", sql: `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_payments_request'`, want: /hotel_id/i },
];
for (const c of uniChecks) {
  const row = one(c.sql);
  check(c.name, Boolean(row?.sql && c.want.test(row.sql)), row?.sql?.slice(0, 100) ?? "索引不存在");
}

/* 3. 造第二家酒店的数据，验证互不可见
 *
 * 原来 catch 里只打印「（造测试数据跳过：...）」就继续跑 —— 假通过：
 * 数据没造出来时，下面「酒店 999 的查询拿不到酒店 1 的房间」会变成恒真的空集比较，
 * 「用别家 room_id 越权查询」那条断言又被 if (h2RoomId) 整个跳过，退出码仍是 0。
 * 现在：造不出来就 exit(1) 明确报错，不把「跳过」当通过。
 * 另外 hotels.code 是 NOT NULL —— 原 INSERT 没给 code，INSERT OR IGNORE 会把整行静默丢掉。
 */
const now = new Date().toISOString();
db.exec("BEGIN");
try {
  db.prepare(`INSERT OR IGNORE INTO hotels (id, code, name, address, phone) VALUES (999, 'T999', '租户隔离测试酒店', '测试', '000')`).run();
  db.prepare(
    `INSERT OR IGNORE INTO room_types (hotel_id, name, code, base_price, max_occupancy, sort) VALUES (999, '测试房型', 'TEST', 100, 2, 1)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort)
     VALUES (999, (SELECT id FROM room_types WHERE hotel_id = 999 LIMIT 1), 'T999', 9, 'VC', 999)`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO guests (hotel_id, name, mobile, vip_level) VALUES (999, '租户B客人', '13900000000', 0)`
  ).run();
  db.exec("COMMIT");
} catch (e) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* 已回滚 */
  }
  console.error("❌ 造第二家酒店（hotel 999）的测试数据失败：", e.message, "→ 后面 3 条隔离断言无从验证，不能假装通过");
  process.exit(1);
}

const h1Rooms = all(`SELECT room_no FROM rooms WHERE hotel_id = 1`);
const h2Rooms = all(`SELECT room_no FROM rooms WHERE hotel_id = 999`);
check("酒店 1 的查询拿不到酒店 999 的房间", !h1Rooms.some((r) => r.room_no === "T999"), JSON.stringify(h2Rooms));
check("酒店 999 的查询拿不到酒店 1 的房间", !h2Rooms.some((r) => h1Rooms.some((x) => x.room_no === r.room_no)), "");

const h1Guests = all(`SELECT name FROM guests WHERE hotel_id = 1`);
check("酒店 1 的客人列表不含别家客人", !h1Guests.some((g) => g.name === "租户B客人"));

/* 4. 跨租户按 id 直查（模拟越权） */
const h2RoomId = one(`SELECT id FROM rooms WHERE hotel_id = 999 LIMIT 1`)?.id;
if (!h2RoomId) {
  /* 原来这里是 if (h2RoomId) { ... }：查不到房间就把这条越权断言静默跳过 → 少一条还判绿 */
  console.error("❌ 查不到 hotel 999 的房间 id，越权拦截无法验证 → 不静默跳过");
  process.exit(1);
}
const crossLookup = one(`SELECT room_no, status FROM rooms WHERE id = ? AND hotel_id = 1`, [h2RoomId]);
check("用别家酒店的 room_id 查本酒店返回空（越权被拦）", !crossLookup, JSON.stringify(crossLookup));

/* 5. 清理测试租户 */
try {
  db.exec("BEGIN");
  db.prepare(`DELETE FROM rooms WHERE hotel_id = 999`).run();
  db.prepare(`DELETE FROM room_types WHERE hotel_id = 999`).run();
  db.prepare(`DELETE FROM guests WHERE hotel_id = 999`).run();
  db.prepare(`DELETE FROM hotels WHERE id = 999`).run();
  db.exec("COMMIT");
} catch {
  db.exec("ROLLBACK");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
