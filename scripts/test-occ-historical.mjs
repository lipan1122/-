#!/usr/bin/env node
/**
 * 跨期出租率「历史可售房晚」验收（上线评审 P1）
 *
 * ── 评审原文 ──
 * 「跨期出租率：metrics.ts 使用当前房态的可售房量，房间营业日报乘区间天数。
 *   验证昨日锁房今日解锁时昨日报表是否变化。经营日报优先以每个营业日的
 *   夜审快照或历史可售房晚为分母。缺历史值时提示估算。」
 *
 * ── 修之前为什么会变 ──
 * occupancyMetrics 的分母原来是「**此刻**数 rooms.status」：
 *     可售 = 总房量 − 当前 OOO − 当前 LOCK
 * 于是 D 日锁了 2 间 → 夜审日报写 6/8 = 75%；D+1 解锁 → 同一张 D 日报变成 6/10 = 60%。
 * 分母跟着今天的房态动，历史报表无法复核。
 *
 * ── 修之后 ──
 * src/lib/metrics.ts 的 historicalSellable() 逐营业日取分母：
 *   ① 当日有夜审快照 → 反解 `rooms_sold / occupancy`（夜审写入时冻结的两个值，
 *      写入侧保证分母就是当日可售房量，见 scripts/test-night-audit-occupancy.mjs）→ source = "audit"
 *   ② 今天/未来还没夜审 → 当前房态（live = true，这就是事实，不算估算）
 *   ③ 历史日无当日快照 → 最近一次夜审快照 → source = "estimate"
 *   ④ 一天快照都没有 → 当前房态 → source = "estimate"（报表提示估算）
 * 出租率 / RevPAR 的分母 = Σ 每日可售房量（OccupancyMetrics.sellableRoomNights）。
 *
 * ── 本脚本验什么 ──
 * A. 静态：本脚本「跑夜审」用的 SQL 与 night-audit/actions.ts 源码逐字一致；
 *    metrics.ts 确实改成了逐日快照（并给出反解公式）。
 * B. 评审场景（核心）：D 日 2 间锁房 → 跑夜审 → 记出租率 → **解锁那 2 间**
 *    → 再算 D 的出租率，必须与夜审时逐位相同；同时反向证明「按旧口径此刻是会变的」。
 * C. 估算提示：没有夜审快照的历史日 → estimated = true / estimatedDays 列出该日；
 *    有快照的日子 estimated = false；今天 live 且不算估算。
 * D. 隔离与脏数据：别家店的快照不串店；rooms_sold=0、可售<已售 这类脏行不被当成快照。
 * E. 真库零写入。
 *
 * ── 怎么「真正打开数据库并执行」 ──
 * 1. `VACUUM INTO` 把 data/pms.db 复制到 .tmp/（源库只读打开，**绝不改真库**）；
 * 2. 注入 `globalThis.__pmsDb`（src/lib/db.ts 的换库开关）+ registerHooks 解析 `@/`，
 *    直接 import 生产代码 src/lib/metrics.ts —— 断言跑的是生产实现，不是脚本里抄的一份；
 * 3. 造数全部落在 hotel_id = 9870 / 9871 / 9872，与真门店（1 号店）互不影响；
 * 4. 结束删掉临时库（含 -wal / -shm），并复查真库里没有测试酒店。
 *
 * 用法：node scripts/test-occ-historical.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/* ============================================================ 断言器 */

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
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
      "排查顺序：",
      "  1. PMS_DB_PATH        —— 默认用项目内 data/pms.db，可用环境变量指到别的真库",
      "  2. data 目录权限       —— 源库只需读权限；.tmp 目录需要写权限",
      "  3. VACUUM INTO 目标    —— 目标文件不能已存在，父目录必须可写",
      "  4. SQLite WAL 文件     —— 临时库旁的 -wal/-shm 需要可删（脚本结束会清）",
    ].join("\n")
  );
  process.exit(1);
}

/*
 * Node 24 用原生类型剥离直接 import .ts 脚本（下一节的 registerHooks + import()），
 * 每次加载都会打一条 MODULE_TYPELESS_PACKAGE_JSON 警告（package.json 没写 type: module）。
 * 这是测试手法带来的噪音，不是被测代码的问题 —— 与仓库里其它 test-*.mjs 一样过滤掉。
 */
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

