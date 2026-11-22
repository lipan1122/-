#!/usr/bin/env node
/**
 * 直连订单角标 / 悬浮列表状态集合验收
 * 整改清单 P0-2（第四节第 2 项）
 *
 * ── 缺陷背景（清单第 39-43 行）──
 * 房态页底部功能条「直连订单」的角标原来只看 `status = 'PENDING'`，
 * 而 channel_orders 实际写入的状态是 NEW / CONFIRMED / IMPORTING / IMPORTED / CANCELLED，
 * **PENDING 一条都没有** → 新订单进来角标一直是 0，前台看不到有单要接。
 * 而且角标和它点开的悬浮列表是两处各写一份 SQL，口径容易再次分叉。
 *
 * ── 本脚本验什么 ──
 *   1. 源码里的状态集合常量就是 NEW + CONFIRMED + PENDING，
 *      且排除 IMPORTING / IMPORTED / CANCELLED / REJECTED；
 *   2. 角标 SQL 与悬浮列表 SQL **都**引用同一个占位符常量（没有第二份硬编码状态列表）；
 *   3. 真库（VACUUM INTO 副本）里造 7 条状态各异的订单，跑**从源码里抠出来的两条 SQL**：
 *      角标计数 = 3，且两条 SQL 返回的 id 集合逐条相同；
 *   4. 新单进 NEW / CONFIRMED 立即计入，转成 IMPORTED 后立即退出；
 *   5. 用真演示库的 1222 条渠道订单验证：老实现（只看 PENDING）会显示 0，
 *      新实现显示 16（NEW 6 + CONFIRMED 10）—— 这条断言就是「角标为 0」那个 bug 的回归网。
 *
 * ── 为什么不是 grep 完事 ──
 *  状态集合是脚本从 rooms/page.tsx 里**解析出来**的，SQL 也是从源码里**抠出来的模板**，
 *  然后在 SQLite 上真执行 —— 源码里改坏了状态集合或改坏了 SQL，这里的数字立刻变。
 *
 * ── 怎么「真正打开数据库并执行」 ──
 *  `VACUUM INTO` 把 data/pms.db 复制到 .tmp/ 临时库（源库只读打开，**绝不改真库**），
 *  所有造数据/改状态都在副本上；结束删掉副本（含 -wal / -shm）并复查真库零写入。
 *
 * 运行：node scripts/test-channel-order-badge-status.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const TAG = "channel-order-badge";
/** 验收专用酒店：真库只有 1 号店，这里造 990002 专用于角标口径 */
const HOTEL = 990002;
const NOW = new Date().toISOString();

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

copyToTempDb();

let conn;
try {
  conn = new DatabaseSync(TMP_DB);
  conn.exec("PRAGMA busy_timeout = 5000");
} catch (e) {
  abandon(`打不开临时库：${TMP_DB}`, String(e?.message ?? e));
}

const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);

/* ============================================================ 一、从源码解析状态集合与两条 SQL */

console.log("=== 一、源码：状态集合常量 + 角标 SQL / 悬浮列表 SQL（rooms/page.tsx） ===");

const PAGE_REL = path.join("src", "app", "(main)", "rooms", "page.tsx");
const pageSrc = fs.readFileSync(path.join(ROOT, PAGE_REL), "utf8");

/** 1.1 解析 CHANNEL_ORDER_PENDING_STATUSES 常量 */
const constMatch = pageSrc.match(/CHANNEL_ORDER_PENDING_STATUSES\s*=\s*\[([^\]]*)\]\s*as\s+const/);
const pendingStatuses = constMatch ? [...constMatch[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]) : [];
console.log(`  rooms/page.tsx 待处理状态集合 = [${pendingStatuses.join(", ")}]`);

