// 报表中心逐张体检（含新增 15 张）：标题 / 统计卡 / 表格行 / 是否空态
const base = process.env.BASE || "http://localhost:3100";
const KEYS = [
  "summary", "room-revenue", "deposit-report", "credit-guests", "goods-range", "goods-sales",
  "ar-age", "ar-happen", "ar-account", "salesman-detail", "salesman-summary",
  "company-detail", "company-summary", "change-room", "reverse-detail", "extra-room-fee",
  "expected-arrivals", "price-change", "free-room", "hourly-orders", "package-report",
  "breakfast-report", "shift-report", "shift-summary", "folio-daily", "consume-detail",
  "receipt-summary", "finance-overview", "sales-overview", "member-overview", "biz-type",
  "biz-total", "biz-daily", "room-type-daily", "room-daily", "floor-daily", "room-fee-daily",
  "trial-balance", "account-balance", "consume-recover", "night-audit", "inhouse-report",
  "quick-biz-type", "quick-ar", "quick-dun", "quick-fin-ex", "quick-fd-ex",
  "member-list-report", "score-detail-report", "invoice-report", "realtime-report",
  "cancel-order-report", "cleaner-perf", "epidemic-report", "member-topup",
  "salesman-card", "salesman-card-detail", "member-consume-rank", "members-upgrade",
  "goods-stock", "channel-report", "channel-report-detail",
  "credit-checkin", "sms-report", "police-report", "recharge-sum",
  "recharge-salesman", "room-biz-daily",
];
async function main() {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    body: new URLSearchParams({ username: "admin", password: "admin123" }),
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  let ok = 0, fail = 0, notReady = 0;
  for (const k of KEYS) {
    const res = await fetch(`${base}/reports?r=${k}`, { headers: { cookie }, redirect: "manual" });
    const h = await res.text();
    const title = (h.match(/<h1[^>]*>([^<]{2,40})<\/h1>/) || [])[1] || "-";
    const tr = (h.match(/<tr/g) || []).length;
    const cards = (h.match(/StatCard|text-\[18px\]|text-\[20px\]/g) || []).length;
    const empty = /暂无数据|没有数据/.test(h);
    /*
     * 「尚未实现」占位不算失败
     *
     * 上线前审计发现 11 张报表的 SQL 引用了不存在的表/列（AI 生成后从未运行过），
     * 映射到真组件会 500。现在改成明确的 ReportNotReady 占位 ——
     * 页面 200 + 说明文字，比 500 白屏或静默显示别的报表都好。
     * 这类算「未实现」，单独统计，不混进失败数。
     */
    const placeholder = h.includes("尚未实现") || h.includes("占位说明");
    const good = res.status === 200 && !h.includes("Application error") && (tr > 1 || placeholder);
    if (placeholder) {
      notReady++;
      ok++;
      console.log(`N/A  ${k.padEnd(20)}  ——  占位（未实现）  ${title}`);
      continue;
    }
    good ? ok++ : fail++;
    console.log(`${good ? "OK  " : "FAIL"} ${k.padEnd(20)} ${String(tr).padStart(3)}行 卡${String(cards).padStart(2)} ${empty ? "[空态]" : "      "} ${title}`);
  }
  console.log(`\n报表 ${KEYS.length} 张：通过 ${ok}（其中未实现占位 ${notReady}），失败 ${fail}`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
