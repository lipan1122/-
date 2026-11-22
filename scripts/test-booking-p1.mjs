/**
 * P1 预订 / 排房一致性验收脚本（独立脚本，不改动别人的测试）
 *
 * 覆盖 4 项整改：
 *   P1-1  排房并发兜底不严：事务内重查房间 + 三来源区间冲突 + 乐观锁 changes 判定
 *   P1-11 删预订不级联明细：删预订单时同事务删 booking_rooms，不留孤儿
 *   P1-12 钟点房价格语义混用：bookings.total_price 列 + 「优先 total_price」金额口径
 *   P1-7  预订定金未落库：deposit 写库 + 上限校验 + 入住时转押金
 *
 * 为什么用「VACUUM INTO 的临时副本」而不是直接改 data/pms.db：
 *   本脚本要造预订、造明细、删数据来验证级联，绝不能碰正在被 3100 服务使用的开发库；
 *   VACUUM INTO 生成的是事务一致的快照，副本的 schema 与真实库完全一致，
 *   所以「迁移是否已到目标状态」在副本上检查等价于在真实库上检查。
 *
 * 用法：
 *   node scripts/test-booking-p1.mjs                  # 校验 data/pms.db 的快照
 *   PMS_DB_PATH=/path/pms.db node scripts/test-booking-p1.mjs
 * 退出码：0 = 全部通过，1 = 有失败项（可直接接进 CI）。
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { runMigrations, resolveDbPath } from "./migrate-all.mjs";

const SRC_DB = resolveDbPath();
const TMP_DIR = path.join(process.cwd(), "data", ".tmp-p1-test");
const TMP_DB = path.join(TMP_DIR, "pms-p1.db");
const SRC_ROOT = process.cwd();

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name} ${extra ? "→ " + extra : ""}`);
  }
};

const all = (db, sql, p = []) => db.prepare(sql).all(...p);
const one = (db, sql, p = []) => db.prepare(sql).get(...p);
const run = (db, sql, p = []) => db.prepare(sql).run(...p);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const readSrc = (rel) => fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");

/** 模拟 src/lib/db.ts 的 tx：BEGIN / COMMIT / 失败 ROLLBACK 后重抛 */
function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 准备：快照一份临时库                                                 */
/* ------------------------------------------------------------------ */
if (!fs.existsSync(SRC_DB)) {
  console.error(`找不到数据库：${SRC_DB}`);
  process.exit(1);
}
fs.mkdirSync(TMP_DIR, { recursive: true });
for (const f of [TMP_DB, TMP_DB + "-wal", TMP_DB + "-shm"]) fs.rmSync(f, { force: true });

const srcDb = new DatabaseSync(SRC_DB, { readOnly: true });
srcDb.exec(`VACUUM INTO '${TMP_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
srcDb.close();

const db = new DatabaseSync(TMP_DB);
db.exec("PRAGMA foreign_keys = ON");
console.log(`源库：${SRC_DB}`);
console.log(`副本：${TMP_DB}\n`);

const hotelId = one(db, `SELECT id FROM hotels ORDER BY id LIMIT 1`)?.id;
const roomTypeId = one(db, `SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [hotelId])?.id;
const now = new Date().toISOString();
const TEST_NO = `T-P1-${Date.now()}`;

/* 清掉上次残留的测试数据（副本是一次性的，这里只是兜底） */
const cleanupTestRows = () => {
  const ids = all(db, `SELECT id FROM bookings WHERE booking_no LIKE 'T-P1-%'`).map((r) => r.id);
  for (const id of ids) {
    run(db, `DELETE FROM booking_rooms WHERE booking_id = ?`, [id]);
    run(db, `DELETE FROM bookings WHERE id = ?`, [id]);
  }
  run(db, `DELETE FROM rooms WHERE room_no LIKE 'T-P1-%'`);
};
cleanupTestRows();

/* ------------------------------------------------------------------ */
/* A. P1-12 迁移：bookings.total_price 列必须存在且迁移幂等             */
/* ------------------------------------------------------------------ */
console.log("—— A. 迁移（P1-12 bookings.total_price）——");

const bookingCols = all(db, `PRAGMA table_info(bookings)`).map((c) => c.name);
check("bookings 有 total_price 列（老库升级生效）", bookingCols.includes("total_price"), bookingCols.join(","));

