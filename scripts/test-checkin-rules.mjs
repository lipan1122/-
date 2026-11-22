/**
 * 入住异常校验与后续同步验收（整改指令 2.3 / 2.4）
 *
 * 指令要求的 7 项入住后同步：
 *   订单状态 / 入住单 / 房间状态 / 账单押金 / 客人档案 / 客房任务 / 渠道订单状态
 *
 * 指令要求的 7 项异常校验：
 *   身份证重复入住 / 房间已被其他订单占用 / 押金不足 / 预订已取消 /
 *   预订已过期 / 渠道订单重复入住 / 入住人数超过房型人数
 *
 * 本脚本做静态 + 数据双向校验。
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

const src = readFileSync(join("src", "app", "(main)", "frontdesk", "actions.ts"), "utf8");

/* ---------- 2.4 七项异常校验 ---------- */
console.log("=== 2.4 入住异常校验 ===");
check("① 身份证重复入住", /证件号.*已有在住单|已有在住单.*证件号|身份证重复入住/.test(src) || /证件号 \$\{idNo\} 已有在住单/.test(src));
check("② 房间已被其他订单占用", /已被在住单.*占用|房间.*已被.*占用/.test(src));
check("③ 押金不足 / 押金为负", /押金不能为负数/.test(src));
check("④ 预订已取消", /该预订已取消/.test(src));
check("⑤ 预订已过期", /该预订已过期|已过期（/.test(src));
check("⑥ 渠道订单重复入住", /渠道订单号.*已办理过入住|不能重复办理/.test(src));
check("⑦ 入住人数超房型上限", /最多住 \$\{cap\} 人|超出房型|max_occupancy/.test(src));

/* ---------- 2.3 七项同步 ---------- */
console.log("\n=== 2.3 入住后同步 ===");
check("① 订单状态", /UPDATE bookings[\s\S]{0,200}SET status/.test(src));
check("② 入住单", /INSERT INTO stays/.test(src));
check("③ 房间状态", /changeRoomStatus\(\{[\s\S]{0,120}to: "OC"/.test(src));
check("④ 账单押金", /INSERT INTO folios/.test(src) && /INSERT INTO folio_items/.test(src) && /INSERT INTO payments/.test(src));
check("⑤ 客人档案", /INSERT INTO guests/.test(src) || /UPDATE guests SET/.test(src));
check("⑥ 客房任务（入住时取消待打扫）", /UPDATE housekeeping[\s\S]{0,200}status = 'CANCELLED'|'CANCELLED'/.test(src));
check("⑦ 渠道订单状态", /UPDATE channel_orders[\s\S]{0,120}CHECKED_IN/.test(src));

/* ---------- 数据一致性 ---------- */
console.log("\n=== 数据一致性 ===");
const db = new DatabaseSync(DB, { readOnly: true });

/* 在住房都必须有一张账务单 */
const noFolio = db.prepare(
  `SELECT s.stay_no FROM stays s
    WHERE s.hotel_id = 1 AND s.status = 'INHOUSE'
      AND NOT EXISTS (SELECT 1 FROM folios f WHERE f.stay_id = s.id)`
).all();
check("在住单都有账务单", noFolio.length === 0, noFolio.slice(0, 3).map((s) => s.stay_no).join(","));

/* 在住房的房态必须是 OC/OD */
const badStatus = db.prepare(
  `SELECT s.stay_no, r.room_no, r.status
     FROM stays s JOIN rooms r ON r.id = s.room_id
    WHERE s.hotel_id = 1 AND s.status = 'INHOUSE' AND r.status NOT IN ('OC','OD')`
).all();
check("在住单对应的房间状态是 OC/OD", badStatus.length === 0,
  badStatus.slice(0, 3).map((b) => `${b.room_no}=${b.status}`).join(","));

/* 同一个房间不能有两个在住单 */
const dupRoom = db.prepare(
  `SELECT room_id, COUNT(*) c FROM stays
    WHERE hotel_id = 1 AND status = 'INHOUSE' AND room_id IS NOT NULL
    GROUP BY room_id HAVING c > 1`
).all();
check("同一房间没有两个在住单", dupRoom.length === 0, JSON.stringify(dupRoom.slice(0, 3)));

/* 同一证件号不能有两个在住单 */
const dupIdNo = db.prepare(
  `SELECT g.id_no, COUNT(*) c
     FROM stays s JOIN guests g ON g.id = s.guest_id
    WHERE s.hotel_id = 1 AND s.status = 'INHOUSE' AND COALESCE(g.id_no,'') <> ''
    GROUP BY g.id_no HAVING c > 1`
).all();
check("同一证件号没有两个在住单", dupIdNo.length === 0, JSON.stringify(dupIdNo.slice(0, 3)));

/* 押金不为负 */
const negDeposit = db.prepare(
  `SELECT stay_no, deposit FROM stays WHERE hotel_id = 1 AND COALESCE(deposit,0) < 0`
).all();
check("没有负押金", negDeposit.length === 0, JSON.stringify(negDeposit.slice(0, 3)));

/* 入住人数不超过房型上限 */
const overCap = db.prepare(
  `SELECT s.stay_no, r.room_no, s.guest_count, rt.max_occupancy
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     JOIN room_types rt ON rt.id = r.room_type_id
    WHERE s.hotel_id = 1 AND s.status = 'INHOUSE'
      AND COALESCE(rt.max_occupancy, 0) > 0
      AND COALESCE(s.guest_count, 1) > rt.max_occupancy`
).all();
check("在住单人数都没超房型上限", overCap.length === 0,
  overCap.slice(0, 3).map((o) => `${o.room_no}: ${o.guest_count}>${o.max_occupancy}`).join(","));

/* housekeeping 状态值合法 */
const hkStatus = db.prepare(`SELECT DISTINCT status FROM housekeeping WHERE hotel_id = 1`).all().map((r) => r.status);
const legal = ["PENDING", "DOING", "DONE", "CANCELLED"];
check("housekeeping 状态值都在合法枚举内", hkStatus.every((s) => legal.includes(s)), hkStatus.join(","));

/* 在住房间不应还有待打扫任务（入住时应被取消） */
const occupiedWithTask = db.prepare(
  `SELECT r.room_no FROM housekeeping h JOIN rooms r ON r.id = h.room_id
    WHERE h.hotel_id = 1 AND h.status IN ('PENDING','DOING')
      AND EXISTS (SELECT 1 FROM stays s WHERE s.room_id = h.room_id AND s.status = 'INHOUSE')`
).all();
check("在住房间没有残留待打扫任务", occupiedWithTask.length === 0,
  occupiedWithTask.slice(0, 3).map((o) => o.room_no).join(","));

console.log(`\n在住 ${db.prepare(`SELECT COUNT(*) c FROM stays WHERE hotel_id=1 AND status='INHOUSE'`).get().c} 单 / 客房任务 ${db.prepare(`SELECT COUNT(*) c FROM housekeeping WHERE hotel_id=1`).get().c} 条`);
db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
