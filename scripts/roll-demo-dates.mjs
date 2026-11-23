/**
 * 演示数据日期滚动（问题 1：21 张在住单逾期 7~11 天）
 *
 * ── 背景：为什么会逾期 ──
 * `scripts/demo-data/demo-data.sql` 里的入住/离店日期是**硬编码的绝对日期**
 * （SI1100 系列写在 2026-11-12 ~ 2026-11-17）。演示库导出那天看着很合理，
 * 但日期不随时间滚动：每过一天，所有在住单就往「逾期」多走一天。
 * 表现是工作台「逾期未离店」、夜审预检「未完成退房」、报表「在住 25 间」
 * 全部跟着虚高 —— 明明是同一个演示库，隔一周再看就是另一副样子。
 *
 * 这不是某一天的数据脏了，而是**日期锚点选错了**：演示数据应该锚在
 * 「今天」，而不是锚在导出那天。所以修法不是把这些单改成已退房
 * （那会丢掉「在住」这种演示场景），而是把日期整体滚动到今天附近。
 *
 * ── 平移规则（方案 A）──
 *   在住单（INHOUSE）：保持实际晚数不变，整体平移
 *     · check_in_time     落在 [今天-3, 今天]
 *     · expect_check_out  落在 [今天+1, 今天+3]（全部未来 → 逾期归零）
 *   已退房单（CHECKED_OUT）：只在 actual_check_out >= 今天时回拉到 今天-1
 *     （已经严格在过去的单子不动 —— 那是历史报表的数据基础，挪了报表就变样）
 *
 * 同一个 stay 的**所有**日期都按同一个天数平移，相对关系因此天然保持：
 *   结账日 = 退房日、押金收款日 = 入住日、房费明细日 = 入住日 …
 *   涉及：stays / folios / folio_items / payments / breakfast_records / 关联 bookings
 *
 * ── 幂等：为什么不从当前值累加 ──
 * 「基准日期」记在 op_logs（action = 演示数据日期滚动）里，每次都用
 * 「基准 + 今天」重算目标，而不是「当前 + N 天」。所以：
 *   · 同一天跑第二次：目标与现状一致 → 0 改动（不会越移越远）
 *   · 隔几天再跑：窗口跟着今天走，需要时整体前移刚好够用的天数（自动保鲜）
 *   · op_logs 不进演示数据导出，重新导入后自然以新种子日期为基准，不会串味
 *
 * ── 用法 ──
 *   node scripts/roll-demo-dates.mjs            # 等价 --check，只看会动多少条
 *   node scripts/roll-demo-dates.mjs --check
 *   node scripts/roll-demo-dates.mjs --apply    # 先 VACUUM INTO 备份，再写库
 *
 * 导出脚本 `scripts/export-demo-sql.mjs` 会 import 本文件的 buildImportBlock()，
 * 把同一套 SQL 追加进 demo-data.sql —— 导入时以「导入当天」为锚重新滚动，
 * 这样「下次导入又带回来一批逾期单」的问题被根治在同一份 SQL 里。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** op_logs 里的动作名（同时是基准日期的存储位置） */
export const ROLL_ACTION = "演示数据日期滚动";

/** 基准日期的临时表（连接级，不落库、不导出） */
export const BASE_TABLE = "_demo_roll_base";

/** 参与滚动的演示入住单前缀（SI1100 / SI6000 …；DEMO-* 是冒烟脚本产物，不动） */
export const DEMO_STAY_LIKE = "SI%";

/** 在住单的目标窗口：入住 今天-3 ~ 今天，应退 今天+1 ~ 今天+3 */
const IN_CHECKIN_BACK_DAYS = 3;
const IN_CHECKOUT_FWD_DAYS = 3;

