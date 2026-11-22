import { all, get } from "@/lib/db";
import { addDays, todayStr } from "@/lib/utils";
import { requireUser } from "@/lib/session";
import { occupancyOfDay } from "@/lib/metrics";
import { ROOM_TAG_KEYS, ROOM_TAG_SQL, ROOM_TAG_FIELD_SQL } from "@/lib/room-tags";
import { stockTotals, todayRoomTypeStock, type RoomTypeStock, type StockTotals } from "@/lib/room-stock";
import RoomBoard, { type RoomRow, type ArrivalRow, type TagStats } from "@/components/RoomBoard";
import { CHANNEL_ORDER_PENDING_STATUSES, CHANNEL_ORDER_PENDING_IN } from "@/lib/channel-orders";

export const dynamic = "force-dynamic";

/*
 * 渠道订单「待处理」状态集合（整改清单 P0-2 / 第七轮清单一.4）
 *
 * 原来这份集合定义在本文件顶部（模块级 const，没有 export），顶部导航想显示数字
 * 只能另写一份；而另写一份就是下一次分叉的开始。
 * 第七轮把集合、SQL 占位符、计数语句统一抽到 `@/lib/channel-orders`，本页与
 * `(main)/layout.tsx` 的顶部数字共用同一份 —— 详细状态分布与口径见该文件顶部注释。
 *
 * 待处理 = NEW + CONFIRMED + PENDING
 */

/** 预抵类明细最多列几条（计数走 COUNT(*)，不受这个限制） */
const ARRIVAL_LIST_LIMIT = 8;

/** 预抵明细行（今日预抵 / 逾期未入住 / 未来预抵 三个桶共用的精简字段） */
type ArrivalBrief = {
  id: number;
  room_id: number | null;
  guest_name: string | null;
  booking_no: string;
  room_type_name: string | null;
  check_in_date: string;
};

