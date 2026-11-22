/**
 * 多租户隔离扫描（整改报告 P1-9）
 *
 * 抓出源码里所有访问业务表的 SQL，检查是否带 hotel_id 条件。
 * 只做静态扫描，可能有误报（比如子查询里另有 hotel_id），需要人工复核。
 *
 * 用法：node scripts/scan-tenant-isolation.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TENANT_TABLES = [
  "bookings",
  "stays",
  "folios",
  "folio_items",
  "payments",
  "rooms",
  "room_types",
  "guests",
  "companies",
  "channels",
  "channel_orders",
  "settings",
  "sessions",
  "op_logs",
  "room_logs",
  "housekeeping",
  "night_audits",
  "members",
  "ar_accounts",
  "ar_transactions",
];
const TABLE_RE = new RegExp(`\\b(?:FROM|INTO|UPDATE)\\s+(${TENANT_TABLES.join("|")})\\b`, "gi");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk("src");
const suspicious = [];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  /* 抓出模板字符串 / 字符串里的 SQL 片段：从 FROM|INTO|UPDATE 到反引号或引号结束 */
  const sqlBlocks = src.match(/(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,1200}?(?=`|"|;)/gi) ?? [];
  for (const block of sqlBlocks) {
    const m = block.match(TABLE_RE);
    if (!m) continue;
    const table = m[0].split(/\s+/).pop();
    /* 有 WHERE 但整段没有 hotel_id → 可疑 */
    const hasWhere = /\bWHERE\b/i.test(block);
    const hasHotel = /\bhotel_id\b/i.test(block);
    if (hasWhere && !hasHotel) {
      const line = src.slice(0, src.indexOf(block)).split("\n").length;
      suspicious.push({ file: f.replace(/^src[\\/]/, ""), line, table, snippet: block.replace(/\s+/g, " ").slice(0, 110) });
    }
  }
}

console.log(`扫描 ${files.length} 个源码文件，可疑查询 ${suspicious.length} 处\n`);
const byFile = new Map();
for (const s of suspicious) {
  if (!byFile.has(s.file)) byFile.set(s.file, []);
  byFile.get(s.file).push(s);
}
for (const [file, items] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n=== ${file}（${items.length}）===`);
  for (const it of items.slice(0, 6)) {
    console.log(`  L${it.line} [${it.table}] ${it.snippet}`);
  }
  if (items.length > 6) console.log(`  …还有 ${items.length - 6} 处`);
}
console.log(
  suspicious.length === 0
    ? "\n✅ 所有带 WHERE 的业务表查询都带了 hotel_id"
    : `\n⚠️  ${suspicious.length} 处需要人工复核（子查询里可能已带 hotel_id）`
);
process.exit(suspicious.length === 0 ? 0 : 1);
