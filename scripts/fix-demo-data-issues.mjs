/**
 * 演示数据一致性体检 / 修复（问题 2 + 问题 3）
 *
 * 独立验证 agent 实测出三类演示数据问题，本脚本负责其中两类：
 *
 *   问题 2（中）8 条 DEPOSIT 明细 amount=0 藏在 SETTLED 账单里
 *                → qty × price ≠ amount，「明细与金额一致性」检查永远报警
 *   问题 3（中）5 张 SI6xxx 的 nights=2 但入离差 3 天
 *                → 以日期为准回填 nights（房费明细本来就是按 3 晚入账的）
 *
 * 问题 1（严重，21 张在住单逾期）属于「日期锚点」问题，不在本脚本里 ——
 * 它需要按天滚动，见 `scripts/roll-demo-dates.mjs`。
 *
 * ── 为什么修复逻辑放在这个文件而不是直接内联进 migrate-all ──
 * 同一份修复要能从这里单独跑（只想修这两类、不惊动别的迁移段），
 * 也要能由 `scripts/migrate-all.mjs` 第 22 段在每次迁移时自查执行。
 * 两处各写一份必然漂移，所以只写一份，由 migrate-all import。
 *
 * ── 用法 ──
 *   node scripts/fix-demo-data-issues.mjs            # 只体检（默认，不写库）
 *   node scripts/fix-demo-data-issues.mjs --apply    # 先 VACUUM INTO 备份，再修复
 *   node scripts/fix-demo-data-issues.mjs --json     # 机器可读输出
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** 问题 2 的判定：已结账单里的零额押金明细 */
const ZERO_DEPOSIT_JOIN = `folio_items fi JOIN folios f ON f.id = fi.folio_id`;
const ZERO_DEPOSIT_WHERE = `fi.item_type = 'DEPOSIT' AND fi.amount = 0 AND f.status = 'SETTLED'`;

/** 问题 3 的判定：nights 与实测入离差不一致（钟点房除外） */
const NIGHTS_EXPR = `CAST(julianday(date(expect_check_out)) - julianday(date(check_in_time)) AS INTEGER)`;
const NIGHTS_WHERE = `check_in_time IS NOT NULL AND expect_check_out IS NOT NULL
        AND ${NIGHTS_EXPR} >= 1
        AND COALESCE(nights, -1) <> ${NIGHTS_EXPR}
        AND NOT (COALESCE(nights, 0) = 0 AND COALESCE(remark, '') LIKE '%钟点%')`;

/* ══════════════════════════════════════════════════ 体检（只读） */

/**
 * 一次读清三类问题的现状，给报告 / 验收用。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{
 *   dateRoll: { inhouse: number, overdue: number, dueToday: number, future: number, oldest: any[] },
 *   zeroDeposit: { count: number, rows: any[] },
 *   nightsMismatch: { count: number, rows: any[] }
 * }}
 */
export function inspectDemoData(db) {
  const has = (t) => {
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`).get(t).n > 0;
    } catch {
      return false;
    }
  };

  /* 问题 1：在住单逾期分布（口径同 src/app/(main)/dashboard/alerts.ts：
        status='INHOUSE' 且 expect_check_out < 今天 → 逾期未离店） */
  const dateRoll = { inhouse: 0, overdue: 0, dueToday: 0, future: 0, oldest: [] };
  if (has("stays")) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                CAST(SUM(CASE WHEN expect_check_out <  date('now','localtime') THEN 1 ELSE 0 END) AS INTEGER) AS overdue,
                CAST(SUM(CASE WHEN expect_check_out =  date('now','localtime') THEN 1 ELSE 0 END) AS INTEGER) AS dueToday,
                CAST(SUM(CASE WHEN expect_check_out >  date('now','localtime') THEN 1 ELSE 0 END) AS INTEGER) AS future
           FROM stays WHERE status = 'INHOUSE'`
      )
      .get();
    dateRoll.inhouse = Number(row.total ?? 0);
    dateRoll.overdue = Number(row.overdue ?? 0);
    dateRoll.dueToday = Number(row.dueToday ?? 0);
    dateRoll.future = Number(row.future ?? 0);
    dateRoll.oldest = db
      .prepare(
        `SELECT stay_no, room_id,
                substr(check_in_time, 1, 10) AS check_in,
                substr(expect_check_out, 1, 10) AS expect_out,
                CAST(julianday(date('now','localtime')) - julianday(expect_check_out) AS INTEGER) AS overdue_days
           FROM stays
          WHERE status = 'INHOUSE' AND expect_check_out < date('now','localtime')
          ORDER BY expect_check_out, id`
      )
      .all();
  }

  /* 问题 2：已结账单里 amount=0 的押金明细 */
  const zeroDeposit = { count: 0, rows: [] };
  if (has("folio_items") && has("folios")) {
    zeroDeposit.rows = db
      .prepare(
        `SELECT fi.id, f.folio_no, f.status AS folio_status, fi.qty, fi.price, fi.amount,
                s.stay_no, s.status AS stay_status
           FROM ${ZERO_DEPOSIT_JOIN} LEFT JOIN stays s ON s.id = f.stay_id
          WHERE ${ZERO_DEPOSIT_WHERE}
          ORDER BY fi.id`
      )
      .all();
    zeroDeposit.count = zeroDeposit.rows.length;
  }

  /* 问题 3：nights 与入离差不符 */
  const nightsMismatch = { count: 0, rows: [] };
  if (has("stays")) {
    nightsMismatch.rows = db
      .prepare(
        `SELECT id, stay_no, status, nights, ${NIGHTS_EXPR} AS real_nights,
                substr(check_in_time, 1, 10) AS check_in,
                substr(expect_check_out, 1, 10) AS expect_out
           FROM stays WHERE ${NIGHTS_WHERE} ORDER BY id`
      )
      .all();
    nightsMismatch.count = nightsMismatch.rows.length;
  }

  return { dateRoll, zeroDeposit, nightsMismatch };
}

