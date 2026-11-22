import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { canAccess, getSession } from "@/lib/session";
import MobileTabBar from "@/components/mobile/MobileTabBar";

/**
 * 员工移动端布局（整改清单 F13）
 *
 * 和桌面端 `(main)` 的区别：
 *   · 没有顶部大菜单（手机上放不下 28 个入口）
 *   · 底部固定 Tab 导航（拇指够得到）
 *   · 内容区单列、卡片化、大按钮
 *   · 同一个 session，只是呈现方式不同
 *
 * ⚠️ 安全约束（上线前加固，审计实测漏洞）：
 *   原来这里只有 `getSession()`，登录了就能进 —— housekeeper 账号访问 /cashier 会被
 *   桌面布局 307 挡回，但访问 /m/cashier 直接 200，能看到今日收款和全店客人余额。
 *   现在按 `(main)/layout.tsx` 同一套 `canAccess(role, module, hotelId)` 判断：
 *   只信任服务端 session 里的角色，权限矩阵仍是 role_modules 表（设置页可改）。
 */

/**
 * 移动端子路由 → 桌面端模块名
 *
 * 权限矩阵（role_modules / ROLE_MODULES）里登记的是桌面路径，移动端 /m/xxx 只是
 * 同一个模块的手机版入口，所以判断前先换算成桌面模块名：
 *   /m/cashier      → /cashier              只有 admin / frontdesk / cashier 能进
 *   /m/housekeeping → /mobile-housekeeping  admin / frontdesk / housekeeping（它就是往这个页面跳）
 *   /m/checkin      → /frontdesk            办入住是前台的活
 *   /m/rooms        → /rooms
 *   /m/orders       → /orders
 *
 * 用白名单而不是黑名单：以后新增移动端页面如果忘了登记，默认拒绝而不是默认放行。
 */
const MOBILE_MODULE_OF: Record<string, string> = {
  "/m/rooms": "/rooms",
  "/m/checkin": "/frontdesk",
  "/m/orders": "/orders",
  "/m/cashier": "/cashier",
  "/m/housekeeping": "/mobile-housekeeping",
};

/** 所有角色都能进的移动端页面：工作台 / 我的 / 旧入口跳转页 */
const MOBILE_PUBLIC_PATHS = new Set(["/m", "/m/me", "/mobile"]);

/** 取当前路径对应的桌面模块；未登记的路径返回 undefined（= 不放行） */
function mobileModuleOf(pathname: string): string | undefined {
  const exact = MOBILE_MODULE_OF[pathname];
  if (exact) return exact;
  for (const [base, module] of Object.entries(MOBILE_MODULE_OF)) {
    if (pathname.startsWith(base + "/")) return module;
  }
  return undefined;
}

export default async function MobileLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const isPrefetch = h.get("sec-fetch-mode") === "cors" || h.get("next-router-prefetch") === "1";

  const user = await getSession();
  if (!user) {
    if (isPrefetch) return null;
    redirect("/login");
  }

  /* ---------- 模块守卫（预取也照样判断，与 (main) 一致） ---------- */
  const rawPath = h.get("x-pathname") ?? "";
  const pathname = (rawPath.split("?")[0] || "").replace(/\/$/, "") || "/";

  if (!MOBILE_PUBLIC_PATHS.has(pathname)) {
    const module = mobileModuleOf(pathname);
    const blocked = !module || !canAccess(user.role, module, user.hotelId);
    if (blocked) {
      redirect("/m?err=" + encodeURIComponent("当前角色无权访问该页面"));
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f6f7]">
      {/* 内容区：底部留出 Tab 高度，避免被遮住 */}
      <main className="flex-1 pb-[64px]">{children}</main>
      <MobileTabBar role={user.role} />
    </div>
  );
}
