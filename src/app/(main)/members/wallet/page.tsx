import Link from "next/link";
import { ensureWalletSchema } from "@/lib/member-wallet";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { consumeWalletAction, rechargeWalletAction, refundWalletAction } from "./actions";
/* 第 5 轮 P2-1：退款加二次确认（预设金额改成只填值，不再点一下就退钱） */
import RefundForm from "./RefundForm";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

type MemberRow = {
  id: number;
  name: string;
  mobile: string | null;
  vip_level: number;
};

type TxRow = {
  id: number;
  type: string;
  amount: number;
  balance_after: number | null;
  note: string | null;
  operator: string | null;
  created_at: string | null;
};

type StatsRow = {
  total_recharge: number;
  total_consume: number;
  balance: number;
  member_count: number;
};

const TYPE_META: Record<string, { label: string; cls: string; positive: boolean }> = {
  RECHARGE: { label: "充值", cls: "border-emerald-200 bg-emerald-50 text-emerald-700", positive: true },
  CONSUME: { label: "消费", cls: "border-rose-200 bg-rose-50 text-rose-700", positive: false },
  REFUND: { label: "退款", cls: "border-amber-200 bg-amber-50 text-amber-700", positive: true },
};

const PAY_METHODS = ["现金", "微信", "支付宝", "银行卡"];
const PRESETS = [100, 500, 1000, 2000];

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

