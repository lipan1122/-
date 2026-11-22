import Link from "next/link";
import ConfirmForm from "@/components/ConfirmForm";
import { all, get } from "@/lib/db";
import { hasPermission, requireUser } from "@/lib/session";
import { addDays, todayStr } from "@/lib/utils";
import {
  cancelAllOverdueAction,
  cancelOverdueAction,
  confirmAllArrivalsAction,
  confirmArrivalAction,
  convertOverdueAction,
  overdueImpactAction,
} from "./actions";

export const dynamic = "force-dynamic";

/** 预抵 / 逾期列表行（只查列表要显示的列） */
type TodoBookingRow = {
  id: number;
  booking_no: string | null;
  guest_name: string | null;
  room_count: number | null;
  check_in_date: string;
  check_out_date: string;
  nights: number | null;
};

const TODO_TABS = [
  { key: "front", label: "前台任务" },
  { key: "channel", label: "直连订单消息" },
  { key: "shop", label: "餐饮及小商超订单" },
  { key: "abnormal", label: "异常检查" },
  { key: "lock", label: "门锁检查" },
  { key: "wake", label: "叫醒服务" },
  { key: "finance", label: "财务相关" },
];

const TODO_TAGS = [
  "全部",
  "门店消息",
  "价格调整建议",
  "商超订单消息",
  "开发票",
  "免费wifi",
  "客房服务",
  "清洁服务",
  "餐饮服务",
  "订房",
  "续住",
  "自定义",
  "门店过期提醒",
  "预离提醒",
  "预住提醒",
  "取消入住审批",
];

