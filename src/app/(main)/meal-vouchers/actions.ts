"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run } from "@/lib/db";
import { requirePermissionOrRedirect } from "@/lib/session";
import { nowIso, todayStr } from "@/lib/utils";

/** 待核销的餐券行 */
type VoucherRow = { id: number; code: string };

/*
 * 权限（整改 A 类缺口：本文件 3 个动作原来只有 requireUser()）
 *
 * 餐券没有独立权限点，按语义对齐已有的「餐饮权益」权限点：
 *   · 核销（redeem*）= 把一份餐券消费掉 → cashier.receive
 *     （与 breakfast/actions.ts 的核销、以及收银台收款的角色集一致：admin / frontdesk / cashier，
 *       也正是 /meal-vouchers 页面的可见角色，不会锁死正常核销）
 *   · 作废（void）= 冲销已发出的餐饮权益、不改金额 → breakfast.void
 *     （第六轮整改为「撤销早餐核销」单列的点：admin / frontdesk；与 breakfast 的 revoke 同构）
 *
 * 影响（如实说明）：作废用了比核销更窄的 breakfast.void，所以收银（cashier）可以核销
 *   但不能作废 —— 与 /breakfast 页面对收银不可见的现状一致。若业务要求收银也能作废，
 *   应新增 meal_voucher.void 并授权三岗，而不是退回 requireUser()。
 */

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 懒建表：第一次访问时创建 meal_vouchers，已有库不受影响 */
function ensureVoucherTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS meal_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      room_no TEXT,
      guest_name TEXT,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNUSED',
      used_at TEXT,
      created_at TEXT
    );
  `);
}

/**
 * 核销餐券：支持用券号、房号或客人姓名定位当日最早的一张待用券。
 * 结果通过 redirect 带回页面（?msg= 成功 / ?err= 失败），不引入客户端组件。
 */
export async function redeemVoucherAction(formData: FormData): Promise<void> {
  const user = await requirePermissionOrRedirect("cashier.receive");
  ensureVoucherTable();

  const q = str(formData.get("code")) || str(formData.get("q"));
  const back = `/meal-vouchers?q=${encodeURIComponent(q)}`;

  if (!q) {
    redirect(`${back}&err=${encodeURIComponent("请输入券号 / 房号 / 客人姓名")}`);
  }

  const today = todayStr();
  const row = get<VoucherRow>(
    `SELECT id, code FROM meal_vouchers
      WHERE hotel_id = ? AND date = ? AND status = 'UNUSED'
        AND (code = ? OR room_no = ? OR guest_name = ?)
      ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, id
      LIMIT 1`,
    [user.hotelId, today, q, q, q, q]
  );

  if (!row) {
    redirect(
      `${back}&err=${encodeURIComponent(`没有找到可核销的餐券（${q}），请确认券号 / 房号 / 客人是否正确`)}`
    );
  }

  run(`UPDATE meal_vouchers SET status = 'USED', used_at = ? WHERE id = ? AND hotel_id = ?`, [
    nowIso(),
    row.id,
    user.hotelId,
  ]);

  revalidatePath("/meal-vouchers");
  redirect(`/meal-vouchers?q=${encodeURIComponent(row.code)}&msg=${encodeURIComponent(`餐券 ${row.code} 已核销`)}`);
}

/** 列表行「核销」：按餐券 id 直接核销 */
export async function redeemVoucherByIdAction(formData: FormData): Promise<void> {
  const user = await requirePermissionOrRedirect("cashier.receive");
  ensureVoucherTable();

  const id = Number(str(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) return;

  run(
    `UPDATE meal_vouchers SET status = 'USED', used_at = ?
      WHERE id = ? AND hotel_id = ? AND status = 'UNUSED' AND date = ?`,
    [nowIso(), Math.trunc(id), user.hotelId, todayStr()]
  );

  revalidatePath("/meal-vouchers");
}

/** 作废未使用的餐券 */
export async function voidVoucherAction(formData: FormData): Promise<void> {
  const user = await requirePermissionOrRedirect("breakfast.void");
  ensureVoucherTable();

  const id = Number(str(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) return;

  run(
    `UPDATE meal_vouchers SET status = 'VOID'
      WHERE id = ? AND hotel_id = ? AND status = 'UNUSED'`,
    [Math.trunc(id), user.hotelId]
  );

  revalidatePath("/meal-vouchers");
}
