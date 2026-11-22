"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { ensureArLedgerSchema } from "@/lib/ar";
import { fmtMoney, nowIso } from "@/lib/utils";

/** 失败 / 成功回跳：文案带在 query 上，页面顶部渲染横幅 */
function back(key: "err" | "msg", message: string): never {
  redirect(`/companies?${key}=${encodeURIComponent(message)}`);
}

export async function createCompanyAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
    user.hotelId,
    name,
    String(formData.get("contact") ?? ""),
    String(formData.get("phone") ?? ""),
    Number(formData.get("discount") ?? 1) || 1,
    Number(formData.get("credit_limit") ?? 0) || 0,
  ]);
  revalidatePath("/companies");
}

/**
 * 删除协议单位（整改清单 P1-31：不可逆物理删除）
 *
 * 原来按 id 直接物理删除、一把梭：库内没有任何 REFERENCES 约束，
 * 删除不会失败，只会静默留孤儿数据（订单 / AR 台账指向一个不存在的单位）。
 *
 * 现在的约束：
 *   1. 二次确认 + 删除原因必填（页面用 ConfirmForm，服务端再校验一次，防绕过）；
 *   2. 引用检查：有历史订单（协议价预订）→ 拒绝；有未结 AR 台账 → 拒绝；
 *   3. 删除成功写 op_logs（含原因、历史订单数、未结台账数），事后可追溯。
 */
export async function deleteCompanyAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!id) back("err", "协议单位不存在，请刷新后重试");

  const company = get<{ id: number; name: string }>(
    `SELECT id, name FROM companies WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!company) back("err", "协议单位不存在，请刷新后重试");
  if (!reason) back("err", "删除协议单位必须填写原因");

  /* 引用检查 1：协议价预订（bookings.company_id）——删了会让订单指向空单位 */
  const orderCount =
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND company_id = ?`, [
      user.hotelId,
      id,
    ])?.c ?? 0;
  if (orderCount > 0) {
    back("err", `「${company.name}」有 ${orderCount} 条历史订单，不能删除；请先调整这些订单的协议单位归属`);
  }

  /* 引用检查 2：未结 AR 台账（ar_ledgers 是按协议单位的笔级应收明细） */
  ensureArLedgerSchema();
  const ledger =
    get<{ c: number; outstanding: number }>(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS outstanding
         FROM ar_ledgers
        WHERE hotel_id = ? AND company_id = ? AND status IN ('OPEN', 'PARTIAL')`,
      [user.hotelId, id]
    ) ?? { c: 0, outstanding: 0 };
  if (ledger.c > 0) {
    back(
      "err",
      `「${company.name}」有 ${ledger.c} 笔未结 AR 台账（未结应收 ${fmtMoney(ledger.outstanding)}），请先核销后再删除`
    );
  }

  run(`DELETE FROM companies WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);

  /* 整改清单 P1-34：物理删除必须留痕（失败不影响主流程） */
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName || user.username,
      "删除协议单位",
      `「${company.name}」（ID ${id}）· 原因：${reason} · 历史订单 ${orderCount} 条 · 未结 AR 台账 0 笔`,
      nowIso(),
    ]);
  } catch {
    /* op_logs 不存在（极老库）→ 跳过审计 */
  }

  revalidatePath("/companies");
  back("msg", `协议单位「${company.name}」已删除`);
}
