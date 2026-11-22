import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { canAccess, getSession } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";

/**
 * 管理类页面：只有 admin 能进
 * （普通前台/收银/客房账号直接访问会被挡回工作台）
 */
const ADMIN_ONLY = [
  "/settings",
  "/channels",
  "/lock-settings",
  "/logs",
  "/query-logs",
  "/wechat",
  "/dummy-rooms",
  "/rate-codes",
  "/sms",
  "/devices",
];

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
 */
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const isPrefetch = h.get("sec-fetch-mode") === "cors" || h.get("next-router-prefetch") === "1";

  const user = await getSession();
  if (!user) {
    if (isPrefetch) return null;
    redirect("/login");
  }

  /* ---------- 角色守卫（预取也照样判断，只是命中越权时不 redirect） ---------- */
  const rawPath = h.get("x-pathname") ?? "";
  const pathname = (rawPath.split("?")[0] || "").replace(/\/$/, "") || "/";

  if (pathname !== "/") {
    const blocked = (() => {
      if (
        user.role !== "admin" &&
        ADMIN_ONLY.some((p) => pathname === p || pathname.startsWith(p + "/"))
      ) {
        return true;
      }
      return !canAccess(user.role, pathname, user.hotelId);
    })();

    if (blocked) {
      /*
       * 预取请求也 redirect（不再 return null）
       *
       * Next 16 的 layout 里 `return null` 并不会阻止 child 页面渲染 ——
       * 实测带 `sec-fetch-mode: cors` 访问 /settings 仍返回 66573 字节完整页面。
       * redirect 对预取同样是安全的：客户端拿到 307 就不缓存该路由。
       */
      redirect("/dashboard?err=" + encodeURIComponent("当前角色无权访问该页面"));
    }
  }

  return (
    <AppShell
      user={{ realName: user.realName, role: user.role, hotelName: user.hotelName }}
      bizDate={bizToday(user.hotelId)}
    >
      {children}
    </AppShell>
  );
}
