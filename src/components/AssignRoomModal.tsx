"use client";

import { useMemo, useState } from "react";
import { assignRoomAction } from "@/app/(main)/bookings/actions";

export type CandidateRoom = {
  id: number;
  room_no: string;
  floor: number | null;
  room_type_id: number;
  room_type_name: string;
  status: string;
  /** 该房型是否可作为「升级房型」入住当前预订 */
  upgradable?: boolean;
};

/** 去呼呼排房弹窗：房态 / 楼层 / 房型 三级筛选 + 可选房间 + 已排房间 */
export function AssignRoomModal({
  bookingId,
  roomTypeName,
  roomTypeId,
  rooms,
  alreadyAssigned,
  backTo,
  pendingCount = 1,
}: {
  bookingId: number;
  roomTypeName: string;
  roomTypeId: number;
  rooms: CandidateRoom[];
  alreadyAssigned: string | null;
  backTo: string;
  /** 还剩几间待排房（决定一次最多能选几间） */
  pendingCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "VC" | "VD" | "departing">("all");
  const [floorFilter, setFloorFilter] = useState<number | "all">("all");
  const [typeFilter, setTypeFilter] = useState<number | "all">(roomTypeId);
  const [picked, setPicked] = useState<CandidateRoom[]>([]);
  const [busy, setBusy] = useState(false);

  const floors = useMemo(() => {
    const set = new Set<number>();
    for (const r of rooms) if (r.floor != null) set.add(r.floor);
    return Array.from(set).sort((a, b) => a - b);
  }, [rooms]);

  const types = useMemo(() => {
    const map = new Map<number, { name: string; upgradable: boolean }>();
    for (const r of rooms) {
      if (!map.has(r.room_type_id)) map.set(r.room_type_id, { name: r.room_type_name, upgradable: Boolean(r.upgradable) });
    }
    return Array.from(map.entries());
  }, [rooms]);

  const shown = rooms.filter((r) => {
    if (typeFilter !== "all" && r.room_type_id !== typeFilter) return false;
    if (floorFilter !== "all" && r.floor !== floorFilter) return false;
    if (statusFilter === "VC" && r.status !== "VC") return false;
    if (statusFilter === "VD" && r.status !== "VD") return false;
    if (statusFilter === "departing" && r.status !== "OD") return false;
    return true;
  });

  /** 一次最多选 pendingCount 间（对齐后端「一次性校验所有房间」） */
  const maxPick = Math.max(1, pendingCount);
  const toggle = (r: CandidateRoom) => {
    setPicked((prev) => {
      if (prev.some((x) => x.id === r.id)) return prev.filter((x) => x.id !== r.id);
      if (prev.length >= maxPick) return prev; // 满了就不再加
      return [...prev, r];
    });
  };

  const submit = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("bookingId", String(bookingId));
    fd.set("roomIds", picked.map((p) => p.id).join(","));
    fd.set("backTo", backTo);
    try {
      await assignRoomAction(fd);
    } catch {
      /* redirect 由 action 内部抛出，忽略 */
    }
    setBusy(false);
    setOpen(false);
    setPicked([]);
  };

  const btn = (active: boolean) =>
    `rounded-[2px] px-2.5 py-[3px] text-[12px] ${
      active ? "border border-[#3bd943] bg-[#eef9f0] text-[#0f8f6f]" : "border border-[#e5e5e5] bg-white text-[#555] hover:border-[#b8d8c0]"
    }`;

  return (
    <>
      <form action={`${backTo ? "" : ""}`} className="inline">
        <button
          type="button"
          data-keep-open
          onClick={() => setOpen(true)}
          className={
            alreadyAssigned
              ? "rounded border border-gray-300 bg-white px-2 py-0.5 text-[12px] text-gray-600 hover:border-brand-500"
              : "btn-primary px-2 py-0.5 text-[12px]"
          }
        >
          {alreadyAssigned ? `改排房（现 ${alreadyAssigned}）` : "排房"}
        </button>
      </form>

      {open && (
        <div
          data-keep-open
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[6vh]"
        >
          <div className="w-[880px] max-w-[94vw] rounded-[3px] bg-white shadow-2xl">
            {/* 标题栏 */}
            <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
              <span className="rounded-[2px] bg-[#3bd943] px-2.5 py-1 text-[13px] text-white">
                {roomTypeName}　{picked.length}/{maxPick}
              </span>
              <button onClick={() => setOpen(false)} className="text-[16px] text-[#bbb] hover:text-[#e53935]" aria-label="关闭">
                ✕
              </button>
            </div>

            <div className="flex gap-3 p-3">
              {/* 左侧筛选 + 可选房间 */}
              <div className="min-w-0 flex-1">
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="w-[44px] shrink-0 pt-1 text-[12px] text-[#555]">房态:</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button className={btn(statusFilter === "all")} onClick={() => setStatusFilter("all")}>全部</button>
                      <button className={btn(statusFilter === "VC")} onClick={() => setStatusFilter("VC")}>空净</button>
                      <button className={btn(statusFilter === "VD")} onClick={() => setStatusFilter("VD")}>空脏</button>
                      <button className={btn(statusFilter === "departing")} onClick={() => setStatusFilter("departing")}>今日预离</button>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="w-[44px] shrink-0 pt-1 text-[12px] text-[#555]">楼层:</span>
                    <div className="flex flex-wrap gap-1.5">
                      <button className={btn(floorFilter === "all")} onClick={() => setFloorFilter("all")}>全部</button>
                      {floors.map((f) => (
                        <button key={f} className={btn(floorFilter === f)} onClick={() => setFloorFilter(f)}>
                          {["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][f] ?? f}层
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="w-[44px] shrink-0 pt-1 text-[12px] text-[#555]">房型:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {types.map(([id, t]) => (
                        <button key={id} className={btn(typeFilter === id)} onClick={() => setTypeFilter(id)}>
                          {t.name}
                          {t.upgradable && (
                            <span className="ml-1 rounded-[2px] bg-[#e53935] px-1 text-[10px] text-white">可升级</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 border-t border-[#f0f0f0] pt-2">
                  <div className="mb-1 text-[12.5px] font-medium text-[#333]">可选房间</div>
                  {shown.length === 0 ? (
                    <div className="py-8 text-center text-[12px] text-[#999]">暂无可选房间</div>
                  ) : (
                    <div className="grid max-h-[300px] grid-cols-3 gap-1.5 overflow-y-auto md:grid-cols-4">
                      {shown.map((r) => {
                        const on = picked.some((x) => x.id === r.id);
                        return (
                          <button
                            key={r.id}
                            onClick={() => toggle(r)}
                            className={`rounded-[2px] border px-2 py-1.5 text-left text-[12px] ${
                              on
                                ? "border-[#3bd943] bg-[#eef9f0] text-[#0f8f6f]"
                                : "border-[#e5e5e5] bg-white text-[#333] hover:border-[#b8d8c0]"
                            }`}
                          >
                            <div className="font-medium">{r.room_no}</div>
                            <div className="text-[10.5px] text-[#999]">
                              {r.status === "VC" ? "空净" : r.status === "VD" ? "空脏" : r.status === "OD" ? "预离" : r.status}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* 右侧已排房间 */}
              <div className="w-[300px] shrink-0 rounded border border-[#f0f0f0] bg-[#fafafa] p-2">
                <div className="mb-1 text-[12.5px] text-[#555]">已排房间 ({picked.length}/{maxPick})</div>
                {picked.length === 0 ? (
                  <div className="py-4 text-[12px] text-[#999]">暂无房间</div>
                ) : (
                  <div className="space-y-1">
                    {picked.map((p) => (
                      <div key={p.id} className="flex items-center justify-between rounded bg-white px-2 py-1 text-[12px]">
                        <span className="text-[#333]">
                          {p.room_no} <span className="text-[10.5px] text-[#999]">{p.room_type_name}</span>
                        </span>
                        <button onClick={() => toggle(p)} className="text-[11px] text-[#999] hover:text-[#e53935]">
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 底部按钮 */}
            <div className="flex items-center justify-end gap-2 border-t border-[#f0f0f0] px-3 py-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-[2px] border border-[#ddd] bg-white px-4 py-1 text-[12.5px] text-[#555]"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={busy || picked.length === 0}
                className="rounded-[2px] bg-[#3bd943] px-4 py-1 text-[12.5px] text-white hover:bg-[#33cd3b] disabled:opacity-50"
              >
                {busy ? "排房中…" : "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
