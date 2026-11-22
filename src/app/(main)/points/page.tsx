import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, todayStr } from "@/lib/utils";
import {
  adjustPointsAction,
  createScoreCodeAction,
  createScoreGoodsAction,
  ensurePointsSchema,
  redeemPointsAction,
  toggleScoreCodeAction,
  toggleScoreGoodsAction,
} from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type TabKey = "rules" | "goods" | "records" | "redeem";

type GuestRow = {
  id: number;
  name: string;
  mobile: string | null;
  vip_level: number;
};

type CodeRow = {
  id: number;
  code: string;
  name: string;
  ratio: number;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
};

type GoodsRow = {
  id: number;
  name: string;
  points: number;
  stock: number;
  status: string;
  note: string | null;
};

type RecordRow = {
  id: number;
  guest_id: number;
  guest_name: string;
  type: string;
  points: number;
  balance_after: number | null;
  note: string | null;
  operator: string | null;
  created_at: string | null;
};

type StatsRow = {
  member_count: number;
  total_earn: number;
  total_spend: number;
  pool: number;
};

const TABS: { key: TabKey; label: string }[] = [
  { key: "rules", label: "积分规则" },
  { key: "goods", label: "积分商品" },
  { key: "records", label: "积分明细" },
  { key: "redeem", label: "兑换记录" },
];

