/**
 * 小程序：换房申请
 *
 * POST /api/mini/stays/:id/change-room   { roomId? , roomNo?, reason?, requestId }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、只创建申请，不直接换房（为什么）
 * ══════════════════════════════════════════════════════════════════════════
 * PC 端 changeRoomAction 要在一个事务里做五件事：原房 VD、新房 OC、改 stays.room_id、
 * 同步 folios.room_no 与 booking_rooms.room_id，再写房态日志与操作日志。
 * 这是前台的现场处置（新房脏不脏、行李谁搬、原房何时打扫），
 * 客人单方面点一下就改房态，前台会完全失去现场控制。
 * 所以小程序侧只落一条 PENDING 申请（mini_service_requests.CHANGE_ROOM），
 * 前台在 PC 端确认后才真正执行换房。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、申请阶段就要挡掉的四类错
 * ══════════════════════════════════════════════════════════════════════════
 *   1. **目标房间不属于本店**（清单：换房不能跨酒店）：查询带 hotel_id，
 *      客户端的 roomId / roomNo 只是候选值，跨店 id 一律按「房间不存在」拒绝 ——
 *      不区分「不存在」与「是别家的」，否则这个接口就成了别家酒店的房间号探测器。
 *   2. 目标房间就是当前房间：无意义。
 *   3. 目标房间不是空净 / 空脏（VC / VD）：住不进去。
 *   4. 目标房间在客人剩余在住期内已有占用（P0-5 口径，排除自己）：
 *      换过去就是双重占用，提前拒掉省一轮无效沟通。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、不泄漏别人的信息
 * ══════════════════════════════════════════════════════════════════════════
 * 冲突只回「该房间在 X~Y 已被安排」，**不回**别人的姓名 / 单号
 * （findRoomConflicts 返回的 detail 里带这些，绝不能直接下发）。
 */

import { get } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { findRoomConflicts } from "@/lib/room-availability";
import { fail, str, type MiniStayRow } from "../../../_shared";
import { submitStayApplication } from "../_stay-actions";

export const dynamic = "force-dynamic";

/** 只有空净 / 空脏房可以换入（与 PC 端 changeRoomAction 同一判定） */
const CHANGEABLE_ROOM_STATUSES = ["VC", "VD"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return submitStayApplication({
    req,
    scope: "mini:stay:change-room",
    params: ctx.params,
    serviceType: "CHANGE_ROOM",
    prepare: prepareChangeRoom,
  });
}

/**
 * 校验并生成申请内容。
 *
 * 放在这里而不是 route 顶层：只有当 stayId 已经通过归属校验（stay 一定是当前客人
 * 自己的在住单）之后，才允许拿它去查房间占用 —— 否则「用别人的 stayId 探房间状态」
 * 就成了一个免费的房态查询接口。
 */
function prepareChangeRoom(
  stay: MiniStayRow,
  body: Record<string, unknown>,
  hotelId: number
): { note: string } | { response: ReturnType<typeof fail> } {
  const roomIdNum = Number(body.roomId);
  const roomId = Number.isFinite(roomIdNum) && roomIdNum > 0 ? Math.trunc(roomIdNum) : 0;
  const roomNo = str(body.roomNo).slice(0, 12);
  const reason = str(body.reason).slice(0, 120);

  if (!roomId && !roomNo) {
    return { response: fail("BAD_REQUEST", "请选择要换的房间", 400) };
  }

  /* 目标房间必须属于本店：两个条件都带 hotel_id，跨店 id 查不到 → 走「房间不存在」 */
  const room = get<{ id: number; room_no: string | null; status: string | null }>(
    roomId
      ? `SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ? LIMIT 1`
      : `SELECT id, room_no, status FROM rooms WHERE room_no = ? AND hotel_id = ? LIMIT 1`,
    [roomId || roomNo, hotelId]
  );
  if (!room) {
    return { response: fail("ROOM_NOT_FOUND", "目标房间不存在，请刷新可换房列表后重试", 404) };
  }
  if (Number(room.id) === Number(stay.roomId)) {
    return { response: fail("BAD_REQUEST", "目标房间就是当前房间，请选择别的房间", 400) };
  }
  if (!CHANGEABLE_ROOM_STATUSES.includes((room.status ?? "").trim())) {
    return {
      response: fail("ROOM_UNAVAILABLE", `房间 ${room.room_no ?? ""} 当前不可换入（不是空房），请选择其他房间`),
    };
  }

  /*
   * 剩余在住期内的占用检查（P0-5 口径）：从「今天（不早于入住日）」到预计离店日，
   * 排除自己这条在住单。命中即拒 —— 换过去就是双重占用。
   */
  const today = bizToday(hotelId);
  const from = stay.checkInDate > today ? stay.checkInDate : today;
  const to = stay.expectCheckOut > from ? stay.expectCheckOut : addOneDay(from);
  const conflicts = findRoomConflicts({
    hotelId,
    roomId: Number(room.id),
    checkIn: from,
    checkOut: to,
    excludeStayId: stay.id,
  });
  if (conflicts.length > 0) {
    return {
      response: fail(
        "ROOM_UNAVAILABLE",
        `房间 ${room.room_no ?? ""} 在 ${from}~${to} 期间已有安排，请选择其他房间，或联系前台协调`
      ),
    };
  }

  return {
    note:
      `申请换房：${stay.roomNo || "-"} → ${room.room_no ?? ""}（${from}~${to}）` +
      (reason ? `；原因：${reason}` : ""),
  };
}

/** 日期加一天（字符串运算，不经过时区） */
function addOneDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
