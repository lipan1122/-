"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { ensureCancelRequestsTable } from "@/lib/cancel-requests";
/* 第 4 轮 P1-29：钟点房报价统一口径 */
import { quoteHourly } from "@/lib/hourly-rate";
import { requirePermission } from "@/lib/session";
import { changeRoomStatus } from "@/lib/room-status";
import { addDays, fmtMoney, nowIso, todayStr } from "@/lib/utils";
/*
 * 第十一轮 Bug 4：取消入住审批必须真的退押金
 *   recalcFolioBalance 统一重算账单；
 *   depositHeld        该账单还挂着的押金明细（押金负债的权威口径）；
 *   findDepositPayment 原押金收款（退款流水的 refund_of 要指向它）
 */
import { depositHeld, findDepositPayment, recalcFolioBalance } from "@/lib/folio";
/* 第十一轮 Bug 4：冲销的营业日按本店营业日切点取，与夜审 / 报表同口径 */
import { bizToday } from "@/lib/biz-date";
import { conflictMessage, findRoomConflicts } from "@/lib/room-availability";
/* 整改 P2-5：取消入住审批通过后生成的打扫任务，指派本店在岗客房人员而非写死姓名 */
import { pickHousekeepingAssignee } from "@/lib/housekeeping-assignee";

type StayRow = {
  id: number;
  room_id: number;
  guest_name: string | null;
  nights: number | null;
  rate: number | null;
  expect_check_out: string | null;
  room_no: string | null;
  status: string;
};

type FolioRow = { id: number; paid_amount: number | null };

type RoomRow = { id: number; room_no: string; status: string };

/** 取消入住审批里用到的入住单上下文 */
type StayContextRow = {
  id: number;
  stay_no: string;
  room_id: number | null;
  room_no: string | null;
  room_status: string | null;
  guest_name: string | null;
  check_in_time: string | null;
  expect_check_out: string | null;
  nights: number | null;
  rate: number | null;
  remark: string | null;
  status: string;
};

