/**
 * 小程序 API 共享工具（整改清单 F12）
 *
 * 这里放三类东西，避免每个 route 各写一份：
 *   1. 统一响应体 `{ ok, data?, error?, code? }`（含 no-store，小程序端永远拿实时数据）
 *   2. 日期 / 手机号 / 请求体这类入参校验
 *   3. 房量计算 loadAvailability —— /api/mini/rooms 与 /api/mini/bookings 共用同一口径
 *
 * 放在 app/api/mini/ 下的下划线文件不会被 Next 当成路由（只有 route.ts 才会）。
 */

import { NextResponse } from "next/server";
import { all } from "@/lib/db";

/** 统一响应体：小程序端只按 ok 判断成败，error 直接展示给用户 */
export type MiniApiBody<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  /** 业务错误码：NOT_CONFIGURED / AUTH_FAILED / NETWORK / BAD_REQUEST / UNAUTHORIZED / ROOM_NOT_ENOUGH ... */
  code?: string;
};

/** 统一响应头：接口数据不进任何 CDN / 浏览器缓存 */
const NO_STORE = { "cache-control": "no-store" } as const;

/** 成功响应（HTTP 200） */
export function ok<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data } satisfies MiniApiBody<T>, { status: 200, headers: NO_STORE });
}

/**
 * 失败响应。
 *
 * HTTP 状态码约定：
 *   · 业务/配置类失败（NOT_CONFIGURED / AUTH_FAILED / NETWORK / ROOM_NOT_ENOUGH）用 200，
 *     这样小程序 wx.request 走 success 回调，能直接把 error 文案弹给用户；
 *   · 参数错误 400、未登录 401 —— 属于调用方 bug 或会话过期，小程序端按「异常」处理。
 */
export function fail(code: string, error: string, status = 200): NextResponse {
  return NextResponse.json({ ok: false, error, code } satisfies MiniApiBody, { status, headers: NO_STORE });
}

/** 业务校验异常：route 里 throw，catch 后转成 fail（不把数据库原始报错抛给小程序） */
export class MiniBizError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MiniBizError";
    this.code = code;
  }
}

/** 读取 JSON 请求体：非法 JSON / 空体返回 null（调用方回 BAD_REQUEST） */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 取字符串字段并 trim（非字符串 → 空串） */
export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 取整数字段：非法 / 越界返回 0（调用方自己判断 0 是否允许） */
export function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** YYYY-MM-DD 格式 + 真实存在（排除 2026-02-30） */
export function isDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 相差天数（b - a），可为 0 或负数 —— 用来判定「离店必须晚于到店」 */
export function dayDiff(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime();
  return Math.round(ms / 86400000);
}

/** 区间内的每一天（含 checkIn，不含 checkOut）；最多 62 天，防畸形入参打爆内存 */
export function eachDay(checkIn: string, checkOut: string): string[] {
  const days: string[] = [];
  const start = new Date(`${checkIn}T00:00:00`);
  const total = dayDiff(checkIn, checkOut);
  for (let i = 0; i < Math.min(total, 62); i += 1) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    const p = (n: number) => String(n).padStart(2, "0");
    days.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return days;
}

/** 中国大陆手机号（与 PC 端建单/会员页的口径一致：1 开头 11 位） */
export function isMobile(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value);
}

/**
 * 手机号打码：138****8000
 *
 * 小程序响应体里**永远不出现完整号码**：接口返回会经微信客户端、用户截图、
 * 前端日志多次落地，完整号码一旦下发就收不回来（整改 P0-11 第 5 点）。
 */
export function maskMobile(mobile: string): string {
  const m = (mobile ?? "").trim();
  if (m.length !== 11) return m ? "****" : "";
  return `${m.slice(0, 3)}****${m.slice(-4)}`;
}

/**
 * 姓名打码：张三 → 张*；欧阳修 → 欧*修
 * 同样只用于「证明身份后的确认展示」，避免响应体成为客人姓名查询接口。
 */
export function maskGuestName(name: string): string {
  const n = (name ?? "").trim();
  if (!n) return "";
  if (n.length === 1) return n;
  if (n.length === 2) return `${n[0]}*`;
  return `${n[0]}*${n.slice(-1)}`;
}

