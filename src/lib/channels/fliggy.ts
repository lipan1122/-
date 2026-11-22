/**
 * 飞猪（飞猪开放平台 / 淘宝开放平台 TOP 网关）直连适配器 —— 整改清单 F1
 *
 * ⚠️ 联调状态：**结构已实现，真机未验证**。本仓库没有飞猪开发者账号，
 * 也没有签约开通酒店库存 / 订单接口权限，以下内容均未经飞猪侧确认：
 *
 *   【按公开文档的地址结构编写，待联调核对】
 *     · 飞猪走淘宝开放平台 TOP 网关：https://eco.taobao.com/router/rest
 *       （一个网关地址 + method 参数区分接口，可用 channels.endpoint 覆盖到测试环境）
 *     · 接口用 method 名区分（alitrip.hotel.*，见 METHODS）
 *
 *   【按 TOP 网关的通用形态编写，待联调核对】
 *     · 编码：application/x-www-form-urlencoded（TOP 网关的常见形态）
 *     · 公共参数：method / app_key / timestamp / format / v / sign_method / sign
 *     · timestamp：yyyy-MM-dd HH:mm:ss（本地时区，TOP 通常要求 GMT+8）
 *     · 响应包裹：正常响应是 `<method>_response`，错误是 `error_response`
 *
 *   【通用模式，不是 TOP 官方算法，待联调核对】
 *     · 签名：本文件用 OTA 通用 HMAC-SHA256（参数按 key 排序后 k=v 拼接）
 *       ⚠️ TOP 实际的 hmac-sha256 是「key 排序后 key+value 直接拼接」再做 HMAC，
 *       不包含 `=` 与 `&`；正式联调时**必须**按官方文档改 signParams 的调用方式。
 *
 *   【业务语义，待联调核对】
 *     · 房源参数：hotel_id / rates
 *     · 订单参数：hotel_id / start_time / page_size；状态回传 order_id / reason
 *     · 订单字段：order_id / checkin / checkout / room_type_code / amount / status
 *
 * 首次联调做法：对着官方文档逐个核对上面的清单，需要改签名 / 编码 / 字段时
 * 只改本文件的 topRequest()、readTopEnvelope()、mapOrder()、STATUS_METHOD，
 * 不要动 common.ts。没有凭据时不会发任何请求。
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
  readBizEnvelope,
  requestJson,
  resolveEndpoint,
  signParams,
  str,
  type BizEnvelope,
  type ChannelFailure,
  type HttpResult,
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

/** 淘宝开放平台 TOP 网关（飞猪接口挂在这套网关上；测试环境用 channels.endpoint 覆盖） */
const DEFAULT_ENDPOINT = "https://eco.taobao.com/router/rest";

/**
 * 接口 method 名（⚠️ 待联调核对）。
 * 飞猪的酒店接口在 TOP 上以 alitrip.hotel.* 命名，具体 method 与版本以官方文档为准。
 */
const METHODS = {
  ping: "alitrip.hotel.ping",
  pushRates: "alitrip.hotel.rate.update",
  pullOrders: "alitrip.hotel.order.list",
  confirm: "alitrip.hotel.order.confirm",
  checkin: "alitrip.hotel.order.checkin",
  noshow: "alitrip.hotel.order.noshow",
  checkout: "alitrip.hotel.order.checkout",
  cancel: "alitrip.hotel.order.cancel",
};

/** 本系统状态 → TOP method（⚠️ 待联调核对：TOP 通常是「一个动作一个 method」） */
type OrderStatus = "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "NOSHOW" | "CANCELLED";
const STATUS_METHOD: Record<OrderStatus, string> = {
  CONFIRMED: METHODS.confirm,
  CHECKED_IN: METHODS.checkin,
  /* 退房：TOP 的 checkout method 名待联调核对 */
  CHECKED_OUT: METHODS.checkout,
  NOSHOW: METHODS.noshow,
  CANCELLED: METHODS.cancel,
};

/* ============================================================ 小工具 */

