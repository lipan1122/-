/**
 * 房态校准：把 rooms.status 和 stays 的在住情况对齐
 *
 * 背景：测试数据里出现「rooms.status = VC（空净）但 stays 有在住客人」的不一致，
 * 导致房态页显示在住、排房弹窗却把房间当空房列出来。
 *
 * 规则：
 *   1) 有 INHOUSE 入住单的房间 → OC（住净）/ OD（住脏，原状态是 VD 的）
 *   2) 没有在住单但状态是 OC/OD 的房间 → VC / VD
 *
 * 用法：node scripts/fix-room-status.mjs [--apply]
 *   不带 --apply 只打印将要变更的内容（dry-run）
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const HOTEL_ID = Number(process.env.PMS_HOTEL_ID ?? 1);
const db = new DatabaseSync(DB_PATH);

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

console.log(`=== 有在住单的房间 ${inhouse.length} 间 ===`);
for (const r of inhouse) {
  const want = r.room_status === "VD" || r.room_status === "OD" ? "OD" : "OC";
  const need = r.room_status !== want;
  console.log(
    `  ${r.room_no} 当前=${r.room_status} → 应为=${want}${need ? "  【需修】" : ""}  ${r.guest_name ?? ""}`
  );
}

console.log(`\n=== 无在住单但状态是住净/住脏的房间 ${stale.length} 间 ===`);
for (const r of stale) {
  const want = r.room_status === "OD" ? "VD" : "VC";
  console.log(`  ${r.room_no} 当前=${r.room_status} → 应为=${want}  【需修】`);
}

if (!APPLY) {
  console.log("\n这是 dry-run，没有写入。加 --apply 才会真正更新。");
  process.exit(0);
}

let changed = 0;
db.exec("BEGIN");
try {
  const a = db
    .prepare(
      `UPDATE rooms
          SET status = CASE WHEN status = 'VD' THEN 'OD' ELSE 'OC' END
        WHERE hotel_id = ?
          AND status NOT IN ('OOO','LOCK')
          AND id IN (SELECT room_id FROM stays WHERE status = 'INHOUSE')`
    )
    .run(HOTEL_ID);
  const b = db
    .prepare(
      `UPDATE rooms
          SET status = CASE WHEN status = 'OD' THEN 'VD' ELSE 'VC' END
        WHERE hotel_id = ?
          AND status IN ('OC','OD')
          AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = rooms.id AND s.status = 'INHOUSE')`
    )
    .run(HOTEL_ID);
  changed = Number(a.changes) + Number(b.changes);
  db.exec("COMMIT");
  console.log(`\n已修正：置为在住 ${a.changes} 间，恢复空房 ${b.changes} 间，共 ${changed} 行`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("失败已回滚:", e.message);
  process.exit(1);
}

/* 校验：还有没有不一致的 */
const left = db
  .prepare(
    `SELECT COUNT(*) AS c FROM rooms r
      WHERE r.hotel_id = ?
        AND ((r.status IN ('OC','OD') AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status='INHOUSE'))
          OR (r.status IN ('VC','VD') AND EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status='INHOUSE')))`
  )
  .get(HOTEL_ID).c;
console.log(`校验：剩余不一致 ${left} 间`);
