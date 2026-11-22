// 增量迁移：新增通知公告、失物招领表 + 种子数据（不重建库）
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbFile = path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  author TEXT,
  level TEXT DEFAULT 'normal',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS lost_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  room_no TEXT, guest_name TEXT, mobile TEXT,
  found_at TEXT, keeper TEXT,
  status TEXT DEFAULT 'KEEPING',
  note TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  room_type_id INTEGER,
  price REAL,
  start_date TEXT, end_date TEXT,
  note TEXT, created_at TEXT
);
`);

const now = new Date();
const iso = now.toISOString();
const hotelId = 1;

const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

if (count("notices") === 0) {
  const ins = db.prepare(`INSERT INTO notices (hotel_id, title, content, author, level, created_at) VALUES (?,?,?,?,?,?)`);
  ins.run(hotelId, "本周房态盘点通知", "请各岗位于周五前完成本楼层房态核对，脏房及时报客房中心。", "张经理", "normal", iso);
  ins.run(hotelId, "五一房价调整", "4 月 28 日起标准间上调 30 元，协议价不变。", "张经理", "important", iso);
  ins.run(hotelId, "消防演练安排", "下周二 15:00 全店消防演练，请提前告知住客。", "李前台", "normal", iso);
}

if (count("lost_items") === 0) {
  const ins = db.prepare(`INSERT INTO lost_items (hotel_id, item_name, room_no, guest_name, mobile, found_at, keeper, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run(hotelId, "黑色充电器", "301", "陈立", "13811112222", "2026-11-14", "赵阿姨", "KEEPING", "床头柜", iso);
  ins.run(hotelId, "蓝色雨伞", "402", "王芳", "13922223333", "2026-11-15", "赵阿姨", "RETURNED", "已归还", iso);
}

if (count("quotes") === 0) {
  const ins = db.prepare(`INSERT INTO quotes (hotel_id, name, room_type_id, price, start_date, end_date, note, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(hotelId, "国庆标准价", 1, 368, "2026-10-01", "2026-10-07", "节假日上浮", iso);
  ins.run(hotelId, "冬季大床特惠", 2, 288, "2026-12-01", "2027-02-28", "淡季促销", iso);
}

console.log("迁移完成：notices", count("notices"), "lost_items", count("lost_items"), "quotes", count("quotes"));
db.close();
