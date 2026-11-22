#!/usr/bin/env node
/**
 * rate_calendar.allotment（手工房量上限）验收
 * 整改清单 P0-3「支持 rate_calendar allotment」+ 第 67 行验收，第四节第 5 项
 *
 * ── 口径（src/lib/room-stock.ts）──
 *   物理可卖上限 physicalCap = 总房量 − 维修(OOO) − 锁房(LOCK)
 *   cap = allotment 为 NULL ? physicalCap : min(physicalCap, max(0, allotment))
 *   今日可售 sellable = cap − 在住 − 今日预订占用
 *
 *   allotment 只用来「收紧」上限，**绝不外扩**：
 *   配置 10 间而店里只有 5 间时，显示 5 而不是 10
 *   —— 放量属于渠道侧超售策略（src/lib/channels/stock-trigger.ts 的 toChannelAllotment），
 *      房态页展示的是物理事实，不能凭空多出房间。
 *
 * ── 断言矩阵 ──
 *   allotment = 2   → 显示 2（收紧）              ← 清单第 67 行
 *   allotment = 10  → 显示 5（不外扩）            ← 清单第 67 行
 *   allotment = NULL→ 显示物理可售 5              ← 未配置时回落
 *   allotment = 0   → 显示 0（当天关房）
 *   allotment 为负数 → 按 0 处理（不能变成「负数间可卖」）
 *   allotment 叠加维修房 → cap 取两者更小的
 *   allotment 是给「明天」配的 → 不影响今天
 *
 * ── 怎么「真正打开数据库并执行」 ──
 *  1. `VACUUM INTO` 复制 data/pms.db 到 .tmp/ 临时库（源库只读，**绝不改真库**）；
 *  2. 注入 `globalThis.__pmsDb`（src/lib/db.ts 的 getDb() 优先用它），
 *     这样跑的是**生产代码 todayRoomTypeStock()**；
 *  3. 数据造在 hotel_id = 997 的测试酒店里；结束清理临时库并复查真库零写入。
 *
 * 运行：node scripts/test-room-stock-allotment.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const TAG = "room-stock-allotment";
/** 验收专用酒店（真库只有 1 号店） */
const HOTEL = 997;

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
const NOW = new Date().toISOString();

