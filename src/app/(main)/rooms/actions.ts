"use server";

import { revalidatePath } from "next/cache";
import { all, get, getDb, run, tx } from "@/lib/db";
/* 第 4 轮 P1-29：钟点房报价（读 hourly_rates 配置） */
import { quoteHourly } from "@/lib/hourly-rate";
import { bizToday } from "@/lib/biz-date";
import { requirePermission } from "@/lib/session";
import { ROOM_STATUS as ROOM_STATUS_LIB, changeRoomStatus, type RoomStatus } from "@/lib/room-status";
import { conflictMessage, findRoomConflicts } from "@/lib/room-availability";
import { addDays, fmtMoney, nightsBetween, nowIso, todayStr } from "@/lib/utils";
import { recalcFolioBalance } from "@/lib/folio";
import { findGuestByIdentity } from "@/lib/guest-match";
/* 第八轮业务冒烟 C6：会员充值唯一记账入口（member_wallet_ledger，member_id 维度）。
 * 禁止再往 guest_name 维度的旧表 member_wallet 写单笔充值行，否则与收银台储值卡两套账。 */
import { rechargeWallet } from "@/lib/member-wallet";

/** 统一返回：{ error } 失败提示，{ ok } 成功提示（与 cashier/actions.ts 保持一致） */
type ActionState = { error?: string; ok?: string };

/** 部分结账写入的负项前缀（重算时需排除，与 cashier 页口径一致） */
const PARTIAL_SETTLE_PREFIX = "【部分结账】";

type StayRow = {
  id: number;
  stay_no: string;
  room_id: number;
  /** 来源预订（有值时校验远期占用要把它排除，否则把客人自己的预订算成冲突） */
  booking_id?: number | null;
  guest_id: number | null;
  guest_name: string | null;
  mobile: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  nights: number | null;
  rate: number | null;
  deposit: number | null;
  status: string;
  remark: string | null;
  team_name: string | null;
  rate_code: string | null;
  room_no: string | null;
  room_status: string | null;
  base_price: number | null;
};

type FolioRow = {
  id: number;
  folio_no: string;
  status: string;
  total_amount: number | null;
  paid_amount: number | null;
  balance: number | null;
};

type RoomRow = { id: number; room_no: string; status: string };

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** 取第一个非空字段，用于兼容旧表单的别名（如 guest_name / name） */
function firstStr(formData: FormData, keys: string[]): string {
  for (const key of keys) {
    const value = str(formData, key);
    if (value) return value;
  }
  return "";
}

function numOf(formData: FormData, key: string, fallback = 0): number {
  const raw = str(formData, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 收款单号：P + 毫秒时间戳 + 随机尾数，避免同毫秒重复 */
function nextPayNo(): string {
  return `P${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

/** 备注追加：以「；」连接，重复操作不会覆盖原有备注 */
function appendRemark(remark: string | null, text: string): string {
  const kept = (remark ?? "").trim();
  if (!kept) return text;
  if (kept.includes(text)) return kept;
  return `${kept}；${text}`;
}

/** 表是否存在（兼容旧库） */
function tableExists(table: string): boolean {
  return (
    (get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])?.n ??
      0) > 0
  );
}

/** 列是否存在（folios.remark 等可缺省字段） */
function columnExists(table: string, column: string): boolean {
  if (!tableExists(table)) return false;
  return all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

/* 第 4 轮 P1-29：钟点房报价统一到 src/lib/hourly-rate.ts（三个入口共用） */


/** 操作日志：入库 /logs 与报表「敏感操作」统计（op_logs 不存在时静默跳过） */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string): void {
  if (!tableExists("op_logs")) return;
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

function loadStay(stayId: number, hotelId: number): StayRow | undefined {
  return get<StayRow>(
    `SELECT s.id, s.stay_no, s.room_id, s.booking_id, s.guest_id, s.guest_name, s.mobile, s.check_in_time,
            s.expect_check_out, s.nights, s.rate, s.deposit, s.status, s.remark, s.team_name, s.rate_code,
            r.room_no, r.status AS room_status, rt.base_price
       FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE s.id = ? AND s.hotel_id = ?`,
    [stayId, hotelId]
  );
}

function loadFolioByStay(stayId: number, hotelId: number): FolioRow | undefined {
  return get<FolioRow>(
    `SELECT id, folio_no, status, total_amount, paid_amount, balance
       FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`,
    [stayId, hotelId]
  );
}

/**
 * 重算账单：total_amount = SUM(明细)，balance = total_amount - paid_amount
 * 「部分结账」写入的负项是已结记录，需从合计中排除（与 cashier/actions.ts 口径一致）。
 */

function revalidateRooms() {
  revalidatePath("/rooms");
  revalidatePath("/inhouse");
  revalidatePath("/cashier");
  revalidatePath("/logs");
}

/** 在住校验：只有 INHOUSE 的入住单才能做房内业务操作 */
function requireInhouseStay(formData: FormData, hotelId: number): { stay: StayRow } | { error: string } {
  const stayId = numOf(formData, "stay_id");
  if (!stayId) return { error: "缺少入住单号，请重新打开房间" };
  const stay = loadStay(stayId, hotelId);
  if (!stay) return { error: "入住单不存在" };
  if (stay.status !== "INHOUSE") return { error: "该入住单已退房，不能执行此操作" };
  return { stay };
}

/**
 * 查该房间是否有在住单（P0-9）
 *
 * 背景：`ALLOWED` 流转表允许 OC → VC / OOO / LOCK，手工改房态与「打扫完成」
 * 原来都不看在住单，一间住着人的房能被置成空净后重新卖出（一房两住）。
 * 这里返回在住单号与房号，调用方负责拒绝并给出可读文案。
 */
function occupiedInhouseStay(
  hotelId: number,
  roomId: number
): { stay_no: string; room_no: string } | undefined {
  return get<{ stay_no: string; room_no: string }>(
    `SELECT s.stay_no, COALESCE(r.room_no, '') AS room_no
       FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.room_id = ? AND s.status = 'INHOUSE'
      ORDER BY s.id DESC LIMIT 1`,
    [hotelId, roomId]
  );
}

/**
 * 远期占用校验（P0-6）
 *
 * 续住 / 改退房日 / 换房原来只看当前房态，不看未来日期区间，会造成超售：
 * 客人 A 住到 11-20 续住到 11-25，而这间房 11-22 已卖给 B → 22 号两人一房。
 * 统一走 `findRoomConflicts`（半开区间），并排除自己（当前在住单 + 来源预订），
 * 否则「客人自己的预订」会被当成冲突误拦。
 */
function checkStayRoomConflicts(
  stay: StayRow,
  hotelId: number,
  input: { roomId?: number; checkIn: string; checkOut: string; roomNo?: string | null }
): { error: string } | null {
  const checkIn = input.checkIn;
  const checkOut = input.checkOut;
  if (!checkIn || !checkOut || checkIn >= checkOut) return null;

  const conflicts = findRoomConflicts({
    hotelId,
    roomId: input.roomId ?? stay.room_id,
    checkIn,
    checkOut,
    excludeStayId: stay.id,
    excludeBookingId: stay.booking_id ?? undefined,
  });
  if (conflicts.length === 0) return null;
  return { error: conflictMessage(conflicts, input.roomNo ?? stay.room_no ?? undefined) };
}

export async function setRoomStatusAction(formData: FormData) {
  const user = await requirePermission("room.change_status");
  const roomId = Number(formData.get("roomId"));
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!roomId || !status) return;
  if (!(status in ROOM_STATUS_LIB)) return;

  /*
   * P0-9：在住房不能被手工置成空房状态
   *
   * `ALLOWED` 流转表允许 OC → VC / VD / OOO / LOCK，但那是给「退房」用的路径：
   * 退房流程会先把 stay 置为 CHECKED_OUT 再改房态。手工改房态没有这一步，
   * 于是客房角色（有 room.change_status）可以把住着人的房间置成空净，
   * 房间立刻回到可售池 → 一房两住。这里直接按在住单拦死。
   */
  if (status === "VC" || status === "VD") {
    const occupied = occupiedInhouseStay(user.hotelId, roomId);
    if (occupied) {
      throw new Error(
        `房间 ${occupied.room_no || roomId} 有在住客人（单号 ${occupied.stay_no}），不能改成空房状态`
      );
    }
  }

  const r = changeRoomStatus({
    hotelId: user.hotelId,
    roomId,
    to: status as RoomStatus,
    operator: user.realName,
    reason: reason || "手动修改房态",
    source: { kind: "manual" },
  });
  if (!r.ok) return;

  revalidatePath("/rooms");
  revalidatePath("/housekeeping");
}

export async function completeRoomAction(formData: FormData) {
  const user = await requirePermission("room.change_status");
  const roomId = Number(formData.get("roomId"));
  if (!roomId) return;
  const room = get<{ status: string }>(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [roomId, user.hotelId]);
  if (!room) return;

  /*
   * P0-9：服务端复核「打扫完成」的适用房态。
   * 按钮在 VC / OC 上是 disabled，但 disabled 只是前端约束 —— 直接构造请求就能绕过。
   * 只有空脏（VD → 空净）与住脏（OD → 住净）是打扫完成的合法来源：
   *   · 对住净（OC）执行会把在住房直接释放成 VC，属于本次要堵的漏洞；
   *   · 对空净（VC）执行是重复操作，没有业务意义。
   */
  if (room.status !== "VD" && room.status !== "OD") return;
  const next = room.status === "OD" ? "OC" : "VC";

  // 目标为空净时再查一次在住单：房态若被别的路径改成 VD 但人在住，同样不能释放
  if (next === "VC") {
    const occupied = occupiedInhouseStay(user.hotelId, roomId);
    if (occupied) {
      throw new Error(
        `房间 ${occupied.room_no || roomId} 有在住客人（单号 ${occupied.stay_no}），不能改成空房状态`
      );
    }
  }

  changeRoomStatus({
    hotelId: user.hotelId,
    roomId,
    to: next as RoomStatus,
    operator: user.realName,
    reason: "打扫完成",
    source: { kind: "housekeeping" },
  });
  run(`UPDATE housekeeping SET status = 'DONE', done_at = ? WHERE room_id = ? AND status = 'PENDING'`, [nowIso(), roomId]);
  revalidatePath("/rooms");
  revalidatePath("/housekeeping");
}

/* ------------------------------------------------------------------ *
 * 订单操作：续住 / 修改退房 / 换房 / 调价 / 加收 / 预收 / 同住 / 联房
 * ------------------------------------------------------------------ */

/**
 * 续住：晚数 +n、预计离店 +n 天，并按营业日补 n 条房费明细后重算账单
 * 入参：stay_id、nights（兼容 n）
 */
export async function extendStayAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5）：续住会延长在住期并补房费，属入住单办理；与 inhouse 的同名 action 同口径。
  const user = await requirePermission("checkin.create");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const rawNights = numOf(formData, "nights", numOf(formData, "n", 1));
  const nights = Math.min(30, Math.max(1, Math.round(rawNights || 1)));
  if (!stay.expect_check_out) return { error: "该入住单缺少预计离店日期，无法续住" };

  const rate = round2(stay.rate ?? 0);
  const oldExpectOut = stay.expect_check_out;
  const newExpectOut = todayStr(addDays(oldExpectOut, nights));
  const folio = loadFolioByStay(stay.id, user.hotelId);
  if (folio && folio.status === "SETTLED") return { error: "该账单已结账，无法续住入账" };

  /*
   * P0-6：续住必须查新增日期的远期占用。
   * 原来只听房态，房间明晚已经卖给别的客人也照样续住，到店才发现双重占用。
   * 排除本单与来源预订，避免把客人自己的预订算成冲突。
   */
  const conflict = checkStayRoomConflicts(stay, user.hotelId, {
    checkIn: oldExpectOut,
    checkOut: newExpectOut,
  });
  if (conflict) return { error: `不能续住：${conflict.error}` };

  const now = nowIso();

  tx(() => {
    run(`UPDATE stays SET nights = ?, expect_check_out = ? WHERE id = ? AND hotel_id = ?`, [
      (stay.nights ?? 1) + nights,
      newExpectOut,
      stay.id,
      user.hotelId,
    ]);

    if (folio) {
      // 新增的每一晚营业日依次递增：原预计离店日当晚、+1 天…
      for (let i = 0; i < nights; i++) {
        const bizDate = todayStr(addDays(oldExpectOut, i));
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [user.hotelId, folio.id, "ROOM", `房费 ${bizDate}`, 1, rate, rate, bizDate, now, user.id]
        );
      }
      recalcFolioBalance(user.hotelId, folio.id);
    }

    writeOpLog(
      user.hotelId,
      user.realName,
      "续住",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 续住 ${nights} 晚 · 预计离店 ${oldExpectOut} → ${newExpectOut}`
    );
  });

  revalidateRooms();
  return { ok: `已续住 ${nights} 晚，预计离店 ${newExpectOut}` };
}

