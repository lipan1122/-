"use client";

import { useMemo, useState, useTransition } from "react";

export type PosItem = { id: number; name: string; price: number; stock: number; category: string | null };
export type PosRoom = { roomNo: string; guestName: string | null };

/** 商超前台售卖（客户端 POS：点击加购、数量增减、小计实时变化，无刷新） */
export function ShopPOS({
  items,
  rooms,
  onSubmit,
  msg,
  err,
}: {
  items: PosItem[];
  rooms: PosRoom[];
  onSubmit: (payload: { itemId: number; qty: number; roomNo: string; method: string }) => Promise<void>;
  msg?: string;
  err?: string;
}) {
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.category) set.add(it.category);
    return ["全部分类", ...Array.from(set)];
  }, [items]);

  const [cat, setCat] = useState("全部分类");
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<{ id: number; name: string; price: number; qty: number }[]>([]);
  const [roomNo, setRoomNo] = useState("");
  const [method, setMethod] = useState("现金");
  const [pending, startTransition] = useTransition();
  const [tip, setTip] = useState<{ kind: "ok" | "err"; text: string } | null>(
    msg ? { kind: "ok", text: msg } : err ? { kind: "err", text: err } : null
  );

  const shown = items.filter(
    (it) => (cat === "全部分类" || it.category === cat) && (!q.trim() || it.name.includes(q.trim()))
  );

  const add = (it: PosItem) => {
    setCart((prev) => {
      const hit = prev.find((c) => c.id === it.id);
      if (hit) return prev.map((c) => (c.id === it.id ? { ...c, qty: c.qty + 1 } : c));
      return [...prev, { id: it.id, name: it.name, price: it.price, qty: 1 }];
    });
  };
  const minus = (id: number) =>
    setCart((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, qty: c.qty - 1 } : c))
        .filter((c) => c.qty > 0)
    );
  const clear = () => setCart([]);

  const totalQty = cart.reduce((a, c) => a + c.qty, 0);
  const total = cart.reduce((a, c) => a + c.price * c.qty, 0);

  const submit = () => {
    if (cart.length === 0) {
      setTip({ kind: "err", text: "购物车为空，请先点商品" });
      return;
    }
    if (!roomNo) {
      setTip({ kind: "err", text: "挂房账请先选房号；现金收款可直接点收款" });
      return;
    }
    startTransition(async () => {
      await onSubmit({ itemId: cart[0].id, qty: cart.reduce((a, c) => a + c.qty, 0), roomNo, method });
      setTip({ kind: "ok", text: `已售出 ${totalQty} 件，合计 ¥${total.toFixed(2)}` });
      setCart([]);
    });
  };

  return (
    <div className="flex gap-3">
      {/* 商品区 */}
      <div className="min-w-0 flex-1 rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="flex items-center gap-2 px-3 py-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入商品名称即时过滤"
            className="input h-7 w-[240px]"
          />
          <span className="text-[11.5px] text-[#999]">共 {items.length} 件 · 显示 {shown.length} 件</span>
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-[#f0f0f0] px-3 py-2">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-[2px] px-2.5 py-1 text-[12px] ${
                cat === c ? "bg-[#3bd943] text-white" : "bg-[#f5f5f5] text-[#666] hover:bg-[#ebebeb]"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-[#f0f0f0] p-3 md:grid-cols-3 xl:grid-cols-4">
          {shown.map((it) => (
            <button
              key={it.id}
              onClick={() => add(it)}
              className="rounded-[2px] border border-[#e5e5e5] px-2.5 py-2 text-left hover:border-[#3bd943]"
            >
              <div className="truncate text-[13px] text-[#222]">{it.name}</div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-[#e53935]">¥{it.price.toFixed(2)}</span>
                <span className="text-[11px] text-[#999]">库:{it.stock}</span>
              </div>
            </button>
          ))}
          {shown.length === 0 && (
            <div className="col-span-full py-10 text-center text-[12px] text-[#999]">没有匹配的商品</div>
          )}
        </div>
      </div>

      {/* 购物车 */}
      <div className="w-[320px] shrink-0 rounded-[3px] border border-[#e5e5e5] bg-white">
        <div className="grid grid-cols-[1fr_70px_70px] border-b border-[#f0f0f0] bg-[#fafafa] px-3 py-2 text-[12px] font-medium text-[#555]">
          <span>商品名称</span>
          <span className="text-center">数量</span>
          <span className="text-right">小计</span>
        </div>
        <div className="min-h-[300px] max-h-[420px] overflow-y-auto">
          {cart.length === 0 && (
            <div className="px-3 py-16 text-center text-[12px] text-[#bbb]">点击左侧商品进行售卖</div>
          )}
          {cart.map((c) => (
            <div key={c.id} className="grid grid-cols-[1fr_70px_70px] items-center border-b border-[#f8f8f8] px-3 py-2">
              <span className="truncate text-[12px] text-[#222]">{c.name}</span>
              <div className="flex items-center justify-center gap-1">
                <button onClick={() => minus(c.id)} className="h-4 w-4 rounded border border-[#ddd] text-[11px] leading-none text-[#666]">
                  −
                </button>
                <span className="w-5 text-center text-[12px] tabular-nums text-[#333]">{c.qty}</span>
                <button onClick={() => add({ id: c.id, name: c.name, price: c.price, stock: 999, category: null })} className="h-4 w-4 rounded border border-[#ddd] text-[11px] leading-none text-[#666]">
                  +
                </button>
              </div>
              <span className="text-right text-[12px] tabular-nums text-[#e53935]">
                ¥{(c.price * c.qty).toFixed(2)}
              </span>
            </div>
          ))}
        </div>
        <div className="border-t border-[#f0f0f0] px-3 py-2 text-[12px] text-[#555]">
          <div className="flex items-center justify-between">
            <span>商品数量：{totalQty}</span>
            <span>合计：¥{total.toFixed(2)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>优惠金额：</span>
            <span className="text-[#e53935]">¥0.00</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>应收金额：</span>
            <span className="text-[13px] font-semibold text-[#e53935]">¥{total.toFixed(2)}</span>
          </div>
          <div className="mt-2 space-y-1.5">
            <select value={roomNo} onChange={(e) => setRoomNo(e.target.value)} className="input h-7 w-full text-[12px]">
              <option value="">挂房账（选房号）</option>
              {rooms.map((r) => (
                <option key={r.roomNo} value={r.roomNo}>
                  {r.roomNo} {r.guestName ?? ""}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1.5">
              <select value={method} onChange={(e) => setMethod(e.target.value)} className="input h-7 flex-1 text-[12px]">
                {["现金", "微信", "支付宝", "银行卡"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button
                onClick={submit}
                disabled={pending}
                className="h-7 rounded-[3px] bg-[#3bd943] px-3 text-[12px] text-white hover:bg-[#33cd3b] disabled:opacity-60"
              >
                {pending ? "提交中…" : "收款"}
              </button>
            </div>
            {cart.length > 0 && (
              <button onClick={clear} className="w-full text-[11px] text-[#999] hover:text-[#e53935]">
                清空购物车
              </button>
            )}
          </div>
          {tip && (
            <div className={`mt-1.5 text-[11.5px] ${tip.kind === "ok" ? "text-[#2a9d5c]" : "text-[#e53935]"}`}>
              {tip.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
