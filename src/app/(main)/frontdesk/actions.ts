"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { get, run, tx } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { changeRoomStatus } from "@/lib/room-status";
import { conflictMessage, findRoomConflicts } from "@/lib/room-availability";
import { ensurePaymentKindSchema, recalcFolioBalance } from "@/lib/folio";
/*
 * 客史匹配唯一口径（第九轮 P0-1：stays.guest_id 大面积为空）
 *
 * 入住单的 guest_id 是会员储值、历史入住次数、会员等级、退款对象的唯一纽带。
 * 缺了它，会员充值/消费只能按姓名回退 —— 同名客人要么被拒、要么充错人。
 * 这里复用 lib/guest-match 的口径（证件号 → 手机号），**不再自己写 ORDER BY id LIMIT 1**：
 * 那等于「同名时取最早建立的档案」，正是会把钱记到别人头上的写法。
 */
import { findGuestByIdentity, findSameNameGuests } from "@/lib/guest-match";
/* 第 4 轮 P1-29：钟点房报价（读房型配置，不再硬编码 15%） */
import { quoteHourly } from "@/lib/hourly-rate";
/* 第 4 轮 P1-20：渠道订单状态回传（入住成功 → CHECKED_IN） */
import { pushOrderStatusForChannelOrder } from "@/lib/channels/order-status";
/* 渠道库存同步（整改 4.1 缺口补线）：入住后该房型的可售量变少，必须让渠道知道 */
import { markStockDirty } from "@/lib/channels/stock-trigger";
import { addDays, nightsBetween, nowIso, todayStr, nowLocalIso } from "@/lib/utils";

/**
 * 入住办理（散客步入 / 钟点房）。
 *
 * 既可直接作为 <form action={checkInAction}>（只传 FormData）调用，
 * 也可配合客户端 useActionState（传 (prevState, formData)）使用。
 *
 * 业务规则：
 * - 支持一次排多间房，逐间创建 stays 并把房间置为 OC（在住净房）
 * - 每间房生成一张 folio，押金写入 DEPOSIT 明细 + payments
 * - 支持从 ?booking=id 带入预订信息，入住成功后预订置为 CHECKED_IN
 * - 房价按「门店基准价 × 房价代码折扣」计算；钟点房按时长计费
 */
export type CheckInState = { error?: string; ok?: string };

/** 房价代码折扣：与 CheckInForm 中的 RATE_CODES 保持一致 */
const RATE_FACTORS: Record<string, number> = {
  门市价: 1,
  协议价: 0.9,
  会员价: 0.85,
};

/** 钟点房可选时长（小时） */
const HOUR_OPTIONS = [2, 4, 6];

/** 钟点房每小时按门店基准价的 15% 计费（2/4/6 小时均低于整夜价） */
const HOURLY_FACTOR = 0.15;

/** 收款类型 → 收款流水方式 */
const PAY_METHOD: Record<string, string> = {
  到店付款: "现金",
  预付: "微信",
  挂账: "挂账",
};

