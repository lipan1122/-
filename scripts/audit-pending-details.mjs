#!/usr/bin/env node
/**
 * 「未排房已确认明细」分类体检（只读）
 *
 * ── 为什么要这个脚本 ──
 * 上线评审 P1：本地副本数据体检报出 63 条「已确认但没排房」的明细。
 * 如果照单全收当成 63 个异常，最自然的下一步就是「批量把这些单取消/改状态」——
 * 而这恰恰是错的：酒店行业里**已担保但尚未排房**是合法且常见的在途状态，
 * 排房本来就是入住当天（甚至到店时）才做的事。
 *
 * 评审原文要求：「先区分已担保但尚未排房的正常订单与异常历史数据……
 * 按营业日核对今日预抵、待排及可售。避免批量改状态。」
 * 本脚本就是把「分类依据」固化成可复跑的只读体检，而不是靠人肉看 63 行 SQL。
 *
 * ── 分类口径（三桶互斥 + 标记可叠加）──
 * 【正常】      未来入住、客房量够排、订单状态自洽 —— 属于正常在途预订，不许改任何状态
 * 【需要关注】  今日预抵（营业日）仍未排房 —— 今天就要处理，但不等于数据错
 * 【异常】      订单本身自相矛盾或历史残留 —— 才需要人工逐笔确认后处理：
 *                 A1 NO_SHOW_OVERDUE    整段住宿日期已过（离店日 < 营业日）却仍 CONFIRMED
 *                 A2 IN_WINDOW_NO_STAY  入住日已过、离店日未到，既没房号也没有住宿单
 *                 A3 BOOKING_STATE      主单已取消/失联/作废，明细还挂在 CONFIRMED
 *                 A4 ROOM_TYPE_MISSING  房型已被删除
 *                 A5 CAPACITY_SHORT     当夜该房型剩余可排房 < 待排间数（排不出房 / 超售）
 * 标记（不改变桶，只提示主数据/时效）：
 *                 · 渠道已停用（channels.enabled = 0）
 *                 · 临近预抵（营业日起 3 天内）
 *
 * ── 为什么「渠道已停用」不算订单异常 ──
 * channels.enabled 是渠道主数据的软删除标记（下线一个客源），历史订单保留
 * channel_id 是设计如此，订单本身仍然有效、仍要接待。把它算成「订单异常」
 * 会让 16/63 条正常单被误处理 —— 这正是评审要避免的一刀切。
 *
 * ── 只读保证 ──
 * 连接以 readOnly 打开；只有 SELECT。不建表、不补列、不改任何订单/明细状态。
 * 需要修数据时，按「异常」清单人工逐笔确认后再走前台页面操作，不提供批量入口。
 *
 * 用法：
 *   node scripts/audit-pending-details.mjs
 *   node scripts/audit-pending-details.mjs --json          # 机器可读
 *   node scripts/audit-pending-details.mjs --all           # 三类都打逐条清单
 *   node scripts/audit-pending-details.mjs --today=2026-11-25   # 指定营业日（复现历史）
 *   PMS_DB_PATH=/path/to/pms.db node scripts/audit-pending-details.mjs
 *   node scripts/audit-pending-details.mjs --strict        # 有「异常」时 exit 1（CI 用）
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const HOTEL_ID = Number(process.env.PMS_HOTEL_ID ?? 1);
const AS_JSON = process.argv.includes("--json");
const SHOW_ALL = process.argv.includes("--all");
const STRICT = process.argv.includes("--strict");

/** 营业日起算的「临近预抵」窗口（天）：排房前置工作通常提前 3 天做 */
const SOON_DAYS = 3;

/** 渠道类型 → 客源分类（与 /channels 页面的口径一致） */
const OTA_TYPES = new Set([
  "ctrip",
  "meituan",
  "qunar",
  "elong",
  "fliggy",
  "douyin",
  "meituan_homestay",
]);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ============================================================ 一、工具 */

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`✗ 找不到数据库：${DB_PATH}`);
    process.exit(2);
  }
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

const isoDay = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

