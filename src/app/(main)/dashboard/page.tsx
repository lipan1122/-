import Link from "next/link";
import { all, get } from "@/lib/db";
/* 第 4 轮 P1-5：出租率/ADR/RevPAR 统一口径 */
import { bizToday } from "@/lib/biz-date";
import { fmtOccupancy, occupancyMetrics } from "@/lib/metrics";

/** 单行查询别名（店长看板用） */
const one = get;
import { requireUser } from "@/lib/session";
import { fmtMoney, todayStr, BOOKING_STATUS } from "@/lib/utils";
import { loadAlerts } from "./alerts";

export const dynamic = "force-dynamic";

type Stats = {
  total: number; occupied: number; vc: number; vd: number; ooo: number;
  arrivals: number; departures: number; revenue: number; inhouse_guests: number;
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();

  const s = get<Stats>(
    `SELECT
       (SELECT COUNT(*) FROM rooms WHERE hotel_id = ?) AS total,
       (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status IN ('OC','OD')) AS occupied,
       (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'VC') AS vc,
       (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'VD') AS vd,
       (SELECT COUNT(*) FROM rooms WHERE hotel_id = ? AND status = 'OOO') AS ooo,
       (SELECT COUNT(*) FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED')) AS arrivals,
       (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND expect_check_out = ? AND status = 'INHOUSE') AS departures,
       (SELECT COALESCE(SUM(amount),0) FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type IN ('ROOM','FOOD','OTHER')) AS revenue,
       (SELECT COALESCE(SUM(guest_count),0) FROM stays WHERE hotel_id = ? AND status = 'INHOUSE') AS inhouse_guests`,
    [hotelId, hotelId, hotelId, hotelId, hotelId, hotelId, today, hotelId, today, hotelId, today, hotelId]
  )!;

  const arrivals = all<{
    id: number; booking_no: string; guest_name: string; mobile: string;
    room_type_name: string; rate: number; status: string; room_no: string | null;
  }>(
    `SELECT b.id, b.booking_no, b.guest_name, b.mobile, rt.name AS room_type_name, b.rate, b.status,
            r.room_no
     FROM bookings b
     JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN rooms r ON r.id = b.room_id
     WHERE b.hotel_id = ? AND b.check_in_date = ? AND b.status IN ('PENDING','CONFIRMED')
     ORDER BY b.id LIMIT 6`,
    [hotelId, today]
  );

  const departures = all<{
    stay_id: number; room_no: string; guest_name: string; balance: number; rate: number;
  }>(
    `SELECT s.id AS stay_id, r.room_no, s.guest_name, COALESCE(f.balance,0) AS balance, s.rate
     FROM stays s JOIN rooms r ON r.id = s.room_id
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND s.expect_check_out = ?
     ORDER BY r.sort LIMIT 6`,
    [hotelId, today]
  );

  const inhouseList = all<{
    room_no: string; guest_name: string; rate: number; expect_check_out: string;
    channel: string | null; balance: number; check_in_time: string | null;
  }>(
    `SELECT r.room_no, s.guest_name, s.rate, s.expect_check_out, c.name AS channel,
            COALESCE(f.balance,0) AS balance, s.check_in_time
     FROM stays s JOIN rooms r ON r.id = s.room_id
     LEFT JOIN channels c ON c.id = s.channel_id
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     ORDER BY r.sort`,
    [hotelId]
  );

  /*
   * 出租率 / ADR / RevPAR 统一口径（第 4 轮 P1-5）
   *
   * 原来这里用 `occupied / total`：分母含维修房(OOO)和锁房(LOCK)，
   * 那些房卖不出去却占着分母 → 出租率被低估。
   * 而报表页扣了维修房、夜审日报又没扣 —— 同一个指标三个数，
   * 店长早上看工作台 54%、看报表 57%，谁也不知道该信哪个。
   *
   * 现在统一走 src/lib/metrics.ts（分母扣 OOO/LOCK、排除钟点房、ADR 除以已售房量）。
   * 注意：s.occupied 仍然用于「在住房间数」这种物理房间计数（那个语义是对的），
   * 只有「率」和「每间收入」走统一指标。
   */
  const bizDay = bizToday(hotelId);
  const metrics = occupancyMetrics(hotelId, bizDay, bizDay);
  const occupancy = fmtOccupancy(metrics.occupancy).replace("%", "");

  /* ---------- 店长看板（整改报告 P2-10）：ADR / RevPAR / 欠费 / 未到店 / 渠道异常 ---------- */
  const roomNights = metrics.roomsSold;
  const roomRevenue = metrics.roomRevenue;
  const adr = metrics.adr;
  const revpar = metrics.revpar;

  const debtTotal =
    one<{ c: number; amt: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(f.balance), 0) AS amt
         FROM stays s JOIN folios f ON f.stay_id = s.id
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0.01`,
      [hotelId]
    ) ?? { c: 0, amt: 0 };

  /** 未到店：离店日已过仍未入住（夜审会标 NOSHOW，这里看还没处理的） */
  const noShowPending =
    one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bookings
        WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_out_date < ?`,
      [hotelId, today]
    )?.c ?? 0;

  /** 渠道异常：同步失败 / 待接单太多 */
  const channelFailed =
    one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM channel_sync_logs
        WHERE hotel_id = ? AND status <> 'SUCCESS'
          AND created_at >= datetime('now', '-1 day')`,
      [hotelId]
    )?.c ?? 0;

  const pendingOrders =
    one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND status = 'NEW'`,
      [hotelId]
    )?.c ?? 0;

  const alerts = loadAlerts(hotelId, today);

  const ownerKpis = [
    { label: "出租率", value: `${occupancy}%`, sub: `${roomNights} 间夜 / 可售 ${metrics.sellableRooms} 间` },
    /*
     * 第 4 轮 P1-5：hint 跟着口径改
     * ADR 除以「已售间夜」（不是物理房间数）；RevPAR 除以「可售房量」（扣了维修房/锁房）。
     * 昨天写的「÷ 总房量」在新口径下是错的，会误导店长。
     */
    { label: "平均房价 ADR", value: fmtMoney(adr), sub: `客房收入 ÷ ${roomNights} 间夜` },
    { label: "RevPAR", value: fmtMoney(revpar), sub: `客房收入 ÷ 可售 ${metrics.sellableRooms} 间` },
    { label: "在住欠费", value: fmtMoney(debtTotal.amt), sub: `${debtTotal.c} 间未结清`, tone: "rose" },
    { label: "未到店待处理", value: String(noShowPending), sub: "离店日已过的预订", tone: "amber" },
    { label: "渠道异常", value: String(channelFailed), sub: `待接单 ${pendingOrders} 条`, tone: "amber" },
  ];

  const kpis = [
    { label: "在住房间", value: s.occupied, unit: "间", sub: `共 ${s.total} 间 · 出租率 ${occupancy}%`, tone: "blue", icon: "在" },
    { label: "今日预抵", value: s.arrivals, unit: "单", sub: "待办理入住", tone: "green", icon: "今" },
    { label: "今日预离", value: s.departures, unit: "单", sub: "待结账退房", tone: "amber", icon: "今" },
    { label: "今日营收", value: fmtMoney(s.revenue), unit: "", sub: "房费 + 消费", tone: "violet", icon: "营" },
  ];

  const toneMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    violet: "bg-violet-50 text-violet-600",
  };

  const flashErr = sp.err ?? "";

  return (
    <div className="space-y-4">
      {flashErr && (
        <div className="rounded-[3px] border border-[#f5c2c2] bg-[#fdf3f3] px-3 py-2 text-[12px] text-[#c0392b]">
          {flashErr}
        </div>
      )}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">工作台</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
            · 在住 {s.inhouse_guests} 位客人 · 空净 {s.vc} 间 / 空脏 {s.vd} 间
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/frontdesk" className="btn-primary">快速入住</Link>
          <Link href="/bookings/new" className="btn-default">新建预订</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-[4px] border border-[#eee] bg-white p-[14px]">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[12px] text-gray-500">{k.label}</span>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-[11px] font-semibold ${toneMap[k.tone]}`}>
                {k.icon}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-[22px] font-bold leading-none tabular-nums text-gray-900">{k.value}</span>
              <span className="text-[12px] text-gray-400">{k.unit}</span>
            </div>
            <div className="mt-1.5 truncate text-[11px] text-gray-400">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* 今日预警（报告 P2-10）：有问题才显示 */}
      {alerts.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#f3e0b8] bg-[#fffbf2] px-4 py-2.5">
            <span className="text-[12.5px] font-semibold text-[#b07d2e]">今日预警 · {alerts.length} 项</span>
            <span className="text-[11px] text-[#b07d2e]/70">点击右侧去处理</span>
          </div>
          <div className="divide-y divide-gray-50">
            {alerts.map((a) => (
              <div key={a.key} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${
                    a.level === "danger" ? "bg-[#d9534f]" : a.level === "warn" ? "bg-[#e8a33d]" : "bg-[#5b9bd5]"
                  }`}
                >
                  {a.count > 99 ? "99" : a.count}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-gray-800">{a.title}</div>
                  <div className="truncate text-[11px] text-gray-500" title={a.detail}>{a.detail}</div>
                </div>
                <Link
                  href={a.href}
                  className="shrink-0 rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-0.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                >
                  去处理
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 店长看板：ADR / RevPAR / 欠费 / 未到店 / 渠道异常 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {ownerKpis.map((k) => (
          <div
            key={k.label}
            className={`rounded-[4px] border bg-white p-[12px] ${
              k.tone === "rose" ? "border-[#f5c2c2]" : k.tone === "amber" ? "border-[#f3e0b8]" : "border-[#eee]"
            }`}
          >
            <div className="text-[11.5px] text-gray-500">{k.label}</div>
            <div
              className={`mt-1.5 text-[18px] font-bold leading-none tabular-nums ${
                k.tone === "rose" ? "text-[#c0392b]" : k.tone === "amber" ? "text-[#b07d2e]" : "text-gray-900"
              }`}
            >
              {k.value}
            </div>
            <div className="mt-1 truncate text-[10.5px] text-gray-400">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between border-b border-[#f0f0f0] bg-white px-4 py-2.5">
            <span className="text-[12px] font-semibold text-gray-800">今日预抵 · {s.arrivals}</span>
            <Link href="/bookings" className="text-[12px] text-brand-600 hover:underline">全部预订</Link>
          </div>
          <div className="divide-y divide-gray-50">
            {arrivals.length === 0 && <div className="px-4 py-8 text-center text-[12px] text-gray-400">暂无今日预抵</div>}
            {arrivals.map((a) => (
              <div key={a.id} className="flex h-14 items-center gap-3 px-4">
                <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[#f3f4f6] text-[12px] font-medium text-gray-600">
                  {a.guest_name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-gray-800">{a.guest_name}</span>
                    <span className={`rounded-[3px] border px-1 text-[10px] leading-[15px] ${BOOKING_STATUS[a.status]?.cls ?? ""}`}>
                      {BOOKING_STATUS[a.status]?.label ?? a.status}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-gray-400">
                    {a.room_type_name} · {ticket(a.room_no)} · {fmtMoney(a.rate)}
                  </div>
                </div>
                <Link href={`/frontdesk?booking=${a.id}`} className="inline-flex h-[26px] shrink-0 items-center rounded-[4px] bg-brand-600 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-brand-700">入住</Link>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between border-b border-[#f0f0f0] bg-white px-4 py-2.5">
            <span className="text-[12px] font-semibold text-gray-800">今日预离 · {s.departures}</span>
            <Link href="/cashier" className="text-[12px] text-brand-600 hover:underline">收银台</Link>
          </div>
          <div className="divide-y divide-gray-50">
            {departures.length === 0 && <div className="px-4 py-8 text-center text-[12px] text-gray-400">暂无今日预离</div>}
            {departures.map((d) => (
              <div key={d.stay_id} className="flex h-14 items-center gap-3 px-4">
                <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[#f3f4f6] text-[11px] font-semibold text-gray-600">
                  {d.room_no}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-gray-800">{d.guest_name}</div>
                  <div className="truncate text-[11px] text-gray-400">房价 {fmtMoney(d.rate)} · 余额 {fmtMoney(d.balance)}</div>
                </div>
                <Link href={`/cashier?stay=${d.stay_id}`} className="inline-flex h-[26px] shrink-0 items-center rounded-[4px] border border-gray-300 bg-white px-2.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-brand-400 hover:text-brand-600">结账</Link>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="mb-3 text-[13px] font-semibold text-gray-800">房态概览</div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div className="bg-[#3a76c4]" style={{ width: `${(s.occupied / Math.max(1, s.total)) * 100}%` }} />
            <div className="bg-gray-300" style={{ width: `${(s.vd / Math.max(1, s.total)) * 100}%` }} />
            <div className="bg-[#c99a2e]" style={{ width: `${(s.ooo / Math.max(1, s.total)) * 100}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {[
              ["在住", s.occupied, "text-blue-600"],
              ["空净", s.vc, "text-emerald-600"],
              ["空脏", s.vd, "text-amber-600"],
              ["维修", s.ooo, "text-gray-500"],
            ].map(([label, v, cls]) => (
              <div key={label as string} className="rounded-[4px] bg-[#fafafa] py-2">
                <div className={`text-[18px] font-semibold leading-tight tabular-nums ${cls}`}>{v as number}</div>
                <div className="text-[11px] text-gray-500">{label as string}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Link href="/rooms" className="btn-default flex-1 py-1.5 text-[12px]">打开房态图</Link>
            <Link href="/housekeeping" className="btn-default flex-1 py-1.5 text-[12px]">客房中心</Link>
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-3 text-[13px] font-semibold text-gray-800">快捷入口</div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["/bookings", "预订管理", "bg-blue-50 text-blue-700"],
              ["/frontdesk", "入住办理", "bg-emerald-50 text-emerald-700"],
              ["/cashier", "收银结账", "bg-amber-50 text-amber-700"],
              ["/inhouse", "在住客人", "bg-violet-50 text-violet-700"],
              ["/night-audit", "夜审日结", "bg-slate-100 text-slate-700"],
              ["/reports", "报表中心", "bg-rose-50 text-rose-700"],
            ].map(([href, label, cls]) => (
              <Link key={href} href={href} className={`flex h-[60px] items-center justify-center rounded-[4px] px-1 text-center text-[12px] font-medium leading-tight transition-opacity hover:opacity-80 ${cls}`}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">今日在住 · {inhouseList.length} 间</span>
          <Link href="/inhouse" className="text-[12px] text-brand-600 hover:underline">在住管理</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                <th className="th bg-[#eef6f1] text-[12px] font-medium text-gray-600">房号</th>
                <th className="th bg-[#eef6f1] text-[12px] font-medium text-gray-600">客人</th>
                <th className="th bg-[#eef6f1] text-[12px] font-medium text-gray-600">渠道</th>
                <th className="th bg-[#eef6f1] text-[12px] font-medium text-gray-600">房价</th>
                <th className="th bg-[#eef6f1] text-[12px] font-medium text-gray-600">预计离店</th>
                <th className="th bg-[#eef6f1] text-[12px] font-medium text-gray-600">余额</th>
                <th className="th bg-[#eef6f1] text-right text-[12px] font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody>
              {inhouseList.length === 0 && (
                <tr><td colSpan={7} className="td py-8 text-center text-gray-400">当前没有在住客人</td></tr>
              )}
              {inhouseList.map((r) => (
                <tr key={r.room_no} className="hover:bg-[#fafcfa]">
                  <td className="td h-[34px] py-0 align-middle font-medium text-gray-800">{r.room_no}</td>
                  <td className="td h-[34px] py-0 align-middle">{r.guest_name}</td>
                  <td className="td h-[34px] py-0 align-middle text-gray-500">{r.channel ?? "散客"}</td>
                  <td className="td h-[34px] py-0 align-middle tabular-nums">{fmtMoney(r.rate)}</td>
                  <td className="td h-[34px] py-0 align-middle text-gray-500">{r.expect_check_out}</td>
                  <td className={`td h-[34px] py-0 align-middle tabular-nums ${r.balance > 0 ? "text-rose-600" : "text-gray-500"}`}>{fmtMoney(r.balance)}</td>
                  <td className="td h-[34px] py-0 align-middle text-right">
                    <Link href="/cashier" className="text-[12px] text-brand-600 hover:underline">收银</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ticket(roomNo: string | null) {
  return roomNo ? `房间 ${roomNo}` : "未排房";
}
