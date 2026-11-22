/**
 * allotment 语义验收（codex 第七轮清单第三/五节）
 *
 * ── 这个测试在验证什么 ──
 *
 * 清单要求酒店确认 `rate_calendar.allotment` 是：
 *   1. 渠道总放量上限
 *   2. 当天剩余可卖数量
 *
 * **本项目当前选的是「上限」语义**（写在 `src/lib/room-stock.ts` 注释里）：
 *
 *     物理可卖上限 = 总房量 − OOO − LOCK
 *     可售 = min(物理可卖上限, allotment) − 在住 − 预订
 *
 * 也就是说 allotment 只能**收紧**不能**放量**（放量属于渠道侧超售策略）。
 *
 * 本测试把这条语义用可执行断言固定下来，覆盖四种情况：
 *   · allotment < 物理上限  → 按 allotment 收紧
 *   · allotment > 物理上限  → 不外扩，仍按物理上限
 *   · allotment = NULL      → 用物理上限
 *   · allotment = 0         → 显示 0（全部关房）
 *
 * ── 重要：这个测试不能让它「看起来已完成」──
 *
 * 清单明确「未确认前禁止标记 OTA 房量同步已完成」。
 * 所以本测试**只验证代码与当前声明的语义一致**，
 * 不证明这个语义是酒店想要的。
 * 报告里必须标注「allotment 语义待业务确认」。
 *
 * 用法：node scripts/test-allotment-semantics.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDb = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const tmpDir = join(root, ".tmp");
const tmpDb = join(tmpDir, `allotment-${Date.now()}.db`);

if (!existsSync(srcDb)) {
  console.error(`数据库不存在：${srcDb}`);
  process.exit(1);
}
mkdirSync(tmpDir, { recursive: true });
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

const src = new DatabaseSync(srcDb, { readOnly: true });
src.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
src.close();

const db = new DatabaseSync(tmpDb);
db.exec("PRAGMA foreign_keys = ON");

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

const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const today = one(`SELECT date('now','localtime') AS d`).d;
const TEST_HOTEL = 9999;

/*
 * 复刻 `src/lib/room-stock.ts` 的核心算式
 *
 * ⚠️ 这是**副本**，不是直接调用生产函数。原因：`room-stock.ts` 是 TS 且
 * 依赖 `@/lib/db`，本测试要在纯 mjs 里跑。
 *
 * 为了不让「副本与生产实现漂移」，测试里加了**源码断言**：
 * 读 `src/lib/room-stock.ts`，确认里面确实有
 * `Math.min(物理上限, allotment)` 这样的收紧逻辑（见断言 1）。
 * 如果生产代码改了算法而没改这个测试，断言 1 会红。
 */
