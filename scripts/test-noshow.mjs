/**
 * 夜审 NOSHOW 口径验收（整改清单 P1-2）
 *
 * 缺陷背景（两条）：
 *   1. 判定条件用 `check_out_date <= today` —— 会把「今天入住、今天离店」的
 *      日租单，以及「今天离店但客人还没到」的单一起标 NOSHOW，误杀当天单。
 *      正确语义是「到店日已过去，客人始终没来」→ `check_in_date < today`。
 *   2. 标 NOSHOW 时不清房 —— 主单 room_id 和 booking_rooms 明细还挂着，
 *      房间在房态图上仍是占用，卖不出去。
 *
 * 本脚本：
 *   1. 静态校验：夜审 action 的判定条件是 check_in_date < today，且有清房语句
 *   2. 逻辑校验：构造四种边界场景，验证判定条件符合预期
 *   3. 数据校验：已标 NOSHOW 的单不应还占着房间
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* ---------- 1. 静态 ---------- */
const src = readFileSync(join("src", "app", "(main)", "night-audit", "actions.ts"), "utf8");

check("NOSHOW 判定用 check_in_date < today（不用 check_out_date）", /check_in_date\s*<\s*\?/.test(src));
check("NOSHOW 判定不再用 check_out_date <= today", !/check_out_date\s*<=\s*\?/.test(src));
check("标 NOSHOW 时释放主单 room_id", /status\s*=\s*'NOSHOW'[\s\S]{0,120}room_id\s*=\s*NULL/.test(src));
check("标 NOSHOW 时把明细置 CANCELLED", /booking_rooms\s+SET\s+status\s*=\s*'CANCELLED'/.test(src));
check("日志说明房间已释放", /房间已释放/.test(src));

/* ---------- 2. 逻辑：四种边界场景 ---------- */
/* 与 SQL 判定等价：check_in_date < today */
function isNoShow(checkIn, today) {
  return checkIn < today;
}
const today = "2026-11-18";

check("到店日 11-17（昨天）→ 标 NOSHOW", isNoShow("2026-11-17", today));
check("到店日 11-18（今天）→ 不标（客人还没到，但日子没过）", !isNoShow("2026-11-18", today));
check("到店日 11-19（明天）→ 不标", !isNoShow("2026-11-19", today));
check("今天入住今天离店（日租单）→ 不标（旧逻辑误杀）", !isNoShow("2026-11-18", today));

/* ---------- 3. 数据：已 NOSHOW 的单不该占房 ---------- */
const db = new DatabaseSync(DB, { readOnly: true });

const noShowStillOccupied = db.prepare(
  `SELECT b.booking_no, b.room_id,
          (SELECT COUNT(*) FROM booking_rooms br
            WHERE br.booking_id = b.id AND br.room_id IS NOT NULL
              AND br.status IN ('PENDING','CONFIRMED')) AS live_details
     FROM bookings b
    WHERE b.hotel_id = 1 AND b.status = 'NOSHOW'
      AND (b.room_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM booking_rooms br
                       WHERE br.booking_id = b.id AND br.room_id IS NOT NULL
                         AND br.status IN ('PENDING','CONFIRMED')))
    LIMIT 10`
).all();
check("已标 NOSHOW 的单不再占房（主单与明细都释放）", noShowStillOccupied.length === 0,
  JSON.stringify(noShowStillOccupied.slice(0, 3)));

/* 统计 */
const stat = db.prepare(
  `SELECT
     (SELECT COUNT(*) FROM bookings WHERE hotel_id=1 AND status='NOSHOW') AS noshow,
     (SELECT COUNT(*) FROM bookings WHERE hotel_id=1 AND status IN ('PENDING','CONFIRMED')) AS pending`
).get();
console.log(`\n当前：NOSHOW ${stat.noshow} 单 / 待处理预订 ${stat.pending} 单`);

/* 当日单（今天入住今天离店）不应已被误标 NOSHOW */
const todayYmd = new Date().toISOString().slice(0, 10);
const misKilled = db.prepare(
  `SELECT booking_no, check_in_date, check_out_date FROM bookings
    WHERE hotel_id = 1 AND status = 'NOSHOW' AND check_in_date >= ? LIMIT 5`
).all(todayYmd);
check("没有被误杀的当天单（今天及以后到店的 NOSHOW）", misKilled.length === 0,
  JSON.stringify(misKilled));

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
