// 交付前自检：登录态、页面、数据、占位、数据库完整性
// 用法: node scripts/audit.mjs   （需先 npm run start 或 dev 在 3100 跑着）
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const BASE = process.env.AUDIT_BASE || "http://localhost:3100";
const DB = path.join(process.cwd(), "data", "pms.db");

let pass = 0;
let fail = 0;
const problems = [];

function ok(name, detail = "") {
  pass++;
  console.log(`  ✅ ${name}${detail ? "  " + detail : ""}`);
}
function bad(name, detail = "") {
  fail++;
  problems.push(`${name} ${detail}`);
  console.log(`  ❌ ${name}${detail ? "  " + detail : ""}`);
}

const PAGES = [
  "/dashboard", "/rooms", "/rooms/forecast", "/rooms/predict", "/today-todo",
  "/bookings", "/bookings/new", "/orders", "/frontdesk", "/inhouse", "/guests",
  "/members", "/members/wallet", "/cashier", "/cashier/print?stay=1",
  "/channels", "/channel-orders", "/housekeeping", "/meal-vouchers", "/shop",
  "/night-audit", "/reports", "/settings", "/settings?tab=calendar",
  "/settings?tab=package", "/settings?tab=salesman", "/settings?tab=role",
  "/companies", "/quotes", "/notices", "/lost-found", "/finance", "/dummy-rooms",
  "/rental", "/id-verify", "/query-logs", "/lock-settings", "/wechat", "/logs",
];

const REPORTS = [
  "summary", "room-revenue", "shift-report", "shift-summary", "folio-daily",
  "consume-detail", "receipt-summary", "finance-overview", "sales-overview",
  "member-overview", "biz-type", "biz-total", "biz-daily", "room-type-daily",
  "floor-daily", "room-fee-daily", "trial-balance", "account-balance",
  "consume-recover", "night-audit", "inhouse-report", "quick-biz-type",
  "quick-ar", "quick-dun", "quick-fin-ex", "quick-fd-ex",
];

async function main() {
  console.log("\n=== 1. 登录 ===");
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    body: new URLSearchParams({ username: "admin", password: "admin123" }),
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const setCookies = login.headers.getSetCookie?.() ?? [];
  const hasSid = setCookies.some((c) => c.startsWith("pms_sid="));
  const hasUser = setCookies.some((c) => c.startsWith("pms_user="));
  hasSid ? ok("登录返回 pms_sid") : bad("登录未返回 pms_sid");
  hasUser ? ok("登录返回 pms_user（兜底）") : bad("登录未返回 pms_user");

  const jar = setCookies.map((c) => c.split(";")[0]).join("; ");
  const sidCookie = setCookies.find((c) => c.startsWith("pms_sid="))?.split(";")[0] ?? "";
  const userCookie = setCookies.find((c) => c.startsWith("pms_user="))?.split(";")[0] ?? "";

  console.log("\n=== 2. 登录态 ===");
  const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: jar }, redirect: "manual" });
  dash.status === 200 ? ok("带 Cookie 访问工作台") : bad("带 Cookie 访问工作台", `status=${dash.status}`);

  // session 丢失场景：伪造 sid + 真实 pms_user
  const fakeJar = `pms_sid=deadbeefdeadbeefdeadbeefdeadbeef; ${userCookie}`;
  const fakeDash = await fetch(`${BASE}/rooms`, { headers: { cookie: fakeJar }, redirect: "manual" });
  const fakeHtml = await fakeDash.text();
  fakeDash.status === 200 && !/登录工作台/.test(fakeHtml)
    ? ok("session 丢失时用 pms_user 自动恢复")
    : bad("session 丢失后未恢复登录态", `status=${fakeDash.status}`);

  // 只有 sid 没有 user（旧 Cookie）也要正常
  const onlySid = await fetch(`${BASE}/rooms`, { headers: { cookie: sidCookie }, redirect: "manual" });
  onlySid.status === 200 ? ok("仅 sid Cookie 正常") : bad("仅 sid Cookie 失败", `status=${onlySid.status}`);

  console.log("\n=== 3. 页面（40 个）===");
  for (const p of PAGES) {
    const res = await fetch(BASE + p, { headers: { cookie: jar }, redirect: "manual" });
    const html = await res.text();
    const isLogin = /登录工作台/.test(html);
    const placeholder = /已预留|暂未开放|敬请期待|功能开发中/.test(html);
    const runtimeErr = html.includes("Application error") || html.includes("Unhandled Runtime Error");
    const rows = (html.match(/<tr/g) || []).length;
    const links = (html.match(/<a /g) || []).length;
    if (res.status !== 200) bad(p, `status=${res.status}`);
    else if (isLogin) bad(p, "被踢回登录页");
    else if (placeholder) bad(p, "存在占位文案");
    else if (runtimeErr) bad(p, "运行错误");
    else if (rows === 0 && links < 10) bad(p, `内容过少 rows=${rows} links=${links}`);
    else ok(p, `rows=${rows} links=${links}`);
  }

  console.log("\n=== 4. 报表（26 张）===");
  for (const r of REPORTS) {
    const res = await fetch(`${BASE}/reports?r=${r}`, { headers: { cookie: jar }, redirect: "manual" });
    const html = await res.text();
    if (res.status !== 200) bad(`report:${r}`, `status=${res.status}`);
    else if (html.includes("Application error")) bad(`report:${r}`, "运行错误");
    else if (html.includes("NaN")) bad(`report:${r}`, "含 NaN");
    else ok(`report:${r}`, `len=${html.length}`);
  }

  console.log("\n=== 5. 数据库 ===");
  const db = new DatabaseSync(DB);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
  tables.length >= 35 ? ok("表数量", `${tables.length} 张`) : bad("表数量不足", `${tables.length}`);

  const checks = [
    ["rooms", "SELECT COUNT(*) c FROM rooms", 40],
    ["stays(在住)", "SELECT COUNT(*) c FROM stays WHERE status='INHOUSE'", 20],
    ["bookings", "SELECT COUNT(*) c FROM bookings", 300],
    ["channel_orders", "SELECT COUNT(*) c FROM channel_orders", 1000],
    ["folio_items", "SELECT COUNT(*) c FROM folio_items", 30],
    ["payments", "SELECT COUNT(*) c FROM payments", 15],
    ["op_logs", "SELECT COUNT(*) c FROM op_logs", 50],
    ["rate_calendar", "SELECT COUNT(*) c FROM rate_calendar", 100],
    ["meal_vouchers", "SELECT COUNT(*) c FROM meal_vouchers", 10],
    ["shop_items", "SELECT COUNT(*) c FROM shop_items", 5],
  ];
  for (const [name, sql, min] of checks) {
    try {
      const c = db.prepare(sql).get().c;
      c >= min ? ok(`数据 ${name}`, `${c} >= ${min}`) : bad(`数据 ${name} 不足`, `${c} < ${min}`);
    } catch (e) {
      bad(`数据 ${name}`, "查询失败");
    }
  }
  db.close();

  console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
  if (fail > 0) {
    console.log("\n失败项：");
    problems.forEach((p) => console.log(" - " + p));
    process.exit(1);
  }
  console.log("全部通过 ✅");
}

main().catch((e) => {
  console.error("审计脚本异常:", e.message);
  process.exit(1);
});