/** TOP 的 timestamp 格式（⚠️ 待核对：通常是 GMT+8 的 yyyy-MM-dd HH:mm:ss，这里用服务器本地时区） */
function topTimestamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(
    now.getMinutes()
  )}:${p(now.getSeconds())}`;
}

/**
 * 本渠道的签名 / 请求封装：核对文档后如果签名或编码不一致，只改这个函数。
 * TOP 网关用 form-urlencoded，签名在公共参数 + 业务参数之上计算。
 */
async function topRequest(
  cfg: ChannelConfig,
  method: string,
  bizParams: Record<string, ParamValue>
): Promise<HttpResult> {
  const params: Record<string, ParamValue> = {
    method,
    app_key: cfg.appKey,
    timestamp: topTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: "hmac-sha256",
    ...bizParams,
  };
  const sign = signParams(params, cfg.appSecret ?? "");

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, sign })) {
    if (value === undefined || value === null) continue;
    form.set(key, String(value));
  }

  const url = resolveEndpoint(cfg, DEFAULT_ENDPOINT, "");
  return requestJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      accept: "application/json",
    },
    body: form.toString(),
  });
}

/**
 * 读取 TOP 响应：
 *   · 出错：{ error_response: { code, msg, sub_code, sub_msg } }
 *   · 正常：{ "<method>_response": { code?, msg?, result? } }
 * 没有这两种结构时退回通用包裹解析。
 */
function readTopEnvelope(body: unknown): BizEnvelope {
  const rec = asRecord(body);

  if (rec.error_response !== undefined) {
    const err = asRecord(rec.error_response);
    return {
      success: false,
      code: str(err.code) || "ERROR_RESPONSE",
      message: str(err.sub_msg) || str(err.msg) || "飞猪 / TOP 网关返回错误",
      data: err,
    };
  }

  const responseKey = Object.keys(rec).find((key) => key.endsWith("_response"));
  if (!responseKey) return readBizEnvelope(body);

  const inner = asRecord(rec[responseKey]);
  const code = str(inner.code);
  // TOP 的业务码：空 / 0 / 200 都按成功处理（⚠️ 各接口口径待核对）
  const success = code === "" || code === "0" || code === "200";
  return {
    success,
    code,
    message: str(inner.msg ?? inner.message),
    data: inner.result ?? inner.data ?? inner,
  };
}

/** 非沙箱时先做凭据校验，缺凭据 / 掩码占位都不发请求 */
function blockReason(cfg: ChannelConfig): ChannelFailure | null {
  const missing = missingCredentials(cfg);
  if (missing.length > 0) {
    return fail(
      "NOT_CONFIGURED",
      `飞猪直连缺少凭据：${missing.join("、")}`,
      "请先在渠道配置里补全门店 id / appKey / appSecret，或保持沙箱模式"
    );
  }
  if (isMaskedSecret(cfg.appSecret)) {
    return fail(
      "NOT_CONFIGURED",
      "飞猪 appSecret 是掩码占位，未发起真实请求",
      "渠道配置页保存后会落库真实密钥；演示库里存的是「••••••••」"
    );
  }
  return null;
}

/** 把飞猪订单原始字段映射成本系统统一结构（⚠️ 字段名待联调核对） */
function mapOrder(raw: Record<string, unknown>): ChannelOrderPayload | null {
  const orderNo = str(raw.order_id ?? raw.orderId ?? raw.tid ?? raw.orderNo);
  if (!orderNo) return null;

  const checkInDate = str(raw.checkin ?? raw.checkInDate ?? raw.check_in_date);
  const checkOutDate = str(raw.checkout ?? raw.checkOutDate ?? raw.check_out_date);
  const nights = num(raw.nights ?? raw.day_count, 0) || diffNights(checkInDate, checkOutDate) || 1;

  return {
    channelOrderNo: orderNo,
    roomTypeCode: str(raw.room_type_code ?? raw.roomTypeCode ?? raw.room_type_id),
    guestName: str(raw.guest_name ?? raw.guestName ?? raw.buyer_nick) || "飞猪客人",
    mobile: str(raw.mobile ?? raw.contact_phone ?? raw.phone) || null,
    checkInDate,
    checkOutDate,
    nights,
    roomCount: num(raw.room_count ?? raw.roomCount ?? raw.quantity, 1) || 1,
    amount: num(raw.amount ?? raw.total_amount ?? raw.total_price, 0),
    statusRaw: str(raw.status ?? raw.order_status ?? raw.statusRaw) || "NEW",
    raw: { ...raw },
    createdAt: str(raw.created ?? raw.created_at ?? raw.create_time) || null,
  };
}

/* ============================================================ 适配器 */

export class FliggyAdapter implements ChannelAdapter {
  readonly type = "fliggy";
  readonly label = "飞猪（开放平台直连）";

  async testConnection(
    cfg: ChannelConfig
  ): Promise<ChannelResult<{ latencyMs: number; message: string }>> {
    if (cfg.sandbox) return sandboxTestConnection();
    const blocked = blockReason(cfg);
    if (blocked) return blocked;

    const startedAt = Date.now();
    const res = await topRequest(cfg, METHODS.ping, { hotel_id: cfg.storeId });
    if (!res.ok) return res;

    const env = readTopEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    return {
      ok: true,
      data: {
        latencyMs: Date.now() - startedAt,
        message: `飞猪接口连通，门店 ${cfg.storeId ?? ""} 授权有效（首次联调请核对签名与字段）`,
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

    // TOP 的复杂参数常用 JSON 字符串承载；核对后可改成分层参数
    const res = await topRequest(cfg, METHODS.pushRates, {
      hotel_id: cfg.storeId,
      rates: JSON.stringify(rates),
    });
    if (!res.ok) return res;

    const env = readTopEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    // 飞猪若返回逐条失败明细，需要在这里解析并入 rejected；明细结构待核对，
    // 当前按「业务成功 = 全部接受」处理，联调时补这一段。
    return { ok: true, data: { accepted: rows.length, rejected: [] } };
  }

  async pullOrders(cfg: ChannelConfig, since: string): Promise<ChannelResult<ChannelOrderPayload[]>> {
    if (cfg.sandbox) return sandboxPullOrders();
    const blocked = blockReason(cfg);
    if (blocked) return blocked;
    if (!since) return fail("CHANNEL_ERROR", "拉单缺少起始时间 since");

    const res = await topRequest(cfg, METHODS.pullOrders, {
      hotel_id: cfg.storeId,
      start_time: since,
      page_size: 100,
    });
    if (!res.ok) return res;

    const env = readTopEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    const data = asRecord(env.data);
    const rawList = Array.isArray(env.data)
      ? asArray(env.data)
      : asArray(data.orders ?? data.order_list ?? data.items);

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

    const res = await topRequest(cfg, STATUS_METHOD[status], {
      order_id: channelOrderNo,
      reason: reason ?? "",
    });
    if (!res.ok) return res;

    const env = readTopEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);
    return { ok: true, data: { accepted: true } };
  }
}
