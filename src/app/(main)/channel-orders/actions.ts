"use server";

import { revalidatePath } from "next/cache";
import { all, get, run, tx } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, nightsBetween, nowIso, todayStr } from "@/lib/utils";
import { nextBookingNo } from "@/lib/channels/booking-no";
import { DEMO_SEED_DISABLED_MESSAGE, demoSeedEnabled } from "@/lib/channels/demo-mode";
import { pushOrderStatusForChannelOrder } from "@/lib/channels/order-status";
import { markStockDirty } from "@/lib/channels/stock-trigger";
import type { ChannelOrderStatus } from "@/lib/channels/types";

/* --------------------------------------------------------------- 类型 */

type RoomTypeRow = { id: number; code: string; name: string; base_price: number };

type ChannelOrderRow = {
  id: number;
  channel_type: string;
  channel_order_no: string;
  room_type_id: number | null;
  guest_name: string | null;
  mobile: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
  nights: number | null;
  room_count: number | null;
  amount: number | null;
  status: string;
  booking_id: number | null;
  raw: string | null;
};

/* ----------------------------------------------------------- 常量表 */

const CHANNEL_KEYS = ["ctrip", "meituan", "douyin"] as const;
type ChannelKey = (typeof CHANNEL_KEYS)[number];

const CHANNEL_PREFIX: Record<ChannelKey, string> = { ctrip: "CT", meituan: "MT", douyin: "DY" };
const CHANNEL_PAY: Record<ChannelKey, string> = { ctrip: "预付", meituan: "预付", douyin: "到店付" };
const CHANNEL_ARRIVAL: Record<ChannelKey, string> = { ctrip: "06:00", meituan: "06:00", douyin: "22:00" };

/** 演示用客人池（姓名 + 手机号） */
const GUEST_POOL: ReadonlyArray<{ name: string; mobile: string }> = [
  { name: "魏恺", mobile: "13811110001" },
  { name: "汤其全", mobile: "13811110002" },
  { name: "黄文鑫", mobile: "13811110003" },
  { name: "熊世珍", mobile: "13922220001" },
  { name: "毛萍", mobile: "13922220002" },
  { name: "温智滔", mobile: "13922220003" },
  { name: "刘生", mobile: "13733330001" },
  { name: "黄丽珠", mobile: "13733330002" },
  { name: "谢斯媛", mobile: "13644440001" },
  { name: "吴泽昌", mobile: "13644440002" },
  { name: "马月", mobile: "13555550001" },
  { name: "马昂", mobile: "13555550002" },
  { name: "邓文希", mobile: "13466660001" },
  { name: "李谊岚", mobile: "13466660002" },
  { name: "李佳", mobile: "13988880001" },
  { name: "胡杰文", mobile: "13988880002" },
  { name: "戴青妤", mobile: "13377770001" },
  { name: "徐慧", mobile: "13377770002" },
  { name: "卢秋", mobile: "13299990001" },
  { name: "张三贵", mobile: "13299990002" },
];

/** 演示订单状态分布：以「已确认」为主，混入待确认 / 已取消 / 已入住 */
const STATUS_POOL = [
  "CONFIRMED",
  "CONFIRMED",
  "NEW",
  "CONFIRMED",
  "CANCELLED",
  "CONFIRMED",
  "NEW",
  "IMPORTED",
  "CONFIRMED",
  "NEW",
] as const;

/* --------------------------------------------------------- 小工具 */

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/** 从原始 JSON 里取字符串字段 */
function readStr(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** 原始数据字符串 → 普通对象，非 JSON 一律当空对象 */
function parseRaw(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 原始数据不是合法 JSON，按空对象处理
  }
  return {};
}

function revalidateChannelOrderPaths() {
  revalidatePath("/channel-orders");
  revalidatePath("/channels");
  revalidatePath("/bookings");
  revalidatePath("/orders");
  revalidatePath("/dashboard");
}

