"use client";

import { Fragment, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { createBookingAction } from "@/app/(main)/bookings/actions";
import { addDays, fmtMoney } from "@/lib/utils";

export type BookingType = "guest" | "team";

export type RoomTypeOption = {
  id: number;
  code: string;
  name: string;
  bed_type: string | null;
  max_occupancy: number | null;
  base_price: number;
  /** 今可订数：统一库存口径算出的今日可售（物理可售与 allotment 取小，见 lib/room-stock.ts） */
  vacant_count: number;
};

export type ChannelOption = {
  id: number;
  name: string | null;
};

export type CompanyOption = {
  id: number;
  name: string | null;
};

export type SalesmanOption = {
  id: number;
  username: string;
  real_name: string | null;
};

export type MemberOption = {
  id: number;
  name: string;
  mobile: string | null;
  id_no: string | null;
  vip_level: number;
};

export type VacantRoom = {
  id: number;
  room_no: string;
  floor: number | null;
  room_type_id: number;
};

type Props = {
  bookingType: BookingType;
  roomTypes: RoomTypeOption[];
  channels: ChannelOption[];
  companies: CompanyOption[];
  salesmen: SalesmanOption[];
  members: MemberOption[];
  rooms: VacantRoom[];
  defaultCheckIn: string;
  defaultCheckOut: string;
};

type TypeRow = {
  /** 首日房价 */
  rate: string;
  /** 早餐数 */
  breakfast: string;
  /** 预订间数 */
  count: number;
  /** 已排房房间 id */
  roomIds: number[];
};

const EMPTY_ROW: TypeRow = { rate: "", breakfast: "0", count: 0, roomIds: [] };

const ARRIVAL_TIMES = ["12:00", "14:00", "18:00", "20:00"];

const RETAIN_TIMES: { value: string; label: string }[] = [
  { value: "", label: "不保留" },
  { value: "18:00", label: "保留至18:00" },
  { value: "20:00", label: "保留至20:00" },
  { value: "24:00", label: "保留至24:00" },
];

const RATE_CODES = ["门市价", "协议价", "会员价", "团队价"];
const PAY_TYPES = ["到店付款", "预付", "挂账"];
const INVOICE_PARTIES = ["酒店", "个人"];

const INPUT = "input h-[30px] rounded-[2px] px-2 text-[12px]";
const SELECT = "input h-[30px] rounded-[2px] px-1.5 text-[12px]";

const TH = "border-b border-[#e0e0e0] bg-[#f6f6f6] px-2 py-2 text-left text-[12px] font-normal text-[#333333]";
const TD = "border-b border-[#eeeeee] px-2 py-[6px] align-middle text-[12px] text-[#555555]";

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function initRows(roomTypes: RoomTypeOption[]): Record<number, TypeRow> {
  const rows: Record<number, TypeRow> = {};
  for (const t of roomTypes) {
    rows[t.id] = { rate: String(t.base_price ?? 0), breakfast: "0", count: 0, roomIds: [] };
  }
  return rows;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-[30px] w-[100px] rounded-[2px] bg-[#5cb85c] text-[14px] font-bold text-white transition-colors hover:bg-[#4cae4c] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "提交中…" : "创建订单"}
    </button>
  );
}

/**
 * 表单行：右对齐标签 + 控件，标签宽度与参考页面一致（60/70px）
 *
 * 整改 P2-26a：外层用包裹式 `<label>`，让标签文字与控件建立「隐式关联」。
 * 原来是 `<span>` + 兄弟控件，读屏软件读不到字段名，点标签也不会聚焦输入框。
 * 这个组件在预订表单里被复用了几十次，改一次全修好。
 */
function Field({
  label,
  required,
  labelWidth = 60,
  children,
}: {
  label: string;
  required?: boolean;
  labelWidth?: number;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 items-start">
      <span
        className="shrink-0 pt-[7px] text-right text-[12px] text-[#555555]"
        style={{ width: labelWidth }}
      >
        {label}
        {required ? <span className="ml-0.5 text-[#ff0000]">*</span> : null}
      </span>
      <div className="min-w-0 flex-1 pl-2">{children}</div>
    </label>
  );
}

/** 入住天数 / 预订间数的小步进器 */
function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  width = 44,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  width?: number;
}) {
  const btn =
    "h-[22px] w-[22px] shrink-0 rounded-[2px] border border-[#dddddd] bg-white text-[13px] leading-none text-[#555555] transition-colors hover:border-[#58bc62] hover:text-[#58bc62] disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={btn}
        aria-label="减少"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-[24px] rounded-[2px] border border-[#dddddd] bg-white text-center text-[12px] outline-none focus:border-[#58bc62]"
        style={{ width }}
      />
      <button
        type="button"
        className={btn}
        aria-label="增加"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

export default function BookingForm({
  bookingType,
  roomTypes,
  channels,
  companies,
  salesmen,
  members,
  rooms,
  defaultCheckIn,
  defaultCheckOut,
}: Props) {
  const isTeam = bookingType === "team";

  const [memberCard, setMemberCard] = useState("");
  const [guestName, setGuestName] = useState("");
  const [mobile, setMobile] = useState("");
  const [teamName, setTeamName] = useState("");

  const [checkIn, setCheckIn] = useState(defaultCheckIn);
  const [checkOut, setCheckOut] = useState(defaultCheckOut);
  const [arrivalTime, setArrivalTime] = useState("12:00");
  const [departureTime, setDepartureTime] = useState("12:00");

  const [companyName, setCompanyName] = useState("");
  const [channelId, setChannelId] = useState<string>(() => {
    const scatter = channels.find((c) => c.name === "散客");
    return scatter ? String(scatter.id) : "";
  });
  const [payType, setPayType] = useState("到店付款");
  const [channelOrderNo, setChannelOrderNo] = useState("");
  const [retainTime, setRetainTime] = useState("");

  const [rateCode, setRateCode] = useState("门市价");
  const [salesman, setSalesman] = useState("");
  const [packageCode, setPackageCode] = useState("");
  const [invoiceParty, setInvoiceParty] = useState("酒店");
  /*
   * 预订定金（整改 P1-7）：表单原来没有这个输入框，服务端也就读不到定金，
   * bookings.deposit 永远为 0，入住时没有押金可转。
   * 这里补一个输入框（name="deposit" 与服务端读取的字段同名），
   * 金额上限由服务端按「房价 × 晚数 × 间数」校验，前端不做截断以免误导。
   */
  const [deposit, setDeposit] = useState("");

  const [remark, setRemark] = useState("");
  const [rows, setRows] = useState<Record<number, TypeRow>>(() => initRows(roomTypes));
  const [expanded, setExpanded] = useState<number | null>(null);
  const [emptyError, setEmptyError] = useState(false);

  /** 会员：按卡号 / 手机号匹配 guests 表，命中后显示 VIP 等级并回填姓名电话 */
  const member = useMemo(() => {
    const key = memberCard.trim();
    if (!key) return null;
    return members.find((m) => m.mobile === key || m.id_no === key) ?? null;
  }, [members, memberCard]);

  const memberTypeLabel = member
    ? member.vip_level > 0
      ? `VIP${member.vip_level}`
      : "普通"
    : "非会员";

  function handleMemberCard(value: string) {
    setMemberCard(value);
    const key = value.trim();
    const hit = key ? members.find((m) => m.mobile === key || m.id_no === key) : undefined;
    if (hit) {
      setGuestName((prev) => prev || hit.name);
      setMobile((prev) => prev || (hit.mobile ?? ""));
    }
  }

  const nights = useMemo(() => {
    if (!checkIn || !checkOut) return 0;
    const ms =
      new Date(`${checkOut}T00:00:00`).getTime() - new Date(`${checkIn}T00:00:00`).getTime();
    return Math.max(0, Math.round(ms / 86400000));
  }, [checkIn, checkOut]);

  function handleCheckIn(value: string) {
    setCheckIn(value);
    if (value && checkOut <= value) setCheckOut(ymd(addDays(value, 1)));
  }

  function handleNights(next: number) {
    if (!checkIn) return;
    const n = Math.min(99, Math.max(1, next));
    setCheckOut(ymd(addDays(checkIn, n)));
  }

  function patchRow(id: number, patch: Partial<TypeRow>) {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_ROW), ...patch } }));
  }

  function setCount(id: number, next: number) {
    const n = Math.min(99, Math.max(0, Number.isFinite(next) ? Math.trunc(next) : 0));
    setRows((prev) => {
      const cur = prev[id] ?? EMPTY_ROW;
      return { ...prev, [id]: { ...cur, count: n, roomIds: cur.roomIds.slice(0, n) } };
    });
  }

  function toggleRoom(typeId: number, roomId: number) {
    setRows((prev) => {
      const cur = prev[typeId] ?? EMPTY_ROW;
      const has = cur.roomIds.includes(roomId);
      const roomIds = has ? cur.roomIds.filter((id) => id !== roomId) : [...cur.roomIds, roomId];
      return { ...prev, [typeId]: { ...cur, roomIds, count: Math.max(cur.count, roomIds.length) } };
    });
  }

  /** 提交行：每个预订间数 > 0 的房型各生成一条预订 */
  const lines = useMemo(
    () =>
      roomTypes.flatMap((t) => {
        const row = rows[t.id];
        if (!row || row.count <= 0) return [];
        return [
          {
            room_type_id: t.id,
            room_count: row.count,
            rate: Number(row.rate) || 0,
            breakfast: Number(row.breakfast) || 0,
            room_id: row.roomIds[0] ?? null,
          },
        ];
      }),
    [roomTypes, rows]
  );

  const linesJson = JSON.stringify(lines);
  const totalRooms = lines.reduce((sum, line) => sum + line.room_count, 0);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (totalRooms === 0) {
      event.preventDefault();
      setEmptyError(true);
    }
  }

  return (
    <form action={createBookingAction} onSubmit={handleSubmit} className="space-y-3">
      <input type="hidden" name="booking_type" value={bookingType} />
      <input type="hidden" name="lines" value={linesJson} />
      <input type="hidden" name="member_card" value={memberCard} />
      <input type="hidden" name="member_type" value={member ? memberTypeLabel : ""} />

      {/* 第 1 行：会员信息 / 会员类型（团队预订额外要求团队名称） */}
      <div className="card px-4 py-3">
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="会员信息">
            <input
              id="member_card"
              className={INPUT}
              placeholder="会员卡号或手机号"
              autoComplete="off"
              value={memberCard}
              onChange={(e) => handleMemberCard(e.target.value)}
            />
          </Field>
          <Field label="会员类型">
            <div className="flex h-[30px] items-center gap-2 rounded-[2px] border border-[#e0e0e0] bg-[#f8f8f8] px-2 text-[12px]">
              <span className={member ? "font-medium text-[#32c141]" : "text-[#999999]"}>
                {memberTypeLabel}
              </span>
              {member ? <span className="truncate text-[11px] text-[#999999]">{member.name}</span> : null}
            </div>
          </Field>
          {isTeam ? (
            <Field label="团队名称" required>
              <input
                id="team_name"
                name="team_name"
                required
                className={INPUT}
                placeholder="请输入团队名称"
                autoComplete="off"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </div>

      {/* 第 2 行：预订人 / 联系电话 / 入住日期时间 / 离店日期时间 / 入住天数 */}
      <div className="card px-4 py-3">
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="预订人" required>
            <input
              id="guest_name"
              name="guest_name"
              required
              className={INPUT}
              placeholder="请输入预订人"
              autoComplete="off"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
            />
          </Field>
          <Field label="联系电话">
            <input
              id="mobile"
              name="mobile"
              inputMode="tel"
              className={INPUT}
              placeholder="请输入联系电话"
              autoComplete="off"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
            />
          </Field>
          <Field label="入住日期" labelWidth={70} required>
            <div className="flex items-center gap-1">
              <input
                id="check_in_date"
                name="check_in_date"
                type="date"
                required
                className={INPUT}
                value={checkIn}
                onChange={(e) => handleCheckIn(e.target.value)}
              />
              <select
                id="arrival_time"
                name="arrival_time"
                className={`${SELECT} w-[68px] shrink-0`}
                value={arrivalTime}
                onChange={(e) => setArrivalTime(e.target.value)}
              >
                {ARRIVAL_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="离店日期" labelWidth={70} required>
            <div className="flex items-center gap-1">
              <input
                id="check_out_date"
                name="check_out_date"
                type="date"
                required
                min={checkIn || undefined}
                className={INPUT}
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
              />
              <select
                id="departure_time"
                name="departure_time"
                className={`${SELECT} w-[68px] shrink-0`}
                value={departureTime}
                onChange={(e) => setDepartureTime(e.target.value)}
              >
                {ARRIVAL_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="入住天数" labelWidth={70} required>
            <Stepper value={nights} min={1} max={99} onChange={handleNights} width={48} />
          </Field>
        </div>

        {/* 第 3 行：协议客户 / 渠道来源 / 收款类型 / 渠道订单号 / 保留时间 */}
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="协议客户">
            <input
              id="company_name"
              name="company_name"
              list="booking-company-options"
              className={INPUT}
              placeholder="请输入协议客户"
              autoComplete="off"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
            <datalist id="booking-company-options">
              {companies.map((c) => (
                <option key={c.id} value={c.name ?? ""} />
              ))}
            </datalist>
          </Field>
          <Field label="渠道来源">
            <select
              id="channel_id"
              name="channel_id"
              className={SELECT}
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            >
              <option value="">未指定</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? `渠道 #${c.id}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="收款类型" labelWidth={70}>
            <select
              id="pay_type"
              name="pay_type"
              className={SELECT}
              value={payType}
              onChange={(e) => setPayType(e.target.value)}
            >
              {PAY_TYPES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="渠道订单号" labelWidth={70}>
            <input
              id="channel_order_no"
              name="channel_order_no"
              className={INPUT}
              placeholder="请输入渠道订单号"
              autoComplete="off"
              value={channelOrderNo}
              onChange={(e) => setChannelOrderNo(e.target.value)}
            />
          </Field>
          <Field label="保留时间" labelWidth={70}>
            <select
              id="retain_time"
              name="retain_time"
              className={SELECT}
              value={retainTime}
              onChange={(e) => setRetainTime(e.target.value)}
            >
              {RETAIN_TIMES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* 第 4 行：房价代码 / 销售员 / 包价 / 开票方 */}
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="房价代码">
            <select
              id="rate_code"
              name="rate_code"
              className={SELECT}
              value={rateCode}
              onChange={(e) => setRateCode(e.target.value)}
            >
              {RATE_CODES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="销售员">
            <select
              id="salesman"
              name="salesman"
              className={SELECT}
              value={salesman}
              onChange={(e) => setSalesman(e.target.value)}
            >
              <option value="">请选择销售员</option>
              {salesmen.map((s) => (
                <option key={s.id} value={s.real_name ?? s.username}>
                  {s.real_name ?? s.username}
                </option>
              ))}
            </select>
          </Field>
          <Field label="包价" labelWidth={70}>
            <input
              id="package_code"
              name="package_code"
              className={INPUT}
              placeholder="请选择包价"
              autoComplete="off"
              value={packageCode}
              onChange={(e) => setPackageCode(e.target.value)}
            />
          </Field>
          <Field label="开票方" labelWidth={70}>
            <select
              id="invoice_party"
              name="invoice_party"
              className={SELECT}
              value={invoiceParty}
              onChange={(e) => setInvoiceParty(e.target.value)}
            >
              {INVOICE_PARTIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          {/* 预订定金（整改 P1-7）：写进 bookings.deposit，入住时作为押金转入 */}
          <Field label="定金" labelWidth={70}>
            <input
              id="deposit"
              name="deposit"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className={INPUT}
              placeholder="预订时实收定金"
              autoComplete="off"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* 房型表格 */}
      <div className="card overflow-x-auto">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] table-fixed border-collapse">
            <colgroup>
              <col style={{ width: "17%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className={TH}>房型</th>
                <th className={TH}>门市价</th>
                <th className={TH}>首日房价</th>
                <th className={TH}>早餐数</th>
                <th className={TH}>今可订</th>
                <th className={TH}>可超数</th>
                <th className={TH}>预订间数</th>
                <th className={TH}>未分配间数</th>
                <th className={TH}>操作</th>
              </tr>
            </thead>
            <tbody>
              {roomTypes.length === 0 ? (
                <tr>
                  <td colSpan={9} className={`${TD} py-10 text-center text-[#999999]`}>
                    暂无可售房型，请先在房型设置中维护房型
                  </td>
                </tr>
              ) : null}
              {roomTypes.map((t) => {
                const row = rows[t.id] ?? EMPTY_ROW;
                const typeRooms = rooms.filter((r) => r.room_type_id === t.id);
                const selectedRooms = typeRooms.filter((r) => row.roomIds.includes(r.id));
                const unassigned = Math.max(0, row.count - selectedRooms.length);
                const overCount = Math.max(0, row.count - t.vacant_count);
                const open = expanded === t.id;
                return (
                  <Fragment key={t.id}>
                    <tr className="hover:bg-[#fafafa]">
                      <td className={TD}>
                        <span className="font-semibold text-[#333333]">{t.name}</span>
                      </td>
                      <td className={`${TD} tabular-nums`}>{fmtMoney(t.base_price)}</td>
                      <td className={TD}>
                        <div className="flex items-center gap-1">
                          <span className="text-[12px] text-[#999999]">¥</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            className="h-[24px] w-full rounded-[2px] border border-[#dddddd] bg-white px-1.5 text-[12px] tabular-nums outline-none focus:border-[#58bc62]"
                            value={row.rate}
                            onChange={(e) => patchRow(t.id, { rate: e.target.value })}
                          />
                        </div>
                      </td>
                      <td className={TD}>
                        <input
                          type="number"
                          min={0}
                          max={9}
                          className="h-[24px] w-[60px] rounded-[2px] border border-[#dddddd] bg-white px-1.5 text-center text-[12px] tabular-nums outline-none focus:border-[#58bc62]"
                          value={row.breakfast}
                          onChange={(e) => patchRow(t.id, { breakfast: e.target.value })}
                        />
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        <span className={t.vacant_count > 0 ? "text-[#32c141]" : "text-[#999999]"}>
                          {t.vacant_count}
                        </span>
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        <span className={overCount > 0 ? "text-[#c99a2e]" : "text-[#999999]"}>
                          {overCount}
                        </span>
                      </td>
                      <td className={TD}>
                        <div className="flex justify-center">
                          <Stepper value={row.count} onChange={(n) => setCount(t.id, n)} />
                        </div>
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        <span className={unassigned > 0 ? "text-[#c99a2e]" : "text-[#999999]"}>
                          {unassigned}
                        </span>
                      </td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : t.id)}
                            className="rounded-[2px] border border-[#58bc62] px-2 py-[2px] text-[12px] text-[#32c141] transition-colors hover:bg-[#ddeee0]"
                          >
                            排房
                          </button>
                          {selectedRooms.map((r) => (
                            <span
                              key={r.id}
                              className="rounded-[2px] border border-[#58bc62] bg-[#ddeee0] px-1.5 py-[1px] text-[11px] text-[#32c141]"
                            >
                              {r.room_no}
                            </span>
                          ))}
                          {selectedRooms.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => patchRow(t.id, { roomIds: [] })}
                              className="text-[11px] text-[#999999] underline hover:text-[#58bc62]"
                            >
                              清空
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {open ? (
                      <tr>
                        <td colSpan={9} className="border-b border-[#eeeeee] bg-[#fafafa] px-3 py-2">
                          <div className="mb-1.5 text-[11px] text-[#999999]">
                            选择 {t.name} 的房间（空净房，可多选）· 已选 {selectedRooms.length} 间
                          </div>
                          {typeRooms.length === 0 ? (
                            <div className="text-[12px] text-[#999999]">该房型暂无可售空净房，可先待排房</div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {typeRooms.map((r) => {
                                const on = row.roomIds.includes(r.id);
                                return (
                                  <button
                                    key={r.id}
                                    type="button"
                                    onClick={() => toggleRoom(t.id, r.id)}
                                    className={`rounded-[2px] border px-2 py-[2px] text-[12px] transition-colors ${
                                      on
                                        ? "border-[#58bc62] bg-[#ddeee0] text-[#32c141]"
                                        : "border-[#dddddd] bg-white text-[#555555] hover:border-[#58bc62] hover:text-[#32c141]"
                                    }`}
                                  >
                                    {r.room_no}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 订单备注 + 创建订单 */}
      <div className="card px-4 py-3">
        <label className="label text-[12px] text-[#333333]" htmlFor="remark">
          订单备注
        </label>
        <textarea
          id="remark"
          name="remark"
          rows={3}
          className="input resize-none rounded-[2px] text-[12px]"
          placeholder="特殊要求、担保方式等"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
        {emptyError && totalRooms === 0 ? (
          <div className="mt-2 text-center text-[12px] text-[#ff0000]">
            请至少填写一个房型的预订间数
          </div>
        ) : null}
        <div className="mt-3 flex justify-center">
          <SubmitButton />
        </div>
      </div>
    </form>
  );
}
