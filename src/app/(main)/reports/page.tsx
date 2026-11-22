import type { ReactNode } from "react";
import Link from "next/link";
import { all, get } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { addDays, fmtMoney, round2, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* ================================================================== *
 * 一、报表注册表
 * ================================================================== */

type ReportMeta = { label: string; desc: string };

const REPORTS: Record<string, ReportMeta> = {
  "credit-checkin": { label: "闪住对账报表", desc: "闪住订单与渠道结算对账" },
  "sms-report": { label: "短信汇总报表", desc: "短信发送量、成功率与失败原因" },
  "police-report": { label: "公安上传准备清单", desc: "待上传住客身份信息汇总（需对接公安系统接口后自动上传）" },
  "recharge-sum": { label: "会员卡充值汇总表", desc: "按支付方式汇总充值金额" },
  "recharge-salesman": { label: "会员充值明细(销售员)", desc: "按销售员统计充值笔数与金额" },
  "room-biz-daily": { label: "综合营业日报-房间", desc: "逐日 × 房间的房费与间夜" },
  "member-topup": { label: "会员储值明细报表", desc: "会员储值余额变动流水" },
  "salesman-card": { label: "销售员发卡报告", desc: "按销售员统计发卡数量与卡内金额" },
  "salesman-card-detail": { label: "销售员发卡明细报告", desc: "逐张卡的发卡记录与销售员" },
  "member-consume-rank": { label: "会员消费排名表", desc: "按累计消费排序的会员消费榜" },
  "members-upgrade": { label: "会员升级报表", desc: "等级变动的会员清单" },
  "goods-stock": { label: "小商品库存报表", desc: "商品库存、售价与库存金额" },
  "channel-report": { label: "渠道统计报表", desc: "按渠道统计订单数、间夜与营收" },
  "channel-report-detail": { label: "渠道统计明细表", desc: "逐笔渠道订单明细" },
  "member-list-report": { label: "会员报表", desc: "会员卡号、姓名、等级、累计消费与最近入住" },
  "score-detail-report": { label: "会员积分明细报表", desc: "逐笔积分流水（会员 / 类型 / 积分 / 余额）" },
  "invoice-report": { label: "发票明细表", desc: "开票记录清单（账单 / 抬头 / 金额 / 时间）" },
  "realtime-report": { label: "实时房态报表", desc: "当前各房态房间数与占比，按楼层/房型拆分" },
  "cancel-order-report": { label: "预订取消/失约报表", desc: "取消与 NO-SHOW 订单清单及原因分布" },
  "cleaner-perf": { label: "打扫员业绩报表", desc: "按打扫员统计完成间数与工作量" },
  "epidemic-report": { label: "防疫数据汇表", desc: "入住客人体温/健康码等防疫登记汇总" },
  summary: { label: "酒店经营总表", desc: "门店收入、收款、应收与经营项目明细的总览" },
  "room-revenue": { label: "客房收益报表", desc: "按房型统计间夜、房费、ADR、RevPAR 与收入占比" },
  "shift-report": { label: "交班报表", desc: "按早/中/夜班统计收款笔数、金额与支付方式拆分" },
  "shift-summary": { label: "交班汇总表", desc: "按操作人汇总收款、退款与净收" },
  "folio-daily": { label: "结账单日报表", desc: "当日已退房并结清的账单清单" },
  "consume-detail": { label: "消费明细报表", desc: "账务明细逐条流水（营业日 / 类型 / 摘要 / 金额）" },
  "receipt-summary": { label: "收款明细汇总表", desc: "收款流水按支付方式汇总" },
  "finance-overview": { label: "财务概况", desc: "收入、成本、毛利、出租率与间夜一览" },
  "sales-overview": { label: "销售概况", desc: "按客源渠道统计间夜、营收与渠道佣金" },
  "member-overview": { label: "会员概况", desc: "会员数、会员消费、会员间夜与占比" },
  "biz-type": { label: "经营项目类型表", desc: "按科目类型（房费 / 餐饮 / 其他 / 押金 / 调整）汇总" },
  "biz-total": { label: "经营项目汇总表", desc: "按摘要归并统计经营项目发生额" },
  "biz-daily": { label: "综合营业日报", desc: "逐日的间夜、房费、餐饮、其他收入与出租率" },
  "room-type-daily": { label: "综合营业日报-房型", desc: "逐日 × 房型的房费矩阵" },
  "floor-daily": { label: "综合营业日报-楼层", desc: "逐日 × 楼层的房费矩阵" },
  "room-daily": { label: "综合营业日报-房间", desc: "逐日 × 房间号的房费矩阵" },
  "room-fee-daily": { label: "房费日报表", desc: "逐日房费、平均房价与出租率" },
  "trial-balance": { label: "试算平衡表", desc: "期初 / 收入 / 收款 / 期末与借贷平衡校验" },
  "account-balance": { label: "账户余额", desc: "协议单位授信与挂账单余额" },
  "consume-recover": { label: "消费收回明细报表", desc: "每日消费与收款回收对比" },
  "night-audit": { label: "夜审记录", desc: "夜审营业日的售出房数、营收与出租率" },
  "inhouse-report": { label: "现住客人报表", desc: "当前在住客人的房间、房价与账务余额" },
  "quick-biz-type": { label: "酒店经营项目类型汇总表", desc: "按类型汇总发生额并列出各类型主要项目" },
  "quick-ar": { label: "AR账发生汇总表", desc: "按渠道统计赊销发生、已收与应收余额" },
  "quick-dun": { label: "催账报表", desc: "当前欠款账单与账龄分布" },
  "quick-fin-ex": { label: "财务异常汇总表", desc: "金额不平 / 负余额 / 已结仍挂账的账单" },
  "quick-fd-ex": { label: "前台操作异常汇总表", desc: "调价、加收消费、换房、取消预订等敏感操作" },

  /* ---------- 新增 20 张 ---------- */
  "deposit-report": { label: "押金报表", desc: "按营业日列出收取 / 已退 / 在压押金明细与收款方式" },
  "credit-guests": { label: "挂账客人报表", desc: "在住及已离店仍有挂账余额的客人清单与账龄" },
  "goods-range": { label: "小商品区间报表", desc: "区间内商超小商品逐条销售流水（日期 / 商品 / 房号 / 金额）" },
  "goods-sales": { label: "小商品销售报表", desc: "按商品名汇总销量、金额与收入占比" },
  "ar-age": { label: "AR账龄报表", desc: "未结账账单按 0-30 / 31-60 / 60+ 天分档的应收账龄" },
  "ar-happen": { label: "AR发生汇总报表", desc: "逐日挂账建账、还款核销与未收余额" },
  "ar-account": { label: "AR账报表", desc: "每个协议单位的建账、已收、余额与授信占用" },
  "salesman-detail": { label: "销售员业绩明细表", desc: "按销售员展开的订单明细与小计" },
  "salesman-summary": { label: "销售员业绩汇总表", desc: "按销售员汇总订单数、间夜、营收与佣金" },
  "company-detail": { label: "协议客户销售明细表", desc: "按协议单位展开的订单明细与间夜营收" },
  "company-summary": { label: "协议客户销售汇总表", desc: "按协议单位汇总订单、间夜、营收与折扣" },
  "change-room": { label: "换房报表", desc: "换房操作日志、房态变更与预订房/实际房差异" },
  "reverse-detail": { label: "冲账明细报表", desc: "负数调整（冲账）明细及操作人" },
  "extra-room-fee": { label: "离店客人房费加收表", desc: "加收项目与入住日之后补记的房费" },
  "expected-arrivals": { label: "预抵客人报表", desc: "未来 7 天待排房 / 已确认的预抵订单" },
  "price-change": { label: "调价报表", desc: "调价操作记录及关联在住订单" },
  "free-room": { label: "免费房报表", desc: "零房价或备注免费的住宿与预订" },
  "hourly-orders": { label: "时租房报表", desc: "钟点房（nights = 0）订单与在店时长" },
  "package-report": { label: "包价报表", desc: "使用包价的订单与包价设置对照" },
  "breakfast-report": { label: "早餐报表", desc: "按日期 / 房号统计早餐核销份数" },
};

const DEFAULT_KEY = "summary";

function metaOf(key: string): ReportMeta {
  return REPORTS[key] ?? REPORTS[DEFAULT_KEY];
}

/* 左侧树形菜单 */
type MenuNode =
  | { kind: "leaf"; key: string }
  | { kind: "group"; title: string; keys: string[] };

const MENU: MenuNode[] = [
  { kind: "leaf", key: "summary" },
  { kind: "leaf", key: "room-revenue" },
  {
    kind: "group",
    title: "交班报表",
    keys: ["shift-report", "shift-summary", "folio-daily", "consume-detail", "receipt-summary"],
  },
  {
    kind: "group",
    title: "经营报表",
    keys: [
      "finance-overview",
      "sales-overview",
      "goods-range",
      "goods-sales",
      "change-room",
      "price-change",
      "free-room",
      "hourly-orders",
      "package-report",
      "breakfast-report",
      "expected-arrivals",
    ],
  },
  {
    kind: "group",
    title: "财务报表",
    keys: [
      "biz-type",
      "biz-total",
      "biz-daily",
      "room-type-daily",
      "room-daily",
      "floor-daily",
      "room-fee-daily",
      "trial-balance",
      "account-balance",
      "consume-recover",
      "deposit-report",
      "credit-guests",
      "ar-age",
      "ar-happen",
      "ar-account",
      "reverse-detail",
      "extra-room-fee",
    ],
  },
  {
    kind: "group",
    title: "会员报表",
    keys: ["member-overview", "salesman-detail", "salesman-summary", "company-detail", "company-summary"],
  },
  {
    kind: "group",
    title: "夜审与在住",
    keys: ["night-audit", "inhouse-report"],
  },
  {
    kind: "group",
    title: "异常与催收",
    keys: ["quick-biz-type", "quick-ar", "quick-dun", "quick-fin-ex", "quick-fd-ex"],
  },
];

/* 顶部常用报表 */
const TABS: { key: string; label: string }[] = [
  { key: "room-revenue", label: "客房收益" },
  { key: "summary", label: "酒店经营" },
  { key: "biz-daily", label: "综合营业" },
  { key: "shift-report", label: "交班报表" },
  { key: "night-audit", label: "夜审记录" },
  { key: "consume-detail", label: "消费明细" },
  { key: "biz-type", label: "经营项目" },
  { key: "inhouse-report", label: "现住客人" },
  { key: "receipt-summary", label: "收款明细" },
];

/* 快速查看 */
const QUICK_VIEWS: { key: string; label: string }[] = [
  { key: "quick-biz-type", label: "酒店经营项目类型汇总表" },
  { key: "quick-ar", label: "AR账发生汇总表" },
  { key: "quick-dun", label: "催账报表" },
  { key: "quick-fin-ex", label: "财务异常汇总表" },
  { key: "quick-fd-ex", label: "前台操作异常汇总表" },
];

/** 左侧菜单里某一项所属的分组名（用于面包屑） */
function groupOf(key: string): string {
  for (const node of MENU) {
    if (node.kind === "group" && node.keys.includes(key)) return node.title;
  }
  return "常用报表";
}

/* ================================================================== *
 * 二、日期区间
 * ================================================================== */

const RANGE_PRESETS = ["yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth"] as const;
type RangeKey = (typeof RANGE_PRESETS)[number];

const RANGE_LABEL: Record<RangeKey, string> = {
  yesterday: "昨日",
  thisWeek: "本周",
  lastWeek: "上周",
  thisMonth: "本月",
  lastMonth: "上月",
};

const CMP_KEYS = ["lastWeek", "lastMonth", "lastYear"] as const;
type CmpKey = (typeof CMP_KEYS)[number];

const CMP_LABEL: Record<CmpKey, string> = {
  lastWeek: "对比上周同期",
  lastMonth: "对比上月同期",
  lastYear: "对比去年同期",
};

const CMP_SHORT: Record<CmpKey, string> = {
  lastWeek: "上周",
  lastMonth: "上月",
  lastYear: "去年",
};

function isRangeKey(v: string | undefined): v is RangeKey {
  return typeof v === "string" && (RANGE_PRESETS as readonly string[]).includes(v);
}

function isCmpKey(v: string | undefined): v is CmpKey {
  return typeof v === "string" && (CMP_KEYS as readonly string[]).includes(v);
}

function parseDay(s: string | undefined | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfWeek(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7; // 周一为 0
  d.setDate(d.getDate() - offset);
  return d;
}

function resolveRange(key: RangeKey, today: Date): { from: string; to: string } {
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  switch (key) {
    case "yesterday": {
      const y = addDays(t, -1);
      return { from: todayStr(y), to: todayStr(y) };
    }
    case "thisWeek":
      return { from: todayStr(startOfWeek(t)), to: todayStr(t) };
    case "lastWeek": {
      const s = startOfWeek(t);
      return { from: todayStr(addDays(s, -7)), to: todayStr(addDays(s, -1)) };
    }
    case "thisMonth":
      return { from: todayStr(new Date(t.getFullYear(), t.getMonth(), 1)), to: todayStr(t) };
    case "lastMonth":
      return {
        from: todayStr(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
        to: todayStr(new Date(t.getFullYear(), t.getMonth(), 0)),
      };
  }
}

function shiftMonthDay(s: string, delta: number): string {
  const d = parseDay(s);
  if (!d) return s;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return todayStr(d);
}

function shiftYearDay(s: string, delta: number): string {
  const d = parseDay(s);
  if (!d) return s;
  const day = d.getDate();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + delta);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return todayStr(d);
}

function comparisonRange(from: string, to: string, cmp: CmpKey): { from: string; to: string } {
  if (cmp === "lastWeek") {
    return { from: todayStr(addDays(from, -7)), to: todayStr(addDays(to, -7)) };
  }
  if (cmp === "lastMonth") {
    return { from: shiftMonthDay(from, -1), to: shiftMonthDay(to, -1) };
  }
  return { from: shiftYearDay(from, -1), to: shiftYearDay(to, -1) };
}

function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = parseDay(from);
  const end = parseDay(to);
  if (!cur || !end) return out;
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 400) {
    out.push(todayStr(cur));
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

/* ================================================================== *
 * 三、格式化
 * ================================================================== */

/*
 * 百分比显示（整改清单 P2-9）
 *
 * 旧实现 `if (!Number.isFinite(n) || n <= 0) return "0.00%"` 有两个毛病：
 *   1. 负值被吞成 0.00%。毛利率为负（退款冲减大于收入）、回收率为负、
 *      「其他收入」里退货多于销售而形成负数占比时，页面一律显示 0.00% ——
 *      等于把亏损/红字伪装成零，报表最重要的异常信号被抹掉了。
 *   2. 精度不统一。本文件用 2 位小数，`night-audit/page.tsx` 的 fmtPct 用
 *      1 位小数，同一个出租率在「夜审记录」报表里是 65.22%、在夜审页是 65.2%。
 *      现在两处统一为 2 位小数（财务口径），负值原样带出。
 *
 * `-0.004` 这类算出 -0.00001 的值会格式化成 "-0.00%"，读起来像有值其实是零，
 * 这里把绝对值小于半个百分位（0.005%）的负数归零，避免出现 "-0.00%"。
 */
function fmtPct(v: number): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0.00%";
  const pct = n * 100;
  if (Math.abs(pct) < 0.005) return "0.00%";
  return `${pct.toFixed(2)}%`;
}

function fmtInt(v: number): string {
  return Number(v ?? 0).toLocaleString("zh-CN");
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 占比（百分数，0 → 100）
 *
 * 旧实现 `n <= 0 || total <= 0` 直接返回 0，负数科目（退货冲减、红字调整）
 * 的占比会静默消失；`Math.min(100, …)` 又只截上限。现在两侧都保留：
 * 负数原样返回（调用方负责条形图宽度不能让负值变成无效 CSS），
 * 上限仍收到 100 —— 浮点除法偶尔会算出 100.0000000001。
 */
function share(n: number, total: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(total) || total === 0) return 0;
  const pct = (n / total) * 100;
  return Math.max(-100, Math.min(100, pct));
}

/**
 * 金额聚合取整（P2-9）
 *
 * 报表合计大量使用 `rows.reduce((s, r) => s + num(r.amount), 0)`，几十条金额
 * 相加会留下 0.0000000001 量级的浮点尾巴。显示时 `fmtMoney` 会格式化掉，
 * 但占比、平衡校验、`balance > 0.005` 这类阈值判断都直接吃这个尾巴。
 * 合计一律走这里收口到「分」。
 */
function sumMoney(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += num(v);
  return round2(total);
}

function dash(v: string | null | undefined): string {
  return v && v.length > 0 ? v : "-";
}

type DeltaInfo = { dir: "up" | "down" | "flat"; text: string };

function moneyDelta(cur: number, prev: number): DeltaInfo {
  if (prev <= 0 && cur <= 0) return { dir: "flat", text: "持平" };
  if (prev <= 0) return { dir: "flat", text: "0" };
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.005) return { dir: "flat", text: "持平" };
  return { dir: pct > 0 ? "up" : "down", text: `${Math.abs(pct).toFixed(2)}%` };
}

function countDelta(cur: number, prev: number, unit = "次"): DeltaInfo {
  const diff = cur - prev;
  if (diff === 0) return { dir: "flat", text: "持平" };
  return { dir: diff > 0 ? "up" : "down", text: `${Math.abs(diff)}${unit}` };
}

/* ================================================================== *
 * 四、业务常量
 * ================================================================== */

const ITEM_TYPE_LABEL: Record<string, string> = {
  ROOM: "房费",
  FOOD: "餐饮",
  OTHER: "其他",
  DEPOSIT: "押金",
  ADJUST: "调整",
};

const ITEM_TYPE_CLS: Record<string, string> = {
  ROOM: "border-blue-200 bg-blue-50 text-blue-700",
  FOOD: "border-amber-200 bg-amber-50 text-amber-700",
  OTHER: "border-violet-200 bg-violet-50 text-violet-700",
  DEPOSIT: "border-gray-200 bg-gray-50 text-gray-600",
  ADJUST: "border-red-200 bg-red-50 text-red-600",
};

const VIP_LABEL: Record<number, string> = {
  0: "普通客",
  1: "银卡会员",
  2: "金卡会员",
  3: "白金会员",
  4: "钻石会员",
};

const PAY_METHOD_ORDER: string[] = ["现金", "微信", "支付宝", "银行卡", "挂账", "储值卡"];

const SHIFT_DEFS: { key: string; label: string; window: string }[] = [
  { key: "早班", label: "早班", window: "08:00-16:00" },
  { key: "中班", label: "中班", window: "16:00-24:00" },
  { key: "夜班", label: "夜班", window: "00:00-08:00" },
];

const SENSITIVE_ACTIONS = ["调价", "加收消费", "换房", "取消预订"];

/* 明细项目分类（其他收入按摘要归类） */
const OTHER_CATEGORIES = [
  {
    label: "娱乐",
    match:
      "(description LIKE '%娱乐%' OR description LIKE '%KTV%' OR description LIKE '%棋牌%' OR description LIKE '%酒吧%')",
  },
  {
    label: "电话",
    match: "(description LIKE '%电话%' OR description LIKE '%话费%' OR description LIKE '%长途%')",
  },
  {
    label: "会议",
    match: "(description LIKE '%会议%' OR description LIKE '%会场%' OR description LIKE '%宴会%')",
  },
  {
    label: "客房收费",
    match:
      "(description LIKE '%客房%' OR description LIKE '%洗衣%' OR description LIKE '%迷你吧%' OR description LIKE '%赔偿%' OR description LIKE '%加床%')",
  },
] as const;

const OTHER_MATCH_ALL = `(${OTHER_CATEGORIES.map((c) => c.match).join(" OR ")})`;

const CATEGORY_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END), 0) AS room,
    COALESCE(SUM(CASE WHEN item_type = 'FOOD' THEN amount ELSE 0 END), 0) AS food,
    COALESCE(SUM(CASE WHEN item_type = 'OTHER' THEN amount ELSE 0 END), 0) AS other_total,
    COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN qty ELSE 0 END), 0) AS nights,
    ${OTHER_CATEGORIES.map(
      (c, i) =>
        `COALESCE(SUM(CASE WHEN item_type = 'OTHER' AND ${c.match} THEN amount ELSE 0 END), 0) AS c${i}`
    ).join(",\n    ")},
    COALESCE(SUM(CASE WHEN item_type = 'OTHER' AND NOT ${OTHER_MATCH_ALL} THEN amount ELSE 0 END), 0) AS other_rest
  FROM folio_items
  WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND item_type IN ('ROOM','FOOD','OTHER')
`;

/* ================================================================== *
 * 五、数据访问层（全部报表的数据源）
 * ================================================================== */

type CategoryAgg = {
  room: number;
  food: number;
  otherTotal: number;
  nights: number;
  rows: { label: string; amount: number }[];
  income: number;
};

function categoryAgg(hotelId: number, from: string, to: string): CategoryAgg {
  const raw = get<Record<string, number>>(CATEGORY_SQL, [hotelId, from, to]) ?? {};
  /* 聚合结果一律 round2（P2-9）：这些值会被上层再次相加/相除，
     浮点尾巴（9999.999999999998）会传导到毛利率、占比和平衡校验里 */
  const room = round2(num(raw.room));
  const food = round2(num(raw.food));
  const otherTotal = round2(num(raw.other_total));
  const rows: { label: string; amount: number }[] = [
    { label: "房费", amount: room },
    { label: "餐饮", amount: food },
    ...OTHER_CATEGORIES.map((c, i) => ({ label: c.label, amount: round2(num(raw[`c${i}`])) })),
    { label: "其他收入", amount: round2(num(raw.other_rest)) },
  ];
  return {
    room,
    food,
    otherTotal,
    nights: num(raw.nights),
    rows,
    income: round2(room + food + otherTotal),
  };
}

function paymentAgg(hotelId: number, from: string, to: string): { amount: number; cnt: number } {
  const row = get<{ amount: number; cnt: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS cnt
     FROM payments WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?`,
    [hotelId, from, to]
  );
  return { amount: round2(num(row?.amount)), cnt: num(row?.cnt) };
}

function receivableAgg(hotelId: number): { total: number; cnt: number } {
  const row = get<{ total: number; cnt: number }>(
    `SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) AS cnt
     FROM folios WHERE hotel_id = ? AND balance > 0.005`,
    [hotelId]
  );
  return { total: round2(num(row?.total)), cnt: num(row?.cnt) };
}

/** 账务异常：账单金额不平 / 负余额（多收）/ 已结账仍挂余额 */
function financeAnomalyCount(hotelId: number, from: string, to: string): number {
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM folios
     WHERE hotel_id = ?
       AND date(created_at, '+8 hours') BETWEEN ? AND ?
       AND (
         ABS(COALESCE(total_amount, 0) - COALESCE(paid_amount, 0) - COALESCE(balance, 0)) > 0.01
         OR COALESCE(balance, 0) < -0.01
         OR (status = 'SETTLED' AND COALESCE(balance, 0) > 0.01)
       )`,
    [hotelId, from, to]
  );
  return num(row?.n);
}

/** 前台操作异常：冲账调整 / 有余额无明细 / 负数明细 */
function frontDeskAnomalyCount(hotelId: number, from: string, to: string): number {
  const row = get<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM folio_items fi
         WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ? AND fi.item_type = 'ADJUST')
     + (SELECT COUNT(*) FROM folios f
         WHERE f.hotel_id = ? AND date(f.created_at, '+8 hours') BETWEEN ? AND ?
           AND f.balance > 0.01
           AND NOT EXISTS (SELECT 1 FROM folio_items x WHERE x.folio_id = f.id))
     + (SELECT COUNT(*) FROM folio_items fi
         WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ?
           AND fi.item_type IN ('ROOM','FOOD','OTHER') AND fi.amount < 0) AS n`,
    [hotelId, from, to, hotelId, from, to, hotelId, from, to]
  );
  return num(row?.n);
}

/** 房态一致性（当前实时状态） */
function roomStateMismatch(hotelId: number): { total: number; noStay: number; noRoom: number } {
  const row = get<{ no_stay: number; no_room: number }>(
    `SELECT
       (SELECT COUNT(*) FROM stays s JOIN rooms r ON r.id = s.room_id
         WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND r.status NOT IN ('OC','OD')) AS no_stay,
       (SELECT COUNT(*) FROM rooms r
         WHERE r.hotel_id = ? AND r.status IN ('OC','OD')
           AND NOT EXISTS (SELECT 1 FROM stays s2 WHERE s2.room_id = r.id AND s2.status = 'INHOUSE')) AS no_room`,
    [hotelId, hotelId]
  );
  const noStay = num(row?.no_stay);
  const noRoom = num(row?.no_room);
  return { total: noStay + noRoom, noStay, noRoom };
}

type RoomTypeRow = {
  name: string | null;
  nights: number;
  room: number;
  food: number;
  other: number;
  total: number;
};

function roomTypeAgg(hotelId: number, from: string, to: string): RoomTypeRow[] {
  return all<RoomTypeRow>(
    `SELECT COALESCE(rt.name, '未分房型') AS name,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.qty ELSE 0 END), 0) AS nights,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.amount ELSE 0 END), 0) AS room,
            COALESCE(SUM(CASE WHEN fi.item_type = 'FOOD' THEN fi.amount ELSE 0 END), 0) AS food,
            COALESCE(SUM(CASE WHEN fi.item_type = 'OTHER' THEN fi.amount ELSE 0 END), 0) AS other,
            COALESCE(SUM(fi.amount), 0) AS total
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN rooms r ON r.id = s.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ?
       AND fi.item_type IN ('ROOM','FOOD','OTHER')
     GROUP BY rt.id
     ORDER BY room DESC, nights DESC`,
    [hotelId, from, to]
  );
}

type ChannelRoomRow = { name: string | null; nights: number; room: number };

function channelAgg(hotelId: number, from: string, to: string): ChannelRoomRow[] {
  return all<ChannelRoomRow>(
    `SELECT COALESCE(c.name, '散客') AS name,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.qty ELSE 0 END), 0) AS nights,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.amount ELSE 0 END), 0) AS room
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN channels c ON c.id = s.channel_id
     WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ? AND fi.item_type = 'ROOM'
     GROUP BY c.id
     ORDER BY room DESC`,
    [hotelId, from, to]
  );
}

type DailyRow = {
  biz_date: string;
  room: number;
  food: number;
  other: number;
  nights: number;
};

function dailyAgg(hotelId: number, from: string, to: string): DailyRow[] {
  return all<DailyRow>(
    `SELECT biz_date,
            COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END), 0) AS room,
            COALESCE(SUM(CASE WHEN item_type = 'FOOD' THEN amount ELSE 0 END), 0) AS food,
            COALESCE(SUM(CASE WHEN item_type = 'OTHER' THEN amount ELSE 0 END), 0) AS other,
            COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN qty ELSE 0 END), 0) AS nights
     FROM folio_items
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND item_type IN ('ROOM','FOOD','OTHER')
     GROUP BY biz_date
     ORDER BY biz_date`,
    [hotelId, from, to]
  );
}

type CapacityRow = { name: string | null; rooms: number };

/** 各房型的可售房间数（排除维修 / 锁房） */
function roomTypeCapacity(hotelId: number): CapacityRow[] {
  return all<CapacityRow>(
    `SELECT rt.name AS name,
            COALESCE(SUM(CASE WHEN r.status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS rooms
     FROM room_types rt
     LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = ?
     WHERE rt.hotel_id = ?
     GROUP BY rt.id
     ORDER BY rt.sort, rt.id`,
    [hotelId, hotelId]
  );
}

type PayMethodRow = { method: string | null; cnt: number; amount: number };

function payMethodAgg(hotelId: number, from: string, to: string): PayMethodRow[] {
  return all<PayMethodRow>(
    `SELECT COALESCE(NULLIF(method, ''), '未填方式') AS method,
            COUNT(*) AS cnt,
            COALESCE(SUM(amount), 0) AS amount
     FROM payments
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY method
     ORDER BY amount DESC`,
    [hotelId, from, to]
  );
}

type ShiftPayRow = { shift: string; method: string | null; cnt: number; amount: number };

function shiftPayAgg(hotelId: number, from: string, to: string): ShiftPayRow[] {
  return all<ShiftPayRow>(
    `SELECT CASE
              WHEN CAST(strftime('%H', created_at, '+8 hours') AS INTEGER) BETWEEN 8 AND 15 THEN '早班'
              WHEN CAST(strftime('%H', created_at, '+8 hours') AS INTEGER) >= 16 THEN '中班'
              ELSE '夜班'
            END AS shift,
            COALESCE(NULLIF(method, ''), '未填方式') AS method,
            COUNT(*) AS cnt,
            COALESCE(SUM(amount), 0) AS amount
     FROM payments
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY shift, method`,
    [hotelId, from, to]
  );
}

type ShiftWindowRow = {
  shift: string;
  first_at: string | null;
  last_at: string | null;
  cnt: number;
};

function shiftWindowAgg(hotelId: number, from: string, to: string): ShiftWindowRow[] {
  return all<ShiftWindowRow>(
    `SELECT CASE
              WHEN CAST(strftime('%H', created_at, '+8 hours') AS INTEGER) BETWEEN 8 AND 15 THEN '早班'
              WHEN CAST(strftime('%H', created_at, '+8 hours') AS INTEGER) >= 16 THEN '中班'
              ELSE '夜班'
            END AS shift,
            MIN(strftime('%H:%M', created_at, '+8 hours')) AS first_at,
            MAX(strftime('%H:%M', created_at, '+8 hours')) AS last_at,
            COUNT(*) AS cnt
     FROM payments
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY shift`,
    [hotelId, from, to]
  );
}

type OperatorPayRow = {
  operator: string;
  cnt: number;
  receipt: number;
  refund: number;
  net: number;
};

/** 按操作人汇总收款：操作人取账务单最早一条消费明细的过账人 */
function operatorPayAgg(hotelId: number, from: string, to: string): OperatorPayRow[] {
  return all<OperatorPayRow>(
    `SELECT COALESCE(u.real_name, '未记录') AS operator,
            COUNT(*) AS cnt,
            COALESCE(SUM(CASE WHEN p.amount >= 0 THEN p.amount ELSE 0 END), 0) AS receipt,
            COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END), 0) AS refund,
            COALESCE(SUM(p.amount), 0) AS net
     FROM payments p
     LEFT JOIN (
       SELECT folio_id, created_by
       FROM folio_items
       WHERE id IN (SELECT MIN(id) FROM folio_items WHERE hotel_id = ? GROUP BY folio_id)
     ) oi ON oi.folio_id = p.folio_id
     LEFT JOIN users u ON u.id = oi.created_by
     WHERE p.hotel_id = ? AND p.biz_date BETWEEN ? AND ?
     GROUP BY operator
     ORDER BY net DESC`,
    [hotelId, hotelId, from, to]
  );
}

type FolioDailyRow = {
  folio_no: string;
  guest_name: string | null;
  room_no: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  settled_at: string | null;
  nights: number | null;
  check_in_date: string | null;
  checkout_date: string | null;
  operator: string;
};

function folioDailyRows(hotelId: number, from: string, to: string): FolioDailyRow[] {
  return all<FolioDailyRow>(
    `SELECT f.folio_no,
            f.guest_name,
            f.room_no,
            COALESCE(f.total_amount, 0) AS total_amount,
            COALESCE(f.paid_amount, 0) AS paid_amount,
            COALESCE(f.balance, 0) AS balance,
            strftime('%Y-%m-%d %H:%M', f.settled_at, '+8 hours') AS settled_at,
            s.nights,
            substr(s.check_in_time, 1, 10) AS check_in_date,
            s.actual_check_out AS checkout_date,
            COALESCE(u.real_name, '未记录') AS operator
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN (
       SELECT folio_id, created_by
       FROM folio_items
       WHERE id IN (SELECT MIN(id) FROM folio_items WHERE hotel_id = ? GROUP BY folio_id)
     ) oi ON oi.folio_id = f.id
     LEFT JOIN users u ON u.id = oi.created_by
     WHERE f.hotel_id = ?
       AND f.status = 'SETTLED'
       AND f.settled_at IS NOT NULL
       AND date(f.settled_at, '+8 hours') BETWEEN ? AND ?
     ORDER BY f.settled_at DESC, f.id DESC`,
    [hotelId, hotelId, from, to]
  );
}

type ConsumeRow = {
  biz_date: string;
  item_type: string;
  description: string | null;
  qty: number;
  price: number;
  amount: number;
  created_at: string | null;
  operator: string;
  folio_no: string | null;
  room_no: string | null;
  guest_name: string | null;
};

const CONSUME_LIMIT = 500;

function consumeRows(hotelId: number, from: string, to: string): ConsumeRow[] {
  return all<ConsumeRow>(
    `SELECT fi.biz_date,
            fi.item_type,
            fi.description,
            COALESCE(fi.qty, 0) AS qty,
            COALESCE(fi.price, 0) AS price,
            COALESCE(fi.amount, 0) AS amount,
            strftime('%Y-%m-%d %H:%M', fi.created_at, '+8 hours') AS created_at,
            COALESCE(u.real_name, '未记录') AS operator,
            f.folio_no,
            f.room_no,
            f.guest_name
     FROM folio_items fi
     LEFT JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN users u ON u.id = fi.created_by
     WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ?
     ORDER BY fi.biz_date DESC, fi.id DESC
     LIMIT ${CONSUME_LIMIT}`,
    [hotelId, from, to]
  );
}

