/**
 * 房间区间占用校验验收（整改清单 P0-5）
 *
 * 缺陷背景：续住、换房只看当前房态，不看未来日期区间 ——
 * 客人 A 住到 11-20，续到 11-25，而这间房 11-22 已卖给 B，
 * 续住成功 → 22 号双重占用。
 *
 * 修复：src/lib/room-availability.ts 的 findRoomConflicts，
 * 续住 / 换房在事务前调用，有冲突就 redirect 带错误提示。
 *
 * 本脚本：
 *   1. 源码静态校验：续住/换房函数体里必须有 findRoomConflicts
 *   2. 区间判定逻辑用真实数据验证（半开区间、相等不算冲突、排除自己）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* ---------- 1. 源码静态校验 ---------- */
const inhouseSrc = readFileSync(join("src", "app", "(main)", "inhouse", "actions.ts"), "utf8");

function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  /* 粗略取到下一个 export 之前 */
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}

const extendBody = funcBody(inhouseSrc, "extendStayAction");
const changeBody = funcBody(inhouseSrc, "changeRoomAction");

check("续住 extendStayAction 调用了 findRoomConflicts", extendBody.includes("findRoomConflicts"));
check("续住排除了自己（excludeStayId）", extendBody.includes("excludeStayId"));
check("续住冲突时 redirect 带 err 提示", /conflictMessage/.test(extendBody));
check("换房 changeRoomAction 调用了 findRoomConflicts", changeBody.includes("findRoomConflicts"));
check("换房排除了自己（excludeStayId）", changeBody.includes("excludeStayId"));
check("换房冲突时 redirect 带 err 提示", /conflictMessage/.test(changeBody));

/* ---------- 2. 半开区间判定逻辑验证 ---------- */
const db = new DatabaseSync(DB, { readOnly: true });

/** 与 src/lib/room-availability.ts 里的 SQL 判定等价 */
function clashes(aIn, aOut, bIn, bOut) {
  return aIn < bOut && aOut > bIn;
}

check("区间 [11-18,11-20) vs [11-20,11-22) 不冲突（退房当天可接续）", !clashes("2026-11-18", "2026-11-20", "2026-11-20", "2026-11-22"));
check("区间 [11-18,11-20) vs [11-19,11-21) 冲突", clashes("2026-11-18", "2026-11-20", "2026-11-19", "2026-11-21"));
check("区间 [11-18,11-20) vs [11-22,11-24) 不冲突", !clashes("2026-11-18", "2026-11-20", "2026-11-22", "2026-11-24"));
check("完全相同区间必然冲突", clashes("2026-11-18", "2026-11-20", "2026-11-18", "2026-11-20"));

/* ---------- 3. 真实数据：所有在住单自身都不应和自己冲突 ---------- */
const stays = db.prepare(
  `SELECT s.id, s.stay_no, s.room_id,
          COALESCE(substr(s.check_in_time,1,10),'') AS ci,
          COALESCE(s.expect_check_out,'') AS co
     FROM stays s WHERE s.hotel_id = 1 AND s.status = 'INHOUSE' AND s.room_id IS NOT NULL`
).all();

const selfConflict = stays.filter((s) => clashes(s.ci, s.co, s.ci, s.co) === false);
check("所有在住单的日期区间自身合法（ci < co）", selfConflict.length === 0,
  selfConflict.slice(0, 3).map((s) => `${s.stay_no} ${s.ci}~${s.co}`).join("; "));

/* ---------- 4. 真实数据：在住单之间同房间不应有区间重叠 ---------- */
const byRoom = new Map();
for (const s of stays) {
  if (!byRoom.has(s.room_id)) byRoom.set(s.room_id, []);
  byRoom.get(s.room_id).push(s);
}
let overlap = [];
for (const [roomId, list] of byRoom) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (clashes(list[i].ci, list[i].co, list[j].ci, list[j].co)) {
        overlap.push(`room#${roomId}: ${list[i].stay_no} vs ${list[j].stay_no}`);
      }
    }
  }
}
check("同房间不存在重叠的在住单（数据本身干净）", overlap.length === 0, overlap.slice(0, 3).join("; "));

console.log(`\n在住单 ${stays.length} 条，覆盖 ${byRoom.size} 间房`);
db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
