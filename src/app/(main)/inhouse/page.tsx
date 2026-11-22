import Link from "next/link";
import ConfirmForm from "@/components/ConfirmForm";
import { all } from "@/lib/db";
import { ensureCancelRequestsTable } from "@/lib/cancel-requests";
import { requireUser } from "@/lib/session";
import { addDays, fmtMoney, todayStr } from "@/lib/utils";
import {
  approveCancelAction,
  changeRoomAction,
  convertStayModeAction,
  extendStayAction,
  postAllMissingRoomChargesAction,
  postRoomChargeAction,
  rejectCancelAction,
  requestCancelAction,
} from "./actions";

export const dynamic = "force-dynamic";

/** 钟点房可选小时数（rate = 门市价 × 15% × 小时数） */
const HOUR_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type InHouseRow = {
  id: number;
  stay_no: string;
  guest_name: string | null;
  mobile: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  nights: number | null;
  rate: number | null;
  guest_count: number | null;
  room_no: string;
  room_type_name: string | null;
  base_price: number | null;
  channel_name: string | null;
  folio_id: number | null;
  total_amount: number | null;
  paid_amount: number | null;
  balance: number | null;
  remark: string | null;
};

type RoomOption = { id: number; room_no: string; status: string; room_type_name: string };

/** 空隔夜检查候选行（昨日入住且在住） */
type BlankNightRow = {
  id: number;
  stay_no: string;
  guest_name: string | null;
  check_in_time: string | null;
  rate: number | null;
  room_no: string | null;
  folio_id: number | null;
};

/** 取消入住申请行 */
type CancelRow = {
  id: number;
  stay_id: number | null;
  room_no: string | null;
  guest_name: string | null;
  reason: string | null;
  status: string;
  requested_by: string | null;
  approved_by: string | null;
  created_at: string | null;
  approved_at: string | null;
};