/** 取消入住申请行 */
type CancelRequestRow = {
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

/**
 * 取消入住审批表（去呼呼「取消入住审批」）。
 * 首次导入本模块时懒创建，页面查询前即可用；CREATE TABLE IF NOT EXISTS 幂等。
 */
/* 建表逻辑已抽到 src/lib/cancel-requests.ts（构建期不写库、Server Component 也能用） */


const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 取消申请状态中文名 */
function cancelStatusLabel(status: string | null) {
  if (status === "APPROVED") return "已批准";
  if (status === "REJECTED") return "已拒绝";
  return "待审批";
}

function revalidateAll() {
  revalidatePath("/inhouse");
  revalidatePath("/rooms");
  revalidatePath("/cashier");
  revalidatePath("/housekeeping");
  revalidatePath("/logs");
}

/** 统一回跳：带 msg / err 提示 */
function back(message: string, isError = false): never {
  const qs = new URLSearchParams();
  qs.set(isError ? "err" : "msg", message);
  redirect(`/inhouse?${qs.toString()}`);
}

/** 操作日志（/logs 页面可查） */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string) {
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

/** 收款单号：P + 毫秒时间戳 + 尾随随机数（与 cashier/actions.ts 的 nextPayNo 同格式） */
function nextPayNo() {
  return `P${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

/** 按账务明细重算 folios 的合计与应收余额 */

/** 房间所属房型 id（钟点房报价要按房型查 hourly_rates 配置） */
function roomTypeIdOf(roomId: number | null, hotelId: number): number | null {
  if (!roomId) return null;
  const row = get<{ room_type_id: number | null }>(
    `SELECT room_type_id FROM rooms WHERE id = ? AND hotel_id = ?`,
    [roomId, hotelId]
  );
  return row?.room_type_id ?? null;
}

/** 门市价：优先房型挂牌 base_price，其次价目表「门市价」，最后回落当前房价 */
function rackPriceOf(roomId: number | null, hotelId: number, fallback: number) {
  if (roomId) {
    const base = get<{ base_price: number | null }>(
      `SELECT rt.base_price FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
        WHERE r.id = ? AND r.hotel_id = ?`,
      [roomId, hotelId]
    )?.base_price;
    const n = Number(base ?? 0);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const plan = get<{ price: number | null }>(
    `SELECT price FROM rate_plans WHERE hotel_id = ? AND name = '门市价' ORDER BY id DESC LIMIT 1`,
    [hotelId]
  )?.price;
  const p = Number(plan ?? 0);
  if (Number.isFinite(p) && p > 0) return p;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

/** 备注追加：用「；」拼接，重复执行不会覆盖历史说明 */
function appendRemark(remark: string | null, text: string) {
  const kept = (remark ?? "").trim();
  return kept ? `${kept}；${text}` : text;
}

/** 生成 [from, to] 之间的营业日列表（含首尾，最多 cap 天） */
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
function missingRoomDates(folioId: number, from: string, to: string) {
  const posted = new Set(
    all<{ biz_date: string | null }>(
      `SELECT DISTINCT biz_date FROM folio_items
        WHERE folio_id = ? AND item_type = 'ROOM' AND biz_date IS NOT NULL`,
      [folioId]
    ).map((r) => String(r.biz_date ?? ""))
  );
  return ymdRange(from, to).filter((d) => !posted.has(d));
}

/** 在住单 + 房号 + 房态的统一查询 */
function loadStay(stayId: number, hotelId: number) {
  return get<StayContextRow>(
    `SELECT s.id, s.stay_no, s.room_id, r.room_no, r.status AS room_status,
            s.guest_name, s.check_in_time, s.expect_check_out, s.nights, s.rate, s.remark, s.status
       FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.id = ? AND s.hotel_id = ?`,
    [stayId, hotelId]
  );
}

/** 延住一晚：晚数 +1、预计离店 +1 天，并补一条房费明细 */
export async function extendStayAction(formData: FormData): Promise<void> {
  // 权限（整改 P0-3）：续住会延长在住期并补一条房费明细，属入住单办理；checkin.create 授权 admin / frontdesk。
  const user = await requirePermission("checkin.create");
  const stayId = Number(formData.get("stay_id"));
  /* P2-20：原来这三处静默 return，前台点「续住」没反应也不知道为什么，统一回显原因 */
  if (!stayId) back("续住未执行：缺少入住单参数，请刷新页面后重试", true);

  const stay = get<StayRow>(
    `SELECT s.id, s.room_id, s.guest_name, s.nights, s.rate, s.expect_check_out, s.status, r.room_no
     FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
     WHERE s.id = ? AND s.hotel_id = ?`,
    [stayId, user.hotelId]
  );
  if (!stay || stay.status !== "INHOUSE" || !stay.expect_check_out) {
    back("续住未执行：该入住单不是在住状态（已退房或已取消），请刷新列表确认", true);
  }

  const newNights = (stay.nights ?? 1) + 1;
  const oldExpectOut = stay.expect_check_out;
  const newExpectOut = todayStr(addDays(oldExpectOut, 1));
  // 新增的一晚即原预计离店日当晚，营业日期取该日
  const bizDate = oldExpectOut;
  const now = nowIso();

  /*
   * P0-5：续住必须查这段新增日期的远期占用。
   * 原实现只看当前房态，会出现「这间房明晚已经卖给别的客人，却还允许续住」，
   * 到店才发现双重占用。这里排除自己（excludeStayId），只查别的占用。
   */
  const conflicts = findRoomConflicts({
    hotelId: user.hotelId,
    roomId: stay.room_id,
    checkIn: oldExpectOut,
    checkOut: newExpectOut,
    excludeStayId: stayId,
  });
  if (conflicts.length > 0) {
    redirect(
      `/inhouse?err=${encodeURIComponent(
        `不能续住：${conflictMessage(conflicts, stay.room_no ?? undefined)}`
      )}`
    );
  }

  tx(() => {
    run(`UPDATE stays SET nights = ?, expect_check_out = ? WHERE id = ? AND hotel_id = ?`, [
      newNights,
      newExpectOut,
      stayId,
      user.hotelId,
    ]);

    const folio = get<FolioRow>(
      `SELECT id, paid_amount FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`,
      [stayId, user.hotelId]
    );
    if (!folio) {
      /* P2-20：没有账单时原来直接 return（事务回滚后页面毫无提示） */
      back("续住未执行：该入住单还没有账单，请先在电脑版收银台生成账单", true);
    }

    const rate = stay.rate ?? 0;
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folio.id, "ROOM", `房费 ${bizDate}`, 1, rate, rate, bizDate, now, user.id]
    );
    recalcFolioBalance(user.hotelId, folio.id);
  });

  revalidateAll();
}

/** 换房：原房置空脏、新房置在住净，并同步账务单房号与房态日志 */
export async function changeRoomAction(formData: FormData): Promise<void> {
  // 权限（整改 P0-3）：换房要给在住单重新分配房间并联动房态（原房 VD / 新房 OC），属分房类写操作；booking.assign_room 授权 admin / frontdesk。
  const user = await requirePermission("booking.assign_room");
  const stayId = Number(formData.get("stay_id"));
  const newRoomId = Number(formData.get("new_room_id"));
  /* P2-20：换房的每个前置校验原来都是静默 return，前台只看到「没反应」 */
  if (!stayId || !newRoomId) back("换房未执行：请选择入住单和目标房间", true);

  const stay = get<StayRow>(
    `SELECT s.id, s.room_id, s.guest_name, s.nights, s.rate, s.expect_check_out, s.status, r.room_no
     FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
     WHERE s.id = ? AND s.hotel_id = ?`,
    [stayId, user.hotelId]
  );
  if (!stay || stay.status !== "INHOUSE") {
    back("换房未执行：该入住单不是在住状态（已退房或已取消），请刷新列表确认", true);
  }
  if (stay.room_id === newRoomId) back("换房未执行：目标房间就是当前房间，请选择别的房间", true);

  const newRoom = get<RoomRow>(`SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`, [
    newRoomId,
    user.hotelId,
  ]);
  if (!newRoom) back("换房未执行：目标房间不存在或不属于本店", true);
  if (newRoom.status !== "VC" && newRoom.status !== "VD") {
    back(`换房未执行：${newRoom.room_no} 当前状态不能换入（只有空净 / 空脏房可以换房）`, true);
  }

  /*
   * P0-5：换房必须查新房在当前住客剩余日期内的占用。
   * 原实现只看房态是 VC/VD 就换，若新房这几天已经排给别人，
   * 换过去就是双重占用。排除自己（excludeStayId）后仍有冲突则拒绝。
   */
  const today = todayStr();
  const stayFrom = stay.expect_check_out && stay.expect_check_out > today ? today : today;
  const stayTo = stay.expect_check_out ?? todayStr(addDays(today, 1));
  const conflicts = findRoomConflicts({
    hotelId: user.hotelId,
    roomId: newRoom.id,
    checkIn: stayFrom,
    checkOut: stayTo > stayFrom ? stayTo : todayStr(addDays(stayFrom, 1)),
    excludeStayId: stayId,
  });
  if (conflicts.length > 0) {
    redirect(
      `/inhouse?err=${encodeURIComponent(
        `不能换房：${conflictMessage(conflicts, newRoom.room_no)}`
      )}`
    );
  }

  const oldRoom = get<RoomRow>(`SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`, [
    stay.room_id,
    user.hotelId,
  ]);
  const now = nowIso();

  tx(() => {
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId: stay.room_id,
      to: "VD",
      operator: user.realName,
      reason: `换房至 ${newRoom.room_no}（${stay.guest_name ?? "客人"}）`,
      source: { kind: "change_room", stayId },
    });
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId: newRoom.id,
      to: "OC",
      operator: user.realName,
      reason: `由 ${oldRoom?.room_no ?? stay.room_no ?? "-"} 换房入住（${stay.guest_name ?? "客人"}）`,
      source: { kind: "change_room", stayId },
    });
    run(`UPDATE stays SET room_id = ? WHERE id = ? AND hotel_id = ?`, [newRoom.id, stayId, user.hotelId]);
    run(`UPDATE folios SET room_no = ? WHERE stay_id = ? AND hotel_id = ?`, [newRoom.room_no, stayId, user.hotelId]);
    /*
     * 第 4 轮 P1-7：换房必须回写 booking_rooms
     *
     * 原来只改 stays 和 folios，预订明细里的 room_id 还指着旧房间，后果：
     *   · 次日的预抵/房态报表仍按旧房间算占用，旧房被重复安排、新房漏算
     *   · 取消入住时按 booking_rooms.room_id 释放房间，释放的是旧房（新房永远占着）
     * 这里找出该 stay 对应的明细行，把 room_id 一并更新。
     */
    run(
      `UPDATE booking_rooms SET room_id = ?
        WHERE hotel_id = ? AND stay_id = ?`,
      [newRoom.id, user.hotelId, stayId]
    );
  });

  revalidateAll();
}

/**
 * 空隔夜补过房费（单间）：
 * 扫描该在住单从入住日到今天所有缺失房费的营业日，逐日补 ROOM 明细并重算账单。
 */
export async function postRoomChargeAction(formData: FormData): Promise<void> {
  // 权限（整改 P0-3）：补过房费是向账单过账、影响应收余额，属账务类写操作；新增的 folio.post_charge 授权 admin / frontdesk / cashier。
  const user = await requirePermission("folio.post_charge");
  const stayId = Number(formData.get("stay_id"));
  if (!stayId) back("缺少入住单，补过房费未执行", true);

  const stay = loadStay(stayId, user.hotelId);
  if (!stay) back("入住单不存在", true);
  if (stay.status !== "INHOUSE") back(`房间 ${stay.room_no ?? "-"} 已不是在住状态`, true);

  const folio = get<FolioRow>(
    `SELECT id, paid_amount FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`,
    [stayId, user.hotelId]
  );
  if (!folio) back(`房间 ${stay.room_no ?? "-"} 没有账务单，无法补过房费`, true);

  const today = todayStr();
  const from = checkInDateOf(stay.check_in_time, today);
  const missing = missingRoomDates(folio.id, from, today);
  if (missing.length === 0) back(`房间 ${stay.room_no ?? "-"} 没有缺失的房费营业日`);

  const rate = Number(stay.rate ?? 0);
  const now = nowIso();

  tx(() => {
    for (const biz of missing) {
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [user.hotelId, folio.id, "ROOM", `补过房费 ${biz}`, 1, rate, rate, biz, now, user.id]
      );
    }
    recalcFolioBalance(user.hotelId, folio.id);
    writeOpLog(
      user.hotelId,
      user.realName,
      "空隔夜补过房费",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${stay.guest_name ?? "-"} · 补过 ${missing.join(
        "、"
      )} · 合计 ${fmtMoney(rate * missing.length)}`
    );
  });

  revalidateAll();
  back(`房间 ${stay.room_no ?? "-"} 已补过 ${missing.length} 天房费（${missing.join("、")}）`);
}

