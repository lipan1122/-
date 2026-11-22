import Link from "next/link";
import { all, get } from "@/lib/db";
/* 第 4 轮 P1-1：收款写营业日，读也要按营业日 */
import { bizToday } from "@/lib/biz-date";
import { requireUser } from "@/lib/session";
import { fmtMoney, todayStr } from "@/lib/utils";
import CashierPanel, {
  type CashierFolio,
  type CashierItem,
  type CashierLog,
  type CashierPayment,
  type CashierStay,
  type CashierTotals,
  type CompanionRow,
  type CompanyOption,
  type RoomOption,
  type StayOption,
  type TransferTarget,
  type WakeUpRow,
} from "@/components/CashierPanel";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

type ListRow = {
  stay_id: number;
  stay_no: string;
  room_no: string;
  guest_name: string;
  expect_check_out: string | null;
  actual_check_out: string | null;
  stay_status: string;
  remark: string | null;
  balance: number | null;
  folio_status: string | null;
};

type SelRow = {
  stay_id: number;
  stay_no: string;
  room_id: number;
  room_no: string;
  floor: number | null;
  room_type_name: string | null;
  guest_name: string;
  mobile: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  actual_check_out: string | null;
  nights: number | null;
  rate: number;
  deposit: number | null;
  guest_count: number | null;
  stay_status: string;
  remark: string | null;
  team_name: string | null;
  member_card: string | null;
  member_type: string | null;
  rate_code: string | null;
  salesman: string | null;
  package_code: string | null;
  invoice_party: string | null;
  pay_type: string | null;
  breakfast: number | null;
  created_at: string | null;
  channel_name: string | null;
  company_name: string | null;
  booking_no: string | null;
  channel_order_no: string | null;
  arrival_time: string | null;
  retain_time: string | null;
  folio_id: number | null;
  folio_no: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  balance: number | null;
  folio_status: string | null;
  settled_at: string | null;
};

type ItemRaw = {
  id: number;
  item_type: string;
  description: string | null;
  qty: number | null;
  price: number | null;
  amount: number | null;
  biz_date: string | null;
  created_at: string | null;
  operator: string | null;
  room_type_name: string | null;
};

type PaymentRaw = {
  id: number;
  pay_no: string | null;
  method: string | null;
  amount: number | null;
  biz_date: string | null;
  remark: string | null;
  created_at: string | null;
};

type LogRaw = {
  id: number;
  operator: string | null;
  action: string;
  detail: string | null;
  created_at: string | null;
};

const LIST_TABS: { key: string; label: string }[] = [
  { key: "inhouse", label: "在住" },
  { key: "out", label: "已退房" },
  { key: "credit", label: "挂账" },
  { key: "all", label: "全部" },
];