const norm = (s) => s.replace(/\s+/g, " ").trim();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
/** 浮点比到 12 位（出租率是除法结果，不能直接 ===） */
const twelve = (n) => Number(n).toFixed(12);

/* ============================================================ 临时库（VACUUM INTO 副本） */

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const TAG = "occ-historical";
const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

let TMP_DB = "";
/** 临时库连接（cleanup 要先关它，否则 Windows 上删不掉 db / -wal 文件） */
let conn = null;

function copyToTempDb() {
  if (!existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}`);
  try {
    mkdirSync(TMP_DIR, { recursive: true });
    /*
     * 显式验证写权限：Windows 上「目录存在但只读」时 VACUUM INTO 会报
     * unable to open database file，提前用真实写入探针说清楚是哪一步坏的。
     */
    const probe = join(TMP_DIR, `.probe-${TAG}-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (e) {
    abandon(`临时目录不可写：${TMP_DIR}`, String(e?.message ?? e));
  }

  TMP_DB = join(TMP_DIR, `${TAG}-${process.pid}-${Date.now()}.db`);
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 目标不存在：正常 */
    }
  }

  let src;
  try {
    /* 源库只读打开：物理上不可能写坏真库 */
    src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    src.exec(`VACUUM INTO '${sqlPath(TMP_DB)}'`);
  } catch (e) {
    abandon(`VACUUM INTO 失败：${REAL_DB} → ${TMP_DB}`, String(e?.message ?? e));
  } finally {
    try {
      src?.close();
    } catch {
      /* 已关闭 */
    }
  }
  if (!existsSync(TMP_DB)) abandon("VACUUM INTO 执行后目标文件仍不存在（磁盘满 / 路径被拦？）");
}

function cleanup() {
  /* 先关连接：Windows 上文件句柄没释放时 rmSync 会 EPERM */
  try {
    conn?.close();
  } catch {
    /* 已关闭 / 从未打开 */
  }
  conn = null;
  if (!TMP_DB) return;
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch (e) {
      console.warn(`（清理临时文件失败：${f} — ${e?.message ?? e}）`);
    }
  }
}

process.on("exit", cleanup);
process.on("uncaughtException", (e) => {
  console.error("脚本异常：", e);
  cleanup();
  process.exit(1);
});

/* ============================================================ 载入生产代码 */

copyToTempDb();

/** 让 Node 解析 Next 的 `@/` 别名（与 test-room-stock-today.mjs 同一手法） */
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

try {
  conn = new DatabaseSync(TMP_DB, { timeout: 10000 });
  conn.exec("PRAGMA busy_timeout = 5000");
} catch (e) {
  abandon(`打不开临时库：${TMP_DB}`, String(e?.message ?? e));
}

/* 关键一步：把生产代码的数据库连接换成临时库（src/lib/db.ts 的 getDb 会优先用它） */
globalThis.__pmsDb = conn;

/** 生产代码：逐日历史可售房量 + 区间经营指标（本次整改的主体） */
let occupancyMetrics;
let occupancyOfDay;
let historicalSellable;
let estimatedHint;
try {
  ({ occupancyMetrics, occupancyOfDay, historicalSellable, estimatedHint } = await import("../src/lib/metrics.ts"));
} catch (e) {
  abandon("import src/lib/metrics.ts 失败", String(e?.message ?? e));
}

const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);
const one = (sql, params = []) => conn.prepare(sql).get(...params);

/* ============================================================ A. 静态：夜审口径 == 源码 */

console.log("=== A. 静态：本脚本「跑夜审」用的 SQL 必须与 night-audit/actions.ts 逐字一致 ===");

/** 夜审可售房量 SQL（actions.ts 里那条，分母就是「当日可售房量」） */
const AUDIT_SELLABLE_SQL = `SELECT COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
           FROM rooms WHERE hotel_id = ?`;

