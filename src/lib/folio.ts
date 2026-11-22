/**
 * 账务重算（整改清单 P0-4：账务重算四处分叉）
 *
 * 背景：收银台、客房、在住、夜审各自有一份 recalcFolio，规则不一致——
 *   - cashier：排除「部分结账」ADJUST 负项（正确）
 *   - rooms：SQL 带 `(? IS NULL OR hotel_id = ?)` 但只传了 1 个参数（参数错位）
 *   - inhouse：完全不排除部分结账负项 → 部分结账后 total 被负项抵掉，余额算错
 *
 * 现实后果：同一张账单在不同入口重算，得到不同余额，对账必然出差异。
 *
 * 现在统一到这里：所有入口只调 recalcFolioBalance，规则只写一份。
 */

import { all, get, run } from "@/lib/db";

/** 部分结账写入的调整项前缀（historical，改动会影响已落库数据，保持原值） */
export const PARTIAL_SETTLE_PREFIX = "【部分结账】";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type FolioBalance = { total: number; paid: number; balance: number };

/**
 * 有效应收明细：从 SUM(amount) 里排除的明细类型
 *
 * ── 为什么要排除 DEPOSIT（上线前修的重大口径问题）──
 *
 * 押金是**负债**，不是收入。客人交 600 押金、消费 1764，账单应收应是 1764，
 * 已收 2364，余额 -600（应退客人 600）。
 *
 * 旧实现把 DEPOSIT 计入 total：total = 600 + 1764 = 2364，已收 2364，余额 0
 * → 系统判定「已结清」，**客人那 600 押金永远退不回去**，
 *   酒店营收被虚增 600，押金负债也无法核销。
 *
 * 全库 20 张含押金账单全部是 balance=0/SETTLED，没有一张体现应退押金。
 *
 * ── 附带排除 ──
 * ADJUST + 「【部分结账】」前缀：那是内部已结记录，不是客人消费。
 */
export const NON_REVENUE_ITEM = `(item_type = 'DEPOSIT' OR (item_type = 'ADJUST' AND description LIKE '${PARTIAL_SETTLE_PREFIX}%'))`;

/**
 * 重算并回写账单：total_amount = SUM(有效消费明细)，balance = total - paid
 *
 * 规则（唯一口径）：
 *   1. 押金 DEPOSIT **不计入** total —— 它是负债，通过 paid 体现「已收押金」，
 *      多收的部分会体现成负余额，退房时按「应退」处理。
 *   2. 「部分结账」写入的 ADJUST 负项不计入 —— 内部已结记录，不是消费。
 *   3. hotelId 必传：所有账务写操作都必须带酒店校验，防跨租户。
 *
 * @returns 重算后的三个金额（已 round2）。balance 为负表示应退客人。
 */
export function recalcFolioBalance(hotelId: number, folioId: number): FolioBalance {
  const total = round2(
    get<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS t
         FROM folio_items
        WHERE folio_id = ? AND hotel_id = ?
          AND NOT ${NON_REVENUE_ITEM}`,
      [folioId, hotelId]
    )?.t ?? 0
  );

  run(
    `UPDATE folios
        SET total_amount = ?, balance = ? - COALESCE(paid_amount, 0)
      WHERE id = ? AND hotel_id = ?`,
    [total, total, folioId, hotelId]
  );

  const row = get<{ total_amount: number | null; paid_amount: number | null; balance: number | null }>(
    `SELECT total_amount, paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, hotelId]
  );

  return {
    total: round2(Number(row?.total_amount ?? total)),
    paid: round2(Number(row?.paid_amount ?? 0)),
    balance: round2(Number(row?.balance ?? total)),
  };
}

/**
 * 只读版：算出「按统一口径应该是多少」但不写库。
 * 用于体检脚本、对账校验、预检提示。
 */
