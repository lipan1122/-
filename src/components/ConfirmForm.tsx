"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 危险操作二次确认（整改报告 P2-10）
 *
 * 用于删除、取消入住、撤结账这类不可逆操作。
 *
 * 用法（包住一个表单）：
 *   <ConfirmForm action={deleteAction} message="确认删除这条预订？"
 *                detail="删除后无法恢复" requireReason="删除原因">
 *     <input type="hidden" name="id" value={id} />
 *     <button>删除</button>
 *   </ConfirmForm>
 *
 * 实现说明：
 *   - 用**原生 document capture 监听**拦提交，避免依赖 React 合成事件的传播边界
 *     （行内下拉菜单是 portal 渲染的，React 事件委托不一定能覆盖）
 *   - 弹窗用 createPortal 挂到 body，不会被父容器的 overflow / z-index 裁掉
 *   - 根节点带 data-keep-open，行内菜单不会因为点击而提前卸载本组件
 */
export default function ConfirmForm({
  action,
  message,
  detail,
  confirmLabel = "确认",
  cancelLabel = "取消",
  requireReason,
  danger = true,
  linkedFormId,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  requireReason?: string;
  danger?: boolean;
  /** 需要一起提交的外部表单 id（如批量操作表单 bkBatch） */
  linkedFormId?: string;
  children: React.ReactNode;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  /* 原生 capture 监听：按钮（含 portal 里的）点了就弹确认 */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest("button");
      if (!btn) return;
      if (btn.getAttribute("type") === "button") return;

      const wrap = wrapRef.current;
      const form = formRef.current;
      if (!wrap || !form) return;

      /* 只处理属于本组件的按钮 */
      const inThis = wrap.contains(btn) || form.contains(btn);
      if (!inThis) return;

      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);

  /* ESC 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /* 打开时聚焦输入框 */
  useEffect(() => {
    if (open) setTimeout(() => reasonRef.current?.focus(), 60);
  }, [open]);

  const doConfirm = useCallback(() => {
    if (requireReason && reason.trim().length === 0) return;
    const form = formRef.current;
    if (!form) return;

    setBusy(true);
    const fd = new FormData(form);
    if (linkedFormId) {
      const ext = document.getElementById(linkedFormId) as HTMLFormElement | null;
      if (ext) for (const [k, v] of new FormData(ext).entries()) fd.append(k, v);
    }
    if (requireReason) fd.set("reason", reason.trim());

    Promise.resolve(action(fd))
      .catch(() => {
        /* redirect / NEXT_REDIRECT 属于正常流程，这里忽略 */
      })
      .finally(() => {
        setBusy(false);
        setOpen(false);
        setReason("");
      });
  }, [action, requireReason, reason, linkedFormId]);

  return (
    <div ref={wrapRef} className="contents" data-keep-open data-confirm-id={uid}>
      <form ref={formRef} action={() => {}} className="contents">
        {children}
      </form>

      {mounted &&
        open &&
        createPortal(
          <div
            className="fixed inset-0 z-[500] flex items-center justify-center bg-black/30 p-4"
            role="dialog"
            aria-modal="true"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div className="w-full max-w-[390px] overflow-hidden rounded-[4px] bg-white shadow-xl">
              <div
                className={`flex items-center gap-2 px-4 py-2.5 text-[13px] font-semibold ${
                  danger ? "bg-[#fdf3f3] text-[#c0392b]" : "bg-[#f1f9f3] text-[#1e8e3e]"
                }`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[12px]">
                  !
                </span>
                <span className="flex-1">{message}</span>
              </div>

              <div className="px-4 py-3">
                {detail && <p className="text-[12px] leading-relaxed text-gray-600">{detail}</p>}
                {requireReason && (
                  <div className="mt-2.5">
                    <label className="mb-1 block text-[11.5px] text-gray-500">{requireReason}（必填）</label>
                    <input
                      ref={reasonRef}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && reason.trim()) doConfirm();
                      }}
                      placeholder="请填写原因"
                      className="h-7 w-full rounded-[2px] border border-[#dcdcdc] px-2 text-[12px] outline-none focus:border-[#32c141]"
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-[28px] items-center rounded-[2px] border border-[#dcdcdc] bg-white px-3 text-[12px] text-[#5f6b76] hover:border-[#bbb]"
                >
                  {cancelLabel}
                </button>
                <button
                  type="button"
                  onClick={doConfirm}
                  disabled={busy || (!!requireReason && reason.trim().length === 0)}
                  className={`inline-flex h-[28px] items-center rounded-[2px] px-3 text-[12px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:bg-[#c9c9c9] ${
                    danger ? "bg-[#d9534f] hover:bg-[#c9302c]" : "bg-[#32c141] hover:bg-[#2bb038]"
                  }`}
                >
                  {busy ? "处理中…" : confirmLabel}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
