/**
 * 库存待同步队列的消费者（整改清单 P2-13）
 *
 * ── 原来错在哪 ──
 * `markStockDirty()` 写 `channel_sync_queue` 之后**没有任何消费者**：
 * 队列里的 PENDING 行永远留在那儿，渠道侧库存一动不动。
 * 更糟的是 `markStockDirty` 本身零调用 —— 写入方和读取方都不存在，
 * 整条「房态变了 → 通知渠道」的链路是断的。
 *
 * ── 本轮的接线方式（不引入定时器 / 不新增进程）──
 *   写入方：channel-orders/actions.ts（转入预订 / 拒单）、channels/actions.ts（接单 / 忽略）、
 *           channels/sync-actions.ts（拉单新增订单）
 *   消费方：本文件的 drainStockQueue()，由
 *           ① 渠道页「立即处理待同步队列」按钮（管理员显式触发）
 *           ② pushRatesAction 推完房量后顺带把队列清零（推完即消费）
 *           ③ 系统 cron（见文件末尾说明）
 *          调用。房态 / 订单变化只落一条任务，绝不实时打渠道接口（四家 OTA 都有频控）。
 *
 * ── 与 channel_sync_logs 的区别 ──
 *   sync_logs 是「已经发生的调用」的账本（只追加，审计用）；
 *   queue 是「还没做的工作」（会被消费、会累计 attempts、会进死信）。
 *   两者生命周期不同，所以分成两张表，谁也不当谁的日志。
 *
 * ── 状态机 ──
 *   PENDING --成功--> DONE
 *   PENDING --失败--> PENDING（attempts+1，next_attempt_at 指数退避）
 *                    └─ attempts >= 5 --> FAILED（不再自动重试，页面标红等人工处理）
 */

import { all, get, run } from "@/lib/db";
import { nowIso, todayStr } from "@/lib/utils";
import { channelCapability, getAdapter } from "@/lib/channels/index";
import { invokeWithLog } from "@/lib/channels/invoke";
import { planRatePush } from "@/lib/channels/stock-trigger";

/** 队列任务类型（目前只有「推房量房价」；将来有房态回传时再加） */
export const STOCK_QUEUE_KIND = "PUSH_RATES";

/** 自动重试上限：超过就置 FAILED，交给人工（反复重试只会持续打渠道接口） */
export const STOCK_QUEUE_MAX_ATTEMPTS = 5;

/** 一次消费默认推送的天数（与渠道页「推送房量」按钮的 DAYS 一致） */
export const DEFAULT_STOCK_PUSH_DAYS = 14;

/** 队列行（next_attempt_at / last_error 是新增列，老库按可选处理） */
export type StockQueueRow = {
  id: number;
  hotel_id: number;
  kind: string;
  reason: string | null;
  status: string;
  attempts: number;
  created_at: string | null;
  done_at?: string | null;
  next_attempt_at?: string | null;
  last_error?: string | null;
};

/** 一次消费的结果（页面直接展示，不做二次归纳） */
export type StockDrainResult = {
  /** 本次消费的队列行数 */
  processed: number;
  /** 实际尝试推送的渠道数 */
  channels: number;
  /** 推送成功的渠道数 */
  succeeded: number;
  /** 推送失败的渠道数 */
  failed: number;
  /** 本次实际推送的「房型 × 日期」行数 */
  rows: number;
  /** 消费后仍在等待处理的队列行数 */
  remaining: number;
  /** 逐条说明（写进操作日志 / 页面提示） */
  detail: string[];
};

/* ============================================================ 读队列 */

/** 队列表的实际列（老库可能没有 next_attempt_at / last_error） */
function queueColumns(): Set<string> {
  try {
    return new Set(all<{ name: string }>(`PRAGMA table_info(channel_sync_queue)`).map((c) => c.name));
  } catch {
    return new Set<string>();
  }
}

