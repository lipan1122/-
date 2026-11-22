/**
 * 多房预订明细表迁移（整改报告 P1-4）
 *
 * 背景：bookings 有 room_count，但一条预订只有一个 room_id，
 *       订 3 间房时排房/入住无法准确表示实际房量。
 *
 * 目标结构：
 *   bookings        预订主单（保留，作为订单头）
 *   booking_rooms   房间明细（一间一行，可独立排房、独立客人、独立房价）
 *   stays           入住单（入住时按明细生成）
 *   folios          账务单（每间一张）
 *
 * 迁移规则：
 *   1. 建 booking_rooms 表
 *   2. 每条现有预订按其 room_count 生成 N 条明细
 *      - 第 1 条带原 booking.room_id（已排房的订单）
 *      - 其余 room_id 为 NULL（待排房）
 *   3. 之前「拆单方案」产生的 BK-xxx-1 子单，合并回主单（booking_no 去掉 -N 后缀），
 *      其房间数累加到主单，然后删除子单，避免主单明细与子单重复
 *
 * 用法：
 *   node scripts/migrate-booking-rooms.mjs            # dry-run
 *   node scripts/migrate-booking-rooms.mjs --apply
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB_PATH = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync(DB_PATH);
const now = new Date().toISOString();

/* ---------- 1. 建表 ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS booking_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  room_type_id INTEGER,
  room_id INTEGER,
  guest_name TEXT,
  mobile TEXT,
  rate REAL DEFAULT 0,
  status TEXT DEFAULT 'PENDING',
  check_in_date TEXT,
  check_out_date TEXT,
  stay_id INTEGER,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_booking_rooms_booking ON booking_rooms(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_rooms_room ON booking_rooms(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_rooms_occupied
  ON booking_rooms(room_id, check_in_date, check_out_date)
  WHERE room_id IS NOT NULL AND status IN ('CONFIRMED','CHECKED_IN');
`);
console.log("booking_rooms 表已就绪");

/* ---------- 2. 合并历史拆单 ---------- */
/* 只认「结尾是 -数字」的号才是拆出的子单；BN 单号本身可能含横线（如 BK-TEST3） */
const splits = db
  .prepare(
    `SELECT id, hotel_id, booking_no, room_count, room_id, status FROM bookings
      WHERE booking_no GLOB '*-[0-9]*' AND booking_no GLOB '*-[0-9][0-9]'
         OR booking_no LIKE '%-1' OR booking_no LIKE '%-2' OR booking_no LIKE '%-3'
      ORDER BY id`
  )
  .all()
  .filter((b) => /-\d+$/.test(b.booking_no));

console.log(`\n历史拆单（BK-xxx-N）${splits.length} 条`);

const mergeLog = [];
for (const sp of splits) {
  const parentNo = sp.booking_no.replace(/-\d+$/, "");
  if (parentNo === sp.booking_no) continue; // 防御：不要合并到自己
  const parent = db
    .prepare(`SELECT id, room_count FROM bookings WHERE hotel_id = ? AND booking_no = ?`)
    .get(sp.hotel_id, parentNo);
  if (!parent) {
    mergeLog.push(`  ${sp.booking_no} 找不到主单 ${parentNo}，跳过`);
    continue;
  }
  if (parent.id === sp.id) continue; // 防御：同一行
  mergeLog.push(`  ${sp.booking_no}（${sp.room_count}间）合并进 ${parentNo}`);
}
for (const l of mergeLog.slice(0, 10)) console.log(l);
if (mergeLog.length > 10) console.log(`  …还有 ${mergeLog.length - 10} 条`);

/* ---------- 3. 统计将要生成的明细 ---------- */
const bookings = db
  .prepare(
    `SELECT id, hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
            room_count, rate, status, check_in_date, check_out_date
       FROM bookings WHERE status NOT IN ('CANCELLED') ORDER BY id`
  )
  .all();

const already = db.prepare(`SELECT COUNT(*) AS c FROM booking_rooms`).get().c;
console.log(`\n待迁移预订 ${bookings.length} 条，将生成明细约 ${bookings.reduce((s, b) => s + Math.max(1, b.room_count ?? 1), 0)} 行`);
console.log(`booking_rooms 现有 ${already} 行`);

if (!APPLY) {
  console.log("\ndry-run，未写入。加 --apply 执行迁移。");
  process.exit(0);
}

/* ---------- 4. 执行 ---------- */
db.exec("BEGIN");
try {
  /* 4.1 合并拆单：把子单房间数并回主单，删除子单 */
  for (const sp of splits) {
    const parentNo = sp.booking_no.replace(/-\d+$/, "");
    if (parentNo === sp.booking_no) continue; // 不是拆单号
    const parent = db
      .prepare(`SELECT id, room_count FROM bookings WHERE hotel_id = ? AND booking_no = ?`)
      .get(sp.hotel_id, parentNo);
    if (!parent || parent.id === sp.id) continue;
    db.prepare(`UPDATE bookings SET room_count = COALESCE(room_count,1) + ? WHERE id = ?`).run(
      Math.max(0, Number(sp.room_count ?? 1)),
      parent.id
    );
    db.prepare(`UPDATE channel_orders SET booking_id = ? WHERE booking_id = ?`).run(parent.id, sp.id);
    db.prepare(`DELETE FROM bookings WHERE id = ?`).run(sp.id);
  }

  /* 4.2 为每条预订生成明细 */
  db.prepare(`DELETE FROM booking_rooms`).run();
  const ins = db.prepare(
    `INSERT INTO booking_rooms
       (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
        check_in_date, check_out_date, stay_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  let made = 0;
  for (const b of bookings) {
    const n = Math.max(1, Number(b.room_count ?? 1));
    const statusMap =
      b.status === "CHECKED_IN" ? "CHECKED_IN" : b.status === "CONFIRMED" ? "CONFIRMED" : "PENDING";
    for (let i = 0; i < n; i += 1) {
      ins.run(
        b.hotel_id,
        b.id,
        b.room_type_id,
        i === 0 ? b.room_id : null, // 只有第 1 间带原房号
        b.guest_name,
        b.mobile,
        b.rate ?? 0,
        b.room_id && i === 0 ? "CONFIRMED" : statusMap,
        b.check_in_date,
        b.check_out_date,
        null,
        now
      );
      made += 1;
    }
    /* 主单 room_count 归一（合并拆单后可能偏大） */
    db.prepare(`UPDATE bookings SET room_count = ? WHERE id = ?`).run(n, b.id);
  }

  db.exec("COMMIT");
  console.log(`\n已生成 ${made} 条房间明细`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("迁移失败已回滚:", e.message);
  process.exit(1);
}

/* ---------- 5. 校验 ---------- */
const check = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM bookings WHERE status <> 'CANCELLED') AS bookings,
       (SELECT COUNT(*) FROM booking_rooms) AS details,
       (SELECT COUNT(*) FROM bookings b
         WHERE b.status <> 'CANCELLED'
           AND (SELECT COUNT(*) FROM booking_rooms br WHERE br.booking_id = b.id) = 0) AS empty`
  )
  .get();
console.log(`校验：预订 ${check.bookings} 条 · 明细 ${check.details} 行 · 无明细的预订 ${check.empty} 条`);
console.log(check.empty === 0 && check.details >= check.bookings ? "迁移完成 ✅" : "仍有预订缺少明细 ⚠️");
db.close();
process.exit(check.empty === 0 ? 0 : 1);