function consumeTotalCount(hotelId: number, from: string, to: string): number {
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM folio_items WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?`,
    [hotelId, from, to]
  );
  return num(row?.n);
}

type PayDetailRow = {
  pay_no: string;
  method: string | null;
  amount: number;
  biz_date: string;
  remark: string | null;
  folio_no: string | null;
  room_no: string | null;
  guest_name: string | null;
  created_at: string | null;
};

function payDetailRows(hotelId: number, from: string, to: string): PayDetailRow[] {
  return all<PayDetailRow>(
    `SELECT p.pay_no,
            COALESCE(NULLIF(p.method, ''), '未填方式') AS method,
            COALESCE(p.amount, 0) AS amount,
            p.biz_date,
            p.remark,
            f.folio_no,
            f.room_no,
            f.guest_name,
            strftime('%Y-%m-%d %H:%M', p.created_at, '+8 hours') AS created_at
     FROM payments p
     LEFT JOIN folios f ON f.id = p.folio_id
     WHERE p.hotel_id = ? AND p.biz_date BETWEEN ? AND ?
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 100`,
    [hotelId, from, to]
  );
}

type SalesChannelRow = {
  name: string;
  nights: number;
  room: number;
  total: number;
  rate: number;
};

function salesChannelAgg(hotelId: number, from: string, to: string): SalesChannelRow[] {
  return all<SalesChannelRow>(
    `SELECT COALESCE(c.name, '散客') AS name,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.qty ELSE 0 END), 0) AS nights,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.amount ELSE 0 END), 0) AS room,
            COALESCE(SUM(fi.amount), 0) AS total,
            COALESCE(MAX(c.commission), 0) AS rate
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN channels c ON c.id = s.channel_id
     WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ?
       AND fi.item_type IN ('ROOM','FOOD','OTHER')
     GROUP BY c.id
     ORDER BY total DESC`,
    [hotelId, from, to]
  );
}

type MemberLevelRow = { level: number; members: number; amount: number; nights: number };

function memberLevelAgg(hotelId: number, from: string, to: string): MemberLevelRow[] {
  return all<MemberLevelRow>(
    `SELECT g.vip_level AS level,
            COUNT(DISTINCT g.id) AS members,
            COALESCE(SUM(fi.amount), 0) AS amount,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.qty ELSE 0 END), 0) AS nights
     FROM guests g
     LEFT JOIN stays s ON s.guest_name = g.name AND s.hotel_id = g.hotel_id
     LEFT JOIN folios f ON f.stay_id = s.id
     LEFT JOIN folio_items fi ON fi.folio_id = f.id
       AND fi.biz_date BETWEEN ? AND ?
       AND fi.item_type IN ('ROOM','FOOD','OTHER')
     WHERE g.hotel_id = ?
     GROUP BY g.vip_level
     ORDER BY g.vip_level`,
    [from, to, hotelId]
  );
}

type MemberRankRow = {
  name: string;
  level: number;
  stays: number;
  nights: number;
  amount: number;
};

function memberRankRows(hotelId: number, from: string, to: string): MemberRankRow[] {
  return all<MemberRankRow>(
    `SELECT g.name,
            g.vip_level AS level,
            COUNT(DISTINCT s.id) AS stays,
            COALESCE(SUM(CASE WHEN fi.item_type = 'ROOM' THEN fi.qty ELSE 0 END), 0) AS nights,
            COALESCE(SUM(fi.amount), 0) AS amount
     FROM guests g
     JOIN stays s ON s.guest_name = g.name AND s.hotel_id = g.hotel_id
     JOIN folios f ON f.stay_id = s.id
     JOIN folio_items fi ON fi.folio_id = f.id
       AND fi.biz_date BETWEEN ? AND ?
       AND fi.item_type IN ('ROOM','FOOD','OTHER')
     WHERE g.hotel_id = ? AND g.vip_level > 0
     GROUP BY g.id
     ORDER BY amount DESC
     LIMIT 30`,
    [from, to, hotelId]
  );
}

type BizTypeRow = { item_type: string; cnt: number; qty: number; amount: number };

function bizTypeAgg(hotelId: number, from: string, to: string): BizTypeRow[] {
  return all<BizTypeRow>(
    `SELECT item_type,
            COUNT(*) AS cnt,
            COALESCE(SUM(qty), 0) AS qty,
            COALESCE(SUM(amount), 0) AS amount
     FROM folio_items
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY item_type
     ORDER BY amount DESC`,
    [hotelId, from, to]
  );
}

type BizSummaryRow = {
  description: string | null;
  item_type: string;
  cnt: number;
  qty: number;
  amount: number;
  first_day: string | null;
  last_day: string | null;
};

const BIZ_SUMMARY_LIMIT = 200;

function bizSummaryAgg(hotelId: number, from: string, to: string): BizSummaryRow[] {
  return all<BizSummaryRow>(
    `SELECT description,
            MAX(item_type) AS item_type,
            COUNT(*) AS cnt,
            COALESCE(SUM(qty), 0) AS qty,
            COALESCE(SUM(amount), 0) AS amount,
            MIN(biz_date) AS first_day,
            MAX(biz_date) AS last_day
     FROM folio_items
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY description
     ORDER BY amount DESC
     LIMIT ${BIZ_SUMMARY_LIMIT}`,
    [hotelId, from, to]
  );
}

function bizSummaryCount(hotelId: number, from: string, to: string): number {
  const row = get<{ n: number }>(
    `SELECT COUNT(DISTINCT description) AS n FROM folio_items WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?`,
    [hotelId, from, to]
  );
  return num(row?.n);
}

type RoomTypeMatrixRow = { biz_date: string; name: string; amount: number };

function roomTypeMatrix(hotelId: number, from: string, to: string): RoomTypeMatrixRow[] {
  return all<RoomTypeMatrixRow>(
    `SELECT fi.biz_date,
            COALESCE(rt.name, '未分房型') AS name,
            COALESCE(SUM(fi.amount), 0) AS amount
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN rooms r ON r.id = s.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM' AND fi.biz_date BETWEEN ? AND ?
     GROUP BY fi.biz_date, rt.id
     ORDER BY fi.biz_date`,
    [hotelId, from, to]
  );
}

type RoomMatrixRow = { biz_date: string; room_no: string; amount: number };

/** 逐日 × 房间号的房费矩阵（综合营业日报-房间） */
function roomNoMatrix(hotelId: number, from: string, to: string): RoomMatrixRow[] {
  return all<RoomMatrixRow>(
    `SELECT fi.biz_date,
            COALESCE(r.room_no, '未分房') AS room_no,
            COALESCE(SUM(fi.amount), 0) AS amount
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN rooms r ON r.id = s.room_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM' AND fi.biz_date BETWEEN ? AND ?
     GROUP BY fi.biz_date, r.id
     ORDER BY fi.biz_date, r.room_no`,
    [hotelId, from, to]
  );
}

type FloorMatrixRow = { biz_date: string; floor: string; amount: number };

function floorMatrix(hotelId: number, from: string, to: string): FloorMatrixRow[] {
  return all<FloorMatrixRow>(
    `SELECT fi.biz_date,
            COALESCE(CAST(r.floor AS TEXT), '未分楼层') AS floor,
            COALESCE(SUM(fi.amount), 0) AS amount
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN rooms r ON r.id = s.room_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM' AND fi.biz_date BETWEEN ? AND ?
     GROUP BY fi.biz_date, r.floor
     ORDER BY fi.biz_date`,
    [hotelId, from, to]
  );
}

type FloorRow = { floor: number | null; rooms: number };

function floorList(hotelId: number): FloorRow[] {
  return all<FloorRow>(
    `SELECT floor, COUNT(*) AS rooms FROM rooms WHERE hotel_id = ? GROUP BY floor ORDER BY floor`,
    [hotelId]
  );
}

type CompanyRow = {
  name: string;
  contact: string | null;
  phone: string | null;
  discount: number | null;
  credit_limit: number | null;
};

function companyRows(hotelId: number): CompanyRow[] {
  return all<CompanyRow>(
    `SELECT name,
            MAX(contact) AS contact,
            MAX(phone) AS phone,
            MAX(discount) AS discount,
            MAX(credit_limit) AS credit_limit
     FROM companies
     WHERE hotel_id = ?
     GROUP BY name
     ORDER BY name`,
    [hotelId]
  );
}

type CompanyBalanceRow = { name: string; cnt: number; balance: number };

/** 挂账余额按客人所属协议单位归集 */
function companyBalanceAgg(hotelId: number): CompanyBalanceRow[] {
  return all<CompanyBalanceRow>(
    `SELECT COALESCE(NULLIF(g.company, ''), '散客 / 无协议') AS name,
            COUNT(*) AS cnt,
            COALESCE(SUM(f.balance), 0) AS balance
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN guests g ON g.name = s.guest_name AND g.hotel_id = f.hotel_id
     WHERE f.hotel_id = ? AND f.balance > 0.005
     GROUP BY COALESCE(NULLIF(g.company, ''), '散客 / 无协议')
     ORDER BY balance DESC`,
    [hotelId]
  );
}

type OpenFolioRow = {
  folio_no: string;
  guest_name: string | null;
  room_no: string | null;
  channel: string;
  checkout_date: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  age: number;
  created_at: string | null;
};

function openFolioRows(hotelId: number): OpenFolioRow[] {
  return all<OpenFolioRow>(
    `SELECT f.folio_no,
            f.guest_name,
            f.room_no,
            COALESCE(c.name, '散客') AS channel,
            s.actual_check_out AS checkout_date,
            COALESCE(f.total_amount, 0) AS total_amount,
            COALESCE(f.paid_amount, 0) AS paid_amount,
            COALESCE(f.balance, 0) AS balance,
            CAST(julianday(date('now', '+8 hours')) - julianday(date(f.created_at, '+8 hours')) AS INTEGER) AS age,
            strftime('%Y-%m-%d', f.created_at, '+8 hours') AS created_at
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN channels c ON c.id = s.channel_id
     WHERE f.hotel_id = ? AND f.balance > 0.005
     ORDER BY f.balance DESC
     LIMIT 200`,
    [hotelId]
  );
}

type DayAmountRow = { biz_date: string; amount: number };

function consumeByDay(hotelId: number, from: string, to: string): DayAmountRow[] {
  return all<DayAmountRow>(
    `SELECT biz_date, COALESCE(SUM(amount), 0) AS amount
     FROM folio_items
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND item_type IN ('ROOM','FOOD','OTHER')
     GROUP BY biz_date ORDER BY biz_date`,
    [hotelId, from, to]
  );
}

function recoverByDay(hotelId: number, from: string, to: string): DayAmountRow[] {
  return all<DayAmountRow>(
    `SELECT biz_date, COALESCE(SUM(amount), 0) AS amount
     FROM payments
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY biz_date ORDER BY biz_date`,
    [hotelId, from, to]
  );
}

type AuditRow = {
  biz_date: string;
  status: string;
  rooms_sold: number;
  revenue: number;
  occupancy: number;
  operator: string | null;
  /* 分列列（P1-19）：迁移后新写入的行有值，迁移前的历史行全是 0 */
  revenue_room: number | null;
  revenue_food: number | null;
  revenue_other: number | null;
  refund_total: number | null;
  revenue_net: number | null;
};

/**
 * 夜审行「营收」口径（整改清单 P1-19：`night_audits.revenue` 语义漂移）
 *
 * ── 漂移是怎么来的 ──
 * 第 4 轮 P1-13 把指标口径拆成「毛收入三分类 - 退款 = 净收入」后，
 * 兼容列 `revenue` 改为写 **净收入**（与 revenue_net 同值）。
 * 但迁移前的历史行 `revenue` 写的是当年的 **毛收入**，而且没有分列数据。
 * 报表原来直接 `SUM(revenue)`，等于把两种口径混进同一个合计。
 *
 * ── 为什么选「读取时判断」而不是「迁移回填历史行」 ──
 * 回填需要还原历史行的 revenue_room / revenue_food / revenue_other。
 * 实测 7 条历史行的 revenue 与当前 folio_items 按 biz_date 重算的结果对不上
 * （2026-11-14：历史 9320 / 明细 8408；11-13：9640 / 3000；11-12：9960 / 268…），
 * 说明当年的明细已被后续改动（补录、冲账、清理）改变，三分类根本无法还原。
 * 此时回填只有两条路：
 *   · 把总额硬塞进某一分类 → 数字是编的；
 *   · 令 revenue_net = revenue 而分列留 0 → 破坏
 *     「净收入 = 房费+餐饮+其他-退款」恒等式，任何对账脚本一眼就能看出不自洽。
 * 两者都是把「不知道」伪装成「知道」，比留白更坏。
 * 方案 2（本实现）不动历史数据：按「该行有没有分列数据」判断口径，
 * 旧行取 revenue（毛额），新行取 revenue_net（净额），页面把两者标注清楚。
 * 好处是可回滚、不写库、不伪造；将来若真能从归档明细还原，再跑迁移也不冲突。
 *
 * ── 判定条件为什么不是 `revenue_net === 0` ──
 * 新夜审某天恰好零收入（无消费也无退款）时 revenue_net 也是 0，用等零判断
 * 会把这类新行误当历史行。分列全 0 + 退款也 0 才行 —— 那时取 revenue 也只可能
 * 是 0，数值上无害，但「分列非全零」是更严格的历史行信号。
 */
function auditHasSplit(r: AuditRow): boolean {
  return (
    num(r.revenue_room) !== 0 ||
    num(r.revenue_food) !== 0 ||
    num(r.revenue_other) !== 0 ||
    num(r.refund_total) !== 0
  );
}

/** 该行有效的营收：新行净额 / 历史行毛额 */
function auditRevenue(r: AuditRow): number {
  return auditHasSplit(r) ? num(r.revenue_net) : num(r.revenue);
}

function auditRows(hotelId: number, from: string, to: string): AuditRow[] {
  return all<AuditRow>(
    `SELECT biz_date, status, rooms_sold, revenue, occupancy, operator,
            revenue_room, revenue_food, revenue_other, refund_total, revenue_net
     FROM night_audits WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     ORDER BY biz_date DESC`,
    [hotelId, from, to]
  );
}

type InhouseRow = {
  stay_no: string;
  room_no: string;
  floor: number | null;
  room_type: string | null;
  guest_name: string | null;
  mobile: string | null;
  check_in: string | null;
  expect_check_out: string | null;
  nights: number;
  rate: number;
  deposit: number;
  channel: string;
  balance: number;
  folio_no: string | null;
  folio_status: string | null;
};

function inhouseRows(hotelId: number): InhouseRow[] {
  return all<InhouseRow>(
    `SELECT s.stay_no,
            r.room_no,
            r.floor,
            rt.name AS room_type,
            s.guest_name,
            s.mobile,
            strftime('%Y-%m-%d %H:%M', s.check_in_time, '+8 hours') AS check_in,
            s.expect_check_out,
            COALESCE(s.nights, 0) AS nights,
            COALESCE(s.rate, 0) AS rate,
            COALESCE(s.deposit, 0) AS deposit,
            COALESCE(c.name, '散客') AS channel,
            COALESCE(f.balance, 0) AS balance,
            f.folio_no,
            f.status AS folio_status
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN channels c ON c.id = s.channel_id
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     ORDER BY r.room_no`,
    [hotelId]
  );
}

type ArChannelRow = { name: string; cnt: number; charge: number; paid: number; ar: number };

function arChannelAgg(hotelId: number, from: string, to: string): ArChannelRow[] {
  return all<ArChannelRow>(
    `SELECT COALESCE(c.name, '散客') AS name,
            COUNT(*) AS cnt,
            COALESCE(SUM(f.total_amount), 0) AS charge,
            COALESCE(SUM(f.paid_amount), 0) AS paid,
            COALESCE(SUM(f.balance), 0) AS ar
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN channels c ON c.id = s.channel_id
     WHERE f.hotel_id = ? AND date(f.created_at, '+8 hours') BETWEEN ? AND ?
     GROUP BY c.id
     ORDER BY ar DESC`,
    [hotelId, from, to]
  );
}

type ArDetailRow = {
  folio_no: string;
  guest_name: string | null;
  room_no: string | null;
  charge: number;
  paid: number;
  ar: number;
  created_at: string | null;
  age: number;
};

function arDetailRows(hotelId: number, from: string, to: string): ArDetailRow[] {
  return all<ArDetailRow>(
    `SELECT f.folio_no,
            f.guest_name,
            f.room_no,
            COALESCE(f.total_amount, 0) AS charge,
            COALESCE(f.paid_amount, 0) AS paid,
            COALESCE(f.balance, 0) AS ar,
            strftime('%Y-%m-%d', f.created_at, '+8 hours') AS created_at,
            CAST(julianday(date('now', '+8 hours')) - julianday(date(f.created_at, '+8 hours')) AS INTEGER) AS age
     FROM folios f
     WHERE f.hotel_id = ? AND date(f.created_at, '+8 hours') BETWEEN ? AND ?
     ORDER BY f.balance DESC
     LIMIT 200`,
    [hotelId, from, to]
  );
}

type FinExRow = {
  folio_no: string;
  guest_name: string | null;
  room_no: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  status: string;
  created_at: string | null;
};

function finExRows(hotelId: number, from: string, to: string): FinExRow[] {
  return all<FinExRow>(
    `SELECT f.folio_no,
            f.guest_name,
            f.room_no,
            COALESCE(f.total_amount, 0) AS total_amount,
            COALESCE(f.paid_amount, 0) AS paid_amount,
            COALESCE(f.balance, 0) AS balance,
            f.status,
            strftime('%Y-%m-%d %H:%M', f.created_at, '+8 hours') AS created_at
     FROM folios f
     WHERE f.hotel_id = ?
       AND date(f.created_at, '+8 hours') BETWEEN ? AND ?
       AND (
         ABS(COALESCE(f.total_amount, 0) - COALESCE(f.paid_amount, 0) - COALESCE(f.balance, 0)) > 0.01
         OR COALESCE(f.balance, 0) < -0.01
         OR (f.status = 'SETTLED' AND COALESCE(f.balance, 0) > 0.01)
       )
     ORDER BY f.id DESC
     LIMIT 200`,
    [hotelId, from, to]
  );
}

type OpActionRow = { operator: string; action: string; cnt: number };

function opActionAgg(hotelId: number, from: string, to: string): OpActionRow[] {
  return all<OpActionRow>(
    `SELECT operator, action, COUNT(*) AS cnt
     FROM op_logs
     WHERE hotel_id = ? AND date(created_at, '+8 hours') BETWEEN ? AND ?
     GROUP BY operator, action
     ORDER BY operator, cnt DESC`,
    [hotelId, from, to]
  );
}

type OpDetailRow = {
  operator: string;
  action: string;
  detail: string | null;
  created_at: string | null;
};

function opDetailRows(hotelId: number, from: string, to: string): OpDetailRow[] {
  return all<OpDetailRow>(
    `SELECT operator,
            action,
            detail,
            strftime('%Y-%m-%d %H:%M', created_at, '+8 hours') AS created_at
     FROM op_logs
     WHERE hotel_id = ? AND date(created_at, '+8 hours') BETWEEN ? AND ?
     ORDER BY created_at DESC, id DESC
     LIMIT 200`,
    [hotelId, from, to]
  );
}

/* ------------------------------------------------------------------ *
 * 五之二、新增 20 张报表的数据源
 * ------------------------------------------------------------------ */

/* ---------- 1. 押金报表 ---------- */
type DepositRow = {
  id: number;
  biz_date: string;
  guest_name: string;
  room_no: string;
  amount: number;
  description: string;
  method: string;
  created_at: string | null;
  folio_no: string;
  folio_status: string;
  stay_status: string;
};

function depositRows(hotelId: number, from: string, to: string): DepositRow[] {
  return all<DepositRow>(
    `SELECT fi.id,
            fi.biz_date,
            COALESCE(f.guest_name, '') AS guest_name,
            COALESCE(f.room_no, '') AS room_no,
            COALESCE(fi.amount, 0) AS amount,
            COALESCE(fi.description, '') AS description,
            COALESCE((SELECT GROUP_CONCAT(DISTINCT p.method) FROM payments p
                      WHERE p.folio_id = fi.folio_id AND p.biz_date = fi.biz_date), '') AS method,
            strftime('%Y-%m-%d %H:%M', fi.created_at, '+8 hours') AS created_at,
            COALESCE(f.folio_no, '') AS folio_no,
            COALESCE(f.status, '') AS folio_status,
            COALESCE(s.status, '') AS stay_status
     FROM folio_items fi
     LEFT JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'DEPOSIT' AND fi.biz_date BETWEEN ? AND ?
     ORDER BY fi.biz_date DESC, fi.id DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 1b. 押金退款流水（整改清单 P2-6） ----------
 *
 * 「已退押金」原来用 `押金收取 - 押金余额` 倒推，两个端都不可靠：
 *   · 退房自动退押金会把 DEPOSIT 明细按退款额冲减（cashier/actions.ts 退房流程
 *     第 ② 步 `UPDATE folio_items SET amount = amount - refundCash`），
 *     所以「区间内押金明细合计」本身已经是**净剩余**，而不是当年收取额；
 *   · 用净剩余减去在压押金，只会得到「跨期滚动后的差额」，不是真的退过多少钱。
 * 实测就出现「已退 ¥0.00」但实际退过款的情况。
 *
 * 现在直接读真实退款流水。押金退款的识别有两处写入点：
 *   · 退房自动退押金（cashier/actions.ts）：负数流水 + remark「退房退还押金」，
 *     refund_of 指向原押金收款；
 *   · 收银台手动退款（refundPaymentAction）：负数流水 + remark「退款：原因」，
 *     refund_of 指向原收款（原收款可能是押金，也可能不是）。
 * 判定：本笔备注含「押金」，**或** refund_of 指向的那笔原收款备注含「押金」。
 * 押金收款的备注由 rooms/actions.ts 写「预收款（押金）」、收银台写
 * remark || "预收款"，所以「含押金」是两侧都成立的锚点。
 *
 * 时间列用 `datetime(x,'localtime')` 而不是 `x, '+8 hours'`：
 * 老数据 created_at 是 UTC（nowIso），新数据可能是带 +08:00 的本地串
 * （nowLocalIso）；localtime 修饰符对两种格式都能算出同一个本地时间，
 * 硬编码 +8 则会把后者重复加一次。
 */
type DepositRefundRow = {
  id: number;
  biz_date: string;
  pay_no: string;
  amount: number;
  method: string;
  remark: string;
  created_at: string | null;
  folio_no: string;
  guest_name: string;
  room_no: string;
  origin_pay_no: string;
  origin_remark: string;
};

