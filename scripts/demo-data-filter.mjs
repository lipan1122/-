/**
 * 演示数据里「DEMO 前缀单」的识别、排除与体检（导出 / 打包共用一份口径）
 *
 * ── 为什么需要这个模块 ──
 *
 * 演示库里有一批 `DEMO-<日期>-<类型><序号>-<时间戳>` 的单据，来源有两处：
 *   · `scripts/seed-uniform-demo.mjs` / `src/lib/seed-uniform.ts`
 *     按天均匀补的近期数据（让「统计报表」随便点哪天都有内容）
 *   · 冒烟脚本留下的短期单（跑完会话结束，不会自动清）
 *
 * 这些单**不该被写进演示数据文件**：
 *   · 它们的日期是「生成那天」的绝对值，文件一旦落盘就开始变旧；
 *   · 设置页「一键导入」在 SQL 导入完会调用 `seedUniformDemo` 按**导入当天**
 *     重新补一遍（见 src/app/(main)/settings/demo-actions.ts 末尾），
 *     文件里再带一份只会重复，且可能把旧日期锚死；
 *   · `npm run db:load-demo` 用的整库包同理 —— 打包前清掉，由打包脚本按
 *     **打包当天**重新生成，包才不会一开箱就是一堆逾期在住单。
 *
 * ── 排除口径（按引用关系闭包，不靠猜表名）──
 *
 * 1. 四张主表的单号列 `stay_no` / `booking_no` / `folio_no` / `pay_no`
 *    以 `DEMO-` 开头 → 该行是演示生成单；
 * 2. 其余表凡是带 `*_no` 文本列的值以 `DEMO-` 开头 → 同一批；
 * 3. 其余表凡是带 `stay_id` / `booking_id` / `folio_id` / `payment_id` /
 *    `refund_of` 列且值落在上面四张表被排除的 id 集合里 → 派生数据（明细 / 流水 /
 *    房量明细 / 早餐 / 发票 / 应收 …），一起排除。
 *
 * 现有库 93 张表实测命中：stays / bookings / folios / payments / folio_items /
 * booking_rooms 六张（其余表没有引用），但口径按列名自动发现，将来加表也不会漏。
 */

/** 单号前缀（生成器统一用这个前缀） */
export const DEMO_PREFIX = "DEMO-";
export const DEMO_LIKE = `${DEMO_PREFIX}%`;

/**
 * 「某张表的某列引用四张主表的主键」的映射。
 *
 * 不读 PRAGMA foreign_key_list：本库没有声明外键（实测 0 条），
 * 只能按列名约定识别；`refund_of` 存的是 payments.id。
 */
const ID_REF_COLUMNS = [
  ["stay_id", "stays"],
  ["booking_id", "bookings"],
  ["folio_id", "folios"],
  ["payment_id", "payments"],
  ["refund_of", "payments"],
];

/** 库里所有业务表（跳过 sqlite_*） */
export function listTables(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

/** 表的所有列名（顺序同 SELECT *） */
export function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name);
}

/** SQL 标识符转义 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** 四张主表里 DEMO 前缀行的 id 集合 */
export function collectDemoIds(db) {
  const pick = (table, col) => {
    try {
      return db
        .prepare(`SELECT id FROM ${quoteIdent(table)} WHERE COALESCE(${quoteIdent(col)}, '') LIKE ?`)
        .all(DEMO_LIKE)
        .map((r) => Number(r.id));
    } catch {
      return [];
    }
  };
  return {
    stays: pick("stays", "stay_no"),
    bookings: pick("bookings", "booking_no"),
    folios: pick("folios", "folio_no"),
    payments: pick("payments", "pay_no"),
  };
}

/** 四张主表被排除的 id 总数（日志用） */
export function demoIdCounts(ids) {
  return {
    stays: ids.stays.length,
    bookings: ids.bookings.length,
    folios: ids.folios.length,
    payments: ids.payments.length,
  };
}

/**
 * 生成某张表的排除条件（没有可排除的列则返回 null）
 *
 * 直接可用在 `WHERE NOT (...)` / `DELETE FROM t WHERE ...`。
 *
 * @param {string} table
 * @param {string[]} columns
 * @param {{stays:number[], bookings:number[], folios:number[], payments:number[]}} ids
 * @returns {string|null}
 */
export function demoExclusionWhere(table, columns, ids) {
  const has = new Set(columns);
  const parts = [];

  for (const [col, setKey] of ID_REF_COLUMNS) {
    const set = ids[setKey];
    if (!has.has(col) || !set || set.length === 0) continue;
    parts.push(`${quoteIdent(col)} IN (${set.join(",")})`);
  }
  for (const col of columns) {
    if (!/_no$/.test(col)) continue;
    parts.push(`COALESCE(${quoteIdent(col)}, '') LIKE '${DEMO_LIKE}'`);
  }
  return parts.length > 0 ? parts.join(" OR ") : null;
}

/**
 * 从库里清掉 DEMO 前缀单及其派生行（打包整库包前用；真库也可在备份后跑）
 *
 * 迭代表到不动点：payments.refund_of 这类「同表引用」要等第一轮删完才会浮出来。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{removed: Record<string, number>, rounds: number, total: number}}
 */
