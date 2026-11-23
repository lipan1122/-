import { all, get, run, tx } from "@/lib/db";
import { changeRoomStatus } from "@/lib/room-status";
import { nowIso, todayStr } from "@/lib/utils";

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
 *   · 3 笔「已退房」（历史日）—— 当天入住、住 nights 晚、账单结清
 *   · 今天额外：3 笔「在住」（今天入住，明天/后天/大后天离店）
 *               + 1 笔「昨日入住、今日预离」（演示「查预离 → 退房结账」不空列表）
 *               + 3 笔「今日预抵」（未排房）
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
 * ── 房态自愈 ──
 *
 * seed 造在住单时会直接把房间置成 OC，但**在住单被清掉时房态不会自己回滚**。
 * 旧批次 DEMO 在住单删了又重灌之后，房间里就留下「OC 却没有任何在住单」的孤儿房态：
 *   · `/rooms` 按 rooms.status 数在住（26 间），`/rooms/forecast` 按在住单数（24 间）
 *   · 两个页面差 2 间，可售库存也算错
 *
 * 所以每次 seed 开头先跑 `resetOrphanRoomStatus(hotelId)`，把没有在住单的住净/住脏房
 * 复位成 VC，并写 room_logs / op_logs。人工手工置成 OC 的房（room_logs 最后一笔是
 * 「手工 · …」）会跳过，不作为脏数据清掉。
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

/** 表是否存在（旧库可能还没建 room_logs / op_logs，日志缺失不能把主流程拖挂） */
function tableExists(name: string): boolean {
  return (
    Number(
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [name])?.n ?? 0
    ) > 0
  );
}

export type OrphanRoomResetResult = {
  /** 已复位成 VC 的房间（含复位前房态） */
  reset: { id: number; room_no: string; from: string }[];
  /** 判定为「人工置住净」而跳过复位的房间 */
  skippedManual: { id: number; room_no: string }[];
  /** 复位失败（房态流转被服务层拒绝）的房间 */
  failed: { id: number; room_no: string; error: string }[];
  /** 本次是否写了 op_logs 审计 */
  logged: boolean;
};

/**
 * 房态自愈：把「没有在住单、却还挂着 OC/OD」的房间复位成 VC（空净）
 *
 * 背景（chk-demo 实测）：
 *   旧批次 DEMO 在住单被清掉/重灌后，`rooms.status='OC'` 留在原处，
 *   于是真库出现 `OC 26 间 / INHOUSE 在住单 24 张`，房态页可售 17 间、
 *   远期房态页只认在住单算出 19 间 —— 两个页面直接对不上。
 *
 * 判定口径：
 *   · 孤儿 = `rooms.status IN ('OC','OD')` 且**没有任何 INHOUSE 在住单**；
 *   · 人工手工置成住净的房（room_logs 最后一笔 to_status 为 OC/OD 且 reason 以「手工」开头）
 *     视为人工意图，跳过不复位，避免把「人为留的住净房」清掉；
 *   · 复位走 `lib/room-status.ts` 的统一房态服务（校验流转 + 写 room_logs），
 *     最后写一条 op_logs 记录本次复位了几间。
 *
 * 导出给 `settings/demo-actions.ts` 复用（导入演示数据前也可以单独调一次）。
 */