/** 金额两位小数（避免浮点尾差写进库） */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 单次可订晚数上限：小程序只做短住预订，超过一律视为异常入参 */
export const MAX_NIGHTS = 30;

/** 单笔最多订几间（单房型单行，房间太多请走前台 / 团队预订） */
export const MAX_ROOM_COUNT = 5;

/* ========================================================================== */
/*                                  房量计算                                   */
/* ========================================================================== */

/** 一个房型在某日期区间内的可订情况 */
export type RoomTypeAvailability = {
  roomTypeId: number;
  code: string | null;
  name: string;
  bedType: string | null;
  maxOccupancy: number | null;
  /** 门市价（晚） */
  basePrice: number;
  /** 区间内每晚均价（有房价日历就用日历价，缺的日子回落门市价） */
  avgPrice: number;
  /** 区间总价（1 间） */
  totalPrice: number;
  /**
   * 可订房量 = 总数 − 占用 − 维修房（不小于 0）
   *
   * 整改 P1-24：这里**只**回吐可订间数，不再返回 totalRooms / occupiedRooms /
   * maintenanceRooms。原实现把三个原始字段直接发给匿名接口 /api/mini/rooms，
   * 等于公开全店物理房量、出租率和维修房数（竞对、同行按天采集即可推算经营情况）。
   * 客人真正需要的只有「还能订几间」——一个数就够了，内部口径在函数里算完即丢。
   */
  remainingRooms: number;
  /** 是否已售完 */
  soldOut: boolean;
};

export type AvailabilityResult = {
  checkIn: string;
  checkOut: string;
  nights: number;
  /** 每晚均价（按房型分别返回，这里只是汇总给页面做提示） */
  roomTypes: RoomTypeAvailability[];
};

/** rate_calendar 某房型某天的价格（没有配置就返回 null） */
type RateRow = { room_type_id: number; date: string; price: number | null };

/**
 * 计算某日期区间内每个房型的可订房量。
 *
 * 口径（与 PC 端「房型可售预测」/ room-availability.ts 的占用判定一致）：
 *   可订 = 物理房间数 − 该区间在住 − 该区间已排预订 − 维修房
 *
 * 三个占用来源都要查，且不能互相重复计数：
 *   1. stays（在住）：按入住日期 ~ 预计离店日与目标区间求交
 *   2. booking_rooms（预订明细，权威来源）：已转入住的明细 stay_id 非空，
 *      那部分由第 1 条计数，这里必须排除，否则同一间房会被算两次
 *   3. bookings 主单：只为「没有明细的历史单」兜底（迁移会补明细，
 *      但外网老库可能还没跑过迁移），有明细时以明细为准
 *
 * 维修房（rooms.status = 'OOO'）没有日期维度，只能按「整段不可售」扣减；
 * 这是保守做法 —— 宁可少卖一间，也不会出现「卖了维修房让前台无法排房」。
 * 锁房（LOCK）与房型可售预测页保持同一口径，不在此扣减。
 *
 * 区间判定用半开区间：入住日 < 目标离店日 且 离店日 > 目标入住日，
 * 相等不算冲突（12:00 退房、14:00 入住，同一天可以接续）。
 */
