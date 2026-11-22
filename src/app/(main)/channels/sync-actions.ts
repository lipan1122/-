"use server";

/**
 * 渠道直连同步动作（整改清单 4.1 / 4.2）
 *
 * ── 这个文件为什么必须存在 ──
 * src/lib/channels/ 下的适配器（ctrip / meituan / fliggy / douyin / sandbox）早就写好了，
 * 里面有 testConnection / pushRates / pullOrders / pushOrderStatus 四个能力，
 * 但**业务层一个调用点都没有** —— 页面上的「推送房量」「拉取订单」按钮走的是
 * actions.ts 里的演示逻辑（随机造单、只写日志、根本不碰渠道），于是审计把 4.1 判成缺失。
 *
 * 这里补的就是「业务层调用点」，全部统一经过 invokeWithLog：
 *   1. pushRatesAction        推送房量房价（按 rate_calendar / room_types / rooms / stays / bookings 算）
 *   2. pullOrdersAction       拉取渠道订单（幂等落 channel_orders，auto_import=1 时自动转预订）
 *   3. pushOrderStatusAction  把 PMS 状态回传渠道（确认 / 入住 / 退房 / 未到 / 取消）
 *   4. testConnectionSyncAction 真正调用适配器的连通性测试（页面「测试连接」按钮）
 *   5. retryChannelSyncLogAction 真实重试一条失败记录（整改清单 P1-20）
 *   6. retryDueSyncLogsAction    批量重试所有到期失败记录（P1-20 的消费者）
 *   7. drainStockQueueAction     消费库存待同步队列（整改清单 P2-13）
 *
 * ── 与 actions.ts 的分工（第 4 轮整改后）──
 * actions.ts 只做渠道**配置与订单维护**（保存凭据 / 开关 / 接单 / 拒单）；
 * 本文件是「真实适配器调用」的唯一入口：推房量、拉单、回传状态、重试、消费库存队列。
 *
 * 整改清单 P1-23：actions.ts 里原来的 4 个演示动作（随机造单 / 只写日志的推送 /
 * 假测试连接）已整体删除 —— 它们会往生产库写随机渠道订单并自动建正式预订。
 *
 * ── 安全与隔离 ──
 * 每个动作都 requirePermission("channel.sync")（整改 P1-32：原来一律 requireAdmin()，
 * 权限点里定义的 channel.sync 全项目零引用，管理员改了也不生效）。
 * admin 由 hasPermission 恒放行；渠道同步会改库存与订单，普通前台默认无权触发。
 * 且所有渠道 / 订单查询都带 hotel_id，杜绝跨店操作。
 */

import { revalidatePath } from "next/cache";
import { all, get, run, tx } from "@/lib/db";
import { requirePermission, type SessionUser } from "@/lib/session";
import { nowIso, todayStr } from "@/lib/utils";
import { channelCapability, getAdapter } from "@/lib/channels/index";
import { nextBookingNo } from "@/lib/channels/booking-no";
import { invokeWithLog, logSyncOutcome, type InvokeMeta } from "@/lib/channels/invoke";
import { pushOrderStatusForChannelOrder } from "@/lib/channels/order-status";
import { retryDueSyncLogs, retrySyncLog, type RetryOutcome } from "@/lib/channels/retry";
import { drainStockQueue, pendingStockCount, type StockDrainResult } from "@/lib/channels/stock-queue";
import { buildRateRows, markStockDirty, planRatePush, upsertChannelOrder } from "@/lib/channels/stock-trigger";
import type { ChannelOrderPayload, ChannelOrderStatus } from "@/lib/channels/types";

/* ============================================================ 类型 */

/** channels 表一行（sort / sandbox / endpoint / 加密列老库可能没有，按可选处理） */
type ChannelRow = {
  id: number;
  hotel_id: number;
  channel_type: string | null;
  name: string | null;
  store_id: string | null;
  app_key: string | null;
  app_secret: string | null;
  app_secret_enc?: string | null;
  enabled: number | null;
  auto_import: number | null;
  commission: number | null;
  oversell: number | null;
  sandbox?: number | null;
  endpoint?: string | null;
  last_sync_at?: string | null;
  /** 整改清单 P1-22：拉单增量游标（只有拉单推进它） */
  last_order_sync_at?: string | null;
};

