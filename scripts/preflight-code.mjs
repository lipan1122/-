/**
 * 上线前代码健壮性检查
 *
 * 查那些「数据体检查不出、页面测试也难发现」的问题：
 *   空态处理 / 错误提示 / 二次确认 / 危险操作保护 / TODO 残留
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
const pages = files.filter((f) => f.endsWith("page.tsx"));
const actions = files.filter((f) => f.endsWith("actions.ts"));

const findings = [];
const add = (level, cat, msg) => findings.push({ level, cat, msg });

console.log("========== 一、空态处理 ==========\n");

/* 列表页应该有「没有数据」的提示 */
const listPages = pages.filter((f) => {
  const s = readFileSync(f, "utf8");
  return /\.map\(/.test(s) && /<table|<tbody/.test(s);
});
const noEmpty = [];
for (const f of listPages) {
  const s = readFileSync(f, "utf8");
  const hasEmpty =
    /暂无|没有|空|length === 0|\.length\s*\?\s*0|empty|EmptyState/i.test(s);
  if (!hasEmpty) noEmpty.push(f.replace(/\\\\/g, "/"));
}
console.log(`  列表页 ${listPages.length} 个，缺空态提示 ${noEmpty.length} 个`);
if (noEmpty.length > 0) {
  noEmpty.slice(0, 8).forEach((f) => console.log(`    · ${f}`));
  if (noEmpty.length > 8) console.log(`    ... 还有 ${noEmpty.length - 8} 个`);
  add("WARN", "空态", `${noEmpty.length} 个列表页没有空态提示`);
} else {
  console.log("  ✅ 全部有");
}

console.log("\n========== 二、错误提示（不能静默 return） ==========\n");

/* Server Action 里 `if (!x) return;` 是静默失败 —— 用户点了没反应 */
let silentReturns = 0;
const silentList = [];
for (const f of actions) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    /* 只关心「校验后直接 return」的形态 */
    if (/^\s*if\s*\([^)]*\)\s*return\s*;?\s*$/.test(line)) {
      /* 前面不是注释说明或这是幂等早退 */
      silentReturns++;
      silentList.push(`${f.replace(/\\\\/g, "/")}:${i + 1}`);
    }
  });
}
console.log(`  静默 return 共 ${silentReturns} 处`);
if (silentReturns > 0) {
  silentList.slice(0, 10).forEach((x) => console.log(`    · ${x}`));
  if (silentList.length > 10) console.log(`    ... 还有 ${silentList.length - 10} 处`);
  console.log("  （部分是有意的幂等早退，需人工判断）");
  add("INFO", "错误提示", `${silentReturns} 处静默 return，需人工判断哪些该给提示`);
}

console.log("\n========== 三、危险操作二次确认 ==========\n");

const DANGEROUS = [
  ["删除", /delete|remove/i],
  ["退款", /refund/i],
  ["冲账/撤销", /reverse|void|cancel.*checkout/i],
  ["取消入住", /cancelCheckin|cancel.*stay/i],
  ["夜审", /nightAudit|runNight/i],
  ["清空/重置", /reset|clear|truncate/i],
];

let noConfirm = 0;
for (const [label, re] of DANGEROUS) {
  /* 找 UI 里调用这些 action 的地方，看有没有 ConfirmForm / confirm( */
  const hits = [];
  for (const f of files.filter((x) => x.endsWith(".tsx"))) {
    const s = readFileSync(f, "utf8");
    if (!re.test(s)) continue;
    const hasConfirm = /ConfirmForm|confirm\(|window\.confirm|二次确认|确认删除|确定要/.test(s);
    if (!hasConfirm) hits.push(f.replace(/\\\\/g, "/"));
  }
  if (hits.length > 0) {
    noConfirm += hits.length;
    console.log(`  ⚠️ ${label}：${hits.length} 个文件无二次确认`);
    hits.slice(0, 4).forEach((x) => console.log(`      · ${x}`));
  } else {
    console.log(`  ✅ ${label}：有二次确认`);
  }
}
if (noConfirm > 0) add("WARN", "二次确认", `${noConfirm} 处危险操作缺确认`);

console.log("\n========== 四、TODO / FIXME 残留 ==========\n");

const todos = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (/\b(TODO|FIXME|XXX|HACK|待实现|未实现|暂时|临时方案)\b/.test(line)) {
      todos.push(`${f.replace(/\\\\/g, "/")}:${i + 1}  ${line.trim().slice(0, 70)}`);
    }
  });
}
console.log(`  TODO/FIXME 共 ${todos.length} 处`);
todos.slice(0, 8).forEach((t) => console.log(`    · ${t}`));
if (todos.length > 8) console.log(`    ... 还有 ${todos.length - 8} 处`);
if (todos.length > 0) add("INFO", "TODO", `${todos.length} 处标记`);

console.log("\n========== 五、硬编码与魔法值 ==========\n");

/* 硬编码的业务值（应该进配置的） */
const HARDCODE_PATTERNS = [
  ["硬编码酒店 ID", /\bhotelId\s*[:=]\s*1\b(?!\s*[,)])/g],
  ["硬编码区号/电话", /\b1[3-9]\d{9}\b/g],
  ["硬编码金额", /\b(?:rate|price|amount)\s*[:=]\s*\d{3,}\b/g],
];
let hard = 0;
for (const [label, re] of HARDCODE_PATTERNS) {
  const hits = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    const m = s.match(re);
    if (m) hits.push(`${f.replace(/\\\\/g, "/")} (${m.length})`);
  }
  if (hits.length > 0) {
    hard += hits.length;
    console.log(`  ⚠️ ${label}：${hits.length} 个文件`);
    hits.slice(0, 3).forEach((x) => console.log(`      · ${x}`));
  }
}
if (hard === 0) console.log("  ✅ 未发现明显硬编码");

console.log("\n========== 六、未使用的导入（潜在死代码） ==========\n");

let unusedWarn = 0;
for (const f of files) {
  const s = readFileSync(f, "utf8");
  const imports = [...s.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from/g)];
  for (const m of imports) {
    const names = (m[1] ?? m[2] ?? "")
      .split(",")
      .map((x) => x.trim().split(/\s+as\s+/).pop())
      .filter((x) => x && !x.startsWith("type "));
    for (const n of names) {
      if (!n || n.length < 2) continue;
      /* 出现在 import 行之后的次数 */
      const after = s.slice(m.index + m[0].length);
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`);
      if (!re.test(after)) {
        unusedWarn++;
        console.log(`  ⚠️ ${f.replace(/\\\\/g, "/")}  未使用: ${n}`);
      }
    }
  }
}
if (unusedWarn === 0) console.log("  ✅ 无未使用导入");

console.log("\n========== 汇总 ==========\n");
const byLevel = (lv) => findings.filter((x) => x.level === lv).length;
console.log(`  警告 ${byLevel("WARN")} 项 / 提示 ${byLevel("INFO")} 项`);
console.log("");

/* 输出机读清单 */
if (findings.length > 0) {
  console.log("  待处理清单：");
  findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.level}] ${f.cat}：${f.msg}`));
}
