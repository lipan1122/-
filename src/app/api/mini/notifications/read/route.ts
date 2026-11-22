/**
 * 小程序：标记通知已读（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * POST /api/mini/notifications/read   （需要 Bearer token）
 *   { id: 12 }                 标记单条
 *   { ids: [12, 13] }          批量标记（最多 100 条）
 *   { all: true }              全部标记已读
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、为什么必须带 mini_user_id 条件（越权更新的经典口子）
 * ══════════════════════════════════════════════════════════════════════════
 * 「标记已读」看起来无害，但如果不带收件人条件：
 *   ① 任何人都能把**别人**的未读清空（清掉客人还没看到的通知 = 事实上的删消息）；
 *   ② 还能通过 changes 数量判断某个 id 是否存在（枚举预言机）。
 * 所以所有 UPDATE 的 WHERE 都是
 *   (hotel_id = ? AND mini_user_id = ? AND id IN (...))
 * 且返回值只报「影响行数」，不区分「不存在」与「不属于你」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、幂等
 * ══════════════════════════════════════════════════════════════════════════
 * 只写 read_at IS NULL 的行：重复点击 / 网络重试不会覆盖首次阅读时间
 * （客人问「我什么时候看的」时，答案是第一次看的时间，而不是最后一次点击）。
 * 第二次调用返回 updated = 0，前端按成功处理即可。
 */

import { run } from "@/lib/db";
import { requireMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { nowIso } from "@/lib/utils";
import { fail, int, miniConfigBlocked, ok, readJsonBody } from "../../_shared";
import { countUnreadNotifications, ensureMiniNotificationsSchema } from "../_notify";

export const dynamic = "force-dynamic";

/** 写操作限流：比列表紧，防批量刷 */
const READ_RATE_LIMIT_PER_MINUTE = 30;

/** 单次最多标记多少条（防止一个请求带一万个 id） */
const MAX_IDS = 100;

export async function POST(req: Request) {
  const limited = rateLimit(req, { scope: "mini:notifications:read", limit: READ_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * 配置门槛（整改清单第 431 行）：停用后不再接受「标记已读」这类写操作。
   * 放在读请求体之前 —— 配置就不合规时没有任何理由解析业务入参。
   */
  const blocked = miniConfigBlocked(user);
  if (blocked) return blocked;

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  const hotelId = user.hotelId;
  const miniUserId = user.id;
  ensureMiniNotificationsSchema();

  /* ---------- 1. 收件范围：单条 / 批量 / 全部 ---------- */
  const markAll = body.all === true || body.all === 1 || body.all === "1";
  const ids: number[] = [];
  const single = int(body.id);
  if (single > 0) ids.push(single);
  if (Array.isArray(body.ids)) {
    for (const raw of body.ids) {
      const n = int(raw);
      if (n > 0) ids.push(n);
    }
  }
  const uniqueIds = [...new Set(ids)];

  if (!markAll && uniqueIds.length === 0) {
    return fail("BAD_REQUEST", "请指定要标记已读的通知", 400);
  }
  if (uniqueIds.length > MAX_IDS) {
    return fail("BAD_REQUEST", `单次最多标记 ${MAX_IDS} 条，请分批提交`, 400);
  }

  const readAt = nowIso();
  let updated = 0;

  if (markAll) {
    /* 全部已读：仍然只作用于自己这个 mini_user_id */
    const res = run(
      `UPDATE mini_notifications
          SET read_at = ?
        WHERE hotel_id = ? AND mini_user_id = ? AND read_at IS NULL`,
      [readAt, hotelId, miniUserId]
    );
    updated += Number(res.changes ?? 0);
  }

  if (uniqueIds.length > 0) {
    /*
     * 占位符按 id 数量拼（SQLite 变量上限远大于 100，这是安全的）；
     * 参数顺序：read_at, hotelId, miniUserId, ...ids
     */
    const placeholders = uniqueIds.map(() => "?").join(",");
    const res = run(
      `UPDATE mini_notifications
          SET read_at = ?
        WHERE hotel_id = ? AND mini_user_id = ? AND read_at IS NULL
          AND id IN (${placeholders})`,
      [readAt, hotelId, miniUserId, ...uniqueIds]
    );
    updated += Number(res.changes ?? 0);
  }

  return ok({
    /** 本次真正从「未读」变「已读」的条数（重复标记返回 0，属正常） */
    updated,
    /** 剩余未读数（前端角标直接用它） */
    unreadCount: countUnreadNotifications(hotelId, miniUserId),
    readAt,
  });
}
