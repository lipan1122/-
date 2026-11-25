/**
 * 酒管系统综合体检
 *
 * 检查五类问题：
 *   1. 房态与入住单一致性（房间状态 vs INHOUSE 单）
 *   2. 账务一致性（账单总额 vs 流水合计）
 *   3. 数据完整性（排房到不存在的房间、在住单缺账务单）
 *   4. 业务积压（逾期未离店、过期未到店预订、欠费挂账）
 *   5. 房型/房量异常（房型无房、房号重复）
 *
 * 另外把房态/入住单对不上的情况写进 room_anomalies（整改报告第 7 节），
 * 让不一致留下可追踪的异常记录，而不是打印完就散（--no-persist 可跳过写库）。
 *
 * 用法：
 *   node scripts/health-check.mjs
 *   node scripts/health-check.mjs --json
 *   node scripts/health-check.mjs --no-persist            # 只体检，不写 room_anomalies
 *   node scripts/health-check.mjs --hotel 1 --date 2026-11-17
 *   PMS_DB_PATH=/path/pms.db node scripts/health-check.mjs
 *
 * 退出码：0 = 无问题；1 = 有需要处理的项；2 = 数据库打不开
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
// 检测/落库逻辑与 detect-room-anomalies.mjs 共用一份，避免体检报告和异常记录口径不一致
import {
  detectRoomAnomalies,
  persistRoomAnomalies,
  hasAnomalyTable,
  countOpenAnomalies,
  localToday,
} from "./detect-room-anomalies.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
// 默认把新发现的房态异常落库；--no-persist 只体检不写库（排查环境/只读库时用）
const PERSIST = !args.includes("--no-persist");
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const DB_PATH =
  process.env.PMS_DB_PATH ?? argVal("--db", path.join(process.cwd(), "data", "pms.db"));
const HOTEL_ID = Number(argVal("--hotel", process.env.PMS_HOTEL_ID ?? 1));
// 体检日期：默认本地自然日（酒店业务日按本地时间算，UTC 会在凌晨差一天）
const today = argVal("--date", process.env.PMS_BIZ_DATE ?? localToday());

if (!existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}`);
  process.exit(2);
}

let db;
try {
  // 要写 room_anomalies，默认必须可写；--no-persist 时保持只读，避免误改生产库
  db = new DatabaseSync(DB_PATH, { readOnly: !PERSIST });
} catch (e) {
  console.error(`数据库打不开：${e.message}`);
  process.exit(2);
}

const all = (sql, params = []) => db.prepare(sql).all(...params);
const one = (sql, params = []) => db.prepare(sql).get(...params);

const sections = [];
let problems = 0;
const add = (title, rows, hint) => {
  sections.push({ title, count: rows.length, rows, hint });
  problems += rows.length;
};

/* 1. 房态一致性 */
add(
  "空房标记但有在住单的房间",
  all(
    `SELECT room_no || ' 标记 ' || r.status || ' 但有在住客人 ' || COALESCE(s.guest_name,'') AS x
       FROM rooms r JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
      WHERE r.hotel_id = ? AND r.status IN ('VC','VD')`,
    [HOTEL_ID]
  ).map((r) => r.x),
  "跑 fix-room-status.mjs --apply"
);
add(
  "住净/住脏标记但无在住单的房间",
  all(
    `SELECT room_no || ' 标记 ' || status AS x FROM rooms r
      WHERE hotel_id = ? AND status IN ('OC','OD')
        AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'INHOUSE')`,
    [HOTEL_ID]
  ).map((r) => r.x),
  "跑 fix-room-status.mjs --apply"
);