function nights(a, b) {
  const ms = new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/* ============================================================ 二、取数（只读） */

/**
 * 营业日：settings.biz_day_cutoff（默认 05:00）
 * 酒店营业日不等于自然日 —— 凌晨 3 点还算「昨天」，所以 63 条到底算不算「今日预抵」
 * 必须用营业日判断，而不是 new Date()。口径与 src/lib/biz-date.ts 完全一致。
 */
function resolveBizDay(db, override) {
  if (override) return { day: override, source: "--today 参数" };
  const row = db
    .prepare(`SELECT value FROM settings WHERE hotel_id = ? AND key = 'biz_day_cutoff' LIMIT 1`)
    .get(HOTEL_ID);
  const cutoff = /^\d{2}:\d{2}$/.test(String(row?.value ?? "").trim())
    ? String(row.value).trim()
    : "00:00";
  const now = new Date();
  const [hh, mm] = cutoff.split(":").map((x) => Number(x) || 0);
  const d = new Date(now.getTime());
  if (d.getHours() * 60 + d.getMinutes() < hh * 60 + mm) d.setDate(d.getDate() - 1);
  return { day: isoDay(d), cutoff, source: `settings.biz_day_cutoff=${cutoff}` };
}

/**
 * 目标明细：booking_rooms 里 status=CONFIRMED 但 room_id 为空(或 0) 的房
 *
 * 主单状态一并带出来 —— 只看明细表会漏掉「主单已取消、明细没跟着改」这一类，
 * 而那正是评审点名要区分出来的异常。
 */
function loadRows(db) {
  const sql = `
    SELECT br.id                                    AS detail_id,
           br.booking_id,
           br.status                                AS detail_status,
           br.room_type_id,
           br.room_id,
           br.check_in_date,
           br.check_out_date,
           COALESCE(NULLIF(br.rate, 0), b.rate, 0)  AS rate,
           br.guest_name                            AS detail_guest,
           b.booking_no,
           b.status                                 AS booking_status,
           b.guest_name,
           b.mobile,
           b.channel_id,
           b.company_id,
           b.booking_type,
           b.team_name,
           b.guarantee,
           b.pay_type,
           b.deposit,
           b.arrival_time,
           b.created_at,
           b.check_in_date                          AS booking_check_in,
           b.check_out_date                         AS booking_check_out,
           b.room_id                                AS booking_room_id,
           c.name                                   AS channel_name,
           c.channel_type,
           c.enabled                                AS channel_enabled,
           rt.name                                  AS room_type_name
      FROM booking_rooms br
      JOIN bookings b   ON b.id = br.booking_id
      LEFT JOIN channels c  ON c.id = b.channel_id
      LEFT JOIN room_types rt ON rt.id = br.room_type_id
     WHERE br.hotel_id = ?
       AND br.status = 'CONFIRMED'
       AND (br.room_id IS NULL OR br.room_id = 0)
     ORDER BY br.check_in_date, br.id`;

  return db.prepare(sql).all(HOTEL_ID).map((r) => ({
    ...r,
    nights: nights(r.check_in_date, r.check_out_date),
    amount: round2(Number(r.rate ?? 0) * nights(r.check_in_date, r.check_out_date)),
    guest: r.detail_guest || r.guest_name || "",
  }));
}

/** 每个房型的物理房量（排除维修 OOO / 锁房 LOCK），与 src/lib/room-stock.ts 同口径 */
function loadCapacity(db) {
  const rows = db
    .prepare(
      `SELECT room_type_id AS rt,
              SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END) AS capacity,
              SUM(CASE WHEN status = 'OOO' THEN 1 ELSE 0 END) AS ooo,
              SUM(CASE WHEN status = 'LOCK' THEN 1 ELSE 0 END) AS lock
         FROM rooms WHERE hotel_id = ? GROUP BY room_type_id`
    )
    .all(HOTEL_ID);
  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.rt), {
      capacity: Number(r.capacity ?? 0),
      ooo: Number(r.ooo ?? 0),
      lock: Number(r.lock ?? 0),
    });
  }
  return map;
}

/**
 * 某一天某房型的「剩余可排房」= 物理可售 − 已排房 − 人在住
 *
 * 注意与 src/lib/room-stock.ts 的 todayRoomTypeStock 的区别：那个函数按
 * `rooms.status` 判断在住，只能算「今天」。算未来某一晚时今天的房态没有意义，
 * 所以在住改成按 stays 的住期与当晚是否重叠来判断，已排房量按 booking_rooms 计。
 * 未排房的明细不计入「已排」—— 它正是要被排进去的那批。
 */