export function resetOrphanRoomStatus(hotelId: number): OrphanRoomResetResult {
  const out: OrphanRoomResetResult = { reset: [], skippedManual: [], failed: [], logged: false };

  const orphans = all<{ id: number; room_no: string; status: string }>(
    `SELECT r.id, r.room_no, r.status FROM rooms r
      WHERE r.hotel_id = ?
        AND r.status IN ('OC','OD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.hotel_id = r.hotel_id AND s.room_id = r.id AND s.status = 'INHOUSE'
        )
      ORDER BY r.floor, r.room_no, r.id`,
    [hotelId]
  );
  if (orphans.length === 0) return out;

  const hasRoomLogs = tableExists("room_logs");

  for (const room of orphans) {
    /*
     * 尊重人工意图：最后一笔房态日志就是「手工」把房置成住净/住脏的，不算脏数据。
     * changeRoomStatus 写日志时 reason 形如 `手工 · 手动修改房态`。
     */
    if (hasRoomLogs) {
      const last = get<{ to_status: string; reason: string | null }>(
        `SELECT to_status, reason FROM room_logs
          WHERE hotel_id = ? AND room_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1`,
        [hotelId, room.id]
      );
      if (last && (last.to_status === "OC" || last.to_status === "OD") && /^手工/.test(last.reason ?? "")) {
        out.skippedManual.push({ id: room.id, room_no: room.room_no });
        continue;
      }
    }

    if (hasRoomLogs) {
      const r = changeRoomStatus({
        hotelId,
        roomId: room.id,
        to: "VC",
        operator: "演示数据",
        reason: "无在住单的住净房复位（seed-uniform 前置清理）",
        source: { kind: "manual" },
      });
      if (!r.ok) {
        out.failed.push({ id: room.id, room_no: room.room_no, error: r.error });
        continue;
      }
    } else {
      /* 旧库没有 room_logs：直接改房态，宁可少一条审计也不能让 seed 整体失败 */
      run(`UPDATE rooms SET status = 'VC' WHERE id = ? AND hotel_id = ?`, [room.id, hotelId]);
    }
    out.reset.push({ id: room.id, room_no: room.room_no, from: room.status });
  }

  if (out.reset.length > 0 && tableExists("op_logs")) {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      "演示数据",
      "演示数据·房态复位",
      `复位无在住单的住净/住脏房 ${out.reset.length} 间：` +
        out.reset.map((r) => `${r.room_no}(${r.from}→VC)`).join("、") +
        (out.skippedManual.length > 0
          ? `；跳过人工置住净 ${out.skippedManual.length} 间：${out.skippedManual.map((r) => r.room_no).join("、")}`
          : ""),
      nowIso(),
    ]);
    out.logged = true;
  }

  return out;
}

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
  /** 本轮房态自愈：复位了几间「OC/OD 却没有在住单」的房间 */
  roomsReset: number;
  /** 本轮房态自愈：因人工置住净而跳过的房间数 */
  roomsResetSkipped: number;
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
    roomsReset: 0,
    roomsResetSkipped: 0,
    unbalanced: 0,
  };

  const today = todayStr();
  const stamp = Date.now();

  /*
   * 第 0 步：房态自愈（必须在算可用房之前）
   *
   * 上一批 DEMO 在住单被清掉后，rooms.status 会留在 OC —— 这样的房间既不算在住
   * （没有在住单），却又不算可售（房态页按 status 数），会让 /rooms 与
   * /rooms/forecast 的可售数差出几间。这里先复位成 VC。
   */
  const roomCleanup = resetOrphanRoomStatus(hotelId);
  res.roomsReset = roomCleanup.reset.length;
  res.roomsResetSkipped = roomCleanup.skippedManual.length;

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

  /*
   * 本批次已经被在住单占掉的房间
   *
   * 今天要造 4 笔在住单（3 笔今天入住 + 1 笔昨日入住今日预离），而房型池里
   * 每个房型可能只剩 2~3 间房 —— 按 `(n*3 + idx) % pool.length` 取房间时
   * idx=0 和 idx=3 可能撞到同一间，同房两张在住单会让
   * test-room-availability 的「同房间不存在重叠的在住单」判红。
   */
  const usedRoomIds = new Set<number>();

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
      /*
       * 第 3 笔在住：**昨天 14:00 入住、今天预离**
       *
       * 为什么必须有这一笔：dashboard 的「今日预离」和 /today-todo 的预离列表都按
       * `stays.expect_check_out = today AND status='INHOUSE'` 取数。上面 3 笔都是
       * 今天入住（check_out = 明天/后天/大后天），于是「今日预离」永远是 0 张，
       * 演示「查预离 → 退房结账」时列表是空的。
       *
       * 注意不能直接把上面那 3 笔的 check_out 改成今天 —— check_in == check_out
       * 是非法区间（ci == co），test-room-availability 会判红。
       * 正确做法是单独造一笔「昨天入住、今天离店」的单：区间合法（昨天 < 今天），
       * 押金 / 账单 / 流水照常造，押金的 biz_date 落在**昨天**（钱是昨天收的）。
       */
      kinds.push({ kind: "inhouse", idx: 3 });
      for (let i = 0; i < 3; i++) kinds.push({ kind: "arrival", idx: i });
    } else {
      for (let i = 0; i < 3; i++) kinds.push({ kind: "checked_out", idx: i });
      kinds.push({ kind: "booking", idx: 0 });
    }

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
            /*
             * 已退房：入住日 + nights = 离店日（方案 A）
             *
             * 上一版 nights 取 1~3，但 actual_check_out 固定 = 入住日 + 1：
             * 180 张 DEMO 已退房单里 120 张「账单写房费 3 晚、日期只跨 1 天」，
             * 预订列表拿 check_in_date / check_out_date 一算就露馅。
             *
             * 现在让离店日跟着 nights 走，账单写几晚就住几晚。
             * 唯一约束：已退房单的离店日不能落到未来，所以「n 天前入住」最多住 n 晚
             * （n=1 只住 1 晚；n>=3 保持原来的 1~3 晚不变）。
             */
            const stayNights = Math.min(nights, Math.max(1, n));
            const stayRoomFee = round2(rate * stayNights);
            const stayTotal = round2(stayRoomFee + otherFee);
            const checkOutDay = shiftDay(day, stayNights);
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
                checkOutDay,
                `${checkOutDay}T12:00:00`,
                stayNights,
                rate,
                channel?.id ?? null,
              ]
            );
            const stayId = Number(get<{ id: number }>(`SELECT id FROM stays WHERE stay_no = ?`, [stayNo])?.id);

            const folioNo = `DEMO-${day}-F${p.idx + 1}-${stamp}`;
            run(
              `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at, settled_at)
               VALUES (?,?,?,?,?,?,?,0, 'SETTLED', ?, ?)`,
              [hotelId, folioNo, stayId, guest.name, room.room_no, stayTotal, stayTotal, `${checkOutDay}T12:05:00`, `${checkOutDay}T12:05:00`]
            );
            const folioId = Number(get<{ id: number }>(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo])?.id);

            run(
              `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
               VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
              [hotelId, folioId, `房费 ${stayNights} 晚`, stayNights, rate, stayRoomFee, day, `${day}T14:0${p.idx}:30`]
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
              [hotelId, folioId, stayId, `DEMO-P-${day}-${p.idx + 1}-${stamp}`, "现金", stayTotal, day, "退房结账", `${checkOutDay}T12:05:00`]
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
                checkOutDay,
                stayNights,
                channel?.id ?? null,
                /* created_at 统一用带 T 的 ISO：mjs 版以前写成 `YYYY-MM-DD 10:00:00`（空格），两版漂移 */
                `${shiftDay(day, -3)}T10:00:00`,
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
              checkOut: checkOutDay,
            });
          } else if (p.kind === "inhouse") {
            /*
             * 在住（只有今天这一批）
             *
             *   第 0/1/2 笔：**今天入住**，明天/后天/大后天离店
             *                 （押金流水的 biz_date = 今天，报表有数）
             *   第 3 笔：**昨天 14:00 入住、今天预离**
             *                 （dashboard「今日预离」/ /today-todo 预离演示不再空列表；
             *                  押金是昨天收的，biz_date / created_at 都落在昨天）
             *
             * 离店日必须晚于入住日：ci == co 是非法区间（test-room-availability 会抓），
             * 所以不能靠「今天入住今天离店」来造预离。
             */
            const dueOut = p.idx === 3;
            const checkIn = dueOut ? shiftDay(today, -1) : today;
            const checkOut = dueOut ? today : shiftDay(today, 1 + p.idx);
            const stayNo = `DEMO-${day}-H${p.idx + 1}-${stamp}`;
            const deposit = round2(rate * nights);
            /* 同批次在住单不撞房（房型池可能只剩 2 间，idx=0 和 idx=3 会取到同一间） */
            const stayRoom = pool.find((r) => !usedRoomIds.has(r.id)) ?? room;
            usedRoomIds.add(stayRoom.id);

            run(
              `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, deposit, status, channel_id)
               VALUES (?,?,?,?,?,?,?,?, NULL, ?,?,?, 'INHOUSE', ?)`,
              [
                hotelId,
                stayNo,
                stayRoom.id,
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
            run(`UPDATE rooms SET status = 'OC' WHERE id = ? AND hotel_id = ?`, [stayRoom.id, hotelId]);

            const folioNo = `DEMO-${day}-HF${p.idx + 1}-${stamp}`;
            run(
              `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
               VALUES (?,?,?,?,?,?,?,0, 'OPEN', ?)`,
              [hotelId, folioNo, stayId, guest.name, stayRoom.room_no, roomFee, roomFee, `${checkIn}T14:1${p.idx}:30`]
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
    (res.roomsReset > 0
      ? `  房态自愈：复位 ${res.roomsReset} 间「没有在住单却还是 OC/OD」的房间 → VC` +
        (res.roomsResetSkipped > 0 ? `（跳过人工置住净 ${res.roomsResetSkipped} 间）` : "") +
        `\n`
      : "") +
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
