/**
 * 小程序：房型详情（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * GET /api/mini/room-types/:id
 *     可选 query：?from=YYYY-MM-DD&days=30 价格日历起点与天数（默认今天 / 30 天，最多 90）
 *     可选 query：?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD 附带可订房量
 *
 * 返回：图片 / 床型 / 面积 / 可住人数 / 早餐说明 / 房间设施 / 取消政策 /
 *       入住与离店时间 / 押金说明 / 每晚价格日历 / 酒店电话。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、clean 原则：数据库没有的字段就返回 null，绝不写死假图假设施
 * ══════════════════════════════════════════════════════════════════════════
 * 整改清单第 81 行：**「如果数据库没有图片和设施字段，增加明确的数据表或配置字段，
 * 不要在页面写死虚假信息」**。
 *
 * room_types 原来只有 code / name / bed_type / area / max_occupancy / base_price / sort，
 * 于是本批给 room_types 补了 7 列（同步 scripts/{schema-full.sql,init-db.mjs,
 * migrate-all.mjs,schema-fingerprint.json} 与运行时 ensure）：
 *
 *   images              TEXT  图片 URL 的 JSON 数组（['https://.../1.jpg']）
 *   facilities          TEXT  设施的 JSON 数组（['免费WiFi','独立卫浴']）
 *   breakfast_note      TEXT  早餐说明（'含双早（自助）' / '不含早餐'）
 *   cancellation_policy TEXT  取消政策（'入住前 1 天 18:00 前可免费取消'）
 *   check_in_time       TEXT  该房型可入住时间（HH:MM，空 = 用酒店默认）
 *   check_out_time      TEXT  该房型离店时间（HH:MM，空 = 用酒店默认）
 *   deposit_note        TEXT  押金说明（'押金 300 元，退房时原路退回'）
 *
 * **老库 / 没配过数据的房型，这些列是 NULL** —— 响应里对应字段返回 null（列表类
 * 字段返回空数组），并且在 `configured` 里逐项标记 false，同时 `unconfigured`
 * 列出人话说明。小程序页面据此显示「该房型暂未提供图片 / 设施信息，以酒店实际为准」，
 * 而不是加载一张从网上抄来的假房型照片（那属于虚假宣传，客人到店会投诉）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、价格日历：房价来自 rate_calendar，缺的日子回落门市价并在 source 标出来
 * ══════════════════════════════════════════════════════════════════════════
 * 每晚价格 = COALESCE(rate_calendar.price, room_types.base_price)，与
 * _shared.ts 的 loadAvailability 完全同一口径（两处算出来的区间总价必须能对上）。
 * **不返回 rate_calendar.allotment**：那是当天分配房量，属于库存经营数据，
 * 匿名接口下发给同行等于每天公开一次全店可售房量（清单第四节）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、可订房量
 * ══════════════════════════════════════════════════════════════════════════
 * 传了 checkIn / checkOut 才计算，复用 loadAvailability（与 /api/mini/rooms 同一函数），
 * 只回吐 remainingRooms / soldOut —— 不返回物理房量、占用数、维修房数。
 */

import { all, get } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { resolveMiniHotelId } from "@/lib/mini-config";
import { rateLimit } from "@/lib/mini-rate-limit";
import { dayDiff, fail, isDateStr, loadAvailability, MAX_NIGHTS, ok, round2 } from "../../_shared";

export const dynamic = "force-dynamic";

/** 公开接口限流：与 /rooms、/hotel 同一量级 */
const ROOM_TYPE_RATE_LIMIT_PER_MINUTE = 120;

/** 价格日历默认天数 / 上限（30 天足够页面横向滚动，90 天封顶防打爆查询） */
const DEFAULT_CALENDAR_DAYS = 30;
const MAX_CALENDAR_DAYS = 90;

/** Next 16 的动态段上下文：params 是 Promise，必须 await 后再用 */
type RouteContext = { params: Promise<{ id: string }> };

type RoomTypeRow = {
  id: number;
  code: string | null;
  name: string;
  bed_type: string | null;
  area: number | null;
  max_occupancy: number | null;
  base_price: number | null;
  images: string | null;
  facilities: string | null;
  breakfast_note: string | null;
  cancellation_policy: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  deposit_note: string | null;
};

