import Link from "next/link";
import { Fragment } from "react";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, nightsBetween } from "@/lib/utils";
import { demoSeedEnabled } from "@/lib/channels/demo-mode";
import { importChannelOrderAction, pushChannelOrderStatusAction, seedChannelOrdersAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

/* --------------------------------------------------------------- 类型 */

type SearchParams = Record<string, string | string[] | undefined>;

type ChannelOrderRow = {
  id: number;
  channel_type: string;
  channel_order_no: string;
  room_type_id: number | null;
  room_type_name: string | null;
  guest_name: string | null;
  mobile: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
  nights: number | null;
  room_count: number | null;
  amount: number | null;
  status: string;
  booking_id: number | null;
  raw: string | null;
  created_at: string | null;
  imported_at: string | null;
};

type ChannelMeta = { label: string; bg: string; color: string };

type StatusMeta = { label: string; cls: string };

type ViewRow = {
  id: number;
  channelKey: string;
  channelLabel: string;
  channelBg: string;
  channelColor: string;
  orderNo: string;
  statusKey: string;
  statusLabel: string;
  statusCls: string;
  guestName: string;
  mobile: string;
  mobileMasked: string;
  checkIn: string;
  checkOut: string;
  checkInMd: string;
  checkOutMd: string;
  nights: number;
  latestArrival: string;
  bookedAt: string;
  createdAt: string;
  roomTypeName: string;
  roomTypeCode: string;
  breakfast: string;
  roomCount: number;
  payType: string;
  amount: number;
  bookingId: number | null;
  raw: string;
  haystack: string;
};

type Filters = {
  q: string;
  channel: string;
  status: string;
  type: "in" | "out";
  from: string;
  to: string;
  pending: boolean;
  sort: string;
  page: number;
  detail: number;
};

type Query = Record<string, string>;

/* ----------------------------------------------------------- 常量表 */

const CHANNEL_META: Record<string, ChannelMeta> = {
  ctrip: { label: "携程", bg: "#2f6fed", color: "#ffffff" },
  meituan: { label: "美团", bg: "#f59e0b", color: "#ffffff" },
  douyin: { label: "抖音", bg: "#161823", color: "#ffffff" },
  qunar: { label: "去哪儿", bg: "#0e7ad6", color: "#ffffff" },
  elong: { label: "艺龙", bg: "#8b5cf6", color: "#ffffff" },
  direct: { label: "直订", bg: "#059669", color: "#ffffff" },
};

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "ctrip", label: "携程" },
  { value: "meituan", label: "美团" },
  { value: "douyin", label: "抖音" },
];

/** 渠道订单状态：NEW→待确认、CONFIRMED→已确认、IMPORTED→已入住、CANCELLED→已取消 */
const STATUS_META: Record<string, StatusMeta> = {
  NEW: { label: "待确认", cls: "border border-amber-200 bg-amber-50 text-amber-700" },
  CONFIRMED: { label: "已确认", cls: "border border-[#2f6fed] bg-[#2f6fed] text-white" },
  IMPORTED: { label: "已入住", cls: "border border-emerald-200 bg-emerald-50 text-emerald-700" },
  CANCELLED: { label: "已取消", cls: "border border-gray-300 bg-white text-gray-400" },
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "CONFIRMED", label: "已确认" },
  { value: "NEW", label: "待确认" },
  { value: "CANCELLED", label: "已取消" },
  { value: "IMPORTED", label: "已入住" },
];

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "created_desc", label: "按创建时间从晚到早" },
  { value: "created_asc", label: "按创建时间从早到晚" },
  { value: "stay", label: "按入离日期" },
];

const ALLOWED_CHANNEL: readonly string[] = ["ctrip", "meituan", "douyin", "direct"];
const ALLOWED_STATUS: readonly string[] = ["NEW", "CONFIRMED", "IMPORTED", "CANCELLED"];
const ALLOWED_SORT: readonly string[] = ["created_desc", "created_asc", "stay"];

/** 渠道侧默认收款方式（raw 里有值时以 raw 为准） */
const CHANNEL_PAY: Record<string, string> = { ctrip: "预付", meituan: "预付", douyin: "到店付" };

