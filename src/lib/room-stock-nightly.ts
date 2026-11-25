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
 *   某一晚物理可售 = 该房型房间数 − 该晚处于维修/锁房窗口内的房间数
 *   某一晚占用     = 在住单 + 未入住明细（一行一间）+ 无明细旧主单（按 room_count）
 *   某一晚剩余     = 该晚物理可售 − 该晚占用
 *   判定           = 入住区间内**最低**的剩余 ≥ 本单要的间数
 *
 *   · 入住日含、离店日不含（`ci <= 该晚 && co > 该晚`）：
 *     A 占 11-25 一晚、B 占 11-26 一晚，二者不在任何一晚叠加。
 *   · **已转在住的房晚只计一次**：checkInAction 会把 `booking_rooms.stay_id`
 *     回填并把明细置 CHECKED_IN，这类明细由「在住单」那一支表达，明细支不再计。
 *   · 明细 / 主单挂在「该晚不可售」的房上时**不再计入占用**：那间房这一晚已经
 *     从物理可售里剔除了，再扣一次是重复扣减（与 room-stock.ts 的 blockedRooms 同口径）。
 *     「该晚不可售」= status ∈ {OOO,LOCK} 且落在 [block_from, block_to) 内（见下）。
 *   · 容量和占用都在**写入事务内**复查（PC 端见 actions.ts 的 tx，小程序端见
 *     bookings/route.ts 的 tx）：并发下由 `BEGIN IMMEDIATE` 的写锁 + 复查兜住。
 *   · 维修 / 锁房的**起止日期**（`rooms.block_from` / `block_to`，第 25 段迁移补列）：
 *       两列为空（老数据）      → 整段不可售（改造前的行为，一行都不放开）；
 *       两列都有值              → 只在 [block_from, block_to) 内不可售，区间外照常可售；
 *       只有 block_from         → 从该日起永久不可售（修完才会被前台改回 VC/VD）；
 *       只有 block_to           → 按老数据整段不可售（缺开始日就无法证明哪天开始，
 *                                 宁可多扣也不凭空放量）。
 *     唯一实现是 `roomBlockedOn()`，本文件的 physicalCapByNight / occupiedByNight
 *     与 room-stock.ts（房态页）、channels/stock-trigger.ts（渠道推送）共用它，
 *     所以「PC 能卖」与「渠道推出多少」不会分叉。
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

/* ============================================================ 维修 / 锁房窗口 */

/** 维修 / 锁房的状态集合 —— 只有这两种状态才看 block_from / block_to 窗口 */
const BLOCK_STATUSES = new Set(["OOO", "LOCK"]);

/** 一间房的「房态 + 维修/锁房窗口」三要素（`rooms` 里库存口径需要的全部列） */
export type RoomBlockInfo = {
  id: number;
  room_type_id: number | null;
  /** VC/VD/OC/OD/OOO/LOCK 之一；脏值按 VC 处理（与迁移脚本同口径） */
  status: string | null;
  /** 维修/锁房开始日（含）；`''` = 没有登记窗口（老数据） */
  block_from: string | null;
  /** 维修/锁房结束日（不含）；`''` = 没登记 / 只有开始日 */
  block_to: string | null;
};

/** 该房态是不是「维修 / 锁房」（只有它们会被 block_from/block_to 约束） */
export function isBlockStatus(status: unknown): boolean {
  return BLOCK_STATUSES.has(String(status ?? "").trim().toUpperCase());
}

/**
 * 日期列归一成 `YYYY-MM-DD`；不是**真实存在**的日期一律返回 `''`
 *
 * 为什么要归一：`block_from` 是 TEXT 列，前台/迁移/导入历史数据时可能带时间
 * （`2026-11-26T00:00:00`）或脏值。口径只关心「日」，所以统一截到前 10 位；
 * 脏值当「没有这个日期」处理 —— 对 OOO/LOCK 来说「没有开始日」= 整段不可售，
 * 也就是脏数据只会让库存**更保守**，不会凭空放量。
 *
 * 为什么要回读校验而不是只测格式：`2026-13-99` 的**形状**是合法的
 * `YYYY-MM-DD`，但 `new Date()` 会得到 Invalid Date；而 `2026-02-31` 会被
 * 顺延成 3 月 3 日 —— 直接拿去比字符串会静默算错（13 月永远排在 11 月之后，
 * 于是「维修从 13 月开始」被当成还没开始 → 放量）。回读一次才认。
 */
