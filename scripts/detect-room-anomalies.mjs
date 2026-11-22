/**
 * 房态异常检测 + 落库（整改报告第 7 节）
 *
 * 背景：
 *   房态（rooms.status）和入住单（stays.status）对不上时，光靠体检脚本打印一遍没人跟进。
 *   这个脚本把不一致写成 room_anomalies 记录，前台/店长可以按表逐条销账。
 *
 * 为什么检测逻辑放在这里而不是 import TS：
 *   lib 里是 TypeScript，.mjs 脚本不能直接 import（Node 不做 TS 转译）；
 *   所以检测 SQL 写在脚本里，同时以函数形式导出，health-check.mjs 复用同一份，
 *   保证「体检报告」和「异常落库」两处口径完全一致，不会各写一套 SQL 慢慢漂移。
 *
 * 去重：同一 房间 + 异常类型 且未处理（resolved_at IS NULL）只保留一条，
 *       反复跑不会刷出重复记录；处理完后再犯才会新开一条。
 *
 * 用法：
 *   node scripts/detect-room-anomalies.mjs
 *   node scripts/detect-room-anomalies.mjs --hotel 2
 *   node scripts/detect-room-anomalies.mjs --date 2026-11-17      # 指定业务日（默认本地今天）
 *   node scripts/detect-room-anomalies.mjs --dry-run             # 只看结果不写库
 *   PMS_DB_PATH=/path/pms.db node scripts/detect-room-anomalies.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DB_PATH = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");

/** 本地自然日（酒店业务日按本地时间算，UTC 会在凌晨错一天） */
export function localToday(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const nowIso = () => new Date().toISOString();

const STATUS_LABEL = { VC: "空净", VD: "空脏", OC: "在住净", OD: "在住脏", OOO: "维修", LOCK: "锁房" };
const statusText = (code) => `${STATUS_LABEL[code] ?? code}(${code})`;

export const ANOMALY_LABEL = {
  OCCUPIED_BUT_VACANT: "有在住单但房态为空房",
  VACANT_BUT_OCCUPIED: "房态为在住但没有在住单",
  DUPLICATE_OCCUPANT: "同一房间多条在住单",
  NO_SHOW_STILL_OCCUPIED: "逾期未离店仍在住",
};

/** 表是否存在（没跑过迁移时给一句人话提示，而不是抛 SQLITE_ERROR） */
export function hasAnomalyTable(db) {
  try {
    return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'room_anomalies'`).all().length > 0;
  } catch {
    return false;
  }
}

/**
 * 扫描房态异常（只读）
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} hotelId 酒店 ID
 * @param {string} today   业务日 YYYY-MM-DD
 */
export function detectRoomAnomalies(db, hotelId, today = localToday()) {
  const all = (sql, p = []) => db.prepare(sql).all(...p);
  const items = [];

  /* 规则 1：房态是空净/空脏，但还有 INHOUSE 单 —— 客人可能没房住，最紧急 */
  for (const row of all(
    `SELECT r.id AS room_id, r.room_no, r.status,
            GROUP_CONCAT(COALESCE(s.guest_name, s.stay_no), '、') AS guests
       FROM rooms r
       JOIN stays s ON s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
      WHERE r.hotel_id = ? AND r.status IN ('VC','VD')
      GROUP BY r.id, r.room_no, r.status
      ORDER BY r.room_no`,
    [hotelId]
  )) {
    items.push({
      type: "OCCUPIED_BUT_VACANT",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} 房态为 ${statusText(row.status)}，但仍挂在住单：${row.guests ?? "（无客人姓名）"}`,
    });
  }

  /* 规则 2：房态是在住净/在住脏，但没有 INHOUSE 单 —— 房间被空占，卖不出去 */
  for (const row of all(
    `SELECT r.id AS room_id, r.room_no, r.status
       FROM rooms r
      WHERE r.hotel_id = ? AND r.status IN ('OC','OD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
        )
      ORDER BY r.room_no`,
    [hotelId]
  )) {
    items.push({
      type: "VACANT_BUT_OCCUPIED",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} 房态为 ${statusText(row.status)}，但系统里没有在住单（房间被空占，无法售卖）`,
    });
  }

  /* 规则 3：同一房间 2 条以上 INHOUSE 单 —— 排房/换房没清干净，账务会重复 */
  for (const row of all(
    `SELECT r.id AS room_id, r.room_no, COUNT(*) AS cnt,
            GROUP_CONCAT(COALESCE(s.guest_name, '') || '(' || s.stay_no || ')', '、') AS stays
       FROM rooms r
       JOIN stays s ON s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
      WHERE r.hotel_id = ?
      GROUP BY r.id, r.room_no
     HAVING COUNT(*) > 1
      ORDER BY r.room_no`,
    [hotelId]
  )) {
    items.push({
      type: "DUPLICATE_OCCUPANT",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} 同时挂了 ${row.cnt} 条在住单：${row.stays ?? ""}（需退掉多余的单并核对账务）`,
    });
  }

  /* 规则 4：expect_check_out 已过期仍 INHOUSE —— 逾期未离店 */
  for (const row of all(
    `SELECT s.room_id, r.room_no, s.stay_no, s.guest_name, s.expect_check_out
       FROM stays s
       JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND s.expect_check_out IS NOT NULL AND TRIM(s.expect_check_out) <> ''
        AND s.expect_check_out < ?
      ORDER BY s.expect_check_out, r.room_no`,
    [hotelId, today]
  )) {
    const expect = String(row.expect_check_out).slice(0, 10);
    const a = new Date(`${expect}T00:00:00`).getTime();
    const b = new Date(`${today}T00:00:00`).getTime();
    const late = Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.max(0, Math.round((b - a) / 86400000));
    items.push({
      type: "NO_SHOW_STILL_OCCUPIED",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} ${row.guest_name ?? "住客"}(${row.stay_no}) 应离日 ${expect}，已逾期 ${late} 天仍在住`,
    });
  }

  return items;
}

/**
 * 写入 room_anomalies（同一 房间 + 类型 且未处理的已存在则跳过）
 * @returns {number} 本次新写入条数
 */
export function persistRoomAnomalies(db, hotelId, items, detectedAt = nowIso()) {
  const get = (sql, p = []) => db.prepare(sql).get(...p);
  let inserted = 0;

  for (const item of items) {
    const roomId = item.roomId ?? null;

    // 要求的口径：写之前先查同房间同类型未处理的是否存在，存在就跳过
    const existing = get(
      `SELECT id FROM room_anomalies
        WHERE hotel_id = ? AND room_id IS ? AND anomaly_type = ? AND resolved_at IS NULL
        LIMIT 1`,
      [hotelId, roomId, item.type]
    );
    if (existing) continue;

    // 条件插入兜底：两个进程同时跑检测也不会写出重复行（查和写不是原子的）
    const r = db
      .prepare(
        `INSERT INTO room_anomalies (hotel_id, room_id, room_no, anomaly_type, detail, detected_at)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM room_anomalies
             WHERE hotel_id = ? AND room_id IS ? AND anomaly_type = ? AND resolved_at IS NULL
          )`
      )
      .run(hotelId, roomId, item.roomNo, item.type, item.detail, detectedAt, hotelId, roomId, item.type);
    inserted += Number(r.changes);
  }

  return inserted;
}

/** 未处理异常条数 */
export function countOpenAnomalies(db, hotelId) {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM room_anomalies WHERE hotel_id = ? AND resolved_at IS NULL`)
      .get(hotelId);
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

