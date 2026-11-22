/**
 * 小程序「在住服务」公共流程（换房申请 / 延迟退房 / 叫醒 / 客房服务）
 *
 * 四个接口的骨架完全一样，差别只有「类型 + 入参校验 + 一句 note + 可选副作用」：
 *   1. 限流 → 鉴权 → 小程序配置（miniGuard）
 *   2. requestId 必填（幂等键，缺了就不接单）
 *   3. 未绑定客史一律拒（NOT_BOUND）
 *   4. stayId 必须属于当前 mini_user（loadOwnedStay）
 *   5. **幂等**：同一个 requestId 再来一次 → 直接回已有记录 + duplicated: true，
 *      绝不再建第二条（(hotel_id, request_id) 唯一索引是最后一道防线）
 *   6. 落一条 mini_service_requests（status = PENDING，等前台处理）+ 写 op_logs
 *
 * 为什么把这套流程抽出来而不是每个 route 抄一遍：
 * 越权防护与幂等是安全边界，抄四遍必然有一遍写漏（少一个 hotel_id、少一个
 * mini_user_id 判定）。收成一份之后，四个接口的差别只剩业务校验，审起来也快。
 */

import { NextResponse } from "next/server";
import { tx } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import {
  fail,
  findMiniServiceRequest,
  insertMiniServiceRequest,
  isRequestId,
  loadOwnedStay,
  logMiniOp,
  miniGuard,
  ok,
  readJsonBody,
  resolveMiniGuest,
  str,
  MINI_SERVICE_TYPE_LABEL,
  type MiniGuestIdentity,
  type MiniServiceType,
  type MiniStayRow,
} from "../../_shared";

/** 写接口统一限流：10 次/分钟 */
export const STAY_ACTION_RATE_LIMIT_PER_MINUTE = 10;

