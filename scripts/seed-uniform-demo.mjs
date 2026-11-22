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
 *   · 3 笔「已退房」（check-in 当天 → check-out 次日 → 账单已结清）
 *   · 2 笔「已确认预订」（覆盖未来入住，让预抵/预离也有数）
 *   · 今天额外补「在住」（不吃掉历史房间）
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

/* ─────────── 准备：房间 / 房型 / 渠道 / 客人 ─────────── */
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
 * 每个房型挑可用房间
 *
 * ⚠️ 必须排除两类，否则会造出「一间房两张在住单」的脏数据：
 *   1. OOO(维修) / LOCK(锁房) —— 不能卖
 *   2. **已经有 INHOUSE 在住单的房间** —— 这间房现在有客人
 *
 * 上一版只排除了第 1 类，结果 2 张 DEMO 在住单落在了 8402/8503
 * （那两间本来就有 SI1111 / SI6001 在住），房态页出现「一间房两个客人」。
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
        ORDER BY r.id`,
      [HOTEL, rt.id]
    )
  );
}

const channels = all(`SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
const guests = all(`SELECT id, name, mobile FROM guests WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
if (guests.length === 0) {
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
   *   · 今天（n=0）：造「在住」（昨天/前天入住，明天/后天离店）+「今日预抵」（CONFIRMED、未排房）
   *   · 历史（n>=1）：造「已退房」（当天入住、次日离店、账单结清）
   */
  const isToday = n === 0;
  const plans = [];
  if (isToday) {
    /* 今天：3 笔在住 + 3 笔今日预抵 */
    for (let i = 0; i < 3; i++) plans.push({ kind: "inhouse", idx: i });
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

  const outDay = shift(day, 1);

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
    const guest = guests[(n * 5 + p.idx) % guests.length];
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
            `${day} 14:00:00`,
            outDay,
            `${outDay} 12:00:00`,
            nights,
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
          [HOTEL, folioNo, stayId, guest.name, room.room_no, total, total, 0, `${outDay} 12:05:00`, `${outDay} 12:05:00`]
        );
        const folioId = one(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo]).id;

        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
           VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
          [HOTEL, folioId, `房费 ${nights} 晚`, nights, rate, roomFee, day, `${day} 14:05:00`]
        );
        if (otherFee > 0) {
          run(
            `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
             VALUES (?,?, 'OTHER', '其他消费', 1, ?, ?, ?, ?)`,
            [HOTEL, folioId, otherFee, otherFee, day, `${day} 20:00:00`]
          );
        }

        run(
          `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
           VALUES (?,?,?,?,?,?,?,?,?, '演示数据', 'ROOM_PAYMENT')`,
          [HOTEL, folioId, stayId, `DEMO-P-${day}-${p.idx + 1}-${stamp}`, "现金", total, day, "退房结账", `${outDay} 12:05:00`]
        );

        created.stays++;
        created.folios++;
        created.items += otherFee > 0 ? 2 : 1;
        created.payments++;

        /* ---- 预订：已退房（走完整个生命周期） ---- */
        run(
          `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, status, channel_id, created_at)
           VALUES (?,?,?,?,?,?,?,1,'CHECKED_OUT',?,?)`,
          [
            HOTEL,
            `DEMO-${day}-B${p.idx + 1}-${stamp}`,
            guest.name,
            guest.mobile ?? null,
            rt.id,
            day,
            outDay,
            channel?.id ?? null,
            `${shift(day, -3)} 10:00:00`,
          ]
        );
        created.bookings++;
      } else if (p.kind === "inhouse") {
        /*
         * ---- 在住（只造「今天」这一批）----
         *
         * 三笔全部**今天入住**（这样押金流水的 biz_date 就是今天，报表有数）：
         *   第 0 笔：今天入住 + 今天预离 → 房态页「今日预离」能看到
         *   第 1 笔：今天入住 + 明天离店
         *   第 2 笔：今天入住 + 后天离店
         */
        const checkIn = today;
        const checkOut = p.idx === 0 ? today : shift(today, p.idx);
        const stayNo = `DEMO-${day}-H${p.idx + 1}-${stamp}`;
        const deposit = round2(rate * nights);

        run(
          `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, check_in_time, expect_check_out, actual_check_out, nights, rate, deposit, status, channel_id, booking_id)
           VALUES (?,?,?,?,?,?,?,?, NULL, ?,?,?, 'INHOUSE', ?, NULL)`,
          [
            HOTEL,
            stayNo,
            room.id,
            guest.id,
            guest.name,
            guest.mobile ?? null,
            `${checkIn} 14:00:00`,
            checkOut,
            nights,
            rate,
            deposit,
            channel?.id ?? null,
          ]
        );
        const stayId = one(`SELECT id FROM stays WHERE stay_no = ?`, [stayNo]).id;

        /* 房间置 OC（在住） */
        run(`UPDATE rooms SET status = 'OC' WHERE id = ? AND hotel_id = ?`, [room.id, HOTEL]);

        /* 押金已收（kind=DEPOSIT），账单还是 OPEN（客人还没退房结账） */
        const folioNo = `DEMO-${day}-HF${p.idx + 1}-${stamp}`;
        run(
          `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
           VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?)`,
          [HOTEL, folioNo, stayId, guest.name, room.room_no, roomFee, roomFee, 0, `${checkIn} 14:05:00`]
        );
        const folioId = one(`SELECT id FROM folios WHERE folio_no = ?`, [folioNo]).id;
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
           VALUES (?,?, 'ROOM', ?, ?, ?, ?, ?, ?)`,
          [HOTEL, folioId, `房费 ${nights} 晚`, nights, rate, roomFee, checkIn, `${checkIn} 14:05:00`]
        );
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
           VALUES (?,?, 'DEPOSIT', '押金', 1, ?, ?, ?, ?)`,
          [HOTEL, folioId, deposit, deposit, checkIn, `${checkIn} 14:06:00`]
        );
        run(
          `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
           VALUES (?,?,?,?,?,?,?,?,?, '演示数据', 'DEPOSIT')`,
          [HOTEL, folioId, stayId, `DEMO-HP-${day}-${p.idx + 1}-${stamp}`, "现金", deposit, checkIn, "预收款（押金）", `${checkIn} 14:06:00`]
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
          `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, status, channel_id, created_at, remark)
           VALUES (?,?,?,?,?,?,?,1,'CONFIRMED',?,?, '演示数据·今日预抵')`,
          [
            HOTEL,
            `DEMO-${day}-AR${p.idx + 1}-${stamp}`,
            guest.name,
            guest.mobile ?? null,
            rt.id,
            today,
            shift(today, nights),
            channel?.id ?? null,
            `${today} 08:30:00`,
          ]
        );
        created.bookings++;
      } else {
        /*
         * ---- 未来预订：每天 1 条，分散到「今天 + 3 + n」----
         *
         * n 是「往前第几天」，所以 61 天的数据会覆盖今天+3 到 今天+63，
         * 每天恰好 1 条未排房预订（1 间），不会把 46 间的库存打穿。
         */
        const arrivals = shift(today, 3 + n);
        run(
          `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, status, channel_id, created_at)
           VALUES (?,?,?,?,?,?,?,1,'CONFIRMED',?,?)`,
          [
            HOTEL,
            `DEMO-${day}-BQ${p.idx + 1}-${stamp}`,
            guest.name,
            guest.mobile ?? null,
            rt.id,
            arrivals,
            shift(arrivals, nights),
            channel?.id ?? null,
            `${day} 09:30:00`,
          ]
        );
        created.bookings++;
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
console.log(`  跳过（已有 DEMO 数据）：${skippedDays} 天`);
console.log(`  新增：入住单 ${created.stays} · 账单 ${created.folios} · 明细 ${created.items} · 流水 ${created.payments} · 预订 ${created.bookings}`);
console.log(`  自洽校验：${bad.length === 0 ? "✅ 全部通过" : `❌ ${bad.length} 张账单不平`}`);
if (bad.length) {
  for (const b of bad.slice(0, 5)) console.log(`     ${b.folio_no}: total=${b.total_amount} items=${b.items_sum} paid=${b.paid_amount} pay=${b.pay_sum}`);
}

db.close();
process.exit(bad.length === 0 ? 0 : 1);
