"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 懒建表：打扫员。
 * status：ACTIVE 在岗 / INACTIVE 已停用；业绩来自 housekeeping 表中 assignee = 姓名的已完成任务。
 */
function ensureCleanersTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS cleaners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
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

function backTo(msg?: string, err?: string): string {
  const p = new URLSearchParams();
  if (msg) p.set("msg", msg);
  if (err) p.set("err", err);
  const qs = p.toString();
  return qs ? `/cleaners?${qs}` : "/cleaners";
}

/** 新增打扫员：姓名必填且不重名，电话可空 */
export async function addCleanerAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureCleanersTable();

  const name = str(formData.get("name"));
  const phone = str(formData.get("phone"));

  if (!name) redirect(backTo(undefined, "请输入打扫员姓名"));
  if (name.length > 20) redirect(backTo(undefined, "姓名不能超过 20 个字"));
  if (phone && !/^[\d+\-\s]{5,20}$/.test(phone)) redirect(backTo(undefined, "电话格式不正确，请填写 5-20 位号码"));

  const dup = get<{ id: number }>(`SELECT id FROM cleaners WHERE hotel_id = ? AND name = ?`, [
    user.hotelId,
    name,
  ]);
  if (dup) redirect(backTo(undefined, `已存在名为「${name}」的打扫员`));

  run(`INSERT INTO cleaners (hotel_id, name, phone, status, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    name,
    phone || null,
    "ACTIVE",
    nowIso(),
  ]);

  revalidatePath("/cleaners");
  redirect(backTo(`已新增打扫员 ${name}`));
}

/** 停用 / 启用打扫员：停用后不再参与派单，历史业绩保留 */
export async function setCleanerStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureCleanersTable();

  const id = num(formData.get("id"));
  const status = str(formData.get("status")) === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  if (!id) redirect(backTo(undefined, "没有找到要操作的打扫员"));

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM cleaners WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) redirect(backTo(undefined, "该打扫员不存在或已删除"));
  if (row.status === status) {
    redirect(backTo(undefined, `${row.name} 已经是${status === "ACTIVE" ? "在岗" : "停用"}状态`));
  }

  run(`UPDATE cleaners SET status = ? WHERE id = ? AND hotel_id = ?`, [status, id, user.hotelId]);

  revalidatePath("/cleaners");
  redirect(backTo(`${row.name} 已${status === "ACTIVE" ? "启用" : "停用"}`));
}