/**
 * 空隔夜检查结果「一键补过房费」：
 * 对所有「昨日入住且在住」的房间批量补过缺失营业日房费。
 */
export async function postAllMissingRoomChargesAction(): Promise<void> {
  // 权限（整改 P0-3）：批量补过房费同样是账务过账（一次改多张账单余额），用 folio.post_charge。
  const user = await requirePermission("folio.post_charge");
  const today = todayStr();
  const yesterday = todayStr(addDays(today, -1));

  const stays = all<{ id: number; stay_no: string; guest_name: string | null; room_no: string | null; rate: number | null; check_in_time: string | null }>(
    `SELECT s.id, s.stay_no, s.guest_name, r.room_no, s.rate, s.check_in_time
       FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND date(s.check_in_time, 'localtime') = ?
      ORDER BY r.sort, r.room_no`,
    [user.hotelId, yesterday]
  );

  const now = nowIso();
  let rooms = 0;
  let days = 0;
  const touched: string[] = [];

  for (const stay of stays) {
    const folio = get<FolioRow>(
      `SELECT id, paid_amount FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`,
      [stay.id, user.hotelId]
    );
    if (!folio) continue;

    const from = checkInDateOf(stay.check_in_time, today);
    const missing = missingRoomDates(folio.id, from, today);
    if (missing.length === 0) continue;

    const rate = Number(stay.rate ?? 0);
    tx(() => {
      for (const biz of missing) {
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [user.hotelId, folio.id, "ROOM", `补过房费 ${biz}`, 1, rate, rate, biz, now, user.id]
        );
      }
      recalcFolioBalance(user.hotelId, folio.id);
    });

    rooms += 1;
    days += missing.length;
    touched.push(`${stay.room_no ?? "-"}（${missing.length} 天）`);
  }

  if (rooms === 0) back("没有需要补过房费的在住房间");

  writeOpLog(
    user.hotelId,
    user.realName,
    "空隔夜批量补过房费",
    `共 ${rooms} 间 / ${days} 个营业日：${touched.join("、")}`
  );

  revalidateAll();
  back(`已为 ${rooms} 间房补过 ${days} 个营业日的房费：${touched.join("、")}`);
}

