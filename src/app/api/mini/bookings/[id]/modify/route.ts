/**
 * 小程序：修改订单（改日期 / 改房数）
 *
 * POST /api/mini/bookings/:id/modify
 *   { checkInDate?, checkOutDate?, roomCount?, requestId? }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、三条必须做到的事
 * ══════════════════════════════════════════════════════════════════════════
 *   1. **价格服务端重算**：客户端传来的任何金额一律忽略。改单后的房价取
 *      loadAvailability 的区间均价（= 房价日历逐日累加，缺的日子回落门市价），
 *      total_price = 均价 × 新晚数 × 新间数 —— 与下单接口完全同一个公式，
 *      不会出现「改单便宜了 30 块」这种两套计价。
 *   2. **库存重新校验**：改日期 / 加间数等于重新卖一次房，必须按新区间查房量。
 *      这里的口径与下单一致，但要**排除这张单自己**（否则「原样改一次日期」
 *      会被自己占的房挡住）。remainingRoomsExcludingBooking 逐字复用同一公式。
 *      事务内再查一次兜住并发（两个人同时改/同时下单抢最后一间）。
 *   3. **booking_rooms 明细跟着改**：房量占用的权威来源是明细（见 cancel 路由的
 *      说明）。只改主单会让明细停在旧区间 —— 老区间仍算占用（房卖不出去），
 *      新区间却没人占（超卖）。所以明细的日期、间数、房价必须一起改。
 *
 * ── 改了日期为什么要把房号释放掉 ──
 * 原来排到 302 房，日期一改，302 在新区间未必空着（可能已经卖给别人）。
 * 与 PC 端 today-todo「逾期转今日预订」同一处理：明细 room_id 置空、状态回
 * PENDING，主单 room_id 也置空，由前台按新日期重新排房。只改间数（日期没变）
 * 时保留已排房号，多出来的间数追加未排房的明细行。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、幂等
 * ══════════════════════════════════════════════════════════════════════════
 * 改单是「把订单设成某个绝对目标状态」（不是增量加减）：同一个请求重放两次，
 * 结果完全一样（日期、间数、价格、明细行数都收敛到同一组值），
 * 因此不需要额外的幂等表；requestId 写进 op_logs，方便区分「客户端重试」与
 * 「客人改了两回」。
 */