/** 夜审出租间夜 SQL（过夜在住房间数，排除钟点房） */
const AUDIT_ROOM_NIGHTS_SQL = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND COALESCE(s.nights, 0) > 0
   AND COALESCE(s.rate_code, '') <> '钟点'`;

const AUDIT_FILE = join("src", "app", "(main)", "night-audit", "actions.ts");
const METRICS_FILE = join("src", "lib", "metrics.ts");
const auditSrc = readFileSync(AUDIT_FILE, "utf8");
const metricsSrc = readFileSync(METRICS_FILE, "utf8");
const nAudit = norm(auditSrc);
const nMetrics = norm(metricsSrc);

check(
  "夜审可售房量 SQL 与源码一致（分母 = 总房量 − OOO − LOCK）",
  nAudit.includes(norm(AUDIT_SELLABLE_SQL)),
  "night-audit/actions.ts 可售房量 SQL 已变，请同步本脚本"
);
check(
  "夜审出租间夜 SQL 与源码一致（过夜在住、排除钟点房）",
  nAudit.includes(norm(AUDIT_ROOM_NIGHTS_SQL)),
  "night-audit/actions.ts 间夜 SQL 已变，请同步本脚本"
);
check(
  "夜审核心：occupancy 的分母是 sellableRooms（不是总房量）",
  /const\s+occupancy\s*=\s*sellableRooms\s*>\s*0\s*\?\s*roomNights\s*\/\s*sellableRooms\s*:\s*0/.test(auditSrc),
  (auditSrc.match(/const occupancy =[^;]{0,120};/) ?? [""])[0]
);
check(
  "metrics.ts 已改为逐营业日取分母（historicalSellable + sellableRoomNights）",
  /export function historicalSellable\(/.test(metricsSrc) &&
    nMetrics.includes("roomNights / sellableRoomNights") &&
    nMetrics.includes("estimated: estimatedDays.length > 0"),
  "metrics.ts 的分母没有走历史快照"
);
check(
  "metrics.ts 的夜审反解公式存在（可售房量 = rooms_sold / occupancy）",
  nMetrics.includes("sold / occ") && nMetrics.includes("FROM night_audits WHERE hotel_id = ?"),
  "找不到夜审快照反解"
);

/* ============================================================ B. 造数（评审场景） */

console.log("\n=== B. 评审场景：D 日 2 间锁房 → 夜审 → 解锁 → 出租率是否变化 ===");

const HOTEL = 9870; // 被测店
const OTHER = 9871; // 别家店（隔离用）
const EMPTY = 9872; // 空店（无房间）
const ROOM_TOTAL = 10;
const LOCK_ROOMS = 2;
const GUEST_ROOMS = 6;
const REVENUE_PER_NIGHT = 300;

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dayShift(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
const TODAY = fmt(new Date());
/**
 * D = 昨天（已夜审的营业日），D2 = 前天（没有夜审快照的历史日）。
 * 用相对日期而不是写死 2026-11-xx：不论哪天跑，D 都严格早于今天，
 * D2 都严格早于 D，评审场景与「估算」判定都不受运行日期影响。
 */
const D = dayShift(TODAY, -1);
const D2 = dayShift(TODAY, -2);
const GAP_NO_SOLD = dayShift(TODAY, -5); // 脏数据：rooms_sold = 0（反解不出分母）
const GAP_BAD_PAIR = dayShift(TODAY, -6); // 脏数据：可售 < 已售（物理上不成立）

const NOW = new Date().toISOString();
const AT = (day, time = "14:00:00") => `${day}T${time}`;

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL,
  "TEST-OCC-HIST",
  "跨期出租率验收酒店",
  "测试地址",
  "000",
  NOW,
]);
run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  OTHER,
  "TEST-OCC-OTHER",
  "跨期出租率隔离酒店",
  "测试地址",
  "000",
  NOW,
]);
run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  EMPTY,
  "TEST-OCC-EMPTY",
  "空店（没有房间）",
  "测试地址",
  "000",
  NOW,
]);

const typeId = Number(
  run(
    `INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`,
    [HOTEL, "TH", "跨期验收房型", REVENUE_PER_NIGHT, 2, 1]
  ).lastInsertRowid
);

const roomIds = [];
for (let i = 1; i <= ROOM_TOTAL; i += 1) {
  /* 1..6 在住（OC）、7..8 空净（VC）、9..10 锁房（LOCK）—— 锁房就是评审说的「昨日锁房」 */
  let status = "VC";
  if (i <= GUEST_ROOMS) status = "OC";
  else if (i > ROOM_TOTAL - LOCK_ROOMS) status = "LOCK";
  roomIds.push(
    Number(
      run(`INSERT INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort) VALUES (?,?,?,?,?,?)`, [
        HOTEL,
        typeId,
        `H${String(i).padStart(3, "0")}`,
        1,
        status,
        1,
      ]).lastInsertRowid
    )
  );
}

/* D 日在住的 6 间（1 晚），房间状态 OC */
for (let i = 0; i < GUEST_ROOMS; i += 1) {
  run(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out,
                        nights, rate, status, rate_code, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `HIST-${i + 1}`, roomIds[i], `跨期客${i + 1}`, AT(D), dayShift(D, 1), 1, REVENUE_PER_NIGHT, "INHOUSE", "门市价", AT(D)]
  );
}

const roomsNow = one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [HOTEL]).c;
check(
  `测试店数据就绪：${ROOM_TOTAL} 间房 / ${LOCK_ROOMS} 间锁房 / ${GUEST_ROOMS} 间在住（D = ${D}）`,
  Number(roomsNow) === ROOM_TOTAL &&
    Number(one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND status = 'LOCK'`, [HOTEL]).c) === LOCK_ROOMS &&
    Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [HOTEL]).c) === GUEST_ROOMS,
  JSON.stringify({ rooms: roomsNow })
);