/**
 * 申请取消入住：对在住单发起审批申请（cancel_requests.status = PENDING）。
 */
export async function requestCancelAction(formData: FormData): Promise<void> {
  /* 懒建表：首次调用时创建 cancel_requests（构建期不再写库） */
  ensureCancelRequestsTable();
  // 权限（整改 P0-3）：发起取消入住申请会写 cancel_requests，属入住取消流程；checkin.cancel 授权 admin / frontdesk。
  const user = await requirePermission("checkin.cancel");
  const stayId = Number(formData.get("stay_id"));
  const reason = String(formData.get("reason") ?? "").trim();

  if (!stayId) back("请选择要取消的在住单", true);
  if (!reason) back("请填写取消入住的原因", true);

  const stay = loadStay(stayId, user.hotelId);
  if (!stay) back("入住单不存在", true);
  if (stay.status !== "INHOUSE") back(`房间 ${stay.room_no ?? "-"} 已不是在住状态，无需申请取消`, true);

  const pending = get<{ id: number }>(
    `SELECT id FROM cancel_requests WHERE hotel_id = ? AND stay_id = ? AND status = 'PENDING' ORDER BY id DESC LIMIT 1`,
    [user.hotelId, stayId]
  );
  if (pending) back(`房间 ${stay.room_no ?? "-"} 已有待审批的取消申请（#${pending.id}），请等待审批`, true);

  run(
    `INSERT INTO cancel_requests (hotel_id, stay_id, room_no, guest_name, reason, status, requested_by, created_at)
     VALUES (?,?,?,?,?,'PENDING',?,?)`,
    [user.hotelId, stayId, stay.room_no, stay.guest_name, reason, user.realName, nowIso()]
  );

  writeOpLog(
    user.hotelId,
    user.realName,
    "申请取消入住",
    `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${stay.guest_name ?? "-"} · 原因：${reason}`
  );

  revalidateAll();
  back(`已提交取消入住申请：${stay.room_no ?? "-"} ${stay.guest_name ?? ""}（待审批）`);
}

/**
 * 批准取消入住：执行退房
 * → 押金退还 + 未收房费冲销 → stays CHECKED_OUT / folios SETTLED / 房间 VD
 *   （并记房态日志与打扫任务）
 *
 * ── Bug 4（第十一轮）：审批通过 = 押金 500 残留 + 未收 100 静默结清 ──
 *
 * 旧实现只有两句 UPDATE：
 *     stays  → CHECKED_OUT
 *     folios → SETTLED（只有 settled_at，账上一分没动）
 * 独立检查 agent 实测（入住收押金 500、客人当天取消、审批通过）：
 *   · 押金 500 仍然留在 `stays.deposit` 与 DEPOSIT 明细里 —— 没退给客人；
 *   · 未收的 100 房费被 SETTLED 静默结清 —— 账单显示已结清，但从来没收到这笔钱；
 *   · 事后收银台也修不了：账单已 SETTLED，收款 / 入账 / 退款全部拒绝。
 *
 * ── 现在的口径：取消入住 = 整单取消（不收钱，也不留不该留的钱）──
 *   ① **押金必须退**：写一笔 kind='DEPOSIT_REFUND' 的负数 payments
 *      （refund_of 指向原押金收款）+ 冲销 DEPOSIT 明细 + stays.deposit = 0。
 *      退多少现金取三者最小值：押金明细、实收押金流水（收取−已退）、paid_amount ——
 *      任何一项为 0 都不会凭空退钱出去。
 *   ② **未收房费不能静默结清**：写**红字冲销明细**（item_type 与原消费一致、金额为负，
 *      描述「【取消入住】未收房费冲销」），把 total_amount 冲减到 0。
 *
 *      ── 为什么不用 kind='ROOM_REFUND' ──
 *      ROOM_REFUND 是「钱已经收过、现在退给客人」的负数收款流水。这笔房费**根本没收过**，
 *      记一笔负数收款等于凭空造一次现金流出（refund_of 也找不到对应收款），
 *      而且夜审的「退款冲减」会把同一笔再减一次收入 —— 重复冲减。
 *      红字明细只改账单应收 / 对应营收桶，没有现金流动，才是「未收款直接冲销」。
 *   ③ 如果已收 > 应收（预收多了），多出的部分写 kind='ROOM_REFUND' 的负数 payments
 *      真金白银退回（refund_of 指向最近一笔非押金收款），退完 paid = total。
 *   ④ ①②③ 与入住单 / 房态 / 打扫任务 / 审批状态 / 操作日志**在同一个 tx() 里**，
 *      任一步失败整体回滚 —— 不会留下「房态已退、押金还挂着」的半截账。
 *   ⑤ 账单 SETTLED 且 balance = 0；账务有差额（历史脏数据）时额外写一条日志留痕。
 */
