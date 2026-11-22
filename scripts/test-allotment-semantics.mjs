/**
 * allotment 语义验收（codex 第七/第八/第九轮反复要求「业务确认」）
 *
 * ── 酒店确认的语义（2026-11-22）──
 *
 * `rate_calendar.allotment`（设置 → 房价日历「修改房量」）= **当天剩余可卖数量**。
 * 不是「渠道总放量上限」。
 *
 * 因此：
 *     物理可售 = 总房量 − 维修房(OOO) − 锁房(LOCK) − 在住 − 已排预订
 *     今日可售 = 配了 allotment ? min(物理可售, allotment) : 物理可售
 *
 * 关键点：allotment 是「剩余可卖」，所以它**不再从里面扣在住/预订** ——
 * 那是上一版（把它当"总放量上限"）的算法，会导致同一份占用被扣两次。
 *
 * 举例（6 间房、1 间在住）：
 *   · 物理可售 = 6 − 1 = 5
 *   · allotment = 4（酒店说"今天还能卖 4 间"）→ 今日可售 = min(5,4) = **4**
 *   · 旧算法（错）：cap = min(6,4) = 4，再扣 1 间在住 → 3（占用被扣两次）
 *
 * ── 这个测试怎么保证不漂移 ──
 *
 * **直接 import 生产代码 `src/lib/room-stock.ts` 的 `todayRoomTypeStock()`**，
 * 不是抄一份算式到测试里。
 *
 * 上一版就是抄了副本，而且抄成了旧语义（min 之后再扣占用），
 * 结果「测试全绿但和线上不一致」—— 这类漂移比没有测试更危险。
 *
 * 用法：node scripts/test-allotment-semantics.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync, copyFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDb = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const tmpDir = join(root, ".tmp");
const tmpDb = join(tmpDir, `allotment-${Date.now()}.db`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${extra ? `  ${extra}` : ""}`);
  }
};

function abandon(why, detail = "") {
  console.error(`\n❌ ${why}${detail ? `：${detail}` : ""}`);
  console.error(`\n排查清单（清单第 561-567 行要求，不能标记通过）：`);
  console.error(`  · PMS_DB_PATH 是否正确指向可读的库`);
  console.error(`  · .tmp 目录是否存在且可写`);
  console.error(`  · 是否残留 -wal / -shm 文件`);
  console.error(`  · 是否有其它进程持有写锁（database is locked / SQLITE_BUSY）`);
  process.exit(1);
}

if (!existsSync(srcDb)) abandon(`数据库不存在：${srcDb}`);
mkdirSync(tmpDir, { recursive: true });
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

try {
  copyFileSync(srcDb, tmpDb);
} catch (e) {
  abandon("复制副本库失败", String(e?.message ?? e));
}

/* 让 Node 解析 Next 的 `@/` 别名（与 test-room-stock-today.mjs 同一手法） */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

/* 关键：把生产代码的数据库连接换成副本（src/lib/db.ts 的 getDb 优先用它） */
const conn = new DatabaseSync(tmpDb);
conn.exec("PRAGMA busy_timeout = 5000");
globalThis.__pmsDb = conn;

let todayRoomTypeStock;
try {
  ({ todayRoomTypeStock } = await import("../src/lib/room-stock.ts"));
} catch (e) {
  abandon("import src/lib/room-stock.ts 失败", String(e?.message ?? e));
}

const one = (sql, p = []) => conn.prepare(sql).get(...p);
const all = (sql, p = []) => conn.prepare(sql).all(...p);
const run = (sql, p = []) => conn.prepare(sql).run(...p);

const today = one(`SELECT date('now','localtime') AS d`).d;
/* 住一晚：check_in = today、check_out = tomorrow（占用查询要求 check_out > day） */
const tomorrow = one(`SELECT date('now','localtime','+1 day') AS d`).d;
const TEST_HOTEL = 9999;

console.log(`测试库：${tmpDb}`);
console.log(`营业日：${today}`);
console.log(`口径：allotment = 当天剩余可卖数量（酒店 2026-11-22 确认）\n`);

