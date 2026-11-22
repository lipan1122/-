"use server";

import { revalidatePath } from "next/cache";
import { get, run, tx } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 批量排房提交结果。
 * ok = true 时 savedCount 为实际落库的订单数；失败时 error 为可直接展示的中文原因。
 */
export type AssignRoomsResult = { ok?: boolean; savedCount?: number; error?: string };

/** 一条排房意向：把哪个订单排到哪间房 */
type Pair = { bookingId: number; roomId: number };

/** 任意值转正整数，非法值返回 0 */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 解析前端提交的 rows JSON：形如 [{"bookingId":1,"roomId":2}]，任何非法项一律丢弃 */
function parsePairs(raw: string): Pair[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const pairs: Pair[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const bookingId = toInt(row.bookingId);
    const roomId = toInt(row.roomId);
    if (bookingId <= 0 || roomId <= 0) continue;
    pairs.push({ bookingId, roomId });
  }
  return pairs;
}

/**
 * 批量排房：一次提交多组「订单 → 房间」。
 *
 * 事务内逐条校验（任一条不合法则整批回滚，避免排一半留下脏数据）：
 *   1. 订单必须仍属本酒店、状态 PENDING/CONFIRMED 且尚未排房；
 *   2. 房间必须是订单预订房型下的空净房 VC / 空脏房 VD；
 *   3. 房间在订单入离区间内无冲突（在住占房 / 已排房预订 / 多房明细都不能撞）；
 *   4. 用乐观锁占位（UPDATE rooms SET status = status ...）确认房间仍可排。
 * 全部通过后把 bookings.room_id 落库、状态置为 CONFIRMED，并写一条 op_logs。
 *
 * 整改 P1-1（排房并发兜底不严）：本批排房原来只查 stays 和 bookings 主单镜像，
 * 漏了权威来源 booking_rooms —— 同一间房被另一张单的「房间明细」占着时查不出来；
 * 而且房间校验与落库之间没有行级互斥，两个并发批量排房可能都判定房间可排。
 * 现在补齐第三来源，并在每间房落库前用乐观锁 UPDATE 拿行锁 + 回读 changes。
 */
