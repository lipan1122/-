"use client";

import { Fragment, useState } from "react";
import OrderListDialog, { type OrderListCell } from "@/components/OrderListDialog";

export type PredictRow = {
  typeId: number;
  typeName: string;
  total: number;
  cells: { day: string; sellable: number; occupied: number; adr: number; revpar: number; rate: number }[];
};

export type PredictTotal = { day: string; sellable: number; occupied: number; occRate: number; adr: number; revpar: number };

/** 房型可售预测（客户端：显示项复选框即时生效，不刷新页面） */
export function PredictTable({
  rows,
  totals,
  dates,
  today,
  showOcc = true,
  showAdr = true,
  orderCells = [],
  typeNames = {},
}: {
  rows: PredictRow[];
  totals: PredictTotal[];
  dates: string[];
  today: string;
  showOcc?: boolean;
  /** 点「占用」弹出的当天订单明细 */
  orderCells?: OrderListCell[];
  typeNames?: Record<number, string>;
  showAdr?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [orderCell, setOrderCell] = useState<{ typeId: number; day: string } | null>(null);

  const shown = filter.trim() ? rows.filter((r) => r.typeName.includes(filter.trim())) : rows;

  const cellOf = (row: PredictRow, day: string) => row.cells.find((c) => c.day === day);

  return (
    <div className="space-y-2">
      {/* 即时筛选（显示项在上方表单里切换） */}
      <div className="flex items-center gap-2 rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="即时筛选房型（输入即过滤）"
          className="input h-7 w-[220px] text-[12px]"
        />
        {filter && (
          <button onClick={() => setFilter("")} className="text-[11.5px] text-[#999] hover:text-[#e53935]">
            清除
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-[#999]">
          共 {rows.length} 个房型 · 显示 {shown.length} 个
        </span>
      </div>

      <div className="overflow-auto rounded-[3px] border border-[#e5e5e5] bg-white">
        <table className="w-full min-w-max border-collapse">
          <thead>
            <tr className="bg-[#fafafa]">
              <th className="sticky left-0 z-10 min-w-[200px] border-b border-r border-[#eee] bg-[#fafafa] px-2 py-2 text-left text-[12px] font-medium text-[#555]">
                房型（总房量{rows.reduce((a, r) => a + r.total, 0)}）
              </th>
              {dates.map((d) => {
                const dt = new Date(`${d}T00:00:00`);
                const isToday = d === today;
                return (
                  <th
                    key={d}
                    colSpan={2}
                    className={`min-w-[120px] border-b border-r border-[#eee] px-1 py-1 text-center text-[12px] font-normal ${
                      isToday ? "text-[#e60012]" : "text-[#333]"
                    }`}
                  >
                    {d.slice(5)} 星期{["日", "一", "二", "三", "四", "五", "六"][dt.getDay()]}
                    {isToday ? " 今天" : ""}
                    <div className="mt-0.5 flex justify-center gap-6 text-[12px] text-[#666]">
                      <span>可卖</span>
                      <span>{showOcc ? "占用" : ""}</span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.typeId} className="hover:bg-[#fafcfb]">
                <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-white px-2 py-1.5 text-[12px] text-[#222]">
                  {r.typeName}
                  <span className="ml-1 text-[11px] text-[#999]">（{r.total}）</span>
                </td>
                {dates.map((d) => {
                  const c = cellOf(r, d);
                  const sellable = c?.sellable ?? 0;
                  const occupied = c?.occupied ?? 0;
                  /* 真实页：今天列淡紫底、过去日期列淡绿底 */
                  const dayBg = d === today ? "bg-[#f7f2ff]" : d < today ? "bg-[#f4faf4]" : "";
                  return (
                    <Fragment key={d}>
                      <td
                        key={`${d}-s`}
                        className={`border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums ${dayBg} ${
                          sellable < 0 ? "text-[#e53935]" : sellable === 0 ? "text-[#f0a020]" : "text-[#2a9d3c]"
                        }`}
                      >
                        {sellable}
                      </td>
                      <td
                        key={`${d}-o`}
                        onClick={occupied > 0 ? () => setOrderCell({ typeId: r.typeId, day: d }) : undefined}
                        title={occupied > 0 ? "点此查看当天占用的客人订单" : undefined}
                        className={`border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums text-[#333] ${dayBg} ${
                          occupied > 0
                            ? "cursor-pointer hover:bg-[#eef9f0] hover:text-[#2a9d3c] hover:underline"
                            : ""
                        }`}
                      >
                        {showOcc ? occupied : "—"}
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={dates.length * 2 + 1} className="px-3 py-12 text-center text-[12px] text-[#999]">
                  没有匹配的房型
                </td>
              </tr>
            )}

            {/* 合计 */}
            <tr className="bg-[#f7f9f8] font-medium">
              <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-[#f7f9f8] px-2 py-1.5 text-[12px] text-[#222]">合计</td>
              {dates.map((d) => {
                const t = totals.find((x) => x.day === d);
                return (
                  <Fragment key={d}>
                    <td key={`${d}-ts`} className="border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums text-[#2a9d3c]">
                      {t?.sellable ?? 0}
                    </td>
                    <td key={`${d}-to`} className="border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums text-[#333]">
                      {showOcc ? t?.occupied ?? 0 : "—"}
                    </td>
                  </Fragment>
                );
              })}
            </tr>

            {/* 出租率 */}
            <tr className="bg-white">
              <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-white px-2 py-1.5 text-[12px] text-[#555]">出租率</td>
              {dates.map((d) => {
                const t = totals.find((x) => x.day === d);
                const rate = t?.occRate ?? 0;
                return (
                  <td
                    key={d}
                    colSpan={2}
                    className={`border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums ${
                      rate >= 90 ? "text-[#2a9d3c]" : rate < 60 ? "text-[#f0a020]" : "text-[#333]"
                    }`}
                  >
                    {rate.toFixed(2)}%
                  </td>
                );
              })}
            </tr>

            {showAdr && (
              <>
                <tr className="bg-white">
                  <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-white px-2 py-1.5 text-[12px] text-[#555]">平均房价(ADR)</td>
                  {dates.map((d) => (
                    <td key={d} colSpan={2} className="border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums text-[#555]">
                      {(totals.find((x) => x.day === d)?.adr ?? 0).toFixed(2)}
                    </td>
                  ))}
                </tr>
                <tr className="bg-white">
                  <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-white px-2 py-1.5 text-[12px] text-[#555]">客房收益(RevPAR)</td>
                  {dates.map((d) => (
                    <td key={d} colSpan={2} className="border-b border-r border-[#eee] px-1 py-1.5 text-center text-[12px] tabular-nums text-[#555]">
                      {(totals.find((x) => x.day === d)?.revpar ?? 0).toFixed(2)}
                    </td>
                  ))}
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <OrderListDialog
        cells={orderCells}
        typeNames={typeNames}
        open={orderCell}
        onClose={() => setOrderCell(null)}
      />
    </div>
  );
}
