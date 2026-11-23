/**
 * 从当前库导出「纯数据」SQL（不含建表语句）
 *
 * 用途：给设置页的「一键导入演示数据」按钮准备数据文件。
 *
 * 为什么不直接换 .db 文件：
 *   运行时进程已经打开了数据库连接，替换文件会导致：
 *     · 旧连接指着被删的 inode（读写都出错）
 *     · WAL/SHM 与新文件不一致
 *     · 必须重启进程才生效，而按钮点完不该要求用户去敲命令
 *
 * 用 SQL 导入则全程走同一个连接，事务内完成，页面刷新即可看到数据。
 *
 * 用法：
 *   node scripts/export-demo-sql.mjs                    # 导出到 scripts/demo-data/demo-data.sql
 *   node scripts/export-demo-sql.mjs --tables a,b,c     # 只导指定表
 *
 * 输出格式：
 *   每个表一段：
 *     DELETE FROM "表名";
 *     INSERT INTO "表名" VALUES (...),(...);   ← 分批，每批 200 行
 *   文件末尾再追加一段「导入时日期滚动」（见 scripts/roll-demo-dates.mjs 的
 *   buildImportBlock）——导出的入住日期是**导出那天**的绝对值，隔几天再导入就是
 *   一堆逾期在住单，工作台 / 夜审 / 报表全部虚高。这段 SQL 在导入时以「导入当天」
 *   为锚重新滚动，把这个问题根治在数据文件里，而不是指望谁记得手动跑脚本。
 *
 * ── 导出时排除「DEMO 前缀单」（冒烟 / 均匀补数据的产物）──
 *
 * 这些单是运行期生成的，日期锚在「生成那天」，写进文件就只会越来越旧；
 * 而设置页「一键导入」在 SQL 导入后本来就会调用 seedUniformDemo 按导入当天
 * 重新补一遍（见 src/app/(main)/settings/demo-actions.ts 末尾），文件里再带一份
 * 纯属重复。排除口径与依赖闭包见 scripts/demo-data-filter.mjs。
 *
 * 同时写出 .gz：设置页「一键导入演示数据」读的是 demo-data.sql.gz，只更新 .sql
 * 不更新 .gz 等于改了没人用 —— 之前靠手工 gzip，漏一次就两边不一致。
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { buildImportBlock } from "./roll-demo-dates.mjs";
import {
  collectDemoIds,
  demoIdCounts,
  demoExclusionWhere,
  tableColumns,
  quoteIdent,
} from "./demo-data-filter.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbFile = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const outFile = join(here, "demo-data", "demo-data.sql");

/*
 * 导出哪些表
 *
 * 排除说明（用不到就不用导，能显著减小文件）：
 *   · sqlite_*            系统表
 *   · op_logs / room_logs 操作日志（几千行，演示时没人看，且会暴露历史操作）
 *   · channel_sync_logs   渠道同步日志（同上）
 *   · channel_orders      1222 条渠道订单，占数据量近 1/4，演示时可以重新拉
 * 其余有数据的表全导。
 */
const SKIP = new Set([
  "op_logs",
  "room_logs",
  "channel_sync_logs",
  "channel_sync_queue",
  "channel_sync_dead_letter",
  "channel_orders",
  "sessions",
  "login_attempts",
]);

if (!existsSync(dbFile)) {
  console.error(`数据库不存在：${dbFile}`);
  process.exit(1);
}

const db = new DatabaseSync(dbFile, { readOnly: true });

const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all()
  .map((r) => r.name)
  .filter((t) => !SKIP.has(t));

/* 排除「DEMO 前缀单」及其派生行（口径集中在 demo-data-filter.mjs） */
const demoIds = collectDemoIds(db);
const excluded = {};
let excludedRows = 0;

