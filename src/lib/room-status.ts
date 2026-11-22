/**
 * 房态统一流转服务（整改报告 P1-7）
 *
 * 目标：
 *   1. 所有房态变化走这里，不再散落 `UPDATE rooms SET status`
 *   2. 每次变化都写 room_logs（谁改的 / 从什么改成什么 / 原因 / 来源业务单）
 *   3. 校验合法流转，拦住「维修房直接改成空净」这类越级操作
 *   4. 房态变更带上来源（入住/退房/置净/维修/夜审），便于排查
 */

import { get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";

export const ROOM_STATUS = {
  VC: "空净",
  VD: "空脏",
  OC: "在住净",
  OD: "在住脏",
  OOO: "维修",
  LOCK: "锁房",
} as const;
export type RoomStatus = keyof typeof ROOM_STATUS;

/** 允许的状态流转（from → 可到的 to） */
const ALLOWED: Record<RoomStatus, RoomStatus[]> = {
  VC: ["VD", "OC", "OD", "OOO", "LOCK"],
  VD: ["VC", "OC", "OD", "OOO", "LOCK"],
  /*
   * 住净 → 空脏：退房必经路径（客人离店房间就脏了，必须能直接转 VD）。
   * 这里漏掉 VD 会导致「退房后房态不变」——曾经的真实 bug。
   */
  OC: ["OD", "VD", "VC", "OOO", "LOCK"],
  OD: ["OC", "VD", "OOO", "LOCK"],
  OOO: ["VC", "VD"],
  LOCK: ["VC", "VD"],
};

/** 来源业务单类型 */
export type RoomChangeSource =
  | { kind: "checkin"; stayId: number; stayNo?: string }
  | { kind: "checkout"; stayId: number; stayNo?: string }
  | { kind: "change_room"; bookingId?: number; stayId?: number }
  | { kind: "housekeeping"; taskId?: number }
  | { kind: "maintenance"; note?: string }
  | { kind: "night_audit"; bizDate?: string }
  | { kind: "manual" };

function sourceText(src: RoomChangeSource): string {
  switch (src.kind) {
    case "checkin":
      return `入住 ${src.stayNo ?? "#" + src.stayId}`;
    case "checkout":
      return `退房 ${src.stayNo ?? "#" + src.stayId}`;
    case "change_room":
      return `换房${src.stayId ? " 入住单#" + src.stayId : ""}${src.bookingId ? " 预订#" + src.bookingId : ""}`;
    case "housekeeping":
      return `保洁${src.taskId ? " 任务#" + src.taskId : ""}`;
    case "maintenance":
      return `维修${src.note ? " " + src.note : ""}`;
    case "night_audit":
      return `夜审${src.bizDate ? " " + src.bizDate : ""}`;
    default:
      return "手工";
  }
}

/** 房态是否可被排房/预订占用（维修房、锁房不能排） */
export function isAssignable(status: string): boolean {
  return status === "VC" || status === "VD";
}

export type ChangeResult = { ok: true } | { ok: false; error: string };

/**
 * 变更房态（带校验 + 日志）
 *
 * @param hotelId   酒店 ID
 * @param roomId    房间 ID
 * @param to        目标房态
 * @param operator  操作人（姓名）
 * @param reason    原因（可选，写日志）
 * @param source    来源业务单
 */
export function changeRoomStatus(input: {
  hotelId: number;
  roomId: number;
  to: RoomStatus;
  operator: string;
  reason?: string;
  source?: RoomChangeSource;
}): ChangeResult {
  const { hotelId, roomId, to, operator, reason, source = { kind: "manual" } } = input;

  const room = get<{ id: number; room_no: string; status: string }>(
    `SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`,
    [roomId, hotelId]
  );
  if (!room) return { ok: false, error: "房间不存在" };

  const from = room.status as RoomStatus;
  if (from === to) return { ok: true }; // 幂等：已经是目标状态

  const allowed = ALLOWED[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: `不能把 ${room.room_no} 从「${ROOM_STATUS[from] ?? from}」直接改成「${ROOM_STATUS[to] ?? to}」`,
    };
  }

  run(`UPDATE rooms SET status = ? WHERE id = ? AND hotel_id = ?`, [to, roomId, hotelId]);
  run(
    `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      hotelId,
      roomId,
      from,
      to,
      `${sourceText(source)}${reason ? " · " + reason : ""}`,
      operator,
      nowIso(),
    ]
  );

  return { ok: true };
}

/**
 * 按入住/退房场景推导房态
 *   入住 → OC（住净）；退房 → VD（退房后必脏，需清扫）
 */
export function statusAfterCheckin(): RoomStatus {
  return "OC";
}
export function statusAfterCheckout(): RoomStatus {
  return "VD";
}
