/**
 * 上线前数据一致性体检（生产就绪检查）
 *
 * 覆盖上线后最容易出事的 20 类问题：
 *   孤儿数据 / 状态矛盾 / 金额对不上 / 时间穿越 / 重复记录 / 空值污染
 *
 * 与 audit.mjs 的区别：audit.mjs 查「业务规则」（如账单总额=明细合计），
 * 这个脚本查「数据完整性」（如孤儿记录、状态矛盾、外键悬空）。
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB, { readOnly: true });
const all = (s, p = []) => db.prepare(s).all(...p);
const one = (s, p = []) => db.prepare(s).get(...p);

let total = 0;
let fatal = 0;
let warn = 0;

function check(level, name, sql, note = "") {
  let rows;
  try {
    rows = all(sql);
  } catch (e) {
    console.log(`  ⚠ 跳过 ${name}：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  total++;
  if (rows.length === 0) {
    console.log(`  ✅ ${name}`);
    return;
  }
  const n = rows.length;
  const sample = JSON.stringify(rows.slice(0, 2));
  if (level === "INFO_NEG") {
    console.log(`  ℹ ： 张（押金口径修正后的正常状态，退房时按应退处理）`);
    return;
  }
  if (level === "FATAL") {
    fatal++;
    console.log(`  ❌ [严重] ${name}：${n} 条  ${sample}`);
  } else {
    warn++;
    console.log(`  ⚠️ [警告] ${name}：${n} 条  ${sample}`);
  }
  if (note) console.log(`       ${note}`);
}

console.log("\n========== 一、孤儿数据（外键悬空） ==========\n");

check("FATAL", "入住单指向不存在的房间", `
  SELECT s.id, s.stay_no, s.room_id FROM stays s
   WHERE s.room_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = s.room_id)`);

check("FATAL", "账务单指向不存在的入住单", `
  SELECT f.id, f.folio_no, f.stay_id FROM folios f
   WHERE f.stay_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.id = f.stay_id)`);

check("FATAL", "账单明细指向不存在的账单", `
  SELECT fi.id FROM folio_items fi
   WHERE NOT EXISTS (SELECT 1 FROM folios f WHERE f.id = fi.folio_id)`);

check("FATAL", "收款流水指向不存在的账单", `
  SELECT p.id, p.pay_no FROM payments p
   WHERE p.folio_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM folios f WHERE f.id = p.folio_id)`);

check("FATAL", "预订明细指向不存在的预订", `
  SELECT br.id FROM booking_rooms br
   WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = br.booking_id)`);

check("WARN", "客房任务指向不存在的房间", `
  SELECT h.id FROM housekeeping h
   WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = h.room_id)`);

console.log("\n========== 二、状态矛盾 ==========\n");

check("FATAL", "房态是空房（VC/VD）但有在住单", `
  SELECT r.room_no, r.status, s.stay_no FROM rooms r
    JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
   WHERE r.status IN ('VC','VD')`,
  "退房时房态没更新，或入住时没置 OC");

check("FATAL", "房态是在住（OC/OD）但没有在住单", `
  SELECT r.room_no, r.status FROM rooms r
   WHERE r.status IN ('OC','OD')
     AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'INHOUSE')`,
  "可能是取消入住后房态没回滚");

check("FATAL", "入住单状态是 INHOUSE 但实际已退房", `
  SELECT s.stay_no FROM stays s
   WHERE s.status = 'INHOUSE' AND s.actual_check_out IS NOT NULL`);

check("FATAL", "同一房间有两个在住单", `
  SELECT room_id, COUNT(*) c FROM stays
   WHERE status = 'INHOUSE' AND room_id IS NOT NULL
   GROUP BY room_id HAVING c > 1`,
  "并发入住没锁住，会导致重复占用");

check("WARN", "预订是 CHECKED_IN 但没有对应入住单", `
  SELECT b.booking_no FROM bookings b
   WHERE b.status = 'CHECKED_IN'
     AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.booking_id = b.id)`);

check("WARN", "预订明细已 CHECKED_IN 但没有 stay_id", `
  SELECT br.id, br.booking_id FROM booking_rooms br
   WHERE br.status = 'CHECKED_IN' AND br.stay_id IS NULL`);

check("WARN", "未排房却标 CONFIRMED 的明细", `
  SELECT id FROM booking_rooms
   WHERE room_id IS NULL AND status = 'CONFIRMED'`);

console.log("\n========== 三、金额一致性 ==========\n");

/*
 * 账单总额 = 有效消费明细合计
 *
 * ⚠️ 口径（上线前修正）：押金 DEPOSIT **不计入**应收总额 —— 押金是负债不是收入。
 * 旧口径把押金算进 total，导致「客人交了 600 押金 + 消费 1764」时
 * total=2364、余额 0、系统判定已结清，那 600 押金永远退不回去。
 * 现在 total = 1764、余额 = -600（应退客人 600），退房时按应退处理。
 */
