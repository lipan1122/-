import { all, get } from "@/lib/db";
import { todayStr } from "@/lib/utils";
import { requireUser } from "@/lib/session";
import RoomBoard, { type RoomRow, type ArrivalRow, type TagStats } from "@/components/RoomBoard";

export const dynamic = "force-dynamic";

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
                AND lr.room_type_id = r.room_type_id) AS link_count
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
     LEFT JOIN channels c ON c.id = s.channel_id
     LEFT JOIN folios f ON f.stay_id = s.id
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

  // 今日预抵：check_in_date=今天且未入住/未取消的订单，供顶部提示条与悬浮层使用
  const arrivals = all<ArrivalRow>(
    `SELECT b.id, b.room_id, b.guest_name, b.mobile, b.booking_no, b.rate,
            rt.name AS room_type_name,
            COALESCE(c.name, '散客') AS channel_name,
            b.check_in_date, COALESCE(b.arrival_time, '') AS arrival_time
     FROM bookings b
     JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
       AND b.check_in_date <= ? AND b.check_out_date > ?
     ORDER BY b.id`,
    [hotelId, today, today]
  );

  const departures = all<{ room_id: number; guest_name: string }>(
    `SELECT room_id, guest_name FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out = ?`,
    [hotelId, today]
  );

  const roomTypes = all<{ id: number; name: string; count: number }>(
    `SELECT rt.id, rt.name, COUNT(r.id) AS count
     FROM room_types rt LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = rt.hotel_id
     WHERE rt.hotel_id = ? GROUP BY rt.id ORDER BY rt.sort`,
    [hotelId]
  );

  const channels = all<{ name: string; count: number }>(
    `SELECT COALESCE(c.name,'散客') AS name, COUNT(*) AS count
     FROM stays s LEFT JOIN channels c ON c.id = s.channel_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     GROUP BY c.name ORDER BY count DESC`,
    [hotelId]
  );

  // —— 联房 / 团队 / 常用标签统计：全部由 SQL 汇总，不在前端写死 ——
  // 联房：在住客人在住间数 ≥ 2 的间数（同一预订 booking_id 或同备注 remark 归为同一联房组）
  const linkedRow = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stays s
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND (SELECT COUNT(*) FROM stays s2
              WHERE s2.hotel_id = s.hotel_id AND s2.status = 'INHOUSE' AND s2.id <> s.id
                AND (
                  (s2.guest_id IS NOT NULL AND s2.guest_id = s.guest_id)
                  OR (s2.booking_id IS NOT NULL AND s2.booking_id = s.booking_id)
                  OR (s2.remark IS NOT NULL AND TRIM(s2.remark) <> '' AND s2.remark = s.remark)
                )
            ) > 0`,
    [hotelId]
  );
  // 团队：团队单在住间数
  const teamRow = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stays
      WHERE hotel_id = ? AND status = 'INHOUSE' AND team_name IS NOT NULL AND TRIM(team_name) <> ''`,
    [hotelId]
  );
  // 钟点：晚数为 0 或价码标记为钟点
  const hourlyRow = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stays
      WHERE hotel_id = ? AND status = 'INHOUSE' AND (nights = 0 OR rate_code = '钟点')`,
    [hotelId]
  );
  // 欠费：在住账务单余额 > 0
  const owedRow = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stays s JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0.01`,
    [hotelId]
  );

  const tagStats: TagStats = {
    linked: linkedRow?.c ?? 0,
    team: teamRow?.c ?? 0,
    hourly: hourlyRow?.c ?? 0,
    owed: owedRow?.c ?? 0,
  };

  // 底部功能条四个角标的真实计数
  const pendingOrders = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = ? AND status = 'PENDING'`,
    [hotelId]
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
              COALESCE(rt.name, '') || ' ' || COALESCE(o.check_in_date, '') AS sub,
              '/channel-orders?q=' || COALESCE(o.channel_order_no, '') AS href
         FROM channel_orders o LEFT JOIN room_types rt ON rt.id = o.room_type_id
        WHERE o.hotel_id = ? AND o.status = 'PENDING'
        ORDER BY o.id DESC LIMIT 8`,
      [hotelId]
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
    <div className="h-[calc(100vh-121px)]">
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
        initialStatus={sp.filter}
        pendingBookings={pendingBookings}
      />
    </div>
  );
}
