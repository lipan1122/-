/**
 * 页面级权限守卫：判定口径的**唯一来源**
 *
 * ── 要解决的问题（P0 架构）──
 *
 * 原来「谁能进哪个页面」这件事只在 `(main)/layout.tsx` / `(mobile)/layout.tsx` 里判断。
 * 但 Server Action 的执行**不经过 layout**：客户端是 `POST /<页面路径>` + action id，
 * Next 直接把 action 跑起来 —— 于是出现
 *
 *     housekeeper 访问 /cashier       → 307 踢回（layout 生效）
 *     housekeeper POST /cashier 的 action → 照样执行并写库（layout 完全没参与）
 *
 * 页面守卫和动作守卫是两套东西，而权限矩阵只有一份（role_modules）。这里把它抽成
 * 「路径 → 当前角色能不能站在这条路径上」的单一判定，两个入口共用：
 *
 *   1. `(main)/layout.tsx`            —— 页面渲染（GET），行为与改前一致；
 *   2. `requireUser()`（session.ts）  —— 所有页面和所有 server action 的第一行都调它，
 *      所以动作层自动继承页面守卫，**不需要逐个改 30+ 个 action 文件**
 *      （其中 bookings / night-audit / rooms 等目录还在别人手里，也不该由本修复去动）。
 *
 * ── 为什么不用 middleware 兜底（方案 B 调查结论）──
 *
 * middleware 跑在 **Edge runtime**：实测本项目生产构建把 middleware 打在
 * `.next/server/edge/chunks/...`、`middleware-manifest.json` 里也在 edge 分组，
 * 而角色必须来自服务端 SQLite（不能信任 Cookie，见整改报告 P0-2.1）——
 * Edge 里 require 不了 `node:sqlite`。要硬做只有两条路，都不划算：
 *
 *   · middleware 里 fetch 一个内部鉴权接口：每个 action 多一次进程内 HTTP 往返，
 *     并新增一个可被探测的接口面；
 *   · 把 `middleware.ts` 改名 `proxy.ts`（Next 16 的新约定，固定在 Node 运行）：
 *     改的是全局文件约定（还牵扯 3100 上正在跑的构建），收益却不比现在这条路径大。
 *
 * 关键事实（实测，见交付报告）：Next 16 **已经把 action 限定在它所属的页面**——
 * 把 `/cashier` 的 action id POST 到 `/dashboard` 会得到
 * `409 Server Action unavailable.`，不会执行。所以「POST 的路径」就是「这个 action
 * 所属页面」，用请求路径做页面级判定是精确的，不存在「换个路径绕过去」。
 *
 * ── 误伤怎么避免 ──
 *
 *   · 只有**命中判定**才拦：`canAccess`（role_modules 库表）说不能进才拦，逻辑与 layout 完全一致；
 *   · `/m/**` 与 `/mobile` 走移动端自己的映射（与 `(mobile)/layout.tsx` 同一张表），
 *     不拿桌面模块名去套 `/m/cashier`，避免把前台/客房正常干活的动作挡掉；
 *   · `/no-permission` 是 AUTHENTICATED_ONLY（canAccess 里放行），被拒用户看得到提示页；
 *   · `/`（根路径）、`/api/**`（middleware matcher 不覆盖，没有 x-pathname）一律不参与判定；
 *   · 页面 GET 仍然走 `redirect()`（与改前同一个落点），只有**写请求**才抛错，
 *     所以正常浏览的体验一点没变。
 */

/**
 * middleware 透传下来的「请求路径」头
 *
 * 与 `src/middleware.ts` 里的名字必须一致。middleware 无条件覆盖该头，
 * 客户端自己塞同名头不会影响判定。
 */
export const PATHNAME_HEADER = "x-pathname";

/**
 * middleware 透传下来的「HTTP 方法」头
 *
 * 为什么要方法：同一个 `requireUser()` 既被页面渲染调用、又被 action 调用。
 *   · GET/HEAD（页面渲染）→ 被拒时 `redirect()`，保持原有页面体验；
 *   · 其它方法（Server Action 一律 POST）→ 被拒时抛 FORBIDDEN，
 *     绝不让动作继续往下跑（也不会给客户端留下可跟随的页面数据）。
 * 客户端伪造该头无效：middleware 用 `req.method` 覆盖。
 */
export const METHOD_HEADER = "x-pms-http-method";

/**
 * 管理类页面：只有 admin 能进
 * （与 `(main)/layout.tsx` 里原来那份清单一致，改动请只改这里）
 */
