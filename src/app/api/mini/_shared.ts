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
import { all, get, run } from "@/lib/db";
import { getActiveMiniConfig, getMiniProgramConfig } from "@/lib/mini-config";
import { requireMiniToken, type MiniUser } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
/* 房量口径：与 PC 建单（bookings/actions.ts）共用同一份实现，见文件下方 loadAvailability */
import { roomTypeStock, type StockDb } from "@/lib/room-stock-nightly";
import { nowIso } from "@/lib/utils";

/**
 * 交给库存 lib 的查询句柄（同一个连接，事务内看到的就是最新已提交数据）
 *
 * lib 不自己 import @/lib/db：PC action / 小程序 route / 测试脚本共用同一份逻辑，
 * 句柄由调用方注入，才能保证「算房量」和「写订单」在同一份快照上。
 */
const STOCK_DB: StockDb = { all, get };

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
 * ══════════════════════════════════════════════════════════════════════════
 * 房量口径（整改 P0-1 之后统一到 src/lib/room-stock-nightly.ts）
 * ══════════════════════════════════════════════════════════════════════════
 *   物理可售(房型) = 房间数 − 维修(OOO) − 锁房(LOCK)
 *   某一晚占用     = 在住单 + PENDING/CONFIRMED 明细（一行一间）
 *                  + 无明细旧主单（按 room_count）
 *   对外可订       = 区间内**最低**的那一晚剩余
 *
 * 原来这里自己写了一份「区间重叠计数」的旧口径，与 PC 建单修好后的逐晚口径不一致，
 * 带着两个已实测的 bug：
 *   ① 只扣 OOO 不扣 LOCK → 房型唯一一间房被锁，小程序照样卖出去（超卖）；
 *   ② 按整个入住区间有没有重叠 +1、不按晚拆 → 两间同型房 A 占 11-25、B 占 11-26，
 *      再订 11-25~11-27 一间（两晚各剩 1 间）被算成「已占 2 间」而误拒。
 * 现在口径交给 lib 的 `roomTypeStock`：它内部的 `physicalCapOfType` / `occupiedByNight`
 * 与 PC 端 `stockShortage` 是同一份代码，所以「列表显示可订 N 间」与
 * 「PC 建单能不能订 N 间」永远是同一个答案，不存在两个入口漂移的空间。
 *
 * 房价（rate_calendar）与库存无关，仍在下面自己算：
 *   区间总价 = Σ 每晚（有日历价用日历价，缺的日子回落门市价），均价 = 总价 / 晚数。
 * 两段故意分开：改库存口径不该影响报价，改报价也不该影响库存。
 *
 * 区间判定用半开区间：入住日 ≤ 该晚 < 离店日 —— 12:00 退房、14:00 入住，同一天可以接续，
 * A 占 11-25 一晚不会占掉 11-26。
 */