/* ------------------------------------------------------------- 工具 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

function pick(sp: SearchParams, key: string): string {
  const value = sp[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

function parseFilters(sp: SearchParams): Filters {
  const channel = pick(sp, "channel");
  const status = pick(sp, "status");
  const sort = pick(sp, "sort");
  const type = pick(sp, "type") === "in" ? "in" : "out";
  const from = pick(sp, "from");
  const to = pick(sp, "to");
  const rawPage = Number(pick(sp, "page"));
  const detail = Number(pick(sp, "detail"));

  return {
    q: pick(sp, "q").trim().slice(0, 60),
    channel: ALLOWED_CHANNEL.includes(channel) ? channel : "",
    status: ALLOWED_STATUS.includes(status) ? status : "",
    type,
    from: isDate(from) ? from : "",
    to: isDate(to) ? to : "",
    pending: pick(sp, "pending") === "1",
    sort: ALLOWED_SORT.includes(sort) ? sort : "created_desc",
    page: Number.isFinite(rawPage) && rawPage > 0 ? Math.trunc(rawPage) : 1,
    detail: Number.isFinite(detail) && detail > 0 ? Math.trunc(detail) : 0,
  };
}

/** 在保留现有查询条件的前提下拼接新链接 */
function hrefWith(base: Query, patch: Partial<Query>): string {
  const merged: Record<string, string | undefined> = { ...base, ...patch };
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) usp.set(key, value);
  }
  const qs = usp.toString();
  return qs ? `/channel-orders?${qs}` : "/channel-orders";
}

/** 原始数据字符串 → 普通对象，非 JSON 一律当空对象 */
function parseRaw(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 原始数据不是合法 JSON，按空对象处理
  }
  return {};
}

