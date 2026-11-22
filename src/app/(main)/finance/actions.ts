"use server";

import { revalidatePath } from "next/cache";
import { get, run, tx } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso, round2, todayStr } from "@/lib/utils";

/** 收款单号：AR + 毫秒时间戳 + 随机数，避免同毫秒重复 */
function nextPayNo() {
  return `AR${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

/**
 * 单笔结清应收账单：
 * 写 payments 收款流水（默认收满余额），并同步 folios 的已收 / 余额 / 状态。
 */
export async function settleArAction(formData: FormData) {
  // 权限边界（上线前加固）：AR 结清会真实写收款流水，与收款同一权限组，原来只校验登录
  const user = await requirePermission("cashier.receive");
  const id = Number(formData.get("id"));
  if (!id) return;

  const method = String(formData.get("method") ?? "微信").trim() || "微信";
  const inputAmount = Number(String(formData.get("amount") ?? "").trim());

  const folio = get<{
    id: number;
    stay_id: number | null;
    total_amount: number;
    paid_amount: number;
    balance: number;
    status: string;
  }>(
    `SELECT id, stay_id, total_amount, paid_amount, balance, status
       FROM folios WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!folio) return;
  if (folio.status !== "OPEN") return;

  const balance = round2(Number(folio.balance ?? 0));
  if (balance <= 0.01) return;

  // 不传金额时按余额结清；传入金额时不允许超过余额（避免出现负数应收）
  const amount = round2(inputAmount > 0 ? Math.min(inputAmount, balance) : balance);
  if (amount <= 0) return;

  const after = tx(() => {
    run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, id, folio.stay_id, nextPayNo(), method, amount, todayStr(), "AR 应收结清", nowIso(), "ROOM_PAYMENT"]
    );

    const paid = round2(Number(folio.paid_amount ?? 0) + amount);
    const left = round2(Number(folio.total_amount ?? 0) - paid);
    const settled = left <= 0.01;

    run(
      `UPDATE folios SET paid_amount = ?, balance = ?, status = ?, settled_at = ? WHERE id = ? AND hotel_id = ?`,
      [paid, settled ? 0 : left, settled ? "SETTLED" : "OPEN", settled ? nowIso() : null, id, user.hotelId]
    );

    /* 把结清结果带出事务，给下面的审计日志用（事务内的局部变量外部看不到） */
    return { left, settled };
  });

  /*
   * 整改清单 P1-34：收款属于敏感账务操作，必须能事后追溯「谁在什么时候收了多少」。
   * 审计写失败不能反过来让已经落库的收款显示为失败（前台会二次收款），所以包 try/catch。
   */
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName || user.username,
      "AR 结清收款",
      `账单 #${id} 收款 ¥${amount.toFixed(2)} · 方式 ${method} · 余额 ${
        after.settled ? "已结清" : `¥${after.left.toFixed(2)}`
      }`,
      nowIso(),
    ]);
  } catch {
    /* op_logs 不存在（老库未迁移）→ 跳过审计，不影响收款 */
  }

  revalidatePath("/finance");
  revalidatePath("/cashier");
  revalidatePath("/reports");
}
