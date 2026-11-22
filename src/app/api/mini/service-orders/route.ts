/**
 * 小程序：我的服务请求列表
 *
 * GET /api/mini/service-orders?status=&limit=
 *
 * ── 只看自己的 ──
 * 取数条件**只有** `hotel_id = token 的酒店 AND mini_user_id = token 的用户`
 * （mini_program_users.id，服务端身份），请求里没有任何 id 参数可以影响结果。
 * 所以哪怕客户端传 `?miniUserId=2` 也不会读到别人的请求 —— 参数被完全忽略，
 * 这是刻意的：越权最省事的修法就是「让攻击面根本不存在」。
 *
 * ── 字段裁剪 ──
 *   · 不回 mini_user_id / guest_id / hotel_id（客人不需要，回了只是给探测提供坐标）；
 *   · note 是客人自己写的内容，照实回；
 *   · operator 是前台处理人姓名（客人现场就会知道是谁处理的），照实回；
 *   · 不返回任何其他客人的数据、也不返回全店统计。
 *
 * ── 客房服务以外的类型 ──
 * 延迟退房 / 换房 / 叫醒 / 续住也落同一张表，所以这里一并列出来（客人能看到自己
 * 提过的所有申请与处理进度）。status 允许按状态过滤，便于页面分 Tab。
 */

import { all } from "@/lib/db";
import {
  ensureMiniServiceSchema,
  fail,
  int,
  miniGuard,
  ok,
  MINI_SERVICE_STATUS_LABEL,
  MINI_SERVICE_TYPE_LABEL,
  type MiniServiceType,
} from "../_shared";

export const dynamic = "force-dynamic";

/** 读接口限流：60 次/分钟 */
const READ_RATE_LIMIT_PER_MINUTE = 60;

/** 单次最多回多少条（小程序列表是滚动加载，一次 50 条足够） */
const MAX_LIMIT = 50;

/** 允许过滤的状态值（非法值按「不过滤」处理，不报错 —— 列表页更在意能刷出来） */
const STATUS_FILTERS = ["PENDING", "ACCEPTED", "PROCESSING", "DONE", "CANCELLED", "REJECTED"];

export async function GET(req: Request) {
  const guard = miniGuard(req, "mini:service-orders", READ_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const statusRaw = (url.searchParams.get("status") ?? "").trim().toUpperCase();
  const status = STATUS_FILTERS.includes(statusRaw) ? statusRaw : "";
  const limitRaw = int(url.searchParams.get("limit"));
  const limit = limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 30;

  if (!Number.isFinite(limit) || limit <= 0) {
    return fail("BAD_REQUEST", "limit 参数不合法", 400);
  }

  ensureMiniServiceSchema();
  const hotelId = guard.hotelId;

  /*
   * 参数化查询：status 为空时用 `? = ''` 短路条件，避免拼 SQL 字符串。
   * 所有条件都带 hotel_id + mini_user_id，两个都来自 token。
   */
  const rows = all<{
    id: number;
    service_type: string | null;
    status: string | null;
    stay_id: number | null;
    note: string | null;
    operator: string | null;
    created_at: string | null;
    completed_at: string | null;
    room_no: string | null;
  }>(
    `SELECT r.id, r.service_type, r.status, r.stay_id, r.note, r.operator,
            r.created_at, r.completed_at, rm.room_no AS room_no
       FROM mini_service_requests r
       LEFT JOIN stays s ON s.id = r.stay_id AND s.hotel_id = r.hotel_id
       LEFT JOIN rooms rm ON rm.id = s.room_id AND rm.hotel_id = s.hotel_id
      WHERE r.hotel_id = ? AND r.mini_user_id = ?
        AND (? = '' OR r.status = ?)
      ORDER BY r.id DESC
      LIMIT ?`,
    [hotelId, guard.user.id, status, status, limit]
  );

  return ok({
    total: rows.length,
    statusFilter: status,
    limit,
    requests: rows.map((r) => {
      const type = (r.service_type ?? "").trim();
      const st = (r.status ?? "").trim();
      return {
        id: Number(r.id),
        serviceType: type,
        serviceTypeLabel: MINI_SERVICE_TYPE_LABEL[type as MiniServiceType] ?? type,
        status: st,
        statusLabel: MINI_SERVICE_STATUS_LABEL[st] ?? st,
        /* 只有「待处理」能由客人自己取消（与 /cancel 接口的判定同源） */
        cancellable: st === "PENDING",
        stayId: r.stay_id == null ? null : Number(r.stay_id),
        roomNo: (r.room_no ?? "").trim(),
        note: (r.note ?? "").trim(),
        operator: (r.operator ?? "").trim(),
        createdAt: r.created_at ?? "",
        completedAt: r.completed_at ?? null,
      };
    }),
  });
}
