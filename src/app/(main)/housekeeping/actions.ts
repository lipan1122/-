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

/* ============================================================ 客房审核状态（第 5 轮 P1-4）
 *
 * housekeeping.review_status 与 housekeeping.status 是两个正交维度（迁移第 20 段）：
 *   status        任务流转：PENDING 待打扫 → DOING 打扫中 → DONE 已完成 / CANCELLED
 *   review_status 验收结果：NULL 无需审核 / PENDING_REVIEW 待验收 / APPROVED / REJECTED
 *
 * 流程：
 *   ① 阿姨在「客房中心」或手机端点「开始打扫」→ status = DOING（房态页「打扫中」标签）
 *   ② 点「完成打扫」→ status = DONE 且 review_status = PENDING_REVIEW
 *      （房态页「待审」标签；维修/查房任务不走验收，review_status 留 NULL）
 *   ③ 主管点「验收通过」→ APPROVED
 *      点「打回重做」 → REJECTED，同时任务退回 PENDING 重新进待打扫列表；
 *      房间若已置净（VC）则同步改回空脏（VD），避免「房态干净但还要重做」。
 *
 * 为什么维修/查房不置 PENDING_REVIEW：它们不是「打扫质量」问题，且验收口径不同
 * （维修要复检设备、查房要核对物品），混进「待审」标签会让房态页待审数虚高。
 */
const REVIEW_PENDING = "PENDING_REVIEW";
const REVIEW_APPROVED = "APPROVED";
const REVIEW_REJECTED = "REJECTED";

/** 任务状态中文名（拒绝操作时回显原因用） */
const TASK_STATUS_TEXT: Record<string, string> = {
  PENDING: "待打扫",
  DOING: "打扫中",
  DONE: "已完成",
  CANCELLED: "已取消",
};

/** 完成一条客房任务：任务置为已完成，对应空脏房间置为 VC 并记房态日志 */
export async function completeTaskAction(taskId: number): Promise<void> {
  const user = await requireUser();
  if (!Number.isFinite(taskId) || taskId <= 0) back("任务完成失败：任务参数不正确，请刷新后重试");

  const task = get<{ room_id: number | null; status: string; task_type: string | null }>(
    `SELECT room_id, status, task_type FROM housekeeping WHERE id = ? AND hotel_id = ?`,
    [Math.trunc(taskId), user.hotelId]
  );
  if (!task) back("任务完成失败：该任务不存在或已被删除，请刷新列表确认");

  /*
   * 已完成 / 已取消的任务不允许再「完成」：
   * 重复提交会把已经验收通过（APPROVED）的记录重置回 PENDING_REVIEW，
   * 验收人和验收时间被抹掉 —— 验收流水就失去了追溯意义。
   * 前端只在 PENDING / DOING 的行上渲染「完成」按钮，这里兜一次底。
   */
  if (task.status === "DONE") {
    back("任务完成失败：该任务已完成。若打扫不合格，请主管在「待验收」里点「打回重做」");
  }
  if (task.status === "CANCELLED") {
    back("任务完成失败：该任务已取消，不能标记为完成；如仍需打扫请重新建任务");
  }

  /*
   * 第 5 轮 P1-4：打扫任务完成即进入「待审」（review_status = PENDING_REVIEW），
   * 由主管验收后再置 APPROVED / REJECTED。原来直接 DONE 就结束了，
   * 「已打扫但没人验收」这件事在系统里根本不存在，房态页的「待审」标签
   * 只能去查 cancel_requests（取消入住审批）凑数 —— 那是语义错误。
   *
   * task_type 为 NULL 的历史数据按「打扫」处理（页面展示也是 COALESCE(...,'打扫')）。
   */
  const isCleanTask = (task.task_type ?? "打扫") === "打扫";
  run(
    `UPDATE housekeeping
        SET status = 'DONE',
            done_at = ?,
            review_status = ?,
            reviewed_by = NULL,
            reviewed_at = NULL
      WHERE id = ? AND hotel_id = ?`,
    [nowIso(), isCleanTask ? REVIEW_PENDING : null, Math.trunc(taskId), user.hotelId]
  );

  if (task.room_id) {
    setRoomVacantClean(user.hotelId, task.room_id, `客房任务 #${taskId} 打扫完成`, user.realName);
  }

  revalidatePath("/housekeeping");
  revalidatePath("/mobile-housekeeping");
  revalidatePath("/rooms");
}

/**
 * 开始打扫：PENDING → DOING（第 5 轮 P1-4）
 *
 * 补这个动作的原因：housekeeping.status 一直有 DOING，批量置净的 SQL 里
 * 也早就写了 `status IN ('PENDING','DOING')`，但整个系统**没有任何入口**
 * 能把任务从 PENDING 推到 DOING —— 于是库里 DOING 永远是 0 条，
 * 房态页的「打扫中」标签看上去像「字段缺失」，实际是缺动作。
 */
