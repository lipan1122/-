"use client";

/**
 * 客人订单列表浮窗（受控）
 *
 * 对照去呼呼「房型可售预测」：点某房型某天的「占用」数字，弹出当天占用该房型的订单。
 * 列：订单状态 / 渠道 / 渠道订单号 / 客人信息 / 入住类型 / 房间信息 / 入住·离店 / 备注 / 操作
 */

import { useEffect, useState } from "react";
import Link from "next/link";

export type OrderListEntry = {
  status: string;
  statusLabel: string;
  channelName: string;
  channelOrderNo: string;
  guestName: string;
  mobile: string | null;
  stayType: string;
  roomTypeName: string;
  roomNo: string;
  rate: number;
  rooms: number;
  checkIn: string;
  checkOut: string;
  remark: string;
  stayId: number | null;
  bookingId: number | null;
  linkCount: number;
};

export type OrderListCell = { typeId: number; day: string; list: OrderListEntry[] };

const TH =
  "border-b border-r border-[#eee] bg-[#fafafa] px-2 py-1.5 text-left text-[11.5px] font-medium text-[#555] whitespace-nowrap";
const TD = "border-b border-r border-[#f2f2f2] px-2 py-1.5 text-[11.5px] text-[#555] align-top";

export default function OrderListDialog({
  cells,
  typeNames,
  open,
  onClose,
}: {
  cells: OrderListCell[];
  typeNames: Record<number, string>;
  open: { typeId: number; day: string } | null;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const PER_PAGE = 10;

  useEffect(() => {
    setPage(1);
  }, [open?.typeId, open?.day]);

  if (!open) return null;

  const list = cells.find((c) => c.typeId === open.typeId && c.day === open.day)?.list ?? [];
  const pageCount = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const paged = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const roomCount = list.reduce((s, e) => s + (e.rooms || 1), 0);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[1180px] max-w-full flex-col overflow-hidden rounded-[4px] bg-white shadow-[0_12px_40px_rgba(0,0,0,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#eee] px-4 py-2.5">
          <div className="flex items-baseline gap-3">
            <span className="text-[14px] font-semibold text-[#2a9d3c]">客人订单列表</span>
            <span className="text-[11.5px] text-[#888]">
              {typeNames[open.typeId] ?? ""} · {open.day} · 订单数 {list.length} · 房间数 {roomCount}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭客人订单列表"
            className="text-[18px] leading-none text-[#999] hover:text-[#e53935]"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-max border-collapse">
            <thead>
              <tr>
                <th className={TH}>订单状态</th>
                <th className={TH}>渠道</th>
                <th className={TH}>渠道订单号</th>
                <th className={TH}>客人信息</th>
                <th className={TH}>入住类型</th>
                <th className={TH}>房间信息</th>
                <th className={TH}>入住时间</th>
                <th className={TH}>备注</th>
                <th className={TH}>操作</th>
              </tr>
            </thead>
            <tbody>
              {paged.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-[12px] text-[#999]">
                    当天没有占用订单
                  </td>
                </tr>
              )}
              {paged.map((e, i) => (
                <tr
                  /*
                   * 行 key 必须带上行序号：多房订单在「占用」里是按明细展开的
                   * （同一 bookingId 会占多行，一行 = 一间），只用 bookingId 会撞 key。
                   */
                  key={`${e.stayId ?? `b${e.bookingId ?? ""}`}-${page}-${i}`}
                  className="hover:bg-[#fafcfb]"
                >
                  <td className={TD}>{e.statusLabel}</td>
                  <td className={TD}>{e.channelName}</td>
                  <td className={`${TD} tabular-nums`}>{e.channelOrderNo}</td>
                  <td className={TD}>
                    <div>{e.guestName}</div>
                    {e.linkCount > 1 && (
                      <div className="text-[10.5px] text-[#2a9d3c]">⌂ 所有联房（{e.linkCount}）</div>
                    )}
                  </td>
                  <td className={TD}>{e.stayType}</td>
                  <td className={TD}>
                    <div>
                      {e.roomTypeName} <span className="font-medium tabular-nums">{e.roomNo}</span>
                    </div>
                    <div className="text-[11px] text-[#e53935]">
                      ¥{e.rate.toFixed(2)} {e.rooms}间
                    </div>
                  </td>
                  <td className={`${TD} tabular-nums`}>
                    <div>入住：{e.checkIn}</div>
                    <div className="text-[11px] text-[#888]">离店：{e.checkOut}</div>
                  </td>
                  <td className={`${TD} max-w-[180px]`}>
                    <div className="line-clamp-2">{e.remark}</div>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    <div className="flex items-center gap-2 text-[#2a9d3c]">
                      <Link prefetch={false} href={e.stayId ? `/guest-detail?type=stay&id=${e.stayId}` : `/guest-detail?type=booking&id=${e.bookingId ?? ""}`} className="hover:underline">
                        查看
                      </Link>
                      <Link prefetch={false} href={e.stayId ? `/cashier?stay=${e.stayId}&op=change` : `/guest-detail?type=booking&id=${e.bookingId ?? ""}`} className="hover:underline">
                        换房
                      </Link>
                      <Link
                        prefetch={false}
                        href={e.stayId ? `/cashier?stay=${e.stayId}&op=cancel` : `/guest-detail?type=booking&id=${e.bookingId ?? ""}`}
                        className="hover:underline"
                      >
                        取消入住
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#eee] px-4 py-2 text-[11.5px] text-[#666]">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded border border-[#ddd] px-2 py-0.5 disabled:opacity-40"
          >
            上一页
          </button>
          <span className="rounded bg-[#32c141] px-2 py-0.5 text-white">{page}</span>
          <span>/ {pageCount}</span>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            className="rounded border border-[#ddd] px-2 py-0.5 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
