/**
 * 渠道同步能力验收（整改清单 4.1 / 4.2）
 *
 * 验证目标：
 *   1. 4.2 字段：channel_sync_logs 的 8 个新列（request_no / channel_order_no /
 *      finished_at / duration_ms / success_count / fail_count / booking_id / folio_id）
 *      以及 (hotel_id, request_no)、(hotel_id, channel_order_no) 两个索引存在。
 *   2. 4.1 前置：channel_sync_queue 表 + idx_sync_queue_pending 索引存在。
 *   3. invokeWithLog：真实跑一次沙箱推送，断言日志里写入 request_no（UUID）、
 *      finished_at、duration_ms、success_count / fail_count，并且 meta 里的
 *      渠道单号 / 预订 / 账单关联落库；失败调用写入 fail_count = 1。
 *   4. 幂等：同一个 channel_order_no 连续 upsert 两次，channel_orders 只有 1 条；
 *      第二次返回 inserted=false 且不会带出可建预订的信号。
 *   5. 超售策略：oversell=0 时 allotment 负数 clamp 到 0；oversell=1 时保留负数；
 *      非法值按 0 处理。
 *   6. markStockDirty：写 channel_sync_queue（kind=PUSH_RATES / status=PENDING / attempts=0）。
 *   7. 业务层调用点：sync-actions.ts 的 4 个 action 存在且走 invokeWithLog；
 *      page.tsx 用 <form action={...}> 绑定了「推送房量 / 拉取订单 / 测试连接」。
 *   8. 全程不发真实网络请求（globalThis.fetch 被拦截并计数，最后断言为 0）。
 *   9. 测试数据零残留：开头先清一次（保证重复跑也不累积），结尾删净并复查为 0。
 *
 * 运行：node scripts/test-channel-sync.mjs
 * 环境：Node ≥ 22.18（原生剥离 TS 类型）+ registerHooks 解析 `@/` 别名；
 *       本机 Node 24.22.3 已验证通过。
 *
 * 说明：本脚本只使用 hotel_id = 990001 这一条「假酒店」的数据，
 *       不读写任何真实酒店的渠道配置 / 订单 / 日志；结束前全部删除。
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB_FILE = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
/** 验收专用酒店 id：远离真实门店，且所有断言都以它为过滤条件 */
const TEST_HOTEL = 990001;
const TEST_ORDER_NO = "TEST-SYNC-0001";

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

/** Node 在 .ts 上会提示「package.json 没有 type: module」，属于噪音，过滤掉 */
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* ============================================================ 禁止真实网络 */

let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  return Promise.reject(new Error("验收脚本禁止真实网络请求，fetch 已被拦截"));
};

/* 让 Node 能解析 Next 的 `@/` 路径别名（指向项目 src 目录） */
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

/* ============================================================ 数据库 */

let db;
try {
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA busy_timeout = 5000");
} catch (e) {
  console.error(`无法打开数据库 ${DB_FILE}：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const exec = (sql, p = []) => db.prepare(sql).run(...p);
const hasTable = (name) =>
  Number(one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name = ?`, [name]).c) > 0;
