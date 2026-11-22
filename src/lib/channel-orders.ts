/**
 * 渠道订单「待处理」状态集合（全站唯一口径）
 *
 * ── 为什么单独抽一个模块（第七轮整改清单一.4）──
 * 「待处理渠道订单」在页面上出现过两个地方：
 *   1. 房态页底部功能条「直连订单」的角标（第 5 轮 P0-2 修的就是它）；
 *   2. 顶部导航「渠道预订」旁的红点 / 数字（本轮修的是它）。
 * 之前状态集合定义在 `src/app/(main)/rooms/page.tsx` 顶部（模块级 const，没 export），
 * 顶部布局拿不到，只能靠「另写一份」——而另写一份就是下一次分叉的开始：
 * 房态页角标数 6、顶部数字却按 PENDING 算成 0，前台看到的两个数字永远对不上。
 *
 * 现在集合、SQL 占位符、计数语句都只在这里定义一次：
 *   · rooms/page.tsx       —— import 集合 + 占位符（角标 / 悬浮列表 / 计数）
 *   · (main)/layout.tsx    —— import countPendingChannelOrders()（顶部数字）
 * 两处口径因此不可能再分叉。
 *
 * ── 实测 channel_orders.status 取值分布（data/pms.db，2026-11-22，hotel_id = 1）──
 *   IMPORTED 964 · CANCELLED 242 · CONFIRMED 10 · NEW 6（合计 1222），**PENDING 一条都没有**。
 * 代码里会写入的全部状态（逐个核对过写入点）：
 *   · NEW        —— 建表默认值；upsertChannelOrder() 拉单落库也写它（真正的新单待处理）
 *   · CONFIRMED  —— 渠道确认后经 order-status.ts 状态回传落库，还没转预订，仍要前台处理
 *   · PENDING    —— 历史/兼容写法，当前代码不再写入，保留在集合里不影响正确性
 *   · IMPORTING  —— 转入预订的中间态（转完即 IMPORTED），不是待办
 *   · IMPORTED   —— 已转入预订，处理完了
 *   · CANCELLED  —— 渠道已取消
 *   · CHECKED_IN / CHECKED_OUT / NOSHOW —— 状态回传成功后的本地推进（已进店/已离店/未到），不是待办
 * 清单里提到的 `REJECTED` 在 channel_orders 没有任何写入点（只有 order-status.ts 的**返回码**叫 REJECTED），
 * 不在待处理集合里。
 *
 * ── 待处理 = 还没被前台处理掉的单 ──
 *   NEW + CONFIRMED + PENDING
 *
 * ⚠️ 本模块 import 了 @/lib/db（node:sqlite），只能在服务端组件 / action / 脚本里用，
 * 客户端组件不要 import（只需要类型时请 import type）。
 */

import { get } from "@/lib/db";

/** 待处理渠道订单状态集合（顺序即 SQL 占位符顺序） */
export const CHANNEL_ORDER_PENDING_STATUSES = ["NEW", "CONFIRMED", "PENDING"] as const;

/** 集合里的单个状态字面量类型 */
export type ChannelOrderPendingStatus = (typeof CHANNEL_ORDER_PENDING_STATUSES)[number];

/** 拼进 SQL 的占位符（数量与上面的集合一一对应） */
export const CHANNEL_ORDER_PENDING_IN = CHANNEL_ORDER_PENDING_STATUSES.map(() => "?").join(",");

/**
 * 待处理订单计数语句（唯一口径来源）。
 *
 * hotel_id 一律作为第一个占位符，调用方传进来的酒店必须来自服务端 session，
 * 不能来自页面 query —— 否则任何登录用户都能看到别家店的待办数量。
 */
export const CHANNEL_ORDER_PENDING_COUNT_SQL =
  `SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = ? AND status IN (${CHANNEL_ORDER_PENDING_IN})`;

/**
 * 统计某家酒店的待处理渠道订单数。
 *
 * 顶部导航（(main)/layout.tsx）与房态页角标（rooms/page.tsx）共用这一份口径；
 * 表还没建（全新部署、只跑了部分迁移）时返回 0 而不是让整个布局 500 ——
 * 待办角标少显示一个数字，比所有页面打不开的代价小得多。
 */
export function countPendingChannelOrders(hotelId: number): number {
  const hotel = Math.trunc(Number(hotelId));
  if (!(hotel > 0)) return 0;
  try {
    const row = get<{ n: number }>(CHANNEL_ORDER_PENDING_COUNT_SQL, [
      hotel,
      ...CHANNEL_ORDER_PENDING_STATUSES,
    ]);
    return Number(row?.n ?? 0);
  } catch {
    // no such table: channel_orders —— 迁移没跑完时的兜底
    return 0;
  }
}
