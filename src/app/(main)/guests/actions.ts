"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/** 某张表是否存在（未初始化的库直接跳过补列） */
function tableExists(table: string) {
  return (
    (all<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])[0]?.n ??
      0) > 0
  );
}

/** PRAGMA table_info 探测某列是否存在 */
function columnExists(table: string, column: string) {
  return all<{ name: string }>(`PRAGMA table_info(${table})`).some(
    (row) => String(row.name).toLowerCase() === column.toLowerCase()
  );
}

/**
 * guests.deleted 软删除标记：删除客人只打标记，客史、入住单与账务明细全部保留。
 * 旧库没有该列，先 PRAGMA 探测再 ALTER TABLE 补列（幂等，可反复执行）。
 */
function ensureGuestDeletedColumn() {
  if (!tableExists("guests")) return;
  if (!columnExists("guests", "deleted")) {
    run(`ALTER TABLE guests ADD COLUMN deleted INTEGER DEFAULT 0`);
  }
}

// 顶部懒执行：页面导入本模块即补列，保证列表里的 deleted 过滤不会因缺列而报错
ensureGuestDeletedColumn();

/** 操作日志：op_logs 缺失（旧库）时静默跳过，不影响主流程 */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string) {
  if (!tableExists("op_logs")) return;
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

/** 默认回跳：客人档案视图 */
const GUEST_FALLBACK_BACK = "/guests?view=profile";

/** 只允许回到宾客列表 / 订单列表，避免开放重定向 */
function safeBack(raw: string): string {
  const v = raw.trim();
  if (!v.startsWith("/")) return GUEST_FALLBACK_BACK;
  const ok = ["/guests", "/orders"].some((base) => v === base || v.startsWith(`${base}?`));
  return ok ? v : GUEST_FALLBACK_BACK;
}

/**
 * 统一回跳：带 msg / err 提示，方便页面显示结果。
 * 表单里带 hidden input name="back" 时回到来源列表（保留 tab / 关键词 / 页码）。
 */
function backGuests(formData: FormData | null, message: string, isError = false): never {
  const target = safeBack(String(formData?.get("back") ?? ""));
  const qs = new URLSearchParams();
  qs.set(isError ? "err" : "msg", message);
  redirect(`${target}${target.includes("?") ? "&" : "?"}${qs.toString()}`);
}

/** 新增客人档案 */
export async function createGuestAction(formData: FormData) {
  // 权限边界（整改清单 P2-28）：建档写的是客史主数据，与「修改客人资料」同一权限点，
  // 原来只校验登录 —— 客房账号也能凭空建客人档案。
  const user = await requirePermission("guest.modify");
  ensureGuestDeletedColumn();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const gender = String(formData.get("gender") ?? "男");
  const mobile = String(formData.get("mobile") ?? "").trim();
  const idType = String(formData.get("id_type") ?? "身份证");
  const idNo = String(formData.get("id_no") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const vipLevel = Number(formData.get("vip_level") ?? 0) || 0;
  const note = String(formData.get("note") ?? "").trim();

  run(
    `INSERT INTO guests (hotel_id, name, gender, id_type, id_no, mobile, company, vip_level, blacklist, note, deleted, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    [user.hotelId, name, gender, idType, idNo, mobile, company, vipLevel, 0, note, nowIso()]
  );
  writeOpLog(user.hotelId, user.realName, "新增客人档案", `客人 ${name}（${mobile || "无手机号"}）建档`);
  revalidatePath("/guests");
  backGuests(formData, `已新增客人档案「${name}」`);
}

/**
 * 删除客人信息（软删除）：guests.deleted = 1，客史与账务保留。
 * 列表默认只看 deleted = 0 的在册客人。
 */
export async function deleteGuestAction(formData: FormData): Promise<void> {
  // 权限边界（上线前加固）：删客史属于「修改客人资料」，原来只校验登录
  const user = await requirePermission("guest.modify");
  ensureGuestDeletedColumn();

  const id = Number(formData.get("id"));
  if (!id) backGuests(formData, "缺少客人 ID，删除未执行", true);

  const row = get<{ id: number; name: string }>(
    `SELECT id, name FROM guests WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) backGuests(formData, "未找到该客人，删除未执行", true);

  run(`UPDATE guests SET deleted = 1 WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  writeOpLog(user.hotelId, user.realName, "删除客人信息", `客人 ${row.name}（ID ${row.id}）软删除，客史与账务保留`);

  revalidatePath("/guests");
  revalidatePath("/members");
  backGuests(formData, `已删除客人「${row.name}」（软删除，可从回收站恢复）`);
}

/** 恢复被软删除的客人 */
export async function restoreGuestAction(formData: FormData): Promise<void> {
  // 权限边界（整改清单 P2-28）：恢复客史同样是修改客人资料
  const user = await requirePermission("guest.modify");
  ensureGuestDeletedColumn();

  const id = Number(formData.get("id"));
  if (!id) backGuests(formData, "缺少客人 ID，恢复未执行", true);

  const row = get<{ id: number; name: string; deleted: number | null }>(
    `SELECT id, name, deleted FROM guests WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) backGuests(formData, "未找到该客人，恢复未执行", true);
  if (Number(row.deleted ?? 0) !== 1) backGuests(formData, `客人「${row.name}」目前在册，无需恢复`, true);

  run(`UPDATE guests SET deleted = 0 WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  writeOpLog(user.hotelId, user.realName, "恢复客人信息", `客人 ${row.name}（ID ${row.id}）从回收站恢复`);

  revalidatePath("/guests");
  backGuests(formData, `已恢复客人「${row.name}」`);
}

/**
 * 免费升级 VIP1：把普通客人标记为 VIP1（guests.vip_level = 1）并写 op_logs。
 * 已是更高等级时不再降级，直接返回提示。
 */
export async function freeUpgradeVip1Action(formData: FormData): Promise<void> {
  // 权限边界（整改清单 P2-28）：免费升级 VIP1 直接改客人等级（影响房价与积分），
  // 与「修改客人资料」同一权限点，原来只校验登录。
  const user = await requirePermission("guest.modify");
  ensureGuestDeletedColumn();

  const id = Number(formData.get("id"));
  if (!id) backGuests(formData, "缺少客人 ID，免费升级未执行", true);

  const row = get<{ id: number; name: string; vip_level: number | null; deleted: number | null }>(
    `SELECT id, name, vip_level, deleted FROM guests WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) backGuests(formData, "未找到该客人，免费升级未执行", true);
  if (Number(row.deleted ?? 0) === 1) backGuests(formData, `客人「${row.name}」已删除，请先恢复再升级`, true);

  const current = Number(row.vip_level ?? 0);
  if (current >= 1) backGuests(formData, `客人「${row.name}」当前已是 VIP${current}，无需免费升级`, true);

  run(`UPDATE guests SET vip_level = 1 WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  writeOpLog(user.hotelId, user.realName, "免费升级 VIP1", `客人 ${row.name}（ID ${row.id}）普通 → VIP1（免费升级）`);

  revalidatePath("/guests");
  revalidatePath("/members");
  backGuests(formData, `客人「${row.name}」已免费升级为 VIP1`);
}
