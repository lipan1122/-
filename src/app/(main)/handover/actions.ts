"use server";

import { revalidatePath } from "next/cache";
import { all, get, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { nowIso } from "@/lib/utils";

/**
 * 交班汇总（整改报告 P2-10）
 *
 * 业务规则：
 *   - 一个收银员同时只有一条 OPEN 班次（唯一索引兜底）
 *   - 开班时记录备用金；交班时汇总本班次的收款/退款，算出应交现金
 *   - 实交现金与应交现金的差额单独记录，方便核对长短款
 *   - 交班记录不删除，只置 CLOSED，作为资金流水的凭证
 */

export type ActionState = { ok?: string; error?: string } | undefined;

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}
function num(v: FormDataEntryValue | null): number {
  const n = Number(str(v));
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 按当前时间推断班次（早/中/晚） */
function currentShiftCode(now = new Date()): { code: string; name: string } {
  const h = now.getHours();
  if (h >= 8 && h < 16) return { code: "MORNING", name: "早班" };
  if (h >= 16 && h < 24) return { code: "MIDDLE", name: "中班" };
  return { code: "NIGHT", name: "夜班" };
}

/** 本班次时间范围：从开班时间到现在 */
function shiftRange(startAt: string, now = nowIso()): { from: string; to: string } {
  return { from: startAt, to: now };
}

/**
 * 汇总某段时间内的收款（按方式分组）
 *
 * 第 4 轮 P1-13：必须带 operator 过滤。
 * 班次是按人开的，汇总却是全店口径 → 多人同时在岗时串账、长短款判定必然错。
 * operator 传空时退回全店口径（兼容管理员查总账）。
 */
function summarizePayments(hotelId: number, fromIso: string, toIso: string, operator: string) {
  const op = (operator ?? "").trim();
  const rows = all<{ method: string | null; total: number; cnt: number }>(
    `SELECT COALESCE(method, '现金') AS method,
            COALESCE(SUM(amount), 0) AS total,
            COUNT(*) AS cnt
       FROM payments
      WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
        AND (? = '' OR COALESCE(operator, '') = ?)
      GROUP BY COALESCE(method, '现金')
      ORDER BY total DESC`,
    [hotelId, fromIso, toIso, op, op]
  );
  const cash = rows.find((r) => r.method === "现金")?.total ?? 0;
  const refund = rows.filter((r) => Number(r.total) < 0).reduce((s, r) => s + Number(r.total), 0);
  return { rows, cash: round2(Number(cash)), refund: round2(refund) };
}

/** 开班：记录备用金 */
export async function openShiftAction(formData: FormData): Promise<ActionState> {
  const user = await requirePermission("cashier.receive");
  const openingCash = round2(num(formData.get("opening_cash")));
  const shift = currentShiftCode();
  const bizDate = bizToday(user.hotelId);
  const now = nowIso();

  /* 已有未交班的记录 → 不允许重复开班 */
  const exist = get<{ id: number; start_at: string; shift_name: string }>(
    `SELECT id, start_at, shift_name FROM shifts
      WHERE hotel_id = ? AND operator = ? AND status = 'OPEN' LIMIT 1`,
    [user.hotelId, user.realName]
  );
  if (exist) {
    return { error: `你还有未交班的记录（${exist.shift_name}，开班于 ${exist.start_at.slice(0, 16)}），请先交班` };
  }
  if (openingCash < 0) return { error: "备用金不能为负数" };

  run(
    `INSERT INTO shifts (hotel_id, biz_date, shift_code, shift_name, start_at, operator, opening_cash, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [user.hotelId, bizDate, shift.code, shift.name, now, user.realName, openingCash, "OPEN", now]
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    user.realName,
    "开班",
    `${shift.name} · 备用金 ¥${openingCash.toFixed(2)}`,
    now,
  ]);

  revalidatePath("/handover");
  revalidatePath("/cashier");
  return { ok: `已开班（${shift.name}），备用金 ¥${openingCash.toFixed(2)}` };
}

/** 交班：汇总本班次收款，记录实交现金与差额 */
export async function closeShiftAction(formData: FormData): Promise<ActionState> {
  const user = await requirePermission("cashier.receive");
  const actualCash = round2(num(formData.get("actual_cash")));
  const receiver = str(formData.get("receiver"));
  const note = str(formData.get("note"));

  const shift = get<{
    id: number;
    start_at: string;
    shift_name: string;
    opening_cash: number;
    biz_date: string;
  }>(
    `SELECT id, start_at, shift_name, COALESCE(opening_cash,0) AS opening_cash, biz_date
       FROM shifts WHERE hotel_id = ? AND operator = ? AND status = 'OPEN' LIMIT 1`,
    [user.hotelId, user.realName]
  );
  if (!shift) return { error: "没有未交班的记录，请先开班" };

  const now = nowIso();
  const { from, to } = shiftRange(shift.start_at, now);
  const sum = summarizePayments(user.hotelId, from, to, user.realName);

  /* 应交现金 = 备用金 + 现金收款（退款已是负数，会自然抵扣） */
  const expectCash = round2(Number(shift.opening_cash) + sum.cash);
  const diff = round2(actualCash - expectCash);

  if (receiver && receiver === user.realName) {
    return { error: "接班人不能是自己" };
  }

  run(
    `UPDATE shifts
        SET end_at = ?, receiver = ?, cash_in = ?, cash_out = ?, expect_cash = ?,
            actual_cash = ?, diff = ?, pay_summary = ?, note = ?, status = 'CLOSED'
      WHERE id = ? AND hotel_id = ?`,
    [
      now,
      receiver || null,
      round2(sum.cash),
      round2(sum.refund),
      expectCash,
      actualCash,
      diff,
      JSON.stringify(sum.rows),
      note || null,
      shift.id,
      user.hotelId,
    ]
  );

  const diffText =
    Math.abs(diff) < 0.01 ? "账实相符" : diff > 0 ? `长款 ¥${diff.toFixed(2)}` : `短款 ¥${Math.abs(diff).toFixed(2)}`;
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    user.realName,
    "交班",
    `${shift.shift_name} · 应交 ¥${expectCash.toFixed(2)} · 实交 ¥${actualCash.toFixed(2)} · ${diffText}`,
    now,
  ]);

  revalidatePath("/handover");
  revalidatePath("/cashier");
  return {
    ok: `${shift.shift_name}已交班：应交 ¥${expectCash.toFixed(2)}，实交 ¥${actualCash.toFixed(2)}（${diffText}）`,
  };
}

