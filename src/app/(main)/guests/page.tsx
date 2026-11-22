import Link from "next/link";
import { ArchiveSidebar } from "@/components/ArchiveSidebar";
import { RowActionMenu } from "@/components/RowActionMenu";
import type { ReactNode } from "react";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, fmtMoney, todayStr } from "@/lib/utils";
import { createGuestAction, deleteGuestAction, freeUpgradeVip1Action } from "./actions";
import ConfirmForm from "@/components/ConfirmForm";

export const dynamic = "force-dynamic";

/** 订单视角列表每页 30 条（对齐去呼呼「宾客列表」） */
const PAGE_SIZE = 30;
/** 客人档案每页 30 条 */
const PROFILE_PAGE_SIZE = 30;

/* ========================================================== 左侧菜单定义 */

type TabKey =
  | "pre-arrive"
  | "arrived"
  | "pre-leave"
  | "yesterday-noshow"
  | "all"
  | "booked"
  | "inhouse"
  | "unassigned"
  | "tomorrow"
  | "left-today"
  | "ledger"
  | "team"
  | "channel"
  | "old-left";

type TabGroup = "todo" | "status";

type TabDef = { key: TabKey; label: string; group: TabGroup };

/** 左侧菜单：今日待办 + 状态 */
const TAB_DEFS: TabDef[] = [
  { key: "pre-arrive", label: "今日预抵", group: "todo" },
  { key: "arrived", label: "今日到达", group: "todo" },
  { key: "pre-leave", label: "今日预离", group: "todo" },
  { key: "yesterday-noshow", label: "昨日未到", group: "todo" },
  { key: "all", label: "全部", group: "status" },
  { key: "booked", label: "所有预订", group: "status" },
  { key: "inhouse", label: "当前在住", group: "status" },
  { key: "unassigned", label: "待排房", group: "status" },
  { key: "tomorrow", label: "明日预抵", group: "status" },
  { key: "left-today", label: "今日已离", group: "status" },
  { key: "ledger", label: "挂账客人", group: "status" },
  { key: "team", label: "当前团队", group: "status" },
  { key: "channel", label: "渠道订单", group: "status" },
];

/** 「一年前离店订单查询」是隐藏 tab，菜单里不出现 */
const HIDDEN_TABS: TabDef[] = [{ key: "old-left", label: "一年前离店", group: "status" }];

const ALL_TABS: TabDef[] = [...TAB_DEFS, ...HIDDEN_TABS];
const ALL_TAB_KEYS: TabKey[] = ALL_TABS.map((t) => t.key);
const TODO_TABS: TabDef[] = TAB_DEFS.filter((t) => t.group === "todo");
const STATUS_TABS: TabDef[] = TAB_DEFS.filter((t) => t.group === "status");
const DEFAULT_TAB: TabKey = "inhouse";

/** 菜单以外的档案视图 key（左侧菜单第三项） */
const PROFILE_VIEW = "profile";

/* ==================================================== 统一订单视图（SQL） */

/**
 * stays + bookings 统一成「订单」：
 * · stays  INHOUSE     → 现住
 * · stays  CHECKED_OUT → 已离（今日已离 / 一年前离店 / 余额都靠它）
 * · bookings PENDING / CONFIRMED → 待排房 / 预订
 * 日期统一折算成北京时间的 YYYY-MM-DD（stays.check_in_time 存 UTC ISO，
 * expect_check_out / actual_check_out 存纯日期），后续所有筛选与排序都用 in_date / out_date。
 */
const UNIFIED_SQL = `
  WITH u AS (
    SELECT 'stay' AS kind,
           s.id AS row_id,
           s.status AS status_key,
           s.channel_id AS channel_id,
           COALESCE(c.channel_type, '') AS channel_type,
           COALESCE(c.name, '散客') AS channel_name,
           COALESCE(NULLIF(TRIM(COALESCE(s.stay_no, '')), ''), 'SI' || s.id) AS order_no,
           COALESCE(s.guest_name, '') AS booker_name,
           COALESCE(s.mobile, '') AS booker_mobile,
           COALESCE(s.guest_name, '') AS guest_name,
           COALESCE(s.mobile, '') AS guest_mobile,
           s.guest_id AS guest_id,
           CASE WHEN TRIM(COALESCE(s.team_name, '')) <> '' THEN '团队房' ELSE '日租房' END AS stay_type,
           COALESCE(r.room_type_id, 0) AS room_type_id,
           COALESCE(rt.name, '未分房型') AS room_type_name,
           COALESCE(r.room_no, '') AS room_no,
           COALESCE(s.rate, 0) AS rate,
           1 AS room_count,
           (SELECT COUNT(*) FROM stays s2
             WHERE s2.hotel_id = s.hotel_id
               AND s.booking_id IS NOT NULL
               AND s2.booking_id = s.booking_id) AS linked_rooms,
           date(s.check_in_time, '+8 hours') AS in_date,
           COALESCE(
             date(NULLIF(TRIM(COALESCE(s.actual_check_out, '')), ''), '+8 hours'),
             date(NULLIF(TRIM(COALESCE(s.expect_check_out, '')), ''), '+8 hours')
           ) AS out_date,
           COALESCE(date(NULLIF(TRIM(COALESCE(s.actual_check_out, '')), ''), '+8 hours'), '') AS out_actual_date,
           COALESCE(s.check_in_time, '') AS check_in_raw,
           COALESCE(s.expect_check_out, '') AS check_out_raw,
           COALESCE(
             (SELECT f.balance FROM folios f
               WHERE f.hotel_id = s.hotel_id AND f.stay_id = s.id
               ORDER BY f.id DESC LIMIT 1),
             0
           ) AS balance,
           COALESCE(NULLIF(TRIM(COALESCE(s.invoice_party, '')), ''), '酒店') AS invoice_party,
           TRIM(COALESCE(s.team_name, '')) AS team_name,
           '' AS company_name,
           s.id AS stay_id,
           s.booking_id AS booking_id,
           COALESCE(s.remark, '') AS remark,
           COALESCE(s.breakfast, 0) AS breakfast,
           COALESCE(s.pay_type, '') AS pay_type
      FROM stays s
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      LEFT JOIN channels c ON c.id = s.channel_id
     WHERE s.hotel_id = ? AND s.status IN ('INHOUSE', 'CHECKED_OUT')

    UNION ALL

    SELECT 'booking' AS kind,
           b.id AS row_id,
           b.status AS status_key,
           b.channel_id AS channel_id,
           COALESCE(c.channel_type, '') AS channel_type,
           COALESCE(c.name, '散客') AS channel_name,
           COALESCE(NULLIF(TRIM(COALESCE(b.channel_order_no, '')), ''), b.booking_no, 'BK' || b.id) AS order_no,
           COALESCE(b.guest_name, '') AS booker_name,
           COALESCE(b.mobile, '') AS booker_mobile,
           COALESCE(b.guest_name, '') AS guest_name,
           COALESCE(b.mobile, '') AS guest_mobile,
           b.guest_id AS guest_id,
           CASE WHEN TRIM(COALESCE(b.team_name, '')) <> '' THEN '团队房' ELSE '日租房' END AS stay_type,
           COALESCE(b.room_type_id, 0) AS room_type_id,
           COALESCE(rt.name, '未分房型') AS room_type_name,
           COALESCE(r.room_no, '') AS room_no,
           COALESCE(b.rate, 0) AS rate,
           MAX(COALESCE(b.room_count, 1), 1) AS room_count,
           MAX(COALESCE(b.room_count, 1), 1) AS linked_rooms,
           date(b.check_in_date) AS in_date,
           date(b.check_out_date) AS out_date,
           '' AS out_actual_date,
           COALESCE(b.check_in_date, '') AS check_in_raw,
           COALESCE(b.check_out_date, '') AS check_out_raw,
           0 AS balance,
           COALESCE(NULLIF(TRIM(COALESCE(b.invoice_party, '')), ''), '酒店') AS invoice_party,
           TRIM(COALESCE(b.team_name, '')) AS team_name,
           COALESCE(cp.name, '') AS company_name,
           NULL AS stay_id,
           b.id AS booking_id,
           COALESCE(b.remark, '') AS remark,
           COALESCE(b.breakfast, 0) AS breakfast,
           COALESCE(b.pay_type, '') AS pay_type
      FROM bookings b
      LEFT JOIN room_types rt ON rt.id = b.room_type_id
      LEFT JOIN rooms r ON r.id = b.room_id
      LEFT JOIN channels c ON c.id = b.channel_id
      LEFT JOIN companies cp ON cp.id = b.company_id
     WHERE b.hotel_id = ? AND b.status IN ('PENDING', 'CONFIRMED')
  )
`;

