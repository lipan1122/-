#!/usr/bin/env node
/**
 * 多房订单占用口径验收（整改清单 P0-3「支持 booking_rooms 多房订单」，第四节第 4 项）
 *
 * ── 验的是什么 ──
 * 「今日可售」的预订占用有两个来源，缺一个就会算错：
 *   1. booking_rooms 明细：一行 = 一间房。多房订单（一张订单订 3 间）只有它说得清；
 *   2. bookings 主单兜底：没有有效明细行的老数据，已排房按 1 间、未排房按 room_count。
 *
 * 缺陷形态（本脚本要拦住的）：
 *   · 只看主单 room_count 或room_id → 一张 3 间房的订单只扣 1 间 → 可售数虚高 → 超卖；
 *   · 明细和主单同时扣 → 一张 3 间房的订单扣 4~6 间 → 可售数虚小 → 明明有房却显示满房；
 *   · 部分入住后（1 间变在住、2 间还没到）两边都算 → 重复扣减。
 *
 * ── 怎么「真正打开数据库并执行」 ──
 *  1. `VACUUM INTO` 把 data/pms.db 复制到 .tmp/ 下的临时库（源库只读打开，**绝不改真库**）；
 *  2. 打开临时库，注入 `globalThis.__pmsDb`
 *     —— src/lib/db.ts 的 getDb() 优先返回它，所以断言跑的是**生产代码
 *     todayRoomTypeStock()**（不是脚本里抄的一份 SQL）；
 *  3. 数据全部造在 hotel_id = 998 的测试酒店里，与真酒店（1）互不影响；
 *  4. 结束删掉临时库（含 -wal / -shm），并复查真库里没有 998 号酒店。
 *
 * 运行：node scripts/test-room-stock-multiroom.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const TAG = "room-stock-multiroom";
/** 验收专用酒店（真库只有 1 号店） */
const HOTEL = 998;
/** 多房订单：一间订单关联 3 间房 */
const MULTI_ROOMS = 3;

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

/** 测试没跑起来 ≠ 通过：明确打红并退出 1 */
function abandon(message, detail = "") {
  console.error(`\n❌ 测试无法执行：${message}`);
  if (detail) console.error(detail);
  console.error(
    [
      "",
      "按整改清单第 281-287 行逐项排查：",
      "  1. PMS_DB_PATH        —— 本脚本固定用项目内 data/pms.db，可用 PMS_DB_PATH 指到别的真库",
      "  2. data 目录写权限     —— 源库只需读权限；.tmp 目录需要写权限",
      "  3. 临时数据库目录      —— .tmp/ 必须存在且可写（脚本会自动创建）",
      "  4. VACUUM INTO 目标目录 —— 目标文件不能已存在，父目录必须可写",
      "  5. SQLite WAL 文件权限  —— 临时库旁的 -wal/-shm 需要可删（脚本结束会清）",
    ].join("\n")
  );
  process.exit(1);
}

/* ============================================================ 临时库（VACUUM INTO 副本） */

const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = path.join(ROOT, ".tmp");
let TMP_DB = "";

function copyToTempDb() {
  if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}`);
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.accessSync(TMP_DIR, fs.constants.W_OK);
  } catch (e) {
    abandon(`临时目录不可写：${TMP_DIR}`, String(e?.message ?? e));
  }

  TMP_DB = path.join(TMP_DIR, `${TAG}-${Date.now()}.db`);
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 目标不存在：正常 */
    }
  }

  let src;
  try {
    src = new DatabaseSync(REAL_DB, { readOnly: true });
    src.exec(`VACUUM INTO '${TMP_DB.replace(/'/g, "''")}'`);
  } catch (e) {
    abandon(`VACUUM INTO 失败：${REAL_DB} → ${TMP_DB}`, String(e?.message ?? e));
  } finally {
    try {
      src?.close();
    } catch {
      /* 已关闭 */
    }
  }
  if (!fs.existsSync(TMP_DB)) abandon("VACUUM INTO 执行后目标文件仍不存在（磁盘满 / 路径被拦？）");
}

function cleanup() {
  if (!TMP_DB) return;
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      console.warn(`（清理临时文件失败：${f} — ${e?.message ?? e}）`);
    }
  }
}

