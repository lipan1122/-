/**
 * 修复存量超卖：房型级预订数超过物理房量
 *
 * ── 问题 ──
 *
 * `2026-11-16T05:29:04` 批量种子数据（`BK3377~BK3581`）插入时**没有校验房型容量**：
 *   · 友聚欢享三床房（容量 1 间）有 3 个有效预订
 *   · 星幕影院大床房（容量 1 间）有 3 个
 *   · 智享安睡大床房（容量 2 间）有 3 个
 *
 * 结果 `/rooms/predict` 直接显示 **占用 47 > 总房量 46、出租率 102.17%**，
 * 涉及 10 个营业日。
 *
 * ── 为什么测试没抓到 ──
 *
 * `test-room-stock-*` 那 4 套测试只验证「**新建**预订时会拦截超卖」，
 * 没有任何测试扫描**存量**预订是否超房型容量。
 *
 * ── 修法 ──
 *
 * 按「日期 × 房型」逐日检查：占用 > 容量时，**保留 id 最小的 N 条**
 * （N = 容量），其余置 `CANCELLED` 并写 `op_logs`。
 *
 * 保留最早的是有意的：越早创建的订单越可能是真实客户先订的；
 * 后插的批量种子数据更可能是噪声。
 *
 * 只处理 `PENDING` / `CONFIRMED`，不动 `CHECKED_IN` / `CHECKED_OUT` / 已取消。
 *
 * 用法：
 *   node scripts/fix-oversell-bookings.mjs            # 只报告（默认）
 *   node scripts/fix-oversell-bookings.mjs --apply    # 备份后写库
 *   node scripts/fix-oversell-bookings.mjs --days 60  # 检查未来 60 天（默认 30）
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbPath = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const daysArg = args.indexOf("--days");
const DAYS = daysArg >= 0 ? Number(args[daysArg + 1]) : 30;
const HOTEL = 1;

const db = new DatabaseSync(dbPath);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const today = one(`SELECT date('now','localtime') AS d`).d;

function shift(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/* 房型容量 = 该房型的物理房间数（不含 OOO/LOCK —— 容量按物理算，维修是临时的） */
const types = all(
  `SELECT rt.id, rt.name,
          (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS cap
     FROM room_types rt WHERE rt.hotel_id = ? ORDER BY rt.sort, rt.id`,
  [HOTEL]
);

console.log(`\n检查范围：今天 ${today} 起 ${DAYS} 天，酒店 #${HOTEL}`);
console.log(
  `房型容量：${types.map((t) => `${t.name}=${t.cap}`).join(" / ")}\n`
);

/* 逐日 × 逐房型 检查 */
const over = [];
for (let i = 0; i < DAYS; i++) {
  const day = shift(today, i);
  for (const t of types) {
    if (Number(t.cap) <= 0) continue;
    const rows = all(
      `SELECT id, booking_no, room_count, status, created_at
         FROM bookings
        WHERE hotel_id = ? AND room_type_id = ?
          AND status IN ('PENDING','CONFIRMED')
          AND check_in_date <= ? AND check_out_date > ?
        ORDER BY id`,
      [HOTEL, t.id, day, day]
    );
    /* 占用按 room_count 累加（多房订单按间数算） */
    let used = 0;
    const keep = [];
    const drop = [];
    for (const b of rows) {
      const n = Math.max(1, Number(b.room_count ?? 1));
      if (used + n <= Number(t.cap)) {
        used += n;
        keep.push(b);
      } else {
        drop.push(b);
      }
    }
    if (drop.length > 0) {
      over.push({ day, type: t, cap: Number(t.cap), kept: keep.length, drop });
    }
  }
}

if (over.length === 0) {
  console.log("✅ 没有超卖：所有日期的房型预订数都在容量内\n");
  db.close();
  process.exit(0);
}

/* 汇总「要取消哪些订单」（同一订单可能多天超卖，只取消一次） */
const toCancel = new Map();
for (const o of over) {
  for (const b of o.drop) {
    if (!toCancel.has(b.id)) {
      toCancel.set(b.id, { booking_no: b.booking_no, room_count: b.room_count, days: [] });
    }
    toCancel.get(b.id).days.push(`${o.day}(${o.type.name})`);
  }
}

console.log(`超卖：${over.length} 个「日期 × 房型」组合`);
console.log(`需要取消：${toCancel.size} 条预订\n`);
for (const o of over.slice(0, 12)) {
  console.log(
    `  ${o.day}  ${o.type.name}  容量 ${o.cap}  保留 ${o.kept} 条  取消 ${o.drop.length} 条：` +
      o.drop.map((b) => b.booking_no).join(", ")
  );
}
if (over.length > 12) console.log(`  …… 还有 ${over.length - 12} 个组合`);

if (!APPLY) {
  console.log(`\n【只报告】加 --apply 备份后写库\n`);
  db.close();
  process.exit(0);
}

/* ─────────── 备份 + 写库 ─────────── */
const backupDir = join(root, "data", "backup");
if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `pms.before-fix-oversell.${stamp}.db`);
copyFileSync(dbPath, backupPath);
console.log(`\n已备份：${backupPath}`);

let cancelled = 0;
db.exec("BEGIN");
try {
  for (const [id, info] of toCancel) {
    /*
     * 主单的 room_id 也必须清空
     *
     * 只清 booking_rooms 不够：test-cancel-assign 有一条断言
     * 「已取消订单主单 room_id 已清空」。留着 room_id 会让这间房
     * 在按主单统计的地方仍被算成被占用。
     */
    run(`UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
      new Date().toISOString(),
      id,
      HOTEL,
    ]);
    /* 明细行一并取消（否则 booking_rooms 还会占房） */
    run(
      `UPDATE booking_rooms SET status = 'CANCELLED', room_id = NULL
        WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [HOTEL, id]
    );
    cancelled++;
  }

  /* 写 op_logs */
  const detail = [...toCancel.values()]
    .map((c) => `${c.booking_no}（${c.days.slice(0, 3).join("/")}${c.days.length > 3 ? " 等" : ""}）`)
    .join("、");
  run(
    `INSERT INTO op_logs (hotel_id, action, detail, operator, created_at)
     VALUES (?,?,?,?,?)`,
    [
      HOTEL,
      "修复存量超卖",
      `房型级预订数超过物理房量，取消 ${cancelled} 条预订并释放房间明细：${detail}`,
      "系统修复",
      new Date().toISOString(),
    ]
  );

  db.exec("COMMIT");
  console.log(`✅ 已取消 ${cancelled} 条预订（含明细行），写 1 条 op_logs`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`❌ 失败已回滚：${e.message}`);
  db.close();
  process.exit(1);
}

/* 复核 */
let stillOver = 0;
for (let i = 0; i < DAYS; i++) {
  const day = shift(today, i);
  for (const t of types) {
    if (Number(t.cap) <= 0) continue;
    const occ = Number(
      one(
        `SELECT COALESCE(SUM(COALESCE(room_count,1)),0) AS s FROM bookings
          WHERE hotel_id = ? AND room_type_id = ? AND status IN ('PENDING','CONFIRMED')
            AND check_in_date <= ? AND check_out_date > ?`,
        [HOTEL, t.id, day, day]
      ).s
    );
    if (occ > Number(t.cap)) stillOver++;
  }
}
console.log(`复核：剩余超卖组合 ${stillOver} 个（应为 0）\n`);

db.close();
process.exit(stillOver === 0 ? 0 : 1);

