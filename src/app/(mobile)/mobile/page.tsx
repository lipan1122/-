import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * `/m` 之外的移动端入口：`/mobile` → `/m`
 *
 * 有人习惯直接输 /mobile，给个短跳转，不要 404。
 * 如果是桌面浏览器打开，也送进来（不强行跳回电脑版——手机模拟调试常用）。
 */
export default async function MobileEntry() {
  const h = await headers();
  const isPrefetch = h.get("sec-fetch-mode") === "cors" || h.get("next-router-prefetch") === "1";
  const user = await getSession();
  if (!user) {
    if (isPrefetch) return null;
    redirect("/login");
  }
  redirect("/m");
}
