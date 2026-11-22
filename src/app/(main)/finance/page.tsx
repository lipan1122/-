import Link from "next/link";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { csvNumberCell, csvTextCell, fmtMoney, round2, todayStr } from "@/lib/utils";
import { settleArAction } from "./actions";

export const dynamic = "force-dynamic";

type ArRow = {
  id: number;
  folio_no: string;
  guest_name: string | null;
  room_no: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  created_at: string | null;
};

const AGING = [
  { label: "7 天内", hint: "账龄 ≤ 7 天", cls: "text-gray-700" },
  { label: "7–30 天", hint: "账龄 8–30 天", cls: "text-amber-700" },
  { label: "30 天以上", hint: "账龄 > 30 天", cls: "text-rose-600" },
];

function timeText(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/** 账龄：按开单时间（created_at）到今天的自然日天数 */
function agingDays(createdAt: string | null) {
  if (!createdAt) return 0;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function bucketIndex(days: number) {
  if (days <= 7) return 0;
  if (days <= 30) return 1;
  return 2;
}

export default async function FinancePage() {
  const user = await requireUser();

  /*
   * 应收列表（第 4 轮 P1-15 · 问题 3：改成查 ar_ledgers 笔级台账）
   *
   * 原来查 `folios WHERE status='OPEN' AND balance>0`，有两个问题：
   *   ① 那是「客人在住欠费」，不是「协议单位挂账应收」—— 两码事混在一个列表里
   *   ② 挂账成功后（P0-4 修好的）账单 balance 归 0，就查不出来了，
   *      而这笔钱明明还在公司欠着，只是记在 ar_ledgers 里
   *
   * 现在按语义分开：
   *   · 本页「协议单位应收」← ar_ledgers（未结/部分核销）
   *   · 「客人在住欠费」去 /cashier 看（那里本来就是客人视角）
   *
   * ar_ledgers 是笔级台账（一次挂账一行，带到期日与已核销金额），
   * 账龄按 biz_date 算（业务发生日），不是按创建时间。
   */
  const rows = all<ArRow>(
    `SELECT l.id,
            COALESCE(l.folio_no, '#' || l.folio_id) AS folio_no,
            COALESCE(c.name, '协议单位#' || l.company_id) AS guest_name,
            '' AS room_no,
            l.amount AS total_amount,
            COALESCE(l.settled_amount, 0) AS paid_amount,
            ROUND(l.amount - COALESCE(l.settled_amount, 0), 2) AS balance,
            l.biz_date || 'T00:00:00' AS created_at
       FROM ar_ledgers l
       LEFT JOIN companies c ON c.id = l.company_id AND c.hotel_id = l.hotel_id
      WHERE l.hotel_id = ? AND l.status IN ('OPEN', 'PARTIAL')
        AND (l.amount - COALESCE(l.settled_amount, 0)) > 0.005
      ORDER BY l.biz_date ASC, l.id ASC`,
    [user.hotelId]
  );

  const buckets = [0, 0, 0];
  let total = 0;
  for (const f of rows) {
    const bal = round2(Number(f.balance ?? 0));
    total = round2(total + bal);
    buckets[bucketIndex(agingDays(f.created_at))] = round2(
      buckets[bucketIndex(agingDays(f.created_at))] + bal
    );
  }

  /*
   * 客人在住欠费（第 4 轮 P1-15 配套）
   *
   * 上面那块是「协议单位挂账应收」（ar_ledgers）——单位欠酒店的钱。
   * 这一块是「客人在住欠费」（folios）——人还住在店里、账没结清。
   * 两者性质完全不同，不能混在一个列表：
   *   · 单位欠款走 AR 核销（可能几个月后才付）
   *   · 客人欠费在退房时就必须结清
   * 分开列出来，财务知道哪些要催公司、哪些是前台退房时要盯的。
   */
  const guestDebtRows = all<{ folio_no: string; guest_name: string | null; room_no: string | null; balance: number }>(
    `SELECT f.folio_no, f.guest_name, f.room_no, ROUND(f.balance, 2) AS balance
       FROM folios f
       JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
      WHERE f.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0.005
      ORDER BY f.balance DESC`,
    [user.hotelId]
  );
  const guestDebtTotal = round2(guestDebtRows.reduce((sum, r) => sum + Number(r.balance ?? 0), 0));

  /*
   * 导出：服务端生成 CSV，通过 data URL 直接下载，无需额外路由
   *
   * 整改清单 P1-25：CSV 公式注入——序列化细节见 @/lib/utils 的 csvTextCell /
   * csvNumberCell 注释（含一个名叫 `=cmd|'/c calc'!A0` 的客人会怎样）。
   * 这里只负责按列性质分流：文本列中和、数值列保留原样。
   */
  const header = ["账单号", "客人", "房号", "消费合计", "已收", "应收", "开单时间", "账龄(天)"];
  const body = rows.map((f) => [
    f.folio_no,
    f.guest_name ?? "",
    f.room_no ?? "",
    Number(f.total_amount ?? 0).toFixed(2),
    Number(f.paid_amount ?? 0).toFixed(2),
    Number(f.balance ?? 0).toFixed(2),
    timeText(f.created_at),
    String(agingDays(f.created_at)),
  ]);
  /** 数值列下标：消费合计 / 已收 / 应收 / 账龄 */
  const NUMERIC_COLS = new Set([3, 4, 5, 7]);
  const csvLine = (cells: string[]) =>
    cells.map((c, i) => (NUMERIC_COLS.has(i) ? csvNumberCell(c) : csvTextCell(c))).join(",");
  const csvText = [csvLine(header), ...body.map(csvLine)].join("\r\n");
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csvText}`)}`;
  const csvName = `应收账单-${todayStr()}.csv`;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">财务应收（AR）</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            未结清账单 <b className="text-gray-800">{rows.length}</b> 笔 · 应收总额{" "}
            <b className="text-rose-600">{fmtMoney(total)}</b>
            <span className="ml-2 text-[11px] text-gray-400">账龄按开单时间计算</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={csvHref} download={csvName} className="btn-default px-2.5 py-1 text-[12px]">
            导出 CSV
          </a>
          <Link href="/cashier" className="btn-default px-2.5 py-1 text-[12px]">
            收银台
          </Link>
          <Link href="/reports" className="btn-default px-2.5 py-1 text-[12px]">
            统计报表
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <div className="card p-3">
          <div className="text-[11px] text-gray-500">应收总额</div>
          <div className="mt-1 text-[18px] font-semibold tabular-nums text-rose-600">{fmtMoney(total)}</div>
          <div className="mt-0.5 text-[11px] text-gray-400">全部未结清余额</div>
        </div>
        <div className="card p-3">
          <div className="text-[11px] text-gray-500">挂账笔数</div>
          <div className="mt-1 text-[18px] font-semibold tabular-nums text-gray-900">{rows.length}</div>
          <div className="mt-0.5 text-[11px] text-gray-400">{"状态 OPEN 且余额 > 0"}</div>
        </div>
        {AGING.map((b, i) => (
          <div key={b.label} className="card p-3">
            <div className="text-[11px] text-gray-500">账龄 {b.label}</div>
            <div className={`mt-1 text-[18px] font-semibold tabular-nums ${b.cls}`}>
              {fmtMoney(round2(buckets[i]))}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-400">{b.hint}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">应收账单明细</span>
          <span className="text-[11px] text-gray-400">按开单时间升序，越早的账单账龄越长</span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">账单号</th>
              <th className="th">客人</th>
              <th className="th">房号</th>
              <th className="th text-right">消费合计</th>
              <th className="th text-right">已收</th>
              <th className="th text-right">应收</th>
              <th className="th">开单时间</th>
              <th className="th text-right">账龄</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="td py-10 text-center text-gray-400">
                  暂无未结清账单，所有账单均已结清
                </td>
              </tr>
            )}
            {rows.map((f) => {
              const days = agingDays(f.created_at);
              const idx = bucketIndex(days);
              const ageCls = idx === 2 ? "text-rose-600" : idx === 1 ? "text-amber-700" : "text-gray-500";
              return (
                <tr key={f.id} className="hover:bg-gray-50">
                  <td className="td font-medium text-gray-800">{f.folio_no}</td>
                  <td className="td text-gray-700">{f.guest_name || "—"}</td>
                  <td className="td text-gray-600">{f.room_no || "—"}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(f.total_amount)}</td>
                  <td className="td text-right tabular-nums text-emerald-700">{fmtMoney(f.paid_amount)}</td>
                  <td className="td text-right font-medium tabular-nums text-rose-600">{fmtMoney(f.balance)}</td>
                  <td className="td text-gray-500">{timeText(f.created_at)}</td>
                  <td className={`td text-right tabular-nums ${ageCls}`}>{days} 天</td>
                  <td className="td text-right">
                    <form action={settleArAction} className="flex items-center justify-end gap-1.5">
                      <input type="hidden" name="id" value={f.id} />
                      <select
                        name="method"
                        defaultValue="微信"
                        aria-label={`${f.folio_no} 收款方式`}
                        className="input w-[76px] px-1 py-0.5 text-[11px]"
                      >
                        <option value="微信">微信</option>
                        <option value="支付宝">支付宝</option>
                        <option value="现金">现金</option>
                        <option value="银行卡">银行卡</option>
                        <option value="挂账">挂账</option>
                      </select>
                      <button className="btn-primary px-2 py-0.5 text-[11px]">结清</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-400">
        结清后写入收款流水（payments）并将账单状态置为 SETTLED，可在收银台与报表中核对。
      </p>

      {/*
        第 4 轮 P1-15 配套：客人在住欠费（与上面的「协议单位挂账」分开）
        单位欠款走 AR 核销，客人欠费退房时必须结清 —— 两件事，两个列表。
      */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">客人在住欠费</span>
          <span className="text-[11.5px] text-gray-500">
            {guestDebtRows.length} 张 · 合计{" "}
            <b className="tabular-nums text-rose-600">{fmtMoney(guestDebtTotal)}</b> · 退房前须结清
          </span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">账单号</th>
              <th className="th">客人</th>
              <th className="th">房号</th>
              <th className="th text-right">欠费</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {guestDebtRows.length === 0 && (
              <tr>
                <td colSpan={5} className="td py-8 text-center text-gray-400">
                  没有在住客人的欠费，账都结清了
                </td>
              </tr>
            )}
            {guestDebtRows.map((g) => (
              <tr key={g.folio_no} className="hover:bg-gray-50">
                <td className="td font-medium text-gray-800">{g.folio_no}</td>
                <td className="td text-gray-700">{g.guest_name || "—"}</td>
                <td className="td text-gray-600">{g.room_no || "—"}</td>
                <td className="td text-right font-medium tabular-nums text-rose-600">{fmtMoney(g.balance)}</td>
                <td className="td text-right">
                  <a href="/cashier" className="text-[12px] text-brand-600 hover:underline">
                    去收银台收款
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
