/**
 * 房态校准：把 rooms.status 和 stays 的在住情况对齐
 *
 * 背景：测试数据里出现「rooms.status = VC（空净）但 stays 有在住客人」的不一致，
 * 导致房态页显示在住、排房弹窗却把房间当空房列出来。
 *
 * 规则：
 *   1) 有 INHOUSE 入住单的房间 → OC（住净）/ OD（住脏，原状态是 VD 或 OD 的）
 *   2) 没有在住单但状态是 OC/OD 的房间 → VC / VD
 *   3) 房态是 OOO / LOCK 的房间**不动**（维修/锁定不是 occupancy，强行改成 OC/OD
 *      会掩盖维修状态；这里只报告、不覆盖）
 *
 * ── 严格 0 变更（P2 整改）──
 * 旧版的问题是：第一条 UPDATE 的 WHERE 只写了「有在住单」，
 * 所以**每次**都会重写全部在住房间（实测 25 间全被「写一遍」但值没变）。
 * 在营业高峰跑会白拿写锁，而且输出「共 25 行」会让人误以为改坏了 25 间房。
 *
 * 现在改成「先算差异，只写差异」：
 *   1) 用与 dry-run 完全相同的口径算出 changes（每行带 from/to）；
 *   2) 提交时逐行 `UPDATE ... WHERE id = ? AND status = ?`（CAS）：
 *      status 已经被别人改过的行（changes = 0）不覆盖，计入「并发跳过」；
 *   3) changes 为空时**不开事务、不写库**，直接报「0 处变更」。
 * 于是：第一次可能有变更，第二次（以及之后每一次）必然是 0 处变更。
 *
 * 用法：
 *   node scripts/fix-room-status.mjs           # dry-run，只打印（等价 --check / --dry-run）
 *   node scripts/fix-room-status.mjs --check   # 同上，显式写法
 *   node scripts/fix-room-status.mjs --apply   # 真正写入（只写有差异的行）
 * 退出码：--apply 后仍有不一致时 1，否则 0。
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const HOTEL_ID = Number(process.env.PMS_HOTEL_ID ?? 1);
const db = new DatabaseSync(DB_PATH);

/** OOO（维修）/ LOCK（锁定）不是 occupancy：不参与「有在住单 → OC/OD」的自动改写 */
const FROZEN = new Set(["OOO", "LOCK"]);

const inhouse = db.prepare(
  `SELECT r.id, r.room_no, r.status AS room_status, s.guest_name, s.expect_check_out
     FROM rooms r
     JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
    WHERE r.hotel_id = ?
    ORDER BY r.room_no`
).all(HOTEL_ID);

const stale = db.prepare(
  `SELECT r.id, r.room_no, r.status AS room_status
     FROM rooms r
    WHERE r.hotel_id = ? AND r.status IN ('OC','OD')
      AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'INHOUSE')
    ORDER BY r.room_no`
).all(HOTEL_ID);

/* ============================================================ 1. 先算「哪些行真的会变」 */

/** 同一间房可能有多条 INHOUSE 单（原则上一间一单），按房间 id 去重，避免重复 UPDATE */
const inhouseByRoom = new Map();
for (const r of inhouse) if (!inhouseByRoom.has(r.id)) inhouseByRoom.set(r.id, r);

const changes = []; // { id, room_no, from, to, kind }
const frozen = []; // 被跳过的 OOO/LOCK 在住房

for (const r of inhouseByRoom.values()) {
  if (FROZEN.has(r.room_status)) {
    frozen.push(r);
    continue;
  }
  // 与 dry-run 报告同一口径：VD / OD 都归 OD，其余归 OC
  const to = r.room_status === "VD" || r.room_status === "OD" ? "OD" : "OC";
  if (r.room_status === to) continue; // ← 严格 0 变更的关键：值已经对了就不写
  changes.push({ id: r.id, room_no: r.room_no, from: r.room_status, to, kind: "occupied" });
}

