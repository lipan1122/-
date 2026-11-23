/**
 * 房态统一流转服务（整改报告 P1-7）
 *
 * 目标：
 *   1. 所有房态变化走这里，不再散落 `UPDATE rooms SET status`
 *   2. 每次变化都写 room_logs（谁改的 / 从什么改成什么 / 原因 / 来源业务单）
 *   3. 校验合法流转，拦住「维修房直接改成空净」这类越级操作
 *   4. 房态变更带上来源（入住/退房/置净/维修/夜审），便于排查
 */

import { get, getDb, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";

export const ROOM_STATUS = {
  VC: "空净",
  VD: "空脏",
  OC: "在住净",
  OD: "在住脏",
  OOO: "维修",
  LOCK: "锁房",
} as const;
export type RoomStatus = keyof typeof ROOM_STATUS;

/** 允许的状态流转（from → 可到的 to） */
const ALLOWED: Record<RoomStatus, RoomStatus[]> = {
  VC: ["VD", "OC", "OD", "OOO", "LOCK"],
  VD: ["VC", "OC", "OD", "OOO", "LOCK"],
  /*
   * 住净 → 空脏：退房必经路径（客人离店房间就脏了，必须能直接转 VD）。
   * 这里漏掉 VD 会导致「退房后房态不变」——曾经的真实 bug。
   */
  OC: ["OD", "VD", "VC", "OOO", "LOCK"],
  OD: ["OC", "VD", "OOO", "LOCK"],
  OOO: ["VC", "VD"],
  LOCK: ["VC", "VD"],
};

/** 来源业务单类型 */
export type RoomChangeSource =
  | { kind: "checkin"; stayId: number; stayNo?: string }
  | { kind: "checkout"; stayId: number; stayNo?: string }
  | { kind: "change_room"; bookingId?: number; stayId?: number }
  | { kind: "housekeeping"; taskId?: number }
  | { kind: "maintenance"; note?: string }
  | { kind: "night_audit"; bizDate?: string }
  | { kind: "manual" };

function sourceText(src: RoomChangeSource): string {
  switch (src.kind) {
    case "checkin":
      return `入住 ${src.stayNo ?? "#" + src.stayId}`;
    case "checkout":
      return `退房 ${src.stayNo ?? "#" + src.stayId}`;
    case "change_room":
      return `换房${src.stayId ? " 入住单#" + src.stayId : ""}${src.bookingId ? " 预订#" + src.bookingId : ""}`;
    case "housekeeping":
      return `保洁${src.taskId ? " 任务#" + src.taskId : ""}`;
    case "maintenance":
      return `维修${src.note ? " " + src.note : ""}`;
    case "night_audit":
      return `夜审${src.bizDate ? " " + src.bizDate : ""}`;
    default:
      return "手工";
  }
}

/** 房态是否可被排房/预订占用（维修房、锁房不能排） */
export function isAssignable(status: string): boolean {
  return status === "VC" || status === "VD";
}

export type ChangeResult = { ok: true } | { ok: false; error: string };

/**
 * 写事务（不嵌套报错）
 *
 * `changeRoomStatus` 有 18 个调用点，**多处已经在外层 `tx()` 里**
 * （入住 / 退房 / 换房 / 取消入住等，至少 6 处），所以这里不能再无脑 `BEGIN IMMEDIATE`
 * —— 嵌套 BEGIN 会抛 "cannot start a transaction within a transaction"。
 *
 *   · 不在事务里 → 自己开 BEGIN IMMEDIATE（与 lib/db.ts 的 tx() 同口径：
 *     事务开头就拿 RESERVED 写锁，多进程并发时在 BEGIN 处排队，不会读到旧快照再想写）；
 *   · 已在事务里 → 直接执行，原子性由外层事务保证（语句加入外层事务，一起提交/回滚）。
 */
function withWriteTx<T>(fn: () => T): T {
  const db = getDb();
  let owned = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    owned = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/cannot start a transaction within a transaction/i.test(msg)) throw e;
    /* 已在事务内：直接用外层事务执行 */
  }
  if (!owned) return fn();

  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已结束（SQLite 可能已自动回滚），不掩盖原始异常 */
    }
    throw e;
  }
}