/**
 * 修改退房：改预计离店日期并重算晚数；比原日期多出的晚数补入房费明细
 * 入参：stay_id、expect_check_out（YYYY-MM-DD）
 */
export async function updateCheckoutAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5）：改预计离店日期会重算晚数并补房费明细，属入住单办理。
  const user = await requirePermission("checkin.create");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const raw = str(formData, "expect_check_out");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: "请选择有效的预计离店日期" };
  const checkInDate = stay.check_in_time ? todayStr(new Date(stay.check_in_time)) : todayStr();
  if (raw <= checkInDate) return { error: "预计离店日期必须晚于入住日期" };

  const oldExpectOut = stay.expect_check_out;
  if (oldExpectOut === raw) return { ok: `预计离店日期未变化（${raw}）` };

  /*
   * P0-6：往后延必须查新增日期的远期占用（缩短是释放房间，不会超售，无需校验）。
   * 旧退房日缺失时从入住日算起，覆盖整段在住期。
   */
  const changedFrom = oldExpectOut && oldExpectOut > checkInDate ? oldExpectOut : checkInDate;
  if (raw > changedFrom) {
    const conflict = checkStayRoomConflicts(stay, user.hotelId, { checkIn: changedFrom, checkOut: raw });
    if (conflict) return { error: `不能修改退房日期：${conflict.error}` };
  }

  const newNights = nightsBetween(checkInDate, raw);
  const oldNights = stay.nights ?? 1;
  const extraNights = Math.max(0, newNights - oldNights);
  const rate = round2(stay.rate ?? 0);
  const folio = loadFolioByStay(stay.id, user.hotelId);
  const now = nowIso();

  tx(() => {
    run(`UPDATE stays SET expect_check_out = ?, nights = ? WHERE id = ? AND hotel_id = ?`, [
      raw,
      newNights,
      stay.id,
      user.hotelId,
    ]);

    if (folio && extraNights > 0) {
      const base = oldExpectOut ?? todayStr();
      for (let i = 0; i < extraNights; i++) {
        const bizDate = todayStr(addDays(base, i));
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [user.hotelId, folio.id, "ROOM", `房费 ${bizDate}`, 1, rate, rate, bizDate, now, user.id]
        );
      }
      recalcFolioBalance(user.hotelId, folio.id);
    }

    writeOpLog(
      user.hotelId,
      user.realName,
      "修改退房",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 预计离店 ${oldExpectOut ?? "-"} → ${raw} · ${newNights} 晚`
    );
  });

  revalidateRooms();
  return { ok: `预计离店已改为 ${raw}（${newNights} 晚）` };
}

/**
 * 换房：旧房 VD、新房 OC、stays.room_id、folios.room_no，并写两条 room_logs
 * 入参：stay_id、new_room_id（兼容 room_id）
 */
export async function changeStayRoomAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5）：换房要给在住单重新分配房间并联动房态，属分房类写操作。
  const user = await requirePermission("booking.assign_room");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const newRoomId = numOf(formData, "new_room_id", numOf(formData, "room_id"));
  if (!newRoomId) return { error: "请选择要换入的房间" };
  if (newRoomId === stay.room_id) return { error: "新房间与当前房间相同" };

  const newRoom = get<RoomRow>(`SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`, [
    newRoomId,
    user.hotelId,
  ]);
  if (!newRoom) return { error: "目标房间不存在" };
  if (newRoom.status !== "VC" && newRoom.status !== "VD") return { error: `${newRoom.room_no} 不是空房，不能换入` };

  /*
   * P0-6：换房必须查新房在客人剩余住期内的占用。
   * 原实现只看房态是 VC/VD 就换，若新房这几天已排给别的客人，换过去就是双重占用。
   * 区间取 [今天, 预计离店)，并排除本单与来源预订。
   */
  const today = todayStr();
  const stayTo =
    stay.expect_check_out && stay.expect_check_out > today ? stay.expect_check_out : todayStr(addDays(today, 1));
  const conflict = checkStayRoomConflicts(stay, user.hotelId, {
    roomId: newRoom.id,
    roomNo: newRoom.room_no,
    checkIn: today,
    checkOut: stayTo,
  });
  if (conflict) return { error: `不能换房：${conflict.error}` };

  const oldRoomNo = stay.room_no ?? "-";
  const fromStatus = stay.room_status ?? "OC";
  const now = nowIso();

  tx(() => {
    // 原房置脏 / 新房置住净，统一走房态服务（自动校验流转 + 写 room_logs）
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId: stay.room_id,
      to: "VD",
      operator: user.realName,
      reason: `换房至 ${newRoom.room_no}（${stay.guest_name ?? "客人"}）`,
      source: { kind: "change_room", stayId: stay.id },
    });
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId: newRoom.id,
      to: "OC",
      operator: user.realName,
      reason: `由 ${oldRoomNo} 换房入住（${stay.guest_name ?? "客人"}）`,
      source: { kind: "change_room", stayId: stay.id },
    });
    run(`UPDATE stays SET room_id = ? WHERE id = ? AND hotel_id = ?`, [newRoom.id, stay.id, user.hotelId]);
    run(`UPDATE folios SET room_no = ? WHERE stay_id = ? AND hotel_id = ?`, [newRoom.room_no, stay.id, user.hotelId]);

    /*
     * 第 4 轮 P1-7：换房回写 booking_rooms（否则预订明细还指旧房，
     * 报表按旧房算占用、取消入住时释放错房间）
     */
    run(`UPDATE booking_rooms SET room_id = ? WHERE hotel_id = ? AND stay_id = ?`, [
      newRoom.id,
      user.hotelId,
      stay.id,
    ]);

    writeOpLog(
      user.hotelId,
      user.realName,
      "换房",
      `入住单 ${stay.stay_no} · ${oldRoomNo} → ${newRoom.room_no} · 客人 ${stay.guest_name ?? "-"}`
    );
  });

  revalidateRooms();
  revalidatePath("/housekeeping");
  return { ok: `已换房：${oldRoomNo} → ${newRoom.room_no}` };
}

/* ------------------------------------------------------------------ *
 * 门卡 / 修改订单信息 / 修改客人信息 / 置换房
 * ------------------------------------------------------------------ */

/**
 * 制门卡：懒建表 lock_cards 后按张数批量发卡
 * 卡号 = 房号 + 毫秒时间戳后 6 位（多张时时间戳 +i，保证同批不重复）；
 * 有效期 = 今天 ~ 该入住单的预计离店日。
 * 入参：stay_id、room_no（缺省取入住单房间）、count(1-5)、type（缺省客卡）
 */
export async function makeLockCardAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：制门卡是房间凭证与门锁授权，与房态操作同级；原来只校验登录。）
  const user = await requirePermission("room.change_status");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const roomNo = firstStr(formData, ["room_no"]) || (stay.room_no ?? "");
  if (!roomNo) return { error: "该入住单没有关联房间号，无法制卡" };

  const count = Math.min(5, Math.max(1, Math.round(numOf(formData, "count", 1) || 1)));
  const cardType = firstStr(formData, ["type", "card_type"]) || "客卡";
  const validFrom = todayStr();
  const validTo =
    stay.expect_check_out && /^\d{4}-\d{2}-\d{2}$/.test(stay.expect_check_out)
      ? stay.expect_check_out
      : validFrom;

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS lock_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      card_no TEXT,
      room_no TEXT,
      type TEXT,
      status TEXT DEFAULT 'VALID',
      valid_from TEXT,
      valid_to TEXT,
      created_at TEXT
    );
  `);

  // 卡号：${room_no}${毫秒时间戳后 6 位}，多张时用 +i 的时间戳避免重复
  const base = Date.now();
  const cardNos: string[] = [];
  for (let i = 0; i < count; i++) cardNos.push(`${roomNo}${(base + i).toString().slice(-6)}`);

  tx(() => {
    for (const cardNo of cardNos) {
      run(
        `INSERT INTO lock_cards (hotel_id, card_no, room_no, type, status, valid_from, valid_to, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [user.hotelId, cardNo, roomNo, cardType, "VALID", validFrom, validTo, nowIso()]
      );
    }
    writeOpLog(
      user.hotelId,
      user.realName,
      "制门卡",
      `入住单 ${stay.stay_no} · 房间 ${roomNo} · ${cardType} × ${count} 张 · 有效期 ${validFrom} ~ ${validTo} · 卡号 ${cardNos.join("/")}`
    );
  });

  revalidateRooms();
  return { ok: `已制卡 ${count} 张` };
}

/**
 * 修改订单信息：一次提交可改「预计离店日期 / 房价 / 备注」三项
 * - 离店日期后移：重算晚数并按营业日补房费明细（复用 updateCheckoutAction 口径）
 * - 房价：更新 stays.rate 并写 op_logs「调价」（复用 adjustRateAction 口径）
 * - 备注：非空才覆盖，留空表示不修改
 * 入参：stay_id、expect_check_out、rate、remark
 */
export async function modifyStayAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：改退房日/房价/备注属入住单办理（含账务补录）；与 inhouse 同名 action 同口径。）
  const user = await requirePermission("checkin.create");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const oldRate = round2(stay.rate ?? 0);
  const oldOut = stay.expect_check_out;
  const oldNights = stay.nights ?? 1;
  const oldRemark = (stay.remark ?? "").trim();

  // —— 离店日期 ——
  const rawOut = str(formData, "expect_check_out");
  const checkInDate = stay.check_in_time ? todayStr(new Date(stay.check_in_time)) : todayStr();
  let outChanged = false;
  let newNights = oldNights;
  let extraNights = 0;
  if (rawOut && rawOut !== oldOut) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawOut)) return { error: "请选择有效的预计离店日期" };
    if (rawOut <= checkInDate) return { error: "预计离店日期必须晚于入住日期" };
    newNights = nightsBetween(checkInDate, rawOut);
    extraNights = Math.max(0, newNights - oldNights);
    outChanged = true;

    /*
     * P0-6：延长离店日期前查新增日期的远期占用（缩短是释放房间，不会超售，无需校验）。
     * 原来这里只重算晚数就落库，房间后续日期已卖给别的客人也照改，等于造超售。
     */
    const changedFrom = oldOut && oldOut > checkInDate ? oldOut : checkInDate;
    if (rawOut > changedFrom) {
      const conflict = checkStayRoomConflicts(stay, user.hotelId, { checkIn: changedFrom, checkOut: rawOut });
      if (conflict) return { error: `不能延长离店日期：${conflict.error}` };
    }
  }

  // —— 房价 ——
  const hasRate = formData.has("rate");
  const newRate = hasRate ? round2(numOf(formData, "rate", oldRate)) : oldRate;
  if (hasRate && newRate !== oldRate && !(newRate > 0)) return { error: "房价必须大于 0" };
  const rateChanged = hasRate && newRate !== oldRate;

  // —— 备注（留空 = 不修改）——
  const newRemark = str(formData, "remark");
  const remarkChanged = newRemark !== "" && newRemark !== oldRemark;

  const folio = loadFolioByStay(stay.id, user.hotelId);
  if (outChanged && extraNights > 0 && folio && folio.status === "SETTLED") {
    return { error: "该账单已结账，无法延长离店日期" };
  }

  if (!outChanged && !rateChanged && !remarkChanged) return { ok: "订单信息未变化" };

  const effectiveRate = rateChanged ? newRate : oldRate;
  const now = nowIso();
  const done: string[] = [];

  tx(() => {
    if (outChanged) {
      run(`UPDATE stays SET expect_check_out = ?, nights = ? WHERE id = ? AND hotel_id = ?`, [
        rawOut,
        newNights,
        stay.id,
        user.hotelId,
      ]);
      if (folio && extraNights > 0) {
        const base = oldOut ?? todayStr();
        for (let i = 0; i < extraNights; i++) {
          const bizDate = todayStr(addDays(base, i));
          run(
            `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [user.hotelId, folio.id, "ROOM", `房费 ${bizDate}`, 1, effectiveRate, effectiveRate, bizDate, now, user.id]
          );
        }
        recalcFolioBalance(user.hotelId, folio.id);
      }
      done.push(`预计离店 ${oldOut ?? "-"} → ${rawOut}（${newNights} 晚）`);
    }

    if (rateChanged) {
      run(`UPDATE stays SET rate = ? WHERE id = ? AND hotel_id = ?`, [newRate, stay.id, user.hotelId]);
      writeOpLog(
        user.hotelId,
        user.realName,
        "调价",
        `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 房价 ${fmtMoney(oldRate)} → ${fmtMoney(newRate)}`
      );
      done.push(`房价 ${fmtMoney(oldRate)} → ${fmtMoney(newRate)}`);
    }

    if (remarkChanged) {
      run(`UPDATE stays SET remark = ? WHERE id = ? AND hotel_id = ?`, [newRemark, stay.id, user.hotelId]);
      done.push("备注已更新");
    }

    writeOpLog(
      user.hotelId,
      user.realName,
      "修改订单信息",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${done.join(" · ")}`
    );
  });

  revalidateRooms();
  return { ok: `已保存：${done.join(" · ")}` };
}

/**
 * 修改客人信息：更新 stays 的姓名 / 手机号，并同步 guests 客史
 * （按姓名匹配到客史则更新，匹配不到则新建客史并把 guest_id 回写到入住单）
 * 入参：stay_id、guest_name、mobile、id_no
 */
export async function modifyGuestAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：改客人姓名/手机/证件会同步客史，属客人资料修改。）
  const user = await requirePermission("guest.modify");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const name = firstStr(formData, ["guest_name", "name"]);
  if (!name) return { error: "请填写客人姓名" };
  const mobile = firstStr(formData, ["mobile", "phone"]);
  const idNo = firstStr(formData, ["id_no", "id_card", "guest_id_no"]);

  /*
   * P1-9：改客史必须按「证件号 → 手机号」定位档案。
   * 原来按姓名 `WHERE name = ? LIMIT 1` 找，重名时会把别人的档案改掉。
   * 姓名只在「查不到档案、需要新建」时使用。
   */
  const existing = findGuestByIdentity(user.hotelId, { idNo, mobile });

  const oldName = stay.guest_name ?? "";
  const oldMobile = stay.mobile ?? "";
  const now = nowIso();
  let guestId = 0;

  tx(() => {
    run(`UPDATE stays SET guest_name = ?, mobile = ? WHERE id = ? AND hotel_id = ?`, [
      name,
      mobile || null,
      stay.id,
      user.hotelId,
    ]);
    if (columnExists("folios", "guest_name")) {
      run(`UPDATE folios SET guest_name = ? WHERE stay_id = ? AND hotel_id = ?`, [name, stay.id, user.hotelId]);
    }

    if (existing) {
      run(`UPDATE guests SET mobile = ?, id_no = ? WHERE id = ? AND hotel_id = ?`, [
        mobile || (existing.mobile ?? null),
        idNo || (existing.idNo ?? null),
        existing.id,
        user.hotelId,
      ]);
      guestId = existing.id;
    } else {
      guestId = run(
        `INSERT INTO guests (hotel_id, name, mobile, id_no, vip_level, blacklist, created_at) VALUES (?,?,?,?,?,?,?)`,
        [user.hotelId, name, mobile || null, idNo || null, 0, 0, now]
      ).lastInsertRowid;
    }
    run(`UPDATE stays SET guest_id = ? WHERE id = ? AND hotel_id = ?`, [guestId, stay.id, user.hotelId]);

    writeOpLog(
      user.hotelId,
      user.realName,
      "修改客人信息",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 姓名 ${oldName || "-"} → ${name} · 手机 ${
        oldMobile || "-"
      } → ${mobile || "-"}${idNo ? ` · 证件 ${idNo}` : ""} · 客史 ${existing ? "更新" : "新建"}(#${guestId})`
    );
  });

  revalidateRooms();
  return { ok: `已更新客人信息（${existing ? "客史已同步" : "已新建客史"}）` };
}

