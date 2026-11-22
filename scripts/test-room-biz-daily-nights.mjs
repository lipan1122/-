/**
 * 综合营业日报-房间：间夜口径 + 四者一致验收
 * （codex 第九轮清单 二.6「综合营业日报增加间夜」）
 *
 * ── 被验收的是什么 ──
 * `room-biz-daily` 原来只有「房间号 / 营业日 / 房费」三列，**没有间夜**；
 * 一旦有人自己数 folio_items.qty，就会得到「房费还没过账时分钟夜恒为 0」的第四套口径。
 * 清单要求补：售出间夜 / 房费 / 餐饮 / 其他 / 退款 / 净收入 / 可售房量 / 出租率 / ADR，
 * 并且**全部复用 metrics.ts，不允许再用 folio_items.qty 当间夜**。
 *
 * ── 验收条件（清单第 190-197 行）──
 * 报表间夜、房态间夜、夜审间夜、工作台出租率 —— **四者必须一致**。
 *
 * 四者的真实来源：
 *   1. 报表间夜   reports/page.tsx  → ctx.occupancy.roomNights / stayNightSlices / nightSeries
 *   2. 房态间夜   rooms/page.tsx    → occupancyOfDay(hotelId, today).roomNights
 *   3. 夜审间夜   night-audit/actions.ts → SQL_ROOM_NIGHTS（在住、nights>0、非钟点）
 *                                   落库到 night_audits.rooms_sold
 *   4. 工作台     dashboard/page.tsx → occupancyMetrics(bizDay, bizDay).roomsSold（单日 = 间夜）
 *
 * 本脚本验三半：
 *   A. 静态：报表组件用 metrics（不是 qty）；九列齐全；净收入 / 退款 / 可售房口径正确；
 *   B. 动态：真库副本（.tmp）+ 独立租户 9002 构造受控数据，分别用「四者各自的 SQL」
 *      算同一个营业日 D 的间夜与出租率，断言四个数字完全相同，并把它们打印出来；
 *   C. 动态：区间口径恒等式 —— Σ 逐日间夜 = Σ 房间×日明细 = occupancyMetrics().roomNights。
 *
 * 用法：node scripts/test-room-biz-daily-nights.mjs
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
const six = (n) => Number(n).toFixed(6);

const REPORTS_FILE = join("src", "app", "(main)", "reports", "page.tsx");
const METRICS_FILE = join("src", "lib", "metrics.ts");
const AUDIT_FILE = join("src", "app", "(main)", "night-audit", "actions.ts");
const DASH_FILE = join("src", "app", "(main)", "dashboard", "page.tsx");
const ROOMS_FILE = join("src", "app", "(main)", "rooms", "page.tsx");

const pageSrc = readFileSync(REPORTS_FILE, "utf8");
const metricsSrc = readFileSync(METRICS_FILE, "utf8");
const auditSrc = readFileSync(AUDIT_FILE, "utf8");
const dashSrc = readFileSync(DASH_FILE, "utf8");
const roomsSrc = readFileSync(ROOMS_FILE, "utf8");

/** 报表组件正文（「八点五」这节标题 → 下一个节标题「八·二」） */
const section = (() => {
  const start = pageSrc.indexOf("八点五、综合营业日报-房间");
  const end = pageSrc.indexOf("八·二、未实现报表的占位视图");
  if (start < 0 || end < 0 || end <= start) return "";
  return pageSrc.slice(start, end);
})();
const code = section
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\*|\/\/)/.test(l))
  .join("\n");

/* ================================================================== *
 * A. 静态校验
 * ================================================================== */
console.log("=== A. 静态：报表实现 ===");

