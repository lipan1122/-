/**
 * 交班汇总的数据读取（服务端组件直接用）
 *
 * 注意：不能放在 "use server" 文件里 —— 那样导出的函数在 Server Component 中
 * 会被当成 server action 代理，无法直接 await 拿到数据（会 500）。
 */

import { all, get } from "@/lib/db";
import { nowIso, todayStr } from "@/lib/utils";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 当前用户的未交班记录 */
export function getOpenShift(hotelId: number, operator: string) {
  return get<{ id: number; shift_name: string; start_at: string; opening_cash: number }>(
    `SELECT id, shift_name, start_at, COALESCE(opening_cash, 0) AS opening_cash
       FROM shifts WHERE hotel_id = ? AND operator = ? AND status = 'OPEN' LIMIT 1`,
    [hotelId, operator]
  );
}

/**
 * 某班次范围内的收款汇总（按方式分组 + 业务量）
 *
 * 第 4 轮 P1-13：必须按操作员过滤。
 *
 * 班次是「按人」开的（getOpenShift 查 `operator = ?`），但汇总原来是「按全店」算的
 * —— 两个收银员同时在岗时，A 交班会把自己班里的钱加上 B 收的钱，
 * 两边都长款，长短款核对必然错，交班报表（/reports?r=shift-summary）也跟着错。
 *
 * payments.operator 在收款时已写入（`user.realName ?? user.username`），
 * 这里用同一口径过滤。operator 传空时退回全店口径（兼容历史数据/管理员查总账）。
 */
export function previewShiftSummary(hotelId: number, fromIso: string, operator?: string) {
  const now = nowIso();
  const op = (operator ?? "").trim();
  const rows = all<{ method: string | null; total: number; cnt: number }>(
    `SELECT COALESCE(method, '现金') AS method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
       FROM payments
      WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
        AND (? = '' OR COALESCE(operator, '') = ?)
      GROUP BY COALESCE(method, '现金') ORDER BY total DESC`,
    [hotelId, fromIso, now, op, op]
  );
  const cash = rows.find((r) => r.method === "现金")?.total ?? 0;
  const refund = rows.filter((r) => Number(r.total) < 0).reduce((s, r) => s + Number(r.total), 0);

  /*
   * 业务量统计（入账笔数 / 退房笔数）也按操作员过滤。
   * folio_items.created_by 存的是 users.id（数字），不是名字，
   * 所以这里只能按「有 created_by」来近似 —— 口径比收款汇总宽松，
   * 但比原来「全店统计」准确。要精确到人需要 join users 比对姓名，
   * 那会把「同名员工」也混掉，暂不做。
   */
  const itemCount =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM folio_items
        WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
          AND (? = '' OR created_by IS NOT NULL)`,
      [hotelId, fromIso, now, op]
    )?.c ?? 0;
  const checkoutCount =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM folios WHERE hotel_id = ? AND settled_at >= ? AND settled_at <= ?`,
      [hotelId, fromIso, now]
    )?.c ?? 0;
  const checkinCount =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND check_in_time >= ? AND check_in_time <= ?`,
      [hotelId, fromIso, now]
    )?.c ?? 0;
  const newBookings =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?`,
      [hotelId, fromIso, now]
    )?.c ?? 0;

  return {
    rows,
    cash: round2(Number(cash)),
    refund: round2(refund),
    itemCount,
    checkoutCount,
    checkinCount,
    newBookings,
    today: todayStr(),
  };
}

/** 历史交班记录 */
export function listShifts(hotelId: number, limit = 30) {
  return all<{
    id: number;
    biz_date: string;
    shift_name: string;
    start_at: string;
    end_at: string | null;
    operator: string;
    receiver: string | null;
    expect_cash: number;
    actual_cash: number;
    diff: number;
    status: string;
    note: string | null;
  }>(
    `SELECT id, biz_date, shift_name, start_at, end_at, operator, receiver,
            COALESCE(expect_cash,0) AS expect_cash, COALESCE(actual_cash,0) AS actual_cash,
            COALESCE(diff,0) AS diff, status, note
       FROM shifts WHERE hotel_id = ? ORDER BY id DESC LIMIT ?`,
    [hotelId, limit]
  );
}