export default async function RoomsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const hotelId = user.hotelId;
  const today = todayStr();

  const rooms = all<RoomRow>(
    `SELECT r.id, r.room_no, r.floor, r.status, r.feature, r.room_type_id,
            rt.name AS room_type_name, rt.code AS room_type_code,
            s.id AS stay_id, s.stay_no, s.guest_name, s.mobile, s.expect_check_out, s.check_in_time,
            s.rate, s.nights, s.rate_code, s.team_name, c.name AS channel_name, s.booking_id,
            f.id AS folio_id, f.balance,
            s.breakfast, s.invoice_party, s.remark, s.deposit, s.pay_type, s.member_card,
            s.channel_order_no,
            COALESCE((SELECT SUM(fi.amount) FROM folio_items fi
                       WHERE fi.folio_id = f.id AND fi.item_type <> 'PAYMENT'), 0) AS consume_amount,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.stay_id = s.id), 0) AS paid_amount,
            COALESCE((SELECT group_concat(lr2.room_no, ',') FROM stays ls2
                        JOIN rooms lr2 ON lr2.id = ls2.room_id
                       WHERE ls2.status = 'INHOUSE' AND s.guest_id IS NOT NULL
                         AND ls2.guest_id = s.guest_id AND ls2.id <> s.id), '') AS link_rooms,
            ld.signal AS lock_signal, ld.battery AS lock_battery, ld.status AS lock_status,
            (SELECT COUNT(*) FROM stays ls
               JOIN rooms lr ON lr.id = ls.room_id
              WHERE ls.hotel_id = r.hotel_id AND ls.status = 'INHOUSE'
                AND s.guest_id IS NOT NULL AND ls.guest_id = s.guest_id
                AND lr.room_type_id = r.room_type_id) AS link_count,
            /*
             * 第 5 轮 P1-4 快捷标签 / P2-2 卡片信息：
             * 下面这些字段供 RoomBoard 客户端筛选与卡片展示。
             * SQL 片段统一放在 @/lib/room-tags，与客户端 matchesRoomTag 一一对应，
             * 避免「标签统计」和「点击筛选」各写一份口径。
             */
            ${ROOM_TAG_FIELD_SQL.link_room_count} AS link_room_count,
            ${ROOM_TAG_FIELD_SQL.guest_vip_level} AS guest_vip_level,
            ${ROOM_TAG_FIELD_SQL.guest_id_no} AS guest_id_no,
            ${ROOM_TAG_FIELD_SQL.guest_stay_count} AS guest_stay_count,
            ${ROOM_TAG_FIELD_SQL.hk_pending} AS hk_pending,
            ${ROOM_TAG_FIELD_SQL.hk_doing} AS hk_doing,
            ${ROOM_TAG_FIELD_SQL.hk_review_pending} AS hk_review_pending,
            ${ROOM_TAG_FIELD_SQL.stay_self_use} AS stay_self_use,
            ${ROOM_TAG_FIELD_SQL.pending_cancel_count} AS pending_cancel_count
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
     LEFT JOIN channels c ON c.id = s.channel_id
     LEFT JOIN folios f ON f.stay_id = s.id
     LEFT JOIN guests g ON g.id = s.guest_id
     LEFT JOIN lock_devices ld ON ld.room_id = r.id
     WHERE r.hotel_id = ?
     ORDER BY r.sort, r.room_no`,
    [hotelId]
  );

  /*
   * 待排房订单（整改指令 3.2「房态页排房」）
   *
   * 房态图的空房格子只能看不能排，前台必须切到订单页才能排房 ——
   * 去呼呼是直接在房态页排的。这里把待排房订单查出来，
   * 复用订单页同一个 AssignRoomModal，不另写一套交互。
   */
  const pendingBookings = all<{
    id: number;
    booking_no: string;
    guest_name: string;
    room_type_id: number | null;
    room_type_name: string | null;
    check_in_date: string;
    check_out_date: string;
    room_count: number | null;
  }>(
    `SELECT b.id, b.booking_no, b.guest_name, b.room_type_id, rt.name AS room_type_name,
            b.check_in_date, b.check_out_date, COALESCE(b.room_count,1) AS room_count
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
        AND NOT EXISTS (SELECT 1 FROM booking_rooms br
                         WHERE br.booking_id = b.id AND br.room_id IS NOT NULL
                           AND br.status IN ('PENDING','CONFIRMED'))
      ORDER BY b.check_in_date, b.id
      LIMIT 20`,
    [hotelId]
  );

  // 悬浮面板「财务明细」用：在住单的消费/收款流水（按 stay_id 分组）
  const stayFlows = all<{ stay_id: number; kind: string; label: string; amount: number; biz_date: string | null }>(
    `SELECT fi.folio_id AS stay_id, 'CONSUME' AS kind,
            COALESCE(fi.description, fi.item_type) AS label, fi.amount, fi.biz_date
       FROM folio_items fi
       JOIN folios f ON f.id = fi.folio_id
      WHERE fi.hotel_id = ? AND f.stay_id IS NOT NULL
     UNION ALL
     SELECT p.stay_id, 'PAY' AS kind,
            '收款 · ' || COALESCE(p.method, '') AS label, p.amount, p.biz_date
       FROM payments p
      WHERE p.hotel_id = ? AND p.stay_id IS NOT NULL
      ORDER BY biz_date DESC LIMIT 400`,
    [hotelId, hotelId]
  );
  const flowMap: Record<number, { kind: string; label: string; amount: number; biz_date: string | null }[]> = {};
  for (const f of stayFlows) {
    const k = Number(f.stay_id);
    (flowMap[k] ??= []).push({ kind: f.kind, label: f.label, amount: f.amount, biz_date: f.biz_date });
  }

  /*
   * —— 预抵三分（第 5 轮 P1-5）——
   *
   * 改之前只有一条 SQL：`check_in_date <= today AND check_out_date > today`，
   * 把「昨天该到、今天还在住期内」的逾期单算进了「今日预抵」——
   * 前台看到「今日预抵 5 间」，实际只有 3 个客人是今天的，另外 2 个是昨天没来的，
   * 接机 / 排房 / 早餐全部按错的人数准备。
   *
   * 现在按入住日切成三个互不重叠的桶，顶部提示条分别展示：
   *   ① 今日预抵   check_in_date = today
   *   ② 逾期未入住 check_in_date < today（状态仍是 PENDING/CONFIRMED，客人该到没到，要前台去追）
   *   ③ 未来预抵   check_in_date > today（提示条给 7 天内 + 累计两个数）
   * 三个桶的 status 条件完全一致，只是入住日区间不同，所以三个数相加正好是全部未到店预订。
   */

  /** ① 今日预抵：入住日**严格等于今天**（不再用 <= 兜住逾期单） */
  const arrivals = all<ArrivalRow>(
    `SELECT b.id, b.room_id, b.guest_name, b.mobile, b.booking_no, b.rate,
            rt.name AS room_type_name,
            COALESCE(c.name, '散客') AS channel_name,
            b.check_in_date, COALESCE(b.arrival_time, '') AS arrival_time
     FROM bookings b
     JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
       AND b.check_in_date = ?
     ORDER BY b.id`,
    [hotelId, today]
  );

  /** ② 逾期未入住：入住日早于今天、状态还没被处理掉（改期/取消/标记未到都不在这个桶里） */
  const overdueCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date < ?`,
    [hotelId, today]
  )?.n ?? 0;
  const overdueArrivals = all<ArrivalBrief>(
    `SELECT b.id, b.room_id, b.guest_name, b.booking_no,
            rt.name AS room_type_name, b.check_in_date
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED') AND b.check_in_date < ?
      ORDER BY b.check_in_date DESC, b.id DESC
      LIMIT ?`,
    [hotelId, today, ARRIVAL_LIST_LIMIT]
  );

  /** ③ 未来预抵：入住日晚于今天；7 天内单独给一个数（排班/备货用），累计数一起带上 */
  const futureEnd = todayStr(addDays(today, 7));
  const futureCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date > ?`,
    [hotelId, today]
  )?.n ?? 0;
  const futureSoonCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED')
        AND check_in_date > ? AND check_in_date <= ?`,
    [hotelId, today, futureEnd]
  )?.n ?? 0;
  const futureArrivals = all<ArrivalBrief>(
    `SELECT b.id, b.room_id, b.guest_name, b.booking_no,
            rt.name AS room_type_name, b.check_in_date
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date > ? AND b.check_in_date <= ?
      ORDER BY b.check_in_date, b.id
      LIMIT ?`,
    [hotelId, today, futureEnd, ARRIVAL_LIST_LIMIT]
  );

  const departures = all<{ room_id: number; guest_name: string }>(
    `SELECT room_id, guest_name FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out = ?`,
    [hotelId, today]
  );

  /*
   * —— 房型「今日可售」（第 5 轮 P0-3）——
   *
   * 改之前这里是 `COUNT(r.id)`：**物理房间总数**，却被 RoomBoard 的
   * 「房型筛选 … 今日可售」当成可售数显示 —— 在住、维修、锁房、已排房预订全都算了进去。
   * 全店 46 间、在住 21 间时仍显示 46 间可售，前台按这个数字排房必然排到满房才发现没房。
   *
   * 现在口径统一走 `src/lib/room-stock.ts`（那里详细说明了为什么复用
   * channels/stock-trigger.ts 的 buildRateRows 占用口径、为什么不直接用
   * room-availability.findRoomConflicts 与 rooms/forecast 的 dayStats）：
   *   今日可售 = 总房量 − 维修房(OOO) − 锁房(LOCK) − 在住 − 今日预订占用 − 手工房量限售
   * 页面自己不再写一套算法，只把结果映射成 RoomBoard 需要的 { id, name, count }。
   */
  const stockRows: RoomTypeStock[] = todayRoomTypeStock(hotelId, today);
  const stock: StockTotals = stockTotals(stockRows);
  const roomTypes = stockRows.map((row) => ({ id: row.roomTypeId, name: row.name, count: row.sellable }));

  const channels = all<{ name: string; count: number }>(
    `SELECT COALESCE(c.name,'散客') AS name, COUNT(*) AS count
     FROM stays s LEFT JOIN channels c ON c.id = s.channel_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     GROUP BY c.name ORDER BY count DESC`,
    [hotelId]
  );

  /*
   * —— 快捷标签统计（第 5 轮 P1-4）——
   *
   * 去呼呼房态页的 12 个常用标签：数量全部由这里 SQL 汇总，前端不写死。
   * 判定条件与 `src/lib/room-tags.ts` 的 ROOM_TAG_SQL 一一对应；客户端点击筛选
   * 走同一个文件里的 matchesRoomTag，所以「标签上的数字」与「点进去的房间数」必然一致。
   *
   * 第 5 轮 P1-4 修正后 12 个标签全部有真实数据来源，不再有恒为 0 的占位项：
   *   打扫中 → housekeeping.status = 'DOING'（字段本来就有，缺的是推进入口）
   *   待审   → housekeeping.review_status = 'PENDING_REVIEW'（客房验收新维度）
   *   自用   → stays.self_use = 1（新字段；不拿 rate=0 反推）
   */
  const tagStats = ROOM_TAG_KEYS.reduce((acc, key) => {
    const row = get<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM rooms r
         LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
         LEFT JOIN folios f ON f.stay_id = s.id
         LEFT JOIN guests g ON g.id = s.guest_id
        WHERE r.hotel_id = ? AND (${ROOM_TAG_SQL[key]})`,
      [hotelId]
    );
    acc[key] = row?.c ?? 0;
    return acc;
  }, {} as TagStats);

  /*
   * —— 出租率（第 5 轮 P1-1）——
   *
   * 原来 RoomBoard 在客户端拼：occupied / rooms.length，分母把维修房(OOO)、
   * 锁房(LOCK) 也算了进去 —— 那些房根本卖不了，算进分母会低估出租率，
   * 和工作台 / 报表 / 夜审的数字打架。
   *
   * 口径统一交给 `src/lib/metrics.ts`（它 import 了 @/lib/db，是服务端模块，
   * 客户端组件不能直接用）。所以：房态页（服务端组件）在这里算好，
   * 把「可售房量 / 已售房量 / 出租率」以 props 传给 RoomBoard 展示，
   * 客户端只负责渲染，不再自己算分母。
   */
  const dayMetrics = occupancyOfDay(hotelId, today);

  // 底部功能条四个角标的真实计数
  /*
   * 直连订单角标（第 5 轮 P0-2）= 「待处理」渠道订单数。
   * 状态集合见文件顶部 CHANNEL_ORDER_PENDING_STATUSES（NEW / CONFIRMED / PENDING），
   * 与下面 badgeList.orders 的列表共用同一份常量 + 占位符 —— 角标数和点开列表必须同口径。
   */
  const pendingOrders = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = ? AND status IN (${CHANNEL_ORDER_PENDING_IN})`,
    [hotelId, ...CHANNEL_ORDER_PENDING_STATUSES]
  )?.n ?? 0;
  const frontTasks = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings WHERE hotel_id = ? AND check_in_date = ? AND room_id IS NULL AND status IN ('PENDING','CONFIRMED')`,
    [hotelId, today]
  )?.n ?? 0;
  const shopSales = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ? AND date(created_at,'localtime') = ?`,
    [hotelId, today]
  )?.n ?? 0;
  const alertLogs = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = ? AND date(created_at,'localtime') = ?`,
    [hotelId, today]
  )?.n ?? 0;
  const badgeCounts = { orders: pendingOrders, tasks: frontTasks, shop: shopSales, alerts: alertLogs };

  /** 底部四个入口点开后的列表内容（去呼呼点角标是弹列表，不是直接跳页） */
  const badgeList = {
    orders: all<{ id: number; title: string; sub: string; href: string }>(
      `SELECT o.id,
              COALESCE(o.channel_order_no, '') || ' · ' || COALESCE(o.guest_name, '待处理') AS title,
              COALESCE(rt.name, '') || ' ' || COALESCE(o.check_in_date, '') ||
                CASE o.status WHEN 'NEW' THEN ' · 待确认'
                              WHEN 'CONFIRMED' THEN ' · 已确认'
                              ELSE ' · 待处理' END AS sub,
              '/channel-orders?q=' || COALESCE(o.channel_order_no, '') AS href
         FROM channel_orders o LEFT JOIN room_types rt ON rt.id = o.room_type_id
        WHERE o.hotel_id = ? AND o.status IN (${CHANNEL_ORDER_PENDING_IN})
        ORDER BY o.id DESC LIMIT 8`,
      [hotelId, ...CHANNEL_ORDER_PENDING_STATUSES]
    ),
    tasks: all<{ id: number; title: string; sub: string; href: string }>(
      `SELECT b.id,
              COALESCE(b.guest_name, '待排房') || ' · ' || COALESCE(rt.name, '') AS title,
              '入住 ' || COALESCE(b.check_in_date, '') || ' · 待排房' AS sub,
              '/bookings?q=' || COALESCE(b.booking_no, '') AS href
         FROM bookings b LEFT JOIN room_types rt ON rt.id = b.room_type_id
        WHERE b.hotel_id = ? AND b.check_in_date = ? AND b.room_id IS NULL
          AND b.status IN ('PENDING','CONFIRMED')
        ORDER BY b.id DESC LIMIT 8`,
      [hotelId, today]
    ),
    shop: all<{ id: number; title: string; sub: string; href: string }>(
      `SELECT id, item_name AS title,
              '¥' || printf('%.2f', amount) || ' · ' || COALESCE(method, '') AS sub,
              '/shop?tab=orders' AS href
         FROM shop_sales WHERE hotel_id = ? AND date(created_at,'localtime') = ?
        ORDER BY id DESC LIMIT 8`,
      [hotelId, today]
    ),
    alerts: all<{ id: number; title: string; sub: string; href: string }>(
      `SELECT id, COALESCE(action, '操作') || ' · ' || COALESCE(substr(detail, 1, 24), '') AS title,
              COALESCE(operator, '系统') AS sub, '/logs' AS href
         FROM op_logs WHERE hotel_id = ? AND date(created_at,'localtime') = ?
        ORDER BY id DESC LIMIT 8`,
      [hotelId, today]
    ),
  };
  return (
    <div className="flex h-[calc(100vh-121px)] min-h-0 flex-col">
      {/*
       * 顶部口径条（第 5 轮 P0-3 / P1-5）：
       * 房态图自带的那条「温馨提示：今日预抵 N 间」在 RoomBoard 内部，
       * 只够表达「今日预抵」一个数；逾期未入住、未来预抵、以及今日可售的算法口径
       * 没有地方说明，前台得自己猜数字是怎麼来的。这里在房态图上方加一条服务端渲染的
       * 说明条：四个数各自独立、点「明细」展开来源（纯 <details>，不需要客户端 JS）。
       */}
      <RoomsSummaryBar
        stock={stock}
        stockRows={stockRows}
        arrivals={{ total: arrivals.length, assigned: arrivals.filter((a) => a.room_id !== null).length }}
        overdue={{ count: overdueCount, rows: overdueArrivals }}
        future={{ soonCount: futureSoonCount, total: futureCount, rows: futureArrivals }}
      />
      <div className="min-h-0 flex-1">
        <RoomBoard
          badgeCounts={badgeCounts}
          badgeList={badgeList}
          stayFlows={flowMap}
          rooms={rooms}
          arrivals={arrivals}
          departures={departures}
          roomTypes={roomTypes}
          channels={channels}
          tagStats={tagStats}
          dayMetrics={{
            totalRooms: dayMetrics.totalRooms,
            sellableRooms: dayMetrics.sellableRooms,
            roomNights: dayMetrics.roomNights,
            roomsSold: dayMetrics.roomsSold,
            occupancy: dayMetrics.occupancy,
          }}
          initialStatus={sp.filter}
          pendingBookings={pendingBookings}
        />
      </div>
    </div>
  );
}

