/**
 * 小程序：储值流水（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * GET /api/mini/member/ledger?limit=50   （需要 Bearer token）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、与 PC 端「同一本账」（清单第七节：会员储值和 PC 端余额一致）
 * ══════════════════════════════════════════════════════════════════════════
 * 余额与流水**全部**来自 src/lib/member-wallet.ts：
 *   · getWalletBalance → SUM(member_wallet_ledger.amount)
 *   · getWalletSummary → 充值 / 消费 / 退款 / 调整四项汇总
 *   · listWalletLedger → 明细（按 id 倒序）
 * 本路由不写一条自己的余额 SQL，也不碰旧表 member_wallet.balance
 * —— 第八轮刚修过「会员充值两套账」的缺陷（P1-3）：那张表的 balance 只是
 * 缓存列，真相是 ledger 流水。小程序如果读缓存列，就会出现
 * 「PC 端显示余额 500、小程序显示 300」这种必然被投诉的差异。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、只能看自己的流水
 * ══════════════════════════════════════════════════════════════════════════
 * member_id = token 绑定关系里的 guest_id（不读请求体里的 guestId / mobile）。
 * 储值账本按会员（guests.id）记账，A 用户拿不到 B 的 member_id，
 * 也就查不到 B 的流水。未绑定手机号 → NOT_BOUND（没有客史就没有账本）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、字段口径
 * ══════════════════════════════════════════════════════════════════════════
 * amount 有符号：正数入账（充值 / 正向调整）、负数出账（消费 / 退款 / 负向调整）。
 * 展示时按 biz_type 给中文名，前端不要自己从符号猜类型（REFUND 与 CONSUME
 * 都是负数，猜不出来）。balanceAfter 是记账后余额快照，便于对账。
 */

import { get } from "@/lib/db";
import { requireMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { getWalletBalance, getWalletSummary, listWalletLedger } from "@/lib/member-wallet";
import { fail, miniConfigBlocked, ok, round2 } from "../../_shared";

export const dynamic = "force-dynamic";

/** 读接口限流：流水是高频刷新页 */
const LEDGER_RATE_LIMIT_PER_MINUTE = 60;

/* 与 member-wallet.ts 的 WalletBizType 一一对应；未知类型给中性文案（历史脏数据不报错） */
const BIZ_TYPE_LABEL: Record<string, string> = {
  RECHARGE: "充值",
  CONSUME: "消费",
  REFUND: "退款",
  ADJUST: "调整",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request) {
  const limited = rateLimit(req, { scope: "mini:member:ledger", limit: LEDGER_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "查询过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * 配置门槛（整改清单第 431 行）：停用小程序后储值流水必须立刻不可读。
   * 放在鉴权之后、NOT_BOUND 之前：未配置是管理员要处理的事，优先于「还没绑定」。
   */
  const blocked = miniConfigBlocked(user);
  if (blocked) return blocked;

  if (!user.guestId) {
    /* 未绑定用户没有账本：返回业务码而不是空列表，前端才能引导去绑定 */
    return fail("NOT_BOUND", "尚未绑定手机号，请先绑定后再查看储值流水");
  }

  const hotelId = user.hotelId;
  const guestId = user.guestId;

  /* 档案必须仍然属于本店（客史被删 / 换了酒店时提示重新绑定，而不是 500） */
  const guest = get<{ id: number }>(`SELECT id FROM guests WHERE id = ? AND hotel_id = ?`, [guestId, hotelId]);
  if (!guest) return fail("NOT_BOUND", "会员档案已失效，请重新绑定手机号");

  const url = new URL(req.url);
  const limitRaw = Number.parseInt((url.searchParams.get("limit") ?? "").trim(), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

  /* ---------- 余额 / 汇总 / 明细：三个函数都来自 member-wallet.ts ---------- */
  const balance = getWalletBalance(hotelId, guestId);
  const summary = getWalletSummary(hotelId, guestId);
  const entries = listWalletLedger(hotelId, guestId, limit);

  /* 总条数用来分页与「PC 端 & 小程序条数一致」核对（同一张表，只是 COUNT） */
  const totalRow = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`,
    [hotelId, guestId]
  );

  return ok({
    /** 储值余额（元）—— 恒等于 PC 端 /members/wallet 与 getWalletBalance 的返回值 */
    balance: round2(balance),
    currency: "CNY",
    /** 汇总口径与 PC 端同一函数，不做二次计算 */
    summary: {
      recharge: round2(summary.recharge),
      consume: round2(summary.consume),
      refund: round2(summary.refund),
      adjust: round2(summary.adjust),
    },
    /** 流水总条数 / 本次返回条数 / 单页上限 */
    total: Number(totalRow?.n ?? 0),
    returned: entries.length,
    limit,
    /** 真相来源标注：告诉前端（和后来改代码的人）这不是旧表的缓存余额 */
    source: "member_wallet_ledger",
    entries: entries.map((row) => ({
      id: row.id,
      bizType: row.biz_type,
      bizTypeLabel: BIZ_TYPE_LABEL[row.biz_type] ?? "账务调整",
      /** 有符号：正入账、负出账 */
      amount: round2(Number(row.amount ?? 0)),
      /** 记账后余额快照 */
      balanceAfter: round2(Number(row.balance_after ?? 0)),
      refType: row.ref_type,
      refId: row.ref_id,
      /** 经办人（PC 端前台填写的姓名，不含手机号） */
      operator: row.operator,
      remark: row.remark,
      createdAt: row.created_at,
    })),
  });
}
