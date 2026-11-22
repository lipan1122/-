/**
 * 小程序：绑定手机号 / 客史（整改清单 P0-11 / P0-12）
 *
 * POST /api/mini/bind  { mobile, guestName, bookingNo?, roomNo? }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、原实现的漏洞（P0-11）
 * ══════════════════════════════════════════════════════════════════════════
 * 旧版只要 `{ mobile, guestName }`，服务端 `findGuestByIdentity(hotelId,{mobile})`
 * 命中既有档案就直接把 openid 绑上去，没有任何「手机号是本人的」证明：
 *   · 任意微信用户拿到 token → 输入别人手机号 → 绑定对方的 guest 档案；
 *   · 之后 /api/mini/member 读到对方**储值余额 / 累计消费 / 入住次数**，
 *     /api/mini/bookings 读到对方**全部订单明细**；
 *   · 而且 bind 没有频控、已绑定还能反复覆盖 → 可批量导出全店客人姓名 + VIP 等级。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、本版方案：手机号 + 「只有本人/前台知道」的单据信息
 * ══════════════════════════════════════════════════════════════════════════
 * 绑定必须同时满足：
 *   1. 提交 `bookingNo`（预订号 BKxxxx）或 `roomNo`（在住房间号）之一；
 *   2. 服务端在**本酒店**找到该预订 / 在住单，且该单登记的 mobile 与提交手机号
 *       **完全一致**（trim 后相等）；
 *   3. 该单据必须来自**酒店侧可信来源**（前台建档的预订 / 渠道订单 / 在住单），
 *      不能是「小程序自助下单」—— 见下面第 4 点的绕过分析；
 *   4. 该单处于可用状态（预订：PENDING/CONFIRMED/CHECKED_IN 且未过离店日；
 *      在住：status = INHOUSE）。
 * 四条都过了，才允许把这个 openid 绑到该手机号对应的 guest 档案。
 *
 * ── 为什么「单号」还不足够，必须限定单据来源（自审发现的绕过）──
 * 如果只要是「手机号 + 单号匹配」就放行，攻击者可以：
 *   ① 用小程序给自己下一张单，`mobile` 随手填受害者的手机号（下单接口不校验归属）；
 *   ② 拿这张自己造出来的单号 + 受害者手机号来绑定，命中受害者既有档案 → 越权复现。
 * 换句话说：**小程序自助下单里的 mobile 是攻击者可控的输入**，不能用来证明自己。
 * 所以只接受「客户端写不进去」的单据：
 *   · stays（在住单）：只能由前台入住产生；
 *   · bookings 且 created_by 非空（前台代建单）：只有员工登录 PC 端才会写；
 *   · bookings 且 channel_id 非空（OTA/渠道单）：数据来自渠道对接，小程序端无法伪造。
 * 「小程序自助下单」的单据一律拒绝，并提示到店后用房间号绑定 —— 见下方「不够的场景」。
 *
 * ── 为什么选这个方案（对比短信 / 微信授权手机号 / 前台确认）──
 * · 短信验证码：项目里的短信是第三方通道，多数部署没配（PMS_SMS_* 为空）。
 *   绑定会员是主流程，不能挂在「短信余额还有没有」上；上线后一旦欠费，
 *   整个小程序会员端不可用，属于用一个新故障换一个安全修复。
 * · 微信 getPhoneNumber：需要企业主体 + 已认证小程序，且服务端要用
 *   jscode2session 的 session_key 解密 encryptedData —— 当前登录接口刻意不落地
 *   session_key（它等价于用户数据解密密钥，落库即扩大泄露面）；大量酒店用个人
 *   或测试主体，拿不到这个权限。
 * · 前台点「确认绑定」（bindToken）：安全性最高，但需要在 PC 端客人档案/在住页
 *   加按钮与待确认列表，属于 (main) 页面写作用域（本批不允许改），并且会让
 *   「客人到店前自助绑会员」直接失效 —— 体验倒退到只能前台排队。
 * · 单据证明（本方案）：客人手上就有订单号 / 房卡上的房号，属于
 *   「本人或前台才知道」的信息；零外部依赖、零页面改造，覆盖
 *   「前台/渠道预订 → 自助绑会员」和「在住 → 绑会员」两条路径。
 *
 * ── 这个方案什么场景下不够（如实记录）──
 * · **小程序自助下单的用户，到店前无法自助绑定**：那张单的 mobile 是自填的，
 *   不构成证明；入住后用房间号绑定即可，或由前台代为绑定。这是刻意取舍：
 *   要么牺牲「提前绑会员」，要么牺牲「账号不被冒用」。
 * · 知道「别人手机号 + 别人准确单号」的人仍可绑定别人的档案。预订号是连续编号
 *   （BK3001 起），理论上可枚举。缓解措施：连续失败 5 次锁 30 分钟（落库，
 *   重启不清零）、每 IP+UA 每分钟 20 次限流、失败写 op_logs 供前台发现异常。
 *   **这仍不等于人工核身**，所以本版不把「绑定」当成资金操作的凭证：
 *   /api/mini/member、/api/mini/bookings 只是只读本人数据；储值消费 / 退款
 *   等涉钱动作必须走前台人工核身（PC 端流程不变）。
 * · 家人代订（A 的手机号下单、B 来住）、换手机号的常客，无法自助绑定，
 *   需要前台在客人档案里更新手机号 / 人工绑定。
 * · 已绑定到另一位客人的 openid 一律拒绝换绑（CONFLICT），换绑走前台。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、响应体不回吐真值（P0-11 第 5 点）
 * ══════════════════════════════════════════════════════════════════════════
 * 旧响应带 `matched`（该手机号在库里有没有档案的预言）、真实姓名、VIP 等级。
 * 本版只回 `{ bound, guestName: 打码, mobile: 打码, proof }`：
 * 绑定失败也不会区分「手机号不存在」和「单号不对」，不给枚举者任何提示。
 */