function normDay(value: unknown): string {
  const s = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const back = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return back === s ? s : "";
}

/**
 * 某间房在**某一晚**是否不可售（维修 / 锁房窗口口径的**唯一实现**）
 *
 *   status 不是 OOO/LOCK                        → 可售（窗口对它无意义）
 *   block_from 为空（含脏值 / 只有 block_to）    → 不可售（老数据 = 整段排除）
 *   该晚 < block_from                           → 可售（窗口还没开始）
 *   该晚 ≥ block_from 且没有 block_to           → 不可售（从该日起永久）
 *   否则                                        → `block_to` 之前不可售（[from, to) 半开）
 *
 * 三处库存口径（本文件的 physicalCapByNight / room-stock.ts / stock-trigger.ts）
 * 全部只调这一个函数，避免「房态页扣了、渠道没扣」这类分叉。
 */
export function roomBlockedOn(
  room: { status?: unknown; block_from?: unknown; block_to?: unknown },
  night: string
): boolean {
  if (!isBlockStatus(room.status)) return false;
  const from = normDay(room.block_from);
  if (!from) return true; // 没有开始日：整段不可售（老数据 / 脏数据都走这支，保守）
  const to = normDay(room.block_to);
  if (night < from) return false; // 窗口开始之前：照常可售
  if (!to) return true; // 只有开始日：从那天起永久不可售
  return night < to; // [block_from, block_to) 内不可售
}

/** 只需要「一条查询」能力的句柄（loadRoomBlocks 用；与 `@/lib/db` 的 `all` 同构） */
export type RoomReadDb = Pick<StockDb, "all">;

/** 已经证明「缺 block_from/block_to 列」的查询函数（老库，按 db.all 引用记住） */
const noBlockColumns = new WeakSet<RoomReadDb["all"]>();

/**
 * 读本店（可限定房型）每间房的「房态 + 维修窗口」
 *
 * 老库兼容：`block_from` / `block_to` 是第 25 段迁移才加的列，代码先上、迁移后跑
 * （或某个只读副本还没迁移）时，SELECT 会报 `no such column`。这种情况退回
 * 「两列为空」的口径 —— 也就是改造前的老行为（OOO/LOCK 整段排除），
 * 绝不会因为读不到日期就把维修房放开。
 *
 * 探测结果按 `db.all` 的函数引用缓存（WeakMap）：同一次进程内只会在第一次
 * 付一次失败探测的代价，之后直接走正确的 SQL。
 */
export function loadRoomBlocks(db: RoomReadDb, hotelId: number, roomTypeId?: number): RoomBlockInfo[] {
  const hasType = roomTypeId !== undefined && roomTypeId !== null;
  const where = hasType ? `WHERE hotel_id = ? AND room_type_id = ?` : `WHERE hotel_id = ?`;
  const params: unknown[] = hasType ? [hotelId, roomTypeId] : [hotelId];
  const full = `SELECT id, room_type_id, status, block_from, block_to FROM rooms ${where} ORDER BY id`;

  /* 老库（缺列）：直接走 NULL 兜底 */
  if (noBlockColumns.has(db.all)) {
    return db.all<RoomBlockInfo>(
      `SELECT id, room_type_id, status, NULL AS block_from, NULL AS block_to FROM rooms ${where} ORDER BY id`,
      params
    );
  }
  try {
    return db.all<RoomBlockInfo>(full, params);
  } catch {
    noBlockColumns.add(db.all);
    return db.all<RoomBlockInfo>(
      `SELECT id, room_type_id, status, NULL AS block_from, NULL AS block_to FROM rooms ${where} ORDER BY id`,
      params
    );
  }
}