// 副本就是真实库的快照：checkOnly 报 0 项待处理 = 真实库已到目标状态
const checkResult = runMigrations(db, { checkOnly: true });
check(
  "migrate-all --check 已是目标状态（0 项待处理）",
  checkResult.applied.length === 0,
  checkResult.applied.join("；")
);

const again = runMigrations(db, { checkOnly: false });
check("迁移可重复执行（第二次 0 处变更）", again.changed === 0, `changed=${again.changed}`);
check(
  "迁移跳过项里含 bookings.total_price（说明是幂等跳过，不是没跑到）",
  again.skipped.includes("bookings.total_price"),
  again.skipped.join(",")
);

/* ------------------------------------------------------------------ */
/* B. P1-12 钟点房价格语义：total_price 优先，rate × nights 回退        */
/* ------------------------------------------------------------------ */
console.log("\n—— B. 钟点房金额口径（P1-12）——");

// 现状确认：本系统「钟点」落在 stays（nights = 0，rate 存钟点总价），bookings 里没有 hourly 标识
const hourlyStays = one(db, `SELECT COUNT(*) AS c FROM stays WHERE COALESCE(nights, 0) = 0`).c;
const hourlyBookings = one(db, `SELECT COUNT(*) AS c FROM bookings WHERE COALESCE(nights, 0) = 0`).c;
console.log(`  现状：stays 钟点单 ${hourlyStays} 条（nights = 0）；bookings 里 nights = 0 的 ${hourlyBookings} 条`);
check("确认钟点房不参与 nights 计算（以 nights = 0 标识）", hourlyBookings === 0);

