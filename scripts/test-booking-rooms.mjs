/**
 * 多房预订明细验收（整改报告 P1-4）
 *
 * 1. booking_rooms 表结构与索引
 * 2. 每条有效预订都有明细，明细数 ≈ room_count
 * 3. 已排房的明细指向真实房间
 * 4. 同一房间同区间不能被两条明细同时占（唯一索引）
 * 5. 主单没有残留的拆单子号
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* 1. 表结构 */
const cols = all(`PRAGMA table_info(booking_rooms)`).map((c) => c.name);
const need = ["id", "hotel_id", "booking_id", "room_type_id", "room_id", "guest_name", "rate", "status", "check_in_date", "check_out_date", "stay_id"];
check("booking_rooms 字段齐全", need.every((c) => cols.includes(c)), `缺 ${need.filter((c) => !cols.includes(c)).join(",")}`);

const idx = all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='booking_rooms'`).map((i) => i.name);
check("booking_rooms 有按预订/房间的索引", idx.includes("idx_booking_rooms_booking") && idx.includes("idx_booking_rooms_room"), idx.join(","));
check("booking_rooms 有占房唯一索引", idx.includes("idx_booking_rooms_occupied"));

/* 2. 明细覆盖 */
const noDetail = all(
  `SELECT b.booking_no FROM bookings b
    WHERE b.status <> 'CANCELLED'
      AND NOT EXISTS (SELECT 1 FROM booking_rooms br WHERE br.booking_id = b.id) LIMIT 5`
);
check("每条有效预订都有房间明细", noDetail.length === 0, JSON.stringify(noDetail.map((r) => r.booking_no)));

const countMismatch = all(
  `SELECT b.booking_no, b.room_count,
          (SELECT COUNT(*) FROM booking_rooms br WHERE br.booking_id = b.id) AS details
     FROM bookings b
    WHERE b.status <> 'CANCELLED'
      AND (SELECT COUNT(*) FROM booking_rooms br WHERE br.booking_id = b.id) <> MAX(1, COALESCE(b.room_count,1))
    LIMIT 5`
);
check("明细数 = 预订房间数", countMismatch.length === 0, JSON.stringify(countMismatch));

/* 3. 已排房明细指向真实房间 */
const badRoom = all(
  `SELECT br.id, br.room_id FROM booking_rooms br
    WHERE br.room_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = br.room_id) LIMIT 5`
);
check("已排房明细都指向真实房间", badRoom.length === 0, JSON.stringify(badRoom));

/* 4. 唯一索引拦住重复占房 */
const sample = one(
  `SELECT room_id, check_in_date, check_out_date, hotel_id, booking_id
     FROM booking_rooms WHERE room_id IS NOT NULL AND status IN ('CONFIRMED','CHECKED_IN') LIMIT 1`
);
if (sample) {
  const wdb = new DatabaseSync(DB);
  let blocked = false;
  try {
    wdb.prepare(
      `INSERT INTO booking_rooms (hotel_id, booking_id, room_id, status, check_in_date, check_out_date, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(sample.hotel_id, sample.booking_id, sample.room_id, "CONFIRMED", sample.check_in_date, sample.check_out_date, new Date().toISOString());
  } catch { blocked = true; }
  check("同房间同区间重复占房被唯一索引拦截", blocked);
  wdb.close();
} else {
  check("同房间同区间重复占房被唯一索引拦截", false, "没有已排房样本");
}

/* 5. 没有残留的拆单子号 */
const splitLeft = all(`SELECT booking_no FROM bookings WHERE booking_no GLOB '*-[0-9]' AND booking_no GLOB '*-[0-9][0-9]' LIMIT 5`)
  .filter((b) => /-\d+$/.test(b.booking_no) && !/^BK-[A-Z]+[0-9]*$/.test(b.booking_no));
check("没有残留的拆单子号（BK-xxx-N）", splitLeft.length === 0, JSON.stringify(splitLeft.map((r) => r.booking_no)));

/* 统计 */
const stat = one(
  `SELECT (SELECT COUNT(*) FROM bookings WHERE status <> 'CANCELLED') AS bk,
          (SELECT COUNT(*) FROM booking_rooms) AS br,
          (SELECT COUNT(*) FROM booking_rooms WHERE room_id IS NOT NULL) AS assigned,
          (SELECT COUNT(*) FROM bookings WHERE room_count > 1) AS multi`
);
console.log(`\n预订 ${stat.bk} 条 | 明细 ${stat.br} 行 | 已排 ${stat.assigned} | 多房单 ${stat.multi} 条`);
console.log(`通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
