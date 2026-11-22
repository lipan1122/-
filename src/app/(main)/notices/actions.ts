"use server";

import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

export async function createNoticeAction(formData: FormData) {
  const user = await requireUser();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  run(`INSERT INTO notices (hotel_id, title, content, author, level, created_at) VALUES (?,?,?,?,?,?)`, [
    user.hotelId,
    title,
    String(formData.get("content") ?? ""),
    user.realName,
    String(formData.get("level") ?? "normal"),
    nowIso(),
  ]);
  revalidatePath("/notices");
}

export async function deleteNoticeAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (id) run(`DELETE FROM notices WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  revalidatePath("/notices");
}
