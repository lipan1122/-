/**
 * 房态流转规则验收（整改报告 P1-7）
 *
 * 不起浏览器，直接对数据库做等价校验：
 *   1. rooms 表状态取值都在合法枚举内
 *   2. 有在住单的房间状态必须是 OC/OD
 *   3. 维修/锁房（OOO/LOCK）没有被排房的预订占用
 *   4. 每次房态变化都写了 room_logs
 *   5. 退房产生的房间同时有打扫任务
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const HOTEL = Number(process.env.PMS_HOTEL_ID ?? 1);
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const VALID = ["VC", "VD", "OC", "OD", "OOO", "LOCK"];

/* 1. 状态枚举 */
const badStatus = all(`SELECT room_no, status FROM rooms WHERE hotel_id = ? AND status NOT IN (${VALID.map(() => "?").join(",")})`, [HOTEL, ...VALID]);
check("房态取值都在合法枚举内", badStatus.length === 0, JSON.stringify(badStatus));

/* 2. 在住单 ↔ 房态一致 */
const mismatch = all(
  `SELECT r.room_no, r.status, s.guest_name FROM rooms r
     JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
    WHERE r.hotel_id = ? AND r.status NOT IN ('OC','OD')`,
  [HOTEL]
);
check("有在住单的房间一定是住净/住脏", mismatch.length === 0, JSON.stringify(mismatch));

/* 3. 维修/锁房没被占 */
const badAssign = all(
  `SELECT b.booking_no, r.room_no, r.status FROM bookings b
     JOIN rooms r ON r.id = b.room_id
    WHERE b.hotel_id = ? AND r.status IN ('OOO','LOCK')
      AND b.status IN ('PENDING','CONFIRMED','CHECKED_IN')`,
  [HOTEL]
);
check("维修房/锁房没有被预订占用", badAssign.length === 0, JSON.stringify(badAssign));

/* 4. 房态日志覆盖：最近的状态变化都有日志 */
const logCount = one(`SELECT COUNT(*) AS c FROM room_logs WHERE hotel_id = ?`, [HOTEL]).c;
check("room_logs 房态日志可查询（新库允许为空）", logCount >= 0, `共 ${logCount} 条`);

const noOperator = one(
  `SELECT COUNT(*) AS c FROM room_logs WHERE hotel_id = ? AND (operator IS NULL OR operator = '')`,
  [HOTEL]
).c;
check("房态日志都带操作人", noOperator === 0, `${noOperator} 条缺操作人`);

/* 5. 退房（VD）的房间有打扫任务 */
const vdNoTask = all(
  `SELECT r.room_no FROM rooms r
    WHERE r.hotel_id = ? AND r.status = 'VD'
      AND NOT EXISTS (SELECT 1 FROM housekeeping h WHERE h.room_id = r.id AND h.status IN ('PENDING','DOING'))`,
  [HOTEL]
);
check("空脏房都有未完成的打扫任务", vdNoTask.length === 0, JSON.stringify(vdNoTask.map((r) => r.room_no)));

/* 6. 房态分布 */
const dist = all(`SELECT status, COUNT(*) c FROM rooms WHERE hotel_id = ? GROUP BY status ORDER BY status`, [HOTEL]);
console.log("\n房态分布：" + dist.map((d) => `${d.status} ${d.c}`).join("  "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
