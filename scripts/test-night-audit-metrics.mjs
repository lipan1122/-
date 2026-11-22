/**
 * 夜审经营指标口径验收（整改清单 P1-13「夜审口径偏粗」）
 *
 * 被验收的三个缺陷：
 *   1. 出租间夜没排除钟点房 —— 钟点房 stays.nights = 0（rate_code = '钟点'），
 *      旧代码用 `inhouseStays.length` 把在住单条数当间夜，钟点房被算 1 个间夜，
 *      出租率虚高。
 *   2. 收入没有分列 —— 只有一个总营收，分不出 房费 / 餐饮 / 其他。
 *   3. 退款没有单列冲减 —— 退款是负数 payments，混在收入里或干脆没算，
 *      报表看不出「毛收入 - 退款 = 净收入」。
 *
 * 本脚本做三件事：
 *   A. 静态校验：actions.ts / page.tsx 的口径实现（含必须保护的既有逻辑）没被改坏；
 *   B. 临时库实测：拿真实库做一致性快照 → 把 6 个分列列 DROP 掉回到「迁移前」
 *      → 跑 scripts/migrate-all.mjs 的 runMigrations 把列补回来（验证迁移路径）
 *      → 用 runMigrations 再跑一次验证幂等
 *      → 在 hotel_id = 9999 的独立租户下灌构造数据（不污染真实酒店）
 *      → 执行 actions.ts 里那几条指标 SQL（与源码逐字比对过）→ 断言数值。
 *   C. 真实库校验：data/pms.db 的 night_audits 是否已具备分列列，已分列行是否满足
 *      净收入 = 房费 + 餐饮 + 其他 - 退款、revenue = revenue_net。
 *
 * 临时库放在 data/ 下（与真实库同盘同目录，避免系统临时目录不可写），跑完即删。
 *
 * 用法：node scripts/test-night-audit-metrics.mjs
 */

import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/* 迁移脚本：可 import 的纯逻辑（CLI 与 init-db 共用同一份） */
import { runMigrations } from "./migrate-all.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? " → " + extra : ""}`);
  }
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (s) => s.replace(/\s+/g, " ").trim();

const ACTIONS = join("src", "app", "(main)", "night-audit", "actions.ts");
const PAGE = join("src", "app", "(main)", "night-audit", "page.tsx");
const MIGRATE = join("scripts", "migrate-all.mjs");
const src = readFileSync(ACTIONS, "utf8");
const pageSrc = readFileSync(PAGE, "utf8");
const migrateSrc = readFileSync(MIGRATE, "utf8");
const nSrc = norm(src);

const realPath = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");

/* night_audits 新增的分列列（与 migrate-all.mjs 保持一致） */
const WANT_COLUMNS = [
  ["revenue_room", "房费"],
  ["revenue_food", "餐饮"],
  ["revenue_other", "其他"],
  ["refund_total", "退款冲减"],
  ["revenue_net", "净收入"],
  ["hourly_rooms", "钟点房数"],
];

console.log("=== A. 静态校验：口径实现 ===");

/* ---------- A1. 必须保护的既有逻辑（整改 P0-3 / P0-4 / P1-2 不能被这次改动带回退） ---------- */
check(
  '权限校验 requirePermission("night_audit.run") 仍在',
  /requirePermission\(\s*"night_audit\.run"\s*\)/.test(src)
);
check("账务重算仍走 recalcFolioBalance(hotelId, folio.id)", /recalcFolioBalance\(\s*hotelId\s*,\s*folio\.id\s*\)/.test(src));
check("营业日仍取 bizToday(user.hotelId)", /bizToday\(\s*user\.hotelId\s*\)/.test(src));
check("NOSHOW 判定仍是 check_in_date < today", /check_in_date\s*<\s*\?/.test(src));
check("NOSHOW 仍清房（room_id = NULL）", /status\s*=\s*'NOSHOW'[\s\S]{0,120}room_id\s*=\s*NULL/.test(src));
check("NOSHOW 仍把明细置 CANCELLED", /booking_rooms\s+SET\s+status\s*=\s*'CANCELLED'/.test(src));

/* ---------- A2. 指标 SQL：与 actions.ts 里的常量逐字一致（只比空白） ----------
 * 脚本执行的就是下面这几条 SQL，所以「源码一致」这一层保证了
 * 「测的 SQL == 线上跑的 SQL」——改了源码忘了同步脚本，这里先红。
 */
