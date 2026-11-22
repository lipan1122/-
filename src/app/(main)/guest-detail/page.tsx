import Link from "next/link";
import { notFound } from "next/navigation";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, ROOM_STATUS } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 客人 / 订单详情页
 *
 * 对照去呼呼宾客列表点「查看」打开的详情页（图 1）：
 *   顶部渠道来源条 → 预订人信息 → 房间备注 → 操作按钮条 →
 *   tab（订单详情 / 财务明细）→ 房间信息 / 入住人信息
 */

type StayDetail = {
  id: number;
  stay_no: string;
  booking_id: number | null;
  guest_name: string;
  mobile: string | null;
  room_no: string | null;
  room_type_name: string | null;
  rate: number;
  nights: number;
  check_in_time: string | null;
  expect_check_out: string | null;
  breakfast: number | null;
  remark: string | null;
  channel_name: string | null;
  team_name: string | null;
  member_card: string | null;
  rate_code: string | null;
  salesman: string | null;
  invoice_party: string | null;
  pay_type: string | null;
  deposit: number | null;
  status: string;
  created_at: string | null;
  balance: number | null;
  booking_no: string | null;
  channel_order_no: string | null;
};

type BookingDetail = {
  id: number;
  booking_no: string;
  guest_name: string;
  mobile: string | null;
  room_no: string | null;
  room_type_name: string | null;
  rate: number;
  check_in_date: string;
  check_out_date: string;
  breakfast: number | null;
  remark: string | null;
  channel_name: string | null;
  team_name: string | null;
  member_card: string | null;
  rate_code: string | null;
  salesman: string | null;
  invoice_party: string | null;
  pay_type: string | null;
  status: string;
  created_at: string | null;
  nights: number;
};

const LABEL = "text-[11.5px] text-[#9aa4ae]";
const VAL = "text-[12px] text-[#333]";
const BOX = "rounded-[3px] border border-[#e8ebe9] bg-white";

