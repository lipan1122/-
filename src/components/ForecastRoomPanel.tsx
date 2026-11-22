"use client";

/**
 * 远期房态 · 订单操作面板
 *
 * 对照去呼呼「远期房态」截图（.repro/video/f14.png）：点房间色块后
 * 从右侧滑出一块 560px 宽的面板，内容依次是
 *   1. 标题行（房号 + 房型名 + 关闭 ✕）
 *   2. 四行操作按钮（12px 小按钮，预收款(押金) / 换单续住 / 结账退房为实心绿）
 *   3. 在住信息九宫格（入住 / 离店 / 房价 / 消费 / 收款 / 余额 / 开票方 …）+ 备注长文本
 *   4. 主联房 / 其他联房 + 「更多联房信息」「更多入住及开票记录」
 *
 * 板内所有写操作都复用 src/app/(main)/rooms/actions.ts 里已有的 server action，
 * 没有新增 SQL；跳转型操作（账单、打印、在住单）用 Link 直达既有页面。
 *
 * 组件分三块：
 *   - ForecastRoomPanel（默认导出）：Provider，持有「当前选中的在住单」和提示条，
 *     把页面上已渲染好的甘特表当作 children 收进来，面板本身用 Portal 挂到 body。
 *   - ForecastStayBlock：色块按钮，通过 context 通知 Provider 打开对应入住单。
 *   - StayDrawer / InfoGrid / 小表单：面板内部实现。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, useFormStatus } from "react-dom";
import { fmtMoney, ROOM_STATUS } from "@/lib/utils";
import {
  addCompanionAction,
  addDepositAction,
  addOtherChargeAction,
  addRoomFeeAction,
  adjustRateAction,
  cancelCheckinAction,
  changeStayRoomAction,
  extendStayAction,
  joinTeamAction,
  linkRoomsAction,
  memberRechargeAction,
  registerMemberAction,
  sendSmsAction,
  setRoomStatusAction,
  setWakeUpAction,
  toHourlyAction,
  updateCheckoutAction,
} from "@/app/(main)/rooms/actions";

/* ============================================================ 对外类型 */

/** 一间在住房在面板里要展示的全部数据（由 page.tsx 服务端查好后传入） */
export type ForecastStayInfo = {
  stayId: number;
  roomId: number;
  roomNo: string;
  roomTypeName: string;
  /** rooms.status：VC / VD / OC / OD …，用于「置净」提示 */
  roomStatus: string;
  guestName: string;
  channelName: string;
  /** 入住时间（已格式化为 YYYY-MM-DD HH:MM） */
  checkInText: string;
  /** 预计离店日期（YYYY-MM-DD） */
  checkOutText: string;
  rate: number;
  /** 消费金额（folios.total_amount 合计） */
  consume: number;
  /** 收款金额（folio paid_amount 合计） */
  paid: number;
  /** 余款（folio balance 合计） */
  balance: number;
  deposit: number;
  breakfast: number;
  /** 房卡数量：按入住人数发卡 */
  cardCount: number;
  invoiceParty: string;
  guestPassword: string;
  /** 物品租赁摘要：如「吹风机×1、转换插头×2」，无记录时为「无」 */
  itemRental: string;
  remark: string;
  /** 主联房：联房组内共几间（无联房时为 1） */
  linkRooms: number;
  /** 其他联房房号，逗号分隔；无联房时为空串 */
  otherLinkRooms: string;
};

/** 换房 / 联房下拉选项 */
export type ForecastOption = { id: number; label: string };

/* ============================================================ 常量 */

const PANEL_W = 560;

const PAY_METHODS = ["现金", "微信", "支付宝", "银行卡", "挂账"];

const FIELD_CLS =
  "h-[28px] w-full rounded-[2px] border border-[#d7e3da] bg-white px-2 text-[12px] text-[#3f4a54] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]";

const HINT_CLS = "text-[11px] leading-[16px] text-[#8b98a1]";

