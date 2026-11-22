import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { ensureIdVerifySchema, verifyIdAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type LogRow = {
  id: number;
  name: string | null;
  id_no: string | null;
  result: string | null;
  operator: string | null;
  created_at: string | null;
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** 证件号脱敏：保留前 6 位与后 4 位 */
function maskIdNo(idNo: string | null): string {
  if (!idNo) return "-";
  const s = idNo.trim();
  if (s.length < 10) return s;
  return `${s.slice(0, 6)}${"*".repeat(Math.max(4, s.length - 10))}${s.slice(-4)}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default async function IdVerifyPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;

  const ok = first(sp.msg);
  const err = first(sp.err);

  // 懒建表：id_verify_logs
  await ensureIdVerifySchema();

  const rows = all<LogRow>(
    `SELECT id, name, id_no, result, operator, created_at
       FROM id_verify_logs
      WHERE hotel_id = ?
      ORDER BY id DESC
      LIMIT 20`,
    [user.hotelId]
  );

  const passed = rows.filter((r) => (r.result ?? "").startsWith("校验通过")).length;
  const failed = rows.filter((r) => (r.result ?? "").startsWith("核验未通过")).length;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">人证核验</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            录入姓名与身份证号，校验格式与校验码，解析出生日期 / 性别 / 年龄，并比对客史档案
          </p>
        </div>
        <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
          最近 20 条：通过 {passed} · 未通过 {failed}
        </span>
      </div>

      {ok && <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{ok}</div>}
      {err && <div className="card border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">{err}</div>}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">核验录入</div>
          <form action={verifyIdAction} className="grid gap-3 px-4 py-3 md:grid-cols-2">
            <div>
              <label className="label">客人姓名 *</label>
              <input name="name" required maxLength={30} placeholder="与证件一致" className="input" />
            </div>
            <div>
              <label className="label">身份证号 *</label>
              <input
                name="id_no"
                required
                maxLength={18}
                placeholder="18 位身份证号，末位可为 X"
                autoComplete="off"
                className="input tabular-nums"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <button className="btn-primary">开始核验</button>
              <span className="text-[11px] text-gray-400">核验结果会写入核验日志，未通过同样留痕</span>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="border-b border-gray-100 px-4 py-2.5 text-[13px] font-semibold text-gray-800">校验规则</div>
          <ul className="space-y-1.5 px-4 py-3 text-[11px] leading-relaxed text-gray-500">
            <li>· 长度必须为 18 位，前 17 位为数字，末位为数字或 X</li>
            <li>· 校验码按 GB 11643 加权因子求和后对 11 取模比对</li>
            <li>· 第 7-14 位为出生日期，必须真实存在且不晚于今天</li>
            <li>· 第 17 位奇数为男、偶数为女，按生日计算周岁</li>
            <li>· 与客史表比对：优先按证件号命中，其次按同名匹配</li>
            <li>· 本页只做格式与客史比对，不做公安部联网核验</li>
          </ul>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">最近核验记录 · {rows.length} 条</span>
          <span className="text-[11px] text-gray-400">证件号已脱敏显示</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">时间</th>
                <th className="th">姓名</th>
                <th className="th">证件号</th>
                <th className="th">核验结果</th>
                <th className="th">操作人</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="td py-10 text-center text-gray-400">
                    暂无核验记录，使用上方表单完成首次人证核验
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const pass = (r.result ?? "").startsWith("校验通过");
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="td whitespace-nowrap text-gray-500">{fmtTime(r.created_at)}</td>
                    <td className="td font-medium text-gray-800">{r.name ?? "-"}</td>
                    <td className="td tabular-nums text-gray-600">{maskIdNo(r.id_no)}</td>
                    <td className="td whitespace-normal">
                      <span
                        className={`mr-1.5 rounded px-1.5 py-0.5 text-[11px] ${
                          pass ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                        }`}
                      >
                        {pass ? "通过" : "未通过"}
                      </span>
                      <span className="text-[12px] text-gray-600">{r.result ?? "-"}</span>
                    </td>
                    <td className="td text-gray-500">{r.operator ?? "-"}</td>
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
