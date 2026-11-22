import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import {
  applyUpgradeAction,
  cancelMemberAction,
  createMemberAction,
  importMembersAction,
  saveUpgradeRulesAction,
  upgradeMemberAction,
} from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type TabKey = "members" | "consumption" | "upgrade";

const TABS: { key: TabKey; label: string }[] = [
  { key: "members", label: "会员列表" },
  { key: "consumption", label: "消费记录" },
  { key: "upgrade", label: "会员升级" },
];

/** 左侧竖向菜单的菜单项（会员模块直属项） */
type NavItem = { key: string; label: string; href: string };

const NAV_ITEMS: NavItem[] = [
  { key: "members", label: "会员列表", href: "/members?tab=members" },
  { key: "consumption", label: "消费记录", href: "/members?tab=consumption" },
  { key: "score-detail", label: "积分明细", href: "/points?tab=records" },
  { key: "upgrade", label: "会员升级", href: "/members?tab=upgrade" },
  { key: "exchange", label: "兑换记录", href: "/points?tab=redeem" },
];

/** 可折叠分组「会员卡设置」的子菜单（锚点对齐各页面真实区块 id） */
const CARD_GROUP_ITEMS: NavItem[] = [
  { key: "card-types", label: "会员卡类型设置", href: "/member-cards#card-types" },
  { key: "points-code", label: "积分代码设置", href: "/points?tab=rules" },
  { key: "points-goods", label: "积分商品设置", href: "/points?tab=goods" },
  { key: "recharge", label: "充值方案", href: "/member-cards#recharge-plans" },
];

const NAV_ACTIVE_CLS = "border-l-[#0f8f6f] bg-[#eef9f0] font-medium text-[#0f8f6f]";
const NAV_IDLE_CLS = "border-l-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900";
const NAV_BASE_CLS =
  "flex h-[34px] items-center border-l-[3px] pr-3 text-[13px] transition-colors";

type MemberRow = {
  id: number;
  name: string;
  mobile: string | null;
  vip_level: number;
  stay_count: number;
  total_spend: number;
  last_stay: string | null;
  /** 可消费积分：score_records.points 累计（EARN 正、SPEND 负） */
  points_balance: number;
  /** 累计积分：仅 EARN 流水合计 */
  points_total: number;
};

/** member_card_types：会员卡类型（折扣 / 积分比例 / 最低充值） */
type CardTypeRow = {
  id: number;
  name: string;
  discount: number;
  points_ratio: number;
  status: string;
};

type MemberStats = { total: number; v1: number; v2: number; v3: number };

/** 会员消费明细行（folio_items 为主，联 folios / stays / payments） */
type ConsumptionRow = {
  id: number;
  item_type: string;
  description: string | null;
  amount: number;
  biz_date: string | null;
  created_at: string | null;
  folio_no: string | null;
  room_no: string | null;
  stay_no: string | null;
  guest_name: string | null;
  methods: string | null;
  guest_id: number | null;
  operator: string | null;
};

type ConsumptionStats = { total: number; cnt: number };

type UpgradeLevelRule = {
  level: number;
  minSpend: number;
  minStays: number;
  discount: number;
  pointsRate: number;
};

type UpgradeRules = { basis: "spend" | "stays"; levels: UpgradeLevelRule[] };

const UPGRADE_RULES_KEY = "member_upgrade_rules";

const DEFAULT_UPGRADE_RULES: UpgradeRules = {
  basis: "spend",
  levels: [
    { level: 1, minSpend: 0, minStays: 0, discount: 1, pointsRate: 1 },
    { level: 2, minSpend: 3000, minStays: 5, discount: 0.95, pointsRate: 1.5 },
    { level: 3, minSpend: 10000, minStays: 15, discount: 0.9, pointsRate: 2 },
  ],
};

const VIP_META: Record<number, { label: string; cls: string }> = {
  1: { label: "VIP1", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  2: { label: "VIP2", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  3: { label: "VIP3", cls: "border-violet-200 bg-violet-50 text-violet-700" },
};

/** 消费类型（folio_items.item_type）显示名与配色 */
const ITEM_TYPE_META: Record<string, { label: string; cls: string }> = {
  ROOM: { label: "房费", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  FOOD: { label: "餐饮", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  GOODS: { label: "商品", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  SERVICE: { label: "服务费", cls: "border-violet-200 bg-violet-50 text-violet-700" },
  ADJUST: { label: "调整", cls: "border-rose-200 bg-rose-50 text-rose-600" },
  DEPOSIT: { label: "押金", cls: "border-gray-200 bg-gray-50 text-gray-500" },
  OTHER: { label: "其他消费", cls: "border-gray-200 bg-gray-50 text-gray-600" },
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 积分整数展示（千分位） */
function fmtPoints(n: number | null | undefined): string {
  return Math.trunc(Number(n ?? 0)).toLocaleString("zh-CN");
}

/** 旧库可能还没建懒建表（积分表 / 会员卡类型表），先探测再取列，避免整页 500 */
function tableExists(name: string): boolean {
  return (
    (get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [name]
    )?.n ?? 0) > 0
  );
}

/** 左菜单项：选中态左侧 3px 绿色竖条 + 浅绿底 + 绿字 */
function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`${NAV_BASE_CLS} pl-[13px] ${active ? NAV_ACTIVE_CLS : NAV_IDLE_CLS}`}
    >
      {item.label}
    </Link>
  );
}

/** 分组子项：字号/行高与一级项一致，左侧多缩进 16px */
function NavSubLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`${NAV_BASE_CLS} pl-[29px] ${active ? NAV_ACTIVE_CLS : NAV_IDLE_CLS}`}
    >
      {item.label}
    </Link>
  );
}

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** 日期只接受 yyyy-mm-dd，避免脏参数进入比较条件 */
function dayParam(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}