type TabCtx = { today: string; yesterday: string; tomorrow: string; yearAgo: string };

/**
 * 每个 tab 的 SQL 判定条件（计数与列表共用的唯一真相来源）。
 * 只有服务端生成的日期字面量会被拼进 SQL，关键词一律走参数绑定。
 */
const TAB_SQL: Record<TabKey, (c: TabCtx) => string> = {
  all: () => "1 = 1",
  booked: () => "kind = 'booking'",
  inhouse: () => "kind = 'stay' AND status_key = 'INHOUSE'",
  /** 待排房 = 待排房预订 + 已确认但还没排房的预订 */
  unassigned: () =>
    "kind = 'booking' AND (status_key = 'PENDING' OR (status_key = 'CONFIRMED' AND room_no = ''))",
  "pre-arrive": (c) =>
    `kind = 'booking' AND in_date = '${c.today}' AND status_key IN ('PENDING', 'CONFIRMED')`,
  arrived: (c) => `kind = 'stay' AND in_date = '${c.today}'`,
  "pre-leave": (c) => `kind = 'stay' AND status_key = 'INHOUSE' AND out_date = '${c.today}'`,
  "yesterday-noshow": (c) =>
    `kind = 'booking' AND in_date = '${c.yesterday}' AND status_key IN ('PENDING', 'CONFIRMED', 'NOSHOW')`,
  tomorrow: (c) =>
    `kind = 'booking' AND in_date = '${c.tomorrow}' AND status_key IN ('PENDING', 'CONFIRMED')`,
  "left-today": (c) => `kind = 'stay' AND out_actual_date = '${c.today}'`,
  ledger: () => "balance > 0.009",
  team: () => "team_name <> ''",
  channel: () => "kind = 'booking' AND COALESCE(channel_type, '') NOT IN ('', 'direct')",
  "old-left": (c) => `kind = 'stay' AND out_actual_date <> '' AND out_actual_date < '${c.yearAgo}'`,
};

/** 快速查询：姓名 / 手机 / 房号 / 房型 / 协议公司 / 团队 / 订单号（全部走 LIKE 参数） */
const SEARCH_SQL = `(guest_name LIKE ? OR booker_name LIKE ? OR booker_mobile LIKE ? OR guest_mobile LIKE ?
   OR room_no LIKE ? OR room_type_name LIKE ? OR company_name LIKE ? OR team_name LIKE ? OR order_no LIKE ?)`;
const SEARCH_PARAM_COUNT = 9;

const countAlias = (key: TabKey) => `n_${key.replace(/-/g, "_")}`;

/* ================================================================ 类型 */

/** 统一视图的原始行 */
type RawRow = {
  kind: string;
  row_id: number;
  status_key: string | null;
  channel_id: number | null;
  channel_type: string | null;
  channel_name: string | null;
  order_no: string | null;
  booker_name: string | null;
  booker_mobile: string | null;
  guest_name: string | null;
  guest_mobile: string | null;
  guest_id: number | null;
  stay_type: string | null;
  room_type_id: number | null;
  room_type_name: string | null;
  room_no: string | null;
  rate: number | null;
  room_count: number | null;
  linked_rooms: number | null;
  in_date: string | null;
  out_date: string | null;
  out_actual_date: string | null;
  check_in_raw: string | null;
  check_out_raw: string | null;
  balance: number | null;
  invoice_party: string | null;
  team_name: string | null;
  company_name: string | null;
  stay_id: number | null;
  booking_id: number | null;
  remark: string | null;
  breakfast: number | null;
  pay_type: string | null;
};

/** 表格一行（已脱敏、已格式化） */
type OrderRow = {
  key: string;
  kind: "stay" | "booking";
  id: number;
  statusKey: string;
  statusLabel: string;
  statusCls: string;
  channelName: string;
  orderNo: string;
  bookerName: string;
  bookerMobile: string;
  guestName: string;
  guestMobile: string;
  guestArchiveId: number | null;
  guestVipLevel: number;
  stayType: string;
  roomTypeId: number | null;
  roomTypeName: string;
  roomNo: string;
  rate: number;
  roomCount: number;
  linkedRooms: number;
  inDate: string;
  outDate: string;
  checkInDisplay: string;
  checkOutDisplay: string;
  balance: number;
  invoiceParty: string;
  stayId: number | null;
  bookingId: number | null;
};

/** 客人档案（订单行按姓名回查，用于「删除客人 / 免费升级」） */
type GuestLite = { id: number; name: string; vip_level: number | null };

/** 档案视图一行 */
type GuestRow = {
  id: number;
  name: string;
  gender: string | null;
  mobile: string | null;
  id_type: string | null;
  id_no: string | null;
  company: string | null;
  vip_level: number;
  blacklist: number;
  note: string | null;
  created_at: string | null;
  deleted: number | null;
  stay_count: number;
  last_stay: string | null;
  total_revenue: number;
};

/** 统一视图的筛选状态（拼 URL 用） */
type OrderFilters = {
  tab: TabKey;
  q: string;
  channel: string;
  roomType: string;
  from: string;
  to: string;
  advanced: boolean;
  page: number;
};

const EMPTY_FILTERS: OrderFilters = {
  tab: DEFAULT_TAB,
  q: "",
  channel: "",
  roomType: "",
  from: "",
  to: "",
  advanced: false,
  page: 1,
};

type SearchParamsMap = Record<string, string | string[] | undefined>;
type GuestsPageProps = { searchParams: Promise<SearchParamsMap> };

/* ============================================================== 小工具 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 纯日期（ISO 时间按本地时区折算，纯日期原样截取） */
function localDate(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  if (v.length > 10 && v.includes("T")) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
  }
  return v.slice(0, 10);
}

/** 「YYYY-MM-DD HH:mm」：入住时间取真实入住时刻，纯日期补酒店入住/离店时间 */
function localDateTime(raw: string | null | undefined, fallbackTime: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  if (v.length > 10 && v.includes("T")) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
        d.getHours()
      )}:${pad2(d.getMinutes())}`;
    }
  }
  return `${v.slice(0, 10)} ${fallbackTime}`;
}

/** 手机号脱敏：138****1234（与去呼呼一致，中间四位打码） */
function maskMobile(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  if (s.length <= 4) return s;
  if (s.length < 8) return `${s.slice(0, 2)}****${s.slice(-2)}`;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function pickRaw(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function isValidDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** 给已有 URL 追加参数（用于 &export=1） */
function addParam(href: string, kv: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}${kv}`;
}

function orderHref(f: OrderFilters, patch: Partial<OrderFilters> = {}): string {
  const n: OrderFilters = { ...f, ...patch };
  const p = new URLSearchParams();
  if (n.tab !== DEFAULT_TAB) p.set("tab", n.tab);
  if (n.q) p.set("q", n.q);
  if (n.channel) p.set("channel", n.channel);
  if (n.roomType) p.set("roomType", n.roomType);
  if (n.from) p.set("from", n.from);
  if (n.to) p.set("to", n.to);
  if (n.advanced) p.set("advanced", "1");
  if (n.page > 1) p.set("page", String(n.page));
  const qs = p.toString();
  return qs ? `/guests?${qs}` : "/guests";
}

