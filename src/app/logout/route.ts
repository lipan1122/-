import { NextResponse } from "next/server";
import { run } from "@/lib/db";

export async function GET(req: Request) {
  const sid = req.headers.get("cookie")?.match(/pms_sid=([^;]+)/)?.[1];
  if (sid) run(`DELETE FROM sessions WHERE id = ?`, [sid]);
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.set("pms_sid", "", { path: "/", maxAge: 0 });
  return res;
}
