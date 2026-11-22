import Link from "next/link";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney } from "@/lib/utils";
import { round2 } from "@/lib/folio";
import { bizToday } from "@/lib/biz-date";
import { runNightAuditAction, undoNightAuditAction } from "./actions";
import { nightAuditPreflight } from "./preflight";

export const dynamic = "force-dynamic";

/** 表单适配：执行夜审（表单提交忽略返回值，状态由页面徽章体现） */
async function runAuditFormAction(): Promise<void> {
  "use server";
  await runNightAuditAction();
}

/** 表单适配：撤销夜审（第 4 轮 P1-18） */
async function undoAuditFormAction(formData: FormData): Promise<void> {
  "use server";
  await undoNightAuditAction(formData);
}
/** 撤销夜审表单（原因必填 + 二次确认，第 4 轮 P1-18） */
function UndoAuditForm() {
  return (
    <details className="relative">
      <summary className="ml-2 inline-flex cursor-pointer list-none items-center rounded border border-rose-200 bg-rose-50 px-2.5 py-2 text-[12px] text-rose-700 hover:bg-rose-100">
        撤销夜审
      </summary>
      <form
        action={undoAuditFormAction}
        className="absolute right-0 z-20 mt-1 w-[280px] rounded-lg border border-rose-200 bg-white p-3 shadow-lg"
      >
        <div className="mb-1.5 text-[12px] font-medium text-gray-800">确认撤销最近一次夜审？</div>
        <div className="mb-2 text-[11px] leading-relaxed text-gray-500">
          将冲正当日补记的房费、还原被标未到店的订单、删除当日营收日报。
          被清空的房号不会自动恢复，需要重新排房。
        </div>
        <input
          name="reason"
          required
          placeholder="填写撤销原因（必填）"
          className="input mb-2 w-full py-1.5 text-[12px]"
        />
        <button className="w-full rounded bg-rose-600 py-1.5 text-[12px] text-white hover:bg-rose-700">
          确认撤销
        </button>
      </form>
    </details>
  );
}



type AuditRow = {
  biz_date: string;
  status: string;
  /** 出租间夜（房间数口径，不含钟点房）；旧行是「在住房间数」 */
  rooms_sold: number;
  /** 当日钟点房间数（在住但不计间夜），旧行为 NULL/0 */
  hourly_rooms: number | null;
  /** 兼容列：新行 = 净收入，旧行 = 旧口径总营收 */
  revenue: number;
  occupancy: number;
  revenue_room: number | null;
  revenue_food: number | null;
  revenue_other: number | null;
  refund_total: number | null;
  revenue_net: number | null;
  operator: string | null;
  created_at: string | null;
};

type AuditStats = {
  total_rooms: number;
  inhouse: number;
  overnight: number;
  hourly: number;
  posted: number;
  pending: number;
  pending_amount: number;
};

/**
 * 营收分列（页面上的唯一形状）
 *   gross = 房费 + 餐饮 + 其他   净收入 net = gross - refund
 * 口径与 night-audit/actions.ts 完全一致：收入取 folio_items 的
 * ROOM / FOOD / OTHER（排除押金 DEPOSIT 与冲账 ADJUST），
 * 退款取 payments 里 amount < 0（或 refund_of 非空）的绝对值。
 */
type RevenueSplit = { room: number; food: number; other: number; refund: number; gross: number; net: number };

function splitRevenue(room: number, food: number, other: number, refund: number): RevenueSplit {
  const r = round2(room);
  const f = round2(food);
  const o = round2(other);
  const rf = round2(Math.abs(refund));
  const gross = round2(r + f + o);
  return { room: r, food: f, other: o, refund: rf, gross, net: round2(gross - rf) };
}

function splitOfAudit(a: AuditRow): RevenueSplit {
  return splitRevenue(
    Number(a.revenue_room ?? 0),
    Number(a.revenue_food ?? 0),
    Number(a.revenue_other ?? 0),
    Number(a.refund_total ?? 0)
  );
}

/**
 * 历史（迁移前）夜审行：只有 revenue 一列，分列金额无法反推。
 * 迁移把 revenue_net 留成 0 作为「未分列」标记 —— 这里据此判定，
 * 分列显示「—」，净收入原样显示历史 revenue，不把未知伪装成 0。
 *
 * 第 4 轮 P1-19：判定条件从「revenue_net === 0」收紧为「分列全部为 0」。
 * 原因是新夜审某天可能恰好零收入（无消费也无退款），revenue_net 也是 0，
 * 单看 revenue_net 会把这类**新行**误判成历史行、把分列显示成「—」。
 * 分列（房费/餐饮/其他/退款）全为 0 才是真正的「未分列」信号，
 * 与 reports/page.tsx 的 auditHasSplit() 保持同一口径（两个页面不能各判各的）。
 */