/**
 * 置换房：两个在住单的 room_id 对调（房间都在住，房态不变），
 * 同步 folios.room_no，并各写一条 room_logs 说明与哪间互换。
 * 入参：stay_id、target_stay_id
 */
export async function exchangeRoomAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：置换房改的是两间在住房的分配关系，属分房类写操作。）
  const user = await requirePermission("booking.assign_room");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const targetId = numOf(formData, "target_stay_id");
  if (!targetId) return { error: "请选择要置换的在住房间" };
  if (targetId === stay.id) return { error: "不能与当前房间自身置换" };

  const target = loadStay(targetId, user.hotelId);
  if (!target) return { error: "目标入住单不存在" };
  if (target.status !== "INHOUSE") return { error: "目标房间不是在住状态，不能置换" };

  const now = nowIso();
  const stayRoomNo = stay.room_no ?? "-";
  const targetRoomNo = target.room_no ?? "-";

  tx(() => {
    // 两个 stay 的 room_id 对调
    run(`UPDATE stays SET room_id = ? WHERE id = ? AND hotel_id = ?`, [target.room_id, stay.id, user.hotelId]);
    run(`UPDATE stays SET room_id = ? WHERE id = ? AND hotel_id = ?`, [stay.room_id, target.id, user.hotelId]);

    // 账单房号同步
    run(`UPDATE folios SET room_no = ? WHERE stay_id = ? AND hotel_id = ?`, [
      targetRoomNo,
      stay.id,
      user.hotelId,
    ]);
    run(`UPDATE folios SET room_no = ? WHERE stay_id = ? AND hotel_id = ?`, [
      stayRoomNo,
      target.id,
      user.hotelId,
    ]);

    // 两间都在住，房态不变，日志只记录置换事实
    run(
      `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        user.hotelId,
        stay.room_id,
        stay.room_status ?? "OC",
        stay.room_status ?? "OC",
        `置换房：与 ${targetRoomNo}（${target.guest_name ?? "客人"}）互换`,
        user.realName,
        now,
      ]
    );
    run(
      `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        user.hotelId,
        target.room_id,
        target.room_status ?? "OC",
        target.room_status ?? "OC",
        `置换房：与 ${stayRoomNo}（${stay.guest_name ?? "客人"}）互换`,
        user.realName,
        now,
      ]
    );

    writeOpLog(
      user.hotelId,
      user.realName,
      "置换房",
      `入住单 ${stay.stay_no}（${stay.guest_name ?? "-"}）与 ${target.stay_no}（${
        target.guest_name ?? "-"
      }）互换房间：${stayRoomNo} ⇄ ${targetRoomNo}`
    );
  });

  revalidateRooms();
  return { ok: `已置换房：${stayRoomNo} ⇄ ${targetRoomNo}` };
}