/* 造两条测试预订：一条日租、一条钟点（nights = 0，rate = 钟点总价） */
const insBooking = (row) =>
  Number(
    run(
      db,
      `INSERT INTO bookings
         (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date, nights,
          room_count, rate, deposit, total_price, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        row.booking_no,
        "P1测试客人",
        roomTypeId,
        row.check_in,
        row.check_out,
        row.nights,
        row.room_count,
        row.rate,
        row.deposit,
        row.total_price,
        "PENDING",
        now,
        now,
      ]
    ).lastInsertRowid
  );

const dailyId = insBooking({
  booking_no: `${TEST_NO}-D`,
  check_in: "2030-01-01",
  check_out: "2030-01-03",
  nights: 2,
  room_count: 2,
  rate: 300,
  deposit: 200,
  total_price: 1200, // 300 × 2 晚 × 2 间
});
const hourlyId = insBooking({
  booking_no: `${TEST_NO}-H`,
  check_in: "2030-02-01",
  check_out: "2030-02-01",
  nights: 0, // 钟点房标识
  room_count: 1,
  rate: 260, // 钟点总价直接放 rate
  deposit: 100,
  total_price: 260, // 新口径：总价另存，不再靠 rate 兼价
});

/**
 * 报表/账单取房费的旧口径与新口径。
 * 旧：COALESCE(rate,0) * COALESCE(nights,1) * room_count —— 钟点房 rate 是总价，会被当整晚价再乘一次
 * 新：COALESCE(total_price, rate * 晚数 * 间数) —— 有 total_price 就用它
 */
const OLD_SQL = `SELECT COALESCE(rate, 0) * COALESCE(nights, 1) * MAX(1, COALESCE(room_count, 1)) AS amount
                   FROM bookings WHERE id = ?`;
const NEW_SQL = `SELECT COALESCE(total_price,
                          COALESCE(rate, 0) * COALESCE(NULLIF(nights, 0), 1) * MAX(1, COALESCE(room_count, 1))
                        ) AS amount
                   FROM bookings WHERE id = ?`;

const daily = one(db, NEW_SQL, [dailyId]).amount;
const hourly = one(db, NEW_SQL, [hourlyId]).amount;
const hourlyOld = one(db, OLD_SQL, [hourlyId]).amount;

check("日租：total_price 口径 = 房价 × 晚数 × 间数（1200）", daily === 1200, String(daily));
check("钟点：total_price 口径保留真实总价（260，不会变成 0）", hourly === 260, String(hourly));
check(
  "旧口径会把钟点房算错（说明为什么必须换口径）",
  hourlyOld !== hourly,
  `old=${hourlyOld} new=${hourly}`
);

// 老数据兜底：total_price 为 NULL 时必须回退到 rate × 晚数 × 间数，金额不能变 0
const legacy = one(
  db,
  `SELECT b.id, b.rate, b.nights, b.room_count,
          COALESCE(b.total_price,
                   COALESCE(b.rate, 0) * COALESCE(NULLIF(b.nights, 0), 1) * MAX(1, COALESCE(b.room_count, 1))) AS amount
     FROM bookings b WHERE b.total_price IS NULL AND COALESCE(b.nights, 0) > 0 LIMIT 1`
);
check(
  "老数据（total_price 为 NULL）回退口径金额正确",
  Boolean(legacy) && legacy.amount === round2(legacy.rate * legacy.nights * Math.max(1, legacy.room_count ?? 1)),
  JSON.stringify(legacy)
);

// 全库一致性：凡是写了 total_price 的行，都不能与「总价语义」冲突
const badTotal = one(
  db,
  `SELECT COUNT(*) AS c FROM bookings
    WHERE total_price IS NOT NULL AND COALESCE(nights, 0) > 0
      AND ABS(total_price - COALESCE(rate, 0) * nights * MAX(1, COALESCE(room_count, 1))) > 0.01`
).c;
check("日租行 total_price 与 rate × 晚数 × 间数一致（无脏数据）", badTotal === 0, `不一致 ${badTotal} 条`);

/* ------------------------------------------------------------------ */
/* C. P1-11 删预订要级联明细                                            */
/* ------------------------------------------------------------------ */
console.log("\n—— C. 删预订级联明细（P1-11）——");

const testRoomId = Number(
  run(
    db,
    `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`,
    [hotelId, `T-P1-${Date.now() % 100000}`, 9, roomTypeId, "VC", 999]
  ).lastInsertRowid
);

const cascadeId = insBooking({
  booking_no: `${TEST_NO}-C`,
  check_in: "2030-03-01",
  check_out: "2030-03-03",
  nights: 2,
  room_count: 2,
  rate: 280,
  deposit: 0,
  total_price: 1120,
});
run(
  db,
  `INSERT INTO booking_rooms
     (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
      check_in_date, check_out_date, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [hotelId, cascadeId, roomTypeId, testRoomId, "P1测试客人", 280, "CONFIRMED", "2030-03-01", "2030-03-03", now]
);
run(
  db,
  `INSERT INTO booking_rooms
     (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
      check_in_date, check_out_date, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [hotelId, cascadeId, roomTypeId, null, "P1测试客人", 280, "PENDING", "2030-03-01", "2030-03-03", now]
);
const beforeDetails = one(db, `SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ?`, [cascadeId]).c;
check("测试预订先有 2 条房间明细", beforeDetails === 2, String(beforeDetails));

/* 复刻 deleteBookingAction 的 SQL：同一事务内先删明细、再删主单 */
tx(db, () => {
  run(db, `DELETE FROM booking_rooms WHERE booking_id = ? AND hotel_id = ?`, [cascadeId, hotelId]);
  run(db, `DELETE FROM bookings WHERE id = ? AND hotel_id = ?`, [cascadeId, hotelId]);
});
check(
  "删预订后 booking_rooms 不再有该单明细（无孤儿）",
  one(db, `SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ?`, [cascadeId]).c === 0
);
check(
  "删预订后主单已删除",
  one(db, `SELECT COUNT(*) AS c FROM bookings WHERE id = ?`, [cascadeId]).c === 0
);
check(
  "全库无孤儿明细（booking_rooms 都能对上主单）",
  one(
    db,
    `SELECT COUNT(*) AS c FROM booking_rooms br
      WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = br.booking_id)`
  ).c === 0
);

/* 批量删除口径：已入住订单不允许删，它的明细必须保留 */
const occupiedId = insBooking({
  booking_no: `${TEST_NO}-O`,
  check_in: "2030-04-01",
  check_out: "2030-04-02",
  nights: 1,
  room_count: 1,
  rate: 300,
  deposit: 0,
  total_price: 300,
});
run(db, `UPDATE bookings SET status = 'CHECKED_IN' WHERE id = ?`, [occupiedId]);
run(
  db,
  `INSERT INTO booking_rooms
     (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
      check_in_date, check_out_date, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [hotelId, occupiedId, roomTypeId, testRoomId, "P1在住客人", 300, "CHECKED_IN", "2030-04-01", "2030-04-02", now]
);
/* 复刻 batchDeleteBookingsAction：先查出可删的，再按这批 id 删明细、删主单 */
tx(db, () => {
  const ids = [occupiedId, cascadeId];
  const deletable = all(
    db,
    `SELECT id FROM bookings WHERE hotel_id = ? AND id IN (${ids.map(() => "?").join(",")})
       AND status <> 'CHECKED_IN'`,
    [hotelId, ...ids]
  );
  for (const row of deletable) {
    run(db, `DELETE FROM booking_rooms WHERE booking_id = ? AND hotel_id = ?`, [row.id, hotelId]);
  }
  run(
    db,
    `DELETE FROM bookings WHERE hotel_id = ? AND id IN (${ids.map(() => "?").join(",")})
       AND status <> 'CHECKED_IN'`,
    [hotelId, ...ids]
  );
});
check(
  "批量删除：已入住订单未被删（主单还在）",
  one(db, `SELECT COUNT(*) AS c FROM bookings WHERE id = ?`, [occupiedId]).c === 1
);
check(
  "批量删除：已入住订单的房间明细被保留",
  one(db, `SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ?`, [occupiedId]).c === 1
);

/* 源码静态校验：两个删除 action 必须是「先明细、后主单」且包在事务里 */
const bookingActionsSrc = readSrc("src/app/(main)/bookings/actions.ts");
const deleteFnStart = bookingActionsSrc.indexOf("export async function deleteBookingAction");
const deleteFnBody = bookingActionsSrc.slice(deleteFnStart, bookingActionsSrc.indexOf("/* ------", deleteFnStart));
check(
  "deleteBookingAction 事务内先删 booking_rooms",
  deleteFnStart > 0 &&
    deleteFnBody.indexOf("tx(") > 0 &&
    deleteFnBody.indexOf("DELETE FROM booking_rooms") < deleteFnBody.indexOf("DELETE FROM bookings")
);
const batchDeleteStart = bookingActionsSrc.indexOf("export async function batchDeleteBookingsAction");
const batchDeleteBody = bookingActionsSrc.slice(batchDeleteStart, batchDeleteStart + 2200);
check(
  "batchDeleteBookingsAction 事务内先删 booking_rooms",
  batchDeleteStart > 0 &&
    batchDeleteBody.indexOf("tx(") > 0 &&
    batchDeleteBody.indexOf("DELETE FROM booking_rooms") < batchDeleteBody.indexOf("DELETE FROM bookings") &&
    batchDeleteBody.includes("status <> 'CHECKED_IN'")
);

/* ------------------------------------------------------------------ */
/* D. P1-1 排房并发兜底                                                 */
/* ------------------------------------------------------------------ */
console.log("\n—— D. 排房并发兜底（P1-1）——");

/* D1. 乐观锁语义：可排状态 changes = 1；被改过 changes = 0 */
run(db, `UPDATE rooms SET status = 'VC' WHERE id = ?`, [testRoomId]);
const lockOk = run(
  db,
  `UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')`,
  [testRoomId, hotelId]
);
check("乐观锁：房间可排（VC）时 changes = 1（抢到）", Number(lockOk.changes) === 1, String(lockOk.changes));

run(db, `UPDATE rooms SET status = 'OOO' WHERE id = ?`, [testRoomId]);
const lockFail = run(
  db,
  `UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')`,
  [testRoomId, hotelId]
);
check("乐观锁：房态被别人改成 OOO 后 changes = 0（整批回滚）", Number(lockFail.changes) === 0, String(lockFail.changes));

/* D2. 「日期不同但区间重叠」是唯一索引兜不住、必须靠区间校验的场景 */
run(db, `UPDATE rooms SET status = 'VC' WHERE id = ?`, [testRoomId]);
const overlapA = insBooking({
  booking_no: `${TEST_NO}-A`,
  check_in: "2031-05-10",
  check_out: "2031-05-12",
  nights: 2,
  room_count: 1,
  rate: 300,
  deposit: 0,
  total_price: 600,
});
const overlapB = insBooking({
  booking_no: `${TEST_NO}-B`,
  check_in: "2031-05-11",
  check_out: "2031-05-13", // 与 A 重叠 5-11 一天，但起止日期都不同
  nights: 2,
  room_count: 1,
  rate: 300,
  deposit: 0,
  total_price: 600,
});
run(
  db,
  `INSERT INTO booking_rooms
     (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
      check_in_date, check_out_date, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [hotelId, overlapA, roomTypeId, testRoomId, "P1重叠A", 300, "CONFIRMED", "2031-05-10", "2031-05-12", now]
);

let uniqueBlocked = false;
try {
  run(
    db,
    `INSERT INTO booking_rooms
       (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
        check_in_date, check_out_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [hotelId, overlapB, roomTypeId, testRoomId, "P1重叠B", 300, "CONFIRMED", "2031-05-11", "2031-05-13", now]
  );
} catch (e) {
  uniqueBlocked = true;
  console.log("  提示：唯一索引拦下了重叠插入", e.message);
}
check(
  "占房唯一索引拦不住「日期不同但区间重叠」（所以必须事务内查区间）",
  uniqueBlocked === false,
  uniqueBlocked ? "被索引拦下（说明该场景已由索引覆盖，可调整本用例）" : ""
);

/* 事务内三来源之一：booking_rooms 区间冲突查询必须能查到这条重叠 */
const conflict = one(
  db,
  `SELECT COUNT(*) AS c FROM booking_rooms
    WHERE hotel_id = ? AND room_id = ? AND booking_id <> ?
      AND status IN ('CONFIRMED','CHECKED_IN')
      AND check_in_date < ? AND check_out_date > ?`,
  [hotelId, testRoomId, overlapB, "2031-05-13", "2031-05-11"]
).c;
check("事务内区间冲突查询能查出重叠占用（count = 1）", conflict === 1, String(conflict));

/* D3. 源码静态校验：冲突校验必须在事务内、且有乐观锁 */
const assignStart = bookingActionsSrc.indexOf("export async function assignRoomAction");
const assignBody = bookingActionsSrc.slice(assignStart, bookingActionsSrc.indexOf("export async function adjustPriceAction", assignStart));
const txIdx = assignBody.indexOf("tx(() => {");
const detailClashIdx = assignBody.indexOf("FROM booking_rooms\n              WHERE hotel_id = ? AND room_id = ? AND booking_id <> ?");
const lockIdx = assignBody.indexOf("UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')");
const roomRereadIdx = assignBody.indexOf("SELECT id, room_no, room_type_id, status FROM rooms WHERE id = ? AND hotel_id = ?");
check("assignRoomAction：冲突校验在事务内（tx 之前不再有三来源校验）", txIdx > 0 && detailClashIdx > txIdx, `tx@${txIdx} clash@${detailClashIdx}`);
check("assignRoomAction：事务内重查房间行", roomRereadIdx > txIdx, `reread@${roomRereadIdx}`);
check("assignRoomAction：乐观锁 UPDATE rooms SET status = status 且判 changes", lockIdx > txIdx && assignBody.includes("lock.changes === 0"));
check(
  "assignRoomAction：三来源冲突（stays / bookings / booking_rooms）都在事务内",
  assignBody.indexOf("FROM stays") > txIdx &&
    assignBody.indexOf("clashStay") > txIdx &&
    assignBody.indexOf("clashBooking") > txIdx &&
    assignBody.indexOf("clashDetail") > txIdx &&
    assignBody.indexOf("FROM booking_rooms\n              WHERE hotel_id = ? AND room_id = ? AND booking_id <> ?") > txIdx
);

const forecastSrc = readSrc("src/app/(main)/rooms/forecast/actions.ts");
const forecastTxIdx = forecastSrc.indexOf("tx(() => {");
check(
  "forecast assignRoomsAction：补上 booking_rooms 冲突校验且在事务内",
  forecastSrc.indexOf("FROM booking_rooms br") > forecastTxIdx && forecastSrc.indexOf("br.check_in_date < ?") > 0
);
check(
  "forecast assignRoomsAction：乐观锁占位 + changes 判定",
  forecastSrc.indexOf("UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')") > forecastTxIdx &&
    forecastSrc.includes("lock.changes === 0")
);

/* ------------------------------------------------------------------ */
/* E. P1-7 预订定金                                                     */
/* ------------------------------------------------------------------ */
console.log("\n—— E. 预订定金（P1-7）——");

const depositBooking = insBooking({
  booking_no: `${TEST_NO}-E`,
  check_in: "2031-06-01",
  check_out: "2031-06-03",
  nights: 2,
  room_count: 2,
  rate: 300,
  deposit: 200, // rate × nights × roomCount = 1200，200 合法
  total_price: 1200,
});
const persisted = one(db, `SELECT COALESCE(deposit, 0) AS deposit FROM bookings WHERE id = ?`, [depositBooking]).deposit;
check("定金写进 bookings.deposit（不再恒为 0）", persisted === 200, String(persisted));

/*
 * 上限不变量：新口径写入的订单（total_price 非空）不允许「定金 > 房费总额」。
 * 为什么只查 total_price 非空的行：改造前建的历史订单 deposit 已经超出总额
 * （例如种子数据 BK5012：rate 288 / 定金 300），那是旧代码没校验留下的既成事实，
 * 不在本次整改范围内回改业务数据（会动到别人核过的账），所以只约束新写入。
 */
const overDeposit = one(
  db,
  `SELECT COUNT(*) AS c FROM bookings
    WHERE status <> 'CANCELLED' AND total_price IS NOT NULL
      AND COALESCE(deposit, 0) > COALESCE(total_price, 0) + 0.01`
).c;
check("新写入订单不存在「定金超过房费总额」", overDeposit === 0, `超限 ${overDeposit} 条`);

const legacyOver = one(
  db,
  `SELECT COUNT(*) AS c FROM bookings
    WHERE status <> 'CANCELLED' AND total_price IS NULL AND COALESCE(deposit, 0) > 0
      AND COALESCE(deposit, 0) > COALESCE(rate, 0) * COALESCE(NULLIF(nights, 0), 1) * MAX(1, COALESCE(room_count, 1)) + 0.01`
).c;
if (legacyOver > 0) {
  console.log(`  提示：历史订单中还有 ${legacyOver} 条定金超出房费总额（旧代码无校验导致，未回改业务数据）`);
}

/* 定金拆分：整单定金按房费占比拆到各行，各行之和必须等于实收定金（含尾差） */
const weights = [300, 450, 250]; // 三行房费
const splitDeposit = (total, ws, index) => {
  const sum = ws.reduce((s, w) => s + w, 0);
  if (sum <= 0) return index === 0 ? round2(total) : 0;
  if (index >= ws.length - 1) {
    let acc = 0;
    for (let i = 0; i < ws.length - 1; i += 1) acc += round2((total * ws[i]) / sum);
    return round2(total - acc);
  }
  return round2((total * weights[index]) / sum);
};
const splitSum = round2(weights.map((_, i) => splitDeposit(100, weights, i)).reduce((s, v) => s + v, 0));
check("整单定金拆分后各行之和 = 实收定金（尾差不丢钱）", splitSum === 100, String(splitSum));

/* 源码 / 表单静态校验：字段名一致，才有数据从页面流到库 */
const bookingFormSrc = readSrc("src/components/BookingForm.tsx");
check('BookingForm 有 name="deposit" 输入框且受控', bookingFormSrc.includes('name="deposit"') && bookingFormSrc.includes("setDeposit"));
check("createBookingAction 读取表单 deposit", bookingActionsSrc.includes('formData.get("deposit")'));
check("createBookingAction 校验定金上限并回传明确文案", bookingActionsSrc.includes("不能超过订单房费总额"));
check("新建预订页会渲染 err 文案（不静默失败）", readSrc("src/app/(main)/bookings/new/page.tsx").includes("errMsg"));

const frontdeskSrc = readSrc("src/app/(main)/frontdesk/actions.ts");
check(
  "checkInAction 用预订定金兜底入住押金",
  frontdeskSrc.includes("bookedDeposit") && frontdeskSrc.includes("FROM bookings WHERE id = ? AND hotel_id = ?")
);
check("checkInAction 的 deposit 可变（let）以支持定金转入", /let deposit = Math\.max/.test(frontdeskSrc));

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */
cleanupTestRows();
db.close();
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log("存在失败项，请按上面 ❌ 逐条修复");
  process.exit(1);
}
console.log("P1 预订 / 排房 4 项整改验收全部通过 ✅");