const hasIndex = (name) =>
  Number(one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name = ?`, [name]).c) > 0;
const colsOf = (table) => {
  try {
    return new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
  } catch {
    return new Set();
  }
};

/* ---------- 测试数据清理（开头 + 结尾都跑，保证重复执行不残留） ---------- */

const TEST_SCOPED_TABLES = [
  "channel_sync_logs",
  "channel_orders",
  "channel_sync_queue",
  "channels",
  // 房量口径验证用（5b）：测试房型 / 房间 / 预订 / 房价日历
  "rooms",
  "room_types",
  "bookings",
  "rate_calendar",
];

const clean = () => {
  for (const table of TEST_SCOPED_TABLES) {
    try {
      exec(`DELETE FROM ${table} WHERE hotel_id = ?`, [TEST_HOTEL]);
    } catch {
      // 表还没迁移时忽略：后面的检查会把「缺表」明确报出来
    }
  }
};

const residue = () => {
  const out = {};
  for (const table of TEST_SCOPED_TABLES) {
    try {
      out[table] = Number(one(`SELECT COUNT(*) AS c FROM ${table} WHERE hotel_id = ?`, [TEST_HOTEL]).c);
    } catch {
      out[table] = 0;
    }
  }
  return out;
};

clean();

/* ============================================================ 一、4.2 字段与索引 */

console.log("\n=== 一、channel_sync_logs 整改 4.2 字段（请求编号 / 订单号 / 时间 / 数量 / 关联） ===");

const NEW_LOG_COLS = [
  "request_no", // 请求编号（每次同步一个 UUID）
  "channel_order_no", // 渠道订单号
  "finished_at", // 结束时间
  "duration_ms", // 耗时
  "success_count", // 成功数量
  "fail_count", // 失败数量
  "booking_id", // 关联 PMS 预订
  "folio_id", // 关联账单
];
const logCols = colsOf("channel_sync_logs");
for (const column of NEW_LOG_COLS) {
  check(`channel_sync_logs.${column} 存在`, logCols.has(column), `现有列：${[...logCols].join(",")}`);
}
// 计数列必须带默认值 0：老行不会因为 NULL 参与统计时被当成异常
const colInfo = Object.fromEntries(all(`PRAGMA table_info(channel_sync_logs)`).map((c) => [c.name, c]));
check(
  "success_count / fail_count 默认值为 0",
  String(colInfo.success_count?.dflt_value ?? "") === "0" && String(colInfo.fail_count?.dflt_value ?? "") === "0",
  `success_count=${colInfo.success_count?.dflt_value}, fail_count=${colInfo.fail_count?.dflt_value}`
);
check("idx_sync_logs_request 索引存在", hasIndex("idx_sync_logs_request"));
check("idx_sync_logs_channel_order 索引存在", hasIndex("idx_sync_logs_channel_order"));

/* ============================================================ 二、4.1 队列表 */

console.log("\n=== 二、channel_sync_queue 待同步队列（房态回传前置） ===");

check("channel_sync_queue 表存在", hasTable("channel_sync_queue"));
const queueCols = colsOf("channel_sync_queue");
const EXPECT_QUEUE_COLS = ["id", "hotel_id", "kind", "reason", "status", "attempts", "created_at", "done_at"];
check(
  "channel_sync_queue 列齐全",
  EXPECT_QUEUE_COLS.every((c) => queueCols.has(c)),
  `缺：${EXPECT_QUEUE_COLS.filter((c) => !queueCols.has(c)).join(",")}`
);
check("idx_sync_queue_pending 索引存在", hasIndex("idx_sync_queue_pending"));

/* ============================================================ 三、载入生产代码 */

console.log("\n=== 三、invokeWithLog 写入请求编号 / 结束时间 / 耗时 / 成功失败数 ===");

const { invokeWithLog } = await import("../src/lib/channels/invoke.ts");
const { getAdapter } = await import("../src/lib/channels/index.ts");
const { buildRateRows, markStockDirty, toChannelAllotment, upsertChannelOrder } = await import(
  "../src/lib/channels/stock-trigger.ts"
);

/** 造一条验收专用渠道：不填 app_secret → buildChannelConfig 自动进沙箱，绝不会发真实请求 */
exec(
  `INSERT INTO channels (hotel_id, name, channel_type, enabled, auto_import, oversell)
   VALUES (?,?,?,?,?,?)`,
  [TEST_HOTEL, "验收测试渠道", "sandbox", 1, 0, 0]
);
const testChannelId = Number(one(`SELECT id FROM channels WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [TEST_HOTEL]).id);
check("验收用渠道已落库", Number.isFinite(testChannelId) && testChannelId > 0);

