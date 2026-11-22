/**
 * 小程序：续住
 *
 * POST /api/mini/stays/:id/extend   { nights? | newCheckOutDate?, requestId }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、为什么必须查「远期冲突」（整改清单第七节：续住检查远期冲突）
 * ══════════════════════════════════════════════════════════════════════════
 * 续住的本质不是「改一个日期字段」，而是**把这间房在新增日期上再卖一次**。
 * 只看当前房态（OC = 有人住）就放行的话，会出现：
 *   客人 A 住到 11-20 续到 11-25，而这间房 11-22 已经卖给客人 B →
 *   22 号那天双重占用，客人 B 到店才发现没房。
 * PC 端 inhouse 的 extendStayAction 用 findRoomConflicts 修的就是这个坑
 * （整改清单 P0-5），小程序这边逐条对齐：
 *   · 查询区间 = [原预计离店日, 新预计离店日) —— 半开区间，12:00 退房 / 14:00 入住
 *     同一天可以接续，相等不算冲突；
 *   · excludeStayId = 本单，否则「自己占着自己」永远冲突；
 *   · 三个占用来源（在住单 / 预订明细 / 主单镜像）全查，与 PC 端同一份实现。
 *
 * ── 报错文案为什么不带别人的姓名单号 ──
 * findRoomConflicts 的 detail 里带「在住 xxx 张三（日期）」这类信息。
 * 那是**别的客人**的姓名与单号，绝不能出现在小程序响应里
 * （清单第四节：不返回其他客人的订单）。所以这里只回「该房间在 X~Y 已被安排」，
 * 具体是谁、哪张单，留给前台在 PC 端看。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、钱怎么算（服务端唯一口径）
 * ══════════════════════════════════════════════════════════════════════════
 * 每晚房价取入住单上已确认的 stays.rate（不是客户端传的值，也不是当前门市价 ——
 * 客人入住时房价就定了，续住沿用原价是行业惯例），
 * 新增房费 = rate × 新增晚数，逐晚写一条 ROOM 明细（biz_date = 该晚的营业日），
 * 写完整账单一律 recalcFolioBalance（与收银台同一个重算函数）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、留痕与幂等
 * ══════════════════════════════════════════════════════════════════════════
 * 续住成功后写一条 mini_service_requests（service_type = EXTEND, status = DONE），
 * 让「客人自己在小程序续住过」在服务请求台账里可追溯；
 * requestId 就是这条台账的主键来源，(hotel_id, request_id) 唯一索引保证
 * 同一个 requestId 重复提交只会续一次 —— 重放时直接回当前状态 + duplicated: true。
 */

import { get, run, tx } from "@/lib/db";
import { findRoomConflicts } from "@/lib/room-availability";
import { recalcFolioBalance } from "@/lib/folio";
import { bizToday } from "@/lib/biz-date";
import { nowIso } from "@/lib/utils";
import { dayDiff, eachDay, fail, int, isDateStr, MAX_NIGHTS, MiniBizError, miniGuard, ok, readJsonBody, round2, str, isRequestId } from "../../../_shared";
import {
  findMiniServiceRequest,
  insertMiniServiceRequest,
  loadOwnedStay,
  loadStayFolio,
  logMiniOp,
  resolveMiniGuest,
} from "../../../_shared";

export const dynamic = "force-dynamic";

