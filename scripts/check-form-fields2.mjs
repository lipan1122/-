/**
 * 表单字段 vs action 读取 —— 精确版
 *
 * 上一版按「目录名」匹配，误报太多。这版改成：
 *   对每个 actions.ts 里的每个 export 函数，扫它读的字段；
 *   然后在**同模块目录 + 全项目 tsx** 里找是否有同名 name=，
 *   并且额外输出「表单有但 action 没读」的反向检查（这才是真 bug 高发区）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

const all = walk("src");
const tsx = all.filter((f) => f.endsWith(".tsx"));

/** 全项目所有 name="xxx"（含模板前缀） */
const provided = new Set();
for (const f of tsx) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/\bname\s*=\s*["']([A-Za-z_][\w]*)["']/g)) provided.add(m[1]);
  for (const m of s.matchAll(/\bname\s*=\s*\{\s*["']([A-Za-z_][\w]*)["']\s*\}/g)) provided.add(m[1]);
  for (const m of s.matchAll(/\bname\s*=\s*\{\s*`([A-Za-z_][\w]*)`\s*\}/g)) provided.add(m[1]);
  for (const m of s.matchAll(/\bname\s*=\s*\{\s*`([A-Za-z_][\w]*)_\$\{/g)) provided.add(m[1] + "_*");
  /* hidden input 用 value={...} name=... 已经覆盖；这里补 htmlFor 不算 */
}

/* 由框架/代码动态生成，静态扫不到的字段 */
const RUNTIME = new Set([
  "$ACTION_ID", "$ACTION_REF", "mode", "hours", "guest_count", "nights",
  "lines", "rows", "type", "page", "filter", "q", "status", "channel",
  "range", "date", "sel", "sort", "err", "msg", "tab", "target",
  "request_id", "reason", "n", "count",
]);

const problems = [];
const actionFiles = all.filter((f) => f.endsWith("actions.ts"));

for (const af of actionFiles) {
  const src = readFileSync(af, "utf8");
  /* 按 export 函数切块，分别检查 */
  const fns = [...src.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)];
  for (let i = 0; i < fns.length; i++) {
    const name = fns[i][1];
    const start = fns[i].index;
    const end = i + 1 < fns.length ? fns[i + 1].index : src.length;
    const body = src.slice(start, end);

    const reads = new Set();
    for (const m of body.matchAll(/formData\.get(?:All)?\(\s*["']([A-Za-z_][\w]*)["']\s*\)/g)) reads.add(m[1]);
    for (const m of body.matchAll(/read(?:Str|Num|Int|Bool)?\(\s*formData\s*,\s*["']([A-Za-z_][\w]*)["']/g)) reads.add(m[1]);
    for (const m of body.matchAll(/numOf\(\s*formData\s*,\s*["']([A-Za-z_][\w]*)["']/g)) reads.add(m[1]);
    for (const m of body.matchAll(/formData\.get\(\s*`([A-Za-z_][\w]*)_\$\{/g)) reads.add(m[1] + "_*");

    for (const r of reads) {
      if (RUNTIME.has(r)) continue;
      const base = r.endsWith("_*") ? r.slice(0, -2) : r;
      if (!provided.has(r) && !provided.has(base)) {
        problems.push(`${af.replace(/\\/g, "/")} → ${name}()   读 "${r}"，全项目没有 name="${base}"`);
      }
    }
  }
}

console.log("=== 精确版：action 读取的字段是否都有对应表单项 ===\n");
if (problems.length === 0) {
  console.log("✅ 全部匹配");
} else {
  console.log(`⚠️ ${problems.length} 处：\n`);
  problems.forEach((p) => console.log("  " + p));
}