import { all, get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { nowIso } from "@/lib/utils";
import {
  dayDiff,
  fail,
  int,
  isDateStr,
  loadAvailability,
  MAX_NIGHTS,
  MAX_ROOM_COUNT,
  MiniBizError,
  miniGuard,
  ok,
  readJsonBody,
  round2,
  str,
} from "../../../_shared";
import {
  loadOwnedBooking,
  MINI_BOOKING_EDITABLE_STATUSES,
  MINI_BOOKING_STATUS_LABEL,
  remainingRoomsExcludingBooking,
} from "../../_booking-shared";

export const dynamic = "force-dynamic";

/** 写接口限流：10 次/分钟 */
const WRITE_RATE_LIMIT_PER_MINUTE = 10;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = miniGuard(req, "mini:booking:modify", WRITE_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const bookingId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return fail("BAD_REQUEST", "订单号格式不正确", 400);
  }

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);
  const requestId = str(body.requestId).slice(0, 64);

  const booking = loadOwnedBooking(guard.hotelId, guard.user.id, guard.guestId, bookingId);
  if (!booking) {
    return fail("BOOKING_NOT_FOUND", "没有找到这笔订单，请返回列表刷新后重试", 404);
  }
  if (!(MINI_BOOKING_EDITABLE_STATUSES as readonly string[]).includes(booking.status)) {
    return fail(
      "BOOKING_NOT_EDITABLE",
      booking.status === "CHECKED_IN"
        ? "订单已入住，如需修改请联系酒店前台"
        : "该订单已结束，无法修改，如有疑问请联系酒店前台"
    );
  }
  if (booking.checkInDate < bizToday(guard.hotelId)) {
    return fail("BOOKING_NOT_EDITABLE", "已过入住日期，请联系酒店前台处理该订单");
  }
  /*
   * 没有房型的订单（极老的数据 / 人工补录）无法重算价格与房量：
   * 直接拒绝并给出去前台的指引，而不是算出一个 0 元订单或者「房量不足」的假错误。
   */
  if (!booking.roomTypeId) {
    return fail("BOOKING_NOT_EDITABLE", "该订单缺少房型信息，修改请到酒店前台办理");
  }

  /* ---------- 入参：没传的字段沿用原值（只改日期或只改间数都支持） ---------- */
  const checkInDate = str(body.checkInDate) || booking.checkInDate;
  const checkOutDate = str(body.checkOutDate) || booking.checkOutDate;
  const roomCount = body.roomCount === undefined || body.roomCount === null
    ? booking.roomCount
    : int(body.roomCount);

  if (!isDateStr(checkInDate)) return fail("BAD_REQUEST", "请选择正确的到店日期", 400);
  if (!isDateStr(checkOutDate)) return fail("BAD_REQUEST", "请选择正确的离店日期", 400);

  const nights = dayDiff(checkInDate, checkOutDate);
  if (nights <= 0) return fail("BAD_REQUEST", "离店日期必须晚于到店日期", 400);
  if (nights > MAX_NIGHTS) return fail("BAD_REQUEST", `单笔预订最多 ${MAX_NIGHTS} 晚`, 400);
  if (checkInDate < bizToday(guard.hotelId)) {
    return fail("BAD_REQUEST", "到店日期不能早于今天", 400);
  }
  if (roomCount < 1 || roomCount > MAX_ROOM_COUNT) {
    return fail("BAD_REQUEST", `单笔最多预订 ${MAX_ROOM_COUNT} 间`, 400);
  }

  const datesChanged = checkInDate !== booking.checkInDate || checkOutDate !== booking.checkOutDate;

  /* ---------- 事务外先算一次，给出明确文案（事务内再算一次防并发） ---------- */
  const pricePreview = quoteForNewRange(
    guard.hotelId,
    booking.id,
    booking.roomTypeId,
    checkInDate,
    checkOutDate,
    nights,
    roomCount
  );
  if (pricePreview.remaining < roomCount) {
    return fail(
      "ROOM_NOT_ENOUGH",
      `「${booking.roomTypeName || "该房型"}」在 ${checkInDate}~${checkOutDate} 仅剩 ${pricePreview.remaining} 间，无法保留 ${roomCount} 间`
    );
  }

  let next = {
    checkInDate,
    checkOutDate,
    nights,
    roomCount,
    rate: pricePreview.rate,
    totalPrice: pricePreview.totalPrice,
    status: booking.status,
  };
  let releasedAssignments = 0;
  let detailRows = 0;

  try {
    const applied = tx(() => {
      /* 事务内重查状态（并发：可能刚被取消 / 刚被前台入住） */
      const fresh = loadOwnedBooking(guard.hotelId, guard.user.id, guard.guestId, bookingId);
      if (!fresh) throw new MiniBizError("BOOKING_NOT_FOUND", "没有找到这笔订单，请返回列表刷新后重试");
      if (!(MINI_BOOKING_EDITABLE_STATUSES as readonly string[]).includes(fresh.status)) {
        throw new MiniBizError("BOOKING_NOT_EDITABLE", "该订单状态已变化，请返回列表刷新后重试");
      }

      /* 事务内用新区间再查一次房量（排除自己） */
      const quote = quoteForNewRange(
        guard.hotelId,
        fresh.id,
        fresh.roomTypeId,
        checkInDate,
        checkOutDate,
        nights,
        roomCount
      );
      if (quote.remaining < roomCount) {
        throw new MiniBizError(
          "ROOM_NOT_ENOUGH",
          `「${fresh.roomTypeName || "该房型"}」在该日期区间房量不足，请重新选择日期或间数`
        );
      }

      const now = nowIso();
      /*
       * 状态：改了日期就得重新排房（原来的房号在新日期上未必空着），
       * 所以退回 PENDING 并清房号镜像；只改间数时保持原状态、保留已排房号。
       */
      const nextStatus = datesChanged && fresh.status === "CONFIRMED" ? "PENDING" : fresh.status;

      if (datesChanged) {
        run(
          `UPDATE bookings
              SET check_in_date = ?, check_out_date = ?, nights = ?, room_count = ?,
                  rate = ?, total_price = ?, status = ?, room_id = NULL, updated_at = ?
            WHERE id = ? AND hotel_id = ?`,
          [
            checkInDate,
            checkOutDate,
            nights,
            roomCount,
            quote.rate,
            quote.totalPrice,
            nextStatus,
            now,
            fresh.id,
            guard.hotelId,
          ]
        );
      } else {
        run(
          `UPDATE bookings
              SET nights = ?, room_count = ?, rate = ?, total_price = ?, status = ?, updated_at = ?
            WHERE id = ? AND hotel_id = ?`,
          [nights, roomCount, quote.rate, quote.totalPrice, nextStatus, now, fresh.id, guard.hotelId]
        );
      }

      /* ---------- 明细同步（房量的权威来源） ---------- */
      const existing = all<{ id: number; room_id: number | null }>(
        `SELECT id, room_id FROM booking_rooms
          WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')
          ORDER BY id`,
        [guard.hotelId, fresh.id]
      );

      let freedAssigned = 0;
      if (datesChanged) {
        /* 日期变了：全部释放房号回待排房，前台按新日期重排 */
        const before = existing.filter((r) => r.room_id != null).length;
        run(
          `UPDATE booking_rooms
              SET check_in_date = ?, check_out_date = ?, rate = ?,
                  room_id = NULL, status = 'PENDING'
            WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
          [checkInDate, checkOutDate, quote.rate, guard.hotelId, fresh.id]
        );
        freedAssigned = before;
      } else {
        /* 日期没变：只同步房价（间数增减在下面处理，已排的房号保留） */
        run(
          `UPDATE booking_rooms SET rate = ?
            WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
          [quote.rate, guard.hotelId, fresh.id]
        );
      }

      /* 间数：多了补未排房明细，少了先删未排房的（没有未排房的就删最后几行） */
      const diff = roomCount - existing.length;
      if (diff > 0) {
        for (let i = 0; i < diff; i += 1) {
          run(
            `INSERT INTO booking_rooms
               (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
                check_in_date, check_out_date, stay_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              guard.hotelId,
              fresh.id,
              fresh.roomTypeId,
              null,
              fresh.guestName,
              fresh.mobile,
              quote.rate,
              "PENDING",
              checkInDate,
              checkOutDate,
              null,
              now,
            ]
          );
        }
      } else if (diff < 0) {
        const surplus = Math.abs(diff);
        const unassigned = existing.filter((r) => r.room_id == null).map((r) => r.id);
        const assigned = existing.filter((r) => r.room_id != null).map((r) => r.id);
        /* 先删未排房的明细，不够再删已排房的（从后往前），删掉即释放占用 */
        const doomed = [...unassigned, ...assigned].slice(0, surplus);
        if (doomed.length > 0) {
          const marks = doomed.map(() => "?").join(",");
          run(
            `DELETE FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND id IN (${marks})`,
            [guard.hotelId, fresh.id, ...doomed]
          );
        }
      }

      const finalDetails =
        get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
          [guard.hotelId, fresh.id]
        )?.n ?? 0;

      /* 敏感动作留痕：日期 / 间数 / 金额都是客人可核对的业务事实 */
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        guard.hotelId,
        "微信小程序",
        "小程序修改订单",
        `${fresh.bookingNo} ${fresh.roomTypeName || "-"} ` +
          `${fresh.checkInDate}~${fresh.checkOutDate} ${fresh.roomCount} 间 → ` +
          `${checkInDate}~${checkOutDate} ${roomCount} 间；` +
          `房费 ${fresh.totalPrice} → ${quote.totalPrice}` +
          (freedAssigned > 0 ? `；释放已排房号 ${freedAssigned} 间待重排` : "") +
          (requestId ? `；requestId=${requestId}` : ""),
        now,
      ]);

      return {
        status: nextStatus,
        releasedAssignments: freedAssigned,
        detailRows: Number(finalDetails),
        rate: quote.rate,
        totalPrice: quote.totalPrice,
      };
    });

    next = { ...next, status: applied.status, rate: applied.rate, totalPrice: applied.totalPrice };
    releasedAssignments = applied.releasedAssignments;
    detailRows = applied.detailRows;
  } catch (e) {
    if (e instanceof MiniBizError) {
      return fail(e.code, e.message, e.code === "BOOKING_NOT_FOUND" ? 404 : 200);
    }
    return fail("MODIFY_FAILED", "修改订单失败，请稍后重试或联系酒店前台");
  }

  return ok({
    bookingId: booking.id,
    bookingNo: booking.bookingNo,
    checkInDate: next.checkInDate,
    checkOutDate: next.checkOutDate,
    nights: next.nights,
    roomCount: next.roomCount,
    rate: round2(next.rate),
    totalPrice: round2(next.totalPrice),
    status: next.status,
    statusLabel: MINI_BOOKING_STATUS_LABEL[next.status] ?? next.status,
    /** 改日期后需要前台按新日期重排房，前端可以据此提示客人 */
    requiresReassign: releasedAssignments > 0 && next.status === "PENDING",
    releasedAssignments,
    detailRows,
    payType: booking.payType || "到店付款",
  });
}

/**
 * 改单后的报价 + 房量（服务端唯一口径）。
 *
 * rate 取 loadAvailability 的**区间均价**（房价日历逐日累加 / 晚数，缺的日子回落门市价），
 * totalPrice = 均价 × 晚数 × 间数 —— 与下单接口 /api/mini/bookings 的算法逐字相同，
 * 保证「下单时看到的价」与「改单后算出的价」不会有第二套公式。
 *
 * remaining 用 remainingRoomsExcludingBooking（同公式，但排除本单自身占用：
 * excludeBookingId 就是这张单自己的 id，否则「原样改一次日期」会被自己挡住）。
 */
function quoteForNewRange(
  hotelId: number,
  excludeBookingId: number,
  roomTypeId: number,
  checkInDate: string,
  checkOutDate: string,
  nights: number,
  roomCount: number
): { rate: number; totalPrice: number; remaining: number } {
  const availability = loadAvailability(hotelId, checkInDate, checkOutDate);
  const type = availability.roomTypes.find((t) => t.roomTypeId === roomTypeId);
  const rate = round2(type?.avgPrice ?? 0);
  const totalPrice = round2(rate * nights * roomCount);
  const remaining = remainingRoomsExcludingBooking(
    hotelId,
    roomTypeId,
    checkInDate,
    checkOutDate,
    excludeBookingId
  );
  return { rate, totalPrice, remaining };
}
