/**
 * 小程序「我的订单」公共部分（第九轮清单：订单与在住）
 *
 * 被三个 route 共用，所以单独一个下划线文件（app 目录下只有 route.ts 会成为路由）：
 *   · bookings/[id]/route.ts         订单详情
 *   · bookings/[id]/cancel/route.ts  取消订单（释放 booking_rooms）
 *   · bookings/[id]/modify/route.ts  修改订单（重算价格与库存）
 *
 * 这里只做两件事：
 *   1. **归属校验**：一条订单凭什么是「我的」—— 只认服务端关系，不看任何请求参数；
 *   2. **库存口径**：修改订单时要算「除自己以外还剩几间」，必须与
 *      _shared.ts 的 loadAvailability 完全同源（同一个公式、同样三个占用来源），
 *      否则会出现「详情页显示有房、改单算出来没房」或反过来的两套口径。
 */

import { get } from "@/lib/db";
import { round2 } from "../_shared";

/** 订单状态中文名（与 bookings/route.ts 的 STATUS_LABEL 同一份文案） */
export const MINI_BOOKING_STATUS_LABEL: Record<string, string> = {
  PENDING: "待排房",
  CONFIRMED: "已确认",
  CHECKED_IN: "已入住",
  CHECKED_OUT: "已离店",
  CANCELLED: "已取消",
  NOSHOW: "未到",
};

/** 还能被客人自己取消 / 修改的状态（已入住以后必须走前台） */
export const MINI_BOOKING_EDITABLE_STATUSES = ["PENDING", "CONFIRMED"] as const;

/** 订单行（服务端视图） */
export type MiniBookingRow = {
  id: number;
  bookingNo: string;
  guestId: number | null;
  guestName: string;
  mobile: string;
  status: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  roomCount: number;
  rate: number;
  totalPrice: number;
  deposit: number;
  payType: string;
  breakfast: number;
  remark: string;
  roomTypeId: number;
  roomTypeName: string;
  roomNo: string;
  createdAt: string;
};

/** SQL 原始行 */
type BookingRawRow = {
  id: number;
  booking_no: string | null;
  guest_id: number | null;
  guest_name: string | null;
  mobile: string | null;
  status: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
  nights: number | null;
  room_count: number | null;
  rate: number | null;
  total_price: number | null;
  deposit: number | null;
  pay_type: string | null;
  breakfast: number | null;
  remark: string | null;
  room_type_id: number | null;
  room_type_name: string | null;
  room_id: number | null;
  room_no: string | null;
  created_at: string | null;
};

const BOOKING_SELECT = `
  b.id, b.booking_no, b.guest_id, b.guest_name, b.mobile, b.status,
  b.check_in_date, b.check_out_date, b.nights, b.room_count, b.rate, b.total_price,
  b.deposit, b.pay_type, b.breakfast, b.remark, b.room_type_id, b.room_id, b.created_at,
  rt.name AS room_type_name, r.room_no AS room_no`;

/** 原始行 → 领域对象（金额优先取 total_price，老单没有就按 rate × 晚数 × 间数兜底） */
function toBookingRow(row: BookingRawRow): MiniBookingRow {
  const nights = Number(row.nights ?? 0);
  const roomCount = Number(row.room_count ?? 1) || 1;
  const rate = round2(Number(row.rate ?? 0));
  return {
    id: Number(row.id),
    bookingNo: (row.booking_no ?? "").trim(),
    guestId: row.guest_id == null ? null : Number(row.guest_id),
    guestName: (row.guest_name ?? "").trim(),
    mobile: (row.mobile ?? "").trim(),
    status: (row.status ?? "").trim(),
    checkInDate: (row.check_in_date ?? "").slice(0, 10),
    checkOutDate: (row.check_out_date ?? "").slice(0, 10),
    nights,
    roomCount,
    rate,
    totalPrice: round2(Number(row.total_price ?? round2(rate * nights * roomCount))),
    deposit: round2(Number(row.deposit ?? 0)),
    payType: (row.pay_type ?? "").trim(),
    breakfast: Number(row.breakfast ?? 0),
    remark: (row.remark ?? "").trim(),
    roomTypeId: Number(row.room_type_id ?? 0),
    roomTypeName: (row.room_type_name ?? "").trim(),
    roomNo: (row.room_no ?? "").trim(),
    createdAt: row.created_at ?? "",
  };
}