export default async function GuestDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; id?: string; tab?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const id = Number(sp.id ?? 0);
  const type = sp.type === "booking" ? "booking" : "stay";
  const tab = sp.tab === "folio" ? "folio" : sp.tab === "logs" ? "logs" : "detail";
  if (!id) notFound();

  if (type === "stay") {
    const s = get<StayDetail>(
      `SELECT s.id, s.stay_no, s.booking_id, s.guest_name, s.mobile,
              r.room_no, rt.name AS room_type_name, s.rate, s.nights,
              s.check_in_time, s.expect_check_out, s.breakfast, s.remark,
              c.name AS channel_name, s.team_name, s.member_card, s.rate_code,
              s.salesman, s.invoice_party, s.pay_type, s.deposit, s.status, s.created_at,
              f.balance, b.booking_no, NULL AS channel_order_no
         FROM stays s
         LEFT JOIN rooms r ON r.id = s.room_id
         LEFT JOIN room_types rt ON rt.id = r.room_type_id
         LEFT JOIN channels c ON c.id = s.channel_id
         LEFT JOIN folios f ON f.stay_id = s.id
         LEFT JOIN bookings b ON b.id = s.booking_id
        WHERE s.id = ? AND s.hotel_id = ?`,
      [id, user.hotelId]
    );
    if (!s) notFound();

    const flows = all<{ biz_date: string; description: string; amount: number; item_type: string }>(
      `SELECT fi.biz_date, COALESCE(fi.description, fi.item_type) AS description, fi.amount, fi.item_type
         FROM folio_items fi JOIN folios f ON f.id = fi.folio_id
        WHERE fi.hotel_id = ? AND f.stay_id = ?
        ORDER BY fi.biz_date DESC, fi.id DESC LIMIT 200`,
      [user.hotelId, id]
    );
    const pays = all<{ biz_date: string; method: string; amount: number }>(
      `SELECT biz_date, COALESCE(method, '') AS method, amount FROM payments
        WHERE hotel_id = ? AND stay_id = ? ORDER BY biz_date DESC LIMIT 100`,
      [user.hotelId, id]
    );
    const wakes = all<{ wake_time: string; note: string | null; status: string | null; room_no: string | null }>(
      `SELECT wake_time, note, status, room_no FROM wake_up_calls
        WHERE hotel_id = ? AND stay_id = ? ORDER BY wake_time DESC LIMIT 20`,
      [user.hotelId, id]
    );
    const logs = all<{ operator: string; action: string; detail: string | null; created_at: string }>(
      `SELECT operator, action, detail, created_at FROM op_logs
        WHERE hotel_id = ? AND (detail LIKE ? OR detail LIKE ?)
        ORDER BY created_at DESC LIMIT 50`,
      [user.hotelId, `%${s.stay_no}%`, `%${s.guest_name}%`]
    );
    const linkCount =
      get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM room_links rl WHERE rl.hotel_id = ? AND rl.stay_id = ?`,
        [user.hotelId, id]
      )?.c ?? 0;

    const roomStatus = s.room_no
      ? get<{ status: string }>(`SELECT status FROM rooms WHERE room_no = ? AND hotel_id = ?`, [s.room_no, user.hotelId])?.status
      : null;

    const statusFilters: [string, string][] = [
      ["booked", "预订"],
      ["inhouse", "在住"],
      ["left-today", "离店"],
      ["cancelled", "取消"],
      ["noshow", "失约"],
      ["ledger", "挂账"],
      ["all", "全部"],
    ];

    return (
      <div className="flex gap-2 p-3">
        {/* 左侧状态栏（去呼呼详情页左边那栏） */}
        <aside className="w-[170px] shrink-0">
          <div className={`${BOX} mb-2 px-2 py-2`}>
            {statusFilters.map(([key, label]) => (
              <Link
                key={key}
                prefetch={false}
                href={`/guests?tab=${key}`}
                className="flex items-center gap-1.5 py-[3px] text-[12px] text-[#555] hover:text-[#2a9d3c]"
              >
                <span className="inline-block h-[11px] w-[11px] rounded-[1px] border border-[#c9d0ce]" />
                {label}
              </Link>
            ))}
          </div>
          <div className={`${BOX} px-2 py-2 text-[11.5px]`}>
            <Link
              prefetch={false}
              href={`/cashier?stay=${s.id}&op=link`}
              className="mb-1.5 block text-[#2a9d3c] hover:underline"
            >
              查看所有联房{linkCount > 0 ? `（${linkCount}）` : ""}
            </Link>
            <div className="text-[#333]">
              {s.room_no ?? "未排房"} {s.guest_name}
            </div>
            <div className="text-[#9aa4ae]">
              余额：<span className="tabular-nums text-[#e23b3b]">{fmtMoney(s.balance ?? 0)}</span>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
        {/* 顶部：房间号 + 客人 + 返回 */}
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <Link prefetch={false} href="/guests" className="text-[12px] text-[#2a9d3c] hover:underline">
            ‹ 返回宾客列表
          </Link>
          <span className="text-[13px] font-semibold text-[#222]">
            {s.room_no ?? "未排房"} · {s.guest_name}
          </span>
          <span className="rounded-[2px] bg-[#f0f7f1] px-1.5 py-0.5 text-[11px] text-[#2a9d3c]">
            {ROOM_STATUS[roomStatus ?? ""]?.label ?? s.status}
          </span>
          <span className="text-[11.5px] text-[#9aa4ae]">
            余额 <span className="tabular-nums text-[#e23b3b]">{fmtMoney(s.balance ?? 0)}</span>
          </span>
          {linkCount > 0 && (
            <Link prefetch={false} href={`/cashier?stay=${s.id}&op=link`} className="text-[11.5px] text-[#2a9d3c] hover:underline">
              查看所有联房（{linkCount}）
            </Link>
          )}
          <Link
            prefetch={false}
            href={`/cashier?stay=${s.id}`}
            className="rounded-[2px] border border-[#dcdcdc] bg-white px-2 py-[2px] text-[11.5px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d3c]"
          >
            修改/补充订单信息
          </Link>
        </div>

        {/* 渠道来源条 */}
        <div className={`${BOX} mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2`}>
          <span className={LABEL}>渠道来源：<b className="text-[12px] text-[#333]">{s.channel_name ?? "散客"}</b></span>
          <span className={LABEL}>渠道订单号：<b className="tabular-nums text-[12px] text-[#333]">{s.channel_order_no ?? s.booking_no ?? "-"}</b></span>
          <span className={LABEL}>团队名称：<b className="text-[12px] text-[#333]">{s.team_name?.trim() || "-"}</b></span>
          <span className={LABEL}>会员信息：<b className="text-[12px] text-[#333]">{s.member_card?.trim() || "-"}</b></span>
          <span className="ml-auto text-[11px] text-[#9aa4ae]">创建时间：{s.created_at?.slice(0, 16).replace("T", " ") ?? "-"}</span>
        </div>

        {/* 预订人信息 */}
        <div className={`${BOX} mb-2 px-3 py-2`}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-8">
            {[
              ["预订人姓名", s.guest_name],
              ["预订人手机号", s.mobile ?? "-"],
              ["预订房型", s.room_type_name ?? "-"],
              ["预订房价", fmtMoney(s.rate)],
              ["早餐数", String(s.breakfast ?? 0)],
              ["入住日期", (s.check_in_time ?? "").slice(0, 16).replace("T", " ")],
              ["离店日期", s.expect_check_out ?? "-"],
              ["入住天数", `${s.nights ?? 1}晚`],
              ["收款类型", s.pay_type ?? "-"],
              ["开票方", s.invoice_party ?? "-"],
              ["销售员", s.salesman?.trim() || "-"],
              ["房价代码", s.rate_code ?? "-"],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <div className={LABEL}>{k}</div>
                <div className={`${VAL} truncate`}>{v}</div>
              </div>
            ))}
          </div>
          {s.remark?.trim() && (
            <div className="mt-2 border-t border-[#f2f4f3] pt-1.5 text-[11.5px] leading-[17px] text-[#666]">
              <span className="text-[#9aa4ae]">房间备注：</span>
              {s.remark}
            </div>
          )}
        </div>

        {/* 操作按钮条 */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {[
            ["联房", `/cashier?stay=${s.id}&op=link`],
            ["换房", `/cashier?stay=${s.id}&op=change`],
            ["调价", `/cashier?stay=${s.id}&op=rate`],
            ["续住", `/cashier?stay=${s.id}&op=extend`],
            ["延迟退房", `/cashier?stay=${s.id}&op=checkout-time`],
            ["同住", `/cashier?stay=${s.id}&op=share`],
            ["入团", `/cashier?stay=${s.id}&op=team`],
          ].map(([label, href]) => (
            <Link
              key={label}
              prefetch={false}
              href={href}
              className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[12px] text-white hover:bg-[#2bb038]"
            >
              {label}
            </Link>
          ))}
          <Link
            prefetch={false}
            href={`/orders?tab=all&q=${encodeURIComponent(s.booking_no ?? s.stay_no)}`}
            className="rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 py-[3px] text-[12px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d3c]"
          >
            查看渠道订单
          </Link>
          <Link
            prefetch={false}
            href={`/cashier?stay=${s.id}`}
            className="ml-auto rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 py-[3px] text-[12px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d3c]"
          >
            打开账务（收银台）
          </Link>
        </div>

        {/* tab */}
        <div className={`${BOX} mb-2`}>
          <div className="flex items-center gap-4 border-b border-[#eef0ef] px-3">
            {[
              ["detail", "订单详情"],
              ["folio", "财务明细"],
              ["logs", "日志"],
            ].map(([k, label]) => (
              <Link
                key={k}
                prefetch={false}
                href={`/guest-detail?type=stay&id=${s.id}&tab=${k}`}
                className={`border-b-2 py-2 text-[12.5px] ${
                  tab === k ? "border-[#32c141] text-[#2a9d3c]" : "border-transparent text-[#666] hover:text-[#2a9d3c]"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>

          {tab === "detail" ? (
            <div className="px-3 py-2.5">
              <div className="mb-1 text-[12.5px] font-medium text-[#222]">房间信息</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-8">
                {[
                  ["状态", ROOM_STATUS[roomStatus ?? ""]?.label ?? s.status],
                  ["房间号", s.room_no ?? "未排房"],
                  ["房型", s.room_type_name ?? "-"],
                  ["总房价", fmtMoney(s.rate * (s.nights ?? 1))],
                  ["入住时间", (s.check_in_time ?? "").slice(0, 16).replace("T", " ")],
                  ["离店时间", s.expect_check_out ?? "-"],
                  ["入住天数", `${s.nights ?? 1}晚`],
                  ["总早餐数", String((s.breakfast ?? 0) * (s.nights ?? 1))],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div className={LABEL}>{k}</div>
                    <div className={VAL}>{v}</div>
                  </div>
                ))}
              </div>

              <div className="mt-3 border-t border-[#f2f4f3] pt-2">
                <div className="mb-1 flex items-center gap-2 text-[12.5px] font-medium text-[#222]">
                  入住人信息
                  <Link
                    prefetch={false}
                    href={`/cashier?stay=${s.id}&op=share`}
                    className="rounded-[2px] bg-[#32c141] px-2 py-[2px] text-[11px] text-white hover:bg-[#2bb038]"
                  >
                    添加同住人
                  </Link>
                </div>
                <div className="flex items-center gap-4 text-[12px] text-[#333]">
                  <span>客人姓名：{s.guest_name}</span>
                  <span className="text-[11.5px] text-[#9aa4ae]">手机：{s.mobile ?? "-"}</span>
                  <Link
                    prefetch={false}
                    href={`/members?q=${encodeURIComponent(s.guest_name)}`}
                    className="rounded-[2px] bg-[#32c141] px-2 py-[2px] text-[11px] text-white hover:bg-[#2bb038]"
                  >
                    发展为会员
                  </Link>
                </div>
              </div>

              <div className="mt-3 border-t border-[#f2f4f3] pt-2">
                <div className="mb-1 flex items-center gap-2 text-[12.5px] font-medium text-[#222]">
                  叫醒信息
                  <Link
                    prefetch={false}
                    href={`/cashier?stay=${s.id}&op=wakeup`}
                    className="rounded-[2px] bg-[#32c141] px-2 py-[2px] text-[11px] text-white hover:bg-[#2bb038]"
                  >
                    设置叫醒
                  </Link>
                </div>
                {wakes.length === 0 ? (
                  <div className="text-[11.5px] text-[#9aa4ae]">无</div>
                ) : (
                  <ul className="space-y-0.5 text-[11.5px] text-[#333]">
                    {wakes.map((w, i) => (
                      <li key={i} className="tabular-nums">
                        {w.wake_time} · {w.room_no ?? s.room_no} · {w.status ?? "待叫醒"}
                        {w.note ? ` · ${w.note}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="px-3 py-2.5">
              <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th text-left">营业日</th>
                    <th className="th text-left">摘要</th>
                    <th className="th text-right">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {flows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-6 text-center text-[12px] text-[#9aa4ae]">
                        暂无消费流水
                      </td>
                    </tr>
                  )}
                  {flows.map((f, i) => (
                    <tr key={i}>
                      <td className="td tabular-nums text-[#666]">{f.biz_date}</td>
                      <td className="td text-[#333]">{f.description}</td>
                      <td className="td text-right tabular-nums text-[#e23b3b]">{fmtMoney(f.amount)}</td>
                    </tr>
                  ))}
                  {pays.map((p, i) => (
                    <tr key={`p${i}`}>
                      <td className="td tabular-nums text-[#666]">{p.biz_date}</td>
                      <td className="td text-[#333]">收款 · {p.method}</td>
                      <td className="td text-right tabular-nums text-[#2a9d3c]">-{fmtMoney(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
          {tab === "logs" && (
            <div className="px-3 py-2.5">
              <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th text-left">时间</th>
                    <th className="th text-left">操作人</th>
                    <th className="th text-left">操作</th>
                    <th className="th text-left">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-[12px] text-[#9aa4ae]">
                        暂无操作日志
                      </td>
                    </tr>
                  )}
                  {logs.map((l, i) => (
                    <tr key={i}>
                      <td className="td tabular-nums text-[#666]">{l.created_at?.slice(0, 16).replace("T", " ")}</td>
                      <td className="td text-[#333]">{l.operator}</td>
                      <td className="td text-[#333]">{l.action}</td>
                      <td className="td text-[#666]">{l.detail ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    );
  }

  /* ---------- 预订详情 ---------- */
  const b = get<BookingDetail>(
    `SELECT b.id, b.booking_no, b.guest_name, b.mobile, r.room_no, rt.name AS room_type_name,
            b.rate, b.check_in_date, b.check_out_date, b.breakfast, b.remark,
            c.name AS channel_name, b.team_name, b.member_card, b.rate_code,
            b.salesman, b.invoice_party, b.pay_type, b.status, b.created_at
       FROM bookings b
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN room_types rt ON rt.id = b.room_type_id
       LEFT JOIN channels c ON c.id = b.channel_id
      WHERE b.id = ? AND b.hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!b) notFound();
  const nights = Math.max(
    1,
    Math.round((new Date(b.check_out_date).getTime() - new Date(b.check_in_date).getTime()) / 86400000)
  );

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <Link prefetch={false} href="/guests" className="text-[12px] text-[#2a9d3c] hover:underline">
          ‹ 返回宾客列表
        </Link>
        <span className="text-[13px] font-semibold text-[#222]">
          {b.room_no ?? "未排房"} · {b.guest_name}
        </span>
        <span className="rounded-[2px] bg-[#f0f7f1] px-1.5 py-0.5 text-[11px] text-[#2a9d3c]">
          {b.status === "CONFIRMED" ? "已确认" : b.status === "PENDING" ? "待排房" : b.status}
        </span>
      </div>

      <div className={`${BOX} mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2`}>
        <span className={LABEL}>渠道来源：<b className="text-[12px] text-[#333]">{b.channel_name ?? "散客"}</b></span>
        <span className={LABEL}>订单号：<b className="tabular-nums text-[12px] text-[#333]">{b.booking_no}</b></span>
        <span className={LABEL}>团队名称：<b className="text-[12px] text-[#333]">{b.team_name?.trim() || "-"}</b></span>
        <span className={LABEL}>会员信息：<b className="text-[12px] text-[#333]">{b.member_card?.trim() || "-"}</b></span>
        <span className="ml-auto text-[11px] text-[#9aa4ae]">创建时间：{b.created_at?.slice(0, 16).replace("T", " ") ?? "-"}</span>
      </div>

      <div className={`${BOX} mb-2 px-3 py-2`}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-8">
          {[
            ["预订人姓名", b.guest_name],
            ["预订人手机号", b.mobile ?? "-"],
            ["预订房型", b.room_type_name ?? "-"],
            ["预订房价", fmtMoney(b.rate)],
            ["早餐数", String(b.breakfast ?? 0)],
            ["入住日期", b.check_in_date],
            ["离店日期", b.check_out_date],
            ["入住天数", `${nights}晚`],
            ["收款类型", b.pay_type ?? "-"],
            ["开票方", b.invoice_party ?? "-"],
            ["销售员", b.salesman?.trim() || "-"],
            ["房价代码", b.rate_code ?? "-"],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className={LABEL}>{k}</div>
              <div className={`${VAL} truncate`}>{v}</div>
            </div>
          ))}
        </div>
        {b.remark?.trim() && (
          <div className="mt-2 border-t border-[#f2f4f3] pt-1.5 text-[11.5px] leading-[17px] text-[#666]">
            <span className="text-[#9aa4ae]">订单备注：</span>
            {b.remark}
          </div>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Link
          prefetch={false}
          href={`/bookings?tab=all&q=${encodeURIComponent(b.booking_no)}`}
          className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[12px] text-white hover:bg-[#2bb038]"
        >
          去排房
        </Link>
        <Link
          prefetch={false}
          href={`/frontdesk?booking=${b.id}`}
          className="rounded-[2px] bg-[#32c141] px-2.5 py-[3px] text-[12px] text-white hover:bg-[#2bb038]"
        >
          办理入住
        </Link>
        <Link
          prefetch={false}
          href={`/orders?tab=all&q=${encodeURIComponent(b.booking_no)}`}
          className="rounded-[2px] border border-[#dcdcdc] bg-white px-2.5 py-[3px] text-[12px] text-[#555] hover:border-[#32c141] hover:text-[#2a9d3c]"
        >
          查看渠道订单
        </Link>
      </div>
    </div>
  );
}
