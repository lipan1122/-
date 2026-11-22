/**
 * 小程序：会员中心（整改清单 F12）
 *
 * GET /api/mini/member  （需要 Bearer token）
 *
 * 返回：等级 / 储值余额 / 积分 / 累计消费 / 入住次数。
 *
 * 口径说明（与 PC 端 /members 页面保持一致，避免小程序和前台看到两套数字）：
 *   · 等级        guests.vip_level（0 = 还没升级，显示「普通客人」）
 *   · 储值余额    src/lib/member-wallet.ts 的 getWalletBalance（真相来源是流水表，
 *                 不是 member_wallet.balance 缓存列 —— 缓存可能还没回写）
 *   · 积分        score_records 按 guest_id 求和（表由积分模块懒建，不存在就记 0）
 *   · 累计消费    folio_items 里非 DEPOSIT 的金额和，按 stay 关联到该客人
 *   · 入住次数    stays 里该客人的单据数
 *
 * 未绑定手机号时返回 NOT_BOUND，小程序据此引导到绑定页（不是异常）。
 */

import { all, get } from "@/lib/db";
import { requireMiniToken } from "@/lib/mini-auth";
import { getWalletBalance, getWalletSummary } from "@/lib/member-wallet";
import { fail, maskMobile, ok, round2 } from "../_shared";

export const dynamic = "force-dynamic";

/** 判断表是否存在（积分表由积分模块懒建，老库可能没有） */
function tableExists(name: string): boolean {
  const row = get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);
  return Number(row?.n ?? 0) > 0;
}

export async function GET(req: Request) {
  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  if (!user.guestId) {
    return fail("NOT_BOUND", "尚未绑定手机号，请先绑定后再查看会员信息");
  }

  const hotelId = user.hotelId;
  const guest = get<{ id: number; name: string; mobile: string | null; vip_level: number | null; created_at: string | null }>(
    `SELECT id, name, mobile, COALESCE(vip_level, 0) AS vip_level, created_at
       FROM guests WHERE id = ? AND hotel_id = ?`,
    [user.guestId, hotelId]
  );
  if (!guest) {
    // 客史被删 / 换了酒店：提示重新绑定，而不是抛 500
    return fail("NOT_BOUND", "会员档案已失效，请重新绑定手机号");
  }

  /* ---------- 储值：余额 + 累计充值 / 消费（同一套口径） ---------- */
  // 余额单独取一次：getWalletBalance 是整改 P1-3 收敛后的唯一余额口径（流水求和），
  // getWalletSummary 返回的 balance 也来自它，但显式调用让「余额从哪来」一眼可见。
  const balance = getWalletBalance(hotelId, guest.id);
  const wallet = getWalletSummary(hotelId, guest.id);

  /* ---------- 积分：积分表不存在时按 0，不报错 ---------- */
  let points = 0;
  let pointsEarned = 0;
  if (tableExists("score_records")) {
    const row = get<{ balance: number | null; earned: number | null }>(
      `SELECT COALESCE(SUM(points), 0) AS balance,
              COALESCE(SUM(CASE WHEN type = 'EARN' THEN points ELSE 0 END), 0) AS earned
         FROM score_records
        WHERE hotel_id = ? AND guest_id = ?`,
      [hotelId, guest.id]
    );
    points = Number(row?.balance ?? 0);
    pointsEarned = Number(row?.earned ?? 0);
  }

  /* ---------- 累计消费 / 入住次数（与 /members 页同一 SQL 口径） ---------- */
  /*
   * 整改 P0-12：这里**只能按 guest_id 取数**。
   * 旧实现是 `s.guest_id = ? OR s.guest_name = ?` —— guests.name 没有唯一约束，
   * 重名就会串号：绑一个「张三」能读到全店所有「张三」的消费与入住记录，
   * 而 guest_id 又是 P0-11 里「只凭手机号就能绑到别人档案」拿到的，两处叠加即越权。
   * 现在 guest_id 已经由 token → 绑定关系推出（见 mini-auth.ts / bind/route.ts），
   * 不再接受任何请求参数里的 mobile / guestId，也不再按姓名兜底匹配。
   */
  const stats = get<{ stay_count: number | null; total_spend: number | null }>(
    `SELECT (SELECT COUNT(*) FROM stays s
              WHERE s.hotel_id = ? AND s.guest_id = ?) AS stay_count,
            (SELECT COALESCE(SUM(fi.amount), 0)
               FROM folio_items fi
               JOIN folios f ON f.id = fi.folio_id
               JOIN stays s ON s.id = f.stay_id
              WHERE s.hotel_id = ? AND s.guest_id = ?
                AND fi.item_type <> 'DEPOSIT') AS total_spend`,
    [hotelId, guest.id, hotelId, guest.id]
  );

  /* ---------- 会员卡类型（按等级取折扣最高那张，与 /members 页一致） ---------- */
  const vip = Number(guest.vip_level ?? 0);
  let cardName = "普通客人";
  let discount = 1;
  if (tableExists("member_card_types") && vip > 0) {
    const cards = all<{ name: string; discount: number; points_ratio: number }>(
      `SELECT name, COALESCE(discount, 1) AS discount, COALESCE(points_ratio, 1) AS points_ratio
         FROM member_card_types WHERE hotel_id = ? ORDER BY discount DESC, id`,
      [hotelId]
    );
    const card = cards[Math.min(Math.max(1, vip), cards.length) - 1];
    if (card) {
      cardName = card.name;
      discount = Number(card.discount ?? 1);
    }
  }

  return ok({
    guestId: guest.id,
    guestName: guest.name,
    mobile: maskMobile(guest.mobile ?? ""),
    /** 会员等级：0 = 普通客人，1/2/3 = VIP1/VIP2/VIP3 */
    level: vip,
    levelLabel: vip > 0 ? `VIP${vip}` : "普通客人",
    cardName,
    discount,
    /** 储值余额（元） */
    balance: round2(balance),
    rechargeTotal: round2(wallet.recharge),
    consumeTotal: round2(wallet.consume),
    /*
     * 退款 / 调整两项在第九轮补齐（清单第十节要求「充值记录 / 消费记录 / 退款记录」）：
     * 与 rechargeTotal / consumeTotal 同一份 getWalletSummary 结果，不另算一套。
     * 明细见 /api/mini/member/ledger（同一张 member_wallet_ledger 表）。
     */
    refundTotal: round2(wallet.refund),
    adjustTotal: round2(wallet.adjust),
    /** 余额真相来源标注：旧表 member_wallet.balance 只是缓存，不允许作为口径 */
    walletSource: "member_wallet_ledger",
    /** 当前可用积分 / 累计获得积分 */
    points: Math.trunc(points),
    pointsEarned: Math.trunc(pointsEarned),
    /** 累计消费（元）与入住次数 */
    totalSpend: round2(Number(stats?.total_spend ?? 0)),
    stayCount: Number(stats?.stay_count ?? 0),
    joinedAt: guest.created_at,
  });
}
