/**
 * 小程序：预订下单 / 我的订单（整改清单 F12）
 *
 * POST /api/mini/bookings   下单（需要 Bearer token）
 * GET  /api/mini/bookings   我的订单（需要 Bearer token）
 *
 * ── 与 PC 端 createBookingAction 的口径对齐 ──
 *   · 必填：客人姓名、到店日、离店日；离店必须晚于到店
 *   · 房型必须属于本酒店（不能拿别家的房型 ID 下单）
 *   · 房费总额 = 每晚价 × 晚数 × 间数，一次算清写进 bookings.total_price
 *   · 建单同时落 booking_rooms 明细（每间一行），前台才能排房
 * 差异（小程序端有意简化）：
 *   · 只支持「单房型单行」，多房型 / 团队单请走前台
 *   · 一律 PENDING（小程序不排具体房间，由前台分配后再 CONFIRMED）
 */

import { all, get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { requireMiniToken } from "@/lib/mini-auth";
import { nowIso } from "@/lib/utils";
import {
  dayDiff,
  fail,
  int,
  isDateStr,
  isMobile,
  loadAvailability,
  MAX_NIGHTS,
  MAX_ROOM_COUNT,
  MiniBizError,
  nextBookingSeq,
  ok,
  readJsonBody,
  round2,
  str,
} from "../_shared";

export const dynamic = "force-dynamic";

/** 订单状态中文名（与 utils.BOOKING_STATUS 一致，这里只取文案不打样式） */
const STATUS_LABEL: Record<string, string> = {
  PENDING: "待排房",
  CONFIRMED: "已确认",
  CHECKED_IN: "已入住",
  CHECKED_OUT: "已离店",
  CANCELLED: "已取消",
  NOSHOW: "未到",
};

/* ========================================================================== */
/*                                   下单                                      */
/* ========================================================================== */

export async function POST(req: Request) {
  /* ---------- 1. 鉴权 ---------- */
  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  const roomTypeId = int(body.roomTypeId);
  const checkInDate = str(body.checkInDate);
  const checkOutDate = str(body.checkOutDate);
  const roomCount = int(body.roomCount) || 1;
  const guestName = str(body.guestName);
  const mobile = str(body.mobile);
  const remark = str(body.remark).slice(0, 200);

  /* ---------- 2. 入参校验（文案要能直接展示给客人） ---------- */
  if (!guestName) return fail("BAD_REQUEST", "请填写入住人姓名", 400);
  if (guestName.length > 30) return fail("BAD_REQUEST", "入住人姓名最多 30 个字", 400);
  if (!isDateStr(checkInDate)) return fail("BAD_REQUEST", "请选择到店日期", 400);
  if (!isDateStr(checkOutDate)) return fail("BAD_REQUEST", "请选择离店日期", 400);

  const nights = dayDiff(checkInDate, checkOutDate);
  if (nights <= 0) return fail("BAD_REQUEST", "离店日期必须晚于到店日期", 400);
  if (nights > MAX_NIGHTS) return fail("BAD_REQUEST", `单笔预订最多 ${MAX_NIGHTS} 晚`, 400);
  if (checkInDate < bizToday(user.hotelId)) return fail("BAD_REQUEST", "到店日期不能早于今天", 400);

  if (!isMobile(mobile)) return fail("BAD_REQUEST", "请填写正确的 11 位手机号", 400);
  if (roomCount < 1 || roomCount > MAX_ROOM_COUNT) {
    return fail("BAD_REQUEST", `单笔最多预订 ${MAX_ROOM_COUNT} 间`, 400);
  }
  if (!roomTypeId) return fail("BAD_REQUEST", "请选择房型", 400);

  const hotelId = user.hotelId;

  /* ---------- 3. 房型归属校验（与 PC 端一致：只认本酒店的房型） ---------- */
  const roomType = get<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE id = ? AND hotel_id = ?`,
    [roomTypeId, hotelId]
  );
  if (!roomType) return fail("BAD_REQUEST", "所选房型无效，请刷新后重新选择", 400);

  /* ---------- 4. 房量校验（事务外先查一次，给出明确文案；事务内再查一次防并发） ---------- */
  const pre = loadAvailability(hotelId, checkInDate, checkOutDate);
  const preType = pre.roomTypes.find((t) => t.roomTypeId === roomTypeId);
  if (!preType) return fail("BAD_REQUEST", "所选房型无效，请刷新后重新选择", 400);
  if (preType.remainingRooms < roomCount) {
    return fail(
      "ROOM_NOT_ENOUGH",
      `「${roomType.name}」在该日期区间仅剩 ${preType.remainingRooms} 间，无法预订 ${roomCount} 间`
    );
  }

  /* ---------- 5. 会员身份：已绑客史就取 vip_level / guest_id ---------- */
  let guestId: number | null = user.guestId;
  let memberCard: string | null = null;
  let memberType: string | null = null;
  if (guestId) {
    const guest = get<{ id: number; name: string; mobile: string | null; vip_level: number | null }>(
      `SELECT id, name, mobile, vip_level FROM guests WHERE id = ? AND hotel_id = ?`,
      [guestId, hotelId]
    );
    if (guest) {
      memberCard = (guest.mobile ?? "").trim() || null;
      const vip = Number(guest.vip_level ?? 0);
      memberType = vip > 0 ? `VIP${vip}` : "普通";
    } else {
      // 档案被删除 / 换了酒店：不阻断下单，但不要带着脏 guest_id 落库
      guestId = null;
    }
  }

  /* ---------- 6. 落库（主单 + N 条房间明细） ---------- */
  const now = nowIso();
  const finalRemark = remark ? `微信小程序下单；${remark}` : "微信小程序下单";

  let created: { bookingId: number; bookingNo: string; totalPrice: number };
  try {
    created = tx(() => {
      /*
       * 并发兜底：事务内用同一口径再算一次房量。
       * 两个人同时点「提交」时，事务外的检查都会通过；
       * 事务内再查一次能挡住「最后一间被抢走」，宁可让后一个人看到提示重选，
       * 也不能把同一间房卖两次（前台排房才会有房可排）。
       */
      const fresh = loadAvailability(hotelId, checkInDate, checkOutDate);
      const freshType = fresh.roomTypes.find((t) => t.roomTypeId === roomTypeId);
      if (!freshType || freshType.remainingRooms < roomCount) {
        throw new MiniBizError(
          "ROOM_NOT_ENOUGH",
          `「${roomType.name}」在该日期区间房量不足，请重新选择日期或房型`
        );
      }

      // 订单一律按现行房价日历计价，不接受客户端传价格（防止改价下单）
      const rate = round2(freshType.avgPrice);
      const totalPrice = round2(rate * nights * roomCount);

      const maxId = get<{ max_id: number }>(`SELECT COALESCE(MAX(id), 0) AS max_id FROM bookings`)?.max_id ?? 0;
      const bookingNo = nextBookingSeq(Number(maxId));

      const inserted = run(
        `INSERT INTO bookings (
           hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id,
           channel_id, company_id, check_in_date, check_out_date, nights,
           room_count, guest_count, rate, deposit, total_price, status, remark,
           booking_type, team_name, member_card, member_type, arrival_time,
           rate_code, salesman, package_code, invoice_party, retain_time,
           pay_type, breakfast, channel_order_no, created_by, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          bookingNo,
          guestId,
          guestName,
          mobile,
          roomTypeId,
          null, // room_id：小程序不排具体房间
          null,
          null,
          checkInDate,
          checkOutDate,
          nights,
          roomCount,
          1,
          rate,
          0,
          totalPrice,
          "PENDING",
          finalRemark,
          "guest",
          null,
          memberCard,
          memberType,
          "12:00",
          "门市价",
          null,
          null,
          "酒店",
          null,
          "到店付款",
          0,
          null,
          null, // created_by：小程序客人不是系统用户
          now,
          now,
        ]
      );

      const bookingId = Number(inserted.lastInsertRowid);

      /* 每间一行明细：前台「待排房」列表靠它统计间数，入住时逐条排房 */
      for (let i = 0; i < roomCount; i += 1) {
        run(
          `INSERT INTO booking_rooms
             (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
              check_in_date, check_out_date, stay_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [hotelId, bookingId, roomTypeId, null, guestName, mobile, rate, "PENDING", checkInDate, checkOutDate, null, now]
        );
      }

      /*
       * 整改 P2-17：把这笔单记到「当前微信用户」名下（服务端事务内写，客户端无法伪造）。
       * 旧实现只把手机号写进 mini_program_users.mobile，再按手机号反查订单 ——
       * 手机号是下单时用户自填的自由文本，随手填别人的号就能把别人的订单拉进
       * 「我的订单」（与 P0-12 同类的越权）。现在身份关联只认这张关联表，
       * mobile 列仅作联系信息冗余，**不参与任何授权判断**。
       */
      run(
        `INSERT OR IGNORE INTO mini_program_bookings (hotel_id, mini_user_id, booking_id, created_at)
         VALUES (?,?,?,?)`,
        [hotelId, user.id, bookingId, now]
      );
      run(`UPDATE mini_program_users SET mobile = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
        mobile,
        now,
        user.id,
        hotelId,
      ]);

      /* 操作日志：小程序来的单在前台 op_logs 里能查到，出问题好追溯 */
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        "微信小程序",
        "小程序预订",
        `${bookingNo} ${guestName} ${roomType.name} ${checkInDate}~${checkOutDate} ${roomCount} 间`,
        now,
      ]);

      return { bookingId, bookingNo, totalPrice };
    });
  } catch (e) {
    if (e instanceof MiniBizError) return fail(e.code, e.message);
    return fail("BOOKING_FAILED", "下单失败，请稍后重试或联系酒店前台");
  }

  return ok({
    bookingNo: created.bookingNo,
    bookingId: created.bookingId,
    roomTypeName: roomType.name,
    checkInDate,
    checkOutDate,
    nights,
    roomCount,
    totalPrice: created.totalPrice,
  });
}

