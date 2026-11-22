import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { PrintButton } from "@/components/CashierPanel";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

type StayRow = {
  id: number;
  stay_no: string;
  guest_name: string;
  mobile: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  actual_check_out: string | null;
  nights: number | null;
  rate: number;
  deposit: number | null;
  guest_count: number | null;
  status: string;
  remark: string | null;
  pay_type: string | null;
  invoice_party: string | null;
  room_no: string;
  room_type_name: string | null;
  channel_name: string | null;
  folio_id: number | null;
  folio_no: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  balance: number | null;
  folio_status: string | null;
  settled_at: string | null;
};

type ItemRow = {
  id: number;
  item_type: string;
  description: string | null;
  qty: number | null;
  price: number | null;
  amount: number | null;
  biz_date: string | null;
};

type PayRow = {
  id: number;
  pay_no: string | null;
  method: string | null;
  amount: number | null;
  biz_date: string | null;
  remark: string | null;
};

const ITEM_LABEL: Record<string, string> = {
  ROOM: "房费",
  FOOD: "餐饮",
  OTHER: "其他",
  DEPOSIT: "押金",
  ADJUST: "调整",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function dateText(value: string | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function stamp(value: string | null | undefined) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export default async function CashierPrintPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const stayId = Number(typeof sp.stay === "string" ? sp.stay : 0) || 0;

  const stay = stayId
    ? get<StayRow>(
        `SELECT s.id, s.stay_no, s.guest_name, s.mobile, s.check_in_time, s.expect_check_out,
                s.actual_check_out, s.nights, s.rate, s.deposit, s.guest_count, s.status, s.remark,
                s.pay_type, s.invoice_party,
                r.room_no, rt.name AS room_type_name, c.name AS channel_name,
                f.id AS folio_id, f.folio_no, f.total_amount, f.paid_amount, f.balance,
                f.status AS folio_status, f.settled_at
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
           LEFT JOIN room_types rt ON rt.id = r.room_type_id
           LEFT JOIN channels c ON c.id = s.channel_id
           LEFT JOIN folios f ON f.stay_id = s.id
          WHERE s.hotel_id = ? AND s.id = ?`,
        [hotelId, stayId]
      )
    : undefined;

  const items =
    stay?.folio_id != null
      ? all<ItemRow>(
          `SELECT id, item_type, description, qty, price, amount, biz_date
             FROM folio_items WHERE folio_id = ? ORDER BY biz_date, id`,
          [stay.folio_id]
        )
      : [];
  const payments =
    stay?.folio_id != null
      ? all<PayRow>(
          `SELECT id, pay_no, method, amount, biz_date, remark
             FROM payments WHERE folio_id = ? ORDER BY id`,
          [stay.folio_id]
        )
      : [];

  const depositSum = items
    .filter((it) => it.item_type === "DEPOSIT")
    .reduce((sum, it) => sum + Number(it.amount ?? 0), 0);
  // 「部分结账」负项是内部已结记录，不计入客人账单明细（否则明细合计与消费合计对不上）
  const printItems = items.filter(
    (it) => !(it.item_type === "ADJUST" && (it.description ?? "").startsWith("【部分结账】"))
  );
  const printedAt = new Date();
  const creditMark = /【挂账】([^；]+)/.exec(stay?.remark ?? "")?.[1] ?? null;

  return (
    <div className="print-overlay fixed inset-0 z-[300] overflow-auto bg-white">
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: #fff; }
          body * { visibility: hidden !important; }
          #print-sheet, #print-sheet * { visibility: visible !important; }
          .print-overlay { position: static !important; overflow: visible !important; height: auto !important; }
          #print-sheet {
            position: absolute; left: 0; top: 0; width: 100%; max-width: none;
            margin: 0; padding: 0; border: 0 !important; box-shadow: none !important;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print mx-auto flex max-w-[860px] flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="text-[12px] text-gray-500">账单打印预览 · A4 竖版</div>
        <div className="flex items-center gap-2">
          <Link
            href={stayId ? `/cashier?stay=${stayId}` : "/cashier"}
            className="inline-flex items-center justify-center rounded border border-gray-300 bg-white px-3 py-1 text-[12px] text-gray-700 hover:border-gray-400"
          >
            返回收银台
          </Link>
          <PrintButton label="打印" />
        </div>
      </div>

      {!stay ? (
        <div className="mx-auto mt-10 max-w-[860px] rounded border border-dashed border-gray-300 px-6 py-16 text-center text-[13px] text-gray-500">
          未找到对应的账单，请从收银台重新选择客人后打印。
        </div>
      ) : (
        <div
          id="print-sheet"
          className="mx-auto mb-10 max-w-[860px] border border-gray-200 bg-white px-8 py-7 text-[12px] leading-6 text-gray-900 shadow-sm"
        >
          {/* 抬头 */}
          <div className="flex items-start justify-between gap-6 border-b-2 border-gray-800 pb-3">
            <div>
              <div className="text-[18px] font-semibold tracking-wide">{user.hotelName}</div>
              <div className="mt-0.5 text-[12px] text-gray-600">结账账单 / 消费明细</div>
            </div>
            <div className="text-right text-[11px] leading-5 text-gray-700">
              <div>账单号：{stay.folio_no ?? "-"}</div>
              <div>入住单号：{stay.stay_no}</div>
              <div>打印时间：{stamp(printedAt.toISOString())}</div>
            </div>
          </div>

          {/* 客人 / 房间信息 */}
          <div className="mt-3 grid grid-cols-3 gap-x-6 gap-y-1 text-[12px]">
            <div>
              房号：<b>{stay.room_no}</b>
            </div>
            <div>房型：{stay.room_type_name ?? "-"}</div>
            <div>客人：{stay.guest_name}</div>
            <div>手机：{stay.mobile ?? "-"}</div>
            <div>入住：{dateText(stay.check_in_time)}</div>
            <div>离店：{stay.actual_check_out ?? stay.expect_check_out ?? "-"}</div>
            <div>晚数：{stay.nights ?? 0} 晚</div>
            <div>房价：{fmtMoney(stay.rate)} / 晚</div>
            <div>渠道：{stay.channel_name ?? "散客"}</div>
            <div>收款类型：{stay.pay_type ?? "到店付款"}</div>
            <div>开票方：{stay.invoice_party ?? "酒店"}</div>
            <div>协议单位：{creditMark ?? "-"}</div>
          </div>

          {/* 明细 */}
          <table className="mt-4 w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th className="w-[86px] border-y border-gray-400 py-1.5 text-left font-semibold">营业日</th>
                <th className="border-y border-gray-400 py-1.5 text-left font-semibold">项目</th>
                <th className="w-[48px] border-y border-gray-400 py-1.5 text-right font-semibold">数量</th>
                <th className="w-[80px] border-y border-gray-400 py-1.5 text-right font-semibold">单价</th>
                <th className="w-[90px] border-y border-gray-400 py-1.5 text-right font-semibold">金额</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td className="border-b border-gray-200 py-3 text-center text-gray-400" colSpan={5}>
                    暂无消费明细
                  </td>
                </tr>
              )}
              {printItems.map((it) => (
                <tr key={it.id}>
                  <td className="border-b border-gray-200 py-1.5 tabular-nums">{it.biz_date ?? "-"}</td>
                  <td className="border-b border-gray-200 py-1.5">
                    <span className="mr-1 text-[11px] text-gray-500">[{ITEM_LABEL[it.item_type] ?? it.item_type}]</span>
                    {it.description ?? "-"}
                  </td>
                  <td className="border-b border-gray-200 py-1.5 text-right tabular-nums">
                    {Number(it.qty ?? 0) === 1 ? "1" : String(it.qty ?? "-")}
                  </td>
                  <td className="border-b border-gray-200 py-1.5 text-right tabular-nums">{fmtMoney(it.price)}</td>
                  <td className="border-b border-gray-200 py-1.5 text-right tabular-nums">
                    {fmtMoney(it.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 合计 */}
          <div className="mt-3 flex justify-end">
            <div className="w-[300px] space-y-1 text-[12px]">
              <div className="flex items-center justify-between border-b border-gray-200 pb-1">
                <span className="text-gray-600">消费合计</span>
                <span className="tabular-nums">{fmtMoney(stay.total_amount)}</span>
              </div>
              <div className="flex items-center justify-between border-b border-gray-200 pb-1">
                <span className="text-gray-600">押金 / 预收款</span>
                <span className="tabular-nums">{fmtMoney(depositSum)}</span>
              </div>
              <div className="flex items-center justify-between border-b border-gray-200 pb-1">
                <span className="text-gray-600">已收金额</span>
                <span className="tabular-nums">{fmtMoney(stay.paid_amount)}</span>
              </div>
              <div className="flex items-center justify-between border-b-2 border-gray-800 pb-1 text-[13px] font-semibold">
                <span>应收余额</span>
                <span className="tabular-nums">{fmtMoney(stay.balance)}</span>
              </div>
            </div>
          </div>

          {/* 收款记录 */}
          <div className="mt-4">
            <div className="mb-1 text-[12px] font-semibold">收款记录</div>
            {payments.length === 0 ? (
              <div className="text-[11px] text-gray-500">暂无收款记录</div>
            ) : (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr>
                    <th className="w-[92px] border-y border-gray-300 py-1 text-left font-medium text-gray-600">
                      营业日
                    </th>
                    <th className="w-[70px] border-y border-gray-300 py-1 text-left font-medium text-gray-600">
                      方式
                    </th>
                    <th className="w-[96px] border-y border-gray-300 py-1 text-right font-medium text-gray-600">
                      金额
                    </th>
                    <th className="border-y border-gray-300 py-1 pl-3 text-left font-medium text-gray-600">备注</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="border-b border-gray-200 py-1 tabular-nums">{p.biz_date ?? "-"}</td>
                      <td className="border-b border-gray-200 py-1">{p.method ?? "-"}</td>
                      <td className="border-b border-gray-200 py-1 text-right tabular-nums">{fmtMoney(p.amount)}</td>
                      <td className="border-b border-gray-200 py-1 pl-3 text-gray-600">
                        {p.remark ?? "-"}
                        {p.pay_no ? ` · ${p.pay_no}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {stay.remark && (
            <div className="mt-3 border-t border-gray-200 pt-2 text-[11px] text-gray-600">备注：{stay.remark}</div>
          )}

          {/* 落款 */}
          <div className="mt-10 flex items-end justify-between text-[11px] text-gray-700">
            <div className="space-y-3">
              <div>收银员：{user.realName}</div>
              <div>酒店（盖章）：____________________</div>
            </div>
            <div className="space-y-3 text-right">
              <div>客人签字：____________________</div>
              <div>打印日期：{stamp(printedAt.toISOString())}</div>
            </div>
          </div>
          <div className="mt-4 border-t border-dashed border-gray-300 pt-2 text-center text-[10px] text-gray-400">
            本账单由 {user.hotelName} PMS 系统生成 · 请妥善保管，退房后如需开票请出示本账单
          </div>
        </div>
      )}
    </div>
  );
}