const CREDIT_MARK = /【挂账】([^；]+)/;

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 同住人 / 叫醒记录表可能尚未创建，先探测再查询，避免整页报错 */
function hasTable(name: string) {
  return Boolean(get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
}

/** 从宽松行对象里取第一个有值的字段（表结构由入住模块维护，字段名可能略有差异） */
function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function isPartialSettle(it: { item_type: string; description: string | null }) {
  return it.item_type === "ADJUST" && (it.description ?? "").startsWith("【部分结账】");
}

function buildHref(tab: string, q: string, stayId: number) {
  const params = new URLSearchParams();
  if (tab && tab !== "inhouse") params.set("tab", tab);
  if (q) params.set("q", q);
  if (stayId > 0) params.set("stay", String(stayId));
  const qs = params.toString();
  return qs ? `/cashier?${qs}` : "/cashier";
}

function StatPill({
  label,
  value,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  tone?: "default" | "rose" | "emerald" | "amber";
  href?: string;
}) {
  const toneCls =
    tone === "rose"
      ? "text-[#d9534f]"
      : tone === "emerald"
        ? "text-[#3f9d57]"
        : tone === "amber"
          ? "text-[#c8811f]"
          : "text-[#333]";
  const body = (
    <span className="inline-flex items-baseline gap-1 text-[12px] leading-5 text-[#999]">
      {label}
      <b className={`tabular-nums font-medium ${toneCls}`}>{value}</b>
    </span>
  );
  return href ? (
    <Link href={href} className="hover:underline">
      {body}
    </Link>
  ) : (
    body
  );
}

/** 统计条里的中点分隔符 */
function Sep() {
  return <span className="text-[12px] leading-5 text-[#d0d0d0]">·</span>;
}

export default async function CashierPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  /*
   * 两个「今天」（第 4 轮 P1-1 配套）
   *
   * 收款写库用的是**营业日** `bizToday()`（cutoff 默认 05:00）：
   *   凌晨 00:00–05:00 收的钱记到前一个营业日，这样夜审按营业日对得上。
   * 但「今日退房」写的是**自然日** `todayStr()`（actual_check_out 存日期）。
   *
   * 所以两个统计必须分开取对应口径 —— 原来都用一个 todayStr()，
   * 结果凌晨收的钱在「今日收款」里看不到（写进了前一个营业日）。
   */
  const bizDay = bizToday(hotelId);
  const naturalDay = todayStr();
  const sp = await searchParams;
  const pickRaw = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] ?? "" : v ?? "");
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const selectedId = Number(typeof sp.stay === "string" ? sp.stay : 0) || 0;
  const rawTab = typeof sp.tab === "string" ? sp.tab : "inhouse";
  const tab = LIST_TABS.some((t) => t.key === rawTab) ? rawTab : "inhouse";

  // 顶部统计：在住 / 应收 / 押金 / 今日收款 / 今日退房 / 挂账户数
  const stats = get<{
    rooms: number;
    receivable: number;
    deposits: number;
    today_paid: number;
    today_out: number;
    credit_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND status = 'INHOUSE') AS rooms,
       (SELECT COALESCE(SUM(f.balance), 0) FROM folios f
          JOIN stays s ON s.id = f.stay_id
         WHERE f.hotel_id = ? AND s.status = 'INHOUSE' AND f.balance > 0) AS receivable,
       (SELECT COALESCE(SUM(deposit), 0) FROM stays WHERE hotel_id = ? AND status = 'INHOUSE') AS deposits,
       (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE hotel_id = ? AND biz_date = ?) AS today_paid,
       (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND status = 'CHECKED_OUT' AND actual_check_out = ?) AS today_out,
       (SELECT COUNT(*) FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND remark LIKE '%【挂账】%') AS credit_count`,
    [hotelId, hotelId, hotelId, hotelId, bizDay, hotelId, naturalDay, hotelId]
  ) ?? { rooms: 0, receivable: 0, deposits: 0, today_paid: 0, today_out: 0, credit_count: 0 };

  const counts = get<{ inhouse: number; out: number; credit: number; total: number }>(
    `SELECT
       SUM(CASE WHEN status = 'INHOUSE' THEN 1 ELSE 0 END) AS inhouse,
       SUM(CASE WHEN status = 'CHECKED_OUT' THEN 1 ELSE 0 END) AS out,
       SUM(CASE WHEN status = 'INHOUSE' AND remark LIKE '%【挂账】%' THEN 1 ELSE 0 END) AS credit,
       COUNT(*) AS total FROM stays WHERE hotel_id = ?`,
    [hotelId]
  ) ?? { inhouse: 0, out: 0, credit: 0, total: 0 };

  // 左侧客人列表（支持房号 / 客人搜索 + 状态筛选）
  const listParams: unknown[] = [hotelId];
  const where: string[] = [];
  if (tab === "inhouse") where.push("s.status = 'INHOUSE'");
  else if (tab === "out") where.push("s.status = 'CHECKED_OUT'");
  else if (tab === "credit") where.push("s.status = 'INHOUSE' AND s.remark LIKE '%【挂账】%'");
  if (q) {
    where.push("(r.room_no LIKE ? OR s.guest_name LIKE ?)");
    listParams.push(`%${q}%`, `%${q}%`);
  }
  const stays = all<ListRow>(
    `SELECT s.id AS stay_id, s.stay_no, r.room_no, s.guest_name, s.expect_check_out, s.actual_check_out,
            s.status AS stay_status, s.remark, f.balance, f.status AS folio_status
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
       LEFT JOIN folios f ON f.stay_id = s.id
      WHERE s.hotel_id = ?${where.length ? ` AND ${where.join(" AND ")}` : ""}
      ORDER BY r.sort, r.room_no`,
    listParams
  );

  // 选中客人的完整账单信息
  const selected = selectedId
    ? get<SelRow>(
        `SELECT s.id AS stay_id, s.stay_no, s.room_id, r.room_no, r.floor,
                rt.name AS room_type_name, s.guest_name, s.mobile,
                s.check_in_time, s.expect_check_out, s.actual_check_out, s.nights, s.rate, s.deposit,
                s.guest_count, s.status AS stay_status, s.remark, s.team_name, s.member_card,
                s.member_type, s.rate_code, s.salesman, s.package_code, s.invoice_party, s.pay_type,
                s.breakfast, s.created_at,
                c.name AS channel_name, co.name AS company_name,
                b.booking_no, b.channel_order_no, b.arrival_time, b.retain_time,
                f.id AS folio_id, f.folio_no, f.total_amount, f.paid_amount, f.balance,
                f.status AS folio_status, f.settled_at
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
           LEFT JOIN room_types rt ON rt.id = r.room_type_id
           LEFT JOIN channels c ON c.id = s.channel_id
           LEFT JOIN bookings b ON b.id = s.booking_id
           LEFT JOIN companies co ON co.id = b.company_id
           LEFT JOIN folios f ON f.stay_id = s.id
          WHERE s.hotel_id = ? AND s.id = ?`,
        [hotelId, selectedId]
      )
    : undefined;

  const rawItems = selected?.folio_id
    ? all<ItemRaw>(
        `SELECT fi.id, fi.item_type, fi.description, fi.qty, fi.price, fi.amount, fi.biz_date,
                fi.created_at, u.real_name AS operator, rt.name AS room_type_name
           FROM folio_items fi
           LEFT JOIN users u ON u.id = fi.created_by
           LEFT JOIN folios f ON f.id = fi.folio_id
           LEFT JOIN stays s2 ON s2.id = f.stay_id
           LEFT JOIN rooms r2 ON r2.id = s2.room_id
           LEFT JOIN room_types rt ON rt.id = r2.room_type_id
          WHERE fi.folio_id = ?
          ORDER BY fi.biz_date, fi.id`,
        [selected.folio_id]
      )
    : [];

  const rawPayments = selected?.folio_id
    ? all<PaymentRaw>(
        `SELECT id, pay_no, method, amount, biz_date, remark, created_at
           FROM payments WHERE folio_id = ? ORDER BY id DESC`,
        [selected.folio_id]
      )
    : [];

  const rawLogs = selected
    ? all<LogRaw>(
        `SELECT id, operator, action, detail, created_at FROM op_logs
          WHERE hotel_id = ? AND detail LIKE ? ORDER BY id DESC LIMIT 50`,
        [hotelId, `%${selected.stay_no}%`]
      )
    : [];

  // 发票汇总（开票记录在 op_logs 的 detail 文本里）
  let invoiced = 0;
  let invoiceCount = 0;
  if (selected) {
    const invoices = all<{ detail: string | null }>(
      `SELECT detail FROM op_logs WHERE hotel_id = ? AND action = '开发票' AND detail LIKE ?`,
      [hotelId, `%入住单 ${selected.stay_no}%`]
    );
    invoiceCount = invoices.length;
    for (const inv of invoices) {
      const m = /金额 ¥([\d,]+(?:\.\d+)?)/.exec(inv.detail ?? "");
      if (m) invoiced += Number(m[1].replace(/,/g, ""));
    }
  }

  const payments: CashierPayment[] = rawPayments.map((p) => ({
    id: p.id,
    payNo: p.pay_no,
    method: p.method,
    amount: Number(p.amount ?? 0),
    bizDate: p.biz_date,
    remark: p.remark,
    createdAt: p.created_at,
  }));

  const items: CashierItem[] = rawItems.map((it) => {
    let payMethod = "-";
    if (it.item_type === "DEPOSIT") {
      const hit = payments.find(
        (p) => Math.abs(p.amount - Number(it.amount ?? 0)) < 0.01 && /押金|预收/.test(p.remark ?? "")
      );
      payMethod = hit?.method ?? "-";
    } else if (isPartialSettle(it)) {
      const m = /^【部分结账】(.+?) 结账/.exec(it.description ?? "");
      payMethod = m?.[1] ?? "-";
    }
    return {
      id: it.id,
      itemType: it.item_type,
      description: it.description,
      qty: it.qty,
      price: it.price,
      amount: Number(it.amount ?? 0),
      bizDate: it.biz_date,
      createdAt: it.created_at,
      operator: it.operator ?? "系统",
      payMethod,
    };
  });

  const logs: CashierLog[] = rawLogs.map((l) => ({
    id: l.id,
    operator: l.operator,
    action: l.action,
    detail: l.detail,
    createdAt: l.created_at,
  }));

  const sums: Record<string, number> = { ROOM: 0, FOOD: 0, OTHER: 0, DEPOSIT: 0, ADJUST: 0 };
  let partialSettled = 0;
  for (const it of items) {
    sums[it.itemType] = (sums[it.itemType] ?? 0) + Number(it.amount ?? 0);
    if (it.itemType === "ADJUST" && (it.description ?? "").startsWith("【部分结账】")) {
      partialSettled += Math.abs(Number(it.amount ?? 0));
    }
  }

  const receivable = round2(Number(selected?.total_amount ?? 0));
  const received = round2(Number(selected?.paid_amount ?? 0));
  const balance = round2(Number(selected?.balance ?? 0));

  const totals: CashierTotals = {
    room: round2(sums.ROOM ?? 0),
    consume: round2((sums.FOOD ?? 0) + (sums.OTHER ?? 0)),
    deposit: round2(sums.DEPOSIT ?? 0),
    settle: round2(partialSettled),
    receivable,
    received,
    balance,
    invoiced: round2(invoiced),
  };

  const companies: CompanyOption[] = all<CompanyOption>(
    `SELECT id, name FROM companies WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const transferTargets: TransferTarget[] = selected
    ? all<{
        stay_id: number;
        folio_id: number;
        room_no: string;
        guest_name: string;
        balance: number;
      }>(
        `SELECT s.id AS stay_id, f.id AS folio_id, r.room_no, s.guest_name, f.balance
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
           JOIN folios f ON f.stay_id = s.id
          WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND f.status = 'OPEN' AND s.id <> ?
          ORDER BY r.sort, r.room_no`,
        [hotelId, selected.stay_id]
      ).map((t) => ({
        stayId: t.stay_id,
        folioId: t.folio_id,
        roomNo: t.room_no,
        guestName: t.guest_name,
        balance: Number(t.balance ?? 0),
      }))
    : [];

  const checkInLimit =
    get<{ value: string }>(`SELECT value FROM settings WHERE hotel_id = ? AND key = 'check_in_time'`, [hotelId])?.value ??
    "14:00";

  // 换房：可选目标空房（空净 / 空脏，且当前无在住客人）
  const vacantRooms: RoomOption[] = selected
    ? all<{ room_id: number; room_no: string; status: string; room_type_name: string | null }>(
        `SELECT r.id AS room_id, r.room_no, r.status, rt.name AS room_type_name
           FROM rooms r
           LEFT JOIN room_types rt ON rt.id = r.room_type_id
          WHERE r.hotel_id = ? AND r.status IN ('VC', 'VD')
            AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.room_id = r.id AND s.status = 'INHOUSE')
          ORDER BY r.sort, r.room_no`,
        [hotelId]
      ).map((r) => ({
        roomId: r.room_id,
        roomNo: r.room_no,
        status: r.status,
        roomTypeName: r.room_type_name,
      }))
    : [];

  // 联房：其他在住房间
  const inhouseStays: StayOption[] = selected
    ? all<{ stay_id: number; stay_no: string; room_no: string; guest_name: string }>(
        `SELECT s.id AS stay_id, s.stay_no, r.room_no, s.guest_name
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
          WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND s.id <> ?
          ORDER BY r.sort, r.room_no`,
        [hotelId, selected.stay_id]
      ).map((r) => ({
        stayId: r.stay_id,
        stayNo: r.stay_no,
        roomNo: r.room_no,
        guestName: r.guest_name,
      }))
    : [];

  // 同住人（表不存在时视为空）
  const companions: CompanionRow[] =
    selected && hasTable("stay_companions")
      ? all<Record<string, unknown>>(`SELECT * FROM stay_companions WHERE stay_id = ? ORDER BY id`, [
          selected.stay_id,
        ]).map((row, idx) => ({
          id: Number(row.id ?? idx + 1),
          name: pick(row, ["name", "guest_name", "companion_name"]) || "-",
          mobile: pick(row, ["mobile", "phone", "tel"]) || null,
          idNo: pick(row, ["id_no", "id_card", "id_number", "cert_no"]) || null,
          relation: pick(row, ["relation", "relationship", "guest_type"]) || null,
          createdAt: pick(row, ["created_at", "createdAt"]) || null,
        }))
      : [];

  // 叫醒记录（表不存在时视为空）
  const wakeUpCalls: WakeUpRow[] =
    selected && hasTable("wake_up_calls")
      ? all<Record<string, unknown>>(`SELECT * FROM wake_up_calls WHERE stay_id = ? ORDER BY id DESC`, [
          selected.stay_id,
        ]).map((row, idx) => ({
          id: Number(row.id ?? idx + 1),
          wakeTime: pick(row, ["wake_time", "wake_at", "wakeup_time", "call_time", "time"]) || null,
          content: pick(row, ["content", "remark", "note", "status"]) || null,
          createdAt: pick(row, ["created_at", "createdAt"]) || null,
        }))
      : [];

  const stay: CashierStay | undefined = selected
    ? {
        stayId: selected.stay_id,
        stayNo: selected.stay_no,
        roomId: selected.room_id,
        roomNo: selected.room_no,
        floor: selected.floor,
        roomTypeName: selected.room_type_name,
        guestName: selected.guest_name,
        mobile: selected.mobile,
        status: selected.stay_status,
        checkInTime: selected.check_in_time,
        expectCheckOut: selected.expect_check_out,
        actualCheckOut: selected.actual_check_out,
        nights: selected.nights,
        rate: Number(selected.rate ?? 0),
        deposit: selected.deposit,
        guestCount: selected.guest_count,
        remark: selected.remark,
        teamName: selected.team_name,
        memberCard: selected.member_card,
        memberType: selected.member_type,
        rateCode: selected.rate_code,
        salesman: selected.salesman,
        packageCode: selected.package_code,
        invoiceParty: selected.invoice_party,
        payType: selected.pay_type,
        breakfast: selected.breakfast,
        createdAt: selected.created_at,
        channelName: selected.channel_name,
        companyName: selected.company_name,
        bookingNo: selected.booking_no,
        channelOrderNo: selected.channel_order_no,
        arrivalTime: selected.arrival_time,
        retainTime: selected.retain_time,
      }
    : undefined;

  const folio: CashierFolio | null =
    selected?.folio_id && selected.folio_no
      ? {
          id: selected.folio_id,
          folioNo: selected.folio_no,
          totalAmount: receivable,
          paidAmount: received,
          balance,
          status: selected.folio_status ?? "OPEN",
          settledAt: selected.settled_at,
        }
      : null;

  const creditCompany = stay?.remark ? CREDIT_MARK.exec(stay.remark)?.[1] ?? null : null;

  return (
    <div className="flex h-[calc(100vh-36px)] flex-col gap-3 p-4">
      {/* 页面标题 + 统计条（12px 单行：在住 N 间 · 应收总额 ¥X · 今日收款 ¥Y） */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[17px] font-semibold text-gray-900">收银结账</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatPill label="在住" value={`${stats.rooms} 间`} />
            <Sep />
            <StatPill label="应收总额" value={fmtMoney(stats.receivable)} tone="rose" />
            <Sep />
            <StatPill label="今日收款" value={fmtMoney(stats.today_paid)} tone="emerald" />
            <Sep />
            <StatPill label="在住押金" value={fmtMoney(stats.deposits)} />
            <Sep />
            <StatPill label="今日退房" value={`${stats.today_out}`} tone="amber" />
            <Sep />
            <StatPill label="挂账" value={`${stats.credit_count} 户`} tone="amber" href="/cashier?tab=credit" />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href="/inhouse" className="btn-default h-[30px] px-2.5 text-[12px]">
            在住客人
          </Link>
          <Link href="/rooms" className="btn-default h-[30px] px-2.5 text-[12px]">
            房态图
          </Link>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* 左侧：客人列表 */}
        <aside className="flex w-[260px] shrink-0 flex-col overflow-hidden rounded border border-[#e5e5e5] bg-white">
          <form method="get" className="shrink-0 border-b border-gray-100 p-2.5">
            <div className="flex gap-1.5">
              <input name="q" defaultValue={q} placeholder="房号 / 客人姓名" className="input" />
              <button type="submit" className="btn-primary shrink-0 px-2.5 py-1.5">
                搜索
              </button>
            </div>
            {tab !== "inhouse" && <input type="hidden" name="tab" value={tab} />}
            {selectedId > 0 && <input type="hidden" name="stay" value={selectedId} />}
            {q && (
              <Link href="/cashier" className="mt-1.5 inline-block text-[11px] text-brand-600 hover:underline">
                清除搜索「{q}」
              </Link>
            )}
          </form>

          <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-2 py-1.5">
            {LIST_TABS.map((t) => {
              const count =
                t.key === "inhouse"
                  ? counts.inhouse
                  : t.key === "out"
                    ? counts.out
                    : t.key === "credit"
                      ? counts.credit
                      : counts.total;
              const active = t.key === tab;
              return (
                <Link
                  key={t.key}
                  href={buildHref(t.key, q, selectedId)}
                  className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                    active ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  {t.label}
                  <span className={`ml-0.5 ${active ? "text-white/70" : "text-gray-400"}`}>{count ?? 0}</span>
                </Link>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {stays.length === 0 && (
              <div className="px-3 py-10 text-center text-[12px] leading-relaxed text-gray-400">
                {q ? "没有匹配的客人" : tab === "out" ? "暂无已退房账单" : "暂无客人"}
              </div>
            )}
            {stays.map((s) => {
              const active = s.stay_id === selectedId;
              const owed = Number(s.balance ?? 0) > 0.01;
              const credit = /【挂账】/.test(s.remark ?? "");
              const departed = s.stay_status === "CHECKED_OUT";
              return (
                <Link
                  key={s.stay_id}
                  href={buildHref(tab, q, s.stay_id)}
                  className={`block border-l-[3px] px-3 py-2.5 transition-colors ${
                    active ? "border-brand-500 bg-brand-50" : "border-transparent hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[13px] font-semibold ${active ? "text-brand-700" : "text-gray-900"}`}>
                      {s.room_no}
                      {departed && (
                        <span className="ml-1.5 rounded bg-gray-400 px-1 text-[10px] font-normal text-white">离店</span>
                      )}
                      {credit && (
                        <span className="ml-1.5 rounded bg-amber-500 px-1 text-[10px] font-normal text-white">挂账</span>
                      )}
                      {!departed && s.expect_check_out === naturalDay && (
                        <span className="ml-1.5 rounded bg-rose-500 px-1 text-[10px] font-normal text-white">今离</span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 tabular-nums text-[12px] ${
                        owed ? "font-medium text-rose-600" : "text-gray-500"
                      }`}
                    >
                      {fmtMoney(s.balance)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-gray-600">{s.guest_name}</span>
                    <span className="shrink-0 text-gray-400">{s.expect_check_out ?? "-"} 离</span>
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-500">
            <span>共 {stays.length} 条</span>
            <span className="text-gray-400">{naturalDay}</span>
          </div>
        </aside>

        {/* 右侧：账单详情 + 账务操作 */}
        <section className="min-w-0 flex-1 overflow-y-auto pb-16">
          {!stay ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded border border-dashed border-[#dcdcdc] bg-white text-[#aaa]">
              <svg viewBox="0 0 24 24" className="h-9 w-9 fill-current text-[#dcdcdc]">
                <path d="M3 6h18v12H3V6zm2 2v8h14V8H5zm7 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
              </svg>
              <div className="text-[13px] text-[#888]">请从左侧选择一位客人</div>
              <div className="text-[11px]">可入账、收预收款、部分结账、转账、挂账、开发票与打印账单</div>
            </div>
          ) : !folio ? (
            <div className="rounded border border-[#e5e5e5] bg-white px-4 py-6 text-center text-[12px] text-[#aaa]">
              该入住单暂无账务单，请先到入住办理页生成账单
            </div>
          ) : (
            <CashierPanel
              stay={stay}
              folio={folio}
              items={items}
              payments={payments}
              logs={logs}
              companies={companies}
              transferTargets={transferTargets}
              vacantRooms={vacantRooms}
              inhouseStays={inhouseStays}
              companions={companions}
              wakeUpCalls={wakeUpCalls}
              totals={totals}
              invoiceCount={invoiceCount}
              checkInLimit={checkInLimit}
              creditCompany={creditCompany}
              initOp={pickRaw(sp.op)}
            />
          )}
        </section>
      </div>
    </div>
  );
}