/* ════════════════════════════════════════════════════════════ SQL 生成
 *
 * 下面这堆 SQL 有两个消费者：
 *   1. 本脚本 --apply（真库滚动）
 *   2. demo-data.sql 末尾的导入段（导入当天滚动）
 * 两边必须是**同一份 SQL**，否则「跑脚本修好的库」和「重新导入的库」会不一样。
 * 所以这里只写一次，两个入口共用。
 *
 * 为什么把基准日期先灌进临时表 `_demo_roll_base`：
 *   delta 必须一次性算定。如果每条 UPDATE 都从 stays 现读基准，
 *   第一条 UPDATE 改完日期后，第二条重算出来的 delta 就变了 —— 账单会被平移
 *   另一个天数，和入住单对不上。灌进临时表就锁定了基准，后面所有语句用同一个 delta。
 */

/**
 * 日期字符串整体后移 d 天，保留时间部分（'2026-11-13T05:30:00.000Z' → '2026-11-23T05:30:00.000Z'）
 *
 * 列名必须带表名限定：UPDATE ... FROM 里另一张表也有 created_at / biz_date 时，
 * 不限定会直接报 `ambiguous column name: created_at`（SET 左边不能写表名，只能限定右边）。
 */
function shiftColumn(table, col, d = "dd.sh") {
  return `date(${table}.${col}, ${d} || ' days') || substr(${table}.${col}, 11)`;
}

/** 纯日期列（DATE 类型）后移 d 天 */
function shiftDate(table, col, d = "dd.sh") {
  return `date(${table}.${col}, ${d} || ' days')`;
}

/**
 * 算出这一组（INHOUSE / CHECKED_OUT）每张单**这次要平移多少天**。
 *
 * 分两步，这两步分开是幂等的关键：
 *   ① place —— 从**基准日期**算出「目标入住日」应该落在哪（相对基准的位移）
 *   ② sh    —— 本次真正要执行的位移 = 目标入住日 − **当前**入住日
 *
 * 为什么不能把 place 直接当位移用：
 *   place 是相对基准的天数，而 UPDATE 是作用于当前值。当天跑第二次时，
 *   当前值已经是「基准 + place」，再按 place 平移就会翻倍 —— 越跑越远。
 *   换算成「目标 − 当前」之后，第二次跑 sh = 0，天然幂等；隔天再跑 sh = 1，
 *   窗口跟着今天走，只补最短的距离。
 *   导入段（基准 = 当前）里 sh 就等于 place，行为不变。
 *
 * place 的取法（INHOUSE）：保持实际晚数 nn = 应退 - 入住，解出可行区间
 *   ci + place ∈ [T-3, T]   →  place ∈ [T-3-ci, T-ci]
 *   co + place ∈ [T+1, T+3] →  place ∈ [T+1-co, T+3-co]
 *   lo = max(T-3-ci, T+1-co)，hi = min(T-ci, T+3-co)
 *   1 ≤ nn ≤ 6 时 lo ≤ hi 恒成立（nn=1 时 hi/lo 收成一个点），
 *   在这个区间里按 stay_id 取一个稳定值 → 入住日自然散落在今天~今天-3，不会 25 张单全挤在同一天。
 *   nn > 6 时区间为空（窗口最多容纳 6 晚），退化为「入住 = 今天」，宁可应退超出今天+3 也不篡改晚数。
 *
 * CHECKED_OUT：只在 实际退房 >= 今天 时回拉到 今天-1；已经严格过去的单子 place = NULL（不动）。
 */