/* ─────────── 1. 源码断言：确认实现是「先扣占用，再和 allotment 取小」 ─────────── */
console.log("=== 0. 生产实现断言（防漂移）===\n");
{
  const fs = await import("node:fs");
  const srcText = fs.readFileSync(join(root, "src", "lib", "room-stock.ts"), "utf8");

  check(
    "注释声明 allotment 语义是「当天剩余可卖数量」",
    /当天剩余可卖|剩余可卖数量/.test(srcText),
    "注释里没写清语义"
  );
  check(
    "算式是 min(物理可售, allotment)，不是 min(物理上限, allotment) − 占用",
    /Math\.min\(\s*physicalSellable\s*,\s*Math\.max\(\s*0\s*,\s*allotment\s*\)\s*\)/.test(srcText) ||
      /Math\.min\(\s*physicalSellable\s*,\s*allotment\s*\)/.test(srcText),
    "没找到 min(physicalSellable, allotment) 的写法"
  );
  check(
    "physicalSellable 已经扣掉了在住与预订（allotment 不再重复扣）",
    /physicalSellable/.test(srcText) && /INHOUSE|在住/.test(srcText) && /booking|预订/.test(srcText)
  );
}

/* ─────────── 2. 造测试房型：6 间房 ─────────── */
console.log(`\n=== 1. 造测试酒店（6 间房）===\n`);

conn.exec("BEGIN");
let rtId;
try {
  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?, 'T-ALLOT2', 'allotment测试店B', datetime('now'))`, [
    TEST_HOTEL,
  ]);
  const srcRt = one(`SELECT * FROM room_types WHERE hotel_id = 1 ORDER BY id LIMIT 1`);
  if (!srcRt) throw new Error("库里没有可复制的房型");
  const cols = Object.keys(srcRt);
  const values = cols.map((c) => (c === "id" ? null : c === "hotel_id" ? TEST_HOTEL : srcRt[c]));
  run(`INSERT INTO room_types (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, values);
  rtId = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [TEST_HOTEL]).id;

  for (let i = 1; i <= 6; i++) {
    run(`INSERT INTO rooms (hotel_id, room_no, room_type_id, status) VALUES (?, ?, ?, 'VC')`, [TEST_HOTEL, `AT${i}`, rtId]);
  }
  conn.exec("COMMIT");
} catch (e) {
  conn.exec("ROLLBACK");
  abandon("造测试数据失败", String(e?.message ?? e));
}

/** 读生产函数给出的今日可售 */
function sellableNow() {
  const rows = todayRoomTypeStock(TEST_HOTEL, today);
  const hit = rows.find((r) => Number(r.id ?? r.roomTypeId) === Number(rtId));
  return hit ? Number(hit.count ?? hit.sellable) : null;
}

const roomCount = one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [TEST_HOTEL, rtId]).c;
check("造了 6 间房", roomCount === 6, `实际 ${roomCount}`);

/* ─────────── 3. 四种 allotment 情况（无占用） ─────────── */
console.log(`\n=== 2. 四种 allotment（无占用，物理可售 6）===\n`);

run(`DELETE FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check("allotment = NULL → 可售 = 6", sellableNow() === 6, `实际 ${sellableNow()}`);

run(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, allotment) VALUES (?,?,?,2)`, [TEST_HOTEL, rtId, today]);
check("allotment = 2 → 可售 = 2（剩余可卖 2 间）", sellableNow() === 2, `实际 ${sellableNow()}`);