/** 列存在性缓存：老库（还没跑迁移）里没有新列时自动降级，不让接口 500 */
let newColumnsReady: boolean | null = null;

function hasNewColumns(): boolean {
  if (newColumnsReady !== null) return newColumnsReady;
  try {
    const cols = all<{ name: string }>(`PRAGMA table_info(room_types)`).map((c) => String(c.name));
    newColumnsReady = cols.includes("images") && cols.includes("facilities") && cols.includes("breakfast_note");
  } catch {
    newColumnsReady = false;
  }
  return newColumnsReady;
}

/** 去空 + 截断；空返回 null */
function orNull(value: unknown, max = 500): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * 把库里的文本解析成字符串数组。
 *
 * 允许两种写法（管理员手填时不一定写规范 JSON）：
 *   · JSON 数组：["免费WiFi","独立卫浴"]
 *   · 分隔符列表：免费WiFi、独立卫浴 / 免费WiFi,独立卫浴
 * 单值非法 / 超量一律丢弃并截断，**绝不抛错**（脏数据不能让详情页 500）。
 */
function parseStringList(raw: string | null, maxItems: number, maxLen: number): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let items: unknown[] = [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [];
    }
  }
  if (items.length === 0) {
    items = text.split(/[,，、|;；\n]/);
  }
  const out: string[] = [];
  for (const item of items) {
    const s = typeof item === "string" ? item.trim() : "";
    if (!s) continue;
    out.push(s.length > maxLen ? s.slice(0, maxLen) : s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 图片白名单：只接受 http(s) 绝对地址与站内 /uploads/ 相对路径。
 *
 * 为什么必须过滤：图片 URL 由管理员在数据里录入，但小程序端拿到的任何字符串
 * 都可能被渲染成 <image src>。放行 javascript: / data: 之类协议在部分容器里
 * 会被当脚本执行（XSS 面），过滤是最省事的一刀。
 */
function parseImages(raw: string | null): string[] {
  return parseStringList(raw, 30, 500).filter((url) => /^(https?:\/\/|\/uploads\/|\/images\/)/i.test(url));
}

/** 读 settings 的若干个 key（表不存在时返回空 Map） */
function readSettings(hotelId: number, keys: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (keys.length === 0) return map;
  try {
    const rows = all<{ key: string; value: string | null }>(
      `SELECT key, value FROM settings
        WHERE hotel_id = ? AND key IN (${keys.map(() => "?").join(",")})
        ORDER BY id`,
      [hotelId, ...keys]
    );
    for (const row of rows) if (!map.has(row.key)) map.set(row.key, (row.value ?? "").trim());
  } catch {
    /* settings 表缺失：全部当未配置 */
  }
  return map;
}

/** HH:MM 合法性（脏值回落酒店默认） */
function isHhMm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function GET(req: Request, ctx: RouteContext) {
  /* ---------- 0. 限流 ---------- */
  const limited = rateLimit(req, { scope: "mini:room-type", limit: ROOM_TYPE_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "查询过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  /* ---------- 1. 房型 id：只认纯数字，避免 "1abc" 被 parseInt 吃掉后缀 ---------- */
  const { id: rawId } = await ctx.params;
  const idText = String(rawId ?? "").trim();
  if (!/^\d{1,9}$/.test(idText)) {
    return fail("BAD_REQUEST", "房型参数不正确", 400);
  }
  const roomTypeId = Number(idText);

  const hotelId = resolveMiniHotelId();

  /* ---------- 2. 房型必须属于本店（拿到别家的 id 一律「不存在」） ---------- */
  const baseSelect = hasNewColumns()
    ? `SELECT id, code, name, bed_type, area, max_occupancy, base_price,
              images, facilities, breakfast_note, cancellation_policy,
              check_in_time, check_out_time, deposit_note`
    : `SELECT id, code, name, bed_type, area, max_occupancy, base_price,
              NULL AS images, NULL AS facilities, NULL AS breakfast_note,
              NULL AS cancellation_policy, NULL AS check_in_time,
              NULL AS check_out_time, NULL AS deposit_note`;
  const roomType = get<RoomTypeRow>(`${baseSelect} FROM room_types WHERE id = ? AND hotel_id = ?`, [
    roomTypeId,
    hotelId,
  ]);
  if (!roomType) {
    /* 业务类错误用 200：小程序 wx.request 走 success 回调，页面直接弹中文提示 */
    return fail("NOT_FOUND", "该房型已下架或不存在，请返回重新选择");
  }

  /* ---------- 3. 价格日历 ---------- */
  const url = new URL(req.url);
  const today = bizToday(hotelId);
  const fromRaw = (url.searchParams.get("from") ?? "").trim();
  const from = isDateStr(fromRaw) ? fromRaw : today;
  const daysRaw = Number.parseInt((url.searchParams.get("days") ?? "").trim(), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, MAX_CALENDAR_DAYS) : DEFAULT_CALENDAR_DAYS;

  /* 截止日（不含）：from + days，日历按半开区间取数 */
  const endDate = (() => {
    const [y, m, d] = from.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  })();

  const basePrice = round2(Number(roomType.base_price ?? 0));
  /*
   * rate_calendar 由 scripts/migrate-all.mjs 建表（历史上 /settings 也懒建过一份）。
   * 极老库可能整张表都不存在：那时房价日历全部回落门市价，不要让详情页 500
   * —— 「没有房价日历」是正常业务状态，不是错误。
   */
  let rateRows: { date: string; price: number | null }[] = [];
  try {
    rateRows = all<{ date: string; price: number | null }>(
      `SELECT date, price FROM rate_calendar
        WHERE hotel_id = ? AND room_type_id = ? AND date >= ? AND date < ?`,
      [hotelId, roomTypeId, from, endDate]
    );
  } catch {
    rateRows = [];
  }
  const rateMap = new Map<string, number>();
  for (const row of rateRows) {
    const price = Number(row.price);
    if (Number.isFinite(price) && price >= 0) rateMap.set(String(row.date), round2(price));
  }

  const priceCalendar: { date: string; price: number; source: "CALENDAR" | "BASE" }[] = [];
  {
    const [y, m, d] = from.split("-").map(Number);
    const cursor = new Date(y, m - 1, d);
    const p = (n: number) => String(n).padStart(2, "0");
    for (let i = 0; i < days; i += 1) {
      const key = `${cursor.getFullYear()}-${p(cursor.getMonth() + 1)}-${p(cursor.getDate())}`;
      const calendarPrice = rateMap.get(key);
      priceCalendar.push(
        calendarPrice === undefined
          ? { date: key, price: basePrice, source: "BASE" }
          : { date: key, price: calendarPrice, source: "CALENDAR" }
      );
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  /* ---------- 4. 入离时间 / 押金：房型优先，其次酒店默认 ---------- */
  const settings = readSettings(hotelId, ["check_in_time", "check_out_time", "hotel_deposit_note"]);
  const hotelCheckIn = isHhMm(settings.get("check_in_time") ?? "") ? (settings.get("check_in_time") as string) : "14:00";
  const hotelCheckOut = isHhMm(settings.get("check_out_time") ?? "") ? (settings.get("check_out_time") as string) : "12:00";
  const roomCheckIn = orNull(roomType.check_in_time, 5);
  const roomCheckOut = orNull(roomType.check_out_time, 5);
  const checkInTime = roomCheckIn && isHhMm(roomCheckIn) ? roomCheckIn : hotelCheckIn;
  const checkOutTime = roomCheckOut && isHhMm(roomCheckOut) ? roomCheckOut : hotelCheckOut;

  /* ---------- 5. 可订房量（只有在客人选了日期时才算） ---------- */
  const checkIn = (url.searchParams.get("checkIn") ?? "").trim();
  const checkOut = (url.searchParams.get("checkOut") ?? "").trim();
  let availability: {
    checkIn: string;
    checkOut: string;
    nights: number;
    remainingRooms: number;
    soldOut: boolean;
  } | null = null;

  if (checkIn || checkOut) {
    if (!isDateStr(checkIn) || !isDateStr(checkOut)) {
      return fail("BAD_REQUEST", "请传入合法的 checkIn / checkOut（格式 YYYY-MM-DD）", 400);
    }
    const nights = dayDiff(checkIn, checkOut);
    if (nights <= 0) return fail("BAD_REQUEST", "离店日期必须晚于入住日期", 400);
    if (nights > MAX_NIGHTS) return fail("BAD_REQUEST", `单次最多查询 ${MAX_NIGHTS} 晚`, 400);

    const result = loadAvailability(hotelId, checkIn, checkOut);
    const type = result.roomTypes.find((t) => t.roomTypeId === roomTypeId);
    availability = {
      checkIn,
      checkOut,
      nights,
      /* 只给「还能订几间」，物理房量 / 占用数 / 维修房数一律不出这个函数 */
      remainingRooms: type ? type.remainingRooms : 0,
      soldOut: type ? type.soldOut : true,
    };
  }

  /* ---------- 6. 酒店联系方式（详情页「拨打电话」用，不含经营数据） ---------- */
  const hotel = get<{ name: string; phone: string | null; address: string | null }>(
    `SELECT name, phone, address FROM hotels WHERE id = ?`,
    [hotelId]
  );

  /* ---------- 7. 未配置字段逐项列明（清单第 81 行） ---------- */
  const images = parseImages(roomType.images);
  const facilities = parseStringList(roomType.facilities, 40, 40);
  const breakfastNote = orNull(roomType.breakfast_note, 300);
  const cancellationPolicy = orNull(roomType.cancellation_policy, 500);
  const depositNote = orNull(roomType.deposit_note, 300) ?? orNull(settings.get("hotel_deposit_note"), 300);

  const configured = {
    images: images.length > 0,
    facilities: facilities.length > 0,
    breakfast: breakfastNote !== null,
    cancellationPolicy: cancellationPolicy !== null,
    depositNote: depositNote !== null,
  };
  const unconfigured: string[] = [];
  if (!configured.images) unconfigured.push("房型图片（room_types.images 未配置）");
  if (!configured.facilities) unconfigured.push("房间设施（room_types.facilities 未配置）");
  if (!configured.breakfast) unconfigured.push("早餐说明（room_types.breakfast_note 未配置）");
  if (!configured.cancellationPolicy) unconfigured.push("取消政策（room_types.cancellation_policy 未配置）");
  if (!configured.depositNote) unconfigured.push("押金说明（room_types.deposit_note / settings.hotel_deposit_note 未配置）");

  return ok({
    roomTypeId: roomType.id,
    code: orNull(roomType.code, 40),
    name: roomType.name,

    /* 基础属性：确实没有的（面积 / 可住人数 / 床型）就是 null，不做估算 */
    bedType: orNull(roomType.bed_type, 60),
    area: roomType.area == null ? null : round2(Number(roomType.area)),
    maxOccupancy: roomType.max_occupancy == null ? null : Math.trunc(Number(roomType.max_occupancy)),

    /* 价格（元/晚）：门市价 + 日历价 */
    basePrice,
    currency: "CNY",
    priceCalendar,
    priceCalendarFrom: from,
    priceCalendarDays: days,
    /** 日历里有几天用了门市价兜底（没配房价日历），前端可提示「价格以到店为准」 */
    priceCalendarBaseDays: priceCalendar.filter((d) => d.source === "BASE").length,

    /* 展示型字段：没配置 = null / 空数组 + configured 标记 */
    images,
    facilities,
    breakfastNote,
    cancellationPolicy,
    depositNote,

    /* 入离时间：房型没配就用酒店默认，来源显式标出来 */
    checkInTime,
    checkOutTime,
    checkInTimeSource: roomCheckIn && isHhMm(roomCheckIn) ? "ROOM_TYPE" : "HOTEL",
    checkOutTimeSource: roomCheckOut && isHhMm(roomCheckOut) ? "ROOM_TYPE" : "HOTEL",

    /** 可订房量（只有传了日期才有值） */
    availability,

    /** 酒店电话 / 地图入口（详情页底部「联系酒店 / 导航」） */
    hotel: {
      name: hotel?.name ?? null,
      phone: orNull(hotel?.phone, 40),
      address: orNull(hotel?.address, 200),
    },

    configured,
    unconfigured,
  });
}
