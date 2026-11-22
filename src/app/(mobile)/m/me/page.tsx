import Link from "next/link";
import { get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { ROLE_LABEL } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 移动端「我的」（F13）
 *
 * 放三样东西：
 *   1. 我是谁（身份、班次、营业日）
 *   2. 我的待办（按角色给不同入口）
 *   3. 交班 + 退出
 */

export default async function MobileMePage() {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = bizToday(hotelId);

  /* 我的未交班记录 */
  const openShift = get<{ id: number; shift_name: string; start_at: string; opening_cash: number }>(
    `SELECT id, shift_name, start_at, COALESCE(opening_cash,0) AS opening_cash
       FROM shifts WHERE hotel_id = ? AND operator = ? AND status = 'OPEN' LIMIT 1`,
    [hotelId, user.realName]
  );

  /*
   * P1-28e：当前班次一律读真实开班记录。
   * 原来用墙上时钟猜「早班/中班/夜班」，跟同页「我的班次」里的 openShift.shift_name
   * 自相矛盾（比如 08:10 开班写的是「夜班」，顶部却显示「早班」）。
   */
  const shift = openShift?.shift_name ?? "未开班";

  /* 待办数字（按角色决定查哪些） */
  const stat = get<{
    arrivals: number;
    departures: number;
    debt: number;
    hk: number;
    pending_booking: number;
    unsynced_channel: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED')) AS arrivals,
       (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND expect_check_out = ? AND status = 'INHOUSE') AS departures,
       (SELECT COUNT(*) FROM stays st JOIN folios f ON f.stay_id = st.id
         WHERE st.hotel_id = ? AND st.status = 'INHOUSE' AND f.balance > 0.01) AS debt,
       (SELECT COUNT(*) FROM housekeeping WHERE hotel_id = ? AND status IN ('PENDING','DOING')) AS hk,
       (SELECT COUNT(*) FROM bookings WHERE hotel_id = ? AND status = 'PENDING') AS pending_booking,
       (SELECT COUNT(*) FROM channel_orders WHERE hotel_id = ? AND status = 'NEW') AS unsynced_channel`,
    [hotelId, today, hotelId, today, hotelId, hotelId, hotelId, hotelId]
  ) ?? { arrivals: 0, departures: 0, debt: 0, hk: 0, pending_booking: 0, unsynced_channel: 0 };

  /* 按角色给待办入口 */
  type Item = { href: string; label: string; n: number; unit: string };
  const allItems: Item[] = [
    { href: "/m/checkin", label: "待办入住", n: stat.arrivals, unit: "单" },
    { href: "/m/cashier?filter=dueout", label: "今日预离", n: stat.departures, unit: "间" },
    { href: "/m/cashier?filter=debt", label: "欠费客人", n: stat.debt, unit: "间" },
    { href: "/m/housekeeping", label: "待打扫", n: stat.hk, unit: "间" },
    { href: "/m/orders?status=PENDING", label: "待排房订单", n: stat.pending_booking, unit: "单" },
    { href: "/channel-orders", label: "待接渠道单", n: stat.unsynced_channel, unit: "条" },
  ];

  const roleItems: Record<string, string[]> = {
    admin: ["/m/checkin", "/m/cashier?filter=dueout", "/m/cashier?filter=debt", "/m/housekeeping", "/m/orders?status=PENDING", "/channel-orders"],
    frontdesk: ["/m/checkin", "/m/cashier?filter=dueout", "/m/housekeeping", "/m/orders?status=PENDING"],
    cashier: ["/m/cashier?filter=dueout", "/m/cashier?filter=debt"],
    housekeeping: ["/m/housekeeping"],
  };
  const items = allItems.filter((i) => (roleItems[user.role] ?? roleItems.frontdesk).includes(i.href));

  return (
    <div className="mx-auto max-w-[520px]">
      {/* 身份卡 */}
      <div className="bg-gradient-to-br from-[#1e8e3e] to-[#14a3a4] px-4 pb-5 pt-4 text-white">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/20 text-[18px] font-semibold">
            {user.realName.slice(0, 1)}
          </div>
          <div className="flex-1">
            <div className="text-[17px] font-semibold">{user.realName}</div>
            <div className="mt-0.5 text-[11.5px] text-white/75">
              {ROLE_LABEL[user.role] ?? user.role} · {user.hotelName}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-4 text-[11.5px] text-white/85">
          <span>营业日 {today}</span>
          <span>当前班次 {shift}</span>
        </div>
      </div>

      {/* 待办 */}
      <div className="mx-3 mt-3 overflow-hidden rounded-[8px] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[12px] font-semibold text-gray-700">我的待办</div>
        {items.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-[#8b949e]">暂无待办</div>}
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            prefetch={false}
            className="flex items-center gap-2 px-3 py-2.5 active:bg-[#f7f7f7]"
          >
            <span className="flex-1 text-[13px] text-gray-700">{it.label}</span>
            <span
              className={`text-[13px] font-semibold tabular-nums ${it.n > 0 ? "text-[#d9534f]" : "text-[#b0b8bf]"}`}
            >
              {it.n}
            </span>
            <span className="w-5 text-[10.5px] text-[#b0b8bf]">{it.unit}</span>
            <span className="text-[11px] text-[#c4c9ce]">›</span>
          </Link>
        ))}
      </div>

      {/* 交班 */}
      <div className="mx-3 mt-3 overflow-hidden rounded-[8px] bg-white">
        <div className="border-b border-[#f0f0f0] px-3 py-2 text-[12px] font-semibold text-gray-700">我的班次</div>
        {openShift ? (
          <Link href="/handover" prefetch={false} className="flex items-center gap-2 px-3 py-3 active:bg-[#f7f7f7]">
            <div className="flex-1">
              <div className="text-[13px] text-gray-800">
                {openShift.shift_name}进行中
                <span className="ml-1.5 text-[11px] text-[#8b949e]">
                  开班 {openShift.start_at.slice(11, 16)}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-[#8b949e]">备用金 ¥{Number(openShift.opening_cash).toFixed(2)}</div>
            </div>
            <span className="rounded-[4px] bg-[#e8f5ec] px-2 py-1 text-[11.5px] text-[#1e8e3e]">去交班</span>
          </Link>
        ) : (
          <Link href="/handover" prefetch={false} className="flex items-center gap-2 px-3 py-3 active:bg-[#f7f7f7]">
            <div className="flex-1">
              <div className="text-[13px] text-gray-800">尚未开班</div>
              <div className="mt-0.5 text-[11px] text-[#8b949e]">开班后才能记录本班次的收款</div>
            </div>
            <span className="rounded-[4px] border border-[#dcdcdc] px-2 py-1 text-[11.5px] text-gray-600">去开班</span>
          </Link>
        )}
      </div>

      {/* 其他入口 */}
      <div className="mx-3 mt-3 overflow-hidden rounded-[8px] bg-white">
        {[
          { href: "/m/rooms", label: "房态一览" },
          { href: "/m/orders", label: "订单列表" },
          { href: "/mobile-housekeeping", label: "客房任务（大按钮版）" },
          { href: "/dashboard", label: "切换到电脑版" },
        ].map((l) => (
          <Link
            key={l.href}
            href={l.href}
            prefetch={false}
            className="flex items-center gap-2 border-b border-[#f5f5f5] px-3 py-2.5 last:border-0 active:bg-[#f7f7f7]"
          >
            <span className="flex-1 text-[13px] text-gray-700">{l.label}</span>
            <span className="text-[11px] text-[#c4c9ce]">›</span>
          </Link>
        ))}
      </div>

      {/* 退出 */}
      <div className="mx-3 mt-3 overflow-hidden rounded-[8px] bg-white">
        <a
          href="/logout"
          className="block px-3 py-3 text-center text-[13.5px] font-medium text-[#d9534f] active:bg-[#fdf3f3]"
        >
          退出登录
        </a>
      </div>

      <div className="px-3 py-5 text-center text-[10.5px] text-[#b0b8bf]">
        员工移动端 · 数据与电脑版实时同步
      </div>
    </div>
  );
}
