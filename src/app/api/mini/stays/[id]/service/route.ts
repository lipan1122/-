/**
 * 小程序：在住服务请求（客房清洁 / 送物 / 维修 / 其他）
 *
 * POST /api/mini/stays/:id/service   { serviceType, note?, requestId }
 *
 * ── 类型只接受白名单 ──
 * CLEANING / DELIVERY / REPAIR / OTHER（见 _shared.ts 的 MINI_SERVICE_TYPES）。
 * 客户端传 `'x'; DROP TABLE ...` 这类内容一律按「类型无效」拒绝 —— 类型既是 SQL 参数、
 * 又会进前台列表的筛选条件，必须是枚举值。
 *
 * 延迟退房 / 换房 / 叫醒 / 续住各有专门接口，不接受从这里提交，
 * 免得「换房」被当成一条普通保洁请求漏掉。
 *
 * ── note ──
 * 客人自由文本，trim 后截断 300 字，只在本人与前台之间流转，不进任何对外响应。
 * OTHER（其他需求）必须填内容：只有类型没有内容，前台无法处理。
 */

import { fail, str, toMiniServiceType, type MiniServiceType } from "../../../_shared";
import { submitStayApplication } from "../_stay-actions";

export const dynamic = "force-dynamic";

/** 允许从这里提交的类型（与「在住服务」页面的入口一一对应） */
const ALLOWED_TYPES: MiniServiceType[] = ["CLEANING", "DELIVERY", "REPAIR", "OTHER"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return submitStayApplication({
    req,
    scope: "mini:stay:service",
    params: ctx.params,
    /* 类型由请求体决定：先把「类型白名单」过了，再进通用流程（幂等比对也要用同一个值） */
    resolveServiceType: (body) => {
      const raw = str(body.serviceType) || str(body.service_type);
      const type = toMiniServiceType(raw);
      if (!type || !ALLOWED_TYPES.includes(type)) {
        return {
          response: fail(
            "BAD_REQUEST",
            "服务类型无效，可选：CLEANING（清洁）/ DELIVERY（送物）/ REPAIR（维修）/ OTHER（其他）",
            400
          ),
        };
      }
      /* OTHER 必须有具体内容，否则前台拿到一条「客人有需求」什么也做不了 */
      const note = str(body.note);
      if (type === "OTHER" && note.length < 2) {
        return { response: fail("BAD_REQUEST", "请填写具体的服务需求（至少 2 个字）", 400) };
      }
      return { type };
    },
    prepare: (_stay, body) => {
      const type = toMiniServiceType(str(body.serviceType) || str(body.service_type)) ?? "OTHER";
      const note = str(body.note).slice(0, 300);
      return { note: note || defaultNote(type) };
    },
  });
}

/** 没填备注时给一句默认说明，前台一眼知道客人要什么 */
function defaultNote(type: MiniServiceType): string {
  switch (type) {
    case "CLEANING":
      return "客人申请客房清洁";
    case "DELIVERY":
      return "客人申请送物服务（未填写具体物品，请电话确认）";
    case "REPAIR":
      return "客人申请设施维修（未填写具体问题，请电话确认）";
    default:
      return "客人提出服务需求";
  }
}