import { get, run } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { findGuestByIdentity } from "@/lib/guest-match";
import {
  bindMiniUserGuest,
  clearMiniBindFailures,
  detachMiniUserGuest,
  getMiniBindState,
  MINI_BIND_MAX_ATTEMPTS,
  recordMiniBindFailure,
  requireMiniToken,
} from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { nowIso } from "@/lib/utils";
import { fail, isMobile, maskGuestName, maskMobile, ok, readJsonBody, str } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * 老库兜底：guests.deleted 列是 /guests 页面懒加的（src/app/(main)/guests/actions.ts），
 * 全新库若还没人打开过客人档案页，这一列不存在，findGuestByIdentity 的
 * `COALESCE(deleted,0)` 会直接报 no such column。这里补一次（幂等，已存在会抛错被忽略）。
 */
function ensureGuestDeletedColumn(): void {
  try {
    run(`ALTER TABLE guests ADD COLUMN deleted INTEGER DEFAULT 0`);
  } catch {
    /* 列已存在 → 跳过（SQLite 不支持 ADD COLUMN IF NOT EXISTS） */
  }
}

/** 可用于绑定会员的预订状态（已取消 / 已离店 / 未到 都不算） */
const BINDABLE_BOOKING_STATUS = ["PENDING", "CONFIRMED", "CHECKED_IN"];

/** 绑定证明：命中哪条单据，以及该单据上登记的客史 id（可能为空） */
type BindProof =
  | { ok: true; source: "booking" | "stay"; guestId: number | null }
  | { ok: false; reason: string };

/**
 * 归一化预订号：客人可能只抄到数字部分（3012），统一补 BK 前缀。
 * 小程序下单生成的编号是 `BK${id + 3001}`（见 _shared.ts 的 nextBookingSeq）。
 */
function normalizeBookingNo(raw: string): string {
  const v = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!v) return "";
  return /^\d+$/.test(v) ? `BK${v}` : v;
}

/**
 * 用预订号验证手机号归属。
 *
 * 「查不到单」与「单存在但手机号不一致」返回**同一句**文案：
 * 两者都必须让枚举者无法区分（否则就变成「某手机号有没有预订」的预言机）。
 */
