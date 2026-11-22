import { all, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import ConfirmForm from "@/components/ConfirmForm";
import { claimLostItemAction, createLostItemAction, deleteLostItemAction } from "./actions";

export const dynamic = "force-dynamic";

type Search = { q?: string; err?: string; msg?: string };

export default async function LostFoundPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const err = sp.err ?? "";
  const msg = sp.msg ?? "";

  run(`CREATE TABLE IF NOT EXISTS lost_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    room_no TEXT,
    guest_name TEXT,
    mobile TEXT,
    found_at TEXT,
    keeper TEXT,
    status TEXT DEFAULT 'PENDING',
    note TEXT,
    claimed_at TEXT,
    created_at TEXT
  )`);

  /*
   * 老库补列（整改清单 P1-30）：建表语句里的 claimed_at 只对新建库生效，
   * 已经存在的库要 ALTER TABLE。幂等：每次页面加载先 PRAGMA 探测。
   */
  if (!all<{ name: string }>(`PRAGMA table_info(lost_items)`).some((c) => String(c.name) === "claimed_at")) {
    run(`ALTER TABLE lost_items ADD COLUMN claimed_at TEXT`);
  }

  const rows = all<{
    id: number;
    item_name: string;
    found_at: string | null;
    room_no: string | null;
    guest_name: string | null;
    keeper: string | null;
    note: string | null;
    status: string | null;
    claimed_at: string | null;
  }>(
    `SELECT id, item_name, found_at, room_no, guest_name, keeper, note, status, claimed_at
     FROM lost_items WHERE hotel_id = ? ${q ? "AND (item_name LIKE ? OR note LIKE ? OR room_no LIKE ?)" : ""}
     ORDER BY id DESC`,
    q ? [hotelId, `%${q}%`, `%${q}%`, `%${q}%`] : [hotelId]
  );

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[16px] font-semibold text-[#222]">失物招领</h1>
        <form method="get" className="flex items-center gap-2">
          <input name="q" defaultValue={q} placeholder="物品 / 描述 / 房号" className="input h-7 w-[200px] text-[12px]" />
          <button className="h-7 rounded-[3px] bg-[#3bd943] px-3 text-[12px] text-white">查询</button>
        </form>
      </div>

      {/* 操作结果提示（认领 / 删除被拒绝的原因必须让人看见，不能静默 return） */}
      {err && (
        <div className="rounded-[3px] border border-[#f3c6c6] bg-[#fdf3f3] px-3 py-2 text-[12px] text-[#c0392b]">
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-[3px] border border-[#cfe8d5] bg-[#f1f9f3] px-3 py-2 text-[12px] text-[#1e8e3e]">
          {msg}
        </div>
      )}

      <details className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-[#2a9d5c] [&::-webkit-details-marker]:hidden">
          + 新建失物信息
        </summary>
        <form action={createLostItemAction} className="grid gap-2 border-t border-[#f0f0f0] p-3 md:grid-cols-5">
          <div>
            <label className="label">物品名称 *</label>
            <input name="name" required className="input h-7 w-full text-[12px]" />
          </div>
          <div>
            <label className="label">拾获人</label>
            <input name="place" className="input h-7 w-full text-[12px]" placeholder="客房/大堂/餐厅" />
          </div>
          <div>
            <label className="label">房号</label>
            <input name="room_no" className="input h-7 w-full text-[12px]" />
          </div>
          <div>
            <label className="label">备注</label>
            <input name="desc" className="input h-7 w-full text-[12px]" />
          </div>
          <div className="flex items-end">
            <button className="btn-primary h-7 w-full text-[12px]">登记</button>
          </div>
        </form>
      </details>

      <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[#fafafa]">
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">物品</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">拾获地点</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">房号</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">描述</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">状态</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">拾获日期</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">客人</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-[12px] text-[#999]">
                  暂无失物记录
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-[#f5f5f5]">
                <td className="px-3 py-2 text-[12px] text-[#222]">{r.item_name}</td>
                <td className="px-3 py-2 text-[12px] text-[#555]">{r.keeper ?? "—"}</td>
                <td className="px-3 py-2 text-[12px] text-[#555]">{r.room_no ?? "—"}</td>
                <td className="px-3 py-2 text-[12px] text-[#666]">{r.note ?? "—"}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-[2px] px-1.5 py-0.5 text-[11px] ${
                      r.status === "CLAIMED" ? "bg-[#f5f5f5] text-[#999]" : "bg-[#fff7e6] text-[#b8860b]"
                    }`}
                  >
                    {r.status === "CLAIMED" ? "已认领" : "待认领"}
                  </span>
                  {/* 认领时间单独一列会挤爆窄屏，挂在状态下面即可（P1-30：不再覆盖拾获日期） */}
                  {r.claimed_at && (
                    <div className="mt-0.5 text-[10.5px] tabular-nums text-[#999]">
                      认领 {String(r.claimed_at).slice(0, 10)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-[12px] tabular-nums text-[#666]">{r.found_at ?? "—"}</td>
                <td className="px-3 py-2 text-[12px] text-[#555]">{r.guest_name ?? "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {r.status !== "CLAIMED" && (
                      <form action={claimLostItemAction} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <input name="claimant" placeholder="认领人" className="input h-6 w-[80px] text-[11.5px]" />
                        <button className="rounded-[2px] bg-[#32c141] px-2 py-0.5 text-[11.5px] text-white">
                          认领
                        </button>
                      </form>
                    )}
                    {/*
                      整改清单 P1-31：物理删除必须二次确认 + 填写原因。
                      已认领/已归还的记录会被服务端拒绝（对客交付凭证），
                      这里直接把按钮置灰，避免点下去才失败。
                    */}
                    {r.status === "CLAIMED" || r.status === "RETURNED" ? (
                      <span className="text-[11.5px] text-[#c9c9c9]" title="已交付客人的记录不能删除">
                        已归档
                      </span>
                    ) : (
                      <ConfirmForm
                        action={deleteLostItemAction}
                        message={`确认删除「${r.item_name}」？`}
                        detail="删除后无法恢复，且不会留下物品归还记录。若只是想标记「已还给客人」，请用认领。"
                        requireReason="删除原因"
                        confirmLabel="删除"
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-[11.5px] text-[#999] hover:text-[#e53935]">删除</button>
                      </ConfirmForm>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
