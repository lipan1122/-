"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/session";
import { changeRoomStatus } from "@/lib/room-status";
import { nowIso } from "@/lib/utils";

/** 读取正整数表单字段，非法值返回 0 */
function toId(value: FormDataEntryValue | null): number {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * 客房中心操作失败时回显原因（整改 P2-20）
 *
 * 原来「置净 / 完成任务 / 建维修单」失败都是裸 `return;`：
 * 阿姨在手机上点「已打扫」，房间没变干净，页面上却一个字都不提示。
 * 统一跳回 /housekeeping 并带上 err，由页面顶部横幅显示。
 */
function back(message: string): never {
  redirect(`/housekeeping?err=${encodeURIComponent(message)}`);
}

/**
 * 把房间从空脏置为空净（走统一房态服务，自动校验流转并写 room_logs）。
 * 只有 VD（空脏）才会被置净：在住脏房 OD 需先退房，空净 VC 无需重复处理。
 */
function setRoomVacantClean(hotelId: number, roomId: number, reason: string, operator: string, taskId?: number): void {
  const room = get<{ status: string }>(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [
    roomId,
    hotelId,
  ]);
  if (!room || room.status !== "VD") return;

  changeRoomStatus({
    hotelId,
    roomId,
    to: "VC",
    operator,
    reason,
    source: { kind: "housekeeping", taskId },
  });
}

/** 完成一条客房任务：任务置为已完成，对应空脏房间置为 VC 并记房态日志 */
export async function completeTaskAction(taskId: number): Promise<void> {
  const user = await requireUser();
  if (!Number.isFinite(taskId) || taskId <= 0) back("任务完成失败：任务参数不正确，请刷新后重试");

  const task = get<{ room_id: number | null; status: string }>(
    `SELECT room_id, status FROM housekeeping WHERE id = ? AND hotel_id = ?`,
    [Math.trunc(taskId), user.hotelId]
  );
  if (!task) back("任务完成失败：该任务不存在或已被删除，请刷新列表确认");

  run(`UPDATE housekeeping SET status = 'DONE', done_at = ? WHERE id = ? AND hotel_id = ?`, [
    nowIso(),
    Math.trunc(taskId),
    user.hotelId,
  ]);

  if (task.room_id) {
    setRoomVacantClean(user.hotelId, task.room_id, `客房任务 #${taskId} 打扫完成`, user.realName);
  }

  revalidatePath("/housekeeping");
  revalidatePath("/rooms");
}

/** 脏房置净：房间直接改为 VC，并写房态变更日志 */
export async function setRoomCleanAction(roomId: number): Promise<void> {
  const user = await requireUser();
  if (!Number.isFinite(roomId) || roomId <= 0) back("置净未执行：房间参数不正确，请刷新后重试");

  /*
   * P2-20：只有空脏房（VD）需要置净。原来非 VD 的房间在 setRoomVacantClean 里被静默丢弃，
   * 用户点「置净」没有任何反馈。这里先查一次给出确切原因（不改房态逻辑，只是把拒绝说出口）。
   */
  const room = get<{ room_no: string; status: string }>(
    `SELECT room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`,
    [Math.trunc(roomId), user.hotelId]
  );
  if (!room) back("置净未执行：房间不存在或不属于本店");
  if (room.status !== "VD") back(`置净未执行：${room.room_no} 当前不是空脏房，无需置净`);

  setRoomVacantClean(user.hotelId, Math.trunc(roomId), "客房中心置净", user.realName);

  revalidatePath("/housekeeping");
  revalidatePath("/rooms");
}

/** 表单适配：完成客房任务 */
export async function completeTaskFormAction(formData: FormData): Promise<void> {
  const taskId = toId(formData.get("taskId"));
  if (!taskId) back("任务完成失败：缺少任务参数，请刷新页面后重试");
  await completeTaskAction(taskId);
}

/** 表单适配：脏房置净 */
export async function setRoomCleanFormAction(formData: FormData): Promise<void> {
  const roomId = toId(formData.get("roomId"));
  if (!roomId) back("置净未执行：缺少房间参数，请刷新页面后重试");
  await setRoomCleanAction(roomId);
}

/* ============================================================ 维修任务（整改报告第 10 节） */

/** 一条任务最多接受的图片数（页面缩略图也只展示 3 张） */
const MAX_PHOTOS = 3;
/** 单张图片 data URL 的字符上限，约 200KB 原图（base64 会膨胀约 1.37 倍） */
const MAX_PHOTO_CHARS = 300_000;

/** 读取表单文本字段并去掉首尾空白，非字符串一律当空 */
function toText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析 photos 表单字段（JSON 数组字符串）
 *
 * 约定只接受字符串项：既支持 data URL（前端 FileReader 读出来的），
 * 也支持服务器上的图片路径，两种都能直接塞进 <img src>。
 * 非法 JSON、超大图片、超量图片一律丢弃，避免把脏数据写进库。
 */
function parsePhotos(value: FormDataEntryValue | null): string[] {
  const raw = toText(value);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const url = item.trim();
    if (!url || url.length > MAX_PHOTO_CHARS) continue;
    out.push(url);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

/**
 * 新建维修任务（报告第 10 节：客房支持维修图片和备注）
 *
 * 表单字段：
 *   room_id  必填，房间 ID
 *   note     必填，维修说明（同时写进房态日志）
 *   photos   可选，JSON 数组字符串（data URL 或图片路径）
 *   assignee 可选，默认「工程部」
 *
 * 副作用：插入一条 task_type='维修' 的任务 + 把房间置为 OOO（维修），
 * 房态变化统一走 changeRoomStatus，来源标记 maintenance。
 */
export async function createMaintenanceTaskAction(formData: FormData): Promise<void> {
  const user = await requirePermission("room.change_status");

  const roomId = toId(formData.get("room_id"));
  const note = toText(formData.get("note"));
  const photos = parsePhotos(formData.get("photos"));
  const assignee = toText(formData.get("assignee")) || "工程部";

  // 房间和维修说明都是必填：缺了直接不写库，避免产生无法处理的空任务
  if (!roomId || !note) back("维修任务未创建：请选择房间并填写维修说明");

  const room = get<{ id: number; room_no: string; status: string }>(
    `SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`,
    [roomId, user.hotelId]
  );
  if (!room) back("维修任务未创建：房间不存在或不属于本店");

  // 先落任务（room_status_snapshot 存创建那一刻的房态，便于事后按房态统计）
  run(
    `INSERT INTO housekeeping
       (hotel_id, room_id, task_type, status, assignee, note, photos, room_status_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      user.hotelId,
      room.id,
      "维修",
      "PENDING",
      assignee,
      note,
      photos.length > 0 ? JSON.stringify(photos) : null,
      room.status,
      nowIso(),
    ]
  );

  // 再把房间置为维修 OOO：走统一房态服务，自动校验流转并写 room_logs
  const res = changeRoomStatus({
    hotelId: user.hotelId,
    roomId: room.id,
    to: "OOO",
    operator: user.realName,
    source: { kind: "maintenance", note },
  });

  // 房态改不过去（例如房间状态被并发改动）也不丢维修单，只留痕便于排查
  if (!res.ok) {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName,
      "报修",
      `${room.room_no} 维修任务已创建，但房态置 OOO 失败：${res.error}`,
      nowIso(),
    ]);
  }

  revalidatePath("/housekeeping");
  revalidatePath("/rooms");
}
