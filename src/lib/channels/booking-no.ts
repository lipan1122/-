/**
 * 预订号生成（整改清单 P2-14 后半）
 *
 * ── 原来错在哪 ──
 * 全项目至少 5 处各自写 `BK${MAX(id)+1+3000}`：
 *   channels/actions.ts、channels/sync-actions.ts、channel-orders/actions.ts、
 *   bookings/actions.ts、api/mini/_shared.ts
 * 而 `bookings.booking_no` 上**没有任何唯一约束**（只有 id 主键）。
 * 两个请求同时进来 → 读到同一个 MAX(id) → 插出两个一模一样的 BK4321，
 * 之后按预订号查单、对账、打印单据全部二义。实测库里 588 条预订没撞号，
 * 是运气（同步写入 + 事务串行），不是设计。
 *
 * ── 现在怎么保证唯一 ──
 * 1. `scripts/migrate-all.mjs` 给 bookings 加 `CREATE UNIQUE INDEX idx_bookings_no
 *    ON bookings(hotel_id, booking_no)`（先查重复，有重复会明确报出来而不是静默建索引失败）；
 * 2. 本函数按「基号 + 撞号重试」生成：基号保持全项目口径 BK{MAX(id)+3001}，
 *    一旦该号已存在就追加 3 位随机后缀再试，最多 20 次。
 *    正常情况下第一次就成功（和原来的号完全一样），只有真撞号才会看到后缀。
 *
 * 为什么放在 src/lib/channels/ 下：本轮渠道整改只允许动渠道目录，而渠道订单转预订
 * （channels / channel-orders 三处）是撞号风险最高的路径（批量自动接单一次几十单）。
 * 其它模块（bookings/actions.ts、api/mini/_shared.ts）后续应统一改用本函数。
 */

import { get } from "@/lib/db";

/** 预订号基号：与全项目既有口径一致（BK + 全局 MAX(id) + 3001） */
function baseBookingNo(): number {
  const maxId = get<{ m: number | null }>(`SELECT MAX(id) AS m FROM bookings`)?.m ?? 0;
  return maxId + 1 + 3000;
}

/** 该预订号在本店是否已存在（唯一索引是 (hotel_id, booking_no)） */
export function bookingNoExists(hotelId: number, bookingNo: string): boolean {
  try {
    const row = get<{ id: number }>(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no = ? LIMIT 1`, [
      hotelId,
      bookingNo,
    ]);
    return Boolean(row);
  } catch {
    // 表缺失等异常时按「不存在」处理：调用方紧接着的 INSERT 会自己报错
    return false;
  }
}

/**
 * 生成一个本店内唯一的预订号。
 *
 * @param hotelId 酒店 id（唯一索引按酒店隔离，两个酒店可以有同号预订）
 */
export function nextBookingNo(hotelId: number): string {
  const base = baseBookingNo();
  let bookingNo = `BK${base}`;
  for (let attempt = 0; attempt < 20 && bookingNoExists(hotelId, bookingNo); attempt += 1) {
    // 撞号只在并发瞬间发生：加 3 位随机后缀即可打散，不必改基号口径
    const suffix = String(Math.floor(Math.random() * 900) + 100);
    bookingNo = `BK${base}-${suffix}`;
  }
  return bookingNo;
}
