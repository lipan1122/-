"use client";

import Link from "next/link";
import { Fragment, useActionState, useEffect, useMemo, useState } from "react";
import {
  addChargeAction,
  splitFolioAction,
  addDepositAction,
  addPaymentAction,
  chargeToCompanyAction,
  checkoutAction,
  delayCheckoutAction,
  invoiceAction,
  partialSettleAction,
  reopenStayAction,
  reverseCheckoutAction,
  refundPaymentAction,
  transferAction,
} from "@/app/(main)/cashier/actions";
import {
  addCompanionAction,
  addOtherChargeAction,
  adjustRateAction,
  changeStayRoomAction,
  extendStayAction,
  joinTeamAction,
  linkRoomsAction,
} from "@/app/(main)/rooms/actions";
import { fmtMoney } from "@/lib/utils";
/* 第 4 轮 P2-22a：拆账等危险操作统一走确认弹窗 */
import ConfirmForm from "@/components/ConfirmForm";

export type CashierStay = {
  stayId: number;
  stayNo: string;
  roomId: number;
  roomNo: string;
  floor: number | null;
  roomTypeName: string | null;
  guestName: string;
  mobile: string | null;
  status: string;
  checkInTime: string | null;
  expectCheckOut: string | null;
  actualCheckOut: string | null;
  nights: number | null;
  rate: number;
  deposit: number | null;
  guestCount: number | null;
  remark: string | null;
  teamName: string | null;
  memberCard: string | null;
  memberType: string | null;
  rateCode: string | null;
  salesman: string | null;
  packageCode: string | null;
  invoiceParty: string | null;
  payType: string | null;
  breakfast: number | null;
  createdAt: string | null;
  channelName: string | null;
  companyName: string | null;
  bookingNo: string | null;
  channelOrderNo: string | null;
  arrivalTime: string | null;
  retainTime: string | null;
};

export type CashierFolio = {
  id: number;
  folioNo: string;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  status: string;
  settledAt: string | null;
};

export type CashierItem = {
  id: number;
  itemType: string;
  description: string | null;
  qty: number | null;
  price: number | null;
  amount: number;
  bizDate: string | null;
  createdAt: string | null;
  operator: string;
  payMethod: string;
};

export type CashierPayment = {
  id: number;
  payNo: string | null;
  method: string | null;
  amount: number;
  bizDate: string | null;
  remark: string | null;
  createdAt: string | null;
};

export type CashierLog = {
  id: number;
  operator: string | null;
  action: string;
  detail: string | null;
  createdAt: string | null;
};

export type TransferTarget = {
  stayId: number;
  folioId: number;
  roomNo: string;
  guestName: string;
  balance: number;
};

export type CompanyOption = { id: number; name: string };

/** 换房可选的目标空房 */
export type RoomOption = {
  roomId: number;
  roomNo: string;
  status: string;
  roomTypeName: string | null;
};

/** 联房可选的其他在住房间 */
export type StayOption = {
  stayId: number;
  stayNo: string;
  roomNo: string;
  guestName: string;
};

export type CompanionRow = {
  id: number;
  name: string;
  mobile: string | null;
  idNo: string | null;
  relation: string | null;
  createdAt: string | null;
};

export type WakeUpRow = {
  id: number;
  wakeTime: string | null;
  content: string | null;
  createdAt: string | null;
};

export type CashierTotals = {
  room: number;
  consume: number;
  deposit: number;
  settle: number;
  receivable: number;
  received: number;
  balance: number;
  invoiced: number;
};

type Props = {
  stay: CashierStay;
  folio: CashierFolio;
  items: CashierItem[];
  payments: CashierPayment[];
  logs: CashierLog[];
  companies: CompanyOption[];
  transferTargets: TransferTarget[];
  vacantRooms: RoomOption[];
  inhouseStays: StayOption[];
  companions: CompanionRow[];
  wakeUpCalls: WakeUpRow[];
  totals: CashierTotals;
  invoiceCount: number;
  checkInLimit: string;
  initOp?: string;
  creditCompany: string | null;
};

type FormState = { error?: string; ok?: string } | null;
type OpenForm =
  | "checkout"
  | "partial"
  | "charge"
  | "receive"
  | "deposit"
  | "transfer"
  | "credit"
  | "roomfee"
  | "reverse"
  | "refund"
  | "invoice"
  | "link"
  | "changeRoom"
  | "rate"
  | "extend"
  | "delay"
  | "companion"
  | "team"
  | "reopen"
  | "housecharge"
  | null;

/*
 * 支付方式（第 4 轮 P1-9：加「会员储值卡」）
 *
 * 原来硬编码 5 项，与设置页配置的 16 项完全脱节：
 * 会员充了钱，收银台却没有储值卡这个选项，钱花不出去。
 * 这里补上储值卡；选它时服务端会校验会员余额并扣减（addPaymentAction 内实现）。
 */
const PAY_METHODS = ["现金", "微信", "支付宝", "银行卡", "会员储值卡", "挂账"];

/**
 * 生成一次收银台操作的幂等请求号（第十轮 P1：4 个写动作补 request_id）
 *
 * ── 为什么必须三级降级 ──
 * 收银台在酒店前台机上通常通过 `http://内网IP:3100` 访问，那是**非安全上下文**：
 * `crypto.randomUUID()` 在那里不存在或直接抛错，只用它会让「确认收款 / 退房」按钮静默失效。
 * 与第七轮 ShopPOS、第九轮 RoomBoard 同一套降级（三级都不抛错）：
 *   1. crypto.randomUUID()      → https / localhost
 *   2. crypto.getRandomValues() → http 也能用，手工拼 RFC4122 v4
 *   3. 时间戳 + Math.random()   → 老浏览器 / 无 crypto 兜底
 */