/** channel_orders 一行（转预订时用） */
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
};

/** 可回传的 PMS 订单状态（与适配器 pushOrderStatus 的入参枚举一致） */
/**
 * 可回传的状态白名单
 *
 * CHECKED_OUT（退房）是整改指令 4.1 明确要求的能力：
 * 客人离店后要告知渠道，否则渠道侧一直显示在住，房态不释放、佣金也算不准。
 */
const PUSHABLE_STATUSES = ["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "NOSHOW", "CANCELLED"] as const;
type PushableStatus = (typeof PUSHABLE_STATUSES)[number];

/** 推送房量的默认天数（页面上可以改，表单里的 days 优先） */
const DEFAULT_PUSH_DAYS = 14;

/* ============================================================ 小工具 */

/** 异常压成一行，避免把堆栈塞进 op_logs */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 写一条操作日志。
 *
 * 为什么同步动作还要单独写 op_logs：
 *   channel_sync_logs 是「渠道侧调用」的账（渠道排障用），op_logs 是「谁在本系统点了什么」
 *   的账（审计用）。两者缺一不可：渠道日志里看不出操作人，op_logs 里看不出渠道返回码。
 * 表缺失 / 库忙时静默跳过，不能让记日志把同步本身搞失败。
 */
function logOp(hotelId: number, operator: string, action: string, detail: string): void {
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    // 忽略：日志不是业务结果
  }
}

/** 读本店的渠道配置；不属于本店 / 不存在返回 undefined */
function readChannel(hotelId: number, channelId: number): ChannelRow | undefined {
  if (!Number.isFinite(channelId) || channelId <= 0) return undefined;
  // SELECT *：老库可能没有 sort / sandbox / endpoint 列，点名查询会直接抛 SQL 错
  return get<ChannelRow>(`SELECT * FROM channels WHERE id = ? AND hotel_id = ?`, [channelId, hotelId]);
}

/** 表单里的天数：非法值走默认 14，硬夹在 1…60 之间（防止误填 365 天把渠道打爆） */
function readDays(formData: FormData): number {
  const n = Number(formData.get("days"));
  if (!Number.isFinite(n)) return DEFAULT_PUSH_DAYS;
  return Math.min(60, Math.max(1, Math.trunc(n)));
}

/**
 * 把一条渠道订单转成正式预订（私有函数，不导出 —— "use server" 文件只能导出 async action）。
 *
 * 为什么不直接复用 actions.ts 的 importOneOrder：那个函数没有被导出，而本轮改造
 * 不允许改别人的文件；这里按同一口径实现，并额外把 channel_order_no 写进 bookings，
 * 对账时能直接从预订反查渠道单号。
 *
 * 幂等（第三道保险）：先用条件 UPDATE 抢占订单（status NEW/CONFIRMED → IMPORTING，
 * 且 booking_id IS NULL），change=0 说明别人已经抢到或已转单，本次直接放弃；
 * 整个动作在一个事务里，建预订失败会回滚，订单不会停在 IMPORTING。
 */
