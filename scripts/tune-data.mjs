// 把演示数据微调到与去呼呼截图一致的规模：在住30 / 预抵17 / 预离4 / 空净9 / 空脏6 / 联房4
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(path.join(process.cwd(), "data", "pms.db"));
db.exec("PRAGMA foreign_keys = ON;");
const hotelId = 1;
const now = new Date();
now.setHours(14, 0, 0, 0);
const iso = (d) => d.toISOString();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = ymd(now);
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
const pick = (arr, i) => arr[i % arr.length];
const NAMES = ["张雪","王瑞宇","金泽宇","朱吉玲","周静","徐宗令","吴梦兰","黄心娜","汤其全","王敏","杨延丽","李竹婷","刘露斯","孙强","吴静","周杰","郑凯","陈立","王芳","刘洋","赵敏","钱多多","杨茜","许丹","杨燕茨"];
const CHS = db.prepare(`SELECT id, name FROM channels WHERE hotel_id = ?`).all(hotelId);

function statusCount(s) { return db.prepare(`SELECT COUNT(*) c FROM rooms WHERE hotel_id = ? AND status = ?`).get(hotelId, s).c; }

// 1) 让空净 9、空脏 6、其余在住 30
let vd = db.prepare(`SELECT id, room_no, room_type_id FROM rooms WHERE hotel_id = ? AND status = 'VD' ORDER BY sort`).all(hotelId);
const toVacantClean = vd.slice(0, 3);
const toOccupied = vd.slice(3, 8);
for (const r of toVacantClean) db.prepare(`UPDATE rooms SET status = 'VC' WHERE id = ?`).run(r.id);

let staySeq = 6000, folioSeq = 8000, paySeq = 9000;
const types = db.prepare(`SELECT id, base_price FROM room_types WHERE hotel_id = ?`).all(hotelId);
toOccupied.forEach((r, i) => {
  const t = types.find((x) => x.id === r.room_type_id) ?? types[0];
  const rate = t.base_price;
  const name = pick(NAMES, i + 3);
  const ch = pick(CHS, i);
  const stayId = ins(
    `INSERT INTO stays (hotel_id,stay_no,room_id,guest_id,guest_name,mobile,check_in_time,expect_check_out,nights,rate,deposit,guest_count,status,channel_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "SI" + (staySeq++), r.id, null, name, `138${String(70000000 + i * 37).slice(0, 8)}`,
    iso(addDays(now, -1)), ymd(addDays(now, 2)), 2, rate, 500, 1, "INHOUSE", ch.id, 2, iso(addDays(now, -1))
  );
  db.prepare(`UPDATE rooms SET status = ? WHERE id = ?`).run(i % 2 === 0 ? "OD" : "OC", r.id);
  const folioId = ins(
    `INSERT INTO folios (hotel_id,folio_no,stay_id,guest_name,room_no,total_amount,paid_amount,balance,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "F" + (folioSeq++), stayId, name, r.room_no, rate, 500, rate - 500, "OPEN", iso(addDays(now, -1))
  );
  ins(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, folioId, "ROOM", `夜审房费 ${ymd(addDays(now, -1))}`, 1, rate, rate, ymd(addDays(now, -1)), iso(now), 2);
  ins(`INSERT INTO payments (hotel_id,folio_id,stay_id,pay_no,method,amount,biz_date,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    hotelId, folioId, stayId, "P" + (paySeq++), "微信", 500, today, "入住押金", iso(now));
});

// 2) 今日预抵 36 → 17（删掉多余的今日预抵）
const arrivals = db.prepare(`SELECT id FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED') ORDER BY id`).all(hotelId, today);
if (arrivals.length > 17) {
  const drop = arrivals.slice(17).map((r) => r.id);
  db.prepare(`DELETE FROM bookings WHERE id IN (${drop.join(",")})`).run();
}

// 3) 今日预离 15 → 4（把多余的挪到明天）
const dep = db.prepare(`SELECT id FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out = ? ORDER BY id`).all(hotelId, today);
if (dep.length > 4) {
  for (const s of dep.slice(4)) {
    db.prepare(`UPDATE stays SET expect_check_out = ?, nights = nights + 1 WHERE id = ?`).run(ymd(addDays(now, 1)), s.id);
  }
}

// 4) 联房 4 组：找同房型的在住房间配对，写入 room_links
db.exec(`CREATE TABLE IF NOT EXISTS room_links (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, link_no TEXT, stay_id INTEGER, created_at TEXT)`);
db.prepare(`DELETE FROM room_links WHERE hotel_id = ?`).run(hotelId);
const inhouse = db.prepare(`SELECT s.id, r.room_type_id, r.room_no FROM stays s JOIN rooms r ON r.id = s.room_id WHERE s.hotel_id = ? AND s.status = 'INHOUSE' ORDER BY r.sort`).all(hotelId);
const byType = new Map();
for (const s of inhouse) {
  if (!byType.has(s.room_type_id)) byType.set(s.room_type_id, []);
  byType.get(s.room_type_id).push(s);
}
let linkSeq = 1;
for (const [, list] of byType) {
  if (list.length >= 2 && linkSeq <= 4) {
    const linkNo = "L" + String(1000 + linkSeq);
    ins(`INSERT INTO room_links (hotel_id, link_no, stay_id, created_at) VALUES (?,?,?,?)`, hotelId, linkNo, list[0].id, iso(now));
    ins(`INSERT INTO room_links (hotel_id, link_no, stay_id, created_at) VALUES (?,?,?,?)`, hotelId, linkNo, list[1].id, iso(now));
    linkSeq++;
  }
}

const q = (sql, ...p) => db.prepare(sql).get(...p).c;
console.log({
  全部: q(`SELECT COUNT(*) c FROM rooms WHERE hotel_id = ?`, hotelId),
  空净: statusCount("VC"),
  空脏: statusCount("VD"),
  住净: statusCount("OC"),
  住脏: statusCount("OD"),
  在住: q(`SELECT COUNT(*) c FROM stays WHERE status='INHOUSE' AND hotel_id = ?`, hotelId),
  今日预抵: q(`SELECT COUNT(*) c FROM bookings WHERE check_in_date=? AND status IN ('PENDING','CONFIRMED')`, today),
  今日预离: q(`SELECT COUNT(*) c FROM stays WHERE status='INHOUSE' AND expect_check_out=?`, today),
  联房组: q(`SELECT COUNT(DISTINCT link_no) c FROM room_links WHERE hotel_id=?`, hotelId),
});
db.close();