function depositRefundRows(hotelId: number, from: string, to: string): DepositRefundRow[] {
  return all<DepositRefundRow>(
    `SELECT p.id,
            COALESCE(p.biz_date, '') AS biz_date,
            COALESCE(p.pay_no, '') AS pay_no,
            COALESCE(p.amount, 0) AS amount,
            COALESCE(p.method, '') AS method,
            COALESCE(p.remark, '') AS remark,
            substr(datetime(p.created_at, 'localtime'), 1, 16) AS created_at,
            COALESCE(f.folio_no, '') AS folio_no,
            COALESCE(f.guest_name, '') AS guest_name,
            COALESCE(f.room_no, '') AS room_no,
            COALESCE(op.pay_no, '') AS origin_pay_no,
            COALESCE(op.remark, '') AS origin_remark
     FROM payments p
     LEFT JOIN folios f ON f.id = p.folio_id
     LEFT JOIN payments op ON op.id = p.refund_of
     WHERE p.hotel_id = ? AND p.amount < 0 AND p.biz_date BETWEEN ? AND ?
       AND (p.remark LIKE '%押金%' OR COALESCE(op.remark, '') LIKE '%押金%')
     ORDER BY p.biz_date DESC, p.id DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 2. 挂账客人报表 ---------- */
type CreditGuestRow = {
  id: number;
  folio_no: string;
  guest_name: string;
  room_no: string;
  total_amount: number;
  paid_amount: number;
  balance: number;
  stay_status: string;
  nights: number;
  check_in_date: string | null;
  leave_date: string;
  age: number;
  company: string;
  channel: string;
};

function creditGuestRows(hotelId: number): CreditGuestRow[] {
  return all<CreditGuestRow>(
    `SELECT f.id,
            COALESCE(f.folio_no, '') AS folio_no,
            COALESCE(f.guest_name, '') AS guest_name,
            COALESCE(f.room_no, '') AS room_no,
            COALESCE(f.total_amount, 0) AS total_amount,
            COALESCE(f.paid_amount, 0) AS paid_amount,
            COALESCE(f.balance, 0) AS balance,
            COALESCE(s.status, '') AS stay_status,
            COALESCE(s.nights, 0) AS nights,
            substr(s.check_in_time, 1, 10) AS check_in_date,
            COALESCE(s.actual_check_out, s.expect_check_out, '') AS leave_date,
            CAST(julianday(date('now', '+8 hours')) - julianday(date(f.created_at, '+8 hours')) AS INTEGER) AS age,
            COALESCE(NULLIF(g.company, ''), '') AS company,
            COALESCE(ch.name, '散客') AS channel
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id
     LEFT JOIN guests g ON g.name = s.guest_name AND g.hotel_id = f.hotel_id
     LEFT JOIN channels ch ON ch.id = s.channel_id
     WHERE f.hotel_id = ? AND COALESCE(f.balance, 0) > 0.005
       AND COALESCE(s.status, 'INHOUSE') IN ('INHOUSE', 'CHECKED_OUT')
     ORDER BY balance DESC`,
    [hotelId]
  );
}

/* ---------- 3. 小商品区间报表 ---------- */
type GoodsRangeRow = {
  id: number;
  biz_date: string;
  goods_name: string;
  room_no: string;
  guest_name: string;
  qty: number;
  price: number;
  amount: number;
  folio_no: string;
  created_at: string | null;
};

function goodsRangeRows(hotelId: number, from: string, to: string): GoodsRangeRow[] {
  return all<GoodsRangeRow>(
    `SELECT fi.id,
            fi.biz_date,
            REPLACE(REPLACE(COALESCE(fi.description, ''), '商超:', ''), '商超：', '') AS goods_name,
            COALESCE(f.room_no, '') AS room_no,
            COALESCE(f.guest_name, '') AS guest_name,
            COALESCE(fi.qty, 0) AS qty,
            COALESCE(fi.price, 0) AS price,
            COALESCE(fi.amount, 0) AS amount,
            COALESCE(f.folio_no, '') AS folio_no,
            strftime('%Y-%m-%d %H:%M', fi.created_at, '+8 hours') AS created_at
     FROM folio_items fi
     LEFT JOIN folios f ON f.id = fi.folio_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'OTHER' AND fi.biz_date BETWEEN ? AND ?
       AND (fi.description LIKE '商超:%' OR fi.description LIKE '商超：%')
     ORDER BY fi.biz_date DESC, fi.id DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 4. 小商品销售报表 ---------- */
type GoodsSalesRow = {
  goods_name: string;
  cnt: number;
  qty: number;
  amount: number;
};

function goodsSalesAgg(hotelId: number, from: string, to: string): GoodsSalesRow[] {
  return all<GoodsSalesRow>(
    `SELECT REPLACE(REPLACE(COALESCE(fi.description, ''), '商超:', ''), '商超：', '') AS goods_name,
            COUNT(*) AS cnt,
            COALESCE(SUM(fi.qty), 0) AS qty,
            COALESCE(SUM(fi.amount), 0) AS amount
     FROM folio_items fi
     WHERE fi.hotel_id = ? AND fi.item_type = 'OTHER' AND fi.biz_date BETWEEN ? AND ?
       AND (fi.description LIKE '商超:%' OR fi.description LIKE '商超：%')
     GROUP BY goods_name
     ORDER BY amount DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 5. AR账龄报表 ---------- */
type ArAgeRow = {
  id: number;
  folio_no: string;
  guest_name: string;
  room_no: string;
  total_amount: number;
  paid_amount: number;
  balance: number;
  stay_status: string;
  created_date: string | null;
  age: number;
};

function arAgeRows(hotelId: number): ArAgeRow[] {
  return all<ArAgeRow>(
    `SELECT f.id,
            COALESCE(f.folio_no, '') AS folio_no,
            COALESCE(f.guest_name, '') AS guest_name,
            COALESCE(f.room_no, '') AS room_no,
            COALESCE(f.total_amount, 0) AS total_amount,
            COALESCE(f.paid_amount, 0) AS paid_amount,
            COALESCE(f.balance, 0) AS balance,
            COALESCE(s.status, '') AS stay_status,
            date(f.created_at, '+8 hours') AS created_date,
            CAST(julianday(date('now', '+8 hours')) - julianday(date(f.created_at, '+8 hours')) AS INTEGER) AS age
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id
     WHERE f.hotel_id = ? AND f.status = 'OPEN' AND COALESCE(f.balance, 0) > 0.005
     ORDER BY age DESC, balance DESC`,
    [hotelId]
  );
}

/* ---------- 6. AR发生汇总报表 ---------- */
type ArHappenRow = {
  biz_date: string;
  cnt: number;
  post_amount: number;
  paid_amount: number;
  write_off: number;
};

function arHappenAgg(hotelId: number, from: string, to: string): ArHappenRow[] {
  return all<ArHappenRow>(
    `SELECT t.biz_date,
            COUNT(*) AS cnt,
            COALESCE(SUM(CASE WHEN t.type = 'POST' THEN t.amount ELSE 0 END), 0) AS post_amount,
            COALESCE(SUM(CASE WHEN t.type = 'PAY' THEN -t.amount ELSE 0 END), 0) AS paid_amount,
            COALESCE(SUM(CASE WHEN t.type = 'WRITE_OFF' THEN -t.amount ELSE 0 END), 0) AS write_off
     FROM ar_transactions t
     WHERE t.hotel_id = ? AND t.biz_date BETWEEN ? AND ?
     GROUP BY t.biz_date
     ORDER BY t.biz_date DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 7. AR账报表 ---------- */
type ArAccountRow = {
  id: number;
  code: string;
  name: string;
  type: string;
  status: string;
  credit_limit: number;
  balance: number;
  cnt: number;
  post_amount: number;
  paid_amount: number;
  write_off: number;
  last_date: string;
};

function arAccountAgg(hotelId: number, from: string, to: string): ArAccountRow[] {
  return all<ArAccountRow>(
    `SELECT a.id, a.code, a.name, a.type, a.status,
            COALESCE(a.credit_limit, 0) AS credit_limit,
            COALESCE(a.balance, 0) AS balance,
            COUNT(t.id) AS cnt,
            COALESCE(SUM(CASE WHEN t.type = 'POST' THEN t.amount ELSE 0 END), 0) AS post_amount,
            COALESCE(SUM(CASE WHEN t.type = 'PAY' THEN -t.amount ELSE 0 END), 0) AS paid_amount,
            COALESCE(SUM(CASE WHEN t.type = 'WRITE_OFF' THEN -t.amount ELSE 0 END), 0) AS write_off,
            COALESCE(MAX(t.biz_date), '') AS last_date
     FROM ar_accounts a
     LEFT JOIN ar_transactions t
       ON t.ar_account_id = a.id AND t.hotel_id = a.hotel_id AND t.biz_date BETWEEN ? AND ?
     WHERE a.hotel_id = ?
     GROUP BY a.id
     ORDER BY balance DESC`,
    [from, to, hotelId]
  );
}

/* ---------- 8. 销售员业绩明细表 ---------- */
type SalesmanOrderRow = {
  salesman_id: number;
  salesman: string;
  commission_rate: number;
  booking_no: string;
  guest_name: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  room_count: number;
  rate: number;
  amount: number;
  status: string;
  company: string;
  channel: string;
};

function salesmanOrderRows(hotelId: number, from: string, to: string): SalesmanOrderRow[] {
  return all<SalesmanOrderRow>(
    `SELECT sm.id AS salesman_id,
            sm.name AS salesman,
            COALESCE(sm.commission_rate, 0) AS commission_rate,
            COALESCE(b.booking_no, '') AS booking_no,
            COALESCE(b.guest_name, '') AS guest_name,
            COALESCE(b.check_in_date, '') AS check_in_date,
            COALESCE(b.check_out_date, '') AS check_out_date,
            COALESCE(b.nights, 0) AS nights,
            COALESCE(b.room_count, 1) AS room_count,
            COALESCE(b.rate, 0) AS rate,
            COALESCE(b.rate, 0) * COALESCE(b.nights, 1) * COALESCE(b.room_count, 1) AS amount,
            COALESCE(b.status, '') AS status,
            COALESCE(co.name, '散客') AS company,
            COALESCE(ch.name, '') AS channel
     FROM salesmen sm
     JOIN bookings b ON b.hotel_id = sm.hotel_id AND b.salesman = sm.name AND b.check_in_date BETWEEN ? AND ?
     LEFT JOIN companies co ON co.id = b.company_id
     LEFT JOIN channels ch ON ch.id = b.channel_id
     WHERE sm.hotel_id = ?
     ORDER BY sm.name, b.check_in_date DESC`,
    [from, to, hotelId]
  );
}

/* ---------- 9. 销售员业绩汇总表 ---------- */
type SalesmanAggRow = {
  id: number;
  salesman: string;
  commission_rate: number;
  status: string;
  orders: number;
  nights: number;
  revenue: number;
};

function salesmanAggRows(hotelId: number, from: string, to: string): SalesmanAggRow[] {
  return all<SalesmanAggRow>(
    `SELECT sm.id, sm.name AS salesman,
            COALESCE(sm.commission_rate, 0) AS commission_rate, sm.status,
            COUNT(b.id) AS orders,
            COALESCE(SUM(CASE WHEN b.id IS NULL THEN 0
                              ELSE COALESCE(b.nights, 1) * COALESCE(b.room_count, 1) END), 0) AS nights,
            COALESCE(SUM(CASE WHEN b.id IS NULL THEN 0
                              ELSE COALESCE(b.rate, 0) * COALESCE(b.nights, 1) * COALESCE(b.room_count, 1) END), 0) AS revenue
     FROM salesmen sm
     LEFT JOIN bookings b ON b.hotel_id = sm.hotel_id AND b.salesman = sm.name
       AND b.check_in_date BETWEEN ? AND ?
     WHERE sm.hotel_id = ?
     GROUP BY sm.id
     ORDER BY revenue DESC`,
    [from, to, hotelId]
  );
}

/* ---------- 10. 协议客户销售明细表 ---------- */
type CompanyOrderRow = {
  company: string;
  discount: number;
  booking_no: string;
  guest_name: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  room_count: number;
  rate: number;
  amount: number;
  status: string;
  channel: string;
};

function companyOrderRows(hotelId: number, from: string, to: string): CompanyOrderRow[] {
  return all<CompanyOrderRow>(
    `SELECT co.name AS company,
            COALESCE(co.discount, 1) AS discount,
            COALESCE(b.booking_no, '') AS booking_no,
            COALESCE(b.guest_name, '') AS guest_name,
            COALESCE(b.check_in_date, '') AS check_in_date,
            COALESCE(b.check_out_date, '') AS check_out_date,
            COALESCE(b.nights, 0) AS nights,
            COALESCE(b.room_count, 1) AS room_count,
            COALESCE(b.rate, 0) AS rate,
            COALESCE(b.rate, 0) * COALESCE(b.nights, 1) * COALESCE(b.room_count, 1) AS amount,
            COALESCE(b.status, '') AS status,
            COALESCE(ch.name, '') AS channel
     FROM bookings b
     JOIN companies co ON co.id = b.company_id
     LEFT JOIN channels ch ON ch.id = b.channel_id
     WHERE b.hotel_id = ? AND b.check_in_date BETWEEN ? AND ?
     ORDER BY co.name, b.check_in_date DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 11. 协议客户销售汇总表 ---------- */
type CompanyAggRow = {
  company: string;
  discount: number;
  credit_limit: number;
  orders: number;
  nights: number;
  amount: number;
};

function companyAgg(hotelId: number, from: string, to: string): CompanyAggRow[] {
  return all<CompanyAggRow>(
    `SELECT c.name AS company, c.discount, c.credit_limit,
            COUNT(b.id) AS orders,
            COALESCE(SUM(CASE WHEN b.id IS NULL THEN 0
                              ELSE COALESCE(b.nights, 1) * COALESCE(b.room_count, 1) END), 0) AS nights,
            COALESCE(SUM(CASE WHEN b.id IS NULL THEN 0
                              ELSE COALESCE(b.rate, 0) * COALESCE(b.nights, 1) * COALESCE(b.room_count, 1) END), 0) AS amount
     FROM (SELECT name, MAX(discount) AS discount, MAX(credit_limit) AS credit_limit
           FROM companies WHERE hotel_id = ? GROUP BY name) c
     LEFT JOIN bookings b ON b.hotel_id = ? AND b.check_in_date BETWEEN ? AND ?
       AND b.company_id IN (SELECT co.id FROM companies co
                            WHERE co.hotel_id = ? AND co.name = c.name)
     GROUP BY c.name
     ORDER BY amount DESC, c.name`,
    [hotelId, hotelId, from, to, hotelId]
  );
}

/* ---------- 12. 换房报表 ---------- */
type ChangeRoomLogRow = {
  log_id: number;
  room_no: string;
  reason: string;
  from_status: string;
  to_status: string;
  operator: string;
  created_at: string | null;
};

function changeRoomLogRows(hotelId: number, from: string, to: string): ChangeRoomLogRow[] {
  return all<ChangeRoomLogRow>(
    `SELECT l.id AS log_id,
            COALESCE(r.room_no, '') AS room_no,
            COALESCE(l.reason, '') AS reason,
            COALESCE(l.from_status, '') AS from_status,
            COALESCE(l.to_status, '') AS to_status,
            COALESCE(l.operator, '') AS operator,
            strftime('%Y-%m-%d %H:%M', l.created_at, '+8 hours') AS created_at
     FROM room_logs l
     LEFT JOIN rooms r ON r.id = l.room_id
     WHERE l.hotel_id = ? AND (l.reason LIKE '%换房%' OR l.reason LIKE '%调房%')
       AND date(l.created_at, '+8 hours') BETWEEN ? AND ?
     ORDER BY l.created_at DESC`,
    [hotelId, from, to]
  );
}

type ChangeRoomOpRow = {
  log_id: number;
  room_no: string;
  new_room: string;
  action: string;
  detail: string;
  operator: string;
  created_at: string | null;
};

function changeRoomOpRows(hotelId: number, from: string, to: string): ChangeRoomOpRow[] {
  return all<ChangeRoomOpRow>(
    `SELECT o.id AS log_id,
            TRIM(substr(o.detail, 1, instr(o.detail || ' ', ' ') - 1)) AS room_no,
            CASE WHEN instr(o.detail, '→') > 0
                 THEN TRIM(substr(o.detail, instr(o.detail, '→') + 1, 12))
                 ELSE '' END AS new_room,
            COALESCE(o.action, '') AS action,
            COALESCE(o.detail, '') AS detail,
            COALESCE(o.operator, '') AS operator,
            strftime('%Y-%m-%d %H:%M', o.created_at, '+8 hours') AS created_at
     FROM op_logs o
     WHERE o.hotel_id = ? AND (o.action LIKE '%换房%' OR o.action LIKE '%调房%')
       AND date(o.created_at, '+8 hours') BETWEEN ? AND ?
     ORDER BY o.created_at DESC`,
    [hotelId, from, to]
  );
}

type StayRoomChangeRow = {
  stay_no: string;
  actual_room: string;
  booked_room: string;
  guest_name: string;
  status: string;
  check_in: string | null;
  check_out: string;
  operator: string;
};

function stayRoomChangeRows(hotelId: number, from: string, to: string): StayRoomChangeRow[] {
  return all<StayRoomChangeRow>(
    `SELECT s.stay_no,
            COALESCE(r.room_no, '') AS actual_room,
            COALESCE(rb.room_no, '') AS booked_room,
            COALESCE(s.guest_name, '') AS guest_name,
            COALESCE(s.status, '') AS status,
            strftime('%Y-%m-%d %H:%M', s.check_in_time, '+8 hours') AS check_in,
            COALESCE(s.actual_check_out, '') AS check_out,
            COALESCE(u.real_name, '') AS operator
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     JOIN bookings b ON b.id = s.booking_id
     LEFT JOIN rooms rb ON rb.id = b.room_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.hotel_id = ? AND b.room_id IS NOT NULL AND b.room_id <> s.room_id
       AND substr(s.check_in_time, 1, 10) BETWEEN ? AND ?
     ORDER BY s.check_in_time DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 13. 冲账明细报表 ---------- */
type ReverseDetailRow = {
  id: number;
  biz_date: string;
  description: string;
  qty: number;
  price: number;
  amount: number;
  folio_no: string;
  room_no: string;
  guest_name: string;
  operator: string;
  created_at: string | null;
};

function reverseDetailRows(hotelId: number, from: string, to: string): ReverseDetailRow[] {
  return all<ReverseDetailRow>(
    `SELECT fi.id, fi.biz_date, COALESCE(fi.description, '') AS description,
            COALESCE(fi.qty, 0) AS qty, COALESCE(fi.price, 0) AS price, COALESCE(fi.amount, 0) AS amount,
            COALESCE(f.folio_no, '') AS folio_no, COALESCE(f.room_no, '') AS room_no,
            COALESCE(f.guest_name, '') AS guest_name,
            COALESCE(u.real_name, '未记录') AS operator,
            strftime('%Y-%m-%d %H:%M', fi.created_at, '+8 hours') AS created_at
     FROM folio_items fi
     LEFT JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN users u ON u.id = fi.created_by
     WHERE fi.hotel_id = ? AND fi.item_type = 'ADJUST' AND COALESCE(fi.amount, 0) < 0
       AND fi.biz_date BETWEEN ? AND ?
     ORDER BY fi.biz_date DESC, fi.id DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 14. 离店客人房费加收表 ---------- */
type ExtraRoomFeeRow = {
  id: number;
  biz_date: string;
  item_type: string;
  description: string;
  qty: number;
  price: number;
  amount: number;
  folio_no: string;
  room_no: string;
  guest_name: string;
  check_in_date: string | null;
  nights: number;
  created_at: string | null;
  reason: string;
};

function extraRoomFeeRows(hotelId: number, from: string, to: string): ExtraRoomFeeRow[] {
  return all<ExtraRoomFeeRow>(
    `SELECT fi.id, fi.biz_date, fi.item_type, COALESCE(fi.description, '') AS description,
            COALESCE(fi.qty, 0) AS qty, COALESCE(fi.price, 0) AS price, COALESCE(fi.amount, 0) AS amount,
            COALESCE(f.folio_no, '') AS folio_no, COALESCE(f.room_no, '') AS room_no,
            COALESCE(f.guest_name, '') AS guest_name,
            substr(s.check_in_time, 1, 10) AS check_in_date,
            COALESCE(s.nights, 0) AS nights,
            strftime('%Y-%m-%d %H:%M', fi.created_at, '+8 hours') AS created_at,
            CASE WHEN fi.description LIKE '加收%' THEN '加收项目' ELSE '超入住日房费' END AS reason
     FROM folio_items fi
     LEFT JOIN folios f ON f.id = fi.folio_id
     LEFT JOIN stays s ON s.id = f.stay_id
     WHERE fi.hotel_id = ? AND fi.biz_date BETWEEN ? AND ?
       AND (
         fi.description LIKE '加收%'
         OR (fi.item_type = 'ROOM' AND s.check_in_time IS NOT NULL
             AND date(fi.created_at, '+8 hours') > substr(s.check_in_time, 1, 10))
       )
     ORDER BY fi.biz_date DESC, fi.id DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 15. 预抵客人报表 ---------- */
type ExpectedArrivalRow = {
  booking_no: string;
  guest_name: string;
  mobile: string;
  room_type: string;
  room_no: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  rate: number;
  deposit: number;
  channel: string;
  status: string;
  arrival_time: string;
  remark: string;
  guest_count: number;
};

function expectedArrivalRows(hotelId: number, from: string, to: string): ExpectedArrivalRow[] {
  return all<ExpectedArrivalRow>(
    `SELECT COALESCE(b.booking_no, '') AS booking_no,
            COALESCE(b.guest_name, '') AS guest_name,
            COALESCE(b.mobile, '') AS mobile,
            COALESCE(rt.name, '未排房型') AS room_type,
            COALESCE(r.room_no, '') AS room_no,
            COALESCE(b.check_in_date, '') AS check_in_date,
            COALESCE(b.check_out_date, '') AS check_out_date,
            COALESCE(b.nights, 0) AS nights,
            COALESCE(b.rate, 0) AS rate,
            COALESCE(b.deposit, 0) AS deposit,
            COALESCE(ch.name, '散客') AS channel,
            COALESCE(b.status, '') AS status,
            COALESCE(b.arrival_time, '') AS arrival_time,
            COALESCE(b.remark, '') AS remark,
            COALESCE(b.guest_count, 1) AS guest_count
     FROM bookings b
     LEFT JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN rooms r ON r.id = b.room_id
     LEFT JOIN channels ch ON ch.id = b.channel_id
     WHERE b.hotel_id = ? AND b.status IN ('PENDING', 'CONFIRMED')
       AND b.check_in_date BETWEEN ? AND ?
     ORDER BY b.check_in_date, b.booking_no`,
    [hotelId, from, to]
  );
}

/* ---------- 16. 调价报表 ---------- */
type PriceChangeRow = {
  id: number;
  operator: string;
  action: string;
  detail: string;
  room_no: string;
  created_at: string | null;
  stay_no: string;
  guest_name: string;
  rate: number;
  stay_status: string;
  check_in_date: string | null;
};

function priceChangeRows(hotelId: number, from: string, to: string): PriceChangeRow[] {
  return all<PriceChangeRow>(
    `SELECT o.id,
            COALESCE(o.operator, '') AS operator,
            COALESCE(o.action, '') AS action,
            COALESCE(o.detail, '') AS detail,
            TRIM(substr(o.detail, 1, instr(o.detail || ' ', ' ') - 1)) AS room_no,
            strftime('%Y-%m-%d %H:%M', o.created_at, '+8 hours') AS created_at,
            COALESCE(s.stay_no, '') AS stay_no,
            COALESCE(s.guest_name, '') AS guest_name,
            COALESCE(s.rate, 0) AS rate,
            COALESCE(s.status, '') AS stay_status,
            substr(s.check_in_time, 1, 10) AS check_in_date
     FROM op_logs o
     LEFT JOIN stays s ON s.id = (
       SELECT s2.id FROM stays s2 JOIN rooms r2 ON r2.id = s2.room_id
       WHERE s2.hotel_id = o.hotel_id
         AND r2.room_no = TRIM(substr(o.detail, 1, instr(o.detail || ' ', ' ') - 1))
         AND date(s2.check_in_time, '+8 hours') <= date(o.created_at, '+8 hours')
       ORDER BY s2.check_in_time DESC LIMIT 1
     )
     WHERE o.hotel_id = ? AND o.action LIKE '%调价%' AND date(o.created_at, '+8 hours') BETWEEN ? AND ?
     ORDER BY o.created_at DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 17. 免费房报表 ---------- */
type FreeStayRow = {
  stay_no: string;
  room_no: string;
  guest_name: string;
  rate: number;
  nights: number;
  status: string;
  check_in_date: string | null;
  check_out_date: string;
  remark: string;
  channel: string;
  reason: string;
};

function freeStayRows(hotelId: number, from: string, to: string): FreeStayRow[] {
  return all<FreeStayRow>(
    `SELECT s.stay_no, COALESCE(r.room_no, '') AS room_no, COALESCE(s.guest_name, '') AS guest_name,
            COALESCE(s.rate, 0) AS rate, COALESCE(s.nights, 0) AS nights, COALESCE(s.status, '') AS status,
            substr(s.check_in_time, 1, 10) AS check_in_date,
            COALESCE(s.actual_check_out, s.expect_check_out, '') AS check_out_date,
            COALESCE(s.remark, '') AS remark,
            COALESCE(ch.name, '散客') AS channel,
            CASE WHEN COALESCE(s.rate, 0) <= 0 THEN '零房价' ELSE '免费备注' END AS reason
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     LEFT JOIN channels ch ON ch.id = s.channel_id
     WHERE s.hotel_id = ? AND (COALESCE(s.rate, 0) <= 0 OR s.remark LIKE '%免费%')
       AND substr(s.check_in_time, 1, 10) BETWEEN ? AND ?
     ORDER BY s.check_in_time DESC`,
    [hotelId, from, to]
  );
}

type FreeBookingRow = {
  booking_no: string;
  room_type: string;
  guest_name: string;
  rate: number;
  nights: number;
  status: string;
  check_in_date: string;
  check_out_date: string;
  remark: string;
  channel: string;
  reason: string;
};

function freeBookingRows(hotelId: number, from: string, to: string): FreeBookingRow[] {
  return all<FreeBookingRow>(
    `SELECT COALESCE(b.booking_no, '') AS booking_no,
            COALESCE(rt.name, '未排房型') AS room_type,
            COALESCE(b.guest_name, '') AS guest_name,
            COALESCE(b.rate, 0) AS rate, COALESCE(b.nights, 0) AS nights,
            COALESCE(b.status, '') AS status, COALESCE(b.check_in_date, '') AS check_in_date,
            COALESCE(b.check_out_date, '') AS check_out_date, COALESCE(b.remark, '') AS remark,
            COALESCE(ch.name, '散客') AS channel,
            CASE WHEN COALESCE(b.rate, 0) <= 0 THEN '零房价' ELSE '免费备注' END AS reason
     FROM bookings b
     LEFT JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN channels ch ON ch.id = b.channel_id
     WHERE b.hotel_id = ? AND (COALESCE(b.rate, 0) <= 0 OR b.remark LIKE '%免费%')
       AND b.check_in_date BETWEEN ? AND ?
     ORDER BY b.check_in_date DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 18. 时租房报表 ---------- */
type HourlyRow = {
  id: number;
  stay_no: string;
  room_no: string;
  guest_name: string;
  rate: number;
  nights: number;
  deposit: number;
  status: string;
  check_in: string | null;
  check_out: string;
  hours: number;
  channel: string;
  balance: number;
  folio_no: string;
};

function hourlyRows(hotelId: number, from: string, to: string): HourlyRow[] {
  return all<HourlyRow>(
    `SELECT s.id, s.stay_no, COALESCE(r.room_no, '') AS room_no, COALESCE(s.guest_name, '') AS guest_name,
            COALESCE(s.rate, 0) AS rate, COALESCE(s.nights, 0) AS nights, COALESCE(s.deposit, 0) AS deposit,
            COALESCE(s.status, '') AS status,
            strftime('%Y-%m-%d %H:%M', s.check_in_time, '+8 hours') AS check_in,
            COALESCE(strftime('%Y-%m-%d %H:%M', s.actual_check_out, '+8 hours'), '') AS check_out,
            CASE
              WHEN s.actual_check_out IS NOT NULL AND s.check_in_time IS NOT NULL
                THEN ROUND((julianday(s.actual_check_out) - julianday(s.check_in_time)) * 24, 1)
              WHEN s.check_in_time IS NOT NULL
                THEN ROUND((julianday('now', '+8 hours') - julianday(s.check_in_time)) * 24, 1)
              ELSE 0
            END AS hours,
            COALESCE(ch.name, '散客') AS channel,
            COALESCE(f.balance, 0) AS balance, COALESCE(f.folio_no, '') AS folio_no
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     LEFT JOIN channels ch ON ch.id = s.channel_id
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND COALESCE(s.nights, 0) = 0
       AND substr(s.check_in_time, 1, 10) BETWEEN ? AND ?
     ORDER BY s.check_in_time DESC`,
    [hotelId, from, to]
  );
}

/* ---------- 19. 包价报表 ---------- */
type PackageStayRow = {
  stay_no: string;
  room_no: string;
  guest_name: string;
  package_code: string;
  rate: number;
  nights: number;
  status: string;
  breakfast: number;
  check_in_date: string | null;
};

function packageStayRows(hotelId: number, from: string, to: string): PackageStayRow[] {
  return all<PackageStayRow>(
    `SELECT s.stay_no, COALESCE(r.room_no, '') AS room_no, COALESCE(s.guest_name, '') AS guest_name,
            COALESCE(s.package_code, '') AS package_code, COALESCE(s.rate, 0) AS rate,
            COALESCE(s.nights, 0) AS nights, COALESCE(s.status, '') AS status,
            COALESCE(s.breakfast, 0) AS breakfast,
            substr(s.check_in_time, 1, 10) AS check_in_date
     FROM stays s
     LEFT JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND COALESCE(s.package_code, '') <> ''
       AND substr(s.check_in_time, 1, 10) BETWEEN ? AND ?
     ORDER BY s.check_in_time DESC`,
    [hotelId, from, to]
  );
}

type PackageBookingRow = {
  booking_no: string;
  room_type: string;
  guest_name: string;
  package_code: string;
  rate: number;
  nights: number;
  status: string;
  breakfast: number;
  check_in_date: string;
};

function packageBookingRows(hotelId: number, from: string, to: string): PackageBookingRow[] {
  return all<PackageBookingRow>(
    `SELECT b.booking_no, COALESCE(rt.name, '未排房型') AS room_type, COALESCE(b.guest_name, '') AS guest_name,
            COALESCE(b.package_code, '') AS package_code, COALESCE(b.rate, 0) AS rate,
            COALESCE(b.nights, 0) AS nights, COALESCE(b.status, '') AS status,
            COALESCE(b.breakfast, 0) AS breakfast, COALESCE(b.check_in_date, '') AS check_in_date
     FROM bookings b
     LEFT JOIN room_types rt ON rt.id = b.room_type_id
     WHERE b.hotel_id = ? AND COALESCE(b.package_code, '') <> ''
       AND b.check_in_date BETWEEN ? AND ?
     ORDER BY b.check_in_date DESC`,
    [hotelId, from, to]
  );
}

type PackageDefRow = {
  code: string;
  name: string;
  price: number;
  breakfast_count: number;
  items: string;
  status: string;
};

function packageDefRows(hotelId: number): PackageDefRow[] {
  return all<PackageDefRow>(
    `SELECT code, name, COALESCE(price, 0) AS price,
            COALESCE(breakfast_count, 0) AS breakfast_count,
            COALESCE(items, '') AS items, COALESCE(status, '') AS status
     FROM package_code WHERE hotel_id = ? ORDER BY code`,
    [hotelId]
  );
}

/* ---------- 20. 早餐报表 ---------- */
type BreakfastRow = {
  id: number;
  date: string;
  room_no: string;
  guest_name: string;
  count: number;
  status: string;
  note: string;
  stay_breakfast: number;
  created_at: string | null;
};

function breakfastRows(hotelId: number, from: string, to: string): BreakfastRow[] {
  return all<BreakfastRow>(
    `SELECT b.id, b.date, COALESCE(b.room_no, '') AS room_no, COALESCE(b.guest_name, '') AS guest_name,
            COALESCE(b.count, 0) AS count, COALESCE(b.status, '') AS status,
            COALESCE(b.note, '') AS note, COALESCE(s.breakfast, 0) AS stay_breakfast,
            strftime('%Y-%m-%d %H:%M', b.created_at, '+8 hours') AS created_at
     FROM breakfast_records b
     LEFT JOIN stays s ON s.id = b.stay_id
     WHERE b.hotel_id = ? AND b.date BETWEEN ? AND ?
     ORDER BY b.date DESC, b.room_no`,
    [hotelId, from, to]
  );
}

type BreakfastDailyRow = {
  date: string;
  rooms: number;
  portions: number;
  used: number;
  pending: number;
};

function breakfastDailyAgg(hotelId: number, from: string, to: string): BreakfastDailyRow[] {
  return all<BreakfastDailyRow>(
    `SELECT date, COUNT(*) AS rooms,
            COALESCE(SUM(COALESCE(count, 0)), 0) AS portions,
            COALESCE(SUM(CASE WHEN status = 'USED' THEN COALESCE(count, 0) ELSE 0 END), 0) AS used,
            COALESCE(SUM(CASE WHEN status = 'PENDING' THEN COALESCE(count, 0) ELSE 0 END), 0) AS pending
     FROM breakfast_records
     WHERE hotel_id = ? AND date BETWEEN ? AND ?
     GROUP BY date
     ORDER BY date DESC`,
    [hotelId, from, to]
  );
}

/* ================================================================== *
 * 六、公共小组件
 * ================================================================== */

const SUM_TD = "td text-right font-semibold tabular-nums text-gray-900";

function DeltaBadge({ d }: { d: DeltaInfo }) {
  if (d.dir === "flat") {
    return <span className="text-[11px] text-gray-400">{d.text}</span>;
  }
  const up = d.dir === "up";
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${
        up ? "text-[#e2483a]" : "text-[#32a852]"
      }`}
    >
      <span aria-hidden>{up ? "↑" : "↓"}</span>
      {d.text}
    </span>
  );
}

function KpiCard({
  label,
  hint,
  prevLabel,
  prevValue,
  delta,
  main,
  active,
  detailHref,
}: {
  label: string;
  hint: string;
  prevLabel?: string;
  prevValue?: string;
  delta?: DeltaInfo;
  main: string;
  active?: boolean;
  detailHref: string;
}) {
  return (
    <div className="rounded-[4px] border border-[#eee] bg-white p-3 transition-shadow hover:shadow-sm">
      <div className="flex items-center gap-1">
        <span className="text-[12px] text-gray-500">{label}</span>
        <span
          title={hint}
          className="flex h-[13px] w-[13px] shrink-0 cursor-help items-center justify-center rounded-full border border-gray-300 text-[9px] leading-none text-gray-400"
        >
          ?
        </span>
      </div>
      {prevValue !== undefined && delta !== undefined && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-[11px] text-gray-400">
          <span>{prevLabel}</span>
          <span className="tabular-nums">{prevValue}</span>
          <DeltaBadge d={delta} />
        </div>
      )}
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className={`text-[20px] font-bold tabular-nums ${active ? "text-[#32c141]" : "text-gray-900"}`}>
          {main}
        </span>
        <Link href={detailHref} className="shrink-0 pb-0.5 text-[11px] text-[#2f6fed] hover:underline">
          详情&gt;
        </Link>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[4px] border border-[#eee] bg-white p-3">
      <div className="flex items-center gap-1">
        <span className="text-[12px] text-gray-500">{label}</span>
        {hint && (
          <span
            title={hint}
            className="flex h-[13px] w-[13px] shrink-0 cursor-help items-center justify-center rounded-full border border-gray-300 text-[9px] leading-none text-gray-400"
          >
            ?
          </span>
        )}
      </div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums text-gray-900">{value}</div>
    </div>
  );
}

function ShareBar({ value, total, tone = "bg-[#32c141]" }: { value: number; total: number; tone?: string }) {
  /*
   * 占比条形图（P2-9）：share() 现在会返回负数（红字科目），但 CSS width 不接受
   * 负百分比 —— 直接塞进去会被浏览器当无效值丢掉，条形反而不显示。
   * 宽度按 0 兜底、文字如实显示负值，这样「这个科目是负的」既不丢信息也不破样式。
   */
  const pct = share(value, total);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-gray-100">
        <div className={`h-1.5 rounded-full ${pct < 0 ? "bg-red-300" : tone}`} style={{ width: `${Math.max(0, pct)}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-500">
        {total > 0 || total < 0 ? `${pct.toFixed(2)}%` : "-"}
      </span>
    </div>
  );
}

function SectionCard({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[4px] border border-[#eee] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f2f2f2] px-3.5 py-2">
        <span className="text-[12px] font-semibold text-gray-700">{title}</span>
        <span className="text-[11px] text-gray-400">{right}</span>
      </div>
      {children}
    </div>
  );
}

function EmptyRow({ colSpan, text = "暂无数据" }: { colSpan: number; text?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="td py-8 text-center text-[12px] text-gray-400">
        {text}
      </td>
    </tr>
  );
}

function TotalRow({ children }: { children: ReactNode }) {
  return <tr className="border-t border-gray-200 bg-gray-50">{children}</tr>;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[11px] ${
        ITEM_TYPE_CLS[type] ?? "border-gray-200 bg-gray-50 text-gray-600"
      }`}
    >
      {ITEM_TYPE_LABEL[type] ?? type}
    </span>
  );
}

function NoteCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[4px] border border-[#eee] bg-white px-3.5 py-2.5 text-[11px] leading-5 text-gray-500">
      {children}
    </div>
  );
}

/* ================================================================== *
 * 七、报表上下文
 * ================================================================== */

type FilterState = { r: string; range: string; from: string; to: string; cmp: string };
type ReportsSearchParams = {
  r?: string;
  range?: string;
  from?: string;
  to?: string;
  cmp?: string;
};

type ReportCtx = {
  hotelId: number;
  from: string;
  to: string;
  cmp: CmpKey;
  cmpFrom: string;
  cmpTo: string;
  days: number;
  todayDate: string;
  sellableRooms: number;
  totalRooms: number;
  hotelName: string;
  href: (patch: Partial<FilterState>) => string;
};

type ReportProps = { ctx: ReportCtx };

function rangeText(ctx: ReportCtx): string {
  return ctx.from === ctx.to ? ctx.from : `${ctx.from} ~ ${ctx.to}`;
}

/* ================================================================== *
 * 八、各报表实现
 * ================================================================== */

/* -------------------- 1. 酒店经营总表 -------------------- */
function ReportHotelSummary({ ctx }: ReportProps) {
  const { hotelId, from, to, href } = ctx;
  const cur = categoryAgg(hotelId, from, to);
  const prev = categoryAgg(hotelId, ctx.cmpFrom, ctx.cmpTo);
  const pay = paymentAgg(hotelId, from, to);
  const payPrev = paymentAgg(hotelId, ctx.cmpFrom, ctx.cmpTo);
  const ar = receivableAgg(hotelId);
  const finEx = financeAnomalyCount(hotelId, from, to);
  const finExPrev = financeAnomalyCount(hotelId, ctx.cmpFrom, ctx.cmpTo);
  const fdEx = frontDeskAnomalyCount(hotelId, from, to);
  const fdExPrev = frontDeskAnomalyCount(hotelId, ctx.cmpFrom, ctx.cmpTo);
  const roomState = roomStateMismatch(hotelId);
  const hasRows = cur.rows.some((r) => Math.abs(r.amount) > 0.005);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="门店总收入"
          hint="统计区间内全部营业收入（房费 + 餐饮 + 其他，不含押金与调整）"
          prevLabel={CMP_SHORT[ctx.cmp]}
          prevValue={fmtMoney(prev.income)}
          delta={moneyDelta(cur.income, prev.income)}
          main={fmtMoney(cur.income)}
          active
          detailHref={href({ r: "biz-daily" })}
        />
        <KpiCard
          label="门店总收款"
          hint="统计区间内收款流水合计"
          prevLabel={CMP_SHORT[ctx.cmp]}
          prevValue={fmtMoney(payPrev.amount)}
          delta={moneyDelta(pay.amount, payPrev.amount)}
          main={fmtMoney(pay.amount)}
          detailHref={href({ r: "receipt-summary" })}
        />
        <KpiCard
          label="应催账款"
          hint="当前未结账务单的应收余额合计（实时）"
          main={fmtMoney(ar.total)}
          detailHref={href({ r: "quick-dun" })}
        />
        <KpiCard
          label="账务异常"
          hint="账单金额不平 / 负余额 / 已结账仍挂余额"
          prevLabel={CMP_SHORT[ctx.cmp]}
          prevValue={`${finExPrev}次`}
          delta={countDelta(finEx, finExPrev)}
          main={String(finEx)}
          detailHref={href({ r: "quick-fin-ex" })}
        />
      </div>

      <div className="rounded-[4px] border border-[#eee] bg-white px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[12px] text-gray-500">前台操作异常</span>
          <span
            title="冲账调整明细 / 有余额但无消费明细的账务单 / 负数明细"
            className="flex h-[13px] w-[13px] cursor-help items-center justify-center rounded-full border border-gray-300 text-[9px] leading-none text-gray-400"
          >
            ?
          </span>
          <span className="rounded bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-400">{CMP_SHORT[ctx.cmp]}</span>
          <span className="text-[11px] tabular-nums text-gray-500">{fdExPrev}次</span>
          <DeltaBadge d={countDelta(fdEx, fdExPrev)} />
          <span className="text-[18px] font-semibold tabular-nums text-gray-900">{fdEx}</span>
          <span className="ml-auto flex items-center gap-3 text-[11px]">
            <span className={roomState.total === 0 ? "text-gray-400" : "text-[#e2483a]"}>
              房态一致性 {roomState.total === 0 ? "正常" : `异常 ${roomState.total} 间`}
            </span>
            <Link href={href({ r: "quick-fd-ex" })} className="text-[#2a9d3a] hover:underline">
              详情&gt;
            </Link>
          </span>
        </div>
      </div>

      <SectionCard
        title="经营项目明细"
        right={`${rangeText(ctx)} · 间夜 ${cur.nights} · 合计 ${fmtMoney(cur.income)}`}
      >
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">项目</th>
              <th className="th text-right">金额</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {!hasRows && <EmptyRow colSpan={3} />}
            {cur.rows.map((row) => (
              <tr key={row.label} className="hover:bg-gray-50">
                <td className="td text-gray-600">{row.label}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(row.amount)}</td>
                <td className="td">
                  <ShareBar value={row.amount} total={cur.income} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtMoney(cur.income)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-gray-500">快速查看：</span>
        {QUICK_VIEWS.map((q) => (
          <Link
            key={q.key}
            href={href({ r: q.key })}
            className="inline-flex h-[26px] items-center rounded-[3px] bg-[#32c141] px-2.5 text-[12px] text-white transition-colors hover:bg-[#2bb038]"
          >
            {q.label}
          </Link>
        ))}
      </div>
    </>
  );
}

/* -------------------- 2. 客房收益报表 -------------------- */
function ReportRoomRevenue({ ctx }: ReportProps) {
  const { hotelId, from, to, days } = ctx;
  const cur = categoryAgg(hotelId, from, to);
  const prev = categoryAgg(hotelId, ctx.cmpFrom, ctx.cmpTo);
  const capacity = roomTypeCapacity(hotelId);
  const rows = roomTypeAgg(hotelId, from, to);
  const channels = channelAgg(hotelId, from, to);
  const capMap = new Map<string, number>();
  for (const c of capacity) capMap.set(c.name ?? "未分房型", num(c.rooms));
  const capRooms = capacity.reduce((s, c) => s + num(c.rooms), 0);
  const capNights = capRooms * days;
  const adr = cur.nights > 0 ? cur.room / cur.nights : 0;
  const revpar = capNights > 0 ? cur.room / capNights : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="房费收入"
          hint="统计区间内房费明细合计"
          prevLabel={CMP_SHORT[ctx.cmp]}
          prevValue={fmtMoney(prev.room)}
          delta={moneyDelta(cur.room, prev.room)}
          main={fmtMoney(cur.room)}
          active
          detailHref={ctx.href({ r: "room-fee-daily" })}
        />
        <KpiCard
          label="间夜数"
          hint="统计区间内已过房费的间夜数"
          prevLabel={CMP_SHORT[ctx.cmp]}
          prevValue={`${prev.nights}`}
          delta={countDelta(cur.nights, prev.nights, "")}
          main={fmtInt(cur.nights)}
          detailHref={ctx.href({ r: "room-fee-daily" })}
        />
        <KpiCard
          label="平均房价 ADR"
          hint="房费收入 ÷ 间夜数"
          main={fmtMoney(adr)}
          detailHref={ctx.href({ r: "room-fee-daily" })}
        />
        <KpiCard
          label="RevPAR"
          hint={`房费收入 ÷ 可售房晚（可售房 ${capRooms} 间 × ${days} 天）`}
          main={fmtMoney(revpar)}
          detailHref={ctx.href({ r: "biz-daily" })}
        />
      </div>

      <SectionCard
        title="按房型收益"
        right={`可售房 ${capRooms} 间 × ${days} 天 = ${fmtInt(capNights)} 房晚`}
      >
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">房型</th>
              <th className="th text-right">间夜</th>
              <th className="th text-right">房费</th>
              <th className="th text-right">ADR</th>
              <th className="th text-right">RevPAR</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={6} />}
            {rows.map((r, i) => {
              const name = r.name ?? "未分房型";
              const roomCount = capMap.get(name) ?? 0;
              const typeCapNights = roomCount * days;
              return (
                <tr key={`${name}-${i}`} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{name}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.room))}</td>
                  <td className="td text-right tabular-nums text-gray-500">
                    {fmtMoney(num(r.nights) > 0 ? num(r.room) / num(r.nights) : 0)}
                  </td>
                  <td className="td text-right tabular-nums text-gray-500">
                    {fmtMoney(typeCapNights > 0 ? num(r.room) / typeCapNights : 0)}
                  </td>
                  <td className="td">
                    <ShareBar value={num(r.room)} total={cur.room} />
                  </td>
                </tr>
              );
            })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(cur.nights)}</td>
              <td className={SUM_TD}>{fmtMoney(cur.room)}</td>
              <td className={SUM_TD}>{fmtMoney(adr)}</td>
              <td className={SUM_TD}>{fmtMoney(revpar)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="按渠道收益" right={`房费合计 ${fmtMoney(cur.room)}`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">客源渠道</th>
              <th className="th text-right">间夜</th>
              <th className="th text-right">房费</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {channels.length === 0 && <EmptyRow colSpan={4} />}
            {channels.map((c, i) => (
              <tr key={`${c.name ?? "unknown"}-${i}`} className="hover:bg-gray-50">
                <td className="td text-gray-700">{c.name ?? "散客"}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(c.nights))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(c.room))}</td>
                <td className="td">
                  <ShareBar value={num(c.room)} total={cur.room} tone="bg-brand-500" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(channels.reduce((s, c) => s + num(c.nights), 0))}</td>
              <td className={SUM_TD}>{fmtMoney(channels.reduce((s, c) => s + num(c.room), 0))}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        <StatCard label="可售房晚" value={fmtInt(capNights)} hint="可售房 × 统计天数" />
        <StatCard label="已售房晚" value={fmtInt(cur.nights)} />
        <StatCard label="平均房价" value={fmtMoney(adr)} />
        <StatCard label="RevPAR" value={fmtMoney(revpar)} hint="房费 ÷ 可售房晚" />
      </div>
    </>
  );
}

/* -------------------- 3. 交班报表 -------------------- */
function ReportShiftReport({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = shiftPayAgg(hotelId, from, to);
  const windows = shiftWindowAgg(hotelId, from, to);
  const methodSet = new Set<string>();
  for (const r of rows) if (r.method) methodSet.add(r.method);
  const methods: string[] = [
    ...PAY_METHOD_ORDER.filter((m) => methodSet.has(m)),
    ...[...methodSet].filter((m) => !PAY_METHOD_ORDER.includes(m)),
  ];
  if (methods.length === 0) methods.push("现金", "微信", "支付宝", "银行卡");

  const pivot = new Map<string, number>();
  for (const r of rows) pivot.set(`${r.shift}|${r.method ?? ""}`, num(r.amount));

  const grandCnt = rows.reduce((s, r) => s + num(r.cnt), 0);
  const grandAmount = rows.reduce((s, r) => s + num(r.amount), 0);
  const activeShifts = new Set(rows.map((r) => r.shift)).size;

  const rowData = SHIFT_DEFS.map((def) => {
    const vals = methods.map((m) => pivot.get(`${def.key}|${m}`) ?? 0);
    const cnt = rows.filter((r) => r.shift === def.key).reduce((s, r) => s + num(r.cnt), 0);
    return { def, vals, cnt, total: vals.reduce((s, v) => s + v, 0) };
  });

  const methodTotals = methods.map((m) =>
    rows.filter((r) => (r.method ?? "") === m).reduce((s, r) => s + num(r.amount), 0)
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="收款笔数" value={fmtInt(grandCnt)} hint="区间内收款流水笔数" />
        <StatCard label="收款金额" value={fmtMoney(grandAmount)} />
        <StatCard label="有收款班次" value={`${activeShifts} / ${SHIFT_DEFS.length}`} hint="早 / 中 / 夜三班" />
        <StatCard label="覆盖天数" value={`${ctx.days} 天`} />
      </div>

      <SectionCard
        title="按班次收款汇总"
        right={`${rangeText(ctx)} · 早班 08:00-16:00 / 中班 16:00-24:00 / 夜班 00:00-08:00`}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">班次</th>
                <th className="th text-right">笔数</th>
                {methods.map((m) => (
                  <th key={m} className="th text-right">
                    {m}
                  </th>
                ))}
                <th className="th text-right">合计</th>
                <th className="th w-40">占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={3 + methods.length} />}
              {rowData.map((r) => (
                <tr key={r.def.key} className="hover:bg-gray-50">
                  <td className="td text-gray-700">
                    <span className="font-medium text-gray-800">{r.def.label}</span>
                    <span className="ml-1.5 text-[11px] text-gray-400">{r.def.window}</span>
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(r.cnt)}</td>
                  {r.vals.map((v, i) => (
                    <td key={`${r.def.key}-${methods[i]}`} className="td text-right tabular-nums text-gray-700">
                      {fmtMoney(v)}
                    </td>
                  ))}
                  <td className="td text-right font-medium tabular-nums text-gray-800">{fmtMoney(r.total)}</td>
                  <td className="td">
                    <ShareBar value={r.total} total={grandAmount} />
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className={SUM_TD}>{fmtInt(grandCnt)}</td>
                {methodTotals.map((v, i) => (
                  <td key={`sum-${methods[i]}`} className={SUM_TD}>
                    {fmtMoney(v)}
                  </td>
                ))}
                <td className={SUM_TD}>{fmtMoney(grandAmount)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="班次交接时间" right="按收款发生时间（北京时间）归集">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">班次</th>
              <th className="th">时间窗</th>
              <th className="th text-right">收款笔数</th>
              <th className="th text-right">收款金额</th>
              <th className="th">首笔时间</th>
              <th className="th">末笔时间</th>
            </tr>
          </thead>
          <tbody>
            {windows.length === 0 && <EmptyRow colSpan={6} />}
            {SHIFT_DEFS.map((def) => {
              const w = windows.find((x) => x.shift === def.key);
              const amount = rowData.find((r) => r.def.key === def.key)?.total ?? 0;
              return (
                <tr key={`w-${def.key}`} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{def.label}</td>
                  <td className="td text-gray-500">{def.window}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(w?.cnt))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(amount)}</td>
                  <td className="td tabular-nums text-gray-600">{w?.first_at ?? "-"}</td>
                  <td className="td tabular-nums text-gray-600">{w?.last_at ?? "-"}</td>
                </tr>
              );
            })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className="td" />
              <td className={SUM_TD}>{fmtInt(grandCnt)}</td>
              <td className={SUM_TD}>{fmtMoney(grandAmount)}</td>
              <td className="td" />
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：班次按收款流水的发生时间（created_at + 8 小时）划分，营业日维度仍按 payments.biz_date
        统计；如某班次当日无收款，该班次整行显示 0 值。
      </NoteCard>
    </>
  );
}

/* -------------------- 4. 交班汇总表 -------------------- */
function ReportShiftSummary({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = operatorPayAgg(hotelId, from, to);
  const totalCnt = rows.reduce((s, r) => s + num(r.cnt), 0);
  const totalReceipt = rows.reduce((s, r) => s + num(r.receipt), 0);
  const totalRefund = rows.reduce((s, r) => s + num(r.refund), 0);
  const totalNet = rows.reduce((s, r) => s + num(r.net), 0);
  const settled = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM folios
     WHERE hotel_id = ? AND status = 'SETTLED' AND settled_at IS NOT NULL
       AND date(settled_at, '+8 hours') BETWEEN ? AND ?`,
    [hotelId, from, to]
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="收款合计" value={fmtMoney(totalReceipt)} hint="正数收款流水之和" />
        <StatCard label="退款合计" value={fmtMoney(totalRefund)} hint="负数流水 / 退款冲回" />
        <StatCard label="净收" value={fmtMoney(totalNet)} hint="收款 − 退款" />
        <StatCard label="区间已结账账单" value={fmtInt(num(settled?.n))} />
      </div>

      <SectionCard title="按操作人交班汇总" right={`${rangeText(ctx)} · 共 ${rows.length} 位操作人`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">操作人</th>
              <th className="th text-right">收款笔数</th>
              <th className="th text-right">收款金额</th>
              <th className="th text-right">退款金额</th>
              <th className="th text-right">净收</th>
              <th className="th w-44">净收占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={6} />}
            {rows.map((r, i) => (
              <tr key={`${r.operator}-${i}`} className="hover:bg-gray-50">
                <td className="td text-gray-700">{r.operator}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.cnt))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.receipt))}</td>
                <td className="td text-right tabular-nums text-[#e2483a]">{fmtMoney(num(r.refund))}</td>
                <td className="td text-right font-medium tabular-nums text-gray-900">{fmtMoney(num(r.net))}</td>
                <td className="td">
                  <ShareBar value={num(r.net)} total={totalNet} tone="bg-[#58bc62]" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(totalCnt)}</td>
              <td className={SUM_TD}>{fmtMoney(totalReceipt)}</td>
              <td className={SUM_TD}>{fmtMoney(totalRefund)}</td>
              <td className={SUM_TD}>{fmtMoney(totalNet)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：操作人取该账务单最早一条消费明细的过账人（folio_items.created_by → users.real_name），
        未记录过账人的账单归入「未记录」。净收 = 收款 − 退款（对应 payments.amount 的正负合计）。
      </NoteCard>
    </>
  );
}

/* -------------------- 5. 结账单日报表 -------------------- */
function ReportFolioDaily({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = folioDailyRows(hotelId, from, to);
  const charge = rows.reduce((s, r) => s + num(r.total_amount), 0);
  const paid = rows.reduce((s, r) => s + num(r.paid_amount), 0);
  const balance = rows.reduce((s, r) => s + num(r.balance), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="已结账单数" value={fmtInt(rows.length)} hint="区间内完成结账的账务单" />
        <StatCard label="消费合计" value={fmtMoney(charge)} />
        <StatCard label="收款合计" value={fmtMoney(paid)} />
        <StatCard label="应收余额" value={fmtMoney(balance)} hint="结账时仍挂账的金额" />
      </div>

      <SectionCard title="结账单日报表" right={`${rangeText(ctx)} · 按结账时间倒序`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">账单号</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">入住</th>
                <th className="th">离店</th>
                <th className="th text-right">晚数</th>
                <th className="th text-right">消费</th>
                <th className="th text-right">收款</th>
                <th className="th text-right">余额</th>
                <th className="th">结账时间</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={11} />}
              {rows.map((r) => (
                <tr key={r.folio_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{r.folio_no}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums">{dash(r.room_no)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.checkout_date)}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.total_amount))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.paid_amount))}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(r.balance))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.settled_at)}</td>
                  <td className="td text-gray-600">{r.operator}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(charge)}</td>
                <td className={SUM_TD}>{fmtMoney(paid)}</td>
                <td className={SUM_TD}>{fmtMoney(balance)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

/* -------------------- 6. 消费明细报表 -------------------- */
function ReportConsumeDetail({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = consumeRows(hotelId, from, to);
  const totalCount = consumeTotalCount(hotelId, from, to);
  const amount = rows.reduce((s, r) => s + num(r.amount), 0);
  const qty = rows.reduce((s, r) => s + num(r.qty), 0);
  const room = rows.filter((r) => r.item_type === "ROOM").reduce((s, r) => s + num(r.amount), 0);
  const food = rows.filter((r) => r.item_type === "FOOD").reduce((s, r) => s + num(r.amount), 0);
  const allAmount = get<{ amount: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS amount FROM folio_items
     WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?`,
    [hotelId, from, to]
  );
  const grandAmount = num(allAmount?.amount);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="明细笔数" value={fmtInt(totalCount)} hint="区间内账务明细总条数" />
        <StatCard label="金额合计" value={fmtMoney(grandAmount)} />
        <StatCard label="房费合计" value={fmtMoney(room)} />
        <StatCard label="餐饮合计" value={fmtMoney(food)} />
      </div>

      <SectionCard
        title="消费明细"
        right={
          totalCount > CONSUME_LIMIT
            ? `共 ${totalCount} 条，当前仅显示最近 ${CONSUME_LIMIT} 条`
            : `${rangeText(ctx)} · 共 ${totalCount} 条`
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">类型</th>
                <th className="th">摘要</th>
                <th className="th">房号 / 客人</th>
                <th className="th text-right">数量</th>
                <th className="th text-right">单价</th>
                <th className="th text-right">金额</th>
                <th className="th">操作人</th>
                <th className="th">发生时间</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={10} />}
              {rows.map((r, i) => (
                <tr key={`${r.biz_date}-${i}`} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{r.biz_date}</td>
                  <td className="td">
                    <TypeBadge type={r.item_type} />
                  </td>
                  <td className="td text-gray-700">{dash(r.description)}</td>
                  <td className="td text-gray-500">
                    {dash(r.room_no)}
                    {r.guest_name ? ` / ${r.guest_name}` : ""}
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.qty))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.price))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.amount))}</td>
                  <td className="td text-gray-600">{r.operator}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(qty)}</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(amount)}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：本表逐条列出 folio_items 账务明细，包含押金与调整类记录；合计行统计当前展示条数的数量与金额。
        类型说明：房费 ROOM、餐饮 FOOD、其他 OTHER、押金 DEPOSIT、调整 ADJUST。
      </NoteCard>
    </>
  );
}

/* -------------------- 7. 收款明细汇总表 -------------------- */
function ReportReceiptSummary({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const methods = payMethodAgg(hotelId, from, to);
  const details = payDetailRows(hotelId, from, to);
  const pay = paymentAgg(hotelId, from, to);
  const avg = pay.cnt > 0 ? pay.amount / pay.cnt : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="收款笔数" value={fmtInt(pay.cnt)} />
        <StatCard label="收款金额" value={fmtMoney(pay.amount)} />
        <StatCard label="支付方式数" value={fmtInt(methods.length)} />
        <StatCard label="平均单笔" value={fmtMoney(avg)} hint="收款金额 ÷ 笔数" />
      </div>

      <SectionCard title="按支付方式汇总" right={`${rangeText(ctx)} · 共 ${pay.cnt} 笔`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">支付方式</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">金额</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {methods.length === 0 && <EmptyRow colSpan={4} />}
            {methods.map((m, i) => (
              <tr key={`${m.method ?? "unknown"}-${i}`} className="hover:bg-gray-50">
                <td className="td text-gray-700">{m.method ?? "未填方式"}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(m.cnt))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(m.amount))}</td>
                <td className="td">
                  <ShareBar value={num(m.amount)} total={pay.amount} tone="bg-[#58bc62]" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(pay.cnt)}</td>
              <td className={SUM_TD}>{fmtMoney(pay.amount)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="收款流水明细（最近 100 笔）" right={`共 ${pay.cnt} 笔`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">收款单号</th>
                <th className="th">账单号</th>
                <th className="th">客人 / 房号</th>
                <th className="th">营业日</th>
                <th className="th">方式</th>
                <th className="th text-right">金额</th>
                <th className="th">备注</th>
                <th className="th">发生时间</th>
              </tr>
            </thead>
            <tbody>
              {details.length === 0 && <EmptyRow colSpan={8} />}
              {details.map((p) => (
                <tr key={p.pay_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{p.pay_no}</td>
                  <td className="td tabular-nums text-gray-500">{dash(p.folio_no)}</td>
                  <td className="td text-gray-600">
                    {dash(p.guest_name)}
                    {p.room_no ? ` / ${p.room_no}` : ""}
                  </td>
                  <td className="td tabular-nums">{p.biz_date}</td>
                  <td className="td text-gray-600">{p.method ?? "-"}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(p.amount))}</td>
                  <td className="td text-gray-500">{dash(p.remark)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(p.created_at)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(pay.amount)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

/* -------------------- 8. 财务概况 -------------------- */
function ReportFinanceOverview({ ctx }: ReportProps) {
  const { hotelId, from, to, days, sellableRooms } = ctx;
  const cur = categoryAgg(hotelId, from, to);
  const pay = paymentAgg(hotelId, from, to);
  const cost = 0;
  const gross = cur.income - cost;
  const capNights = sellableRooms * days;
  const adr = cur.nights > 0 ? cur.room / cur.nights : 0;
  const revpar = capNights > 0 ? cur.room / capNights : 0;
  const occupancy = capNights > 0 ? cur.nights / capNights : 0;
  const hasRows = cur.income > 0.005 || pay.cnt > 0;

  const lines: { label: string; value: string; note: string; strong?: boolean }[] = [
    { label: "房费收入", value: fmtMoney(cur.room), note: `占收入 ${share(cur.room, cur.income).toFixed(2)}%` },
    { label: "餐饮收入", value: fmtMoney(cur.food), note: `占收入 ${share(cur.food, cur.income).toFixed(2)}%` },
    {
      label: "其他收入",
      value: fmtMoney(cur.otherTotal),
      note: `占收入 ${share(cur.otherTotal, cur.income).toFixed(2)}%`,
    },
    { label: "收入合计", value: fmtMoney(cur.income), note: "房费 + 餐饮 + 其他", strong: true },
    { label: "营业成本", value: fmtMoney(cost), note: "本期未归集成本" },
    { label: "毛利", value: fmtMoney(gross), note: `毛利率 ${fmtPct(cur.income > 0 ? gross / cur.income : 0)}`, strong: true },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="营业收入" value={fmtMoney(cur.income)} hint="房费 + 餐饮 + 其他" />
        <StatCard label="营业成本" value={fmtMoney(cost)} hint="本期未归集成本，按 0 计" />
        <StatCard label="毛利" value={fmtMoney(gross)} />
        <StatCard label="出租率" value={fmtPct(occupancy)} hint={`间夜 ${cur.nights} ÷ 可售房晚 ${capNights}`} />
      </div>

      <SectionCard title="财务概况" right={`${rangeText(ctx)} · ${days} 天 · 可售房 ${sellableRooms} 间`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">项目</th>
              <th className="th text-right">金额</th>
              <th className="th">说明</th>
            </tr>
          </thead>
          <tbody>
            {!hasRows && <EmptyRow colSpan={3} />}
            {lines.map((l, i) => (
              <tr key={`${l.label}-${i}`} className="hover:bg-gray-50">
                <td className={`td ${l.strong ? "font-medium text-gray-800" : "text-gray-600"}`}>{l.label}</td>
                <td className={`td text-right tabular-nums ${l.strong ? "font-semibold text-gray-900" : "text-gray-800"}`}>
                  {l.value}
                </td>
                <td className="td text-gray-500">{l.note}</td>
              </tr>
            ))}
            <tr className="hover:bg-gray-50">
              <td className="td text-gray-600">毛利率</td>
              <td className="td text-right tabular-nums text-gray-800">
                {fmtPct(cur.income > 0 ? gross / cur.income : 0)}
              </td>
              <td className="td text-gray-500">毛利 ÷ 收入</td>
            </tr>
            <tr className="hover:bg-gray-50">
              <td className="td text-gray-600">间夜 / ADR / RevPAR</td>
              <td className="td text-right tabular-nums text-gray-800">{fmtInt(cur.nights)}</td>
              <td className="td text-gray-500">
                ADR {fmtMoney(adr)} · RevPAR {fmtMoney(revpar)}
              </td>
            </tr>
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtMoney(cur.income)}</td>
              <td className="td text-gray-500">
                成本 {fmtMoney(cost)} · 毛利 {fmtMoney(gross)}
              </td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：收入按营业日（biz_date）归集房费 / 餐饮 / 其他，不含押金与调整；成本本期未归集，按 0 计，
        因此毛利等于收入。出租率 = 间夜 ÷（可售房 × 统计天数），可售房已排除维修房与锁房。
      </NoteCard>
    </>
  );
}

/* -------------------- 9. 销售概况 -------------------- */
function ReportSalesOverview({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = salesChannelAgg(hotelId, from, to);
  const totalRevenue = rows.reduce((s, r) => s + num(r.total), 0);
  const totalNights = rows.reduce((s, r) => s + num(r.nights), 0);
  const totalRoom = rows.reduce((s, r) => s + num(r.room), 0);
  const totalCommission = rows.reduce((s, r) => s + num(r.room) * num(r.rate), 0);
  const commissionRate = totalRevenue > 0 ? totalCommission / totalRevenue : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="渠道营收" value={fmtMoney(totalRevenue)} hint="含房费、餐饮与其他收入" />
        <StatCard label="售价间夜" value={fmtInt(totalNights)} />
        <StatCard label="渠道佣金" value={fmtMoney(totalCommission)} hint="房费 × 渠道佣金率" />
        <StatCard label="综合佣金率" value={fmtPct(commissionRate)} />
      </div>

      <SectionCard title="按客源渠道销售概况" right={`${rangeText(ctx)} · 共 ${rows.length} 个渠道`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">客源渠道</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">房费</th>
                <th className="th text-right">总营收</th>
                <th className="th text-right">佣金率</th>
                <th className="th text-right">佣金</th>
                <th className="th w-40">营收占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={7} />}
              {rows.map((r, i) => {
                const commission = num(r.room) * num(r.rate);
                return (
                  <tr key={`${r.name}-${i}`} className="hover:bg-gray-50">
                    <td className="td text-gray-700">{r.name}</td>
                    <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.room))}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.total))}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtPct(num(r.rate))}</td>
                    <td className="td text-right tabular-nums text-gray-700">{fmtMoney(commission)}</td>
                    <td className="td">
                      <ShareBar value={num(r.total)} total={totalRevenue} />
                    </td>
                  </tr>
                );
              })}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className={SUM_TD}>{fmtInt(totalNights)}</td>
                <td className={SUM_TD}>{fmtMoney(totalRoom)}</td>
                <td className={SUM_TD}>{fmtMoney(totalRevenue)}</td>
                <td className={SUM_TD}>{fmtPct(totalRoom > 0 ? totalCommission / totalRoom : 0)}</td>
                <td className={SUM_TD}>{fmtMoney(totalCommission)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：营收按账务明细的营业日归集到入住单所属渠道；佣金 = 房费 × 渠道佣金率（channels.commission，
        散客与协议单位为 0）。未匹配到渠道的在住记录归入「散客」。
      </NoteCard>
    </>
  );
}

/* -------------------- 10. 会员概况 -------------------- */
function ReportMemberOverview({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const levels = memberLevelAgg(hotelId, from, to);
  const rank = memberRankRows(hotelId, from, to);
  const memberLevels = levels.filter((l) => num(l.level) > 0);
  const normal = levels.find((l) => num(l.level) === 0);

  const memberCount = memberLevels.reduce((s, l) => s + num(l.members), 0);
  const memberAmount = memberLevels.reduce((s, l) => s + num(l.amount), 0);
  const memberNights = memberLevels.reduce((s, l) => s + num(l.nights), 0);
  const allAmount = levels.reduce((s, l) => s + num(l.amount), 0);
  const normalAmount = num(normal?.amount);
  const memberShare = allAmount > 0 ? memberAmount / allAmount : 0;
  const rankAmount = rank.reduce((s, r) => s + num(r.amount), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="会员总数" value={fmtInt(memberCount)} hint="vip_level > 0 的客史数量" />
        <StatCard label="会员消费" value={fmtMoney(memberAmount)} />
        <StatCard label="会员间夜" value={fmtInt(memberNights)} />
        <StatCard label="会员消费占比" value={fmtPct(memberShare)} hint="会员消费 ÷ 全部消费" />
      </div>

      <SectionCard title="会员等级消费概况" right={`${rangeText(ctx)} · 会员按客史 vip_level 认定`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">客群 / 等级</th>
              <th className="th text-right">人数</th>
              <th className="th text-right">消费金额</th>
              <th className="th text-right">间夜</th>
              <th className="th w-44">消费占比</th>
            </tr>
          </thead>
          <tbody>
            {levels.length === 0 && <EmptyRow colSpan={5} />}
            {memberLevels.map((l) => (
              <tr key={`lv-${l.level}`} className="hover:bg-gray-50">
                <td className="td text-gray-700">{VIP_LABEL[num(l.level)] ?? `VIP ${l.level}`}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(l.members))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(l.amount))}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(l.nights))}</td>
                <td className="td">
                  <ShareBar value={num(l.amount)} total={allAmount} />
                </td>
              </tr>
            ))}
            {normal && (
              <tr className="hover:bg-gray-50">
                <td className="td text-gray-500">非会员（普通客）</td>
                <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(normal.members))}</td>
                <td className="td text-right tabular-nums text-gray-500">{fmtMoney(normalAmount)}</td>
                <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(normal.nights))}</td>
                <td className="td">
                  <ShareBar value={normalAmount} total={allAmount} tone="bg-gray-300" />
                </td>
              </tr>
            )}
            <TotalRow>
              <td className="td font-medium text-gray-800">会员合计</td>
              <td className={SUM_TD}>{fmtInt(memberCount)}</td>
              <td className={SUM_TD}>{fmtMoney(memberAmount)}</td>
              <td className={SUM_TD}>{fmtInt(memberNights)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="会员消费排行（前 30 位）" right={`会员消费合计 ${fmtMoney(memberAmount)}`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">客人</th>
              <th className="th">等级</th>
              <th className="th text-right">住店次数</th>
              <th className="th text-right">间夜</th>
              <th className="th text-right">消费金额</th>
              <th className="th w-40">占会员消费</th>
            </tr>
          </thead>
          <tbody>
            {rank.length === 0 && <EmptyRow colSpan={6} />}
            {rank.map((r, i) => (
              <tr key={`${r.name}-${i}`} className="hover:bg-gray-50">
                <td className="td text-gray-700">{r.name}</td>
                <td className="td text-gray-500">{VIP_LABEL[num(r.level)] ?? `VIP ${r.level}`}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.stays))}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.amount))}</td>
                <td className="td">
                  <ShareBar value={num(r.amount)} total={memberAmount} tone="bg-[#58bc62]" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className="td" />
              <td className="td" />
              <td className={SUM_TD}>{fmtInt(rank.reduce((s, r) => s + num(r.nights), 0))}</td>
              <td className={SUM_TD}>{fmtMoney(rankAmount)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：会员以客史 guests.vip_level &gt; 0 认定，会员消费通过「在住单客人姓名 = 客史姓名」关联账务明细归集；
        排行仅展示本期有消费的会员，合计取前 30 位汇总。
      </NoteCard>
    </>
  );
}

/* -------------------- 11. 经营项目类型表 -------------------- */
function ReportBizType({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = bizTypeAgg(hotelId, from, to);
  const totalAmount = rows.reduce((s, r) => s + num(r.amount), 0);
  const totalCnt = rows.reduce((s, r) => s + num(r.cnt), 0);
  const totalQty = rows.reduce((s, r) => s + num(r.qty), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="明细笔数" value={fmtInt(totalCnt)} />
        <StatCard label="发生金额" value={fmtMoney(totalAmount)} />
        <StatCard label="项目类型数" value={fmtInt(rows.length)} hint="房费 / 餐饮 / 其他 / 押金 / 调整" />
        <StatCard label="平均单笔" value={fmtMoney(totalCnt > 0 ? totalAmount / totalCnt : 0)} />
      </div>

      <SectionCard title="经营项目类型表" right={rangeText(ctx)}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">项目类型</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">数量</th>
              <th className="th text-right">金额</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={5} />}
            {rows.map((r) => (
              <tr key={r.item_type} className="hover:bg-gray-50">
                <td className="td">
                  <TypeBadge type={r.item_type} />
                </td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.cnt))}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.qty))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.amount))}</td>
                <td className="td">
                  <ShareBar value={num(r.amount)} total={totalAmount} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(totalCnt)}</td>
              <td className={SUM_TD}>{fmtInt(totalQty)}</td>
              <td className={SUM_TD}>{fmtMoney(totalAmount)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：按 folio_items.item_type 汇总，金额包含押金（DEPOSIT）与调整（ADJUST），与营业收入口径不同；
        收入类报表仅统计房费 / 餐饮 / 其他。
      </NoteCard>
    </>
  );
}

/* -------------------- 12. 经营项目汇总表 -------------------- */
function ReportBizTotal({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = bizSummaryAgg(hotelId, from, to);
  const totalCount = bizSummaryCount(hotelId, from, to);
  const totalAmount = rows.reduce((s, r) => s + num(r.amount), 0);
  const totalCnt = rows.reduce((s, r) => s + num(r.cnt), 0);
  const totalQty = rows.reduce((s, r) => s + num(r.qty), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="项目数" value={fmtInt(totalCount)} hint="按摘要去重后的数量" />
        <StatCard label="明细笔数" value={fmtInt(totalCnt)} />
        <StatCard label="发生金额" value={fmtMoney(totalAmount)} />
        <StatCard label="平均单价" value={fmtMoney(totalQty > 0 ? totalAmount / totalQty : 0)} />
      </div>

      <SectionCard
        title="经营项目汇总表（按摘要）"
        right={
          totalCount > BIZ_SUMMARY_LIMIT
            ? `共 ${totalCount} 个项目，当前显示金额前 ${BIZ_SUMMARY_LIMIT} 项`
            : `${rangeText(ctx)} · 共 ${totalCount} 个项目`
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">项目摘要</th>
                <th className="th">类型</th>
                <th className="th text-right">笔数</th>
                <th className="th text-right">数量</th>
                <th className="th text-right">金额</th>
                <th className="th w-40">占比</th>
                <th className="th">营业日范围</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={7} />}
              {rows.map((r, i) => (
                <tr key={`${r.description ?? "unknown"}-${i}`} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{dash(r.description)}</td>
                  <td className="td">
                    <TypeBadge type={r.item_type} />
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.cnt))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.qty))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.amount))}</td>
                  <td className="td">
                    <ShareBar value={num(r.amount)} total={totalAmount} />
                  </td>
                  <td className="td tabular-nums text-gray-500">
                    {dash(r.first_day)}
                    {r.last_day && r.last_day !== r.first_day ? ` ~ ${r.last_day}` : ""}
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(totalCnt)}</td>
                <td className={SUM_TD}>{fmtInt(totalQty)}</td>
                <td className={SUM_TD}>{fmtMoney(totalAmount)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：按 folio_items.description（摘要）分组统计，摘要为空的记录归集为「-」；金额含押金与调整。
      </NoteCard>
    </>
  );
}

/* -------------------- 13. 综合营业日报 -------------------- */
function ReportBizDaily({ ctx }: ReportProps) {
  const { hotelId, from, to, days, sellableRooms } = ctx;
  const cur = categoryAgg(hotelId, from, to);
  const rows = dailyAgg(hotelId, from, to);
  const map = new Map<string, DailyRow>();
  for (const r of rows) map.set(r.biz_date, r);
  const dates = dayList(from, to);
  const adr = cur.nights > 0 ? cur.room / cur.nights : 0;
  const occupancy = sellableRooms > 0 ? cur.nights / (sellableRooms * days) : 0;
  const hasData = rows.length > 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="营业收入" value={fmtMoney(cur.income)} />
        <StatCard label="间夜" value={fmtInt(cur.nights)} />
        <StatCard label="平均房价" value={fmtMoney(adr)} />
        <StatCard label="区间出租率" value={fmtPct(occupancy)} hint={`可售房 ${sellableRooms} 间 × ${days} 天`} />
      </div>

      <SectionCard title="综合营业日报" right={`${rangeText(ctx)} · ${dates.length} 天`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">营业日</th>
              <th className="th text-right">间夜</th>
              <th className="th text-right">房费</th>
              <th className="th text-right">餐饮</th>
              <th className="th text-right">其他</th>
              <th className="th text-right">合计</th>
              <th className="th text-right">ADR</th>
              <th className="th text-right">出租率</th>
            </tr>
          </thead>
          <tbody>
            {!hasData && <EmptyRow colSpan={8} />}
            {hasData &&
              dates.map((d) => {
                const r = map.get(d);
                const room = num(r?.room);
                const food = num(r?.food);
                const other = num(r?.other);
                const nights = num(r?.nights);
                const total = room + food + other;
                return (
                  <tr key={d} className="hover:bg-gray-50">
                    <td className="td tabular-nums text-gray-700">
                      {d}
                      {d === ctx.todayDate && (
                        <span className="ml-1.5 rounded bg-brand-100 px-1 text-[10px] leading-[15px] text-brand-700">
                          今日
                        </span>
                      )}
                    </td>
                    <td className="td text-right tabular-nums">{fmtInt(nights)}</td>
                    <td className="td text-right tabular-nums">{fmtMoney(room)}</td>
                    <td className="td text-right tabular-nums">{fmtMoney(food)}</td>
                    <td className="td text-right tabular-nums">{fmtMoney(other)}</td>
                    <td className="td text-right font-medium tabular-nums text-gray-800">{fmtMoney(total)}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(nights > 0 ? room / nights : 0)}</td>
                    <td className="td text-right tabular-nums">
                      {fmtPct(sellableRooms > 0 ? nights / sellableRooms : 0)}
                    </td>
                  </tr>
                );
              })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(cur.nights)}</td>
              <td className={SUM_TD}>{fmtMoney(cur.room)}</td>
              <td className={SUM_TD}>{fmtMoney(cur.food)}</td>
              <td className={SUM_TD}>{fmtMoney(cur.otherTotal)}</td>
              <td className={SUM_TD}>{fmtMoney(cur.income)}</td>
              <td className={SUM_TD}>{fmtMoney(adr)}</td>
              <td className={SUM_TD}>{fmtPct(occupancy)}</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：逐日按营业日展开，即使某天无营业数据也显示 0 值行，便于观察空档；合计行取区间汇总值，
        出租率按「间夜 ÷ 可售房数」逐日计算。
      </NoteCard>
    </>
  );
}

/* -------------------- 14. 综合营业日报-房型 -------------------- */
function ReportRoomTypeDaily({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = roomTypeMatrix(hotelId, from, to);
  const cur = categoryAgg(hotelId, from, to);
  const capacity = roomTypeCapacity(hotelId);
  const dateSet = new Set<string>();
  const typeSet = new Set<string>();
  const cellMap = new Map<string, number>();
  for (const r of rows) {
    dateSet.add(r.biz_date);
    typeSet.add(r.name);
    cellMap.set(`${r.biz_date}|${r.name}`, num(r.amount));
  }
  const dates = [...dateSet].sort();
  const types: string[] = [...typeSet];
  if (types.length === 0) for (const c of capacity) types.push(c.name ?? "未分房型");
  const dateTotals = new Map<string, number>();
  for (const d of dates) {
    let sum = 0;
    for (const t of types) sum += cellMap.get(`${d}|${t}`) ?? 0;
    dateTotals.set(d, sum);
  }
  const typeTotals = new Map<string, number>();
  for (const t of types) {
    let sum = 0;
    for (const d of dates) sum += cellMap.get(`${d}|${t}`) ?? 0;
    typeTotals.set(t, sum);
  }
  const grand = rows.reduce((s, r) => s + num(r.amount), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="房型数" value={fmtInt(types.length)} />
        <StatCard label="房费合计" value={fmtMoney(grand)} />
        <StatCard label="间夜" value={fmtInt(cur.nights)} />
        <StatCard label="平均房价" value={fmtMoney(cur.nights > 0 ? cur.room / cur.nights : 0)} />
      </div>

      <SectionCard
        title="综合营业日报（逐日 × 房型）"
        right={`${rangeText(ctx)} · 单位：金额（元）`}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                {types.map((t) => (
                  <th key={t} className="th text-right whitespace-nowrap">
                    {t}
                  </th>
                ))}
                <th className="th text-right">日合计</th>
              </tr>
            </thead>
            <tbody>
              {dates.length === 0 && <EmptyRow colSpan={2 + types.length} />}
              {dates.map((d) => (
                <tr key={d} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{d}</td>
                  {types.map((t) => (
                    <td key={`${d}-${t}`} className="td text-right tabular-nums text-gray-700">
                      {fmtMoney(cellMap.get(`${d}|${t}`) ?? 0)}
                    </td>
                  ))}
                  <td className="td text-right font-medium tabular-nums text-gray-800">
                    {fmtMoney(dateTotals.get(d) ?? 0)}
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                {types.map((t) => (
                  <td key={`sum-${t}`} className={SUM_TD}>
                    {fmtMoney(typeTotals.get(t) ?? 0)}
                  </td>
                ))}
                <td className={SUM_TD}>{fmtMoney(grand)}</td>
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：矩阵仅统计房费（item_type = ROOM），行取区间内实际产生房费的营业日，列取全部房型；
        未排房或房间已删除的房费归入「未分房型」。
      </NoteCard>
    </>
  );
}

/* -------------------- 15. 综合营业日报-楼层 -------------------- */
function ReportRoomDaily({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = roomNoMatrix(hotelId, from, to);
  const cur = categoryAgg(hotelId, from, to);

  const dateSet = new Set<string>();
  const roomSet = new Set<string>();
  const cellMap = new Map<string, number>();
  for (const r of rows) {
    dateSet.add(r.biz_date);
    roomSet.add(r.room_no);
    cellMap.set(`${r.biz_date}|${r.room_no}`, num(r.amount));
  }
  const dates = [...dateSet].sort();
  // 房间多时只展示有房费的房间，避免表格过宽
  const rooms = [...roomSet].sort();
  const dateTotals = new Map<string, number>();
  for (const d of dates) {
    let sum = 0;
    for (const r of rooms) sum += cellMap.get(`${d}|${r}`) ?? 0;
    dateTotals.set(d, sum);
  }
  const roomTotals = new Map<string, number>();
  for (const r of rooms) {
    let sum = 0;
    for (const d of dates) sum += cellMap.get(`${d}|${r}`) ?? 0;
    roomTotals.set(r, sum);
  }
  const grand = rows.reduce((s, r) => s + num(r.amount), 0);
  const grandTotal = [...dateTotals.values()].reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="产生房费的房间数" value={fmtInt(rooms.length)} />
        <StatCard label="房费合计" value={fmtMoney(grand)} />
        <StatCard label="间夜" value={fmtInt(cur.nights)} />
        <StatCard label="平均房价" value={fmtMoney(cur.nights > 0 ? cur.room / cur.nights : 0)} />
      </div>

      <SectionCard
        title="综合营业日报（逐日 × 房间号）"
        right={`${rangeText(ctx)} · 单位：金额（元）`}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                {rooms.map((r) => (
                  <th key={r} className="th text-right whitespace-nowrap">
                    {r}
                  </th>
                ))}
                <th className="th text-right">日合计</th>
              </tr>
            </thead>
            <tbody>
              {dates.length === 0 && <EmptyRow colSpan={2 + rooms.length} />}
              {dates.map((d) => (
                <tr key={d} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{d}</td>
                  {rooms.map((r) => (
                    <td key={`${d}-${r}`} className="td text-right tabular-nums text-gray-700">
                      {fmtMoney(cellMap.get(`${d}|${r}`) ?? 0)}
                    </td>
                  ))}
                  <td className="td text-right font-medium tabular-nums text-gray-800">
                    {fmtMoney(dateTotals.get(d) ?? 0)}
                  </td>
                </tr>
              ))}
              {dates.length > 0 && (
                <tr className="bg-gray-50 font-medium">
                  <td className="td text-gray-800">合计</td>
                  {rooms.map((r) => (
                    <td key={`sum-${r}`} className="td text-right tabular-nums text-gray-800">
                      {fmtMoney(roomTotals.get(r) ?? 0)}
                    </td>
                  ))}
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(grandTotal)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

function ReportFloorDaily({ ctx }: ReportProps) {
  const { hotelId, from, to, sellableRooms } = ctx;
  const rows = floorMatrix(hotelId, from, to);
  const cur = categoryAgg(hotelId, from, to);
  const floors = floorList(hotelId);
  const dateSet = new Set<string>();
  const floorSet = new Set<string>();
  const cellMap = new Map<string, number>();
  for (const r of rows) {
    dateSet.add(r.biz_date);
    floorSet.add(r.floor);
    cellMap.set(`${r.biz_date}|${r.floor}`, num(r.amount));
  }
  const dates = [...dateSet].sort();
  const floorKeys: string[] = [...floorSet].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  const cols: string[] = floorKeys.length > 0 ? floorKeys : floors.map((f) => String(f.floor ?? "未分楼层"));
  const dateTotals = new Map<string, number>();
  for (const d of dates) {
    let sum = 0;
    for (const f of cols) sum += cellMap.get(`${d}|${f}`) ?? 0;
    dateTotals.set(d, sum);
  }
  const floorTotals = new Map<string, number>();
  for (const f of cols) {
    let sum = 0;
    for (const d of dates) sum += cellMap.get(`${d}|${f}`) ?? 0;
    floorTotals.set(f, sum);
  }
  const grand = rows.reduce((s, r) => s + num(r.amount), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="楼层数" value={fmtInt(cols.length)} />
        <StatCard label="房费合计" value={fmtMoney(grand)} />
        <StatCard label="间夜" value={fmtInt(cur.nights)} />
        <StatCard label="平均房价" value={fmtMoney(cur.nights > 0 ? cur.room / cur.nights : 0)} />
      </div>

      <SectionCard
        title="综合营业日报（逐日 × 楼层）"
        right={`${rangeText(ctx)} · 可售房 ${sellableRooms} 间 · 单位：金额（元）`}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                {cols.map((f) => (
                  <th key={f} className="th text-right whitespace-nowrap">
                    {f === "未分楼层" ? f : `${f} 层`}
                  </th>
                ))}
                <th className="th text-right">日合计</th>
              </tr>
            </thead>
            <tbody>
              {dates.length === 0 && <EmptyRow colSpan={2 + cols.length} />}
              {dates.map((d) => (
                <tr key={d} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{d}</td>
                  {cols.map((f) => (
                    <td key={`${d}-${f}`} className="td text-right tabular-nums text-gray-700">
                      {fmtMoney(cellMap.get(`${d}|${f}`) ?? 0)}
                    </td>
                  ))}
                  <td className="td text-right font-medium tabular-nums text-gray-800">
                    {fmtMoney(dateTotals.get(d) ?? 0)}
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                {cols.map((f) => (
                  <td key={`sum-${f}`} className={SUM_TD}>
                    {fmtMoney(floorTotals.get(f) ?? 0)}
                  </td>
                ))}
                <td className={SUM_TD}>{fmtMoney(grand)}</td>
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：按房间所属楼层归集房费，楼层取 rooms.floor；未分配到已存在房间的房费归入「未分楼层」，
        行取区间内实际产生房费的营业日。
      </NoteCard>
    </>
  );
}

/* -------------------- 16. 房费日报表 -------------------- */
function ReportRoomFeeDaily({ ctx }: ReportProps) {
  const { hotelId, from, to, days, sellableRooms } = ctx;
  const cur = categoryAgg(hotelId, from, to);
  const rows = dailyAgg(hotelId, from, to);
  const map = new Map<string, DailyRow>();
  for (const r of rows) map.set(r.biz_date, r);
  const dates = dayList(from, to);
  const adr = cur.nights > 0 ? cur.room / cur.nights : 0;
  const occupancy = sellableRooms > 0 ? cur.nights / (sellableRooms * days) : 0;
  const hasData = rows.length > 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="房费收入" value={fmtMoney(cur.room)} />
        <StatCard label="间夜" value={fmtInt(cur.nights)} />
        <StatCard label="平均房价" value={fmtMoney(adr)} />
        <StatCard label="区间出租率" value={fmtPct(occupancy)} />
      </div>

      <SectionCard title="房费日报表" right={`可售房 ${sellableRooms} 间 · ${rangeText(ctx)}`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">营业日</th>
              <th className="th text-right">间夜</th>
              <th className="th text-right">房费</th>
              <th className="th text-right">ADR</th>
              <th className="th text-right">出租率</th>
              <th className="th w-44">占区间房费</th>
            </tr>
          </thead>
          <tbody>
            {!hasData && <EmptyRow colSpan={6} />}
            {hasData &&
              dates.map((d) => {
                const r = map.get(d);
                const room = num(r?.room);
                const nights = num(r?.nights);
                return (
                  <tr key={d} className="hover:bg-gray-50">
                    <td className="td tabular-nums text-gray-700">
                      {d}
                      {d === ctx.todayDate && (
                        <span className="ml-1.5 rounded bg-brand-100 px-1 text-[10px] leading-[15px] text-brand-700">
                          今日
                        </span>
                      )}
                    </td>
                    <td className="td text-right tabular-nums">{fmtInt(nights)}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(room)}</td>
                    <td className="td text-right tabular-nums text-gray-500">
                      {fmtMoney(nights > 0 ? room / nights : 0)}
                    </td>
                    <td className="td text-right tabular-nums">
                      {fmtPct(sellableRooms > 0 ? nights / sellableRooms : 0)}
                    </td>
                    <td className="td">
                      <ShareBar value={room} total={cur.room} />
                    </td>
                  </tr>
                );
              })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(cur.nights)}</td>
              <td className={SUM_TD}>{fmtMoney(cur.room)}</td>
              <td className={SUM_TD}>{fmtMoney(adr)}</td>
              <td className={SUM_TD}>{fmtPct(occupancy)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：房费按夜审过账的营业日（folio_items.biz_date）统计，ADR = 房费 ÷ 间夜，
        出租率 = 间夜 ÷ 可售房数；区间无房费数据时仅显示空状态与合计行。
      </NoteCard>
    </>
  );
}

/* -------------------- 17. 试算平衡表 -------------------- */
function ReportTrialBalance({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const cur = categoryAgg(hotelId, from, to);
  const pay = paymentAgg(hotelId, from, to);
  const methods = payMethodAgg(hotelId, from, to);
  const before = get<{ charges: number; paid: number }>(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM folio_items
         WHERE hotel_id = ? AND biz_date < ? AND item_type IN ('ROOM','FOOD','OTHER')) AS charges,
       (SELECT COALESCE(SUM(amount), 0) FROM payments
         WHERE hotel_id = ? AND biz_date < ?) AS paid`,
    [hotelId, from, hotelId, from]
  );
  const openAR = num(before?.charges) - num(before?.paid);
  const closeAR = openAR + cur.income - pay.amount;
  const arIncrease = closeAR - openAR;
  const debitTotal = cur.income;
  const creditTotal = pay.amount + arIncrease;
  const balanceDiff = debitTotal - creditTotal;
  const balanced = Math.abs(balanceDiff) < 0.01;
  const hasLedger =
    cur.income > 0.005 || pay.cnt > 0 || methods.length > 0 || Math.abs(arIncrease) > 0.005;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="期初应收" value={fmtMoney(openAR)} hint={`营业日 < ${from} 的消费 − 收款`} />
        <StatCard label="本期收入" value={fmtMoney(cur.income)} />
        <StatCard label="本期收款" value={fmtMoney(pay.amount)} />
        <StatCard label="期末应收" value={fmtMoney(closeAR)} hint="期初 + 本期收入 − 本期收款" />
      </div>

      <SectionCard title="余额流转" right={rangeText(ctx)}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">项目</th>
              <th className="th text-right">金额</th>
              <th className="th">说明</th>
            </tr>
          </thead>
          <tbody>
            <tr className="hover:bg-gray-50">
              <td className="td text-gray-600">期初应收</td>
              <td className="td text-right tabular-nums text-gray-800">{fmtMoney(openAR)}</td>
              <td className="td text-gray-500">营业日早于 {from} 的累计消费 − 累计收款</td>
            </tr>
            <tr className="hover:bg-gray-50">
              <td className="td text-gray-600">本期收入</td>
              <td className="td text-right tabular-nums text-gray-800">{fmtMoney(cur.income)}</td>
              <td className="td text-gray-500">房费 + 餐饮 + 其他</td>
            </tr>
            <tr className="hover:bg-gray-50">
              <td className="td text-gray-600">本期收款</td>
              <td className="td text-right tabular-nums text-gray-800">{fmtMoney(pay.amount)}</td>
              <td className="td text-gray-500">含押金收付的收款流水合计</td>
            </tr>
            <TotalRow>
              <td className="td font-medium text-gray-800">期末应收</td>
              <td className={SUM_TD}>{fmtMoney(closeAR)}</td>
              <td className="td text-gray-500">期初 + 收入 − 收款</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard
        title="借贷明细与平衡校验"
        right={
          <span className={balanced ? "text-[#2a9d3a]" : "text-[#e2483a]"}>
            {balanced ? "借贷平衡" : `差额 ${fmtMoney(balanceDiff)}`}
          </span>
        }
      >
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">科目</th>
              <th className="th">方向</th>
              <th className="th text-right">借方</th>
              <th className="th text-right">贷方</th>
            </tr>
          </thead>
          <tbody>
            {!hasLedger && <EmptyRow colSpan={4} />}
            {hasLedger && (
              <>
                <tr className="hover:bg-gray-50">
                  <td className="td text-gray-700">房费收入</td>
                  <td className="td text-gray-500">借</td>
                  <td className="td text-right tabular-nums">{cur.room > 0 ? fmtMoney(cur.room) : "-"}</td>
                  <td className="td text-right tabular-nums">-</td>
                </tr>
                <tr className="hover:bg-gray-50">
                  <td className="td text-gray-700">餐饮收入</td>
                  <td className="td text-gray-500">借</td>
                  <td className="td text-right tabular-nums">{cur.food > 0 ? fmtMoney(cur.food) : "-"}</td>
                  <td className="td text-right tabular-nums">-</td>
                </tr>
                <tr className="hover:bg-gray-50">
                  <td className="td text-gray-700">其他收入</td>
                  <td className="td text-gray-500">借</td>
                  <td className="td text-right tabular-nums">{cur.otherTotal > 0 ? fmtMoney(cur.otherTotal) : "-"}</td>
                  <td className="td text-right tabular-nums">-</td>
                </tr>
                {methods.map((m, i) => (
                  <tr key={`${m.method ?? "unknown"}-${i}`} className="hover:bg-gray-50">
                    <td className="td text-gray-700">{m.method ?? "未填方式"}收款</td>
                    <td className="td text-gray-500">贷</td>
                    <td className="td text-right tabular-nums">-</td>
                    <td className="td text-right tabular-nums">{fmtMoney(num(m.amount))}</td>
                  </tr>
                ))}
                <tr className="hover:bg-gray-50">
                  <td className="td text-gray-700">期间应收增加</td>
                  <td className="td text-gray-500">贷</td>
                  <td className="td text-right tabular-nums">-</td>
                  <td className="td text-right tabular-nums">{fmtMoney(arIncrease)}</td>
                </tr>
              </>
            )}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className="td" />
              <td className={SUM_TD}>{fmtMoney(debitTotal)}</td>
              <td className={SUM_TD}>{fmtMoney(creditTotal)}</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：期间应收增加 = 期末应收 − 期初应收；试算平衡条件为「本期收入 = 本期收款 + 应收增加」。
        期初应收按「营业日 &lt; {from} 的收入 − 收款」推算，押金计入收款项，因此期末应收与账面未结余额存在口径差异。
        当前账务单未结余额合计 {fmtMoney(receivableAgg(hotelId).total)}（{receivableAgg(hotelId).cnt} 张）。
      </NoteCard>
    </>
  );
}

/* -------------------- 18. 账户余额 -------------------- */
function ReportAccountBalance({ ctx }: ReportProps) {
  const { hotelId } = ctx;
  const companies = companyRows(hotelId);
  const balances = companyBalanceAgg(hotelId);
  const openFolios = openFolioRows(hotelId);
  const balanceMap = new Map<string, number>();
  for (const b of balances) balanceMap.set(b.name, num(b.balance));
  const creditTotal = companies.reduce((s, c) => s + num(c.credit_limit), 0);
  const companyBalance = companies.reduce((s, c) => s + (balanceMap.get(c.name) ?? 0), 0);
  const walkinBalance = balanceMap.get("散客 / 无协议") ?? 0;
  const totalBalance = companyBalance + walkinBalance;
  const usage = creditTotal > 0 ? companyBalance / creditTotal : 0;
  const openTotal = openFolios.reduce((s, f) => s + num(f.balance), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="协议单位数" value={fmtInt(companies.length)} />
        <StatCard label="授信额度合计" value={fmtMoney(creditTotal)} />
        <StatCard label="挂账余额" value={fmtMoney(totalBalance)} hint="协议单位 + 散客挂账" />
        <StatCard label="额度占用率" value={fmtPct(usage)} hint="协议单位挂账 ÷ 授信额度" />
      </div>

      <SectionCard title="协议单位账户余额" right="授信额度取自企业档案，余额按客人所属单位归集">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">协议单位</th>
              <th className="th">联系人</th>
              <th className="th">折扣</th>
              <th className="th text-right">授信额度</th>
              <th className="th text-right">当前挂账</th>
              <th className="th w-44">额度占用</th>
            </tr>
          </thead>
          <tbody>
            {companies.length === 0 && <EmptyRow colSpan={6} />}
            {companies.map((c) => {
              const bal = balanceMap.get(c.name) ?? 0;
              return (
                <tr key={c.name} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{c.name}</td>
                  <td className="td text-gray-500">
                    {dash(c.contact)}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </td>
                  <td className="td tabular-nums text-gray-600">
                    {num(c.discount) > 0 ? `${(num(c.discount) * 10).toFixed(1)} 折` : "-"}
                  </td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(c.credit_limit))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(bal)}</td>
                  <td className="td">
                    <ShareBar value={bal} total={num(c.credit_limit) || creditTotal} tone="bg-[#e2a03a]" />
                  </td>
                </tr>
              );
            })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className="td" />
              <td className="td" />
              <td className={SUM_TD}>{fmtMoney(creditTotal)}</td>
              <td className={SUM_TD}>{fmtMoney(companyBalance)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard
        title="挂账单余额明细"
        right={`当前欠款账单 ${openFolios.length} 张 · 合计 ${fmtMoney(openTotal)}（实时）`}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">账单号</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">渠道</th>
                <th className="th">离店日期</th>
                <th className="th text-right">消费</th>
                <th className="th text-right">已收</th>
                <th className="th text-right">余额</th>
                <th className="th text-right">账龄</th>
              </tr>
            </thead>
            <tbody>
              {openFolios.length === 0 && <EmptyRow colSpan={9} />}
              {openFolios.map((f) => (
                <tr key={f.folio_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{f.folio_no}</td>
                  <td className="td text-gray-700">{dash(f.guest_name)}</td>
                  <td className="td tabular-nums">{dash(f.room_no)}</td>
                  <td className="td text-gray-600">{f.channel}</td>
                  <td className="td tabular-nums text-gray-500">{dash(f.checkout_date)}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(f.total_amount))}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(f.paid_amount))}</td>
                  <td className="td text-right font-medium tabular-nums text-gray-900">{fmtMoney(num(f.balance))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(f.age))} 天</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(openFolios.reduce((s, f) => s + num(f.total_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(openFolios.reduce((s, f) => s + num(f.paid_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(openTotal)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：挂账余额 = 账务单应收余额（folios.balance &gt; 0）合计；协议单位归属按客史 guests.company 匹配，
        未匹配到协议单位的挂账归入「散客 / 无协议」。授信额度来自企业档案，单位折扣按 companies.discount 显示。
      </NoteCard>
    </>
  );
}

/* -------------------- 19. 消费收回明细报表 -------------------- */
function ReportConsumeRecover({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const consumeRowsData = consumeByDay(hotelId, from, to);
  const recoverRowsData = recoverByDay(hotelId, from, to);
  const consumeMap = new Map<string, number>();
  for (const r of consumeRowsData) consumeMap.set(r.biz_date, num(r.amount));
  const recoverMap = new Map<string, number>();
  for (const r of recoverRowsData) recoverMap.set(r.biz_date, num(r.amount));
  const dates = dayList(from, to);
  const totalConsume = consumeRowsData.reduce((s, r) => s + num(r.amount), 0);
  const totalRecover = recoverRowsData.reduce((s, r) => s + num(r.amount), 0);
  const diff = totalConsume - totalRecover;
  const rate = totalConsume > 0 ? totalRecover / totalConsume : 0;
  const hasData = consumeRowsData.length > 0 || recoverRowsData.length > 0;
  let cumulative = 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="消费合计" value={fmtMoney(totalConsume)} hint="房费 + 餐饮 + 其他" />
        <StatCard label="收回合计" value={fmtMoney(totalRecover)} hint="收款流水合计" />
        <StatCard label="消费 − 收回" value={fmtMoney(diff)} hint="正数表示本期消费未全部收回" />
        <StatCard label="回收率" value={fmtPct(rate)} />
      </div>

      <SectionCard title="消费收回明细" right={`${rangeText(ctx)} · ${dates.length} 天`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">营业日</th>
              <th className="th text-right">当日消费</th>
              <th className="th text-right">当日收回</th>
              <th className="th text-right">差额</th>
              <th className="th text-right">累计差额</th>
              <th className="th text-right">回收率</th>
            </tr>
          </thead>
          <tbody>
            {!hasData && <EmptyRow colSpan={6} />}
            {hasData &&
              dates.map((d) => {
                const c = consumeMap.get(d) ?? 0;
                const r = recoverMap.get(d) ?? 0;
                const dayDiff = c - r;
                cumulative += dayDiff;
                return (
                  <tr key={d} className="hover:bg-gray-50">
                    <td className="td tabular-nums text-gray-700">{d}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(c)}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(r)}</td>
                    <td className={`td text-right tabular-nums ${dayDiff > 0.005 ? "text-[#e2483a]" : "text-gray-600"}`}>
                      {fmtMoney(dayDiff)}
                    </td>
                    <td className={`td text-right tabular-nums ${cumulative > 0.005 ? "text-[#e2483a]" : "text-gray-600"}`}>
                      {fmtMoney(cumulative)}
                    </td>
                    <td className="td text-right tabular-nums">{c > 0 ? fmtPct(r / c) : "-"}</td>
                  </tr>
                );
              })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtMoney(totalConsume)}</td>
              <td className={SUM_TD}>{fmtMoney(totalRecover)}</td>
              <td className={SUM_TD}>{fmtMoney(diff)}</td>
              <td className="td" />
              <td className={SUM_TD}>{fmtPct(rate)}</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：消费按营业日归集收入类明细（不含押金与调整），收回按收款流水的营业日归集，两者存在时间性差异；
        累计差额从区间首日起逐日累加。
      </NoteCard>
    </>
  );
}

/* -------------------- 20. 夜审记录 -------------------- */
function ReportNightAudit({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = auditRows(hotelId, from, to);
  const roomsSold = rows.reduce((s, r) => s + num(r.rooms_sold), 0);
  /*
   * 营收合计（P1-19）：逐行按口径取值再求和 —— 新行取 revenue_net（净额），
   * 迁移前历史行取 revenue（毛额）。混合口径的合计必须让用户看见，
   * 所以下面合计行旁边标注「含 N 条历史毛额行」。
   */
  const legacyRows = rows.filter((r) => !auditHasSplit(r));
  const revenue = sumMoney(rows.map(auditRevenue));
  const avgOcc = rows.length > 0 ? rows.reduce((s, r) => s + num(r.occupancy), 0) / rows.length : 0;
  const done = rows.filter((r) => r.status === "DONE").length;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="夜审天数" value={fmtInt(rows.length)} />
        <StatCard label="已完成" value={fmtInt(done)} hint="status = DONE" />
        <StatCard label="售出房晚" value={fmtInt(roomsSold)} />
        <StatCard
          label="夜审营收"
          value={fmtMoney(revenue)}
          hint={
            legacyRows.length > 0
              ? `净额口径；含 ${legacyRows.length} 条迁移前毛额行`
              : "净收入 = 房费 + 餐饮 + 其他 - 退款"
          }
        />
      </div>

      <SectionCard title="夜审记录" right={`${rangeText(ctx)} · 共 ${rows.length} 条`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">营业日</th>
              <th className="th">状态</th>
              <th className="th text-right">售出房数</th>
              <th className="th text-right">营收</th>
              <th className="th text-right">出租率</th>
              <th className="th">操作员</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={6} />}
            {rows.map((a) => {
              const legacy = !auditHasSplit(a);
              return (
                <tr key={a.biz_date} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{a.biz_date}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        a.status === "DONE"
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {a.status === "DONE" ? "已完成" : "进行中"}
                    </span>
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(a.rooms_sold))}</td>
                  <td className="td text-right tabular-nums text-gray-800">
                    {fmtMoney(auditRevenue(a))}
                    {/* 历史行营收是毛收入，与新行净收入不同口径，逐行标出来避免误读 */}
                    {legacy && (
                      <span
                        className="ml-1 rounded border border-gray-200 bg-gray-50 px-1 py-0.5 text-[10px] text-gray-500"
                        title="迁移前的夜审行只有毛收入总额，无房费/餐饮/其他分列与退款数据"
                      >
                        毛额
                      </span>
                    )}
                  </td>
                  <td className="td text-right tabular-nums">{fmtPct(num(a.occupancy))}</td>
                  <td className="td text-gray-600">{dash(a.operator)}</td>
                </tr>
              );
            })}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className="td" />
              <td className={SUM_TD}>{fmtInt(roomsSold)}</td>
              <td className={SUM_TD}>{fmtMoney(revenue)}</td>
              <td className={SUM_TD}>{fmtPct(avgOcc)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：营收取夜审记录的净收入（房费 + 餐饮 + 其他 − 退款）。迁移前的历史行当年只记了毛收入总额，
        没有分列与退款数据，无法反推，因此这类行按毛额计入并标注「毛额」——
        合计里同时含两种口径，请结合行内标注阅读；需要拆分口径时按营业日单独看新行。
      </NoteCard>
    </>
  );
}

/* -------------------- 21. 现住客人报表 -------------------- */
function ReportInhouse({ ctx }: ReportProps) {
  const { hotelId } = ctx;
  const rows = inhouseRows(hotelId);
  const nights = rows.reduce((s, r) => s + num(r.nights), 0);
  const rateTotal = rows.reduce((s, r) => s + num(r.rate), 0);
  const deposit = rows.reduce((s, r) => s + num(r.deposit), 0);
  const balance = rows.reduce((s, r) => s + num(r.balance), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="在住房间数" value={fmtInt(rows.length)} />
        <StatCard label="在住房晚" value={fmtInt(nights)} hint="各在住单登记的晚数合计" />
        <StatCard label="房价合计" value={fmtMoney(rateTotal)} hint="按登记房价/晚合计" />
        <StatCard label="在住押金" value={fmtMoney(deposit)} />
      </div>

      <SectionCard title="现住客人报表" right={`实时快照 · 在住 ${rows.length} 间 · 应收余额 ${fmtMoney(balance)}`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">房号</th>
                <th className="th">楼层</th>
                <th className="th">房型</th>
                <th className="th">客人</th>
                <th className="th">渠道</th>
                <th className="th">入住时间</th>
                <th className="th">预计离店</th>
                <th className="th text-right">晚数</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">押金</th>
                <th className="th text-right">余额</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={12} />}
              {rows.map((r) => (
                <tr key={r.stay_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums font-medium text-gray-700">{r.room_no}</td>
                  <td className="td text-gray-500">{r.floor === null ? "-" : `${r.floor} 层`}</td>
                  <td className="td text-gray-600">{dash(r.room_type)}</td>
                  <td className="td text-gray-700">
                    {dash(r.guest_name)}
                    {r.mobile ? <span className="ml-1 text-[11px] text-gray-400">{r.mobile}</span> : null}
                  </td>
                  <td className="td text-gray-600">{r.channel}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.expect_check_out)}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums text-gray-600">{fmtMoney(num(r.deposit))}</td>
                  <td className={`td text-right tabular-nums ${num(r.balance) > 0.005 ? "text-[#e2483a]" : "text-gray-600"}`}>
                    {fmtMoney(num(r.balance))}
                  </td>
                  <td className="td tabular-nums text-gray-500">
                    {dash(r.folio_no)}
                    {r.folio_status === "OPEN" ? (
                      <span className="ml-1 rounded bg-gray-50 px-1 text-[10px] text-gray-400">未结</span>
                    ) : null}
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(nights)}</td>
                <td className={SUM_TD}>{fmtMoney(rateTotal)}</td>
                <td className={SUM_TD}>{fmtMoney(deposit)}</td>
                <td className={SUM_TD}>{fmtMoney(balance)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：本表为当前实时在住快照（stays.status = INHOUSE），不受顶部营业日区间影响；
        余额取对应账务单的应收余额（folios.balance）。
      </NoteCard>
    </>
  );
}

/* -------------------- 22. 酒店经营项目类型汇总表 -------------------- */
function ReportQuickBizType({ ctx }: ReportProps) {
  const { hotelId, from, to, days } = ctx;
  const rows = bizTypeAgg(hotelId, from, to);
  const summaries = bizSummaryAgg(hotelId, from, to);
  const totalAmount = rows.reduce((s, r) => s + num(r.amount), 0);
  const totalCnt = rows.reduce((s, r) => s + num(r.cnt), 0);

  const topByType = new Map<string, BizSummaryRow[]>();
  for (const s of summaries) {
    const list = topByType.get(s.item_type) ?? [];
    if (list.length < 3) list.push(s);
    topByType.set(s.item_type, list);
  }
  const topRows: { type: string; row: BizSummaryRow }[] = [];
  for (const r of rows) {
    for (const s of topByType.get(r.item_type) ?? []) topRows.push({ type: r.item_type, row: s });
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="项目类型数" value={fmtInt(rows.length)} />
        <StatCard label="明细笔数" value={fmtInt(totalCnt)} />
        <StatCard label="发生金额" value={fmtMoney(totalAmount)} />
        <StatCard label="日均金额" value={fmtMoney(days > 0 ? totalAmount / days : 0)} hint={`金额 ÷ ${days} 天`} />
      </div>

      <SectionCard title="类型汇总" right={rangeText(ctx)}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">项目类型</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">金额</th>
              <th className="th text-right">日均</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={5} />}
            {rows.map((r) => (
              <tr key={r.item_type} className="hover:bg-gray-50">
                <td className="td">
                  <TypeBadge type={r.item_type} />
                </td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.cnt))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.amount))}</td>
                <td className="td text-right tabular-nums text-gray-500">
                  {fmtMoney(days > 0 ? num(r.amount) / days : 0)}
                </td>
                <td className="td">
                  <ShareBar value={num(r.amount)} total={totalAmount} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(totalCnt)}</td>
              <td className={SUM_TD}>{fmtMoney(totalAmount)}</td>
              <td className={SUM_TD}>{fmtMoney(days > 0 ? totalAmount / days : 0)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="各类型主要项目（Top 3）" right={`共 ${summaries.length} 个摘要`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">类型</th>
              <th className="th">项目摘要</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">金额</th>
            </tr>
          </thead>
          <tbody>
            {topRows.length === 0 && <EmptyRow colSpan={4} />}
            {topRows.map((t, i) => (
              <tr key={`${t.type}-${i}`} className="hover:bg-gray-50">
                <td className="td">
                  <TypeBadge type={t.type} />
                </td>
                <td className="td text-gray-700">{dash(t.row.description)}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(t.row.cnt))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(t.row.amount))}</td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className="td" />
              <td className={SUM_TD}>{fmtInt(topRows.reduce((s, t) => s + num(t.row.cnt), 0))}</td>
              <td className={SUM_TD}>{fmtMoney(topRows.reduce((s, t) => s + num(t.row.amount), 0))}</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>
    </>
  );
}

/* -------------------- 23. AR账发生汇总表 -------------------- */
function ReportQuickAr({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const channels = arChannelAgg(hotelId, from, to);
  const details = arDetailRows(hotelId, from, to);
  const charge = channels.reduce((s, c) => s + num(c.charge), 0);
  const paid = channels.reduce((s, c) => s + num(c.paid), 0);
  const ar = channels.reduce((s, c) => s + num(c.ar), 0);
  const recoverRate = charge > 0 ? paid / charge : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="AR 发生额" value={fmtMoney(charge)} hint="区间内建账账单的消费金额" />
        <StatCard label="已收金额" value={fmtMoney(paid)} />
        <StatCard label="AR 余额" value={fmtMoney(ar)} hint="当前应收余额（实时）" />
        <StatCard label="回款率" value={fmtPct(recoverRate)} />
      </div>

      <SectionCard title="按渠道 AR 账发生" right={`${rangeText(ctx)} · 按账单创建日归集`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">渠道</th>
              <th className="th text-right">账单数</th>
              <th className="th text-right">发生额</th>
              <th className="th text-right">已收</th>
              <th className="th text-right">AR 余额</th>
              <th className="th w-40">回款率</th>
            </tr>
          </thead>
          <tbody>
            {channels.length === 0 && <EmptyRow colSpan={6} />}
            {channels.map((c, i) => (
              <tr key={`${c.name}-${i}`} className="hover:bg-gray-50">
                <td className="td text-gray-700">{c.name}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(c.cnt))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(c.charge))}</td>
                <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(c.paid))}</td>
                <td className="td text-right font-medium tabular-nums text-gray-900">{fmtMoney(num(c.ar))}</td>
                <td className="td">
                  <ShareBar value={num(c.paid)} total={num(c.charge)} tone="bg-[#58bc62]" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(channels.reduce((s, c) => s + num(c.cnt), 0))}</td>
              <td className={SUM_TD}>{fmtMoney(charge)}</td>
              <td className={SUM_TD}>{fmtMoney(paid)}</td>
              <td className={SUM_TD}>{fmtMoney(ar)}</td>
              <td className={SUM_TD}>{fmtPct(recoverRate)}</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="AR 发生明细" right={`账单创建日落在 ${rangeText(ctx)}，余额为当前值`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">账单号</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th text-right">发生额</th>
                <th className="th text-right">已收</th>
                <th className="th text-right">AR 余额</th>
                <th className="th">创建日</th>
                <th className="th text-right">账龄</th>
              </tr>
            </thead>
            <tbody>
              {details.length === 0 && <EmptyRow colSpan={8} />}
              {details.map((d) => (
                <tr key={d.folio_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{d.folio_no}</td>
                  <td className="td text-gray-700">{dash(d.guest_name)}</td>
                  <td className="td tabular-nums">{dash(d.room_no)}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(d.charge))}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(d.paid))}</td>
                  <td className="td text-right font-medium tabular-nums text-gray-900">{fmtMoney(num(d.ar))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(d.created_at)}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(d.age))} 天</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(details.reduce((s, d) => s + num(d.charge), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(details.reduce((s, d) => s + num(d.paid), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(details.reduce((s, d) => s + num(d.ar), 0))}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：AR 账即赊销账，按账单创建日归集区间内的发生额与已收金额；AR 余额为账务单当前未结余额，
        因此可能包含区间之前发生的欠款。回款率 = 已收 ÷ 发生额。
      </NoteCard>
    </>
  );
}

/* -------------------- 24. 催账报表 -------------------- */
function ReportQuickDun({ ctx }: ReportProps) {
  const { hotelId } = ctx;
  const rows = openFolioRows(hotelId);
  const totalBalance = rows.reduce((s, f) => s + num(f.balance), 0);
  const over30 = rows.filter((f) => num(f.age) > 30);
  const over30Amount = over30.reduce((s, f) => s + num(f.balance), 0);
  const maxBalance = rows.reduce((s, f) => Math.max(s, num(f.balance)), 0);

  const buckets = [
    { label: "0-30 天", min: 0, max: 30 },
    { label: "31-60 天", min: 31, max: 60 },
    { label: "60 天以上", min: 61, max: Number.MAX_SAFE_INTEGER },
  ].map((b) => {
    const items = rows.filter((f) => num(f.age) >= b.min && num(f.age) <= b.max);
    return {
      label: b.label,
      cnt: items.length,
      amount: items.reduce((s, f) => s + num(f.balance), 0),
    };
  });

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="欠款账单数" value={fmtInt(rows.length)} hint="实时余额大于 0 的账务单" />
        <StatCard label="欠款合计" value={fmtMoney(totalBalance)} />
        <StatCard label="超 30 天欠款" value={fmtMoney(over30Amount)} hint={`${over30.length} 张账单`} />
        <StatCard label="最大单笔欠款" value={fmtMoney(maxBalance)} />
      </div>

      <SectionCard title="催账报表" right={`实时快照 · 共 ${rows.length} 张欠款账单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">账单号</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">渠道</th>
                <th className="th">离店日期</th>
                <th className="th text-right">消费</th>
                <th className="th text-right">已收</th>
                <th className="th text-right">欠款</th>
                <th className="th text-right">账龄</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={9} />}
              {rows.map((f) => (
                <tr key={f.folio_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{f.folio_no}</td>
                  <td className="td text-gray-700">{dash(f.guest_name)}</td>
                  <td className="td tabular-nums">{dash(f.room_no)}</td>
                  <td className="td text-gray-600">{f.channel}</td>
                  <td className="td tabular-nums text-gray-500">{dash(f.checkout_date)}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(f.total_amount))}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(f.paid_amount))}</td>
                  <td className="td text-right font-medium tabular-nums text-[#e2483a]">{fmtMoney(num(f.balance))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(f.age))} 天</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, f) => s + num(f.total_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, f) => s + num(f.paid_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(totalBalance)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="账龄分布" right="账龄按账单创建日至今天计算">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">账龄区间</th>
              <th className="th text-right">账单数</th>
              <th className="th text-right">欠款金额</th>
              <th className="th w-44">金额占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={4} />}
            {rows.length > 0 &&
              buckets.map((b) => (
                <tr key={b.label} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{b.label}</td>
                  <td className="td text-right tabular-nums">{fmtInt(b.cnt)}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(b.amount)}</td>
                  <td className="td">
                    <ShareBar value={b.amount} total={totalBalance} tone="bg-[#e2a03a]" />
                  </td>
                </tr>
              ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(rows.length)}</td>
              <td className={SUM_TD}>{fmtMoney(totalBalance)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：本表为实时催账快照，不受营业日区间影响；欠款 = 账务单应收余额，
        账龄 = 账单创建日至今天的天数（北京时间），金额降序排列。
      </NoteCard>
    </>
  );
}

/* -------------------- 25. 财务异常汇总表 -------------------- */
function ReportQuickFinEx({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = finExRows(hotelId, from, to);
  const imbalance = rows.filter(
    (r) => Math.abs(num(r.total_amount) - num(r.paid_amount) - num(r.balance)) > 0.01
  );
  const negative = rows.filter((r) => num(r.balance) < -0.01);
  const settledOpen = rows.filter((r) => r.status === "SETTLED" && num(r.balance) > 0.01);
  const diffTotal = rows.reduce(
    (s, r) => s + Math.abs(num(r.total_amount) - num(r.paid_amount) - num(r.balance)),
    0
  );

  const kindOf = (r: FinExRow): string => {
    const parts: string[] = [];
    if (Math.abs(num(r.total_amount) - num(r.paid_amount) - num(r.balance)) > 0.01) parts.push("金额不平");
    if (num(r.balance) < -0.01) parts.push("负余额（多收）");
    if (r.status === "SETTLED" && num(r.balance) > 0.01) parts.push("已结仍挂账");
    return parts.length > 0 ? parts.join(" / ") : "-";
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="异常账单数" value={fmtInt(rows.length)} hint="金额不平 / 负余额 / 已结仍挂账" />
        <StatCard label="金额不平" value={fmtInt(imbalance.length)} />
        <StatCard label="负余额账单" value={fmtInt(negative.length)} />
        <StatCard label="已结仍挂账" value={fmtInt(settledOpen.length)} />
      </div>

      <SectionCard title="财务异常汇总表" right={`${rangeText(ctx)} · 按账单创建日归集`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">账单号</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th text-right">消费</th>
                <th className="th text-right">已收</th>
                <th className="th text-right">余额</th>
                <th className="th">异常类型</th>
                <th className="th">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={8} />}
              {rows.map((r) => (
                <tr key={r.folio_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{r.folio_no}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums">{dash(r.room_no)}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(r.total_amount))}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(r.paid_amount))}</td>
                  <td
                    className={`td text-right tabular-nums ${
                      num(r.balance) < -0.01 ? "text-[#e2483a]" : "text-gray-800"
                    }`}
                  >
                    {fmtMoney(num(r.balance))}
                  </td>
                  <td className="td">
                    <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">
                      {kindOf(r)}
                    </span>
                  </td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.total_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.paid_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.balance), 0))}</td>
                <td className="td text-[11px] text-gray-500">不平差额 {fmtMoney(diffTotal)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        判定口径：金额不平 = |消费 − 已收 − 余额| &gt; 0.01；负余额 = 余额 &lt; −0.01（多收未退）；
        已结仍挂账 = 账单已结清但仍存在正余额。三类条件可同时命中。
      </NoteCard>
    </>
  );
}

/* -------------------- 26. 前台操作异常汇总表 -------------------- */
function ReportQuickFdEx({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const actions = opActionAgg(hotelId, from, to);
  const details = opDetailRows(hotelId, from, to);

  const operators = new Set<string>();
  for (const a of actions) operators.add(a.operator);
  const operatorRows = [...operators].map((op) => {
    const items = actions.filter((a) => a.operator === op);
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.action, num(it.cnt));
    const total = SENSITIVE_ACTIONS.reduce((s, act) => s + (counts.get(act) ?? 0), 0);
    return { operator: op, counts, total };
  });
  operatorRows.sort((a, b) => b.total - a.total);

  const sensitiveTotal = operatorRows.reduce((s, r) => s + r.total, 0);
  const sensitiveDetails = details.filter((d) => SENSITIVE_ACTIONS.includes(d.action));
  const anomalyFolios = finExRows(hotelId, from, to);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="敏感操作次数" value={fmtInt(sensitiveTotal)} hint="调价 / 加收消费 / 换房 / 取消预订" />
        <StatCard label="涉及操作人" value={fmtInt(operatorRows.filter((r) => r.total > 0).length)} />
        <StatCard label="异常账单数" value={fmtInt(anomalyFolios.length)} hint="账务异常（金额不平 / 负余额）" />
        <StatCard label="操作日志条数" value={fmtInt(details.length)} hint="区间内 op_logs 记录" />
      </div>

      <SectionCard title="按操作人敏感操作汇总" right={`${rangeText(ctx)} · 数据源 op_logs`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">操作人</th>
              {SENSITIVE_ACTIONS.map((a) => (
                <th key={a} className="th text-right">
                  {a}
                </th>
              ))}
              <th className="th text-right">合计</th>
              <th className="th w-40">占比</th>
            </tr>
          </thead>
          <tbody>
            {operatorRows.length === 0 && <EmptyRow colSpan={3 + SENSITIVE_ACTIONS.length} />}
            {operatorRows.map((r) => (
              <tr key={r.operator} className="hover:bg-gray-50">
                <td className="td text-gray-700">{r.operator}</td>
                {SENSITIVE_ACTIONS.map((a) => (
                  <td key={`${r.operator}-${a}`} className="td text-right tabular-nums text-gray-700">
                    {fmtInt(r.counts.get(a) ?? 0)}
                  </td>
                ))}
                <td className="td text-right font-medium tabular-nums text-gray-900">{fmtInt(r.total)}</td>
                <td className="td">
                  <ShareBar value={r.total} total={sensitiveTotal} tone="bg-[#e2a03a]" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              {SENSITIVE_ACTIONS.map((a) => (
                <td key={`sum-${a}`} className={SUM_TD}>
                  {fmtInt(operatorRows.reduce((s, r) => s + (r.counts.get(a) ?? 0), 0))}
                </td>
              ))}
              <td className={SUM_TD}>{fmtInt(sensitiveTotal)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="敏感操作明细" right={`共 ${sensitiveDetails.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">操作人</th>
                <th className="th">操作</th>
                <th className="th">明细</th>
                <th className="th">标记</th>
              </tr>
            </thead>
            <tbody>
              {sensitiveDetails.length === 0 && <EmptyRow colSpan={5} />}
              {sensitiveDetails.map((d, i) => (
                <tr key={`${d.created_at ?? "t"}-${i}`} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{dash(d.created_at)}</td>
                  <td className="td text-gray-700">{d.operator}</td>
                  <td className="td text-gray-600">{d.action}</td>
                  <td className="td text-gray-500">{dash(d.detail)}</td>
                  <td className="td">
                    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                      敏感
                    </span>
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td text-gray-500">共 {sensitiveDetails.length} 条敏感操作</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：敏感操作定义为调价、加收消费、换房、取消预订，来源 op_logs（按操作时间 + 8 小时落在区间内）；
        异常账单数与「财务异常汇总表」一致，按账单创建日归集。
      </NoteCard>
    </>
  );
}

/* -------------------- 27. 押金报表 -------------------- */
function ReportDeposit({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = depositRows(hotelId, from, to);
  /*
   * 押金退款流水（P2-6）：单独一条查询，见数据访问层 depositRefundRows 的口径说明。
   * 旧实现用 `released = total - held` 倒推，既看不见退款笔数，也算不对金额。
   */
  const refunds = depositRefundRows(hotelId, from, to);

  const total = sumMoney(rows.map((r) => r.amount));
  const isHeld = (r: DepositRow) => r.stay_status === "INHOUSE" && r.folio_status !== "SETTLED";
  const held = sumMoney(rows.filter(isHeld).map((r) => r.amount));
  /* 已退押金 = 区间内真实负数收款（押金退款）绝对值合计 */
  const released = sumMoney(refunds.map((r) => Math.abs(num(r.amount))));

  const byMethod = new Map<string, { cnt: number; amount: number }>();
  for (const r of rows) {
    const key = r.method || "未填方式";
    const cur = byMethod.get(key) ?? { cnt: 0, amount: 0 };
    cur.cnt += 1;
    cur.amount += num(r.amount);
    byMethod.set(key, cur);
  }
  const methodRows = [...byMethod.entries()]
    .map(([method, v]) => ({ method, cnt: v.cnt, amount: round2(v.amount) }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="押金笔数" value={fmtInt(rows.length)} hint="区间内 DEPOSIT 明细条数" />
        <StatCard
          label="押金总额"
          value={fmtMoney(total)}
          hint="区间内押金明细当前余额（退房退押时会冲减明细）"
        />
        <StatCard
          label="已退押金"
          value={fmtMoney(released)}
          hint={`区间内真实退款流水 ${refunds.length} 笔（负数收款，非倒推值）`}
        />
        <StatCard label="在压押金" value={fmtMoney(held)} hint="在住且账单未结的押金" />
      </div>

      <SectionCard title="押金明细" right={`${rangeText(ctx)} · 共 ${rows.length} 笔`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">摘要</th>
                <th className="th text-right">押金金额</th>
                <th className="th">收款方式</th>
                <th className="th">过账时间</th>
                <th className="th">状态</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={9} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{r.biz_date}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-500">{dash(r.description)}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.amount))}</td>
                  <td className="td text-gray-600">{dash(r.method)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        isHeld(r)
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-gray-200 bg-gray-50 text-gray-500"
                      }`}
                    >
                      {isHeld(r) ? "在压" : "已退"}
                    </span>
                  </td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td text-gray-500">
                  在压 {fmtMoney(held)} / 已退 {fmtMoney(released)}
                </td>
                <td className={SUM_TD}>{fmtMoney(total)}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* P2-6：退款必须有据可查 —— 列真实流水，而不是让用户拿「收取 − 余额」猜 */}
      <SectionCard
        title="押金退款流水（真实收款记录）"
        right={`${rangeText(ctx)} · 共 ${refunds.length} 笔 · 合计 ${fmtMoney(released)}`}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">退款备注</th>
                <th className="th">原收款单号</th>
                <th className="th">方式</th>
                <th className="th text-right">退款金额</th>
                <th className="th">过账时间</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {refunds.length === 0 && <EmptyRow colSpan={9} />}
              {refunds.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{dash(r.biz_date)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-500">{dash(r.remark)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.origin_pay_no)}</td>
                  <td className="td text-gray-600">{dash(r.method)}</td>
                  <td className="td text-right tabular-nums text-[#c0392b]">
                    {fmtMoney(Math.abs(num(r.amount)))}
                  </td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(released)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="按收款方式汇总" right={`共 ${methodRows.length} 种方式`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">收款方式</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">金额</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {methodRows.length === 0 && <EmptyRow colSpan={4} />}
            {methodRows.map((m) => (
              <tr key={m.method} className="hover:bg-gray-50">
                <td className="td text-gray-700">{m.method}</td>
                <td className="td text-right tabular-nums">{fmtInt(m.cnt)}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(m.amount)}</td>
                <td className="td">
                  <ShareBar value={m.amount} total={total} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(rows.length)}</td>
              <td className={SUM_TD}>{fmtMoney(total)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：押金取 folio_items.item_type = DEPOSIT，按营业日（biz_date）落在区间内统计；
        收款方式取同账单同营业日的 payments.method；对应订单仍在住且账单未结清记为「在压」，其余记为「已退」。
        「已退押金」不再用「押金总额 − 在压」倒推，而是直接汇总区间内的**真实退款流水**：
        退房自动退押（备注「退房退还押金」）与收银台手动退款（refund_of 指向原押金收款）都会写入负数收款，
        退款明细见「押金退款流水」表；退房退押会同时冲减押金明细，所以「押金总额」是明细当前余额而非期间收取额。
      </NoteCard>
    </>
  );
}

/* -------------------- 28. 挂账客人报表 -------------------- */
function ReportCreditGuests({ ctx }: ReportProps) {
  const { hotelId } = ctx;
  const rows = creditGuestRows(hotelId);
  const total = rows.reduce((s, r) => s + num(r.balance), 0);
  const charge = rows.reduce((s, r) => s + num(r.total_amount), 0);
  const paid = rows.reduce((s, r) => s + num(r.paid_amount), 0);
  const inhouse = rows.filter((r) => r.stay_status === "INHOUSE");
  const checkedOut = rows.filter((r) => r.stay_status === "CHECKED_OUT");

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="挂账账单数" value={fmtInt(rows.length)} hint="余额 > 0 且在住 / 已退房的账单" />
        <StatCard label="挂账金额" value={fmtMoney(total)} />
        <StatCard
          label="在住挂账"
          value={fmtMoney(inhouse.reduce((s, r) => s + num(r.balance), 0))}
          hint={`${inhouse.length} 间在住`}
        />
        <StatCard
          label="已离店挂账"
          value={fmtMoney(checkedOut.reduce((s, r) => s + num(r.balance), 0))}
          hint={`${checkedOut.length} 单待收`}
        />
      </div>

      <SectionCard title="挂账客人清单" right={`实时快照 · 消费 ${fmtMoney(charge)} · 已收 ${fmtMoney(paid)}`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">房态</th>
                <th className="th">入住日期</th>
                <th className="th">离店日期</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">挂账金额</th>
                <th className="th text-right">账龄（天）</th>
                <th className="th">渠道</th>
                <th className="th">协议单位</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={11} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        r.stay_status === "INHOUSE"
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "border-gray-200 bg-gray-50 text-gray-500"
                      }`}
                    >
                      {r.stay_status === "INHOUSE" ? "在住" : "已离店"}
                    </span>
                  </td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.leave_date)}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums font-medium text-[#e2483a]">{fmtMoney(num(r.balance))}</td>
                  <td className={`td text-right tabular-nums ${num(r.age) > 30 ? "text-[#e2483a]" : "text-gray-600"}`}>
                    {fmtInt(num(r.age))}
                  </td>
                  <td className="td text-gray-600">{r.channel}</td>
                  <td className="td text-gray-500">{dash(r.company)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(total)}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：取 folios.balance &gt; 0 且关联网店状态为在住（INHOUSE）或已退房（CHECKED_OUT）的账单，不受顶部营业日区间限制；
        账龄 = 今日 − 账单创建日，间夜取 stays.nights。
      </NoteCard>
    </>
  );
}

/* -------------------- 29. 小商品区间报表 -------------------- */
function ReportGoodsRange({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = goodsRangeRows(hotelId, from, to);
  const amount = rows.reduce((s, r) => s + num(r.amount), 0);
  const qty = rows.reduce((s, r) => s + num(r.qty), 0);
  const avg = rows.length > 0 ? amount / rows.length : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="销售笔数" value={fmtInt(rows.length)} />
        <StatCard label="销售件数" value={fmtInt(qty)} />
        <StatCard label="销售金额" value={fmtMoney(amount)} />
        <StatCard label="单笔均价" value={fmtMoney(avg)} hint="金额 ÷ 笔数" />
      </div>

      <SectionCard title="小商品销售流水" right={`${rangeText(ctx)} · 共 ${rows.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">商品</th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th text-right">数量</th>
                <th className="th text-right">单价</th>
                <th className="th text-right">金额</th>
                <th className="th">账单号</th>
                <th className="th">过账时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={9} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{r.biz_date}</td>
                  <td className="td text-gray-700">{dash(r.goods_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-600">{dash(r.guest_name)}</td>
                  <td className="td text-right tabular-nums">{num(r.qty)}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.price))}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.amount))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(qty)}</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(amount)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：取 folio_items.item_type = OTHER 且 description 以「商超:」或「商超：」开头的明细，商品名去掉前缀后展示；
        按营业日（biz_date）落在区间内统计。
      </NoteCard>
    </>
  );
}

/* -------------------- 30. 小商品销售报表 -------------------- */
function ReportGoodsSales({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = goodsSalesAgg(hotelId, from, to);
  const amount = rows.reduce((s, r) => s + num(r.amount), 0);
  const qty = rows.reduce((s, r) => s + num(r.qty), 0);
  const cnt = rows.reduce((s, r) => s + num(r.cnt), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="商品种类" value={fmtInt(rows.length)} />
        <StatCard label="销售笔数" value={fmtInt(cnt)} />
        <StatCard label="销售件数" value={fmtInt(qty)} />
        <StatCard label="销售金额" value={fmtMoney(amount)} />
      </div>

      <SectionCard title="按商品汇总" right={`${rangeText(ctx)} · 共 ${rows.length} 种商品`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">商品</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">销量</th>
              <th className="th text-right">金额</th>
              <th className="th text-right">均价</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={6} />}
            {rows.map((r) => (
              <tr key={r.goods_name} className="hover:bg-gray-50">
                <td className="td text-gray-700">{dash(r.goods_name)}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.cnt))}</td>
                <td className="td text-right tabular-nums">{num(r.qty)}</td>
                <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.amount))}</td>
                <td className="td text-right tabular-nums text-gray-500">
                  {fmtMoney(num(r.qty) > 0 ? num(r.amount) / num(r.qty) : 0)}
                </td>
                <td className="td">
                  <ShareBar value={num(r.amount)} total={amount} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(cnt)}</td>
              <td className={SUM_TD}>{fmtInt(qty)}</td>
              <td className={SUM_TD}>{fmtMoney(amount)}</td>
              <td className="td" />
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：同「小商品区间报表」，按商品名（description 去掉「商超:」前缀）汇总销量与金额，占比 = 单品金额 ÷ 合计金额。
      </NoteCard>
    </>
  );
}

/* -------------------- 31. AR账龄报表 -------------------- */
const AR_AGE_BUCKETS = [
  { key: "0-30", label: "0-30 天", min: 0, max: 30 },
  { key: "31-60", label: "31-60 天", min: 31, max: 60 },
  { key: "60+", label: "60 天以上", min: 61, max: Number.MAX_SAFE_INTEGER },
] as const;

function arBucketOf(age: number): string {
  for (const b of AR_AGE_BUCKETS) if (age >= b.min && age <= b.max) return b.label;
  return AR_AGE_BUCKETS[AR_AGE_BUCKETS.length - 1].label;
}

function ReportArAge({ ctx }: ReportProps) {
  const { hotelId } = ctx;
  const rows = arAgeRows(hotelId);
  const total = rows.reduce((s, r) => s + num(r.balance), 0);
  const bucketTotals = AR_AGE_BUCKETS.map((b) => ({
    label: b.label,
    amount: rows.filter((r) => arBucketOf(num(r.age)) === b.label).reduce((s, r) => s + num(r.balance), 0),
    cnt: rows.filter((r) => arBucketOf(num(r.age)) === b.label).length,
  }));

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {bucketTotals.map((b) => (
          <StatCard key={b.label} label={`账龄 ${b.label}`} value={fmtMoney(b.amount)} hint={`${b.cnt} 笔未结账单`} />
        ))}
        <StatCard label="应收余额合计" value={fmtMoney(total)} hint={`${rows.length} 笔未结账单`} />
      </div>

      <SectionCard title="账龄分档汇总" right="未结账（folios.status = OPEN）">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">账龄档</th>
              <th className="th text-right">账单数</th>
              <th className="th text-right">应收余额</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {bucketTotals.every((b) => b.cnt === 0) && <EmptyRow colSpan={4} />}
            {bucketTotals.map((b) => (
              <tr key={b.label} className="hover:bg-gray-50">
                <td className="td text-gray-700">{b.label}</td>
                <td className="td text-right tabular-nums">{fmtInt(b.cnt)}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtMoney(b.amount)}</td>
                <td className="td">
                  <ShareBar value={b.amount} total={total} tone="bg-[#e2483a]" />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(rows.length)}</td>
              <td className={SUM_TD}>{fmtMoney(total)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="账龄明细" right={`按账龄倒序 · 共 ${rows.length} 笔`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">房态</th>
                <th className="th">建账日期</th>
                <th className="th text-right">账龄（天）</th>
                <th className="th">账龄档</th>
                <th className="th text-right">消费</th>
                <th className="th text-right">已收</th>
                <th className="th text-right">应收余额</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={10} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-500">{r.stay_status === "INHOUSE" ? "在住" : "已离店"}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_date)}</td>
                  <td className={`td text-right tabular-nums ${num(r.age) > 60 ? "text-[#e2483a]" : "text-gray-600"}`}>
                    {fmtInt(num(r.age))}
                  </td>
                  <td className="td text-gray-600">{arBucketOf(num(r.age))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.total_amount))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.paid_amount))}</td>
                  <td className={SUM_TD}>{fmtMoney(num(r.balance))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.total_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.paid_amount), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(total)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：账龄 = 今日 − 账单创建日（按 +8 小时时区），取未结账且有余额的账单；三档为 0-30 天、31-60 天、60 天以上。
      </NoteCard>
    </>
  );
}

/* -------------------- 32. AR发生汇总报表 -------------------- */
function ReportArHappen({ ctx }: ReportProps) {
  const { hotelId, from, to, days } = ctx;
  const rows = arHappenAgg(hotelId, from, to);
  const post = rows.reduce((s, r) => s + num(r.post_amount), 0);
  const paid = rows.reduce((s, r) => s + num(r.paid_amount), 0);
  const writeOff = rows.reduce((s, r) => s + num(r.write_off), 0);

  /* 累计未收：按日期正序累加 */
  const asc = [...rows].sort((a, b) => (a.biz_date < b.biz_date ? -1 : a.biz_date > b.biz_date ? 1 : 0));
  const cum = new Map<string, number>();
  let running = 0;
  for (const r of asc) {
    running += num(r.post_amount) - num(r.paid_amount) - num(r.write_off);
    cum.set(r.biz_date, running);
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="建账金额" value={fmtMoney(post)} hint="POST 类型挂账发生合计" />
        <StatCard label="已收金额" value={fmtMoney(paid)} hint="PAY 类型还款合计" />
        <StatCard label="销账金额" value={fmtMoney(writeOff)} hint="WRITE_OFF 核销合计" />
        <StatCard label="期间未收" value={fmtMoney(post - paid - writeOff)} hint={`${days} 天区间`} />
      </div>

      <SectionCard title="AR 发生明细" right={`${rangeText(ctx)} · 共 ${rows.length} 天有发生`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th text-right">笔数</th>
                <th className="th text-right">建账金额</th>
                <th className="th text-right">已收</th>
                <th className="th text-right">销账</th>
                <th className="th text-right">当日未收</th>
                <th className="th text-right">累计未收</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={7} />}
              {rows.map((r) => {
                const net = num(r.post_amount) - num(r.paid_amount) - num(r.write_off);
                return (
                  <tr key={r.biz_date} className="hover:bg-gray-50">
                    <td className="td tabular-nums text-gray-600">{r.biz_date}</td>
                    <td className="td text-right tabular-nums">{fmtInt(num(r.cnt))}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.post_amount))}</td>
                    <td className="td text-right tabular-nums text-[#32a852]">{fmtMoney(num(r.paid_amount))}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.write_off))}</td>
                    <td className={`td text-right tabular-nums ${net > 0 ? "text-[#e2483a]" : "text-gray-600"}`}>
                      {fmtMoney(net)}
                    </td>
                    <td className="td text-right tabular-nums text-gray-700">{fmtMoney(cum.get(r.biz_date) ?? 0)}</td>
                  </tr>
                );
              })}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.cnt), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(post)}</td>
                <td className={SUM_TD}>{fmtMoney(paid)}</td>
                <td className={SUM_TD}>{fmtMoney(writeOff)}</td>
                <td className={SUM_TD}>{fmtMoney(post - paid - writeOff)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：来源 ar_transactions，按 biz_date 归集；建账 = POST，已收 = PAY（取绝对值），销账 = WRITE_OFF；
        累计未收为区间内逐日净额累加，不含期初余额。
      </NoteCard>
    </>
  );
}

/* -------------------- 33. AR账报表 -------------------- */
function ReportArAccount({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = arAccountAgg(hotelId, from, to);
  const balance = rows.reduce((s, r) => s + num(r.balance), 0);
  const post = rows.reduce((s, r) => s + num(r.post_amount), 0);
  const paid = rows.reduce((s, r) => s + num(r.paid_amount), 0);
  const credit = rows.reduce((s, r) => s + num(r.credit_limit), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="协议单位数" value={fmtInt(rows.length)} />
        <StatCard label="区间建账" value={fmtMoney(post)} hint={rangeText(ctx)} />
        <StatCard label="区间已收" value={fmtMoney(paid)} />
        <StatCard label="应收余额" value={fmtMoney(balance)} hint={`授信总额 ${fmtMoney(credit)}`} />
      </div>

      <SectionCard title="协议单位 AR 账" right={`${rangeText(ctx)} · 共 ${rows.length} 家`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">编号</th>
                <th className="th">协议单位</th>
                <th className="th">类型</th>
                <th className="th text-right">区间建账</th>
                <th className="th text-right">区间已收</th>
                <th className="th text-right">销账</th>
                <th className="th text-right">应收余额</th>
                <th className="th text-right">授信额度</th>
                <th className="th w-44">授信占用</th>
                <th className="th">最近发生</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={10} />}
              {rows.map((r) => {
                const used = num(r.credit_limit) > 0 ? share(num(r.balance), num(r.credit_limit)) : 0;
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="td tabular-nums text-gray-500">{dash(r.code)}</td>
                    <td className="td text-gray-700">{dash(r.name)}</td>
                    <td className="td text-gray-500">{dash(r.type)}</td>
                    <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.post_amount))}</td>
                    <td className="td text-right tabular-nums text-[#32a852]">{fmtMoney(num(r.paid_amount))}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.write_off))}</td>
                    <td className={SUM_TD}>{fmtMoney(num(r.balance))}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.credit_limit))}</td>
                    <td className="td">
                      {num(r.credit_limit) > 0 ? (
                        <ShareBar value={num(r.balance)} total={num(r.credit_limit)} tone="bg-[#e2483a]" />
                      ) : (
                        <span className="text-[11px] text-gray-400">不限额</span>
                      )}
                      {used > 100 && <span className="ml-1 text-[11px] text-[#e2483a]">超限</span>}
                    </td>
                    <td className="td tabular-nums text-gray-500">{dash(r.last_date)}</td>
                  </tr>
                );
              })}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(post)}</td>
                <td className={SUM_TD}>{fmtMoney(paid)}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.write_off), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(balance)}</td>
                <td className={SUM_TD}>{fmtMoney(credit)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：主体为 ar_accounts（协议单位 / 挂账客户）；区间建账、已收、销账来自 ar_transactions 按 biz_date 汇总，
        应收余额取账户当前余额（a.balance），授信占用 = 余额 ÷ 授信额度。
      </NoteCard>
    </>
  );
}

/* -------------------- 34. 销售员业绩明细表 -------------------- */
function ReportSalesmanDetail({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = salesmanOrderRows(hotelId, from, to);
  const sums = salesmanAggRows(hotelId, from, to);
  const totalAmount = rows.reduce((s, r) => s + num(r.amount), 0);
  const totalNights = rows.reduce((s, r) => s + num(r.nights) * num(r.room_count), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="销售员数" value={fmtInt(sums.length)} />
        <StatCard label="订单数" value={fmtInt(rows.length)} hint="按销售员归属的预订订单" />
        <StatCard label="间夜数" value={fmtInt(totalNights)} />
        <StatCard label="订单金额" value={fmtMoney(totalAmount)} />
      </div>

      <SectionCard title="订单明细" right={`${rangeText(ctx)} · 共 ${rows.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">销售员</th>
                <th className="th">订单号</th>
                <th className="th">客人</th>
                <th className="th">入离日期</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">房间数</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">金额</th>
                <th className="th">状态</th>
                <th className="th">渠道</th>
                <th className="th">协议单位</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={11} />}
              {rows.map((r, i) => (
                <tr key={`${r.booking_no}-${i}`} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{dash(r.salesman)}</td>
                  <td className="td tabular-nums text-gray-600">{dash(r.booking_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-500">
                    {dash(r.check_in_date)} ~ {dash(r.check_out_date)}
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.room_count))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.amount))}</td>
                  <td className="td text-gray-500">{dash(r.status)}</td>
                  <td className="td text-gray-500">{dash(r.channel)}</td>
                  <td className="td text-gray-500">{r.company}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(totalNights)}</td>
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.room_count), 0))}</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(totalAmount)}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="按销售员小计" right={`共 ${sums.length} 人`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">销售员</th>
              <th className="th text-right">订单数</th>
              <th className="th text-right">间夜</th>
              <th className="th text-right">营收</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {sums.length === 0 && <EmptyRow colSpan={5} />}
            {sums.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="td text-gray-700">{dash(r.salesman)}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.orders))}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.revenue))}</td>
                <td className="td">
                  <ShareBar value={num(r.revenue)} total={sums.reduce((s, x) => s + num(x.revenue), 0)} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(sums.reduce((s, r) => s + num(r.orders), 0))}</td>
              <td className={SUM_TD}>{fmtInt(sums.reduce((s, r) => s + num(r.nights), 0))}</td>
              <td className={SUM_TD}>{fmtMoney(sums.reduce((s, r) => s + num(r.revenue), 0))}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：销售员取 settings →「销售员管理」维护的 salesmen 表，订单按 bookings.salesman 与销售员姓名匹配；
        金额 = 房价 × 间夜 × 房间数（预订口径，未扣渠道佣金），间夜 = 晚数 × 房间数。
      </NoteCard>
    </>
  );
}

/* -------------------- 35. 销售员业绩汇总表 -------------------- */
function ReportSalesmanSummary({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = salesmanAggRows(hotelId, from, to);
  const revenue = rows.reduce((s, r) => s + num(r.revenue), 0);
  const orders = rows.reduce((s, r) => s + num(r.orders), 0);
  const commission = rows.reduce((s, r) => s + (num(r.revenue) * num(r.commission_rate)) / 100, 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="销售员数" value={fmtInt(rows.length)} />
        <StatCard label="订单数" value={fmtInt(orders)} />
        <StatCard label="营收合计" value={fmtMoney(revenue)} />
        <StatCard label="佣金合计" value={fmtMoney(commission)} hint="营收 × 佣金率" />
      </div>

      <SectionCard title="销售员业绩汇总" right={`${rangeText(ctx)} · 共 ${rows.length} 人`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">销售员</th>
                <th className="th">状态</th>
                <th className="th text-right">订单数</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">营收</th>
                <th className="th text-right">平均房价</th>
                <th className="th text-right">佣金率</th>
                <th className="th text-right">佣金</th>
                <th className="th w-44">营收占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={9} />}
              {rows.map((r) => {
                const nights = num(r.nights);
                const rev = num(r.revenue);
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="td text-gray-700">{dash(r.salesman)}</td>
                    <td className="td">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${
                          r.status === "ACTIVE"
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-gray-200 bg-gray-50 text-gray-500"
                        }`}
                      >
                        {r.status === "ACTIVE" ? "在职" : "停用"}
                      </span>
                    </td>
                    <td className="td text-right tabular-nums">{fmtInt(num(r.orders))}</td>
                    <td className="td text-right tabular-nums">{fmtInt(nights)}</td>
                    <td className="td text-right tabular-nums text-gray-900">{fmtMoney(rev)}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(nights > 0 ? rev / nights : 0)}</td>
                    <td className="td text-right tabular-nums text-gray-500">{num(r.commission_rate).toFixed(2)}%</td>
                    <td className={SUM_TD}>{fmtMoney((rev * num(r.commission_rate)) / 100)}</td>
                    <td className="td">
                      <ShareBar value={rev} total={revenue} />
                    </td>
                  </tr>
                );
              })}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(orders)}</td>
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(revenue)}</td>
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(commission)}</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：订单数与营收按 bookings 中该销售员的预订订单统计（check_in_date 落在区间内），
        间夜 = 晚数 × 房间数，佣金 = 营收 × commission_rate ÷ 100；平均房价 = 营收 ÷ 间夜。
      </NoteCard>
    </>
  );
}

/* -------------------- 36. 协议客户销售明细表 -------------------- */
function ReportCompanyDetail({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = companyOrderRows(hotelId, from, to);
  const sums = companyAgg(hotelId, from, to);
  const totalAmount = rows.reduce((s, r) => s + num(r.amount), 0);
  const totalNights = rows.reduce((s, r) => s + num(r.nights) * num(r.room_count), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="协议单位数" value={fmtInt(sums.length)} hint="companies 表去重后单位数" />
        <StatCard label="订单数" value={fmtInt(rows.length)} />
        <StatCard label="间夜数" value={fmtInt(totalNights)} />
        <StatCard label="订单金额" value={fmtMoney(totalAmount)} />
      </div>

      <SectionCard title="协议客户订单明细" right={`${rangeText(ctx)} · 共 ${rows.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">协议单位</th>
                <th className="th text-right">折扣</th>
                <th className="th">订单号</th>
                <th className="th">客人</th>
                <th className="th">入离日期</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">房间数</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">金额</th>
                <th className="th">状态</th>
                <th className="th">渠道</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={11} />}
              {rows.map((r, i) => (
                <tr key={`${r.booking_no}-${i}`} className="hover:bg-gray-50">
                  <td className="td text-gray-700">{dash(r.company)}</td>
                  <td className="td text-right tabular-nums text-gray-500">{num(r.discount).toFixed(2)}</td>
                  <td className="td tabular-nums text-gray-600">{dash(r.booking_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-500">
                    {dash(r.check_in_date)} ~ {dash(r.check_out_date)}
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.room_count))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.amount))}</td>
                  <td className="td text-gray-500">{dash(r.status)}</td>
                  <td className="td text-gray-500">{dash(r.channel)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(totalNights)}</td>
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.room_count), 0))}</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(totalAmount)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：订单取 bookings.company_id 关联 companies 的预订，check_in_date 落在区间内；
        金额 = 房价 × 间夜 × 房间数，折扣取协议单位签定的 companies.discount。
      </NoteCard>
    </>
  );
}

/* -------------------- 37. 协议客户销售汇总表 -------------------- */
function ReportCompanySummary({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = companyAgg(hotelId, from, to);
  const amount = rows.reduce((s, r) => s + num(r.amount), 0);
  const orders = rows.reduce((s, r) => s + num(r.orders), 0);
  const nights = rows.reduce((s, r) => s + num(r.nights), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="协议单位数" value={fmtInt(rows.length)} />
        <StatCard label="订单数" value={fmtInt(orders)} />
        <StatCard label="间夜数" value={fmtInt(nights)} />
        <StatCard label="营收合计" value={fmtMoney(amount)} />
      </div>

      <SectionCard title="协议客户销售汇总" right={`${rangeText(ctx)} · 共 ${rows.length} 家`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">协议单位</th>
                <th className="th text-right">协议折扣</th>
                <th className="th text-right">授信额度</th>
                <th className="th text-right">订单数</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">营收</th>
                <th className="th text-right">平均房价</th>
                <th className="th w-44">营收占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={8} />}
              {rows.map((r) => {
                const n = num(r.nights);
                const amt = num(r.amount);
                return (
                  <tr key={r.company} className="hover:bg-gray-50">
                    <td className="td text-gray-700">{dash(r.company)}</td>
                    <td className="td text-right tabular-nums text-gray-500">{num(r.discount).toFixed(2)}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.credit_limit))}</td>
                    <td className="td text-right tabular-nums">{fmtInt(num(r.orders))}</td>
                    <td className="td text-right tabular-nums">{fmtInt(n)}</td>
                    <td className="td text-right tabular-nums text-gray-900">{fmtMoney(amt)}</td>
                    <td className="td text-right tabular-nums text-gray-500">{fmtMoney(n > 0 ? amt / n : 0)}</td>
                    <td className="td">
                      <ShareBar value={amt} total={amount} />
                    </td>
                  </tr>
                );
              })}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.credit_limit), 0))}</td>
                <td className={SUM_TD}>{fmtInt(orders)}</td>
                <td className={SUM_TD}>{fmtInt(nights)}</td>
                <td className={SUM_TD}>{fmtMoney(amount)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：以 companies 表按单位名去重为主表，左连接 bookings（company_id 属于该单位的任一条记录）；
        区间内无订单的单位仍列出并计 0，间夜 = 晚数 × 房间数，营收 = 房价 × 间夜 × 房间数。
      </NoteCard>
    </>
  );
}

/* -------------------- 38. 换房报表 -------------------- */
function ReportChangeRoom({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const logs = changeRoomLogRows(hotelId, from, to);
  const ops = changeRoomOpRows(hotelId, from, to);
  const diffs = stayRoomChangeRows(hotelId, from, to);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="房态换房记录" value={fmtInt(logs.length)} hint="room_logs 中 reason 含「换房」" />
        <StatCard label="换房操作记录" value={fmtInt(ops.length)} hint="op_logs 中 action 含「换房」" />
        <StatCard label="预订/实际房不一致" value={fmtInt(diffs.length)} hint="stays.room_id ≠ bookings.room_id" />
        <StatCard label="涉及操作人" value={fmtInt(new Set([...logs.map((l) => l.operator), ...ops.map((o) => o.operator)]).size)} />
      </div>

      <SectionCard title="换房操作日志" right={`${rangeText(ctx)} · 共 ${ops.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">原房号</th>
                <th className="th">新房号</th>
                <th className="th">操作</th>
                <th className="th">明细</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {ops.length === 0 && <EmptyRow colSpan={6} />}
              {ops.map((o) => (
                <tr key={o.log_id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{dash(o.created_at)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(o.room_no)}</td>
                  <td className="td tabular-nums text-gray-600">{dash(o.new_room)}</td>
                  <td className="td text-gray-600">{dash(o.action)}</td>
                  <td className="td text-gray-500">{dash(o.detail)}</td>
                  <td className="td text-gray-700">{dash(o.operator)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td text-gray-500">共 {ops.length} 次换房</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="房态变更日志（换房 / 调房）" right={`${rangeText(ctx)} · 共 ${logs.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">房号</th>
                <th className="th">原因</th>
                <th className="th">原房态</th>
                <th className="th">现房态</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && <EmptyRow colSpan={6} />}
              {logs.map((l) => (
                <tr key={l.log_id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{dash(l.created_at)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(l.room_no)}</td>
                  <td className="td text-gray-600">{dash(l.reason)}</td>
                  <td className="td text-gray-500">{dash(l.from_status)}</td>
                  <td className="td text-gray-500">{dash(l.to_status)}</td>
                  <td className="td text-gray-700">{dash(l.operator)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td text-gray-500">共 {logs.length} 条</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="住宿变更历史（预订房 vs 实际房）" right={`${rangeText(ctx)} · 共 ${diffs.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">住宿单号</th>
                <th className="th">客人</th>
                <th className="th">原房号（预订）</th>
                <th className="th">新房号（实际）</th>
                <th className="th">入住时间</th>
                <th className="th">离店日期</th>
                <th className="th">状态</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {diffs.length === 0 && <EmptyRow colSpan={8} />}
              {diffs.map((d) => (
                <tr key={d.stay_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{dash(d.stay_no)}</td>
                  <td className="td text-gray-700">{dash(d.guest_name)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(d.booked_room)}</td>
                  <td className="td tabular-nums font-medium text-[#e2483a]">{dash(d.actual_room)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(d.check_in)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(d.check_out)}</td>
                  <td className="td text-gray-500">{d.status === "INHOUSE" ? "在住" : "已离店"}</td>
                  <td className="td text-gray-700">{dash(d.operator)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td text-gray-500">共 {diffs.length} 单</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：换房来源为 room_logs（reason 含「换房 / 调房」）与 op_logs（action 含「换房 / 调房」）；
        新房号从操作明细的「→」后提取，日志未记录新旧房对应关系时显示「-」；
        住宿变更历史比对 bookings.room_id 与 stays.room_id，二者不同即视为换房。
      </NoteCard>
    </>
  );
}

/* -------------------- 39. 冲账明细报表 -------------------- */
function ReportReverseDetail({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = reverseDetailRows(hotelId, from, to);
  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  const byOperator = new Map<string, { cnt: number; amount: number }>();
  for (const r of rows) {
    const cur = byOperator.get(r.operator) ?? { cnt: 0, amount: 0 };
    cur.cnt += 1;
    cur.amount += num(r.amount);
    byOperator.set(r.operator, cur);
  }
  const opRows = [...byOperator.entries()].map(([operator, v]) => ({ operator, ...v }));

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="冲账笔数" value={fmtInt(rows.length)} hint="ADJUST 且金额为负" />
        <StatCard label="冲账金额" value={fmtMoney(total)} hint="负数合计（减少营收）" />
        <StatCard label="涉及账单" value={fmtInt(new Set(rows.map((r) => r.folio_no)).size)} />
        <StatCard label="涉及操作人" value={fmtInt(opRows.length)} />
      </div>

      <SectionCard title="冲账明细" right={`${rangeText(ctx)} · 共 ${rows.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">摘要</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th text-right">数量</th>
                <th className="th text-right">单价</th>
                <th className="th text-right">冲账金额</th>
                <th className="th">操作人</th>
                <th className="th">过账时间</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={10} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{r.biz_date}</td>
                  <td className="td text-gray-700">{dash(r.description)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-right tabular-nums">{num(r.qty)}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.price))}</td>
                  <td className="td text-right tabular-nums font-medium text-[#e2483a]">{fmtMoney(num(r.amount))}</td>
                  <td className="td text-gray-600">{r.operator}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(total)}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="按操作人汇总" right={`共 ${opRows.length} 人`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">操作人</th>
              <th className="th text-right">笔数</th>
              <th className="th text-right">冲账金额</th>
            </tr>
          </thead>
          <tbody>
            {opRows.length === 0 && <EmptyRow colSpan={3} />}
            {opRows.map((o) => (
              <tr key={o.operator} className="hover:bg-gray-50">
                <td className="td text-gray-700">{o.operator}</td>
                <td className="td text-right tabular-nums">{fmtInt(o.cnt)}</td>
                <td className="td text-right tabular-nums text-[#e2483a]">{fmtMoney(o.amount)}</td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(rows.length)}</td>
              <td className={SUM_TD}>{fmtMoney(total)}</td>
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：冲账取 folio_items.item_type = ADJUST 且 amount &lt; 0 的明细，按营业日（biz_date）落在区间内统计；
        操作人取明细过账人（folio_items.created_by → users.real_name）。
      </NoteCard>
    </>
  );
}

/* -------------------- 40. 离店客人房费加收表 -------------------- */
function ReportExtraRoomFee({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = extraRoomFeeRows(hotelId, from, to);
  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  const extra = rows.filter((r) => r.reason === "加收项目");
  const late = rows.filter((r) => r.reason !== "加收项目");
  const extraAmount = extra.reduce((s, r) => s + num(r.amount), 0);
  const lateAmount = late.reduce((s, r) => s + num(r.amount), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="加收 / 补记笔数" value={fmtInt(rows.length)} />
        <StatCard label="加收项目金额" value={fmtMoney(extraAmount)} hint={`${extra.length} 笔 description 以「加收」开头`} />
        <StatCard label="超入住日房费" value={fmtMoney(lateAmount)} hint={`${late.length} 笔房费过账时间晚于入住日`} />
        <StatCard label="合计金额" value={fmtMoney(total)} />
      </div>

      <SectionCard title="加收与补记明细" right={`${rangeText(ctx)} · 共 ${rows.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">类别</th>
                <th className="th">摘要</th>
                <th className="th">客人</th>
                <th className="th">房号</th>
                <th className="th">入住日期</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">金额</th>
                <th className="th">过账时间</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={10} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{r.biz_date}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        r.reason === "加收项目"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-blue-200 bg-blue-50 text-blue-700"
                      }`}
                    >
                      {r.reason}
                    </span>
                  </td>
                  <td className="td text-gray-700">{dash(r.description)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.amount))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td text-gray-500">
                  加收 {fmtMoney(extraAmount)} / 补记 {fmtMoney(lateAmount)}
                </td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(total)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：两类来源——① 摘要以「加收」开头的消费项目（folio_items.description LIKE &apos;加收%&apos;）；
        ② 房费（item_type = ROOM）但过账时间（created_at + 8 小时）晚于该住宿单入住日的补记房费。按营业日区间过滤。
      </NoteCard>
    </>
  );
}

/* -------------------- 41. 预抵客人报表 -------------------- */
function ReportExpectedArrivals({ ctx }: ReportProps) {
  const { hotelId, todayDate } = ctx;
  const windowTo = todayStr(addDays(todayDate, 7));
  const rows = expectedArrivalRows(hotelId, todayDate, windowTo);
  const nights = rows.reduce((s, r) => s + num(r.nights), 0);
  const amount = rows.reduce((s, r) => s + num(r.rate) * num(r.nights), 0);
  const deposit = rows.reduce((s, r) => s + num(r.deposit), 0);
  const pending = rows.filter((r) => r.status === "PENDING");

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="预抵订单数" value={fmtInt(rows.length)} hint={`${todayDate} ~ ${windowTo}`} />
        <StatCard label="预抵间夜" value={fmtInt(nights)} />
        <StatCard label="预计房费" value={fmtMoney(amount)} hint="房价 × 间夜" />
        <StatCard label="待排房订单" value={fmtInt(pending.length)} hint={`已收定金 ${fmtMoney(deposit)}`} />
      </div>

      <SectionCard title="未来 7 天预抵客人" right={`${todayDate} ~ ${windowTo} · 共 ${rows.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">预抵日期</th>
                <th className="th">订单号</th>
                <th className="th">客人</th>
                <th className="th">房型</th>
                <th className="th">房号</th>
                <th className="th">入离日期</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">人数</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">预计房费</th>
                <th className="th text-right">定金</th>
                <th className="th">渠道</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={13} />}
              {rows.map((r, i) => (
                <tr key={`${r.booking_no}-${i}`} className="hover:bg-gray-50">
                  <td className="td tabular-nums font-medium text-gray-700">{r.check_in_date}</td>
                  <td className="td tabular-nums text-gray-600">{dash(r.booking_no)}</td>
                  <td className="td text-gray-700">
                    {dash(r.guest_name)}
                    {r.mobile ? <span className="ml-1 text-[11px] text-gray-400">{r.mobile}</span> : null}
                  </td>
                  <td className="td text-gray-600">{dash(r.room_type)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.room_no)}</td>
                  <td className="td tabular-nums text-gray-500">
                    {dash(r.check_in_date)} ~ {dash(r.check_out_date)}
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.guest_count))}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums text-gray-900">
                    {fmtMoney(num(r.rate) * num(r.nights))}
                  </td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.deposit))}</td>
                  <td className="td text-gray-600">{r.channel}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        r.status === "PENDING"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-blue-200 bg-blue-50 text-blue-700"
                      }`}
                    >
                      {r.status === "PENDING" ? "待排房" : "已确认"}
                    </span>
                  </td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(nights)}</td>
                <td className={SUM_TD}>{fmtInt(rows.reduce((s, r) => s + num(r.guest_count), 0))}</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(amount)}</td>
                <td className={SUM_TD}>{fmtMoney(deposit)}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：本表固定取「今日 ~ 今日 + 7 天」的预抵订单（bookings.check_in_date），状态为 PENDING（待排房）或 CONFIRMED（已确认），
        不受顶部营业日区间影响；预计房费 = 房价 × 间夜。
      </NoteCard>
    </>
  );
}

/* -------------------- 42. 调价报表 -------------------- */
function ReportPriceChange({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = priceChangeRows(hotelId, from, to);
  const linked = rows.filter((r) => r.stay_no !== "");
  const byOperator = new Map<string, number>();
  for (const r of rows) byOperator.set(r.operator, (byOperator.get(r.operator) ?? 0) + 1);
  const opRows = [...byOperator.entries()].map(([operator, cnt]) => ({ operator, cnt })).sort((a, b) => b.cnt - a.cnt);
  const rooms = new Set(rows.map((r) => r.room_no).filter((x) => x !== ""));

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="调价次数" value={fmtInt(rows.length)} hint="op_logs 中 action = 调价" />
        <StatCard label="涉及房间" value={fmtInt(rooms.size)} />
        <StatCard label="关联订单" value={fmtInt(linked.length)} hint="按房号匹配到住宿单" />
        <StatCard label="操作人数" value={fmtInt(opRows.length)} />
      </div>

      <SectionCard title="调价记录" right={`${rangeText(ctx)} · 共 ${rows.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">房号</th>
                <th className="th">关联住宿单</th>
                <th className="th">客人</th>
                <th className="th text-right">原房价</th>
                <th className="th">入住日期</th>
                <th className="th">住宿状态</th>
                <th className="th">操作明细</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={9} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td tabular-nums text-gray-600">{dash(r.stay_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td text-right tabular-nums text-gray-800">{fmtMoney(num(r.rate))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td text-gray-500">
                    {r.stay_status === "INHOUSE" ? "在住" : r.stay_status === "CHECKED_OUT" ? "已离店" : "-"}
                  </td>
                  <td className="td text-gray-500">{dash(r.detail)}</td>
                  <td className="td text-gray-700">{dash(r.operator)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td text-gray-500">共 {rows.length} 次调价</td>
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="按操作人汇总" right={`共 ${opRows.length} 人`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">操作人</th>
              <th className="th text-right">调价次数</th>
              <th className="th w-44">占比</th>
            </tr>
          </thead>
          <tbody>
            {opRows.length === 0 && <EmptyRow colSpan={3} />}
            {opRows.map((o) => (
              <tr key={o.operator} className="hover:bg-gray-50">
                <td className="td text-gray-700">{o.operator || "未记录"}</td>
                <td className="td text-right tabular-nums">{fmtInt(o.cnt)}</td>
                <td className="td">
                  <ShareBar value={o.cnt} total={rows.length} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(rows.length)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <NoteCard>
        口径说明：来源 op_logs（action 含「调价」），按操作时间（created_at + 8 小时）落在区间内统计；
        操作明细首段为房号，据此回溯匹配该房间在调价时点之前最近的一笔住宿单作为关联订单。
      </NoteCard>
    </>
  );
}

/* -------------------- 43. 免费房报表 -------------------- */
function ReportFreeRoom({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const stays = freeStayRows(hotelId, from, to);
  const bookings = freeBookingRows(hotelId, from, to);
  const inhouse = stays.filter((s) => s.status === "INHOUSE");
  const totalLost = stays.reduce((s, r) => s + num(r.rate) * Math.max(1, num(r.nights)), 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="免费住宿单" value={fmtInt(stays.length)} hint="rate = 0 或备注含「免费」" />
        <StatCard label="其中在住" value={fmtInt(inhouse.length)} />
        <StatCard label="免费预订" value={fmtInt(bookings.length)} />
        <StatCard label="影响房费" value={fmtMoney(totalLost)} hint="按登记房价计（免费即让利）" />
      </div>

      <SectionCard title="免费 / 零房价住宿" right={`${rangeText(ctx)} · 共 ${stays.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">住宿单号</th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th">判定依据</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">间夜</th>
                <th className="th">入住日期</th>
                <th className="th">离店日期</th>
                <th className="th">渠道</th>
                <th className="th">状态</th>
                <th className="th">备注</th>
              </tr>
            </thead>
            <tbody>
              {stays.length === 0 && <EmptyRow colSpan={11} />}
              {stays.map((r) => (
                <tr key={r.stay_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{dash(r.stay_no)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td">
                    <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700">
                      {r.reason}
                    </span>
                  </td>
                  <td className={`td text-right tabular-nums ${num(r.rate) <= 0 ? "text-[#e2483a]" : "text-gray-800"}`}>
                    {fmtMoney(num(r.rate))}
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_out_date)}</td>
                  <td className="td text-gray-600">{r.channel}</td>
                  <td className="td text-gray-500">{r.status === "INHOUSE" ? "在住" : "已离店"}</td>
                  <td className="td text-gray-500">{dash(r.remark)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(stays.reduce((s, r) => s + num(r.rate), 0))}</td>
                <td className={SUM_TD}>{fmtInt(stays.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="免费 / 零房价预订" right={`${rangeText(ctx)} · 共 ${bookings.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">订单号</th>
                <th className="th">客人</th>
                <th className="th">房型</th>
                <th className="th">判定依据</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">间夜</th>
                <th className="th">入离日期</th>
                <th className="th">渠道</th>
                <th className="th">状态</th>
                <th className="th">备注</th>
              </tr>
            </thead>
            <tbody>
              {bookings.length === 0 && <EmptyRow colSpan={10} />}
              {bookings.map((r, i) => (
                <tr key={`${r.booking_no}-${i}`} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{dash(r.booking_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td text-gray-600">{dash(r.room_type)}</td>
                  <td className="td">
                    <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700">
                      {r.reason}
                    </span>
                  </td>
                  <td className={`td text-right tabular-nums ${num(r.rate) <= 0 ? "text-[#e2483a]" : "text-gray-800"}`}>
                    {fmtMoney(num(r.rate))}
                  </td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td tabular-nums text-gray-500">
                    {dash(r.check_in_date)} ~ {dash(r.check_out_date)}
                  </td>
                  <td className="td text-gray-600">{r.channel}</td>
                  <td className="td text-gray-500">{dash(r.status)}</td>
                  <td className="td text-gray-500">{dash(r.remark)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(bookings.reduce((s, r) => s + num(r.rate), 0))}</td>
                <td className={SUM_TD}>{fmtInt(bookings.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：住宿单取 stays.rate = 0 或 remark 含「免费」，按入住日期落在区间内；预订取 bookings.rate = 0 或 remark 含「免费」，
        按抵店日期落在区间内。影响房费按登记房价 × 间夜估算。
      </NoteCard>
    </>
  );
}

/* -------------------- 44. 时租房报表 -------------------- */
function ReportHourlyOrders({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = hourlyRows(hotelId, from, to);
  const amount = rows.reduce((s, r) => s + num(r.rate), 0);
  const hours = rows.reduce((s, r) => s + num(r.hours), 0);
  const inhouse = rows.filter((r) => r.status === "INHOUSE");
  const avgHours = rows.length > 0 ? hours / rows.length : 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="钟点房单量" value={fmtInt(rows.length)} hint="stays.nights = 0" />
        <StatCard label="其中在住" value={fmtInt(inhouse.length)} />
        <StatCard label="在店时长合计" value={`${hours.toFixed(1)} 小时`} hint="退房时间 − 入住时间" />
        <StatCard label="房费合计" value={fmtMoney(amount)} hint={`平均 ${avgHours.toFixed(1)} 小时 / 单`} />
      </div>

      <SectionCard title="钟点房订单" right={`${rangeText(ctx)} · 共 ${rows.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">住宿单号</th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th">入住时间</th>
                <th className="th">离店时间</th>
                <th className="th text-right">时长（小时）</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">押金</th>
                <th className="th text-right">余额</th>
                <th className="th">渠道</th>
                <th className="th">状态</th>
                <th className="th">账单号</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={12} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{dash(r.stay_no)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in)}</td>
                  <td className="td tabular-nums text-gray-500">
                    {r.check_out || (r.status === "INHOUSE" ? "在店中" : "-")}
                  </td>
                  <td className="td text-right tabular-nums text-gray-700">{num(r.hours).toFixed(1)}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtMoney(num(r.deposit))}</td>
                  <td className={`td text-right tabular-nums ${num(r.balance) > 0.005 ? "text-[#e2483a]" : "text-gray-600"}`}>
                    {fmtMoney(num(r.balance))}
                  </td>
                  <td className="td text-gray-600">{r.channel}</td>
                  <td className="td text-gray-500">{r.status === "INHOUSE" ? "在住" : "已离店"}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.folio_no)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{hours.toFixed(1)}</td>
                <td className={SUM_TD}>{fmtMoney(amount)}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.deposit), 0))}</td>
                <td className={SUM_TD}>{fmtMoney(rows.reduce((s, r) => s + num(r.balance), 0))}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：钟点房以 stays.nights = 0 识别，按入住时间（check_in_time + 8 小时）落在区间内统计；
        时长 = 退房时间 − 入住时间，未退房按当前时间计算，仅供参考。
      </NoteCard>
    </>
  );
}

/* -------------------- 45. 包价报表 -------------------- */
function ReportPackageReport({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const stays = packageStayRows(hotelId, from, to);
  const bookings = packageBookingRows(hotelId, from, to);
  const defs = packageDefRows(hotelId);
  const used = new Set([...stays.map((s) => s.package_code), ...bookings.map((b) => b.package_code)]);

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="使用包价的住宿" value={fmtInt(stays.length)} />
        <StatCard label="使用包价的预订" value={fmtInt(bookings.length)} />
        <StatCard label="包价种类（已用/配置）" value={`${used.size} / ${defs.length}`} />
        <StatCard
          label="含早份数（配置合计）"
          value={fmtInt(defs.reduce((s, d) => s + num(d.breakfast_count), 0))}
          hint="package_code.breakfast_count 之和"
        />
      </div>

      <SectionCard title="住宿单使用包价" right={`${rangeText(ctx)} · 共 ${stays.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">住宿单号</th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th">包价代码</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">含早份数</th>
                <th className="th">入住日期</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {stays.length === 0 && <EmptyRow colSpan={9} />}
              {stays.map((r) => (
                <tr key={r.stay_no} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{dash(r.stay_no)}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td">
                    <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                      {dash(r.package_code)}
                    </span>
                  </td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(r.breakfast))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td text-gray-500">{r.status === "INHOUSE" ? "在住" : "已离店"}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(stays.reduce((s, r) => s + num(r.rate), 0))}</td>
                <td className={SUM_TD}>{fmtInt(stays.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className={SUM_TD}>{fmtInt(stays.reduce((s, r) => s + num(r.breakfast), 0))}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="预订使用包价" right={`${rangeText(ctx)} · 共 ${bookings.length} 单`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">订单号</th>
                <th className="th">客人</th>
                <th className="th">房型</th>
                <th className="th">包价代码</th>
                <th className="th text-right">房价</th>
                <th className="th text-right">间夜</th>
                <th className="th text-right">含早份数</th>
                <th className="th">抵店日期</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {bookings.length === 0 && <EmptyRow colSpan={9} />}
              {bookings.map((r, i) => (
                <tr key={`${r.booking_no}-${i}`} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{dash(r.booking_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td text-gray-600">{dash(r.room_type)}</td>
                  <td className="td">
                    <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                      {dash(r.package_code)}
                    </span>
                  </td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(r.rate))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(r.nights))}</td>
                  <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(r.breakfast))}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.check_in_date)}</td>
                  <td className="td text-gray-500">{dash(r.status)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(bookings.reduce((s, r) => s + num(r.rate), 0))}</td>
                <td className={SUM_TD}>{fmtInt(bookings.reduce((s, r) => s + num(r.nights), 0))}</td>
                <td className={SUM_TD}>{fmtInt(bookings.reduce((s, r) => s + num(r.breakfast), 0))}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="包价设置表" right={`共 ${defs.length} 种包价`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">包价代码</th>
                <th className="th">包价名称</th>
                <th className="th text-right">包价价格</th>
                <th className="th text-right">含早份数</th>
                <th className="th">包含内容</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {defs.length === 0 && <EmptyRow colSpan={6} />}
              {defs.map((d) => (
                <tr key={d.code} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-700">{dash(d.code)}</td>
                  <td className="td text-gray-700">{dash(d.name)}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtMoney(num(d.price))}</td>
                  <td className="td text-right tabular-nums">{fmtInt(num(d.breakfast_count))}</td>
                  <td className="td text-gray-500">{dash(d.items)}</td>
                  <td className="td text-gray-500">{d.status === "ACTIVE" ? "启用" : d.status}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className={SUM_TD}>{fmtMoney(defs.reduce((s, d) => s + num(d.price), 0))}</td>
                <td className={SUM_TD}>{fmtInt(defs.reduce((s, d) => s + num(d.breakfast_count), 0))}</td>
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：订单的包价取 stays.package_code / bookings.package_code，非空即计入；住宿按入住日期、预订按抵店日期落在区间内；
        包价设置表来自 package_code（settings → 包价管理维护）。
      </NoteCard>
    </>
  );
}

/* -------------------- 46. 早餐报表 -------------------- */
function ReportBreakfast({ ctx }: ReportProps) {
  const { hotelId, from, to } = ctx;
  const rows = breakfastRows(hotelId, from, to);
  const daily = breakfastDailyAgg(hotelId, from, to);
  const portions = rows.reduce((s, r) => s + num(r.count), 0);
  const used = rows.filter((r) => r.status === "USED").reduce((s, r) => s + num(r.count), 0);
  const pending = rows.filter((r) => r.status === "PENDING").reduce((s, r) => s + num(r.count), 0);
  const rooms = new Set(rows.map((r) => r.room_no)).size;

  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="早餐份数" value={fmtInt(portions)} hint={`${rows.length} 条记录 / ${rooms} 间房`} />
        <StatCard label="已核销" value={fmtInt(used)} hint="status = USED" />
        <StatCard label="待核销" value={fmtInt(pending)} hint="status = PENDING" />
        <StatCard label="日均份数" value={fmtInt(daily.length > 0 ? portions / daily.length : 0)} hint={`有记录 ${daily.length} 天`} />
      </div>

      <SectionCard title="按日期汇总" right={`${rangeText(ctx)} · 共 ${daily.length} 天`}>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">日期</th>
              <th className="th text-right">房间数</th>
              <th className="th text-right">份数</th>
              <th className="th text-right">已核销</th>
              <th className="th text-right">待核销</th>
              <th className="th w-44">核销率</th>
            </tr>
          </thead>
          <tbody>
            {daily.length === 0 && <EmptyRow colSpan={6} />}
            {daily.map((d) => (
              <tr key={d.date} className="hover:bg-gray-50">
                <td className="td tabular-nums text-gray-600">{d.date}</td>
                <td className="td text-right tabular-nums">{fmtInt(num(d.rooms))}</td>
                <td className="td text-right tabular-nums text-gray-800">{fmtInt(num(d.portions))}</td>
                <td className="td text-right tabular-nums text-[#32a852]">{fmtInt(num(d.used))}</td>
                <td className="td text-right tabular-nums text-gray-500">{fmtInt(num(d.pending))}</td>
                <td className="td">
                  <ShareBar value={num(d.used)} total={num(d.portions)} />
                </td>
              </tr>
            ))}
            <TotalRow>
              <td className="td font-medium text-gray-800">合计</td>
              <td className={SUM_TD}>{fmtInt(daily.reduce((s, d) => s + num(d.rooms), 0))}</td>
              <td className={SUM_TD}>{fmtInt(portions)}</td>
              <td className={SUM_TD}>{fmtInt(used)}</td>
              <td className={SUM_TD}>{fmtInt(pending)}</td>
              <td className="td" />
            </TotalRow>
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="早餐核销明细" right={`共 ${rows.length} 条`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">日期</th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th text-right">份数</th>
                <th className="th">状态</th>
                <th className="th">早餐标记</th>
                <th className="th">备注</th>
                <th className="th">生成时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <EmptyRow colSpan={8} />}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{r.date}</td>
                  <td className="td tabular-nums text-gray-700">{dash(r.room_no)}</td>
                  <td className="td text-gray-700">{dash(r.guest_name)}</td>
                  <td className="td text-right tabular-nums text-gray-900">{fmtInt(num(r.count))}</td>
                  <td className="td">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[11px] ${
                        r.status === "USED"
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {r.status === "USED" ? "已核销" : "待核销"}
                    </span>
                  </td>
                  <td className="td text-gray-500">{num(r.stay_breakfast) > 0 ? "含早" : "-"}</td>
                  <td className="td text-gray-500">{dash(r.note)}</td>
                  <td className="td tabular-nums text-gray-500">{dash(r.created_at)}</td>
                </tr>
              ))}
              <TotalRow>
                <td className="td font-medium text-gray-800">合计</td>
                <td className="td" />
                <td className="td" />
                <td className={SUM_TD}>{fmtInt(portions)}</td>
                <td className="td" />
                <td className="td" />
                <td className="td" />
                <td className="td" />
              </TotalRow>
            </tbody>
          </table>
        </div>
      </SectionCard>

      <NoteCard>
        口径说明：来源 breakfast_records，按 date 落在区间内统计；份数取 count 之和，已核销 = status USED、待核销 = PENDING；
        房间数为去重房号数，核销率 = 已核销 ÷ 份数。
      </NoteCard>
    </>
  );
}


/* ================================================================== *
 * 八点五、去呼呼补齐的 7 张报表
 * ================================================================== */

/** 通用简单表：head + rows（都是字符串） */
function MiniTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="th">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="td py-10 text-center text-[12px] text-[#999]">
                暂无数据
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-[#fafcfb]">
              {r.map((c, j) => (
                <td key={j} className="td">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportMemberList({ ctx }: ReportProps) {
  const rows = all<{
    id: number;
    name: string;
    mobile: string | null;
    vip_level: number | null;
    total_spend: number | null;
    stay_count: number | null;
  }>(
    `SELECT id, name, mobile, vip_level, total_spend, stay_count
     FROM guests WHERE hotel_id = ? AND COALESCE(vip_level, 0) > 0
     ORDER BY COALESCE(total_spend, 0) DESC LIMIT 300`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        会员报表 · 共 {rows.length} 位
      </div>
      <MiniTable
        head={["会员卡号", "姓名", "手机", "等级", "累计消费", "入住次数"]}
        rows={rows.map((r) => [
          `M${String(r.id).padStart(8, "0")}`,
          r.name,
          r.mobile ?? "—",
          `VIP${r.vip_level ?? 0}`,
          fmtMoney(r.total_spend),
          String(r.stay_count ?? 0),
        ])}
      />
    </div>
  );
}

function ReportScoreDetail({ ctx }: ReportProps) {
  const rows = all<{ guest_name: string | null; type: string | null; points: number | null; note: string | null; created_at: string | null }>(
    `SELECT g.name AS guest_name, sr.type, sr.points, sr.note, sr.created_at
     FROM score_records sr LEFT JOIN guests g ON g.id = sr.guest_id
     WHERE sr.hotel_id = ? ORDER BY sr.id DESC LIMIT 300`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        会员积分明细报表 · 最近 {rows.length} 笔
      </div>
      <MiniTable
        head={["会员", "类型", "积分", "备注", "时间"]}
        rows={rows.map((r) => [
          r.guest_name ?? "—",
          r.type ?? "—",
          String(r.points ?? 0),
          r.note ?? "—",
          (r.created_at ?? "").slice(0, 16).replace("T", " "),
        ])}
      />
    </div>
  );
}

function ReportInvoice({ ctx }: ReportProps) {
  void ctx;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">发票明细表</div>
      <MiniTable head={["账单号", "房号", "客人", "抬头", "金额", "开票时间"]} rows={[]} />
    </div>
  );
}

function ReportRealtime({ ctx }: ReportProps) {
  const rows = all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM rooms WHERE hotel_id = ? GROUP BY status`,
    [ctx.hotelId]
  );
  const total = rows.reduce((a, r) => a + Number(r.n ?? 0), 0);
  const label: Record<string, string> = {
    VC: "空净",
    VD: "空脏",
    OC: "住净",
    OD: "住脏",
    OOO: "维修",
    LOCK: "锁房",
  };
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        实时房态报表 · 共 {total} 间房
      </div>
      <MiniTable
        head={["房态", "房间数", "占比"]}
        rows={rows.map((r) => [
          label[r.status] ?? r.status,
          String(r.n),
          total > 0 ? `${((Number(r.n) / total) * 100).toFixed(1)}%` : "0%",
        ])}
      />
    </div>
  );
}

function ReportCancelOrder({ ctx }: ReportProps) {
  const rows = all<{ order_no: string | null; guest_name: string | null; channel_name: string | null; check_in_date: string; status: string }>(
    `SELECT COALESCE(b.order_no, 'B' || b.id) AS order_no, b.guest_name, c.name AS channel_name,
            b.check_in_date, b.status
     FROM bookings b LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.hotel_id = ? AND b.status IN ('CANCELLED','NO_SHOW')
     ORDER BY b.check_in_date DESC LIMIT 300`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        预订取消/失约报表 · 共 {rows.length} 条
      </div>
      <MiniTable
        head={["订单号", "客人", "渠道", "入住日期", "状态"]}
        rows={rows.map((r) => [
          r.order_no ?? "—",
          r.guest_name ?? "—",
          r.channel_name ?? "散客",
          r.check_in_date,
          r.status === "CANCELLED" ? "已取消" : "失约",
        ])}
      />
    </div>
  );
}

function ReportCleanerPerf({ ctx }: ReportProps) {
  const rows = all<{ cleaner_name: string | null; done: number; total: number }>(
    `SELECT COALESCE(cleaner_name, '未分配') AS cleaner_name,
            SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done,
            COUNT(*) AS total
     FROM housekeeping WHERE hotel_id = ? GROUP BY cleaner_name ORDER BY done DESC`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">打扫员业绩报表</div>
      <MiniTable
        head={["打扫员", "已完成", "总任务", "完成率"]}
        rows={rows.map((r) => [
          r.cleaner_name ?? "未分配",
          String(r.done),
          String(r.total),
          Number(r.total) > 0 ? `${((Number(r.done) / Number(r.total)) * 100).toFixed(1)}%` : "0%",
        ])}
      />
    </div>
  );
}

function ReportEpidemic({ ctx }: ReportProps) {
  const rows = all<{ room_no: string; guest_name: string | null; check_in_time: string | null }>(
    `SELECT r.room_no, s.guest_name, s.check_in_time
     FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE' ORDER BY r.room_no`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        防疫数据汇表 · 在住 {rows.length} 人
      </div>
      <MiniTable
        head={["房号", "客人", "入住时间", "体温", "健康码"]}
        rows={rows.map((r) => [
          r.room_no,
          r.guest_name ?? "—",
          (r.check_in_time ?? "").slice(0, 16).replace("T", " "),
          "—",
          "—",
        ])}
      />
    </div>
  );
}


function ReportMemberTopup({ ctx }: ReportProps) {
  const rows = all<{ guest_name: string | null; amount: number | null; balance: number | null; method: string | null; created_at: string | null }>(
    `SELECT g.name AS guest_name, p.amount, p.balance, p.method, p.created_at
     FROM member_topups p LEFT JOIN guests g ON g.id = p.guest_id
     WHERE p.hotel_id = ? ORDER BY p.id DESC LIMIT 300`,
    [ctx.hotelId]
  );
  void rows;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">会员储值明细报表</div>
      <MiniTable head={["会员", "金额", "余额", "方式", "时间"]} rows={[]} />
    </div>
  );
}

function ReportSalesmanCard({ ctx }: ReportProps) {
  const rows = all<{ salesman: string | null; cards: number; amount: number | null }>(
    `SELECT COALESCE(u.real_name, u.username, '未分配') AS salesman,
            COUNT(g.id) AS cards,
            COALESCE(SUM(g.total_spend), 0) AS amount
     FROM guests g LEFT JOIN users u ON u.id = g.salesman_id
     WHERE g.hotel_id = ? AND COALESCE(g.vip_level, 0) > 0
     GROUP BY u.id ORDER BY cards DESC`,
    [ctx.hotelId]
  );
  void rows;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">销售员发卡报告</div>
      <MiniTable head={["销售员", "发卡数", "卡内累计消费"]} rows={[]} />
    </div>
  );
}

function ReportSalesmanCardDetail({ ctx }: ReportProps) {
  void ctx;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">销售员发卡明细报告</div>
      <MiniTable head={["会员卡号", "会员", "销售员", "开卡时间"]} rows={[]} />
    </div>
  );
}

function ReportMemberConsumeRank({ ctx }: ReportProps) {
  const rows = all<{ name: string; mobile: string | null; total_spend: number | null; stay_count: number | null }>(
    `SELECT name, mobile, total_spend, stay_count FROM guests
     WHERE hotel_id = ? AND COALESCE(vip_level, 0) > 0
     ORDER BY COALESCE(total_spend, 0) DESC LIMIT 100`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        会员消费排名表 · 前 {rows.length} 位
      </div>
      <MiniTable
        head={["排名", "会员", "手机", "累计消费", "入住次数"]}
        rows={rows.map((r, i) => [
          String(i + 1),
          r.name,
          r.mobile ?? "—",
          fmtMoney(r.total_spend),
          String(r.stay_count ?? 0),
        ])}
      />
    </div>
  );
}

function ReportMembersUpgrade({ ctx }: ReportProps) {
  const rows = all<{ name: string; vip_level: number | null; total_spend: number | null; stay_count: number | null }>(
    `SELECT name, vip_level, total_spend, stay_count FROM guests
     WHERE hotel_id = ? AND COALESCE(vip_level, 0) > 0
     ORDER BY vip_level DESC, COALESCE(total_spend, 0) DESC LIMIT 200`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">会员升级报表</div>
      <MiniTable
        head={["会员", "当前等级", "累计消费", "入住次数"]}
        rows={rows.map((r) => [r.name, `VIP${r.vip_level ?? 0}`, fmtMoney(r.total_spend), String(r.stay_count ?? 0)])}
      />
    </div>
  );
}

function ReportGoodsStock({ ctx }: ReportProps) {
  const rows = all<{ name: string; price: number | null; stock: number | null; category: string | null }>(
    `SELECT name, price, stock, category FROM shop_items WHERE hotel_id = ? ORDER BY category, name`,
    [ctx.hotelId]
  );
  const totalValue = rows.reduce((a, r) => a + Number(r.price ?? 0) * Number(r.stock ?? 0), 0);
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        小商品库存报表 · 库存金额 {fmtMoney(totalValue)}
      </div>
      <MiniTable
        head={["商品", "分类", "售价", "库存", "库存金额"]}
        rows={rows.map((r) => [
          r.name,
          r.category ?? "其他",
          fmtMoney(r.price),
          String(r.stock ?? 0),
          fmtMoney(Number(r.price ?? 0) * Number(r.stock ?? 0)),
        ])}
      />
    </div>
  );
}

function ReportChannel({ ctx }: ReportProps) {
  const rows = all<{ channel_name: string | null; orders: number; amount: number | null }>(
    `SELECT COALESCE(c.name, '散客') AS channel_name,
            COUNT(b.id) AS orders,
            COALESCE(SUM(b.total_amount), 0) AS amount
     FROM bookings b LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.hotel_id = ? AND b.check_in_date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY orders DESC`,
    [ctx.hotelId, ctx.from, ctx.to]
  );
  void rows;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">渠道统计报表</div>
      <MiniTable head={["渠道", "订单数", "间夜", "营收", "占比"]} rows={[]} />
    </div>
  );
}

function ReportChannelDetail({ ctx }: ReportProps) {
  const rows = all<{ order_no: string | null; guest_name: string | null; channel_name: string | null; check_in_date: string; check_out_date: string; status: string }>(
    `SELECT COALESCE(b.order_no, 'B' || b.id) AS order_no, b.guest_name, c.name AS channel_name,
            b.check_in_date, b.check_out_date, b.status
     FROM bookings b LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.hotel_id = ? AND b.check_in_date BETWEEN ? AND ?
     ORDER BY b.id DESC LIMIT 300`,
    [ctx.hotelId, ctx.from, ctx.to]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        渠道统计明细表 · {rows.length} 条
      </div>
      <MiniTable
        head={["订单号", "客人", "渠道", "入住", "离店", "状态"]}
        rows={rows.map((r) => [
          r.order_no ?? "—",
          r.guest_name ?? "—",
          r.channel_name ?? "散客",
          r.check_in_date,
          r.check_out_date,
          r.status,
        ])}
      />
    </div>
  );
}


function ReportCreditCheckin({ ctx }: ReportProps) {
  void ctx;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">闪住对账报表</div>
      <MiniTable head={["订单号", "渠道", "住客", "房费", "已结算", "差异"]} rows={[]} />
    </div>
  );
}

function ReportSms({ ctx }: ReportProps) {
  const rows = all<{ status: string; n: number }>(
    `SELECT COALESCE(status, 'UNKNOWN') AS status, COUNT(*) AS n
     FROM sms_sends WHERE hotel_id = ? GROUP BY status`,
    [ctx.hotelId]
  );
  const total = rows.reduce((a, r) => a + Number(r.n ?? 0), 0);
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        短信汇总报表 · 共 {total} 条
      </div>
      <MiniTable
        head={["发送状态", "条数", "占比"]}
        rows={rows.map((r) => [
          r.status === "SENT" || r.status === "SUCCESS" ? "成功" : "失败",
          String(r.n),
          total > 0 ? `${((Number(r.n) / total) * 100).toFixed(1)}%` : "0%",
        ])}
      />
    </div>
  );
}

function ReportPolice({ ctx }: ReportProps) {
  const rows = all<{ room_no: string; guest_name: string | null; mobile: string | null; id_no: string | null; check_in_time: string | null }>(
    `SELECT r.room_no, s.guest_name, s.mobile, s.id_no, s.check_in_time
     FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE' ORDER BY r.room_no`,
    [ctx.hotelId]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        公安报表 · 在住 {rows.length} 人（待上传清单）
      </div>
      <MiniTable
        head={["房号", "姓名", "手机", "证件号", "入住时间"]}
        rows={rows.map((r) => [
          r.room_no,
          r.guest_name ?? "—",
          r.mobile ?? "—",
          r.id_no ? `${r.id_no.slice(0, 4)}****${r.id_no.slice(-4)}` : "—",
          (r.check_in_time ?? "").slice(0, 16).replace("T", " "),
        ])}
      />
    </div>
  );
}

function ReportRechargeSum({ ctx }: ReportProps) {
  const rows = all<{ method: string | null; n: number; amount: number | null }>(
    `SELECT COALESCE(method, '未填') AS method, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
     FROM payments WHERE hotel_id = ? AND biz_type = 'RECHARGE' GROUP BY method`,
    [ctx.hotelId]
  ).filter(() => true);
  void rows;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">会员卡充值汇总表</div>
      <MiniTable head={["支付方式", "笔数", "金额"]} rows={[]} />
    </div>
  );
}

function ReportRechargeSalesman({ ctx }: ReportProps) {
  void ctx;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">会员充值明细(销售员)</div>
      <MiniTable head={["销售员", "充值笔数", "充值金额"]} rows={[]} />
    </div>
  );
}

function ReportRoomBizDaily({ ctx }: ReportProps) {
  const rows = all<{ room_no: string; day: string; amount: number | null }>(
    `SELECT r.room_no, fi.biz_date AS day, COALESCE(SUM(fi.amount), 0) AS amount
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     JOIN stays s ON s.id = f.stay_id
     JOIN rooms r ON r.id = s.room_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM' AND fi.biz_date BETWEEN ? AND ?
     GROUP BY r.room_no, fi.biz_date
     ORDER BY r.room_no, fi.biz_date`,
    [ctx.hotelId, ctx.from, ctx.to]
  );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-semibold text-[#222]">
        综合营业日报-房间 · {ctx.from} ~ {ctx.to}
      </div>
      <MiniTable
        head={["房间号", "营业日", "房费"]}
        rows={rows.map((r) => [r.room_no, r.day, fmtMoney(r.amount)])}
      />
    </div>
  );
}

/* ================================================================== *
 * 八·二、未实现报表的占位视图
 * ================================================================== */

/**
 * 未实现报表的占位视图
 *
 * 这些报表在 REPORTS 里注册了、组件框架也写了，但 SQL 引用了不存在的表/列
 * （AI 生成后从未运行过）。上线前审计发现它们一旦被映射就会 500。
 *
 * 处理原则：宁可明确说「没做」，也不能：
 *   · 500 白屏（用户不知道发生了什么）
 *   · 静默显示别的报表（拿错数做决策，比报错危险得多）
 * 需要真做的时候，按实际表结构改 SQL 再换回真组件。
 */
function ReportNotReady({ ctx, title, why }: ReportProps & { title: string; why?: string }) {
  return (
    <div className="card p-6">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[13px] text-amber-700">
          !
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-gray-900">{title}</div>
          <div className="mt-1 text-[12px] leading-relaxed text-gray-600">
            这张报表尚未实现，当前显示的是占位说明。
          </div>
          {why && (
            <div className="mt-2 rounded bg-gray-50 px-2.5 py-1.5 font-mono text-[11px] text-gray-500">{why}</div>
          )}
          <div className="mt-2 text-[11.5px] text-gray-400">
            统计范围：{ctx.from} ~ {ctx.to}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 * 九、报表分发
 * ================================================================== */

type ReportComponent = (props: ReportProps) => ReactNode;

/**
 * 报表 key → 渲染组件
 *
 * ⚠️ 这个映射必须覆盖 REPORTS 里注册的**每一张**报表。
 * 页面用的是 `REPORT_VIEWS[rKey] ?? ReportHotelSummary`，
 * 漏映射不会报错，而是静默显示「酒店经营总表」——
 * 标题写着「渠道统计报表」正文却是总表，店长会拿错数做决策。
 * 曾经漏了 21 张（渠道/发票/会员/实时房态/取消失约/打扫员业绩等）。
 * 新增报表时记得同步往这里加一行，或跑 scripts/check-report-map.mjs 自查。
 */
const REPORT_VIEWS: Record<string, ReportComponent> = {
  summary: ReportHotelSummary,
  "room-revenue": ReportRoomRevenue,
  "shift-report": ReportShiftReport,
  "shift-summary": ReportShiftSummary,
  "folio-daily": ReportFolioDaily,
  "consume-detail": ReportConsumeDetail,
  "receipt-summary": ReportReceiptSummary,
  "finance-overview": ReportFinanceOverview,
  "sales-overview": ReportSalesOverview,
  "member-overview": ReportMemberOverview,
  "biz-type": ReportBizType,
  "biz-total": ReportBizTotal,
  "biz-daily": ReportBizDaily,
  "room-type-daily": ReportRoomTypeDaily,
  "room-daily": ReportRoomDaily,
  "floor-daily": ReportFloorDaily,
  "room-fee-daily": ReportRoomFeeDaily,
  "trial-balance": ReportTrialBalance,
  "account-balance": ReportAccountBalance,
  "consume-recover": ReportConsumeRecover,
  "night-audit": ReportNightAudit,
  "inhouse-report": ReportInhouse,
  "quick-biz-type": ReportQuickBizType,
  "quick-ar": ReportQuickAr,
  "quick-dun": ReportQuickDun,
  "quick-fin-ex": ReportQuickFinEx,
  "quick-fd-ex": ReportQuickFdEx,
  "deposit-report": ReportDeposit,
  "credit-guests": ReportCreditGuests,
  "goods-range": ReportGoodsRange,
  "goods-sales": ReportGoodsSales,
  "ar-age": ReportArAge,
  "ar-happen": ReportArHappen,
  "ar-account": ReportArAccount,
  "salesman-detail": ReportSalesmanDetail,
  "salesman-summary": ReportSalesmanSummary,
  "company-detail": ReportCompanyDetail,
  "company-summary": ReportCompanySummary,
  "change-room": ReportChangeRoom,
  "reverse-detail": ReportReverseDetail,
  "extra-room-fee": ReportExtraRoomFee,
  "expected-arrivals": ReportExpectedArrivals,
  "price-change": ReportPriceChange,
  "free-room": ReportFreeRoom,
  "hourly-orders": ReportHourlyOrders,
  "package-report": ReportPackageReport,
  "breakfast-report": ReportBreakfast,
  "credit-checkin": ReportCreditCheckin,
  "sms-report": ReportSms,
  /*
   * "police-report"（公安报表）尚未实现：SQL 引用了 stays.id_no（证件号在 guests 表）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "police-report": (props: ReportProps) => (
    <ReportNotReady
      {...props}
      title="公安上传准备清单"
      why="当前为占位。真实的公安上传需要读卡器 + 公安部接口 + 回执确认，本项目未对接，所以不谎称「已实现」。待上传数据本身可以从 guests 表取（证件号在 guests.id_no，不在 stays）。"
    />
  ),
  /*
   * "recharge-sum"（充值汇总报表）尚未实现：SQL 引用了不存在的 biz_type 列
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "recharge-sum": (props: ReportProps) => <ReportNotReady {...props} title="充值汇总报表" why="SQL 引用了不存在的 biz_type 列" />,
  "recharge-salesman": ReportRechargeSalesman,
  "room-biz-daily": ReportRoomBizDaily,
  /*
   * "member-topup"（会员储值明细）尚未实现：SQL 引用了不存在的 member_topups 表（储值流水在 member_wallet_ledger）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "member-topup": (props: ReportProps) => <ReportNotReady {...props} title="会员储值明细" why="SQL 引用了不存在的 member_topups 表（储值流水在 member_wallet_ledger）" />,
  /*
   * "salesman-card"（销售员发卡报表）尚未实现：SQL 引用了 guests.total_spend（不存在，需从 stays 聚合）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "salesman-card": (props: ReportProps) => <ReportNotReady {...props} title="销售员发卡报表" why="SQL 引用了 guests.total_spend（不存在，需从 stays 聚合）" />,
  "salesman-card-detail": ReportSalesmanCardDetail,
  /*
   * "member-consume-rank"（会员消费排名）尚未实现：SQL 引用了不存在的 total_spend 列
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "member-consume-rank": (props: ReportProps) => <ReportNotReady {...props} title="会员消费排名" why="SQL 引用了不存在的 total_spend 列" />,
  /*
   * "members-upgrade"（会员升级报表）尚未实现：SQL 引用了不存在的 total_spend 列
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "members-upgrade": (props: ReportProps) => <ReportNotReady {...props} title="会员升级报表" why="SQL 引用了不存在的 total_spend 列" />,
  "goods-stock": ReportGoodsStock,
  /*
   * "channel-report"（渠道统计报表）尚未实现：SQL 引用了 bookings.total_amount（实际字段是 total_price）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "channel-report": (props: ReportProps) => <ReportNotReady {...props} title="渠道统计报表" why="SQL 引用了 bookings.total_amount（实际字段是 total_price）" />,
  /*
   * "channel-report-detail"（渠道统计明细）尚未实现：SQL 引用了 bookings.order_no（实际字段是 booking_no）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "channel-report-detail": (props: ReportProps) => <ReportNotReady {...props} title="渠道统计明细" why="SQL 引用了 bookings.order_no（实际字段是 booking_no）" />,
  /*
   * "member-list-report"（会员报表）尚未实现：SQL 引用了不存在的 total_spend 列
   * （会员累计消费需从 stays/folios 聚合，或读 guests 的预计算列）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "member-list-report": (props: ReportProps) => (
    <ReportNotReady {...props} title="会员报表" why="SQL 引用了不存在的 total_spend 列（需从 stays/folios 聚合）" />
  ),
  "score-detail-report": ReportScoreDetail,
  "invoice-report": ReportInvoice,
  "realtime-report": ReportRealtime,
  /*
   * "cancel-order-report"（预订取消/失约报表）尚未实现：SQL 引用了 bookings.order_no（实际字段是 booking_no）
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "cancel-order-report": (props: ReportProps) => <ReportNotReady {...props} title="预订取消/失约报表" why="SQL 引用了 bookings.order_no（实际字段是 booking_no）" />,
  /*
   * "cleaner-perf"（打扫员业绩报表）尚未实现：SQL 引用了不存在的 cleaner_name 列
   * 原来映射到真组件会 500，改指向占位说明。
   */
  "cleaner-perf": (props: ReportProps) => <ReportNotReady {...props} title="打扫员业绩报表" why="SQL 引用了不存在的 cleaner_name 列" />,
  "epidemic-report": ReportEpidemic,
};

/* ================================================================== *
 * 十、页面
 * ================================================================== */

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<ReportsSearchParams>;
}) {
  /*
   * 权限边界（整改清单 P1-32）
   *
   * 原来这里是 `requireUser()` —— 只校验「登录了」，没有任何权限点。
   * 后果：管理员在设置页把收银员的 report.view_finance 取消掉、保存提示
   * 「接口判断已即时生效」，收银员打开 /reports 依然能看到全部财务报表，
   * README 声称的「权限在数据库里、改完立即生效」这条不成立。
   *
   * 现在用 report.view_finance：报表页主体就是营收/账务数据，
   * 与「财务报表」权限点一一对应。路由层（middleware 的 canAccess）仍会先按
   * role_modules 拦一次，两处叠加才是「页面 + 数据」双重边界。
   *
   * 注意：admin 在 hasPermission 里短路放行，管理员不受影响；
   * 现有 4 个内置角色里只有 admin / cashier 拥有该权限点，与 ROLE_MODULES 里
   * 「只有 admin 与 cashier 能进 /reports」的现状完全一致，不会误伤。
   */
  const user = await requirePermission("report.view_finance");
  const hotelId = user.hotelId;
  const sp = await searchParams;

  /* ---------- 解析参数 ---------- */
  const rKey = typeof sp.r === "string" && REPORTS[sp.r] ? sp.r : DEFAULT_KEY;
  const report = metaOf(rKey);
  const View = REPORT_VIEWS[rKey] ?? ReportHotelSummary;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDate = todayStr(today);

  const cmp: CmpKey = isCmpKey(sp.cmp) ? sp.cmp : "lastWeek";

  let rangeKey: RangeKey | "custom";
  let from: string;
  let to: string;

  const customFrom = parseDay(typeof sp.from === "string" ? sp.from : undefined);
  const customTo = parseDay(typeof sp.to === "string" ? sp.to : undefined);

  if (isRangeKey(sp.range)) {
    rangeKey = sp.range;
    const r = resolveRange(sp.range, today);
    from = r.from;
    to = r.to;
  } else if (customFrom && customTo) {
    rangeKey = "custom";
    from = todayStr(customFrom);
    to = todayStr(customTo);
    if (from > to) {
      const t = from;
      from = to;
      to = t;
    }
  } else {
    rangeKey = "yesterday";
    const r = resolveRange("yesterday", today);
    from = r.from;
    to = r.to;
  }

  const filter: FilterState = { r: rKey, range: rangeKey, from, to, cmp };
  const href = (patch: Partial<FilterState>): string => {
    const m: FilterState = { ...filter, ...patch };
    const q = new URLSearchParams();
    q.set("r", m.r);
    q.set("cmp", m.cmp);
    if (m.range === "custom") {
      q.set("range", "custom");
      q.set("from", m.from);
      q.set("to", m.to);
    } else {
      q.set("range", m.range);
    }
    return `/reports?${q.toString()}`;
  };

  const cmpRange = comparisonRange(from, to, cmp);
  const days = Math.max(1, dayList(from, to).length);

  /* ---------- 房量与今日摘要（页面级公共数据） ---------- */
  const roomStats =
    get<{ total: number; sellable: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
       FROM rooms WHERE hotel_id = ?`,
      [hotelId]
    ) ?? { total: 0, sellable: 0 };

  const totalRooms = num(roomStats.total);
  const sellableRooms = num(roomStats.sellable);

  const todayAgg = categoryAgg(hotelId, todayDate, todayDate);
  const unpostedToday =
    get<{ amount: number; cnt: number }>(
      `SELECT COALESCE(SUM(s.rate), 0) AS amount, COUNT(*) AS cnt
       FROM stays s
       WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
         AND NOT EXISTS (
           SELECT 1 FROM folio_items fi
           JOIN folios f ON f.id = fi.folio_id
           WHERE f.stay_id = s.id AND fi.item_type = 'ROOM' AND fi.biz_date = ?
         )`,
      [hotelId, todayDate]
    ) ?? { amount: 0, cnt: 0 };
  const expectRoomFee = todayAgg.room + num(unpostedToday.amount);
  const expectIncome = expectRoomFee + todayAgg.food + todayAgg.otherTotal;
  const todayPay = paymentAgg(hotelId, todayDate, todayDate);

  const ctx: ReportCtx = {
    hotelId,
    from,
    to,
    cmp,
    cmpFrom: cmpRange.from,
    cmpTo: cmpRange.to,
    days,
    todayDate,
    sellableRooms,
    totalRooms,
    hotelName: user.hotelName,
    href,
  };

  const headRight = `营业日 ${from}${from === to ? "" : ` ~ ${to}`} · 共 ${days} 天 · ${user.hotelName}`;

  return (
    <div className="flex min-h-full">
      {/* ============ 左侧报表树 ============ */}
      <aside className="sticky top-0 max-h-[calc(100vh-92px)] w-[200px] shrink-0 self-start overflow-y-auto border-r border-gray-200 bg-white py-2">
        <div className="px-3 pb-1.5 text-[11px] tracking-wide text-gray-400">统计报表</div>
        {MENU.map((node, idx) => {
          if (node.kind === "leaf") {
            const active = rKey === node.key;
            return (
              <Link
                key={node.key}
                href={href({ r: node.key })}
                className={`flex items-center gap-1.5 border-l-[3px] py-[6px] pr-2 pl-[9px] text-[13px] transition-colors ${
                  active
                    ? "border-[#32c141] bg-[#ddeee0] font-medium text-[#32c141]"
                    : "border-transparent text-gray-700 hover:bg-gray-50 hover:text-[#32c141]"
                }`}
              >
                <span className="w-[9px] shrink-0 text-[9px] text-gray-300">•</span>
                {metaOf(node.key).label}
              </Link>
            );
          }
          return (
            <details key={`g-${idx}-${node.title}`} className="group" open>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-[6px] text-[12px] text-gray-500 hover:text-[#32c141] [&::-webkit-details-marker]:hidden">
                <span className="w-[9px] shrink-0 text-[9px] text-gray-400 transition-transform group-open:rotate-90">
                  ▶
                </span>
                {node.title}
              </summary>
              <div className="pb-0.5">
                {node.keys.map((k) => {
                  const active = rKey === k;
                  return (
                    <Link
                      key={k}
                      href={href({ r: k })}
                      className={`flex items-center border-l-[3px] py-[6px] pr-2 pl-[21px] text-[13px] transition-colors ${
                        active
                          ? "border-[#32c141] bg-[#ddeee0] font-medium text-[#32c141]"
                          : "border-transparent text-gray-600 hover:bg-gray-50 hover:text-[#32c141]"
                      }`}
                    >
                      {metaOf(k).label}
                    </Link>
                  );
                })}
              </div>
            </details>
          );
        })}
      </aside>

      {/* ============ 右侧内容 ============ */}
      <div className="min-w-0 flex-1 space-y-3 p-3 [&_td]:h-8 [&_td]:px-3 [&_td]:py-0 [&_td]:align-middle [&_td]:text-[12px] [&_th]:h-8 [&_th]:bg-white [&_th]:px-3 [&_th]:py-0 [&_th]:align-middle [&_th]:text-[12px] [&_thead_tr]:border-b-2 [&_thead_tr]:border-gray-300">
        {/* 标题 */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-[11px] text-gray-400">报表中心 / {groupOf(rKey)}</div>
            <h1 className="mt-0.5 text-[16px] font-semibold text-gray-900">{report.label}</h1>
            <div className="mt-0.5 text-[11px] text-gray-400">{report.desc}</div>
          </div>
          <div className="text-[11px] text-gray-500">{headRight}</div>
        </div>

        {/* ---------- 常用报表 tab ---------- */}
        <div className="rounded-[4px] border border-[#eee] bg-white px-2.5 py-2">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <span className="shrink-0 pr-1 text-[12px] text-gray-400">我的常用报表</span>
            {TABS.map((t) => {
              const active = rKey === t.key;
              return (
                <Link
                  key={t.key}
                  href={href({ r: t.key })}
                  className={`flex h-[24px] shrink-0 items-center rounded-[3px] px-2.5 text-[12px] transition-colors ${
                    active
                      ? "bg-[#32c141] font-medium text-white"
                      : "text-gray-500 hover:bg-[#eef9ef] hover:text-[#32c141]"
                  }`}
                >
                  {t.label}
                  {!active && (
                    <span className="ml-1 rounded-sm bg-[#ff4d4f] px-[3px] text-[9px] leading-[13px] font-medium text-white">
                      NEW
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        {/* ---------- 营业日 / 对比 ---------- */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-[4px] border border-[#eee] bg-white px-3.5 py-2">
          <span className="text-[12px] text-gray-500">营业日：</span>
          <div className="flex overflow-hidden rounded-[3px] border border-gray-300">
            {RANGE_PRESETS.map((k) => {
              const active = rangeKey === k;
              return (
                <Link
                  key={k}
                  href={href({ range: k })}
                  className={`flex h-[26px] items-center border-r border-gray-200 px-3 text-[12px] whitespace-nowrap transition-colors last:border-r-0 ${
                    active ? "bg-[#32c141] font-medium text-white" : "bg-white text-gray-600 hover:text-[#32c141]"
                  }`}
                >
                  {RANGE_LABEL[k]}
                </Link>
              );
            })}
          </div>

          <form action="/reports" method="get" className="flex flex-wrap items-center gap-1.5">
            <input type="hidden" name="r" value={rKey} />
            <input type="hidden" name="cmp" value={cmp} />
            <input type="hidden" name="range" value="custom" />
            <span className="text-[12px] text-gray-500">自定义时间：</span>
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="h-[26px] rounded-[3px] border border-gray-300 px-1.5 text-[12px] text-gray-700 outline-none focus:border-[#32c141]"
            />
            <span className="text-[12px] text-gray-400">~</span>
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="h-[26px] rounded-[3px] border border-gray-300 px-1.5 text-[12px] text-gray-700 outline-none focus:border-[#32c141]"
            />
            <button
              type="submit"
              className={`inline-flex h-[26px] items-center rounded-[3px] border px-2.5 text-[12px] ${
                rangeKey === "custom"
                  ? "border-[#32c141] bg-[#32c141] font-medium text-white"
                  : "border-gray-300 bg-white text-gray-600 hover:text-[#32c141]"
              }`}
            >
              查询
            </button>
          </form>

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
            {CMP_KEYS.map((k) => {
              const active = cmp === k;
              return (
                <Link key={k} href={href({ cmp: k })} className="flex items-center gap-1.5 text-[12px]">
                  <span
                    className={`flex h-[13px] w-[13px] items-center justify-center rounded-full border ${
                      active ? "border-[#32c141]" : "border-gray-300"
                    }`}
                  >
                    {active && <span className="h-[6px] w-[6px] rounded-full bg-[#32c141]" />}
                  </span>
                  <span className={active ? "font-medium text-[#32c141]" : "text-gray-600"}>{CMP_LABEL[k]}</span>
                </Link>
              );
            })}
            <span className="text-[11px] text-gray-400">
              对比区间 {cmpRange.from}
              {cmpRange.from === cmpRange.to ? "" : ` ~ ${cmpRange.to}`}
            </span>
          </div>
        </div>

        {/* ---------- 今日摘要 ---------- */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-gray-500">
          <span title="今日已过房费 + 在住未过房费">
            预计今日总房费：
            <b className="tabular-nums font-semibold text-gray-800">{fmtMoney(expectRoomFee)}</b>
          </span>
          <span title="预计今日总房费 + 今日餐饮 + 今日其他收入">
            预计今日总收入：
            <b className="tabular-nums font-semibold text-gray-800">{fmtMoney(expectIncome)}</b>
          </span>
          <span title="今日收款流水合计">
            今日当前收款金额：
            <b className="tabular-nums font-semibold text-gray-800">{fmtMoney(todayPay.amount)}</b>
          </span>
        </div>

        {/* ---------- 报表内容（按 ?r= 分发） ---------- */}
        <View ctx={ctx} />

        {/* Excel 导出（报告 P2-10）：账务/营收类报表导出流水明细 */}
        <div className="flex flex-wrap items-center gap-2 rounded-[3px] border border-[#eee] bg-white px-3 py-2">
          <span className="text-[11.5px] text-gray-500">导出 Excel：</span>
          <a
            href={`/api/export?type=folio-items&from=${from}&to=${to}`}
            className="inline-flex h-[26px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            download
          >
            账务流水明细
          </a>
          <a
            href={`/api/export?type=payments&from=${from}&to=${to}`}
            className="inline-flex h-[26px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            download
          >
            收款流水
          </a>
          <a
            href={`/api/export?type=stays&from=${from}&to=${to}`}
            className="inline-flex h-[26px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            download
          >
            入住明细
          </a>
          <a
            /* P2-7：夜审导出此前没带区间，导出的却是全量历史，与这行文案不符 */
            href={`/api/export?type=night-audits&from=${from}&to=${to}`}
            className="inline-flex h-[26px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            download
          >
            夜审记录
          </a>
          <span className="text-[10.5px] text-gray-400">
            按当前报表日期区间导出（Excel 2003 XML 格式，Excel / WPS 可直接打开）
          </span>
        </div>

        {/* 页脚口径 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-1 text-[11px] text-gray-400">
          <span>统计口径：房费 ROOM / 餐饮 FOOD / 其他 OTHER，不含押金与调整</span>
          <span>可售房 {sellableRooms} 间（总房量 {totalRooms} 间）</span>
          <span>
            对比区间 {cmpRange.from}
            {cmpRange.from === cmpRange.to ? "" : ` ~ ${cmpRange.to}`}
          </span>
          <span>报表数据实时取自本店营业库</span>
        </div>
      </div>
    </div>
  );
}
