"use client";

/**
 * 会员储值退款表单（客户端）
 *
 * ── 为什么单独抽出来 ──
 *
 * 原来的退款表单在 `members/wallet/page.tsx` 里（Server Component），有两个问题：
 *
 * 1. **没有任何二次确认** —— 点「确认退款」立刻退回储值账户
 * 2. **预设金额按钮是 `type="submit"`** —— 点 100 / 500 / 1000 / 2000
 *    任意一个就直接提交退款。误点一下就退钱了，这是真实的资金风险。
 *
 * Server Component 不能用 onClick，所以把预设按钮改成「填充」必须放到客户端组件。
 *
 * ── 现在的行为 ──
 *   · 预设金额按钮 = 填进输入框（type="button"，不提交）
 *   · 点「退款」→ 弹出确认框，显示会员姓名、退款金额、当前余额、退款后余额
 *   · 确认才真正提交；服务端仍会校验权限（cashier.refund）与可退上限
 */
import { useState } from "react";
import ConfirmForm from "@/components/ConfirmForm";
import { fmtMoney } from "@/lib/utils";

const PRESETS = [100, 500, 1000, 2000] as const;

export default function RefundForm({
  guestId,
  guestName,
  balance,
  action,
}: {
  guestId: number;
  guestName: string;
  /** 当前余额（用于确认框里展示退款后余额） */
  balance: number;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [amount, setAmount] = useState("");

  const num = Number(amount);
  const valid = Number.isFinite(num) && num > 0;
  /*
   * 退款后余额 = 当前余额 − 退款额
   *
   * ⚠️ 方向不能写反（第一版写成 +num，被回归测试抓到）
   *
   * 本项目「退款」的语义是**从会员储值账户出账**：
   * 客人当初充值 1000，现在把没用完的部分退回给他，储值余额自然减少。
   * 服务端 member-wallet.ts 记的就是 `REFUND → signedAmount: -amount`，
   * 判定的可退上限也是「累计充值 − 累计消费 − 累计退款」。
   *
   * 以前这个页面写的是「退款金额退回会员储值账户，余额相应增加」——
   * 那是把退款当充值了，方向完全相反。改成减号并与服务端口径一致。
   */
  const after = valid ? Math.round((balance - num) * 100) / 100 : balance;
  /* 退款金额超过储值余额时，服务端会拒（不能退不存在的钱），这里提前提示 */
  const exceed = valid && num > balance;

  return (
    <div className="card flex flex-col gap-2.5 p-4">
      <div className="text-[13px] font-semibold text-gray-800">退款退回</div>

      <div>
        <label className="label" htmlFor="refund-amount">
          金额（元）
        </label>
        <input
          id="refund-amount"
          name="amount"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="input"
          placeholder="输入退款金额"
        />
        {/* 预设金额：只填值，不提交（原来是 type="submit"，误点即退款） */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {PRESETS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAmount(String(v))}
              className="btn-default px-2 py-0.5 text-[11px]"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label" htmlFor="refund-note">
          备注
        </label>
        <input id="refund-note" name="note" className="input" placeholder="可空，如：订单取消退回" />
      </div>

      <div className="text-[11px] leading-relaxed text-gray-400">
        退款从会员储值账户出账，余额相应<b>减少</b>。
        <br />
        当前余额 <b className="tabular-nums text-gray-600">{fmtMoney(balance)}</b>
        {valid && (
          <>
            {" → 退款后 "}
            <b className={`tabular-nums ${exceed ? "text-rose-600" : "text-gray-800"}`}>{fmtMoney(after)}</b>
            {exceed && <span className="ml-1 text-rose-600">（超过储值余额）</span>}
          </>
        )}
      </div>

      {/*
        二次确认：显示会员姓名 + 金额 + 退款后余额（codex 清单 P2-1 要求）
        服务端仍会校验 cashier.refund 权限和「累计退款 ≤ 累计充值 − 累计消费」上限。
      */}
      <ConfirmForm
        action={action}
        message={valid ? `确认给「${guestName}」退款 ${fmtMoney(num)}？` : "请先填写退款金额"}
        detail={
          valid
            ? `退款从储值账户出账，余额从 ${fmtMoney(balance)} 变为 ${fmtMoney(after)}。此操作会留下资金流水。`
            : "金额为空或不是正数时不会提交。"
        }
        confirmLabel={valid && !exceed ? "确认退款" : "请检查金额"}
        requireReason="退款原因"
        danger
      >
        <input type="hidden" name="guest_id" value={guestId} />
        {/* 金额用 state 的值（预设按钮填进来的也走这里） */}
        <input type="hidden" name="amount" value={amount} />
        <button
          type="button"
          disabled={!valid || exceed}
          className="btn-default mt-1 w-full disabled:cursor-not-allowed disabled:opacity-40"
        >
          {exceed ? "超过储值余额" : valid ? "退款" : "请先填写金额"}
        </button>
      </ConfirmForm>
    </div>
  );
}
