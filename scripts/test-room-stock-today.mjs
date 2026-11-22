#!/usr/bin/env node
/**
 * 房型「今日可售」验收（整改清单 P0-3 基础场景，第四节第 3 项）
 *
 * ── 验的是什么 ──
 * 房态页左侧「房型 / 今日可售」原来跑 `COUNT(r.id)`（= 物理房间总数），
 * 在住、维修、锁房、已排房预订全都被当成可售 → 前台按它排房必然超卖。
 * 修完后的口径由 src/lib/room-stock.ts 的 todayRoomTypeStock() 统一提供：
 *
 *   物理可卖上限 = 总房量 − 维修(OOO) − 锁房(LOCK)，当天配了 rate_calendar.allotment 且更小则取它
 *   今日可售     = 物理可卖上限 − 在住 − 今日预订占用
 *
 * ── 清单验收项（第 63-69 行）逐条对应 ──
 *   · 总房 5，在住 1，已排预订 1，可售 3        → 场景 A
 *   · 维修和锁房继续扣除                        → 场景 A 续
 *   · allotment 设为 2 时显示 2                 → 场景 B（新楼 P0-3 口径；见文件末尾说明）
 *   · 取消预订后库存恢复                        → 场景 A 续
 *   · 多房订单按房间数扣减                      → 场景 C（深度验证在 test-room-stock-multiroom.mjs）
 *
 * ── 怎么「真正打开数据库并执行」 ──
 *  1. `VACUUM INTO` 把 data/pms.db 复制到 .tmp/ 下的临时库（源库只读打开，**绝不改真库**）；
 *  2. 打开临时库，把它注入 `globalThis.__pmsDb`
 *     —— src/lib/db.ts 的 getDb() 第一行就是 `if (globalThis.__pmsDb) return globalThis.__pmsDb;`，
 *     这是项目自带的「换库」开关，所以下面的断言跑的是**生产代码 todayRoomTypeStock()**，
 *     不是脚本里抄一份 SQL（抄一份的话代码改了测试还是绿的）。
 *     Node 24 原生剥离 .ts 类型，配 registerHooks 解析 `@/` 别名即可 import；
 *     本机 Node v24.22.3 实测通过。
 *  3. 断言数据全部造在 hotel_id = 999 的测试酒店里，与真酒店（1）互不影响；
 *  4. 结束删掉临时库（含 -wal / -shm）并复查真库里没有 999 号酒店。
 *
 * 运行：node scripts/test-room-stock-today.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const TAG = "room-stock-today";
/** 验收专用酒店：远离真实门店（真库只有 1 号店），所有断言都以它为过滤条件 */
const HOTEL = 999;

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
    // 显式验证写权限：Windows 上目录存在但只读时，VACUUM INTO 会报 unable to open database file
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
    // 源库只读打开：物理上不可能写坏真库
    src = new DatabaseSync(REAL_DB, { readOnly: true });
    // 单引号转义（Windows 路径里的反斜杠在 SQL 单引号串里是普通字符）
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

/* 异常退出也必须清理，不能留下临时库 */
process.on("exit", cleanup);
process.on("uncaughtException", (e) => {
  console.error("脚本异常：", e);
  fail += 1;
  process.exitCode = 1;
});

/* ============================================================ 载入生产代码 */

copyToTempDb();

process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/** 让 Node 解析 Next 的 `@/` 别名（与 scripts/test-channel-sync.mjs 同一手法） */
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

/* 关键一步：把生产代码的数据库连接换成临时库（src/lib/db.ts 的 getDb 会优先用它） */
globalThis.__pmsDb = conn;

/** 生产代码：今日可售口径（唯一实现） */
let todayRoomTypeStock;
try {
  ({ todayRoomTypeStock } = await import("../src/lib/room-stock.ts"));
} catch (e) {
  abandon("import src/lib/room-stock.ts 失败", String(e?.message ?? e));
}

/* ============================================================ 数据准备工具 */

const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);
const one = (sql, params = []) => conn.prepare(sql).get(...params);

/** 本地日期 YYYY-MM-DD（与 src/lib/utils.ts 的 todayStr 同义，避免 import 到 TS 里再绕一圈） */
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
/** 只取前 10 位当营业日用的本地时间串（stays.check_in_time 的口径） */
const AT = (day, time = "14:00:00") => `${day}T${time}`;

/** 取 hotel 999 下某个房型的一行库存明细 */
function stockOf(typeId, day = TODAY) {
  const rows = todayRoomTypeStock(HOTEL, day);
  return rows.find((r) => r.roomTypeId === typeId);
}

