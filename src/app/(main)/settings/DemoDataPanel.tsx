"use client";

/**
 * 演示数据导入面板（设置页「演示数据」Tab 用）
 *
 * 为什么是客户端组件：
 *   · 需要显示「当前库有多少数据」→ 点击时调 action 查
 *   · 需要二次确认（覆盖有真实数据时必须让用户看见）
 *   · 需要展示导入结果（成功/失败）
 *
 * 为什么不直接放表单：
 *   Server Action 返回值要渲染到页面上，用 useActionState 最直接；
 *   但这里还要在提交前查一次数据量，所以用显式 state 管理。
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { countBusinessDataAction, loadDemoDataAction } from "./demo-actions";
import { clearBusinessDataAction } from "./clear-data-actions";

type Counts = { rooms: number; bookings: number; stays: number; folios: number };

export default function DemoDataPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /* 清空数据：展开确认区 + 「清空」两字校验 */
  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState("");

  const check = () => {
    setChecking(true);
    setMsg(null);
    startTransition(async () => {
      try {
        const c = await countBusinessDataAction();
        setCounts(c);
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof Error ? e.message : "查询失败" });
      } finally {
        setChecking(false);
      }
    });
  };

  const load = () => {
    setMsg(null);
    startTransition(async () => {
      try {
        const r = await loadDemoDataAction();
        if ("error" in r) {
          setMsg({ kind: "err", text: r.error });
        } else {
          setMsg({ kind: "ok", text: r.ok });
          setCounts(null);
          router.refresh();
        }
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof Error ? e.message : "导入失败" });
      }
    });
  };

  const clearAll = () => {
    setMsg(null);
    startTransition(async () => {
      try {
        const r = await clearBusinessDataAction(clearText);
        if ("error" in r) {
          setMsg({ kind: "err", text: r.error });
        } else {
          setMsg({ kind: "ok", text: r.ok });
          setCounts(null);
          setClearOpen(false);
          setClearText("");
          router.refresh();
        }
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof Error ? e.message : "清空失败" });
      }
    });
  };

  const hasRealData = counts !== null && (counts.bookings > 0 || counts.stays > 0);

  return (
    <div className="card p-4">
      <div className="mb-3 border-b border-gray-100 pb-2">
        <div className="text-[13px] font-semibold text-gray-800">演示数据</div>
        <div className="mt-1 text-[11.5px] leading-relaxed text-gray-500">
          一键导入一整套演示数据：46 间房、588 条预订、200 张账单、45 个客人、会员储值、AR 应收，
          68 张报表立刻有数。适合给客户演示、给同事试用、培训新人。
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800">
          <b>⚠ 会覆盖现有数据</b>
          <div className="mt-0.5">
            导入会清空并重写 62 张业务表（房间、预订、入住、账单、客人、会员…）。
            参数、账号、权限矩阵等配置类数据保留。
          </div>
        </div>

        {!counts && (
          <button
            type="button"
            onClick={check}
            disabled={pending || checking}
            className="btn-default px-3 py-1.5 text-[12px]"
          >
            {checking ? "查询中…" : "先看看当前有多少数据"}
          </button>
        )}

        {counts && (
          <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11.5px] text-gray-600">
            当前库：<b>{counts.rooms}</b> 间房 · <b>{counts.bookings}</b> 条预订 ·{" "}
            <b>{counts.stays}</b> 张入住单 · <b>{counts.folios}</b> 张账单
            {hasRealData && (
              <div className="mt-1 text-rose-600">
                已经有业务数据了 —— 导入会把它们全部覆盖掉。
              </div>
            )}
          </div>
        )}

        {counts && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={pending}
              className={`px-3 py-1.5 text-[12px] text-white ${
                hasRealData
                  ? "rounded bg-rose-600 hover:bg-rose-700"
                  : "rounded bg-brand-500 hover:bg-brand-600"
              } disabled:opacity-50`}
            >
              {pending ? "导入中…" : hasRealData ? "确认覆盖并导入演示数据" : "导入演示数据"}
            </button>
            <button
              type="button"
              onClick={() => setCounts(null)}
              disabled={pending}
              className="px-2 py-1.5 text-[12px] text-gray-500 hover:underline"
            >
              取消
            </button>
          </div>
        )}

        {msg && (
          <pre
            className={`whitespace-pre-wrap rounded border px-3 py-2 text-[11.5px] leading-relaxed ${
              msg.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {msg.text}
          </pre>
        )}

        <div className="border-t border-gray-100 pt-2 text-[11px] leading-relaxed text-gray-400">
          导入后 4 个演示账号的密码会重置为：
          <span className="ml-1 font-mono">admin/admin123</span> ·
          <span className="ml-1 font-mono">front/123456</span> ·
          <span className="ml-1 font-mono">cashier/123456</span> ·
          <span className="ml-1 font-mono">housekeeper/123456</span>
        </div>

        {/* ===== 清空业务数据（正式上线前用） ===== */}
        <div className="border-t border-gray-200 pt-3">
          <div className="mb-1.5 text-[12px] font-semibold text-gray-700">清空业务数据</div>
          <div className="mb-2 text-[11.5px] leading-relaxed text-gray-500">
            删掉所有预订、入住单、账单、流水、客人档案、会员储值、应收台账、发票、渠道订单，
            房间状态重置为空净。
            <b className="text-gray-600">保留</b>房间与房型、渠道、协议单位、参数、账号与权限矩阵。
          </div>

          {!clearOpen && (
            <button
              type="button"
              onClick={() => {
                setClearOpen(true);
                setMsg(null);
              }}
              className="rounded border border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700 hover:bg-rose-100"
            >
              清空业务数据
            </button>
          )}

          {clearOpen && (
            <div className="rounded border border-rose-300 bg-rose-50 p-3">
              <div className="mb-1.5 text-[11.5px] font-medium text-rose-800">
                确认清空？此操作不可撤销。
              </div>
              <div className="mb-2 text-[11px] leading-relaxed text-rose-700">
                输入「<b>清空</b>」两个字以确认：
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={clearText}
                  onChange={(e) => setClearText(e.target.value)}
                  placeholder="清空"
                  disabled={pending}
                  className="input h-7 w-[110px] px-2 text-[12px]"
                />
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={pending || clearText.trim() !== "清空"}
                  className="rounded bg-rose-600 px-3 py-1.5 text-[12px] text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pending ? "清空中…" : "确认清空"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setClearOpen(false);
                    setClearText("");
                  }}
                  disabled={pending}
                  className="px-2 py-1.5 text-[12px] text-gray-500 hover:underline"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-gray-100 pt-2 text-[11px] leading-relaxed text-gray-400">
          命令行等价操作：
          <span className="ml-1 font-mono">node scripts/init-db.mjs --reset</span>
          （会连表结构和房型一起重建）
        </div>
      </div>
    </div>
  );
}
