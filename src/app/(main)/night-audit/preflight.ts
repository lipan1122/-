/**
 * 夜审前异常检查（整改报告第 6 节明确要求）
 *
 * 夜审一旦执行会给在住客人过房费、把未到店订单标 NOSHOW、切营业日，
 * 所以跑之前必须先让操作员看到「有哪些没处理完的事」。
 *
 * 检查项（对齐报告）：
 *   1. 未完成入住  —— 今天该到店但没办入住
 *   2. 未完成退房  —— 逾期未离店
 *   3. 欠费        —— 在住客人有未结余额
 *   4. 未处理预订  —— 过期仍未处理的预订
 *   5. 未到店订单  —— 今天该离店却没入住
 *   6. 未过房费    —— 在住但今天还没过房费
 *   7. 支付未同步  —— 账单余额与流水合计对不上
 *
 * 放在普通服务端文件，Server Component 可直接 await。
 */

import { all, get } from "@/lib/db";
import { fmtMoney } from "@/lib/utils";

export type PreflightItem = {
  key: string;
  level: "danger" | "warn" | "info";
  title: string;
  count: number;
  detail: string;
  /** 是否阻断夜审（danger 项默认不阻断，只提示，因为酒店实际场景常常带欠费过夜审） */
  blocking: boolean;
  href: string;
};

export function nightAuditPreflight(hotelId: number, bizDate: string): {
  items: PreflightItem[];
  blockingCount: number;
  totalCount: number;
} {
  const items: PreflightItem[] = [];

  /* 1. 未完成入住：今天该到店还没办入住，且还没过期 */
  const pendingArrival = all<{ booking_no: string; guest_name: string; room_no: string | null }>(
    `SELECT b.booking_no, b.guest_name, r.room_no
       FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date <= ? AND b.check_out_date > ?
      ORDER BY b.id LIMIT 10`,
    [hotelId, bizDate, bizDate]
  );
  if (pendingArrival.length > 0) {
    items.push({
      key: "arrival",
      level: "warn",
      title: "未完成入住",
      count: pendingArrival.length,
      detail: pendingArrival
        .slice(0, 4)
        .map((b) => `${b.booking_no} ${b.guest_name}${b.room_no ? "(" + b.room_no + ")" : ""}`)
        .join("；"),
      blocking: false,
      href: "/bookings?status=CONFIRMED",
    });
  }

  /* 2. 未完成退房：逾期未离店 */
  const overdue = all<{ room_no: string; guest_name: string; expect_check_out: string }>(
    `SELECT r.room_no, s.guest_name, s.expect_check_out
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND s.expect_check_out < ?
      ORDER BY s.expect_check_out LIMIT 10`,
    [hotelId, bizDate]
  );
  if (overdue.length > 0) {
    items.push({
      key: "checkout",
      level: "warn",
      title: "未完成退房",
      count: overdue.length,
      detail: overdue
        .slice(0, 4)
        .map((s) => `${s.room_no} ${s.guest_name}（应离 ${s.expect_check_out}）`)
        .join("；"),
      blocking: false,
      href: "/inhouse",
    });
  }

  /* 3. 欠费 */
  const debt =
    get<{ c: number; amt: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(f.balance),0) AS amt
         FROM stays s JOIN folios f ON f.stay_id = s.id
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0.01`,
      [hotelId]
    ) ?? { c: 0, amt: 0 };
  if (Number(debt.c) > 0) {
    items.push({
      key: "debt",
      level: "danger",
      title: "在住欠费",
      count: Number(debt.c),
      detail: `合计 ${fmtMoney(debt.amt)}，夜审后仍会保留欠费状态`,
      blocking: false,
      href: "/cashier",
    });
  }

  /* 4. 未处理预订：离店日已过仍未入住 */
  const staleBookings = all<{ booking_no: string; guest_name: string; check_out_date: string }>(
    `SELECT booking_no, guest_name, check_out_date FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_out_date < ?
      ORDER BY check_out_date LIMIT 10`,
    [hotelId, bizDate]
  );
  if (staleBookings.length > 0) {
    items.push({
      key: "stale",
      level: "warn",
      title: "未处理预订",
      count: staleBookings.length,
      detail: `离店日已过仍未入住，夜审会自动标记为 NOSHOW`,
      blocking: false,
      href: "/bookings",
    });
  }

  /* 5. 未到店订单：今天该离店但仍是预订状态 */
  const noShowToday =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bookings
        WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_out_date = ?`,
      [hotelId, bizDate]
    )?.c ?? 0;
  if (noShowToday > 0) {
    items.push({
      key: "noshow",
      level: "info",
      title: "未到店订单",
      count: noShowToday,
      detail: "今天离店但仍未办理入住，夜审将标记 NOSHOW",
      blocking: false,
      href: "/bookings?status=PENDING",
    });
  }

  /* 6. 未过房费：在住但今天没有房费明细 */
  const noRoomFee = all<{ room_no: string; guest_name: string }>(
    `SELECT r.room_no, s.guest_name
       FROM stays s JOIN rooms r ON r.id = s.room_id
       LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND NOT EXISTS (
          SELECT 1 FROM folio_items fi
           WHERE fi.folio_id = f.id AND fi.item_type = 'ROOM' AND fi.biz_date = ?
        )
      LIMIT 10`,
    [hotelId, bizDate]
  );
  if (noRoomFee.length > 0) {
    items.push({
      key: "roomfee",
      level: "info",
      title: "未过房费",
      count: noRoomFee.length,
      detail: `今天还没过房费，夜审会补记：${noRoomFee
        .slice(0, 3)
        .map((s) => `${s.room_no} ${s.guest_name}`)
        .join("、")}`,
      blocking: false,
      href: "/inhouse",
    });
  }

  /* 7. 支付未同步：账单已收金额与收款流水合计不一致 */
  const payMismatch = all<{ folio_no: string; paid: number; sum_pay: number }>(
    `SELECT f.folio_no, COALESCE(f.paid_amount,0) AS paid,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.folio_id = f.id), 0) AS sum_pay
       FROM folios f
      WHERE f.hotel_id = ?
        AND ABS(COALESCE(f.paid_amount,0) - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.folio_id = f.id),0)) > 0.01
      LIMIT 10`,
    [hotelId]
  );
  if (payMismatch.length > 0) {
    items.push({
      key: "paymismatch",
      level: "danger",
      title: "支付未同步",
      count: payMismatch.length,
      detail: `账单已收金额与流水合计不一致：${payMismatch
        .slice(0, 3)
        .map((f) => `${f.folio_no} ${Number(f.paid).toFixed(2)}≠${Number(f.sum_pay).toFixed(2)}`)
        .join("；")}`,
      blocking: true,
      href: "/reports?r=audit-check",
    });
  }

  return {
    items,
    blockingCount: items.filter((i) => i.blocking).reduce((s, i) => s + i.count, 0),
    totalCount: items.reduce((s, i) => s + i.count, 0),
  };
}
