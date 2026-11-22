import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { fmtMoney, BOOKING_STATUS } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 移动端订单列表（F13）
 *
 * 桌面订单页一屏 20 列，手机上只能横滑看表头。
 * 这里换成卡片：一行一个订单，关键信息 3 行内说完。
 *
 * 筛选：?status=PENDING|CONFIRMED|CHECKED_IN|CANCELLED|all
 * 搜索：?q=客人姓名/手机/订单号
 *
 * 第 4 轮整改：
 *   P1-28b 口径对齐桌面：`stays ∪ bookings`（原来只查 bookings → 「在住」3 条 vs 桌面 24 条）。
 *   P1-28c 金额用 bookings.total_price（钟点房 nights=0 不再显示 ¥0），取不到时回退到
 *          rate × max(1, 晚数) × 间数；在住单用账单 total_amount。
 */

const TABS = [
  { key: "all", label: "全部" },
  { key: "PENDING", label: "待排" },
  { key: "CONFIRMED", label: "已确认" },
  { key: "CHECKED_IN", label: "在住" },
  { key: "CANCELLED", label: "已取消" },
];

/** 在住单状态 → 订单状态（在住单只有 INHOUSE / CHECKED_OUT） */
const STAY_STATUS: Record<string, string> = {
  INHOUSE: "CHECKED_IN",
  CHECKED_OUT: "CHECKED_OUT",
};

const STATUS_LABEL: Record<string, string> = {
  CHECKED_OUT: "已离",
};

type OrderRow = {
  kind: string;
  id: number;
  status: string;
  booking_no: string;
  guest_name: string;
  mobile: string | null;
  room_no: string | null;
  room_type: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  room_count: number;
  rate: number;
  total_price: number | null;
};

/**
 * 统一列表 SQL（在住单 ∪ 预订单）
 *
 * 两个分支的列必须一一对应：kind / id / status / 单号 / 客人 / 手机 / 房号 / 房型 /
 * 入离日期 / 晚数 / 间数 / 房价 / 总价。
 * 注意 SQLite 的 `max(a, b)` 两参数是标量函数（不是聚合），这里用它把 0/空值抬到 1。
 */
const UNIFIED_SQL = `
  SELECT 'stay' AS kind,
         s.id AS id,
         CASE WHEN s.status = 'INHOUSE' THEN 'CHECKED_IN' ELSE s.status END AS status,
         s.stay_no AS booking_no,
         s.guest_name AS guest_name,
         s.mobile AS mobile,
         r.room_no AS room_no,
         rt.name AS room_type,
         substr(s.check_in_time, 1, 10) AS check_in_date,
         s.expect_check_out AS check_out_date,
         max(COALESCE(s.nights, 1), 1) AS nights,
         1 AS room_count,
         COALESCE(s.rate, 0) AS rate,
         NULLIF(f.total_amount, 0) AS total_price
    FROM stays s
    JOIN rooms r ON r.id = s.room_id
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN folios f ON f.stay_id = s.id
   WHERE s.hotel_id = ?

  UNION ALL

  SELECT 'booking' AS kind,
         b.id AS id,
         b.status AS status,
         b.booking_no AS booking_no,
         b.guest_name AS guest_name,
         b.mobile AS mobile,
         r.room_no AS room_no,
         rt.name AS room_type,
         b.check_in_date AS check_in_date,
         b.check_out_date AS check_out_date,
         max(COALESCE(b.nights, 1), 1) AS nights,
         max(COALESCE(b.room_count, 1), 1) AS room_count,
         COALESCE(b.rate, 0) AS rate,
         b.total_price AS total_price
    FROM bookings b
    LEFT JOIN rooms r ON r.id = b.room_id
    LEFT JOIN room_types rt ON rt.id = b.room_type_id
   WHERE b.hotel_id = ?
`;

/** 金额：优先用总价（钟点房 nights=0 也不会算成 0），没有总价再回退到「房价 × 晚数 × 间数」 */
function orderAmount(b: OrderRow): number {
  const total = b.total_price;
  if (total != null) return Number(total);
  return (b.rate ?? 0) * Math.max(1, b.nights ?? 1) * (b.room_count ?? 1);
}

