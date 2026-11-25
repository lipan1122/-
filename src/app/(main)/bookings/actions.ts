"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { conflictMessage, findRoomConflicts } from "@/lib/room-availability";
import { isAssignable } from "@/lib/room-status";
import { nightsBetween, nowIso } from "@/lib/utils";
/* 预订号生成（按酒店隔离，多租户修复：原来这里自己算全局 MAX(id)，两家店会撞号） */
import { nextBookingNo } from "@/lib/channels/booking-no";
/*
 * 渠道库存同步（整改 4.1 的缺口补线，见 src/lib/channels/stock-trigger.ts 文件头）
 *
 * 为什么预订侧必须调：取消 / 排房都会改变「这间房还能不能卖」，
 * 而渠道（携程 / 美团 / 飞猪 / 抖音）那边**只认推送**，本地改了它不会自己知道。
 * 不推的后果：客人已经取消，携程上那间房仍然挂着卖；反之排房后本地满房了，
 * 渠道还在放量 → 超卖。这里只落一条「待同步」队列记录（不实时打渠道接口，
 * 四家 OTA 都有频控），由 stock-queue 的 drainStockQueue 合并后推送。
 *
 * 位置约束：**必须放在 tx() 提交之后**。事务里调用的话，一旦后面回滚，
 * 队列里已经记了「库存变了」，消费者就会照着一个不存在的状态去推渠道，
 * 反而制造渠道与本地不一致。
 */
import { markStockDirty } from "@/lib/channels/stock-trigger";
/*
 * 房型库存「按晚」口径 —— PC 建单与小程序下单的**唯一实现**（src/lib/room-stock-nightly.ts）
 *
 * 这里原来自己写着 physicalCapOfType / eachNight / occupiedByNight / stockError 四个本地函数，
 * 小程序 api/mini/_shared.ts 的 loadAvailability 又照着抄了一份旧口径，结果两边漂移：
 * 小程序那份只扣 OOO 不扣 LOCK（锁房被卖）、按区间重叠计数（跨日订单被误拒）。
 * 抽成 lib 之后口径只有一份，任何改动两边同时生效；本文件只保留「按房型汇总要订几间」
 * 这一层页面语义（见下方 createBookingInTx 里的 needByType）。
 */
import { stockShortage, type StockDb } from "@/lib/room-stock-nightly";

/**
 * 交给库存 lib 的查询句柄（同一个连接、同一个事务快照）
 *
 * 为什么不在 lib 里直接 import @/lib/db：lib 要被 PC action、小程序 route、
 * 测试脚本共用，句柄由调用方注入才能保证「算库存」和「写订单」看到的是同一份数据
 * （PC 端是在 `BEGIN IMMEDIATE` 事务内复查的，换成另一个连接就失去意义了）。
 */
const STOCK_DB: StockDb = { all, get };

