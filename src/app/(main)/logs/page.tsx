import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  const user = await requireUser();
  const rows = all<{ id: number; operator: string | null; action: string | null; detail: string | null; created_at: string | null }>(
    `SELECT id, operator, action, detail, created_at FROM op_logs WHERE hotel_id = ? ORDER BY id DESC LIMIT 200`,
    [user.hotelId]
  );

  return (
    <div className="space-y-3 p-4">
      <div>
        <h1 className="text-[16px] font-semibold text-gray-900">操作日志</h1>
        <p className="mt-0.5 text-[12px] text-gray-500">最近 200 条系统操作记录</p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">时间</th><th className="th">操作人</th><th className="th">动作</th><th className="th">详情</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="td py-10 text-center text-gray-400">暂无操作记录（房态变更、退房等操作会自动记录）</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="td text-gray-500">{r.created_at ? new Date(r.created_at).toLocaleString("zh-CN", { hour12: false }) : "-"}</td>
                <td className="td">{r.operator ?? "-"}</td>
                <td className="td text-gray-700">{r.action ?? "-"}</td>
                <td className="td text-gray-500">{r.detail ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
