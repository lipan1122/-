/**
 * 统一搜索（整改报告 P2-10）
 *
 * 一个输入框打通：客人 / 预订 / 入住单 / 房间。
 * 放在普通服务端文件（不是 "use server"），Server Component 可直接 await。
 */

import { all } from "@/lib/db";

export type SearchResult = {
  guests: { id: number; name: string; mobile: string | null; idNo: string | null; vipLevel: number | null; deleted: number }[];
  bookings: {
    id: number;
    bookingNo: string;
    guestName: string;
    mobile: string | null;
    roomNo: string | null;
    checkIn: string;
    checkOut: string;
    status: string;
    roomCount: number;
  }[];
  stays: {
    id: number;
    stayNo: string;
    guestName: string;
    mobile: string | null;
    roomNo: string;
    status: string;
    checkIn: string | null;
    expectOut: string | null;
    balance: number;
  }[];
  rooms: { id: number; roomNo: string; status: string; roomType: string | null; floor: number | null }[];
  total: number;
};

const LIMIT = 20;

export function unifiedSearch(hotelId: number, raw: string): SearchResult {
  const q = raw.trim();
  if (!q) {
    return { guests: [], bookings: [], stays: [], rooms: [], total: 0 };
  }
  const like = `%${q}%`;
  /** 纯数字时按房号/手机号优先；带字母时按单号 */
  const isDigits = /^\d+$/.test(q);

  const guests = all<SearchResult["guests"][number]>(
    `SELECT id, name, mobile, id_no AS idNo, vip_level AS vipLevel, COALESCE(deleted,0) AS deleted
       FROM guests
      WHERE hotel_id = ? AND (name LIKE ? OR mobile LIKE ? OR COALESCE(id_no,'') LIKE ?)
      ORDER BY COALESCE(deleted,0), id DESC LIMIT ?`,
    [hotelId, like, like, like, LIMIT]
  );

  const bookings = all<SearchResult["bookings"][number]>(
    `SELECT b.id, b.booking_no AS bookingNo, b.guest_name AS guestName, b.mobile,
            r.room_no AS roomNo, b.check_in_date AS checkIn, b.check_out_date AS checkOut,
            b.status, COALESCE(b.room_count,1) AS roomCount
       FROM bookings b
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.hotel_id = ?
        AND (b.booking_no LIKE ? OR b.guest_name LIKE ? OR COALESCE(b.mobile,'') LIKE ?
             OR COALESCE(b.channel_order_no,'') LIKE ?)
      ORDER BY b.id DESC LIMIT ?`,
    [hotelId, like, like, like, like, LIMIT]
  );

  const stays = all<SearchResult["stays"][number]>(
    `SELECT s.id, s.stay_no AS stayNo, s.guest_name AS guestName, s.mobile,
            r.room_no AS roomNo, s.status,
            substr(COALESCE(s.check_in_time,''),1,10) AS checkIn,
            s.expect_check_out AS expectOut,
            COALESCE(f.balance,0) AS balance
       FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id
       LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = ?
        AND (s.stay_no LIKE ? OR s.guest_name LIKE ? OR COALESCE(s.mobile,'') LIKE ?)
      ORDER BY s.id DESC LIMIT ?`,
    [hotelId, like, like, like, LIMIT]
  );

  const rooms = all<SearchResult["rooms"][number]>(
    `SELECT r.id, r.room_no AS roomNo, r.status, rt.name AS roomType, r.floor
       FROM rooms r
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = ?
        AND (r.room_no LIKE ? ${isDigits ? "OR r.floor LIKE ?" : ""})
      ORDER BY r.sort LIMIT ?`,
    isDigits ? [hotelId, like, like, LIMIT] : [hotelId, like, LIMIT]
  );

  return {
    guests,
    bookings,
    stays,
    rooms,
    total: guests.length + bookings.length + stays.length + rooms.length,
  };
}
