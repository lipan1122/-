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

/* 每个房型挑可用房间（避开当前 OOO/LOCK 的） */
const roomsByType = new Map();
for (const rt of roomTypes) {
  roomsByType.set(
    rt.id,
    all(
      `SELECT id, room_no FROM rooms
        WHERE hotel_id = ? AND room_type_id = ? AND status NOT IN ('OOO','LOCK')
        ORDER BY id`,
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

  /* 每天 3 个「已退房」+ 2 个「已确认预订」 */
  const plans = [];
  for (let i = 0; i < 3; i++) plans.push({ kind: "checked_out", idx: i });
  for (let i = 0; i < 2; i++) plans.push({ kind: "booking", idx: i });
  plan.push({ day, count: plans.length });

  if (CHECK) continue;

  const outDay = shift(day, 1);

  for (const p of plans) {
    const rt = roomTypes[(n + p.idx) % roomTypes.length];
    const pool = roomsByType.get(rt.id) ?? [];
    if (pool.length === 0) continue;
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
            round2(rate * nights), // 押金按应收收
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
      } else {
        /* ---- 已确认预订：覆盖未来入住，让预抵/预离有数 ---- */
        const arrivals = shift(today, 1 + ((n + p.idx) % 7));
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
const bad = all(
  `SELECT f.id, f.folio_no, f.total_amount, f.paid_amount, f.balance,
          (SELECT COALESCE(SUM(amount),0) FROM folio_items WHERE folio_id = f.id) AS items_sum,
          (SELECT COALESCE(SUM(amount),0) FROM payments WHERE folio_id = f.id) AS pay_sum
     FROM folios f
    WHERE f.hotel_id = ? AND f.folio_no LIKE 'DEMO-%'
      AND (ABS(f.total_amount - (SELECT COALESCE(SUM(amount),0) FROM folio_items WHERE folio_id = f.id)) > 0.01
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
