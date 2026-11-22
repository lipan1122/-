/**
 * 渠道同步失败的真实重试（整改清单 P1-20）
 *
 * ── 原来错在哪 ──
 * `retryChannelSyncAction` 只做了一件事：
 *   `UPDATE channel_sync_logs SET status='RETRYING', retry_count = retry_count + 1`
 * 全程没有 `invokeWithLog`、没有 `getAdapter`、**从不重新调用上游**。
 * 而且 `RETRYING` 不是终态，没有任何代码把它推进到 SUCCESS / FAILED：
 *   · 点一次「重试」，这条记录就**永久卡在 RETRYING**；
 *   · 首页「渠道同步异常」按 `status <> 'SUCCESS'` 计数 → 这条记录一直算故障；
 *   · 运维以为自己重试过了，实际渠道那边什么都没发生。
 *
 * ── 现在的语义 ──
 *   1. 按原始 `action` 真实分派：PULL_ORDERS → 拉单适配器；PUSH_RATES → 推房量；
 *      TEST_CONNECTION → 连通性测试；PUSH_STATUS → 回传原状态；
 *      其余动作（导入预订 / 演示动作等）不支持自动重试，明确标出来，不假装重试。
 *   2. 成功写 `SUCCESS` 并把 retry_count 归零；失败写 `FAILED` + retry_count + 1
 *      + `next_retry_at = now + min(3600, 60·2^n)`。
 *   3. 连续失败达到 5 次 → 写死信表 `channel_sync_dead_letter`，原记录置 `DEAD`，
 *      不再被「到期重试」反复捞起来打渠道接口。
 *   4. 每次重试都会由 invokeWithLog 另写一条日志（新 request_no），
 *      原始那条只被推进状态 —— 于是「重试了几次、每次什么结果」全都可追溯。
 *
 * ── 谁来触发 ──
 *   · 渠道页「最近同步记录」每行的「重试」按钮 → retrySyncLog()
 *   · 渠道页「重试全部到期」/ cron → retryDueSyncLogs()
 */

import { all, get, run } from "@/lib/db";
import { nowIso, todayStr } from "@/lib/utils";
import { getAdapter } from "@/lib/channels/index";
import { invokeWithLog } from "@/lib/channels/invoke";
import { upsertChannelOrder, planRatePush } from "@/lib/channels/stock-trigger";
import { normalizeOrderStatus } from "@/lib/channels/order-status";
import type { ChannelOrderPayload } from "@/lib/channels/types";

/** 最多自动重试几次，超过进死信 */
export const SYNC_RETRY_MAX = 5;

/** 指数退避：第 n 次失败后等 min(3600, 60·2^n) 秒 */
export function syncRetryBackoffSeconds(retryCount: number): number {
  return Math.min(3600, Math.max(60, 60 * Math.pow(2, Math.max(0, Math.trunc(retryCount)))));
}

/** 一条待重试日志（SELECT *，老库缺列时按可选处理） */
type SyncLogRow = {
  id: number;
  hotel_id: number;
  channel_type: string | null;
  action: string | null;
  status: string | null;
  message: string | null;
  error_code?: string | null;
  retry_count?: number | null;
  next_retry_at?: string | null;
  channel_order_no?: string | null;
  booking_id?: number | null;
};

/** 单个日志的重试结果 */
export type RetryOutcome = {
  logId: number;
  action: string;
  /** SUCCESS/FAILED/DEAD 是本次之后该日志的状态；SKIPPED 表示无需 / 不支持重试 */
  result: "SUCCESS" | "FAILED" | "DEAD" | "SKIPPED";
  message: string;
};

/** 支持自动重试的动作 → 不在这里的一律 SKIPPED（并说明该去哪里重做） */
const RETRYABLE_ACTIONS = new Set(["PULL_ORDERS", "PUSH_RATES", "TEST_CONNECTION", "PUSH_STATUS"]);

/** channel_sync_logs 的实际列（老库可能没有 retry_count / next_retry_at） */
function syncLogColumns(): Set<string> {
  try {
    return new Set(all<{ name: string }>(`PRAGMA table_info(channel_sync_logs)`).map((c) => c.name));
  } catch {
    return new Set<string>();
  }
}

