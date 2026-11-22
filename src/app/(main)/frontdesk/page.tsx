import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { BOOKING_STATUS, ROLE_LABEL, addDays, fmtMoney, nightsBetween, todayStr } from "@/lib/utils";
import CheckInForm, {
  type BookingPrefill,
  type ChannelOption,
  type CheckInMode,
  type CompanyOption,
  type MemberOption,
  type RoomTypeGroup,
  type SalesmanOption,
  type VacantRoom,
} from "@/components/CheckInForm";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type BookingRow = {
  id: number;
  booking_no: string;
  guest_name: string | null;
  mobile: string | null;
  room_type_id: number | null;
  room_type_name: string | null;
  room_id: number | null;
  channel_id: number | null;
  channel_name: string | null;
  company_name: string | null;
  check_in_date: string;
  check_out_date: string;
  nights: number | null;
  guest_count: number | null;
  rate: number | null;
  deposit: number | null;
  status: string;
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
  channel_order_no: string | null;
};

type RoomTypeRow = {
  id: number;
  name: string;
  base_price: number;
  max_occupancy: number | null;
};

type RoomRow = {
  id: number;
  room_no: string;
  floor: number | null;
  status: string;
  room_type_id: number;
};

type ChannelRow = { id: number; name: string | null };

type CompanyRow = { id: number; name: string | null };

type MemberRow = {
  id: number;
  name: string;
  mobile: string | null;
  id_no: string | null;
  vip_level: number | null;
};

type SalesmanRow = { real_name: string; role: string };

