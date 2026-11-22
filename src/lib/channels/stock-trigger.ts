/**
 * 渠道库存同步工具（整改清单 4.1）
 *
 * ── 这个文件解决什么问题 ──
 * 4.1 的缺口不是「适配器没写」，而是「业务层没人调」：房态 / 房价变了、订单进来了，
 * 没有任何地方通知渠道；渠道那边看到的一直是旧库存，于是超卖。
 *
 * 这里放五块**与具体渠道无关**的公共能力，供业务层（房态、预订、收银、夜审）调用：
 *
 *   1. markStockDirty()     —— 房态 / 订单变化后只记一条「待同步任务」，不实时打渠道接口；
 *   2. toChannelAllotment() —— 可售房量的超售口径（clamp 到 0 还是允许负数）；
 *   3. buildRateRows()      —— 未来 N 天 × 每房型的房量房价（推送房量房价的入参）；
 *   4. planRatePush()       —— 在 3 的基础上做「房型映射 + 价格方案」校验（整改清单 P2-10）；
 *   5. upsertChannelOrder() —— 渠道订单幂等落库（同一渠道单号重复拉取只留一条）。
 *
 * ── 为什么这些函数不在 sync-actions.ts 里 ──
 * `src/app/(main)/channels/sync-actions.ts` 是 "use server" 文件，按规定只能导出
 * async 的 server action；纯函数导出会直接编译报错。而且验收脚本
 * （scripts/test-channel-sync.mjs）需要**直接 import 生产代码**来验证幂等与超售口径，
 * 放在普通 lib 文件里既能被 action 用，也能被脚本用。
 *
 * ── markStockDirty 的调用点（整改清单 P2-13：原来零调用）──
 *   1. src/app/(main)/channels/actions.ts         —— 渠道订单转预订、拒单、切换超售策略之后
 *   2. src/app/(main)/channel-orders/actions.ts   —— 手动转入预订之后
 *   3. src/app/(main)/channels/sync-actions.ts    —— 拉单新增订单之后
 *   消费方：src/lib/channels/stock-queue.ts 的 drainStockQueue()（页面按钮 / pushRates 后 / cron）。
 *   仍待其它模块接线（不在本轮渠道整改的文件范围内）：
 *   rooms/actions.ts 改房态、bookings/actions.ts 取消换房、frontdesk 入住退房、
 *   night-audit 夜审结束、settings 改房价日历 —— 它们各自只需加一行 markStockDirty(hotelId, "原因")。
 *   调用频次很高，所以必须靠队列合并后再推送，绝不能在页面动作里直接调渠道。
 */

import { all, get, run } from "@/lib/db";
import { addDays, nowIso, todayStr } from "@/lib/utils";
import type { ChannelOrderPayload, RatePush } from "@/lib/channels/types";

/* ============================================================ 待同步队列 */

/** 队列里的任务类型；目前只有「推送房量房价」一种，未来加房态回传时扩展 */
export const STOCK_DIRTY_KIND = "PUSH_RATES";

/**
 * 标记「本店库存待同步」。
 *
 * 只落一条 channel_sync_queue 任务，不碰网络、不碰渠道适配器：
 *   · 前台改房态是很高频的动作，实时推送会把 OTA 接口打爆（四家都有频控）；
 *   · 队列消费者（后台任务 / 定时脚本）可以把同一酒店的多条任务合并成一次推送；
 *   · 即使消费者还没上线，队列里的 PENDING 记录也是「库存可能不一致」的可查证据。
 *
 * 幂等 / 容错：本函数**不抛异常**。房态动作不能因为「队列表没建」或「库锁」而失败，
 * 表缺失时静默跳过（老库没跑迁移时行为退回改造前，不引入新的崩溃点）。
 *
 * @param hotelId 酒店 id（租户隔离）
 * @param reason  变化原因，写进队列便于排查（如「改房态 301→OOO」「订单 BK8001 取消」）
 */
