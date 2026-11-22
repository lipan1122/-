/**
 * 小程序：解除绑定（注销小程序会员绑定）
 *
 * POST /api/mini/member/unbind   （需要 Bearer token）
 *
 *   step 1（不带 confirmToken）
 *     → 服务端签发一次性确认 token（5 分钟有效），返回二次确认指令
 *   step 2（带 confirmToken + confirmText="解绑"）
 *     → 校验 token / 归属 / 时效 / 明文字确认，然后解绑并**立即吊销当前会话**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、为什么解绑必须二次确认（清单第八节：绑定、解绑都要做权限检查）
 * ══════════════════════════════════════════════════════════════════════════
 * 解绑的后果是「客人看不到自己的订单、储值、发票」—— 属于破坏性动作，
 * 而且客人往往是在「以为在切换账号」时误点。所以不能一个 POST 直接生效：
 *   ① 第一次请求只做「我要解绑」的意图确认，服务端签发 confirmToken；
 *   ② 第二次请求必须同时具备：有效 Bearer token（同一 mini_user_id）+
 *      confirmToken（只有发过第一次请求才拿得到、5 分钟内有效、绑定到
 *      hotel_id + mini_user_id + guest_id 三元组）+ 明文输入「解绑」。
 *
 * ── confirmToken 为什么用 HMAC 而不是落库 ──
 * 落库要新加表或新加列（本批 schema 变更只批了 room_types 与 mini_notifications），
 * 而确认令牌是**纯一次性凭证**：签名里带过期时间就够了。
 * 密钥优先取 PMS_MINI_UNBIND_SECRET，其次 SESSION_SECRET（.env.example 已约定
 * 生产必配），都没有时用开发兜底串 —— 与 src/lib/crypto.ts 的取材方式一致，
 * 换密钥只会让进行中的确认令牌失效，不影响数据。
 * 签名用 timingSafeEqual 比较，避免按字节比较泄露签名前缀。
 *
 * ── 这个方案不解决什么（如实记录）──
 * confirmToken 防的是「误触 / 跨站伪造的悄悄解绑」，不防「攻击者已经拿到
 * Bearer token」——那种情况下他本来就能读全部会员数据，解绑只是破坏而非越权。
 * 真正的权限边界是 token 鉴权 + 只能解绑自己 + 解绑后立即失效会话（见第三节）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、解绑只动绑定关系，不动任何业务数据
 * ══════════════════════════════════════════════════════════════════════════
 * · mini_program_users.guest_id → NULL（detachMiniUserGuest）
 * · 绑定失败计数 / 锁定清零（clearMiniBindFailures），换个人重新绑定不受影响
 * · guests / stays / folios / member_wallet_ledger / invoices 一律不动
 *   —— 客史与账务是酒店的法定记录，不能因为客人换微信就消失。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、解绑后 token 立即失效
 * ══════════════════════════════════════════════════════════════════════════
 * 调 revokeMiniToken：把 session_token / token_expires_at 清空。
 * 之后任何带旧 token 的请求都会在 requireMiniToken 里返回 null → 401。
 * 这是清单「解绑后 token 失效」的落实方式，也是避免「解绑了但旧 token
 * 还能读到上一段绑定缓存」的唯一可靠做法（身份缓存住在客户端内存里，
 * 服务端只能让凭证本身作废）。
 */

import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { get, run } from "@/lib/db";
import {
  clearMiniBindFailures,
  detachMiniUserGuest,
  requireMiniToken,
  revokeMiniToken,
} from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { nowIso } from "@/lib/utils";
import { fail, maskGuestName, maskMobile, ok, readJsonBody, str } from "../../_shared";
import { MINI_NOTIFY_TYPE, safeNotify } from "../../notifications/_notify";

export const dynamic = "force-dynamic";

/** 解绑是低频破坏性动作：限流比查询紧，防脚本反复刷确认令牌 */
const UNBIND_RATE_LIMIT_PER_MINUTE = 10;

/** 确认令牌有效期：5 分钟（够客人读完提示并输入「解绑」） */
const CONFIRM_TTL_MS = 5 * 60 * 1000;

/** 二次确认的明文字（要求客人手输，防误触；两种写法都认） */
const CONFIRM_TEXT = ["解绑", "确认解绑"];

/** 确认令牌 payload（紧凑字段名，减少 token 长度） */
type ConfirmPayload = {
  /** hotel_id */
  h: number;
  /** mini_user_id */
  u: number;
  /** guest_id（解绑对象；换绑后旧令牌自动失效） */
  g: number;
  /** 过期时间（epoch ms） */
  e: number;
};

let cachedKey: Buffer | null = null;

/** 派生签名密钥（进程内缓存一次；scrypt 有成本，不在每次请求里做） */
function confirmKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material =
    (process.env.PMS_MINI_UNBIND_SECRET ?? "").trim() ||
    (process.env.SESSION_SECRET ?? "").trim() ||
    /* 开发 / 演示兜底：与 crypto.ts 的 DEV_FALLBACK_MATERIAL 同级风险，
       生产部署必须配 SESSION_SECRET（.env.example 已标注为必配项） */
    "pms-dev-only-mini-unbind";
  cachedKey = scryptSync(material, "pms:mini:unbind-confirm:v1", 32);
  return cachedKey;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", confirmKey()).update(payloadB64).digest("base64url");
}