export function loadAvailability(hotelId: number, checkIn: string, checkOut: string): AvailabilityResult {
  const nights = dayDiff(checkIn, checkOut);

  /* 1. 房型基础信息（只取展示 / 报价要用的列；房量交给 lib，不再自己数房间） */
  const roomTypes = all<{
    id: number;
    code: string | null;
    name: string;
    bed_type: string | null;
    max_occupancy: number | null;
    base_price: number | null;
  }>(
    `SELECT rt.id, rt.code, rt.name, rt.bed_type, rt.max_occupancy, COALESCE(rt.base_price, 0) AS base_price
       FROM room_types rt
      WHERE rt.hotel_id = ?
      ORDER BY COALESCE(rt.sort, 100), rt.id`,
    [hotelId]
  );

  /*
   * 2. 房量（逐晚口径，与 PC 建单同一份实现）
   *
   * roomTypeStock 一次算全房型：
   *   cap       物理可售（房间数 − OOO − LOCK）
   *   minRemain 区间内最低剩余（入住区间里最紧的那一晚）
   *   occupied  每一晚的占用明细（本函数只用 minRemain；排查时可从这里拿逐晚数据）
   */
  const stock = roomTypeStock(STOCK_DB, hotelId, checkIn, checkOut);

  /* 3. 区间房价（房价日历按天配置，缺的日子回落门市价） */
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

  const days = eachDay(checkIn, checkOut);
  const list: RoomTypeAvailability[] = roomTypes.map((rt) => {
    const basePrice = round2(Number(rt.base_price ?? 0));
    let sum = 0;
    for (const day of days) sum += rateMap.get(`${rt.id}|${day}`) ?? basePrice;
    const totalPrice = round2(sum);
    const avgPrice = days.length > 0 ? round2(totalPrice / days.length) : basePrice;

    /*
     * 可订间数 = 区间内最低的那一晚剩余（roomTypeStock 已按逐晚算好，与 PC 建单同源）。
     *
     * 整改 P1-24：cap / 占用 / 维修房数**只在这里参与计算、不进入返回值** ——
     * 匿名接口不能泄露全店物理房量与经营数据，客人只需要知道「还能订几间」。
     * minRemain 可能为负（历史超卖数据），对外统一 clamp 到 0。
     */
    const remainingRooms = Math.max(0, Number(stock.get(rt.id)?.minRemain ?? 0));

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

/* ========================================================================== */
/*         第九轮：订单与在住（/bookings/[id]、/stays/**、/service-orders）       */
/* ========================================================================== */

/*
 * 这一节是「订单与在住」这批接口的公共骨架，加在文件末尾是为了不动上面
 * 已经被 6 个既有接口依赖的部分（其他 agent 也在改本目录，append-only 冲突面最小）。
 *
 * 三条贯穿全批的硬约束，逐个由这里的函数落实：
 *   1. **不信任客户端 id**：hotelId 只从 token 取；guestId 只从 mini_program_users
 *      的绑定关系取；stayId / bookingId 必须先用「属于当前 mini_user」的 SQL 验过
 *      才允许继续（loadOwnedStay / loadOwnedBooking）。
 *   2. **写操作必须幂等**：request_id 落库 + (hotel_id, request_id) 部分唯一索引，
 *      同一个 request_id 重复提交只建一条（findMiniServiceRequest 先查、唯一索引兜底）。
 *   3. **敏感动作留痕**：logMiniOp 写 op_logs（operator 固定「微信小程序」），
 *      日志里只出现打码后的姓名 / 手机号。
 */

/** 网关结果：要么带着可信身份继续，要么直接把这个响应回给小程序 */
export type MiniGuardResult =
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      /** token 解析出的身份（id 即 mini_program_users.id） */
      user: MiniUser;
      /** 服务端认定的酒店：只来自 token 行，绝不来自请求体 / query */
      hotelId: number;
      /** 绑定到 guests.id；未绑定为 null */
      guestId: number | null;
    };

/** 限流被拒的统一响应（429 + retry-after，文案给真人看） */
function rateLimitedResponse(retryAfterSeconds: number, message: string): NextResponse {
  const res = fail("RATE_LIMITED", message, 429);
  res.headers.set("retry-after", String(retryAfterSeconds));
  return res;
}

/**
 * 订单 / 在住接口的统一入口：限流 → 鉴权 → 小程序配置 → 返回可信身份。
 *
 * ── 顺序为什么是「先鉴权、后查配置」──
 * token 校验只是一次带索引的等值查询，比读配置便宜；更重要的是
 * 「未登录」对小程序端更可操作（清 token 重新登录即可），
 * 而 NOT_CONFIGURED 是管理员要处理的事。另外先鉴权也避免匿名调用方
 * 通过探测这个接口推断某家酒店到底配没配小程序。
 *
 * ── 配置检查为什么用 getActiveMiniConfig ──
 * 与 /api/mini/login 完全同一口径（登录成功过就说明拿到了可用配置），
 * 避免出现「登录能用、其他接口说没配置」的自相矛盾。管理员关掉小程序后
 * 已签发的 token 也会立刻被这里挡住（返回 NOT_CONFIGURED）。
 */
export function miniGuard(req: Request, scope: string, limit: number): MiniGuardResult {
  const limited = rateLimit(req, { scope, limit });
  if (limited.limited) {
    return {
      ok: false,
      response: rateLimitedResponse(limited.retryAfterSeconds, "操作过于频繁，请稍后再试"),
    };
  }

  const user = requireMiniToken(req);
  if (!user) {
    return {
      ok: false,
      response: fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401),
    };
  }

  const blocked = miniConfigBlocked(user);
  if (blocked) return { ok: false, response: blocked };

  return { ok: true, user, hotelId: user.hotelId, guestId: user.guestId };
}

/**
 * 小程序配置门槛（只查配置，不做鉴权、不限流）—— 返回 null 表示放行。
 *
 * ── 为什么需要这个函数（第九轮专项测试发现的实际缺陷）───────
 * 除 12 个走 miniGuard 的接口外，还有一批接口只 `requireMiniToken`：
 *   bind / bookings(列表 GET) / member / member/ledger / member/unbind /
 *   notifications / notifications/read / breakfast / invoices（+ 本批的 bookings POST）。
 * 它们因此**绕过了配置检查**：`mini_program_config` 一行都没有、或管理员把
 * `enabled` 关掉之后，这些接口仍然返回 200 —— 等于「停用小程序」只停住了
 * 订单/在住那一半，会员资料、储值流水、发票、通知照常可读可写。
 * 整改清单第 431 行要求「未配置小程序时返回 NOT_CONFIGURED」，覆盖范围必须是
 * **所有需要登录的小程序接口**，而不只是第一批。
 *
 * ── 为什么不做成「第二个 miniGuard」──
 * miniGuard 自带限流。这些接口早就有自己按业务调好的限流阈值（bind 20/分、
 * 标记已读 30/分、breakfast 更紧……），再做一层网关限流会叠加出两套配额，
 * 线上调一个阈值要改两处，且更紧的那层会先 429，排查时分不清是谁挡的。
 * 所以这里只抽「鉴权之后、业务之前」这一步，调用顺序保持：
 *   限流（各接口自己的）→ 鉴权 → 配置 → 业务。
 *
 * ── 为什么有些接口故意不调用它 ──
 *   · /api/mini/logout：退出是**清理动作**（服务端吊销 token）。小程序被停用后
 *     若连退出都返回 NOT_CONFIGURED，客户端会留着一个 7 天有效的服务端凭证，
 *     反而延长了风险窗口；吊销自己 token 也不泄露任何数据，所以按「始终允许」处理。
 *   · /api/mini/hotel、/api/mini/rooms、/api/mini/room-types/[id]：匿名公开接口，
 *     客人还没登录就要能看酒店信息与房价；它们用 getActiveMiniConfig() 只回一个
 *     `miniConfigured` 布尔，不需要（也不应该）整体拒绝。
 */
export function miniConfigBlocked(user: MiniUser): NextResponse | null {
  if (isMiniConfiguredFor(user.hotelId)) return null;
  return fail("NOT_CONFIGURED", "小程序未配置，请管理员在系统设置里填写 AppID/AppSecret");
}

/**
 * 当前 token 所属酒店是否还有可用的小程序配置。
 *
 * ── 为什么按酒店判定，而不是直接 getActiveMiniConfig() ──
 * getActiveMiniConfig() 会扫「任意一家」酒店的配置：多店部署时，只要别家还开着，
 * 本店被停用也照样放行 —— 管理员关掉本店小程序却不生效。
 *
 * ── 为什么还要回退到 getActiveMiniConfig() ──
 * 有几类部署只在 /wechat 页填过配置（写 settings 的 wechat_*，mini_program_config
 * 一行都没有，见 mini-config.ts 的 P2-18 说明）。那种库上按酒店查必然查不到行，
 * 如果直接判 NOT_CONFIGURED，会出现「登录能用、别的接口说没配置」的自相矛盾。
 * 所以：**本店有配置行就只看本店**（严格），本店一行都没有才回退全局判定。
 */
function isMiniConfiguredFor(hotelId: number): boolean {
  const own = getMiniProgramConfig(hotelId);
  if (own) return Boolean(own.enabled && own.appId && own.appSecret);
  return getActiveMiniConfig() !== null;
}

/** 绑定客史的可信身份（服务端数据，用来做「单据属于本人」的判定） */
export type MiniGuestIdentity = {
  guestId: number;
  /** 客史姓名（响应前必须打码） */
  name: string;
  /** 客史手机号（只用于归属比对，响应前必须打码） */
  mobile: string;
};

/**
 * 读绑定客史。返回 null 表示没绑定 / 档案不存在 / 档案属于别家酒店。
 *
 * 为什么要校验 hotel_id：mini_program_users.guest_id 是一个裸 id，
 * 客史档案换店或被删时它可能悬空。悬空时**不能**当成「有效绑定」去取数据，
 * 否则会在另一个租户里匹配到同 id 的档案。悬空就按未绑定处理（返回 null）。
 */
export function resolveMiniGuest(hotelId: number, guestId: number | null): MiniGuestIdentity | null {
  if (!guestId) return null;
  const row = get<{ id: number; name: string | null; mobile: string | null }>(
    `SELECT id, name, mobile FROM guests WHERE id = ? AND hotel_id = ? LIMIT 1`,
    [guestId, hotelId]
  );
  if (!row) return null;
  return { guestId: Number(row.id), name: (row.name ?? "").trim(), mobile: (row.mobile ?? "").trim() };
}

/** 一条在住单（服务端视图；room_no / 金额都由服务端补齐） */
export type MiniStayRow = {
  id: number;
  stayNo: string;
  roomId: number;
  roomNo: string;
  /** 关联的预订主单（服务请求留痕用；无预订为 null） */
  bookingId: number | null;
  /** 入住日（YYYY-MM-DD，从 check_in_time 截出来） */
  checkInDate: string;
  /** 预计离店日（YYYY-MM-DD） */
  expectCheckOut: string;
  nights: number;
  rate: number;
  status: string;
  breakfast: number;
  guestName: string;
  mobile: string;
};

/** stays 的原始行（SQL 别名） */
type StayRawRow = {
  id: number;
  stay_no: string | null;
  room_id: number | null;
  room_no: string | null;
  booking_id: number | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  nights: number | null;
  rate: number | null;
  status: string | null;
  breakfast: number | null;
  guest_name: string | null;
  mobile: string | null;
};

/** 原始行 → 领域对象 */
function toStayRow(row: StayRawRow): MiniStayRow {
  return {
    id: Number(row.id),
    stayNo: (row.stay_no ?? "").trim(),
    roomId: Number(row.room_id ?? 0),
    roomNo: (row.room_no ?? "").trim(),
    bookingId: row.booking_id == null ? null : Number(row.booking_id),
    checkInDate: (row.check_in_time ?? "").slice(0, 10),
    expectCheckOut: (row.expect_check_out ?? "").slice(0, 10),
    nights: Number(row.nights ?? 0),
    rate: round2(Number(row.rate ?? 0)),
    status: (row.status ?? "").trim(),
    breakfast: Number(row.breakfast ?? 0),
    guestName: (row.guest_name ?? "").trim(),
    mobile: (row.mobile ?? "").trim(),
  };
}

/** 在住单的取数列（三处 SQL 共用，避免列清单漂移） */
const STAY_SELECT = `s.id, s.stay_no, s.room_id, r.room_no, s.booking_id, s.check_in_time,
            s.expect_check_out, s.nights, s.rate, s.status, s.breakfast, s.guest_name, s.mobile`;

/**
 * 按「属于当前小程序用户」的条件取一条在住单。取不到返回 null。
 *
 * 归属口径（整改清单：不信任客户端 stayId）：
 *   1. stays.guest_id = token 推出的 guest_id —— 权威来源；
 *   2. 兜底：stays.guest_id 为空的**历史单**，且 stays.mobile 与**已绑定客史**的
 *      guests.mobile 完全一致。这里用的手机号是服务端档案里的号码（绑定客史时已用
 *      预订号 / 房间号证明过归属），不是客户端本次请求里填的自由文本，所以不构成
 *      「用可伪造字段做授权」（P0-12 的反面案例是拿请求体里的 mobile 查库）。
 *      只在 guest_id IS NULL 时才走这条，不给「改了 guest_id 的单」开后门。
 *
 * 未绑定客史（guestId = null）一律返回 null → 调用方回 STAY_NOT_FOUND / 空列表。
 */
export function loadOwnedStay(
  hotelId: number,
  identity: MiniGuestIdentity | null,
  stayId: number
): MiniStayRow | null {
  if (!identity || !stayId) return null;
  const row = get<StayRawRow>(
    `SELECT ${STAY_SELECT}
       FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.id = ? AND s.hotel_id = ?
        AND (
          s.guest_id = ?
          OR (s.guest_id IS NULL AND ? <> '' AND s.mobile = ?)
        )
      LIMIT 1`,
    [stayId, hotelId, identity.guestId, identity.mobile, identity.mobile]
  );
  return row ? toStayRow(row) : null;
}

/**
 * 当前在住单列表（同一归属口径，status = INHOUSE）。
 * 未绑定客史直接返回空数组，不做任何「按手机号猜」的兜底。
 */
export function listOwnedInhouseStays(hotelId: number, identity: MiniGuestIdentity | null): MiniStayRow[] {
  if (!identity) return [];
  return all<StayRawRow>(
    `SELECT ${STAY_SELECT}
       FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND (
          s.guest_id = ?
          OR (s.guest_id IS NULL AND ? <> '' AND s.mobile = ?)
        )
      ORDER BY s.id DESC
      LIMIT 20`,
    [hotelId, identity.guestId, identity.mobile, identity.mobile]
  ).map(toStayRow);
}

/** 在住单对应的账单（folioId 只由服务端推导，绝不接受客户端传入） */
export function loadStayFolio(
  hotelId: number,
  stayId: number
): { id: number; folioNo: string; status: string } | null {
  const row = get<{ id: number; folio_no: string | null; status: string | null }>(
    `SELECT id, folio_no, status FROM folios
      WHERE hotel_id = ? AND stay_id = ?
      ORDER BY id DESC LIMIT 1`,
    [hotelId, stayId]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    folioNo: (row.folio_no ?? "").trim(),
    status: (row.status ?? "").trim(),
  };
}

/* ------------------------------ 幂等键 ---------------------------------- */

/** request_id 长度下限：太短会撞（客户端一般用 uuid / 时间戳+随机） */
export const MINI_REQUEST_ID_MIN = 8;

/** request_id 长度上限：防止有人往上限里灌几十 KB 文本 */
export const MINI_REQUEST_ID_MAX = 64;

/**
 * 合法的幂等键：8-64 位字母 / 数字 / 下划线 / 中划线。
 * 只允许这套字符是为了让键能安全进日志、也避免客户端塞任意文本进库。
 */
export function isRequestId(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{${MINI_REQUEST_ID_MIN},${MINI_REQUEST_ID_MAX}}$`).test(value);
}

/* --------------------------- 服务请求类型 / 状态 --------------------------- */

/** 服务请求类型（与 scripts 三处 DDL 的注释、PC 端处理队列同一套枚举） */
export const MINI_SERVICE_TYPES = [
  "CLEANING", // 客房清洁
  "DELIVERY", // 送物（水 / 毛巾 / 充电器等）
  "REPAIR", // 维修
  "LATE_CHECKOUT", // 延迟退房申请
  "CHANGE_ROOM", // 换房申请
  "WAKEUP", // 叫醒服务
  "EXTEND", // 续住（已按冲突校验结果落库，留痕）
  "OTHER", // 其他
] as const;

export type MiniServiceType = (typeof MINI_SERVICE_TYPES)[number];

/** 类型 → 中文文案（小程序列表直接展示） */
export const MINI_SERVICE_TYPE_LABEL: Record<MiniServiceType, string> = {
  CLEANING: "客房清洁",
  DELIVERY: "送物服务",
  REPAIR: "设施维修",
  LATE_CHECKOUT: "延迟退房",
  CHANGE_ROOM: "换房申请",
  WAKEUP: "叫醒服务",
  EXTEND: "续住申请",
  OTHER: "其他需求",
};

/** 归一化客户端传来的类型：大写 + 去空白，认不出返回 null（不猜） */
export function toMiniServiceType(value: string): MiniServiceType | null {
  const v = (value ?? "").trim().toUpperCase();
  return (MINI_SERVICE_TYPES as readonly string[]).includes(v) ? (v as MiniServiceType) : null;
}

/** 状态 → 中文文案 */
export const MINI_SERVICE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待处理",
  ACCEPTED: "已接单",
  PROCESSING: "处理中",
  DONE: "已完成",
  CANCELLED: "已取消",
  REJECTED: "已驳回",
};

/**
 * 客人自己还能取消的状态。
 *
 * 只允许 PENDING：一旦前台接单（ACCEPTED / PROCESSING），阿姨可能已经在路上了，
 * 客人点取消就会出现「人到了活没了」；这种情况请客人直接联系前台。
 */
export const MINI_CANCELLABLE_STATUS = "PENDING";

/* ------------------------- 运行时建表（第四处同步） ------------------------- */

/** 表结构只建一次（dev 热重载会重置模块，CREATE IF NOT EXISTS 幂等兜底） */
let serviceSchemaReady = false;

/**
 * 运行时懒建 mini_service_requests（清单第六节第 387-394 行的「运行时 ensureSchema」）。
 *
 * 为什么放在小程序 API 目录而不是 src/lib/mini-config.ts：
 *   mini-config.ts 管的是「配置 + 用户 + 订单关联」三张登录相关表，由其他改动面共用；
 *   服务请求只被本批接口用到，就近懒建可以让新接口在还没跑迁移的库上也能起来
 *   （项目既有约定：页面 / 接口先能跑，迁移脚本仍是 schema 的唯一权威来源）。
 *
 * ⚠️ 这里的 DDL 必须与 scripts/schema-full.sql、scripts/init-db.mjs、
 *    scripts/migrate-all.mjs（12.3 段）四处逐列一致。
 */
export function ensureMiniServiceSchema(): void {
  if (serviceSchemaReady) return;
  run(`
    CREATE TABLE IF NOT EXISTS mini_service_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      mini_user_id INTEGER NOT NULL,
      guest_id INTEGER,
      stay_id INTEGER,
      booking_id INTEGER,
      service_type TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      request_id TEXT,
      note TEXT,
      operator TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    )
  `);
  run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mini_service_requests_req
       ON mini_service_requests(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_mini_service_requests_user
       ON mini_service_requests(hotel_id, mini_user_id, id)`
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_mini_service_requests_stay
       ON mini_service_requests(hotel_id, stay_id)`
  );
  run(
    `CREATE INDEX IF NOT EXISTS idx_mini_service_requests_status
       ON mini_service_requests(hotel_id, status, id)`
  );
  serviceSchemaReady = true;
}

/** 服务请求行（服务端视图） */
export type MiniServiceRequestRow = {
  id: number;
  serviceType: string;
  status: string;
  requestId: string;
  stayId: number | null;
  bookingId: number | null;
  note: string;
  operator: string;
  createdAt: string;
  completedAt: string | null;
};

type ServiceRawRow = {
  id: number;
  service_type: string | null;
  status: string | null;
  request_id: string | null;
  stay_id: number | null;
  booking_id: number | null;
  note: string | null;
  operator: string | null;
  created_at: string | null;
  completed_at: string | null;
};

/** 原始行 → 领域对象（列表 / 幂等回显共用一份，避免两处字段口径漂移） */
export function toServiceRequestRow(row: ServiceRawRow): MiniServiceRequestRow {
  return {
    id: Number(row.id),
    serviceType: (row.service_type ?? "").trim(),
    status: (row.status ?? "").trim(),
    requestId: (row.request_id ?? "").trim(),
    stayId: row.stay_id == null ? null : Number(row.stay_id),
    bookingId: row.booking_id == null ? null : Number(row.booking_id),
    note: (row.note ?? "").trim(),
    operator: (row.operator ?? "").trim(),
    createdAt: row.created_at ?? "",
    completedAt: row.completed_at ?? null,
  };
}

const SERVICE_SELECT = `id, service_type, status, request_id, stay_id, booking_id, note, operator, created_at, completed_at`;

/**
 * 用幂等键查已有的服务请求（先查；并发下的兜底是唯一索引抛错 + catch）。
 * 必须带上 hotel_id：不同酒店可能各自生成同一串 request_id。
 */
export function findMiniServiceRequest(hotelId: number, requestId: string): MiniServiceRequestRow | undefined {
  if (!requestId) return undefined;
  ensureMiniServiceSchema();
  const row = get<ServiceRawRow>(
    `SELECT ${SERVICE_SELECT} FROM mini_service_requests
      WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
    [hotelId, requestId]
  );
  return row ? toServiceRequestRow(row) : undefined;
}