/** 读取字符串字段并去除首尾空格，非字符串一律视为空串 */
function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 读取可空外键：空串 / 0 / 非法值返回 null */
function intOrNull(value: FormDataEntryValue | null): number | null {
  const n = Number(str(value));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** 任意值转整数，非法值返回 0 */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 任意值转数字，非法值返回 0 */
function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 金额四舍五入到分（避免浮点尾差写进库） */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 房费总额口径（整改 P1-12：钟点房价格语义混用）
 *
 * 为什么需要单独一个函数：
 *   bookings.rate 在不同业态下语义不同，直接「rate × nights」必错 ——
 *     · 日租：rate = 每晚房价，总额 = rate × 晚数 × 间数；
 *     · 钟点：代码里以 nights = 0 + rate = 钟点总价 表示（转钟点房时把总价写进 rate），
 *             rate × 0 = 0（金额凭空消失），rate × max(1,nights) 又会把钟点房当整晚卖（翻倍）。
 *   所以总额统一由本函数算一次写进 bookings.total_price，
 *   所有读取方（列表 / 报表 / 账单）优先用 total_price，没有才回退到 rate × nights × room_count。
 */
function bookingAmount(rate: number, nights: number, roomCount: number): number {
  const count = Math.max(1, Math.trunc(roomCount) || 1);
  const n = Math.max(0, Math.trunc(nights) || 0);
  // n = 0 即钟点房：rate 本身就是总价，不能再乘晚数
  return round2(rate * (n > 0 ? n : 1) * count);
}

/**
 * 把整单定金按各房型明细的房费占比拆到每一行预订（整改 P1-7：定金落库）
 *
 * 为什么要拆：一个新建预订表单可以填多个房型，每行落一条 bookings，
 *   但定金是整单收的一笔钱，而库表只有行级的 bookings.deposit。
 *   按房费占比拆分后，各行定金之和恰好等于前台实收定金，
 *   入住时逐单转押金既不会凭空多出钱，也不会少掉钱。
 * 尾差：最后一行取「总额 − 前面各行之和」，保证合计精确等于 total（不会被四舍五入吃掉几分钱）。
 */
function splitDeposit(total: number, weights: number[], index: number): number {
  if (total <= 0) return 0;
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return index === 0 ? round2(total) : 0;
  if (index >= weights.length - 1) {
    let acc = 0;
    for (let i = 0; i < weights.length - 1; i += 1) acc += round2((total * weights[i]) / sum);
    return round2(total - acc);
  }
  return round2((total * weights[index]) / sum);
}

/** 一条房型明细：每个预订间数 > 0 的房型对应一条预订 */
type BookingLine = {
  roomTypeId: number;
  roomCount: number;
  rate: number;
  breakfast: number;
  roomId: number | null;
};

/** 解析前端提交的房型明细 JSON（隐藏域 lines），任何非法项一律丢弃 */
function parseLines(raw: string): BookingLine[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const lines: BookingLine[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const roomTypeId = toInt(row.room_type_id);
    if (roomTypeId <= 0) continue;
    lines.push({
      roomTypeId,
      roomCount: Math.min(99, Math.max(1, toInt(row.room_count))),
      rate: Math.max(0, toNum(row.rate)),
      breakfast: Math.min(9, Math.max(0, toInt(row.breakfast))),
      roomId: toInt(row.room_id) > 0 ? toInt(row.room_id) : null,
    });
  }
  return lines;
}

function revalidateBookingPaths() {
  revalidatePath("/bookings");
  revalidatePath("/rooms");
  revalidatePath("/dashboard");
}

/*
 * 建单业务校验失败（并发建单修复）
 *
 * 事务里不能直接 `redirect()`：Next 的 redirect 是靠抛 NEXT_REDIRECT 实现的，
 * 抛在 tx 里会被 tx 的 catch 当成普通异常回滚，外层再翻译成「建单失败：NEXT_REDIRECT」。
 * 所以事务内一律抛这个专用错误，由 createBookingAction 外层的 catch 统一转成
 * 「回新建页 + 明确文案」—— 与 assignRoomAction 的 AssignRoomError 同一种写法。
 */
class BookingCreateError extends Error {}

/**
 * 新建预订：一个房型一条记录，room_count 为该行预订间数。
 * 入住日期必须早于离店日期；排了具体房间则直接置为已确认，否则待排房。
 */
export async function createBookingAction(formData: FormData) {
  // 权限（整改 P0-3）：新建预订会直接落库订单并占用房间，属建单类写操作；booking.create 授权 admin / frontdesk。
  const user = await requirePermission("booking.create");
  const hotelId = user.hotelId;

  const bookingType = str(formData.get("booking_type")) === "team" ? "team" : "guest";
  const teamName = str(formData.get("team_name"));
  const guestName = str(formData.get("guest_name"));
  const mobile = str(formData.get("mobile"));
  const companyName = str(formData.get("company_name"));
  const memberCard = str(formData.get("member_card"));
  const checkInDate = str(formData.get("check_in_date"));
  const checkOutDate = str(formData.get("check_out_date"));
  const arrivalTime = str(formData.get("arrival_time")) || "12:00";
  const departureTime = str(formData.get("departure_time")) || "12:00";
  const rateCode = str(formData.get("rate_code")) || "门市价";
  const salesman = str(formData.get("salesman"));
  const packageCode = str(formData.get("package_code"));
  const invoiceParty = str(formData.get("invoice_party")) || "酒店";
  const retainTime = str(formData.get("retain_time"));
  const payType = str(formData.get("pay_type")) || "到店付款";
  const channelOrderNo = str(formData.get("channel_order_no"));
  const remark = str(formData.get("remark"));
  const channelId = intOrNull(formData.get("channel_id"));
  /*
   * 预订定金（整改 P1-7：定金未落库）
   * 之前完全不读表单里的 deposit，bookings.deposit 永远是 0，
   * 入住时也就没有押金可转（前台白收一笔钱、账上查无此款）。
   * 这里先按「空 = 0」解析，真正的金额上限校验放到算出房费总额之后做。
   */
  const depositRaw = str(formData.get("deposit")) === "" ? 0 : Number(str(formData.get("deposit")));

  /*
   * P2-1：校验失败必须给明确文案，不能静默 return。
   * 静默 return 时前端只看到「页面刷新了但什么都没发生」，
   * 前台不知道是网络问题还是自己填错了，只能反复点提交。
   */
  const backNew = (msg: string) =>
    redirect(`/bookings/new?type=${bookingType}&err=${encodeURIComponent(msg)}`);

  if (!guestName) backNew("请填写客人姓名");
  if (!checkInDate) backNew("请选择到店日期");
  if (!checkOutDate) backNew("请选择离店日期");
  if (bookingType === "team" && !teamName) backNew("团队预订必须填写团队名称");
  if (checkOutDate <= checkInDate) backNew("离店日期必须晚于到店日期");

  // 定金必须是 0 或正数；非法值不静默丢弃，回新建页给出明确文案
  if (!Number.isFinite(depositRaw) || depositRaw < 0) {
    backNew("定金必须是 0 或正数");
  }

  const lines = parseLines(str(formData.get("lines")));
  if (lines.length === 0) backNew("请至少添加一行房型明细");

  // 会员类型由服务端复核 guests 表，避免前端伪造
  let memberType = "";
  if (memberCard) {
    const guest = get<{ vip_level: number }>(
      `SELECT vip_level FROM guests
       WHERE hotel_id = ? AND (mobile = ? OR id_no = ?)
       ORDER BY id LIMIT 1`,
      [hotelId, memberCard, memberCard]
    );
    memberType = guest ? (guest.vip_level > 0 ? `VIP${guest.vip_level}` : "普通") : "非会员";
  }

  // 协议客户按名称匹配 companies 表，匹配不到则留空
  let companyId: number | null = null;
  if (companyName) {
    const company = get<{ id: number }>(
      `SELECT id FROM companies WHERE hotel_id = ? AND name = ?`,
      [hotelId, companyName]
    );
    companyId = company?.id ?? null;
  }

  // 逐行校验房型归属本酒店，房间必须属于该房型且不能重复占用
  const validLines: BookingLine[] = [];
  const usedRoomIds = new Set<number>();
  for (const line of lines) {
    const roomType = get<{ id: number }>(
      `SELECT id FROM room_types WHERE id = ? AND hotel_id = ?`,
      [line.roomTypeId, hotelId]
    );
    if (!roomType) continue;

    let roomId: number | null = null;
    if (line.roomId && !usedRoomIds.has(line.roomId)) {
      const room = get<{ id: number; room_no: string; status: string }>(
        `SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ? AND room_type_id = ?`,
        [line.roomId, hotelId, line.roomTypeId]
      );
      if (room) {
        /*
         * P0-8：指定房间建单必须查区间占用（P0-7 同一套 findRoomConflicts）。
         * 原来只看「房间存在 + 房型匹配」，唯一索引 idx_booking_rooms_occupied
         * 只能挡住起止日期完全相同的重叠，日期不同但区间交叠照样能排出去。
         */
        const conflicts = findRoomConflicts({
          hotelId,
          roomId: room.id,
          checkIn: checkInDate,
          checkOut: checkOutDate,
        });
        if (conflicts.length > 0) {
          backNew(`不能指定该房间：${conflictMessage(conflicts, room.room_no)}`);
        }
        // 维修 / 锁房不可售，不能直接排给预订（与排房 action 的 VC/VD 口径一致）
        if (!isAssignable(room.status)) {
          backNew(`房间 ${room.room_no} 当前不可排房（状态 ${room.status}），请先恢复为空净/空脏`);
        }
        roomId = room.id;
        usedRoomIds.add(room.id);
      }
    }
    validLines.push({ ...line, roomId });
  }
  /* P2-1：房型校验全部失败时也要说清楚哪一项不对，而不是静默回退 */
  if (validLines.length === 0) {
    backNew("所选房型无效，请重新选择房型（可能已被停用）");
  }

  const nights = nightsBetween(checkInDate, checkOutDate);
  const now = nowIso();

  /*
   * 房费总额与定金上限校验（整改 P1-7 + P1-12）
   *
   * 逐行算总额（钟点语义的 nights = 0 由 bookingAmount 处理，总额不会变成 0），
   * 全部行相加得到整单房费，定金不得超过它 —— 超了直接回新建页报错，不静默截断。
   * 为什么按总额而不是逐行比：一个表单可以有多行房型，定金是整单收的一笔钱。
   */
  const lineTotals = validLines.map((line) => bookingAmount(line.rate, nights, line.roomCount));
  const totalCharge = round2(lineTotals.reduce((sum, v) => sum + v, 0));
  const depositTotal = round2(depositRaw);
  if (depositTotal > totalCharge) {
    redirect(
      `/bookings/new?type=${bookingType}&err=${encodeURIComponent(
        `定金 ¥${depositTotal.toFixed(2)} 不能超过订单房费总额 ¥${totalCharge.toFixed(2)}`
      )}`
    );
  }

  // 离店时间没有独立字段，非默认值补进备注，避免信息丢失
  const remarkParts: string[] = [];
  if (departureTime !== "12:00") remarkParts.push(`预计离店时间 ${departureTime}`);
  if (remark) remarkParts.push(remark);
  const finalRemark = remarkParts.length > 0 ? remarkParts.join("；") : null;

  // 预订号：复用 lib/channels/booking-no.ts 的 nextBookingNo(hotelId)
  //
  // 原来这里自己算 `BK${MAX(id)+1+3000}` —— 那是**全局** MAX(id)，
  // 多店并行建单时两家店会算出同一个号，撞上 bookings.booking_no 的唯一约束
  // （表上至今保留着列级 UNIQUE，见下方说明）。
  //
  // lib 里早就有按酒店隔离的 nextBookingNo()（查 hotel_id + booking_no、
  // 撞号时加随机后缀），但建单没调用它。这里改成调用它。
  //
  // ⚠️ 遗留：bookings/stays/folios 三张表仍是**列级 UNIQUE**（全局唯一），
  // 与 idx_bookings_no(hotel_id, booking_no) 的组合唯一并存。
  // 这导致「两个酒店有同号预订」在多店部署下仍会失败（只是概率被随机后缀压低）。
  // 彻底解决需要重建表去掉列级 UNIQUE（SQLite 不支持 DROP CONSTRAINT，
  // 要走「建新表→复制→删旧表→改名→重建索引」12 步流程），风险较高，
  // 已记录在 docs/已知问题.md，单店部署不受影响。
  let remainingLast = 0;

  /** 建单的事务体（抽成函数只为让下面的 catch 兜住事务内的校验异常与唯一索引冲突） */
  const createBookingInTx = () => {
    /*
     * 事务内复查「指定房间」的区间占用（chk-perf 并发建单 4/5 抛 UNIQUE 的根因修复）
     *
     * 症状：5 个前台同时给同一间房建同一区间的预订 → 1 个成功、4 个抛
     *   `UNIQUE constraint failed: booking_rooms.room_id, check_in_date, check_out_date`
     *   → 生产环境 500，前台不知道订单到底建没建。
     *
     * 根因：唯一索引上面那句 `findRoomConflicts()` 在**事务外**，并发下五个请求
     *   互相看不见对方刚提交的明细，全部通过校验；唯一索引兜底后又没有翻译成人话。
     *
     * 修法：事务内再查一遍。`tx()` 是 BEGIN IMMEDIATE，事务开头就拿到写锁，
     *   后到的事务在 BEGIN 处排队，进入后一定看得见前一个已提交的 booking_rooms 明细，
     *   所以这一遍才是权威的 —— 命中就抛 BookingCreateError，整单回滚，
     *   由外层 catch 转成「不能指定该房间：房间 XXX 已被占用…」，不再是 500。
     *
     * 事务外那一遍保留：快速失败 / 减少白开事务，但不再作为判定依据。
     * ⚠ 唯一索引仍是最后一道兜底（见下面的 UNIQUE 翻译），不能删。
     */
    for (const line of validLines) {
      if (!line.roomId) continue;
      const conflicts = findRoomConflicts({
        hotelId,
        roomId: line.roomId,
        checkIn: checkInDate,
        checkOut: checkOutDate,
      });
      if (conflicts.length > 0) {
        const room = get<{ room_no: string }>(
          `SELECT room_no FROM rooms WHERE id = ? AND hotel_id = ?`,
          [line.roomId, hotelId]
        );
        throw new BookingCreateError(`不能指定该房间：${conflictMessage(conflicts, room?.room_no)}`);
      }
    }

    /*
     * 事务内复查房型库存（按晚 · P0-1）
     *
     * 口径全部在 src/lib/room-stock-nightly.ts（与小程序下单同一份实现）：
     *   物理可售 = 房间数 − OOO − LOCK
     *   该晚占用 = 在住单 + PENDING/CONFIRMED 明细（一行一间）+ 无明细旧主单 room_count
     *   判定     = 入住区间内**最低**的剩余 ≥ 本单要的间数
     *
     * 库存这一遍必须在 `BEGIN IMMEDIATE` 拿到写锁之后算：并发下两个请求可能
     * 都看到「还剩 1 间」然后都写成功 —— 唯一索引只能挡住「同一间房同一区间」，
     * 挡不住「只订房型」这种没有具体房间的重复售卖。
     * 这一遍看到的是权威快照；任一行超量就整单拒绝（要么全成功、要么全回滚）。
     *
     * 本文件只剩业务层语义：一个表单里同房型可能有多行，库存要按合并后的间数判，
     * 所以先聚合成 needByType 再逐房型问 lib（文案由 lib 统一给，指出最低的那一晚）。
     */
    {
      const needByType = new Map<number, number>();
      for (const line of validLines) {
        needByType.set(line.roomTypeId, (needByType.get(line.roomTypeId) ?? 0) + Math.max(1, line.roomCount));
      }
      for (const [typeId, need] of needByType) {
        const name =
          get<{ name: string }>(`SELECT name FROM room_types WHERE id = ? AND hotel_id = ?`, [typeId, hotelId])?.name ??
          "该房型";
        const stockMsg = stockShortage(STOCK_DB, hotelId, typeId, name, checkInDate, checkOutDate, need);
        if (stockMsg) throw new Error(stockMsg);
      }
    }

    for (const [lineIndex, line] of validLines.entries()) {
      const bookingNo = nextBookingNo(user.hotelId);
      // 整单定金按房费占比拆到本行；最后一行吸收尾差，保证各行之和 = 实收定金
      const lineDeposit = splitDeposit(depositTotal, lineTotals, lineIndex);
      const inserted = run(
        `INSERT INTO bookings (
           hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
           channel_id, company_id, check_in_date, check_out_date, nights,
           room_count, guest_count, rate, deposit, total_price, status, remark,
           booking_type, team_name, member_card, member_type, arrival_time,
           rate_code, salesman, package_code, invoice_party, retain_time,
           pay_type, breakfast, channel_order_no, created_by, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          bookingNo,
          guestName,
          mobile || null,
          line.roomTypeId,
          line.roomId,
          channelId,
          companyId,
          checkInDate,
          checkOutDate,
          nights,
          line.roomCount,
          1,
          line.rate,
          lineDeposit,
          lineTotals[lineIndex],
          line.roomId ? "CONFIRMED" : "PENDING",
          finalRemark,
          bookingType,
          teamName || null,
          memberCard || null,
          memberType || null,
          arrivalTime,
          rateCode,
          salesman || null,
          packageCode || null,
          invoiceParty,
          retainTime || null,
          payType,
          line.breakfast,
          channelOrderNo || null,
          user.id,
          now,
          now,
        ]
      );

      /*
       * 多房明细（整改报告 P1-4）：主单 + N 条 booking_rooms。
       * 第 1 条带主单的 room_id（若建单时就指定了房），其余待排房。
       */
      const bookingId = Number(inserted.lastInsertRowid);
      const detailCount = Math.max(1, line.roomCount);
      for (let i = 0; i < detailCount; i += 1) {
        run(
          `INSERT INTO booking_rooms
             (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
              check_in_date, check_out_date, stay_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            bookingId,
            line.roomTypeId,
            i === 0 ? line.roomId : null,
            guestName,
            mobile || null,
            line.rate,
            i === 0 && line.roomId ? "CONFIRMED" : "PENDING",
            checkInDate,
            checkOutDate,
            null,
            now,
          ]
        );
      }
    }
  };

  /*
   * 事务错误翻译（并发建单）
   *
   * 事务已由 tx() 内部 ROLLBACK，这里只负责把错误翻成前台能懂的话并回新建页：
   *   · BookingCreateError = 事务内复查的「房间区间已被占用」→ 原文案就是给用户看的；
   *   · 房型库存不足（事务内校验抛的普通 Error，文案本来就是给人看的）→ 原样回显；
   *   · UNIQUE = 唯一索引兜底（事务内复查之后、插入之前被抢写；或老库缺区间校验）
   *     → 「房间刚被占用，请刷新后重试」，绝不再变成 500；
   *   · SQLITE_BUSY / database is locked = 写锁排队超时 → 提示稍后重试；
   *   · 其它异常继续抛：那是真 bug，保留第一手堆栈便于排查。
   */
  try {
    tx(createBookingInTx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof BookingCreateError) {
      backNew(msg);
    } else if (/UNIQUE constraint failed/i.test(msg)) {
      backNew("该房间刚被其他订单占用（并发冲突），整单未创建，请刷新后重试");
    } else if (/SQLITE_BUSY|database is locked/i.test(msg)) {
      backNew("系统正忙：另一笔建单正在写库，本次未生效，请稍后重试");
    } else if (/库存不足|整单未创建/.test(msg)) {
      backNew(msg);
    } else {
      throw e;
    }
  }

  revalidateBookingPaths();
  redirect("/bookings");
}