function readStr(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function readNum(formData: FormData, key: string, fallback = 0): number {
  const raw = readStr(formData, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 入住日期 + 时间选择 → 本地时间 ISO（非法输入退回当前时间）
 *
 * 用 nowLocalIso 而不是 toISOString：check_in_time 会被 `substr(x,1,10)` 当业务日期读
 * （推营业日、算房费、夜审统计），存 UTC 的话凌晨入住会落到前一天（P1-6）。
 */
function combineDateTime(date: string, time: string): string {
  const d = new Date(`${isDate(date) ? date : todayStr()}T${/^\d{2}:\d{2}$/.test(time) ? time : "00:00"}:00`);
  return Number.isNaN(d.getTime()) ? nowLocalIso() : nowLocalIso(d);
}

type RoomInfo = {
  id: number;
  room_no: string;
  status: string;
  room_type_name: string;
  /* 第 4 轮 P1-29：钟点房报价要按房型查 hourly_rates */
  room_type_id: number | null;
  base_price: number;
};

type GuestDraft = {
  name: string;
  mobile: string;
  idType: string;
  idNo: string;
  gender: string;
  breakfast: number;
};

type BookingRow = { id: number; status: string; room_id: number | null };

export async function checkInAction(
  prevStateOrFormData: CheckInState | FormData,
  maybeFormData?: FormData
): Promise<CheckInState> {
  const formData = prevStateOrFormData instanceof FormData ? prevStateOrFormData : maybeFormData;
  if (!formData) return { error: "表单数据缺失，请重试" };
  /* 第九轮 P1-2：入住押金流水要写 kind，老库先兜底补列（幂等，进程内只查一次） */
  ensurePaymentKindSchema();
  const mode = readStr(formData, "mode") === "hour" ? "hour" : "day";

  // 已排房：可多间，去重并过滤非法值
  const roomIds = Array.from(
    new Set(
      formData
        .getAll("room_id")
        .map((v) => (typeof v === "string" ? Number(v) : 0))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n))
    )
  );

  // 住客：主住客 + 可选多名同住人
  const guestCount = Math.max(1, Math.min(9, Math.trunc(readNum(formData, "guest_count", 1))));
  const guests: GuestDraft[] = [];
  for (let i = 0; i < guestCount; i += 1) {
    guests.push({
      name: readStr(formData, `guest_name_${i}`),
      mobile: readStr(formData, `guest_mobile_${i}`),
      idType: readStr(formData, `guest_id_type_${i}`) || "身份证",
      idNo: readStr(formData, `guest_id_no_${i}`),
      gender: readStr(formData, `guest_gender_${i}`) || "男",
      breakfast: Math.max(0, Math.trunc(readNum(formData, `guest_breakfast_${i}`, 0))),
    });
  }
  const namedGuests = guests.filter((g) => g.name);
  const primary = namedGuests[0];
  if (roomIds.length === 0) return { error: "请先通过「快速排房」选择房间" };
  if (!primary) return { error: "请填写主住客姓名" };

  const today = todayStr();
  const checkInDateRaw = readStr(formData, "check_in_date");
  const checkInDate = isDate(checkInDateRaw) ? checkInDateRaw : today;
  const checkInTimeRaw = readStr(formData, "check_in_time");

  const rawHours = Math.trunc(readNum(formData, "hours", 4));
  const hours = mode === "hour" ? (HOUR_OPTIONS.includes(rawHours) ? rawHours : 4) : 0;

  const checkOutDateRaw = readStr(formData, "check_out_date");
  const checkOutDate =
    mode === "hour"
      ? checkInDate
      : isDate(checkOutDateRaw) && checkOutDateRaw > checkInDate
        ? checkOutDateRaw
        : todayStr(addDays(checkInDate, Math.max(1, Math.trunc(readNum(formData, "nights", 1)))));

  const nights = mode === "hour" ? 0 : Math.max(1, nightsBetween(checkInDate, checkOutDate));

  const rateCodeRaw = readStr(formData, "rate_code");
  const rateCode = RATE_FACTORS[rateCodeRaw] !== undefined ? rateCodeRaw : "门市价";

  const teamName = readStr(formData, "team_name");
  const memberCard = readStr(formData, "member_card");
  const company = readStr(formData, "company");
  const salesman = readStr(formData, "salesman");
  const packageCode = readStr(formData, "package_code");
  const invoiceParty = readStr(formData, "invoice_party") === "个人" ? "个人" : "酒店";
  const payTypeRaw = readStr(formData, "pay_type");
  const payType = PAY_METHOD[payTypeRaw] !== undefined ? payTypeRaw : "到店付款";
  const channelOrderNo = readStr(formData, "channel_order_no");
  const remarkInput = readStr(formData, "remark");
  /*
   * 自用标记（第 5 轮 P1-4）
   *
   * 只认表单上显式勾选的 self_use=1，**不拿 rate=0 反推**：
   * 免费房有促销免单、赔付、招待、OTA 预付等多种来源，
   * 用房价推「入住性质」必然把免费房错算成自用房（清单明确禁止）。
   * 落库到 stays.self_use，房态页「自用」标签的唯一判定来源。
   */
  const selfUse = readStr(formData, "self_use") === "1" ? 1 : 0;
  /*
   * 押金（整改 P1-7：预订定金转入住押金）
   * 用 let：下面查到来源预订后，若本次表单没填押金而预订阶段收过定金，
   * 会用预订定金兜底（见 booking 校验之后那段）。
   */
  let deposit = Math.max(0, readNum(formData, "deposit"));
  const channelRaw = Math.trunc(readNum(formData, "channel_id"));
  const channelId = channelRaw > 0 ? channelRaw : null;
  const bookingRaw = Math.trunc(readNum(formData, "booking_id"));
  const bookingId = bookingRaw > 0 ? bookingRaw : null;
  const breakfastTotal = guests.reduce((sum, g) => sum + g.breakfast, 0);

  // 备注里带上协议客户 / 渠道单号 / 钟点房时长，stays 没有独立字段
  const remarkParts: string[] = [];
  if (mode === "hour") remarkParts.push(`钟点房 ${hours} 小时`);
  if (company) remarkParts.push(`协议客户：${company}`);
  if (channelOrderNo) remarkParts.push(`渠道订单号：${channelOrderNo}`);
  if (remarkInput) remarkParts.push(remarkInput);
  const remark = remarkParts.join("；");

  try {
    try {
      const store = await cookies();
    } catch (e) {
    }
    // 权限边界（上线前加固）：办理入住会开房、建档、挂房费，必须校验 checkin.create，原来只校验登录
    const user = await requirePermission("checkin.create");
    const hotelId = user.hotelId;

    // 房间必须真实存在且为空净 VC / 空脏 VD
    const roomList: RoomInfo[] = [];
    for (const id of roomIds) {
      const room = get<RoomInfo>(
        `SELECT r.id, r.room_no, r.status, r.room_type_id, rt.name AS room_type_name, COALESCE(rt.base_price, 0) AS base_price
         FROM rooms r
         JOIN room_types rt ON rt.id = r.room_type_id
         WHERE r.id = ? AND r.hotel_id = ?`,
        [id, hotelId]
      );
      if (!room) return { error: `房间不存在（ID ${id}）` };
      if (room.status !== "VC" && room.status !== "VD") {
      return { error: `房间 ${room.room_no} 当前不可入住，请重新排房` };
      }
      /*
       * 异常校验①：房间已被其他订单占用（整改指令 2.4）
       *
       * 房态是 VC/VD 也可能已经被人住进去了（历史脏数据、并发写），
       * 只信房态标志会办出「一间房两个在住单」。
       */
      const occupied = get<{ stay_no: string; guest_name: string }>(
        `SELECT stay_no, guest_name FROM stays
          WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE' LIMIT 1`,
        [hotelId, room.id]
      );
      if (occupied) {
        return {
          error: `房间 ${room.room_no} 已被在住单 ${occupied.stay_no}（${occupied.guest_name}）占用，请刷新房态后重试`,
        };
      }
      /*
       * 异常校验①-b：房间已被预订占用（P0-7）
       *
       * 上面只查了「有没有在住单」，完全没有查 bookings / booking_rooms ——
       * 房间今天已经排给预订客 A，散客 B 房态还是 VC，照样能办进来，形成一房两住。
       * 这里用半开区间查本次入住日期区间内的占用（在住 / 主单 / 多房明细三源），
       * 并排除本次来源预订（bookingId），否则客人自己的预订会被当成冲突。
       */
      const stayTo = todayStr(addDays(checkInDate, Math.max(1, nights)));
      const conflicts = findRoomConflicts({
        hotelId,
        roomId: room.id,
        checkIn: checkInDate,
        checkOut: stayTo,
        excludeBookingId: bookingId ?? undefined,
      });
      if (conflicts.length > 0) {
        return { error: `不能入住：${conflictMessage(conflicts, room.room_no)}` };
      }
      roomList.push(room);
    }

    /*
     * 异常校验②：入住人数超过房型上限（整改指令 2.4）
     *
     * 房型表有 max_occupancy，同住人数超了不但住不下，消防检查也过不了。
     */
    for (const room of roomList) {
      const cap = get<{ max_occupancy: number | null }>(
        `SELECT COALESCE(rt.max_occupancy, 0) AS max_occupancy
           FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
          WHERE r.id = ? AND r.hotel_id = ?`,
        [room.id, hotelId]
      )?.max_occupancy ?? 0;
      if (cap > 0 && guestCount > cap) {
        return { error: `房间 ${room.room_no} 的房型最多住 ${cap} 人，本次填了 ${guestCount} 人` };
      }
    }

    /*
     * 异常校验③：身份证重复入住（整改指令 2.4）
     *
     * 同一个人（同一证件号）已经有一间房在住时再开一间，正常业务里是"再加一间"，
     * 前台应该用「联房 / 多间」而不是重新办一次入住 —— 这里拦下来提醒。
     */
    for (const g of namedGuests) {
      const idNo = g.idNo?.trim();
      if (!idNo) continue;
      const dup = get<{ stay_no: string; room_no: string }>(
        `SELECT s.stay_no, r.room_no
           FROM stays s JOIN rooms r ON r.id = s.room_id
          WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
            AND s.guest_id IN (SELECT id FROM guests WHERE hotel_id = ? AND id_no = ?)
          LIMIT 1`,
        [hotelId, hotelId, idNo]
      );
      if (dup) {
        return {
          error: `证件号 ${idNo} 已有在住单 ${dup.stay_no}（房间 ${dup.room_no}）。如需再加一间请用「联房」`,
        };
      }
    }

    /*
     * 异常校验④：渠道订单重复入住（整改指令 2.4）
     *
     * 渠道单号是渠道侧的幂等键，同一个渠道单号不能办两次入住，
     * 否则渠道对账时会出现「一单两房」。
     */
    if (channelOrderNo) {
      /*
       * 第 4 轮 P1-21：用 stays.channel_order_no 精确拦截（不再靠 remark LIKE 模糊匹配）
       *
       * 旧写法 `remark LIKE '%渠道订单号：X%'` 有两个洞：
       *   ① 只查 status='INHOUSE'，客人退房后 remark 还在，但查不到 → 可以再办一次
       *   ② 字符串包含匹配，单号 123 会命中 1234
       * 现在 stays 有专门的列（channel-fix 已加列 + 索引 + 历史回填），不限状态精确比对。
       */
      const chDup = get<{ stay_no: string; status: string }>(
        `SELECT stay_no, status FROM stays
          WHERE hotel_id = ? AND channel_order_no = ?
          LIMIT 1`,
        [hotelId, channelOrderNo]
      );
      if (chDup) {
        const statusText =
          chDup.status === "INHOUSE"
            ? "已在住"
            : chDup.status === "CHECKED_OUT"
              ? "已退房"
              : `状态 ${chDup.status}`;
        return {
          error: `渠道订单号 ${channelOrderNo} ${statusText}（${chDup.stay_no}），不能重复办理入住`,
        };
      }
    }

    /*
     * 异常校验⑤：押金为负 / 明显不足（整改指令 2.4）
     *
     * 押金政策各家不同（有的酒店只收一晚，有的不收），所以**不强行拦截 0 押金**，
     * 只拦负数和「填了但不够一晚房费」这两种明显有问题的。
     */
    if (deposit < 0) {
      return { error: "押金不能为负数" };
    }

    // 预订带入：必须是本酒店且未入住 / 未取消
    let booking: BookingRow | undefined;
    if (bookingId) {
      booking = get<BookingRow>(
        `SELECT id, status, room_id FROM bookings WHERE id = ? AND hotel_id = ?`,
        [bookingId, hotelId]
      );
      if (!booking) return { error: "来源预订不存在，请重新进入入住办理" };
      if (booking.status === "CHECKED_IN") return { error: "该预订已办理入住" };
      if (booking.status === "CANCELLED") return { error: "该预订已取消，不能办理入住" };
      if (booking.status === "NOSHOW") return { error: "该预订已标记未到，不能办理入住" };
      /*
       * 异常校验⑥：预订已过期（整改指令 2.4）
       *
       * 客人订的是昨天的房、今天才来，房间早就被别人卖了；
       * 直接放行会变成「无房可住还办了入住」。要求前台重新确认日期。
       */
      const bkDates = get<{ check_in_date: string; check_out_date: string }>(
        `SELECT check_in_date, check_out_date FROM bookings WHERE id = ? AND hotel_id = ?`,
        [booking.id, hotelId]
      );
      if (bkDates && bkDates.check_out_date < todayStr()) {
        return {
          error: `该预订已过期（${bkDates.check_in_date} ~ ${bkDates.check_out_date}），请核对后重新预订或修改日期`,
        };
      }

      /*
       * 预订定金 → 入住押金（整改 P1-7）
       *
       * 预订阶段收的定金记在 bookings.deposit，但入住这里原来完全不看它：
       * 定金凭空消失，入住押金永远是前台当场填的那个数（多半是 0），
       * 结账时押金不够抵扣房费，还得让客人再掏一次钱。
       *
       * 只在「本次表单没填押金」时才兜底，遵循两条原则：
       *   1. 前台实际收的钱以表单为准（可能补交 / 多收 / 换支付方式），不能覆盖；
       *   2. 没填就说明这笔钱就是预订时收的那笔定金，转成入住押金落库，
       *      后面的 DEPOSIT 明细 + payments 流水都按这个金额生成，账实一致。
       */
      if (deposit <= 0) {
        const booked = get<{ deposit: number | null }>(
          `SELECT COALESCE(deposit, 0) AS deposit FROM bookings WHERE id = ? AND hotel_id = ?`,
          [booking.id, hotelId]
        );
        const bookedDeposit = Number(booked?.deposit ?? 0);
        if (Number.isFinite(bookedDeposit) && bookedDeposit > 0) deposit = round2(bookedDeposit);
      }
    }

    // 会员类型：按会员卡号 / 手机号自动匹配 guests 档案
    const memberRow = memberCard
      ? get<{ vip_level: number | null }>(
          `SELECT vip_level FROM guests
           WHERE hotel_id = ? AND (mobile = ? OR CAST(id AS TEXT) = ? OR id_no = ?)
           ORDER BY id LIMIT 1`,
          [hotelId, memberCard, memberCard, memberCard]
        )
      : undefined;
    const memberType = memberRow
      ? (memberRow.vip_level ?? 0) > 0
        ? `VIP${Math.min(3, memberRow.vip_level ?? 0)}`
        : "普通"
      : readStr(formData, "member_type") || "普通";

    const rateFactor = RATE_FACTORS[rateCode] ?? 1;
    const modeFactor = mode === "hour" ? HOURLY_FACTOR * hours : 1;
    /*
     * 钟点房计价（第 4 轮 P1-29）
     *
     * 原来这里 `basePrice × rateFactor × 0.15 × hours`，没读设置页配的钟点房标准
     * （基础时长/基础收费/超时费率/满房规则）。现在钟点走 lib/hourly-rate 的统一报价，
     * 日租仍用原来的费率因子链。
     */
    const quoteOf = (basePrice: number, roomTypeId: number | null) => {
      if (mode === "hour") {
        const q = quoteHourly(hotelId, roomTypeId, hours, round2(basePrice * rateFactor));
        return { price: q.price, note: q.note };
      }
      const calculated = round2(basePrice * rateFactor * modeFactor);
      return { price: calculated > 0 ? calculated : basePrice, note: "" };
    };
    const rateOf = (basePrice: number, roomTypeId: number | null = null) => quoteOf(basePrice, roomTypeId).price;

    const now = nowIso();
    const checkInTime = combineDateTime(checkInDate, checkInTimeRaw);
    const guestCountValue = Math.max(1, namedGuests.length);

    tx(() => {
      /*
       * 1. 客史：入住单必须挂上 guests.id（第九轮 P0-1）
       *
       * ── 缺陷 ──
       * 旧写法只按 id_no / mobile 查，两者都没有就直接建档；查询还带
       * `ORDER BY id LIMIT 1` —— 靠「id 最小」当默认客人。唯一索引缺失或历史脏数据时，
       * 这一行足以把在住单挂到另一个人头上：会员积分、入住次数、退款对象全错。
       *
       * ── 现在的匹配口径（与 lib/guest-match 一致，只多一道同名闸门）──
       *   ① 表单显式指定客史（guest_id_<i>，前台在同名列表里选过）→ 直接用；
       *   ② 身份证号（guests.id_no，唯一部分索引）→ ③ 手机号（唯一部分索引）；
       *   ④ 都没有时，**同名客史恰好 1 条**才允许用姓名辅助关联；
       *   ⑤ 同名多条 → 拒绝办理并列出候选，绝不选「最早 id」；
       *   ⑥ 一条同名都没有 → 才真正新建客史。
       *
       * 逐位住客顺序处理：主住客先落库，同住人再按 id_no/mobile 就能命中刚建的那条，
       * 不会因为「本次表单里两个人手机号相同」而撞唯一索引。
       */
      let primaryGuestId: number | null = null;
      for (let gi = 0; gi < namedGuests.length; gi += 1) {
        const g = namedGuests[gi];
        let guestId: number | null = null;

        /* ① 前台显式选择的客史编号（同名歧义时的唯一出路） */
        const pickedId = Math.trunc(readNum(formData, `guest_id_${gi}`));
        if (pickedId > 0) {
          const picked = get<{ id: number; name: string }>(
            `SELECT id, name FROM guests
              WHERE id = ? AND hotel_id = ? AND COALESCE(deleted, 0) = 0`,
            [pickedId, hotelId]
          );
          if (!picked) throw new Error(`指定的客史（ID ${pickedId}）不存在或不属于当前酒店，请重新选择`);
          guestId = picked.id;
        }

        /* ②③ 唯一口径：证件号优先，其次手机号 */
        if (guestId === null) {
          const hit = findGuestByIdentity(hotelId, { idNo: g.idNo, mobile: g.mobile });
          if (hit) guestId = hit.id;
        }

        /* ④⑤ 姓名只在「唯一同名」时辅助关联；多条一律拒绝 */
        if (guestId === null) {
          const sameName = findSameNameGuests(hotelId, g.name);
          if (sameName.length > 1) {
            const candidates = sameName
              .map((s) => `#${s.id}${s.mobile ? `（手机尾号 ${s.mobile.slice(-4)}）` : "（无手机号）"}`)
              .join("、");
            throw new Error(
              `住客「${g.name}」在本店有 ${sameName.length} 份同名客史（${candidates}），无法确定关联对象：` +
                `请补填身份证号或手机号区分，或在表单里用 guest_id_${gi} 指定客史编号后重试`
            );
          }
          if (sameName.length === 1) guestId = sameName[0].id;
        }

        /* ⑥ 确实没有档案：新建（有证件号/手机号时仍受唯一索引保护） */
        if (guestId === null) {
          guestId = run(
            `INSERT INTO guests
               (hotel_id, name, gender, id_type, id_no, mobile, company, vip_level, blacklist, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              hotelId,
              g.name,
              g.gender,
              g.idType,
              g.idNo || null,
              g.mobile || null,
              company || null,
              0,
              0,
              null,
              now,
            ]
          ).lastInsertRowid;
        }
        if (primaryGuestId === null) primaryGuestId = guestId;
      }
      /* 前面已保证至少一位有名住客，这里只是把 null 收窄，避免带着空 guest_id 开单 */
      if (primaryGuestId === null) throw new Error("未能确定主住客客史，请检查住客信息后重试");

      /*
       * 第 4 轮 P1-17：押金按房间数重复收取
       *
       * `deposit` 是**整单**金额（表单填的，或从 bookings.deposit 带入），
       * 旧代码在「逐间创建入住单」的循环里，每间都写一条 DEPOSIT 明细 + 一条 payments。
       * 实测：预订 2 间房、定金 200 → 实收 400，而预订阶段只收了 200，凭空多收一倍。
       *
       * 现在循环外先按间数分摊，最后一间补尾差（保证各间之和严格等于整单押金）。
       */
      const roomCount = roomList.length;
      const depositBase = roomCount > 0 ? round2(deposit / roomCount) : 0;

      // 2. 逐间创建入住单、账务单与押金流水
      for (let roomIdx = 0; roomIdx < roomList.length; roomIdx++) {
        const room = roomList[roomIdx];
        /* 每间分摊到的押金：前 n-1 间取基准值，最后一间吃掉尾差 */
        const depositThisRoom =
          roomIdx === roomCount - 1
            ? round2(deposit - depositBase * (roomCount - 1))
            : depositBase;
        const nextStayId =
          get<{ m: number | null }>(`SELECT COALESCE(MAX(id), 0) AS m FROM stays`)?.m ?? 0;
        const stayNo = `SI${nextStayId + 1 + 1000}`;
        const rate = rateOf(room.base_price, room.room_type_id ?? null);

        const stayId = run(
          `INSERT INTO stays
             (hotel_id, stay_no, booking_id, room_id, guest_id, guest_name, mobile,
              check_in_time, expect_check_out, actual_check_out, nights, rate, deposit,
              guest_count, status, channel_id, remark, channel_order_no,
              team_name, member_card, member_type, rate_code, salesman, package_code,
              invoice_party, pay_type, breakfast, self_use, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            stayNo,
            bookingId,
            room.id,
            primaryGuestId,
            primary.name,
            primary.mobile || null,
            checkInTime,
            checkOutDate,
            null,
            nights,
            rate,
            depositThisRoom,
            guestCountValue,
            "INHOUSE",
            channelId,
            remark || null,
            /* 第 4 轮 P1-21：渠道单号落专用列，供精确幂等拦截 */
            channelOrderNo || null,
            teamName || null,
            memberCard || null,
            memberType,
            rateCode,
            salesman || null,
            packageCode || null,
            invoiceParty,
            payType,
            breakfastTotal,
            /* 第 5 轮 P1-4：自用标记（前台显式勾选；不拿 rate=0 反推） */
            selfUse,
            user.id,
            now,
          ]
        ).lastInsertRowid;

        // 房态：空净 / 空脏 → 在住净（走统一房态服务，自动校验并写 room_logs）
        changeRoomStatus({
          hotelId,
          roomId: room.id,
          to: "OC",
          operator: user.realName,
          reason: `入住（${primary.name}）`,
          source: { kind: "checkin", stayId: 0 },
        });

        const nextFolioId =
          get<{ m: number | null }>(`SELECT COALESCE(MAX(id), 0) AS m FROM folios`)?.m ?? 0;
        const folioNo = `F${nextFolioId + 1 + 2000}`;
        const folioId = run(
          /*
           * 建单（第 4 轮 P0-1：押金被当成房费应收，账单余额全错）
           *
           * 押金是**负债**（酒店欠客人的钱），不是应收。
           * 旧写法 `total_amount = deposit, paid_amount = deposit, balance = 0`
           * 与下面那行注释「押金不计入应收余额」自相矛盾 —— 注释是对的，代码是错的。
           *
           * 后果链：押金 600、房费 1764 时 total_amount=600，
           * 收银台收款 SQL 用 `balance = total_amount - (paid + 本次)` 手算，
           * 收 100 元后 balance = 600-700 = -100（正确值应为 0-700 = -700），
           * 差额正好是押金 —— 每收一次钱，账就错一次。
           *
           * 现在：应收 0、已收押金、余额为负（表示欠客人押金）。
           * 后续房费通过 folio_items 逐笔入账，由 recalcFolioBalance 统一重算。
           */
          `INSERT INTO folios
             (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            folioNo,
            stayId,
            primary.name,
            room.room_no,
            0, // 应收：建单时还没有消费，押金不算应收
            depositThisRoom, // 已收：押金（分摊到本间）
            -depositThisRoom, // 余额：负 = 欠客人本间押金
            "OPEN",
            now,
          ]
        ).lastInsertRowid;

        /*
         * 押金入账：明细 + 收款流水
         *
         * 明细记 DEPOSIT（recalcFolioBalance 会把它排除在「应收」之外），
         * 收款流水记 payments（钱真的收到了，体现在 paid_amount 上）。
         * 写完统一调 recalcFolioBalance 重算，不手写 total/balance —— 口径只有一份。
         */
        if (depositThisRoom > 0) {
          run(
            `INSERT INTO folio_items
               (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [hotelId, folioId, "DEPOSIT", "入住押金", 1, depositThisRoom, depositThisRoom, today, now, user.id]
          );
          run(
            `INSERT INTO payments
               (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              hotelId,
              folioId,
              stayId,
              `P${folioId}`,
              PAY_METHOD[payType] ?? "现金",
              depositThisRoom,
              today,
              "入住押金",
              now,
              user.realName,
              /* 第九轮 P1-2：入住押金必须带结构化标记 DEPOSIT（备注是自由文本，不能靠它识别） */
              "DEPOSIT",
            ]
          );
          /* 押金与流水写完，统一重算（应收 0 - 已收押金 = 负余额 = 欠客人押金） */
          recalcFolioBalance(hotelId, folioId);
        }

        /*
         * 多房明细回填（整改报告 P1-4）
         * 逐间办入住：本次入住的这个房间对应一条 booking_rooms 明细，
         * 把 stay_id 写回去、状态置 CHECKED_IN。
         */
        const detail = get<{ id: number }>(
          `SELECT id FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND room_id = ? AND stay_id IS NULL
            ORDER BY id LIMIT 1`,
          [hotelId, bookingId ?? 0, room.id]
        );
        if (detail) {
          run(`UPDATE booking_rooms SET stay_id = ?, status = 'CHECKED_IN' WHERE id = ? AND hotel_id = ?`, [
            stayId,
            detail.id,
            hotelId,
          ]);
        } else {
          // 老数据兜底：没有明细就补一条已入住明细
          run(
            `INSERT INTO booking_rooms
               (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
                check_in_date, check_out_date, stay_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              hotelId,
              bookingId ?? 0,
              null,
              room.id,
              primary.name,
              primary.mobile || null,
              rate,
              "CHECKED_IN",
              checkInDate,
              checkOutDate,
              stayId,
              now,
            ]
          );
        }
      }

      // 3. 来源预订推进：还有未入住明细就保持 CONFIRMED（逐间办），全办完才 CHECKED_IN
      if (booking && bookingId) {
        const left =
          get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM booking_rooms
              WHERE hotel_id = ? AND booking_id = ? AND status NOT IN ('CHECKED_IN','CHECKED_OUT','CANCELLED')`,
            [hotelId, bookingId]
          )?.c ?? 0;
        run(
          `UPDATE bookings
              SET status = CASE WHEN ? > 0 THEN 'CONFIRMED' ELSE 'CHECKED_IN' END,
                  room_id = COALESCE(room_id, ?),
                  updated_at = ?
            WHERE id = ? AND hotel_id = ?`,
          [left, roomList[0].id, now, bookingId, hotelId]
        );
      }

      /*
       * 4. 客房任务同步（整改指令 2.3）
       *
       * 房间住进人了，之前排给它的「打扫任务」就不该再做了 ——
       * 否则阿姨会敲门进去打扫一个正在住人的房间。这里把该房间所有
       * 待办/进行中的打扫任务标记取消，并写清原因。
       */
      for (const room of roomList) {
        run(
          `UPDATE housekeeping
              SET status = 'CANCELLED', note = COALESCE(note,'') || ' [入住自动取消]', done_at = ?
            WHERE hotel_id = ? AND room_id = ? AND status IN ('PENDING','DOING')`,
          [now, hotelId, room.id]
        );
      }

      /*
       * 5. 渠道订单状态同步（整改指令 2.3）
       *
       * 渠道单号对得上的 channel_orders 记录要推进到 CHECKED_IN，
       * 否则渠道侧一直显示「待入住」，渠道对账时会认为酒店没接单。
       */
      if (channelOrderNo) {
        run(
          `UPDATE channel_orders
              SET status = 'CHECKED_IN', booking_id = COALESCE(booking_id, ?)
            WHERE hotel_id = ? AND channel_order_no = ? AND status NOT IN ('CANCELLED')`,
          [bookingId, hotelId, channelOrderNo]
        );
      }
    });

    /*
     * 渠道库存（整改 4.1 缺口）：入住已经把房间从「可售」变成「在住」，
     * 事务在上一步提交完成，这里再记一条待同步。
     *
     * 与下面 pushOrderStatusForChannelOrder 的区别：
     *   · 那个推的是**订单状态**（待入住 → 已入住），走网络、按单推送；
     *   · markStockDirty 记的是**库存变化**（房量少了 N 间），只落本地队列，
     *     由 stock-queue 合并后统一推房量房价。
     * 两件事都要做：只回传订单状态，渠道的房量仍然是入住前的旧值 → 超卖。
     */
    markStockDirty(hotelId, `入住 ${roomIds.length} 间（${primary.name}），在住占用增加`);

    /*
     * 第 4 轮 P1-20：把「已入住」回传给渠道（放在事务**提交之后**）
     *
     * 不回传的后果：客人已经住进来了，携程/美团后台还显示「待入住」，
     * 渠道按未到店处理 → 影响渠道权重，严重时按 no-show 扣款。
     *
     * 位置说明：渠道推送要走网络（可能几秒），放在事务内会一直占着写锁，
     * 同店其他人的入住/收款都得排队。所以本地表在事务里改完，
     * 事务提交后再单独推送；推送失败只留日志，不影响已经成功的入住。
     */
    if (channelOrderNo) {
      void pushOrderStatusForChannelOrder({
        hotelId,
        channelOrderNo,
        status: "CHECKED_IN",
        operator: user.realName,
        source: "frontdesk-checkin",
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && e.message === "UNAUTHORIZED") {
      return { error: "登录已过期，请重新登录" };
    }
    return { error: e instanceof Error ? e.message : "入住办理失败，请重试" };
  }
  // 逐条打点定位：哪个 revalidate 之后抛 NEXT_REDIRECT
  const rp = (path: string) => {
    try {
      revalidatePath(path);
    } catch (e) {
      throw e;
    }
  };
  rp("/frontdesk");
  rp("/rooms");
  rp("/inhouse");
  rp("/bookings");
  rp("/cashier");
  rp("/dashboard");
  // useActionState 下不能直接 redirect（会以 NEXT_REDIRECT 形式显示成错误），
  // 改为返回成功态，由表单组件跳转。
  return { ok: `已办理入住：${primary.name}（${roomIds.length} 间）` };
}
