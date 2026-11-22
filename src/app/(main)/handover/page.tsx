import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { getOpenShift, listShifts, previewShiftSummary } from "./data";
import { OpenShiftForm, CloseShiftForm } from "./ShiftForms";

export const dynamic = "force-dynamic";

const PAY_LABEL: Record<string, string> = {
  现金: "现金",
  微信: "微信",
  支付宝: "支付宝",
  银行卡: "银行卡",
  挂账: "挂账",
};

export default async function HandoverPage() {
  const user = await requireUser();
  const hotelId = user.hotelId;

  const openShift = await getOpenShift(hotelId, user.realName);
  /*
   * 第 4 轮 P1-13：汇总必须按当前操作员过滤
   *
   * 班次是按人开的（getOpenShift 查 operator = realName），
   * 汇总却原来是全店口径 —— 两个收银员同时在岗时互相串账。
   * 这里传 realName，与收款时写入 payments.operator 的口径一致
   * （cashier 收款用 `user.realName ?? user.username`）。
   */
  const preview = openShift
    ? await previewShiftSummary(hotelId, openShift.start_at, user.realName)
    : null;
  const history = await listShifts(hotelId, 30);

  const expectCash = openShift && preview ? Number(openShift.opening_cash) + preview.cash : 0;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">交班汇总</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            当前收银员 {user.realName} · {openShift ? `${openShift.shift_name}进行中` : "尚未开班"}
          </p>
        </div>
        <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
          交班后自动汇总本班次收款，差额单独记录便于核对长短款
        </span>
      </div>

      {!openShift ? (
        /* ---------- 未开班：先开班 ---------- */
        <div className="card overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">
            开班
          </div>
          <OpenShiftForm />
        </div>
      ) : (
        /* ---------- 已开班：本班次汇总 ---------- */
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "开班时间", value: openShift.start_at.slice(11, 16), unit: "", sub: openShift.start_at.slice(0, 10) },
              { label: "备用金", value: fmtMoney(openShift.opening_cash), unit: "", sub: "开班时钱箱现金" },
              { label: "本班次现金收款", value: fmtMoney(preview?.cash ?? 0), unit: "", sub: "含退款抵扣" },
              { label: "应交现金", value: fmtMoney(expectCash), unit: "", sub: "备用金 + 现金收款" },
            ].map((k) => (
              <div key={k.label} className="rounded-[4px] border border-[#eee] bg-white p-[14px]">
                <div className="text-[12px] text-gray-500">{k.label}</div>
                <div className="mt-2 text-[20px] font-bold leading-none tabular-nums text-gray-900">{k.value}</div>
                <div className="mt-1.5 truncate text-[11px] text-gray-400">{k.sub}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            {/* 按支付方式汇总 */}
            <div className="card overflow-x-auto">
              <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">
                本班次收款（按方式）
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">支付方式</th>
                    <th className="th text-right">笔数</th>
                    <th className="th text-right">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview?.rows ?? []).length === 0 && (
                    <tr>
                      <td colSpan={3} className="td py-8 text-center text-gray-400">
                        本班次暂无收款
                      </td>
                    </tr>
                  )}
                  {(preview?.rows ?? []).map((r) => (
                    <tr key={r.method ?? "现金"}>
                      <td className="td">{PAY_LABEL[r.method ?? "现金"] ?? r.method ?? "现金"}</td>
                      <td className="td text-right tabular-nums">{r.cnt}</td>
                      <td className={`td text-right tabular-nums ${Number(r.total) < 0 ? "text-[#c0392b]" : ""}`}>
                        {fmtMoney(r.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 本班次业务量 */}
            <div className="card overflow-hidden">
              <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">
                本班次业务量
              </div>
              <div className="divide-y divide-gray-50">
                {[
                  ["办理入住", preview?.checkinCount ?? 0, "单"],
                  ["结账退房", preview?.checkoutCount ?? 0, "单"],
                  ["新建预订", preview?.newBookings ?? 0, "单"],
                  ["账务明细", preview?.itemCount ?? 0, "条"],
                ].map(([label, value, unit]) => (
                  <div key={String(label)} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-[12px] text-gray-600">{label}</span>
                    <span className="text-[13px] font-semibold tabular-nums text-gray-900">
                      {value} <span className="text-[11px] font-normal text-gray-400">{unit}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 交班表单 */}
          <div className="card overflow-hidden">
            <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">
              交班
            </div>
            <CloseShiftForm expectCash={expectCash} />
          </div>
        </>
      )}

      {/* 历史交班记录 */}
      <div className="card overflow-x-auto">
        <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">
          交班记录（最近 30 条）
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">班次</th>
                <th className="th">收银员</th>
                <th className="th">接班</th>
                <th className="th">开班</th>
                <th className="th">交班</th>
                <th className="th text-right">应交</th>
                <th className="th text-right">实交</th>
                <th className="th text-right">差额</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={10} className="td py-10 text-center text-gray-400">
                    还没有交班记录
                  </td>
                </tr>
              )}
              {history.map((s) => {
                const diff = Number(s.diff ?? 0);
                const diffCls = Math.abs(diff) < 0.01 ? "text-gray-500" : diff > 0 ? "text-[#b07d2e]" : "text-[#c0392b]";
                return (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="td tabular-nums">{s.biz_date}</td>
                    <td className="td">{s.shift_name}</td>
                    <td className="td">{s.operator}</td>
                    <td className="td text-gray-600">{s.receiver ?? "-"}</td>
                    <td className="td tabular-nums text-gray-500">{s.start_at?.slice(11, 16) ?? "-"}</td>
                    <td className="td tabular-nums text-gray-500">{s.end_at?.slice(11, 16) ?? "-"}</td>
                    <td className="td text-right tabular-nums">{fmtMoney(s.expect_cash)}</td>
                    <td className="td text-right tabular-nums">{s.status === "CLOSED" ? fmtMoney(s.actual_cash) : "-"}</td>
                    <td className={`td text-right tabular-nums ${diffCls}`}>
                      {s.status === "CLOSED" ? (Math.abs(diff) < 0.01 ? "相符" : fmtMoney(diff)) : "-"}
                    </td>
                    <td className="td">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${
                          s.status === "OPEN"
                            ? "border-[#b7e0c4] bg-[#f1f9f3] text-[#1e8e3e]"
                            : "border-gray-200 bg-gray-100 text-gray-500"
                        }`}
                      >
                        {s.status === "OPEN" ? "进行中" : "已交班"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