function isLegacyAudit(a: AuditRow): boolean {
  return (
    Number(a.revenue_room ?? 0) === 0 &&
    Number(a.revenue_food ?? 0) === 0 &&
    Number(a.revenue_other ?? 0) === 0 &&
    Number(a.refund_total ?? 0) === 0
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO 时间 → 「YYYY-MM-DD HH:mm」 */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 出租率（0~1）→ 百分比文本
 *
 * 第 4 轮 P2-9：统一为 2 位小数、允许负值。旧实现 1 位小数，与
 * `reports/page.tsx` 的 fmtPct（2 位）不一致 —— 同一个出租率在夜审页
 * 显示 65.2%、在报表页显示 65.22%，对不上账时业主会怀疑数据来源。
 * `n <= 0` 的短路也去掉了：负的出租率说明间夜/房量为负（数据异常），
 * 显示成 0.0% 会把异常藏起来。
 */
function fmtPct(v: number | null): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0.00%";
  const pct = n * 100;
  if (Math.abs(pct) < 0.005) return "0.00%";
  return `${pct.toFixed(2)}%`;
}

/** 带符号金额：负数显示「-¥100.00」而不是「¥-100.00」 */
function fmtSigned(n: number): string {
  const v = Number(n ?? 0);
  return v < 0 ? `-${fmtMoney(-v)}` : fmtMoney(v);
}

export default async function NightAuditPage() {
  const user = await requireUser();
  const hotelId = user.hotelId;
  /*
   * 营业日（整改 P1-6 同源口径）：夜审记录按 biz_date 落库，
   * 页面必须用同一个日期查，否则营业日切换点（默认 05:00）前后会出现
   * 「服务端判定今日已夜审、页面却显示待夜审」的矛盾。
   */
  const today = bizToday(hotelId);
  const weekday = new Date(`${today}T00:00:00`).toLocaleDateString("zh-CN", { weekday: "long" });

  const todayAudit = get<AuditRow>(
    `SELECT biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
            revenue_room, revenue_food, revenue_other, refund_total, revenue_net,
            operator, created_at
     FROM night_audits WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  );

  /* 基础统计：拆成几条小查询，避免一条 SQL 里十几个问号参数错位 */
  const totalRooms =
    get<{ total: number }>(`SELECT COUNT(*) AS total FROM rooms WHERE hotel_id = ?`, [hotelId])?.total ?? 0;
  const inhouse =
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [hotelId])?.c ?? 0;
  /* 出租间夜口径：只数过夜的在住单（nights > 0 且 rate_code 不是「钟点」） */
  const overnight =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM stays s
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
          AND COALESCE(s.nights, 0) > 0
          AND COALESCE(s.rate_code, '') <> '钟点'`,
      [hotelId]
    )?.c ?? 0;
  const hourly =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM stays s
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
          AND (COALESCE(s.nights, 0) <= 0 OR COALESCE(s.rate_code, '') = '钟点')`,
      [hotelId]
    )?.c ?? 0;
  const posted =
    get<{ c: number }>(
      `SELECT COUNT(DISTINCT fi.folio_id) AS c FROM folio_items fi
         JOIN folios f ON f.id = fi.folio_id
        WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'ROOM'`,
      [hotelId, today]
    )?.c ?? 0;
  const pendingRow =
    get<{ c: number; amount: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(s.rate), 0) AS amount
         FROM stays s
         JOIN folios f ON f.stay_id = s.id
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
          AND NOT EXISTS (
            SELECT 1 FROM folio_items fi
             WHERE fi.folio_id = f.id AND fi.biz_date = ? AND fi.item_type = 'ROOM'
          )`,
      [hotelId, today]
    ) ?? { c: 0, amount: 0 };

  const stats: AuditStats = {
    total_rooms: totalRooms,
    inhouse,
    overnight,
    hourly,
    posted,
    pending: pendingRow.c,
    pending_amount: Number(pendingRow.amount ?? 0),
  };

  /** 实时出租率：出租间夜 / 总房量（房间数口径，分母不扣维修房） */
  const liveOccupancy = totalRooms > 0 ? overnight / totalRooms : 0;

  const history = all<AuditRow>(
    `SELECT biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
            revenue_room, revenue_food, revenue_other, refund_total, revenue_net,
            operator, created_at
     FROM night_audits WHERE hotel_id = ?
     ORDER BY biz_date DESC, id DESC
     LIMIT 30`,
    [hotelId]
  );

  /*
   * 今日营收分列：
   *   已夜审 → 用夜审存档值（报表口径，与历史记录、导出、/reports 对齐）
   *   未夜审 → 用当日实时数据预览，口径与 actions.ts 一致，方便夜审前核对
   */
  const liveRevenue =
    get<{ room: number; food: number; other: number; refund: number }>(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM folio_items
           WHERE hotel_id = ? AND biz_date = ? AND item_type = 'ROOM') AS room,
         (SELECT COALESCE(SUM(amount), 0) FROM folio_items
           WHERE hotel_id = ? AND biz_date = ? AND item_type = 'FOOD') AS food,
         (SELECT COALESCE(SUM(amount), 0) FROM folio_items
           WHERE hotel_id = ? AND biz_date = ? AND item_type = 'OTHER') AS other,
         (SELECT COALESCE(SUM(ABS(amount)), 0) FROM payments
           WHERE hotel_id = ? AND biz_date = ? AND (amount < 0 OR refund_of IS NOT NULL)) AS refund`,
      [hotelId, today, hotelId, today, hotelId, today, hotelId, today]
    ) ?? { room: 0, food: 0, other: 0, refund: 0 };

  const revenue = todayAudit
    ? splitOfAudit(todayAudit)
    : splitRevenue(liveRevenue.room, liveRevenue.food, liveRevenue.other, liveRevenue.refund);

  const auditTime =
    get<{ value: string | null }>(`SELECT value FROM settings WHERE hotel_id = ? AND key = 'night_audit_time'`, [
      hotelId,
    ])?.value ?? "02:00";

  const preflight = nightAuditPreflight(hotelId, today);
  /* 撤销夜审只给 admin（服务端 undoNightAuditAction 也会再校验一次） */
  const canUndo = user.role === "admin";

  const cards = [
    {
      label: "在住房间",
      value: String(stats.inhouse),
      unit: "间",
      sub: `共 ${stats.total_rooms} 间 · 出租率 ${fmtPct(liveOccupancy)}（过夜 ${stats.overnight} 间，钟点 ${stats.hourly} 间不计间夜）`,
      tone: "bg-blue-50 text-blue-600",
    },
    {
      label: "今日已过房费单数",
      value: String(stats.posted),
      unit: "单",
      sub: `今日房费已过账的账务单`,
      tone: "bg-emerald-50 text-emerald-600",
    },
    {
      label: "待过账房间数",
      value: String(stats.pending),
      unit: "间",
      sub: `待过账房费 ${fmtMoney(stats.pending_amount)}`,
      tone: "bg-amber-50 text-amber-600",
    },
  ];

  /* 营收分列小卡：房费 / 餐饮 / 其他 / 退款 / 净收入 */
  const revenueTiles = [
    { label: "房费", value: fmtMoney(revenue.room), hint: "ROOM 明细" },
    { label: "餐饮", value: fmtMoney(revenue.food), hint: "FOOD 明细" },
    { label: "其他", value: fmtMoney(revenue.other), hint: "OTHER 明细（商超/洗衣等）" },
    { label: "退款冲减", value: fmtSigned(-revenue.refund), hint: "当日负数收款，正数表示退出去多少" },
    { label: "净收入", value: fmtSigned(revenue.net), hint: "房费+餐饮+其他-退款" },
  ];

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-[16px] font-semibold text-gray-900">夜审日结</h1>
        <p className="mt-0.5 text-[12px] text-gray-500">
          每日营业结束后执行夜审，系统把当日房费过账到在住账务单并生成营业日报
        </p>
      </div>

      {/* 夜审前异常检查（报告第 6 节） */}
      {preflight.items.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#f3e0b8] bg-[#fffbf2] px-4 py-2.5">
            <span className="text-[12.5px] font-semibold text-[#b07d2e]">
              夜审前检查 · {preflight.items.length} 类待处理
              {preflight.blockingCount > 0 && (
                <span className="ml-2 rounded bg-[#d9534f] px-1.5 py-0.5 text-[10.5px] text-white">
                  有 {preflight.blockingCount} 项阻断
                </span>
              )}
            </span>
            <span className="text-[11px] text-[#b07d2e]/70">不阻断的项可以先跑夜审，事后处理</span>
          </div>
          <div className="divide-y divide-gray-50">
            {preflight.items.map((it) => (
              <div key={it.key} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${
                    it.level === "danger" ? "bg-[#d9534f]" : it.level === "warn" ? "bg-[#e8a33d]" : "bg-[#5b9bd5]"
                  }`}
                >
                  {it.count > 99 ? "99" : it.count}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-medium text-gray-800">{it.title}</span>
                    {it.blocking && (
                      <span className="rounded bg-[#fdf3f3] px-1 text-[10px] text-[#c0392b]">阻断夜审</span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-gray-500" title={it.detail}>{it.detail}</div>
                </div>
                <Link
                  href={it.href}
                  className="shrink-0 rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-0.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
                >
                  去处理
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-[#16233d] to-[#1f3355] px-5 py-4 text-white">
          <div>
            <div className="text-[11px] text-white/60">当前营业日</div>
            <div className="mt-0.5 text-[26px] font-semibold leading-tight tabular-nums">{today}</div>
            <div className="mt-1 text-[11px] text-white/60">
              {weekday} · 夜审时间 {auditTime} · 操作人 {user.realName}
            </div>
          </div>
          <div className="text-right">
            {todayAudit ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-3 py-1 text-[12px] font-medium text-emerald-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  今日已夜审
                </span>
                <div className="mt-2 text-[11px] text-white/60">
                  执行时间 {fmtDateTime(todayAudit.created_at)} · 操作人 {todayAudit.operator ?? "—"}
                </div>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/15 px-3 py-1 text-[12px] font-medium text-amber-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                  今日待夜审
                </span>
                <div className="mt-2 text-[11px] text-white/60">营业日尚未结束</div>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-2.5 text-[12px] text-gray-500">
          <span>
            在住 <b className="tabular-nums text-gray-800">{stats.inhouse}</b> 间
          </span>
          <span>
            出租间夜 <b className="tabular-nums text-gray-800">{stats.overnight}</b> 间夜
          </span>
          <span>
            钟点房 <b className="tabular-nums text-gray-800">{stats.hourly}</b> 间（不计间夜）
          </span>
          <span>
            出租率 <b className="tabular-nums text-gray-800">{fmtPct(liveOccupancy)}</b>
          </span>
          <span>
            已过账 <b className="tabular-nums text-gray-800">{stats.posted}</b> 单
          </span>
          <span>
            待过账 <b className="tabular-nums text-gray-800">{stats.pending}</b> 间 ·{" "}
            {fmtMoney(stats.pending_amount)}
          </span>
        </div>
      </div>

      {/* 今日营收分列（整改 P1-13）：房费 / 餐饮 / 其他 / 退款 / 净收入 */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">今日营收结构</span>
          <span className="text-[11px] text-gray-400">
            {todayAudit ? `夜审存档 · ${fmtDateTime(todayAudit.created_at)}` : "未夜审 · 以下为实时预览"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-gray-100 md:grid-cols-5">
          {revenueTiles.map((t) => (
            <div key={t.label} className="bg-white px-4 py-3" title={t.hint}>
              <div className="text-[11px] text-gray-500">{t.label}</div>
              <div
                className={`mt-1 text-[17px] font-semibold tabular-nums ${
                  t.label === "退款冲减"
                    ? "text-[#c0392b]"
                    : t.label === "净收入"
                      ? "text-emerald-700"
                      : "text-gray-900"
                }`}
              >
                {t.value}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-gray-100 px-4 py-2 text-[11.5px] text-gray-500">
          <span>
            毛收入 <b className="tabular-nums text-gray-800">{fmtMoney(revenue.gross)}</b>
          </span>
          <span className="text-gray-300">−</span>
          <span>
            退款冲减 <b className="tabular-nums text-[#c0392b]">{fmtMoney(revenue.refund)}</b>
          </span>
          <span className="text-gray-300">=</span>
          <span>
            净收入 <b className="tabular-nums text-emerald-700">{fmtSigned(revenue.net)}</b>
          </span>
          <span className="text-gray-300">·</span>
          <span className="text-gray-400">
            口径：房费/餐饮/其他取 folio_items 的 ROOM/FOOD/OTHER（押金、冲账不算收入）；退款取 payments 当日负数收款的绝对值
          </span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-gray-500">{c.label}</span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-semibold ${c.tone}`}
              >
                {c.label.slice(0, 1)}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1">
              <span className="text-2xl font-semibold tabular-nums text-gray-900">{c.value}</span>
              <span className="text-[12px] text-gray-400">{c.unit}</span>
            </div>
            <div className="mt-1 text-[11px] text-gray-400">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-2xl">
            <div className="text-[13px] font-semibold text-gray-800">执行夜审</div>
            <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
              夜审会把今日房费过账到每间在住房间：为尚无「房费 {today}」明细的在住账务单补录一条房费，随后重算账务单合计与应收余额，
              并把「到店日已过但仍未入住」的预订单标记为<span className="text-gray-700">未到店（NOSHOW）</span>，
              最后按「出租间夜（不含钟点房）+ 房费/餐饮/其他 + 退款冲减」生成当日营业日报。同一营业日只允许执行一次。
            </p>
            {todayAudit && (
              <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-700">
                今日夜审已于 {fmtDateTime(todayAudit.created_at)} 完成：出租间夜 {todayAudit.rooms_sold} 间夜
                {Number(todayAudit.hourly_rooms ?? 0) > 0 && `（另钟点房 ${todayAudit.hourly_rooms} 间不计）`}
                ，房费 {fmtMoney(revenue.room)} · 餐饮 {fmtMoney(revenue.food)} · 其他 {fmtMoney(revenue.other)} · 退款{" "}
                {fmtSigned(-revenue.refund)}，净收入 {fmtSigned(revenue.net)}，出租率 {fmtPct(todayAudit.occupancy)}。
              </p>
            )}
          </div>
          <form action={runAuditFormAction}>
            <button
              type="submit"
              disabled={Boolean(todayAudit) || preflight.blockingCount > 0}
              className="btn-primary px-5 py-2 text-[13px]"
              title={
                todayAudit
                  ? "今日已完成夜审"
                  : preflight.blockingCount > 0
                    ? `存在 ${preflight.blockingCount} 项阻断，处理后才能执行`
                    : "过账今日房费并生成营业日报"
              }
            >
              {todayAudit ? "今日已夜审" : "执行夜审"}
            </button>
          </form>
          {/*
            第 4 轮 P1-18：撤销夜审入口
            夜审原来跑错无法撤回，只能手工改库。这里给 admin 一个带原因必填的撤销入口。
          */}
          {todayAudit && canUndo && <UndoAuditForm />}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">夜审历史</span>
          <span className="text-[11px] text-gray-400">最近 {history.length} 条</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">营业日</th>
                <th className="th">出租间夜</th>
                <th className="th">房费</th>
                <th className="th">餐饮</th>
                <th className="th">其他</th>
                <th className="th">退款</th>
                <th className="th">净收入</th>
                <th className="th">出租率</th>
                <th className="th">操作人</th>
                <th className="th">执行时间</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={10} className="td py-10 text-center text-gray-400">
                    暂无夜审记录，点击上方「执行夜审」生成第一条营业日报
                  </td>
                </tr>
              )}
              {history.map((a) => {
                /* 迁移前的行只有总额：分列显示「—」，净收入回退到历史 revenue */
                const legacy = isLegacyAudit(a);
                const split = splitOfAudit(a);
                return (
                  <tr key={a.biz_date} className="hover:bg-gray-50">
                    <td className="td tabular-nums font-medium text-gray-800">{a.biz_date}</td>
                    <td
                      className="td tabular-nums"
                      title={
                        legacy
                          ? "历史行：口径为「在住房间数」（含钟点房），未按出租间夜口径重算"
                          : `已排除钟点房 ${Number(a.hourly_rooms ?? 0)} 间（钟点房在住但不计间夜）`
                      }
                    >
                      {a.rooms_sold} 间夜
                    </td>
                    <td className="td tabular-nums" title={legacy ? "该日早于收入分列口径，无法反推房费明细" : "ROOM 明细合计"}>
                      {legacy ? "—" : fmtMoney(split.room)}
                    </td>
                    <td className="td tabular-nums" title={legacy ? "该日早于收入分列口径，无法反推餐饮明细" : "FOOD 明细合计"}>
                      {legacy ? "—" : fmtMoney(split.food)}
                    </td>
                    <td className="td tabular-nums" title={legacy ? "该日早于收入分列口径，无法反推其他明细" : "OTHER 明细合计"}>
                      {legacy ? "—" : fmtMoney(split.other)}
                    </td>
                    <td className="td tabular-nums text-[#c0392b]" title="当日负数收款（退款）绝对值合计">
                      {legacy ? "—" : fmtSigned(-split.refund)}
                    </td>
                    <td
                      className="td tabular-nums font-medium"
                      title={legacy ? "历史行：净收入取历史 revenue 列（旧口径总营收）" : "房费+餐饮+其他-退款"}
                    >
                      {legacy ? fmtMoney(a.revenue) : fmtSigned(split.net)}
                    </td>
                    <td className="td tabular-nums" title="出租率 = 出租间夜 / 总房量（房间数口径）">
                      {fmtPct(a.occupancy)}
                    </td>
                    <td className="td text-gray-600">{a.operator ?? "—"}</td>
                    <td className="td tabular-nums text-gray-500">{fmtDateTime(a.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
