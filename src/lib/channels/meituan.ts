/**
 * 美团（美团开放平台 / 酒店商家接口）直连适配器 —— 整改清单 F1
 *
 * ⚠️ 联调状态：**结构已实现，真机未验证**。本仓库没有美团开发者账号，
 * 也没有签约开通酒店库存 / 订单接口权限，以下内容均未经美团侧确认：
 *
 *   【按公开文档的地址结构编写，待联调核对】
 *     · 网关：https://openapi.meituan.com（可用 channels.endpoint 覆盖到测试环境）
 *     · 路径：ping / 房量房价推送 / 订单增量 / 订单状态四条（见 PATHS）
 *
 *   【通用模式，不是美团官方算法，待联调核对】
 *     · 签名：OTA 通用 HMAC-SHA256（参数按 key 排序后 k=v 拼接）
 *       美团开放平台实际常见 md5 / 时间戳拼接等方案，**必须以官方文档为准**；
 *     · 报文：JSON body + sign；
 *     · 业务包裹：code / message / data（readBizEnvelope 的别名表）。
 *
 *   【业务语义，待联调核对】
 *     · 房源字段：roomTypeCode / date / quantity / price / closed
 *     · 订单字段：orderId / checkInDate / checkOutDate / roomTypeCode / amount / status
 *     · 订单状态枚举：CONFIRM / CHECKIN / NOSHOW / CANCEL（见 STATUS_MAP，美团可能是数字码）
 *
 * 首次联调做法：对着官方文档逐个核对上面的清单，需要改签名 / 编码 / 字段时
 * 只改本文件的 signedPost() 与 mapOrder() / STATUS_MAP，不要动 common.ts。
 * 没有凭据时不会发任何请求：沙箱走沙箱分支，非沙箱缺凭据在入口就返回 NOT_CONFIGURED。
 */

import {
  asArray,
  asRecord,
  bizFailure,
  diffNights,
  fail,
  isMaskedSecret,
  missingCredentials,
  num,
  postSignedJson,
  readBizEnvelope,
  str,
  type ChannelFailure,
  type ParamValue,
} from "@/lib/channels/common";
import {
  sandboxPullOrders,
  sandboxPushOrderStatus,
  sandboxPushRates,
  sandboxTestConnection,
} from "@/lib/channels/sandbox";
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelOrderPayload,
  ChannelResult,
  RatePush,
} from "@/lib/channels/types";

/* ============================================================ 端点（待核对） */

/** 美团开放平台网关（公开地址结构；测试环境用 channels.endpoint 覆盖） */
const DEFAULT_ENDPOINT = "https://openapi.meituan.com";

/**
 * 接口路径：按开放平台「/业务/版本/资源/动作」的路径风格编写。
 * ⚠️ 首次联调必须对着官方文档核对，尤其是版本号与资源单复数。
 */
const PATHS = {
  ping: "/hotel/v1/ping",
  pushRates: "/hotel/v1/inventory/rates",
  pullOrders: "/hotel/v1/orders",
  pushStatus: "/hotel/v1/orders/status",
};

/** 本系统状态 → 美团状态原值（⚠️ 待联调核对，美团很可能是数字状态码） */
type OrderStatus = "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "NOSHOW" | "CANCELLED";
const STATUS_MAP: Record<OrderStatus, string> = {
  CONFIRMED: "CONFIRM",
  CHECKED_IN: "CHECKIN",
  /* 退房：美团侧可能是 CHECKOUT 或数字码，联调时核对 */
  CHECKED_OUT: "CHECKOUT",
  NOSHOW: "NOSHOW",
  CANCELLED: "CANCEL",
};

/* ============================================================ 小工具 */

/** 本渠道的签名 / 请求封装：核对文档后如果签名或编码不一致，只改这个函数 */
function signedPost(
  cfg: ChannelConfig,
  action: string,
  path: string,
  bizParams: Record<string, ParamValue>
) {
  return postSignedJson(cfg, path, DEFAULT_ENDPOINT, action, bizParams);
}

/** 非沙箱时先做凭据校验，缺凭据 / 掩码占位都不发请求 */
function blockReason(cfg: ChannelConfig): ChannelFailure | null {
  const missing = missingCredentials(cfg);
  if (missing.length > 0) {
    return fail(
      "NOT_CONFIGURED",
      `美团直连缺少凭据：${missing.join("、")}`,
      "请先在渠道配置里补全门店 id / appKey / appSecret，或保持沙箱模式"
    );
  }
  if (isMaskedSecret(cfg.appSecret)) {
    return fail(
      "NOT_CONFIGURED",
      "美团 appSecret 是掩码占位，未发起真实请求",
      "渠道配置页保存后会落库真实密钥；演示库里存的是「••••••••」"
    );
  }
  return null;
}

