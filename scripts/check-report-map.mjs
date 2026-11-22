/**
 * 报表映射完整性检查
 *
 * 页面用的是 `REPORT_VIEWS[rKey] ?? ReportHotelSummary` —— 漏映射不报错，
 * 只是静默显示「酒店经营总表」。曾经漏了 21 张，店长拿着错数做决策。
 *
 * 这个脚本确保 REPORTS 里每一张报表都有对应渲染组件。
 */
import { readFileSync } from "node:fs";

const SRC = "src/app/(main)/reports/page.tsx";
const lines = readFileSync(SRC, "utf8").split("\n");

/* REPORTS 块 */
let repStart = -1;
let repEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^const REPORTS/.test(lines[i])) {
    repStart = i;
    break;
  }
}
for (let i = repStart + 1; i < lines.length; i++) {
  if (/^\};/.test(lines[i])) {
    repEnd = i;
    break;
  }
}
const repKeys = [
  ...lines
    .slice(repStart, repEnd)
    .join("\n")
    .matchAll(/^\s{2}["']?([a-zA-Z0-9_-]+)["']?\s*:\s*\{/gm),
].map((m) => m[1]);

/* REPORT_VIEWS 块 */
let vStart = -1;
let vEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^const REPORT_VIEWS/.test(lines[i])) {
    vStart = i;
    break;
  }
}
for (let i = vStart + 1; i < lines.length; i++) {
  if (/^\};/.test(lines[i])) {
    vEnd = i;
    break;
  }
}
const viewBlock = lines.slice(vStart, vEnd).join("\n");
/*
 * 映射有两种写法：
 *   · 直接给组件引用：     "key": ReportXxx,
 *   · 包一层箭头函数：     "key": (props) => <ReportNotReady ... />,
 * 两种都算「已映射」。之前只认第一种，把改写成占位的 11 张误判成未映射。
 */
const mapped = [
  ...viewBlock.matchAll(/^\s{2}["']?([a-zA-Z0-9_-]+)["']?\s*:\s*(?:Report[A-Za-z0-9]+|\([^)]*\)\s*=>)/gm),
].map((m) => m[1]);

const missing = repKeys.filter((k) => !mapped.includes(k));
const extra = mapped.filter((k) => !repKeys.includes(k));

console.log("=== 报表映射完整性 ===\n");
console.log(`  REPORTS 注册：${repKeys.length} 张`);
console.log(`  REPORT_VIEWS 映射：${mapped.length} 张\n`);

let bad = 0;

if (missing.length > 0) {
  bad++;
  console.log(`❌ ${missing.length} 张报表没有渲染组件（会静默显示酒店经营总表）：`);
  missing.forEach((k) => console.log(`   · ${k}`));
  console.log();
} else {
  console.log("✅ 所有报表都有渲染组件");
}

if (extra.length > 0) {
  console.log(`\nℹ️ ${extra.length} 个映射指向未注册的报表 key（无害但冗余）：`);
  extra.forEach((k) => console.log(`   · ${k}`));
}

/* 检查组件是否真的定义 */
const comps = [...viewBlock.matchAll(/:\s*(Report[A-Za-z0-9]+),/g)].map((m) => m[1]);
const fullSrc = lines.join("\n");
const undef = [...new Set(comps)].filter(
  (c) => !new RegExp(`function\\s+${c}\\b|const\\s+${c}\\b`).test(fullSrc)
);
if (undef.length > 0) {
  bad++;
  console.log(`\n❌ ${undef.length} 个映射指向的组件未定义（会编译失败）：`);
  undef.forEach((c) => console.log(`   · ${c}`));
}

console.log(bad === 0 ? "\n✅ 报表映射完整\n" : "\n❌ 有问题\n");
process.exit(bad === 0 ? 0 : 1);