export const ADMIN_ONLY_PATHS = [
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
 * 移动端子路由 → 桌面模块名
 *
 * ⚠️ 必须与 `src/app/(mobile)/layout.tsx` 里的 `MOBILE_MODULE_OF` 保持一致：
 * 权限矩阵登记的是桌面路径，`/m/xxx` 只是同一个模块的手机版入口。
 * （那份代码不在本次可改范围内，所以这里做一份镜像；以后改任一份都要同步。）
 */
export const MOBILE_MODULE_OF: Record<string, string> = {
  "/m/rooms": "/rooms",
  "/m/checkin": "/frontdesk",
  "/m/orders": "/orders",
  "/m/cashier": "/cashier",
  "/m/housekeeping": "/mobile-housekeeping",
};

/** 所有角色都能进的移动端页面（工作台 / 我的 / 旧入口跳转页） */
export const MOBILE_PUBLIC_PATHS = ["/m", "/m/me", "/mobile"];

/** 桌面端被拒后的落点（与 layout 改前一致） */
export const DESKTOP_HOME = "/dashboard";
/** 移动端被拒后的落点（与 (mobile)/layout.tsx 一致） */
export const MOBILE_HOME = "/m";

/** 被拒文案（桌面 / 移动共用，改前就是这一句，不改已有的 URL 语义） */
export const NO_PAGE_ACCESS_MESSAGE = "当前角色无权访问该页面";

/** 判定结果：allowed 或「拦住 + 该跳哪」 */
export type PageGate =
  | { allowed: true }
  | {
      allowed: false;
      /** 拦截原因：admin_only 管理类页面 / module 模块未授权 / mobile 移动端映射 / unknown 未登记的移动页 */
      reason: "admin_only" | "module" | "mobile" | "unknown";
      /** 页面 GET 被拒时的落点（带 err 文案，与改前的 URL 完全一致） */
      redirectTo: string;
    };

/** 路径归一化：去掉查询串 / 片段 / 末尾斜杠，空值视为根路径 */
export function normalizePathname(raw: string | null | undefined): string {
  const path = (raw ?? "").split("?")[0].split("#")[0].replace(/\/$/, "");
  return path || "/";
}

/** 是否管理类页面（只有 admin 能进） */
export function isAdminOnlyPath(pathname: string): boolean {
  return ADMIN_ONLY_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** 是否员工移动端路径（/m、/m/**、/mobile），这些路径不能直接套桌面模块名 */
export function isMobilePath(pathname: string): boolean {
  return pathname === "/m" || pathname === "/mobile" || pathname.startsWith("/m/");
}

/** 移动端路径 → 桌面模块名；未登记返回 undefined（= 不放行，与 (mobile)/layout.tsx 一致） */
export function mobileModuleOf(pathname: string): string | undefined {
  const exact = MOBILE_MODULE_OF[pathname];
  if (exact) return exact;
  for (const [base, module] of Object.entries(MOBILE_MODULE_OF)) {
    if (pathname.startsWith(base + "/")) return module;
  }
  return undefined;
}

/** 是不是「写请求」（Server Action 一律 POST；GET/HEAD 才是页面渲染） */
export function isMutationMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").toUpperCase();
  return m !== "" && m !== "GET" && m !== "HEAD";
}

/** 被拒落点 */
function deniedRedirect(pathname: string): string {
  const home = isMobilePath(pathname) ? MOBILE_HOME : DESKTOP_HOME;
  return `${home}?err=${encodeURIComponent(NO_PAGE_ACCESS_MESSAGE)}`;
}

/**
 * 页面访问判定（纯函数）
 *
 * @param user      当前登录用户（只需要 role / hotelId）
 * @param pathname  请求路径（已去掉查询串的即可，内部还会再归一化一次）
 * @param canAccess 角色模块判定（由 session.ts 注入，避免 session.ts ↔ 本模块循环依赖）
 *
 * 判定顺序（与两个 layout 改前的行为逐条对齐）：
 *   根路径 "/"            → 放行（layout 本来就不判 "/"）
 *   移动端 /m、/mobile    → 公开页放行；其余按 MOBILE_MODULE_OF 换算后 canAccess
 *   桌面非根路径          → 管理类页面只给 admin；其余 canAccess
 */
export function pageAccessOf(
  user: { role: string; hotelId?: number },
  pathname: string,
  canAccess: (role: string, pathname: string, hotelId?: number) => boolean
): PageGate {
  const path = normalizePathname(pathname);

  /* 根路径没有页面（只是入口跳转），与 layout 一致不判权限 */
  if (path === "/") return { allowed: true };

  if (isMobilePath(path)) {
    if (MOBILE_PUBLIC_PATHS.includes(path)) return { allowed: true };
    const module = mobileModuleOf(path);
    if (!module) return { allowed: false, reason: "unknown", redirectTo: deniedRedirect(path) };
    return canAccess(user.role, module, user.hotelId)
      ? { allowed: true }
      : { allowed: false, reason: "mobile", redirectTo: deniedRedirect(path) };
  }

  if (user.role !== "admin" && isAdminOnlyPath(path)) {
    return { allowed: false, reason: "admin_only", redirectTo: deniedRedirect(path) };
  }

  return canAccess(user.role, path, user.hotelId)
    ? { allowed: true }
    : { allowed: false, reason: "module", redirectTo: deniedRedirect(path) };
}
