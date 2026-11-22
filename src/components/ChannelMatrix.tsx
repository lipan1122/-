"use client";

import { useState, useTransition } from "react";

/** 渠道矩阵客户端组件：日期切换、超售开关、房型搜索都无需刷新页面 */
export type MatrixChannel = { type: string; label: string; tone: string };
export type MatrixRow = {
  roomTypeId: number;
  roomTypeName: string;
  total: number;
  cells: { day: string; left: number }[];
};

export function ChannelMatrix({
  channels,
  rows,
  dates,
  today,
  oversell,
  onToggleOversell,
}: {
  channels: MatrixChannel[];
  rows: MatrixRow[];
  dates: string[];
  today: string;
  oversell: Record<string, boolean>;
  onToggleOversell: (type: string, next: boolean) => Promise<void>;
}) {
  const [localOversell, setLocalOversell] = useState<Record<string, boolean>>(oversell);
  const [filter, setFilter] = useState("");
  const [pending, startTransition] = useTransition();

  const shown = filter.trim()
    ? rows.filter((r) => r.roomTypeName.includes(filter.trim()))
    : rows;

  const toggle = (type: string) => {
    const next = !localOversell[type];
    setLocalOversell((prev) => ({ ...prev, [type]: next }));
    startTransition(async () => {
      await onToggleOversell(type, next);
    });
  };

  return (
    <div className="space-y-2">
      {/* 房型即时筛选 */}
      <div className="flex items-center gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="实时筛选房型名称（输入即过滤，不刷新页面）"
          className="input h-7 w-[280px]"
        />
        {filter && (
          <button onClick={() => setFilter("")} className="text-[11.5px] text-[#999] hover:text-[#e53935]">
            清除
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-[#999]">
          共 {rows.length} 个房型 · 显示 {shown.length} 个
          {pending && <span className="ml-1 text-[#2a9d5c]">保存中…</span>}
        </span>
      </div>

      <div className="overflow-auto rounded-[3px] border border-[#e5e5e5] bg-white">
        <table className="w-full min-w-max border-collapse">
          <thead>
            <tr className="bg-[#fafafa]">
              <th className="sticky left-0 z-10 min-w-[260px] border-b border-r border-[#eee] bg-[#fafafa] px-2 py-2 text-left text-[12px] font-medium text-[#555]">
                房型名称
              </th>
              {dates.map((d) => {
                const dt = new Date(`${d}T00:00:00`);
                const isToday = d === today;
                return (
                  <th
                    key={d}
                    className={`min-w-[86px] border-b border-r border-[#eee] px-1 py-1.5 text-center text-[11.5px] font-normal ${
                      isToday ? "text-[#2a9d3a]" : "text-[#555]"
                    }`}
                  >
                    <div className={isToday ? "font-semibold" : ""}>{isToday ? "今天" : d.slice(5)}</div>
                    <div className="text-[11px] text-[#999]">
                      周{["日", "一", "二", "三", "四", "五", "六"][dt.getDay()]}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((rt) => (
              <RowGroup key={rt.roomTypeId} row={rt} channels={channels} dates={dates} oversell={localOversell} onToggle={toggle} />
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={dates.length + 1} className="px-3 py-12 text-center text-[12px] text-[#999]">
                  没有匹配的房型
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowGroup({
  row,
  channels,
  dates,
  oversell,
  onToggle,
}: {
  row: MatrixRow;
  channels: MatrixChannel[];
  dates: string[];
  oversell: Record<string, boolean>;
  onToggle: (type: string) => void;
}) {
  const leftOf = (day: string) => row.cells.find((c) => c.day === day)?.left ?? 0;
  return (
    <>
      <tr className="bg-[#fbfdfb]">
        <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-[#fbfdfb] px-2 py-1.5 text-[12px]">
          <span className="mr-1 rounded-[2px] bg-[#52c41a] px-1 text-[10px] text-white">去呼呼</span>
          <span className="font-medium text-[#222]">{row.roomTypeName}</span>
          <span className="ml-1 text-[11px] text-[#999]">（共 {row.total} 间）</span>
        </td>
        {dates.map((d) => {
          const left = leftOf(d);
          return (
            <td
              key={d}
              className={`border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums ${
                left === 0 ? "font-semibold text-[#e53935]" : "text-[#333]"
              }`}
            >
              剩{left}
            </td>
          );
        })}
      </tr>
      {channels.map((c) => {
        const on = Boolean(oversell[c.type]);
        return (
          <tr key={`${row.roomTypeId}-${c.type}`} className="hover:bg-[#fafcfb]">
            <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-white px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className={`rounded-[2px] px-1 text-[10.5px] ${c.tone}`}>{c.label}</span>
                <span className="truncate text-[11.5px] text-[#555]">{row.roomTypeName}（含早/不含早）</span>
                <button
                  type="button"
                  onClick={() => onToggle(c.type)}
                  title={on ? "点击关闭该渠道超售" : "点击开启该渠道超售"}
                  className={`ml-1 shrink-0 cursor-pointer rounded-[2px] px-1 text-[10px] transition-colors ${
                    on
                      ? "bg-[#fff1f1] text-[#e53935] hover:bg-[#ffe0e0]"
                      : "bg-[#f5f5f5] text-[#999] hover:bg-[#e8f5e9] hover:text-[#2a9d5c]"
                  }`}
                >
                  {on ? "已开超售" : "未开超售"}
                </button>
              </div>
            </td>
            {dates.map((d) => {
              const left = leftOf(d);
              return (
                <td
                  key={d}
                  className={`border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums ${
                    left === 0 ? "font-semibold text-[#e53935]" : "text-[#333]"
                  }`}
                >
                  剩{left}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
