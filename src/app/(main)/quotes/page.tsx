import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { deleteQuoteAction, saveQuoteAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  const user = await requireUser();
  const quotes = all<{
    id: number; name: string; room_type_id: number | null; price: number;
    start_date: string | null; end_date: string | null; note: string | null; room_type_name: string | null;
  }>(
    `SELECT q.*, rt.name AS room_type_name FROM quotes q
     LEFT JOIN room_types rt ON rt.id = q.room_type_id
     WHERE q.hotel_id = ? ORDER BY q.id DESC`,
    [user.hotelId]
  );
  const roomTypes = all<{ id: number; name: string; base_price: number }>(
    `SELECT id, name, base_price FROM room_types WHERE hotel_id = ? ORDER BY sort`,
    [user.hotelId]
  );

  return (
    <div className="space-y-3 p-4">
      <div>
        <h1 className="text-[16px] font-bold text-[#333333]">报价管理</h1>
        <p className="mt-[3px] text-[12px] text-[#999999]">按时段设置房型特价，共 {quotes.length} 条报价</p>
      </div>

      <details className="card overflow-hidden">
        <summary className="cursor-pointer list-none select-none px-3 py-2 text-[12px] text-[#32c141] transition-colors hover:bg-[#fafafa] [&::-webkit-details-marker]:hidden">
          ＋ 新增报价
        </summary>
        <form action={saveQuoteAction} className="grid gap-[10px] border-t border-[#eeeeee] px-3 py-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">报价名称 *</label>
            <input name="name" required placeholder="如：国庆标准价" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">房型</label>
            <select name="room_type_id" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]">
              {roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">价格</label>
            <input name="price" type="number" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">开始日期</label>
            <input name="start_date" type="date" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">结束日期</label>
            <input name="end_date" type="date" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">说明</label>
            <input name="note" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
          <div className="md:col-span-3">
            <button className="flex h-[26px] items-center justify-center rounded-[3px] bg-[#32c141] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038]">保存报价</button>
          </div>
        </form>
      </details>

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#fafafa]">
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">报价名称</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">房型</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">价格</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">有效期</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">说明</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-right text-[12px] font-normal text-[#999999]">操作</th>
            </tr>
          </thead>
          <tbody>
            {quotes.length === 0 && (
              <tr>
                <td colSpan={6} className="py-[32px] text-center text-[12px] text-[#999999]">暂无报价</td>
              </tr>
            )}
            {quotes.map((q) => (
              <tr key={q.id} className="h-[34px] transition-colors hover:bg-[#fafafa]">
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] font-medium text-[#333333]">{q.name}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] text-[#666666]">{q.room_type_name ?? "-"}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] tabular-nums text-[#333333]">{fmtMoney(q.price)}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] text-[#666666]">{q.start_date ?? "-"} ~ {q.end_date ?? "-"}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] text-[#666666]">{q.note ?? "-"}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-right">
                  <form action={deleteQuoteAction} className="inline">
                    <input type="hidden" name="id" value={q.id} />
                    <button className="text-[12px] text-[#999999] transition-colors hover:text-[#e05a5a]">删除</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
