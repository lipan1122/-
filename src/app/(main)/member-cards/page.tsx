import Link from "next/link";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import {
  createMemberCardTypeFormAction,
  createRechargePlanFormAction,
  ensureSettingsSchema,
  toggleMemberCardTypeStatusFormAction,
  toggleRechargePlanStatusFormAction,
  updateMemberCardTypeFormAction,
} from "../settings/actions";

export const dynamic = "force-dynamic";

type CardTypeRow = {
  id: number;
  name: string;
  discount: number;
  points_ratio: number;
  min_recharge: number;
  status: string;
};

type RechargePlanRow = {
  id: number;
  name: string;
  amount: number;
  gift_amount: number;
  status: string;
};

type MemberCardsSearchParams = {
  msg?: string;
  err?: string;
  /** 正在编辑的会员卡类型 id（?edit=3） */
  edit?: string;
};

/* --------------------- 视觉常量（与系统设置页保持一致） ---------------------- */

const TH = "h-[30px] whitespace-nowrap border-b border-[#eee] bg-white px-2 align-middle text-[12px] font-normal text-[#888]";
const TD = "h-[34px] border-b border-[#eee] px-2 align-middle text-[12px] text-[#333]";
const ROW_HOVER = "hover:bg-[#fafafa]";
const INPUT =
  "h-[30px] rounded-[4px] border border-[#ddd] bg-white px-2 text-[12px] text-[#333] outline-none focus:border-[#32c141] focus:ring-2 focus:ring-[#d8f2dd]";
