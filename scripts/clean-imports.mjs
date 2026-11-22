/**
 * 清理未使用的 import（上线前死代码清理）
 *
 * 只删「导入后整个文件里再也没出现过」的标识符，删完立刻跑 tsc 验证。
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGETS = [
  "src/app/(main)/bookings/page.tsx",
  "src/app/(main)/channels/page.tsx",
  "src/app/(main)/guests/page.tsx",
  "src/app/(main)/handover/actions.ts",
  "src/app/(main)/rooms/predict/page.tsx",
  "src/app/(main)/settings/page.tsx",
  "src/app/(main)/shop/page.tsx",
  "src/app/(main)/today-todo/page.tsx",
  "src/app/(mobile)/m/housekeeping/page.tsx",
  "src/app/(mobile)/m/me/page.tsx",
  "src/app/(mobile)/m/page.tsx",
  "src/components/AssignRoomModal.tsx",
];

let changed = 0;

for (const f of TARGETS) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const before = src;

  /* 匹配 import { a, b, c } from "x";  或  import { a } from "x"; */
  src = src.replace(/import\s*\{([^}]+)\}\s*from\s*(["'][^"']+["']);?/g, (whole, names, mod) => {
    const list = names.split(",").map((x) => x.trim()).filter(Boolean);
    const kept = [];
    for (const raw of list) {
      /* 跳过带注释的（无法安全判断） */
      if (raw.includes("/*") || raw.includes("//")) {
        kept.push(raw);
        continue;
      }
      const id = raw.split(/\s+as\s+/).pop().trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(id)) {
        kept.push(raw);
        continue;
      }
      /* 在整个文件里（除本 import 行）搜该标识符 */
      const rest = before.replace(whole, "");
      const re = new RegExp(`\\b${id.replace(/[$]/g, "\\$")}\\b`);
      if (re.test(rest)) kept.push(raw);
      /* 否则丢弃 */
    }
    if (kept.length === 0) return ""; // 整条 import 都不要
    if (kept.length === list.length) return whole; // 没变
    return `import { ${kept.join(", ")} } from ${mod};`;
  });

  /* 清掉多余空行 */
  src = src.replace(/\n{3,}/g, "\n\n");

  if (src !== before) {
    writeFileSync(f, src, "utf8");
    changed++;
    console.log("  ✓ " + f);
  }
}

console.log(`\n清理 ${changed} 个文件`);