/**
 * 「跑夜审」：与 night-audit/actions.ts 的 runNightAuditAction 同口径同落库列
 * （可售房量 SQL / 间夜 SQL 上面已逐字校验过，就是源码里那两条）。
 */
function runNightAudit(hotelId, bizDate) {
  const sellable = Number(one(AUDIT_SELLABLE_SQL, [hotelId]).sellable);
  const roomNights = Number(one(AUDIT_ROOM_NIGHTS_SQL, [hotelId]).v);
  const hourlyRooms = Number(
    one(
      `SELECT COUNT(*) AS v FROM stays s
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
          AND (COALESCE(s.nights, 0) <= 0 OR COALESCE(s.rate_code, '') = '钟点')`,
      [hotelId]
    ).v
  );
  const occupancy = sellable > 0 ? roomNights / sellable : 0;
  run(
    `INSERT INTO night_audits
       (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
        revenue_room, revenue_food, revenue_other, refund_total, revenue_net, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING`,
    [hotelId, bizDate, "DONE", roomNights, hourlyRooms, 0, occupancy, 0, 0, 0, 0, 0, "验收夜审", AT(bizDate, "23:59:00")]
  );
  return { sellable, roomNights, hourlyRooms, occupancy };
}

/* ---- ① 夜审前：出租率（分母已扣当日 2 间锁房 = 8） ---- */
const beforeAudit = occupancyOfDay(HOTEL, D);
check(
  `夜审前出租率 = ${GUEST_ROOMS}/${ROOM_TOTAL - LOCK_ROOMS}（当日锁房已扣：可售 8）`,
  beforeAudit.sellableRooms === ROOM_TOTAL - LOCK_ROOMS &&
    twelve(beforeAudit.occupancy) === twelve(GUEST_ROOMS / (ROOM_TOTAL - LOCK_ROOMS)),
  JSON.stringify({ sellable: beforeAudit.sellableRooms, occ: beforeAudit.occupancy })
);

