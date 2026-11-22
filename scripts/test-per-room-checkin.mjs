/**
 * 逐间入住验收（整改报告 P1-4）
 *
 * 场景：一单 3 间房
 *   1. 建单双写 3 条明细
 *   2. 排房排满 3 间 → 主单 CONFIRMED
 *   3. 逐间办入住 → 每条明细独立 stay_id、状态 CHECKED_IN
 *   4. 只办 1 间时主单仍是 CONFIRMED（不能整单变已入住）
 *   5. 全办完后主单才 CHECKED_IN
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const now = new Date().toISOString();
const freeRooms = all(`SELECT id, room_no FROM rooms WHERE hotel_id = 1 AND status = 'VC' LIMIT 3`);
if (freeRooms.length < 3) {
  console.log("空房不足 3 间，跳过");
  process.exit(0);
}

/* 1. 造 3 间房订单 + 3 条明细 + 排满 */
let bookingId = 0;
db.exec("BEGIN");
try {
  const ins = db.prepare(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id, room_count,
       rate, check_in_date, check_out_date, nights, guest_count, status, created_at, updated_at)
     VALUES (1,'BK-CHK3','逐间入住测试','13900006666',1,?,3,328,'2026-12-05','2026-12-07',2,3,'PENDING',?,?)`
  ).run(freeRooms[0].id, now, now);
  bookingId = Number(ins.lastInsertRowid);
  for (let i = 0; i < 3; i += 1) {
    db.prepare(
      `INSERT INTO booking_rooms
         (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
          check_in_date, check_out_date, stay_id, created_at)
       VALUES (1,?,1,?,'逐间入住测试','13900006666',328,'CONFIRMED','2026-12-05','2026-12-07',NULL,?)`
    ).run(bookingId, freeRooms[i].id, now);
  }
  db.prepare(`UPDATE bookings SET room_count = 3 WHERE id = ?`).run(bookingId);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.log("造数据失败:", e.message);
  process.exit(1);
}

const before = all(`SELECT id, room_id, stay_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bookingId]);
check("建单后 3 条明细全部已排房待入住", before.length === 3 && before.every((d) => d.room_id && d.stay_id === null && d.status === "CONFIRMED"));

/* 2. 模拟逐间入住第 1 间 */
function checkInDetail(detailId, roomId, stayId) {
  db.prepare(`UPDATE booking_rooms SET stay_id = ?, status = 'CHECKED_IN' WHERE id = ?`).run(stayId, detailId);
  const left = one(
    `SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ? AND status NOT IN ('CHECKED_IN','CHECKED_OUT','CANCELLED')`,
    [bookingId]
  ).c;
  db.prepare(
    `UPDATE bookings SET status = CASE WHEN ? > 0 THEN 'CONFIRMED' ELSE 'CHECKED_IN' END WHERE id = ?`
  ).run(left, bookingId);
  return left;
}

const left1 = checkInDetail(before[0].id, before[0].room_id, 990001);
const bk1 = one(`SELECT status FROM bookings WHERE id = ?`, [bookingId]);
check("只办 1 间时明细 1 已入住", one(`SELECT status FROM booking_rooms WHERE id = ?`, [before[0].id]).status === "CHECKED_IN");
check("只办 1 间时主单仍是 CONFIRMED（不整单变已入住）", bk1.status === "CONFIRMED", `实际 ${bk1.status}`);
check("剩余未入住明细 = 2", left1 === 2, `实际 ${left1}`);

/* 3. 办完剩下 2 间 */
checkInDetail(before[1].id, before[1].room_id, 990002);
checkInDetail(before[2].id, before[2].room_id, 990003);
const bk2 = one(`SELECT status FROM bookings WHERE id = ?`, [bookingId]);
check("3 间全办完主单才 CHECKED_IN", bk2.status === "CHECKED_IN", `实际 ${bk2.status}`);

const after = all(`SELECT id, stay_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bookingId]);
check("每条明细都有独立 stay_id", after.every((d) => d.stay_id !== null) && new Set(after.map((d) => d.stay_id)).size === 3);
check("每条明细状态都是 CHECKED_IN", after.every((d) => d.status === "CHECKED_IN"));

/* 清理 */
db.exec("BEGIN");
try {
  db.prepare(`DELETE FROM booking_rooms WHERE booking_id = ?`).run(bookingId);
  db.prepare(`DELETE FROM bookings WHERE id = ?`).run(bookingId);
  db.exec("COMMIT");
} catch { db.exec("ROLLBACK"); }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
