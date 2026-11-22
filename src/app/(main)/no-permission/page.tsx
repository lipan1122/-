import Link from "next/link";
import { getSession, PERMISSION_LABELS } from "@/lib/session";

/**
 * 「没有该操作权限」提示页（第十轮验收 P2）
 *
 * ── 为什么需要这一页 ──
 *
 * 生产构建下，Server Action 里 `throw new Error("FORBIDDEN: 缺少权限 xxx")`
 * 的错误消息会被 Next 脱敏成只剩 digest（响应体 `1:E{"digest":"…"}`），
 * 于是 (main)/error.tsx 只能走通用分支，显示「操作失败」+ React error #441 ——
 * 用户以为系统坏了，而不是「我的角色没这个权限」。
 *
 * 修法（方案 A）：服务端不再把权限拒绝当异常，而是
 *   · 页面：checkPermission(user, p) 不通过 → redirect(`/no-permission?p=…`)
 *   · 动作：requirePermissionOrRedirect(p) 不通过 → 同一个跳转
 * 本页只负责把「哪个权限点」翻译成人话，不读任何业务数据。
 *
 * ── 路由守卫 ──
 *
 * 本页在 (main) 路由组内，会经过 layout 的角色守卫；/no-permission 已加入
 * session.ts 的 AUTHENTICATED_ONLY_PATHS（任何已登录账号都放行），
 * 否则被拒用户会被二次重定向回工作台，永远看不到这句话。
 *
 * ── 为什么没有「返回上一页」按钮 ──
 *
 * router.back() 需要客户端组件；这里保持纯服务端渲染，避免为一个按钮引入
 * "use client" 边界。保留浏览器自带的返回即可，页面只给「去工作台」和
 * 「打开权限矩阵」（后者仅 admin 可达，非管理员点进去会被路由守卫挡回并提示原因）。
 */
export default async function NoPermissionPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const sp = await searchParams;
  const user = await getSession();

  /*
   * 权限点来自 URL，属于不可信输入：
   *   · 只接受 `模块.动作` 形态的短字符串（不合法就不展示，避免把任意文本渲染出来）；
   *   · 中文名只查服务端常量表，不做任何 HTML 拼接 —— React 默认转义，双重保险。
   */
  const raw = typeof sp.p === "string" ? sp.p.trim().slice(0, 64) : "";
  const permission = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/.test(raw) ? raw : "";
  const label = permission ? PERMISSION_LABELS[permission] : undefined;

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-[460px] rounded border border-amber-200 bg-amber-50 p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[18px]">🔒</span>
          <span className="text-[14px] font-semibold text-amber-900">没有该操作权限</span>
        </div>

        <p className="mb-3 text-[12px] leading-relaxed text-amber-800">
          当前账号
          {user ? (
            <>
              （<b>{user.realName || user.username}</b> / 角色 <code className="rounded bg-white px-1 font-mono text-[11px]">{user.role}</code>）
            </>
          ) : null}
          的角色不允许执行这个操作。这不是系统故障，数据没有任何改动。
        </p>

        {permission && (
          <p className="mb-3 text-[12px] leading-relaxed text-amber-800">
            需要的权限点：
            <code className="rounded bg-white px-1 font-mono text-[11px]">{permission}</code>
            {label ? <span className="ml-1">（{label}）</span> : null}
          </p>
        )}

        <p className="mb-3 text-[11.5px] leading-relaxed text-amber-700">
          如果确实需要这个权限，请联系管理员在
          <b> 设置 → 权限管理 → 权限矩阵 </b>
          里为你的角色勾选；保存后下一个请求就会生效，无需重启服务。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/dashboard"
            className="rounded border border-amber-300 bg-white px-3 py-1.5 text-[12px] text-amber-800 hover:bg-amber-100"
          >
            去工作台
          </Link>
          {/* 权限矩阵在 /settings（仅 admin 可达）：非管理员点进去会被路由守卫挡回工作台并提示原因 */}
          <Link
            href="/settings?tab=rbac"
            className="rounded border border-amber-300 bg-white px-3 py-1.5 text-[12px] text-amber-800 hover:bg-amber-100"
          >
            打开权限矩阵（仅管理员）
          </Link>
        </div>
      </div>
    </div>
  );
}
