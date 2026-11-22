/**
 * 房态异常检测与落库（整改报告第 7 节）
 *
 * 为什么单独做这一层：
 *   1. 房态（rooms.status）和入住单（stays.status）是两份独立维护的数据，
 *      入住、退房、换房、夜审、手工改库任何一条路径漏写，两边就会对不上；
 *   2. 原来的体检脚本只是「打印」不一致，打印完就散了，没人认领、没人销账，
 *      问题会一直挂在那里，也无法统计多久能修好；
 *   3. 所以这里把不一致固化成 room_anomalies 记录：哪间房、什么问题、什么时候发现、
 *      谁什么时候处理掉（resolved_at / resolved_by），让异常可追踪。
 *
 * 去重口径（为什么反复跑不会刷爆表）：
 *   同一 hotel + room + anomaly_type 且未处理（resolved_at IS NULL）只保留一条。
 *   反复跑检测时已有的未处理异常直接跳过；处理完（写了 resolved_at）以后再犯才会新开一条，
 *   这样「复犯」能被统计出来，而不是被永久忽略。
 *
 * 日期口径：
 *   「逾期未离店」按本地自然日判断（酒店业务日以本地时间为准，不用 UTC，
 *   否则凌晨 0-8 点会把昨天到期的单判定成未逾期）。
 */

import { all, get, run } from "@/lib/db";
import { nowIso, todayStr } from "@/lib/utils";

/** 异常类型码：放库里便于统计和做筛选，展示时再翻译成人话 */
export type AnomalyType =
  | "OCCUPIED_BUT_VACANT" // 有在住单但房态是空房
  | "VACANT_BUT_OCCUPIED" // 房态在住但没有在住单
  | "DUPLICATE_OCCUPANT" // 一间房挂了两条以上在住单
  | "NO_SHOW_STILL_OCCUPIED"; // 该走没走，逾期仍在住

export type AnomalyItem = {
  type: AnomalyType;
  roomId: number;
  roomNo: string;
  detail: string;
};

/** 类型码 → 中文说明（写 detail 与界面展示共用，避免各处各写一套措辞） */
export const ANOMALY_LABEL: Record<AnomalyType, string> = {
  OCCUPIED_BUT_VACANT: "有在住单但房态为空房",
  VACANT_BUT_OCCUPIED: "房态为在住但没有在住单",
  DUPLICATE_OCCUPANT: "同一房间多条在住单",
  NO_SHOW_STILL_OCCUPIED: "逾期未离店仍在住",
};

/**
 * 房态码 → 中文
 * 这里故意只用一份只读映射，不 import room-status.ts：
 * 异常检测是「看」数据，不该把房态流转服务（写数据）一起拖进来。
 */
const STATUS_LABEL: Record<string, string> = {
  VC: "空净",
  VD: "空脏",
  OC: "在住净",
  OD: "在住脏",
  OOO: "维修",
  LOCK: "锁房",
};

const statusText = (code: string) => `${STATUS_LABEL[code] ?? code}(${code})`;