process.on("exit", cleanup);
process.on("uncaughtException", (e) => {
  console.error("脚本异常：", e);
  process.exitCode = 1;
});

/* ============================================================ 载入生产代码 */

copyToTempDb();

process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

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

let conn;
try {
  conn = new DatabaseSync(TMP_DB);
  conn.exec("PRAGMA busy_timeout = 5000");
} catch (e) {
  abandon(`打不开临时库：${TMP_DB}`, String(e?.message ?? e));
}

globalThis.__pmsDb = conn;

let todayRoomTypeStock;
try {
  ({ todayRoomTypeStock } = await import("../src/lib/room-stock.ts"));
} catch (e) {
  abandon("import src/lib/room-stock.ts 失败", String(e?.message ?? e));
}

/* ============================================================ 工具 */

const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = todayStr();
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return todayStr(d);
})();
const AT = (day, time = "14:00:00") => `${day}T${time}`;
const NOW = new Date().toISOString();

function stock() {
  return todayRoomTypeStock(HOTEL, TODAY).find((r) => r.roomTypeId === TYPE_ID);
}

/* ============================================================ 数据准备：1 个房型 5 间房 */

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL,
  "TEST998",
  "多房订单口径验收酒店",
  "测试地址",
  "000",
  NOW,
]);
const TYPE_ID = Number(
  run(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort)
     VALUES (?,?,?,?,?,?,?)`,
    [HOTEL, "MR-5", "多房订单测试房型", "大床", 2, 300, 9999]
  ).lastInsertRowid
);
const ROOM_IDS = [];
for (let i = 0; i < 5; i += 1) {
  ROOM_IDS.push(
    Number(
      run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
        HOTEL,
        `MR-${i + 1}`,
        8,
        TYPE_ID,
        "VC",
        i + 1,
      ]).lastInsertRowid
    )
  );
}

let s = stock();
check("初始：物理 5 间、无占用、可售 5", s?.physical === 5 && s?.sellable === 5, JSON.stringify({ p: s?.physical, se: s?.sellable }));

/* ============================================================ 一、一条订单 3 间房 */

console.log("\n=== 一、一条 bookings 关联 3 间房（booking_rooms 3 行）→ 可售减 3 ===");

const bookingId = Number(
  run(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id,
                           check_in_date, check_out_date, nights, room_count, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      HOTEL,
      "TEST-MR-BK-1",
      "多房订单客人",
      TYPE_ID,
      null, // 主单不排具体房（多房订单的权威来源是明细表）
      TODAY,
      TOMORROW,
      1,
      MULTI_ROOMS,
      "CONFIRMED",
      NOW,
      NOW,
    ]
  ).lastInsertRowid
);

/** 3 行明细：分别排到前 3 间房 */
function insertDetailRows(roomIds, status = "CONFIRMED") {
  const ids = [];
  for (const roomId of roomIds) {
    ids.push(
      Number(
        run(
          `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile,
                                     rate, status, check_in_date, check_out_date, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [HOTEL, bookingId, TYPE_ID, roomId, "多房订单客人", "13800000002", 300, status, TODAY, TOMORROW, NOW]
        ).lastInsertRowid
      )
    );
    // 房态跟着排房走：已排房但未入住的房间在房态上还是 VC（可售数由明细扣，不由房态扣）
  }
  return ids;
}
const detailIds = insertDetailRows(ROOM_IDS.slice(0, MULTI_ROOMS));

const detailCount = Number(
  all(`SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ?`, [HOTEL, bookingId])[0].c
);
check(`数据前提：booking_rooms 有 ${MULTI_ROOMS} 行明细`, detailCount === MULTI_ROOMS, `实际 ${detailCount} 行`);

s = stock();
check("多房订单 booked = 3（按明细行数，不是按订单 1 张）", s?.booked === 3, `实际 ${s?.booked}`);
check("多房订单可售 = 5 − 3 = 2", s?.sellable === 2, `实际 ${s?.sellable}`);
check(
  "主单 room_count = 3 没有和明细叠加（否则会扣 6 间）",
  s?.booked === MULTI_ROOMS && s?.sellable === 5 - MULTI_ROOMS,
  JSON.stringify({ booked: s?.booked, sellable: s?.sellable })
);

