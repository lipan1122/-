"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { sellCartAction } from "@/app/(main)/shop/actions";

export type PosItem = { id: number; name: string; price: number; stock: number; category: string | null };
export type PosRoom = { roomNo: string; guestName: string | null };

/* ============================================================ 幂等请求号 */

/**
 * 生成一次结算的幂等请求号（整改清单第七轮 一.2）
 *
 * 服务端 sellCartAction / sellAction 用 shop_sales(hotel_id, request_id) 的部分唯一索引
 * 去重，但第七轮之前前端从来不传 request_id —— 服务端只能自己生成，
 * 于是按钮双击、网络重试、表单重放每一次都换一枚新的，全部记账成独立销售。
 *
 * 这里的三级降级是必须的：`crypto.randomUUID()` **只在 secure context**（https 或
 * localhost）存在，酒店库存机常见的是 http://内网IP:3100 直连，那里调用它要么
 * 属性不存在、要么直接抛错，整个收款按钮就废了：
 *   1. crypto.randomUUID()      → https / localhost
 *   2. crypto.getRandomValues() → http 也能用，手工拼 RFC4122 v4
 *   3. 时间戳 + Math.random()   → 老浏览器 / 非安全上下文兜底
 * 三级都不抛错；值由组件 state 持有，同一次结算始终是同一枚。
 */