function importOrderToBooking(user: SessionUser, hotelId: number, orderId: number): string | null {
  const order = get<ChannelOrderRow>(
    `SELECT id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
            check_in_date, check_out_date, nights, room_count, amount, status, booking_id
       FROM channel_orders WHERE id = ? AND hotel_id = ?`,
    [orderId, hotelId]
  );
  if (!order) return null;
  if (order.booking_id) return null; // 已转过，绝不再建第二张
  if (!order.check_in_date || !order.check_out_date) return null;
  if (order.status !== "NEW" && order.status !== "CONFIRMED") return null;

  const channel = get<{ id: number }>(`SELECT id FROM channels WHERE hotel_id = ? AND channel_type = ?`, [
    hotelId,
    order.channel_type,
  ]);

  const nights =
    order.nights && order.nights > 0
      ? Number(order.nights)
      : Math.max(
          1,
          Math.round(
            (new Date(`${order.check_out_date}T00:00:00`).getTime() -
              new Date(`${order.check_in_date}T00:00:00`).getTime()) /
              86400000
          )
        );
  const roomCount = order.room_count && order.room_count > 0 ? Number(order.room_count) : 1;
  const total = Number(order.amount ?? 0);
  // rate 存「每晚每间」单价，总价落 amount / total_price 口径
  const rate = nights > 0 ? Math.round((total / nights / roomCount) * 100) / 100 : total;
  const now = nowIso();

  return tx(() => {
    const claimed = run(
      `UPDATE channel_orders SET status = 'IMPORTING'
        WHERE id = ? AND hotel_id = ? AND booking_id IS NULL AND status IN ('NEW','CONFIRMED')`,
      [orderId, hotelId]
    );
    if (Number(claimed.changes) === 0) return null;

    // 整改清单 P2-14：预订号改为「基号 + 撞号重试」，配合 bookings(hotel_id, booking_no) 唯一索引
    const bookingNo = nextBookingNo(hotelId);

    const inserted = run(
      `INSERT INTO bookings (
         hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
         channel_id, company_id, check_in_date, check_out_date, nights,
         room_count, guest_count, rate, deposit, status, guarantee, remark,
         booking_type, pay_type, breakfast, channel_order_no,
         created_by, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        bookingNo,
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
        `由 ${order.channel_type} 订单 ${order.channel_order_no} 自动接单转入`,
        "guest",
        "到店付款",
        0,
        order.channel_order_no,
        user.id,
        now,
        now,
      ]
    );

    run(`UPDATE channel_orders SET status = 'IMPORTED', booking_id = ?, imported_at = ? WHERE id = ? AND hotel_id = ?`, [
      inserted.lastInsertRowid,
      now,
      orderId,
      hotelId,
    ]);

    return bookingNo;
  });
}

/* ============================================================ 动作 1：推送房量房价 */

/**
 * 推送房量房价到指定渠道（整改清单 4.1 的「房量同步 / 房态回传」）。
 *
 * 表单字段：
 *   channel_id  必填，channels.id
 *   days        可选，默认 14，夹在 1…60
 *
 * 流程：读渠道 → 算 rows（房量 + 价格 + 关房）→ invokeWithLog(PUSH_RATES) → 写 op_logs。
 * 渠道侧的成败由 invokeWithLog 写 channel_sync_logs（带 request_no / duration_ms /
 * success_count / fail_count），这里只补「谁点的、推了多少条」。
 */
export async function pushRatesAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const channelId = Number(formData.get("channel_id"));
  const days = readDays(formData);
  const operator = user.realName ?? user.username;

  const ch = readChannel(hotelId, channelId);
  if (!ch) {
    logOp(hotelId, operator, "CHANNEL_PUSH_RATES", `推送房量房价失败：渠道 #${channelId} 不存在或不属于本店`);
    revalidatePath("/channels");
    return;
  }

  const channelType = ch.channel_type ?? "";
  const oversell = Number(ch.oversell ?? 0) === 1;
  /*
   * 房量房价口径（房间数 - 在住 - 已排预订 - 维修房，price 取 rate_calendar 否则基准价，
   * 超售策略 clamp/保留负数）统一实现在 src/lib/channels/stock-trigger.ts 的 buildRateRows()：
   * 库存口径和 markStockDirty 是同一件事的两端，放一起便于验收脚本用真实数据断言，
   * 也避免 "use server" 文件导出纯函数（会编译报错）。
   *
   * 整改清单 P2-10：先算一遍原始行，再交给 planRatePush 做「映射 / 价格方案」校验 ——
   * 没有渠道房型映射的房型不再拿本地编码硬推（渠道侧必然报房型不存在），
   * 而是被剔出来单独记一条 MAPPING_MISSING 失败日志，管理员能直接看到该去补映射。
   */
  const baseRows = buildRateRows(hotelId, channelType, todayStr(), days, oversell);
  if (baseRows.length === 0) {
    // 没有房型就没有可推的内容：不调渠道（避免一次毫无意义的外部请求），但必须留操作痕迹
    logOp(hotelId, operator, "CHANNEL_PUSH_RATES", `推送房量房价跳过：本店尚未维护房型（${ch.name ?? channelType}）`);
    revalidatePath("/channels");
    return;
  }

  const plan = planRatePush(hotelId, channelType, todayStr(), days, oversell, baseRows);

  /* 房型映射缺失：必须先让管理员看到，不能把「推了但渠道全拒」记成成功 */
  if (plan.unmapped.length > 0) {
    const names = plan.unmapped.map((u) => `${u.roomTypeName}（${u.localCode}）`).join("、");
    logSyncOutcome({
      hotelId,
      channelType,
      action: "PUSH_RATES",
      status: "FAILED",
      message: `推送房量房价被跳过 ${plan.unmapped.length} 个房型：未配置渠道房型映射（channel_room_types）——${names}。已配置的房型继续推送`,
      errorCode: "MAPPING_MISSING",
      failCount: plan.unmapped.length,
    });
    logOp(
      hotelId,
      operator,
      "CHANNEL_PUSH_RATES",
      `房型映射缺失 ${plan.unmapped.length} 个（${names}），这些房型本次不推送；请到「房型与匹配」补齐`
    );
  }

  if (plan.rows.length === 0) {
    logOp(
      hotelId,
      operator,
      "CHANNEL_PUSH_RATES",
      `推送房量房价未执行：${ch.name ?? channelType} 没有任何已映射的房型（共 ${plan.unmapped.length} 个房型待匹配）`
    );
    revalidatePath("/channels");
    return;
  }

  const result = await invokeWithLog(
    ch.id,
    hotelId,
    "PUSH_RATES",
    (cfg) => getAdapter(cfg.channelType).pushRates(cfg, plan.rows)
  );

  if (result.ok) {
    const rejected = result.data.rejected.length;
    logOp(
      hotelId,
      operator,
      "CHANNEL_PUSH_RATES",
      `推送房量房价 ${days} 天 / ${plan.rows.length} 条（${ch.name ?? channelType}）：接受 ${result.data.accepted} 条，拒绝 ${rejected} 条` +
        (rejected > 0 ? `；首条拒绝原因：${result.data.rejected[0]?.reason ?? "-"}` : "") +
        (plan.note ? `；${plan.note}` : "") +
        `；超售策略 ${oversell ? "允许负数（超售）" : "不允许负数（clamp 0）"}`
    );
  } else {
    logOp(hotelId, operator, "CHANNEL_PUSH_RATES", `推送房量房价失败（${result.code}）：${result.message}`);
  }

  /*
   * 整改清单 P2-13：推完就把本酒店待同步队列里的任务清掉。
   * 「刚推过全量房量」意味着队列里那些「库存变了」的任务已经覆盖，再留着只会重复推。
   * 放在推送成功后：失败时队列必须留着，等下一次重试。
   */
  if (result.ok && pendingStockCount(hotelId) > 0) {
    const drained = await drainStockQueue(hotelId, { channelIds: [ch.id], days });
    logOp(
      hotelId,
      operator,
      "CHANNEL_STOCK_QUEUE",
      `推送房量后顺带消费待同步队列 ${drained.processed} 条（成功渠道 ${drained.succeeded} / 失败 ${drained.failed}），剩余 ${drained.remaining} 条`
    );
  }

  revalidatePath("/channels");
}

/* ============================================================ 动作 2：拉取订单 */

/**
 * 从渠道拉取增量订单（整改清单 4.1 的「订单拉取」）。
 *
 * 表单字段：channel_id 必填
 *
 * since = channels.last_sync_at；从没同步过就回看 7 天（渠道一般也只保留近期订单）。
 *
 * 幂等（重复拉单不会重复建单）：
 *   1. upsertChannelOrder 先按 (hotel_id, channel_order_no) 查，命中就跳过；
 *   2. 插入用 INSERT OR IGNORE + 唯一索引 idx_channel_orders_key 兜并发；
 *   3. 只有本次新插入（inserted=true）且 channels.auto_import=1 时才建预订，
 *      importOrderToBooking 内部再用条件 UPDATE 抢占，同一单只会有一张预订。
 */
export async function pullOrdersAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const channelId = Number(formData.get("channel_id"));
  const operator = user.realName ?? user.username;

  const ch = readChannel(hotelId, channelId);
  if (!ch) {
    logOp(hotelId, operator, "CHANNEL_PULL_ORDERS", `拉取订单失败：渠道 #${channelId} 不存在或不属于本店`);
    revalidatePath("/channels");
    return;
  }

  const channelType = ch.channel_type ?? "";
  /*
   * 整改清单 P1-22：拉单增量起点**只**用 last_order_sync_at。
   *
   * 原来读的是 last_sync_at，而那个字段被所有动作（测试连接 / 推送房价 / 状态回传）
   * 一起刷新 —— 管理员点一次「测试连接」，游标就跳到此刻，期间的渠道新单永久漏拉。
   * 现在两个字段分工：last_sync_at 只做页面展示，last_order_sync_at 才是游标。
   */
  const lastOrderSyncAt =
    typeof ch.last_order_sync_at === "string" && ch.last_order_sync_at.trim() !== "" ? ch.last_order_sync_at : null;
  // 从没拉过：回看 7 天（既不会漏掉近期新单，也不会一次拉回半年前的存量）
  const since = lastOrderSyncAt ?? new Date(Date.now() - 7 * 86400000).toISOString();

  const meta: InvokeMeta = {};
  const result = await invokeWithLog<ChannelOrderPayload[]>(
    ch.id,
    hotelId,
    "PULL_ORDERS",
    async (cfg) => {
      const res = await getAdapter(cfg.channelType).pullOrders(cfg, since);
      // 只有一单时把渠道单号写进同步日志，运维一眼能看出这次拉的是哪一单；
      // 多单时留空 —— channel_order_no 只放得下一个单号，硬塞会误导排障。
      if (res.ok && res.data.length === 1) {
        meta.channelOrderNo = res.data[0].channelOrderNo;
      }
      return res;
    },
    meta
  );

  let created = 0;
  let skippedExisting = 0;
  let imported = 0;
  const createdNos: string[] = [];
  const importFails: string[] = [];

  if (!result.ok) {
    /*
     * 拉单失败时把增量游标退回去。
     *
     * invokeWithLog 的约定是「真正调过适配器就推进 last_order_sync_at」（成功失败都推进，
     * 因为游标属于「已经问过渠道的时间窗」）。但拉单失败时，这个时间窗里的订单
     * **并没有落到本系统**，游标一旦前进，下次 since 就从新游标开始 → 永久漏单。
     * 所以这里在本动作内把 last_order_sync_at 恢复成调用前的值
     * （从没拉过时恢复成 NULL，下次仍按 7 天回看）。
     */
    try {
      run(`UPDATE channels SET last_order_sync_at = ? WHERE id = ? AND hotel_id = ?`, [lastOrderSyncAt, ch.id, hotelId]);
    } catch {
      // 恢复失败不影响本次结果（日志已经写清失败原因，运维可手工重拉更长时间窗）
    }
  }

  if (result.ok) {
    for (const payload of result.data) {
      try {
        const up = upsertChannelOrder(hotelId, channelType, payload);
        if (!up.inserted) {
          // 幂等命中：这单之前已经拉过（可能已转预订），直接跳过
          skippedExisting += 1;
          continue;
        }
        created += 1;
        createdNos.push(payload.channelOrderNo);

        if (Number(ch.auto_import ?? 0) === 1 && up.orderId !== null) {
          try {
            const bookingNo = importOrderToBooking(user, hotelId, up.orderId);
            if (bookingNo) imported += 1;
          } catch (e) {
            // 单条转预订失败不能拖垮整次拉单：记一条失败，订单仍在 NEW 状态可手工处理
            importFails.push(`${payload.channelOrderNo}：${errText(e)}`);
          }
        }
      } catch (e) {
        importFails.push(`${payload.channelOrderNo}：${errText(e)}`);
      }
    }
  }

  if (result.ok) {
    const detail =
      `拉取订单（${ch.name ?? channelType}，since ${since}）：新单 ${created} 条，重复跳过 ${skippedExisting} 条，自动接单 ${imported} 条` +
      (createdNos.length > 0 ? `；单号：${createdNos.slice(0, 10).join("、")}${createdNos.length > 10 ? " 等" : ""}` : "") +
      (importFails.length > 0 ? `；失败：${importFails.slice(0, 5).join("；")}` : "");
    logOp(hotelId, operator, "CHANNEL_PULL_ORDERS", detail);
    /*
     * 整改清单 P2-13：拉单新增订单 = 库存可能变化（新单占房）→ 记一条待同步任务。
     * 只落队列，不实时推渠道：拉单经常一次几十条，逐条推会被 OTA 频控。
     */
    if (created > 0) markStockDirty(hotelId, `拉单新增 ${created} 条订单（${ch.name ?? channelType}）`);
  } else {
    logOp(hotelId, operator, "CHANNEL_PULL_ORDERS", `拉取订单失败（${result.code}）：${result.message}`);
  }

  revalidatePath("/channels");
  revalidatePath("/channel-orders");
  if (imported > 0) {
    revalidatePath("/bookings");
    revalidatePath("/dashboard");
  }
}

/* ============================================================ 动作 3：订单状态回传 */

/**
 * 把 PMS 的订单状态回传给渠道（整改清单 4.1 的「订单修改 / 退房状态回传」）。
 *
 * 表单字段：
 *   channel_order_id  必填，channel_orders.id
 *   status            必填，CONFIRMED / CHECKED_IN / NOSHOW / CANCELLED
 *   reason            可选，取消原因等
 *
 * 状态映射在各自的适配器里（PMS 枚举 → 渠道枚举），这里只传 PMS 枚举。
 * 渠道不接受（result.ok=false 或 accepted=false）时不改本地状态：
 * 本地状态是「已经生效的事实」，渠道没确认就不能假装同步成功。
 */
export async function pushOrderStatusAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const orderId = Number(formData.get("channel_order_id"));
  const statusRaw = String(formData.get("status") ?? "")
    .trim()
    .toUpperCase();
  const reason = String(formData.get("reason") ?? "").trim() || undefined;
  const status = PUSHABLE_STATUSES.find((s): s is PushableStatus => s === statusRaw);

  if (!Number.isFinite(orderId) || orderId <= 0 || !status) {
    logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", `状态回传跳过：参数不合法（订单 ${orderId}，状态 ${statusRaw || "-"})`);
    revalidatePath("/channels");
    return;
  }

  /*
   * 真实调用统一收口到 src/lib/channels/order-status.ts：
   * 前台入住 / 收银退房 / 夜审未到 都要回传同一个状态，逻辑只留一份，
   * 谁调用都走同一套「渠道确认后才改本地状态」的口径。
   */
  const pushed = await pushOrderStatusForChannelOrder({
    hotelId,
    channelOrderId: orderId,
    status: status as ChannelOrderStatus,
    reason,
    operator,
    source: "channels",
  });

  logOp(hotelId, operator, "CHANNEL_PUSH_STATUS", pushed.message);
  revalidatePath("/channels");
  revalidatePath("/channel-orders");
}