function deltaCte(group, { baselineSource }) {
  const placeExpr =
    group === "INHOUSE"
      ? `CASE
           WHEN nn < 1 THEN NULL
           WHEN hi >= lo THEN lo + (stay_id % (hi - lo + 1))
           ELSE d1
         END`
      : `CASE
           WHEN bao IS NOT NULL AND date(bao) >= date('now', 'localtime')
           THEN CAST(julianday(date('now', 'localtime', '-1 day')) - julianday(bao) AS INTEGER)
           ELSE NULL
         END`;

  return `WITH base AS (
  SELECT stay_id, bci, bco, bao, st, cur_ci FROM (${baselineSource})
),
win AS (
  SELECT stay_id,
         bci,
         bao,
         cur_ci,
         CAST(julianday(bco) - julianday(bci) AS INTEGER) AS nn,
         CAST(julianday(date('now', 'localtime')) - julianday(bci) AS INTEGER) AS d1
    FROM base
   WHERE st = '${group}' AND bci IS NOT NULL AND bco IS NOT NULL AND cur_ci IS NOT NULL
),
w2 AS (
  SELECT stay_id, bci, bao, cur_ci, nn, d1,
         MAX(d1 - ${IN_CHECKIN_BACK_DAYS}, d1 + 1 - nn) AS lo,
         MIN(d1, d1 + ${IN_CHECKOUT_FWD_DAYS} - nn) AS hi
    FROM win
),
placed AS (
  SELECT stay_id, bci, cur_ci,
         ${placeExpr} AS place
    FROM w2
),
delta AS (
  SELECT stay_id,
         CAST(julianday(date(bci, place || ' days')) - julianday(cur_ci) AS INTEGER) AS sh
    FROM placed
   WHERE place IS NOT NULL
)`;
}

/**
 * 生成全部滚动语句（不含结尾分号）。
 *
 * @param {{ baselineSource?: string }} [options]
 *   baselineSource：基准日期的 SELECT 来源，必须给出 stay_id / bci / bco / bao / st / cur_ci 六列。
 *   默认读临时表（脚本与导入段都先把基准灌进 _demo_roll_base，行为一致）。
 * @returns {string[]} 每条都是可单独执行的一条 SQL
 */
export function buildRollStatements({ baselineSource = `SELECT stay_id, bci, bco, bao, st, cur_ci FROM ${BASE_TABLE}` } = {}) {
  const stmts = [];
  for (const group of ["INHOUSE", "CHECKED_OUT"]) {
    const pre = deltaCte(group, { baselineSource });

    /* 1) 入住单本身：入住 / 应退 / 实退 / 建档时间 */
    stmts.push(`${pre}
UPDATE stays
   SET check_in_time     = ${shiftColumn("stays", "check_in_time")},
       expect_check_out  = ${shiftColumn("stays", "expect_check_out")},
       actual_check_out  = ${shiftColumn("stays", "actual_check_out")},
       created_at        = ${shiftColumn("stays", "created_at")}
  FROM delta dd
 WHERE stays.id = dd.stay_id AND dd.sh IS NOT NULL AND dd.sh <> 0`);

    /* 2) 账单：建档时间 + 结账时间（结账日 = 退房日 由同一个 d 保证） */
    stmts.push(`${pre}
UPDATE folios
   SET created_at = ${shiftColumn("folios", "created_at")},
       settled_at = ${shiftColumn("folios", "settled_at")}
  FROM delta dd
 WHERE folios.stay_id = dd.stay_id AND dd.sh IS NOT NULL AND dd.sh <> 0`);

    /* 3) 账务明细：业务日期 + 建档时间 */
    stmts.push(`${pre}
UPDATE folio_items
   SET biz_date   = ${shiftColumn("folio_items", "biz_date")},
       created_at = ${shiftColumn("folio_items", "created_at")}
  FROM folios f
  JOIN delta dd ON dd.stay_id = f.stay_id
 WHERE folio_items.folio_id = f.id AND dd.sh IS NOT NULL AND dd.sh <> 0`);

    /* 4) 收款流水：业务日期 + 建档时间（押金收款日 = 入住日 同样由同一个 d 保证） */
    stmts.push(`${pre}
UPDATE payments
   SET biz_date   = ${shiftColumn("payments", "biz_date")},
       created_at = ${shiftColumn("payments", "created_at")}
  FROM delta dd
 WHERE payments.stay_id = dd.stay_id AND dd.sh IS NOT NULL AND dd.sh <> 0`);

    /* 5) 早餐记录：按天生成，跟着住宿日一起挪，否则会出现「入住前就在吃早餐」 */
    stmts.push(`${pre}
UPDATE breakfast_records
   SET "date"     = date(breakfast_records."date", dd.sh || ' days'),
       created_at = ${shiftColumn("breakfast_records", "created_at")}
  FROM delta dd
 WHERE breakfast_records.stay_id = dd.stay_id AND dd.sh IS NOT NULL AND dd.sh <> 0`);

    /* 6) 关联预订：入住单挪了，预订日期不挪就对不上（例如订单详情里的入离日期） */
    stmts.push(`${pre}
UPDATE bookings
   SET check_in_date  = ${shiftDate("bookings", "check_in_date")},
       check_out_date = ${shiftDate("bookings", "check_out_date")},
       created_at     = ${shiftColumn("bookings", "created_at")},
       updated_at     = ${shiftColumn("bookings", "updated_at")}
  FROM stays s
  JOIN delta dd ON dd.stay_id = s.id
 WHERE bookings.id = s.booking_id AND dd.sh IS NOT NULL AND dd.sh <> 0`);
  }
  return stmts;
}