/** 计划离店日到今天差几天（本地自然日，避免跨时区/夏令时误差） */
function daysLate(expectCheckOut: string, today: string): number {
  const a = new Date(`${expectCheckOut.slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${today}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * 扫描某酒店当前的房态异常（只读，不写库）
 *
 * 四条规则对应四类现实事故：
 *   1. 房态空着但有在住单 → 客人可能没房住，最紧急
 *   2. 房态在住但没在住单 → 房间被「幽灵」占着，卖不出去
 *   3. 一房多单在住 → 排房/换房没清干净，账务会重复
 *   4. 逾期未离店 → 收入漏收、房态被长期占用
 */
export function detectRoomAnomalies(hotelId: number): AnomalyItem[] {
  const today = todayStr();
  const items: AnomalyItem[] = [];

  /* 规则 1：房间标记空净/空脏，但系统里还有 INHOUSE 入住单 */
  const occupiedButVacant = all<{ room_id: number; room_no: string; status: string; guests: string | null }>(
    `SELECT r.id AS room_id, r.room_no, r.status,
            GROUP_CONCAT(COALESCE(s.guest_name, s.stay_no), '、') AS guests
       FROM rooms r
       JOIN stays s ON s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
      WHERE r.hotel_id = ? AND r.status IN ('VC','VD')
      GROUP BY r.id, r.room_no, r.status
      ORDER BY r.room_no`,
    [hotelId]
  );
  for (const row of occupiedButVacant) {
    items.push({
      type: "OCCUPIED_BUT_VACANT",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} 房态为 ${statusText(row.status)}，但仍挂在住单：${row.guests ?? "（无客人姓名）"}`,
    });
  }

  /* 规则 2：房间标记在住净/在住脏，但查不到任何 INHOUSE 入住单 */
  const vacantButOccupied = all<{ room_id: number; room_no: string; status: string }>(
    `SELECT r.id AS room_id, r.room_no, r.status
       FROM rooms r
      WHERE r.hotel_id = ? AND r.status IN ('OC','OD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
        )
      ORDER BY r.room_no`,
    [hotelId]
  );
  for (const row of vacantButOccupied) {
    items.push({
      type: "VACANT_BUT_OCCUPIED",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} 房态为 ${statusText(row.status)}，但系统里没有在住单（房间被空占，无法售卖）`,
    });
  }

  /* 规则 3：同一房间有 2 条以上 INHOUSE 单 */
  const duplicate = all<{ room_id: number; room_no: string; cnt: number; stays: string | null }>(
    `SELECT r.id AS room_id, r.room_no, COUNT(*) AS cnt,
            GROUP_CONCAT(COALESCE(s.guest_name, '') || '(' || s.stay_no || ')', '、') AS stays
       FROM rooms r
       JOIN stays s ON s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
      WHERE r.hotel_id = ?
      GROUP BY r.id, r.room_no
     HAVING COUNT(*) > 1
      ORDER BY r.room_no`,
    [hotelId]
  );
  for (const row of duplicate) {
    items.push({
      type: "DUPLICATE_OCCUPANT",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} 同时挂了 ${row.cnt} 条在住单：${row.stays ?? ""}（需退掉多余的单并核对账务）`,
    });
  }

  /* 规则 4：expect_check_out 已过期，但入住单还是 INHOUSE（逾期未离店） */
  const overdue = all<{
    room_id: number;
    room_no: string;
    stay_no: string;
    guest_name: string | null;
    expect_check_out: string;
  }>(
    `SELECT s.room_id, r.room_no, s.stay_no, s.guest_name, s.expect_check_out
       FROM stays s
       JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND s.expect_check_out IS NOT NULL AND TRIM(s.expect_check_out) <> ''
        AND s.expect_check_out < ?
      ORDER BY s.expect_check_out, r.room_no`,
    [hotelId, today]
  );
  for (const row of overdue) {
    const late = daysLate(row.expect_check_out, today);
    items.push({
      type: "NO_SHOW_STILL_OCCUPIED",
      roomId: row.room_id,
      roomNo: row.room_no,
      detail: `房间 ${row.room_no} ${row.guest_name ?? "住客"}(${row.stay_no}) 应离日 ${row.expect_check_out.slice(0, 10)}，已逾期 ${late} 天仍在住`,
    });
  }

  return items;
}

/**
 * 把检测结果写入 room_anomalies，返回本次新写入的条数
 *
 * 去重：先查「同房间 + 同类型 + 未处理」是否已存在，有就跳过（这是要求里的口径）；
 *       插入语句再带一层 NOT EXISTS 兜底 —— 查和写不是原子操作，
 *       两个进程（体检脚本 + 定时任务）同时跑时不会写出两条一样的记录。
 *
 * @param hotelId 酒店 ID
 * @param items   detectRoomAnomalies 的结果
 */
export function persistRoomAnomalies(hotelId: number, items: ReturnType<typeof detectRoomAnomalies>): number {
  const detectedAt = nowIso();
  let inserted = 0;

  for (const item of items) {
    const roomId = item.roomId ?? null;

    // 已经有一条未处理的同类型异常 → 说明它在追踪清单里了，重复检测不再写新记录
    const existing = get<{ id: number }>(
      `SELECT id FROM room_anomalies
        WHERE hotel_id = ? AND room_id IS ? AND anomaly_type = ? AND resolved_at IS NULL
        LIMIT 1`,
      [hotelId, roomId, item.type]
    );
    if (existing) continue;

    // 条件插入：并发场景下只有第一个能写进去，changes 为 0 就当跳过
    const result = run(
      `INSERT INTO room_anomalies (hotel_id, room_id, room_no, anomaly_type, detail, detected_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM room_anomalies
           WHERE hotel_id = ? AND room_id IS ? AND anomaly_type = ? AND resolved_at IS NULL
        )`,
      [hotelId, roomId, item.roomNo, item.type, item.detail, detectedAt, hotelId, roomId, item.type]
    );
    inserted += result.changes;
  }

  return inserted;
}
