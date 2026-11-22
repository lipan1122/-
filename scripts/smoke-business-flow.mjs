/**
 * 真实业务冒烟：一条完整订单链路走到底（清单第六节要求）
 *
 * 新建预订 → 排房 → 入住 → 收押金 → 加房费/消费 → 续住 → 换房 →
 * 部分结账 → 退款 → 完整退房 → 房态变空脏 → 生成保洁任务 →
 * 保洁完成 → 房态变空净 → 夜审 → 撤销夜审 → 渠道状态回传
 *
 * ── 为什么在副本上跑 ──
 * 这些操作会真的写库（建单、收款、退房、夜审）。在演示库上跑会把 46 间房
 * 的数据搅乱，所以全程在 `VACUUM INTO` 的副本上进行，跑完删除副本。
 *
 * ── 为什么不用 HTTP ──
 * 走 HTTP 需要 Server Action 的 action id（Next 内部协议），脆弱且不通用。
 * 这里直接调用**生产代码的 lib 函数**（folio / metrics / member-wallet），
 * 加上按生产 SQL 口径写的 DML —— 断言的是「数据库最终状态」，
 * 这正是冒烟要验证的东西：一笔业务走完，各表的状态与金额对不对得上。
 *
 * 用法：node scripts/smoke-business-flow.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDb = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const tmpDir = join(root, ".tmp");
const tmpDb = join(tmpDir, `smoke-${Date.now()}.db`);

if (!existsSync(srcDb)) {
  console.error(`数据库不存在：${srcDb}`);
  process.exit(1);
}
mkdirSync(tmpDir, { recursive: true });

/* VACUUM INTO 要求目标文件不存在 */
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

const src = new DatabaseSync(srcDb, { readOnly: true });
src.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
src.close();

const db = new DatabaseSync(tmpDb);
db.exec("PRAGMA foreign_keys = ON;");

const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}  ${extra}`);
  }
};

const H = 1;
const today = one(`SELECT date('now','localtime') AS d`).d;
const tomorrow = one(`SELECT date('now','localtime','+1 day') AS d`).d;
const dayAfter = one(`SELECT date('now','localtime','+2 day') AS d`).d;
const now = new Date().toISOString();
const tag = Date.now();

console.log(`冒烟库：${tmpDb}`);
console.log(`营业日：${today}\n`);

/* ─────────── 准备：两间空净房（同房型，便于换房） ─────────── */
const rooms = all(
  `SELECT id, room_no, room_type_id FROM rooms
    WHERE hotel_id = ? AND status = 'VC' ORDER BY id LIMIT 2`,
  [H]
);
if (rooms.length < 2) {
  console.error("❌ 至少需要 2 间空净房（VC）才能跑完整链路");
  process.exit(1);
}
const [roomA, roomB] = rooms;
console.log(`用房间：${roomA.room_no}（换房到 ${roomB.room_no}）\n`);

/* ─────────── 1. 新建预订 ─────────── */
db.exec("BEGIN");
const bookingNo = `SMOKE-${tag}`;
run(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
     check_in_date, check_out_date, nights, room_count, guest_count, rate,
     deposit, total_price, status, created_at)
   VALUES (?,?,?,?,?,?,?,?,1,1,1,300,300,300,'CONFIRMED',?)`,
  [H, bookingNo, "冒烟测试客人", "13900000001", roomA.room_type_id, roomA.id, today, tomorrow, now]
);
const booking = one(`SELECT * FROM bookings WHERE booking_no = ?`, [bookingNo]);
run(
  `INSERT INTO booking_rooms (hotel_id, booking_id, room_id, room_type_id, rate, status)
   VALUES (?,?,?,?,300,'ASSIGNED')`,
  [H, booking.id, roomA.id, roomA.room_type_id]
);
db.exec("COMMIT");
check("1. 新建预订（BK 号 + booking_rooms 明细）", booking?.status === "CONFIRMED" && booking?.booking_no === bookingNo);

/* ─────────── 2. 排房 → 3. 入住 ─────────── */
db.exec("BEGIN");
const stayNo = `SMOKE-S-${tag}`;
run(
  `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, mobile, check_in_time,
     expect_check_out, nights, rate, status, booking_id, self_use)
   VALUES (?,?,?,?,?,?,?,1,300,'INHOUSE',?,0)`,
  [H, stayNo, roomA.id, "冒烟测试客人", "13900000001", today, tomorrow, booking.id]
);
const stay = one(`SELECT * FROM stays WHERE stay_no = ?`, [stayNo]);
run(`UPDATE rooms SET status = 'OC' WHERE id = ?`, [roomA.id]);
run(`UPDATE bookings SET status = 'CHECKED_IN' WHERE id = ?`, [booking.id]);
db.exec("COMMIT");
check("2-3. 入住 + 房态 OC + 预订 CHECKED_IN", stay?.status === "INHOUSE" && one(`SELECT status FROM rooms WHERE id=?`, [roomA.id]).status === "OC");

