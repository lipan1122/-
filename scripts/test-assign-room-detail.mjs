#!/usr/bin/env node
/**
 * 多房订单「逐明细排房」验收（本轮修复：主单已填首间的订单排不了剩余间）
 *
 * ── 缺陷背景 ──
 * 远期房态「引入待排房订单」弹窗已经改成明细级（一行 = 一间待分房），
 * 但 `rooms/forecast/actions.ts` 的 assignRoomsAction 只认「主单 room_id 为空」的订单：
 *     AND (room_id IS NULL OR room_id = 0)
 * 于是 BK-MULTI3（room_count=3、主单 room_id=8201、明细 3 行：1 已排 + 2 待排）
 * 在弹窗里能看到 2 间待分房，却一间也排不了 —— 硬塞候选房整批报错回滚，
 * 连带同批其他订单也排不进去。
 *
 * ── 本脚本验什么（断言全部落在**库的真实最终状态**上）──
 *   A 源码口径：不再要求主单 room_id 为空 / 有明细级入参 / 事务 + 乐观锁 / 四来源冲突
 *   B BK-MULTI3 真数据：一次给第 2、3 间排房 → 明细各落各的房、room_count 不变、stay_id 不被污染
 *   C 重复排房与整批回滚：其他订单占房 → 拒；一批里第二行冲突 → 第一行也回滚；本单另一间复用同一间房 → 拒
 *   D 房型约束：明细级跨房型 → 拒；主单级仍按老口径允许「升级排房」
 *   E 状态约束：CHECKED_IN 的明细跳过，不写库、不算失败；混合批正常那间照常落库
 *   F 跨酒店隔离：A 店身份排 B 店的房 / B 店身份排 A 店的房与单 → 全部拒绝，同店自己排房正常
 *   G 弹窗侧：候选房 SQL 覆盖「主单已填首间」的多房订单，且不把自己已排的房列进来；
 *             提交时按明细级带 bookingRoomId；明细行只列同房型候选房
 *   H 主单级老行为：主单未排房 + 有明细的订单仍能按老方式落到第一条待排明细；无明细老单会补一条；
 *                   已排满再加房明确拒绝
 *
 * ── 怎么做到「验真代码而不是抄一份 SQL」──
 *   1. `VACUUM INTO` 把 data/pms.db 复制到 .tmp/（每个场景一份干净副本，真库全程只读）；
 *   2. 注入 `globalThis.__pmsDb`（src/lib/db.ts 的 getDb() 优先返回它），
 *      再用 registerHooks 把 `next/cache`、`@/lib/session` 换成桩 ——
 *      于是脚本调用的是**生产代码 assignRoomsAction 本身**（含 tx / 冲突校验 / 乐观锁）；
 *   3. 断言直接查副本库的最终状态，不看返回值自说自话。
 *
 * 用法：node scripts/test-assign-room-detail.mjs
 * 环境：Node ≥ 22.18（原生剥离 TS 类型）+ module.registerHooks 解析 `@/` 别名。
 */
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const TAG = "assign-room-detail";
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = path.join(ROOT, ".tmp", TAG);
const HOTEL = 1; // 演示库唯一酒店
const OTHER_HOTEL = 998; // 跨店隔离用的测试酒店（只活在副本里）

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

