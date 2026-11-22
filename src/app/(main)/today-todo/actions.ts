"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, nightsBetween, nowIso, todayStr } from "@/lib/utils";

/** 逾期预订行：转预订时用于推算新的入住 / 离店日期 */
type OverdueRow = {
  id: number;
  nights: number | null;
  check_in_date: string;
  check_out_date: string;
};

/** 表单值转正整数，非法值返回 0 */
function readId(value: FormDataEntryValue | null): number {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
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

/** 批量确认今日预抵：所有今天到店且仍「待排房」的预订置为已确认 */
export async function confirmAllArrivalsAction(): Promise<void> {
  const user = await requireUser();
  const today = todayStr();

  const res = run(
    `UPDATE bookings SET status = 'CONFIRMED', updated_at = ?
     WHERE hotel_id = ? AND check_in_date = ? AND status = 'PENDING'`,
    [nowIso(), user.hotelId, today]
  );

  if (res.changes > 0) {
    logOp(user.hotelId, user.realName, "批量确认预抵", `${today} 共确认 ${res.changes} 条预抵预订`);
  }

  revalidateTodo();
}

/** 确认单条预抵（待排房 → 已确认） */
export async function confirmArrivalAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = readId(formData.get("id"));
  if (!id) return;

  run(
    `UPDATE bookings SET status = 'CONFIRMED', updated_at = ?
     WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`,
    [nowIso(), id, user.hotelId]
  );

  revalidateTodo();
}

/** 批量取消逾期未到：今天之前应到未到的预订（待排房 / 已确认 / 未到）全部取消 */
export async function cancelAllOverdueAction(): Promise<void> {
  const user = await requireUser();
  const today = todayStr();

  const res = run(
    `UPDATE bookings SET status = 'CANCELLED', updated_at = ?
     WHERE hotel_id = ? AND check_in_date < ? AND status IN ('PENDING','CONFIRMED','NOSHOW')`,
    [nowIso(), user.hotelId, today]
  );

  if (res.changes > 0) {
    logOp(user.hotelId, user.realName, "批量取消逾期", `共取消 ${res.changes} 条逾期未到预订`);
  }

  revalidateTodo();
}

/** 取消单条逾期预订 */
export async function cancelOverdueAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = readId(formData.get("id"));
  if (!id) return;

  run(
    `UPDATE bookings SET status = 'CANCELLED', updated_at = ?
     WHERE id = ? AND hotel_id = ? AND status IN ('PENDING','CONFIRMED','NOSHOW')`,
    [nowIso(), id, user.hotelId]
  );

  revalidateTodo();
}

/** 逾期订单转今日预订：入住日顺延到今天，离店日按原晚数重算，状态置为已确认 */
export async function convertOverdueAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = readId(formData.get("id"));
  if (!id) return;

  const row = get<OverdueRow>(
    `SELECT id, nights, check_in_date, check_out_date FROM bookings WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) return;

  const nights = Math.max(
    1,
    Math.trunc(row.nights && row.nights > 0 ? row.nights : nightsBetween(row.check_in_date, row.check_out_date))
  );
  const today = todayStr();
  const checkOut = todayStr(addDays(today, nights));

  run(
    `UPDATE bookings
        SET check_in_date = ?, check_out_date = ?, nights = ?, status = 'CONFIRMED', updated_at = ?
      WHERE id = ? AND hotel_id = ?`,
    [today, checkOut, nights, nowIso(), id, user.hotelId]
  );

  logOp(user.hotelId, user.realName, "逾期转预订", `预订单 #${id} 顺延至 ${today} → ${checkOut}（${nights} 晚）`);

  revalidateTodo();
}
