/**
 * 渠道订单状态回传（整改清单 P1-20）
 *
 * ── 这个文件解决的缺口 ──
 * 清单 P1-20 的原文：「`pushOrderStatusAction` 全项目零引用；入住只改本地表
 * `UPDATE channel_orders SET status='CHECKED_IN'`，退房完全不碰 `channel_orders`
 * → 渠道侧永远显示「待入住」」。
 *
 * 也就是说：适配器早就实现了 `pushOrderStatus()`（四家各自的枚举映射都写了），
 * 但业务层没有一个地方调它 —— 客人已经入住了，渠道后台还显示「待入住」，
 * 渠道会按「未到店」处理，轻则影响渠道权重，重则按 no-show 扣款。
 *
 * ── 为什么抽成 lib 而不是留在 sync-actions.ts ──
 * 1. "use server" 文件只能导出 async 函数，纯逻辑放里面没法被脚本 / 其它服务端模块复用；
 * 2. 状态回传的触发点分散在**多个模块**（前台入住 frontdesk、退房收银 cashier、
 *    渠道订单页 channel-orders），它们都只能 import 普通模块，不能直接调别人的 server action；
 * 3. 验收脚本要能 import 生产代码做断言。
 *
 * ── 调用方式（触发点接线说明）──
 *   · 前台入住成功  → pushOrderStatusForChannelOrder({ hotelId, channelOrderNo, status: "CHECKED_IN", source: "frontdesk" })
 *   · 收银退房成功  → ... status: "CHECKED_OUT"
 *   · 夜审判未到    → ... status: "NOSHOW"
 *   · 渠道订单页按钮 / 取消订单 → status: "CANCELLED" / "CONFIRMED"
 *
 * 渠道不确认（ok=false 或 accepted=false）时**不改本地状态**：
 * 本地状态是「已经发生的事实」，渠道没收到就假装同步成功，下次对账会更乱。
 * 但也不会抛错：状态回传失败不应该回滚客人入住 / 退房这种既成事实，只留痕等人处理。
 */

import { get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { getAdapter } from "@/lib/channels/index";
import { invokeWithLog } from "@/lib/channels/invoke";
import type { ChannelOrderStatus } from "@/lib/channels/types";

/** 允许回传的状态（与适配器 pushOrderStatus 的入参枚举一致） */
export const PUSHABLE_ORDER_STATUSES: readonly ChannelOrderStatus[] = [
  "CONFIRMED",
  "CHECKED_IN",
  "CHECKED_OUT",
  "NOSHOW",
  "CANCELLED",
];

/** 状态中文名（写日志 / 页面提示用） */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "已确认",
  CHECKED_IN: "已入住",
  CHECKED_OUT: "已退房",
  NOSHOW: "未到店",
  CANCELLED: "已取消",
};

/** 回传结果：调用方据此决定是否提示用户，不需要 try/catch */
export type StatusPushResult = {
  ok: boolean;
  /** 失败时的归一化错误码（NOT_CONFIGURED / UNSUPPORTED / CHANNEL_ERROR…） */
  code?: string;
  /** 一句话结果，可直接展示给前台 / 写进 op_logs */
  message: string;
  /** 实际回传的渠道单号（找不到订单时为 undefined） */
  channelOrderNo?: string;
};

/** 把任意字符串归一成合法状态；非法值返回 null */
export function normalizeOrderStatus(raw: unknown): ChannelOrderStatus | null {
  const value = String(raw ?? "")
    .trim()
    .toUpperCase();
  return PUSHABLE_ORDER_STATUSES.find((s) => s === value) ?? null;
}

/** 写一条操作日志（谁的哪个动作导致回传，审计要能追到人） */
function logOp(hotelId: number, operator: string, action: string, detail: string): void {
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    // op_logs 缺失 / 库忙时不影响回传本身
  }
}