/** 把美团订单原始字段映射成本系统统一结构（⚠️ 字段名待联调核对） */
function mapOrder(raw: Record<string, unknown>): ChannelOrderPayload | null {
  const orderNo = str(raw.orderId ?? raw.orderNo ?? raw.order_no ?? raw.dealId);
  if (!orderNo) return null;

  const checkInDate = str(raw.checkInDate ?? raw.checkIn ?? raw.check_in_date);
  const checkOutDate = str(raw.checkOutDate ?? raw.checkOut ?? raw.check_out_date);
  const nights = num(raw.nights ?? raw.dayCount, 0) || diffNights(checkInDate, checkOutDate) || 1;

  return {
    channelOrderNo: orderNo,
    roomTypeCode: str(raw.roomTypeCode ?? raw.roomTypeId ?? raw.roomId),
    guestName: str(raw.guestName ?? raw.contactName ?? raw.userName) || "美团客人",
    mobile: str(raw.mobile ?? raw.contactPhone ?? raw.phone) || null,
    checkInDate,
    checkOutDate,
    nights,
    roomCount: num(raw.roomCount ?? raw.quantity, 1) || 1,
    amount: num(raw.amount ?? raw.totalAmount ?? raw.totalPrice, 0),
    statusRaw: str(raw.status ?? raw.orderStatus ?? raw.statusRaw) || "NEW",
    raw: { ...raw },
    createdAt: str(raw.createdAt ?? raw.createTime ?? raw.orderTime) || null,
  };
}

/* ============================================================ 适配器 */

export class MeituanAdapter implements ChannelAdapter {
  readonly type = "meituan";
  readonly label = "美团（开放平台直连）";

  async testConnection(
    cfg: ChannelConfig
  ): Promise<ChannelResult<{ latencyMs: number; message: string }>> {
    if (cfg.sandbox) return sandboxTestConnection();
    const blocked = blockReason(cfg);
    if (blocked) return blocked;

    const startedAt = Date.now();
    const res = await signedPost(cfg, "PING", PATHS.ping, {});
    if (!res.ok) return res;

    const env = readBizEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    return {
      ok: true,
      data: {
        latencyMs: Date.now() - startedAt,
        message: `美团接口连通，门店 ${cfg.storeId ?? ""} 授权有效（首次联调请核对签名与字段）`,
      },
    };
  }

  async pushRates(
    cfg: ChannelConfig,
    rows: RatePush[]
  ): Promise<ChannelResult<{ accepted: number; rejected: { code: string; reason: string }[] }>> {
    if (cfg.sandbox) return sandboxPushRates(rows);
    const blocked = blockReason(cfg);
    if (blocked) return blocked;
    if (rows.length === 0) return { ok: true, data: { accepted: 0, rejected: [] } };

    // ⚠️ 字段名按 OTA 通用结构假定：roomTypeCode / date / quantity / price / closed
    const rates = rows.map((row) => ({
      roomTypeCode: row.channelRoomTypeCode,
      date: row.date,
      quantity: row.allotment,
      price: row.price,
      closed: row.closed,
    }));

    // 复杂参数用 JSON 字符串承载（OTA 常见形态，也保证签名只覆盖标量参数）；核对文档后可改成分层参数
    const res = await signedPost(cfg, "PUSH_RATES", PATHS.pushRates, { rates: JSON.stringify(rates) });
    if (!res.ok) return res;

    const env = readBizEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    // 美团若返回逐条失败明细，需要在这里解析并入 rejected；明细结构待核对，
    // 当前按「业务成功 = 全部接受」处理，联调时补这一段。
    return { ok: true, data: { accepted: rows.length, rejected: [] } };
  }

  async pullOrders(cfg: ChannelConfig, since: string): Promise<ChannelResult<ChannelOrderPayload[]>> {
    if (cfg.sandbox) return sandboxPullOrders();
    const blocked = blockReason(cfg);
    if (blocked) return blocked;
    if (!since) return fail("CHANNEL_ERROR", "拉单缺少起始时间 since");

    const res = await signedPost(cfg, "PULL_ORDERS", PATHS.pullOrders, {
      since,
      pageSize: 100,
    });
    if (!res.ok) return res;

    const env = readBizEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    const data = asRecord(env.data);
    const rawList = Array.isArray(env.data)
      ? asArray(env.data)
      : asArray(data.orders ?? data.list ?? data.items);

    const orders: ChannelOrderPayload[] = [];
    for (const item of rawList) {
      const mapped = mapOrder(asRecord(item));
      if (mapped) orders.push(mapped);
    }
    return { ok: true, data: orders };
  }

  async pushOrderStatus(
    cfg: ChannelConfig,
    channelOrderNo: string,
    status: OrderStatus,
    reason?: string
  ): Promise<ChannelResult<{ accepted: boolean }>> {
    if (cfg.sandbox) return sandboxPushOrderStatus();
    const blocked = blockReason(cfg);
    if (blocked) return blocked;
    if (!channelOrderNo) return fail("CHANNEL_ERROR", "状态回传缺少渠道单号");

    const res = await signedPost(cfg, "PUSH_STATUS", PATHS.pushStatus, {
      orderId: channelOrderNo,
      orderStatus: STATUS_MAP[status],
      reason: reason ?? null,
    });
    if (!res.ok) return res;

    const env = readBizEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);
    return { ok: true, data: { accepted: true } };
  }
}
