import Link from "next/link";
import RowDropdown from "@/components/RowDropdown";
import { AssignRoomModal } from "@/components/AssignRoomModal";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { BOOKING_STATUS, addDays, fmtMoney, todayStr } from "@/lib/utils";
import { cancelBookingAction, deleteBookingAction } from "./actions";
import ConfirmForm from "@/components/ConfirmForm";
import { adjustPriceAction, freeUpgradeAction, joinGroupAction, batchAdjustRateBookingsAction, batchCancelBookingsAction, batchCancelTeamRoomsAction, batchConfirmBookingsAction, batchDeleteBookingsAction, updateBookingRemarkAction } from "./actions";

export const dynamic = "force-dynamic";

type BookingListRow = {
  id: number;
  booking_no: string;
  guest_name: string;
  mobile: string | null;
  room_type_id: number | null;
  room_type_name: string | null;
  room_no: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number | null;
  rate: number;
  /** 房费总额（整改 P1-12：优先取 total_price，老数据回退 rate × 晚数 × 间数） */
  total_amount: number;
  /** 预订定金（整改 P1-7：定金落库后列表要能看见，前台才知道入住该转多少押金） */
  deposit: number;
  channel_name: string | null;
  status: string;
  team_name: string | null;
  remark: string | null;
  breakfast: number | null;
  room_count: number | null;
};

type BookingPageProps = {
  searchParams: Promise<{
    status?: string;
    q?: string;
    channel?: string;
    range?: string;
    date?: string;
    sel?: string;
    sort?: string;
    page?: string;
  err?: string;
  msg?: string;
  }>;
};

const TABS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "PENDING", label: "待排房" },
  { key: "CONFIRMED", label: "已确认" },
  { key: "CHECKED_IN", label: "已入住" },
  { key: "NOSHOW", label: "未到" },
  { key: "CANCELLED", label: "已取消" },
];

const RANGES: { key: string; label: string }[] = [
  { key: "", label: "全部日期" },
  { key: "today", label: "今日预抵" },
  { key: "tomorrow", label: "明日预抵" },
  { key: "week", label: "未来 7 天" },
  { key: "overdue", label: "逾期未到" },
];

/** 保留筛选条件拼接链接 */
function buildHref(status: string, q: string, channel: string, range: string, sort = ""): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  if (channel) params.set("channel", channel);
  if (range) params.set("range", range);
  if (sort) params.set("sort", sort);
  const qs = params.toString();
  return qs ? `/bookings?${qs}` : "/bookings";
}

