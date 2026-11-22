"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run } from "@/lib/db";
import { redFlushInvoice } from "@/lib/invoice";
import { requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 发票台账动作层（整改清单 P2-3）
 *
 * 目前只有一个「红冲」：开票动作在收银台（cashier/actions.ts 的 invoiceAction），
 * 台账页只负责查询与红冲。
 *
 * 校验与写库都在 src/lib/invoice.ts 的 redFlushInvoice 里：
 *   · 原票必须存在且属于当前酒店；
 *   · 只允许对「正常票 + 已开状态」红冲，红冲票不能重复红冲；
 *   · 追加一条负数票（red_of 指向原票），原票 status 置 RED。
 * 这里只做三件事：取登录用户、把成功 / 失败文案带回页面（与 /ar 页面同一套 ?ok= / ?err= 约定）、
 * 补一条 op_logs 供 /logs 与交班对账。
 */

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** 回到台账页并保留筛选条件；redirect 内部抛 NEXT_REDIRECT，所以返回 never */
function back(filters: Record<string, string>, key: "ok" | "err", message: string): never {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  q.set(key, message);
  redirect(`/invoices?${q.toString()}`);
}

/** 红冲发票：生成负数票 + 原票置「已红冲」 */
export async function redFlushInvoiceAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  // 筛选条件原样带回：红冲后仍停在同一个营业日区间 / 状态视图
  const filters = {
    from: text(formData, "from"),
    to: text(formData, "to"),
    status: text(formData, "status"),
  };

  const invoiceId = Number(text(formData, "invoice_id")) || 0;
  if (!invoiceId) back(filters, "err", "发票不存在，请刷新页面后重试");

  // 二次确认弹窗里的「红冲原因」（ConfirmForm 的字段名固定为 reason），作为台账备注
  const remark = text(formData, "reason");

  const result = redFlushInvoice(user.hotelId, invoiceId, {
    operator: user.realName,
    remark,
  });
  if ("error" in result) back(filters, "err", result.error);

  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    user.realName,
    "红冲发票",
    `红冲发票 · 原发票 #${invoiceId} · 红冲票号 ${result.invoiceNo}${remark ? ` · 原因 ${remark}` : ""}`,
    nowIso(),
  ]);

  revalidatePath("/invoices");
  revalidatePath("/logs");
  revalidatePath("/cashier");
  back(filters, "ok", `已红冲原发票 #${invoiceId}，红冲票号 ${result.invoiceNo}`);
}
