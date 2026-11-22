"use server";

import { revalidatePath } from "next/cache";
import { all, get, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { changeRoomStatus } from "@/lib/room-status";
import { nowIso } from "@/lib/utils";

/**
 * 批量置净（整改报告 P2-10：客房移动端/批量操作）
 *
 * 把选中的空脏房（VD）一次性置为空净（VC），同时：
 *   - 该房间未完成的打扫任务标记完成
 *   - 每间房写一条房态日志（来源 housekeeping）
 *
 * 只处理 VD：在住脏房 OD 必须先退房，OOO/LOCK 不能置净。
 */
export async function batchCleanRoomsAction(formData: FormData): Promise<{ ok?: string; error?: string }> {
  const user = await requirePermission("room.change_status");
  const raw = formData.getAll("room_id").map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (raw.length === 0) return { error: "请先勾选要置净的房间" };
  if (raw.length > 200) return { error: "一次最多处理 200 间" };

  const ids = [...new Set(raw)];
  const placeholders = ids.map(() => "?").join(",");
  const rooms = all<{ id: number; room_no: string; status: string }>(
    `SELECT id, room_no, status FROM rooms
      WHERE hotel_id = ? AND id IN (${placeholders})`,
    [user.hotelId, ...ids]
  );

  const notVD = rooms.filter((r) => r.status !== "VD");
  if (rooms.length === 0) return { error: "所选房间不存在" };

  let cleaned = 0;
  const skipped: string[] = [];

  for (const r of rooms) {
    if (r.status !== "VD") {
      skipped.push(`${r.room_no}(${r.status})`);
      continue;
    }
    const res = changeRoomStatus({
      hotelId: user.hotelId,
      roomId: r.id,
      to: "VC",
      operator: user.realName,
      reason: "批量置净",
      source: { kind: "housekeeping" },
    });
    if (!res.ok) {
      skipped.push(`${r.room_no}(${res.error})`);
      continue;
    }
    /*
     * 同步关闭该房间的待办打扫任务。
     *
     * 第 5 轮 P1-4：批量置净等价于「替阿姨点完成打扫」，所以打扫任务同样要进
     * 待审（review_status = PENDING_REVIEW），否则从批量入口完成的打扫永远
     * 绕过了验收，房态页「待审」标签会漏掉这一批。
     * 维修/查房任务不需要验收，CASE 里留 NULL。
     */
    run(
      `UPDATE housekeeping
          SET status = 'DONE',
              done_at = ?,
              review_status = CASE WHEN COALESCE(task_type, '打扫') = '打扫' THEN 'PENDING_REVIEW' ELSE NULL END,
              reviewed_by = NULL,
              reviewed_at = NULL
        WHERE hotel_id = ? AND room_id = ? AND status IN ('PENDING','DOING')`,
      [nowIso(), user.hotelId, r.id]
    );
    cleaned += 1;
  }

  // 操作日志
  if (cleaned > 0) {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName,
      "批量置净",
      `置净 ${cleaned} 间${skipped.length ? `，跳过 ${skipped.length} 间` : ""}`,
      nowIso(),
    ]);
  }

  revalidatePath("/housekeeping");
  revalidatePath("/rooms");
  revalidatePath("/dashboard");

  if (cleaned === 0) {
    return { error: `没有可置净的房间（${skipped.slice(0, 5).join("、")}${skipped.length > 5 ? "…" : ""}）` };
  }
  return {
    ok: `已置净 ${cleaned} 间${skipped.length ? `，跳过 ${skipped.length} 间（非空脏）` : ""}`,
  };
}

/**
 * 按打扫员批量置净：把某个阿姨名下所有已完成任务的房间一次置净。
 * 用于「赵阿姨今天 8 间都打扫完了，一次性点确认」。
 */
export async function cleanByAssigneeAction(formData: FormData): Promise<{ ok?: string; error?: string }> {
  const user = await requirePermission("room.change_status");
  const assignee = String(formData.get("assignee") ?? "").trim();
  if (!assignee) return { error: "请指定打扫员" };

  const rooms = all<{ id: number; room_no: string }>(
    `SELECT DISTINCT r.id, r.room_no
       FROM housekeeping h JOIN rooms r ON r.id = h.room_id
      WHERE h.hotel_id = ? AND h.assignee = ? AND h.status IN ('PENDING','DOING')
        AND r.status = 'VD'
      ORDER BY r.sort`,
    [user.hotelId, assignee]
  );
  if (rooms.length === 0) return { error: `${assignee} 名下没有待置净的空脏房` };

  const fd = new FormData();
  for (const r of rooms) fd.append("room_id", String(r.id));
  return batchCleanRoomsAction(fd);
}
