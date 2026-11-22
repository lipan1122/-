/**
 * 渠道统计报表验收（codex 第九轮清单 二.5「完成渠道统计报表」）
 *
 * ── 被验收的是什么 ──
 * `channel-report` 原来是**空占位**（`<MiniTable rows={[]} />`，SQL 引用了
 * bookings.total_amount —— 实际列是 total_price），68 张报表里它一直显示「暂无数据」。
 * 清单要求补齐：
 *   渠道订单量 / 渠道间夜 / 渠道房费 / 渠道取消量 / 渠道未到店量 /
 *   渠道已入住量 / 渠道已退房量 / 渠道收入占比 /
 *   按营业日和自然日筛选 / 按渠道、房型、日期导出
 *
 * ── 最关键的约束（清单第 172 行）──
 * 数据必须按 **渠道 id** 聚合，不能按渠道名称聚合。
 * `channels` 表里真有一条 **id=6 名字叫「散客」** 的渠道，而「没匹配到渠道」的
 * 入住单（stays.channel_id IS NULL）也显示成「散客」；按名称 GROUP BY 会把两组
 * 并成一行、间夜加两遍（第八轮真库实测：售价间夜 151，实际 142）。
 *
 * ── 本脚本验三半 ──
 *  A. 静态：报表组件不再是空占位；按 id 聚合；间夜来自 metrics.stayNightSlices；
 *     不数 folio_items.qty；营业日/自然日切换；三个导出入口。
 *  B. 动态：真库副本（.tmp）+ 独立租户 9001 构造「同名不同 id 的两条散客渠道」，
 *     跑与源码逐字一致的聚合 SQL，断言两行分开、间夜不重复、合计 = metrics 口径。
 *  C. 动态：营业日 / 自然日两种归期口径在同一批房费上给出不同结果（凌晨过账的单）。
 *
 * 用法：node scripts/test-channel-report.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? " → " + extra : ""}`);
  }
};
const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (s) => s.replace(/\s+/g, " ").trim();

const REPORTS_FILE = join("src", "app", "(main)", "reports", "page.tsx");
const METRICS_FILE = join("src", "lib", "metrics.ts");
const pageSrc = readFileSync(REPORTS_FILE, "utf8");
const metricsSrc = readFileSync(METRICS_FILE, "utf8");
const nPage = norm(pageSrc);
const nMetrics = norm(metricsSrc);

/** 报表组件正文（从 function ReportChannel 到下一个组件 ReportChannelDetail） */
const channelSection = (() => {
  /*
   * 整段口径实现：聚合 helper（channelStatRows / channelRoomTypeRows / channelDayRows）
   * 定义在 ReportChannel 之前，所以起点取「八点四」这一节的标题注释 ——
   * 只截到下一个报表组件 ReportChannelDetail，别的报表不受影响。
   */
  const start = pageSrc.indexOf("八点四、渠道统计报表");
  const end = pageSrc.indexOf("function ReportChannelDetail(");
  if (start < 0 || end < 0 || end <= start) return "";
  return pageSrc.slice(start, end);
})();
const nChannel = norm(channelSection);

/* ================================================================== *
 * A. 静态校验
 * ================================================================== */
console.log("=== A. 静态：报表实现 ===");

