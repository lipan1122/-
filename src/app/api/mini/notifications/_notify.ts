/**
 * 小程序站内通知：建表 + 写入 + 类型文案（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * ── 为什么单独一个文件 ──
 * 通知的「表结构」与「写入入口」会被三处用到：
 *   · /api/mini/notifications        （读：列表 / 未读数）
 *   · /api/mini/notifications/read   （写：标记已读）
 *   · /api/mini/breakfast、/api/mini/invoices（业务动作成功后落一条通知）
 * 表结构在这个文件里只写一份，避免三条路由各抄一遍 CREATE TABLE 将来漂移。
 * 文件名以 `_` 开头，Next 不会把它当成路由（只有 route.ts 才是路由）。
 *
 * ── 安全边界（清单第 302 行硬要求）──
 * 「通知必须只发给对应 mini_user_id，不能按手机号群发」。
 * 也就是说 mini_notifications 的**唯一**归属字段是 mini_user_id（服务端从
 * Bearer token 解析出来的那一行 mini_program_users.id）；这张表刻意不存
 * mobile / guest_id —— 一旦存了手机号，将来一定会有人写出「按手机号发通知」
 * 的群发 SQL，而手机号在绑定流程里是用户自填的、可被冒用的字段。
 * 收件人 id 只允许由调用方从 token 传入，任何请求体里的 miniUserId 都会被忽略。
 *
 * ── 与 migrate-all 的关系 ──
 * 正式建表在 scripts/migrate-all.mjs（第 12.3 段），本文件的
 * CREATE TABLE IF NOT EXISTS 只是「克隆仓库直接 dev / 接口先跑起来」的幂等兜底
 * （与 src/lib/invoice.ts 的 ensureInvoiceSchema 同一约定）。
 */