export default async function BookingsPage({ searchParams }: BookingPageProps) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();

  const sp = await searchParams;
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const status = Object.prototype.hasOwnProperty.call(BOOKING_STATUS, rawStatus) ? rawStatus : "";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const channel = typeof sp.channel === "string" ? sp.channel : "";
  const sort = typeof sp.sort === "string" ? sp.sort : "";
  const range = typeof sp.range === "string" && RANGES.some((r) => r.key === sp.range) ? sp.range : "";
  // 排房 / 批量操作的结果提示（action 里 redirect 带过来的）
  const flashErr = typeof sp.err === "string" ? sp.err : "";
  const flashMsg = typeof sp.msg === "string" ? sp.msg : "";

  /*
   * 分页（性能优化）
   *
   * 原来一次渲染全表 588 条预订 → 4.5 MB HTML，
   * 通过内网穿透传给手机要 17 秒（本机只要 0.26 秒，纯粹是带宽问题）。
   * 改成每页 30 条，HTML 降到 281 KB。
   */
  const PAGE_SIZE = 30;
  const pageRaw = Number(typeof sp.page === "string" ? sp.page : "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;

  const where: string[] = ["b.hotel_id = ?"];
  const params: unknown[] = [hotelId];
  if (status) {
    where.push("b.status = ?");
    params.push(status);
  }
  if (q) {
    where.push("(b.guest_name LIKE ? OR b.mobile LIKE ? OR b.booking_no LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (channel) {
    where.push("b.channel_id = ?");
    params.push(Number(channel));
  }
  if (range === "today") {
    where.push("b.check_in_date = ?");
    params.push(today);
  } else if (range === "tomorrow") {
    where.push("b.check_in_date = ?");
    params.push(todayStr(addDays(today, 1)));
  } else if (range === "week") {
    where.push("b.check_in_date >= ? AND b.check_in_date <= ?");
    params.push(today, todayStr(addDays(today, 7)));
  } else if (range === "overdue") {
    where.push("b.check_in_date < ? AND b.status IN ('PENDING','CONFIRMED')");
    params.push(today);
  }
  // 指定日期（远期房态表头「待分房N间」点进来）
  const dateParam = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : "";
  if (dateParam) {
    where.push("b.check_in_date <= ? AND b.check_out_date > ?");
    params.push(dateParam, dateParam);
  }

  const bookings = all<BookingListRow>(
    `SELECT b.id, b.booking_no, b.guest_name, b.mobile, b.room_type_id, COALESCE(b.breakfast, 0) AS breakfast,
            b.check_in_date, b.check_out_date, b.nights, b.rate, b.status,
            b.team_name, b.remark, COALESCE(b.room_count, 1) AS room_count,
            /* 房费总额（整改 P1-12）：钟点房 total_price = 钟点总价，日租 = rate × 晚数 × 间数；
               老数据 total_price 为 NULL 时按原口径 rate × nights × room_count 回退，金额不会变 0 */
            COALESCE(
              b.total_price,
              COALESCE(b.rate, 0) * COALESCE(NULLIF(b.nights, 0), 1) * MAX(1, COALESCE(b.room_count, 1))
            ) AS total_amount,
            COALESCE(b.deposit, 0) AS deposit,
            rt.name AS room_type_name, r.room_no, c.name AS channel_name
     FROM bookings b
     LEFT JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN rooms r ON r.id = b.room_id
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${sort === "in_asc" ? "b.check_in_date ASC" : "b.check_in_date DESC"}, b.id DESC
     LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
  );

  /* 总条数（分页用，只查一次，不参与渲染） */
  const totalRows =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bookings b WHERE ${where.join(" AND ")}`,
      params
    )?.c ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  /* ---- 排房：可用房间 = 同房型 + 房态 VC/VD + 区间不被在住或已排房订单占用 ---- */
  const allRooms = all<{
    id: number;
    room_no: string;
    room_type_id: number;
    status: string;
    floor: number | null;
    room_type_name: string | null;
  }>(
    `SELECT r.id, r.room_no, r.room_type_id, r.status, r.floor, COALESCE(rt.name, '') AS room_type_name
       FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = ? ORDER BY r.floor, r.room_no`,
    [hotelId]
  );
  /*
   * 房间占用区间（第 4 轮 P1-38：要查 booking_rooms 明细，不能只看主单 + 不要算 PENDING）
   *
   * 旧写法两段 UNION：
   *   ① stays（在住）
   *   ② bookings WHERE room_id IS NOT NULL AND status IN ('PENDING','CONFIRMED','CHECKED_IN')
   *
   * 两个问题：
   *   · PENDING 是「还没排房」，物理上没占房，算成占用会让候选房列表少一半（能排的说不能排）
   *   · 多房订单的明细房间在 booking_rooms 里，主单 room_id 通常只有一间 ——
   *     漏查明细会导致「界面上能选，提交才报冲突」（P0-8 已在服务端拦住，但前端体验差）
   */
  const occupiedSpans = all<{ room_id: number; from_date: string; to_date: string }>(
    `SELECT room_id, date(check_in_time) AS from_date, expect_check_out AS to_date
       FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'
     UNION ALL
     SELECT room_id, check_in_date, check_out_date
       FROM bookings WHERE hotel_id = ? AND room_id IS NOT NULL AND status IN ('CONFIRMED','CHECKED_IN')
     UNION ALL
     SELECT br.room_id, b.check_in_date, b.check_out_date
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
      WHERE br.hotel_id = ? AND br.room_id IS NOT NULL
        AND br.status IN ('CONFIRMED','CHECKED_IN')
        AND b.status IN ('CONFIRMED','CHECKED_IN')`,
    [hotelId, hotelId, hotelId]
  );
  /** 排房弹窗候选：该日期区间内可用的全部房间（其他房型标可升级） */
  const assignCandidates = (b: { room_type_id: number | null; check_in_date: string; check_out_date: string }) =>
    allRooms.filter(
      (r) =>
        // 房型必须一致（或订单未指定房型），否则 action 会拒绝
        (!b.room_type_id || r.room_type_id === b.room_type_id) &&
        (r.status === "VC" || r.status === "VD") &&
        !occupiedSpans.some(
          (o) => o.room_id === r.id && o.from_date < b.check_out_date && b.check_in_date < o.to_date
        )
    );
  const freeRoomsFor = (b: { room_type_id: number | null; check_in_date: string; check_out_date: string }) =>
    allRooms.filter(
      (r) =>
        (!b.room_type_id || r.room_type_id === b.room_type_id) &&
        (r.status === "VC" || r.status === "VD") &&
        !occupiedSpans.some(
          (o) => o.room_id === r.id && o.from_date < b.check_out_date && o.to_date > b.check_in_date
        )
    );
  const currentPath = (() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (q) p.set("q", q);
    if (channel) p.set("channel", channel);
    if (range) p.set("range", range);
    if (dateParam) p.set("date", dateParam);
    const qs = p.toString();
    return qs ? `/bookings?${qs}` : "/bookings";
  })();

  /** 表头「全选」：用 ?sel=1 让本页所有行默认勾选（无需前端脚本） */
  const selAll = sp.sel === "1";
  const selHref = (sel: boolean) => {    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    if (channel) params.set("channel", channel);
    if (range) params.set("range", range);
    if (dateParam) params.set("date", dateParam);
    if (sel) params.set("sel", "1");
    const qs = params.toString();
    return qs ? `/bookings?${qs}` : "/bookings";
  };

  const grouped = all<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM bookings WHERE hotel_id = ? GROUP BY status`,
    [hotelId]
  );
  const channels = all<{ id: number; name: string }>(
    `SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  const countMap = new Map<string, number>();
  for (const g of grouped) countMap.set(g.status, g.count);
  const totalCount = grouped.reduce((sum, g) => sum + g.count, 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">预订管理</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            今日 {today} · 共 {totalCount} 条预订，待排房 {countMap.get("PENDING") ?? 0} 条
          </p>
        </div>

        {(flashErr || flashMsg) && (
          <div
            className={`mt-2 rounded-[3px] border px-3 py-2 text-[12px] ${
              flashErr
                ? "border-[#f5c2c2] bg-[#fdf3f3] text-[#c0392b]"
                : "border-[#b7e2c2] bg-[#f2fbf5] text-[#1e7e39]"
            }`}
          >
            {flashErr || flashMsg}
          </div>
        )}
        <Link href="/bookings/new" className="btn-primary">
          新建预订
        </Link>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1">
            {TABS.map((tab) => {
              const count = tab.key ? countMap.get(tab.key) ?? 0 : totalCount;
              const active = status === tab.key;
              return (
                <Link
                  key={tab.key || "all"}
                  href={buildHref(tab.key, q, channel, range, sort)}
                  className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                    active
                      ? "bg-brand-600 font-medium text-white"
                      : "border border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                  }`}
                >
                  {tab.label}
                  <span className={`ml-1 text-[11px] tabular-nums ${active ? "text-white/80" : "text-gray-400"}`}>
                    {count}
                  </span>
                </Link>
              );
            })}
          </div>

          <form action="/bookings" method="get" className="ml-auto flex flex-wrap items-center gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="客人姓名 / 手机 / 预订号"
              className="input h-8 w-52"
            />
            <select name="channel" defaultValue={channel} className="input h-8 w-28">
              <option value="">全部渠道</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select name="range" defaultValue={range} className="input h-8 w-28">
              {RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-default h-8">
              筛选
            </button>
            {(q || channel || range) && (
              <Link href={buildHref(status, "", "", "")} className="text-[12px] text-gray-500 hover:text-brand-600">
                清除
              </Link>
            )}
          </form>
        </div>

        {/* 批量操作表单：表格里的勾选框用 form="bkBatch" 归属到这里 */}
        <form
          id="bkBatch"
          action={batchConfirmBookingsAction}
          className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2"
        >
          <span className="text-[12px] text-gray-500">
            批量操作：先勾选行（或点表头全选框全选）{selAll && <b className="text-brand-700">· 已全选当前 {bookings.length} 条</b>}
          </span>
          <button type="submit" className="btn-primary h-8 px-2.5 text-[12px]">
            批量确认
          </button>
          <button type="submit" formAction={batchCancelBookingsAction} className="btn-default h-8 px-2.5 text-[12px]">
            批量取消
          </button>
          <button type="submit" formAction={batchCancelTeamRoomsAction} className="btn-default h-8 px-2.5 text-[12px]">
            团队取消排房
          </button>
          <ConfirmForm
            action={batchDeleteBookingsAction}
            linkedFormId="bkBatch"
            message="确认批量删除选中的预订单？"
            detail="选中的预订单会被永久删除，房间占用同时释放，无法恢复。"
            confirmLabel="确认批量删除"
          >
            <button type="submit" className="btn-danger h-8 px-2.5 text-[12px]">
              批量删除
            </button>
          </ConfirmForm>
          <div className="ml-auto flex items-center gap-1.5">
            <input
              name="rate"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="统一房价"
              className="input h-8 w-28"
            />
            <button
              type="submit"
              formAction={batchAdjustRateBookingsAction}
              className="btn-default h-8 px-2.5 text-[12px]"
            >
              批量调价
            </button>
          </div>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th w-8">
                  <Link
                    href={selHref(!selAll)}
                    title={selAll ? "取消全选" : "全选当前列表"}
                    className="inline-flex items-center"
                  >
                    <span
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border text-[9px] leading-none ${
                        selAll ? "border-brand-600 bg-brand-600 text-white" : "border-gray-300 bg-white text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                  </Link>
                </th>
                <th className="th">预订号</th>
                <th className="th">客人</th>
                <th className="th">手机</th>
                <th className="th">房间信息</th>
                <th className="th">
                  <Link
                    href={buildHref(status, q, channel, range, sort === "in_asc" ? "in_desc" : "in_asc")}
                    className="inline-flex items-center gap-0.5 hover:text-brand-600"
                    title="点击按入住日期排序"
                  >
                    入离时间 <span className="text-[10px]">{sort === "in_asc" ? "▲" : sort === "in_desc" ? "▼" : "▾"}</span>
                  </Link>
                </th>
                <th className="th">离店</th>
                <th className="th">晚数</th>
                <th className="th">早餐</th>
                <th className="th">渠道</th>
                <th className="th">状态</th>
                <th className="th">操作</th>
              </tr>
            </thead>
            <tbody>
              {bookings.length === 0 && (
                <tr>
                  <td colSpan={12} className="td py-10 text-center text-gray-400">
                    {q || status ? "没有符合条件的预订，试试调整筛选或搜索条件" : "暂无预订记录，点击右上角「新建预订」开始"}
                  </td>
                </tr>
              )}
              {bookings.map((b) => {
                const st = BOOKING_STATUS[b.status];
                const isArrival =
                  b.check_in_date === today && (b.status === "PENDING" || b.status === "CONFIRMED");
                return (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="td">
                      <input
                        type="checkbox"
                        form="bkBatch"
                        name="ids"
                        value={b.id}
                        defaultChecked={selAll}
                        aria-label={`选择预订 ${b.booking_no}`}
                        className="h-3.5 w-3.5 accent-brand-600"
                      />
                    </td>
                    <td className="td font-medium text-brand-700">{b.booking_no}</td>
                    <td className="td">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate">{b.guest_name}</span>
                        {b.team_name && (
                          <span
                            className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1 text-[10px] leading-[15px] text-amber-700"
                            title="团队名称：团队取消排房按此归组"
                          >
                            {b.team_name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="td text-gray-500">{b.mobile || "—"}</td>
                    <td className="td">
                      <div className="text-[12px] text-[#333]">{b.room_type_name ?? "—"}</div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="text-[11.5px] font-medium text-[#e53935]">{fmtMoney(b.rate)}</span>
                        <span className="text-[10.5px] text-[#999]">{b.nights ?? 1}间</span>
                      </div>
                      {/* 房费合计 / 定金（整改 P1-12、P1-7）：合计走 total_price 口径，定金为 0 时不占位 */}
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px] text-[#999]">
                        <span>合计 {fmtMoney(b.total_amount)}</span>
                        {b.deposit > 0 ? (
                          <span className="rounded border border-[#d8e4f5] bg-[#f3f8ff] px-1 leading-[15px] text-[#3b6ea5]">
                            定金 {fmtMoney(b.deposit)}
                          </span>
                        ) : null}
                      </div>
                      {b.room_no ? (
                        <span className="mt-0.5 inline-block rounded border border-[#b7e0c0] bg-[#f0f9f2] px-1 text-[10px] leading-[15px] text-[#3f9d57]">
                          {b.room_no}
                        </span>
                      ) : (
                        <span className="mt-0.5 inline-block rounded border border-[#ffd8d8] bg-[#fff5f5] px-1 text-[10px] leading-[15px] text-[#e53935]">
                          排房
                        </span>
                      )}
                    </td>
                    <td className="td tabular-nums">{b.check_in_date}</td>
                    <td className="td tabular-nums">{b.check_out_date}</td>
                    <td className="td tabular-nums text-gray-600">{b.nights ?? 0}</td>
                    <td className="td text-gray-600">{b.breakfast ? "含早" : "不含早"}</td>
                    <td className="td text-gray-600">{b.channel_name ?? "散客"}</td>
                    <td className="td">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${
                          st ? st.cls : "border-gray-200 bg-gray-100 text-gray-500"
                        }`}
                      >
                        {st ? st.label : b.status}
                      </span>
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* 查看 / 操作▾（去呼呼式两按钮 + 下拉） */}
                        <Link
                          href={`/orders?tab=all&q=${encodeURIComponent(b.booking_no ?? "")}`}
                          className="rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-[2px] text-[12px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                        >
                          查看
                        </Link>

                        <RowDropdown label="操作" width={170}>
                            {(b.status === "PENDING" || b.status === "CONFIRMED") ? (
                              <AssignRoomModal
                                bookingId={b.id}
                                roomTypeName={b.room_type_name ?? "未指定房型"}
                                roomTypeId={b.room_type_id ?? 0}
                                alreadyAssigned={b.room_no}
                                backTo={currentPath}
                                pendingCount={Math.max(1, b.room_count ?? 1)}
                                rooms={assignCandidates(b).map((r) => ({
                                  id: r.id,
                                  room_no: r.room_no,
                                  floor: r.floor ?? null,
                                  room_type_id: r.room_type_id,
                                  room_type_name: r.room_type_name ?? "",
                                  status: r.status,
                                  upgradable: r.room_type_id !== b.room_type_id,
                                }))}
                              />
                            ) : (
                              <div className="px-2 py-1 text-[12px] text-[#bbb]">排房</div>
                            )}

                            <details>
                              <summary className="cursor-pointer list-none px-2 py-1 text-[12px] text-[#555] hover:bg-[#f7f9f8] [&::-webkit-details-marker]:hidden">
                                调价
                              </summary>
                              <form action={adjustPriceAction} className="flex items-center gap-1 px-2 pb-1">
                                <input type="hidden" name="id" value={b.id} />
                                <input type="hidden" name="backTo" value={currentPath} />
                                <input
                                  name="rate"
                                  type="number"
                                  step="0.01"
                                  defaultValue={b.rate}
                                  className="input h-6 w-[80px] text-[11.5px]"
                                />
                                <button className="rounded-[2px] bg-[#32c141] px-2 py-0.5 text-[11px] text-white">保存</button>
                              </form>
                            </details>

                            <form action={freeUpgradeAction}>
                              <input type="hidden" name="id" value={b.id} />
                              <input type="hidden" name="backTo" value={currentPath} />
                              <button className="w-full px-2 py-1 text-left text-[12px] text-[#555] hover:bg-[#f7f9f8]">
                                免费升级
                              </button>
                            </form>

                            <form action={joinGroupAction}>
                              <input type="hidden" name="id" value={b.id} />
                              <input type="hidden" name="backTo" value={currentPath} />
                              <button className="w-full px-2 py-1 text-left text-[12px] text-[#555] hover:bg-[#f7f9f8]">
                                入团
                              </button>
                            </form>

                            {(b.status === "PENDING" || b.status === "CONFIRMED") ? (
                              <ConfirmForm
                                action={cancelBookingAction}
                                message={`确认取消预订 ${b.booking_no}？`}
                                detail="取消后房态占用会释放，订单状态变为「已取消」，可在取消记录里查看。"
                                confirmLabel="确认取消订单"
                                requireReason="取消原因"
                              >
                                <input type="hidden" name="id" value={b.id} />
                                <button className="w-full px-2 py-1 text-left text-[12px] text-[#e53935] hover:bg-[#fdf3f3]">
                                  取消订单
                                </button>
                              </ConfirmForm>
                            ) : (
                              <div className="px-2 py-1 text-[12px] text-[#bbb]">取消订单</div>
                            )}

                            <span className="my-1 block border-t border-[#f0f0f0]" />
                            <details>
                              <summary className="cursor-pointer list-none px-2 py-1 text-[12px] text-[#555] hover:bg-[#f7f9f8] [&::-webkit-details-marker]:hidden">
                                修改备注
                              </summary>
                              <form action={updateBookingRemarkAction} className="px-2 pb-1">
                                <input type="hidden" name="id" value={b.id} />
                                <textarea
                                  name="remark"
                                  rows={2}
                                  defaultValue={b.remark ?? ""}
                                  placeholder="订单备注"
                                  className="input w-full text-[11.5px]"
                                />
                                <button className="mt-1 w-full rounded-[2px] bg-[#32c141] py-0.5 text-[11px] text-white">
                                  保存
                                </button>
                              </form>
                            </details>
                            {b.status !== "CHECKED_IN" && (
                              <ConfirmForm
                                action={deleteBookingAction}
                                message={`确认删除预订 ${b.booking_no}？`}
                                detail="删除后预订单和房间占用都会消失，无法恢复。只是不想接待请用「取消订单」。"
                                confirmLabel="确认删除"
                              >
                                <input type="hidden" name="id" value={b.id} />
                                <button className="w-full px-2 py-1 text-left text-[12px] text-[#999] hover:bg-[#fdf3f3] hover:text-[#e53935]">
                                  删除
                                </button>
                              </ConfirmForm>
                            )}
                        </RowDropdown>

                        {b.room_no && (
                          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                            {b.room_no}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/*
         * 分页控件（性能优化）
         *
         * 原来是假的：硬编码「1」，上下页是灰色不可点，但表格其实渲染了全表 588 条
         * → 4.5 MB HTML，走内网穿透要 17 秒。现在真分页，每页 30 条。
         */}
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5 text-[12px] text-gray-500">
          <span>
            {q ? `关键词「${q}」` : status ? `筛选：${BOOKING_STATUS[status].label}` : "全部预订"}
            {totalRows > 0 && (
              <span className="ml-1.5 text-gray-400">
                第 {page} / {totalPages} 页
              </span>
            )}
          </span>
          <div className="flex items-center gap-1.5">
            <span>共 {totalRows} 条</span>
            {(() => {
              /* 保留当前筛选条件，只改 page 参数 */
              const mk = (n: number) => {
                const u = new URLSearchParams();
                if (status) u.set("status", status);
                if (q) u.set("q", q);
                if (channel) u.set("channel", channel);
                if (range) u.set("range", range);
                if (sort) u.set("sort", sort);
                if (n > 1) u.set("page", String(n));
                const qs = u.toString();
                return "/bookings" + (qs ? "?" + qs : "");
              };
              return (
                <>
                  {page > 1 ? (
                    <Link
                      href={mk(page - 1)}
                      prefetch={false}
                      className="rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                    >
                      上一页
                    </Link>
                  ) : (
                    <span className="rounded border border-gray-200 px-2 py-0.5 text-gray-300">上一页</span>
                  )}
                  <span className="flex h-5 min-w-5 items-center justify-center rounded bg-brand-500 px-1.5 text-white">
                    {page}
                  </span>
                  {page < totalPages ? (
                    <Link
                      href={mk(page + 1)}
                      prefetch={false}
                      className="rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                    >
                      下一页
                    </Link>
                  ) : (
                    <span className="rounded border border-gray-200 px-2 py-0.5 text-gray-300">下一页</span>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
