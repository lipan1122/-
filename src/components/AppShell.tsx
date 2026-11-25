"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------ 第一行导航 */

type NavItem = {
  href: string;
  label: string;
  badge?: "channel";
  /** 只有 admin 看得到（比如演示数据入口，不该给前台看到） */
  adminOnly?: boolean;
};

const MAIN_NAV: NavItem[] = [
  { href: "/rooms", label: "房态" },
  { href: "/bookings/new", label: "新增预订" },
  { href: "/channel-orders", label: "渠道预订", badge: "channel" },
  { href: "/frontdesk", label: "散客步入" },
  { href: "/guests", label: "宾客列表" },
  { href: "/reports", label: "统计报表" },
  { href: "/meal-vouchers", label: "餐券核销" },
  { href: "/channels", label: "直连管理" },
  { href: "/shop", label: "商超" },
  { href: "/today-todo", label: "今日待办" },
  { href: "/handover", label: "交班汇总" },
  { href: "/invoices", label: "发票台账" },
  /*
   * 演示数据入口
   *
   * 原来只在「设置 → 演示数据」（要点进设置、再点左侧第 22 项菜单），
   * 埋得太深找不到。这里放到顶部主菜单，admin 一眼可见。
   * 前台/收银/客房不需要这个功能，所以 adminOnly。
   */
  { href: "/settings?tab=demo", label: "演示数据", adminOnly: true },
];

/* ------------------------------------------------------------ 更多下拉 */

type MoreItem = { href: string; label: string };
type MoreGroup = { title?: string; items: MoreItem[] };

const MORE_GROUPS: MoreGroup[] = [
  {
    title: "增值服务",
    items: [
      { href: "/app-client", label: "APP客户端" },
      { href: "/lease", label: "物品租赁" },
      { href: "/lost-found", label: "失物招领" },
    ],
  },
  {
    title: "渠道与订单",
    items: [
      { href: "/channels", label: "渠道直连" },
      { href: "/orders", label: "订单列表" },
    ],
  },
  {
    title: "客史与会员",
    items: [
      { href: "/guests", label: "宾客档案" },
      { href: "/members", label: "会员管理" },
      { href: "/members/wallet", label: "会员储值" },
      { href: "/member-cards", label: "会员卡设置" },
      { href: "/points", label: "会员积分" },
      { href: "/companies", label: "协议单位" },
    ],
  },
  {
    title: "财务",
    items: [
      { href: "/finance", label: "财务应收" },
      { href: "/ar", label: "AR应收管理" },
      { href: "/quotes", label: "报价管理" },
      { href: "/dummy-rooms", label: "哑房管理" },
    ],
  },
  {
    title: "服务",
    items: [
      { href: "/meal-vouchers", label: "餐券核销" },
      { href: "/breakfast", label: "早餐核销" },
      { href: "/shop", label: "商超" },
      { href: "/goods", label: "商品库存" },
      { href: "/rental", label: "物品租赁" },
      { href: "/lost-found", label: "失物招领" },
      { href: "/sms", label: "短信服务" },
    ],
  },
  {
    title: "系统",
    items: [
      { href: "/id-verify", label: "人证核验" },
      { href: "/inhouse", label: "在住客人" },
      { href: "/cashier", label: "收银台" },
      { href: "/housekeeping", label: "客房中心" },
      { href: "/cleaners", label: "打扫员" },
      { href: "/night-audit", label: "夜审" },
      { href: "/notices", label: "通知公告" },
      { href: "/query-logs", label: "查询日志" },
      { href: "/logs", label: "操作日志" },
      { href: "/lock-settings", label: "门锁设置" },
      { href: "/wechat", label: "微酒店" },
      { href: "/settings", label: "系统设置" },
    ],
  },
];

/* ------------------------------------------------------------ 第三行标签栏 */

/** 常驻标签：房态三页，永远存在、没有 ×（与去呼呼一致） */
const PAGE_TABS = [
  { href: "/rooms", label: "实时房态", exact: true },
  { href: "/rooms/forecast", label: "远期房态", exact: false },
  { href: "/rooms/predict", label: "房型可售预测", exact: false },
];

type OpenTab = { href: string; label: string };

/** 导航项索引：MAIN_NAV 优先，其次 MORE_GROUPS（同一 href 只取第一次出现的名字） */
const NAV_LABELS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const item of MAIN_NAV) if (!out[item.href]) out[item.href] = item.label;
  for (const group of MORE_GROUPS) {
    for (const item of group.items) if (!out[item.href]) out[item.href] = item.label;
  }
  return out;
})();

