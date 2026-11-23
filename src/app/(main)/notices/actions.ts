"use server";

import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { requirePermissionOrRedirect } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/*
 * 内部公告（整改 A 类缺口：两个动作原来只有 requireUser()）
 *
 * 权限为什么是 settings.manage：
 *   PERMISSION_CODES 里没有任何「公告 / 通知」类权限点，而本仓库对「没有专属权限点的
 *   管理类写操作」的既有约定就是 settings.manage（goods / points 配置 / companies /
 *   cleaners / quotes 全都用它）。公告是面向全店发布的内容，属管理动作，沿用同一约定，
 *   不为了凑一个语义就新造权限点（新增点要同步 session.ts + permission_dict，
 *   超出本次改造的文件范围）。
 *
 * 影响（如实说明）：/notices 页面在 ROLE_MODULES 里对 frontdesk / cashier / housekeeping
 *   可见（大家都要**看**公告），但改造后**发布 / 删除**只允许 admin。
 *   若业务上需要让前台也发公告，正确做法是新增 notice.manage 并授权 admin / frontdesk，
 *   而不是退回 requireUser()。
 *
 * 用 requirePermissionOrRedirect：生产构建会把 Server Action 抛出的错误脱敏成
 * 「操作失败」，跳 /no-permission 才能让用户看到「没有该操作权限」。
 */

export async function createNoticeAction(formData: FormData) {
  const user = await requirePermissionOrRedirect("settings.manage");
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
  const user = await requirePermissionOrRedirect("settings.manage");
  const id = Number(formData.get("id"));
  if (id) run(`DELETE FROM notices WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  revalidatePath("/notices");
}