/** 调价：更新 stays.rate 并写 op_logs「调价」（报表敏感操作口径） */
export async function adjustRateAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：调价直接改 stays.rate 并计入营收，属订单金额修改。）
  const user = await requirePermission("booking.modify");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const rate = round2(numOf(formData, "rate"));
  if (!(rate > 0)) return { error: "房价必须大于 0" };
  const oldRate = round2(stay.rate ?? 0);
  if (oldRate === rate) return { ok: `房价未变化（${fmtMoney(rate)}）` };

  tx(() => {
    run(`UPDATE stays SET rate = ? WHERE id = ? AND hotel_id = ?`, [rate, stay.id, user.hotelId]);
    writeOpLog(
      user.hotelId,
      user.realName,
      "调价",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 房价 ${fmtMoney(oldRate)} → ${fmtMoney(rate)}`
    );
  });

  revalidateRooms();
  return { ok: `房价已调整为 ${fmtMoney(rate)}` };
}

/**
 * 加收房费：按营业日插一条 ROOM 明细并重算账单
 * 入参：stay_id、amount、biz_date、remark
 */
export async function addRoomFeeAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：加收房费 = 往客人账单记应收，属账单过账。）
  const user = await requirePermission("folio.post_charge");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const amount = round2(numOf(formData, "amount"));
  if (!(amount > 0)) return { error: "加收金额必须大于 0" };
  const rawDate = str(formData, "biz_date");
  const bizDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : bizToday(user.hotelId);
  const remark = str(formData, "remark");
  const description = remark ? `房费 ${bizDate}（${remark}）` : `房费 ${bizDate}`;

  const folio = loadFolioByStay(stay.id, user.hotelId);
  if (!folio) return { error: "该入住单还没有账务单，请先在收银台开单" };
  if (folio.status === "SETTLED") return { error: "该账单已结账，不能再加收房费" };

  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folio.id, "ROOM", description, 1, amount, amount, bizDate, nowIso(), user.id]
    );
    const money = recalcFolioBalance(user.hotelId, folio.id);
    writeOpLog(
      user.hotelId,
      user.realName,
      "加收消费",
      `加收房费 · 入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${fmtMoney(amount)} · 营业日 ${bizDate} · 余额 ${fmtMoney(money.balance)}`
    );
  });

  revalidateRooms();
  return { ok: `已加收房费 ${fmtMoney(amount)}` };
}

/**
 * 客房消费：插一条 OTHER 明细（如迷你吧、洗衣）并重算账单
 * 入参：stay_id、description、amount
 */
export async function addOtherChargeAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：客房消费 = 往客人账单记应收，属账单过账。）
  const user = await requirePermission("folio.post_charge");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const amount = round2(numOf(formData, "amount"));
  if (!(amount > 0)) return { error: "消费金额必须大于 0" };
  const description = str(formData, "description") || "客房消费";
  const bizDate = bizToday(user.hotelId);

  const folio = loadFolioByStay(stay.id, user.hotelId);
  if (!folio) return { error: "该入住单还没有账务单，请先在收银台开单" };
  if (folio.status === "SETTLED") return { error: "该账单已结账，不能再入账" };

  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folio.id, "OTHER", description, 1, amount, amount, bizDate, nowIso(), user.id]
    );
    const money = recalcFolioBalance(user.hotelId, folio.id);
    writeOpLog(
      user.hotelId,
      user.realName,
      "加收消费",
      `客房消费 · 入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${description} ${fmtMoney(amount)} · 余额 ${fmtMoney(money.balance)}`
    );
  });

  revalidateRooms();
  return { ok: `已入账 ${description} ${fmtMoney(amount)}` };
}

/**
 * 预收款（押金）：folio_items 记 DEPOSIT + payments 流水 + folios.paid_amount 累加
 * 入参：stay_id、amount、method（缺省现金）
 */
export async function addDepositAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：预收押金会写 payments 流水并累加 paid_amount，属收款。）
  const user = await requirePermission("cashier.receive");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const amount = round2(numOf(formData, "amount"));
  if (!(amount > 0)) return { error: "预收款金额必须大于 0" };
  const method = str(formData, "method") || "现金";
  const bizDate = bizToday(user.hotelId);

  const folio = loadFolioByStay(stay.id, user.hotelId);
  if (!folio) return { error: "该入住单还没有账务单，请先在收银台开单" };
  if (folio.status === "SETTLED") return { error: "该账单已结账，不能再收预收款" };

  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folio.id, "DEPOSIT", `预收款（押金·${method}）`, 1, amount, amount, bizDate, nowIso(), user.id]
    );
    run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folio.id, stay.id, nextPayNo(), method, amount, bizDate, "预收款（押金）", nowIso()]
    );
    run(`UPDATE folios SET paid_amount = paid_amount + ? WHERE id = ? AND hotel_id = ?`, [
      amount,
      folio.id,
      user.hotelId,
    ]);
    run(`UPDATE stays SET deposit = COALESCE(deposit, 0) + ? WHERE id = ? AND hotel_id = ?`, [amount, stay.id, user.hotelId]);
    const money = recalcFolioBalance(user.hotelId, folio.id);
    writeOpLog(
      user.hotelId,
      user.realName,
      "预收款",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 方式 ${method} · 金额 ${fmtMoney(amount)} · 余额 ${fmtMoney(money.balance)}`
    );
  });

  revalidateRooms();
  return { ok: `已收预收款 ${fmtMoney(amount)}（${method}）` };
}

