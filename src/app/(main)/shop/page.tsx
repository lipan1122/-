import Link from "next/link";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, todayStr } from "@/lib/utils";
import ConfirmForm from "@/components/ConfirmForm";
import { ShopPOS } from "@/components/ShopPOS";
import { ensureShopPageSchema, sellCartAction, voidSaleAction } from "./actions";

export const dynamic = "force-dynamic";

/** 去呼呼商超左侧菜单 */
const SHOP_MENU = [
  { label: "前台售卖", href: "/shop" },
  { label: "订单管理", href: "/shop?tab=orders" },
  { label: "餐饮及小商超订单", href: "/shop?tab=orders", child: true },
  { label: "前台订单", href: "/shop?tab=orders&kind=front", child: true },
  { label: "商品管理", href: "/shop?tab=items" },
  { label: "商品设置", href: "/shop?tab=items", child: true },
  { label: "商品分类", href: "/shop?tab=categories", child: true },
];

type Search = { q?: string; cat?: string; tab?: string; msg?: string; err?: string };

export default async function ShopPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const tab = sp.tab ?? "";
  const today = todayStr();

  /* 旧库可能还没有 shop_sales.voided_at 等列：渲染前补一次结构，避免列表查询报错 */
  await ensureShopPageSchema(hotelId);

  const items = all<{ id: number; name: string; price: number; stock: number; category: string | null }>(
    `SELECT id, name, price, stock, category FROM shop_items
     WHERE hotel_id = ? AND COALESCE(status, 'ON') = 'ON' ORDER BY id`,
    [hotelId]
  );

  const rooms = all<{ room_no: string; guest_name: string | null }>(
    `SELECT r.room_no, s.guest_name FROM rooms r
     LEFT JOIN stays s ON s.room_id = r.id AND s.status = 'INHOUSE'
     WHERE r.hotel_id = ? AND r.status IN ('OC','OD') ORDER BY r.room_no`,
    [hotelId]
  );

  const todaySales = all<{
    id: number;
    item_name: string;
    qty: number;
    amount: number;
    method: string | null;
    room_no: string | null;
    created_at: string | null;
    voided_at: string | null;
    void_reason: string | null;
  }>(
    `SELECT id, item_name, qty, amount, method, room_no, created_at, voided_at, void_reason FROM shop_sales
     WHERE hotel_id = ? AND date(created_at, 'localtime') = ? ORDER BY id DESC`,
    [hotelId, today]
  );

  const totalSales = todaySales.reduce((a, s) => a + (s.voided_at ? 0 : Number(s.amount ?? 0)), 0);

  async function submitOrder(payload: { itemId: number; qty: number; roomNo: string; method: string }) {
    "use server";
    const fd = new FormData();
    fd.set("item_id", String(payload.itemId));
    fd.set("qty", String(payload.qty));
    fd.set("room_no", payload.roomNo);
    fd.set("method", payload.method);
    await sellCartAction(fd);
  }

  return (
    <div className="flex">
      <aside className="w-[168px] shrink-0 border-r border-[#e8e8e8] bg-white py-2">
        {SHOP_MENU.map((m) => {
          const active = m.href === "/shop" ? !tab : m.href.includes(tab) && tab !== "";
          return (
            <Link
              key={m.label + m.href}
              href={m.href}
              className={`flex h-[34px] items-center border-l-[3px] text-[13px] ${
                m.child ? "pl-[29px] text-[12.5px]" : "pl-[13px]"
              } ${
                active && !m.child
                  ? "border-[#0f8f6f] bg-[#eef9f0] font-medium text-[#0f8f6f]"
                  : "border-transparent text-[#555] hover:bg-[#f7f9f8]"
              }`}
            >
              {m.label}
            </Link>
          );
        })}
      </aside>

      <div className="min-w-0 flex-1 space-y-3 p-3">
        <div className="text-[15px] font-semibold text-[#222]">
          {tab === "orders" ? "餐饮及小商超订单" : tab === "categories" ? "商品分类" : tab === "items" ? "商品设置" : "前台售卖"}
        </div>

        {tab === "orders" ? (
          <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
            <div className="flex items-center justify-between border-b border-[#f0f0f0] px-3 py-2">
              <span className="text-[13px] font-medium text-[#333]">今日订单 · {today}</span>
              <span className="text-[11.5px] text-[#888]">
                共 {todaySales.length} 笔 · 合计 {fmtMoney(totalSales)}
              </span>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#fafafa]">
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">序号</th>
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">商品名称</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">数量</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">金额</th>
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">支付方式</th>
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">时间</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">操作</th>
                </tr>
              </thead>
              <tbody>
                {todaySales.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-[12px] text-[#999]">
                      暂无订单数据
                    </td>
                  </tr>
                )}
                {todaySales.map((s, i) => (
                  <tr key={s.id} className={`border-t border-[#f5f5f5] ${s.voided_at ? "text-[#aaa]" : ""}`}>
                    <td className="px-3 py-2 text-[12px] text-[#888]">{i + 1}</td>
                    <td className={`px-3 py-2 text-[12px] ${s.voided_at ? "line-through" : "text-[#222]"}`}>
                      {s.item_name}
                    </td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{s.qty}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(s.amount)}</td>
                    <td className="px-3 py-2 text-[12px] text-[#555]">{s.method ?? "-"}</td>
                    <td className="px-3 py-2 text-[12px] tabular-nums text-[#888]">{(s.created_at ?? "").slice(11, 16)}</td>
                    <td className="px-3 py-2 text-right text-[12px]">
                      {s.voided_at ? (
                        <span
                          className="rounded border border-[#e5e5e5] bg-[#fafafa] px-1.5 py-0.5 text-[11px] text-[#999]"
                          title={s.void_reason ? `原因：${s.void_reason}` : undefined}
                        >
                          已撤销
                        </span>
                      ) : (
                        <ConfirmForm
                          action={voidSaleAction}
                          message={`确认撤销销售单 #${s.id}？`}
                          detail={`${s.item_name} ×${s.qty} · ${fmtMoney(s.amount)} · ${
                            s.room_no ? `挂账房 ${s.room_no}` : s.method ?? "现金"
                          }。撤销后库存回加；挂房账的会在客人账单上补一笔负项。`}
                          requireReason="撤销原因"
                          confirmLabel="确认撤销"
                        >
                          <input type="hidden" name="id" value={s.id} />
                          <button type="submit" className="btn-danger px-2 py-0.5 text-[11px]">
                            撤销
                          </button>
                        </ConfirmForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : tab === "items" || tab === "categories" ? (
          <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#fafafa]">
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">商品名称</th>
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">分类</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">售价</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">库存</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-t border-[#f5f5f5]">
                    <td className="px-3 py-2 text-[12px] text-[#222]">{it.name}</td>
                    <td className="px-3 py-2 text-[12px] text-[#666]">{it.category ?? "其他"}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(it.price)}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums text-[#666]">{it.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          <ShopPOS
            items={items.map((i) => ({ id: i.id, name: i.name, price: Number(i.price), stock: it0(i.stock), category: i.category }))}
            rooms={rooms.map((r) => ({ roomNo: r.room_no, guestName: r.guest_name }))}
            onSubmit={submitOrder}
            msg={sp.msg}
            err={sp.err}
          />
        )}
      </div>
    </div>
  );
}

/** 库存可能为 null，统一转数字 */
function it0(v: number | null | undefined): number {
  return Number(v ?? 0);
}
