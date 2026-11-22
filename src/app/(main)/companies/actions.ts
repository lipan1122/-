"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { ensureArLedgerSchema } from "@/lib/ar";
import { fmtMoney, nowIso } from "@/lib/utils";

/**
 * 协议单位档案（整改清单 第六轮 一.8）
 *
 * ── 原来的问题 ──
 * 新增 / 删除只调 `requireUser()`：任何登录账号都能建协议单位、删协议单位；
 * 而**改信用额度**当时根本没有服务端入口（页面只在新建表单里填一次），
 * 于是「授信变更」既没有独立权限，也没有旧值留痕。
 *
 * ── 现在 ──
 *   · 新增 / 修改 / 删除 全部 `requirePermission("settings.manage")`（当前仅 admin）；
 *   · 新增 `updateCompanyAction`：档案与信用额度可改，**信用额度变更必须填原因**，
 *     并写 op_logs：`旧值 ¥x → 新值 ¥y · 原因 · 操作人`（operator 列 + detail 里各一份）；
 *   · 所有 SQL 带 hotel_id：UPDATE / DELETE 写在 WHERE，INSERT 直接带列；
 *   · 删除保留原有的引用检查（历史订单 / 未结 AR 台账）+ 原因必填 + 留痕。
 *
 * 为什么信用额度没有单独新增 `company.credit` 权限点：
 * 授信是配置级操作，`settings.manage` 已经是「仅 admin」的最严档，再加一个同样只有 admin 的
 * 权限点不增加任何约束，只会多一组 RBAC 种子与勾选矩阵要去维护；
 * 真正的风险用「强制原因 + 旧值/新值/操作人留痕」控住（清单只要求 settings.manage 或 company.manage）。
 */

/** 失败 / 成功回跳：文案带在 query 上，页面顶部渲染横幅 */
function back(key: "err" | "msg", message: string): never {
  redirect(`/companies?${key}=${encodeURIComponent(message)}`);
}

/** op_logs 可能不存在（极老库），失败不影响主流程 */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string) {
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    /* 老库没有 op_logs → 跳过审计 */
  }
}

/** 金额按分比较，避免 0.1 + 0.2 这类浮点误差把「没改」判成「改了」 */
const toCents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100) / 100;

export async function createCompanyAction(formData: FormData) {
  // 权限：建协议单位 = 建授信主体 → settings.manage
  const user = await requirePermission("settings.manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const discount = Number(formData.get("discount") ?? 1) || 1;
  const creditLimit = Number(formData.get("credit_limit") ?? 0) || 0;

  run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
    user.hotelId,
    name,
    String(formData.get("contact") ?? ""),
    String(formData.get("phone") ?? ""),
    discount,
    creditLimit,
  ]);

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "新增协议单位",
    `「${name}」· 协议折扣 ${discount} · 信用额度 ${fmtMoney(creditLimit)}`
  );

  revalidatePath("/companies");
  back("msg", `协议单位「${name}」已新增`);
}

/**
 * 修改协议单位档案 / 信用额度。
 *
 * 信用额度变化时**必须**填原因：授信额度涨一块钱就是多一笔可挂账风险，
 * 没有原因的额度调整事后无法向财务解释。日志里同时写旧值与新值。
 */
