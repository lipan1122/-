import { NextResponse } from "next/server";
import { run } from "@/lib/db";

function html(body: string) {
  return new NextResponse(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>退出中…</title></head><body>${body}</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

export async function GET(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const sid = cookie.match(/pms_sid=([^;]+)/)?.[1];
  if (sid) run(`DELETE FROM sessions WHERE id = ?`, [sid]);
  const res = html(`<p>已退出</p><script>location.replace("/login")</script>`);
  res.cookies.set("pms_sid", "", { path: "/", maxAge: 0 });
  res.cookies.set("pms_user", "", { path: "/", maxAge: 0 });
  return res;
}