/** 取消预订：状态改为已取消，并释放房间占用 */
export async function cancelBookingAction(formData: FormData) {
  // 权限（整改 P0-3）：取消预订会改状态并释放房间，属取消类写操作；booking.cancel 授权 admin / frontdesk。
  const user = await requirePermission("booking.cancel");
  const id = intOrNull(formData.get("id"));
  if (!id) return;

  /*
   * 整改指令 3.4：取消排房只能释放房间占用关系，不能删订单/客史/历史。
   *
   * 旧实现只改主单状态，booking_rooms 明细还挂着 room_id + CONFIRMED：
   *   · 占房唯一索引继续把这间房算作已占，房量不回来
   *   · 房态图上显示「有预订」，前台以为卖不出去
   *   · 渠道推库存时算的也是错的
   */
  tx(() => {
    run(
      `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
        WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [user.hotelId, id]
    );
    run(
      `UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`,
      [nowIso(), id, user.hotelId]
    );
    run(
      `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
      [user.hotelId, user.realName, "取消预订", `预订 #${id} 取消并释放房间占用`, nowIso()]
    );
  });

  /* 取消 = 房间重新可售：事务已提交，这里记一条渠道待同步（不实时打渠道接口） */
  markStockDirty(user.hotelId, `取消预订 #${id}，释放房间占用`);

  revalidateBookingPaths();
}

