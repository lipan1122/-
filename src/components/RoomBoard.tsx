"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import ConfirmForm from "@/components/ConfirmForm";
import {
  addCompanionAction,
  addDepositAction,
  addOtherChargeAction,
  addRoomFeeAction,
  adjustRateAction,
  cancelCheckinAction,
  changeStayRoomAction,
  completeRoomAction,
  exchangeRoomAction,
  extendStayAction,
  joinTeamAction,
  linkRoomsAction,
  makeLockCardAction,
  memberRechargeAction,
  modifyGuestAction,
  modifyStayAction,
  registerMemberAction,
  sendSmsAction,
  setRoomStatusAction,
  setWakeUpAction,
  toHourlyAction,
  updateCheckoutAction,
} from "@/app/(main)/rooms/actions";
import { ROOM_TAGS, matchesRoomTag, type RoomTagKey } from "@/lib/room-tags";
import { ROOM_STATUS, fmtMoney, todayStr } from "@/lib/utils";

export type RoomRow = {
  id: number;
  room_no: string;
  floor: number;
  status: string;
  feature: string | null;
  room_type_id: number;
  room_type_name: string;
  room_type_code: string;
  stay_id: number | null;
  stay_no: string | null;
  guest_name: string | null;
  /** 在住客人手机号（stays.mobile），悬浮层里脱敏展示 */
  mobile: string | null;
  expect_check_out: string | null;
  check_in_time: string | null;
  rate: number | null;
  channel_name: string | null;
  balance: number | null;
  folio_id: number | null;
  nights: number | null;
  rate_code: string | null;
  team_name: string | null;
  /** 悬浮操作面板用的账务与备注字段 */
  booking_id?: number | null;
  breakfast?: number | null;
  invoice_party?: string | null;
  remark?: string | null;
  deposit?: number | null;
  pay_type?: string | null;
  member_card?: string | null;
  consume_amount?: number | null;
  paid_amount?: number | null;
  link_rooms?: string | null;
  /** 渠道订单号（stays.channel_order_no），渠道直连单才有值 */
  channel_order_no?: string | null;
  /**
   * 快捷标签判定字段（第 5 轮 P1-4）
   *
   * 由 rooms/page.tsx 按 `@/lib/room-tags` 的 ROOM_TAG_FIELD_SQL 算好，
   * 客户端点击标签时用 matchesRoomTag 过滤，与左侧数量同口径。
   */
  link_room_count?: number | null;
  guest_vip_level?: number | null;
  guest_id_no?: string | null;
  guest_stay_count?: number | null;
  hk_pending?: number | null;
  pending_cancel_count?: number | null;
  /** 门锁通讯信号：GOOD / BAD / LOW */
  lock_signal: string | null;
  /** 门锁电量百分比 */
  lock_battery: number | null;
  lock_status: string | null;
  link_count: number;
};

export type ArrivalRow = {
  id: number;
  room_id: number | null;
  guest_name: string;
  room_type_name: string;
  booking_no: string;
  rate: number;
  /** 预抵订单手机号（bookings.mobile），仅用于悬浮层展示 */
  mobile: string | null;
  /** 渠道名（去呼呼预抵卡片会显示渠道标签） */
  channel_name?: string | null;
  check_in_date?: string | null;
  arrival_time?: string | null;
};

/**
 * 12 个快捷标签的房间数（第 5 轮 P1-4）
 *
 * 全部由服务端 SQL 汇总后传入（rooms/page.tsx），前端不写死；
 * 缺字段的标签（自用 / 打扫中）恒为 0，界面灰显。
 */
export type TagStats = Record<RoomTagKey, number>;

/**
 * 当日经营指标（第 5 轮 P1-1）
 *
 * 出租率的分子分母都由 `src/lib/metrics.ts` 算好再传下来：
 * 那个模块 import 了 `@/lib/db`，属于服务端模块，客户端组件不能直接引用，
 * 所以房态页（服务端组件）算完通过 props 传 —— 客户端只渲染，不自己算分母。
 */
export type DayMetrics = {
  /** 总房量（含维修房 / 锁房） */
  totalRooms: number;
  /** 可售房量 = 总房量 − 维修房(OOO) − 锁房(LOCK) */
  sellableRooms: number;
  /** 出租间夜（不含钟点房） */
  roomNights: number;
  /** 已售房量 = 出租间夜 / 统计天数（单日等于出租间夜） */
  roomsSold: number;
  /** 出租率 0-1 */
  occupancy: number;
};

type Props = {
  rooms: RoomRow[];
  arrivals: ArrivalRow[];
  departures: { room_id: number; guest_name: string }[];
  roomTypes: { id: number; name: string; count: number }[];
  channels: { name: string; count: number }[];
  tagStats: TagStats;
  /** 当日经营指标（出租率口径统一走 metrics.ts） */
  dayMetrics?: DayMetrics;
  initialStatus?: string;
  /** 底部功能条四个角标的真实计数（去呼呼这里也是实时数） */
  badgeCounts?: { orders: number; tasks: number; shop: number; alerts: number };
  /** 四个入口点开的列表条目 */
  badgeList?: Record<"orders" | "tasks" | "shop" | "alerts", { id: number; title: string; sub: string; href: string }[]>;
  /** 悬浮面板「财务明细」用：入住单流水 */
  stayFlows?: Record<number, { kind: string; label: string; amount: number; biz_date: string | null }[]>;
  /**
   * 待排房订单（整改指令 3.2「房态页排房」）
   *
   * 房态图里直接给这些订单排房，前台不用切到订单页。
   * 数据由 rooms/page.tsx 查好传入，交互复用订单页的 AssignRoomModal。
   */
  pendingBookings?: PendingBookingRow[];
};

export type PendingBookingRow = {
  id: number;
  booking_no: string;
  guest_name: string;
  room_type_id: number | null;
  room_type_name: string | null;
  check_in_date: string;
  check_out_date: string;
  room_count: number | null;
};

/** 订单操作类 server action 的返回结构（与 rooms/actions.ts 保持一致） */
type ActionResult = { error?: string; ok?: string } | undefined;
type ActionFn = (formData: FormData) => Promise<ActionResult>;

type Notice = { kind: "ok" | "error"; text: string };

const PAY_METHODS = ["现金", "微信", "支付宝", "银行卡", "挂账"];

const FILTERS = [
  { key: "all", label: "全部房间", short: "全部", color: "" },
  { key: "VC", label: "空净房", short: "空净", color: "bg-white" },
  { key: "VD", label: "空脏房", short: "空脏", color: "bg-[#4b4b4b]" },
  { key: "OC", label: "住净房", short: "住净", color: "bg-[#4A90E2]" },
  { key: "OD", label: "住脏房", short: "住脏", color: "bg-[#9013FE]" },
  { key: "OOO", label: "维修房", short: "维修", color: "bg-[#c99a2e]" },
  { key: "LOCK", label: "锁房", short: "锁房", color: "bg-[#9aa3af]" },
];


/** 底部功能条左侧：真实入口（角标用数据库实时计数，与去呼呼一致） */
const bottomLinks = (c: { orders: number; tasks: number; shop: number; alerts: number }) => [
  { label: "直连订单", badge: c.orders > 99 ? "99+" : String(c.orders), tone: (c.orders > 0 ? "red" : "grey") as "red" | "grey", href: "/channel-orders" },
  { label: "前台任务", badge: String(c.tasks), tone: (c.tasks > 0 ? "red" : "grey") as "red" | "grey", href: "/today-todo" },
  { label: "小商超", badge: String(c.shop), tone: (c.shop > 0 ? "red" : "grey") as "red" | "grey", href: "/shop" },
  { label: "异常事件", badge: String(c.alerts), tone: (c.alerts > 0 ? "red" : "grey") as "red" | "grey", href: "/logs" },
];

/** 底部功能条左侧：绿色实底按钮（房态设置是弹窗，见 RoomStatusSettings） */
const BOTTOM_SOLIDS: { label: string; href?: string; modal?: boolean }[] = [
  { label: "房态设置", modal: true },
  { label: "保洁中心", href: "/housekeeping" },
  { label: "维修房管理", href: "/rooms?filter=OOO" },
];

/** 房态设置弹窗的配置（存 localStorage） */
type BoardConfig = {
  colors: Record<string, string>;
  sortBy: "floor" | "type" | "room";
  size: "large" | "medium" | "small";
};

const DEFAULT_BOARD_CONFIG: BoardConfig = {
  colors: {
    VC: "#ffffff",
    VD: "#4b4b4b",
    BOOKING: "#b6e388",
    OC: "#4A90E2",
    OD: "#9013FE",
    OOO: "#c99a2e",
    LOCK: "#9aa3af",
  },
  sortBy: "floor",
  size: "medium",
};

const BOARD_CFG_KEY = "pms.roomboard.config";

function loadBoardConfig(): BoardConfig {
  if (typeof window === "undefined") return DEFAULT_BOARD_CONFIG;
  try {
    const raw = window.localStorage.getItem(BOARD_CFG_KEY);
    if (!raw) return DEFAULT_BOARD_CONFIG;
    const parsed = JSON.parse(raw) as Partial<BoardConfig>;
    return {
      colors: { ...DEFAULT_BOARD_CONFIG.colors, ...(parsed.colors ?? {}) },
      sortBy: parsed.sortBy === "type" || parsed.sortBy === "room" ? parsed.sortBy : "floor",
      size: parsed.size === "large" || parsed.size === "small" ? parsed.size : "medium",
    };
  } catch {
    return DEFAULT_BOARD_CONFIG;
  }
}

/*
 * 快捷标签定义（第 5 轮 P1-4）
 *
 * 12 个标签的 key / 文案 / 判定说明 / 是否可用统一放在 `@/lib/room-tags`，
 * 服务端统计与客户端筛选共用同一份定义，避免两边各写一套。
 * 缺字段的两个标签（自用 / 打扫中）在该文件里 available=false，界面灰显。
 */
const FLOOR_NAMES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function floorLabel(floor: number) {
  return FLOOR_NAMES[floor - 1] ?? String(floor);
}

function daysToCheckout(expect: string | null) {
  if (!expect) return 0;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const e = new Date(`${expect}T00:00:00`);
  return Math.round((e.getTime() - t.getTime()) / 86400000);
}

/** 钟点房：晚数为 0 或价码标记为钟点 */
function isHourlyRoom(room: RoomRow) {
  return room.nights === 0 || room.rate_code === "钟点";
}

/**
 * 房态卡片用的紧凑金额（第 5 轮 P2-2）
 *
 * 卡片只有 160px 宽，fmtMoney 的「¥1,234.00」带两位小数太长会被裁，
 * 这里去掉无意义的 .00、保留千分位；有小数才显示小数（12.5）。
 * 只是展示用，正式账单金额一律走 fmtMoney，未经手任何计算。
 */