export function markStockDirty(hotelId: number, reason: string): void {
  try {
    run(
      `INSERT INTO channel_sync_queue (hotel_id, kind, reason, status, attempts, created_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?)`,
      [hotelId, STOCK_DIRTY_KIND, reason, nowIso()]
    );
  } catch {
    // 队列表不存在 / 库忙：库存同步是「尽力而为」，不能反向影响房态与订单操作
  }
}

/* ============================================================ 超售口径 */

/**
 * 把「物理可售房量」换算成传给渠道的 allotment（整改清单 4.1 的超售策略）。
 *
 *   channels.oversell = 0（严格）  → 负数一律 clamp 到 0
 *     理由：渠道侧 allotment 不接受负数，部分渠道会直接拒单；
 *           而「实际已经卖超」这种情况，推 0（满房）才是对渠道的正确表达。
 *   channels.oversell = 1（允许超售） → 保留负数，-N 表示「还能再卖超 N 间」
 *     理由：渠道按 allotment 判断能否继续下单，负数就是继续放量的额度。
 *
 * NaN / 非法值统一按 0 处理：宁可推「满房」，也不能给渠道推一个 NaN。
 */
export function toChannelAllotment(rawAllotment: number, oversell: boolean): number {
  const n = Number(rawAllotment);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.trunc(n);
  return oversell ? whole : Math.max(0, whole);
}

/* ============================================================ 房量房价计算 */

/**
 * 组装「未来 N 天 × 每房型」的推送行（整改清单 4.1 的房量 / 房态回传口径）。
 *
 *   allotment = 该房型房间数 - 该区间在住 - 该区间已排预订 - 维修房(OOO)
 *   price     = rate_calendar 当天该房型价格；没有配置就用 room_types.base_price
 *   closed    = 当天 allotment 为 0（满房关房）。
 *               负数代表「开了超售，还能再卖 N 间」，不是关房，所以不置 closed。
 *
 * 区间口径统一按 [入住日, 退房日) 左闭右开，与房态页的可售计算保持一致。
 * 超售策略由 toChannelAllotment 统一处理（oversell=0 clamp 到 0；=1 保留负数）。
 *
 * 为什么放在这个文件而不是 sync-actions.ts：
 *   「一人房、一张订单到底能卖几间」属于库存口径，和 markStockDirty 是同一件事的两端
 *   （一边算现状，一边记待办）；而且 sync-actions.ts 是 "use server" 文件只能导出 async
 *   action，验收脚本需要直接 import 这个纯函数用真实数据断言超售策略。
 *
 * 数据来源全部带 hotel_id，杜绝跨店串数。
 */
