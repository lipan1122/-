"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { consumeWallet, getWalletBalance, rechargeWallet, refundWallet } from "@/lib/member-wallet";

/**
 * 会员储值页 actions
 *
 * 整改清单 P1-3：原来这里有自己的一套「余额表 + 流水表」逻辑，
 * 和 src/lib/member-wallet.ts 的单一流水表割裂。现在全部改调 service，
 * 余额只由流水推导，退款带上「累计退款 ≤ 累计充值 − 已消费」校验。
 *
 * 语义澄清（改动前旧实现是反的，容易埋账）：
 *   充值  → 客人给钱进卡，余额 +
 *   消费  → 用卡里的钱消费，余额 −
 *   退款  → 把卡里的钱退给客人，余额 −（旧实现是余额 +，等于又送了一次钱）
 */

type GuestRow = { id: number; name: string; mobile: string | null; vip_level: number };

const MAX_AMOUNT = 999999;

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function loadMember(hotelId: number, guestId: number): GuestRow | undefined {
  return get<GuestRow>(
    `SELECT id, name, mobile, vip_level FROM guests
      WHERE id = ? AND hotel_id = ? AND vip_level > 0`,
    [guestId, hotelId]
  );
}

function failUrl(guestId: number, message: string): string {
  return `/members/wallet?guest=${guestId}&err=${encodeURIComponent(message)}`;
}

function successUrl(guestId: number, message: string): string {
  return `/members/wallet?guest=${guestId}&ok=${encodeURIComponent(message)}`;
}

/** 读取金额：优先快捷按钮 preset，其次金额输入框 */
function parseAmount(formData: FormData): number {
  const raw = str(formData.get("preset")) || str(formData.get("amount"));
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round2(Math.min(n, MAX_AMOUNT));
}

/** 充值：客人给钱进卡，余额增加 */
export async function rechargeWalletAction(formData: FormData): Promise<void> {
  const user = await requirePermission("member.view_sensitive");
  const hotelId = user.hotelId;

  const guestId = Number(str(formData.get("guest_id")));
  const amount = parseAmount(formData);
  const method = str(formData.get("method")) || "现金";
  const noteText = str(formData.get("note"));

  if (!guestId) redirect(`/members/wallet?err=${encodeURIComponent("请先选择会员")}`);
  const guest = loadMember(hotelId, guestId);
  if (!guest) redirect(failUrl(guestId, "会员不存在或已取消会员"));
  if (!(amount > 0)) redirect(failUrl(guestId, "请填写正确的充值金额（大于 0）"));

  const r = rechargeWallet(hotelId, guest.id, amount, {
    operator: user.realName,
    remark: `充值方式：${method}${noteText ? `；${noteText}` : ""}`,
    requestId: str(formData.get("request_id")) || undefined,
  });
  if ("error" in r) redirect(failUrl(guestId, r.error));

  revalidatePath("/members/wallet");
  redirect(successUrl(guest.id, `已为 ${guest.name} 充值 ${fmtMoney(amount)}（${method}），余额 ${fmtMoney(r.balance)}`));
}

/** 消费：用卡里的钱，余额扣减；余额不足由 service 拒绝 */
export async function consumeWalletAction(formData: FormData): Promise<void> {
  const user = await requirePermission("member.view_sensitive");
  const hotelId = user.hotelId;

  const guestId = Number(str(formData.get("guest_id")));
  const amount = parseAmount(formData);
  const noteText = str(formData.get("note"));

  if (!guestId) redirect(`/members/wallet?err=${encodeURIComponent("请先选择会员")}`);
  const guest = loadMember(hotelId, guestId);
  if (!guest) redirect(failUrl(guestId, "会员不存在或已取消会员"));
  if (!(amount > 0)) redirect(failUrl(guestId, "请填写正确的消费金额（大于 0）"));

  const r = consumeWallet(hotelId, guest.id, amount, {
    operator: user.realName,
    remark: `储值消费${noteText ? `；${noteText}` : ""}`,
    requestId: str(formData.get("request_id")) || undefined,
  });
  if ("error" in r) redirect(failUrl(guestId, r.error));

  revalidatePath("/members/wallet");
  redirect(successUrl(guest.id, `已从 ${guest.name} 储值账户扣减 ${fmtMoney(amount)}，余额 ${fmtMoney(r.balance)}`));
}

/**
 * 退款：把卡里的钱退给客人，余额减少
 *
 * P1-3 校验：累计退款 ≤ 累计充值 − 累计消费（service 里做），
 * 防止「退着退着把没充过的钱也退了」。
 */
export async function refundWalletAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.refund");
  const hotelId = user.hotelId;

  const guestId = Number(str(formData.get("guest_id")));
  const amount = parseAmount(formData);
  const noteText = str(formData.get("note"));
  /*
   * 确认框里必填的「退款原因」必须落进流水备注
   *
   * ConfirmForm 会把必填原因注入 FormData.reason（该项目所有危险操作
   * —— 退款/取消入住/夜审/清空 —— 都读这个字段）。这个 action 原来只读
   * `note`（自由备注，可为空），导致前台在确认框里认真填的原因被直接丢掉，
   * 资金流水上没有留痕。回归测试抓到了这一点。
   *
   * 两者都写进备注：原因是必填的审计信息，备注是补充说明。
   */
  const reasonText = str(formData.get("reason"));

  if (!guestId) redirect(`/members/wallet?err=${encodeURIComponent("请先选择会员")}`);
  const guest = loadMember(hotelId, guestId);
  if (!guest) redirect(failUrl(guestId, "会员不存在或已取消会员"));
  if (!(amount > 0)) redirect(failUrl(guestId, "请填写正确的退款金额（大于 0）"));

  const remarkParts = [`储值退款`];
  if (reasonText) remarkParts.push(`原因：${reasonText}`);
  if (noteText) remarkParts.push(noteText);

  const r = refundWallet(hotelId, guest.id, amount, {
    operator: user.realName,
    remark: remarkParts.join("；"),
    requestId: str(formData.get("request_id")) || undefined,
  });
  if ("error" in r) redirect(failUrl(guestId, r.error));

  revalidatePath("/members/wallet");
  redirect(successUrl(guest.id, `已从 ${guest.name} 储值账户退款 ${fmtMoney(amount)}，余额 ${fmtMoney(r.balance)}`));
}

/**
 * 页面用的余额读取（改调 service，保证和流水一致）
 *
 * 权限边界（上线前加固）：这是导出的 Server Action，可被客户端直接调用，
 * 所以必须要求登录；hotelId 一律取 session，绝不信任调用方传入的酒店 id，
 * 否则任何登录账号都能读别家酒店的会员储值余额（跨租户越权）。
 */
export async function readWalletBalance(guestId: number): Promise<number> {
  const user = await requireUser();
  return getWalletBalance(user.hotelId, guestId);
}