/** SQL 字面量（NULL / 数字原样 / 其余按字符串转义） */
function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array) {
    /* BLOB：转成 X'..' 十六进制字面量 */
    return `X'${Buffer.from(v).toString("hex")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const chunks = [];
chunks.push("-- 云栖 PMS 演示数据（由 scripts/export-demo-sql.mjs 生成）");
chunks.push(`-- 生成时间：${new Date().toISOString()}`);
chunks.push(`-- 源库：${dbFile}`);
chunks.push("-- 说明：只含数据，不含建表语句；导入时会先清空同名表再插入。");
chunks.push("-- 说明：不含冒烟 / 均匀补数据生成的单据（导入后由 seedUniformDemo 按导入当天重新补）。\n");

let totalRows = 0;
const perTable = [];

for (const t of tables) {
  const cols = tableColumns(db, t);
  const where = demoExclusionWhere(t, cols, demoIds);

  let total = 0;
  try {
    total = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(t)}`).get().c ?? 0);
  } catch {
    continue;
  }
  if (total === 0) continue;

  let rows;
  try {
    /*
     * 注意：必须用 `IS NOT TRUE` 而不是 `NOT (...)`。
     * 排除条件里有 `folio_id IN (...)` / `refund_of IN (...)` 这类可能为 NULL 的列，
     * 三值逻辑下 `NOT NULL` 仍然是 NULL → 行不会进入结果集 —— 会**多删**正常数据
     * （实测把 ar_ledgers 23 行、真实流水 389 行整片滤掉）。
     */
    rows = db
      .prepare(`SELECT * FROM ${quoteIdent(t)}${where ? ` WHERE (${where}) IS NOT TRUE` : ""}`)
      .all();
  } catch {
    continue;
  }

  if (where && rows.length < total) {
    excluded[t] = total - rows.length;
    excludedRows += total - rows.length;
  }

  /*
   * 整张表都被排除（历史上可能有全由生成单构成的表）：
   * 仍然要发 DELETE —— 目标库里这些行必须先清掉，否则导入后残留。
   */
  if (rows.length === 0) {
    chunks.push(`-- ${t}：0 行（原有 ${total} 行全是生成单，已排除）`);
    chunks.push(`DELETE FROM ${quoteIdent(t)};`);
    chunks.push("");
    continue;
  }

  const colList = cols.map(quoteIdent).join(", ");
  totalRows += rows.length;
  perTable.push([t, rows.length]);

  chunks.push(`-- ${t}：${rows.length} 行`);
  chunks.push(`DELETE FROM ${quoteIdent(t)};`);

  /* 分批插入，每批 200 行，避免单条 SQL 过长 */
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = slice.map((r) => `(${cols.map((c) => lit(r[c])).join(",")})`).join(",");
    chunks.push(`INSERT INTO ${quoteIdent(t)} (${colList}) VALUES ${values};`);
  }
  chunks.push("");
}

/* ── 末尾追加「导入时日期滚动」段 ──
 *
 * 这一段必须是文件最后的语句：它要在所有表都插完之后，按「导入当天」重算日期。
 * 内容与 scripts/roll-demo-dates.mjs 共用同一个生成器，不要在这里手写 SQL。
 */
chunks.push("--");
chunks.push("-- ↓↓↓ 以下是导入时执行的日期滚动段（不是数据，是数据修正） ↓↓↓");
chunks.push("--");
chunks.push(buildImportBlock());

db.close();

mkdirSync(join(here, "demo-data"), { recursive: true });
const sql = chunks.join("\n");
writeFileSync(outFile, sql, "utf8");

/*
 * 运行时读的是 .gz（settings/demo-actions.ts），不是 .sql。
 * 两个文件必须一起更新，否则「一键导入演示数据」导入的还是旧数据。
 */
const gz = gzipSync(Buffer.from(sql, "utf8"), { level: 9 });
writeFileSync(`${outFile}.gz`, gz);

console.log(`已导出：${outFile}`);
console.log(`        ${outFile}.gz（${(gz.length / 1024).toFixed(0)} KB，设置页一键导入读这个）`);
console.log(`  ${perTable.length} 张表 / ${totalRows} 行`);
console.log(`  文件大小：${(Buffer.byteLength(sql) / 1024).toFixed(0)} KB`);

const idCounts = demoIdCounts(demoIds);
console.log(
  `  排除生成单：入住单 ${idCounts.stays} / 预订 ${idCounts.bookings} / 账单 ${idCounts.folios} / 流水 ${idCounts.payments}` +
    `，连带删除 ${excludedRows} 行（${Object.keys(excluded).length} 张表）`
);
for (const [t, n] of Object.entries(excluded)) console.log(`    - ${t}: ${n} 行`);

const demoMentions = (sql.match(/DEMO-/g) ?? []).length;
if (demoMentions > 0) {
  console.error(`  ❌ 导出文件里仍有 ${demoMentions} 处生成单前缀，请检查 demo-data-filter.mjs 的排除口径`);
  process.exitCode = 1;
} else {
  console.log(`  ✅ 导出文件里生成单前缀出现 0 次`);
}

console.log("\n前 12 张：");
perTable
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .forEach(([t, n]) => console.log(`  ${t}: ${n}`));