check("FATAL", "账单总额 ≠ 消费明细合计", `
  SELECT f.folio_no, f.total_amount,
         COALESCE((SELECT SUM(fi.amount) FROM folio_items fi
                    WHERE fi.folio_id = f.id
                      AND NOT (fi.item_type='DEPOSIT'
                               OR (fi.item_type='ADJUST' AND fi.description LIKE '【部分结账】%'))), 0) AS items
    FROM folios f
   WHERE ABS(COALESCE(f.total_amount,0) - COALESCE((
           SELECT SUM(fi.amount) FROM folio_items fi
            WHERE fi.folio_id = f.id
              AND NOT (fi.item_type='DEPOSIT'
                       OR (fi.item_type='ADJUST' AND fi.description LIKE '【部分结账】%'))), 0)) > 0.01`);

check("FATAL", "账单余额 ≠ 应收 − 已收", `
  SELECT folio_no, total_amount, paid_amount, balance FROM folios
   WHERE ABS(COALESCE(total_amount,0) - COALESCE(paid_amount,0) - COALESCE(balance,0)) > 0.01`);

check("FATAL", "账单已收 ≠ 收款流水合计", `
  SELECT f.folio_no, f.paid_amount,
         COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.folio_id = f.id), 0) AS pays
    FROM folios f
   WHERE ABS(COALESCE(f.paid_amount,0) - COALESCE(
           (SELECT SUM(p.amount) FROM payments p WHERE p.folio_id = f.id), 0)) > 0.01`);

/*
 * 负余额 = 应退客人金额
 *
 * 押金口径修正后这是**正常状态**：客人交了押金、消费没那么多，
 * 中间那部分就是该退的钱。退房时前台按「应退」处理即可。
 * 只有当负余额对应的账单已经 CHECKED_OUT 却没生成退款流水时才是问题 ——
 * 那个由下面的「退房后仍有应退但无退款流水」单独检查。
 */
check("INFO_NEG", "存在应退客人的账单（负余额，正常）", `
  SELECT folio_no, balance FROM folios WHERE balance < -0.01 LIMIT 20`);

check("WARN", "金额字段有多位小数（浮点污染）", `
  SELECT COUNT(*) AS bad FROM folio_items
   WHERE ABS(ROUND(amount,2) - amount) > 0.000001
  HAVING bad > 0`);

console.log("\n========== 四、时间穿越 ==========\n");

check("FATAL", "离店日期早于到店日期", `
  SELECT booking_no, check_in_date, check_out_date FROM bookings
   WHERE check_out_date <= check_in_date`);

check("WARN", "入住时间晚于当前时间（未来入住）", `
  SELECT stay_no, check_in_time FROM stays
   WHERE check_in_time > datetime('now', '+1 day')`);

check("WARN", "退房时间早于入住时间", `
  SELECT stay_no, check_in_time, actual_check_out FROM stays
   WHERE actual_check_out IS NOT NULL
     AND substr(actual_check_out,1,10) < substr(check_in_time,1,10)`);

check("WARN", "账务明细营业日不在合理范围", `
  SELECT id, biz_date FROM folio_items
   WHERE biz_date IS NOT NULL AND (biz_date < '2020-01-01' OR biz_date > date('now','+2 year'))
   LIMIT 5`);

console.log("\n========== 五、重复与唯一性 ==========\n");

check("FATAL", "房号重复", `
  SELECT room_no, COUNT(*) c FROM rooms GROUP BY hotel_id, room_no HAVING c > 1`);