export function computeFolioBalance(hotelId: number, folioId: number): FolioBalance {
  const total = round2(
    get<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS t
         FROM folio_items
        WHERE folio_id = ? AND hotel_id = ?
          AND NOT ${NON_REVENUE_ITEM}`,
      [folioId, hotelId]
    )?.t ?? 0
  );
  const paid = round2(
    Number(
      get<{ paid_amount: number | null }>(
        `SELECT paid_amount FROM folios WHERE id = ? AND hotel_id = ?`,
        [folioId, hotelId]
      )?.paid_amount ?? 0
    )
  );
  return { total, paid, balance: round2(total - paid) };
}

/**
 * 押金余额（只算押金类明细，正数为已收押金总额）
 * 退房时用它判断「该退客人多少钱押金」。
 */
export function depositHeld(hotelId: number, folioId: number): number {
  return round2(
    get<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS t
         FROM folio_items
        WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
      [folioId, hotelId]
    )?.t ?? 0
  );
}

/* ------------------------------------------------------------------ *
 * 收款性质 kind（第九轮 P1-2：押金不能再靠备注识别）
 *
 * ── 缺陷 ──
 * payments 表原来只有 remark：押金靠「备注里含『押金』/『预收』」识别。
 * 于是：
 *   · 前台把押金备注写成「订金」→ 退房找不到原押金，refund_of 为空、押金退不回去；
 *   · 手动退款（refundPaymentAction）与退房退款（checkoutAction）各写一套判断，
 *     口径不一致时一笔押金可能被退两次；
 *   · 押金退款报表按备注 LIKE 匹配，漏记一切没写对备注的押金。
 *
 * ── 本段提供的东西（全项目押金判定的**唯一口径**）──
 *   PaymentKind        五种结构化性质（落库在 payments.kind）
 *   ensurePaymentKindSchema  运行时兜底补列 + 索引（老库第一次写之前调用，幂等）
 *   isDepositPayment   kind 优先，kind 为空时按旧备注兜底（为了升级前的历史数据）
 *   refundKindOf       退款流水的性质：原收款是押金 → DEPOSIT_REFUND，否则 ROOM_REFUND
 *   findDepositPayment 找「退房/退款要指向的原押金收款」：kind 优先、备注兜底
 *   listDepositPayments / depositKindSummary  押金报表按 kind 的口径（收取 / 退还 / 在压）
 *
 * ── 为什么保留备注兜底 ──
 * 升级前落库的旧行没有 kind（迁移无法判断的一律留 NULL = 待核对，见
 * scripts/migrate-all.mjs 的回填段）。对这些行继续用业务锚点识别，
 * 才不至于「上线后旧押金一夜之间都退不出去」；新写入的行一律带 kind，
 * 备注写成什么都无所谓。
 * ------------------------------------------------------------------ */

/** 收款性质：房费收款 / 押金收取 / 押金退款 / 房费退款 / 其他收款 */
export type PaymentKind = "ROOM_PAYMENT" | "DEPOSIT" | "DEPOSIT_REFUND" | "ROOM_REFUND" | "OTHER_PAYMENT";

/** 全部合法取值（迁移脚本、测试脚本与页面共用这一份） */
export const PAYMENT_KINDS: readonly PaymentKind[] = [
  "ROOM_PAYMENT",
  "DEPOSIT",
  "DEPOSIT_REFUND",
  "ROOM_REFUND",
  "OTHER_PAYMENT",
];

/** 中文标签（操作日志 / 报表展示） */
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  ROOM_PAYMENT: "房费收款",
  DEPOSIT: "押金收取",
  DEPOSIT_REFUND: "押金退款",
  ROOM_REFUND: "房费退款",
  OTHER_PAYMENT: "其他收款",
};

/**
 * 旧数据识别锚点：只有 kind 为空（升级前的历史行）时才看备注。
 * 「订金」故意**不在**这里 —— 旧口径识别不出来的正是这种自定义备注，
 * 新写入的行靠 kind，不再靠这串正则。
 */
export const LEGACY_DEPOSIT_REMARK = /押金|预收/;

/** 运行时兜底：payments.kind 列 + 索引（幂等，进程内只查一次 PRAGMA） */
let paymentKindSchemaReady = false;
export function ensurePaymentKindSchema(): void {
  if (paymentKindSchemaReady) return;
  const exists =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'payments'`)?.n ?? 0;
  if (!exists) {
    /* 全新库还没建表：scripts/schema-full.sql 建表时就带 kind，这里不越权建表 */
    return;
  }
  const cols = all<{ name: string }>(`PRAGMA table_info(payments)`).map((c) => String(c.name));
  if (!cols.includes("kind")) {
    run(`ALTER TABLE payments ADD COLUMN kind TEXT`);
  }
  run(`CREATE INDEX IF NOT EXISTS idx_payments_kind ON payments(hotel_id, kind, biz_date)`);
  paymentKindSchemaReady = true;
}

/** 任意输入 → 合法 paymentKind（非法 / 空 → null，不猜） */
export function toPaymentKind(value: unknown): PaymentKind | null {
  const raw = String(value ?? "").trim().toUpperCase();
  return (PAYMENT_KINDS as readonly string[]).includes(raw) ? (raw as PaymentKind) : null;
}

/**
 * 这笔收款是不是押金收款
 *
 * 判定顺序（唯一口径）：
 *   ① kind 有值 → 只有 DEPOSIT 算押金（写成「订金」也照样算，因为不看备注）；
 *   ② kind 为空（升级前旧数据）→ 备注含「押金」/「预收」才算。
 */
export function isDepositPayment(payment: { kind?: unknown; remark?: unknown } | null | undefined): boolean {
  if (!payment) return false;
  const kind = toPaymentKind(payment.kind);
  if (kind) return kind === "DEPOSIT";
  return LEGACY_DEPOSIT_REMARK.test(String(payment.remark ?? ""));
}

/**
 * 退款流水的性质：原收款是押金 → DEPOSIT_REFUND，其余 → ROOM_REFUND
 *
 * 手动退款和退房退款都调它，保证两条退款路径写进库里的 kind 完全一致
 * （旧实现两处各写一套 remark 判断，口径分叉，出现「手动退过一次、退房又退一次」）。
 */