/** 推进原日志的状态（成功 / 失败 / 死信），列缺失时自动降级 */
function updateLogStatus(
  hotelId: number,
  logId: number,
  input: { status: "SUCCESS" | "FAILED" | "DEAD"; retryCount: number; nextRetryAt: string | null; note?: string }
): void {
  const cols = syncLogColumns();
  const sets: string[] = ["status = ?"];
  const params: unknown[] = [input.status];
  if (cols.has("retry_count")) {
    sets.push("retry_count = ?");
    params.push(input.retryCount);
  }
  if (cols.has("next_retry_at")) {
    sets.push("next_retry_at = ?");
    params.push(input.nextRetryAt);
  }
  if (input.note && cols.has("message")) {
    sets.push("message = ?");
    params.push(input.note.slice(0, 900));
  }
  try {
    run(`UPDATE channel_sync_logs SET ${sets.join(", ")} WHERE id = ? AND hotel_id = ?`, [...params, logId, hotelId]);
  } catch {
    // 日志表异常不影响重试本身的结果
  }
}

/** 写死信（表缺失时静默跳过：老库还没跑迁移时重试依然可用） */
function writeDeadLetter(hotelId: number, row: SyncLogRow, retryCount: number, message: string): void {
  try {
    run(
      `INSERT INTO channel_sync_dead_letter
         (hotel_id, channel_type, action, log_id, error_code, message, retry_count, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        row.channel_type ?? "-",
        row.action ?? "-",
        row.id,
        row.error_code ?? null,
        message.slice(0, 900),
        retryCount,
        nowIso(),
      ]
    );
  } catch {
    // 表不存在（未迁移）时忽略
  }
}

/** 从日志 message 里还原 PUSH_STATUS 的目标状态（"… → 已入住" 不行，日志里存的是英文枚举） */
function parsePushedStatus(message: string | null): string | null {
  const text = String(message ?? "");
  const matched = /→\s*(CONFIRMED|CHECKED_IN|CHECKED_OUT|NOSHOW|CANCELLED)/.exec(text);
  return matched ? matched[1] : null;
}

/* ============================================================ 单条重试 */

/**
 * 重试一条失败日志：按原始 action 真实重新调用上游。
 *
 * @param hotelId 当前酒店（租户隔离，别人的日志 id 传进来查不到）
 * @param logId   channel_sync_logs.id
 */
export async function retrySyncLog(hotelId: number, logId: number): Promise<RetryOutcome> {
  const row = get<SyncLogRow>(`SELECT * FROM channel_sync_logs WHERE id = ? AND hotel_id = ?`, [logId, hotelId]);
  if (!row) {
    return { logId, action: "-", result: "SKIPPED", message: `同步日志 #${logId} 不存在或不属于本店` };
  }
  const action = String(row.action ?? "");
  if (row.status === "SUCCESS") {
    return { logId, action, result: "SKIPPED", message: "该记录已成功，无需重试" };
  }
  if (row.status === "DEAD") {
    return { logId, action, result: "SKIPPED", message: "该记录已进死信，请先修好配置再手工触发一次同步" };
  }
  if (!RETRYABLE_ACTIONS.has(action)) {
    /*
     * 导入预订 / 演示动作没有「同一动作可重放」的语义，硬重试只会造重复数据。
     *
     * 处理方式有两层考虑：
     *   1. 不假装重试 —— 原 message 一个字节都不改（改写了反而丢失当次的真实错误）；
     *   2. 把 next_retry_at 推到一年后 —— 否则「重试全部到期」每次都会把同一条
     *      不可重试的记录再捞一遍，页面点击一次就刷一次噪音。
     */
    const message = `动作 ${action || "-"} 不支持自动重试，请到对应页面重新操作`;
    const farFuture = new Date(Date.now() + 365 * 86400000).toISOString();
    updateLogStatus(hotelId, row.id, {
      status: "FAILED",
      retryCount: Number(row.retry_count ?? 0),
      nextRetryAt: farFuture,
    });
    return { logId, action, result: "SKIPPED", message };
  }

  const channelType = String(row.channel_type ?? "");
  const ch = get<{
    id: number;
    channel_type: string;
    name: string | null;
    oversell: number | null;
    sandbox?: number | null;
    last_order_sync_at?: string | null;
  }>(`SELECT * FROM channels WHERE hotel_id = ? AND channel_type = ?`, [hotelId, channelType]);
  if (!ch) {
    /*
     * 渠道配置被删掉了：重试不可能成功，但不该无限排期。
     * 与失败分支同样处理 —— 计一次失败、按退避排下一次、到上限进死信，
     * 这样运维补回渠道配置后，还能在死信里按单号找到它。
     */
    const message = `渠道 ${channelType || "-"} 已不在本店配置中，无法重试（请先到渠道配置页补上）`;
    const retryCount = Number(row.retry_count ?? 0) + 1;
    if (retryCount >= SYNC_RETRY_MAX) {
      writeDeadLetter(hotelId, row, retryCount, message);
      updateLogStatus(hotelId, row.id, {
        status: "DEAD",
        retryCount,
        nextRetryAt: null,
        note: `【已进死信，连续失败 ${retryCount} 次】${message}`,
      });
      return { logId, action, result: "DEAD", message: `${message}（已进死信）` };
    }
    updateLogStatus(hotelId, row.id, {
      status: "FAILED",
      retryCount,
      nextRetryAt: new Date(Date.now() + syncRetryBackoffSeconds(retryCount) * 1000).toISOString(),
      note: `【第 ${retryCount} 次重试失败】${message}`,
    });
    return { logId, action, result: "FAILED", message };
  }

  const retryCount = Number(row.retry_count ?? 0) + 1;
  const operator = "系统重试";

  /** 真正调用适配器；返回一句话结果 */
  let ok = false;
  let message = "";

  if (action === "PUSH_RATES") {
    const oversell = Number(ch.oversell ?? 0) === 1;
    const plan = planRatePush(hotelId, channelType, todayStr(), 14, oversell);
    if (plan.rows.length === 0) {
      message = `无可推送的房量（${plan.unmapped.length} 个房型未配置渠道映射）`;
    } else {
      const res = await invokeWithLog(ch.id, hotelId, "PUSH_RATES", (cfg) =>
        getAdapter(cfg.channelType).pushRates(cfg, plan.rows)
      );
      ok = res.ok;
      message = res.ok
        ? `重试推送房量成功：接受 ${res.data.accepted} 条，拒绝 ${res.data.rejected.length} 条`
        : `重试推送房量失败（${res.code}）：${res.message}`;
    }
  } else if (action === "PULL_ORDERS") {
    // 与 pullOrdersAction 一致：since 用拉单游标（P1-22），失败时把游标回滚，避免窗口漏单
    const before =
      typeof ch.last_order_sync_at === "string" && ch.last_order_sync_at.trim() !== "" ? ch.last_order_sync_at : null;
    const since = before ?? new Date(Date.now() - 7 * 86400000).toISOString();
    let pulled: ChannelOrderPayload[] = [];
    const res = await invokeWithLog<ChannelOrderPayload[]>(ch.id, hotelId, "PULL_ORDERS", async (cfg) => {
      const r = await getAdapter(cfg.channelType).pullOrders(cfg, since);
      if (r.ok) pulled = r.data;
      return r;
    });
    ok = res.ok;
    if (res.ok) {
      let created = 0;
      for (const payload of pulled) {
        try {
          if (upsertChannelOrder(hotelId, channelType, payload).inserted) created += 1;
        } catch {
          // 单条落库失败不影响整体重试结论（下一次拉单还会再遇到它）
        }
      }
      message = `重试拉单成功：拉到 ${pulled.length} 条，新增 ${created} 条`;
    } else {
      try {
        run(`UPDATE channels SET last_order_sync_at = ? WHERE id = ? AND hotel_id = ?`, [
          before,
          ch.id,
          hotelId,
        ]);
      } catch {
        // 回滚失败时下次仍按 7 天回看（宁可多拉，不漏单）
      }
      message = `重试拉单失败（${res.code}）：${res.message}`;
    }
  } else if (action === "TEST_CONNECTION") {
    const res = await invokeWithLog(ch.id, hotelId, "TEST_CONNECTION", (cfg) =>
      getAdapter(cfg.channelType).testConnection(cfg)
    );
    ok = res.ok;
    message = res.ok ? `重试连通性测试成功：${res.data.message}，${res.data.latencyMs}ms` : `重试连通性测试失败（${res.code}）：${res.message}`;
  } else if (action === "PUSH_STATUS") {
    const status = normalizeOrderStatus(parsePushedStatus(row.message));
    const orderNo = String(row.channel_order_no ?? "").trim();
    if (!status || orderNo === "") {
      message = "原日志缺少订单号 / 目标状态，无法重放状态回传（请在渠道订单页重新回传）";
    } else {
      const res = await invokeWithLog(
        ch.id,
        hotelId,
        "PUSH_STATUS",
        (cfg) => getAdapter(cfg.channelType).pushOrderStatus(cfg, orderNo, status),
        { channelOrderNo: orderNo, bookingId: row.booking_id ?? undefined }
      );
      ok = res.ok && res.data.accepted;
      message = res.ok
        ? `重试状态回传${res.data.accepted ? "成功" : "未被渠道接受"}：${orderNo} → ${status}`
        : `重试状态回传失败（${res.code}）：${res.message}`;
    }
  }

  /* 推进原日志的状态 */
  if (ok) {
    updateLogStatus(hotelId, row.id, { status: "SUCCESS", retryCount: 0, nextRetryAt: null, note: `【重试成功】${message}` });
    return { logId, action, result: "SUCCESS", message };
  }

  if (retryCount >= SYNC_RETRY_MAX) {
    writeDeadLetter(hotelId, row, retryCount, message);
    updateLogStatus(hotelId, row.id, {
      status: "DEAD",
      retryCount,
      nextRetryAt: null,
      note: `【已进死信，连续失败 ${retryCount} 次】${message}`,
    });
    return { logId, action, result: "DEAD", message: `${message}（连续失败 ${retryCount} 次，已进死信）` };
  }

  const nextRetryAt = new Date(Date.now() + syncRetryBackoffSeconds(retryCount) * 1000).toISOString();
  updateLogStatus(hotelId, row.id, {
    status: "FAILED",
    retryCount,
    nextRetryAt,
    note: `【第 ${retryCount} 次重试失败，${nextRetryAt} 后再试】${message}`,
  });
  return { logId, action, result: "FAILED", message };
}

/* ============================================================ 批量重试 */

/**
 * 重试所有「到期」的失败记录（next_retry_at <= now 或为空）。
 *
 * 这是 P1-20 要求补的「消费者」：页面按钮和系统 cron 都调它，
 * 不需要常驻进程，也不会在页面动作里长耗时等待大批量渠道请求
 * （limit 默认 5，一次最多打 5 个上游调用）。
 */
export async function retryDueSyncLogs(
  hotelId: number,
  opts: { limit?: number } = {}
): Promise<{ retried: number; succeeded: number; failed: number; dead: number; skipped: number; outcomes: RetryOutcome[] }> {
  const limit = Math.min(20, Math.max(1, Math.trunc(Number(opts.limit ?? 5))));
  const cols = syncLogColumns();
  let due: SyncLogRow[] = [];
  try {
    const backoff = cols.has("next_retry_at")
      ? "AND (next_retry_at IS NULL OR next_retry_at <= ?)"
      : "";
    const params: unknown[] = [hotelId];
    if (backoff) params.push(nowIso());
    params.push(limit);
    due = all<SyncLogRow>(
      `SELECT * FROM channel_sync_logs
        WHERE hotel_id = ? AND status = 'FAILED' ${backoff}
        ORDER BY id LIMIT ?`,
      params
    );
  } catch {
    return { retried: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0, outcomes: [] };
  }

  const summary = { retried: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0, outcomes: [] as RetryOutcome[] };
  for (const row of due) {
    const outcome = await retrySyncLog(hotelId, row.id);
    summary.outcomes.push(outcome);
    if (outcome.result === "SUCCESS") summary.succeeded += 1;
    else if (outcome.result === "DEAD") summary.dead += 1;
    else if (outcome.result === "FAILED") summary.failed += 1;
    else summary.skipped += 1;
    if (outcome.result !== "SKIPPED") summary.retried += 1;
  }
  return summary;
}
