/**
 * 抖音（抖音生活服务开放平台）直连适配器 —— 整改清单 F1
 *
 * ⚠️ 联调状态：**结构已实现，真机未验证**。本仓库没有抖音开放平台开发者账号，
 * 也没有签约开通酒店/生活服务的商品与订单接口权限，以下内容均未经抖音侧确认：
 *
 *   【按公开文档的地址结构编写，待联调核对】
 *     · 网关：https://open.douyin.com（可用 channels.endpoint 覆盖到测试环境）
 *     · 路径：生活服务 goodlife 系列前缀 + 资源路径（见 PATHS），
 *       抖音的接口路径普遍带结尾斜杠；**版本号与资源名必须对着官方文档核对**。
 *
 *   【通用模式，不是抖音官方算法，待联调核对】
 *     · 签名：OTA 通用 HMAC-SHA256（参数按 key 排序后 k=v 拼接）
 *     · 报文：JSON body + sign
 *     · 业务包裹：code / message / data（抖音常用 data.error_code / description 嵌套，待核对）
 *
 *   【明确未实现的部分（不猜）】
 *     · access_token 换取：抖音生活服务正式调用需要先用 client_credential
 *       （appId + appSecret）换 access_token，再带 `access-token` 头请求业务接口。
 *       这一步没有真实凭据无法验证，且 token 缓存/刷新策略需要单独设计，
 *       所以本文件**没有实现换取流程**，先按通用签名结构占位；
 *       首次联调时在 signedPost() 前面补 token 获取，业务方法不用改。
 *     · pushOrderStatus：抖音生活服务的订单状态主要由商家后台 / 审核与履约回调驱动，
 *       主动回传接口的具体 method、参数与权限开通方式本仓库没有把握，
 *       因此这里**返回 UNSUPPORTED 而不是瞎写参数**（见文件末尾）。
 *
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

/** 抖音开放平台网关（公开地址结构；测试环境用 channels.endpoint 覆盖） */
const DEFAULT_ENDPOINT = "https://open.douyin.com";

/**
 * 接口路径：按生活服务 goodlife 系列的路径风格编写（抖音路径常以 / 结尾）。
 * ⚠️ 首次联调必须对着官方文档核对版本号、资源名与是否带结尾斜杠。
 */
const PATHS = {
  ping: "/goodlife/v1/shop/ping/",
  pushRates: "/goodlife/v1/poi/product/stock/",
  pullOrders: "/goodlife/v1/trade/order/query/",
};

/* ============================================================ 小工具 */

/**
 * 本渠道的签名 / 请求封装。
 * ⚠️ 正式联调时在这里补 access_token 换取与 `access-token` 请求头；
 * 签名算法若与文档不一致，也只改这个函数。
 */
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
      `抖音直连缺少凭据：${missing.join("、")}`,
      "请先在渠道配置里补全门店 id / appKey / appSecret，或保持沙箱模式"
    );
  }
  if (isMaskedSecret(cfg.appSecret)) {
    return fail(
      "NOT_CONFIGURED",
      "抖音 appSecret 是掩码占位，未发起真实请求",
      "渠道配置页保存后会落库真实密钥；演示库里存的是「••••••••」"
    );
  }
  return null;
}

/** 把抖音订单原始字段映射成本系统统一结构（⚠️ 字段名待联调核对） */
function mapOrder(raw: Record<string, unknown>): ChannelOrderPayload | null {
  const orderNo = str(raw.order_id ?? raw.orderId ?? raw.order_no ?? raw.out_order_no);
  if (!orderNo) return null;

  const checkInDate = str(raw.check_in ?? raw.checkInDate ?? raw.checkin ?? raw.check_in_date);
  const checkOutDate = str(raw.check_out ?? raw.checkOutDate ?? raw.checkout ?? raw.check_out_date);
  const nights = num(raw.nights ?? raw.day_count, 0) || diffNights(checkInDate, checkOutDate) || 1;

  return {
    channelOrderNo: orderNo,
    roomTypeCode: str(raw.room_type_code ?? raw.roomTypeCode ?? raw.product_id),
    guestName: str(raw.guest_name ?? raw.guestName ?? raw.user_name) || "抖音客人",
    mobile: str(raw.mobile ?? raw.phone) || null,
    checkInDate,
    checkOutDate,
    nights,
    roomCount: num(raw.room_count ?? raw.roomCount ?? raw.quantity, 1) || 1,
    amount: num(raw.amount ?? raw.pay_amount ?? raw.total_amount, 0),
    statusRaw: str(raw.status ?? raw.order_status ?? raw.statusRaw) || "NEW",
    raw: { ...raw },
    createdAt: str(raw.create_time ?? raw.created_at ?? raw.order_time) || null,
  };
}

/* ============================================================ 适配器 */

export class DouyinAdapter implements ChannelAdapter {
  readonly type = "douyin";
  readonly label = "抖音（开放平台直连）";

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
        message: `抖音接口连通，门店 ${cfg.storeId ?? ""} 授权有效（首次联调请核对 token 与签名）`,
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
    const res = await signedPost(cfg, "PUSH_RATES", PATHS.pushRates, {
      poi_id: cfg.storeId,
      rates: JSON.stringify(rates),
    });
    if (!res.ok) return res;

    const env = readBizEnvelope(res.body);
    if (!env.success) return bizFailure(env, res.text);

    // 抖音若返回逐条失败明细，需要在这里解析并入 rejected；明细结构待核对，
    // 当前按「业务成功 = 全部接受」处理，联调时补这一段。
    return { ok: true, data: { accepted: rows.length, rejected: [] } };
  }

  async pullOrders(cfg: ChannelConfig, since: string): Promise<ChannelResult<ChannelOrderPayload[]>> {
    if (cfg.sandbox) return sandboxPullOrders();
    const blocked = blockReason(cfg);
    if (blocked) return blocked;
    if (!since) return fail("CHANNEL_ERROR", "拉单缺少起始时间 since");

    const res = await signedPost(cfg, "PULL_ORDERS", PATHS.pullOrders, {
      poi_id: cfg.storeId,
      start_time: since,
      page_size: 100,
    });
    if (!res.ok) return res;

    const env = readBizEnvelope(res.body);
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

  /**
   * 订单状态回传：**明确返回 UNSUPPORTED**。
   *
   * 原因（如实说明，不瞎写）：
   *   1. 抖音生活服务的订单履约状态大量依赖商家后台操作与平台回调（核销 / 退款审核），
   *      主动回传接口是否开放、method 叫什么、要哪些参数，公开文档细节本仓库没有把握；
   *   2. 状态回传通常还要单独申请权限，未签约时写死参数只会得到无法定位的 CHANNEL_ERROR。
   * 等拿到开发者账号与文档后，再在这里实现；业务层收到 UNSUPPORTED 会跳过回传并在日志里注明。
   */
  async pushOrderStatus(
    cfg: ChannelConfig,
    _channelOrderNo: string,
    _status: "CONFIRMED" | "CHECKED_IN" | "CHECKED_OUT" | "NOSHOW" | "CANCELLED",
    _reason?: string
  ): Promise<ChannelResult<{ accepted: boolean }>> {
    if (cfg.sandbox) {
      // 沙箱仍返回 accepted：让「已确认 → 回传成功」的流程在演示环境能走通
      return sandboxPushOrderStatus();
    }
    return fail(
      "UNSUPPORTED",
      "抖音暂不支持订单状态回传",
      "抖音生活服务的订单状态回传接口与权限开通方式待联调核对，当前直接跳过回传"
    );
  }
}
