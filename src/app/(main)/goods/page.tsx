import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, todayStr } from "@/lib/utils";
import {
  createCategoryAction,
  ensureGoodsSchema,
  purchaseAction,
  rejectAction,
  returnAction,
  saveGoodsAction,
  toggleGoodsStatusAction,
} from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type TabKey = "goods" | "stock" | "flows" | "report";

type FlowType = "PURCHASE" | "RETURN" | "REJECT" | "SELL";

type CategoryRow = { id: number; name: string; sort: number; status: string };

type GoodsRow = {
  id: number;
  category_id: number | null;
  name: string;
  barcode: string | null;
  unit: string;
  cost_price: number;
  sell_price: number;
  stock: number;
  warn_stock: number;
  status: string;
  category_name: string | null;
};

type FlowRow = {
  id: number;
  goods_id: number;
  goods_name: string | null;
  unit: string | null;
  type: string;
  qty: number;
  stock_after: number;
  unit_price: number;
  amount: number;
  note: string | null;
  operator: string | null;
  created_at: string | null;
};

type StatsRow = {
  goods_count: number;
  on_sale: number;
  stock_qty: number;
  cost_value: number;
  sell_value: number;
  low_count: number;
};

type CategoryAgg = {
  id: number;
  name: string;
  goods_count: number;
  stock_qty: number;
  cost_value: number;
  sell_value: number;
};

const TABS: { key: TabKey; label: string }[] = [
  { key: "goods", label: "商品列表" },
  { key: "stock", label: "库存操作" },
  { key: "flows", label: "明细查询" },
  { key: "report", label: "库存报表" },
];

const FLOW_KEYS: FlowType[] = ["PURCHASE", "RETURN", "REJECT", "SELL"];