function loadOccupancyOn(db, day) {
  const assigned = new Map();
  for (const r of db
    .prepare(
      `SELECT br.room_type_id AS rt, COUNT(*) AS cnt
         FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
        WHERE br.hotel_id = ?
          AND br.status IN ('PENDING','CONFIRMED')
          AND b.status  IN ('PENDING','CONFIRMED')
          AND br.room_id IS NOT NULL AND br.room_id > 0
          AND br.check_in_date <= ? AND br.check_out_date > ?
        GROUP BY br.room_type_id`
    )
    .all(HOTEL_ID, day, day)) {
    assigned.set(Number(r.rt), Number(r.cnt ?? 0));
  }

  const inhouse = new Map();
  for (const r of db
    .prepare(
      `SELECT rm.room_type_id AS rt, COUNT(*) AS cnt
         FROM stays s
         JOIN rooms rm ON rm.id = s.room_id
        WHERE s.hotel_id = ?
          AND s.status = 'INHOUSE'
          AND substr(s.check_in_time, 1, 10) <= ?
          AND COALESCE(s.expect_check_out, '9999-12-31') > ?
        GROUP BY rm.room_type_id`
    )
    .all(HOTEL_ID, day, day)) {
    inhouse.set(Number(r.rt), Number(r.cnt ?? 0));
  }
  return { assigned, inhouse };
}

/* ============================================================ 三、分类 */

const SEVERITY = {
  NO_SHOW_OVERDUE: "高",
  IN_WINDOW_NO_STAY: "高",
  BOOKING_STATE: "高",
  ROOM_TYPE_MISSING: "中",
  CAPACITY_SHORT: "中",
  DUE_TODAY: "中",
  NORMAL: "低",
};

/** 异常逐条处置建议：一律「人工确认后再改」，不提供批量入口 */
const ADVICE = {
  NO_SHOW_OVERDUE: (r) =>
    `整段住宿（${r.check_in_date}~${r.check_out_date}）已过且从未排房、无住宿单。` +
    `先联系客人/渠道确认是否到店；确认未到的按「不能到店/失约(NO-SHOW)」结案，` +
    `确认来过的补建住宿单并补排房。两件事都要逐笔做，不要批量改状态。`,
  IN_WINDOW_NO_STAY: (r) =>
    `入住日已过、离店日（${r.check_out_date}）未到，既没房号也没有住宿单 —— ` +
    `客人可能已经在店里却没建单。立即核对当日到店登记与监控；在店则补排房+补建住宿单，` +
    `未到店则按 NO-SHOW 结案（今日 12:00 前处理）。`,
  BOOKING_STATE: (r) =>
    `主单已是 ${r.booking_status}，明细还挂在 CONFIRMED。先核对主单的实际去向与对应流水` +
    `（取消 / 失联 / 离店），确认后把该明细同步成同一状态（逐笔），并检查渠道侧是否已回传取消。`,
  ROOM_TYPE_MISSING: () =>
    `原房型已被删除，明细挂着的房型不存在。核对订单原始房型后改排到在售房型（逐笔）。`,
  CAPACITY_SHORT: (r) =>
    `当夜「${r.room_type_name}」剩余可排房 ${r.free_rooms} 间 < 待排 ${r.need_rooms} 间：` +
    `排不出房。先看能否升级/换房型或与渠道协调，不要硬排造成超售。`,
  DUE_TODAY: () =>
    `今日预抵还没排房。属于今天的前台排房工作，按到店时间先后排房即可 —— 订单本身没问题，不需要改状态。`,
};

/**
 * 分类主函数
 *
 * 判定顺序即优先级：先看「订单本身是否自相矛盾/历史残留」，再看「今天要不要处理」，
 * 最后才看主数据标记。顺序不对就会出现「已取消的单被算成今日预抵」这种结论。
 */
