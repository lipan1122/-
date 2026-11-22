"use client";

import { useState, useTransition } from "react";
import { batchCleanRoomsAction } from "@/app/(main)/housekeeping/batch-actions";

export type DirtyRoom = { id: number; roomNo: string; floor: number | null };

/**
 * 批量置净面板（整改报告 P2-10）
 *
 * 客房/前台把今天打扫完的空脏房一次勾选、一键置净，
 * 不用一间一间点。
 */
export default function BatchCleanPanel({ rooms }: { rooms: DirtyRoom[] }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<{ ok?: string; error?: string } | null>(null);

  if (rooms.length === 0) return null;

  const allSelected = selected.length === rooms.length;
  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = () => {
    if (selected.length === 0) {
      setState({ error: "请先勾选房间" });
      return;
    }
    const fd = new FormData();
    for (const id of selected) fd.append("room_id", String(id));
    startTransition(async () => {
      const r = await batchCleanRoomsAction(fd);
      setState(r);
      if (r.ok) setSelected([]);
    });
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-gray-800">批量置净</span>
          <span className="text-[11px] text-gray-400">空脏 {rooms.length} 间</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSelected(allSelected ? [] : rooms.map((r) => r.id))}
            className="inline-flex h-[26px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || selected.length === 0}
            className="inline-flex h-[26px] items-center rounded-[2px] border border-[#32c141] bg-[#32c141] px-3 text-[11.5px] font-medium text-white transition-colors hover:bg-[#2bb038] disabled:cursor-not-allowed disabled:border-[#e0e0e0] disabled:bg-[#f5f5f5] disabled:text-[#b8b8b8]"
          >
            {pending ? "置净中…" : `置净选中（${selected.length}）`}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 py-3">
        {rooms.map((r) => {
          const on = selected.includes(r.id);
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => toggle(r.id)}
              className={`inline-flex h-[28px] min-w-[64px] items-center justify-center rounded-[2px] border px-2 text-[12px] tabular-nums transition-colors ${
                on
                  ? "border-[#32c141] bg-[#eaf7ec] font-medium text-[#1e8e3e]"
                  : "border-[#dcdcdc] bg-white text-[#5f6b76] hover:border-[#32c141]"
              }`}
              title={r.floor != null ? `${r.floor} 楼` : undefined}
            >
              {r.roomNo}
            </button>
          );
        })}
      </div>

      {state?.ok && (
        <div className="border-t border-[#e6f4ea] bg-[#f1f9f3] px-4 py-1.5 text-[11.5px] text-[#1e8e3e]">
          {state.ok}
        </div>
      )}
      {state?.error && (
        <div className="border-t border-[#f5c2c2] bg-[#fdf3f3] px-4 py-1.5 text-[11.5px] text-[#c0392b]">
          {state.error}
        </div>
      )}
    </div>
  );
}