/** 入团：stays.team_name 写入团队名 */
export async function joinTeamAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：入团改的是订单归属信息，属订单修改。）
  const user = await requirePermission("booking.modify");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const teamName = str(formData, "team_name");
  if (!teamName) return { error: "请填写团队名称" };

  tx(() => {
    run(`UPDATE stays SET team_name = ? WHERE id = ? AND hotel_id = ?`, [teamName, stay.id, user.hotelId]);
    writeOpLog(
      user.hotelId,
      user.realName,
      "入团",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 团队 ${stay.team_name ?? "-"} → ${teamName}`
    );
  });

  revalidateRooms();
  return { ok: `已加入团队「${teamName}」` };
}

/**
 * 同住：懒建表 stay_companions 后登记同住人
 * 入参：stay_id、name（兼容 guest_name）、mobile、id_no（兼容 guest_id_no / id_card）
 */
export async function addCompanionAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：同住登记是入住单的延伸登记，属入住办理。）
  const user = await requirePermission("checkin.create");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const name = firstStr(formData, ["name", "guest_name", "companion_name"]);
  if (!name) return { error: "请填写同住人姓名" };
  const mobile = firstStr(formData, ["mobile", "guest_mobile", "phone"]);
  const idNo = firstStr(formData, ["id_no", "guest_id_no", "id_card"]);

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS stay_companions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mobile TEXT,
      id_no TEXT,
      created_at TEXT
    );
  `);

  tx(() => {
    run(
      `INSERT INTO stay_companions (hotel_id, stay_id, name, mobile, id_no, created_at) VALUES (?,?,?,?,?,?)`,
      [user.hotelId, stay.id, name, mobile || null, idNo || null, nowIso()]
    );
    writeOpLog(
      user.hotelId,
      user.realName,
      "同住登记",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 同住人 ${name}${mobile ? ` · ${mobile}` : ""}`
    );
  });

  revalidateRooms();
  return { ok: `已登记同住人 ${name}` };
}

/**
 * 联房：懒建表 room_links，把两个在住单写入同一个 link_no；
 * 若 folios 有 remark 字段则给两间账单打上「【联房】组号」标记，没有该字段则跳过。
 * 入参：stay_id、target_stay_id
 */
export async function linkRoomsAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：联房是把两间房关联成一组，属分房/房态关联操作。）
  const user = await requirePermission("booking.assign_room");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const targetId = numOf(formData, "target_stay_id");
  if (!targetId) return { error: "请选择要联房的在住房间" };
  if (targetId === stay.id) return { error: "不能与当前房间自身联房" };

  const target = loadStay(targetId, user.hotelId);
  if (!target) return { error: "目标入住单不存在" };
  if (target.status !== "INHOUSE") return { error: "目标房间不是在住状态，不能联房" };

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS room_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      link_no TEXT NOT NULL,
      stay_id INTEGER NOT NULL,
      created_at TEXT
    );
  `);

  const links = all<{ id: number; link_no: string; stay_id: number }>(
    `SELECT id, link_no, stay_id FROM room_links WHERE hotel_id = ? AND stay_id IN (?, ?)`,
    [user.hotelId, stay.id, target.id]
  );
  const mine = links.find((l) => l.stay_id === stay.id);
  const other = links.find((l) => l.stay_id === target.id);
  const linkNo = mine?.link_no ?? other?.link_no ?? `L${Date.now().toString().slice(-8)}`;
  const now = nowIso();

  tx(() => {
    // 两边原本属于不同联房组：把目标组并入当前组
    if (mine && other && mine.link_no !== other.link_no) {
      run(`UPDATE room_links SET link_no = ? WHERE hotel_id = ? AND link_no = ?`, [linkNo, user.hotelId, other.link_no]);
    }
    if (mine) {
      if (mine.link_no !== linkNo) run(`UPDATE room_links SET link_no = ? WHERE id = ?`, [linkNo, mine.id]);
    } else {
      run(`INSERT INTO room_links (hotel_id, link_no, stay_id, created_at) VALUES (?,?,?,?)`, [
        user.hotelId,
        linkNo,
        stay.id,
        now,
      ]);
    }
    if (!other) {
      run(`INSERT INTO room_links (hotel_id, link_no, stay_id, created_at) VALUES (?,?,?,?)`, [
        user.hotelId,
        linkNo,
        target.id,
        now,
      ]);
    } else if (other.link_no !== linkNo) {
      run(`UPDATE room_links SET link_no = ? WHERE id = ? AND hotel_id = ?`, [linkNo, other.id, user.hotelId]);
    }

    // folios.remark 在该库不存在时按约定跳过标记
    if (columnExists("folios", "remark")) {
      for (const stayId of [stay.id, target.id]) {
        const folio = get<{ id: number; remark: string | null }>(
          `SELECT id, remark FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`,
          [stayId, user.hotelId]
        );
        if (!folio) continue;
        run(`UPDATE folios SET remark = ? WHERE id = ? AND hotel_id = ?`, [
          appendRemark(folio.remark, `【联房】${linkNo}`),
          folio.id,
          user.hotelId,
        ]);
      }
    }

    writeOpLog(
      user.hotelId,
      user.realName,
      "联房",
      `入住单 ${stay.stay_no}（${stay.room_no ?? "-"}）联房 ${target.stay_no}（${target.room_no ?? "-"}）· 组号 ${linkNo}`
    );
  });

  revalidateRooms();
  return { ok: `已与 ${target.room_no ?? "-"}（${target.guest_name ?? "客人"}）联房，组号 ${linkNo}` };
}

/* ------------------------------------------------------------------ *
 * 取消入住 / 钟点房 / 叫醒 / 短信 / 会员
 * ------------------------------------------------------------------ */

/**
 * 取消入住：删除 stays 及对应 folios / folio_items / payments，房间回 VC，写 room_logs
 * 账单仍有余额时拒绝（返回错误提示），避免把欠费记录直接抹掉
 */
export async function cancelCheckinAction(formData: FormData): Promise<ActionState> {
  const user = await requirePermission("checkin.cancel");
  const reason = String(formData.get("reason") ?? "").trim();
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const folios = all<{ id: number; balance: number | null }>(
    `SELECT id, balance FROM folios WHERE stay_id = ? AND hotel_id = ?`,
    [stay.id, user.hotelId]
  );
  const debt = round2(folios.reduce((sum, f) => sum + Math.max(0, Number(f.balance ?? 0)), 0));
  if (debt > 0.01) {
    return { error: `账单仍有欠款 ${fmtMoney(debt)}，请先结清后再取消入住` };
  }

  const roomId = stay.room_id;
  const fromStatus = stay.room_status ?? "OC";
  const now = nowIso();

  tx(() => {
    /*
     * 第 4 轮 P1-8：物理删除前先留完整快照
     *
     * 取消入住原本直接把 stays / folios / folio_items / payments 全删了，
     * 一旦误操作（或客人争议「我明明住过」），原始流水无法追溯，财务也没法审计。
     *
     * 这里在删除前把完整快照序列化进 op_logs（JSON），
     * 排查时用单号就能还原当时的所有数据；需要恢复也能按快照重建。
     * 不做软删除是为了避免动到项目里几十处 `status='INHOUSE'` 的判断（改错风险更高）。
     */
    const snapshot = {
      stay: get(`SELECT * FROM stays WHERE id = ? AND hotel_id = ?`, [stay.id, user.hotelId]),
      folios: all(`SELECT * FROM folios WHERE stay_id = ? AND hotel_id = ?`, [stay.id, user.hotelId]),
      items: all(
        `SELECT fi.* FROM folio_items fi
           JOIN folios f ON f.id = fi.folio_id
          WHERE f.stay_id = ? AND f.hotel_id = ?`,
        [stay.id, user.hotelId]
      ),
      payments: all(`SELECT * FROM payments WHERE stay_id = ? AND hotel_id = ?`, [stay.id, user.hotelId]),
      reason: reason || "",
      at: nowIso(),
    };
    writeOpLog(
      user.hotelId,
      user.realName,
      "取消入住-数据快照",
      JSON.stringify(snapshot)
    );

    for (const folio of folios) {
      run(`DELETE FROM folio_items WHERE folio_id = ? AND hotel_id = ?`, [folio.id, user.hotelId]);
      run(`DELETE FROM payments WHERE folio_id = ? AND hotel_id = ?`, [folio.id, user.hotelId]);
    }
    run(`DELETE FROM payments WHERE stay_id = ? AND hotel_id = ?`, [stay.id, user.hotelId]);
    run(`DELETE FROM folios WHERE stay_id = ? AND hotel_id = ?`, [stay.id, user.hotelId]);

    // 清理与该入住单相关的扩展登记（表可能尚未创建）
    for (const table of ["stay_companions", "wake_up_calls", "sms_logs", "room_links"]) {
      if (tableExists(table)) run(`DELETE FROM ${table} WHERE stay_id = ? AND hotel_id = ?`, [stay.id, user.hotelId]);
    }

    run(`DELETE FROM stays WHERE id = ? AND hotel_id = ?`, [stay.id, user.hotelId]);

    // 取消入住：房间释放回空净，走统一房态服务
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId,
      to: "VC",
      operator: user.realName,
      reason: `取消入住（${stay.guest_name ?? "客人"}）${reason ? " · " + reason : ""}`,
      source: { kind: "manual" },
    });

    writeOpLog(
      user.hotelId,
      user.realName,
      "取消入住",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 客人 ${stay.guest_name ?? "-"} · 删除账单 ${folios.length} 张`
    );
  });

  revalidateRooms();
  revalidatePath("/housekeeping");
  return { ok: `已取消入住，${stay.room_no ?? "房间"} 已置为空净房` };
}

/**
 * 转钟点房：晚数置 0、房价按设置页「钟点房收费」的房型配置计算
 * （基础收费 + 超时收费标准；未配置时回退「门市价 × 15% × 小时数」），
 * 备注追加「钟点房 N 小时」，folio 追加一条 ROOM 明细后重算
 * 入参：stay_id、hours
 */
export async function toHourlyAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：转钟点房会重算房价并补记账单，属订单金额修改。）
  const user = await requirePermission("booking.modify");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const hours = Math.min(24, Math.max(1, Math.round(numOf(formData, "hours", 2) || 2)));
  const basePrice = round2(stay.base_price ?? stay.rate ?? 0);
  if (!(basePrice > 0)) return { error: "该房型未设置门市价，无法折算钟点房价" };
  /*
   * 整改 P1-29：房价改为「按房型读 hourly_rates 配置」，
   * 房间 → 房型的映射单独查一次（stays 上没有 room_type_id）。
   */
  const roomTypeId =
    get<{ room_type_id: number | null }>(`SELECT room_type_id FROM rooms WHERE id = ? AND hotel_id = ?`, [
      stay.room_id,
      user.hotelId,
    ])?.room_type_id ?? null;
  const quote = quoteHourly(user.hotelId, roomTypeId, hours, basePrice);
  const hourlyRate = quote.price;
  const remark = appendRemark(stay.remark, `钟点房 ${hours} 小时`);
  const bizDate = bizToday(user.hotelId);

  const folio = loadFolioByStay(stay.id, user.hotelId);
  if (folio && folio.status === "SETTLED") return { error: "该账单已结账，不能转钟点房" };

  tx(() => {
    run(`UPDATE stays SET nights = 0, rate = ?, rate_code = '钟点', remark = ? WHERE id = ? AND hotel_id = ?`, [
      hourlyRate,
      remark,
      stay.id,
      user.hotelId,
    ]);

    if (folio) {
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folio.id,
          "ROOM",
          `钟点房 ${hours} 小时（${quote.note}）`,
          1,
          hourlyRate,
          hourlyRate,
          bizDate,
          nowIso(),
          user.id,
        ]
      );
      recalcFolioBalance(user.hotelId, folio.id);
    }

    writeOpLog(
      user.hotelId,
      user.realName,
      "转钟点房",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${hours} 小时 · 钟点房价 ${fmtMoney(hourlyRate)}` +
        ` · 计价 ${quote.note}${quote.configured ? "（房型钟点房配置）" : "（未配置，按默认 15%/小时）"}`
    );
  });

  revalidateRooms();
  return {
    ok: `已转钟点房 ${hours} 小时，房价 ${fmtMoney(hourlyRate)}${
      quote.configured ? "（按房型钟点房收费标准）" : "（未配置钟点房标准，按门市价 15%/小时折算）"
    }`,
  };
}

/**
 * 叫醒：懒建表 wake_up_calls 后登记叫醒服务
 * 入参：stay_id、wake_time（HH:MM 或 YYYY-MM-DD HH:MM）、note
 */
export async function setWakeUpAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：叫醒服务挂在入住单上，属入住期间服务办理（只写服务流水）。）
  const user = await requirePermission("checkin.create");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const rawTime = str(formData, "wake_time");
  if (!rawTime) return { error: "请选择叫醒时间" };
  let wakeTime = rawTime.replace("T", " ");
  if (/^\d{2}:\d{2}$/.test(wakeTime)) wakeTime = `${todayStr()} ${wakeTime}`;
  const note = str(formData, "note");

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS wake_up_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      wake_time TEXT NOT NULL,
      note TEXT,
      status TEXT DEFAULT 'PENDING',
      created_at TEXT
    );
  `);

  tx(() => {
    run(
      `INSERT INTO wake_up_calls (hotel_id, stay_id, room_no, wake_time, note, status, created_at) VALUES (?,?,?,?,?,?,?)`,
      [user.hotelId, stay.id, stay.room_no ?? "", wakeTime, note || null, "PENDING", nowIso()]
    );
    writeOpLog(
      user.hotelId,
      user.realName,
      "叫醒服务",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 叫醒时间 ${wakeTime}${note ? ` · ${note}` : ""}`
    );
  });

  revalidateRooms();
  return { ok: `已登记叫醒：${wakeTime}` };
}