/* ============================================================ 顶部口径条 */

/**
 * 房态页顶部的「数字来源」说明条。
 *
 * 三块内容各自独立、互不混口径：
 *   ① 今日可售 N 间 = 总房 − 在住 − 预订 − 维修 − 锁房 − 限售（P0-3 的算法就在这一行里写明）
 *   ② 今日预抵 N 间（已排房 X / 未排房 Y）—— 只统计 check_in_date = 今天
 *   ③ 逾期未入住 M 间 + 未来预抵 K 间（7 天内 / 累计）—— 与今日预抵分开，不合并成一个数
 *
 * 明细用原生 <details>：展开是浮层（absolute），不改变房态图高度，也不需要客户端 JS。
 */
function RoomsSummaryBar({
  stock,
  stockRows,
  arrivals,
  overdue,
  future,
}: {
  stock: StockTotals;
  stockRows: RoomTypeStock[];
  arrivals: { total: number; assigned: number };
  overdue: { count: number; rows: ArrivalBrief[] };
  future: { soonCount: number; total: number; rows: ArrivalBrief[] };
}) {
  const unassigned = Math.max(0, arrivals.total - arrivals.assigned);
  return (
    <div className="shrink-0 border-b border-[#f0e4bf] bg-[#fffdf3] px-3 py-1 text-[12px] leading-5 text-[#5c5340]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {/* ① 今日可售：P0-3 的口径，算式直接写出来 */}
        <div className="flex items-center gap-1">
          <i className="h-[11px] w-[2px] shrink-0 bg-[#32c141]" />
          <b className="font-semibold text-[#333]">今日可售 {stock.sellable} 间</b>
          <span className="tabular-nums text-[#9c8f60]">
            = 总房 {stock.physical} − 在住 {stock.inhouse} − 预订 {stock.booked} − 维修 {stock.ooo} − 锁房{" "}
            {stock.lock}
            {stock.allotmentHold > 0 ? ` − 限售 ${stock.allotmentHold}` : ""}
          </span>
          {stock.oversold > 0 && (
            <span className="rounded-[2px] bg-[#f5222d] px-1 text-[10px] leading-[14px] text-white">
              超卖 {stock.oversold} 间
            </span>
          )}
          <PopDetail label="分房型">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-[#8a8a8a]">
                  <th className="border-b border-[#eee] px-1 py-0.5 text-left font-normal">房型</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">可售</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">总房</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">在住</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">预订</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">维修</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">锁房</th>
                  <th className="border-b border-[#eee] px-1 py-0.5 text-right font-normal">限售</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {stockRows.map((r) => (
                  <tr key={r.roomTypeId} className="text-[#333]">
                    <td className="px-1 py-0.5 text-left">{r.name}</td>
                    <td className={`px-1 py-0.5 text-right font-semibold ${r.sellable > 0 ? "text-[#2fa84f]" : "text-[#c4c4c4]"}`}>
                      {r.sellable}
                      {r.oversold > 0 ? <span className="ml-1 text-[10px] text-[#f5222d]">超卖{r.oversold}</span> : null}
                    </td>
                    <td className="px-1 py-0.5 text-right">{r.physical}</td>
                    <td className="px-1 py-0.5 text-right">{r.inhouse}</td>
                    <td className="px-1 py-0.5 text-right">{r.booked}</td>
                    <td className="px-1 py-0.5 text-right">{r.ooo}</td>
                    <td className="px-1 py-0.5 text-right">{r.lock}</td>
                    <td className="px-1 py-0.5 text-right">{r.allotmentHold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] leading-4 text-[#9a9a9a]">
              口径：src/lib/room-stock.ts（复用渠道库存推送 buildRateRows 的占用口径，另扣锁房与手工房量）。
              在住含逾期未离店；预订含未排房订单按间数占用。
            </p>
          </PopDetail>
        </div>

        <span className="text-[#e6dcbd]">|</span>

        {/* ② 今日预抵：严格 check_in_date = 今天 */}
        <span className="tabular-nums">
          今日预抵 <b className="font-semibold text-[#333]">{arrivals.total}</b> 间
          <span className="text-[#9c8f60]">
            （已排房 {arrivals.assigned} · 未排房 {unassigned}）
          </span>
        </span>

        <span className="text-[#e6dcbd]">|</span>

        {/* ③ 逾期未入住：单独一个数，红字提示，点开看是谁 */}
        <div className="flex items-center gap-1 tabular-nums">
          逾期未入住{" "}
          <b className={`font-semibold ${overdue.count > 0 ? "text-[#f5222d]" : "text-[#8a8a8a]"}`}>
            {overdue.count}
          </b>{" "}
          间
          {overdue.count > 0 && (
            <PopDetail label="明细" tone="red">
              <p className="mb-1 text-[11px] leading-4 text-[#9a9a9a]">
                入住日早于今天、状态仍是「待排房 / 已确认」的单子，<b className="text-[#f5222d]">不计入今日预抵</b>。
                需要前台联系客人改期、取消，或在夜审里标记未到。
              </p>
              <ArrivalList rows={overdue.rows} total={overdue.count} />
            </PopDetail>
          )}
        </div>

        <span className="text-[#e6dcbd]">|</span>

        {/* ④ 未来预抵：7 天内 + 累计两个数 */}
        <div className="flex items-center gap-1 tabular-nums">
          未来预抵 <b className="font-semibold text-[#333]">{future.soonCount}</b> 间（7 天内）
          <span className="text-[#9c8f60]">累计 {future.total} 间</span>
          {future.soonCount > 0 && (
            <PopDetail label="明细">
              <ArrivalList rows={future.rows} total={future.soonCount} />
            </PopDetail>
          )}
        </div>
      </div>
    </div>
  );
}

/** 「明细」小按钮 + 浮层（原生 details，服务端渲染即可用） */
function PopDetail({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "red";
  children: React.ReactNode;
}) {
  return (
    <details className="relative inline-block">
      <summary
        className={`cursor-pointer list-none select-none text-[11px] [&::-webkit-details-marker]:hidden hover:underline ${
          tone === "red" ? "text-[#f5222d]" : "text-[#2f6fed]"
        }`}
      >
        {label} ▾
      </summary>
      <div className="absolute left-0 top-[18px] z-[60] max-h-[320px] w-[440px] overflow-auto rounded-[3px] border border-[#e2e2e2] bg-white p-2 text-[12px] shadow-lg">
        {children}
      </div>
    </details>
  );
}

/** 预抵类明细列表（最多 ARRIVAL_LIST_LIMIT 条，超出提示还剩多少） */
function ArrivalList({ rows, total }: { rows: ArrivalBrief[]; total: number }) {
  if (rows.length === 0) return <p className="text-[#999]">暂无明细</p>;
  return (
    <>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-1 text-[#333]">
            <span className="shrink-0 tabular-nums text-[#8a8a8a]">{r.check_in_date}</span>
            <span className="truncate">{r.guest_name || "未留姓名"}</span>
            <span className="shrink-0 text-[#9a9a9a]">{r.room_type_name ?? "未定房型"}</span>
            <span className="ml-auto shrink-0 text-[#b5b5b5]">{r.booking_no}</span>
            <span className="shrink-0 text-[#c4c4c4]">{r.room_id ? "已排房" : "未排房"}</span>
          </li>
        ))}
      </ul>
      {total > rows.length && (
        <p className="mt-1 text-[11px] text-[#9a9a9a]">还有 {total - rows.length} 条，去「订单管理 → 预订」按日期筛选查看</p>
      )}
    </>
  );
}