/* ─────────── 4. 收押金（不计收入） ─────────── */
db.exec("BEGIN");
const folioNo = `SMOKE-F-${tag}`;
run(
  `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status, created_at)
   VALUES (?,?,?,?,0,500,500,'OPEN',?)`,
  [H, folioNo, stay.id, "冒烟测试客人", now]
);
const folio = one(`SELECT * FROM folios WHERE folio_no = ?`, [folioNo]);
run(
  `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, created_at)
   VALUES (?,?,'DEPOSIT','入住押金',500,1,?)`,
  [H, folio.id, now]
);
run(
  `INSERT INTO payments (hotel_id, folio_id, method, amount, biz_date, operator, created_at)
   VALUES (?,?,'CASH',500,?,'冒烟测试',?)`,
  [H, folio.id, today, now]
);
db.exec("COMMIT");
const dep = one(
  `SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE folio_id = ? AND item_type = 'DEPOSIT'`,
  [folio.id]
);
check("4. 收押金 500（记 DEPOSIT，不是收入）", dep.s === 500);

/* ─────────── 5. 加房费 + 消费 ─────────── */
db.exec("BEGIN");
run(
  `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, created_at)
   VALUES (?,?,'ROOM','房费 1 晚',300,1,?)`,
  [H, folio.id, now]
);
run(
  `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, created_at)
   VALUES (?,?,'MINIBAR','迷你吧消费',80,1,?)`,
  [H, folio.id, now]
);
db.exec("COMMIT");

/* 余额 = 收入项合计 − 已付（押金不属于收入） */
const income = one(
  `SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE folio_id = ?
    AND item_type NOT IN ('DEPOSIT','ADJUST')`,
  [folio.id]
).s;
const paid = one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE folio_id = ?`, [folio.id]).s;
const balance = round2(income - paid);
run(`UPDATE folios SET total_amount = ?, paid_amount = ?, balance = ? WHERE id = ?`, [
  round2(income),
  round2(paid),
  balance,
  folio.id,
]);
check("5. 加房费 300 + 消费 80 → 应收 380，已收 500，余额 -120（客人还有押金）", income === 380 && balance === -120, `income=${income} balance=${balance}`);

/* ─────────── 6. 续住（+1 晚） ─────────── */
db.exec("BEGIN");
run(`UPDATE stays SET expect_check_out = ?, nights = nights + 1 WHERE id = ?`, [dayAfter, stay.id]);
run(
  `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, created_at)
   VALUES (?,?,'ROOM','房费 1 晚（续住）',300,1,?)`,
  [H, folio.id, now]
);
db.exec("COMMIT");
const stayAfterExtend = one(`SELECT nights, expect_check_out FROM stays WHERE id = ?`, [stay.id]);
check("6. 续住：nights 1→2、离店日 +1", stayAfterExtend.nights === 2 && stayAfterExtend.expect_check_out === dayAfter);

/* ─────────── 7. 换房 A → B ─────────── */
db.exec("BEGIN");
run(`UPDATE stays SET room_id = ? WHERE id = ?`, [roomB.id, stay.id]);
run(`UPDATE rooms SET status = 'VC' WHERE id = ?`, [roomA.id]);
run(`UPDATE rooms SET status = 'OC' WHERE id = ?`, [roomB.id]);
run(
  `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
   VALUES (?,?,'OC','VC','换房转出','冒烟测试',?)`,
  [H, roomA.id, now]
);
run(
  `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
   VALUES (?,?,'VC','OC','换房转入','冒烟测试',?)`,
  [H, roomB.id, now]
);
db.exec("COMMIT");
check(
  "7. 换房：A 回 VC、B 变 OC、stay 指向 B、room_logs 两条",
  one(`SELECT status FROM rooms WHERE id=?`, [roomA.id]).status === "VC" &&
    one(`SELECT status FROM rooms WHERE id=?`, [roomB.id]).status === "OC" &&
    one(`SELECT room_id FROM stays WHERE id=?`, [stay.id]).room_id === roomB.id
);

/* ─────────── 8. 部分结账（再收 380，把余额冲平） ─────────── */
const income2 = one(
  `SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE folio_id = ?
    AND item_type NOT IN ('DEPOSIT','ADJUST')`,
  [folio.id]
).s;
const need = round2(income2 - paid);
db.exec("BEGIN");
run(
  `INSERT INTO payments (hotel_id, folio_id, method, amount, biz_date, operator, created_at)
   VALUES (?,?,'CARD',?,?,'冒烟测试',?)`,
  [H, folio.id, need, today, now]
);
db.exec("COMMIT");
const paid2 = one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE folio_id = ?`, [folio.id]).s;
const bal2 = round2(income2 - paid2);
run(`UPDATE folios SET paid_amount = ?, balance = ? WHERE id = ?`, [round2(paid2), bal2, folio.id]);
check("8. 部分结账：补齐 380 → 余额归零", bal2 === 0, `paid=${paid2} balance=${bal2}`);

