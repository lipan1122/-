/**
 * 房型库存「按晚（nightly）」口径 —— PC 建单与小程序下单的**唯一实现**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要抽成一个 lib
 * ══════════════════════════════════════════════════════════════════════════
 * 这条口径原来有**两份**实现：
 *   · PC 建单 `app/(main)/bookings/actions.ts`（评审 P0-1 修好后是逐晚的）；
 *   · 小程序 `app/api/mini/_shared.ts` 的 `loadAvailability`（还是旧的区间重叠计数）。
 * 两份实现 = 两个真源 = 必然漂移。实测小程序那份带着和 PC 修之前**完全相同的两个 bug**：
 *
 *   ① **超卖**：容量口径是 `COUNT(*) − OOO`，锁房（LOCK）被当成可售 →
 *      某房型唯一一间房被锁，客人照样能从小程序卖掉它。
 *   ② **误拒**：占用按「整个入住区间有没有重叠」+1，没有按晚拆开 →
 *      两间同型房 A 占 11-25、B 占 11-26，再订 11-25~11-27 一间
 *      （两晚各剩 1 间，本该成功）被算成「已占 2 间」而拒绝。
 *
 * 所以这里把口径收敛成一份，两个入口都 import 本文件：
 *   · 任何口径改动（例如哪天给 rooms 表加了维修起止日期）只改这里；
 *   · 两个入口的行为天然一致，不存在「PC 拦住、小程序放过去」的窗口。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 口径（与房态页 / 渠道库存的物理限额一致）
 * ══════════════════════════════════════════════════════════════════════════
 *   物理可售(房型) = 该房型房间数 − OOO − LOCK
 *   某一晚占用     = 在住单 + 未入住明细（一行一间）+ 无明细旧主单（按 room_count）
 *   某一晚剩余     = 物理可售 − 该晚占用
 *   判定           = 入住区间内**最低**的剩余 ≥ 本单要的间数
 *
 *   · 入住日含、离店日不含（`ci <= 该晚 && co > 该晚`）：
 *     A 占 11-25 一晚、B 占 11-26 一晚，二者不在任何一晚叠加。
 *   · **已转在住的房晚只计一次**：checkInAction 会把 `booking_rooms.stay_id`
 *     回填并把明细置 CHECKED_IN，这类明细由「在住单」那一支表达，明细支不再计。
 *   · 明细 / 主单挂在 OOO、LOCK 的房上时**不再计入占用**：那间房已经整段从
 *     物理可售里剔除了，再扣一次是重复扣减（与 room-stock.ts 的 blockedRooms 同口径）。
 *   · 容量和占用都在**写入事务内**复查（PC 端见 actions.ts 的 tx，小程序端见
 *     bookings/route.ts 的 tx）：并发下由 `BEGIN IMMEDIATE` 的写锁 + 复查兜住。
 *   · 维修 / 锁房的**起止日期**：`rooms` 表只有 `status` 快照，没有
 *     ooo_from / ooo_to 之类的时间列，所以只能按「恢复为 VC/VD 之前一律不可售」
 *     处理 —— 这正是「只在房态记录能证明房间已恢复时才释放后续房晚」的保守做法：
 *     宁可按整段不可售，也不拿一个无法证明的恢复日期去放量。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么 db 句柄是参数而不是在这里 import @/lib/db
 * ══════════════════════════════════════════════════════════════════════════
 *   · 调用方（PC action / 小程序 route）都有自己的连接与全局注入
 *     （`globalThis.__pmsDb`、测试 harness 的副本库），把句柄传进来保证
 *     本文件的读与调用方的写**在同一个连接、同一个事务快照**里；
 *   · 本文件因此不依赖 node:sqlite / next，是纯函数式口径模块，脚本里可以直接跑。
 */

/**
 * 只读查询句柄（与 `@/lib/db` 的 `all` / `get` 结构一致）
 *
 * 不写 `import type { DatabaseSync }`：本模块只需要这两条查询能力，
 * 传 `{ all, get }` 或整份 `@/lib/db` 命名空间都能用。
 */
export type StockDb = {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
};

