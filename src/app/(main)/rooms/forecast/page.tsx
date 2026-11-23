import Link from "next/link";
import { redirect } from "next/navigation";
import ForecastRoomPanel, {
  ForecastStayBlock,
  type ForecastOption,
  type ForecastStayInfo,
} from "@/components/ForecastRoomPanel";
import AssignRoomDialog from "@/components/AssignRoomDialog";
import type { PendingBooking } from "@/components/AssignRoomDialog";
import { all, get } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { addDays, fmtMoney, ROOM_STATUS, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* ============================================================ 版式常量
 * 尺寸全部按去呼呼远期房态截图实测：
 *   左侧三列 64 + 124 + 72 = 260px，每个日期列 100px，行高 60px，
 *   色块 4 边各留 1px 白隙，所以单元格里再套一层 57px 高的方块。
 */
const MAX_DAYS = 60; // 需求：日期范围最长 60 天
const DEFAULT_DAYS = 30; // 需求：默认今天起 30 天
/*
 * 「引入待排房订单」弹窗的行数上限。
 *
 * 弹窗从「订单级」改成「明细级」后，一张多房订单会占多行（一行 = 一个待分房单位），
 * 所以上限要跟着放大：原来 30 是按「订单」算的，若仍卡 30 条，
 * 一个待分房很多的日期会出现「表头写 40 间、弹窗只列 30 间」的新不一致。
 * 这里放到 200 间（弹窗表体本来就滚动，不影响页面性能），
 * 同时仍然保留一个上限，避免极端脏数据把弹窗渲染拖垮。
 */
const PROMPT_LIMIT = 200; // 「引入待排房订单」弹窗最多列 200 个待分房单位（一行一间）

const FLOOR_W = 64;
const TYPE_W = 124;
const ROOM_W = 72;
const LEFT_W = FLOOR_W + TYPE_W + ROOM_W; // 260
const DAY_W = 100;
const BLOCK_H = 57; // 57 + 左右/上下各 1px 白隙 + 1px 网格线 = 60px 行高

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const FLOOR_NAMES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

const INHOUSE_BG = "#4a90e2"; // 在住色块（截图像素 #4a90e2）
const PENDING_BG = "#e6f1fd"; // 已排房未入住预订：浅蓝底
const PAST_BG = "#e3e8e5"; // 早于今天的在住夜（截图像素 #e3e8e5）
const LINE = "#e2e2e2"; // 网格线

/* ============================================================ 服务端类型 */

type RoomRow = {
  id: number;
  room_no: string;
  floor: number;
  room_type_id: number;
  type_name: string;
  type_code: string;
  /** 房态：面板里的「置净」要按房态提示 */
  room_status: string;
};

type StayRow = {
  id: number;
  room_id: number;
  guest_name: string | null;
  check_in_time: string | null;
  check_in_date: string | null;
  out_date: string | null;
  expect_check_out: string | null;
  channel_name: string | null;
  /** 账单口径：余款 / 消费金额 / 收款金额 */
  balance: number | null;
  consume: number | null;
  paid: number | null;
  rate: number | null;
  deposit: number | null;
  breakfast: number | null;
  invoice_party: string | null;
  remark: string | null;
  team_name: string | null;
  guest_count: number | null;
};

type BookingRow = {
  id: number;
  room_id: number | null;
  room_type_id: number | null;
  guest_name: string | null;
  check_in_date: string;
  check_out_date: string;
  room_count: number | null;
  channel_name: string | null;
  /* 弹窗展示用（不参与任何计数）：订单号 / 渠道订单号 / 到店 / 保留时间 */
  booking_no: string;
  channel_order_no: string | null;
  arrival_time: string | null;
  retain_time: string | null;
};

type Search = {
  start?: string;
  days?: string;
  floor?: string;
  type?: string;
  room?: string;
  msg?: string;
  /** 表头「待分房N间」点进来：直接打开「引入待排房订单」弹窗 */
  pending?: string;
};

/** 一个「房间 × 日期」格子里放什么 */
type Slot = {
  kind: "empty" | "inhouse" | "booking";
  /** 同一订单同色块连续跨天时用 key 合并成一整块 */
  key: string;
  name: string;
  channel: string;
  owed: boolean;
  /** 在住色块：点击打开订单操作面板 */
  stayId?: number;
  /** 预订色块：点击跳到预订列表 */
  href?: string;
};

const EMPTY_SLOT: Slot = { kind: "empty", key: "", name: "", channel: "", owed: false };

type Segment = { slot: Slot; len: number };

/* ============================================================ 工具函数 */

function isYmd(v: string | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function md(d: string) {
  return d.slice(5); // 2026-11-14 -> 11-14
}

/** 入住时间：库里存 ISO 串，面板里按截图显示成 YYYY-MM-DD HH:MM */
function stampText(value: string | null) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 16).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function weekday(d: string) {
  return WEEKDAY[new Date(`${d}T00:00:00`).getDay()];
}

function floorLabel(floor: number) {
  return `${FLOOR_NAMES[floor - 1] ?? floor}层`;
}

function buildQuery(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

/** 把一天一天的格子压成「连续段」，同一订单相邻日期只出一个色块 */
function toSegments(slots: Slot[]): Segment[] {
  const out: Segment[] = [];
  for (const slot of slots) {
    const last = out[out.length - 1];
    if (slot.kind !== "empty" && last && last.slot.kind === slot.kind && last.slot.key === slot.key) {
      last.len += 1;
    } else {
      out.push({ slot, len: 1 });
    }
  }
  return out;
}

/* ============================================================ 服务端动作 */

/** 通用提示：底部功能条 / 图例等占位入口，回写一条 msg 让页面弹出提示 */
async function hintAction(formData: FormData) {
  "use server";
  const text = String(formData.get("hint") ?? "操作已完成");
  const qs = String(formData.get("qs") ?? "");
  redirect(`/rooms/forecast?${qs}${qs ? "&" : ""}msg=${encodeURIComponent(text)}`);
}

/* ============================================================ 页面 */

export default async function ForecastPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const today = todayStr();

  /* ---------------- 1. 解析日期区间（最长 60 天，默认今天起 30 天） ---------------- */
  const firstDate = isYmd(sp.start) ? sp.start : today;
  const wanted = Number(sp.days);
  const days = Number.isFinite(wanted) && wanted >= 1 ? Math.min(MAX_DAYS, Math.floor(wanted)) : DEFAULT_DAYS;
  const dates = Array.from({ length: days }, (_, i) => todayStr(addDays(firstDate, i)));
  const lastDate = dates[days - 1];
  const endExclusive = todayStr(addDays(lastDate, 1)); // 区间右开

  /* ---------------- 2. 解析筛选条件 ---------------- */
  const floorFilter = sp.floor && /^-?\d+$/.test(sp.floor) ? Number(sp.floor) : null;
  const typeFilter = sp.type && /^\d+$/.test(sp.type) ? Number(sp.type) : null;
  const roomFilter = sp.room && sp.room.trim() ? sp.room.trim() : null;
  const msg = sp.msg ?? "";
  /** 表头「待分房N间」→ 打开「引入待排房订单」弹窗，并只看覆盖该日的订单 */
  const pendingDay = isYmd(sp.pending) ? sp.pending : "";

  /* ---------------- 3. 房间 + 房型（楼层/房型/房号三列数据源） ---------------- */
  const allRooms = all<RoomRow>(
    `SELECT r.id, r.room_no, COALESCE(r.floor, 0) AS floor, r.room_type_id,
            COALESCE(r.status, 'VC') AS room_status,
            rt.name AS type_name, rt.code AS type_code
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = ?
      ORDER BY COALESCE(r.floor, 0), COALESCE(rt.sort, 0), r.room_no`,
    [hotelId]
  );

  const roomTypes = all<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE hotel_id = ? ORDER BY COALESCE(sort, 0), id`,
    [hotelId]
  );

  const rows = allRooms.filter(
    (r) =>
      (floorFilter === null || r.floor === floorFilter) &&
      (typeFilter === null || r.room_type_id === typeFilter) &&
      (roomFilter === null || r.room_no === roomFilter)
  );
  const floors = [...new Set(allRooms.map((r) => r.floor))].sort((a, b) => a - b);

  /* ---------------- 4. 在住：stays INHOUSE（按房号 + 日期区间） ---------------- */
  const stays = all<StayRow>(
    `SELECT s.id, s.room_id, s.guest_name,
            s.check_in_time, substr(s.check_in_time, 1, 10) AS check_in_date,
            s.expect_check_out AS out_date, s.expect_check_out,
            s.rate, s.deposit, s.breakfast, s.invoice_party, s.remark, s.team_name, s.guest_count,
            COALESCE(c.name, '散客') AS channel_name,
            COALESCE((SELECT SUM(f.balance) FROM folios f WHERE f.stay_id = s.id), 0) AS balance,
            COALESCE((SELECT SUM(f.total_amount) FROM folios f WHERE f.stay_id = s.id), 0) AS consume,
            COALESCE((SELECT SUM(f.paid_amount) FROM folios f WHERE f.stay_id = s.id), 0) AS paid
       FROM stays s
       LEFT JOIN channels c ON c.id = s.channel_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND s.check_in_time IS NOT NULL
        AND substr(s.check_in_time, 1, 10) < ?
        /*
         * ⚠️ 这里**不能**再按 expect_check_out 过滤（本轮修的真 bug）
         *
         * 原来还有一行：
         *     AND (s.expect_check_out IS NULL OR s.expect_check_out > ?)   -- firstDate
         *
         * 它的本意是「只看和本区间有交集的在住单」，但副作用是：
         * **逾期未离店的客人被整条滤掉**。演示库的 21 张在住单
         * expect_check_out 是 11-14~11-18（都早于区间起始日 11-22），
         * 于是 stays 查出来是空的 → occupied=0 → 远期房态「剩 N 间」显示 46 间全空，
         * 而实际在住 21 间 —— 前台按 46 卖会**超卖 21 间**。
         *
         * 正确判据只有一个：'status='INHOUSE'' 就代表客人还在，房间就占着。
         * 逾期（expect_check_out 已过但还没退房）不是「空房」，恰恰是「必须继续占房」。
         *
         * 与 src/lib/metrics.ts、src/lib/room-stock.ts 的口径保持一致：
         * 三处都刻意不看 expect_check_out。
         */
        AND s.check_in_time IS NOT NULL`,
    [hotelId, endExclusive]
  );

  /* ---------------- 5. 预订：PENDING / CONFIRMED（已排房的画块，未排房的进表头计数） ---------------- */
  const bookings = all<BookingRow>(
    `SELECT b.id, b.room_id, b.room_type_id, b.guest_name,
            b.check_in_date, b.check_out_date,
            COALESCE(b.room_count, 1) AS room_count,
            COALESCE(c.name, '散客') AS channel_name,
            b.booking_no, b.channel_order_no, b.arrival_time, b.retain_time
       FROM bookings b
       LEFT JOIN channels c ON c.id = b.channel_id
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date < ? AND b.check_out_date > ?`,
    [hotelId, endExclusive, firstDate]
  );

  /* ---------------- 5a. 多房订单明细 booking_rooms（一行 = 一间房） ----------------
   *
   * ── 为什么必须读明细 ──
   * 一张订单订 3 间房时，`bookings` 主单只有 `room_count = 3` 一个数字，
   * 具体哪几间排在 `booking_rooms` 明细里（1 行 = 1 间，`room_id` 为空 = 还没排房）。
   * 只读主单会犯两个错（实测 BK-MULTI3：room_count=3、主单 room_id=1、明细 3 行）：
   *   · 画块只认 `b.room_id` → 3 间只画出 1 间；
   *   · 计数 `if (b.room_id) continue` → 剩下 2 间连「待分房」都不算
   *     → 那天「剩 N 间」多算 2 间（11-25 显示 24、真值 22；前台按 24 卖就超卖 2 间）。
   *
   * 口径与 `src/lib/room-stock.ts` 保持一致（房态页今日可售就是这套）：
   *   · 明细里排了房的 → 画块 / 算「已排房」，**一行一间**
   *   · 明细里没排房的 → 算「待分房」
   *   · 明细行数 < room_count → 差额也算「待分房」
   *   · 完全没有明细行的老订单 → 退回主单：已排房按 1 间、未排房按 room_count
   * 明细表是老库的迁移表，缺表时按「没有明细」降级，不能让整页报错。
   */
  type BookingDetailRow = {
    booking_id: number;
    room_id: number | null;
    room_type_id: number | null;
    check_in_date: string | null;
    check_out_date: string | null;
  };
  const bookingDetails: BookingDetailRow[] = (() => {
    try {
      return all<BookingDetailRow>(
        `SELECT br.booking_id, br.room_id, br.room_type_id,
                COALESCE(substr(br.check_in_date, 1, 10), b.check_in_date) AS check_in_date,
                COALESCE(substr(br.check_out_date, 1, 10), b.check_out_date) AS check_out_date
           FROM booking_rooms br
           JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
          WHERE br.hotel_id = ?
            AND br.status IN ('PENDING','CONFIRMED')
            AND b.status IN ('PENDING','CONFIRMED')
            AND b.check_in_date < ? AND b.check_out_date > ?`,
        [hotelId, endExclusive, firstDate]
      );
    } catch {
      return [];
    }
  })();
  const detailsByBooking = new Map<number, BookingDetailRow[]>();
  for (const det of bookingDetails) {
    const list = detailsByBooking.get(det.booking_id) ?? [];
    list.push(det);
    detailsByBooking.set(det.booking_id, list);
  }

  /* ---------------- 5b. 「引入待排房订单」弹窗数据源（**明细级：一行 = 一个待分房单位**） ----------------
   *
   * ── 原来的问题：弹窗列「订单」，表头数字却按「间」 ──
   * 原来这里只查 `AND (b.room_id IS NULL OR b.room_id = 0)` 的订单，即「主单完全没排房」才算待分房。
   * 但表头「待分房 N 间」在第 5a / 第 7 节已经改成按 `booking_rooms` 明细逐间数了
   * （与 room-stock.ts 的 booked 口径一致）。两者差在多房订单上：
   *   BK-MULTI3：room_count=3、主单 room_id=8201、明细 3 行（1 已排 + 2 未排）。
   *   → 那 2 间已经算进「待分房 2 间」，
   *   → 但主单 room_id 非空，整单被这条 SQL 过滤掉，
   *   → 用户点「待分房 N 间」看不到这 2 间是谁的，也就没法去排房。
   *
   * ── 现在：和计数用同一份数据、同一套口径 ──
   *   · 未排房明细（br.room_id 为空）        → 一行（第 i/N 间）；
   *   · 明细行数 < room_count 的差额          → 每间补一行「虚拟明细」，否则弹窗会少于表头；
   *   · 完全没有明细行的老订单                → 主单兜底：已排房 → room_count−1 行，未排房 → room_count 行；
   *   · 房型筛选（typesInView）、明细自带日期的覆盖判定、订单日期区间，全部照抄下面 dayStats 的 pending 计数，
   *     所以「弹窗行数 = 表头待分房数」（同一视图、同一天）。
   *
   * ── 行里能看到什么 ──
   *   「预订房型」列显示「房型 · 第 i/N 间（已排 8201）」，把「这间在订单里排第几、这张单已排掉哪几间」讲清楚；
   *   渠道订单号列在渠道单号为空时回落到内部订单号，保证 BK-MULTI3 这类手工单也有单号可核对。
   *
   * ⚠️ 仍然不改「分配房间」的候选口径：候选房 SQL 只给「主单 room_id 为空」的订单
   *    （assignRoomsAction 也只接受这类订单）。所以主单已排房的多房订单在弹窗里能看到、
   *    但那几间不能在弹窗内落库 —— 硬塞候选房会让保存整批报错，反而排不了任何单。
   */
  const typeNameById = new Map<number, string>(roomTypes.map((t) => [t.id, t.name]));
  const roomNoById = new Map<number, string>(allRooms.map((r) => [r.id, r.room_no]));

  /** 当前视图涉及的房型：与 dayStats 的 pending 计数同一过滤条件 */
  const typesInView = new Set(rows.map((r) => r.room_type_id));
  const typeInView = (typeId: number | null) => typeId === null || typesInView.has(typeId);

  /** 这张单已经排掉的房号（明细优先；没有明细才看主单那一间） */
  function assignedRoomNos(b: BookingRow): string[] {
    const details = detailsByBooking.get(b.id) ?? [];
    const ids: number[] = [];
    if (details.length > 0) {
      for (const det of details) if (det.room_id !== null && det.room_id > 0) ids.push(det.room_id);
    } else if (b.room_id) {
      ids.push(b.room_id);
    }
    const out: string[] = [];
    for (const id of ids) {
      const no = roomNoById.get(id);
      if (no && !out.includes(no)) out.push(no);
    }
    return out;
  }

  /** 明细自带日期时按明细判覆盖；明细缺日期 = 跟主单同区间（与 dayStats 的 continue 条件一致） */
  function detailCovers(ci: string | null, co: string | null, day: string) {
    if (!ci || !co) return true;
    return ci <= day && day < co;
  }

  /** 给一条待分房单位挑一个「确实覆盖」的视图内日期：带 ?pending= 点进来时就是那一天 */
  function pickUnitDay(ci: string | null, co: string | null, b: BookingRow): string {
    if (pendingDay) {
      if (!(b.check_in_date <= pendingDay && pendingDay < b.check_out_date)) return "";
      return detailCovers(ci, co, pendingDay) ? pendingDay : "";
    }
    for (const d of dates) {
      if (b.check_in_date <= d && d < b.check_out_date && detailCovers(ci, co, d)) return d;
    }
    return "";
  }

  type PendingUnit = {
    booking: BookingRow;
    /** 该单位在视图内被判定的日期（表头点进来时就是那一天） */
    day: string;
    /** 明细/主单自己的入离日期（弹窗展示用） */
    checkIn: string;
    checkOut: string;
    roomTypeId: number | null;
    /** 本单内第几间（1-based） */
    index: number;
    /** 本单共几间 */
    total: number;
    /** 明细表里没有对应行、由 room_count 差额补出来的虚拟条目 */
    virtual: boolean;
  };

  const pendingUnits: PendingUnit[] = [];
  for (const b of bookings) {
    const details = detailsByBooking.get(b.id) ?? [];
    const roomCount = Math.max(1, Number(b.room_count ?? 1));
    /* 本单总间数：明细比 room_count 多时以明细为准（明细一行一间，与计数同口径） */
    const totalUnits = Math.max(roomCount, details.length);

    if (details.length === 0) {
      /* 老数据没有明细：主单兜底（已排房按 1 间、未排房按 room_count） */
      if (!typeInView(b.room_type_id)) continue;
      const units = b.room_id ? Math.max(0, roomCount - 1) : roomCount;
      let index = b.room_id ? 1 : 0; // 主单那间已排，占掉第 1 间
      for (let k = 0; k < units; k += 1) {
        const day = pickUnitDay(null, null, b);
        index += 1;
        if (!day) continue;
        pendingUnits.push({
          booking: b,
          day,
          checkIn: b.check_in_date,
          checkOut: b.check_out_date,
          roomTypeId: b.room_type_id,
          index,
          total: roomCount,
          virtual: true,
        });
      }
      continue;
    }

    /* 明细：已排房的只占「第几间」编号，未排房的才出一行 */
    let index = 0;
    for (const det of details) {
      index += 1;
      if (det.room_id !== null && det.room_id > 0) continue;
      if (!typeInView(det.room_type_id ?? b.room_type_id)) continue;
      const day = pickUnitDay(det.check_in_date, det.check_out_date, b);
      if (!day) continue;
      pendingUnits.push({
        booking: b,
        day,
        checkIn: det.check_in_date ?? b.check_in_date,
        checkOut: det.check_out_date ?? b.check_out_date,
        roomTypeId: det.room_type_id ?? b.room_type_id,
        index,
        total: totalUnits,
        virtual: false,
      });
    }
    /* 明细行数少于 room_count：差额每间补一行，否则弹窗比表头少 */
    const missing = Math.max(0, roomCount - details.length);
    if (missing > 0 && typeInView(b.room_type_id)) {
      for (let k = 0; k < missing; k += 1) {
        const day = pickUnitDay(null, null, b);
        index += 1;
        if (!day) continue;
        pendingUnits.push({
          booking: b,
          day,
          checkIn: b.check_in_date,
          checkOut: b.check_out_date,
          roomTypeId: b.room_type_id,
          index,
          total: totalUnits,
          virtual: true,
        });
      }
    }
  }
  /* 与原来 SQL 的排序一致：入住日期升序、订单号升序；同一单内按第几间 */
  pendingUnits.sort(
    (a, b) =>
      a.booking.check_in_date.localeCompare(b.booking.check_in_date) ||
      a.booking.id - b.booking.id ||
      a.index - b.index
  );

  const optionRows = all<{ booking_id: number; room_id: number; room_no: string; status: string; room_type_name: string; upgradable: number }>(
    `SELECT b.id AS booking_id, r.id AS room_id, r.room_no, r.status,
            rt.name AS room_type_name,
            CASE WHEN r.room_type_id = b.room_type_id THEN 0 ELSE 1 END AS upgradable
       FROM bookings b
       JOIN rooms r ON r.hotel_id = b.hotel_id
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE b.hotel_id = ?
        AND b.status IN ('PENDING','CONFIRMED')
        AND (b.room_id IS NULL OR b.room_id = 0)
        AND r.status IN ('VC','VD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.hotel_id = b.hotel_id AND s.room_id = r.id AND s.status = 'INHOUSE'
             AND substr(s.check_in_time, 1, 10) < b.check_out_date
             AND (s.expect_check_out IS NULL OR s.expect_check_out > b.check_in_date)
        )
        AND NOT EXISTS (
          SELECT 1 FROM bookings o
           WHERE o.hotel_id = b.hotel_id AND o.room_id = r.id
             AND o.status IN ('CONFIRMED','CHECKED_IN')
             AND o.check_in_date < b.check_out_date AND o.check_out_date > b.check_in_date
        )
        /*
         * 第 4 轮 P1-38：还要查 booking_rooms 明细
         * 多房订单主单 room_id 通常只指一间，其余房间在明细表里；
         * 不查明细会让已被占用的房间出现在候选列表里，选了才报冲突。
         * 同时把 PENDING（未排房、物理没占）从上面的判断里去掉了。
         */
        AND NOT EXISTS (
          SELECT 1 FROM booking_rooms br
            JOIN bookings ob ON ob.id = br.booking_id AND ob.hotel_id = br.hotel_id
           WHERE br.hotel_id = b.hotel_id AND br.room_id = r.id
             AND br.status IN ('CONFIRMED','CHECKED_IN')
             AND ob.status IN ('CONFIRMED','CHECKED_IN')
             AND ob.check_in_date < b.check_out_date AND ob.check_out_date > b.check_in_date
        )
      ORDER BY upgradable, r.room_no`,
    [hotelId]
  );

  const roomsByBooking = new Map<
    number,
    { id: number; roomNo: string; status: string; roomTypeName?: string; upgradable?: boolean }[]
  >();
  for (const o of optionRows) {
    const list = roomsByBooking.get(o.booking_id) ?? [];
    list.push({
      id: o.room_id,
      roomNo: o.room_no,
      status: o.status,
      roomTypeName: o.room_type_name,
      upgradable: Number(o.upgradable) === 1,
    });
    roomsByBooking.set(o.booking_id, list);
  }

  /*
   * 弹窗行 = 一个待分房单位（一间），按表头那天的待分房口径逐条铺开。
   *
   * · roomCount 固定 1：一行就是一间，避免「3 行 × 房间数 3 = 9 间」的误读；
   *   这张单总共有几间写在「预订房型」列的「第 i/N 间」里。
   * · 候选房仍然取 roomsByBooking（只覆盖主单未排房的订单）。主单已排房的多房订单
   *   在这里没有候选房 —— 它的剩余间由订单详情排房，弹窗只负责「让人看得到是谁的」。
   */
  const pendingBookings: PendingBooking[] = pendingUnits.slice(0, PROMPT_LIMIT).map((u) => {
    const b = u.booking;
    const assigned = assignedRoomNos(b);
    const typeName = (u.roomTypeId !== null ? typeNameById.get(u.roomTypeId) : "") ?? "";
    const unitText = `${typeName || "未指定房型"} · 第${u.index}/${u.total}间${u.virtual ? "（剩余未生成明细）" : ""}`;
    return {
      id: b.id,
      /* 行级唯一键：一张多房订单会展开成多行（共享同一个 id），弹窗靠它区分勾选/选房 */
      rowKey: `${b.id}#${u.index}${u.virtual ? "v" : "d"}`,
      bookingNo: b.booking_no,
      channelName: (b.channel_name ?? "").trim(),
      /* 渠道单号为空时回落到内部订单号：手工单 / 演示单只有 booking_no，空着就没法核对 */
      channelOrderNo: (b.channel_order_no ?? "").trim() || b.booking_no,
      guestName: (b.guest_name ?? "").trim(),
      roomTypeName: assigned.length > 0 ? `${unitText}（已排 ${assigned.join("、")}）` : unitText,
      roomCount: 1,
      checkInDate: u.checkIn,
      checkInTime: (b.arrival_time ?? "").trim() || "12:00",
      checkOutDate: u.checkOut,
      checkOutTime: "12:00",
      latestArrival: (b.retain_time ?? "").trim(),
      rooms: roomsByBooking.get(b.id) ?? [],
    };
  });

  /* ---------------- 6. 组装「每间房每天」的状态矩阵 ---------------- */
  const cellMap = new Map<number, Slot[]>();
  for (const r of rows) cellMap.set(r.id, Array.from({ length: days }, () => EMPTY_SLOT));

  // 在住优先：check_in <= 当天 < 离店日
  for (const s of stays) {
    const slots = cellMap.get(s.room_id);
    if (!slots) continue;
    const from = s.check_in_date ?? firstDate;
    /*
     * 离店日的取法（**这是本轮修的一个真 bug**）
     *
     * 原来直接取 `s.out_date`。但「在住单」查的是 status='INHOUSE' 的单，
     * 而客人**可能逾期未离店** —— 这时 `expect_check_out` 早就过去了，
     * `d < to` 对今天及之后全不成立，于是：
     *   · 该房间在远期房态里显示成「空房」
     *   · 表头「剩 N 间」虚高（实测 46 间全空，而实际在住 21 间 → 前台按 46 卖会超卖 21 间）
     *
     * 这正是 `src/lib/metrics.ts` 踩过的同一个坑（按 expect_check_out 截断
     * 会把逾期房间算成空房，出租率归零）。修法一致：
     * **只要客人还在（status='INHOUSE'），房间就一直占着**，
     * 所以离店日取 `max(expect_check_out, 明天)` —— 至少占掉今天和明天。
     */
    const rawOut = s.out_date ?? endExclusive;
    /* stays 查询本身就限定了 status=INHOUSE，所以逾期单直接延续到区间末尾 */
    const to = rawOut > today ? rawOut : endExclusive;
    const name = (s.guest_name ?? "").trim() || "在住";
    const channel = (s.channel_name ?? "").trim() || "散客";
    const owed = Number(s.balance ?? 0) > 0.01;
    for (let i = 0; i < days; i++) {
      const d = dates[i];
      if (from <= d && d < to && slots[i].kind === "empty") {
        // 早于今天的在住夜单独成段（灰色），今天及以后是蓝色
        slots[i] = {
          kind: "inhouse",
          key: `s${s.id}:${d < today ? "p" : "f"}`,
          name,
          channel,
          owed,
          stayId: s.id,
        };
      }
    }
  }

  /*
   * 未入住但已排房的预订：房间已锁定，画浅蓝色块
   *
   * ⚠️ 原来这里只画 `b.room_id` 那一间 —— 多房订单（room_count = 3、主单只填了首间）
   * 就只画出 1 间，剩下 2 间既没画块、也没进「待分房」计数，那天「剩 N 间」多算 2 间。
   *
   * 现在按 `booking_rooms` 明细画：一行明细 = 一间房。
   *   · 有明细 → 只画明细里排了房的那些房号（主单 room_id 不再重复画，否则一单画 4 间）
   *   · 没明细 → 退回主单 room_id（老数据，1 间）
   * 没排到房的那几间（明细 room_id 为空 / 明细数少于 room_count）由下面 dayStats 的
   * pending 计数负责，与 room-stock.ts 的「未排房按 room_count」口径对齐。
   */
  const blockedRoomIds = new Set(
    rows.filter((r) => r.room_status === "OOO" || r.room_status === "LOCK").map((r) => r.id)
  );
  for (const b of bookings) {
    const details = detailsByBooking.get(b.id) ?? [];
    /* 这一单要画块的房号：明细优先，没有明细才用主单 */
    const targetRooms: number[] = [];
    if (details.length > 0) {
      for (const det of details) {
        if (det.room_id === null || det.room_id <= 0) continue;
        if (targetRooms.includes(det.room_id)) continue;
        targetRooms.push(det.room_id);
      }
    } else if (b.room_id) {
      targetRooms.push(b.room_id);
    }
    if (targetRooms.length === 0) continue;

    const name = (b.guest_name ?? "").trim() || "预订";
    const channel = (b.channel_name ?? "").trim() || "散客";
    for (const roomId of targetRooms) {
      const slots = cellMap.get(roomId);
      if (!slots) continue;
      /* 维修房 / 锁房已经在「剩 N 间」里整间扣过（blocked），再按订单扣一次就是重复扣减 */
      if (blockedRoomIds.has(roomId)) continue;
      for (let i = 0; i < days; i++) {
        const d = dates[i];
        if (b.check_in_date <= d && d < b.check_out_date && slots[i].kind === "empty") {
          slots[i] = {
            kind: "booking",
            key: `b${b.id}:${d < today ? "p" : "f"}`,
            name,
            channel,
            owed: false,
            href: `/bookings?q=${encodeURIComponent(name)}`,
          };
        }
      }
    }
  }

  /* ---------------- 7. 表头每天的三行数字 ----------------
   * 剩 N 间 = 可售房量 = 物理可售与 allotment 取小（与房态页同一口径，见 lib/room-stock.ts）
   *
   * ⚠️ 这里原来只算 `rows.length − 在住 − 已排房 − 待分房`，有两处漏扣：
   *    1. **没扣 OOO(维修) / LOCK(锁房)** —— `rows.length` 包含这两种房，
   *       它们本该整段日期都不能卖，于是「剩 N 间」会虚高
   *    2. **没读 rate_calendar.allotment** —— 运营手工把某天限售成 2 间，
   *       远期房态还按物理剩余显示，两张页面给出不同数字
   *
   * 清单（第九轮第二节）要求「房态、远期房态、房型预测、渠道推送共用一套库存算法」。
   * 这里补上 OOO / LOCK / allotment 三项，口径与 `todayRoomTypeStock` 对齐：
   *   物理可售 = 可视房数 − OOO − LOCK − 在住 − 已排房 − 待分房
   *   可售     = 配了 allotment ? min(物理可售, allotment) : 物理可售
   *
   * 注意 total 仍是**当前视图内的房数**（受楼层/房型筛选影响），
   * 这是本页的设计（「按当前视图看未来」），不是全店口径 —— 页面上有说明。
   *
   * `typesInView` / `typeInView` 已在第 5b 节（弹窗数据源）定义：弹窗与这里的 pending
   * 计数共用同一套房型过滤，否则「弹窗行数」和「表头待分房数」会再次分叉。
   */

  /* 每天各自的 OOO / LOCK 房数（维修与锁房是房间属性，但可能今天维修明天正常，
     所以按月查不到当天状态时按「当前状态」兜底 —— 远期房态本来就依赖当前房态快照） */
  const blockedByType = new Map<number, number>();
  for (const r of rows) {
    if (r.room_status === "OOO" || r.room_status === "LOCK") {
      blockedByType.set(r.room_type_id, (blockedByType.get(r.room_type_id) ?? 0) + 1);
    }
  }

  /* 手工房量（allotment）：key = 房型id:日期。语义是「当天剩余可卖数量」 */
  const allots = new Map<string, number>();
  try {
    for (const a of all<{ room_type_id: number; date: string; allotment: number }>(
      `SELECT room_type_id, date, allotment FROM rate_calendar
        WHERE hotel_id = ? AND allotment IS NOT NULL AND date >= ? AND date <= ?`,
      [hotelId, dates[0] ?? "", dates[dates.length - 1] ?? ""]
    )) {
      allots.set(`${Number(a.room_type_id)}:${String(a.date).slice(0, 10)}`, Number(a.allotment));
    }
  } catch {
    /* 老库没有 allotment 列：按「没配手工房量」处理 */
  }

  const dayStats = dates.map((d, i) => {
    let occupied = 0;
    let assigned = 0;
    for (const r of rows) {
      const slot = cellMap.get(r.id)?.[i];
      if (!slot) continue;
      if (slot.kind === "inhouse") occupied += 1;
      else if (slot.kind === "booking") assigned += 1;
    }
    /*
     * 待分房（还没排到具体房间的占用）
     *
     * ⚠️ 原来是 `if (b.room_id) continue;` —— 只要主单填了一间房，整单就不再进待分房。
     * 多房订单主单通常只填首间（BK-MULTI3：room_count=3、room_id=1），
     * 剩下 2 间于是**既没画块也不计数**，那天「剩 N 间」多算 2 间。
     *
     * 现在按 `booking_rooms` 明细算，一行一间：
     *   · 明细 room_id 为空       → 待分房 +1
     *   · 明细数 < room_count     → 差额也算待分房（明细漏行的老数据兜底）
     *   · 完全没有明细行          → 退回主单：已排房 → room_count − 1，未排房 → room_count
     * 与 room-stock.ts 的 booked 口径一致（它也是「明细一行一间、主单兜底」）。
     */
    let pending = 0;
    for (const b of bookings) {
      if (!(b.check_in_date <= d && d < b.check_out_date)) continue;
      const details = detailsByBooking.get(b.id) ?? [];
      const roomCount = Math.max(1, Number(b.room_count ?? 1));
      /** 房型筛选：null = 订单没指房型，任何视图都算 */
      const typeInView = (typeId: number | null) => typeId === null || typesInView.has(typeId);
      if (details.length === 0) {
        /* 老数据没有明细：主单兜底（已排房按 1 间、未排房按 room_count） */
        if (!typeInView(b.room_type_id)) continue;
        pending += b.room_id ? Math.max(0, roomCount - 1) : roomCount;
        continue;
      }
      /* 明细里没排房的（按明细自己的房型算，跨房型订单才不会漏） */
      for (const det of details) {
        /* 明细自带日期（可能分段落住），不覆盖当天的行不算 */
        if (det.check_in_date && det.check_out_date && !(det.check_in_date <= d && d < det.check_out_date)) continue;
        if (det.room_id !== null && det.room_id > 0) continue;
        if (!typeInView(det.room_type_id ?? b.room_type_id)) continue;
        pending += 1;
      }
      /* 明细行数少于 room_count：差额也算待分房（明细漏行的老数据兜底） */
      const missing = roomCount - details.length;
      if (missing > 0 && typeInView(b.room_type_id)) pending += missing;
    }

    /*
     * 可视房数（含 OOO/LOCK）→ 扣掉维修/锁房 → 物理可售 → 与 allotment 取小
     *
     * allotment 是按房型配的，而本页的「剩 N 间」是全店（或当前视图）汇总，
     * 所以这里取「该视图内各房型的 allotment 之和」作为当天手工上限；
     * 某个房型没配就按它的物理可售算（不额外限制）。
     */
    const total = rows.length;
    let blocked = 0;
    for (const r of rows) {
      if (r.room_status === "OOO" || r.room_status === "LOCK") blocked += 1;
    }
    const physicalSellable = Math.max(0, total - blocked - occupied - assigned - pending);

    /* 按房型汇总 allotment 上限（没配的房型贡献它的物理可售） */
    let manualCap = 0;
    let anyManual = false;
    const perType = new Map<number, { total: number; blocked: number; used: number }>();
    for (const r of rows) {
      const e = perType.get(r.room_type_id) ?? { total: 0, blocked: 0, used: 0 };
      e.total += 1;
      if (r.room_status === "OOO" || r.room_status === "LOCK") e.blocked += 1;
      perType.set(r.room_type_id, e);
    }
    for (const r of rows) {
      const slot = cellMap.get(r.id)?.[i];
      if (slot && (slot.kind === "inhouse" || slot.kind === "booking")) {
        const e = perType.get(r.room_type_id);
        if (e) e.used += 1;
      }
    }
    for (const [typeId, e] of perType) {
      const phys = Math.max(0, e.total - e.blocked - e.used);
      const a = allots.get(`${typeId}:${d}`);
      if (a === undefined) {
        manualCap += phys;
      } else {
        anyManual = true;
        manualCap += Math.min(phys, Math.max(0, a));
      }
    }
    /* 待分房属于「还没排到具体房型」的占用，从手工上限里也要扣 */
    const capAfterManual = anyManual ? Math.max(0, manualCap - pending) : physicalSellable;
    const left = anyManual ? Math.min(physicalSellable, capAfterManual) : physicalSellable;

    return {
      day: d,
      total,
      blocked,
      occupied,
      assigned,
      pending,
      allotmentHold: physicalSellable - left,
      left,
    };
  });

  /* ---------------- 7.5 订单操作面板的数据（点色块弹出，见 ForecastRoomPanel） ----------------
   * 全部是只读查询：在住单详情 + 换房可选空房 + 联房目标，查好一次性传给客户端组件。
   * 面板里的写操作复用 rooms/actions.ts 里已有的 server action，本页不新增 SQL 写入。
   */
  const roomById = new Map(rows.map((r) => [r.id, r]));
  const panelStays = stays.filter((s) => roomById.has(s.room_id));

  // 物品租赁：租赁表是懒建的，先探测再查，避免整页报错
  const rentalByRoom = new Map<string, string>();
  if (get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rental_records'`)) {
    const rentalRows = all<{ room_no: string | null; items: string | null }>(
      `SELECT rr.room_no AS room_no, GROUP_CONCAT(ri.name || '×' || rr.qty, '、') AS items
         FROM rental_records rr
         LEFT JOIN rental_items ri ON ri.id = rr.item_id
        WHERE rr.hotel_id = ? AND rr.status = 'RENTED'
        GROUP BY rr.room_no`,
      [hotelId]
    );
    for (const row of rentalRows) {
      if (row.room_no) rentalByRoom.set(row.room_no, (row.items ?? "").trim());
    }
  }

  // 联房组：room_links 同样是懒建表
  const linkRoomsByStay = new Map<number, string[]>();
  if (get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_links'`)) {
    const linkRows = all<{ link_no: string; stay_id: number; room_no: string | null }>(
      `SELECT rl.link_no, rl.stay_id, r.room_no
         FROM room_links rl
         LEFT JOIN stays s ON s.id = rl.stay_id
         LEFT JOIN rooms r ON r.id = s.room_id
        WHERE rl.hotel_id = ?`,
      [hotelId]
    );
    const roomsByLink = new Map<string, string[]>();
    const linkOfStay = new Map<number, string>();
    for (const row of linkRows) {
      linkOfStay.set(row.stay_id, row.link_no);
      const list = roomsByLink.get(row.link_no) ?? [];
      if (row.room_no) list.push(row.room_no);
      roomsByLink.set(row.link_no, list);
    }
    for (const [stayId, linkNo] of linkOfStay) {
      linkRoomsByStay.set(stayId, roomsByLink.get(linkNo) ?? []);
    }
  }

  const panelStayInfos: ForecastStayInfo[] = panelStays.map((s) => {
    const room = roomById.get(s.room_id)!;
    const linked = linkRoomsByStay.get(s.id) ?? [];
    return {
      stayId: s.id,
      roomId: s.room_id,
      roomNo: room.room_no,
      roomTypeName: room.type_name,
      roomStatus: room.room_status,
      guestName: (s.guest_name ?? "").trim() || "在住",
      channelName: (s.channel_name ?? "").trim() || "散客",
      checkInText: stampText(s.check_in_time),
      checkOutText: s.expect_check_out ?? "",
      rate: Number(s.rate ?? 0),
      consume: Number(s.consume ?? 0),
      paid: Number(s.paid ?? 0),
      balance: Number(s.balance ?? 0),
      deposit: Number(s.deposit ?? 0),
      breakfast: Number(s.breakfast ?? 0),
      cardCount: Math.max(1, Number(s.guest_count ?? 1)),
      invoiceParty: (s.invoice_party ?? "").trim(),
      guestPassword: "",
      itemRental: rentalByRoom.get(room.room_no) ?? "",
      remark: (s.remark ?? "").trim(),
      linkRooms: linked.length > 0 ? linked.length : 1,
      otherLinkRooms: linked.filter((no) => no !== room.room_no).join("、"),
    };
  });

  /** 换房可选：空净 / 空脏房 */
  const vacantRoomOptions: ForecastOption[] = all<{
    id: number;
    room_no: string;
    type_name: string;
    status: string;
  }>(
    `SELECT r.id, r.room_no, rt.name AS type_name, r.status
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = ? AND r.status IN ('VC','VD')
      ORDER BY COALESCE(r.floor, 0), r.room_no`,
    [hotelId]
  ).map((r) => ({
    id: r.id,
    label: `${r.room_no} · ${r.type_name}（${ROOM_STATUS[r.status]?.label ?? r.status}）`,
  }));

  /** 联房目标：全店其他在住单（跨筛选，避免只看一段日期时找不到可联房对象） */
  const linkStayOptions: ForecastOption[] = all<{
    id: number;
    room_no: string;
    guest_name: string | null;
    balance: number | null;
  }>(
    `SELECT s.id, r.room_no, s.guest_name,
            COALESCE((SELECT SUM(f.balance) FROM folios f WHERE f.stay_id = s.id), 0) AS balance
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
      ORDER BY COALESCE(r.floor, 0), r.room_no`,
    [hotelId]
  ).map((s) => ({ id: s.id, label: `${s.room_no} · ${s.guest_name ?? "客人"} · ${fmtMoney(s.balance)}` }));

  /* ---------------- 8. 底部功能条的统计（整店口径，不随筛选变化） ---------------- */
  const inhouseNow = get<{ c: number }>(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [
    hotelId,
  ])?.c ?? 0;
  const occupancy = allRooms.length ? ((inhouseNow / allRooms.length) * 100).toFixed(2) : "0.00";
  const channelNew = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = ? AND status = 'NEW'`,
    [hotelId]
  )?.c ?? 0;
  const arrivalsToday = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date = ?`,
    [hotelId, today]
  )?.c ?? 0;
  const departuresToday = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND expect_check_out = ?`,
    [hotelId, today]
  )?.c ?? 0;

  /* ---------------- 9. 链接工具：所有跳转都保留当前视图 ---------------- */
  const base = {
    start: firstDate,
    days,
    floor: floorFilter,
    type: typeFilter,
    room: roomFilter,
  };
  const qs = buildQuery(base);
  const hrefWith = (patch: Record<string, string | number | null | undefined>) =>
    `/rooms/forecast?${buildQuery({ ...base, ...patch })}`;
  const shift = (n: number) => todayStr(addDays(firstDate, n));

  const tableWidth = LEFT_W + DAY_W * days;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* 右上角提示：由 msg 参数驱动，纯 CSS 淡出，不依赖客户端 JS */}
      {msg ? (
        <>
          <style
            dangerouslySetInnerHTML={{
              __html: "@keyframes qhToast{0%{opacity:0;transform:translate(-50%,-6px)}8%{opacity:1;transform:translate(-50%,0)}76%{opacity:1}100%{opacity:0}}",
            }}
          />
          <div
            key={msg}
            className="pointer-events-none fixed left-1/2 top-24 z-[200] max-w-[80vw] rounded bg-black/80 px-3.5 py-2 text-[12px] text-white shadow-lg"
            style={{ transform: "translate(-50%, 0)", animation: "qhToast 3.2s ease forwards" }}
          >
            {msg}
          </div>
        </>
      ) : null}

      {/* ============================================ 顶部工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e2e2e2] bg-white px-3 py-1.5">
        {/* 引入待排房订单：打开排房弹窗（客户端组件自带按钮 + 弹窗） */}
        <AssignRoomDialog bookings={pendingBookings} defaultOpen={pendingDay !== ""} />

        {/* 日期区间：‹ 11-14 至 12-13 › */}
        <div className="flex items-center gap-0.5 text-[12px] text-[#333]">
          <Link
            href={hrefWith({ start: shift(-days) })}
            aria-label="往前一段日期"
            className="flex h-6 w-6 items-center justify-center rounded text-[15px] text-[#666] hover:bg-[#f2f4f7] hover:text-[#32c141]"
          >
            ‹
          </Link>
          <span className="min-w-[108px] text-center tabular-nums">
            {md(firstDate)}至{md(lastDate)}
          </span>
          <Link
            href={hrefWith({ start: shift(days) })}
            aria-label="往后一段日期"
            className="flex h-6 w-6 items-center justify-center rounded text-[15px] text-[#666] hover:bg-[#f2f4f7] hover:text-[#32c141]"
          >
            ›
          </Link>
          <Link
            href={hrefWith({ start: today })}
            className="ml-1 rounded-[3px] border border-[#d9dde3] px-1.5 py-0.5 text-[12px] text-[#555] hover:border-[#32c141] hover:text-[#32c141]"
          >
            今天
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-[12px] text-[#8a8a8a]">
          <span>
            共 <b className="font-semibold text-[#333]">{rows.length}</b> 间
          </span>
          <span className="text-[#d5d5d5]">·</span>
          <span>日期范围 {days} 天（最长 {MAX_DAYS} 天）</span>
          <span className="text-[#d5d5d5]">·</span>
          {[14, 30, 60].map((n) => (
            <Link
              key={n}
              href={hrefWith({ days: n })}
              className={`rounded-[3px] px-1.5 py-0.5 ${
                days === n ? "bg-[#eaf7ec] font-medium text-[#2fa84f]" : "text-[#666] hover:bg-[#f2f4f7]"
              }`}
            >
              {n}天
            </Link>
          ))}
        </div>
      </div>

      {/* ============================================ 甘特表：横向滚动 + 左侧三列 sticky */}
      <div className="min-h-0 flex-1 overflow-auto border-t border-[#e8e8e8]">
        {/* 订单操作面板：客户端 Provider 只持有「当前选中的在住单」，甘特表原样作为 children */}
        <ForecastRoomPanel
          stays={panelStayInfos}
          vacantRooms={vacantRoomOptions}
          linkTargets={linkStayOptions}
        >
          <table
            className="border-separate border-spacing-0 text-[12px]"
            style={{ tableLayout: "fixed", width: "100%", minWidth: tableWidth }}
          >
            <colgroup>
              <col style={{ width: FLOOR_W }} />
              <col style={{ width: TYPE_W }} />
              <col style={{ width: ROOM_W }} />
              {dates.map((d) => (
                <col key={d} style={{ width: DAY_W }} />
              ))}
            </colgroup>

            {/* ---------- 表头两段（固定）：日期 34px + 统计 40px（剩N间 / 待分房N间） ---------- */}
            <thead>
              <tr>
                <FilterTh
                  label="楼层"
                  left={0}
                  width={FLOOR_W}
                  active={floorFilter}
                  options={[
                    { label: "全部楼层", value: null },
                    ...floors.map((f) => ({ label: floorLabel(f), value: f })),
                  ]}
                  hrefWith={hrefWith}
                  param="floor"
                />
                <FilterTh
                  label="房型"
                  left={FLOOR_W}
                  width={TYPE_W}
                  active={typeFilter}
                  options={[
                    { label: "全部房型", value: null },
                    ...roomTypes.map((t) => ({ label: t.name, value: t.id })),
                  ]}
                  hrefWith={hrefWith}
                  param="type"
                />
                <FilterTh
                  label="房号"
                  left={FLOOR_W + TYPE_W}
                  width={ROOM_W}
                  active={roomFilter}
                  options={[
                    { label: "全部房号", value: null },
                    ...allRooms.map((r) => ({ label: r.room_no, value: r.room_no })),
                  ]}
                  hrefWith={hrefWith}
                  param="room"
                />
                {dayStats.map((st) => {
                  const isToday = st.day === today;
                  const isPast = st.day < today;
                  return (
                    <th
                      key={st.day}
                      scope="col"
                      className={`sticky top-0 z-20 h-[34px] whitespace-nowrap border-r bg-[#f8f8f8] p-0 text-center align-middle text-[14px] font-normal tabular-nums ${
                        isToday ? "font-semibold text-[#e60012]" : isPast ? "text-[#999]" : "text-[#333]"
                      }`}
                      style={{ borderRightColor: LINE }}
                    >
                      <a
                        href={`/rooms/forecast?start=${st.day}`}
                        title={`以 ${st.day} 为起始日查看`}
                        className="flex h-full w-full items-center justify-center px-1 hover:bg-[#eaf7ec] hover:underline"
                      >
                        {isToday ? "今天" : md(st.day)} {weekday(st.day)}
                      </a>
                    </th>
                  );
                })}
              </tr>
              <tr>
                {dayStats.map((st) => {
                  const isPast = st.day < today;
                  return (
                    <th
                      key={`stat-${st.day}`}
                      className={`sticky top-[34px] z-20 h-[40px] whitespace-nowrap border-b border-r bg-[#f8f8f8] p-0 text-center align-middle font-normal tabular-nums ${
                        isPast ? "text-[#999]" : "text-[#555]"
                      }`}
                      style={{ borderRightColor: LINE, borderBottomColor: LINE }}
                    >
                      {isPast ? (
                        <a
                          href="/rooms?filter=VC"
                          title={`${st.day} 可售 ${st.left} 间，点击查看空房`}
                          className="flex h-full w-full items-center justify-center text-[10px] hover:bg-[#eaf7ec] hover:underline"
                        >
                          剩{st.left}间
                        </a>
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center">
                          <a
                            href="/rooms?filter=VC"
                            title={`${st.day} 可售 ${st.left} 间，点击查看空房`}
                            className="flex h-[20px] w-full items-center justify-center text-[10px] hover:bg-[#eaf7ec] hover:underline"
                          >
                            剩{st.left}间
                          </a>
                          <Link
                            href={hrefWith({ pending: st.day })}
                            title={`引入 ${st.day} 的待排房订单`}
                            className={`flex h-[20px] w-full items-center justify-center text-[10px] underline hover:bg-[#fff1f0] ${
                              st.pending > 0 ? "text-[#ff0000]" : "text-[#999]"
                            }`}
                          >
                            待分房{st.pending}间
                          </Link>
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={3 + days}
                    className="h-[120px] text-center align-middle text-[13px] text-[#999]"
                    style={{ borderBottomColor: LINE }}
                  >
                    {allRooms.length === 0
                      ? "暂无房间数据，请先在「系统设置 - 房间管理」里维护房间"
                      : "当前筛选条件下没有房间，点击表头「楼层 / 房型 / 房号」可清除筛选"}
                  </td>
                </tr>
              )}

              {rows.map((room, idx) => {
                const prev = idx > 0 ? rows[idx - 1] : null;
                const isFloorHead = !prev || prev.floor !== room.floor;
                const isTypeHead = isFloorHead || prev!.room_type_id !== room.room_type_id;
                const floorSpan = spanFrom(rows, idx, (a, b) => a.floor === b.floor);
                const typeSpan = spanFrom(
                  rows,
                  idx,
                  (a, b) => a.floor === b.floor && a.room_type_id === b.room_type_id
                );
                const segments = toSegments(cellMap.get(room.id) ?? []);

                return (
                  <tr key={room.id}>
                    {isFloorHead && (
                      <td
                        rowSpan={floorSpan}
                        className="sticky left-0 z-20 border-b border-r bg-[#f8f8f8] px-2 py-2 align-top text-[14px] font-semibold text-[#222]"
                        style={{ width: FLOOR_W, borderBottomColor: LINE, borderRightColor: LINE }}
                      >
                        {floorLabel(room.floor)}
                      </td>
                    )}
                    {isTypeHead && (
                      <td
                        rowSpan={typeSpan}
                        className="sticky z-20 border-b border-r bg-[#f8f8f8] px-2 py-2 align-top text-[14px] leading-[20px] text-[#555]"
                        style={{ left: FLOOR_W, width: TYPE_W, borderBottomColor: LINE, borderRightColor: LINE }}
                      >
                        {room.type_name}
                      </td>
                    )}
                    <td
                      className="sticky z-20 border-b border-r bg-[#f8f8f8] px-1 py-2 align-top text-center text-[14px] text-[#333] tabular-nums"
                      style={{
                        left: FLOOR_W + TYPE_W,
                        width: ROOM_W,
                        borderBottomColor: LINE,
                        borderRightColor: LINE,
                      }}
                    >
                      {room.room_no}
                    </td>

                    {segments.map((seg, si) => {
                      const slot = seg.slot;
                      if (slot.kind === "empty") {
                        // 空房：白底 + 1px 灰边框
                        return (
                          <td
                            key={`e${si}`}
                            className="border-b border-r bg-white p-px"
                            style={{ borderBottomColor: LINE, borderRightColor: LINE }}
                          >
                            <div style={{ height: BLOCK_H }} />
                          </td>
                        );
                      }
                      const isInhouse = slot.kind === "inhouse";
                      const isPast = slot.key.endsWith(":p");
                      return (
                        <td
                          key={`b${si}`}
                          colSpan={seg.len}
                          className="border-b border-r bg-white p-px"
                          style={{ borderBottomColor: LINE, borderRightColor: LINE }}
                        >
                          {isInhouse ? (
                            /* 在住块：改成 button，点开订单操作面板 */
                            <ForecastStayBlock
                              stayId={slot.stayId ?? 0}
                              name={slot.name}
                              channel={slot.channel}
                              owed={slot.owed}
                              height={BLOCK_H}
                              bg={isPast ? PAST_BG : INHOUSE_BG}
                              fg={isPast ? "#374151" : "#000000d9"}
                            />
                          ) : (
                            <Link
                              href={slot.href ?? "/orders"}
                              title={`查看 ${slot.name} 的预订`}
                              className="flex flex-col justify-center gap-[3px] px-2 transition-opacity hover:opacity-90"
                              style={{ height: BLOCK_H, background: PENDING_BG, color: "#1d54d8" }}
                            >
                              <span className="truncate text-[12px] leading-[15px] font-medium">{slot.name}</span>
                              <span className="flex items-center gap-1 text-[11px] leading-[14px]">
                                <span className="truncate opacity-90">{slot.channel}</span>
                              </span>
                            </Link>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ForecastRoomPanel>
      </div>

      {/* ============================================ 底部功能条（与房态页一致） */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[#e8e8e8] bg-white px-2">
        <PillLink label="直连订单" badge={channelNew} tone="red" href="/channel-orders" />
        <PillLink label="前台任务" badge={arrivalsToday + departuresToday} tone="grey" href="/today-todo" />
        <PillLink label="小商超" badge={0} tone="grey" href="/shop" />
        <PillLink label="异常事件" badge={0} tone="grey" href="/logs" />

        {[
          { label: "房态设置", href: "/settings" },
          { label: "保洁中心", href: "/housekeeping" },
          { label: "维修房管理", href: "/rooms?filter=OOO" },
        ].map((a) => (
          <Link
            key={a.label}
            href={a.href}
            className="flex h-6 shrink-0 items-center whitespace-nowrap rounded-full bg-[#58bc62] px-2.5 text-[12px] text-white hover:bg-[#4fae59]"
          >
            {a.label}
          </Link>
        ))}

        <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-3 text-[12px] text-[#8a8a8a]">
          <span>
            当前占房数 <b className="font-semibold text-[#333]">{inhouseNow}</b>
          </span>
          <span className="text-[#d5d5d5]">·</span>
          <span>
            预计出租率 <b className="font-semibold text-[#333]">{occupancy}%</b>
          </span>
          <span className="text-[#d5d5d5]">·</span>
          <form action={hintAction} className="flex items-center gap-1.5">
            <input type="hidden" name="qs" value={qs} />
            <HintButton
              label="图例说明"
              hint="图例：蓝色=在住 浅蓝=已排房待入住 灰色=今天之前的在住夜 白底=可售空房（块内两行为客人名 / 渠道名，红色「欠」= 欠费）"
              tone="grey"
            />
            <PillLink label="在线客服" badge={0} tone="grey" href="/sms" />
            <PillLink label="叫醒" badge={0} tone="grey" href="/inhouse?wakeup=1" />
            <PillLink label="公告" badge={0} tone="grey" href="/notices" />
          </form>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ 子组件 */

/** 连续同类行的数量：用于楼层 / 房型的 rowSpan */
function spanFrom<T>(rows: T[], start: number, same: (a: T, b: T) => boolean) {
  let n = 1;
  for (let i = start + 1; i < rows.length; i++) {
    if (!same(rows[start], rows[i])) break;
    n += 1;
  }
  return n;
}

/** 左侧三列表头：文字 + 下拉筛选（用 details，不需要客户端 JS） */
function FilterTh({
  label,
  left,
  width,
  active,
  options,
  hrefWith,
  param,
}: {
  label: string;
  left: number;
  width: number;
  active: string | number | null;
  options: { label: string; value: string | number | null }[];
  hrefWith: (patch: Record<string, string | number | null | undefined>) => string;
  param: string;
}) {
  return (
    <th
      rowSpan={2}
      scope="col"
      className="sticky top-0 z-40 border-b border-r bg-[#f8f8f8] px-2 text-left align-middle text-[14px] font-normal text-[#555]"
      style={{ left, width, borderBottomColor: LINE, borderRightColor: LINE }}
    >
      <details className="group relative">
        <summary className="flex cursor-pointer select-none items-center gap-1">
          <span className="truncate">{label}</span>
          <span className="text-[9px] text-[#999] transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="absolute left-0 top-[16px] z-50 max-h-[280px] w-[140px] overflow-y-auto rounded border border-[#e2e2e2] bg-white py-1 text-[12px] shadow-lg">
          {options.map((o) => {
            const isActive = active === o.value;
            return (
              <Link
                key={`${param}-${o.value ?? "all"}`}
                href={hrefWith({ [param]: o.value })}
                className={`block px-2 py-1 ${
                  isActive ? "bg-[#eaf7ec] font-medium text-[#2fa84f]" : "text-[#555] hover:bg-[#f5f7fa]"
                }`}
              >
                {o.label}
              </Link>
            );
          })}
        </div>
      </details>
    </th>
  );
}

/** 底部功能条的圆角提示按钮（提交到 hintAction，写 ?msg= 弹提示） */
function HintButton({
  label,
  badge,
  hint,
  tone,
}: {
  label: string;
  badge?: number;
  hint: string;
  tone: "red" | "grey";
}) {
  return (
    <button
      type="submit"
      name="hint"
      value={hint}
      className="flex h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-[#b7dfbf] px-2 text-[12px] text-[#58bc62] hover:border-[#58bc62] hover:bg-[#f6fcf7]"
    >
      {label}
      {typeof badge === "number" && (
        <span
          className={`rounded-full px-1 text-[10px] leading-[14px] text-white ${
            tone === "red" && badge > 0 ? "bg-[#f5222d]" : "bg-[#c9c9c9]"
          }`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

/** 底部功能条的跳转胶囊（真实跳转，不再弹提示） */
function PillLink({
  label,
  badge,
  tone,
  href,
}: {
  label: string;
  badge?: number;
  tone: "red" | "grey";
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#b7dfbf] px-2 text-[12px] text-[#58bc62] hover:border-[#58bc62] hover:bg-[#f6fcf7]"
    >
      {label}
      {typeof badge === "number" && (
        <span
          className={`rounded-full px-1 text-[10px] leading-[14px] text-white ${
            tone === "red" && badge > 0 ? "bg-[#f5222d]" : "bg-[#c9c9c9]"
          }`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}