function classify(db, rows, bizDay) {
  const capacity = loadCapacity(db);
  const roomTypeIds = new Set(
    db.prepare(`SELECT id FROM room_types WHERE hotel_id = ?`).all(HOTEL_ID).map((r) => Number(r.id))
  );

  /* 先按「营业日 + 房型」把待排间数聚起来，容量判断要的是当天全房型的待排总量，
     不是单条明细 —— 同一晚同房型 3 条明细挤 1 间房，单看每一条都「排得出」。 */
  const needByKey = new Map();
  for (const r of rows) {
    const key = `${r.check_in_date}|${r.room_type_id}`;
    needByKey.set(key, (needByKey.get(key) ?? 0) + 1);
  }
  const occupancy = new Map(); // day → { assigned, inhouse, free }
  const freeRoomsFor = (day, roomTypeId) => {
    if (!occupancy.has(day)) occupancy.set(day, loadOccupancyOn(db, day));
    const occ = occupancy.get(day);
    const cap = capacity.get(Number(roomTypeId));
    if (!cap) return 0;
    return (
      cap.capacity -
      (occ.assigned.get(Number(roomTypeId)) ?? 0) -
      (occ.inhouse.get(Number(roomTypeId)) ?? 0)
    );
  };

  const soonTo = addDays(bizDay, SOON_DAYS);

  for (const r of rows) {
    const marks = [];

    /* ---------- 主数据标记（不改变桶） ---------- */
    if (Number(r.channel_enabled) === 0) marks.push("渠道已停用");
    if (r.channel_id === null || r.channel_id === undefined) marks.push("无客源渠道");
    if (r.check_in_date > bizDay && r.check_in_date <= soonTo) marks.push(`临近预抵(${SOON_DAYS}天内)`);
    if (r.guarantee) marks.push(`已担保(${r.guarantee})`);

    /* ---------- 桶判定 ---------- */
    let bucket = "NORMAL";
    let code = "NORMAL";
    let reason = "";

    if (r.booking_status !== "CONFIRMED" && r.booking_status !== "PENDING") {
      bucket = "ANOMALY";
      code = "BOOKING_STATE";
      reason = `主单 ${r.booking_status}，明细仍 CONFIRMED`;
    } else if (r.room_type_id === null || r.room_type_id === undefined || !roomTypeIds.has(Number(r.room_type_id))) {
      bucket = "ANOMALY";
      code = "ROOM_TYPE_MISSING";
      reason = "房型不存在（已删除）";
    } else if (r.check_out_date < bizDay) {
      bucket = "ANOMALY";
      code = "NO_SHOW_OVERDUE";
      reason = `整段住宿已过（${r.check_in_date}~${r.check_out_date} < 营业日 ${bizDay}）`;
    } else if (r.check_in_date < bizDay) {
      bucket = "ANOMALY";
      code = "IN_WINDOW_NO_STAY";
      reason = `入住日已过但离店日未到（${r.check_in_date}~${r.check_out_date}）`;
    } else {
      const free = freeRoomsFor(r.check_in_date, r.room_type_id);
      const need = needByKey.get(`${r.check_in_date}|${r.room_type_id}`) ?? 1;
      if (free < need) {
        bucket = "ANOMALY";
        code = "CAPACITY_SHORT";
        reason = `当夜剩余可排房 ${free} 间 < 待排 ${need} 间`;
        r.free_rooms = free;
        r.need_rooms = need;
      } else if (r.check_in_date === bizDay) {
        bucket = "ATTENTION";
        code = "DUE_TODAY";
        reason = "今日预抵，尚未排房";
      } else {
        bucket = "NORMAL";
        code = "NORMAL";
        reason = `未来入住（${r.check_in_date}），属正常在途预订`;
      }
    }

    r.bucket = bucket;
    r.code = code;
    r.reason = reason;
    r.marks = marks;
    r.severity = SEVERITY[code] ?? "低";
    r.advice = ADVICE[code] ? ADVICE[code](r) : "";
  }

  const pick = (b) => rows.filter((r) => r.bucket === b);
  const sum = (list, f) => round2(list.reduce((s, r) => s + f(r), 0));

  const stat = (list) => ({
    count: list.length,
    nights: list.reduce((s, r) => s + r.nights, 0),
    amount: sum(list, (r) => r.amount),
  });

  const normal = pick("NORMAL");
  const attention = pick("ATTENTION");
  const anomaly = pick("ANOMALY");

  /* 正常桶的客源细分：渠道单 / 直销·线下 / 无渠道；团队单单列 */
  const bySource = { 渠道单: [], 直连直销: [], 线下其他: [], 无渠道: [] };
  for (const r of normal) {
    const t = String(r.channel_type ?? "");
    if (r.channel_id === null || r.channel_id === undefined) bySource.无渠道.push(r);
    else if (OTA_TYPES.has(t)) bySource.渠道单.push(r);
    else if (t === "direct") bySource.直连直销.push(r);
    else bySource.线下其他.push(r);
  }
  const teams = normal.filter((r) => (r.team_name ?? "") !== "" || r.booking_type === "team");

  /* 异常按 code 分组 */
  const byCode = new Map();
  for (const r of anomaly) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  /* 标记汇总（可叠加，不改变桶） */
  const marked = {
    渠道已停用: rows.filter((r) => r.marks.includes("渠道已停用")),
    临近预抵: rows.filter((r) => r.marks.some((m) => m.startsWith("临近预抵"))),
    已担保: rows.filter((r) => r.marks.some((m) => m.startsWith("已担保"))),
  };

  return {
    rows,
    normal,
    attention,
    anomaly,
    byCode,
    bySource,
    teams,
    marked,
    stat,
    meta: { needByKey, soonTo },
  };
}