/**
 * 老口径：**不带日期**的物理可售 = 房间数 − 所有 OOO/LOCK 房（最严口径）
 *
 * 保留它是因为「没有日期就问不出某晚」的调用点仍然存在：
 *   · `src/app/api/mini/bookings/_booking-shared.ts` 的 remainingRoomsExcludingBooking
 *     （小程序改单，签名里只有区间、没有逐晚容量表）；
 *   · 脏日期 / 钟点房（`co <= ci`）算不出「晚」时的兜底。
 * 这两处拿到的都是**偏小**的容量 —— 最坏是多拒一单，绝不会把维修房卖出去。
 *
 * **按晚判定请用 physicalCapByNight**：那才是三处库存口径的正式实现。
 *
 * 为什么 OOO / LOCK 要一起扣：
 *   · 维修房卖出去，前台无法排房（客人到店才知道房间在修）；
 *   · 锁房是「人为留着不卖」的房（渠道预留 / 内部用房 / 损坏待处理），
 *     同样不是可售库存，扣 OOO 不扣 LOCK 就是把锁房的量白送出去。
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
 * 某房型在 `[ci, co)` **每一晚**的物理可售房间数（Map<日期, 间数>）
 *
 * 逐晚口径（`status` 快照 + 维修窗口，不是「整段排除」）：
 *   某晚物理可售 = 该房型房间数 − 该晚 `roomBlockedOn()` 为真的房间数
 *
 * 这正是「维修 / 锁房只挡住窗口内的房晚」的落地：一间房登记 11-26 ~ 11-28 维修，
 * 11-25 与 11-28 的房晚仍然可卖（11-28 是结束日，**不含**），11-26 / 11-27 不可卖；
 * 没有登记窗口的老数据则与改造前完全一致（整段不可售）。
 *
 * 脏日期（非法 / `co <= ci`）→ 空 Map：没有可算的房晚，由调用方按
 * `physicalCapOfType`（整段严格口径）兜底，保持改造前行为。
 *
 * 返回的 Map 包含区间内**每一晚**（顺序即入住日顺序），与 occupiedByNight 的键一致。
 */
