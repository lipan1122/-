import { all, get, run, tx } from "@/lib/db";
import { todayStr } from "@/lib/utils";

/**
 * 演示数据 · 按天均匀填充（lib 版）
 *
 * ── 为什么要有这个文件 ──
 *
 * `scripts/seed-uniform-demo.mjs` 是给命令行用的（直接开 `node:sqlite`）。
 * 但「一键导入演示数据」是个 Server Action，跑在 Next 运行时里，不能 spawn 脚本，
 * 所以逻辑抽到这里，两边共用同一份口径。
 *
 * ── 造什么 ──
 *
 * 从今天开始往前 N 天，每天：
 *   · 3 笔「已退房」（历史日）—— 当天入住、次日离店、账单结清
 *   · 今天额外：3 笔「在住」（今天入住，其中 1 笔今天预离）+ 3 笔「今日预抵」（未排房）
 *   · 1 笔「未来预订」（落在 今天+3+n，分散开，不会把 46 间库存打穿）
 *
 * ── 自洽 ──
 *
 *   folios.total_amount = SUM(folio_items.amount) WHERE item_type <> 'DEPOSIT'
 *   folios.paid_amount  = SUM(payments.amount)
 *   folios.balance      = total_amount − paid_amount
 *
 * 押金不计入 total（见 `lib/folio.ts` 的 NON_REVENUE_ITEM —— 押金是负债不是消费）。
 *
 * ── 幂等 ──
 *
 * 单号带 `DEMO-<日期>-` 前缀。已有该日 DEMO 单的日子会跳过（除非 force）。
 */

const HOTEL_FALLBACK = 1;

/** 日期字符串 +n 天（纯整数运算，不经过时区转换） */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 给一张 DEMO 预订补一条房间明细（booking_rooms）
 *
 * `test-booking-rooms` 要求「每条有效预订都有房间明细」，缺了会红两个测试：
 *   · test-booking-rooms「每条有效预订都有房间明细」
 *   · test-booking-p1「migrate-all --check 已是目标状态」
 *     （migrate-all 有一段迁移专门「为 N 条预订补 N 条房间明细」，缺明细就报待处理）
 *
 * 真实预订一定有这一行，DEMO 预订也必须补。
 */
