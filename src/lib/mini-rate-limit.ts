/**
 * 小程序接口限流（整改清单 P2-16）
 *
 * ── 为什么需要这个模块 ──
 * 原来只有 /api/mini/rooms 自带一份限流代码：
 *   · /api/mini/login 完全不限流 —— 每次调用都会拿 AppSecret 去请求微信
 *     （出网请求 + 微信侧有「code 无效」错误码计数），被脚本刷时既烧配额又可能
 *     把微信接口刷到风控；攻击者还能拿它做「盲猜 code」探测。
 *   · /api/mini/bind 也不限流 —— 绑定接口要校验单号，不限流就能枚举。
 * 所以把限流收敛成一份实现，login / rooms / bind 共用，参数只差阈值。
 *
 * ── 限流键为什么是「XFF 首段 + UA 哈希」而不是纯 IP ──
 * `x-forwarded-for` 是代理写的头，直连时客户端可以自己伪造：
 *   · 伪造不同 IP 就能绕过「按 IP 计数」；
 *   · 运营商 CGNAT 下大量真实用户共享同一个出口 IP，纯 IP 计数会误伤整片用户
 *     （整改点：60 次/分钟在 CGNAT 下会把同一个小区的人一起挡住）。
 * 所以键里再掺一段 UA 的哈希：
 *   · 同一出口 IP 下不同机型/微信版本落进不同桶，显著降低误伤；
 *   · 脚本想绕开必须同时换 IP 与 UA，成本比只换一个高。
 *
 * ── 必须说清楚的边界 ──
 * 这**不是安全边界**：代理头可以伪造，换 IP + 换 UA 仍能绕过。
 * 它只是一道「成本闸门」，挡掉无脑脚本和意外放大（比如小程序死循环重试）。
 * 真正的鉴权在 token / 绑定关系 / 单号校验上，任何一条都不能依赖这里。
 *
 * ── 存储 ──
 * 进程内存 Map，零依赖、零 I/O。代价是多实例部署时每个实例各算一份
 * （单机酒店部署够用；真要做全局精确限流得换 Redis 或网关层）。
 * Map 有上限，超限时先清过期桶，极端情况整体重置 ——
 * 宁可短时放松，也不能让扫 IP 的脚本把进程内存撑爆。
 */

/** 默认窗口：1 分钟 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** 最多跟踪多少个限流桶（超出后清理 / 重置） */
const MAX_TRACKED_BUCKETS = 20_000;

/** key → { count: 当前窗口已用次数, resetAt: 窗口结束的时间戳(ms) } */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** FNV-1a 32 位哈希：只用来把长 UA 压成短键，不做任何安全用途 */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 取调用方标识：XFF 第一段（没有则 x-real-ip，都没有归为 unknown）+ UA 哈希。
 *
 * 只取 XFF 第一段：链路上第一个值才是客户端地址，后面是代理链；
 * 取整段会让「同一台代理后面的所有人」混进同一个桶。
 */
export function rateLimitKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
  const ua = req.headers.get("user-agent") ?? "";
  return `${ip}|${hashText(ua)}`;
}

export type RateLimitOptions = {
  /** 分作用域计数：login / rooms / bind 各自独立，互不挤占配额 */
  scope: string;
  /** 窗口内允许的次数（超出即拒绝） */
  limit: number;
  /** 窗口长度（毫秒），默认 1 分钟 */
  windowMs?: number;
};

export type RateLimitDecision = {
  /** true = 超限，调用方回 429 */
  limited: boolean;
  /** 建议的 Retry-After（秒）：窗口剩余时间上取整，最小 1 */
  retryAfterSeconds: number;
  /** 本次请求落进的桶键（便于日志排查，不含敏感信息） */
  key: string;
};

/**
 * 记一次请求并返回是否超限。
 *
 * 注意：**先计数再判断**，所以连参数非法的请求也计入 ——
 * 否则脚本只要一直传错参数就能免费刷解析逻辑。
 */
export function rateLimit(req: Request, options: RateLimitOptions): RateLimitDecision {
  const { scope, limit } = options;
  const windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : RATE_LIMIT_WINDOW_MS;
  const now = Date.now();
  const key = `${scope}|${rateLimitKey(req)}`;

  /* 桶数量兜底：先清过期，仍然超限就整体重置（同 rooms 原实现的口径） */
  if (buckets.size > MAX_TRACKED_BUCKETS) {
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k);
    }
    if (buckets.size > MAX_TRACKED_BUCKETS) buckets.clear();
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, retryAfterSeconds: 0, key };
  }

  bucket.count += 1;
  if (bucket.count <= limit) return { limited: false, retryAfterSeconds: 0, key };

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return { limited: true, retryAfterSeconds, key };
}
