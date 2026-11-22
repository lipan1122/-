"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 行内「操作 ▾」菜单：面板通过 portal 挂到 body，
 * 避免被表格滚动容器（overflow）裁切或遮挡。
 */
export function RowActionMenu({
  label = "操作",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, bottom: 0, up: false });
  const WIDTH = 172;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 340 > window.innerHeight;
    const left = Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8));
    setPos(
      up
        ? { left, top: 0, bottom: window.innerHeight - r.top + 4, up: true }
        : { left, top: r.bottom + 4, bottom: 0, up: false }
    );
    setOpen(true);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-[2px] text-[12px] leading-[18px] text-[#5f6b76] transition-colors hover:border-[#32c141] hover:text-[#32c141]"
      >
        {label}
        <span className={`text-[9px] transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.up ? undefined : pos.top,
              bottom: pos.up ? pos.bottom : undefined,
              width: WIDTH,
              zIndex: 200,
            }}
            className="max-h-[70vh] overflow-y-auto rounded-[2px] border border-[#e5e7eb] bg-white py-1 shadow-lg"
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}

export default RowActionMenu;