export function physicalCapByNight(
  db: StockDb,
  hotelId: number,
  roomTypeId: number,
  ci: string,
  co: string
): Map<string, number> {
  const out = new Map<string, number>();
  const nights = eachNight(ci, co);
  if (nights.length === 0) return out;

  const rooms = loadRoomBlocks(db, hotelId, roomTypeId);
  const total = rooms.length;
  /* 只有 OOO/LOCK 的房才可能被扣：先筛出来，内层循环就只剩这几间 */
  const blocked = rooms.filter((r) => isBlockStatus(r.status));

  for (const night of nights) {
    let cap = total;
    for (const room of blocked) {
      if (roomBlockedOn(room, night)) cap -= 1;
    }
    out.set(night, cap);
  }
  return out;
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
 * ② / ③ 若挂在**该晚不可售**的房上 → 那一晚跳过：物理可售已经把那一晚剔除了，
 * 再扣一次就是重复扣减。注意「不可售」是**逐晚**判定的（roomBlockedOn）：
 * 同一间维修房，窗口内的房晚跳过、窗口外的房晚照常计占用 —— 否则
 * 「登记了 11-26~11-28 维修」的房在 11-25 被预订后不会被计入占用（会超卖）。
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
  /** 把 [from, to) 这段的占用 +n 摊到与入住区间相交的每一晚（skip 掉的房晚不计） */
  const spread = (from: string, to: string, n: number, skipBlocked?: { status?: unknown; block_from?: unknown; block_to?: unknown }) => {
    if (!from || !to) return;
    for (const night of nights) {
      if (from <= night && to > night) {
        if (skipBlocked && roomBlockedOn(skipBlocked, night)) continue;
        occ.set(night, (occ.get(night) ?? 0) + n);
      }
    }
  };

  /*
   * 房间 id → 房态 + 维修窗口（逐晚判定要用）
   *
   * 为什么单独查一遍而不是在下面两条 SQL 里 JOIN rooms.block_from：
   *   · 列可能不存在（老库还没跑第 25 段迁移），JOIN 会直接把整条查询打挂；
   *   · loadRoomBlocks 已经把「缺列 → 当空处理」的兜底收在一处，
   *     这里只在内存里做 Map 查表，不会多出第二份老库兼容逻辑。
   * 传 hotelId 而不是 roomTypeId：明细/主单偶尔挂到别的房型的房上（数据漂移），
   * 按店取全量才不会漏掉那几行。
   */
  const blockInfoById = new Map<number, RoomBlockInfo>();
  for (const r of loadRoomBlocks(db, hotelId)) blockInfoById.set(Number(r.id), r);
  /** 排房/主单指向的房间若该晚不可售，就把这一晚从占用里摘掉（避免与容量重复扣） */
  const blockedSkipOf = (roomId: unknown) => {
    const id = toInt(roomId);
    if (id <= 0) return undefined;
    const info = blockInfoById.get(id);
    return info && isBlockStatus(info.status) ? info : undefined;
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
  for (const d of db.all<{
    ci: string | null;
    co: string | null;
    room_id: number | null;
    booking_id: number;
  }>(
    `SELECT br.check_in_date AS ci, br.check_out_date AS co, br.room_id AS room_id, b.id AS booking_id
       FROM booking_rooms br
       JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
      WHERE br.hotel_id = ? AND br.room_type_id = ?
        AND br.status IN ('PENDING','CONFIRMED')
        AND b.status IN ('PENDING','CONFIRMED')
        AND br.check_in_date < ? AND br.check_out_date > ?`,
    [hotelId, roomTypeId, co, ci]
  )) {
    /* 改单场景：本单自己的占用不算（否则改到同一区间恒报「只剩 0 间」） */
    if (ex > 0 && Number(d.booking_id) === ex) continue;
    /*
     * 明细挂在维修 / 锁房上：物理可售已经把**该晚**剔除了，再计一次就是重复扣减。
     * 窗口外的房晚仍然照常计 —— 否则「下周才维修」的房被订掉后不会被算进占用。
     */
    spread(String(d.ci ?? ""), String(d.co ?? ""), 1, blockedSkipOf(d.room_id));
  }

  /* ③ 没有明细的旧订单（迁移前的老数据）→ 按主单 room_count 算 */
  for (const m of db.all<{
    ci: string | null;
    co: string | null;
    room_count: number;
    room_id: number | null;
    booking_id: number;
  }>(
    `SELECT b.check_in_date AS ci, b.check_out_date AS co,
            COALESCE(b.room_count, 1) AS room_count, b.room_id AS room_id, b.id AS booking_id
       FROM bookings b
      WHERE b.hotel_id = ? AND b.room_type_id = ?
        AND b.status IN ('PENDING','CONFIRMED')
        AND b.check_in_date < ? AND b.check_out_date > ?
        AND NOT EXISTS (SELECT 1 FROM booking_rooms x WHERE x.booking_id = b.id)`,
    [hotelId, roomTypeId, co, ci]
  )) {
    if (ex > 0 && Number(m.booking_id) === ex) continue;
    spread(String(m.ci ?? ""), String(m.co ?? ""), Math.max(1, toInt(m.room_count)), blockedSkipOf(m.room_id));
  }

  return occ;
}

/**
 * 区间内最低剩余及对应那一晚（内部工具）
 *
 * 逐晚口径：剩余 = **该晚**物理可售 − 该晚占用（容量按晚取，不是区间共用一个大数）。
 * occupied 按入住日顺序插入，最小值相同时保留**最早**的那一晚，便于前台排查。
 * minRemain 可能为负（历史超卖数据），表示已经卖超了几间 —— 不去 clamp，
 * 让调用方自己决定对外怎么表述（小程序不返回负数，PC 文案里也做了 Math.max）。
 *
 * @param caps 每晚物理可售（physicalCapByNight 的结果；键与 occupied 一致）
 */
function minRemainOf(
  caps: Map<string, number>,
  occupied: Map<string, number>,
  checkInDate: string
): { minRemain: number; minNight: string } {
  let minRemain = Number.POSITIVE_INFINITY;
  let minNight = checkInDate;
  for (const [night, used] of occupied) {
    const remain = (caps.get(night) ?? 0) - used;
    if (remain < minRemain) {
      minRemain = remain;
      minNight = night;
    }
  }
  /* 没有可算的房晚（脏日期 / 钟点房）：退回入住日那一晚的容量 */
  if (!Number.isFinite(minRemain)) return { minRemain: caps.get(checkInDate) ?? 0, minNight: checkInDate };
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

  /*
   * 逐晚容量（维修 / 锁房窗口在这里生效）
   *
   * 脏日期 / 钟点房（`co <= ci`）算不出「晚」：退回不带日期的严格口径
   * physicalCapOfType（所有 OOO/LOCK 房都不算可售），行为与改造前完全一致 ——
   * 不能因为「算不出房晚」就当成无限可售。
   */
  const caps = physicalCapByNight(db, hotelId, roomTypeId, ci, co);
  const noNights = caps.size === 0;
  const maxCap = noNights ? physicalCapOfType(db, hotelId, roomTypeId) : Math.max(...caps.values());

  /*
   * 区间内**一晚都卖不了**（房型没有房间，或者每一晚都被维修 / 锁房占满）必须拒绝：
   * 旧代码写 `if (cap <= 0) continue;` —— 跳过校验等于「无限可售」，
   * 而下游并没有别的房型校验兜底，维修房的单子就是这么超卖出去的。
   *
   * 注意判的是「区间内最高的那一晚容量」也为 0：只要有一晚能卖，就交给下面的
   * 「最低剩余」分支给出精确文案（「只剩 0 间（11-26 当晚最低）」），
   * 而不是笼统地说「没有可售房」。
   */
  if (maxCap <= 0) {
    return (
      `「${roomTypeName}」当前没有可售房（无物理房间，或全部为维修/锁房），` +
      `本次要订 ${needCount} 间，库存不足（整单未创建）`
    );
  }
  const occ = occupiedByNight(db, hotelId, roomTypeId, ci, co);
  const { minRemain, minNight } = noNights
    ? { minRemain: maxCap, minNight: ci }
    : minRemainOf(caps, occ, ci);
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
  /** 区间内**最低**的物理可售（每晚容量不同的来源就是维修/锁房窗口） */
  cap: number;
  /** 每一晚的物理可售（Map<日期, 间数>；顺序即入住日顺序，脏日期为空 Map） */
  capByNight: Map<string, number>;
  /** 区间内**最低**的剩余（可能为负 = 历史超卖；对外展示请自己 clamp 到 0） */
  minRemain: number;
  /** 区间内的每一晚（入住日含、离店日不含；顺序即入住顺序） */
  nights: string[];
  /** 每一晚的占用，插入顺序 = 入住日顺序，含没有占用的 0 */
  occupied: Map<string, number>;
};

/**
 * 一次算全房型：Map<roomTypeId, {cap, capByNight, minRemain, nights, occupied}> —— 给小程序的可售列表用。
 *
 * 小程序的 `/api/mini/rooms`、`/api/mini/room-types/[id]`、`/api/mini/bookings`
 * 都走这里，所以「列表里显示可订 1 间」和「下单时校验能不能订 1 间」是同一份数，
 * 不会出现列表说能订、点进去被拒（或反过来）的自相矛盾。
 *
 * 与 PC 建单（stockShortage）**逐字同口径**：都按 physicalCapByNight 逐晚容量 +
 * occupiedByNight 逐晚占用算最低剩余，所以「PC 判定通过」⇔「小程序 remaining ≥ need」。
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
    const occupied = occupiedByNight(db, hotelId, typeId, ci, co);
    const capByNight = physicalCapByNight(db, hotelId, typeId, ci, co);
    if (capByNight.size === 0) {
      /*
       * 脏日期 / 钟点房：没有「晚」可算 —— 与 stockShortage 的兜底保持一致
       * （整段严格口径），这样两个入口在异常入参上也不会给出相反结论。
       */
      const cap = physicalCapOfType(db, hotelId, typeId);
      out.set(typeId, { cap, capByNight, minRemain: cap, nights: [...occupied.keys()], occupied });
      continue;
    }
    const { minRemain } = minRemainOf(capByNight, occupied, ci);
    out.set(typeId, {
      cap: Math.min(...capByNight.values()),
      capByNight,
      minRemain,
      nights: [...occupied.keys()],
      occupied,
    });
  }
  return out;
}
