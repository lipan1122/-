/**
 * 小程序：当前账单
 *
 * GET /api/mini/stays/:id/folio   （需要 Bearer token）
 *
 * ── 三件事 ──
 * 1. **归属**：stayId 必须属于当前 mini_user（loadOwnedStay：guest_id 匹配
 *    或 guest_id 为空的历史单 + 客史手机号一致）。伪造别人的 stayId 一律 404。
 * 2. **folioId 不由客户端提供**：账单号从 stays.id → folios.stay_id 由服务端推出来。
 *    客户端即使构造 `?folioId=999` 也不会被读到（本接口根本不读 query）。
 * 3. **金额全部服务端算**：
 *      · total = SUM(folio_items.amount) 排除押金与「部分结账」负项（computeFolioBalance，
 *        与收银台同一个口径，见 src/lib/folio.ts 的 NON_REVENUE_ITEM）；
 *      · paid = folios.paid_amount；
 *      · balance = total − paid（负数表示应退客人）。
 *    响应里没有任何「客户端可推导的总价」参与计算。
 *
 * 为什么明细要排除押金行却又要单独给 depositHeld：
 * 押金是负债不是消费（交了 600 押金、消费 1764，应收是 1764 而不是 2364）。
 * 明细列表照实回吐（客人要能看到自己交过押金），但「应收」只算消费。
 */

import { all } from "@/lib/db";
import { computeFolioBalance, depositHeld } from "@/lib/folio";
import { bizToday } from "@/lib/biz-date";
import {
  fail,
  loadStayFolio,
  loadOwnedStay,
  maskGuestName,
  miniGuard,
  ok,
  resolveMiniGuest,
  round2,
} from "../../../_shared";

export const dynamic = "force-dynamic";

/** 读接口限流：60 次/分钟 */
const READ_RATE_LIMIT_PER_MINUTE = 60;

/** 明细行上限：一张账单几百行顶天了，超出的截断并给出提示（防畸形数据打爆响应体） */
const MAX_ITEMS = 200;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = miniGuard(req, "mini:stay:folio", READ_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const stayId = Number.parseInt(String(id ?? ""), 10);
  if (!Number.isFinite(stayId) || stayId <= 0) {
    return fail("BAD_REQUEST", "入住单号格式不正确", 400);
  }

  const hotelId = guard.hotelId;
  const identity = resolveMiniGuest(hotelId, guard.guestId);
  if (!identity) {
    return fail("NOT_BOUND", "尚未绑定会员身份，无法查看账单。请在「我的 → 绑定身份」里完成绑定。");
  }

  const stay = loadOwnedStay(hotelId, identity, stayId);
  if (!stay || stay.status !== "INHOUSE") {
    /* 不存在 / 不是本人的 / 已退房 / 别家酒店：同一句话（不给 id 存在性预言机） */
    return fail("STAY_NOT_FOUND", "没有找到这笔在住单，请返回列表刷新后重试", 404);
  }

  const folio = loadStayFolio(hotelId, stay.id);
  if (!folio) {
    return fail("FOLIO_NOT_FOUND", "该入住单还没有账单，请到酒店前台咨询");
  }

  const balance = computeFolioBalance(hotelId, folio.id);
  const deposit = depositHeld(hotelId, folio.id);

  const rows = all<{
    id: number;
    item_type: string;
    description: string | null;
    qty: number | null;
    price: number | null;
    amount: number | null;
    biz_date: string | null;
    created_at: string | null;
  }>(
    `SELECT id, item_type, description, qty, price, amount, biz_date, created_at
       FROM folio_items
      WHERE hotel_id = ? AND folio_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [hotelId, folio.id, MAX_ITEMS]
  );

  return ok({
    stayId: stay.id,
    stayNo: stay.stayNo,
    roomNo: stay.roomNo,
    guestName: maskGuestName(stay.guestName || identity.name),
    checkInDate: stay.checkInDate,
    expectCheckOut: stay.expectCheckOut,
    nights: stay.nights,
    folioNo: folio.folioNo,
    folioStatus: folio.status,
    today: bizToday(hotelId),
    /* 三个金额都由服务端算好，小程序只显示 */
    total: round2(balance.total),
    paid: round2(balance.paid),
    balance: round2(balance.balance),
    /** 已收押金（负债，不计入应收；退房时按「应退」处理） */
    depositHeld: round2(deposit),
    settled: Math.abs(balance.balance) < 0.005,
    itemCount: rows.length,
    truncated: rows.length >= MAX_ITEMS,
    items: rows.map((r) => ({
      id: Number(r.id),
      itemType: (r.item_type ?? "").trim(),
      description: (r.description ?? "").trim(),
      qty: round2(Number(r.qty ?? 1)),
      price: round2(Number(r.price ?? 0)),
      amount: round2(Number(r.amount ?? 0)),
      bizDate: (r.biz_date ?? "").trim(),
      createdAt: r.created_at ?? "",
      /** 押金行：金额是负债、不计入应收，前端可以单独分区展示 */
      isDeposit: (r.item_type ?? "").trim() === "DEPOSIT",
    })),
  });
}
