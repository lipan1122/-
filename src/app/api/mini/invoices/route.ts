/**
 * 小程序：发票（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * GET  /api/mini/invoices   我的发票列表（需要 Bearer token）
 * POST /api/mini/invoices   申请开票   （需要 Bearer token）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、归属判定：只按 guest_id，绝不按姓名 / 手机号
 * ══════════════════════════════════════════════════════════════════════════
 * invoices 表本身只有 guest_name / room_no / folio_id / stay_id，**没有 guest_id**。
 * 直接拿 invoices.guest_name 和客人姓名比较就是整改 P0-12 里被否决过的写法
 * （guests.name 无唯一约束，重名必串号）。所以：
 *   发票 → 账单 folios.stay_id → stays.guest_id → token 推导出的 guestId
 *   发票 → invoices.stay_id    → stays.guest_id（少数不关联账单、只关联入住单的票）
 * 两条路都要求 stays.guest_id 等于**当前登录客史**，并且 stays.hotel_id 与发票同店。
 * 请求体里的 hotelId / guestId / mobile / guestName **一律不参与授权判断**，
 * 只用于「抬头」这类本来就要由客人自己填的业务字段。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、开票口径：只能给自己「已结清」的账单开，金额上限服务端算
 * ══════════════════════════════════════════════════════════════════════════
 * 真正的台账写入交给 src/lib/invoice.ts 的 issueInvoice（PC 端收银台同一个函数）：
 *   · 账单必须 SETTLED（客人已付）或 CHARGED（已挂公司账），OPEN / VOID 一律拒绝；
 *   · 开票金额不得超过「账单总额 − 已开票净额」，红冲会把这个额度还回来；
 *   · 抬头 / 税号 / 营业日 / 发票号查重都在那里校验，两张入口不会各算一套。
 *
 * 本路由额外做两件 issueInvoice 管不到的事：
 *   ① 归属：账单必须是**这个客人自己的**（见第一节）；
 *   ② 金额：客户端只能「少开」（部分开票），不能「多开」——
 *      不传 amount 时取服务端算出的可开余额；传了就必须 ≤ 可开余额，
 *      否则直接 400。金额绝不采信客户端。
 *
 * 清单第四节「不返回其他客人的订单」在发票侧同样成立：GET 的 SQL 里
 * 根本不存在「不加 guest_id 条件」的分支。
 */

