"use client";

/**
 * 表格行内的「操作 ▾」下拉
 *
 * 用 portal 挂到 body 上 + fixed 定位，避免被表格的 overflow-x-auto 容器裁掉
 * （details + absolute 的写法在窄容器里会把菜单切掉，之前宾客列表和预订列表都踩过）。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function RowDropdown({
  label = "操作",
  children,
  width = 160,
}: {
  label?: string;
  children: ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const menuH = menuRef.current?.offsetHeight ?? 240;
    // 下方放不下就向上弹
    const above = r.bottom + menuH + 8 > vh;
    setPos({
      top: above ? Math.max(8, r.top - menuH - 4) : r.bottom + 4,
      left: Math.max(8, Math.min(r.left, vw - width - 8)),
    });
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-[2px] border bg-white px-2 py-[2px] text-[12px] leading-[18px] transition-colors ${
          open
            ? "border-[#32c141] text-[#32c141]"
            : "border-[#dcdcdc] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
        }`}
      >
        {label}
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[90] overflow-y-auto rounded-[2px] border border-[#e5e7eb] bg-white py-1 shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: "60vh" }}
            onClick={(e) => {
              // 菜单里的弹窗触发器（如「排房」）需要保持菜单打开
              if ((e.target as HTMLElement).closest("[data-keep-open]")) return;
              setOpen(false);
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
