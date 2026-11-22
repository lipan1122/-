/**
 * 渠道直连适配器接口（整改清单 F1）
 *
 * ── 现实前提（必须先说清楚）──
 * 携程 / 美团 / 飞猪 / 抖音的开放平台都要求：
 *   1. 商户资质（营业执照、特种行业许可证、酒店星级证明）
 *   2. 申请开发者账号并签约（部分渠道要交保证金）
 *   3. 拿到 app_key / app_secret / 门店 id 后由渠道方开通接口权限
 * 这些凭据**只能由酒店方申请**，代码里不能编造。
 *
 * ── 本模块的定位 ──
 * 把「对接一家渠道」这件事抽象成统一接口，做到：
 *   · 凭据填进渠道配置 → 立刻可跑（不用改代码）
 *   · 每家渠道的端点 / 签名 / 报文各自封装，互不污染
 *   · 所有调用都有超时、错误码归一、重试计数、日志留痕
 *   · 没填凭据时走 sandbox 实现，业务流程能完整跑通（便于演示和联调前验收）
 *
 * ── 不能在代码里假装的事 ──
 * 各家的签名算法、字段名、错误码以官方文档为准。本文件给出的是**结构**，
 * 真机上首次联调必须对着渠道方文档逐个字段核对（见 docs/渠道对接清单.md）。
 */

import { decryptSecret } from "@/lib/crypto";

/** 渠道类型（与 channels.channel_type 对应） */
export type ChannelType = "ctrip" | "meituan" | "fliggy" | "douyin" | "qunar" | "elong" | string;

/**
 * 渠道直连能力（整改清单 P2-10）
 *
 * 三种状态的业务含义完全不同，页面上必须分开说，不能一律「同步成功」：
 *   direct      有真实直连实现（凭据配全 + 关掉沙箱时真的发请求）
 *   sandbox     沙箱：流程能跑通，但没有连接真实渠道（演示 / 联调前）
 *   unsupported 该渠道没有直连能力（去哪儿 / 艺龙 / 协议单位…）：只能记录，不能推送
 *
 * 之所以从布尔值升级成枚举：布尔值只能表达「是不是沙箱」，
 * 而「无直连能力」被当成沙箱时，日志里就出现了「推送成功」的假成功。
 */
export type ChannelCapability = "direct" | "sandbox" | "unsupported";

/** 一家渠道的配置（来自 channels 表） */
export type ChannelConfig = {
  id: number;
  hotelId: number;
  channelType: ChannelType;
  name: string;
  /** 渠道方给的门店/酒店 id */
  storeId: string | null;
  appKey: string | null;
  appSecret: string | null;
  /** 是否启用 */
  enabled: boolean;
  /** 拉单后是否自动转预订 */
  autoImport: boolean;
  /** 佣金比例 0~1 */
  commission: number;
  /** 是否允许超售（false = 严格按可售房量推送） */
  oversell: boolean;
  /** 自定义端点（多用于测试环境或私有化部署） */
  endpoint: string | null;
  /** 是否沙箱模式：true 表示不真正发请求，只走流程 */
  sandbox: boolean;
};

/** 推送房量房价的一行（某房型某营业日） */
export type RatePush = {
  /** 渠道方的房型编码（映射表里配的） */
  channelRoomTypeCode: string;
  /** 营业日 YYYY-MM-DD */
  date: string;
  /** 可售房量 */
  allotment: number;
  /** 单价（含税） */
  price: number;
  /** 是否关房 */
  closed: boolean;
  /** 本系统房型 id（新增，可选）：推价被拒时能直接定位到房型，不用靠编码反查 */
  roomTypeId?: number;
  /**
   * 编码来源（新增，可选，整改清单 P2-10）
   *
   *   mapped     channel_room_types 里配了渠道房型名 —— 可以直接推
   *   local-code 没配映射，用的是本系统 room_types.code 兜底 —— **渠道侧必然报房型不存在**
   *
   * 生产路径（planRatePush）会把 local-code 的行剔出来放进 rejected，
   * 绝不再把本地编码当渠道编码推过去然后统计成 accepted。
   */
  mappingSource?: "mapped" | "local-code";
};

/** 从渠道拉回来的一单 */
export type ChannelOrderPayload = {
  channelOrderNo: string;
  roomTypeCode: string;
  guestName: string;
  mobile: string | null;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  roomCount: number;
  amount: number;
  /** 渠道订单状态原值 */
  statusRaw: string;
  /** 渠道给的其余原始字段（存 channel_orders.raw） */
  raw: Record<string, unknown>;
  /** 下单时间 */
  createdAt: string | null;
};

/** 统一返回：ok=false 时带归一化错误码和原文 */
export type ChannelResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ChannelErrorCode; message: string; detail?: string };

