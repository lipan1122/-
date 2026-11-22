import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 移动端账务（F13）
 *
 * 手机上看账的核心诉求：「哪几间房欠多少钱、今天该退谁的房」。
 * 不是把收银台那套 30 个按钮搬过来。
 *
 * 分三块：
 *   1. 今日收款汇总（按方式）
 *   2. 待结账客人（预离 + 有余额，按金额降序）
 *   3. 全部在住客人（可搜）
 */

export default async function MobileCashierPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const filter = sp.filter === "debt" || sp.filter === "dueout" ? sp.filter : "all";
  /*
   * 整改 P1-28g：桌面收银台（src/app/(main)/cashier/page.tsx）的「今日收款 / 今日退房」
   * 用 todayStr()（自然日）统计，移动端原来用 bizToday()（营业日）—— 营业日切换点
   * 不为 00:00 时同一时刻两个页面会差一天。这里对齐桌面口径，统一按自然日。
   */
  const today = todayStr();

  /* 今日收款按方式 */
  const pays = all<{ method: string | null; total: number; cnt: number }>(
    `SELECT COALESCE(method, '现金') AS method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM payments WHERE hotel_id = ? AND biz_date = ?
      GROUP BY COALESCE(method, '现金') ORDER BY total DESC`,
    [user.hotelId, today]
  );
  const payTotal = pays.reduce((s, p) => s + Number(p.total), 0);

  /* 在住客人账务 */
  const where: string[] = ["s.hotel_id = ?", "s.status = 'INHOUSE'"];
  const params: unknown[] = [user.hotelId];
  if (q) {
    where.push("(s.guest_name LIKE ? OR s.mobile LIKE ? OR r.room_no LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (filter === "debt") where.push("COALESCE(f.balance,0) > 0.01");
  if (filter === "dueout") {
    /* 注意：SQL 里别名是 expect_out，但 WHERE 条件必须用真实列名 expect_check_out */
    where.push("s.expect_check_out = ?");
    params.push(today);
  }

  const stays = all<{
    stay_id: number;
    stay_no: string;
    guest_name: string;
    mobile: string | null;
    room_no: string;
    expect_out: string | null;
    folio_id: number | null;
    folio_no: string | null;
    total: number;
    paid: number;
    balance: number;
  }>(
    `SELECT s.id AS stay_id, s.stay_no, s.guest_name, s.mobile, r.room_no,
            s.expect_check_out AS expect_out, f.id AS folio_id, f.folio_no,
            COALESCE(f.total_amount,0) AS total,
            COALESCE(f.paid_amount,0) AS paid,
            COALESCE(f.balance,0) AS balance
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
       LEFT JOIN folios f ON f.stay_id = s.id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(f.balance,0) DESC, r.sort
      LIMIT 100`,
    params
  );

  /*
   * 分类计数：P1-28f —— 必须用「未筛选」的全量口径，
   * 否则选了「有欠费」之后「全部在住」会从 24 变成 21，跟桌面 /m 工作台对不上。
   */
  const stat =
    get<{ total: number; debt: number; dueout: number; debt_amount: number }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN COALESCE(f.balance,0) > 0.01 THEN 1 ELSE 0 END) AS debt,
         SUM(CASE WHEN s.expect_check_out = ? THEN 1 ELSE 0 END) AS dueout,
         SUM(CASE WHEN COALESCE(f.balance,0) > 0.01 THEN f.balance ELSE 0 END) AS debt_amount
       FROM stays s
       LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'`,
      [today, user.hotelId]
    ) ?? { total: 0, debt: 0, dueout: 0, debt_amount: 0 };

  const debtTotal = Number(stat.debt_amount) || 0;

  return (
    <div className="mx-auto max-w-[520px]">
      {/* 今日收款 */}
      <div className="bg-gradient-to-br from-[#2f80ed] to-[#1e8e3e] px-4 pb-4 pt-3 text-white">
        <div className="text-[11px] text-white/70">今日收款 · {today}</div>
        <div className="mt-1 text-[26px] font-bold leading-none tabular-nums">{fmtMoney(payTotal)}</div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/85">
          {pays.length === 0 && <span>暂无收款</span>}
          {pays.map((p) => (
            <span key={p.method ?? "现金"}>
              {p.method} {fmtMoney(p.total)}（{p.cnt} 笔）
            </span>
          ))}
        </div>
      </div>

      {/* 快捷筛选 */}
      <div className="sticky top-0 z-10 border-b border-[#e5e5e5] bg-white/95 px-3 py-2 backdrop-blur">
        <form action="/m/cashier" method="get" className="flex items-center gap-2">
          {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
          <label htmlFor="m-cashier-q" className="sr-only">
            搜索在住客人（姓名 / 手机 / 房号）
          </label>
          <input
            id="m-cashier-q"
            name="q"
            defaultValue={q}
            placeholder="客人 / 手机 / 房号"
            className="h-8 flex-1 rounded-[4px] bg-[#f2f3f5] px-2.5 text-[12.5px] outline-none placeholder:text-[#b0b8bf] focus-visible:ring-2 focus-visible:ring-brand-300"
          />
          <button type="submit" className="h-8 rounded-[4px] bg-[#1e8e3e] px-3 text-[12px] text-white">
            搜索
          </button>
        </form>

        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {[
            { key: "all", label: "全部在住", n: stat.total },
            { key: "debt", label: "有欠费", n: stat.debt },
            { key: "dueout", label: "今日预离", n: stat.dueout },
          ].map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/m/cashier" : `/m/cashier?filter=${f.key}`}
              prefetch={false}
              aria-current={filter === f.key ? "true" : undefined}
              aria-label={`筛选 ${f.label}（${f.n} 间）`}
              className={`inline-flex h-11 shrink-0 items-center rounded-full px-3 text-[12px] ${
                filter === f.key ? "bg-[#1e8e3e] text-white" : "border border-[#dcdcdc] bg-white text-gray-600"
              }`}
            >
              {f.label}
              <span className={`ml-1 ${filter === f.key ? "text-white/70" : "text-[#b0b8bf]"}`}>{f.n}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* 欠费汇总条 */}
      {debtTotal > 0.01 && (
        <div className="mx-3 mt-3 rounded-[6px] border border-[#f5c2c2] bg-[#fdf3f3] px-3 py-2">
          <span className="text-[11.5px] text-[#c0392b]">
            当前在住欠费合计 <b className="tabular-nums">{fmtMoney(debtTotal)}</b>，退房前需结清
          </span>
        </div>
      )}

      {/* 客人列表 */}
      <div className="space-y-2 px-3 py-3">
        {stays.length === 0 && (
          <div className="rounded-[8px] border border-dashed border-[#dcdcdc] bg-white py-16 text-center text-[13px] text-[#8b949e]">
            {q || filter !== "all" ? "没有符合条件的客人" : "当前没有在住客人"}
          </div>
        )}

        {stays.map((s) => {
          const bal = Number(s.balance);
          const isToday = s.expect_out === today;
          return (
            <Link
              key={s.stay_id}
              href={`/cashier?stay=${s.stay_id}`}
              prefetch={false}
              className="block rounded-[8px] bg-white p-3 active:bg-[#f7f7f7]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded-[4px] bg-[#f2f3f5] text-[12px] font-semibold tabular-nums text-gray-700">
                    {s.room_no}
                  </span>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[14px] font-medium text-gray-900">{s.guest_name}</span>
                      {isToday && (
                        <span className="shrink-0 rounded-[3px] bg-[#fff7e6] px-1 text-[10px] text-[#b07d2e]">今日离</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-[#8b949e]">
                      {s.mobile ?? "无手机"} · 预离 {s.expect_out ?? "—"}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={`text-[15px] font-semibold tabular-nums ${
                      bal > 0.01 ? "text-[#d9534f]" : "text-[#1e8e3e]"
                    }`}
                  >
                    {fmtMoney(bal)}
                  </div>
                  <div className="text-[10px] text-[#b0b8bf]">应收余额</div>
                </div>
              </div>

              <div className="mt-1.5 flex items-center justify-between text-[11px] text-[#8b949e]">
                <span>
                  消费 {fmtMoney(s.total)} · 已收 {fmtMoney(s.paid)}
                  {s.folio_no && <span className="ml-1.5 font-mono">{s.folio_no}</span>}
                </span>
                <span className="text-[#1e8e3e]">去收银台 ›</span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="px-3 pb-4 text-center text-[10.5px] text-[#b0b8bf]">
        收款/退款/结账请用电脑版收银台
      </div>
    </div>
  );
}
