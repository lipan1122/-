/**
 * 房型「今日可售」库存口径（整改清单 P0-3）
 *
 * ── 修的是什么 ──
 * 房态页左侧「房型 / 今日可售」原来跑的是
 *   SELECT rt.id, rt.name, COUNT(r.id) FROM room_types rt LEFT JOIN rooms r ...
 * `COUNT(r.id)` 是**物理房间总数**：在住、维修、锁房、已排房预订全都被当成「可售」。
 * 46 间房里有 21 间在住，页面还是显示 46 间可售 —— 前台按这个数字排房，
 * 排到满房才发现根本没房（超卖）。这一栏的字面意思就是「今日可售」，必须扣占用。
 *
 * ── 为什么不直接调用项目里现有的三套算法 ──
 * 项目里关于「房量」已经有三处实现，各有明确用途，先说明为什么没有直接复用其中某一个：
 *
 *   1. src/lib/channels/stock-trigger.ts 的 buildRateRows()
 *      渠道房量房价推送用的可售数：
 *        allotment = 该房型房间数 − 区间占用（在住 + 已排房预订 + 未排房预订按 room_count）− 维修房(OOO)
 *      它判定占用的口径是 [入住日, 退房日) 左闭右开（退房当天可以接续），
 *      三处占用来源（stays / 主单 room_id / 未排房 room_count）也都是它先定的，
 *      而且这套口径已经被 scripts/test-channel-sync.mjs 的「5b」段用真实数据锁死（含超售 clamp）。
 *
 *      ★ 本文件复用的就是 buildRateRows 的占用口径 ★
 *      理由：房态页显示的可售数必须与推给渠道的数字是同一个口径。
 *      两边一旦分叉，就会出现「前台看到有房、渠道那边已经满房关房」或者反过来超卖 ——
 *      而这个页面正是前台排房 / 接单的依据。
 *
 *      但 buildRateRows 有两处不够（本轮清单要求补上，所以抽到本文件补齐）：
 *        · 它不扣锁房（LOCK）：锁房同样卖不了，算进可售就是超卖；
 *        · 它不认 rate_calendar.allotment（设置 → 房价设置「修改房量」手工可售上限）；
 *        · 它的「在住」按日期区间判定：客人逾期未离店（expect_check_out 已经过了但没走）时，
 *          那间房就不再落在任何区间里，会被算成可售 —— 这是超卖的直接来源。
 *      （stock-trigger.ts 不在本轮改动范围内，差异已在本文件里补齐；
 *        后续可以让 buildRateRows 反向复用本文件，两边口径就只剩一份。）
 *
 *   2. src/lib/room-availability.ts 的 findRoomConflicts()
 *      单房间的区间冲突判定（续住 / 换房 / 排房校验用）。
 *      它回答的是「这间房在 A~B 区间被谁占了」，按房间逐个查：
 *      房态页要的是「每个房型今天还剩几间」，46 间房就是 46 次查询（N+1），
 *      而且它同样不知道 OOO / LOCK / allotment。→ 排房校验继续用它，房量统计不用。
 *
 *   3. src/app/(main)/rooms/forecast/page.tsx 的 dayStats（远期房态表头「剩 N 间」）
 *      把当前视图里画出来的格子（在住块 + 已排房块）加上待分房汇总。
 *      它跟着屏幕筛选（楼层 / 房型 / 房号）走，而且只统计画在 VC/VD 上的预订块，
 *      不扣 OOO / LOCK / allotment。→ 它是「按当前视图看未来」，不是「全店今晚能卖几间」。
 *
 * ── 本文件的口径 ──
 *   物理可售 = 总房量 − 维修房(OOO) − 锁房(LOCK) − 在住 − 预订占用
 *   今日可售 = 配了 rate_calendar.allotment ? min(物理可售, allotment) : 物理可售
 *
 *   · 维修 / 锁房**按营业日（维修窗口）判定**（2026-11-25 加 rooms.block_from/block_to）：
 *       房间 status ∈ {OOO,LOCK} 且两列为空 → 今天仍算不可售（老数据行为，一个字都没变）；
 *       两列都有值 → 只有 `block_from <= day < block_to` 的营业日不可售，
 *                    窗口外的营业日照常计入可售（维修明天结束，明天就能卖）。
 *     判定函数是 `@/lib/room-stock-nightly` 的 `roomBlockedOn()` —— **唯一实现**，
 *     与 PC 建单 / 小程序查房 / 渠道推送（stock-trigger.ts）共用同一份，
 *     不存在「房态页说不可售、渠道还在卖」这种分叉。
 *   · 在住：房态是 OC/OD **或者**挂着 INHOUSE 在住单（两者取并集，数据漂移时任一成立都算占用）。
 *     **不看预计离店日** —— 客人逾期没走，房间就是卖不出去；
 *     metrics.ts 里同一个坑已经踩过一次（按 expect_check_out 截断会把逾期房间算成空房，出租率归零）。
 *   · 预订占用：状态 PENDING/CONFIRMED 且区间覆盖今天的房间数。
 *     明细表 booking_rooms 优先（一行 = 一间房，多房订单的权威来源），
 *     没有有效明细行的老数据用主单兜底（已排房按 1 间、未排房按 room_count）。
 *     房间本身**今天不可售**（在住 / 维修窗口内 / 锁房）时**不再重复扣** ——
 *     否则同一间房被扣两次，可售数偏小。窗口外的维修房不在此列：它今天是可售的，
 *     挂在它上面的预订照常扣减。
 *   · allotment（`rate_calendar.allotment`，设置 → 房价日历「修改房量」）：
 *     **当天剩余可卖数量**（2026-11-22 酒店确认）。
 *     它表达的是「今天这个房型还剩几间能卖」，已经是在住/维修/锁房/预订之后的结果，
 *     所以**不再从它里面扣占用** —— 那会把同一份占用扣两次。
 *     取 min 的原因：运营设的剩余量不能突破物理事实（不能把住满的房型设成还能卖 5 间）。
 *     ⚠️ 与渠道侧的 `toChannelAllotment` 不是一回事：那个是把「物理可售」换算成
 *     推给渠道的数字（负数是超售策略），两者同名但语义不同。
 *
 * ── 不变量（验收脚本逐条断言）──
 *   物理可售 = 总房量 − OOO − LOCK − 在住 − 预订
 *   今日可售 = min(物理可售, allotment)  或 allotment 为 NULL 时 = 物理可售
 *   （旧口径是「min(物理上限, allotment) − 在住 − 预订」，占用被扣两次，已于第九轮回退）
 */

