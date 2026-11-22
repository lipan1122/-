import { get } from "./db";

/**
 * 无人可派时写入的占位姓名。
 *
 * 不要写空串：移动端客房页面按 assignee 过滤（`AND h.assignee = ?`），
 * 空串会落进「非 admin 只看自己」的过滤条件之外 —— 阿姨打开手机看不到这单，
 * 任务卡也显示「未指派」，看起来像数据坏了。写「待分配」让任务在 admin 视图里
 * 能一眼被发现并手动改派。
 */
export const HOUSEKEEPING_UNASSIGNED = "待分配";

/**
 * 选一个打扫员（整改 P2-5）
 *
 * 背景：退房 / 取消入住时生成打扫任务的代码里把打扫员写死成某个固定姓名，
 * 不管当天谁当班，任务都派给同一个人。夜班、休假、换人时任务不会流转，
 * 手机端按 assignee 过滤还看不到，房间就一直空脏着。
 *
 * 选取规则（与产品确认过的口径一致，保持简单可预测）：
 *   1. 本店在岗的客房人员：users 表 role = 'housekeeping' 且 status = 1，
 *      按 id 升序取第一个 —— 同一家店每次派给同一个人，不会因为查询顺序
 *      变化导致任务在几个人之间跳来跳去；
 *   2. 本店没有在岗客房人员时返回「待分配」，由管理员在客房中心手动改派。
 *
 * 为什么不用「班次」：shifts 表里的班次是「早班 / 中班 / 夜班」这种时段概念，
 * 不是人；把「夜班」写进 assignee 会让手机端的「我的任务」永远筛不到它，
 * 也统计不出某个人的工作量。要按班次找人，前提是班次表记了人（当前没有），
 * 所以这里直接取在岗客房人员，语义正确且不引入新表。
 *
 * 注意：如果店里配了多名客房人员，这里只会固定派给 id 最小的那位。
 * 需要按工作量均衡派单时再改这里（本函数是唯一派单入口，改动面很小）。
 */
export function pickHousekeepingAssignee(hotelId: number): string {
  // 非法酒店 ID 直接兜底，避免把 undefined / NaN 传进 SQL 变成全表第一行
  if (!Number.isFinite(hotelId) || hotelId <= 0) return HOUSEKEEPING_UNASSIGNED;

  const row = get<{ real_name: string | null }>(
    `SELECT real_name
       FROM users
      WHERE hotel_id = ? AND role = 'housekeeping' AND status = 1
      ORDER BY id
      LIMIT 1`,
    [hotelId]
  );

  // 姓名可能为空串 / NULL（历史数据），同样按「待分配」处理
  const name = (row?.real_name ?? "").trim();
  return name || HOUSEKEEPING_UNASSIGNED;
}
