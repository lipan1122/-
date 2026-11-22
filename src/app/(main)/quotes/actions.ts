"use server";

import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

export async function saveQuoteAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id") ?? 0);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const values = [
    name,
    Number(formData.get("room_type_id")) || null,
    Number(formData.get("price")) || 0,
    String(formData.get("start_date") ?? ""),
    String(formData.get("end_date") ?? ""),
    String(formData.get("note") ?? ""),
  ];
  if (id) {
    run(
      `UPDATE quotes SET name=?, room_type_id=?, price=?, start_date=?, end_date=?, note=? WHERE id=? AND hotel_id=?`,
      [...values, id, user.hotelId]
    );
  } else {
    run(
      `INSERT INTO quotes (hotel_id, name, room_type_id, price, start_date, end_date, note, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [user.hotelId, ...values, nowIso()]
    );
  }
  revalidatePath("/quotes");
}

export async function deleteQuoteAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (id) run(`DELETE FROM quotes WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  revalidatePath("/quotes");
}