export function buildRateRows(
  hotelId: number,
  channelType: string,
  fromDate: string,
  days: number,
  oversell: boolean
): RatePush[] {
  const roomTypes = all<{ id: number; code: string; name: string; base_price: number | null }>(
    `SELECT id, code, name, base_price FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );
  if (roomTypes.length === 0) return [];

  // 每个房型的物理房间数（可售房量上限）
  const totals = new Map<number, number>();
  for (const r of all<{ room_type_id: number; c: number }>(
    `SELECT room_type_id, COUNT(*) AS c FROM rooms WHERE hotel_id = ? GROUP BY room_type_id`,
    [hotelId]
  )) {
    totals.set(Number(r.room_type_id), Number(r.c));
  }

  // 维修房（OOO）：整段日期都按这个数扣减 —— 维修房永远不能卖
  const maintenance = new Map<number, number>();
  for (const r of all<{ room_type_id: number; c: number }>(
    `SELECT room_type_id, COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND status = 'OOO' GROUP BY room_type_id`,
    [hotelId]
  )) {
    maintenance.set(Number(r.room_type_id), Number(r.c));
  }

  /* 锁房（LOCK）：同样整段日期都不能卖 —— 旧实现漏了这一项，会把锁房推给渠道（超卖） */
  const locked = new Map<number, number>();
  for (const r of all<{ room_type_id: number; c: number }>(
    `SELECT room_type_id, COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND status = 'LOCK' GROUP BY room_type_id`,
    [hotelId]
  )) {
    locked.set(Number(r.room_type_id), Number(r.c));
  }

  /*
   * 手工房量（rate_calendar.allotment），key = `房型id:日期`
   *
   * 语义（2026-11-22 经酒店确认）：**当天剩余可卖数量**。
   * 旧实现完全没读这张表 → 运营在「设置 → 房量」手工限售 5 间，
   * 渠道那边还在按物理剩余卖，限售形同虚设。
   *
   * 只取非 NULL 的行：没配的日期按物理可售走。
   */
  const rateAllotments = new Map<string, number>();
  try {
    for (const r of all<{ room_type_id: number; date: string; allotment: number }>(
      `SELECT room_type_id, date, allotment FROM rate_calendar
        WHERE hotel_id = ? AND allotment IS NOT NULL`,
      [hotelId]
    )) {
      rateAllotments.set(`${Number(r.room_type_id)}:${String(r.date).slice(0, 10)}`, Number(r.allotment));
    }
  } catch {
    /* 老库没有 rate_calendar 或没有 allotment 列：按「没配手工房量」处理 */
  }

  /*
   * 已占用：在住（stays）+ 已排具体房间的预订（bookings.room_id 非空）
   *
   * ⚠️ 在住单的占用区间必须**延伸到现在之后**，不能直接用 expect_check_out
   *
   * 用真实数据算：`day < expect_check_out` 对逾期未离店的客人永远不成立
   * （真库 21 张在住单 expect_check_out 是 11-14~11-18，都早于今天）。
   * 结果是这 21 间**全部被当成空房推给渠道**：
   *   房态页今日可售 17 间，渠道侧算成 40 间，实推携程 31 间
   *   → 携程能卖 31 间，实际只有 12 间可卖，**多推 19 间**
   *
   * 这正是用户在远期房态里修掉的同一个坑（forecast/page.tsx 已去掉该过滤），
   * 渠道侧当时没同步。
   *
   * 修法：SQL 里用 `MAX(expect_check_out, 明天)` 作为占用终点 ——
   * 只要客人还在（status='INHOUSE'），这间房就不能卖。
   * 用 date('now','localtime','+1 day') 而不是 today 变量，
   * 保证「今天离店」的单也覆盖到今天（`from <= day < to` 才成立）。
   */
  const occupied = all<{ room_type_id: number; from_date: string; to_date: string }>(
    `SELECT r.room_type_id,
            date(s.check_in_time) AS from_date,
            CASE
              WHEN s.expect_check_out IS NULL THEN date('now','localtime','+1 day')
              WHEN s.expect_check_out > date('now','localtime') THEN s.expect_check_out
              ELSE date('now','localtime','+1 day')
            END AS to_date
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     UNION ALL
     SELECT room_type_id, check_in_date, check_out_date
       FROM bookings
      WHERE hotel_id = ? AND room_id IS NOT NULL AND status IN ('PENDING','CONFIRMED')`,
    [hotelId, hotelId]
  );

  // 未排房预订：按 room_count 占用量（一间房一张单，多间就是多间）
  const pending = all<{
    room_type_id: number | null;
    from_date: string;
    to_date: string;
    room_count: number | null;
  }>(
    `SELECT room_type_id, check_in_date AS from_date, check_out_date AS to_date, room_count
       FROM bookings WHERE hotel_id = ? AND room_id IS NULL AND status IN ('PENDING','CONFIRMED')`,
    [hotelId]
  );

  // 房价日历：有配置用配置价，没有就用房型基准价
  const priceMap = new Map<string, number>();
  try {
    const endDate = todayStr(addDays(fromDate, days));
    for (const r of all<{ room_type_id: number; date: string; price: number }>(
      `SELECT room_type_id, date, price FROM rate_calendar WHERE hotel_id = ? AND date >= ? AND date < ?`,
      [hotelId, fromDate, endDate]
    )) {
      priceMap.set(`${Number(r.room_type_id)}:${r.date}`, Number(r.price));
    }
  } catch {
    // rate_calendar 未建表 / 未迁移时全部退回基准价
  }

  // 渠道房型编码映射（channel_room_types 里配的「携程房型名」）；没配就用本地房型 code 兜底，
  // 绝不发空编码 —— 渠道侧对空编码一律报「房型不存在」，会污染一次同步的 accepted/rejected 统计
  const channelCodes = new Map<number, string>();
  try {
    for (const r of all<{ room_type_id: number | null; channel_room_name: string }>(
      `SELECT room_type_id, channel_room_name FROM channel_room_types WHERE hotel_id = ? AND channel_type = ?`,
      [hotelId, channelType]
    )) {
      if (r.room_type_id !== null && r.room_type_id !== undefined) {
        channelCodes.set(Number(r.room_type_id), r.channel_room_name);
      }
    }
  } catch {
    // channel_room_types 表缺失时用本地 code
  }

  const dates = Array.from({ length: days }, (_, i) => todayStr(addDays(fromDate, i)));

  const rows: RatePush[] = [];
  for (const rt of roomTypes) {
    const total = totals.get(rt.id) ?? 0;
    /* 维修(OOO) + 锁房(LOCK)：两种情况整段日期都不能卖 */
    const ooo = maintenance.get(rt.id) ?? 0;
    const lock = locked.get(rt.id) ?? 0;
    for (const day of dates) {
      let used = 0;
      for (const o of occupied) {
        if (!o.from_date || !o.to_date) continue;
        if (Number(o.room_type_id) === rt.id && o.from_date <= day && day < o.to_date) used += 1;
      }
      for (const p of pending) {
        if (p.room_type_id === null || !p.from_date || !p.to_date) continue;
        if (Number(p.room_type_id) === rt.id && p.from_date <= day && day < p.to_date) {
          used += Math.max(1, Number(p.room_count ?? 1));
        }
      }

      /*
       * 可售 = 配了 rate_calendar.allotment ? min(物理可售, allotment) : 物理可售
       *
       * 与 src/lib/room-stock.ts 同口径（2026-11-22 经酒店确认：
       * allotment 是「当天剩余可卖数量」，不是「渠道总放量上限」）。
       *
       * 两个旧实现的缺陷在这轮一并修掉：
       *   1. 只扣了 OOO，**没扣 LOCK** → 锁房会被当成可卖推给渠道（超卖）
       *   2. **完全没读 rate_calendar.allotment** → 运营手工限售形同虚设
       *
       * ⚠️ 这里**不能** `Math.max(0, ...)`：
       *    物理可售可能是**负数**（卖超了），而负数是「还能再卖超几间」的信息，
       *    下游 toChannelAllotment(oversell) 要用它决定「关房」还是「继续放量」。
       *    房态页（room-stock.ts）才需要夹到 0，因为页面不显示负库存。
       */
      const physicalSellable = total - used - ooo - lock;
      const manual = rateAllotments.get(`${rt.id}:${day}`);
      const sellable =
        manual === null || manual === undefined ? physicalSellable : Math.min(physicalSellable, Math.max(0, manual));

      const allotment = toChannelAllotment(sellable, oversell);
      rows.push({
        channelRoomTypeCode: channelCodes.get(rt.id) ?? rt.code,
        // 整改清单 P2-10：把「编码是映射来的还是本地兜底的」显式带出来，
        // 下游 planRatePush 据此把未映射的房型剔进 rejected，不再静默降级
        roomTypeId: rt.id,
        mappingSource: channelCodes.has(rt.id) ? "mapped" : "local-code",
        date: day,
        allotment,
        price: priceMap.get(`${rt.id}:${day}`) ?? Number(rt.base_price ?? 0),
        // 0 间可售 = 当天满房 → 关房；负数代表「开了超售，仍可继续卖超」，不关房
        closed: allotment === 0,
      });
    }
  }
  return rows;
}

/* ============================================================ 推价前的映射校验 */

/** 一个没配渠道映射的房型（推送时必须剔出来，否则渠道侧必然报「房型不存在」） */
export type UnmappedRoomType = {
  roomTypeId: number;
  roomTypeName: string;
  /** 本系统房型编码（如果直接推给渠道就用的这个值 —— 也就是会被拒的编码） */
  localCode: string;
};

/** 推价计划：能推的行 + 必须先修映射的行 + 给日志的一句话 */
export type RatePushPlan = {
  rows: RatePush[];
  rejected: { code: string; reason: string }[];
  unmapped: UnmappedRoomType[];
  /** 价格方案的落地情况（未配置 / 回退了多少行），写进操作日志，避免静默降级 */
  note: string;
};

/** 渠道价格方案：把渠道的 rate_code（含加价 / 折扣系数）映射到本系统房价 */
type RatePlan = { rate_code: string; factor: number; room_type_id: number | null };

/** 读本店该渠道的价格方案；表不存在（老库没迁移）时返回空数组 */
function loadRatePlans(hotelId: number, channelType: string): RatePlan[] {
  try {
    return all<RatePlan>(
      `SELECT rate_code, factor, room_type_id FROM channel_rate_plans
        WHERE hotel_id = ? AND channel_type = ? ORDER BY id`,
      [hotelId, channelType]
    );
  } catch {
    return [];
  }
}

/**
 * 生成「可推送」的房量房价计划（整改清单 P2-10 的问题 1 / 3）。
 *
 * ── 纠正的静默降级 ──
 * 整改前：没配 `channel_room_types` 的房型直接用本地 `room_types.code` 当渠道编码推过去，
 * 渠道侧 100% 报「房型不存在」，而日志还写「接受 N 条」——运维看不出任何异常。
 * 现在：未映射的房型不进 rows，而进 rejected（每条带房型名与本地编码），
 * 同时 sync-actions 会补一条 MAPPING_MISSING 的失败日志，界面能直接看到「去补映射」。
 *
 * ── 价格方案（channel_rate_plans）──
 * 配了方案就按 factor 折算（房型专属优先于渠道通用方案）；
 * 一行都没配时按房价日历 / 基准价推，并在 note 里写明「未配置价格方案」——
 * 这是显式的降级说明，不再是查不到就悄悄换个价。
 *
 * @returns rows 可直接交给适配器；rejected 是**推送前就被拒**的行（不占渠道频控）
 * @param baseRows 可选的已算好的房量房价行（调用方已经调过 buildRateRows 时传进来，避免重复查库）
 */
export function planRatePush(
  hotelId: number,
  channelType: string,
  fromDate: string,
  days: number,
  oversell: boolean,
  baseRows?: RatePush[]
): RatePushPlan {
  const allRows = baseRows ?? buildRateRows(hotelId, channelType, fromDate, days, oversell);

  /* ---------- 1. 房型映射：没有映射的一律不推 ---------- */
  const unmappedMap = new Map<number, UnmappedRoomType>();
  for (const row of allRows) {
    if (row.mappingSource === "mapped") continue;
    const roomTypeId = Number(row.roomTypeId ?? 0);
    if (unmappedMap.has(roomTypeId)) continue;
    unmappedMap.set(roomTypeId, {
      roomTypeId,
      roomTypeName: roomTypeNameOf(hotelId, roomTypeId),
      localCode: row.channelRoomTypeCode,
    });
  }
  const unmapped = [...unmappedMap.values()];
  const rows = allRows.filter((row) => row.mappingSource === "mapped");

  const rejected: { code: string; reason: string }[] = unmapped.map((rt) => ({
    code: rt.localCode,
    reason: `房型「${rt.roomTypeName}」未配置渠道房型映射（channel_room_types），该房型 ${days} 天全部跳过`,
  }));

  /* ---------- 2. 价格方案：有配置就折算，没有就显式说明回退 ---------- */
  const plans = loadRatePlans(hotelId, channelType);
  const roomPlan = new Map<number, number>();
  let globalFactor: number | null = null;
  for (const plan of plans) {
    const factor = Number(plan.factor);
    if (!Number.isFinite(factor) || factor <= 0) continue;
    if (plan.room_type_id === null || plan.room_type_id === undefined) {
      globalFactor = factor;
    } else {
      roomPlan.set(Number(plan.room_type_id), factor);
    }
  }

  let fallbackRows = 0;
  for (const row of rows) {
    const factor = roomPlan.get(Number(row.roomTypeId ?? 0)) ?? globalFactor;
    if (factor === null || factor === undefined) {
      fallbackRows += 1;
      continue;
    }
    row.price = Math.round(row.price * factor * 100) / 100;
  }

  let note = "";
  if (plans.length === 0) {
    note = "未配置渠道价格方案（channel_rate_plans），按房价日历 / 房型基准价推送";
  } else if (fallbackRows > 0) {
    note = `有 ${fallbackRows} 行没有匹配到价格方案，已按基准价推送`;
  }

  return { rows, rejected, unmapped, note };
}

/** 房型显示名（不存在的房型给 #id，日志里也能定位） */
function roomTypeNameOf(hotelId: number, roomTypeId: number): string {
  try {
    const row = get<{ name: string | null }>(`SELECT name FROM room_types WHERE id = ? AND hotel_id = ?`, [
      roomTypeId,
      hotelId,
    ]);
    return row?.name ?? `#${roomTypeId}`;
  } catch {
    return `#${roomTypeId}`;
  }
}