/** 写接口限流：10 次/分钟 */
const WRITE_RATE_LIMIT_PER_MINUTE = 10;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = miniGuard(req, "mini:stay:extend", WRITE_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const stayId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(stayId) || stayId <= 0) {
    return fail("BAD_REQUEST", "入住单号格式不正确", 400);
  }

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  /* request_id 必填：续住会写房费、延长占用，必须能挡住网络重试 / 连点两次 */
  const requestId = str(body.requestId);
  if (!isRequestId(requestId)) {
    return fail("BAD_REQUEST", "缺少有效的 requestId（8-64 位字母/数字/横线），请重新进入页面后再试", 400);
  }

  const hotelId = guard.hotelId;
  const identity = resolveMiniGuest(hotelId, guard.guestId);
  if (!identity) {
    return fail("NOT_BOUND", "尚未绑定会员身份，无法办理续住。请先在小程序里绑定身份，或联系酒店前台。");
  }

  /* ---------- 幂等：同一个 requestId 已经续过就直接回当前状态 ---------- */
  const existing = findMiniServiceRequest(hotelId, requestId);
  if (existing) {
    if (existing.serviceType !== "EXTEND" || existing.stayId !== stayId) {
      return fail("REQUEST_ID_CONFLICT", "该请求号已被其他操作使用，请重新进入页面后再试");
    }
    const replay = loadOwnedStay(hotelId, identity, stayId);
    if (!replay) return fail("STAY_NOT_FOUND", "没有找到这笔在住单，请返回列表刷新后重试", 404);
    return ok({
      stayId: replay.id,
      expectCheckOut: replay.expectCheckOut,
      nights: replay.nights,
      addedNights: 0,
      rate: round2(replay.rate),
      addedAmount: 0,
      duplicated: true,
      message: `该续住请求已处理，当前预计离店日为 ${replay.expectCheckOut}`,
    });
  }

  const stay = loadOwnedStay(hotelId, identity, stayId);
  if (!stay || stay.status !== "INHOUSE") {
    /* 不存在 / 别人的 / 已退房：同一句话 */
    return fail("STAY_NOT_FOUND", "没有找到这笔在住单，请返回列表刷新后重试", 404);
  }
  if (!stay.expectCheckOut || !isDateStr(stay.expectCheckOut)) {
    return fail("EXTEND_FAILED", "该入住单缺少预计离店日，请联系酒店前台办理续住");
  }
  if (stay.expectCheckOut < bizToday(hotelId)) {
    return fail("EXTEND_FAILED", "该入住单已逾期，请联系酒店前台先处理离店日期");
  }
  if (!stay.roomId) {
    return fail("EXTEND_FAILED", "该入住单没有绑定房间，请联系酒店前台办理续住");
  }

  /* ---------- 新增晚数：支持 nights 或 newCheckOutDate 两种入参 ---------- */
  const newCheckOutRaw = str(body.newCheckOutDate);
  let addedNights = 0;
  if (newCheckOutRaw) {
    if (!isDateStr(newCheckOutRaw)) return fail("BAD_REQUEST", "离店日期格式不正确", 400);
    addedNights = dayDiff(stay.expectCheckOut, newCheckOutRaw);
  } else {
    addedNights = int(body.nights) || 1;
  }
  if (addedNights <= 0) {
    return fail("BAD_REQUEST", `新的离店日期必须晚于当前的 ${stay.expectCheckOut}`, 400);
  }
  if (addedNights > MAX_NIGHTS) {
    return fail("BAD_REQUEST", `单次续住最多 ${MAX_NIGHTS} 晚，长期住宿请联系酒店前台`, 400);
  }

  const newExpectOut = addDaysStr(stay.expectCheckOut, addedNights);
  const extraDays = eachDay(stay.expectCheckOut, newExpectOut);

  /* ---------- 房间仍然可用？（房间可能被删 / 被改成维修） ---------- */
  const room = get<{ id: number; room_no: string | null; status: string | null }>(
    `SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ? LIMIT 1`,
    [stay.roomId, hotelId]
  );
  if (!room) return fail("ROOM_NOT_FOUND", "该房间已不在房态里，请联系酒店前台办理续住");
  if (room.status === "OOO" || room.status === "LOCK") {
    return fail("ROOM_UNAVAILABLE", "该房间当前被设为维修/锁房，无法续住，请联系酒店前台换房");
  }

  /*
   * 远期冲突（P0-5 口径）：只查新增的那一段，排除自己。
   * 命中即拒绝 —— 绝不「先续上再说」，那会把冲突留到客人到店当天。
   */
  const conflicts = findRoomConflicts({
    hotelId,
    roomId: stay.roomId,
    checkIn: stay.expectCheckOut,
    checkOut: newExpectOut,
    excludeStayId: stay.id,
  });
  if (conflicts.length > 0) {
    return fail(
      "ROOM_CONFLICT",
      `房间 ${stay.roomNo || room.room_no || ""} 在 ${stay.expectCheckOut} 起已被安排，暂时无法续住到 ${newExpectOut}。` +
        "请联系酒店前台，前台可为您协调换房续住。"
    );
  }

  const rate = round2(stay.rate);
  const addedAmount = round2(rate * addedNights);
  const now = nowIso();
  let requestRowId = 0;

  try {
    requestRowId = tx(() => {
      /* 事务内重查：并发下可能刚被前台退房 / 已被别的续住请求改过日期 */
      const fresh = loadOwnedStay(hotelId, identity, stayId);
      if (!fresh || fresh.status !== "INHOUSE") {
        throw new MiniBizError("STAY_NOT_FOUND", "没有找到这笔在住单，请返回列表刷新后重试");
      }
      if (fresh.expectCheckOut !== stay.expectCheckOut) {
        throw new MiniBizError("STAY_CHANGED", "入住单的离店日期已变化，请返回刷新后再试");
      }
      /* 事务内再查一次冲突（两个终端可能同时续住） */
      const again = findRoomConflicts({
        hotelId,
        roomId: fresh.roomId,
        checkIn: fresh.expectCheckOut,
        checkOut: newExpectOut,
        excludeStayId: fresh.id,
      });
      if (again.length > 0) {
        throw new MiniBizError(
          "ROOM_CONFLICT",
          `房间在 ${fresh.expectCheckOut} 起已被安排，暂时无法续住，请联系酒店前台协调`
        );
      }

      const folio = loadStayFolio(hotelId, fresh.id);
      if (!folio) {
        throw new MiniBizError(
          "FOLIO_NOT_FOUND",
          "该入住单还没有账单，无法自动续住，请联系酒店前台办理"
        );
      }

      run(`UPDATE stays SET nights = ?, expect_check_out = ? WHERE id = ? AND hotel_id = ?`, [
        fresh.nights + addedNights,
        newExpectOut,
        fresh.id,
        hotelId,
      ]);

      /* 逐晚补房费明细：biz_date 取该晚的营业日，报表按 biz_date 归集 */
      for (const day of extraDays) {
        run(
          `INSERT INTO folio_items
             (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [hotelId, folio.id, "ROOM", `房费 ${day}（小程序续住）`, 1, rate, rate, day, now, null]
        );
      }
      /* 账单重算走统一实现（押金不计应收等口径只写一份） */
      recalcFolioBalance(hotelId, folio.id);

      const rowId = insertMiniServiceRequest({
        hotelId,
        miniUserId: guard.user.id,
        guestId: identity.guestId,
        stayId: fresh.id,
        bookingId: fresh.bookingId,
        serviceType: "EXTEND",
        requestId,
        note: `续住 ${addedNights} 晚至 ${newExpectOut}，房费 ${addedAmount}`,
        status: "DONE",
        completedAt: now,
      });

      logMiniOp(
        hotelId,
        "小程序续住",
        `入住单 ${fresh.stayNo} 房间 ${fresh.roomNo || "-"} 续住 ${addedNights} 晚至 ${newExpectOut}，` +
          `房费 +${addedAmount}（${rate}/晚）；requestId=${requestId}`
      );

      return rowId;
    });
  } catch (e) {
    if (e instanceof MiniBizError) {
      return fail(e.code, e.message, e.code === "STAY_NOT_FOUND" ? 404 : 200);
    }
    /*
     * 唯一索引 (hotel_id, request_id) 被撞：极端并发下另一个请求先落库了。
     * 按「已经处理过」返回，不重复补房费（事务已回滚，此处只是提示）。
     */
    const replay = loadOwnedStay(hotelId, identity, stayId);
    if (replay) {
      return ok({
        stayId: replay.id,
        expectCheckOut: replay.expectCheckOut,
        nights: replay.nights,
        addedNights: 0,
        rate: round2(replay.rate),
        addedAmount: 0,
        duplicated: true,
        message: `该续住请求已处理，当前预计离店日为 ${replay.expectCheckOut}`,
      });
    }
    return fail("EXTEND_FAILED", "续住失败，请稍后重试或联系酒店前台");
  }

  return ok({
    stayId: stay.id,
    /** 服务请求台账里的行 id（客人可在「服务请求」里看到这条记录） */
    serviceRequestId: requestRowId,
    requestId,
    expectCheckOut: newExpectOut,
    nights: stay.nights + addedNights,
    addedNights,
    rate,
    addedAmount,
    duplicated: false,
    message: `已续住 ${addedNights} 晚，预计离店日 ${newExpectOut}，新增房费 ${addedAmount} 元`,
  });
}

/**
 * 日期加天数（纯字符串运算，避免时区把 YYYY-MM-DD 算偏一天）。
 * 与 src/lib/utils.ts 的 addDays 同语义，这里就地实现是为了不引额外依赖。
 */
function addDaysStr(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