for (const r of stale) {
  const to = r.room_status === "OD" ? "VD" : "VC";
  if (r.room_status === to) continue; // 兜底（OC/OD 与 VC/VD 不相交，正常走不到）
  changes.push({ id: r.id, room_no: r.room_no, from: r.room_status, to, kind: "vacant" });
}

const willChange = new Map(changes.map((c) => [c.id, c]));
const occupiedPlan = changes.filter((c) => c.kind === "occupied").length;
const vacantPlan = changes.filter((c) => c.kind === "vacant").length;

/* ============================================================ 2. 打印（dry-run 与 --apply 共用） */

console.log(`=== 有在住单的房间 ${inhouseByRoom.size} 间 ===`);
for (const r of inhouseByRoom.values()) {
  const want = FROZEN.has(r.room_status) ? r.room_status : r.room_status === "VD" || r.room_status === "OD" ? "OD" : "OC";
  const c = willChange.get(r.id);
  const note = FROZEN.has(r.room_status)
    ? "  【跳过：OOO/LOCK 不自动改】"
    : c
      ? "  【需修】"
      : "  （已一致）";
  console.log(`  ${r.room_no} 当前=${r.room_status} → 应为=${want}${note}  ${r.guest_name ?? ""}`);
}

console.log(`\n=== 无在住单但状态是住净/住脏的房间 ${stale.length} 间 ===`);
for (const r of stale) {
  const c = willChange.get(r.id);
  console.log(`  ${r.room_no} 当前=${r.room_status} → 应为=${c ? c.to : r.room_status}${c ? "  【需修】" : ""}`);
}

console.log(
  `\n待修复：${changes.length} 间（置为在住 ${occupiedPlan} 间，恢复空房 ${vacantPlan} 间；已一致的房间不写库）`
);
if (frozen.length > 0) {
  console.log(
    `跳过：${frozen.length} 间（${frozen.map((r) => `${r.room_no}:${r.room_status}`).join(", ")}）—— OOO/LOCK 不强行设 occupancy`
  );
}

/* ============================================================ 3. dry-run 到此为止 */

if (!APPLY) {
  console.log("\n这是 dry-run，没有写入。加 --apply 才会真正更新。");
  process.exit(0);
}

/* ============================================================ 4. --apply：只写有差异的行 */

let doneOccupied = 0;
let doneVacant = 0;
let raced = 0;

if (changes.length === 0) {
  // 不开事务、不拿写锁：营业高峰跑也完全无感
  console.log("\n✅ 0 处变更：库已经是目标状态，未开启事务、未写库。");
} else {
  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = db.prepare(`UPDATE rooms SET status = ? WHERE id = ? AND hotel_id = ? AND status = ?`);
    for (const c of changes) {
      // CAS：写之前再确认一次现状，别人刚改过的行不覆盖
      const res = stmt.run(c.to, c.id, HOTEL_ID, c.from);
      if (Number(res.changes) === 1) {
        if (c.kind === "occupied") doneOccupied += 1;
        else doneVacant += 1;
      } else {
        raced += 1;
      }
    }
    db.exec("COMMIT");
    console.log(
      `\n已修正：置为在住 ${doneOccupied} 间，恢复空房 ${doneVacant} 间，共 ${doneOccupied + doneVacant} 行`
    );
    if (raced > 0) {
      console.log(`⚠️  ${raced} 行在读后写前被别处改过，已跳过（不覆盖并发修改，下次再算）`);
    }
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("失败已回滚:", e.message);
    process.exit(1);
  }
}

/* ============================================================ 5. 校验 */

const left = db
  .prepare(
    `SELECT COUNT(*) AS c FROM rooms r
      WHERE r.hotel_id = ?
        AND ((r.status IN ('OC','OD') AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status='INHOUSE'))
          OR (r.status IN ('VC','VD') AND EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status='INHOUSE')))`
  )
  .get(HOTEL_ID).c;
console.log(`\n校验：剩余不一致 ${left} 间`);
console.log("再跑一次 `node scripts/fix-room-status.mjs --apply` 应报「待修复：0 间 / 0 处变更」。");
db.close();
process.exit(left === 0 ? 0 : 1);