import { all, get, run } from "@/lib/db";
import { getFolioInvoiced, issueInvoice } from "@/lib/invoice";
import { requireMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { nowIso } from "@/lib/utils";
import { fail, maskGuestName, ok, readJsonBody, round2, str } from "../_shared";
import { MINI_NOTIFY_TYPE, safeNotify } from "../notifications/_notify";

export const dynamic = "force-dynamic";

/** 读接口 / 开票各自限流：开票是写操作，阈值更低 */
const INVOICE_READ_PER_MINUTE = 60;
const INVOICE_WRITE_PER_MINUTE = 10;

/** 单页最多返回多少张票 */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** 抬头 / 税号长度上限（与 issueInvoice 内部校验对齐，提前给出更聚焦的文案） */
const TITLE_MAX = 200;
const TAX_NO_MAX = 64;

/** 发票状态 / 类型中文名（数据库存 code，响应里同时给中文） */
const STATUS_LABEL: Record<string, string> = {
  ISSUED: "已开票",
  RED: "已红冲",
  VOID: "已作废",
};
const TYPE_LABEL: Record<string, string> = {
  NORMAL: "正常发票",
  RED: "红冲发票",
  VOID: "作废发票",
};

/** 发票行（GET 返回） */
type InvoiceRow = {
  id: number;
  invoice_no: string;
  invoice_type: string | null;
  title: string;
  amount: number | null;
  biz_date: string;
  status: string | null;
  folio_id: number | null;
  folio_no: string | null;
  room_no: string | null;
  guest_name: string | null;
  remark: string | null;
  created_at: string | null;
};

/**
 * 归属条件（两处共用）：
 *   A. 关联账单 → 账单的入住单 → 客史是本人
 *   B. 直接关联入住单 → 客史是本人
 * 都带 stays.hotel_id = 发票同店，跨租户不可能命中。
 */
const OWNER_WHERE = `(
  EXISTS (SELECT 1 FROM folios f
            JOIN stays s ON s.id = f.stay_id
           WHERE f.id = i.folio_id AND f.hotel_id = i.hotel_id
             AND s.hotel_id = i.hotel_id AND s.guest_id = ?)
  OR EXISTS (SELECT 1 FROM stays s2
              WHERE s2.id = i.stay_id AND s2.hotel_id = i.hotel_id AND s2.guest_id = ?)
)`;

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

/* `run` 只在上面的 writeOpLog 用到；单独 import 以免 all/get 命名冲突时不易发现 */

/** 账单归属信息（开票前校验） */
type FolioOwnerRow = {
  id: number;
  folio_no: string;
  status: string | null;
  total_amount: number | null;
  stay_id: number | null;
  guest_name: string | null;
  room_no: string | null;
  stay_no: string | null;
  guest_id: number | null;
};

/** 账单状态中文（错误文案用，与 invoice.ts 一致） */
const FOLIO_STATUS_LABEL: Record<string, string> = {
  OPEN: "未结账",
  SETTLED: "已结账",
  CHARGED: "已挂公司账",
  VOID: "已作废",
};

export async function GET(req: Request) {
  const limited = rateLimit(req, { scope: "mini:invoices:read", limit: INVOICE_READ_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "查询过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);
  if (!user.guestId) return fail("NOT_BOUND", "尚未绑定手机号，请先绑定后再查看发票");

  const hotelId = user.hotelId;
  const guestId = user.guestId;

  const url = new URL(req.url);
  const limitRaw = Number.parseInt((url.searchParams.get("limit") ?? "").trim(), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

  /* ---------- 列表：只按 guest_id 归属取数 ---------- */
  const rows = all<InvoiceRow>(
    `SELECT i.id, i.invoice_no, i.invoice_type, i.title, i.amount, i.biz_date, i.status,
            i.folio_id, i.folio_no, i.room_no, i.guest_name, i.remark, i.created_at
       FROM invoices i
      WHERE i.hotel_id = ?
        AND i.status <> 'VOID'
        AND ${OWNER_WHERE}
      ORDER BY i.biz_date DESC, i.id DESC
      LIMIT ?`,
    [hotelId, guestId, guestId, limit]
  );

  /* 汇总同样只统计自己的票（红冲票金额为负，净额自动回落） */
  const summary = get<{ total: number | null; count: number | null; red_total: number | null }>(
    `SELECT COALESCE(SUM(i.amount), 0) AS total,
            COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN i.invoice_type = 'RED' THEN -i.amount ELSE 0 END), 0) AS red_total
       FROM invoices i
      WHERE i.hotel_id = ?
        AND i.status <> 'VOID'
        AND ${OWNER_WHERE}`,
    [hotelId, guestId, guestId]
  );

  return ok({
    total: Number(summary?.count ?? 0),
    /** 净开票额（红冲自动抵扣） */
    totalAmount: round2(Number(summary?.total ?? 0)),
    redAmount: round2(Number(summary?.red_total ?? 0)),
    currency: "CNY",
    items: rows.map((row) => ({
      id: row.id,
      invoiceNo: row.invoice_no,
      invoiceType: row.invoice_type ?? "NORMAL",
      invoiceTypeLabel: TYPE_LABEL[row.invoice_type ?? "NORMAL"] ?? "发票",
      title: row.title,
      /** 姓名脱敏：即使是自己的票，响应体也不下发全名（截图 / 日志落地问题同 P0-11） */
      guestName: maskGuestName(row.guest_name ?? ""),
      amount: round2(Number(row.amount ?? 0)),
      bizDate: row.biz_date,
      status: row.status ?? "ISSUED",
      statusLabel: STATUS_LABEL[row.status ?? "ISSUED"] ?? "未知状态",
      folioNo: row.folio_no,
      roomNo: row.room_no,
      remark: row.remark,
      createdAt: row.created_at,
    })),
  });
}

export async function POST(req: Request) {
  const limited = rateLimit(req, { scope: "mini:invoices:write", limit: INVOICE_WRITE_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);
  if (!user.guestId) return fail("NOT_BOUND", "尚未绑定手机号，请先绑定后再申请开票");

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  const hotelId = user.hotelId;
  const guestId = user.guestId;

  /* ---------- 1. 抬头 / 税号 / 备注（这些是客人本来就该填的业务字段） ---------- */
  const title = str(body.title);
  if (!title) return fail("BAD_REQUEST", "请填写发票抬头", 400);
  if (title.length > TITLE_MAX) return fail("BAD_REQUEST", `发票抬头最多 ${TITLE_MAX} 个字`, 400);

  const taxNo = str(body.taxNo).slice(0, TAX_NO_MAX);
  const remark = str(body.remark).slice(0, 200);

  /* ---------- 2. 账单：必须存在、属于本店、属于当前客人 ---------- */
  const folioId = Math.trunc(Number(body.folioId));
  const stayIdHint = Math.trunc(Number(body.stayId));

  let folio: FolioOwnerRow | undefined;
  if (Number.isFinite(folioId) && folioId > 0) {
    folio = get<FolioOwnerRow>(
      `SELECT f.id, f.folio_no, f.status, f.total_amount, f.stay_id, f.guest_name, f.room_no,
              s.stay_no, s.guest_id
         FROM folios f
         LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
        WHERE f.id = ? AND f.hotel_id = ?`,
      [folioId, hotelId]
    );
  } else if (Number.isFinite(stayIdHint) && stayIdHint > 0) {
    /* 客人手上可能只有入住单号（房卡/账单），允许用 stayId 反查账单；
       同样必须命中自己的入住单，且取最新一张账单 */
    folio = get<FolioOwnerRow>(
      `SELECT f.id, f.folio_no, f.status, f.total_amount, f.stay_id, f.guest_name, f.room_no,
              s.stay_no, s.guest_id
         FROM folios f
         JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
        WHERE f.stay_id = ? AND f.hotel_id = ? AND s.guest_id = ?
        ORDER BY f.id DESC LIMIT 1`,
      [stayIdHint, hotelId, guestId]
    );
  } else {
    return fail("BAD_REQUEST", "请选择要开票的账单", 400);
  }

  /*
   * 「不存在」「不属于你」「别家酒店的」统一同一句文案：
   * 分开提示等于给枚举者一个「这个账单号存在」的预言机（与 bind 路由同一原则）。
   */
  if (!folio || folio.guest_id === null || Number(folio.guest_id) !== guestId) {
    return fail("NOT_FOUND", "账单不存在或不属于当前账号，请刷新后重试");
  }

  /* ---------- 3. 状态与金额上限：账单须已结清，额度服务端算 ---------- */
  const folioStatus = (folio.status ?? "OPEN").trim();
  if (folioStatus === "OPEN") {
    return fail(
      "FOLIO_OPEN",
      `账单 ${folio.folio_no} 当前为「未结账」，请先到前台结账后再申请开票`
    );
  }
  if (folioStatus !== "SETTLED" && folioStatus !== "CHARGED") {
    const label = FOLIO_STATUS_LABEL[folioStatus] ?? folioStatus;
    return fail("FOLIO_CLOSED", `账单 ${folio.folio_no} 当前为「${label}」，不能开票`);
  }

  const folioTotal = round2(Number(folio.total_amount ?? 0));
  const invoiced = round2(getFolioInvoiced(hotelId, folio.id));
  const remaining = round2(folioTotal - invoiced);
  if (remaining <= 0) {
    return fail("INVOICE_FULLY_ISSUED", `账单 ${folio.folio_no} 已开满发票，无需再次申请`);
  }

  /*
   * 金额：不传 = 开满可开余额；传了只允许「少开」。
   * 无论哪种，上限都是服务端算出来的 remaining，客户端无法多开。
   */
  const hasAmount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== "";
  let amount = remaining;
  if (hasAmount) {
    const raw = Number(body.amount);
    if (!Number.isFinite(raw) || raw <= 0) {
      return fail("BAD_REQUEST", "开票金额必须大于 0", 400);
    }
    amount = round2(raw);
    if (amount > remaining + 0.001) {
      return fail(
        "BAD_REQUEST",
        `开票金额 ${amount} 元超过账单可开余额 ${remaining} 元（账单总额 ${folioTotal} 元，已开票 ${invoiced} 元）`,
        400
      );
    }
  }

  /* ---------- 4. 写台账：交给 issueInvoice，与 PC 端同一份校验 ---------- */
  const result = issueInvoice({
    hotelId,
    title,
    taxNo: taxNo || undefined,
    amount,
    folioId: folio.id,
    stayId: folio.stay_id ?? undefined,
    /* 姓名 / 房号跟账单走，不让客户端指定，避免张冠李戴 */
    guestName: folio.guest_name ?? undefined,
    roomNo: folio.room_no ?? undefined,
    operator: `小程序会员#${user.id}`,
    remark: remark || undefined,
  });

  if ("error" in result) {
    /* issueInvoice 的文案已经是给前台看的中文；再用业务码包一层，前端可按码走不同引导 */
    return fail("INVOICE_FAILED", result.error);
  }

  /* ---------- 5. 审计 + 站内通知（只发给当前 mini_user_id） ---------- */
  writeOpLog(
    hotelId,
    `小程序会员#${user.id}`,
    "开发票",
    `小程序开票 · 发票号 ${result.invoiceNo} · 入住单 ${folio.stay_no ?? "-"} · 账单 ${folio.folio_no} · 房间 ${
      folio.room_no ?? "-"
    } · 抬头 ${title} · 税号 ${taxNo || "—"} · 金额 ${amount}`
  );

  safeNotify({
    hotelId,
    miniUserId: user.id,
    type: MINI_NOTIFY_TYPE.INVOICE_ISSUED,
    title: "发票已开具",
    body: `发票 ${result.invoiceNo} 已开具，金额 ${amount} 元，抬头「${title}」，可在「我的-发票」中查看。`,
    refType: "invoice",
    refId: result.id,
  });

  /* 营业日以台账里实际落库的为准（issueInvoice 按酒店营业日切点算，本路由不重复计算） */
  const saved = get<{ biz_date: string | null }>(
    `SELECT biz_date FROM invoices WHERE id = ? AND hotel_id = ?`,
    [result.id, hotelId]
  );

  return ok({
    id: result.id,
    invoiceNo: result.invoiceNo,
    title,
    taxNo: taxNo || null,
    amount,
    currency: "CNY",
    bizDate: saved?.biz_date ?? null,
    folioNo: folio.folio_no,
    stayNo: folio.stay_no,
    status: "ISSUED",
    statusLabel: "已开票",
    /** 开票后这张账单还剩多少额度（0 = 已开满） */
    remainingAfter: round2(remaining - amount),
  });
}
