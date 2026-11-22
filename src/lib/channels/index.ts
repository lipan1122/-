/**
 * 渠道适配器注册表（整改清单 F1 / P2-10）
 *
 * 业务层只认 ChannelAdapter 接口，不认具体渠道：
 *   getAdapter("ctrip")  → CtripAdapter
 *   getAdapter("qunar")  → UnsupportedAdapter（无直连能力，label 里注明）
 *   getAdapter("任意值") → UnsupportedAdapter（兜底，保证调用方永远拿到一个可用对象）
 *
 * 为什么兜底也返回对象而不是抛错：
 *   渠道类型是数据库里的自由文本，页面上可能还有历史数据 / 新渠道先上线跑流程
 *   的情况。返回沙箱形态 + 明确的 capability 标记，比让「推送房量」按钮直接 500 更有用。
 *
 * ── P2-10 的关键变化：把「假成功」堵住 ──
 * 整改前：未知渠道 → SandboxAdapter → ok:true → 日志记 SUCCESS。
 * 于是去哪儿 / 艺龙 / 协议单位这些根本没有直连接口的渠道，页面上也显示「推送成功」，
 * 运维以为库存已经同步到渠道，实际渠道侧一条都没收到。
 *
 * 现在：
 *   · 无直连渠道由 UnsupportedAdapter 承接（仍继承 SandboxAdapter，接口行为一致，
 *     也不会发任何网络请求），但它带 capability="unsupported"；
 *   · invokeWithLog 看到 unsupported 就把这次调用的结果改判为 UNSUPPORTED 失败，
 *     日志 message 明确写「该渠道无直连能力」，不再出现假成功；
 *   · 页面用 channelCapability() 分组显示直连 / 沙箱 / 不支持。
 */

import { CtripAdapter } from "@/lib/channels/ctrip";
import { DouyinAdapter } from "@/lib/channels/douyin";
import { FliggyAdapter } from "@/lib/channels/fliggy";
import { MeituanAdapter } from "@/lib/channels/meituan";
import { SANDBOX_LABEL, SandboxAdapter } from "@/lib/channels/sandbox";
import type { ChannelAdapter, ChannelCapability, ChannelConfig, ChannelType } from "@/lib/channels/types";

/* ============================================================ 无直连渠道 */

/**
 * 已知但没有直连能力的渠道。
 *
 * 承接方是 UnsupportedAdapter：它继承沙箱（不发请求、不造数据），
 * 但把一个事实写进 capability —— 「这家渠道我们接不了」。
 */
export class UnsupportedAdapter extends SandboxAdapter {
  /** 能力标记：invokeWithLog 据此把调用改判为 UNSUPPORTED */
  readonly capability: ChannelCapability = "unsupported";

  constructor(type: ChannelType, channelName: string) {
    super(type, `沙箱（${channelName} 无直连能力）`);
  }
}

/* ============================================================ 直连渠道 */

/** 有真实直连实现的渠道（凭据配全 + 关掉沙箱才会真的发请求） */
const DIRECT_ADAPTERS: Record<string, ChannelAdapter> = {
  ctrip: new CtripAdapter(),
  meituan: new MeituanAdapter(),
  fliggy: new FliggyAdapter(),
  douyin: new DouyinAdapter(),
};

/* ============================================================ 无直连渠道 */

/** 已知但没有直连能力的渠道：统一由 UnsupportedAdapter 承接，label 注明，避免被误认为已接通 */
const INDIRECT_CHANNEL_NAMES: Record<string, string> = {
  qunar: "去哪儿",
  elong: "艺龙",
  offline: "线下协议",
  direct: "直订",
  meituan_homestay: "美团民宿",
};

const INDIRECT_ADAPTERS: Record<string, ChannelAdapter> = {};
for (const [type, name] of Object.entries(INDIRECT_CHANNEL_NAMES)) {
  INDIRECT_ADAPTERS[type] = new UnsupportedAdapter(type, name);
}

/* ============================================================ 注册表 */

/** 全部已注册适配器（含沙箱与无直连渠道），key 与 channels.channel_type 对应 */
export const ADAPTERS: Record<string, ChannelAdapter> = {
  ...DIRECT_ADAPTERS,
  sandbox: new SandboxAdapter(),
  ...INDIRECT_ADAPTERS,
};

/** 取适配器；未知类型兜底到无直连适配器，label 里保留原类型便于排查 */
export function getAdapter(channelType: string): ChannelAdapter {
  const key = String(channelType ?? "").trim().toLowerCase();
  if (key === "") return ADAPTERS.sandbox;
  return ADAPTERS[key] ?? new UnsupportedAdapter(key, `${key} 未注册直连实现`);
}

/** 该渠道是否有真实直连实现（页面可据此提示「当前为沙箱/无直连」） */
export function isDirectChannel(channelType: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIRECT_ADAPTERS, String(channelType ?? "").toLowerCase());
}

/**
 * 该渠道当前的直连能力（整改清单 P2-10）。
 *
 * 判定顺序（严格）：
 *   1. 没有直连实现 → unsupported（哪怕它是沙箱适配器，也不该被当成「流程成功」）
 *   2. 显式 sandbox 渠道 / 配置里开了沙箱 → sandbox
 *   3. 其余直连渠道 → direct
 *
 * cfg 可以不传（注册表级别的能力判定），传了就会把「这家店开了沙箱」算进去。
 */
export function channelCapability(channelType: string, cfg?: Pick<ChannelConfig, "sandbox">): ChannelCapability {
  const key = String(channelType ?? "").trim().toLowerCase();
  if (key === "sandbox") return "sandbox";
  if (!isDirectChannel(key)) return "unsupported";
  if (cfg && cfg.sandbox) return "sandbox";
  return "direct";
}

/**
 * 给日志 / 页面用的能力说明（写进 channel_sync_logs.message，不再只有「延迟 12ms」）。
 * 返回空串表示「直连渠道 + 真实凭据」，无需额外提示。
 */
export function capabilityNote(channelType: string, cfg?: Pick<ChannelConfig, "sandbox">): string {
  const capability = channelCapability(channelType, cfg);
  if (capability === "unsupported") {
    return `（该渠道无直连能力：${getAdapter(channelType).label}，本次未连接真实渠道，仅记录流程）`;
  }
  if (capability === "sandbox") return "（沙箱模式，未连接真实渠道）";
  return "";
}

/**
 * 适配器清单（渠道配置页 / 文档用）。
 * direct=false 的条目要么是沙箱，要么是该渠道没有直连能力（label 已注明）。
 */
export function listAdapters(): { type: string; label: string; direct: boolean }[] {
  const direct = Object.keys(DIRECT_ADAPTERS).map((type) => ({
    type,
    label: DIRECT_ADAPTERS[type].label,
    direct: true,
  }));
  const indirect = Object.keys(INDIRECT_CHANNEL_NAMES).map((type) => ({
    type,
    label: ADAPTERS[type].label,
    direct: false,
  }));
  return [...direct, { type: "sandbox", label: SANDBOX_LABEL, direct: false }, ...indirect];
}
