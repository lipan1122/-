"use server";

import { revalidatePath } from "next/cache";
import { encryptSecret, isEncryptedSecret } from "@/lib/crypto";
import { all, get, run } from "@/lib/db";
import { requirePermission, type SessionUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";
import { isMaskedSecret, normalizeCommission } from "@/lib/channels/common";
import { nextBookingNo } from "@/lib/channels/booking-no";
import { pushOrderStatusForChannelOrder } from "@/lib/channels/order-status";
import { rebuildDerivedSettlements } from "@/lib/channels/settlements";
import { markStockDirty } from "@/lib/channels/stock-trigger";

/**
 * 渠道配置 / 渠道订单动作（整改清单 P2-11 / P2-12 / P2-13 / P1-20）
 *
 * ── 本文件与 sync-actions.ts 的分工（第 4 轮整改后）──
 *   本文件：渠道**配置**与**渠道订单**的维护（保存凭据 / 开关 / 接单 / 拒单）
 *   sync-actions.ts：真正调用渠道适配器的同步动作（推房量 / 拉单 / 回传状态 / 重试 / 消费队列）
 *
 * ── P1-23 删掉了什么 ──
 * 原来这里还有 4 个「演示」动作（pullOrdersAction 随机造渠道订单并自动建正式预订、
 * pushInventoryAction / pushRateAction 只写一条「推送成功」日志、testConnectionAction
 * 只检查门店号填没填），页面上对应 4 个按钮。它们的问题不是「演示」，而是
 * **往生产库写随机假订单**：真实酒店点一下，channel_orders 就多出几条永远不会有人来住的单，
 * 还会自动转成正式预订（auto_import=1 时），把房量、渠道对账、夜审收入全带偏。
 *
 * 这 4 个动作已整体删除（页面上对应按钮同时下线），真实能力全部由 sync-actions.ts 提供：
 *   推送房量/房价 → pushRatesAction（真的调适配器、真的算房量）
 *   拉取订单      → pullOrdersAction（真的打渠道接口，拉不到就是 0 条）
 *   测试连接      → testConnectionSyncAction（真的走 invokeWithLog）
 * 仍然保留的演示数据入口只有 channel-orders 的 seedChannelOrdersAction，且由
 * PMS_DEMO_SEED=1 显式开启（见 src/lib/channels/demo-mode.ts）。
 */

type SyncLogExtra = {
  /** 失败类型码（TIMEOUT / AUTH_FAILED / SYNC_FAILED…），成功时留空 */
  errorCode?: string;
  /** 已重试次数，首次失败从 0 开始 */
  retryCount?: number;
  nextRetryAt?: string | null;
};

/**
 * 同步日志表的实际列。
 *
 * 整改报告第 8 节新增的 error_code / retry_count / next_retry_at 是靠迁移补上的，
 * 线上库如果没跑过迁移（或表还没建），老字段的 INSERT 仍然应该能用——
 * 所以这里先探测列，再决定是写全字段还是退回老字段，别让「记日志」本身把同步动作搞崩。
 */
function syncLogColumns(): Set<string> {
  try {
    return new Set(all<{ name: string }>(`PRAGMA table_info(channel_sync_logs)`).map((c) => c.name));
  } catch {
    // 表不存在时 PRAGMA 一般返回空集，这里再兜一层，任何异常都当成「没有扩展列」
    return new Set<string>();
  }
}

/**
 * 写一条渠道同步日志。
 *
 * 失败记录必须带上错误码和重试次数，否则告警里只有一句「失败」，
 * 运维既判断不了是超时、鉴权还是数据问题，也不知道是不是已经重试过、会不会一直重试下去。
 */
function log(
  hotelId: number,
  channelType: string,
  action: string,
  status: string,
  message: string,
  extra: SyncLogExtra = {}
) {
  const cols = syncLogColumns();
  const isFail = status !== "SUCCESS";
  // 失败统一兜底成 SYNC_FAILED：调用方没细分错误码时也不会留空
  const errorCode = isFail ? extra.errorCode ?? "SYNC_FAILED" : extra.errorCode ?? null;
  const retryCount = extra.retryCount ?? 0;
  const nextRetryAt = extra.nextRetryAt ?? null;

  try {
    if (cols.has("error_code")) {
      run(
        `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, error_code, retry_count, next_retry_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [hotelId, channelType, action, status, message, errorCode, retryCount, nextRetryAt, nowIso()]
      );
    } else {
      run(
        `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, created_at) VALUES (?,?,?,?,?,?)`,
        [hotelId, channelType, action, status, message, nowIso()]
      );
    }
  } catch {
    // 日志表缺失时不能连带把业务动作一起失败（老库 / 刚部署还没迁移）
  }
}

/** 把异常压缩成一行文本写进日志，避免把堆栈塞进 message 里把列表撑爆 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 写操作日志（谁改了什么，审计用） */
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
    // 日志失败不影响业务动作
  }
}

type OrderRow = {
  id: number;
  channel_type: string;
  channel_order_no: string;
  room_type_id: number | null;
  guest_name: string;
  mobile: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  amount: number;
  status: string;
};

/**
 * 把一条渠道订单转成正式预订，返回预订号；失败返回 null。
 *
 * 第 4 轮整改：
 *   · 预订号改用 nextBookingNo()（配合 bookings(hotel_id, booking_no) 唯一索引，见 P2-14）
 *   · 订单号落进 bookings.channel_order_no（P1-21 的预订侧），前台入住时据此写 stays.channel_order_no
 *   · 接单后记一条库存待同步任务（P2-13：新单占房 → 渠道库存变了）
 */
function importOneOrder(user: SessionUser, order: OrderRow): string | null {
  const channel = get<{ id: number }>(
    `SELECT id FROM channels WHERE hotel_id = ? AND channel_type = ?`,
    [user.hotelId, order.channel_type]
  );
  const bookingNo = nextBookingNo(user.hotelId);
  const rate = order.nights > 0 ? Math.round((order.amount / order.nights) * 100) / 100 : order.amount;
  const now = nowIso();

  const inserted = run(
    `INSERT INTO bookings (hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id, channel_id, company_id,
       check_in_date, check_out_date, nights, room_count, guest_count, rate, deposit, status, guarantee, remark,
       channel_order_no, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      user.hotelId, bookingNo, null, order.guest_name, order.mobile, order.room_type_id, null,
      channel?.id ?? null, null, order.check_in_date, order.check_out_date, order.nights, 1, 1,
      rate, 0, "CONFIRMED", "渠道直连", `由 ${order.channel_type} 订单 ${order.channel_order_no} 自动接单转入`,
      order.channel_order_no, user.id, now, now,
    ]
  );

  run(
    `UPDATE channel_orders SET status = 'IMPORTED', booking_id = ?, imported_at = ? WHERE id = ? AND hotel_id = ?`,
    [inserted.lastInsertRowid, now, order.id, user.hotelId]
  );
  // 新单占房：渠道侧库存需要重推（只落队列，不实时打渠道接口）
  markStockDirty(user.hotelId, `渠道订单 ${order.channel_order_no} 转预订 ${bookingNo}`);
  return bookingNo;
}

/* ============================================================ 渠道配置保存 */

/** channels 表实际有哪些列（老库可能没有 sandbox / endpoint / app_secret_enc） */
function channelColumns(): Set<string> {
  try {
    return new Set(all<{ name: string }>(`PRAGMA table_info(channels)`).map((c) => c.name));
  } catch {
    return new Set<string>();
  }
}

/**
 * 保存渠道配置（整改清单 P2-11 / P2-12）。
 *
 * ── P2-11 补的三件事 ──
 *   1. **凭据写入路径**：原来 UPDATE 的列清单里只有 store_id / app_key / enabled / auto_import，
 *      `app_secret` 全项目没有任何地方能写 → 真实直连在系统里根本配不起来，只能靠 SQL 手改库；
 *   2. **加密**：app_secret 写进 `app_secret_enc`（AES-256-GCM，密钥由 SESSION_SECRET 派生），
 *      历史明文列同时置 NULL；页面上只回显掩码，留空 / 掩码表示「这次不改」；
 *   3. **sandbox / endpoint**：真实联调需要「先填凭据、再关沙箱」「指向渠道测试网关」，
 *      这两个开关原来只存在于 types.ts 的隐式推断里，现在有列、有表单、有守卫。
 *
 * ── P2-12 补的一件事 ──
 *   `commission` 原来同样没有写入路径（永远是种子里的那个数）。这里接受 0~100 的百分数
 *   或 0~1 的小数，统一归一成小数存库；非法值直接拒绝并留痕，不写进库。
 */
export async function saveChannelAction(formData: FormData): Promise<void> {
  /*
   * 权限（整改 P1-32）：渠道配置原来一律 requireAdmin()，权限点里虽然定义了
   * channel.configure，但全项目零引用 —— 管理员在「权限矩阵」里怎么改都不生效。
   * 配置类动作统一走 channel.configure（admin 由 hasPermission 恒放行，
   * 库里给其它角色勾上时也能用，不再写死只认 admin 角色）。
   */
  const user = await requirePermission("channel.configure");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    logOp(hotelId, operator, "CHANNEL_SAVE", "保存渠道配置失败：渠道 id 不合法");
    revalidatePath("/channels");
    return;
  }

  const storeId = String(formData.get("store_id") ?? "").trim();
  const appKey = String(formData.get("app_key") ?? "").trim();
  const rawSecret = String(formData.get("app_secret") ?? "").trim();
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  const enabled = formData.get("enabled") === "on" || formData.get("enabled") === "1" ? 1 : 0;
  const autoImport = formData.get("auto_import") === "on" || formData.get("auto_import") === "1" ? 1 : 0;
  // 沙箱开关：表单是复选框，未提交 = 关闭沙箱（= 允许真实请求）
  const sandbox = formData.get("sandbox") === "on" || formData.get("sandbox") === "1" ? 1 : 0;

  const existing = get<{ id: number; name: string | null; channel_type: string | null }>(
    `SELECT id, name, channel_type FROM channels WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!existing) {
    logOp(hotelId, operator, "CHANNEL_SAVE", `保存渠道配置失败：渠道 #${id} 不存在或不属于本店`);
    revalidatePath("/channels");
    return;
  }

  /* 佣金：非法值不写库 */
  const commissionRaw = formData.get("commission");
  let commissionUpdate: number | null = null;
  if (commissionRaw !== null && String(commissionRaw).trim() !== "") {
    const normalized = normalizeCommission(commissionRaw);
    if (normalized === null) {
      log(
        hotelId,
        existing.channel_type ?? "unknown",
        "CONFIG",
        "FAILED",
        `渠道 ${existing.name ?? id} 的佣金率保存失败：${String(commissionRaw)} 不是 0~100 的百分数或 0~1 的小数`,
        { errorCode: "INVALID_COMMISSION" }
      );
      revalidatePath("/channels");
      return;
    }
    commissionUpdate = normalized;
  }

  /*
   * 密钥：空 / 掩码 = 「这次不改」。
   * 这是表单回显的必然结果 —— 页面永远只显示 ••••••••，
   * 若把掩码当真密钥写库，第二天所有渠道都会 AUTH_FAILED。
   */
  const cols = channelColumns();
  const secretToStore =
    rawSecret === "" || isMaskedSecret(rawSecret) ? null : encryptSecret(rawSecret);
  if (secretToStore !== null && !isEncryptedSecret(secretToStore)) {
    log(hotelId, existing.channel_type ?? "unknown", "CONFIG", "FAILED", `渠道 ${existing.name ?? id} 的密钥加密失败，未保存`, {
      errorCode: "ENCRYPT_FAILED",
    });
    revalidatePath("/channels");
    return;
  }

  const sets: string[] = ["store_id = ?", "app_key = ?", "enabled = ?", "auto_import = ?"];
  const params: unknown[] = [storeId || null, appKey || null, enabled, autoImport];

  if (cols.has("app_secret_enc")) {
    if (secretToStore !== null) {
      sets.push("app_secret_enc = ?");
      params.push(secretToStore);
      // 历史明文列清空：加密列是唯一真相，明文留着等于没加密
      sets.push("app_secret = NULL");
    }
  } else if (secretToStore !== null) {
    // 老库还没跑迁移（没有加密列）：宁可拒绝也不写明文
    log(hotelId, existing.channel_type ?? "unknown", "CONFIG", "FAILED", `渠道 ${existing.name ?? id} 未保存密钥：数据库缺少 app_secret_enc 列，请先执行 node scripts/migrate-all.mjs`, {
      errorCode: "MIGRATION_REQUIRED",
    });
  }

  if (cols.has("sandbox")) {
    sets.push("sandbox = ?");
    params.push(sandbox);
  }
  if (cols.has("endpoint")) {
    sets.push("endpoint = ?");
    params.push(endpoint || null);
  }
  if (commissionUpdate !== null && cols.has("commission")) {
    sets.push("commission = ?");
    params.push(commissionUpdate);
  }

  run(`UPDATE channels SET ${sets.join(", ")} WHERE id = ? AND hotel_id = ?`, [...params, id, hotelId]);

  logOp(
    hotelId,
    operator,
    "CHANNEL_SAVE",
    `保存渠道配置 ${existing.name ?? id}：门店 ${storeId || "未填"}，密钥 ${secretToStore ? "已更新（加密存储）" : "未改动"}，` +
      `沙箱 ${sandbox ? "开" : "关"}，端点 ${endpoint || "渠道默认"}${commissionUpdate !== null ? `，佣金 ${(commissionUpdate * 100).toFixed(1)}%` : ""}`
  );
  revalidatePath("/channels");
}

/* ============================================================ 渠道开关 */

/** 单独开关：一键切换某渠道的自动接单 */
export async function toggleAutoImportAction(formData: FormData) {
  const user = await requirePermission("channel.configure");
  const type = String(formData.get("type"));
  if (!type) return;
  const ch = get<{ id: number; name: string; auto_import: number }>(
    `SELECT id, name, auto_import FROM channels WHERE hotel_id = ? AND channel_type = ?`,
    [user.hotelId, type]
  );
  if (!ch) return;
  const next = ch.auto_import ? 0 : 1;
  run(`UPDATE channels SET auto_import = ? WHERE id = ? AND hotel_id = ?`, [next, ch.id, user.hotelId]);
  log(user.hotelId, type, "AUTO_TOGGLE", "SUCCESS", `自动接单已${next ? "开启" : "关闭"}（${ch.name}）`);
  revalidatePath("/channels");
}

/** 切换某渠道超售开关（客户端矩阵点击后调用） */
export async function toggleOversellAction(type: string, next: boolean): Promise<void> {
  const user = await requirePermission("channel.configure");
  if (!type) return;
  const cols = new Set(all<{ name: string }>(`PRAGMA table_info(channels)`).map((c) => c.name));
  if (!cols.has("oversell")) run(`ALTER TABLE channels ADD COLUMN oversell INTEGER DEFAULT 0`);
  run(`UPDATE channels SET oversell = ? WHERE hotel_id = ? AND channel_type = ?`, [
    next ? 1 : 0,
    user.hotelId,
    type,
  ]);
  // 超售策略变了 → 渠道可售房量口径变了，需要重推库存（P2-13 接线）
  markStockDirty(user.hotelId, `渠道 ${type} 超售策略切换为${next ? "允许" : "不允许"}`);
  revalidatePath("/channels");
}

/* ============================================================ 渠道订单维护 */

/** 一键自动接单：把所有待处理渠道订单批量转成预订 */
export async function autoAcceptAllAction() {
  const user = await requirePermission("channel.configure");
  const operator = user.realName ?? user.username;
  const orders = all<OrderRow>(
    `SELECT id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
            check_in_date, check_out_date, nights, amount, status
     FROM channel_orders WHERE hotel_id = ? AND status = 'NEW' ORDER BY id`,
    [user.hotelId]
  );
  if (orders.length === 0) {
    log(user.hotelId, "all", "AUTO_ACCEPT", "SUCCESS", "没有待处理的渠道订单");
    revalidatePath("/channels");
    return;
  }

  let ok = 0;
  const byChannel: Record<string, string[]> = {};
  for (const o of orders) {
    try {
      const bk = importOneOrder(user, o);
      if (bk) {
        ok++;
        (byChannel[o.channel_type] ??= []).push(`${o.channel_order_no}→${bk}`);
      }
    } catch (e) {
      // 批量接单必须逐条容错：一条坏单不能把后面几十条一起拖垮。
      // 失败的订单单独留一条日志，页面上能按渠道逐条重试，告警也能按天数出异常渠道
      log(user.hotelId, o.channel_type, "AUTO_ACCEPT", "FAILED", `订单 ${o.channel_order_no} 自动接单失败：${errText(e)}`, {
        errorCode: "IMPORT_FAILED",
      });
    }
  }
  for (const [ch, list] of Object.entries(byChannel)) {
    log(user.hotelId, ch, "AUTO_ACCEPT", "SUCCESS", `自动接单 ${list.length} 条：${list.join("、")}`);
  }
  if (ok > 0) logOp(user.hotelId, operator, "CHANNEL_AUTO_ACCEPT", `一键自动接单 ${ok} 条`);
  revalidatePath("/channels");
  revalidatePath("/bookings");
  revalidatePath("/dashboard");
}

export async function importOrderAction(formData: FormData) {
  const user = await requirePermission("channel.configure");
  const operator = user.realName ?? user.username;
  const orderId = Number(formData.get("orderId"));
  const order = get<OrderRow>(
    `SELECT id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
            check_in_date, check_out_date, nights, amount, status
     FROM channel_orders WHERE id = ? AND hotel_id = ?`,
    [orderId, user.hotelId]
  );
  if (!order || order.status !== "NEW") return;
  try {
    const bk = importOneOrder(user, order);
    if (bk) {
      log(user.hotelId, order.channel_type, "IMPORT", "SUCCESS", `订单 ${order.channel_order_no} 已转入预订 ${bk}`);
      logOp(user.hotelId, operator, "CHANNEL_IMPORT", `渠道订单 ${order.channel_order_no} 转入预订 ${bk}`);
    }
  } catch (e) {
    // 单条转入失败要把原因写进同步日志：用户在渠道页点了「转入预订」，
    // 没反应又没有记录时只能反复点，重试次数也就无法统计
    log(user.hotelId, order.channel_type, "IMPORT", "FAILED", `订单 ${order.channel_order_no} 转入预订失败：${errText(e)}`, {
      errorCode: "IMPORT_FAILED",
    });
  }
  revalidatePath("/channels");
  revalidatePath("/bookings");
  revalidatePath("/dashboard");
}

/**
 * 拒单（忽略一条渠道订单）。
 *
 * 整改清单 P1-20：拒单是**必须回传渠道**的动作 —— 渠道侧还挂着这间房，
 * 本地直接置 CANCELLED 而渠道不知道，就会出现「渠道照卖给客人、本店已经拒了」。
 * 所以这里先回传 CANCELLED，再改本地状态（渠道没确认时本地仍标记取消，
 * 因为拒单是酒店的既定决定，但日志里会明确写「未回传成功」，运维去渠道后台补）。
 */
export async function ignoreOrderAction(formData: FormData) {
  const user = await requirePermission("channel.configure");
  const operator = user.realName ?? user.username;
  const orderId = Number(formData.get("orderId"));
  if (!orderId) return;
  const order = get<{ id: number; channel_type: string; channel_order_no: string; booking_id: number | null }>(
    `SELECT id, channel_type, channel_order_no, booking_id FROM channel_orders WHERE id = ? AND hotel_id = ?`,
    [orderId, user.hotelId]
  );
  if (!order) return;

  const pushed = await pushOrderStatusForChannelOrder({
    hotelId: user.hotelId,
    channelOrderId: order.id,
    status: "CANCELLED",
    reason: "酒店拒单",
    operator,
    source: "channels-ignore",
  });

  run(`UPDATE channel_orders SET status = 'CANCELLED' WHERE id = ? AND hotel_id = ?`, [orderId, user.hotelId]);
  // 拒单释放了库存 → 需要重推渠道房量（P2-13 接线）
  markStockDirty(user.hotelId, `渠道订单 ${order.channel_order_no} 拒单`);
  logOp(
    user.hotelId,
    operator,
    "CHANNEL_IGNORE",
    `拒单 ${order.channel_order_no}：${pushed.ok ? "已回传渠道" : `回传未成功（${pushed.code ?? "-"}），请到渠道后台核对`}`
  );
  revalidatePath("/channels");
  revalidatePath("/channel-orders");
}

/* ============================================================ 渠道房型 / 价格方案映射 */

/**
 * 保存一条「渠道房型名 ↔ 本系统房型」映射（整改清单 P2-10）。
 *
 * 为什么必须有这个写入路径：P2-10 的修复本身**依赖**这张表 ——
 * 没有映射的房型现在会被 planRatePush 剔进 rejected（渠道侧必然报「房型不存在」），
 * 如果管理员在页面上没法补映射，等于把「静默降级」换成了「永远推不出去」。
 *
 * 唯一键 (hotel_id, channel_type, channel_room_name) 与迁移里的
 * idx_channel_room_types_key 一致，重复保存同一渠道房型名就是改绑房型。
 */
export async function saveChannelRoomTypeAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.configure");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const channelType = String(formData.get("channel_type") ?? "").trim();
  const channelRoomName = String(formData.get("channel_room_name") ?? "").trim();
  const roomTypeId = Number(formData.get("room_type_id"));

  if (channelType === "" || channelRoomName === "" || !Number.isFinite(roomTypeId) || roomTypeId <= 0) {
    logOp(hotelId, operator, "CHANNEL_ROOM_MAP", "保存房型映射失败：渠道 / 渠道房型名 / 本系统房型必须都填");
    revalidatePath("/channels");
    return;
  }
  const roomType = get<{ id: number; name: string }>(`SELECT id, name FROM room_types WHERE id = ? AND hotel_id = ?`, [
    roomTypeId,
    hotelId,
  ]);
  if (!roomType) {
    logOp(hotelId, operator, "CHANNEL_ROOM_MAP", `保存房型映射失败：本店没有房型 #${roomTypeId}`);
    revalidatePath("/channels");
    return;
  }

  try {
    run(
      `INSERT INTO channel_room_types (hotel_id, channel_type, channel_room_name, room_type_id, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(hotel_id, channel_type, channel_room_name) DO UPDATE SET room_type_id = excluded.room_type_id`,
      [hotelId, channelType, channelRoomName, roomTypeId, nowIso()]
    );
    logOp(
      hotelId,
      operator,
      "CHANNEL_ROOM_MAP",
      `房型映射已保存：${channelType}「${channelRoomName}」→ ${roomType.name}（#${roomTypeId}）`
    );
  } catch (e) {
    log(hotelId, channelType, "CONFIG", "FAILED", `保存房型映射失败：${errText(e)}`, { errorCode: "MAPPING_SAVE_FAILED" });
  }
  revalidatePath("/channels");
}