/** 确认预订：状态改为已确认 */
export async function confirmBookingAction(formData: FormData) {
  // 权限（整改 P0-3）：确认预订是订单状态修改（PENDING → CONFIRMED），归入订单修改权限 booking.modify（admin / frontdesk）。
  const user = await requirePermission("booking.modify");
  const id = intOrNull(formData.get("id"));
  if (!id) return;

  run(
    `UPDATE bookings SET status = 'CONFIRMED', updated_at = ? WHERE id = ? AND hotel_id = ?`,
    [nowIso(), id, user.hotelId]
  );

  revalidateBookingPaths();
}

/** 删除预订：物理删除（含多房明细） */
export async function deleteBookingAction(formData: FormData) {
  // 权限（整改 P0-3）：物理删除订单不可恢复，比取消更危险，用更严格的 booking.delete（admin / frontdesk），不走 booking.cancel。
  const user = await requirePermission("booking.delete");
  const id = intOrNull(formData.get("id"));
  if (!id) return;

  /*
   * 级联删明细（整改 P1-11：删预订不级联明细）
   *
   * 原来只 DELETE bookings，booking_rooms 里的明细变成孤儿：
   *   · 明细还挂着 room_id 和 status='CONFIRMED'，占房唯一索引继续把这间房算作已占，
   *     结果房间再也排不出去（前台只能看到「已被其他订单占用」，却找不到是哪张单）；
   *   · 远期房态 / 待排房统计也会按孤儿明细虚增占用。
   * booking_rooms 建表时没有声明 ON DELETE CASCADE，所以必须显式先删明细。
   * 两步放在同一个事务里：要么都删干净，要么都不动，不会出现「主单没了、明细还在」的中间态。
   */
  tx(() => {
    run(`DELETE FROM booking_rooms WHERE booking_id = ? AND hotel_id = ?`, [id, user.hotelId]);
    run(`DELETE FROM bookings WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  });

  revalidateBookingPaths();
}

/* ------------------------------------------------------------------ *
 * 批量操作（预订列表：复选框 + 表头全选）
 * ------------------------------------------------------------------ */

/** 收集勾选的预订 id：支持多个 ids 字段，也兼容逗号 / 空格分隔的单个串 */
function parseIds(formData: FormData): number[] {
  const set = new Set<number>();
  const push = (raw: string) => {
    for (const part of raw.split(/[,\s]+/)) {
      const n = Number(part);
      if (Number.isFinite(n) && n > 0) set.add(Math.trunc(n));
    }
  };
  for (const value of formData.getAll("ids")) {
    if (typeof value === "string") push(value);
  }
  return [...set];
}

function placeholders(ids: number[]): string {
  return ids.map(() => "?").join(",");
}

/**
 * 批量操作一个都没勾选时的用户反馈（整改 P2-19）
 *
 * 原来 6 处批量动作都是 `if (ids.length === 0) return;`，
 * 前台点了「批量确认 / 批量取消 / 批量删除」页面毫无反应，也不知道是自己没勾选。
 * 这里统一跳回列表页并在顶部横幅给出原因。
 */
function noSelection(message: string): never {
  redirect(`/bookings?err=${encodeURIComponent(message)}`);
}

/** 批量确认：待排房 → 已确认（其余状态不动） */
export async function batchConfirmBookingsAction(formData: FormData) {
  // 权限（整改 P0-3）：批量确认 = 批量改订单状态，同 confirmBookingAction，归入 booking.modify。
  const user = await requirePermission("booking.modify");
  const ids = parseIds(formData);
  if (ids.length === 0) noSelection("请先勾选要确认的订单");

  run(
    `UPDATE bookings SET status = 'CONFIRMED', updated_at = ?
      WHERE hotel_id = ? AND id IN (${placeholders(ids)}) AND status = 'PENDING'`,
    [nowIso(), user.hotelId, ...ids]
  );

  revalidateBookingPaths();
}

/** 批量取消：待排房 / 已确认 → 已取消（已入住、未到、已取消不动） */
export async function batchCancelBookingsAction(formData: FormData) {
  // 权限（整改 P0-3）：批量取消会改状态并释放房间，属取消类写操作；booking.cancel 授权 admin / frontdesk。
  const user = await requirePermission("booking.cancel");
  const ids = parseIds(formData);
  if (ids.length === 0) noSelection("请先勾选要取消的订单");

  /* 整改指令 3.4：与单条取消同一口径 —— 释放明细占用，不删订单 */
  tx(() => {
    run(
      `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
        WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED')
          AND booking_id IN (SELECT id FROM bookings
                              WHERE hotel_id = ? AND id IN (${placeholders(ids)})
                                AND status IN ('PENDING','CONFIRMED'))`,
      [user.hotelId, user.hotelId, ...ids]
    );
    run(
      `UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ?
        WHERE hotel_id = ? AND id IN (${placeholders(ids)}) AND status IN ('PENDING','CONFIRMED')`,
      [nowIso(), user.hotelId, ...ids]
    );
    run(
      `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
      [user.hotelId, user.realName, "批量取消预订", `取消 ${ids.length} 单并释放房间占用`, nowIso()]
    );
  });

  /* 批量取消同样释放房间：事务提交后再记渠道待同步 */
  markStockDirty(user.hotelId, `批量取消预订 ${ids.length} 单，释放房间占用`);

  revalidateBookingPaths();
}