/**
 * 归一化错误码（各家错误码五花八门，统一到这里便于前端分类处理）
 *
 * AUTH_FAILED      凭据错误 / 签名失败 / 未授权
 * NOT_CONFIGURED   凭据没填或渠道没启用
 * NETWORK          连接超时 / DNS / TLS
 * CHANNEL_ERROR    渠道方返回业务错误（如房型不存在、库存不足）
 * RATE_LIMITED     触发限流
 * UNSUPPORTED      该渠道不支持这个操作
 */
export type ChannelErrorCode =
  | "AUTH_FAILED"
  | "NOT_CONFIGURED"
  | "NETWORK"
  | "CHANNEL_ERROR"
  | "RATE_LIMITED"
  | "UNSUPPORTED";

/**
 * 可回传给渠道的订单状态。
 *
 * CHECKED_OUT（退房）是整改指令 4.1 要求补的：渠道要知道客人已离店，
 * 否则渠道侧一直显示在住，影响房态释放和佣金结算。
 */
export type ChannelOrderStatus = "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "NOSHOW" | "CANCELLED";

/**
 * 渠道适配器：每家渠道实现这一组方法，业务层只认接口不认渠道。
 */
export interface ChannelAdapter {
  /** 渠道类型标识 */
  readonly type: ChannelType;
  /** 渠道显示名 */
  readonly label: string;

  /**
   * 连通性测试：验证凭据是否有效、门店是否可达。
   * 渠道配置页的「测试连接」按钮调它。
   */
  testConnection(cfg: ChannelConfig): Promise<ChannelResult<{ latencyMs: number; message: string }>>;

  /**
   * 推送房量房价：把未来 N 天的可售房量与价格同步到渠道。
   * 返回每条推送的结果（部分失败要能定位到具体房型+日期）。
   */
  pushRates(cfg: ChannelConfig, rows: RatePush[]): Promise<ChannelResult<{ accepted: number; rejected: { code: string; reason: string }[] }>>;

  /**
   * 拉取订单增量：按 since 之后的时间窗拉新订单。
   * 实现必须保证「同一渠道单号重复拉取只会返回一次」（靠 channel_order_no 幂等）。
   */
  pullOrders(cfg: ChannelConfig, since: string): Promise<ChannelResult<ChannelOrderPayload[]>>;

  /**
   * 回传订单状态：把本系统的「已确认 / 已入住 / 未到店 / 已取消」推回渠道。
   * 有些渠道不支持，实现里返回 UNSUPPORTED。
   */
  pushOrderStatus(
    cfg: ChannelConfig,
    channelOrderNo: string,
    status: ChannelOrderStatus,
    reason?: string
  ): Promise<ChannelResult<{ accepted: boolean }>>;
}

/* ============================================================ 配置读取 */

/**
 * 从 channels 表的一行构造配置对象（补默认值、解析 sandbox/endpoint、解密密钥）。
 *
 * 整改清单 P2-11：`app_secret` 只作为**历史明文**兜底，优先读 `app_secret_enc`。
 * 解密失败（换了 SESSION_SECRET / 密文损坏）返回空串 → isConfigured 判成
 * NOT_CONFIGURED，页面提示「请重新填写密钥」，绝不拿半截密钥去请求渠道网关。
 */
export function buildChannelConfig(row: {
  id: number;
  hotel_id: number;
  channel_type: string;
  name: string | null;
  store_id: string | null;
  app_key: string | null;
  app_secret: string | null;
  /** 整改清单 P2-11：加密后的密钥（新库才有该列，老库按可选处理） */
  app_secret_enc?: string | null;
  enabled: number | null;
  auto_import: number | null;
  commission: number | null;
  oversell: number | null;
  endpoint?: string | null;
  sandbox?: number | null;
}): ChannelConfig {
  // 加密列优先；没有密文时退回历史明文（迁移会把明文加密并清空，兼容期两边都能读）
  const appSecret = decryptSecret(row.app_secret_enc) || decryptSecret(row.app_secret);

  return {
    id: row.id,
    hotelId: row.hotel_id,
    channelType: row.channel_type,
    name: row.name ?? row.channel_type,
    storeId: row.store_id,
    appKey: row.app_key,
    appSecret: appSecret === "" ? null : appSecret,
    enabled: Number(row.enabled) === 1,
    autoImport: Number(row.auto_import) === 1,
    commission: Number(row.commission ?? 0),
    oversell: Number(row.oversell) === 1,
    endpoint: row.endpoint ?? null,
    /* 没有 app_secret 就默认按沙箱跑：避免半配置状态下真的往渠道发请求 */
    sandbox:
      row.sandbox === undefined || row.sandbox === null
        ? appSecret === ""
        : Number(row.sandbox) === 1,
  };
}

/** 凭据是否配全（channel 直连的最小前提） */
export function isConfigured(cfg: ChannelConfig): boolean {
  if (!cfg.enabled) return false;
  if (cfg.sandbox) return true; // 沙箱模式不要求凭据
  return Boolean(cfg.storeId && cfg.appKey && cfg.appSecret);
}