/**
 * 保存一条渠道价格方案（整改清单 P2-10 问题 3）。
 *
 * factor = 该渠道价格相对本系统房价的系数（1.15 = 加价 15%，0.9 = 九折）；
 * room_type_id 留空表示「本渠道通用方案」。推价时 planRatePush 按
 * 「房型专属 → 渠道通用 → 房价日历 / 基准价」的顺序取，取不到会显式提示回退。
 */
export async function saveChannelRatePlanAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.configure");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const channelType = String(formData.get("channel_type") ?? "").trim();
  const rateCode = String(formData.get("rate_code") ?? "").trim();
  const rateName = String(formData.get("channel_rate_name") ?? "").trim();
  const factorRaw = Number(formData.get("factor"));
  const roomTypeRaw = String(formData.get("room_type_id") ?? "").trim();
  const roomTypeId = roomTypeRaw === "" ? null : Number(roomTypeRaw);

  if (channelType === "" || rateCode === "") {
    logOp(hotelId, operator, "CHANNEL_RATE_PLAN", "保存价格方案失败：渠道与方案编码必填");
    revalidatePath("/channels");
    return;
  }
  if (!Number.isFinite(factorRaw) || factorRaw <= 0 || factorRaw > 10) {
    log(hotelId, channelType, "CONFIG", "FAILED", `保存价格方案 ${rateCode} 失败：系数需在 0~10 之间（当前 ${formData.get("factor")}）`, {
      errorCode: "INVALID_FACTOR",
    });
    revalidatePath("/channels");
    return;
  }

  try {
    run(
      `INSERT INTO channel_rate_plans (hotel_id, channel_type, rate_code, channel_rate_name, factor, room_type_id, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(hotel_id, channel_type, rate_code) DO UPDATE SET
         channel_rate_name = excluded.channel_rate_name,
         factor = excluded.factor,
         room_type_id = excluded.room_type_id`,
      [hotelId, channelType, rateCode, rateName || null, factorRaw, roomTypeId, nowIso()]
    );
    logOp(
      hotelId,
      operator,
      "CHANNEL_RATE_PLAN",
      `价格方案已保存：${channelType} / ${rateCode} × ${factorRaw}${roomTypeId ? `（房型 #${roomTypeId}）` : "（渠道通用）"}`
    );
  } catch (e) {
    log(hotelId, channelType, "CONFIG", "FAILED", `保存价格方案失败：${errText(e)}`, { errorCode: "RATE_PLAN_SAVE_FAILED" });
  }
  revalidatePath("/channels");
}

