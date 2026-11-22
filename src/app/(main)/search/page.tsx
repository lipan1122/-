import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtMoney, BOOKING_STATUS } from "@/lib/utils";
import { unifiedSearch } from "./data";

export const dynamic = "force-dynamic";

const ROOM_STATUS_LABEL: Record<string, string> = {
  VC: "空净",
  VD: "空脏",
  OC: "在住净",
  OD: "在住脏",
  OOO: "维修",
  LOCK: "锁房",
};

const STAY_STATUS_LABEL: Record<string, string> = {
  INHOUSE: "在住",
  CHECKED_OUT: "已离店",
  CANCELLED: "已取消",
};

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-4 py-2.5">
        <span className="text-[13px] font-semibold text-gray-800">{title}</span>
        <span className="text-[11px] text-gray-400">{count} 条</span>
      </div>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  );
}

/**
 * 统一搜索（整改报告 P2-10）
 *
 * 顶部搜索框跳这里：一个输入框同时查客人、预订、入住单、房间。
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const result = unifiedSearch(user.hotelId, q);

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-[16px] font-semibold text-gray-900">统一搜索</h1>
        <p className="mt-0.5 text-[12px] text-gray-500">
          {q
            ? `关键词「${q}」· 共找到 ${result.total} 条（客人 ${result.guests.length} / 预订 ${result.bookings.length} / 入住 ${result.stays.length} / 房间 ${result.rooms.length}）`
            : "在顶部搜索框输入客人姓名、手机号、订单号、单号或房号"}
        </p>
      </div>

      {/* 搜索框（页面内也放一个，方便直接改关键词） */}
      <form method="get" className="flex items-center gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="客人姓名 / 手机号 / 预订号 / 入住单号 / 房号"
          className="input h-8 w-full max-w-[420px] text-[12px]"
        />
        <button type="submit" className="btn-primary h-8 px-3 text-[12px]">
          搜索
        </button>
      </form>

      {!q && (
        <div className="rounded-[4px] border border-dashed border-[#dcdcdc] bg-white px-4 py-16 text-center">
          <div className="text-[14px] text-gray-500">输入关键词开始搜索</div>
          <div className="mt-1.5 text-[11.5px] text-gray-400">
            支持：客人姓名、手机号、证件号、预订号（BK…）、入住单号（SI…）、渠道单号、房号
          </div>
        </div>
      )}

      {q && result.total === 0 && (
        <div className="rounded-[4px] border border-dashed border-[#dcdcdc] bg-white px-4 py-16 text-center">
          <div className="text-[14px] text-gray-500">没有找到「{q}」相关的记录</div>
          <div className="mt-1.5 text-[11.5px] text-gray-400">
            换个关键词试试；或者在宾客列表用高级筛选
          </div>
        </div>
      )}

      {/* 客人 */}
      <Section title="客人档案" count={result.guests.length}>
        {result.guests.map((g) => (
          <div key={g.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f3f4f6] text-[12px] text-gray-600">
              {(g.name ?? "?").slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-gray-800">{g.name}</span>
                {Number(g.vipLevel ?? 0) > 0 && (
                  <span className="rounded-[2px] bg-[#fff7e6] px-1 text-[10px] text-[#b07d2e]">VIP{g.vipLevel}</span>
                )}
                {g.deleted === 1 && (
                  <span className="rounded-[2px] bg-gray-100 px-1 text-[10px] text-gray-500">已删除</span>
                )}
              </div>
              <div className="text-[11px] text-gray-400">
                {g.mobile ?? "无手机号"}
                {g.idNo ? ` · ${g.idNo}` : ""}
              </div>
            </div>
            <Link
              href={`/guests?q=${encodeURIComponent(g.mobile ?? g.name)}`}
              className="shrink-0 rounded-[2px] border border-[#dcdcdc] px-2 py-0.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            >
              查看
            </Link>
          </div>
        ))}
      </Section>

      {/* 预订 */}
      <Section title="预订" count={result.bookings.length}>
        {result.bookings.map((b) => (
          <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] text-gray-500">{b.bookingNo}</span>
                <span className="text-[13px] text-gray-800">{b.guestName}</span>
                <span
                  className={`rounded-[3px] border px-1 text-[10px] leading-[15px] ${
                    BOOKING_STATUS[b.status]?.cls ?? "border-gray-200 bg-gray-100 text-gray-500"
                  }`}
                >
                  {BOOKING_STATUS[b.status]?.label ?? b.status}
                </span>
                {b.roomNo && (
                  <span className="rounded border border-emerald-200 bg-emerald-50 px-1 text-[10px] text-emerald-700">
                    {b.roomNo}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-gray-400">
                {b.mobile ?? "无手机"} · {b.checkIn} → {b.checkOut} · {b.roomCount} 间
              </div>
            </div>
            <Link
              href={`/bookings?q=${encodeURIComponent(b.bookingNo)}`}
              className="shrink-0 rounded-[2px] border border-[#dcdcdc] px-2 py-0.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            >
              查看
            </Link>
          </div>
        ))}
      </Section>

      {/* 入住单 */}
      <Section title="入住单" count={result.stays.length}>
        {result.stays.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] text-gray-500">{s.stayNo}</span>
                <span className="text-[13px] text-gray-800">{s.guestName}</span>
                <span className="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] text-gray-600">
                  {s.roomNo}
                </span>
                <span
                  className={`rounded-[3px] px-1 text-[10px] ${
                    s.status === "INHOUSE"
                      ? "bg-[#f1f9f3] text-[#1e8e3e]"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {STAY_STATUS_LABEL[s.status] ?? s.status}
                </span>
              </div>
              <div className="text-[11px] text-gray-400">
                {s.mobile ?? "无手机"} · 入住 {s.checkIn ?? "-"} · 预离 {s.expectOut ?? "-"}
                {Number(s.balance) > 0.01 && (
                  <span className="ml-1 text-[#c0392b]">· 欠费 {fmtMoney(s.balance)}</span>
                )}
              </div>
            </div>
            <Link
              href={s.status === "INHOUSE" ? `/cashier?stay=${s.id}` : `/guest-detail?stay=${s.id}`}
              className="shrink-0 rounded-[2px] border border-[#dcdcdc] px-2 py-0.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            >
              {s.status === "INHOUSE" ? "收银台" : "详情"}
            </Link>
          </div>
        ))}
      </Section>

      {/* 房间 */}
      <Section title="房间" count={result.rooms.length}>
        {result.rooms.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold tabular-nums text-gray-800">{r.roomNo}</span>
                <span className="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] text-gray-600">
                  {ROOM_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </div>
              <div className="text-[11px] text-gray-400">
                {r.roomType ?? "-"}
                {r.floor != null ? ` · ${r.floor} 楼` : ""}
              </div>
            </div>
            <Link
              href={`/rooms?room=${encodeURIComponent(r.roomNo)}`}
              className="shrink-0 rounded-[2px] border border-[#dcdcdc] px-2 py-0.5 text-[11.5px] text-[#5f6b76] hover:border-[#32c141] hover:text-[#32c141]"
            >
              房态
            </Link>
          </div>
        ))}
      </Section>
    </div>
  );
}
