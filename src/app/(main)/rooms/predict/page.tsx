import Link from "next/link";
import { redirect } from "next/navigation";
import { PredictTable } from "@/components/PredictTable";
import { type OrderListCell } from "@/components/OrderListDialog";

import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

type TypeRow = { id: number; name: string; code: string; total: number; ooo: number; lock: number };
type StayRow = { room_type_id: number; check_in_date: string | null; out_date: string | null };
type RevenueRow = { type_id: number; biz_date: string; revenue: number | null };

type Search = {
  start?: string;
  end?: string;
  type?: string;
  submitted?: string;
  occ?: string;
  ooo?: string;
  adr?: string;
  revpar?: string;
  yest?: string;
  view?: string;
};

const MAX_DAYS = 31;
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function isYmd(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function ymd(d: Date) {
  return todayStr(d);
}

function monthStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function monthEnd(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function isBetween(from: string | null, to: string | null, day: string) {
  if (!from || !to) return false;
  return from <= day && day < to;
}

export default async function PredictPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  // 房间维度视图已下线，统一回到房型可售
  if (sp.view === "room") redirect("/rooms/predict");

  // —— 日期范围（默认今天起 16 天，最多 31 天）——
  const today = todayStr();
  const start = isYmd(sp.start) ? sp.start : today;
  let end = isYmd(sp.end) ? sp.end : todayStr(addDays(new Date(`${today}T00:00:00`), 15));
  if (end < start) end = start;
  const startDate = new Date(`${start}T00:00:00`);
  const rawDays = Math.round((new Date(`${end}T00:00:00`).getTime() - startDate.getTime()) / 86400000) + 1;
  const dayCount = Math.min(Math.max(rawDays, 1), MAX_DAYS);
  const endDate = addDays(startDate, dayCount - 1);
  const endStr = ymd(endDate);

  // —— 复选框：首次进入有默认值，提交后以勾选状态为准 ——
  // 去呼呼把「平均房价(ADR)」和「客房收益(RevPAR)」合成一个复选框，勾上就同时显示两行
  const submitted = sp.submitted === "1";
  const showOcc = submitted ? sp.occ === "1" : true;
  const showOOO = submitted ? sp.ooo === "1" : false;
  const showADR = submitted ? sp.adr === "1" : true;
  const showRevpar = showADR;
  const showYest = submitted ? sp.yest === "1" : false;

  const dayList = Array.from({ length: dayCount }, (_, i) => ymd(addDays(startDate, i)));
  const columns = showYest ? [ymd(addDays(startDate, -1)), ...dayList] : dayList;

  // —— 数据：房量 / 在住 / 未入住预订 / 房费 ——
  const types = all<TypeRow>(
    `SELECT rt.id, rt.name, rt.code,
            COUNT(r.id) AS total,
            SUM(CASE WHEN r.status = 'OOO' THEN 1 ELSE 0 END) AS ooo,
            SUM(CASE WHEN r.status = 'LOCK' THEN 1 ELSE 0 END) AS "lock"
     FROM room_types rt
     LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = rt.hotel_id
     WHERE rt.hotel_id = ?
     GROUP BY rt.id ORDER BY rt.sort`,
    [hotelId]
  );

  const selectedTypeId = sp.type && sp.type !== "" ? Number(sp.type) : null;
  const rows = selectedTypeId && types.some((t) => t.id === selectedTypeId)
    ? types.filter((t) => t.id === selectedTypeId)
    : types;

  const stays = all<StayRow>(
    `SELECT r.room_type_id, date(s.check_in_time) AS check_in_date, s.expect_check_out AS out_date
     FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'`,
    [hotelId]
  );

  /*
   * 预订占用：**按「间」展开，不按「单」算**
   *
   * 原来这里是 `for (const b of bookings) … occupied++` —— 一张订单只算 1 间。
   * 多房订单（一张单订 3 间：room_count = 3、主单只填了首间、明细 3 行）
   * 于是只扣 1 间 → 可售多算 2 间 → 前台按这个数字排房就会超卖。
   * 实测 BK-MULTI3（11-25 → 11-27）改前每天只扣 1 间，正确是 3 间。
   *
   * 权威来源是 `booking_rooms` 明细（一行 = 一间房），没有明细的老订单才退回主单：
   *   · 明细行                      → 每行 1 间
   *   · 主单 room_id 有值（无明细）  → 1 间
   *   · 主单 room_id 为空（无明细）  → room_count 间
   * 与 `src/lib/room-stock.ts` 的 booked 口径逐条一致（房态页今日可售用的是那一套）。
   *
   * ── 这一份数据同时是「占用 N」计数和「占用」弹窗的唯一来源 ──
   * 弹窗原来另查一套 SQL（主单 1 行 + 主单房型），于是行数和数字对不上。
   * 现在 unit 里多带客人 / 渠道 / 单号 / 房号等展示字段，
   * 计数只读 room_type_id / check_in_date / check_out_date 三个字段（与改前完全一致），
   * 弹窗读同一批 unit —— 两边不可能再分叉。
   */
  type BookingUnit = {
    /* ---- 计数只用这三项（字段名与改前一致） ---- */
    room_type_id: number;
    check_in_date: string;
    check_out_date: string;
    /* ---- 以下只给「占用」弹窗展示用，不参与任何计数 ---- */
    booking_id: number;
    booking_no: string;
    guest_name: string | null;
    mobile: string | null;
    rate: number;
    remark: string | null;
    channel_name: string | null;
    status: string;
    room_id: number | null;
    room_no: string | null;
    /** 本单内第几间 / 共几间（弹窗说明这一行是订单里的哪一间） */
    index: number;
    total: number;
    /** 主单兜底补出来的（没有有效明细行） */
    virtual: boolean;
  };
  const bookingUnits: BookingUnit[] = (() => {
    const units: BookingUnit[] = [];
    /* 1) 明细优先：一行 = 一间房。房型按「明细 → 房间 → 主单」依次兜底 */
    let detailRows: {
      type_id: number | null;
      check_in_date: string | null;
      check_out_date: string | null;
      booking_id: number;
      booking_no: string;
      guest_name: string | null;
      mobile: string | null;
      rate: number | null;
      remark: string | null;
      channel_name: string | null;
      status: string;
      room_id: number | null;
      room_no: string | null;
    }[] = [];
    try {
      detailRows = all<{
        type_id: number | null;
        check_in_date: string | null;
        check_out_date: string | null;
        booking_id: number;
        booking_no: string;
        guest_name: string | null;
        mobile: string | null;
        rate: number | null;
        remark: string | null;
        channel_name: string | null;
        status: string;
        room_id: number | null;
        room_no: string | null;
      }>(
        `SELECT COALESCE(r.room_type_id, br.room_type_id, b.room_type_id) AS type_id,
                COALESCE(substr(br.check_in_date, 1, 10), b.check_in_date) AS check_in_date,
                COALESCE(substr(br.check_out_date, 1, 10), b.check_out_date) AS check_out_date,
                b.id AS booking_id, b.booking_no,
                COALESCE(br.guest_name, b.guest_name) AS guest_name,
                COALESCE(br.mobile, b.mobile) AS mobile,
                COALESCE(br.rate, b.rate, 0) AS rate,
                b.remark, c.name AS channel_name, b.status,
                br.room_id, r.room_no
           FROM booking_rooms br
           JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
           LEFT JOIN rooms r ON r.id = br.room_id AND r.hotel_id = br.hotel_id
           LEFT JOIN channels c ON c.id = b.channel_id
          WHERE br.hotel_id = ?
            AND br.status IN ('PENDING','CONFIRMED')
            AND b.status IN ('PENDING','CONFIRMED')
            AND b.check_in_date <= ? AND b.check_out_date >= ?`,
        [hotelId, columns[columns.length - 1] ?? today, columns[0] ?? today]
      );
    } catch {
      /* booking_rooms 是老库的迁移表：缺表时退回只用主单 */
    }
    /* 每张单的有效明细行数：用于「第 i/N 间」（无效行不参与，与下面的 continue 一致） */
    const detailTotal = new Map<number, number>();
    for (const row of detailRows) {
      if (row.type_id === null || !row.check_in_date || !row.check_out_date) continue;
      detailTotal.set(row.booking_id, (detailTotal.get(row.booking_id) ?? 0) + 1);
    }
    const detailSeen = new Map<number, number>();
    for (const row of detailRows) {
      if (row.type_id === null || !row.check_in_date || !row.check_out_date) continue;
      const index = (detailSeen.get(row.booking_id) ?? 0) + 1;
      detailSeen.set(row.booking_id, index);
      units.push({
        room_type_id: Number(row.type_id),
        check_in_date: row.check_in_date,
        check_out_date: row.check_out_date,
        booking_id: row.booking_id,
        booking_no: row.booking_no,
        guest_name: row.guest_name,
        mobile: row.mobile,
        rate: Number(row.rate ?? 0),
        remark: row.remark,
        channel_name: row.channel_name,
        status: row.status,
        room_id: row.room_id,
        room_no: row.room_no,
        index,
        total: Math.max(1, detailTotal.get(row.booking_id) ?? 1),
        virtual: false,
      });
    }
    /* 2) 没有有效明细行的老预订：主单兜底 */
    const mainRows = all<{
      type_id: number | null;
      room_id: number | null;
      room_count: number | null;
      check_in_date: string;
      check_out_date: string;
      booking_id: number;
      booking_no: string;
      guest_name: string | null;
      mobile: string | null;
      rate: number | null;
      remark: string | null;
      channel_name: string | null;
      status: string;
      room_no: string | null;
    }>(
      `SELECT COALESCE(r.room_type_id, b.room_type_id) AS type_id, b.room_id,
              COALESCE(b.room_count, 1) AS room_count,
              b.check_in_date, b.check_out_date,
              b.id AS booking_id, b.booking_no, b.guest_name, b.mobile,
              COALESCE(b.rate, 0) AS rate, b.remark, c.name AS channel_name,
              b.status, r.room_no
         FROM bookings b
         LEFT JOIN rooms r ON r.id = b.room_id AND r.hotel_id = b.hotel_id
         LEFT JOIN channels c ON c.id = b.channel_id
        WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
          AND b.check_in_date <= ? AND b.check_out_date >= ?
          AND NOT EXISTS (SELECT 1 FROM booking_rooms br
                           WHERE br.booking_id = b.id AND br.status IN ('PENDING','CONFIRMED'))`,
      [hotelId, columns[columns.length - 1] ?? today, columns[0] ?? today]
    );
    for (const row of mainRows) {
      if (row.type_id === null) continue;
      const n = row.room_id ? 1 : Math.max(1, Number(row.room_count ?? 1));
      for (let k = 0; k < n; k += 1) {
        units.push({
          room_type_id: Number(row.type_id),
          check_in_date: row.check_in_date,
          check_out_date: row.check_out_date,
          booking_id: row.booking_id,
          booking_no: row.booking_no,
          guest_name: row.guest_name,
          mobile: row.mobile,
          rate: Number(row.rate ?? 0),
          remark: row.remark,
          channel_name: row.channel_name,
          status: row.status,
          room_id: row.room_id,
          room_no: row.room_no,
          index: k + 1,
          total: n,
          virtual: true,
        });
      }
    }
    return units;
  })();

  const revenues = all<RevenueRow>(
    `SELECT r.room_type_id AS type_id, fi.biz_date AS biz_date, SUM(fi.amount) AS revenue
     FROM folio_items fi
     JOIN folios f ON f.id = fi.folio_id
     JOIN stays s ON s.id = f.stay_id
     JOIN rooms r ON r.id = s.room_id
     WHERE fi.hotel_id = ? AND fi.item_type = 'ROOM'
     GROUP BY r.room_type_id, fi.biz_date`,
    [hotelId]
  );

  const revenueMap = new Map<string, number>();
  for (const rv of revenues) revenueMap.set(`${rv.type_id}|${rv.biz_date}`, Number(rv.revenue ?? 0));

  /* 可售房量覆盖：设置 → 房价设置 → 修改房量（rate_calendar.allotment） */
  const allotRows = all<{ room_type_id: number; date: string; allotment: number | null }>(
    `SELECT room_type_id, date, allotment FROM rate_calendar
      WHERE hotel_id = ? AND allotment IS NOT NULL AND date BETWEEN ? AND ?`,
    [hotelId, columns[0] ?? today, columns[columns.length - 1] ?? today]
  );
  const allotMap = new Map<string, number>();
  for (const a of allotRows) allotMap.set(`${a.room_type_id}|${a.date}`, Number(a.allotment ?? 0));
  /**
   * 某房型某天的**今日可售**（与 `src/lib/room-stock.ts` 同一口径）
   *
   * `rate_calendar.allotment` 的语义是**当天剩余可卖数量**（2026-11-22 酒店确认），
   * 不是「总房量」、也不是「放量上限」。
   *
   * 所以这里不能再用旧写法 `capacity = allotment ?? physical` 去当分母 ——
   * 那等于把「还剩 2 间可卖」当成「总共只有 2 间房」，
   * 再减去占用和维修就会算出负数可售。
   *
   * 正确：
   *   物理可售 = 总房量 − 维修 − 在住/预订占用
   *   今日可售 = allotment === null ? 物理可售 : min(物理可售, allotment)
   */
  const allotmentOf = (typeId: number, day: string) => allotMap.get(`${typeId}|${day}`) ?? null;

  type Cell = { day: string; occupied: number; maintenance: number; sellable: number };
  const matrix = rows.map((t) => {
    const cells: Cell[] = columns.map((day) => {
      let occupied = 0;
      /*
       * 在住占用：`isBetween(check_in_date, out_date, day)` 会把**逾期未离店**的客人漏掉
       *
       * 真库 21 张在住单 expect_check_out 是 11-14~11-18（都早于今天），
       * `isBetween` 对今天及之后全不成立 → 占用只剩 6 间 → 可卖 40 间，
       * 而房态页今日可售是 17 间（**多算 23 间、126%**）。
       * 与 room-stock.ts / forecast 同一口径：只要 status='INHOUSE'，客人就还在，房间就占着。
       */
      for (const s of stays) {
        if (s.room_type_id !== t.id) continue;
        /* stays 查询本身就限定了 status='INHOUSE'，所以：从入住那天起一直占着（逾期也占） */
        if (s.check_in_date && s.check_in_date <= day) occupied++;
      }
      /*
       * 预订占用：按「间」累加（bookingUnits 已经把每张订单展开成 N 间）
       *
       * 原来 `for (const b of bookings) occupied++` 是「一张单算 1 间」，
       * 多房订单（room_count = 3）只扣 1 间 → 可售多算 2 间。
       */
      for (const u of bookingUnits) {
        if (u.room_type_id !== t.id) continue;
        if (isBetween(u.check_in_date, u.check_out_date, day)) occupied++;
      }
      /*
       * 维修 / 锁房：两个都必须扣
       *
       * 原来只 SUM(status='OOO')，**完全不扣 LOCK** ——
       * 实测（chk-stock）：设 1 间 OOO + 1 间 LOCK，房态页可售 3，本页显示 5。
       *
       * 另外原来 `showOOO ? ooo : 0` 让「可卖」随一个**显示复选框**变化 →
       * 首屏把维修房算成可卖。维修房不能被卖，这个开关只该影响「显不显示」，
       * 不该影响「算不算可卖」。
       */
      const maintenance = Number(t.ooo ?? 0) + Number(t.lock ?? 0);
      /* 物理可售：总房量 − 维修 − 锁房 − 占用（occupied 已含在住与预订） */
      const physicalSellable = Math.max(0, Number(t.total ?? 0) - maintenance - occupied);
      /* 手工房量是「剩余可卖」，只做一次 min，不再从里面扣占用 */
      const allot = allotmentOf(t.id, day);
      const sellable = allot === null ? physicalSellable : Math.min(physicalSellable, Math.max(0, allot));
      return { day, occupied, maintenance, sellable };
    });
    return { type: t, cells };
  });

  const totals = columns.map((day) => {
    let total = 0;
    let occupied = 0;
    let maintenance = 0;
    let sellable = 0;
    let revenue = 0;
    for (const row of matrix) {
      const cell = row.cells.find((c) => c.day === day);
      if (!cell) continue;
      total += Number(row.type.total ?? 0);
      occupied += cell.occupied;
      maintenance += cell.maintenance;
      sellable += cell.sellable;
      revenue += revenueMap.get(`${row.type.id}|${day}`) ?? 0;
    }
    const base = total - maintenance;
    return {
      day,
      total,
      occupied,
      maintenance,
      sellable,
      revenue,
      occRate: base > 0 ? (occupied / base) * 100 : 0,
      adr: occupied > 0 ? revenue / occupied : 0,
      revpar: total > 0 ? revenue / total : 0,
    };
  });

  const totalRooms = types.reduce((a, t) => a + Number(t.total ?? 0), 0);

  const href = (from: Date, to: Date) => {
    const p = new URLSearchParams();
    p.set("submitted", "1");
    p.set("start", ymd(from));
    p.set("end", ymd(to));
    if (selectedTypeId && rows.some((t) => t.id === selectedTypeId)) p.set("type", String(selectedTypeId));
    if (showOcc) p.set("occ", "1");
    if (showOOO) p.set("ooo", "1");
    if (showADR) p.set("adr", "1");
    if (showRevpar) p.set("revpar", "1");
    if (showYest) p.set("yest", "1");
    return `/rooms/predict?${p.toString()}`;
  };

  const now = new Date(`${today}T00:00:00`);
  const thisMonthHref = href(monthStart(now), monthEnd(now));
  const nextMonthHref = href(monthStart(new Date(now.getFullYear(), now.getMonth() + 1, 1)), monthEnd(new Date(now.getFullYear(), now.getMonth() + 1, 1)));

  // —— 导出：服务端生成 CSV（data URI），无需额外接口 ——
  const csvLines: string[] = [];
  csvLines.push(["房型（总房量）", ...columns.flatMap((d) => [`${d} 可卖`, `${d} 占用`])].join(","));
  for (const row of matrix) {
    csvLines.push([
      `${row.type.name}(${row.type.total})`,
      ...row.cells.flatMap((c) => [String(c.sellable), String(showOcc ? c.occupied : "")]),
    ].join(","));
  }
  csvLines.push(["合计", ...totals.flatMap((t) => [String(t.sellable), String(t.occupied)])].join(","));
  csvLines.push(["出租率", ...totals.map((t) => `${t.occRate.toFixed(2)}%`)].join(","));
  csvLines.push(["平均房价ADR", ...totals.map((t) => t.adr.toFixed(2))].join(","));
  csvLines.push(["客房收益RevPAR", ...totals.map((t) => t.revpar.toFixed(2))].join(","));
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`\ufeff${csvLines.join("\r\n")}`)}`;

  const sellableCls = (v: number) => (v < 0 ? "text-rose-600" : v === 0 ? "text-amber-600" : "text-emerald-600");

  /* ---------------------------------------------------------------- *
   * 房间可售预测（view=room）：每个房间 × 日期，显示可卖/已占/维修
   * ---------------------------------------------------------------- */
  // 只保留去呼呼的「房型可售」视图（房间维度已按需求下线）
  const viewSwitch = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="rounded-[2px] border border-[#32c141] bg-[#32c141] px-3 py-1 text-[12px] text-white">
        房型可售
      </span>
    </div>
  );

  if (sp.view === "room") {
    const roomList = all<{
      id: number;
      room_no: string;
      floor: number | null;
      type_name: string;
      status: string;
    }>(
      `SELECT r.id, r.room_no, r.floor, COALESCE(rt.name, '未分房型') AS type_name, r.status
       FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.hotel_id = ?
       ORDER BY COALESCE(r.floor, 0), r.sort, r.room_no`,
      [hotelId]
    );

    const occupiedMap = new Map<string, boolean>();
    for (const st of stays) {
      // stays 只有房型级，房间级用 room_no 反查太重，这里按房间 id 查在住
    }
    const stayRoomIds = new Set(
      all<{ room_id: number }>(
        `SELECT room_id FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`,
        [hotelId]
      ).map((r) => r.room_id)
    );

    return (
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {viewSwitch}
        </div>
        <div className="overflow-auto rounded-[3px] border border-[#e5e5e5] bg-white">
          <table className="w-full min-w-max border-collapse">
            <thead>
              <tr className="bg-[#fafafa]">
                <th className="sticky left-0 z-10 min-w-[160px] border-b border-r border-[#eee] bg-[#fafafa] px-2 py-2 text-left text-[12px] font-medium text-[#555]">
                  房间号 / 房型
                </th>
                {columns.map((d) => {
                  const dt = new Date(`${d}T00:00:00`);
                  const isToday = d === today;
                  return (
                    <th
                      key={d}
                      className={`min-w-[74px] border-b border-r border-[#eee] px-1 py-1 text-center text-[11.5px] font-normal ${
                        isToday ? "text-[#e60012]" : "text-[#555]"
                      }`}
                    >
                      {d.slice(5)}
                      <div className="text-[10px] text-[#999]">
                        周{["日", "一", "二", "三", "四", "五", "六"][dt.getDay()]}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {roomList.map((r) => (
                <tr key={r.id} className="hover:bg-[#fafcfb]">
                  <td className="sticky left-0 z-10 border-b border-r border-[#eee] bg-white px-2 py-1.5 text-[12px] text-[#222]">
                    {r.room_no}
                    <span className="ml-1 text-[11px] text-[#999]">
                      {r.floor != null ? `${r.floor}层 ` : ""}
                      {r.type_name}
                    </span>
                  </td>
                  {columns.map((d) => {
                    const bad = r.status === "OOO" || r.status === "LOCK";
                    const used = !bad && stayRoomIds.has(r.id);
                    return (
                      <td
                        key={d}
                        className={`border-b border-r border-[#eee] px-1 py-1.5 text-center text-[11.5px] ${
                          bad
                            ? "bg-[#f5f5f5] text-[#999]"
                            : used
                              ? "bg-[#e8f0ff] text-[#1a5fd0]"
                              : "text-[#2a9d3c]"
                        }`}
                      >
                        {bad ? (r.status === "OOO" ? "维修" : "锁房") : used ? "占用" : "可卖"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {roomList.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-12 text-center text-[12px] text-[#999]">
                    暂无房间
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  /* 房型可售预测：点「占用」弹出当天客人订单列表（去呼呼图 2）
   *
   * ── 为什么这里必须和「占用 N」用同一份数据 ──
   * 改前这里另查两套 SQL（在住 stayRows + 主单 bkRows），和上面的 matrix 各算各的，于是：
   *   1. 在住按 `date(expect_check_out) > 当天` 过滤 —— **逾期未离店被整条滤掉**，
   *      而 matrix 的 occupied 只看 `check_in_date <= 当天`（逾期房间照样占着，这是对的）。
   *      实测 2026-11-25 房型1：占用 13 间，弹窗只列 1 行；
   *   2. 预订按「主单 1 行 + 主单房型」列 —— 多房订单（BK-MULTI3 = 3 间）只显示 1 行，
   *      跨房型订单的房型也可能和计数用的「房间实际房型」不同。
   *
   * 现在：
   *   · 在住 = stayRows，判定 `check_in_date <= 当天`（与 matrix 的 occupied 一字不差）；
   *   · 预订 = bookingUnits（matrix 计数用的那一份，已按 booking_rooms 明细展开）；
   *   · 房型 = 同一口径的 room_type_id（房间实际房型 → 明细房型 → 主单房型兜底）；
   *   · 一行 = 一间，所以「弹窗行数 = 占用 N」（同一房型、同一天）。
   */
  const stayRows = all<{
    id: number; room_type_id: number; room_no: string; type_name: string;
    guest_name: string; mobile: string | null; rate: number; nights: number;
    check_in_time: string | null; check_in_date: string | null;
    expect_check_out: string | null; remark: string | null;
    channel_name: string | null; booking_no: string | null; link_count: number;
  }>(
    `SELECT s.id, rt.id AS room_type_id, r.room_no, rt.name AS type_name,
            s.guest_name, s.mobile, s.rate, s.nights,
            s.check_in_time, date(s.check_in_time) AS check_in_date,
            s.expect_check_out, s.remark,
            c.name AS channel_name, b.booking_no,
            (SELECT COUNT(*) FROM stays ls2 WHERE ls2.status = 'INHOUSE' AND s.guest_id IS NOT NULL AND ls2.guest_id = s.guest_id) AS link_count
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN channels c ON c.id = s.channel_id
       LEFT JOIN bookings b ON b.id = s.booking_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        /*
         * 不能再用 date(s.expect_check_out) > 起始日 过滤：
         * 逾期未离店的客人 expect_check_out 早已过去，会被整条滤掉，
         * 而 matrix 的 occupied 是「只要 INHOUSE 就继续占房」——
         * 两边口径一分叉，弹窗行数就比「占用 N」少。
         */
        AND date(s.check_in_time) <= ?`,
    [hotelId, endStr]
  );

  /** 房型名：unit / 在住行都只有 room_type_id，统一从 types 取（不受「房型筛选」影响） */
  const typeNameOf = (id: number) => types.find((t) => t.id === id)?.name ?? "未分房型";

  const orderCells: OrderListCell[] = (() => {
    const out: OrderListCell[] = [];
    const typeIds = [
      ...new Set<number>([...stayRows.map((r) => r.room_type_id), ...bookingUnits.map((u) => u.room_type_id)]),
    ];
    for (const typeId of typeIds) {
      for (const day of columns) {
        /* 在住：与 matrix 的 occupied 同一判定 —— 入住日 <= 当天（逾期也照样占着） */
        const stayOfDay = stayRows.filter(
          (r) => r.room_type_id === typeId && r.check_in_date && r.check_in_date <= day
        );
        /* 预订：直接用计数那批 unit，同一判定 isBetween（退房当天不算占用） */
        const unitOfDay = bookingUnits.filter(
          (u) => u.room_type_id === typeId && isBetween(u.check_in_date, u.check_out_date, day)
        );
        if (stayOfDay.length === 0 && unitOfDay.length === 0) continue;
        out.push({
          typeId,
          day,
          list: [
            ...stayOfDay.map((r) => ({
              status: "INHOUSE",
              statusLabel: "现住",
              channelName: r.channel_name ?? "散客",
              channelOrderNo: r.booking_no ?? "-",
              guestName: r.guest_name ?? "-",
              mobile: r.mobile,
              stayType: "日租房",
              roomTypeName: r.type_name,
              roomNo: r.room_no,
              rate: Number(r.rate ?? 0),
              rooms: 1,
              checkIn: (r.check_in_time ?? "").slice(0, 16).replace("T", " "),
              checkOut: (r.expect_check_out ?? "") + " 12:00",
              remark: r.remark?.trim() || "如客人需要发票，请提前告知前台",
              stayId: r.id,
              bookingId: null,
              linkCount: Number(r.link_count ?? 1),
            })),
            ...unitOfDay.map((u) => ({
              status: u.status,
              statusLabel: u.status === "CONFIRMED" ? "已确认" : "待排房",
              channelName: u.channel_name ?? "散客",
              channelOrderNo: u.booking_no,
              guestName: u.guest_name ?? "-",
              mobile: u.mobile,
              stayType: "日租房",
              /* 多房订单标明「第几间/共几间」，一张单展开成几行时不会看起来像重复行 */
              roomTypeName: `${typeNameOf(u.room_type_id)}${u.total > 1 ? `（${u.index}/${u.total}间）` : ""}`,
              roomNo: u.room_no || "未排房",
              rate: Number(u.rate ?? 0),
              rooms: 1,
              checkIn: u.check_in_date + " 15:00",
              checkOut: u.check_out_date + " 12:00",
              remark: u.remark?.trim() || (u.room_no ? "预订占用，尚未入住" : "预订占用，尚未分房"),
              stayId: null,
              bookingId: u.booking_id,
              linkCount: 1,
            })),
          ],
        });
      }
    }
    return out;
  })();
  const typeNameMap: Record<number, string> = {};
  for (const t of rows) typeNameMap[t.id] = t.name;

  return (
    <div className="flex h-[calc(100vh-121px)] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {viewSwitch}
        <form method="get" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600">
          <input type="hidden" name="submitted" value="1" />
          <span className="text-gray-500">日期:</span>
          <input type="date" name="start" defaultValue={start} className="input h-7 w-[132px]" />
          <span className="text-gray-400">-</span>
          <input type="date" name="end" defaultValue={endStr} className="input h-7 w-[132px]" />
          <button type="submit" className="rounded-[3px] bg-[#58bc62] px-3 py-1 text-white hover:bg-[#4fae59]">
            查询
          </button>
          <Link href={thisMonthHref} className="rounded-[3px] bg-[#58bc62] px-2.5 py-1 text-white hover:bg-[#4fae59]">
            本月
          </Link>
          <Link href={nextMonthHref} className="rounded-[3px] border border-gray-300 px-2.5 py-1 text-gray-600 hover:border-[#58bc62] hover:text-[#58bc62]">
            下一月
          </Link>
          <select name="type" defaultValue={selectedTypeId ? String(selectedTypeId) : ""} className="input h-7 w-[150px]">
            <option value="">全部房型</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <span className="ml-auto flex flex-wrap items-center gap-3">
            <span className="text-gray-400">显示：</span>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="occ" value="1" defaultChecked={showOcc} /> 占用
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="ooo" value="1" defaultChecked={showOOO} /> 维修房
            </label>
            {/* 去呼呼把 ADR 与 RevPAR 合并在一个复选框里 */}
            <label className="flex items-center gap-1">
              <input type="checkbox" name="adr" value="1" defaultChecked={showADR || showRevpar} /> 平均房价(ADR)、客房收益(RevPAR)
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="yest" value="1" defaultChecked={showYest} /> 显示昨天
            </label>
            <a
              href={csvHref}
              download="房型可售预测.csv"
              className="flex items-center gap-1 rounded border border-gray-300 px-2.5 py-1 text-gray-600 hover:border-[#3bd943] hover:text-[#2fa84f]"
              title="导出 CSV"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2v8m0 0L5 7m3 3l3-3M3 12v2h10v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              导出
            </a>
          </span>
        </form>

        <PredictTable
          orderCells={orderCells}
          typeNames={typeNameMap}
          dates={columns}
          today={today}
          showOcc={showOcc}
          showAdr={showADR || showRevpar}
          rows={rows.map((t) => ({
            typeId: t.id,
            typeName: t.name,
            total: Number(t.total ?? 0),
            cells: columns.map((d) => {
              const cell = matrix.find((m) => m.type.id === t.id)?.cells.find((c) => c.day === d);
              const rev = revenueMap.get(String(t.id) + "|" + d) ?? 0;
              const occupied = cell?.occupied ?? 0;
              const nights = occupied;
              return {
                day: d,
                sellable: cell?.sellable ?? 0,
                occupied,
                rate: nights > 0 ? rev / nights : 0,
                adr: nights > 0 ? rev / nights : 0,
                revpar: Number(t.total ?? 0) > 0 ? rev / Number(t.total ?? 0) : 0,
              };
            }),
          }))}
          totals={totals.map((t) => ({
            day: t.day,
            sellable: t.sellable,
            occupied: t.occupied,
            occRate: t.occRate,
            adr: t.adr,
            revpar: t.revpar,
          }))}
        />

        <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-100 ring-1 ring-emerald-300" />可卖</span>
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm bg-blue-100 ring-1 ring-blue-300" />占用</span>
          <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-sm bg-rose-100 ring-1 ring-rose-300" />超卖（负数）</span>
          <span>可卖 = 总房量 − 占用{showOOO ? " − 维修房" : ""}；ADR = 当日房费 ÷ 间夜；RevPAR = 当日房费 ÷ 总房量</span>
        </div>
      </div>
    </div>
  );
}