check(
  "状态集合恰为 NEW + CONFIRMED + PENDING（清单第 40 行）",
  pendingStatuses.length === 3 && ["NEW", "CONFIRMED", "PENDING"].every((s) => pendingStatuses.includes(s)),
  `实际 [${pendingStatuses.join(", ")}]`
);
const EXCLUDED = ["IMPORTING", "IMPORTED", "CANCELLED", "REJECTED"];
const leaked = EXCLUDED.filter((s) => pendingStatuses.includes(s));
check(
  "状态集合排除了 IMPORTING / IMPORTED / CANCELLED / REJECTED（清单第 41 行）",
  leaked.length === 0,
  `混入了 ${leaked.join(", ")}`
);
check(
  "状态集合常量在源码里只定义一次（口径只有一份）",
  (pageSrc.match(/CHANNEL_ORDER_PENDING_STATUSES\s*=\s*\[/g) ?? []).length === 1
);

/** 1.2 从源码里抠出两条 SQL 模板（都含 ${CHANNEL_ORDER_PENDING_IN} 占位符） */
const SQL_TEMPLATE_RE = /`([^`]*\$\{CHANNEL_ORDER_PENDING_IN\}[^`]*)`/g;
const sqlTemplates = [...pageSrc.matchAll(SQL_TEMPLATE_RE)].map((m) => m[1]);
const badgeRaw = sqlTemplates.find((s) => /COUNT\(\s*\*\s*\)/i.test(s) && /channel_orders/i.test(s));
const listRaw = sqlTemplates.find((s) => /FROM\s+channel_orders\s+o/i.test(s));

check("源码里能解析出「角标计数 SQL」（COUNT(*) + channel_orders）", Boolean(badgeRaw), `解析到 ${sqlTemplates.length} 条占位符 SQL`);
check("源码里能解析出「悬浮列表 SQL」（FROM channel_orders o ... 共用同一占位符）", Boolean(listRaw));
check(
  "两条 SQL 都在源码里出现且都引用 ${CHANNEL_ORDER_PENDING_IN}（不是各写一份状态列表）",
  sqlTemplates.length >= 2 && Boolean(badgeRaw) && Boolean(listRaw),
  `实际 ${sqlTemplates.length} 处`
);

if (!badgeRaw || !listRaw || pendingStatuses.length === 0) {
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  conn.close();
  cleanup();
  process.exit(1);
}

/** 把模板里的占位符换成 ? ，参数顺序与源码一致：[hotelId, ...状态集合] */
function materialize(raw) {
  return raw.replace("${CHANNEL_ORDER_PENDING_IN}", pendingStatuses.map(() => "?").join(","));
}
const badgeSql = materialize(badgeRaw);
const listSql = materialize(listRaw);
const paramsOf = (hotelId) => [hotelId, ...pendingStatuses];

/** 角标计数（跑源码里的 SQL） */
function badgeCount(hotelId) {
  const row = conn.prepare(badgeSql).get(...paramsOf(hotelId));
  return Number(row?.n ?? row?.[Object.keys(row ?? {})[0]] ?? 0);
}
/** 悬浮列表（跑源码里的 SQL） */
function badgeList(hotelId) {
  return conn.prepare(listSql).all(...paramsOf(hotelId));
}

/* ============================================================ 二、造 7 条状态各异的订单 */

console.log("\n=== 二、造 7 条状态各异的渠道订单（待处理 3 条 / 非待处理 4 条） ===");

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL,
  "TEST990002",
  "角标口径验收酒店",
  "测试地址",
  "000",
  NOW,
]);

