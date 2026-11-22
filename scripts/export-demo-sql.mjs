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
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
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

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

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
chunks.push("-- 说明：只含数据，不含建表语句；导入时会先能清空同名表再插入。\n");

let totalRows = 0;
const perTable = [];

for (const t of tables) {
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM ${quoteIdent(t)}`).all();
  } catch {
    continue;
  }
  if (rows.length === 0) continue;

  const cols = Object.keys(rows[0]);
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

db.close();

mkdirSync(join(here, "demo-data"), { recursive: true });
const sql = chunks.join("\n");
writeFileSync(outFile, sql, "utf8");

console.log(`已导出：${outFile}`);
console.log(`  ${perTable.length} 张表 / ${totalRows} 行`);
console.log(`  文件大小：${(Buffer.byteLength(sql) / 1024).toFixed(0)} KB`);
console.log(`\n前 12 张：`);
perTable
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .forEach(([t, n]) => console.log(`  ${t}: ${n}`));