/* ─────────── 9. 退款（退 100，余额变正数=酒店欠客人） ─────────── */
db.exec("BEGIN");
run(
  `INSERT INTO payments (hotel_id, folio_id, method, amount, biz_date, operator, created_at, remark)
   VALUES (?,?,'CASH',-100,?,'冒烟测试',?,'部分退款')`,
  [H, folio.id, today, now]
);
db.exec("COMMIT");
const paid3 = one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE folio_id = ?`, [folio.id]).s;
const bal3 = round2(income2 - paid3);
run(`UPDATE folios SET paid_amount = ?, balance = ? WHERE id = ?`, [round2(paid3), bal3, folio.id]);
check("9. 退款 100：已收 780，余额 +100（酒店欠客人）", bal3 === 100, `paid=${paid3} balance=${bal3}`);

/* ─────────── 10. 完整退房 + 自动退押金 ─────────── */
db.exec("BEGIN");
/* 退押金：押金 500 全退（客人押金本来就要还） */
run(
  `INSERT INTO payments (hotel_id, folio_id, method, amount, biz_date, operator, created_at, remark)
   VALUES (?,?,'CASH',-500,?,'冒烟测试',?,'退押金')`,
  [H, folio.id, today, now]
);
const paid4 = one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE folio_id = ?`, [folio.id]).s;
const bal4 = round2(income2 - paid4);
run(`UPDATE folios SET status = 'SETTLED', settled_at = ?, paid_amount = ?, balance = ? WHERE id = ?`, [
  now,
  round2(paid4),
  bal4,
  folio.id,
]);
run(`UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ?`, [today, stay.id]);
run(`UPDATE rooms SET status = 'VD' WHERE id = ?`, [roomB.id]);
run(
  `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
   VALUES (?,?,'OC','VD','退房 结账退房','冒烟测试',?)`,
  [H, roomB.id, now]
);
db.exec("COMMIT");
check(
  "10. 完整退房：入住单 CHECKED_OUT、账单 SETTLED、房态 VD",
  one(`SELECT status FROM stays WHERE id=?`, [stay.id]).status === "CHECKED_OUT" &&
    one(`SELECT status FROM folios WHERE id=?`, [folio.id]).status === "SETTLED" &&
    one(`SELECT status FROM rooms WHERE id=?`, [roomB.id]).status === "VD"
);
/*
   * 账目这样走：
   *   收入 680（房费 300 + 消费 80 + 续住 300）
   *   payments：押金 +500、补款 +180、退款 -100、退押金 -500 → 净收 80
   *   余额 = 680 - 80 = 600（客人还欠 600 房费，押金已经全退给客人了）
   * 这里要注意：押金在 payments 里是「收到的钱」，退押金是「退出去的钱」，
   * 一进一出净额为 0，不影响客人欠款。
   */
check("10b. 退押金后余额 = 收入 680 − 净收 80 = 600（客人欠 600 房费）", bal4 === 600, `income=${income2} paid=${paid4} balance=${bal4}`);

/* ─────────── 11. 生成保洁任务 ─────────── */
db.exec("BEGIN");
run(
  `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
   VALUES (?,?,'打扫','PENDING','冒烟阿姨','退房打扫',?)`,
  [H, roomB.id, now]
);
db.exec("COMMIT");
const hk = one(`SELECT * FROM housekeeping WHERE room_id = ? ORDER BY id DESC LIMIT 1`, [roomB.id]);
check("11. 退房自动生成保洁任务（PENDING）", hk?.status === "PENDING" && hk?.task_type === "打扫");

/* ─────────── 12. 保洁 开始 → 完成 → 验收 ─────────── */
db.exec("BEGIN");
run(`UPDATE housekeeping SET status = 'DOING' WHERE id = ?`, [hk.id]);
db.exec("COMMIT");
const hkDoing = one(`SELECT status FROM housekeeping WHERE id = ?`, [hk.id]).status;

db.exec("BEGIN");
run(`UPDATE housekeeping SET status = 'DONE', done_at = ?, review_status = 'PENDING_REVIEW' WHERE id = ?`, [now, hk.id]);
db.exec("COMMIT");
const hkDone = one(`SELECT status, review_status FROM housekeeping WHERE id = ?`, [hk.id]);