/** 基准临时表的建表 / 清空语句 */
function baseTableStatements(baselineInsertSql) {
  return [
    `CREATE TEMP TABLE IF NOT EXISTS ${BASE_TABLE} (
  stay_id INTEGER PRIMARY KEY,
  bci TEXT,
  bco TEXT,
  bao TEXT,
  st TEXT,
  cur_ci TEXT
)`,
    `DELETE FROM ${BASE_TABLE}`,
    baselineInsertSql,
  ];
}

/**
 * demo-data.sql 末尾要追加的「导入时滚动」段。
 *
 * 导入段与脚本的唯一差别是基准日期的来源：这里直接从刚插进去的种子数据取
 * （导入刚完成，库里就是种子原值），脚本则从 op_logs 取基准。
 * 其余 SQL（delta 计算 + 6 组 UPDATE）完全同一份。
 */
export function buildImportBlock() {
  const stmts = [
    ...baseTableStatements(`INSERT INTO ${BASE_TABLE} (stay_id, bci, bco, bao, st, cur_ci)
SELECT id,
       substr(check_in_time, 1, 10),
       substr(expect_check_out, 1, 10),
       substr(actual_check_out, 1, 10),
       status,
       substr(check_in_time, 1, 10)
  FROM stays
 WHERE stay_no LIKE '${DEMO_STAY_LIKE}'`),
    ...buildRollStatements(),
    `DROP TABLE IF EXISTS ${BASE_TABLE}`,
  ];

  const header = [
    "-- ════════════════════════════════════════════════════════════════════",
    "-- 演示数据日期滚动（问题 1 根治）",
    "--",
    "-- 上面这些 INSERT 的日期是**导出那天**的绝对日期，隔几天再导入就是在住单",
    "-- 逾期十来天，工作台 / 夜审预检 / 报表全部虚高。所以导入的最后一步，",
    "-- 以「导入当天」为锚把所有演示入住单整体滚到健康窗口：",
    "--   在住单  入住 今天-0~3 天，应退 今天+1~3 天（逾期归零）",
    "--   已退房  实际退房 今天之前",
    "-- 同一个 stay 的所有日期（账单/明细/流水/早餐/关联预订）按同一个天数平移，",
    "-- 保持「结账日 = 退房日」「押金收款日 = 入住日」等相对关系。",
    "--",
    "-- 这段 SQL 与 scripts/roll-demo-dates.mjs 共用同一份生成器，不要单独改这里。",
    "-- 用临时表 _demo_roll_base 同时锁定「基准日期」和「当前日期」：",
    "--   导入时两者相同（基准 = 刚插入的种子字面值）；",
    "--   本次位移 = 目标入住日 - 当前入住日，所以重复执行位移为 0，不会越移越远。",
    "-- delta 必须先定死再逐表 UPDATE，否则第一条 UPDATE 改了入住日期，",
    "-- 后面几条重算出来的天数就不一样了。",
    "-- 每条语句单独一行以「;」结尾（settings/demo-actions.ts 按「分号+换行」切分）。",
    "-- ════════════════════════════════════════════════════════════════════",
  ];

  return header.join("\n") + "\n" + stmts.join(";\n") + ";\n";
}

