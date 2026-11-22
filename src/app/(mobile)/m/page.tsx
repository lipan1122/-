import Link from "next/link";
import { get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 员工移动端工作台（F13）
 *
 * 目标：店长/前台掏手机能 3 秒看到「今天要干什么、哪里出事了」。
 * 不是把桌面工作台等比缩小——桌面那套 KPI 卡在手机上要横滑，没法用。
 *
 * 结构：
 *   1. 顶部：营业日 + 身份 + 待办数字
 *   2. 大按钮区：最常用的 4 个动作（入住/退房/看房态/打扫）
 *   3. 预警区：只显示有问题的
 *   4. 今日概览：3 个关键数字
 */

type Stats = {
  total: number;
  occupied: number;
  vc: number;
  vd: number;
  arrivals: number;
  departures: number;
  revenue: number;
  debt_count: number;
  debt_amount: number;
  hk_pending: number;
  overdue: number;
};

export default async function MobileHomePage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = bizToday(hotelId);
  const sp = await searchParams;

  /*
   * P2-26f：布局层越权时 redirect("/m?err=…")，但本页原来不读 err，
   * 用户被弹回来却看不到原因。这里把它渲染成顶部提示条。
   */
  const errMsg = typeof sp.err === "string" ? sp.err.trim() : "";

  const s =
    get<Stats>(
      `SELECT
         (SELECT COUNT(*) FROM rooms WHERE hotel_id = ?) AS total,
         (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status IN ('OC','OD')) AS occupied,
         (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'VC') AS vc,
         (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'VD') AS vd,
         (SELECT COUNT(*) FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED')) AS arrivals,
         (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND expect_check_out = ? AND status = 'INHOUSE') AS departures,
         (SELECT COALESCE(SUM(amount),0) FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type IN ('ROOM','FOOD','OTHER')) AS revenue,
         (SELECT COUNT(*) FROM stays st JOIN folios f ON f.stay_id = st.id
           WHERE st.hotel_id = ? AND st.status = 'INHOUSE' AND f.balance > 0.01) AS debt_count,
         (SELECT COALESCE(SUM(f.balance),0) FROM stays st JOIN folios f ON f.stay_id = st.id
           WHERE st.hotel_id = ? AND st.status = 'INHOUSE' AND f.balance > 0.01) AS debt_amount,
         (SELECT COUNT(*) FROM housekeeping WHERE hotel_id = ? AND status IN ('PENDING','DOING')) AS hk_pending,
         (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out < ?) AS overdue`,
      [
        hotelId, hotelId, hotelId, hotelId,
        hotelId, today, hotelId, today,
        hotelId, today,
        hotelId, hotelId,
        hotelId, hotelId, today,
      ]
    ) ?? {
      total: 0, occupied: 0, vc: 0, vd: 0, arrivals: 0, departures: 0,
      revenue: 0, debt_count: 0, debt_amount: 0, hk_pending: 0, overdue: 0,
    };

  const occupancy = s.total > 0 ? Math.round((s.occupied / s.total) * 100) : 0;

  /* 预警：只收「今天该处理」的，且只在有值时显示 */
  const alerts: { key: string; text: string; href: string; tone: "red" | "amber" }[] = [];
  if (s.overdue > 0) alerts.push({ key: "overdue", text: `${s.overdue} 间逾期未离店`, href: "/m/rooms?filter=overdue", tone: "amber" });
  if (s.debt_count > 0) alerts.push({ key: "debt", text: `${s.debt_count} 间欠费 合计 ${fmtMoney(s.debt_amount)}`, href: "/m/cashier", tone: "red" });
  if (s.vd > 0) alerts.push({ key: "vd", text: `${s.vd} 间空脏待打扫`, href: "/m/housekeeping", tone: "amber" });

  const actions = [
    { href: "/m/rooms", label: "房态", sub: `${s.vc + s.vd} 空可排`, cls: "bg-[#1e8e3e]" },
    { href: "/m/checkin", label: "办入住", sub: `${s.arrivals} 待入`, cls: "bg-[#2f80ed]" },
    { href: "/m/cashier", label: "去退房", sub: `${s.departures} 预离`, cls: "bg-[#e8a33d]" },
    { href: "/m/housekeeping", label: "打扫", sub: `${s.hk_pending} 待办`, cls: "bg-[#7c6bd6]" },
  ];

  return (
    <div className="mx-auto max-w-[520px]">
      {/* 顶部 */}
      <div className="bg-gradient-to-br from-[#1e8e3e] to-[#14a3a4] px-4 pb-4 pt-3 text-white">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] text-white/70">营业日 {today}</div>
            <div className="mt-0.5 text-[16px] font-semibold">
              {user.realName}
              <span className="ml-1.5 text-[11px] font-normal text-white/70">
                {user.role === "admin" ? "管理员" : user.role === "frontdesk" ? "前台" : user.role === "cashier" ? "收银" : "客房"}
              </span>
            </div>
          </div>
          <Link
            href="/dashboard"
            prefetch={false}
            className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] text-white"
          >
            电脑版
          </Link>
        </div>

        <div className="mt-3 flex items-end gap-4">
          <div>
            <div className="text-[26px] font-bold leading-none tabular-nums">{occupancy}%</div>
            <div className="mt-0.5 text-[10.5px] text-white/70">
              出租率 {s.occupied}/{s.total}
            </div>
          </div>
          <div>
            <div className="text-[20px] font-semibold leading-none tabular-nums">{fmtMoney(s.revenue)}</div>
            <div className="mt-0.5 text-[10.5px] text-white/70">今日营收</div>
          </div>
        </div>
      </div>

      {/* 越权/错误提示（P2-26f） */}
      {errMsg && (
        <div className="mx-3 mt-3 flex items-start justify-between gap-2 rounded-[6px] border border-[#f5c2c2] bg-[#fdf3f3] px-3 py-2">
          <span role="alert" className="min-w-0 flex-1 text-[12px] leading-[18px] text-[#c0392b]">
            {errMsg}
          </span>
          <Link href="/m" prefetch={false} className="shrink-0 text-[11px] text-[#8b949e]">
            关闭
          </Link>
        </div>
      )}

      {/* 大按钮区 */}
      <div className="grid grid-cols-2 gap-2.5 px-3 py-3">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            prefetch={false}
            className={`${a.cls} flex h-[72px] flex-col items-center justify-center rounded-[8px] text-white shadow-sm active:opacity-90`}
          >
            <span className="text-[15px] font-semibold">{a.label}</span>
            <span className="mt-0.5 text-[11px] text-white/80">{a.sub}</span>
          </Link>
        ))}
      </div>

      {/* 预警 */}
      {alerts.length > 0 && (
        <div className="mx-3 mb-3 overflow-hidden rounded-[8px] bg-white">
          <div className="border-b border-[#f0f0f0] px-3 py-2 text-[12px] font-semibold text-[#b07d2e]">
            待处理 · {alerts.length} 项
          </div>
          {alerts.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              prefetch={false}
              className="flex items-center gap-2 px-3 py-2.5 active:bg-[#f7f7f7]"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.tone === "red" ? "bg-[#d9534f]" : "bg-[#e8a33d]"}`}
              />
              <span className="flex-1 text-[12.5px] text-gray-700">{a.text}</span>
              <span className="text-[11px] text-[#8b949e]">处理 ›</span>
            </Link>
          ))}
        </div>
      )}

      {/* 今日概览 */}
      <div className="mx-3 mb-3 grid grid-cols-3 gap-2">
        {[
          { label: "预抵", value: s.arrivals, href: "/m/checkin" },
          { label: "预离", value: s.departures, href: "/m/cashier" },
          { label: "空脏", value: s.vd, href: "/m/housekeeping" },
        ].map((k) => (
          <Link
            key={k.label}
            href={k.href}
            prefetch={false}
            className="rounded-[8px] bg-white py-3 text-center active:bg-[#f7f7f7]"
          >
            <div className="text-[19px] font-semibold leading-none tabular-nums text-gray-900">{k.value}</div>
            <div className="mt-1 text-[10.5px] text-[#8b949e]">{k.label}</div>
          </Link>
        ))}
      </div>

      <div className="px-3 pb-4 text-center text-[10.5px] text-[#b0b8bf]">
        员工移动端 · 完整功能请用电脑版
      </div>
    </div>
  );
}
