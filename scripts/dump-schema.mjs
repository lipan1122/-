/**
 * 导出数据库结构指纹（供另一台机器对比 / 补列）
 *
 * 用法：
 *   node scripts/dump-schema.mjs                       # 输出到 stdout
 *   node scripts/dump-schema.mjs > schema-fingerprint.json
 *
 * 输出内容：
 *   { tables: { 表名: [ { name, type, notnull, dflt_value, pk }, ... ] }, indexes: [...] }
 *
 * 用途：
 *   全新部署时，VPS 上的库可能是「旧版 init-db + migrate-all」建出来的，
 *   与当前代码需要的结构有差异（缺表、缺列）。只用 CREATE TABLE IF NOT EXISTS
 *   补不了「表存在但缺列」的情况 —— 那需要 ALTER TABLE ADD COLUMN。
 *
 *   所以导出这份指纹，由 compare-schema.mjs 在目标库上逐表逐列比对，
 *   生成需要执行的 ALTER 语句。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbFile = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");

if (!existsSync(dbFile)) {
  console.error(`数据库不存在：${dbFile}`);
  process.exit(1);
}

const db = new DatabaseSync(dbFile, { readOnly: true });

const tables = {};
const tableNames = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all()
  .map((r) => r.name);

for (const t of tableNames) {
  tables[t] = db
    .prepare(`PRAGMA table_info(${JSON.stringify(t)})`)
    .all()
    .map((c) => ({
      name: c.name,
      type: c.type ?? "",
      notnull: c.notnull ?? 0,
      dflt_value: c.dflt_value ?? null,
      pk: c.pk ?? 0,
    }));
}

const indexes = db
  .prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`
  )
  .all()
  .map((r) => ({ name: r.name, table: r.tbl_name, sql: r.sql }));

db.close();

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), tables, indexes }, null, 2));