/* ============================================================ 动作 4：测试连接 */

/**
 * 真正调适配器的连通性测试（整改清单 4.1 的「测试连接」）。
 *
 * 与 actions.ts 的 testConnectionAction 的区别：那个只检查「门店号填了没」并写一条日志，
 * 全程不碰适配器；这里走 invokeWithLog + testConnection，凭据缺失 / 渠道停用 / 网络异常
 * 都会被归一成错误码写进 channel_sync_logs，页面「最近同步记录」能直接看到原因。
 */
export async function testConnectionSyncAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const channelId = Number(formData.get("channel_id"));

  const ch = readChannel(hotelId, channelId);
  if (!ch) {
    logOp(hotelId, operator, "CHANNEL_TEST", `测试连接失败：渠道 #${channelId} 不存在或不属于本店`);
    revalidatePath("/channels");
    return;
  }

  const result = await invokeWithLog(ch.id, hotelId, "TEST_CONNECTION", (cfg) =>
    getAdapter(cfg.channelType).testConnection(cfg)
  );

  if (result.ok) {
    logOp(
      hotelId,
      operator,
      "CHANNEL_TEST",
      `测试连接成功（${ch.name ?? ch.channel_type}）：${result.data.message}，延迟 ${result.data.latencyMs}ms` +
        `；能力 ${channelCapability(ch.channel_type ?? "", { sandbox: Number(ch.sandbox ?? 0) === 1 })}`
    );
  } else {
    logOp(hotelId, operator, "CHANNEL_TEST", `测试连接失败（${result.code}）：${result.message}`);
  }

  revalidatePath("/channels");
}