const FLOW_META: Record<FlowType, { label: string; cls: string }> = {
  PURCHASE: { label: "进货", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  RETURN: { label: "退货", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  REJECT: { label: "报废", cls: "border-rose-200 bg-rose-50 text-rose-700" },
  SELL: { label: "销售", cls: "border-blue-200 bg-blue-50 text-blue-700" },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  ON: { label: "在售", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  OFF: { label: "已下架", cls: "border-gray-200 bg-gray-100 text-gray-500" },
};

/** 库存操作三张表单（进货 / 退货 / 报废） */
const MOVE_FORMS: {
  type: FlowType;
  title: string;
  desc: string;
  action: (formData: FormData) => Promise<void>;
  submit: string;
  btn: string;
}[] = [
  {
    type: "PURCHASE",
    title: "进货",
    desc: "入库增加库存，写入进货流水；填写的单价会同步为商品最新成本价",
    action: purchaseAction,
    submit: "确认进货",
    btn: "btn-primary",
  },
  {
    type: "RETURN",
    title: "退货",
    desc: "商品退回供应商，扣减库存，单价默认按成本价计算退货金额",
    action: returnAction,
    submit: "确认退货",
    btn: "btn-default",
  },
  {
    type: "REJECT",
    title: "报废",
    desc: "破损 / 过期报损，扣减库存，报损金额按成本价计入",
    action: rejectAction,
    submit: "确认报废",
    btn: "btn-danger",
  },
];

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/** 数量带符号：+24 / −6 */
function signedQty(n: number): string {
  const v = Math.trunc(Number(n ?? 0));
  if (v > 0) return `+${v}`;
  if (v < 0) return `-${Math.abs(v)}`;
  return "0";
}

function flowMeta(type: string) {
  return FLOW_META[type as FlowType] ?? { label: type || "其他", cls: "border-gray-200 bg-gray-50 text-gray-600" };
}

export default async function GoodsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const sp = await searchParams;

  // 懒建表 + 首次种子（4 个类别 / 12 个商品 / 每商品 8 条流水）
  await ensureGoodsSchema(hotelId);

  const msg = first(sp.msg);
  const err = first(sp.err);

  const tabParam = first(sp.tab);
  const activeTab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "goods";

  const editId = Number(first(sp.edit)) || 0;
  const catFilter = Number(first(sp.cat)) || 0;
  const flowGoodsId = Number(first(sp.g)) || 0;
  const flowTypeParam = first(sp.t);
  const flowType: FlowType | "" = FLOW_KEYS.find((k) => k === flowTypeParam) ?? "";

  const tabHref = (tab: TabKey) => `/goods?tab=${tab}`;

  /* ------------------------------ 商品 / 类别 ------------------------------ */

  const categories = all<CategoryRow>(
    `SELECT id, name, sort, status FROM goods_categories WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );

  const goodsAll = all<GoodsRow>(
    `SELECT g.id, g.category_id, g.name, g.barcode, g.unit, g.cost_price, g.sell_price,
            g.stock, g.warn_stock, g.status, c.name AS category_name
       FROM goods g
       LEFT JOIN goods_categories c ON c.id = g.category_id AND c.hotel_id = g.hotel_id
      WHERE g.hotel_id = ?
      ORDER BY CASE WHEN g.status = 'ON' THEN 0 ELSE 1 END, COALESCE(c.sort, 99), g.name, g.id`,
    [hotelId]
  );

  const goods = catFilter ? goodsAll.filter((g) => g.category_id === catFilter) : goodsAll;
  const editing = editId ? goodsAll.find((g) => g.id === editId) : undefined;
  const activeCategory = catFilter ? categories.find((c) => c.id === catFilter) : undefined;

  const catGoodsCount = new Map<number, number>();
  for (const g of goodsAll) {
    if (g.category_id) catGoodsCount.set(g.category_id, (catGoodsCount.get(g.category_id) ?? 0) + 1);
  }
  const uncategorizedCount = goodsAll.filter((g) => !g.category_id).length;

  const filteredCost = goods.reduce((s, g) => s + Number(g.cost_price ?? 0) * Number(g.stock ?? 0), 0);

  /* ------------------------------ 库存统计 ------------------------------ */

  const stats =
    get<StatsRow>(
      `SELECT
         (SELECT COUNT(*) FROM goods WHERE hotel_id = ?) AS goods_count,
         (SELECT COUNT(*) FROM goods WHERE hotel_id = ? AND status = 'ON') AS on_sale,
         (SELECT COALESCE(SUM(stock), 0) FROM goods WHERE hotel_id = ?) AS stock_qty,
         (SELECT COALESCE(SUM(cost_price * stock), 0) FROM goods WHERE hotel_id = ?) AS cost_value,
         (SELECT COALESCE(SUM(sell_price * stock), 0) FROM goods WHERE hotel_id = ?) AS sell_value,
         (SELECT COUNT(*) FROM goods WHERE hotel_id = ? AND stock <= warn_stock) AS low_count`,
      [hotelId, hotelId, hotelId, hotelId, hotelId, hotelId]
    ) ?? { goods_count: 0, on_sale: 0, stock_qty: 0, cost_value: 0, sell_value: 0, low_count: 0 };

  const flowsTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM goods_flows WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  const todayFlows =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM goods_flows WHERE hotel_id = ? AND substr(created_at, 1, 10) = ?`,
      [hotelId, today]
    )?.n ?? 0;

  /* ------------------------------ 流水查询 ------------------------------ */

  const flowConds: string[] = [];
  const flowParams: unknown[] = [hotelId];
  if (flowGoodsId) {
    flowConds.push("f.goods_id = ?");
    flowParams.push(flowGoodsId);
  }
  if (flowType) {
    flowConds.push("f.type = ?");
    flowParams.push(flowType);
  }

  const flows = all<FlowRow>(
    `SELECT f.id, f.goods_id, g.name AS goods_name, g.unit, f.type, f.qty, f.stock_after,
            f.unit_price, f.amount, f.note, f.operator, f.created_at
       FROM goods_flows f
       LEFT JOIN goods g ON g.id = f.goods_id
      WHERE f.hotel_id = ?${flowConds.map((c) => ` AND ${c}`).join("")}
      ORDER BY f.id DESC
      LIMIT 300`,
    flowParams
  );

  const recentFlows = all<FlowRow>(
    `SELECT f.id, f.goods_id, g.name AS goods_name, g.unit, f.type, f.qty, f.stock_after,
            f.unit_price, f.amount, f.note, f.operator, f.created_at
       FROM goods_flows f
       LEFT JOIN goods g ON g.id = f.goods_id
      WHERE f.hotel_id = ?
      ORDER BY f.id DESC
      LIMIT 10`,
    [hotelId]
  );

  const flowIn = flows.filter((f) => Number(f.qty) > 0).reduce((s, f) => s + Number(f.qty ?? 0), 0);
  const flowOut = flows.filter((f) => Number(f.qty) < 0).reduce((s, f) => s + Math.abs(Number(f.qty ?? 0)), 0);
  const flowAmount = flows.reduce((s, f) => s + Number(f.amount ?? 0), 0);

  const flowsHref = (opts: { g?: number; t?: string }) => {
    const qs = new URLSearchParams({ tab: "flows" });
    const g = opts.g ?? flowGoodsId;
    const t = opts.t ?? flowType;
    if (g) qs.set("g", String(g));
    if (t) qs.set("t", t);
    return `/goods?${qs.toString()}`;
  };

  /* ------------------------------ 报表数据 ------------------------------ */

  const lowGoods = all<GoodsRow>(
    `SELECT g.id, g.category_id, g.name, g.barcode, g.unit, g.cost_price, g.sell_price,
            g.stock, g.warn_stock, g.status, c.name AS category_name
       FROM goods g
       LEFT JOIN goods_categories c ON c.id = g.category_id AND c.hotel_id = g.hotel_id
      WHERE g.hotel_id = ? AND g.stock <= g.warn_stock
      ORDER BY (g.warn_stock - g.stock) DESC, g.stock, g.id`,
    [hotelId]
  );

  const byCategory = all<CategoryAgg>(
    `SELECT c.id, c.name,
            COUNT(g.id) AS goods_count,
            COALESCE(SUM(g.stock), 0) AS stock_qty,
            COALESCE(SUM(g.cost_price * g.stock), 0) AS cost_value,
            COALESCE(SUM(g.sell_price * g.stock), 0) AS sell_value
       FROM goods_categories c
       LEFT JOIN goods g ON g.category_id = c.id AND g.hotel_id = c.hotel_id
      WHERE c.hotel_id = ?
      GROUP BY c.id, c.name, c.sort
      ORDER BY c.sort, c.id`,
    [hotelId]
  );

  const uncategorized =
    get<{ goods_count: number; stock_qty: number; cost_value: number; sell_value: number }>(
      `SELECT COUNT(*) AS goods_count,
              COALESCE(SUM(stock), 0) AS stock_qty,
              COALESCE(SUM(cost_price * stock), 0) AS cost_value,
              COALESCE(SUM(sell_price * stock), 0) AS sell_value
         FROM goods WHERE hotel_id = ? AND (category_id IS NULL OR category_id = 0)`,
      [hotelId]
    ) ?? { goods_count: 0, stock_qty: 0, cost_value: 0, sell_value: 0 };

  const categoryRows: CategoryAgg[] = [
    ...byCategory,
    ...(Number(uncategorized.goods_count) > 0
      ? [
          {
            id: 0,
            name: "未分类",
            goods_count: Number(uncategorized.goods_count),
            stock_qty: Number(uncategorized.stock_qty),
            cost_value: Number(uncategorized.cost_value),
            sell_value: Number(uncategorized.sell_value),
          },
        ]
      : []),
  ];
  const totalStockQty = categoryRows.reduce((s, c) => s + Number(c.stock_qty ?? 0), 0);
  const totalCostValue = Number(stats.cost_value ?? 0);

  const tabCounts: Record<TabKey, number> = {
    goods: goodsAll.length,
    stock: todayFlows,
    flows: flowsTotal,
    report: stats.low_count,
  };

  const cards = [
    {
      label: "商品数",
      value: String(stats.goods_count),
      unit: "个",
      sub: `在售 ${stats.on_sale} 个 · 下架 ${Math.max(0, Number(stats.goods_count) - Number(stats.on_sale))} 个`,
      cls: "bg-blue-50 text-blue-600",
    },
    {
      label: "库存总量",
      value: String(stats.stock_qty),
      unit: "件",
      sub: `覆盖 ${categories.length} 个类别 · 今日流水 ${todayFlows} 条`,
      cls: "bg-violet-50 text-violet-600",
    },
    {
      label: "库存总额（成本）",
      value: fmtMoney(stats.cost_value),
      unit: "",
      sub: `售价口径 ${fmtMoney(stats.sell_value)}`,
      cls: "bg-emerald-50 text-emerald-600",
    },
    {
      label: "低库存预警",
      value: String(stats.low_count),
      unit: "个",
      sub: "库存 ≤ 预警库存的商品",
      cls: "bg-amber-50 text-amber-600",
    },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">商品库存管理</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            商品类别 · 商品列表 · 进货 / 退货 / 报废 · 库存流水 · 库存报表 — 所有库存变动真实落库
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/shop" className="btn-default px-2.5 py-1 text-[12px]">
            商超零售
          </Link>
          <Link href="/goods?tab=report" className="btn-default px-2.5 py-1 text-[12px]">
            查看库存报表
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-500">{c.label}</span>
              <span className={`flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-semibold ${c.cls}`}>
                {c.label.slice(0, 1)}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-1">
              <span className="text-[18px] font-semibold tabular-nums text-gray-900">{c.value}</span>
              {c.unit && <span className="text-[11px] text-gray-400">{c.unit}</span>}
            </div>
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
                active
                  ? "border-brand-500 font-medium text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-900"
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
          流水共 {flowsTotal} 条 · 数据表 goods / goods_flows
        </span>
      </nav>

      {msg && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-emerald-500 px-4 py-2.5">
          <span className="text-[12px] text-emerald-700">{msg}</span>
          <Link href={tabHref(activeTab)} className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}
      {err && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-rose-500 px-4 py-2.5">
          <span className="text-[12px] text-rose-600">{err}</span>
          <Link href={tabHref(activeTab)} className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}

      {/* ------------------------------ Tab 1 商品列表 ------------------------------ */}
      {activeTab === "goods" && (
        <div className="space-y-3">
          <div className="card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">商品类别 · {categories.length}</span>
              <span className="text-[11px] text-gray-400">类别用于商品归类与报表汇总</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
              <Link
                href="/goods?tab=goods"
                className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                  catFilter
                    ? "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                    : "border-brand-600 bg-brand-600 font-medium text-white"
                }`}
              >
                全部
                <span className={`ml-1 text-[11px] tabular-nums ${catFilter ? "text-gray-400" : "text-white/80"}`}>
                  {goodsAll.length}
                </span>
              </Link>
              {categories.map((c) => {
                const active = c.id === catFilter;
                return (
                  <Link
                    key={c.id}
                    href={`/goods?tab=goods&cat=${c.id}`}
                    className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                      active
                        ? "border-brand-600 bg-brand-600 font-medium text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                    }`}
                  >
                    {c.name}
                    <span className={`ml-1 text-[11px] tabular-nums ${active ? "text-white/80" : "text-gray-400"}`}>
                      {catGoodsCount.get(c.id) ?? 0}
                    </span>
                  </Link>
                );
              })}
              {uncategorizedCount > 0 && (
                <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[12px] text-gray-500">
                  未分类<span className="ml-1 text-[11px] tabular-nums text-gray-400">{uncategorizedCount}</span>
                </span>
              )}
              {categories.length === 0 && <span className="text-[12px] text-gray-400">还没有商品类别</span>}
            </div>
            <form
              action={createCategoryAction}
              className="flex flex-wrap items-end gap-2 border-t border-gray-100 px-4 py-3"
            >
              <div className="w-56">
                <label className="label">新增类别</label>
                <input name="name" required maxLength={20} className="input" placeholder="如 酒水 / 零食" />
              </div>
              <button className="btn-default">添加类别</button>
              <span className="text-[11px] text-gray-400">类别名称在同一酒店内不可重复</span>
            </form>
          </div>

          <details className="card" open={Boolean(editing)}>
            <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-brand-700">
              {editing ? `编辑商品：${editing.name}` : "+ 新增商品"}
            </summary>
            <form action={saveGoodsAction} className="grid gap-3 border-t border-gray-100 px-4 py-3 md:grid-cols-12">
              {editing && <input type="hidden" name="id" value={editing.id} />}
              <div className="md:col-span-3">
                <label className="label">商品名称 *</label>
                <input
                  name="name"
                  required
                  maxLength={40}
                  defaultValue={editing?.name ?? ""}
                  className="input"
                  placeholder="如 矿泉水 550ml"
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">商品类别</label>
                <select
                  name="category_id"
                  defaultValue={editing?.category_id ? String(editing.category_id) : ""}
                  className="input"
                >
                  <option value="">未分类</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="label">条码</label>
                <input
                  name="barcode"
                  defaultValue={editing?.barcode ?? ""}
                  maxLength={32}
                  className="input"
                  placeholder="可选"
                />
              </div>
              <div className="md:col-span-1">
                <label className="label">单位</label>
                <input name="unit" defaultValue={editing?.unit ?? "件"} maxLength={6} className="input" />
              </div>
              <div className="md:col-span-2">
                <label className="label">成本价</label>
                <input
                  name="cost_price"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={editing ? String(editing.cost_price) : ""}
                  className="input"
                  placeholder="0.00"
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">售价</label>
                <input
                  name="sell_price"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={editing ? String(editing.sell_price) : ""}
                  className="input"
                  placeholder="0.00"
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">预警库存</label>
                <input
                  name="warn_stock"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={editing ? String(editing.warn_stock) : "10"}
                  className="input"
                />
              </div>
              <div className="md:col-span-2">
                <label className="label">{editing ? "当前库存" : "期初库存"}</label>
                {editing ? (
                  <div className="flex h-[30px] items-center rounded-md border border-gray-200 bg-gray-50 px-2.5 text-[13px] tabular-nums text-gray-700">
                    {editing.stock} {editing.unit}
                  </div>
                ) : (
                  <input name="stock" type="number" min="0" step="1" defaultValue="0" className="input" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 md:col-span-12">
                <button className="btn-primary">{editing ? "保存修改" : "新增商品"}</button>
                {editing ? (
                  <Link href="/goods?tab=goods" className="btn-default">
                    取消编辑
                  </Link>
                ) : null}
                <span className="text-[11px] text-gray-400">
                  {editing
                    ? "编辑不修改库存：库存只能通过「库存操作」的进货 / 退货 / 报废调整（流水留痕）"
                    : "期初库存 > 0 时自动写入一条「期初建账入库」的进货流水"}
                </span>
              </div>
            </form>
          </details>

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">
                商品列表 · {goods.length}
                {activeCategory ? `（类别：${activeCategory.name}）` : ""}
              </span>
              <span className="text-[11px] text-gray-400">库存 ≤ 预警库存标红 · 下架商品不参与销售出库</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">类别</th>
                    <th className="th">商品名称</th>
                    <th className="th">条码</th>
                    <th className="th">单位</th>
                    <th className="th text-right">成本价</th>
                    <th className="th text-right">售价</th>
                    <th className="th text-right">库存</th>
                    <th className="th text-right">预警库存</th>
                    <th className="th">状态</th>
                    <th className="th text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {goods.length === 0 && (
                    <tr>
                      <td colSpan={10} className="td py-10 text-center text-[12px] text-gray-400">
                        还没有商品
                        <div className="mt-1 text-[11px] text-gray-400">
                          首次访问会自动写入 4 个类别与 12 个商品；也可以直接用上方表单新增
                        </div>
                      </td>
                    </tr>
                  )}
                  {goods.map((g) => {
                    const low = Number(g.stock) <= Number(g.warn_stock);
                    const on = g.status === "ON";
                    const statusMeta = STATUS_META[g.status] ?? STATUS_META.OFF;
                    return (
                      <tr key={g.id} className="hover:bg-gray-50">
                        <td className="td text-gray-600">{g.category_name ?? "未分类"}</td>
                        <td className="td font-medium text-gray-800">{g.name}</td>
                        <td className="td tabular-nums text-gray-500">{g.barcode ?? "-"}</td>
                        <td className="td text-gray-600">{g.unit}</td>
                        <td className="td text-right tabular-nums text-gray-700">{fmtMoney(g.cost_price)}</td>
                        <td className="td text-right tabular-nums text-gray-700">{fmtMoney(g.sell_price)}</td>
                        <td className="td text-right tabular-nums">
                          {low ? (
                            <span className="font-medium text-rose-600">{g.stock}</span>
                          ) : (
                            <span className="text-gray-700">{g.stock}</span>
                          )}
                        </td>
                        <td className="td text-right tabular-nums text-gray-500">{g.warn_stock}</td>
                        <td className="td">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${statusMeta.cls}`}>
                            {statusMeta.label}
                          </span>
                        </td>
                        <td className="td text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Link
                              href={`/goods?tab=goods&edit=${g.id}`}
                              className="btn-default px-2 py-0.5 text-[12px]"
                            >
                              编辑
                            </Link>
                            <form action={toggleGoodsStatusAction}>
                              <input type="hidden" name="id" value={g.id} />
                              <button className="btn-default px-2 py-0.5 text-[12px]">{on ? "下架" : "上架"}</button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
              <span>数据表 goods · 库存由 goods_flows 的进货 / 退货 / 报废 / 销售流水维护</span>
              <span>
                当前筛选库存成本合计{" "}
                <b className="tabular-nums text-gray-600">{fmtMoney(filteredCost)}</b>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------ Tab 2 库存操作 ------------------------------ */}
      {activeTab === "stock" && (
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-3">
            {MOVE_FORMS.map((f) => {
              const meta = FLOW_META[f.type];
              return (
                <div key={f.type} className="card">
                  <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                    <span className="text-[13px] font-semibold text-gray-800">{f.title}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>{meta.label}</span>
                  </div>
                  <form action={f.action} className="space-y-2.5 px-4 py-3">
                    <div>
                      <label className="label">商品 *</label>
                      <select name="goods_id" required className="input" defaultValue="">
                        <option value="" disabled>
                          请选择商品
                        </option>
                        {goodsAll.map((g) => (
                          <option key={g.id} value={g.id} disabled={g.status !== "ON"}>
                            {`${g.name} · 库存 ${g.stock} ${g.unit}${g.status !== "ON" ? "（已下架）" : ""}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="label">数量 *</label>
                        <input
                          name="qty"
                          type="number"
                          min={1}
                          max={99999}
                          step={1}
                          defaultValue="1"
                          required
                          className="input"
                        />
                      </div>
                      <div>
                        <label className="label">单价</label>
                        <input
                          name="unit_price"
                          type="number"
                          min="0"
                          step="0.01"
                          className="input"
                          placeholder="默认成本价"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="label">备注</label>
                      <input
                        name="note"
                        maxLength={60}
                        className="input"
                        placeholder={f.type === "PURCHASE" ? "如 供应商送货单号" : "如 破损 / 临期原因"}
                      />
                    </div>
                    <button className={`${f.btn} w-full`}>{f.submit}</button>
                    <p className="text-[11px] leading-4 text-gray-400">{f.desc}</p>
                  </form>
                </div>
              );
            })}
          </div>

          <div className="card overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">最近库存操作 · {recentFlows.length}</span>
              <Link href="/goods?tab=flows" className="text-[12px] text-gray-500 hover:text-brand-600">
                查看全部流水 →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">时间</th>
                    <th className="th">商品</th>
                    <th className="th">类型</th>
                    <th className="th text-right">数量</th>
                    <th className="th text-right">结存</th>
                    <th className="th text-right">单价</th>
                    <th className="th text-right">金额</th>
                    <th className="th">备注</th>
                    <th className="th">操作人</th>
                  </tr>
                </thead>
                <tbody>
                  {recentFlows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="td py-8 text-center text-[12px] text-gray-400">
                        还没有库存流水
                        <div className="mt-1 text-[11px] text-gray-400">用上方三张表单做一次进货 / 退货 / 报废</div>
                      </td>
                    </tr>
                  )}
                  {recentFlows.map((f) => {
                    const meta = flowMeta(f.type);
                    const qty = Number(f.qty ?? 0);
                    return (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="td tabular-nums text-gray-500">{fmtTime(f.created_at)}</td>
                        <td className="td text-gray-700">{f.goods_name ?? "-"}</td>
                        <td className="td">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>{meta.label}</span>
                        </td>
                        <td
                          className={`td text-right tabular-nums font-medium ${
                            qty > 0 ? "text-emerald-700" : "text-rose-600"
                          }`}
                        >
                          {signedQty(qty)}
                        </td>
                        <td className="td text-right tabular-nums text-gray-700">{f.stock_after}</td>
                        <td className="td text-right tabular-nums text-gray-600">{fmtMoney(f.unit_price)}</td>
                        <td className="td text-right tabular-nums text-gray-700">{fmtMoney(f.amount)}</td>
                        <td className="td text-gray-500">{f.note ?? "-"}</td>
                        <td className="td text-gray-600">{f.operator ?? "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
              每次操作都在一个事务内先更新 goods.stock，再写入 goods_flows（含变动后结存 stock_after）；库存不足会拒绝出库
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------ Tab 3 明细查询 ------------------------------ */}
      {activeTab === "flows" && (
        <div className="space-y-3">
          <div className="card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">流水筛选</span>
              <span className="text-[11px] text-gray-400">按商品 / 类型过滤，最多展示最近 300 条</span>
            </div>
            <form method="get" action="/goods" className="flex flex-wrap items-end gap-2 px-4 py-3">
              <input type="hidden" name="tab" value="flows" />
              {flowType && <input type="hidden" name="t" value={flowType} />}
              <div className="w-64">
                <label className="label">商品</label>
                <select name="g" defaultValue={flowGoodsId ? String(flowGoodsId) : ""} className="input">
                  <option value="">全部商品</option>
                  {goodsAll.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn-primary">查询</button>
              <Link href="/goods?tab=flows" className="btn-default">
                重置
              </Link>
              <span className="ml-auto text-[11px] text-gray-400">
                进货 {flowIn} 件 · 出库 {flowOut} 件 · 金额合计 {fmtMoney(flowAmount)}
              </span>
            </form>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 px-4 py-2.5">
              <Link
                href={flowsHref({ t: "" })}
                className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                  flowType
                    ? "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                    : "border-brand-600 bg-brand-600 font-medium text-white"
                }`}
              >
                全部类型
              </Link>
              {FLOW_KEYS.map((k) => {
                const meta = FLOW_META[k];
                const active = flowType === k;
                return (
                  <Link
                    key={k}
                    href={flowsHref({ t: k })}
                    className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                      active
                        ? "border-brand-600 bg-brand-600 font-medium text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:border-brand-300 hover:text-brand-600"
                    }`}
                  >
                    {meta.label}
                  </Link>
                );
              })}
              {flowGoodsId && (
                <span className="ml-1 rounded-md bg-brand-50 px-2 py-1 text-[11px] text-brand-700">
                  已按商品过滤：{goodsAll.find((g) => g.id === flowGoodsId)?.name ?? flowGoodsId}
                </span>
              )}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">库存流水 · {flows.length} 条</span>
              <span className="text-[11px] text-gray-400">
                {flowType ? `类型：${FLOW_META[flowType].label}` : "全部类型"}
                {flowGoodsId ? " · 已按商品过滤" : ""}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">时间</th>
                    <th className="th">商品</th>
                    <th className="th">类型</th>
                    <th className="th text-right">数量</th>
                    <th className="th text-right">结存</th>
                    <th className="th text-right">单价</th>
                    <th className="th text-right">金额</th>
                    <th className="th">备注</th>
                    <th className="th">操作人</th>
                  </tr>
                </thead>
                <tbody>
                  {flows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="td py-10 text-center text-[12px] text-gray-400">
                        没有符合条件的库存流水
                        <div className="mt-1 text-[11px] text-gray-400">
                          换个商品或类型试试，或到「库存操作」做一次进货 / 退货 / 报废
                        </div>
                      </td>
                    </tr>
                  )}
                  {flows.map((f) => {
                    const meta = flowMeta(f.type);
                    const qty = Number(f.qty ?? 0);
                    return (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="td tabular-nums text-gray-500">{fmtTime(f.created_at)}</td>
                        <td className="td text-gray-700">
                          {f.goods_name ?? "-"}
                          <span className="ml-1 text-[11px] text-gray-400">{f.unit ?? ""}</span>
                        </td>
                        <td className="td">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>{meta.label}</span>
                        </td>
                        <td
                          className={`td text-right tabular-nums font-medium ${
                            qty > 0 ? "text-emerald-700" : "text-rose-600"
                          }`}
                        >
                          {signedQty(qty)}
                        </td>
                        <td className="td text-right tabular-nums text-gray-700">{f.stock_after}</td>
                        <td className="td text-right tabular-nums text-gray-600">{fmtMoney(f.unit_price)}</td>
                        <td className="td text-right tabular-nums text-gray-700">{fmtMoney(f.amount)}</td>
                        <td className="td text-gray-500">{f.note ?? "-"}</td>
                        <td className="td text-gray-600">{f.operator ?? "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
              <span>数量带符号：进货为正（绿色），退货 / 报废 / 销售为负（红色）；金额 = 单价 × 数量</span>
              <span>
                当前 {flows.length} 条金额合计 <b className="tabular-nums text-gray-600">{fmtMoney(flowAmount)}</b>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------ Tab 4 库存报表 ------------------------------ */}
      {activeTab === "report" && (
        <div className="space-y-3">
          <div className="card overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">低库存预警清单 · {lowGoods.length}</span>
              <span className="text-[11px] text-gray-400">判定条件：stock ≤ warn_stock，按缺口从大到小排列</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">商品名称</th>
                    <th className="th">类别</th>
                    <th className="th">单位</th>
                    <th className="th text-right">当前库存</th>
                    <th className="th text-right">预警库存</th>
                    <th className="th text-right">缺口</th>
                    <th className="th text-right">建议补货</th>
                    <th className="th text-right">库存成本</th>
                    <th className="th">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {lowGoods.length === 0 && (
                    <tr>
                      <td colSpan={9} className="td py-10 text-center text-[12px] text-gray-400">
                        暂无低库存商品，库存水位正常
                      </td>
                    </tr>
                  )}
                  {lowGoods.map((g) => {
                    const gap = Math.max(0, Number(g.warn_stock) - Number(g.stock));
                    const suggest = Math.max(0, Number(g.warn_stock) * 2 - Number(g.stock));
                    const statusMeta = STATUS_META[g.status] ?? STATUS_META.OFF;
                    return (
                      <tr key={g.id} className="hover:bg-gray-50">
                        <td className="td font-medium text-gray-800">{g.name}</td>
                        <td className="td text-gray-600">{g.category_name ?? "未分类"}</td>
                        <td className="td text-gray-600">{g.unit}</td>
                        <td className="td text-right tabular-nums font-medium text-rose-600">{g.stock}</td>
                        <td className="td text-right tabular-nums text-gray-500">{g.warn_stock}</td>
                        <td className="td text-right tabular-nums text-rose-600">-{gap}</td>
                        <td className="td text-right tabular-nums text-gray-700">{suggest}</td>
                        <td className="td text-right tabular-nums text-gray-700">
                          {fmtMoney(Number(g.cost_price ?? 0) * Number(g.stock ?? 0))}
                        </td>
                        <td className="td">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${statusMeta.cls}`}>
                            {statusMeta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
              建议补货 = 预警库存 × 2 − 当前库存（补到 2 倍安全库存水位）
            </div>
          </div>

          <div className="card overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
              <span className="text-[13px] font-semibold text-gray-800">按类别汇总 · {categoryRows.length}</span>
              <span className="text-[11px] text-gray-400">
                库存总额（成本口径）<b className="tabular-nums text-gray-600">{fmtMoney(totalCostValue)}</b>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">类别</th>
                    <th className="th text-right">商品数</th>
                    <th className="th text-right">库存量</th>
                    <th className="th text-right">成本金额</th>
                    <th className="th text-right">售价金额</th>
                    <th className="th text-right">毛利空间</th>
                    <th className="th">成本占比</th>
                  </tr>
                </thead>
                <tbody>
                  {categoryRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="td py-10 text-center text-[12px] text-gray-400">
                        还没有商品类别与库存数据
                      </td>
                    </tr>
                  )}
                  {categoryRows.map((c) => {
                    const cost = Number(c.cost_value ?? 0);
                    const sell = Number(c.sell_value ?? 0);
                    const qty = Number(c.stock_qty ?? 0);
                    const pct = totalCostValue > 0 ? Math.round((cost / totalCostValue) * 100) : 0;
                    return (
                      <tr key={`cat-${c.id}`} className="hover:bg-gray-50">
                        <td className="td font-medium text-gray-800">{c.name}</td>
                        <td className="td text-right tabular-nums text-gray-700">{c.goods_count}</td>
                        <td className="td text-right tabular-nums text-gray-700">{qty}</td>
                        <td className="td text-right tabular-nums text-gray-700">{fmtMoney(cost)}</td>
                        <td className="td text-right tabular-nums text-gray-600">{fmtMoney(sell)}</td>
                        <td className="td text-right tabular-nums text-emerald-700">{fmtMoney(sell - cost)}</td>
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded bg-gray-100">
                              <div
                                className="h-full rounded bg-brand-500"
                                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                              />
                            </div>
                            <span className="w-9 text-right text-[11px] tabular-nums text-gray-500">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
              <span>合计 {categoryRows.length} 个类别 · 库存量 {totalStockQty} 件</span>
              <span>
                成本口径合计 <b className="tabular-nums text-gray-600">{fmtMoney(totalCostValue)}</b>
              </span>
            </div>
          </div>

          <p className="text-[11px] leading-5 text-gray-400">
            库存报表口径：库存总额 = Σ(成本价 × 现有库存)，售价金额 = Σ(售价 × 现有库存)，毛利空间 = 售价金额 −
            成本金额；低库存按「库存 ≤ 预警库存」判定。商品、流水与类别数据均来自 goods / goods_flows /
            goods_categories 三张表（首次访问本模块时自动创建并写入示例数据）。
          </p>
        </div>
      )}
    </div>
  );
}
