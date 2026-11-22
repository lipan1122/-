"use server";

import { revalidatePath } from "next/cache";
import { get, run, tx } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { addDays, nightsBetween, nowIso, todayStr } from "@/lib/utils";

/**
 * 今日待办 / 逾期订单动作层（第六轮整改清单一.4）
 *
 * ── 整改前的问题 ──
 * 5 个写动作（确认预抵、批量确认、取消逾期、批量取消、逾期转今日预订）全部只调
 * `requireUser()`：任何登录账号（含客房阿姨）构造一个表单请求就能取消全店逾期订单。
 *
 * ── 本轮改动（逐条对应清单第 57-71 行）──
 *   1. 权限：确认预抵 / 逾期转今日预订 → `booking.modify`；
 *      取消逾期（单条 + 批量）→ `booking.cancel`（与 /bookings 单条 / 批量取同一个点）。
 *   2. 取消必须释放 booking_rooms：旧实现只 `UPDATE bookings SET status`，
 *      明细还挂着 room_id + PENDING/CONFIRMED，`lib/room-stock.ts` 的占房口径
 *      （status IN ('PENDING','CONFIRMED') AND 区间覆盖当天）照旧把它们算作占用 ——
 *      订单取消了、房量却没回来，前台看到「已取消」但排不出这间房。
 *      现在与 bookings/actions.ts 的 cancelBookingAction 完全同口径：
 *      明细 `room_id = NULL, status = 'CANCELLED'`，主单 `room_id = NULL`。
 *   3. 逾期转今日预订必须同时顺延 booking_rooms 的日期：旧实现只改主单日期，
 *      明细还停在过去的区间 —— room-stock 按明细判占用（主单在「有有效明细」时不兜底），
 *      结果这张单顺延到今天就等于「不占房」，直接超卖。
 *      顺延的同时把具体房号释放回 PENDING（逾期未到的客人从没住进那间房，
 *      旧房号在新日期上也未必空着），由前台按新日期重新排房。
 *   4. 每个动作都在 tx() 里写 op_logs（状态、间夜、释放间数、操作人），
 *      日志与业务写入同事务，不会出现「改了单没留痕」。
 *   5. 所有 SQL 都带 hotel_id：不能跨酒店改订单（页面/请求参数里的 id 一律先按本店过滤）。
 */

/** 逾期预订行：转预订时用于推算新的入住 / 离店日期 */
type OverdueRow = {
  id: number;
  nights: number | null;
  check_in_date: string;
  check_out_date: string;
  status: string;
};

/** 计入「逾期未到」的订单状态（与列表 / 批量取消 / 转预订三处口径一致） */
const OVERDUE_STATUSES = ["PENDING", "CONFIRMED", "NOSHOW"] as const;

/** 还能被取消的明细状态：CHECKED_IN 已转在住，取消订单不能动它 */
const OPEN_DETAIL_STATUSES = ["PENDING", "CONFIRMED"] as const;

/** 库存影响汇总（批量取消确认框与操作日志共用一份口径） */
type OverdueImpact = {
  /** 逾期订单数 */
  orders: number;
  /** 最早 / 最晚的日期（确认框显示日期范围） */
  minIn: string;
  maxOut: string;
  /** 合计间夜 */
  nights: number;
  /** 仍有效的 booking_rooms 明细间数（取消后释放） */
  rooms: number;
  /** 其中已排了具体房号的间数 */
  assigned: number;
  /** 其中区间覆盖今天的间数（取消后今日可售增加这么多） */
  occupyToday: number;
};

