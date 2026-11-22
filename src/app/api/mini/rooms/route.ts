/**
 * 小程序：可订房型列表（整改清单 F12）
 *
 * GET /api/mini/rooms?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
 *
 * 不需要登录 —— 客人还没登录时就要能查房价房量（这是小程序首页的核心内容）。
 * 返回每个房型的：名称 / 床型 / 可住人数 / 门市价 / 区间均价 / 区间总价 / 剩余可订间数。
 *
 * 房量口径见 _shared.ts 的 loadAvailability：
 *   可订 = 物理房间数 − 该区间在住 − 该区间已排预订 − 维修房
 */

import { resolveMiniHotelId } from "@/lib/mini-config";
import { rateLimit } from "@/lib/mini-rate-limit";
import { dayDiff, eachDay, fail, isDateStr, loadAvailability, MAX_NIGHTS, ok } from "../_shared";

export const dynamic = "force-dynamic";

/* ============================================================ 公开接口限流
 *
 * 小程序首页要在未登录时就能查房价房量，所以这个接口必须匿名开放；
 * 匿名 + 每次都要算整段区间的房量，天然是「被脚本刷」的靶子。
 *
 * 整改 P2-16 的调整（实现在 src/lib/mini-rate-limit.ts）：
 *   · 限流键从「纯 XFF 首段」改成「XFF 首段 + UA 哈希」：
 *     运营商 CGNAT 下整片用户共享一个出口 IP，纯 IP 计数会把他们一起挡住；
 *     掺入 UA 哈希后同 IP 下不同机型/微信版本各自计数，误伤显著下降。
 *   · 阈值从 60 次/分钟提到 120 次/分钟：首页会并行拉房型列表 + 详情图，
 *     60 对正常用户太紧，120 对脚本仍然毫无用处。
 *   · 计数放到共享模块，login / bind 用同一份实现，参数只差阈值。
 *
 * 边界：XFF 可伪造，这不是安全边界，只是防刷的成本闸门（详见 mini-rate-limit.ts）。
 */
const ROOMS_RATE_LIMIT_PER_MINUTE = 120;

export async function GET(req: Request) {
  /*
   * 限流放在最前面：连非法参数的请求也计数，
   * 否则脚本只要一直传错日期就能免费刷解析逻辑。
   */
  const limited = rateLimit(req, { scope: "mini:rooms", limit: ROOMS_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "查询过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const url = new URL(req.url);
  const checkIn = (url.searchParams.get("checkIn") ?? "").trim();
  const checkOut = (url.searchParams.get("checkOut") ?? "").trim();

  if (!isDateStr(checkIn) || !isDateStr(checkOut)) {
    return fail("BAD_REQUEST", "请传入合法的 checkIn / checkOut（格式 YYYY-MM-DD）", 400);
  }
  const nights = dayDiff(checkIn, checkOut);
  if (nights <= 0) {
    return fail("BAD_REQUEST", "离店日期必须晚于入住日期", 400);
  }
  if (nights > MAX_NIGHTS) {
    return fail("BAD_REQUEST", `单次最多查询 ${MAX_NIGHTS} 晚`, 400);
  }

  const hotelId = resolveMiniHotelId();
  const result = loadAvailability(hotelId, checkIn, checkOut);

  return ok({
    checkIn: result.checkIn,
    checkOut: result.checkOut,
    nights: result.nights,
    /** 提示页面：日期区间共几天，方便展示「¥xxx / 2 晚」 */
    days: eachDay(checkIn, checkOut),
    currency: "CNY",
    roomTypes: result.roomTypes,
  });
}