function checkBookingNo(hotelId: number, mobile: string, bookingNo: string): BindProof {
  const row = get<{
    id: number;
    guest_id: number | null;
    mobile: string | null;
    status: string | null;
    check_out_date: string | null;
    created_by: number | null;
    channel_id: number | null;
  }>(
    `SELECT id, guest_id, mobile, status, check_out_date, created_by, channel_id
       FROM bookings
      WHERE hotel_id = ? AND booking_no = ?
      LIMIT 1`,
    [hotelId, bookingNo]
  );

  if (!row || (row.mobile ?? "").trim() !== mobile) {
    return {
      ok: false,
      reason:
        "没查到与该手机号一致的预订记录。请核对：①预订号是否完整（通常以 BK 开头）；②酒店预留的手机号是否就是本次填写的号码。仍无法绑定请到酒店前台办理。",
    };
  }

  /*
   * 单据来源校验（自审发现的绕过）：
   * 「小程序自助下单」里的 mobile 是下单人自己填的 —— 攻击者可以给受害者手机号
   * 下一张单，再用这张单号来绑定受害者档案。所以只有**客户端写不进去**的单据才算证明：
   *   · created_by 非空 → 前台员工在 PC 端代建的单；
   *   · channel_id 非空 → OTA / 渠道对接进来的单。
   * 两者都为空 = 小程序自助下单，拒绝。
   */
  const createdBy = row.created_by == null ? null : Number(row.created_by);
  const channelId = row.channel_id == null ? null : Number(row.channel_id);
  if (createdBy == null && channelId == null) {
    return {
      ok: false,
      reason:
        "该预订是小程序自助下单，手机号由下单人自行填写，不能用来证明手机号归属。入住后可用房间号绑定，或请到酒店前台办理。",
    };
  }

  if (!BINDABLE_BOOKING_STATUS.includes(String(row.status ?? ""))) {
    return {
      ok: false,
      reason: "该预订已取消或已结束，不能用于绑定会员。已到店请改用房间号绑定，仍不行请到酒店前台办理。",
    };
  }

  if ((row.check_out_date ?? "") < bizToday(hotelId)) {
    return {
      ok: false,
      reason: "该预订已过离店日期，不能用于绑定会员。下次入住时再用新的预订号或房间号绑定，急用请到酒店前台办理。",
    };
  }

  return { ok: true, source: "booking", guestId: row.guest_id == null ? null : Number(row.guest_id) };
}

/**
 * 用在住房间号验证手机号归属。
 * 房间号本身是半公开信息（电梯里能看到房号牌），所以必须叠加「该在住单登记的
 * 手机号与提交手机号一致」才算证明 —— 单凭房号不构成身份证明。
 */
function checkRoomNo(hotelId: number, mobile: string, roomNo: string): BindProof {
  const row = get<{ id: number; guest_id: number | null; mobile: string | null }>(
    `SELECT s.id, s.guest_id, s.mobile
       FROM stays s
       JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND r.room_no = ? COLLATE NOCASE AND s.status = 'INHOUSE'
      ORDER BY s.id DESC
      LIMIT 1`,
    [hotelId, roomNo]
  );

  if (!row || (row.mobile ?? "").trim() !== mobile) {
    return {
      ok: false,
      reason:
        "没查到该手机号对应的在住房间。房间号请填房卡/入住单上的号码；若为预订未到店，请改用预订号（BK 开头）。换过手机号的话请到前台更新。",
    };
  }

  return { ok: true, source: "stay", guestId: row.guest_id == null ? null : Number(row.guest_id) };
}

