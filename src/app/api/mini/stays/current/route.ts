/**
 * 小程序：当前在住
 *
 * GET /api/mini/stays/current   （需要 Bearer token）
 *
 * ── 身份（整改清单第四节：不信任客户端 id）──
 * 请求里**没有任何参数**：住的是哪家店、哪位客人，全部由 token → mini_program_users
 * 这一列推导。未绑定客史的用户直接返回空列表（bound: false），
 * 不做「按手机号猜一下」的兜底 —— 那正是 P0-12 / P2-17 被点名的越权形态。
 *
 * ── 只回这一位客人自己的数据 ──
 *   · 房间号、入住日、预计离店日、房价：他本人住的那间，属于本人信息；
 *   · 账单余额：从 folios 实时算（computeFolioBalance，与收银台同一个口径），
 *     金额一律服务端算，客户端只显示；
 *   · **不返回**全店房量、出租率、其他客人的在住单、押金明细明细行。
 *
 * ── 为什么列表也带余额 ──
 * 小程序「在住」一进去就要同时回答两个问题：我住哪间、我到今天花了多少。
 * 分两次请求会让钱包/账单页闪一下旧值；这里在服务端一次算好（最多 20 条在住单，
 * 每人一次只有 1 条，实际开销是 1~2 条 SQL）。
 */

import { computeFolioBalance } from "@/lib/folio";
import { bizToday } from "@/lib/biz-date";
import {
  listOwnedInhouseStays,
  loadStayFolio,
  maskGuestName,
  maskMobile,
  miniGuard,
  ok,
  resolveMiniGuest,
  round2,
} from "../../_shared";

export const dynamic = "force-dynamic";

/** 读接口限流：60 次/分钟 */
const READ_RATE_LIMIT_PER_MINUTE = 60;

export async function GET(req: Request) {
  const guard = miniGuard(req, "mini:stay:current", READ_RATE_LIMIT_PER_MINUTE);
  if (!guard.ok) return guard.response;

  const hotelId = guard.hotelId;
  const identity = resolveMiniGuest(hotelId, guard.guestId);

  /* 未绑定（或绑定的客史已不存在）：回空列表，不报错 —— 小程序要能正常渲染空态 */
  if (!identity) {
    return ok({
      bound: false,
      today: bizToday(hotelId),
      guestName: "",
      mobile: "",
      total: 0,
      stays: [],
      hint: "尚未绑定会员身份，绑定后可查看当前在住、账单与在住服务",
    });
  }

  const stays = listOwnedInhouseStays(hotelId, identity);
  const list = stays.map((stay) => {
    /* 账单只按 stay_id 由服务端推导，客户端永远拿不到也传不进 folioId */
    const folio = loadStayFolio(hotelId, stay.id);
    const balance = folio ? computeFolioBalance(hotelId, folio.id) : null;
    return {
      stayId: stay.id,
      stayNo: stay.stayNo,
      roomNo: stay.roomNo,
      checkInDate: stay.checkInDate,
      expectCheckOut: stay.expectCheckOut,
      nights: stay.nights,
      rate: round2(stay.rate),
      breakfast: stay.breakfast,
      /* 姓名 / 手机号打码：小程序响应会经微信客户端、用户截图多次落地 */
      guestName: maskGuestName(stay.guestName || identity.name),
      mobile: maskMobile(stay.mobile || identity.mobile),
      hasFolio: Boolean(folio),
      folioNo: folio?.folioNo ?? "",
      /** 账单金额（服务端算；balance 为负表示应退客人） */
      folio: balance
        ? {
            total: round2(balance.total),
            paid: round2(balance.paid),
            balance: round2(balance.balance),
            settled: Math.abs(balance.balance) < 0.005,
          }
        : null,
      /** 能不能续住 / 换房 / 延迟退房（前端按钮开关；真正的校验在各 POST 接口里再做） */
      canExtend: Boolean(stay.expectCheckOut),
      canChangeRoom: Boolean(stay.roomId),
      canLateCheckout: Boolean(stay.expectCheckOut),
    };
  });

  return ok({
    bound: true,
    today: bizToday(hotelId),
    guestName: maskGuestName(identity.name),
    mobile: maskMobile(identity.mobile),
    total: list.length,
    stays: list,
    hint: list.length === 0 ? "当前没有在住的入住单。办理入住后可在这里查看房间与账单。" : "",
  });
}