/* ============================================================ 四、营业日核对（今日预抵 / 待排 / 可售） */

/**
 * 评审要求「按营业日核对今日预抵、待排及可售」。
 * 这里是独立于上面 63 条的另一套数：63 条只是「已确认未排房」，
 * 而今日的工作面还包括 PENDING 未排、已排房、以及全店可售房量。
 */
function bizDayCheck(db, bizDay, capacity) {
  const arrivals = db
    .prepare(
      `SELECT br.status                                   AS detail_status,
              CASE WHEN br.room_id IS NULL OR br.room_id = 0 THEN 0 ELSE 1 END AS assigned,
              COUNT(*)                                    AS cnt
         FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id
        WHERE br.hotel_id = ?
          AND br.check_in_date = ?
          AND br.status IN ('PENDING','CONFIRMED')
          AND b.status  IN ('PENDING','CONFIRMED')
        GROUP BY br.status, assigned`
    )
    .all(HOTEL_ID, bizDay);

  const today = { total: 0, assigned: 0, unassigned: 0, pending: 0, confirmed: 0 };
  for (const r of arrivals) {
    const c = Number(r.cnt ?? 0);
    today.total += c;
    if (Number(r.assigned) === 1) today.assigned += c;
    else today.unassigned += c;
    if (r.detail_status === "PENDING") today.pending += c;
    else today.confirmed += c;
  }

  const inWindow = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id
        WHERE br.hotel_id = ?
          AND (br.room_id IS NULL OR br.room_id = 0)
          AND br.status = 'CONFIRMED'
          AND b.status IN ('PENDING','CONFIRMED')
          AND br.check_in_date <= ? AND br.check_out_date > ?`
    )
    .get(HOTEL_ID, bizDay, bizDay);

  const soon = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id
        WHERE br.hotel_id = ?
          AND (br.room_id IS NULL OR br.room_id = 0)
          AND br.status IN ('PENDING','CONFIRMED')
          AND b.status IN ('PENDING','CONFIRMED')
          AND br.check_in_date > ? AND br.check_in_date <= ?`
    )
    .get(HOTEL_ID, bizDay, addDays(bizDay, SOON_DAYS));

  const totals = { capacity: 0, ooo: 0, lock: 0 };
  for (const v of capacity.values()) {
    totals.capacity += v.capacity;
    totals.ooo += v.ooo;
    totals.lock += v.lock;
  }

  return {
    bizDay,
    arrivals: today,
    inWindowUnassigned: Number(inWindow?.c ?? 0),
    soonUnassigned: Number(soon?.c ?? 0),
    soonTo: addDays(bizDay, SOON_DAYS),
    rooms: totals,
  };
}

/* ============================================================ 五、打印 */

const pad = (s, n) => String(s).padEnd(n);
const money = (n) => `¥${Number(n).toFixed(2)}`;

function line(char = "─", n = 66) {
  return char.repeat(n);
}

function printList(list, indent = "  ") {
  for (const r of list) {
    console.log(
      `${indent}· 明细#${pad(r.detail_id, 6)} ${pad(r.booking_no, 34)} ` +
        `${r.check_in_date}~${r.check_out_date} ${pad(r.room_type_name ?? "房型已删", 12)} ` +
        `${pad(r.channel_name ?? "无渠道", 8)} ${pad(r.nights + "晚", 5)} ${money(r.amount)}` +
        (r.marks.length ? `  [${r.marks.join("/")}]` : "")
    );
  }
}

