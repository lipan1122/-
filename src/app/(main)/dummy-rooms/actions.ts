"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 哑房（非客房消费挂账点）不在 init-db.mjs 内，
 * 首次导入本模块时懒创建，避免页面查询不到表。
 */
const DUMMY_ROOMS_DDL = `CREATE TABLE IF NOT EXISTS dummy_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  category TEXT DEFAULT '其他',
  status TEXT DEFAULT 'ACTIVE',
  note TEXT,
  created_at TEXT
)`;

/**
 * 幂等建表：页面渲染前也会 await 一次，保证查询安全
 *
 * 注意：dummy-rooms/page.tsx 直接 import 了它，去掉 export 会打断页面编译，
 * 所以保留导出但补登录守卫 —— 它不该是「未登录也能打的建表端点」。
 */
export async function ensureDummyRoomsTable() {
  await requireUser();
  run(DUMMY_ROOMS_DDL);
}

// 顶部懒创建：模块被页面导入即执行（CREATE TABLE IF NOT EXISTS 幂等）
run(DUMMY_ROOMS_DDL);

const CATEGORIES = ["餐饮", "会议", "其他"];

function categoryOf(value: FormDataEntryValue | null) {
  const c = String(value ?? "其他").trim();
  return CATEGORIES.includes(c) ? c : "其他";
}

/** 新增哑房；编码重复时复用原记录（重新启用并更新名称 / 分类 / 备注） */
export async function createDummyRoomAction(formData: FormData) {
  // 权限边界（上线前加固）：哑房属于系统配置（主布局里 /dummy-rooms 也是 ADMIN_ONLY），仅 admin 可写
  const user = await requireAdmin();
  await ensureDummyRoomsTable();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const code = String(formData.get("code") ?? "").trim();
  const category = categoryOf(formData.get("category"));
  const note = String(formData.get("note") ?? "").trim();

  if (code) {
    const existed = get<{ id: number }>(
      `SELECT id FROM dummy_rooms WHERE hotel_id = ? AND code = ? LIMIT 1`,
      [user.hotelId, code]
    );
    if (existed) {
      run(
        `UPDATE dummy_rooms SET name = ?, category = ?, note = ?, status = 'ACTIVE' WHERE id = ? AND hotel_id = ?`,
        [name, category, note, existed.id, user.hotelId]
      );
      revalidatePath("/dummy-rooms");
      return;
    }
  }

  run(
    `INSERT INTO dummy_rooms (hotel_id, name, code, category, status, note, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [user.hotelId, name, code, category, "ACTIVE", note, nowIso()]
  );
  revalidatePath("/dummy-rooms");
}

/** 启用 / 停用切换 */
export async function toggleDummyRoomAction(formData: FormData) {
  const user = await requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return;

  const row = get<{ status: string }>(
    `SELECT status FROM dummy_rooms WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) return;

  run(`UPDATE dummy_rooms SET status = ? WHERE id = ? AND hotel_id = ?`, [
    row.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
    id,
    user.hotelId,
  ]);
  revalidatePath("/dummy-rooms");
}

/** 删除哑房 */
export async function deleteDummyRoomAction(formData: FormData) {
  const user = await requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return;

  run(`DELETE FROM dummy_rooms WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  revalidatePath("/dummy-rooms");
}
