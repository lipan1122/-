// 补充演示数据：历史订单、账单、操作日志、哑房、渠道订单等（幂等，只在数据不足时插入）
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(path.join(process.cwd(), "data", "pms.db"));
db.exec("PRAGMA foreign_keys = ON;");

const hotelId = 1;
const now = new Date();
const iso = (d) => d.toISOString();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);

db.exec(`CREATE TABLE IF NOT EXISTS dummy_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL, code TEXT, category TEXT DEFAULT '其他',
  status INTEGER DEFAULT 1, note TEXT, created_at TEXT
)`);

// 1. 更多客人
if (count("guests") < 20) {
  const names = ["钱多多","孙丽","李强","王雪","张涛","刘洋二","陈曦","杨帆二","周雨","吴迪","郑爽","冯磊","褚琳","卫东","蒋雯","沈浪","韩梅","杨过","秦岚","许飞"];
  const gu = db.prepare(`INSERT INTO guests (hotel_id,name,gender,id_type,id_no,mobile,company,vip_level,blacklist,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 12; i++) {
    const g = i % 2 ? "女" : "男";
    const name = names[i % names.length];
    const vip = i % 3 === 0 ? 1 : i % 5 === 0 ? 2 : 0;
    gu.run(hotelId, name + (i > 9 ? i : ""), g, "身份证", "3301061990010" + String(10000 + i), "1380000" + String(1000 + i), "", vip, 0, "", iso(addDays(now, -i * 3)));
  }
}

// 2. 历史预订（已入住/已取消/未到）
if (count("bookings") < 25) {
  const rooms = db.prepare(`SELECT id, room_type_id FROM rooms WHERE hotel_id=? ORDER BY sort`).all(hotelId);
  const types = db.prepare(`SELECT id, base_price FROM room_types WHERE hotel_id=?`).all(hotelId);
  const chans = db.prepare(`SELECT id FROM channels WHERE hotel_id=?`).all(hotelId);
  const statuses = ["CHECKED_IN", "CANCELLED", "NOSHOW", "CONFIRMED"];
  const bi = db.prepare(`INSERT INTO bookings (hotel_id,booking_no,guest_name,mobile,room_type_id,room_id,channel_id,check_in_date,check_out_date,nights,room_count,guest_count,rate,deposit,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 20; i++) {
    const t = types[i % types.length];
    const c = chans[i % chans.length];
    const inD = addDays(now, -20 + i);
    const nights = 1 + (i % 3);
    const st = statuses[i % statuses.length];
    bi.run(hotelId, "BK" + (4000 + i), "客人" + i, "1390000" + String(1000 + i), t.id, null, c.id,
      ymd(inD), ymd(addDays(inD, nights)), nights, 1, 1 + (i % 2), t.base_price, 0, st, 2, iso(inD), iso(inD));
  }
}

// 3. 历史已退房记录 + 账单
if (count("stays") < 20) {
  const rooms = db.prepare(`SELECT r.id, r.room_no, r.room_type_id, rt.base_price FROM rooms r JOIN room_types rt ON rt.id=r.room_type_id WHERE r.hotel_id=? ORDER BY r.sort`).all(hotelId);
  const chans = db.prepare(`SELECT id FROM channels WHERE hotel_id=?`).all(hotelId);
  const si = db.prepare(`INSERT INTO stays (hotel_id,stay_no,booking_id,room_id,guest_id,guest_name,mobile,check_in_time,expect_check_out,actual_check_out,nights,rate,deposit,guest_count,status,channel_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fi = db.prepare(`INSERT INTO folios (hotel_id,folio_no,stay_id,guest_name,room_no,total_amount,paid_amount,balance,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const fii = db.prepare(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const pi = db.prepare(`INSERT INTO payments (hotel_id,folio_id,stay_id,pay_no,method,amount,biz_date,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const names = ["历史客人A","历史客人B","历史客人C","历史客人D","历史客人E","历史客人F","历史客人G","历史客人H"];
  for (let i = 0; i < 14; i++) {
    const r = rooms[(i * 2) % rooms.length];
    const inD = addDays(now, -30 + i * 2);
    const nights = 1 + (i % 3);
    const outD = addDays(inD, nights);
    const rate = r.base_price;
    const total = rate * nights;
    const name = names[i % names.length];
    const stayId = ins(`INSERT INTO stays (hotel_id,stay_no,booking_id,room_id,guest_id,guest_name,mobile,check_in_time,expect_check_out,actual_check_out,nights,rate,deposit,guest_count,status,channel_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      hotelId, "SI" + (2000 + i), null, r.id, null, name, "1370000" + String(1000 + i), iso(inD), ymd(outD), ymd(outD), nights, rate, 0, 1, "CHECKED_OUT", chans[i % chans.length].id, 2, iso(inD));
    const folioId = ins(`INSERT INTO folios (hotel_id,folio_no,stay_id,guest_name,room_no,total_amount,paid_amount,balance,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      hotelId, "F" + (4000 + i), stayId, name, r.room_no, total, total, 0, "SETTLED", iso(inD), iso(outD));
    for (let n = 0; n < nights; n++) {
      fii.run(hotelId, folioId, "ROOM", "房费 " + ymd(addDays(inD, n)), 1, rate, rate, ymd(addDays(inD, n)), iso(inD), 2);
    }
    pi.run(hotelId, folioId, stayId, "P" + (4000 + i), ["微信","支付宝","现金","银行卡"][i % 4], total, ymd(outD), "退房结账", iso(outD));
  }
}

// 4. 操作日志 + 房态日志
if (count("op_logs") < 10) {
  const actions = [
    ["登录系统", "admin 登录前台终端"],
    ["办理入住", "301 陈立 入住 2 晚"],
    ["换房", "405 赵敏 换至 406"],
    ["延住", "304 刘洋 延住 1 晚"],
    ["结账退房", "602 客人退房，收款 ¥536.00"],
    ["夜审", "执行 2026-11-14 夜审，售出 6 间"],
    ["房态修改", "306 置脏"],
    ["加收消费", "304 中餐厅晚餐 ¥168.00"],
    ["新增预订", "BK3006 刘敏 豪华套房"],
    ["取消预订", "BK3005 未到取消"],
    ["收款", "501 吴静 押金 ¥1500.00"],
    ["打印账单", "301 账单打印"],
  ];
  const p = db.prepare(`INSERT INTO op_logs (hotel_id,operator,action,detail,created_at) VALUES (?,?,?,?,?)`);
  actions.forEach(([a, d], i) => p.run(hotelId, ["张经理","李前台","王收银"][i % 3], a, d, iso(addDays(now, -i))));
}

if (count("room_logs") < 8) {
  const rooms = db.prepare(`SELECT id, room_no FROM rooms WHERE hotel_id=? LIMIT 8`).all(hotelId);
  const p = db.prepare(`INSERT INTO room_logs (hotel_id,room_id,from_status,to_status,reason,operator,created_at) VALUES (?,?,?,?,?,?,?)`);
  const pairs = [["VC","VD","客人退房"],["VD","VC","打扫完成"],["VC","OOO","空调维修"],["OOO","VC","维修完成"],["VC","LOCK","内部预留"],["LOCK","VC","解除锁房"],["OC","OD","置脏"],["OD","OC","打扫完成"]];
  rooms.forEach((r, i) => {
    const [f, t, reason] = pairs[i % pairs.length];
    p.run(hotelId, r.id, f, t, reason, "赵阿姨", iso(addDays(now, -i)));
  });
}

// 5. 哑房
if (count("dummy_rooms") === 0) {
  const p = db.prepare(`INSERT INTO dummy_rooms (hotel_id,name,code,category,status,note,created_at) VALUES (?,?,?,?,?,?,?)`);
  const list = [["一楼中餐厅","D001","餐饮"],["二楼咖啡厅","D002","餐饮"],["三楼会议室A","D003","会议"],["三楼会议室B","D004","会议"],["健身房","D005","其他"],["洗衣服务","D006","其他"],["迷你吧","D007","餐饮"],["接送机服务","D008","其他"]];
  list.forEach(([n, c, cat]) => p.run(hotelId, n, c, cat, 1, "", iso(now)));
}

// 6. 渠道历史订单
if (count("channel_orders") < 20) {
  const types = db.prepare(`SELECT id, code, base_price FROM room_types WHERE hotel_id=?`).all(hotelId);
  const p = db.prepare(`INSERT INTO channel_orders (hotel_id,channel_type,channel_order_no,room_type_id,guest_name,mobile,check_in_date,check_out_date,nights,room_count,amount,status,raw,created_at,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const chs = ["ctrip","meituan","douyin"];
  const names = ["渠道客甲","渠道客乙","渠道客丙","渠道客丁","渠道客戊","渠道客己","渠道客庚","渠道客辛","渠道客壬","渠道客癸"];
  const statuses = ["IMPORTED","IMPORTED","CANCELLED","NEW"];
  for (let i = 0; i < 18; i++) {
    const t = types[i % types.length];
    const inD = addDays(now, -15 + i);
    const nights = 1 + (i % 2);
    const amount = t.base_price * nights;
    p.run(hotelId, chs[i % 3], "H" + (70000 + i), t.id, names[i % names.length], "1360000" + String(2000 + i),
      ymd(inD), ymd(addDays(inD, nights)), nights, 1, amount, statuses[i % 4], "{}", iso(inD), statuses[i % 4] === "IMPORTED" ? iso(inD) : null);
  }
}

console.log("补充完成:");
for (const t of ["guests","bookings","stays","folios","folio_items","payments","op_logs","room_logs","dummy_rooms","channel_orders"]) {
  console.log(" ", t.padEnd(16), count(t));
}
db.close();