export async function approveCancelAction(formData: FormData): Promise<void> {
  /* 懒建表：首次调用时创建 cancel_requests（构建期不再写库） */
  ensureCancelRequestsTable();
  // 权限（整改 P0-3）：审批通过会真正执行退房（stays CHECKED_OUT / folios SETTLED / 房间 VD），属入住取消审批；checkin.cancel 授权 admin / frontdesk，收银与客房被拦。
  const user = await requirePermission("checkin.cancel");
  const id = Number(formData.get("id"));
  if (!id) back("缺少申请编号，审批未执行", true);

  const req = get<CancelRequestRow>(`SELECT * FROM cancel_requests WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  if (!req) back("取消申请不存在", true);
  if (req.status !== "PENDING") back(`该申请已是「${cancelStatusLabel(req.status)}」，无需重复处理`, true);

  const stay = req.stay_id ? loadStay(req.stay_id, user.hotelId) : undefined;
  if (!stay) back("入住单不存在，无法执行退房", true);
  if (stay.status !== "INHOUSE") back(`房间 ${stay.room_no ?? "-"} 已不是在住状态，无法执行退房`, true);

  /*
   * 一张入住单可能有**多张**账单（「拆账」会生成 -B / -C 单），取消入住必须全部结清。
   * 旧实现只取最新一张（ORDER BY id DESC LIMIT 1），拆过账的单子会把押金 / 欠款
   * 留在没被选中的那张单上 —— 押金照样残留在 stays.deposit。
   */
  const folios = all<{ id: number; status: string }>(
    `SELECT id, status FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id`,
    [stay.id, user.hotelId]
  );
  /*
   * 已挂账（CHARGED）的单子不能直接取消：
   * 挂账已经把应收转到协议单位（ar_ledgers 有记录），若这里再把账单结掉，
   * 就会出现「账单已结 + AR 仍挂应收」的双份账。必须先撤挂账 / 核销。
   */
  if (folios.some((f) => f.status === "CHARGED")) {
    back(`房间 ${stay.room_no ?? "-"} 的账单已挂账到协议单位（AR 应收未结），请先在「应收」里撤销挂账后再审批取消`, true);
  }

  const now = nowIso();
  const today = todayStr();
  const bizDate = bizToday(user.hotelId);
  const operator = user.realName ?? user.username;
  /* 金额处理结果：写操作日志与成功提示用（多张账单累加） */
  let depositRefund = 0; // 真实退回的押金现金
  let waived = 0; // 未收房费冲销额
  let extraRefund = 0; // 已收 > 应收时退回的多收款
  let settleResidual = 0; // 最终仍有的差额（历史脏数据，写日志留痕）

  /**
   * 把一张账单的金额清干净（**必须在 tx() 内调用**）
   *
   * ① 押金必须退：负数 payments（kind=DEPOSIT_REFUND，refund_of 指向原押金）
   *    + 冲销 DEPOSIT 明细 + stays.deposit = 0；
   * ② 未收房费不能静默结清：按原消费类型红字冲销，把 total_amount 冲减到 0；
   * ③ 已收 > 应收：多收的钱写 ROOM_REFUND 真金白银退回；
   * ④ balance 归 0 之后账单才能 SETTLED。
   */
  const settleOneFolio = (folio: { id: number; status: string }) => {
    let folioDepositRefund = 0;
    let folioWaived = 0;
    let folioExtraRefund = 0;
    let folioResidual = 0;

    const moneyBefore = recalcFolioBalance(user.hotelId, folio.id);
    const paidBefore = round2(Math.max(0, moneyBefore.paid));

    /* ① 押金：该账单还挂着的押金明细（押金负债的权威口径） */
    const depositOnFolio = round2(Math.max(0, depositHeld(user.hotelId, folio.id)));
    /* 实收押金流水：收取 − 已退。两项取小，绝不会退出没收到过的钱 */
    const depositCashHeld = round2(
      Math.max(
        0,
        Number(
          get<{ s: number | null }>(
            `SELECT COALESCE(SUM(amount), 0) AS s FROM payments
              WHERE hotel_id = ? AND folio_id = ? AND amount > 0 AND kind = 'DEPOSIT'`,
            [user.hotelId, folio.id]
          )?.s ?? 0
        ) -
          Number(
            get<{ s: number | null }>(
              `SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM payments
                WHERE hotel_id = ? AND folio_id = ? AND amount < 0 AND kind = 'DEPOSIT_REFUND'`,
              [user.hotelId, folio.id]
            )?.s ?? 0
          )
      )
    );
    folioDepositRefund = round2(Math.min(depositOnFolio, paidBefore, depositCashHeld));

    if (folioDepositRefund > 0.005) {
      /* refund_of 指向原押金收款：押金报表按 kind 归类，退得回去、对得上 */
      const depositPay = findDepositPayment(user.hotelId, folio.id);
      run(
        `INSERT INTO payments
           (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folio.id,
          stay.id,
          nextPayNo(),
          depositPay?.method ?? "现金",
          -Math.abs(folioDepositRefund),
          bizDate,
          "取消入住退还押金",
          now,
          depositPay?.id ?? null,
          operator,
          "DEPOSIT_REFUND",
        ]
      );
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount, 0) - ? WHERE id = ? AND hotel_id = ?`, [
        folioDepositRefund,
        folio.id,
        user.hotelId,
      ]);
    }

    /*
     * 押金明细无条件清零、stays.deposit 归零：担保结束。
     * 即使现金没退成（明细与实收流水对不上，属历史脏数据），负债口径也必须归零，
     * 否则「在住押金」报表会永远虚高 —— 与退房 checkoutAction 同一处理。
     */
    const depositLines = all<{ id: number; amount: number | null }>(
      `SELECT id, amount FROM folio_items
        WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT' AND COALESCE(amount, 0) > 0.005
        ORDER BY id DESC`,
      [folio.id, user.hotelId]
    );
    for (const line of depositLines) {
      run(
        `UPDATE folio_items SET amount = 0
          WHERE id = ? AND folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
        [line.id, folio.id, user.hotelId]
      );
    }
    run(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`, [stay.id, user.hotelId]);

    /*
     * ② 未收房费：红字冲销（按原消费类型分摊，三个营收桶一起归零）
     *
     * 为什么不用 kind='ROOM_REFUND'：那是「钱已经收过、现在退给客人」的负数收款流水。
     * 这笔房费**根本没收过**，记负数收款等于凭空造一次现金流出（refund_of 也找不到
     * 对应收款），而且夜审的「退款冲减」会把同一笔再减一次收入 —— 重复冲减。
     * 红字明细只改账单应收 / 对应营收桶，没有现金流动，才是「未收款直接冲销」。
     *
     * 为什么按 item_type 分摊而不是拍一条 ADJUST：报表/夜审按 ROOM / FOOD / OTHER
     * 分桶，拍成 ADJUST 会让营收一分不减（ADJUST 不计收入），客人没住却算了房费。
     */
    const moneyAfterDeposit = recalcFolioBalance(user.hotelId, folio.id);
    if (moneyAfterDeposit.balance > 0.01) {
      folioWaived = round2(moneyAfterDeposit.balance);
      const groups = all<{ item_type: string; amount: number | null }>(
        `SELECT item_type, COALESCE(SUM(amount), 0) AS amount
           FROM folio_items
          WHERE folio_id = ? AND hotel_id = ? AND item_type IN ('ROOM', 'FOOD', 'OTHER')
          GROUP BY item_type
         HAVING COALESCE(SUM(amount), 0) > 0.005
          ORDER BY item_type`,
        [folio.id, user.hotelId]
      );
      const chargeTotal = round2(groups.reduce((s, g) => s + Number(g.amount ?? 0), 0));
      let left = folioWaived;
      groups.forEach((g, idx) => {
        if (left <= 0.005) return;
        const groupAmount = round2(Number(g.amount ?? 0));
        const proportional = chargeTotal > 0 ? round2((folioWaived * groupAmount) / chargeTotal) : 0;
        /* 最后一组兜住四舍五入的零头，保证分摊合计严等于冲销额 */
        const take =
          idx === groups.length - 1
            ? round2(Math.min(left, groupAmount))
            : round2(Math.min(left, proportional, groupAmount));
        if (take <= 0.005) return;
        run(
          `INSERT INTO folio_items
             (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            user.hotelId,
            folio.id,
            String(g.item_type),
            "【取消入住】未收房费冲销（取消入住审批通过）",
            1,
            -take,
            -take,
            bizDate,
            now,
            user.id,
          ]
        );
        left = round2(left - take);
      });
      /* 兜底：没有正向消费明细 / 分摊后仍有零头 → 用 ADJUST 把余额补齐 */
      if (left > 0.005) {
        run(
          `INSERT INTO folio_items
             (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            user.hotelId,
            folio.id,
            "ADJUST",
            "【取消入住】未收房费冲销（尾差）",
            1,
            -left,
            -left,
            bizDate,
            now,
            user.id,
          ]
        );
      }
      writeOpLog(
        user.hotelId,
        operator,
        "取消入住冲销未收款",
        `入住单 ${stay.stay_no} · 账单 #${folio.id} · 未收 ${fmtMoney(
          folioWaived
        )} 以红字冲销（不计现金、不计营收）`
      );
    }

    /*
     * ③ 已收 > 应收：多收的钱要真退回（负数收款 + refund_of 指向最近一笔非押金收款）
     *
     * 走到这里说明押金退完后仍多收，来源只可能是现金/转账预收，
     * 所以退款的 kind 是 ROOM_REFUND（营收口径的退款冲减，与退款函数一致）。
     */
    const moneyAfterWaive = recalcFolioBalance(user.hotelId, folio.id);
    if (moneyAfterWaive.balance < -0.01) {
      folioExtraRefund = round2(-moneyAfterWaive.balance);
      const originPay = get<{ id: number; method: string | null }>(
        `SELECT id, method FROM payments
          WHERE hotel_id = ? AND folio_id = ? AND amount > 0 AND COALESCE(kind, '') <> 'DEPOSIT'
          ORDER BY id DESC LIMIT 1`,
        [user.hotelId, folio.id]
      );
      run(
        `INSERT INTO payments
           (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folio.id,
          stay.id,
          nextPayNo(),
          originPay?.method ?? "现金",
          -Math.abs(folioExtraRefund),
          bizDate,
          "取消入住退还多收款",
          now,
          originPay?.id ?? null,
          operator,
          "ROOM_REFUND",
        ]
      );
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount, 0) - ? WHERE id = ? AND hotel_id = ?`, [
        folioExtraRefund,
        folio.id,
        user.hotelId,
      ]);
    }

    /* ④ 结清：balance 归 0 之后账单才能 SETTLED */
    const moneyFinal = recalcFolioBalance(user.hotelId, folio.id);
    folioResidual = round2(moneyFinal.balance);
    run(`UPDATE folios SET status = 'SETTLED', settled_at = ?, balance = 0 WHERE id = ? AND hotel_id = ?`, [
      now,
      folio.id,
      user.hotelId,
    ]);
    if (Math.abs(folioResidual) > 0.01) {
      writeOpLog(
        user.hotelId,
        operator,
        "取消入住账务差额",
        `入住单 ${stay.stay_no} · 账单 #${folio.id} · 应收 ${fmtMoney(
          moneyFinal.total
        )} · 已收 ${fmtMoney(moneyFinal.paid)} · 差额 ${fmtMoney(folioResidual)} 已按 0 结清，请核对`
      );
    }

    return {
      depositRefund: folioDepositRefund,
      waived: folioWaived,
      extraRefund: folioExtraRefund,
      residual: folioResidual,
    };
  };

  tx(() => {
    /* ---------- 一、账务：每张单都退押金 → 冲销未收款 → 退多收款 ---------- */
    for (const folio of folios) {
      if (folio.status === "SETTLED") {
        /* 审批前就已结清：金额不动，只补一个 settled_at（历史数据可能为空） */
        run(`UPDATE folios SET settled_at = COALESCE(settled_at, ?) WHERE id = ? AND hotel_id = ?`, [
          now,
          folio.id,
          user.hotelId,
        ]);
        continue;
      }
      const r = settleOneFolio(folio);
      depositRefund = round2(depositRefund + r.depositRefund);
      waived = round2(waived + r.waived);
      extraRefund = round2(extraRefund + r.extraRefund);
      settleResidual = round2(settleResidual + r.residual);
    }

    /*
     * 入住单押金无条件归零（担保结束）
     *
     * 有账单时 settleOneFolio 已经清零；这里兜住「入住单有押金但没有账单」的历史脏数据 ——
     * 与 checkoutAction 的「④ 入住单押金无条件归零」同一处理。
     * 没有账单就退不了现金，只能留痕让财务核对，绝不能继续把押金挂在在住列表上。
     */
    const stayDepositLeft = round2(
      Math.max(
        0,
        Number(
          get<{ d: number | null }>(
            `SELECT COALESCE(deposit, 0) AS d FROM stays WHERE id = ? AND hotel_id = ?`,
            [stay.id, user.hotelId]
          )?.d ?? 0
        )
      )
    );
    if (stayDepositLeft > 0.005) {
      writeOpLog(
        user.hotelId,
        operator,
        "取消入住押金冲销",
        `入住单 ${stay.stay_no} · 押金 ${fmtMoney(stayDepositLeft)} 无账单可退，已清零，请核对是否已线下退还`
      );
    }
    run(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`, [stay.id, user.hotelId]);

    /* ---------- 二、入住单 / 房态 / 打扫 / 审批状态 ---------- */
    run(`UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ? AND hotel_id = ?`, [
      today,
      stay.id,
      user.hotelId,
    ]);
    if (stay.room_id) {
      changeRoomStatus({
        hotelId: user.hotelId,
        roomId: stay.room_id,
        to: "VD",
        operator: user.realName,
        reason: `取消入住审批通过退房（${stay.guest_name ?? "客人"}）`,
        source: { kind: "checkout", stayId: stay.id, stayNo: stay.stay_no },
      });
      run(
        `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          stay.room_id,
          "打扫",
          "PENDING",
          // P2-5：派给本店在岗客房人员（无人在岗 → 「待分配」），不再写死姓名
          pickHousekeepingAssignee(user.hotelId),
          "取消入住退房打扫",
          now,
        ]
      );
    }
    run(`UPDATE cancel_requests SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ? AND hotel_id = ?`, [
      user.realName,
      now,
      id,
      user.hotelId,
    ]);
    writeOpLog(
      user.hotelId,
      user.realName,
      "取消入住审批通过",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${stay.guest_name ?? "-"} · 原因：${
        req.reason ?? "-"
      } · 已执行退房` +
        (folios.length > 0
          ? `（账单 ${folios.length} 张已全部 SETTLED · 退还押金 ${fmtMoney(depositRefund)}` +
            ` · 冲销未收款 ${fmtMoney(waived)}` +
            (extraRefund > 0.005 ? ` · 退还多收款 ${fmtMoney(extraRefund)}` : "") +
            "）"
          : "（无账单）")
    );
  });

  revalidateAll();
  const moneyNote =
    folios.length > 0
      ? `；账单已结清：退还押金 ${fmtMoney(depositRefund)}${
          waived > 0.005 ? `，冲销未收房费 ${fmtMoney(waived)}` : ""
        }${extraRefund > 0.005 ? `，退还多收款 ${fmtMoney(extraRefund)}` : ""}${
          Math.abs(settleResidual) > 0.01 ? `（差额 ${fmtMoney(settleResidual)} 已留痕，请核对）` : ""
        }`
      : "";
  back(`已批准取消入住并执行退房：${stay.room_no ?? "-"} ${stay.guest_name ?? ""}${moneyNote}`);
}