/* ---- ② 跑夜审（写 night_audits，冻结当日 rooms_sold / occupancy） ---- */
const audit = runNightAudit(HOTEL, D);
const auditRow = one(`SELECT * FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [HOTEL, D]);
check(
  `夜审落库 occupancy = ${GUEST_ROOMS}/${ROOM_TOTAL - LOCK_ROOMS}（rooms_sold = ${GUEST_ROOMS}）`,
  six(Number(auditRow?.occupancy)) === six(audit.occupancy) && Number(auditRow?.rooms_sold) === GUEST_ROOMS,
  JSON.stringify(auditRow)
);
const occAtAudit = occupancyOfDay(HOTEL, D);
check(
  "夜审后 metrics 出租率 === 夜审写入值（同一营业日、同一分母，逐位比到 12 位）",
  twelve(occAtAudit.occupancy) === twelve(Number(auditRow.occupancy)),
  `metrics=${twelve(occAtAudit.occupancy)} 夜审=${twelve(Number(auditRow.occupancy))}`
);

/* ---- ③ 解锁那 2 间（昨天锁房 → 今天解锁） ---- */
const unlocked = run(`UPDATE rooms SET status = 'VC' WHERE hotel_id = ? AND status = 'LOCK'`, [HOTEL]).changes;
const currentSellable = Number(one(AUDIT_SELLABLE_SQL, [HOTEL]).sellable);
check(
  `解锁 ${LOCK_ROOMS} 间成功，当前可售房量从 8 变成 ${currentSellable}（房态确实变了）`,
  Number(unlocked) === LOCK_ROOMS && currentSellable === ROOM_TOTAL,
  JSON.stringify({ unlocked, currentSellable })
);

/* ---- ④ ★ 评审核心：再算 D 的出租率，必须和夜审时一致 ---- */
const occAfterUnlock = occupancyOfDay(HOTEL, D);
check(
  `★ 解锁后 D（${D}）的出租率**不变**：${twelve(occAtAudit.occupancy)} === ${twelve(occAfterUnlock.occupancy)}`,
  twelve(occAfterUnlock.occupancy) === twelve(occAtAudit.occupancy),
  `夜审时 ${twelve(occAtAudit.occupancy)} → 解锁后 ${twelve(occAfterUnlock.occupancy)}`
);
check(
  `★ 解锁后 D 的分母仍是 8（旧口径会变成 ${ROOM_TOTAL}）`,
  occAfterUnlock.sellableRooms === ROOM_TOTAL - LOCK_ROOMS &&
    occAfterUnlock.sellableRoomNights === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify({ sellableRooms: occAfterUnlock.sellableRooms, nights: occAfterUnlock.sellableRoomNights })
);
check(
  `★ 反向证明：若按旧口径（当前房态 ${currentSellable} 当分母）D 会变成 ${twelve(GUEST_ROOMS / currentSellable)} ≠ ${twelve(occAtAudit.occupancy)}`,
  twelve(GUEST_ROOMS / currentSellable) !== twelve(occAtAudit.occupancy) &&
    twelve(occAtAudit.occupancy) === twelve(GUEST_ROOMS / (ROOM_TOTAL - LOCK_ROOMS)),
  `旧口径 6/${currentSellable} = ${twelve(GUEST_ROOMS / currentSellable)}`
);
check(
  "解锁后 D 的 ADR / RevPAR 也不变（分母换了，派生指标不能跟着漂）",
  twelve(occAfterUnlock.adr) === twelve(occAtAudit.adr) &&
    twelve(occAfterUnlock.revpar) === twelve(occAtAudit.revpar),
  JSON.stringify({ adr: occAfterUnlock.adr, revpar: occAfterUnlock.revpar })
);
check(
  "解锁后 D 的 estimated = false（已夜审的日子不可能被标「估算」）",
  occAfterUnlock.estimated === false && occAfterUnlock.estimatedDays.length === 0,
  JSON.stringify({ estimated: occAfterUnlock.estimated, days: occAfterUnlock.estimatedDays })
);
const dayInfo = historicalSellable(HOTEL, D, D).get(D);
check(
  "D 的分母来源 = 夜审快照（source = audit / basis = night-audit / live = false）",
  dayInfo?.source === "audit" && dayInfo?.basis === "night-audit" && dayInfo?.live === false && dayInfo?.sellable === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify(dayInfo)
);
check(
  "单日区间调用与 occupancyOfDay 完全一致（不会出现两套口径）",
  twelve(occupancyMetrics(HOTEL, D, D).occupancy) === twelve(occAfterUnlock.occupancy) &&
    occupancyMetrics(HOTEL, D, D).sellableRoomNights === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify(occupancyMetrics(HOTEL, D, D))
);

/* ============================================================ C. 缺历史值 → 提示估算 */

console.log(`\n=== C. 缺夜审快照的历史日（D2 = ${D2}）→ 出租率必须标 estimated: true ===`);

const d2 = historicalSellable(HOTEL, D2, D2).get(D2);
check(
  `D2 没有当日夜审快照 → source = "estimate"（不是 audit）`,
  d2?.source === "estimate" && d2?.live === false,
  JSON.stringify(d2)
);
check(
  `D2 分母来自最近一次夜审快照（basis = neighbor-night-audit，值 = ${ROOM_TOTAL - LOCK_ROOMS}，不是当前房态 ${currentSellable}）`,
  d2?.basis === "neighbor-night-audit" && d2?.sellable === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify(d2)
);
const occD2 = occupancyOfDay(HOTEL, D2);
check(
  "D2 的 OccupancyMetrics.estimated = true，且 estimatedDays 正好列出这一天",
  occD2.estimated === true && occD2.estimatedDays.length === 1 && occD2.estimatedDays[0] === D2,
  JSON.stringify({ estimated: occD2.estimated, days: occD2.estimatedDays })
);
check(
  "D2 的出租率按「可售 8」算（不是按当前 10），且没有 NaN",
  occD2.sellableRooms === ROOM_TOTAL - LOCK_ROOMS && Number.isFinite(occD2.occupancy),
  JSON.stringify({ sellable: occD2.sellableRooms, occ: occD2.occupancy })
);

const range = occupancyMetrics(HOTEL, D2, D);
check(
  `区间 ${D2} ~ ${D}：可售房晚 = 8 + 8 = ${(ROOM_TOTAL - LOCK_ROOMS) * 2}（逐日累加，不是 平均值 × 天数）`,
  range.sellableRoomNights === (ROOM_TOTAL - LOCK_ROOMS) * 2 && range.sellableRooms === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify({ capacityNights: range.sellableRoomNights, sellableRooms: range.sellableRooms })
);
check(
  `区间出租率 = ${GUEST_ROOMS} 间夜 / ${(ROOM_TOTAL - LOCK_ROOMS) * 2} 可售房晚`,
  twelve(range.occupancy) === twelve(GUEST_ROOMS / ((ROOM_TOTAL - LOCK_ROOMS) * 2)),
  `实际 ${twelve(range.occupancy)}`
);
check(
  `区间 estimated = true，estimatedDays = [${D2}]（只有缺快照的那一天被标）`,
  range.estimated === true && range.estimatedDays.length === 1 && range.estimatedDays[0] === D2,
  JSON.stringify(range.estimatedDays)
);

const today = historicalSellable(HOTEL, TODAY, TODAY).get(TODAY);
check(
  `今天（${TODAY}）还没夜审：live = true / basis = current-rooms / 分母 = 当前 ${currentSellable}`,
  today?.live === true && today?.basis === "current-rooms" && today?.sellable === currentSellable,
  JSON.stringify(today)
);
check(
  "今天的出租率不算「缺历史值估算」（estimated = false）",
  occupancyOfDay(HOTEL, TODAY).estimated === false,
  JSON.stringify({ estimated: occupancyOfDay(HOTEL, TODAY).estimated })
);

/* 提示文案（报表缺历史值时直接展示，评审要求的「提示估算」） */
const hintAudited = estimatedHint(occAfterUnlock);
const hintD2 = estimatedHint(occD2);
const hintRange = estimatedHint(range);
check(
  "已夜审的日子不出估算提示（estimatedHint === null）",
  hintAudited === null,
  String(hintAudited)
);
check(
  `缺快照的日子给出提示文案，并且点名 ${D2}`,
  typeof hintD2 === "string" && hintD2.includes(D2) && hintD2.includes("估算"),
  String(hintD2)
);
check(
  "区间提示只点名估算的那一天（不会把已夜审的 D 也列进去）",
  typeof hintRange === "string" && hintRange.includes(D2) && !hintRange.includes(`${D}、`) && hintRange === hintD2,
  String(hintRange)
);

/* ============================================================ D. 隔离与脏数据 */

console.log("\n=== D. 隔离 / 脏数据：别家店的快照不串店，反解不出来的行不当快照 ===");

/* 别家店：2 间房、夜审快照可售 2（用同一天 D2 造快照，考验 hotel_id 过滤） */
const otherTypeId = Number(
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
    OTHER,
    "OTH",
    "隔离房型",
    200,
    2,
    1,
  ]).lastInsertRowid
);
for (let i = 1; i <= 2; i += 1) {
  run(`INSERT INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort) VALUES (?,?,?,?,?,?)`, [
    OTHER,
    otherTypeId,
    `O${i}`,
    1,
    "VC",
    1,
  ]);
}
run(`INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, occupancy, operator, created_at) VALUES (?,?,?,?,?,?,?)`, [
  OTHER,
  D2,
  "DONE",
  1,
  0.5, // 可售 2
  "别家夜审",
  AT(D2, "23:59:00"),
]);
const d2Other = historicalSellable(HOTEL, D2, D2).get(D2);
check(
  `别家店（${OTHER}）在 ${D2} 的快照可售 2，但不影响本店：本店仍取 ${ROOM_TOTAL - LOCK_ROOMS}`,
  d2Other?.sellable === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify(d2Other)
);
check(
  "别家店自己的分母也算得对（可售 2，source = audit）",
  historicalSellable(OTHER, D2, D2).get(D2)?.sellable === 2 &&
    historicalSellable(OTHER, D2, D2).get(D2)?.source === "audit",
  JSON.stringify(historicalSellable(OTHER, D2, D2).get(D2))
);

/* 脏数据 1：rooms_sold = 0 / occupancy = 0 → 0/0 反解不出分母，不能当快照 */
run(`INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, occupancy, operator, created_at) VALUES (?,?,?,?,?,?,?)`, [
  HOTEL,
  GAP_NO_SOLD,
  "DONE",
  0,
  0,
  "空记录",
  AT(GAP_NO_SOLD, "23:59:00"),
]);
const noSold = historicalSellable(HOTEL, GAP_NO_SOLD, GAP_NO_SOLD).get(GAP_NO_SOLD);
check(
  `rooms_sold = 0 的夜审行（${GAP_NO_SOLD}）不被当成快照：source = estimate 且没有 NaN/Infinity`,
  noSold?.source === "estimate" && Number.isFinite(noSold?.sellable) && noSold?.sellable > 0,
  JSON.stringify(noSold)
);

/* 脏数据 2：rooms_sold = 5 / occupancy = 2 → 反解可售 3 < 已售 5，物理不成立 → 拒用 */
run(`INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, occupancy, operator, created_at) VALUES (?,?,?,?,?,?,?)`, [
  HOTEL,
  GAP_BAD_PAIR,
  "DONE",
  5,
  2,
  "脏数据",
  AT(GAP_BAD_PAIR, "23:59:00"),
]);
const badPair = historicalSellable(HOTEL, GAP_BAD_PAIR, GAP_BAD_PAIR).get(GAP_BAD_PAIR);
check(
  `「可售 3 < 已售 5」的脏行（${GAP_BAD_PAIR}）被拒用：source = estimate，分母回到可用的快照`,
  badPair?.source === "estimate" && badPair?.basis === "neighbor-night-audit" && badPair?.sellable === ROOM_TOTAL - LOCK_ROOMS,
  JSON.stringify(badPair)
);

/* 空店：没有房间也没有快照 → 分母 0、basis none、出租率 0，不能崩 */
const emptyDay = historicalSellable(EMPTY, D, D).get(D);
const emptyOcc = occupancyOfDay(EMPTY, D);
check(
  "空店（没有房间）→ basis = none / 分母 0 / 出租率 0（除零不炸）",
  emptyDay?.basis === "none" &&
    emptyDay?.sellable === 0 &&
    emptyOcc.sellableRoomNights === 0 &&
    emptyOcc.occupancy === 0 &&
    emptyOcc.revpar === 0,
  JSON.stringify({ day: emptyDay, occ: emptyOcc.occupancy })
);

/* 反向日期（from > to）不应该死循环 / 少算成空 Map */
const reversed = historicalSellable(HOTEL, D, D2);
check(
  "区间首尾颠倒（from > to）也只返回 1 天，不崩",
  reversed.size === 1 && reversed.has(D),
  `size=${reversed.size}`
);

/* ============================================================ E. 真库零写入 */

console.log("\n=== E. 真库零写入（所有造数都在 VACUUM INTO 副本里）===");

try {
  const real = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    const realHotels = real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id IN (?,?,?)`).get(HOTEL, OTHER, EMPTY).c;
    const realRooms = real.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id IN (?,?,?)`).get(HOTEL, OTHER, EMPTY).c;
    const realStays = real.prepare(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id IN (?,?,?)`).get(HOTEL, OTHER, EMPTY).c;
    const realAudits = real.prepare(`SELECT COUNT(*) AS c FROM night_audits WHERE hotel_id IN (?,?,?)`).get(HOTEL, OTHER, EMPTY).c;
    check(
      `真库没有被写入测试酒店（${HOTEL}/${OTHER}/${EMPTY} = 0）`,
      Number(realHotels) === 0,
      `实际 ${realHotels}`
    );
    check("真库没有被写入测试房间 / 入住单 / 夜审行", Number(realRooms) === 0 && Number(realStays) === 0 && Number(realAudits) === 0, JSON.stringify({ realRooms, realStays, realAudits }));
  } finally {
    real.close();
  }
} catch (e) {
  check("真库复查（只读打开）", false, String(e?.message ?? e));
}

/* ============================================================ 汇总 */

function six(n) {
  return Number(n).toFixed(6);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("失败项：");
  for (const name of failures) console.log(`  · ${name}`);
  process.exitCode = 1;
} else {
  console.log("✅ 跨期出租率分母（历史可售房晚）验收通过：锁房→夜审→解锁，出租率不变；缺快照的日子标估算");
}