/* ---------- 3a. 成功推送：2 条接受、1 条负库存被拒 ---------- */
const rows = [
  { channelRoomTypeCode: "RT-A", date: "2026-12-01", allotment: 5, price: 300, closed: false },
  { channelRoomTypeCode: "RT-B", date: "2026-12-01", allotment: 0, price: 400, closed: true },
  { channelRoomTypeCode: "RT-C", date: "2026-12-01", allotment: -2, price: 500, closed: false },
];
const meta = { channelOrderNo: TEST_ORDER_NO, bookingId: 4321, folioId: 8765 };
const pushResult = await invokeWithLog(
  testChannelId,
  TEST_HOTEL,
  "PUSH_RATES",
  (cfg) => getAdapter(cfg.channelType).pushRates(cfg, rows),
  meta
);
check("沙箱推送返回 ok=true", pushResult.ok === true, JSON.stringify(pushResult));
if (pushResult.ok) {
  check(
    "沙箱按约定接受 2 条 / 拒绝 1 条（负库存）",
    pushResult.data.accepted === 2 && pushResult.data.rejected.length === 1,
    JSON.stringify(pushResult.data)
  );
}

const pushLog = one(
  `SELECT * FROM channel_sync_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`,
  [TEST_HOTEL]
);
check("同步日志已写入", Boolean(pushLog));
if (pushLog) {
  check(
    "request_no 是 UUID 且非空",
    typeof pushLog.request_no === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pushLog.request_no),
    String(pushLog.request_no)
  );
  check("finished_at 有值且不早于 created_at", Boolean(pushLog.finished_at) && pushLog.finished_at >= pushLog.created_at);
  check(
    "duration_ms 是 >= 0 的整数",
    Number.isInteger(pushLog.duration_ms) && pushLog.duration_ms >= 0,
    String(pushLog.duration_ms)
  );
  check("success_count = 2（accepted）", Number(pushLog.success_count) === 2, String(pushLog.success_count));
  check("fail_count = 1（rejected.length）", Number(pushLog.fail_count) === 1, String(pushLog.fail_count));
  check("channel_order_no 来自 meta", pushLog.channel_order_no === TEST_ORDER_NO, String(pushLog.channel_order_no));
  check("booking_id 来自 meta", Number(pushLog.booking_id) === 4321, String(pushLog.booking_id));
  check("folio_id 来自 meta", Number(pushLog.folio_id) === 8765, String(pushLog.folio_id));
  check("状态成功时 error_code 为空", pushLog.error_code === null || pushLog.error_code === undefined);
}

/* ---------- 3b. 不传 meta 也能跑（向后兼容）：拉单空数组 → 0/0 ---------- */
const pullResult = await invokeWithLog(testChannelId, TEST_HOTEL, "PULL_ORDERS", (cfg) =>
  getAdapter(cfg.channelType).pullOrders(cfg, "2026-01-01T00:00:00.000Z")
);
const pullLog = one(`SELECT * FROM channel_sync_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [TEST_HOTEL]);
check("不传 meta 的调用也能正常落日志（向后兼容）", pullResult.ok === true && Boolean(pullLog?.request_no));
check(
  "PULL_ORDERS 的 success_count = 订单条数（沙箱 0 条）",
  Number(pullLog?.success_count) === 0 && Number(pullLog?.fail_count) === 0,
  `${pullLog?.success_count}/${pullLog?.fail_count}`
);

/* ---------- 3c. 失败调用：渠道不存在 → NOT_CONFIGURED 且 fail_count = 1 ---------- */
const failResult = await invokeWithLog(99999999, TEST_HOTEL, "PUSH_RATES", (cfg) =>
  getAdapter(cfg.channelType).pushRates(cfg, rows)
);
const failLog = one(`SELECT * FROM channel_sync_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [TEST_HOTEL]);
check("不存在渠道返回 NOT_CONFIGURED", failResult.ok === false && failResult.code === "NOT_CONFIGURED");
check(
  "失败日志 fail_count = 1 / success_count = 0 / error_code 有值",
  Number(failLog?.fail_count) === 1 &&
    Number(failLog?.success_count) === 0 &&
    failLog?.error_code === "NOT_CONFIGURED" &&
    Boolean(failLog?.request_no),
  JSON.stringify({ fc: failLog?.fail_count, sc: failLog?.success_count, ec: failLog?.error_code })
);

/* ============================================================ 四、幂等 */

console.log("\n=== 四、渠道订单幂等（同一 channel_order_no 拉两次只留 1 条） ===");