/* ========================================================================== */
/*                                 我的订单                                    */
/* ========================================================================== */

export async function GET(req: Request) {
  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  const hotelId = user.hotelId;

  /*
   * 身份口径（整改清单 P0-12 / P2-17）：只认服务端关系，不接受任何请求参数
   *
   *   1. 已绑定客史 → b.guest_id = token 推出的 guestId
   *      （前台代建、渠道来的单都算「我的」，这才是会员该看到的全量订单）
   *   2. 这个微信用户在小程序下过的单 → mini_program_bookings 关联行
   *      （未绑定手机号也能看到自己下的单，P2-17 的诉求）
   *
   * **旧实现已删除**：`b.mobile = mini_program_users.mobile` 的兜底。
   * 它把「用户自填/绑定请求里的手机号」当成授权凭证：只要在绑定或下单时填上
   * 别人的手机号，就能把对方名下的订单拉进自己的「我的订单」（P0-12 的越权形态）。
   * 现在 mobile 列只作联系信息冗余，绝不参与取数条件。
   */
  const guestId = user.guestId;

  const rows = all<{
    id: number;
    booking_no: string;
    guest_name: string | null;
    room_type_name: string | null;
    check_in_date: string;
    check_out_date: string;
    nights: number | null;
    room_count: number | null;
    amount: number | null;
    status: string;
    created_at: string | null;
  }>(
    `SELECT b.id, b.booking_no, b.guest_name,
            rt.name AS room_type_name,
            b.check_in_date, b.check_out_date, b.nights, b.room_count,
            COALESCE(
              b.total_price,
              ROUND(COALESCE(b.rate, 0) * COALESCE(NULLIF(b.nights, 0), 1) * COALESCE(b.room_count, 1), 2)
            ) AS amount,
            b.status, b.created_at
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id
      WHERE b.hotel_id = ?
        AND (
          (? IS NOT NULL AND b.guest_id = ?)
          OR EXISTS (
            SELECT 1 FROM mini_program_bookings mb
             WHERE mb.hotel_id = b.hotel_id
               AND mb.booking_id = b.id
               AND mb.mini_user_id = ?
          )
        )
      ORDER BY b.check_in_date DESC, b.id DESC
      LIMIT 100`,
    [hotelId, guestId, guestId, user.id]
  );

  return ok({
    bound: Boolean(guestId),
    total: rows.length,
    bookings: rows.map((r) => ({
      bookingId: r.id,
      bookingNo: r.booking_no,
      guestName: r.guest_name,
      roomTypeName: r.room_type_name ?? "—",
      checkInDate: r.check_in_date,
      checkOutDate: r.check_out_date,
      nights: Number(r.nights ?? 0),
      roomCount: Number(r.room_count ?? 1),
      amount: round2(Number(r.amount ?? 0)),
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      createdAt: r.created_at,
    })),
  });
}