/** 不在导航里的兜底名字 */
const EXTRA_LABELS: Record<string, string> = {
  "/dashboard": "首页",
  "/bookings": "预订单",
  "/logout": "退出登录",
};

/** 导航 + 兜底的统一索引（用于精确匹配与子路由前缀匹配） */
const ALL_LABELS: Record<string, string> = { ...NAV_LABELS, ...EXTRA_LABELS };

/** 英文路径段兜底：lost-found → Lost Found */
function prettifySegment(seg: string) {
  return seg
    .split("-")
    .filter(Boolean)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * 路由 → 应当出现在标签栏里的标签。
 * · 房态三页返回空数组：由常驻标签负责，不重复加入
 * · /bookings/new 同时打开「散客预订」「团队预订」
 * · 其余页面用导航项 label，导航外的页面从 pathname 推导
 */
function resolveTabs(pathname: string): OpenTab[] {
  const path = pathname.split("?")[0] || "/";

  if (path === "/rooms" || path.startsWith("/rooms/")) return [];

  if (path === "/bookings/new") {
    return [
      { href: "/bookings/new", label: "散客预订" },
      { href: "/bookings/new?type=team", label: "团队预订" },
    ];
  }

  const exact = ALL_LABELS[path];
  if (exact) return [{ href: path, label: exact }];

  // 子路由（/guests/123、/members/wallet…）：借用最近一级导航项的名字
  let bestHref = "";
  for (const href of Object.keys(ALL_LABELS)) {
    if (path.startsWith(href + "/") && href.length > bestHref.length) bestHref = href;
  }
  if (bestHref) return [{ href: path, label: ALL_LABELS[bestHref] }];

  const first = path.split("/").filter(Boolean)[0] ?? "";
  return [{ href: path, label: prettifySegment(first) || "首页" }];
}

/* ------------------------------------------------------------ 标签栏组件 */

/**
 * 第三行标签栏。
 * · 房态三页（实时房态 / 远期房态 / 房型可售预测）常驻，没有 ×
 * · 其余页面点开即生成一个带 × 的标签，可单独关闭；右侧「关闭全部」回到房态
 */
function TabBar({ pathname }: { pathname: string }) {
  const router = useRouter();
  // 预订页的「散客 / 团队」只差一个 query，需要响应式地读 search
  const search = useSearchParams().toString();
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);

  // 路由变化 → 把当前页面加入标签；房态三页跳过（已常驻）
  useEffect(() => {
    const want = resolveTabs(pathname);
    if (want.length === 0) return;
    setOpenTabs((prev) => {
      const missing = want.filter((w) => !prev.some((t) => t.href === w.href));
      return missing.length ? [...prev, ...missing] : prev;
    });
  }, [pathname]);

  // 当前 pathname（+ 预订页的 ?type）命中的标签
  const isTabActive = useCallback(
    (tab: OpenTab) => {
      if (tab.href === "/bookings/new") return pathname === "/bookings/new" && !search.includes("type=team");
      if (tab.href === "/bookings/new?type=team")
        return pathname === "/bookings/new" && search.includes("type=team");
      return pathname === tab.href || pathname.startsWith(tab.href + "/");
    },
    [pathname, search]
  );

  const closeTab = (tab: OpenTab) => {
    setOpenTabs((prev) => prev.filter((t) => t.href !== tab.href));
    // 关掉的是当前页 → 回房态
    if (isTabActive(tab)) router.push("/rooms");
  };

  const closeAllTabs = () => {
    setOpenTabs([]);
    router.push("/rooms");
  };

  // 显示条件：房态页常驻显示；其他页面只有打开了标签才显示
  if (!(pathname.startsWith("/rooms") || openTabs.length > 0)) return null;

  return (
    <div className="h-9 shrink-0 bg-[#e9edf1] shadow-[inset_0_-1px_0_0_#d7dde5]">
      <div className="flex h-9 items-center gap-1 overflow-x-auto px-2">
        {/* 常驻标签：无 ×（与去呼呼一致） */}
        {PAGE_TABS.map((t) => {
          const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          return (
            <Link
              prefetch={false}
              key={t.href}
              href={t.href}
              className={`relative flex h-7 shrink-0 items-center rounded-[3px] px-2.5 text-[12px] leading-4 whitespace-nowrap transition-colors ${
                active
                  ? "bg-white font-medium text-[#0f8f6f] shadow-sm"
                  : "bg-[#f5f6f7] text-gray-600 hover:bg-white hover:text-[#0f8f6f]"
              }`}
            >
              {active && <span className="absolute left-1 top-1 h-1 w-1 rounded-full bg-[#0f8f6f]" />}
              {t.label}
            </Link>
          );
        })}

        <span className="mx-0.5 h-4 w-px shrink-0 bg-[#c9d2dc]" />

        {/* 动态标签：带 ×，可单独关闭 */}
        {openTabs.map((t) => {
          const active = isTabActive(t);
          return (
            <span
              key={t.href}
              className={`relative flex h-7 shrink-0 items-center overflow-hidden rounded-[3px] text-[12px] leading-4 transition-colors ${
                active ? "bg-white font-medium text-[#0f8f6f] shadow-sm" : "bg-[#f5f6f7] text-gray-600 hover:bg-white"
              }`}
            >
              {active && <span className="absolute left-1 top-1 h-1 w-1 rounded-full bg-[#0f8f6f]" />}
              <Link
              prefetch={false}
                href={t.href}
                title={t.label}
                className="flex h-7 items-center pr-1 pl-2.5 whitespace-nowrap hover:text-[#0f8f6f]"
              >
                {t.label}
              </Link>
              <button
                type="button"
                title={`关闭 ${t.label}`}
                aria-label={`关闭 ${t.label}`}
                onClick={() => closeTab(t)}
                className="flex h-7 w-[18px] shrink-0 items-center justify-center pr-1.5 text-[12px] leading-none text-gray-400 transition-colors hover:text-red-500"
              >
                ×
              </button>
            </span>
          );
        })}

        <button
          type="button"
          onClick={closeAllTabs}
          className="ml-auto flex h-7 shrink-0 items-center rounded-[3px] px-2 text-[12px] leading-4 text-gray-500 hover:bg-white hover:text-[#0f8f6f]"
        >
          关闭全部
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 右侧胶囊 */

const PILL_CLS =
  "shrink-0 rounded-[3px] bg-[#0f8f6f] px-3 py-1 text-[12px] leading-4 text-white transition-colors hover:bg-[#0d7a5f]";

function shiftLabel() {
  const h = new Date().getHours();
  if (h >= 8 && h < 16) return "早班";
  if (h >= 16 && h < 23) return "中班";
  return "夜班";
}

function isNavActive(href: string, pathname: string) {
  if (href === "/rooms") return pathname === "/rooms";
  const base = href.split("?")[0];
  return pathname === base || pathname.startsWith(base + "/");
}

export default function AppShell({
  user,
  bizDate,
  pendingChannelOrders,
  demoMode = false,
  children,
}: {
  user: { realName: string; role: string; hotelName: string };
  /**
   * 是否演示模式（服务端 isDemoMode() 传下来）
   *
   * AppShell 是客户端组件，process.env 在浏览器里是构建期空值，
   * 所以不能在这里自己读环境变量 —— 必须由服务端 layout 传。
   * 控制「顶部导航里的『演示数据』入口」是否出现。
   */
  demoMode?: boolean;
  /** 服务端算好的营业日（按设置的切换时间） */
  bizDate?: string;
  /** 待处理渠道订单数；不传时「渠道预订」旁只显示一个小红点 */
  pendingChannelOrders?: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setMoreOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [moreOpen]);

  const openMore = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const width = 720;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setMenuPos({ left, top: r.bottom + 6 });
    }
    setMoreOpen((v) => !v);
  };

  const channelBadge =
    typeof pendingChannelOrders === "number" && pendingChannelOrders > 0 ? pendingChannelOrders : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="relative z-40 shrink-0 bg-gradient-to-r from-[#2b9b74] via-[#1f9a8f] to-[#14a3a4] text-white">
        {/* 1 ─ 营业日条 */}
        <div className="flex h-11 items-center gap-3 px-3">
          <div className="flex items-center gap-1.5 rounded bg-white/15 px-2 py-0.5 text-[12px]">
            <span className="text-white/75">营业日</span>
            <b className="font-semibold">{bizDate ?? "—"}</b>
            <span>{shiftLabel()}</span>
          </div>
          {/* 去呼呼每页营业日旁都有「夜审」按钮 */}
          <Link
              prefetch={false}
            href="/night-audit"
            className="rounded bg-white/15 px-2 py-0.5 text-[12px] hover:bg-white/25"
            title="夜审日结"
          >
            夜审
          </Link>
          <Link prefetch={false} href="/dashboard" className="max-w-[220px] truncate text-[13px] font-medium hover:underline">
            {user.hotelName}
          </Link>
          {searchOpen ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = q.trim();
                if (v) {
                  router.push(`/search?q=${encodeURIComponent(v)}`);
                  setSearchOpen(false);
                  setQ("");
                }
              }}
              className="flex items-center gap-1"
            >
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                placeholder="客人 / 房号 / 订单号，回车搜索"
                className="h-6 w-[220px] rounded bg-white px-2 text-[12px] text-gray-800 outline-none placeholder:text-gray-400 focus-visible:ring-2 focus-visible:ring-brand-300"
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="全局搜索"
              className="flex h-6 w-6 items-center justify-center rounded bg-white/15 hover:bg-white/25"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-white stroke-2">
                <circle cx="11" cy="11" r="6.5" />
                <path d="M16 16l4.5 4.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <div className="ml-auto flex items-center gap-2 text-[11px] text-white/85">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/25 text-[11px] font-semibold">
              {user.realName.slice(0, 1)}
            </div>
            <span className="hidden max-w-[120px] truncate align-bottom sm:inline-block">{user.realName}</span>
            <span className="hidden max-w-[80px] truncate align-bottom text-white/60 md:inline-block">{user.role}</span>
            <span className="mx-1 h-4 w-px bg-white/25" />
            <Link prefetch={false} href="/api/logout" className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">
              退出
            </Link>
          </div>
        </div>

        {/* 2 ─ 导航（项间 gap 更紧，当前项白底深绿字） */}
        <nav className="flex h-10 items-center gap-0.5 px-2 pb-1">
          {MAIN_NAV.filter((item) => (!item.adminOnly || user.role === "admin") && (item.href !== "/settings?tab=demo" || demoMode)).map((item) => {
            const active = isNavActive(item.href, pathname);
            return (
              <Link
              prefetch={false}
                key={item.href}
                href={item.href}
                className={`flex shrink-0 items-center rounded-[3px] px-2 py-1.5 text-[13px] leading-4 transition-colors ${
                  active ? "bg-white font-medium text-[#0f7a5f] shadow-sm" : "text-white/90 hover:bg-white/15"
                }`}
              >
                {item.label}
                {item.badge === "channel" &&
                  (channelBadge !== null ? (
                    <span className="ml-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
                      {channelBadge > 99 ? "99+" : channelBadge}
                    </span>
                  ) : (
                    <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500 ring-1 ring-white/70" />
                  ))}
              </Link>
            );
          })}

          <button
            ref={btnRef}
            onClick={openMore}
            className={`flex shrink-0 items-center gap-1 rounded-[3px] px-2 py-1.5 text-[13px] leading-4 transition-colors ${
              moreOpen ? "bg-white font-medium text-[#0f7a5f]" : "text-white/90 hover:bg-white/15"
            }`}
          >
            更多
            <span className={`text-[9px] transition-transform ${moreOpen ? "rotate-180" : ""}`}>▾</span>
          </button>

          {/* 右侧三个绿色胶囊 */}
          <div className="ml-auto flex items-center gap-1.5 pl-2">
            <Link prefetch={false} href="/lock-settings" className={PILL_CLS}>
              酒店门锁
            </Link>
            <Link prefetch={false} href="/wechat" className={PILL_CLS}>
              丽呈清居
            </Link>
            <button type="button" onClick={() => showToast("去呼呼管家为外部系统")} className={PILL_CLS}>
              去呼呼管家
            </button>
          </div>
        </nav>

        {/* 3 ─ 标签栏（房态页常驻显示；其他页面有打开的标签时显示） */}
        <Suspense fallback={null}>
          <TabBar pathname={pathname} />
        </Suspense>
      </header>

      {/* 更多：fixed 定位，不受导航 overflow 裁剪 */}
      {moreOpen && (
        <div
          ref={panelRef}
          style={{ left: menuPos.left, top: menuPos.top, position: "fixed" }}
          className="z-[100] max-h-[calc(100vh-120px)] w-[720px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-3 text-gray-700 shadow-2xl"
        >
          <div className="grid grid-cols-3 gap-3">
            {MORE_GROUPS.map((g, gi) => (
              <div key={g.title ?? `flat-${gi}`}>
                {g.title && (
                  <div className="mb-1 border-b border-gray-100 pb-1 text-[12px] font-medium uppercase tracking-wider text-gray-400">
                    {g.title}
                  </div>
                )}
                <div className="space-y-0.5">
                  {g.items.map((m) => {
                    const active = pathname === m.href || pathname.startsWith(m.href + "/");
                    return (
                      <Link
              prefetch={false}
                        key={m.href}
                        href={m.href}
                        onClick={() => setMoreOpen(false)}
                        className={`block rounded px-2 py-1.5 text-[12px] ${
                          active ? "bg-brand-50 font-medium text-brand-700" : "hover:bg-gray-50 hover:text-brand-700"
                        }`}
                      >
                        {m.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto bg-[#f2f4f7]">{children}</main>

      {toast && (
        <div className="fixed left-1/2 top-24 z-[200] -translate-x-1/2 rounded bg-black/80 px-3.5 py-2 text-[12px] text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
