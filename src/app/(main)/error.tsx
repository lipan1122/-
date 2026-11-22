"use client";

/**
 * 主界面错误边界（第九轮清单第 9 项）
 *
 * ── 解决的问题 ──
 *
 * `requirePermission()` 是 `throw new Error("FORBIDDEN: 缺少权限 xxx")`。
 * Next 16 会把 Server Action 抛出的异常渲染成默认错误页 —— 用户看到的是
 * 「Application error: a server-side exception has occurred」，
 * 既不知道是「没权限」还是「系统坏了」，也看不到是哪个权限。
 *
 * ── 为什么用 error boundary 而不是拆 100+ 个 action ──
 *
 * 拆成 `requirePermission`（throw）+ `checkPermission`（返回结构化结果）
 * 需要改 100+ 处 action 的返回类型、100+ 处调用方、以及所有相关测试。
 * 而 error boundary 是**一次覆盖全部**：
 *   · 服务端的拒绝逻辑**完全不变**（`requirePermission` 继续 throw）
 *   · 只改变「错误怎么呈现给用户」
 *   · 不暴露堆栈（Next 生产构建本来就不下发堆栈，这里再包一层）
 *
 * 这是清单允许的方案（第 255-262 行：「保留 requirePermission 作为安全守卫」
 * 「页面展示『没有该操作权限』」「不暴露堆栈」「不改变现有服务端拒绝逻辑」）。
 *
 * ── 判定逻辑 ──
 *
 * `requirePermission` 抛的消息形如：`FORBIDDEN: 缺少权限 cashier.refund`。
 * 这里匹配 `FORBIDDEN` 前缀 → 显示权限错误页；其他错误走通用兜底。
 */
import { useEffect } from "react";
import Link from "next/link";

/** 从错误里判断是不是权限拒绝，并尽量提取权限点 */
function parsePermissionError(error: Error & { digest?: string }) {
  const msg = String(error?.message ?? "");

  /* requirePermission 的固定前缀 */
  const m = msg.match(/FORBIDDEN[：:]\s*(?:缺少权限\s*)?([\w.]+)?/);
  if (m) return { isPermission: true, permission: m[1] ?? "" };

  /* 兜底：有些 action 直接抛中文「无权执行」 */
  if (/无权|没有.*权限|权限不足/.test(msg) && !/^Application error/i.test(msg)) {
    return { isPermission: true, permission: "" };
  }

  return { isPermission: false, permission: "" };
}

export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { isPermission, permission } = parsePermissionError(error);

  useEffect(() => {
    /*
     * 只把摘要打到浏览器控制台（便于客服让用户截图），
     * 不把完整堆栈渲染到页面上。
     */
    console.error("[PMS] 页面错误：", error.digest ?? "", String(error.message).slice(0, 200));
  }, [error]);

  if (isPermission) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="w-full max-w-[420px] rounded border border-amber-200 bg-amber-50 p-5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[18px]">🔒</span>
            <span className="text-[14px] font-semibold text-amber-900">没有该操作权限</span>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-amber-800">
            当前账号的角色不允许执行这个操作。这不是系统故障，数据没有任何改动。
            {permission && (
              <>
                <br />
                需要的权限点：<code className="rounded bg-white px-1 font-mono text-[11px]">{permission}</code>
              </>
            )}
          </p>
          <p className="mb-3 text-[11.5px] leading-relaxed text-amber-700">
            如果确实需要这个权限，请联系管理员在
            <b> 设置 → 权限管理 → 权限矩阵 </b>
            里为你的角色勾选。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded border border-amber-300 bg-white px-3 py-1.5 text-[12px] text-amber-800 hover:bg-amber-100"
            >
              返回重试
            </button>
            <Link
              href="/dashboard"
              className="rounded border border-amber-300 bg-white px-3 py-1.5 text-[12px] text-amber-800 hover:bg-amber-100"
            >
              去工作台
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-[420px] rounded border border-rose-200 bg-rose-50 p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[18px]">⚠</span>
          <span className="text-[14px] font-semibold text-rose-900">操作失败</span>
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-rose-800">
          这个操作没有完成。数据要么已回滚、要么没有被修改。
        </p>
        {/* 只显示摘要，不显示堆栈 */}
        <p className="mb-3 break-all rounded bg-white px-2 py-1.5 font-mono text-[11px] text-rose-700">
          {String(error.message ?? "").slice(0, 300) || "未知错误"}
        </p>
        {error.digest && (
          <p className="mb-3 text-[10.5px] text-rose-600">
            错误编号：<code className="font-mono">{error.digest}</code>（报障时请提供）
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded border border-rose-300 bg-white px-3 py-1.5 text-[12px] text-rose-800 hover:bg-rose-100"
          >
            重试
          </button>
          <Link
            href="/dashboard"
            className="rounded border border-rose-300 bg-white px-3 py-1.5 text-[12px] text-rose-800 hover:bg-rose-100"
          >
            去工作台
          </Link>
        </div>
      </div>
    </div>
  );
}