export function deleteDemoResidue(db) {
  const tables = listTables(db);
  const removed = {};
  let rounds = 0;
  let total = 0;

  for (;;) {
    rounds++;
    const ids = collectDemoIds(db);
    let changed = 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of tables) {
        const cols = tableColumns(db, t);
        const where = demoExclusionWhere(t, cols, ids);
        if (!where) continue;
        const res = db.prepare(`DELETE FROM ${quoteIdent(t)} WHERE ${where}`).run();
        const n = Number(res.changes ?? 0);
        if (n > 0) {
          removed[t] = (removed[t] ?? 0) + n;
          changed += n;
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 可能已自动回滚 */
      }
      throw e;
    }

    total += changed;
    if (changed === 0 || rounds >= 10) break;
  }

  return { removed, rounds, total };
}

/* ══════════════════════════════════════════════════ 体检 */

const safeOne = (db, sql) => {
  try {
    return db.prepare(sql).get() ?? {};
  } catch {
    return {};
  }
};

/** 四类遗留问题的判定口径（与 fix-demo-data-issues.mjs / roll-demo-dates.mjs 一致） */
const NIGHTS_EXPR = `CAST(julianday(date(expect_check_out)) - julianday(date(check_in_time)) AS INTEGER)`;
const NIGHTS_WHERE = `check_in_time IS NOT NULL AND expect_check_out IS NOT NULL
        AND ${NIGHTS_EXPR} >= 1
        AND COALESCE(nights, -1) <> ${NIGHTS_EXPR}
        AND NOT (COALESCE(nights, 0) = 0 AND COALESCE(remark, '') LIKE '%钟点%')`;
const ZERO_DEPOSIT_SQL = `SELECT COUNT(*) AS c FROM folio_items fi JOIN folios f ON f.id = fi.folio_id
   WHERE fi.item_type = 'DEPOSIT' AND fi.amount = 0 AND f.status = 'SETTLED'`;

/**
 * 演示数据包 / 演示库体检：日期锚点 + nights 一致性 + 零额押金 + AR 台账
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{
 *   today: string,
 *   tables: number, rooms: number, stays: number, bookings: number,
 *   folios: number, payments: number, guests: number,
 *   inhouse: number, overdue: number, dueToday: number, future: number,
 *   nightsMismatch: number, zeroDeposit: number, arLedgers: number,
 *   demo: { stays: number, bookings: number, folios: number, payments: number }
 * }}
 */
export function inspectDemoMetrics(db) {
  const c = (sql) => Number(safeOne(db, sql).c ?? 0);

  const inhouseRow = safeOne(
    db,
    `SELECT COUNT(*) AS total,
            CAST(SUM(CASE WHEN expect_check_out <  date('now','localtime') THEN 1 ELSE 0 END) AS INTEGER) AS overdue,
            CAST(SUM(CASE WHEN expect_check_out =  date('now','localtime') THEN 1 ELSE 0 END) AS INTEGER) AS dueToday,
            CAST(SUM(CASE WHEN expect_check_out >  date('now','localtime') THEN 1 ELSE 0 END) AS INTEGER) AS future
       FROM stays WHERE status = 'INHOUSE'`
  );

  return {
    today: String(safeOne(db, `SELECT date('now','localtime') AS d`).d ?? ""),
    tables: c(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`),
    rooms: c(`SELECT COUNT(*) AS c FROM rooms`),
    stays: c(`SELECT COUNT(*) AS c FROM stays`),
    bookings: c(`SELECT COUNT(*) AS c FROM bookings`),
    folios: c(`SELECT COUNT(*) AS c FROM folios`),
    payments: c(`SELECT COUNT(*) AS c FROM payments`),
    guests: c(`SELECT COUNT(*) AS c FROM guests`),
    inhouse: Number(inhouseRow.total ?? 0),
    overdue: Number(inhouseRow.overdue ?? 0),
    dueToday: Number(inhouseRow.dueToday ?? 0),
    future: Number(inhouseRow.future ?? 0),
    nightsMismatch: c(`SELECT COUNT(*) AS c FROM stays WHERE ${NIGHTS_WHERE}`),
    zeroDeposit: c(ZERO_DEPOSIT_SQL),
    arLedgers: c(`SELECT COUNT(*) AS c FROM ar_ledgers`),
    demo: {
      stays: c(`SELECT COUNT(*) AS c FROM stays WHERE stay_no LIKE '${DEMO_LIKE}'`),
      bookings: c(`SELECT COUNT(*) AS c FROM bookings WHERE booking_no LIKE '${DEMO_LIKE}'`),
      folios: c(`SELECT COUNT(*) AS c FROM folios WHERE folio_no LIKE '${DEMO_LIKE}'`),
      payments: c(`SELECT COUNT(*) AS c FROM payments WHERE COALESCE(pay_no, '') LIKE '${DEMO_LIKE}'`),
    },
  };
}

/**
 * 四条验收线（逾期 0 / nights 0 / 零额押金 0 / AR 台账 23）
 *
 * @param {ReturnType<typeof inspectDemoMetrics>} m
 * @param {{arLedgers?: number}} [expect]
 */
export function checkDemoMetrics(m, expect = {}) {
  const expectAr = expect.arLedgers ?? 23;
  return [
    { name: "在住单逾期", value: m.overdue, expect: 0, ok: m.overdue === 0, unit: "张" },
    { name: "nights 与入离差不符", value: m.nightsMismatch, expect: 0, ok: m.nightsMismatch === 0, unit: "张" },
    { name: "已结账单零额押金明细", value: m.zeroDeposit, expect: 0, ok: m.zeroDeposit === 0, unit: "行" },
    { name: "ar_ledgers 行数", value: m.arLedgers, expect: expectAr, ok: m.arLedgers === expectAr, unit: "行" },
  ];
}