/** 造一条渠道订单，返回 id */
function seedOrder(orderNo, status, guestName = "角标验收客人") {
  return Number(
    run(
      `INSERT INTO channel_orders (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
                                   check_in_date, check_out_date, nights, room_count, amount, status, booking_id, raw, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [HOTEL, "ctrip", orderNo, null, guestName, "13800000000", "2026-12-01", "2026-12-02", 1, 1, 300, status, null, "{}", NOW]
    ).lastInsertRowid
  );
}

/** 状态 → 是否应计入待处理（与清单第 40/41 行一致） */
const STATUS_CASES = [
  ["PENDING", true], // 历史/兼容写法：仍待处理
  ["NEW", true], // 建表默认值 / 拉单落库：新单待处理
  ["CONFIRMED", true], // 渠道已确认但还没转预订：仍待前台处理
  ["IMPORTING", false], // 转入预订中间态
  ["IMPORTED", false], // 已转预订，处理完
  ["CANCELLED", false], // 渠道已取消
  ["REJECTED", false], // 清单点名要排除（当前无写入点，仍要保证排除）
];
const ids = {};
for (const [status] of STATUS_CASES) {
  ids[status] = seedOrder(`BADGE-${status}-1`, status, `角标测试-${status}`);
}
const totalRows = Number(all(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ?`, [HOTEL])[0].c);
check("测试酒店共写入 7 条渠道订单（7 种状态各 1 条）", totalRows === 7, `实际 ${totalRows} 条`);

const expectedIds = STATUS_CASES.filter(([, counted]) => counted).map(([s]) => ids[s]).sort((a, b) => a - b);
const excludedIds = STATUS_CASES.filter(([, counted]) => !counted).map(([s]) => ids[s]).sort((a, b) => a - b);

/* ============================================================ 三、角标计数 = 3 */

console.log("\n=== 三、角标计数（跑源码里的 COUNT SQL） ===");

const badge = badgeCount(HOTEL);
check("角标计数 = 3（NEW + CONFIRMED + PENDING，清单第 40 行）", badge === 3, `实际 ${badge}`);
check(
  "老实现（只数 status = 'PENDING'）会得到 1 —— 这正是「只数 PENDING」不可用的证据",
  Number(all(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND status = 'PENDING'`, [HOTEL])[0].c) === 1
);
check(
  "非待处理的 4 条（IMPORTING/IMPORTED/CANCELLED/REJECTED）确实都在库里",
  Number(all(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND id IN (${excludedIds.map(() => "?").join(",")})`, [HOTEL, ...excludedIds])[0].c) === 4
);

/* ============================================================ 四、悬浮列表与角标同集合 */

console.log("\n=== 四、悬浮列表 SQL 与角标 SQL 返回同一集合（清单第 39 行） ===");

const list = badgeList(HOTEL);
const listIds = list.map((r) => Number(r.id)).sort((a, b) => a - b);
check("悬浮列表返回 3 条（与角标数一致）", list.length === 3, `实际 ${list.length} 条`);
check(
  "列表 id 集合 = 角标计入的 id 集合（逐条比对）",
  listIds.length === expectedIds.length && listIds.every((id, i) => id === expectedIds[i]),
  `列表 [${listIds.join(",")}] vs 期望 [${expectedIds.join(",")}]`
);
check(
  "列表里没有任何非待处理状态的订单 id",
  listIds.every((id) => !excludedIds.includes(id)),
  `混入了 ${listIds.filter((id) => excludedIds.includes(id)).join(",")}`
);
/*
 * 「同一个状态集合」的运行时证据：两条 SQL 的参数个数都必须恰好是 1(hotel_id) + N(状态)。
 * 做法：按源码的传参顺序跑一遍（必须成功），再**多传一个**参数
 *      （node:sqlite 对多出的参数会抛 "column index out of range"，少传则静默绑 NULL，
 *        所以「多传必报错」才是精确的参数个数证据）。
 * 若哪条 SQL 里又硬编码了一份状态列表（占位符变少），多传参数就不会报错 → 断言失败。
 */
function exactParamBinding(sql) {
  try {
    conn.prepare(sql).all(...paramsOf(HOTEL));
  } catch {
    return false;
  }
  try {
    conn.prepare(sql).all(...paramsOf(HOTEL), "__extra__");
    return false; // 多传一个还能跑 → 参数个数与状态集合对不上
  } catch {
    return true;
  }
}
check(
  "两条 SQL 的参数个数都恰好是 1(hotel_id) + 3(状态)，共用同一个占位符常量（没有第二份硬编码状态列表）",
  exactParamBinding(badgeSql) && exactParamBinding(listSql),
  `badge=${exactParamBinding(badgeSql)} / list=${exactParamBinding(listSql)}`
);
check(
  "列表行的展示字段可用（标题 = 渠道单号 · 客人名，副标题含房型/入住日/状态中文）",
  list.every((r) => typeof r.title === "string" && r.title.length > 0 && typeof r.sub === "string" && r.sub.length > 0),
  JSON.stringify(list[0] ?? {})
);

/* ============================================================ 五、新单即时显示 / 转预订后即时消失 */

console.log("\n=== 五、新订单进入 NEW 立即显示，转成 IMPORTED 立即消失（清单第 42 行） ===");

const freshId = seedOrder("BADGE-FRESH-1", "NEW", "角标测试-新单");
check("新增 1 条 NEW 订单 → 角标 = 4（房态页立即能看到）", badgeCount(HOTEL) === 4, `实际 ${badgeCount(HOTEL)}`);
check("新增 NEW 订单立即出现在悬浮列表里", badgeList(HOTEL).some((r) => Number(r.id) === freshId));

run(`UPDATE channel_orders SET status = 'IMPORTED', booking_id = NULL, imported_at = ? WHERE hotel_id = ? AND id = ?`, [
  NOW,
  HOTEL,
  freshId,
]);
check("该单转成 IMPORTED → 角标回落到 3", badgeCount(HOTEL) === 3, `实际 ${badgeCount(HOTEL)}`);
check("该单不再出现在悬浮列表里", !badgeList(HOTEL).some((r) => Number(r.id) === freshId));

/* 状态分布必须写测试（清单第 43 行）：逐个状态核对「计入 / 不计入」 */
const distribution = all(`SELECT status, COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? GROUP BY status`, [HOTEL]);
const distMap = Object.fromEntries(distribution.map((r) => [r.status, Number(r.c)]));
check(
  "状态分布：7 种状态各 1 条（NEW 1 / CONFIRMED 1 / PENDING 1 / IMPORTING 1 / IMPORTED 2 / CANCELLED 1 / REJECTED 1）",
  distMap.NEW === 1 &&
    distMap.CONFIRMED === 1 &&
    distMap.PENDING === 1 &&
    distMap.IMPORTING === 1 &&
    distMap.IMPORTED === 2 &&
    distMap.CANCELLED === 1 &&
    distMap.REJECTED === 1,
  JSON.stringify(distMap)
);
check(
  "计入集合的每一条状态都真的被 SQL 数到（逐状态独立验证）",
  STATUS_CASES.every(([status, counted]) => {
    const inSqlSet = pendingStatuses.includes(status);
    const inListSet = conn
      .prepare(listSql)
      .all(...paramsOf(HOTEL))
      .some((row) => Number(row.id) === ids[status]);
    // 计入 = 状态在 SQL 集合里 且 真的出现在悬浮列表结果里；不计入 = 两者都不成立
    return counted ? inSqlSet && inListSet : !inSqlSet && !inListSet;
  }),
  STATUS_CASES.map(([s, c]) => `${s}:${c ? "计入" : "排除"}`).join(" ")
);

/* ============================================================ 六、真演示数据：老实现 0，新实现 16 */

console.log("\n=== 六、真演示库（hotel 1，1222 条渠道订单）：老实现 0 vs 新实现 16 ===");

const h1Badge = badgeCount(1);
const h1New = Number(all(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = 1 AND status = 'NEW'`)[0].c);
const h1Confirmed = Number(all(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = 1 AND status = 'CONFIRMED'`)[0].c);
const h1Pending = Number(all(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = 1 AND status = 'PENDING'`)[0].c);
const h1List = badgeList(1);

check(
  `hotel 1 角标 = NEW(${h1New}) + CONFIRMED(${h1Confirmed}) + PENDING(${h1Pending}) = ${h1New + h1Confirmed + h1Pending}`,
  h1Badge === h1New + h1Confirmed + h1Pending,
  `实际 ${h1Badge}`
);
check(
  "老实现（只数 PENDING）在真库上会显示 0 —— 新订单不显示的 bug 会被这条断言抓住",
  h1Pending === 0 && h1Badge > 0,
  `PENDING=${h1Pending} / 新实现=${h1Badge}`
);
check(
  "真库角标大于 0（前台能看到有待处理单）",
  h1Badge > 0,
  String(h1Badge)
);
check(
  "真库悬浮列表按 LIMIT 8 截断（列表最多 8 条，角标数保持完整）",
  h1List.length === Math.min(8, h1Badge),
  `list=${h1List.length} / badge=${h1Badge}`
);
check(
  "列表里的每一条都属于计入集合（IMPORTED/CANCELLED 等历史单没混进待处理列表）",
  h1List.every((r) => {
    const row = all(`SELECT status FROM channel_orders WHERE id = ?`, [Number(r.id)])[0];
    return row && pendingStatuses.includes(row.status);
  })
);

/* ============================================================ 七、租户隔离 + 真库零写入 */

console.log("\n=== 七、租户隔离 + 真库零写入 ===");

check(
  "hotel 990002 的 7 条订单不影响 hotel 1 的角标（角标 SQL 带 hotel_id）",
  badgeCount(1) === h1Badge,
  `改前 ${h1Badge} / 改后 ${badgeCount(1)}`
);

const real = new DatabaseSync(REAL_DB, { readOnly: true });
try {
  const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL).c);
  const leakedOrders = Number(real.prepare(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ?`).get(HOTEL).c);
  check("真库没有被写入测试酒店（990002 号店 = 0）", leakedHotel === 0, `实际 ${leakedHotel}`);
  check("真库没有被写入测试渠道订单（channel_orders = 0）", leakedOrders === 0, `实际 ${leakedOrders}`);
} finally {
  real.close();
}

/* ============================================================ 汇总 */

console.log(`\n通过 ${pass} / 失败 ${fail}`);
conn.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