/* ============================================================ 动作 5：重试一条失败记录 */

/**
 * 重试一条失败的同步日志（整改清单 P1-20）。
 *
 * 与旧实现的区别（这也是本项整改的核心）：
 *   旧：只把日志改成 RETRYING、retry_count+1，**从不重新调用上游**，
 *       而且 RETRYING 没有后续路径 → 永久卡住。
 *   新：按原 action 真实重放（拉单 / 推房量 / 连通性 / 状态回传），
 *       成功写 SUCCESS（retry_count 归零）、失败写 FAILED + next_retry_at 退避，
 *       连续 5 次失败进死信表。
 */
export async function retryChannelSyncLogAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const logId = Number(formData.get("log_id"));
  if (!Number.isFinite(logId) || logId <= 0) {
    logOp(hotelId, operator, "CHANNEL_RETRY", `重试跳过：日志 id 不合法（${String(formData.get("log_id") ?? "")}）`);
    revalidatePath("/channels");
    return;
  }

  const outcome: RetryOutcome = await retrySyncLog(hotelId, logId);
  logOp(
    hotelId,
    operator,
    "CHANNEL_RETRY",
    `重试渠道同步日志 #${logId}（${outcome.action}）→ ${outcome.result}：${outcome.message}`
  );
  revalidatePath("/channels");
}

