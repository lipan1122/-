/**
 * 补关键索引（性能整改）
 *
 * ── 问题 ──
 * 房态页 /rooms 在 Vercel 上要 2~5 秒。拆解后发现：
 *   · 连接 0.4ms（网络没问题）
 *   · TTFB 1~5s（全在服务器端）
 * 而 stays / folios / bookings / rooms / housekeeping 这些核心表**一个索引都没有**。
 *
 * 房态页的 SQL 结构是：
 *   FROM rooms r
 *   LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
 *   LEFT JOIN folios f ON f.stay_id = s.id
 *   + 4 个相关子查询（folio_items 求和 / payments 求和 / stays 自连接算联房）
 *
 * 46 间房 × 6 个无索引关联 = 276 次全表扫描。本地 SSD 上还凑合，
 * 在 Serverless 的弱 CPU 上就是几秒。
 *
 * ── 加索引后 ──
 * 每个关联走索引查找，总扫描量从「276 × 全表」降到「276 × 索引定位」。
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);

const INDEXES = [
  /* 房态页核心：按房间找在住单（LEFT JOIN 条件） */
  ["idx_stays_room", "CREATE INDEX IF NOT EXISTS idx_stays_room ON stays(hotel_id, room_id, status)"],
  /* 联房查询：按客人找其它房间 */
  ["idx_stays_guest", "CREATE INDEX IF NOT EXISTS idx_stays_guest ON stays(hotel_id, guest_id)"],
  /* 在住统计：按状态筛 */
  ["idx_stays_status", "CREATE INDEX IF NOT EXISTS idx_stays_status ON stays(hotel_id, status, expect_check_out)"],
  /* 账单：按入住单找账单（LEFT JOIN） */
  ["idx_folios_stay", "CREATE INDEX IF NOT EXISTS idx_folios_stay ON folios(hotel_id, stay_id)"],
  /* 账单明细：按账单求和 */
  ["idx_folio_items_folio", "CREATE INDEX IF NOT EXISTS idx_folio_items_folio ON folio_items(hotel_id, folio_id)"],
  /* 收款：按入住单求和 */
  ["idx_payments_stay", "CREATE INDEX IF NOT EXISTS idx_payments_stay ON payments(hotel_id, stay_id)"],
  /* 收款：按营业日汇总（交班、收银台今日收款） */
  ["idx_payments_bizdate", "CREATE INDEX IF NOT EXISTS idx_payments_bizdate ON payments(hotel_id, biz_date)"],
  /* 预订列表：状态 + 到店日 */
  ["idx_bookings_status", "CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(hotel_id, status, check_in_date)"],
  /* 预订：按到店日查预抵 */
  ["idx_bookings_checkin", "CREATE INDEX IF NOT EXISTS idx_bookings_checkin ON bookings(hotel_id, check_in_date)"],
  /* 房间：按排序号（房态页 ORDER BY sort） */
  ["idx_rooms_sort", "CREATE INDEX IF NOT EXISTS idx_rooms_sort ON rooms(hotel_id, sort)"],
  /* 客房任务：按状态筛 */
  ["idx_housekeeping_status", "CREATE INDEX IF NOT EXISTS idx_housekeeping_status ON housekeeping(hotel_id, status, room_id)"],
  /* 操作日志：按时间倒序查（日志页） */
  ["idx_op_logs_time", "CREATE INDEX IF NOT EXISTS idx_op_logs_time ON op_logs(hotel_id, id DESC)"],
  /* 门锁设备：按房间关联 */
  ["idx_lock_devices_room", "CREATE INDEX IF NOT EXISTS idx_lock_devices_room ON lock_devices(hotel_id, room_id)"],
  /* 房价日历：按房型+日期 */
  ["idx_rate_calendar_key", "CREATE INDEX IF NOT EXISTS idx_rate_calendar_key ON rate_calendar(hotel_id, room_type_id, date)"],
];

let ok = 0;
let skip = 0;
for (const [name, sql] of INDEXES) {
  try {
    db.exec(sql);
    ok++;
    console.log("  ✅ " + name);
  } catch (e) {
    skip++;
    console.log("  ⚠ " + name + " → " + (e instanceof Error ? e.message : String(e)));
  }
}

/* WAL 模式下 ANALYZE 让查询规划器拿到真实分布，避免选错索引 */
try {
  db.exec("ANALYZE");
  console.log("\n  ✅ ANALYZE 完成（更新统计信息）");
} catch {
  /* 只读库或无权限时跳过，不影响功能 */
}

db.close();
console.log(`\n共 ${INDEXES.length} 个索引：成功 ${ok} / 跳过 ${skip}`);
