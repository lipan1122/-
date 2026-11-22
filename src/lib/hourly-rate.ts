/**
 * 钟点房报价（第 4 轮 P1-29，统一入口）
 *
 * ── 为什么抽到 lib ──
 * 钟点计费有三个入口，原来各写一套硬编码公式「门市价 × 15% × 小时数」：
 *   1. `rooms/actions.ts` 的 `toHourlyAction`（日租转钟点）
 *   2. `inhouse/actions.ts` 的转钟点（在住客人改钟点）
 *   3. `frontdesk/actions.ts` 的入住钟点房
 *
 * 管理员在设置页「钟点房收费」里配了每个房型的基础时长 / 基础收费 / 超时标准 /
 * 全房费规则，但三个入口都不读 —— 改完设置价格纹丝不动，前台还得手工改价。
 *
 * 现在统一到这里：有配置用配置，没配置回退到原公式，三个入口都调这一个函数。
 *
 * ── 计价规则 ──
 *   报价 = 基础收费 + 超出基础时长的整点小时数 × 超时收费标准
 *   · 全房费规则能解析出「满 N 小时」且本次达到 N → 按全天房费（门市价）
 *   · 未达阈值时钟点价不应高于全天房费（半天不可能比整天贵）
 *   · 完全没有配置 → 门市价 × 15% × 小时数（历史口径，保证老行为不变）
 */
import { get } from "@/lib/db";
import { fmtMoney } from "@/lib/utils";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 表是否存在（老库可能还没建 hourly_rates） */
function tableExists(name: string): boolean {
  try {
    const row = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
      [name]
    );
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 从「满 8 小时按全天房费收取」这类自由文本里解析小时数。
 * 解析不出返回 null —— 宁可忽略规则，也不能因为描述写得随意就拒绝给客人算价。
 */
export function parseFullDayHours(rule: string | null): number | null {
  const m = /满\s*(\d+(?:\.\d+)?)\s*小时/.exec((rule ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 24 ? n : null;
}

export type HourlyQuote = {
  /** 本次钟点房价 */
  price: number;
  /** 计价口径说明（账单明细 / 操作日志用，便于事后对账） */
  note: string;
  /** true = 命中按房型的钟点房配置；false = 走了门市价 15%/小时的历史口径 */
  configured: boolean;
};

/**
 * 钟点房报价
 *
 * @param hotelId    酒店
 * @param roomTypeId 房型（空/0 时直接走历史公式）
 * @param hours      钟点小时数（必须 > 0）
 * @param rack       该房型门市价（全天房费，作为上限与满房规则的价格）
 */
export function quoteHourly(hotelId: number, roomTypeId: number | null, hours: number, rack: number): HourlyQuote {
  const h = Number.isFinite(hours) && hours > 0 ? hours : 1;
  const fallback: HourlyQuote = {
    price: round2(rack * 0.15 * h),
    note: `门市价 ${fmtMoney(rack)} × 15% × ${h} 小时（未配置钟点房标准）`,
    configured: false,
  };
  if (!roomTypeId || roomTypeId <= 0 || !tableExists("hourly_rates")) return fallback;

  const row = get<{
    base_hours: number | null;
    base_price: number | null;
    overtime_rate: number | null;
    full_day_rule: string | null;
  }>(
    `SELECT base_hours, base_price, overtime_rate, full_day_rule
       FROM hourly_rates WHERE hotel_id = ? AND room_type_id = ?`,
    [hotelId, roomTypeId]
  );
  if (!row) return fallback;

  const baseHours = Math.max(1, Math.trunc(Number(row.base_hours ?? 4)) || 4);
  const basePrice = Math.max(0, Number(row.base_price ?? 0) || 0);
  const overtimeRate = Math.max(0, Number(row.overtime_rate ?? 0) || 0);
  const overHours = Math.max(0, Math.ceil(h - baseHours));
  let price = round2(basePrice + overHours * overtimeRate);
  let note = `基础 ${baseHours} 小时 ${fmtMoney(basePrice)}`;
  if (overHours > 0) note += ` + 超时 ${overHours} 小时 × ${fmtMoney(overtimeRate)}`;

  /*
   * 全房费规则（设置页可改的自由文本）：
   *   · 能解析出「满 N 小时」且本次时长达到 N → 按全天房费收取；
   *   · 没达到（或规则解析不出）时，钟点价也不应高于全天房费（半天不可能比整天贵）。
   */
  const fullDayHours = parseFullDayHours(row.full_day_rule);
  if (fullDayHours !== null && h >= fullDayHours) {
    price = round2(rack);
    note += `；满 ${fullDayHours} 小时按全天房费 ${fmtMoney(rack)} 收取`;
  } else if (rack > 0 && price > rack) {
    price = round2(rack);
    note += `；不超过全天房费 ${fmtMoney(rack)}`;
  }

  return { price, note, configured: true };
}