/** 造一个房型 + n 间房，返回 { typeId, roomIds } */
function seedRoomType(code, name, roomCount, statusList = []) {
  const typeId = Number(
    run(
      `INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort)
       VALUES (?,?,?,?,?,?,?)`,
      [HOTEL, code, name, "大床", 2, 300, 9999]
    ).lastInsertRowid
  );
  const roomIds = [];
  for (let i = 0; i < roomCount; i += 1) {
    const status = statusList[i] ?? "VC";
    roomIds.push(
      Number(
        run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
          HOTEL,
          `${code}-${i + 1}`,
          9,
          typeId,
          status,
          i + 1,
        ]).lastInsertRowid
      )
    );
  }
  return { typeId, roomIds };
}

/* 测试酒店（真库只有 1 号店，这里固定 999） */
run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL,
  "TEST999",
  "今日可售验收酒店",
  "测试地址",
  "000",
  new Date().toISOString(),
]);

/* ============================================================ 场景 A：清单第 65 行 */

console.log("\n=== 场景 A：总房 5，在住 1，已排预订 1 → 可售 3（清单第 65 行） ===");

// 5 间房：第 1 间在住（OC），其余 4 间可售
const A = seedRoomType("STK-A", "可售口径A房型", 5, ["OC", "VC", "VC", "VC", "VC"]);
const [roomA1, roomA2, roomA3, roomA4, roomA5] = A.roomIds;

