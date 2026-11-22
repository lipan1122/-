import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { createNoticeAction, deleteNoticeAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function NoticesPage() {
  const user = await requireUser();
  const rows = all<{
    id: number; title: string; content: string | null; author: string | null;
    level: string; created_at: string | null;
  }>(
    `SELECT id, title, content, author, level, created_at FROM notices WHERE hotel_id = ? ORDER BY id DESC`,
    [user.hotelId]
  );

  return (
    <div className="space-y-3 p-4">
      <div>
        <h1 className="text-[16px] font-bold text-[#333333]">通知公告</h1>
        <p className="mt-[3px] text-[12px] text-[#999999]">前台交接班通知、内部公告，共 {rows.length} 条</p>
      </div>

      <details className="card overflow-hidden" open>
        <summary className="cursor-pointer list-none select-none px-3 py-2 text-[12px] text-[#32c141] transition-colors hover:bg-[#fafafa] [&::-webkit-details-marker]:hidden">
          ＋ 发布公告
        </summary>
        <form action={createNoticeAction} className="grid gap-[10px] border-t border-[#eeeeee] px-3 py-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="mb-1 block text-[11px] text-[#999999]">公告标题 *</label>
            <input name="title" required placeholder="公告标题" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#999999]">级别</label>
            <select name="level" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]">
              <option value="normal">普通</option>
              <option value="important">重要</option>
            </select>
          </div>
          <div className="flex items-end">
            <button className="flex h-[26px] items-center justify-center rounded-[3px] bg-[#32c141] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038]">发布公告</button>
          </div>
          <div className="md:col-span-4">
            <label className="mb-1 block text-[11px] text-[#999999]">公告内容</label>
            <textarea name="content" rows={2} placeholder="公告内容" className="input rounded-[3px] border-[#dddddd] text-[12px]" />
          </div>
        </form>
      </details>

      <div className="space-y-2">
        {rows.length === 0 && (
          <div className="card px-3 py-[32px] text-center text-[12px] text-[#999999]">暂无公告</div>
        )}
        {rows.map((n) => (
          <div key={n.id} className="card px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {n.level === "important" && (
                    <span className="shrink-0 rounded-[2px] bg-[#fff5e6] px-1.5 py-[2px] text-[11px] text-[#d48806]">重要</span>
                  )}
                  <span className="truncate text-[13px] font-medium text-[#333333]">{n.title}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-[1.7] text-[#666666]">{n.content}</p>
                <div className="mt-1.5 text-[11px] text-[#999999]">
                  {n.author ?? "-"} · {n.created_at ? new Date(n.created_at).toLocaleString("zh-CN", { hour12: false }) : "-"}
                </div>
              </div>
              <form action={deleteNoticeAction} className="shrink-0">
                <input type="hidden" name="id" value={n.id} />
                <button className="text-[12px] text-[#999999] transition-colors hover:text-[#e05a5a]">删除</button>
              </form>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
