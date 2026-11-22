/**
 * 小程序：取消订单
 *
 * POST /api/mini/bookings/:id/cancel   { reason?, requestId? }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、为什么「只改主单状态」是错的（第七轮 today-todo 同一处坑）
 * ══════════════════════════════════════════════════════════════════════════
 * 房量占用的权威口径在 booking_rooms 明细上（src/app/api/mini/_shared.ts
 * 的 loadAvailability 第 3 条、src/lib/room-stock.ts 的占房判定都按明细算：
 * `status IN ('PENDING','CONFIRMED') AND 区间覆盖`）。
 * 只把 bookings.status 改成 CANCELLED，明细还挂着 PENDING / 具体房号 ——
 * 客人已经取消了、房量却没回来，前台看「已取消」却排不出这间房。
 * 所以本接口与 PC 端 cancelBookingAction / today-todo 完全同口径：
 *   ① 明细：`room_id = NULL, status = 'CANCELLED'`
 *   ② 主单：`status = 'CANCELLED', room_id = NULL`（清掉房号镜像，房态图立刻释放）
 * 两者在同一个事务里，不会出现「释放了明细但主单没改」的中间态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、幂等（清单第四节「request_id 幂等」）
 * ══════════════════════════════════════════════════════════════════════════
 * 取消是一个**状态机迁移**，天然幂等：第二次请求看到 status 已经是 CANCELLED，
 * 直接返回 `alreadyCancelled: true` + 同样的业务结果，不报错、也不重复释放。
 * 事务内用 `WHERE status IN ('PENDING','CONFIRMED')` 再兜一层：并发两个请求里
 * 只有一个能改到行（changes = 1），另一个按「已取消」返回。
 * requestId 若传入则写进 op_logs，便于把「客户端重试」和「客人真的点了两次」
 * 在日志里分开看。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、什么情况不许取消
 * ══════════════════════════════════════════════════════════════════════════
 *   · 已入住 CHECKED_IN：要退房请走前台（涉及房态、账务与在住单）
 *   · 已离店 / 未到 / 已取消：已结束，无需操作
 *   · 到店日早于今天：「逾期未到」由前台在今日待办里统一处理（可能已排房）
 * 到店付款、未产生任何收款，所以这里不涉及退款；若前台已经收过押金 / 房费，
 * 必须由前台按财务流程退款（本接口只回一句提示，不做任何资金动作）。
 */

