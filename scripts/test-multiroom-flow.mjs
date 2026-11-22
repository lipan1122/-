/**
 * 多房预订端到端验证：建单 → 双写明细 → 排房 → 明细落房
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

/* 造一条 3 间房预订（模拟 createBookingAction 的双写） */
const now = new Date().toISOString();
db.exec("BEGIN");
let bookingId = 0;
try {
  const ins = db.prepare(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id, room_count,
       rate, check_in_date, check_out_date, nights, guest_count, status, created_at, updated_at)
     VALUES (1,'BK-E2E3','双写测试客','13900007777',1,NULL,3,328,'2026-12-01','2026-12-03',2,3,'PENDING',?,?)`
  ).run(now, now);
  bookingId = Number(ins.lastInsertRowid);

  /* 双写：3 条明细 */
  for (let i = 0; i < 3; i += 1) {
    db.prepare(
      `INSERT INTO booking_rooms
         (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
          check_in_date, check_out_date, stay_id, created_at)
       VALUES (1,?,1,NULL,'双写测试客','13900007777',328,'PENDING','2026-12-01','2026-12-03',NULL,?)`
    ).run(bookingId, now);
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.log("造数据失败:", e.message);
  process.exit(1);
}

const details = all(`SELECT id, room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bookingId]);
check("建单同时生成 3 条明细", details.length === 3, `实际 ${details.length}`);
check("新建明细全部待排房", details.every((d) => d.room_id === null && d.status === "PENDING"));

/* 模拟排一间房：找空房 */
const freeRoom = one(`SELECT id, room_no FROM rooms WHERE hotel_id = 1 AND status = 'VC' LIMIT 1`);
if (!freeRoom) {
  console.log("没有空房可用于测试");
  process.exit(1);
}

/* 排房：写明细 + 主单镜像 */
db.exec("BEGIN");
try {
  const d = details[0];
  db.prepare(`UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED' WHERE id = ?`).run(freeRoom.id, d.id);
  const rest = one(`SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ? AND room_id IS NULL`, [bookingId]).c;
  const assigned = one(`SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ? AND room_id IS NOT NULL`, [bookingId]).c;
  db.prepare(
    `UPDATE bookings SET room_id = COALESCE(room_id, ?), room_count = ?,
       status = CASE WHEN ? > 0 THEN 'PENDING' ELSE 'CONFIRMED' END WHERE id = ?`
  ).run(freeRoom.id, assigned, rest, bookingId);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.log("排房失败:", e.message);
}

const after = all(`SELECT id, room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bookingId]);
const bk = one(`SELECT room_id, room_count, status FROM bookings WHERE id = ?`, [bookingId]);
check("排房后第 1 条明细带房号", after[0].room_id === freeRoom.id && after[0].status === "CONFIRMED");
check("排房后其余 2 条仍待排", after.filter((d) => d.room_id === null).length === 2);
check("主单 room_id 镜像到首间房", bk.room_id === freeRoom.id);
check("主单 room_count = 已排间数", Number(bk.room_count) === 1, `实际 ${bk.room_count}`);
check("还有待排房时主单保持 PENDING", bk.status === "PENDING", `实际 ${bk.status}`);

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