import { all } from "@/lib/db";
import { loadRoomBlocks, roomBlockedOn } from "@/lib/room-stock-nightly";
import { todayStr } from "@/lib/utils";

/** 房态里「已经卖不了」的两种状态：维修 / 锁房（具体到哪一天由维修窗口决定） */
const BLOCKED_ROOM_STATUSES = new Set(["OOO", "LOCK"]);

/** 房态里「有客人在住」的两种状态（OOO/LOCK 之外的占用口径） */
const OCCUPIED_ROOM_STATUSES = new Set(["OC", "OD"]);

/** 一个房型今天各项房量的明细 */
export type RoomTypeStock = {
  roomTypeId: number;
  name: string;
  code: string;
  /** 物理房间数（含维修房 / 锁房 / 在住） */
  physical: number;
  /** 维修房（OOO） */
  ooo: number;
  /** 锁房（LOCK） */
  lock: number;
  /** 在住占用（含逾期未离店） */
  inhouse: number;
  /** 今日已被预订占用的房间数（已排房 + 未排房按 room_count） */
  booked: number;
  /** 当天手工可售上限（rate_calendar.allotment）；null = 没配 */
  allotment: number | null;
  /** allotment 造成的限售扣减 = 物理可卖上限 − min(物理可卖上限, allotment) */
  allotmentHold: number;
  /** 今日可售（展示值，负数按 0 截断） */
  sellable: number;
  /** 超卖间数（可售为负时取绝对值；0 = 没超卖） */
  oversold: number;
};

