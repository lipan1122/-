import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, fmtMoney, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "revenue", label: "客户端营收" },
  { key: "rooms", label: "客户端房态" },
  { key: "guests", label: "客户端客人列表" },
  { key: "shift", label: "客户端交班" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

type Search = { tab?: string };

import Link from "next/link";

export default async function AppClientPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const tab: TabKey = (TABS.some((t) => t.key === sp.tab) ? sp.tab : "revenue") as TabKey;
  const today = todayStr();
  const monthAgo = todayStr(addDays(today, -29));

  /* ---------- 客户端营收：按日统计小程序/APP 订单 ---------- */
  const revenue = all<{ day: string; orders: number; amount: number | null }>(
    `SELECT b.check_in_date AS day, COUNT(*) AS orders, COALESCE(SUM(b.rate * COALESCE(b.nights, 1) * COALESCE(b.room_count, 1)), 0) AS amount
     FROM bookings b
     WHERE b.hotel_id = ? AND b.check_in_date BETWEEN ? AND ?
     GROUP BY b.check_in_date ORDER BY b.check_in_date DESC`,
    [hotelId, monthAgo, today]
  );
  const revenueTotal = revenue.reduce((a, r) => a + Number(r.amount ?? 0), 0);

  /* ---------- 客户端房态 ---------- */
  const roomStats = all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM rooms WHERE hotel_id = ? GROUP BY status`,
    [hotelId]
  );
  const roomTotal = roomStats.reduce((a, r) => a + Number(r.n ?? 0), 0);
  const statusLabel: Record<string, string> = {
    VC: "空净",
    VD: "空脏",
    OC: "住净",
    OD: "住脏",
    OOO: "维修",
    LOCK: "锁房",
  };

  /* ---------- 客户端客人列表（在住） ---------- */
  const guests = all<{
    room_no: string;
    guest_name: string | null;
    mobile: string | null;
    expect_check_out: string | null;
    rate: number | null;
  }>(
    `SELECT r.room_no, s.guest_name, s.mobile, s.expect_check_out, s.rate
     FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE' ORDER BY r.room_no`,
    [hotelId]
  );

  /* ---------- 客户端交班 ---------- */
  const shift = get<{ consume: number | null; receipt: number | null; cnt: number | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN item_type <> 'PAYMENT' THEN amount ELSE 0 END), 0) AS consume,
       COALESCE(SUM(CASE WHEN item_type = 'PAYMENT' THEN amount ELSE 0 END), 0) AS receipt,
       COUNT(*) AS cnt
     FROM folio_items WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  );
  const payments = all<{ method: string | null; n: number; amount: number | null }>(
    `SELECT COALESCE(method, '未填') AS method, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
     FROM payments WHERE hotel_id = ? AND date(created_at, 'localtime') = ?
     GROUP BY method ORDER BY amount DESC`,
    [hotelId, today]
  );

  return (
    <div className="space-y-3 p-4">
      <h1 className="text-[16px] font-semibold text-[#222]">APP/小程序客户端</h1>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/app-client?tab=${t.key}`}
            className={`rounded-[2px] px-3 py-1 text-[12px] ${
              tab === t.key ? "bg-[#3bd943] text-white" : "border border-[#e5e5e5] bg-white text-[#555]"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "revenue" && (
        <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
          <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-medium text-[#333]">
            近 30 天 · 订单 {revenue.reduce((a, r) => a + Number(r.orders), 0)} 笔 · 合计 {fmtMoney(revenueTotal)}
          </div>
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-[#fafafa]">
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">日期</th>
                <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">订单数</th>
                <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">营收</th>
              </tr>
            </thead>
            <tbody>
              {revenue.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-10 text-center text-[12px] text-[#999]">
                    近 30 天暂无订单
                  </td>
                </tr>
              )}
              {revenue.map((r) => (
                <tr key={r.day} className="border-t border-[#f5f5f5]">
                  <td className="px-3 py-2 text-[12px] tabular-nums text-[#333]">{r.day}</td>
                  <td className="px-3 py-2 text-right text-[12px] tabular-nums">{r.orders}</td>
                  <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {tab === "rooms" && (
        <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
          <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-medium text-[#333]">
            房间总数 {roomTotal} 间
          </div>
          <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-6">
            {roomStats.map((r) => (
              <div key={r.status} className="rounded border border-[#eee] p-2 text-center">
                <div className="text-[12px] text-[#888]">{statusLabel[r.status] ?? r.status}</div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-[#222]">{r.n}</div>
                <div className="text-[10.5px] text-[#999]">
                  {roomTotal > 0 ? `${((Number(r.n) / roomTotal) * 100).toFixed(1)}%` : "0%"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "guests" && (
        <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
          <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-medium text-[#333]">
            在住客人 {guests.length} 位
          </div>
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-[#fafafa]">
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">房号</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">客人</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">手机</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">离店日期</th>
                <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">房价</th>
              </tr>
            </thead>
            <tbody>
              {guests.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-[12px] text-[#999]">
                    暂无在住客人
                  </td>
                </tr>
              )}
              {guests.map((g) => (
                <tr key={g.room_no} className="border-t border-[#f5f5f5]">
                  <td className="px-3 py-2 text-[12px] text-[#222]">{g.room_no}</td>
                  <td className="px-3 py-2 text-[12px] text-[#333]">{g.guest_name ?? "—"}</td>
                  <td className="px-3 py-2 text-[12px] tabular-nums text-[#666]">{g.mobile ?? "—"}</td>
                  <td className="px-3 py-2 text-[12px] tabular-nums text-[#666]">{g.expect_check_out ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(g.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {tab === "shift" && (
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
              <div className="text-[12px] text-[#888]">消费合计</div>
              <div className="text-[18px] font-semibold tabular-nums text-[#222]">{fmtMoney(shift?.consume ?? 0)}</div>
            </div>
            <div className="rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
              <div className="text-[12px] text-[#888]">收款合计</div>
              <div className="text-[18px] font-semibold tabular-nums text-[#222]">{fmtMoney(shift?.receipt ?? 0)}</div>
            </div>
            <div className="rounded-[3px] border border-[#e5e5e5] bg-white px-3 py-2">
              <div className="text-[12px] text-[#888]">账务笔数</div>
              <div className="text-[18px] font-semibold tabular-nums text-[#222]">{shift?.cnt ?? 0}</div>
            </div>
          </div>
          <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
            <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-medium text-[#333]">
              今日收款方式拆分 · {today}
            </div>
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#fafafa]">
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">支付方式</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">笔数</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">金额</th>
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-10 text-center text-[12px] text-[#999]">
                      今日暂无收款
                    </td>
                  </tr>
                )}
                {payments.map((p) => (
                  <tr key={p.method} className="border-t border-[#f5f5f5]">
                    <td className="px-3 py-2 text-[12px] text-[#333]">{p.method}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{p.n}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
