/**
 * 确保数据库有完整的表结构（全新部署的关键）
 *
 * ── 为什么需要这个脚本 ──
 *
 * 本项目的建表语句分散在三处：
 *   1. `scripts/init-db.mjs` —— 22 张核心表（房间/预订/入住/账单…）
 *   2. `scripts/migrate-all.mjs` —— 9 张后加的表（渠道/会员…）
 *   3. **散落在各 page.tsx / actions.ts 里的懒建** —— 60 张
 *      （某个页面第一次被访问时才 CREATE TABLE）
 *
 * 第 3 类在长期使用的「老库」上没有问题（用得多的库早就建全了），
 * 但**全新部署会直接坏掉**：
 *
 *   在 VPS 上跑完 init-db + migrate-all 只有 30 张表，
 *   访问 /rooms 和 /settings 直接 500 —— 它们依赖的表还不存在。
 *   以前靠「把每个页面点一遍」来建表，这对交付部署完全不可接受。
 *
 * ── 做法 ──
 *
 * `scripts/schema-full.sql` 是从一个「已经跑起来的库」导出的完整 schema
 * （90 张表 + 61 个索引），本脚本在 init-db 之后执行它：
 *
 *   · 所有语句都是 `CREATE TABLE ...` / `CREATE INDEX ...`（导出时带了 IF NOT EXISTS 的保留原样）
 *   · 逐条执行，单条失败不影响后续（老库上表已存在会报错，属正常）
 *   · 幂等：重复执行不会破坏已有数据
 *
 * ── 维护约定 ──
 * 以后新增表时：
 *   1. 照旧在功能里写懒建（保持单页可用）
 *   2. **同时把它加进 scripts/schema-full.sql**
 *   否则下一次全新部署还是会缺表。
 *
 * 重新导出（在一个跑起来的库上）：
 *   见 README 或本文件底部注释。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schemaFile = join(here, "schema-full.sql");
const dbFile = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");

const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(schemaFile)) {
  console.error(`找不到 ${schemaFile}`);
  process.exit(1);
}
if (!existsSync(dbFile)) {
  console.error(`数据库不存在：${dbFile}（请先跑 init-db）`);
  process.exit(1);
}

const sqlText = readFileSync(schemaFile, "utf8");

/* 按分号切分（schema 里没有触发器/存储过程，不需要更复杂的解析） */
const statements = sqlText
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith("--"))
  .map((s) => s + ";");

const db = new DatabaseSync(dbFile);

const tableCount = () =>
  db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get().c;

const before = tableCount();
let created = 0;
let skipped = 0;
const errors = [];

for (const stmt of statements) {
  try {
    db.exec(stmt);
    created++;
  } catch (e) {
    /*
     * 「已存在」是最常见的正常失败：
     *   table xxx already exists / index xxx already exists
     * 其他错误收集起来，最后一起报告（但继续执行，避免一个坏语句挡住后面所有表）。
     */
    const msg = e instanceof Error ? e.message : String(e);
    if (/already exists/i.test(msg)) {
      skipped++;
    } else {
      errors.push(`${msg.slice(0, 120)}  ← ${stmt.slice(0, 80).replace(/\s+/g, " ")}`);
    }
  }
}

const after = tableCount();

console.log(`表结构：执行 ${statements.length} 条语句`);
console.log(`  已在：${skipped} 条（表/索引已存在，跳过）`);
console.log(`  成功：${created} 条`);
if (errors.length > 0) {
  console.log(`  失败：${errors.length} 条`);
  errors.slice(0, 8).forEach((e) => console.log(`    · ${e}`));
  if (errors.length > 8) console.log(`    ... 还有 ${errors.length - 8} 条`);
}
console.log(`表数量：${before} → ${after}`);

db.close();

/* 全新库建完应该是 88+ 张；低于 60 说明 schema 文件或数据库状态有问题 */
if (after < 60) {
  console.error(`\n❌ 表数量异常（${after} 张），全新部署会缺表。请检查 scripts/schema-full.sql`);
  process.exit(1);
}

console.log("\n✅ 表结构完整\n");