function printHuman(data) {
  const { rows, normal, attention, anomaly, byCode, bySource, teams, marked, stat, biz, bizDayInfo } = data;

  console.log("");
  console.log(line("="));
  console.log(`未排房已确认明细体检（只读）  共 ${rows.length} 条`);
  console.log(line("="));
  console.log(`  库文件    ${DB_PATH}`);
  console.log(`  门店      hotel_id=${HOTEL_ID}`);
  console.log(`  营业日    ${biz.bizDay}（${bizDayInfo}）`);
  console.log(`  判定依据  booking_rooms.status='CONFIRMED' 且 room_id 为空/0`);
  console.log("");

  /* ---------- 汇总 ---------- */
  const sN = stat(normal);
  const sA = stat(attention);
  const sX = stat(anomaly);
  console.log(line("-"));
  console.log("一、三桶汇总（互斥，一条明细只进一个桶）");
  console.log(line("-"));
  console.log(`  【正常】      ${pad(sN.count + " 条", 7)} 间夜 ${pad(sN.nights, 4)}  房费 ${money(sN.amount)}   → 不改任何状态`);
  console.log(`  【需要关注】  ${pad(sA.count + " 条", 7)} 间夜 ${pad(sA.nights, 4)}  房费 ${money(sA.amount)}   → 今日排房工作`);
  console.log(`  【异常】      ${pad(sX.count + " 条", 7)} 间夜 ${pad(sX.nights, 4)}  房费 ${money(sX.amount)}   → 人工逐笔确认`);
  console.log(`  合计          ${pad(rows.length + " 条", 7)} 间夜 ${pad(sN.nights + sA.nights + sX.nights, 4)}  房费 ${money(round2(sN.amount + sA.amount + sX.amount))}`);
  console.log("");
  console.log("  ※ 本脚本只读：不修改任何订单/明细状态，也不提供批量修改入口。");
  console.log("");

  /* ---------- 正常 ---------- */
  console.log(line("-"));
  console.log(`二、正常 · ${sN.count} 条 ｜ 间夜 ${sN.nights} ｜ 房费 ${money(sN.amount)}`);
  console.log(line("-"));
  console.log("  为什么算正常：入住日在营业日之后、房型在售、当夜剩余可排房 ≥ 当日待排间数。");
  console.log("  已担保未排房是行业常态 —— 排房本来就在临近入住时才做，不需要改单。");
  for (const [k, v] of Object.entries(bySource)) {
    if (v.length === 0) continue;
    const s = stat(v);
    const chans = [...new Set(v.map((r) => r.channel_name ?? "无渠道"))];
    console.log(
      `    · ${pad(k, 6)} ${pad(v.length + " 条", 7)} 间夜 ${pad(s.nights, 4)} ${money(s.amount)}` +
        `  来源：${chans.slice(0, 8).join(" / ")}${chans.length > 8 ? " …" : ""}`
    );
  }
  console.log(`    · 团队单  ${teams.length} 条（team_name 非空或 booking_type=team）`);
  if (SHOW_ALL) printList(normal);
  console.log("");

  /* ---------- 需要关注 ---------- */
  const notYetDue = normal.filter((r) => r.check_in_date <= biz.soonTo);
  console.log(line("-"));
  console.log(`三、需要关注 · ${sA.count} 条 ｜ 间夜 ${sA.nights} ｜ 房费 ${money(sA.amount)}`);
  console.log(line("-"));
  console.log(`  口径：营业日 ${biz.bizDay} 当天预抵（check_in_date = 营业日）却仍未排房。`);
  if (sA.count === 0) {
    console.log(`  ✔ 今天没有预抵未排房的已确认明细。`);
    console.log(
      `  ℹ 未来 ${SOON_DAYS} 天内（≤ ${biz.soonTo}）另有 ${notYetDue.length} 条预抵待排，` +
        `属于正常的排房前置工作，已计入「正常」桶（见标记「临近预抵」）。`
    );
    const due = biz.arrivals;
    console.log(
      `  ℹ 今日预抵工作面对账：明细 ${due.total} 行 = 已排 ${due.assigned} + 待排 ${due.unassigned}` +
        `（其中 CONFIRMED ${due.confirmed} / PENDING ${due.pending}）`
    );
  } else {
    const urgent = attention.filter((r) => {
      /* 距入住不足 6 小时：入住时刻按 settings.check_in_time，默认 14:00 */
      const t = data.checkInTime;
      const arrive = new Date(`${r.check_in_date}T${t}:00`);
      const hours = (arrive.getTime() - Date.now()) / 3600000;
      r.hoursToArrival = Math.round(hours * 10) / 10;
      return hours <= 6;
    });
    console.log(`  · 今日预抵未排房 ${sA.count} 条`);
    if (urgent.length > 0) console.log(`  · 其中 ${urgent.length} 条距入住时刻已不足 6 小时（入住时刻 ${data.checkInTime}）`);
    printList(attention);
  }
  console.log("");

  /* ---------- 异常 ---------- */
  console.log(line("-"));
  console.log(`四、异常 · ${sX.count} 条 ｜ 间夜 ${sX.nights} ｜ 房费 ${money(sX.amount)}`);
  console.log(line("-"));
  const CODE_LABEL = {
    NO_SHOW_OVERDUE: "整段住宿日期已过，仍 CONFIRMED 且从未排房",
    IN_WINDOW_NO_STAY: "入住日已过、离店日未到，无房号无住宿单",
    BOOKING_STATE: "主单状态已不是确认/待排（取消、失联、离店等），明细仍 CONFIRMED",
    ROOM_TYPE_MISSING: "房型已被删除",
    CAPACITY_SHORT: "当夜该房型剩余可排房不足（排不出房）",
  };
  if (sX.count === 0) {
    console.log("  ✔ 没有订单级异常。");
  } else {
    for (const [code, list] of byCode) {
      const s = stat(list);
      console.log(`  · ${pad(CODE_LABEL[code] ?? code, 34)} ${list.length} 条   间夜 ${s.nights}   ${money(s.amount)}`);
    }
    console.log("");
    console.log("  ▼ 逐条清单 + 建议处理方式（都要人工确认后再改，禁止批量）");
    for (const [code, list] of byCode) {
      console.log(`  ┌─ [${code}] ${CODE_LABEL[code] ?? code} · 严重度 ${SEVERITY[code]}`);
      for (const r of list) {
        console.log(
          `  │ 明细#${r.detail_id}  单号 ${r.booking_no}  客人 ${r.guest || "-"}  ${r.mobile || ""}`
        );
        console.log(
          `  │   房型 ${r.room_type_name ?? "（已删除）"}  ${r.check_in_date}~${r.check_out_date} ` +
            `${r.nights} 晚  房价 ${money(r.rate)}  房费 ${money(r.amount)}  渠道 ${r.channel_name ?? "无"}`
        );
        console.log(`  │   现状 ${r.reason}${r.marks.length ? ` ［${r.marks.join(" / ")}］` : ""}`);
        console.log(`  │   建议 ${r.advice}`);
        console.log("  │");
      }
      console.log("  └─");
    }
  }
  console.log("");

  /* ---------- 标记层 ---------- */
  console.log(line("-"));
  console.log("五、标记（可叠加，不改变桶；这些≠订单异常）");
  console.log(line("-"));
  for (const [name, list] of Object.entries(marked)) {
    if (list.length === 0) continue;
    const s = stat(list);
    const inNormal = list.filter((r) => r.bucket === "NORMAL").length;
    console.log(
      `  · ${pad(name, 8)} ${pad(list.length + " 条", 7)} 间夜 ${pad(s.nights, 4)} ${money(s.amount)}` +
        `   其中正常单 ${inNormal} 条`
    );
  }
  const disabled = marked.渠道已停用;
  if (disabled.length > 0) {
    const chans = {};
    for (const r of disabled) chans[r.channel_name ?? "无渠道"] = (chans[r.channel_name ?? "无渠道"] ?? 0) + 1;
    console.log("");
    console.log(
      `  ℹ 渠道已停用 = channels.enabled=0 的客源渠道（${Object.entries(chans).map(([k, v]) => `${k} ${v}`).join(" / ")}）。`
    );
    console.log(
      "    这是渠道主数据的软删除标记，历史订单保留 channel_id 属于设计如此；订单仍然要接待，" +
        "只需在「渠道直连」里核对主数据，不要改订单状态。"
    );
  }
  console.log("");

  /* ---------- 营业日核对 ---------- */
  console.log(line("-"));
  console.log(`六、营业日核对（${biz.bizDay}）：今日预抵 / 待排 / 可售`);
  console.log(line("-"));
  const a = biz.arrivals;
  console.log(`  今日预抵明细   ${a.total} 行 = 已排房 ${a.assigned} + 待排房 ${a.unassigned}`);
  console.log(`  状态构成       CONFIRMED ${a.confirmed} / PENDING ${a.pending}`);
  console.log(`  在住窗口未排   ${biz.inWindowUnassigned} 条（入住日 ≤ 今天 < 离店日，仍无房号）`);
  console.log(`  ${SOON_DAYS} 天内预抵待排 ${biz.soonUnassigned} 条（今天之后 ~ ${biz.soonTo}）`);
  console.log(
    `  房量          物理 ${biz.rooms.capacity} 间 − 维修 ${biz.rooms.ooo} − 锁房 ${biz.rooms.lock}` +
      ` = 可售上限 ${biz.rooms.capacity - biz.rooms.ooo - biz.rooms.lock} 间`
  );
  console.log("");

  /* ---------- 结论 ---------- */
  console.log(line("="));
  console.log("结论");
  console.log(line("="));
  console.log(
    `  ${rows.length} 条里，${sN.count} 条是正常在途预订、${sA.count} 条是今天的排房工作、` +
      `只有 ${sX.count} 条是订单级异常。`
  );
  console.log(`  → 正常 + 需要关注这 ${sN.count + sA.count} 条**不要改状态**；`);
  console.log(`  → 异常 ${sX.count} 条按上面的逐条清单人工确认后再处理；`);
  console.log(`  → 渠道已停用 ${disabled.length} 条属于主数据问题，与订单一律无关。`);
  console.log("");
  console.log("  本脚本只读，未修改任何订单状态或房间号。");
  console.log("");
}