/** 依次尝试预订号 / 房间号；两者都给了就以前者为准，失败再看后者 */
function verifyBindProof(hotelId: number, mobile: string, bookingNo: string, roomNo: string): BindProof {
  const reasons: string[] = [];

  if (bookingNo) {
    const proof = checkBookingNo(hotelId, mobile, bookingNo);
    if (proof.ok) return proof;
    reasons.push(proof.reason);
  }
  if (roomNo) {
    const proof = checkRoomNo(hotelId, mobile, roomNo);
    if (proof.ok) return proof;
    reasons.push(proof.reason);
  }

  /*
   * 两个字段都传了（小程序里填的是纯数字，分不清是房号还是省略 BK 的预订号）时，
   * 分别的文案会把用户指向单一答案（「预订号是否完整」），反而误导。
   * 这种情况给一句同时覆盖两种可能的核对清单。
   */
  if (reasons.length > 1) {
    return {
      ok: false,
      reason:
        "没查到与该手机号一致的单据。请核对：①预订号是否完整（通常以 BK 开头）；②房间号是否房卡/入住单上的号码；③手机号是否入住登记时预留的号码。仍无法绑定请到酒店前台办理。",
    };
  }

  return { ok: false, reason: reasons[0] ?? "请填写入住时登记的房间号或入住单号（预订号以 BK 开头）" };
}

/* ========================================================================== */
/*                                  接口实现                                   */
/* ========================================================================== */

export async function POST(req: Request) {
  /*
   * 限流放最前面（整改 P2-16）：绑定要校验单号，不限流就等于给出一个可枚举的
   * 身份查询接口。20 次/分钟对真人足够（填错重试几次就够），对脚本太慢。
   */
  const limited = rateLimit(req, { scope: "mini:bind", limit: 20 });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "绑定尝试过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  const mobile = str(body.mobile);
  const guestName = str(body.guestName);
  const bookingNo = normalizeBookingNo(str(body.bookingNo));
  const roomNo = str(body.roomNo);

  if (!isMobile(mobile)) {
    return fail("BAD_REQUEST", "请填写正确的 11 位手机号（入住登记时预留的号码）", 400);
  }
  if (!guestName) return fail("BAD_REQUEST", "请填写姓名", 400);
  if (guestName.length > 30) return fail("BAD_REQUEST", "姓名最多 30 个字", 400);
  if (!bookingNo && !roomNo) {
    return fail(
      "BAD_REQUEST",
      "请填写入住时登记的房间号或入住单号（预订号通常以 BK 开头，可在「我的订单」里查到），再提交一次",
      400
    );
  }
  if (bookingNo && bookingNo.length > 32) return fail("BAD_REQUEST", "预订号格式不正确，请重新核对", 400);
  if (roomNo && roomNo.length > 12) return fail("BAD_REQUEST", "房间号格式不正确，请重新核对", 400);

  const hotelId = user.hotelId;
  const now = nowIso();

  /* ---------- 1. 已绑定：同号幂等返回，异号拒绝换绑 ---------- */
  if (user.guestId) {
    const bound = get<{ id: number; name: string; mobile: string | null }>(
      `SELECT id, name, mobile FROM guests WHERE id = ? AND hotel_id = ?`,
      [user.guestId, hotelId]
    );
    if (bound) {
      if ((bound.mobile ?? "").trim() === mobile) {
        // 幂等：同一手机号重复点「绑定」不报错，也不重复写日志
        return ok({
          bound: true,
          guestName: maskGuestName(bound.name),
          mobile: maskMobile(mobile),
          proof: null,
        });
      }
      return fail("CONFLICT", "当前微信已绑定其他会员，如需换绑请联系酒店前台人工办理");
    }
    /*
     * 客史被删 / 换了酒店：视为未绑定继续走校验流程。
     * 但指针还悬着，必须先清掉 —— 否则防换绑条件会把「合法重新绑定」也挡掉
     * （见 mini-auth.ts 的 detachMiniUserGuest）。
     */
    detachMiniUserGuest(user.id);
  }

  /* ---------- 2. 失败锁定（防枚举单号） ---------- */
  const state = getMiniBindState(user.id);
  if (state?.lockedUntil && state.lockedUntil > now) {
    const remainMinutes = Math.max(1, Math.ceil((new Date(state.lockedUntil).getTime() - Date.now()) / 60000));
    return fail(
      "BIND_LOCKED",
      `绑定校验失败次数过多，请 ${remainMinutes} 分钟后再试，或直接到酒店前台办理绑定`
    );
  }

  /* ---------- 3. 单据证明：手机号必须与预订/在住单一致 ---------- */
  const proof = verifyBindProof(hotelId, mobile, bookingNo, roomNo);
  if (!proof.ok) {
    const after = recordMiniBindFailure(user.id, hotelId);
    const remain = after ? Math.max(0, MINI_BIND_MAX_ATTEMPTS - after.attempts) : 0;
    const tail = remain > 0 ? `（还可尝试 ${remain} 次，超过后将锁定 30 分钟）` : "（已锁定 30 分钟）";
    /* 失败留痕：前台可据此发现「有人拿手机号+单号在试」，也方便客人到店时追溯 */
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      "微信小程序",
      "小程序绑定失败",
      `${maskMobile(mobile)} openid ${user.openid.slice(0, 8)}… 单号=${bookingNo || "-"} 房号=${roomNo || "-"}`,
      now,
    ]);
    return fail("BIND_PROOF_FAILED", `${proof.reason}${tail}`);
  }

  /* ---------- 4. 解析客史：优先按手机号命中档案，其次用单据上的 guest_id，再不行新建 ---------- */
  ensureGuestDeletedColumn();
  const guest = resolveOrCreateGuest(hotelId, mobile, guestName, proof.guestId);
  if (!guest) return fail("BIND_FAILED", "绑定失败，请稍后重试或联系酒店前台");

  /* ---------- 5. 绑定（已绑定别的客人时 bindMiniUserGuest 会拒绝） ---------- */
  const bound = bindMiniUserGuest(user.id, guest.id, mobile);
  if (!bound) {
    return fail("CONFLICT", "当前微信已绑定其他会员，如需换绑请联系酒店前台人工办理");
  }
  clearMiniBindFailures(user.id, hotelId);

  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    "微信小程序",
    guest.created ? "小程序绑定会员（新建客史）" : "小程序绑定会员",
    `${maskMobile(mobile)} ↔ openid ${user.openid.slice(0, 8)}…（依据：${
      proof.source === "booking" ? `预订号 ${bookingNo}` : `在住房间 ${roomNo}`
    }）`,
    now,
  ]);

  /*
   * 只回打码后的姓名 / 手机号与绑定依据：
   * 不再回 `matched`（手机号在库里的预言）、真实姓名、VIP 等级真值。
   */
  return ok({
    bound: true,
    guestName: maskGuestName(guest.name),
    mobile: maskMobile(mobile),
    proof: proof.source,
  });
}