/** 拒绝取消入住：只改审批状态，不动入住单与房态 */
export async function rejectCancelAction(formData: FormData): Promise<void> {
  /* 懒建表：首次调用时创建 cancel_requests（构建期不再写库） */
  ensureCancelRequestsTable();
  // 权限（整改 P0-3）：驳回取消申请是同一审批流程的写操作，用 checkin.cancel。
  const user = await requirePermission("checkin.cancel");
  const id = Number(formData.get("id"));
  const note = String(formData.get("note") ?? "").trim();
  if (!id) back("缺少申请编号，审批未执行", true);

  const req = get<CancelRequestRow>(`SELECT * FROM cancel_requests WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  if (!req) back("取消申请不存在", true);
  if (req.status !== "PENDING") back(`该申请已是「${cancelStatusLabel(req.status)}」，无需重复处理`, true);

  const now = nowIso();
  run(`UPDATE cancel_requests SET status = 'REJECTED', approved_by = ?, approved_at = ? WHERE id = ? AND hotel_id = ?`, [
    user.realName,
    now,
    id,
    user.hotelId,
  ]);
  writeOpLog(
    user.hotelId,
    user.realName,
    "取消入住审批驳回",
    `房间 ${req.room_no ?? "-"} · ${req.guest_name ?? "-"} · 原因：${req.reason ?? "-"}${note ? ` · 审批意见：${note}` : ""}`
  );

  revalidateAll();
  back(`已拒绝取消入住申请：${req.room_no ?? "-"} ${req.guest_name ?? ""}`);
}

/**
 * 时租 / 日租转换：
 * hourly（日租转钟点房）→ nights = 0、rate = 门市价 × 15% × 小时数、remark 追加
 * daily（钟点转日租）    → nights = 晚数、rate = 门市价、预计离店 = 今天 + 晚数、remark 追加
 */
export async function convertStayModeAction(formData: FormData): Promise<void> {
  // 权限（整改 P0-3）：时租 / 日租转换会改在住单房价与晚数（计费方式变更），属改单类写操作；booking.modify 授权 admin / frontdesk。
  const user = await requirePermission("booking.modify");
  const stayId = Number(formData.get("stay_id"));
  const mode = String(formData.get("mode") ?? "").trim() === "hourly" ? "hourly" : "daily";
  if (!stayId) back("请选择在住单", true);

  const stay = loadStay(stayId, user.hotelId);
  if (!stay) back("入住单不存在", true);
  if (stay.status !== "INHOUSE") back(`房间 ${stay.room_no ?? "-"} 已不是在住状态，无法转换房型计价`, true);

  const today = todayStr();
  const oldRate = Number(stay.rate ?? 0);
  const rack = round2(rackPriceOf(stay.room_id, user.hotelId, oldRate));

  if (mode === "hourly") {
    const hours = Math.trunc(Number(formData.get("hours") ?? 0));
    if (!Number.isFinite(hours) || hours < 1 || hours > 24) back("小时数需在 1 ~ 24 之间", true);

    /* 第 4 轮 P1-29：读房型钟点房配置，不再硬编码 15%（报价口径见 lib/hourly-rate.ts） */
    const quote = quoteHourly(user.hotelId, roomTypeIdOf(stay.room_id, user.hotelId), hours, rack);
    const rate = quote.price;
    const remark = appendRemark(stay.remark, `【时租】${hours} 小时 · ${quote.note} = ${rate}`);

    tx(() => {
      run(`UPDATE stays SET nights = 0, rate = ?, expect_check_out = ?, remark = ? WHERE id = ? AND hotel_id = ?`, [
        rate,
        today,
        remark,
        stayId,
        user.hotelId,
      ]);
      writeOpLog(
        user.hotelId,
        user.realName,
        "日租转钟点房",
        `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${stay.guest_name ?? "-"} · ${hours} 小时 · 房价 ${fmtMoney(
          oldRate
        )} → ${fmtMoney(rate)}（门市价 ${fmtMoney(rack)}×15%×${hours}）`
      );
    });

    revalidateAll();
    back(
      `房间 ${stay.room_no ?? "-"} 已转为钟点房：${hours} 小时 · 房价 ${fmtMoney(rate)}（门市价 ${fmtMoney(rack)} × 15% × ${hours}）`
    );
  }

  const nights = Math.trunc(Number(formData.get("nights") ?? 0));
  if (!Number.isFinite(nights) || nights < 1 || nights > 30) back("晚数需在 1 ~ 30 之间", true);

  const rate = rack;
  const expectOut = todayStr(addDays(today, nights));
  const remark = appendRemark(stay.remark, `【日租】${nights} 晚 · 门市价 ${rate}`);

  tx(() => {
    run(`UPDATE stays SET nights = ?, rate = ?, expect_check_out = ?, remark = ? WHERE id = ? AND hotel_id = ?`, [
      nights,
      rate,
      expectOut,
      remark,
      stayId,
      user.hotelId,
    ]);
    writeOpLog(
      user.hotelId,
      user.realName,
      "钟点房转日租",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · ${stay.guest_name ?? "-"} · ${nights} 晚 · 房价 ${fmtMoney(
        oldRate
      )} → ${fmtMoney(rate)}/晚 · 预计离店 ${expectOut}`
    );
  });

  revalidateAll();
  back(`房间 ${stay.room_no ?? "-"} 已转为日租：${nights} 晚 · 房价 ${fmtMoney(rate)}/晚 · 预计离店 ${expectOut}`);
}
