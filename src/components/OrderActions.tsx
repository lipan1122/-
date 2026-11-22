"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  addCompanionAction,
  addDepositAction,
  adjustRateAction,
  cancelCheckinAction,
  changeStayRoomAction,
  extendStayAction,
  joinTeamAction,
  linkRoomsAction,
  toHourlyAction,
} from "@/app/(main)/rooms/actions";
import { assignRoomAction } from "@/app/(main)/bookings/actions";

export type OrderDetail = {
  kind: "stay" | "booking";
  id: number;
  stayId: number | null;
  bookingId: number | null;
  statusKey: string;
  rateValue: number;
  orderNo: string;
  folioNo: string;
  statusLabel: string;
  statusCls: string;
  channelName: string;
  bookerName: string;
  bookerMobile: string;
  guestName: string;
  guestMobile: string;
  roomTypeName: string;
  roomNo: string;
  linkedRooms: number;
  stayType: string;
  checkInDisplay: string;
  checkOutDisplay: string;
  roomCount: number;
  rateText: string;
  breakfast: number;
  payType: string;
  invoiceParty: string;
  remark: string;
  totalText: string;
  paidText: string;
  balanceText: string;
  balanceOwed: boolean;
};

/** 换房可选的空房（VC / VD） */
export type RoomOption = { id: number; label: string };

/** 联房可选的其他在住入住单 */
export type StayOption = { id: number; label: string };

/** 抽屉内展开的操作表单 */
type PanelKey =
  | "extend"
  | "deposit"
  | "rate"
  | "link"
  | "companion"
  | "changeRoom"
  | "team"
  | "cancel"
  | "hourly"
  | "assignRoom";

type MenuEntry = {
  label: string;
  href?: string;
  external?: boolean;
  panel?: PanelKey;
  /** 无权限/不适用时展示的原因，有值即禁用 */
  disabledReason?: string;
};

type MenuPos = { top: number; left: number };

/** server action 统一签名（返回 void 或 { error, ok } 都能接住） */
type ServerAction = (formData: FormData) => Promise<unknown>;

type ActionReturn = { error?: string; ok?: string } | void | undefined;

const PANEL_TITLES: Record<PanelKey, string> = {
  assignRoom: "排房",
  extend: "续住",
  deposit: "交押金",
  rate: "调价",
  link: "联房",
  companion: "同住",
  changeRoom: "换房",
  team: "入团",
  cancel: "取消入住",
  hourly: "转钟点房",
};

const PAY_METHODS = ["现金", "微信", "支付宝", "银行卡", "挂账"];

const FIELD_CLS =
  "h-[30px] w-full rounded-[2px] border border-[#dcdcdc] bg-white px-2 text-[12px] text-[#3f4a54] outline-none focus:border-[#32c141] focus:ring-1 focus:ring-[#d6f2da]";