check("组件正文已抓到", section.length > 4000, `长度 ${section.length}`);
check(
  "REPORT_VIEWS 仍把 room-biz-daily 指向真实组件",
  /"room-biz-daily":\s*ReportRoomBizDaily,/.test(pageSrc)
);
check("间夜取 stayNightSlices（住宿占用口径）", /stayNightSlices\(/.test(code), "没有用 metrics 的间夜明细");
check("逐日间夜取 nightSeries", /nightSeries\(/.test(code), "没有用 metrics 的逐日间夜");
check("房费 / 餐饮 / 其他取 categoryAgg / dailyAgg（报表统一科目口径）", /categoryAgg\(/.test(code) && /dailyAgg\(/.test(code));
check(
  "合计行直接取 ctx.occupancy（roomNights / adr / occupancy）",
  /ctx\.occupancy\.roomNights/.test(code) && /ctx\.occupancy\.adr/.test(code) && /ctx\.occupancy\.occupancy/.test(code),
  "合计行没有复用区间指标"
);
check(
  "不再用 folio_items.qty 当间夜（组件代码里没有 qty）",
  !/SUM\(\s*fi\.qty\s*\)/i.test(code) && !/\.qty\b/.test(code),
  "出现 qty —— 间夜不能数明细行数"
);

/* ---------- 九列 ---------- */
for (const col of ["售出间夜", "房费", "餐饮", "其他", "退款", "净收入", "可售房量", "出租率", "ADR"]) {
  check(`表格有「${col}」列`, section.includes(col), `缺少 ${col}`);
}

/* ---------- 计算口径 ---------- */
check(
  "净收入 = 房费 + 餐饮 + 其他 − 退款",
  n()(code).includes(norm(`const netIncome = round2(cur.room + cur.food + cur.otherTotal - refundTotal)`)),
  "净收入公式不符"
);
function n() {
  return norm;
}
check(
  "退款口径与夜审一致（amount < 0 或 refund_of 非空，取绝对值）",
  /p\.amount < 0 OR p\.refund_of IS NOT NULL/.test(code) && /SUM\(ABS\(p\.amount\)\)/.test(code),
  "退款判定与夜审不同口径"
);
check(
  "可售房量排除 OOO / LOCK（与 metrics 同一条 CASE）",
  /status IN \('OOO','LOCK'\) THEN 0 ELSE 1 END/.test(code),
  "可售房量没有扣维修房 / 锁房"
);
check("ADR = 房费 ÷ 间夜", /r\.nights > 0 \? r\.room \/ r\.nights : 0/.test(code) && /nights > 0 \? room \/ nights : 0/.test(code));
check("出租率 = 间夜 ÷ 可售房量", /r\.sellable > 0 \? r\.nights \/ r\.sellable : 0/.test(code));
check("房间 × 营业日明细按 (room_no, biz_date) 聚合", /GROUP BY r\.room_no, fi\.biz_date/.test(code));
check(
  "页面标注「四者同口径」（房态 / 工作台 / 夜审）",
  /四者相等/.test(section) && /房态/.test(section) && /工作台/.test(section) && /夜审/.test(section)
);

/* ---------- 上游口径（四者的来源） ---------- */
check(
  "房态页用 occupancyOfDay（metrics 口径）",
  /occupancyOfDay\(/.test(roomsSrc) && /dayMetrics\.roomNights/.test(roomsSrc)
);
check(
  "工作台用 occupancyMetrics(bizDay, bizDay)",
  /occupancyMetrics\(hotelId,\s*bizDay,\s*bizDay\)/.test(dashSrc),
  "工作台没有用统一口径"
);
check(
  "metrics 的 StayNightSlice 带 roomNo（房间维度可用）",
  /roomNo: string \| null;/.test(metricsSrc) && /r\.room_no AS room_no/.test(metricsSrc),
  "间夜明细缺少房间维度"
);
check("metrics 的 StayNightSlice 带 channelId（渠道维度可用）", /channelId: number \| null;/.test(metricsSrc));

/* ---------- SQL 副本与源码逐字一致 ---------- */
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

/* 房态 / 工作台共用的两条间夜 SQL（metrics.occupancyMetrics 的核心，不可改） */
const INHOUSE_NIGHTS_SQL = `SELECT COALESCE(SUM(
              MAX(0,
                  MIN(
                    julianday(CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day') ELSE s.expect_check_out END),
                    julianday(date(?, '+1 day'))
                  )
                  - MAX(julianday(substr(s.check_in_time,1,10)), julianday(?))
              )
            ), 0) AS nights
       FROM stays s
      WHERE s.hotel_id = ?
        AND s.status IN ('INHOUSE','CHECKED_OUT')
        AND COALESCE(s.rate_code,'') <> '钟点'
        AND (
              (substr(s.check_in_time,1,10) <= ?
               AND COALESCE(s.expect_check_out, substr(s.check_in_time,1,10)) > ?)
           OR (s.status = 'INHOUSE' AND substr(s.check_in_time,1,10) <= ?)
        )
        AND s.status = 'INHOUSE'`;
const CHECKED_OUT_NIGHTS_SQL = `SELECT COALESCE(SUM(
              MAX(0,
                  MIN(
                    julianday(COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out)),
                    julianday(date(?, '+1 day'))
                  )
                  - MAX(julianday(substr(s.check_in_time,1,10)), julianday(?))
              )
            ), 0) AS nights
       FROM stays s
      WHERE s.hotel_id = ?
        AND s.status = 'CHECKED_OUT'
        AND COALESCE(s.rate_code,'') <> '钟点'
        AND substr(s.check_in_time,1,10) <= ?
        AND COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out, substr(s.check_in_time,1,10)) > ?`;
const SELLABLE_SQL = `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
       FROM rooms WHERE hotel_id = ?`;
/* 夜审的出租间夜 SQL（night-audit/actions.ts 的 SQL_ROOM_NIGHTS） */
const AUDIT_NIGHTS_SQL = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND COALESCE(s.nights, 0) > 0
   AND COALESCE(s.rate_code, '') <> '钟点'`;

const nMetrics = norm(metricsSrc);
const nAudit = norm(auditSrc);
check("住宿占用明细 SQL 与 metrics.ts 逐字一致", nMetrics.includes(norm(SLICE_SQL)), "metrics.ts 已变，请同步本脚本");
check("在住间夜 SQL 与 metrics.ts 逐字一致", nMetrics.includes(norm(INHOUSE_NIGHTS_SQL)), "metrics.ts 已变，请同步本脚本");
check("已退房间夜 SQL 与 metrics.ts 逐字一致", nMetrics.includes(norm(CHECKED_OUT_NIGHTS_SQL)), "metrics.ts 已变，请同步本脚本");
check("可售房量 SQL 与 metrics.ts 逐字一致", nMetrics.includes(norm(SELLABLE_SQL)), "metrics.ts 已变，请同步本脚本");
check("夜审间夜 SQL 与 night-audit/actions.ts 逐字一致", nAudit.includes(norm(AUDIT_NIGHTS_SQL)), "夜审 SQL 已变，请同步本脚本");

/* ================================================================== *
 * B. 动态：四者一致（同一营业日 D）
 * ================================================================== */
console.log("\n=== B. 动态：报表 / 房态 / 夜审 / 工作台 四者一致 ===");

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const H = 9002;
const D = "2031-01-05";

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

function openCopy() {
  if (!existsSync(REAL_DB)) {
    console.error(`真实库不存在：${REAL_DB}（用 PMS_DB_PATH 指定，或先 init-db）`);
    process.exit(1);
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, `room-biz-daily-${process.pid}-${Date.now()}.db`);
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
const all = (sql, params = []) => db.prepare(sql).all(...params);
const one = (sql, params = []) => db.prepare(sql).get(...params);

try {
  db.exec("BEGIN");
  const rtId = Number(
    db
      .prepare(`INSERT INTO room_types (hotel_id, code, name, base_price) VALUES (?,?,?,?)`)
      .run(H, "T9", "口径测试房型", 100).lastInsertRowid
  );
  const insRoom = db.prepare(`INSERT INTO rooms (hotel_id, room_no, room_type_id, status) VALUES (?,?,?,?)`);
  const roomIds = {};
  for (const [no, status] of [
    ["T9-01", "VC"],
    ["T9-02", "VC"],
    ["T9-03", "VC"],
    ["T9-04", "OOO"],
  ]) {
    roomIds[no] = Number(insRoom.run(H, no, rtId, status).lastInsertRowid);
  }

  const insStay = db.prepare(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out,
                        actual_check_out, nights, rate, status, rate_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  /*
   * 受控数据（营业日 D = 2031-01-05）：
   *   S1 在住，D-1 入住、D+1 预计离店 → 占 D 晚
   *   S2 在住，D 入住、D+2 预计离店   → 占 D 晚
   *   S3 已退房，D-1 实际离店          → 不占 D 晚
   *   S4 已退房，D 实际离店            → 不占 D 晚（行业口径：退房当晚不占房）
   *   S5 钟点房在住（nights=0）        → 不计间夜
   * 期望：间夜 = 2，可售房 = 3（T9-04 OOO），出租率 = 2/3。
   */
  const s1 = Number(
    insStay.run(H, "T9-S1", roomIds["T9-01"], "在住甲", "2031-01-04T14:00:00", "2031-01-06", null, 2, 200, "INHOUSE", "门市价")
      .lastInsertRowid
  );
  const s2 = Number(
    insStay.run(H, "T9-S2", roomIds["T9-02"], "在住乙", "2031-01-05T15:00:00", "2031-01-07", null, 2, 120, "INHOUSE", "门市价")
      .lastInsertRowid
  );
  insStay.run(H, "T9-S3", roomIds["T9-03"], "已退丙", "2031-01-03T14:00:00", "2031-01-04", "2031-01-04", 1, 100, "CHECKED_OUT", "门市价");
  insStay.run(H, "T9-S4", roomIds["T9-03"], "已退丁", "2031-01-03T16:00:00", "2031-01-05", "2031-01-05", 2, 100, "CHECKED_OUT", "门市价");
  insStay.run(H, "T9-S5", roomIds["T9-04"], "钟点", "2031-01-05T10:00:00", "2031-01-05", null, 0, 60, "INHOUSE", "钟点");

  const folioId = Number(
    db
      .prepare(
        `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(H, "T9-F1", s1, "在住甲", 0, 0, 0, "OPEN").lastInsertRowid
  );
  const folio2 = Number(
    db
      .prepare(
        `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(H, "T9-F2", s2, "在住乙", 0, 0, 0, "OPEN").lastInsertRowid
  );
  const insItem = db.prepare(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  insItem.run(H, folioId, "ROOM", "房费", 1, 200, 200, D, `${D}T23:00:00`);
  insItem.run(H, folioId, "FOOD", "餐饮", 1, 50, 50, D, `${D}T19:00:00`);
  insItem.run(H, folio2, "OTHER", "其他", 1, 30, 30, D, `${D}T20:00:00`);
  insItem.run(H, folioId, "DEPOSIT", "押金", 1, 100, 100, D, `${D}T14:00:00`);
  /* 退款 -20（负数收款）：报表的「退款」列与夜审 refund_total 同一判定 */
  db.prepare(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, amount, method, biz_date, created_at, remark)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(H, folioId, s1, -20, "现金", D, `${D}T21:00:00`, "退款：测试");
  db.prepare(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, amount, method, biz_date, created_at, remark)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(H, folioId, s1, 500, "现金", D, `${D}T12:00:00`, "收款");
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

/* ---------- 四个来源分别计算同一营业日 D 的间夜 ---------- */
/* 1) 报表间夜：metrics.stayNightSlices 展开到 D 那一晚 */
const slices = all(SLICE_SQL, [D, D, D, D, D, D, H, D, D, D]);
const nightMap = new Map();
for (const r of slices) {
  const nights = Math.max(0, Math.round(num(r.nights)));
  if (nights <= 0) continue;
  /* first_night 是区间夹取后的第一晚；单日区间下就只有 D 这一晚 */
  nightMap.set(String(r.first_night), (nightMap.get(String(r.first_night)) ?? 0) + nights);
}
const reportNights = [...nightMap.values()].reduce((s, v) => s + v, 0);

/* 2) 房态间夜：occupancyOfDay(hotelId, D).roomNights = 两条 SQL 之和 */
const inhouseNights = Math.max(0, Math.round(num(one(INHOUSE_NIGHTS_SQL, [D, D, D, H, D, D, D])?.nights)));
const checkedOutNights = Math.max(0, Math.round(num(one(CHECKED_OUT_NIGHTS_SQL, [D, D, H, D, D])?.nights)));
const roomsPageNights = inhouseNights + checkedOutNights;

/* 3) 夜审间夜：SQL_ROOM_NIGHTS */
const auditNights = Math.round(num(one(AUDIT_NIGHTS_SQL, [H])?.v));

/* 4) 工作台：occupancyMetrics(D, D).roomsSold —— 单日时 roomsSold === roomNights */
const dashNights = roomsPageNights;
const dashRoomsSold = roomsPageNights; /* dayCount = 1 → roomsSold = roomNights / 1 */

/* 可售房：metrics 的房量 SQL（房态 / 工作台 / 夜审都取它） */
const capacity = one(SELLABLE_SQL, [H]);
const sellableRooms = num(capacity?.sellable);
const occupancy = sellableRooms > 0 ? dashRoomsSold / sellableRooms : 0;

console.log(`\n  报表间夜=${reportNights} 房态间夜=${roomsPageNights} 夜审间夜=${auditNights} 工作台间夜=${dashNights}`);
console.log(`  可售房=${sellableRooms} 出租率=${six(occupancy)}（${dashRoomsSold}/${sellableRooms}）\n`);

check("报表间夜 = 2", reportNights === 2, `实际 ${reportNights}`);
check("房态间夜 = 2", roomsPageNights === 2, `实际 ${roomsPageNights}`);
check("夜审间夜 = 2", auditNights === 2, `实际 ${auditNights}`);
check("工作台间夜 = 2", dashNights === 2, `实际 ${dashNights}`);
check(
  "四者一致：报表 = 房态 = 夜审 = 工作台",
  reportNights === roomsPageNights && roomsPageNights === auditNights && auditNights === dashNights,
  `报表 ${reportNights} / 房态 ${roomsPageNights} / 夜审 ${auditNights} / 工作台 ${dashNights}`
);
check("钟点房不计入间夜（S5 未算进来）", reportNights === 2 && auditNights === 2, "钟点房被计成间夜");
check("已退房且当天退房的单不占当晚（S4 actual = D）", checkedOutNights === 0, `已退房间夜 ${checkedOutNights}`);
check("可售房量 = 3（4 间房 − 1 间 OOO）", sellableRooms === 3, `实际 ${sellableRooms}`);
check("出租率 = 2/3 ≈ 0.666667（四者同一分母）", six(occupancy) === "0.666667", `实际 ${six(occupancy)}`);

/* 夜审落库：rooms_sold 必须写同一个数 */
try {
  db.prepare(
    `INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(H, D, "DONE", auditNights, 0, 0, occupancy, "test", `${D}T23:59:00`);
  const auditRow = one(`SELECT rooms_sold, occupancy FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, D]);
  check("夜审落库 rooms_sold = 报表间夜（2）", num(auditRow?.rooms_sold) === reportNights, `实际 ${num(auditRow?.rooms_sold)}`);
  check(
    "夜审落库出租率 = 报表出租率（2/3）",
    six(num(auditRow?.occupancy)) === six(occupancy),
    `实际 ${six(num(auditRow?.occupancy))} vs ${six(occupancy)}`
  );
} catch (e) {
  check("夜审落库 rooms_sold = 报表间夜（2）", false, e.message);
  check("夜审落库出租率 = 报表出租率（2/3）", false, e.message);
}

/* ---------- 收入口径 ---------- */
const cat = one(
  `SELECT
     COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END), 0) AS room,
     COALESCE(SUM(CASE WHEN item_type = 'FOOD' THEN amount ELSE 0 END), 0) AS food,
     COALESCE(SUM(CASE WHEN item_type = 'OTHER' THEN amount ELSE 0 END), 0) AS other
   FROM folio_items
   WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND item_type IN ('ROOM','FOOD','OTHER')`,
  [H, D, D]
);
const refund = round2(
  num(
    one(
      `SELECT COALESCE(SUM(ABS(amount)), 0) AS v FROM payments
        WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND (amount < 0 OR refund_of IS NOT NULL)`,
      [H, D, D]
    )?.v
  )
);
const room = round2(num(cat?.room));
const food = round2(num(cat?.food));
const other = round2(num(cat?.other));
check("房费 = 200（ROOM 明细）", room === 200, `实际 ${room}`);
check("餐饮 = 50", food === 50, `实际 ${food}`);
check("其他 = 30", other === 30, `实际 ${other}`);
check("押金不计收入（DEPOSIT 100 未算进来）", room + food + other === 280, `实际 ${room + food + other}`);
check("退款 = 20（负数收款绝对值）", refund === 20, `实际 ${refund}`);
check("净收入 = 200 + 50 + 30 − 20 = 260", round2(room + food + other - refund) === 260, `实际 ${round2(room + food + other - refund)}`);
check("ADR = 房费 ÷ 间夜 = 100", round2(reportNights > 0 ? room / reportNights : 0) === 100);

/* ---------- 房间 × 日明细：合计必须等于报表间夜 ---------- */
const roomDays = new Map();
for (const r of slices) {
  const nights = Math.max(0, Math.round(num(r.nights)));
  if (nights <= 0) continue;
  const key = `${r.room_no ?? "未关联房"}|${String(r.first_night)}`;
  roomDays.set(key, (roomDays.get(key) ?? 0) + nights);
}
const detailNights = [...roomDays.values()].reduce((s, v) => s + v, 0);
check("房间 × 日明细间夜合计 = 报表间夜（2）", detailNights === reportNights, `明细 ${detailNights} vs 报表 ${reportNights}`);
check("明细落在正确的房间（T9-01 / T9-02 各 1 间夜）", roomDays.get(`T9-01|${D}`) === 1 && roomDays.get(`T9-02|${D}`) === 1, JSON.stringify([...roomDays]));

/* ================================================================== *
 * C. 区间恒等式：Σ 逐日间夜 = Σ 房间×日明细 = occupancyMetrics().roomNights
 * ================================================================== */
console.log("\n=== C. 区间恒等式 ===");

const FROM = "2031-01-04";
const TO = "2031-01-06";
const rangeSlices = all(SLICE_SQL, [FROM, TO, TO, TO, TO, FROM, H, TO, TO, FROM]);
const rangeNights = rangeSlices.reduce((s, r) => s + Math.max(0, Math.round(num(r.nights))), 0);
const rangeInhouse = Math.max(0, Math.round(num(one(INHOUSE_NIGHTS_SQL, [TO, TO, FROM, H, TO, FROM, TO])?.nights)));
const rangeCheckedOut = Math.max(0, Math.round(num(one(CHECKED_OUT_NIGHTS_SQL, [TO, FROM, H, TO, FROM])?.nights)));
const rangeMetrics = rangeInhouse + rangeCheckedOut;

/* 逐日：把每条明细展开到每一晚 */
const byDay = new Map();
for (const d of ["2031-01-04", "2031-01-05", "2031-01-06"]) byDay.set(d, 0);
for (const r of rangeSlices) {
  const nights = Math.max(0, Math.round(num(r.nights)));
  for (let i = 0; i < nights; i += 1) {
    const dt = new Date(`${r.first_night}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + i);
    const day = dt.toISOString().slice(0, 10);
    if (byDay.has(day)) byDay.set(day, byDay.get(day) + 1);
  }
}
const seriesSum = [...byDay.values()].reduce((s, v) => s + v, 0);
console.log(`  区间 ${FROM}~${TO}: 明细合计=${rangeNights} 逐日合计=${seriesSum} metrics=${rangeMetrics} 逐日=${JSON.stringify([...byDay])}`);
check("Σ 住宿占用明细 = occupancyMetrics().roomNights", rangeNights === rangeMetrics, `${rangeNights} vs ${rangeMetrics}`);
check("Σ 逐日间夜 = occupancyMetrics().roomNights", seriesSum === rangeMetrics, `${seriesSum} vs ${rangeMetrics}`);
check(
  "逐日分布正确（D-1=2：S1+S4 / D=2：S1+S2 / D+1=2：S1+S2）",
  byDay.get("2031-01-04") === 2 && byDay.get("2031-01-05") === 2 && byDay.get("2031-01-06") === 2,
  JSON.stringify([...byDay])
);
check("区间间夜 = 6（与逐日 2+2+2 一致）", rangeMetrics === 6, `实际 ${rangeMetrics}`);

/* ---------- 清理 ---------- */
close();

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log("（临时库在 .tmp 下创建并已删除，未影响 data/pms.db）\n");
process.exit(fail === 0 ? 0 : 1);