/**
 * 按「这条订单属于当前小程序用户」的条件取单。取不到返回 null。
 *
 * ── 归属口径（与 GET /api/mini/bookings 完全一致，不新增第二条授权路径）──
 *   1. 已绑定客史 → bookings.guest_id = token 推出的 guest_id
 *      （前台代建、渠道来的单也算「我的」，这才是会员该看到的全量订单）
 *   2. 这个微信用户在小程序下过的单 → mini_program_bookings 关联行
 *
 * **绝不使用** bookings.mobile 与请求参数比对：手机号是下单时自填的自由文本，
 * 拿它做授权就是 P0-12 / P2-17 那个越权漏洞的复现方式。
 *
 * 也不区分「订单不存在」与「订单不属于我」：两种情况都返回 null，
 * 路由统一回 404 BOOKING_NOT_FOUND，不给枚举者任何「这个 id 存在」的预言。
 */
export function loadOwnedBooking(
  hotelId: number,
  miniUserId: number,
  guestId: number | null,
  bookingId: number
): MiniBookingRow | null {
  if (!bookingId) return null;
  const row = get<BookingRawRow>(
    `SELECT ${BOOKING_SELECT}
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id
       LEFT JOIN rooms r ON r.id = b.room_id AND r.hotel_id = b.hotel_id
      WHERE b.id = ? AND b.hotel_id = ?
        AND (
          (? IS NOT NULL AND b.guest_id = ?)
          OR EXISTS (
            SELECT 1 FROM mini_program_bookings mb
             WHERE mb.hotel_id = b.hotel_id
               AND mb.booking_id = b.id
               AND mb.mini_user_id = ?
          )
        )
      LIMIT 1`,
    [bookingId, hotelId, guestId, guestId, miniUserId]
  );
  return row ? toBookingRow(row) : null;
}

/**
 * 某房型在某区间的「可订房量」，但**把指定的这张订单自己排除掉**。
 *
 * ── 为什么不能直接用 loadAvailability ──
 * 改单时这张单的占用还在库里，loadAvailability 会把它算进去，
 * 于是「原样改一次日期」也会提示「房量不足」（自己占着自己的房）。
 *
 * ── 为什么要在本文件重写一份而不是给 loadAvailability 加参数 ──
 * loadAvailability 被 /api/mini/rooms 与 /api/mini/bookings 两个既有接口共用，
 * 本批不许改它们的取数行为；这里逐字复制同一个公式与同样三个占用来源
 * （stays 在住 / booking_rooms 明细（权威）/ bookings 主单兜底），
 * 只是多加一个「不等于本单」的过滤条件。公式改动必须两处同步。
 *
 * 返回不小于 0 的可订间数。
 */
export function remainingRoomsExcludingBooking(
  hotelId: number,
  roomTypeId: number,
  checkIn: string,
  checkOut: string,
  excludeBookingId: number
): number {
  const head = get<{ total_rooms: number; ooo_rooms: number }>(
    `SELECT
       (SELECT COUNT(*) FROM rooms r
         WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS total_rooms,
       (SELECT COUNT(*) FROM rooms r
         WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id AND r.status = 'OOO') AS ooo_rooms
     FROM room_types rt
    WHERE rt.id = ? AND rt.hotel_id = ?`,
    [roomTypeId, hotelId]
  );
  if (!head) return 0;

  /* 1. 在住占用（同一房型的在住单覆盖目标区间）—— 与自己在住的单不可能同时存在（本单还在 PENDING/CONFIRMED） */
  const stayRows = get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM stays s
       JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND r.room_type_id = ?
        AND COALESCE(substr(s.check_in_time, 1, 10), '') < ?
        AND COALESCE(s.expect_check_out, '') > ?`,
    [hotelId, roomTypeId, checkOut, checkIn]
  );

  /* 2. 预订明细占用（权威来源；已转入住的明细不重复计） */
  const detailRows = get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
      WHERE br.hotel_id = ? AND br.room_type_id = ?
        AND br.stay_id IS NULL
        AND br.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND br.check_in_date < ? AND br.check_out_date > ?
        AND b.id <> ?`,
    [hotelId, roomTypeId, checkOut, checkIn, excludeBookingId]
  );

  /* 3. 没有明细的历史主单兜底（有明细时以明细为准，避免同一间房算两次） */
  const legacyRows = get<{ n: number }>(
    `SELECT COALESCE(SUM(COALESCE(b.room_count, 1)), 0) AS n
       FROM bookings b
      WHERE b.hotel_id = ? AND b.room_type_id = ?
        AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND b.check_in_date < ? AND b.check_out_date > ?
        AND b.id <> ?
        AND NOT EXISTS (SELECT 1 FROM booking_rooms br2 WHERE br2.booking_id = b.id)`,
    [hotelId, roomTypeId, checkOut, checkIn, excludeBookingId]
  );

  const totalRooms = Number(head.total_rooms ?? 0);
  const maintenanceRooms = Number(head.ooo_rooms ?? 0);
  const occupied =
    Number(stayRows?.n ?? 0) + Number(detailRows?.n ?? 0) + Number(legacyRows?.n ?? 0);
  return Math.max(0, totalRooms - occupied - maintenanceRooms);
}