/* ══════════════════════════════════════════════════ 修复（幂等） */

/**
 * 修问题 2 + 问题 3。幂等：干净库上执行 0 行。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ checkOnly?: boolean }} [options]
 * @returns {{ changed: number, applied: string[], skipped: string[], notes: string[] }}
 */
export function repairDemoDataConsistency(db, { checkOnly = false } = {}) {
  const applied = [];
  const skipped = [];
  const notes = [];
  let changed = 0;

  const has = (t) => {
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`).get(t).n > 0;
    } catch {
      return false;
    }
  };

  /* ── 问题 2：删掉已结账单里 amount=0 的押金明细 ──
   *
   * 只删 SETTLED 的：在住单（OPEN）的 DEPOSIT 行 amount=0 可能另有含义
   * （例如尚未实收），账单没结，行还有用，删掉会把押金线索抹掉。 */
  if (has("folio_items") && has("folios")) {
    const n = Number(
      db.prepare(`SELECT COUNT(*) AS n FROM ${ZERO_DEPOSIT_JOIN} WHERE ${ZERO_DEPOSIT_WHERE}`).get()?.n ?? 0
    );
    if (n === 0) {
      skipped.push("folio_items 零额押金明细（已清理）");
    } else if (checkOnly) {
      applied.push(`folio_items 零额押金明细（待删 ${n} 行）`);
    } else {
      const del = db
        .prepare(
          `DELETE FROM folio_items
            WHERE item_type = 'DEPOSIT' AND amount = 0
              AND folio_id IN (SELECT id FROM folios WHERE status = 'SETTLED')`
        )
        .run();
      applied.push(`folio_items 零额押金明细（删 ${Number(del.changes)} 行）`);
      notes.push(
        "零额押金明细：bill SETTLED、余额已 0、押金早已退净，这些行只剩「单价×数量≠金额」的噪音，" +
          "删掉不改变任何账单金额"
      );
      changed += 1;
    }
  } else {
    skipped.push("folio_items 零额押金明细（表不存在）");
  }

  /* ── 问题 3：nights 按实际入离差回填 ──
   *
   * 以日期为准而不是以 nights 为准：这 5 张单的房费明细本来就算的 3 晚，
   * 是 nights 列自己写错了。钟点房（nights=0 且备注含「钟点」）是合法的 0 晚，排除。 */
  if (has("stays")) {
    let bad = [];
    try {
      bad = db.prepare(`SELECT id, stay_no, nights, ${NIGHTS_EXPR} AS real_nights FROM stays WHERE ${NIGHTS_WHERE}`).all();
    } catch {
      bad = [];
    }
    if (bad.length === 0) {
      skipped.push("stays.nights 与入离差（已一致）");
    } else if (checkOnly) {
      applied.push(
        `stays.nights 按入离差回填（待改 ${bad.length} 张：` +
          `${bad.map((r) => `${r.stay_no} ${r.nights}→${r.real_nights}`).join("、")}）`
      );
    } else {
      const upd = db.prepare(`UPDATE stays SET nights = ${NIGHTS_EXPR} WHERE ${NIGHTS_WHERE}`).run();
      applied.push(`stays.nights 按入离差回填（改 ${Number(upd.changes)} 张）`);
      notes.push(
        `nights 回填：${bad.map((r) => `${r.stay_no} ${r.nights}→${r.real_nights}`).join("、")}`
      );
      changed += 1;
    }
  } else {
    skipped.push("stays.nights（表不存在）");
  }

  return { changed, applied, skipped, notes };
}

/* ══════════════════════════════════════════════════ CLI */

function resolveDbPath() {
  return process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
}

function printReport(rep, label) {
  const { dateRoll, zeroDeposit, nightsMismatch } = rep;
  console.log(`\n── ${label} ──`);

  const p1 = dateRoll.overdue === 0 && dateRoll.inhouse > 0 ? "✅" : dateRoll.overdue > 0 ? "❌" : "·";
  console.log(
    `${p1} 问题 1 在住单日期：在住 ${dateRoll.inhouse} 张（逾期 ${dateRoll.overdue} / 今日应退 ${dateRoll.dueToday} / 未到期 ${dateRoll.future}）`
  );
  for (const s of dateRoll.oldest.slice(0, 5)) {
    console.log(`     · ${s.stay_no} 入住 ${s.check_in} 应退 ${s.expect_out} 逾期 ${s.overdue_days} 天`);
  }
  if (dateRoll.overdue > 0) {
    console.log("     → 修复：node scripts/roll-demo-dates.mjs --apply");
  }

  console.log(
    `${zeroDeposit.count === 0 ? "✅" : "❌"} 问题 2 零额押金明细：${zeroDeposit.count} 行` +
      (zeroDeposit.count > 0 ? `（${zeroDeposit.rows.map((r) => `${r.folio_no}/${r.stay_no ?? "-"}/¥${r.price}`).join("、")}）` : "")
  );

  console.log(
    `${nightsMismatch.count === 0 ? "✅" : "❌"} 问题 3 nights 与入离差：${nightsMismatch.count} 张` +
      (nightsMismatch.count > 0
        ? `（${nightsMismatch.rows.map((r) => `${r.stay_no} ${r.nights}→${r.real_nights}`).join("、")}）`
        : "")
  );
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const asJson = args.includes("--json");
  const dbPath = resolveDbPath();

  if (!existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");

  const before = inspectDemoData(db);
  const beforeRepair = repairDemoDataConsistency(db, { checkOnly: true });

  if (!apply) {
    if (asJson) {
      console.log(JSON.stringify({ dbPath, before, pending: beforeRepair }, null, 2));
    } else {
      console.log(`数据库：${dbPath}`);
      console.log("模式：仅体检（不写库）");
      printReport(before, "现状");
      console.log(`\n待修复：${beforeRepair.applied.length} 项`);
      for (const a of beforeRepair.applied) console.log(`  + ${a}`);
      if (beforeRepair.applied.length === 0) console.log("  （无）");
      console.log("\n加 --apply 执行修复（会先 VACUUM INTO 备份）");
    }
    db.close();
    return;
  }

  if (beforeRepair.applied.length === 0) {
    console.log(`数据库：${dbPath}\n没有问题 2 / 问题 3 需要修复（幂等：已是目标状态）`);
    db.close();
    return;
  }

  /* 备份 */
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  const backupDir = join(root, "data", "backup");
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, `pms-before-demo-data-fix-${stamp}.db`);
  if (existsSync(backupFile)) throw new Error(`备份文件已存在：${backupFile}`);
  db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
  console.log(`数据库：${dbPath}`);
  console.log(`已备份：${backupFile}\n`);

  const result = repairDemoDataConsistency(db, { checkOnly: false });
  for (const a of result.applied) console.log(`  + ${a}`);
  for (const n of result.notes) console.log(`    ${n}`);

  const after = inspectDemoData(db);
  printReport(after, "修复后");

  if (asJson) console.log(JSON.stringify({ dbPath, backupFile, applied: result.applied, after }, null, 2));

  db.close();

  if (after.zeroDeposit.count !== 0 || after.nightsMismatch.count !== 0) {
    console.error("\n❌ 修复后仍有残留");
    process.exit(1);
  }
  console.log("\n✅ 问题 2 / 问题 3 已清零（问题 1 见 scripts/roll-demo-dates.mjs）");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