function abandon(message, detail = "") {
  console.error(`\n❌ 测试无法执行：${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/* ============================================================ 副本库管理 */

const copies = [];
let conn = null;

function openCopy(tag) {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.accessSync(TMP_DIR, fs.constants.W_OK);
  } catch (e) {
    abandon(`临时目录不可写：${TMP_DIR}`, String(e?.message ?? e));
  }
  const file = path.join(TMP_DIR, `${tag}-${Date.now()}.db`);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 不存在 */
    }
  }
  let src;
  try {
    src = new DatabaseSync(REAL_DB, { readOnly: true });
    src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch (e) {
    abandon(`VACUUM INTO 失败：${REAL_DB} → ${file}`, String(e?.message ?? e));
  } finally {
    try {
      src?.close();
    } catch {
      /* 已关闭 */
    }
  }
  if (!fs.existsSync(file)) abandon("VACUUM INTO 后副本不存在（磁盘满 / 无权限？）");
  copies.push(file);
  try {
    conn?.close();
  } catch {
    /* 已关闭 */
  }
  conn = new DatabaseSync(file);
  conn.exec("PRAGMA busy_timeout = 5000");
  globalThis.__pmsDb = conn; // 让生产代码 lib/db.ts 用这份副本
  return conn;
}

function cleanup() {
  try {
    conn?.close();
  } catch {
    /* 已关闭 */
  }
  for (const file of copies) {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
}
process.on("exit", cleanup);
process.on("uncaughtException", (e) => {
  console.error("脚本异常：", e);
  process.exitCode = 1;
});

/* ============================================================ 载入生产代码 */

/* 桩：requirePermission 按 globalThis.__testHotelId 返回当前身份（跨酒店隔离要用它切店） */
const sessionStub =
  "data:text/javascript," +
  encodeURIComponent(
    `export async function requirePermission(){ return { id: 1, hotelId: globalThis.__testHotelId ?? 1, realName: "验收员", username: "tester" }; }`
  );
const cacheStub = "data:text/javascript," + encodeURIComponent("export function revalidatePath(){}");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/cache") return { url: cacheStub, format: "module", shortCircuit: true };
    if (specifier === "@/lib/session") return { url: sessionStub, format: "module", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

globalThis.__testHotelId = HOTEL;
openCopy("boot");

let assignRoomsAction;
try {
  ({ assignRoomsAction } = await import("../src/app/(main)/rooms/forecast/actions.ts"));
} catch (e) {
  abandon("import rooms/forecast/actions.ts 失败", String(e?.stack ?? e));
}

/* ============================================================ 工具 */

const q = (sql, params = []) => conn.prepare(sql).all(...params);
const one = (sql, params = []) => conn.prepare(sql).get(...params);
const exec = (sql, params = []) => conn.prepare(sql).run(...params);
const NOW = new Date().toISOString();

/** 以指定身份调用真实 action（rows 数组 → FormData） */
async function assign(hotelId, rows) {
  globalThis.__testHotelId = hotelId;
  const fd = new FormData();
  fd.set("rows", JSON.stringify(rows));
  const res = await assignRoomsAction(fd);
  globalThis.__testHotelId = HOTEL;
  return res;
}

const SRC = (rel) => fs.readFileSync(path.join(ROOT, "src", rel), "utf8");
const forecastSrc = SRC(path.join("app", "(main)", "rooms", "forecast", "actions.ts"));
const forecastPageSrc = SRC(path.join("app", "(main)", "rooms", "forecast", "page.tsx"));
const dialogSrc = SRC(path.join("components", "AssignRoomDialog.tsx"));

/** 房间在区间内是否真的可排（与 action 同口径的三来源） */
function isFree(roomId, from, to, hotelId = HOTEL) {
  const stay = one(
    `SELECT 1 AS c FROM stays
      WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE'
        AND substr(check_in_time, 1, 10) < ?
        AND (expect_check_out IS NULL OR expect_check_out > ?)`,
    [hotelId, roomId, to, from]
  );
  const bk = one(
    `SELECT 1 AS c FROM bookings
      WHERE hotel_id = ? AND room_id = ? AND status IN ('PENDING','CONFIRMED','CHECKED_IN')
        AND check_in_date < ? AND check_out_date > ?`,
    [hotelId, roomId, to, from]
  );
  const br = one(
    `SELECT 1 AS c FROM booking_rooms
      WHERE hotel_id = ? AND room_id = ? AND status IN ('CONFIRMED','CHECKED_IN')
        AND check_in_date < ? AND check_out_date > ?`,
    [hotelId, roomId, to, from]
  );
  return !stay && !bk && !br;
}

/** 挑一间「指定房型 + 该区间真的空」的房间；mode='other' 表示房型 != 1 */
function pickFreeRoom(from, to, { typeId = null, otherType = false, used = new Set() } = {}) {
  const rooms = q(
    `SELECT id, room_no, room_type_id FROM rooms
      WHERE hotel_id = ? AND status IN ('VC','VD')
      ORDER BY room_no`,
    [HOTEL]
  );
  return rooms.find(
    (r) =>
      !used.has(r.id) &&
      (otherType ? r.room_type_id !== 1 : typeId === null || r.room_type_id === typeId) &&
      isFree(r.id, from, to)
  );
}

/* ============================================================ A. 源码口径 */

console.log("=== A. 源码口径（assignRoomsAction）===");
/* 只检查**代码里的订单查询**，不检查注释里引用的旧条件（注释要留着解释为什么改） */
const bookingSqlMatch = forecastSrc.match(/const BOOKING_SQL = `([\s\S]*?)`;/);
check(
  "A1 订单查询不再按「主单 room_id 为空」过滤",
  !!bookingSqlMatch && !/room_id IS NULL|room_id = 0/.test(bookingSqlMatch[1]),
  bookingSqlMatch ? bookingSqlMatch[1].replace(/\s+/g, " ") : "找不到 BOOKING_SQL"
);
check(
  "A2 支持明细级入参 bookingRoomId",
  /bookingRoomId/.test(forecastSrc) &&
    /bookingRoomId: Math\.max\(0, toInt\(row\.bookingRoomId\)\)/.test(forecastSrc)
);
check(
  "A3 支持「房型 + 序号」定位明细",
  /roomTypeId/.test(forecastSrc) &&
    /unitIndex/.test(forecastSrc) &&
    /details\[pair\.unitIndex - 1\]/.test(forecastSrc)
);
check(
  "A4 明细级房型必须与候选房一致（跨房型直接拒）",
  /逐明细排房不能跨房型/.test(forecastSrc) && /room\.room_type_id !== wantTypeId/.test(forecastSrc)
);
check(
  "A5 只处理 PENDING / CONFIRMED，其余跳过（skip 而非硬写）",
  /status === "PENDING" \|\| status === "CONFIRMED"/.test(forecastSrc) &&
    /skippedCount/.test(forecastSrc) &&
    /CHECKED_IN/.test(forecastSrc)
);
check(
  "A6 四来源冲突校验都在 tx 内（含本单其他明细）",
  forecastSrc.indexOf("FROM stays") > forecastSrc.indexOf("tx(() => {") &&
    forecastSrc.indexOf("FROM bookings o") > 0 &&
    forecastSrc.indexOf("FROM booking_rooms br") > 0 &&
    /selfClash/.test(forecastSrc) &&
    /已经排给本订单的另一间明细/.test(forecastSrc)
);
check(
  "A7 乐观锁占位 + changes 判定保留",
  forecastSrc.includes(
    "UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')"
  ) && forecastSrc.includes("lock.changes === 0")
);
check(
  "A8 写明细只写指定一行，且带 hotel_id",
  forecastSrc.includes("UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED' WHERE id = ? AND hotel_id = ?")
);
check(
  "A9 明说不动 room_count、不碰 stay_id（stay 关联靠入住回填）",
  !/SET[\s\S]{0,160}room_count = \?/.test(forecastSrc) && /不碰 stay_id/.test(forecastSrc)
);

/* ============================================================ G. 弹窗侧 */

console.log("\n=== G. 弹窗侧（候选房 / 明细级提交）===");
const optIdx = forecastPageSrc.indexOf("const optionRows");
const backtick1 = forecastPageSrc.indexOf("`", optIdx);
const backtick2 = forecastPageSrc.indexOf("`", backtick1 + 1);
const OPTION_SQL = backtick1 > 0 && backtick2 > backtick1 ? forecastPageSrc.slice(backtick1 + 1, backtick2) : "";
const optionRegion =
  optIdx >= 0 ? forecastPageSrc.slice(optIdx, forecastPageSrc.indexOf("const roomsByBooking")) : "";

check(
  "G1 候选房 SQL 不再只给「主单 room_id 为空」的订单",
  !!optionRegion && !/b\.room_id IS NULL OR b\.room_id = 0/.test(optionRegion)
);
check("G2 候选房 SQL 按「还有未排明细」出房（pd.room_id IS NULL）", /pd\.room_id IS NULL/.test(optionRegion));
check(
  "G3 候选房 SQL 排除本单已排的房（明细占用不再 JOIN 对方主单状态）",
  /br\.room_id = r\.id/.test(optionRegion) && !/ob\.status IN/.test(optionRegion)
);
check(
  "G4 页面把明细 id 传给弹窗（detailId）",
  /detailId: u\.detailId/.test(forecastPageSrc) && /detailId\?: number \| null/.test(dialogSrc)
);
check(
  "G5 弹窗提交时按明细级带 bookingRoomId",
  /row\.bookingRoomId = b\.detailId as number/.test(dialogSrc) && /isDetailRow/.test(dialogSrc)
);
check(
  "G6 明细行只列同房型候选房（避免选了必报错）",
  /roomOptionsFor/.test(dialogSrc) && /r\.roomTypeId === b\.roomTypeId/.test(dialogSrc)
);

/** 用页面里那条候选房 SQL 现算某订单的候选房（不抄 SQL） */
function candidateRooms(bookingId) {
  if (!OPTION_SQL) return [];
  return q(OPTION_SQL, [HOTEL]).filter((r) => r.booking_id === bookingId);
}

/* ============================================================ B. BK-MULTI3 真数据 */

console.log("\n=== B. BK-MULTI3 真数据 · 逐明细排房 ===");
openCopy("bk-multi3");
const bk3 = one(
  `SELECT id, room_id, room_count, status, check_in_date, check_out_date
     FROM bookings WHERE hotel_id = ? AND booking_no = 'BK-MULTI3'`,
  [HOTEL]
);
if (!bk3) abandon("副本里找不到 BK-MULTI3（演示数据缺失？）");
const details3 = q(
  `SELECT id, room_id, status, stay_id FROM booking_rooms
    WHERE hotel_id = ? AND booking_id = ? ORDER BY id`,
  [HOTEL, bk3.id]
);
check(
  "B1 改前形态：主单已填首间 + 3 条明细（1 已排 / 2 待排）",
  bk3.room_id !== null &&
    bk3.room_id > 0 &&
    bk3.room_count === 3 &&
    details3.length === 3 &&
    details3.filter((d) => d.room_id === null).length === 2,
  `room_id=${bk3.room_id} room_count=${bk3.room_count} details=${JSON.stringify(details3)}`
);

const cand = candidateRooms(bk3.id);
check("B2 弹窗候选房：主单已填首间的多房订单也有候选房", cand.length > 0, `候选 ${cand.length} 间`);
/* 本单已排的房号（首间那张）不能出现在自己的候选列表里 —— 否则一选就撞占房唯一索引 */
const assignedRoomNo =
  one(`SELECT room_no FROM rooms WHERE id = ? AND hotel_id = ?`, [bk3.room_id, HOTEL])?.room_no ?? "";
check(
  `B3 候选房里不含本单自己已排的首间（${assignedRoomNo}）`,
  !!assignedRoomNo && !cand.some((r) => r.room_no === assignedRoomNo),
  JSON.stringify(cand.map((r) => r.room_no))
);

const pending3 = details3.filter((d) => d.room_id === null);
const [roomA, roomB] = cand;
const resB = await assign(HOTEL, [
  { bookingId: bk3.id, roomId: roomA.room_id, bookingRoomId: pending3[0].id },
  { bookingId: bk3.id, roomId: roomB.room_id, bookingRoomId: pending3[1].id },
]);
check("B4 一次提交第 2、3 间 → 成功（不再整批报错）", resB.ok === true && resB.savedCount === 2, JSON.stringify(resB));

const after3 = q(
  `SELECT id, room_id, status, stay_id FROM booking_rooms
    WHERE hotel_id = ? AND booking_id = ? ORDER BY id`,
  [HOTEL, bk3.id]
);
const afterBk = one(`SELECT room_id, room_count, status FROM bookings WHERE id = ? AND hotel_id = ?`, [
  bk3.id,
  HOTEL,
]);
check(
  `B5 第 2 间明细落库正确（#${pending3[0].id} → ${roomA.room_no}）`,
  after3.find((d) => d.id === pending3[0].id)?.room_id === roomA.room_id &&
    after3.find((d) => d.id === pending3[0].id)?.status === "CONFIRMED"
);
check(
  `B6 第 3 间明细落库正确（#${pending3[1].id} → ${roomB.room_no}）`,
  after3.find((d) => d.id === pending3[1].id)?.room_id === roomB.room_id &&
    after3.find((d) => d.id === pending3[1].id)?.status === "CONFIRMED"
);
check("B7 bookings.room_count 不变（仍是 3）", afterBk.room_count === 3, String(afterBk.room_count));
check("B8 主单 room_id 仍是首间 8201（COALESCE 未被覆盖）", afterBk.room_id === 1, String(afterBk.room_id));
check("B9 主单状态 → CONFIRMED（3 间全部排满）", afterBk.status === "CONFIRMED", afterBk.status);
check(
  "B10 排房不写 stay_id（3 行仍为 NULL，留给入住回填）",
  after3.every((d) => d.stay_id === null),
  JSON.stringify(after3.map((d) => d.stay_id))
);
check(
  "B11 入住回填能按「booking_id + room_id + stay_id IS NULL」逐间命中",
  [roomA.room_id, roomB.room_id].every(
    (rid) =>
      q(
        `SELECT id FROM booking_rooms
          WHERE hotel_id = ? AND booking_id = ? AND room_id = ? AND stay_id IS NULL`,
        [HOTEL, bk3.id, rid]
      ).length === 1
  )
);
check(
  "B12 待排明细清零（房态页「待分房」口径归零）",
  one(
    `SELECT COUNT(*) AS c FROM booking_rooms
      WHERE hotel_id = ? AND booking_id = ? AND (room_id IS NULL OR room_id = 0)
        AND status IN ('PENDING','CONFIRMED')`,
    [HOTEL, bk3.id]
  ).c === 0
);

/* ============================================================ C. 重复排房 / 整批回滚 */

console.log("\n=== C. 重复排房与整批回滚 ===");
openCopy("conflict");
const bk3c = one(
  `SELECT id, check_in_date, check_out_date FROM bookings WHERE hotel_id = ? AND booking_no = 'BK-MULTI3'`,
  [HOTEL]
);
const detc = q(
  `SELECT id FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL ORDER BY id`,
  [HOTEL, bk3c.id]
);
const candC = candidateRooms(bk3c.id);
const occupiedRoom = candC[0];
const freeRoom = candC[1];
const freeRoom2 = candC[2];

/* 造「另一张单已经占了 occupiedRoom」：主单镜像 + 明细都写，模拟真实占用 */
const otherId = Number(
  exec(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, room_count, rate,
        check_in_date, check_out_date, nights, status, created_at, updated_at)
     VALUES (?,?,'占房客',1,?,1,300,?,?,2,'CONFIRMED',?,?)`,
    [HOTEL, "BK-OCCUPY-TEST", occupiedRoom.room_id, bk3c.check_in_date, bk3c.check_out_date, NOW, NOW]
  ).lastInsertRowid
);
exec(
  `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
      check_in_date, check_out_date, created_at)
   VALUES (?,?,1,?,'占房客',300,'CONFIRMED',?,?,?)`,
  [HOTEL, otherId, occupiedRoom.room_id, bk3c.check_in_date, bk3c.check_out_date, NOW]
);

const resC1 = await assign(HOTEL, [
  { bookingId: bk3c.id, roomId: occupiedRoom.room_id, bookingRoomId: detc[0].id },
]);
check(
  "C1 同一间房已被其他订单占用 → 拒绝",
  !!resC1.error && /已被其他订单/.test(resC1.error),
  JSON.stringify(resC1)
);
check(
  "C2 被拒后该明细未写库",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [detc[0].id, HOTEL]).room_id === null
);

/* 整批回滚：第 1 行合法（会写库）+ 第 2 行冲突（抛错）→ 合法的也必须回滚 */
const resC3 = await assign(HOTEL, [
  { bookingId: bk3c.id, roomId: freeRoom.room_id, bookingRoomId: detc[0].id },
  { bookingId: bk3c.id, roomId: occupiedRoom.room_id, bookingRoomId: detc[1].id },
]);
check("C3 一批里第二行冲突 → 整批报错", !!resC3.error, JSON.stringify(resC3));
check(
  "C4 第一行（合法）也被回滚：第 2 间仍待排",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [detc[0].id, HOTEL]).room_id === null
);
check(
  "C5 第二行也没落库，本单已排仍只有首间",
  one(
    `SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NOT NULL`,
    [HOTEL, bk3c.id]
  ).c === 1
);

/* 本单另一间复用同一间房 → 必须给出人话，而不是 UNIQUE 崩溃 */
const resC6 = await assign(HOTEL, [{ bookingId: bk3c.id, roomId: freeRoom.room_id, bookingRoomId: detc[0].id }]);
check("C6 空房排给第 2 间 → 成功", resC6.ok === true && resC6.savedCount === 1, JSON.stringify(resC6));
const resC7 = await assign(HOTEL, [{ bookingId: bk3c.id, roomId: freeRoom.room_id, bookingRoomId: detc[1].id }]);
check(
  "C7 本单另一间再排同一间房 → 拒绝（不再撞 UNIQUE 报错）",
  !!resC7.error && /已经排给本订单的另一间明细/.test(resC7.error),
  JSON.stringify(resC7)
);
check(
  "C8 该次失败没有写库（第 3 间仍待排）",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [detc[1].id, HOTEL]).room_id === null
);

/* ============================================================ D. 房型约束 */

console.log("\n=== D. 房型约束 ===");
openCopy("room-type");
const bk3d = one(
  `SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = 'BK-MULTI3'`,
  [HOTEL]
);
const detd = q(
  `SELECT id FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL ORDER BY id`,
  [HOTEL, bk3d.id]
);
const otherTypeRoom = pickFreeRoom("2026-11-25", "2026-11-27", { otherType: true });
if (!otherTypeRoom) abandon("找不到异房型的空房，无法验证房型约束");
const resD1 = await assign(HOTEL, [
  { bookingId: bk3d.id, roomId: otherTypeRoom.id, bookingRoomId: detd[0].id },
]);
check(
  "D1 明细级跨房型排房 → 拒绝（房型必须一致）",
  !!resD1.error && /不能跨房型/.test(resD1.error),
  JSON.stringify(resD1)
);
check(
  "D2 被拒后明细未写库",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [detd[0].id, HOTEL]).room_id === null
);

/* 主单级老口径：跨房型视为升级，仍允许（不能因为本次改动把它一起砍掉） */
const legacyId = Number(
  exec(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, room_count, rate,
        check_in_date, check_out_date, nights, status, created_at, updated_at)
     VALUES (?,?,'老单升级客',1,NULL,1,300,'2031-06-01','2031-06-03',2,'PENDING',?,?)`,
    [HOTEL, "BK-UPGRADE-LEGACY", NOW, NOW]
  ).lastInsertRowid
);
const upgradeRoom = pickFreeRoom("2031-06-01", "2031-06-03", { otherType: true });
if (!upgradeRoom) abandon("找不到 2031-06 期间可用的异房型空房");
const resD3 = await assign(HOTEL, [{ bookingId: legacyId, roomId: upgradeRoom.id }]);
check("D3 主单级仍允许升级排房（老行为保留）", resD3.ok === true && resD3.savedCount === 1, JSON.stringify(resD3));
const legacyDetail = one(
  `SELECT room_type_id, room_id, status FROM booking_rooms WHERE hotel_id = ? AND booking_id = ?`,
  [HOTEL, legacyId]
);
check(
  "D4 升级排房补的明细：房型仍记原预订房型，房号记升级后的房",
  legacyDetail.room_type_id === 1 && legacyDetail.room_id === upgradeRoom.id && legacyDetail.status === "CONFIRMED",
  JSON.stringify(legacyDetail)
);
check(
  "D5 升级排房写进操作日志（可追溯）",
  /升级房型/.test(one(`SELECT detail FROM op_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL])?.detail ?? "")
);

/* ============================================================ E. 状态约束（跳过） */

console.log("\n=== E. 状态约束（CHECKED_IN 跳过）===");
openCopy("status");
const bk3e = one(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = 'BK-MULTI3'`, [HOTEL]);
const dete = q(
  `SELECT id FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? ORDER BY id`,
  [HOTEL, bk3e.id]
);
const pendE = dete.slice(1, 3); // 第 2、3 间（dete[0] 是已排的首间）
const candE = candidateRooms(bk3e.id);
exec(`UPDATE booking_rooms SET room_id = ?, status = 'CHECKED_IN' WHERE id = ? AND hotel_id = ?`, [
  candE[2].room_id,
  pendE[1].id,
  HOTEL,
]);
const resE1 = await assign(HOTEL, [
  { bookingId: bk3e.id, roomId: candE[3].room_id, bookingRoomId: pendE[1].id },
]);
check(
  "E1 已 CHECKED_IN 的明细 → 跳过（不写库、不报「失败」）",
  !!resE1.error && /没有需要落库的排房/.test(resE1.error) && /已入住/.test(resE1.error),
  JSON.stringify(resE1)
);
check(
  "E2 已入住明细的房号没被改写",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [pendE[1].id, HOTEL]).room_id ===
    candE[2].room_id
);
check(
  "E3 被跳过后没有给本单多排一间（该房未挂到 BK-MULTI3 的任何明细）",
  one(
    `SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id = ?`,
    [HOTEL, bk3e.id, candE[3].room_id]
  ).c === 0
);

/* 混合：一间正常 + 一间已入住 → 正常的落库、已入住跳过 */
openCopy("status-mixed");
const bk3m = one(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = 'BK-MULTI3'`, [HOTEL]);
const detm = q(
  `SELECT id FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? ORDER BY id`,
  [HOTEL, bk3m.id]
);
const candM = candidateRooms(bk3m.id);
exec(`UPDATE booking_rooms SET room_id = ?, status = 'CHECKED_IN' WHERE id = ? AND hotel_id = ?`, [
  candM[3].room_id,
  detm[2].id,
  HOTEL,
]);
const resE4 = await assign(HOTEL, [
  { bookingId: bk3m.id, roomId: candM[0].room_id, bookingRoomId: detm[1].id },
  { bookingId: bk3m.id, roomId: candM[1].room_id, bookingRoomId: detm[2].id },
]);
check(
  "E4 混合批：正常那间落库、已入住那间跳过",
  resE4.ok === true && resE4.savedCount === 1 && resE4.skippedCount === 1,
  JSON.stringify(resE4)
);
check(
  "E5 正常那间真的写进去了",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [detm[1].id, HOTEL]).room_id ===
    candM[0].room_id
);

/* ============================================================ F. 跨酒店隔离 */

console.log("\n=== F. 跨酒店隔离 ===");
openCopy("tenant");
const bk3f = one(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = 'BK-MULTI3'`, [HOTEL]);
const detf = q(
  `SELECT id FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL ORDER BY id`,
  [HOTEL, bk3f.id]
);
const candF = candidateRooms(bk3f.id);

/* 造第二家店（998）：房型 + 房间 + 订单 + 明细 */
exec(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  OTHER_HOTEL,
  "TEST998",
  "隔离验收酒店",
  "测试地址",
  "000",
  NOW,
]);
const type998 = Number(
  exec(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort)
     VALUES (?,?,?,?,?,?,?)`,
    [OTHER_HOTEL, "T998", "隔离测试房型", "大床", 2, 200, 9001]
  ).lastInsertRowid
);
const room998 = Number(
  exec(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
    OTHER_HOTEL,
    "T-998-01",
    9,
    type998,
    "VC",
    1,
  ]).lastInsertRowid
);
const bk998 = Number(
  exec(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, room_count, rate,
        check_in_date, check_out_date, nights, status, created_at, updated_at)
     VALUES (?,?,'别店客人',?,NULL,1,200,'2026-11-25','2026-11-27',2,'PENDING',?,?)`,
    [OTHER_HOTEL, "BK-H998", type998, NOW, NOW]
  ).lastInsertRowid
);
const det998 = Number(
  exec(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
        check_in_date, check_out_date, created_at)
     VALUES (?,?,?,NULL,'别店客人',200,'PENDING','2026-11-25','2026-11-27',?)`,
    [OTHER_HOTEL, bk998, type998, NOW]
  ).lastInsertRowid
);

const resF1 = await assign(HOTEL, [{ bookingId: bk3f.id, roomId: room998, bookingRoomId: detf[0].id }]);
check(
  "F1 A 店身份排 B 店的房 → 拒绝（房间按 hotel_id 隔离）",
  !!resF1.error && /不是空净\/空脏房/.test(resF1.error),
  JSON.stringify(resF1)
);
check(
  "F2 A 店明细未被跨店写入",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [detf[0].id, HOTEL]).room_id === null
);

const resF3 = await assign(OTHER_HOTEL, [
  { bookingId: bk998, roomId: candF[0].room_id, bookingRoomId: det998 },
]);
check(
  "F3 B 店身份排 A 店的房 → 拒绝",
  !!resF3.error && /不是空净\/空脏房/.test(resF3.error),
  JSON.stringify(resF3)
);
check(
  "F4 B 店明细未被跨店写入",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [det998, OTHER_HOTEL]).room_id === null
);

const resF5 = await assign(OTHER_HOTEL, [{ bookingId: bk3f.id, roomId: room998 }]);
check("F5 B 店身份碰 A 店的订单 → 拒绝（订单按 hotel_id 隔离）", !!resF5.error, JSON.stringify(resF5));

const resF6 = await assign(OTHER_HOTEL, [{ bookingId: bk998, roomId: room998, bookingRoomId: det998 }]);
check(
  "F6 同一家店（998）自己排房 → 成功（证明拒绝是隔离生效而非数据坏）",
  resF6.ok === true,
  JSON.stringify(resF6)
);
check(
  "F7 998 的明细正确落库",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [det998, OTHER_HOTEL]).room_id === room998
);

/* ============================================================ H. 主单级老行为 */

console.log("\n=== H. 主单级老行为（不能退化）===");
openCopy("legacy");
const legacy2 = Number(
  exec(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, room_count, rate,
        check_in_date, check_out_date, nights, status, created_at, updated_at)
     VALUES (?,?,'双间老单客',1,NULL,2,300,'2031-07-01','2031-07-03',2,'PENDING',?,?)`,
    [HOTEL, "BK-LEGACY-MAIN", NOW, NOW]
  ).lastInsertRowid
);
const insLegacyDetail = () =>
  Number(
    exec(
      `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
          check_in_date, check_out_date, created_at)
       VALUES (?,?,1,NULL,'双间老单客',300,'PENDING','2031-07-01','2031-07-03',?)`,
      [HOTEL, legacy2, NOW]
    ).lastInsertRowid
  );
