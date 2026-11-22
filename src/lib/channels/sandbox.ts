/**
 * 沙箱适配器（整改清单 F1）
 *
 * ── 为什么先做它 ──
 * 携程 / 美团 / 飞猪 / 抖音的开放平台都要「商户资质 + 开发者账号 + 签约」才发 app_key，
 * 本仓库拿不到真实凭据。没有沙箱，渠道同步这条业务链（推送房量房价 → 拉单 → 转预订 →
 * 回传状态）在联调之前根本跑不起来，页面只能看不能点。
 *
 * ── 沙箱的行为约定（硬约束） ──
 *   1. 不发任何真实网络请求（连 DNS 都不查）；
 *   2. 确定性：同样的输入永远得到同样的输出，不用 Math.random；
 *   3. 幂等、无副作用：不写 channels / channel_orders / channel_sync_logs / bookings，
 *      连跑一万次库里也不会多一行；
 *   4. 不造订单：pullOrders 永远返回空数组。需要测试订单流的，用
 *      src/app/(main)/channel-orders/actions.ts 里的生成器（它负责造单并落 channel_orders）。
 *
 * 真实适配器（ctrip / meituan / fliggy / douyin）在 cfg.sandbox = true 时直接复用本文件
 * 导出的 sandbox* 助手，保证「没凭据走沙箱」和直接使用 SandboxAdapter 的行为完全一致。
 */

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelOrderPayload,
  ChannelResult,
  ChannelType,
  RatePush,
} from "@/lib/channels/types";

/* ============================================================ 对外常量 */

/** 沙箱模拟的固定延迟（毫秒）：写死而不是随机，测试才能稳定断言 */
export const SANDBOX_LATENCY_MS = 12;

/** 连通性测试的固定文案 */
export const SANDBOX_TEST_MESSAGE = "沙箱模式，未连接真实渠道";

/** 沙箱不造订单的说明：接口里没有 message 字段放它，导出给调用方写进日志 / 页面提示 */
export const SANDBOX_PULL_NOTE =
  "沙箱模式不产生订单，如需测试请用 channel-orders/actions.ts 的生成器";

/** 负库存的拒绝原因（验收脚本按原文断言） */
export const SANDBOX_NEGATIVE_ALLOTMENT_REASON = "库存不能为负";

/** 沙箱适配器的默认显示名 */
export const SANDBOX_LABEL = "沙箱（不连接真实渠道）";

/* ============================================================ 可复用助手 */

/** 沙箱版连通性测试：固定 12ms，代表「本地走通了流程」，不代表渠道可达 */
export function sandboxTestConnection(): ChannelResult<{ latencyMs: number; message: string }> {
  return { ok: true, data: { latencyMs: SANDBOX_LATENCY_MS, message: SANDBOX_TEST_MESSAGE } };
}

/**
 * 沙箱版房量房价推送：
 *   - 库存 >= 0：全部 accepted（含 closed=true 的关房，关房是合法推送）；
 *   - 库存 < 0：rejected，reason = "库存不能为负"。
 *
 * rejected 的类型只有 { code, reason }，没有房型/日期字段，
 * 所以 code 编码成 `房型编码@营业日`，出问题时能直接定位到具体一行。
 */
export function sandboxPushRates(
  rows: RatePush[]
): ChannelResult<{ accepted: number; rejected: { code: string; reason: string }[] }> {
  const rejected: { code: string; reason: string }[] = [];
  for (const row of rows) {
    if (row.allotment < 0) {
      rejected.push({
        code: `${row.channelRoomTypeCode}@${row.date}`,
        reason: SANDBOX_NEGATIVE_ALLOTMENT_REASON,
      });
    }
  }
  return { ok: true, data: { accepted: rows.length - rejected.length, rejected } };
}

/**
 * 沙箱版拉单：永远空数组（沙箱不造业务数据）。
 * 需要测试拉单流程时，调用方自行插入 channel_orders 或走渠道订单页的生成器。
 */
export function sandboxPullOrders(): ChannelResult<ChannelOrderPayload[]> {
  return { ok: true, data: [] };
}

/** 沙箱版状态回传：一律接受（沙箱不校验渠道真实状态机） */
export function sandboxPushOrderStatus(): ChannelResult<{ accepted: boolean }> {
  return { ok: true, data: { accepted: true } };
}

/* ============================================================ 适配器 */

/**
 * 沙箱实现。
 *
 * type / label 允许构造时覆盖：getAdapter() 遇到没有直连能力的渠道（qunar / elong / offline…）
 * 会返回一个 SandboxAdapter，并把 label 标成「… 无直连能力」，让页面和日志一眼看出区别。
 */
export class SandboxAdapter implements ChannelAdapter {
  readonly type: ChannelType;
  readonly label: string;

  constructor(type: ChannelType = "sandbox", label: string = SANDBOX_LABEL) {
    this.type = type;
    this.label = label;
  }

  async testConnection(_cfg: ChannelConfig): Promise<ChannelResult<{ latencyMs: number; message: string }>> {
    // 沙箱不读凭据、不发请求：_cfg 只为满足接口签名
    return sandboxTestConnection();
  }

  async pushRates(
    _cfg: ChannelConfig,
    rows: RatePush[]
  ): Promise<ChannelResult<{ accepted: number; rejected: { code: string; reason: string }[] }>> {
    return sandboxPushRates(rows);
  }

  async pullOrders(_cfg: ChannelConfig, _since: string): Promise<ChannelResult<ChannelOrderPayload[]>> {
    return sandboxPullOrders();
  }

  async pushOrderStatus(
    _cfg: ChannelConfig,
    _channelOrderNo: string,
    _status: "CONFIRMED" | "CHECKED_IN" | "NOSHOW" | "CANCELLED",
    _reason?: string
  ): Promise<ChannelResult<{ accepted: boolean }>> {
    return sandboxPushOrderStatus();
  }
}
