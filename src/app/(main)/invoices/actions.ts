"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run, tx } from "@/lib/db";
import { redFlushInvoice, type InvoiceResult } from "@/lib/invoice";
import { requirePermission, requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 发票台账动作层（整改清单 P2-3 / 第六轮整改清单一.6）
 *
 * 目前只有一个「红冲」：开票动作在收银台（cashier/actions.ts 的 invoiceAction），
 * 台账页只负责查询与红冲。
 *
 * 校验与写库主体在 src/lib/invoice.ts 的 redFlushInvoice 里：
 *   · 原票必须存在且属于当前酒店（不能跨酒店红冲）；
 *   · 只允许对「正常票 + 已开状态」红冲，红冲票不能重复红冲；
 *   · 追加一条负数票（red_of 指向原票），原票 status 置 RED —— 两步在同一个 SAVEPOINT 里。
 *
 * ── 第六轮整改补的东西（清单第 90-104 行）──
 *   1. 权限：原来只有 `await requireUser()`，任何登录账号（含客房）都能红冲任意发票。
 *      现在两步守卫：requireUser()（未登录 → 跳登录页）+ requirePermission("invoice.void")
 *      （已登录但没有红冲权 → FORBIDDEN）。权限点只授权 admin / cashier，见 session.ts。
 *   2. 红冲原因必填：ConfirmForm 的 requireReason 只是前端体验，构造请求就能绕开，
 *      所以服务端再校验一次；原因写进红冲票 remark 与 op_logs。
 *   3. 原票只能红冲一次：除了 lib 里的状态机校验，这里在事务内再查一次
 *      「是否已存在 red_of = 原票 id 的负数票」，防止原票状态被人工改回 ISSUED 后重复红冲。
 *   4. 事务边界：redFlushInvoice（负数票 + 原票状态）与 op_logs 写在同一个 tx() 里
 *      （lib 内部用 SAVEPOINT，嵌套在 tx 里安全），不会出现「票红了但日志没留」。
 *   5. 留痕：负数票带 operator / remark / created_at，op_logs 带操作人、原因、时间。
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
  /*
   * 权限（清单第 98 行）：红冲是财务写操作，用独立权限点 invoice.void（admin / cashier）。
   *
   * 为什么分两步而不是只写 requirePermission()：
   *   requireUser() 负责「没登录 → 跳登录页」这条最自然的失败路径；
   *   requirePermission() 负责「登录了但不该做这件事 → 服务端拒绝」。
   * 两步都在任何读票 / 写库之前完成，且 requirePermission 自身也会再确认一次登录态。
   */
  const user = await requireUser();
  await requirePermission("invoice.void");

  // 筛选条件原样带回：红冲后仍停在同一个营业日区间 / 状态视图
  const filters = {
    from: text(formData, "from"),
    to: text(formData, "to"),
    status: text(formData, "status"),
  };

  const invoiceId = Number(text(formData, "invoice_id")) || 0;
  if (!invoiceId) back(filters, "err", "发票不存在，请刷新页面后重试");

  // 二次确认弹窗里的「红冲原因」（ConfirmForm 的字段名固定为 reason），作为红冲票备注
  const reason = text(formData, "reason");
  /*
   * 清单第 99 行：必须填写红冲原因。
   * 前端 ConfirmForm 的 requireReason 只拦住「点按钮」这条路径，直接构造 POST 就能传空，
   * 所以服务端必须再校验一次 —— 没有原因的红冲票在财务对账时等于没有依据。
   */
  if (!reason) back(filters, "err", "请填写红冲原因（红冲是不可逆的财务操作，必须留痕）");
  if (reason.length > 200) back(filters, "err", "红冲原因过长（最多 200 个字符）");

  let result: InvoiceResult;
  try {
    result = tx(() => {
      /*
       * 「原发票只能红冲一次」的第二道保险（清单第 101 行）：
       * lib 里按原票 status === 'ISSUED' 拦重复红冲，但状态是可变列；
       * 这里直接以「是否已经存在 red_of = 原票 id 的负数票」为准，
       * 查询与插入在同一个事务内，原票被改回 ISSUED 也红冲不出第二张。
       */
      const existing = get<{ id: number; invoice_no: string }>(
        `SELECT id, invoice_no FROM invoices WHERE hotel_id = ? AND red_of = ? LIMIT 1`,
        [user.hotelId, invoiceId]
      );
      if (existing) {
        return { error: `该发票已红冲过（红冲票号 ${existing.invoice_no}），不能重复红冲` };
      }

      const flushed = redFlushInvoice(user.hotelId, invoiceId, {
        operator: user.realName,
        remark: reason,
      });
      if ("error" in flushed) return flushed;

      // 与负数票写入同事务：票红了但日志丢了 = 对账时查不到是谁红的
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        user.hotelId,
        user.realName,
        "红冲发票",
        `红冲发票 · 原发票 #${invoiceId} · 红冲票号 ${flushed.invoiceNo} · 原因 ${reason}`,
        nowIso(),
      ]);

      return flushed;
    });
  } catch (e) {
    // 业务异常（如唯一索引冲突）不吞掉，但也不能把整页打成 500：回台账页提示
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) back(filters, "err", "红冲票号冲突，请重试（可能是并发重复提交）");
    throw e;
  }

  if ("error" in result) back(filters, "err", result.error);

  revalidatePath("/invoices");
  revalidatePath("/logs");
  revalidatePath("/cashier");
  back(filters, "ok", `已红冲原发票 #${invoiceId}，红冲票号 ${result.invoiceNo}`);
}
