import Link from "next/link";
import ConfirmForm from "@/components/ConfirmForm";
import { bizToday } from "@/lib/biz-date";
import { invoiceStats, listInvoices } from "@/lib/invoice";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { redFlushInvoiceAction } from "./actions";

/**
 * 发票台账（整改清单 P2-3：发票建台账 / 开票校验 / 红冲）
 *
 * 数据来源：invoices 表（service：src/lib/invoice.ts，建表见 scripts/migrate-all.mjs 第 10 段）。
 * 页面只做只读展示 + 红冲，开票动作仍从收银台「开发票」发起（那里的金额来自账单实收，
 * 校验会拒绝未结账与超额开票）。
 *
 * 金额口径：amount 有符号 —— 正常票为正、红冲票为负，
 * 因此 已开票金额 - 红冲金额 = 净开票额，红冲后额度自动还回可重新开票。
 */
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** 发票类型徽标：NORMAL 正常 / RED 红冲 / VOID 作废 */
const TYPE_META: Record<string, { label: string; cls: string }> = {
  NORMAL: { label: "正常", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  RED: { label: "红冲", cls: "border-rose-200 bg-rose-50 text-rose-600" },
  VOID: { label: "作废", cls: "border-gray-200 bg-gray-100 text-gray-500" },
};

/** 发票状态徽标：ISSUED 已开 / RED 已红冲 / VOID 已作废 */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  ISSUED: { label: "已开票", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  RED: { label: "已红冲", cls: "border-rose-200 bg-rose-50 text-rose-600" },
  VOID: { label: "已作废", cls: "border-gray-200 bg-gray-100 text-gray-500" },
};

const FILTER_STATUS = ["ISSUED", "RED", "VOID"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** 只接受合法的 YYYY-MM-DD，非法值当没填（避免脏参数把筛选条件带偏） */
function safeDate(v: string): string {
  return DATE_RE.test(v) ? v : "";
}

/** 时间戳：台账展示到分钟，与 /ar 页面口径一致 */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default async function InvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  const ok = first(sp.ok);
  const err = first(sp.err);

  // 筛选：营业日闭区间 + 状态（参数先做白名单 / 格式校验）
  const from = safeDate(first(sp.from));
  const to = safeDate(first(sp.to));
  const statusRaw = first(sp.status);
  const status = (FILTER_STATUS as readonly string[]).includes(statusRaw) ? statusRaw : "";

  const today = bizToday(hotelId);
  const monthStart = `${today.slice(0, 7)}-01`;

  const stats = invoiceStats(hotelId, from || undefined, to || undefined);
  const rows = listInvoices(hotelId, {
    from: from || undefined,
    to: to || undefined,
    status: status || undefined,
    limit: 500,
  });

  const normalCount = rows.filter((r) => r.invoice_type === "NORMAL").length;
  const redCount = rows.filter((r) => r.invoice_type === "RED").length;
  const hasFilter = Boolean(from || to || status);

  const cards = [
    {
      label: "已开票金额",
      value: fmtMoney(stats.issued),
      sub: "正常票合计（含之后被红冲的）",
      cls: "text-gray-900",
    },
    {
      label: "红冲金额",
      value: fmtMoney(stats.red),
      sub: "红冲票（负数票）绝对值合计",
      cls: "text-rose-600",
    },
    {
      label: "净开票额",
      value: fmtMoney(stats.net),
      sub: "已开票 − 红冲 = 实际有效开票",
      cls: "text-brand-700",
    },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">发票台账</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            开票记录逐张可查：发票号 / 抬头 / 税号 / 金额 / 关联账单 / 红冲。开票前校验账单已结账且不超应收。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/cashier" className="btn-default px-2.5 py-1 text-[12px]">
            收银台开票
          </Link>
          <Link href="/ar" className="btn-default px-2.5 py-1 text-[12px]">
            AR 应收
          </Link>
          <Link href="/invoices" className="btn-default px-2.5 py-1 text-[12px]">
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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="card p-3">
            <div className="text-[11px] text-gray-500">{c.label}</div>
            <div className={`mt-1 text-[18px] font-semibold tabular-nums ${c.cls}`}>{c.value}</div>
            <div className="mt-0.5 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* 筛选：营业日区间 + 状态 */}
      <div className="card flex flex-wrap items-end gap-2 px-3 py-2.5">
        <form action="/invoices" method="get" className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">营业日从</label>
            <input type="date" name="from" defaultValue={from} className="input h-[30px] w-36 text-[12px]" />
          </div>
          <div>
            <label className="label">营业日到</label>
            <input type="date" name="to" defaultValue={to} className="input h-[30px] w-36 text-[12px]" />
          </div>
          <div>
            <label className="label">状态</label>
            <select name="status" defaultValue={status} className="input h-[30px] w-28 text-[12px]">
              <option value="">全部</option>
              <option value="ISSUED">已开票</option>
              <option value="RED">已红冲</option>
              <option value="VOID">已作废</option>
            </select>
          </div>
          <button type="submit" className="btn-primary h-[30px] px-3 text-[12px]">
            查询
          </button>
          {hasFilter && (
            <Link href="/invoices" className="btn-default h-[30px] px-3 text-[12px]">
              重置
            </Link>
          )}
        </form>

        <div className="ml-auto flex items-center gap-1.5 text-[12px]">
          <Link
            href={`/invoices?from=${today}&to=${today}`}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:border-brand-400 hover:text-brand-600"
          >
            今日
          </Link>
          <Link
            href={`/invoices?from=${monthStart}&to=${today}`}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:border-brand-400 hover:text-brand-600"
          >
            本月
          </Link>
          <Link
            href="/invoices"
            className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-600 hover:border-brand-400 hover:text-brand-600"
          >
            全部
          </Link>
          <span className="ml-1 text-[11px] text-gray-400">
            {from || to ? `${from || "最早"} ~ ${to || "最新"}` : "未限营业日"} · 共 {rows.length} 条（正常{" "}
            {normalCount} / 红冲 {redCount}）
          </span>
        </div>
      </div>

      {/* 台账列表 */}
      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">发票记录</span>
          <span className="text-[11px] text-gray-400">
            红冲只追加负数票、不删原票；红冲后该账单额度自动还回，可重新开票
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">发票号</th>
                <th className="th">类型</th>
                <th className="th">抬头</th>
                <th className="th">税号</th>
                <th className="th text-right">金额</th>
                <th className="th">关联账单</th>
                <th className="th">客人 / 房间</th>
                <th className="th">营业日</th>
                <th className="th">操作人</th>
                <th className="th">状态</th>
                <th className="th text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="td py-10 text-center text-gray-400">
                    {hasFilter
                      ? "该条件下没有发票记录，试试放宽营业日区间或状态"
                      : "暂无发票记录：收银台结账后点「开发票」，记录会出现在这里"}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const typeMeta = TYPE_META[r.invoice_type] ?? {
                  label: r.invoice_type,
                  cls: "border-gray-200 bg-gray-50 text-gray-600",
                };
                const statusMeta = STATUS_META[r.status] ?? {
                  label: r.status,
                  cls: "border-gray-200 bg-gray-50 text-gray-600",
                };
                // 只有「正常票 + 已开票」可以红冲；红冲票不能再红冲
                const canRedFlush = r.invoice_type === "NORMAL" && r.status === "ISSUED";
                const neg = r.amount < 0;
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="td font-medium tabular-nums text-gray-800">
                      {r.invoice_no}
                      {r.red_of && (
                        <span className="ml-1 text-[11px] text-gray-400" title={`红冲原发票 #${r.red_of}`}>
                          ← #{r.red_of}
                        </span>
                      )}
                      <div className="text-[11px] font-normal text-gray-400">{fmtTime(r.created_at)}</div>
                    </td>
                    <td className="td">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${typeMeta.cls}`}>
                        {typeMeta.label}
                      </span>
                    </td>
                    <td className="td text-gray-700">
                      <div className="max-w-[220px] truncate" title={r.title}>
                        {r.title}
                      </div>
                      {r.remark && <div className="max-w-[220px] truncate text-[11px] text-gray-400">{r.remark}</div>}
                    </td>
                    <td className="td text-gray-500">
                      <span className="text-[12px] tabular-nums">{r.tax_no || "—"}</span>
                    </td>
                    <td
                      className={`td text-right font-medium tabular-nums ${neg ? "text-rose-600" : "text-gray-800"}`}
                    >
                      {neg ? "-" : ""}
                      {fmtMoney(Math.abs(r.amount))}
                    </td>
                    <td className="td text-gray-500">
                      {r.folio_id ? (
                        <Link
                          href={r.stay_id ? `/cashier?stay=${r.stay_id}` : "/cashier"}
                          className="text-brand-600 hover:underline"
                          title="到收银台查看该账单"
                        >
                          {r.folio_no || `#${r.folio_id}`}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="td text-gray-600">
                      <div className="max-w-[150px] truncate">{r.guest_name || "—"}</div>
                      <div className="text-[11px] text-gray-400">{r.room_no ? `房间 ${r.room_no}` : ""}</div>
                    </td>
                    <td className="td tabular-nums text-gray-600">{r.biz_date}</td>
                    <td className="td text-gray-500">{r.operator || "系统"}</td>
                    <td className="td">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${statusMeta.cls}`}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="td text-right">
                      {canRedFlush ? (
                        <ConfirmForm
                          action={redFlushInvoiceAction}
                          message={`确认红冲发票 ${r.invoice_no}？`}
                          detail={`将生成一张金额 ${fmtMoney(-Math.abs(r.amount))} 的红冲票，原票标记为「已红冲」，该账单额度自动还回。红冲记录会保留，不能删除。`}
                          confirmLabel="确认红冲"
                          requireReason="红冲原因"
                        >
                          <input type="hidden" name="invoice_id" value={r.id} />
                          <input type="hidden" name="from" value={from} />
                          <input type="hidden" name="to" value={to} />
                          <input type="hidden" name="status" value={status} />
                          <button type="submit" className="btn-danger h-7 px-2 text-[12px]">
                            红冲
                          </button>
                        </ConfirmForm>
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
      </div>

      <p className="px-1 text-[11px] leading-relaxed text-gray-400">
        说明：金额为有符号数，红冲票以负数入账；「已开票金额 − 红冲金额 = 净开票额」。发票号在同一酒店内唯一，
        用户不填时自动生成 INV-营业日-序号；红冲票号自动生成 RED-营业日-序号。
      </p>
    </div>
  );
}
