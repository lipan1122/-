"use client";

import { useState } from "react";

/**
 * 一键填入演示账号（本地/演示环境专用）
 *
 * ── 为什么做成独立组件 + 开关 ──
 *
 * 上线前安全审计指出：「登录页硬编码展示 admin/admin123，且口令真实有效，
 * 任何能打开登录页的人直接接管管理员」。所以默认版本已经删掉了明文口令展示。
 *
 * 但演示/测试时每次手输 4 个账号确实麻烦，所以这里提供一个**一键填入**，
 * 由服务端通过 props 控制是否渲染：
 *   · 环境变量 PMS_DEMO_LOGIN=1（或未设置时的默认值）→ 显示
 *   · PMS_DEMO_LOGIN=0 → 完全不渲染，生产环境看不到任何账号口令
 *
 * 注意：按钮本身不写死口令，账号列表由服务端传入，
 * 这样改演示账号时只改一处（服务端的 DEMO_ACCOUNTS）。
 */

export type DemoAccount = { label: string; username: string; password: string };

export default function DemoLoginFill({ accounts }: { accounts: DemoAccount[] }) {
  const [filled, setFilled] = useState<string | null>(null);

  function fill(acc: DemoAccount) {
    /* 直接操作 DOM：登录表单是普通 <form action="/api/login">，
       不走 React 受控组件，这样改动最小、不涉及表单重构 */
    const u = document.querySelector<HTMLInputElement>('input[name="username"]');
    const p = document.querySelector<HTMLInputElement>('input[name="password"]');
    const h = document.querySelector<HTMLInputElement>('input[name="hotel_code"]');
    if (u) {
      u.value = acc.username;
      u.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (p) {
      p.value = acc.password;
      p.dispatchEvent(new Event("input", { bubbles: true }));
    }
    /* 单店部署不需要酒店标识，清空避免上次残留 */
    if (h) h.value = "";
    setFilled(acc.username);
    /* 填完把焦点给密码框，回车即可登录 */
    p?.focus();
  }

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium text-gray-600">演示账号（点一下自动填入）</span>
        <span className="text-[11px] text-gray-400">PMS_DEMO_LOGIN=0 可关闭</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {accounts.map((acc) => (
          <button
            key={acc.username}
            type="button"
            onClick={() => fill(acc)}
            className={`flex items-center justify-between rounded border px-2 py-1.5 text-left text-[12px] transition ${
              filled === acc.username
                ? "border-brand-500 bg-[#eef9f0] text-[#0f8f6f]"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            }`}
          >
            <span className="font-medium">{acc.label}</span>
            <span className="font-mono text-[11px] text-gray-400">{acc.username}</span>
          </button>
        ))}
      </div>
      {filled && (
        <div className="mt-2 text-[11px] text-gray-400">
          已填入 <span className="font-mono">{filled}</span>，按回车即可登录
        </div>
      )}
    </div>
  );
}
