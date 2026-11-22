import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { ensureRentalSchema, rentItemAction, returnRentalAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type ItemRow = {
  id: number;
  name: string;
  price: number;
  deposit: number;
  stock: number;
  status: string;
  rented_out: number;
};

type RecordRow = {
  id: number;
  item_name: string | null;
  room_no: string | null;
  guest_name: string | null;
  qty: number | null;
  deposit: number | null;
  rent_at: string | null;
  return_at: string | null;
  status: string;
};

type StayRow = { room_no: string; guest_name: string | null };

type Stats = {
  items: number;
  stock: number;
  rented: number;
  deposit_out: number;
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** ISO → MM-DD HH:mm，保留跨天信息 */
function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default async function RentalPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  const ok = first(sp.msg);
  const err = first(sp.err);

  // 懒建表 + 首次种子：租赁物品 / 租赁记录
  await ensureRentalSchema(hotelId);

  const items = all<ItemRow>(
    `SELECT ri.id, ri.name, ri.price, ri.deposit, ri.stock, ri.status,
            (SELECT COALESCE(SUM(rr.qty), 0) FROM rental_records rr
              WHERE rr.hotel_id = ri.hotel_id AND rr.item_id = ri.id AND rr.status = 'RENTED') AS rented_out
       FROM rental_items ri
      WHERE ri.hotel_id = ?
      ORDER BY CASE ri.status WHEN 'ON' THEN 0 ELSE 1 END, ri.id`,
    [hotelId]
  );

  const records = all<RecordRow>(
    `SELECT rr.id, ri.name AS item_name, rr.room_no, rr.guest_name, rr.qty, rr.deposit,
            rr.rent_at, rr.return_at, rr.status
       FROM rental_records rr
       LEFT JOIN rental_items ri ON ri.id = rr.item_id
      WHERE rr.hotel_id = ?
      ORDER BY rr.id DESC
      LIMIT 30`,
    [hotelId]
  );

  // 在住房间建议：房号输入框的候选项，选房号即可自动带出客人
  const stays = all<StayRow>(
    `SELECT r.room_no, s.guest_name
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
      ORDER BY r.sort, r.room_no`,
    [hotelId]
  );

  const stats =
    get<Stats>(
      `SELECT
         (SELECT COUNT(*) FROM rental_items WHERE hotel_id = ?) AS items,
         (SELECT COALESCE(SUM(stock), 0) FROM rental_items WHERE hotel_id = ?) AS stock,
         (SELECT COUNT(*) FROM rental_records WHERE hotel_id = ? AND status = 'RENTED') AS rented,
         (SELECT COALESCE(SUM(deposit), 0) FROM rental_records WHERE hotel_id = ? AND status = 'RENTED') AS deposit_out`,
      [hotelId, hotelId, hotelId, hotelId]
    ) ?? { items: 0, stock: 0, rented: 0, deposit_out: 0 };

  const renting = records.filter((r) => r.status === "RENTED").length;

  const cards = [
    {
      label: "可租物品",
      value: String(stats.items),
      sub: `可租库存合计 ${stats.stock} 件`,
      cls: "bg-blue-50 text-blue-600",
    },
    {
      label: "在租记录",
      value: String(stats.rented),
      sub: `近期记录中在租 ${renting} 条 · 已归还 ${records.length - renting} 条`,
      cls: "bg-amber-50 text-amber-600",
    },
    {
      label: "在租押金",
      value: fmtMoney(stats.deposit_out),
      sub: "归还后押金退还客人，库存自动回补",
      cls: "bg-emerald-50 text-emerald-600",
    },
  ];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-gray-900">物品租赁</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            充电宝、雨伞、转换插头等前台出借物品 · 共 {stats.items} 种 · 在租 {stats.rented} 笔
          </p>
        </div>
        <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
          当前酒店：{user.hotelName}
        </span>
      </div>

      {ok && <div className="card border-l-4 border-l-emerald-500 px-4 py-2.5 text-[12px] text-emerald-700">{ok}</div>}
      {err && <div className="card border-l-4 border-l-rose-500 px-4 py-2.5 text-[12px] text-rose-600">{err}</div>}

      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-500">{c.label}</span>
              <span className={`flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold ${c.cls}`}>
                {c.label.slice(0, 1)}
              </span>
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-gray-900">{c.value}</div>
            <div className="mt-1 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      <details className="card" open>
        <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-brand-700">
          + 办理物品租赁
        </summary>
        <form action={rentItemAction} className="grid gap-3 border-t border-gray-100 px-4 py-3 md:grid-cols-4">
          <div>
            <label className="label">房号 *</label>
            <input name="room_no" list="rental-room-list" required placeholder="输入或选择在住房间" className="input" />
            <datalist id="rental-room-list">
              {stays.map((s) => (
                <option key={s.room_no} value={s.room_no}>
                  {s.guest_name ?? ""}
                </option>
              ))}
            </datalist>
          </div>
          <div className="md:col-span-2">
            <label className="label">租借物品 *</label>
            <select name="item_id" required defaultValue="" className="input">
              <option value="" disabled>
                请选择物品
              </option>
              {items.map((it) => (
                <option key={it.id} value={it.id} disabled={it.status !== "ON" || it.stock <= 0}>
                  {`${it.name} · 租金 ${fmtMoney(it.price)} · 押金 ${fmtMoney(it.deposit)} · 可租 ${it.stock}` +
                    (it.status !== "ON" ? "（已停用）" : it.stock <= 0 ? "（无库存）" : "")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">数量 *</label>
            <input name="qty" type="number" min={1} max={99} step={1} defaultValue="1" required className="input" />
          </div>
          <div className="flex flex-wrap items-end gap-2 md:col-span-4">
            <button className="btn-primary">确认租出</button>
            <span className="text-[11px] text-gray-400">
              房号自动匹配在住客人 · 押金按「物品押金 × 数量」计算 · 租出后库存同步扣减
            </span>
          </div>
          {stays.length === 0 && (
            <div className="text-[11px] text-amber-600 md:col-span-4">
              当前没有在住客人，物品租赁需先办理入住
            </div>
          )}
        </form>
      </details>

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">物品列表 · {items.length} 种</span>
          <span className="text-[11px] text-gray-400">库存 ≤ 2 显示预警 · 停用物品不可租出</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">物品名称</th>
                <th className="th text-right">租金</th>
                <th className="th text-right">押金</th>
                <th className="th text-right">可租库存</th>
                <th className="th text-right">在租数量</th>
                <th className="th">状态</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="td py-10 text-center text-gray-400">
                    暂无租赁物品
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.id} className="hover:bg-gray-50">
                  <td className="td font-medium text-gray-800">{it.name}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(it.price)}</td>
                  <td className="td text-right tabular-nums text-gray-700">{fmtMoney(it.deposit)}</td>
                  <td className="td text-right tabular-nums">
                    <span className={it.stock <= 2 ? "font-medium text-rose-600" : "text-gray-800"}>{it.stock}</span>
                  </td>
                  <td className="td text-right tabular-nums text-gray-600">{it.rented_out}</td>
                  <td className="td">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        it.status === "ON" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {it.status === "ON" ? "可租" : "停用"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">租赁记录 · 最近 {records.length} 条</span>
          <span className="text-[11px] text-gray-400">归还后点击「归还」回库存</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">物品</th>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th text-right">数量</th>
                <th className="th text-right">押金</th>
                <th className="th">租出时间</th>
                <th className="th">归还时间</th>
                <th className="th">状态</th>
                <th className="th text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr>
                  <td colSpan={9} className="td py-10 text-center text-gray-400">
                    暂无租赁记录，使用上方表单办理物品租赁
                  </td>
                </tr>
              )}
              {records.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td font-medium text-gray-800">{r.item_name ?? "（物品已删除）"}</td>
                  <td className="td tabular-nums">{r.room_no ?? "-"}</td>
                  <td className="td text-gray-600">{r.guest_name ?? "-"}</td>
                  <td className="td text-right tabular-nums">{r.qty ?? 1}</td>
                  <td className="td text-right tabular-nums">{fmtMoney(r.deposit)}</td>
                  <td className="td text-gray-500">{fmtTime(r.rent_at)}</td>
                  <td className="td text-gray-500">{r.return_at ? fmtTime(r.return_at) : "-"}</td>
                  <td className="td">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        r.status === "RENTED" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {r.status === "RENTED" ? "在租" : "已归还"}
                    </span>
                  </td>
                  <td className="td text-right">
                    {r.status === "RENTED" ? (
                      <form action={returnRentalAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="btn-default h-7 px-2 text-[11px]">归还</button>
                      </form>
                    ) : (
                      <span className="text-[11px] text-gray-400">已完成</span>
                    )}
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