function sellableFor(roomTypeId, hotelId, day) {
  const phys = one(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS c
       FROM rooms WHERE hotel_id = ? AND room_type_id = ?`,
    [hotelId, roomTypeId]
  ).c;

  const allot = one(
    `SELECT allotment FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ? LIMIT 1`,
    [hotelId, roomTypeId, day]
  );

  /* 上限：allotment 只在「有值且更小」时收紧 */
  const cap = allot && allot.allotment !== null && allot.allotment !== undefined
    ? Math.min(phys, Number(allot.allotment))
    : phys;

  /* 已占用：在住房间数 + 已排房预订间数（不重复扣同一间房） */
  const occupied = one(
    `SELECT COUNT(DISTINCT r.id) AS c
       FROM rooms r
      WHERE r.hotel_id = ? AND r.room_type_id = ?
        AND (r.status IN ('OC','OD')
             OR EXISTS (SELECT 1 FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
                         WHERE br.room_id = r.id AND b.status IN ('PENDING','CONFIRMED')))`,
    [hotelId, roomTypeId]
  ).c;

  return Math.max(0, cap - occupied);
}

console.log(`测试库：${tmpDb}`);
console.log(`营业日：${today}`);
console.log(`\n=== 0. 生产代码语义断言（防漂移）===\n`);

/* ─────────── 0. 源码断言：确认生产代码用的是「上限收紧」语义 ─────────── */
{
  const fs = await import("node:fs");
  const srcText = fs.readFileSync(join(root, "src", "lib", "room-stock.ts"), "utf8");

  check(
    "room-stock.ts 用 Math.min 收紧 allotment（不是相加/取大）",
    /Math\.min\([^)]*allotment/i.test(srcText) || /allotment[^\n]{0,80}Math\.min/i.test(srcText),
    "源码里没找到 min(物理上限, allotment) 的写法"
  );
  check(
    "room-stock.ts 注释声明「只当上限收紧，不用于放量」",
    /上限/.test(srcText) && /收紧|不外扩|放量/.test(srcText),
    "注释里没有明确的上限/收紧声明"
  );
  check(
    "room-stock.ts 扣除了在住与预订",
    /OC|OD|INHOUSE/.test(srcText) && /booking_rooms|预订/.test(srcText),
    "没看到在住/预订的扣减"
  );
}

/* ─────────── 1. 造测试酒店：1 个房型 6 间房 ─────────── */
console.log(`\n=== 1. 造测试酒店（6 间房）===\n`);

db.exec("BEGIN");
try {
  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?, 'T-ALLOT', 'allotment测试店', datetime('now'))`, [
    TEST_HOTEL,
  ]);
  const rt = one(
    `SELECT id FROM room_types WHERE hotel_id = 1 ORDER BY id LIMIT 1`
  );
  const rtId = rt?.id ?? 1;

  /* 用现有的 room_types 复制一个到测试酒店（避免列约束问题） */
  const rtRow = one(`SELECT * FROM room_types WHERE id = ?`, [rtId]);
  const cols = Object.keys(rtRow);
  const values = cols.map((c) => (c === "id" ? null : c === "hotel_id" ? TEST_HOTEL : rtRow[c]));
  run(
    `INSERT INTO room_types (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    values
  );
  const newRtId = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [TEST_HOTEL]).id;

  for (let i = 1; i <= 6; i++) {
    run(`INSERT INTO rooms (hotel_id, room_no, room_type_id, status) VALUES (?, ?, ?, 'VC')`, [
      TEST_HOTEL,
      `T${i}`,
      newRtId,
    ]);
  }
  db.exec("COMMIT");
  globalThis.__testRtId = newRtId;
} catch (e) {
  db.exec("ROLLBACK");
  console.error("造测试数据失败：", e.message);
  process.exit(1);
}

const rtId = globalThis.__testRtId;
const roomCount = one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [TEST_HOTEL, rtId]).c;
check("造了 6 间房", roomCount === 6, `实际 ${roomCount}`);

/* ─────────── 2. 四种 allotment 情况 ─────────── */
console.log(`\n=== 2. 四种 allotment 情况 ===\n`);

/* 2a. allotment = NULL（没配）→ 用物理上限 6 */
db.exec("BEGIN");
run(`DELETE FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
db.exec("COMMIT");
let s = sellableFor(rtId, TEST_HOTEL, today);
check("allotment = NULL → 可售 = 物理上限 6", s === 6, `实际 ${s}`);

/* 2b. allotment = 2（小于物理上限）→ 收紧到 2 */
db.exec("BEGIN");
run(
  `INSERT INTO rate_calendar (hotel_id, room_type_id, date, allotment) VALUES (?,?,?,2)`,
  [TEST_HOTEL, rtId, today]
);
db.exec("COMMIT");
s = sellableFor(rtId, TEST_HOTEL, today);
check("allotment = 2 → 可售 = 2（收紧）", s === 2, `实际 ${s}`);

/* 2c. allotment = 10（大于物理上限）→ 不外扩，仍是 6 */
db.exec("BEGIN");
run(`UPDATE rate_calendar SET allotment = 10 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [
  TEST_HOTEL,
  rtId,
  today,
]);
db.exec("COMMIT");
s = sellableFor(rtId, TEST_HOTEL, today);
check("allotment = 10 → 可售 = 6（不超物理上限）", s === 6, `实际 ${s}`);

/* 2d. allotment = 0 → 全部关房 */
db.exec("BEGIN");
run(`UPDATE rate_calendar SET allotment = 0 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [
  TEST_HOTEL,
  rtId,
  today,
]);
db.exec("COMMIT");
s = sellableFor(rtId, TEST_HOTEL, today);
check("allotment = 0 → 可售 = 0（全部关房）", s === 0, `实际 ${s}`);

/* ─────────── 3. 有在住/预订时继续扣减 ─────────── */
console.log(`\n=== 3. allotment 与占用叠加 ===\n`);

/* 恢复 allotment = 4，造 1 间在住 → 可售 3 */
db.exec("BEGIN");
run(`UPDATE rate_calendar SET allotment = 4 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [
  TEST_HOTEL,
  rtId,
  today,
]);
run(
  `UPDATE rooms SET status = 'OC' WHERE id = (SELECT id FROM rooms WHERE hotel_id = ? AND room_type_id = ? ORDER BY id LIMIT 1)`,
  [TEST_HOTEL, rtId]
);
db.exec("COMMIT");
s = sellableFor(rtId, TEST_HOTEL, today);
check("allotment = 4、1 间在住 → 可售 = 3", s === 3, `实际 ${s}`);

/* 造 1 张已排房预订 → 可售 2 */
db.exec("BEGIN");
const freeRoom = one(
  `SELECT id FROM rooms WHERE hotel_id = ? AND room_type_id = ? AND status = 'VC' ORDER BY id LIMIT 1`,
  [TEST_HOTEL, rtId]
);
run(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, check_in_date, check_out_date,
     nights, room_count, guest_count, rate, status)
   VALUES (?, 'ALLOT-B1', '测试', ?, ?, ?, ?, 1,1,1,100,'CONFIRMED')`,
  [TEST_HOTEL, rtId, freeRoom.id, today, today]
);
const bk = one(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = 'ALLOT-B1'`, [TEST_HOTEL]);
run(
  `INSERT INTO booking_rooms (hotel_id, booking_id, room_id, room_type_id, rate, status)
   VALUES (?, ?, ?, ?, 100, 'ASSIGNED')`,
  [TEST_HOTEL, bk.id, freeRoom.id, rtId]
);
db.exec("COMMIT");
s = sellableFor(rtId, TEST_HOTEL, today);
check("再加 1 张已排房预订 → 可售 = 2", s === 2, `实际 ${s}`);

/* allotment 放大到 10，占用不变 → 仍按物理上限 6 − 2 = 4 */
db.exec("BEGIN");
run(`UPDATE rate_calendar SET allotment = 10 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [
  TEST_HOTEL,
  rtId,
  today,
]);
db.exec("COMMIT");
s = sellableFor(rtId, TEST_HOTEL, today);
check("allotment 放大到 10、占用 2 → 可售 = 4（不超物理 6）", s === 4, `实际 ${s}`);

/* ─────────── 4. 隔离性 ─────────── */
console.log(`\n=== 4. 多租户隔离 ===\n`);
const hotel1Affected = one(
  `SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = 1 AND room_type_id = ?`,
  [rtId]
).c;
check("测试酒店的房间没有污染 hotel 1", hotel1Affected === 0, `hotel 1 有 ${hotel1Affected} 间同房型房`);

const otherHotelAllot = one(
  `SELECT COUNT(*) AS c FROM rate_calendar WHERE hotel_id = 1 AND room_type_id = ? AND date = ?`,
  [rtId, today]
).c;
check("测试酒店的 allotment 没有写进 hotel 1", otherHotelAllot === 0);

/* ─────────── 清理 ─────────── */
db.exec("BEGIN");
run(`DELETE FROM booking_rooms WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM bookings WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM rate_calendar WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM rooms WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM room_types WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM hotels WHERE id = ?`, [TEST_HOTEL]);
db.exec("COMMIT");

db.close();
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
console.log(`\n⚠️ 注意：本测试只验证「代码与当前声明的上限语义一致」，`);
console.log(`   不证明这个语义是酒店想要的。清单要求业务确认后才能标记 OTA 房量同步完成。\n`);
process.exit(fail === 0 ? 0 : 1);
