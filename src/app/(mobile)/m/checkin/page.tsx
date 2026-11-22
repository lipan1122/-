import Link from "next/link";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bizToday } from "@/lib/biz-date";
import { isAssignable } from "@/lib/room-status";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 移动端「办入住」（F13）
 *
 * 手机上办入住只做一件事：从今日预抵里选人 → 排房 → 确认。
 * 不做团队、不做钟点、不做多间——那些回到电脑版。
 */

export default async function MobileCheckinPage({
  searchParams,
}: {
  searchParams: Promise<{ booking?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const today = bizToday(user.hotelId);

  const arrivals = all<{
    id: number;
    booking_no: string;
    guest_name: string;
    mobile: string | null;
    room_type_id: number | null;
    room_type: string | null;
    room_no: string | null;
    check_in_date: string;
    check_out_date: string;
    nights: number | null;
    rate: number | null;
    room_count: number | null;
  }>(
    /*
     * P1-27：必须把 b.room_type_id 取出来。
     * 原来只取了房型名称 rt.name，排房面板拿 `a.room_type_id`（运行时 undefined）
     * 跟空房的 room_type_id（number | null）比，永远不相等 → 面板恒为空。
     * P1-28a：预抵口径对齐桌面工作台（dashboard/page.tsx），只算「今天」的预抵。
     */
    `SELECT b.id, b.booking_no, b.guest_name, b.mobile,
            b.room_type_id, rt.name AS room_type, r.room_no,
            b.check_in_date, b.check_out_date, b.nights, b.rate,
            COALESCE(b.room_count, 1) AS room_count
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id
       LEFT JOIN rooms r ON r.id = b.room_id
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date = ?
      ORDER BY b.check_in_date, b.id
      LIMIT 50`,
    [user.hotelId, today]
  );

  /*
   * 可选空房（按房型分组，给排房用）
   * P1-28d：口径统一走 isAssignable（VC 或 VD），不再各处手写状态清单。
   */
  const vacant = all<{
    id: number;
    room_no: string;
    room_type_id: number | null;
    room_type: string | null;
    floor: number | null;
    status: string;
  }>(
    `SELECT r.id, r.room_no, r.room_type_id, rt.name AS room_type, r.floor, r.status
       FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = ?
      ORDER BY r.floor, r.room_no`,
    [user.hotelId]
  ).filter((r) => isAssignable(r.status));

  const selected = sp.booking ? arrivals.find((a) => String(a.id) === sp.booking) : undefined;

  return (
    <div className="mx-auto max-w-[520px]">
      <div className="sticky top-0 z-10 border-b border-[#e5e5e5] bg-white/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="text-[15px] font-semibold text-gray-900">办入住</div>
          <div className="text-[11px] text-[#8b949e]">今日预抵 {arrivals.length} 单 · 空房 {vacant.length} 间</div>
        </div>
        <div className="mt-1 text-[11px] text-[#b0b8bf]">点订单展开排房；排完到电脑版办理正式入住</div>
      </div>

      <div className="space-y-2 px-3 py-3">
        {arrivals.length === 0 && (
          <div className="rounded-[8px] border border-dashed border-[#dcdcdc] bg-white py-16 text-center text-[13px] text-[#8b949e]">
            今天没有待入住的订单
          </div>
        )}

        {arrivals.map((a) => {
          const isOpen = selected?.id === a.id;
          /* P1-27：同房型空房。去掉原来的 as unknown as 转义，类型直接来自 SQL。 */
          const sameType = vacant.filter((v) => v.room_type_id != null && v.room_type_id === a.room_type_id);
          return (
            <div key={a.id} className="overflow-hidden rounded-[8px] bg-white">
              <Link
                href={isOpen ? "/m/checkin" : `/m/checkin?booking=${a.id}`}
                prefetch={false}
                className="block p-3 active:bg-[#f7f7f7]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[14px] font-medium text-gray-900">{a.guest_name}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-[#8b949e]">{a.booking_no}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-[#8b949e]">
                      {a.mobile ?? "无手机"} · {a.room_type ?? "未指定房型"} · {a.nights ?? 1} 晚
                      {a.room_no && <span className="ml-1 text-emerald-700">已排 {a.room_no}</span>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[14px] font-semibold tabular-nums text-gray-900">{fmtMoney(a.rate ?? 0)}</div>
                    <div className="text-[10px] text-[#b0b8bf]">{isOpen ? "收起" : "排房 ›"}</div>
                  </div>
                </div>
              </Link>

              {isOpen && (
                <div className="border-t border-[#f0f0f0] bg-[#fafafa] p-3">
                  {sameType.length === 0 ? (
                    <div className="text-[12px] text-[#8b949e]">该房型暂无可排的空房，请到电脑版做升级排房</div>
                  ) : (
                    <>
                      <div className="mb-1.5 text-[11.5px] text-[#8b949e]">可选 {a.room_type}（{sameType.length} 间）</div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {sameType.map((v) => (
                          <Link
                            key={v.id}
                            href={`/bookings?q=${encodeURIComponent(a.booking_no)}`}
                            prefetch={false}
                            className="flex h-9 items-center justify-center rounded-[4px] border border-[#dcdcdc] bg-white text-[12px] tabular-nums text-gray-700 active:bg-[#f2f3f5]"
                          >
                            {v.room_no}
                          </Link>
                        ))}
                      </div>
                      <div className="mt-2 text-[10.5px] text-[#b0b8bf]">
                        点房号会跳到电脑版预订页完成排房与入住（手机上不做多步表单）
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="px-3 pb-4 text-center text-[10.5px] text-[#b0b8bf]">
        完整入住（团队/钟点/多间/押金）请用电脑版
      </div>
    </div>
  );
}