const TYPE_META: Record<string, { label: string; cls: string }> = {
  EARN: { label: "获得", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  SPEND: { label: "兑换", cls: "border-rose-200 bg-rose-50 text-rose-700" },
  ADJUST: { label: "调整", cls: "border-amber-200 bg-amber-50 text-amber-700" },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "生效中", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  INACTIVE: { label: "已停用", cls: "border-gray-200 bg-gray-50 text-gray-500" },
};

const GOODS_STATUS_META: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "在售", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  INACTIVE: { label: "已下架", cls: "border-gray-200 bg-gray-50 text-gray-500" },
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function fmtPoints(n: number | null | undefined): string {
  return Math.trunc(Number(n ?? 0)).toLocaleString("zh-CN");
}

/** 分值带符号：+120 / −300 */
function signedPoints(n: number): string {
  const v = Math.trunc(Number(n ?? 0));
  if (v > 0) return `+${fmtPoints(v)}`;
  if (v < 0) return `−${fmtPoints(Math.abs(v))}`;
  return "0";
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

/** 日期只取 yyyy-mm-dd，空值显示破折号 */
function dayText(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

export default async function PointsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  const msg = first(sp.msg);
  const err = first(sp.err);
  const guestId = Number(first(sp.guest)) || 0;
  const goodsParam = Number(first(sp.goods)) || 0;
  const tabParam = first(sp.tab);
  const activeTab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "rules";

  // 懒建表 + 首次种子（积分规则 / 积分商品 / 积分明细）
  await ensurePointsSchema(hotelId);

  const members = all<GuestRow>(
    `SELECT id, name, mobile, vip_level
       FROM guests
      WHERE hotel_id = ? AND vip_level > 0
      ORDER BY vip_level DESC, name`,
    [hotelId]
  );
  const selectedMember = guestId ? members.find((m) => m.id === guestId) : undefined;

  const codes = all<CodeRow>(
    `SELECT id, code, name, ratio, valid_from, valid_to, status
       FROM score_codes
      WHERE hotel_id = ?
      ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, id`,
    [hotelId]
  );

  const goods = all<GoodsRow>(
    `SELECT id, name, points, stock, status, note
       FROM score_goods
      WHERE hotel_id = ?
      ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, points, id`,
    [hotelId]
  );
  const redeemable = goods.filter((g) => g.status === "ACTIVE" && Number(g.stock) > 0);

  const stats =
    get<StatsRow>(
      `SELECT
         (SELECT COUNT(*) FROM guests g WHERE g.hotel_id = ? AND g.vip_level > 0) AS member_count,
         COALESCE(SUM(CASE WHEN type = 'EARN' THEN points ELSE 0 END), 0) AS total_earn,
         COALESCE(SUM(CASE WHEN type = 'SPEND' THEN -points ELSE 0 END), 0) AS total_spend,
         COALESCE(SUM(points), 0) AS pool
       FROM score_records
      WHERE hotel_id = ?`,
      [hotelId, hotelId]
    ) ?? { member_count: members.length, total_earn: 0, total_spend: 0, pool: 0 };

  // 各会员当前积分：score_records 累计
  const balanceRows = all<{ guest_id: number; balance: number }>(
    `SELECT guest_id, COALESCE(SUM(points), 0) AS balance
       FROM score_records
      WHERE hotel_id = ?
      GROUP BY guest_id`,
    [hotelId]
  );
  const balanceMap = new Map<number, number>(
    balanceRows.map((r) => [Number(r.guest_id), Math.trunc(Number(r.balance ?? 0))] as const)
  );

  const records = all<RecordRow>(
    `SELECT id, guest_id, guest_name, type, points, balance_after, note, operator, created_at
       FROM score_records
      WHERE hotel_id = ?${selectedMember ? " AND guest_id = ?" : ""}
      ORDER BY id DESC
      LIMIT 200`,
    selectedMember ? [hotelId, selectedMember.id] : [hotelId]
  );

  const redeemRecords = all<RecordRow>(
    `SELECT id, guest_id, guest_name, type, points, balance_after, note, operator, created_at
       FROM score_records
      WHERE hotel_id = ? AND type = 'SPEND'
      ORDER BY id DESC
      LIMIT 200`,
    [hotelId]
  );

  const tabCounts: Record<TabKey, number> = {
    rules: codes.length,
    goods: goods.length,
    records: records.length,
    redeem: redeemRecords.length,
  };

  const tabHref = (tab: TabKey) => `/points?tab=${tab}`;
  const currentHref = tabHref(activeTab);
  const defaultFrom = todayStr();
  const defaultTo = todayStr(addDays(new Date(), 365));

  const cards = [
    { label: "会员总数", value: fmtPoints(stats.member_count), sub: "VIP1 及以上会员", cls: "text-gray-900" },
    { label: "累计发放积分", value: fmtPoints(stats.total_earn), sub: "全部 EARN 流水合计", cls: "text-emerald-700" },
    { label: "累计兑换积分", value: fmtPoints(stats.total_spend), sub: "全部 SPEND 流水合计", cls: "text-rose-600" },
    { label: "当前积分池", value: fmtPoints(stats.pool), sub: "未使用积分余额合计", cls: "text-brand-700" },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">会员积分</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            积分代码、积分商品、积分明细与兑换流水 · 余额按明细逐笔累计
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/members" className="btn-default px-2.5 py-1 text-[12px]">
            会员管理
          </Link>
          <Link href="/members/wallet" className="btn-default px-2.5 py-1 text-[12px]">
            会员储值
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-3">
            <div className="text-[11px] text-gray-500">{c.label}</div>
            <div className={`mt-1 text-[18px] font-semibold tabular-nums ${c.cls}`}>{c.value}</div>
            <div className="mt-0.5 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      <nav className="card flex flex-wrap items-center gap-x-1 px-2 pt-1 pb-0">
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          const count = tabCounts[tab.key];
          return (
            <Link
              key={tab.key}
              href={tabHref(tab.key)}
              className={`flex items-center border-b-2 px-2 pt-1 pb-[6px] text-[13px] transition-colors ${
                active ? "border-brand-500 font-medium text-gray-900" : "border-transparent text-gray-500 hover:text-gray-900"
              }`}
            >
              {tab.label}
              <span
                className={`ml-1 rounded px-1 text-[11px] leading-[15px] tabular-nums ${
                  active ? "bg-brand-50 text-brand-700" : "bg-gray-100 text-gray-500"
                }`}
              >
                {count}
              </span>
            </Link>
          );
        })}
        <span className="ml-auto pr-1 pb-[6px] text-[11px] text-gray-400">
          {members.length > 0 ? `可参与积分会员 ${members.length} 位` : "暂无会员，请先在会员管理中建档"}
        </span>
      </nav>

      {msg && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-emerald-500 px-4 py-2.5">
          <span className="text-[12px] text-emerald-700">{msg}</span>
          <Link href={currentHref} className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}
      {err && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-rose-500 px-4 py-2.5">
          <span className="text-[12px] text-rose-600">{err}</span>
          <Link href={currentHref} className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}

      {/* ------------------------------ Tab 1 积分规则 ------------------------------ */}
      {activeTab === "rules" && (
        <div className="space-y-3">
          <details className="card" open>
            <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-brand-700">
              + 新增积分规则
            </summary>
            <form action={createScoreCodeAction} className="grid gap-3 border-t border-gray-100 px-4 py-3 md:grid-cols-6">
              <div>
                <label className="label">规则代码 *</label>
                <input name="code" required className="input" placeholder="如 STAY-1X" />
              </div>
              <div className="md:col-span-2">
                <label className="label">规则名称 *</label>
                <input name="name" required className="input" placeholder="如 住店消费 1:1" />
              </div>
              <div>
                <label className="label">积分配比 *</label>
                <input
                  name="ratio"
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  defaultValue="1"
                  className="input"
                  placeholder="每消费 1 元积多少分"
                />
              </div>
              <div>
                <label className="label">有效期从</label>
                <input name="valid_from" type="date" defaultValue={defaultFrom} className="input" />
              </div>
              <div>
                <label className="label">有效期至</label>
                <input name="valid_to" type="date" defaultValue={defaultTo} className="input" />
              </div>
              <div className="md:col-span-6 flex items-center gap-2">
                <button className="btn-primary">保存规则</button>
                <span className="text-[11px] text-gray-400">
                  积分配比 = 每消费 1 元累计多少分（如 2 表示 1 元 = 2 分）；代码不可重复
                </span>
              </div>
            </form>
          </details>

          <div className="card overflow-x-auto">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">积分规则</span>
              <span className="text-[11px] text-gray-400">共 {codes.length} 条 · 停用后不再累计积分</span>
            </div>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">规则代码</th>
                  <th className="th">规则名称</th>
                  <th className="th text-right">积分配比</th>
                  <th className="th">有效期</th>
                  <th className="th">状态</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {codes.length === 0 && (
                  <tr>
                    <td colSpan={6} className="td py-10 text-center text-gray-400">
                      暂无积分规则，可在上方「新增积分规则」中录入
                    </td>
                  </tr>
                )}
                {codes.map((c) => {
                  const meta = STATUS_META[c.status] ?? STATUS_META.ACTIVE;
                  return (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="td font-medium text-gray-800">{c.code}</td>
                      <td className="td text-gray-700">{c.name}</td>
                      <td className="td text-right tabular-nums text-brand-700">
                        1 元 = {Number(c.ratio ?? 0)} 分
                      </td>
                      <td className="td text-gray-500 tabular-nums">
                        {dayText(c.valid_from)} ~ {dayText(c.valid_to)}
                      </td>
                      <td className="td">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="td text-right">
                        <form action={toggleScoreCodeAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="tab" value="rules" />
                          <button className="text-[12px] text-brand-600 hover:underline">
                            {c.status === "ACTIVE" ? "停用" : "启用"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            本模块按「去呼呼」积分代码方式管理规则：代码用于标识积分来源（住店 / 餐饮 / 其他），比例决定每元累计分值。
          </p>
        </div>
      )}

      {/* ------------------------------ Tab 2 积分商品 ------------------------------ */}
      {activeTab === "goods" && (
        <div className="space-y-3">
          <details className="card" open>
            <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-brand-700">
              + 新增积分商品
            </summary>
            <form action={createScoreGoodsAction} className="grid gap-3 border-t border-gray-100 px-4 py-3 md:grid-cols-6">
              <div className="md:col-span-2">
                <label className="label">商品名称 *</label>
                <input name="name" required className="input" placeholder="如 免费早餐" />
              </div>
              <div>
                <label className="label">所需积分 *</label>
                <input name="points" type="number" min="1" step="1" className="input" placeholder="如 500" />
              </div>
              <div>
                <label className="label">库存</label>
                <input name="stock" type="number" min="0" step="1" defaultValue="10" className="input" placeholder="如 50" />
              </div>
              <div className="md:col-span-2">
                <label className="label">备注</label>
                <input name="note" className="input" placeholder="可空，如使用说明" />
              </div>
              <div className="md:col-span-6 flex items-center gap-2">
                <button className="btn-primary">保存商品</button>
                <span className="text-[11px] text-gray-400">新增后默认在售，可随时下架；同店商品名称不可重复</span>
              </div>
            </form>
          </details>

          <div className="card overflow-x-auto">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">积分商品</span>
              <span className="text-[11px] text-gray-400">
                共 {goods.length} 个 · 在售 {goods.filter((g) => g.status === "ACTIVE").length} 个
              </span>
            </div>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">商品名称</th>
                  <th className="th text-right">所需积分</th>
                  <th className="th text-right">库存</th>
                  <th className="th">状态</th>
                  <th className="th">备注</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {goods.length === 0 && (
                  <tr>
                    <td colSpan={6} className="td py-10 text-center text-gray-400">
                      暂无积分商品，可在上方「新增积分商品」中录入
                    </td>
                  </tr>
                )}
                {goods.map((g) => {
                  const meta = GOODS_STATUS_META[g.status] ?? GOODS_STATUS_META.ACTIVE;
                  const stock = Math.trunc(Number(g.stock ?? 0));
                  return (
                    <tr key={g.id} className="hover:bg-gray-50">
                      <td className="td font-medium text-gray-800">{g.name}</td>
                      <td className="td text-right tabular-nums text-brand-700">{fmtPoints(g.points)} 分</td>
                      <td className={`td text-right tabular-nums ${stock <= 0 ? "text-rose-600" : "text-gray-700"}`}>
                        {stock <= 0 ? "已兑完" : `${fmtPoints(stock)} 件`}
                      </td>
                      <td className="td">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="td max-w-[260px] truncate text-gray-500" title={g.note ?? ""}>
                        {g.note || "—"}
                      </td>
                      <td className="td text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/points?tab=redeem&goods=${g.id}${guestId ? `&guest=${guestId}` : ""}`}
                            className="text-[12px] text-gray-400 hover:text-brand-600"
                          >
                            去兑换
                          </Link>
                          <form action={toggleScoreGoodsAction}>
                            <input type="hidden" name="id" value={g.id} />
                            <input type="hidden" name="tab" value="goods" />
                            <button className="text-[12px] text-brand-600 hover:underline">
                              {g.status === "ACTIVE" ? "下架" : "上架"}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------ Tab 3 积分明细 ------------------------------ */}
      {activeTab === "records" && (
        <div className="space-y-3">
          <form method="get" className="card flex flex-wrap items-end gap-2 px-4 py-3">
            <input type="hidden" name="tab" value="records" />
            <div className="min-w-[240px] flex-1">
              <label className="label">按会员筛选</label>
              <select name="guest" className="input" defaultValue={guestId ? String(guestId) : ""}>
                <option value="">全部会员积分明细</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.mobile ? ` · ${m.mobile}` : ""}（{fmtPoints(balanceMap.get(m.id) ?? 0)} 分）
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-primary px-3 py-1.5 text-[12px]">
              查询
            </button>
            <Link href="/points?tab=records" className="btn-default px-2.5 py-1.5 text-[12px]">
              清空
            </Link>
            <span className="ml-auto text-[11px] text-gray-400">
              {selectedMember
                ? `${selectedMember.name} 当前积分 ${fmtPoints(balanceMap.get(selectedMember.id) ?? 0)} 分`
                : "当前显示全部会员的积分流水"}
            </span>
          </form>

          <details className="card" open>
            <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-brand-700">
              + 手工调整积分
            </summary>
            <form action={adjustPointsAction} className="grid gap-3 border-t border-gray-100 px-4 py-3 md:grid-cols-6">
              <div className="md:col-span-2">
                <label className="label">会员 *</label>
                <select name="guest_id" className="input" required defaultValue={guestId ? String(guestId) : ""}>
                  <option value="">请选择会员</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.mobile ? ` · ${m.mobile}` : ""}（{fmtPoints(balanceMap.get(m.id) ?? 0)} 分）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">调整方向</label>
                <select name="direction" className="input" defaultValue="+">
                  <option value="+">增加积分 (+)</option>
                  <option value="-">扣减积分 (−)</option>
                </select>
              </div>
              <div>
                <label className="label">分值 *</label>
                <input name="amount" type="number" min="1" step="1" required className="input" placeholder="如 200" />
              </div>
              <div className="md:col-span-2">
                <label className="label">备注</label>
                <input name="note" className="input" placeholder="如 投诉补偿 / 活动赠送" />
              </div>
              <div className="md:col-span-6 flex items-center gap-2">
                <button className="btn-primary">确认调整</button>
                <span className="text-[11px] text-gray-400">
                  调整以 ADJUST 类型写入积分明细，扣减不允许把会员余额调成负数
                </span>
              </div>
            </form>
          </details>

          <div className="card overflow-x-auto">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">积分明细</span>
              <span className="text-[11px] text-gray-400">
                {selectedMember ? `${selectedMember.name} · 最近 ${records.length} 笔` : `全部会员 · 最近 ${records.length} 笔`}
              </span>
            </div>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">会员卡号</th>
                  <th className="th">姓名</th>
                  <th className="th">手机号</th>
                  <th className="th">交易门店</th>
                  <th className="th">订单号</th>
                  <th className="th">房间信息</th>
                  <th className="th text-right">积分变化</th>
                  <th className="th">操作类型</th>
                  <th className="th">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && (
                  <tr>
                    <td colSpan={9} className="td py-10 text-center text-gray-400">
                      <span className="text-[#f0a020]">⚠</span> 暂无数据
                    </td>
                  </tr>
                )}
                {records.map((r) => {
                  const meta = TYPE_META[r.type] ?? { label: r.type, cls: "border-gray-200 bg-gray-50 text-gray-600" };
                  const value = Math.trunc(Number(r.points ?? 0));
                  const valueCls = value >= 0 ? "text-emerald-600" : "text-rose-600";
                  return (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="td tabular-nums text-gray-600">M{String(r.guest_id ?? 0).padStart(8, "0")}</td>
                      <td className="td font-medium text-gray-800">
                        <Link href={`/points?tab=records&guest=${r.guest_id}`} className="hover:text-brand-600">
                          {r.guest_name}
                        </Link>
                      </td>
                      <td className="td tabular-nums text-gray-500">—</td>
                      <td className="td text-gray-600">云栖国际酒店</td>
                      <td className="td tabular-nums text-gray-500">{r.id ? `R${String(r.id).padStart(6, "0")}` : "—"}</td>
                      <td className="td text-gray-500">{r.note || "—"}</td>
                      <td className={`td text-right font-medium tabular-nums ${valueCls}`}>{signedPoints(value)}</td>
                      <td className="td">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="td text-gray-500">{r.operator || "系统"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------ Tab 4 兑换记录 ------------------------------ */}
      {activeTab === "redeem" && (
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-3">
            <form action={redeemPointsAction} className="card flex flex-col gap-2.5 p-4 lg:col-span-1">
              <div className="text-[13px] font-semibold text-gray-800">积分兑换</div>
              <div>
                <label className="label">选择会员 *</label>
                <select name="guest_id" className="input" required defaultValue={guestId ? String(guestId) : ""}>
                  <option value="">请选择会员（VIP1 及以上）</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.mobile ? ` · ${m.mobile}` : ""}（{fmtPoints(balanceMap.get(m.id) ?? 0)} 分）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">选择积分商品 *</label>
                <select name="goods_id" className="input" required defaultValue={goodsParam ? String(goodsParam) : ""}>
                  <option value="">请选择在售商品</option>
                  {redeemable.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} · {fmtPoints(g.points)} 分（库存 {fmtPoints(g.stock)}）
                    </option>
                  ))}
                </select>
                {redeemable.length === 0 && (
                  <div className="mt-1 text-[11px] text-rose-600">暂无在售且有库存的积分商品，请先在「积分商品」中上架</div>
                )}
              </div>
              <div className="rounded border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-500">
                兑换将校验会员积分是否充足，成功后扣减积分并减少 1 件商品库存，流水以 SPEND 类型记入积分明细。
              </div>
              <button className="btn-primary mt-1">确认兑换</button>
            </form>

            <div className="card overflow-x-auto lg:col-span-2">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <span className="text-[13px] font-semibold text-gray-800">兑换记录</span>
                <span className="text-[11px] text-gray-400">最近 {redeemRecords.length} 笔 SPEND 流水</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">时间</th>
                    <th className="th">会员</th>
                    <th className="th">兑换商品</th>
                    <th className="th text-right">扣减积分</th>
                    <th className="th text-right">余额</th>
                    <th className="th">操作人</th>
                  </tr>
                </thead>
                <tbody>
                  {redeemRecords.length === 0 && (
                    <tr>
                      <td colSpan={6} className="td py-10 text-center text-gray-400">
                        暂无兑换记录，可在左侧为会员办理积分兑换
                      </td>
                    </tr>
                  )}
                  {redeemRecords.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="td text-gray-600 tabular-nums">{fmtTime(r.created_at)}</td>
                      <td className="td">
                        <Link href={`/points?tab=records&guest=${r.guest_id}`} className="text-gray-800 hover:text-brand-600">
                          {r.guest_name}
                        </Link>
                      </td>
                      <td className="td text-gray-600">{(r.note ?? "").replace(/^兑换：/, "") || "—"}</td>
                      <td className="td text-right font-medium tabular-nums text-rose-600">
                        −{fmtPoints(Math.abs(Math.trunc(Number(r.points ?? 0))))}
                      </td>
                      <td className="td text-right tabular-nums text-gray-700">{fmtPoints(r.balance_after)}</td>
                      <td className="td text-gray-500">{r.operator || "系统"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[11px] text-gray-400">
            兑换记录即积分明细中 type = SPEND 的流水；下架或库存为 0 的积分商品不会出现在兑换下拉中。
          </p>
        </div>
      )}
    </div>
  );
}