/* ============================================================ 二、部分入住 */

console.log("\n=== 二、部分入住：1 间变在住、2 间还没到 → 可售仍减 3（不重复扣、不漏扣） ===");

/** 让某一间明细房办理入住：房态 OC + INHOUSE 单 + 明细行状态跟着改 */
function checkIn(roomId, detailId, stayNo, detailStatus) {
  run(`UPDATE rooms SET status = 'OC' WHERE hotel_id = ? AND id = ?`, [HOTEL, roomId]);
  run(
    `INSERT INTO stays (hotel_id, stay_no, booking_id, room_id, guest_name, mobile,
                        check_in_time, expect_check_out, nights, rate, status, rate_code, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, stayNo, bookingId, roomId, "多房订单客人", "13800000002", AT(TODAY), TOMORROW, 1, 300, "INHOUSE", "日租", NOW]
  );
  if (detailStatus) run(`UPDATE booking_rooms SET status = ? WHERE hotel_id = ? AND id = ?`, [detailStatus, HOTEL, detailId]);
}

/* 变体 A：明细行状态同步推进到 CHECKED_IN（正常业务路径） */
checkIn(ROOM_IDS[0], detailIds[0], "TEST-MR-STAY-1", "CHECKED_IN");
s = stock();
check("变体 A（明细 → CHECKED_IN）：inhouse = 1", s?.inhouse === 1, `实际 ${s?.inhouse}`);
check("变体 A：booked = 2（在住那间不再算预订占用）", s?.booked === 2, `实际 ${s?.booked}`);
check("变体 A：可售仍是 2（1 在住 + 2 预订 = 3 间被占，没重复扣）", s?.sellable === 2, `实际 ${s?.sellable}`);

/* 变体 B：明细行状态没跟着改（数据漂移：房间已 OC/在住，明细还是 CONFIRMED） */
run(`UPDATE booking_rooms SET status = 'CONFIRMED' WHERE hotel_id = ? AND id = ?`, [HOTEL, detailIds[0]]);
s = stock();
check("变体 B（明细仍 CONFIRMED，房态已 OC）：booked = 2（已在住的房不按预订再扣一次）", s?.booked === 2, `实际 ${s?.booked}`);
check("变体 B：可售仍是 2（同一间房不会被扣两次）", s?.sellable === 2, `实际 ${s?.sellable}`);

/* 恢复明细行的正常状态，后面的断言以正常路径为准 */
run(`UPDATE booking_rooms SET status = 'CHECKED_IN' WHERE hotel_id = ? AND id = ?`, [HOTEL, detailIds[0]]);

/* ============================================================ 三、主单兜底不与明细叠加 */

console.log("\n=== 三、主单兜底不与明细叠加（老数据兼容路径） ===");

/*
 * 再插一条「只有主单、没有明细」的团队单：
 * 它走的是 bookings 主单兜底分支（未排房按 room_count 扣）。
 * 如果代码把「明细分支」和「主单兜底分支」写成了并行两段（没有 NOT EXISTS 互斥），
 * 就会变成 3（上面的明细）+ N（兜底）双份扣减，可售直接变负。
 *
 * 先按「刚好卖完」的间数造：此时占用的房间 = 1 间在住 + 2 间明细 + 2 间团队单 = 5 间 = 物理房量。
 */
const teamBookingId = Number(
  run(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id,
                           check_in_date, check_out_date, nights, room_count, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, "TEST-MR-BK-2", "无明细团队单", TYPE_ID, null, TODAY, TOMORROW, 1, 2, "CONFIRMED", NOW, NOW]
  ).lastInsertRowid
);
s = stock();
check("无明细团队单按 room_count 扣 → booked = 2 + 2 = 4（不是 2 + 1，也没和明细叠加成 7）", s?.booked === 4, `实际 ${s?.booked}`);
check("占用 5 间（在住 1 + 明细 2 + 团队 2）→ 可售 = 0", s?.sellable === 0, `实际 ${s?.sellable}`);
check("刚好卖完时 oversold = 0（可售截断到 0，但不算超卖）", s?.oversold === 0, String(s?.oversold));

/* 再多卖 1 间：可售仍是 0，但 oversold 必须记下真实差额 1（页面要能提示超卖） */
run(`UPDATE bookings SET room_count = 3 WHERE hotel_id = ? AND id = ?`, [HOTEL, teamBookingId]);
s = stock();
check("再卖 1 间 → sellable 仍截断为 0", s?.sellable === 0, `实际 ${s?.sellable}`);
check("超卖时 oversold = 1（真实差额，不能被截断掩盖）", s?.oversold === 1, `实际 ${s?.oversold}`);

/* 取消这张兜底单，回到「3 间明细被占」的状态 */
run(`UPDATE bookings SET status = 'CANCELLED' WHERE hotel_id = ? AND id = ?`, [HOTEL, teamBookingId]);
s = stock();
check("取消无明细团队单 → 可售恢复为 2", s?.sellable === 2, `实际 ${s?.sellable}`);

/* ============================================================ 四、取消整张多房订单 → 库存全恢复 */

console.log("\n=== 四、取消整张多房订单 → 3 间库存全部恢复 ===");

run(`UPDATE bookings SET status = 'CANCELLED' WHERE hotel_id = ? AND id = ?`, [HOTEL, bookingId]);
s = stock();
check("整单取消 → booked = 0（明细行随主单状态一起失效）", s?.booked === 0, `实际 ${s?.booked}`);
check("整单取消后仍在住 1 间 → 可售 = 4", s?.sellable === 4, `实际 ${s?.sellable}`);

/* ============================================================ 五、租户隔离：别家酒店的明细不扣本店 */

console.log("\n=== 五、租户隔离：别家酒店的明细行不扣本店可售 ===");

/*
 * 造一条 hotel_id 与主单不一致的 booking_rooms（脏数据/越权写入的形态）：
 * room_stock 的明细查询是 `JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id`，
 * 主单在 1 号店、明细声称在 998 号店 → 这条必须被 JOIN 剔除，不能扣本店库存。
 */
const h1Booking = all(`SELECT id FROM bookings WHERE hotel_id = 1 LIMIT 1`)[0];
let crossHotelHeld = false;
if (h1Booking) {
  run(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile,
                               rate, status, check_in_date, check_out_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, h1Booking.id, TYPE_ID, ROOM_IDS[4], "别家酒店脏明细", "13800000003", 300, "CONFIRMED", TODAY, TOMORROW, NOW]
  );
  const before = stock();
  // 这条明细的 room_id 指向本店第 5 间房；若 JOIN 条件被写成 b.hotel_id = ? 也会被剔除，
  // 只有「完全不带 hotel_id」时才会串店。断言 booked 不因它变化。
  crossHotelHeld = before?.booked === 0;
  check(
    "主单在别家酒店的 booking_rooms 明细不扣本店可售（booked 仍为 0）",
    crossHotelHeld,
    `实际 booked = ${before?.booked}`
  );
  run(`DELETE FROM booking_rooms WHERE hotel_id = ? AND guest_name = ?`, [HOTEL, "别家酒店脏明细"]);
} else {
  check("主单在别家酒店的 booking_rooms 明细不扣本店可售（无 1 号店主单，跳过构造）", false, "真库里没有 hotel 1 的预订，无法构造跨店主单");
}

/* ============================================================ 六、真库零写入 */

console.log("\n=== 六、真库零写入 ===");

const real = new DatabaseSync(REAL_DB, { readOnly: true });
try {
  const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL).c);
  const leakedBookings = Number(real.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ?`).get(HOTEL).c);
  const leakedDetails = Number(real.prepare(`SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ?`).get(HOTEL).c);
  check("真库没有被写入测试酒店（998 号店 = 0）", leakedHotel === 0, `实际 ${leakedHotel}`);
  check("真库没有被写入测试预订（bookings = 0）", leakedBookings === 0, `实际 ${leakedBookings}`);
  check("真库没有被写入测试明细（booking_rooms = 0）", leakedDetails === 0, `实际 ${leakedDetails}`);
} finally {
  real.close();
}

/* ============================================================ 汇总 */

console.log(`\n通过 ${pass} / 失败 ${fail}`);
conn.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
