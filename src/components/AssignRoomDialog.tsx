"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { assignRoomsAction } from "@/app/(main)/rooms/forecast/actions";

/* ============================================================
 * 「引入待排房订单」弹窗（尺寸 / 配色按去呼呼远期房态截图实测）
 *   弹窗  852 × 自适应，遮罩 rgba(0,0,0,.45)
 *   标题栏 40px  表头 40px（#ddf0e0） 表体可视 318px  底栏 37px
 *   列宽  36 / 46 / 102 / 64 / 68 / 34 / 124 / 68 / 自适应 / 65
 *   主绿  #3bd943（保存、去排房）
 * ============================================================ */

const DIALOG_W = 852;
const HEADER_BG = "#ddf0e0";
const GREEN = "#3bd943";
const LINE = "#f4f4f4";
const BODY_MAX_H = 318;

/** 分配房间下拉的一个候选房 */
export type RoomOption = {
  id: number;
  roomNo: string;
  status: string;
  /** 房型名 + 是否属于升级房型（同房型为空时才能选） */
  roomTypeName?: string;
  upgradable?: boolean;
};

/** 一条待排房订单（服务端已算好该订单可用的房间列表） */
export type PendingBooking = {
  id: number;
  /**
   * 行级唯一键（可选）。
   *
   * 多房订单在弹窗里会按 `booking_rooms` 明细展开成多行（一行 = 一间待分房单位），
   * 这些行共享同一个订单 id —— 如果直接拿 `id` 当 React key / 勾选键：
   *   · 同一个 key 出现多次 → React 报「Encountered two children with the same key」；
   *   · 勾一行等于勾整单、选一间房等于整单都选了那一间。
   * 所以页面用 `rowKey`（如 `612#2`）区分行；老调用方不传时退回 String(id)，行为不变。
   */
  rowKey?: string;
  bookingNo: string;
  channelName: string;
  channelOrderNo: string;
  guestName: string;
  roomTypeName: string;
  roomCount: number;
  checkInDate: string;
  checkInTime: string;
  checkOutDate: string;
  checkOutTime: string;
  /** 最晚到店（保留时间），空则显示「-」 */
  latestArrival: string;
  rooms: RoomOption[];
};

/** 行级键：有 rowKey 用 rowKey，否则退回订单 id（单行/老数据） */
function rowKeyOf(b: PendingBooking): string {
  return b.rowKey && b.rowKey.length > 0 ? b.rowKey : String(b.id);
}

const COL_W = { check: 36, channel: 46, orderNo: 102, guest: 64, type: 68, count: 34, stay: 124, latest: 68, action: 65 };

const thCls = "h-10 px-1 text-center align-middle text-[12px] font-normal text-[#4a4a4a]";
const tdCls = "px-1 py-2 text-center align-middle text-[12px] leading-[18px] text-[#333]";