/** 批量删除：已入住（CHECKED_IN）的订单不允许删除，其余物理删除（含多房明细） */
export async function batchDeleteBookingsAction(formData: FormData) {
  // 权限（整改 P0-3）：批量物理删除不可恢复，用 booking.delete（admin / frontdesk）。
  const user = await requirePermission("booking.delete");
  const ids = parseIds(formData);
  if (ids.length === 0) noSelection("请先勾选要删除的订单");

  /*
   * 级联删明细（整改 P1-11）：与单条删除同一套口径。
   * 注意只删「本次真的会被删掉」的那批订单的明细 —— 已入住订单不允许删，
   * 它的明细必须原样保留（不能先把明细删了再发现主单没删，那样在住单会失去房间明细）。
   * 所以先在同一个事务里查出可删的 id，再按这批 id 删明细、删主单。
   */
  tx(() => {
    const deletable = all<{ id: number }>(
      `SELECT id FROM bookings
        WHERE hotel_id = ? AND id IN (${placeholders(ids)}) AND status <> 'CHECKED_IN'`,
      [user.hotelId, ...ids]
    );
    for (const row of deletable) {
      run(`DELETE FROM booking_rooms WHERE booking_id = ? AND hotel_id = ?`, [row.id, user.hotelId]);
    }
    run(
      `DELETE FROM bookings WHERE hotel_id = ? AND id IN (${placeholders(ids)}) AND status <> 'CHECKED_IN'`,
      [user.hotelId, ...ids]
    );
  });

  revalidateBookingPaths();
}

/**
 * 团队批量取消排房：把所选预订所属团队（team_name 相同）的订单统一
 * room_id 置空、状态回 PENDING；只影响待排房 / 已确认的订单。
 */
export async function batchCancelTeamRoomsAction(formData: FormData) {
  // 权限（整改 P0-3）：团队批量取消排房会清空 room_id 并回 PENDING，属取消排房类写操作；booking.cancel 授权 admin / frontdesk。
  const user = await requirePermission("booking.cancel");
  const ids = parseIds(formData);
  if (ids.length === 0) noSelection("请先勾选要取消排房的订单");

  const rows = all<{ team_name: string | null }>(
    `SELECT DISTINCT team_name FROM bookings
      WHERE hotel_id = ? AND id IN (${placeholders(ids)})
        AND team_name IS NOT NULL AND TRIM(team_name) <> ''`,
    [user.hotelId, ...ids]
  );
  const teams = [...new Set(rows.map((r) => (r.team_name ?? "").trim()).filter((t) => t.length > 0))];
  if (teams.length === 0) return;

  const now = nowIso();
  tx(() => {
    for (const team of teams) {
      /*
       * 取消排房（整改指令 3.4）
       *
       * 只释放「房间占用关系」，不删订单、不删客史、不删历史记录。
       * 两处都要释放：主单的 room_id 镜像 + booking_rooms 明细的 room_id。
       * 旧实现只改主单，明细还占着房，房态图上仍然显示被占用 ——
       * 团队取消排房后房量没回来，前台以为没房可卖。
       */
      run(
        `UPDATE booking_rooms
            SET room_id = NULL, status = 'PENDING'
          WHERE hotel_id = ?
            AND status IN ('PENDING','CONFIRMED')
            AND booking_id IN (
              SELECT id FROM bookings
               WHERE hotel_id = ? AND team_name = ? AND status IN ('PENDING','CONFIRMED')
            )`,
        [user.hotelId, user.hotelId, team]
      );
      run(
        `UPDATE bookings SET room_id = NULL, status = 'PENDING', updated_at = ?
          WHERE hotel_id = ? AND team_name = ? AND status IN ('PENDING','CONFIRMED')`,
        [now, user.hotelId, team]
      );
      run(
        `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
        [user.hotelId, user.realName, "团队取消排房", `团队 ${team} · 释放房间占用（订单保留）`, now]
      );
    }
  });

  /* 团队释放房间后房间重新可售：事务提交后记渠道待同步 */
  markStockDirty(user.hotelId, `团队 ${teams.join("、")} 取消排房，释放房间占用`);

  revalidateBookingPaths();
}

/** 批量调价：给所选订单统一设置房价（金额必须 > 0） */
export async function batchAdjustRateBookingsAction(formData: FormData) {
  // 权限（整改 P0-3）：批量调价直接改订单金额，属改单类写操作；收银的收款权限不能等同于改价权限，故用 booking.modify。
  const user = await requirePermission("booking.modify");
  const ids = parseIds(formData);
  const rate = toNum(formData.get("rate"));
  if (ids.length === 0) noSelection("请先勾选要调价的订单");
  if (!(rate > 0)) redirect(`/bookings?err=${encodeURIComponent("批量调价需要填写大于 0 的统一房价")}`);

  const newRate = Math.round((rate + Number.EPSILON) * 100) / 100;
  /*
   * 逐单重算 total_price（整改 P1-12）：每单晚数 / 间数不同，不能只更新 rate，
   * 否则 total_price 变成调价前的旧值，报表按 total_price 取数会与 rate 不一致。
   */
  tx(() => {
    const rows = all<{ id: number; nights: number | null; room_count: number | null }>(
      `SELECT id, nights, room_count FROM bookings
        WHERE hotel_id = ? AND id IN (${placeholders(ids)})`,
      [user.hotelId, ...ids]
    );
    const now = nowIso();
    for (const row of rows) {
      run(`UPDATE bookings SET rate = ?, total_price = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
        newRate,
        bookingAmount(newRate, row.nights ?? 0, row.room_count ?? 1),
        now,
        row.id,
        user.hotelId,
      ]);
    }
  });

  revalidateBookingPaths();
}