/* 2. 账务一致性 */
add(
  "账单总额与流水合计不符",
  all(
    /*
     * ⚠️ 必须排除押金明细（item_type='DEPOSIT'）
     *
     * `folios.total_amount` 的口径是「客人应付的消费金额」，**不含押金**
     * （见 lib/folio.ts 的 recalcFolioBalance / 以及 migrate-all 第 23 段）。
     * 押金是代收代付的往来款，单独记在 folio_items 里用于退房时冲销。
     *
     * 原来的判据把押金明细也算进去 → 16 张 OPEN 账单恒报「不符」，
     * 但实际 `total_amount - SUM(非押金明细) = 0.00`，数据是对的。
     * 这类误报会让人习惯性忽略体检结果，比漏报更危险。
     */
    `SELECT folio_no || ' 账单 ' || ROUND(total_amount,2) || ' vs 明细 ' ||
            ROUND(COALESCE((SELECT SUM(amount) FROM folio_items fi
                             WHERE fi.folio_id = f.id AND fi.item_type <> 'DEPOSIT'),0),2) AS x
       FROM folios f WHERE hotel_id = ?
        AND ABS(total_amount - COALESCE((SELECT SUM(amount) FROM folio_items fi
                                          WHERE fi.folio_id = f.id AND fi.item_type <> 'DEPOSIT'),0)) > 0.01`,
    [HOTEL_ID]
  ).map((r) => r.x)
);
add(
  "在住单缺账务单",
  all(
    `SELECT s.stay_no || ' ' || COALESCE(s.guest_name,'') AS x FROM stays s
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND NOT EXISTS (SELECT 1 FROM folios f WHERE f.stay_id = s.id)`,
    [HOTEL_ID]
  ).map((r) => r.x)
);

/* 3. 数据完整性 */
add(
  "预订排到不存在的房间",
  all(
    `SELECT booking_no AS x FROM bookings b
      WHERE hotel_id = ? AND room_id IS NOT NULL AND room_id > 0
        AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = b.room_id)`,
    [HOTEL_ID]
  ).map((r) => r.x)
);
add(
  "房号重复",
  all(`SELECT room_no || ' 出现 ' || COUNT(*) || ' 次' AS x FROM rooms WHERE hotel_id = ? GROUP BY room_no HAVING COUNT(*) > 1`, [
    HOTEL_ID,
  ]).map((r) => r.x)
);
add(
  "房型下没有房间",
  all(
    `SELECT rt.name AS x FROM room_types rt WHERE rt.hotel_id = ?
      AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.room_type_id = rt.id)`,
    [HOTEL_ID]
  ).map((r) => r.x)
);

/* 4. 业务积压 */
add(
  "逾期未离店（离店日已过仍在住）",
  all(
    `SELECT stay_no || ' ' || COALESCE(guest_name,'') || ' 应离 ' || expect_check_out AS x
       FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out < ?`,
    [HOTEL_ID, today]
  ).map((r) => r.x),
  "前台应办理退房或续住"
);
add(
  "过期未到店仍占房的预订",
  all(
    `SELECT booking_no || ' ' || COALESCE(guest_name,'') || ' 应离 ' || check_out_date AS x
       FROM bookings WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_out_date < ?`,
    [HOTEL_ID, today]
  ).map((r) => r.x),
  "夜审会自动标记 NOSHOW"
);
add(
  "在住客人欠费",
  all(
    `SELECT r.room_no || ' ' || COALESCE(s.guest_name,'') || ' 余额 ' || ROUND(f.balance,2) AS x
       FROM stays s JOIN rooms r ON r.id = s.room_id JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0.01`,
    [HOTEL_ID]
  ).map((r) => r.x),
  "前台催收或挂账"
);

/* 5. 房态异常记录（整改报告第 7 节）
 *
 * 前面第 1/4 节已经把「房态和入住单对不上」打印出来了，但打印完就散了：
 * 没人认领、没法统计多久修好。这里把同样的不一致写成 room_anomalies 记录，
 * 同一条未处理异常反复检测只保留一条，处理完（resolved_at 有值）后再犯才新开一条。
 *
 * 检测逻辑复用 detect-room-anomalies.mjs，保证脚本和体检报告口径一致。
 */
const anomalyTableReady = hasAnomalyTable(db);
const anomalyItems = anomalyTableReady ? detectRoomAnomalies(db, HOTEL_ID, today) : [];
let newAnomalies = 0;
let openAnomalies = 0;
let anomalyNote = "";