/** 任意值转整数，非法值返回 0（与 actions.ts 的 toInt 同口径） */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 某房型物理可售 = 房间数 − OOO − LOCK（整段排除，因为 rooms 没有维修起止日期字段）
 *
 * 为什么 OOO / LOCK 要一起扣：
 *   · 维修房卖出去，前台无法排房（客人到店才知道房间在修）；
 *   · 锁房是「人为留着不卖」的房（渠道预留 / 内部用房 / 损坏待处理），
 *     同样不是可售库存，扣 OOO 不扣 LOCK 就是把锁房的量白送出去。
 * 两者都只有 `status` 快照、没有起止日期，只能按整段不可售处理。
 *
 * 返回 0 表示该房型当前一间都卖不了（没有物理房间 / 全部维修锁房）——
 * 调用方**必须**把它当成「不可售」，不能因为 0 就跳过校验（旧代码正是这么超卖的）。
 */
export function physicalCapOfType(db: StockDb, hotelId: number, roomTypeId: number): number {
  return Number(
    db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM rooms r
        WHERE r.hotel_id = ? AND r.room_type_id = ?
          AND UPPER(COALESCE(r.status, 'VC')) NOT IN ('OOO','LOCK')`,
      [hotelId, roomTypeId]
    )?.c ?? 0
  );
}

/**
 * [ci, co) 的每一晚（YYYY-MM-DD，入住日含、离店日不含）
 *
 * 脏日期（非法 / `co <= ci`）返回空数组，由调用方按「没有可卖房晚」处理；
 * 上限 400 晚，防「把 2026 写成 2062」这种脏日期把事务拖死。
 */
export function eachNight(ci: string, co: string): string[] {
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(`${ci}T00:00:00`);
  const end = new Date(`${co}T00:00:00`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return out;
  for (let i = 0; d < end && i < 400; i += 1) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * 某房型在 [ci, co) 每一晚的已有占用（Map<日期, 间数>）
 *
 * 三个来源，互不重复计数：
 *
 * ① **在住单**：同一间在住的房，每晚算 1 间。
 *    离店日按 `expect_check_out`；该字段为空 / 为脏值时按「无限期在住」处理 ——
 *    宁可算紧（少卖）也不能算松（超卖）。
 *
 * ② **有明细的订单**：**一行明细 = 一间房**（不管这间排没排房）。
 *    只数「排了房的明细」会漏：3 间订单排了 1 间时明细是「1 行有 room_id +
 *    2 行 room_id 为空」，按已排房数算成 1 间，另外 2 间凭空消失 → 校验形同虚设。
 *    也不能再叠加主单 `room_count`：主单和明细是同一份占用的两种表达，两边都算会翻倍。
 *    状态口径只算 PENDING / CONFIRMED（还占着房的）：CHECKED_IN 的明细已经由
 *    ① 在住单表达（`stay_id` 就是回填凭据），这里再算就是双计。
 *
 * ③ **没有明细的旧订单**（迁移前的老数据）→ 按主单 room_count 算。
 *    有明细的订单**不参与**这一支，避免和 ② 重复计数。
 *
 * ② / ③ 若挂在 OOO / LOCK 的房上 → 跳过：物理可售已经把那间房整段剔除，
 * 再扣一次就是重复扣减。
 *
 * 返回的 Map **包含区间内每一晚**（没有占用的记 0），插入顺序即入住日顺序，
 * 调用方取最小值时天然按「最早的一晚」优先，便于前台排查。
 */
export function occupiedByNight(
  db: StockDb,
  hotelId: number,
  roomTypeId: number,
  ci: string,
  co: string,
  /**
   * 排除某张订单自身的占用（改单 / 续住 / 升房时用）
   *
   * 为什么需要：小程序「改单」要算「把这张单改到新区间后还剩几间」——
   * 如果把它自己算进占用，改到同一区间就会恒报「只剩 0 间」。
   * PC 端建单不需要这个参数（新单还没落库）。
   */
  excludeBookingId?: number
): Map<string, number> {
  const nights = eachNight(ci, co);
  const occ = new Map<string, number>(nights.map((night): [string, number] => [night, 0]));
  const ex = Number(excludeBookingId ?? 0) || 0;
  /** 把 [from, to) 这段的占用 +n 摊到与入住区间相交的每一晚 */
  const spread = (from: string, to: string, n: number) => {
    if (!from || !to) return;
    for (const night of nights) {
      if (from <= night && to > night) occ.set(night, (occ.get(night) ?? 0) + n);
    }
  };

  /* ① 在住单：同一间在住的房，每晚算 1 间（离店日为空按无限期在住） */
  for (const s of db.all<{ ci: string | null; co: string | null }>(
    `SELECT COALESCE(NULLIF(substr(s.check_in_time, 1, 10), ''), '0000-01-01') AS ci,
            COALESCE(NULLIF(s.expect_check_out, ''), '9999-12-31') AS co
       FROM stays s
       JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND r.room_type_id = ? AND s.status = 'INHOUSE'`,
    [hotelId, roomTypeId]
  )) {
    spread(String(s.ci ?? ""), String(s.co ?? ""), 1);
  }

  /* ② 有明细的订单：一行明细 = 一间房（CHECKED_IN 由 ① 表达，这里不计） */
  for (const d of db.all<{ ci: string | null; co: string | null; room_status: string | null; booking_id: number }>(
    `SELECT br.check_in_date AS ci, br.check_out_date AS co, r.status AS room_status, b.id AS booking_id
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
       LEFT JOIN rooms r ON r.id = br.room_id AND r.hotel_id = br.hotel_id
      WHERE br.hotel_id = ? AND br.room_type_id = ?
        AND br.status IN ('PENDING','CONFIRMED')
        AND b.status IN ('PENDING','CONFIRMED')
        AND br.check_in_date < ? AND br.check_out_date > ?`,
    [hotelId, roomTypeId, co, ci]
  )) {
    /* 改单场景：本单自己的占用不算（否则改到同一区间恒报「只剩 0 间」） */
    if (ex > 0 && Number(d.booking_id) === ex) continue;
    const st = String(d.room_status ?? "").toUpperCase();
    /* 明细挂在维修 / 锁房上：物理可售已经把那间房整段剔除，再计一次就是重复扣减 */
    if (st === "OOO" || st === "LOCK") continue;
    spread(String(d.ci ?? ""), String(d.co ?? ""), 1);
  }

  /* ③ 没有明细的旧订单（迁移前的老数据）→ 按主单 room_count 算 */
  for (const m of db.all<{
    ci: string | null;
    co: string | null;
    room_count: number;
    room_status: string | null;
    booking_id: number;
  }>(
    `SELECT b.check_in_date AS ci, b.check_out_date AS co,
            COALESCE(b.room_count, 1) AS room_count, r.status AS room_status, b.id AS booking_id
       FROM bookings b
       LEFT JOIN rooms r ON r.id = b.room_id AND r.hotel_id = b.hotel_id
      WHERE b.hotel_id = ? AND b.room_type_id = ?
        AND b.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date < ? AND b.check_out_date > ?
        AND NOT EXISTS (SELECT 1 FROM booking_rooms x WHERE x.booking_id = b.id)`,
    [hotelId, roomTypeId, co, ci]
  )) {
    if (ex > 0 && Number(m.booking_id) === ex) continue;
    const st = String(m.room_status ?? "").toUpperCase();
    if (st === "OOO" || st === "LOCK") continue;
    spread(String(m.ci ?? ""), String(m.co ?? ""), Math.max(1, toInt(m.room_count)));
  }

  return occ;
}

/**
 * 区间内最低剩余及对应那一晚（内部工具）
 *
 * occ 按入住日顺序插入，最小值相同时保留**最早**的那一晚，便于前台排查。
 * minRemain 可能为负（历史超卖数据），表示已经卖超了几间 —— 不去 clamp，
 * 让调用方自己决定对外怎么表述（小程序不返回负数，PC 文案里也做了 Math.max）。
 */
function minRemainOf(
  cap: number,
  occupied: Map<string, number>,
  checkInDate: string
): { minRemain: number; minNight: string } {
  let minRemain = cap;
  let minNight = checkInDate;
  for (const [night, used] of occupied) {
    const remain = cap - used;
    if (remain < minRemain) {
      minRemain = remain;
      minNight = night;
    }
  }
  return { minRemain, minNight };
}

/**
 * 房型库存判定（按晚）：null = 通过；否则返回给用户看的错误文案。
 *
 * 文案要能指出**哪一晚最低**：「A」在 11-25 ~ 11-27 只剩 1 间（11-26 当晚最低）——
 * 只报一个「库存不足」的话，前台不知道是该减间数还是换日期。
 *
 * PC 端只在写入事务内调用（`BEGIN IMMEDIATE` 已拿到写锁，这一遍才是权威的），
 * 失败时由调用方抛出去翻成「回新建页 + 明确文案」。
 *
 * @param roomTypeId 房型
 * @param roomTypeName 房型名（调用方已查好，本函数不再回查 room_types）
 * @param ci 入住日（含）
 * @param co 离店日（不含）
 * @param need 本次要订的间数
 */
export function stockShortage(
  db: StockDb,
  hotelId: number,
  roomTypeId: number,
  roomTypeName: string,
  ci: string,
  co: string,
  need: number
): string | null {
  const needCount = Math.max(1, toInt(need));
  const cap = physicalCapOfType(db, hotelId, roomTypeId);
  /*
   * 物理可售为 0（房型没有房间，或者全部是维修 / 锁房）必须拒绝：
   * 旧代码写 `if (cap <= 0) continue;` —— 跳过校验等于「无限可售」，
   * 而下游并没有别的房型校验兜底，维修房的单子就是这么超卖出去的。
   */
  if (cap <= 0) {
    return (
      `「${roomTypeName}」当前没有可售房（无物理房间，或全部为维修/锁房），` +
      `本次要订 ${needCount} 间，库存不足（整单未创建）`
    );
  }
  const occ = occupiedByNight(db, hotelId, roomTypeId, ci, co);
  const { minRemain, minNight } = minRemainOf(cap, occ, ci);
  if (minRemain < needCount) {
    return (
      `「${roomTypeName}」在 ${ci} ~ ${co} 只剩 ${Math.max(0, minRemain)} 间` +
      `（${minNight} 当晚最低），本次要订 ${needCount} 间，库存不足（整单未创建）`
    );
  }
  return null;
}

/** 一个房型在某区间内的按晚库存（`roomTypeStock` 的成员） */
export type RoomTypeStock = {
  /** 物理可售（房间数 − OOO − LOCK） */
  cap: number;
  /** 区间内**最低**的剩余（可能为负 = 历史超卖；对外展示请自己 clamp 到 0） */
  minRemain: number;
  /** 区间内的每一晚（入住日含、离店日不含；顺序即入住顺序） */
  nights: string[];
  /** 每一晚的占用，插入顺序 = 入住日顺序，含没有占用的 0 */
  occupied: Map<string, number>;
};

/**
 * 一次算全房型：Map<roomTypeId, {cap, minRemain, nights, occupied}> —— 给小程序的可售列表用。
 *
 * 小程序的 `/api/mini/rooms`、`/api/mini/room-types/[id]`、`/api/mini/bookings`
 * 都走这里，所以「列表里显示可订 1 间」和「下单时校验能不能订 1 间」是同一份数，
 * 不会出现列表说能订、点进去被拒（或反过来）的自相矛盾。
 *
 * 房型清单按 `room_types` 表取（同一 hotel_id），调用方不必先查一遍再传进来。
 */
export function roomTypeStock(
  db: StockDb,
  hotelId: number,
  ci: string,
  co: string
): Map<number, RoomTypeStock> {
  const out = new Map<number, RoomTypeStock>();
  for (const row of db.all<{ id: number }>(
    `SELECT id FROM room_types WHERE hotel_id = ? ORDER BY COALESCE(sort, 100), id`,
    [hotelId]
  )) {
    const typeId = Number(row.id);
    if (!typeId) continue;
    const cap = physicalCapOfType(db, hotelId, typeId);
    const occupied = occupiedByNight(db, hotelId, typeId, ci, co);
    const { minRemain } = minRemainOf(cap, occupied, ci);
    out.set(typeId, { cap, minRemain, nights: [...occupied.keys()], occupied });
  }
  return out;
}
