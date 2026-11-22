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
import { all, get } from "@/lib/db";

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
   * ── 在住单怎么算 ──
   * 在住单（INHOUSE）如果已经过了预计离店日，客人**人还在房间里**，
   * 房间仍然被占着、卖不出去 —— 所以间夜要算到今天，用 `date(to, '+1 day')`。
   * 旧口径直接用 expect_check_out，导致「客人逾期 7 天没走」时
   * 今天出租率显示 0%（明明房间全占着），那是错的。
   *
   * ── 已退房单（第九轮修复 F6）──
   * 行业定义里「出租间夜 = 当晚被占用的房间数」。
   * 客人今天退房（actual_check_out = 今天），今晚这间房**不占**，
   * 必须用 actual_check_out 作区间终点；旧口径用 expect_check_out（预计明天退），
   * 把已经空出来的房间又算了一晚 —— 夜审分子按「当前在住条数」只算 29，
   * 本函数却算出 32，同一营业日两个出租率打架。
   * actual_check_out 为空（历史脏数据）时才回落到 expect_check_out。
   *
   * date(check_in_time) 用 substr 取前 10 位而不是 date()：
   *   check_in_time 现在存的是本地时间戳（nowLocalIso），
   *   SQLite 的 date() 会按 UTC 解析，导致凌晨入住的房少算一天。
   *
   * ⚠️ 下面这段 SQL 的文本被 scripts/test-night-audit-occupancy.mjs 逐字比对
   *    （它把 SQL 抠出来在临时库上真跑）。所以修复方式是在原文本**末尾追加**
   *    `AND s.status = 'INHOUSE'`，把这一条限定为在住单；已退房单由紧随其后的
   *    第二条 SQL 单独计算 —— 两条相加才是完整的出租间夜。
   */
  /*
   * 条件必须整体加括号（这里曾经是个真实的多租户漏洞）
   *
   * 上一版的 WHERE 长这样：
   *     WHERE s.hotel_id = ?
   *       AND s.status IN ('INHOUSE','CHECKED_OUT')
   *       AND COALESCE(s.rate_code,'') <> '钟点'
   *       AND substr(s.check_in_time,1,10) <= ?
   *       AND COALESCE(s.expect_check_out, ...) > ?
   *          OR (s.status = 'INHOUSE' AND substr(s.check_in_time,1,10) <= ?)
   *
   * SQL 里 AND 优先级高于 OR，所以它实际等价于：
   *     WHERE (hotel_id=? AND 状态 AND 非钟点 AND 在区间内)
   *        OR (status='INHOUSE' AND check_in <= ?)          ← 这个分支没有 hotel_id！
   *
   * 后果：所有酒店的 INHOUSE 单都会被算进本酒店的间夜，「排除钟点房」也失效。
   * 当前演示库只有 1 家酒店、唯一钟点单已退房，所以数字看起来是对的 ——
   * 一旦上多店部署，房态/报表/夜审的出租率会全部串店虚高。
   *
   * 修法：把「区间内 或 在住」这一组条件用括号包起来，
   * 让它只决定「算不算这一晚」，而不是绕开前面的租户/状态/钟点过滤。
   */
  const inhouseNightRow = get<{ nights: number }>(
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
        AND (
              (substr(s.check_in_time,1,10) <= ?
               AND COALESCE(s.expect_check_out, substr(s.check_in_time,1,10)) > ?)
           OR (s.status = 'INHOUSE' AND substr(s.check_in_time,1,10) <= ?)
        )
        AND s.status = 'INHOUSE'`,
    [to, to, from, hotelId, to, from, to]
  );
  const inhouseNights = Math.max(0, Math.round(Number(inhouseNightRow?.nights ?? 0)));

  /*
   * 已退房单：区间终点用 actual_check_out（实际离店日），不是 expect_check_out。
   *
   * 覆盖三类历史/提前退房：
   *   · 正常退房：actual = expect，与旧口径同结果；
   *   · 提前退房：actual < expect，退房当晚不再算占用（就是 F6 的 3 间夜差）；
   *   · actual 为空的脏数据：回落 expect_check_out，行为与旧口径一致。
   * 仍然排除钟点房、仍按营业日闭区间夹取，参数顺序 [to, from, hotelId, to, from]。
   */
  const checkedOutNightRow = get<{ nights: number }>(
    `SELECT COALESCE(SUM(
              MAX(0,
                  MIN(
                    julianday(COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out)),
                    julianday(date(?, '+1 day'))
                  )
                  - MAX(julianday(substr(s.check_in_time,1,10)), julianday(?))
              )
            ), 0) AS nights
       FROM stays s
      WHERE s.hotel_id = ?
        AND s.status = 'CHECKED_OUT'
        AND COALESCE(s.rate_code,'') <> '钟点'
        AND substr(s.check_in_time,1,10) <= ?
        AND COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out, substr(s.check_in_time,1,10)) > ?`,
    [to, from, hotelId, to, from]
  );
  const checkedOutNights = Math.max(0, Math.round(Number(checkedOutNightRow?.nights ?? 0)));

  const roomNights = inhouseNights + checkedOutNights;

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

/* ================================================================== *
 * 区间间夜明细（报表中心统一口径）
 *
 * ── 问题（真实缺陷，真库可复现）──
 * 报表中心原来把 `SUM(folio_items.qty)` 当间夜数（WHERE item_type = 'ROOM'）。
 * 但 qty 是「明细行数量」，不是住宿晚数；而且房费是夜审按营业日逐条补记的 ——
 * 今天 / 昨天的房费还没过账时 ROOM 明细根本不存在，报表间夜恒等于 0，
 * 而房态与工作台显示 21 间在住。同一个「间夜」出现第三套口径：
 *
 *     房态 21 间在住 · 工作台 / 夜审 21 · 报表 0 · 导出 0
 *
 * 清单要求「房态、工作台、夜审、报表、导出、渠道库存全部一致」，
 * 所以报表必须改成读 stays 的住宿口径，而不是数房费明细行。
 *
 * ── 这里做什么 ──
 * 把上面 occupancyMetrics 的间夜口径**逐条**展开成：
 * 「每条入住单在本区间占用哪几晚、共几晚」，并带上房型 / 渠道 / 客人维度。
 * 报表再按日 / 房型 / 渠道 / 客人聚合，不再各写一套 SQL。
 *
 * 过滤条件与 nights 表达式与 occupancyMetrics 的两条 SQL 同口径：
 *   · 在住单算到今天（date(to,'+1 day')）—— 逾期未退仍占着房；
 *   · 已退房单用 actual_check_out（提前退房不占退房当晚），为空回落 expect_check_out；
 *   · 排除钟点房（rate_code = '钟点'）；
 *   · 按营业日闭区间夹取 [from, to]，每晚算 1 个间夜。
 *
 * 恒等式（对账用）：
 *     Σ stayNightSlices(hotelId, from, to).nights
 *   = occupancyMetrics(hotelId, from, to).roomNights
 * 并且 nightSeries() 的逐日值累加也等于它 —— 报表卡片 / 合计行 / 逐日表格
 * 三处因此不可能再打架。
 * ================================================================== */

/** 一条入住单在统计区间内的占用明细 */
export type StayNightSlice = {
  stayId: number;
  status: string;
  guestName: string | null;
  /**
   * 房型 / 渠道的 id 与名称。
   *
   * 为什么两个都带：`channels` 表里可能真有一条名字叫「散客」的渠道记录，
   * 而「没匹配到渠道」的入住单也会显示成「散客」（COALESCE(c.name,'散客')）。
   * 报表按 `GROUP BY c.id` 出行时会有**两行同名**，只按名字聚合会把间夜加两遍
   * （真库实测：售价间夜 151 而实际 142）。所以按 id 对齐，名称只用于显示。
   */
  roomTypeId: number | null;
  roomType: string | null;
  channelId: number | null;
  channel: string | null;
  /** 区间内占用的第一晚（含，YYYY-MM-DD） */
  firstNight: string;
  /** 区间内占用的最后一晚（含，YYYY-MM-DD） */
  lastNight: string;
  /** 区间内占用晚数（≥ 1） */
  nights: number;
};

/*
 * 与 occupancyMetrics 两条 SQL 同口径的「明细版」。
 *
 * 参数顺序（共 10 个占位符）：
 *   [from, to, to, to, to, from, hotelId, to, to, from]
 *
 * 为什么 WHERE 用 (在住 AND check_in <= to) OR (已退房 AND check_in <= to AND 终点 > from)
 * 而不是照抄那两条 SQL 的完整条件：
 *   第一条 SQL 的净条件 = 在住 AND check_in <= to（两个 OR 分支都要求 check_in <= to）；
 *   第二条 SQL 的净条件 = 已退房 AND check_in <= to AND coalesce(actual, expect, check_in) > from。
 * 两条都是「把同一批单按状态拆开」，所以这里用状态分支把它们合起来就是同一批单，
 * 而且不会出现「漏掉延后退房单」（延后退房 actual > expect，只看 expect 会漏）。
 */
const STAY_NIGHT_SLICE_SQL = `
  SELECT s.id AS stay_id,
         s.status AS status,
         s.guest_name AS guest_name,
         rt.id AS room_type_id,
         rt.name AS room_type,
         c.id AS channel_id,
         c.name AS channel,
         MAX(substr(s.check_in_time, 1, 10), ?) AS first_night,
         CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day')
              ELSE MIN(COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out),
                       date(?, '+1 day'))
         END AS last_night_exclusive,
         MAX(0, CAST(ROUND(
           julianday(CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day')
                          ELSE MIN(COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out),
                                   date(?, '+1 day'))
                     END)
           - julianday(MAX(substr(s.check_in_time, 1, 10), ?))
         ) AS INTEGER)) AS nights
    FROM stays s
    LEFT JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN channels c ON c.id = s.channel_id
   WHERE s.hotel_id = ?
     AND s.status IN ('INHOUSE', 'CHECKED_OUT')
     AND COALESCE(s.rate_code, '') <> '钟点'
     AND (
           (s.status = 'INHOUSE' AND substr(s.check_in_time, 1, 10) <= ?)
        OR (s.status = 'CHECKED_OUT'
            AND substr(s.check_in_time, 1, 10) <= ?
            AND COALESCE(NULLIF(substr(s.actual_check_out, 1, 10), ''), s.expect_check_out,
                         substr(s.check_in_time, 1, 10)) > ?)
         )
   ORDER BY s.id`;

/**
 * 日期字符串 +n 天（纯整数运算，不经过 Date 的时区转换）
 *
 * 之前是用「带 Z 的 ISO 串 + 毫秒加法 + ISO 输出」实现的，语义上是对的
 * （输入带 Z、输出也是 UTC，时区相消），但项目里有一条静态守卫测试
 * 禁止 X-toISOString-slice 这种「取日期」的写法 —— 因为那种写法在
 * **不带 Z** 的场景下凌晨会落前一天，历史上踩过坑；静态检查分不清
 * 「带 Z 的安全用法」和「不带的危险用法」。
 *
 * 所以改成显式的年月日整数运算：不经过任何时区转换，也天然满足守卫。
 */
function shiftDay(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * 逐条入住单的区间占用明细。
 *
 * 只返回「本区间内真正占用过至少一晚」的单（nights ≥ 1），
 * 与 occupancyMetrics 里 SUM 的语义一致：没有占用的单贡献 0。
 */
export function stayNightSlices(hotelId: number, from: string, to: string): StayNightSlice[] {
  const rows = all<{
    stay_id: number;
    status: string;
    guest_name: string | null;
    room_type_id: number | null;
    room_type: string | null;
    channel_id: number | null;
    channel: string | null;
    first_night: string;
    last_night_exclusive: string | null;
    nights: number | null;
  }>(STAY_NIGHT_SLICE_SQL, [from, to, to, to, to, from, hotelId, to, to, from]);

  const out: StayNightSlice[] = [];
  for (const r of rows) {
    const nights = Math.max(0, Math.round(Number(r.nights ?? 0)));
    if (nights <= 0) continue;
    const first = String(r.first_night ?? "");
    if (!first) continue;
    const lastInclusive = shiftDay(String(r.last_night_exclusive ?? ""), -1);
    out.push({
      stayId: Number(r.stay_id),
      status: String(r.status ?? ""),
      guestName: r.guest_name == null ? null : String(r.guest_name),
      roomTypeId: r.room_type_id == null ? null : Number(r.room_type_id),
      roomType: r.room_type == null ? null : String(r.room_type),
      channelId: r.channel_id == null ? null : Number(r.channel_id),
      channel: r.channel == null ? null : String(r.channel),
      firstNight: first,
      lastNight: lastInclusive || shiftDay(first, nights - 1),
      nights,
    });
  }
  return out;
}

/**
 * 逐日间夜（营业日 → 当晚被占用的房间数）。
 *
 * 报表的「综合营业日报」「房费日报表」逐日表格用它，
 * 合计行则用 occupancyMetrics(...).roomNights —— 两者相等（见文件头恒等式）。
 * 区间内的每一天都会出现在 Map 里（没有住客的天为 0），便于逐日表格直接取。
 */
export function nightSeries(hotelId: number, from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  const total = dayCount(from, to);
  for (let i = 0; i < total; i += 1) out.set(shiftDay(from, i), 0);

  for (const slice of stayNightSlices(hotelId, from, to)) {
    for (let i = 0; i < slice.nights; i += 1) {
      const day = shiftDay(slice.firstNight, i);
      const cur = out.get(day);
      /* 区间外的晚数不写进来（SQL 已夹取，这里只是防御） */
      if (cur !== undefined) out.set(day, cur + 1);
    }
  }
  return out;
}