export default function AssignRoomDialog({
  bookings,
  defaultOpen = false,
}: {
  bookings: PendingBooking[];
  /** 由表头「待分房N间」点进来时直接打开弹窗 */
  defaultOpen?: boolean;
}) {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [pending, startTransition] = useTransition();

  /** 行勾选：行级键（rowKeyOf）-> 是否勾选。多房订单展开成多行时每行独立勾选 */
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  /** 行分配：行级键 -> roomId | null */
  const [roomOf, setRoomOf] = useState<Record<string, number | null>>({});
  /** 批量智能排房开关 */
  const [batch, setBatch] = useState(false);
  const [error, setError] = useState("");

  const selectRefs = useRef<Map<string, HTMLSelectElement | null>>(new Map());
  const allRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  /* 由表头「待分房」带 ?pending= 进来：即使组件被复用（query 变化不重新挂载）也要弹出 */
  useEffect(() => {
    if (!defaultOpen) return;
    setChecked({});
    setRoomOf({});
    setBatch(false);
    setError("");
    setOpen(true);
  }, [defaultOpen]);

  /* ---------------- 打开 / 关闭 ---------------- */

  function openDialog() {
    setChecked({});
    setRoomOf({});
    setBatch(false);
    setError("");
    setOpen(true);
  }

  function closeDialog() {
    if (pending) return;
    setOpen(false);
    /* 由 URL 打开时，关闭后清掉 ?pending=，刷新不会再弹 */
    if (defaultOpen) {
      const url = new URL(window.location.href);
      url.searchParams.delete("pending");
      router.replace(`${url.pathname}${url.search}`, { scroll: false });
    }
  }

  /* ---------------- 弹窗打开时锁住页面滚动（禁止滚动穿透） ---------------- */
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  /* ---------------- Esc 关闭 ---------------- */
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeDialog();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  /* ---------------- 勾选统计 ---------------- */
  const checkedCount = useMemo(
    () => bookings.reduce((n, b) => (checked[rowKeyOf(b)] ? n + 1 : n), 0),
    [bookings, checked]
  );

  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = checkedCount > 0 && checkedCount < bookings.length;
    }
  }, [checkedCount, bookings.length, open]);

  /** 提交给 action 的行：勾选 + 已选房（bookingId 仍是真实订单 id，rowKey 只用于区分弹窗里的行） */
  const payload = useMemo(
    () =>
      bookings
        .filter((b) => {
          const key = rowKeyOf(b);
          return checked[key] === true && typeof roomOf[key] === "number";
        })
        .map((b) => ({ bookingId: b.id, roomId: roomOf[rowKeyOf(b)] as number })),
    [bookings, checked, roomOf]
  );

  /* ---------------- 交互 ---------------- */

  function toggleAll(next: boolean) {
    if (!next) {
      setChecked({});
      return;
    }
    const all: Record<string, boolean> = {};
    for (const b of bookings) all[rowKeyOf(b)] = true;
    setChecked(all);
  }

  function toggleRow(key: string) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function setRowRoom(key: string, roomId: number | null) {
    setRoomOf((prev) => ({ ...prev, [key]: roomId }));
    // 选了房就顺带勾上，避免「选了房但没勾选」导致保存被忽略
    if (roomId !== null) setChecked((prev) => ({ ...prev, [key]: true }));
  }

  /**
   * 批量智能排房：为每行预填一个可用房号。
   * 同一间房不会被同时分给两行（按订单顺序取第一个尚未被占用的候选房）。
   */
  function applyBatch(on: boolean) {
    setBatch(on);
    setError("");
    if (!on) return;

    const used = new Set<number>();
    const nextRoom: Record<string, number | null> = {};
    const nextChecked: Record<string, boolean> = { ...checked };

    for (const b of bookings) {
      const pick = b.rooms.find((r) => !used.has(r.id));
      if (!pick) continue;
      used.add(pick.id);
      nextRoom[rowKeyOf(b)] = pick.id;
      nextChecked[rowKeyOf(b)] = true;
    }
    setRoomOf(nextRoom);
    setChecked(nextChecked);
  }

  /** 「去排房」：聚焦并展开该行的分配房间下拉 */
  function goAssign(booking: PendingBooking) {
    const key = rowKeyOf(booking);
    const el = selectRefs.current.get(key);
    if (!el || el.disabled) {
      setError(`${booking.guestName || booking.bookingNo} 的 ${booking.roomTypeName} 在该日期区间没有空房，可在下拉里选其他房型（升级排房）`);
      return;
    }
    setError("");
    setChecked((prev) => ({ ...prev, [key]: true }));
    el.focus();
    const picker = (el as HTMLSelectElement & { showPicker?: () => void }).showPicker;
    if (typeof picker === "function") {
      try {
        picker.call(el);
      } catch {
        /* 浏览器不允许程序唤起时，聚焦即可 */
      }
    }
  }

  /** 保存：提交所有「已勾选 + 已选房」的行 */
  function onSave() {
    setError("");
    if (payload.length === 0) {
      setError("请先勾选待排房订单并为其分配房间");
      return;
    }
    const fd = new FormData();
    fd.set("rows", JSON.stringify(payload));
    startTransition(async () => {
      const res = await assignRoomsAction(fd);
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(res.error ?? "批量排房失败，请重试");
      }
    });
  }

  /* ---------------- 渲染 ---------------- */

  const trigger = (
    <button
      type="button"
      onClick={openDialog}
      className="cursor-pointer rounded-[3px] bg-[#58bc62] px-3 py-[6px] text-[13px] font-medium text-white transition-colors hover:bg-[#4fae59]"
    >
      引入待排房订单
    </button>
  );

  if (!mounted || !open) return trigger;

  const dialog = (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="引入待排房订单"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeDialog();
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-[2px] bg-white shadow-[0_6px_26px_rgba(0,0,0,0.28)]"
        style={{ width: DIALOG_W, maxWidth: "100%", maxHeight: "calc(100vh - 32px)" }}
      >
        {/* ------------------------------------------------ 标题栏 */}
        <div className="flex h-10 shrink-0 items-center border-b border-[#f0f0f0] px-4">
          <h2 className="text-[13px] font-bold text-[#2b2b2b]">引入待排房订单</h2>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="关闭"
            className="ml-auto cursor-pointer rounded p-1 text-[16px] leading-none text-[#b0b0b0] transition-colors hover:bg-[#f5f5f5] hover:text-[#666]"
          >
            ×
          </button>
        </div>

        {/* ------------------------------------------------ 内容 */}
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-1 pt-3">
          {/* 批量智能排房 */}
          <label className="mb-2 inline-flex w-fit cursor-pointer select-none items-center gap-1.5 rounded-[2px] border border-[#e7e7e7] bg-[#f3f3f3] px-1.5 py-1 text-[12px] text-[#8c8c8c] transition-colors hover:text-[#555]">
            <input
              type="checkbox"
              checked={batch}
              onChange={(e) => applyBatch(e.target.checked)}
              className="h-[13px] w-[13px] cursor-pointer accent-[#3bd943]"
            />
            批量智能排房
          </label>

          {/* 表格：表头固定，表体滚动 */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ maxHeight: BODY_MAX_H }}>
            <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: COL_W.check }} />
                <col style={{ width: COL_W.channel }} />
                <col style={{ width: COL_W.orderNo }} />
                <col style={{ width: COL_W.guest }} />
                <col style={{ width: COL_W.type }} />
                <col style={{ width: COL_W.count }} />
                <col style={{ width: COL_W.stay }} />
                <col style={{ width: COL_W.latest }} />
                <col />
                <col style={{ width: COL_W.action }} />
              </colgroup>

              <thead>
                <tr>
                  <th className={`${thCls} sticky top-0 z-10`} style={{ background: HEADER_BG }}>
                    <input
                      ref={allRef}
                      type="checkbox"
                      aria-label="全选待排房订单"
                      checked={bookings.length > 0 && checkedCount === bookings.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                      className="h-[13px] w-[13px] cursor-pointer accent-[#3bd943]"
                    />
                  </th>
                  {["渠道", "渠道订单号", "客人信息", "预订房型", "房间数", "入离时间", "最晚到店"].map((label) => (
                    <th key={label} className={`${thCls} sticky top-0 z-10`} style={{ background: HEADER_BG }}>
                      {label}
                    </th>
                  ))}
                  <th className={`${thCls} sticky top-0 z-10`} style={{ background: HEADER_BG }}>
                    分配房间
                  </th>
                  <th className={`${thCls} sticky top-0 z-10`} style={{ background: HEADER_BG }}>
                    操作
                  </th>
                </tr>
              </thead>

              <tbody>
                {bookings.length === 0 && (
                  <tr>
                    <td colSpan={10} className="h-[120px] text-center align-middle text-[13px] text-[#999]">
                      暂无待排房订单：所有预订都已分配房间
                    </td>
                  </tr>
                )}

                {bookings.map((b) => {
                  const key = rowKeyOf(b);
                  const roomId = roomOf[key];
                  const noRoom = b.rooms.length === 0;
                  return (
                    <tr key={key} className="hover:bg-[#fafafa]" style={{ borderBottom: `1px solid ${LINE}` }}>
                      {/* 复选框 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <input
                          type="checkbox"
                          aria-label={`勾选 ${b.guestName || b.bookingNo}`}
                          checked={checked[key] === true}
                          onChange={() => toggleRow(key)}
                          className="h-[13px] w-[13px] cursor-pointer accent-[#3bd943]"
                        />
                      </td>
                      {/* 渠道 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <span className="block truncate">{b.channelName || "-"}</span>
                      </td>
                      {/* 渠道订单号 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <span className="block truncate tabular-nums" title={b.channelOrderNo || undefined}>
                          {b.channelOrderNo || "-"}
                        </span>
                      </td>
                      {/* 客人信息 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <span className="block truncate">{b.guestName || "-"}</span>
                      </td>
                      {/* 预订房型 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <span className="block break-words">{b.roomTypeName || "-"}</span>
                      </td>
                      {/* 房间数 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <span className="tabular-nums">{b.roomCount}</span>
                      </td>
                      {/* 入离时间 */}
                      <td className={`${tdCls} tabular-nums`} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <span className="block whitespace-nowrap">
                          入住：{b.checkInDate} {b.checkInTime}
                        </span>
                        <span className="block whitespace-nowrap">
                          离店：{b.checkOutDate} {b.checkOutTime}
                        </span>
                      </td>
                      {/* 最晚到店 */}
                      <td className={`${tdCls} tabular-nums`} style={{ borderBottom: `1px solid ${LINE}` }}>
                        {b.latestArrival || "-"}
                      </td>
                      {/* 分配房间 */}
                      <td className={`${tdCls} px-1.5`} style={{ borderBottom: `1px solid ${LINE}` }}>
                        {noRoom ? (
                          <span
                            className="text-[12px] text-[#999]"
                            title={`${b.roomTypeName} 在该日期区间没有空净/空脏房可分`}
                          >
                            -
                          </span>
                        ) : (
                          <select
                            ref={(el) => {
                              selectRefs.current.set(key, el);
                            }}
                            value={roomId != null ? String(roomId) : ""}
                            onChange={(e) => setRowRoom(key, e.target.value ? Number(e.target.value) : null)}
                            aria-label={`为 ${b.guestName || b.bookingNo} 分配房间`}
                            className="h-6 w-full cursor-pointer rounded-[2px] border border-transparent bg-transparent px-1 text-center text-[12px] text-[#333] outline-none transition-colors hover:border-[#d9d9d9] focus:border-[#3bd943] focus:bg-white"
                          >
                            <option value="">-</option>
                            {b.rooms.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.roomNo}
                                {r.status === "VD" ? "（脏）" : ""}
                                {r.upgradable ? ` · 升级 ${r.roomTypeName ?? ""}` : ""}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      {/* 操作 */}
                      <td className={tdCls} style={{ borderBottom: `1px solid ${LINE}` }}>
                        <button
                          type="button"
                          onClick={() => goAssign(b)}
                          className="inline-flex h-5 cursor-pointer items-center justify-center rounded-[2px] px-1 text-[12px] leading-none text-white transition-colors"
                          style={{ background: GREEN }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#33cd3b";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = GREEN;
                          }}
                        >
                          去排房
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ------------------------------------------------ 底栏 */}
        <div className="flex h-[37px] shrink-0 items-center gap-2 border-t border-[#f2f2f2] px-4">
          {error ? <span className="mr-auto truncate text-[12px] text-[#e60012]">{error}</span> : null}
          <button
            type="button"
            onClick={closeDialog}
            disabled={pending}
            className="inline-flex h-6 cursor-pointer items-center justify-center rounded-[2px] border border-[#e5e5e5] bg-white px-3 text-[12px] text-[#555] transition-colors hover:border-[#d0d0d0] hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={pending}
            className="inline-flex h-6 cursor-pointer items-center justify-center rounded-[2px] px-3 text-[12px] text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: GREEN }}
          >
            {pending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {trigger}
      {createPortal(dialog, document.body)}
    </>
  );
}
