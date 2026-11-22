/**
 * 小程序：退出登录（整改清单 P2-15）
 *
 * POST /api/mini/logout  （需要 Bearer token）
 *
 * ── 原来的问题 ──
 * `miniprogram/pages/member/member.js` 的「退出登录」只调 `api.clearToken()` 清本地
 * storage，服务端 `mini_program_users.session_token` 仍然有效（有效期 7 天）。
 * 也就是说「退出」只是从这台手机上抹掉了入口，凭证本身没吊销：
 *   · 手机被转卖 / 借用时，旧 token 还能继续读会员储值与订单；
 *   · token 被日志、代理、截图泄露时，用户点「退出」并不能止损。
 * `src/lib/mini-auth.ts` 里的 `revokeMiniToken` 早就写好了，但**零调用**。
 *
 * ── 本版 ──
 * 小程序先 `POST /api/mini/logout`（服务端把 session_token / token_expires_at 清空），
 * 成功后再 `api.clearToken()`；网络失败也继续本地退出（见 member.js），
 * 但服务端吊销这一步必须先尝试 —— 没有它，本地清除只是心理安慰。
 *
 * 只吊销**当前这次请求携带的 token** 对应的那一行：
 * 同一个 openid 在库里只有一行（登录即覆盖旧 token），所以也不需要「全端下线」。
 * 这里不做「按 openid 吊销」的原因：请求里只有 token 没有可信 openid，
 * 接受客户端传 openid 反而会变成「谁都能踢掉别人」的接口。
 */

import { requireMiniToken, revokeMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { fail, ok } from "../_shared";

export const dynamic = "force-dynamic";

/** 退出接口限流：正常一次点击就够，30 次/分钟纯粹防脚本刷 op 写 */
const LOGOUT_RATE_LIMIT_PER_MINUTE = 30;

export async function POST(req: Request) {
  const limited = rateLimit(req, { scope: "mini:logout", limit: LOGOUT_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * revokeMiniToken 自己会按 id 取回 hotel_id 再写（租户隔离），
   * 幂等：token 已经失效时重复调用不会报错，接口仍回 ok。
   */
  revokeMiniToken(user.id);

  return ok({ loggedOut: true });
}