run(`UPDATE rate_calendar SET allotment = 10 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check("allotment = 10 → 可售 = 6（不超物理可售）", sellableNow() === 6, `实际 ${sellableNow()}`);

run(`UPDATE rate_calendar SET allotment = 0 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check("allotment = 0 → 可售 = 0（全部关房）", sellableNow() === 0, `实际 ${sellableNow()}`);

/* ─────────── 4. 有占用时：allotment 不再二次扣减（核心语义） ─────────── */
console.log(`\n=== 3. 有占用时 allotment 是「剩余」不是「上限」 ===\n`);

/* 造 1 间在住 → 物理可售 5 */
run(`UPDATE rooms SET status = 'OC' WHERE id = (SELECT id FROM rooms WHERE hotel_id = ? AND room_type_id = ? ORDER BY id LIMIT 1)`, [
  TEST_HOTEL,
  rtId,
]);

run(`UPDATE rate_calendar SET allotment = 4 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check(
  "物理可售 5（6 − 1 在住）、allotment = 4 → 可售 = 4（不是 3，占用不重复扣）",
  sellableNow() === 4,
  `实际 ${sellableNow()}`
);

run(`UPDATE rate_calendar SET allotment = 10 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check("allotment 放大到 10 → 可售 = 5（按物理可售封顶）", sellableNow() === 5, `实际 ${sellableNow()}`);

run(`UPDATE rate_calendar SET allotment = NULL WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check("allotment 清空 → 可售 = 5（回到物理可售）", sellableNow() === 5, `实际 ${sellableNow()}`);

/* ─────────── 5. 再加预订 → 物理可售继续降 ─────────── */
console.log(`\n=== 4. 加已排房预订 ===\n`);

const freeRoom = one(
  `SELECT id FROM rooms WHERE hotel_id = ? AND room_type_id = ? AND status = 'VC' ORDER BY id LIMIT 1`,
  [TEST_HOTEL, rtId]
);
run(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, check_in_date, check_out_date,
     nights, room_count, guest_count, rate, status)
   VALUES (?, 'AT-B1', '测试', ?, ?, ?, ?, 1,1,1,100,'CONFIRMED')`,
  [TEST_HOTEL, rtId, freeRoom.id, today, today]
);
const bk = one(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = 'AT-B1'`, [TEST_HOTEL]);
/*
 * ⚠️ booking_rooms 必须带 check_in_date / check_out_date
 *
 * 生产函数（room-stock.ts:192-198）按
 *     br.check_in_date <= day AND br.check_out_date > day
 * 判断这一间是否在目标营业日被占用。
 * 只插 room_id 不插日期的话两个字段是 NULL，NULL 比较恒为假 →
 * 这条明细永远不算占用（我在第一版就踩了这个坑，测试报"加了预订可售没变"）。
 */
run(
  `INSERT INTO booking_rooms (hotel_id, booking_id, room_id, room_type_id, rate, status, check_in_date, check_out_date)
   VALUES (?, ?, ?, ?, 100, 'PENDING', ?, ?)`,
  [TEST_HOTEL, bk.id, freeRoom.id, rtId, today, tomorrow]
);

check("加 1 张已排房预订 → 物理可售 4", sellableNow() === 4, `实际 ${sellableNow()}`);

run(`UPDATE rate_calendar SET allotment = 2 WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
check(
  "物理可售 4、allotment = 2 → 可售 = 2（取小，占用不二次扣）",
  sellableNow() === 2,
  `实际 ${sellableNow()}`
);

/* ─────────── 6. OOO / LOCK 继续扣 ─────────── */
console.log(`\n=== 5. 维修房 / 锁房 ===\n`);

/*
     * 先清掉第 4 节的预订，单独测 OOO/LOCK
     *
     * 不清的话：那间房被改成 OOO 后，occupancy 查询会命中它，
     * physicalsSellable 里 booked 会被 blockedRooms 跳过（正确行为：不重复扣），
     * 于是「加 OOO 可售少 1」这条断言就分不清是 OOO 生效还是预订被跳过。
     */
run(`DELETE FROM booking_rooms WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM bookings WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`UPDATE rate_calendar SET allotment = NULL WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [TEST_HOTEL, rtId, today]);
run(
  `UPDATE rooms SET status = 'OOO' WHERE id = (SELECT id FROM rooms WHERE hotel_id = ? AND room_type_id = ? AND status = 'VC' ORDER BY id LIMIT 1)`,
  [TEST_HOTEL, rtId]
);
check("1 在住 + 1 维修 → 可售 = 4（6−1−1）", sellableNow() === 4, `实际 ${sellableNow()}`);

run(
  `UPDATE rooms SET status = 'LOCK' WHERE id = (SELECT id FROM rooms WHERE hotel_id = ? AND room_type_id = ? AND status = 'VC' ORDER BY id LIMIT 1)`,
  [TEST_HOTEL, rtId]
);
check("再加 1 锁房 → 可售 = 3（6−1−1−1）", sellableNow() === 3, `实际 ${sellableNow()}`);

/* ─────────── 7. 多租户隔离 ─────────── */
console.log(`\n=== 6. 多租户隔离 ===\n`);
const polluted = one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = 1 AND room_type_id = ?`, [rtId]).c;
check("测试酒店的房间没有污染 hotel 1", polluted === 0, `hotel 1 有 ${polluted} 间`);

const otherRate = one(
  `SELECT COUNT(*) AS c FROM rate_calendar WHERE hotel_id = 1 AND room_type_id = ? AND date = ?`,
  [rtId, today]
).c;
check("测试酒店的 allotment 没有写进 hotel 1", otherRate === 0);

/* ─────────── 清理 ─────────── */
conn.exec("BEGIN");
run(`DELETE FROM booking_rooms WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM bookings WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM rate_calendar WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM rooms WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM room_types WHERE hotel_id = ?`, [TEST_HOTEL]);
run(`DELETE FROM hotels WHERE id = ?`, [TEST_HOTEL]);
conn.exec("COMMIT");

conn.close();
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
console.log(`\n口径已确认（2026-11-22 酒店确认）：allotment = 当天剩余可卖数量。`);
console.log(`实现 = min(物理可售, allotment)，物理可售已扣在住/预订/维修/锁房，allotment 不再二次扣。`);
console.log(`（本测试直接 import 生产函数 todayRoomTypeStock()，不是抄副本）\n`);
process.exit(fail === 0 ? 0 : 1);