const BTN_PRIMARY =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[3px] border border-[#32c141] bg-[#32c141] px-2.5 text-[12px] font-medium text-white transition-colors hover:border-[#2bb038] hover:bg-[#2bb038] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_SECOND =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[3px] border border-[#ddd] bg-white px-2.5 text-[12px] text-[#444] transition-colors hover:border-[#32c141] hover:text-[#32c141] disabled:cursor-not-allowed disabled:opacity-50";
const BTN_DANGER =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[3px] border border-[#f0c0c0] bg-white px-2.5 text-[12px] text-[#e04545] transition-colors hover:bg-[#fff3f3] disabled:cursor-not-allowed disabled:opacity-50";

/* ------------------------------- 展示组件 -------------------------------- */

function Section({
  id,
  title,
  desc,
  extra,
  children,
}: {
  id: string;
  title: string;
  desc?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-14 overflow-hidden rounded-[4px] border border-[#eee] bg-white">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#eee] p-3">
        <div>
          <div className="text-[13px] font-semibold text-[#222]">{title}</div>
          {desc && <div className="mt-0.5 text-[11px] leading-[16px] text-[#999]">{desc}</div>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Banner({ tone, text }: { tone: "error" | "ok"; text: string }) {
  const cls =
    tone === "error" ? "border-[#f0c0c0] bg-[#fff3f3] text-[#e04545]" : "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-center justify-between rounded-[4px] border px-3 py-1.5 text-[12px] ${cls}`}
    >
      <span>{text}</span>
      <Link href="/member-cards" className="ml-3 shrink-0 text-[11px] opacity-70 hover:opacity-100">
        关闭
      </Link>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`rounded-[2px] border px-1 text-[11px] leading-[15px] ${
        active ? "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]" : "border-[#eee] bg-[#f7f7f7] text-[#999]"
      }`}
    >
      {active ? "启用" : "停用"}
    </span>
  );
}

/* ------------------------------- 格式化工具 ------------------------------- */

/** 金额：整数不带小数，否则保留两位（用于卡片文案「充 500 送 50」） */
function fmtNum(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** 折扣：1 = 不打折，0.95 = 9.5 折，0.9 = 9 折 */
function fmtDiscount(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1) return "不打折";
  const zhe = Math.round(n * 100) / 10;
  return `${Number.isInteger(zhe) ? zhe.toFixed(0) : zhe.toFixed(1)} 折`;
}

/** 积分比例：1 = 消费 1 元得 1 分，1.2 = 消费 1 元得 1.2 分 */
function fmtPoints(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return `1 : ${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}`;
}

/* -------------------------------- 页面主体 -------------------------------- */

export default async function MemberCardsPage({ searchParams }: { searchParams: Promise<MemberCardsSearchParams> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  // 懒建表 + 首次访问写入 3 种会员卡 / 4 个充值方案种子（不改 init-db）
  await ensureSettingsSchema(hotelId);

  const cardTypes = all<CardTypeRow>(
    `SELECT id, name, discount, points_ratio, min_recharge, status
     FROM member_card_types WHERE hotel_id = ? ORDER BY discount DESC, id`,
    [hotelId]
  );

  const plans = all<RechargePlanRow>(
    `SELECT id, name, amount, gift_amount, status
     FROM recharge_plans WHERE hotel_id = ? ORDER BY amount, id`,
    [hotelId]
  );

  const activeCardCount = cardTypes.filter((card) => card.status === "ACTIVE").length;
  const activePlanCount = plans.filter((plan) => plan.status === "ACTIVE").length;
  const totalGift = plans
    .filter((plan) => plan.status === "ACTIVE")
    .reduce((sum, plan) => sum + Number(plan.gift_amount ?? 0), 0);

  // 行内「编辑」通过 ?edit=<id> 打开上方编辑表单（服务端渲染，无需客户端组件）
  const editId = Number(sp.edit);
  const editingCard = Number.isInteger(editId) ? cardTypes.find((card) => card.id === editId) ?? null : null;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[15px] font-semibold text-[#222]">会员卡设置</h1>
          <p className="mt-0.5 text-[12px] text-[#888]">
            会员卡折扣与积分规则、储值充值方案维护 · 共 {cardTypes.length} 种卡（启用 {activeCardCount}）·{" "}
            {plans.length} 个充值方案（启用 {activePlanCount}）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/members" className={`${BTN_SECOND} px-2.5`}>
            会员管理
          </Link>
          <Link href="/settings" className={`${BTN_SECOND} px-2.5`}>
            系统设置
          </Link>
          <span className="rounded-[3px] border border-[#eee] bg-white px-2 py-[3px] text-[11px] text-[#888]">
            当前酒店：{user.hotelName}
          </span>
        </div>
      </div>

      {sp.err && <Banner tone="error" text={sp.err} />}
      {sp.msg && <Banner tone="ok" text={sp.msg} />}

      <Section
        id="card-types"
        title="会员卡类型"
        desc="折扣作用于房费与消费项目，积分比例决定每消费 1 元累计的积分；最低充值为开卡 / 升级门槛"
        extra={<span className="text-[11px] text-[#999]">共 {cardTypes.length} 种卡</span>}
      >
        {editingCard && (
          <form
            action={updateMemberCardTypeFormAction}
            className="border-b border-[#eee] bg-[#fffdf3] px-3 py-2.5"
          >
            <input type="hidden" name="id" value={editingCard.id} />
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-[#b8860b]">正在编辑会员卡：{editingCard.name}</span>
              <Link href="/member-cards" className="text-[11px] text-[#888] hover:text-[#222]">
                取消编辑
              </Link>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor="edit_card_name">
                  卡名称
                </label>
                <input
                  id="edit_card_name"
                  name="name"
                  defaultValue={editingCard.name}
                  className={`${INPUT} w-36`}
                />
              </div>
              <div>
                <label className="label" htmlFor="edit_card_discount">
                  折扣（1 = 不打折）
                </label>
                <input
                  id="edit_card_discount"
                  name="discount"
                  type="number"
                  min="0.1"
                  max="1"
                  step="0.01"
                  defaultValue={editingCard.discount}
                  className={`${INPUT} w-32 tabular-nums`}
                />
              </div>
              <div>
                <label className="label" htmlFor="edit_card_points">
                  积分比例
                </label>
                <input
                  id="edit_card_points"
                  name="points_ratio"
                  type="number"
                  min="0"
                  max="99"
                  step="0.1"
                  defaultValue={editingCard.points_ratio}
                  className={`${INPUT} w-28 tabular-nums`}
                />
              </div>
              <div>
                <label className="label" htmlFor="edit_card_min_recharge">
                  最低充值
                </label>
                <input
                  id="edit_card_min_recharge"
                  name="min_recharge"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={editingCard.min_recharge}
                  className={`${INPUT} w-32 tabular-nums`}
                />
              </div>
              <button type="submit" className={BTN_PRIMARY}>
                保存修改
              </button>
              <span className="text-[11px] text-[#999]">保存后立即生效，新折扣用于后续开单与充值</span>
            </div>
          </form>
        )}
        <form
          action={createMemberCardTypeFormAction}
          className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
        >
          <div>
            <label className="label" htmlFor="card_name">
              卡名称
            </label>
            <input id="card_name" name="name" className={`${INPUT} w-36`} placeholder="如 钻石卡" />
          </div>
          <div>
            <label className="label" htmlFor="card_discount">
              折扣（1 = 不打折）
            </label>
            <input
              id="card_discount"
              name="discount"
              type="number"
              min="0.1"
              max="1"
              step="0.01"
              defaultValue={1}
              className={`${INPUT} w-32 tabular-nums`}
            />
          </div>
          <div>
            <label className="label" htmlFor="card_points">
              积分比例
            </label>
            <input
              id="card_points"
              name="points_ratio"
              type="number"
              min="0"
              max="99"
              step="0.1"
              defaultValue={1}
              className={`${INPUT} w-28 tabular-nums`}
            />
          </div>
          <div>
            <label className="label" htmlFor="card_min_recharge">
              最低充值
            </label>
            <input
              id="card_min_recharge"
              name="min_recharge"
              type="number"
              min="0"
              step="0.01"
              defaultValue={0}
              className={`${INPUT} w-32 tabular-nums`}
            />
          </div>
          <button type="submit" className={BTN_PRIMARY}>
            新增会员卡
          </button>
          <span className="text-[11px] text-[#999]">折扣填 0.95 即 9.5 折，填 1 表示不打折</span>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} text-left`}>卡名称</th>
                <th className={`${TH} text-left`}>折扣</th>
                <th className={`${TH} text-left`}>积分比例</th>
                <th className={`${TH} text-left`}>最低充值</th>
                <th className={`${TH} text-left`}>状态</th>
                <th className={`${TH} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {cardTypes.length === 0 && (
                <tr>
                  <td colSpan={6} className={`${TD} py-8 text-center text-[#999]`}>
                    暂无会员卡类型，请使用上方表单新增
                  </td>
                </tr>
              )}
              {cardTypes.map((card) => {
                const active = card.status === "ACTIVE";
                return (
                  <tr key={card.id} className={ROW_HOVER}>
                    <td className={TD}>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-[#222]">{card.name}</span>
                        {editingCard?.id === card.id && (
                          <span className="rounded-[2px] border border-[#f0e0b0] bg-[#fffdf3] px-1 text-[11px] leading-[15px] text-[#b8860b]">
                            编辑中
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={TD}>
                      <span className={`tabular-nums ${active ? "text-[#222]" : "text-[#999]"}`}>
                        {Number(card.discount).toFixed(2)}
                      </span>
                      <span className="ml-1.5 text-[11px] text-[#999]">{fmtDiscount(card.discount)}</span>
                    </td>
                    <td className={`${TD} tabular-nums text-[#555]`}>
                      {fmtPoints(card.points_ratio)}
                      <span className="ml-1.5 text-[11px] text-[#999]">×{Number(card.points_ratio).toFixed(1)}</span>
                    </td>
                    <td className={`${TD} text-right tabular-nums text-[#555]`}>{fmtMoney(card.min_recharge)}</td>
                    <td className={TD}>
                      <StatusBadge active={active} />
                    </td>
                    <td className={`${TD} text-right`}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Link href={`/member-cards?edit=${card.id}#card-types`} className={`${BTN_SECOND} px-2`}>
                          编辑
                        </Link>
                        <form action={toggleMemberCardTypeStatusFormAction} className="inline-block">
                          <input type="hidden" name="id" value={card.id} />
                          <button type="submit" className={`${active ? BTN_DANGER : BTN_SECOND} px-2`}>
                            {active ? "停用" : "启用"}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
          点击「编辑」在上方表单修改折扣 / 积分比例 / 最低充值并保存；停用的卡不再参与开卡与折扣计算，历史会员保留原卡等级。
        </p>
      </Section>

      <Section
        id="recharge-plans"
        title="充值方案"
        desc="会员储值充值方案：充多少送多少，赠送金额计入会员储值余额（只赠送一次，不可提现）"
        extra={
          <span className="text-[11px] text-[#999]">
            共 {plans.length} 个方案 · 启用方案赠送合计 {fmtMoney(totalGift)}
          </span>
        }
      >
        <form
          action={createRechargePlanFormAction}
          className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
        >
          <div className="min-w-[200px]">
            <label className="label" htmlFor="plan_name">
              方案名（可留空自动生成）
            </label>
            <input id="plan_name" name="name" className={`${INPUT} w-full`} placeholder="如 充 1000 送 120" />
          </div>
          <div>
            <label className="label" htmlFor="plan_amount">
              充值金额
            </label>
            <input
              id="plan_amount"
              name="amount"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={500}
              className={`${INPUT} w-28 tabular-nums`}
            />
          </div>
          <div>
            <label className="label" htmlFor="plan_gift">
              赠送金额
            </label>
            <input
              id="plan_gift"
              name="gift_amount"
              type="number"
              min="0"
              step="0.01"
              defaultValue={50}
              className={`${INPUT} w-28 tabular-nums`}
            />
          </div>
          <button type="submit" className={BTN_PRIMARY}>
            新增充值方案
          </button>
          <span className="text-[11px] text-[#999]">赠送金额可为 0（纯充值方案）</span>
        </form>

        {/* 方案卡片：直接展示「充 500 送 50」这类文案 */}
        <div className="grid gap-2.5 p-3 sm:grid-cols-2 xl:grid-cols-4">
          {plans.length === 0 && (
            <div className="rounded-[4px] border border-dashed border-[#eee] px-3 py-8 text-center text-[12px] text-[#999] sm:col-span-2 xl:col-span-4">
              暂无充值方案，请使用上方表单新增
            </div>
          )}
          {plans.map((plan) => {
            const active = plan.status === "ACTIVE";
            const amount = Number(plan.amount ?? 0);
            const gift = Number(plan.gift_amount ?? 0);
            const bonusRate = amount > 0 ? (gift / amount) * 100 : 0;
            return (
              <div
                key={plan.id}
                className={`rounded-[4px] border p-3 ${
                  active ? "border-[#bfe6c6] bg-[#f3fbf4]" : "border-[#eee] bg-[#fafafa]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-[#888]">{plan.name}</span>
                  <StatusBadge active={active} />
                </div>
                <div
                  className={`mt-2 text-[18px] font-semibold tabular-nums ${active ? "text-[#222]" : "text-[#999]"}`}
                >
                  充 {fmtNum(amount)} 送 {fmtNum(gift)}
                </div>
                <div className="mt-1 text-[11px] text-[#888]">
                  到账 {fmtMoney(amount + gift)} · 赠送比例 {bonusRate.toFixed(1)}%
                </div>
              </div>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} text-left`}>方案名</th>
                <th className={`${TH} text-right`}>充值金额</th>
                <th className={`${TH} text-right`}>赠送金额</th>
                <th className={`${TH} text-right`}>到账金额</th>
                <th className={`${TH} text-left`}>状态</th>
                <th className={`${TH} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.length === 0 && (
                <tr>
                  <td colSpan={6} className={`${TD} py-8 text-center text-[#999]`}>
                    暂无充值方案，请使用上方表单新增
                  </td>
                </tr>
              )}
              {plans.map((plan) => (
                <tr key={plan.id} className={ROW_HOVER}>
                  <td className={`${TD} font-medium text-[#222]`}>{plan.name}</td>
                  <td className={`${TD} text-right tabular-nums text-[#222]`}>{fmtMoney(plan.amount)}</td>
                  <td className={`${TD} text-right tabular-nums text-[#2a9d3a]`}>{fmtMoney(plan.gift_amount)}</td>
                  <td className={`${TD} text-right tabular-nums text-[#555]`}>
                    {fmtMoney(Number(plan.amount ?? 0) + Number(plan.gift_amount ?? 0))}
                  </td>
                  <td className={TD}>
                    <StatusBadge active={plan.status === "ACTIVE"} />
                  </td>
                  <td className={`${TD} text-right`}>
                    <form action={toggleRechargePlanStatusFormAction} className="inline-block">
                      <input type="hidden" name="id" value={plan.id} />
                      <button
                        type="submit"
                        className={`${plan.status === "ACTIVE" ? BTN_DANGER : BTN_SECOND} px-2`}
                      >
                        {plan.status === "ACTIVE" ? "停用" : "启用"}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
          充值方案用于会员储值开卡与充值收款；停用后不再出现在充值选择列表，已充值记录不受影响。
        </p>
      </Section>
    </div>
  );
}