export function loadAvailability(hotelId: number, checkIn: string, checkOut: string): AvailabilityResult {
  const nights = dayDiff(checkIn, checkOut);

  /* 1. 房型 + 物理房量 + 维修房 */
  const roomTypes = all<{
    id: number;
    code: string | null;
    name: string;
    bed_type: string | null;
    max_occupancy: number | null;
    base_price: number | null;
    total_rooms: number;
    ooo_rooms: number;
  }>(
    `SELECT rt.id, rt.code, rt.name, rt.bed_type, rt.max_occupancy, COALESCE(rt.base_price, 0) AS base_price,
            (SELECT COUNT(*) FROM rooms r
              WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS total_rooms,
            (SELECT COUNT(*) FROM rooms r
              WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id AND r.status = 'OOO') AS ooo_rooms
       FROM room_types rt
      WHERE rt.hotel_id = ?
      ORDER BY COALESCE(rt.sort, 100), rt.id`,
    [hotelId]
  );

  /* 2. 在住占用（按房间所属房型统计） */
  const stayRows = all<{ room_type_id: number; n: number }>(
    `SELECT r.room_type_id AS room_type_id, COUNT(*) AS n
       FROM stays s
       JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND COALESCE(substr(s.check_in_time, 1, 10), '') < ?
        AND COALESCE(s.expect_check_out, '') > ?
      GROUP BY r.room_type_id`,
    [hotelId, checkOut, checkIn]
  );

  /* 3. 预订明细占用（权威来源；已转入住的不重复计） */
  const detailRows = all<{ room_type_id: number; n: number }>(
    `SELECT br.room_type_id AS room_type_id, COUNT(*) AS n
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
      WHERE br.hotel_id = ?
        AND br.stay_id IS NULL
        AND br.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND br.check_in_date < ? AND br.check_out_date > ?
      GROUP BY br.room_type_id`,
    [hotelId, checkOut, checkIn]
  );

  /* 4. 历史主单兜底（只算没有明细的单，避免与第 3 条重复） */
  const legacyRows = all<{ room_type_id: number; n: number }>(
    `SELECT b.room_type_id AS room_type_id, COALESCE(SUM(COALESCE(b.room_count, 1)), 0) AS n
       FROM bookings b
      WHERE b.hotel_id = ?
        AND b.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND b.check_in_date < ? AND b.check_out_date > ?
        AND NOT EXISTS (SELECT 1 FROM booking_rooms br2 WHERE br2.booking_id = b.id)
      GROUP BY b.room_type_id`,
    [hotelId, checkOut, checkIn]
  );

  /* 5. 区间房价（房价日历按天配置，缺的日子回落门市价） */
  const rateRows =
    nights > 0
      ? all<RateRow>(
          `SELECT room_type_id, date, price FROM rate_calendar
            WHERE hotel_id = ? AND date >= ? AND date < ?`,
          [hotelId, checkIn, checkOut]
        )
      : [];
  const rateMap = new Map<string, number>();
  for (const r of rateRows) {
    const price = Number(r.price);
    if (Number.isFinite(price) && price >= 0) rateMap.set(`${r.room_type_id}|${r.date}`, price);
  }

  const occupiedMap = new Map<number, number>();
  for (const row of [...stayRows, ...detailRows, ...legacyRows]) {
    const typeId = Number(row.room_type_id ?? 0);
    if (!typeId) continue;
    occupiedMap.set(typeId, (occupiedMap.get(typeId) ?? 0) + Number(row.n ?? 0));
  }

  const days = eachDay(checkIn, checkOut);
  const list: RoomTypeAvailability[] = roomTypes.map((rt) => {
    const basePrice = round2(Number(rt.base_price ?? 0));
    let sum = 0;
    for (const day of days) sum += rateMap.get(`${rt.id}|${day}`) ?? basePrice;
    const totalPrice = round2(sum);
    const avgPrice = days.length > 0 ? round2(totalPrice / days.length) : basePrice;

    const totalRooms = Number(rt.total_rooms ?? 0);
    const maintenanceRooms = Number(rt.ooo_rooms ?? 0);
    const occupiedRooms = occupiedMap.get(rt.id) ?? 0;
    const remainingRooms = Math.max(0, totalRooms - occupiedRooms - maintenanceRooms);

    /* 整改 P1-24：totalRooms / occupiedRooms / maintenanceRooms 只在这里参与计算，
       不进入返回值（无登录接口不得外泄全店房量与经营数据）。 */
    return {
      roomTypeId: rt.id,
      code: rt.code ?? null,
      name: rt.name,
      bedType: rt.bed_type ?? null,
      maxOccupancy: rt.max_occupancy == null ? null : Number(rt.max_occupancy),
      basePrice,
      avgPrice,
      totalPrice,
      remainingRooms,
      soldOut: remainingRooms <= 0,
    };
  });

  return { checkIn, checkOut, nights, roomTypes: list };
}

/**
 * 预订号生成：BK + (bookings 表 MAX(id) + 1 + 3000)
 *
 * 与 PC 端 createBookingAction 完全同一口径（前台看到的单号段一致，
 * 不会出现「小程序单号 BK3012、前台单号 BK512」这种两套编号）。
 * 必须在事务内调用，否则并发下两张单可能算出同一个号。
 */
export function nextBookingSeq(maxId: number): string {
  return `BK${Number(maxId) + 1 + 3000}`;
}