/**
 * 变更房态（带校验 + 日志）
 *
 * ── 并发缺陷修复（chk-perf 真子进程压测）──
 * 症状：5 个前台同时把同一间 OC 房改成 5 个不同房态 → 5 条 room_logs 全是 `OC→X`，
 *   流转链直接断掉（无法还原「谁在谁之后改的」），P2 级审计缺陷。
 *
 * 根因：`SELECT status → 校验 → UPDATE → INSERT room_logs` 三步没包事务。
 *   5 个进程各自读到同一个旧值 OC，各自写一条 `OC→X`，
 *   最后虽然 rooms.status 是最后写入者的值，但日志链已经和真实流转无关。
 *
 * 修法（两层）：
 *   ① 整个「读 → 校验 → 写 → 记日志」包进同一个写事务（BEGIN IMMEDIATE），
 *      并发请求在事务处串行化，后到的那个一定能读到前一个已提交的 status；
 *   ② UPDATE 再加一层 CAS（`WHERE id = ? AND status = <刚读到的 from>`），
 *      changes = 0 说明读完之后被别人改了 —— 重读再来（最多 3 次），
 *      确保写进 room_logs 的 from_status 一定是「这次真正改之前的那个值」。
 *      两者叠加后，日志链天然连续：每条 from = 上一条 to。
 *
 * 业务规则、返回值、日志文案均未改变。
 *
 * @param hotelId   酒店 ID
 * @param roomId    房间 ID
 * @param to        目标房态
 * @param operator  操作人（姓名）
 * @param reason    原因（可选，写日志）
 * @param source    来源业务单
 */
export function changeRoomStatus(input: {
  hotelId: number;
  roomId: number;
  to: RoomStatus;
  operator: string;
  reason?: string;
  source?: RoomChangeSource;
}): ChangeResult {
  const { hotelId, roomId, to, operator, reason, source = { kind: "manual" } } = input;

  return withWriteTx<ChangeResult>(() => {
    /*
     * CAS 重试：正常情况下第一轮就成功（事务已拿写锁）。
     * 存在第二轮的唯一场景是「上层事务是 deferred 的」—— 那时读和写之间可能有间隙，
     * 重读一次即可拿到真实的前置状态，绝不把过期值写进日志。
     */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const room = get<{ id: number; room_no: string; status: string }>(
        `SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`,
        [roomId, hotelId]
      );
      if (!room) return { ok: false, error: "房间不存在" };

      const from = room.status as RoomStatus;
      if (from === to) return { ok: true }; // 幂等：已经是目标状态

      const allowed = ALLOWED[from] ?? [];
      if (!allowed.includes(to)) {
        return {
          ok: false,
          error: `不能把 ${room.room_no} 从「${ROOM_STATUS[from] ?? from}」直接改成「${ROOM_STATUS[to] ?? to}」`,
        };
      }

      const updated = run(
        `UPDATE rooms SET status = ? WHERE id = ? AND hotel_id = ? AND status = ?`,
        [to, roomId, hotelId, from]
      );
      if (updated.changes === 0) continue; // 读完之后被别人改了：重读重试

      run(
        `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          hotelId,
          roomId,
          from,
          to,
          `${sourceText(source)}${reason ? " · " + reason : ""}`,
          operator,
          nowIso(),
        ]
      );

      return { ok: true };
    }

    /* 连续 3 次 CAS 都没抢到（只在极高的并发下出现）：明确拒绝，不写错日志 */
    return { ok: false, error: "房间房态刚被其他人修改，请刷新后重试" };
  });
}

/**
 * 按入住/退房场景推导房态
 *   入住 → OC（住净）；退房 → VD（退房后必脏，需清扫）
 */
export function statusAfterCheckin(): RoomStatus {
  return "OC";
}
export function statusAfterCheckout(): RoomStatus {
  return "VD";
}