export default async function MobileOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const status = TABS.some((t) => t.key === sp.status) ? sp.status! : "all";
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const today = bizToday(user.hotelId);

  const where: string[] = [];
  const params: unknown[] = [user.hotelId, user.hotelId];
  if (status !== "all") {
    if (status === "CHECKED_IN") {
      /*
       * 「在住」只看真实在住单（stays INHOUSE），与桌面订单页「当前在住」完全同口径。
       * 库里还有 3 条状态残留为 CHECKED_IN 的预订单（历史数据，没有对应 stay），
       * 它们只出现在「全部」里，不再冒充在住。
       */
      where.push("u.kind = 'stay' AND u.status = 'CHECKED_IN'");
    } else {
      where.push("u.status = ?");
      params.push(status);
    }
  }
  if (q) {
    where.push("(u.guest_name LIKE ? OR u.mobile LIKE ? OR u.booking_no LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = all<OrderRow>(
    `SELECT * FROM (${UNIFIED_SQL}) u
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY u.check_in_date DESC, u.kind DESC, u.id DESC
      LIMIT 100`,
    params
  );

  /* 分类计数：口径与列表一致（stays ∪ bookings），且不受搜索/筛选影响 */
  const counts = get<Record<string, number>>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS PENDING,
       SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) AS CONFIRMED,
       SUM(CASE WHEN kind = 'stay' AND status = 'CHECKED_IN' THEN 1 ELSE 0 END) AS CHECKED_IN,
       SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS CANCELLED
     FROM (${UNIFIED_SQL}) u`,
    [user.hotelId, user.hotelId]
  ) ?? { total: 0, PENDING: 0, CONFIRMED: 0, CHECKED_IN: 0, CANCELLED: 0 };

  const qs = (patch: Record<string, string>) => {
    const u = new URLSearchParams();
    const next = { status, q, ...patch };
    if (next.status && next.status !== "all") u.set("status", next.status);
    if (next.q) u.set("q", next.q);
    const s = u.toString();
    return s ? `/m/orders?${s}` : "/m/orders";
  };

  return (
    <div className="mx-auto max-w-[520px]">
      {/* 吸顶筛选 + 搜索 */}
      <div className="sticky top-0 z-10 border-b border-[#e5e5e5] bg-white/95 px-3 py-2 backdrop-blur">
        <form action="/m/orders" method="get" className="flex items-center gap-2">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <label htmlFor="m-orders-q" className="sr-only">
            搜索订单（客人姓名 / 手机 / 订单号）
          </label>
          <input
            id="m-orders-q"
            name="q"
            defaultValue={q}
            placeholder="客人 / 手机 / 订单号"
            className="h-8 flex-1 rounded-[4px] bg-[#f2f3f5] px-2.5 text-[12.5px] outline-none placeholder:text-[#b0b8bf] focus-visible:ring-2 focus-visible:ring-brand-300"
          />
          <button type="submit" className="h-8 rounded-[4px] bg-[#1e8e3e] px-3 text-[12px] text-white">
            搜索
          </button>
        </form>

        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {TABS.map((t) => {
            const active = status === t.key;
            const n = counts[t.key === "all" ? "total" : t.key] ?? 0;
            return (
              <Link
                key={t.key}
                href={qs({ status: t.key })}
                prefetch={false}
                aria-current={active ? "true" : undefined}
                aria-label={`筛选 ${t.label}（${n} 单）`}
                className={`inline-flex h-11 shrink-0 items-center rounded-full px-3 text-[12px] ${
                  active ? "bg-[#1e8e3e] text-white" : "border border-[#dcdcdc] bg-white text-gray-600"
                }`}
              >
                {t.label}
                <span className={`ml-1 ${active ? "text-white/70" : "text-[#b0b8bf]"}`}>{n}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* 订单卡片 */}
      <div className="space-y-2 px-3 py-3">
        {rows.length === 0 && (
          <div className="rounded-[8px] border border-dashed border-[#dcdcdc] bg-white py-16 text-center">
            <div className="text-[13px] text-[#8b949e]">{q || status !== "all" ? "没有符合条件的订单" : "还没有订单"}</div>
          </div>
        )}

        {rows.map((b) => {
          const displayStatus = STAY_STATUS[b.status] ?? b.status;
          const st = BOOKING_STATUS[displayStatus];
          const isToday = b.check_in_date === today;
          /* 在住单跳桌面订单页（按入住单号搜索）；预订单仍走预订页 */
          const href =
            b.kind === "stay"
              ? `/orders?tab=inhouse&q=${encodeURIComponent(b.booking_no)}`
              : `/bookings?q=${encodeURIComponent(b.booking_no)}`;
          return (
            <Link
              key={`${b.kind}-${b.id}`}
              href={href}
              prefetch={false}
              className="block rounded-[8px] bg-white p-3 active:bg-[#f7f7f7]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-[11.5px] text-[#8b949e]">{b.booking_no}</span>
                  <span
                    className={`shrink-0 rounded-[3px] border px-1 text-[10px] leading-[15px] ${st?.cls ?? "border-gray-200 bg-gray-100 text-gray-500"}`}
                  >
                    {st?.label ?? STATUS_LABEL[displayStatus] ?? displayStatus}
                  </span>
                  {isToday && b.status !== "CANCELLED" && (
                    <span className="shrink-0 rounded-[3px] bg-[#fff7e6] px-1 text-[10px] text-[#b07d2e]">今日</span>
                  )}
                </div>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-gray-900">
                  {fmtMoney(orderAmount(b))}
                </span>
              </div>

              <div className="mt-1.5 flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-[14px] font-medium text-gray-900">{b.guest_name}</span>
                {b.mobile && <span className="shrink-0 text-[11.5px] text-[#8b949e]">{b.mobile}</span>}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-[#8b949e]">
                <span>{b.check_in_date || "—"} → {b.check_out_date || "—"}</span>
                <span>{b.nights ?? 1} 晚 · {b.room_count ?? 1} 间</span>
                {b.room_no ? (
                  <span className="rounded border border-emerald-200 bg-emerald-50 px-1 text-[10.5px] text-emerald-700">
                    {b.room_no}
                  </span>
                ) : (
                  <span className="rounded border border-gray-200 bg-gray-50 px-1 text-[10.5px] text-gray-500">待排房</span>
                )}
                {b.room_type && <span>{b.room_type}</span>}
              </div>
            </Link>
          );
        })}
      </div>

      {rows.length >= 100 && (
        <div className="px-3 pb-4 text-center text-[10.5px] text-[#b0b8bf]">只显示最近 100 条，请用搜索缩小范围</div>
      )}
    </div>
  );
}
