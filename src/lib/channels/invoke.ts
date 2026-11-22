/**
 * 渠道调用统一入口（整改清单 F1）
 *
 * ── 为什么所有渠道动作都要从这里走 ──
 * 「点一下同步」背后有四件事：读配置、判凭据、计时调用、留痕。
 * 如果每个页面动作各写一遍，必然出现：有的地方没判凭据（拿掩码密钥去撞网关）、
 * 有的地方失败不留痕（运维只看到按钮没反应）、有的地方超时把请求挂死。
 * 所以统一收口到 invokeWithLog()：
 *
 *   1. 从 channels 表按 (id, hotel_id) 读配置 —— 带 hotel_id 就是租户隔离；
 *   2. isConfigured 不通过直接返回 NOT_CONFIGURED，**不调用适配器**（绝不发请求）；
 *   3. 调 fn(cfg) 并加 20s 兜底截止时间（适配器内部还有 15s fetch 超时）；
 *   4. 把结果写 channel_sync_logs（整改清单 4.2 的全字段口径）：
 *        SUCCESS → message 带耗时（+ 结果摘要 + 沙箱提示）
 *        FAILED  → error_code = 归一化错误码，message = 具体原因（detail 截断后附上）
 *      失败同时算 retry_count：同渠道同动作连续失败的第几次；
 *      另外每次都写：
 *        request_no       本次同步请求编号（crypto.randomUUID，一次调用一个）
 *        finished_at      结束时间
 *        duration_ms      耗时（毫秒）
 *        success_count    成功数量（PUSH_RATES=accepted、PULL_ORDERS=订单条数、其它 1/0）
 *        fail_count       失败数量（PUSH_RATES=rejected 条数、整次失败=1）
 *        channel_order_no / booking_id / folio_id  由调用方通过 meta 传入
 *      老库缺这些列时自动降级（只写存在的列），不影响同步本身；
 *   5. 真正调用过适配器才刷新 channels.last_sync_at（凭据缺失的早退不算一次同步）。
 *
 * 适配器内部异常 / 超时也在这里兜住并归一，页面永远拿到 ChannelResult，不用 try/catch。
 */