function dayText(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** yyyy-mm-dd hh:mm，消费明细的「时间」列用 */
function timeText(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

function itemTypeOf(type: string) {
  return ITEM_TYPE_META[type] ?? { label: type || "其他消费", cls: "border-gray-200 bg-gray-50 text-gray-600" };
}

/** 支付方式：同一账单可能多笔收款，多种方式合并显示为「混合」 */
function payText(methods: string | null) {
  const list = (methods ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (list.length === 0) return { text: "—", title: "该账单暂未收款" };
  if (list.length === 1) return { text: list[0], title: list[0] };
  return { text: "混合", title: list.join(" / ") };
}

/** 折扣率 → 中文折数，1 表示无折扣 */
function discountText(discount: number) {
  if (!Number.isFinite(discount) || discount >= 1) return "无折扣";
  return `${round2(discount * 10)} 折`;
}

function numOf(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 settings.member_upgrade_rules，字段缺失 / JSON 损坏时回落默认规则 */
function parseUpgradeRules(raw: string | null | undefined): UpgradeRules {
  if (!raw) return DEFAULT_UPGRADE_RULES;
  try {
    const data = JSON.parse(raw) as { basis?: unknown; levels?: unknown };
    const basis: UpgradeRules["basis"] = data?.basis === "stays" ? "stays" : "spend";
    const list = Array.isArray(data?.levels) ? (data.levels as unknown[]) : [];

    const levels: UpgradeLevelRule[] = [1, 2, 3].map((lv) => {
      const found = list.find((x) => {
        if (!x || typeof x !== "object") return false;
        return Math.trunc(numOf((x as Record<string, unknown>).level, -1)) === lv;
      }) as Record<string, unknown> | undefined;
      const def = DEFAULT_UPGRADE_RULES.levels.find((x) => x.level === lv) ?? DEFAULT_UPGRADE_RULES.levels[0];
      return {
        level: lv,
        minSpend: Math.max(0, round2(numOf(found?.minSpend, def.minSpend))),
        minStays: Math.max(0, Math.trunc(numOf(found?.minStays, def.minStays))),
        discount: Math.min(1, Math.max(0.1, numOf(found?.discount, def.discount))),
        pointsRate: Math.min(10, Math.max(0, numOf(found?.pointsRate, def.pointsRate))),
      };
    });

    return { basis, levels };
  } catch {
    return DEFAULT_UPGRADE_RULES;
  }
}

/** 按生效口径判断会员应得等级（0 表示未达任何等级门槛） */
function targetLevelOf(
  member: { stay_count: number; total_spend: number },
  rules: UpgradeRules
): number {
  let target = 0;
  for (const lv of rules.levels) {
    const reached =
      rules.basis === "stays"
        ? Number(member.stay_count ?? 0) >= lv.minStays
        : Number(member.total_spend ?? 0) >= lv.minSpend;
    if (reached && lv.level > target) target = lv.level;
  }
  return target;
}

export default async function MembersPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  const tabParam = first(sp.tab);
  const activeTab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "members";

  const msg = first(sp.msg);
  const err = first(sp.err);

  // 消费记录筛选条件
  const guestFilter = Number(first(sp.guest)) || 0;
  const fromDate = dayParam(first(sp.from));
  const toDate = dayParam(first(sp.to));

  // 会员列表搜索区：关键字（姓名 / 手机）+ 「N 天后生日」
  const kw = first(sp.kw).trim();
  const birthdayDays = Math.max(0, Math.min(365, Math.trunc(Number(first(sp.birthdays)) || 0)));
  const showNewForm = first(sp.new) === "1";

  // 积分表由积分模块懒建（points/actions.ts），卡类型表由会员卡模块懒建：
  // 旧库可能还没有，先探测再取列，避免整页 500
  const hasScore = tableExists("score_records");
  const hasCardTypes = tableExists("member_card_types");

  const cardTypes = hasCardTypes
    ? all<CardTypeRow>(
        `SELECT id, name, discount, points_ratio, status
           FROM member_card_types
          WHERE hotel_id = ?
          ORDER BY discount DESC, id`,
        [hotelId]
      )
    : [];

  /** guests 未存卡类型外键：按会员等级对应「折扣从高到低」的卡类型序号（VIP3 → 折扣最高那张） */
  function cardTypeOf(vipLevel: number): CardTypeRow | undefined {
    if (cardTypes.length === 0) return undefined;
    const lv = Math.min(Math.max(1, Math.trunc(vipLevel)), cardTypes.length);
    return cardTypes[lv - 1];
  }

  const memberWhere = ["g.hotel_id = ?", "g.vip_level > 0"];
  const memberParams: unknown[] = [hotelId];
  if (kw) {
    memberWhere.push("(g.name LIKE ? OR COALESCE(g.mobile, '') LIKE ?)");
    memberParams.push(`%${kw}%`, `%${kw}%`);
  }

  const pointsSql = hasScore
    ? `(SELECT COALESCE(SUM(sr.points), 0) FROM score_records sr
          WHERE sr.hotel_id = g.hotel_id AND sr.guest_id = g.id) AS points_balance,
       (SELECT COALESCE(SUM(CASE WHEN sr.type = 'EARN' THEN sr.points ELSE 0 END), 0) FROM score_records sr
          WHERE sr.hotel_id = g.hotel_id AND sr.guest_id = g.id) AS points_total`
    : `0 AS points_balance, 0 AS points_total`;

  const rows = all<MemberRow>(
    `SELECT g.id, g.name, g.mobile, g.vip_level,
       (SELECT COUNT(*) FROM stays s
         WHERE s.hotel_id = g.hotel_id AND (s.guest_id = g.id OR s.guest_name = g.name)) AS stay_count,
       (SELECT COALESCE(SUM(fi.amount), 0)
          FROM folio_items fi
          JOIN folios f ON f.id = fi.folio_id
          JOIN stays s ON s.id = f.stay_id
         WHERE s.hotel_id = g.hotel_id
           AND (s.guest_id = g.id OR s.guest_name = g.name)
           AND fi.item_type != 'DEPOSIT') AS total_spend,
       (SELECT MAX(s.check_in_time) FROM stays s
         WHERE s.hotel_id = g.hotel_id AND (s.guest_id = g.id OR s.guest_name = g.name)) AS last_stay,
       ${pointsSql}
     FROM guests g
     WHERE ${memberWhere.join(" AND ")}
     ORDER BY g.vip_level DESC, total_spend DESC, g.id DESC`,
    memberParams
  );

  const st =
    get<MemberStats>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN vip_level = 1 THEN 1 ELSE 0 END), 0) AS v1,
              COALESCE(SUM(CASE WHEN vip_level = 2 THEN 1 ELSE 0 END), 0) AS v2,
              COALESCE(SUM(CASE WHEN vip_level = 3 THEN 1 ELSE 0 END), 0) AS v3
         FROM guests WHERE hotel_id = ? AND vip_level > 0`,
      [hotelId]
    ) ?? { total: 0, v1: 0, v2: 0, v3: 0 };

  // 会员储值模块暂未启用（未建 members_wallet），统一按 0 展示
  const storedValue = 0;
  const totalSpend = round2(rows.reduce((sum, m) => sum + Number(m.total_spend ?? 0), 0));

  const cards = [
    { label: "会员总数", value: String(st.total), sub: "VIP1 及以上会员", cls: "text-gray-900" },
    { label: "VIP1", value: String(st.v1), sub: "基础会员等级", cls: "text-blue-700" },
    { label: "VIP2", value: String(st.v2), sub: "成长会员等级", cls: "text-amber-700" },
    { label: "VIP3", value: String(st.v3), sub: "最高会员等级", cls: "text-violet-700" },
    { label: "会员储值总额", value: fmtMoney(storedValue), sub: "储值模块未启用", cls: "text-emerald-700" },
  ];

  // ---------------------------------------------------------------------------
  // 消费记录：folio_items 消费明细为主，联 folios（房号/账单号）/ stays（会员、入住单）
  // 支付方式取该账单 payments 的收款方式聚合
  // ---------------------------------------------------------------------------
  const consumptionWhere: string[] = [
    "fi.hotel_id = ?",
    "fi.item_type <> 'DEPOSIT'",
    // 账期：优先业务日期，缺失时回落明细创建日期
    "COALESCE(NULLIF(fi.biz_date, ''), substr(fi.created_at, 1, 10)) >= ?",
    "COALESCE(NULLIF(fi.biz_date, ''), substr(fi.created_at, 1, 10)) <= ?",
  ];
  const consumptionParams: unknown[] = [hotelId, fromDate || "0000-01-01", toDate || "9999-12-31"];

  if (guestFilter > 0) {
    consumptionWhere.push(
      "(s.guest_id = ? OR s.guest_name = (SELECT name FROM guests WHERE id = ? AND hotel_id = ?))"
    );
    consumptionParams.push(guestFilter, guestFilter, hotelId);
  }

  const consumptionFrom = `FROM folio_items fi
      JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
      LEFT JOIN stays s ON s.id = f.stay_id
     WHERE ${consumptionWhere.join(" AND ")}`;

  const consumptionRows = all<ConsumptionRow>(
    `SELECT fi.id, fi.item_type, fi.description, fi.amount,
            COALESCE(NULLIF(fi.biz_date, ''), substr(fi.created_at, 1, 10)) AS biz_date,
            fi.created_at, f.folio_no, f.room_no,
            s.stay_no, COALESCE(s.guest_name, f.guest_name) AS guest_name,
            (SELECT GROUP_CONCAT(DISTINCT p.method)
               FROM payments p
              WHERE p.folio_id = f.id AND p.hotel_id = f.hotel_id) AS methods
       ${consumptionFrom}
       ORDER BY biz_date DESC, fi.id DESC
       LIMIT 300`,
    consumptionParams
  );

  const consumptionStats =
    get<ConsumptionStats>(`SELECT COALESCE(SUM(fi.amount), 0) AS total, COUNT(*) AS cnt ${consumptionFrom}`, consumptionParams) ??
    { total: 0, cnt: 0 };
  const consumptionTotal = round2(Number(consumptionStats.total ?? 0));
  const consumptionCount = Number(consumptionStats.cnt ?? 0);
  const averageTicket = consumptionCount > 0 ? round2(consumptionTotal / consumptionCount) : 0;

  // ---------------------------------------------------------------------------
  // 会员升级：规则读 settings.member_upgrade_rules，待升级清单按生效口径实时计算
  // ---------------------------------------------------------------------------
  const rulesRaw =
    get<{ value: string | null }>(
      `SELECT value FROM settings WHERE hotel_id = ? AND key = ? ORDER BY id DESC LIMIT 1`,
      [hotelId, UPGRADE_RULES_KEY]
    )?.value ?? null;
  const rules = parseUpgradeRules(rulesRaw);
  const ruleSaved = rulesRaw !== null;

  const ruleByLevel = new Map(rules.levels.map((r) => [r.level, r] as const));

  const upgradeCandidates = rows
    .map((m) => {
      const target = targetLevelOf(m, rules);
      return { ...m, target_level: target };
    })
    .filter((m) => m.target_level > m.vip_level)
    .sort((a, b) => Number(b.total_spend ?? 0) - Number(a.total_spend ?? 0));

  // 切 tab 时保留消费记录筛选条件，避免切回来筛选丢失
  const keep = new URLSearchParams();
  if (guestFilter > 0) keep.set("guest", String(guestFilter));
  if (fromDate) keep.set("from", fromDate);
  if (toDate) keep.set("to", toDate);
  if (kw) keep.set("kw", kw);

  function tabHref(key: TabKey) {
    const qs = new URLSearchParams(keep);
    qs.set("tab", key);
    return `/members?${qs.toString()}`;
  }

  const currentHref = tabHref(activeTab);

  /** 本页内部 tab 的菜单项沿用 tabHref，切换时保留搜索 / 日期筛选 */
  const inPageKeys: TabKey[] = ["members", "consumption", "upgrade"];
  const navItems: NavItem[] = NAV_ITEMS.map((item) =>
    inPageKeys.includes(item.key as TabKey) ? { ...item, href: tabHref(item.key as TabKey) } : item
  );

  // 筛选会员直接按 id 取（不限于当前会员列表，取消会员后历史消费仍可查）
  const filterGuest =
    guestFilter > 0
      ? get<{ id: number; name: string; vip_level: number }>(
          `SELECT id, name, vip_level FROM guests WHERE id = ? AND hotel_id = ?`,
          [guestFilter, hotelId]
        )
      : undefined;

  return (
    <div className="flex min-h-full items-stretch">
      {/* ======================= 左侧竖向菜单（去呼呼会员模块） ======================= */}
      <aside className="w-[168px] shrink-0 border-r border-[#e8e8e8] bg-white py-2">
        <nav className="flex flex-col">
          {navItems.map((item) => (
            <NavLink key={item.key} item={item} active={item.key === activeTab} />
          ))}

          {/* 分组「会员卡设置」：<details> 原生可折叠，无需客户端组件 */}
          <details open className="group">
            <summary
              className={`${NAV_BASE_CLS} cursor-pointer list-none select-none justify-between border-l-transparent pl-[13px] text-gray-600 hover:bg-gray-50 hover:text-gray-900 [&::-webkit-details-marker]:hidden`}
            >
              <span>会员卡设置</span>
              <span aria-hidden className="text-[10px] text-gray-400 transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <div className="flex flex-col">
              {CARD_GROUP_ITEMS.map((item) => (
                <NavSubLink key={item.key} item={item} active={false} />
              ))}
            </div>
          </details>
        </nav>
      </aside>

      {/* ======================= 右侧内容区 ======================= */}
      <div className="min-w-0 flex-1 space-y-3 p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-[16px] font-semibold text-gray-900">会员管理</h1>
            <p className="mt-0.5 text-[12px] text-gray-500">
              共 {st.total} 位会员 · 累计消费 <b className="text-gray-800">{fmtMoney(totalSpend)}</b>
              <span className="ml-2 text-[11px] text-gray-400">会员等级基于客史档案</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/guests" className="btn-default px-2.5 py-1 text-[12px]">
              宾客列表
            </Link>
            <Link href="/reports?r=member-overview" className="btn-default px-2.5 py-1 text-[12px]">
              会员报表
            </Link>
          </div>
        </div>

        {msg && (
          <div className="card flex items-start justify-between gap-3 border-l-4 border-l-emerald-500 px-4 py-2.5">
            <span className="text-[12px] text-emerald-700">{msg}</span>
            <Link href={currentHref} className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
              关闭
            </Link>
          </div>
        )}
        {err && (
          <div className="card flex items-start justify-between gap-3 border-l-4 border-l-rose-500 px-4 py-2.5">
            <span className="text-[12px] text-rose-600">{err}</span>
            <Link href={currentHref} className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
              关闭
            </Link>
          </div>
        )}

        {/* ============================ Tab 1 会员列表 ============================ */}
        {activeTab === "members" && (
          <div className="space-y-3">
            {/* 顶部：搜索区（生日筛选 + 输入框 + 查询）+ 右上操作按钮一排 */}
            <div className="card space-y-2 px-3 py-2.5">
              <form method="get" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="tab" value="members" />
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    name="birthdays"
                    min={0}
                    max={365}
                    defaultValue={birthdayDays || ""}
                    placeholder="0"
                    className="input w-[56px] px-1.5 text-center"
                    title="生日筛选：客史档案暂未采集生日字段，此项仅保留界面位"
                  />
                  <span className="whitespace-nowrap text-[13px] text-gray-600">天后生日</span>
                </div>
                <input
                  name="kw"
                  defaultValue={kw}
                  placeholder="姓名 / 手机号码"
                  className="input w-[300px] max-w-full"
                />
                <button className="btn-primary px-3 py-1 text-[12px]">查询</button>
                {(kw || birthdayDays > 0) && (
                  <Link href="/members?tab=members" className="btn-default px-2.5 py-1 text-[12px]">
                    重置
                  </Link>
                )}
                <span className="text-[11px] text-gray-400">
                  共 {st.total} 位会员{kw ? ` · 已按「${kw}」筛选` : ""}
                </span>
              </form>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Link href="/members?tab=members&new=1" className="btn-default px-2.5 py-1 text-[12px]">
                  + 新增会员
                </Link>
                <details className="relative">
                  <summary className="btn-default cursor-pointer list-none px-2.5 py-1 text-[12px] [&::-webkit-details-marker]:hidden">
                    导入
                  </summary>
                  <form
                    action={importMembersAction}
                    className="absolute right-0 z-30 mt-1 flex w-[280px] flex-col gap-1.5 rounded border border-gray-200 bg-white p-2 shadow-lg"
                  >
                    <div className="text-[11px] text-gray-500">
                      选择 CSV 文件（表头：姓名,手机号,会员等级,会员卡号,备注）
                    </div>
                    <input
                      type="file"
                      name="file"
                      accept=".csv,text/csv"
                      required
                      className="text-[12px]"
                    />
                    <button type="submit" className="btn-primary py-1 text-[12px]">
                      开始导入
                    </button>
                  </form>
                </details>
                <a href="/api/members/template" className="btn-default px-2.5 py-1 text-[12px]">
                  导入模版下载
                </a>
                <a href="/api/members/export" className="btn-default px-2.5 py-1 text-[12px]">
                  导出
                </a>
              </div>
            </div>

            {showNewForm && (
              <div className="card">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-gray-800">+ 新增会员</span>
                  <Link href="/members?tab=members" className="text-[11px] text-gray-400 hover:text-gray-600">
                    收起
                  </Link>
                </div>
                <form action={createMemberAction} className="grid gap-3 px-4 py-3 md:grid-cols-5">
                  <div className="md:col-span-2">
                    <label className="label">姓名 *</label>
                    <input name="name" required className="input" placeholder="会员姓名" />
                  </div>
                  <div>
                    <label className="label">手机</label>
                    <input name="mobile" className="input" placeholder="手机号（可空）" />
                  </div>
                  <div>
                    <label className="label">等级</label>
                    <select name="vip_level" className="input" defaultValue="1">
                      <option value="1">VIP1</option>
                      <option value="2">VIP2</option>
                      <option value="3">VIP3</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button className="btn-primary">保存</button>
                  </div>
                </form>
              </div>
            )}

            <div className="card overflow-x-auto">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <span className="text-[13px] font-semibold text-gray-800">会员列表</span>
                <span className="text-[11px] text-gray-400">按等级、累计消费降序</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">姓名</th>
                      <th className="th">手机</th>
                      <th className="th">会员等级</th>
                      <th className="th">会员卡类型</th>
                      <th className="th text-right">累计入住</th>
                      <th className="th text-right">累计消费</th>
                      <th className="th text-right">可消费积分</th>
                      <th className="th text-right">累计积分</th>
                      <th className="th">最近入住</th>
                      <th className="th">生日</th>
                      <th className="th text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={11} className="td py-10 text-center text-gray-400">
                          {kw ? `没有匹配「${kw}」的会员` : "暂无会员，可在上方「+ 新增会员」中录入会员档案"}
                        </td>
                      </tr>
                    )}
                    {rows.map((m) => {
                      const vip = VIP_META[m.vip_level] ?? VIP_META[1];
                      const card = cardTypeOf(m.vip_level);
                      return (
                        <tr key={m.id} className="hover:bg-gray-50">
                          <td className="td font-medium text-gray-800">{m.name}</td>
                          <td className="td text-gray-600">{m.mobile || "—"}</td>
                          <td className="td">
                            <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${vip.cls}`}>
                              {vip.label}
                            </span>
                          </td>
                          <td className="td">
                            {card ? (
                              <span
                                className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${
                                  card.status === "ACTIVE"
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-gray-200 bg-gray-50 text-gray-500"
                                }`}
                                title={`折扣 ${discountText(card.discount)} · ${round2(card.points_ratio)} 分 / 元${
                                  card.status === "ACTIVE" ? "" : " · 已停用"
                                }`}
                              >
                                {card.name}
                              </span>
                            ) : (
                              <span
                                className="text-[11px] text-gray-300"
                                title="尚未维护会员卡类型：会员卡设置 → 会员卡类型设置"
                              >
                                —
                              </span>
                            )}
                          </td>
                          <td className="td text-right tabular-nums text-gray-700">{m.stay_count} 次</td>
                          <td className="td text-right tabular-nums text-gray-900">{fmtMoney(m.total_spend)}</td>
                          <td className="td text-right tabular-nums text-brand-700">
                            {fmtPoints(m.points_balance)}
                          </td>
                          <td className="td text-right tabular-nums text-gray-600">{fmtPoints(m.points_total)}</td>
                          <td className="td text-gray-500">{dayText(m.last_stay)}</td>
                          <td className="td text-gray-400" title="客史档案未采集生日字段">
                            —
                          </td>
                          <td className="td text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Link
                                href={`/members/wallet?guest=${m.id}`}
                                className="text-[12px] text-brand-600 hover:underline"
                              >
                                储值
                              </Link>
                              <Link
                                href={`/members?tab=consumption&guest=${m.id}`}
                                className="text-[12px] text-brand-600 hover:underline"
                              >
                                消费
                              </Link>
                              {m.vip_level < 3 ? (
                                <form action={upgradeMemberAction}>
                                  <input type="hidden" name="id" value={m.id} />
                                  <button className="text-[12px] text-brand-600 hover:underline">
                                    升级 VIP{m.vip_level + 1}
                                  </button>
                                </form>
                              ) : (
                                <span className="text-[11px] text-gray-300">已是最高等级</span>
                              )}
                              <form action={cancelMemberAction}>
                                <input type="hidden" name="id" value={m.id} />
                                <button className="text-[12px] text-rose-600 hover:underline">取消会员</button>
                              </form>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-gray-400">
              升级等级会同步写入 guests.vip_level；取消会员后客史保留，可随时重新加入会员。
              <span className="ml-2">
                会员卡类型取 member_card_types（按折扣降序对应会员等级：VIP1 → 折扣最低卡）；可消费积分为
                score_records 累计余额，累计积分只统计 EARN 流水。
              </span>
            </p>

            {/* 会员概览（保留原统计卡片，置于列表下方，避免打断「搜索 → 表格」结构） */}
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-gray-500">会员概览</div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                {cards.map((c) => (
                  <div key={c.label} className="card p-3">
                    <div className="text-[11px] text-gray-500">{c.label}</div>
                    <div className={`mt-1 text-[18px] font-semibold tabular-nums ${c.cls}`}>{c.value}</div>
                    <div className="mt-0.5 text-[11px] text-gray-400">{c.sub}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ============================ Tab 2 消费记录 ============================ */}
        {activeTab === "consumption" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              <div className="card p-3">
                <div className="text-[11px] text-gray-500">消费总额</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-gray-900">
                  {fmtMoney(consumptionTotal)}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-400">
                  {filterGuest ? `${filterGuest.name} · ` : "全部会员 · "}
                  {fromDate || toDate ? `${fromDate || "最早"} ~ ${toDate || "至今"}` : "不限日期"}
                </div>
              </div>
              <div className="card p-3">
                <div className="text-[11px] text-gray-500">消费笔数</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-blue-700">{consumptionCount}</div>
                <div className="mt-0.5 text-[11px] text-gray-400">押金不计入消费 · 明细最多显示 300 笔</div>
              </div>
              <div className="card p-3">
                <div className="text-[11px] text-gray-500">客单价</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-emerald-700">
                  {fmtMoney(averageTicket)}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-400">消费总额 ÷ 消费笔数</div>
              </div>
            </div>

            <form method="get" className="card flex flex-wrap items-end gap-3 px-4 py-3">
              <input type="hidden" name="tab" value="consumption" />
              <div className="min-w-[180px]">
                <label className="label">会员</label>
                <select name="guest" className="input" defaultValue={guestFilter > 0 ? String(guestFilter) : ""}>
                  <option value="">全部会员</option>
                  {rows.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}（VIP{m.vip_level}）
                      {m.mobile ? ` · ${m.mobile}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">开始日期</label>
                <input type="date" name="from" className="input" defaultValue={fromDate} />
              </div>
              <div>
                <label className="label">结束日期</label>
                <input type="date" name="to" className="input" defaultValue={toDate} />
              </div>
              <div className="flex items-center gap-2">
                <button className="btn-primary">查询</button>
                <Link href="/members?tab=consumption" className="btn-default px-2.5 py-1 text-[12px]">
                  重置
                </Link>
              </div>
              <span className="ml-auto text-[11px] text-gray-400">
                数据来源：folio_items 消费明细 + folios 账单 + payments 收款
              </span>
            </form>

            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <span className="text-[13px] font-semibold text-gray-800">消费明细</span>
                <span className="text-[11px] text-gray-400">
                  按业务日期倒序 · 共 {consumptionCount} 笔
                  {consumptionCount > consumptionRows.length ? ` · 仅显示最近 ${consumptionRows.length} 笔` : ""}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">会员卡号</th>
                      <th className="th">会员姓名</th>
                      <th className="th">账单号</th>
                      <th className="th">房间号</th>
                      <th className="th text-right">消费金额（¥）</th>
                      <th className="th">交易时间</th>
                      <th className="th">备注</th>
                      <th className="th">操作人</th>
                      <th className="th">明细</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consumptionRows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="td py-10 text-center text-gray-400">
                          <span className="text-[#f0a020]">⚠</span> 暂无数据
                        </td>
                      </tr>
                    )}
                    {consumptionRows.map((c) => {
                      const type = itemTypeOf(c.item_type);
                      const pay = payText(c.methods);
                      return (
                        <tr key={c.id} className="hover:bg-gray-50">
                          <td className="td tabular-nums text-gray-600">
                            M{String(c.guest_id ?? 0).padStart(8, "0")}
                          </td>
                          <td className="td font-medium text-gray-800">{c.guest_name || "—"}</td>
                          <td className="td tabular-nums text-gray-600">{c.folio_no ?? "—"}</td>
                          <td className="td text-gray-600">{c.room_no || "—"}</td>
                          <td className="td text-right tabular-nums text-[#e53935]">
                            {Number(c.amount ?? 0).toFixed(2)}
                          </td>
                          <td className="td whitespace-nowrap text-gray-600">
                            {timeText(c.created_at)}
                            <div className="text-[11px] text-gray-400">账期 {dayText(c.biz_date)}</div>
                          </td>
                          <td className="td max-w-[220px] truncate text-gray-500">
                            {c.description || "—"}
                          </td>
                          <td className="td text-gray-600">{c.operator ?? "—"}</td>
                          <td className="td text-gray-500">
                            {type.label} · {pay.text}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-gray-400">
              消费金额取 folio_items.amount（不含 DEPOSIT 押金）；支付方式取该账单 payments 收款方式，多方式合并显示为「混合」。
            </p>
          </div>
        )}

        {/* ============================ Tab 3 会员升级 ============================ */}
        {activeTab === "upgrade" && (
          <div className="space-y-3">
            <div className="card overflow-x-auto">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
                <span className="text-[13px] font-semibold text-gray-800">当前生效规则</span>
                <span className="text-[11px] text-gray-400">
                  存储于 settings.{UPGRADE_RULES_KEY} ·{" "}
                  {ruleSaved ? "已自定义" : "未配置，显示默认规则"}
                </span>
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">会员等级</th>
                    <th className="th">升级条件（累计消费金额 / 入住次数）</th>
                    <th className="th">折扣</th>
                    <th className="th text-right">积分比例</th>
                    <th className="th">当前会员数</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.levels.map((lv) => {
                    const meta = VIP_META[lv.level] ?? VIP_META[1];
                    const count = lv.level === 1 ? st.v1 : lv.level === 2 ? st.v2 : st.v3;
                    const spendActive = rules.basis === "spend";
                    return (
                      <tr key={lv.level} className="hover:bg-gray-50">
                        <td className="td">
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="td text-gray-600">
                          <span className={spendActive ? "font-medium text-gray-900" : ""}>
                            累计消费 ≥ {fmtMoney(lv.minSpend)}
                          </span>
                          <span className="mx-1 text-gray-300">/</span>
                          <span className={!spendActive ? "font-medium text-gray-900" : ""}>
                            入住 ≥ {lv.minStays} 次
                          </span>
                        </td>
                        <td className="td text-gray-700">{discountText(lv.discount)}</td>
                        <td className="td text-right tabular-nums text-gray-700">
                          {round2(lv.pointsRate)} 分 / 元
                        </td>
                        <td className="td text-gray-600">{count} 位</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
                当前判定口径：
                <b className="text-gray-700">{rules.basis === "spend" ? "累计消费金额" : "入住次数"}</b>
                （表中加粗的条件即生效口径）
              </div>
            </div>

            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <span className="text-[13px] font-semibold text-gray-800">规则配置</span>
                <span className="text-[11px] text-gray-400">修改后点击保存，写入 settings 表</span>
              </div>
              <form action={saveUpgradeRulesAction} className="space-y-3 px-4 py-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="label">升级判定口径</label>
                    <select name="basis" className="input" defaultValue={rules.basis}>
                      <option value="spend">累计消费金额</option>
                      <option value="stays">入住次数</option>
                    </select>
                  </div>
                  <span className="pb-1.5 text-[11px] text-gray-400">
                    选择「累计消费金额」时按门槛金额判定，选择「入住次数」时按入住次数判定
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="th">等级</th>
                        <th className="th">累计消费金额门槛（元）</th>
                        <th className="th">入住次数门槛（次）</th>
                        <th className="th">折扣（%，95 即 9.5 折）</th>
                        <th className="th">积分比例（分 / 元）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.levels.map((lv) => (
                        <tr key={lv.level}>
                          <td className="td">
                            <span
                              className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${
                                (VIP_META[lv.level] ?? VIP_META[1]).cls
                              }`}
                            >
                              {(VIP_META[lv.level] ?? VIP_META[1]).label}
                            </span>
                          </td>
                          <td className="td">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              name={`minSpend_${lv.level}`}
                              defaultValue={lv.minSpend}
                              className="input"
                            />
                          </td>
                          <td className="td">
                            <input
                              type="number"
                              min={0}
                              step="1"
                              name={`minStays_${lv.level}`}
                              defaultValue={lv.minStays}
                              className="input"
                            />
                          </td>
                          <td className="td">
                            <input
                              type="number"
                              min={10}
                              max={100}
                              step="0.5"
                              name={`discount_${lv.level}`}
                              defaultValue={round2(lv.discount * 100)}
                              className="input"
                            />
                          </td>
                          <td className="td">
                            <input
                              type="number"
                              min={0}
                              max={10}
                              step="0.1"
                              name={`pointsRate_${lv.level}`}
                              defaultValue={lv.pointsRate}
                              className="input"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn-primary">保存规则</button>
                  <span className="text-[11px] text-gray-400">
                    高等级门槛不得低于低等级；积分比例与折扣仅作会员权益展示，不改变账单金额。
                  </span>
                </div>
              </form>
            </div>

            <div className="card overflow-x-auto">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
                <span className="text-[13px] font-semibold text-gray-800">待升级会员</span>
                <span className="text-[11px] text-gray-400">
                  累计消费 / 入住次数已达下一等级门槛但等级未升级 · 共 {upgradeCandidates.length} 位
                </span>
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th w-8"></th>
                    <th className="th">姓名</th>
                    <th className="th">卡号</th>
                    <th className="th">当前卡类型</th>
                    <th className="th">目标卡类型</th>
                    <th className="th">最高可升级卡类型</th>
                    <th className="th text-right">累计积分</th>
                    <th className="th">创建时间</th>
                    <th className="th text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {upgradeCandidates.length === 0 && (
                    <tr>
                      <td colSpan={9} className="td py-10 text-center text-gray-400">
                        {rows.length === 0
                          ? "暂无会员，请先在「会员列表」中建档"
                          : "当前没有达到升级门槛的会员"}
                      </td>
                    </tr>
                  )}
                  {upgradeCandidates.map((m) => {
                    const cur = VIP_META[m.vip_level] ?? VIP_META[1];
                    const next = VIP_META[m.target_level] ?? VIP_META[3];
                    const nextRule = ruleByLevel.get(m.target_level);
                    const gapSpend = nextRule ? round2(nextRule.minSpend - Number(m.total_spend ?? 0)) : 0;
                    const gapStays = nextRule ? nextRule.minStays - Number(m.stay_count ?? 0) : 0;
                    return (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="td">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-[#32c141]" />
                        </td>
                        <td className="td font-medium text-gray-800">{m.name}</td>
                        <td className="td tabular-nums text-gray-600">
                          M{String(m.id).padStart(8, "0")}
                        </td>
                        <td className="td">
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${cur.cls}`}>
                            {cur.label}
                          </span>
                        </td>
                        <td className="td">
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${next.cls}`}>
                            {next.label}
                          </span>
                        </td>
                        <td className="td text-gray-600">{VIP_META[3]?.label ?? "VIP3"}</td>
                        <td className="td text-right tabular-nums text-gray-700">
                          {Number(m.total_spend ?? 0).toFixed(0)}
                        </td>
                        <td className="td whitespace-nowrap text-[11.5px] text-gray-500">
                          {m.stay_count ?? 0} 次入住
                        </td>
                        <td className="td text-right">
                          <form action={applyUpgradeAction} className="inline-block">
                            <input type="hidden" name="guest_id" value={m.id} />
                            <input type="hidden" name="target_level" value={m.target_level} />
                            <button className="btn-primary px-2 py-0.5 text-[12px]">升级</button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
                点击「升级」会真实更新 guests.vip_level 并写入 op_logs，刷新后会员列表等级随之变化。
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
