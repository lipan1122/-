"use server";

import { revalidatePath } from "next/cache";
import { all, get, run, tx } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 批量排房提交结果。
 * ok = true 时 savedCount 为实际落库的「间」数；
 * skippedCount 为本次跳过的「间」数（已排房 / 已入住 / 已退房 / 已取消，跳过不等于失败）。
 * 失败时 error 为可直接展示的中文原因（整批未排）。
 */
export type AssignRoomsResult = { ok?: boolean; savedCount?: number; skippedCount?: number; error?: string };

/** 订单快照（排房校验用，状态已限定 PENDING / CONFIRMED） */
type BookingSnapshot = {
  id: number;
  booking_no: string;
  room_type_id: number | null;
  room_count: number | null;
  rate: number | null;
  check_in_date: string;
  check_out_date: string;
};

/** 明细行（booking_rooms 一行 = 一间）。日期已用 substr 归一到 YYYY-MM-DD，空串 = 沿用主单区间 */
type DetailRow = {
  id: number;
  room_type_id: number | null;
  room_id: number | null;
  status: string;
  check_in_date: string;
  check_out_date: string;
};

/**
 * 一条排房意向，支持两种形态（同一个 rows 数组里可以混用）：
 *   · 主单级（老行为）    ：{ bookingId, roomId }
 *   · 明细级（本次新能力）：{ bookingId, roomId, bookingRoomId }
 *                          或 { bookingId, roomId, roomTypeId, unitIndex }
 */
type Pair = {
  bookingId: number;
  roomId: number;
  /** 明细级首选：booking_rooms.id。弹窗里一行明细就是一条，直接指名最不容易排错行 */
  bookingRoomId: number;
  /** 明细级次选：该明细的房型 id（不传 bookingRoomId 时生效） */
  roomTypeId: number;
  /** 明细级次选：序号，1-based，按该订单明细 id 升序（与弹窗「第 i/N 间」同口径） */
  unitIndex: number;
};

/** 任意值转正整数，非法值返回 0 */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 解析前端提交的 rows JSON。任何非法项一律丢弃（不为一条脏数据炸整批解析）。
 *   [{"bookingId":1,"roomId":2}]                              主单级（老界面）
 *   [{"bookingId":1,"roomId":2,"bookingRoomId":853}]          明细级 · 按明细 id
 *   [{"bookingId":1,"roomId":2,"roomTypeId":3,"unitIndex":2}] 明细级 · 按房型 + 序号
 */
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
    pairs.push({
      bookingId,
      roomId,
      bookingRoomId: Math.max(0, toInt(row.bookingRoomId)),
      roomTypeId: Math.max(0, toInt(row.roomTypeId)),
      unitIndex: Math.max(0, toInt(row.unitIndex)),
    });
  }
  return pairs;
}

/** 该意向是否是「明细级」（显式指名了某一行明细） */
function isDetailLevel(pair: Pair): boolean {
  return pair.bookingRoomId > 0 || pair.roomTypeId > 0 || pair.unitIndex > 0;
}

/** 只有 PENDING / CONFIRMED 的明细可以排房；CHECKED_IN / CHECKED_OUT / CANCELLED 一律跳过 */
function isAssignableDetail(status: string): boolean {
  return status === "PENDING" || status === "CONFIRMED";
}

/** 明细状态 → 给前台看的说法（跳过时告诉用户为什么这间没排） */
function detailStatusLabel(status: string): string {
  switch (status) {
    case "CHECKED_IN":
      return "已入住";
    case "CHECKED_OUT":
      return "已退房";
    case "CANCELLED":
      return "已取消";
    case "CONFIRMED":
      return "已排房";
    default:
      return `状态为 ${status}`;
  }
}

/** 目标明细的定位结果：可写明细 / 需要补一条（迁移前老数据）/ 跳过 */
type Target =
  | { kind: "detail"; detail: DetailRow }
  | { kind: "insert" }
  | { kind: "skip"; reason: string };

const BOOKING_SQL = `SELECT b.id, b.booking_no, b.room_type_id,
                            COALESCE(b.room_count, 1) AS room_count, COALESCE(b.rate, 0) AS rate,
                            b.check_in_date, b.check_out_date
                       FROM bookings b
                      WHERE b.id = ? AND b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')`;

const DETAIL_SQL = `SELECT id, room_type_id, room_id, status,
                           substr(COALESCE(check_in_date, ''), 1, 10) AS check_in_date,
                           substr(COALESCE(check_out_date, ''), 1, 10) AS check_out_date
                      FROM booking_rooms
                     WHERE hotel_id = ? AND booking_id = ?
                     ORDER BY id`;