/**
 * 修改单条预订备注：写 bookings.remark（空串视为清空备注）
 * 批量表单里每行备注框名为 remark_<id>，避免同名互相覆盖；
 * 单独表单直接传 remark 也可以。
 */
export async function updateBookingRemarkAction(formData: FormData) {
  // 权限（整改 P0-3）：修改预订备注会写 bookings.remark，属改单类写操作；booking.modify 授权 admin / frontdesk。
  const user = await requirePermission("booking.modify");
  const id = intOrNull(formData.get("id"));
  if (!id) return;

  const keyed = str(formData.get(`remark_${id}`));
  const remark = keyed || str(formData.get("remark"));

  run(`UPDATE bookings SET remark = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
    remark || null,
    nowIso(),
    id,
    user.hotelId,
  ]);

  revalidateBookingPaths();
  revalidatePath("/orders");
}

/**
 * 修改订单备注（订单列表 /orders 复用）：kind=stay 写 stays.remark，
 * 其余按预订写 bookings.remark。
 */
export async function updateOrderRemarkAction(formData: FormData) {
  // 权限（整改 P0-3）：订单 / 在住单备注修改同样是写操作（/orders 收银也可访问页面），服务端用 booking.modify 限制为 admin / frontdesk。
  const user = await requirePermission("booking.modify");
  const id = intOrNull(formData.get("id"));
  if (!id) return;

  const kind = str(formData.get("kind"));
  const keyed = str(formData.get(`remark_${id}`));
  const remark = keyed || str(formData.get("remark"));

  if (kind === "stay") {
    run(`UPDATE stays SET remark = ? WHERE id = ? AND hotel_id = ?`, [remark || null, id, user.hotelId]);
    revalidatePath("/rooms");
    revalidatePath("/orders");
  } else {
    run(`UPDATE bookings SET remark = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
      remark || null,
      nowIso(),
      id,
      user.hotelId,
    ]);
    revalidateBookingPaths();
    revalidatePath("/orders");
  }
}

/**
 * 排房失败（业务校验）专用错误类型。
 *
 * 为什么不用 redirect() 在事务里报错：redirect() 是靠抛 NEXT_REDIRECT 实现的，
 * 事务里的 try/catch 会把它当成普通异常吞掉（于是变成「排房失败：NEXT_REDIRECT」）。
 * 所以事务内一律抛 AssignRoomError，由外层 catch 统一转成 redirect 文案。
 */
class AssignRoomError extends Error {}

/**
 * 单条预订「排房」：给待排房订单分配一间具体房间。
 *
 * 整改 P1-1（排房并发兜底不严）——原实现的漏洞：
 *   冲突校验（stays / bookings / booking_rooms）全在事务外做，事务内拿到结果直接写库。
 *   两个人同时排同一间房时两边都能通过校验，只能指望 booking_rooms 的占房唯一索引兜底，
 *   而那个索引是 (room_id, check_in_date, check_out_date) 三列 ——
 *   只有「同房间 + 同起止日期」才触发，日期不同但区间重叠（如 10~12 与 11~13）根本不报错，
 *   结果同一间房被两张订单重复占用，前台到店才发现没房。
 *
 * 现在的顺序：
 *   1) 事务开始后先用 SELECT ... FROM rooms WHERE id = ? AND hotel_id = ? 重查房间行；
 *   2) 在事务内重新查三种占用来源（在住 / 预订主单镜像 / 多房明细）；
 *   3) 用乐观锁占位：UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ?
 *        AND status IN ('VC','VD')，回读 changes ——
 *        0 = 房间已不在「可排」状态（被别人置 OC/OOO，或抢先改过），立即整批回滚。
 *        排房本身不改房态（房态在入住时才置 OC），所以这条 UPDATE 只改自己（status = status），
 *        目的是在事务内对该房间行拿一次写锁，让并发排房在 SQLite 下串行化：
 *        后到的那个事务会看到前一个已提交的 booking_rooms 明细，从而被第 2 步拦下。
 *   4) 任一环节失败 → 整个事务回滚，返回明确原因，绝不会「排一半」。
 *      占房唯一索引保留作最后一道兜底（同房间同日期直接撞索引）。
 */