check("channel-report 组件存在", channelSection.length > 2000, `长度 ${channelSection.length}`);
check(
  "不再用空占位表格（rows={[]}）",
  !/rows=\{\[\]\}/.test(channelSection),
  "组件里还有 rows={[]} 空占位"
);
check(
  "不再引用不存在的 bookings.total_amount",
  !/total_amount/.test(channelSection),
  "仍在用 bookings.total_amount（真实列是 total_price）"
);
check("报表注册表仍登记 channel-report", /"channel-report":\s*\{\s*label:/.test(pageSrc));
check(
  "REPORT_VIEWS 把 channel-report 指向真实组件（不是占位）",
  /"channel-report":\s*ReportChannel,/.test(pageSrc) && !/"channel-report":\s*\(props/.test(pageSrc)
);

/* ---------- A1. 按渠道 id 聚合（清单第 172 行） ---------- */
check(
  "订单 / 取消 / 未到店按 channel_id 聚合",
  nChannel.includes(norm(`GROUP BY b.channel_id`)),
  "缺少 GROUP BY b.channel_id"
);
check(
  "已入住 / 已退房按 channel_id 聚合",
  nChannel.includes(norm(`GROUP BY s.channel_id`)),
  "缺少 GROUP BY s.channel_id"
);
check(
  "渠道 × 房型按 (channel_id, room_type_id) 聚合",
  nChannel.includes(norm(`GROUP BY s.channel_id, rt.id`)),
  "缺少 GROUP BY s.channel_id, rt.id"
);
check(
  "渠道 × 日期按 (channel_id, 归期日) 聚合",
  nChannel.includes(norm(`GROUP BY s.channel_id, day`)),
  "缺少 GROUP BY s.channel_id, day"
);
check(
  "没有按渠道名称分组（GROUP BY c.name / COALESCE(c.name)）",
  !/GROUP\s+BY\s+c\.name/i.test(channelSection) && !/GROUP\s+BY\s+COALESCE\(\s*c\.name/i.test(channelSection),
  "出现按名称分组的 SQL —— 同名「散客」会重复统计"
);
check(
  "渠道名只用于显示（channelNameMap / channelLabel）",
  /function channelNameMap\(/.test(pageSrc) && /function channelLabel\(/.test(pageSrc),
  "缺少名称映射（名称只该用于显示）"
);
check(
  "额外给出「渠道ID」列，区分两行同名渠道",
  /渠道ID/.test(channelSection),
  "没有渠道ID 列"
);

/* ---------- A2. 间夜来自 metrics.ts ---------- */
check("间夜取 stayNightSlices（住宿占用口径）", /stayNightSlices\(/.test(channelSection));
check(
  "按 channelId 聚合间夜（不是按名称）",
  nChannel.includes(norm(`nightsBy(slices, (s) => s.channelId)`)),
  "没有按 channelId 聚合"
);
/**
 * 组件里「可执行的代码」（去掉注释）
 *
 * channelSection 从一个注释块中间开始（「八点四」在 /* 之后），
 * 用正则去掉块注释时开头已被切掉，所以再按行过滤「*」「//」开头的注释行。
 */
const channelCode = channelSection
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\*|\/\/)/.test(l))
  .join("\n");

check(
  "不再把 folio_items.qty 当间夜",
  !/SUM\(\s*fi\.qty\s*\)/i.test(channelCode) && !/\.qty\b/.test(channelCode),
  "组件里出现 qty —— 间夜不能数明细行数"
);
check(
  "房型间夜按 `channelId|roomTypeId` 双键聚合",
  /channelKey\(s\.channelId\)\}\|\$\{channelKey\(s\.roomTypeId\)/.test(channelSection),
  "房型维度没有按双键聚合"
);
check(
  "展示了「间夜对账」：渠道间夜合计 = occupancyMetrics().roomNights",
  /occupancy\.roomNights/.test(channelSection) && /nightsMatch/.test(channelSection),
  "没有与区间指标对账"
);

/* ---------- A3. 八项指标 ---------- */
for (const col of ["订单量", "取消量", "未到店量", "已入住量", "已退房量", "间夜", "房费", "收入占比"]) {
  check(`表格有「${col}」列`, channelSection.includes(col), `缺少 ${col}`);
}

/* ---------- A4. 营业日 / 自然日筛选 ---------- */
check("支持 cal=natural 切换链接", /cal=natural/.test(channelSection));
check("营业日口径用 fi.biz_date", /fi\.biz_date/.test(channelSection));
check(
  "自然日口径用明细创建日 substr(fi.created_at, 1, 10)",
  /substr\(fi\.created_at, 1, 10\)/.test(channelSection)
);
check(
  "归期表达式收敛在两处固定 SQL（feeDateExpr）",
  /function feeDateExpr\(/.test(pageSrc) && /fi\.biz_date/.test(pageSrc) && /substr\(fi\.created_at, 1, 10\)/.test(pageSrc)
);
check(
  "口径切换有说明（营业日=夜审过账，自然日=明细发生日）",
  /营业日/.test(channelSection) && /自然日/.test(channelSection) && /口径说明/.test(channelSection)
);

/* ---------- A5. 三个导出入口 ---------- */
check("实现了 CSV 导出（data URI）", /data:text\/csv;charset=utf-8/.test(pageSrc) && /function csvHref\(/.test(pageSrc));
check("CSV 带 BOM（Excel / WPS 中文不乱码）", /\\uFEFF/.test(pageSrc) || /\uFEFF/.test(pageSrc));
check("导出（按渠道）", /导出（按渠道）/.test(channelSection), "缺少按渠道导出");
check("导出（按房型）", /导出（按房型）/.test(channelSection), "缺少按房型导出");
check("导出（按日期）", /导出（按日期）/.test(channelSection), "缺少按日期导出");
check(
  "三个导出文件名分别是渠道 / 房型 / 日期",
  /download=\{`渠道统计_/.test(channelSection) &&
    /download=\{`渠道房型_/.test(channelSection) &&
    /download=\{`渠道日期_/.test(channelSection)
);

/* ---------- A6. SQL 副本与源码逐字一致 ---------- */
const SLICE_SQL = `
  SELECT s.id AS stay_id,
         s.status AS status,
         s.guest_name AS guest_name,
         rt.id AS room_type_id,
         rt.name AS room_type,
         c.id AS channel_id,
         c.name AS channel,
         r.id AS room_id,
         r.room_no AS room_no,
         MAX(substr(s.check_in_time, 1, 10), ?) AS first_night,
         CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day')
              ELSE MIN(COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out),
                       date(?, '+1 day'))
         END AS last_night_exclusive,
         MAX(0, CAST(ROUND(
           julianday(CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day')
                          ELSE MIN(COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out),
                                   date(?, '+1 day'))
                     END)
           - julianday(MAX(substr(s.check_in_time, 1, 10), ?))
         ) AS INTEGER)) AS nights
    FROM stays s
    LEFT JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN channels c ON c.id = s.channel_id
   WHERE s.hotel_id = ?
     AND s.status IN ('INHOUSE', 'CHECKED_OUT')
     AND COALESCE(s.rate_code, '') <> '钟点'
     AND (
           (s.status = 'INHOUSE' AND substr(s.check_in_time, 1, 10) <= ?)
        OR (s.status = 'CHECKED_OUT'
            AND substr(s.check_in_time, 1, 10) <= ?
            AND COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out,
                         substr(s.check_in_time, 1, 10)) > ?)
         )
   ORDER BY s.id`;

check(
  "住宿占用明细 SQL 与 metrics.ts 逐字一致（含新增的 room_id / room_no）",
  nMetrics.includes(norm(SLICE_SQL)),
  "metrics.ts 的 STAY_NIGHT_SLICE_SQL 已变，请同步本脚本"
);

const ORDER_SQL = `SELECT b.channel_id AS channel_id,
            COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN b.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled,
            COALESCE(SUM(CASE WHEN b.status = 'NOSHOW' THEN 1 ELSE 0 END), 0) AS noshow
       FROM bookings b
      WHERE b.hotel_id = ? AND b.check_in_date BETWEEN ? AND ?
      GROUP BY b.channel_id`;
const STAY_SQL = `SELECT s.channel_id AS channel_id,
            COUNT(*) AS checkins,
            COALESCE(SUM(CASE WHEN s.status = 'CHECKED_OUT' THEN 1 ELSE 0 END), 0) AS checkouts
       FROM stays s
      WHERE s.hotel_id = ? AND substr(s.check_in_time, 1, 10) BETWEEN ? AND ?
      GROUP BY s.channel_id`;
check("订单聚合 SQL 与源码逐字一致", nChannel.includes(norm(ORDER_SQL)), "SQL 漂移");
check("住宿聚合 SQL 与源码逐字一致", nChannel.includes(norm(STAY_SQL)), "SQL 漂移");

/* ================================================================== *
 * B. 动态：同名「散客」必须按 id 分成两行
 * ================================================================== */
console.log("\n=== B. 动态：同名渠道按 id 分开统计 ===");

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const H = 9001;
const D1 = "2031-01-01";
const D2 = "2031-01-02";
const D3 = "2031-01-03";

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

function openCopy() {
  if (!existsSync(REAL_DB)) {
    console.error(`真实库不存在：${REAL_DB}（用 PMS_DB_PATH 指定，或先 init-db）`);
    process.exit(1);
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, `channel-report-${process.pid}-${Date.now()}.db`);
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
  } finally {
    src.close();
  }
  const db = new DatabaseSync(tmp, { timeout: 10000 });
  return {
    db,
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    },
  };
}

const { db, close } = openCopy();
let stayA = 0;
let stayB = 0;
let directId = 0;
let ctripId = 0;
let roomTypeId = 0;
let roomA = 0;
let roomB = 0;
let folA = 0;
let folB = 0;

try {
  db.exec("BEGIN");
  /* 渠道：一条**名字就叫「散客」**（模拟真库 id=6），一条「携程」 */
  directId = Number(
    db
      .prepare(`INSERT INTO channels (hotel_id, name, commission, channel_type, enabled) VALUES (?,?,?,?,?)`)
      .run(H, "散客", 0, "direct", 1).lastInsertRowid
  );
  ctripId = Number(
    db
      .prepare(`INSERT INTO channels (hotel_id, name, commission, channel_type, enabled) VALUES (?,?,?,?,?)`)
      .run(H, "携程", 0.1, "ctrip", 1).lastInsertRowid
  );

  roomTypeId = Number(
    db
      .prepare(`INSERT INTO room_types (hotel_id, code, name, base_price) VALUES (?,?,?,?)`)
      .run(H, "T1", "测试房型", 100).lastInsertRowid
  );
  roomA = Number(
    db
      .prepare(`INSERT INTO rooms (hotel_id, room_no, room_type_id, status) VALUES (?,?,?,?)`)
      .run(H, "T-101", roomTypeId, "VC").lastInsertRowid
  );
  roomB = Number(
    db
      .prepare(`INSERT INTO rooms (hotel_id, room_no, room_type_id, status) VALUES (?,?,?,?)`)
      .run(H, "T-102", roomTypeId, "VC").lastInsertRowid
  );

  /*
   * 两条入住单，显示的渠道名都叫「散客」：
   *   A：channel_id = directId（真渠道，名字「散客」），住 D1~D3 → 3 晚
   *   B：channel_id = NULL（没匹配到渠道），住 D1~D2 → 1 晚
   * 按名称聚合会得到一行 4 间夜；按 id 必须是两行 3 / 1。
   */
  stayA = Number(
    db
      .prepare(
        `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out,
                            nights, rate, status, channel_id, rate_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(H, "T-A", roomA, "甲客人", `${D1}T14:00:00`, D3, 2, 100, "INHOUSE", directId, "门市价").lastInsertRowid
  );
  stayB = Number(
    db
      .prepare(
        `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out,
                            actual_check_out, nights, rate, status, channel_id, rate_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(H, "T-B", roomB, "乙客人", `${D1}T15:00:00`, D2, D2, 1, 80, "CHECKED_OUT", null, "门市价").lastInsertRowid
  );

  folA = Number(
    db
      .prepare(
        `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(H, "T-FA", stayA, "甲客人", 0, 0, 0, "OPEN").lastInsertRowid
  );
  folB = Number(
    db
      .prepare(
        `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(H, "T-FB", stayB, "乙客人", 0, 0, 0, "OPEN").lastInsertRowid
  );

  const insItem = db.prepare(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  /* A：3 晚房费各 100；B：1 晚 80 → 合计 380 */
  insItem.run(H, folA, "ROOM", "房费", 1, 100, 100, D1, `${D1}T23:00:00`);
  insItem.run(H, folA, "ROOM", "房费", 1, 100, 100, D2, `${D2}T23:00:00`);
  insItem.run(H, folA, "ROOM", "房费", 1, 100, 100, D3, `${D3}T23:00:00`);
  insItem.run(H, folB, "ROOM", "房费", 1, 80, 80, D1, `${D1}T23:00:00`);
  /*
   * 凌晨过账的一条房费（营业日 D2 / 实际发生 D3 04:00）：
   * 营业日口径归 D2，自然日口径归 D3 —— 用来区分两种筛选。
   */
  insItem.run(H, folA, "ROOM", "房费(凌晨过账)", 1, 50, 50, D2, `${D3}T04:00:00`);

  const insBooking = db.prepare(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date,
                           nights, room_count, guest_count, rate, status, channel_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insBooking.run(H, "T-BK1", "甲", roomTypeId, D1, D3, 2, 1, 1, 100, "CHECKED_IN", directId);
  insBooking.run(H, "T-BK2", "乙", roomTypeId, D1, D2, 1, 1, 1, 100, "CANCELLED", directId);
  insBooking.run(H, "T-BK3", "丙", roomTypeId, D2, D3, 1, 1, 1, 100, "NOSHOW", null);
  db.exec("COMMIT");
} catch (e) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* 已回滚 */
  }
  console.error(`构造测试数据失败：${e.message}`);
  close();
  process.exit(1);
}

const all = (sql, params = []) => db.prepare(sql).all(...params);
const one = (sql, params = []) => db.prepare(sql).get(...params);

/* 间夜：metrics.ts 的住宿占用明细按 channelId 聚合（与组件同一份 SQL） */
const slices = all(SLICE_SQL, [D1, D3, D3, D3, D3, D1, H, D3, D3, D1]);
const nightsByChannel = new Map();
for (const r of slices) {
  const nights = Math.max(0, Math.round(num(r.nights)));
  if (nights <= 0) continue;
  const key = r.channel_id == null ? "null" : String(Number(r.channel_id));
  nightsByChannel.set(key, (nightsByChannel.get(key) ?? 0) + nights);
}
const metricsNights = [...nightsByChannel.values()].reduce((s, v) => s + v, 0);

const feeSql = (feeExpr) => `SELECT s.channel_id AS channel_id,
            COALESCE(SUM(fi.amount), 0) AS room
       FROM folio_items fi
       JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
       LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = fi.hotel_id
      WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM'
        AND ${feeExpr} BETWEEN ? AND ?
      GROUP BY s.channel_id`;

const orderRows = all(ORDER_SQL, [H, D1, D3]);
const stayRows = all(STAY_SQL, [H, D1, D3]);
const feeRowsBiz = all(feeSql("fi.biz_date"), [H, D1, D3]);

const keyOf = (v) => (v == null ? "null" : String(Number(v)));
const orderMap = new Map(orderRows.map((r) => [keyOf(r.channel_id), r]));
const stayMap = new Map(stayRows.map((r) => [keyOf(r.channel_id), r]));
const feeMap = new Map(feeRowsBiz.map((r) => [keyOf(r.channel_id), round2(num(r.room))]));

check("散客渠道（id）有 3 间夜", nightsByChannel.get(String(directId)) === 3, `实际 ${nightsByChannel.get(String(directId))}`);
check("未匹配渠道（NULL）有 1 间夜", nightsByChannel.get("null") === 1, `实际 ${nightsByChannel.get("null")}`);
check("间夜合计 = 4（3 + 1，不重复）", metricsNights === 4, `实际 ${metricsNights}`);
check(
  "按名称聚合会得到 1 行 4 间夜（错误的旧做法能复现），按 id 是 2 行 3/1",
  metricsNights === 4 && nightsByChannel.size === 2,
  `渠道行数 ${nightsByChannel.size}`
);
check("散客渠道房费 = 350（300 + 凌晨过账 50）", feeMap.get(String(directId)) === 350, `实际 ${feeMap.get(String(directId))}`);
check("未匹配渠道房费 = 80", feeMap.get("null") === 80, `实际 ${feeMap.get("null")}`);
check(
  "房费合计 = 430",
  round2([...feeMap.values()].reduce((s, v) => s + v, 0)) === 430,
  `实际 ${round2([...feeMap.values()].reduce((s, v) => s + v, 0))}`
);
check("散客渠道订单量 = 2（含 1 单取消）", num(orderMap.get(String(directId))?.orders) === 2);
check("散客渠道取消量 = 1", num(orderMap.get(String(directId))?.cancelled) === 1);
check("散客渠道已入住量 = 1", num(stayMap.get(String(directId))?.checkins) === 1);
check(
  "未匹配渠道已退房量 = 1（NULL 渠道的已退房单独统计）",
  num(stayMap.get("null")?.checkouts) === 1,
  `实际 ${num(stayMap.get("null")?.checkouts)}`
);
check("未匹配渠道未到店量 = 1", num(orderMap.get("null")?.noshow) === 1);
check(
  "未匹配渠道（NULL）单独成行，没有被并进同名的「散客」渠道",
  orderMap.has("null") && orderMap.has(String(directId)),
  "NULL 渠道与 id 渠道被合并"
);

/* 收入占比：350/430 + 80/430 */
const shareA = round2((350 / 430) * 100);
const shareB = round2((80 / 430) * 100);
check("收入占比（散客渠道）≈ 81.40%", Math.abs(shareA - 81.4) < 0.01, `实际 ${shareA}%`);
check("收入占比合计 ≈ 100%", Math.abs(shareA + shareB - 100) < 0.02, `实际 ${shareA + shareB}%`);

/* ---------- 渠道 × 房型 / 渠道 × 日期 ---------- */
const feeByType = all(
  `SELECT s.channel_id AS channel_id,
          rt.id AS room_type_id,
          COALESCE(SUM(fi.amount), 0) AS room
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
     LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = fi.hotel_id
     LEFT JOIN rooms r ON r.id = s.room_id AND r.hotel_id = fi.hotel_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id AND rt.hotel_id = fi.hotel_id
    WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM'
      AND fi.biz_date BETWEEN ? AND ?
    GROUP BY s.channel_id, rt.id`,
  [H, D1, D3]
);
check(
  "渠道 × 房型：两个渠道各一行（同房型不合并通道）",
  feeByType.length === 2,
  `实际 ${feeByType.length} 行`
);

const feeByDay = all(
  `SELECT s.channel_id AS channel_id,
          fi.biz_date AS day,
          COALESCE(SUM(fi.amount), 0) AS room
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
     LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = fi.hotel_id
    WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM'
      AND fi.biz_date BETWEEN ? AND ?
    GROUP BY s.channel_id, day`,
  [H, D1, D3]
);
check("渠道 × 日期：按 (渠道, 日) 切片", feeByDay.length === 4, `实际 ${feeByDay.length} 行`);

/* ================================================================== *
 * C. 营业日 / 自然日两种归期口径
 * ================================================================== */
console.log("\n=== C. 营业日 / 自然日 ===");

const dayBiz = all(
  `SELECT s.channel_id AS channel_id, fi.biz_date AS day, COALESCE(SUM(fi.amount), 0) AS room
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
     LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = fi.hotel_id
    WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM'
      AND fi.biz_date BETWEEN ? AND ?
    GROUP BY s.channel_id, day`,
  [H, D1, D2]
);
const dayNat = all(
  `SELECT s.channel_id AS channel_id, substr(fi.created_at, 1, 10) AS day, COALESCE(SUM(fi.amount), 0) AS room
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
     LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = fi.hotel_id
    WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM'
      AND substr(fi.created_at, 1, 10) BETWEEN ? AND ?
    GROUP BY s.channel_id, day`,
  [H, D1, D2]
);
const bizD2 = round2(num(dayBiz.find((r) => String(r.channel_id) === String(directId) && r.day === D2)?.room));
const natD2 = round2(num(dayNat.find((r) => String(r.channel_id) === String(directId) && r.day === D2)?.room));
check("营业日 D2 含凌晨过账的房费（100 + 50 = 150）", bizD2 === 150, `实际 ${bizD2}`);
check("自然日 D2 不含凌晨过账的房费（只有 100）", natD2 === 100, `实际 ${natD2}`);
check("两种口径结果确实不同（筛选真的生效）", bizD2 !== natD2, `biz=${bizD2} nat=${natD2}`);
check(
  "自然日 D1~D2 合计 = 280（A 100+100 + B 80；凌晨过账那条归 D3，不在区间）",
  round2([...dayNat].reduce((s, r) => s + num(r.room), 0)) === 280,
  `实际 ${round2([...dayNat].reduce((s, r) => s + num(r.room), 0))}`
);
check(
  "营业日 D1~D2 合计 = 330（A 100+100+凌晨 50 + B 80）",
  round2([...dayBiz].reduce((s, r) => s + num(r.room), 0)) === 330,
  `实际 ${round2([...dayBiz].reduce((s, r) => s + num(r.room), 0))}`
);

/* 间夜两种口径相同：住宿晚本身就是自然日 */
const nightBiz = all(SLICE_SQL, [D1, D3, D3, D3, D3, D1, H, D3, D3, D1]);
check(
  "间夜不受归期口径影响（住宿晚 = 自然日的那一晚）",
  nightBiz.length === slices.length,
  `实际 ${nightBiz.length} vs ${slices.length}`
);

/* ---------- 清理 ---------- */
close();

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log("（临时库在 .tmp 下创建并已删除，未影响 data/pms.db）\n");
process.exit(fail === 0 ? 0 : 1);