/* ============================================================ 渠道订单幂等落库 */

/** upsertChannelOrder 的结果：inserted=false 表示这单拉过，调用方应跳过后续处理 */
export type UpsertChannelOrderResult = {
  /** 本次是否真的新插入 */
  inserted: boolean;
  /** channel_orders.id（跳过时是被命中的那条已有记录，可能为 null） */
  orderId: number | null;
  /** 库里当前的订单状态（跳过时用于判断是否还要接单） */
  status: string | null;
  /** 已关联的 PMS 预订 id（跳过时可能已经有值，绝不能再建一张） */
  bookingId: number | null;
};

/**
 * 按 (hotel_id, channel_order_no) 幂等写入一条渠道订单。
 *
 * 幂等的三道保险（重复拉单不会重复建单）：
 *   1. 先按 (hotel_id, channel_type, channel_order_no) 查一次 —— **与唯一索引的三列完全一致**
 *      （整改清单 P2-14：原来预查少了 channel_type，会让「同单号、不同渠道」的两条订单
 *      在预查阶段就被判成重复而永远拉不进来；两个渠道的订单号撞号是常态，
 *      因为各家的号段规则互不知情）；
 *   2. INSERT 用 OR IGNORE，靠唯一索引 idx_channel_orders_key
 *      (hotel_id, channel_type, channel_order_no) 兜住并发；changes=0 时回读已有行；
 *   3. 调用方只在 inserted=true 时才建预订，已转过的单在库里 status='IMPORTED'
 *      且 booking_id 非空，不会再走接单逻辑。
 *
 * 为什么要映射房型：渠道给的是渠道房型编码（如「大床房-预付」），
 * 落库要的是本系统 room_types.id；映射表 channel_room_types 没配时退回
 * room_types.code 精确匹配，两边都没有就留 NULL（宁可待人工匹配，也不乱猜房型）。
 */
