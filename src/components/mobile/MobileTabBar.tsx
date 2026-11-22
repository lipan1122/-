"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 底部 Tab 导航（F13）
 *
 * 按角色显示不同 Tab —— 前台不需要看「财务」，客房不需要看「订单」。
 * 图标用纯 SVG（不引第三方图标库，包体积可控）。
 */

type Tab = { href: string; label: string; icon: React.ReactNode };

const I = {
  home: (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
      <path d="M3 10.5 12 3l9 7.5V21H3z" strokeLinejoin="round" />
      <path d="M9 21v-7h6v7" strokeLinejoin="round" />
    </svg>
  ),
  rooms: (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M7 4v16M17 4v16" />
    </svg>
  ),
  orders: (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M8 8h8M8 12h8M8 16h5" strokeLinecap="round" />
    </svg>
  ),
  cashier: (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
      <rect x="3" y="6" width="18" height="13" rx="1.5" />
      <path d="M3 10h18M7 15h4" strokeLinecap="round" />
    </svg>
  ),
  clean: (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
      <path d="M8 3h8l-1 6H9z" strokeLinejoin="round" />
      <path d="M9 9h6v12H9z" strokeLinejoin="round" />
      <path d="M7 13h2M15 13h2" strokeLinecap="round" />
    </svg>
  ),
  me: (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" strokeLinecap="round" />
    </svg>
  ),
};

const TABS_BY_ROLE: Record<string, Tab[]> = {
  admin: [
    { href: "/m", label: "工作台", icon: I.home },
    { href: "/m/rooms", label: "房态", icon: I.rooms },
    { href: "/m/orders", label: "订单", icon: I.orders },
    { href: "/m/cashier", label: "账务", icon: I.cashier },
    { href: "/m/me", label: "我的", icon: I.me },
  ],
  frontdesk: [
    { href: "/m", label: "工作台", icon: I.home },
    { href: "/m/rooms", label: "房态", icon: I.rooms },
    { href: "/m/orders", label: "订单", icon: I.orders },
    { href: "/m/cashier", label: "账务", icon: I.cashier },
    { href: "/m/me", label: "我的", icon: I.me },
  ],
  cashier: [
    { href: "/m", label: "工作台", icon: I.home },
    { href: "/m/cashier", label: "账务", icon: I.cashier },
    { href: "/m/me", label: "我的", icon: I.me },
  ],
  housekeeping: [
    { href: "/m", label: "工作台", icon: I.home },
    { href: "/m/housekeeping", label: "打扫", icon: I.clean },
    { href: "/m/me", label: "我的", icon: I.me },
  ],
};

export default function MobileTabBar({ role }: { role: string }) {
  const pathname = usePathname();
  const tabs = TABS_BY_ROLE[role] ?? TABS_BY_ROLE.frontdesk;

  return (
    <nav
      aria-label="移动端主导航"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-[#e5e5e5] bg-white/95 backdrop-blur"
    >
      <div className="mx-auto flex max-w-[520px]">
        {tabs.map((t) => {
          /* 首页精确匹配，其余前缀匹配（/m/rooms 下的子页也算选中） */
          const active = t.href === "/m" ? pathname === "/m" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              prefetch={false}
              className={`flex h-[56px] flex-1 flex-col items-center justify-center gap-0.5 ${
                active ? "text-[#1e8e3e]" : "text-[#8b949e]"
              }`}
            >
              <span className={active ? "text-[#1e8e3e]" : "text-[#8b949e]"}>{t.icon}</span>
              <span className={`text-[10.5px] ${active ? "font-medium" : ""}`}>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
