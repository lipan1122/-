import { NextResponse, type NextRequest } from "next/server";

/**
 * 只负责把「当前路径 + 请求方法」透传给服务端。
 *
 * 为什么不在 middleware 里判断角色：
 *   middleware 跑在 edge runtime（实测生产构建产物打在 .next/server/edge/chunks），
 *   读不到 SQLite；而角色必须来自服务端 session 表，
 *   不能信任客户端 Cookie（整改报告 P0-2.1）。
 *   所以这里只塞两个头，真正的鉴权在：
 *     · `(main)/layout.tsx` —— 页面渲染（GET）
 *     · `src/lib/session.ts` 的 requireUser() —— 页面 + 所有 Server Action（POST）
 *   两者共用 `src/lib/action-guard.ts` 的同一份判定口径。
 *
 * 为什么还要透传方法（P0 架构修复）：
 *   Server Action 也是「POST 到页面路径」。`requireUser()` 需要区分
 *   「页面渲染被拒 → redirect 到工作台」和「写请求被拒 → 直接抛 FORBIDDEN 不执行」，
 *   而 next/headers 不暴露 HTTP 方法。
 *
 *   安全约束：两个头都用服务端自己的值**覆盖**（不是 append），客户端自己塞
 *   `x-pathname` / `x-pms-http-method` 不会影响判定。
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  headers.set("x-pms-http-method", req.method);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 主应用页面都要带路径；接口/静态/登录页跳过
  matcher: ["/((?!api|_next|login|favicon).*)"],
};