/**
 * 发短信：懒建表 sms_logs 后记录一条已发送短信
 * 入参：stay_id、content
 */
export async function sendSmsAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：短信发送会读取在住客人手机号并落发送记录，属入住期间服务办理。）
  const user = await requirePermission("checkin.create");
  const loaded = requireInhouseStay(formData, user.hotelId);
  if ("error" in loaded) return { error: loaded.error };
  const stay = loaded.stay;

  const content = str(formData, "content");
  if (!content) return { error: "请填写短信内容" };
  const mobile = stay.mobile ?? "";
  if (!mobile) return { error: "该客人未登记手机号，无法发送短信" };

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      mobile TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'SENT',
      created_at TEXT
    );
  `);

  tx(() => {
    run(`INSERT INTO sms_logs (hotel_id, stay_id, mobile, content, status, created_at) VALUES (?,?,?,?,?,?)`, [
      user.hotelId,
      stay.id,
      mobile,
      content,
      "SENT",
      nowIso(),
    ]);
    writeOpLog(
      user.hotelId,
      user.realName,
      "发送短信",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · 手机 ${mobile} · 内容 ${content}`
    );
  });

  revalidateRooms();
  return { ok: `短信已记录发送（${mobile}）` };
}

/**
 * 会员充值（房态 / 远期房态面板 / 房间卡片入口）
 *
 * ── 缺陷（第八轮业务冒烟 C6）──
 * 旧实现自己懒建 `member_wallet`，然后 INSERT 一行（guest_name 维度）。
 * 而收银台「会员储值卡」支付读的是 `member_wallet_ledger`（member_id 维度，
 * 见 src/lib/member-wallet.ts 文件头「唯一记账明细」）。
 * 两套账的后果：在「房态 → 会员充值」充 1000，收银台读到的储值余额仍是 0 ——
 * 钱充进去了却花不出去。
 *
 * ── 修复 ──
 * 一律调用 lib/member-wallet.rechargeWallet()（全项目唯一记账入口）：
 *   · member_wallet_ledger 记 RECHARGE 正数流水，余额缓存由 SUM(流水) 回写；
 *   · request_id 作幂等键（表单可带；未带时按普通充值处理，与收银台页面一致）；
 *   · 本函数只保留前台口径的「单笔 5 万上限 + 原因必填」，比 service 的 999999 更严。
 *
 * ── 入参（三个既有表单的调用方式保持不变）──
 *   guest_name / name    会员姓名（远期房态面板；房间卡片右栏表单）
 *   stay_id              入住单（房间卡片行内表单只传它 → 取 stays.guest_id）
 *   member_id / guest_id 显式会员主键（优先；供后续表单/接口升级）
 *   amount / method / reason / request_id
 *
 * ── 旧表 member_wallet 的存量 ──
 * 本函数不再 CREATE TABLE、不再 INSERT、不再读取旧表（表保留，避免丢历史数据）。
 * 历史行（member_id IS NULL 的 guest_name 维度单笔充值）由
 * `scripts/migrate-all.mjs` 第 8c 段一次性搬进 ledger：
 *   · request_id = 'migrate:mw:<旧行 id>'，幂等（重复执行不会重复入账）；
 *   · 按 (hotel_id, 姓名) 反查 guests，同名取最早一条；
 *   · 找不到客史的行保留在原表、只提示人工核对（不删、不猜）。
 * 缺陷真正的根因是「迁移过又被旧入口写回旧表」，所以本次重点是停掉旧写入路径；
 * 存量按上面的迁移脚本处理，先迁移再上代码不会把钱算两遍。
 */