export function upsertChannelOrder(
  hotelId: number,
  channelType: string,
  payload: ChannelOrderPayload
): UpsertChannelOrderResult {
  const orderNo = String(payload.channelOrderNo ?? "").trim();
  if (orderNo === "") {
    // 没有渠道单号就不存在幂等键，写进去只会变成脏数据
    return { inserted: false, orderId: null, status: null, bookingId: null };
  }

  /* 保险 1：先查（键与唯一索引一致；同时把已有 booking_id 带回去，调用方据此避免重复建预订） */
  const existing = get<{ id: number; status: string | null; booking_id: number | null }>(
    `SELECT id, status, booking_id FROM channel_orders
      WHERE hotel_id = ? AND channel_type = ? AND channel_order_no = ?`,
    [hotelId, channelType, orderNo]
  );
  if (existing) {
    return {
      inserted: false,
      orderId: Number(existing.id),
      status: existing.status,
      bookingId: existing.booking_id === null ? null : Number(existing.booking_id),
    };
  }

  const nights = finiteInt(payload.nights, 0);
  const roomCount = Math.max(1, finiteInt(payload.roomCount, 1));
  const amount = finiteNumber(payload.amount, 0);
  const roomTypeId = resolveRoomTypeId(hotelId, channelType, payload.roomTypeCode);

  /* 保险 2：OR IGNORE + 唯一索引，防止并发两次拉单插出两条 */
  const inserted = run(
    `INSERT OR IGNORE INTO channel_orders
       (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
        check_in_date, check_out_date, nights, room_count, amount, status, raw, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      hotelId,
      channelType,
      orderNo,
      roomTypeId,
      payload.guestName ?? null,
      payload.mobile ?? null,
      payload.checkInDate ?? null,
      payload.checkOutDate ?? null,
      nights,
      roomCount,
      amount,
      "NEW",
      safeRaw(payload.raw),
      payload.createdAt ?? nowIso(),
    ]
  );

  if (Number(inserted.changes) === 0) {
    // 并发下被别的请求抢先插入：回读那一行（同样按三列键），仍然按「跳过」处理
    const again = get<{ id: number; status: string | null; booking_id: number | null }>(
      `SELECT id, status, booking_id FROM channel_orders
        WHERE hotel_id = ? AND channel_type = ? AND channel_order_no = ?`,
      [hotelId, channelType, orderNo]
    );
    return {
      inserted: false,
      orderId: again ? Number(again.id) : null,
      status: again?.status ?? null,
      bookingId: again?.booking_id === null || again?.booking_id === undefined ? null : Number(again.booking_id),
    };
  }

  return {
    inserted: true,
    orderId: Number(inserted.lastInsertRowid),
    status: "NEW",
    bookingId: null,
  };
}

/* ============================================================ 私有工具 */

/** 渠道房型编码 → 本系统房型 id；映射表 / 编码都匹配不上时返回 null */
function resolveRoomTypeId(hotelId: number, channelType: string, channelRoomTypeCode: string): number | null {
  const code = String(channelRoomTypeCode ?? "").trim();
  if (code === "") return null;

  try {
    const mapped = get<{ room_type_id: number | null }>(
      `SELECT room_type_id FROM channel_room_types
        WHERE hotel_id = ? AND channel_type = ? AND channel_room_name = ?`,
      [hotelId, channelType, code]
    );
    if (mapped?.room_type_id !== null && mapped?.room_type_id !== undefined) {
      return Number(mapped.room_type_id);
    }
  } catch {
    // channel_room_types 表缺失（老库）时退回按房型 code 匹配
  }

  const byCode = get<{ id: number }>(`SELECT id FROM room_types WHERE hotel_id = ? AND code = ?`, [hotelId, code]);
  return byCode ? Number(byCode.id) : null;
}

/** 整数化：非法值 / 缺省走 fallback，负数不额外处理（钟点房 nights=0 是合法值） */
function finiteInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 金额整数化：非法值走 fallback（渠道偶尔会给 "300.00" 这样的字符串） */
function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 渠道原始报文落库：序列化失败时退成一个可读占位，不让 raw 把整次拉单搞崩 */
function safeRaw(raw: Record<string, unknown> | null | undefined): string {
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return "{}";
  }
}