const SQL_ROOM_NIGHTS = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND COALESCE(s.nights, 0) > 0
   AND COALESCE(s.rate_code, '') <> '钟点'`;

const SQL_HOURLY_ROOMS = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND (COALESCE(s.nights, 0) <= 0 OR COALESCE(s.rate_code, '') = '钟点')`;

const SQL_REVENUE_ROOM = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
 WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'ROOM'`;

const SQL_REVENUE_FOOD = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
 WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'FOOD'`;

const SQL_REVENUE_OTHER = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
 WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'OTHER'`;

const SQL_REFUND_TOTAL = `SELECT COALESCE(SUM(ABS(p.amount)), 0) AS v
  FROM payments p
 WHERE p.hotel_id = ? AND p.biz_date = ?
   AND (p.amount < 0 OR p.refund_of IS NOT NULL)`;

check("出租间夜 SQL 与源码一致（只统计 nights > 0）", nSrc.includes(norm(SQL_ROOM_NIGHTS)));
check("钟点房 SQL 与源码一致（nights = 0 / rate_code = '钟点'）", nSrc.includes(norm(SQL_HOURLY_ROOMS)));
check("房费 SQL 与源码一致（item_type = 'ROOM'）", nSrc.includes(norm(SQL_REVENUE_ROOM)));
check("餐饮 SQL 与源码一致（item_type = 'FOOD'）", nSrc.includes(norm(SQL_REVENUE_FOOD)));
check("其他 SQL 与源码一致（item_type = 'OTHER'）", nSrc.includes(norm(SQL_REVENUE_OTHER)));
check("退款 SQL 与源码一致（amount < 0 或 refund_of 非空，取绝对值）", nSrc.includes(norm(SQL_REFUND_TOTAL)));
check("不再用 inhouseStays.length 当售出房间数", !/roomsSold\s*=\s*inhouseStays\.length/.test(src));
check("净收入 = 毛收入 - 退款（源码）", /netRevenue\s*=\s*round2\(\s*grossRevenue\s*-\s*refundTotal\s*\)/.test(src));

/* ---------- A3. 表结构迁移 ---------- */
check(
  "migrate-all.mjs 用 addColumn 补 6 个分列列",
  WANT_COLUMNS.every(([c]) => new RegExp(`addColumn\\(\\s*"night_audits"\\s*,\\s*"${c}"`).test(migrateSrc))
);
check("夜审 INSERT 写入分列列", /revenue_room, revenue_food, revenue_other, refund_total, revenue_net/.test(nSrc));
check("revenue 兼容列继续写净收入", /netRevenue, \/\/ revenue 兼容列/.test(src));

/* ---------- A4. 页面展示口径 ---------- */
check("页面按营业日取数（bizToday）", /bizToday\(/.test(pageSrc));
check("页面展示房费/餐饮/其他/退款/净收入五项", ["房费", "餐饮", "其他", "退款冲减", "净收入"].every((k) => pageSrc.includes(k)));
check("页面给出「毛收入 - 退款 = 净收入」算式", /毛收入/.test(pageSrc) && /退款冲减/.test(pageSrc));
check("页面标注口径说明（押金/冲账不算收入）", /押金、冲账不算收入/.test(pageSrc));
check("历史旧行有「未分列」回退（不把未知显示成 0）", /isLegacyAudit/.test(pageSrc));
check("页面出租率用出租间夜口径", /出租间夜/.test(pageSrc) && /不计间夜/.test(pageSrc));

console.log("\n=== B. 临时库实测（真实库快照 → 移除分列列 → migrate 补回 → 灌数据 → 跑指标 SQL）===");

const tmpDbPath = join(process.cwd(), "data", `tmp-night-audit-${process.pid}-${Date.now()}.db`);
let db;
try {
  /* B1. 一致性快照：VACUUM INTO 会把 WAL 一并落成单文件，不碰真实库数据 */
  const snapSrc = new DatabaseSync(realPath);
  snapSrc.exec(`VACUUM INTO '${tmpDbPath.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  snapSrc.close();

  db = new DatabaseSync(tmpDbPath);
  const one = (sql, p = []) => db.prepare(sql).get(...p);
  const exec = (sql, p = []) => db.prepare(sql).run(...p);
  const colsOf = () => db.prepare(`PRAGMA table_info(night_audits)`).all().map((c) => c.name);

  /* B2. 把 6 个分列列 DROP 掉，回到「迁移前」的老库形态 */
  for (const [c] of WANT_COLUMNS) {
    if (colsOf().includes(c)) db.exec(`ALTER TABLE night_audits DROP COLUMN ${c}`);
  }
  check(
    "快照已还原成迁移前形态（6 个分列列都不存在）",
    WANT_COLUMNS.every(([c]) => !colsOf().includes(c)),
    colsOf().join(",")
  );

  /* B3. 跑迁移：列应被 addColumn 重新补上 */
  const m1 = runMigrations(db, { checkOnly: false });
  for (const [c, label] of WANT_COLUMNS) {
    check(`迁移补列 night_audits.${c}（${label}）`, colsOf().includes(c));
  }
  check("runMigrations 首次执行有变更", m1.changed > 0, `changed=${m1.changed}`);
  const m2 = runMigrations(db, { checkOnly: false });
  check("runMigrations 重复执行零变更（幂等）", m2.changed === 0, `changed=${m2.changed}`);

  /* B4. 构造数据：独立租户 hotel_id = 9999，不污染真实酒店
   * 40 间房；在住 13 单 = 10 单过夜 + 3 单不计间夜（2 单 nights=0，1 单 rate_code 钟点但 nights 被写成 2） */
  const H = 9999;
  const BIZ = "2030-01-15"; // 远离真实数据的营业日
  const PREV = "2030-01-14";
  for (let i = 1; i <= 40; i += 1) {
    exec(`INSERT INTO rooms (hotel_id, room_no, room_type_id, status) VALUES (?,?,1,'OC')`, [
      H,
      `T${String(i).padStart(3, "0")}`,
    ]);
  }
  let staySeq = 0;
  const addStay = (nights, rateCode, status) => {
    staySeq += 1;
    exec(
      `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, nights, rate, rate_code, status, created_at)
       VALUES (?,?,?, '测试客', ?, 300, ?, ?, ?)`,
      [H, `T${H}-${staySeq}`, staySeq, nights, rateCode, status, `${BIZ}T12:00:00.000+08:00`]
    );
  };
  /* 8 单日租（nights 1~3，rate_code = 门市价）+ 2 单日租（rate_code 为空，历史数据常见） */
  for (let i = 0; i < 8; i += 1) addStay(1 + (i % 3), "门市价", "INHOUSE");
  for (let i = 0; i < 2; i += 1) addStay(2, null, "INHOUSE");
  /* 钟点房 1：nights = 0 + rate_code = '钟点'（toHourlyAction 写入的形状） */
  addStay(0, "钟点", "INHOUSE");
  /* 钟点房 2：nights = 0 但 rate_code 为空 */
  addStay(0, null, "INHOUSE");
  /* 钟点房 3：rate_code = '钟点' 但 nights 被误写成 2（防御性口径，仍不计间夜） */
  addStay(2, "钟点", "INHOUSE");
  /* 已离店 2 单：不论 nights 多少都不能算在住 */
  addStay(1, "门市价", "CHECKED_OUT");
  addStay(0, "钟点", "CHECKED_OUT");

  const totalInhouse = Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [H]).c);

  exec(`INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name) VALUES (?,?,?, '测试客')`, [H, `T-F-${H}`, 1]);
  const folioId = Number(one(`SELECT MAX(id) AS id FROM folios WHERE hotel_id = ?`, [H]).id);
  const addItem = (type, amount, bizDate = BIZ, desc = "") =>
    exec(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,1,?,?,?, ?, 1)`,
      [H, folioId, type, desc, amount, amount, bizDate, `${bizDate}T12:00:00.000+08:00`]
    );
  addItem("ROOM", 1800, BIZ, `房费 ${BIZ}`);
  addItem("ROOM", 150, BIZ, "钟点房 3 小时"); // 钟点房房费：是房费收入，但不产生间夜
  addItem("FOOD", 300, BIZ, "中餐厅");
  addItem("OTHER", 200, BIZ, "商超：矿泉水");
  addItem("OTHER", -50, BIZ, "商超退货");
  addItem("DEPOSIT", 1000, BIZ, "押金（不是收入）");
  addItem("ADJUST", -300, BIZ, "【部分结账】内部结账（不是消费）");
  addItem("ROOM", 500, PREV, "隔日房费（不归本期）");

  /* 收款流水：+4000 收款；退款 -150 / -50（有 refund_of）、-80（无关联的负数），隔日 -999 */
  let paySeq = 0;
  const addPay = (amount, bizDate = BIZ, refundOf = null) => {
    paySeq += 1;
    exec(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of)
       VALUES (?,?,?,?, '现金', ?, ?, '测试', ?, ?)`,
      [H, folioId, 1, `T-PAY-${H}-${paySeq}`, amount, bizDate, `${bizDate}T12:00:00.000+08:00`, refundOf]
    );
  };
  addPay(4000);
  addPay(-150, BIZ, 1);
  addPay(-50, BIZ, 1);
  addPay(-80);
  addPay(-999, PREV);

  /* B5. 跑 actions.ts 的同款 SQL（上面逐字比对过源码） */
  const roomNights = Number(one(SQL_ROOM_NIGHTS, [H]).v);
  const hourlyRooms = Number(one(SQL_HOURLY_ROOMS, [H]).v);
  const revenueRoom = round2(Number(one(SQL_REVENUE_ROOM, [H, BIZ]).v));
  const revenueFood = round2(Number(one(SQL_REVENUE_FOOD, [H, BIZ]).v));
  const revenueOther = round2(Number(one(SQL_REVENUE_OTHER, [H, BIZ]).v));
  const refundTotal = round2(Number(one(SQL_REFUND_TOTAL, [H, BIZ]).v));
  const totalRooms = Number(one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [H]).c);
  const oldRoomsSold = totalInhouse; // 旧算法：在住单条数（含钟点房）

  /* --- 缺陷 1：钟点房不计入间夜 --- */
  check("钟点房不计入出租间夜（新 10 / 旧 13）", roomNights === 10 && oldRoomsSold === 13, `新=${roomNights} 旧=${oldRoomsSold}`);
  check("钟点房单独留痕（hourly_rooms = 3）", hourlyRooms === 3, `hourly=${hourlyRooms}`);
  check("已离店单不计入在住口径", totalInhouse === 13, `inhouse=${totalInhouse}`);
  const occupancy = totalRooms > 0 ? roomNights / totalRooms : 0;
  check(
    "出租率按「出租间夜 / 总房量」，不再被钟点房抬高",
    near(occupancy, 0.25) && !near(oldRoomsSold / totalRooms, 0.25),
    `新=${occupancy.toFixed(4)} 旧=${(oldRoomsSold / totalRooms).toFixed(4)}`
  );

  /* --- 缺陷 2：收入分列 --- */
  const gross = round2(revenueRoom + revenueFood + revenueOther);
  const sumLegacy = round2(
    Number(
      one(
        `SELECT COALESCE(SUM(amount), 0) AS v FROM folio_items
          WHERE hotel_id = ? AND biz_date = ? AND item_type IN ('ROOM','FOOD','OTHER')`,
        [H, BIZ]
      ).v
    )
  );
  check("房费只取 ROOM 明细（1800 + 钟点房 150）", revenueRoom === 1950, `room=${revenueRoom}`);
  check("餐饮只取 FOOD 明细", revenueFood === 300, `food=${revenueFood}`);
  check("其他只取 OTHER 明细（含退货 -50）", revenueOther === 150, `other=${revenueOther}`);
  check("押金 DEPOSIT / 冲账 ADJUST 不算收入", gross === 2400 && gross !== 3100, `gross=${gross}`);
  check("三项相加等于原总营收口径（IN('ROOM','FOOD','OTHER')）", near(gross, sumLegacy), `${gross} vs ${sumLegacy}`);
  check("隔日房费不归本期（未把 2030-01-14 的 500 算进来）", revenueRoom !== 2450, `room=${revenueRoom}`);

  /* --- 缺陷 3：退款单列 + 净收入 --- */
  check("退款取负数收款绝对值（150 + 50 + 80 = 280）", refundTotal === 280, `refund=${refundTotal}`);
  check("正数收款不误算成退款（4000 未计入）", refundTotal !== 4280);
  check("隔日退款不归本期（2030-01-14 的 999 未计入）", refundTotal !== 1279);
  const net = round2(gross - refundTotal);
  check("净收入 = 毛收入 - 退款（2400 - 280 = 2120）", net === 2120, `net=${net}`);

  /* B6. 用与 actions.ts 相同的 INSERT 落库，再读回校验 */
  const INSERT_SQL = `INSERT INTO night_audits
         (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
          revenue_room, revenue_food, revenue_other, refund_total, revenue_net,
          operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  check(
    "INSERT 列清单与源码一致",
    nSrc.includes(
      norm(
        `INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy, revenue_room, revenue_food, revenue_other, refund_total, revenue_net, operator, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
    )
  );
  const rowArgs = [H, BIZ, "DONE", roomNights, hourlyRooms, net, occupancy, revenueRoom, revenueFood, revenueOther, refundTotal, net, "测试员", `${BIZ}T23:59:00.000+08:00`];
  exec(INSERT_SQL, rowArgs);
  const row = one(`SELECT * FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, BIZ]);
  check("落库：rooms_sold 为出租间夜（10，不含钟点房）", Number(row.rooms_sold) === 10, `rooms_sold=${row.rooms_sold}`);
  check("落库：hourly_rooms = 3", Number(row.hourly_rooms) === 3, `hourly_rooms=${row.hourly_rooms}`);
  check("落库：revenue = revenue_net（兼容列写净收入）", near(row.revenue, row.revenue_net) && near(row.revenue_net, 2120));
  check(
    "落库：revenue_room + revenue_food + revenue_other = 毛收入",
    near(row.revenue_room + row.revenue_food + row.revenue_other, 2400)
  );
  check("落库：refund_total 单列且为正数（表示退出去多少）", near(row.refund_total, 280) && row.refund_total > 0);
  check(
    "落库：净收入 = 毛收入 - 退款",
    near(row.revenue_net, row.revenue_room + row.revenue_food + row.revenue_other - row.refund_total)
  );
  check("落库：出租率 = 出租间夜 / 总房量", near(row.occupancy, 0.25));

  /* B7. 幂等：同一天重复夜审必须被唯一键挡住，不重复累加 */
  let dupErr = null;
  try {
    exec(INSERT_SQL, [...rowArgs.slice(0, 13), `${BIZ}T23:59:30.000+08:00`]);
  } catch (e) {
    dupErr = e;
  }
  const cnt = Number(one(`SELECT COUNT(*) AS c FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, BIZ]).c);
  check("重复跑同一天被 UNIQUE(hotel_id, biz_date) 拒绝", /UNIQUE/i.test(String(dupErr?.message ?? "")), String(dupErr?.message));
  check("幂等：同一天只有一条夜审记录，金额不累加", cnt === 1, `rows=${cnt}`);
  check(
    "幂等：唯一键含 hotel_id（多酒店同营业日互不冲突）",
    /UNIQUE\s*\(\s*hotel_id\s*,\s*biz_date\s*\)/i.test(
      one(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'night_audits'`).sql
    )
  );
} finally {
  try {
    db?.close();
  } finally {
    rmSync(tmpDbPath, { force: true });
    rmSync(`${tmpDbPath}-wal`, { force: true });
    rmSync(`${tmpDbPath}-shm`, { force: true });
  }
}

console.log("\n=== C. 真实库校验（data/pms.db，只读）===");
const real = new DatabaseSync(realPath, { readOnly: true });
try {
  const realCols = real.prepare(`PRAGMA table_info(night_audits)`).all().map((c) => c.name);
  check(
    "真实库 night_audits 已有 6 个分列列（先跑 node scripts/migrate-all.mjs）",
    WANT_COLUMNS.every(([c]) => realCols.includes(c)),
    realCols.join(",")
  );
  const rows = real.prepare(`SELECT * FROM night_audits`).all();
  const split = rows.filter((r) => Number(r.revenue_net ?? 0) !== 0 || Number(r.revenue_room ?? 0) !== 0);
  const bad = split.filter(
    (r) =>
      !near(
        Number(r.revenue_net ?? 0),
        Number(r.revenue_room ?? 0) +
          Number(r.revenue_food ?? 0) +
          Number(r.revenue_other ?? 0) -
          Number(r.refund_total ?? 0),
        0.02
      ) || !near(Number(r.revenue ?? 0), Number(r.revenue_net ?? 0), 0.02)
  );
  check(
    `真实库已分列的行满足 净收入 = 毛收入 - 退款 且 revenue = revenue_net（${split.length} 行）`,
    bad.length === 0,
    JSON.stringify(bad.slice(0, 3))
  );
  const legacy = rows.length - split.length;
  console.log(
    `   ℹ 真实库共 ${rows.length} 条夜审记录：已分列 ${split.length} 条 / 迁移前旧口径 ${legacy} 条（页面按「未分列」显示，净收入回退到 revenue）`
  );
} finally {
  real.close();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