export async function memberRechargeAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：会员充值 = 收钱进储值（最严重的越权点：客房账号能凭空加钱）。）
  const user = await requirePermission("cashier.receive");

  let guestName = firstStr(formData, ["guest_name", "name"]);
  const rawMemberId = Math.trunc(numOf(formData, "member_id") || numOf(formData, "guest_id"));
  const rawStayId = Math.trunc(numOf(formData, "stay_id"));
  if (!guestName && rawMemberId <= 0 && rawStayId <= 0) return { error: "请填写会员姓名" };

  const amount = round2(numOf(formData, "amount"));
  if (!(amount > 0)) return { error: "充值金额必须大于 0" };
  /*
   * 第 4 轮 P2-22b：会员充值补单笔上限 + 原因必填
   *
   * 充值是「凭空往客人账上加钱」的动作，误操作或内部舞弊的后果是实打实的资金损失：
   *   · 上限：单笔 5 万元（超过的走银行转账 + 财务复核，不该在前台账上点）
   *   · 原因：必填并写进 op_logs，事后能查「谁在什么时候给谁充了多少、为什么」
   */
  if (amount > 50000) {
    return { error: `单笔充值上限 50000 元（本次 ${fmtMoney(amount)}）。大额充值请走财务复核流程。` };
  }
  const rechargeReason = str(formData, "reason").trim();
  if (!rechargeReason) {
    return { error: "请填写充值原因（如「会员卡充值」「活动充值」），会记入操作日志" };
  }
  const method = str(formData, "method") || "现金";

  /* ---------- 会员定位：显式 ID → 入住单客史 → 姓名唯一匹配 ----------
   * 三种入口必须都收敛到 guests.id：ledger.member_id 是 NOT NULL，
   * 收银台也是按 guests.id 汇总余额的。旧实现把姓名直接写进旧表，
   * 连「房间卡片行内充值」（表单只有 stay_id）都会因为没姓名而被拒。 */
  const loadGuest = (guestId: number) =>
    get<{ id: number; name: string; mobile: string | null }>(
      `SELECT id, name, mobile FROM guests WHERE id = ? AND hotel_id = ?`,
      [guestId, user.hotelId]
    );

  let memberId = 0;
  let memberLabel = guestName;

  if (rawMemberId > 0) {
    const hit = loadGuest(rawMemberId);
    if (!hit) return { error: `会员（ID ${rawMemberId}）不存在，或不属于当前酒店` };
    memberId = hit.id;
    memberLabel = hit.name;
  } else if (rawStayId > 0) {
    const stay = get<{ guest_id: number | null; guest_name: string | null }>(
      `SELECT guest_id, guest_name FROM stays WHERE id = ? AND hotel_id = ?`,
      [rawStayId, user.hotelId]
    );
    if (!stay) return { error: "入住单不存在或不属于当前酒店，无法确定充值会员" };
    const hit = stay.guest_id ? loadGuest(stay.guest_id) : undefined;
    if (hit) {
      memberId = hit.id;
      memberLabel = hit.name;
    } else if (stay.guest_name) {
      guestName = stay.guest_name;
    } else {
      return { error: "该入住单没有关联客史，请先补登客人资料再充值" };
    }
  }

  if (memberId <= 0) {
    if (!guestName) return { error: "该入住单没有关联客史，请先补登客人资料再充值" };
    /*
     * 姓名匹配必须唯一：同名客人充给谁无法判断，不能像旧表那样按姓名合并成一笔。
     * 多条同名的处理是「拒绝 + 指路」，不是猜最早一条 —— 充错人的钱很难追回。
     */
    const hits = all<{ id: number; name: string; mobile: string | null }>(
      `SELECT id, name, mobile FROM guests WHERE hotel_id = ? AND name = ? ORDER BY id`,
      [user.hotelId, guestName]
    );
    if (hits.length === 0) {
      return {
        error: `未找到名为「${guestName}」的客史，无法充值：请先在入住/会员管理里建档，或到收银台「会员储值」页按会员办理`,
      };
    }
    if (hits.length > 1) {
      const candidates = hits
        .slice(0, 3)
        .map((h) => `${h.name}${h.mobile ? `（尾号 ${h.mobile.slice(-4)}）` : ""}`)
        .join("、");
      return {
        error: `本店有 ${hits.length} 位同名会员「${guestName}」，无法确定充值对象（${candidates}…）：请到收银台「会员储值」页按手机号选择会员`,
      };
    }
    memberId = hits[0].id;
    memberLabel = hits[0].name;
  }

  /* ---------- 记账：唯一入口 + 同一事务写操作日志 ---------- */
  const requestId = str(formData, "request_id") || undefined;
  const result = tx(() => {
    /* rechargeWallet 内部用 SAVEPOINT，可在外层 tx 里安全调用（见 member-wallet.ts「事务」段） */
    const written = rechargeWallet(user.hotelId, memberId, amount, {
      operator: user.realName,
      remark: `充值方式：${method} · 原因：${rechargeReason}（房态会员充值）`,
      refType: "rooms.memberRecharge",
      requestId,
    });
    if ("error" in written) return written;
    writeOpLog(
      user.hotelId,
      user.realName,
      "会员充值",
      `会员 ${memberLabel}（ID ${memberId}）· 方式 ${method} · 金额 ${fmtMoney(amount)} · 原因：${rechargeReason} · 储值余额 ${fmtMoney(written.balance)}`
    );
    return written;
  });
  if ("error" in result) return { error: result.error };

  revalidateRooms();
  return { ok: `已为 ${memberLabel} 充值 ${fmtMoney(amount)}（${method}），储值余额 ${fmtMoney(result.balance)}` };
}