/**
 * 找到要绑的客史；没有就新建一条散客档案。
 *
 * 顺序：
 *   1. 按手机号命中既有档案（(hotel_id, mobile) 有唯一索引，最多一条）；
 *   2. 单据上登记的 guest_id（档案手机号与本次手机号不一致时的兜底，例如客人换号）；
 *   3. 都没有 → 新建档案（姓名用客人自填，手机号已由单据证明）。
 *
 * 并发兜底：两个人同时用同一手机号绑定时，第 3 步会撞 (hotel_id, mobile) 唯一索引，
 * 重新按手机号找一次即可。
 */
function resolveOrCreateGuest(
  hotelId: number,
  mobile: string,
  guestName: string,
  proofGuestId: number | null
): { id: number; name: string; created: boolean } | null {
  const hit = findGuestByIdentity(hotelId, { mobile });
  if (hit) return { id: hit.id, name: hit.name, created: false };

  if (proofGuestId) {
    const archived = get<{ id: number; name: string }>(
      `SELECT id, name FROM guests WHERE id = ? AND hotel_id = ? AND COALESCE(deleted, 0) = 0 LIMIT 1`,
      [proofGuestId, hotelId]
    );
    if (archived) return { id: archived.id, name: archived.name, created: false };
  }

  try {
    const inserted = run(
      `INSERT INTO guests (hotel_id, name, mobile, gender, vip_level, blacklist, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [hotelId, guestName, mobile, null, 0, 0, nowIso()]
    );
    return { id: Number(inserted.lastInsertRowid), name: guestName, created: true };
  } catch {
    /* (hotel_id, mobile) 唯一索引：并发下已被另一条请求建好，直接复用 */
    const again = findGuestByIdentity(hotelId, { mobile });
    return again ? { id: again.id, name: again.name, created: false } : null;
  }
}