/* ════════════════════════════════════════════════════════════ 脚本逻辑 */

function resolveDbPath() {
  return process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const toNum = (s) => Date.UTC(...s.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  return Math.round((toNum(b) - toNum(a)) / 86400000);
}

/** op_logs.detail 的固定格式：只放机器可读的定长字段，方便回读基准 */
function formatDetail(r) {
  return (
    `stay=${r.stay_no} baseIn=${r.bci ?? "-"} baseOut=${r.bco ?? "-"} baseAo=${r.bao ?? "-"} ` +
    `delta=${r.d} newIn=${r.newIn ?? "-"} newOut=${r.newOut ?? "-"} newAo=${r.newAo ?? "-"} ` +
    `nights=${r.nights ?? "-"} group=${r.group}`
  );
}

const DETAIL_RE =
  /stay=(\S+) baseIn=(\S+) baseOut=(\S+) baseAo=(\S+) delta=(\S+) newIn=(\S+) newOut=(\S+) newAo=(\S+)/;

function parseDetail(detail) {
  if (typeof detail !== "string") return null;
  const m = DETAIL_RE.exec(detail);
  if (!m) return null;
  return {
    stay: m[1],
    baseIn: m[2],
    baseOut: m[3],
    baseAo: m[4],
    d: Number(m[5]),
    newIn: m[6],
    newOut: m[7],
    newAo: m[8],
  };
}

const norm = (v) => (v === null || v === undefined || v === "" ? "-" : v);

/**
 * 读取基准日期。
 *
 * 只有「上次滚动的结果 == 当前值」时才采信历史基准：那说明这期间没人改过这张单。
 * 一旦不相等（重新导入了种子数据、或前台手工改过日期），就以当前值为新基准 ——
 * 否则会把旧种子的基准套到新数据上，越修越错。
 */
function loadBaselines(db) {
  const stays = db
    .prepare(
      `SELECT id, stay_no, status,
              substr(check_in_time, 1, 10) AS ci,
              substr(expect_check_out, 1, 10) AS co,
              substr(actual_check_out, 1, 10) AS ao
         FROM stays
        WHERE stay_no LIKE ?
        ORDER BY id`
    )
    .all(DEMO_STAY_LIKE);

  const last = new Map();
  try {
    const logs = db.prepare(`SELECT detail FROM op_logs WHERE action = ? ORDER BY id`).all(ROLL_ACTION);
    for (const row of logs) {
      const p = parseDetail(row.detail);
      if (p) last.set(p.stay, p); // 按 id 升序 → 最后一条是最新基准
    }
  } catch {
    /* 旧库没有 op_logs：没有历史基准，全部以当前值为基准 */
  }

  return stays.map((s) => {
    const prev = last.get(s.stay_no);
    const reuse =
      prev &&
      prev.newIn === norm(s.ci) &&
      prev.newOut === norm(s.co) &&
      prev.newAo === norm(s.ao);
    return {
      id: s.id,
      stay_no: s.stay_no,
      status: s.status,
      ci: s.ci,
      co: s.co,
      ao: s.ao,
      bci: reuse ? prev.baseIn : s.ci,
      bco: reuse ? prev.baseOut : s.co,
      bao: reuse ? norm(prev.baseAo) : norm(s.ao),
      reusedBaseline: Boolean(reuse),
    };
  });
}

function vacuumInto(db, targetFile) {
  mkdirSync(dirname(targetFile), { recursive: true });
  if (existsSync(targetFile)) throw new Error(`备份文件已存在：${targetFile}`);
  const escaped = targetFile.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbPath = resolveDbPath();

  if (!existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");

  const today = todayStr();
  const baselines = loadBaselines(db);
  if (baselines.length === 0) {
    console.log(`数据库：${dbPath}`);
    console.log(`没有 ${DEMO_STAY_LIKE} 开头的演示入住单，无需滚动。`);
    db.close();
    return;
  }

  /* 基准 + 当前值灌进临时表，位移交给 SQL 一次定死（与导入段同一份 SQL） */
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS ${BASE_TABLE} (stay_id INTEGER PRIMARY KEY, bci TEXT, bco TEXT, bao TEXT, st TEXT, cur_ci TEXT)`
  );
  db.exec(`DELETE FROM ${BASE_TABLE}`);
  const insBase = db.prepare(
    `INSERT INTO ${BASE_TABLE} (stay_id, bci, bco, bao, st, cur_ci) VALUES (?,?,?,?,?,?)`
  );
  for (const b of baselines) insBase.run(b.id, b.bci, b.bco, b.bao, b.status, b.ci);

  const rows = new Map();
  for (const group of ["INHOUSE", "CHECKED_OUT"]) {
    const pre = deltaCte(group, {
      baselineSource: `SELECT stay_id, bci, bco, bao, st, cur_ci FROM ${BASE_TABLE}`,
    });
    const got = db.prepare(`${pre}\nSELECT stay_id, sh FROM delta ORDER BY stay_id`).all();
    for (const r of got) rows.set(Number(r.stay_id), { group, sh: r.sh === null ? null : Number(r.sh) });
  }

  const plan = baselines.map((b) => {
    const got = rows.get(b.id) ?? { group: b.status, sh: null };
    const sh = got.sh;
    return {
      ...b,
      group: got.group,
      d: sh, // 本次位移（相对当前值），0 = 不动
      nights: b.bci && b.bco ? daysBetween(b.bci, b.bco) : null,
      newIn: sh ? addDays(b.ci, sh) : b.ci,
      newOut: sh ? addDays(b.co, sh) : b.co,
      newAo: b.ao && sh ? addDays(b.ao, sh) : b.ao,
    };
  });

  const moving = plan.filter((p) => p.d !== null && p.d !== 0);
  const unchanged = plan.filter((p) => p.d === null || p.d === 0);

  /* ── 现状与预计结果（逾期口径与 src/app/(main)/dashboard/alerts.ts 一致：
        INHOUSE 且 expect_check_out < 今天 → 逾期） ── */
  const before = overdueStats(db, today);

  const projected = plan
    .filter((p) => p.status === "INHOUSE")
    .map((p) => (p.d ? p.newOut : p.co));
  const untouched = db
    .prepare(
      `SELECT substr(expect_check_out, 1, 10) AS co FROM stays
        WHERE status = 'INHOUSE' AND stay_no NOT LIKE ?`
    )
    .all(DEMO_STAY_LIKE)
    .map((r) => r.co);
  const after = tally([...projected, ...untouched], today);

  console.log(`数据库：${dbPath}`);
  console.log(`今天：${today}`);
  console.log(apply ? "模式：执行（先 VACUUM INTO 备份）\n" : "模式：仅检查（不写库）\n");

  console.log(`演示在住单：${before.inhouse} 张（逾期 ${before.overdue} / 今日应退 ${before.dueToday} / 未到期 ${before.future}）`);
  if (moving.length === 0) {
    console.log("没有需要平移的单据：全部已在目标窗口内（幂等，重复执行不会累积偏移）");
  } else {
    console.log(`需要平移：${moving.length} 张（不变 ${unchanged.length} 张）\n`);
    const head = ["单号", "状态", "晚数", "平移", "入住", "→", "应退", "→"];
    console.log(head.join("\t"));
    for (const p of moving) {
      console.log(
        [p.stay_no, p.status, p.nights ?? "-", `${p.d > 0 ? "+" : ""}${p.d} 天`, p.ci, p.newIn, p.co, p.newOut].join("\t")
      );
    }
  }
  console.log(
    `\n平移后预计：在住 ${after.total} 张（逾期 ${after.overdue} / 今日应退 ${after.dueToday} / 未到期 ${after.future}）`
  );

  if (!apply) {
    console.log("\n（未写库。加 --apply 执行）");
    db.exec(`DROP TABLE IF EXISTS ${BASE_TABLE}`);
    db.close();
    return;
  }

  if (moving.length === 0) {
    console.log("\n无需变更，未写库");
    db.exec(`DROP TABLE IF EXISTS ${BASE_TABLE}`);
    db.close();
    return;
  }

  /* ── 1. 备份 ── */
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  const backupFile = join(root, "data", "backup", `pms-before-roll-dates-${stamp}.db`);
  vacuumInto(db, backupFile);
  console.log(`\n已备份：${backupFile}`);

  /* ── 2. 事务内平移 + 每条写 op_logs ── */
  const nowIso = new Date().toISOString();
  let touched = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const stmt of buildRollStatements()) db.prepare(stmt).run();
    const log = db.prepare(
      `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`
    );
    const hotelId = Number(
      db.prepare(`SELECT hotel_id FROM stays WHERE id = ?`).get(moving[0].id)?.hotel_id ?? 1
    );
    for (const p of moving) {
      const r = { ...p, group: p.group };
      log.run(hotelId, "system:roll-demo-dates", ROLL_ACTION, formatDetail(r), nowIso);
      touched += 1;
    }
    log.run(
      hotelId,
      "system:roll-demo-dates",
      ROLL_ACTION,
      `汇总：平移 ${touched} 张演示入住单，逾期 ${before.overdue} → 0，锚点 ${today}`,
      nowIso
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error(`\n写库失败，已回滚：${e instanceof Error ? e.message : String(e)}`);
    console.error(`备份文件仍在：${backupFile}`);
    db.exec(`DROP TABLE IF EXISTS ${BASE_TABLE}`);
    db.close();
    process.exit(1);
  }

  db.exec(`DROP TABLE IF EXISTS ${BASE_TABLE}`);

  /* ── 3. 写后自证 ── */
  const real = overdueStats(db, today);
  console.log(`\n已平移：${touched} 张入住单 + 对应账单/明细/流水/早餐/关联预订（op_logs ${touched + 1} 条）`);
  console.log(
    `逾期未离店：${before.overdue} → ${real.overdue}　` +
      `今日应退：${before.dueToday} → ${real.dueToday}　未到期：${before.future} → ${real.future}`
  );
  console.log(`在住单总数：${real.inhouse} 张（内容不变，只是日期回到今天附近）`);

  const stillStale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM stays
        WHERE status = 'INHOUSE' AND stay_no LIKE ? AND expect_check_out < ?`
    )
    .get(DEMO_STAY_LIKE, today).n;
  console.log(stillStale === 0 ? "\n✅ 演示在住单逾期 0 张" : `\n❌ 仍有 ${stillStale} 张逾期`);

  db.close();
  if (stillStale !== 0) process.exit(1);
}

function tally(checkouts, today) {
  let overdue = 0;
  let dueToday = 0;
  let future = 0;
  for (const co of checkouts) {
    if (co < today) overdue += 1;
    else if (co === today) dueToday += 1;
    else future += 1;
  }
  return { total: checkouts.length, overdue, dueToday, future };
}

function overdueStats(db, today) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              CAST(SUM(CASE WHEN expect_check_out <  ? THEN 1 ELSE 0 END) AS INTEGER) AS overdue,
              CAST(SUM(CASE WHEN expect_check_out =  ? THEN 1 ELSE 0 END) AS INTEGER) AS dueToday,
              CAST(SUM(CASE WHEN expect_check_out >  ? THEN 1 ELSE 0 END) AS INTEGER) AS future
         FROM stays WHERE status = 'INHOUSE'`
    )
    .get(today, today, today);
  return {
    inhouse: Number(row.total ?? 0),
    overdue: Number(row.overdue ?? 0),
    dueToday: Number(row.dueToday ?? 0),
    future: Number(row.future ?? 0),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
