import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * 移动端打扫（F13 与现有 /mobile-housekeeping 的桥接）
 *
 * 老实说：阿姨用的那个大按钮版本 `/mobile-housekeeping` 已经做得很好了，
 * 没必要再写一遍。这里只做「按我名下筛」的跳转，保持 Tab 结构完整。
 *
 * 如果以后要合并，把 /mobile-housekeeping 改名成 /m/housekeeping 即可。
 */
export default async function MobileHousekeepingRedirect() {
  const user = await requireUser();
  const hotelId = user.hotelId;

  /* 有指派给自己的任务就直接带筛选参数过去，省一次点击 */
  const mine = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM housekeeping
      WHERE hotel_id = ? AND status IN ('PENDING','DOING') AND assignee = ?`,
    [hotelId, user.realName]
  )?.c ?? 0;

  if (mine > 0) {
    redirect(`/mobile-housekeeping?assignee=${encodeURIComponent(user.realName)}`);
  }
  redirect("/mobile-housekeeping");
}