const CANCEL_STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "待审批", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  APPROVED: { label: "已批准", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  REJECTED: { label: "已拒绝", cls: "border-gray-200 bg-gray-50 text-gray-500" },
};

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function fmtCheckInTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** yyyy-mm-dd hh:mm */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/** 生成 [from, to] 之间的营业日列表（含首尾，最多 31 天） */
function ymdRange(from: string, to: string, cap = 31): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00`);
  let cur = new Date(`${from}T00:00:00`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return out;
  while (cur <= end && out.length < cap) {
    out.push(todayStr(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

/** 入住日期（按本地时区取 check_in_time 的日期部分） */
function checkInDateOf(iso: string | null, fallback: string) {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : todayStr(d);
}

/** 某账单在 [from, to] 内缺少房费（ROOM）明细的营业日 */
function missingRoomDates(folioId: number | null, from: string, to: string): string[] {
  if (!folioId) return ymdRange(from, to);
  const posted = new Set(
    all<{ biz_date: string | null }>(
      `SELECT DISTINCT biz_date FROM folio_items
        WHERE folio_id = ? AND item_type = 'ROOM' AND biz_date IS NOT NULL`,
      [folioId]
    ).map((r) => String(r.biz_date ?? ""))
  );
  return ymdRange(from, to).filter((d) => !posted.has(d));
}

/** 缺少的营业日文案：超过 3 天折叠显示 */
function missingText(list: string[]) {
  if (list.length === 0) return "—";
  if (list.length <= 3) return list.join("、");
  return `${list.slice(0, 3).join("、")} 等 ${list.length} 天`;
}

export default async function InHousePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const yesterday = todayStr(addDays(today, -1));

  const sp = await searchParams;
  const msg = first(sp.msg);
  const err = first(sp.err);
  const checked = first(sp.check) === "1";

  const rows = all<InHouseRow>(
    `SELECT s.id, s.stay_no, s.guest_name, s.mobile, s.check_in_time, s.expect_check_out,
            s.nights, s.rate, s.guest_count, s.remark,
            r.room_no, rt.name AS room_type_name, rt.base_price,
            c.name AS channel_name,
            f.id AS folio_id, f.total_amount, f.paid_amount, f.balance
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN channels c ON c.id = s.channel_id
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     ORDER BY r.sort, r.room_no`,
    [hotelId]
  );

  const availableRooms = all<RoomOption>(
    `SELECT r.id, r.room_no, r.status, rt.name AS room_type_name
     FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.hotel_id = ? AND r.status IN ('VC','VD')
     ORDER BY r.sort, r.room_no`,
    [hotelId]
  );

  // ---------------------------------------------------------------------------
  // 空隔夜检查：昨日入住、仍在住，且今天还没有房费（biz_date = 今天）明细的房
  // 缺少的营业日 = 入住日 ~ 今天之间没有任何 ROOM 明细的日期
  // ---------------------------------------------------------------------------
  const blankCandidates = all<BlankNightRow>(
    `SELECT s.id, s.stay_no, s.guest_name, s.check_in_time, s.rate, r.room_no,
            (SELECT id FROM folios WHERE stay_id = s.id ORDER BY id DESC LIMIT 1) AS folio_id
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND date(s.check_in_time, 'localtime') = ?
      ORDER BY r.sort, r.room_no`,
    [hotelId, yesterday]
  );

  const blankNights = blankCandidates
    .map((s) => {
      const from = checkInDateOf(s.check_in_time, today);
      const missing = missingRoomDates(s.folio_id, from, today);
      return { ...s, from, missing };
    })
    .filter((s) => s.missing.length > 0);

  const blankMissingDays = blankNights.reduce((n, s) => n + s.missing.length, 0);
  const blankAmount = blankNights.reduce((n, s) => n + Number(s.rate ?? 0) * s.missing.length, 0);

  // ---------------------------------------------------------------------------
  // 取消入住审批
  // ---------------------------------------------------------------------------
  ensureCancelRequestsTable();
  const cancelRequests = all<CancelRow>(
    `SELECT id, stay_id, room_no, guest_name, reason, status,
            requested_by, approved_by, created_at, approved_at
       FROM cancel_requests
      WHERE hotel_id = ?
      ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, id DESC
      LIMIT 50`,
    [hotelId]
  );

  const pendingCancelCount = cancelRequests.filter((r) => r.status === "PENDING").length;
  const pendingStayIds = new Set(
    cancelRequests.filter((r) => r.status === "PENDING" && r.stay_id).map((r) => Number(r.stay_id))
  );

  const dueOut = rows.filter((r) => r.expect_check_out === today);
  const owedCount = rows.filter((r) => (r.balance ?? 0) > 0.009).length;
  const hourlyCount = rows.filter((r) => (r.nights ?? 0) === 0).length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">在住客人</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            前台业务 / 在住客人 · 查看在住客人账务，办理延住、换房、时租转换、取消审批与退房结账
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[12px] text-blue-700">
            在住 <b className="tabular-nums">{rows.length}</b> 间
          </span>
          <span className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">
            今日应离 <b className="tabular-nums">{dueOut.length}</b> 间
          </span>
          {owedCount > 0 && (
            <span className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-600">
              待收余额 <b className="tabular-nums">{owedCount}</b> 间
            </span>
          )}
          {hourlyCount > 0 && (
            <span className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[12px] text-violet-700">
              钟点房 <b className="tabular-nums">{hourlyCount}</b> 间
            </span>
          )}
          <span
            className={`rounded-md border px-2.5 py-1.5 text-[12px] ${
              blankNights.length > 0
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            空隔夜 <b className="tabular-nums">{blankNights.length}</b> 间
          </span>
          <Link href={`/inhouse?check=1#blanknight`} className="btn-default py-1.5">
            空隔夜检查
          </Link>
          <Link href="#cancel" className="btn-default py-1.5">
            取消审批
            <b className="ml-1 tabular-nums text-rose-600">{pendingCancelCount}</b>
          </Link>
          <Link href="/frontdesk" className="btn-primary py-1.5">办理入住</Link>
        </div>
      </div>

      {msg && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-emerald-500 px-4 py-2.5">
          <span className="text-[12px] text-emerald-700">{msg}</span>
          <Link href="/inhouse" className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}
      {err && (
        <div className="card flex items-start justify-between gap-3 border-l-4 border-l-rose-500 px-4 py-2.5">
          <span className="text-[12px] text-rose-600">{err}</span>
          <Link href="/inhouse" className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600">
            关闭
          </Link>
        </div>
      )}

      {/* ===================== 空隔夜检查 ===================== */}
      <div className="card overflow-x-auto scroll-mt-4" id="blanknight">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">
            空隔夜检查
            {blankNights.length > 0 && (
              <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-[11px] text-rose-600">
                {blankNights.length} 间 / {blankMissingDays} 个营业日
              </span>
            )}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-400">
              扫描口径：昨日入住、当前在住、今天没有房费明细（folio_items 无 biz_date={today} 的 ROOM 记录）
            </span>
            {blankNights.length > 0 && (
              /* P2-22c：补过房费会直接往账单里过账，必须先确认金额和间数 */
              <ConfirmForm
                action={postAllMissingRoomChargesAction}
                message={`将为 ${blankCandidates.length} 间在住客房补记缺失房费，共 ${fmtMoney(blankAmount)}`}
                detail={`缺失 ${blankNights.length} 个营业日的 ROOM 明细。补记后账单应收余额会同步增加，请确认金额无误。`}
                confirmLabel="确认补记"
                danger={false}
              >
                <button className="btn-primary px-2.5 py-1 text-[12px]">
                  一键补过房费（{fmtMoney(blankAmount)}）
                </button>
              </ConfirmForm>
            )}
          </div>
        </div>

        {checked && (
          <div className="border-b border-gray-100 bg-emerald-50/60 px-4 py-2 text-[12px] text-emerald-700">
            检查完成：昨日入住且在住 <b className="tabular-nums">{blankCandidates.length}</b> 间，其中{" "}
            <b className="tabular-nums">{blankNights.length}</b> 间缺少房费明细，共缺{" "}
            <b className="tabular-nums">{blankMissingDays}</b> 个营业日。
          </div>
        )}

        {blankNights.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-gray-400">
            {blankCandidates.length === 0
              ? "昨日没有入住的在住单，无需检查"
              : "未发现空隔夜：昨日入住的房间今天都已有房费明细"}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th">入住时间</th>
                <th className="th">缺少的营业日</th>
                <th className="th text-right">应补房费</th>
                <th className="th">操作</th>
              </tr>
            </thead>
            <tbody>
              {blankNights.map((s) => {
                const amount = Number(s.rate ?? 0) * s.missing.length;
                return (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="td">
                      <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[12px] font-semibold text-rose-700">
                        {s.room_no ?? "-"}
                      </span>
                    </td>
                    <td className="td text-gray-800">
                      {s.guest_name ?? "-"}
                      <div className="text-[11px] text-gray-400">{s.stay_no}</div>
                    </td>
                    <td className="td tabular-nums text-gray-600">{fmtCheckInTime(s.check_in_time)}</td>
                    <td className="td text-gray-600" title={s.missing.join("、")}>
                      <div className="text-[12px] text-rose-600">{missingText(s.missing)}</div>
                      <div className="text-[11px] text-gray-400">
                        入住日 {s.from} · 缺 {s.missing.length} 天
                      </div>
                    </td>
                    <td className="td text-right tabular-nums text-gray-700">
                      {fmtMoney(amount)}
                      <div className="text-[11px] text-gray-400">{fmtMoney(s.rate)} / 晚</div>
                    </td>
                    <td className="td">
                      <form action={postRoomChargeAction}>
                        <input type="hidden" name="stay_id" value={s.id} />
                        <button className="btn-default px-2 py-1 text-[12px] text-brand-700">补过房费</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ===================== 取消入住审批 ===================== */}
      <div className="card overflow-x-auto scroll-mt-4" id="cancel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <span className="text-[13px] font-semibold text-gray-800">取消入住审批</span>
          <span className="text-[11px] text-gray-400">
            待审批 {pendingCancelCount} 条 · 批准后退房：入住单 CHECKED_OUT / 账单 SETTLED / 房间 VD
          </span>
        </div>

        <form action={requestCancelAction} className="flex flex-wrap items-end gap-2 border-b border-gray-100 px-4 py-3">
          <div className="min-w-[220px]">
            <label className="label">申请取消的在住单 *</label>
            <select name="stay_id" className="input" defaultValue="" required>
              <option value="">请选择在住单…</option>
              {rows.map((s) => (
                <option key={s.id} value={s.id}>
                  {`${s.room_no} · ${s.guest_name ?? "-"} · ${s.stay_no}`}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[240px] flex-1">
            <label className="label">取消原因 *</label>
            <input name="reason" required className="input" placeholder="例如：客人行程变更、房间设施问题等" />
          </div>
          <button className="btn-primary px-3 py-1.5 text-[12px]">申请取消入住</button>
        </form>

        <table className="w-full">
          <thead>
            <tr>
              <th className="th">房号</th>
              <th className="th">客人</th>
              <th className="th">原因</th>
              <th className="th">状态</th>
              <th className="th">申请 / 审批</th>
              <th className="th">操作</th>
            </tr>
          </thead>
          <tbody>
            {cancelRequests.length === 0 && (
              <tr>
                <td colSpan={6} className="td py-8 text-center text-[12px] text-gray-400">
                  暂无取消入住申请，可在上方选择在住单发起申请
                </td>
              </tr>
            )}
            {cancelRequests.map((r) => {
              const meta = CANCEL_STATUS_META[r.status] ?? {
                label: r.status,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
              };
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="td">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[12px] text-gray-700">
                      {r.room_no ?? "-"}
                    </span>
                    <div className="text-[11px] text-gray-400">#{r.id}</div>
                  </td>
                  <td className="td text-gray-800">{r.guest_name ?? "-"}</td>
                  <td className="td max-w-[240px] whitespace-normal text-gray-600" title={r.reason ?? ""}>
                    <span className="line-clamp-2 break-words whitespace-normal">{r.reason || "—"}</span>
                  </td>
                  <td className="td">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="td text-[11px] text-gray-500">
                    <div>申请：{r.requested_by ?? "—"} · {fmtDateTime(r.created_at)}</div>
                    <div>
                      审批：{r.approved_by ?? "—"} · {fmtDateTime(r.approved_at)}
                    </div>
                  </td>
                  <td className="td">
                    {r.status === "PENDING" ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <form action={approveCancelAction}>
                          <input type="hidden" name="id" value={r.id} />
                          <button className="btn-default px-2 py-1 text-[12px] text-rose-600">批准并退房</button>
                        </form>
                        <form action={rejectCancelAction} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <input
                            name="note"
                            placeholder="审批意见（可空）"
                            className="input w-[120px] py-1 text-[12px]"
                          />
                          <button className="btn-default px-2 py-1 text-[12px]">拒绝</button>
                        </form>
                      </div>
                    ) : (
                      <span className="text-[11px] text-gray-300">已处理</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ===================== 在住客人列表 ===================== */}
      <div className="card overflow-x-auto">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">房号</th>
                <th className="th">客人</th>
                <th className="th">入住时间</th>
                <th className="th">预计离店</th>
                <th className="th">晚数</th>
                <th className="th">房价</th>
                <th className="th">渠道</th>
                <th className="th">
                  <span className="block text-right">余额</span>
                </th>
                <th className="th">状态</th>
                <th className="th">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="td py-12 text-center text-[12px] text-gray-400" colSpan={10}>
                    当前没有在住客人
                    <div className="mt-1 text-[11px] text-gray-400">
                      前台办理入住后，客人会自动出现在这里
                    </div>
                    <Link href="/frontdesk" className="btn-default mt-3 inline-flex py-1.5">
                      去办理入住
                    </Link>
                  </td>
                </tr>
              )}

              {rows.map((s) => {
                const isDueOut = s.expect_check_out === today;
                const owed = (s.balance ?? 0) > 0.009;
                const nights = Number(s.nights ?? 0);
                const isHourly = nights === 0;
                const rack = Number(s.base_price ?? 0) > 0 ? Number(s.base_price) : Number(s.rate ?? 0);
                const pendingCancel = pendingStayIds.has(s.id);
                return (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[12px] font-semibold text-blue-700">
                          {s.room_no}
                        </span>
                        <span className="text-[11px] text-gray-400">{s.room_type_name ?? "-"}</span>
                      </div>
                    </td>
                    <td className="td">
                      <div className="text-gray-800">{s.guest_name ?? "-"}</div>
                      <div className="text-[11px] text-gray-400">
                        {s.mobile || "-"} · {s.guest_count ?? 1} 人 · {s.stay_no}
                      </div>
                    </td>
                    <td className="td tabular-nums text-gray-600">{fmtCheckInTime(s.check_in_time)}</td>
                    <td className="td tabular-nums">
                      <span className={isDueOut ? "font-medium text-amber-600" : "text-gray-700"}>
                        {s.expect_check_out ?? "-"}
                      </span>
                      {isDueOut && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] leading-[15px] text-amber-700">
                          今离
                        </span>
                      )}
                    </td>
                    <td className="td tabular-nums text-gray-700">
                      {isHourly ? (
                        <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700">
                          钟点
                        </span>
                      ) : (
                        `${nights} 晚`
                      )}
                    </td>
                    <td className="td tabular-nums text-gray-700">{fmtMoney(s.rate)}</td>
                    <td className="td text-gray-600">{s.channel_name ?? "散客"}</td>
                    <td className="td text-right tabular-nums">
                      {owed ? (
                        <span className="font-medium text-red-600">欠 {fmtMoney(s.balance)}</span>
                      ) : (
                        <span className="text-gray-500">{fmtMoney(s.balance ?? 0)}</span>
                      )}
                    </td>
                    <td className="td">
                      <div className="flex flex-col gap-1">
                        <span className="w-fit rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] leading-[15px] text-blue-700">
                          在住
                        </span>
                        {pendingCancel && (
                          <span className="w-fit rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] leading-[15px] text-amber-700">
                            待审取消
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <form action={extendStayAction}>
                          <input type="hidden" name="stay_id" value={s.id} />
                          <button className="btn-default px-2 py-1 text-[12px]">延住 +1 晚</button>
                        </form>

                        <form action={changeRoomAction} className="flex items-center gap-1">
                          <input type="hidden" name="stay_id" value={s.id} />
                          <select
                            name="new_room_id"
                            defaultValue=""
                            aria-label={`为 ${s.room_no} 换房`}
                            className="input w-[150px] py-1 text-[12px]"
                          >
                            <option value="">换房…</option>
                            {availableRooms.map((r) => (
                              <option key={r.id} value={r.id}>
                                {`${r.room_no} · ${r.room_type_name} · ${r.status === "VC" ? "空净" : "空脏"}`}
                              </option>
                            ))}
                          </select>
                          <button className="btn-default px-2 py-1 text-[12px]">换房</button>
                        </form>

                        <Link href={`/cashier?stay=${s.id}`} className="btn-primary px-2 py-1 text-[12px]">
                          退房
                        </Link>

                        <details className="inline-block">
                          <summary className="cursor-pointer list-none text-[12px] text-brand-600 hover:underline">
                            更多（时租 / 取消）
                          </summary>
                          <div className="mt-1.5 flex w-[260px] flex-col gap-1.5 rounded-md border border-gray-200 bg-white p-2 shadow-sm">
                            {isHourly ? (
                              <form action={convertStayModeAction} className="flex items-center gap-1">
                                <input type="hidden" name="stay_id" value={s.id} />
                                <input type="hidden" name="mode" value="daily" />
                                <select
                                  name="nights"
                                  defaultValue="1"
                                  aria-label={`${s.room_no} 转日租晚数`}
                                  className="input w-[96px] py-1 text-[12px]"
                                >
                                  {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                                    <option key={n} value={n}>
                                      {n} 晚
                                    </option>
                                  ))}
                                </select>
                                <button className="btn-default px-2 py-1 text-[12px]">转日租</button>
                              </form>
                            ) : (
                              <form action={convertStayModeAction} className="flex items-center gap-1">
                                <input type="hidden" name="stay_id" value={s.id} />
                                <input type="hidden" name="mode" value="hourly" />
                                <select
                                  name="hours"
                                  defaultValue="3"
                                  aria-label={`${s.room_no} 转钟点房小时数`}
                                  className="input w-[152px] py-1 text-[12px]"
                                >
                                  {HOUR_OPTIONS.map((h) => (
                                    <option key={h} value={h}>
                                      {`${h} 小时 · ${fmtMoney(round2(rack * 0.15 * h))}`}
                                    </option>
                                  ))}
                                </select>
                                <button className="btn-default px-2 py-1 text-[12px]">转钟点</button>
                              </form>
                            )}
                            <div className="text-[10px] text-gray-400">
                              {isHourly
                                ? `当前为钟点房；转日租按门市价 ${fmtMoney(rack)}/晚、从今天起计`
                                : `转钟点：门市价 ${fmtMoney(rack)} × 15% × 小时数，预计离店改为今天`}
                            </div>
                            <form action={requestCancelAction} className="flex items-center gap-1">
                              <input type="hidden" name="stay_id" value={s.id} />
                              <input
                                name="reason"
                                required
                                placeholder="取消入住原因"
                                className="input w-[150px] py-1 text-[12px]"
                              />
                              <button className="btn-default px-2 py-1 text-[12px] text-rose-600">申请取消</button>
                            </form>
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-gray-400">
        共 {rows.length} 间在住 · 今日应离 {dueOut.length} 间 · 可用房 {availableRooms.length} 间 · 钟点房{" "}
        {hourlyCount} 间 · 空隔夜 {blankNights.length} 间 · 待审批取消 {pendingCancelCount} 条
        <br />
        延住按原房价增补一晚房费；换房仅调整房间与账务单房号；时租/日租转换只改入住单的晚数、房价与备注，已过账房费不追溯重算。
      </p>
    </div>
  );
}
