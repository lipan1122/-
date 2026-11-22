/**
 * 小程序 Token 鉴权（整改清单 F12）
 *
 * ── 为什么不复用 PC 端的 session ──
 * src/lib/session.ts 依赖 next/headers 的 Cookie（pms_sid），只适用于同源浏览器。
 * 小程序用 wx.request 发请求，不自动带 Cookie，也没有「同源」概念，
 * 所以会员端走独立的 Bearer token：登录时把 token 存进小程序 storage，
 * 之后每次请求放到 `Authorization: Bearer <token>` 头里。
 *
 * ── 与 PC 端一致的推导方式 ──
 * PC 端 SessionUser 由 sessions 表推导（不信任客户端内容）；这里同理：
 * 客户端只持有随机 token，身份、酒店、绑定客史全部以 mini_program_users 表为准。
 *
 * ── 有效期 ──
 * 7 天。过期后接口返回 401，小程序端捕获后重新 wx.login 换新 token
 * （见 miniprogram/utils/api.js 的 ensureLogin）。
 */

import { randomUUID } from "node:crypto";
import { get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { ensureMiniSchema } from "@/lib/mini-config";

/** token 有效期：7 天（毫秒） */
export const MINI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 绑定校验连续失败上限（整改清单 P0-11）
 *
 * 绑定需要「手机号 + 入住单号/房号」双重证明。单号是连续编号（BK3001 起），
 * 理论上可枚举，所以必须有次数上限：连续失败 5 次锁 30 分钟，
 * 让「盲猜单号」从「几秒钟试完」变成「半天试不出一个」。
 */
export const MINI_BIND_MAX_ATTEMPTS = 5;

/** 达到失败上限后的锁定时长：30 分钟（到期自动解锁，不需要人工介入） */
export const MINI_BIND_LOCK_MS = 30 * 60 * 1000;

/** 鉴权通过后的最小身份信息（业务代码只看这个，不再关心表结构） */
export type MiniUser = {
  /** mini_program_users.id */
  id: number;
  openid: string;
  hotelId: number;
  /** 绑定到 guests.id（未绑定手机号时为 null） */
  guestId: number | null;
};

/** 从请求头里取 Bearer token，取不到返回空串 */
export function readBearerToken(req: Request): string {
  const raw = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : "";
}

/** mini_program_users 行（只声明用得到的列） */
type MiniUserRow = {
  id: number;
  hotel_id: number;
  openid: string;
  guest_id: number | null;
  token_expires_at: string | null;
};

/**
 * 用 token 解析出身份。
 *
 * 校验顺序（任何一步不通过都返回 null）：
 *   1. token 为空 → null
 *   2. 表里查不到该 token → null（被顶号 / 伪造）
 *   3. token_expires_at 缺失或已过期 → null，并顺手把 token 清掉
 *
 * 时间比较用 ISO 字符串字典序：库里存的是 nowIso() 的 UTC ISO（2026-11-18T06:00:00.000Z），
 * 同格式同长度，字典序 === 时间序（与 src/lib/session.ts 的判定口径一致）。
 */
export function resolveMiniUser(token: string): MiniUser | null {
  const t = (token ?? "").trim();
  if (!t) return null;
  ensureMiniSchema();

  const row = get<MiniUserRow>(
    `SELECT id, hotel_id, openid, guest_id, token_expires_at
       FROM mini_program_users
      WHERE session_token = ?
      LIMIT 1`,
    [t]
  );
  if (!row) return null;

  const expires = (row.token_expires_at ?? "").trim();
  if (!expires || expires <= nowIso()) {
    // 过期即清空，避免旧 token 长期留在表里（下次登录会覆盖）
    run(`UPDATE mini_program_users SET session_token = NULL, token_expires_at = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
      nowIso(),
      row.id,
      row.hotel_id,
    ]);
    return null;
  }

  return {
    id: Number(row.id),
    openid: row.openid,
    hotelId: Number(row.hotel_id),
    guestId: row.guest_id == null ? null : Number(row.guest_id),
  };
}

/**
 * 接口鉴权入口：`const user = requireMiniToken(req); if (!user) return 401`
 * 返回 null 表示未登录 / token 过期 / token 无效，调用方统一回 UNAUTHORIZED。
 */
export function requireMiniToken(req: Request): MiniUser | null {
  return resolveMiniUser(readBearerToken(req));
}

/**
 * 登录成功后签发 token（openid 首次出现时建行，重复登录只换 token）
 *
 * 用 ON CONFLICT 而不是「先查再插」：两个人同时用同一 openid 登录时，
 * 先查再插会撞唯一索引；upsert 是原子的一条语句，微信偶尔重试回调也不会报错。
 */
export function issueMiniToken(
  hotelId: number,
  openid: string,
  unionid: string | null = null
): { token: string; userId: number; expiresAt: string } {
  ensureMiniSchema();
  const token = randomUUID().replace(/-/g, "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MINI_TOKEN_TTL_MS).toISOString();
  const nowText = now.toISOString();

  run(
    `INSERT INTO mini_program_users
       (hotel_id, openid, unionid, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(hotel_id, openid) DO UPDATE SET
       unionid = COALESCE(excluded.unionid, mini_program_users.unionid),
       session_token = excluded.session_token,
       token_expires_at = excluded.token_expires_at,
       updated_at = excluded.updated_at`,
    [hotelId, openid, unionid || null, token, expiresAt, nowText, nowText]
  );

  const row = get<{ id: number }>(`SELECT id FROM mini_program_users WHERE hotel_id = ? AND openid = ?`, [
    hotelId,
    openid,
  ]);
  return { token, userId: Number(row?.id ?? 0), expiresAt };
}

/** 绑定相关的服务端状态（整改清单 P0-11） */
export type MiniBindState = {
  /** 已绑定的 guests.id（未绑定为 null） */
  guestId: number | null;
  /** 连续失败次数（成功绑定后清零） */
  attempts: number;
  /** 锁定截止时间（ISO，UTC）；为空或已过期表示未锁定 */
  lockedUntil: string | null;
};

/**
 * 读取绑定状态（含失败计数 / 锁定截止）。
 *
 * 失败计数落库而不是放内存：进程重启后仍然记得「这个 openid 已经试错 4 次」，
 * 否则攻击者只要等实例重启就能无限重试枚举单号。
 */
export function getMiniBindState(userId: number): MiniBindState | null {
  ensureMiniSchema();
  const row = get<{ guest_id: number | null; bind_attempts: number | null; bind_locked_until: string | null }>(
    `SELECT guest_id, bind_attempts, bind_locked_until
       FROM mini_program_users
      WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (!row) return null;
  return {
    guestId: row.guest_id == null ? null : Number(row.guest_id),
    attempts: Number(row.bind_attempts ?? 0),
    lockedUntil: (row.bind_locked_until ?? "").trim() || null,
  };
}

/**
 * 记一次绑定失败；达到上限时写锁定截止时间。
 * 返回计数后的状态，调用方据此决定文案（还要不要提示「还剩几次」）。
 */
export function recordMiniBindFailure(userId: number, hotelId: number): MiniBindState | null {
  ensureMiniSchema();
  const state = getMiniBindState(userId);
  if (!state) return null;

  const attempts = state.attempts + 1;
  const lockedUntil =
    attempts >= MINI_BIND_MAX_ATTEMPTS ? new Date(Date.now() + MINI_BIND_LOCK_MS).toISOString() : state.lockedUntil;

  run(
    `UPDATE mini_program_users
        SET bind_attempts = ?, bind_locked_until = ?, updated_at = ?
      WHERE id = ? AND hotel_id = ?`,
    [attempts, lockedUntil, nowIso(), userId, hotelId]
  );
  return { ...state, attempts, lockedUntil };
}

/** 绑定成功 / 前台改绑后清零失败计数与锁定 */
export function clearMiniBindFailures(userId: number, hotelId: number): void {
  ensureMiniSchema();
  run(
    `UPDATE mini_program_users
        SET bind_attempts = 0, bind_locked_until = NULL, updated_at = ?
      WHERE id = ? AND hotel_id = ?`,
    [nowIso(), userId, hotelId]
  );
}

/**
 * 绑定客史（只有在调用方**已核实手机号归属**后才可以调用 —— 整改清单 P0-11）
 *
 * ── 与上一版的区别 ──
 * 上一版允许「已绑定再换绑」：`UPDATE ... SET guest_id = ?` 无条件覆盖，
 * 于是攻击者拿到任意 token 后，可以反复 bind 把同一个 openid 绑到不同客人身上。
 * 本版加两道保险：
 *   1. 已绑定到**另一位**客人时直接拒绝（返回 false，由路由回 CONFLICT），
 *      换绑必须走前台人工核身；
 *   2. 成功绑定后清零失败计数与锁定，避免「合法绑定」还背着上一轮的锁定。
 *
 * 同时更新 mobile 冗余列（展示用）。**注意**：mobile 列不是查询凭证，
 * /api/mini/member、/api/mini/bookings 一律只用 guest_id / 订单关联表取数
 * （整改 P0-12），绝不按手机号反查别人的档案或订单。
 */
export function bindMiniUserGuest(userId: number, guestId: number, mobile: string): boolean {
  ensureMiniSchema();
  // 租户隔离：函数签名只有 userId（调用方是 /api/mini/bind 路由），
  // 所以写入前先按 id 取回该行的 hotel_id，UPDATE 带 id + hotel_id 双条件；
  // 真正的租户边界仍在 resolveMiniUser：身份由全局唯一的 session_token 解析出那一行。
  const row = get<{ hotel_id: number; guest_id: number | null }>(
    `SELECT hotel_id, guest_id FROM mini_program_users WHERE id = ?`,
    [userId]
  );
  if (!row) return false;
  if (row.guest_id != null && Number(row.guest_id) !== guestId) return false;

  const now = nowIso();
  const result = run(
    `UPDATE mini_program_users
        SET guest_id = ?, mobile = ?, bind_attempts = 0, bind_locked_until = NULL, updated_at = ?
      WHERE id = ? AND hotel_id = ? AND (guest_id IS NULL OR guest_id = ?)`,
    [guestId, mobile, now, userId, row.hotel_id, guestId]
  );
  return result.changes > 0;
}

/**
 * 清掉悬空的 guest_id（客史档案被删 / 换了酒店时用）。
 *
 * 场景：用户已绑定 guest 79，后来前台把这条档案删了（guests.deleted=1 或整行删除）。
 * 这时 mini_program_users.guest_id 还指向 79，但档案不存在 —— 路由会判定
 * 「未绑定」并允许重新绑定，可 bindMiniUserGuest 的防换绑条件
 * （guest_id IS NULL OR guest_id = 新 guestId）会挡住写入，用户就永远绑不上。
 * 所以在确认档案不存在后，先把悬空指针清掉，再走正常绑定流程。
 */
export function detachMiniUserGuest(userId: number): void {
  ensureMiniSchema();
  const row = get<{ hotel_id: number }>(`SELECT hotel_id FROM mini_program_users WHERE id = ?`, [userId]);
  if (!row) return;
  run(`UPDATE mini_program_users SET guest_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
    nowIso(),
    userId,
    row.hotel_id,
  ]);
}

/** 退出登录（小程序「退出」按钮用）：只清当前设备的 token */
export function revokeMiniToken(userId: number): void {
  ensureMiniSchema();
  // 同上：先取回该行的 hotel_id 再写，避免将来有人把外部 id 直接传进来时越界更新
  const row = get<{ hotel_id: number }>(`SELECT hotel_id FROM mini_program_users WHERE id = ?`, [userId]);
  if (!row) return;
  run(`UPDATE mini_program_users SET session_token = NULL, token_expires_at = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
    nowIso(),
    userId,
    row.hotel_id,
  ]);
}
