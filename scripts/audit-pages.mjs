// 逐页详细体检：标题、表格行、按钮、表单、空状态
const base = process.env.AUDIT_BASE || "http://localhost:3100";

const PAGES = [
  ["/dashboard", "工作台"], ["/rooms", "实时房态"], ["/rooms/forecast", "远期房态"],
  ["/rooms/predict", "房型可售预测"], ["/today-todo", "今日待办"],
  ["/bookings", "预订管理"], ["/bookings/new", "新增预订"], ["/orders", "订单列表"],
  ["/frontdesk", "散客步入"], ["/inhouse", "在住客人"], ["/guests", "宾客列表"],
  ["/members", "会员管理"], ["/members/wallet", "会员储值"], ["/member-cards", "会员卡设置"],
  ["/points", "会员积分"], ["/companies", "协议单位"],
  ["/cashier", "收银台"], ["/finance", "财务应收"], ["/ar", "AR应收"],
  ["/channels", "渠道直连"], ["/channel-orders", "渠道预订"],
  ["/housekeeping", "客房中心"], ["/cleaners", "打扫员"],
  ["/meal-vouchers", "餐券核销"], ["/breakfast", "早餐核销"],
  ["/shop", "商超"], ["/goods", "商品库存"], ["/rental", "物品租赁"],
  ["/lost-found", "失物招领"], ["/sms", "短信服务"],
  ["/night-audit", "夜审"], ["/reports", "报表中心"],
  ["/settings", "系统设置"], ["/dummy-rooms", "哑房管理"], ["/quotes", "报价管理"],
  ["/notices", "通知公告"], ["/query-logs", "查询日志"], ["/logs", "操作日志"],
  ["/id-verify", "人证核验"], ["/lock-settings", "门锁设置"], ["/wechat", "微酒店"],
];

async function main() {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    body: new URLSearchParams({ username: "admin", password: "admin123" }),
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  let total = 0, bad = 0;
  const rows = [];
  for (const [path, name] of PAGES) {
    const res = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
    const html = await res.text();
    const tr = (html.match(/<tr/g) || []).length;
    const btn = (html.match(/<button/g) || []).length;
    const form = (html.match(/<form/g) || []).length;
    const link = (html.match(/<a /g) || []).length;
    const empty = /暂无|没有数据|尚未选择|空状态/.test(html);
    const err = html.includes("Application error") || html.includes("Unhandled Runtime Error");
    const login = html.includes("登录工作台");
    const ok = res.status === 200 && !err && !login;
    total++;
    if (!ok) bad++;
    rows.push({ name, path, ok, tr, btn, form, link, empty });
    console.log(
      `${ok ? "OK  " : "FAIL"} ${name.padEnd(10)} ${path.padEnd(22)} 行${String(tr).padStart(4)} 按钮${String(btn).padStart(3)} 表单${String(form).padStart(3)} 链接${String(link).padStart(3)}${empty ? " [含空态]" : ""}`
    );
  }
  console.log(`\n共 ${total} 页，失败 ${bad} 个`);
  if (bad > 0) process.exit(1);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