export type StayApplicationInput = {
  req: Request;
  /** 限流作用域（每个接口独立计数，互不挤占配额） */
  scope: string;
  /** 路由的 params（Next 16 是 Promise） */
  params: Promise<{ id: string }>;
  /** 固定的服务请求类型（换房 / 延迟退房 / 叫醒 / 续住这类只有一种） */
  serviceType?: MiniServiceType;
  /**
   * 动态服务类型（客房服务有清洁 / 送物 / 维修 / 其他四种，类型来自请求体）。
   * 与 serviceType 二选一；返回 { response } 表示类型非法，直接回错误。
   */
  resolveServiceType?: (
    body: Record<string, unknown>
  ) => { type: MiniServiceType } | { response: NextResponse };
  /**
   * 业务校验：返回 { note } 继续，返回 { response } 直接把错误回给小程序。
   * body 是已经解析好的请求体（由本函数统一解析，避免每个 route 各读一遍）。
   */
  prepare: (
    stay: MiniStayRow,
    body: Record<string, unknown>,
    hotelId: number
  ) => { note: string } | { response: NextResponse };
  /**
   * 可选副作用（与台账写入同一个事务）。
   * 目前只有「叫醒」用到：把叫醒时间写进 PC 端也在用的 wake_up_calls 表。
   */
  sideEffect?: (args: {
    hotelId: number;
    miniUserId: number;
    identity: MiniGuestIdentity;
    stay: MiniStayRow;
    now: string;
  }) => void;
  /** 额外回吐的字段（例如叫醒时间）；成功与幂等回放都会带上 */
  extra?: (body: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * 提交一条在住服务申请。
 * 成功与「重复提交」都返回 200 + ok:true（前端不需要区分成功/重试），
 * 只有校验失败才回 ok:false。
 */
export async function submitStayApplication(input: StayApplicationInput): Promise<NextResponse> {
  const guard = miniGuard(input.req, input.scope, STAY_ACTION_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await input.params;
  const stayId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(stayId) || stayId <= 0) {
    return fail("BAD_REQUEST", "入住单号格式不正确", 400);
  }

  const body = await readJsonBody(input.req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  /* 服务类型：固定值或由请求体推导（推导失败直接回校验错误） */
  let serviceType: MiniServiceType;
  if (input.resolveServiceType) {
    const resolved = input.resolveServiceType(body);
    if ("response" in resolved) return resolved.response;
    serviceType = resolved.type;
  } else if (input.serviceType) {
    serviceType = input.serviceType;
  } else {
    return fail("SERVICE_REQUEST_FAILED", "服务类型未配置，请联系酒店前台");
  }

  /* 幂等键必填：没有它就无法区分「网络重试」与「客人真的又提了一次」 */
  const requestId = str(body.requestId);
  if (!isRequestId(requestId)) {
    return fail("BAD_REQUEST", "缺少有效的 requestId（8-64 位字母/数字/横线），请重新进入页面后再试", 400);
  }

  const hotelId = guard.hotelId;
  const identity = resolveMiniGuest(hotelId, guard.guestId);
  if (!identity) {
    return fail("NOT_BOUND", "尚未绑定会员身份，无法提交在住服务。请先在小程序里绑定身份，或联系酒店前台。");
  }

  /* ---------- 幂等回放（事务外先查一次，命中直接返回，不做任何写操作） ---------- */
  const existing = findMiniServiceRequest(hotelId, requestId);
  if (existing) {
    if (existing.serviceType !== serviceType || existing.stayId !== stayId) {
      return fail("REQUEST_ID_CONFLICT", "该请求号已被其他操作使用，请重新进入页面后再试");
    }
    return ok({
      duplicated: true,
      serviceRequestId: existing.id,
      serviceType: existing.serviceType,
      serviceTypeLabel: MINI_SERVICE_TYPE_LABEL[existing.serviceType as MiniServiceType] ?? existing.serviceType,
      status: existing.status,
      statusLabel: statusLabelOf(existing.status),
      note: existing.note,
      createdAt: existing.createdAt,
      ...(input.extra ? input.extra(body) : {}),
    });
  }

  const stay = loadOwnedStay(hotelId, identity, stayId);
  if (!stay || stay.status !== "INHOUSE") {
    /* 不存在 / 别人的入住单 / 已退房 / 别家酒店：同一句话，不给 id 存在性预言机 */
    return fail("STAY_NOT_FOUND", "没有找到这笔在住单，请返回列表刷新后重试", 404);
  }

  const prepared = input.prepare(stay, body, hotelId);
  if ("response" in prepared) return prepared.response;
  const note = prepared.note.slice(0, 300);

  let rowId = 0;
  try {
    rowId = tx(() => {
      /* 事务内重查：并发下可能刚退房，或另一个请求已经用同一个 requestId 落了库 */
      const fresh = loadOwnedStay(hotelId, identity, stayId);
      if (!fresh || fresh.status !== "INHOUSE") {
        return -1;
      }
      const already = findMiniServiceRequest(hotelId, requestId);
      if (already) return already.id;

      const now = nowIso();
      const id = insertMiniServiceRequest({
        hotelId,
        miniUserId: guard.user.id,
        guestId: identity.guestId,
        stayId: fresh.id,
        bookingId: fresh.bookingId,
        serviceType,
        requestId,
        note,
        status: "PENDING",
      });

      input.sideEffect?.({ hotelId, miniUserId: guard.user.id, identity, stay: fresh, now });

      logMiniOp(
        hotelId,
        `小程序${MINI_SERVICE_TYPE_LABEL[serviceType]}`,
        `入住单 ${fresh.stayNo} 房间 ${fresh.roomNo || "-"}：${note}；requestId=${requestId}`
      );

      return id;
    });
  } catch {
    /*
     * 唯一索引 (hotel_id, request_id) 被撞 = 并发下另一个请求先落库了。
     * 不抛错、不重复建单，回「已提交过」。
     */
    const again = findMiniServiceRequest(hotelId, requestId);
    if (again) {
      return ok({
        duplicated: true,
        serviceRequestId: again.id,
        serviceType: again.serviceType,
        serviceTypeLabel: MINI_SERVICE_TYPE_LABEL[again.serviceType as MiniServiceType] ?? again.serviceType,
        status: again.status,
        statusLabel: statusLabelOf(again.status),
        note: again.note,
        createdAt: again.createdAt,
        ...(input.extra ? input.extra(body) : {}),
      });
    }
    return fail("SERVICE_REQUEST_FAILED", "提交失败，请稍后重试或联系酒店前台");
  }

  if (rowId === -1) {
    return fail("STAY_NOT_FOUND", "没有找到这笔在住单，请返回列表刷新后重试", 404);
  }

  return ok({
    duplicated: false,
    serviceRequestId: rowId,
    serviceType,
    serviceTypeLabel: MINI_SERVICE_TYPE_LABEL[serviceType],
    status: "PENDING",
    statusLabel: statusLabelOf("PENDING"),
    note,
    createdAt: nowIso(),
    ...(input.extra ? input.extra(body) : {}),
  });
}

/** 状态 → 文案（与 _shared.ts 的 MINI_SERVICE_STATUS_LABEL 同源，这里只做兜底） */
function statusLabelOf(status: string): string {
  const map: Record<string, string> = {
    PENDING: "待处理",
    ACCEPTED: "已接单",
    PROCESSING: "处理中",
    DONE: "已完成",
    CANCELLED: "已取消",
    REJECTED: "已驳回",
  };
  return map[status] ?? status;
}