// 在住单（房态 OC + INHOUSE 单，两者都算占用）
run(
  `INSERT INTO stays (hotel_id, stay_no, booking_id, room_id, guest_name, mobile,
                      check_in_time, expect_check_out, nights, rate, status, rate_code, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [HOTEL, "TEST-STK-STAY-1", null, roomA1, "可售验收在住客人", "13800000001", AT(TODAY), TOMORROW, 1, 300, "INHOUSE", "日租", new Date().toISOString()]
);

// 已排房预订 1 张（今天入住 1 晚，占用 roomA2）
run(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id,
                         check_in_date, check_out_date, nights, room_count, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [HOTEL, "TEST-STK-BK-1", "可售验收已排房客人", A.typeId, roomA2, TODAY, TOMORROW, 1, 1, "CONFIRMED", new Date().toISOString(), new Date().toISOString()]
);

let a = stockOf(A.typeId);
check("测试房型出现在今日库存清单里", Boolean(a), JSON.stringify(all(`SELECT id, name FROM room_types WHERE hotel_id = ?`, [HOTEL])));
check("physical = 5（物理房量 5 间）", a?.physical === 5, String(a?.physical));
check("inhouse = 1（在住 1 间）", a?.inhouse === 1, String(a?.inhouse));
check("booked = 1（已排房预订 1 间）", a?.booked === 1, String(a?.booked));
check("sellable = 3（5 − 1 在住 − 1 预订，清单第 65 行）", a?.sellable === 3, `实际 ${a?.sellable}`);
check("oversold = 0（没超卖）", a?.oversold === 0, String(a?.oversold));

/* ---------- 维修房 / 锁房继续扣除（清单第 66 行） ---------- */
console.log("\n=== 维修(OOO) / 锁房(LOCK) 继续扣除（清单第 66 行） ===");

run(`UPDATE rooms SET status = 'OOO' WHERE hotel_id = ? AND id = ?`, [HOTEL, roomA3]);
a = stockOf(A.typeId);
check("1 间改维修 → ooo = 1", a?.ooo === 1, String(a?.ooo));
check("1 间维修 → sellable = 2（维修房不能卖）", a?.sellable === 2, String(a?.sellable));

run(`UPDATE rooms SET status = 'LOCK' WHERE hotel_id = ? AND id = ?`, [HOTEL, roomA4]);
a = stockOf(A.typeId);
check("再锁 1 间 → lock = 1", a?.lock === 1, String(a?.lock));
check("锁房同样扣除 → sellable = 1", a?.sellable === 1, `实际 ${a?.sellable}`);

/* ---------- 取消预订后库存恢复（清单第 68 行） ---------- */
console.log("\n=== 取消预订后库存恢复（清单第 68 行） ===");

run(`UPDATE bookings SET status = 'CANCELLED' WHERE hotel_id = ? AND booking_no = ?`, [HOTEL, "TEST-STK-BK-1"]);
a = stockOf(A.typeId);
check("取消预订 → booked = 0", a?.booked === 0, String(a?.booked));
check("取消预订 → sellable 恢复到 2（物理可卖 3 − 在住 1）", a?.sellable === 2, `实际 ${a?.sellable}`);

/* ---------- 退房（在住 → 空房）也要恢复 ---------- */
run(`UPDATE stays SET status = 'CHECKED_OUT' WHERE hotel_id = ? AND stay_no = ?`, [HOTEL, "TEST-STK-STAY-1"]);
run(`UPDATE rooms SET status = 'VC' WHERE hotel_id = ? AND id = ?`, [HOTEL, roomA1]);
a = stockOf(A.typeId);
check("在住客人退房 → inhouse = 0", a?.inhouse === 0, String(a?.inhouse));
check("退房后 sellable = 3（5 − 维修 1 − 锁房 1）", a?.sellable === 3, `实际 ${a?.sellable}`);

/* ---------- 场景 C：多房订单按房间数扣减（清单第 69 行） ---------- */
console.log("\n=== 多房订单按房间数扣减（清单第 69 行，深度验证见 test-room-stock-multiroom.mjs） ===");

run(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id,
                         check_in_date, check_out_date, nights, room_count, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [HOTEL, "TEST-STK-BK-2", "可售验收团队单（2 间）", A.typeId, null, TODAY, TOMORROW, 1, 2, "CONFIRMED", new Date().toISOString(), new Date().toISOString()]
);
a = stockOf(A.typeId);
check("未排房的 2 间团队单 → booked = 2（按 room_count 扣，不是 1）", a?.booked === 2, String(a?.booked));
check("团队单占用 2 间 → sellable = 1", a?.sellable === 1, `实际 ${a?.sellable}`);

/* ============================================================ 场景 B：allotment（清单第 67 行） */

console.log("\n=== 场景 B：allotment = 2 时显示 2（清单第 67 行） ===");

/*
 * 关于清单第 67 行「allotment 设为 2 时显示 2」的口径：
 *   room-stock.ts 把 allotment 当作**物理可卖上限的上限**：
 *     cap = min(物理可卖上限, allotment)；sellable = cap − 在住 − 预订
 *   所以在「没有在住、没有预订」的干净房型上，allotment = 2 就**直接显示 2**（本场景）。
 *   如果同一个房型还有在住/预订，那部分已经卖掉的房间仍然要从 2 里扣
 *   —— 否则「今日可售」会比实际还能卖的房多，又变成超卖。
 *   allotment 的四种边界（2 / 10 / NULL / 0）在 test-room-stock-allotment.mjs 里逐条验证。
 */
const B = seedRoomType("STK-B", "可售口径B房型", 5, ["VC", "VC", "VC", "VC", "VC"]);
run(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, allotment, updated_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL,
  B.typeId,
  TODAY,
  300,
  2,
  new Date().toISOString(),
]);

const b = stockOf(B.typeId);
check("干净房型物理可卖 5 间（physical = 5）", b?.physical === 5, String(b?.physical));
check("allotment = 2 → sellable 显示 2（上限收紧，清单第 67 行）", b?.sellable === 2, `实际 ${b?.sellable}`);
check("allotmentHold = 3（5 − 2，被手工上限压掉的 3 间）", b?.allotmentHold === 3, String(b?.allotmentHold));
check("allotment 字段回显 = 2（页面「修改房量」要显示设置值）", b?.allotment === 2, String(b?.allotment));

/* ============================================================ 租户隔离 + 真库未被写 */

console.log("\n=== 租户隔离 + 真库零写入 ===");

const otherHotelRows = todayRoomTypeStock(1, TODAY);
check(
  "hotel 1 的库存清单里没有 999 号店的测试房型（库存查询带 hotel_id）",
  otherHotelRows.every((r) => r.roomTypeId !== A.typeId && r.roomTypeId !== B.typeId),
  otherHotelRows.map((r) => r.name).join(",")
);

const real = new DatabaseSync(REAL_DB, { readOnly: true });
try {
  const leaked = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL).c);
  const leakedRooms = Number(real.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`).get(HOTEL).c);
  check("真库没有被写入测试酒店（999 号店条数 = 0）", leaked === 0, `真库里有 ${leaked} 家 999 号店`);
  check("真库没有被写入测试房间（rooms 条数 = 0）", leakedRooms === 0, `真库里有 ${leakedRooms} 间测试房`);
} finally {
  real.close();
}

/* ============================================================ 汇总 */

console.log(`\n通过 ${pass} / 失败 ${fail}`);
conn.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