/** 表单值转正整数，非法值返回 0 */
function readId(value: FormDataEntryValue | null): number {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 表单文本（取消原因等），统一去空白 + 限长，避免把整段粘贴内容塞进 op_logs */
function readText(value: FormDataEntryValue | null, max = 120): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 操作日志：op_logs 不存在时静默跳过，避免旧库直接报错 */
function logOp(hotelId: number, operator: string, action: string, detail: string): void {
  const exists =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0;
  if (exists === 0) return;
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

function revalidateTodo() {
  revalidatePath("/today-todo");
  revalidatePath("/bookings");
  revalidatePath("/frontdesk");
  revalidatePath("/inhouse");
  revalidatePath("/cashier");
  revalidatePath("/dashboard");
}

/**
 * 逾期订单的库存影响（只读）：页面确认框与动作日志都用这一份口径算，
 * 避免「弹窗说 12 间、实际释放 30 间」这种对不上账的文案。
 *
 * 明细口径与 lib/room-stock.ts 一致：只有 PENDING/CONFIRMED 的明细还占房；
 * 「覆盖今天」= check_in_date <= 今天 < check_out_date（左闭右开，退房当天可以接续）。
 */
export async function overdueImpactAction(): Promise<OverdueImpact> {
  // 只读动作：页面渲染前后都可能调用，保留登录校验即可（不写库）
  const user = await requirePermission("booking.view");
  return overdueImpact(user.hotelId, todayStr());
}

function overdueImpact(hotelId: number, today: string): OverdueImpact {
  const agg = get<{ orders: number; min_in: string | null; max_out: string | null; nights: number | null }>(
    `SELECT COUNT(*) AS orders,
            MIN(check_in_date) AS min_in,
            MAX(check_out_date) AS max_out,
            COALESCE(SUM(COALESCE(nights, 1)), 0) AS nights
       FROM bookings
      WHERE hotel_id = ? AND check_in_date < ? AND status IN ('PENDING','CONFIRMED','NOSHOW')`,
    [hotelId, today]
  );
  const rooms = get<{ rooms: number; assigned: number; occupy_today: number }>(
    `SELECT COUNT(*) AS rooms,
            COALESCE(SUM(CASE WHEN br.room_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS assigned,
            COALESCE(SUM(CASE WHEN br.check_in_date <= ? AND br.check_out_date > ? THEN 1 ELSE 0 END), 0) AS occupy_today
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
      WHERE br.hotel_id = ?
        AND br.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date < ? AND b.status IN ('PENDING','CONFIRMED','NOSHOW')`,
    [today, today, hotelId, today]
  );

  return {
    orders: Number(agg?.orders ?? 0),
    minIn: agg?.min_in ?? "",
    maxOut: agg?.max_out ?? "",
    nights: Math.round(Number(agg?.nights ?? 0)),
    rooms: Number(rooms?.rooms ?? 0),
    assigned: Number(rooms?.assigned ?? 0),
    occupyToday: Number(rooms?.occupy_today ?? 0),
  };
}

/** 批量确认今日预抵：所有今天到店且仍「待排房」的预订置为已确认 */
export async function confirmAllArrivalsAction(): Promise<void> {
  // 权限（清单第 65 行）：确认预抵属于订单状态修改 → booking.modify（admin / frontdesk）
  const user = await requirePermission("booking.modify");
  const hotelId = user.hotelId;
  const today = todayStr();

  tx(() => {
    const res = run(
      `UPDATE bookings SET status = 'CONFIRMED', updated_at = ?
       WHERE hotel_id = ? AND check_in_date = ? AND status = 'PENDING'`,
      [nowIso(), hotelId, today]
    );
    if (res.changes > 0) {
      logOp(hotelId, user.realName, "批量确认预抵", `${today} 共确认 ${res.changes} 条预抵预订`);
    }
  });

  revalidateTodo();
}

/** 确认单条预抵（待排房 → 已确认） */
export async function confirmArrivalAction(formData: FormData): Promise<void> {
  // 权限（清单第 65 行）：booking.modify
  const user = await requirePermission("booking.modify");
  const hotelId = user.hotelId;
  const id = readId(formData.get("id"));
  if (!id) return;

  tx(() => {
    // WHERE 里同时限定 hotel_id：别人家的 single id 传进来也改不动
    const res = run(
      `UPDATE bookings SET status = 'CONFIRMED', updated_at = ?
       WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`,
      [nowIso(), id, hotelId]
    );
    // 只有真的改到了才写日志（重复点击 / 已被别人确认过 → 不刷日志）
    if (res.changes > 0) logOp(hotelId, user.realName, "确认预抵", `预订单 #${id} 已确认（原状态：待排房）`);
  });

  revalidateTodo();
}

/** 批量取消逾期未到：今天之前应到未到的预订（待排房 / 已确认 / 未到）全部取消 */
export async function cancelAllOverdueAction(formData?: FormData): Promise<void> {
  // 权限（清单第 66 行）：取消订单 → booking.cancel（admin / frontdesk）
  const user = await requirePermission("booking.cancel");
  const hotelId = user.hotelId;
  const today = todayStr();
  // 二次确认弹窗里填的取消原因（ConfirmForm 的字段名固定为 reason）
  const reason = readText(formData?.get("reason") ?? null);

  tx(() => {
    // 日志里的日期范围 / 间夜 / 释放间数：必须在 UPDATE 之前算（UPDATE 之后条件就不成立了）
    const before = overdueImpact(hotelId, today);

    /*
     * ① 先释放明细占用（整改关键点：取消后 booking_rooms 必须释放）
     *    子查询与下面 ② 的主单条件逐字一致，保证「释放的明细」与「取消的主单」是同一批。
     */
    const released = run(
      `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
        WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED')
          AND booking_id IN (SELECT id FROM bookings
                              WHERE hotel_id = ? AND check_in_date < ?
                                AND status IN ('PENDING','CONFIRMED','NOSHOW'))`,
      [hotelId, hotelId, today]
    ).changes;

    /* ② 再改主单状态，并清掉主单上的房号镜像（否则房态图仍显示这间房被占） */
    const res = run(
      `UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ?
       WHERE hotel_id = ? AND check_in_date < ? AND status IN ('PENDING','CONFIRMED','NOSHOW')`,
      [nowIso(), hotelId, today]
    );

    if (res.changes > 0 || released > 0) {
      const range = before.minIn ? `${before.minIn} ~ ${before.maxOut}` : "无";
      logOp(
        hotelId,
        user.realName,
        "批量取消逾期",
        `共取消 ${res.changes} 张逾期订单（日期 ${range}，合计 ${before.nights} 间夜），` +
          `释放 ${released} 间 booking_rooms 占用（含已排房号 ${before.assigned} 间、覆盖今日 ${before.occupyToday} 间）` +
          (reason ? `；原因：${reason}` : "")
      );
    }
  });

  revalidateTodo();
}

/** 取消单条逾期预订 */
export async function cancelOverdueAction(formData: FormData): Promise<void> {
  // 权限（清单第 66 行）：booking.cancel
  const user = await requirePermission("booking.cancel");
  const hotelId = user.hotelId;
  const id = readId(formData.get("id"));
  if (!id) return;
  const reason = readText(formData.get("reason"));

  tx(() => {
    const row = get<{ id: number; check_in_date: string; check_out_date: string; status: string }>(
      `SELECT id, check_in_date, check_out_date, status FROM bookings WHERE id = ? AND hotel_id = ?`,
      [id, hotelId]
    );
    // 跨酒店 / 不存在 → 什么都不做（不会命中别人家的订单）
    if (!row) return;
    // 已入住不能在这里取消（要走 /inhouse 的取消入住审批）；已取消不重复处理
    if (!overdueCancellable(row.status)) return;

    // 明细释放：与批量取消、bookings/actions.ts 的 cancelBookingAction 同一口径
    const released = run(
      `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
        WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [hotelId, id]
    ).changes;

    run(
      `UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`,
      [nowIso(), id, hotelId]
    );

    logOp(
      hotelId,
      user.realName,
      "取消逾期预订",
      `预订单 #${id}（${row.check_in_date} → ${row.check_out_date}）取消，释放 ${released} 间房占用` +
        (reason ? `；原因：${reason}` : "")
    );
  });

  revalidateTodo();
}

/** 单条取消允许的起始状态：与 OVERDUE_STATUSES 一致（不含 CHECKED_IN / CANCELLED） */
function overdueCancellable(status: string): boolean {
  return (OVERDUE_STATUSES as readonly string[]).includes(status);
}

/**
 * 逾期订单转今日预订：入住日顺延到今天，离店日按原晚数重算，状态置为已确认。
 *
 * 同时顺延 booking_rooms 的日期并释放具体房号（见文件头第 3 条）：
 *   · 只改主单 = 明细还停在过去区间 → room-stock 认为这张单不占房 → 超卖；
 *   · 保留原房号 = 把客人塞进一间未必空着的房 → 与别人撞房。
 */
export async function convertOverdueAction(formData: FormData): Promise<void> {
  // 权限（清单第 67 行）：逾期转今日预订属于订单状态/日期修改 → booking.modify
  const user = await requirePermission("booking.modify");
  const hotelId = user.hotelId;
  const id = readId(formData.get("id"));
  if (!id) return;

  const today = todayStr();

  tx(() => {
    const row = get<OverdueRow>(
      `SELECT id, nights, check_in_date, check_out_date, status FROM bookings WHERE id = ? AND hotel_id = ?`,
      [id, hotelId]
    );
    // 跨酒店 / 不存在
    if (!row) return;
    // 只有「逾期未到」的单子能顺延；已入住 / 已取消不动
    if (!overdueCancellable(row.status)) return;
    // 今天到店或未来的订单本来就不需要顺延，避免被这个动作把日期往前推
    if (!(row.check_in_date < today)) return;

    const nights = Math.max(
      1,
      Math.trunc(row.nights && row.nights > 0 ? row.nights : nightsBetween(row.check_in_date, row.check_out_date))
    );
    const checkOut = todayStr(addDays(today, nights));

    // ① 明细日期一起顺延，并释放具体房号（回到待排房，由前台按新日期重排）
    const shifted = run(
      `UPDATE booking_rooms
          SET check_in_date = ?, check_out_date = ?, room_id = NULL, status = 'PENDING'
        WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [today, checkOut, hotelId, id]
    ).changes;

    // ② 主单日期 / 晚数 / 状态（房号镜像一并清掉，与明细保持一致）
    run(
      `UPDATE bookings
          SET check_in_date = ?, check_out_date = ?, nights = ?, status = 'CONFIRMED',
              room_id = NULL, updated_at = ?
        WHERE id = ? AND hotel_id = ?`,
      [today, checkOut, nights, nowIso(), id, hotelId]
    );

    logOp(
      hotelId,
      user.realName,
      "逾期转预订",
      `预订单 #${id} 顺延至 ${today} → ${checkOut}（${nights} 晚），` +
        `同步顺延 ${shifted} 条房明细并释放房号（回到待排房）`
    );
  });

  revalidateTodo();
}
