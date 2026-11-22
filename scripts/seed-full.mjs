// 按去呼呼真实规模重建演示数据（覆盖 init-db 的种子业务数据）
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(path.join(process.cwd(), "data", "pms.db"));
db.exec("PRAGMA foreign_keys = ON;");

const hotelId = 1;
const now = new Date();
now.setHours(13, 30, 0, 0);
const iso = (d) => d.toISOString();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = ymd(now);
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
const pick = (arr, i) => arr[i % arr.length];

// 清空业务表
for (const t of ["bookings","stays","folios","folio_items","payments","room_logs","housekeeping","night_audits","op_logs","channel_orders","channel_sync_logs","rooms","room_types","guests","channels","notices","lost_items","quotes","dummy_rooms","sessions"]) {
  try { db.exec(`DELETE FROM ${t}`); } catch {}
}
try { db.exec("DELETE FROM sqlite_sequence"); } catch {}

// ---------- 房型（与去呼呼一致的 7 个） ----------
const ROOM_TYPES = [
  ["YX", "悦享阔景特大床房", "特大床", 32, 2, 328, 20],
  ["YQ", "云栖安睡大床房", "大床", 28, 2, 268, 12],
  ["JY", "友聚欢享三床房", "三床", 38, 3, 468, 1],
  ["XY", "星幕影院大床房", "大床", 30, 2, 388, 1],
  ["ZX", "智享安睡大床房", "大床", 26, 2, 258, 2],
  ["YS", "逸享舒适双床房", "双床", 30, 2, 288, 5],
  ["HJ", "阖家欢居套房", "套房", 48, 3, 588, 4],
];
const typeIds = {};
ROOM_TYPES.forEach(([code, name, bed, area, occ, price], i) => {
  typeIds[code] = ins(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, area, max_occupancy, base_price, sort) VALUES (?,?,?,?,?,?,?,?)`,
    hotelId, code, name, bed, area, occ, price, i
  );
});

// ---------- 45 间房 ----------
const ROOMS = [];
const FLOOR_PLAN = [
  { floor: 2, prefix: "82", types: [["YX", 10]] },
  { floor: 3, prefix: "83", types: [["YX", 10]] },
  { floor: 4, prefix: "84", types: [["YQ", 10]] },
  { floor: 5, prefix: "85", types: [["YQ", 2], ["JY", 1], ["XY", 1], ["ZX", 2], ["YS", 3]] },
  { floor: 6, prefix: "86", types: [["YS", 2], ["HJ", 4]] },
];
let sort = 0;
for (const f of FLOOR_PLAN) {
  let seq = 1;
  for (const [code, cnt] of f.types) {
    for (let i = 0; i < cnt; i++) {
      const roomNo = `${f.prefix}${String(seq).padStart(2, "0")}`;
      seq++;
      ROOMS.push({ id: ins(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, hotelId, roomNo, f.floor, typeIds[code], "VC", ++sort), no: roomNo, code, floor: f.floor, price: ROOM_TYPES.find((t) => t[0] === code)[5] });
    }
  }
}

// ---------- 渠道 ----------
const CHANNELS = [
  ["携程", "ctrip", 0.1, "CTRIP-HZ-0088"],
  ["美团", "meituan", 0.12, "MT-HZ-7712"],
  ["去哪儿", "qunar", 0.08, "QNR-HZ-3301"],
  ["艺龙", "elong", 0.1, "ELONG-HZ-2201"],
  ["抖音", "douyin", 0.15, "DY-HZ-5620"],
  ["散客", "direct", 0, null],
  ["协议单位", "direct", 0, null],
  ["会员直订", "direct", 0, null],
  ["线下客人", "direct", 0, null],
];
const channelIds = {};
CHANNELS.forEach(([name, type, commission, store]) => {
  channelIds[name] = ins(
    `INSERT INTO channels (hotel_id, name, commission, channel_type, store_id, app_key, app_secret, enabled) VALUES (?,?,?,?,?,?,?,?)`,
    hotelId, name, commission, type, store, type === "direct" ? null : `${type.toUpperCase()}_AK_${Math.random().toString(36).slice(2, 8)}`, type === "direct" ? null : "••••••••", type === "direct" ? 0 : 1
  );
});

// ---------- 客源渠道（用于在住渠道统计：携程 21 / 美团 5 等） ----------
const GUEST_NAMES = ["杨燕茨","邹敏","梁廷廷","周静","徐宗令","倪必顺","张雪","陈立","王芳","刘洋","赵敏","孙强","周杰","吴静","郑凯","钱多多","孙丽","李强","王雪","张涛","陈曦","杨帆","周雨","吴迪","郑爽","冯磊","褚琳","卫东","蒋雯","沈浪","韩梅","秦岚","许飞","马骏","何静","林涛","苏晴","小鹿","阿凯","张三","李四","王五"];

// 客人档案
for (let i = 0; i < 40; i++) {
  const name = GUEST_NAMES[i];
  ins(`INSERT INTO guests (hotel_id,name,gender,id_type,id_no,mobile,company,vip_level,blacklist,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, name, i % 2 ? "女" : "男", "身份证",
    `3301061990${String(1000 + i).slice(0, 4)}${String(100000 + i)}`,
    `138${String(10000000 + i * 137).slice(0, 8)}`,
    i % 7 === 0 ? "杭州云启科技有限公司" : i % 11 === 0 ? "西湖旅行社" : "",
    i % 5 === 0 ? 1 : i % 9 === 0 ? 2 : 0, 0, "", iso(addDays(now, -60 + i)));
}

// ---------- 23 间在住 ----------
const INHOUSE = [
  { no: "8202", ch: "携程", guest: "杨燕茨", offset: -2, nights: 2, dirty: false, hour: false, team: null },
  { no: "8203", ch: "美团", guest: "张雪", offset: -1, nights: 2, dirty: true, hour: false, team: null },
  { no: "8205", ch: "携程", guest: "朱吉玲", offset: -1, nights: 1, dirty: true, hour: false, team: null },
  { no: "8206", ch: "携程", guest: "王瑞宇", offset: -1, nights: 2, dirty: true, hour: false, team: null },
  { no: "8207", ch: "携程", guest: "邹敏", offset: -2, nights: 1, dirty: false, hour: false, team: null },
  { no: "8209", ch: "美团", guest: "金泽宇", offset: -1, nights: 1, dirty: true, hour: false, team: null },
  { no: "8302", ch: "携程", guest: "张三丰", offset: -2, nights: 1, dirty: true, hour: false, team: null },
  { no: "8306", ch: "携程", guest: "杨燕茨", offset: -2, nights: 2, dirty: true, hour: false, team: null },
  { no: "8307", ch: "携程", guest: "倪必顺", offset: -1, nights: 2, dirty: false, hour: false, team: null },
  { no: "8309", ch: "美团", guest: "金泽宇", offset: -1, nights: 1, dirty: true, hour: false, team: null },
  { no: "8310", ch: "携程", guest: "周静", offset: -2, nights: 1, dirty: true, hour: true, team: null },
  { no: "8311", ch: "美团", guest: "张雪", offset: -1, nights: 1, dirty: true, hour: false, team: null },
  { no: "8402", ch: "携程", guest: "杨茜", offset: -2, nights: 2, dirty: false, hour: false, team: null },
  { no: "8405", ch: "携程", guest: "许丹", offset: 0, nights: 1, dirty: false, hour: false, team: null },
  { no: "8408", ch: "携程", guest: "徐宗令", offset: -1, nights: 1, dirty: true, hour: false, team: null },
  { no: "8409", ch: "协议单位", guest: "刘洋", offset: -3, nights: 3, dirty: true, hour: false, team: "春秋旅行社" },
  { no: "8410", ch: "协议单位", guest: "王芳", offset: -2, nights: 2, dirty: true, hour: false, team: "春秋旅行社" },
  { no: "8411", ch: "协议单位", guest: "赵敏", offset: -1, nights: 2, dirty: false, hour: false, team: "春秋旅行社" },
  { no: "8502", ch: "会员直订", guest: "吴静", offset: -2, nights: 3, dirty: true, hour: false, team: null },
  { no: "8505", ch: "散客", guest: "孙强", offset: -1, nights: 2, dirty: true, hour: false, team: null },
  { no: "8601", ch: "去哪儿", guest: "周杰", offset: -2, nights: 2, dirty: false, hour: false, team: null },
  { no: "8606", ch: "携程", guest: "郑凯", offset: -1, nights: 2, dirty: true, hour: false, team: null },
  { no: "8607", ch: "携程", guest: "钱多多", offset: -1, nights: 1, dirty: false, hour: false, team: null },
];

let staySeq = 1100, folioSeq = 2100, paySeq = 3100;
const roomByNo = new Map(ROOMS.map((r) => [r.no, r]));
const todayCheckout = [];

INHOUSE.forEach((s, i) => {
  const room = roomByNo.get(s.no);
  if (!room) return;
  const checkIn = addDays(now, s.offset);
  const expectOut = addDays(checkIn, s.nights);
  const rate = room.price;
  const stayId = ins(
    `INSERT INTO stays (hotel_id,stay_no,booking_id,room_id,guest_id,guest_name,mobile,check_in_time,expect_check_out,actual_check_out,nights,rate,deposit,guest_count,status,channel_id,remark,team_name,rate_code,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "SI" + (staySeq++), null, room.id, null, s.guest,
    `138${String(10000000 + i * 91).slice(0, 8)}`,
    iso(checkIn), ymd(expectOut), null, s.hour ? 0 : s.nights, s.hour ? Math.round(rate * 0.5) : rate,
    s.hour ? 0 : 500 + (i % 4) * 100, 1, "INHOUSE", channelIds[s.ch],
    s.hour ? "钟点房 4 小时" : "", s.team, s.hour ? "钟点" : "门市价", 2, iso(checkIn)
  );
  db.prepare(`UPDATE rooms SET status = ? WHERE id = ?`).run(s.dirty ? "OD" : "OC", room.id);

  const folioId = ins(
    `INSERT INTO folios (hotel_id,folio_no,stay_id,guest_name,room_no,total_amount,paid_amount,balance,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "F" + (folioSeq++), stayId, s.guest, s.no, 0, 0, 0, "OPEN", iso(checkIn)
  );

  const deposit = s.hour ? 0 : 500 + (i % 4) * 100;
  let total = 0;
  if (deposit > 0) {
    ins(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      hotelId, folioId, "DEPOSIT", "入住押金", 1, deposit, deposit, today, iso(checkIn), 2);
    ins(`INSERT INTO payments (hotel_id,folio_id,stay_id,pay_no,method,amount,biz_date,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      hotelId, folioId, stayId, "P" + (paySeq++), pick(["微信","支付宝","现金","银行卡"], i), deposit, today, "入住押金", iso(checkIn));
  }
  const consumed = s.hour ? 1 : Math.max(1, Math.min(s.nights, s.offset === 0 ? 1 : Math.abs(s.offset) + 1));
  for (let n = 0; n < consumed; n++) {
    const biz = ymd(addDays(checkIn, n));
    ins(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      hotelId, folioId, "ROOM", `夜审房费 ${biz}`, 1, rate, rate, biz, iso(addDays(checkIn, n)), 2);
  }
  if (i % 6 === 2) {
    ins(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      hotelId, folioId, "FOOD", "中餐厅晚餐", 1, 168, 168, today, iso(now), 2);
  }
  const sum = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM folio_items WHERE folio_id = ?`).get(folioId).t;
  db.prepare(`UPDATE folios SET total_amount=?, paid_amount=?, balance=? WHERE id=?`).run(sum, deposit, sum - deposit, folioId);

  if (ymd(expectOut) === today) todayCheckout.push({ stayId, room, guest: s.guest });
});

// ---------- 空房：6 空净 + 16 空脏 ----------
const occupied = new Set(INHOUSE.map((s) => s.no));
const vacant = ROOMS.filter((r) => !occupied.has(r.no));
vacant.forEach((r, i) => {
  db.prepare(`UPDATE rooms SET status = ? WHERE id = ?`).run(i < 6 ? "VC" : "VD", r.id);
});

// ---------- 今日预离（15 间，取自今日应离 + 补充） ----------
let extraCheckout = 0;
for (const v of vacant.slice(0, 15 - todayCheckout.length)) {
  const s = { no: v.no, ch: "携程", guest: pick(GUEST_NAMES, extraCheckout + 7) };
  const rate = v.price;
  const stayId = ins(
    `INSERT INTO stays (hotel_id,stay_no,room_id,guest_id,guest_name,mobile,check_in_time,expect_check_out,nights,rate,deposit,guest_count,status,channel_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "SI" + (staySeq++), v.id, null, s.guest, "13800001111", iso(addDays(now, -1)), today, 1, rate, 500, 1, "INHOUSE", channelIds["携程"], 2, iso(addDays(now, -1))
  );
  db.prepare(`UPDATE rooms SET status='OC' WHERE id=?`).run(v.id);
  const folioId = ins(`INSERT INTO folios (hotel_id,folio_no,stay_id,guest_name,room_no,total_amount,paid_amount,balance,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "F" + (folioSeq++), stayId, s.guest, v.no, rate, 500, rate - 500, "OPEN", iso(addDays(now, -1)));
  ins(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, folioId, "ROOM", `夜审房费 ${ymd(addDays(now, -1))}`, 1, rate, rate, ymd(addDays(now, -1)), iso(now), 2);
  extraCheckout++;
}

// ---------- 今日预抵 36 单 ----------
const preArrival = [];
for (let i = 0; i < 36; i++) {
  const rt = ROOM_TYPES[i % ROOM_TYPES.length];
  const name = pick(GUEST_NAMES, i + 3);
  const ch = pick(["携程","携程","携程","美团","去哪儿","抖音","散客","会员直订"], i);
  const nights = 1 + (i % 3);
  const room = i % 3 === 0 ? pick(ROOMS.filter((r) => r.code === rt[0]), i) : null;
  const bkId = ins(
    `INSERT INTO bookings (hotel_id,booking_no,guest_name,mobile,room_type_id,room_id,channel_id,check_in_date,check_out_date,nights,room_count,guest_count,rate,deposit,status,pay_type,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    hotelId, "BK" + (5000 + i), name, `139${String(20000000 + i * 37).slice(0, 8)}`, typeIds[rt[0]], room?.id ?? null,
    channelIds[ch], today, ymd(addDays(now, nights)), nights, 1, 1, rt[5], i % 4 === 0 ? 300 : 0,
    room ? "CONFIRMED" : "PENDING", "到店付款", 2, iso(now), iso(now)
  );
  preArrival.push({ id: bkId, room });
}

// ---------- 历史订单（总计 364） ----------
const histStatuses = ["CHECKED_IN","CHECKED_IN","CHECKED_IN","CANCELLED","NOSHOW","CONFIRMED"];
let bkSeq = 6000;
let staySeq2 = 5000;
let folioSeq2 = 7000;
let totalOrders = 36;
for (let day = 60; day >= 1 && totalOrders < 364; day--) {
  const perDay = 5 + (day % 3);
  for (let k = 0; k < perDay && totalOrders < 364; k++) {
    const rt = ROOM_TYPES[(day + k) % ROOM_TYPES.length];
    const name = pick(GUEST_NAMES, day * 3 + k);
    const ch = pick(["携程","携程","美团","去哪儿","抖音","散客","协议单位","会员直订"], day + k);
    const inD = addDays(now, -day);
    const nights = 1 + ((day + k) % 3);
    const outD = addDays(inD, nights);
    const status = pick(histStatuses, day + k);
    ins(`INSERT INTO bookings (hotel_id,booking_no,guest_name,mobile,room_type_id,room_id,channel_id,check_in_date,check_out_date,nights,room_count,guest_count,rate,deposit,status,pay_type,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      hotelId, "BK" + (bkSeq++), name, `137${String(30000000 + day * 100 + k).slice(0, 8)}`, typeIds[rt[0]], null,
      channelIds[ch], ymd(inD), ymd(outD), nights, 1, 1 + (k % 2), rt[5], 0, status, "到店付款", 2, iso(inD), iso(inD));
    totalOrders++;

    // 已入住的历史订单生成已退房记录 + 账单
    if (status === "CHECKED_IN") {
      const room = ROOMS[(day * 7 + k) % ROOMS.length];
      const stayId = ins(
        `INSERT INTO stays (hotel_id,stay_no,room_id,guest_id,guest_name,mobile,check_in_time,expect_check_out,actual_check_out,nights,rate,deposit,guest_count,status,channel_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        hotelId, "SI" + (staySeq2++), room.id, null, name, `137${String(30000000 + day * 100 + k).slice(0, 8)}`,
        iso(inD), ymd(outD), ymd(outD), nights, rt[5], 0, 1, "CHECKED_OUT", channelIds[ch], 2, iso(inD));
      const total = rt[5] * nights;
      const folioId = ins(`INSERT INTO folios (hotel_id,folio_no,stay_id,guest_name,room_no,total_amount,paid_amount,balance,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        hotelId, "F" + (folioSeq2++), stayId, name, room.no, total, total, 0, "SETTLED", iso(inD), iso(outD));
      for (let n = 0; n < nights; n++) {
        ins(`INSERT INTO folio_items (hotel_id,folio_id,item_type,description,qty,price,amount,biz_date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          hotelId, folioId, "ROOM", `夜审房费 ${ymd(addDays(inD, n))}`, 1, rt[5], rt[5], ymd(addDays(inD, n)), iso(inD), 2);
      }
      ins(`INSERT INTO payments (hotel_id,folio_id,stay_id,pay_no,method,amount,biz_date,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        hotelId, folioId, stayId, "P" + (paySeq++), pick(["微信","支付宝","现金","银行卡"], day + k), total, ymd(outD), "退房结账", iso(outD));
    }
  }
}

// ---------- 渠道订单 1200 条（约 60 页） ----------
const coStatuses = ["IMPORTED","IMPORTED","IMPORTED","CANCELLED","NEW"];
let coSeq = 0;
const coIns = db.prepare(`INSERT INTO channel_orders (hotel_id,channel_type,channel_order_no,room_type_id,guest_name,mobile,check_in_date,check_out_date,nights,room_count,amount,status,raw,created_at,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (let i = 0; i < 1200; i++) {
  const rt = ROOM_TYPES[i % ROOM_TYPES.length];
  const type = pick(["ctrip","ctrip","meituan","douyin","qunar"], i);
  const name = pick(GUEST_NAMES, i);
  const inD = addDays(now, -30 + (i % 60));
  const nights = 1 + (i % 3);
  const amount = rt[5] * nights;
  const st = pick(coStatuses, i);
  coIns.run(hotelId, type, `${type === "ctrip" ? "CT" : type === "meituan" ? "MT" : type === "douyin" ? "DY" : "QN"}${1128000000000 + i}`,
    typeIds[rt[0]], name, `139${String(50000000 + i).slice(0, 8)}`, ymd(inD), ymd(addDays(inD, nights)), nights, 1, amount, st,
    JSON.stringify({ source: type, amount }), iso(inD), st === "IMPORTED" ? iso(inD) : null);
}

// 渠道同步日志
const logActions = ["PULL_ORDER","PUSH_INVENTORY","PUSH_RATE","TEST"];
for (let i = 0; i < 30; i++) {
  ins(`INSERT INTO channel_sync_logs (hotel_id,channel_type,action,status,message,created_at) VALUES (?,?,?,?,?,?)`,
    hotelId, pick(["ctrip","meituan","douyin","qunar"], i), pick(logActions, i), "SUCCESS",
    pick(["拉取到 12 条新订单","推送未来 14 天房量成功","推送房型价格成功","接口握手成功"], i), iso(addDays(now, -i)));
}

// ---------- 操作 / 房态日志 ----------
const opActions = ["登录系统","办理入住","结账退房","续住","换房","调价","夜审","新增预订","取消预订","加收消费","收款","打印账单","置净","置脏"];
for (let i = 0; i < 60; i++) {
  ins(`INSERT INTO op_logs (hotel_id,operator,action,detail,created_at) VALUES (?,?,?,?,?)`,
    hotelId, pick(["张经理","李前台","王收银","赵阿姨"], i), opActions[i % opActions.length],
    pick(["301 陈立","304 刘洋","402 王芳","501 吴静","8202 杨燕茨","8408 徐宗令"], i) + " · 操作成功", iso(addDays(now, -Math.floor(i / 3))));
}
for (let i = 0; i < 40; i++) {
  const r = ROOMS[i % ROOMS.length];
  const pairs = [["VC","VD","客人退房"],["VD","VC","打扫完成"],["VC","OOO","维修"],["OOO","VC","维修完成"],["OC","OD","置脏"],["OD","OC","打扫完成"],["VC","LOCK","预留"],["LOCK","VC","解除"]];
  const [f, t, reason] = pairs[i % pairs.length];
  ins(`INSERT INTO room_logs (hotel_id,room_id,from_status,to_status,reason,operator,created_at) VALUES (?,?,?,?,?,?,?)`,
    hotelId, r.id, f, t, reason, pick(["赵阿姨","李前台"], i), iso(addDays(now, -Math.floor(i / 2))));
}

// ---------- 客房任务 / 夜审 / 设置 / 公告 / 失物 / 报价 / 哑房 ----------
const dirtyRooms = db.prepare(`SELECT id FROM rooms WHERE hotel_id=? AND status IN ('VD','OD') LIMIT 16`).all(hotelId);
for (const r of dirtyRooms) {
  ins(`INSERT INTO housekeeping (hotel_id,room_id,task_type,status,assignee,created_at) VALUES (?,?,?,?,?,?)`,
    hotelId, r.id, "打扫", "PENDING", "赵阿姨", iso(now));
}
for (let i = 1; i <= 6; i++) {
  const d = addDays(now, -i);
  ins(`INSERT INTO night_audits (hotel_id,biz_date,status,rooms_sold,revenue,occupancy,operator,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    hotelId, ymd(d), "DONE", 18 + i, 9000 + i * 320, (18 + i) / 45, "张经理", iso(addDays(d, 1)));
}

const SETTINGS = [["hotel_name","云栖国际酒店"],["check_in_time","14:00"],["check_out_time","12:00"],["night_audit_time","02:00"],["currency","CNY"],["invoice_title","云栖国际酒店有限公司"]];
for (const [k, v] of SETTINGS) ins(`INSERT INTO settings (hotel_id,key,value) VALUES (?,?,?)`, hotelId, k, v);

const NOTICES = [["本周房态盘点通知","请各岗位于周五前完成本楼层房态核对，脏房及时报客房中心。","normal"],["五一房价调整","4 月 28 日起悦享阔景特大床房上调 30 元，协议价不变。","important"],["消防演练安排","下周二 15:00 全店消防演练，请提前告知住客。","normal"]];
for (const [t, c, l] of NOTICES) ins(`INSERT INTO notices (hotel_id,title,content,author,level,created_at) VALUES (?,?,?,?,?,?)`, hotelId, t, c, "张经理", l, iso(addDays(now, -3)));

for (let i = 0; i < 6; i++) {
  ins(`INSERT INTO lost_items (hotel_id,item_name,room_no,guest_name,mobile,found_at,keeper,status,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    hotelId, pick(["黑色充电器","蓝色雨伞","眼镜","钥匙扣","外套","充电宝"], i), pick(ROOMS, i).no, pick(GUEST_NAMES, i),
    "13800001234", ymd(addDays(now, -i)), "赵阿姨", i % 3 === 0 ? "RETURNED" : "KEEPING", "", iso(now));
}

for (let i = 0; i < 5; i++) {
  const rt = ROOM_TYPES[i % ROOM_TYPES.length];
  ins(`INSERT INTO quotes (hotel_id,name,room_type_id,price,start_date,end_date,note,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    hotelId, pick(["国庆特价","冬季特惠","周末价","连住优惠","长包房价"], i), typeIds[rt[0]], rt[5] + 20,
    ymd(addDays(now, 10)), ymd(addDays(now, 40)), "促销报价", iso(now));
}

db.exec(`CREATE TABLE IF NOT EXISTS dummy_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT NOT NULL, code TEXT, category TEXT DEFAULT '其他', status INTEGER DEFAULT 1, note TEXT, created_at TEXT)`);
for (const [n, c, cat] of [["一楼中餐厅","D001","餐饮"],["二楼咖啡厅","D002","餐饮"],["三楼会议室A","D003","会议"],["三楼会议室B","D004","会议"],["健身房","D005","其他"],["洗衣服务","D006","其他"],["迷你吧","D007","餐饮"],["接送机服务","D008","其他"]]) {
  ins(`INSERT INTO dummy_rooms (hotel_id,name,code,category,status,note,created_at) VALUES (?,?,?,?,?,?,?)`, hotelId, n, c, cat, 1, "", iso(now));
}

// ---------- 协议单位 ----------
for (const [n, ct, ph, disc, credit] of [["杭州云启科技有限公司","陈总","13800001111",0.85,50000],["西湖旅行社","刘导","13900002222",0.8,20000],["东方航空杭州分公司","周经理","13700003333",0.9,30000],["春秋旅行社","孙经理","13600004444",0.82,15000]]) {
  ins(`INSERT INTO companies (hotel_id,name,contact,phone,discount,credit_limit) VALUES (?,?,?,?,?,?)`, hotelId, n, ct, ph, disc, credit);
}

const stats = {
  房间: db.prepare("SELECT COUNT(*) c FROM rooms").get().c,
  在住: db.prepare("SELECT COUNT(*) c FROM stays WHERE status='INHOUSE'").get().c,
  空净: db.prepare("SELECT COUNT(*) c FROM rooms WHERE status='VC'").get().c,
  空脏: db.prepare("SELECT COUNT(*) c FROM rooms WHERE status='VD'").get().c,
  住脏: db.prepare("SELECT COUNT(*) c FROM rooms WHERE status='OD'").get().c,
  订单: db.prepare("SELECT COUNT(*) c FROM bookings").get().c,
  渠道订单: db.prepare("SELECT COUNT(*) c FROM channel_orders").get().c,
  今日预抵: db.prepare("SELECT COUNT(*) c FROM bookings WHERE check_in_date=? AND status IN ('PENDING','CONFIRMED')").get(today).c,
  今日预离: db.prepare("SELECT COUNT(*) c FROM stays WHERE status='INHOUSE' AND expect_check_out=?").get(today).c,
};
console.log(stats);
db.close();
