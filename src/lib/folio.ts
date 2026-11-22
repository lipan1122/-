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

import { get, run } from "@/lib/db";

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
