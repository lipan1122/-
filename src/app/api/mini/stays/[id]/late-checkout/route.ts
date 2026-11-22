/**
 * 小程序：延迟退房申请
 *
 * POST /api/mini/stays/:id/late-checkout   { time: "14:00", reason?, requestId }
 *
 * ── 为什么是「申请」而不是直接改 expect_check_out ──
 * 延迟退房会直接影响两件事：房态（这间房今天还能不能卖）与房费（多数酒店
 * 14:00 后按半天、18:00 后按全天计费）。这两件都不能让客人自己改，
 * 所以小程序只落一条 PENDING 申请，由前台确认时间与加收口径。
 *
 * ── 入参校验（挡掉明显不可能的申请，减少无效沟通）──
 *   · 标准退房时间 12:00：早于等于它的申请没有意义 → 拒绝，直接按原时间退房即可；
 *   · 最晚 20:00：再晚就是续住一晚的事，让客人走续住流程（会影响当天房量售卖）；
 *   · 只接受 HH:MM：客户端传 "下午两点" 这种文本一律拒，不猜。
 *
 * ── 幂等 ──
 * 同一个 requestId 重复提交只建一条（submitStayApplication 负责），
 * 重放时回 duplicated: true 与已提交的时间。
 */

import { fail, str } from "../../../_shared";
import { submitStayApplication } from "../_stay-actions";

export const dynamic = "force-dynamic";

/** 标准退房时间（与入住单上的默认 12:00 一致） */
const STANDARD_CHECKOUT = "12:00";

/** 最晚可申请的延迟退房时间（再晚应走续住） */
const LATEST_CHECKOUT = "20:00";

/** HH:MM 格式校验（00:00 - 23:59） */
function isHourMinute(value: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return submitStayApplication({
    req,
    scope: "mini:stay:late-checkout",
    params: ctx.params,
    serviceType: "LATE_CHECKOUT",
    prepare: (_stay, body) => {
      const time = str(body.time);
      const reason = str(body.reason).slice(0, 120);

      if (!time) return { response: fail("BAD_REQUEST", "请选择希望的退房时间", 400) };
      if (!isHourMinute(time)) {
        return { response: fail("BAD_REQUEST", "退房时间格式应为 HH:MM，例如 14:00", 400) };
      }
      if (time <= STANDARD_CHECKOUT) {
        return {
          response: fail(
            "BAD_REQUEST",
            `标准退房时间是 ${STANDARD_CHECKOUT}，不需要申请延迟；如需提前退房请到前台办理`,
            400
          ),
        };
      }
      if (time > LATEST_CHECKOUT) {
        return {
          response: fail(
            "BAD_REQUEST",
            `最晚可申请到 ${LATEST_CHECKOUT}，再晚请在小程序「续住」或到前台加住一晚`,
            400
          ),
        };
      }

      return { note: `申请延迟退房至 ${time}${reason ? `；原因：${reason}` : ""}` };
    },
    /* 单独回一个字段：小程序列表要直接显示「申请到 14:00」而不必解析 note */
    extra: (body) => ({ requestedTime: str(body.time) }),
  });
}