/**
 * 定位「这一条意向要排的是哪一间」。
 *
 * 顺序：明细 id（最精确）→ 房型 + 序号（兼容调用方）→ 主单级（第一条待排明细 / 补一条）。
 * 定位不到 → 抛错（整批回滚）；定位到「不该排」的行（已排房 / 已入住 / 已退房 / 已取消）→ skip。
 * 主单级的老订单如果连明细都没有（迁移前的历史数据），返回 insert，由调用方补一条明细。
 */
function resolveTarget(hotelId: number, booking: BookingSnapshot, pair: Pair): Target {
  /* ---------- A. 明细级 · 按 booking_rooms.id ---------- */
  if (pair.bookingRoomId > 0) {
    const detail = get<DetailRow>(
      `SELECT id, room_type_id, room_id, status,
              substr(COALESCE(check_in_date, ''), 1, 10) AS check_in_date,
              substr(COALESCE(check_out_date, ''), 1, 10) AS check_out_date
         FROM booking_rooms
        WHERE hotel_id = ? AND booking_id = ? AND id = ?`,
      [hotelId, booking.id, pair.bookingRoomId]
    );
    if (!detail) {
      throw new Error(
        `订单 ${booking.booking_no} 的第 ${pair.bookingRoomId} 号房间明细不存在（可能已被删除），请刷新后重试（整批未排）`
      );
    }
    /*
     * 先看状态、再看有没有房号：
     * CHECKED_IN / CHECKED_OUT / CANCELLED 的明细一定也带着 room_id，
     * 如果先判 room_id 就会把「已入住」说成「已排房」，前台看不出这间其实住着人。
     */
    if (!isAssignableDetail(detail.status)) {
      return { kind: "skip", reason: `第 ${pair.bookingRoomId} 号明细${detailStatusLabel(detail.status)}` };
    }
    if (detail.room_id !== null && detail.room_id > 0) {
      return { kind: "skip", reason: `第 ${pair.bookingRoomId} 号明细已排房` };
    }
    return { kind: "detail", detail };
  }

  const details = all<DetailRow>(DETAIL_SQL, [hotelId, booking.id]);

  /* ---------- B. 明细级 · 按房型 + 序号 ---------- */
  if (pair.roomTypeId > 0 || pair.unitIndex > 0) {
    if (details.length === 0) {
      throw new Error(
        `订单 ${booking.booking_no} 还没有房间明细，无法按「房型 + 序号」排房，请改用主单排房（整批未排）`
      );
    }
    let picked: DetailRow | undefined;
    let pos = 0;
    if (pair.unitIndex > 0) {
      picked = details[pair.unitIndex - 1];
      if (!picked) {
        throw new Error(
          `订单 ${booking.booking_no} 只有 ${details.length} 间明细，没有第 ${pair.unitIndex} 间，请刷新后重试（整批未排）`
        );
      }
      /* 序号与房型必须自洽：前端若把两单的序号串了，这里挡住，绝不写错行 */
      if (pair.roomTypeId > 0 && picked.room_type_id !== null && picked.room_type_id !== pair.roomTypeId) {
        throw new Error(
          `订单 ${booking.booking_no} 第 ${pair.unitIndex} 间明细的房型与提交的房型不一致，请刷新后重试（整批未排）`
        );
      }
      pos = pair.unitIndex;
    } else {
      picked = details.find((d) => (d.room_type_id ?? booking.room_type_id) === pair.roomTypeId);
      if (!picked) {
        throw new Error(`订单 ${booking.booking_no} 没有房型匹配的房间明细，请刷新后重试（整批未排）`);
      }
      pos = details.indexOf(picked) + 1;
    }
    if (!isAssignableDetail(picked.status)) {
      return { kind: "skip", reason: `第 ${pos} 间明细${detailStatusLabel(picked.status)}` };
    }
    if (picked.room_id !== null && picked.room_id > 0) {
      return { kind: "skip", reason: `第 ${pos} 间明细已排房` };
    }
    return { kind: "detail", detail: picked };
  }

  /* ---------- C. 主单级（老行为）：排第一条待排明细 ---------- */
  const pendingDetail = details.find((d) => (d.room_id === null || d.room_id <= 0) && d.status === "PENDING");
  if (pendingDetail) return { kind: "detail", detail: pendingDetail };

  /*
   * 没有待排明细时不再「闷头再插一条」：
   * 旧实现无条件 INSERT，已排满的订单还能继续加房，明细数会超过 room_count。
   * 这里按订单间数算一次容量 —— 还有余量（明细漏行的老数据）才补，否则明确拒绝。
   */
  const roomCount = Math.max(1, booking.room_count ?? 1);
  const assigned =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM booking_rooms
        WHERE hotel_id = ? AND booking_id = ? AND room_id IS NOT NULL`,
      [hotelId, booking.id]
    )?.c ?? 0;
  if (assigned >= roomCount) {
    throw new Error(
      `订单 ${booking.booking_no} 共 ${roomCount} 间，已全部排满，不能再加房。要加房请先修改订单间数（整批未排）`
    );
  }
  return { kind: "insert" };
}

/** 房型名（只在报错信息里用，取不到就给一个可读的回退） */
function roomTypeName(hotelId: number, typeId: number | null): string {
  if (!typeId) return "未指定房型";
  const t = get<{ name: string }>(`SELECT name FROM room_types WHERE id = ? AND hotel_id = ?`, [typeId, hotelId]);
  return t?.name ?? `房型#${typeId}`;
}