/* 12px 小按钮：内边距压到 4px，保证「第一行 9 个 / 第二行 9 个」在 560px 面板里不换行
 * （去呼呼截图里的按钮同样是几乎没有横向留白的紧凑样式） */
const BTN_BASE = "flex h-[26px] shrink-0 cursor-pointer items-center rounded-[3px] px-1 text-[12px] transition-colors";
const BTN_NORMAL = `${BTN_BASE} bg-[#f5f6f7] text-[#4aa96a] hover:bg-[#eaf7ee] hover:text-[#2fa84f]`;
const BTN_ACTIVE = `${BTN_BASE} bg-[#e0f5e8] font-medium text-[#2fa84f]`;
const BTN_SOLID = `${BTN_BASE} bg-[#32c141] text-white hover:bg-[#2cb03b]`;
/** 面板底部两个按钮文字更长，留白放大一点 */
const BTN_WIDE = "flex h-[26px] shrink-0 cursor-pointer items-center whitespace-nowrap rounded-[3px] px-2.5 text-[12px] transition-colors";
const BTN_WIDE_LIGHT = `${BTN_WIDE} bg-[#f5f6f7] text-[#4aa96a] hover:bg-[#eaf7ee] hover:text-[#2fa84f]`;
const BTN_WIDE_SOLID = `${BTN_WIDE} bg-[#32c141] text-white hover:bg-[#2cb03b]`;

/** 面板内展开的小表单 */
type FormKey =
  | "deposit"
  | "companion"
  | "extend"
  | "renewSheet"
  | "checkout"
  | "changeRoom"
  | "link"
  | "team"
  | "cancel"
  | "hourly"
  | "roomFee"
  | "otherCharge"
  | "rate"
  | "wakeUp"
  | "sms"
  | "recharge"
  | "register"
  | "setVC";

const FORM_TITLES: Record<FormKey, string> = {
  deposit: "预收款（押金）",
  companion: "同住登记",
  extend: "续住",
  renewSheet: "换单续住",
  checkout: "修改退房时间",
  changeRoom: "换房",
  link: "联房",
  team: "入团",
  cancel: "取消入住",
  hourly: "转钟点房",
  roomFee: "加收房费",
  otherCharge: "客房消费",
  rate: "调价",
  wakeUp: "叫醒",
  sms: "发短信",
  recharge: "会员充值",
  register: "会员注册",
  setVC: "置净",
};

/** server action 统一签名 */
type ActionFn = (formData: FormData) => Promise<unknown>;

/** 操作按钮：要么是跳转（href），要么展开小表单（form） */
type OpEntry = {
  label: string;
  href?: string;
  external?: boolean;
  form?: FormKey;
  solid?: boolean;
};

/* ============================================================ Context */

type PanelCtx = { open: (stayId: number) => void };

const ForecastPanelContext = createContext<PanelCtx | null>(null);

/* ============================================================ 色块按钮 */

/**
 * 在住色块：原来是 <Link>，现在改成 <button>，
 * 点击后通知外层 Provider 打开该入住单的订单操作面板。
 */
export function ForecastStayBlock({
  stayId,
  name,
  channel,
  owed,
  height,
  bg,
  fg,
}: {
  stayId: number;
  name: string;
  channel: string;
  owed: boolean;
  /** 色块高度（与空房格同高，由 page.tsx 的 BLOCK_H 传入） */
  height: number;
  bg: string;
  fg: string;
}) {
  const ctx = useContext(ForecastPanelContext);

  return (
    <button
      type="button"
      onClick={() => ctx?.open(stayId)}
      title={`打开 ${name} 的订单操作面板`}
      aria-haspopup="dialog"
      className="flex w-full cursor-pointer flex-col justify-center gap-[4px] px-3 text-left transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      style={{ height, background: bg, color: fg }}
    >
      <span className="truncate text-[14px] leading-[20px] font-medium">{name}</span>
      <span className="flex items-center gap-1 text-[14px] leading-[20px]">
        <span className="truncate opacity-90">{channel}</span>
        {owed && (
          <span className="shrink-0 rounded-[2px] bg-[#f5222d] px-[3px] text-[11px] leading-[15px] text-white">欠</span>
        )}
      </span>
    </button>
  );
}