const payload = {
  channelOrderNo: TEST_ORDER_NO,
  roomTypeCode: "RT-A",
  guestName: "验收测试客人",
  mobile: "13800000000",
  checkInDate: "2026-12-01",
  checkOutDate: "2026-12-02",
  nights: 1,
  roomCount: 1,
  amount: 300,
  statusRaw: "NEW",
  raw: { source: "acceptance-test" },
  createdAt: null,
};

const first = upsertChannelOrder(TEST_HOTEL, "sandbox", payload);
const second = upsertChannelOrder(TEST_HOTEL, "sandbox", payload);
const orderCount = Number(
  one(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND channel_order_no = ?`, [TEST_HOTEL, TEST_ORDER_NO]).c
);

check("第一次 upsert 返回 inserted=true", first.inserted === true, JSON.stringify(first));
check("第二次 upsert 返回 inserted=false（幂等跳过）", second.inserted === false, JSON.stringify(second));
check("两次拉取后 channel_orders 只有 1 条", orderCount === 1, `实际 ${orderCount} 条`);
check("第二次命中的是同一行记录", first.orderId !== null && first.orderId === second.orderId, `${first.orderId} vs ${second.orderId}`);
check("已有行不会带出可建预订的信号（bookingId 为空）", second.bookingId === null, String(second.bookingId));

/* 空单号不产生幂等键 → 必须拒绝写入，否则会攒出一堆无法对账的脏数据 */
const emptyNo = upsertChannelOrder(TEST_HOTEL, "sandbox", { ...payload, channelOrderNo: "   " });
const emptyCount = Number(
  one(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND (channel_order_no IS NULL OR TRIM(channel_order_no) = '')`, [
    TEST_HOTEL,
  ]).c
);
check("空渠道单号被拒绝落库", emptyNo.inserted === false && emptyCount === 0, `空单号 ${emptyCount} 条`);

/* ============================================================ 五、房量与超售策略 */

console.log("\n=== 五、房量口径 + 超售策略（真实数据：房间数 - 在住/已排 - 维修房） ===");

check("oversell=0：-3 → 0（严格不卖超）", toChannelAllotment(-3, false) === 0, String(toChannelAllotment(-3, false)));
check("oversell=1：-3 → -3（保留超售额度）", toChannelAllotment(-3, true) === -3, String(toChannelAllotment(-3, true)));
check("oversell=0：5 → 5（正库存原样）", toChannelAllotment(5, false) === 5, String(toChannelAllotment(5, false)));
check("oversell=1：5 → 5（正库存原样）", toChannelAllotment(5, true) === 5, String(toChannelAllotment(5, true)));
check("非法值（NaN）→ 0，不往渠道推 NaN", toChannelAllotment(Number.NaN, true) === 0, String(toChannelAllotment(Number.NaN, true)));
check("小数向下取整：2.9 → 2", toChannelAllotment(2.9, false) === 2, String(toChannelAllotment(2.9, false)));