type ProfileFilters = { q: string; vip: boolean; deleted: boolean; page: number };

function profileHref(f: ProfileFilters, patch: Partial<ProfileFilters> = {}): string {
  const n: ProfileFilters = { ...f, ...patch };
  const p = new URLSearchParams();
  p.set("view", PROFILE_VIEW);
  if (n.q) p.set("q", n.q);
  if (n.vip) p.set("vip", "1");
  if (n.deleted) p.set("deleted", "1");
  if (n.page > 1) p.set("page", String(n.page));
  return `/guests?${p.toString()}`;
}

/* ================================================================ 视觉 */

/** 表头：淡绿底 12px（对齐去呼呼列表头） */
const TH =
  "whitespace-nowrap border-b border-[#d9ead9] bg-[#e8f5e9] px-3 py-2 text-left text-[12px] font-normal text-[#333]";

/** 单元格：两行/三行内容，行高随内容自适应 */
const TD = "border-t border-[#eee] px-3 py-[5px] align-middle text-[12px] leading-[17px]";

/** 极小内联箭头，避免小字号下三角字符渲染成圆点 */
function Chevron({ up = false, className = "" }: { up?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path
        d={up ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 联房图标 */
function LinkedIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect x="1" y="1" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="7" y="1" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="1" y="7" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="7" y="7" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** 订单状态标签（现住绿 / 待排房橙 / 已离灰） */
const ORDER_STATUS: Record<string, { label: string; text: string }> = {
  INHOUSE: { label: "现住", text: "text-[#32c141]" },
  CHECKED_OUT: { label: "已离", text: "text-[#8a949e]" },
  PENDING: { label: "待排房", text: "text-[#b07d2e]" },
  CONFIRMED: { label: "已确认", text: "text-[#2f6fed]" },
  CHECKED_IN: { label: "已入住", text: "text-[#32c141]" },
  CANCELLED: { label: "已取消", text: "text-[#8a949e]" },
  NOSHOW: { label: "未到", text: "text-[#e23b3b]" },
};

/* ------------------------------------------------- 纯 HTML 下拉（无需 JS） */

const MENU_ITEM_CLS =
  "block w-full cursor-pointer px-3 py-[6px] text-left text-[12px] text-[#3f4a54] hover:bg-[#f2f8f4] hover:text-[#32c141]";

/** 「操作 ▾」下拉：portal 浮层，避免被表格滚动容器裁切 */

function MenuLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={MENU_ITEM_CLS}
    >
      {children}
    </Link>
  );
}

function MenuDisabled({ children, reason }: { children: ReactNode; reason: string }) {
  return (
    <span
      title={reason}
      className="flex cursor-not-allowed items-center justify-between gap-2 px-3 py-[6px] text-[12px] text-[#d3d8dd]"
    >
      <span>{children}</span>
      <span className="shrink-0 text-[10px] text-[#b3bcc5]">{reason}</span>
    </span>
  );
}

const MENU_BUTTON_CLS =
  "w-full cursor-pointer px-3 py-[6px] text-left text-[12px] text-[#3f4a54] hover:bg-[#f2f8f4] hover:text-[#32c141]";
const MENU_DANGER_CLS =
  "w-full cursor-pointer px-3 py-[6px] text-left text-[12px] text-[#e23b3b] hover:bg-[#fdf3f3]";

/* ============================================================ 侧边菜单 */

function SidebarItem({
  label,
  count,
  href,
  active,
}: {
  label: string;
  count: number;
  href: string;
  active: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center justify-between border-l-[3px] py-[6px] pl-3 pr-2 text-[13px] leading-[18px] transition-colors ${
          active
            ? "border-[#32c141] bg-[#eef9f0] font-medium text-[#2a9d5c]"
            : "border-transparent text-[#5f6b76] hover:bg-[#f7f9f8] hover:text-[#1f2937]"
        }`}
      >
        <span className="truncate">{label}</span>
        <span
          className={`ml-2 shrink-0 text-[11px] tabular-nums ${
            active ? "text-[#7d8a95]" : "text-[#9aa4ae]"
          }`}
        >
          {count}
        </span>
      </Link>
    </li>
  );
}

function Sidebar({
  counts,
  activeTab,
  hrefForTab,
  profileHrefValue,
  profileActive,
  profileCount,
}: {
  counts: Record<TabKey, number>;
  activeTab: TabKey | null;
  hrefForTab: (key: TabKey) => string;
  profileHrefValue: string;
  profileActive: boolean;
  profileCount: number;
}) {
  const item = (t: TabDef) => (
    <SidebarItem
      key={t.key}
      label={t.label}
      count={counts[t.key] ?? 0}
      href={hrefForTab(t.key)}
      active={activeTab === t.key}
    />
  );

  return (
    <aside className="sticky top-0 w-[168px] shrink-0 self-stretch border-r border-[#eef0f2] bg-white pb-6">
      <p className="px-3 pb-1 pt-3 text-[12px] font-medium tracking-wide text-[#9aa4ae]">今日待办</p>
      <ul>{TODO_TABS.map(item)}</ul>

      <p className="px-3 pb-1 pt-4 text-[12px] font-medium tracking-wide text-[#9aa4ae]">状态</p>
      <ul>{STATUS_TABS.map(item)}</ul>

      <p className="px-3 pb-1 pt-4 text-[12px] font-medium tracking-wide text-[#9aa4ae]">档案</p>
      <ul>
        <SidebarItem
          label="客人档案"
          count={profileCount}
          href={profileHrefValue}
          active={profileActive}
        />
      </ul>
    </aside>
  );
}

/* ============================================================ 数据加载 */

/** 左侧全部计数：一条聚合 SQL，全部真实 COUNT */
function loadCounts(hotelId: number, ctx: TabCtx): Record<TabKey, number> {
  const sql = `${UNIFIED_SQL}
    SELECT COUNT(*) AS total,
           ${ALL_TAB_KEYS.map(
             (key) => `COALESCE(SUM(CASE WHEN ${TAB_SQL[key](ctx)} THEN 1 ELSE 0 END), 0) AS ${countAlias(key)}`
           ).join(",\n           ")}
      FROM u`;
  const row = get<Record<string, number | null>>(sql, [hotelId, hotelId]) ?? {};
  const counts = {} as Record<TabKey, number>;
  for (const key of ALL_TAB_KEYS) counts[key] = Number(row[countAlias(key)] ?? 0);
  counts.all = Number(row.total ?? 0);
  return counts;
}

/** 统一视图 → 表格行（脱敏 + 时间格式化 + 回查客人档案） */
function toOrderRow(
  u: RawRow,
  checkInTime: string,
  checkOutTime: string,
  guestByName: Map<string, GuestLite>
): OrderRow {
  const kind: "stay" | "booking" = u.kind === "stay" ? "stay" : "booking";
  const statusKey = u.status_key ?? "";
  const style = ORDER_STATUS[statusKey];
  const inDate = localDate(u.in_date ?? u.check_in_raw);
  const outDate = localDate(u.out_date ?? u.check_out_raw);
  const guestName = (u.guest_name ?? "").trim() || (u.booker_name ?? "").trim() || "—";
  const bookerName = (u.booker_name ?? "").trim() || guestName;
  const mobileRaw = (u.guest_mobile ?? "").trim() || (u.booker_mobile ?? "").trim();
  const guestMobile = maskMobile(mobileRaw);
  const archive = guestByName.get(guestName);

  const checkInDisplay =
    kind === "stay"
      ? localDateTime(u.check_in_raw, checkInTime)
      : `${inDate} ${checkInTime}`.trim();
  const checkOutDisplay = outDate ? `${outDate} ${checkOutTime}` : "";

  return {
    key: `${kind}-${u.row_id}`,
    kind,
    id: Number(u.row_id),
    statusKey,
    statusLabel: style ? style.label : statusKey || "—",
    statusCls: style ? style.text : "text-[#8a949e]",
    channelName: u.channel_name ?? "散客",
    orderNo: u.order_no ?? "—",
    bookerName,
    bookerMobile: guestMobile,
    guestName,
    guestMobile,
    guestArchiveId: archive ? archive.id : null,
    guestVipLevel: Number(archive?.vip_level ?? 0),
    stayType: u.stay_type ?? "日租房",
    roomTypeId: u.room_type_id ?? null,
    roomTypeName: u.room_type_name ?? "未分房型",
    roomNo: (u.room_no ?? "").trim(),
    rate: Number(u.rate ?? 0),
    roomCount: Math.max(1, Number(u.room_count ?? 1)),
    linkedRooms: Math.max(1, Number(u.linked_rooms ?? 1)),
    inDate,
    outDate,
    checkInDisplay: checkInDisplay || "—",
    checkOutDisplay: checkOutDisplay || "未定",
    balance: Number(u.balance ?? 0),
    invoiceParty: u.invoice_party ?? "酒店",
    stayId: u.stay_id ?? null,
    bookingId: u.booking_id ?? null,
  };
}

/* ================================================================ CSV 导出 */

const CSV_HEADERS = [
  "订单状态",
  "渠道",
  "渠道订单号",
  "预订人",
  "预订人手机",
  "客人",
  "客人手机",
  "入住类型",
  "房型",
  "房号",
  "房价",
  "间数",
  "入住时间",
  "离店时间",
  "余额",
  "开票方",
];

function toCsv(rows: OrderRow[]): string {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const lines: string[] = [CSV_HEADERS.map(esc).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.statusLabel,
        r.channelName,
        r.orderNo,
        r.bookerName,
        r.bookerMobile,
        r.guestName,
        r.guestMobile,
        r.stayType,
        r.roomTypeName,
        r.roomNo || "未排房",
        r.rate.toFixed(2),
        String(r.roomCount),
        r.checkInDisplay,
        r.checkOutDisplay,
        r.balance.toFixed(2),
        r.invoiceParty,
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

/* ================================================================ 页面 */

export default async function GuestsPage({ searchParams }: GuestsPageProps) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  const today = todayStr();
  const ctx: TabCtx = {
    today,
    yesterday: todayStr(addDays(today, -1)),
    tomorrow: todayStr(addDays(today, 1)),
    yearAgo: todayStr(addDays(today, -365)),
  };

  /* 左侧计数（两种视图共用真实 COUNT） */
  const counts = loadCounts(hotelId, ctx);

  const profileCount =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM guests WHERE hotel_id = ? AND COALESCE(deleted, 0) = 0`,
      [hotelId]
    )?.n ?? 0;

  const isProfile = pickRaw(sp.view) === PROFILE_VIEW;

  /* ------------------------------------------------- 客人档案视图 */
  if (isProfile) {
    const q = pickRaw(sp.q).trim();
    const vipOnly = pickRaw(sp.vip) === "1";
    const showDeleted = pickRaw(sp.deleted) === "1";
    const msg = pickRaw(sp.msg);
    const err = pickRaw(sp.err);
    const rawPage = Number.parseInt(pickRaw(sp.page), 10);
    const filters: ProfileFilters = {
      q,
      vip: vipOnly,
      deleted: showDeleted,
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    };

    const conditions = [
      "g.hotel_id = ?",
      showDeleted ? "COALESCE(g.deleted, 0) = 1" : "COALESCE(g.deleted, 0) = 0",
    ];
    const params: unknown[] = [hotelId];
    if (q) {
      conditions.push("(g.name LIKE ? OR g.mobile LIKE ? OR g.id_no LIKE ? OR g.company LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (vipOnly) conditions.push("g.vip_level > 0");
    const whereSql = conditions.join(" AND ");

    const profileTotal =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM guests g WHERE ${whereSql}`, params)?.n ?? 0;
    const profilePages = Math.max(1, Math.ceil(profileTotal / PROFILE_PAGE_SIZE));
    const profilePage = Math.min(filters.page, profilePages);
    const state: ProfileFilters = { ...filters, page: profilePage };

    const rows = all<GuestRow>(
      `SELECT g.*,
         (SELECT COUNT(*) FROM stays s WHERE s.guest_id = g.id) AS stay_count,
         (SELECT MAX(s.check_in_time) FROM stays s WHERE s.guest_id = g.id) AS last_stay,
         (SELECT COALESCE(SUM(fi.amount), 0) FROM folio_items fi JOIN folios f ON f.id = fi.folio_id
            JOIN stays s ON s.id = f.stay_id WHERE s.guest_id = g.id AND fi.item_type != 'DEPOSIT') AS total_revenue
       FROM guests g
       WHERE ${whereSql}
       ORDER BY g.vip_level DESC, g.id DESC
       LIMIT ? OFFSET ?`,
      [...params, PROFILE_PAGE_SIZE, (profilePage - 1) * PROFILE_PAGE_SIZE]
    );

    const stats =
      get<{ total: number; vip: number; black: number }>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN vip_level > 0 THEN 1 ELSE 0 END), 0) AS vip,
                COALESCE(SUM(CASE WHEN blacklist = 1 THEN 1 ELSE 0 END), 0) AS black
           FROM guests WHERE hotel_id = ? AND COALESCE(deleted, 0) = 0`,
        [hotelId]
      ) ?? { total: 0, vip: 0, black: 0 };

    const deletedCount =
      get<{ n: number }>(
        `SELECT COALESCE(SUM(CASE WHEN COALESCE(deleted, 0) = 1 THEN 1 ELSE 0 END), 0) AS n
           FROM guests WHERE hotel_id = ?`,
        [hotelId]
      )?.n ?? 0;

    /* 操作后回跳本页（保留筛选与分页） */
    const backPath = profileHref(state);

    const pageNumbers: number[] = [];
    const pageStart = Math.max(1, Math.min(profilePage - 2, profilePages - 4));
    const pageEnd = Math.min(profilePages, pageStart + 4);
    for (let i = pageStart; i <= pageEnd; i += 1) pageNumbers.push(i);

    return (
      <div className="flex min-h-full items-start bg-[#f7f8fa]">
        <ArchiveSidebar active="客人档案" />

        <div className="min-w-0 flex-1 space-y-3 p-3">
          <div className="rounded-[2px] border border-[#e5e7eb] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eee] px-3 py-2.5">
              <div>
                <h1 className="text-[14px] font-bold text-[#1f2937]">
                  {showDeleted ? "客人档案 · 回收站" : "客人档案"}
                </h1>
                <p className="mt-0.5 text-[11px] text-[#9aa4ae]">
                  共 {stats.total} 位客人 · 会员 {stats.vip} 位 · 黑名单 {stats.black} 位 · 已删除{" "}
                  {deletedCount} 位
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <form action="/guests" method="get" className="flex items-center gap-1.5">
                  <input type="hidden" name="view" value={PROFILE_VIEW} />
                  {vipOnly && <input type="hidden" name="vip" value="1" />}
                  {showDeleted && <input type="hidden" name="deleted" value="1" />}
                  <input
                    name="q"
                    defaultValue={q}
                    placeholder="姓名 / 手机 / 证件号 / 单位"
                    className="h-[28px] w-[196px] rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] text-[#3f4a54] outline-none placeholder:text-[#b3bcc5] focus:border-[#32c141]"
                  />
                  <button
                    type="submit"
                    className="h-[28px] cursor-pointer rounded-[2px] bg-[#32c141] px-3 text-[12px] font-medium text-white hover:bg-[#2bb038]"
                  >
                    查询
                  </button>
                </form>
                <Link
                  href={profileHref(state, { vip: !vipOnly, page: 1 })}
                  className={`inline-flex h-[28px] items-center rounded-[2px] border bg-white px-2.5 text-[12px] transition-colors ${
                    vipOnly
                      ? "border-[#32c141] text-[#32c141]"
                      : "border-[#dcdcdc] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                  }`}
                >
                  仅看会员
                </Link>
                <Link
                  href={profileHref(state, { deleted: !showDeleted, page: 1 })}
                  className={`inline-flex h-[28px] items-center rounded-[2px] border bg-white px-2.5 text-[12px] transition-colors ${
                    showDeleted
                      ? "border-[#32c141] text-[#32c141]"
                      : "border-[#dcdcdc] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                  }`}
                >
                  {showDeleted ? "返回在册客人" : `回收站（${deletedCount}）`}
                </Link>
                <Link
                  href="/frontdesk"
                  className="inline-flex h-[28px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                >
                  散客步入
                </Link>
              </div>
            </div>

            {msg && (
              <div className="flex items-start justify-between gap-3 border-b border-[#eef0f2] bg-[#f2f8f4] px-3 py-2">
                <span className="text-[12px] text-[#2a9d5c]">{msg}</span>
                <Link
                  href={profileHref(state)}
                  className="shrink-0 text-[11px] text-[#9aa4ae] hover:text-[#5f6b76]"
                >
                  关闭
                </Link>
              </div>
            )}
            {err && (
              <div className="flex items-start justify-between gap-3 border-b border-[#eef0f2] bg-[#fdf3f3] px-3 py-2">
                <span className="text-[12px] text-[#e23b3b]">{err}</span>
                <Link
                  href={profileHref(state)}
                  className="shrink-0 text-[11px] text-[#9aa4ae] hover:text-[#5f6b76]"
                >
                  关闭
                </Link>
              </div>
            )}

            <details className="border-b border-[#eee]">
              <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-[#2a9d5c] [&::-webkit-details-marker]:hidden">
                + 新增客人档案
              </summary>
              <form
                action={createGuestAction}
                className="grid gap-2.5 border-t border-[#eee] bg-[#fafbfc] px-3 py-2.5 md:grid-cols-4"
              >
                <input type="hidden" name="back" value={profileHref(state)} />
                <div>
                  <label className="label">姓名 *</label>
                  <input name="name" required className="input" placeholder="客人姓名" />
                </div>
                <div>
                  <label className="label">性别</label>
                  <select name="gender" className="input">
                    <option>男</option>
                    <option>女</option>
                  </select>
                </div>
                <div>
                  <label className="label">手机号</label>
                  <input name="mobile" className="input" placeholder="手机号" />
                </div>
                <div>
                  <label className="label">会员等级</label>
                  <select name="vip_level" className="input">
                    <option value="0">普通</option>
                    <option value="1">VIP1</option>
                    <option value="2">VIP2</option>
                    <option value="3">VIP3</option>
                  </select>
                </div>
                <div>
                  <label className="label">证件类型</label>
                  <select name="id_type" className="input">
                    <option>身份证</option>
                    <option>护照</option>
                    <option>其他</option>
                  </select>
                </div>
                <div>
                  <label className="label">证件号</label>
                  <input name="id_no" className="input" placeholder="证件号码" />
                </div>
                <div>
                  <label className="label">单位 / 协议</label>
                  <input name="company" className="input" placeholder="所属单位" />
                </div>
                <div>
                  <label className="label">备注</label>
                  <input name="note" className="input" placeholder="偏好、禁忌等" />
                </div>
                <div className="md:col-span-4">
                  <button type="submit" className="btn-primary">
                    保存档案
                  </button>
                </div>
              </form>
            </details>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px]">
                <thead>
                  <tr>
                    <th className={TH}>档案号</th>
                    <th className={TH}>姓名</th>
                    <th className={TH}>性别</th>
                    <th className={TH}>联系电话</th>
                    <th className={TH}>证件</th>
                    <th className={TH}>单位 / 协议</th>
                    <th className={TH}>等级</th>
                    <th className={`${TH} text-right`}>入住次数</th>
                    <th className={`${TH} text-right`}>累计消费</th>
                    <th className={TH}>是否有效</th>
                    <th className={TH}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={11} className="border-t border-[#eee] px-3 py-12 text-center text-[12px] text-[#9aa4ae]">
                        {showDeleted ? "回收站里没有客人" : "没有匹配的客人档案"}
                      </td>
                    </tr>
                  )}
                  {rows.map((g) => (
                    <tr key={g.id} className="hover:bg-[#fafcfb]">
                      <td className={`${TD} tabular-nums text-[#9aa4ae]`}>
                        G{String(g.id).padStart(10, "0")}
                      </td>
                      <td className={TD}>
                        <div className="flex items-center gap-1.5">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#eef9f0] text-[11px] font-semibold text-[#2a9d5c]">
                            {g.name.slice(0, 1)}
                          </span>
                          <span className="font-medium text-[#3f4a54]">{g.name}</span>
                          {g.blacklist === 1 && (
                            <span className="rounded-[2px] bg-[#fdf3f3] px-1 text-[10px] leading-[16px] text-[#e23b3b]">
                              黑名单
                            </span>
                          )}
                          {showDeleted && (
                            <span className="rounded-[2px] bg-[#f4f5f7] px-1 text-[10px] leading-[16px] text-[#8a949e]">
                              已删除
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`${TD} text-[#5f6b76]`}>{g.gender ?? "-"}</td>
                      <td className={`${TD} tabular-nums text-[#5f6b76]`}>{g.mobile ?? "-"}</td>
                      <td className={`${TD} text-[#9aa4ae]`}>
                        <div className="text-[11px]">{g.id_type ?? "-"}</div>
                        <div className="text-[11px] text-[#b3bcc5]">{maskIdNo(g.id_no)}</div>
                      </td>
                      <td className={`${TD} text-[#5f6b76]`}>{g.company || "-"}</td>
                      <td className={TD}>
                        {g.vip_level > 0 ? (
                          <span className="rounded-[2px] bg-[#fdf6ea] px-1.5 py-0.5 text-[11px] text-[#b07d2e]">
                            VIP{g.vip_level}
                          </span>
                        ) : (
                          <span className="text-[11px] text-[#9aa4ae]">普通</span>
                        )}
                      </td>
                      <td className={`${TD} text-right tabular-nums text-[#5f6b76]`}>{g.stay_count}</td>
                      <td className={`${TD} text-right tabular-nums text-[#3f4a54]`}>
                        {fmtMoney(g.total_revenue)}
                      </td>
                      <td className={TD}>
                        <span
                          className={`rounded-[2px] px-1.5 py-0.5 text-[11px] ${
                            g.deleted ? "bg-[#f4f5f7] text-[#8a949e]" : "bg-[#eef9f0] text-[#2a9d5c]"
                          }`}
                        >
                          {g.deleted ? "无效" : "有效"}
                        </span>
                      </td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-1">
                          <Link
                            href={orderHref(EMPTY_FILTERS, { tab: "all", q: g.name, page: 1 })}
                            className="rounded border border-[#d8dde3] bg-white px-1.5 py-0.5 text-[11px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#2a9d5c]"
                          >
                            详情
                          </Link>
                          <Link
                            href={`/guests?view=profile&edit=${g.id}`}
                            className="rounded border border-[#d8dde3] bg-white px-1.5 py-0.5 text-[11px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#2a9d5c]"
                          >
                            修改
                          </Link>
                          <Link
                            href={`/inhouse?q=${encodeURIComponent(g.name)}`}
                            className="rounded border border-[#d8dde3] bg-white px-1.5 py-0.5 text-[11px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#2a9d5c]"
                          >
                            入住记录
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[#eee] px-3 py-2 text-[12px] text-[#8a949e]">
              <span>
                共 <span className="tabular-nums text-[#3f4a54]">{profileTotal}</span> 条
              </span>
              <Pager
                page={profilePage}
                totalPages={profilePages}
                numbers={pageNumbers}
                hrefFor={(n) => profileHref(state, { page: n })}
              />
            </div>
          </div>

          <p className="text-[11px] text-[#9aa4ae]">
            删除客人只做软删除（guests.deleted = 1），历史入住单与账务明细保留；回收站可恢复。
            免费升级仅把等级标记为 VIP1，不改动历史账单金额。每页 {PROFILE_PAGE_SIZE} 条。
          </p>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------- 订单视角列表 */
  const rawTab = pickRaw(sp.tab);
  const tab: TabKey = ALL_TAB_KEYS.includes(rawTab as TabKey) ? (rawTab as TabKey) : DEFAULT_TAB;
  const q = pickRaw(sp.q).trim();
  const channel = /^\d+$/.test(pickRaw(sp.channel)) ? pickRaw(sp.channel) : "";
  const roomType = /^\d+$/.test(pickRaw(sp.roomType)) ? pickRaw(sp.roomType) : "";
  const rawFrom = pickRaw(sp.from);
  const rawTo = pickRaw(sp.to);
  const from = isValidDate(rawFrom) ? rawFrom : "";
  const to = isValidDate(rawTo) ? rawTo : "";
  const advanced = pickRaw(sp.advanced) === "1";
  const exported = pickRaw(sp.export) === "1";
  const msg = pickRaw(sp.msg);
  const err = pickRaw(sp.err);
  const rawPage = Number.parseInt(pickRaw(sp.page), 10);

  const filters: OrderFilters = {
    tab,
    q,
    channel,
    roomType,
    from,
    to,
    advanced,
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };

  const checkInTime =
    get<{ value: string }>(`SELECT value FROM settings WHERE hotel_id = ? AND key = 'check_in_time'`, [
      hotelId,
    ])?.value || "14:00";
  const checkOutTime =
    get<{ value: string }>(`SELECT value FROM settings WHERE hotel_id = ? AND key = 'check_out_time'`, [
      hotelId,
    ])?.value || "12:00";

  /* 关键词 + 高级筛选 → WHERE 片段（参数化，日期只从服务端常量拼） */
  const whereParts: string[] = [TAB_SQL[tab](ctx)];
  const whereParams: unknown[] = [];
  if (q) {
    whereParts.push(SEARCH_SQL);
    for (let i = 0; i < SEARCH_PARAM_COUNT; i += 1) whereParams.push(`%${q}%`);
  }
  if (channel) {
    whereParts.push("channel_id = ?");
    whereParams.push(Number(channel));
  }
  if (roomType) {
    whereParts.push("room_type_id = ?");
    whereParams.push(Number(roomType));
  }
  const historyView = pickRaw(sp.history) === "1";
  if (historyView) {
    whereParts.push("out_date <> '' AND out_date < ?");
    whereParams.push(ctx.yearAgo);
  }
  const doorNo = pickRaw(sp.doorNo).trim();
  if (doorNo) {
    whereParts.push("room_no = ?");
    whereParams.push(doorNo);
  }
  if (from) {
    whereParts.push("in_date >= ?");
    whereParams.push(from);
  }
  if (to) {
    whereParts.push("in_date <= ?");
    whereParams.push(to);
  }
  const whereSql = whereParts.join(" AND ");
  const whereBind = [hotelId, hotelId, ...whereParams] as never[];

  const totals = get<{ n: number; rooms: number | null }>(
    `${UNIFIED_SQL}
     SELECT COUNT(*) AS n, COALESCE(SUM(room_count), 0) AS rooms
       FROM u WHERE ${whereSql}`,
    whereBind
  ) ?? { n: 0, rooms: 0 };
  const total = Number(totals.n ?? 0);
  const roomTotal = Number(totals.rooms ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const state: OrderFilters = { ...filters, page };

  /** 姓名 → 客人档案（订单行的「删除客人 / 免费升级」用） */
  const guestByName = new Map<string, GuestLite>();
  for (const g of all<GuestLite>(
    `SELECT id, name, COALESCE(vip_level, 0) AS vip_level
       FROM guests WHERE hotel_id = ? AND COALESCE(deleted, 0) = 0`,
    [hotelId]
  )) {
    const key = (g.name ?? "").trim();
    if (key && !guestByName.has(key)) guestByName.set(key, g);
  }

  const pageRows = all<RawRow>(
    `${UNIFIED_SQL}
     SELECT * FROM u WHERE ${whereSql}
      ORDER BY in_date DESC, kind ASC, row_id DESC
      LIMIT ? OFFSET ?`,
    [...whereBind, PAGE_SIZE, (page - 1) * PAGE_SIZE] as never[]
  ).map((u) => toOrderRow(u, checkInTime, checkOutTime, guestByName));

  /* 导出：当前筛选下的全部行（最多 5000 条） */
  const exportRows = exported
    ? all<RawRow>(
        `${UNIFIED_SQL}
         SELECT * FROM u WHERE ${whereSql}
          ORDER BY in_date DESC, kind ASC, row_id DESC
          LIMIT 5000`,
        whereBind
      ).map((u) => toOrderRow(u, checkInTime, checkOutTime, guestByName))
    : [];

  const channels = all<{ id: number; name: string }>(
    `SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  const roomTypes = all<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );

  const activeTab = ALL_TABS.find((t) => t.key === tab);
  const hasFilter = Boolean(q || channel || roomType || from || to);
  const csvName = `宾客列表-${today}.csv`;
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${toCsv(exportRows)}`)}`;
  const exportHref = addParam(orderHref(state, { page: 1 }), "export=1");
  const backPath = orderHref(state);

  const pageNumbers: number[] = [];
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const pageEnd = Math.min(totalPages, pageStart + 4);
  for (let i = pageStart; i <= pageEnd; i += 1) pageNumbers.push(i);

  return (
    <div className="flex min-h-full items-start bg-[#f7f8fa]">
      <Sidebar
        counts={counts}
        activeTab={tab}
        hrefForTab={(key) => orderHref(state, { tab: key, page: 1 })}
        profileHrefValue={profileHref({ q: "", vip: false, deleted: false, page: 1 })}
        profileActive={false}
        profileCount={profileCount}
      />

      <div className="min-w-0 flex-1 p-2">
        <div className="overflow-hidden rounded-[2px] border border-[#e5e7eb] bg-white">
          {/* 隐私提示 */}
          <div className="border-b border-[#f5e6a8] bg-[#fffceb] px-3 py-1.5 text-[12px] leading-5 text-[#59675f]">
            <span className="mr-1 font-semibold text-[#e23b3b]">温馨提示：</span>
            为保护住客隐私。查询离店后的入住数据，请务必验证手机号码一致性。可引导客人使用【微管家】小程序自助查询和在线申请开票等操作。
          </div>

          {/* 快速查询 */}
          <form action="/guests" method="get" className="border-b border-[#eee] px-3 py-2.5">
            {tab !== DEFAULT_TAB && <input type="hidden" name="tab" value={tab} />}
            {advanced && <input type="hidden" name="advanced" value="1" />}

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-[#3f4a54]">快速查询</span>
              <input
                type="text"
                name="q"
                defaultValue={q}
                placeholder="请输入客人姓名、房间号、协议公司、团队名称"
                className="h-[30px] w-[320px] max-w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#3f4a54] outline-none placeholder:text-[#b3bcc5] focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]"
              />
              <button
                type="submit"
                className="h-[30px] cursor-pointer rounded-[2px] bg-[#32c141] px-5 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038]"
              >
                查询
              </button>
              <Link
                href={orderHref(state, { advanced: !advanced, page: 1 })}
                className="inline-flex items-center gap-0.5 text-[12px] text-[#8a949e] hover:text-[#32c141]"
              >
                更多筛选条件
                <Chevron up={advanced} />
              </Link>

              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Link
                  href={orderHref(state, { tab: "old-left", page: 1 })}
                  className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
                >
                  一年前离店订单查询
                </Link>
                <Link
                  href={exportHref}
                  className="inline-flex h-[30px] items-center gap-1 rounded-[2px] border border-[#32c141] bg-[#32c141] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038]"
                >
                  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                    <path
                      d="M6 1v7m0 0L3.2 5.2M6 8l2.8-2.8M1.5 10.5h9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  导出
                </Link>
                {/* Excel 导出（报告 P2-10）：服务端生成 .xls，Excel/WPS 直接打开 */}
                <a
                  href="/api/export?type=guests"
                  className="inline-flex h-[30px] items-center gap-1 rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
                  download
                >
                  Excel
                </a>
              </div>
            </div>

            {advanced && (
              <div className="mt-2 rounded-[2px] border border-[#e5e7eb] bg-[#fafbfc] p-2.5">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-[#9aa4ae]">入离日期（起）</span>
                    <input
                      type="date"
                      name="from"
                      defaultValue={from}
                      className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141]"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-[#9aa4ae]">入离日期（止）</span>
                    <input
                      type="date"
                      name="to"
                      defaultValue={to}
                      className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141]"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-[#9aa4ae]">房型</span>
                    <select
                      name="roomType"
                      defaultValue={roomType}
                      className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141]"
                    >
                      <option value="">全部房型</option>
                      {roomTypes.map((rt) => (
                        <option key={rt.id} value={rt.id}>
                          {rt.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-[#9aa4ae]">渠道</span>
                    <select
                      name="channel"
                      defaultValue={channel}
                      className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141]"
                    >
                      <option value="">全部渠道</option>
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="submit"
                    className="h-[30px] cursor-pointer rounded-[2px] bg-[#32c141] px-3 text-[12px] font-medium text-white hover:bg-[#2bb038]"
                  >
                    应用筛选
                  </button>
                  <Link
                    href={orderHref(state, {
                      q: "",
                      channel: "",
                      roomType: "",
                      from: "",
                      to: "",
                      page: 1,
                    })}
                    className="text-[12px] text-[#8a949e] hover:text-[#32c141]"
                  >
                    清除筛选
                  </Link>
                </div>
              </div>
            )}
          </form>

          {msg && (
            <div className="flex items-start justify-between gap-3 border-b border-[#eee] bg-[#f2f8f4] px-3 py-2">
              <span className="text-[12px] text-[#2a9d5c]">{msg}</span>
              <Link
                href={orderHref(state)}
                className="shrink-0 text-[11px] text-[#9aa4ae] hover:text-[#5f6b76]"
              >
                关闭
              </Link>
            </div>
          )}
          {err && (
            <div className="flex items-start justify-between gap-3 border-b border-[#eee] bg-[#fdf3f3] px-3 py-2">
              <span className="text-[12px] text-[#e23b3b]">{err}</span>
              <Link
                href={orderHref(state)}
                className="shrink-0 text-[11px] text-[#9aa4ae] hover:text-[#5f6b76]"
              >
                关闭
              </Link>
            </div>
          )}

          {exported && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[#eee] bg-[#f2f8f4] px-3 py-2 text-[12px] text-[#3f4a54]">
              <span className="font-medium">已导出 {exportRows.length} 条订单（CSV）</span>
              <a
                href={csvHref}
                download={csvName}
                className="rounded-[2px] border border-[#32c141] bg-white px-2 py-0.5 text-[#32c141] hover:bg-[#e8f7ea]"
              >
                下载 {csvName}
              </a>
              <Link
                href={orderHref(state, { page: 1 })}
                className="text-[12px] text-[#5f6b76] underline-offset-2 hover:underline"
              >
                收起
              </Link>
            </div>
          )}

          {/* 订单数 / 房间数 */}
          <div className="flex flex-wrap items-center gap-5 border-b border-[#eee] px-3 py-2 text-[12px] text-[#3f4a54]">
            <span>
              订单数：<span className="tabular-nums">{total}</span>
            </span>
            <span>
              房间数：<span className="tabular-nums">{roomTotal}</span>
            </span>
            {hasFilter && (
              <span className="text-[11px] text-[#9aa4ae]">
                已应用筛选：
                {[
                  q && `关键词「${q}」`,
                  channel && `渠道 ${channels.find((c) => String(c.id) === channel)?.name ?? channel}`,
                  roomType && `房型 ${roomTypes.find((r) => String(r.id) === roomType)?.name ?? roomType}`,
                  (from || to) && `日期 ${from || "…"} ~ ${to || "…"}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {tab === "old-left" && (
              <Link href={orderHref(state, { tab: "all", page: 1 })} className="text-[11px] text-[#32c141] hover:underline">
                返回全部
              </Link>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px]">
              <thead>
                <tr>
                  <th className={TH}>订单状态</th>
                  <th className={TH}>
                    <span className="inline-flex items-center gap-1">
                      渠道 <Chevron className="text-[#9aa4ae]" />
                    </span>
                  </th>
                  <th className={TH}>渠道订单号</th>
                  <th className={TH}>预订人信息</th>
                  <th className={TH}>客人信息</th>
                  <th className={TH}>入住类型</th>
                  <th className={TH}>房间信息</th>
                  <th className={TH}>
                    <span className="inline-flex items-center gap-1">
                      入离时间 <span className="text-[#9aa4ae]">⇅</span>
                    </span>
                  </th>
                  <th className={TH}>
                    <span className="inline-flex items-center gap-1">
                      余额 <span className="text-[#9aa4ae]">⇅</span>
                    </span>
                  </th>
                  <th className={TH}>开票方</th>
                  <th className={`${TH} border-l border-l-[#e9efec]`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="border-t border-[#eee] px-3 py-12 text-center text-[12px] text-[#9aa4ae]">
                      没有符合条件的订单
                      <div className="mt-1 text-[11px] text-[#9aa4ae]">
                        {hasFilter
                          ? "试试调整关键词、日期区间或渠道/房型筛选"
                          : `「${activeTab ? activeTab.label : "当前"}」暂无订单，其他分组可能还有数据`}
                      </div>
                      <div className="mt-3 flex items-center justify-center gap-2">
                        {hasFilter && (
                          <Link
                            href={orderHref(state, {
                              q: "",
                              channel: "",
                              roomType: "",
                              from: "",
                              to: "",
                              page: 1,
                            })}
                            className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                          >
                            清除筛选
                          </Link>
                        )}
                        <Link
                          href={orderHref(state, { tab: "all", page: 1 })}
                          className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                        >
                          查看全部订单
                        </Link>
                      </div>
                    </td>
                  </tr>
                )}

                {pageRows.map((r) => {
                  const inHouse = r.kind === "stay" && r.statusKey === "INHOUSE";
                  return (
                    <tr key={r.key} className="align-middle hover:bg-[#fafcfb]">
                      <td className={TD}>
                        <span className={`text-[12px] ${r.statusCls}`}>{r.statusLabel}</span>
                      </td>

                      <td className={`${TD} text-[#3f4a54]`}>
                        <span className="inline-flex items-center gap-1">
                          {r.channelName}
                          <Chevron className="text-[#b3bcc5]" />
                        </span>
                      </td>

                      <td className={`${TD} tabular-nums text-[#5f6b76]`}>{r.orderNo}</td>

                      <td className={TD}>
                        <div className="text-[#3f4a54]">{r.bookerName}</div>
                        <div className="text-[11px] tabular-nums leading-[17px] text-[#9aa4ae]">
                          {r.bookerMobile}
                        </div>
                      </td>

                      <td className={TD}>
                        {r.linkedRooms > 1 && (
                          <div className="mb-0.5">
                            <span className="inline-flex items-center gap-1 text-[11px] leading-[16px] text-[#32c141]">
                              <LinkedIcon />
                              所有联房 ({r.linkedRooms})
                            </span>
                          </div>
                        )}
                        <div className="text-[#3f4a54]">{r.guestName}</div>
                        <div className="text-[11px] tabular-nums leading-[17px] text-[#9aa4ae]">
                          {r.guestMobile}
                        </div>
                      </td>

                      <td className={`${TD} text-[#5f6b76]`}>{r.stayType}</td>

                      <td className={TD}>
                        <div className="text-[#3f4a54]">{r.roomTypeName}</div>
                        <div className="text-[11px] leading-[17px] text-[#5f6b76]">
                          {r.roomNo ? (
                            r.roomNo
                          ) : (
                            <span className="rounded-[2px] bg-[#fdf6ea] px-1 text-[10px] leading-[16px] text-[#b07d2e]">
                              未排房
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] tabular-nums leading-[17px]">
                          <span className="text-[#e23b3b]">{fmtMoney(r.rate)}</span>
                          <span className="ml-1 text-[#9aa4ae]">{r.roomCount} 间</span>
                        </div>
                      </td>

                      <td className={`${TD} tabular-nums`}>
                        <div className="text-[#3f4a54]">
                          <span className="text-[#9aa4ae]">入住：</span>
                          {r.checkInDisplay}
                        </div>
                        <div className="text-[#3f4a54]">
                          <span className="text-[#9aa4ae]">离店：</span>
                          {r.checkOutDisplay}
                        </div>
                      </td>

                      <td className={`${TD} tabular-nums`}>
                        <span className="text-[#e23b3b]">{fmtMoney(r.balance)}</span>
                      </td>

                      <td className={`${TD} text-[#5f6b76]`}>{r.invoiceParty}</td>

                      <td className={`${TD} border-l border-l-[#f0f2f4]`}>
                        <div className="flex items-center gap-1.5">
                          <Link
                            href={`/orders?tab=all&q=${encodeURIComponent(r.orderNo)}`}
                            className="rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-[2px] text-[12px] leading-[18px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
                          >
                            查看
                          </Link>

                          <RowActionMenu>
                            {/* 去呼呼宾客列表「操作 ▾」的 11 项 */}
                            {inHouse && r.stayId !== null ? (
                              <MenuLink href={`/cashier?stay=${r.stayId}&checkout=1`}>结账退房</MenuLink>
                            ) : (
                              <MenuDisabled reason={inHouse ? "未关联入住单" : "未入住"}>结账退房</MenuDisabled>
                            )}
                            {/* 去呼呼宾客列表第一项就是「排房」：预订类订单可直接排房 */}
                            {r.kind === "booking" && r.statusKey !== "CANCELLED" && r.statusKey !== "CHECKED_IN" ? (
                              <MenuLink href={`/bookings?tab=all&q=${encodeURIComponent(r.orderNo)}`}>排房</MenuLink>
                            ) : (
                              <MenuDisabled reason={r.kind === "stay" ? "已入住，用换房" : "订单已取消"}>排房</MenuDisabled>
                            )}
                            {/* 重新入住：已离店的客人一键带入上次信息再办入住 */}
                            {r.kind === "stay" && r.statusKey !== "INHOUSE" && r.stayId !== null ? (
                              <MenuLink href={`/frontdesk?fromStay=${r.stayId}`}>重新入住</MenuLink>
                            ) : (
                              <MenuDisabled reason={r.kind === "stay" ? "在住中" : "预订单请用「办理入住」"}>
                                重新入住
                              </MenuDisabled>
                            )}
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=extend` : `/inhouse`}>
                              续住
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=deposit` : `/inhouse`}>
                              交押金
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=rate` : `/inhouse`}>
                              调价
                            </MenuLink>
                            {r.stayId !== null ? (
                              <MenuLink href={`/cashier/print?stay=${r.stayId}`} external>
                                打登记单
                              </MenuLink>
                            ) : (
                              <MenuDisabled reason="待入住">打登记单</MenuDisabled>
                            )}
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=link` : `/inhouse`}>
                              联房
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=share` : `/inhouse`}>
                              同住
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=change` : `/inhouse`}>
                              换房
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=team` : `/inhouse`}>
                              入团
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=cancel` : `/inhouse`}>
                              取消入住
                            </MenuLink>
                            <MenuLink href={r.stayId !== null ? `/cashier?stay=${r.stayId}&op=hourly` : `/inhouse`}>
                              转钟点房
                            </MenuLink>

                            <span className="my-1 block border-t border-[#f0f2f4]" />
                            <MenuLink href={profileHref({ q: r.guestName, vip: false, deleted: false, page: 1 })}>
                              修改客人信息
                            </MenuLink>
                            <MenuLink href={`/sms?tab=send`}>发短信</MenuLink>

                            {r.guestArchiveId !== null && (
                              <>
                                <span className="my-1 block border-t border-[#f0f2f4]" />
                                {r.guestVipLevel < 1 ? (
                                  <form action={freeUpgradeVip1Action}>
                                    <input type="hidden" name="id" value={r.guestArchiveId} />
                                    <input type="hidden" name="back" value={backPath} />
                                    <button type="submit" className={MENU_BUTTON_CLS}>
                                      免费升级 VIP1
                                    </button>
                                  </form>
                                ) : (
                                  <MenuDisabled reason={`已是 VIP${r.guestVipLevel}`}>
                                    免费升级 VIP1
                                  </MenuDisabled>
                                )}
                                <ConfirmForm
                                  action={deleteGuestAction}
                                  message={`确认删除客人「${r.guestName}」？`}
                                  detail="只做软删除（标记为已删除），历史入住单与账务明细保留，可在回收站恢复。"
                                  confirmLabel="确认删除"
                                >
                                  <input type="hidden" name="id" value={r.guestArchiveId} />
                                  <input type="hidden" name="back" value={backPath} />
                                  <button type="submit" className={MENU_DANGER_CLS}>
                                    删除客人
                                  </button>
                                </ConfirmForm>
                              </>
                            )}
                          </RowActionMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[#eee] px-3 py-2 text-[12px] text-[#8a949e]">
            <span>
              共 <span className="tabular-nums text-[#3f4a54]">{total}</span> 条
            </span>
            <Pager page={page} totalPages={totalPages} numbers={pageNumbers} hrefFor={(n) => orderHref(state, { page: n })} />
          </div>
        </div>

        <p className="mt-2 px-1 text-[11px] text-[#9aa4ae]">
          数据源：stays（现住 / 已离）+ bookings（待排房 / 已确认）合并视图 · 每页 {PAGE_SIZE} 条 ·
          手机号已脱敏（{"138****1234"}）· 余额取入住单最新账务单
        </p>
      </div>
    </div>
  );
}

/* ============================================================== 分页 */

function Pager({
  page,
  totalPages,
  numbers,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  numbers: number[];
  hrefFor: (n: number) => string;
}) {
  const btn = "flex h-6 min-w-6 items-center justify-center rounded-[2px] border px-1.5 tabular-nums";
  return (
    <div className="flex items-center gap-1">
      <Link
        href={hrefFor(Math.max(1, page - 1))}
        aria-disabled={page <= 1}
        aria-label="上一页"
        className={`${btn} ${
          page <= 1
            ? "pointer-events-none border-[#eee] text-[#d3d8dd]"
            : "border-[#e0e4e8] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
        }`}
      >
        ‹
      </Link>
      {numbers.map((n) => (
        <Link
          key={n}
          href={hrefFor(n)}
          aria-current={n === page ? "page" : undefined}
          className={`${btn} ${
            n === page
              ? "border-[#32c141] bg-[#32c141] font-medium text-white"
              : "border-[#e0e4e8] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
          }`}
        >
          {n}
        </Link>
      ))}
      <Link
        href={hrefFor(Math.min(totalPages, page + 1))}
        aria-disabled={page >= totalPages}
        aria-label="下一页"
        className={`${btn} ${
          page >= totalPages
            ? "pointer-events-none border-[#eee] text-[#d3d8dd]"
            : "border-[#e0e4e8] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
        }`}
      >
        ›
      </Link>
    </div>
  );
}

/* ============================================================== 杂项 */

function maskIdNo(id: string | null): string {
  if (!id) return "-";
  if (id.length <= 6) return id;
  return id.slice(0, 4) + "*".repeat(Math.max(0, id.length - 8)) + id.slice(-4);
}