/** 还剩多少条待处理（页面角标用；表缺失返回 0） */
export function pendingStockCount(hotelId: number): number {
  try {
    const row = get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM channel_sync_queue WHERE hotel_id = ? AND status = 'PENDING'`,
      [hotelId]
    );
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

/** 读最近若干条队列任务（页面展示「为什么待同步」） */
export function recentStockQueue(hotelId: number, limit = 8): StockQueueRow[] {
  try {
    return all<StockQueueRow>(
      `SELECT * FROM channel_sync_queue WHERE hotel_id = ? ORDER BY id DESC LIMIT ?`,
      [hotelId, limit]
    );
  } catch {
    return [];
  }
}

/** 指数退避：第 n 次失败后等 min(3600, 60 * 2^n) 秒（与清单 P1-20 的重试节奏一致） */
export function stockBackoffSeconds(attempts: number): number {
  const base = 60 * Math.pow(2, Math.max(0, Math.trunc(attempts)));
  return Math.min(3600, Math.max(60, base));
}

/* ============================================================ 消费队列 */

/** 把一批队列行标记为已消费（成功） */
function markQueueDone(ids: number[], hotelId: number): void {
  const now = nowIso();
  for (const id of ids) {
    try {
      run(`UPDATE channel_sync_queue SET status = 'DONE', done_at = ? WHERE id = ? AND hotel_id = ?`, [
        now,
        id,
        hotelId,
      ]);
    } catch {
      // 单行更新失败不影响其它行
    }
  }
}

/**
 * 把一批队列行标记为「失败待重试」。
 * attempts + 1；达到上限置 FAILED（终态），否则继续保持 PENDING 并写入退避时间。
 */
function markQueueFailed(ids: number[], hotelId: number, error: string, maxAttempts: number): void {
  const cols = queueColumns();
  const now = new Date();
  for (const id of ids) {
    try {
      const row = get<{ attempts: number | null }>(
        `SELECT attempts FROM channel_sync_queue WHERE id = ? AND hotel_id = ?`,
        [id, hotelId]
      );
      if (!row) continue;
      const attempts = Number(row.attempts ?? 0) + 1;
      const terminal = attempts >= maxAttempts;
      const nextAt = new Date(now.getTime() + stockBackoffSeconds(attempts) * 1000).toISOString();

      const sets: string[] = ["status = ?", "attempts = ?"];
      const params: unknown[] = [terminal ? "FAILED" : "PENDING", attempts];
      if (cols.has("next_attempt_at")) {
        sets.push("next_attempt_at = ?");
        params.push(terminal ? null : nextAt);
      }
      if (cols.has("last_error")) {
        sets.push("last_error = ?");
        params.push(error.slice(0, 500));
      }
      if (terminal && cols.has("done_at")) {
        sets.push("done_at = ?");
        params.push(nowIso());
      }
      run(`UPDATE channel_sync_queue SET ${sets.join(", ")} WHERE id = ? AND hotel_id = ?`, [
        ...params,
        id,
        hotelId,
      ]);
    } catch {
      // 单行失败忽略
    }
  }
}

/**
 * 消费本店的库存待同步队列。
 *
 * 语义：「本店库存变了」这条任务 → 给本店**所有启用的直连渠道**各推一次房量房价。
 * 推成功才把队列行置 DONE；任一渠道失败就整批退避重试（渠道之间是独立的，
 * 但队列行不区分渠道，所以按「全部成功才算消费成功」处理，避免漏推某一家）。
 *
 * @param hotelId 酒店 id
 * @param opts.limit        本次最多消费多少行（默认 20）
 * @param opts.maxAttempts  重试上限（默认 5）
 * @param opts.channelIds   只推这几个渠道（不传 = 本店全部启用渠道）
 * @param opts.days         推送天数（默认 14）
 */
export async function drainStockQueue(
  hotelId: number,
  opts: { limit?: number; maxAttempts?: number; channelIds?: number[]; days?: number } = {}
): Promise<StockDrainResult> {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(opts.limit ?? 20))));
  const maxAttempts = Math.max(1, Math.trunc(Number(opts.maxAttempts ?? STOCK_QUEUE_MAX_ATTEMPTS)));
  const days = Math.min(60, Math.max(1, Math.trunc(Number(opts.days ?? DEFAULT_STOCK_PUSH_DAYS))));
  const detail: string[] = [];

  const result: StockDrainResult = {
    processed: 0,
    channels: 0,
    succeeded: 0,
    failed: 0,
    rows: 0,
    remaining: pendingStockCount(hotelId),
    detail,
  };

  /* 1. 取出待处理任务（含退避未到期的跳过） */
  const cols = queueColumns();
  let queueRows: StockQueueRow[];
  try {
    const backoffClause = cols.has("next_attempt_at") ? "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)" : "";
    const params: unknown[] = [hotelId];
    if (backoffClause) params.push(nowIso());
    params.push(limit);
    queueRows = all<StockQueueRow>(
      `SELECT * FROM channel_sync_queue
        WHERE hotel_id = ? AND status = 'PENDING' ${backoffClause}
        ORDER BY id LIMIT ?`,
      params
    );
  } catch {
    // 表还没建（老库）：没有队列可消费
    return result;
  }

  if (queueRows.length === 0) {
    detail.push(`没有待处理的库存同步任务（剩余 ${result.remaining} 条，可能都在退避等待中）`);
    return result;
  }
  result.processed = queueRows.length;
  const queueIds = queueRows.map((r) => r.id);

  /* 2. 找出本店启用的直连渠道 */
  type ChannelRow = { id: number; channel_type: string; name: string | null; oversell: number | null; sandbox?: number | null };
  let channels: ChannelRow[] = [];
  try {
    channels = all<ChannelRow>(`SELECT * FROM channels WHERE hotel_id = ? AND enabled = 1 ORDER BY id`, [hotelId]);
  } catch {
    channels = [];
  }
  if (opts.channelIds && opts.channelIds.length > 0) {
    const allow = new Set(opts.channelIds.map(Number));
    channels = channels.filter((c) => allow.has(Number(c.id)));
  }
  // 无直连能力的渠道不推：推了也只是沙箱假动作，还会把队列钉在失败重试里
  const unsupported = channels.filter((c) => channelCapability(c.channel_type, { sandbox: Number(c.sandbox ?? 0) === 1 }) === "unsupported");
  channels = channels.filter((c) => !unsupported.includes(c));

  if (channels.length === 0) {
    // 没有任何可推送的渠道：消费掉这些任务，但把原因写进 detail（不留无穷 PENDING）
    markQueueDone(queueIds, hotelId);
    result.remaining = pendingStockCount(hotelId);
    detail.push(
      unsupported.length > 0
        ? `本店启用的渠道都没有直连能力（${unsupported.map((c) => c.name ?? c.channel_type).join("、")}），库存任务已归档`
        : "本店没有启用的渠道，库存任务已归档"
    );
    return result;
  }

  /* 3. 逐渠道推送；渠道之间互不影响，但队列行按「全部成功才 DONE」处理 */
  const failureMessages: string[] = [];
  for (const channel of channels) {
    const channelType = String(channel.channel_type ?? "");
    const oversell = Number(channel.oversell ?? 0) === 1;
    const plan = planRatePush(hotelId, channelType, todayStr(), days, oversell);
    if (plan.unmapped.length > 0) {
      detail.push(
        `${channel.name ?? channelType}：${plan.unmapped.length} 个房型未配置渠道映射（${plan.unmapped
          .map((u) => u.roomTypeName)
          .slice(0, 3)
          .join("、")}${plan.unmapped.length > 3 ? " 等" : ""}），本次未推`
      );
    }
    if (plan.rows.length === 0) {
      detail.push(`${channel.name ?? channelType}：没有可推的房量（房型未映射 / 本店未维护房型）`);
      continue;
    }

    result.channels += 1;
    result.rows += plan.rows.length;
    const pushed = await invokeWithLog(channel.id, hotelId, "PUSH_RATES", (cfg) =>
      getAdapter(cfg.channelType).pushRates(cfg, plan.rows)
    );
    if (pushed.ok) {
      result.succeeded += 1;
      detail.push(
        `${channel.name ?? channelType}：推送 ${plan.rows.length} 条，接受 ${pushed.data.accepted} 条，拒绝 ${pushed.data.rejected.length} 条${
          plan.note ? `（${plan.note}）` : ""
        }`
      );
      if (pushed.data.rejected.length > 0) {
        failureMessages.push(
          `${channel.name ?? channelType} 拒绝 ${pushed.data.rejected.length} 条：${pushed.data.rejected[0]?.reason ?? "-"}`
        );
      }
    } else {
      result.failed += 1;
      failureMessages.push(`${channel.name ?? channelType} 推送失败（${pushed.code}）：${pushed.message}`);
      detail.push(failureMessages[failureMessages.length - 1]);
    }
  }

  /* 4. 结算队列行状态 */
  const attempted = result.channels;
  const allOk = attempted > 0 && result.failed === 0;
  if (allOk) {
    markQueueDone(queueIds, hotelId);
    // 有被渠道拒绝的行也算「推送完成」：拒绝原因已经进日志，重试同样的数据不会变好
    if (failureMessages.length > 0) detail.push(`部分行被渠道拒绝：${failureMessages[0]}`);
  } else {
    markQueueFailed(queueIds, hotelId, failureMessages[0] ?? "本次没有渠道推送成功", maxAttempts);
    detail.push(`本次推送未全部成功，队列退避重试（上限 ${maxAttempts} 次）`);
  }

  result.remaining = pendingStockCount(hotelId);
  return result;
}

/*
 * ── 用系统 cron 消费（可选，不影响页面按钮）──
 * 本项目不引入常驻进程，部署时用系统 cron 每天 / 每小时触发一次即可：
 *
 *   # 每 10 分钟消费一次所有酒店的库存队列（示例，按需调整）
 *   *\/10 * * * * cd /srv/pms && node --experimental-strip-types scripts/channel-stock-cron.mjs >> logs/channel-stock.log 2>&1
 *
 * 说明：本仓库的 scripts/ 目录由运维侧维护，本轮整改只新增了 lib 层的消费者，
 * 页面按钮与 pushRatesAction 已经是可用触发点；需要无人值守时再落地上面的脚本。
 */