export default function OrderActions({
  detail,
  vacantRooms,
  inHouseStays,
}: {
  detail: OrderDetail;
  vacantRooms: RoomOption[];
  inHouseStays: StayOption[];
}) {
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  /* 抽屉滑入动画：挂载后下一帧切到 translate-x-0 */
  useEffect(() => {
    if (!drawerOpen) {
      setEntered(false);
      return;
    }
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, [drawerOpen]);

  /* 抽屉打开时锁定滚动 */
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  /* 下拉打开：点外部 / Esc / 滚动 / 窗口尺寸变化都收起 */
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  /* 抽屉 Esc 关闭 */
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        setPanel(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setPanel(null);
    setFormError(null);
  }, []);

  /** 提交 server action：成功关闭抽屉并刷新列表，失败留在抽屉内提示 */
  const submit = useCallback(
    async (action: ServerAction, formData: FormData, doneText: string) => {
      setPending(true);
      setFormError(null);
      try {
        const result = (await action(formData)) as ActionReturn;
        const error = result && typeof result === "object" ? result.error : undefined;
        const ok = result && typeof result === "object" ? result.ok : undefined;
        if (error) {
          setFormError(error);
          return;
        }
        showToast(ok ?? doneText);
        setPanel(null);
        setDrawerOpen(false);
        router.refresh();
      } catch {
        setFormError("操作失败，请稍后重试");
      } finally {
        setPending(false);
      }
    },
    [router, showToast]
  );

  /** 表单提交：补 stay_id 后交给 server action */
  const onSubmitWith = (action: ServerAction, doneText: string) => {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      if (detail.stayId !== null) formData.set("stay_id", String(detail.stayId));
      void submit(action, formData, doneText);
    };
  };

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 196;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    setMenuPos({ top: rect.bottom + 4, left });
    setMenuOpen(true);
  };

  /* ------------------------------------------------------ 可用性判定 */
  const stayId = detail.stayId;
  const bookingId = detail.bookingId;
  /** 在住：只有真的在住才会生成入住单可用能力 */
  const inHouse = detail.kind === "stay" && detail.statusKey === "INHOUSE";
  const checkedOut = detail.kind === "stay" && detail.statusKey === "CHECKED_OUT";
  /** 预订可办理入住：待排房 / 已确认 */
  const canCheckIn =
    detail.kind === "booking" &&
    (detail.statusKey === "PENDING" || detail.statusKey === "CONFIRMED");

  /** 在住能力被禁用的原因（空字符串 = 可用） */
  const stayBlocked =
    stayId === null
      ? detail.kind === "booking"
        ? "尚未入住"
        : "未关联入住单"
      : inHouse
        ? ""
        : checkedOut
          ? "已离店"
          : detail.statusLabel;

  const stayEntry = (label: string, key: PanelKey): MenuEntry =>
    stayBlocked ? { label, disabledReason: stayBlocked } : { label, panel: key };

  const checkoutEntry: MenuEntry = stayBlocked
    ? { label: "结账退房", disabledReason: stayBlocked }
    : { label: "结账退房", href: `/cashier?stay=${stayId ?? ""}` };

  const checkInEntry: MenuEntry =
    canCheckIn && bookingId !== null
      ? { label: "办理入住", href: `/frontdesk?booking=${bookingId}` }
      : {
          label: "办理入住",
          disabledReason:
            detail.kind === "booking" ? `${detail.statusLabel}，不可办理入住` : "已入住",
        };

  const registerPrintEntry: MenuEntry = stayBlocked
    ? { label: "打登记单", disabledReason: stayBlocked }
    : { label: "打登记单", href: `/cashier/print?stay=${stayId ?? ""}`, external: true };

  const entries: MenuEntry[] = [
    checkoutEntry,
    stayEntry("续住", "extend"),
    // 去呼呼预订单每行都有「排房」：未排房时可排，已排房时提示改排
    {
      label: detail.roomNo ? `重新排房（现 ${detail.roomNo}）` : "排房",
      panel: "assignRoom",
      disabledReason: detail.statusKey === "CHECKED_IN" ? "已入住，请用换房" : detail.statusKey === "CANCELLED" ? "订单已取消" : undefined,
    },
    checkInEntry,
    registerPrintEntry,
    stayEntry("交押金", "deposit"),
    stayEntry("调价", "rate"),
    stayEntry("联房", "link"),
    stayEntry("同住", "companion"),
    stayEntry("换房", "changeRoom"),
    stayEntry("入团", "team"),
    stayEntry("取消入住", "cancel"),
    stayEntry("转钟点房", "hourly"),
  ];

  /** 点击操作项：可跳转的直接跳，有表单的展开抽屉并切到对应表单 */
  const activateEntry = (entry: MenuEntry) => {
    setMenuOpen(false);
    if (!entry.panel) return;
    setFormError(null);
    setPanel(entry.panel);
    setDrawerOpen(true);
  };

  const hasMultiRoom = detail.linkedRooms > 1;

  /** 详情字段：标签灰 / 值深灰，两列排布 */
  const row = (label: string, value: ReactNode) => (
    <div className="min-w-0">
      <div className="text-[12px] leading-[18px] text-[#9aa4ae]">{label}</div>
      <div className="min-w-0 break-words text-[12px] leading-[18px] text-[#3f4a54]">{value}</div>
    </div>
  );

  /* ---------------------------------------------------- 抽屉内小表单 */
  const linkTargets = inHouseStays.filter((s) => s.id !== stayId);

  const renderPanel = () => {
    if (!panel) return null;
    // 排房是预订级操作，不依赖在住单
    if (stayId === null && panel !== "assignRoom") return null;

    const footer = (
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="submit"
          disabled={pending}
          className="h-[30px] cursor-pointer rounded-[2px] bg-[#32c141] px-3 text-[12px] font-medium text-white hover:bg-[#2bb038] disabled:cursor-not-allowed disabled:bg-[#d3d8dd]"
        >
          {pending ? "提交中…" : "确认"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPanel(null);
            setFormError(null);
          }}
          className="h-[30px] cursor-pointer rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
        >
          取消
        </button>
        {formError && <span className="text-[11px] text-[#e23b3b]">{formError}</span>}
      </div>
    );

    let body: ReactNode = null;

    switch (panel) {
      case "assignRoom":
        body = (
          <form
            action={assignRoomAction}
            className="space-y-2"
          >
            <input type="hidden" name="bookingId" value={detail.id ?? ""} />
            <input type="hidden" name="backTo" value="/bookings" />
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">分配房间</span>
              <select name="roomId" defaultValue="" required className={FIELD_CLS}>
                <option value="">请选择房间</option>
                {vacantRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11px] leading-[16px] text-[#9aa4ae]">
              入住 {detail.checkInDisplay ?? "-"} → 离店 {detail.checkOutDisplay ?? "-"}，
              列表只显示该日期区间可用的同房型房间。
            </p>
            {footer}
          </form>
        );
        break;
      case "extend":
        body = (
          <form onSubmit={onSubmitWith(extendStayAction, "已办理续住")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">续住晚数</span>
              <input
                type="number"
                name="nights"
                min={1}
                max={99}
                step={1}
                defaultValue={1}
                required
                className={FIELD_CLS}
              />
            </label>
            <p className="text-[11px] text-[#9aa4ae]">
              当前预计离店 {detail.checkOutDisplay || "未定"}，续住后顺延并补记房费。
            </p>
            {footer}
          </form>
        );
        break;

      case "deposit":
        body = (
          <form onSubmit={onSubmitWith(addDepositAction, "已收取押金")} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-[#9aa4ae]">金额（元）</span>
                <input
                  type="number"
                  name="amount"
                  min={0.01}
                  step={0.01}
                  defaultValue={0}
                  required
                  className={FIELD_CLS}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-[#9aa4ae]">收款方式</span>
                <select name="method" defaultValue="现金" className={FIELD_CLS}>
                  {PAY_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-[#9aa4ae]">
              押金计入账单预收款，同时累加入住单押金金额。
            </p>
            {footer}
          </form>
        );
        break;

      case "rate":
        body = (
          <form onSubmit={onSubmitWith(adjustRateAction, "已调整房价")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">新房价（元 / 晚）</span>
              <input
                type="number"
                name="rate"
                min={0}
                step={0.01}
                defaultValue={detail.rateValue}
                required
                className={FIELD_CLS}
              />
            </label>
            <p className="text-[11px] text-[#9aa4ae]">当前房价 {detail.rateText} / 晚。</p>
            {footer}
          </form>
        );
        break;

      case "link":
        body = (
          <form onSubmit={onSubmitWith(linkRoomsAction, "已完成联房")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">选择另一在住房间</span>
              <select name="target_stay_id" defaultValue="" required className={FIELD_CLS}>
                <option value="" disabled>
                  请选择在住房间
                </option>
                {linkTargets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {linkTargets.length === 0 && (
              <p className="text-[11px] text-[#b07d2e]">当前没有其他在住房间可联房。</p>
            )}
            {footer}
          </form>
        );
        break;

      case "companion":
        body = (
          <form onSubmit={onSubmitWith(addCompanionAction, "已添加同住人")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">同住人姓名</span>
              <input
                type="text"
                name="guest_name"
                required
                maxLength={40}
                placeholder="请输入同住人姓名"
                className={FIELD_CLS}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-[#9aa4ae]">手机号</span>
                <input
                  type="tel"
                  name="mobile"
                  maxLength={20}
                  placeholder="选填"
                  className={FIELD_CLS}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-[#9aa4ae]">证件号</span>
                <input
                  type="text"
                  name="id_no"
                  maxLength={40}
                  placeholder="选填"
                  className={FIELD_CLS}
                />
              </label>
            </div>
            <p className="text-[11px] text-[#9aa4ae]">同住人登记到该入住单下，可查同住人姓名与联系方式。</p>
            {footer}
          </form>
        );
        break;

      case "changeRoom":
        body = (
          <form onSubmit={onSubmitWith(changeStayRoomAction, "已完成换房")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">目标空房</span>
              <select name="new_room_id" defaultValue="" required className={FIELD_CLS}>
                <option value="" disabled>
                  请选择空房
                </option>
                {vacantRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            {vacantRooms.length === 0 && (
              <p className="text-[11px] text-[#b07d2e]">当前没有空净 / 空脏房可换。</p>
            )}
            <p className="text-[11px] text-[#9aa4ae]">
              换房后原房转空脏，新房转在住净，账务单房号同步更新。
            </p>
            {footer}
          </form>
        );
        break;

      case "team":
        body = (
          <form onSubmit={onSubmitWith(joinTeamAction, "已加入团队")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">团队名称</span>
              <input
                type="text"
                name="team_name"
                required
                maxLength={60}
                placeholder="如 阳光旅行社 2026-11 团"
                className={FIELD_CLS}
              />
            </label>
            <p className="text-[11px] text-[#9aa4ae]">入团后该入住单按团队房统计。</p>
            {footer}
          </form>
        );
        break;

      case "cancel":
        body = (
          <form onSubmit={onSubmitWith(cancelCheckinAction, "已取消入住")} className="space-y-2">
            <p className="text-[12px] leading-5 text-[#3f4a54]">
              确认取消入住单 <b className="tabular-nums">{detail.orderNo}</b>
              {detail.roomNo ? ` （房间 ${detail.roomNo}）` : ""}{" "}
              吗？取消后房间置为空净房，该入住单的账单与收款流水一并清理；存在欠款时需先结清。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={pending}
                className="h-[30px] cursor-pointer rounded-[2px] bg-[#e23b3b] px-3 text-[12px] font-medium text-white hover:bg-[#c93030] disabled:cursor-not-allowed disabled:bg-[#d3d8dd]"
              >
                {pending ? "提交中…" : "确认取消入住"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPanel(null);
                  setFormError(null);
                }}
                className="h-[30px] cursor-pointer rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
              >
                保留入住
              </button>
              {formError && <span className="text-[11px] text-[#e23b3b]">{formError}</span>}
            </div>
          </form>
        );
        break;

      case "hourly":
        body = (
          <form onSubmit={onSubmitWith(toHourlyAction, "已转为钟点房")} className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[#9aa4ae]">钟点小时数</span>
              <input
                type="number"
                name="hours"
                min={1}
                max={24}
                step={1}
                defaultValue={4}
                required
                className={FIELD_CLS}
              />
            </label>
            <p className="text-[11px] text-[#9aa4ae]">转为钟点房后按小时计费，晚数归零。</p>
            {footer}
          </form>
        );
        break;
    }

    return (
      <section className="mb-3 rounded-[2px] border border-[#b8e4c0] bg-[#f2f8f4] px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold text-[#3f4a54]">{PANEL_TITLES[panel]}</h3>
          <button
            type="button"
            onClick={() => {
              setPanel(null);
              setFormError(null);
            }}
            className="cursor-pointer text-[11px] text-[#9aa4ae] hover:text-[#5f6b76]"
          >
            收起
          </button>
        </div>
        {body}
      </section>
    );
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="cursor-pointer rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-0.5 text-[12px] leading-[18px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
      >
        查看
      </button>

      <button
        ref={btnRef}
        type="button"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-[2px] border bg-white px-2 py-0.5 text-[12px] leading-[18px] transition-colors hover:border-[#32c141] hover:text-[#32c141] ${
          menuOpen ? "border-[#32c141] text-[#32c141]" : "border-[#dcdcdc] text-[#5f6b76]"
        }`}
      >
        操作
        <svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true" className="shrink-0">
          <path
            d={menuOpen ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* ------------------------------------------------ 操作下拉 */}
      {menuOpen && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ top: menuPos.top, left: menuPos.left }}
              className="fixed z-[80] w-[196px] overflow-hidden rounded-[2px] border border-[#e5e7eb] bg-white py-1 shadow-lg"
            >
              {entries.map((entry) =>
                entry.disabledReason ? (
                  <div
                    key={entry.label}
                    role="menuitem"
                    aria-disabled="true"
                    title={entry.disabledReason}
                    className="flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-[#d3d8dd]"
                  >
                    <span>{entry.label}</span>
                    <span className="shrink-0 text-[10px] text-[#b3bcc5]">
                      {entry.disabledReason}
                    </span>
                  </div>
                ) : entry.href ? (
                  <a
                    key={entry.label}
                    href={entry.href}
                    role="menuitem"
                    target={entry.external ? "_blank" : undefined}
                    rel={entry.external ? "noreferrer" : undefined}
                    onClick={() => setMenuOpen(false)}
                    className="block px-3 py-1.5 text-[12px] text-[#3f4a54] hover:bg-[#f2f8f4] hover:text-[#32c141]"
                  >
                    {entry.label}
                  </a>
                ) : (
                  <button
                    key={entry.label}
                    type="button"
                    role="menuitem"
                    onClick={() => activateEntry(entry)}
                    className="block w-full cursor-pointer px-3 py-1.5 text-left text-[12px] text-[#3f4a54] hover:bg-[#f2f8f4] hover:text-[#32c141]"
                  >
                    {entry.label}
                  </button>
                )
              )}
            </div>,
            document.body
          )
        : null}

      {/* ------------------------------------------------ 详情抽屉 */}
      {drawerOpen
        ? createPortal(
            <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="订单详情">
              <button
                type="button"
                aria-label="关闭订单详情"
                onClick={closeDrawer}
                className={`absolute inset-0 cursor-default bg-black/30 transition-opacity duration-200 ${
                  entered ? "opacity-100" : "opacity-0"
                }`}
              />

              <aside
                className={`absolute right-0 top-0 flex h-full w-[460px] max-w-[94vw] flex-col bg-white shadow-2xl transition-transform duration-200 ease-out ${
                  entered ? "translate-x-0" : "translate-x-full"
                }`}
              >
                <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[#eee] px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[14px] font-bold text-[#1f2937]">订单详情</h2>
                      <span
                        className={`inline-flex items-center rounded-[2px] border px-1.5 py-0.5 text-[11px] ${detail.statusCls}`}
                      >
                        {detail.statusLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-[#9aa4ae]">
                      {detail.orderNo} · {detail.channelName} · {detail.stayType}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeDrawer}
                    aria-label="关闭"
                    className="cursor-pointer rounded-[2px] p-1 text-[16px] leading-none text-[#b3bcc5] hover:bg-[#f4f6f5] hover:text-[#3f4a54]"
                  >
                    ×
                  </button>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {/* 操作表单（点击操作下拉后在抽屉内展开） */}
                  {renderPanel()}

                  {/* 订单概况 */}
                  <section>
                    <h3 className="mb-2 text-[12px] font-semibold text-[#3f4a54]">订单概况</h3>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-[2px] border border-[#eef0f2] bg-[#fafbfc] px-3 py-3">
                      {row("订单号", detail.orderNo)}
                      {row("渠道", detail.channelName)}
                      {row(
                        "订单状态",
                        <span
                          className={`inline-flex items-center rounded-[2px] border px-1.5 py-0.5 text-[11px] ${detail.statusCls}`}
                        >
                          {detail.statusLabel}
                        </span>
                      )}
                      {row(
                        "预订人",
                        <span className="tabular-nums">
                          {detail.bookerName}
                          <span className="ml-1.5 text-[#9aa4ae]">{detail.bookerMobile}</span>
                        </span>
                      )}
                      {row(
                        "客人",
                        <span className="tabular-nums">
                          {detail.guestName}
                          <span className="ml-1.5 text-[#9aa4ae]">{detail.guestMobile}</span>
                        </span>
                      )}
                      {row("入住类型", detail.stayType)}
                      {row(
                        "房型/房号",
                        detail.roomNo ? (
                          <span>
                            {detail.roomTypeName}
                            <span className="ml-1.5 rounded-[2px] border border-[#b8e4c0] bg-[#e8f7ea] px-1 text-[11px] text-[#32c141]">
                              {detail.roomNo}
                            </span>
                          </span>
                        ) : (
                          <span>
                            {detail.roomTypeName}
                            <span className="ml-1.5 rounded-[2px] bg-[#fdf6ea] px-1 text-[11px] text-[#b07d2e]">
                              未排房
                            </span>
                          </span>
                        )
                      )}
                      {row(
                        "入离时间",
                        <span className="tabular-nums">
                          <span className="block">入住 {detail.checkInDisplay || "—"}</span>
                          <span className="block">离店 {detail.checkOutDisplay}</span>
                        </span>
                      )}
                      {row(
                        "间数",
                        <span className="tabular-nums">
                          {detail.roomCount} 间
                          {hasMultiRoom && (
                            <span className="ml-1.5 inline-flex items-center gap-1 rounded-[2px] border border-[#b8e4c0] bg-[#e8f7ea] px-1 text-[11px] text-[#32c141]">
                              <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                                <rect x="1" y="1" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                                <rect x="7" y="1" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                                <rect x="1" y="7" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                                <rect x="7" y="7" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
                              </svg>
                              所有联房 {detail.linkedRooms} 间
                            </span>
                          )}
                        </span>
                      )}
                      {row("房价", <span className="tabular-nums text-[#3f4a54]">{detail.rateText} / 晚</span>)}
                      {row("早餐", detail.breakfast > 0 ? `${detail.breakfast} 份` : "无早")}
                      {row("收款类型", detail.payType || "—")}
                      {row("开票方", detail.invoiceParty || "—")}
                      {row("备注", detail.remark || <span className="text-[#9aa4ae]">无</span>)}
                    </div>
                  </section>

                  {/* 账务信息 */}
                  <section className="mt-4">
                    <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[#3f4a54]">
                      账务信息
                      {detail.folioNo && (
                        <span className="rounded-[2px] border border-[#e5e7eb] bg-[#fafbfc] px-1 text-[11px] font-normal text-[#9aa4ae]">
                          {detail.folioNo}
                        </span>
                      )}
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-[2px] border border-[#eee] bg-white px-2.5 py-2">
                        <div className="text-[11px] text-[#9aa4ae]">消费合计</div>
                        <div className="mt-0.5 text-[13px] font-medium tabular-nums text-[#3f4a54]">
                          {detail.totalText}
                        </div>
                      </div>
                      <div className="rounded-[2px] border border-[#eee] bg-white px-2.5 py-2">
                        <div className="text-[11px] text-[#9aa4ae]">已收</div>
                        <div className="mt-0.5 text-[13px] font-medium tabular-nums text-[#3f4a54]">
                          {detail.paidText}
                        </div>
                      </div>
                      <div className="rounded-[2px] border border-[#eee] bg-white px-2.5 py-2">
                        <div className="text-[11px] text-[#9aa4ae]">余额</div>
                        <div
                          className={`mt-0.5 text-[13px] font-medium tabular-nums ${
                            detail.balanceOwed ? "text-[#e23b3b]" : "text-[#3f4a54]"
                          }`}
                        >
                          {detail.balanceText}
                        </div>
                      </div>
                    </div>
                    {detail.kind === "booking" && (
                      <p className="mt-1.5 text-[11px] text-[#9aa4ae]">
                        预订阶段未生成账务单，办理入住后自动生成账单与消费明细。
                      </p>
                    )}
                  </section>
                </div>

                <footer className="flex shrink-0 items-center gap-2 border-t border-[#eee] px-4 py-2.5">
                  {inHouse ? (
                    <Link
                prefetch={false}
                      href={`/cashier?stay=${stayId}`}
                      onClick={closeDrawer}
                      className="inline-flex h-[30px] items-center rounded-[2px] bg-[#32c141] px-3 text-[12px] font-medium text-white hover:bg-[#2bb038]"
                    >
                      结账退房
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        showToast(stayId === null ? "该订单尚未入住，无法结账退房" : "该订单已离店")
                      }
                      className="inline-flex h-[30px] cursor-pointer items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                    >
                      结账退房
                    </button>
                  )}
                  {stayId !== null ? (
                    <Link
                prefetch={false}
                      href={`/cashier?stay=${stayId}`}
                      onClick={closeDrawer}
                      className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                    >
                      查看账单
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => showToast("预订阶段未生成账单")}
                      className="inline-flex h-[30px] cursor-pointer items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                    >
                      查看账单
                    </button>
                  )}
                  {canCheckIn && bookingId !== null ? (
                    <Link
                prefetch={false}
                      href={`/frontdesk?booking=${bookingId}`}
                      onClick={closeDrawer}
                      className="inline-flex h-[30px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                    >
                      办理入住
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        showToast(
                          detail.kind === "booking"
                            ? `${detail.statusLabel}，不可办理入住`
                            : "该订单已入住，无需重复办理"
                        )
                      }
                      className="inline-flex h-[30px] cursor-pointer items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                    >
                      办理入住
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={closeDrawer}
                    className="ml-auto inline-flex h-[30px] cursor-pointer items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                  >
                    关闭
                  </button>
                </footer>
              </aside>
            </div>,
            document.body
          )
        : null}

      {/* ---------------------------------------------------- toast */}
      {toast
        ? createPortal(
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none fixed left-1/2 top-6 z-[90] -translate-x-1/2 rounded-md bg-gray-900/90 px-3.5 py-2 text-[12px] text-white shadow-lg"
            >
              {toast}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
