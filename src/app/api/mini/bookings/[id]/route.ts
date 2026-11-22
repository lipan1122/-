/**
 * 小程序：单条订单详情
 *
 * GET /api/mini/bookings/:id   （需要 Bearer token）
 *
 * ── 越权防护（整改清单第四节「不返回其他客人的订单」）──
 * 1. id 只当作「候选」：真正能不能读，由 loadOwnedBooking 的 SQL 决定 ——
 *    条件里同时带 hotel_id 与「属于当前 mini_user / 绑定客史」两种归属关系，
 *    客户端伪造别人的 id 只会拿到 404。
 * 2. 「不存在」与「不是你的」返回**同一个**错误码与文案：否则重复试 id 就能
 *    枚举出「哪些订单号存在」，进而配合订单号规律猜别人的单。
 * 3. 姓名 / 手机号一律打码后下发（maskGuestName / maskMobile）。
 * 4. 不返回任何全店口径数据（房量、出租率、其它订单）：详情里只有这一张单
 *    自己的房型名、自己排到的房号、自己的金额。
 * 5. 金额以服务端为准：total_price 从库里取（老单按 rate × 晚数 × 间数兜底），
 *    不接受也不回显客户端算出来的任何价格。
 */

import { fail, miniGuard, ok, maskGuestName, maskMobile, round2 } from "../../_shared";
import {
  loadOwnedBooking,
  MINI_BOOKING_EDITABLE_STATUSES,
  MINI_BOOKING_STATUS_LABEL,
} from "../_booking-shared";
import { bizToday } from "@/lib/biz-date";

export const dynamic = "force-dynamic";

/** 读接口限流：60 次/分钟（真人滑订单列表远用不到，脚本枚举会被挡住） */
const READ_RATE_LIMIT_PER_MINUTE = 60;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = miniGuard(req, "mini:booking:detail", READ_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const bookingId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return fail("BAD_REQUEST", "订单号格式不正确", 400);
  }

  const booking = loadOwnedBooking(guard.hotelId, guard.user.id, guard.guestId, bookingId);
  if (!booking) {
    /* 不存在 / 不是自己的 / 别家酒店的单：同一句话，不给预言机 */
    return fail("BOOKING_NOT_FOUND", "没有找到这笔订单，请返回列表刷新后重试", 404);
  }

  /*
   * 能不能取消 / 改单由服务端算好下发，前端只负责显示按钮：
   *   · 状态必须是待排房 / 已确认（已入住要走前台，已取消无需再操作）
   *   · 到店日不能早于今天（逾期未到的单子在「今日待办」里由前台处理）
   */
  const today = bizToday(guard.hotelId);
  const editable =
    (MINI_BOOKING_EDITABLE_STATUSES as readonly string[]).includes(booking.status) &&
    booking.checkInDate >= today;

  return ok({
    bookingId: booking.id,
    bookingNo: booking.bookingNo,
    status: booking.status,
    statusLabel: MINI_BOOKING_STATUS_LABEL[booking.status] ?? booking.status,
    /* 客人自己填的姓名手机号：详情页也要打码，避免响应体成为「姓名手机号查询接口」 */
    guestName: maskGuestName(booking.guestName),
    mobile: maskMobile(booking.mobile),
    roomTypeName: booking.roomTypeName || "—",
    roomNo: booking.roomNo || null,
    checkInDate: booking.checkInDate,
    checkOutDate: booking.checkOutDate,
    nights: booking.nights,
    roomCount: booking.roomCount,
    rate: round2(booking.rate),
    totalPrice: round2(booking.totalPrice),
    deposit: round2(booking.deposit),
    payType: booking.payType || "到店付款",
    breakfast: booking.breakfast,
    remark: booking.remark,
    createdAt: booking.createdAt,
    /** 前端按钮开关（服务端口径；真正的校验在 cancel / modify 里再做一次） */
    canCancel: editable,
    canModify: editable,
    /** 不能操作时给一句能直接显示的原因 */
    actionHint: editable
      ? ""
      : booking.status === "CHECKED_IN"
        ? "已入住的订单如需取消或修改，请联系酒店前台"
        : booking.status === "CANCELLED"
          ? "该订单已取消"
          : booking.status === "CHECKED_OUT" || booking.status === "NOSHOW"
            ? "该订单已结束，如需帮助请联系酒店前台"
            : "已过入住日期，如需取消或修改请联系酒店前台",
  });
}