/* ------------------------------------------------- 生成演示渠道订单 */

/**
 * 生成一批历史渠道订单：不同渠道、不同入离日期、不同金额，
 * 状态覆盖 已确认 / 待确认 / 已取消 / 已入住，供「渠道预订」页演示与筛选使用。
 *
 * ⚠️ 整改清单 P1-23：这是**往生产库写随机假数据**的动作，默认必须关闭。
 *
 * 原来的行为：真实酒店管理员在渠道预订页点「生成演示订单」，
 * 库里立刻多出 20 条随机客人 / 随机手机号 / 随机房型的渠道订单（实测本库已有 1222 条），
 * 其中 status=IMPORTED 的还会被当成已转预订计入房量与渠道对账。
 *
 * 现在：与 AR / 商品 / 积分 / 收银一致，只有显式 `PMS_DEMO_SEED=1` 才执行；
 * 默认直接返回并留一条同步日志 —— 不静默、不写库、不污染生产数据。
 * 判断放在函数**第一行**（在 requireUser 之前）：连会话都不需要，
 * 就不可能因为「忘记登录态校验」等原因绕过开关。
 */
export async function seedChannelOrdersAction(formData: FormData) {
  if (!demoSeedEnabled()) {
    // 无法确定 hotel_id（还没取会话），用 0 记一条全局日志：说明有人点了被拦下的演示动作
    try {
      run(
        `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, created_at)
         VALUES (?,?,?,?,?,?)`,
        [0, "all", "SEED_DEMO", "FAILED", `${DEMO_SEED_DISABLED_MESSAGE}（本次未写入任何订单）`, nowIso()]
      );
    } catch {
      // 日志表缺失时也不能让演示开关失效
    }
    return;
  }

  const user = await requireUser();
  const hotelId = user.hotelId;

  const wanted = Number(formData.get("count"));
  const count = Number.isFinite(wanted) && wanted > 0 ? Math.min(60, Math.max(1, Math.trunc(wanted))) : 20;

  const roomTypes = all<RoomTypeRow>(
    `SELECT id, code, name, base_price FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );
  if (roomTypes.length === 0) return;

  const now = new Date();
  let created = 0;

  tx(() => {
    for (let i = 0; i < count; i++) {
      const channel: ChannelKey = CHANNEL_KEYS[i % CHANNEL_KEYS.length];
      const roomType = roomTypes[Math.floor(Math.random() * roomTypes.length)];
      const guest = GUEST_POOL[Math.floor(Math.random() * GUEST_POOL.length)];

      const nights = 1 + (i % 4);
      const roomCount = i % 7 === 0 ? 2 : 1;
      const checkInOffset = (i % 13) - 5;
      const checkIn = todayStr(addDays(now, checkInOffset));
      const checkOut = todayStr(addDays(now, checkInOffset + nights));

      // 房价在门市价上下浮动，金额 = 单价 × 晚数 × 间数
      const rate = Math.max(120, Math.round(roomType.base_price * (0.92 + (i % 5) * 0.04)));
      const amount = Math.round(rate * nights * roomCount * 100) / 100;

      // 预订时间铺开在最近 9 天内，便于验证「按创建时间排序」
      const daysAgo = i % 9;
      const minutesAgo = (i * 37) % 600;
      const createdAt = new Date(now.getTime() - daysAgo * 86400000 - minutesAgo * 60000).toISOString();
      const stamp = todayStr(addDays(now, -daysAgo)).slice(2).replace(/-/g, "");

      const status = STATUS_POOL[i % STATUS_POOL.length];
      const breakfast = i % 3 === 0 ? 1 : 2;
      const payType = CHANNEL_PAY[channel];
      const latestArrival = CHANNEL_ARRIVAL[channel];

      // 渠道单号：渠道前缀 + 年月日 + 4 位流水，插入序号保证不重复
      const orderNo = `${CHANNEL_PREFIX[channel]}${stamp}${String(1000 + (i * 431) % 9000)}`;

      const raw = {
        source: channel,
        channelOrderNo: orderNo,
        guestName: guest.name,
        scope: "渠道直连（演示数据）",
        roomTypeCode: roomType.code,
        roomTypeName: roomType.name,
        breakfast,
        latestArrival,
        payType,
        pricePerNight: rate,
        nights,
        roomCount,
        amount,
        contact: { name: guest.name, mobile: guest.mobile },
        confirmCode: `QC-${stamp}-${String(100 + i).padStart(3, "0")}`,
        remark: "超过 30 分钟未处理将按「拒绝取消」处理",
      };

      const insRes = run(
        `INSERT OR IGNORE INTO channel_orders (
           hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
           check_in_date, check_out_date, nights, room_count, amount, status,
           booking_id, raw, created_at, imported_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          channel,
          orderNo,
          roomType.id,
          guest.name,
          guest.mobile,
          checkIn,
          checkOut,
          nights,
          roomCount,
          amount,
          status,
          null,
          JSON.stringify(raw),
          createdAt,
          status === "IMPORTED" ? createdAt : null,
        ]
      );
      // 幂等：同渠道单号已存在则跳过，不重复计数
      if (Number(insRes.changes) === 0) continue;
      created += 1;
    }
  });

  if (created > 0) {
    run(
      `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, created_at)
       VALUES (?,?,?,?,?,?)`,
      [hotelId, "ctrip", "PULL_ORDER", "SUCCESS", `生成 ${created} 条演示渠道订单`, nowIso()]
    );
  }

  revalidateChannelOrderPaths();
}

