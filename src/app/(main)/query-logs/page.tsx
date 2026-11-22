import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** 查询日志：只读。直接统计 op_logs 并按操作类型（action）分类与过滤 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type ActionStat = {
  action: string;
  c: number;
  last_at: string | null;
};

type LogRow = {
  id: number;
  operator: string | null;
  action: string | null;
  detail: string | null;
  created_at: string | null;
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default async function QueryLogsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const type = first(sp.type).trim();
  const today = todayStr();

  // 老库可能还没有 op_logs，先探测表，避免直接 500
  const hasTable =
    (get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0) > 0;

  const total = hasTable
    ? get<{ c: number }>(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ?`, [hotelId])?.c ?? 0
    : 0;
  const todayCount = hasTable
    ? get<{ c: number }>(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND substr(created_at, 1, 10) = ?`, [
        hotelId,
        today,
      ])?.c ?? 0
    : 0;

  const actions = hasTable
    ? all<ActionStat>(
        `SELECT action, COUNT(*) AS c, MAX(created_at) AS last_at
           FROM op_logs
          WHERE hotel_id = ? AND action IS NOT NULL AND action <> ''
          GROUP BY action
          ORDER BY c DESC, action`,
        [hotelId]
      )
    : [];

  const rows = hasTable
    ? type
      ? all<LogRow>(
          `SELECT id, operator, action, detail, created_at
             FROM op_logs
            WHERE hotel_id = ? AND action = ?
            ORDER BY id DESC
            LIMIT 200`,
          [hotelId, type]
        )
      : all<LogRow>(
          `SELECT id, operator, action, detail, created_at
             FROM op_logs
            WHERE hotel_id = ?
            ORDER BY id DESC
            LIMIT 200`,
          [hotelId]
        )
    : [];

  const maxCount = actions.reduce((m, a) => (a.c > m ? a.c : m), 0);
  const filteredActive = type.length > 0;

  const cards = [
    { label: "日志总数", value: String(total), sub: "op_logs 全量记录", cls: "bg-blue-50 text-blue-600" },
    { label: "动作类型", value: String(actions.length), sub: "按 action 分组统计", cls: "bg-violet-50 text-violet-600" },
    { label: "今日操作", value: String(todayCount), sub: `营业日 ${today}`, cls: "bg-emerald-50 text-emerald-600" },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">查询日志</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            系统操作留痕按动作分类统计，可点击动作标签过滤明细 · 本页只读
          </p>
        </div>
        <Link href="/logs" className="btn-default py-1.5 text-[12px]">
          查看原始操作日志
        </Link>
      </div>

      {!hasTable && (
        <div className="card border-l-4 border-l-amber-500 px-4 py-2.5 text-[12px] text-amber-700">
          当前数据库还没有 op_logs 表，暂无日志数据；完成任意一次房态变更、退房或登录后即可产生记录。
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-500">{c.label}</span>
              <span className={`flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold ${c.cls}`}>
                {c.label.slice(0, 1)}
              </span>
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-gray-900">{c.value}</div>
            <div className="mt-1 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="border-b border-gray-100 px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-gray-800">按动作分类 · {actions.length} 类</span>
            <span className="text-[11px] text-gray-400">点击标签过滤下方明细</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          <Link
            href="/query-logs"
            className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
              filteredActive
                ? "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                : "border-brand-600 bg-brand-600 font-medium text-white"
            }`}
          >
            全部
            <span className={`ml-1 text-[11px] tabular-nums ${filteredActive ? "text-gray-400" : "text-white/80"}`}>
              {total}
            </span>
          </Link>
          {actions.map((a) => {
            const active = a.action === type;
            const pct = maxCount > 0 ? Math.round((a.c / maxCount) * 100) : 0;
            return (
              <Link
                key={a.action}
                href={`/query-logs?type=${encodeURIComponent(a.action)}`}
                title={`最近一次 ${fmtTime(a.last_at)} · 占比 ${pct}%`}
                className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                  active
                    ? "border-brand-600 bg-brand-600 font-medium text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                }`}
              >
                {a.action}
                <span className={`ml-1 text-[11px] tabular-nums ${active ? "text-white/80" : "text-gray-400"}`}>
                  {a.c}
                </span>
              </Link>
            );
          })}
          {actions.length === 0 && <span className="text-[12px] text-gray-400">暂无可统计的操作类型</span>}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">
            {filteredActive ? `明细 · 动作「${type}」` : "全部明细"} · {rows.length} 条
          </span>
          <span className="text-[11px] text-gray-400">
            最多展示最近 200 条{filteredActive ? "（已按动作过滤）" : ""}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">操作人</th>
                <th className="th">动作</th>
                <th className="th">详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="td py-10 text-center text-gray-400">
                    {filteredActive ? `动作「${type}」暂无日志记录` : "暂无日志记录（房态变更、退房等操作会自动留痕）"}
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td whitespace-nowrap text-gray-500">{fmtTime(r.created_at)}</td>
                  <td className="td text-gray-700">{r.operator ?? "-"}</td>
                  <td className="td">
                    <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-600">
                      {r.action ?? "未分类"}
                    </span>
                  </td>
                  <td className="td whitespace-normal text-gray-600">{r.detail ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