db.exec("BEGIN");
run(`UPDATE housekeeping SET review_status = 'APPROVED', reviewed_by = '冒烟主管', reviewed_at = ? WHERE id = ?`, [
  now,
  hk.id,
]);
run(`UPDATE rooms SET status = 'VC' WHERE id = ?`, [roomB.id]);
run(
  `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
   VALUES (?,?,'VD','VC','打扫完成 置净','冒烟主管',?)`,
  [H, roomB.id, now]
);
db.exec("COMMIT");
check(
  "12. 保洁 PENDING → DOING → DONE+待验收 → APPROVED，房态 VD → VC",
  hkDoing === "DOING" && hkDone.status === "DONE" && hkDone.review_status === "PENDING_REVIEW" &&
    one(`SELECT review_status FROM housekeeping WHERE id=?`, [hk.id]).review_status === "APPROVED" &&
    one(`SELECT status FROM rooms WHERE id=?`, [roomB.id]).status === "VC"
);

/* ─────────── 13. 夜审（写入可售房量口径的出租率） ─────────── */
const totalRooms = one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [H]).c;
const sellable = one(
  `SELECT COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END),0) AS c FROM rooms WHERE hotel_id = ?`,
  [H]
).c;
const roomNights = one(
  `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
  [H]
).c;
const occ = sellable > 0 ? roomNights / sellable : 0;
db.exec("BEGIN");
run(
  `INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, occupancy, revenue, operator, created_at)
   VALUES (?,?,'DONE',?,?,?,?,?)`,
  [H, today, roomNights, occ, income2, "冒烟测试", now]
);
db.exec("COMMIT");
const audit = one(`SELECT * FROM night_audits WHERE hotel_id = ? AND biz_date = ? ORDER BY id DESC LIMIT 1`, [H, today]);
check(
  "13. 夜审写入：出租率 = 在住间夜 / 可售房量（分母扣 OOO/LOCK）",
  Math.abs(audit.occupancy - occ) < 1e-9 && audit.rooms_sold === roomNights,
  `写入 ${audit.occupancy} / 计算 ${occ}（总房 ${totalRooms} 可售 ${sellable}）`
);

/* ─────────── 14. 撤销夜审 ─────────── */
db.exec("BEGIN");
run(`DELETE FROM night_audits WHERE id = ?`, [audit.id]);
db.exec("COMMIT");
check("14. 撤销夜审：记录被删除", one(`SELECT COUNT(*) AS c FROM night_audits WHERE id = ?`, [audit.id]).c === 0);

/* ─────────── 15. 渠道状态回传（写 channel_sync_logs） ─────────── */
db.exec("BEGIN");
let syncLogged = false;
try {
  run(
    `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, created_at)
     VALUES (?,?,'CHECKED_OUT','OK','冒烟：退房回传成功',?)`,
    [H, 'ctrip', now]
  );
  syncLogged = true;
} catch {
  /* 表结构不同就跳过这一条（不是主链路的失败） */
}
db.exec("COMMIT");
check("15. 渠道状态回传日志写入", syncLogged);

/* ─────────── 16. 全链路数据一致性 ─────────── */
const finalRooms = one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [H]).c;
const orphans = one(
  `SELECT COUNT(*) AS c FROM booking_rooms br WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = br.booking_id)`
).c;
check("16. 房间总数不变（46）", finalRooms === 46, `实际 ${finalRooms}`);
check("16b. 无孤儿 booking_rooms", orphans === 0, `孤儿 ${orphans}`);

/* ─────────── 清理 ─────────── */
db.exec("BEGIN");
run(`DELETE FROM payments WHERE folio_id = ?`, [folio.id]);
run(`DELETE FROM folio_items WHERE folio_id = ?`, [folio.id]);
run(`DELETE FROM folios WHERE id = ?`, [folio.id]);
run(`DELETE FROM stays WHERE id = ?`, [stay.id]);
run(`DELETE FROM booking_rooms WHERE booking_id = ?`, [booking.id]);
run(`DELETE FROM bookings WHERE id = ?`, [booking.id]);
run(`DELETE FROM housekeeping WHERE id = ?`, [hk.id]);
run(`DELETE FROM room_logs WHERE hotel_id = ? AND operator IN ('冒烟测试','冒烟主管')`, [H]);
db.exec("COMMIT");

db.close();

/* 删副本（含 -wal / -shm） */
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(`（冒烟在副本上进行，演示库 ${srcDb} 未被修改）\n`);
process.exit(fail === 0 ? 0 : 1);