/* ---------- 5b. 用真实数据跑一遍 buildRateRows（生产代码，不是脚本里的副本） ---------- */
const testRoomTypeId = Number(
  exec(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort)
     VALUES (?,?,?,?,?,?,?)`,
    [TEST_HOTEL, "TEST-RT", "验收测试房型", "大床", 2, 200, 999]
  ).lastInsertRowid
);
// 3 间房，其中 1 间维修（OOO）：物理可售上限 3，扣掉维修后实际只能卖 2
const roomA = Number(
  exec(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
    TEST_HOTEL,
    "TEST-A",
    9,
    testRoomTypeId,
    "VC",
    1,
  ]).lastInsertRowid
);
exec(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
  TEST_HOTEL,
  "TEST-B",
  9,
  testRoomTypeId,
  "VC",
  2,
]);
exec(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
  TEST_HOTEL,
  "TEST-C",
  9,
  testRoomTypeId,
  "OOO",
  3,
]);
// 未排房预订（room_id 为空）：12-01 住 1 晚，占 1 间
exec(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, check_in_date, check_out_date, nights, room_count, status, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [TEST_HOTEL, `BK-TESTSYNC-${Date.now()}-1`, "验收未排房客人", testRoomTypeId, null, "2026-12-01", "2026-12-02", 1, 1, "CONFIRMED", new Date().toISOString()]
);
// 已排具体房间的预订：12-02 住 1 晚，占 TEST-A 1 间（走 occupied 分支）
exec(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, check_in_date, check_out_date, nights, room_count, status, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [TEST_HOTEL, `BK-TESTSYNC-${Date.now()}-2`, "验收已排房客人", testRoomTypeId, roomA, "2026-12-02", "2026-12-03", 1, 1, "CONFIRMED", new Date().toISOString()]
);
// 12-03 一张 5 间的团队单：3 间房卖 5 间 → 必然为负（验证超售策略）
exec(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_id, check_in_date, check_out_date, nights, room_count, status, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [TEST_HOTEL, `BK-TESTSYNC-${Date.now()}-3`, "验收团队单", testRoomTypeId, null, "2026-12-03", "2026-12-04", 1, 5, "CONFIRMED", new Date().toISOString()]
);
// 房价日历：12-01 配 555，其余天回退房型基准价 200
exec(`INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, updated_at) VALUES (?,?,?,?,?)`, [
  TEST_HOTEL,
  testRoomTypeId,
  "2026-12-01",
  555,
  new Date().toISOString(),
]);

const rowsStrict = buildRateRows(TEST_HOTEL, "sandbox", "2026-12-01", 3, false);
const rowsOversell = buildRateRows(TEST_HOTEL, "sandbox", "2026-12-01", 3, true);
const byDate = (rows, day) => rows.find((r) => r.date === day);

check("buildRateRows 输出 3 天 × 1 房型 = 3 行", rowsStrict.length === 3, `实际 ${rowsStrict.length} 行`);
check(
  "12-01：3 间 - 1 间未排房预订 - 1 间维修 = 1",
  byDate(rowsStrict, "2026-12-01")?.allotment === 1,
  String(byDate(rowsStrict, "2026-12-01")?.allotment)
);
check(
  "12-02：已排房预订占 1 间 + 维修 1 间 → 1（占用走 room_id 分支）",
  byDate(rowsStrict, "2026-12-02")?.allotment === 1,
  String(byDate(rowsStrict, "2026-12-02")?.allotment)
);
check(
  "oversell=0：12-03 超卖（3-5-1=-3）clamp 到 0",
  byDate(rowsStrict, "2026-12-03")?.allotment === 0,
  String(byDate(rowsStrict, "2026-12-03")?.allotment)
);
check(
  "oversell=1：12-03 保留 -3（还能再卖超 3 间）",
  byDate(rowsOversell, "2026-12-03")?.allotment === -3,
  String(byDate(rowsOversell, "2026-12-03")?.allotment)
);
check(
  "满房（0 间）标记关房 closed=true；负数是超售，不算关房",
  byDate(rowsStrict, "2026-12-03")?.closed === true && byDate(rowsOversell, "2026-12-03")?.closed === false
);
check(
  "价格优先取 rate_calendar（12-01 = 555），没配置的天回退 base_price（12-02 = 200）",
  byDate(rowsStrict, "2026-12-01")?.price === 555 && byDate(rowsStrict, "2026-12-02")?.price === 200,
  `${byDate(rowsStrict, "2026-12-01")?.price}/${byDate(rowsStrict, "2026-12-02")?.price}`
);
check(
  "没配渠道房型映射时用本地房型 code 兜底（不推空编码）",
  byDate(rowsStrict, "2026-12-01")?.channelRoomTypeCode === "TEST-RT",
  String(byDate(rowsStrict, "2026-12-01")?.channelRoomTypeCode)
);

/* 业务层确实用了这套口径（静态校验：不能在 action 里各自再写一套 max(0, x)） */
const syncActionsSource = fs.readFileSync(path.join(ROOT, "src/app/(main)/channels/sync-actions.ts"), "utf8");
const stockTriggerSource = fs.readFileSync(path.join(ROOT, "src/lib/channels/stock-trigger.ts"), "utf8");
check(
  "stock-trigger.ts 实现统一超售口径（oversell 分支 + clamp）",
  stockTriggerSource.includes("toChannelAllotment") && stockTriggerSource.includes("Math.max(0, whole)")
);
check(
  "sync-actions.ts 调用 stock-trigger 的 buildRateRows（口径只有一份）",
  syncActionsSource.includes("buildRateRows(") && syncActionsSource.includes('from "@/lib/channels/stock-trigger"')
);
check(
  "sync-actions.ts 读取 channels.oversell 并传入超售策略",
  syncActionsSource.includes("ch.oversell") && syncActionsSource.includes("oversell")
);

/* ============================================================ 六、markStockDirty */

console.log("\n=== 六、markStockDirty 写入待同步队列 ===");

const beforeQueue = Number(one(`SELECT COUNT(*) AS c FROM channel_sync_queue WHERE hotel_id = ?`, [TEST_HOTEL]).c);
markStockDirty(TEST_HOTEL, "验收：改房态 301 → OOO");
markStockDirty(TEST_HOTEL, "验收：订单 BK8001 取消");
const queueRows = all(`SELECT * FROM channel_sync_queue WHERE hotel_id = ? ORDER BY id`, [TEST_HOTEL]);
check("markStockDirty 写入 2 条任务", queueRows.length === beforeQueue + 2, `实际 ${queueRows.length} 条`);
check(
  "任务字段正确（kind=PUSH_RATES / status=PENDING / attempts=0）",
  queueRows.every((r) => r.kind === "PUSH_RATES" && r.status === "PENDING" && Number(r.attempts) === 0)
);
check(
  "reason 记录了变化来源",
  queueRows.some((r) => String(r.reason ?? "").includes("改房态")) &&
    queueRows.some((r) => String(r.reason ?? "").includes("订单"))
);
check("created_at 有值", queueRows.every((r) => typeof r.created_at === "string" && r.created_at.length >= 10));

/* ============================================================ 七、业务层调用点 */

console.log("\n=== 七、业务层调用点（4.1 的核心缺口：适配器有没有人调） ===");

for (const action of ["pushRatesAction", "pullOrdersAction", "pushOrderStatusAction"]) {
  check(
    `sync-actions.ts 导出 ${action}`,
    new RegExp(`export\\s+async\\s+function\\s+${action}\\s*\\(`).test(syncActionsSource)
  );
}
check(
  "sync-actions.ts 通过 invokeWithLog 调用适配器",
  (syncActionsSource.match(/invokeWithLog\(/g) ?? []).length >= 3 && syncActionsSource.includes("getAdapter(")
);
check(
  "sync-actions.ts 拉单走幂等落库 upsertChannelOrder",
  syncActionsSource.includes("upsertChannelOrder(")
);

const channelsPageSource = fs.readFileSync(path.join(ROOT, "src/app/(main)/channels/page.tsx"), "utf8");
check("channels/page.tsx 绑定「推送房量」按钮", channelsPageSource.includes("pushChannelRatesAction"));
check("channels/page.tsx 绑定「拉取订单」按钮", channelsPageSource.includes("pullChannelOrdersAction"));
check("channels/page.tsx 绑定「测试连接」按钮", channelsPageSource.includes("testConnectionSyncAction"));
check(
  "channels/page.tsx 展示最近一次同步结果（成功/失败条数）",
  channelsPageSource.includes("success_count") && channelsPageSource.includes("fail_count")
);

/* ============================================================ 八、清理与残留 */

console.log("\n=== 八、测试数据清理（重复跑也必须零残留） ===");

clean();
const left = residue();
check(
  "验收数据零残留（同步日志 / 渠道订单 / 队列 / 渠道 / 房间 / 房型 / 预订 / 房价日历）",
  Object.values(left).every((n) => n === 0),
  JSON.stringify(left)
);
check("全程没有发出真实网络请求（fetch 调用次数 = 0）", fetchCalls === 0, `fetch 被调用 ${fetchCalls} 次`);

/* ============================================================ 汇总 */

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
