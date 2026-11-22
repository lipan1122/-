"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { closeShiftAction, openShiftAction, type ActionState } from "@/app/(main)/handover/actions";

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-[30px] items-center rounded-[2px] border border-[#32c141] bg-[#32c141] px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-[#2bb038] disabled:cursor-not-allowed disabled:border-[#e0e0e0] disabled:bg-[#f5f5f5] disabled:text-[#b8b8b8]"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Flash({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.ok) {
    return (
      <div className="rounded-[2px] border border-[#b7e0c4] bg-[#f1f9f3] px-3 py-1.5 text-[12px] text-[#1e8e3e]">
        {state.ok}
      </div>
    );
  }
  return (
    <div className="rounded-[2px] border border-[#f5c2c2] bg-[#fdf3f3] px-3 py-1.5 text-[12px] text-[#c0392b]">
      {state.error}
    </div>
  );
}

/** 开班表单 */
export function OpenShiftForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    async (_prev: ActionState, fd: FormData) => openShiftAction(fd),
    undefined
  );

  return (
    <form action={action} className="space-y-3 px-4 py-4">
      <div className="max-w-[240px]">
        <label className="label">备用金（开班时钱箱里的现金）</label>
        <input
          name="opening_cash"
          type="number"
          min="0"
          step="0.01"
          defaultValue="0"
          className="input h-8 w-full text-[12px]"
        />
      </div>
      <p className="text-[11.5px] text-gray-500">
        开班后会记录你这一班的收款流水；交班时系统算出应交现金，与实际清点金额对比。
      </p>
      <Flash state={state} />
      <Submit label={pending ? "开班中…" : "确认开班"} pendingLabel="开班中…" />
    </form>
  );
}

/** 交班表单 */
export function CloseShiftForm({ expectCash }: { expectCash: number }) {
  const [state, action] = useActionState<ActionState, FormData>(
    async (_prev: ActionState, fd: FormData) => closeShiftAction(fd),
    undefined
  );

  return (
    <form action={action} className="grid gap-3 px-4 py-4 md:grid-cols-3">
      <div>
        <label className="label">实交现金（清点后）</label>
        <input
          name="actual_cash"
          type="number"
          min="0"
          step="0.01"
          defaultValue={expectCash.toFixed(2)}
          className="input h-8 w-full text-[12px]"
        />
      </div>
      <div>
        <label className="label">接班人</label>
        <input name="receiver" placeholder="下一班收银员姓名" className="input h-8 w-full text-[12px]" />
      </div>
      <div>
        <label className="label">备注</label>
        <input name="note" placeholder="如：钱箱有零钱不足" className="input h-8 w-full text-[12px]" />
      </div>
      <div className="md:col-span-3">
        <Flash state={state} />
      </div>
      <div className="md:col-span-3 flex items-center gap-3">
        <Submit label="确认交班" pendingLabel="交班中…" />
        <span className="text-[11.5px] text-gray-500">
          应交 <b className="tabular-nums text-gray-800">¥{expectCash.toFixed(2)}</b>
          ，与实交金额的差额会单独记录
        </span>
      </div>
    </form>
  );
}
