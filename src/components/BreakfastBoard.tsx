"use client";

import { useState, useTransition } from "react";

export type BreakfastRow = {
  roomNo: string;
  guestName: string | null;
  breakfast: number;
  used: number;
};

/** 餐券核销（客户端：点核销即时变状态，不刷新页面） */
export function BreakfastBoard({
  rows,
  rooms,
  verify,
  buy,
}: {
  rows: BreakfastRow[];
  rooms: { roomNo: string; guestName: string | null }[];
  verify: (roomNo: string) => Promise<void>;
  buy: (roomNo: string, qty: number) => Promise<void>;
}) {
  const [local, setLocal] = useState(rows);
  const [filter, setFilter] = useState("");
  const [pending, startTransition] = useTransition();
  const [tip, setTip] = useState("");

  const shown = filter.trim() ? local.filter((r) => r.roomNo.includes(filter.trim())) : local;

  const doVerify = (roomNo: string) => {
    setLocal((prev) =>
      prev.map((r) => (r.roomNo === roomNo ? { ...r, used: r.breakfast } : r))
    );
    setTip(`房间 ${roomNo} 已核销 ${local.find((r) => r.roomNo === roomNo)?.breakfast ?? 0} 份`);
    startTransition(async () => {
      await verify(roomNo);
    });
  };

  const doBuy = (roomNo: string) => {
    setLocal((prev) => prev.map((r) => (r.roomNo === roomNo ? { ...r, breakfast: r.breakfast + 1 } : r)));
    setTip(`房间 ${roomNo} 已购买 1 份早餐`);
    startTransition(async () => {
      await buy(roomNo, 1);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
        <span className="text-[12px] text-[#555]">房间号:</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="输入房号即时筛选"
          className="input h-7 w-[160px] text-[12px]"
        />
        <span className="text-[11.5px] text-[#999]">
          在住 {local.length} 间 · 显示 {shown.length} 间
          {pending && <span className="ml-1 text-[#2a9d5c]">保存中…</span>}
        </span>
        {tip && <span className="ml-auto text-[11.5px] text-[#2a9d5c]">{tip}</span>}
        <details className="relative ml-auto">
          <summary className="cursor-pointer list-none rounded-[3px] bg-[#3bd943] px-3 py-1 text-[12px] text-white hover:bg-[#33cd3b] [&::-webkit-details-marker]:hidden">
            购买早餐
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-[260px] rounded border border-[#e5e5e5] bg-white p-2 shadow-lg">
            <div className="mb-1 text-[11.5px] text-[#666]">选择房间后点击购买，立刻 +1 份</div>
            <div className="max-h-[220px] space-y-1 overflow-y-auto">
              {rooms.map((r) => (
                <button
                  key={r.roomNo}
                  onClick={() => doBuy(r.roomNo)}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-[12px] hover:bg-[#f5f5f5]"
                >
                  <span>
                    {r.roomNo} {r.guestName ?? ""}
                  </span>
                  <span className="text-[#2a9d5c]">+1</span>
                </button>
              ))}
            </div>
          </div>
        </details>
      </div>

      <div className="overflow-x-auto rounded-[3px] border border-[#e5e5e5] bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#f2faf3]">
              <th className="w-[220px] border-b border-r border-[#e8e8e8] px-3 py-2.5 text-center text-[13px] font-medium text-[#333]">
                房间号
              </th>
              <th className="border-b border-r border-[#e8e8e8] px-3 py-2.5 text-center text-[13px] font-medium text-[#333]">
                早餐数（份）
              </th>
              <th className="border-b border-r border-[#e8e8e8] px-3 py-2.5 text-center text-[13px] font-medium text-[#333]">
                今日已核销
              </th>
              <th className="w-[300px] border-b border-[#e8e8e8] px-3 py-2.5 text-center text-[13px] font-medium text-[#333]">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-12 text-center text-[12px] text-[#999]">
                  没有匹配的在住房间
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const done = r.used >= r.breakfast && r.breakfast > 0;
              return (
                <tr key={r.roomNo} className="border-b border-[#f5f5f5] hover:bg-[#fafcfb]">
                  <td className="px-3 py-3 text-center text-[13px] text-[#222]">
                    {r.roomNo}
                    <span className="ml-1 text-[11px] text-[#999]">{r.guestName ?? ""}</span>
                  </td>
                  <td className="px-3 py-3 text-center text-[13px] tabular-nums text-[#333]">{r.breakfast}</td>
                  <td className="px-3 py-3 text-center text-[13px] tabular-nums">
                    {r.used > 0 ? (
                      <span className="text-[#2a9d5c]">{r.used}</span>
                    ) : (
                      <span className="text-[#bbb]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => doVerify(r.roomNo)}
                        disabled={r.breakfast === 0}
                        className={`rounded-[3px] px-3 py-1 text-[12px] text-white ${
                          done || r.breakfast === 0
                            ? "bg-[#c8c8c8]"
                            : "bg-[#32c141] hover:bg-[#2bb038]"
                        }`}
                      >
                        {done ? "已核销" : "核销"}
                      </button>
                      <button
                        onClick={() => doBuy(r.roomNo)}
                        className="rounded-[3px] bg-[#32c141] px-3 py-1 text-[12px] text-white hover:bg-[#2bb038]"
                      >
                        购买早餐
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
