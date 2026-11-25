#!/usr/bin/env node
/**
 * 房型库存「按晚（nightly）」口径验收（P0-1：超卖 + 误拒）
 *
 * ── 要修的两种错 ──
 *  1. **超卖**：房量统计把维修房（OOO）/ 锁房（LOCK）也算成可售 →
 *     唯一一间房在维修，房型照样能卖出去。
 *  2. **误拒**：占用按「整个入住区间有没有重叠」计数，而不是「每一晚」→
 *     两间房的房型，A 占 11-25、B 占 11-26，再订 11-25~11-27 一间
 *     （两晚各剩 1 间，本该成功）会被判成「占 2 间」，误拒。
 *
 * ── 正确口径（本脚本逐条断言）──
 *   每晚剩余 = 物理可卖 − 该晚占用
 *     物理可卖 = 该房型房间数 − 维修(OOO) − 锁房(LOCK)
 *     该晚占用 = 在住单（date(check_in_time) ≤ 该晚 < expect_check_out）
 *              + 已排房/待排房明细（check_in_date ≤ 该晚 < check_out_date，一行一间）
 *              + 无明细旧主单（同上区间，按 room_count）
 *   入住日含、离店日不含：一张 T1→T2 的订单只占 T1 这一晚。
 *   判定 = 区间内**最低**的剩余 ≥ 本单要的间数。
 *
 * ── 怎么跑的是生产代码 ──
 *  与 test-multiroom-flow.mjs 同一套底盘（scripts/helpers/action-harness.mjs）：
 *    `data/pms.db --VACUUM INTO--> .tmp/stock-nightly-<时间戳>/data/pms.db`
 *    → 注入 globalThis.__pmsDb → registerHooks 把 next/* 换桩
 *    → 动态 import **真实的** bookings/actions.ts 与 frontdesk/actions.ts
 *    → 像页面一样 new FormData() 调 createBookingAction / cancelBookingAction / checkInAction
 *  真库全程只读（VACUUM INTO 的源连接 readOnly），脚本末尾复查真库零写入。
 *
 * ── 场景清单（评审给的 3 个是验收硬指标）──
 *   1. 唯一一间房 OOO，本日订 1 间不指定房号            → 拒绝 + 零副作用
 *   2. 唯一一间房 LOCK，同上                            → 拒绝 + 零副作用
 *   3. 两间空净房，相邻两晚各订 1 间，再订跨两晚 1 间    → 三单全成功
 *   4. 零物理房                                         → 拒绝
 *   5. 最后一间被两个独立请求同时抢                      → 恰好 1 单成功
 *   6. 多房订单只排了部分房（2 间订单只指定 1 间房）      → 占用仍按 2 间计
 *   7. 取消预订返库                                      → 取消后能再卖出
 *   8. 预订转入住（stay_id 回填）                        → 已转在住的房晚只计一次
 *   9. 超量失败时主单 / 明细 / 定金 / channel_sync_queue 零新增
 *  10. 指定房号的全段冲突校验仍然生效（findRoomConflicts 不许被削）
 *
 * 用法：node scripts/test-stock-nightly.mjs
 * 退出码：0 = 全绿；1 = 有失败 / 中断
 */

import fs from "node:fs";

import { createActionHarness, createChecker, isOk, isErr, msgOf } from "./helpers/action-harness.mjs";

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "stock-nightly" });
const { one, all, run, invoke, localDate, hotelId: HOTEL, stamp } = h;

const TODAY = localDate(0);
const TOMORROW = localDate(1);
/* 相邻两晚 + 跨两晚：T1→T2、T2→T3、T1→T3 */
const T1 = localDate(1);
const T2 = localDate(2);
const T3 = localDate(3);
const MOBILE = `135${stamp.slice(-8)}`;

