"use client";

import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { checkInAction, searchGuestsAction } from "@/app/(main)/frontdesk/actions";
import type { CheckInState, GuestPickCandidate } from "@/app/(main)/frontdesk/actions";
import { addDays, fmtMoney, nightsBetween, todayStr } from "@/lib/utils";

export type VacantRoom = {
  id: number;
  room_no: string;
  floor: number | null;
  status: string;
};

export type RoomTypeGroup = {
  id: number;
  name: string;
  base_price: number;
  max_occupancy: number | null;
  rooms: VacantRoom[];
};

export type ChannelOption = { id: number; name: string };

export type CompanyOption = { id: number; name: string };

export type MemberOption = {
  id: number;
  name: string;
  mobile: string;
  idNo: string;
  vipLevel: number;
};

export type SalesmanOption = { name: string; role: string };

export type BookingPrefill = {
  id: number;
  bookingNo: string;
  guestName: string;
  mobile: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  rate: number;
  deposit: number;
  guestCount: number;
  channelId: number | null;
  channelName: string | null;
  roomTypeId: number | null;
  roomTypeName: string | null;
  roomIds: number[];
  teamName: string;
  memberCard: string;
  rateCode: string;
  companyName: string;
  salesman: string;
  packageCode: string;
  invoiceParty: string;
  payType: string;
  breakfast: number;
  channelOrderNo: string;
};

export type CheckInMode = "day" | "hour";

type Props = {
  mode: CheckInMode;
  roomTypes: RoomTypeGroup[];
  channels: ChannelOption[];
  companies: CompanyOption[];
  members: MemberOption[];
  salesmen: SalesmanOption[];
  prefill: BookingPrefill | null;
  defaultRoomIds: number[];
  today: string;
  nowTime: string;
  checkOutTimeDefault: string;
  querySuffix: string;
};

type FlatRoom = VacantRoom & {
  room_type_id: number;
  room_type_name: string;
  base_price: number;
};

type GuestDraft = {
  name: string;
  mobile: string;
  idType: string;
  idNo: string;
  gender: string;
  breakfast: string;
};

/**
 * 表单里的一行住客
 *
 * rowKey 只给 React 用（稳定 key），**不会**被提交：
 * 住客可以增删，若拿数组下标当 key，「删除第 2 行」会让第 3 行复用第 2 行的
 * 本地状态（客史查询结果 / 已选客史），前台看到的就是别人的候选。
 */
type GuestRow = GuestDraft & { rowKey: string };

/** 某一行已选中的老客 + 当初是用什么词搜到的（用于回填空字段，且不把脱敏串写进表单） */
type GuestPick = { candidate: GuestPickCandidate; query: string };

/** 房价代码：与 actions.ts 中的 RATE_FACTORS 保持一致 */
const RATE_CODES = [
  { value: "门市价", label: "门市价", factor: 1 },
  { value: "协议价", label: "协议价（9 折）", factor: 0.9 },
  { value: "会员价", label: "会员价（85 折）", factor: 0.85 },
] as const;

const PAY_TYPES = ["到店付款", "预付", "挂账"];
const INVOICE_PARTIES = ["酒店", "个人"];
const ID_TYPES = ["身份证", "护照", "其他"];
const GENDERS = ["男", "女"];
const BREAKFASTS = ["0", "1", "2", "3"];
const HOUR_OPTIONS = [2, 4, 6];
/** 钟点房每小时按门店基准价的 15% 计费（与 actions.ts 一致） */
const HOURLY_FACTOR = 0.15;

