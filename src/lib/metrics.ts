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
 *   · **分母按「每个营业日」取，历史日一律优先用当时的夜审快照**
 *     （上线评审 P1：原来算昨天/上月的出租率时用「当前房态」当分母，
 *      昨天锁房今天解锁，昨天的报表就会跟着变 —— 详见下面 historicalSellable）
 *   · 钟点房不算出租间夜（它是按时段卖的，不是过夜）
 *   · ADR 除以「已售房量」而不是「总房量」
 *
 * ── 这个文件怎么用 ──
 * 三个模块统一 import 这里的函数，不再各写一份 SQL。
 * 允许统计区间（from/to）与单日（传同一个日期）两种调用。
 */
import { all, get } from "@/lib/db";
import { bizDate, bizToday } from "@/lib/biz-date";

export type OccupancyMetrics = {
  /** 统计天数（闭区间，含首尾） */
  days: number;
  /** 总房量（含维修房/锁房）—— 当前房态值，仅用于展示「共 N 间」 */
  totalRooms: number;
  /**
   * 可售房量（扣 OOO / LOCK）
   *
   * 单日调用 = **那一天**的可售房量（历史日优先取当日夜审快照，见 historicalSellable）；
   * 区间调用 = 区间平均每日可售房量 = sellableRoomNights ÷ days。
   * 区间内房量有变化时它可能不是整数 —— 真正的分母是 sellableRoomNights。
   */
  sellableRooms: number;
  /**
   * 可售房晚合计 = Σ 每个营业日的可售房量
   *
   * **这才是出租率 / RevPAR 的分母**（单日时等于 sellableRooms）。
   * 为什么不是 sellableRooms × days：区间内每天的房量可能不同（维修/锁房/增减房），
   * 用一个平均值在末尾乘天数会引入误差；逐日累加才是「一共卖得出多少个房晚」。
   */
  sellableRoomNights: number;
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
  /**
   * 分母里有没有「缺历史快照、只能估算」的营业日（区间里有一天是估算 → true）
   *
   * 报表在 true 时应提示「部分日期的可售房量为估算值」（见 estimatedDays）。
   * 注意：**今天/未来**不算估算 —— 那一天的房态就是事实，标的是 live。
   */
  estimated: boolean;
  /** 具体哪些营业日的分母是估算来的（YYYY-MM-DD，按日期升序，供报表逐日提示） */
  estimatedDays: string[];
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

/* ================================================================== *
 * 历史可售房晚（上线评审 P1：跨期出租率把「当前房态」当分母）
 *
 * ── 问题（评审原文，真库可复现）──
 * 本来的分母是这一条：直接数 `rooms.status` 的当前快照 ——
 *
 *     SELECT COUNT(*) AS total,
 *            COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
 *       FROM rooms WHERE hotel_id = ?
 *
 * 它描述的是「**此刻**有几间房卖不了」，却被拿去当「昨天 / 上月」的分母。
 * 于是：
 *   · 11-24 有 2 间锁房 → 夜审日报 21 / 43 = 48.8%；
 *   · 11-25 那 2 间解了锁 → 同一张 11-24 的报表变成 21 / 46 = 45.7%。
 * 数字会跟着**今天**的房态动，历史报表不可复核 —— 这是 P1。
 *
 * ── 修法：分母按「每个营业日」取，历史日优先用当晚的夜审快照 ──
 * 夜审（night-audit/actions.ts）在当晚就把两个数冻进 night_audits：
 *     rooms_sold = 出租间夜，occupancy = 出租间夜 / 可售房量
 * 写入侧保证 occupancy 的分母就是「当日可售房量」（扣 OOO / LOCK），
 * 这条不变量由 scripts/test-night-audit-occupancy.mjs 静态锁死。
 * 所以当日可售房量可以**精确反解**：
 *
 *     可售房量 = rooms_sold / occupancy
 *
 * 反解出来的就是「夜审当时那个分母」，之后房态怎么变都与它无关。
 *
 * ── 为什么是方案 A（复用 night_audits 现有字段），不是方案 B（新建快照表）──
 * 1. night_audits 里已有 occupancy 与 rooms_sold 两个**冻结**值，反解即得历史分母，
 *    误差只有浮点级（24 / 0.5333… = 45.00000000000001 → 取整 45）；
 * 2. 方案 B 需要新建 room_capacity_snapshots 并让**夜审写入路径**往里写。
 *    本次整改范围不允许改 night-audit/actions.ts，改不了写入侧的新表永远没人写，
 *    历史分母还是只能估算 —— 等于把同一个问题换个表放；
 * 3. 反解对老数据同样成立：第 4 轮 P1-5 之前的夜审行分母是「总房量」，
 *    反解出来就是当时那个总房量，仍然属于「当时的口径」，不会随今天漂移。
 *
 * ── 反解失败时怎么办（缺历史值 → 估算 + 提示）──
 *   · 当晚一个人都没住（rooms_sold = 0）：0 / 0 反解不出分母
 *     → 退到「最近一次可反解的夜审快照」（房量通常只随装修/锁房小幅变动）；
 *   · 一天快照都没有（新店 / 从没跑过夜审）
 *     → 退到当前房态，并标记 source = "estimate"；
 *   · 今天与未来还没到夜审：当前房态本身就是事实，直接用它并标记 live ——
 *     这一类**不算**「缺历史值估算」（否则今天的出租率会莫名其妙被标成估算）。
 *
 * ── 口径边界（写清楚，免得下次又有人「顺手优化」）──
 *   · 今天（营业日 >= bizToday）→ 当前房态，live = true；
 *   · 历史日有可反解快照      → 快照，source = "audit"；
 *   · 历史日无可用快照        → 邻近日快照 / 当前房态，source = "estimate"（报表提示估算）；
 *   · 反解只取分母，**分子仍按 stays 的历史占用重算** ——
 *     P1 修的是「分母跟着今天变」，分子本来就是历史事实（提前退房那类变化是应该变的）。
 * ================================================================== */

/** 出租率分母（可售房量）的来源 */
export type SellableSource =
  /** 夜审快照：当晚落库的「出租间夜 / 可售房量」反解值，冻结，不再随房态变化 */
  | "audit"
  /** 缺历史快照：估算值（当前房态 / 邻近日快照），报表应提示 */
  | "estimate";

/** 估算依据（source = "estimate" 时才需要看；audit 固定是 "night-audit"） */
export type SellableBasis =
  /** 当日夜审快照反解（source = "audit" 时） */
  | "night-audit"
  /** 邻近日的夜审快照（该日自己没有可用快照） */
  | "neighbor-night-audit"
  /** 当前房态的 OOO / LOCK 快照（rooms 表只有 status，没有维修起止日期） */
  | "current-rooms"
  /** 连房间都没有（空店 / 只有房型没房间） */
  | "none";

/** 一个营业日的可售房量（出租率分母） */
export type HistoricalSellableDay = {
  /** 营业日 YYYY-MM-DD */
  day: string;
  /** 当日可售房量 = 总房量 − 当日 OOO − 当日 LOCK */
  sellable: number;
  /** audit = 夜审快照（冻结）；estimate = 估算（缺历史值） */
  source: SellableSource;
  /** 这个数是从哪来的（排查报表「为什么是 45」时看它） */
  basis: SellableBasis;
  /**
   * true = 今天/未来，还没到夜审，用当前房态实时值。
   *
   * 这一类的数和「当前房态」本来就是同一个东西（不是缺值猜测），
   * 所以不计入 estimatedDays；历史日报里出现 live = true 才需要提示估算。
   */
  live: boolean;
};

/**
 * 当前房态下的房量（总数 / 可售数）—— 今天与「缺历史值」时的唯一来源
 *
 * ⚠️ 这段 SQL 的文本被 scripts/test-night-audit-occupancy.mjs 逐字比对
 *    （与 night-audit/actions.ts 的可售房量 SQL 同口径），
 *    搬位置可以，改文本必须同步那两个脚本的常量。
 */
const ROOMS_CAPACITY_SQL = `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
       FROM rooms WHERE hotel_id = ?`;

/** 当前房态房量（一条查询，两个数一起取，避免两次扫 rooms 表的口径漂移） */
function roomsCapacity(hotelId: number): { total: number; sellable: number } {
  const row = get<{ total: number; sellable: number }>(ROOMS_CAPACITY_SQL, [hotelId]);
  return { total: Number(row?.total ?? 0), sellable: Number(row?.sellable ?? 0) };
}

/**
 * 从夜审行反解「当晚可售房量」：sellable = rooms_sold / occupancy
 *
 * 返回 null = 这一行不可用（后续按估算处理），判断条件都写在这里，
 * 免得调用方各写一套「够不够信」的标准：
 *   · rooms_sold / occupancy 必须都是正数（0 / 0 反解不出分母，0 间夜也不能证明房量）；
 *   · 反解值必须是整数房量的 **0.25 间以内**：
 *     写入侧存的是双精度原值（21 / 43 = 0.4883720930232558），
 *     回解误差在 1e-13 级；放宽到 0.25 是为了容忍「有人把 occupancy 手写成两位小数」
 *     （0.49 → 42.857，仍在容差内），同时能挡住「occupancy 和 rooms_sold 根本不是同一天」
 *     这种脏数据；
 *   · 可售房量不可能小于当晚已售房量（卖出去的房间一定来自可售房量），
 *     违反说明两个数不同源 → 不认。
 */
function capacityFromAudit(roomsSold: unknown, occupancy: unknown): number | null {
  const sold = Number(roomsSold ?? 0);
  const occ = Number(occupancy ?? 0);
  if (!Number.isFinite(sold) || !Number.isFinite(occ)) return null;
  if (sold <= 0 || occ <= 0) return null;
  const raw = sold / occ;
  if (!Number.isFinite(raw)) return null;
  const capacity = Math.round(raw);
  if (capacity <= 0 || capacity > 100000) return null;
  if (Math.abs(raw - capacity) > 0.25) return null;
  if (capacity < sold) return null;
  return capacity;
}

/**
 * 全店的夜审快照：Map<营业日, 可售房量>
 *
 * 一次读完该店所有夜审行（night_audits 有 UNIQUE(hotel_id, biz_date)，
 * 一天最多一条；5 年也就 1800 行，比按区间逐日查库便宜）。
 * 表不存在 / 列缺失的老库（第一轮迁移前的库）按「没有任何快照」处理，
 * 不让 metrics.ts 因为一张可选的历史表把工作台整页打 500。
 */
function auditedCapacities(hotelId: number): Map<string, number> {
  const out = new Map<string, number>();
  let rows: { biz_date: string | null; rooms_sold: number | null; occupancy: number | null }[];
  try {
    rows = all<{ biz_date: string | null; rooms_sold: number | null; occupancy: number | null }>(
      `SELECT biz_date, rooms_sold, occupancy FROM night_audits WHERE hotel_id = ?`,
      [hotelId]
    );
  } catch {
    return out;
  }
  for (const row of rows) {
    const day = String(row.biz_date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const capacity = capacityFromAudit(row.rooms_sold, row.occupancy);
    if (capacity === null) continue;
    out.set(day, capacity);
  }
  return out;
}

/** 两个 YYYY-MM-DD 相差多少天（纯 UTC 运算；非法日期返回 NaN） */
function dayDiff(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.NaN;
  return Math.round((ta - tb) / 86400000);
}

/**
 * 最近的可用夜审快照（该日自己没有快照时用）
 *
 * `days` 必须是升序。二分找到插入位置，只比较左右两个邻居 ——
 * 房量单调性没有保证（可能装修又复业），最近的那天是最合理的估计。
 * 距离相同时取更早的一天（房量通常只减不增，早的那天更保守）。
 * 快照离得太远（> 366 天）仍然给出来：估算本来就是估算，
 * 与其假装「没有历史值」不如给一个带来源的数字，来源字段会说明白。
 */
function nearestAuditedCapacity(sortedDays: string[], caps: Map<string, number>, day: string): number | null {
  if (sortedDays.length === 0) return null;
  let lo = 0;
  let hi = sortedDays.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDays[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  const candidates: string[] = [];
  if (lo < sortedDays.length) candidates.push(sortedDays[lo]);
  if (lo > 0) candidates.push(sortedDays[lo - 1]);

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(dayDiff(candidate, day));
    if (!Number.isFinite(distance)) continue;
    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best === null) return null;
  return caps.get(best) ?? null;
}

/** 本店当前营业日（读不到 settings 时按自然日兜底，不能让工作台挂掉） */
function currentBizDay(hotelId: number): string {
  try {
    return bizToday(hotelId);
  } catch {
    return bizDate();
  }
}

/**
 * 逐营业日的「可售房量」（出租率 / RevPAR 的分母）
 *
 * 调度顺序（每一类都写清楚了，评审只需要看这一段）：
 *   ① 当日夜审快照可反解   → 用它（source = "audit"，冻结值，报表不再随房态漂移）
 *   ② 今天 / 未来          → 当前房态（live = true，这就是事实，不算估算）
 *   ③ 历史日 + 邻近日有快照 → 邻近日快照（source = "estimate"）
 *   ④ 完全没有历史快照      → 当前房态（source = "estimate"，报表必须提示估算）
 *
 * 返回的 Map 包含区间内**每一天**（key = YYYY-MM-DD，插入顺序 = 日期升序），
 * 调用方不必自己补齐空日。
 *
 * @param hotelId 酒店
 * @param from    起始营业日（含，YYYY-MM-DD）
 * @param to      结束营业日（含，YYYY-MM-DD）
 */
export function historicalSellable(
  hotelId: number,
  from: string,
  to: string
): Map<string, HistoricalSellableDay> {
  const out = new Map<string, HistoricalSellableDay>();
  const days = dayCount(from, to);
  const capacity = roomsCapacity(hotelId);
  const today = currentBizDay(hotelId);
  const caps = auditedCapacities(hotelId);
  const sortedDays = [...caps.keys()].sort();
  /** 当前房态这一支的 basis：一间房都没有时说明「不是没锁房，是没房」 */
  const currentBasis: SellableBasis = capacity.total > 0 ? "current-rooms" : "none";

  for (let i = 0; i < days; i += 1) {
    const day = shiftDay(from, i);

    /* ① 夜审快照（历史日的唯一权威来源） */
    const snapshot = caps.get(day);
    if (snapshot !== undefined) {
      out.set(day, { day, sellable: snapshot, source: "audit", basis: "night-audit", live: false });
      continue;
    }

    /* ② 今天/未来还没夜审：当前房态就是事实 */
    if (day >= today) {
      out.set(day, { day, sellable: capacity.sellable, source: "estimate", basis: currentBasis, live: true });
      continue;
    }

    /* ③ 历史日没有当日快照：退到最近一次夜审快照 */
    const nearest = nearestAuditedCapacity(sortedDays, caps, day);
    if (nearest !== null) {
      out.set(day, { day, sellable: nearest, source: "estimate", basis: "neighbor-night-audit", live: false });
      continue;
    }

    /* ④ 一天快照都没有：只能拿当前房态估算（报表据此提示「估算」） */
    out.set(day, { day, sellable: capacity.sellable, source: "estimate", basis: currentBasis, live: false });
  }
  return out;
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

  /*
   * ── 分母：逐营业日的可售房量（上线评审 P1 修复点）──
   *
   * 原来这里是一条「当前房态」查询，区间内所有天共用它：
   *     昨天锁房 → 昨天 21/43；今天解锁 → 同一张昨日报表变成 21/46。
   * 现在改成按天取（historicalSellable：夜审快照优先，缺值才估算），
   * 再累加成「可售房晚」当分母 —— 历史报表从此不随今天的房态漂移。
   */
  const capacity = roomsCapacity(hotelId);
  const totalRooms = capacity.total;

  const sellableByDay = historicalSellable(hotelId, from, to);
  let sellableRoomNightsRaw = 0;
  const estimatedDays: string[] = [];
  for (const item of sellableByDay.values()) {
    sellableRoomNightsRaw += item.sellable;
    /* live（今天/未来）不算估算：那天的房态就是事实 */
    if (item.source !== "audit" && !item.live) estimatedDays.push(item.day);
  }
  const sellableRoomNights = round2(sellableRoomNightsRaw);
  /** 区间平均每日可售房量（单日时正好等于那天的可售房量） */
  const sellableRooms = days > 0 ? round2(sellableRoomNights / days) : 0;

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

  /*
   * 出租率 / RevPAR 的分母一律用「可售房晚合计」= Σ 每日可售房量。
   *
   * 不用 sellableRooms × days：那只在「区间内每天房量都相同」时才等价。
   * 一旦区间里有锁房 / 维修 / 增减房，平均值乘天数会把误差带进分母
   * （sellableRooms 还带着 2 位小数的取整），逐日累加才是真值。
   * 单日调用时 sellableRoomNights === sellableRooms，与旧口径逐位相同。
   */
  const occupancy = sellableRoomNights > 0 ? roomNights / sellableRoomNights : 0;
  const adr = roomsSold > 0 ? round2(roomRevenue / roomsSold) : 0;
  const revpar = sellableRoomNights > 0 ? round2(roomRevenue / sellableRoomNights) : 0;

  return {
    days,
    totalRooms,
    sellableRooms,
    sellableRoomNights,
    roomNights,
    roomsSold,
    roomRevenue,
    occupancy,
    adr,
    revpar,
    estimated: estimatedDays.length > 0,
    estimatedDays,
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

/**
 * 「可售房量是估算值」的提示文案（报表 / 工作台直接展示）
 *
 * 上线评审 P1 要求「缺历史值时提示估算」：分母来自夜审快照时不提示，
 * 一旦区间里有营业日缺快照（historicalSellable 里 source = "estimate" 的历史日），
 * 就返回一句话让店长知道这个出租率不能当财务口径用。
 *
 * 返回 null = 没有任何估算日（全部来自夜审快照，或就是今天/未来的实时值），
 * 调用方 `{hint && <提示条>{hint}</提示条>}` 即可，不必自己判断空串。
 *
 * 例：「可售房量为估算值（缺夜审快照）：2026-11-15、2026-11-16 —— 出租率仅供趋势参考」
 */
export function estimatedHint(metrics: Pick<OccupancyMetrics, "estimated" | "estimatedDays">): string | null {
  if (!metrics.estimated || metrics.estimatedDays.length === 0) return null;
  const days = metrics.estimatedDays;
  /* 超过 5 天只列前 5 天 + 省略，避免提示条被撑爆 */
  const shown = days.length > 5 ? `${days.slice(0, 5).join("、")} 等 ${days.length} 天` : days.join("、");
  return `可售房量为估算值（缺夜审快照）：${shown} —— 出租率仅供趋势参考`;
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
  /**
   * 房间 id / 房号（第九轮：综合营业日报-房间要按「房间 × 营业日」出间夜）。
   *
   * 房间号只用于显示与「房间 × 日」聚合的键；占用口径仍与 occupancyMetrics 一致
   * （同一批 stays、同一套晚数表达式），只是把维度补出来，不改任何数值。
   * 房间已被删除 / 未排房的单为 null，调用方归入「未关联房」。
   */
  roomId: number | null;
  roomNo: string | null;
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
         r.id AS room_id,
         r.room_no AS room_no,
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
    room_id: number | null;
    room_no: string | null;
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
      roomId: r.room_id == null ? null : Number(r.room_id),
      roomNo: r.room_no == null ? null : String(r.room_no),
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