export async function startTaskAction(taskId: number): Promise<void> {
  const user = await requirePermission("room.change_status");
  if (!Number.isFinite(taskId) || taskId <= 0) back("开始打扫失败：任务参数不正确，请刷新后重试");

  const id = Math.trunc(taskId);
  const task = get<{ status: string; task_type: string | null; assignee: string | null }>(
    `SELECT status, task_type, assignee FROM housekeeping WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!task) back("开始打扫失败：该任务不存在或已被删除，请刷新列表确认");

  // 幂等：已经点过「开始打扫」的，不重复写日志，直接回列表（避免双击报错）
  if (task.status === "DOING") {
    revalidatePath("/housekeeping");
    revalidatePath("/mobile-housekeeping");
    revalidatePath("/rooms");
    return;
  }
  if (task.status !== "PENDING") {
    back(
      `开始打扫失败：任务当前是「${TASK_STATUS_TEXT[task.status] ?? task.status}」，只有待打扫任务能开始打扫`
    );
  }

  /*
   * 带 status = 'PENDING' 条件：两个阿姨同时点「开始打扫」时只有一次真正生效，
   * 不会出现重复记录；认领人取任务原来的 assignee，未指派时记当前操作人。
   */
  run(
    `UPDATE housekeeping
        SET status = 'DOING',
            assignee = COALESCE(NULLIF(TRIM(assignee), ''), ?)
      WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`,
    [user.realName, id, user.hotelId]
  );

  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    user.realName,
    "开始打扫",
    `客房任务 #${id}（${task.task_type ?? "打扫"}）置为打扫中`,
    nowIso(),
  ]);

  revalidatePath("/housekeeping");
  revalidatePath("/mobile-housekeeping");
  revalidatePath("/rooms");
}

/**
 * 验收打扫任务（第 5 轮 P1-4）
 *
 * @param taskId 任务 ID
 * @param pass   true = 验收通过（APPROVED）；false = 打回重做（REJECTED）
 *
 * 用 room.change_status 权限点：项目里 admin / frontdesk / housekeeping /
 * cashier 的角色权限由数据库配置，这里沿用「房态变更」这一个既有权限，
 * 不新增权限点以免在老库里出现「谁都点不了验收」的空窗。
 */
export async function reviewTaskAction(taskId: number, pass: boolean): Promise<void> {
  const user = await requirePermission("room.change_status");
  if (!Number.isFinite(taskId) || taskId <= 0) back("验收失败：任务参数不正确，请刷新后重试");

  const id = Math.trunc(taskId);
  const task = get<{
    status: string;
    task_type: string | null;
    review_status: string | null;
    room_id: number | null;
    room_no: string | null;
  }>(
    `SELECT h.status, h.task_type, h.review_status, h.room_id, r.room_no
       FROM housekeeping h
       LEFT JOIN rooms r ON r.id = h.room_id
      WHERE h.id = ? AND h.hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!task) back("验收失败：该任务不存在或已被删除，请刷新列表确认");

  /*
   * 只接受「待审」任务：已验收过的任务重复点会覆盖前一次的验收人和时间，
   * 验收记录就失去追溯意义。前端按钮按状态隐藏，这里再兜一次底。
   */
  if (task.review_status !== REVIEW_PENDING) {
    const label =
      task.review_status === REVIEW_APPROVED
        ? "已验收通过"
        : task.review_status === REVIEW_REJECTED
          ? "已打回重做"
          : "不在待审状态";
    back(`验收失败：任务 ${label}，无需重复验收，请刷新列表确认`);
  }

  const at = nowIso();
  if (pass) {
    run(
      `UPDATE housekeeping
          SET review_status = ?, reviewed_by = ?, reviewed_at = ?
        WHERE id = ? AND hotel_id = ? AND review_status = ?`,
      [REVIEW_APPROVED, user.realName, at, id, user.hotelId, REVIEW_PENDING]
    );
  } else {
    /*
     * 打回重做：任务退回 PENDING 重新进待打扫列表，done_at 清空（它不是完成态了）。
     * 房态只在房间仍是空净（VC）时退回空脏（VD）：
     *   · VC → VD 是合法流转（见 src/lib/room-status.ts），且语义正确 ——
     *     验收不合格的房间不能再算「干净可排房」；
     *   · 房间若已排房/在住（OC/OD）、维修（OOO）、锁房（LOCK），房态不归这一步管，
     *     硬改会把入住流程和维修流程搅乱，只留操作日志。
     */
    run(
      `UPDATE housekeeping
          SET review_status = ?, reviewed_by = ?, reviewed_at = ?, status = 'PENDING', done_at = NULL
        WHERE id = ? AND hotel_id = ? AND review_status = ?`,
      [REVIEW_REJECTED, user.realName, at, id, user.hotelId, REVIEW_PENDING]
    );

    if (task.room_id) {
      const room = get<{ status: string }>(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [
        task.room_id,
        user.hotelId,
      ]);
      if (room?.status === "VC") {
        changeRoomStatus({
          hotelId: user.hotelId,
          roomId: task.room_id,
          to: "VD",
          operator: user.realName,
          reason: `客房任务 #${id} 验收不通过，退回重做`,
          source: { kind: "housekeeping", taskId: id },
        });
      }
    }
  }

  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    user.realName,
    pass ? "客房验收通过" : "客房验收打回",
    `任务 #${id}（${task.room_no ?? "房间未知"}·${task.task_type ?? "打扫"}）${
      pass ? "验收通过" : "打回重做，任务退回待打扫"
    }`,
    at,
  ]);

  revalidatePath("/housekeeping");
  revalidatePath("/mobile-housekeeping");
  revalidatePath("/rooms");
}

/** 表单适配：开始打扫（PENDING → DOING） */
export async function startTaskFormAction(formData: FormData): Promise<void> {
  const taskId = toId(formData.get("taskId"));
  if (!taskId) back("开始打扫失败：缺少任务参数，请刷新页面后重试");
  await startTaskAction(taskId);
}

/** 表单适配：验收（action = approve / reject） */
export async function reviewTaskFormAction(formData: FormData): Promise<void> {
  const taskId = toId(formData.get("taskId"));
  if (!taskId) back("验收失败：缺少任务参数，请刷新页面后重试");
  await reviewTaskAction(taskId, formData.get("action") !== "reject");
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