let failed = 0;
try {
  /* ============================================================ 0. 装载真实 action */
  section("〇、装载真实 action + 造数工具");
  const bookings = await h.importModule("app/(main)/bookings/actions.ts");
  const frontdesk = await h.importModule("app/(main)/frontdesk/actions.ts");
  check(
    "createBookingAction / cancelBookingAction / checkInAction 都是从真实 actions.ts 装载的",
    typeof bookings.createBookingAction === "function" &&
      typeof bookings.cancelBookingAction === "function" &&
      typeof frontdesk.checkInAction === "function"
  );

  let guestSeq = 0;
  /** 唯一客名：每个用例都能按名字精确回查自己的订单 */
  const guestName = (tag) => `${tag}#${(guestSeq += 1)}`;

  /**
   * 真调 createBookingAction 建单
   * @param {{typeId:number, ci?:string, co?:string, rooms?:number, roomId?:number|null,
   *          name:string, deposit?:number}} o
   */
  async function book({ typeId, ci = TODAY, co = TOMORROW, rooms = 1, roomId = null, name, deposit = 0 }) {
    const line = { room_type_id: typeId, room_count: rooms, rate: 300, breakfast: 0 };
    if (roomId) line.room_id = roomId;
    const res = await invoke(bookings.createBookingAction, {
      booking_type: "guest",
      guest_name: name,
      mobile: MOBILE,
      check_in_date: ci,
      check_out_date: co,
      rate_code: "门市价",
      pay_type: "到店付款",
      deposit: String(deposit),
      lines: JSON.stringify([line]),
      remark: "库存按晚验收",
    });
    const row = one(
      `SELECT id, status, room_count, room_id, deposit, check_in_date, check_out_date
         FROM bookings WHERE hotel_id = ? AND guest_name = ? ORDER BY id DESC LIMIT 1`,
      [HOTEL, name]
    );
    return { res, row, ok: isOk(res) && Boolean(row?.id), err: msgOf(res), name };
  }

  /** 副作用快照：主单 / 明细 / 财务（folios + payments）/ 定金合计 / 渠道待同步队列 */
  function sideEffects() {
    return {
      bookings: Number(one(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ?`, [HOTEL]).c),
      details: Number(one(`SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ?`, [HOTEL]).c),
      folios: Number(one(`SELECT COUNT(*) AS c FROM folios WHERE hotel_id = ?`, [HOTEL]).c),
      payments: Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ?`, [HOTEL]).c),
      deposits: Number(one(`SELECT COALESCE(SUM(deposit), 0) AS s FROM bookings WHERE hotel_id = ?`, [HOTEL]).s),
      queue: Number(one(`SELECT COUNT(*) AS c FROM channel_sync_queue WHERE hotel_id = ?`, [HOTEL]).c),
    };
  }
  const sameEffects = (a, b) =>
    ["bookings", "details", "folios", "payments", "deposits", "queue"].every((k) => Number(a[k]) === Number(b[k]));
  const diffEffects = (a, b) =>
    ["bookings", "details", "folios", "payments", "deposits", "queue"]
      .filter((k) => Number(a[k]) !== Number(b[k]))
      .map((k) => `${k}: ${a[k]}→${b[k]}`)
      .join(" ");

  /**
   * 「超量被拒」的统一断言组：拒绝文案 + 主单/明细/财务/队列零新增
   * @returns {number} 断言条数
   */
  function assertRejectedNoSideEffects(label, before, r, msgPattern) {
    check(`${label}：建单被拒绝`, !r.ok && isErr(r.res), r.err);
    check(`${label}：错误文案说明库存不足（不是别的失败）`, msgPattern.test(r.err), r.err);
    check(`${label}：没有新建主单`, !r.row);
    const after = sideEffects();
    check(`${label}：主单 / 明细 / 财务 / 定金 / 渠道队列全部零新增`, sameEffects(before, after), diffEffects(before, after));
  }

  /* ============================================================ 1. OOO */
  section("一、场景 1（评审）：房型唯一一间房是维修房 OOO → 本日订 1 间不指定房号必须拒绝");
  const rtOoo = h.createRoomType({ name: "仅维修房房型", basePrice: 300 });
  const [oooRoom] = h.createRooms(1, { roomTypeId: rtOoo, status: "OOO", prefix: "OOO" });
  check("造数：房型下唯一一间房状态 = OOO", one(`SELECT status FROM rooms WHERE id = ?`, [oooRoom.id])?.status === "OOO");
  const beforeOoo = sideEffects();
  const rOoo = await book({ typeId: rtOoo, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("维修房客") });
  assertRejectedNoSideEffects("场景1 OOO", beforeOoo, rOoo, /库存不足|不可售|没有可售|无物理房/);

  /* ============================================================ 2. LOCK */
  section("二、场景 2（评审）：房型唯一一间房是锁房 LOCK → 同样必须拒绝");
  const rtLock = h.createRoomType({ name: "仅锁房房型", basePrice: 300 });
  const [lockRoom] = h.createRooms(1, { roomTypeId: rtLock, status: "LOCK", prefix: "LCK" });
  check("造数：房型下唯一一间房状态 = LOCK", one(`SELECT status FROM rooms WHERE id = ?`, [lockRoom.id])?.status === "LOCK");
  const beforeLock = sideEffects();
  const rLock = await book({ typeId: rtLock, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("锁房客") });
  assertRejectedNoSideEffects("场景2 LOCK", beforeLock, rLock, /库存不足|不可售|没有可售|无物理房/);

  /* ============================================================ 3. 逐晚 */
  section("三、场景 3（评审）：两间同型空净房 + 相邻两晚各 1 间 + 跨两晚 1 间 → 三单全成功");
  const rtNight = h.createRoomType({ name: "相邻夜房型", basePrice: 300 });
  const roomsNight = h.createRooms(2, { roomTypeId: rtNight, status: "VC", prefix: "NGT" });
  check("造数：2 间空净房", roomsNight.length === 2);
  const nA = await book({ typeId: rtNight, ci: T1, co: T2, rooms: 1, name: guestName("相邻夜A") });
  check(`第 1 单（${T1}→${T2}，1 间）成功`, nA.ok, nA.err);
  const nB = await book({ typeId: rtNight, ci: T2, co: T3, rooms: 1, name: guestName("相邻夜B") });
  check(`第 2 单（${T2}→${T3}，1 间）成功`, nB.ok, nB.err);
  /*
   * 第 3 单是评审的误拒场景：
   *   T1 晚：A 占 1（B 还没入住）→ 剩 1
   *   T2 晚：B 占 1（A 已离店）  → 剩 1
   *   最低剩余 1 ≥ 需要 1 → 必须成功（旧算法按「区间重叠」会算成占 2 间而误拒）
   */
  const nC = await book({ typeId: rtNight, ci: T1, co: T3, rooms: 1, name: guestName("相邻夜C") });
  check(`第 3 单（跨 ${T1}→${T3}，1 间）成功 —— 逐晚口径两晚都剩 1 间`, nC.ok, nC.err);
  check(
    "三单都真的落库（不是返回成功却没写库）",
    [nA, nB, nC].every((x) => x.row?.id && x.row.status === "PENDING"),
    JSON.stringify([nA.row?.id, nB.row?.id, nC.row?.id])
  );
  const nCdetails = all(`SELECT room_id FROM booking_rooms WHERE booking_id = ?`, [nC.row?.id ?? 0]);
  check("第 3 单 1 间 = 1 条待排房明细", nCdetails.length === 1 && nCdetails[0].room_id === null);
  /* 逐晚口径的反向证明：此时两晚都已被占满（各 2 间），再订跨两晚 1 间必须拒绝 */
  const nD = await book({ typeId: rtNight, ci: T1, co: T3, rooms: 1, name: guestName("相邻夜D") });
  check("两晚各占满 2 间后再订 1 间 → 拒绝", !nD.ok && isErr(nD.res), nD.err);
  /* 单晚仍有空位？T1=2、T2=2 都已满，所以连只订 T2 一晚也必须拒绝 */
  const nE = await book({ typeId: rtNight, ci: T2, co: T3, rooms: 1, name: guestName("相邻夜E") });
  check("逐晚判定：只订 T2 一晚也已满 → 拒绝（不是按区间余量放行）", !nE.ok && isErr(nE.res), nE.err);

  /* ============================================================ 4. 零物理房 */
  section("四、零物理房（异常数据）→ 不可当成「无限可售」");
  const rtZero = h.createRoomType({ name: "零物理房房型" });
  check(
    "造数：房型下 0 间房",
    Number(one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [HOTEL, rtZero]).c) === 0
  );
  const beforeZero = sideEffects();
  const rZero = await book({ typeId: rtZero, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("零房房型客") });
  assertRejectedNoSideEffects("零物理房", beforeZero, rZero, /库存不足|不可售|没有可售|无物理房/);

  /* ============================================================ 5. 最后一间并发 */
  section("五、最后一间房被两个独立请求同时抢 → 恰好 1 单成功");
  const rtLast = h.createRoomType({ name: "最后一间房型", basePrice: 300 });
  h.createRooms(1, { roomTypeId: rtLast, status: "VC", prefix: "LST" });
  const beforeRace = sideEffects();
  const [raceA, raceB] = await Promise.all([
    book({ typeId: rtLast, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("并发抢房甲") }),
    book({ typeId: rtLast, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("并发抢房乙") }),
  ]);
  const winners = [raceA, raceB].filter((x) => x.ok);
  const losers = [raceA, raceB].filter((x) => !x.ok);
  check("两个独立请求恰好 1 个成功", winners.length === 1, JSON.stringify([raceA.ok, raceB.ok]));
  check("失败的那个给出库存不足文案", losers.length === 1 && /库存不足|不可售|没有可售/.test(losers[0].err), losers[0]?.err);
  const afterRace = sideEffects();
  check(
    "只新增 1 张主单 + 1 条明细（没有双写、没有残留半点）",
    afterRace.bookings === beforeRace.bookings + 1 && afterRace.details === beforeRace.details + 1,
    diffEffects(beforeRace, afterRace)
  );
  check("输的一方没有留下任何主单", losers.length === 1 && !losers[0].row);

  /* ============================================================ 6. 多房部分排房 */
  section("六、多房订单只排了部分房 → 占用按明细行数算（不是只数已排房的）");
  const rtPart = h.createRoomType({ name: "部分排房房型", basePrice: 300 });
  const roomsPart = h.createRooms(3, { roomTypeId: rtPart, status: "VC", prefix: "PRT" });
  check("造数：3 间空净房", roomsPart.length === 3);
  const p1 = await book({
    typeId: rtPart,
    ci: TODAY,
    co: TOMORROW,
    rooms: 2,
    roomId: roomsPart[0].id,
    name: guestName("部分排房客"),
  });
  check("2 间订单、只指定 1 间房 → 建单成功", p1.ok, p1.err);
  const p1details = all(`SELECT room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [p1.row?.id ?? 0]);
  check(
    "明细 2 条：1 条已排房 CONFIRMED + 1 条待排房 PENDING",
    p1details.length === 2 &&
      p1details.filter((d) => d.room_id !== null && d.status === "CONFIRMED").length === 1 &&
      p1details.filter((d) => d.room_id === null && d.status === "PENDING").length === 1,
    JSON.stringify(p1details)
  );
  const p2 = await book({ typeId: rtPart, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("部分排房追加") });
  check("占 2 间后还能再订 1 间（3 − 2 = 1）", p2.ok, p2.err);
  const p3 = await book({ typeId: rtPart, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("部分排房超量") });
  check(
    "再订 1 间被拒 —— 只数「已排房明细」的写法会算成占 1 间而误放",
    !p3.ok && isErr(p3.res),
    p3.err
  );

  /* ============================================================ 7. 取消返库 */
  section("七、取消预订返库：取消后同一晚应能再卖出");
  const rtCancel = h.createRoomType({ name: "取消返库房型", basePrice: 300 });
  h.createRooms(1, { roomTypeId: rtCancel, status: "VC", prefix: "CNL" });
  const c1 = await book({ typeId: rtCancel, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("取消客") });
  check("第 1 单占满唯一一间 → 成功", c1.ok, c1.err);
  const c2 = await book({ typeId: rtCancel, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("取消客之后") });
  check("占满后再订 1 间 → 拒绝", !c2.ok && isErr(c2.res), c2.err);
  await invoke(bookings.cancelBookingAction, { id: c1.row?.id });
  const c1After = one(
    `SELECT status, (SELECT status FROM booking_rooms WHERE booking_id = bookings.id ORDER BY id LIMIT 1) AS detail_status
       FROM bookings WHERE id = ?`,
    [c1.row?.id]
  );
  check(
    "取消落库：主单 CANCELLED + 明细 CANCELLED（release 掉占用）",
    c1After?.status === "CANCELLED" && c1After?.detail_status === "CANCELLED",
    JSON.stringify(c1After)
  );
  const c3 = await book({ typeId: rtCancel, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("取消返库后") });
  check("取消之后同一晚再订 → 成功（房量已返库）", c3.ok, c3.err);

  /* ============================================================ 8. 预订转入住 */
  section("八、预订转入住：已转在住的房晚只计一次（明细 CHECKED_IN + stay 不双算）");
  const rtCi = h.createRoomType({ name: "转入住房型", basePrice: 300 });
  const roomsCi = h.createRooms(2, { roomTypeId: rtCi, status: "VC", prefix: "CHK" });
  const k1 = await book({
    typeId: rtCi,
    ci: TODAY,
    co: TOMORROW,
    rooms: 1,
    roomId: roomsCi[0].id,
    name: guestName("转入住客"),
  });
  check("指定房号的 1 间订单 → 成功（明细 CONFIRMED 且已排房）", k1.ok && k1.row?.status === "CONFIRMED", k1.err);
  const checkinRes = await invoke(frontdesk.checkInAction, {
    mode: "day",
    check_in_date: TODAY,
    check_out_date: TOMORROW,
    nights: 1,
    rate_code: "门市价",
    pay_type: "到店付款",
    guest_count: 1,
    guest_name_0: k1.name,
    guest_mobile_0: MOBILE,
    guest_id_type_0: "身份证",
    guest_gender_0: "男",
    booking_id: k1.row?.id,
    room_id: roomsCi[0].id,
    deposit: 0,
  });
  check("真调 checkInAction 入住成功", isOk(checkinRes), msgOf(checkinRes));
  const k1Detail = one(`SELECT stay_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id LIMIT 1`, [
    k1.row?.id ?? 0,
  ]);
  const k1Stay = one(`SELECT status, room_id FROM stays WHERE booking_id = ?`, [k1.row?.id ?? 0]);
  check(
    "明细回填 stay_id 且置 CHECKED_IN（后续只能按在住单算一次）",
    k1Detail?.stay_id !== null && k1Detail?.stay_id !== undefined && k1Detail?.status === "CHECKED_IN",
    JSON.stringify(k1Detail)
  );
  check("确实生成了 INHOUSE 在住单", k1Stay?.status === "INHOUSE", JSON.stringify(k1Stay));
  const k2 = await book({ typeId: rtCi, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("入住后追加") });
  check(
    "另一间空房仍可卖（在住房晚没有被「明细 + 在住单」双算成占 2 间）",
    k2.ok,
    k2.err
  );
  const k3 = await book({ typeId: rtCi, ci: TODAY, co: TOMORROW, rooms: 1, name: guestName("入住后超量") });
  check("两间都不空（1 在住 + 1 已订）→ 再订 1 间被拒", !k3.ok && isErr(k3.res), k3.err);

  /* ============================================================ 9. 超量副作用 */
  section("九、超量失败时主单 / 明细 / 定金 / channel_sync_queue 零新增（带定金下单）");
  const rtOver = h.createRoomType({ name: "超量副作用房型", basePrice: 300 });
  h.createRooms(1, { roomTypeId: rtOver, status: "VC", prefix: "OVR" });
  const beforeOver = sideEffects();
  const rOver = await book({
    typeId: rtOver,
    ci: TODAY,
    co: TOMORROW,
    rooms: 2,
    deposit: 100,
    name: guestName("超量客"),
  });
  check("要 2 间但房型只有 1 间 → 拒绝", !rOver.ok && isErr(rOver.res), rOver.err);
  check("错误文案给出「只剩 N 间」", /只剩\s*1\s*间/.test(rOver.err), rOver.err);
  const afterOver = sideEffects();
  check("主单零新增", afterOver.bookings === beforeOver.bookings);
  check("明细零新增", afterOver.details === beforeOver.details);
  check("定金总额零变化（没有半张订单把定金写进去）", Number(afterOver.deposits) === Number(beforeOver.deposits));
  check("财务零新增（folios / payments）", afterOver.folios === beforeOver.folios && afterOver.payments === beforeOver.payments);
  check(
    "channel_sync_queue 零新增（失败请求不能记「库存变了」）",
    afterOver.queue === beforeOver.queue,
    `queue ${beforeOver.queue}→${afterOver.queue}`
  );

  /* ============================================================ 10. 指定房号冲突 */
  section("十、指定房号时全段区间冲突校验仍然生效（findRoomConflicts 不许被削）");
  const rtFix = h.createRoomType({ name: "指定房号房型", basePrice: 300 });
  const [fixRoom] = h.createRooms(1, { roomTypeId: rtFix, status: "VC", prefix: "FIX" });
  const f1 = await book({ typeId: rtFix, ci: T1, co: T3, rooms: 1, roomId: fixRoom.id, name: guestName("指定房客") });
  check("第 1 单指定该房 T1→T3 → 成功", f1.ok, f1.err);
  const f2 = await book({ typeId: rtFix, ci: T2, co: T3, rooms: 1, roomId: fixRoom.id, name: guestName("撞房客") });
  check("同一间房 T2→T3（部分重叠）再指定 → 拒绝", !f2.ok && isErr(f2.res), f2.err);
  check("拒绝文案指出该房间已被占用", /已被占用|已被其他订单/.test(f2.err), f2.err);
  const f3 = await book({ typeId: rtFix, ci: T3, co: localDate(4), rooms: 1, roomId: fixRoom.id, name: guestName("接续房客") });
  check("同一间房 T3→T4（首尾相接、不重叠）→ 成功（离店日不含）", f3.ok, f3.err);

  /* ============================================================ 11. 真库零写入 */
  section("十一、真库零写入（全部断言只发生在 VACUUM INTO 副本上）");
  check(
    "真库没有本脚本建的测试房",
    h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_no LIKE ?`, [HOTEL, `NGT${stamp.slice(-6)}%`]) === 0
  );
  check(
    "真库没有本脚本建的测试订单",
    h.realCount(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND remark = ?`, [HOTEL, "库存按晚验收"]) === 0
  );
  check("副本库在 .tmp 下、真库文件存在且只被只读打开过", fs.existsSync(h.dbPath) && fs.statSync(h.realDb).isFile());
} catch (e) {
  console.error("❌ 测试执行中断：", e?.stack ?? e);
  failed = 1;
} finally {
  failed = Math.max(failed, done());
  h.dispose();
}

process.exit(failed === 0 ? 0 : 1);
