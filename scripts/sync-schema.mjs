/**
 * 对比并补齐数据库结构（缺表补表、缺列补列）
 *
 * 用法：
 *   node scripts/sync-schema.mjs                 # 实际执行
 *   node scripts/sync-schema.mjs --check         # 只报告差异，不执行
 *
 * ── 它解决什么问题 ──
 *
 * 全新部署时，目标机上的库是「init-db + migrate-all」建出来的，与当前代码
 * 需要的结构有差异。实测 VPS 上出现过：
 *   Error: no such table: shop_sales      ← /rooms 500
 *   Error: no such column: sort           ← /settings 500
 *
 * 前者能靠 schema-full.sql（CREATE TABLE IF NOT EXISTS）补；
 * **后者补不了** —— 表已经存在，IF NOT EXISTS 会整条跳过，不会加列。
 *
 * 所以需要逐表逐列比对：
 *   · 表缺失 → 执行 schema-full.sql 里对应的 CREATE TABLE
 *   · 列缺失 → ALTER TABLE ADD COLUMN（带默认值，保证已有行不违反约束）
 *   · 索引缺失 → CREATE INDEX IF NOT EXISTS
 *
 * ── 关于 ALTER TABLE 的限制 ──
 * SQLite 加列不支持 PRIMARY KEY / UNIQUE，也不支持 NOT NULL 无默认值。
 * 遇到这类列只能跳过并报告（正常业务列不会这样，主键是建表时就有的）。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbFile = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const fingerprintFile = process.env.PMS_SCHEMA_FINGERPRINT ?? join(root, "scripts", "schema-fingerprint.json");
const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(dbFile)) {
  console.error(`数据库不存在：${dbFile}（请先跑 init-db）`);
  process.exit(1);
}
if (!existsSync(fingerprintFile)) {
  console.error(
    `缺少结构指纹：${fingerprintFile}\n` +
      `请先在一个完整的库上导出：\n` +
      `  node scripts/dump-schema.mjs > scripts/schema-fingerprint.json`
  );
  process.exit(1);
}

const fp = JSON.parse(readFileSync(fingerprintFile, "utf8"));
const db = new DatabaseSync(dbFile);

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

function tableExists(name) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name)
  );
}
function columnsOf(name) {
  try {
    return db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

const missingTables = [];
const missingColumns = [];
const addedColumns = [];
const skipped = [];
const errors = [];

/* ─────────── 1. 缺表 ─────────── */
for (const t of Object.keys(fp.tables)) {
  if (!tableExists(t)) missingTables.push(t);
}

/* ─────────── 2. 缺列 ─────────── */
for (const [t, cols] of Object.entries(fp.tables)) {
  if (!tableExists(t)) continue; // 整表缺失，第 3 步统一建
  const have = new Set(columnsOf(t));
  for (const c of cols) {
    if (!have.has(c.name)) missingColumns.push({ table: t, col: c });
  }
}

console.log(`结构对比：指纹里有 ${Object.keys(fp.tables).length} 张表`);
console.log(`  缺表：${missingTables.length} 张`);
console.log(`  缺列：${missingColumns.length} 个`);

if (CHECK_ONLY) {
  missingTables.forEach((t) => console.log(`    · 缺表 ${t}`));
  missingColumns.slice(0, 20).forEach(({ table, col }) => console.log(`    · 缺列 ${table}.${col.name}`));
  if (missingColumns.length > 20) console.log(`    ... 还有 ${missingColumns.length - 20} 个`);
  db.close();
  process.exit(0);
}

/* ─────────── 3. 建缺的表（从 schema-full.sql 里找 DDL）─────────── */
const schemaSqlFile = join(here, "schema-full.sql");
if (missingTables.length > 0 && existsSync(schemaSqlFile)) {
  const sqlText = readFileSync(schemaSqlFile, "utf8");
  const statements = sqlText
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const t of missingTables) {
    /* 找到创建这张表的语句（CREATE TABLE [IF NOT EXISTS] "t" / t） */
    const re = new RegExp(`^CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${t}["\`]?\\s*\\(`, "i");
    const ddl = statements.find((s) => re.test(s));
    if (!ddl) {
      skipped.push(`缺表 ${t}：schema-full.sql 里找不到建表语句`);
      continue;
    }
    try {
      db.exec(ddl);
    } catch (e) {
      errors.push(`建表 ${t} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/* ─────────── 4. 补缺的列 ─────────── */
for (const { table, col } of missingColumns) {
  /* 主键列不能后加 */
  if (col.pk && Number(col.pk) > 0) {
    skipped.push(`缺列 ${table}.${col.name}：主键列无法 ALTER 添加`);
    continue;
  }
  /*
   * 构造 ALTER 语句。
   * NOT NULL 必须有默认值 —— 表里已有行，加一个无默认值的 NOT NULL 列会失败。
   * 没有默认值时退化成「可空列」，功能上够用（业务写入时会赋值）。
   */
  const def = col.dflt_value === null || col.dflt_value === undefined ? null : String(col.dflt_value);
  const type = col.type || "TEXT";
  let stmt = `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(col.name)} ${type}`;
  if (Number(col.notnull) === 1 && def !== null) stmt += " NOT NULL";
  if (def !== null) stmt += ` DEFAULT ${def}`;
  try {
    db.exec(stmt);
    addedColumns.push(`${table}.${col.name}`);
  } catch (e) {
    errors.push(`加列 ${table}.${col.name} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ─────────── 5. 补索引 ─────────── */
let addedIndexes = 0;
for (const idx of fp.indexes ?? []) {
  if (!tableExists(idx.table)) continue;
  try {
    /* 把 CREATE INDEX 改成 IF NOT EXISTS，避免已存在时报错 */
    const sql = String(idx.sql).replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (m, u) =>
      `CREATE ${u ?? ""}INDEX IF NOT EXISTS `
    );
    db.exec(sql);
    addedIndexes++;
  } catch (e) {
    errors.push(`建索引 ${idx.name} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

db.close();

/* ─────────── 汇总 ─────────── */
const after = (() => {
  const d = new DatabaseSync(dbFile, { readOnly: true });
  const n = d.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get().c;
  d.close();
  return n;
})();

console.log(`\n处理结果：`);
console.log(`  补表：${missingTables.length - skipped.filter((s) => s.includes("缺表")).length} 张`);
console.log(`  补列：${addedColumns.length} 个`);
console.log(`  补索引：${addedIndexes} 条`);
if (skipped.length > 0) {
  console.log(`  跳过：${skipped.length} 条`);
  skipped.slice(0, 10).forEach((s) => console.log(`    · ${s}`));
}
if (errors.length > 0) {
  console.log(`  失败：${errors.length} 条`);
  errors.slice(0, 10).forEach((e) => console.log(`    · ${e}`));
}
console.log(`  表总数：${after}`);

const ok = errors.length === 0;
console.log(ok ? "\n✅ 结构已同步\n" : "\n⚠️ 有失败项，见上\n");
process.exit(ok ? 0 : 1);