if (!anomalyTableReady) {
  anomalyNote = "room_anomalies 表不存在，先跑 npm run db:migrate";
} else {
  if (PERSIST && anomalyItems.length > 0) {
    try {
      newAnomalies = persistRoomAnomalies(db, HOTEL_ID, anomalyItems);
    } catch (e) {
      anomalyNote = `写库失败：${e.message}`;
    }
  }
  // 未处理条数是累计值：房态修好了但记录没销账时，它会大于本次检测数，这是故意的
  openAnomalies = countOpenAnomalies(db, HOTEL_ID);
}

// 结构化输出用（--json），也方便后续报表直接取数
const anomalyReport = {
  tableReady: anomalyTableReady,
  detected: anomalyItems.length,
  inserted: newAnomalies,
  open: openAnomalies,
  note: anomalyNote || undefined,
  items: anomalyItems,
};

/* 6. 规模概览 */
const stat = one(
  `SELECT (SELECT COUNT(*) FROM rooms WHERE hotel_id = ?1) AS rooms,
          (SELECT COUNT(*) FROM stays WHERE hotel_id = ?1 AND status='INHOUSE') AS inhouse,
          (SELECT COUNT(*) FROM bookings WHERE hotel_id = ?1) AS bookings,
          (SELECT COUNT(*) FROM guests WHERE hotel_id = ?1) AS guests,
          (SELECT COUNT(*) FROM folio_items WHERE hotel_id = ?1) AS items,
          (SELECT COUNT(*) FROM payments WHERE hotel_id = ?1) AS pays`,
  [HOTEL_ID]
);
const dist = all(`SELECT status, COUNT(*) c FROM rooms WHERE hotel_id = ? GROUP BY status ORDER BY status`, [HOTEL_ID]);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { db: DB_PATH, hotelId: HOTEL_ID, bizDate: today, problems, sections, stat, roomStatus: dist, roomAnomalies: anomalyReport },
      null,
      2
    )
  );
} else {
  console.log(`数据库：${DB_PATH}`);
  console.log(`酒店：${HOTEL_ID}  营业日：${today}\n`);
  for (const s of sections) {
    if (s.count === 0) {
      console.log(`✅ ${s.title}`);
      continue;
    }
    console.log(`⚠️  ${s.title}（${s.count}）`);
    for (const r of s.rows.slice(0, 8)) console.log("     " + r);
    if (s.rows.length > 8) console.log(`     …还有 ${s.rows.length - 8} 条`);
    if (s.hint) console.log(`     处理建议：${s.hint}`);
  }
  console.log(
    `\n规模：房间 ${stat.rooms} | 在住 ${stat.inhouse} | 预订 ${stat.bookings} | 客人 ${stat.guests} | 流水 ${stat.items} | 收款 ${stat.pays}`
  );
  console.log("房态：" + dist.map((d) => `${d.status} ${d.c}`).join("  "));

  // 「房态异常记录」单独一节：显示未处理条数，让现场知道台账里还欠多少条没销账
  console.log("");
  console.log("房态异常记录");
  if (!anomalyTableReady) {
    console.log(`  ⚠️  ${anomalyNote}`);
  } else {
    const persistText = PERSIST ? `本次新写入 ${newAnomalies} 条` : "--no-persist，本次未写库";
    console.log(`  未处理 ${openAnomalies} 条（本次检测 ${anomalyItems.length} 条，${persistText}）`);
    if (anomalyItems.length > 0) {
      const byType = new Map();
      for (const it of anomalyItems) byType.set(it.type, (byType.get(it.type) ?? 0) + 1);
      for (const [type, count] of byType) console.log(`     ${type} ${count} 条`);
    }
    if (anomalyNote) console.log(`     ⚠️  ${anomalyNote}`);
    if (openAnomalies > 0) {
      console.log("     处理建议：修完房态/入住单后回填 room_anomalies.resolved_at / resolved_by 才算销账");
    }
  }
  console.log(problems === 0 ? "\n体检通过 ✅" : `\n共 ${problems} 处待处理`);
}

db.close();
process.exit(problems === 0 ? 0 : 1);
