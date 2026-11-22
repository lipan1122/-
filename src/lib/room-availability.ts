/**
 * 房间区间占用校验（整改清单 P0-5）
 *
 * 背景：续住、换房原来只看「当前房态是不是 OC/VC」，不看未来日期区间。
 *   结果：客人 A 住到 11-20，续住到 11-25，而这间房 11-22 已经卖给客人 B →
 *   续住成功，22 号那天房间双重占用，前台到店才发现没房。
 *
 * 区间冲突的判定标准（半开区间）：
 *   existing.check_in < new.check_out AND existing.check_out > new.check_in
 * 相等不算冲突（A 12:00 退房、B 14:00 入住，同一营业日可以接续）。
 *
 * 三处占用来源都要查：
 *   1. stays（在住单，用 check_in_time 的日期 + expect_check_out）
 *   2. bookings（主单镜像的 room_id，历史兼容）
 *   3. booking_rooms（明细表，权威来源）
 */

import { all } from "@/lib/db";

export type ConflictSource = "stay" | "booking" | "booking_room";

export type RoomConflict = {
  source: ConflictSource;
  refId: number;
  refNo: string;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  detail: string;
};

export type ConflictCheckInput = {
  hotelId: number;
  roomId: number;
  /** 新区间（YYYY-MM-DD） */
  checkIn: string;
  checkOut: string;
  /** 排除自己（续住时排除当前入住单，换房时排除当前入住单/预订） */
  excludeStayId?: number;
  excludeBookingId?: number;
};

/**
 * 查该房间在目标区间内的所有占用冲突。
 * 返回空数组 = 可排；非空 = 有冲突，调用方应回滚并提示。
 */
export function findRoomConflicts(input: ConflictCheckInput): RoomConflict[] {
  const { hotelId, roomId, checkIn, checkOut, excludeStayId, excludeBookingId } = input;
  if (!roomId || !checkIn || !checkOut || checkIn >= checkOut) return [];

  const out: RoomConflict[] = [];

  /* 1. 在住单 */
  const stays = all<{
    id: number;
    stay_no: string;
    guest_name: string | null;
    check_in: string;
    expect_out: string;
  }>(
    `SELECT s.id, s.stay_no, s.guest_name,
            COALESCE(substr(s.check_in_time, 1, 10), '') AS check_in,
            COALESCE(s.expect_check_out, '') AS expect_out
       FROM stays s
      WHERE s.hotel_id = ? AND s.room_id = ?
        AND s.status = 'INHOUSE'
        AND (? IS NULL OR s.id <> ?)
        AND COALESCE(substr(s.check_in_time, 1, 10), '') < ?
        AND COALESCE(s.expect_check_out, '') > ?`,
    [hotelId, roomId, excludeStayId ?? null, excludeStayId ?? null, checkOut, checkIn]
  );
  for (const s of stays) {
    out.push({
      source: "stay",
      refId: s.id,
      refNo: s.stay_no,
      guestName: s.guest_name,
      checkIn: s.check_in,
      checkOut: s.expect_out,
      detail: `在住 ${s.stay_no} ${s.guest_name ?? ""}（${s.check_in} ~ ${s.expect_out}）`,
    });
  }

  /* 2. 预订主单（历史数据：主单 room_id 有值但明细可能没有） */
  const bookings = all<{
    id: number;
    booking_no: string;
    guest_name: string | null;
    check_in_date: string;
    check_out_date: string;
  }>(
    `SELECT b.id, b.booking_no, b.guest_name, b.check_in_date, b.check_out_date
       FROM bookings b
      WHERE b.hotel_id = ? AND b.room_id = ?
        AND b.status IN ('PENDING','CONFIRMED','CHECKED_IN')
        AND (? IS NULL OR b.id <> ?)
        AND b.check_in_date < ? AND b.check_out_date > ?`,
    [hotelId, roomId, excludeBookingId ?? null, excludeBookingId ?? null, checkOut, checkIn]
  );
  for (const b of bookings) {
    out.push({
      source: "booking",
      refId: b.id,
      refNo: b.booking_no,
      guestName: b.guest_name,
      checkIn: b.check_in_date,
      checkOut: b.check_out_date,
      detail: `预订 ${b.booking_no} ${b.guest_name ?? ""}（${b.check_in_date} ~ ${b.check_out_date}）`,
    });
  }

  /* 3. 多房明细（权威来源） */
  const details = all<{
    id: number;
    booking_no: string;
    guest_name: string | null;
    check_in_date: string;
    check_out_date: string;
  }>(
    `SELECT br.id, b.booking_no, COALESCE(br.guest_name, b.guest_name) AS guest_name,
            br.check_in_date, br.check_out_date
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id
      WHERE br.hotel_id = ? AND br.room_id = ?
        AND br.status IN ('CONFIRMED','CHECKED_IN')
        AND (? IS NULL OR br.booking_id <> ?)
        AND br.check_in_date < ? AND br.check_out_date > ?`,
    [hotelId, roomId, excludeBookingId ?? null, excludeBookingId ?? null, checkOut, checkIn]
  );
  for (const d of details) {
    /* 主单已计入的不重复报（同一 booking_no 只报一次） */
    if (out.some((o) => o.refNo === d.booking_no)) continue;
    out.push({
      source: "booking_room",
      refId: d.id,
      refNo: d.booking_no,
      guestName: d.guest_name,
      checkIn: d.check_in_date,
      checkOut: d.check_out_date,
      detail: `预订 ${d.booking_no} ${d.guest_name ?? ""}（${d.check_in_date} ~ ${d.check_out_date}）`,
    });
  }

  return out;
}

/** 把冲突列表拼成一句话，给 action 直接返回给用户 */
export function conflictMessage(conflicts: RoomConflict[], roomNo?: string): string {
  if (conflicts.length === 0) return "";
  const head = roomNo ? `房间 ${roomNo} 在该日期区间已被占用：` : "该房间在目标日期区间已被占用：";
  return head + conflicts.slice(0, 3).map((c) => c.detail).join("；") + (conflicts.length > 3 ? ` 等 ${conflicts.length} 条` : "");
}
