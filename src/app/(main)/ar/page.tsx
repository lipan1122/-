import Link from "next/link";
import { all, get } from "@/lib/db";
import { listArAging, listArLedgers, listCompanyOutstanding, ensureArLedgerSchema } from "@/lib/ar";
import { requireUser } from "@/lib/session";
import { fmtMoney, todayStr } from "@/lib/utils";
import { ensureArSchema, payArAction, postArAction, settleArLedgerAction, transferArAction, writeOffArAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

type ArAccountRow = {
  id: number;
  code: string;
  name: string;
  type: string;
  credit_limit: number;
  balance: number;
  status: string;
  contact: string | null;
  phone: string | null;
  created_at: string | null;
};

type ArTxRow = {
  id: number;
  ar_account_id: number;
  type: string;
  amount: number;
  balance_after: number;
  note: string | null;
  operator: string | null;
  biz_date: string;
  created_at: string | null;
};

type WriteOffRow = {
  id: number;
  ar_account_id: number;
  transaction_id: number | null;
  amount: number;
  note: string | null;
  operator: string | null;
  created_at: string | null;
  account_code: string | null;
  account_name: string | null;
  tx_biz_date: string | null;
  tx_amount: number | null;
};

type PostCandidate = {
  id: number;
  amount: number;
  biz_date: string;
  note: string | null;
  remaining: number;
};

type AgingRawRow = { ar_account_id: number; type: string; amount: number; biz_date: string };

/** 流水类型：POST 入账 / PAY 付款 / TRANSFER 转账 / WRITE_OFF 核销 */
const TYPE_META: Record<string, { label: string; cls: string }> = {
  POST: { label: "入账", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  PAY: { label: "付款", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  TRANSFER: { label: "转账", cls: "border-violet-200 bg-violet-50 text-violet-700" },
  WRITE_OFF: { label: "核销", cls: "border-amber-200 bg-amber-50 text-amber-700" },
};

const ACCOUNT_TYPE_CLS: Record<string, string> = {
  协议单位: "border-blue-200 bg-blue-50 text-blue-700",
  挂账客户: "border-amber-200 bg-amber-50 text-amber-700",
  内部: "border-gray-200 bg-gray-50 text-gray-600",
};

const AGING_BUCKETS = [
  { label: "0–30 天", hint: "账龄 ≤ 30 天", cls: "text-emerald-700", bar: "bg-emerald-500" },
  { label: "31–60 天", hint: "账龄 31–60 天", cls: "text-amber-700", bar: "bg-amber-500" },
  { label: "60 天以上", hint: "账龄 > 60 天", cls: "text-rose-600", bar: "bg-rose-500" },
];

/** 协议单位挂账台账（ar_ledgers）状态：未结 / 部分核销 / 已结清 / 已注销 */
const LEDGER_STATUS: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "未结", cls: "border-rose-200 bg-rose-50 text-rose-700" },
  PARTIAL: { label: "部分核销", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  SETTLED: { label: "已结清", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  WRITTEN_OFF: { label: "已注销", cls: "border-gray-200 bg-gray-100 text-gray-500" },
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/** 营业日到今天的自然日天数 */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function bucketIndex(days: number): number {
  if (days <= 30) return 0;
  if (days <= 60) return 1;
  return 2;
}

/**
 * 账龄分档（FIFO 冲销）：
 * 每个账户的正数流水（入账、转账转入）按营业日从早到晚排队，
 * 负数的付款 / 核销 / 转出按同样顺序先冲抵最早的挂账，
 * 冲抵后仍有余额的挂账单按营业日计入 0–30 / 31–60 / 60+ 三档。
 * 因此三档合计 = 各账户正余额之和，不会凭空多出应收。
 */
function agingBuckets(rows: AgingRawRow[], today: string): number[] {
  const byAccount = new Map<number, { opens: { date: string; amount: number }[]; reduce: number }>();
  for (const r of rows) {
    const amount = Number(r.amount ?? 0);
    const entry = byAccount.get(r.ar_account_id) ?? { opens: [], reduce: 0 };
    if (amount > 0) entry.opens.push({ date: r.biz_date, amount });
    else if (amount < 0) entry.reduce = round2(entry.reduce + -amount);
    byAccount.set(r.ar_account_id, entry);
  }

  const out = [0, 0, 0];
  for (const { opens, reduce } of byAccount.values()) {
    let left = reduce;
    for (const open of opens) {
      let amount = open.amount;
      if (left > 0) {
        const used = Math.min(left, amount);
        left = round2(left - used);
        amount = round2(amount - used);
      }
      if (amount > 0.001) {
        const idx = bucketIndex(daysBetween(open.date, today));
        out[idx] = round2(out[idx] + amount);
      }
    }
  }
  return out;
}

export default async function ArPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const accountId = Number(first(sp.account)) || 0;
  const act = first(sp.act);
  const today = todayStr();
  const month = today.slice(0, 7);

  // 懒建表 + 首次写入 5 个 AR 账户种子
  await ensureArSchema(hotelId);

  const accounts = all<ArAccountRow>(
    `SELECT id, code, name, type, credit_limit, balance, status, contact, phone, created_at
       FROM ar_accounts
      WHERE hotel_id = ?
      ORDER BY code ASC, id ASC`,
    [hotelId]
  );
  const selected = accountId ? accounts.find((a) => a.id === accountId) : undefined;

  const accountCount = accounts.length;
  const totalReceivable = round2(accounts.reduce((sum, a) => sum + Number(a.balance ?? 0), 0));
  const totalCredit = round2(accounts.reduce((sum, a) => sum + Number(a.credit_limit ?? 0), 0));

  const monthStat =
    get<{ post: number; writeoff: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'POST' AND biz_date LIKE ? THEN amount ELSE 0 END), 0) AS post,
         COALESCE(SUM(CASE WHEN type = 'WRITE_OFF' AND biz_date LIKE ? THEN -amount ELSE 0 END), 0) AS writeoff
       FROM ar_transactions
      WHERE hotel_id = ?`,
      [`${month}%`, `${month}%`, hotelId]
    ) ?? { post: 0, writeoff: 0 };

  // 账龄：全店流水一次性拉回，在内存里做 FIFO 冲销
  const agingRows = all<AgingRawRow>(
    `SELECT ar_account_id, type, amount, biz_date
       FROM ar_transactions
      WHERE hotel_id = ?
      ORDER BY ar_account_id ASC, biz_date ASC, id ASC`,
    [hotelId]
  );
  const buckets = agingBuckets(agingRows, today);
  const agingTotal = round2(buckets[0] + buckets[1] + buckets[2]);

  /* ---------- 协议单位挂账台账（P1-5：挂账结转 AR） ----------
   * 与上面的 AR 账户总账是「明细 vs 总账」的关系：
   *   ar_ledgers 按协议单位逐笔记应收（一次挂账一行），带账期到期日与已核销金额，
   *   信用额度校验与账龄都改用它，不再依赖 stays.remark 里的「【挂账】公司名」标记。
   * 台账表可能还没有数据（收银台尚未接入 postArCharge），这里只做只读展示。 */
  ensureArLedgerSchema();
  const arLedgers = listArLedgers(hotelId, undefined, 20);
  const arLedgerAging = listArAging(hotelId);
  const arLedgerOutstanding = round2(arLedgerAging.reduce((sum, b) => sum + b.amount, 0));
  const arLedgerCompanies = listCompanyOutstanding(hotelId).slice(0, 8);
  const arLedgerOpenCount = arLedgers.filter((r) => r.status === "OPEN" || r.status === "PARTIAL").length;

  const txs = selected
    ? all<ArTxRow>(
        `SELECT id, ar_account_id, type, amount, balance_after, note, operator, biz_date, created_at
           FROM ar_transactions
          WHERE hotel_id = ? AND ar_account_id = ?
          ORDER BY biz_date DESC, id DESC
          LIMIT 200`,
        [hotelId, selected.id]
      )
    : [];

  const txSummary = txs.reduce(
    (acc, t) => {
      const amount = Number(t.amount ?? 0);
      if (t.type === "POST") acc.post = round2(acc.post + Math.abs(amount));
      else if (t.type === "PAY") acc.pay = round2(acc.pay + Math.abs(amount));
      else if (t.type === "TRANSFER") acc.transfer = round2(acc.transfer + Math.abs(amount));
      else if (t.type === "WRITE_OFF") acc.writeoff = round2(acc.writeoff + Math.abs(amount));
      return acc;
    },
    { post: 0, pay: 0, transfer: 0, writeoff: 0 }
  );

  // 核销候选：本账户的入账流水，扣掉已核销部分后仍有可核销余额
  const writtenMap = new Map<number, number>();
  if (selected) {
    const rows = all<{ transaction_id: number; total: number }>(
      `SELECT transaction_id, SUM(amount) AS total
         FROM ar_write_offs
        WHERE hotel_id = ? AND ar_account_id = ? AND transaction_id IS NOT NULL
        GROUP BY transaction_id`,
      [hotelId, selected.id]
    );
    for (const r of rows) writtenMap.set(Number(r.transaction_id), Number(r.total ?? 0));
  }
  const postCandidates: PostCandidate[] = selected
    ? all<{ id: number; amount: number; biz_date: string; note: string | null }>(
        `SELECT id, amount, biz_date, note
           FROM ar_transactions
          WHERE hotel_id = ? AND ar_account_id = ? AND type = 'POST' AND amount > 0
          ORDER BY biz_date ASC, id ASC`,
        [hotelId, selected.id]
      )
        .map((p) => ({
          id: p.id,
          amount: Number(p.amount ?? 0),
          biz_date: p.biz_date,
          note: p.note,
          remaining: round2(Number(p.amount ?? 0) - (writtenMap.get(p.id) ?? 0)),
        }))
        .filter((p) => p.remaining > 0.001)
    : [];

  const writeOffs = all<WriteOffRow>(
    `SELECT w.id, w.ar_account_id, w.transaction_id, w.amount, w.note, w.operator, w.created_at,
            a.code AS account_code, a.name AS account_name,
            t.biz_date AS tx_biz_date, t.amount AS tx_amount
       FROM ar_write_offs w
       LEFT JOIN ar_accounts a ON a.id = w.ar_account_id AND a.hotel_id = w.hotel_id
       LEFT JOIN ar_transactions t ON t.id = w.transaction_id
      WHERE w.hotel_id = ?${selected ? " AND w.ar_account_id = ?" : ""}
      ORDER BY w.id DESC
      LIMIT 100`,
    selected ? [hotelId, selected.id] : [hotelId]
  );
  const writeOffTotal = round2(writeOffs.reduce((sum, w) => sum + Number(w.amount ?? 0), 0));

  const otherAccounts = accounts.filter((a) => a.id !== selected?.id && a.status === "ON");
  const activeCls = (key: string) => (act === key ? " ring-2 ring-brand-300" : "");

  const cards = [
    {
      label: "AR 账户数",
      value: String(accountCount),
      sub: `协议单位 / 挂账客户 / 内部挂账`,
      cls: "text-gray-900",
    },
    {
      label: "应收总额",
      value: fmtMoney(totalReceivable),
      sub: `总授信 ${fmtMoney(totalCredit)}`,
      cls: "text-rose-600",
    },
    {
      label: "本月新增入账",
      value: fmtMoney(Number(monthStat.post ?? 0)),
      sub: `统计月份 ${month}`,
      cls: "text-blue-700",
    },
    {
      label: "本月核销",
      value: fmtMoney(Number(monthStat.writeoff ?? 0)),
      sub: `本月 WRITE_OFF 合计`,
      cls: "text-amber-700",
    },
  ];

  const agingMax = Math.max(buckets[0], buckets[1], buckets[2], 1);

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">AR 应收管理</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            协议单位与挂账客户应收台账：入账 / 付款 / 转账 / 核销 / 历史核销 / 账龄，逐笔记录余额快照
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/finance" className="btn-default px-2.5 py-1 text-[12px]">
            财务应收
          </Link>
          <Link href="/companies" className="btn-default px-2.5 py-1 text-[12px]">
            协议单位
          </Link>
          <Link href="/ar" className="btn-default px-2.5 py-1 text-[12px]">
            刷新
          </Link>
        </div>
      </div>

      {ok && (
        <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{ok}</div>
      )}
      {err && (
        <div className="card border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">{err}</div>
      )}

      {/* 顶部统计 */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-3">
            <div className="text-[11px] text-gray-500">{c.label}</div>
            <div className={`mt-1 text-[18px] font-semibold tabular-nums ${c.cls}`}>{c.value}</div>
            <div className="mt-0.5 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* 账龄分析 */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="text-[13px] font-semibold text-gray-800">账龄分析</span>
          <span className="text-[11px] text-gray-400">
            按入账营业日、付款 / 核销 FIFO 冲销后分档 · 三档合计 {fmtMoney(agingTotal)}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {AGING_BUCKETS.map((b, i) => (
            <div key={b.label} className="rounded-md border border-gray-100 bg-gray-50/60 p-2.5">
              <div className="text-[11px] text-gray-500">账龄 {b.label}</div>
              <div className={`mt-1 text-[16px] font-semibold tabular-nums ${b.cls}`}>{fmtMoney(buckets[i])}</div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-200">
                <div
                  className={`h-full rounded-full ${b.bar}`}
                  style={{ width: `${Math.round((buckets[i] / agingMax) * 100)}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-gray-400">{b.hint}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 协议单位挂账台账（P1-5：挂账进 AR 台账，不再靠备注 LIKE 估算已挂账） */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">协议单位挂账台账</span>
          <span className="text-[11px] text-gray-400">
            笔级明细 ar_ledgers · 未结合计 <b className="text-rose-600">{fmtMoney(arLedgerOutstanding)}</b> ·{" "}
            {arLedgerOpenCount} 笔未结清
          </span>
        </div>

        {/* 账龄（按挂账营业日） */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-50 bg-gray-50/60 px-4 py-2 text-[11px] text-gray-500">
          <span className="text-gray-400">账龄：</span>
          {arLedgerAging.map((b) => (
            <span key={b.bucket} className="rounded border border-gray-200 bg-white px-1.5 py-0.5">
              {b.bucket}
              <b className="ml-1 tabular-nums text-gray-700">{fmtMoney(b.amount)}</b>
            </span>
          ))}
        </div>

        {/* 各协议单位未结应收 */}
        {arLedgerCompanies.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-50 px-4 py-2 text-[11px] text-gray-500">
            <span className="text-gray-400">单位未结：</span>
            {arLedgerCompanies.map((c) => (
              <span key={c.companyId} className="rounded border border-rose-100 bg-rose-50/60 px-1.5 py-0.5 text-rose-700">
                {c.companyName}
                <b className="ml-1 tabular-nums">{fmtMoney(c.outstanding)}</b>
              </span>
            ))}
          </div>
        )}

        <table className="w-full">
          <thead>
            <tr>
              <th className="th">营业日</th>
              <th className="th">协议单位</th>
              <th className="th">账单</th>
              <th className="th text-right">应收金额</th>
              <th className="th text-right">已核销</th>
              <th className="th text-right">未结</th>
              <th className="th">账期到期</th>
              <th className="th">状态</th>
              <th className="th">操作人</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {arLedgers.length === 0 && (
              <tr>
                <td colSpan={10} className="td py-10 text-center text-gray-400">
                  暂无挂账台账：收银台「挂账」接入 ar_ledgers 后，协议单位应收会自动出现在这里
                </td>
              </tr>
            )}
            {arLedgers.map((r) => {
              const meta = LEDGER_STATUS[r.status] ?? {
                label: r.status,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
              };
              const overdue = r.status !== "SETTLED" && r.status !== "WRITTEN_OFF" && r.due_date && r.due_date < today;
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{r.biz_date}</td>
                  <td className="td text-gray-700">{r.company_name || `协议单位#${r.company_id}`}</td>
                  <td className="td text-gray-500">
                    {r.folio_no || (r.folio_id ? `#${r.folio_id}` : "—")}
                  </td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(r.amount)}</td>
                  <td className="td text-right tabular-nums text-emerald-700">{fmtMoney(r.settled_amount)}</td>
                  <td
                    className={`td text-right font-medium tabular-nums ${
                      r.outstanding > 0.001 ? "text-rose-600" : "text-gray-400"
                    }`}
                  >
                    {fmtMoney(r.outstanding)}
                  </td>
                  <td className={`td tabular-nums ${overdue ? "text-rose-600" : "text-gray-500"}`}>
                    {r.due_date || "—"}
                    {overdue ? <span className="ml-1 text-[11px]">逾期</span> : null}
                  </td>
                  <td className="td">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="td text-gray-500">{r.operator || "系统"}</td>
                  <td className="td text-right">
                    {/*
                      第 4 轮 P1-15：核销入口
                      settleAr() 原来全项目零调用，挂账台账只增不减，收了公司的钱也核销不掉。
                      这里给未结/部分核销的台账加「核销」表单（正常收款核销，用 cashier.receive 权限）。
                    */}
                    {r.outstanding > 0.001 ? (
                      <form action={settleArLedgerAction} className="inline-flex items-center gap-1">
                        <input type="hidden" name="ar_id" value={r.id} />
                        <input type="hidden" name="backTo" value="/ar" />
                        <input
                          name="amount"
                          type="number"
                          step="0.01"
                          min="0.01"
                          max={r.outstanding}
                          defaultValue={r.outstanding}
                          className="input h-6 w-[86px] px-1 text-right text-[11px]"
                          title={`未结 ${fmtMoney(r.outstanding)}`}
                        />
                        <button className="btn-default h-6 px-1.5 text-[11px]">核销</button>
                      </form>
                    ) : (
                      <span className="text-[11px] text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 账户列表 */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">AR 账户</span>
          <span className="min-w-0 text-[11px] text-gray-400">
            共 {accountCount} 个账户 · 应收合计 <b className="text-rose-600">{fmtMoney(totalReceivable)}</b>
            {selected ? (
              <span className="ml-2 text-brand-600">当前选中：{selected.code} {selected.name}</span>
            ) : (
              <span className="ml-2">点击「账单」查看流水</span>
            )}
          </span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">编码</th>
              <th className="th">名称</th>
              <th className="th">类型</th>
              <th className="th text-right">授信额度</th>
              <th className="th text-right">应收余额</th>
              <th className="th">状态</th>
              <th className="th">联系人</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <td colSpan={8} className="td py-10 text-center text-gray-400">
                  暂无 AR 账户
                </td>
              </tr>
            )}
            {accounts.map((a) => {
              const balance = round2(Number(a.balance ?? 0));
              const credit = round2(Number(a.credit_limit ?? 0));
              const used = credit > 0 ? Math.round((balance / credit) * 100) : 0;
              const typeCls = ACCOUNT_TYPE_CLS[a.type] ?? "border-gray-200 bg-gray-50 text-gray-600";
              const isSelected = a.id === selected?.id;
              return (
                <tr key={a.id} className={isSelected ? "bg-brand-50" : "hover:bg-gray-50"}>
                  <td className="td font-medium text-gray-800">{a.code}</td>
                  <td className="td text-gray-700">
                    {a.name}
                    <span className="ml-1 text-[11px] text-gray-400">{a.contact || ""}</span>
                  </td>
                  <td className="td">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${typeCls}`}>
                      {a.type}
                    </span>
                  </td>
                  <td className="td text-right tabular-nums text-gray-600">
                    {credit > 0 ? (
                      <>
                        {fmtMoney(credit)}
                        <span className={`ml-1 text-[11px] ${used >= 100 ? "text-rose-600" : "text-gray-400"}`}>
                          {used}%
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-400">不限额</span>
                    )}
                  </td>
                  <td
                    className={`td text-right font-medium tabular-nums ${
                      balance < 0 ? "text-emerald-700" : "text-rose-600"
                    }`}
                  >
                    {fmtMoney(balance)}
                  </td>
                  <td className="td">
                    <span
                      className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${
                        a.status === "ON"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-gray-200 bg-gray-100 text-gray-500"
                      }`}
                    >
                      {a.status === "ON" ? "正常" : "停用"}
                    </span>
                  </td>
                  <td className="td text-gray-500">{a.phone || "—"}</td>
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/ar?account=${a.id}&act=post#ops`}
                        className="btn-primary px-2 py-0.5 text-[11px]"
                      >
                        入账
                      </Link>
                      <Link
                        href={`/ar?account=${a.id}&act=pay#ops`}
                        className="btn-default px-2 py-0.5 text-[11px]"
                      >
                        付款
                      </Link>
                      <Link
                        href={`/ar?account=${a.id}&act=wo#ops`}
                        className="btn-default px-2 py-0.5 text-[11px]"
                      >
                        核销
                      </Link>
                      <Link
                        href={`/ar?account=${a.id}&act=bill#flows`}
                        className="btn-default px-2 py-0.5 text-[11px]"
                      >
                        账单
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 操作区 */}
      {!selected ? (
        <div
          id="ops"
          className="card flex h-[120px] flex-col items-center justify-center gap-1.5 border-dashed text-gray-400"
        >
          <div className="text-[13px] text-gray-500">尚未选择 AR 账户</div>
          <div className="text-[11px]">在上方账户列表点击「入账 / 付款 / 核销 / 账单」，即可办理对应业务</div>
        </div>
      ) : (
        <div id="ops" className="grid gap-3 lg:grid-cols-4">
          {/* 入账 */}
          <form action={postArAction} className={`card flex flex-col gap-2.5 p-4${activeCls("post")}`}>
            <input type="hidden" name="account_id" value={selected.id} />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-gray-800">入账（POST）</span>
              <span className="text-[11px] text-gray-400">{selected.code}</span>
            </div>
            <div>
              <label className="label">入账金额（元）</label>
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                className="input"
                placeholder="输入挂账金额"
                required
              />
            </div>
            <div>
              <label className="label">营业日</label>
              <input name="biz_date" type="date" defaultValue={today} className="input" />
            </div>
            <div>
              <label className="label">备注</label>
              <input name="note" className="input" placeholder="如：11 月房费挂账" />
            </div>
            <div className="text-[11px] text-gray-400">增加应收余额，写入一条 POST 流水</div>
            <button className="btn-primary mt-1">确认入账</button>
          </form>

          {/* 付款 */}
          <form action={payArAction} className={`card flex flex-col gap-2.5 p-4${activeCls("pay")}`}>
            <input type="hidden" name="account_id" value={selected.id} />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-gray-800">付款（PAY）</span>
              <span className="text-[11px] text-gray-400">{selected.code}</span>
            </div>
            <div>
              <label className="label">付款金额（元）</label>
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                className="input"
                placeholder="输入客户还款金额"
                required
              />
            </div>
            <div>
              <label className="label">营业日</label>
              <input name="biz_date" type="date" defaultValue={today} className="input" />
            </div>
            <div>
              <label className="label">备注</label>
              <input name="note" className="input" placeholder="如：银行转账还款" />
            </div>
            <div className="text-[11px] text-gray-400">
              减少应收余额，当前余额 {fmtMoney(selected.balance)}，不得超过余额
            </div>
            <button className="btn-primary mt-1">确认付款</button>
          </form>

          {/* 转账 */}
          <form action={transferArAction} className={`card flex flex-col gap-2.5 p-4${activeCls("tr")}`}>
            <input type="hidden" name="account_id" value={selected.id} />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-gray-800">转账调账（TRANSFER）</span>
              <span className="text-[11px] text-gray-400">{selected.code}</span>
            </div>
            <div>
              <label className="label">转入账户</label>
              <select name="to_account_id" className="input" defaultValue="">
                <option value="">请选择转入账户</option>
                {otherAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">转账金额（元）</label>
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                className="input"
                placeholder="输入调账金额"
                required
              />
            </div>
            <div>
              <label className="label">营业日 / 备注</label>
              <div className="flex gap-1.5">
                <input name="biz_date" type="date" defaultValue={today} className="input w-[140px]" />
                <input name="note" className="input" placeholder="可空" />
              </div>
            </div>
            <div className="text-[11px] text-gray-400">两个账户各写一条 TRANSFER 流水，余额同步调整</div>
            <button className="btn-primary mt-1">确认转账</button>
          </form>

          {/* 核销 */}
          <form action={writeOffArAction} className={`card flex flex-col gap-2.5 p-4${activeCls("wo")}`}>
            <input type="hidden" name="account_id" value={selected.id} />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-gray-800">核销（WRITE_OFF）</span>
              <span className="text-[11px] text-gray-400">{selected.code}</span>
            </div>
            <div>
              <label className="label">选择入账流水</label>
              <select name="transaction_id" className="input" defaultValue="">
                <option value="">请选择要核销的入账</option>
                {postCandidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${p.biz_date} · 可核销 ${fmtMoney(p.remaining)}${p.note ? ` · ${p.note}` : ""}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">核销金额（元）</label>
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                className="input"
                placeholder="输入核销金额"
                required
              />
            </div>
            <div>
              <label className="label">营业日 / 备注</label>
              <div className="flex gap-1.5">
                <input name="biz_date" type="date" defaultValue={today} className="input w-[140px]" />
                <input name="note" className="input" placeholder="如：尾差核销" />
              </div>
            </div>
            <div className="text-[11px] text-gray-400">
              写 ar_write_offs 并减少余额；可核销入账 {postCandidates.length} 笔
            </div>
            <button className="btn-danger mt-1" disabled={postCandidates.length === 0}>
              确认核销
            </button>
          </form>
        </div>
      )}

      {/* 账户流水 */}
      <div id="flows" className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">账户流水</span>
          <span className="text-[11px] text-gray-400">
            {selected ? (
              <>
                {selected.code} {selected.name} · 最近 {txs.length} 笔 · 入账 {fmtMoney(txSummary.post)} · 付款{" "}
                {fmtMoney(txSummary.pay)} · 转账 {fmtMoney(txSummary.transfer)} · 核销{" "}
                {fmtMoney(txSummary.writeoff)} · 期末余额{" "}
                <b className="text-rose-600">{fmtMoney(selected.balance)}</b>
              </>
            ) : (
              "选择账户后展示该账户流水"
            )}
          </span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">营业日</th>
              <th className="th">类型</th>
              <th className="th text-right">金额</th>
              <th className="th text-right">余额</th>
              <th className="th">备注</th>
              <th className="th">操作人</th>
            </tr>
          </thead>
          <tbody>
            {txs.length === 0 && (
              <tr>
                <td colSpan={6} className="td py-10 text-center text-gray-400">
                  {selected ? "该账户暂无流水，可在上方办理入账或付款" : "请先在账户列表点击「账单」查看流水"}
                </td>
              </tr>
            )}
            {txs.map((t) => {
              const meta = TYPE_META[t.type] ?? {
                label: t.type,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
              };
              const amount = Number(t.amount ?? 0);
              const signed = `${amount >= 0 ? "+" : "−"}${fmtMoney(Math.abs(amount))}`;
              const amountCls = amount >= 0 ? "text-rose-600" : "text-emerald-700";
              return (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="td tabular-nums text-gray-600">{t.biz_date}</td>
                  <td className="td">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td className={`td text-right font-medium tabular-nums ${amountCls}`}>{signed}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(t.balance_after)}</td>
                  <td className="td max-w-[360px] whitespace-normal text-gray-600">{t.note || "—"}</td>
                  <td className="td text-gray-500">{t.operator || "系统"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 历史核销 */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">历史核销</span>
          <span className="text-[11px] text-gray-400">
            {selected ? `${selected.code} ${selected.name} 的核销记录` : "全部账户核销记录"} · {writeOffs.length} 条 ·
            合计 <b className="text-amber-700">{fmtMoney(writeOffTotal)}</b>
          </span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">核销时间</th>
              <th className="th">账户</th>
              <th className="th">关联入账</th>
              <th className="th text-right">核销金额</th>
              <th className="th">备注</th>
              <th className="th">操作人</th>
            </tr>
          </thead>
          <tbody>
            {writeOffs.length === 0 && (
              <tr>
                <td colSpan={6} className="td py-10 text-center text-gray-400">
                  {selected ? "该账户暂无核销记录" : "暂无核销记录"}
                </td>
              </tr>
            )}
            {writeOffs.map((w) => (
              <tr key={w.id} className="hover:bg-gray-50">
                <td className="td tabular-nums text-gray-600">{fmtTime(w.created_at)}</td>
                <td className="td text-gray-700">
                  {w.account_code ? `${w.account_code} ${w.account_name ?? ""}` : `#${w.ar_account_id}`}
                </td>
                <td className="td text-gray-600">
                  {w.tx_biz_date ? (
                    <>
                      {w.tx_biz_date}
                      <span className="ml-1 text-[11px] text-gray-400">
                        入账 {fmtMoney(w.tx_amount ?? 0)} · #{w.transaction_id}
                      </span>
                    </>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="td text-right font-medium tabular-nums text-amber-700">
                  {fmtMoney(w.amount)}
                </td>
                <td className="td max-w-[360px] whitespace-normal text-gray-600">{w.note || "—"}</td>
                <td className="td text-gray-500">{w.operator || "系统"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-400">
        入账 / 付款 / 转账 / 核销均在数据库事务内完成：先写 ar_transactions（含 balance_after 余额快照），
        再更新 ar_accounts.balance，核销额外写 ar_write_offs，任何一步失败整体回滚，账户余额与流水始终一致。
      </p>
    </div>
  );
}
