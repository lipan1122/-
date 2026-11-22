import Link from "next/link";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, todayStr } from "@/lib/utils";
import BookingForm, {
  type BookingType,
  type ChannelOption,
  type CompanyOption,
  type MemberOption,
  type RoomTypeOption,
  type SalesmanOption,
  type VacantRoom,
} from "@/components/BookingForm";

export const dynamic = "force-dynamic";

type NewBookingPageProps = {
  searchParams: Promise<{ type?: string; err?: string }>;
};

const TABS: { key: BookingType; label: string }[] = [
  { key: "guest", label: "散客预订" },
  { key: "team", label: "团队预订" },
];

export default async function NewBookingPage({ searchParams }: NewBookingPageProps) {
  const user = await requireUser();
  const hotelId = user.hotelId;

  const sp = await searchParams;
  const bookingType: BookingType = sp.type === "team" ? "team" : "guest";
  /*
   * 建单失败的明确文案（整改 P1-7：定金超总房费不能静默）
   * createBookingAction 校验不通过时 redirect 回本页并带上 err，
   * 这里渲染出来，用户才知道刚才那笔定金钱为什么没保存上。
   */
  const errMsg = typeof sp.err === "string" ? sp.err : "";

  // 房型 + 可订数（该房型 status='VC' 的房间数，由服务端算出后传给前端展示）
  const roomTypes = all<RoomTypeOption>(
    `SELECT rt.id, rt.code, rt.name, rt.bed_type, rt.max_occupancy, rt.base_price,
            (SELECT COUNT(*) FROM rooms r
              WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id AND r.status = 'VC') AS vacant_count
     FROM room_types rt
     WHERE rt.hotel_id = ?
     ORDER BY rt.sort, rt.id`,
    [hotelId]
  );

  const channels = all<ChannelOption>(
    `SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const companies = all<CompanyOption>(
    `SELECT id, name FROM companies WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const salesmen = all<SalesmanOption>(
    `SELECT id, username, real_name FROM users
     WHERE hotel_id = ? AND role = 'admin'
     ORDER BY id`,
    [hotelId]
  );

  const members = all<MemberOption>(
    `SELECT id, name, mobile, id_no, vip_level FROM guests
     WHERE hotel_id = ?
     ORDER BY id DESC
     LIMIT 500`,
    [hotelId]
  );

  const vacantRooms = all<VacantRoom>(
    `SELECT id, room_no, floor, room_type_id
     FROM rooms WHERE hotel_id = ? AND status = 'VC'
     ORDER BY floor, sort, room_no`,
    [hotelId]
  );

  const today = todayStr();
  const tomorrow = todayStr(addDays(today, 1));

  return (
    <div className="space-y-3 p-4">
      {/* 顶部标签栏：散客预订 / 团队预订（当前项绿色高亮），右侧关闭全部 */}
      <div className="card flex items-center px-3 py-1.5">
        <div className="flex flex-1 items-center justify-center gap-3">
          {TABS.map((tab) => {
            const active = tab.key === bookingType;
            return (
              <Link
                key={tab.key}
                href={`/bookings/new?type=${tab.key}`}
                className={`w-[108px] rounded-[2px] py-1 text-center text-[13px] transition-colors ${
                  active
                    ? "bg-[#ddeee0] font-semibold text-[#32c141]"
                    : "text-[#555555] hover:text-[#32c141]"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        <Link
          href="/bookings"
          className="ml-2 flex items-center gap-1 rounded-[4px] px-1.5 py-1 text-[12px] text-[#555555] transition-colors hover:text-[#58bc62]"
        >
          关闭全部
        </Link>
      </div>

      {errMsg ? (
        <div className="rounded-[3px] border border-[#f5c2c2] bg-[#fdf3f3] px-3 py-2 text-[12px] text-[#c0392b]">
          {errMsg}
        </div>
      ) : null}

      <BookingForm
        bookingType={bookingType}
        roomTypes={roomTypes}
        channels={channels}
        companies={companies}
        salesmen={salesmen}
        members={members}
        rooms={vacantRooms}
        defaultCheckIn={today}
        defaultCheckOut={tomorrow}
      />
    </div>
  );
}