function printJson(data) {
  const { rows, normal, attention, anomaly, byCode, stat, biz, marked } = data;
  const sN = stat(normal);
  const sA = stat(attention);
  const sX = stat(anomaly);
  const slim = (r) => ({
    detail_id: r.detail_id,
    booking_id: r.booking_id,
    booking_no: r.booking_no,
    booking_status: r.booking_status,
    detail_status: r.detail_status,
    guest: r.guest,
    room_type: r.room_type_name,
    channel: r.channel_name,
    check_in_date: r.check_in_date,
    check_out_date: r.check_out_date,
    nights: r.nights,
    rate: round2(r.rate),
    amount: r.amount,
    bucket: r.bucket,
    code: r.code,
    severity: r.severity,
    reason: r.reason,
    marks: r.marks,
    advice: r.advice,
  });
  const out = {
    generated_at: new Date().toISOString(),
    db: DB_PATH,
    hotel_id: HOTEL_ID,
    biz_day: biz.bizDay,
    total: rows.length,
    buckets: {
      normal: { ...sN, rows: normal.map(slim) },
      attention: { ...sA, rows: attention.map(slim) },
      anomaly: {
        ...sX,
        by_code: Object.fromEntries([...byCode].map(([k, v]) => [k, { ...stat(v), rows: v.map(slim) }])),
      },
    },
    marks: Object.fromEntries(Object.entries(marked).map(([k, v]) => [k, { count: v.length, rows: v.map((r) => r.detail_id) }])),
    biz_day_check: biz,
    read_only: true,
  };
  console.log(JSON.stringify(out, null, 2));
}

/* ============================================================ 六、入口 */

function main() {
  const db = openDb();
  const bizDayInfo = resolveBizDay(db, argValue("--today"));
  const bizDay = bizDayInfo.day;

  /* 入住时刻（settings.check_in_time），用于「距入住不足 N 小时」 */
  const checkInRow = db
    .prepare(`SELECT value FROM settings WHERE hotel_id = ? AND key = 'check_in_time' LIMIT 1`)
    .get(HOTEL_ID);
  const checkInTime = /^\d{2}:\d{2}$/.test(String(checkInRow?.value ?? "").trim())
    ? String(checkInRow.value).trim()
    : "14:00";

  const rows = loadRows(db);
  const capacity = loadCapacity(db);
  const data = classify(db, rows, bizDay);
  data.biz = bizDayCheck(db, bizDay, capacity);
  data.bizDayInfo = bizDayInfo.source;
  data.checkInTime = checkInTime;

  if (AS_JSON) printJson(data);
  else printHuman(data);

  db.close();

  if (STRICT && data.anomaly.length > 0) {
    console.error(`✗ --strict：存在 ${data.anomaly.length} 条订单级异常，退出码 1`);
    process.exit(1);
  }
}

main();