export function refundKindOf(parent: { kind?: unknown; remark?: unknown } | null | undefined): PaymentKind {
  return isDepositPayment(parent) ? "DEPOSIT_REFUND" : "ROOM_REFUND";
}

/** 押金原收款（refund_of 要指向它）：kind = DEPOSIT 优先，旧数据按备注兜底 */
export function findDepositPayment(
  hotelId: number,
  folioId: number
): { id: number; method: string; amount: number } | undefined {
  ensurePaymentKindSchema();
  const rows = all<{ id: number; method: string | null; amount: number; kind: string | null; remark: string | null }>(
    `SELECT id, method, amount, kind, remark
       FROM payments
      WHERE hotel_id = ? AND folio_id = ? AND amount > 0
        AND (kind = 'DEPOSIT' OR kind IS NULL)
      ORDER BY id ASC`,
    [hotelId, folioId]
  );
  const hit = rows.find((r) => isDepositPayment(r));
  return hit ? { id: Number(hit.id), method: String(hit.method ?? "现金"), amount: Number(hit.amount ?? 0) } : undefined;
}

/** 押金报表一行：按 kind 归类的收取 / 退还 */
export type DepositKindRow = {
  id: number;
  biz_date: string;
  amount: number;
  kind: PaymentKind | "UNVERIFIED";
  method: string | null;
  remark: string | null;
  refund_of: number | null;
};

/**
 * 押金收取 / 退还明细（押金报表的数据源，**按 kind 查询**，备注只对旧数据兜底）
 *
 * @param direction "in" 收取（正数流水） / "refund" 退还（负数流水）/ "all"
 */
export function listDepositPayments(
  hotelId: number,
  from: string,
  to: string,
  direction: "in" | "refund" | "all" = "all"
): DepositKindRow[] {
  ensurePaymentKindSchema();
  const rows = all<{
    id: number;
    biz_date: string;
    amount: number;
    kind: string | null;
    method: string | null;
    remark: string | null;
    refund_of: number | null;
    origin_kind: string | null;
    origin_remark: string | null;
  }>(
    `SELECT p.id, COALESCE(p.biz_date, '') AS biz_date, COALESCE(p.amount, 0) AS amount,
            p.kind, p.method, p.remark, p.refund_of,
            op.kind AS origin_kind, op.remark AS origin_remark
       FROM payments p
       LEFT JOIN payments op ON op.id = p.refund_of AND op.hotel_id = p.hotel_id
      WHERE p.hotel_id = ? AND COALESCE(p.biz_date, '') BETWEEN ? AND ?
      ORDER BY p.biz_date ASC, p.id ASC`,
    [hotelId, from, to]
  );

  const out: DepositKindRow[] = [];
  for (const r of rows) {
    const amount = round2(Number(r.amount ?? 0));
    const refund = amount < 0;
    const kind = toPaymentKind(r.kind);
    let hit = false;
    let label: PaymentKind | "UNVERIFIED" = "UNVERIFIED";
    if (refund) {
      if (kind === "DEPOSIT_REFUND") hit = true;
      else if (!kind && r.refund_of && isDepositPayment({ kind: r.origin_kind, remark: r.origin_remark })) hit = true;
      label = kind ?? (hit ? "DEPOSIT_REFUND" : "UNVERIFIED");
    } else {
      hit = isDepositPayment({ kind: r.kind, remark: r.remark });
      label = kind ?? (hit ? "DEPOSIT" : "UNVERIFIED");
    }
    if (!hit) continue;
    if (direction === "in" && refund) continue;
    if (direction === "refund" && !refund) continue;
    out.push({
      id: Number(r.id),
      biz_date: String(r.biz_date ?? ""),
      amount,
      kind: label,
      method: r.method,
      remark: r.remark,
      refund_of: r.refund_of == null ? null : Number(r.refund_of),
    });
  }
  return out;
}

/**
 * 押金报表汇总（按 kind）：区间内收取 / 退还 + 当前在压押金
 *
 * 在压押金取 folio_items 的 DEPOSIT 明细余额（与 recalcFolioBalance 同一口径：
 * 押金不计入应收，收退都通过明细冲减体现），不按备注倒推。
 */
export function depositKindSummary(
  hotelId: number,
  from: string,
  to: string
): { collected: number; refunded: number; held: number; collectedRows: DepositKindRow[]; refundRows: DepositKindRow[] } {
  const collectedRows = listDepositPayments(hotelId, from, to, "in");
  const refundRows = listDepositPayments(hotelId, from, to, "refund");
  const collected = round2(collectedRows.reduce((s, r) => s + Math.abs(r.amount), 0));
  const refunded = round2(refundRows.reduce((s, r) => s + Math.abs(r.amount), 0));
  const held =
    get<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS t
         FROM folio_items
        WHERE hotel_id = ? AND item_type = 'DEPOSIT'`,
      [hotelId]
    )?.t ?? 0;
  return { collected, refunded, held: round2(Number(held)), collectedRows, refundRows };
}