/**
 * 批量排房（远期房态「引入待排房订单」弹窗的保存动作）。
 *
 * ── 本次修复：多房订单不能逐明细排房 ──
 * 旧实现只认「主单 room_id 为空」的订单：
 *     AND (room_id IS NULL OR room_id = 0)
 * 于是 BK-MULTI3 这类「room_count=3、主单 room_id 已填首间、明细 3 行（1 已排 + 2 待排）」
 * 的订单，在弹窗里能看到 2 间待分房，却一间也排不了 —— 硬塞候选房直接整批报错回滚。
 *
 * 现在同一个 action 支持两种输入（见 Pair）：
 *   · 主单级（老行为）：给主单排房，并落到「该单第一条待排明细」上；完全没有明细的老数据补一条；
 *   · 明细级（新能力）：只排指定明细行，一张多房订单的 N 间各自落各自的明细。
 *
 * ── 改这里之前必须先读的不变量 ──
 *   1. 事务：所有行的校验都在 tx 内做，任何一条失败 → 整批回滚，绝不「排一半」；
 *   2. 冲突：同一间房在同一日期区间不能被排两次。四个来源全查 ——
 *      在住 stays / 其他订单主单镜像 bookings / 其他订单明细 booking_rooms /
 *      **本订单自己的其他明细**（最后一条是这次新补的：旧实现只查「其他订单」，
 *      同一张单把同一间房排给两间明细会绕过校验，最后撞 idx_booking_rooms_occupied
 *      报一句用户看不懂的 UNIQUE 错，而且整批回滚）；
 *   3. 房型：明细级排房要求候选房的实际房型 == 该明细的房型（不许借明细排房偷偷升级房型）；
 *      主单级沿用旧口径 —— 跨房型视为「升级排房」，只写日志不改房型；
 *   4. 状态：只写 PENDING / CONFIRMED 的明细；CHECKED_IN / CHECKED_OUT / CANCELLED 跳过
 *      （跳过不写库、不算失败，结果里用 skippedCount 回报）；
 *   5. stay 关联：明细排房只写 room_id / status，**刻意不碰 stay_id** ——
 *      入住时 frontdesk/actions.ts 按「booking_id + room_id + stay_id IS NULL」找回该行
 *      再回填 stay_id，所以只要把每一间的 room_id 写对，stay 关联自然成立；
 *   6. 主单镜像：只更新 bookings.room_id（COALESCE 保留已填的首间）与 status，
 *      **不动 room_count**（间数是订单原始属性，排房进度只看 booking_rooms）。
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

  /*
   * 去重（三条不同的维度，别合并）：
   *   · 同一间房一批里只能排一次 —— 排两次没有任何意义，还必然撞占房唯一索引；
   *   · 同一条明细只能排一次 —— 多房订单一次提交两间时，两行的 bookingId 相同，
   *     旧实现按 bookingId 去重会把第二间直接丢掉（BK-MULTI3 的 2 间只能排进 1 间）；
   *   · 老式主单级（不指明是哪一间）一单只保留一条 —— 否则两条主单级意向会抢同一条待排明细。
   */
  const seenRoom = new Set<number>();
  const seenUnit = new Set<string>();
  const seenMain = new Set<number>();
  const uniq: Pair[] = [];
  for (const p of pairs) {
    const unitKey =
      p.bookingRoomId > 0
        ? `br:${p.bookingRoomId}`
        : p.roomTypeId > 0 || p.unitIndex > 0
          ? `u:${p.bookingId}:${p.roomTypeId}:${p.unitIndex}`
          : `b:${p.bookingId}`;
    if (seenRoom.has(p.roomId) || seenUnit.has(unitKey)) continue;
    if (!isDetailLevel(p)) {
      if (seenMain.has(p.bookingId)) continue;
      seenMain.add(p.bookingId);
    }
    seenRoom.add(p.roomId);
    seenUnit.add(unitKey);
    uniq.push(p);
  }

  /** 实际落库的间数 / 跳过的间数 / 跳过的原因 */
  let savedCount = 0;
  let skippedCount = 0;
  const skippedNotes: string[] = [];

  try {
    tx(() => {
      const parts: string[] = [];

      for (const pair of uniq) {
        /* ---------- 1. 订单：不再要求「主单 room_id 为空」 ---------- */
        const booking = get<BookingSnapshot>(BOOKING_SQL, [pair.bookingId, hotelId]);
        if (!booking) {
          throw new Error(
            `订单（ID ${pair.bookingId}）不存在，或状态已变更（可能已取消 / 已入住），请刷新后重试（整批未排）`
          );
        }

        /* ---------- 2. 定位要写的那一条明细（明细级 / 主单级） ---------- */
        const target = resolveTarget(hotelId, booking, pair);
        if (target.kind === "skip") {
          skippedCount += 1;
          if (skippedNotes.length < 5) skippedNotes.push(`${booking.booking_no} ${target.reason}`);
          continue;
        }

        /*
         * 明细自己的入离日期优先（跨房型 / 分段入住的订单，每间可能各排各的），
         * 没填日期就沿用主单区间 —— 与房态页、room-stock.ts 的兜底口径一致。
         */
        const checkIn = target.kind === "detail" && target.detail.check_in_date ? target.detail.check_in_date : booking.check_in_date;
        const checkOut = target.kind === "detail" && target.detail.check_out_date ? target.detail.check_out_date : booking.check_out_date;

        /* ---------- 3. 房间校验：空净/空脏 ---------- */
        const room = get<{ id: number; room_no: string; status: string; room_type_id: number }>(
          `SELECT id, room_no, status, room_type_id
             FROM rooms
            WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')`,
          [pair.roomId, hotelId]
        );
        if (!room) {
          throw new Error(`订单 ${booking.booking_no} 的房间（ID ${pair.roomId}）不是空净/空脏房（整批未排）`);
        }

        /*
         * ---------- 3a. 房型必须与明细一致（明细级） ----------
         * 主单级仍沿用旧口径：房型不同视为「升级排房」，允许并写进日志。
         * 明细级如果也放行，就会悄悄把客人订的房型换成别的房型（金额还是原价），
         * 所以这里有且只有「同房型」能过；要升级请走主单排房 / 改单流程。
         */
        if (isDetailLevel(pair)) {
          const wantTypeId =
            target.kind === "detail" ? (target.detail.room_type_id ?? booking.room_type_id) : booking.room_type_id;
          if (wantTypeId !== null && wantTypeId > 0 && room.room_type_id !== wantTypeId) {
            throw new Error(
              `房间 ${room.room_no} 的房型是「${roomTypeName(hotelId, room.room_type_id)}」，` +
                `而这间明细预订的是「${roomTypeName(hotelId, wantTypeId)}」：逐明细排房不能跨房型，` +
                `要升级房型请改用主单排房（整批未排）`
            );
          }
        }
        const upgraded = Boolean(booking.room_type_id && room.room_type_id !== booking.room_type_id);

        /* ---------- 3b. 区间冲突：在住占房 ---------- */
        const stayClash = get<{ c: number }>(
          `SELECT 1 AS c
             FROM stays s
            WHERE s.hotel_id = ? AND s.room_id = ? AND s.status = 'INHOUSE'
              AND substr(s.check_in_time, 1, 10) < ?
              AND (s.expect_check_out IS NULL OR s.expect_check_out > ?)
            LIMIT 1`,
          [hotelId, room.id, checkOut, checkIn]
        );
        if (stayClash) {
          throw new Error(
            `房间 ${room.room_no} 在 ${checkIn} 至 ${checkOut} 期间有在住客人（整批未排）`
          );
        }

        /* ---------- 3c. 区间冲突：其他订单主单镜像（历史数据兼容） ---------- */
        const bookingClash = get<{ c: number }>(
          `SELECT 1 AS c
             FROM bookings o
            WHERE o.hotel_id = ? AND o.room_id = ? AND o.id <> ?
              AND o.status IN ('PENDING','CONFIRMED','CHECKED_IN')
              AND o.check_in_date < ? AND o.check_out_date > ?
            LIMIT 1`,
          [hotelId, room.id, booking.id, checkOut, checkIn]
        );
        if (bookingClash) {
          throw new Error(
            `房间 ${room.room_no} 在 ${checkIn} 至 ${checkOut} 期间已被其他订单占用（整批未排）`
          );
        }

        /* ---------- 3d. 区间冲突：其他订单的明细（权威来源） ---------- */
        const detailClash = get<{ c: number }>(
          `SELECT 1 AS c
             FROM booking_rooms br
            WHERE br.hotel_id = ? AND br.room_id = ? AND br.booking_id <> ?
              AND br.status IN ('CONFIRMED','CHECKED_IN')
              AND br.check_in_date < ? AND br.check_out_date > ?
            LIMIT 1`,
          [hotelId, room.id, booking.id, checkOut, checkIn]
        );
        if (detailClash) {
          throw new Error(
            `房间 ${room.room_no} 在 ${checkIn} 至 ${checkOut} 期间已被其他订单的房间明细占用（整批未排）`
          );
        }

        /*
         * ---------- 3e. 区间冲突：本订单自己的其他明细（本次新补） ----------
         * 上面三条都带 booking_id <> ?，天然查不到「同一张单的另外几间」。
         * 多房订单把同一间房排给第 2、3 间时，冲突校验全过，
         * 最后撞 idx_booking_rooms_occupied(room_id, check_in_date, check_out_date)，
         * 用户只看到一句 UNIQUE constraint failed。这里提前挡住并给出人话。
         */
        const selfClash = get<{ c: number }>(
          `SELECT 1 AS c
             FROM booking_rooms br
            WHERE br.hotel_id = ? AND br.booking_id = ? AND br.room_id = ?
              AND br.status IN ('CONFIRMED','CHECKED_IN')
              AND br.check_in_date < ? AND br.check_out_date > ?
            LIMIT 1`,
          [hotelId, booking.id, room.id, checkOut, checkIn]
        );
        if (selfClash) {
          throw new Error(
            `房间 ${room.room_no} 已经排给本订单的另一间明细了，同一间房不能重复占用（整批未排）`
          );
        }

        /*
         * ---------- 3f. 乐观锁占位（整改 P1-1） ----------
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

        /* ---------- 4. 落库：写明细（明细级只写这一行） ---------- */
        if (target.kind === "detail") {
          run(`UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED' WHERE id = ? AND hotel_id = ?`, [
            room.id,
            target.detail.id,
            hotelId,
          ]);
        } else {
          /* 迁移前的历史订单：一条明细都没有，按主单信息补一条（room_count 容量已在上面校验过） */
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

        /* ---------- 5. 主单镜像：只同步首间房号 + 状态，不动 room_count ---------- */
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

        savedCount += 1;
        parts.push(
          `${booking.booking_no}→${room.room_no}${upgraded ? "（升级房型）" : ""}${
            isDetailLevel(pair) ? "（明细）" : ""
          }`
        );
      }

      /* ---------- 6. 操作日志（只有真的排了房才写） ---------- */
      if (savedCount > 0) {
        run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
          hotelId,
          user.realName,
          "批量排房",
          `批量排房 ${savedCount} 间：${parts.join("、")}${
            skippedCount > 0 ? `；跳过 ${skippedCount} 间（已排房/已入住等）` : ""
          }`,
          nowIso(),
        ]);
      }
    });
  } catch (e) {
    /* tx 内部已 ROLLBACK（见 lib/db.ts），这里只把错误翻成人话 */
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("UNIQUE")) {
      return { error: "所选房间中有房间刚被其他订单占用（并发冲突），本批排房已全部取消，请刷新后重试" };
    }
    return { error: msg || "批量排房失败，请刷新后重试" };
  }

  /*
   * 全部被跳过：不写库也不报成功 —— 前台需要知道「点了保存但一间都没排」，
   * 否则会以为系统把房排好了，实际房态一点没变。
   */
  if (savedCount === 0) {
    return {
      error: `没有需要落库的排房：${skippedNotes.join("；") || "所选明细状态已变化"}。请刷新后重新选择`,
    };
  }

  revalidatePath("/rooms/forecast");
  revalidatePath("/bookings");
  revalidatePath("/rooms");
  revalidatePath("/dashboard");

  return { ok: true, savedCount, skippedCount };
}