const l2a = insLegacyDetail();
const l2b = insLegacyDetail();
const legacyRoom = pickFreeRoom("2031-07-01", "2031-07-03", { typeId: 1 });
if (!legacyRoom) abandon("找不到 2031-07 期间可用的同房型空房");
const resH = await assign(HOTEL, [{ bookingId: legacy2, roomId: legacyRoom.id }]);
check("H1 主单级（只给 bookingId+roomId）仍然可用", resH.ok === true && resH.savedCount === 1, JSON.stringify(resH));
check(
  "H2 主单级落到「第一条待排明细」",
  one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [l2a, HOTEL]).room_id === legacyRoom.id &&
    one(`SELECT room_id FROM booking_rooms WHERE id = ? AND hotel_id = ?`, [l2b, HOTEL]).room_id === null
);
check(
  "H3 主单级排完一间后，主单仍是 PENDING（还有 1 间待排）",
  one(`SELECT status FROM bookings WHERE id = ? AND hotel_id = ?`, [legacy2, HOTEL]).status === "PENDING"
);

/* 完全没有明细的老数据 → 补一条明细（不能因为本次改动丢掉兼容） */
const noDetailId = Number(
  exec(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, room_count, rate,
        check_in_date, check_out_date, nights, status, created_at, updated_at)
     VALUES (?,?,'无明细老单',1,NULL,1,300,'2031-09-01','2031-09-03',2,'PENDING',?,?)`,
    [HOTEL, "BK-NO-DETAIL", NOW, NOW]
  ).lastInsertRowid
);
const noDetailRoom = pickFreeRoom("2031-09-01", "2031-09-03", { typeId: 1, used: new Set([legacyRoom.id]) });
if (!noDetailRoom) abandon("找不到 2031-09 期间可用的同房型空房");
const resH4 = await assign(HOTEL, [{ bookingId: noDetailId, roomId: noDetailRoom.id }]);
const createdH4 = q(
  `SELECT room_type_id, room_id, status FROM booking_rooms WHERE hotel_id = ? AND booking_id = ?`,
  [HOTEL, noDetailId]
);
check(
  "H4 无明细老单排房成功并补出 1 条明细",
  resH4.ok === true && createdH4.length === 1 && createdH4[0].room_id === noDetailRoom.id,
  JSON.stringify({ resH4, createdH4 })
);

/* 排满后再加房 → 明确拒绝，且不会多插一条明细 */
const secondRoom = pickFreeRoom("2031-07-01", "2031-07-03", {
  typeId: 1,
  used: new Set([legacyRoom.id]),
});
if (!secondRoom) abandon("找不到第二间可用同房型空房");
await assign(HOTEL, [{ bookingId: legacy2, roomId: secondRoom.id, bookingRoomId: l2b }]);
const detailCountBefore = one(
  `SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ?`,
  [HOTEL, legacy2]
).c;
const resH5 = await assign(HOTEL, [{ bookingId: legacy2, roomId: legacyRoom.id }]);
const detailCountAfter = one(
  `SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ?`,
  [HOTEL, legacy2]
).c;
check(
  "H5 已排满再加房 → 明确拒绝（提示已全部排满）",
  !!resH5.error && /已全部排满/.test(resH5.error),
  JSON.stringify(resH5)
);
check(
  "H6 拒绝后没有多插明细（明细数仍是 2）",
  detailCountAfter === detailCountBefore && detailCountAfter === 2,
  `before=${detailCountBefore} after=${detailCountAfter}`
);

/* ============================================================ 汇总 */

console.log(`\n${"=".repeat(64)}`);
console.log(`断言：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 条）`);
console.log("=".repeat(64));
if (fail > 0) process.exitCode = 1;
