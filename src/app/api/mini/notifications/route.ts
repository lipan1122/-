/**
 * 小程序：通知列表（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * GET /api/mini/notifications?limit=50&unreadOnly=1&type=INVOICE_ISSUED
 *     （需要 Bearer token）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、清单第 302 行硬要求：只发给对应 mini_user_id，不能按手机号群发
 * ══════════════════════════════════════════════════════════════════════════
 * 落实方式有三层，缺一层都不算数：
 *   1. 表结构：mini_notifications 的唯一归属字段是 mini_user_id，
 *      **没有** mobile / guest_id 列（有手机号列就一定有人写出按手机号群发的 SQL）；
 *   2. 读取：WHERE 条件恒为 (hotel_id, mini_user_id)，mini_user_id 来自
 *      Bearer token 解析出的那一行，请求体 / query 里的 miniUserId 一律忽略；
 *   3. 写入：见 notifications/_notify.ts 的 safeNotify —— hotelId + miniUserId
 *      两个参数只能由服务端（token 上下文）提供。
 *
 * 附带说明：通知正文里也不拼手机号、身份证号，正文由服务端模板生成，
 * 只放房间号 / 单号 / 金额这类客人已经知道的信息。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、未登录 / 未绑定也能看通知吗
 * ══════════════════════════════════════════════════════════════════════════
 * 未登录：不能（401），通知挂在 mini_user_id 上，没有身份就没有收件人。
 * 已登录但未绑定手机号：**可以**看 —— 通知是「这个微信」的站内信，
 * 例如「预订成功」（小程序自助下单的用户还没绑手机号）。这与订单可见性
 * 的处理一致（mini_program_bookings 关联的是 mini_user_id，不是 guest_id）。
 */

import { requireMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { fail, miniConfigBlocked, ok } from "../_shared";
import {
  countNotifications,
  countUnreadNotifications,
  listNotifications,
  MINI_NOTIFY_TYPE_FALLBACK,
  MINI_NOTIFY_TYPE_LABEL,
} from "./_notify";

export const dynamic = "force-dynamic";

/** 通知列表是首页/消息页的常规刷新接口，阈值与查询类接口一致 */
const NOTIFY_RATE_LIMIT_PER_MINUTE = 60;

/** 单页上限：一次最多拉 100 条，再多请用 unreadOnly 或滚动加载 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: Request) {
  const limited = rateLimit(req, { scope: "mini:notifications", limit: NOTIFY_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "查询过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * 配置门槛（整改清单第 431 行）：停用小程序后通知列表也应停止下发。
   * 通知是「这个微信的站内信」，但内容里可能有订单/金额/房号 —— 停用后继续可读
   * 等于停用不彻底。
   */
  const blocked = miniConfigBlocked(user);
  if (blocked) return blocked;

  /* ---------- 收件人 = token 里的 mini_user_id，不接受任何客户端参数 ---------- */
  const hotelId = user.hotelId;
  const miniUserId = user.id;

  const url = new URL(req.url);
  const limitRaw = Number.parseInt((url.searchParams.get("limit") ?? "").trim(), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
  const unreadOnly = ["1", "true", "yes"].includes((url.searchParams.get("unreadOnly") ?? "").trim().toLowerCase());
  const type = (url.searchParams.get("type") ?? "").trim().slice(0, 40);

  const rows = listNotifications(hotelId, miniUserId, { limit, unreadOnly, type });

  return ok({
    /** 未读角标 */
    unreadCount: countUnreadNotifications(hotelId, miniUserId),
    /** 总条数（不受 limit / unreadOnly 影响，用于「共 N 条」与分页） */
    total: countNotifications(hotelId, miniUserId, false),
    returned: rows.length,
    limit,
    unreadOnly,
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      /** 类型中文名：前端不要自己映射，历史类型回退成中性文案 */
      typeLabel: MINI_NOTIFY_TYPE_LABEL[row.type] ?? MINI_NOTIFY_TYPE_FALLBACK,
      title: row.title,
      body: row.body,
      /** 是否已读 + 阅读时间（read_at 为空 = 未读） */
      read: row.read_at !== null,
      readAt: row.read_at,
      createdAt: row.created_at,
      /** 关联业务：前端据此跳详情（booking / stay / invoice / breakfast / mini_user） */
      refType: row.ref_type,
      refId: row.ref_id,
    })),
  });
}