/** 房态色点：空净绿、空脏黄 */
const STATUS_DOT: Record<string, string> = {
  VC: "bg-emerald-500",
  VD: "bg-amber-500",
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 住客行的稳定 key 序号（只在本组件实例内递增，与提交字段无关） */
let guestRowSeq = 0;
function nextGuestRowKey(): string {
  guestRowSeq += 1;
  return `g${guestRowSeq}`;
}

function emptyGuest(): GuestRow {
  return {
    rowKey: nextGuestRowKey(),
    name: "",
    mobile: "",
    idType: "身份证",
    idNo: "",
    gender: "男",
    breakfast: "0",
  };
}

/** 身份证号形状：15 位（可带 X）或 18 位（末位可为 X）；手机号 11 位纯数字 */
const ID_NO_SHAPE = /^\d{15}[0-9Xx]?$|^\d{18}[Xx]?$/;
const MOBILE_SHAPE = /^\d{11}$/;

/** 入住时间 + 时长 → 预计离店时间（仅用于钟点房提示） */
function addHoursText(time: string, hours: number): string {
  const [rawHour, rawMinute] = time.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const total =
    (((Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0) + hours * 60) %
      (24 * 60) +
      24 * 60) %
    (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function vipText(vipLevel: number): string {
  return vipLevel > 0 ? `VIP${Math.min(3, vipLevel)}` : "普通";
}

/**
 * 单行住客的「选择已有客史」控件（上线评审 P1：同名客史无法区分）
 *
 * ── 缺陷 ──
 * 服务端 `checkInAction` 一直支持 `guest_id_<i>`（逐间指定客史），但表单没有入口：
 * 前台遇到两个「张伟」只能碰运气填证件号/手机号，填错就把入住单、历史账单、
 * 会员储值全挂到另一个人头上。
 *
 * ── 交互 ──
 *   · 输满 11 位手机号 / 15 或 18 位身份证号 → 自动查客史（防抖 450ms）；
 *   · 命中 1 条 → 「老客：张伟（138****1234）· 入住 5 次」+「用这个」；
 *   · 命中多条 → 列表让前台核对后选（候选已脱敏：手机 138****1234、证件 3301********1234）；
 *   · 不选 → 提交时不带 `guest_id_<i>`，服务端按「证件号 → 手机号 → 唯一同名」匹配，
 *     确实没有档案才新建（同名多条又没身份信息会被拒绝并提示选择客史）；
 *   · 也可以点「查老客」按姓名/尾号手动查（同名场景就是搜姓名看列表）。
 *
 * ── 为什么填回表单的只有姓名 ──
 * 服务端返回的是脱敏串，把「138****1234」写进 guest_mobile_0 会存出一条假手机号，
 * 还会撞掉客史匹配。所以回填只补「姓名」和「前台自己输入的合法号码」；
 * 选定后真正的关联依据是隐藏字段 `guest_id_<i>`。
 */
function GuestHistoryPicker({
  draft,
  picked,
  onPick,
  onClear,
}: {
  draft: GuestRow;
  picked: GuestPickCandidate | null;
  onPick: (candidate: GuestPickCandidate, query: string) => void;
  onClear: () => void;
}) {
  const [candidates, setCandidates] = useState<GuestPickCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /* 最近一次成功查询用的词（空 = 还没查过），用于「没有匹配」提示与选中时的回填 */
  const [searched, setSearched] = useState("");
  const [open, setOpen] = useState(false);
  /* 请求序号：慢响应回来时若已有更新的查询，直接丢弃，避免候选串行覆盖 */
  const seqRef = useRef(0);

  const idNo = draft.idNo.replace(/\s+/g, "");
  const mobile = draft.mobile.replace(/\s+/g, "");
  const name = draft.name.trim();
  const autoQuery = ID_NO_SHAPE.test(idNo) ? idNo : MOBILE_SHAPE.test(mobile) ? mobile : "";
  /* 「查老客」按钮：优先让前台用当前输入的号码查，其次退回姓名 */
  const manualQuery = autoQuery || idNo || mobile || name;

  const lookup = useCallback(async (raw: string): Promise<void> => {
    const q = raw.trim();
    setError("");
    if (q.length < 2) {
      setError("请输入至少 2 位姓名 / 手机号 / 证件号");
      return;
    }
    const mySeq = seqRef.current + 1;
    seqRef.current = mySeq;
    setLoading(true);
    try {
      const res = await searchGuestsAction(q);
      if (mySeq !== seqRef.current) return;
      if (!res.ok) {
        setCandidates([]);
        setOpen(false);
        setError(res.error);
        return;
      }
      setCandidates(res.guests);
      setSearched(q);
      setOpen(true);
    } catch {
      if (mySeq === seqRef.current) {
        setCandidates([]);
        setOpen(false);
        setError("客史查询失败，请重试");
      }
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    /* 已经选定老客就不再自动查（避免结果面板回来盖掉选择） */
    if (picked) return;
    if (!autoQuery) {
      /* 输入退回不完整状态：旧的候选不再可信，收起面板 */
      setOpen(false);
      return;
    }
    setOpen(false);
    const timer = setTimeout(() => {
      void lookup(autoQuery);
    }, 450);
    return () => clearTimeout(timer);
  }, [autoQuery, picked, lookup]);

  if (picked) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-emerald-300 bg-emerald-50/70 px-2 py-1.5">
        <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
          老客
        </span>
        <span className="text-[11px] text-emerald-800">
          {picked.name}（{picked.mobileMasked || "无手机号"}）· 入住 {picked.stayCount} 次
          {picked.idNoMasked ? ` · 证件 ${picked.idNoMasked}` : ""}
        </span>
        <span className="text-[10px] text-emerald-700/80">本次入住单挂到这条客史 #{picked.id}</span>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto text-[11px] text-rose-500 hover:underline"
        >
          取消选择（改按证件号/手机号自动匹配）
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded border border-gray-200 bg-white/70 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-gray-500">客史</span>
        <button
          type="button"
          onClick={() => void lookup(manualQuery)}
          disabled={loading || manualQuery.length < 2}
          className="rounded border border-emerald-300 px-2 py-[3px] text-[11px] text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "查询中…" : "查老客"}
        </button>
        {!open && !error && (
          <span className="text-[11px] text-gray-400">
            输满手机号 / 身份证号自动匹配；点「查老客」也可按姓名查同名客史
          </span>
        )}
      </div>

      {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}

      {open && candidates.length === 0 && (
        <p className="mt-1 text-[11px] text-gray-500">
          没有匹配「{searched}」的客史 → 不选客史直接提交，将按新客建档
        </p>
      )}

      {open && candidates.length === 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded border border-emerald-200 bg-emerald-50/60 px-2 py-1">
          <span className="text-[11px] text-gray-700">
            老客：{candidates[0].name}（{candidates[0].mobileMasked || "无手机号"}）· 入住{" "}
            {candidates[0].stayCount} 次
            {candidates[0].idNoMasked ? ` · 证件 ${candidates[0].idNoMasked}` : ""}
          </span>
          <button
            type="button"
            onClick={() => onPick(candidates[0], searched)}
            className="rounded bg-emerald-600 px-2 py-[2px] text-[11px] font-medium text-white hover:bg-emerald-700"
          >
            用这个
          </button>
          <span className="text-[10px] text-gray-400">不选 → 不指定客史，按身份信息自动匹配</span>
        </div>
      )}

      {open && candidates.length > 1 && (
        <div className="mt-1 overflow-hidden rounded border border-gray-200 bg-white">
          <div className="border-b border-gray-100 bg-gray-50/70 px-2 py-1 text-[10px] text-gray-500">
            匹配到 {candidates.length} 位客史（候选已脱敏），请核对后选择；不选任何一位 → 不指定客史（同名又无身份信息会被拒绝）
          </div>
          <ul className="divide-y divide-gray-100">
            {candidates.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onPick(c, searched)}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-left text-[11px] transition-colors hover:bg-emerald-50"
                >
                  <span className="font-medium text-gray-800">{c.name}</span>
                  <span className="text-gray-400">#{c.id}</span>
                  <span className="tabular-nums text-gray-600">{c.mobileMasked || "无手机号"}</span>
                  <span className="tabular-nums text-gray-400">{c.idNoMasked || "无证件号"}</span>
                  <span className="text-gray-500">入住 {c.stayCount} 次</span>
                  <span className="text-gray-300">{vipText(c.vipLevel)}</span>
                  {c.matchedBy === "id_no" && (
                    <span className="rounded bg-brand-50 px-1 text-[10px] text-brand-600">证件匹配</span>
                  )}
                  {c.matchedBy === "mobile" && (
                    <span className="rounded bg-brand-50 px-1 text-[10px] text-brand-600">手机匹配</span>
                  )}
                  <span className="ml-auto text-[10px] text-emerald-600 underline">选这位</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
                prefetch={false}
      href={href}
      className={`-mb-px border-b-2 px-1 pb-2 text-[14px] transition-colors ${
        active
          ? "border-[#3fa855] font-medium text-[#2e8b46]"
          : "border-transparent text-gray-500 hover:text-gray-700"
      }`}
    >
      {label}
    </Link>
  );
}

/**
 * 表单行（整改 P2-26a）：外层改成包裹式 `<label>`，
 * 标签文字与内部控件自动建立隐式关联；原来只有 `<span>`，读屏读不到字段名。
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="w-[64px] shrink-0 text-[12px] text-gray-500">{label}</span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </label>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
      <path d="M12 3 2 12h3v9h6v-6h2v6h6v-9h3L12 3z" />
    </svg>
  );
}

function focusRef(ref: RefObject<HTMLInputElement | null>): void {
  ref.current?.focus();
  ref.current?.select();
}

export default function CheckInForm({
  mode,
  roomTypes,
  channels,
  companies,
  members,
  salesmen,
  prefill,
  defaultRoomIds,
  today,
  nowTime,
  checkOutTimeDefault,
  querySuffix,
}: Props) {
  const allRooms = useMemo<FlatRoom[]>(
    () =>
      roomTypes.flatMap((t) =>
        t.rooms.map((r) => ({
          ...r,
          room_type_id: t.id,
          room_type_name: t.name,
          base_price: t.base_price,
        }))
      ),
    [roomTypes]
  );

  const timeOptions = useMemo(() => {
    const list: string[] = [];
    for (let h = 0; h < 24; h += 1) {
      for (const m of ["00", "15", "30", "45"]) {
        list.push(`${String(h).padStart(2, "0")}:${m}`);
      }
    }
    if (!list.includes(nowTime)) list.push(nowTime);
    return list.sort();
  }, [nowTime]);

  const [state, formAction, pending] = useActionState<CheckInState, FormData>(checkInAction, {});
  const router = useRouter();
  // 入住成功后由客户端跳转到在住单列表（action 里 redirect 会被 useActionState 当成错误）
  useEffect(() => {
    if (!state.ok) return;
    const t = setTimeout(() => {
      router.push("/inhouse");
      router.refresh();
    }, 800);
    return () => clearTimeout(t);
  }, [state.ok, router]);

  // 排房
  const [selectedRoomIds, setSelectedRoomIds] = useState<number[]>(defaultRoomIds);
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);

  // 本地模式（与 props.mode 同源初始化，快捷按钮可在页内切换）
  const [localMode, setLocalMode] = useState<CheckInMode>(mode);

  // 订单信息
  const [teamName, setTeamName] = useState(prefill?.teamName ?? "");
  const [memberCard, setMemberCard] = useState(prefill?.memberCard ?? "");
  const [checkInDate, setCheckInDate] = useState(prefill?.checkInDate || today);
  const [checkInTime, setCheckInTime] = useState(nowTime);
  const initialNights = prefill && prefill.nights > 0 ? prefill.nights : 1;
  const [nights, setNights] = useState(initialNights);
  const [checkOutDate, setCheckOutDate] = useState(
    prefill?.checkOutDate || todayStr(addDays(prefill?.checkInDate || today, initialNights))
  );
  const [checkOutTime, setCheckOutTime] = useState(checkOutTimeDefault);
  const [hours, setHours] = useState(4);
  const [company, setCompany] = useState(prefill?.companyName ?? "");
  const [salesman, setSalesman] = useState(prefill?.salesman ?? "");
  const [rateCode, setRateCode] = useState(prefill?.rateCode || "门市价");
  const [channelId, setChannelId] = useState(
    prefill?.channelId != null ? String(prefill.channelId) : ""
  );
  const [channelOrderNo, setChannelOrderNo] = useState(prefill?.channelOrderNo ?? "");
  const [payType, setPayType] = useState(prefill?.payType || "到店付款");
  const [packageCode, setPackageCode] = useState(prefill?.packageCode ?? "");
  const [invoiceParty, setInvoiceParty] = useState(prefill?.invoiceParty || "酒店");
  const [deposit, setDeposit] = useState(
    prefill && prefill.deposit > 0 ? String(prefill.deposit) : ""
  );
  const [remark, setRemark] = useState("");
  /*
   * 自用标记（第 5 轮 P1-4）
   *
   * 自用是「这一次入住的性质」（员工自己住 / 招待用房），不是房间属性，
   * 也不是房价属性 —— 所以必须是前台显式勾选，绝不从 rate=0 反推：
   * 免费房有促销免单、赔付、OTA 预付等多种来源，用房价推入住性质必然算错。
   * 对应字段：stays.self_use（迁移第 20 段），房态页「自用」标签只认它。
   */
  const [selfUse, setSelfUse] = useState(false);

  // 住客
  const [guestDrafts, setGuestDrafts] = useState<GuestRow[]>(() => [
    {
      rowKey: nextGuestRowKey(),
      name: prefill?.guestName ?? "",
      mobile: prefill?.mobile ?? "",
      idType: "身份证",
      idNo: "",
      gender: "男",
      breakfast: String(prefill?.breakfast ?? 0),
    },
  ]);
  /*
   * 每行住客选中的老客（rowKey → 客史）。
   *
   * 选中后才在表单里渲染隐藏字段 `guest_id_<i>`：服务端 `checkInAction` 见到它
   * 就直接用这条客史，不再按证件号/手机号/姓名去猜 —— 同名客人的唯一出路。
   * 不选就没有这个字段，服务端按「证件号 → 手机号 → 唯一同名」匹配或新建。
   */
  const [guestPicks, setGuestPicks] = useState<Record<string, GuestPick>>({});

  // 字段聚焦引用
  const teamRef = useRef<HTMLInputElement | null>(null);
  const idNoRef = useRef<HTMLInputElement | null>(null);

  // 提交后才展示字段级红字校验
  const [submitted, setSubmitted] = useState(false);
  const primaryName = guestDrafts[0]?.name.trim() ?? "";
  const roomError = selectedRoomIds.length === 0;
  const nameError = primaryName === "";
  const showRoomError = submitted && roomError;
  const showNameError = submitted && nameError;

  const selectedSet = useMemo(() => new Set(selectedRoomIds), [selectedRoomIds]);
  const selectedRooms = useMemo(
    () => allRooms.filter((r) => selectedSet.has(r.id)),
    [allRooms, selectedSet]
  );

  const matchedMember = useMemo(() => {
    const q = memberCard.trim();
    if (!q) return null;
    const lq = q.toLowerCase();
    return (
      members.find(
        (m) =>
          String(m.id) === q ||
          (m.mobile !== "" && m.mobile === q) ||
          (m.idNo !== "" && m.idNo.toLowerCase() === lq)
      ) ??
      members.find((m) => (m.mobile !== "" && m.mobile.includes(q)) || m.name === q) ??
      null
    );
  }, [memberCard, members]);

  const rateFactor = RATE_CODES.find((r) => r.value === rateCode)?.factor ?? 1;
  const rateOf = (basePrice: number) =>
    round2(basePrice * rateFactor * (localMode === "hour" ? HOURLY_FACTOR * hours : 1));

  const roomFee = selectedRooms.reduce(
    (sum, room) => sum + rateOf(room.base_price) * (localMode === "hour" ? 1 : nights),
    0
  );
  const depositNum = Math.max(0, Number(deposit) || 0);
  const totalDeposit = depositNum * selectedRooms.length;

  function countOf(typeId: number): number {
    return selectedRooms.filter((r) => r.room_type_id === typeId).length;
  }

  function setTypeCount(type: RoomTypeGroup, next: number): void {
    const limit = Math.max(
      0,
      Math.min(Math.trunc(Number.isFinite(next) ? next : 0), type.rooms.length)
    );
    setSelectedRoomIds((prev) => {
      const others = prev.filter((id) => !type.rooms.some((r) => r.id === id));
      return [...others, ...type.rooms.slice(0, limit).map((r) => r.id)];
    });
  }

  function toggleRoom(roomId: number): void {
    setSelectedRoomIds((prev) =>
      prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId]
    );
  }

  function changeNights(next: number): void {
    const value = Math.min(365, Math.max(1, Math.trunc(Number.isFinite(next) ? next : 1)));
    setNights(value);
    setCheckOutDate(todayStr(addDays(checkInDate || today, value)));
  }

  function changeCheckInDate(value: string): void {
    setCheckInDate(value);
    if (value) setCheckOutDate(todayStr(addDays(value, nights)));
  }

  function changeCheckOutDate(value: string): void {
    setCheckOutDate(value);
    if (value && checkInDate && value > checkInDate) {
      setNights(Math.max(1, nightsBetween(checkInDate, value)));
    }
  }

  /**
   * 改某一行住客的字段
   *
   * 一旦改动姓名 / 手机号 / 证件号，就必须清掉这一行已选中的客史：
   * 服务端「显式指定的 guest_id」优先级最高，留着旧选择会让前台
   * 「把身份证号改成了另一个人的，账单却还挂在原来那条客史」——正是本问题要消灭的错挂。
   */
  function updateGuest(rowKey: string, patch: Partial<GuestDraft>): void {
    setGuestDrafts((prev) => prev.map((g) => (g.rowKey === rowKey ? { ...g, ...patch } : g)));
    if (patch.name !== undefined || patch.mobile !== undefined || patch.idNo !== undefined) {
      clearPick(rowKey);
    }
  }

  function addGuest(): void {
    setGuestDrafts((prev) => (prev.length >= 9 ? prev : [...prev, emptyGuest()]));
  }

  function removeGuest(rowKey: string): void {
    setGuestDrafts((prev) => (prev.length <= 1 ? prev : prev.filter((g) => g.rowKey !== rowKey)));
    clearPick(rowKey);
  }

  /** 选中老客：只回填「空着的」姓名 / 前台自己输入的合法号码，绝不写入脱敏串 */
  function pickGuest(rowKey: string, candidate: GuestPickCandidate, query: string): void {
    setGuestPicks((prev) => ({ ...prev, [rowKey]: { candidate, query } }));
    const q = query.trim();
    setGuestDrafts((prev) =>
      prev.map((g) => {
        if (g.rowKey !== rowKey) return g;
        const next: GuestRow = { ...g };
        if (!next.name.trim()) next.name = candidate.name;
        if (!next.mobile.trim() && MOBILE_SHAPE.test(q)) next.mobile = q;
        if (!next.idNo.trim() && ID_NO_SHAPE.test(q)) next.idNo = q;
        return next;
      })
    );
  }

  function clearPick(rowKey: string): void {
    setGuestPicks((prev) => {
      if (!prev[rowKey]) return prev;
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  }

  /** 快捷：切到钟点房并预设 4 小时 */
  function startHourMode(): void {
    setLocalMode("hour");
    setHours(4);
  }

  const availableCount = allRooms.length;
  const modeLabel = localMode === "hour" ? `${hours} 小时` : `${nights} 晚`;
  const quickBtn =
    "card flex flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:border-emerald-400";

  return (
    <form
      action={formAction}
      className="space-y-4"
      onSubmit={() => setSubmitted(true)}
    >
      <input type="hidden" name="mode" value={localMode} />
      {prefill && <input type="hidden" name="booking_id" value={prefill.id} />}
      <input type="hidden" name="guest_count" value={guestDrafts.length} />
      {selectedRooms.map((room) => (
        <input key={room.id} type="hidden" name="room_id" value={room.id} />
      ))}
      {companies.length > 0 && (
        <datalist id="company-options">
          {companies.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
      )}

      {/* 右侧悬浮入口：对齐去呼呼「今日房价 / 库存」 */}
      <Link
                prefetch={false}
        href="/settings?tab=rates"
        title="今日房价 / 库存"
        className="fixed right-0 top-1/3 z-20 hidden select-none rounded-l-[4px] bg-[#58bc62] px-1.5 py-3 text-[12px] leading-[18px] text-white shadow-sm [writing-mode:vertical-rl] hover:bg-[#4fae59] lg:block"
      >
        今日房价/库存
      </Link>

      {/* 快捷入住条 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button type="button" onClick={() => focusRef(idNoRef)} className={quickBtn}>
          <span className="text-[13px] font-semibold text-gray-800">扫码 / 身份证入住</span>
          <span className="text-[11px] text-gray-400">聚焦证件号码输入框</span>
        </button>
        <button type="button" onClick={startHourMode} className={quickBtn}>
          <span className="text-[13px] font-semibold text-gray-800">钟点房 4 小时</span>
          <span className="text-[11px] text-gray-400">切换钟点房模式并预设 4 小时</span>
        </button>
        <button type="button" onClick={() => focusRef(teamRef)} className={quickBtn}>
          <span className="text-[13px] font-semibold text-gray-800">团队入住</span>
          <span className="text-[11px] text-gray-400">聚焦团队名称输入框</span>
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          {/* 第一块：tab + 订单基础信息 */}
          <div className="card overflow-hidden">
            <div className="flex items-end gap-5 border-b border-gray-200 px-4 pt-2.5">
              <TabLink
                href={`/frontdesk?mode=day${querySuffix}`}
                active={localMode === "day"}
                label="日租入住"
              />
              <TabLink
                href={`/frontdesk?mode=hour${querySuffix}`}
                active={localMode === "hour"}
                label="钟点房"
              />
              <span className="ml-auto pb-2 text-[11px] text-gray-400">
                散客步入 · 当前可售 <b className="font-medium text-gray-600">{availableCount}</b> 间
              </span>
            </div>

            <div className="space-y-3 p-4">
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="团队名称">
                  <input
                    ref={teamRef}
                    name="team_name"
                    className="input h-[30px] w-full text-[12px]"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder="请输入团队名称"
                    autoComplete="off"
                  />
                </Field>
                <Field label="会员信息">
                  <input
                    name="member_card"
                    className="input h-[30px] w-full text-[12px]"
                    value={memberCard}
                    onChange={(e) => setMemberCard(e.target.value)}
                    placeholder="会员卡号或手机号"
                    autoComplete="off"
                  />
                </Field>
                <Field label="会员类型">
                  <input
                    name="member_type"
                    readOnly
                    value={matchedMember ? vipText(matchedMember.vipLevel) : memberCard.trim() ? "普通" : ""}
                    placeholder="自动匹配"
                    className="input h-[30px] w-full bg-gray-100 text-[12px] text-gray-600"
                    title={matchedMember ? `已匹配客史：${matchedMember.name}` : "输入会员卡号 / 手机号自动匹配"}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="入住日期">
                  <div className="flex w-full items-center gap-1">
                    <input
                      type="date"
                      name="check_in_date"
                      className="input h-[30px] flex-1 text-[12px]"
                      value={checkInDate}
                      onChange={(e) => changeCheckInDate(e.target.value)}
                    />
                    <select
                      name="check_in_time"
                      className="input h-[30px] w-[86px] text-[12px]"
                      value={checkInTime}
                      onChange={(e) => setCheckInTime(e.target.value)}
                    >
                      {timeOptions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                </Field>

                {localMode === "day" ? (
                  <>
                    <Field label="离店日期">
                      <div className="flex w-full items-center gap-1">
                        <input
                          type="date"
                          name="check_out_date"
                          className="input h-[30px] flex-1 text-[12px]"
                          value={checkOutDate}
                          min={checkInDate || undefined}
                          onChange={(e) => changeCheckOutDate(e.target.value)}
                        />
                        <select
                          name="check_out_time"
                          className="input h-[30px] w-[86px] text-[12px]"
                          value={checkOutTime}
                          onChange={(e) => setCheckOutTime(e.target.value)}
                        >
                          {timeOptions.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                    </Field>
                    <Field label="入住天数">
                      <div className="flex h-[30px] w-full items-center rounded-md border border-gray-300 bg-white">
                        <button
                          type="button"
                          aria-label="减少入住天数"
                          onClick={() => changeNights(nights - 1)}
                          className="h-full w-7 text-[15px] leading-none text-gray-500 hover:bg-gray-50"
                        >
                          −
                        </button>
                        <input
                          name="nights"
                          value={nights}
                          onChange={(e) => changeNights(Number(e.target.value))}
                          inputMode="numeric"
                          aria-label="入住天数"
                          className="h-full w-full border-x border-gray-200 text-center text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
                        />
                        <button
                          type="button"
                          aria-label="增加入住天数"
                          onClick={() => changeNights(nights + 1)}
                          className="h-full w-7 text-[15px] leading-none text-gray-500 hover:bg-gray-50"
                        >
                          +
                        </button>
                      </div>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="时长">
                      <select
                        name="hours"
                        className="input h-[30px] w-full text-[12px]"
                        value={hours}
                        onChange={(e) => setHours(Number(e.target.value))}
                      >
                        {HOUR_OPTIONS.map((h) => (
                          <option key={h} value={h}>
                            {h} 小时
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="离店时间">
                      <span className="text-[12px] tabular-nums text-gray-700">
                        预计 {addHoursText(checkInTime, hours)} 离店
                      </span>
                    </Field>
                  </>
                )}

                <Field label="协议客户">
                  <input
                    name="company"
                    className="input h-[30px] w-full text-[12px]"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="协议客户"
                    list={companies.length > 0 ? "company-options" : undefined}
                    autoComplete="off"
                  />
                </Field>
                <Field label="销售员">
                  <select
                    name="salesman"
                    className="input h-[30px] w-full text-[12px]"
                    value={salesman}
                    onChange={(e) => setSalesman(e.target.value)}
                  >
                    <option value="">请选择销售员</option>
                    {salesmen.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.role ? `${s.name}（${s.role}）` : s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="房价代码">
                  <select
                    name="rate_code"
                    className="input h-[30px] w-full text-[12px]"
                    value={rateCode}
                    onChange={(e) => setRateCode(e.target.value)}
                  >
                    {RATE_CODES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="渠道来源">
                  <select
                    name="channel_id"
                    className="input h-[30px] w-full text-[12px]"
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                  >
                    <option value="">线下客人</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="渠道订单号">
                  <input
                    name="channel_order_no"
                    className="input h-[30px] w-full text-[12px]"
                    value={channelOrderNo}
                    onChange={(e) => setChannelOrderNo(e.target.value)}
                    placeholder="渠道订单号"
                    autoComplete="off"
                  />
                </Field>
                <Field label="收款类型">
                  <select
                    name="pay_type"
                    className="input h-[30px] w-full text-[12px]"
                    value={payType}
                    onChange={(e) => setPayType(e.target.value)}
                  >
                    {PAY_TYPES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="包价">
                  <input
                    name="package_code"
                    className="input h-[30px] w-full text-[12px]"
                    value={packageCode}
                    onChange={(e) => setPackageCode(e.target.value)}
                    placeholder="包价"
                    autoComplete="off"
                  />
                </Field>
                <Field label="开票方">
                  <select
                    name="invoice_party"
                    className="input h-[30px] w-full text-[12px]"
                    value={invoiceParty}
                    onChange={(e) => setInvoiceParty(e.target.value)}
                  >
                    {INVOICE_PARTIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="押金">
                  <div className="flex w-full items-center gap-1.5">
                    <input
                      name="deposit"
                      type="number"
                      min={0}
                      step={0.01}
                      className="input h-[30px] flex-1 text-[12px]"
                      value={deposit}
                      onChange={(e) => setDeposit(e.target.value)}
                      placeholder="元 / 间"
                    />
                    <span className="shrink-0 text-[11px] text-gray-400">每间</span>
                  </div>
                </Field>
              </div>

              {/*
                自用勾选（第 5 轮 P1-4）
                放在订单信息最后一行：频率低，但必须在入住时能勾。
                显式勾选才写 stays.self_use = 1；房态页「自用」标签只查这个字段，
                免费房（rate = 0）不会被算成自用。
              */}
              <label className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-gray-200 px-2.5 py-1.5">
                <input
                  type="checkbox"
                  name="self_use"
                  value="1"
                  checked={selfUse}
                  onChange={(e) => setSelfUse(e.target.checked)}
                  className="h-3.5 w-3.5 accent-emerald-600"
                />
                <span className="text-[12px] text-gray-700">自用（员工 / 招待用房）</span>
                <span className="text-[11px] text-gray-400">
                  勾选后计入房态页「自用」标签；与房价为 0 的免费房无关，免费房请按实际房价填写
                </span>
              </label>
            </div>
          </div>

          {/* 第二块：快速排房 + 住客 + 备注 */}
          <div className="card space-y-4 p-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRoomPanelOpen((v) => !v)}
                  aria-expanded={roomPanelOpen}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded bg-[#3fa855] px-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#379a4c]"
                >
                  <HomeIcon />
                  快速排房（卡片选房）
                  <span className={`text-[9px] transition-transform ${roomPanelOpen ? "rotate-180" : ""}`}>▾</span>
                </button>
                {showRoomError && <span className="text-[12px] text-red-500">请先选择房间</span>}
              </div>

              {roomPanelOpen && (
                <div className="mt-2 rounded-md border border-gray-200 bg-white">
                  {roomTypes.length === 0 && (
                    <div className="px-3 py-4 text-center text-[12px] text-gray-400">
                      暂无可售房型，请先到
                      <Link prefetch={false} href="/rooms" className="mx-1 text-brand-600 hover:underline">
                        房态图
                      </Link>
                      清理出空净房
                    </div>
                  )}
                  {roomTypes.map((type) => (
                    <div
                      key={type.id}
                      className="border-t border-gray-100 px-2.5 py-2 first:border-t-0"
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <div className="w-[112px] shrink-0">
                          <div className="text-[12px] font-medium text-gray-800">{type.name}</div>
                          <div className="text-[11px] text-gray-400">
                            可订 {type.rooms.length} 间
                            {type.max_occupancy ? ` · 可住 ${type.max_occupancy} 人` : ""}
                          </div>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                          <span className="text-[11px] text-gray-400">间数</span>
                          <div className="flex h-[26px] items-center rounded border border-gray-300">
                            <button
                              type="button"
                              aria-label={`减少${type.name}间数`}
                              onClick={() => setTypeCount(type, countOf(type.id) - 1)}
                              className="h-full w-5 text-[13px] leading-none text-gray-500 hover:bg-gray-50"
                            >
                              −
                            </button>
                            <input
                              value={countOf(type.id)}
                              onChange={(e) => setTypeCount(type, Number(e.target.value))}
                              inputMode="numeric"
                              aria-label={`${type.name}间数`}
                              className="h-full w-8 border-x border-gray-200 text-center text-[12px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
                            />
                            <button
                              type="button"
                              aria-label={`增加${type.name}间数`}
                              onClick={() => setTypeCount(type, countOf(type.id) + 1)}
                              className="h-full w-5 text-[13px] leading-none text-gray-500 hover:bg-gray-50"
                            >
                              +
                            </button>
                          </div>
                          <span className="ml-1 text-[11px] text-gray-500">
                            房价 {fmtMoney(rateOf(type.base_price))}
                            {localMode === "day" ? "/晚" : `/${hours}小时`}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {type.rooms.length === 0 ? (
                          <span className="col-span-full text-[11px] text-gray-300">暂无可售房</span>
                        ) : (
                          type.rooms.map((room) => {
                            const active = selectedSet.has(room.id);
                            return (
                              <button
                                key={room.id}
                                type="button"
                                onClick={() => toggleRoom(room.id)}
                                aria-pressed={active}
                                className={`flex flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
                                  active
                                    ? "border-emerald-500 bg-emerald-50"
                                    : "border-gray-200 bg-white hover:border-emerald-300"
                                }`}
                              >
                                <span className="flex w-full items-center justify-between gap-1">
                                  <span
                                    className={`text-[12px] font-semibold tabular-nums ${
                                      active ? "text-emerald-700" : "text-gray-800"
                                    }`}
                                  >
                                    {room.room_no}
                                  </span>
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[room.status] ?? "bg-gray-300"}`}
                                    title={room.status === "VD" ? "空脏" : "空净"}
                                  />
                                </span>
                                <span className="w-full truncate text-[10px] text-gray-400">
                                  {type.name}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {selectedRooms.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-700">
                  <span>
                    已排房：
                    <b className="font-semibold">{selectedRooms.map((r) => r.room_no).join("、")}</b>
                  </span>
                  <span className="text-[11px] text-emerald-600/80">
                    共 {selectedRooms.length} 间 · 房费 {fmtMoney(roomFee)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedRoomIds([])}
                    className="ml-auto text-[11px] text-emerald-700 underline hover:text-emerald-800"
                  >
                    清空
                  </button>
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-gray-800">住客信息</span>
                <Link prefetch={false} href="/guests" className="text-[11px] text-brand-600 hover:underline">
                  关于未成年入住「五必须」
                </Link>
                <span className="ml-auto text-[11px] text-gray-400">
                  主住客姓名必填，可添加多名同住人
                </span>
              </div>

              {roomError && !submitted && (
                <p className="mb-2 text-[12px] text-red-500">请先排房，再录入住客信息</p>
              )}

              <div className="space-y-2.5">
                {guestDrafts.map((guest, index) => {
                  /*
                   * 服务端按「有名住客」的顺序取 guest_id_<i>：
                   * checkInAction 先把每行读成 guests[]，再 filter(name) 得到 namedGuests，
                   * 然后 for (gi) 读 guest_id_${gi}。所以后缀必须用「本行前面有几位能提交的住客」，
                   * 不能直接用行号 —— 表单里若有空白行，用行号会整体错位一格，
                   * 前台明明选了老客，入住单却悄悄挂到别的档案上。
                   */
                  const namedIndex = guestDrafts
                    .slice(0, index)
                    .filter((g) => g.name.trim()).length;
                  const pick = guestPicks[guest.rowKey];
                  return (
                  <div key={guest.rowKey} className="rounded-md border border-gray-200 bg-gray-50/60 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[12px] font-medium text-gray-700">
                        {index === 0 ? "主住客" : `住客 ${index + 1}`}
                      </span>
                      {index === 0 && <span className="text-[11px] text-red-500">姓名 *</span>}
                      {index > 0 && (
                        <button
                          type="button"
                          onClick={() => removeGuest(guest.rowKey)}
                          className="ml-auto text-[11px] text-rose-500 hover:underline"
                        >
                          删除
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-gray-500">
                          姓名 {index === 0 && <span className="text-red-500">*</span>}
                        </span>
                        <input
                          name={`guest_name_${index}`}
                          className="input h-[30px] w-full bg-white text-[12px]"
                          value={guest.name}
                          onChange={(e) => updateGuest(guest.rowKey, { name: e.target.value })}
                          placeholder="请输入姓名"
                          autoComplete="off"
                        />
                        {index === 0 && showNameError && (
                          <span className="text-[11px] text-red-500">请填写主住客姓名</span>
                        )}
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[12px] text-gray-500">手机</span>
                        <input
                          name={`guest_mobile_${index}`}
                          className="input h-[30px] w-full bg-white text-[12px]"
                          value={guest.mobile}
                          onChange={(e) => updateGuest(guest.rowKey, { mobile: e.target.value })}
                          placeholder="手机号"
                          inputMode="tel"
                          autoComplete="off"
                        />
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[12px] text-gray-500">证件类型</span>
                        <select
                          name={`guest_id_type_${index}`}
                          className="input h-[30px] w-full bg-white text-[12px]"
                          value={guest.idType}
                          onChange={(e) => updateGuest(guest.rowKey, { idType: e.target.value })}
                        >
                          {ID_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-gray-500">证件号</span>
                        <input
                          ref={index === 0 ? idNoRef : undefined}
                          name={`guest_id_no_${index}`}
                          className="input h-[30px] w-full bg-white text-[12px]"
                          value={guest.idNo}
                          onChange={(e) => updateGuest(guest.rowKey, { idNo: e.target.value })}
                          placeholder="证件号码"
                          autoComplete="off"
                        />
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[12px] text-gray-500">性别</span>
                        <select
                          name={`guest_gender_${index}`}
                          className="input h-[30px] w-full bg-white text-[12px]"
                          value={guest.gender}
                          onChange={(e) => updateGuest(guest.rowKey, { gender: e.target.value })}
                        >
                          {GENDERS.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[12px] text-gray-500">早餐</span>
                        <select
                          name={`guest_breakfast_${index}`}
                          className="input h-[30px] w-full bg-white text-[12px]"
                          value={guest.breakfast}
                          onChange={(e) => updateGuest(guest.rowKey, { breakfast: e.target.value })}
                        >
                          {BREAKFASTS.map((b) => (
                            <option key={b} value={b}>
                              {b} 份
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {/* 选择已有客史：同名客人的唯一出路（选中后带 guest_id_<i> 提交） */}
                    <GuestHistoryPicker
                      draft={guest}
                      picked={pick?.candidate ?? null}
                      onPick={(candidate, query) => pickGuest(guest.rowKey, candidate, query)}
                      onClear={() => clearPick(guest.rowKey)}
                    />
                    {pick && guest.name.trim() && (
                      <input type="hidden" name={`guest_id_${namedIndex}`} value={pick.candidate.id} />
                    )}
                  </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={addGuest}
                className="mt-2 rounded border border-dashed border-gray-300 px-2.5 py-1 text-[12px] text-gray-600 transition-colors hover:border-emerald-400 hover:text-emerald-700"
              >
                + 增加住客
              </button>
            </div>

            <div>
              <label htmlFor="remark" className="mb-1 block text-[13px] font-semibold text-gray-800">
                订单备注
              </label>
              <textarea
                id="remark"
                name="remark"
                className="input min-h-[96px] resize-y bg-white text-[12px]"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="特殊要求、担保方式、同住人信息等"
              />
            </div>

            {/* 底部居中「入住」按钮：对齐去呼呼散客步入页 */}
            <div className="flex justify-center pt-1">
              <button
                type="submit"
                disabled={pending || roomError || nameError}
                className="h-9 w-[120px] rounded-[2px] bg-[#58bc62] text-[14px] text-white transition-colors hover:bg-[#4fae59] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "办理中…" : "入住"}
              </button>
            </div>

            {state.error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600">
                {state.error}
              </div>
            )}
            {state.ok && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">
                {state.ok} · 正在跳转在住单…
              </div>
            )}
          </div>
        </div>

        {/* 右侧：入住摘要（sticky） */}
        <aside className="card self-start p-4 lg:sticky lg:top-4">
          <div className="mb-3 text-[13px] font-semibold text-gray-800">入住摘要</div>

          <div className="space-y-2 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">已选房号</span>
              <span className="text-right font-medium text-gray-800">
                {selectedRooms.length > 0 ? selectedRooms.map((r) => r.room_no).join("、") : "未选房"}
              </span>
            </div>

            <div className="space-y-1.5 border-t border-gray-100 pt-2">
              {selectedRooms.length === 0 && (
                <div className="py-2 text-center text-[11px] text-gray-400">选择房间后展示房价明细</div>
              )}
              {selectedRooms.map((room) => (
                <div key={room.id} className="flex items-center justify-between gap-2 text-gray-700">
                  <span className="truncate">
                    {room.room_no} · {room.room_type_name}
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-500">
                    {fmtMoney(rateOf(room.base_price))} × {modeLabel}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-2">
              <span className="text-gray-500">押金</span>
              <span className="tabular-nums text-gray-800">{fmtMoney(totalDeposit)}</span>
            </div>
            {selfUse && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-500">入住性质</span>
                <span className="text-[12px] font-medium text-amber-700">自用房</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500">预计房费</span>
              <span className="text-[15px] font-semibold tabular-nums text-emerald-700">
                {fmtMoney(roomFee)}
              </span>
            </div>
          </div>

          {(showRoomError || showNameError) && (
            <div className="mt-3 space-y-1 text-[11px] text-red-500">
              {showRoomError && <div>· 请先选择房间</div>}
              {showNameError && <div>· 请填写主住客姓名</div>}
            </div>
          )}

          <button
            type="submit"
            disabled={pending || roomError || nameError}
            className="mt-3 h-[38px] w-full rounded-md bg-[#5cb85c] text-[14px] font-medium text-white transition-colors hover:bg-[#4f9e4f] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "办理中…" : "确认入住"}
          </button>
        </aside>
      </div>
    </form>
  );
}
