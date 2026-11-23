import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { PATHNAME_HEADER, getSession, normalizePathname, pageAccessOf } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { countPendingChannelOrders } from "@/lib/channel-orders";

/**
 * 主布局
 *
 * 1. 登录态：靠服务端 session（cookie 只带随机 sid），预取请求不重定向
 * 2. 角色守卫：middleware 把 pathname 通过 `x-pathname` 透传进来，这里查库拿角色再判断
 *
 * ⚠️ 安全约束（整改指令 5.1/5.2 的补充修复）
 *
 * 预取请求（`sec-fetch-mode: cors` / `next-router-prefetch: 1`）**只能跳过 redirect**，
 * 绝不能跳过权限判断本身 —— 曾经写成 `if (!isPrefetch && ...)` 把整个守卫包起来，
 * 结果任何已登录用户只要在请求里加一个 `sec-fetch-mode: cors` 头，
 * 就拿到了受保护页面（/settings、/night-audit 等）的完整 HTML。
 *
 * 正确做法：权限判断永远执行；预取请求命中越权时不 redirect（那会让 Next 缓存一次跳转），
 * 而是返回 null 空壳 —— 客户端预取拿到空壳什么也不缓存，真正导航时仍会被拦。
 *
 * ⚠️ 但注意（P0 架构修复后）：这里**不再是唯一的页面守卫**
 *   · 判定口径已抽到 `@/lib/session` 的 `pageAccessOf()`（含 ADMIN_ONLY_PATHS 与移动端映射），
 *     本文件与 `requireUser()` 共用同一份，避免两处分叉；
 *   · Server Action 不经过 layout，由 `requireUser()` 里的 guardPageAccess 兜住；
 *   · GET 页面在第一行 `requireUser()` 时就会再判一次，越权时**在任何数据查询之前**
 *     redirect —— 这样 307 响应体里不会带出受保护页面的数据（问题 2）。
 */
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const isPrefetch = h.get("sec-fetch-mode") === "cors" || h.get("next-router-prefetch") === "1";

  const user = await getSession();
  if (!user) {
    if (isPrefetch) return null;
    redirect("/login");
  }

  /* ---------- 角色守卫（预取也照样判断；口径见 @/lib/session 的 pageAccessOf） ---------- */
  const pathname = normalizePathname(h.get(PATHNAME_HEADER));
  const gate = pageAccessOf(user, pathname);
  if (!gate.allowed) {
    /*
     * 预取请求也 redirect（不再 return null）
     *
     * Next 16 的 layout 里 `return null` 并不会阻止 child 页面渲染 ——
     * 实测带 `sec-fetch-mode: cors` 访问 /settings 仍返回 66573 字节完整页面。
     * redirect 对预取同样是安全的：客户端拿到 307 就不缓存该路由。
     */
    redirect(gate.redirectTo);
  }

  /*
   * 顶部导航「渠道预订」的数字（第七轮整改清单一.4）
   *
   * 之前这里没传：AppShell 的 pendingChannelOrders 一直是 undefined，
   * 于是「渠道预订」旁永远只有一个小红点，前台看不出有几张单要接。
   *
   * 口径与房态页底部「直连订单」角标**同一个模块**（@/lib/channel-orders）：
   *   · 状态集合 NEW + CONFIRMED + PENDING；
   *   · 计数走该模块的 CHANNEL_ORDER_PENDING_COUNT_SQL / countPendingChannelOrders()，
   *     房态页角标用同一份占位符常量拼 SQL —— 两处各写一份就是上一版分叉的根因。
   *
   * hotel_id 必须来自服务端 session（user.hotelId）—— 不能用 searchParams /
   * header 里的任何值，否则越权用户能改一个数字就看到别家店的待办数量。
   * 表还没建时 countPendingChannelOrders() 返回 0（只显示红点），不会让布局 500。
   */
  return (
    <AppShell
      user={{ realName: user.realName, role: user.role, hotelName: user.hotelName }}
      bizDate={bizToday(user.hotelId)}
      pendingChannelOrders={countPendingChannelOrders(user.hotelId)}
    >
      {children}
    </AppShell>
  );
}