export async function updateCompanyAction(formData: FormData) {
  // 权限：改授信主体 / 额度 → settings.manage
  const user = await requirePermission("settings.manage");
  const id = Number(formData.get("id"));
  if (!id) back("err", "协议单位不存在，请刷新后重试");

  const old = get<{ id: number; name: string; contact: string | null; phone: string | null; discount: number; credit_limit: number }>(
    `SELECT id, name, contact, phone, discount, credit_limit FROM companies WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!old) back("err", "协议单位不存在或不属于本店，未保存");

  const name = String(formData.get("name") ?? old.name).trim();
  if (!name) back("err", "单位名称不能为空");

  const contact = String(formData.get("contact") ?? old.contact ?? "");
  const phone = String(formData.get("phone") ?? old.phone ?? "");

  const discountRaw = Number(formData.get("discount"));
  const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? discountRaw : Number(old.discount ?? 1);

  const creditRaw = formData.get("credit_limit");
  const creditNext = creditRaw === null ? Number(old.credit_limit ?? 0) : Number(creditRaw);
  if (!Number.isFinite(creditNext) || creditNext < 0) {
    back("err", "信用额度必须是不小于 0 的数字");
  }

  const reason = String(formData.get("reason") ?? "").trim();
  const oldCredit = Number(old.credit_limit ?? 0);
  const creditChanged = toCents(oldCredit) !== toCents(creditNext);
  if (creditChanged && !reason) {
    back("err", "调整信用额度必须填写变更原因（授信属于高风险操作）");
  }

  run(
    `UPDATE companies SET name = ?, contact = ?, phone = ?, discount = ?, credit_limit = ?
      WHERE id = ? AND hotel_id = ?`,
    [name, contact, phone, discount, creditNext, id, user.hotelId]
  );

  /* 档案字段差异（金额单独走到下面的授信日志，避免同一件事记两遍看不清） */
  const diffs: string[] = [];
  if (name !== old.name) diffs.push(`名称「${old.name}」→「${name}」`);
  if (contact !== String(old.contact ?? "")) diffs.push(`联系人「${old.contact ?? ""}」→「${contact}」`);
  if (phone !== String(old.phone ?? "")) diffs.push(`电话「${old.phone ?? ""}」→「${phone}」`);
  if (toCents(discount) !== toCents(old.discount)) diffs.push(`协议折扣 ${old.discount} → ${discount}`);

  const operator = user.realName || user.username;

  if (creditChanged) {
    /*
     * 整改清单要求：信用额度变更必须记录旧值、新值、原因、操作人。
     * operator 列已有操作人，detail 里再写一遍是为了报表 / 日志页直接可读。
     */
    writeOpLog(
      user.hotelId,
      operator,
      "变更信用额度",
      `「${name}」（ID ${id}）· 信用额度 旧值 ${fmtMoney(oldCredit)} → 新值 ${fmtMoney(creditNext)}` +
        ` · 原因：${reason} · 操作人：${operator}` +
        (diffs.length ? ` · 同时修改：${diffs.join("；")}` : "")
    );
  } else if (diffs.length > 0) {
    writeOpLog(user.hotelId, operator, "修改协议单位", `「${name}」（ID ${id}）· ${diffs.join("；")}`);
  }

  revalidatePath("/companies");
  back(
    "msg",
    creditChanged
      ? `「${name}」已保存，信用额度 ${fmtMoney(oldCredit)} → ${fmtMoney(creditNext)}（已记操作日志）`
      : `「${name}」已保存`
  );
}

/**
 * 删除协议单位（整改清单 P1-31：不可逆物理删除）
 *
 * 原来按 id 直接物理删除、一把梭：库内没有任何 REFERENCES 约束，
 * 删除不会失败，只会静默留孤儿数据（订单 / AR 台账指向一个不存在的单位）。
 *
 * 现在的约束：
 *   1. 权限 settings.manage；
 *   2. 二次确认 + 删除原因必填（页面用 ConfirmForm，服务端再校验一次，防绕过）；
 *   3. 引用检查：有历史订单（协议价预订）→ 拒绝；有未结 AR 台账 → 拒绝；
 *   4. 删除成功写 op_logs（含原因、历史订单数、未结台账数），事后可追溯。
 */
export async function deleteCompanyAction(formData: FormData) {
  // 权限：删授信主体 → settings.manage
  const user = await requirePermission("settings.manage");
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

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "删除协议单位",
    `「${company.name}」（ID ${id}）· 原因：${reason} · 历史订单 ${orderCount} 条 · 未结 AR 台账 0 笔`
  );

  revalidatePath("/companies");
  back("msg", `协议单位「${company.name}」已删除`);
}