type SettingRow = { key: string; value: string | null };

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export default async function FrontDeskPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const today = todayStr();
  const sp = await searchParams;

  const mode: CheckInMode = first(sp.mode) === "hour" ? "hour" : "day";
  const bookingParam = Math.trunc(Number(first(sp.booking))) || 0;
  const roomParam = Math.trunc(Number(first(sp.room))) || 0;

  // 来源预订：带入客人、房型、日期、房价、渠道、协议单位等信息
  const booking =
    bookingParam > 0
      ? get<BookingRow>(
          `SELECT b.id, b.booking_no, b.guest_name, b.mobile, b.room_type_id, rt.name AS room_type_name,
                  b.room_id, b.channel_id, c.name AS channel_name, co.name AS company_name,
                  b.check_in_date, b.check_out_date, b.nights, b.guest_count, b.rate, b.deposit,
                  b.status, b.remark, b.team_name, b.member_card, b.member_type, b.rate_code,
                  b.salesman, b.package_code, b.invoice_party, b.pay_type, b.breakfast,
                  b.channel_order_no
           FROM bookings b
           LEFT JOIN room_types rt ON rt.id = b.room_type_id
           LEFT JOIN channels c ON c.id = b.channel_id
           LEFT JOIN companies co ON co.id = b.company_id
           WHERE b.id = ? AND b.hotel_id = ?`,
          [bookingParam, hotelId]
        )
      : undefined;

  // 重新入住：从一条历史入住单带入客人信息（去呼呼宾客列表「重新入住」）
  const fromStayParam = Math.trunc(Number(first(sp.fromStay))) || 0;
  const fromStay =
    fromStayParam > 0
      ? get<{
          guest_name: string; mobile: string | null; room_type_id: number | null;
          channel_id: number | null; rate: number; breakfast: number | null;
          team_name: string | null; member_card: string | null; rate_code: string | null;
          salesman: string | null; invoice_party: string | null; pay_type: string | null;
          company: string | null; remark: string | null; nights: number | null;
        }>(
          `SELECT s.guest_name, s.mobile, r.room_type_id, s.channel_id, s.rate, s.breakfast,
                  s.team_name, s.member_card, s.rate_code, s.salesman, s.invoice_party, s.pay_type,
                  s.remark, s.nights, NULL AS company
             FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
            WHERE s.id = ? AND s.hotel_id = ?`,
          [fromStayParam, hotelId]
        )
      : undefined;

  // 房型 + 可售房（空净 VC / 空脏 VD），按房型分组供「快速排房」使用
  const roomTypes = all<RoomTypeRow>(
    `SELECT id, name, COALESCE(base_price, 0) AS base_price, max_occupancy
     FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );
  const vacantRooms = all<RoomRow>(
    `SELECT id, room_no, floor, status, room_type_id
     FROM rooms WHERE hotel_id = ? AND status IN ('VC','VD')
     ORDER BY sort, room_no`,
    [hotelId]
  );
  // 今日预抵：待排房 / 已确认、今日入住的预订（与 dashboard 口径一致）
  const arrivalToday =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bookings
        WHERE hotel_id = ? AND check_in_date = ? AND status IN ('PENDING','CONFIRMED')`,
      [hotelId, today]
    )?.n ?? 0;

  const roomTypeGroups: RoomTypeGroup[] = roomTypes.map((t) => ({
    id: t.id,
    name: t.name,
    base_price: Number(t.base_price ?? 0),
    max_occupancy: t.max_occupancy,
    rooms: vacantRooms
      .filter((r) => r.room_type_id === t.id)
      .map<VacantRoom>((r) => ({
        id: r.id,
        room_no: r.room_no,
        floor: r.floor,
        status: r.status,
      })),
  }));

  const channels: ChannelOption[] = all<ChannelRow>(
    `SELECT id, name FROM channels WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  ).map((c) => ({ id: c.id, name: c.name ?? `渠道 #${c.id}` }));

  const companies: CompanyOption[] = all<CompanyRow>(
    `SELECT id, name FROM companies WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  ).map((c) => ({ id: c.id, name: c.name ?? `单位 #${c.id}` }));

  const members: MemberOption[] = all<MemberRow>(
    `SELECT id, name, mobile, id_no, vip_level FROM guests WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  ).map((g) => ({
    id: g.id,
    name: g.name,
    mobile: g.mobile ?? "",
    idNo: g.id_no ?? "",
    vipLevel: g.vip_level ?? 0,
  }));

  const salesmen: SalesmanOption[] = all<SalesmanRow>(
    `SELECT real_name, role FROM users WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  ).map((u) => ({ name: u.real_name, role: ROLE_LABEL[u.role] ?? u.role }));

  const settings = all<SettingRow>(`SELECT key, value FROM settings WHERE hotel_id = ?`, [hotelId]);
  const checkOutTimeDefault =
    settings.find((s) => s.key === "check_out_time")?.value || "12:00";

  const now = new Date();
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  // 默认排房：?room= 优先，其次预订已排房
  const vacantIdSet = new Set(vacantRooms.map((r) => r.id));
  const defaultRoomIds: number[] = [];
  if (roomParam > 0 && vacantIdSet.has(roomParam)) {
    defaultRoomIds.push(roomParam);
  } else if (booking?.room_id && vacantIdSet.has(booking.room_id)) {
    defaultRoomIds.push(booking.room_id);
  }

  const bookingNights =
    booking?.nights && booking.nights > 0
      ? booking.nights
      : booking
        ? nightsBetween(booking.check_in_date, booking.check_out_date)
        : 1;

  const prefill: BookingPrefill | null = booking
    ? {
        id: booking.id,
        bookingNo: booking.booking_no,
        guestName: booking.guest_name ?? "",
        mobile: booking.mobile ?? "",
        checkInDate: booking.check_in_date,
        checkOutDate: booking.check_out_date,
        nights: bookingNights,
        rate: booking.rate ?? 0,
        deposit: booking.deposit ?? 0,
        guestCount: booking.guest_count ?? 1,
        channelId: booking.channel_id,
        channelName: booking.channel_name,
        roomTypeId: booking.room_type_id,
        roomTypeName: booking.room_type_name,
        roomIds: defaultRoomIds,
        teamName: booking.team_name ?? "",
        memberCard: booking.member_card ?? "",
        rateCode: booking.rate_code ?? "门市价",
        companyName: booking.company_name ?? "",
        salesman: booking.salesman ?? "",
        packageCode: booking.package_code ?? "",
        invoiceParty: booking.invoice_party ?? "酒店",
        payType: booking.pay_type ?? "到店付款",
        breakfast: booking.breakfast ?? 0,
        channelOrderNo: booking.channel_order_no ?? "",
      }
    : fromStay
      ? {
          // 重新入住：沿用上次的客人、房价、渠道、会员等信息
          id: 0,
          bookingNo: "",
          guestName: fromStay.guest_name ?? "",
          mobile: fromStay.mobile ?? "",
          checkInDate: today,
          checkOutDate: todayStr(addDays(new Date(today), Math.max(1, Number(fromStay.nights ?? 1)))),
          nights: Math.max(1, Number(fromStay.nights ?? 1)),
          rate: Number(fromStay.rate ?? 0),
          deposit: 0,
          guestCount: 1,
          channelId: fromStay.channel_id,
          channelName: null,
          roomTypeId: fromStay.room_type_id,
          roomTypeName: roomTypes.find((t) => t.id === fromStay.room_type_id)?.name ?? null,
          roomIds: [],
          teamName: fromStay.team_name ?? "",
          memberCard: fromStay.member_card ?? "",
          rateCode: fromStay.rate_code ?? "门市价",
          companyName: fromStay.company ?? "",
          salesman: fromStay.salesman ?? "",
          packageCode: "",
          invoiceParty: fromStay.invoice_party ?? "酒店",
          payType: fromStay.pay_type ?? "到店付款",
          breakfast: Number(fromStay.breakfast ?? 0),
          channelOrderNo: "",
        }
      : null;

  // tab 切换时保留预订 / 排房参数
  const tabParams = new URLSearchParams();
  if (booking) tabParams.set("booking", String(booking.id));
  if (defaultRoomIds.length > 0) tabParams.set("room", String(defaultRoomIds[0]));
  const querySuffix = tabParams.toString() ? `&${tabParams.toString()}` : "";

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">
        <span>
          当前可用房 <b className="font-semibold">{vacantRooms.length}</b> 间
        </span>
        <span className="text-emerald-300">·</span>
        <span>
          今日预抵 <b className="font-semibold">{arrivalToday}</b> 单
        </span>
      </div>

      {fromStay && (
        <div className="card mb-2 border-l-4 border-l-amber-500 p-3">
          <span className="text-[13px] font-semibold text-gray-800">重新入住</span>
          <span className="ml-2 text-[11px] text-gray-400">
            已带入上次的客人 {fromStay.guest_name}
            {fromStay.mobile ? ` · ${fromStay.mobile}` : ""}，可修改后办理入住
          </span>
        </div>
      )}

      {booking && (
        <div className="card border-l-4 border-l-emerald-500 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-gray-800">
              预订 {booking.booking_no}
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] leading-[15px] ${
                BOOKING_STATUS[booking.status]?.cls ?? "border-gray-200 bg-gray-100 text-gray-500"
              }`}
            >
              {BOOKING_STATUS[booking.status]?.label ?? booking.status}
            </span>
            <span className="text-[11px] text-gray-400">
              已按预订信息自动带入，可修改后办理入住
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <dt className="text-[11px] text-gray-400">客人</dt>
              <dd className="mt-0.5 truncate text-gray-800">
                {booking.guest_name ?? "-"}
                {booking.mobile ? ` · ${booking.mobile}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-gray-400">房型</dt>
              <dd className="mt-0.5 truncate text-gray-800">{booking.room_type_name ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-gray-400">入住 / 离店</dt>
              <dd className="mt-0.5 tabular-nums text-gray-800">
                {booking.check_in_date} → {booking.check_out_date}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-gray-400">晚数 / 房价</dt>
              <dd className="mt-0.5 tabular-nums text-gray-800">
                {bookingNights} 晚 · {fmtMoney(booking.rate ?? 0)}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-gray-400">渠道</dt>
              <dd className="mt-0.5 truncate text-gray-800">{booking.channel_name ?? "散客"}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-gray-400">协议单位</dt>
              <dd className="mt-0.5 truncate text-gray-800">{booking.company_name ?? "-"}</dd>
            </div>
          </dl>
        </div>
      )}

      <CheckInForm
        mode={mode}
        roomTypes={roomTypeGroups}
        channels={channels}
        companies={companies}
        members={members}
        salesmen={salesmen}
        prefill={prefill}
        defaultRoomIds={defaultRoomIds}
        today={today}
        nowTime={nowTime}
        checkOutTimeDefault={checkOutTimeDefault}
        querySuffix={querySuffix}
      />
    </div>
  );
}