export async function assignRoomAction(formData: FormData) {
  // 权限（整改 P0-3）：排房要给订单绑定具体房间并联动房态，属分房类写操作；booking.assign_room 授权 admin / frontdesk。
  const user = await requirePermission("booking.assign_room");
  const hotelId = user.hotelId;
  const bookingId = intOrNull(formData.get("bookingId"));
  const roomIdsRaw = str(formData.get("roomIds"));
  const singleRoomId = intOrNull(formData.get("roomId"));
  const backTo = str(formData.get("backTo")) || "/bookings";
  /** 拼接返回地址：backTo 可能已带查询串 */
  const back = (key: string, val: string) => `${backTo}${backTo.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(val)}`;

  /*
   * 多间一次性排房（整改报告第 4 节：「排房时一次性校验所有房间，不能部分成功、部分失败」）
   *   roomIds 可能形如 "3,7,12"，也可能只传 roomId（老界面）
   *   全部校验通过才写库；任一失败 → 整体不排，返回具体原因
   */
  const requested = (roomIdsRaw ? roomIdsRaw.split(",") : [])
    .map((x) => intOrNull(x))
    .filter((n): n is number => n !== null && n > 0);
  const roomIds = [...new Set(singleRoomId ? [singleRoomId, ...requested] : requested)];
  if (!bookingId || roomIds.length === 0) redirect(back("err", "请选择房间"));

  type BookingSnapshot = {
    id: number;
    room_type_id: number | null;
    check_in_date: string;
    check_out_date: string;
    status: string;
    booking_no: string;
    guest_name: string | null;
    room_count: number | null;
    rate: number | null;
  };
  /** 订单快照 SQL：事务外只用于快速失败，事务内会用它再查一次拿最新状态 */
  const BOOKING_SQL = `SELECT id, room_type_id, check_in_date, check_out_date, status, booking_no, guest_name,
                              room_count, rate
                         FROM bookings WHERE id = ? AND hotel_id = ?`;

  type Picked = { id: number; room_no: string; room_type_id: number; isUpgrade: boolean };

  // 事务外先看一眼（订单存不存在 / 状态对不对），快速失败，避免白开事务；真正的校验在事务内重做
  const pre = get<BookingSnapshot>(BOOKING_SQL, [bookingId, hotelId]);
  if (!pre) redirect(back("err", "订单不存在"));
  if (pre.status !== "PENDING" && pre.status !== "CONFIRMED") {
    redirect(back("err", "该订单当前状态不能排房"));
  }

  /* ---------- 事务内：重查 → 冲突校验 → 乐观锁占位 → 写入（一次成功或全部回滚） ---------- */
  let remainingLast = 0;
  const roomNos: string[] = [];
  let failure = "";
  let done: BookingSnapshot = pre;

  try {
    tx(() => {
      /* 1. 事务内重查订单：状态可能已被并发修改（取消 / 已入住） */
      const b = get<BookingSnapshot>(BOOKING_SQL, [bookingId, hotelId]);
      if (!b) throw new AssignRoomError("订单不存在");
      if (b.status !== "PENDING" && b.status !== "CONFIRMED") {
        throw new AssignRoomError("该订单当前状态不能排房（可能已被取消或已入住），请刷新后重试");
      }

      /*
       * 2. 还能排几间（第 4 轮 P1-6：已排满的订单还能再加房）
       *
       * 旧逻辑只看「待排房明细数」：
       *   if (pendingDetailCount > 0 && roomIds.length > pendingDetailCount) 拒绝
       *
       * 漏洞：当待排明细归零（已经排满）时，`pendingDetailCount > 0` 为假，
       * 整个校验被跳过 —— 于是可以继续往里加房，明细数超过订单的 room_count。
       *
       * 现在按订单间数硬算：
       *   剩余可排 = room_count − 已排间数（booking_rooms 里 room_id 非空的）
       * 无论有没有待排明细，都不能超过这个数。
       */
      const bookedCount = Math.max(1, b.room_count ?? 1);
      const assignedCount =
        get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND room_id IS NOT NULL`,
          [hotelId, bookingId]
        )?.c ?? 0;
      const remaining = Math.max(0, bookedCount - assignedCount);
      if (roomIds.length > remaining) {
        throw new AssignRoomError(
          remaining === 0
            ? `该订单共 ${bookedCount} 间，已全部排满，不能再加房。要加房请先修改订单间数。`
            : `该订单共 ${bookedCount} 间，已排 ${assignedCount} 间，只剩 ${remaining} 间可排，本次选了 ${roomIds.length} 间`
        );
      }

      /* 3. 逐间：重查房间 → 三来源冲突 → 乐观锁 */
      const picked: Picked[] = [];
      for (const roomId of roomIds) {
        const r = get<{ id: number; room_no: string; room_type_id: number; status: string }>(
          `SELECT id, room_no, room_type_id, status FROM rooms WHERE id = ? AND hotel_id = ?`,
          [roomId, hotelId]
        );
        if (!r) throw new AssignRoomError(`房间 #${roomId} 不存在`);
        if (r.status !== "VC" && r.status !== "VD") {
          throw new AssignRoomError(`房间 ${r.room_no} 当前房态为 ${r.status}，不可排房（整批未排）`);
        }

        /* 区间冲突：在住 */
        const clashStay =
          get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM stays
              WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE'
                AND date(check_in_time) < ? AND expect_check_out > ?`,
            [hotelId, roomId, b.check_out_date, b.check_in_date]
          )?.c ?? 0;
        if (clashStay > 0) {
          throw new AssignRoomError(`房间 ${r.room_no} 在该日期区间有在住客人（整批未排）`);
        }

        /* 区间冲突：其他预订（主单镜像，历史数据兼容） */
        const clashBooking =
          get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM bookings
              WHERE hotel_id = ? AND room_id = ? AND id <> ?
                AND status IN ('PENDING','CONFIRMED','CHECKED_IN')
                AND check_in_date < ? AND check_out_date > ?`,
            [hotelId, roomId, bookingId, b.check_out_date, b.check_in_date]
          )?.c ?? 0;
        if (clashBooking > 0) {
          throw new AssignRoomError(`房间 ${r.room_no} 在该日期区间已被其他订单占用（整批未排）`);
        }

        /*
         * 区间冲突：多房明细（权威来源）。
         * P1-1 的关键一条 —— 现在它在事务内执行，能看到并发事务刚提交的明细；
         * 原来放在事务外，两个并发请求都读不到对方的数据，于是「日期不同但重叠」双双通过。
         */
        const clashDetail =
          get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM booking_rooms
              WHERE hotel_id = ? AND room_id = ? AND booking_id <> ?
                AND status IN ('CONFIRMED','CHECKED_IN')
                AND check_in_date < ? AND check_out_date > ?`,
            [hotelId, roomId, bookingId, b.check_out_date, b.check_in_date]
          )?.c ?? 0;
        if (clashDetail > 0) {
          throw new AssignRoomError(`房间 ${r.room_no} 已被其他订单的房间明细占用（整批未排）`);
        }

        /*
         * 乐观锁占位：不改房态，只为「房间仍在可排状态」拿一次行级写锁。
         * changes = 0 说明在我们读完房间行之后，有人把房态改成了 OC/OOO/LOCK 等，
         * 或者另一个排房事务已抢先提交 —— 这时必须整批回滚，不能继续写。
         */
        const lock = run(
          `UPDATE rooms SET status = status WHERE id = ? AND hotel_id = ? AND status IN ('VC','VD')`,
          [roomId, hotelId]
        );
        if (lock.changes === 0) {
          throw new AssignRoomError(
            `房间 ${r.room_no} 刚被其他人改动（并发冲突），本次排房已全部取消，请刷新后重新选择`
          );
        }

        // 房型不一致 = 升级排房（去呼呼允许，日志里标注）
        const isUpgrade = Boolean(b.room_type_id && r.room_type_id !== b.room_type_id);
        picked.push({ id: r.id, room_no: r.room_no, room_type_id: r.room_type_id, isUpgrade });
      }
      if (picked.length === 0) throw new AssignRoomError("没有可排的房间，请重新选择");

      /* 4. 写明细 + 主单镜像 + 操作日志 */
      const upgradeNotes: string[] = [];
      for (const p of picked) {
        const pendingDetail = get<{ id: number }>(
          `SELECT id FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL AND status = 'PENDING'
            ORDER BY id LIMIT 1`,
          [hotelId, bookingId]
        );
        if (pendingDetail) {
          run(
            `UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED', rate = COALESCE(rate, ?) WHERE id = ? AND hotel_id = ?`,
            [p.id, b.rate ?? 0, pendingDetail.id, hotelId]
          );
        } else {
          // 兼容历史数据（迁移前建的订单可能没有明细）
          run(
            `INSERT INTO booking_rooms
               (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
                check_in_date, check_out_date, stay_id, guest_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              hotelId,
              bookingId,
              b.room_type_id,
              p.id,
              b.guest_name,
              null,
              b.rate ?? 0,
              "CONFIRMED",
              b.check_in_date,
              b.check_out_date,
              null,
              null,
              nowIso(),
            ]
          );
        }
        roomNos.push(p.room_no);
        if (p.isUpgrade) upgradeNotes.push(p.room_no);
      }

      const restCnt =
        get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL`,
          [hotelId, bookingId]
        )?.c ?? 0;
      remainingLast = restCnt;

      /*
       * 主单镜像（P2-2）
       *
       * 只更新 room_id（首间房，兼容老报表）和 status，**不动 room_count**：
       *   room_count 是「客人在这个订单里订了几间房」，是订单原始属性；
       *   已排/待排是「排房进度」，应该只从 booking_rooms 明细统计。
       *   旧实现把 room_count 改成「已排间数」，导致排完 1 间后主单说「这单 1 间房」，
       *   与客人实际订的间数不符，报表/入住都跟着错。
       */
      run(
        `UPDATE bookings
            SET room_id = COALESCE(room_id, ?),
                status = CASE WHEN ? > 0 THEN 'PENDING' ELSE 'CONFIRMED' END,
                updated_at = ?
          WHERE id = ? AND hotel_id = ?`,
        [picked[0].id, restCnt, nowIso(), bookingId, hotelId]
      );

      run(
        `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
        [
          hotelId,
          user.realName ?? user.username ?? "系统",
          "排房",
          `${b.booking_no} ${b.guest_name ?? ""} → ${roomNos.join("、")}${
            upgradeNotes.length > 0 ? `（升级房型：${upgradeNotes.join("、")}）` : ""
          }${remainingLast > 0 ? `；还有 ${remainingLast} 间待排` : ""}`,
          nowIso(),
        ]
      );

      done = b;
    });
  } catch (e) {
    /*
     * 事务已回滚（tx 内部 ROLLBACK 后重抛），这里只负责把错误翻成人话。
     * 不用 redirect 在 catch 里做的事：下面统一 redirect，避免在事务上下文里抛 NEXT_REDIRECT。
     */
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof AssignRoomError) {
      failure = msg;
    } else if (msg.includes("UNIQUE")) {
      failure = "所选房间中有房间刚被其他订单占用（并发冲突），本次排房已全部取消，请重新选择";
    } else if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      failure = "系统正忙：另一笔排房正在写库，本次排房未生效，请稍后重试";
    } else {
      failure = `排房失败：${msg}`;
    }
  }

  if (failure) redirect(back("err", failure));

  /*
   * 排房改变「未排房预订 → 具体房间」的占用口径，渠道可售量随之变化：
   * 事务已在上面提交成功（失败分支已 redirect 掉），这里再记渠道待同步。
   */
  markStockDirty(hotelId, `预订单 ${done.booking_no} 排房 → ${roomNos.join("、")}`);

  revalidateBookingPaths();
  revalidatePath("/rooms");
  redirect(
    back(
      "msg",
      remainingLast > 0
        ? `已将 ${done.booking_no} 排到 ${roomNos.join("、")}，还有 ${remainingLast} 间待排房`
        : `已将 ${done.booking_no} 排到房间 ${roomNos.join("、")}（${done.room_count ?? 1} 间已排满）`
    )
  );
}


/** 单条调价（订单列表「操作▾ → 调价」） */
export async function adjustPriceAction(formData: FormData) {
  // 权限（整改 P0-3）：单条调价直接改房价，属改单类写操作；booking.modify 授权 admin / frontdesk。
  const user = await requirePermission("booking.modify");
  const id = intOrNull(formData.get("id"));
  const rate = Number(str(formData.get("rate")) ?? 0);
  const backTo = str(formData.get("backTo")) || "/bookings";
  if (!id || !Number.isFinite(rate) || rate < 0) {
    redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}err=${encodeURIComponent("请填写正确的房价")}`);
  }
  /*
   * 调价必须同步刷新 total_price（整改 P1-12）：total_price 是「房费总额」的快照，
   * 只改 rate 不重算总额，报表/账单会读到调价前的旧金额（比真实值多或少），
   * 所以这里按新的房价重算一次总额一起写。
   */
  const cur = get<{ nights: number | null; room_count: number | null }>(
    `SELECT nights, room_count FROM bookings WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (cur) {
    run(`UPDATE bookings SET rate = ?, total_price = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
      rate,
      bookingAmount(rate, cur.nights ?? 0, cur.room_count ?? 1),
      nowIso(),
      id,
      user.hotelId,
    ]);
  }
  run(
    `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
    [user.hotelId, user.realName ?? "system", "订单调价", `订单 ${id} 调价为 ${rate}`, nowIso()]
  );
  revalidatePath("/bookings");
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}msg=${encodeURIComponent("已调价为 " + rate)}`);
}