/** 设置某房型某天的 allotment（null = 不配置 / 配置为 NULL） */
function setAllotment(typeId, value, day = TODAY) {
  if (value === "DELETE") {
    run(`DELETE FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ?`, [HOTEL, typeId, day]);
    return;
  }
  const existing = conn
    .prepare(`SELECT id FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ?`)
    .get(HOTEL, typeId, day);
  if (existing) {
    run(`UPDATE rate_calendar SET allotment = ?, updated_at = ? WHERE id = ?`, [value, NOW, existing.id]);
    return;
  }
  run(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, allotment, updated_at) VALUES (?,?,?,?,?,?)`, [
    HOTEL,
    typeId,
    day,
    300,
    value,
    NOW,
  ]);
}

function stockOf(typeId, day = TODAY) {
  return todayRoomTypeStock(HOTEL, day).find((r) => r.roomTypeId === typeId);
}

/* ============================================================ 数据准备 */

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL,
  "TEST997",
  "手工房量上限验收酒店",
  "测试地址",
  "000",
  NOW,
]);

/** 造一个房型 + n 间房（全部可售 VC），返回房型 id */
function seedType(code, name, roomCount) {
  const typeId = Number(
    run(
      `INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort)
       VALUES (?,?,?,?,?,?,?)`,
      [HOTEL, code, name, "大床", 2, 300, 9999]
    ).lastInsertRowid
  );
  for (let i = 0; i < roomCount; i += 1) {
    run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
      HOTEL,
      `${code}-${i + 1}`,
      7,
      typeId,
      "VC",
      i + 1,
    ]);
  }
  return typeId;
}

/* 主测试房型：物理 5 间，全部可售，无在住无预订（这样显示值就等于 cap，便于逐条看 allotment 的作用） */
/* 先记下 hotel 1 各房型的 allotment 快照：最后要证明 997 号店的配置没有串到真酒店 */
const h1AllotmentBefore = new Map(todayRoomTypeStock(1, TODAY).map((r) => [r.roomTypeId, r.allotment]));

const TYPE_A = seedType("AL-A", "手工房量A房型", 5);

let s = stockOf(TYPE_A);
check("未配置 allotment：物理 5 间，可售 5", s?.physical === 5 && s?.sellable === 5, JSON.stringify({ p: s?.physical, se: s?.sellable }));
check("未配置 allotment：allotment 字段回显 null", s?.allotment === null, String(s?.allotment));

/* ============================================================ 一、allotment = 2 */

console.log("\n=== 一、allotment = 2，物理可售 5 → 显示 2（上限收紧，清单第 67 行） ===");

setAllotment(TYPE_A, 2);
s = stockOf(TYPE_A);
check("allotment = 2 → sellable = 2", s?.sellable === 2, `实际 ${s?.sellable}`);
check("allotmentHold = 3（物理 5 − 上限 2，被压掉 3 间）", s?.allotmentHold === 3, String(s?.allotmentHold));
check("physical 仍是 5（物理房量不会被 allotment 改动）", s?.physical === 5, String(s?.physical));
check("allotment 回显 = 2（设置页要能显示配置值）", s?.allotment === 2, String(s?.allotment));

/* ============================================================ 二、allotment = 10（不外扩） */

console.log("\n=== 二、allotment = 10，物理可售 5 → 显示 5（绝不外扩，清单第 67 行） ===");

setAllotment(TYPE_A, 10);
s = stockOf(TYPE_A);
check("allotment = 10 → sellable = 5（按物理房量封顶，不会显示 10）", s?.sellable === 5, `实际 ${s?.sellable}`);
check("allotment = 10 → allotmentHold = 0（没有多余的房被压）", s?.allotmentHold === 0, String(s?.allotmentHold));
check("allotment = 10 → physical 仍是 5", s?.physical === 5, String(s?.physical));

/* ============================================================ 三、allotment = NULL */

console.log("\n=== 三、allotment = NULL → 回落用物理可售 ===");

setAllotment(TYPE_A, null);
s = stockOf(TYPE_A);
check("allotment = NULL → sellable = 5（用物理可售）", s?.sellable === 5, `实际 ${s?.sellable}`);
check("allotment = NULL → allotment 回显 null（页面显示「未设上限」）", s?.allotment === null, String(s?.allotment));

/* 整行删掉（没配过这天的房价）也要等价于 NULL */
setAllotment(TYPE_A, "DELETE");
s = stockOf(TYPE_A);
check("rate_calendar 没有这一天的记录 → sellable = 5", s?.sellable === 5, `实际 ${s?.sellable}`);

/* ============================================================ 四、allotment = 0 */

console.log("\n=== 四、allotment = 0 → 显示 0（当天关房） ===");

setAllotment(TYPE_A, 0);
s = stockOf(TYPE_A);
check("allotment = 0 → sellable = 0（手工关房）", s?.sellable === 0, `实际 ${s?.sellable}`);
check("allotment = 0 → allotmentHold = 5（5 间全被压掉）", s?.allotmentHold === 5, String(s?.allotmentHold));
check("allotment = 0 → oversold = 0（关房不算超卖）", s?.oversold === 0, String(s?.oversold));

/* ============================================================ 五、负数 allotment */

console.log("\n=== 五、allotment 为负数 → 按 0 处理（不能变成负数间可卖） ===");

setAllotment(TYPE_A, -3);
s = stockOf(TYPE_A);
check("allotment = -3 → sellable = 0", s?.sellable === 0, `实际 ${s?.sellable}`);
check("allotment = -3 → allotmentHold = 5（按 0 封顶）", s?.allotmentHold === 5, String(s?.allotmentHold));

/* ============================================================ 六、allotment 与维修房叠加 */

console.log("\n=== 六、allotment 与维修(OOO) 叠加 → 取两者更小的上限 ===");

/* 另一个房型：物理 5 间，其中 1 间维修 → 物理可卖上限 4 */
const TYPE_B = seedType("AL-B", "手工房量B房型", 5);
run(`UPDATE rooms SET status = 'OOO' WHERE hotel_id = ? AND room_type_id = ? AND room_no = ?`, [HOTEL, TYPE_B, "AL-B-1"]);

s = stockOf(TYPE_B);
check("B 房型 1 间维修 → physical = 5 / ooo = 1", s?.physical === 5 && s?.ooo === 1, JSON.stringify({ p: s?.physical, o: s?.ooo }));
check("B 房型未配 allotment → sellable = 4（物理 5 − 维修 1）", s?.sellable === 4, `实际 ${s?.sellable}`);

setAllotment(TYPE_B, 3);
s = stockOf(TYPE_B);
check("B 房型 allotment = 3（小于物理可卖 4）→ sellable = 3", s?.sellable === 3, `实际 ${s?.sellable}`);
check("B 房型 allotmentHold = 1（4 − 3）", s?.allotmentHold === 1, String(s?.allotmentHold));

setAllotment(TYPE_B, 10);
s = stockOf(TYPE_B);
check("B 房型 allotment = 10（大于物理可卖 4）→ sellable = 4（维修房仍然扣）", s?.sellable === 4, `实际 ${s?.sellable}`);
check("B 房型 allotment = 10 → allotmentHold = 0", s?.allotmentHold === 0, String(s?.allotmentHold));

/* ============================================================ 七、allotment 的日期不能串 */

console.log("\n=== 七、allotment 只作用于配置的那一天 ===");

const TYPE_C = seedType("AL-C", "手工房量C房型", 5);
setAllotment(TYPE_C, 1, TOMORROW); // 配的是明天
s = stockOf(TYPE_C, TODAY);
check("只给明天配 allotment = 1 → 今天仍显示 5", s?.sellable === 5, `实际 ${s?.sellable}`);
const tomorrow = stockOf(TYPE_C, TOMORROW);
check("明天的 allotment = 1 → 明天显示 1", tomorrow?.sellable === 1, `实际 ${tomorrow?.sellable}`);

/* ============================================================ 八、租户隔离 + 真库零写入 */

console.log("\n=== 八、租户隔离 + 真库零写入 ===");

setAllotment(TYPE_A, 2); // A 房型回到 allotment = 2
const hotel1Rows = todayRoomTypeStock(1, TODAY);
check(
  "hotel 1 的库存清单里不含 997 号店测试房型（allotment 查询也带 hotel_id）",
  hotel1Rows.every((r) => r.roomTypeId !== TYPE_A && r.roomTypeId !== TYPE_B && r.roomTypeId !== TYPE_C),
  hotel1Rows.map((r) => `${r.roomTypeId}:${r.name}`).join(",")
);
/* 逐房型比对「配前 / 配后」：997 号店写了 6 条 rate_calendar（含 allotment=0/负数），真酒店一条都不能变 */
const h1AllotmentAfter = new Map(todayRoomTypeStock(1, TODAY).map((r) => [r.roomTypeId, r.allotment]));
const allotmentDrift = [...h1AllotmentBefore.entries()].filter(([id, v]) => h1AllotmentAfter.get(id) !== v);
check(
  `hotel 1 各房型（${h1AllotmentBefore.size} 个）的 allotment 一条都没被 997 号店的配置改动`,
  allotmentDrift.length === 0,
  JSON.stringify({ drift: allotmentDrift, after: [...h1AllotmentAfter.entries()] })
);

const real = new DatabaseSync(REAL_DB, { readOnly: true });
try {
  const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL).c);
  const leakedCal = Number(real.prepare(`SELECT COUNT(*) AS c FROM rate_calendar WHERE hotel_id = ?`).get(HOTEL).c);
  check("真库没有被写入测试酒店（997 号店 = 0）", leakedHotel === 0, `实际 ${leakedHotel}`);
  check("真库没有被写入测试房价日历（rate_calendar = 0）", leakedCal === 0, `实际 ${leakedCal}`);
} finally {
  real.close();
}

/* ============================================================ 汇总 */

console.log(`\n通过 ${pass} / 失败 ${fail}`);
conn.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