function fmtMoneyShort(n: number | null | undefined) {
  const v = Math.round(Number(n ?? 0) * 100) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 手机号脱敏：138****0001 */
function maskMobile(mobile: string | null | undefined) {
  const s = (mobile ?? "").trim();
  if (!s) return "-";
  if (s.length < 7) return s;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 统一成 yyyy-mm-dd（check_in_time 是 ISO 时间串，expect_check_out 已是日期） */
/** 悬浮面板「入 住」用：日期 + 时分（去呼呼显示 2026-11-15 12:28） */
function fmtDateTime(value: string | null | undefined) {
  const s = (value ?? "").trim();
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(value: string | null | undefined) {
  const s = (value ?? "").trim();
  if (!s) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 顶部横排「渠道筛选」的固定顺序（与去呼呼房态页一致），
 * 后面再接数据里真实存在、但不在固定清单中的渠道（如艺龙 / 协议单位）。
 */
const CHANNEL_PRESETS = ["线下客人", "携程", "美团", "去哪儿", "抖音"];

/** 渠道匹配：线下客人 = 无渠道或散客 */
function matchChannel(room: RoomRow, key: string) {
  if (key === "线下客人") return !room.channel_name || room.channel_name === "散客";
  return room.channel_name === key;
}

/** 悬浮层定位结果：left / top 是视口坐标，above 表示向上弹 */
type HoverCard = { room: RoomRow; left: number; top: number; above: boolean };

export default function RoomBoard({
  rooms,
  arrivals,
  departures,
  roomTypes,
  channels,
  tagStats,
  dayMetrics,
  initialStatus,
  badgeCounts,
  badgeList,
  stayFlows,
  pendingBookings,
}: Props) {
  const [statusFilter, setStatusFilter] = useState<string[]>(
    initialStatus && initialStatus !== "all" ? [initialStatus] : []
  );
  const [typeFilter, setTypeFilter] = useState<number[]>([]);
  const [channelFilter, setChannelFilter] = useState<string[]>([]);
  /** 输入框里的原始文本 vs 已生效的查询词（点「查询」或回车后生效） */
  const [guestInput, setGuestInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [guestQuery, setGuestQuery] = useState("");
  const [roomQuery, setRoomQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [arrivalOnly, setArrivalOnly] = useState(false);
  const [departureOnly, setDepartureOnly] = useState(false);
  const [floorFilter, setFloorFilter] = useState<number | null>(null);
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [teamFilter, setTeamFilter] = useState("");
  const router = useRouter();
  /** 快捷标签筛选（第 5 轮 P1-4）：12 个标签单选，再点一次或点「清除」取消 */
  const [tagFilter, setTagFilter] = useState<RoomTagKey | null>(null);
  /** 身份证设备说明面板（第 5 轮 P1-3）：设备未配置，点按钮出说明 + 配置入口，不再假装能刷证 */
  const [idDeviceOpen, setIdDeviceOpen] = useState(false);
  /** 房态设置弹窗（去呼呼是弹窗，不是跳页） */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 悬停面板里的二级操作弹窗（去呼呼点续住/换房等会弹表单） */
  const [quickOp, setQuickOp] = useState<{ op: string; room: RoomRow } | null>(null);
  /** 悬浮面板内的 tab：详情 / 财务明细 / 操作（去呼呼点这两个 tab 是面板内切换，不跳页） */
  const [panelTab, setPanelTab] = useState<"detail" | "folio">("detail");
  const [boardCfg, setBoardCfg] = useState<BoardConfig>(DEFAULT_BOARD_CONFIG);
  useEffect(() => {
    setBoardCfg(loadBoardConfig());
  }, []);
  const saveBoardCfg = (next: BoardConfig) => {
    setBoardCfg(next);
    try {
      window.localStorage.setItem(BOARD_CFG_KEY, JSON.stringify(next));
    } catch {}
  };
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 房间卡片悬浮层：进入 300ms 后出现，离开 200ms 后消失 */
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const hoverInTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHoverCard = (room: RoomRow, el: HTMLElement) => {
    if (hoverOutTimer.current) clearTimeout(hoverOutTimer.current);
    if (hoverInTimer.current) clearTimeout(hoverInTimer.current);
    hoverInTimer.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const W = 620;
      // 横向夹住视口，避免贴右边被裁
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8));
      // 高度按 8 行估算，放不下就向上弹（向上时用 translateY(-100%)）
      const above = rect.bottom + 400 > window.innerHeight;
      setHoverCard({ room, left, top: above ? rect.top - 2 : rect.bottom + 2, above });
    }, 300);
  };

  const hideHoverCard = () => {
    if (hoverInTimer.current) clearTimeout(hoverInTimer.current);
    if (hoverOutTimer.current) clearTimeout(hoverOutTimer.current);
    hoverOutTimer.current = setTimeout(() => setHoverCard(null), 400);
  };

  /** 订单操作结果：页面顶部一条提示（成功 / 失败都可见） */
  const showNotice = (kind: Notice["kind"], text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4200);
  };

  const arrivalMap = new Map<number, ArrivalRow>();
  for (const a of arrivals) if (a.room_id) arrivalMap.set(a.room_id, a);
  const departureSet = new Set(departures.map((d) => d.room_id));

  // —— 顶部「今日预抵」提示条统计（arrivals 即 check_in_date=今天且 PENDING/CONFIRMED 的订单）——
  const arrivalTotal = arrivals.length;
  const arrivalAssigned = arrivals.filter((a) => a.room_id !== null).length;
  const arrivalUnassigned = arrivalTotal - arrivalAssigned;

  // —— 横排渠道筛选：数量 = 该渠道的在住房间数（含 0），全部 = 房间总数 ——
  const inhouseRooms = rooms.filter((r) => r.status === "OC" || r.status === "OD");
  const channelCount = (key: string) =>
    key === "线下客人"
      ? inhouseRooms.filter((r) => !r.channel_name || r.channel_name === "散客").length
      : inhouseRooms.filter((r) => r.channel_name === key).length;
  const channelPills: { key: string; label: string; count: number }[] = [
    { key: "全部", label: "全部", count: rooms.length },
    ...CHANNEL_PRESETS.map((name) => ({
      key: name,
      label: name,
      count: channelCount(name),
    })),
    // 数据里存在、但不在固定清单里的渠道（有在住才追加，避免拉出一排 0）
    ...channels
      .map((c) => c.name)
      .filter((name) => !CHANNEL_PRESETS.includes(name) && name !== "散客" && channelCount(name) > 0)
      .map((name) => ({ key: name, label: name, count: channelCount(name) })),
  ];

  const stats: Record<string, number> = { VC: 0, VD: 0, OC: 0, OD: 0, OOO: 0, LOCK: 0 };
  for (const r of rooms) stats[r.status] = (stats[r.status] ?? 0) + 1;
  /** 当前占房数：实时房态口径（在住 = OC + OD，含钟点房） */
  const occupied = stats.OC + stats.OD;

  /*
   * —— 出租率（第 5 轮 P1-1）——
   *
   * 旧代码：occupied / rooms.length —— 分母包含维修房(OOO) 和锁房(LOCK)。
   * 那些房根本卖不出去，算进分母会把出租率算低，和工作台 / 报表 / 夜审的数字打架。
   *
   * 现在分母 = 可售房量（总房量 − OOO − LOCK），口径由 src/lib/metrics.ts 统一。
   * 注意：metrics.ts 导入了 @/lib/db，是服务端模块，客户端组件不能直接 import，
   * 所以由 rooms/page.tsx（服务端组件）用 occupancyOfDay() 算好，经 dayMetrics 传入。
   */
  const occupancy = dayMetrics ? (dayMetrics.occupancy * 100).toFixed(2) : "0.00";
  const sellableRooms = dayMetrics?.sellableRooms ?? 0;

  let filtered = rooms;
  // 房态：多选取并集
  if (statusFilter.length) filtered = filtered.filter((r) => statusFilter.includes(r.status));
  // 房型：多选取并集
  if (typeFilter.length) filtered = filtered.filter((r) => typeFilter.includes(r.room_type_id));
  // 渠道：多选取并集（线下客人 = 无渠道 / 散客）
  if (channelFilter.length) filtered = filtered.filter((r) => channelFilter.some((k) => matchChannel(r, k)));
  if (arrivalOnly) filtered = filtered.filter((r) => arrivalMap.has(r.id));
  if (departureOnly) filtered = filtered.filter((r) => departureSet.has(r.id));
  if (floorFilter !== null) filtered = filtered.filter((r) => r.floor === floorFilter);
  // 联房：同一客人 / 同房型在住间数 > 1（page.tsx 的 link_count 子查询）
  if (linkedOnly) filtered = filtered.filter((r) => r.link_count > 1);
  // 团队：按 stays.team_name 精确过滤
  if (teamFilter) filtered = filtered.filter((r) => r.team_name === teamFilter);
  /*
   * 快捷标签（第 5 轮 P1-4）：判定条件与左侧数量的 SQL 同源（@/lib/room-tags），
   * 所以点标签筛出来的间数必然等于标签上的数字。
   */
  if (tagFilter) filtered = filtered.filter((r) => matchesRoomTag(tagFilter, r));
  // 快速查询：姓名（包含匹配）/ 房号（前缀匹配）
  if (guestQuery) filtered = filtered.filter((r) => (r.guest_name ?? "").includes(guestQuery));
  if (roomQuery) filtered = filtered.filter((r) => r.room_no.startsWith(roomQuery));

  // 统计随筛选联动：全部 / 预抵 / 预离 / 在住 都按当前筛选结果计算
  const viewArrivals = filtered.filter((r) => arrivalMap.has(r.id)).length;
  const viewDepartures = filtered.filter((r) => departureSet.has(r.id)).length;
  const viewOccupied = filtered.filter((r) => r.status === "OC" || r.status === "OD").length;

  const floorList = [...new Set(rooms.map((r) => r.floor))].sort((a, b) => a - b);
  const teamList = [...new Set(rooms.map((r) => r.team_name).filter((t): t is string => !!t))];
  const floorMap = new Map<number, RoomRow[]>();
  for (const r of filtered) {
    if (!floorMap.has(r.floor)) floorMap.set(r.floor, []);
    floorMap.get(r.floor)!.push(r);
  }
  const floors = [...floorMap.entries()].sort((a, b) => a[0] - b[0]);

  // 抽屉按 id 索引最新的房间数据，提交后 revalidate 刷新时抽屉内容同步更新
  const selected = selectedId === null ? null : rooms.find((r) => r.id === selectedId) ?? null;

  // 悬浮层：房间 + 该房的预抵订单
  const hoverRoom = hoverCard?.room ?? null;
  const hoverArrival = hoverRoom ? arrivalMap.get(hoverRoom.id) : undefined;
  const hoverInhouse = hoverRoom ? hoverRoom.status === "OC" || hoverRoom.status === "OD" : false;

  const toggleStatus = (key: string) => {
    if (key === "all") setStatusFilter([]);
    else setStatusFilter((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const toggleType = (id: number) =>
    setTypeFilter((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

  /** 横排渠道胶囊：全部=清空，其余多选取并集 */
  const toggleChannel = (key: string) => {
    if (key === "全部") {
      setChannelFilter([]);
      return;
    }
    setChannelFilter((prev) => (prev.includes(key) ? prev.filter((v) => v !== key) : [...prev, key]));
  };

  const resetAll = () => {
    setGuestInput("");
    setRoomInput("");
    setGuestQuery("");
    setRoomQuery("");
    setStatusFilter([]);
    setTypeFilter([]);
    setChannelFilter([]);
    setArrivalOnly(false);
    setDepartureOnly(false);
    setFloorFilter(null);
    setLinkedOnly(false);
    setTeamFilter("");
    setTagFilter(null);
  };

  /*
   * 标签数量一律取服务端统计（tagStats），前端不写死；
   * 缺字段的标签（自用 / 打扫中）定义里 available=false，数量恒为 0。
   */

  return (
    <div className="relative flex h-full min-h-0">
      {/* ---------------- 左侧栏：快速查询 + 筛选 ---------------- */}
      <div className="flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-[#e8e8e8] bg-white">
        {/* 快速查询 */}
        <div className="border-b border-[#f0f0f0] px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <i className="h-[11px] w-[2px] shrink-0 bg-[#32c141]" />
              <span className="text-[13px] font-bold text-[#333]">快速查询</span>
            </span>
            <button type="button" className="text-[12px] text-[#32c141] hover:underline" onClick={resetAll}>
              重置
            </button>
          </div>

          {/* 预订/入住人姓名 + 查询 */}
          <div className="mb-1 flex items-center">
            <input
              value={guestInput}
              onChange={(e) => setGuestInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setGuestQuery(guestInput.trim());
              }}
              placeholder="预订/入住人姓名"
              className="h-7 min-w-0 flex-1 rounded-l-[2px] border border-r-0 border-[#dcdcdc] bg-white px-1.5 text-[12px] text-[#333] outline-none placeholder:text-[#b8b8b8] focus:border-[#32c141]"
            />
            <button
              type="button"
              onClick={() => setGuestQuery(guestInput.trim())}
              className="h-[26px] shrink-0 rounded-r-[2px] bg-[#32c141] px-2 text-[12px] text-white hover:bg-[#2cb03b]"
            >
              查询
            </button>
          </div>

          {/*
           * 身份证（第 5 轮 P1-3）
           *
           * 原来这个按钮叫「刷身份证查询」，点了只弹一句 toast「需对接公安系统」——
           * 看起来能用、实际什么都没做，是假可用按钮。
           * 本机既没有读卡器也没有公安上传接口，就不装成能用的样子：
           * 按钮文案直接写「身份证设备未配置」，样式降级为虚线灰底，
           * 点开说明面板并给两条真实可走的路径（去配置 / 手工核验）。
           * 等设备接好、配置写进 settings 后，再把这里换成真正的刷证调用。
           */}
          <button
            type="button"
            onClick={() => setIdDeviceOpen(true)}
            title="未接入身份证读卡器与公安上传接口，点击查看配置说明"
            className="mb-1 flex h-7 w-full items-center justify-center gap-1 rounded-[2px] border border-dashed border-[#d9d9d9] bg-[#fafafa] text-[12px] text-[#999] hover:border-[#32c141] hover:text-[#2a9d5c]"
          >
            <span aria-hidden>⚠</span>
            身份证设备未配置
          </button>

          {/* 房间号 + 查询 */}
          <div className="mb-1 flex items-center">
            <input
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setRoomQuery(roomInput.trim());
              }}
              placeholder="房间号"
              className="h-7 min-w-0 flex-1 rounded-l-[2px] border border-r-0 border-[#dcdcdc] bg-white px-1.5 text-[12px] text-[#333] outline-none placeholder:text-[#b8b8b8] focus:border-[#32c141]"
            />
            <button
              type="button"
              onClick={() => setRoomQuery(roomInput.trim())}
              className="h-[26px] shrink-0 rounded-r-[2px] bg-[#32c141] px-2 text-[12px] text-white hover:bg-[#2cb03b]"
            >
              查询
            </button>
          </div>

          {/* 楼层下拉：真实切换楼层过滤 */}
          <select
            value={floorFilter === null ? "" : String(floorFilter)}
            onChange={(e) => setFloorFilter(e.target.value ? Number(e.target.value) : null)}
            className="h-7 w-full rounded-[2px] border border-[#dcdcdc] bg-white px-1 text-[12px] text-[#666] outline-none focus:border-[#32c141]"
          >
            <option value="">楼层</option>
            {floorList.map((f) => (
              <option key={f} value={f}>
                {floorLabel(f)}层（{rooms.filter((r) => r.floor === f).length}间）
              </option>
            ))}
          </select>

          {/* 统计：两行小字，数字随筛选联动 */}
          <div className="mt-1.5 grid grid-cols-2 gap-y-0.5 text-[12px] text-[#666]">
            <button
              type="button"
              onClick={() => {
                setStatusFilter([]);
                setArrivalOnly(false);
                setDepartureOnly(false);
              }}
              className="w-fit rounded-[2px] border border-[#a9dcaa] px-1 text-left text-[#333] hover:border-[#32c141]"
            >
              全部 <b className="font-semibold text-[#333]">{filtered.length}</b>间
            </button>
            <button
              type="button"
              onClick={() => {
                setArrivalOnly((v) => !v);
                setDepartureOnly(false);
              }}
              className={`w-fit px-1 text-left hover:text-[#32c141] ${arrivalOnly ? "font-semibold text-[#32c141]" : ""}`}
            >
              今日预抵 <b className="font-semibold text-[#333]">{viewArrivals}</b>
            </button>
            <button
              type="button"
              onClick={() => {
                setDepartureOnly((v) => !v);
                setArrivalOnly(false);
              }}
              className={`w-fit px-1 text-left hover:text-[#32c141] ${departureOnly ? "font-semibold text-[#32c141]" : ""}`}
            >
              今日预离 <b className="font-semibold text-[#333]">{viewDepartures}</b>
            </button>
            <span className="px-1">
              当前在住 <b className="font-semibold text-[#333]">{viewOccupied}</b>
            </span>
          </div>
        </div>

        {/* 房型筛选（可多选） */}
        <div className="border-b border-[#f0f0f0] px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <i className="h-[11px] w-[2px] shrink-0 bg-[#32c141]" />
              <span className="text-[13px] font-bold text-[#333]">
                房型筛选<span className="font-normal text-[#999]">(可选)</span>
              </span>
            </span>
            <span className="text-[11px] text-[#999]">今日可售</span>
          </div>
          <div className="space-y-px">
            {(showAllTypes ? roomTypes : roomTypes.slice(0, 5)).map((t) => {
              const active = typeFilter.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleType(t.id)}
                  className={`flex h-[22px] w-full items-center justify-between rounded-[2px] px-1 text-[12px] ${
                    active ? "bg-[#e6f6e8] text-[#2a8f37]" : "text-[#555] hover:bg-[#f7f7f7]"
                  }`}
                >
                  <span className="truncate">{t.name}</span>
                  <span
                    className={`ml-1 shrink-0 tabular-nums ${t.count > 0 ? "text-[#32c141]" : "text-[#c4c4c4]"}`}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>
          {roomTypes.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAllTypes((v) => !v)}
              className="mt-1 w-full text-center text-[12px] text-[#b5b5b5] hover:text-[#32c141]"
            >
              {showAllTypes ? "收起房型" : "展开更多房型"}
            </button>
          )}
        </div>

        {/* 房态筛选（可多选，两列） */}
        <div className="border-b border-[#f0f0f0] px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1">
            <i className="h-[11px] w-[2px] shrink-0 bg-[#32c141]" />
            <span className="text-[13px] font-bold text-[#333]">
              房态筛选<span className="font-normal text-[#999]">（可选）</span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-1 gap-y-0.5">
            {FILTERS.filter((f) => f.key !== "all").map((f) => {
              const count = stats[f.key] ?? 0;
              const active = statusFilter.includes(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => toggleStatus(f.key)}
                  className={`flex h-[20px] items-center gap-1 rounded-[2px] px-0.5 text-[12px] ${
                    active ? "bg-[#e6f6e8] text-[#2a8f37]" : "text-[#555] hover:bg-[#f7f7f7]"
                  }`}
                >
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-[1px] border ${
                      f.key === "VC" ? "border-[#d9d9d9]" : "border-black/10"
                    } ${f.color}`}
                  />
                  <span className="truncate">{f.short}</span>
                  <span
                    className={`ml-auto tabular-nums ${active ? "text-[#2a8f37]" : count > 0 ? "text-[#32c141]" : "text-[#c4c4c4]"}`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 联房 / 团队：两个整宽下拉 */}
        <div className="border-b border-[#f0f0f0] px-2 py-1.5">
          <div className="flex items-center gap-1">
            <select
              value={linkedOnly ? "linked" : ""}
              onChange={(e) => setLinkedOnly(e.target.value === "linked")}
              className="h-6 min-w-0 flex-1 rounded-[2px] border border-[#dcdcdc] bg-white px-1 text-[12px] text-[#666] outline-none focus:border-[#32c141]"
            >
              <option value="">全部联房</option>
              <option value="linked">只看联房</option>
            </select>
            <span className="w-5 shrink-0 text-right text-[12px] tabular-nums text-[#333]">{tagStats.linked}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1">
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="h-6 min-w-0 flex-1 rounded-[2px] border border-[#dcdcdc] bg-white px-1 text-[12px] text-[#666] outline-none focus:border-[#32c141]"
            >
              <option value="">全部团队</option>
              {teamList.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="w-5 shrink-0 text-right text-[12px] tabular-nums text-[#333]">{tagStats.team}</span>
          </div>
        </div>

        {/* 渠道筛选：已改为房态板顶部的横排复选框（见右侧栏顶部） */}

        {/* 常用标签（第 5 轮 P1-4：12 个标签 / 数量服务端统计 / 点击筛选 / 清除筛选） */}
        <div className="px-2 py-1.5">
          <div className="mb-1 flex items-center gap-1">
            <i className="h-[11px] w-[2px] shrink-0 bg-[#32c141]" />
            <span className="text-[13px] font-bold text-[#333]">
              常用标签<span className="font-normal text-[#999]">(单选)</span>
            </span>
            {tagFilter && (
              <button
                type="button"
                onClick={() => setTagFilter(null)}
                className="ml-auto text-[11px] text-[#32c141] hover:underline"
              >
                清除筛选
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {ROOM_TAGS.map((t) => {
              const active = tagFilter === t.key;
              const count = tagStats[t.key] ?? 0;
              /*
               * 缺字段的标签（自用 / 打扫中）：灰显 + 不可点击，
               * title 里写明缺哪张表的哪个字段，避免「点了没反应」这种假功能。
               */
              if (!t.available) {
                return (
                  <button
                    key={t.key}
                    type="button"
                    disabled
                    title={`${t.label}：${t.missing ?? "数据来源未接入"}`}
                    className="flex h-[20px] cursor-not-allowed items-center gap-1 rounded-[2px] border border-dashed border-[#e8e8e8] px-1.5 text-[12px] text-[#c4c4c4]"
                  >
                    <span>{t.label}</span>
                    <span className="tabular-nums">—</span>
                  </button>
                );
              }
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTagFilter(active ? null : t.key)}
                  title={`${t.hint}（当前 ${count} 间）`}
                  className={`flex h-[20px] items-center gap-1 rounded-[2px] border px-1.5 text-[12px] ${
                    active
                      ? "border-[#32c141] bg-[#e6f6e8] text-[#2a8f37]"
                      : "border-transparent text-[#555] hover:text-[#32c141]"
                  }`}
                >
                  <span>{t.label}</span>
                  <span
                    className={`tabular-nums ${active ? "text-[#32c141]" : count > 0 ? "text-[#a8a8a8]" : "text-[#d5d5d5]"}`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ---------------- 右侧：房态板 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部「今日预抵」提示条：整宽浅黄底 */}
        <div className="shrink-0 border-b border-[#f5e6a8] bg-[#fffbe6] px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] leading-5 text-[#6b5a20]">
              温馨提示：今日预抵{" "}
              <b className="font-semibold text-[#333]">{arrivalTotal}</b> 间，其中，已排房{" "}
              <b className="font-semibold text-[#333]">{arrivalAssigned}</b> 间，未排房{" "}
              <b className="font-semibold text-[#333]">{arrivalUnassigned}</b> 间
            </span>
            <Link
                prefetch={false}
              href="/frontdesk?multi=1"
              className="flex h-[22px] shrink-0 items-center rounded-[2px] bg-[#32c141] px-2 text-[12px] leading-none text-white hover:bg-[#2cb03b]"
            >
              去办理入住（支持多订单办理入住）
            </Link>
          </div>
        </div>

        {/* 渠道筛选：横排复选框胶囊，多选取并集 */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[#e8e8e8] bg-white px-3 py-1.5">
          <span className="shrink-0 text-[12px] text-[#666]">渠道筛选：</span>
          {channelPills.map((p) => {
            const active = p.key === "全部" ? channelFilter.length === 0 : channelFilter.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => toggleChannel(p.key)}
                title={`${p.label}（${p.count}）间`}
                className={`flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-[12px] leading-none ${
                  active
                    ? "border-[#32c141] bg-[#e6f6e8] text-[#2a8f37]"
                    : "border-[#dcdcdc] bg-white text-[#555] hover:border-[#32c141] hover:text-[#2a8f37]"
                }`}
              >
                <span
                  className={`flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-[2px] border text-[8px] leading-none ${
                    active ? "border-[#32c141] bg-[#32c141] text-white" : "border-[#c9c9c9] bg-white text-transparent"
                  }`}
                >
                  ✓
                </span>
                <span>{p.label}</span>
                <span className={`tabular-nums ${active ? "text-[#2a8f37]" : "text-[#999]"}`}>({p.count}) 间</span>
              </button>
            );
          })}
          {channelFilter.length > 0 && (
            <button
              type="button"
              onClick={() => setChannelFilter([])}
              className="shrink-0 text-[12px] text-[#32c141] hover:underline"
            >
              重置
            </button>
          )}
        </div>

        <div className="flex h-8 shrink-0 items-center gap-3 border-b border-[#e8e8e8] bg-white px-3">
          <span className="text-[12px] text-[#555]">
            共 <b className="text-[#333]">{filtered.length}</b> 间
          </span>
          <div className="ml-auto flex items-center gap-2 whitespace-nowrap text-[10px] text-gray-500">
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-[1px] bg-white ring-1 ring-[#d9d9d9]" />空净</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-[1px] bg-[#4b4b4b]" />空脏</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-[1px] bg-[#4A90E2]" />住净</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-[1px] bg-[#9013FE]" />住脏</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-[1px] bg-[#c99a2e]" />维修</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-[1px] bg-[#b6e388]" />预抵</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {floors.length === 0 && (
            <div className="flex h-full items-center justify-center text-[12px] text-gray-400">没有符合条件的房间</div>
          )}
          {floors.map(([floor, list]) => (
            <div key={floor} className="mb-4">
              <div className="mb-1.5 text-[14px] text-[#8a8a8a]">
                {floorLabel(floor)}层（共{list.length}间）
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,160px)] gap-[10px]">
                {list.map((r) => (
                  <RoomCard
                    key={r.id}
                    room={r}
                    arrival={arrivalMap.get(r.id)}
                    departing={departureSet.has(r.id)}
                    onClick={() => {
                      // 去呼呼实时房态点房间 = 跳宾客列表并按房号过滤（订单详情视图）
                      if (r.guest_name || arrivalMap.get(r.id)) {
                        router.push(`/guests?doorNo=${encodeURIComponent(r.room_no)}`);
                      } else {
                        // 空房没有订单可看，仍然打开操作面板
                        setSelectedId(r.id);
                      }
                    }}
                    onHover={showHoverCard}
                    onLeave={hideHoverCard}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* 底部功能条：左侧功能入口 + 右侧统计 / 说明 */}
        <div className="relative flex h-9 shrink-0 items-center gap-1.5 border-t border-[#e8e8e8] bg-white px-2">
          {/*
           * 房态页排房（整改指令 3.2）
           *
           * 待排房订单集中在底部功能条里，点开直接出「房间网格」选房，
           * 不用切到订单页。有单才显示，没单不占地方。
           */}
          {(pendingBookings?.length ?? 0) > 0 && (
            <details className="group relative shrink-0">
              <summary className="flex h-6 cursor-pointer list-none items-center gap-1 rounded-[3px] bg-[#e8f5ec] px-2 text-[11.5px] text-[#1e8e3e] [&::-webkit-details-marker]:hidden">
                待排房
                <span className="rounded-full bg-[#1e8e3e] px-1 text-[10px] leading-[13px] text-white">
                  {pendingBookings!.length}
                </span>
              </summary>
              <div className="absolute bottom-7 left-0 z-40 w-[320px] max-h-[300px] overflow-auto rounded-[4px] border border-[#dcdcdc] bg-white shadow-lg">
                <div className="sticky top-0 border-b border-[#f0f0f0] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-gray-700">
                  点订单去排房（{pendingBookings!.length} 单）
                </div>
                {pendingBookings!.map((b) => (
                  <Link
                    key={b.id}
                    href={`/bookings?q=${encodeURIComponent(b.booking_no)}`}
                    prefetch={false}
                    className="flex items-center gap-2 border-b border-[#f7f7f7] px-2.5 py-1.5 last:border-0 hover:bg-[#f7fbf8]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] text-gray-800">{b.guest_name}</span>
                        <span className="shrink-0 font-mono text-[10px] text-[#b0b8bf]">{b.booking_no}</span>
                      </div>
                      <div className="text-[10.5px] text-[#8b949e]">
                        {b.check_in_date} → {b.check_out_date} · {b.room_type_name ?? "未指定房型"} ·{" "}
                        {b.room_count ?? 1} 间
                      </div>
                    </div>
                    <span className="shrink-0 text-[10.5px] text-[#1e8e3e]">排房 ›</span>
                  </Link>
                ))}
              </div>
            </details>
          )}
          {bottomLinks(badgeCounts ?? { orders: 0, tasks: 0, shop: 0, alerts: 0 }).map((a) => {
            const key = (a.label === "直连订单" ? "orders" : a.label === "前台任务" ? "tasks" : a.label === "小商超" ? "shop" : "alerts") as
              | "orders"
              | "tasks"
              | "shop"
              | "alerts";
            const items = badgeList?.[key] ?? [];
            return (
              <details key={a.label} className="group relative shrink-0">
                <summary className="flex h-6 cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-full border border-[#bfe3c8] px-2 text-[12px] text-[#2fa84f] hover:border-[#32c141] hover:bg-[#f6fcf7] group-open:border-[#32c141] group-open:bg-[#f6fcf7] [&::-webkit-details-marker]:hidden">
                  {a.label}
                  <span
                    className={`rounded-full px-1 text-[10px] leading-[14px] text-white ${
                      a.tone === "red" ? "bg-[#f5222d]" : "bg-[#c9c9c9]"
                    }`}
                  >
                    {a.badge}
                  </span>
                </summary>
                {/* 去呼呼点这里是弹出列表，不是直接跳页 */}
                <div className="absolute bottom-full mb-1 left-0 z-50 w-[320px] overflow-hidden rounded-[3px] border border-[#e0e0e0] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.16)]">
                  <div className="flex items-center justify-between border-b border-[#f0f0f0] bg-[#fafafa] px-2.5 py-1.5">
                    <span className="text-[12px] font-medium text-[#333]">{a.label}</span>
                    <Link prefetch={false} href={a.href} className="text-[11px] text-[#2a9d5c] hover:underline">
                      查看全部 ›
                    </Link>
                  </div>
                  {items.length === 0 ? (
                    <div className="px-2.5 py-6 text-center text-[11.5px] text-[#999]">暂无待处理</div>
                  ) : (
                    <ul className="max-h-[240px] overflow-y-auto">
                      {items.map((it) => (
                        <li key={it.id} className="border-b border-[#f7f7f7] last:border-0">
                          <Link prefetch={false} href={it.href} className="block px-2.5 py-1.5 hover:bg-[#f6fcf7]">
                            <div className="truncate text-[12px] text-[#333]">{it.title}</div>
                            <div className="truncate text-[11px] text-[#999]">{it.sub}</div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            );
          })}
          {BOTTOM_SOLIDS.map((a) =>
            a.modal ? (
              <button
                key={a.label}
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex h-6 shrink-0 items-center whitespace-nowrap rounded-full bg-[#32c141] px-2.5 text-[12px] text-white hover:bg-[#2cb03b]"
              >
                {a.label}
              </button>
            ) : (
              <Link
                prefetch={false}
                key={a.label}
                href={a.href ?? "/rooms"}
                className="flex h-6 shrink-0 items-center whitespace-nowrap rounded-full bg-[#32c141] px-2.5 text-[12px] text-white hover:bg-[#2cb03b]"
              >
                {a.label}
              </Link>
            )
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-3 text-[12px] text-[#8a8a8a]">
            <span title="实时房态口径：在住房间数（住净 + 住脏，含钟点房）">
              当前占房数：<b className="font-semibold text-[#333]">{occupied}</b>
            </span>
            <span className="text-[#d5d5d5]">·</span>
            <span
              className="cursor-help underline decoration-dotted decoration-[#d5d5d5] underline-offset-2"
              title={
                /*
                 * 第 5 轮 P1-1：把分母写进 tooltip，前台点开就知道这个数怎么来的，
                 * 不用再去猜「为什么不是总房量」。
                 */
                `出租率 = 已售房量 ${dayMetrics?.roomsSold ?? 0} / 可售房量 ${sellableRooms}` +
                `（总房量 ${dayMetrics?.totalRooms ?? rooms.length}，已扣除维修房与锁房；` +
                `钟点房按间夜口径不计入出租间夜）`
              }
            >
              预计出租率：<b className="font-semibold text-[#333]">{occupancy}%</b>
            </span>
            <span className="text-[#d5d5d5]">·</span>
            <details className="relative">
              <summary className="cursor-pointer list-none hover:text-[#32c141] [&::-webkit-details-marker]:hidden">
                图例说明
              </summary>
              <div className="absolute bottom-6 right-0 z-40 w-[460px] rounded border border-[#e5e5e5] bg-white p-3 text-[11.5px] leading-[22px] text-[#333] shadow-xl">
                <div className="mb-1 font-semibold text-[#222]">房态</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {[
                    ["白", "空净"],
                    ["深灰", "空脏"],
                    ["蓝", "住净"],
                    ["紫", "住脏"],
                    ["黄", "维修"],
                    ["灰", "锁房"],
                    ["浅绿", "预抵"],
                  ].map(([k, v]) => (
                    <span key={v}>
                      {k}={v}
                    </span>
                  ))}
                </div>
                <div className="mb-1 mt-2 font-semibold text-[#222]">门锁通讯</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="text-[#2a9d3c]">● 通讯正常</span>
                  <span className="text-[#e53935]">● 通讯异常</span>
                  <span className="text-[#f0a020]">● 低电量</span>
                </div>
                <div className="mb-1 mt-2 font-semibold text-[#222]">保洁状态</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>待打扫</span>
                  <span className="text-[#2a9d3c]">打扫中</span>
                  <span className="text-[#f0a020]">打扫暂停</span>
                  <span className="text-[#3a76c4]">打扫完毕待审核</span>
                </div>
              </div>
            </details>
            <span className="text-[#d5d5d5]">·</span>
            <Link prefetch={false} href="/sms" className="hover:text-[#32c141]">
              在线客服
            </Link>
            <span className="text-[#d5d5d5]">·</span>
            <Link prefetch={false} href="/inhouse?wakeup=1" className="hover:text-[#32c141]">
              叫醒
            </Link>
            <span className="text-[#d5d5d5]">·</span>
            <Link prefetch={false} href="/notices" className="hover:text-[#32c141]">
              公告
            </Link>
          </div>
        </div>
      </div>

      {selected && (
        <RoomDrawer
          room={selected}
          rooms={rooms}
          arrival={arrivalMap.get(selected.id)}
          onClose={() => setSelectedId(null)}
          onNotice={showNotice}
        />
      )}

      {/* 房态设置弹窗（去呼呼：配色方案 / 房间排序 / 格子大小，保存到本地） */}
      {settingsOpen && (
        <BoardSettingsModal
          cfg={boardCfg}
          floors={[...new Set(rooms.map((r) => r.floor))].sort((a, b) => a - b)}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            saveBoardCfg(next);
            setSettingsOpen(false);
            showNotice("ok", "房态设置已保存");
          }}
        />
      )}

      {/* 房间卡片悬浮层：去呼呼鼠标停在房间上弹出的是完整操作面板（约 620px 宽） */}
      {hoverCard && hoverRoom && (
        <div
          role="tooltip"
          onMouseEnter={() => {
            if (hoverOutTimer.current) clearTimeout(hoverOutTimer.current);
            if (hoverInTimer.current) clearTimeout(hoverInTimer.current);
          }}
          onMouseLeave={hideHoverCard}
          className="fixed z-[70] w-[620px] overflow-hidden rounded-[3px] border border-[#d9d9d9] bg-white text-[12px] shadow-[0_10px_30px_rgba(0,0,0,0.22)]"
          style={{
            left: Math.min(hoverCard.left, (typeof window !== "undefined" ? window.innerWidth : 1440) - 640),
            top: hoverCard.top,
            transform: hoverCard.above ? "translateY(-100%)" : undefined,
          }}
        >
          {hoverInhouse ? (
            <>
              {/* 标题行：房号 + 房型 + 客人 */}
              <div className="flex items-center gap-2 border-b border-[#f0f0f0] px-2.5 py-1.5">
                <span className="text-[13px] font-bold text-[#333]">{hoverRoom.room_no}</span>
                <span className="text-[12px] text-[#666]">{hoverRoom.room_type_name}</span>
                <span className="ml-auto text-[12px] font-medium text-[#333]">{hoverRoom.guest_name ?? ""}</span>
              </div>

              {/* 第 1 行：8 个 tab */}
              <div className="flex flex-wrap gap-1 border-b border-[#f7f7f7] px-2 py-1.5">
                {(["订单详情", "财务明细", "预收款(押金)", "同住", "续住", "修改退房时间", "换房", "联房"] as const).map((t, i) => {
                  const ops = ["detail", "folio", "deposit", "share", "extend", "checkout-time", "change", "link"];
                  const cls = `rounded-[2px] border px-2 py-[3px] text-[11.5px] ${
                    i === 2
                      ? "border-[#52c41a] bg-[#52c41a] text-white"
                      : "border-[#e0e0e0] bg-white text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
                  }`;
                  // 订单详情 / 财务明细 在面板内切换显示，不跳页
                  if (i <= 1) {
                    const tabKey = i === 0 ? ("detail" as const) : ("folio" as const);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setPanelTab(tabKey)}
                        className={`rounded-[2px] border px-2 py-[3px] text-[11.5px] ${
                          panelTab === tabKey
                            ? "border-[#32c141] bg-[#eef9f0] text-[#2a9d5c]"
                            : "border-[#e0e0e0] bg-white text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
                        }`}
                      >
                        {t}
                      </button>
                    );
                  }
                  return (
                    <button key={t} type="button" onClick={() => setQuickOp({ op: ops[i], room: hoverRoom })} className={cls}>
                      {t}
                    </button>
                  );
                })}
              </div>

              {/* 第 2 行：9 个操作 */}
              <div className="flex flex-wrap gap-1 border-b border-[#f7f7f7] px-2 py-1.5">
                {["入团", "取消入住", "转钟点房", "加收房费", "客房消费", "调价", "挂账", "转账", "部分结账"].map((t, i) => {
                  const ops = ["team", "cancel", "hourly", "addfee", "consume", "rate", "charge", "transfer", "partial"];
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setQuickOp({ op: ops[i], room: hoverRoom })}
                      className="rounded-[2px] border border-[#e0e0e0] bg-white px-2 py-[3px] text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
                    >
                      {t}
                    </button>
                  );
                })}
              </div>

              {/* 第 3 行：8 个操作 */}
              <div className="flex flex-wrap gap-1 border-b border-[#f7f7f7] px-2 py-1.5">
                {["撤销结账", "叫醒", "发短信", "打印入住登记单", "打印账单", "会员充值", "会员注册", "置净"].map((t, i) => (
                  <Link
                prefetch={false}
                    key={t}
                    href={
                      i === 3 && hoverRoom.stay_id
                        ? `/cashier/print?stay=${hoverRoom.stay_id}`
                        : i === 4 && hoverRoom.stay_id
                          ? `/cashier/print?stay=${hoverRoom.stay_id}&doc=bill`
                          : i === 7
                            ? "/rooms"
                            : hoverRoom.stay_id
                              ? `/cashier?stay=${hoverRoom.stay_id}&op=${["unsettle", "wakeup", "sms", "reg-form", "bill", "recharge", "register", "clean"][i]}`
                              : "/inhouse"
                    }
                    className="rounded-[2px] border border-[#e0e0e0] bg-white px-2 py-[3px] text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
                  >
                    {t}
                  </Link>
                ))}
              </div>

              {/* 第 4 行：打扫 / 结账退房 / 换单续住 / 开发票 */}
              <div className="flex flex-wrap gap-1 border-b border-[#f0f0f0] px-2 py-1.5">
                <Link prefetch={false} href={`/housekeeping?room=${hoverRoom.room_no}`} className="rounded-[2px] border border-[#e0e0e0] bg-white px-2 py-[3px] text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]">
                  打扫
                </Link>
                <Link
                prefetch={false}
                  href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&checkout=1` : "/inhouse"}
                  className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[11.5px] text-white hover:bg-[#2bb038]"
                >
                  结账退房
                </Link>
                <Link
                prefetch={false}
                  href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&op=renew` : "/inhouse"}
                  className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[11.5px] text-white hover:bg-[#2bb038]"
                >
                  换单续住
                </Link>
                <Link
                prefetch={false}
                  href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&op=invoice` : "/inhouse"}
                  className="rounded-[2px] border border-[#e0e0e0] bg-white px-2 py-[3px] text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
                >
                  开发票
                </Link>
              </div>

              {/* 第 5 行：去呼呼 280 项权限里剩下的房态操作 */}
              <div className="flex flex-wrap gap-1 border-b border-[#f0f0f0] px-2 py-1.5">
                {[
                  ["空隔夜检查", "overnight"],
                  ["取消入住审批", "cancel-approve"],
                  ["置换房", "exchange"],
                  ["制门卡", "make-card"],
                  ["重新入住", "re-checkin"],
                  ["负值入账", "negative"],
                  ["查看客人密码", "guest-pwd"],
                ].map(([label, op]) => (
                  <Link
                prefetch={false}
                    key={label}
                    href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&op=${op}` : "/inhouse"}
                    className="rounded-[2px] border border-dashed border-[#d9d9d9] bg-white px-2 py-[3px] text-[11.5px] text-[#666] hover:border-[#32c141] hover:text-[#2a9d5c]"
                  >
                    {label}
                  </Link>
                ))}
              </div>

              {/* 面板内 tab：订单详情 / 财务明细 */}
              {panelTab === "detail" && (
                <div className="border-b border-[#f7f7f7] bg-[#fbfdfb] px-2.5 py-2">
                  <div className="mb-1 text-[11.5px] font-medium text-[#333]">订单详情</div>
                  <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-[11.5px] leading-[18px] text-[#555]">
                    <div>入住单号：<span className="tabular-nums text-[#333]">{hoverRoom.stay_no ?? "-"}</span></div>
                    <div>订单号：<span className="tabular-nums text-[#333]">{hoverRoom.booking_id ?? "-"}</span></div>
                    <div>渠道：<span className="text-[#333]">{hoverRoom.channel_name ?? "散客"}</span></div>
                    <div>客人：<span className="text-[#333]">{hoverRoom.guest_name ?? "-"}</span></div>
                    <div>手机：<span className="tabular-nums text-[#333]">{maskMobile(hoverRoom.mobile)}</span></div>
                    <div>房价代码：<span className="text-[#333]">{hoverRoom.rate_code ?? "-"}</span></div>
                    <div>房型：<span className="text-[#333]">{hoverRoom.room_type_name}</span></div>
                    <div>房价：<span className="tabular-nums text-[#333]">{fmtMoney(hoverRoom.rate)}</span></div>
                    <div>间夜：<span className="tabular-nums text-[#333]">{hoverRoom.nights ?? 1}</span></div>
                    <div>团队：<span className="text-[#333]">{hoverRoom.team_name?.trim() || "无"}</span></div>
                    <div>会员卡：<span className="text-[#333]">{hoverRoom.member_card?.trim() || "无"}</span></div>
                    <div>支付方式：<span className="text-[#333]">{hoverRoom.pay_type ?? "-"}</span></div>
                    {/* 第 5 轮 P2-2：渠道订单号（stays.channel_order_no），直连单才有值 */}
                    <div className="col-span-2">
                      渠道单号：
                      <span className="tabular-nums text-[#333]">
                        {hoverRoom.channel_order_no?.trim() || "无（非直连单）"}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {panelTab === "folio" && (
                <div className="border-b border-[#f7f7f7] bg-[#fbfdfb] px-2.5 py-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11.5px] font-medium text-[#333]">财务明细</span>
                    <Link
                prefetch={false}
                      href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}` : "/cashier"}
                      className="text-[11px] text-[#2a9d5c] hover:underline"
                    >
                      前往账单 ›
                    </Link>
                  </div>
                  <div className="max-h-[150px] overflow-y-auto">
                    {(stayFlows?.[Number(hoverRoom.stay_id)] ?? []).length === 0 ? (
                      <div className="py-3 text-center text-[11.5px] text-[#999]">暂无流水</div>
                    ) : (
                      <table className="w-full">
                        <tbody>
                          {(stayFlows?.[Number(hoverRoom.stay_id)] ?? []).slice(0, 50).map((f, i) => (
                            <tr key={i} className="border-b border-[#f5f5f5] last:border-0">
                              <td className="py-0.5 pr-2 text-[11px] tabular-nums text-[#888]">{f.biz_date ?? "-"}</td>
                              <td className="max-w-[260px] truncate py-0.5 pr-2 text-[11.5px] text-[#555]">{f.label}</td>
                              <td
                                className={`py-0.5 text-right text-[11.5px] tabular-nums ${
                                  f.kind === "PAY" ? "text-[#2a9d5c]" : "text-[#333]"
                                }`}
                              >
                                {f.kind === "PAY" ? "-" : ""}
                                {fmtMoney(f.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 信息区：三列（订单详情 tab） */}
              <div className={`grid grid-cols-3 gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-[11.5px] leading-[18px] text-[#555] ${panelTab === "detail" ? "" : "hidden"}`}>
                <div className="space-y-0.5">
                  <div>入 住：<span className="tabular-nums text-[#333]">{fmtDateTime(hoverRoom.check_in_time)}</span></div>
                  <div>离 店：<span className="tabular-nums text-[#333]">{fmtDay(hoverRoom.expect_check_out)} 12:00</span></div>
                  <div>订单来源：<span className="text-[#333]">{hoverRoom.channel_name ?? "散客"}</span></div>
                  <div>房卡数量：<span className="text-[#333]">0</span></div>
                  <div>物品租赁：<span className="text-[#333]">无</span></div>
                </div>
                <div className="space-y-0.5">
                  <div>今日房价：<span className="tabular-nums text-[#333]">{fmtMoney(hoverRoom.rate)}</span></div>
                  <div>消费金额：<span className="tabular-nums text-[#333]">{fmtMoney(hoverRoom.consume_amount ?? 0)}</span></div>
                  <div>收款金额：<span className="tabular-nums text-[#333]">{fmtMoney(hoverRoom.paid_amount ?? 0)}</span></div>
                  <div>余 额：<span className={`tabular-nums ${(hoverRoom.balance ?? 0) > 0.01 ? "text-[#e53935]" : "text-[#333]"}`}>{fmtMoney(hoverRoom.balance)}</span></div>
                  <div>预授权：<span className="tabular-nums text-[#333]">{fmtMoney(hoverRoom.deposit ?? 0)}</span></div>
                </div>
                <div className="space-y-0.5">
                  <div>开票方：<span className="text-[#333]">{hoverRoom.invoice_party ?? "酒店"}</span> <span className="text-[#999]">未开票</span></div>
                  <div>客人密码：<span className="text-[#333]">{hoverRoom.member_card ? maskMobile(hoverRoom.mobile) : ""}</span></div>
                  <div>早餐数：<span className="text-[#333]">{Number(hoverRoom.breakfast ?? 0)}</span></div>
                </div>
              </div>

              {/* 房间备注（订单详情 tab） */}
              <div className={`border-t border-[#f7f7f7] px-2.5 py-1 text-[11.5px] leading-[17px] text-[#555] ${panelTab === "detail" ? "" : "hidden"}`}>
                <span className="text-[#999]">备 注：</span>
                <span className="line-clamp-3">{hoverRoom.remark?.trim() || "【房间】"}</span>
              </div>

              {/* 联房（订单详情 tab） */}
              <div className={`flex items-center gap-3 border-t border-[#f7f7f7] px-2.5 py-1 text-[11.5px] text-[#555] ${panelTab === "detail" ? "" : "hidden"}`}>
                <span>主联房：共{Math.max(1, hoverRoom.link_count ?? 1)}间</span>
                <span className="min-w-0 flex-1 truncate">
                  其他联房：{hoverRoom.link_rooms?.trim() || "无"}
                </span>
                <Link prefetch={false} href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&op=link` : "/inhouse"} className="shrink-0 text-[#2a9d5c] hover:underline">
                  更多联房信息
                </Link>
              </div>

              {/* 底部两个绿色按钮 */}
              <div className="flex items-center justify-end gap-1.5 border-t border-[#f0f0f0] bg-[#fafafa] px-2.5 py-1.5">
                <Link
                prefetch={false}
                  href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&op=link` : "/inhouse"}
                  className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[11.5px] text-white hover:bg-[#2bb038]"
                >
                  更多联房信息
                </Link>
                <Link
                prefetch={false}
                  href={hoverRoom.stay_id ? `/cashier?stay=${hoverRoom.stay_id}&op=records` : "/inhouse"}
                  className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[11.5px] text-white hover:bg-[#2bb038]"
                >
                  更多入住及开票记录
                </Link>
              </div>
            </>
          ) : hoverArrival ? (
            <>
              <div className="flex items-center gap-2 border-b border-[#f0f0f0] px-2.5 py-1.5">
                <span className="text-[13px] font-bold text-[#333]">{hoverRoom.room_no}</span>
                <span className="text-[12px] text-[#666]">{hoverRoom.room_type_name}</span>
                <span className="ml-auto text-[12px] font-medium text-[#2f6b1a]">今日预抵</span>
              </div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 px-2.5 py-2 text-[11.5px] leading-[19px] text-[#555]">
                <div>客人：<span className="text-[#333]">{hoverArrival.guest_name}</span></div>
                <div>手机：<span className="tabular-nums text-[#333]">{maskMobile(hoverArrival.mobile)}</span></div>
                <div>房价：<span className="tabular-nums text-[#333]">{fmtMoney(hoverArrival.rate)}</span></div>
                <div>订单：<span className="tabular-nums text-[#333]">{hoverArrival.booking_no}</span></div>
                <div>渠道：<span className="text-[#333]">{hoverArrival.channel_name ?? "散客"}</span></div>
                <div>入住：<span className="tabular-nums text-[#333]">{hoverArrival.check_in_date ?? ""}</span></div>
              </div>
              <div className="flex items-center justify-end gap-1.5 border-t border-[#f0f0f0] bg-[#fafafa] px-2.5 py-1.5">
                <Link
                prefetch={false}
                  href={`/frontdesk?room=${hoverRoom.room_no}&booking=${hoverArrival.id}`}
                  className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[11.5px] text-white hover:bg-[#2bb038]"
                >
                  办理入住
                </Link>
              </div>
            </>
          ) : (
            <div className="px-2.5 py-2 text-[11.5px] text-[#999]">
              {hoverRoom.room_no} · {hoverRoom.room_type_name} · 空房
            </div>
          )}
        </div>
      )}

      {/* 悬停面板的二级操作弹窗：续住 / 修改退房时间 / 换房 / 联房 / 同住 / 预收款 / 调价 / 加收房费 等 */}
      {quickOp && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25" onClick={() => setQuickOp(null)}>
          <div className="w-[420px] rounded-[3px] bg-white shadow-[0_12px_36px_rgba(0,0,0,0.25)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
              <span className="text-[13px] font-semibold text-[#222]">
                {QUICK_OP_TITLE[quickOp.op] ?? "操作"} · {quickOp.room.room_no} {quickOp.room.guest_name ?? ""}
              </span>
              <button type="button" onClick={() => setQuickOp(null)} aria-label="关闭操作弹窗" className="text-[16px] leading-none text-[#999] hover:text-[#e53935]">
                ×
              </button>
            </div>
            {quickOp.room.stay_id ? (
              <QuickOpForm op={quickOp.op} room={quickOp.room} rooms={rooms} onDone={() => setQuickOp(null)} />
            ) : (
              <div className="px-3 py-4 text-[12px] text-[#999]">该房间没有在住单，不能执行此操作</div>
            )}
          </div>
        </div>
      )}

      {/*
       * 身份证设备说明面板（第 5 轮 P1-3）
       *
       * 设备没接、公安上传接口没配，就把话说清楚，并给出两个真能走的方向：
       *   · /settings?tab=advanced「高级设置」—— 登记读卡器与接口参数
       *   · /id-verify「人证核验」—— 现在就能用的手工核验（校验校验码 + 比对客史）
       * 不再用一个点了只弹 toast 的绿色按钮糊弄人。
       */}
      {idDeviceOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 p-4"
          onClick={() => setIdDeviceOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="身份证设备未配置"
            className="w-[440px] max-w-full overflow-hidden rounded-[3px] bg-white shadow-[0_12px_36px_rgba(0,0,0,0.25)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
              <span className="text-[13px] font-semibold text-[#222]">身份证设备未配置</span>
              <button
                type="button"
                onClick={() => setIdDeviceOpen(false)}
                aria-label="关闭身份证设备说明"
                className="text-[16px] leading-none text-[#999] hover:text-[#e53935]"
              >
                ×
              </button>
            </div>
            <div className="space-y-2 px-3 py-3 text-[12px] leading-[19px] text-[#555]">
              <p>本机还没有接入身份证读卡器与公安上传接口，暂时不能直接「刷身份证」。</p>
              <ol className="list-decimal space-y-0.5 pl-4 text-[11.5px] text-[#666]">
                <li>在「高级设置」里登记读卡器型号与端口；</li>
                <li>填写公安上传接口地址、商户编号与密钥；</li>
                <li>保存后回到房态页，这里会变成可用的刷证查询。</li>
              </ol>
              <p className="text-[11.5px] text-[#999]">
                急着核验证件时，可以到「人证核验」页手工录入姓名与身份证号：
                那边会校验校验码、解析出生日期与性别，并比对客史档案。
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#f0f0f0] bg-[#fafafa] px-3 py-2">
              <Link
                prefetch={false}
                href="/id-verify"
                className="rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 py-[5px] text-[12px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
              >
                手工核验身份证 ›
              </Link>
              <Link
                prefetch={false}
                href="/settings?tab=advanced"
                className="rounded-[2px] bg-[#32c141] px-2.5 py-[5px] text-[12px] text-white hover:bg-[#2bb038]"
              >
                去配置 ›
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* 页面顶部操作结果提示：订单操作提交后的成功 / 失败反馈 */}
      {notice && (
        <div
          role="status"
          className={`pointer-events-none fixed left-1/2 top-3 z-[60] -translate-x-1/2 rounded px-3 py-2 text-[12px] text-white shadow-lg ${
            notice.kind === "error" ? "bg-rose-600/95" : "bg-emerald-600/95"
          }`}
        >
          {notice.text}
        </div>
      )}

    </div>
  );
}

function RoomCard({
  room,
  arrival,
  departing,
  onClick,
  onHover,
  onLeave,
}: {
  room: RoomRow;
  arrival?: ArrivalRow;
  departing: boolean;
  onClick: () => void;
  /** 悬停 300ms 后由父级弹出客人信息浮层 */
  onHover: (room: RoomRow, el: HTMLElement) => void;
  onLeave: () => void;
}) {
  const inhouse = room.status === "OC" || room.status === "OD";
  const preArrival = room.status === "VC" && !!arrival;
  const days = daysToCheckout(room.expect_check_out);
  const owed = (room.balance ?? 0) > 0.01;
  const linked = room.link_count > 1;
  const hourly = isHourlyRoom(room);

  /** 卡片主体：房态底色 */
  const bg = inhouse
    ? room.status === "OC"
      ? "bg-[#4A90E2] text-white"
      : "bg-[#9013FE] text-white"
    : preArrival
    ? "bg-[#b6e388] text-[#1f4d10]"
    : room.status === "VD"
    ? "bg-[#4b4b4b] text-white"
    : room.status === "OOO"
    ? "bg-[#c99a2e] text-white"
    : room.status === "LOCK"
    ? "bg-[#9aa3af] text-white"
    : "bg-white text-[#333]";

  /** 深色底卡片：房型名用 75% 白 */
  const darkCard = inhouse || room.status === "VD" || room.status === "OOO" || room.status === "LOCK";
  const typeColor = darkCard ? "text-white/75" : preArrival ? "text-[#3f6b28]" : "text-[#a8a8a8]";

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => onHover(room, e.currentTarget)}
      onMouseLeave={onLeave}
      onFocus={(e) => onHover(room, e.currentTarget)}
      onBlur={onLeave}
      className="relative flex h-[100px] w-full flex-col overflow-visible rounded-[2px] border border-[#d9d9d9] bg-white text-left transition-colors hover:border-[#32c141]"
    >
      {/* 主体：房态色块（有标记时让出底部签条高度） */}
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[1px] px-2 pt-1.5 ${bg}`}>
        <div className="flex w-full items-start gap-1.5">
          <span className="shrink-0 text-[14px] font-bold leading-[20px]">
            {room.room_no}
            {room.lock_signal && (
              <span
                className={`ml-0.5 inline-block align-middle text-[9px] ${
                  room.lock_signal === "BAD"
                    ? "text-[#ffd0d0]"
                    : room.lock_signal === "LOW"
                      ? "text-[#ffe0a3]"
                      : "text-white/55"
                }`}
                title={
                  room.lock_signal === "BAD"
                    ? "门锁通讯异常"
                    : room.lock_signal === "LOW"
                      ? `门锁低电量 ${room.lock_battery ?? 0}%`
                      : `门锁通讯正常 ${room.lock_battery ?? 0}%`
                }
              >
                {room.lock_signal === "BAD" ? "📵" : room.lock_signal === "LOW" ? "🔋" : "📶"}
              </span>
            )}
          </span>
          <span className={`min-w-0 truncate text-[14px] leading-[20px] ${typeColor}`}>{room.room_type_name}</span>
        </div>
        <div className="mt-0.5 min-h-0 flex-1 truncate text-[14px] leading-[20px]">
          {inhouse ? (
            <>
              {room.guest_name}
              {room.mobile && (
                <span className="ml-0.5 text-[12px] opacity-80">~{String(room.mobile).slice(-3)}</span>
              )}
              {/* 第 5 轮 P2-2：今日房价（stays.rate），去呼呼卡片上客人行右侧就是房费 */}
              {room.rate !== null && room.rate !== undefined && (
                <span className="ml-1 text-[12px] opacity-90">¥{fmtMoneyShort(room.rate)}</span>
              )}
            </>
          ) : preArrival ? (
            <>
              {arrival?.guest_name}
              {arrival?.mobile && (
                <span className="ml-0.5 text-[12px] opacity-80">~{String(arrival.mobile).slice(-3)}</span>
              )}
            </>
          ) : (
            ""
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-1 pb-1">
          {inhouse && room.channel_name && (
            <span className="max-w-full truncate rounded-[1px] bg-white px-1 text-[12px] leading-[16px] text-[#333]">
              {room.channel_name}
            </span>
          )}
          {inhouse && room.expect_check_out && (
            <span className="rounded-[1px] bg-white px-1 text-[12px] leading-[16px] text-[#333]">
              {departing ? "今离" : `${Math.max(days, 0)}日离`}
            </span>
          )}
          {inhouse && hourly && (
            <span className="rounded-[1px] bg-white px-1 text-[12px] leading-[16px] text-[#333]">钟点</span>
          )}
          {preArrival && (
            <>
              {arrival?.channel_name && (
                <span className="max-w-full truncate rounded-[1px] bg-white px-1 text-[12px] leading-[16px] text-[#333]">
                  {arrival.channel_name}
                </span>
              )}
              {arrival?.arrival_time && (
                <span className="rounded-[1px] bg-white px-1 text-[12px] leading-[16px] text-[#333]">
                  {String(arrival.arrival_time).slice(0, 5)}
                </span>
              )}
            </>
          )}
          {room.status === "OOO" && (
            <span className="max-w-full truncate text-[12px] leading-[16px] opacity-90">{room.feature ?? "维修"}</span>
          )}
        </div>
      </div>

      {/* 底部签条：去呼呼把「欠多少 / 联N / 抵」放在色块下方的白条上（第 5 轮 P2-2 补金额） */}
      {(inhouse || preArrival) && (owed || linked || preArrival) ? (
        <div className="flex h-[20px] shrink-0 items-center gap-1 overflow-hidden border-t border-[#ededed] bg-white px-1.5">
          {owed && (
            /*
             * 第 5 轮 P2-2：原来只显示一个「欠」字，看不出欠多少。
             * 现在把余额直接写在签条上（hover 显示完整两位小数），
             * 前台扫一眼房态图就知道哪间欠得多。
             */
            <span
              className="min-w-0 shrink-0 truncate rounded-[1px] bg-[#e53935] px-1 text-[12px] leading-[16px] text-white"
              title={`欠费余额 ${fmtMoney(room.balance)}`}
            >
              欠{fmtMoneyShort(room.balance)}
            </span>
          )}
          {linked && (
            <span
              className="shrink-0 rounded-[1px] border border-[#5cb85c] px-1 text-[12px] leading-[15px] text-[#2e7d32]"
              title={
                /* P2-2：联房优先用 room_links 口径（P1-4），没有联房组时退回同客人同房型口径 */
                (room.link_room_count ?? 0) > 1
                  ? `联房组内 ${room.link_room_count} 间在住`
                  : `同房型同客人联房 ${room.link_count} 间`
              }
            >
              联{(room.link_room_count ?? 0) > 1 ? room.link_room_count : room.link_count}
            </span>
          )}
          {preArrival && (
            <span className="shrink-0 rounded-[1px] bg-[#52c41a] px-1 text-[12px] leading-[16px] text-white">抵</span>
          )}
        </div>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 订单操作：通用小部件
 * ------------------------------------------------------------------ */

const QUICK_OP_TITLE: Record<string, string> = {
  deposit: "预收款(押金)",
  share: "同住",
  extend: "续住",
  "checkout-time": "修改退房时间",
  change: "换房",
  link: "联房",
  team: "入团",
  cancel: "取消入住",
  hourly: "转钟点房",
  addfee: "加收房费",
  consume: "客房消费",
  rate: "调价",
  charge: "挂账",
  transfer: "转账",
  partial: "部分结账",
  unsettle: "撤销结账",
  wakeup: "叫醒",
  sms: "发短信",
  recharge: "会员充值",
  register: "会员注册",
  clean: "置净",
};

/** 悬停面板里的二级表单（每个操作一个独立表单，提交走 rooms/actions 的真实 action） */
function QuickOpForm({
  op,
  room,
  rooms,
  onDone,
}: {
  op: string;
  room: RoomRow;
  rooms: RoomRow[];
  onDone: () => void;
}) {
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const stayId = room.stay_id;

  // rooms/actions 统一返回 { error?, ok? }，这里转成弹窗内的提示
  const wrap = (action: (fd: FormData) => Promise<{ error?: string; ok?: string }>) =>
    async (fd: FormData) => {
      const r = await action(fd);
      setState({ ok: !r.error, message: r.error ?? r.ok ?? "已完成" });
      if (!r.error) setTimeout(onDone, 900);
    };

  const Field = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="mb-2">
      <label className="mb-0.5 block text-[11.5px] text-[#888]">{label}</label>
      {children}
    </div>
  );
  const inputCls = "h-7 w-full rounded-[2px] border border-[#dcdcdc] px-2 text-[12px] text-[#333] outline-none focus:border-[#32c141]";
  const btnCls = "mt-1 h-7 w-full rounded-[2px] bg-[#32c141] text-[12px] text-white hover:bg-[#2bb038]";

  const body = (() => {
    switch (op) {
      case "extend":
        return (
          <form action={wrap(extendStayAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="续住天数"><input name="nights" type="number" min={1} max={30} defaultValue={1} className={inputCls} /></Field>
            <Field label="当前离店"><input value={room.expect_check_out ?? "-"} readOnly className={`${inputCls} bg-[#f7f7f7]`} /></Field>
            <button className={btnCls}>确认续住</button>
          </form>
        );
      case "checkout-time":
        return (
          <form action={wrap(updateCheckoutAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="新离店日期"><input name="expect_check_out" type="date" defaultValue={room.expect_check_out ?? todayStr()} className={inputCls} /></Field>
            <button className={btnCls}>保存退房时间</button>
          </form>
        );
      case "change":
        return (
          <form action={wrap(changeStayRoomAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="换到房间（空净房）">
              <select name="new_room_id" className={inputCls} required>
                <option value="">请选择房间</option>
                {rooms
                  .filter((r) => r.status === "VC" && r.id !== room.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.room_no} · {r.room_type_name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="当前房间"><input value={`${room.room_no} · ${room.room_type_name}`} readOnly className={`${inputCls} bg-[#f7f7f7]`} /></Field>
            <button className={btnCls}>确认换房</button>
          </form>
        );
      case "link":
        return (
          <form action={wrap(linkRoomsAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="联房目标入住单 ID">
              <select name="target_stay_id" className={inputCls} required>
                <option value="">请选择在住单</option>
                {rooms
                  .filter((r) => r.stay_id && r.stay_id !== stayId)
                  .map((r) => (
                    <option key={r.stay_id} value={r.stay_id ?? ""}>
                      {r.room_no} · {r.guest_name ?? ""}
                    </option>
                  ))}
              </select>
            </Field>
            <button className={btnCls}>确认联房</button>
          </form>
        );
      case "share":
        return (
          <form action={wrap(addCompanionAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="同住人姓名"><input name="name" required className={inputCls} /></Field>
            <Field label="手机号"><input name="mobile" className={inputCls} /></Field>
            <Field label="证件号"><input name="id_no" className={inputCls} /></Field>
            <button className={btnCls}>添加同住人</button>
          </form>
        );
      case "deposit":
        return (
          <form action={wrap(addDepositAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="收款金额"><input name="amount" type="number" step="0.01" required className={inputCls} /></Field>
            <Field label="收款方式">
              <select name="method" className={inputCls}>
                {["现金", "微信", "支付宝", "银行卡", "挂账"].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <button className={btnCls}>确认收款</button>
          </form>
        );
      case "rate":
        return (
          <form action={wrap(adjustRateAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="新房价（原价 ¥{room.rate ?? 0}）"><input name="rate" type="number" step="0.01" defaultValue={room.rate ?? 0} className={inputCls} /></Field>
            <Field label="调价原因"><input name="remark" placeholder="如：会员优惠" className={inputCls} /></Field>
            <button className={btnCls}>保存调价</button>
          </form>
        );
      case "addfee":
        return (
          <form action={wrap(addRoomFeeAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="加收金额"><input name="amount" type="number" step="0.01" required className={inputCls} /></Field>
            <Field label="业务日期"><input name="biz_date" type="date" defaultValue={todayStr()} className={inputCls} /></Field>
            <Field label="备注"><input name="remark" placeholder="如：加床费" className={inputCls} /></Field>
            <button className={btnCls}>确认加收</button>
          </form>
        );
      case "consume":
        return (
          <form action={wrap(addOtherChargeAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="消费项目"><input name="description" placeholder="如：矿泉水" required className={inputCls} /></Field>
            <Field label="金额"><input name="amount" type="number" step="0.01" required className={inputCls} /></Field>
            <button className={btnCls}>确认入账</button>
          </form>
        );
      case "team":
        return (
          <form action={wrap(joinTeamAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="团队名称"><input name="team_name" required className={inputCls} /></Field>
            <button className={btnCls}>确认入团</button>
          </form>
        );
      case "cancel":
        /*
         * 第 5 轮 P2-1（危险操作二次确认）：
         * 取消入住是本组件里唯一真正不可逆的写操作 —— 服务端会物理删除
         * 入住单、账单、明细和收款流水，原来点一下按钮就直接提交了。
         *
         * 现在用项目统一的 ConfirmForm（与 CashierPanel / bookings 同一套组件）：
         *   · message：操作对象（房号 + 客人）
         *   · detail ：影响范围（删什么、房间变什么、有没有欠款）
         *   · requireReason：原因必填，随表单提交写进 op_logs 快照
         * 换房 / 续住 / 调价这些可逆操作没有加确认，避免前台每步都被拦。
         */
        return (
          <ConfirmForm
            action={wrap(cancelCheckinAction)}
            message={`确认取消入住 ${room.room_no} · ${room.guest_name ?? "该客人"}？`}
            detail={
              `将删除入住单 ${room.stay_no ?? "（本单）"}、账单及全部收款流水，房间 ${room.room_no} ` +
              `恢复为空房。服务端会先留一份操作日志快照，但业务数据本身不可恢复。` +
              ((room.balance ?? 0) > 0.01 ? ` 当前仍有欠款 ${fmtMoney(room.balance)}，需先结清才能取消。` : "")
            }
            confirmLabel="确认取消入住"
            requireReason="取消原因"
          >
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <p className="mb-2 text-[12px] leading-[18px] text-[#e53935]">
              取消入住会删除入住单、账单与流水，并把房间恢复为空房，不可恢复。
            </p>
            <button className={btnCls}>取消入住</button>
          </ConfirmForm>
        );
      case "hourly":
        return (
          <form action={wrap(toHourlyAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="钟点时长（小时）"><input name="hours" type="number" min={1} defaultValue={4} className={inputCls} /></Field>
            <button className={btnCls}>转钟点房</button>
          </form>
        );
      case "wakeup":
        return (
          <form action={wrap(setWakeUpAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="叫醒时间"><input name="wake_time" placeholder="如 07:30" className={inputCls} /></Field>
            <button className={btnCls}>设置叫醒</button>
          </form>
        );
      case "sms":
        return (
          <form action={wrap(sendSmsAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="短信内容"><textarea name="content" rows={3} className="w-full rounded-[2px] border border-[#dcdcdc] p-2 text-[12px] outline-none focus:border-[#32c141]" /></Field>
            <button className={btnCls}>发送短信</button>
          </form>
        );
      case "recharge":
        return (
          <form action={wrap(memberRechargeAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="充值金额"><input name="amount" type="number" min="0.01" max="50000" step="0.01" required className={inputCls} /></Field>
            {/* 第 4 轮 P2-22b：充值原因必填（写进操作日志，事后可追） */}
            <Field label="充值原因"><input name="reason" required defaultValue="会员卡充值" maxLength={80} className={inputCls} /></Field>
            <button className={btnCls}>确认充值</button>
          </form>
        );
      case "register":
        return (
          <form action={wrap(registerMemberAction)}>
            <input type="hidden" name="stay_id" value={stayId ?? ""} />
            <Field label="会员卡号"><input name="member_card" defaultValue={room.member_card ?? ""} className={inputCls} /></Field>
            <Field label="会员姓名"><input name="name" defaultValue={room.guest_name ?? ""} className={inputCls} /></Field>
            <button className={btnCls}>注册会员</button>
          </form>
        );
      case "clean":
        return (
          <form
            action={async (fd: FormData) => {
              await setRoomStatusAction(fd);
              setState({ ok: true, message: `${room.room_no} 已置为空净房` });
              setTimeout(onDone, 800);
            }}
          >
            <input type="hidden" name="roomId" value={room.id} />
            <input type="hidden" name="status" value="VC" />
            <p className="mb-2 text-[12px] text-[#555]">把 {room.room_no} 置为空净房（VC）。</p>
            <button className={btnCls}>确认置净</button>
          </form>
        );
      default:
        return (
          <div className="px-3 py-4 text-[12px] text-[#999]">
            该操作请到「收银台 → 账单」页处理
            <Link prefetch={false} href={stayId ? `/cashier?stay=${stayId}` : "/cashier"} className="ml-1 text-[#2a9d5c] hover:underline">
              前往账单 ›
            </Link>
          </div>
        );
    }
  })();

  return (
    <div className="px-3 py-2.5">
      {body}
      {state && (
        <div className={`mt-1.5 text-[11.5px] ${state.ok ? "text-[#2a9d5c]" : "text-[#e53935]"}`}>{state.message}</div>
      )}
    </div>
  );
}

function ActionLink({ label, href, hint }: { label: string; href: string; hint?: string }) {
  return (
    <Link
                prefetch={false}
      href={href}
      className="flex h-[26px] items-center justify-between gap-1 rounded-[3px] border border-gray-200 px-1.5 text-[12px] text-gray-700 hover:border-[#32c141] hover:text-[#32c141]"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-[10px] text-gray-400">{hint ?? "→"}</span>
    </Link>
  );
}

function ActionPanel({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <details className="rounded-[3px] border border-gray-200 open:col-span-3 [&::-webkit-details-marker]:hidden">
      <summary className="flex h-[26px] cursor-pointer list-none items-center justify-between gap-1 px-1.5 text-[12px] text-gray-700 hover:text-[#32c141]">
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[10px] text-gray-400">{hint ?? "▾"}</span>
      </summary>
      <div className="border-t border-gray-100 bg-gray-50 px-2 py-2">{children}</div>
    </details>
  );
}

/** 房态设置弹窗：配色方案 / 房间排序 / 房态格子大小 */
function BoardSettingsModal({
  cfg,
  floors,
  onClose,
  onSave,
}: {
  cfg: BoardConfig;
  floors: number[];
  onClose: () => void;
  onSave: (next: BoardConfig) => void;
}) {
  const [draft, setDraft] = useState<BoardConfig>(cfg);
  const COLOR_ITEMS: { key: string; label: string }[] = [
    { key: "VC", label: "空净房" },
    { key: "VD", label: "空脏房" },
    { key: "BOOKING", label: "预订房" },
    { key: "OC", label: "住净房" },
    { key: "OD", label: "住脏房" },
    { key: "OOO", label: "维修房" },
  ];
  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center bg-black/40 pt-[6vh]" role="dialog" aria-modal>
      <div className="w-[860px] max-w-[96vw] rounded-[3px] bg-white shadow-2xl">
        <div className="flex h-10 items-center justify-between border-b border-[#f0f0f0] px-3">
          <span className="text-[13px] font-semibold text-[#222]">房态设置</span>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-[16px] text-[#b0b0b0] hover:text-[#666]">
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
          <div className="mb-1 text-[13px] font-medium text-[#333]">设置配色方案</div>
          <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
            {COLOR_ITEMS.map((it) => (
              <label key={it.key} className="flex items-center gap-1.5 text-[12px] text-[#555]">
                <input
                  type="color"
                  value={draft.colors[it.key] ?? "#ffffff"}
                  onChange={(e) =>
                    setDraft({ ...draft, colors: { ...draft.colors, [it.key]: e.target.value } })
                  }
                  className="h-5 w-6 cursor-pointer rounded-[2px] border border-[#ddd] bg-white p-0"
                />
                {it.label}
              </label>
            ))}
          </div>

          <div className="mb-1 text-[13px] font-medium text-[#333]">
            房间排序 <span className="ml-1 text-[11px] font-normal text-[#999]">您可以拖动进行排序</span>
          </div>
          <div className="mb-2 flex items-center gap-5">
            {[
              { key: "floor", label: "按楼层排序" },
              { key: "type", label: "按房型排序" },
              { key: "room", label: "按房间号排序" },
            ].map((o) => (
              <label key={o.key} className="flex items-center gap-1.5 text-[12px] text-[#555]">
                <input
                  type="radio"
                  name="sortBy"
                  checked={draft.sortBy === o.key}
                  onChange={() => setDraft({ ...draft, sortBy: o.key as BoardConfig["sortBy"] })}
                />
                {o.label}
              </label>
            ))}
          </div>
          <div className="mb-4 flex flex-wrap gap-2 rounded-[2px] bg-[#f4fbf5] px-3 py-3">
            {floors.map((f) => (
              <span
                key={f}
                draggable
                className="cursor-move rounded-[2px] border border-[#d8e6da] bg-white px-6 py-2 text-[12px] text-[#555]"
              >
                {["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][f - 1] ?? f}层
              </span>
            ))}
            {floors.length === 0 && <span className="text-[11px] text-[#999]">暂无楼层</span>}
          </div>

          <div className="mb-1 text-[13px] font-medium text-[#333]">房态格子大小</div>
          <div className="flex items-center gap-5">
            {[
              { key: "large", label: "大" },
              { key: "medium", label: "中" },
              { key: "small", label: "小" },
            ].map((o) => (
              <label key={o.key} className="flex items-center gap-1.5 text-[12px] text-[#555]">
                <input
                  type="radio"
                  name="size"
                  checked={draft.size === o.key}
                  onChange={() => setDraft({ ...draft, size: o.key as BoardConfig["size"] })}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>
        <div className="flex h-[52px] items-center justify-end gap-2 border-t border-[#f0f0f0] px-3">
          <button type="button" onClick={onClose} className="h-7 rounded-[3px] border border-[#e5e5e5] bg-white px-4 text-[12px] text-[#666]">
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="h-7 rounded-[3px] bg-[#3bd943] px-4 text-[12px] text-white hover:bg-[#33cd3b]"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[11px] text-gray-500">
      <span className="mb-0.5 block">{label}</span>
      {children}
    </label>
  );
}

function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${danger ? "btn-danger" : "btn-primary"} w-full py-1.5 text-[12px] disabled:opacity-60`}
    >
      {pending ? "提交中…" : label}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 房间抽屉
 * ------------------------------------------------------------------ */

function RoomDrawer({
  room,
  rooms,
  arrival,
  onClose,
  onNotice,
}: {
  room: RoomRow;
  rooms: RoomRow[];
  arrival?: ArrivalRow;
  onClose: () => void;
  onNotice: (kind: Notice["kind"], text: string) => void;
}) {
  const inhouse = room.status === "OC" || room.status === "OD";
  const meta = ROOM_STATUS[room.status] ?? ROOM_STATUS.VC;
  const days = daysToCheckout(room.expect_check_out);
  const stayId = room.stay_id ?? 0;

  /** 包装 server action：提交后把 { ok } / { error } 抛到页面顶部提示 */
  const submitWith = (action: ActionFn) => async (formData: FormData) => {
    const result = await action(formData);
    if (result && result.error) onNotice("error", result.error);
    else if (result && result.ok) onNotice("ok", result.ok);
    else onNotice("ok", "操作已提交");
  };

  // 换房：可选 VC / VD 空房
  const emptyRooms = rooms.filter((r) => (r.status === "VC" || r.status === "VD") && r.id !== room.id);
  // 联房：其他在住房间
  const otherStays = rooms.filter(
    (r): r is RoomRow & { stay_id: number } =>
      (r.status === "OC" || r.status === "OD") && r.stay_id !== null && r.stay_id !== stayId
  );

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <div className="fixed right-0 top-0 z-40 flex h-full w-[440px] flex-col border-l border-[#e8e8e8] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-gray-100 px-4 py-2.5">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-bold leading-none text-gray-900">{room.room_no}</span>
              <span className="rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium" style={{ background: meta.bg, color: meta.color }}>
                {meta.label}
              </span>
              {room.feature && <span className="text-[11px] text-gray-400">{room.feature}</span>}
            </div>
            <div className="mt-1 text-[12px] text-gray-500">
              {room.room_type_name} · {room.floor} 层
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭房间详情" className="rounded-[3px] p-0.5 text-[13px] text-gray-400 hover:bg-gray-100 hover:text-gray-600">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {inhouse ? (
            <div className="space-y-2.5">
              <div className="card p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-[#4a4a4a]">在住信息</span>
                  <Link prefetch={false} href={`/cashier?stay=${stayId}`} className="text-[12px] text-[#32c141] hover:underline">
                    打开账单 →
                  </Link>
                </div>
                <dl className="grid grid-cols-2 gap-y-2 text-[12px]">
                  <dt className="text-gray-400">客人</dt><dd className="text-gray-800">{room.guest_name}</dd>
                  <dt className="text-gray-400">渠道</dt><dd className="text-gray-800">{room.channel_name ?? "散客"}</dd>
                  <dt className="text-gray-400">入住</dt><dd className="text-gray-800">{room.check_in_time ? new Date(room.check_in_time).toLocaleString("zh-CN", { hour12: false }) : "-"}</dd>
                  <dt className="text-gray-400">预计离店</dt><dd className="text-gray-800">{room.expect_check_out}（{days} 晚）</dd>
                  <dt className="text-gray-400">今日房价</dt><dd className="text-gray-800">{fmtMoney(room.rate)}</dd>
                  <dt className="text-gray-400">账款余额</dt>
                  <dd className={room.balance ? "font-medium text-rose-600" : "text-gray-800"}>{fmtMoney(room.balance)}</dd>
                  {room.link_count > 1 && (
                    <>
                      <dt className="text-gray-400">联房</dt>
                      <dd className="text-gray-800">同房型同客人 {room.link_count} 间</dd>
                    </>
                  )}
                  {room.team_name && (
                    <>
                      <dt className="text-gray-400">团队</dt>
                      <dd className="text-gray-800">{room.team_name}</dd>
                    </>
                  )}
                  {isHourlyRoom(room) && (
                    <>
                      <dt className="text-gray-400">房型标记</dt>
                      <dd className="text-gray-800">钟点房</dd>
                    </>
                  )}
                </dl>
              </div>

              <div className="grid grid-cols-3 gap-1">
                <Link prefetch={false} href={`/cashier?stay=${stayId}`} className="btn-primary py-1.5 text-[12px]">结账退房</Link>
                <Link prefetch={false} href="/inhouse" className="btn-default py-1.5 text-[12px]">续住 / 换房</Link>
              </div>

              <div className="card p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-[#4a4a4a]">订单操作</span>
                  <span className="text-[10px] text-gray-400">点开填写 · 提交即时生效</span>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <ActionLink label="订单详情" href="/inhouse" hint="在住单 →" />
                  <ActionLink label="财务明细" href={`/cashier?stay=${stayId}`} hint="账单 →" />

                  <ActionPanel label="制门卡">
                    <form action={submitWith(makeLockCardAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <input type="hidden" name="room_no" value={room.room_no} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="房号">
                          <input value={room.room_no} readOnly className="input bg-gray-100" />
                        </Field>
                        <Field label="制卡张数（1-5）">
                          <input name="count" type="number" min="1" max="5" step="1" defaultValue="1" required className="input" />
                        </Field>
                      </div>
                      <Field label="卡类型">
                        <input value="客卡" readOnly className="input bg-gray-100" />
                      </Field>
                      <input type="hidden" name="type" value="客卡" />
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        卡号自动生成（房号 + 时间戳后 6 位），有效期 {todayStr()} ~ {room.expect_check_out ?? todayStr()}。
                      </p>
                      <SubmitButton label="确认制卡" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="修改订单信息">
                    <form action={submitWith(modifyStayAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="预计离店日期">
                          <input name="expect_check_out" type="date" defaultValue={room.expect_check_out ?? todayStr()} className="input" />
                        </Field>
                        <Field label="房价（元 / 晚）">
                          <input name="rate" type="number" min="0.01" step="0.01" defaultValue={String(room.rate ?? 0)} className="input" />
                        </Field>
                      </div>
                      <Field label="备注（留空表示不修改）">
                        <textarea name="remark" rows={2} placeholder="如：需无烟房、加床一张" className="input" />
                      </Field>
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        离店日期后移会自动补房费明细；房价变化写调价日志；三项可一次提交。
                      </p>
                      <SubmitButton label="保存订单信息" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="修改客人信息">
                    <form action={submitWith(modifyGuestAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="客人姓名">
                          <input name="guest_name" required defaultValue={room.guest_name ?? ""} className="input" />
                        </Field>
                        <Field label="手机号">
                          <input name="mobile" defaultValue={room.mobile ?? ""} placeholder="选填" className="input" />
                        </Field>
                      </div>
                      <Field label="证件号">
                        <input name="id_no" placeholder="选填，如身份证号" className="input" />
                      </Field>
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        同步 guest 客史：按姓名匹配到则更新，匹配不到则新建客史并回写入住单。
                      </p>
                      <SubmitButton label="保存客人信息" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="预收款(押金)">
                    <form action={submitWith(addDepositAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="金额（元）">
                          <input name="amount" type="number" min="0.01" step="0.01" defaultValue="500.00" required className="input" />
                        </Field>
                        <Field label="收款方式">
                          <select name="method" defaultValue="现金" className="input">
                            {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </Field>
                      </div>
                      <SubmitButton label="确认收取预收款" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="同住">
                    <form action={submitWith(addCompanionAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="同住人姓名">
                          <input name="name" required placeholder="如：李四" className="input" />
                        </Field>
                        <Field label="手机号">
                          <input name="mobile" placeholder="选填" className="input" />
                        </Field>
                      </div>
                      <Field label="证件号">
                        <input name="id_no" placeholder="选填" className="input" />
                      </Field>
                      <SubmitButton label="登记同住人" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="续住">
                    <form action={submitWith(extendStayAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <Field label="增加晚数">
                        <input name="nights" type="number" min="1" max="30" step="1" defaultValue="1" required className="input" />
                      </Field>
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        确认后：预计离店日期 +N 天，并按营业日逐条补入房费明细。
                      </p>
                      <SubmitButton label="确认续住" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="修改退房">
                    <form action={submitWith(updateCheckoutAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <Field label="新的预计离店日期">
                        <input name="expect_check_out" type="date" required defaultValue={room.expect_check_out ?? todayStr()} className="input" />
                      </Field>
                      <SubmitButton label="保存离店日期" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="换房">
                    {emptyRooms.length === 0 ? (
                      <p className="text-[11px] text-gray-400">当前没有可换入的空净 / 空脏房</p>
                    ) : (
                      <form action={submitWith(changeStayRoomAction)} className="space-y-2">
                        <input type="hidden" name="stay_id" value={stayId} />
                        <Field label="换入房间（空净 / 空脏）">
                          <select name="new_room_id" required defaultValue="" className="input">
                            <option value="" disabled>请选择空房</option>
                            {emptyRooms.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.room_no} · {r.room_type_name}（{ROOM_STATUS[r.status]?.label ?? r.status}）
                              </option>
                            ))}
                          </select>
                        </Field>
                        <p className="text-[11px] leading-relaxed text-gray-400">
                          确认后：原房置空脏、新房置在住净，账单房号与房态日志同步更新。
                        </p>
                        <SubmitButton label="确认换房" />
                      </form>
                    )}
                  </ActionPanel>

                  <ActionPanel label="置换房">
                    {otherStays.length === 0 ? (
                      <p className="text-[11px] text-gray-400">当前没有其他在住房间可置换</p>
                    ) : (
                      <form action={submitWith(exchangeRoomAction)} className="space-y-2">
                        <input type="hidden" name="stay_id" value={stayId} />
                        <Field label="与哪间在住房间对调">
                          <select name="target_stay_id" required defaultValue="" className="input">
                            <option value="" disabled>请选择在住房间</option>
                            {otherStays.map((r) => (
                              <option key={r.id} value={r.stay_id}>
                                {r.room_no} · {r.guest_name ?? "客人"} · {r.room_type_name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <p className="text-[11px] leading-relaxed text-gray-400">
                          确认后：两个入住单的房间号互换（房态均保持在住），账单房号与房态日志同步更新。
                        </p>
                        <SubmitButton label="确认置换房" />
                      </form>
                    )}
                  </ActionPanel>

                  <ActionPanel label="联房">
                    {otherStays.length === 0 ? (
                      <p className="text-[11px] text-gray-400">当前没有其他在住房间可联房</p>
                    ) : (
                      <form action={submitWith(linkRoomsAction)} className="space-y-2">
                        <input type="hidden" name="stay_id" value={stayId} />
                        <Field label="联房目标（其他在住房间）">
                          <select name="target_stay_id" required defaultValue="" className="input">
                            <option value="" disabled>请选择在住房间</option>
                            {otherStays.map((r) => (
                              <option key={r.id} value={r.stay_id}>
                                {r.room_no} · {r.guest_name ?? "客人"} · {fmtMoney(r.balance)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <SubmitButton label="建立联房关系" />
                      </form>
                    )}
                  </ActionPanel>

                  <ActionPanel label="入团">
                    <form action={submitWith(joinTeamAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <Field label="团队名称">
                        <input name="team_name" required defaultValue={room.team_name ?? ""} placeholder="如：云启科技考察团" className="input" />
                      </Field>
                      <SubmitButton label="加入团队" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="取消入住" hint="不可撤销 ▾">
                    {/*
                     * 第 5 轮 P2-1：抽屉里的取消入住同样加统一确认框。
                     * ConfirmForm 会把 children 包进它自己的表单，点按钮先弹确认，
                     * 确认时再调 submitWith(cancelCheckinAction) 提交（原因由确认框注入）。
                     */}
                    <ConfirmForm
                      action={submitWith(cancelCheckinAction)}
                      message={`确认取消入住 ${room.room_no} · ${room.guest_name ?? "该客人"}？`}
                      detail={
                        `将删除入住单 ${room.stay_no ?? "（本单）"}、账单、账务明细及收款流水，` +
                        `房间 ${room.room_no} 置为空净房。账单仍有欠款时会被服务端拒绝。` +
                        `操作前会写入操作日志快照，业务数据不可恢复。`
                      }
                      confirmLabel="确认取消入住"
                      requireReason="取消原因"
                    >
                      <input type="hidden" name="stay_id" value={stayId} />
                      <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700">
                        将删除该入住单及对应账单、账务明细与收款流水，房间置为空净房。账单仍有欠款时会被拒绝。
                      </p>
                      <button type="submit" className="btn-danger w-full py-1.5 text-[12px]">
                        取消入住
                      </button>
                    </ConfirmForm>
                  </ActionPanel>

                  <ActionPanel label="转钟点房">
                    <form action={submitWith(toHourlyAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <Field label="钟点时长（小时）">
                        <input name="hours" type="number" min="1" max="24" step="1" defaultValue="2" required className="input" />
                      </Field>
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        房价 = 房型门市价 × 15% × 小时数，晚数置 0，备注追加「钟点房 N 小时」。
                      </p>
                      <SubmitButton label="转为钟点房" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="加收房费">
                    <form action={submitWith(addRoomFeeAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="金额（元）">
                          <input name="amount" type="number" min="0.01" step="0.01" defaultValue={String(room.rate ?? 0)} required className="input" />
                        </Field>
                        <Field label="营业日">
                          <input name="biz_date" type="date" defaultValue={todayStr()} className="input" />
                        </Field>
                      </div>
                      <Field label="说明">
                        <input name="remark" placeholder="如：加床 / 超时退房" className="input" />
                      </Field>
                      <SubmitButton label="确认加收房费" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="客房消费">
                    <form action={submitWith(addOtherChargeAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="消费项目">
                          <input name="description" required placeholder="如：迷你吧饮料" className="input" />
                        </Field>
                        <Field label="金额（元）">
                          <input name="amount" type="number" min="0.01" step="0.01" required className="input" />
                        </Field>
                      </div>
                      <SubmitButton label="记入客房消费" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="调价">
                    <form action={submitWith(adjustRateAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <Field label="新的房价（元 / 晚）">
                        <input name="rate" type="number" min="0.01" step="0.01" required defaultValue={String(room.rate ?? 0)} className="input" />
                      </Field>
                      <SubmitButton label="保存房价" />
                    </form>
                  </ActionPanel>

                  <ActionLink label="挂账" href={`/cashier?stay=${stayId}`} hint="协议单位 →" />
                  <ActionLink label="转账" href={`/cashier?stay=${stayId}`} hint="转到其他账单 →" />
                  <ActionLink label="部分结账" href={`/cashier?stay=${stayId}`} hint="先结一部分 →" />
                  <ActionLink label="撤销结账" href={`/cashier?stay=${stayId}`} hint="仅已退房账单 →" />

                  <ActionPanel label="叫醒">
                    <form action={submitWith(setWakeUpAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="叫醒时间">
                          <input name="wake_time" type="time" defaultValue="07:00" required className="input" />
                        </Field>
                        <Field label="备注">
                          <input name="note" placeholder="选填" className="input" />
                        </Field>
                      </div>
                      <SubmitButton label="登记叫醒" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="发短信">
                    <form action={submitWith(sendSmsAction)} className="space-y-2">
                      <input type="hidden" name="stay_id" value={stayId} />
                      <Field label="短信内容">
                        <textarea name="content" rows={2} required defaultValue="您的退房时间为 12:00，如需延退请与前台联系。" className="input" />
                      </Field>
                      <SubmitButton label="发送并记录" />
                    </form>
                  </ActionPanel>

                  <ActionLink label="打印入住单" href={`/cashier/print?stay=${stayId}`} hint="打印 →" />
                  <ActionLink label="打印账单" href={`/cashier/print?stay=${stayId}`} hint="打印 →" />

                  <ActionPanel label="会员充值">
                    <form action={submitWith(memberRechargeAction)} className="space-y-2">
                      <input type="hidden" name="guest_name" value={room.guest_name ?? ""} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="充值金额（元）">
                          <input name="amount" type="number" min="0.01" max="50000" step="0.01" defaultValue="1000.00" required className="input" />
                        </Field>
                        <Field label="支付方式">
                          <select name="method" defaultValue="微信" className="input">
                            {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </Field>
                      </div>
                      {/* 第 4 轮 P2-22b：充值原因必填（写进操作日志，事后可追） */}
                      <Field label="充值原因（必填）">
                        <input name="reason" required defaultValue="会员卡充值" maxLength={80} className="input" />
                      </Field>
                      <p className="text-[11px] text-gray-400">会员：{room.guest_name ?? "-"}</p>
                      <SubmitButton label="确认充值" />
                    </form>
                  </ActionPanel>

                  <ActionPanel label="会员注册">
                    <form action={submitWith(registerMemberAction)} className="space-y-2">
                      <Field label="会员姓名">
                        <input name="guest_name" required defaultValue={room.guest_name ?? ""} className="input" />
                      </Field>
                      <SubmitButton label="注册为会员" />
                    </form>
                  </ActionPanel>
                  <ActionPanel label="置净">
                    <form action={setRoomStatusAction} className="space-y-2">
                      <input type="hidden" name="roomId" value={room.id} />
                      <input type="hidden" name="status" value="VC" />
                      <p className="text-[11px] text-gray-500">
                        把 {room.room_no} 置为空净（VC），同时写房态变更日志
                      </p>
                      <SubmitButton label="确认置净" />
                    </form>
                  </ActionPanel>
                  <ActionLink
                    label="结账退房"
                    href={stayId ? `/cashier?stay=${stayId}&checkout=1` : "/inhouse"}
                    hint="退房结账 →"
                  />
                  <ActionLink
                    label="换单续住"
                    href={stayId ? `/cashier?stay=${stayId}` : "/inhouse"}
                    hint="换账单续住 →"
                  />
                  <ActionLink
                    label="开发票"
                    href={stayId ? `/cashier?stay=${stayId}&invoice=1` : "/inhouse"}
                    hint="开票 →"
                  />
                </div>
              </div>

              <div className="card p-2.5">
                <div className="mb-1.5 text-[13px] font-bold text-[#4a4a4a]">房态操作</div>
                <div className="grid grid-cols-3 gap-1">
                  <form action={setRoomStatusAction}>
                    <input type="hidden" name="roomId" value={room.id} />
                    <input type="hidden" name="status" value={room.status === "OC" ? "OD" : "OC"} />
                    <button className="btn-default w-full py-1.5 text-[12px]">
                      {room.status === "OC" ? "置脏（住脏）" : "置净（住净）"}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              {arrival && (
                <div className="rounded-[3px] border border-emerald-200 bg-emerald-50 p-2.5 text-[12px]">
                  <div className="font-medium text-emerald-800">今日预抵 · {arrival.booking_no}</div>
                  <div className="mt-1 text-emerald-700">
                    {arrival.guest_name} · {arrival.room_type_name} · {fmtMoney(arrival.rate)}
                  </div>
                  <Link prefetch={false} href={`/frontdesk?booking=${arrival.id}`} className="btn-primary mt-2 w-full py-1.5 text-[12px]">
                    办理入住
                  </Link>
                </div>
              )}
              <div className="card p-2.5">
                <dl className="grid grid-cols-2 gap-y-2 text-[12px]">
                  <dt className="text-gray-400">楼层</dt><dd className="text-gray-800">{room.floor} 层</dd>
                  <dt className="text-gray-400">房型</dt><dd className="text-gray-800">{room.room_type_name}</dd>
                  <dt className="text-gray-400">房态</dt><dd className="text-gray-800">{meta.label}</dd>
                  <dt className="text-gray-400">备注</dt><dd className="text-gray-800">{room.feature ?? "-"}</dd>
                </dl>
              </div>

              <div className="grid grid-cols-3 gap-1">
                <Link prefetch={false} href={arrival ? `/frontdesk?booking=${arrival.id}` : `/frontdesk?room=${room.id}`} className="btn-primary py-1.5 text-[12px]">
                  {arrival ? "办理入住" : "散客步入"}
                </Link>
                <form action={completeRoomAction}>
                  <input type="hidden" name="roomId" value={room.id} />
                  <button className="btn-default w-full py-1.5 text-[12px]" disabled={room.status !== "VD" && room.status !== "OD"}>
                    打扫完成
                  </button>
                </form>
              </div>

              <div className="card p-2.5">
                <div className="mb-1.5 text-[13px] font-bold text-[#4a4a4a]">房态操作</div>
                <div className="grid grid-cols-3 gap-1">
                  {[
                    ["VC", "置净"],
                    ["VD", "置脏"],
                    ["OOO", "维修房"],
                    ["LOCK", "锁房"],
                  ].map(([val, label]) => (
                    <form key={val} action={setRoomStatusAction}>
                      <input type="hidden" name="roomId" value={room.id} />
                      <input type="hidden" name="status" value={val} />
                      <button className="btn-default w-full py-1.5 text-[12px]" disabled={room.status === val}>
                        {label}
                      </button>
                    </form>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