/** 按 id 取服务请求（取消接口用；调用方必须再校验 mini_user_id） */
export function getMiniServiceRequest(hotelId: number, id: number): MiniServiceRequestRow | undefined {
  if (!id) return undefined;
  ensureMiniServiceSchema();
  const row = get<ServiceRawRow>(
    `SELECT ${SERVICE_SELECT} FROM mini_service_requests WHERE id = ? AND hotel_id = ? LIMIT 1`,
    [id, hotelId]
  );
  return row ? toServiceRequestRow(row) : undefined;
}

export type NewServiceRequest = {
  hotelId: number;
  miniUserId: number;
  guestId: number | null;
  stayId: number | null;
  bookingId: number | null;
  serviceType: MiniServiceType;
  /** 幂等键（调用方已校验 isRequestId） */
  requestId: string;
  note: string;
  /** 已经处理完的动作（续住 succeed 时直接落 DONE + completed_at） */
  status?: string;
  completedAt?: string | null;
};

/**
 * 落一条服务请求。**调用方必须已经在事务里做过幂等预检**
 * （tx(() => { 先 findMiniServiceRequest，命中就返回；否则 insert })），
 * 这样「同一 request_id 两次提交」不会产生第二条记录。
 *
 * 唯一索引 (hotel_id, request_id) 是最后一道防线：极端并发下 insert 会抛
 * UNIQUE constraint failed，调用方 catch 后重查一次按「重复提交」处理。
 */
