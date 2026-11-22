/**
 * 小程序：取消自己的服务请求
 *
 * POST /api/mini/service-orders/:id/cancel   { requestId? }
 *
 * ── 两条硬条件 ──
 *   1. 只能取消**自己**的：UPDATE 的 WHERE 里同时带
 *      `hotel_id = ?`（token 的酒店）与 `mini_user_id = ?`（token 的用户），
 *      客户端传别人的 id 会命中 0 行 → 统一回 404 SERVICE_REQUEST_NOT_FOUND，
 *      不区分「不存在」与「不是你的」（否则就成了「别人提了什么服务」的探测器）。
 *   2. 只有 PENDING（待处理）能取消：一旦前台接单（ACCEPTED / PROCESSING），
 *      阿姨可能已经在路上，取消会出现「人到了活没了」；DONE 已执行完不可撤销。
 *      请客人直接联系前台。
 *
 * ── 幂等 ──
 * 已取消再点一次 → 200 + alreadyCancelled: true（不是错误，前端按钮可能重复提交）。
 * 用 `WHERE status = 'PENDING'` 做条件更新，两个并发请求只有一个 changes = 1。
 *
 * ── 副作用 ──
 * 只改状态 + completed_at 留处理时间戳，写一条 op_logs。
 * 叫醒类请求取消时，PC 端的 wake_up_calls 也会被标记 CANCELLED ——
 * 否则前台仍会在 07:30 去敲门，客人却已经取消了叫醒。
 */

import { get, run, tx } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { ensureMiniServiceSchema, fail, getMiniServiceRequest, miniGuard, ok, readJsonBody, str } from "../../../_shared";

export const dynamic = "force-dynamic";

/** 写接口限流：20 次/分钟 */
const WRITE_RATE_LIMIT_PER_MINUTE = 20;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = miniGuard(req, "mini:service-order:cancel", WRITE_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const requestRowId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(requestRowId) || requestRowId <= 0) {
    return fail("BAD_REQUEST", "服务请求编号格式不正确", 400);
  }

  const body = (await readJsonBody(req)) ?? {};
  const requestId = str(body.requestId).slice(0, 64);

  ensureMiniServiceSchema();
  const hotelId = guard.hotelId;

  /* 归属：getMiniServiceRequest 只按 (id, hotel_id) 查，下面还要比对 mini_user_id */
  const row = getMiniServiceRequest(hotelId, requestRowId);
  if (!row) {
    return fail("SERVICE_REQUEST_NOT_FOUND", "没有找到这条服务请求，请刷新列表后重试", 404);
  }
  if (!ownsRequest(hotelId, guard.user.id, requestRowId)) {
    /* 别人的、别家酒店的：与「不存在」同一句话 */
    return fail("SERVICE_REQUEST_NOT_FOUND", "没有找到这条服务请求，请刷新列表后重试", 404);
  }

  if (row.status === "CANCELLED") {
    return ok({ id: row.id, status: "CANCELLED", statusLabel: "已取消", alreadyCancelled: true });
  }
  if (row.status !== "PENDING") {
    return fail(
      "NOT_CANCELLABLE",
      row.status === "DONE"
        ? "该服务已完成，无需取消"
        : "前台已接单并开始处理，如需取消请直接联系酒店前台"
    );
  }

  const now = nowIso();
  try {
    const changed = tx(() => {
      /*
       * 条件更新：WHERE 里再写一遍 hotel_id + mini_user_id + status = 'PENDING'。
       * 三重条件保证「取消别人的」「取消已接单的」都改不到行。
       */
      const res = run(
        `UPDATE mini_service_requests
            SET status = 'CANCELLED', completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE id = ? AND hotel_id = ? AND mini_user_id = ? AND status = 'PENDING'`,
        [now, now, requestRowId, hotelId, guard.user.id]
      );

      if (res.changes === 0) return false;

      /*
       * 叫醒：同步 PC 端的 wake_up_calls（否则前台照着旧记录照样去敲门）。
       * 只改与这条请求同酒店、同入住单、且还没执行的那条 —— 按 wake_time 匹配，
       * 因为 mini_service_requests 没有单独的 wake_time 列（避免为一条撤销改表结构）。
       */
      if ((row.serviceType ?? "").toUpperCase() === "WAKEUP" && row.stayId) {
        const wakeTime = extractWakeTime(row.note);
        if (wakeTime) {
          run(
            `UPDATE wake_up_calls SET status = 'CANCELLED'
              WHERE hotel_id = ? AND stay_id = ? AND wake_time = ? AND status = 'PENDING'`,
            [hotelId, row.stayId, wakeTime]
          );
        }
      }

      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        "微信小程序",
        "小程序取消服务请求",
        `#${requestRowId} ${row.serviceType}「${row.note}」` + (requestId ? `；requestId=${requestId}` : ""),
        now,
      ]);

      return true;
    });

    if (!changed) {
      /* 并发：另一个请求先取消了 / 前台刚接单 */
      const fresh = getMiniServiceRequest(hotelId, requestRowId);
      if (fresh?.status === "CANCELLED") {
        return ok({ id: row.id, status: "CANCELLED", statusLabel: "已取消", alreadyCancelled: true });
      }
      return fail("NOT_CANCELLABLE", "该服务请求状态已变化（前台可能已接单），请刷新后再看");
    }
  } catch {
    return fail("CANCEL_FAILED", "取消失败，请稍后重试或联系酒店前台");
  }

  return ok({ id: row.id, status: "CANCELLED", statusLabel: "已取消", alreadyCancelled: false });
}

/** 这条服务请求是否属于当前小程序用户（唯一授权判定，两处条件都不可省） */
function ownsRequest(hotelId: number, miniUserId: number, requestRowId: number): boolean {
  const row = get<{ id: number }>(
    `SELECT id FROM mini_service_requests
      WHERE id = ? AND hotel_id = ? AND mini_user_id = ? LIMIT 1`,
    [requestRowId, hotelId, miniUserId]
  );
  return Boolean(row);
}

/** 从 note 里抠出 `YYYY-MM-DD HH:MM`（叫醒行是这么写的：`叫醒 2026-11-23 07:30；备注：…`） */
function extractWakeTime(note: string): string {
  const m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(note ?? "");
  return m ? m[1] : "";
}
