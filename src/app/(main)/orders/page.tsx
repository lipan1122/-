import Link from "next/link";
import OrderActions, {
  type OrderDetail,
  type RoomOption,
  type StayOption,
} from "@/components/OrderActions";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { BOOKING_STATUS, addDays, fmtMoney, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

/* ------------------------------------------------------------------ 类型 */

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

const TODO_TABS = TAB_DEFS.filter((t) => t.group === "todo");
const STATUS_TABS = TAB_DEFS.filter((t) => t.group === "status");

/** 一年前离店查询是隐藏 tab（菜单里不出现） */
const HIDDEN_TABS: TabDef[] = [{ key: "old-left", label: "一年前离店", group: "status" }];

const ALL_TABS: TabDef[] = [...TAB_DEFS, ...HIDDEN_TABS];
const ALL_TAB_KEYS: TabKey[] = ALL_TABS.map((t) => t.key);
const DEFAULT_TAB: TabKey = "inhouse";

type TabCtx = { today: string; yesterday: string; tomorrow: string; yearAgo: string };

/** 每个 tab 的判定规则（唯一的真相来源，计数与列表共用） */
const TAB_PREDICATES: Record<TabKey, (r: OrderRow, c: TabCtx) => boolean> = {
  all: () => true,
  booked: (r) => r.kind === "booking",
  inhouse: (r) => r.kind === "stay" && r.statusKey === "INHOUSE",
  unassigned: (r) => r.kind === "booking" && r.statusKey === "PENDING",
  "pre-arrive": (r, c) =>
    r.kind === "booking" &&
    r.checkInDate === c.today &&
    (r.statusKey === "PENDING" || r.statusKey === "CONFIRMED"),
  arrived: (r, c) => r.kind === "stay" && r.checkInDate === c.today,
  "pre-leave": (r, c) => r.kind === "stay" && r.statusKey === "INHOUSE" && r.checkOutDate === c.today,
  "yesterday-noshow": (r, c) =>
    r.kind === "booking" &&
    r.checkInDate === c.yesterday &&
    (r.statusKey === "PENDING" || r.statusKey === "CONFIRMED" || r.statusKey === "NOSHOW"),
  tomorrow: (r, c) =>
    r.kind === "booking" &&
    r.checkInDate === c.tomorrow &&
    (r.statusKey === "PENDING" || r.statusKey === "CONFIRMED"),
  "left-today": (r, c) => r.kind === "stay" && r.actualCheckOutDate === c.today,
  ledger: (r) => r.balance > 0.009,
  team: (r) => r.teamName.length > 0,
  channel: (r) => r.kind === "booking" && r.channelType !== "" && r.channelType !== "direct",
  "old-left": (r, c) =>
    r.kind === "stay" && r.actualCheckOutDate !== "" && r.actualCheckOutDate < c.yearAgo,
};

/** stays / bookings 统一视图的原始行 */
type UnifiedRow = {
  kind: string;
  id: number;
  status_key: string;
  channel_id: number | null;
  channel_type: string | null;
  channel_name: string | null;
  order_no: string | null;
  booker_name: string | null;
  booker_mobile: string | null;
  guest_name: string | null;
  guest_mobile: string | null;
  linked_rooms: number | null;
  stay_type: string | null;
  room_type_id: number | null;
  room_type_name: string | null;
  room_no: string | null;
  rate: number | null;
  room_count: number | null;
  check_in_raw: string | null;
  check_out_raw: string | null;
  actual_check_out: string | null;
  balance: number | null;
  invoice_party: string | null;
  company_name: string | null;
  team_name: string | null;
  stay_id: number | null;
  booking_id: number | null;
  folio_no: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  breakfast: number | null;
  pay_type: string | null;
  remark: string | null;
};

/** 表格一行（已脱敏、已格式化） */
type OrderRow = {
  key: string;
  kind: "stay" | "booking";
  id: number;
  statusKey: string;
  statusLabel: string;
  statusCls: string;
  channelId: number | null;
  channelType: string;
  channelName: string;
  orderNo: string;
  bookerName: string;
  bookerMobile: string;
  guestName: string;
  guestMobile: string;
  linkedRooms: number;
  stayType: string;
  roomTypeId: number | null;
  roomTypeName: string;
  roomNo: string;
  rate: number;
  roomCount: number;
  checkInDate: string;
  checkOutDate: string;
  actualCheckOutDate: string;
  checkInDisplay: string;
  checkOutDisplay: string;
  balance: number;
  invoiceParty: string;
  teamName: string;
  haystack: string;
  stayId: number | null;
  bookingId: number | null;
  folioNo: string;
  totalAmount: number;
  paidAmount: number;
  breakfast: number;
  payType: string;
  remark: string;
};

type StatusStyle = { label: string; cls: string };

const ORDER_STATUS: Record<string, StatusStyle> = {
  ...BOOKING_STATUS,
  /* 徽标配色对齐去呼呼：现住绿 / 预订蓝 / 取消灰 */
  PENDING: { label: "待排房", cls: "border-[#c3daf6] bg-[#edf4fe] text-[#2f6fed]" },
  CONFIRMED: { label: "已确认", cls: "border-[#c3daf6] bg-[#edf4fe] text-[#2f6fed]" },
  CHECKED_IN: { label: "已入住", cls: "border-[#b8e4c0] bg-[#e8f7ea] text-[#32c141]" },
  CANCELLED: { label: "已取消", cls: "border-[#e3e6ea] bg-[#f4f5f7] text-[#8a949e]" },
  NOSHOW: { label: "未到", cls: "border-[#f0ddc2] bg-[#fdf6ea] text-[#b07d2e]" },
  INHOUSE: { label: "现住", cls: "border-[#b8e4c0] bg-[#e8f7ea] text-[#32c141]" },
  CHECKED_OUT: { label: "已离", cls: "border-[#e3e6ea] bg-[#f4f5f7] text-[#8a949e]" },
};

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

type OrdersPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/* -------------------------------------------------------------- 小工具 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 取纯日期：ISO 时间转本地日期，纯日期原样返回 */
function localDate(raw: string | null): string {
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

/** 取本地「日期 时:分」 */
function localDateTime(raw: string | null, fallbackTime: string): string {
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

/** 手机号脱敏：138****1234 */
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

function hrefFor(f: OrderFilters, patch: Partial<OrderFilters> = {}): string {
  const n: OrderFilters = { ...f, ...patch };
  const p = new URLSearchParams();
  p.set("tab", n.tab);
  if (n.q) p.set("q", n.q);
  if (n.channel) p.set("channel", n.channel);
  if (n.roomType) p.set("roomType", n.roomType);
  if (n.from) p.set("from", n.from);
  if (n.to) p.set("to", n.to);
  if (n.advanced) p.set("advanced", "1");
  if (n.page > 1) p.set("page", String(n.page));
  return `/orders?${p.toString()}`;
}

/* ------------------------------------------------------------ 统一列表 */

const UNIFIED_SQL = `
  SELECT * FROM (
    SELECT 'stay' AS kind,
           s.id AS id,
           s.status AS status_key,
           s.channel_id AS channel_id,
           c.channel_type AS channel_type,
           c.name AS channel_name,
           s.stay_no AS order_no,
           s.guest_name AS booker_name,
           s.mobile AS booker_mobile,
           s.guest_name AS guest_name,
           s.mobile AS guest_mobile,
           (SELECT COUNT(*) FROM stays s2
             WHERE s2.hotel_id = s.hotel_id
               AND s.booking_id IS NOT NULL
               AND s2.booking_id = s.booking_id) AS linked_rooms,
           CASE WHEN s.team_name IS NOT NULL AND TRIM(s.team_name) <> ''
                THEN '团队房' ELSE '日租房' END AS stay_type,
           COALESCE(r.room_type_id, 0) AS room_type_id,
           rt.name AS room_type_name,
           r.room_no AS room_no,
           s.rate AS rate,
           1 AS room_count,
           s.check_in_time AS check_in_raw,
           s.expect_check_out AS check_out_raw,
           s.actual_check_out AS actual_check_out,
           COALESCE(f.balance, 0) AS balance,
           COALESCE(s.invoice_party, '酒店') AS invoice_party,
           NULL AS company_name,
           s.team_name AS team_name,
           s.id AS stay_id,
           s.booking_id AS booking_id,
           f.folio_no AS folio_no,
           COALESCE(f.total_amount, 0) AS total_amount,
           COALESCE(f.paid_amount, 0) AS paid_amount,
           COALESCE(s.breakfast, 0) AS breakfast,
           COALESCE(s.pay_type, '') AS pay_type,
           COALESCE(s.remark, '') AS remark
      FROM stays s
      JOIN rooms r ON r.id = s.room_id
      LEFT JOIN room_types rt ON rt.id = r.room_type_id
      LEFT JOIN channels c ON c.id = s.channel_id
      LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ?

    UNION ALL

    SELECT 'booking' AS kind,
           b.id AS id,
           b.status AS status_key,
           b.channel_id AS channel_id,
           c.channel_type AS channel_type,
           c.name AS channel_name,
           COALESCE(NULLIF(TRIM(COALESCE(b.channel_order_no, '')), ''), b.booking_no) AS order_no,
           b.guest_name AS booker_name,
           b.mobile AS booker_mobile,
           b.guest_name AS guest_name,
           b.mobile AS guest_mobile,
           MAX(COALESCE(b.room_count, 1), 1) AS linked_rooms,
           CASE WHEN b.team_name IS NOT NULL AND TRIM(b.team_name) <> ''
                THEN '团队房' ELSE '日租房' END AS stay_type,
           b.room_type_id AS room_type_id,
           rt.name AS room_type_name,
           r.room_no AS room_no,
           b.rate AS rate,
           MAX(COALESCE(b.room_count, 1), 1) AS room_count,
           b.check_in_date AS check_in_raw,
           b.check_out_date AS check_out_raw,
           NULL AS actual_check_out,
           0 AS balance,
           COALESCE(b.invoice_party, '酒店') AS invoice_party,
           cp.name AS company_name,
           b.team_name AS team_name,
           NULL AS stay_id,
           b.id AS booking_id,
           NULL AS folio_no,
           0 AS total_amount,
           0 AS paid_amount,
           COALESCE(b.breakfast, 0) AS breakfast,
           COALESCE(b.pay_type, '') AS pay_type,
           COALESCE(b.remark, '') AS remark
      FROM bookings b
      LEFT JOIN room_types rt ON rt.id = b.room_type_id
      LEFT JOIN rooms r ON r.id = b.room_id
      LEFT JOIN channels c ON c.id = b.channel_id
      LEFT JOIN companies cp ON cp.id = b.company_id
     WHERE b.hotel_id = ?
  ) u
  ORDER BY substr(check_in_raw, 1, 10) DESC, kind ASC, id DESC
`;

function toOrderRow(u: UnifiedRow, checkInTime: string, checkOutTime: string): OrderRow {
  const kind: "stay" | "booking" = u.kind === "stay" ? "stay" : "booking";
  const statusKey = u.status_key ?? "";
  const style = ORDER_STATUS[statusKey];
  const checkInDate = localDate(u.check_in_raw);
  const checkOutDate = localDate(u.check_out_raw);
  const guestName = u.guest_name ?? u.booker_name ?? "—";
  const bookerName = u.booker_name ?? guestName;
  const mobileRaw = u.guest_mobile ?? u.booker_mobile ?? "";
  const channelName = u.channel_name ?? "散客";
  const stayType = u.stay_type ?? "日租房";
  const roomTypeName = u.room_type_name ?? "未分房型";
  const roomNo = u.room_no ?? "";
  const teamName = (u.team_name ?? "").trim();
  const companyName = (u.company_name ?? "").trim();
  const orderNo = u.order_no ?? "—";
  const mobileMasked = maskMobile(mobileRaw);

  const checkInDisplay =
    kind === "stay"
      ? localDateTime(u.check_in_raw, checkInTime)
      : `${checkInDate} ${checkInTime}`.trim();
  const checkOutDisplay = checkOutDate
    ? `${checkOutDate} ${checkOutTime}`
    : kind === "stay"
      ? "未定"
      : "—";

  return {
    key: `${kind}-${u.id}`,
    kind,
    id: u.id,
    statusKey,
    statusLabel: style ? style.label : statusKey || "—",
    statusCls: style ? style.cls : "border-[#e3e6ea] bg-[#f4f5f7] text-[#8a949e]",
    channelId: u.channel_id,
    channelType: u.channel_type ?? "",
    channelName,
    orderNo,
    bookerName,
    bookerMobile: mobileMasked,
    guestName,
    guestMobile: mobileMasked,
    linkedRooms: Math.max(1, Number(u.linked_rooms ?? 1)),
    stayType,
    roomTypeId: u.room_type_id,
    roomTypeName,
    roomNo,
    rate: Number(u.rate ?? 0),
    roomCount: Math.max(1, Number(u.room_count ?? 1)),
    checkInDate,
    checkOutDate,
    actualCheckOutDate: localDate(u.actual_check_out),
    checkInDisplay,
    checkOutDisplay,
    balance: Number(u.balance ?? 0),
    invoiceParty: u.invoice_party ?? "酒店",
    teamName,
    stayId: u.stay_id ?? null,
    bookingId: u.booking_id ?? null,
    folioNo: u.folio_no ?? "",
    totalAmount: Number(u.total_amount ?? 0),
    paidAmount: Number(u.paid_amount ?? 0),
    breakfast: Number(u.breakfast ?? 0),
    payType: u.pay_type ?? "",
    remark: (u.remark ?? "").trim(),
    haystack: [
      guestName,
      bookerName,
      mobileRaw,
      mobileMasked,
      roomNo,
      roomTypeName,
      channelName,
      companyName,
      teamName,
      orderNo,
    ]
      .join(" ")
      .toLowerCase(),
  };
}

/** 表格行 → 抽屉所需的纯数据（可序列化给客户端组件） */
function toDetail(r: OrderRow): OrderDetail {
  return {
    kind: r.kind,
    id: r.id,
    stayId: r.stayId,
    bookingId: r.bookingId,
    statusKey: r.statusKey,
    rateValue: r.rate,
    orderNo: r.orderNo,
    folioNo: r.folioNo,
    statusLabel: r.statusLabel,
    statusCls: r.statusCls,
    channelName: r.channelName,
    bookerName: r.bookerName,
    bookerMobile: r.bookerMobile,
    guestName: r.guestName,
    guestMobile: r.guestMobile,
    roomTypeName: r.roomTypeName,
    roomNo: r.roomNo,
    linkedRooms: r.linkedRooms,
    stayType: r.stayType,
    checkInDisplay: r.checkInDisplay,
    checkOutDisplay: r.checkOutDisplay,
    roomCount: r.roomCount,
    rateText: fmtMoney(r.rate),
    breakfast: r.breakfast,
    payType: r.payType,
    invoiceParty: r.invoiceParty,
    remark: r.remark,
    totalText: fmtMoney(r.totalAmount),
    paidText: fmtMoney(r.paidAmount),
    balanceText: fmtMoney(r.balance),
    balanceOwed: r.balance > 0.009,
  };
}

/* ---------------------------------------------------------------- 导出 */
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

/* ---------------------------------------------------------------- 页面 */

/** 极小内联箭头，避免小字号下三角字符渲染成圆点 */
function Chevron({ up = false, className = "" }: { up?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 10 6"
      width="8"
      height="5"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
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

/* ---------------------------------------------------------------- 视觉 */

/** 表头：淡绿底 12px */
const TH =
  "whitespace-nowrap border-b border-[#e3ece6] bg-[#eef6f1] px-3 py-2 text-left text-[12px] font-normal text-[#5c7a68]";

/** 单元格：两行内容 → 行高 44px，边框 #eee */
const TD = "border-t border-[#eee] px-3 py-[5px] align-middle text-[12px] leading-[17px]";

/** 联房图标 */
function LinkedIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <rect x="1" y="1" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="7" y="1" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="1" y="7" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="7" y="7" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const ctx: TabCtx = {
    today,
    yesterday: todayStr(addDays(today, -1)),
    tomorrow: todayStr(addDays(today, 1)),
    yearAgo: todayStr(addDays(today, -365)),
  };

  const sp = await searchParams;

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
    get<{ value: string }>(
      `SELECT value FROM settings WHERE hotel_id = ? AND key = 'check_in_time'`,
      [hotelId]
    )?.value || "14:00";
  const checkOutTime =
    get<{ value: string }>(
      `SELECT value FROM settings WHERE hotel_id = ? AND key = 'check_out_time'`,
      [hotelId]
    )?.value || "12:00";

  const unified = all<UnifiedRow>(UNIFIED_SQL, [hotelId, hotelId]);
  const allRows: OrderRow[] = unified.map((u) => toOrderRow(u, checkInTime, checkOutTime));

  const counts = ALL_TAB_KEYS.reduce<Record<TabKey, number>>(
    (acc, key) => {
      acc[key] = allRows.filter((r) => TAB_PREDICATES[key](r, ctx)).length;
      return acc;
    },
    {} as Record<TabKey, number>
  );

  const qLower = q.toLowerCase();
  const rows = allRows
    .filter((r) => TAB_PREDICATES[tab](r, ctx))
    .filter((r) => (qLower ? r.haystack.includes(qLower) : true))
    .filter((r) => (channel ? r.channelId === Number(channel) : true))
    .filter((r) => (roomType ? r.roomTypeId === Number(roomType) : true))
    .filter((r) => (from ? r.checkInDate >= from : true))
    .filter((r) => (to ? r.checkInDate <= to : true))
    .sort(
      (a, b) =>
        b.checkInDate.localeCompare(a.checkInDate) ||
        a.kind.localeCompare(b.kind) ||
        b.id - a.id
    );

  const total = rows.length;
  const roomTotal = rows.reduce((sum, r) => sum + r.roomCount, 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const channels = all<{ id: number; name: string }>(
    `SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  const roomTypes = all<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );

  /* 换房可选空房：空净 / 空脏 */
  const vacantRooms: RoomOption[] = all<{
    id: number;
    room_no: string;
    room_type_name: string | null;
  }>(
    `SELECT r.id, r.room_no, rt.name AS room_type_name
       FROM rooms r
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = ? AND r.status IN ('VC', 'VD')
      ORDER BY r.floor, r.room_no`,
    [hotelId]
  ).map((r) => ({ id: r.id, label: `${r.room_no} · ${r.room_type_name ?? "未分房型"}` }));

  /* 联房可选的其他在住入住单 */
  const inHouseStays: StayOption[] = all<{
    id: number;
    room_no: string;
    guest_name: string | null;
  }>(
    `SELECT s.id, r.room_no, s.guest_name
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
      ORDER BY r.floor, r.room_no`,
    [hotelId]
  ).map((s) => ({ id: s.id, label: `${s.room_no} · ${s.guest_name ?? "客人"}` }));

  const state: OrderFilters = { ...filters, page };
  const activeTab = ALL_TABS.find((t) => t.key === tab);
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(
    `\uFEFF${toCsv(rows)}`
  )}`;
  const csvName = `订单列表-${today}.csv`;
  const exportHref = `${hrefFor(state, { page: 1 })}&export=1`;
  const advancedHref = hrefFor(state, { advanced: !advanced, page: 1 });
  const hasFilter = Boolean(q || channel || roomType || from || to);

  const pageNumbers: number[] = [];
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const pageEnd = Math.min(totalPages, pageStart + 4);
  for (let i = pageStart; i <= pageEnd; i += 1) pageNumbers.push(i);

  const sidebarItem = (t: TabDef) => {
    const active = t.key === tab;
    return (
      <li key={t.key}>
        <Link
          href={hrefFor(state, { tab: t.key, page: 1 })}
          aria-current={active ? "page" : undefined}
          className={`flex items-center justify-between border-l-[3px] py-[7px] pl-3 pr-2 text-[13px] transition-colors ${
            active
              ? "border-[#32c141] bg-[#f2f8f4] font-medium text-[#1f2937]"
              : "border-transparent text-[#5f6b76] hover:bg-[#f7f9f8] hover:text-[#1f2937]"
          }`}
        >
          <span className="truncate">{t.label}</span>
          <span
            className={`ml-2 shrink-0 text-[11px] tabular-nums ${
              active ? "text-[#3f4a54]" : "text-[#9aa4ae]"
            }`}
          >
            {counts[t.key]}
          </span>
        </Link>
      </li>
    );
  };

  return (
    <div className="flex min-h-full items-start bg-[#f2f4f7]">
      {/* ------------------------------------------------ 左侧菜单 200px */}
      <aside className="sticky top-0 w-[200px] shrink-0 self-stretch border-r border-[#eee] bg-white pb-4">
        <p className="px-3 pb-1 pt-3 text-[12px] font-medium tracking-wide text-[#9aa4ae]">
          今日待办
        </p>
        <ul>{TODO_TABS.map(sidebarItem)}</ul>

        <p className="px-3 pb-1 pt-4 text-[12px] font-medium tracking-wide text-[#9aa4ae]">状态</p>
        <ul>{STATUS_TABS.map(sidebarItem)}</ul>
      </aside>

      {/* -------------------------------------------------------- 主区 */}
      <div className="min-w-0 flex-1">
        {/* 隐私提示条 */}
        <div className="mx-3 mt-2 rounded-[2px] border border-[#f5e6a8] bg-[#fffceb] px-3 py-1.5 text-[12px] leading-5 text-[#59675f]">
          <span className="mr-1 font-semibold text-[#e23b3b]">温馨提示：</span>
          为保护住客隐私，查询离店后的入住数据，请务必验证手机号码一致性。可引导客人使用【微管家】小程序自助查询和在线申请开票等操作。
        </div>

        {exported && (
          <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-[2px] border border-[#b8e4c0] bg-[#f2f8f4] px-3 py-2 text-[12px] text-[#3f4a54]">
            <span className="font-medium">已导出 {total} 条订单（CSV）</span>
            <a
              href={csvHref}
              download={csvName}
              className="rounded-[2px] border border-[#32c141] bg-white px-2 py-0.5 text-[#32c141] hover:bg-[#e8f7ea]"
            >
              下载 {csvName}
            </a>
            <Link
              href={hrefFor(state, { page: 1 })}
              className="text-[12px] text-[#5f6b76] underline-offset-2 hover:underline"
            >
              收起
            </Link>
          </div>
        )}

        <div className="px-3 pb-3 pt-2">
          <div className="overflow-hidden rounded-[2px] border border-[#e5e7eb] bg-white">
            {/* -------------------------------------- 快速查询 */}
            <form action="/orders" method="get" className="border-b border-[#eee] px-3 py-2.5">
              <input type="hidden" name="tab" value={tab} />
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
                  href={advancedHref}
                  className="inline-flex items-center gap-0.5 text-[12px] text-[#8a949e] hover:text-[#32c141]"
                >
                  更多筛选条件
                  <Chevron up={advanced} />
                </Link>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Link
                    href={hrefFor(state, { tab: "old-left", page: 1 })}
                    className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
                  >
                    一年前离店订单查询
                  </Link>
                  <Link
                    href={exportHref}
                    className="inline-flex h-[30px] items-center gap-1 rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
                  >
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
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
                </div>
              </div>

              {advanced && (
                <div className="mt-2 rounded-[2px] border border-[#e5e7eb] bg-[#fafbfc] p-2.5">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-[#9aa4ae]">入住日期（起）</span>
                      <input
                        type="date"
                        name="from"
                        defaultValue={from}
                        className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-[#9aa4ae]">入住日期（止）</span>
                      <input
                        type="date"
                        name="to"
                        defaultValue={to}
                        className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-[#9aa4ae]">房型</span>
                      <select
                        name="roomType"
                        defaultValue={roomType}
                        className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]"
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
                        className="h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]"
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
                      href={hrefFor(state, {
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

            {/* -------------------------------------- 统计 + 表格 */}
            <div className="flex flex-wrap items-center gap-5 border-b border-[#eee] px-3 py-2 text-[12px] text-[#3f4a54]">
              <span>订单数：{total}</span>
              <span>房间数：{roomTotal}</span>
              {activeTab && activeTab.key !== "all" && (
                <span className="rounded-[2px] border border-[#b8e4c0] bg-[#e8f7ea] px-1.5 py-0.5 text-[11px] text-[#32c141]">
                  {activeTab.label}
                </span>
              )}
              {hasFilter && (
                <span className="text-[11px] text-[#9aa4ae]">
                  已应用筛选：{[q && `关键词「${q}」`, channel && "渠道", roomType && "房型", (from || to) && "日期区间"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
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
                    <th className={TH}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={11}
                        className="border-t border-[#eee] px-3 py-12 text-center text-[12px] text-[#9aa4ae]"
                      >
                        没有符合条件的订单
                        <div className="mt-1 text-[11px] text-[#9aa4ae]">
                          {hasFilter
                            ? "试试调整关键词、日期区间或渠道/房型筛选"
                            : `「${activeTab ? activeTab.label : "当前"}」暂无订单，其他分组可能还有数据`}
                        </div>
                        <div className="mt-3 flex items-center justify-center gap-2">
                          {hasFilter && (
                            <Link
                              href={hrefFor(state, {
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
                            href={hrefFor(state, { tab: "all", page: 1 })}
                            className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                          >
                            查看全部订单
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )}

                  {pageRows.map((r) => (
                    <tr key={r.key} className="align-middle hover:bg-[#fafcfb]">
                      <td className={TD}>
                        <span
                          className={`inline-flex items-center rounded-[2px] border px-1.5 py-0.5 text-[11px] leading-[16px] ${r.statusCls}`}
                        >
                          {r.statusLabel}
                        </span>
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
                        <div className="flex items-center gap-1 text-[11px] tabular-nums leading-[17px] text-[#9aa4ae]">
                          <span>{r.guestMobile}</span>
                        </div>
                      </td>

                      <td className={`${TD} text-[#5f6b76]`}>{r.stayType}</td>

                      <td className={TD}>
                        <div className="text-[#3f4a54]">
                          {r.roomTypeName}
                          {r.roomNo ? (
                            <span className="ml-1 text-[#5f6b76]">{r.roomNo}</span>
                          ) : (
                            <span className="ml-1 rounded-[2px] bg-[#fdf6ea] px-1 text-[10px] leading-[16px] text-[#b07d2e]">
                              未排房
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] tabular-nums leading-[17px]">
                          <span className="text-[#3f4a54]">{fmtMoney(r.rate)}</span>
                          <span className="ml-1 text-[#9aa4ae]">{r.roomCount} 间</span>
                        </div>
                      </td>

                      <td className={`${TD} tabular-nums`}>
                        <div className="text-[#3f4a54]">
                          <span className="text-[#9aa4ae]">入住 </span>
                          {r.checkInDisplay || "—"}
                        </div>
                        <div className="text-[#3f4a54]">
                          <span className="text-[#9aa4ae]">离店 </span>
                          {r.checkOutDisplay}
                        </div>
                      </td>

                      <td className={`${TD} tabular-nums`}>
                        {r.balance > 0.009 ? (
                          <span className="font-medium text-[#e23b3b]">{fmtMoney(r.balance)}</span>
                        ) : (
                          <span className="text-[#3f4a54]">{fmtMoney(r.balance)}</span>
                        )}
                      </td>

                      <td className={`${TD} text-[#5f6b76]`}>{r.invoiceParty}</td>

                      <td className={TD}>
                        <OrderActions
                          detail={toDetail(r)}
                          vacantRooms={vacantRooms}
                          inHouseStays={inHouseStays}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* -------------------------------------- 分页 */}
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[#eee] px-3 py-2 text-[12px] text-[#8a949e]">
              <span>
                共 <span className="tabular-nums text-[#3f4a54]">{total}</span> 条
                {hasFilter ? "（已按筛选条件缩小）" : ""}
              </span>
              <div className="flex items-center gap-1">
                <Link
                  href={hrefFor(state, { page: Math.max(1, page - 1) })}
                  aria-disabled={page <= 1}
                  aria-label="上一页"
                  className={`flex h-6 min-w-6 items-center justify-center rounded-[2px] border px-1.5 ${
                    page <= 1
                      ? "pointer-events-none border-[#eee] text-[#d3d8dd]"
                      : "border-[#e0e4e8] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                  }`}
                >
                  ‹
                </Link>
                {pageNumbers.map((n) => (
                  <Link
                    key={n}
                    href={hrefFor(state, { page: n })}
                    aria-current={n === page ? "page" : undefined}
                    className={`flex h-6 min-w-6 items-center justify-center rounded-[2px] border px-1.5 tabular-nums ${
                      n === page
                        ? "border-[#32c141] bg-[#32c141] font-medium text-white"
                        : "border-[#e0e4e8] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                    }`}
                  >
                    {n}
                  </Link>
                ))}
                <Link
                  href={hrefFor(state, { page: Math.min(totalPages, page + 1) })}
                  aria-disabled={page >= totalPages}
                  aria-label="下一页"
                  className={`flex h-6 min-w-6 items-center justify-center rounded-[2px] border px-1.5 ${
                    page >= totalPages
                      ? "pointer-events-none border-[#eee] text-[#d3d8dd]"
                      : "border-[#e0e4e8] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                  }`}
                >
                  ›
                </Link>
              </div>
            </div>
          </div>

          <p className="mt-2 text-[11px] text-[#9aa4ae]">
            共 {allRows.length} 条订单记录 · 每页 {PAGE_SIZE} 条 · 手机号已脱敏展示（
            {"138****1234"}）· 在住数据关联账务单余额
          </p>
        </div>
      </div>
    </div>
  );
}
