/**
 * 表单字段 ↔ action 字段 一致性检查
 *
 * 最常见的 bug：改了表单的 input name，但 action 里还读旧名字
 * → 用户填了内容，提交后字段是 undefined，表现为「点了没反应 / 数据没保存」。
 *
 * 做法：
 *   1. 扫每个模块的 page.tsx / 组件，收集 name="xxx" 和 name={`xxx`}
 *   2. 扫对应 actions.ts，收集 formData.get("xxx") / readStr(formData, "xxx")
 *   3. 对比：action 读取的字段，表单里必须存在（或由代码动态生成）
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";

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

const allFiles = walk(SRC);

/** 收集一个文件里所有 name="xxx" 的字段（含模板字符串里的字面量部分） */
function collectNames(content) {
  const names = new Set();
  /* name="xxx" */
  for (const m of content.matchAll(/\bname\s*=\s*"([A-Za-z_][\w]*)"/g)) names.add(m[1]);
  /* name={"xxx"} */
  for (const m of content.matchAll(/\bname\s*=\s*\{\s*"([A-Za-z_][\w]*)"\s*\}/g)) names.add(m[1]);
  /* name={`guest_name_${i}`} → guest_name_ */
  for (const m of content.matchAll(/\bname\s*=\s*\{\s*`([A-Za-z_][\w]*)_\$\{/g)) names.add(m[1] + "_*");
  /* hidden input value 里的 name */
  for (const m of content.matchAll(/<input[^>]*name="([A-Za-z_][\w]*)"/g)) names.add(m[1]);
  return names;
}

/** 收集 action 读取的字段 */
function collectReads(content) {
  const reads = new Set();
  /* formData.get("xxx") */
  for (const m of content.matchAll(/formData\.get\(\s*"([A-Za-z_][\w]*)"\s*\)/g)) reads.add(m[1]);
  /* formData.getAll("xxx") */
  for (const m of content.matchAll(/formData\.getAll\(\s*"([A-Za-z_][\w]*)"\s*\)/g)) reads.add(m[1]);
  /* readStr(formData, "xxx") / readNum(formData, "xxx", n) / intOf(formData, "xxx") */
  for (const m of content.matchAll(/read(?:Str|Num|Int|Bool)?\(\s*formData\s*,\s*"([A-Za-z_][\w]*)"/g))
    reads.add(m[1]);
  for (const m of content.matchAll(/numOf\(\s*formData\s*,\s*"([A-Za-z_][\w]*)"/g)) reads.add(m[1]);
  for (const m of content.matchAll(/intOrNull\(\s*formData\.get\(\s*"([A-Za-z_][\w]*)"/g)) reads.add(m[1]);
  /* 模板前缀：`guest_name_${i}` */
  for (const m of content.matchAll(/formData\.get\(\s*`([A-Za-z_][\w]*)_\$\{/g)) reads.add(m[1] + "_*");
  for (const m of content.matchAll(/readStr\(\s*formData\s*,\s*`([A-Za-z_][\w]*)_\$\{/g)) reads.add(m[1] + "_*");
  return reads;
}

/* 动态/程序生成的字段：不参与静态比对 */
const IGNORE = new Set([
  "mode", "hours", "guest_count", "nights", "__next", "$ACTION_ID",
  "lines", "type", "page", "filter", "q", "status", "channel", "range",
  "date", "sel", "sort", "err", "msg", "tab", "id", "ids", "item_id",
  "stay_id", "room_id", "folio_id", "booking_id", "guest_id", "roomId",
  "channel_id", "company_id", "member_id", "invoice_id", "ar_id",
]);

/* 找所有 actions.ts，和同目录的 page.tsx / 上层组件做比对 */
const actionFiles = allFiles.filter((f) => f.endsWith("actions.ts"));
const problems = [];
let checked = 0;
let totalReads = 0;

for (const af of actionFiles) {
  const dir = dirname(af);
  const reads = collectReads(readFileSync(af, "utf8"));
  if (reads.size === 0) continue;

  /* 该模块相关的所有 tsx：同目录 + 其子目录 + 全项目（组件可能放在 components/） */
  const rel = af.replace(/\\/g, "/").replace(/^src\/app\//, "").replace(/\/(actions)\.ts$/, "");
  const moduleKey = rel.split("/").pop();

  const uiFiles = allFiles.filter((f) => {
    if (!f.endsWith(".tsx")) return false;
    const fr = f.replace(/\\/g, "/");
    return (
      fr.includes(`/${moduleKey}/`) ||
      fr.includes(`components/${moduleKey}`) ||
      /* 通用组件：按 action 名匹配 */
      false
    );
  });

  const provided = new Set();
  for (const uf of uiFiles) for (const n of collectNames(readFileSync(uf, "utf8"))) provided.add(n);

  /* 也扫全项目：有些字段在弹窗组件里 */
  if (provided.size === 0) {
    for (const uf of allFiles.filter((f) => f.endsWith(".tsx")))
      for (const n of collectNames(readFileSync(uf, "utf8"))) provided.add(n);
  }

  checked++;
  for (const r of reads) {
    totalReads++;
    if (IGNORE.has(r)) continue;
    const base = r.endsWith("_*") ? r.slice(0, -2) : r;
    const hit = provided.has(r) || provided.has(base);
    if (!hit) problems.push(`${af.replace(/\\/g, "/")}  ← 读取 "${r}"，但表单里没有这个字段`);
  }
}

function dirname(p) {
  const i = p.lastIndexOf("\\") >= 0 ? p.lastIndexOf("\\") : p.lastIndexOf("/");
  return p.slice(0, i);
}

console.log("=== 表单字段 ↔ action 读取 一致性检查 ===\n");
console.log(`检查了 ${checked} 个 actions.ts，共 ${totalReads} 次字段读取\n`);

if (problems.length === 0) {
  console.log("✅ 未发现字段名不匹配");
} else {
  console.log(`⚠️ 发现 ${problems.length} 处可能不匹配：\n`);
  for (const p of problems) console.log("  " + p);
  console.log(
    "\n注意：有些字段由代码动态拼 (如 name={`${prefix}_${i}`}) 或由 Server Action 内部携带，" +
      "\n      静态扫描会误报，需人工确认。"
  );
}
