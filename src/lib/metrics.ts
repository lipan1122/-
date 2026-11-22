/**
 * 出租率 / ADR / RevPAR 口径统一（第 4 轮 P1-5）
 *
 * ── 问题 ──
 * 同一个「出租率」在三个地方算出三个数：
 *   1. dashboard/page.tsx    occupied / total            （分母含维修房/锁房）
 *   2. reports/page.tsx      occupied / sellableRooms    （分母扣了 OOO/LOCK）
 *   3. night-audit/actions   rooms_sold / totalRooms     （注释自认「暂不扣维修房」）
 *
 * 店长早上看工作台 54%、去看报表 57%、夜审日报 54% —— 三个数字打架，
 * 谁也不知道该信哪个。ADR / RevPAR 同理。
 *
 * ── 统一口径（业界标准，与去呼呼一致）──
 *
 *   可售房量（sellableRooms） = 总房量 − 维修房(OOO) − 锁房(LOCK)
 *   出租间夜（roomNights）    = Σ 在住晚数，**排除钟点房**
 *   已售房量（roomsSold）     = 出租间夜 / 统计天数（单日就是出租间夜本身）
 *
 *   出租率 OCC = 已售房量 / 可售房量
 *   ADR（平均房价）  = 客房收入 / 已售房量
 *   RevPAR          = 客房收入 / 可售房量 = ADR × OCC
 *
 * 关键点：
 *   · 分母一律扣维修房/锁房（那些房卖不了，算进分母会低估出租率）
 *   · 钟点房不算出租间夜（它是按时段卖的，不是过夜）
 *   · ADR 除以「已售房量」而不是「总房量」
 *
 * ── 这个文件怎么用 ──
 * 三个模块统一 import 这里的函数，不再各写一份 SQL。
 * 允许统计区间（from/to）与单日（传同一个日期）两种调用。
 */
import { get } from "@/lib/db";

export type OccupancyMetrics = {
  /** 统计天数（闭区间，含首尾） */
  days: number;
  /** 总房量（含维修房/锁房） */
  totalRooms: number;
  /** 可售房量（扣 OOO / LOCK） */
  sellableRooms: number;
  /** 出租间夜（包含入住晚数，排除钟点房） */
  roomNights: number;
  /** 已售房量 = 出租间夜 / 天数（单日时等于 roomNights） */
  roomsSold: number;
  /** 客房收入（只算 ROOM 明细，排除押金与部分结账调整） */
  roomRevenue: number;
  /** 出租率 0-1 */
  occupancy: number;
  /** 平均房价（每间夜） */
  adr: number;
  /** 每间可售房收入 */
  revpar: number;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 闭区间天数（from === to 时返回 1） */
export function dayCount(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * 计算统计区间内的经营指标
 *
 * @param hotelId 酒店
 * @param from    起始营业日（含，YYYY-MM-DD）
 * @param to      结束营业日（含，YYYY-MM-DD）
 */
export function occupancyMetrics(hotelId: number, from: string, to: string): OccupancyMetrics {
  const days = dayCount(from, to);

  /* 房量：总数与可售数分开算（可售扣 OOO / LOCK） */
  const roomRow = get<{ total: number; sellable: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
       FROM rooms WHERE hotel_id = ?`,
    [hotelId]
  );
  const totalRooms = Number(roomRow?.total ?? 0);
  const sellableRooms = Number(roomRow?.sellable ?? 0);

  /*
   * 出租间夜：按「入住的每一晚」累加，落在统计区间内的那一部分才算。
   *
   * 为什么不用 stays 行数：一间房住 3 晚是 3 个间夜，不是 1 间。
   * 为什么排除钟点房：钟点房按时段卖，不构成「过夜出租」，
   *   算进来会让 OCC 虚高、ADR 虚低（房费只有几小时的量）。
   *
   * ── 逾期未离店怎么算（重要）──
   * 在住单（INHOUSE）如果已经过了预计离店日，客人**人还在房间里**，
   * 房间仍然被占着、卖不出去 —— 所以间夜要算到今天，用 `date(to, '+1 day')`。
   * 只有已退房（CHECKED_OUT）的单才按 expect_check_out 截断。
   *
   * 旧口径直接用 expect_check_out，导致「客人逾期 7 天没走」时
   * 今天出租率显示 0%（明明房间全占着），这是错的。
   *
   * date(check_in_time) 用 substr 取前 10 位而不是 date()：
   *   check_in_time 现在存的是本地时间戳（nowLocalIso），
   *   SQLite 的 date() 会按 UTC 解析，导致凌晨入住的房少算一天。
   */
  const nightRow = get<{ nights: number }>(
    `SELECT COALESCE(SUM(
              MAX(0,
                  MIN(
                    julianday(CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day') ELSE s.expect_check_out END),
                    julianday(date(?, '+1 day'))
                  )
                  - MAX(julianday(substr(s.check_in_time,1,10)), julianday(?))
              )
            ), 0) AS nights
       FROM stays s
      WHERE s.hotel_id = ?
        AND s.status IN ('INHOUSE','CHECKED_OUT')
        AND COALESCE(s.rate_code,'') <> '钟点'
        AND substr(s.check_in_time,1,10) <= ?
        AND COALESCE(s.expect_check_out, substr(s.check_in_time,1,10)) > ?
           OR (s.status = 'INHOUSE' AND substr(s.check_in_time,1,10) <= ?)`,
    [to, to, from, hotelId, to, from, to]
  );
  const roomNights = Math.max(0, Math.round(Number(nightRow?.nights ?? 0)));

  /*
   * 客房收入：只算 ROOM 明细里落在这个营业日的部分。
   *
   * 排除押金（DEPOSIT）和「部分结账」调整项 —— 与 recalcFolioBalance 同口径。
   * 不直接 SUM(folios.total_amount)：那是「整张账单的应收」，
   * 跨营业日入住时会把别的日子的房费算进来。
   */
  const revRow = get<{ revenue: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS revenue
       FROM folio_items
      WHERE hotel_id = ? AND item_type = 'ROOM'
        AND biz_date >= ? AND biz_date <= ?`,
    [hotelId, from, to]
  );
  const roomRevenue = round2(Number(revRow?.revenue ?? 0));

  /* 已售房量：单日就是间夜数；多日要除以天数才是「平均在售房间数」 */
  const roomsSold = days > 0 ? round2(roomNights / days) : 0;

  const occupancy = sellableRooms > 0 ? roomsSold / sellableRooms : 0;
  const adr = roomsSold > 0 ? round2(roomRevenue / roomsSold) : 0;
  const revpar = sellableRooms > 0 ? round2(roomRevenue / sellableRooms / days) : 0;

  return {
    days,
    totalRooms,
    sellableRooms,
    roomNights,
    roomsSold,
    roomRevenue,
    occupancy,
    adr,
    revpar,
  };
}

/** 单日快捷调用 */
export function occupancyOfDay(hotelId: number, day: string): OccupancyMetrics {
  return occupancyMetrics(hotelId, day, day);
}

/** 出租率格式化（统一 1 位小数，避免 100.00000001% 这种） */
export function fmtOccupancy(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0.0%";
  return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
}