function addBookingRooms(opts: {
  hotelId: number;
  bookingNo: string;
  roomTypeId: number;
  guestName: string;
  mobile: string | null;
  guestId: number;
  rate: number;
  status: string;
  checkIn: string;
  checkOut: string;
}): void {
  const bk = get<{ id: number }>(`SELECT id FROM bookings WHERE booking_no = ?`, [opts.bookingNo]);
  if (!bk) return;
  run(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, guest_id, created_at)
     VALUES (?,?,?,NULL,?,?,?, ?,?,?,?, ?)`,
    [
      opts.hotelId,
      bk.id,
      opts.roomTypeId,
      opts.guestName,
      opts.mobile,
      opts.rate,
      opts.status,
      opts.checkIn,
      opts.checkOut,
      opts.guestId,
      new Date().toISOString(),
    ]
  );
}

export type SeedResult = {
  ok?: string;
  error?: string;
  stays: number;
  folios: number;
  items: number;
  payments: number;
  bookings: number;
  skippedDays: number;
  /** 自洽校验不平的账单数（0 = 全平） */
  unbalanced: number;
};

type Plan = { day: string; stamp: number; kinds: { kind: string; idx: number }[] };

/**
 * 生成并写入均匀演示数据
 *
 * @param hotelId 酒店 id
 * @param days    往前多少天（含今天）
 * @param force   已有 DEMO 数据的日子也重造
 */
export function seedUniformDemo(hotelId: number, days = 60, force = false): SeedResult {
  const res: SeedResult = {
    stays: 0,
    folios: 0,
    items: 0,
    payments: 0,
    bookings: 0,
    skippedDays: 0,
    unbalanced: 0,
  };

  const today = todayStr();
  const stamp = Date.now();

  const roomTypes = all<{ id: number; base_price: number | null }>(
    `SELECT id, base_price FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );
  if (roomTypes.length === 0) return { ...res, error: "还没有房型，请先导入基础数据（房间/房型）" };

  /*
   * 可用房间：排除三类
   *   1. OOO(维修) / LOCK(锁房)
   *   2. 已有 INHOUSE 在住单的房间
   *   3. **挂着 PENDING 打扫任务的房间** —— 说明刚退房还没打扫完，
   *      造在住单占上去会让 test-checkin-rules 的「在住房间没有残留待打扫任务」红
   */
  const roomsByType = new Map<number, { id: number; room_no: string }[]>();
  for (const rt of roomTypes) {
    roomsByType.set(
      rt.id,
      all<{ id: number; room_no: string }>(
        `SELECT r.id, r.room_no FROM rooms r
          WHERE r.hotel_id = ? AND r.room_type_id = ?
            AND r.status NOT IN ('OOO','LOCK')
            AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'INHOUSE')
            AND NOT EXISTS (SELECT 1 FROM housekeeping h WHERE h.room_id = r.id AND h.status = 'PENDING')
          ORDER BY r.id`,
        [hotelId, rt.id]
      )
    );
  }

  const channels = all<{ id: number; name: string }>(
    `SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  /*
   * 可用客人：排除**已经有在住单的**
   *
   * 不排除会撞出「同一证件号 2 张在住单」（test-checkin-rules 的硬断言）。
   */
  const guestsInhouseFree = all<{ id: number; name: string; mobile: string | null }>(
    `SELECT g.id, g.name, g.mobile FROM guests g
      WHERE g.hotel_id = ?
        AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.guest_id = g.id AND s.status = 'INHOUSE')
      ORDER BY g.id`,
    [hotelId]
  );
  const guestsAll = all<{ id: number; name: string; mobile: string | null }>(
    `SELECT id, name, mobile FROM guests WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  const guests = guestsInhouseFree.length > 0 ? guestsInhouseFree : guestsAll;
  if (guests.length === 0) return { ...res, error: "还没有客史，请先导入基础数据（客人档案）" };

  for (let n = 0; n <= days; n++) {
    const day = shiftDay(today, -n);

    /* 该日已有 DEMO 单 → 幂等跳过 */
    if (!force) {
      const exists = Number(
        get<{ c: number }>(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND stay_no LIKE ?`, [
          hotelId,
          `DEMO-${day}-%`,
        ])?.c ?? 0
      );
      if (exists > 0) {
        res.skippedDays++;
        continue;
      }
    }

    const isToday = n === 0;
    const kinds: { kind: string; idx: number }[] = [];
    if (isToday) {
      for (let i = 0; i < 3; i++) kinds.push({ kind: "inhouse", idx: i });
      for (let i = 0; i < 3; i++) kinds.push({ kind: "arrival", idx: i });
    } else {
      for (let i = 0; i < 3; i++) kinds.push({ kind: "checked_out", idx: i });
      kinds.push({ kind: "booking", idx: 0 });
    }

    const outDay = shiftDay(day, 1);

    for (const p of kinds) {
      /* 挑一个有可用房间的房型（从偏好往后找，第一个有房的就用） */
      let rt: { id: number; base_price: number | null } | null = null;
      let pool: { id: number; room_no: string }[] = [];
      const prefer = (n + p.idx) % roomTypes.length;
      for (let k = 0; k < roomTypes.length; k++) {
        const cand = roomTypes[(prefer + k) % roomTypes.length];
        const candPool = roomsByType.get(cand.id) ?? [];
        if (candPool.length > 0) {
          rt = cand;
          pool = candPool;
          break;
        }
      }
      if (!rt) continue;

      const room = pool[(n * 3 + p.idx) % pool.length];
      /*
       * 客人：每张单必须不同（同一证件号 2 张在住单会被 test-checkin-rules 判红）
       * 用 (n*3 + idx)：同一天内 idx 0/1/2 落在 3 个不同偏移。
       */
      const guest = guests[(n * 3 + p.idx) % guests.length];
      const channel = channels.length ? channels[(n + p.idx) % channels.length] : null;
      const rate = Number(rt.base_price ?? 300);
      const nights = 1 + ((n + p.idx) % 3);
      const roomFee = round2(rate * nights);
      const otherFee = (n + p.idx) % 4 === 0 ? round2(20 + ((n * 7 + p.idx * 13) % 60)) : 0;
      const total = round2(roomFee + otherFee);

      try {
        tx(() => {
          if (p.kind === "checked_out") {
            const stayNo = `DEMO-${day}-S${p.idx + 1}-${stamp}`;
            run(
              `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, deposit, status, channel_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,0, 'CHECKED_OUT', ?)`,
              [
                hotelId,
                stayNo,
                room.id,
                guest.id,
                guest.name,
                guest.mobile,
                `${day}T14:0${p.idx}:00`,
                outDay,
                `${outDay}T12:00:00`,
                nights,
                rate,
                channel?.id ?? null,
              ]
            );
            const stayId = Number(get<{ id: number }>(`SELECT id FROM stays WHERE stay_no = ?`, [stayNo])?.id);

            const folioNo = `DEMO-${day}-F${p.idx + 1}-${stamp}`;
            run(
              `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at, settled_at)
               VALUES (?,?,?,?,?,?,?,0, 'SETTLED', ?, ?)`,
              [hotelId, folioNo, stayId, guest.name, room.room_no, total, total, `${outDay}T12:05:00`, `${outDay}T12:05:00`]
            );
            const folioId = Number(get<{ id: number }>(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo])?.id);

            run(
              `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
               VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
              [hotelId, folioId, `房费 ${nights} 晚`, nights, rate, roomFee, day, `${day}T14:0${p.idx}:30`]
            );
            if (otherFee > 0) {
              run(
                `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
                 VALUES (?,?, 'OTHER', '其他消费', 1, ?, ?, ?, ?)`,
                [hotelId, folioId, otherFee, otherFee, day, `${day}T20:00:00`]
              );
            }
            run(
              `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
               VALUES (?,?,?,?,?,?,?,?,?, '演示数据', 'ROOM_PAYMENT')`,
              [hotelId, folioId, stayId, `DEMO-P-${day}-${p.idx + 1}-${stamp}`, "现金", total, day, "退房结账", `${outDay}T12:05:00`]
            );
            run(
              `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, channel_id, created_at)
               VALUES (?,?,?,?,?,?,?,1,?,'CHECKED_OUT',?,?)`,
              [
                hotelId,
                `DEMO-${day}-B${p.idx + 1}-${stamp}`,
                guest.name,
                guest.mobile,
                rt.id,
                day,
                outDay,
                nights,
                channel?.id ?? null,
                `${shiftDay(day, -3)} 10:00:00`,
              ]
            );
            res.stays++;
            res.folios++;
            res.items += otherFee > 0 ? 2 : 1;
            res.payments++;
            res.bookings++;
            addBookingRooms({
              hotelId,
              bookingNo: `DEMO-${day}-B${p.idx + 1}-${stamp}`,
              roomTypeId: rt.id,
              guestName: guest.name,
              mobile: guest.mobile,
              guestId: guest.id,
              rate,
              status: "CHECKED_OUT",
              checkIn: day,
              checkOut: outDay,
            });
          } else if (p.kind === "inhouse") {
            /*
             * 在住：全部**今天入住**（押金流水的 biz_date 就是今天，报表有数）
             *   第 0 笔：今天预离
             *   第 1/2 笔：明天/后天离店
             */
            const checkIn = today;
            /* 离店日至少 +1 天：ci == co 是非法区间（test-room-availability 会抓） */
            const checkOut = shiftDay(today, 1 + p.idx);
            const stayNo = `DEMO-${day}-H${p.idx + 1}-${stamp}`;
            const deposit = round2(rate * nights);

            run(
              `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, deposit, status, channel_id)
               VALUES (?,?,?,?,?,?,?,?, NULL, ?,?,?, 'INHOUSE', ?)`,
              [
                hotelId,
                stayNo,
                room.id,
                guest.id,
                guest.name,
                guest.mobile,
                `${checkIn}T14:1${p.idx}:00`,
                checkOut,
                nights,
                rate,
                deposit,
                channel?.id ?? null,
              ]
            );
            const stayId = Number(get<{ id: number }>(`SELECT id FROM stays WHERE stay_no = ?`, [stayNo])?.id);
            run(`UPDATE rooms SET status = 'OC' WHERE id = ? AND hotel_id = ?`, [room.id, hotelId]);

            const folioNo = `DEMO-${day}-HF${p.idx + 1}-${stamp}`;
            run(
              `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
               VALUES (?,?,?,?,?,?,?,0, 'OPEN', ?)`,
              [hotelId, folioNo, stayId, guest.name, room.room_no, roomFee, roomFee, `${checkIn}T14:1${p.idx}:30`]
            );
            const folioId = Number(get<{ id: number }>(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo])?.id);
            run(
              `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
               VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
              [hotelId, folioId, `房费 ${nights} 晚`, nights, rate, roomFee, checkIn, `${checkIn}T14:1${p.idx}:30`]
            );
            run(
              `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
               VALUES (?,?, 'DEPOSIT', '押金', 1, ?, ?, ?, ?)`,
              [hotelId, folioId, deposit, deposit, checkIn, `${checkIn}T14:1${p.idx}:45`]
            );
            run(
              `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
               VALUES (?,?,?,?,?,?,?,?,?, '演示数据', 'DEPOSIT')`,
              [hotelId, folioId, stayId, `DEMO-HP-${day}-${p.idx + 1}-${stamp}`, "现金", deposit, checkIn, "预收款（押金）", `${checkIn}T14:1${p.idx}:45`]
            );
            res.stays++;
            res.folios++;
            res.items += 2;
            res.payments++;
          } else if (p.kind === "arrival") {
            /* 今日预抵：CONFIRMED、未排房 → 前台可直接办理入住测试 */
            run(
              `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, channel_id, created_at, remark)
               VALUES (?,?,?,?,?,?,?,1,?,'CONFIRMED',?,?, '演示数据·今日预抵')`,
              [
                hotelId,
                `DEMO-${day}-AR${p.idx + 1}-${stamp}`,
                guest.name,
                guest.mobile,
                rt.id,
                today,
                shiftDay(today, nights),
                nights,
                channel?.id ?? null,
                `${today}T08:30:00`,
              ]
            );
            res.bookings++;
            addBookingRooms({
              hotelId,
              bookingNo: `DEMO-${day}-AR${p.idx + 1}-${stamp}`,
              roomTypeId: rt.id,
              guestName: guest.name,
              mobile: guest.mobile,
              guestId: guest.id,
              rate,
              status: "CONFIRMED",
              checkIn: today,
              checkOut: shiftDay(today, nights),
            });
          } else {
            const arrivals = shiftDay(today, 3 + n);
            run(
              `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, channel_id, created_at)
               VALUES (?,?,?,?,?,?,?,1,?,'CONFIRMED',?,?)`,
              [
                hotelId,
                `DEMO-${day}-BQ${p.idx + 1}-${stamp}`,
                guest.name,
                guest.mobile,
                rt.id,
                arrivals,
                shiftDay(arrivals, nights),
                nights,
                channel?.id ?? null,
                `${day}T09:30:00`,
              ]
            );
            res.bookings++;
            addBookingRooms({
              hotelId,
              bookingNo: `DEMO-${day}-BQ${p.idx + 1}-${stamp}`,
              roomTypeId: rt.id,
              guestName: guest.name,
              mobile: guest.mobile,
              guestId: guest.id,
              rate,
              status: "CONFIRMED",
              checkIn: arrivals,
              checkOut: shiftDay(arrivals, nights),
            });
          }
        });
      } catch {
        /* 单笔失败不影响其他笔（房间可能刚被占用），继续下一笔 */
      }
    }
  }

  /* 自洽校验：total 排除 DEPOSIT（押金是负债，见 lib/folio.ts 的 NON_REVENUE_ITEM） */
  res.unbalanced = Number(
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM folios f
        WHERE f.hotel_id = ? AND f.folio_no LIKE 'DEMO-%'
          AND (ABS(f.total_amount - (SELECT COALESCE(SUM(amount),0) FROM folio_items
                                       WHERE folio_id = f.id AND item_type <> 'DEPOSIT')) > 0.01
            OR ABS(f.paid_amount - (SELECT COALESCE(SUM(amount),0) FROM payments WHERE folio_id = f.id)) > 0.01)`,
      [hotelId]
    )?.c ?? 0
  );

  res.ok =
    `补齐均匀演示数据（近 ${days + 1} 天，含今天）：\n` +
    `  新增 入住单 ${res.stays} / 账单 ${res.folios} / 明细 ${res.items} / 流水 ${res.payments} / 预订 ${res.bookings}\n` +
    `  跳过（已有 DEMO 数据）${res.skippedDays} 天\n` +
    `  自洽校验：${res.unbalanced === 0 ? "全部通过" : `${res.unbalanced} 张账单不平（请报障）`}`;

  return res;
}

/** 仅检查：报告会补多少天，不写库 */
export function inspectUniformDemo(hotelId: number, days = 60): { missing: number; covered: number } {
  const today = todayStr();
  let missing = 0;
  let covered = 0;
  for (let n = 0; n <= days; n++) {
    const day = shiftDay(today, -n);
    const c = Number(
      get<{ c: number }>(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND stay_no LIKE ?`, [
        hotelId,
        `DEMO-${day}-%`,
      ])?.c ?? 0
    );
    if (c > 0) covered++;
    else missing++;
  }
  return { missing, covered };
}

export { HOTEL_FALLBACK };
