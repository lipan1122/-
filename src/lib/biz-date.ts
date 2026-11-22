/**
 * 营业日计算（整改报告 P1-6）
 *
 * 酒店营业日不等于自然日：多数酒店按「凌晨 N 点切换」，
 * 比如 05:00 前进店的客人算前一个营业日。
 *
 * 配置项：settings.key = 'biz_day_cutoff'，值形如 "05:00"（默认 00:00）
 */

import { get } from "@/lib/db";

const DEFAULT_CUTOFF = "00:00";

/** 读取本酒店的营业日切换时间（HH:MM） */
export function getBizCutoff(hotelId: number): string {
  const row = get<{ value: string }>(
    `SELECT value FROM settings WHERE hotel_id = ? AND key = 'biz_day_cutoff' LIMIT 1`,
    [hotelId]
  );
  const v = (row?.value ?? "").trim();
  return /^\d{2}:\d{2}$/.test(v) ? v : DEFAULT_CUTOFF;
}

/**
 * 计算营业日
 * @param now    当前时间（默认取系统时间）
 * @param cutoff 切换时间 HH:MM
 * @returns YYYY-MM-DD
 */
export function bizDate(now: Date = new Date(), cutoff: string = DEFAULT_CUTOFF): string {
  const [hh, mm] = cutoff.split(":").map((x) => Number(x) || 0);
  const d = new Date(now.getTime());
  // 还没到切换点 → 仍属于前一个营业日
  if (d.getHours() * 60 + d.getMinutes() < hh * 60 + mm) {
    d.setDate(d.getDate() - 1);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 带酒店配置的营业日 */
export function bizToday(hotelId: number, now: Date = new Date()): string {
  return bizDate(now, getBizCutoff(hotelId));
}

/** 当前是否已过营业日切换点（夜审前的「今天是否已翻页」判断用） */
export function isAfterCutoff(now: Date = new Date(), cutoff: string = DEFAULT_CUTOFF): boolean {
  const [hh, mm] = cutoff.split(":").map((x) => Number(x) || 0);
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}