/** 按渠道订单号或 channel_orders.id 定位一条渠道订单（都带 hotel_id，租户隔离） */
function findChannelOrder(
  hotelId: number,
  opts: { channelOrderId?: number; channelOrderNo?: string | null }
): { id: number; channel_type: string; channel_order_no: string; booking_id: number | null } | undefined {
  if (opts.channelOrderId !== undefined && Number.isFinite(opts.channelOrderId) && opts.channelOrderId > 0) {
    return get(
      `SELECT id, channel_type, channel_order_no, booking_id FROM channel_orders WHERE id = ? AND hotel_id = ?`,
      [opts.channelOrderId, hotelId]
    );
  }
  const orderNo = String(opts.channelOrderNo ?? "").trim();
  if (orderNo === "") return undefined;
  return get(
    `SELECT id, channel_type, channel_order_no, booking_id FROM channel_orders
      WHERE hotel_id = ? AND channel_order_no = ? ORDER BY id LIMIT 1`,
    [hotelId, orderNo]
  );
}

/**
 * 把一条渠道订单的状态回传给渠道。
 *
 * @param hotelId        当前酒店（一切查询都带它）
 * @param status         要回传的 PMS 状态
 * @param channelOrderId channel_orders.id（页面按钮用这个）
 * @param channelOrderNo 渠道单号（前台 / 收银侧从 bookings.channel_order_no 拿，没 id 时用这个）
 * @param reason         取消原因 / 备注
 * @param operator       操作人（写 op_logs）
 * @param source         触发来源（frontdesk / cashier / channel-orders / cron），排障用
 */
export async function pushOrderStatusForChannelOrder(opts: {
  hotelId: number;
  status: ChannelOrderStatus;
  channelOrderId?: number;
  channelOrderNo?: string | null;
  reason?: string;
  operator?: string;
  source?: string;
}): Promise<StatusPushResult> {
  const { hotelId, status } = opts;
  const operator = opts.operator ?? "system";
  const source = opts.source ?? "manual";

  const order = findChannelOrder(hotelId, opts);
  if (!order) {
    const message = `渠道订单不存在（${opts.channelOrderNo ?? `#${opts.channelOrderId ?? "-"}`}），未回传 ${ORDER_STATUS_LABEL[status]}`;
    logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", message);
    return { ok: false, code: "ORDER_NOT_FOUND", message };
  }

  const channel = get<{ id: number }>(`SELECT id FROM channels WHERE hotel_id = ? AND channel_type = ?`, [
    hotelId,
    order.channel_type,
  ]);
  if (!channel) {
    // 渠道没配置：本地状态照常推进，但没有可回传的对象 —— 说清原因而不是静默
    const message = `渠道 ${order.channel_type} 未在本店配置直连，订单 ${order.channel_order_no} 的「${ORDER_STATUS_LABEL[status]}」未回传`;
    logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", message);
    return { ok: false, code: "NOT_CONFIGURED", message, channelOrderNo: order.channel_order_no };
  }

  const result = await invokeWithLog(
    channel.id,
    hotelId,
    "PUSH_STATUS",
    (cfg) => getAdapter(cfg.channelType).pushOrderStatus(cfg, order.channel_order_no, status, opts.reason),
    { channelOrderNo: order.channel_order_no, bookingId: order.booking_id ?? undefined }
  );

  if (result.ok && result.data.accepted) {
    run(`UPDATE channel_orders SET status = ? WHERE id = ? AND hotel_id = ?`, [status, order.id, hotelId]);
    const message = `状态回传成功：订单 ${order.channel_order_no} → ${ORDER_STATUS_LABEL[status]}（${source}）${
      opts.reason ? `，原因：${opts.reason}` : ""
    }`;
    logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", message);
    return { ok: true, message, channelOrderNo: order.channel_order_no };
  }

  if (result.ok) {
    const message = `渠道未接受状态回传：订单 ${order.channel_order_no} → ${ORDER_STATUS_LABEL[status]}，本地状态保持原值`;
    logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", message);
    return { ok: false, code: "REJECTED", message, channelOrderNo: order.channel_order_no };
  }

  const message = `状态回传失败（${result.code}）：订单 ${order.channel_order_no} → ${ORDER_STATUS_LABEL[status]}，${result.message}`;
  logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", message);
  return { ok: false, code: result.code, message, channelOrderNo: order.channel_order_no };
}
