/**
 * 演示数据 · 按天均匀填充（从今天往前 N 天）
 *
 * 背景：原来的演示数据日期很不均匀 —— 近 30 天里 7 天没有任何账单、
 * 5 天没有任何流水，而 11-14 一天就有 19 张账单、11-15 一天 25 笔流水。
 * 演示时点进「统计报表」某一天，经常看到空白。
 *
 * 这个脚本**从今天开始往前**每天补一批完整业务链：
 *   预订 → 入住 → 账单 → 明细 → 收款
 * 让任何一天点进去都有数据，并且数字自洽（账实相符）。
 *
 * ── 每天造什么 ──
 *   · 3 笔「已退房」（当天入住、住 nights 晚、账单已结清）
 *   · 今天额外：3 笔「在住」（今天入住，明天/后天/大后天离店）
 *               + 1 笔「昨日入住、今日预离」（演示「查预离 → 退房结账」不空列表）
 *               + 3 笔「今日预抵」（未排房）
 *   · 1 笔「未来预订」（落在 今天+3+n，覆盖未来入住）
 *
 * ── 房态自愈 ──
 *   造在住单时会把房间直接置成 OC，但**在住单被清掉时房态不会自己回滚**。
 *   旧批次 DEMO 在住单删了又重灌之后，会留下「OC 却没有在住单」的孤儿房态：
 *   /rooms 按 rooms.status 数在住（26 间）、/rooms/forecast 按在住单数（24 间），
 *   两个页面直接差 2 间。所以每次 seed 前先跑 resetOrphanRoomStatus：
 *   把没有在住单的 OC/OD 房复位成 VC，写 room_logs / op_logs；
 *   人工手工置成 OC 的房（room_logs 最后一笔是「手工 · …」）跳过不动。
 *
 * ── 自洽约束（脚本内逐条保证）──
 *   folios.total_amount  = SUM(folio_items.amount)
 *   folios.paid_amount   = SUM(payments.amount)
 *   folios.balance       = total_amount − paid_amount
 *   folios.status        = balance ≈ 0 ? 'SETTLED' : 'OPEN'
 *   payments.kind        = 'ROOM_PAYMENT'（房费）/ 'DEPOSIT'（押金）
 *
 * ── 幂等 ──
 *   用 `stay_no` 前缀 `DEMO-` + 日期 + 序号做唯一标识，重复跑不会重复插入。
 *   已有 `DEMO-` 单的日期会跳过（除非 --force 指定某天）。
 *
 * 用法：
 *   node scripts/seed-uniform-demo.mjs              # 默认补最近 60 天
 *   node scripts/seed-uniform-demo.mjs --days 90    # 补 90 天
 *   node scripts/seed-uniform-demo.mjs --check      # 只报告会补多少，不写库
 *   node scripts/seed-uniform-demo.mjs --force      # 已有数据的天也补一遍
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbPath = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const FORCE = args.includes("--force");
const daysArg = args.indexOf("--days");
const DAYS = daysArg >= 0 ? Number(args[daysArg + 1]) : 60;

if (!existsSync(dbPath)) {
  console.error(`❌ 数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const HOTEL = 1;
const today = one(`SELECT date('now','localtime') AS d`).d;

/** 日期加减（纯字符串运算，不经过 Date 时区） */
function shift(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** 表是否存在（旧库可能还没建 room_logs / op_logs） */
function tableExists(name) {
  return one(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).n > 0;
}

/**
 * 房态自愈：把「没有在住单、却还挂着 OC/OD」的房间复位成 VC（空净）
 *
 * 与 `src/lib/seed-uniform.ts` 的 resetOrphanRoomStatus 同一口径（两版必须一致）：
 *   · 孤儿 = rooms.status IN ('OC','OD') 且没有任何 INHOUSE 在住单
 *   · room_logs 最后一笔 to_status 为 OC/OD 且 reason 以「手工」开头的 → 人工意图，跳过
 *   · 其余复位成 VC，写 room_logs，最后写一条 op_logs 记录复位了几间
 *
 * @param {boolean} dryRun --check 模式只统计不写库
 */
function resetOrphanRoomStatus(dryRun = false) {
  const out = { reset: [], skippedManual: [], failed: [], logged: false };

  const orphans = all(
    `SELECT r.id, r.room_no, r.status FROM rooms r
      WHERE r.hotel_id = ?
        AND r.status IN ('OC','OD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.hotel_id = r.hotel_id AND s.room_id = r.id AND s.status = 'INHOUSE'
        )
      ORDER BY r.floor, r.room_no, r.id`,
    [HOTEL]
  );
  if (orphans.length === 0) return out;

  const hasRoomLogs = tableExists("room_logs");

  for (const room of orphans) {
    if (hasRoomLogs) {
      const last = one(
        `SELECT to_status, reason FROM room_logs
          WHERE hotel_id = ? AND room_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1`,
        [HOTEL, room.id]
      );
      if (last && (last.to_status === "OC" || last.to_status === "OD") && /^手工/.test(last.reason ?? "")) {
        out.skippedManual.push({ id: room.id, room_no: room.room_no });
        continue;
      }
    }

    if (!dryRun) {
      if (hasRoomLogs) {
        run(`UPDATE rooms SET status = 'VC' WHERE id = ? AND hotel_id = ?`, [room.id, HOTEL]);
        run(
          `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [
            HOTEL,
            room.id,
            room.status,
            "VC",
            "手工 · 无在住单的住净房复位（seed-uniform 前置清理）",
            "演示数据",
            new Date().toISOString(),
          ]
        );
      } else {
        /* 旧库没有 room_logs：直接改房态，审计缺失不能把 seed 拖挂 */
        run(`UPDATE rooms SET status = 'VC' WHERE id = ? AND hotel_id = ?`, [room.id, HOTEL]);
      }
    }
    out.reset.push({ id: room.id, room_no: room.room_no, from: room.status });
  }

  if (!dryRun && out.reset.length > 0 && tableExists("op_logs")) {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      HOTEL,
      "演示数据",
      "演示数据·房态复位",
      `复位无在住单的住净/住脏房 ${out.reset.length} 间：` +
        out.reset.map((r) => `${r.room_no}(${r.from}→VC)`).join("、") +
        (out.skippedManual.length > 0
          ? `；跳过人工置住净 ${out.skippedManual.length} 间：${out.skippedManual.map((r) => r.room_no).join("、")}`
          : ""),
      new Date().toISOString(),
    ]);
    out.logged = true;
  }

  return out;
}

/* ─────────── 准备：房间 / 房型 / 渠道 / 客人 ─────────── */
/* 第 0 步：房态自愈（必须在算可用房之前；--check 只统计不写库） */
const roomCleanup = resetOrphanRoomStatus(CHECK);
const roomTypes = all(
  `SELECT rt.id, rt.base_price, (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS cnt
     FROM room_types rt WHERE rt.hotel_id = ? ORDER BY rt.sort`,
  [HOTEL]
);
if (roomTypes.length === 0) {
  console.error("❌ 没有房型，请先导入基础数据");
  process.exit(1);
}

/*
 * 可用房间：排除三类
 *
 *   1. OOO(维修) / LOCK(锁房) —— 不能卖
 *   2. **已经有 INHOUSE 在住单的房间** —— 这间房现在有客人
 *   3. **挂着 PENDING 打扫任务的房间** —— 说明它刚从脏态出来还没打扫完，
 *      造在住单占上去会让 test-checkin-rules 的
 *      「在住房间没有残留待打扫任务」直接红
 */
const roomsByType = new Map();
for (const rt of roomTypes) {
  roomsByType.set(
    rt.id,
    all(
      `SELECT id, room_no FROM rooms r
        WHERE r.hotel_id = ? AND r.room_type_id = ?
          AND r.status NOT IN ('OOO','LOCK')
          AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'INHOUSE')
          AND NOT EXISTS (SELECT 1 FROM housekeeping h WHERE h.room_id = r.id AND h.status = 'PENDING')
        ORDER BY r.id`,
      [HOTEL, rt.id]
    )
  );
}

/*
 * 本批次已经被在住单占掉的房间
 *
 * 今天要造 4 笔在住单（3 笔今天入住 + 1 笔昨日入住今日预离），而每个房型的
 * 可用池可能只剩 2~3 间 —— 按 `(n*3 + idx) % pool.length` 取房时 idx=0 和 idx=3
 * 可能撞到同一间，同房两张在住单会让 test-room-availability 的
 * 「同房间不存在重叠的在住单」判红。取房时跳过已占的房。
 */
const usedRoomIds = new Set();

const channels = all(`SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`, [HOTEL]);

/*
 * 可用的客人：排除**已经有在住单的**
 *
 * 不排除会撞出「同一证件号 2 张在住单」（test-checkin-rules 的硬断言）。
 * 上一版真撞了：SI1107 杨燕茨 + DEMO-H1 杨燕茨、SI1104 邹敏 + DEMO-H2 邹敏。
 */
const guests = all(
  `SELECT id, name, mobile FROM guests g
    WHERE g.hotel_id = ?
      AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.guest_id = g.id AND s.status = 'INHOUSE')
    ORDER BY g.id`,
  [HOTEL]
);
/* 万一全被占了（极端情况），退回全部客人 —— 宁可撞也不能造不出数据 */
const guestsAll = all(`SELECT id, name, mobile FROM guests WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
const guestPool = guests.length > 0 ? guests : guestsAll;
if (guestPool.length === 0) {
  console.error("❌ 没有客史，请先导入基础数据");
  process.exit(1);
}

/** 流水号发生器（避免和现有单号撞） */
function nextNo(prefix, table, col, hotelId = HOTEL) {
  const row = one(`SELECT ${col} AS no FROM ${table} WHERE hotel_id = ? AND ${col} LIKE ? ORDER BY id DESC LIMIT 1`, [
    hotelId,
    `${prefix}%`,
  ]);
  let n = 0;
  if (row?.no) {
    const tail = String(row.no).slice(prefix.length);
    const num = Number(tail);
    if (Number.isFinite(num)) n = num;
  }
  return n;
}

/* ─────────── 主循环 ─────────── */
let created = { stays: 0, folios: 0, items: 0, payments: 0, bookings: 0 };
let skippedDays = 0;
const plan = [];

const stamp = Date.now();

for (let n = 0; n <= DAYS; n++) {
  const day = shift(today, -n);

  /* 该日已有 DEMO 单？幂等跳过 */
  const existing = one(
    `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND stay_no LIKE ?`,
    [HOTEL, `DEMO-${day}-%`]
  ).c;
  if (existing > 0 && !FORCE) {
    skippedDays++;
    continue;
  }

  /*
   * 今天 vs 历史：造的单类型不同
   *
   * ⚠️ 这是上一版最严重的 bug：
   *   上一版不分今天/历史，每天都造「check_in = 当天、check_out = 次日、状态 CHECKED_OUT」。
   *   于是**今天入住的单当天就退房了**，结果：
   *     · 远期房态今天这一列没有任何块（已退房不占房）
   *     · 今日在住 0 张、今日预抵 0 张
   *     · 用户点进今天：「怎么一条数据都没有」
   *
   * 现在的分工：
   *   · 今天（n=0）：造「在住」（3 笔今天入住，明天/后天/大后天离店）
   *                 +「1 笔昨日入住、今日预离」+「今日预抵」（CONFIRMED、未排房）
   *   · 历史（n>=1）：造「已退房」（当天入住、住 nights 晚、账单结清）
   */
  const isToday = n === 0;
  const plans = [];
  if (isToday) {
    /* 今天：3 笔在住 + 1 笔昨日入住今日预离 + 3 笔今日预抵 */
    for (let i = 0; i < 3; i++) plans.push({ kind: "inhouse", idx: i });
    /*
     * 第 3 笔在住：**昨天 14:00 入住、今天预离**
     *
     * dashboard 的「今日预离」和 /today-todo 的预离列表按
     * `stays.expect_check_out = today AND status='INHOUSE'` 取数。上面 3 笔都是
     * 今天入住（离店在明天/后天/大后天），于是「今日预离」永远是 0 张，
     * 演示「查预离 → 退房结账」时列表是空的。
     *
     * 不能直接把上面 3 笔的离店改成今天 —— check_in == check_out 是非法区间
     * （ci == co，test-room-availability 会判红）。所以单独造一笔昨天入住的：
     * 区间合法（昨天 < 今天），押金 / 账单 / 流水照常，押金的 biz_date 落在**昨天**。
     */
    plans.push({ kind: "inhouse", idx: 3 });
    for (let i = 0; i < 3; i++) plans.push({ kind: "arrival", idx: i });
  } else {
    /*
     * 历史：3 笔已退房 + 1 笔未来预订
     *
     * ⚠️ 未来预订**必须分散**，不能让每天那笔都堆在「未来 1~7 天」：
     *   上一版每天造 2 笔、都落在今天+1~+7，跑几遍后未来一周堆了 900+ 条未排房预订，
     *   而酒店只有 46 间房 → physicalSellable 变成 -45，远期房态整列「可售 0 间」。
     *
     * 现在每笔落在「今天 + 3 + n」上（n 是往前第几天），61 天覆盖到未来 60 天，
     * 每天只有 1 条，永远不会把库存打穿。
     */
    for (let i = 0; i < 3; i++) plans.push({ kind: "checked_out", idx: i });
    plans.push({ kind: "booking", idx: 0 });
  }
  plan.push({ day, count: plans.length });

  if (CHECK) continue;

  for (const p of plans) {
    /*
     * 挑一个有可用房间的房型
     *
     * ⚠️ 上一版是「先按 (n + idx) % 房型数 挑一个房型，如果它没房就 continue」，
     * 结果某些日期直接少造了单（183 → 129）。正确做法是**从偏好的房型开始往后找**，
     * 第一个有可用房间的就用。
     */
    let rt = null;
    let pool = [];
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
    if (!rt) continue; // 全店一个空房都没有（正常营业时不会发生）
    const room = pool[(n * 3 + p.idx) % pool.length];
    /*
     * 客人：每张单必须**不同**（同一证件号 2 张在住单会被 test-checkin-rules 判红）
     *
     * 用 `(n*3 + idx)`：同一天内 idx 0/1/2 落在 3 个不同偏移，
     * 且跨天的偏移步长是 3（和每天的计划数一致），不会撞回同一客人。
     */
    const guest = guestPool[(n * 3 + p.idx) % guestPool.length];
    const channel = channels.length ? channels[(n + p.idx) % channels.length] : null;
    const rate = Number(rt.base_price ?? 300);
    const nights = 1 + ((n + p.idx) % 3); // 1~3 晚
    const roomFee = round2(rate * nights);
    const otherFee = (n + p.idx) % 4 === 0 ? round2(20 + ((n * 7 + p.idx * 13) % 60)) : 0;
    const total = round2(roomFee + otherFee);

    try {
      db.exec("BEGIN");

      if (p.kind === "checked_out") {
        /* ---- 已退房：入住单 + 账单 + 明细 + 收款 ---- */
        /*
         * 方案 A：入住日 + nights = 离店日（账单写几晚就真的住几晚）
         *
         * 上一版 nights 取 1~3，但 actual_check_out 固定 = 入住日 + 1：
         * 180 张 DEMO 已退房单里 120 张「账单写房费 3 晚、日期只跨 1 天」，
         * 预订列表拿 check_in_date / check_out_date 一算就露馅。
         *
         * 唯一约束：已退房单的离店日不能落到未来，所以「n 天前入住」最多住 n 晚
         * （n=1 只住 1 晚；n>=3 保持原来的 1~3 晚不变）。
         */
        const stayNights = Math.min(nights, Math.max(1, n));
        const stayRoomFee = round2(rate * stayNights);
        const stayTotal = round2(stayRoomFee + otherFee);
        const checkOutDay = shift(day, stayNights);
        const stayNo = `DEMO-${day}-S${p.idx + 1}-${stamp}`;
        run(
          `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, deposit, status, channel_id, booking_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'CHECKED_OUT', ?, NULL)`,
          [
            HOTEL,
            stayNo,
            room.id,
            guest.id,
            guest.name,
            guest.mobile ?? null,
            `${day}T14:0${p.idx}:00`,
            checkOutDay,
            `${checkOutDay}T12:00:00`,
            stayNights,
            rate,
            /*
             * ⚠️ deposit 必须是 0 —— 这张单已经退房了
             *
             * 上一版这里写的是 `round2(rate * nights)`（按应收当押金），
             * 于是 180 张 DEMO 已退房单全部残留押金 ¥114,350。
             * 这正好又把「退房后 stays.deposit 必须归零」那条不变量破坏了 ——
             * 而那条不变量是这一轮刚修好的（checkoutAction 无条件冲销 + 迁移脚本清零）。
             *
             * 演示数据是直接 INSERT 成 CHECKED_OUT 的，不走 checkoutAction，
             * 所以必须在这里就把 deposit 设成 0，否则就是「凭空造出一笔已退房却还压着押金的单」。
             */
            0,
            channel?.id ?? null,
          ]
        );
        const stayId = one(`SELECT id FROM stays WHERE stay_no = ?`, [stayNo]).id;

        const folioNo = `DEMO-${day}-F${p.idx + 1}-${stamp}`;
        run(
          `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at, settled_at)
           VALUES (?,?,?,?,?,?,?,?, 'SETTLED', ?, ?)`,
          [HOTEL, folioNo, stayId, guest.name, room.room_no, stayTotal, stayTotal, 0, `${checkOutDay}T12:05:00`, `${checkOutDay}T12:05:00`]
        );
        const folioId = one(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo]).id;

        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
           VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
          [HOTEL, folioId, `房费 ${stayNights} 晚`, stayNights, rate, stayRoomFee, day, `${day}T14:0${p.idx}:30`]
        );
        if (otherFee > 0) {
          run(
            `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
             VALUES (?,?, 'OTHER', '其他消费', 1, ?, ?, ?, ?)`,
            [HOTEL, folioId, otherFee, otherFee, day, `${day}T20:00:00`]
          );
        }

        run(
          `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
           VALUES (?,?,?,?,?,?,?,?,?, '演示数据', 'ROOM_PAYMENT')`,
          [HOTEL, folioId, stayId, `DEMO-P-${day}-${p.idx + 1}-${stamp}`, "现金", stayTotal, day, "退房结账", `${checkOutDay}T12:05:00`]
        );

        created.stays++;
        created.folios++;
        created.items += otherFee > 0 ? 2 : 1;
        created.payments++;

        /* ---- 预订：已退房（走完整个生命周期） ---- */
        run(
          `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, channel_id, created_at)
           VALUES (?,?,?,?,?,?,?,1,?,'CHECKED_OUT',?,?)`,
          [
            HOTEL,
            `DEMO-${day}-B${p.idx + 1}-${stamp}`,
            guest.name,
            guest.mobile ?? null,
            rt.id,
            day,
            checkOutDay,
            stayNights,
            channel?.id ?? null,
            `${shift(day, -3)}T10:00:00`,
          ]
        );
        created.bookings++;
        /*
         * 补房间明细（booking_rooms）
         *
         * `test-booking-rooms` 要求「每条有效预订都有房间明细」，
         * 缺了会导致两个红灯：
         *   · test-booking-rooms「每条有效预订都有房间明细」
         *   · test-booking-p1「migrate-all --check 已是目标状态」
         *     （migrate-all 有一段迁移专门「为 N 条预订补 N 条房间明细」，缺明细就会报待处理）
         *
         * 真实预订一定有这一行；DEMO 预订也必须补。
         */
        const bkId = one(`SELECT id FROM bookings WHERE booking_no = ?`, [`DEMO-${day}-B${p.idx + 1}-${stamp}`])?.id;
        if (bkId) {
          run(
            `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, guest_id, created_at)
             VALUES (?,?,?,NULL,?,?,?, 'CHECKED_OUT', ?,?,?, ?)`,
            [HOTEL, bkId, rt.id, guest.name, guest.mobile, rate, day, checkOutDay, guest.id, new Date().toISOString()]
          );
        }
      } else if (p.kind === "inhouse") {
        /*
         * ---- 在住（只造「今天」这一批）----
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
        const checkIn = dueOut ? shift(today, -1) : today;
        const checkOut = dueOut ? today : shift(today, 1 + p.idx);
        const stayNo = `DEMO-${day}-H${p.idx + 1}-${stamp}`;
        const deposit = round2(rate * nights);
        /* 同批次在住单不撞房（房型池可能只剩 2 间，idx=0 和 idx=3 会取到同一间） */
        const stayRoom = pool.find((r) => !usedRoomIds.has(r.id)) ?? room;
        usedRoomIds.add(stayRoom.id);

        run(
          `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, deposit, status, channel_id, booking_id)
           VALUES (?,?,?,?,?,?,?,?, NULL, ?,?,?, 'INHOUSE', ?, NULL)`,
          [
            HOTEL,
            stayNo,
            stayRoom.id,
            guest.id,
            guest.name,
            guest.mobile ?? null,
            `${checkIn}T14:1${p.idx}:00`,
            checkOut,
            nights,
            rate,
            deposit,
            channel?.id ?? null,
          ]
        );
        const stayId = one(`SELECT id FROM stays WHERE stay_no = ?`, [stayNo]).id;

        /* 房间置 OC（在住） */
        run(`UPDATE rooms SET status = 'OC' WHERE id = ? AND hotel_id = ?`, [stayRoom.id, HOTEL]);

        /* 押金已收（kind=DEPOSIT），账单还是 OPEN（客人还没退房结账） */
        const folioNo = `DEMO-${day}-HF${p.idx + 1}-${stamp}`;
        run(
          `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
           VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?)`,
          [HOTEL, folioNo, stayId, guest.name, stayRoom.room_no, roomFee, roomFee, 0, `${checkIn}T14:1${p.idx}:30`]
        );
        const folioId = one(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo]).id;
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
           VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
          [HOTEL, folioId, `房费 ${nights} 晚`, nights, rate, roomFee, checkIn, `${checkIn}T14:1${p.idx}:30`]
        );
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
           VALUES (?,?, 'DEPOSIT', '押金', 1, ?, ?, ?, ?)`,
          [HOTEL, folioId, deposit, deposit, checkIn, `${checkIn}T14:1${p.idx}:45`]
        );
        run(
          `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
           VALUES (?,?,?,?,?,?,?,?,?, '演示数据', 'DEPOSIT')`,
          [HOTEL, folioId, stayId, `DEMO-HP-${day}-${p.idx + 1}-${stamp}`, "现金", deposit, checkIn, "预收款（押金）", `${checkIn}T14:1${p.idx}:45`]
        );

        created.stays++;
        created.folios++;
        created.items += 2;
        created.payments++;
      } else if (p.kind === "arrival") {
        /*
         * ---- 今日预抵（只造「今天」这一批）----
         *
         * check_in_date = 今天、状态 CONFIRMED、**不排房**（room_id 空）→
         * 房态页的「今日预抵」和远期房态今天列的「待分房」都能看到。
         * 也可以直接在前台「办理入住」里选它测试，不用自己新建预订。
         */
        run(
          `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, channel_id, created_at, remark)
           VALUES (?,?,?,?,?,?,?,1,?,'CONFIRMED',?,?, '演示数据·今日预抵')`,
          [
            HOTEL,
            `DEMO-${day}-AR${p.idx + 1}-${stamp}`,
            guest.name,
            guest.mobile ?? null,
            rt.id,
            today,
            shift(today, nights),
            nights,
            channel?.id ?? null,
            `${today}T08:30:00`,
          ]
        );
        created.bookings++;
        /* 今日预抵也要有房间明细（同「已退房」分支的理由） */
        const arId = one(`SELECT id FROM bookings WHERE booking_no = ?`, [`DEMO-${day}-AR${p.idx + 1}-${stamp}`])?.id;
        if (arId) {
          run(
            `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, guest_id, created_at)
             VALUES (?,?,?,NULL,?,?,?, 'CONFIRMED', ?,?,?, ?)`,
            [HOTEL, arId, rt.id, guest.name, guest.mobile, rate, today, shift(today, nights), guest.id, new Date().toISOString()]
          );
        }
      } else {
        /*
         * ---- 未来预订：每天 1 条，分散到「今天 + 3 + n」----
         *
         * n 是「往前第几天」，所以 61 天的数据会覆盖今天+3 到 今天+63，
         * 每天恰好 1 条未排房预订（1 间），不会把 46 间的库存打穿。
         */
        const arrivals = shift(today, 3 + n);
        run(
          `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, channel_id, created_at)
           VALUES (?,?,?,?,?,?,?,1,?,'CONFIRMED',?,?)`,
          [
            HOTEL,
            `DEMO-${day}-BQ${p.idx + 1}-${stamp}`,
            guest.name,
            guest.mobile ?? null,
            rt.id,
            arrivals,
            shift(arrivals, nights),
            nights,
            channel?.id ?? null,
            `${day}T09:30:00`,
          ]
        );
        created.bookings++;
        /* 未来预订也要有房间明细（同「已退房」分支的理由） */
        const bqId = one(`SELECT id FROM bookings WHERE booking_no = ?`, [`DEMO-${day}-BQ${p.idx + 1}-${stamp}`])?.id;
        if (bqId) {
          run(
            `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, guest_id, created_at)
             VALUES (?,?,?,NULL,?,?,?, 'CONFIRMED', ?,?,?, ?)`,
            [HOTEL, bqId, rt.id, guest.name, guest.mobile, rate, arrivals, shift(arrivals, nights), guest.id, new Date().toISOString()]
          );
        }
      }

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      console.error(`  ⚠ ${day} 第 ${p.idx + 1} 笔失败：${e.message}`);
    }
  }
}

/* ─────────── 自洽校验 ─────────── */
/*
 * 校验口径必须和生产代码一致：`src/lib/folio.ts` 的 NON_REVENUE_ITEM 把
 * DEPOSIT（押金）排除在 total 之外 —— 押金是负债，不是消费。
 *
 * 第一版校验直接 SUM(folio_items.amount) 没排除 DEPOSIT，
 * 于是押金单全是「total 328 / items 656」的假报警。
 */
const bad = all(
  `SELECT f.id, f.folio_no, f.total_amount, f.paid_amount, f.balance,
          (SELECT COALESCE(SUM(amount),0) FROM folio_items
            WHERE folio_id = f.id AND item_type <> 'DEPOSIT') AS items_sum,
          (SELECT COALESCE(SUM(amount),0) FROM payments WHERE folio_id = f.id) AS pay_sum
     FROM folios f
    WHERE f.hotel_id = ? AND f.folio_no LIKE 'DEMO-%'
      AND (ABS(f.total_amount - (SELECT COALESCE(SUM(amount),0) FROM folio_items
                                   WHERE folio_id = f.id AND item_type <> 'DEPOSIT')) > 0.01
        OR ABS(f.paid_amount - (SELECT COALESCE(SUM(amount),0) FROM payments WHERE folio_id = f.id)) > 0.01)`,
  [HOTEL]
);

console.log(`\n${CHECK ? "【检查模式，未写库】" : "【已写入】"}`);
console.log(`  今天：${today}    覆盖：近 ${DAYS + 1} 天（含今天）`);
console.log(`  房态自愈：${roomCleanup.reset.length} 间无在住单的住净/住脏房${CHECK ? "待复位" : "已复位 → VC"}` +
  (roomCleanup.reset.length ? `（${roomCleanup.reset.map((r) => `${r.room_no} ${r.from}→VC`).join("、")}）` : "") +
  (roomCleanup.skippedManual.length ? `；跳过人工置住净 ${roomCleanup.skippedManual.length} 间` : ""));
console.log(`  跳过（已有 DEMO 数据）：${skippedDays} 天`);
console.log(`  新增：入住单 ${created.stays} · 账单 ${created.folios} · 明细 ${created.items} · 流水 ${created.payments} · 预订 ${created.bookings}`);
console.log(`  自洽校验：${bad.length === 0 ? "✅ 全部通过" : `❌ ${bad.length} 张账单不平`}`);
if (bad.length) {
  for (const b of bad.slice(0, 5)) console.log(`     ${b.folio_no}: total=${b.total_amount} items=${b.items_sum} paid=${b.paid_amount} pay=${b.pay_sum}`);
}

db.close();
process.exit(bad.length === 0 ? 0 : 1);