/* --------------------------------------------------------- 转入预订 */

/**
 * 渠道订单转入预订：写入 bookings（来源渠道、渠道单号、预付方式随单带过去），
 * 并把订单状态置为 IMPORTED（页面显示「已入住」）。
 * 已取消 / 已转入的订单不允许重复转入。
 */
export async function importChannelOrderAction(formData: FormData) {
  const user = await requireUser();
  const hotelId = user.hotelId;

  const orderId = Number(formData.get("orderId"));
  if (!Number.isFinite(orderId) || orderId <= 0) return;

  const order = get<ChannelOrderRow>(
    `SELECT id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
            check_in_date, check_out_date, nights, room_count, amount, status, booking_id, raw
     FROM channel_orders WHERE id = ? AND hotel_id = ?`,
    [orderId, hotelId]
  );
  if (!order) return;
  if (order.status !== "NEW" && order.status !== "CONFIRMED") return;
  if (order.booking_id) return;
  if (!order.check_in_date || !order.check_out_date) return;

  const raw = parseRaw(order.raw);
  const breakfast = toInt(raw.breakfast) ?? 0;
  const payType = readStr(raw, ["payType", "pay_type"]) || "到店付款";

  const nights = order.nights && order.nights > 0 ? order.nights : nightsBetween(order.check_in_date, order.check_out_date);
  const roomCount = order.room_count && order.room_count > 0 ? order.room_count : 1;
  const total = order.amount ?? 0;
  const rate = nights > 0 ? Math.round((total / nights / roomCount) * 100) / 100 : total;

  const channel = get<{ id: number }>(
    `SELECT id FROM channels WHERE hotel_id = ? AND channel_type = ?`,
    [hotelId, order.channel_type]
  );

  const now = nowIso();

  const bookingNo = tx(() => {
    /*
     * 并发保护：先用条件 UPDATE 抢占这条渠道订单。
     * 两个前台同时点「转入预订」时，只有一个能抢到（changes = 1），
     * 另一个直接放弃，不会生成两张预订。
     */
    const claimed = run(
      `UPDATE channel_orders SET status = 'IMPORTING'
        WHERE id = ? AND hotel_id = ? AND booking_id IS NULL AND status IN ('NEW','CONFIRMED')`,
      [orderId, hotelId]
    );
    if (Number(claimed.changes) === 0) return "";

    // 整改清单 P2-14：预订号走「基号 + 撞号重试」，与 bookings(hotel_id, booking_no) 唯一索引配合
    const no = nextBookingNo(hotelId);

    const inserted = run(
      `INSERT INTO bookings (
         hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
         channel_id, company_id, check_in_date, check_out_date, nights,
         room_count, guest_count, rate, deposit, status, guarantee, remark,
         booking_type, pay_type, breakfast, channel_order_no,
         created_by, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        no,
        order.guest_name,
        order.mobile,
        order.room_type_id,
        null,
        channel?.id ?? null,
        null,
        order.check_in_date,
        order.check_out_date,
        nights,
        roomCount,
        1,
        rate,
        0,
        "CONFIRMED",
        "渠道直连",
        `由 ${order.channel_type} 订单 ${order.channel_order_no} 转入`,
        "guest",
        payType,
        breakfast,
        order.channel_order_no,
        user.id,
        now,
        now,
      ]
    );

    run(
      `UPDATE channel_orders SET status = 'IMPORTED', booking_id = ?, imported_at = ?
       WHERE id = ? AND hotel_id = ? AND booking_id IS NULL`,
      [inserted.lastInsertRowid, now, orderId, hotelId]
    );

    return no;
  });
  if (!bookingNo) return;

  run(
    `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, created_at)
     VALUES (?,?,?,?,?,?)`,
    [hotelId, order.channel_type, "IMPORT", "SUCCESS", `订单 ${order.channel_order_no} 已转入预订 ${bookingNo}`, now]
  );
  // 整改清单 P2-13：新单占房 → 渠道库存需要重推（只落队列，不实时打渠道接口）
  markStockDirty(hotelId, `渠道订单 ${order.channel_order_no} 转入预订 ${bookingNo}`);

  revalidateChannelOrderPaths();
  revalidatePath(`/channel-orders?detail=${orderId}`);
}

/* --------------------------------------------------------- 状态回传 */

/**
 * 把某条渠道订单的状态回传给渠道（整改清单 P1-20 的触发点之一）。
 *
 * 为什么渠道订单页必须有这个按钮：
 *   入住 / 退房的自动化接线在 frontdesk / cashier（各自模块负责），
 *   但回传失败、渠道未配置、历史单补传这些情况，最终要有人能在**单据上**重新点一次。
 *   没有这个入口时，运维唯一的办法是手工改数据库。
 *
 * 表单字段：orderId（必填）、status（CHECKED_IN / CHECKED_OUT / NOSHOW / CANCELLED / CONFIRMED）
 */
export async function pushChannelOrderStatusAction(formData: FormData) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const orderId = Number(formData.get("orderId"));
  const statusRaw = String(formData.get("status") ?? "").trim();
  if (!Number.isFinite(orderId) || orderId <= 0) return;

  const pushed = await pushOrderStatusForChannelOrder({
    hotelId,
    channelOrderId: orderId,
    status: (statusRaw.toUpperCase() || "CONFIRMED") as ChannelOrderStatus,
    reason: String(formData.get("reason") ?? "").trim() || undefined,
    operator: user.realName ?? user.username,
    source: "channel-orders",
  });

  // 回传结果写进 op_logs，渠道侧是否接受由 channel_sync_logs 记录（两份账各管一段）
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      user.realName ?? user.username,
      "CHANNEL_PUSH_STATUS",
      `订单 #${orderId} 状态回传：${pushed.ok ? "成功" : `失败（${pushed.code ?? "-"}）`}`,
      nowIso(),
    ]);
  } catch {
    // op_logs 缺失不影响回传结果
  }

  revalidateChannelOrderPaths();
  revalidatePath(`/channel-orders?detail=${orderId}`);
}
