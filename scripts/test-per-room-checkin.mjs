/**
 * 逐间入住验收（整改报告 P1-4）
 *
 * 场景：一单 3 间房
 *   1. 建单双写 3 条明细
 *   2. 排房排满 3 间 → 主单 CONFIRMED
 *   3. 逐间办入住 → 每条明细独立 stay_id、状态 CHECKED_IN
 *   4. 只办 1 间时主单仍是 CONFIRMED（不能整单变已入住）
 *   5. 全办完后主单才 CHECKED_IN
 *
 * 数据自给自足（本次修复）：不再依赖「环境里正好有 3 间 VC 空房」。
 * 空房不足 3 间就自建 3 间测试房（房号 T-CHK3-<ts>-N），跑完连同订单一起删掉；
 * 连房型都没有（造不出来）时 exit(1)，不把「跳过」当通过。对照 test-checkout-vd.mjs 的修法。
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
const TS = Date.now();
/** 本脚本自建的房间 id（清理时删掉，避免污染房源） */
const syntheticRoomIds = [];

/**
 * 取 3 间可用房：优先用现有 VC，不足就自建
 *
 * ⚠️ 原来是：
 *     if (freeRooms.length < 3) { console.log("空房不足 3 间，跳过"); process.exit(0); }
 *     —— 假通过：退出码 0 会被验收脚本算成「通过」，但一条断言都没跑；
 *        少房门店 / 空库上的这个测试会永远是绿的。
 * 现在：造得出数据就跑完整套断言，造不出来就 exit(1) 明确报错（对照 test-checkout-vd.mjs）。
 */
function ensureThreeRooms() {
  const rooms = all(`SELECT id, room_no FROM rooms WHERE hotel_id = 1 AND status = 'VC' ORDER BY id LIMIT 3`);
  if (rooms.length === 3) return rooms;

  console.log(`空房只有 ${rooms.length} 间（需要 3 间），自建 ${3 - rooms.length} 间测试房`);
  const rt = one(`SELECT id FROM room_types WHERE hotel_id = 1 ORDER BY id LIMIT 1`);
  if (!rt) {
    console.error("❌ 库里没有房型（room_types 里没有 hotel 1 的记录），无法自建测试房 → 不能假装通过");
    process.exit(1);
  }

  db.exec("BEGIN");
  try {
    for (let i = rooms.length; i < 3; i += 1) {
      const roomNo = `T-CHK3-${TS}-${i}`;
      db.prepare(
        `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (1,?,?,?,'VC',9999)`
      ).run(roomNo, 99, rt.id);
      rooms.push(one(`SELECT id, room_no FROM rooms WHERE hotel_id = 1 AND room_no = ?`, [roomNo]));
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    console.error("❌ 自建测试房失败：", e.message);
    process.exit(1);
  }

  for (const r of rooms) if (String(r.room_no).startsWith("T-CHK3-")) syntheticRoomIds.push(r.id);
  console.log(`已自建 ${syntheticRoomIds.length} 间：${syntheticRoomIds.join(", ")}`);
  return rooms;
}

const testRooms = ensureThreeRooms();

/* 1. 造 3 间房订单 + 3 条明细 + 排满 */
let bookingId = 0;
db.exec("BEGIN");
try {
  const ins = db.prepare(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id, room_count,
       rate, check_in_date, check_out_date, nights, guest_count, status, created_at, updated_at)
     VALUES (1,?,'逐间入住测试','13900006666',1,?,3,328,'2026-12-05','2026-12-07',2,3,'PENDING',?,?)`
  ).run(`BK-CHK3-${TS}`, testRooms[0].id, now, now);
  bookingId = Number(ins.lastInsertRowid);
  for (let i = 0; i < 3; i += 1) {
    db.prepare(
      `INSERT INTO booking_rooms
         (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
          check_in_date, check_out_date, stay_id, created_at)
       VALUES (1,?,1,?,'逐间入住测试','13900006666',328,'CONFIRMED','2026-12-05','2026-12-07',NULL,?)`
    ).run(bookingId, testRooms[i].id, now);
  }
  db.prepare(`UPDATE bookings SET room_count = 3 WHERE id = ?`).run(bookingId);
  db.exec("COMMIT");
} catch (e) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* 已回滚 */
  }
  console.error("❌ 造订单数据失败：", e.message);
  process.exit(1);
}

/* 清理：删订单与明细，删自建房间（正常路径与断言异常都走这里） */
function cleanup() {
  db.exec("BEGIN");
  try {
    if (bookingId) {
      db.prepare(`DELETE FROM booking_rooms WHERE booking_id = ?`).run(bookingId);
      db.prepare(`DELETE FROM bookings WHERE id = ?`).run(bookingId);
    }
    if (syntheticRoomIds.length > 0) {
      const ph = syntheticRoomIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM rooms WHERE hotel_id = 1 AND id IN (${ph})`).run(...syntheticRoomIds);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    console.error("⚠️ 清理测试数据失败（可能残留）：", e.message);
  }
}

try {
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
} finally {
  cleanup();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