function readStr(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function readInt(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/** YYYY-MM-DD → MM-DD */
function monthDay(value: string | null): string {
  const text = (value ?? "").trim();
  if (text.length < 10) return "—";
  return `${text.slice(5, 7)}-${text.slice(8, 10)}`;
}

/** ISO → MM-DD HH:mm（本地时间） */
function monthDayTime(value: string | null): string {
  const text = (value ?? "").trim();
  if (!text) return "—";
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text.slice(0, 16).replace("T", " ");
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 手机号脱敏：138****0001 */
function maskMobile(value: string | null): string {
  const text = (value ?? "").replace(/\s/g, "");
  if (!text) return "—";
  if (text.length >= 7) return `${text.slice(0, 3)}****${text.slice(-4)}`;
  return text;
}

function prettyJson(raw: string | null): string {
  if (!raw) return "（该订单没有原始报文）";
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 页码窗口：1 … 4 5 [6] 7 8 … 20 */
function pageWindow(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set<number>([1, total, current - 2, current - 1, current, current + 1, current + 2]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let prev = 0;
  for (const n of pages) {
    if (prev !== 0 && n - prev > 1) out.push("gap");
    out.push(n);
    prev = n;
  }
  return out;
}

function toViewRow(row: ChannelOrderRow): ViewRow {
  const meta = CHANNEL_META[row.channel_type] ?? {
    label: row.channel_type || "其他",
    bg: "#e5e7eb",
    color: "#4b5563",
  };
  const statusKey = row.status in STATUS_META ? row.status : "NEW";
  const status = STATUS_META[statusKey] ?? STATUS_META.NEW;
  const raw = parseRaw(row.raw);

  const nights =
    row.nights && row.nights > 0
      ? row.nights
      : row.check_in_date && row.check_out_date
        ? nightsBetween(row.check_in_date, row.check_out_date)
        : 0;

  const breakfastCount = readInt(raw, ["breakfast", "breakfast_count"]);
  const breakfast =
    breakfastCount === null ? readStr(raw, ["breakfast", "breakfastText"]) || "双早" : `${breakfastCount}早`;

  const roomTypeName = row.room_type_name || readStr(raw, ["roomTypeName", "room_type_name"]) || "未指定房型";

  return {
    id: row.id,
    channelKey: row.channel_type,
    channelLabel: meta.label,
    channelBg: meta.bg,
    channelColor: meta.color,
    orderNo: row.channel_order_no || "—",
    statusKey,
    statusLabel: status.label,
    statusCls: status.cls,
    guestName: row.guest_name ?? "—",
    mobile: row.mobile ?? "",
    mobileMasked: maskMobile(row.mobile),
    checkIn: row.check_in_date ?? "",
    checkOut: row.check_out_date ?? "",
    checkInMd: monthDay(row.check_in_date),
    checkOutMd: monthDay(row.check_out_date),
    nights,
    latestArrival: readStr(raw, ["latestArrival", "latest_arrival", "arrivalTime"]) || "06:00",
    bookedAt: monthDayTime(row.created_at),
    createdAt: (row.created_at ?? "").trim(),
    roomTypeName,
    roomTypeCode: readStr(raw, ["roomTypeCode", "room_type_code"]),
    breakfast,
    roomCount: row.room_count && row.room_count > 0 ? row.room_count : 1,
    payType: readStr(raw, ["payType", "pay_type"]) || CHANNEL_PAY[row.channel_type] || "预付",
    amount: Number(row.amount ?? 0),
    bookingId: row.booking_id,
    raw: row.raw ?? "",
    haystack: `${row.guest_name ?? ""} ${row.mobile ?? ""} ${row.channel_order_no} ${meta.label} ${roomTypeName}`.toLowerCase(),
  };
}

/* --------------------------------------------------------- 页面组件 */

export default async function ChannelOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  const filters = parseFilters(await searchParams);

  const rows = all<ChannelOrderRow>(
    `SELECT o.id, o.channel_type, o.channel_order_no, o.room_type_id, rt.name AS room_type_name,
            o.guest_name, o.mobile, o.check_in_date, o.check_out_date, o.nights, o.room_count,
            o.amount, o.status, o.booking_id, o.raw, o.created_at, o.imported_at
     FROM channel_orders o
     LEFT JOIN room_types rt ON rt.id = o.room_type_id
     WHERE o.hotel_id = ?
     ORDER BY o.id DESC
     LIMIT 2000`,
    [user.hotelId]
  );

  const viewRows = rows.map(toViewRow);
  const pendingCount = viewRows.filter((r) => r.statusKey === "NEW").length;

  const needle = filters.q.toLowerCase();
  const filtered = viewRows.filter((r) => {
    if (filters.pending && r.statusKey !== "NEW") return false;
    if (filters.channel && r.channelKey !== filters.channel) return false;
    if (filters.status && r.statusKey !== filters.status) return false;
    if (needle && !r.haystack.includes(needle)) return false;
    if (filters.from || filters.to) {
      const target = filters.type === "in" ? r.checkIn : r.checkOut;
      if (!target) return false;
      if (filters.from && target < filters.from) return false;
      if (filters.to && target > filters.to) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (filters.sort === "created_asc") {
      return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
    }
    if (filters.sort === "stay") {
      return (
        (a.checkIn || "9999-99-99").localeCompare(b.checkIn || "9999-99-99") ||
        (a.checkOut || "9999-99-99").localeCompare(b.checkOut || "9999-99-99") ||
        a.id - b.id
      );
    }
    return b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const baseQuery: Query = {
    q: filters.q,
    channel: filters.channel,
    status: filters.status,
    type: filters.type,
    from: filters.from,
    to: filters.to,
    pending: filters.pending ? "1" : "",
    sort: filters.sort,
    page: String(page),
    detail: filters.detail > 0 ? String(filters.detail) : "",
  };

  const pageHref = (target: number) => hrefWith(baseQuery, { page: String(target) });
  const pendingHref = hrefWith(baseQuery, {
    pending: filters.pending ? "" : "1",
    page: "1",
    detail: "",
  });
  const clearHref = hrefWith(baseQuery, { q: "", channel: "", status: "", from: "", to: "", pending: "", page: "1", detail: "" });

  const hasFilters =
    filters.q !== "" ||
    filters.channel !== "" ||
    filters.status !== "" ||
    filters.from !== "" ||
    filters.to !== "" ||
    filters.pending;

  /* 导出当前筛选结果（CSV，UTF-8 + BOM） */
  const csvHeader = [
    "渠道",
    "渠道订单号",
    "状态",
    "客人",
    "手机",
    "入住日期",
    "离店日期",
    "晚数",
    "最晚到店",
    "预订时间",
    "房型",
    "早餐",
    "间数",
    "收款类型",
    "金额",
  ];
  const csvBody = sorted.slice(0, 500).map((r) => [
    r.channelLabel,
    r.orderNo,
    r.statusLabel,
    r.guestName,
    r.mobile,
    r.checkIn,
    r.checkOut,
    String(r.nights),
    r.latestArrival,
    r.bookedAt,
    r.roomTypeName,
    r.breakfast,
    String(r.roomCount),
    r.payType,
    r.amount.toFixed(2),
  ]);
  const csv = [csvHeader, ...csvBody].map((line) => line.map(csvCell).join(",")).join("\r\n");
  const exportHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;

  return (
    <div className="space-y-3 p-4">
      {/* 标题 + 演示数据 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">渠道预订</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            携程 / 美团 / 抖音渠道订单统一查看，待处理订单请及时确认或转入预订
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 整改清单 P1-23：这个按钮会往生产库写随机渠道订单（并可能自动建正式预订），
              只有显式 PMS_DEMO_SEED=1 才渲染 / 才执行。默认看不到入口，点也点不到。 */}
          {demoSeedEnabled() ? (
            <>
              <span className="text-[11px] text-gray-400">演示数据不足时</span>
              <form action={seedChannelOrdersAction}>
                <input type="hidden" name="count" value="20" />
                <button className="btn-default px-2.5 py-1 text-[12px]">生成演示订单</button>
              </form>
            </>
          ) : (
            <span className="text-[11px] text-gray-400">演示数据功能已关闭（PMS_DEMO_SEED=1 可开启）</span>
          )}
        </div>
      </div>

      <form method="get" action="/channel-orders" className="space-y-3">
        {/* 筛选条 */}
        <div className="card flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="relative min-w-[240px] flex-1">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              name="q"
              defaultValue={filters.q}
              placeholder="请输入姓名、电话或渠道订单号搜索"
              className="input pl-8"
            />
          </div>

          <select name="channel" defaultValue={filters.channel} className="input w-auto min-w-[120px] py-1.5 text-[12px]">
            <option value="">全部渠道</option>
            {CHANNEL_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          <select name="status" defaultValue={filters.status} className="input w-auto min-w-[120px] py-1.5 text-[12px]">
            <option value="">全部订单状态</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1.5">
            <span className="text-[12px] text-gray-500">类型</span>
            <select name="type" defaultValue={filters.type} className="input w-auto min-w-[110px] py-1.5 text-[12px]">
              <option value="out">离店日期</option>
              <option value="in">入住日期</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              name="from"
              defaultValue={filters.from}
              className="input w-auto py-1.5 text-[12px]"
              aria-label="开始日期"
            />
            <span className="text-[12px] text-gray-400">至</span>
            <input
              type="date"
              name="to"
              defaultValue={filters.to}
              className="input w-auto py-1.5 text-[12px]"
              aria-label="结束日期"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button className="btn-primary px-3 py-1.5 text-[12px]">查询</button>
            <a href={exportHref} download="渠道预订.csv" className="btn-default px-2.5 py-1.5 text-[12px]">
              <IconExport />
              导出
            </a>
          </div>
        </div>

        {/* 待处理提示条 + 排序 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-y border-gray-200 bg-white px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={pendingHref}
              aria-label={filters.pending ? "取消「只展示待处理订单」" : "只展示待处理订单"}
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
                filters.pending ? "border-amber-500 bg-amber-500 text-white" : "border-gray-300 bg-white text-transparent"
              }`}
            >
              <IconCheck />
            </Link>
            <span className="text-[12px] text-gray-700">
              只展示待处理订单(<b className="font-semibold text-amber-600">{pendingCount}</b>)
            </span>
            <span className="text-[12px] text-gray-400">注意：</span>
            <span className="text-[12px] text-red-500">
              待取消订单请及时处理，超过 30 分钟系统将按「拒绝取消」处理。
            </span>
          </div>
          <select name="sort" defaultValue={filters.sort} className="input w-auto min-w-[170px] py-1 text-[12px] text-gray-600">
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </form>

      {/* 订单表格 */}
      <div className="card overflow-x-auto">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px]">
            <thead>
              <tr>
                <th className="th">渠道</th>
                <th className="th">渠道订单号</th>
                <th className="th">状态</th>
                <th className="th">预订人/客人</th>
                <th className="th">入住日期</th>
                <th className="th">最晚到店时间</th>
                <th className="th">预订时间</th>
                <th className="th">房型</th>
                <th className="th">收款类型</th>
                <th className="th">金额共计</th>
                <th className="th text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="whitespace-normal px-4 py-16 text-center">
                    <div className="text-[13px] text-gray-500">没有匹配的渠道订单</div>
                    <div className="mt-1 text-[12px] text-gray-400">
                      {hasFilters ? (
                        <>
                          试试放宽筛选条件，或
                          <Link href={clearHref} className="mx-1 text-brand-600 hover:underline">
                            清空筛选
                          </Link>
                          后重试
                        </>
                      ) : (
                        "暂无渠道订单，点右上角「生成演示订单」生成 20 条演示数据"
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {pageRows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="hover:bg-gray-50">
                    <td className="td">
                      <span
                        className="inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium leading-none"
                        style={{ background: r.channelBg, color: r.channelColor }}
                      >
                        {r.channelLabel}
                      </span>
                    </td>
                    <td className="td font-medium tabular-nums text-gray-700">{r.orderNo}</td>
                    <td className="td">
                      <span className={`inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[11px] leading-none ${r.statusCls}`}>
                        {r.statusLabel}
                      </span>
                    </td>
                    <td className="td">
                      <div className="text-[13px] text-gray-800">{r.guestName}</div>
                    </td>
                    <td className="td">
                      <span className="tabular-nums text-gray-700">
                        {r.checkInMd} 至 {r.checkOutMd}
                      </span>
                      <span className="ml-1 text-[11px] text-gray-400">共{r.nights}晚</span>
                    </td>
                    <td className="td tabular-nums text-[#e8833a]">{r.latestArrival}</td>
                    <td className="td tabular-nums text-gray-500">{r.bookedAt}</td>
                    <td className="td">
                      <div className="max-w-[240px] truncate text-gray-700" title={r.roomTypeName}>
                        {r.roomTypeName}
                      </div>
                      <div className="text-[11px] text-gray-400">共{r.roomCount}间</div>
                    </td>
                    <td className="td text-gray-600">{r.payType}</td>
                    <td className="td font-medium tabular-nums text-rose-700">{fmtMoney(r.amount)}</td>
                    <td className="td text-center">
                      <Link
                        href={hrefWith(baseQuery, { detail: filters.detail === r.id ? "" : String(r.id) })}
                        className={
                          filters.detail === r.id
                            ? "btn-default px-2 py-0.5 text-[11px]"
                            : "inline-flex items-center justify-center rounded bg-[#58bc62] px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-[#4fae59]"
                        }
                      >
                        {filters.detail === r.id ? "收起" : "详情"}
                      </Link>
                    </td>
                  </tr>

                  {filters.detail === r.id && (
                    <tr className="bg-gray-50">
                      <td colSpan={11} className="whitespace-normal border-t border-gray-100 px-4 py-3">
                        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
                          <div>
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <span className="text-[12px] font-medium text-gray-700">
                                渠道原始信息 · {r.channelLabel} {r.orderNo}
                              </span>
                              <Link
                                href={hrefWith(baseQuery, { detail: "" })}
                                className="text-[11px] text-gray-400 hover:text-brand-600"
                              >
                                关闭
                              </Link>
                            </div>
                            <pre className="max-h-64 overflow-auto rounded-md bg-gray-900 p-3 text-[11px] leading-relaxed text-gray-100">
                              {prettyJson(r.raw)}
                            </pre>
                          </div>

                          <div className="space-y-2 rounded-md border border-gray-200 bg-white p-3">
                            <div className="text-[12px] font-medium text-gray-700">订单概要</div>
                            <dl className="grid grid-cols-2 gap-y-1 text-[12px]">
                              <dt className="text-gray-400">客人</dt>
                              <dd className="text-gray-700">{r.guestName}</dd>
                              <dt className="text-gray-400">手机</dt>
                              <dd className="tabular-nums text-gray-700">{r.mobileMasked}</dd>
                              <dt className="text-gray-400">房型</dt>
                              <dd className="text-gray-700">{r.roomTypeName}</dd>
                              <dt className="text-gray-400">入离</dt>
                              <dd className="tabular-nums text-gray-700">
                                {r.checkInMd} 至 {r.checkOutMd}（{r.nights} 晚）
                              </dd>
                              <dt className="text-gray-400">收款类型</dt>
                              <dd className="text-gray-700">{r.payType}</dd>
                              <dt className="text-gray-400">金额</dt>
                              <dd className="tabular-nums text-gray-700">{fmtMoney(r.amount)}</dd>
                              <dt className="text-gray-400">订单状态</dt>
                              <dd className="text-gray-700">{r.statusLabel}</dd>
                            </dl>

                            {r.statusKey === "NEW" || r.statusKey === "CONFIRMED" ? (
                              <form action={importChannelOrderAction}>
                                <input type="hidden" name="orderId" value={r.id} />
                                <button className="btn-primary w-full py-1.5 text-[12px]">转入预订</button>
                              </form>
                            ) : r.bookingId ? (
                              <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-center text-[12px] text-emerald-700">
                                已转入预订 #{r.bookingId}
                              </div>
                            ) : (
                              <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-center text-[12px] text-gray-400">
                                {r.statusKey === "CANCELLED" ? "订单已取消，不可转入预订" : "订单已处理，无需重复转入"}
                              </div>
                            )}

                            {/* 整改清单 P1-20：状态回传的手工触发点。
                                自动化接线在 frontdesk（入住）/ cashier（退房），
                                但补传、重传、渠道未配置后重试这些情况必须能在单据上点一次 —— 
                                没有这个入口就只能改数据库。 */}
                            {r.bookingId ? (
                              <div className="mt-1.5 rounded border border-gray-200 p-1.5">
                                <div className="mb-1 text-[11px] text-gray-500">回传渠道状态</div>
                                <div className="grid grid-cols-3 gap-1">
                                  {[
                                    { status: "CHECKED_IN", label: "已入住" },
                                    { status: "CHECKED_OUT", label: "已退房" },
                                    { status: "NOSHOW", label: "未到店" },
                                  ].map((item) => (
                                    <form key={item.status} action={pushChannelOrderStatusAction}>
                                      <input type="hidden" name="orderId" value={r.id} />
                                      <input type="hidden" name="status" value={item.status} />
                                      <button className="w-full rounded-[3px] border border-gray-200 py-0.5 text-[11px] text-gray-600 hover:border-emerald-400 hover:text-emerald-700">
                                        {item.label}
                                      </button>
                                    </form>
                                  ))}
                                </div>
                                <div className="mt-1 text-[10px] text-gray-400">
                                  渠道确认后本地状态才会同步变更，失败原因见「渠道管理 / 最近同步记录」
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2">
          <div className="text-[12px] text-gray-500">
            共 {sorted.length} 条
            <span className="mx-1 text-gray-300">·</span>
            每页 {PAGE_SIZE} 条
            <span className="mx-1 text-gray-300">·</span>
            第 {page}/{totalPages} 页
          </div>
          <div className="flex items-center gap-1">
            <PageStep enabled={page > 1} href={pageHref(page - 1)} label="上一页" />
            {pageWindow(page, totalPages).map((p, index) =>
              p === "gap" ? (
                <span key={`gap-${index}`} className="px-1 text-[12px] text-gray-400">
                  …
                </span>
              ) : p === page ? (
                <span
                  key={p}
                  className="inline-flex h-6 min-w-6 items-center justify-center rounded bg-brand-600 px-1.5 text-[12px] font-medium text-white"
                >
                  {p}
                </span>
              ) : (
                <Link
                  key={p}
                  href={pageHref(p)}
                  className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-gray-200 bg-white px-1.5 text-[12px] text-gray-600 transition-colors hover:border-brand-400 hover:text-brand-600"
                >
                  {p}
                </Link>
              )
            )}
            <PageStep enabled={page < totalPages} href={pageHref(page + 1)} label="下一页" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 小图标 */

function PageStep({ enabled, href, label }: { enabled: boolean; href: string; label: string }) {
  if (!enabled) {
    return (
      <span className="inline-flex h-6 items-center justify-center rounded border border-gray-100 bg-gray-50 px-1.5 text-[12px] text-gray-300">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex h-6 items-center justify-center rounded border border-gray-200 bg-white px-1.5 text-[12px] text-gray-600 transition-colors hover:border-brand-400 hover:text-brand-600"
    >
      {label}
    </Link>
  );
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      width="14"
      height="14"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M12.8 12.8 17 17" strokeLinecap="round" />
    </svg>
  );
}

function IconExport() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="13"
      height="13"
      aria-hidden="true"
    >
      <path d="M10 12.5V3.5M10 3.5 6.5 7M10 3.5 13.5 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 12.5v2.2c0 .8.6 1.3 1.3 1.3h10.4c.7 0 1.3-.5 1.3-1.3v-2.2" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" width="9" height="9" aria-hidden="true">
      <path d="M2 6.2 4.6 8.8 10 3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
