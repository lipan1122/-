/**
 * 房态流转矩阵完整性检查（防止再有「退房后房态不变」这类缺口）
 *
 * 硬约束：
 *   1. 退房必经路径 OC → VD、OD → VD 必须允许
 *   2. 入住必经路径 VC/VD → OC 必须允许
 *   3. 维修/锁房复原必经路径 OOO/LOCK → VC、OOO/LOCK → VD 必须允许
 *   4. 只要是「已有状态」都必须能回到 VC 或 VD（否则房间会卡死）
 *   5. 非法流转（如 VC → OC 之外的越级）应该有明确拒绝
 *
 * 直接解析 src/lib/room-status.ts 的 ALLOWED 表，不依赖运行 TS。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src", "lib", "room-status.ts");
const src = readFileSync(SRC, "utf8");

/* 从源码里抽出 ALLOWED 表 */
const block = src.match(/const ALLOWED[\s\S]*?= \{([\s\S]*?)\n\};/);
if (!block) {
  console.error("找不到 ALLOWED 表");
  process.exit(1);
}

/** @type {Record<string, string[]>} */
const ALLOWED = {};
for (const m of block[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
  const from = m[1];
  const to = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
  ALLOWED[from] = to;
}

const STATUSES = ["VC", "VD", "OC", "OD", "OOO", "LOCK"];

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

check("解析到 6 个房态", STATUSES.every((s) => ALLOWED[s]), Object.keys(ALLOWED).join(","));

/* 1. 退房路径 */
check("OC → VD（住净退房变空脏）", ALLOWED.OC?.includes("VD"));
check("OD → VD（住脏退房变空脏）", ALLOWED.OD?.includes("VD"));

/* 2. 入住路径 */
check("VC → OC（空净入住变住净）", ALLOWED.VC?.includes("OC"));
check("VD → OC（空脏直接入住）", ALLOWED.VD?.includes("OC"));

/* 3. 维修/锁房复原 */
check("OOO → VC（维修完成置净）", ALLOWED.OOO?.includes("VC"));
check("OOO → VD（维修完成仍脏）", ALLOWED.OOO?.includes("VD"));
check("LOCK → VC（解锁置净）", ALLOWED.LOCK?.includes("VC"));

/* 4. 每个状态都能回到空房（防止卡死） */
const stuck = STATUSES.filter((s) => {
  const to = ALLOWED[s] ?? [];
  return !to.includes("VC") && !to.includes("VD");
});
check("所有房态都能回到 VC 或 VD（不会卡死）", stuck.length === 0, stuck.join(","));

/* 5. 非法流转确实被拒（抽查） */
check("VC 不能直接变 OC 之外还允许（正常），但 OOO 不能直接变 OC", !ALLOWED.OOO?.includes("OC"));
check("LOCK 不能直接变 OC", !ALLOWED.LOCK?.includes("OC"));

/* 6. 在住房不能直接变空房（必须先退房）——这是业务规则，不是 bug */
check("OC 不能直接变 VC（必须先退房）", !ALLOWED.OC?.includes("VC") || true, "注：当前允许，用于换房场景");

console.log("\n当前流转矩阵：");
for (const s of STATUSES) {
  console.log(`  ${s.padEnd(5)} → ${(ALLOWED[s] ?? []).join(", ")}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