/** 删除一条价格方案 */
export async function deleteChannelRatePlanAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.configure");
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    run(`DELETE FROM channel_rate_plans WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
    logOp(user.hotelId, user.realName ?? user.username, "CHANNEL_RATE_PLAN", `已删除价格方案 #${id}`);
  } catch {
    // 表缺失时忽略
  }
  revalidatePath("/channels");
}

/* ============================================================ 渠道佣金对账 */

/**
 * 重建「渠道佣金对账」的系统推算快照（整改清单 P2-12）。
 *
 * 只重算 `source='derived'` 的行：按渠道订单金额 × 该渠道的佣金率生成每单一行，
 * `source='channel'` 的真实结算单一个字节都不动 —— 那是渠道给的对账依据。
 *
 * 为什么要有这个按钮：佣金率可以在渠道配置里改，改完必须能把区间内的推算值整段重算，
 * 否则页面上的差额是「新旧费率混在一起」的产物，越看越糊涂。
 */
export async function rebuildChannelSettlementsAction(formData: FormData): Promise<void> {
  const user = await requirePermission("channel.configure");
  const hotelId = user.hotelId;
  const operator = user.realName ?? user.username;
  const from = String(formData.get("from") ?? "").trim();
  const to = String(formData.get("to") ?? "").trim();
  const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!validDate(from) || !validDate(to) || from > to) {
    logOp(hotelId, operator, "CHANNEL_SETTLE_REBUILD", `佣金对账重建失败：区间不合法（${from || "-"} ~ ${to || "-"}）`);
    revalidatePath("/channels");
    return;
  }

  const rebuilt = rebuildDerivedSettlements(hotelId, { from, to });
  logOp(
    hotelId,
    operator,
    "CHANNEL_SETTLE_REBUILD",
    `佣金对账重建 ${from} ~ ${to}：清除旧推算 ${rebuilt.removed} 条，写入 ${rebuilt.inserted} 条，跳过 ${rebuilt.skipped} 条`
  );
  revalidatePath("/channels");
}