function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* 非安全上下文等场景：继续降级 */
    }
  }
  if (c && typeof c.getRandomValues === "function") {
    try {
      const buf = new Uint8Array(16);
      c.getRandomValues(buf);
      /* RFC4122 v4：版本位与变体位 */
      buf[6] = (buf[6] & 0x0f) | 0x40;
      buf[8] = (buf[8] & 0x3f) | 0x80;
      const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      /* 继续降级 */
    }
  }
  return `rid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * 从 server action 的跳转信号里取出目标地址
 *
 * sellCartAction 的成功与业务失败都走 redirect（成功 /shop?msg=，失败 /shop?err=），
 * 从客户端调用时 Next 会把它变成一次导航，同时让这个 promise reject。
 * 这里只判断「跳转目标里有没有 err=」—— 那是本文件服务端 failUrl 的约定，
 * 解析不出来就返回 null，调用方按「未确认」保守处理（保留同一 request_id）。
 */
function redirectTarget(e: unknown): string | null {
  const maybe = e as { digest?: unknown; message?: unknown } | null;
  const digest = typeof maybe?.digest === "string" ? maybe.digest : "";
  const message = typeof maybe?.message === "string" ? maybe.message : String(e ?? "");
  const raw = /NEXT_REDIRECT/.test(digest) ? digest : /NEXT_REDIRECT/.test(message) ? message : "";
  if (!raw) return null;
  return raw.slice(raw.indexOf("NEXT_REDIRECT")).split(";").find((p) => p.startsWith("/")) ?? "";
}

/** 取跳转地址里的 flash 文案（页面用 ?msg= 成功、?err= 失败） */
function flashOf(target: string, key: "msg" | "err"): string {
  try {
    return new URL(target, "http://localhost").searchParams.get(key) ?? "";
  } catch {
    return "";
  }
}

/** 兜底错误文案：只给收银员看一行，不把整串堆栈甩到页面上 */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "网络错误";
  return (raw || "网络错误").slice(0, 80);
}

/* ============================================================ 组件 */

/** 商超前台售卖（客户端 POS：点击加购、数量增减、小计实时变化，无刷新） */
export function ShopPOS({
  items,
  rooms,
  msg,
  err,
}: {
  items: PosItem[];
  rooms: PosRoom[];
  /**
   * 兼容参数：第七轮 一.2 之后**不再生效**，组件内部直接调用 sellCartAction
   *
   * 幂等要求 request_id 与业务字段在同一次请求里送到服务端，而 onSubmit 的入参是
   * 纯业务对象（page.tsx 的 submitOrder 只把 4 个字段塞进 FormData），
   * 通过它无法把 request_id 带过去。保留这个 prop 只是为了让
   * src/app/(main)/shop/page.tsx 不用改（本轮整改的文件白名单里没有它）。
   */
  onSubmit?: (payload: { itemId: number; qty: number; roomNo: string; method: string }) => Promise<void>;
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

  /*
   * 本次结算的幂等请求号
   *
   * 初值留空、挂载后在 effect 里生成：这个值会被渲染进隐藏字段的 value，
   * 若用 useState(() => newRequestId()) 初始化，服务端渲染与浏览器 hydration
   * 各算一次、值必然不同 → hydration mismatch 警告。
   */
  const [requestId, setRequestId] = useState("");
  /* 双击 / 连点闸门：同步置位，同一帧里的第二下进不来 */
  const busyRef = useRef(false);
  useEffect(() => {
    setRequestId((prev) => prev || newRequestId());
  }, []);

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

  /** 结算成功（首单成交或服务端幂等重放）：清空购物车，并换下一枚 request_id */
  const settleOk = (qty: number, amount: number) => {
    setTip({ kind: "ok", text: `已售出 ${qty} 件，合计 ¥${amount.toFixed(2)}` });
    setCart([]);
    /* 清单要求「结算成功后再生成下一次 UUID」：否则下一单会被当成重放吞掉 */
    setRequestId(newRequestId());
  };

  const submit = () => {
    /* 双击保护：第一下已经把它置 true，直到这次提交彻底结束才复位 */
    if (busyRef.current) return;
    if (cart.length === 0) {
      setTip({ kind: "err", text: "购物车为空，请先点商品" });
      return;
    }
    if (!roomNo) {
      setTip({ kind: "err", text: "挂房账请先选房号；现金收款可直接点收款" });
      return;
    }

    busyRef.current = true;
    /* 本次结算固定用这一枚：双击的第二下、网络重试、再点一次收款都复用它 */
    const rid = requestId || newRequestId();
    if (!requestId) setRequestId(rid);
    const qty = totalQty;
    const amount = total;

    const fd = new FormData();
    fd.set("item_id", String(cart[0].id));
    fd.set("qty", String(qty));
    fd.set("room_no", roomNo);
    fd.set("method", method);
    fd.set("request_id", rid);

    startTransition(async () => {
      try {
        await sellCartAction(fd);
        /* 正常情况下 action 一定 redirect（不会 resolve）：留作兜底 */
        settleOk(qty, amount);
      } catch (e) {
        const target = redirectTarget(e);
        if (target === null) {
          /* 网络中断 / 服务端 500：结果未知，保留同一 request_id，再点一次也不会变成两笔 */
          setTip({
            kind: "err",
            text: `提交未确认（${errorText(e)}），请再点一次收款；系统会按同一请求号幂等处理`,
          });
        } else if (/[?&]err=/.test(target)) {
          /* 业务失败（库存不足 / 商品下架 / 房号无人）：不换 request_id、不清购物车 */
          setTip({ kind: "err", text: flashOf(target, "err") || "结算失败，请按提示修改后重试" });
        } else {
          /* ?msg=：已成交（含服务端幂等重放）→ 清空购物车并换下一枚 request_id */
          settleOk(qty, amount);
        }
      } finally {
        busyRef.current = false;
      }
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
        <form
          className="border-t border-[#f0f0f0] px-3 py-2 text-[12px] text-[#555]"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {/* 幂等请求号随表单提交：同一次结算（同一份表单）重试复用同一个值 */}
          <input type="hidden" name="request_id" value={requestId} readOnly />
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
                type="submit"
                disabled={pending}
                className="h-7 rounded-[3px] bg-[#3bd943] px-3 text-[12px] text-white hover:bg-[#33cd3b] disabled:opacity-60"
              >
                {pending ? "提交中…" : "收款"}
              </button>
            </div>
            {cart.length > 0 && (
              <button
                type="button"
                onClick={clear}
                className="w-full text-[11px] text-[#999] hover:text-[#e53935]"
              >
                清空购物车
              </button>
            )}
          </div>
          {tip && (
            <div className={`mt-1.5 text-[11.5px] ${tip.kind === "ok" ? "text-[#2a9d5c]" : "text-[#e53935]"}`}>
              {tip.text}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