/**
 * 会员注册：guests.vip_level 置 1；客史不存在则先建客史
 * 入参：guest_name（兼容 name / mobile）
 */
export async function registerMemberAction(formData: FormData): Promise<ActionState> {
  // 权限（P0-5：开会员会新建/升级客史（vip_level），属客人资料修改。）
  const user = await requirePermission("guest.modify");

  const guestName = firstStr(formData, ["guest_name", "name"]);
  if (!guestName) return { error: "请填写会员姓名" };
  const mobile = firstStr(formData, ["mobile", "phone"]);
  const idNo = firstStr(formData, ["id_no", "id_card"]);

  /*
   * P1-9：开通会员必须按「证件号 → 手机号」定位客史，不能按姓名。
   * 按姓名匹配时，馆里有两个「张伟」就可能把会员等级开到别人头上。
   */
  const hit = findGuestByIdentity(user.hotelId, { idNo, mobile });
  const guest = hit ? { id: hit.id, vip_level: hit.vipLevel } : undefined;

  tx(() => {
    if (guest) {
      run(`UPDATE guests SET vip_level = 1${mobile ? ", mobile = ?" : ""} WHERE id = ? AND hotel_id = ?`, [
        ...(mobile ? [mobile] : []),
        guest.id,
        user.hotelId,
      ]);
      writeOpLog(
        user.hotelId,
        user.realName,
        "会员注册",
        `客史 ${guestName} · 会员等级 ${guest.vip_level ?? 0} → 1`
      );
    } else {
      run(`INSERT INTO guests (hotel_id, name, mobile, vip_level, created_at) VALUES (?,?,?,?,?)`, [
        user.hotelId,
        guestName,
        mobile || null,
        1,
        nowIso(),
      ]);
      writeOpLog(user.hotelId, user.realName, "会员注册", `新建客史 ${guestName} · 会员等级 1`);
    }
  });

  revalidateRooms();
  return { ok: guest ? `${guestName} 已升级为会员（VIP 1）` : `已新建客史并注册会员：${guestName}` };
}
