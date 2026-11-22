import { all } from "@/lib/db";
import { ArchiveSidebar } from "@/components/ArchiveSidebar";
import ConfirmForm from "@/components/ConfirmForm";
import { hasPermission, requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { createCompanyAction, deleteCompanyAction, updateCompanyAction } from "./actions";

export const dynamic = "force-dynamic";

type Search = { err?: string; msg?: string };

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const err = sp.err ?? "";
  const msg = sp.msg ?? "";
  /*
   * 协议单位 = 授信主体（整改清单 第六轮 一.8）：写操作用 settings.manage。
   * 页面按同一权限隐藏入口；真正的边界在 Server Action 里。
   */
  const canWrite = hasPermission(user.role, "settings.manage", user.hotelId);

  const rows = all<{
    id: number; name: string; contact: string | null; phone: string | null;
    discount: number; credit_limit: number; order_count: number;
  }>(
    `SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.hotel_id = c.hotel_id AND b.company_id = c.id) AS order_count
     FROM companies c WHERE c.hotel_id = ? ORDER BY c.id`,
    [user.hotelId]
  );

  return (
    <div className="flex">
      <ArchiveSidebar active="协议客户档案" />
      <div className="min-w-0 flex-1 space-y-3 p-4">
      <div>
        <h1 className="text-[16px] font-bold text-[#333333]">协议单位</h1>
        <p className="mt-[3px] text-[12px] text-[#999999]">协议客户档案与信用额度管理，共 {rows.length} 家</p>
      </div>

      {/* 操作结果提示（被拒绝的原因必须让人看见，不能静默失败） */}
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

      {canWrite ? (
        <details className="card overflow-hidden">
          <summary className="cursor-pointer list-none select-none px-3 py-2 text-[12px] text-[#32c141] transition-colors hover:bg-[#fafafa] [&::-webkit-details-marker]:hidden">
            ＋ 新增协议单位
          </summary>
          <form action={createCompanyAction} className="grid gap-[10px] border-t border-[#eeeeee] px-3 py-3 md:grid-cols-5">
            <div>
              <label className="mb-1 block text-[11px] text-[#999999]">单位名称 *</label>
              <input name="name" required className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[#999999]">联系人</label>
              <input name="contact" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[#999999]">电话</label>
              <input name="phone" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[#999999]">协议折扣</label>
              <input name="discount" type="number" step="0.01" defaultValue="0.85" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[#999999]">信用额度</label>
              <input name="credit_limit" type="number" defaultValue="0" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
            </div>
            <div className="md:col-span-5">
              <button className="flex h-[26px] items-center justify-center rounded-[3px] bg-[#32c141] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038]">保存</button>
            </div>
          </form>
        </details>
      ) : (
        <div className="rounded-[3px] border border-[#eeeeee] bg-[#fafafa] px-3 py-2 text-[12px] text-[#999999]">
          当前岗位只能查看协议单位；新增 / 修改 / 删除与信用额度调整需要「系统设置」（settings.manage）权限。
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#fafafa]">
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">单位名称</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">联系人</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">电话</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">协议折扣</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-left text-[12px] font-normal text-[#999999]">信用额度</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-right text-[12px] font-normal text-[#999999]">历史订单</th>
              <th className="h-[30px] whitespace-nowrap border-b border-[#eeeeee] px-3 text-right text-[12px] font-normal text-[#999999]">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-[32px] text-center text-[12px] text-[#999999]">暂无协议单位</td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className="h-[34px] transition-colors hover:bg-[#fafafa]">
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] font-medium text-[#333333]">{c.name}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] text-[#666666]">{c.contact ?? "-"}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] text-[#666666]">{c.phone ?? "-"}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] text-[#333333]">{(c.discount * 10).toFixed(1)} 折</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-[12px] tabular-nums text-[#333333]">{fmtMoney(c.credit_limit)}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-right text-[12px] tabular-nums text-[#333333]">{c.order_count}</td>
                <td className="whitespace-nowrap border-b border-[#eeeeee] px-3 text-right">
                  {canWrite ? (
                    /*
                      整改清单 P1-31：物理删除必须二次确认 + 填写原因。
                      服务端还会做引用检查（历史订单 / 未结 AR 台账），不满足时回跳顶部红条说明原因。
                    */
                    <ConfirmForm
                      action={deleteCompanyAction}
                      message={`确认删除协议单位「${c.name}」？`}
                      detail={
                        c.order_count > 0
                          ? `该单位有 ${c.order_count} 条历史订单，服务端会拒绝删除；如有需要请先调整订单归属。`
                          : "删除后无法恢复。若有未结 AR 台账，服务端会拒绝删除。"
                      }
                      requireReason="删除原因"
                      confirmLabel="删除"
                    >
                      <input type="hidden" name="id" value={c.id} />
                      <button className="text-[12px] text-[#999999] transition-colors hover:text-[#e05a5a]">删除</button>
                    </ConfirmForm>
                  ) : (
                    <span className="text-[11px] text-[#cccccc]">无权限</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        档案与信用额度修改（整改清单 一.8）
        「信用额度」变更必须填原因，服务端落 op_logs：旧值 / 新值 / 原因 / 操作人。
        每家单位一个行内表单，避免把编辑表单塞进表格（table 里嵌套 form 会被浏览器拆掉）。
      */}
      {canWrite && rows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eeeeee] px-3 py-2">
            <span className="text-[12px] font-semibold text-[#333333]">修改档案 / 调整信用额度</span>
            <span className="text-[11px] text-[#999999]">信用额度有变化时必须填写变更原因，变更留痕（旧值 → 新值 · 原因 · 操作人）</span>
          </div>
          <div className="divide-y divide-[#f2f2f2]">
            {rows.map((c) => (
              <form key={c.id} action={updateCompanyAction} className="grid gap-[10px] px-3 py-2.5 md:grid-cols-7 md:items-end">
                <input type="hidden" name="id" value={c.id} />
                <div className="md:col-span-1">
                  <label className="mb-1 block text-[11px] text-[#999999]">单位名称</label>
                  <input name="name" defaultValue={c.name} className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[#999999]">联系人</label>
                  <input name="contact" defaultValue={c.contact ?? ""} className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[#999999]">电话</label>
                  <input name="phone" defaultValue={c.phone ?? ""} className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[#999999]">协议折扣</label>
                  <input name="discount" type="number" step="0.01" defaultValue={c.discount} className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[#999999]">信用额度</label>
                  <input name="credit_limit" type="number" min={0} defaultValue={c.credit_limit} className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[#999999]">变更原因</label>
                  <input name="reason" placeholder="改信用额度必填" className="input h-[30px] rounded-[3px] border-[#dddddd] text-[12px]" />
                </div>
                <div>
                  <button className="flex h-[30px] items-center justify-center rounded-[3px] bg-[#32c141] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038]">保存修改</button>
                </div>
              </form>
            ))}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