/** 按类型统计（输出用） */
function groupByType(items) {
  const map = new Map();
  for (const it of items) map.set(it.type, (map.get(it.type) ?? 0) + 1);
  return map;
}

function main() {
  const args = process.argv.slice(2);
  const argVal = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const HOTEL_ID = Number(argVal("--hotel", process.env.PMS_HOTEL_ID ?? 1));
  const today = argVal("--date", process.env.PMS_BIZ_DATE ?? localToday());
  const DRY_RUN = args.includes("--dry-run");

  if (!existsSync(DB_PATH)) {
    console.error(`数据库不存在：${DB_PATH}`);
    process.exit(2);
  }

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: DRY_RUN });
  } catch (e) {
    console.error(`数据库打不开：${e.message}`);
    process.exit(2);
  }

  if (!hasAnomalyTable(db)) {
    console.error(`room_anomalies 表不存在：${DB_PATH}`);
    console.error("先执行迁移：npm run db:migrate");
    db.close();
    process.exit(2);
  }

  // 同一业务日、同一房间、同一类型只写一条，所以 detectedAt 统一取本次扫描时间
  const detectedAt = nowIso();
  const items = detectRoomAnomalies(db, HOTEL_ID, today);
  const inserted = DRY_RUN ? 0 : persistRoomAnomalies(db, HOTEL_ID, items, detectedAt);
  const open = countOpenAnomalies(db, HOTEL_ID);

  console.log(`数据库：${DB_PATH}`);
  console.log(`酒店：${HOTEL_ID}  业务日：${today}\n`);

  if (items.length === 0) {
    console.log(`发现 0 条，新写入 0 条${DRY_RUN ? "（--dry-run）" : ""}`);
    console.log(`未处理异常合计：${open} 条`);
    db.close();
    process.exit(0);
  }

  console.log(
    `发现 ${items.length} 条，新写入 ${inserted} 条${DRY_RUN ? "（--dry-run，未写库）" : ""}`
  );
  for (const [type, count] of groupByType(items)) {
    console.log(`  ${type.padEnd(24)} ${String(count).padStart(3)} 条   ${ANOMALY_LABEL[type] ?? ""}`);
  }
  console.log(`未处理异常合计：${open} 条`);

  console.log("\n明细：");
  for (const it of items.slice(0, 30)) console.log(`  · ${it.detail}`);
  if (items.length > 30) console.log(`  …还有 ${items.length - 30} 条，见 room_anomalies 表`);

  console.log("\n处理完请在 room_anomalies 回填 resolved_at / resolved_by，异常才会销账。");

  db.close();
  process.exit(0);
}

// 只有直接执行时才跑主流程；被 health-check.mjs import 时只提供函数
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