/** 全店汇总（提示条那一行数字） */
export type StockTotals = {
  physical: number;
  ooo: number;
  lock: number;
  inhouse: number;
  booked: number;
  allotmentHold: number;
  sellable: number;
  oversold: number;
};

/** 一个房型的累计器（房间 / 预订两轮扫描都往里加） */
type Agg = { physical: number; ooo: number; lock: number; inhouse: number; booked: number };

function emptyAgg(): Agg {
  return { physical: 0, ooo: 0, lock: 0, inhouse: 0, booked: 0 };
}

function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 某个房型当天的库存明细，按房型排序返回（顺序与「系统设置 → 房间管理」一致）。
 *
 * @param hotelId 酒店 id（所有查询都带它，杜绝跨店串数）
 * @param day     营业日，默认今天；只支持「今天」，远期房量看 rooms/forecast
 */
export function todayRoomTypeStock(hotelId: number, day: string = todayStr()): RoomTypeStock[] {
  /* ---------- 1. 房型清单：页面按这个顺序渲染，空房型也要出现（0 间可售） ---------- */
  const types = all<{ id: number; name: string; code: string | null }>(
    `SELECT id, name, code FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );
  if (types.length === 0) return [];

  /* ---------- 2. 房间：物理房量 / 维修 / 锁房 / 在住 ---------- */
  /*
   * 房间清单走 `loadRoomBlocks()`（与 PC 建单 / 小程序查房 / 渠道推送同一份实现）：
   * 它比手写 SQL 多返回 block_from / block_to，并且自带老库兜底
   * （第 25 段迁移还没跑时退回「两列为空」= OOO/LOCK 整段排除，不会放开维修房）。
   */
  const rooms = loadRoomBlocks({ all }, hotelId);

  /* 在住单的房间号集合：房态字段可能因为手工改房态而与在住单漂移，
     所以「房态 OC/OD」和「挂着 INHOUSE 单」两个条件取并集，任一成立都按占用算（宁可算紧，不算松）。 */
  const inhouseRoomIds = new Set(
    all<{ room_id: number }>(
      `SELECT DISTINCT room_id FROM stays
        WHERE hotel_id = ? AND status = 'INHOUSE' AND room_id IS NOT NULL`,
      [hotelId]
    ).map((r) => toInt(r.room_id))
  );

  const aggs = new Map<number, Agg>();
  for (const t of types) aggs.set(toInt(t.id), emptyAgg());

  /** 房间 id → 房型 id（预订明细只给 room_id 时用它反查） */
  const typeOfRoom = new Map<number, number>();
  /** 今天已经不可卖的房（在住 / 今天在维修窗口内 / 今天锁房）：预订扣减时用来自查重 */
  const blockedRooms = new Set<number>();

  for (const room of rooms) {
    const roomId = toInt(room.id);
    const typeId = toInt(room.room_type_id);
    const status = String(room.status ?? "VC").toUpperCase();
    if (room.room_type_id !== null) typeOfRoom.set(roomId, typeId);

    const agg = aggs.get(typeId);
    if (!agg) continue; // 房型被删掉的孤儿房间：不进任何房型统计

    agg.physical += 1;

    if (BLOCKED_ROOM_STATUSES.has(status)) {
      /*
       * 维修 / 锁房：只扣**今天落在窗口内**的。
       *   · 没登记窗口（老数据）→ roomBlockedOn 恒 true → 与改造前完全一致；
       *   · 登记了窗口（如 11-26~11-28）→ 窗口外的那天不扣，房间照常可售。
       */
      if (!roomBlockedOn(room, day)) continue;
      if (status === "OOO") agg.ooo += 1;
      else agg.lock += 1;
      blockedRooms.add(roomId);
      continue;
    }
    if (OCCUPIED_ROOM_STATUSES.has(status) || inhouseRoomIds.has(roomId)) {
      agg.inhouse += 1;
      blockedRooms.add(roomId);
    }
  }

  /* ---------- 3. 预订占用 ---------- */
  /* 3a. 明细表 booking_rooms：一行 = 一间房（多房订单的权威来源）。
         状态口径与 findRoomConflicts 一致：只有 PENDING/CONFIRMED 还占着房，
         CHECKED_IN 已经由 stays 表达，重复计会把可售数算小。 */
  let detailRows: { room_id: number | null; room_type_id: number | null }[] = [];
  let hasBookingRooms = true;
  try {
    detailRows = all<{ room_id: number | null; room_type_id: number | null }>(
      `SELECT br.room_id, br.room_type_id
         FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
        WHERE br.hotel_id = ?
          AND br.status IN ('PENDING','CONFIRMED')
          AND b.status IN ('PENDING','CONFIRMED')
          AND br.check_in_date <= ? AND br.check_out_date > ?`,
      [hotelId, day, day]
    );
  } catch {
    // booking_rooms 是老库的迁移表：缺表时退回只用主单，口径与 buildRateRows 一致
    hasBookingRooms = false;
  }

  for (const row of detailRows) {
    const roomId = row.room_id === null ? null : toInt(row.room_id);
    /* 房间本来就在住 / 维修 / 锁房：第 2 步已经扣过，这里不重复扣 */
    if (roomId !== null && roomId > 0 && blockedRooms.has(roomId)) continue;
    const typeId = roomId !== null && roomId > 0 ? typeOfRoom.get(roomId) : toInt(row.room_type_id);
    if (typeId === undefined || typeId === 0) continue;
    const agg = aggs.get(typeId);
    if (!agg) continue;
    agg.booked += 1; // 一行明细 = 一间房
  }

  /* 3b. 没有有效明细行的老预订：主单兜底。
         已排房按 1 间（与 buildRateRows 的 occupied 分支一致），未排房按 room_count。 */
  const mainRows = all<{
    room_id: number | null;
    room_type_id: number | null;
    room_count: number | null;
  }>(
    hasBookingRooms
      ? `SELECT b.room_id, b.room_type_id, COALESCE(b.room_count, 1) AS room_count
           FROM bookings b
          WHERE b.hotel_id = ?
            AND b.status IN ('PENDING','CONFIRMED')
            AND b.check_in_date <= ? AND b.check_out_date > ?
            AND NOT EXISTS (SELECT 1 FROM booking_rooms br
                             WHERE br.booking_id = b.id AND br.status IN ('PENDING','CONFIRMED'))`
      : `SELECT b.room_id, b.room_type_id, COALESCE(b.room_count, 1) AS room_count
           FROM bookings b
          WHERE b.hotel_id = ?
            AND b.status IN ('PENDING','CONFIRMED')
            AND b.check_in_date <= ? AND b.check_out_date > ?`,
    [hotelId, day, day]
  );

  for (const row of mainRows) {
    const roomId = row.room_id === null ? null : toInt(row.room_id);
    if (roomId !== null && roomId > 0 && blockedRooms.has(roomId)) continue;
    const typeId = roomId !== null && roomId > 0 ? typeOfRoom.get(roomId) : toInt(row.room_type_id);
    if (typeId === undefined || typeId === 0) continue;
    const agg = aggs.get(typeId);
    if (!agg) continue;
    /* 已排房：主单只代表 1 间（多房订单会走 booking_rooms 明细，不会落到这个分支） */
    agg.booked += roomId !== null && roomId > 0 ? 1 : Math.max(1, toInt(row.room_count ?? 1));
  }

  /* ---------- 4. 手工房量上限（设置 → 房价设置 → 修改房量） ---------- */
  const allotments = new Map<number, number>();
  try {
    for (const row of all<{ room_type_id: number; allotment: number | null }>(
      `SELECT room_type_id, allotment FROM rate_calendar
        WHERE hotel_id = ? AND date = ? AND allotment IS NOT NULL`,
      [hotelId, day]
    )) {
      allotments.set(toInt(row.room_type_id), toInt(row.allotment));
    }
  } catch {
    // 老库没有 allotment 列 / 没有 rate_calendar：按「没配手工房量」处理
  }

  /* ---------- 5. 合成每个房型的可售 ---------- */
  return types.map((t) => {
    const typeId = toInt(t.id);
    const agg = aggs.get(typeId) ?? emptyAgg();
    const allotment = allotments.has(typeId) ? (allotments.get(typeId) as number) : null;

    /*
     * 物理可售 = 总房量 − 维修 − 锁房 − 在住 − 预订占用
     *
     * 这一步**必须**做：它反映的是「物理上真的还能卖几间」。
     * 客人占着房间、房间在维修、房间被锁，都不能卖。
     */
    const physicalCap = Math.max(0, agg.physical - agg.ooo - agg.lock);
    const physicalSellable = Math.max(0, physicalCap - agg.inhouse - agg.booked);

    /*
     * rate_calendar.allotment 的语义（2026-11-22 经酒店确认）：
     *
     *   **当天剩余可卖数量**
     *
     * 不是「渠道总放量上限」，也不是「总房量」。它表达的是「今天这个房型
     * 还剩几间能卖」—— 已经是在住/维修/锁房/预订之后的结果。
     *
     * 所以：
     *   · 配了 allotment → 可售 = min(物理可售, allotment)
     *     （取小的原因：运营设的剩余量不可能突破物理事实，防止手工把
     *       已经住满的房型设成还能卖 5 间）
     *   · 没配 → 可售 = 物理可售
     *
     * ⚠️ 旧实现错在这里（第八~九轮）：
     *     可售 = min(物理上限, allotment) − 在住 − 预订
     *   把 allotment 当「总上限」用了，于是「在住 + 预订」被扣了两次：
     *     总房 10 / 在住 3 / 预订 2 / allotment 5
     *       旧：min(10,5) − 3 − 2 = 0   ← 明明还能卖 5 间却显示 0
     *       新：min(10−3−2, 5) = 5      ← 正确
     */
    const sellable = allotment === null ? physicalSellable : Math.min(physicalSellable, Math.max(0, allotment));

    /*
     * allotmentHold = allotment 把可售**压低**了多少（只用于页面解释，
     * 不参与任何扣减）。它不是「超售」——超售看的是物理可售是否 < 0。
     */
    const allotmentHold = physicalSellable - sellable;

    const raw = sellable;
    return {
      roomTypeId: typeId,
      name: t.name,
      code: t.code ?? "",
      physical: agg.physical,
      ooo: agg.ooo,
      lock: agg.lock,
      inhouse: agg.inhouse,
      booked: agg.booked,
      allotment,
      allotmentHold,
      sellable: Math.max(0, raw),
      /*
       * 超售：物理可售 < 0（卖超了）。
       * 注意不能用 raw（它被 allotment 夹过，allotment=0 时会误报超售）。
       */
      oversold: physicalCap - agg.inhouse - agg.booked < 0 ? -(physicalCap - agg.inhouse - agg.booked) : 0,
    };
  });
}

/** 把各房型明细汇总成全店数字（提示条用；口径与明细完全一致） */
export function stockTotals(rows: RoomTypeStock[]): StockTotals {
  const totals: StockTotals = {
    physical: 0,
    ooo: 0,
    lock: 0,
    inhouse: 0,
    booked: 0,
    allotmentHold: 0,
    sellable: 0,
    oversold: 0,
  };
  for (const row of rows) {
    totals.physical += row.physical;
    totals.ooo += row.ooo;
    totals.lock += row.lock;
    totals.inhouse += row.inhouse;
    totals.booked += row.booked;
    totals.allotmentHold += row.allotmentHold;
    totals.sellable += row.sellable;
    totals.oversold += row.oversold;
  }
  return totals;
}
