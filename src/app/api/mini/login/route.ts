/**
 * 小程序登录（整改清单 F12）
 *
 * 流程：
 *   小程序 wx.login() → 拿到临时 code → POST /api/mini/login { code }
 *     → 服务端用 mini_program_config 里的 app_id + app_secret 调
 *       https://api.weixin.qq.com/sns/jscode2session 换 openid
 *     → 查 / 建 mini_program_users 行，签发 7 天 token
 *     → 返回 { token, hasGuest, guestName? }
 *
 * 三条硬底线（缺一条这个接口就不能上线）：
 *   1. **未配置就不假装成功**：app_id / app_secret 没填、或 enabled = 0 时
 *      直接返回 { ok:false, code:"NOT_CONFIGURED" }，绝不返回假 token
 *      —— 假 token 会让小程序侧以为登录成功，之后每个接口都 401，问题极难定位。
 *   2. **AppSecret 不出服务端**：只出现在发往微信的请求里，
 *      日志、错误文案、响应体都不得包含（错误文案里只放 errcode / errmsg）。
 *   3. **超时可控**：微信接口卡住不能把我们自己的请求挂死，
 *      统一 AbortSignal.timeout(10000)，超时归一到 NETWORK。
 */

import { get } from "@/lib/db";
import { getActiveMiniConfig } from "@/lib/mini-config";
import { issueMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { fail, ok, readJsonBody, str } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * 登录限流（整改清单 P2-16）
 *
 * 原来这个接口完全没有频控：每次调用都会拿 AppSecret 去请求微信
 * （出网一次 + 微信侧按 code 计数），被脚本刷时会烧服务器出网、可能触发微信风控，
 * 还会变成「盲猜 code / 探测 openid」的免费通道。
 *
 * 阈值取 30 次/分钟：真人一个页面生命周期内最多登录 1-2 次（token 有效期 7 天），
 * 30 次足够覆盖「小程序冷启动重试 / 网络抖动 / 多页面并发 ensureLogin」，
 * 对脚本又远不够用。限流键与 rooms 同规格（XFF 首段 + UA 哈希，见 mini-rate-limit.ts）。
 */
const LOGIN_RATE_LIMIT_PER_MINUTE = 30;

/** 微信 jscode2session 接口（正式环境固定域名，不需要配置） */
const WX_SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session";

/** 调用微信接口的超时时间（毫秒）：超过就按网络失败处理，不让请求无限挂着 */
const WX_TIMEOUT_MS = 10000;

/** 微信返回体（只声明用到的字段；session_key 不落地、不返回给客户端） */
type WxSessionResponse = {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

/**
 * 微信错误码 → 中文文案。
 *
 * 只映射「运营/开发能自己处理」的几类，其余原样带出 errcode，
 * 方便用户拿着错误码去微信文档里查（编文案猜原因反而误导）。
 * key 用字符串：微信返回的 errcode 可能是数字，也可能是字符串，统一 String() 后查表。
 */
const WX_ERROR_TEXT: Record<string, string> = {
  "-1": "微信系统繁忙，请稍后重试",
  40029: "登录凭证 code 无效或已过期，请重新进入小程序",
  40163: "登录凭证 code 已被使用，请重新进入小程序",
  45011: "小程序登录调用过于频繁，请稍后重试",
  40226: "该微信账号存在风险，已被微信拦截登录",
  41002: "缺少 appid：请在系统设置里填写小程序 AppID",
  41004: "AppSecret 不正确：请在系统设置里重新填写小程序 AppSecret",
  40125: "AppSecret 无效：请在系统设置里重新填写",
};

/** 把异常压成一句可展示的话（不暴露堆栈 / 内部地址） */
function errText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "请求微信服务器超时（10 秒）";
    if (e.name === "AbortError") return "请求微信服务器被中断";
    return e.message || e.name;
  }
  return String(e);
}

export async function POST(req: Request) {
  /*
   * 限流必须在读 body / 查配置 / 出网之前：否则攻击者传垃圾 code 也能
   * 免费消耗我们的解析与出网资源（整改 P2-16）。
   */
  const limited = rateLimit(req, { scope: "mini:login", limit: LOGIN_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "登录尝试过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象，形如 { code: \"...\" }", 400);

  const code = str(body.code);
  if (!code) {
    return fail("BAD_REQUEST", "缺少 code：请先在小程序端调用 wx.login() 取临时登录凭证", 400);
  }

  /* ---------- 1. 配置检查：没配就明确拒绝 ---------- */
  const cfg = getActiveMiniConfig();
  if (!cfg) {
    return fail("NOT_CONFIGURED", "小程序未配置，请管理员在系统设置里填写 AppID/AppSecret");
  }

  /* ---------- 2. 用 code 换 openid ---------- */
  const url = new URL(WX_SESSION_URL);
  url.searchParams.set("appid", cfg.appId);
  url.searchParams.set("secret", cfg.appSecret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  let payload: WxSessionResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(WX_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) {
      return fail("NETWORK", `微信登录接口返回 HTTP ${res.status}，请稍后重试`);
    }
    payload = (await res.json()) as WxSessionResponse;
  } catch (e) {
    /* 出网失败 / DNS / 超时 / 微信返回非 JSON：都归到 NETWORK，并提示排查方向 */
    return fail(
      "NETWORK",
      `调用微信登录接口失败：${errText(e)}。请检查服务器可否访问 api.weixin.qq.com，以及服务器的出网/防火墙设置`
    );
  }

  const wxErrcode = Number(payload?.errcode ?? 0);
  if (wxErrcode !== 0 || !payload?.openid) {
    const text =
      WX_ERROR_TEXT[wxErrcode] ??
      `微信登录失败（errcode ${wxErrcode || "未知"}${payload?.errmsg ? `：${payload.errmsg}` : ""}）`;
    return fail("AUTH_FAILED", text);
  }

  /* ---------- 3. 建/更新用户行并签发 token ---------- */
  const hotelId = cfg.hotelId;
  const openid = String(payload.openid);
  const { token } = issueMiniToken(hotelId, openid, payload.unionid ? String(payload.unionid) : null);

  /* ---------- 4. 已绑定的会员把名字带回去，小程序首页可以直接称呼 ---------- */
  const row = get<{ guest_id: number | null }>(
    `SELECT guest_id FROM mini_program_users WHERE hotel_id = ? AND openid = ? LIMIT 1`,
    [hotelId, openid]
  );
  let hasGuest = false;
  let guestName: string | undefined;
  if (row?.guest_id) {
    const guest = get<{ name: string }>(`SELECT name FROM guests WHERE id = ? AND hotel_id = ? LIMIT 1`, [
      row.guest_id,
      hotelId,
    ]);
    if (guest) {
      hasGuest = true;
      guestName = guest.name;
    }
  }

  return ok({ token, hasGuest, guestName, expiresInDays: 7 });
}
