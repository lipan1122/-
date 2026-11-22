/**
 * SQL 占位符 ↔ 参数个数 一致性检查
 *
 * 这是最容易在重构中引入、又最难在页面测试里发现的 bug：
 *   run(`UPDATE t SET a=?, b=? WHERE id=?`, [a, b])   ← 少传一个参数
 *   run(`UPDATE t SET a=? WHERE id=?`, [a, b, c])     ← 多传
 *
 * 少传 → SQLite 报 "not enough bind parameters"（运行时炸）
 * 多传 → SQLite 静默忽略多余参数（更危险，看着正常但值不对）
 *
 * 做法：找 `run(` / `all(` / `get(` 调用，取出第一个参数里的模板字符串，
 *      数 `?` 的个数，再数第二个参数数组里的元素个数。
 *      只处理"参数是纯字面量数组"的情况，复杂表达式跳过不误报。
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

const files = walk("src");
const problems = [];
let checked = 0;
let skipped = 0;

/** 从指定位置开始，找到配对的右括号（跳过字符串里的括号） */
function matchParen(s, start) {
  let depth = 0;
  let inStr = null;
  let inTpl = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (inTpl) {
      if (c === "`" && prev !== "\\") inTpl = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "`") {
      inTpl = true;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 数 SQL 里的 ? 占位符（排除字符串字面量和注释里的 ?） */
function countPlaceholders(sql) {
  let n = 0;
  let inStr = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const prev = sql[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === "'" || c === '"') {
      inStr = c;
      continue;
    }
    if (c === "?") n++;
  }
  return n;
}

/** 数参数数组里的元素个数（已在调用方过滤掉含 ${} 模板的数组） */
function countArrayItems(arrSrc) {
  let n = 0;
  let depth = 0;
  let inStr = null;
  let hasContent = false;
  for (let i = 0; i < arrSrc.length; i++) {
    const c = arrSrc[i];
    const prev = arrSrc[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      hasContent = true;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      hasContent = true;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) n++;
    else if (!/\s/.test(c)) hasContent = true;
  }
  /*
   * 尾逗号修正：Prettier 会在最后一项后加逗号，形如
   *   [a, b, c,]
   * 此时 n = 3（数了 3 个逗号），但实际只有 3 项，不该 +1。
   * 判据：最后一个非空白字符是逗号。
   */
  const trimmed = arrSrc.replace(/\s+$/, "");
  const trailingComma = trimmed.endsWith(",");
  if (!hasContent) return 0;
  return trailingComma ? n : n + 1;
}

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const re = /\b(run|all|get)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const call = src.slice(open + 1, close);

    /* 第一参数：模板字符串或普通字符串 */
    const tpl = call.match(/^\s*`([\s\S]*?)`\s*,/);
    const str = call.match(/^\s*"([\s\S]*?)"\s*,/);
    const literal = tpl || str;
    if (!literal) {
      skipped++;
      continue;
    }
    /* 模板里有 ${...} 说明 SQL 是动态拼的，占位符数不可静态判定 */
    if (literal[1].includes("${")) {
      skipped++;
      continue;
    }
    const ph = countPlaceholders(literal[1]);

    /* 第二参数：数组字面量（[ ... ]）或省略 */
    const rest = call.slice(literal[0].length);
    const arr = rest.match(/^\s*\[([\s\S]*)\]\s*$/);
    if (!arr) {
      /* 没有第二参数 = 传空数组；占位符必须为 0 */
      if (ph > 0) {
        const line = src.slice(0, m.index).split("\n").length;
        problems.push(`${f.replace(/\\/g, "/")}:${line}  ${m[1]}()  SQL 有 ${ph} 个 ? 但没传参数数组`);
      }
      continue;
    }
    const body = arr[1].trim();
    /* 数组里含展开/函数调用 → 无法静态数，跳过 */
    /*
     * 数组里含展开 / 函数调用 / filter / 带 ${} 的模板字符串 → 无法静态数元素，跳过。
     * 带 ${} 的模板字符串里可能含逗号和问号，会污染计数（曾经因此全项目误报 +1）。
     */
    if (
      /\.\.\.|=>|\bfunction\b|\bfilter\b/.test(body) ||
      /`[^`]*\$\{/.test(body)
    ) {
      skipped++;
      continue;
    }
    const args = countArrayItems(body);
    checked++;

    if (ph !== args) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(
        `${f.replace(/\\/g, "/")}:${line}  ${m[1]}()  SQL 有 ${ph} 个 ?，参数数组有 ${args} 个` +
          (args < ph ? "  ← 少传（运行时会炸）" : "  ← 多传（静默忽略，值可能不对）")
      );
    }
  }
}

console.log("=== SQL 占位符 ↔ 参数个数 检查 ===\n");
console.log(`静态可比对 ${checked} 处，跳过（动态 SQL/展开数组）${skipped} 处\n`);

/* 已知豁免：这些地方参数数量确实不等于 ? 个数，且在代码里有注释说明 */
const KNOWN_OK = [
  /* session.ts 的 sessions 表按 token 删，无 hotel_id */
  "lib/session.ts",
];

const real = problems.filter((p) => !KNOWN_OK.some((k) => p.includes(k)));

if (real.length === 0) {
  console.log("✅ 未发现参数个数不匹配");
} else {
  console.log(`⚠️ ${real.length} 处不匹配：\n`);
  real.forEach((p) => console.log("  " + p));
}
