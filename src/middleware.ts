import { NextResponse, type NextRequest } from "next/server";

/**
 * 只负责把当前路径透传给 layout。
 *
 * 为什么不在 middleware 里判断角色：
 *   middleware 跑在 edge runtime，读不到 SQLite；而角色必须来自服务端 session 表，
 *   不能信任客户端 Cookie（整改报告 P0-2.1）。
 *   所以这里只塞一个 `x-pathname`，真正的鉴权在 `(main)/layout.tsx`（Node runtime，能查库）。
 */
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 主应用页面都要带路径；接口/静态/登录页跳过
  matcher: ["/((?!api|_next|login|favicon).*)"],
};