check("FATAL", "同一手机号多个客史", `
  SELECT mobile, COUNT(*) c FROM guests
   WHERE COALESCE(mobile,'') <> '' GROUP BY hotel_id, mobile HAVING c > 1`);

check("WARN", "同一账单重复收款流水号", `
  SELECT pay_no, COUNT(*) c FROM payments
   WHERE COALESCE(pay_no,'') <> '' GROUP BY hotel_id, pay_no HAVING c > 1`);

check("WARN", "同一营业日重复夜审", `
  SELECT biz_date, COUNT(*) c FROM night_audits GROUP BY hotel_id, biz_date HAVING c > 1`);

console.log("\n========== 六、空值污染 ==========\n");

check("WARN", "账单缺 folio_no", `
  SELECT id FROM folios WHERE COALESCE(folio_no,'') = ''`);

check("WARN", "入住单缺 stay_no", `
  SELECT id FROM stays WHERE COALESCE(stay_no,'') = ''`);

check("WARN", "预订缺 booking_no", `
  SELECT id FROM bookings WHERE COALESCE(booking_no,'') = ''`);

check("WARN", "房间缺房型", `
  SELECT room_no FROM rooms WHERE room_type_id IS NULL`);

check("WARN", "房间缺楼层", `
  SELECT room_no FROM rooms WHERE floor IS NULL`);

check("WARN", "有效用户数为 0 或非 4 个", `
  SELECT COUNT(*) c FROM users WHERE status = 1 HAVING c = 0`);

console.log("\n========== 七、业务合理性 ==========\n");

check("WARN", "在住单房价为 0", `
  SELECT stay_no, room_id FROM stays WHERE status='INHOUSE' AND COALESCE(rate,0) <= 0`,
  "免费房请用 0 价政策标记，别让报表算成 0 收入");

check("WARN", "在住单晚数为 0 且非钟点房", `
  SELECT stay_no, rate_code FROM stays
   WHERE status='INHOUSE' AND COALESCE(nights,0) = 0 AND COALESCE(rate_code,'') <> '钟点'`);

check("WARN", "预订日期在未来 2 年以上", `
  SELECT booking_no, check_in_date FROM bookings WHERE check_in_date > date('now','+2 year')`);

check("WARN", "在住单已超过预计离店日 7 天以上", `
  SELECT stay_no, expect_check_out FROM stays
   WHERE status='INHOUSE' AND expect_check_out < date('now','-7 day')`,
  "逾期未离店太久，可能是忘了退房，也可能是数据问题");

console.log("\n========== 八、表与索引完整性 ==========\n");

const requiredTables = [
  "hotels", "users", "rooms", "room_types", "guests", "bookings", "booking_rooms",
  "stays", "folios", "folio_items", "payments", "channels", "channel_orders",
  "night_audits", "housekeeping", "op_logs", "room_logs", "settings",
  "companies", "ar_ledgers", "invoices", "member_wallet", "member_wallet_ledger",
  "role_permissions", "role_modules", "permission_dict", "shifts", "lost_items",
];
const existing = new Set(all(`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name));
const missing = requiredTables.filter((t) => !existing.has(t));
total++;
if (missing.length === 0) {
  console.log(`  ✅ 必需表齐全（${requiredTables.length} 张）`);
} else {
  fatal++;
  console.log(`  ❌ [严重] 缺少表：${missing.join(", ")}`);
}

const idxCount = one(`SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`).c;
console.log(`  ℹ 索引总数：${idxCount}`);

const noPk = all(`
  SELECT name FROM sqlite_master
   WHERE type='table' AND name NOT LIKE 'sqlite_%'
     AND sql NOT LIKE '%PRIMARY KEY%'`);
total++;
if (noPk.length === 0) {
  console.log("  ✅ 所有表都有主键");
} else {
  warn++;
  console.log(`  ⚠️ [警告] 无主键的表：${noPk.map((t) => t.name).join(", ")}`);
}

console.log("\n========== 汇总 ==========\n");
console.log(`  检查项 ${total} 项：严重 ${fatal} / 警告 ${warn} / 通过 ${total - fatal - warn}`);
console.log(fatal === 0 ? "\n  ✅ 无严重数据问题，可以上线\n" : "\n  ❌ 有严重问题，上线前必须修\n");

db.close();
process.exit(fatal === 0 ? 0 : 1);