export async function assignRoomsAction(formData: FormData): Promise<AssignRoomsResult> {
  /*
   * 权限（P0-5）：批量排房会直接占用房间（bookings.room_id / booking_rooms），
   * 原来只校验登录，客房角色打开房态图就能把订单排进任意房间。
   * booking.assign_room 授权 admin / frontdesk，与单条排房 action 同口径。
   */
  const user = await requirePermission("booking.assign_room");
  const hotelId = user.hotelId;

  const pairs = parsePairs(String(formData.get("rows") ?? ""));
  if (pairs.length === 0) return { error: "请先勾选待排房订单并分配房间" };

  // 同一订单 / 同一房间只保留第一条，防止一次提交把一间房排给两个订单
  const seenBooking = new Set<number>();
  const seenRoom = new Set<number>();
  const uniq: Pair[] = [];
  for (const p of pairs) {
    if (seenBooking.has(p.bookingId) || seenRoom.has(p.roomId)) continue;
    seenBooking.add(p.bookingId);
    seenRoom.add(p.roomId);
    uniq.push(p);
  }

  try {
    tx(() => {
      const parts: string[] = [];

      for (const pair of uniq) {
        /* ---------- 1. 订单校验 ---------- */
        const booking = get<{
          id: number;
          booking_no: string;
          room_type_id: number | null;
          check_in_date: string;
          check_out_date: string;
          rate: number | null;
        }>(
          `SELECT id, booking_no, room_type_id, check_in_date, check_out_date, COALESCE(rate, 0) AS rate
             FROM bookings
            WHERE id = ? AND hotel_id = ?
              AND status IN ('PENDING','CONFIRMED')
              AND (room_id IS NULL OR room_id = 0)`,
          [pair.bookingId, hotelId]
        );
        if (!booking) {
          throw new Error(`订单（ID ${pair.bookingId}）已排房或状态已变更，请刷新后重试`);
        }

        /* ---------- 2. 房间校验：空净/空脏（房型不同视为升级排房，允许） ---------- */
        const room = get<{ id: number; room_no: string; status: string; room_type_id: number }>(
          `SELECT id, room_no, status, room_type_id
             FROM rooms
            WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')`,
          [pair.roomId, hotelId]
        );
        if (!room) {
          throw new Error(`订单 ${booking.booking_no} 的房间（ID ${pair.roomId}）不是空净/空脏房`);
        }
        const upgraded = Boolean(booking.room_type_id && room.room_type_id !== booking.room_type_id);

        /* ---------- 3. 区间冲突：在住占房 ---------- */
        const stayClash = get<{ c: number }>(
          `SELECT 1 AS c
             FROM stays s
            WHERE s.hotel_id = ? AND s.room_id = ? AND s.status = 'INHOUSE'
              AND substr(s.check_in_time, 1, 10) < ?
              AND (s.expect_check_out IS NULL OR s.expect_check_out > ?)
            LIMIT 1`,
          [hotelId, room.id, booking.check_out_date, booking.check_in_date]
        );
        /* ---------- 3. 区间冲突：已被其他订单排房 ---------- */
        const bookingClash =
          stayClash ??
          get<{ c: number }>(
            `SELECT 1 AS c
               FROM bookings o
              WHERE o.hotel_id = ? AND o.room_id = ? AND o.id <> ?
                AND o.status IN ('PENDING','CONFIRMED','CHECKED_IN')
                AND o.check_in_date < ? AND o.check_out_date > ?
              LIMIT 1`,
            [hotelId, room.id, booking.id, booking.check_out_date, booking.check_in_date]
          );
        /*
         * ---------- 3b. 区间冲突：多房明细（权威来源，整改 P1-1 补齐） ----------
         * 主单镜像 room_id 只是第一间房的兼容字段，真正的占房记录在 booking_rooms。
         * 原来这里不查明细，同一间房被另一张单的明细占着也照样排得出去；
         * 而且「日期不同但区间重叠」时 booking_rooms 的占房唯一索引（同房间+同起止日期）
         * 根本不会触发，所以才必须在这里用区间条件主动查一遍。
         */
        const detailClash =
          bookingClash ??
          get<{ c: number }>(
            `SELECT 1 AS c
               FROM booking_rooms br
              WHERE br.hotel_id = ? AND br.room_id = ? AND br.booking_id <> ?
                AND br.status IN ('CONFIRMED','CHECKED_IN')
                AND br.check_in_date < ? AND br.check_out_date > ?
              LIMIT 1`,
            [hotelId, room.id, booking.id, booking.check_out_date, booking.check_in_date]
          );
        if (detailClash) {
          throw new Error(
            `房间 ${room.room_no} 在 ${booking.check_in_date} 至 ${booking.check_out_date} 期间已被占用`
          );
        }

        /* ---------- 3c. 乐观锁占位（整改 P1-1） ----------
         * 房间校验和落库之间有时间窗，两个并发批量排房可能都读到同一个 VC/VD 房间。
         * 这条 UPDATE 不真正改房态（排房不改房态，入住才置 OC），作用有两个：
         *   1. 在事务内对该房间行拿一次写锁，SQLite 下让并发排房串行化；
         *   2. 回读 changes —— 0 表示房态在这期间已被别人改成 OC/OOO/LOCK 等，
         *      说明有人抢先，立刻整批回滚（不能部分成功）。
         */
        const lock = run(
          `UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')`,
          [room.id, hotelId]
        );
        if (lock.changes === 0) {
          throw new Error(
            `房间 ${room.room_no} 刚被其他人改动（并发冲突），本批排房已全部取消，请刷新后重试`
          );
        }

        /* ---------- 4. 落库 ---------- */
        /* 多房明细优先：找一条待排明细写房号；没有明细则补一条（兼容老数据） */
        const pendingDetail = get<{ id: number }>(
          `SELECT id FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL AND status = 'PENDING'
            ORDER BY id LIMIT 1`,
          [hotelId, booking.id]
        );
        if (pendingDetail) {
          run(
            `UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED' WHERE id = ? AND hotel_id = ?`,
            [room.id, pendingDetail.id, hotelId]
          );
        } else {
          run(
            `INSERT INTO booking_rooms
               (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status,
                check_in_date, check_out_date, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              hotelId,
              booking.id,
              booking.room_type_id,
              room.id,
              null,
              // 明细房价取主单房价（整改 P1-12）：原来写死 0，按明细汇总房费时会被算成免费房
              booking.rate ?? 0,
              "CONFIRMED",
              booking.check_in_date,
              booking.check_out_date,
              nowIso(),
            ]
          );
        }
        const restCnt =
          get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL`,
            [hotelId, booking.id]
          )?.c ?? 0;
        run(
          `UPDATE bookings
              SET room_id = COALESCE(room_id, ?),
                  status = CASE WHEN ? > 0 THEN 'PENDING' ELSE 'CONFIRMED' END,
                  updated_at = ?
            WHERE id = ? AND hotel_id = ?`,
          [room.id, restCnt, nowIso(), booking.id, hotelId]
        );

        parts.push(`${booking.booking_no}→${room.room_no}${upgraded ? "（升级房型）" : ""}`);
      }

      /* ---------- 5. 操作日志 ---------- */
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        user.realName,
        "批量排房",
        `批量排房 ${parts.length} 单：${parts.join("、")}`,
        nowIso(),
      ]);
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "批量排房失败，请刷新后重试" };
  }

  revalidatePath("/rooms/forecast");
  revalidatePath("/bookings");
  revalidatePath("/rooms");
  revalidatePath("/dashboard");

  return { ok: true, savedCount: uniq.length };
}