export default async function MemberWalletPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const guestId = Number(first(sp.guest)) || 0;

  ensureWalletSchema();

  const members = all<MemberRow>(
    `SELECT id, name, mobile, vip_level
       FROM guests
      WHERE hotel_id = ? AND vip_level > 0
      ORDER BY vip_level DESC, name`,
    [hotelId]
  );

  const selected = guestId ? members.find((m) => m.id === guestId) : undefined;

  const stats =
    get<StatsRow>(
      `SELECT
         COALESCE(SUM(CASE WHEN t.biz_type = 'RECHARGE' THEN t.amount ELSE 0 END), 0) AS total_recharge,
         COALESCE(SUM(CASE WHEN t.biz_type = 'CONSUME' THEN ABS(t.amount) ELSE 0 END), 0) AS total_consume,
         COALESCE(SUM(t.amount), 0) AS balance,
         (SELECT COUNT(*) FROM guests g WHERE g.hotel_id = ? AND g.vip_level > 0) AS member_count
       FROM member_wallet_ledger t
      WHERE t.hotel_id = ?`,
      [hotelId, hotelId]
    ) ?? { total_recharge: 0, total_consume: 0, balance: 0, member_count: members.length };

  const selectedBalance = selected
    ? round2(
        Number(
          get<{ balance: number }>(
            `SELECT COALESCE(SUM(amount), 0) AS balance
               FROM member_wallet_ledger
              WHERE hotel_id = ? AND member_id = ?`,
            [hotelId, selected.id]
          )?.balance ?? 0
        )
      )
    : 0;

  const txs: TxRow[] = selected
    ? all<TxRow>(
        `SELECT id, biz_type AS type, amount, balance_after, remark AS note, operator, created_at
           FROM member_wallet_ledger
          WHERE hotel_id = ? AND member_id = ?
          ORDER BY id DESC
          LIMIT 200`,
        [hotelId, selected.id]
      )
    : [];

  const cards = [
    { label: "总充值", value: fmtMoney(stats.total_recharge), sub: "全部会员累计充值", cls: "text-emerald-700" },
    { label: "总消费", value: fmtMoney(stats.total_consume), sub: "全部会员储值扣款", cls: "text-rose-600" },
    { label: "当前余额", value: fmtMoney(stats.balance), sub: "全店储值账户余额", cls: "text-gray-900" },
    { label: "会员数", value: String(stats.member_count), sub: "VIP1 及以上会员", cls: "text-blue-700" },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">会员储值</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            为会员办理充值、消费扣款与退款，流水按会员逐笔记录余额快照
          </p>
        </div>
        <Link href="/members" className="btn-default px-2.5 py-1 text-[12px]">
          返回会员列表
        </Link>
      </div>

      {ok && (
        <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{ok}</div>
      )}
      {err && (
        <div className="card border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">{err}</div>
      )}

      {/* 会员选择 */}
      <form method="get" className="card flex flex-wrap items-end gap-2 px-4 py-3">
        <div className="min-w-[220px] flex-1">
          <label className="label">选择会员</label>
          <select name="guest" className="input" defaultValue={selected?.id ?? ""}>
            <option value="">请选择会员（VIP1 及以上）</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.mobile ? ` · ${m.mobile}` : ""}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-primary px-3 py-1.5 text-[12px]">
          查询
        </button>
        <Link href="/members/wallet" className="btn-default px-2.5 py-1.5 text-[12px]">
          清空
        </Link>
      </form>

      {/* 当前余额大卡 + 统计 */}
      <div className="grid gap-3 lg:grid-cols-5">
        <div className="card p-4 lg:col-span-2">
          <div className="text-[12px] text-gray-500">当前会员余额</div>
          {selected ? (
            <>
              <div className="mt-1 text-[13px] font-medium text-gray-800">
                {selected.name}
                <span className="ml-2 text-[11px] font-normal text-gray-400">
                  {selected.mobile || "未登记手机号"}
                </span>
              </div>
              <div className="mt-2 text-[24px] font-semibold tabular-nums text-emerald-700">
                {fmtMoney(selectedBalance)}
              </div>
              <div className="mt-0.5 text-[11px] text-gray-400">余额 = 充值 + 退款 − 消费</div>
            </>
          ) : (
            <div className="mt-3 py-4 text-center text-[12px] text-gray-400">请先在上方选择一位会员</div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:col-span-3">
          {cards.map((c) => (
            <div key={c.label} className="card p-3">
              <div className="text-[11px] text-gray-500">{c.label}</div>
              <div className={`mt-1 text-[18px] font-semibold tabular-nums ${c.cls}`}>{c.value}</div>
              <div className="mt-0.5 text-[11px] text-gray-400">{c.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 三类操作表单 */}
      {!selected ? (
        <div className="card flex h-[120px] flex-col items-center justify-center gap-1.5 border-dashed text-gray-400">
          <div className="text-[13px] text-gray-500">尚未选择会员</div>
          <div className="text-[11px]">选择会员后，可在此办理充值、消费扣款与退款</div>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {/* 充值 */}
          <form action={rechargeWalletAction} className="card flex flex-col gap-2.5 p-4">
            <input type="hidden" name="guest_id" value={selected.id} />
            <div className="text-[13px] font-semibold text-gray-800">充值</div>
            <div>
              <label className="label">金额（元）</label>
              <input name="amount" type="number" min="0.01" step="0.01" className="input" placeholder="输入充值金额" />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PRESETS.map((v) => (
                  <button
                    key={v}
                    type="submit"
                    name="preset"
                    value={String(v)}
                    className="btn-default px-2 py-0.5 text-[11px]"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">支付方式</label>
              <select name="method" className="input" defaultValue="现金">
                {PAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">备注</label>
              <input name="note" className="input" placeholder="可空，如：前台充值" />
            </div>
            <button className="btn-primary mt-1">确认充值</button>
          </form>

          {/* 消费 */}
          <form action={consumeWalletAction} className="card flex flex-col gap-2.5 p-4">
            <input type="hidden" name="guest_id" value={selected.id} />
            <div className="text-[13px] font-semibold text-gray-800">消费扣款</div>
            <div>
              <label className="label">金额（元）</label>
              <input name="amount" type="number" min="0.01" step="0.01" className="input" placeholder="输入消费金额" />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PRESETS.map((v) => (
                  <button
                    key={v}
                    type="submit"
                    name="preset"
                    value={String(v)}
                    className="btn-default px-2 py-0.5 text-[11px]"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">备注</label>
              <input name="note" className="input" placeholder="可空，如：房费挂账储值" />
            </div>
            <div className="text-[11px] text-gray-400">余额不足时将拒绝扣款，当前余额 {fmtMoney(selectedBalance)}</div>
            <button className="btn-danger mt-1">确认扣款</button>
          </form>

          {/*
            退款：换成客户端组件 RefundForm
            原因（codex 第 5 轮清单 P2-1）：
              · 原来没有任何二次确认，点「确认退款」直接退钱
              · 预设金额按钮是 type="submit"，点 100/500 就直接提交退款
            现在预设只填值，提交走 ConfirmForm（显示会员姓名+金额+退款后余额+原因必填）。
          */}
          <RefundForm
            guestId={selected.id}
            guestName={selected.name}
            balance={selectedBalance}
            action={refundWalletAction}
          />
        </div>
      )}

      {/* 流水表格 */}
      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">储值流水</span>
          <span className="text-[11px] text-gray-400">
            {selected ? `${selected.name} · 最近 ${txs.length} 笔` : "选择会员后展示流水"}
          </span>
        </div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">时间</th>
              <th className="th">类型</th>
              <th className="th text-right">金额</th>
              <th className="th text-right">余额</th>
              <th className="th">备注</th>
              <th className="th">操作人</th>
            </tr>
          </thead>
          <tbody>
            {txs.length === 0 && (
              <tr>
                <td colSpan={6} className="td py-10 text-center text-gray-400">
                  {selected ? "暂无储值流水，可在上方办理充值或消费" : "请先选择会员查看储值流水"}
                </td>
              </tr>
            )}
            {txs.map((t) => {
              const meta = TYPE_META[t.type] ?? {
                label: t.type,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
                positive: false,
              };
              const amountCls = meta.positive ? "text-emerald-600" : "text-rose-600";
              const signed = `${meta.positive ? "+" : "−"}${fmtMoney(t.amount)}`;
              return (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="td text-gray-600 tabular-nums">{fmtTime(t.created_at)}</td>
                  <td className="td">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td className={`td text-right font-medium tabular-nums ${amountCls}`}>{signed}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(t.balance_after)}</td>
                  <td className="td text-gray-600">{t.note || "—"}</td>
                  <td className="td text-gray-500">{t.operator || "系统"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
