"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { nowIso, todayStr } from "@/lib/utils";

/**
 * 懒建表：早餐核销记录。
 * status：PENDING 待核销 / USED 已核销；一份记录对应一间在住房间的一个早餐日。
 */
function ensureBreakfastTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS breakfast_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      guest_name TEXT,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      note TEXT,
      created_at TEXT
    );
  `);
}

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: FormDataEntryValue | null): number {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 回到指定日期的列表页，可带成功 / 失败提示 */
function backTo(date: string, msg?: string, err?: string): string {
  const p = new URLSearchParams();
  if (date) p.set("date", date);
  if (msg) p.set("msg", msg);
  if (err) p.set("err", err);
  const qs = p.toString();
  return qs ? `/breakfast?${qs}` : "/breakfast";
}

/** 单条核销：把一条待核销记录置为已核销 */
export async function redeemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureBreakfastTable();

  const id = num(formData.get("id"));
  const date = str(formData.get("date")) || todayStr();
  if (!id) redirect(backTo(date, undefined, "没有找到要核销的早餐记录"));

  const row = get<{ count: number; status: string; room_no: string | null }>(
    `SELECT count, status, room_no FROM breakfast_records WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) redirect(backTo(date, undefined, "该早餐记录不存在或已删除"));
  if (row.status === "USED") redirect(backTo(date, undefined, `${row.room_no ?? "该房"} 早餐已核销，无需重复核销`));

  run(
    `UPDATE breakfast_records
        SET status = 'USED',
            note = CASE WHEN note IS NULL OR note = '' THEN '已核销' ELSE note END
      WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`,
    [id, user.hotelId]
  );

  revalidatePath("/breakfast");
  redirect(backTo(date, `${row.room_no ?? "该房"} 早餐 ${row.count} 份已核销`));
}

/** 批量核销：勾选多行后一次核销（表单里以 name="ids" 的复选框传递） */
export async function bulkRedeemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureBreakfastTable();

  const date = str(formData.get("date")) || todayStr();
  const ids = formData
    .getAll("ids")
    .map((v) => num(v))
    .filter((n) => n > 0);

  if (ids.length === 0) redirect(backTo(date, undefined, "请先勾选要核销的房间"));

  const placeholders = ids.map(() => "?").join(", ");
  const result = run(
    `UPDATE breakfast_records
        SET status = 'USED'
      WHERE hotel_id = ? AND date = ? AND status = 'PENDING' AND id IN (${placeholders})`,
    [user.hotelId, date, ...ids]
  );

  revalidatePath("/breakfast");
  if (result.changes === 0) redirect(backTo(date, undefined, "勾选的早餐都已核销，无需重复操作"));
  redirect(backTo(date, `已批量核销 ${result.changes} 间房的早餐`));
}

/** 全部核销：一次核销当日所有待核销早餐 */
export async function redeemAllAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureBreakfastTable();

  const date = str(formData.get("date")) || todayStr();
  const result = run(
    `UPDATE breakfast_records SET status = 'USED' WHERE hotel_id = ? AND date = ? AND status = 'PENDING'`,
    [user.hotelId, date]
  );

  revalidatePath("/breakfast");
  if (result.changes === 0) redirect(backTo(date, undefined, "当日没有待核销的早餐"));
  redirect(backTo(date, `已将当日全部早餐核销（${result.changes} 间房）`));
}

/** 撤销核销：已核销记录回退为待核销 */
export async function revokeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureBreakfastTable();

  const id = num(formData.get("id"));
  const date = str(formData.get("date")) || todayStr();
  if (!id) redirect(backTo(date, undefined, "没有找到要撤销的早餐记录"));

  const row = get<{ room_no: string | null; status: string }>(
    `SELECT room_no, status FROM breakfast_records WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) redirect(backTo(date, undefined, "该早餐记录不存在或已删除"));
  if (row.status !== "USED") redirect(backTo(date, undefined, `${row.room_no ?? "该房"} 当前是待核销状态`));

  run(
    `UPDATE breakfast_records SET status = 'PENDING', note = '撤销核销' WHERE id = ? AND hotel_id = ? AND status = 'USED'`,
    [id, user.hotelId]
  );

  revalidatePath("/breakfast");
  redirect(backTo(date, `${row.room_no ?? "该房"} 早餐已撤销核销`));
}

/** 卖早餐：给某间在住房间加早餐份数，同步更新 stays.breakfast 与当日核销记录 */
export async function sellBreakfastAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureBreakfastTable();

  const today = todayStr();
  const stayId = num(formData.get("stayId"));
  const count = num(formData.get("count"));

  if (!stayId) redirect(backTo(today, undefined, "请选择要加早餐的在住房间"));
  if (count < 1 || count > 20) redirect(backTo(today, undefined, "早餐份数需为 1 - 20 份的整数"));

  const stay = get<{ room_no: string | null; guest_name: string | null; breakfast: number | null }>(
    `SELECT r.room_no, s.guest_name, COALESCE(s.breakfast, 0) AS breakfast
       FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.id = ? AND s.hotel_id = ? AND s.status = 'INHOUSE'`,
    [stayId, user.hotelId]
  );
  if (!stay) redirect(backTo(today, undefined, "该房间当前不在住，无法加卖早餐"));

  const record = get<{ id: number; count: number }>(
    `SELECT id, count FROM breakfast_records
      WHERE hotel_id = ? AND stay_id = ? AND date = ?
      ORDER BY id LIMIT 1`,
    [user.hotelId, stayId, today]
  );

  // 1) 在住单早餐份数 + N
  run(`UPDATE stays SET breakfast = COALESCE(breakfast, 0) + ? WHERE id = ? AND hotel_id = ?`, [
    count,
    stayId,
    user.hotelId,
  ]);

  // 2) 当日记录 + N；原来没有记录（无早房）则新建一条待核销
  if (record) {
    run(
      `UPDATE breakfast_records SET count = count + ?, status = 'PENDING', note = ?
        WHERE id = ? AND hotel_id = ?`,
      [count, `卖早餐 +${count} 份`, record.id, user.hotelId]
    );
  } else {
    run(
      `INSERT INTO breakfast_records
         (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, stayId, stay.room_no, stay.guest_name ?? "散客", today, count, "PENDING", `卖早餐 ${count} 份`, nowIso()]
    );
  }

  const total = (record ? record.count : 0) + count;
  revalidatePath("/breakfast");
  revalidatePath("/inhouse");
  redirect(
    backTo(
      today,
      `${stay.room_no ?? "该房"}${stay.guest_name ? `（${stay.guest_name}）` : ""} 加卖早餐 ${count} 份，当前待核销 ${total} 份`
    )
  );
}
