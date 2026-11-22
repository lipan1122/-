/**
 * 今日预警（整改报告 P2-10：异常预警）
 *
 * 店长打开工作台就能看到今天需要处理的问题，不用自己挨个页面翻。
 * 放在普通服务端文件（不是 "use server"），Server Component 可直接 await。
 */

import { all, get } from "@/lib/db";
import { todayStr } from "@/lib/utils";

export type Alert = {
  key: string;
  level: "danger" | "warn" | "info";
  title: string;
  count: number;
  detail: string;
  href: string;
};

/** 超售房型：某营业日某房型的在住 + 已排房预订 > 该房型房间数 */
function oversold(hotelId: number, from: string, to: string): { typeName: string; day: string; need: number; total: number }[] {
  const rows = all<{ room_type_id: number; type_name: string; total: number }>(
    `SELECT rt.id AS room_type_id, rt.name AS type_name, COUNT(r.id) AS total
       FROM room_types rt LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = rt.hotel_id
      WHERE rt.hotel_id = ? GROUP BY rt.id`,
    [hotelId]
  );
  const out: { typeName: string; day: string; need: number; total: number }[] = [];

  const days: string[] = [];
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(todayStr(d)); // P1-6：本地日期
  }

  for (const rt of rows) {
    if (Number(rt.total) === 0) continue;
    for (const day of days) {
      const occupied =
        get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM stays s JOIN rooms r ON r.id = s.room_id
            WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND r.room_type_id = ?
              AND date(s.check_in_time) <= ? AND s.expect_check_out > ?`,
          [hotelId, rt.room_type_id, day, day]
        )?.c ?? 0;
      const booked =
        get<{ c: number }>(
          `SELECT COALESCE(SUM(COALESCE(br.rate,0) > -1), 0) AS c FROM booking_rooms br
             JOIN bookings b ON b.id = br.booking_id
            WHERE br.hotel_id = ? AND br.room_type_id = ?
              AND br.status IN ('PENDING','CONFIRMED')
              AND br.check_in_date <= ? AND br.check_out_date > ?`,
          [hotelId, rt.room_type_id, day, day]
        )?.c ?? 0;
      const need = Number(occupied) + Number(booked);
      if (need > Number(rt.total)) {
        out.push({ typeName: rt.type_name, day, need, total: Number(rt.total) });
      }
    }
  }
  return out.slice(0, 5);
}

export function loadAlerts(hotelId: number, today: string): Alert[] {
  const out: Alert[] = [];

  /* 1. 超售 */
  const over = oversold(hotelId, today, today);
  if (over.length > 0) {
    out.push({
      key: "oversold",
      level: "danger",
      title: "房型超售",
      count: over.length,
      detail: over.map((o) => `${o.typeName} ${o.day.slice(5)} 需 ${o.need}/共 ${o.total}`).join("；"),
      href: "/rooms/predict",
    });
  }

  /* 2. 逾期未离店 */
  const overdue = all<{ room_no: string; guest_name: string; expect_check_out: string }>(
    `SELECT r.room_no, s.guest_name, s.expect_check_out
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND s.expect_check_out < ?
      ORDER BY s.expect_check_out LIMIT 10`,
    [hotelId, today]
  );
  if (overdue.length > 0) {
    out.push({
      key: "overdue",
      level: "warn",
      title: "逾期未离店",
      count: overdue.length,
      detail: overdue.slice(0, 4).map((o) => `${o.room_no} ${o.guest_name}（应离 ${o.expect_check_out}）`).join("；"),
      href: "/inhouse",
    });
  }

  /* 3. 未到店未处理 */
  const noshow =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bookings
        WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_out_date < ?`,
      [hotelId, today]
    )?.c ?? 0;
  if (noshow > 0) {
    out.push({
      key: "noshow",
      level: "warn",
      title: "未到店待处理",
      count: noshow,
      detail: "离店日已过但仍未入住，夜审会自动标 NOSHOW",
      href: "/bookings?status=PENDING",
    });
  }

  /* 4. 渠道同步失败 */
  const failed =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM channel_sync_logs
        WHERE hotel_id = ? AND status <> 'SUCCESS' AND created_at >= datetime('now','-1 day')`,
      [hotelId]
    )?.c ?? 0;
  if (failed > 0) {
    out.push({
      key: "channel",
      level: "warn",
      title: "渠道同步异常",
      count: failed,
      detail: "近 24 小时有同步失败记录，可能影响接单",
      href: "/channels",
    });
  }

  /* 5. 账实不符的交班 */
  const shiftDiff = all<{ shift_name: string; operator: string; diff: number }>(
    `SELECT shift_name, operator, diff FROM shifts
      WHERE hotel_id = ? AND status = 'CLOSED' AND ABS(COALESCE(diff,0)) > 0.01
        AND date(end_at) >= ? ORDER BY id DESC LIMIT 5`,
    [hotelId, today]
  );
  if (shiftDiff.length > 0) {
    out.push({
      key: "shift",
      level: "danger",
      title: "交班长短款",
      count: shiftDiff.length,
      detail: shiftDiff
        .map((s) => `${s.shift_name} ${s.operator} ${s.diff > 0 ? "长" : "短"} ¥${Math.abs(s.diff).toFixed(2)}`)
        .join("；"),
      href: "/handover",
    });
  }

  /* 6. 在住欠费 */
  const debt =
    get<{ c: number; amt: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(f.balance),0) AS amt
         FROM stays s JOIN folios f ON f.stay_id = s.id
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0.01`,
      [hotelId]
    ) ?? { c: 0, amt: 0 };
  if (Number(debt.c) > 0) {
    out.push({
      key: "debt",
      level: "info",
      title: "在住欠费",
      count: Number(debt.c),
      detail: `合计 ¥${Number(debt.amt).toFixed(2)}，退房前需结清`,
      href: "/cashier",
    });
  }

  return out;
}