/** 签发确认令牌：base64url(payload).base64url(hmac) */
function issueConfirmToken(hotelId: number, miniUserId: number, guestId: number): string {
  const payload: ConfirmPayload = {
    h: hotelId,
    u: miniUserId,
    g: guestId,
    e: Date.now() + CONFIRM_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * 校验确认令牌。
 * 返回 null 表示通过；否则返回给客人看的中文原因。
 * 所有失败都不区分「签名不对」和「过期太久」以外的细节，避免变成探测工具。
 */
function verifyConfirmToken(token: string, hotelId: number, miniUserId: number, guestId: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "确认信息无效，请重新发起解绑";
  const [body, sig] = parts;

  const expected = sign(body);
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return "确认信息无效，请重新发起解绑";
  }

  let payload: ConfirmPayload | null = null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object") payload = parsed as ConfirmPayload;
  } catch {
    payload = null;
  }
  if (!payload) return "确认信息无效，请重新发起解绑";

  /* 三元组必须完全一致：换人、换店、换绑对象后旧令牌一律作废 */
  if (Number(payload.h) !== hotelId || Number(payload.u) !== miniUserId || Number(payload.g) !== guestId) {
    return "确认信息与当前账号不匹配，请重新发起解绑";
  }
  if (!Number.isFinite(Number(payload.e)) || Date.now() > Number(payload.e)) {
    return "确认已超时，请重新发起解绑";
  }
  return null;
}

/** 操作日志：op_logs 缺失时不能反过来让业务失败 */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string): void {
  try {
    const exists =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0;
    if (!exists) return;
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    /* 审计失败不影响业务结果 */
  }
}

export async function POST(req: Request) {
  const limited = rateLimit(req, { scope: "mini:member:unbind", limit: UNBIND_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);
  if (!user.guestId) {
    return fail("NOT_BOUND", "当前账号尚未绑定手机号，无需解绑");
  }

  const hotelId = user.hotelId;
  const guestId = user.guestId;

  const body = (await readJsonBody(req)) ?? {};
  const confirmToken = str(body.confirmToken);

  /* ---------- step 1：只发确认指令，不改任何数据 ---------- */
  if (!confirmToken) {
    const guest = get<{ name: string; mobile: string | null }>(
      `SELECT name, COALESCE(mobile, '') AS mobile FROM guests WHERE id = ? AND hotel_id = ?`,
      [guestId, hotelId]
    );
    if (!guest) {
      /* 档案已失效：清掉悬空指针，让用户能重新绑定（与 bind 路由的兜底一致） */
      detachMiniUserGuest(user.id);
      return fail("NOT_BOUND", "会员档案已失效，已清除绑定关系，请重新绑定手机号");
    }

    return ok({
      stage: "CONFIRM_REQUIRED",
      confirmToken: issueConfirmToken(hotelId, user.id, guestId),
      expiresInSeconds: Math.round(CONFIRM_TTL_MS / 1000),
      /** 让客人确认「解绑的确实是这个身份」——两项都已脱敏 */
      guestName: maskGuestName(guest.name ?? ""),
      mobile: maskMobile(guest.mobile ?? ""),
      hint: "解绑后将无法查看该会员的订单、储值与发票。请在 5 分钟内输入「解绑」两个字并提交确认。",
      /** 前端据此渲染二次确认弹窗 */
      confirmText: "解绑",
      /** 解绑不会删除任何入住 / 账务记录，如实说明，减少客服压力 */
      notice: "解绑只解除微信与该会员档案的关联，不影响你已完成或正在进行的入住与账单。",
    });
  }

  /* ---------- step 2：校验二次确认 ---------- */
  const confirmText = str(body.confirmText);
  if (!CONFIRM_TEXT.includes(confirmText)) {
    return fail("CONFIRM_REQUIRED", "请按提示手输「解绑」两个字以确认本次操作", 400);
  }

  const tokenError = verifyConfirmToken(confirmToken, hotelId, user.id, guestId);
  if (tokenError) return fail("CONFIRM_INVALID", tokenError, 400);

  /* 前置快照（用于日志：解绑的到底是谁） */
  const guest = get<{ name: string; mobile: string | null }>(
    `SELECT name, COALESCE(mobile, '') AS mobile FROM guests WHERE id = ? AND hotel_id = ?`,
    [guestId, hotelId]
  );
  const maskedMobile = maskMobile(guest?.mobile ?? "");
  const maskedName = maskGuestName(guest?.name ?? "");

  /* ---------- 执行解绑：只动绑定关系 ---------- */
  detachMiniUserGuest(user.id);
  clearMiniBindFailures(user.id, hotelId);

  /* 会话立即作废：旧 token 之后一律 401（清单：解绑后 token 失效） */
  revokeMiniToken(user.id);

  /* 审计：解绑属于敏感动作，写 op_logs 供前台发现异常（清单第四节「所有敏感动作写日志」） */
  writeOpLog(
    hotelId,
    `小程序会员#${user.id}`,
    "小程序解绑",
    `解除绑定 · 微信用户 ${user.id} · 会员 ${maskedName} · 手机 ${maskedMobile || "—"} · 撤销会话`
  );

  /* 站内通知（发完就解绑，历史通知保留，不与绑定关系联动） */
  safeNotify({
    hotelId,
    miniUserId: user.id,
    type: MINI_NOTIFY_TYPE.UNBOUND,
    title: "已解除会员绑定",
    body: "本微信已解除与会员档案的关联，如需重新绑定请在「我的」中按提示操作。历史订单与账单不会丢失。",
    refType: "mini_user",
    refId: user.id,
  });

  return ok({
    stage: "UNBOUND",
    unbind: true,
    /** 会话已吊销：前端应清掉本地 token 并回到未登录态 */
    loggedOut: true,
    message: "已解除绑定，请重新登录小程序",
  });
}