/* ============================================================ Provider */

export default function ForecastRoomPanel({
  stays,
  vacantRooms,
  linkTargets,
  children,
}: {
  /** 当前视图里所有在住单的面板数据 */
  stays: ForecastStayInfo[];
  /** 可换入的空房（VC / VD） */
  vacantRooms: ForecastOption[];
  /** 可联房的其他在住单 */
  linkTargets: ForecastOption[];
  /** 页面上已渲染好的甘特表（RSC 结果，原样包进来即可） */
  children: ReactNode;
}) {
  const router = useRouter();
  const [openStayId, setOpenStayId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const open = useCallback((stayId: number) => setOpenStayId(stayId), []);
  const close = useCallback(() => setOpenStayId(null), []);

  const ctxValue = useMemo<PanelCtx>(() => ({ open }), [open]);

  /** 打开中的入住单；数据在一次 refresh 后可能已经不存在了，所以做空值保护 */
  const current = openStayId === null ? null : stays.find((s) => s.stayId === openStayId) ?? null;

  /** 表单提交成功：关面板 + 顶部提示 + 刷新服务端数据 */
  const handleSettled = useCallback(
    (message: string) => {
      setOpenStayId(null);
      showToast(message);
      router.refresh();
    },
    [router, showToast]
  );

  return (
    <ForecastPanelContext.Provider value={ctxValue}>
      {children}

      {current ? (
        <StayDrawer
          key={current.stayId}
          stay={current}
          vacantRooms={vacantRooms}
          linkTargets={linkTargets}
          onClose={close}
          onSettled={handleSettled}
          onNotice={showToast}
        />
      ) : null}

      {/* 全局提示：操作成功 / 预留入口的说明 */}
      {toast
        ? createPortal(
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none fixed left-1/2 top-24 z-[220] max-w-[80vw] -translate-x-1/2 rounded bg-black/80 px-3.5 py-2 text-[12px] text-white shadow-lg"
            >
              {toast}
            </div>,
            document.body
          )
        : null}
    </ForecastPanelContext.Provider>
  );
}

/* ============================================================ 抽屉面板 */

function StayDrawer({
  stay,
  vacantRooms,
  linkTargets,
  onClose,
  onSettled,
  onNotice,
}: {
  stay: ForecastStayInfo;
  vacantRooms: ForecastOption[];
  linkTargets: ForecastOption[];
  onClose: () => void;
  onSettled: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [entered, setEntered] = useState(false);
  const [openForm, setOpenForm] = useState<FormKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /* 滑入动画：挂载后下一帧切到 translate-x-0 */
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  /* 打开时锁滚动 + Esc 关闭 */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /** 统一包一层 server action：补 stay_id、收 { ok } / { error }、成功后关面板刷新 */
  const submitWith = (action: ActionFn, doneText: string) => async (formData: FormData) => {
    formData.set("stay_id", String(stay.stayId));
    setFormError(null);
    try {
      const result = (await action(formData)) as { error?: string; ok?: string } | void | undefined;
      const error = result && typeof result === "object" ? result.error : undefined;
      const ok = result && typeof result === "object" ? result.ok : undefined;
      if (error) {
        setFormError(error);
        return;
      }
      onSettled(ok ?? doneText);
    } catch {
      setFormError("操作失败，请稍后重试");
    }
  };

  const toggleForm = (key: FormKey) => {
    setFormError(null);
    setOpenForm((prev) => (prev === key ? null : key));
  };

  const cashierHref = `/cashier?stay=${stay.stayId}`;
  const printHref = `/cashier/print?stay=${stay.stayId}`;

  /* 四行按钮，顺序与去呼呼截图一致 */
  const rows: OpEntry[][] = [
    [
      { label: "订单详情", href: "/inhouse" },
      { label: "财务明细", href: cashierHref },
      { label: "预收款(押金)", form: "deposit", solid: true },
      { label: "同住", form: "companion" },
      { label: "续住", form: "extend" },
      { label: "修改退房时间", form: "checkout" },
      { label: "换房", form: "changeRoom" },
      { label: "联房", form: "link" },
      { label: "入团", form: "team" },
    ],
    [
      { label: "取消入住", form: "cancel" },
      { label: "转钟点房", form: "hourly" },
      { label: "加收房费", form: "roomFee" },
      { label: "客房消费", form: "otherCharge" },
      { label: "调价", form: "rate" },
      { label: "挂账", href: cashierHref },
      { label: "转账", href: cashierHref },
      { label: "部分结账", href: cashierHref },
      { label: "撤销结账", href: cashierHref },
    ],
    [
      { label: "叫醒", form: "wakeUp" },
      { label: "发短信", form: "sms" },
      { label: "打印入住登记单", href: printHref, external: true },
      { label: "打印账单", href: printHref, external: true },
      { label: "会员充值", form: "recharge" },
      { label: "会员注册", form: "register" },
      { label: "置净", form: "setVC" },
      { label: "结账退房", href: cashierHref, solid: true },
    ],
    [
      { label: "换单续住", form: "renewSheet", solid: true },
      { label: "开发票", href: cashierHref },
    ],
  ];

  /* ------------------------------------------------------ 小表单零件 */

  const footer = (label: string, danger?: boolean) => (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      <SubmitBtn label={label} danger={danger} />
      <button
        type="button"
        onClick={() => {
          setOpenForm(null);
          setFormError(null);
        }}
        className="h-[28px] cursor-pointer rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
      >
        取消
      </button>
      {formError && <span className="text-[11px] text-[#e23b3b]">{formError}</span>}
    </div>
  );

  const renderForm = (key: FormKey): ReactNode => {
    switch (key) {
      case "deposit":
        return (
          <form action={submitWith(addDepositAction, "已收取预收款")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="金额（元）">
                <input name="amount" type="number" min="0.01" step="0.01" defaultValue="500.00" required className={FIELD_CLS} />
              </Field>
              <Field label="收款方式">
                <select name="method" defaultValue="现金" className={FIELD_CLS}>
                  {PAY_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className={HINT_CLS}>收取后计入账单预收款，并累加入住单押金。</p>
            {footer("确认收取预收款")}
          </form>
        );

      case "companion":
        return (
          <form action={submitWith(addCompanionAction, "已登记同住人")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="同住人姓名">
                <input name="name" required maxLength={40} placeholder="如：李四" className={FIELD_CLS} />
              </Field>
              <Field label="手机号">
                <input name="mobile" maxLength={20} placeholder="选填" className={FIELD_CLS} />
              </Field>
            </div>
            <Field label="证件号">
              <input name="id_no" maxLength={40} placeholder="选填" className={FIELD_CLS} />
            </Field>
            {footer("登记同住人")}
          </form>
        );

      case "extend":
        return (
          <form action={submitWith(extendStayAction, "已办理续住")} className="space-y-2">
            <Field label="续住晚数">
              <input name="nights" type="number" min="1" max="30" step="1" defaultValue="1" required className={FIELD_CLS} />
            </Field>
            <p className={HINT_CLS}>
              当前预计离店 {stay.checkOutText || "未定"}，续住后顺延并按营业日逐条补入房费。
            </p>
            {footer("确认续住")}
          </form>
        );

      case "renewSheet":
        return (
          <form action={submitWith(extendStayAction, "已办理续住")} className="space-y-2">
            <Field label="续住晚数">
              <input name="nights" type="number" min="1" max="30" step="1" defaultValue="1" required className={FIELD_CLS} />
            </Field>
            <p className={HINT_CLS}>
              换单续住：沿用原入住单继续占用 {stay.roomNo} 房，续住晚数写入原单并补记房费。
            </p>
            {footer("确认换单续住")}
          </form>
        );

      case "checkout":
        return (
          <form action={submitWith(updateCheckoutAction, "已修改预计离店")} className="space-y-2">
            <Field label="新的预计离店日期">
              <input
                name="expect_check_out"
                type="date"
                required
                defaultValue={stay.checkOutText || ""}
                className={FIELD_CLS}
              />
            </Field>
            <p className={HINT_CLS}>晚数按新日期重算，多出的晚数按当前房价补入房费明细。</p>
            {footer("保存离店日期")}
          </form>
        );

      case "changeRoom":
        return vacantRooms.length === 0 ? (
          <p className={HINT_CLS}>当前没有空净 / 空脏房可换。</p>
        ) : (
          <form action={submitWith(changeStayRoomAction, "已完成换房")} className="space-y-2">
            <Field label="换入房间（空净 / 空脏）">
              <select name="new_room_id" required defaultValue="" className={FIELD_CLS}>
                <option value="" disabled>
                  请选择空房
                </option>
                {vacantRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <p className={HINT_CLS}>换房后原房转空脏、新房转在住净，账单房号与房态日志同步更新。</p>
            {footer("确认换房")}
          </form>
        );

      case "link":
        return linkTargets.length === 0 ? (
          <p className={HINT_CLS}>当前没有其他在住房间可联房。</p>
        ) : (
          <form action={submitWith(linkRoomsAction, "已完成联房")} className="space-y-2">
            <Field label="联房目标（其他在住房间）">
              <select name="target_stay_id" required defaultValue="" className={FIELD_CLS}>
                <option value="" disabled>
                  请选择在住房间
                </option>
                {linkTargets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            {footer("建立联房关系")}
          </form>
        );

      case "team":
        return (
          <form action={submitWith(joinTeamAction, "已加入团队")} className="space-y-2">
            <Field label="团队名称">
              <input name="team_name" required maxLength={60} placeholder="如：云启科技考察团" className={FIELD_CLS} />
            </Field>
            {footer("加入团队")}
          </form>
        );

      case "cancel":
        return (
          <form action={submitWith(cancelCheckinAction, "已取消入住")} className="space-y-2">
            <p className="rounded-[2px] border border-[#f5d9a8] bg-[#fdf8ec] px-2 py-1.5 text-[11px] leading-[16px] text-[#a97b22]">
              将删除该入住单及对应账单、账务明细与收款流水，房间置为空净房；账单仍有欠款时会被拒绝。
            </p>
            {footer("确认取消入住", true)}
          </form>
        );

      case "hourly":
        return (
          <form action={submitWith(toHourlyAction, "已转为钟点房")} className="space-y-2">
            <Field label="钟点时长（小时）">
              <input name="hours" type="number" min="1" max="24" step="1" defaultValue="4" required className={FIELD_CLS} />
            </Field>
            <p className={HINT_CLS}>房价 = 房型门市价 × 15% × 小时数，晚数置 0，备注追加「钟点房 N 小时」。</p>
            {footer("转为钟点房", true)}
          </form>
        );

      case "roomFee":
        return (
          <form action={submitWith(addRoomFeeAction, "已加收房费")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="加收金额（元）">
                <input name="amount" type="number" min="0.01" step="0.01" defaultValue="0.00" required className={FIELD_CLS} />
              </Field>
              <Field label="营业日">
                <input name="biz_date" type="date" className={FIELD_CLS} />
              </Field>
            </div>
            <Field label="备注">
              <input name="remark" maxLength={60} placeholder="选填，如：加床" className={FIELD_CLS} />
            </Field>
            {footer("确认加收房费")}
          </form>
        );

      case "otherCharge":
        return (
          <form action={submitWith(addOtherChargeAction, "已入账客房消费")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="消费项目">
                <input name="description" maxLength={40} defaultValue="迷你吧" className={FIELD_CLS} />
              </Field>
              <Field label="金额（元）">
                <input name="amount" type="number" min="0.01" step="0.01" defaultValue="0.00" required className={FIELD_CLS} />
              </Field>
            </div>
            <p className={HINT_CLS}>按今天营业日插入一条「其他消费」明细并重算账单。</p>
            {footer("确认入账")}
          </form>
        );

      case "rate":
        return (
          <form action={submitWith(adjustRateAction, "已调整房价")} className="space-y-2">
            <Field label="新房价（元 / 晚）">
              <input name="rate" type="number" min="0.01" step="0.01" defaultValue={stay.rate} required className={FIELD_CLS} />
            </Field>
            <p className={HINT_CLS}>当前房价 {fmtMoney(stay.rate)} / 晚，调价会写入「敏感操作」日志。</p>
            {footer("确认调价")}
          </form>
        );

      case "wakeUp":
        return (
          <form action={submitWith(setWakeUpAction, "已登记叫醒")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="叫醒时间">
                <input name="wake_time" type="time" required className={FIELD_CLS} />
              </Field>
              <Field label="备注">
                <input name="note" maxLength={40} placeholder="选填" className={FIELD_CLS} />
              </Field>
            </div>
            <p className={HINT_CLS}>只填时间按今天计算，也可写入完整日期时间。</p>
            {footer("登记叫醒")}
          </form>
        );

      case "sms":
        return (
          <form action={submitWith(sendSmsAction, "短信已记录发送")} className="space-y-2">
            <Field label="短信内容">
              <textarea
                name="content"
                required
                rows={3}
                maxLength={200}
                defaultValue={`尊敬的${stay.guestName}，您的房间 ${stay.roomNo} 预计 ${stay.checkOutText} 离店，如需延住请与前台联系。`}
                className="w-full rounded-[2px] border border-[#d7e3da] bg-white px-2 py-1.5 text-[12px] leading-[18px] text-[#3f4a54] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]"
              />
            </Field>
            <p className={HINT_CLS}>发送至入住单登记的手机号，未登记手机号会被拒绝。</p>
            {footer("发送短信")}
          </form>
        );

      case "recharge":
        return (
          <form action={submitWith(memberRechargeAction, "已充值")} className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <Field label="会员姓名">
                <input name="guest_name" defaultValue={stay.guestName} required maxLength={40} className={FIELD_CLS} />
              </Field>
              <Field label="金额（元）">
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  max="50000"
                  step="0.01"
                  defaultValue="1000.00"
                  required
                  className={FIELD_CLS}
                />
              </Field>
              <Field label="方式">
                <select name="method" defaultValue="现金" className={FIELD_CLS}>
                  {PAY_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {/*
              第 4 轮 P2-22b：充值原因必填
              充值是往客人账上加钱，误操作/内部舞弊的后果是实打实的资金损失，
              原因会写进 op_logs 和储值流水备注，事后能查。
            */}
            <Field label="充值原因（必填，记入操作日志）">
              <input
                name="reason"
                required
                maxLength={80}
                defaultValue="会员卡充值"
                placeholder="如：会员卡充值 / 活动充值 / 团购卡"
                className={FIELD_CLS}
              />
            </Field>
            {footer("确认充值")}
          </form>
        );

      case "register":
        return (
          <form action={submitWith(registerMemberAction, "已注册会员")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="会员姓名">
                <input name="guest_name" defaultValue={stay.guestName} required maxLength={40} className={FIELD_CLS} />
              </Field>
              <Field label="手机号">
                <input name="mobile" maxLength={20} placeholder="选填" className={FIELD_CLS} />
              </Field>
            </div>
            <p className={HINT_CLS}>客史不存在时先建客史，再把会员等级置为 VIP 1。</p>
            {footer("注册会员")}
          </form>
        );

      case "setVC":
        return (
          <form action={submitWith(setRoomStatusAction, `已将 ${stay.roomNo} 置净（VC）`)} className="space-y-2">
            <input type="hidden" name="roomId" value={stay.roomId} />
            <input type="hidden" name="status" value="VC" />
            <p className={HINT_CLS}>
              当前房态 {ROOM_STATUS[stay.roomStatus]?.label ?? stay.roomStatus}。置净会把房间改为空净（VC）并写入房态变更日志。
            </p>
            {stay.roomStatus === "OC" || stay.roomStatus === "OD" ? (
              <p className="rounded-[2px] border border-[#f5d9a8] bg-[#fdf8ec] px-2 py-1.5 text-[11px] leading-[16px] text-[#a97b22]">
                在住房间（OC / OD）不允许直接改房态，需先在收银台结账退房；此处提交不会改变房态。
              </p>
            ) : null}
            {footer("确认置净")}
          </form>
        );

      default:
        return null;
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={`${stay.roomNo} 订单操作`}>
      {/* 遮罩 */}
      <button
        type="button"
        aria-label="关闭订单操作面板"
        onClick={onClose}
        className={`absolute inset-0 cursor-default bg-black/30 transition-opacity duration-200 ${
          entered ? "opacity-100" : "opacity-0"
        }`}
      />

      <aside
        className={`absolute right-0 top-0 flex h-full flex-col bg-white shadow-2xl transition-transform duration-200 ease-out ${
          entered ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ width: PANEL_W, maxWidth: "96vw" }}
      >
        {/* ---------- 1. 标题行：房号 + 房型名 + ✕ ---------- */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#eeeeee] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-4 w-[3px] shrink-0 rounded-[1px] bg-[#54c574]" aria-hidden="true" />
            <h2 className="min-w-0 truncate text-[14px] leading-[20px] text-[#333]">
              <b className="font-bold tabular-nums">{stay.roomNo}</b>
              <span className="ml-1.5 font-normal text-[#4a4a4a]">{stay.roomTypeName}</span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 cursor-pointer rounded-[2px] p-1 text-[16px] leading-none text-[#b3bcc5] hover:bg-[#f4f6f5] hover:text-[#3f4a54]"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {/* ---------- 2. 四行操作按钮 ---------- */}
          <div className="flex flex-col gap-1.5">
            {rows.map((row, ri) => (
              <div key={ri} className="flex flex-wrap gap-1">
                {row.map((op) => {
                  const active = op.form !== undefined && openForm === op.form;
                  const cls = op.solid ? BTN_SOLID : active ? BTN_ACTIVE : BTN_NORMAL;
                  if (op.href) {
                    return (
                      <Link
                prefetch={false}
                        key={op.label}
                        href={op.href}
                        target={op.external ? "_blank" : undefined}
                        rel={op.external ? "noreferrer" : undefined}
                        className={cls}
                      >
                        {op.label}
                      </Link>
                    );
                  }
                  return (
                    <button
                      key={op.label}
                      type="button"
                      aria-expanded={active}
                      onClick={() => op.form && toggleForm(op.form)}
                      className={cls}
                    >
                      {op.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 小表单：折叠在按钮组下方，与截图保持一致（默认收起） */}
          {openForm ? (
            <section className="mt-2.5 rounded-[3px] border border-[#cfe9d7] bg-[#f4fbf6] px-2.5 py-2">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-[12px] font-semibold text-[#3f4a54]">{FORM_TITLES[openForm]}</h3>
                <button
                  type="button"
                  onClick={() => {
                    setOpenForm(null);
                    setFormError(null);
                  }}
                  className="cursor-pointer text-[11px] text-[#8b98a1] hover:text-[#5f6b76]"
                >
                  收起
                </button>
              </div>
              {renderForm(openForm)}
            </section>
          ) : null}

          {/* ---------- 3. 在住信息 + 备注 ---------- */}
          <div className="mt-3">
            <InfoGrid stay={stay} />
          </div>

          {/* ---------- 4. 联房信息 + 底部两个按钮 ---------- */}
          <div className="mt-2.5 space-y-0.5 text-[12px] leading-[18px]">
            <div className="flex gap-1">
              <span className="w-[62px] shrink-0 text-[#7f8a93]">主联房：</span>
              <span className="min-w-0 text-[#333]">共 {stay.linkRooms} 间</span>
            </div>
            <div className="flex gap-1">
              <span className="w-[62px] shrink-0 text-[#7f8a93]">其他联房：</span>
              <span className="min-w-0 break-words text-[#333] tabular-nums">{stay.otherLinkRooms || "无"}</span>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap justify-end gap-1.5 pb-1">
            <button
              type="button"
              onClick={() =>
                onNotice(
                  stay.linkRooms > 1
                    ? `联房组共 ${stay.linkRooms} 间：${stay.otherLinkRooms || "—"}（组号明细在「在住单 - 联房」查看）`
                    : `${stay.roomNo} 当前没有联房记录`
                )
              }
              className={BTN_WIDE_LIGHT}
            >
              更多联房信息
            </button>
            <Link prefetch={false} href="/inhouse" className={BTN_WIDE_SOLID}>
              更多入住及开票记录
            </Link>
          </div>
        </div>
      </aside>
    </div>,
    document.body
  );
}

/* ============================================================ 在住信息 */

function InfoGrid({ stay }: { stay: ForecastStayInfo }) {
  /** 一个「标签: 值」单元格；标签固定 52px（4 字 + 半角冒号正好 52px），值可换行 */
  const cell = (label: string, value: ReactNode, danger?: boolean) => (
    <div className="flex min-w-0 items-baseline gap-1 text-[12px] leading-[18px]">
      <span className="w-[52px] shrink-0 whitespace-nowrap text-[#7f8a93]">{label}:</span>
      <span className={`min-w-0 break-words tabular-nums ${danger ? "text-[#e23b3b]" : "text-[#333]"}`}>{value}</span>
    </div>
  );

  return (
    <div className="rounded-[2px] bg-[#f5f5f5] px-3 py-2.5">
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        {cell("入 住", stay.checkInText || "—")}
        {cell("今日房价", fmtMoney(stay.rate))}
        {cell("开票方", stay.invoiceParty || "未开票")}

        {cell("离 店", stay.checkOutText || "—")}
        {cell("消费金额", fmtMoney(stay.consume))}
        {cell("客人密码", stay.guestPassword || "—")}

        {cell("订单来源", stay.channelName)}
        {cell("收款金额", fmtMoney(stay.paid))}
        {cell("早餐数", stay.breakfast > 0 ? `${stay.breakfast} 份` : "—")}

        {cell("房卡数量", String(stay.cardCount))}
        {cell("余 款", fmtMoney(stay.balance), stay.balance > 0.01)}
        {cell("押 金", fmtMoney(stay.deposit))}

        {cell("物品租赁", stay.itemRental || "无")}
        <div className="col-span-2 flex min-w-0 items-baseline gap-1 text-[12px] leading-[18px]">
          <span className="w-[52px] shrink-0 text-[#7f8a93]">订单:</span>
          <span className="min-w-0 break-words text-[#333] tabular-nums">
            {stay.guestName}
            {stay.channelName ? <span className="ml-1 text-[#8b98a1]">· {stay.channelName}</span> : null}
          </span>
        </div>
      </div>

      {/* 备注：长文本，超出高度可滚动 */}
      <div className="mt-2 flex gap-1 border-t border-[#e6e6e6] pt-2">
        <span className="w-[52px] shrink-0 text-[12px] leading-[18px] tracking-[0.4em] text-[#7f8a93]">备注</span>
        <p className="min-w-0 max-h-[168px] flex-1 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-[18px] text-[#555]">
          {stay.remark || "无"}
        </p>
      </div>
    </div>
  );
}

/* ============================================================ 零件 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[#8b98a1]">{label}</span>
      {children}
    </label>
  );
}

function SubmitBtn({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`h-[28px] cursor-pointer rounded-[2px] px-3 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:bg-[#c8d0d6] ${
        danger ? "bg-[#e23b3b] hover:bg-[#c93030]" : "bg-[#32c141] hover:bg-[#2cb03b]"
      }`}
    >
      {pending ? "提交中…" : label}
    </button>
  );
}