/** 免费升级（把订单房价置 0） */
export async function freeUpgradeAction(formData: FormData) {
  // 权限（整改 P0-3）：免费升级把房价置 0，等于改价，属改单类写操作；booking.modify 授权 admin / frontdesk。
  const user = await requirePermission("booking.modify");
  const id = intOrNull(formData.get("id"));
  const backTo = str(formData.get("backTo")) || "/bookings";
  if (!id) redirect(backTo);
  // total_price 同步清零（整改 P1-12）：免费房总额必须是 0，否则报表仍按原价计房费
  run(`UPDATE bookings SET rate = 0, total_price = 0 WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  run(
    `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
    [user.hotelId, user.realName ?? "system", "免费升级", `订单 ${id} 升级为免费房`, nowIso()]
  );
  revalidatePath("/bookings");
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}msg=${encodeURIComponent("已免费升级")}`);
}

/** 入团（把订单团队名设为默认团） */
export async function joinGroupAction(formData: FormData) {
  // 权限（整改 P0-3）：入团会改订单团队归属（写 bookings.team_name），属改单类写操作；booking.modify 授权 admin / frontdesk。
  const user = await requirePermission("booking.modify");
  const id = intOrNull(formData.get("id"));
  const backTo = str(formData.get("backTo")) || "/bookings";
  if (!id) redirect(backTo);
  run(`UPDATE bookings SET team_name = COALESCE(NULLIF(team_name, ''), '默认团队') WHERE id = ? AND hotel_id = ?`, [
    id,
    user.hotelId,
  ]);
  revalidatePath("/bookings");
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}msg=${encodeURIComponent("已入团")}`);
}