/* ============================================================ 动作 6：重试全部到期 */

/**
 * 批量重试所有「到期」的失败记录（next_retry_at 已过 / 为空）。
 *
 * 这就是 P1-20 要求补的「消费者」：页面按钮可以直接点，
 * 部署时也可以由系统 cron 定时触发（见 src/lib/channels/retry.ts 的说明），
 * 不需要常驻进程。一次最多重试 5 条，避免在页面动作里排队打几十个渠道接口。
 */
export async function retryDueSyncLogsAction(): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;

  const summary = await retryDueSyncLogs(hotelId, { limit: 5 });
  logOp(
    hotelId,
    operator,
    "CHANNEL_RETRY_BATCH",
    summary.retried === 0
      ? "批量重试：没有到期的失败记录"
      : `批量重试 ${summary.retried} 条：成功 ${summary.succeeded}、失败 ${summary.failed}、进死信 ${summary.dead}、跳过 ${summary.skipped}`
  );
  revalidatePath("/channels");
}

/* ============================================================ 动作 7：消费库存队列 */

/**
 * 消费「库存待同步」队列（整改清单 P2-13）。
 *
 * 队列在渠道页只有一个角标和这个按钮：
 *   房态 / 订单变化 → markStockDirty 落一条 PENDING → 管理员（或 cron）点这里
 *   → 给本店启用的直连渠道各推一次房量房价 → 成功置 DONE，失败按指数退避重试。
 */
export async function drainStockQueueAction(): Promise<void> {
  const user = await requirePermission("channel.sync");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;

  const drained: StockDrainResult = await drainStockQueue(hotelId, { limit: 20 });
  logOp(
    hotelId,
    operator,
    "CHANNEL_STOCK_QUEUE",
    drained.processed === 0
      ? `库存队列无事可做（${drained.remaining} 条待重试）`
      : `消费库存队列 ${drained.processed} 条：推送 ${drained.rows} 行，渠道成功 ${drained.succeeded} / 失败 ${drained.failed}，剩余 ${drained.remaining} 条；${drained.detail.join("；")}`
  );
  revalidatePath("/channels");
}