import { get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { nowIso } from "@/lib/utils";
import { fail, miniGuard, ok, readJsonBody, str, MiniBizError } from "../../../_shared";
import { loadOwnedBooking, MINI_BOOKING_EDITABLE_STATUSES } from "../../_booking-shared";

export const dynamic = "force-dynamic";

/** 写接口限流：10 次/分钟（真人不会连点十次取消，脚本枚举会被挡住） */
const WRITE_RATE_LIMIT_PER_MINUTE = 10;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = miniGuard(req, "mini:booking:cancel", WRITE_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const bookingId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return fail("BAD_REQUEST", "订单号格式不正确", 400);
  }

  const body = (await readJsonBody(req)) ?? {};
  /* 取消原因只用于前台留痕，不做任何业务判断；超长直接截断 */
  const reason = str(body.reason).slice(0, 200);
  const requestId = str(body.requestId).slice(0, 64);

  const booking = loadOwnedBooking(guard.hotelId, guard.user.id, guard.guestId, bookingId);
  if (!booking) {
    /* 不存在 / 别人的单 / 别家酒店：同一句话（不给 id 存在性预言机） */
    return fail("BOOKING_NOT_FOUND", "没有找到这笔订单，请返回列表刷新后重试", 404);
  }

  /* ---------- 幂等：已经取消了就直接回同样的结果 ---------- */
  if (booking.status === "CANCELLED") {
    return ok({
      bookingId: booking.id,
      bookingNo: booking.bookingNo,
      status: "CANCELLED",
      statusLabel: "已取消",
      alreadyCancelled: true,
      releasedRooms: 0,
      refundNote: "该订单已是取消状态，无需重复操作。若已支付押金，请联系酒店前台退款。",
    });
  }

  /* ---------- 状态与日期前置校验（文案要能直接展示） ---------- */
  if (!(MINI_BOOKING_EDITABLE_STATUSES as readonly string[]).includes(booking.status)) {
    return fail(
      "BOOKING_NOT_EDITABLE",
      booking.status === "CHECKED_IN"
        ? "订单已入住，如需退房请联系酒店前台办理"
        : "该订单已结束，无法在小程序取消，如有疑问请联系酒店前台"
    );
  }
  if (booking.checkInDate < bizToday(guard.hotelId)) {
    return fail("BOOKING_NOT_EDITABLE", "已过入住日期，请联系酒店前台处理该订单");
  }

  let released = 0;
  let alreadyCancelled = false;
  try {
    released = tx(() => {
      /*
       * 事务内重查：并发下另一个请求可能刚刚取消成功。
       * 这里重新按「属于当前用户」的条件取一次，避免在事务里用事务外的快照做决定。
       */
      const fresh = loadOwnedBooking(guard.hotelId, guard.user.id, guard.guestId, bookingId);
      if (!fresh) throw new MiniBizError("BOOKING_NOT_FOUND", "没有找到这笔订单，请返回列表刷新后重试");
      if (fresh.status === "CANCELLED") {
        alreadyCancelled = true;
        return 0;
      }
      if (!(MINI_BOOKING_EDITABLE_STATUSES as readonly string[]).includes(fresh.status)) {
        throw new MiniBizError("BOOKING_NOT_EDITABLE", "该订单状态已变化，请返回列表刷新后重试");
      }

      const now = nowIso();

      /*
       * ① 先释放明细占用（整改关键点）
       *    只放还占着房的状态：CHECKED_IN 的明细属于在住，取消预订不能动它。
       */
      const freed = run(
        `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
          WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
        [guard.hotelId, fresh.id]
      ).changes;

      /* ② 再改主单，并清掉 room_id 镜像（房态图不再显示这间房被占） */
      const changed = run(
        `UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ?
          WHERE id = ? AND hotel_id = ? AND status IN ('PENDING','CONFIRMED')`,
        [now, fresh.id, guard.hotelId]
      ).changes;

      if (changed === 0) {
        /* 事务内又被人改掉了（例如前台刚办理入住）：按状态已变化处理 */
        throw new MiniBizError("BOOKING_NOT_EDITABLE", "该订单状态已变化，请返回列表刷新后重试");
      }

      /* ③ 敏感动作留痕（与业务写入同事务，不会出现「改了单没留痕」） */
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        guard.hotelId,
        "微信小程序",
        "小程序取消订单",
        `${fresh.bookingNo} ${fresh.roomTypeName || "-"} ${fresh.checkInDate}~${fresh.checkOutDate} ` +
          `${fresh.roomCount} 间；释放 ${freed} 间明细占用` +
          (reason ? `；原因：${reason}` : "") +
          (requestId ? `；requestId=${requestId}` : ""),
        now,
      ]);

      return freed;
    });
  } catch (e) {
    if (e instanceof MiniBizError) return fail(e.code, e.message, e.code === "BOOKING_NOT_FOUND" ? 404 : 200);
    /* 任何未预期异常都不把 SQL / 堆栈抛给小程序 */
    return fail("CANCEL_FAILED", "取消失败，请稍后重试或联系酒店前台");
  }

  if (alreadyCancelled) {
    return ok({
      bookingId: booking.id,
      bookingNo: booking.bookingNo,
      status: "CANCELLED",
      statusLabel: "已取消",
      alreadyCancelled: true,
      releasedRooms: 0,
      refundNote: "该订单已是取消状态，无需重复操作。若已支付押金，请联系酒店前台退款。",
    });
  }

  /*
   * 有没有收过钱由前台账务决定，这里只提示「本接口不涉及退款」，
   * 不做任何资金动作（到店付款是默认模式，见清单第五节）。
   */
  const paidCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payments p
        WHERE p.hotel_id = ? AND p.stay_id IN (SELECT id FROM stays WHERE booking_id = ? AND hotel_id = ?)`,
      [guard.hotelId, booking.id, guard.hotelId]
    )?.n ?? 0;

  return ok({
    bookingId: booking.id,
    bookingNo: booking.bookingNo,
    status: "CANCELLED",
    statusLabel: "已取消",
    alreadyCancelled: false,
    releasedRooms: released,
    refundNote:
      Number(paidCount) > 0
        ? "订单已取消。系统检测到该订单已有关联收款，退款请到酒店前台办理。"
        : "订单已取消，无需付款。如已支付押金请联系酒店前台退款。",
  });
}
