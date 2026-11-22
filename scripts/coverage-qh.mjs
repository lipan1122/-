/**
 * 去呼呼 280 项权限 → 本系统实现覆盖度扫描
 *
 * 读 .repro/qh-privilege.txt（tag<TAB>中文名），在 src/ 里搜中文关键词，
 * 命中即视为「有相关实现」，未命中列为候选缺口（需人工确认）。
 *
 * 用法：node scripts/coverage-qh.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const PRIV = process.env.QH_PRIVILEGE_PATH ?? join(ROOT, "..", ".repro", "qh-privilege.txt");

/* 收集全部源码文本 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");

/** 去掉括号与「/」后缀，拆出核心词 */
function keywords(name) {
  const base = name.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim();
  const parts = base.split(/[/、]/).map((s) => s.trim()).filter((s) => s.length >= 2);
  return parts.length ? parts : [base];
}

const lines = readFileSync(PRIV, "utf8").split(/\r?\n/).filter(Boolean);
const rows = [];
for (const line of lines) {
  const [tag, name] = line.split("\t");
  if (!name) continue;
  const kws = keywords(name);
  const hit = kws.find((k) => corpus.includes(k));
  rows.push({ tag, name, hit: hit ?? null });
}

const missing = rows.filter((r) => !r.hit);
const done = rows.filter((r) => r.hit);

console.log(`权限项 ${rows.length} 项：命中 ${done.length}，未命中 ${missing.length}\n`);
console.log("=== 未命中（候选缺口）===");
for (const r of missing) console.log(`  ${r.tag.padEnd(38)} ${r.name}`);