function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* 非安全上下文等场景：继续降级 */
    }
  }
  if (c && typeof c.getRandomValues === "function") {
    try {
      const buf = new Uint8Array(16);
      c.getRandomValues(buf);
      /* RFC4122 v4：版本位与变体位 */
      buf[6] = (buf[6] & 0x0f) | 0x40;
      buf[8] = (buf[8] & 0x3f) | 0x80;
      const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      /* 继续降级 */
    }
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * 收银台「每个写操作各持一枚」的幂等键名
 *
 * 为什么不能全组件共用一枚：
 *   押金提交「服务端已成功、网络断开」时客户端拿不到结果，必须复用同一枚重试；
 *   此刻若改成去记房费，共用一枚键 —— 服务端按 request_id 查重会命中那笔押金，
 *   把房费当重复提交丢掉（客人房费白记）。所以每种操作一枚，互不串号。
 *
 * 生命周期：
 *   · 首帧是空串：服务端渲染与 hydration 必须一致，随机值只能在**挂载后**生成；
 *   · 换账单 / 换客人（scope 变）→ 整组换新（同一枚键跨账单提交会被别单的
 *     唯一索引命中，被当成重复提交丢掉）；
 *   · 提交成功 → bump 换新；业务失败 / 网络结果未知 → 不动，重试复用同一枚。
 */
const REQUEST_KEYS = ["checkout", "receive", "deposit", "refund", "charge", "roomfee"] as const;

function freshRequestIds(): Record<string, string> {
  return Object.fromEntries(REQUEST_KEYS.map((k) => [k, newRequestId()]));
}

function useActionRequestIds(scope: string) {
  const [ids, setIds] = useState<Record<string, string>>({});
  useEffect(() => {
    /* 挂载 / 切换账单：整组换新（服务端渲染时 ids 是空串，保证 hydration 一致） */
    setIds(freshRequestIds());
  }, [scope]);
  const bump = (key: string) => setIds((prev) => ({ ...prev, [key]: newRequestId() }));
  return { ids, bump };
}
const PAGE_SIZE = 10;

/* ---- 去呼呼视觉规范：30px 高 / 12px 字 / 间距 4px ---- */
const BTN_GREEN =
  "inline-flex h-[30px] items-center justify-center rounded border border-[#5cb85c] bg-[#5cb85c] px-2.5 text-[12px] text-white transition-colors hover:border-[#4cae4c] hover:bg-[#4cae4c] disabled:cursor-not-allowed disabled:border-[#e0e0e0] disabled:bg-[#f5f5f5] disabled:text-[#b8b8b8]";
const BTN_GHOST =
  "inline-flex h-[30px] items-center justify-center rounded border border-[#d9d9d9] bg-white px-2.5 text-[12px] text-[#555] transition-colors hover:border-[#5cb85c] hover:text-[#4cae4c] disabled:cursor-not-allowed disabled:border-[#efefef] disabled:text-[#c4c4c4]";
const BTN_GHOST_ON =
  "inline-flex h-[30px] items-center justify-center rounded border border-[#4cae4c] bg-[#f0f9f2] px-2.5 text-[12px] text-[#4cae4c]";
const BTN_BOTTOM =
  "inline-flex h-[30px] items-center justify-center rounded border border-[#d9d9d9] bg-white px-2.5 text-[12px] text-[#555] transition-colors hover:border-[#5cb85c] hover:text-[#4cae4c] disabled:cursor-not-allowed disabled:border-[#efefef] disabled:text-[#c4c4c4]";
const BTN_BOTTOM_ON =
  "inline-flex h-[30px] items-center justify-center rounded border border-[#4cae4c] bg-[#f0f9f2] px-2.5 text-[12px] text-[#4cae4c]";

/* ---- 明细表：淡绿表头 + 36px 行高 ---- */
const TH = "whitespace-nowrap bg-[#eef6f1] px-2 py-2 text-left text-[12px] font-normal text-[#5c6b63]";
const TH_R = "whitespace-nowrap bg-[#eef6f1] px-2 py-2 text-right text-[12px] font-normal text-[#5c6b63]";
const TD = "h-9 whitespace-nowrap border-t border-[#f2f2f2] px-2 text-[12px] text-[#555]";
const TD_R = "h-9 whitespace-nowrap border-t border-[#f2f2f2] px-2 text-right text-[12px] tabular-nums text-[#333]";

const ITEM_META: Record<string, { label: string; cls: string }> = {
  ROOM: { label: "房费", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  FOOD: { label: "餐饮", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  OTHER: { label: "其他", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  DEPOSIT: { label: "押金", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  ADJUST: { label: "调整", cls: "bg-gray-100 text-gray-600 border-gray-200" },
};

const GROUP_ORDER: { type: string; label: string }[] = [
  { type: "ROOM", label: "房费" },
  { type: "FOOD", label: "餐饮" },
  { type: "OTHER", label: "其他" },
  { type: "DEPOSIT", label: "押金" },
  { type: "ADJUST", label: "调整" },
];

const TABS: { key: "detail" | "finance" | "logs"; label: string }[] = [
  { key: "detail", label: "订单详情" },
  { key: "finance", label: "财务明细" },
  { key: "logs", label: "日志" },
];

const FIN_FILTERS: { key: "all" | "unsettled" | "settled" | "transfer"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "unsettled", label: "未结账" },
  { key: "settled", label: "已结账" },
  { key: "transfer", label: "转出" },
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function stamp(value: string | null | undefined) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dateOnly(value: string | null | undefined) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD 相加天数，非法输入退回今天 */
function addDaysLocal(value: string, n: number) {
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayLocal();
  const d = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(d.getTime())) return todayLocal();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 统一把 server action 的返回值收敛成表单状态（入住类 action 可能返回 void） */
function asFormState(result: unknown): FormState {
  if (result && typeof result === "object") {
    const r = result as { error?: unknown; ok?: unknown };
    if (typeof r.error === "string" && r.error) return { error: r.error };
    if (typeof r.ok === "string" && r.ok) return { ok: r.ok };
  }
  return null;
}

function isPartialSettle(it: { itemType: string; description: string | null }) {
  return it.itemType === "ADJUST" && (it.description ?? "").startsWith("【部分结账】");
}

function isTransferRow(it: { itemType: string; description: string | null }) {
  return it.itemType === "ADJUST" && /^【(转出|转入)】/.test(it.description ?? "");
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1 text-[12px] leading-5">
      <span className="shrink-0 text-[11px] text-[#999]">{label}</span>
      <span className="min-w-0 break-words text-[#555]">{value}</span>
    </div>
  );
}

/** 订单信息条里的「标签：值」行内字段（标签灰、值深灰，不截断、自然换行） */
function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-[12px] leading-5">
      <span className="shrink-0 text-[#999]">{label}：</span>
      <span className="text-[#555]">{value}</span>
    </span>
  );
}

/** 明细行里的状态小徽标 */
function StatusTag({ text }: { text: string }) {
  const done = text === "已结";
  return (
    <span
      className={`inline-block rounded-[2px] border px-1 text-[11px] leading-4 ${
        done ? "border-[#b7e0c0] bg-[#f0f9f2] text-[#3f9d57]" : "border-[#f0d8b0] bg-[#fdf6ec] text-[#c8811f]"
      }`}
    >
      {text}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function FormPanel({
  title,
  hint,
  submitLabel,
  pending,
  state,
  onSubmit,
  onClose,
  confirmText,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  submitLabel: string;
  pending: boolean;
  state: FormState;
  onSubmit: (formData: FormData) => void | Promise<void>;
  onClose: () => void;
  /*
   * 二次确认文案（第 5 轮 P2-1）
   *
   * 退款 / 撤销退房这类**不可逆的资金操作**，点一下提交就真的执行了。
   * 传了这个 prop 后，第一次点提交只弹确认（把表单内容摘要展示一遍），
   * 第二次点才真正提交 —— 用两层 state 实现，不需要 portal 弹窗。
   *
   * 不传就保持原行为（普通表单直接提交）。
   */
  confirmText?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);

  /* 没传 confirmText → 原来的直接提交 */
  const needConfirm = Boolean(confirmText);

  return (
    <form
      action={onSubmit}
      onSubmit={(e) => {
        if (!needConfirm) return;
        if (!confirming) {
          /* 第一次点：拦下来，展示确认区 */
          e.preventDefault();
          setConfirming(true);
        }
        /* confirming=true 时放行，真正提交 */
      }}
      className="space-y-2 rounded border border-[#eee] bg-[#fafcfa] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-[#333]">{title}</span>
        <div className="flex items-center gap-3 text-[11px] text-[#999]">
          {hint}
          <button type="button" onClick={onClose} className="text-[#999] hover:text-[#555]">
            收起
          </button>
        </div>
      </div>
      {children}
      {state?.error && (
        <div className="rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-600">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-700">
          {state.ok}
        </div>
      )}

      {/* 确认区：只在第一次点提交后出现 */}
      {needConfirm && confirming && (
        <div className="rounded border border-rose-300 bg-rose-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-rose-800">
          <div className="mb-1 font-medium">请确认这项操作</div>
          <div>{confirmText}</div>
          <div className="mt-1 text-[11px] text-rose-600">此操作不可撤销，再点一次下面的按钮才会执行。</div>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className={
          (needConfirm && confirming ? "rounded bg-rose-600 px-3 py-1.5 text-white hover:bg-rose-700 " : BTN_GREEN) +
          " w-full"
        }
      >
        {pending ? "处理中…" : needConfirm && confirming ? `确认${submitLabel}` : submitLabel}
      </button>
    </form>
  );
}

/** 打印按钮：供 /cashier/print 打印页复用（避免额外新增客户端文件） */
export function PrintButton({ label = "打印" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={BTN_GREEN}>
      {label}
    </button>
  );
}

export default function CashierPanel({
  stay,
  folio,
  items,
  payments,
  logs,
  companies,
  transferTargets,
  vacantRooms,
  inhouseStays,
  companions,
  wakeUpCalls,
  totals,
  invoiceCount,
  checkInLimit,
  creditCompany,
  initOp,
}: Props) {
  /* ---------- 去呼呼 280 项里的 7 个房态操作 ---------- */
  const OP_META: Record<string, { title: string; desc: string }> = {
    overnight: { title: "空隔夜检查", desc: "列出当前空房，标记隔夜未售出的房间" },
    "cancel-approve": { title: "取消入住审批", desc: "审批客人的取消入住申请" },
    exchange: { title: "置换房", desc: "把当前房间与另一间空房互换" },
    "make-card": { title: "制门卡", desc: "为本房间写入门卡" },
    "re-checkin": { title: "重新入住", desc: "退房后重新办理入住" },
    negative: { title: "负值入账", desc: "录入一条负数账务（冲减）" },
    "guest-pwd": { title: "查看客人密码", desc: "显示本房间客人密码（需权限）" },
  };

  const [tab, setTab] = useState<"detail" | "finance" | "logs">("finance");
  const [open, setOpen] = useState<OpenForm>(null);
  const [finFilter, setFinFilter] = useState<"all" | "unsettled" | "settled" | "transfer">("all");
  const [showStyle, setShowStyle] = useState<"plain" | "grouped">("plain");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [partialPrefill, setPartialPrefill] = useState("");
  const [chargePrefill, setChargePrefill] = useState("");

  const settled = folio.status === "SETTLED";
  const hasDebt = totals.balance > 0.01;
  const creditMark = /【挂账】([^；]+)/.exec(stay.remark ?? "")?.[1] ?? creditCompany;
  const isCredit = Boolean(creditMark);
  const isInhouse = stay.status === "INHOUSE";

  /*
   * 资金操作幂等键（第十轮 P1）
   *
   * scope 用「账单 + 入住单」：换客人 / 换账单时整组换新。
   * 不换的后果是同一枚 request_id 跨账单提交 → 服务端按 (hotel_id, request_id)
   * 查重会把它当成另一张账单的重复提交丢掉（钱收了但没记账）。
   */
  const { ids: requestIds, bump: bumpRequestId } = useActionRequestIds(`${folio.id}:${stay.stayId}`);

  /**
   * 包装「资金类 server action」：成功才换新幂等键
   *
   * 失败 / 网络结果未知时**保留同一枚** —— 服务端按 request_id 幂等重放，
   * 重试不会变成两笔；成功后换新，下一笔才是新业务。
   * 隐藏字段缺失时（理论上只在首帧渲染瞬间）兜底生成一枚，保证至少不裸奔。
   */
  const withRequestId = (
    action: (fd: FormData) => Promise<{ error?: string; ok?: string } | undefined>,
    key: string
  ): ((_prev: FormState, formData: FormData) => Promise<FormState>) => async (_prev, formData) => {
    if (!formData.get("request_id")) formData.set("request_id", requestIds[key] || newRequestId());
    const out = (await action(formData)) ?? null;
    if (out && out.ok) bumpRequestId(key);
    return out;
  };

  // 加收消费 / 入账（与「加收房费」各持一枚键：押金/房费/其他消费不能共用）
  const [chargeState, chargeFormAction, chargePending] = useActionState<FormState, FormData>(
    withRequestId(addChargeAction, "charge"),
    null
  );
  // 加收房费（同一 action，但键与「入账」分开）
  const [roomFeeState, roomFeeFormAction, roomFeePending] = useActionState<FormState, FormData>(
    withRequestId(addChargeAction, "roomfee"),
    null
  );
  // 收款
  /*
   * 收款（第 4 轮 P1-11 + 第十轮 P1）
   *
   * addPaymentAction 里写了「同一 request_id 已收过就直接返回成功」，
   * 但第九轮之前前端从来没传过 request_id，那个分支永远走不到 ——
   * 收银台双击、网络超时重试、点两下提交，都会真的收两笔钱。
   * 现在 request_id 由组件 state 持有并作为隐藏字段提交：
   * 双击是同一枚键（服务端幂等重放），成功后换新（下一笔才是新业务）。
   */
  const [payState, payFormAction, payPending] = useActionState<FormState, FormData>(
    withRequestId(addPaymentAction, "receive"),
    null
  );
  // 预收款
  const [depositState, depositFormAction, depositPending] = useActionState<FormState, FormData>(
    withRequestId(addDepositAction, "deposit"),
    null
  );
  // 部分结账
  const [partialState, partialFormAction, partialPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => (await partialSettleAction(formData)) ?? null,
    null
  );
  // 挂账
  const [creditState, creditFormAction, creditPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> =>
      (await chargeToCompanyAction(formData)) ?? null,
    null
  );
  // 转账
  const [transferState, transferFormAction, transferPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => (await transferAction(formData)) ?? null,
    null
  );
  // 开发票
  const [invoiceState, invoiceFormAction, invoicePending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => (await invoiceAction(formData)) ?? null,
    null
  );
  // 退款（关联原收款，独立权限）
  const [refundState, refundFormAction, refundPending] = useActionState<FormState, FormData>(
    withRequestId(refundPaymentAction, "refund"),
    null
  );
  // 撤销结账
  const [reverseState, reverseFormAction, reversePending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => (await reverseCheckoutAction(formData)) ?? null,
    null
  );
  // 结账退房
  const [checkoutState, checkoutFormAction, checkoutPending] = useActionState<FormState, FormData>(
    withRequestId(checkoutAction, "checkout"),
    null
  );
  // 联房
  const [linkState, linkFormAction, linkPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => asFormState(await linkRoomsAction(formData)),
    null
  );
  // 换房
  const [changeRoomState, changeRoomFormAction, changeRoomPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> =>
      asFormState(await changeStayRoomAction(formData)),
    null
  );
  // 调价
  const [rateState, rateFormAction, ratePending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => asFormState(await adjustRateAction(formData)),
    null
  );
  // 续住
  const [extendState, extendFormAction, extendPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => asFormState(await extendStayAction(formData)),
    null
  );
  // 延迟退房
  const [delayState, delayFormAction, delayPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> =>
      (await delayCheckoutAction(formData)) ?? null,
    null
  );
  // 同住
  const [companionState, companionFormAction, companionPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> =>
      asFormState(await addCompanionAction(formData)),
    null
  );
  // 入团
  const [teamState, teamFormAction, teamPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => asFormState(await joinTeamAction(formData)),
    null
  );
  // 重新入住
  const [reopenState, reopenFormAction, reopenPending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => (await reopenStayAction(formData)) ?? null,
    null
  );
  // 客房收费
  const [houseState, houseFormAction, housePending] = useActionState<FormState, FormData>(
    async (_prev: FormState, formData: FormData): Promise<FormState> => asFormState(await addOtherChargeAction(formData)),
    null
  );

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (finFilter === "settled") return isPartialSettle(it);
      if (finFilter === "transfer") return isTransferRow(it);
      if (finFilter === "unsettled") return !isPartialSettle(it) && !isTransferRow(it);
      return true;
    });
  }, [items, finFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const visibleRows = showStyle === "plain" ? paged : filtered;

  const allChecked = visibleRows.length > 0 && visibleRows.every((it) => selected.includes(it.id));
  const toggleOne = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleAll = () => {
    if (allChecked) {
      setSelected((prev) => prev.filter((id) => !visibleRows.some((it) => it.id === id)));
    } else {
      setSelected((prev) => Array.from(new Set([...prev, ...visibleRows.map((it) => it.id)])));
    }
  };
  const selectedTotal = items
    .filter((it) => selected.includes(it.id) && !isPartialSettle(it) && it.amount > 0)
    .reduce((sum, it) => sum + it.amount, 0);

  const close = () => setOpen(null);
  const toggle = (key: Exclude<OpenForm, null>) => {
    // 从底部按钮打开时清掉上一次「调账 / 按选中金额结账」的预填值
    if (key === "charge") setChargePrefill("");
    if (key === "partial") setPartialPrefill("");
    setOpen((prev) => (prev === key ? null : key));
  };

  const renderRow = (it: CashierItem) => {
    const meta = ITEM_META[it.itemType] ?? { label: it.itemType, cls: "bg-gray-100 text-gray-600 border-gray-200" };
    const settleRow = isPartialSettle(it);
    const statusText = settleRow || settled ? "已结" : "未结";
  

  return (
      <tr key={it.id} className="hover:bg-[#fafcfb]">
        <td className={TD}>
          <input
            type="checkbox"
            checked={selected.includes(it.id)}
            onChange={() => toggleOne(it.id)}
            className="accent-[#5cb85c]"
            aria-label={`选择 ${it.description ?? ""}`}
          />
        </td>
        <td className={`${TD} max-w-[250px]`}>
          <div className="flex items-center gap-1.5">
            <span className={`inline-block shrink-0 rounded-[2px] border px-1 text-[11px] leading-4 ${meta.cls}`}>
              {meta.label}
            </span>
            <span className="truncate text-[#333]">{it.description ?? "-"}</span>
          </div>
        </td>
        <td className={TD_R}>{fmtMoney(it.amount)}</td>
        <td className={`${TD} text-right tabular-nums text-[#888]`}>
          {settleRow || settled ? fmtMoney(Math.abs(it.amount)) : "-"}
        </td>
        <td className={`${TD} text-right tabular-nums text-[#aaa]`}>-</td>
        <td className={`${TD} text-[#777]`}>{it.payMethod}</td>
        <td className={`${TD} tabular-nums text-[#777]`}>{stay.roomNo}</td>
        <td className={`${TD} text-[#777]`}>{stay.roomTypeName ?? "-"}</td>
        <td className={`${TD} tabular-nums text-[#777]`}>{it.bizDate ?? "-"}</td>
        <td className={TD}>
          <div className="text-[#777]">{it.operator}</div>
          <div className="text-[11px] leading-4 text-[#aaa]">{stamp(it.createdAt)}</div>
        </td>
        <td className={TD}>
          <StatusTag text={statusText} />
        </td>
        <td className={TD}>
          <button
            type="button"
            onClick={() => {
              setChargePrefill(`调账 · ${it.description ?? ""}`);
              setOpen("charge");
            }}
            disabled={settled}
            className="text-[12px] text-[#0e63d8] hover:underline disabled:cursor-not-allowed disabled:text-[#ccc]"
          >
            调账
          </button>
        </td>
      </tr>
    );
  };

  const summaryCards: { label: string; value: number; danger?: boolean }[] = [
    { label: "房费", value: totals.room },
    { label: "消费", value: totals.consume },
    { label: "应收金额", value: totals.receivable },
    { label: "实收金额", value: totals.received },
    { label: "余额", value: totals.balance, danger: totals.balance > 0.01 },
    { label: "预授权", value: totals.deposit },
    { label: "已开发票", value: totals.invoiced },
  ];

  const bottomActions: {
    key: Exclude<OpenForm, null> | "print";
    label: string;
    disabled?: boolean;
    title?: string;
  }[] = [
    { key: "checkout", label: "结账退房", disabled: settled || !isInhouse },
    { key: "partial", label: "部分结账", disabled: settled },
    { key: "receive", label: "收款", disabled: settled },
    { key: "charge", label: "入账", disabled: settled },
    { key: "deposit", label: "预收款", disabled: settled },
    { key: "transfer", label: "转账", disabled: settled || transferTargets.length === 0 },
    { key: "credit", label: "挂账", disabled: settled || companies.length === 0 },
    { key: "roomfee", label: "加收房费", disabled: settled },
    { key: "print", label: "打印账单" },
    { key: "refund", label: "退款", disabled: folio.paidAmount <= 0 },
    { key: "reverse", label: "撤销结账", disabled: !settled },
    {
      key: "reopen",
      label: "重新入住",
      disabled: isInhouse,
      title: "当前客人仍在住，无需重新入住",
    },
    { key: "housecharge", label: "客房收费", disabled: settled || !isInhouse },
    { key: "invoice", label: "开发票" },
  ];

  const infoFields: { label: string; value: React.ReactNode }[] = [
    { label: "预订人姓名", value: stay.guestName },
    { label: "预订人手机号码", value: stay.mobile ?? "-" },
    { label: "预订房型", value: stay.roomTypeName ?? "-" },
    { label: "预订房间数", value: "1 间" },
    { label: "预订房价", value: fmtMoney(stay.rate) },
    { label: "早餐数", value: `${stay.breakfast ?? 0} 份` },
    { label: "入离日期", value: `${dateOnly(stay.checkInTime)} ~ ${stay.expectCheckOut ?? "-"}` },
    { label: "入住天数", value: `${stay.nights ?? 0} 晚` },
    { label: "最晚到店时间", value: stay.arrivalTime ?? checkInLimit },
    { label: "最晚取消时间", value: stay.retainTime ?? "-" },
    { label: "收款类型", value: stay.payType ?? "到店付款" },
    { label: "开票金额", value: fmtMoney(totals.invoiced) },
    { label: "开票方", value: stay.invoiceParty ?? "酒店" },
    { label: "销售员", value: stay.salesman ?? "-" },
  ];

  // 顶部快捷操作（联房 / 换房 / 调价 / 续住 / 延迟退房 / 同住 / 入团）
  const quickActions: {
    key: Exclude<OpenForm, null>;
    label: string;
    disabled?: boolean;
    title?: string;
  }[] = [
    {
      key: "link",
      label: "联房",
      disabled: !isInhouse || inhouseStays.length === 0,
      title: !isInhouse ? "仅当前在住客人的账单可联房" : "没有其他在住房间可联房",
    },
    {
      key: "changeRoom",
      label: "换房",
      disabled: !isInhouse || vacantRooms.length === 0,
      title: !isInhouse ? "仅当前在住客人的账单可换房" : "当前没有可换的空房",
    },
    { key: "rate", label: "调价", disabled: !isInhouse, title: "仅当前在住客人的账单可调价" },
    { key: "extend", label: "续住", disabled: !isInhouse, title: "仅当前在住客人的账单可续住" },
    { key: "delay", label: "延迟退房", disabled: !isInhouse, title: "仅当前在住客人的账单可延迟退房" },
    { key: "companion", label: "同住", disabled: !isInhouse, title: "仅当前在住客人的账单可登记同住人" },
    { key: "team", label: "入团", disabled: !isInhouse, title: "仅当前在住客人的账单可入团" },
  ];

  return (
    <div className="space-y-3">
      {/* 去呼呼 280 项里的 7 个房态操作（op=xxx 时在顶部出面板） */}
      {initOp && OP_META[initOp] && (
        <div id="op-panel-7" className="rounded-[3px] border border-[#cfe8d4] bg-[#f3fbf5] px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-[#1f7a37]">{OP_META[initOp].title}</span>
            <a href={`/cashier?stay=${stay.stayId}`} className="text-[11.5px] text-[#999] hover:text-[#e53935]">
              关闭
            </a>
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#7a8b7f]">{OP_META[initOp].desc}</div>

          {initOp === "overnight" && (
            <div className="mt-1.5 text-[12px] text-[#555]">
              当前空房：<b className="text-[#2a9d3c]">{vacantRooms.length}</b> 间
              <span className="ml-2 text-[#888]">
                {vacantRooms.slice(0, 14).map((r) => r.roomNo).join(" / ")}
                {vacantRooms.length > 14 ? " …" : ""}
              </span>
            </div>
          )}

          {initOp === "negative" && (
            <div className="mt-1.5">
              {/*
                第 4 轮 P2-21：文案与实现不符
                原来写「金额填负数即为负值入账」，但服务端 addChargeAction
                校验的是 qty > 0 且 price >= 0 → 填负数直接被拒，文案是骗人的。
                负数入账（冲减）走「部分结账/红冲」，不是这个入口。
              */}
              <button
                type="button"
                onClick={() => setOpen("charge")}
                className="rounded-[2px] bg-[#32c141] px-3 py-1 text-[12px] text-white hover:bg-[#2bb038]"
              >
                打开入账表单（金额需为正数，冲减请用红冲）
              </button>
              <span className="ml-2 text-[11.5px] text-[#888]">
                当前应收 {fmtMoney(totals.receivable)}
              </span>
            </div>
          )}

          {initOp === "guest-pwd" && (
            <div className="mt-1.5 text-[12px] text-[#555]">
              客人密码：<b className="tabular-nums text-[#222]">{stay.mobile ? stay.mobile.slice(-6) : "未设置"}</b>
              <span className="ml-2 text-[11px] text-[#999]">（脱敏展示，完整密码需管家权限）</span>
            </div>
          )}

          {initOp === "make-card" && (
            <div className="mt-1.5 flex flex-wrap items-end gap-2">
              <div>
                <label className="label">门卡号</label>
                <input placeholder="刷卡或手输" className="input h-7 w-[160px] text-[12px]" />
              </div>
              <div>
                <label className="label">有效至</label>
                <input type="date" defaultValue={stay.expectCheckOut ?? ""} className="input h-7 w-[130px] text-[12px]" />
              </div>
              <button className="btn-primary h-7 px-3 text-[12px]">写卡</button>
            </div>
          )}

          {["cancel-approve", "exchange", "re-checkin"].includes(initOp) && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              <a
                href={`/cashier?stay=${stay.stayId}`}
                className="rounded-[2px] bg-[#32c141] px-3 py-1 text-[12px] text-white hover:bg-[#2bb038]"
              >
                确认执行
              </a>
              <a href="/cashier" className="rounded-[2px] border border-[#ddd] px-3 py-1 text-[12px] text-[#666]">
                返回
              </a>
            </div>
          )}
        </div>
      )}

      {/* 顶部订单信息条（去呼呼式两行紧凑字段） */}
      <div className="rounded border border-[#e5e5e5] bg-white px-3 pt-2.5">
        {/* 第一行：房号/状态 + 渠道徽标、订单号、团队、协议、会员 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] leading-5">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-[13px] font-semibold leading-none text-[#333]">{stay.roomNo}</span>
            <span
              className={`rounded-[2px] border px-1 text-[11px] leading-4 ${
                isInhouse
                  ? "border-[#b7e0c0] bg-[#f0f9f2] text-[#3f9d57]"
                  : "border-[#e5e5e5] bg-[#f7f7f7] text-[#999]"
              }`}
            >
              {isInhouse ? "在住" : "已退房"}
            </span>
            {settled && (
              <span className="rounded-[2px] border border-[#e5e5e5] bg-[#f7f7f7] px-1 text-[11px] leading-4 text-[#999]">
                已结账
              </span>
            )}
            {isCredit && (
              <span className="rounded-[2px] border border-[#f0d8b0] bg-[#fdf6ec] px-1 text-[11px] leading-4 text-[#c8811f]">
                已挂账
              </span>
            )}
            {invoiceCount > 0 && (
              <span className="rounded-[2px] border border-[#b7e0c0] bg-[#f0f9f2] px-1 text-[11px] leading-4 text-[#3f9d57]">
                已开票
              </span>
            )}
          </span>

          <span className="inline-flex items-center gap-1">
            <span className="text-[#999]">渠道来源：</span>
            <span
              className={`inline-block rounded-[2px] px-1.5 text-[11px] leading-[18px] font-medium ${
                stay.channelName && stay.channelName !== "散客"
                  ? "bg-[#0e63d8] text-white"
                  : "bg-[#f2f2f2] text-[#888]"
              }`}
            >
              {stay.channelName ?? "散客"}
            </span>
          </span>
          <Pair label="渠道订单号" value={stay.channelOrderNo ?? "-"} />
          <Pair label="团队名称" value={stay.teamName ?? "-"} />
          <Pair label="协议客户" value={stay.companyName ?? creditMark ?? "-"} />
          <Pair label="会员信息" value={[stay.memberType, stay.memberCard].filter(Boolean).join(" · ") || "-"} />

          <span className="ml-auto text-[11px] text-[#bbb]">
            账单号 {folio.folioNo} · 入住单 {stay.stayNo}
            {stay.actualCheckOut ? ` · 实际离店 ${stay.actualCheckOut}` : ""} · 创建 {stamp(stay.createdAt)}
          </span>
        </div>

        {/* 第二行：预订人 / 房型 / 间数 / 房价 / 早餐 / 入离 / 天数 / 收款类型 等 */}
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[#f2f2f2] pt-1.5">
          {infoFields.map((f) => (
            <Pair key={f.label} label={f.label} value={f.value} />
          ))}
        </div>

        {/* 房间备注 */}
        <div className="mt-1.5 flex items-start gap-1 border-t border-[#f2f2f2] pt-1.5 text-[12px] leading-5">
          <span className="shrink-0 text-[#999]">房间备注：</span>
          <span className="min-w-0 flex-1 truncate text-[#555]">{stay.remark || "—"}</span>
          <Link prefetch={false} href="/inhouse" className="shrink-0 text-[#0e63d8] hover:underline">
            修改
          </Link>
        </div>

        {/* 快捷操作按钮组：绿色主按钮 + 白底描边次按钮 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-[#f2f2f2] py-1.5">
          {quickActions.map((a) => {
            const active = open === a.key;
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => toggle(a.key)}
                disabled={a.disabled}
                title={a.disabled ? a.title : undefined}
                className={active ? BTN_GHOST_ON : BTN_GREEN}
              >
                {a.label}
                {active ? " ✕" : ""}
              </button>
            );
          })}
          <Link prefetch={false} href="/orders" className={BTN_GHOST}>
            查看渠道订单
          </Link>
        </div>

        {/* 快捷操作展开的小表单 */}
        {open === "link" && (
          <div className="mt-2">
            <FormPanel
              title="联房"
              hint={<>当前 {stay.roomNo} · {stay.guestName}</>}
              submitLabel={linkPending ? "联房中…" : "确认联房"}
              pending={linkPending}
              state={linkState}
              onSubmit={linkFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <Field label="关联房间 / 客人">
                <select name="target_stay_id" className="input" defaultValue="">
                  <option value="">请选择另一在住房间</option>
                  {inhouseStays.map((t) => (
                    <option key={t.stayId} value={t.stayId}>
                      {t.roomNo} · {t.guestName}（{t.stayNo}）
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：两间房关联为联房，联房账务可在同一账单内查看与合并结账。
              </p>
            </FormPanel>
          </div>
        )}

        {open === "changeRoom" && (
          <div className="mt-2">
            <FormPanel
              title="换房"
              hint={<>当前 {stay.roomNo}（{stay.roomTypeName ?? "-"}）</>}
              submitLabel={changeRoomPending ? "换房中…" : "确认换房"}
              pending={changeRoomPending}
              state={changeRoomState}
              onSubmit={changeRoomFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <Field label="目标房间">
                <select name="new_room_id" className="input" defaultValue="">
                  <option value="">请选择目标空房</option>
                  {vacantRooms.map((r) => (
                    <option key={r.roomId} value={r.roomId}>
                      {r.roomNo} · {r.roomTypeName ?? "-"} · {r.status === "VC" ? "空净" : "空脏"}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：入住单改到目标房间，原房间转为空脏（VD），目标房间转为在住（OC），账务随房间迁移。
              </p>
            </FormPanel>
          </div>
        )}

        {open === "rate" && (
          <div className="mt-2">
            <FormPanel
              title="调价"
              hint={<>当前房价 {fmtMoney(stay.rate)} / 晚</>}
              submitLabel={ratePending ? "调价中…" : "确认调价"}
              pending={ratePending}
              state={rateState}
              onSubmit={rateFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <Field label="新房价（元 / 晚）">
                <input
                  name="rate"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={stay.rate.toFixed(2)}
                  className="input"
                />
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：入住单房价更新为该价格，后续房费按新房价计。
              </p>
            </FormPanel>
          </div>
        )}

        {open === "extend" && (
          <div className="mt-2">
            <FormPanel
              title="续住"
              hint={<>当前 {stay.nights ?? 0} 晚 · 预计离店 {stay.expectCheckOut ?? "-"}</>}
              submitLabel={extendPending ? "续住中…" : "确认续住"}
              pending={extendPending}
              state={extendState}
              onSubmit={extendFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <Field label="续住晚数">
                <input name="nights" type="number" min="1" step="1" defaultValue="1" className="input" />
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：预计离店日期顺延相应晚数，离店日期与晚数同步更新。
              </p>
            </FormPanel>
          </div>
        )}

        {open === "delay" && (
          <div className="mt-2">
            <FormPanel
              title="延迟退房"
              hint={<>当前预计离店 {stay.expectCheckOut ?? "-"}</>}
              submitLabel={delayPending ? "处理中…" : "确认延迟退房"}
              pending={delayPending}
              state={delayState}
              onSubmit={delayFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <Field label="新的离店日期">
                <input
                  name="new_date"
                  type="date"
                  defaultValue={addDaysLocal(stay.expectCheckOut ?? todayLocal(), 1)}
                  className="input"
                />
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：预计离店日期更新为新日期，入住晚数按实际天数同步。
              </p>
            </FormPanel>
          </div>
        )}

        {open === "companion" && (
          <div className="mt-2">
            <FormPanel
              title="同住"
              hint={<>主住客 {stay.guestName}</>}
              submitLabel={companionPending ? "登记中…" : "确认添加同住人"}
              pending={companionPending}
              state={companionState}
              onSubmit={companionFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="同住人姓名">
                  <input name="guest_name" className="input" placeholder="必填" />
                </Field>
                <Field label="手机号码">
                  <input name="mobile" className="input" placeholder="选填" />
                </Field>
              </div>
              <Field label="证件号码">
                <input name="id_no" className="input" placeholder="选填" />
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：同住人写入本入住单，可在下方「同住人」列表查看。
              </p>
            </FormPanel>
          </div>
        )}

        {open === "team" && (
          <div className="mt-2">
            <FormPanel
              title="入团"
              hint={<>当前团队 {stay.teamName ?? "-"}</>}
              submitLabel={teamPending ? "入团中…" : "确认入团"}
              pending={teamPending}
              state={teamState}
              onSubmit={teamFormAction}
              onClose={close}
            >
              <input type="hidden" name="stay_id" value={stay.stayId} />
              <Field label="团队名称">
                <input
                  name="team_name"
                  className="input"
                  defaultValue={stay.teamName ?? ""}
                  placeholder="如：杭州云启会议团"
                />
              </Field>
              <p className="text-[11px] leading-relaxed text-gray-400">
                确认后：入住单归属该团队，团队账务可在团队账单中统一结算。
              </p>
            </FormPanel>
          </div>
        )}

        {/* Tab 切换（去呼呼样式：13px 加粗深灰 + 2px 绿线） */}
        <div className="mt-1 flex items-center gap-6 border-t border-[#f0f0f0]">
          <div className="flex items-center gap-6">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`-mb-px border-b-2 pb-2 pt-2 text-[13px] transition-colors ${
                    active
                      ? "border-[#5cb85c] font-bold text-[#333]"
                      : "border-transparent text-[#888] hover:text-[#333]"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="ml-auto flex items-center gap-3 pb-1 text-[11px] text-[#0e63d8]">
            <Link prefetch={false} href="/logs" className="hover:underline">
              操作日志
            </Link>
            <Link prefetch={false} href="/finance" className="hover:underline">
              财务应收
            </Link>
          </div>
        </div>
      </div>

      {/* Tab 内容 */}
      <div className="overflow-hidden rounded border border-[#e5e5e5] bg-white">
        {tab === "finance" && (
          <div className="space-y-2 p-3">
            {/* 财务类别 / 显示样式：小圆点 + 12px 文字 */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] leading-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[#999]">财务类别：</span>
                {FIN_FILTERS.map((f) => (
                  <label key={f.key} className="inline-flex cursor-pointer items-center gap-1 text-[#555]">
                    <input
                      type="radio"
                      name="fin_category"
                      checked={finFilter === f.key}
                      onChange={() => {
                        setFinFilter(f.key);
                        setPage(1);
                        setSelected([]);
                      }}
                      className="h-3 w-3 cursor-pointer appearance-none rounded-full border border-[#c0c0c0] bg-white checked:border-[#5cb85c] checked:bg-[#5cb85c] checked:shadow-[inset_0_0_0_2.5px_white]"
                    />
                    {f.label}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[#999]">显示样式：</span>
                <label className="inline-flex cursor-pointer items-center gap-1 text-[#555]">
                  <input
                    type="radio"
                    name="fin_style"
                    checked={showStyle === "plain"}
                    onChange={() => setShowStyle("plain")}
                    className="h-3 w-3 cursor-pointer appearance-none rounded-full border border-[#c0c0c0] bg-white checked:border-[#5cb85c] checked:bg-[#5cb85c] checked:shadow-[inset_0_0_0_2.5px_white]"
                  />
                  明显显示
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1 text-[#555]">
                  <input
                    type="radio"
                    name="fin_style"
                    checked={showStyle === "grouped"}
                    onChange={() => setShowStyle("grouped")}
                    className="h-3 w-3 cursor-pointer appearance-none rounded-full border border-[#c0c0c0] bg-white checked:border-[#5cb85c] checked:bg-[#5cb85c] checked:shadow-[inset_0_0_0_2.5px_white]"
                  />
                  分类显示
                </label>
              </div>
            </div>

            {/* 7 个汇总卡 + 全部：标签 11px 灰 + 数值 13px 紧凑卡 */}
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-8">
              <button
                type="button"
                onClick={() => {
                  setFinFilter("all");
                  setPage(1);
                }}
                className={`flex h-[42px] flex-col justify-center rounded border px-2 text-left transition-colors ${
                  finFilter === "all"
                    ? "border-[#5cb85c] bg-[#5cb85c]"
                    : "border-[#eee] bg-white hover:border-[#5cb85c]"
                }`}
              >
                <span className={`text-[11px] leading-4 ${finFilter === "all" ? "text-white/80" : "text-[#999]"}`}>
                  全部
                </span>
                <span
                  className={`text-[13px] leading-4 font-medium tabular-nums ${
                    finFilter === "all" ? "text-white" : "text-[#333]"
                  }`}
                >
                  {filtered.length} 条
                </span>
              </button>
              {summaryCards.map((c) => (
                <div key={c.label} className="flex h-[42px] flex-col justify-center rounded border border-[#eee] bg-white px-2">
                  <div className="text-[11px] leading-4 text-[#999]">{c.label}</div>
                  <div
                    className={`text-[13px] leading-4 font-medium tabular-nums ${
                      c.danger ? "text-[#d9534f]" : "text-[#333]"
                    }`}
                  >
                    {fmtMoney(c.value)}
                  </div>
                </div>
              ))}
            </div>

            {/* 明细表：淡绿表头 + 36px 行高 + 金额右对齐 */}
            <div className="overflow-x-auto rounded border border-[#eee]">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${TH} w-9`}>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={toggleAll}
                        className="accent-[#5cb85c]"
                        aria-label="全选当前页"
                      />
                    </th>
                    <th className={TH}>项目名称</th>
                    <th className={TH_R}>金额</th>
                    <th className={TH_R}>已结金额</th>
                    <th className={TH_R}>可用余额</th>
                    <th className={TH}>支付方式</th>
                    <th className={TH}>房号</th>
                    <th className={TH}>房型名称</th>
                    <th className={TH}>营业日</th>
                    <th className={TH}>操作人/时间</th>
                    <th className={TH}>状态</th>
                    <th className={TH}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 && (
                    <tr>
                      <td className={`${TD} text-center text-[#aaa]`} colSpan={12}>
                        暂无账务明细，可在下方「入账」中加收消费
                      </td>
                    </tr>
                  )}
                  {showStyle === "plain"
                    ? visibleRows.map(renderRow)
                    : GROUP_ORDER.map((g) => {
                        const rows = filtered.filter((it) => it.itemType === g.type);
                        if (rows.length === 0) return null;
                        const subtotal = rows.reduce((sum, it) => sum + it.amount, 0);
                        return (
                          <Fragment key={g.type}>
                            <tr className="bg-[#f7faf8]">
                              <td className={`${TD} text-[11px] font-medium text-[#666]`} colSpan={2}>
                                {g.label} 小计
                              </td>
                              <td className={`${TD} text-right text-[11px] font-medium tabular-nums text-[#555]`}>
                                {fmtMoney(subtotal)}
                              </td>
                              <td className={TD} colSpan={9} />
                            </tr>
                            {rows.map(renderRow)}
                          </Fragment>
                        );
                      })}
                </tbody>
              </table>
            </div>

            {selected.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded border border-[#dcefe1] bg-[#f7fcf9] px-2.5 py-1 text-[11px] text-[#666]">
                <span>
                  已选 <b className="text-[#3f9d57]">{selected.length}</b> 项 · 选中金额{" "}
                  <b className="tabular-nums text-[#333]">{fmtMoney(selectedTotal)}</b>
                </span>
                <button
                  type="button"
                  disabled={settled || selectedTotal <= 0}
                  onClick={() => {
                    setPartialPrefill(selectedTotal.toFixed(2));
                    setOpen("partial");
                  }}
                  className="text-[#3f9d57] hover:underline disabled:cursor-not-allowed disabled:text-[#ccc]"
                >
                  按选中金额部分结账
                </button>
                {/*
                  拆账（第 4 轮 P2-22a：原来点一下就执行，没有任何确认）
                  拆账会把选中的消费挪到新账单、按比例分走已收款 ——
                  分完两单的余额都变，客人对账时会问「为什么账单多了一张」。
                  用项目统一的 ConfirmForm 包一层，并说明影响。
                */}
                <ConfirmForm
                  action={async (fd: FormData) => {
                    await splitFolioAction(fd);
                  }}
                  message={`确认把选中的 ${selected.length} 项拆到新账单？`}
                  detail={`将拆出金额 ${fmtMoney(selectedTotal)} 到一张新账单（-B），已收款按比例分摊到两单。拆分后原单余额会变化。`}
                  confirmLabel="确认拆账"
                  cancelLabel="取消"
                  danger={false}
                >
                  <input type="hidden" name="folio_id" value={folio.id} />
                  {selected.map((id) => (
                    <input key={id} type="hidden" name="item_id" value={id} />
                  ))}
                  <button
                    type="button"
                    disabled={settled}
                    className="text-[#3f9d57] hover:underline disabled:cursor-not-allowed disabled:text-[#ccc]"
                  >
                    拆账
                  </button>
                </ConfirmForm>
                <button type="button" onClick={() => setSelected([])} className="text-[#999] hover:underline">
                  清空选择
                </button>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-[#f2f2f2] pt-1.5 text-[11px] text-[#999]">
              <span>
                共 {filtered.length} 条
                {totals.settle > 0 ? ` · 已部分结账 ${fmtMoney(totals.settle)}` : ""}
              </span>
              {showStyle === "plain" && filtered.length > PAGE_SIZE && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                    className="rounded border border-[#e5e5e5] px-1.5 text-[11px] leading-5 text-[#666] disabled:text-[#ccc]"
                  >
                    ‹
                  </button>
                  <span className="rounded border border-[#5cb85c] px-1.5 text-[11px] leading-5 text-[#4cae4c]">
                    {currentPage}
                  </span>
                  <span className="text-[#bbb]">/ {pageCount}</span>
                  <button
                    type="button"
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage(currentPage + 1)}
                    className="rounded border border-[#e5e5e5] px-1.5 text-[11px] leading-5 text-[#666] disabled:text-[#ccc]"
                  >
                    ›
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "detail" && (
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-[#333]">入住信息</div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-6">
                <InfoItem label="入住单号" value={stay.stayNo} />
                <InfoItem label="入住时间" value={stamp(stay.checkInTime)} />
                <InfoItem label="预计离店" value={stay.expectCheckOut ?? "-"} />
                <InfoItem label="实际离店" value={stay.actualCheckOut ?? "-"} />
                <InfoItem label="入住晚数" value={`${stay.nights ?? 0} 晚`} />
                <InfoItem label="入住人数" value={`${stay.guestCount ?? 1} 人`} />
                <InfoItem label="房价 / 晚" value={fmtMoney(stay.rate)} />
                <InfoItem label="押金" value={fmtMoney(stay.deposit)} />
                <InfoItem label="房价代码" value={stay.rateCode ?? "门市价"} />
                <InfoItem label="早餐" value={`${stay.breakfast ?? 0} 份`} />
                <InfoItem label="套餐" value={stay.packageCode ?? "-"} />
                <InfoItem label="来源预订" value={stay.bookingNo ?? "-"} />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-[#333]">客人信息</div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-6">
                <InfoItem label="客人姓名" value={stay.guestName} />
                <InfoItem label="手机号码" value={stay.mobile ?? "-"} />
                <InfoItem label="渠道" value={stay.channelName ?? "散客"} />
                <InfoItem label="团队名称" value={stay.teamName ?? "-"} />
                <InfoItem label="会员类型" value={stay.memberType ?? "-"} />
                <InfoItem label="会员卡号" value={stay.memberCard ?? "-"} />
                <InfoItem label="协议客户" value={stay.companyName ?? creditMark ?? "-"} />
                <InfoItem label="销售员" value={stay.salesman ?? "-"} />
                <InfoItem label="开票方" value={stay.invoiceParty ?? "酒店"} />
                <InfoItem label="收款类型" value={stay.payType ?? "到店付款"} />
                <InfoItem label="房间备注" value={stay.remark ?? "-"} />
                <InfoItem label="创建时间" value={stamp(stay.createdAt)} />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-[#333]">账务摘要</div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-6">
                <InfoItem label="账单号" value={folio.folioNo} />
                <InfoItem label="账单状态" value={settled ? "已结账" : "未结账"} />
                <InfoItem label="应收金额" value={fmtMoney(totals.receivable)} />
                <InfoItem label="实收金额" value={fmtMoney(totals.received)} />
                <InfoItem label="应收余额" value={fmtMoney(totals.balance)} />
                <InfoItem label="押金 / 预收款" value={fmtMoney(totals.deposit)} />
                <InfoItem label="结账时间" value={stamp(folio.settledAt)} />
                <InfoItem label="已开发票" value={fmtMoney(totals.invoiced)} />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-[#333]">收款记录</div>
              {payments.length === 0 ? (
                <div className="text-[12px] text-gray-400">暂无收款记录</div>
              ) : (
                <div className="space-y-1">
                  {payments.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-2 border-b border-gray-50 pb-1 text-[11px] text-gray-500"
                    >
                      <span className="truncate">
                        {p.bizDate ?? "-"} · {p.method ?? "-"}
                        {p.remark ? ` · ${p.remark}` : ""}
                        {p.payNo ? ` · ${p.payNo}` : ""}
                      </span>
                      <span className="shrink-0 tabular-nums text-emerald-700">{fmtMoney(p.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-[#333]">
                同住人
                <span className="text-[11px] font-normal text-gray-400">{companions.length} 人</span>
              </div>
              {companions.length === 0 ? (
                <div className="text-[12px] text-gray-400">暂无同住人，可点上方「同住」登记</div>
              ) : (
                <div className="space-y-1">
                  {companions.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-2 border-b border-gray-50 pb-1 text-[11px] text-gray-500"
                    >
                      <span className="truncate">
                        <b className="font-medium text-gray-700">{c.name}</b>
                        {c.relation ? ` · ${c.relation}` : ""}
                        {c.mobile ? ` · ${c.mobile}` : ""}
                        {c.idNo ? ` · ${c.idNo}` : ""}
                      </span>
                      <span className="shrink-0 tabular-nums text-gray-400">{stamp(c.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-[#333]">
                叫醒记录
                <span className="text-[11px] font-normal text-gray-400">{wakeUpCalls.length} 条</span>
              </div>
              {wakeUpCalls.length === 0 ? (
                <div className="text-[12px] text-gray-400">暂无叫醒记录</div>
              ) : (
                <div className="space-y-1">
                  {wakeUpCalls.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-center justify-between gap-2 border-b border-gray-50 pb-1 text-[11px] text-gray-500"
                    >
                      <span className="truncate">
                        <b className="font-medium text-gray-700">{w.wakeTime ?? "-"}</b>
                        {w.content ? ` · ${w.content}` : ""}
                      </span>
                      <span className="shrink-0 tabular-nums text-gray-400">{stamp(w.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "logs" && (
          <div className="p-3">
            {logs.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-[#aaa]">暂无账务操作日志</div>
            ) : (
              <div className="overflow-x-auto rounded border border-[#eee]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>时间</th>
                      <th className={TH}>操作</th>
                      <th className={TH}>操作人</th>
                      <th className={TH}>内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id} className="hover:bg-[#fafcfb]">
                        <td className={`${TD} tabular-nums text-[#888]`}>{stamp(log.createdAt)}</td>
                        <td className={TD}>
                          <span className="inline-block rounded-[2px] border border-[#eee] bg-[#fafafa] px-1 text-[11px] leading-4 text-[#666]">
                            {log.action}
                          </span>
                        </td>
                        <td className={`${TD} text-[#666]`}>{log.operator ?? "-"}</td>
                        <td className={`${TD} max-w-[520px] truncate text-[#555]`}>{log.detail ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 账务操作表单（点击底部按钮展开） */}
      {open === "checkout" && (
        <FormPanel
          title="结账退房"
          hint={
            <>
              合计 {fmtMoney(totals.receivable)} · 已收 {fmtMoney(totals.received)}
            </>
          }
          submitLabel={checkoutPending ? "退房处理中…" : "确认退房"}
          pending={checkoutPending}
          state={checkoutState}
          onSubmit={checkoutFormAction}
          onClose={close}
        >
          <input type="hidden" name="stay_id" value={stay.stayId} />
          <input type="hidden" name="room_id" value={stay.roomId} />
          <input type="hidden" name="folio_id" value={folio.id} />
          {/* 幂等键：双击「确认退房」不会多写一笔补收 / 押金退款（第十轮 P1） */}
          <input type="hidden" name="request_id" value={requestIds.checkout ?? ""} readOnly />
          {hasDebt ? (
            <>
              <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">
                当前仍有欠款 <b className="text-rose-600">{fmtMoney(totals.balance)}</b>，结账前请先补收。
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="补收金额">
                  <input
                    key={`checkout-${totals.balance}`}
                    name="pay_amount"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={totals.balance.toFixed(2)}
                    className="input"
                  />
                </Field>
                <Field label="支付方式">
                  <select name="pay_method" className="input" defaultValue="现金">
                    {PAY_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          ) : (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-700">
              账单已结清，可直接退房。
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-gray-400">
            确认后：账单标记为已结清，房间转为空脏房（VD），并自动生成客房打扫任务。
          </p>
        </FormPanel>
      )}

      {open === "partial" && (
        <FormPanel
          title="部分结账"
          hint={<>余额保留 · 应收 {fmtMoney(totals.balance)}</>}
          submitLabel={partialPending ? "结账中…" : "确认部分结账"}
          pending={partialPending}
          state={partialState}
          onSubmit={partialFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <input type="hidden" name="stay_id" value={stay.stayId} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="本次结账金额">
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                defaultValue={partialPrefill || (hasDebt ? totals.balance.toFixed(2) : "0.00")}
                className="input"
              />
            </Field>
            <Field label="支付方式">
              <select name="method" className="input" defaultValue="现金">
                {PAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="备注">
            <input name="remark" className="input" placeholder="如：先结房费，餐饮稍后结" />
          </Field>
          <p className="text-[11px] leading-relaxed text-gray-400">
            确认后：记一条收款流水与一条「部分结账」负项，未结余额继续留在账单上。
          </p>
        </FormPanel>
      )}

      {open === "charge" && (
        <FormPanel
          title="入账（自定义消费）"
          hint={<>当前应收 {fmtMoney(totals.receivable)}</>}
          submitLabel={chargePending ? "入账中…" : "确认入账"}
          pending={chargePending}
          state={chargeState}
          onSubmit={chargeFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          {/* 幂等键：双击「确认入账」只记一条消费明细（第十轮 P1） */}
          <input type="hidden" name="request_id" value={requestIds.charge ?? ""} readOnly />
          <div className="grid grid-cols-2 gap-2">
            <Field label="类型">
              <select name="item_type" className="input" defaultValue="OTHER">
                <option value="ROOM">房费</option>
                <option value="FOOD">餐饮</option>
                <option value="OTHER">其他</option>
              </select>
            </Field>
            <Field label="摘要">
              <input
                name="description"
                className="input"
                defaultValue={chargePrefill}
                placeholder="如：中餐厅晚餐"
              />
            </Field>
            <Field label="数量">
              <input name="qty" type="number" min="0.5" step="0.5" defaultValue="1" className="input" />
            </Field>
            <Field label="单价">
              <input name="price" type="number" min="0" step="0.01" defaultValue="0.00" className="input" />
            </Field>
            <Field label="营业日">
              <input name="biz_date" type="date" defaultValue={todayLocal()} className="input" />
            </Field>
          </div>
        </FormPanel>
      )}

      {open === "roomfee" && (
        <FormPanel
          title="加收房费"
          hint={<>按营业日入账</>}
          submitLabel={roomFeePending ? "入账中…" : "确认加收房费"}
          pending={roomFeePending}
          state={roomFeeState}
          onSubmit={roomFeeFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <input type="hidden" name="item_type" value="ROOM" />
          {/* 幂等键：房费与「其他消费」各持一枚（共用会把后一笔当重复提交丢掉） */}
          <input type="hidden" name="request_id" value={requestIds.roomfee ?? ""} readOnly />
          <div className="grid grid-cols-2 gap-2">
            <Field label="房费摘要">
              <input name="description" className="input" defaultValue="加收房费" />
            </Field>
            <Field label="营业日">
              <input name="biz_date" type="date" defaultValue={todayLocal()} className="input" />
            </Field>
            <Field label="数量（间夜）">
              <input name="qty" type="number" min="0.5" step="0.5" defaultValue="1" className="input" />
            </Field>
            <Field label="单价">
              <input name="price" type="number" min="0" step="0.01" defaultValue={stay.rate.toFixed(2)} className="input" />
            </Field>
          </div>
        </FormPanel>
      )}

      {open === "receive" && (
        <FormPanel
          title="收款"
          hint={<>当前余额 {fmtMoney(totals.balance)}</>}
          submitLabel={payPending ? "收款中…" : "确认收款"}
          pending={payPending}
          state={payState}
          onSubmit={payFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <input type="hidden" name="stay_id" value={stay.stayId} />
          {/* 幂等键：双击「确认收款」只收一笔 */}
          <input type="hidden" name="request_id" value={requestIds.receive ?? ""} readOnly />
          <div className="grid grid-cols-2 gap-2">
            <Field label="支付方式">
              <select name="method" className="input" defaultValue="现金">
                {PAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="收款金额">
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                defaultValue={hasDebt ? totals.balance.toFixed(2) : "0.00"}
                className="input"
              />
            </Field>
          </div>
          <Field label="备注">
            <input name="remark" className="input" placeholder="如：微信扫码收款" />
          </Field>
        </FormPanel>
      )}

      {open === "deposit" && (
        <FormPanel
          title="预收款（押金）"
          hint={<>单独收一笔押金</>}
          submitLabel={depositPending ? "收取中…" : "确认收取预收款"}
          pending={depositPending}
          state={depositState}
          onSubmit={depositFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <input type="hidden" name="stay_id" value={stay.stayId} />
          {/* 幂等键：双击「确认收取预收款」只记一笔押金（明细 + 流水两张表都写） */}
          <input type="hidden" name="request_id" value={requestIds.deposit ?? ""} readOnly />
          <div className="grid grid-cols-3 gap-2">
            <Field label="预收金额">
              <input name="amount" type="number" min="0" step="0.01" defaultValue="0.00" className="input" />
            </Field>
            <Field label="支付方式">
              <select name="method" className="input" defaultValue="现金">
                {PAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="营业日">
              <input name="biz_date" type="date" defaultValue={todayLocal()} className="input" />
            </Field>
          </div>
          <Field label="备注">
            <input name="remark" className="input" placeholder="如：续住补押金" />
          </Field>
          <p className="text-[11px] leading-relaxed text-gray-400">
            确认后：明细新增一条 DEPOSIT（押金），收款流水同步记录，已收金额与押金合计同步累加。
          </p>
        </FormPanel>
      )}

      {open === "transfer" && (
        <FormPanel
          title="转账（转至其他在住账单）"
          hint={<>当前余额 {fmtMoney(totals.balance)}</>}
          submitLabel={transferPending ? "转账中…" : "确认转账"}
          pending={transferPending}
          state={transferState}
          onSubmit={transferFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="转入房间 / 客人">
              <select name="target_folio_id" className="input" defaultValue="">
                <option value="">请选择转入账单</option>
                {transferTargets.map((t) => (
                  <option key={t.folioId} value={t.folioId}>
                    {t.roomNo} · {t.guestName}（余额 {fmtMoney(t.balance)}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="转账金额">
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                defaultValue={hasDebt ? totals.balance.toFixed(2) : "0.00"}
                className="input"
              />
            </Field>
          </div>
          <Field label="备注">
            <input name="remark" className="input" placeholder="如：房费转至团队主账" />
          </Field>
          <p className="text-[11px] leading-relaxed text-gray-400">
            确认后：当前账单记一条「转出」负项，目标账单记一条「转入」正项，双方余额同步变化。
          </p>
        </FormPanel>
      )}

      {open === "credit" && (
        <FormPanel
          title="挂账（转到协议单位）"
          hint={<>挂账金额 {fmtMoney(totals.balance)}</>}
          submitLabel={creditPending ? "挂账中…" : "确认挂账"}
          pending={creditPending}
          state={creditState}
          onSubmit={creditFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <input type="hidden" name="stay_id" value={stay.stayId} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="协议单位">
              <select name="company_id" className="input" defaultValue="">
                <option value="">请选择协议单位</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <div className="label">挂账金额</div>
              <div className="rounded border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] tabular-nums text-gray-800">
                {fmtMoney(totals.balance)}
              </div>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-400">
            确认后：入住单备注写入「【挂账】协议单位」标记并写操作日志，账单头部显示「已挂账」，余额保留待协议单位统一结算。
          </p>
        </FormPanel>
      )}

      {open === "refund" && (
        <FormPanel
          title="退款"
          hint={
            <>
              账单 {folio.folioNo} · 已收 <b className="tabular-nums">{fmtMoney(folio.paidAmount)}</b>
            </>
          }
          submitLabel={refundPending ? "退款中…" : "退款"}
          pending={refundPending}
          state={refundState}
          onSubmit={refundFormAction}
          confirmText={
            <>
              将从账单 <b>{folio.folioNo}</b> 退款，款项原路退回客人。
              退完后余额会重新计算，流水留痕。
            </>
          }
          onClose={close}
        >
          <div>
            <input type="hidden" name="folio_id" value={folio.id} />
            {/* 幂等键：双击「退款」只退一笔 */}
            <input type="hidden" name="request_id" value={requestIds.refund ?? ""} readOnly />
            <label className="label">原收款记录</label>
            <select name="payment_id" required className="input h-7 w-full text-[12px]">
              <option value="">请选择要退的收款</option>
              {payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.bizDate} · {p.method} · {fmtMoney(p.amount)} {p.remark ? `（${p.remark}）` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">退款金额</label>
            <input name="amount" type="number" min="0.01" step="0.01" required className="input h-7 w-full text-[12px]" />
          </div>
          <div>
            <label className="label">退款原因（必填）</label>
            <input name="reason" required placeholder="如：客人提前离店 / 多收" className="input h-7 w-full text-[12px]" />
          </div>
        </FormPanel>
      )}

      {open === "reverse" && (
        <FormPanel
          title="撤销结账"
          hint={<>账单 {folio.folioNo}</>}
          submitLabel={reversePending ? "撤销中…" : "确认撤销结账"}
          pending={reversePending}
          state={reverseState}
          onSubmit={reverseFormAction}
          onClose={close}
        >
          <input type="hidden" name="stay_id" value={stay.stayId} />
          <input type="hidden" name="folio_id" value={folio.id} />
          <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-700">
            撤销后：账单恢复「未结账」，入住单恢复「在住」，房间恢复在住净房（OC），清除实际离店日期并写房态日志。
          </div>
          <div>
            <label className="label">撤销原因（必填）</label>
            <input
              name="reason"
              required
              placeholder="如：客人临时续住 / 结账有误"
              className="input h-7 w-full text-[12px]"
            />
          </div>
        </FormPanel>
      )}

      {open === "invoice" && (
        <FormPanel
          title="开发票"
          hint={<>开票方 {stay.invoiceParty ?? "酒店"}</>}
          submitLabel={invoicePending ? "开票中…" : "确认开票"}
          pending={invoicePending}
          state={invoiceState}
          onSubmit={invoiceFormAction}
          onClose={close}
        >
          <input type="hidden" name="folio_id" value={folio.id} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="发票抬头">
              <input name="title" className="input" placeholder="如：杭州云启科技有限公司" defaultValue="" />
            </Field>
            <Field label="税号">
              <input name="tax_no" className="input" placeholder="如：91330100MA2XXXXXXX" defaultValue="" />
            </Field>
            <Field label="开票金额">
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                defaultValue={totals.received > 0 ? totals.received.toFixed(2) : "0.00"}
                className="input"
              />
            </Field>
            <Field label="备注">
              <input name="remark" className="input" placeholder="如：电子普票" defaultValue="" />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-400">
            开票记录写入操作日志，账单头部显示「已开票」标签。
          </p>
        </FormPanel>
      )}

      {open === "reopen" && (
        <FormPanel
          title="重新入住"
          hint={<>房间 {stay.roomNo} · 入住单 {stay.stayNo}</>}
          submitLabel={reopenPending ? "开房中…" : "确认重新入住"}
          pending={reopenPending}
          state={reopenState}
          onSubmit={reopenFormAction}
          onClose={close}
        >
          <input type="hidden" name="stay_id" value={stay.stayId} />
          <input type="hidden" name="folio_id" value={folio.id} />
          <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-700">
            该账单已退房结账。确认后：账单恢复「未结账」、入住单恢复「在住」、房间恢复在住净房（OC），
            并清除实际离店日期（继续收取的房费会累加到原账单）。
          </div>
        </FormPanel>
      )}

      {open === "housecharge" && (
        <FormPanel
          title="客房收费"
          hint={<>当前应收 {fmtMoney(totals.receivable)}</>}
          submitLabel={housePending ? "入账中…" : "确认收费"}
          pending={housePending}
          state={houseState}
          onSubmit={houseFormAction}
          onClose={close}
        >
          <input type="hidden" name="stay_id" value={stay.stayId} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="收费摘要">
              <input name="description" className="input" placeholder="如：客房迷你吧 / 洗衣费" />
            </Field>
            <Field label="金额">
              <input name="amount" type="number" min="0" step="0.01" defaultValue="0.00" className="input" />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-400">
            确认后：作为客房消费写入本账单「其他」明细并计入应收，可在财务明细中查看。
          </p>
        </FormPanel>
      )}

      {/* 底部整排账务操作（白底描边 / 30px 高 / 横向排列可换行） */}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-1 rounded border border-[#e5e5e5] bg-white px-2 py-1.5 shadow-[0_-2px_6px_rgba(0,0,0,0.04)]">
        {bottomActions.map((a) => {
          if (a.key === "print") {
            return (
              <Link
                prefetch={false}
                key="print"
                href={`/cashier/print?stay=${stay.stayId}`}
                target="_blank"
                rel="noreferrer"
                className={BTN_BOTTOM}
              >
                {a.label}
              </Link>
            );
          }
          const active = open === a.key;
          return (
            <button
              key={a.key}
              type="button"
              onClick={() => toggle(a.key as Exclude<OpenForm, null>)}
              disabled={a.disabled}
              title={a.disabled ? (a.title ?? "当前账单状态不支持该操作") : undefined}
              className={active ? BTN_BOTTOM_ON : BTN_BOTTOM}
            >
              {a.label}
              {active ? " ✕" : ""}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] text-[#999]">
          当前余额{" "}
          <b className={`tabular-nums ${hasDebt ? "text-[#d9534f]" : "text-[#333]"}`}>{fmtMoney(totals.balance)}</b>
        </span>
      </div>
    </div>
  );
}