import { all, get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";

/** 通知类型（落库存 code，展示用中文名；新增类型只加不删，历史数据要能继续显示） */
export const MINI_NOTIFY_TYPE = {
  BOOKING_CREATED: "BOOKING_CREATED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  ROOM_ASSIGNED: "ROOM_ASSIGNED",
  CHECKIN_REMINDER: "CHECKIN_REMINDER",
  STAY_EXTENDED: "STAY_EXTENDED",
  ROOM_CHANGED: "ROOM_CHANGED",
  SERVICE_ACCEPTED: "SERVICE_ACCEPTED",
  SERVICE_DONE: "SERVICE_DONE",
  CHECKOUT_DONE: "CHECKOUT_DONE",
  INVOICE_ISSUED: "INVOICE_ISSUED",
  BREAKFAST_PURCHASED: "BREAKFAST_PURCHASED",
  UNBOUND: "UNBOUND",
  SYSTEM: "SYSTEM",
} as const;

export type MiniNotifyType = (typeof MINI_NOTIFY_TYPE)[keyof typeof MINI_NOTIFY_TYPE];

/** 类型 → 中文名（小程序消息列表左上角的标签） */
export const MINI_NOTIFY_TYPE_LABEL: Record<string, string> = {
  BOOKING_CREATED: "预订成功",
  BOOKING_CANCELLED: "预订取消",
  BOOKING_CONFIRMED: "订单确认",
  ROOM_ASSIGNED: "房间已分配",
  CHECKIN_REMINDER: "入住提醒",
  STAY_EXTENDED: "续住结果",
  ROOM_CHANGED: "换房结果",
  SERVICE_ACCEPTED: "服务受理",
  SERVICE_DONE: "服务完成",
  CHECKOUT_DONE: "退房完成",
  INVOICE_ISSUED: "发票开具",
  BREAKFAST_PURCHASED: "早餐购买",
  UNBOUND: "解除绑定",
  SYSTEM: "系统通知",
};

/** 未知 / 历史类型的中文回退（不能把英文 code 直接甩给客人） */
export const MINI_NOTIFY_TYPE_FALLBACK = "通知";

/** 单条标题 / 正文长度上限：通知是展示用文本，超长一律截断，不写爆库 */
export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 1000;

let schemaReady = false;

/**
 * 懒建表（幂等）。
 *
 * 列与 scripts/migrate-all.mjs 第 12.3 段、scripts/schema-full.sql 完全一致：
 *   id / hotel_id / mini_user_id / type / title / body / read_at / created_at / ref_type / ref_id
 *
 * read_at 用「时间戳而不是 0/1」：客人问「我什么时候看的」能答，也便于将来做
 * 「未读超过 N 天」的清理；NULL = 未读。
 * UNIQUE 刻意不加：同一业务单据可以有多条通知（例如「已受理」「已完成」各一条），
 * 幂等由写入方自己的业务状态机保证，而不是在这里靠唯一索引硬挡。
 */
export function ensureMiniNotificationsSchema(): void {
  if (schemaReady) return;
  run(`
    CREATE TABLE IF NOT EXISTS mini_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      mini_user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      read_at TEXT,
      created_at TEXT,
      ref_type TEXT,
      ref_id INTEGER
    )
  `);
  run(
    `CREATE INDEX IF NOT EXISTS idx_mini_notifications_user
       ON mini_notifications(hotel_id, mini_user_id, read_at)`
  );
  schemaReady = true;
}

/** 写入入参：hotelId / miniUserId 必须来自服务端（token），不能来自请求体 */
export type MiniNotifyInput = {
  hotelId: number;
  /** mini_program_users.id（从 Bearer token 解析，绝不允许客户端传） */
  miniUserId: number;
  type: string;
  title: string;
  body?: string | null;
  /** 关联业务：如 booking / stay / invoice / breakfast */
  refType?: string | null;
  refId?: number | null;
};

/** 文本归一：去首尾空格 + 截断，空串返回空串（由调用方决定是否必填） */
function clip(value: unknown, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 安全写入一条通知：**任何异常都不向上抛**。
 *
 * 为什么必须吞异常：通知是业务动作的「附带信息」（买完早餐给个提醒）。
 * 如果通知表缺失 / 写失败就把整笔早餐购买回滚掉，等于让一个纯展示功能
 * 拖垮收银链路 —— 与项目里「op_logs 写失败不能反过来让业务失败」同一原则。
 * 失败时返回 false，调用方可以记日志，但不改变业务结果。
 */
export function safeNotify(input: MiniNotifyInput): boolean {
  try {
    const hotelId = Math.trunc(Number(input.hotelId));
    const miniUserId = Math.trunc(Number(input.miniUserId));
    const title = clip(input.title, NOTIFY_TITLE_MAX);
    if (!(hotelId > 0) || !(miniUserId > 0) || !title) return false;

    ensureMiniNotificationsSchema();
    const type = clip(input.type, 40) || "SYSTEM";
    const body = clip(input.body ?? "", NOTIFY_BODY_MAX) || null;
    const refType = clip(input.refType ?? "", 40) || null;
    const refIdRaw = Number(input.refId ?? 0);
    const refId = Number.isFinite(refIdRaw) && refIdRaw > 0 ? Math.trunc(refIdRaw) : null;

    run(
      `INSERT INTO mini_notifications
         (hotel_id, mini_user_id, type, title, body, read_at, created_at, ref_type, ref_id)
       VALUES (?,?,?,?,?,NULL,?,?,?)`,
      [hotelId, miniUserId, type, title, body, nowIso(), refType, refId]
    );
    return true;
  } catch {
    /* 通知失败不影响业务：静默降级，由业务方自己的日志负责可观测性 */
    return false;
  }
}

/** 通知列表行（只声明用得到的列） */
export type MiniNotifyRow = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string | null;
  ref_type: string | null;
  ref_id: number | null;
};

/** 未读条数（列表页角标用） */
export function countUnreadNotifications(hotelId: number, miniUserId: number): number {
  ensureMiniNotificationsSchema();
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mini_notifications
      WHERE hotel_id = ? AND mini_user_id = ? AND read_at IS NULL`,
    [hotelId, miniUserId]
  );
  return Number(row?.n ?? 0);
}

/**
 * 通知列表：**只按 (hotel_id, mini_user_id) 取数**，没有第三种过滤入口。
 *
 * 这也是「不按手机号群发」在读取侧的落实：查询条件里根本不出现 mobile / guest_id，
 * 想串号都没有可写的条件。
 */
export function listNotifications(
  hotelId: number,
  miniUserId: number,
  opts: { limit?: number; unreadOnly?: boolean; type?: string } = {}
): MiniNotifyRow[] {
  ensureMiniNotificationsSchema();
  const limitRaw = Math.trunc(Number(opts.limit ?? 50));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

  const where = ["hotel_id = ?", "mini_user_id = ?"];
  const params: unknown[] = [hotelId, miniUserId];
  if (opts.unreadOnly) where.push("read_at IS NULL");
  const type = (opts.type ?? "").trim();
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  params.push(limit);

  return all<MiniNotifyRow>(
    `SELECT id, type, title, body, read_at, created_at, ref_type, ref_id
       FROM mini_notifications
      WHERE ${where.join(" AND ")}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?`,
    params
  );
}

/** 该用户的通知总条数（不受分页 limit 影响） */
export function countNotifications(hotelId: number, miniUserId: number, unreadOnly = false): number {
  ensureMiniNotificationsSchema();
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mini_notifications
      WHERE hotel_id = ? AND mini_user_id = ?${unreadOnly ? " AND read_at IS NULL" : ""}`,
    [hotelId, miniUserId]
  );
  return Number(row?.n ?? 0);
}
