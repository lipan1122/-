import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  createDummyRoomAction,
  deleteDummyRoomAction,
  ensureDummyRoomsTable,
  toggleDummyRoomAction,
} from "./actions";

export const dynamic = "force-dynamic";

type DummyRoomRow = {
  id: number;
  name: string;
  code: string | null;
  category: string | null;
  status: string;
  note: string | null;
  created_at: string | null;
};

const CATEGORIES = ["餐饮", "会议", "其他"] as const;

const CATEGORY_CLS: Record<string, string> = {
  餐饮: "border-amber-200 bg-amber-50 text-amber-700",
  会议: "border-blue-200 bg-blue-50 text-blue-700",
  其他: "border-gray-200 bg-gray-100 text-gray-600",
};

function stamp(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

export default async function DummyRoomsPage() {
  const user = await requireUser();
  await ensureDummyRoomsTable();

  const rows = all<DummyRoomRow>(
    `SELECT id, name, code, category, status, note, created_at
       FROM dummy_rooms
      WHERE hotel_id = ?
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, id`,
    [user.hotelId]
  );

  const active = rows.filter((r) => r.status === "ACTIVE").length;
  const byCategory = CATEGORIES.map((c) => ({
    name: c,
    count: rows.filter((r) => (r.category ?? "其他") === c).length,
  }));

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">哑房管理</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            会议室、餐厅、洗衣等非客房消费挂账点，共 {rows.length} 个 · 启用中{" "}
            <b className="text-emerald-700">{active}</b> 个
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {byCategory.map((c) => (
            <span
              key={c.name}
              className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${
                CATEGORY_CLS[c.name] ?? CATEGORY_CLS.其他
              }`}
            >
              {c.name} {c.count}
            </span>
          ))}
        </div>
      </div>

      <details className="card" open>
        <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-brand-700">
          + 新增哑房
        </summary>
        <form action={createDummyRoomAction} className="grid gap-3 border-t border-gray-100 px-4 py-3 md:grid-cols-6">
          <div className="md:col-span-2">
            <label className="label">名称 *</label>
            <input name="name" required className="input" placeholder="如 3F 会议室 / 中餐厅" />
          </div>
          <div>
            <label className="label">编码</label>
            <input name="code" className="input" placeholder="如 MTG-301" />
          </div>
          <div>
            <label className="label">分类</label>
            <select name="category" className="input" defaultValue="其他">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label">备注</label>
            <input name="note" className="input" placeholder="用途说明（可空）" />
          </div>
          <div className="md:col-span-6">
            <button className="btn-primary">保存</button>
          </div>
        </form>
      </details>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">哑房列表</span>
          <span className="text-[11px] text-gray-400">启用的哑房可直接挂消费，停用后不再出现在选择项中</span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">名称</th>
              <th className="th">编码</th>
              <th className="th">分类</th>
              <th className="th">状态</th>
              <th className="th">备注</th>
              <th className="th">创建时间</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="td py-10 text-center text-gray-400">
                  暂无哑房，可新增会议室、餐厅、洗衣等非客房消费挂账点
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const category = r.category ?? "其他";
              const catCls = CATEGORY_CLS[category] ?? CATEGORY_CLS.其他;
              const on = r.status === "ACTIVE";
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td font-medium text-gray-800">{r.name}</td>
                  <td className="td text-gray-500">{r.code || "—"}</td>
                  <td className="td">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${catCls}`}>
                      {category}
                    </span>
                  </td>
                  <td className="td">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${
                        on ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {on ? "启用中" : "已停用"}
                    </span>
                  </td>
                  <td className="td max-w-[220px] truncate text-gray-600">{r.note || "—"}</td>
                  <td className="td text-gray-500">{stamp(r.created_at)}</td>
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-2">
                      <form action={toggleDummyRoomAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          className={`text-[12px] hover:underline ${on ? "text-gray-500" : "text-emerald-600"}`}
                        >
                          {on ? "停用" : "启用"}
                        </button>
                      </form>
                      <form action={deleteDummyRoomAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-[12px] text-rose-600 hover:underline">删除</button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-400">
        哑房不占房态、不计出租率；删除仅移除该挂账点，历史消费明细仍保留在账单中。
      </p>
    </div>
  );
}