import { randomUUID } from "node:crypto";
import { all, get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";
/*
 * 这里写显式的 `/index` 而不是 `"@/lib/channels"`：
 * 验收脚本（scripts/test-channel-*.mjs）用 registerHooks 把 `@/` 映射成 `src/<x>.ts`，
 * 它不认「目录 → index.ts」的解析，写成目录形式会 ERR_MODULE_NOT_FOUND；
 * 显式文件路径在 Next 与脚本里都能解析。
 */
import { capabilityNote, channelCapability, getAdapter } from "@/lib/channels/index";
import {
  errText,
  fail,
  isMaskedSecret,
  missingCredentials,
  truncate,
  type ChannelFailure,
} from "@/lib/channels/common";
import {
  buildChannelConfig,
  isConfigured,
  type ChannelConfig,
  type ChannelResult,
} from "@/lib/channels/types";

/** 统一动作名（写进 channel_sync_logs.action，页面 / 告警按它分类） */
export const CHANNEL_ACTION: Record<string, string> = {
  TEST_CONNECTION: "TEST_CONNECTION",
  PUSH_RATES: "PUSH_RATES",
  PULL_ORDERS: "PULL_ORDERS",
  PUSH_STATUS: "PUSH_STATUS",
};

/** 单次业务调用的兜底截止时间；适配器自己的 fetch 超时是 15s，这里留 5s 余量 */
export const INVOKE_DEADLINE_MS = 20_000;

/** channels 表一行的最小类型（endpoint / sandbox / last_order_sync_at 老库可能没有，按可选处理） */
type ChannelRow = {
  id: number;
  hotel_id: number;
  channel_type: string;
  name: string | null;
  store_id: string | null;
  app_key: string | null;
  app_secret: string | null;
  /** 整改清单 P2-11：加密后的 app_secret（优先于明文列） */
  app_secret_enc?: string | null;
  enabled: number | null;
  auto_import: number | null;
  commission: number | null;
  oversell: number | null;
  endpoint?: string | null;
  sandbox?: number | null;
  /** 整改清单 P1-22：拉单增量游标（只有 PULL_ORDERS 推进它） */
  last_order_sync_at?: string | null;
};

/** 上一批失败日志里读出来的重试计数 */
type SyncLogRow = {
  id?: number;
  status?: string | null;
  retry_count?: number | null;
};

/* ============================================================ 小工具 */

const ACTION_LABELS: Record<string, string> = {
  TEST_CONNECTION: "测试连接",
  PUSH_RATES: "推送房量房价",
  PULL_ORDERS: "拉取订单",
  PUSH_STATUS: "回传订单状态",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * sync_logs 实际有哪些扩展列。
 * 老库可能还没跑 scripts/migrate-all.mjs（没有 error_code / retry_count），
 * 这时退回老字段写日志，不能让「记账」本身把同步动作搞崩。
 */
function syncLogColumns(): Set<string> {
  try {
    return new Set(all<{ name: string }>("PRAGMA table_info(channel_sync_logs)").map((c) => c.name));
  } catch {
    return new Set<string>();
  }
}

/**
 * 这次失败是「连续第几次」。
 * 口径：同酒店 + 同渠道 + 同动作，上一条日志是 FAILED 就 +1，否则归零；
 * 成功日志会把计数自然归零（下一条失败从 0 开始）。
 */
function nextRetryCount(hotelId: number, channelType: string, action: string): number {
  try {
    const prev = get<SyncLogRow>(
      `SELECT * FROM channel_sync_logs
        WHERE hotel_id = ? AND channel_type = ? AND action = ?
        ORDER BY id DESC LIMIT 1`,
      [hotelId, channelType, action]
    );
    if (prev && prev.status === "FAILED") return Number(prev.retry_count ?? 0) + 1;
    return 0;
  } catch {
    // 日志表不存在时不影响主流程
    return 0;
  }
}

/**
 * 调用方可以补的关联信息（整改清单 4.2 的「订单关联」）。
 * 不传完全没问题：三个字段都会写成 NULL，老调用点不用改一行代码。
 */
export type InvokeMeta = {
  /** 渠道订单号（拉单 / 状态回传时填） */
  channelOrderNo?: string;
  /** 本次同步落地到的 PMS 预订 id */
  bookingId?: number;
  /** 本次同步关联的账单 id */
  folioId?: number;
};

type SyncLogInput = {
  hotelId: number;
  channelType: string;
  action: string;
  status: "SUCCESS" | "FAILED";
  message: string;
  errorCode: string | null;
  retryCount: number;
  /** 本次同步请求编号（一次调用一个 UUID，同一次调用写的多条日志共用） */
  requestNo: string;
  /** 调用开始时间（毫秒时间戳），用来算 finished_at / duration_ms */
  startedAt: number;
  /** 成功数量；没有可数对象时按 1（整次成功） */
  successCount: number;
  /** 失败数量；整次失败记 1 */
  failCount: number;
  meta?: InvokeMeta;
};

/**
 * 写一条渠道同步日志；任何异常都吞掉（日志失败不能覆盖业务结果）。
 *
 * 列是「探测到才写」：线上老库可能还没跑 scripts/migrate-all.mjs（没有 request_no /
 * finished_at / duration_ms / success_count / fail_count / channel_order_no / booking_id /
 * folio_id），这时自动退回老口径写基础列。反过来，只要迁移跑过就写全字段——
 * 同一份代码在新老库上都能跑，不会因为「少一列」让同步动作整条失败。
 */
function writeSyncLog(input: SyncLogInput): void {
  try {
    const cols = syncLogColumns();
    const names: string[] = ["hotel_id", "channel_type", "action", "status", "message", "created_at"];
    const values: unknown[] = [
      input.hotelId,
      input.channelType,
      input.action,
      input.status,
      input.message,
      nowIso(),
    ];
    const add = (column: string, value: unknown) => {
      if (!cols.has(column)) return;
      names.push(column);
      values.push(value);
    };

    add("error_code", input.errorCode);
    add("retry_count", input.retryCount);
    add("request_no", input.requestNo);
    add("finished_at", nowIso());
    add("duration_ms", Math.max(0, Date.now() - input.startedAt));
    add("success_count", input.successCount);
    add("fail_count", input.failCount);
    add("channel_order_no", input.meta?.channelOrderNo ?? null);
    add("booking_id", input.meta?.bookingId ?? null);
    add("folio_id", input.meta?.folioId ?? null);

    run(
      `INSERT INTO channel_sync_logs (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      values
    );
  } catch {
    // 表缺失 / 库锁冲突都不该让页面动作失败
  }
}

/**
 * 在 invokeWithLog 之外补写一条同步日志。
 *
 * 用途：有些失败**根本没走到适配器**（例如房型没配渠道映射，推过去只会被拒），
 * 但它们同样是「同步没做成」，必须能在页面「最近同步记录」里看到、能被重试。
 * 这里复用同一份列探测逻辑，保证新老库都能写。
 */
export function logSyncOutcome(input: {
  hotelId: number;
  channelType: string;
  action: string;
  status: "SUCCESS" | "FAILED";
  message: string;
  errorCode?: string | null;
  retryCount?: number;
  successCount?: number;
  failCount?: number;
  meta?: InvokeMeta;
}): void {
  writeSyncLog({
    hotelId: input.hotelId,
    channelType: input.channelType,
    action: input.action,
    status: input.status,
    message: input.message,
    errorCode: input.errorCode ?? null,
    retryCount: input.retryCount ?? 0,
    requestNo: randomUUID(),
    startedAt: Date.now(),
    successCount: input.successCount ?? 0,
    failCount: input.failCount ?? 0,
    meta: input.meta,
  });
}

/**
 * 从适配器返回里提取「成功几条 / 失败几条」（整改清单 4.2 的 success_count / fail_count）。
 *
 * 口径（与页面「最近同步记录」展示一致）：
 *   PUSH_RATES    accepted / rejected.length —— 部分失败要能看出推 20 条拒 2 条
 *   PULL_ORDERS   data.length / 0           —— 拉到几单就是几条成功
 *   TEST_CONNECTION / PUSH_STATUS 等 1 / 0   —— 这类动作没有「条数」，整次成功记 1
 *   整次失败（ok=false）                     0 / 1
 */
function resultCounts(action: string, result: ChannelResult<unknown>): {
  successCount: number;
  failCount: number;
} {
  if (!result.ok) return { successCount: 0, failCount: 1 };

  const data = result.data;
  if (action === "PUSH_RATES") {
    const d = data as { accepted?: number; rejected?: unknown[] } | null;
    const accepted = Number(d?.accepted);
    return {
      successCount: Number.isFinite(accepted) ? accepted : 0,
      failCount: Array.isArray(d?.rejected) ? d.rejected.length : 0,
    };
  }
  if (action === "PULL_ORDERS") {
    return { successCount: Array.isArray(data) ? data.length : 0, failCount: 0 };
  }
  return { successCount: 1, failCount: 0 };
}

/** 刷新渠道的最后同步时间；同样吞异常 */
function touchLastSync(channelId: number, hotelId: number): void {
  try {
    run(`UPDATE channels SET last_sync_at = ? WHERE id = ? AND hotel_id = ?`, [
      nowIso(),
      channelId,
      hotelId,
    ]);
  } catch {
    // 忽略：last_sync_at 只是展示字段
  }
}

/**
 * 刷新「拉单增量游标」（整改清单 P1-22）。
 *
 * ── 为什么要和 last_sync_at 分开 ──
 * last_sync_at 原来同时承担两个互相冲突的角色：
 *   ① 页面「最近一次同步时间」（所有动作都该刷新，测试连接也算一次尝试）
 *   ② 拉单增量起点（只有拉单成功才该前进）
 * 管理员点一次「测试连接」或「推送房价」，游标就跳到此刻 →
 * 下一次拉单只从此刻开始，**这中间的渠道新单永久漏拉**（不会重来）。
 *
 * 现在 ② 独立成 channels.last_order_sync_at，只有 action = PULL_ORDERS
 * 真正调用过适配器才推进；失败由调用方（sync-actions.pullOrdersAction）回滚。
 */
function touchLastOrderSync(channelId: number, hotelId: number): void {
  try {
    run(`UPDATE channels SET last_order_sync_at = ? WHERE id = ? AND hotel_id = ?`, [
      nowIso(),
      channelId,
      hotelId,
    ]);
  } catch {
    // 老库还没跑迁移（没有该列）时退回「每次都回看 7 天」的保守行为，不影响拉单本身
  }
}

/** 凭据不通过时给出精确原因（停用 / 缺字段 / 掩码占位），便于页面直接提示 */
function notConfiguredMessage(cfg: ChannelConfig): string {
  if (!cfg.enabled) return "渠道已停用";
  const missing = missingCredentials(cfg);
  if (missing.length > 0) return `渠道凭据未配全：缺少 ${missing.join("、")}`;
  if (isMaskedSecret(cfg.appSecret)) return "渠道 appSecret 是掩码占位，未发起真实请求";
  return "渠道未配置";
}

/** 给成功日志补一句结果摘要（页面列表里能直接看出推了几条、拉了几单） */
function summarize(action: string, result: ChannelResult<unknown>): string {
  if (!result.ok) return "";
  const data = result.data;

  if (action === "PUSH_RATES") {
    const d = data as { accepted?: number; rejected?: { code?: string; reason?: string }[] } | null;
    const rejected = Array.isArray(d?.rejected) ? d.rejected : [];
    // 整改清单 P2-10：拒绝原因必须落到日志里，否则「接受 20 条拒绝 2 条」查不出是哪两行被拒
    const first = rejected[0];
    const hint = first ? `（首条被拒：${first.code ?? "-"} ${first.reason ?? "-"}）` : "";
    return `，接受 ${Number(d?.accepted ?? 0)} 条，拒绝 ${rejected.length} 条${hint}`;
  }
  if (action === "PULL_ORDERS") {
    return `，拉到 ${Array.isArray(data) ? data.length : 0} 条订单`;
  }
  if (action === "TEST_CONNECTION") {
    const d = data as { latencyMs?: number; message?: string } | null;
    const latency = Number.isFinite(d?.latencyMs) ? `，延迟 ${d?.latencyMs}ms` : "";
    // 整改清单 P2-10：适配器返回的说明（如「沙箱模式，未连接真实渠道」）不能丢
    const note = typeof d?.message === "string" && d.message.trim() !== "" ? `，${truncate(d.message, 120)}` : "";
    return `${latency}${note}`;
  }
  if (action === "PUSH_STATUS") {
    const d = data as { accepted?: boolean } | null;
    return `，渠道${d?.accepted ? "已接受" : "未接受"}`;
  }
  return "";
}

/** 给 Promise 加外部截止时间（适配器自己的超时之外再兜一层，防止整条链路挂死） */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`渠道调用超过 ${ms}ms 未返回`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 适配器抛出的异常 → 归一化结果；超时算 NETWORK，其它算 CHANNEL_ERROR */
function mapThrown(e: unknown): ChannelFailure {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return fail("NETWORK", `渠道调用超时（${INVOKE_DEADLINE_MS}ms）`, truncate(errText(e), 300));
  }
  return fail("CHANNEL_ERROR", `渠道适配器异常：${errText(e)}`, truncate(errText(e), 500));
}

/* ============================================================ 主入口 */

/**
 * 带日志、超时、重试计数的统一渠道调用。
 *
 * @param channelId channels.id
 * @param hotelId   当前酒店（与 channelId 一起构成租户隔离条件）
 * @param action    CHANNEL_ACTION 里的动作名（也可以是调用方的自定义动作）
 * @param fn        实际调用适配器的方法，入参是已构造好的 ChannelConfig
 * @param meta      可选的订单关联信息（渠道订单号 / 预订 id / 账单 id）；
 *                  不传就是 NULL，老调用点零改动
 */
export async function invokeWithLog<T>(
  channelId: number,
  hotelId: number,
  action: string,
  fn: (cfg: ChannelConfig) => Promise<ChannelResult<T>>,
  meta?: InvokeMeta
): Promise<ChannelResult<T>> {
  const startedAt = Date.now();
  /** 本次同步请求编号：一次调用一个，失败重试是另一条日志（另一次请求） */
  const requestNo = randomUUID();

  /* 1. 读配置（带 hotel_id：别家的渠道 id 传进来查不到） */
  let row: ChannelRow | undefined;
  try {
    row = get<ChannelRow>(`SELECT * FROM channels WHERE id = ? AND hotel_id = ?`, [channelId, hotelId]);
  } catch (e) {
    return fail(
      "NOT_CONFIGURED",
      `读取渠道配置失败：${errText(e)}`,
      "channels 表不存在或库结构异常，请先执行 node scripts/migrate-all.mjs"
    );
  }

  if (!row) {
    const result = fail("NOT_CONFIGURED", `渠道 #${channelId} 不存在或不属于本店`);
    writeSyncLog({
      hotelId,
      channelType: "unknown",
      action,
      status: "FAILED",
      message: `${actionLabel(action)}失败（NOT_CONFIGURED）：${result.message}`,
      errorCode: "NOT_CONFIGURED",
      retryCount: 0,
      requestNo,
      startedAt,
      successCount: 0,
      failCount: 1,
      meta,
    });
    return result;
  }

  const cfg = buildChannelConfig(row);
  const capability = channelCapability(cfg.channelType, cfg);

  /* 2. 前置校验（顺序有讲究：停用 → 无直连能力 → 凭据不全，提示一句比一句具体） */
  if (!cfg.enabled) {
    const result = fail("NOT_CONFIGURED", "渠道已停用", "启用渠道后才能发起同步");
    writeSyncLog({
      hotelId,
      channelType: cfg.channelType,
      action,
      status: "FAILED",
      message: `${actionLabel(action)}失败（NOT_CONFIGURED）：${result.message}`,
      errorCode: "NOT_CONFIGURED",
      retryCount: nextRetryCount(hotelId, cfg.channelType, action),
      requestNo,
      startedAt,
      successCount: 0,
      failCount: 1,
      meta,
    });
    return result;
  }

  /*
   * 整改清单 P2-10②：没有直连能力的渠道**不再记成功**。
   *
   * 原来 getAdapter 对未知 / 无直连渠道兜底到沙箱，沙箱返回 ok=true，
   * 于是去哪儿、艺龙、协议单位的「推送房量」按钮点下去日志写 SUCCESS，
   * 运维以为库存已经到渠道了，实际一条都没发出去。
   * 现在在这里直接判失败（UNSUPPORTED），日志 message 写明原因，页面也按该错误码提示。
   */
  if (capability === "unsupported") {
    const result = fail(
      "UNSUPPORTED",
      `该渠道没有直连能力：${getAdapter(cfg.channelType).label}`,
      "支持直连的渠道为 ctrip / meituan / fliggy / douyin；其余渠道的订单请在渠道后台操作后手工录入本系统"
    );
    writeSyncLog({
      hotelId,
      channelType: cfg.channelType,
      action,
      status: "FAILED",
      message: `${actionLabel(action)}失败（UNSUPPORTED）：${result.message}${capabilityNote(cfg.channelType, cfg)}`,
      errorCode: "UNSUPPORTED",
      retryCount: nextRetryCount(hotelId, cfg.channelType, action),
      requestNo,
      startedAt,
      successCount: 0,
      failCount: 1,
      meta,
    });
    return result;
  }

  /* 3. 凭据 / 启用状态前置校验：不通过就不调适配器，绝不发请求 */
  if (!isConfigured(cfg)) {
    const result = fail(
      "NOT_CONFIGURED",
      notConfiguredMessage(cfg),
      "请到渠道配置页补全凭据，或打开沙箱模式先用流程"
    );
    writeSyncLog({
      hotelId,
      channelType: cfg.channelType,
      action,
      status: "FAILED",
      message: `${actionLabel(action)}失败（NOT_CONFIGURED）：${result.message}`,
      errorCode: "NOT_CONFIGURED",
      retryCount: nextRetryCount(hotelId, cfg.channelType, action),
      requestNo,
      startedAt,
      successCount: 0,
      failCount: 1,
      meta,
    });
    return result;
  }

  /* 4. 调用适配器（带兜底截止时间；异常也归一） */
  let result: ChannelResult<T>;
  try {
    result = await withDeadline(fn(cfg), INVOKE_DEADLINE_MS);
  } catch (e) {
    result = mapThrown(e);
  }

  /* 5. 留痕：成功带耗时与摘要，失败带错误码与原因 */
  const elapsedMs = Date.now() - startedAt;
  // 沙箱 / 无直连说明必须进日志：只看「耗时 12ms」根本分不清是真连上了还是本地模拟
  const sandboxNote = capabilityNote(cfg.channelType, cfg);

  if (result.ok) {
    const counts = resultCounts(action, result);
    writeSyncLog({
      hotelId,
      channelType: cfg.channelType,
      action,
      status: "SUCCESS",
      message: `${actionLabel(action)}成功，耗时 ${elapsedMs}ms${sandboxNote}${summarize(action, result)}`,
      errorCode: null,
      retryCount: 0,
      requestNo,
      startedAt,
      successCount: counts.successCount,
      failCount: counts.failCount,
      meta,
    });
  } else {
    const detail = result.detail ? `；详情：${truncate(result.detail, 300)}` : "";
    writeSyncLog({
      hotelId,
      channelType: cfg.channelType,
      action,
      status: "FAILED",
      message: `${actionLabel(action)}失败（${result.code}）：${result.message}${detail}${sandboxNote}`,
      errorCode: result.code,
      retryCount: nextRetryCount(hotelId, cfg.channelType, action),
      requestNo,
      startedAt,
      successCount: 0,
      failCount: 1,
      meta,
    });
  }

  /* 6. 只有真正调用过适配器才刷新最后同步时间（凭据缺失的早退不算一次同步） */
  touchLastSync(cfg.id, hotelId);

  /*
   * 7. 拉单游标只在 PULL_ORDERS 推进（整改清单 P1-22）
   *
   * 这里不改 last_sync_at 的语义（页面「最近一次同步时间」），另开一列 last_order_sync_at
   * 专供拉单增量起点：测试连接 / 推送房价 / 状态回传都不会再让游标前跳，
   * 期间进来的渠道新单不会因为「管理员点了一下测试连接」而永久漏拉。
   */
  if (action === "PULL_ORDERS") touchLastOrderSync(cfg.id, hotelId);

  return result;
}