export function insertMiniServiceRequest(input: NewServiceRequest): number {
  ensureMiniServiceSchema();
  const now = nowIso();
  const result = run(
    `INSERT INTO mini_service_requests
       (hotel_id, mini_user_id, guest_id, stay_id, booking_id, service_type, status,
        request_id, note, operator, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.hotelId,
      input.miniUserId,
      input.guestId,
      input.stayId,
      input.bookingId,
      input.serviceType,
      input.status ?? "PENDING",
      input.requestId,
      input.note.slice(0, 300),
      null,
      now,
      now,
      input.completedAt ?? null,
    ]
  );
  return Number(result.lastInsertRowid);
}

/**
 * 记一条敏感动作日志（op_logs）。
 *
 * operator 固定为「微信小程序」：PC 端的操作日志按操作人筛选时能一眼分出
 * 「这是客人自己在小程序上动的」，不需要去猜哪位员工在什么时候用手机操作过。
 * detail 里只放单号 / 日期 / 间数这类业务标识，姓名手机号由调用方先打码。
 */
export function logMiniOp(hotelId: number, action: string, detail: string): void {
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    "微信小程序",
    action,
    detail.slice(0, 400),
    nowIso(),
  ]);
}

/** 服务请求的状态文案（找不到映射时原样回吐，前端不会显示空白） */
export function serviceStatusLabel(status: string): string {
  return MINI_SERVICE_STATUS_LABEL[status] ?? status;
}
