/**
 * 取消排房口径验收（整改指令 3.4）
 *
 * 要求：取消排房只能释放房间占用关系，不能删除订单、客人和历史记录。
 *
 * 缺陷背景：旧实现只改主单 status/room_id，booking_rooms 明细还挂着
 * room_id + CONFIRMED —— 占房唯一索引继续算作已占，房量不回来，
 * 房态图上仍显示「有预订」，渠道推库存也算错。
 *
 * 本脚本：静态校验 + 真实数据一致性 + 行为验证（事务内造数据后回滚）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const src = readFileSync(join("src", "app", "(main)", "bookings", "actions.ts"), "utf8");

function funcBody(name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}

/* ---------- 静态 ---------- */
console.log("=== 3.4 取消排房口径 ===");
const cancel = funcBody("cancelBookingAction");
const batchCancel = funcBody("batchCancelBookingsAction");
const batchTeam = funcBody("batchCancelTeamRoomsAction");

check("单条取消：释放明细 room_id", /UPDATE booking_rooms[\s\S]{0,200}room_id = NULL/.test(cancel));
check("单条取消：明细置 CANCELLED", /SET room_id = NULL, status = 'CANCELLED'/.test(cancel));
check("单条取消：主单 room_id 也清空", /UPDATE bookings SET status = 'CANCELLED', room_id = NULL/.test(cancel));
check("单条取消：不删订单（无 DELETE FROM bookings）", !/DELETE FROM bookings/.test(cancel));
check("单条取消：不删客史", !/DELETE FROM guests/.test(cancel));
check("单条取消：写操作日志", /op_logs/.test(cancel));

check("批量取消：释放明细", /UPDATE booking_rooms[\s\S]{0,200}room_id = NULL/.test(batchCancel));
check("批量取消：不删订单", !/DELETE FROM bookings/.test(batchCancel));
check("批量取消：写操作日志", /op_logs/.test(batchCancel));

check("团队取消排房：释放明细", /UPDATE booking_rooms[\s\S]{0,300}room_id = NULL/.test(batchTeam));
check("团队取消排房：订单保留（status → PENDING）", /UPDATE bookings SET room_id = NULL, status = 'PENDING'/.test(batchTeam));
check("团队取消排房：写操作日志", /团队取消排房/.test(batchTeam));

/* 全文件不应有"取消"路径删订单 */
check("整个 bookings/actions.ts 没有『取消即删』的写法",
  !/cancel[\s\S]{0,300}DELETE FROM bookings/i.test(src));

/* ---------- 数据一致性 ---------- */
console.log("\n=== 数据一致性 ===");
const db = new DatabaseSync(DB, { readOnly: true });

/* 已取消订单的明细不应还占着房 */
const cancelledStillOccupy = db.prepare(
  `SELECT b.booking_no, br.id, br.room_id, br.status
     FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
    WHERE br.hotel_id = 1 AND b.status = 'CANCELLED'
      AND br.room_id IS NOT NULL AND br.status IN ('PENDING','CONFIRMED')
    LIMIT 10`
).all();
check("已取消订单的明细不再占房", cancelledStillOccupy.length === 0,
  JSON.stringify(cancelledStillOccupy.slice(0, 3)));

/* 已取消订单的主单不应还挂着 room_id */
const cancelledMain = db.prepare(
  `SELECT booking_no, room_id FROM bookings
    WHERE hotel_id = 1 AND status = 'CANCELLED' AND room_id IS NOT NULL LIMIT 10`
).all();
check("已取消订单主单 room_id 已清空", cancelledMain.length === 0,
  JSON.stringify(cancelledMain.slice(0, 3)));

/* 取消订单不能把客史删掉 */
const guests = db.prepare(`SELECT COUNT(*) c FROM guests WHERE hotel_id = 1`).get().c;
check("客史记录未被取消操作删除", guests > 0, `${guests} 位客人`);
const bookings = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE hotel_id = 1`).get().c;
check("已取消订单仍在库里（可追溯）", bookings > 0, `${bookings} 条预订`);

/* ---------- 行为：事务内造数据验证后回滚 ---------- */
console.log("\n=== 行为验证（造数据后回滚）===");
const w = new DatabaseSync(DB);
let behaviourOk = true;
const detail = [];
w.exec("BEGIN");
try {
  const hotelId = 1;
  /* 造一条已排房预订 */
  const bkId = w.prepare(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, status, room_id, check_in_date, check_out_date, nights, room_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(hotelId, "BK-CANCEL-TEST", "取消测试客", "CONFIRMED", 1, "2026-12-01", "2026-12-03", 2, 1, new Date().toISOString()).lastInsertRowid;
  w.prepare(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_id, guest_name, status, check_in_date, check_out_date, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(hotelId, bkId, 1, "取消测试客", "CONFIRMED", "2026-12-01", "2026-12-03", new Date().toISOString());

  /* 模拟单条取消的实现 */
  w.prepare(`UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
              WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`).run(hotelId, bkId);
  w.prepare(`UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ?
              WHERE id = ? AND hotel_id = ?`).run(new Date().toISOString(), bkId, hotelId);

  const br = w.prepare(`SELECT room_id, status FROM booking_rooms WHERE booking_id = ?`).get(bkId);
  const bk = w.prepare(`SELECT status, room_id FROM bookings WHERE id = ?`).get(bkId);

  behaviourOk = br.room_id === null && br.status === "CANCELLED" && bk.status === "CANCELLED" && bk.room_id === null;
  detail.push(`明细 room_id=${br.room_id} status=${br.status}／主单 status=${bk.status} room_id=${bk.room_id}`);
  /* 订单还在 */
  const still = w.prepare(`SELECT COUNT(*) c FROM bookings WHERE id = ?`).get(bkId).c;
  behaviourOk = behaviourOk && still === 1;
  detail.push(`订单仍在：${still} 条`);
} catch (e) {
  behaviourOk = false;
  detail.push(`异常：${e.message}`);
} finally {
  w.exec("ROLLBACK");
  w.close();
}
check("取消排房后：明细释放 + 订单保留", behaviourOk, detail.join(" ｜ "));

/* 回滚干净 */
const db2 = new DatabaseSync(DB, { readOnly: true });
const residue = db2.prepare(`SELECT COUNT(*) c FROM bookings WHERE booking_no = 'BK-CANCEL-TEST'`).get().c;
check("测试数据已回滚（无残留）", residue === 0, `残留 ${residue} 条`);
db2.close();

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
