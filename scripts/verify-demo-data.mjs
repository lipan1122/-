/**
 * 演示数据包验收（整库包 / SQL 包两条路径都验）
 *
 * 用法：
 *   node scripts/verify-demo-data.mjs --db  scripts/demo-data/pms-demo.db.gz
 *       └ 自动解压到临时目录再查（也可以直接给解压后的 .db）
 *
 *   node scripts/verify-demo-data.mjs --sql scripts/demo-data/demo-data.sql.gz
 *       └ 在 data/pms.db 的副本上，按 settings/demo-actions.ts 的切分逻辑
 *         原样执行一遍（DELETE + INSERT + 末尾日期滚动段），再查导入结果
 *
 * 判定线（四条硬指标）：
 *   在住单逾期 0 / nights 与入离差不符 0 / 已结账单零额押金明细 0 / ar_ledgers 23 行
 *
 * 另外报告：表数、房/预订/入住单/账单/流水/客人行数、在住分布、生成单是否清零、
 * SQL 文本里生成单前缀出现次数、import 语句条数、integrity_check。
 *
 * 可选：
 *   --base <db>     --sql 模式用的基准库（默认 data/pms.db）
 *   --keep-tmp      保留临时目录便于排查
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDemoMetrics, checkDemoMetrics } from "./demo-data-filter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbArg = argValue("--db");
const sqlArg = argValue("--sql");
const baseArg = argValue("--base");
const KEEP_TMP = args.includes("--keep-tmp");

if (!dbArg && !sqlArg) {
  console.error("用法：node scripts/verify-demo-data.mjs --db <包或 .db> | --sql <sql 或 sql.gz> [--base <db>]");
  process.exit(2);
}

const ts = `${Date.now()}-${process.pid}`;
const tmpDir = join(root, ".tmp", `verify-demo-${ts}`);
mkdirSync(tmpDir, { recursive: true });

const isGz = (p) => /\.gz$/i.test(p);

/** 解压到临时目录（.gz → 同名去后缀；否则原样返回） */
function unpack(path) {
  if (!isGz(path)) return path;
  const out = join(tmpDir, basename(path).replace(/\.gz$/i, ""));
  writeFileSync(out, gunzipSync(readFileSync(path)));
  return out;
}

/** 与 settings/demo-actions.ts 完全一致的切分方式（先去注释行，再按「分号 + 换行」切） */
function splitStatements(sqlText) {
  return sqlText
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith(";") ? s : `${s};`));
}

function vacuumInto(db, target) {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/** 执行 SQL 包（返回执行条数） */
function importSql(sqlFile) {
  const base = baseArg ?? join(root, "data", "pms.db");
  if (!existsSync(base)) {
    throw new Error(`基准库不存在：${base}`);
  }

  const text = isGz(sqlFile)
    ? gunzipSync(readFileSync(sqlFile)).toString("utf8")
    : readFileSync(sqlFile, "utf8");
  const statements = splitStatements(text);
  const demoMentions = (text.match(/DEMO-/g) ?? []).length;

  const copy = join(tmpDir, "imported.db");
  {
    const src = new DatabaseSync(base, { readOnly: true });
    vacuumInto(src, copy);
    src.close();
  }

  const db = new DatabaseSync(copy);
  let executed = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const stmt of statements) {
      db.exec(stmt);
      executed++;
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 可能已自动回滚 */
    }
    throw new Error(`导入第 ${executed + 1}/${statements.length} 条失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { dbPath: copy, executed, total: statements.length, demoMentions };
}

let failed = false;
try {
  let dbPath;
  let sqlInfo = null;

  if (sqlArg) {
    console.log(`SQL 包：${sqlArg}`);
    const info = importSql(sqlArg);
    dbPath = info.dbPath;
    sqlInfo = { executed: info.executed, total: info.total, demoMentions: info.demoMentions };
    console.log(
      `  按 demo-actions 切分执行：${info.executed}/${info.total} 条语句全部成功；` +
        `SQL 文本里生成单前缀 ${info.demoMentions} 处`
    );
  } else {
    console.log(`整库包：${dbArg}`);
    dbPath = unpack(dbArg);
    console.log(`  解压/读取：${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let metrics;
  let integrity;
  try {
    integrity = String(db.prepare("PRAGMA integrity_check").get().integrity_check ?? "");
    metrics = inspectDemoMetrics(db);
  } finally {
    db.close();
  }

  const checks = checkDemoMetrics(metrics);

  console.log(`\n库概况（今天 ${metrics.today}）`);
  console.log(
    `  表 ${metrics.tables} 张 · 房 ${metrics.rooms} 间 · 预订 ${metrics.bookings} 条 · 入住单 ${metrics.stays} 张 · ` +
      `账单 ${metrics.folios} 张 · 流水 ${metrics.payments} 条 · 客人 ${metrics.guests} 个`
  );
  console.log(
    `  在住 ${metrics.inhouse} 张（今日应退 ${metrics.dueToday} / 未到期 ${metrics.future}）· ` +
      `生成单：入住单 ${metrics.demo.stays} / 预订 ${metrics.demo.bookings} / 账单 ${metrics.demo.folios} / 流水 ${metrics.demo.payments}`
  );
  console.log(`  integrity_check：${integrity}`);

  console.log(`\n四条硬指标`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}：${c.value} ${c.unit}（要求 ${c.expect}）`);
    if (!c.ok) failed = true;
  }
  if (integrity !== "ok") failed = true;

  if (sqlArg) {
    /* SQL 包里不该有任何生成单；导入后库里也应清零（统一补数据由 demo-actions 事后补） */
    const demoClean = metrics.demo.stays === 0 && metrics.demo.bookings === 0;
    console.log(`\n${demoClean ? "✅" : "❌"} 导入后库内生成单已清零（入住单 ${metrics.demo.stays} / 预订 ${metrics.demo.bookings}）`);
    if (!demoClean) failed = true;
    if (sqlInfo.demoMentions !== 0) {
      console.log(`❌ SQL 文本里仍有生成单前缀 ${sqlInfo.demoMentions} 处`);
      failed = true;
    }
  }

  console.log(`\n结论：${failed ? "❌ 未通过" : "✅ 通过"}`);
} finally {
  if (!KEEP_TMP) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 忽略占用 */
    }
  } else {
    console.log(`（--keep-tmp）临时目录：${tmpDir}`);
  }
}

if (failed) process.exit(1);