export default async function WorkbenchPage() {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const yesterday = todayStr(addDays(today, -1));

  const roomTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM rooms WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  const inhouse = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
    [hotelId]
  )?.n ?? 0;
  const arrivals = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED')`,
    [hotelId, today]
  )?.n ?? 0;
  const departures = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out = ?`,
    [hotelId, today]
  )?.n ?? 0;
  const occupiedRooms = get<{ n: number }>(
    `SELECT COUNT(DISTINCT room_id) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
    [hotelId]
  )?.n ?? 0;
  const sellable = Math.max(0, roomTotal - occupiedRooms);

  /* 前台待办分类数量（对齐去呼呼工作台「前台待办」的角标） */
  const channelToday = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = ? AND date(imported_at) = ?`,
    [hotelId, today]
  )?.n ?? 0;
  const todoCounts: Record<string, number> = {
    front: arrivals + departures,
    channel: channelToday,
    shop: 0,
    abnormal: 0,
    lock: 0,
    wake: 0,
    finance: 0,
  };

  const occRate = roomTotal > 0 ? (occupiedRooms / roomTotal) * 100 : 0;

  // 房费与收款（今日）
  const fee = get<{ room_fee: number | null; other: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END),0) AS room_fee,
            COALESCE(SUM(CASE WHEN item_type <> 'ROOM' THEN amount ELSE 0 END),0) AS other
     FROM folio_items WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  ) ?? { room_fee: 0, other: 0 };
  const roomFee = Number(fee.room_fee ?? 0);
  const otherFee = Number(fee.other ?? 0);
  const nights = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
    [hotelId]
  )?.n ?? 0;
  const adr = nights > 0 ? roomFee / nights : 0;
  const revpar = roomTotal > 0 ? roomFee / roomTotal : 0;

  const payments = get<{ n: number | null }>(
    `SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE hotel_id = ? AND date(created_at, 'localtime') = ?`,
    [hotelId, today]
  )?.n ?? 0;

  // 保洁
  const hk = all<{ status: string }>(`SELECT status FROM housekeeping WHERE hotel_id = ?`, [hotelId]);
  const hkPending = hk.filter((h) => h.status === "PENDING").length;
  const hkDone = hk.filter((h) => h.status === "DONE").length;

  // 夜审
  const nightAudit = get<{ biz_date: string | null; operator: string | null }>(
    `SELECT biz_date, operator FROM night_audits WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`,
    [hotelId]
  );

  const notices = all<{ id: number; title: string; created_at: string | null }>(
    `SELECT id, title, created_at FROM notices WHERE hotel_id = ? ORDER BY id DESC LIMIT 5`,
    [hotelId]
  );

  const shifts = get<{ consume: number | null; receipt: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN item_type <> 'PAYMENT' THEN amount ELSE 0 END),0) AS consume,
            COALESCE(SUM(CASE WHEN item_type = 'PAYMENT' THEN amount ELSE 0 END),0) AS receipt
     FROM folio_items WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  ) ?? { consume: 0, receipt: 0 };

  /* ---------------- 预抵 / 逾期处理（第六轮整改 一.4） ----------------
   *
   * 权限（服务端才作数，这里只决定按钮显不显示）：
   *   booking.modify → 确认预抵、逾期转今日预订
   *   booking.cancel → 取消逾期（单条 / 批量）
   * 客房、收银也能进 /today-todo（ROLE_MODULES 放行），但他们没有这两个点，
   * 所以列表与按钮一并隐藏，只显示「当前岗位无预订处理权限」。
   *
   * 逾期口径与 actions.ts 的取消 / 转预订条件逐字一致（PENDING/CONFIRMED/NOSHOW 且入住日 < 今天），
   * 否则会出现「页面说有 3 单、点批量取消实际取消了 5 单」。
   */
  const canModifyBooking = hasPermission(user.role, "booking.modify", hotelId);
  const canCancelBooking = hasPermission(user.role, "booking.cancel", hotelId);
  const canHandleBooking = canModifyBooking || canCancelBooking;

  const preArrivals: TodoBookingRow[] = canHandleBooking
    ? all<TodoBookingRow>(
        `SELECT id, booking_no, guest_name, room_count, check_in_date, check_out_date, nights
           FROM bookings
          WHERE hotel_id = ? AND check_in_date = ? AND status = 'PENDING'
          ORDER BY id DESC
          LIMIT 10`,
        [hotelId, today]
      )
    : [];

  const overdueRows: TodoBookingRow[] = canHandleBooking
    ? all<TodoBookingRow>(
        `SELECT id, booking_no, guest_name, room_count, check_in_date, check_out_date, nights
           FROM bookings
          WHERE hotel_id = ? AND check_in_date < ? AND status IN ('PENDING','CONFIRMED','NOSHOW')
          ORDER BY check_in_date ASC, id ASC
          LIMIT 10`,
        [hotelId, today]
      )
    : [];

  /* 批量取消确认框要显示「订单数量 / 日期范围 / 库存影响」，统一由 action 侧的同一口径算 */
  const overdue = canHandleBooking ? await overdueImpactAction() : null;

  const Card = ({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) => (
    <div className="rounded-[3px] border border-[#e8e8e8] bg-white">
      <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
        <span className="text-[13px] font-medium text-[#333]">{title}</span>
        {extra}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );

  const Stat = ({ label, value, unit, href }: { label: string; value: string | number; unit?: string; href?: string }) => (
    <div>
      <div className="text-[12px] text-[#888]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[20px] font-semibold tabular-nums text-[#222]">{value}</span>
        {unit && <span className="text-[11px] text-[#999]">{unit}</span>}
        {href && (
          <Link href={href} aria-label={`查看${label}`} className="ml-0.5 text-[12px] text-[#bbb] hover:text-[#2a9d5c]">
            ›
          </Link>
        )}
      </div>
    </div>
  );

  const Metric = ({ label, value, compare }: { label: string; value: string; compare?: string }) => (
    <div>
      <div className="text-[12px] text-[#888]">
        {label} <span className="text-[10px] text-[#ccc]">?</span>
      </div>
      <div className="mt-0.5 text-[19px] font-semibold tabular-nums text-[#222]">{value}</div>
      {compare && <div className="mt-0.5 text-[10.5px] text-[#999]">{compare}</div>}
    </div>
  );

  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-3 xl:grid-cols-[1fr_1.4fr_1fr]">
        {/* 宾客接待列表 */}
        <Card title="宾客接待列表">
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <Stat label="当前在住(间)" value={inhouse} href="/inhouse" />
            <Stat label="今日预抵(间)" value={arrivals} href="/today-todo?tab=arrivals" />
            <Stat label="今日预离(间)" value={departures} href="/today-todo?tab=departures" />
            <Stat label="今日可售(间)" value={sellable} href="/rooms" />
            <Stat label="当前占房数(间)" value={occupiedRooms} href="/rooms" />
          </div>
        </Card>

        {/* 今日客房收益 */}
        <Card
          title="今日客房收益"
          extra={
            <Link href="/reports?r=room-revenue" className="text-[12px] text-[#2a9d5c] hover:underline">
              更多详情 ›
            </Link>
          }
        >
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <Metric label="预计出租率" value={`${occRate.toFixed(2)}%`} compare="上周周期 91.11%" />
            <Metric label="预计间夜数(间)" value={String(nights)} compare={`上周周期 ${nights}`} />
            <Metric label="预计平均房价(元)" value={adr.toFixed(2)} compare="上周周期 145.69" />
            <Metric label="预计客房收益(RevPAR)" value={revpar.toFixed(2)} compare="上周周期 132.74" />
            <Metric label="预计总房费(元)" value={roomFee.toFixed(2)} compare="上周周期 5973.19" />
            <Metric label="预计总收入(元)" value={(roomFee + otherFee).toFixed(2)} compare="上周周期 5973.19" />
          </div>
        </Card>

        {/* 保洁任务 */}
        <Card
          title="保洁任务"
          extra={
            <Link href="/housekeeping" className="text-[12px] text-[#2a9d5c] hover:underline">
              保洁预估表
            </Link>
          }
        >
          <div className="grid grid-cols-4 gap-y-3 text-center">
            {[
              ["保洁任务", hkPending],
              ["检查任务", 0],
              ["待定任务", hkPending],
              ["未分配", 0],
              ["已分配", 0],
              ["加急", 0],
              ["已完成", hkDone],
            ].map(([label, value], i) => (
              <div key={i} className={i === 0 ? "text-left" : ""}>
                <div className="text-[12px] text-[#888]">{label}</div>
                <div className={`mt-0.5 text-[16px] font-semibold tabular-nums ${String(value) !== "0" ? "text-[#e53935]" : "text-[#999]"}`}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* 预抵与逾期处理（第六轮整改 一.4：补权限 + 批量取消二次确认 + 库存影响） */}
      <div className="grid gap-3 xl:grid-cols-2">
        {/* 今日预抵 */}
        <div className="rounded-[3px] border border-[#e8e8e8] bg-white">
          <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
            <span className="text-[13px] font-medium text-[#333]">今日预抵（待确认）</span>
            <span className="text-[11px] text-[#999]">
              {canHandleBooking ? `共 ${preArrivals.length} 条待确认（最多显示 10 条）` : "当前岗位无预订处理权限"}
            </span>
          </div>
          {canHandleBooking ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-[#f2faf3]">
                      <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">单号</th>
                      <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">客人</th>
                      <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">入住 / 离店</th>
                      <th className="w-24 border-b border-[#e8e8e8] px-2 py-2 text-right text-[12px] font-medium text-[#555]">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preArrivals.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-2 py-6 text-center text-[12px] text-[#999]">
                          今天没有待确认的预抵订单
                        </td>
                      </tr>
                    )}
                    {preArrivals.map((b) => (
                      <tr key={b.id} className="hover:bg-[#f7f9f8]">
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-[12px] tabular-nums text-[#555]">
                          {b.booking_no ?? `#${b.id}`}
                        </td>
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-[12px] text-[#333]">
                          {b.guest_name || "—"}
                          {Number(b.room_count ?? 1) > 1 && (
                            <span className="ml-1 text-[11px] text-[#999]">{b.room_count} 间</span>
                          )}
                        </td>
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-[12px] tabular-nums text-[#555]">
                          {b.check_in_date} → {b.check_out_date}
                        </td>
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-right">
                          {canModifyBooking ? (
                            <form action={confirmArrivalAction} className="inline">
                              <input type="hidden" name="id" value={b.id} />
                              <button className="rounded-[2px] border border-[#dcdcdc] px-2 py-0.5 text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]">
                                确认预抵
                              </button>
                            </form>
                          ) : (
                            <span className="text-[11px] text-[#ccc]">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canModifyBooking && (
                <form
                  action={confirmAllArrivalsAction}
                  className="flex items-center justify-between gap-2 border-t border-[#f0f0f0] px-3 py-2"
                >
                  <span className="text-[11px] text-[#999]">
                    批量确认会把今天全部「待排房」预抵置为已确认（只改状态，不排房）
                  </span>
                  <button className="rounded-[2px] bg-[#32c141] px-2.5 py-1 text-[11.5px] text-white hover:bg-[#2bb038]">
                    批量确认预抵
                  </button>
                </form>
              )}
            </>
          ) : (
            <div className="px-3 py-6 text-center text-[12px] text-[#999]">
              确认预抵需要「修改预订」权限（管理员 / 前台）
            </div>
          )}
        </div>

        {/* 逾期未到订单 */}
        <div className="rounded-[3px] border border-[#e8e8e8] bg-white">
          <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
            <span className="text-[13px] font-medium text-[#333]">逾期未到订单</span>
            <span className="text-[11px] text-[#999]">
              {overdue && overdue.orders > 0
                ? `共 ${overdue.orders} 单 · ${overdue.minIn} ~ ${overdue.maxOut}`
                : "无逾期订单"}
            </span>
          </div>

          {!canHandleBooking ? (
            <div className="px-3 py-6 text-center text-[12px] text-[#999]">
              逾期处理需要「取消预订」/「修改预订」权限（管理员 / 前台）
            </div>
          ) : !overdue || overdue.orders === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-[#999]">没有应到未到 / 逾期未到的订单</div>
          ) : (
            <>
              {/* 库存影响：与批量取消确认框、操作日志同一口径 */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-[#f8f8f8] px-3 py-2 text-[11.5px] text-[#666]">
                <span>
                  合计 <b className="text-[#222]">{overdue.nights}</b> 间夜
                </span>
                <span>
                  占房明细 <b className="text-[#222]">{overdue.rooms}</b> 间（已排房号 {overdue.assigned} 间）
                </span>
                <span>
                  覆盖今日 <b className="text-[#e53935]">{overdue.occupyToday}</b> 间 → 取消后今日可售 +
                  {overdue.occupyToday}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-[#f2faf3]">
                      <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">单号</th>
                      <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">客人</th>
                      <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">原入住 / 离店</th>
                      <th className="w-40 border-b border-[#e8e8e8] px-2 py-2 text-right text-[12px] font-medium text-[#555]">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdueRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-2 py-6 text-center text-[12px] text-[#999]">
                          没有逾期订单
                        </td>
                      </tr>
                    )}
                    {overdueRows.map((b) => (
                      <tr key={b.id} className="hover:bg-[#f7f9f8]">
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-[12px] tabular-nums text-[#555]">
                          {b.booking_no ?? `#${b.id}`}
                        </td>
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-[12px] text-[#333]">
                          {b.guest_name || "—"}
                          {Number(b.room_count ?? 1) > 1 && (
                            <span className="ml-1 text-[11px] text-[#999]">{b.room_count} 间</span>
                          )}
                        </td>
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-[12px] tabular-nums text-[#555]">
                          {b.check_in_date} → {b.check_out_date}
                          <span className="ml-1 text-[11px] text-[#999]">{b.nights ?? 1} 晚</span>
                        </td>
                        <td className="border-b border-[#f6f6f6] px-2 py-1.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {canCancelBooking && (
                              <ConfirmForm
                                action={cancelOverdueAction}
                                message={`确认取消逾期订单 ${b.booking_no ?? `#${b.id}`}？`}
                                detail={`${b.check_in_date} → ${b.check_out_date}（${b.nights ?? 1} 晚）。取消后这间房的占用会立即释放，订单状态变为「已取消」，可在预订列表查到但不能恢复。`}
                                confirmLabel="确认取消"
                                requireReason="取消原因"
                              >
                                <input type="hidden" name="id" value={b.id} />
                                <button className="rounded-[2px] border border-[#f0c9c6] px-2 py-0.5 text-[11.5px] text-[#d9534f] hover:bg-[#fdf3f3]">
                                  取消
                                </button>
                              </ConfirmForm>
                            )}
                            {canModifyBooking && (
                              <form action={convertOverdueAction} className="inline">
                                <input type="hidden" name="id" value={b.id} />
                                <button
                                  className="rounded-[2px] border border-[#dcdcdc] px-2 py-0.5 text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d5c]"
                                  title="入住日顺延到今天，离店日按原晚数重算，房号释放回待排房"
                                >
                                  转今日预订
                                </button>
                              </form>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {canCancelBooking && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#f0f0f0] px-3 py-2">
                  <span className="text-[11px] text-[#999]">
                    批量取消会取消全部 {overdue.orders} 张逾期订单并释放房量占用（不可恢复）
                  </span>
                  <ConfirmForm
                    action={cancelAllOverdueAction}
                    message={`确认批量取消 ${overdue.orders} 张逾期订单？`}
                    detail={
                      `订单数量：${overdue.orders} 张；` +
                      `日期范围：${overdue.minIn} ~ ${overdue.maxOut}（合计 ${overdue.nights} 间夜）；` +
                      `库存影响：释放 ${overdue.rooms} 间房占用（其中 ${overdue.assigned} 间已排具体房号），` +
                      `今日可售 +${overdue.occupyToday} 间，其他日期的可售量同步恢复；` +
                      `取消后订单保留在预订列表可查询，但不能恢复`
                    }
                    confirmLabel="确认批量取消"
                    requireReason="取消原因"
                  >
                    <button className="rounded-[2px] bg-[#d9534f] px-2.5 py-1 text-[11.5px] text-white hover:bg-[#c9302c]">
                      批量取消逾期
                    </button>
                  </ConfirmForm>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.55fr_1fr]">
        {/* 前台待办 */}
        <div className="space-y-3">
          <div className="rounded-[3px] border border-[#e8e8e8] bg-white">
            <div className="border-b border-[#f0f0f0] px-3 py-2 text-[13px] font-medium text-[#333]">前台待办</div>
            <div className="flex flex-wrap gap-1.5 border-b border-[#f8f8f8] px-3 py-2">
              {TODO_TABS.map((t, i) => (
                <span
                  key={t.key}
                  className={`rounded-[2px] px-2 py-1 text-[12px] ${
                    i === 0 ? "bg-[#3bd943] text-white" : "border border-[#e5e5e5] bg-white text-[#555]"
                  }`}
                >
                  {t.label} {todoCounts[t.key] ?? 0}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 border-b border-[#f8f8f8] px-3 py-2">
              {TODO_TAGS.map((tag, i) => (
                <span
                  key={tag}
                  className={`rounded-[2px] px-2 py-0.5 text-[11.5px] ${
                    i === 0 ? "bg-[#eef9f0] text-[#2a9d5c]" : "text-[#666]"
                  }`}
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-2">
              <button className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#999]" disabled>
                批量标记为已读
              </button>
              <button className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#999]" disabled>
                查看全部
              </button>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#f2faf3]">
                  <th className="w-8 border-b border-[#e8e8e8] px-2 py-2"></th>
                  <th className="w-24 border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">类型</th>
                  <th className="border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">消息内容</th>
                  <th className="w-28 border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">发布时间</th>
                  <th className="w-16 border-b border-[#e8e8e8] px-2 py-2 text-left text-[12px] font-medium text-[#555]">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={5} className="px-2 py-10 text-center text-[12px] text-[#999]">
                    暂无待办
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#f0f0f0] px-3 py-2 text-[12px] text-[#666]">
              <span>共 0 条记录</span>
              <span className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[#bbb]">上一页</span>
              <span className="flex h-5 w-5 items-center justify-center rounded-[2px] bg-[#3bd943] text-white">1</span>
              <span className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[#bbb]">下一页</span>
            </div>
          </div>
        </div>

        {/* 右侧栏 */}
        <div className="space-y-3">
          <Card
            title="交接班"
            extra={
              <Link href="/reports?r=shift-report" className="text-[12px] text-[#2a9d5c] hover:underline">
                交班报表
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[12px] text-[#888]">消费合计</div>
                <div className="text-[17px] font-semibold tabular-nums text-[#222]">{Number(shifts.consume ?? 0).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[12px] text-[#888]">收款合计</div>
                <div className="text-[17px] font-semibold tabular-nums text-[#222]">{Number(payments ?? 0).toFixed(2)}</div>
              </div>
            </div>
            <div className="mt-2 text-[11.5px] text-[#888]">
              班次：{today.slice(5)} 早班　操作人：{user.realName}
            </div>
          </Card>

          <Card
            title="夜审"
            extra={
              <Link href="/reports?r=night-audit" className="text-[12px] text-[#2a9d5c] hover:underline">
                夜审记录表
              </Link>
            }
          >
            <div className="text-[12px] text-[#555]">
              营业日：<b className="text-[#222]">{nightAudit?.biz_date ?? today}</b>　操作人：
              <b className="text-[#222]">{nightAudit?.operator ?? "系统"}</b>
            </div>
            <div className="mt-2 flex gap-1.5">
              <Link
                href="/night-audit"
                className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#666] hover:border-[#32c141] hover:text-[#2a9d5c]"
              >
                夜审步骤
              </Link>
              <span className="rounded-[2px] border border-[#e5e5e5] px-2 py-0.5 text-[11.5px] text-[#666]">
                6点自动夜审已开启
              </span>
            </div>
          </Card>

          <Card
            title="公告"
            extra={
              <Link href="/notices" className="text-[12px] text-[#2a9d5c] hover:underline">
                全部 ›
              </Link>
            }
          >
            {notices.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[#999]">暂无公告</div>
            ) : (
              <ul className="space-y-1.5">
                {notices.map((n) => (
                  <li key={n.id} className="truncate text-[12px] text-[#555]">
                    · {n.title}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-3 rounded-[3px] border border-[#e8e8e8] bg-white p-3">
            <div className="text-center">
              <div className="text-[12px] text-[#333]">扫码添加</div>
              <div className="text-[11px] text-[#999]">小管家企业微信</div>
              <div className="mx-auto mt-2 flex h-16 w-16 items-center justify-center rounded border border-dashed border-[#ddd] text-[10px] text-[#bbb]">
                二维码
              </div>
            </div>
            <div className="text-center">
              <div className="text-[12px] text-[#333]">扫码登录</div>
              <div className="text-[11px] text-[#999]">酒店管家PMS小程序</div>
              <div className="mx-auto mt-2 flex h-16 w-16 items-center justify-center rounded border border-dashed border-[#ddd] text-[10px] text-[#bbb]">
                二维码
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
