#!/usr/bin/env node
/**
 * 维修 / 锁房「起止日期（维修窗口）」验收 —— `rooms.block_from` / `rooms.block_to`
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的事（评审场景逐条对应）
 * ══════════════════════════════════════════════════════════════════════════
 *  0. 口径单元：`roomBlockedOn()` 的四种形态（无窗口 / 有窗口 / 只有开始日 / 只有结束日）
 *  1. 逐晚容量：`physicalCapByNight()` 按 [block_from, block_to) 扣房，开始日含、结束日不含
 *  2. 窗口 11-26~11-28（本脚本按「明天 ~ 后天+2」算，跑在任何一天都成立）：
 *       前一天可订 / 窗口内两天不可订 / 结束日当天可订
 *  3. LOCK 与 OOO 同口径
 *  4. 老数据（两列为空）→ 未来所有日期都不可售，行为一个字都没变（不退化）
 *  5. PC 建单：窗口外成功、窗口内被拒且零副作用（主单/明细/渠道队列都不动）
 *  6. 房态页（room-stock.ts 的 todayRoomTypeStock）：按营业日判窗口，窗口在未来时今天照常可售
 *  7. 小程序查房（真实 GET /api/mini/rooms）的 remainingRooms 与 PC 逐区间相同；
 *     小程序窗口内下单被拒、窗口外能下单
 *  8. 渠道推送（buildRateRows）逐日 allotment 与 PC 逐晚可售完全相同（含建单后的变化）
 *  9. 房态操作（setRoomStatusAction）：OOO/LOCK 写窗口、改回 VC 清空、脏日期明确报错
 * 10. 真库零写入（全部断言在 VACUUM INTO 副本上；真库也没有被写进任何窗口）
 *
 * ── 怎么跑的是生产代码 ──
 *  与 test-stock-nightly.mjs / test-stock-shared.mjs 同一套底盘
 *  （scripts/helpers/action-harness.mjs）：
 *    `data/pms.db --VACUUM INTO--> .tmp/ooo-window-<时间戳>/data/pms.db`
 *    → 注入 globalThis.__pmsDb → 动态 import 真实的 lib / actions
 *    → 像页面一样 new FormData() 调 createBookingAction / setRoomStatusAction
 *  小程序接口用 esbuild 打包真实的 /api/mini/rooms、/api/mini/bookings 后直接调用，
 *  bundle 里的 src/lib/db.ts 同样走 globalThis.__pmsDb，所以两边看同一个副本库。
 *  真库全程只读，脚本末尾复查零写入。
 *
 * 用法：node scripts/test-ooo-window.mjs
 * 退出码：0 = 全绿；1 = 有失败 / 中断
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createActionHarness, createChecker, isOk, isErr, msgOf } from "./helpers/action-harness.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "ooo-window" });
const { one, all, run, invoke, localDate, hotelId: HOTEL, stamp, dir } = h;

/*
 * 日期全部相对「今天」算，脚本跑在任何一天都成立：
 *   D0 = 今天（评审场景里的 11-25：窗口**前一天**）
 *   D1 ~ D2 = 维修窗口内的两晚（评审场景里的 11-26 / 11-27）
 *   D3 = 窗口结束日（11-28）—— 结束日**不含**，所以这一晚可以卖
 *   WINDOW = [D1, D3) → 不可售的只有 D1、D2 两晚
 */
const D0 = localDate(0);
const D1 = localDate(1);
const D2 = localDate(2);
const D3 = localDate(3);
const D4 = localDate(4);
const MOBILE = `135${stamp.slice(-8)}`;
const WIN = `[${D1}, ${D3})`;

let failed = 0;
try {
  /* ============================================================ 0. 装载真实代码 */
  section("〇、装载真实 lib / actions / 小程序路由");

  const lib = await h.importModule("lib/room-stock-nightly.ts");
  const bookings = await h.importModule("app/(main)/bookings/actions.ts");
  const roomsActions = await h.importModule("app/(main)/rooms/actions.ts");
  const roomStock = await h.importModule("lib/room-stock.ts");
  const channel = await h.importModule("lib/channels/stock-trigger.ts");

  check(
    "共享口径模块导出 roomBlockedOn / physicalCapByNight / physicalCapOfType / loadRoomBlocks",
    ["roomBlockedOn", "physicalCapByNight", "physicalCapOfType", "loadRoomBlocks"].every(
      (f) => typeof lib[f] === "function"
    )
  );
  check(
    "PC 建单 / 房态操作 / 房态页 / 渠道推送四个真实模块都装载成功",
    typeof bookings.createBookingAction === "function" &&
      typeof roomsActions.setRoomStatusAction === "function" &&
      typeof roomStock.todayRoomTypeStock === "function" &&
      typeof channel.buildRateRows === "function"
  );

  /** 交给 lib 的查询句柄（与 actions.ts 里的 `{ all, get }` 同构） */
  const STOCK_DB = { all: h.all, get: h.one };
  /** 本脚本造出来的房型（后面「老数据不退化」的全量断言要把它们排除） */
  const myTypeIds = new Set();

  /**
   * 造一个房型 + n 间房，逐间指定房态与维修窗口
   * @param {string} name 房型名
   * @param {{status?:string, from?:string|null, to?:string|null}[]} specs 每间房的房态 / 窗口
   * @param {string} prefix 房号前缀（带时间戳，避免撞真库房号唯一索引）
   */
  const seedType = (name, specs, prefix) => {
    const typeId = h.createRoomType({ name, basePrice: 300 });
    myTypeIds.add(Number(typeId));
    const created = h.createRooms(specs.length, { roomTypeId: typeId, status: "VC", prefix });
    specs.forEach((spec, i) => {
      run(`UPDATE rooms SET status = ?, block_from = ?, block_to = ? WHERE id = ?`, [
        spec.status ?? "VC",
        spec.from ?? null,
        spec.to ?? null,
        created[i].id,
      ]);
    });
    return { typeId: Number(typeId), roomIds: created.map((r) => Number(r.id)) };
  };

  /** 某房型 [ci, co) 的逐晚容量（生产代码） */
  const capsOf = (typeId, ci, co) => lib.physicalCapByNight(STOCK_DB, HOTEL, typeId, ci, co);
  /** 把逐晚容量打印成 `D0=3 D1=2 ...`，失败时贴进 extra 便于定位 */
  const capsText = (typeId, ci, co) =>
    [...capsOf(typeId, ci, co).entries()].map(([d, c]) => `${d}=${c}`).join(" ");
  /** 某一晚的容量（只算那一天：co = 下一天） */
  const capOn = (typeId, day) => capsOf(typeId, day, nextDay(day)).get(day);
  /** 下一天（只用于「取某一晚的容量」，避免多算一晚） */
  function nextDay(day) {
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  let guestSeq = 0;
  const guestName = (tag) => `${tag}#${(guestSeq += 1)}`;

  /** 像前台页面一样提交建单表单（走真实 createBookingAction） */
  async function book({ typeId, ci, co, rooms = 1, name }) {
    const res = await invoke(bookings.createBookingAction, {
      booking_type: "guest",
      guest_name: name,
      mobile: MOBILE,
      check_in_date: ci,
      check_out_date: co,
      rate_code: "门市价",
      pay_type: "到店付款",
      deposit: "0",
      lines: JSON.stringify([{ room_type_id: typeId, room_count: rooms, rate: 300, breakfast: 0 }]),
      remark: "维修窗口验收",
    });
    const row = one(`SELECT id, status FROM bookings WHERE hotel_id = ? AND guest_name = ? ORDER BY id DESC LIMIT 1`, [
      HOTEL,
      name,
    ]);
    return { res, row, ok: isOk(res) && Boolean(row?.id), err: msgOf(res), name };
  }

  /** 副作用快照：主单 / 明细 / 财务 / 渠道待同步队列 */
  const sideEffects = () => ({
    bookings: Number(one(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ?`, [HOTEL]).c),
    details: Number(one(`SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ?`, [HOTEL]).c),
    folios: Number(one(`SELECT COUNT(*) AS c FROM folios WHERE hotel_id = ?`, [HOTEL]).c),
    payments: Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ?`, [HOTEL]).c),
    queue: Number(one(`SELECT COUNT(*) AS c FROM channel_sync_queue WHERE hotel_id = ?`, [HOTEL]).c),
  });
  const sameEffects = (a, b) => Object.keys(a).every((k) => Number(a[k]) === Number(b[k]));
  const diffEffects = (a, b) =>
    Object.keys(a)
      .filter((k) => Number(a[k]) !== Number(b[k]))
      .map((k) => `${k}: ${a[k]}→${b[k]}`)
      .join(" ");

  check(
    "造数前置：真库的 rooms 表已有 block_from / block_to 列（第 25 段迁移）",
    all(`PRAGMA table_info(rooms)`).some((c) => c.name === "block_from") &&
      all(`PRAGMA table_info(rooms)`).some((c) => c.name === "block_to")
  );

  /* ============================================================ 1. 口径单元 */
  section("一、roomBlockedOn() 的四种形态（唯一实现：四个库存口径都只调它）");

  const blocked = lib.roomBlockedOn;
  check("OOO 且无起止日期 → 任何一天都不可售（老数据不退化）", blocked({ status: "OOO" }, D0) && blocked({ status: "OOO" }, D4));
  check(
    `OOO 窗口 ${WIN} → 前一天可售、窗口内两天不可售、结束日可售`,
    blocked({ status: "OOO", block_from: D1, block_to: D3 }, D0) === false &&
      blocked({ status: "OOO", block_from: D1, block_to: D3 }, D1) === true &&
      blocked({ status: "OOO", block_from: D1, block_to: D3 }, D2) === true &&
      blocked({ status: "OOO", block_from: D1, block_to: D3 }, D3) === false
  );
  check(
    "LOCK 与 OOO 完全同口径（窗口外可售 / 窗口内不可售）",
    blocked({ status: "LOCK", block_from: D1, block_to: D3 }, D0) === false &&
      blocked({ status: "LOCK", block_from: D1, block_to: D3 }, D1) === true &&
      blocked({ status: "LOCK", block_from: D1, block_to: D3 }, D3) === false
  );
  check(
    "只有 block_from → 该日之前可售、从该日起永久不可售",
    blocked({ status: "OOO", block_from: D2 }, D1) === false &&
      blocked({ status: "OOO", block_from: D2 }, D2) === true &&
      blocked({ status: "OOO", block_from: D2 }, D4) === true
  );
  check(
    "只有 block_to（缺开始日）→ 按老数据整段不可售（绝不凭空放量）",
    blocked({ status: "OOO", block_to: D3 }, D0) === true && blocked({ status: "OOO", block_to: D3 }, D4) === true
  );
  check(
    "非 OOO / LOCK 的房间即使带窗口也不受影响（窗口只约束维修/锁房）",
    blocked({ status: "VC", block_from: D1, block_to: D3 }, D1) === false &&
      blocked({ status: "OC", block_from: D1, block_to: D3 }, D1) === false
  );
  check(
    "日期列带时间（datetime-local / 导入数据）按「日」归一后仍然生效",
    blocked({ status: "OOO", block_from: `${D1}T00:00:00`, block_to: `${D3}T00:00:00` }, D1) === true &&
      blocked({ status: "OOO", block_from: `${D1}T00:00:00`, block_to: `${D3}T00:00:00` }, D3) === false
  );
  check(
    "脏日期当「没有开始日」→ 整段不可售（脏数据只会更保守，不放量）",
    blocked({ status: "OOO", block_from: "2026-13-99" }, D0) === true &&
      blocked({ status: "OOO", block_from: "2026-02-31" }, D0) === true
  );

  /*
   * 老库兜底（缺列的库）：`block_from` / `block_to` 是第 25 段迁移才加的列，
   * 代码先上、迁移后跑的那一刻是「rooms 表没有这两列」的状态。
   * 这里用一个内存库模拟，证明 loadRoomBlocks 会退回 NULL（= OOO/LOCK 整段排除），
   * 而不是抛 `no such column` 把整条库存链路打挂。
   */
  const { DatabaseSync } = await import("node:sqlite");
  const oldConn = new DatabaseSync(":memory:");
  oldConn.exec(`CREATE TABLE rooms (id INTEGER PRIMARY KEY, hotel_id INTEGER, room_type_id INTEGER, status TEXT)`);
  oldConn.exec(`INSERT INTO rooms (id, hotel_id, room_type_id, status) VALUES (1, 1, 7, 'OOO'), (2, 1, 7, 'VC')`);
  /** 每次调用都新建一个函数：WeakSet 用的是函数引用，这里模拟「另一个连接」 */
  const oldAll = (sql, params = []) => oldConn.prepare(sql).all(...params).map((r) => ({ ...r }));
  const oldRows = lib.loadRoomBlocks({ all: oldAll }, 1, 7);
  check(
    "老库缺 block_from/block_to 列 → loadRoomBlocks 退回 NULL 且不抛错",
    oldRows.length === 2 && oldRows.every((r) => r.block_from === null && r.block_to === null),
    JSON.stringify(oldRows)
  );
  check(
    "老库缺列时逐晚容量按整段排除（1 间 OOO 无窗口 → 每晚 2−1=1，不会放开维修房）",
    [...lib.physicalCapByNight({ all: oldAll }, 1, 7, D0, D4).values()].every((c) => c === 1),
    [...lib.physicalCapByNight({ all: oldAll }, 1, 7, D0, D4).values()].join(",")
  );
  oldConn.close();

  /* ============================================================ 2. 逐晚容量 */
  section("二、physicalCapByNight()：3 间房、其中 1 间 OOO 窗口 → 只扣窗口内那两晚");

  const rtWin = seedType("逐晚窗口房型", [{ status: "VC" }, { status: "VC" }, { status: "OOO", from: D1, to: D3 }], "WIN3");
  const capsWin = capsOf(rtWin.typeId, D0, D4);
  check(
    `逐晚容量 ${D0}..${D3} = 3 / 2 / 2 / 3`,
    capsWin.get(D0) === 3 && capsWin.get(D1) === 2 && capsWin.get(D2) === 2 && capsWin.get(D3) === 3,
    capsText(rtWin.typeId, D0, D4)
  );
  check(`区间内每一晚都有读数（${D0}~${D3} 共 4 晚，不是只给有窗口的那两晚）`, capsWin.size === 4, String(capsWin.size));
  check(
    "不带日期的老口径 physicalCapOfType 仍是整段排除（= 2）—— 小程序改单等旧调用点不回退",
    lib.physicalCapOfType(STOCK_DB, HOTEL, rtWin.typeId) === 2,
    String(lib.physicalCapOfType(STOCK_DB, HOTEL, rtWin.typeId))
  );
  check(
    "同一个房型占用为 0 时，逐晚剩余 = 逐晚容量（occupiedByNight 不因窗口漏掉任何一晚）",
    [...lib.occupiedByNight(STOCK_DB, HOTEL, rtWin.typeId, D0, D4).values()].every((v) => v === 0)
  );

  /* ============================================================ 3. PC 建单（OOO） */
  section(`三、PC 建单（OOO 窗口 ${WIN}）：前一天/结束日可订、窗口内被拒`);

  const rtOne = seedType("单间维修房房型", [{ status: "OOO", from: D1, to: D3 }], "WIN1");
  check(`造数：唯一一间房的 OOO 窗口 = ${WIN}`, capsOf(rtOne.typeId, D0, D4).get(D1) === 0);

  /* 跨窗口：D0~D3 三晚里有 D1/D2 两晚容量为 0 → 必须拒绝，且文案指向窗口内那一晚 */
  const beforeCross = sideEffects();
  const cross = await book({ typeId: rtOne.typeId, ci: D0, co: D3, rooms: 1, name: guestName("跨窗口客") });
  check("跨窗口区间（含 D1/D2）建单被拒", !cross.ok && isErr(cross.res), cross.err);
  check("错误文案指出最低的那一晚是窗口内（D1）且只剩 0 间", cross.err.includes(D1) && /只剩 0 间/.test(cross.err), cross.err);
  check("被拒时零副作用（主单/明细/财务/渠道队列）", sameEffects(beforeCross, sideEffects()), diffEffects(beforeCross, sideEffects()));

  const b0 = await book({ typeId: rtOne.typeId, ci: D0, co: D1, rooms: 1, name: guestName("窗口前一天") });
  check(`${D0}（窗口开始前那晚）→ 建单成功`, b0.ok, b0.err);

  const beforeIn = sideEffects();
  const b1 = await book({ typeId: rtOne.typeId, ci: D1, co: D2, rooms: 1, name: guestName("窗口第一晚") });
  check(`${D1}（窗口内第一晚）→ 建单被拒`, !b1.ok && isErr(b1.res), b1.err);
  check("拒绝文案是「没有可售房 / 库存不足」，不是别的原因", /没有可售房|库存不足/.test(b1.err), b1.err);
  check("窗口内被拒零副作用", sameEffects(beforeIn, sideEffects()), diffEffects(beforeIn, sideEffects()));

  const b2 = await book({ typeId: rtOne.typeId, ci: D2, co: D3, rooms: 1, name: guestName("窗口第二晚") });
  check(`${D2}（窗口内第二晚）→ 建单被拒`, !b2.ok && isErr(b2.res), b2.err);

  const b3 = await book({ typeId: rtOne.typeId, ci: D3, co: D4, rooms: 1, name: guestName("窗口结束日") });
  check(`${D3}（窗口结束日，[from,to) 不含结束日）→ 建单成功`, b3.ok, b3.err);

  /* ============================================================ 4. PC 建单（LOCK） */
  section(`四、PC 建单（LOCK 窗口 ${WIN}）：与 OOO 完全同口径`);

  const rtLock = seedType("单间锁房房型", [{ status: "LOCK", from: D1, to: D3 }], "LCKW");
  const l0 = await book({ typeId: rtLock.typeId, ci: D0, co: D1, rooms: 1, name: guestName("锁房前夜") });
  check(`LOCK ${D0}（窗口外）→ 建单成功`, l0.ok, l0.err);
  const l1 = await book({ typeId: rtLock.typeId, ci: D1, co: D2, rooms: 1, name: guestName("锁房窗内") });
  check(`LOCK ${D1}（窗口内）→ 建单被拒`, !l1.ok && isErr(l1.res), l1.err);
  const l3 = await book({ typeId: rtLock.typeId, ci: D3, co: D4, rooms: 1, name: guestName("锁房结束日") });
  check(`LOCK ${D3}（窗口结束日）→ 建单成功`, l3.ok, l3.err);

  /* ============================================================ 5. 老数据不退化 */
  section("五、老数据（block_from/block_to 为空）→ 未来所有日期都不可售，行为不变");

  const rtOld = seedType("无窗口维修房房型", [{ status: "OOO" }], "OLDW");
  const capsOld = capsOf(rtOld.typeId, D0, D4);
  check(
    `无窗口 OOO：${D0}~${D3} 每一晚容量都是 0（整段排除，不因加了字段而放开维修房）`,
    capsOld.size === 4 && [...capsOld.values()].every((c) => c === 0),
    capsText(rtOld.typeId, D0, D4)
  );
  check("无窗口 OOO：physicalCapOfType 仍为 0", lib.physicalCapOfType(STOCK_DB, HOTEL, rtOld.typeId) === 0);
  const o1 = await book({ typeId: rtOld.typeId, ci: D0, co: D1, rooms: 1, name: guestName("老数据维修客") });
  check("无窗口 OOO：今天订 1 间被拒（与改造前一致）", !o1.ok && /没有可售房|库存不足/.test(o1.err), o1.err);
  const o2 = await book({ typeId: rtOld.typeId, ci: D4, co: localDate(5), rooms: 1, name: guestName("老数据远期客") });
  check("无窗口 OOO：远期（D4）也同样被拒 —— 不是只挡今天", !o2.ok && isErr(o2.res), o2.err);

  /* 全店既有房型（没有窗口的老数据）逐晚容量必须恒等于整段容量 */
  const legacyTypes = all(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id`, [HOTEL])
    .map((r) => Number(r.id))
    .filter((id) => !myTypeIds.has(id));
  const legacyDiffs = [];
  for (const id of legacyTypes) {
    const strictCap = lib.physicalCapOfType(STOCK_DB, HOTEL, id);
    const nightly = capsOf(id, D0, localDate(10));
    if (nightly.size === 0) legacyDiffs.push(`#${id} 没有逐晚读数`);
    for (const [day, c] of nightly) if (c !== strictCap) legacyDiffs.push(`#${id} ${day}: ${c}≠${strictCap}`);
  }
  check(
    `真库既有 ${legacyTypes.length} 个房型（无窗口）逐晚容量恒等于整段容量 —— 老数据行为未变`,
    legacyDiffs.length === 0,
    legacyDiffs.slice(0, 4).join(" / ")
  );

  /* ============================================================ 6. 房态页 */
  section("六、房态页 todayRoomTypeStock()：按营业日判窗口（维修明天结束 → 明天就能卖）");

  const rtFuture = seedType("未来维修房型", [{ status: "OOO", from: D1, to: D3 }], "TODAYF");
  const rtTodayBlocked = seedType("今日维修中房型", [{ status: "OOO", from: D0, to: D1 }], "TODAYI");
  const rtTodayOld = seedType("今日维修无窗口房型", [{ status: "OOO" }], "TODAYO");
  const todayRows = roomStock.todayRoomTypeStock(HOTEL);
  const rowOf = (typeId) => todayRows.find((r) => Number(r.roomTypeId) === Number(typeId));

  const fRow = rowOf(rtFuture.typeId);
  check(
    `窗口 ${WIN} 不含今天 → 今天 ooo=0、sellable=1（维修还没开始，房间今天照常卖）`,
    fRow?.ooo === 0 && fRow?.physical === 1 && fRow?.sellable === 1,
    JSON.stringify(fRow)
  );
  const tRow = rowOf(rtTodayBlocked.typeId);
  check(
    "窗口 [今天, 明天) 含今天 → ooo=1、sellable=0（今天确实在维修）",
    tRow?.ooo === 1 && tRow?.sellable === 0,
    JSON.stringify(tRow)
  );
  const oRow = rowOf(rtTodayOld.typeId);
  check(
    "老数据（无窗口）OOO → ooo=1、sellable=0（房态页行为与改造前一致）",
    oRow?.ooo === 1 && oRow?.sellable === 0,
    JSON.stringify(oRow)
  );
  check(
    "三种情形的物理房量都是 1（窗口只影响「哪天可售」，不动物理房量）",
    fRow?.physical === 1 && tRow?.physical === 1 && oRow?.physical === 1
  );

  /* ============================================================ 7. 小程序查房 */
  section("七、小程序查房 / 下单：remainingRooms 与 PC 逐区间相同，窗口内下单被拒");

  const srcAbs = (rel) => path.join(ROOT, "src", ...rel.split("/")).replace(/\\/g, "/");
  const ENTRY = path.join(dir, "ooo-window-entry.ts");
  const BUNDLE = path.join(dir, "ooo-window-bundle.cjs");
  fs.writeFileSync(
    ENTRY,
    `
export { GET as rooms } from ${JSON.stringify(srcAbs("app/api/mini/rooms/route.ts"))};
export { POST as bookingCreate } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
`,
    "utf8"
  );
  let routes = null;
  try {
    require("esbuild").buildSync({
      entryPoints: [ENTRY],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: BUNDLE,
      alias: { "@": path.join(ROOT, "src").replace(/\\/g, "/") },
      logLevel: "silent",
    });
    routes = require(BUNDLE);
  } catch (e) {
    routes = null;
  }
  check(
    "小程序真实路由编译成功（/api/mini/rooms 与 /api/mini/bookings）",
    Boolean(routes) && typeof routes.rooms === "function" && typeof routes.bookingCreate === "function"
  );

  /* 小程序配置 + token（写副本库，真库不受影响） */
  const nowIso = () => new Date().toISOString();
  run(
    `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(hotel_id) DO UPDATE SET app_id = excluded.app_id, app_secret = excluded.app_secret,
       enabled = 1, updated_at = excluded.updated_at`,
    [HOTEL, "wxooowindow01", "secret-ooo-window", 1, nowIso()]
  );
  const MINI_TOKEN = `ooo-window-${stamp}`;
  run(
    `INSERT INTO mini_program_users (hotel_id, openid, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    [HOTEL, `openid-${stamp}`, MINI_TOKEN, new Date(Date.now() + 6 * 86400000).toISOString(), nowIso(), nowIso()]
  );

  let uaSeq = 0;
  const makeReq = ({ token, method = "GET", url = "http://127.0.0.1/api/mini/x", body }) => {
    const headers = { "user-agent": `ooo-window-test-${(uaSeq += 1)}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const call = async (handler, opts = {}) => {
    const res = await handler(makeReq(opts), { params: Promise.resolve({}) });
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { __raw: text.slice(0, 300) };
    }
    return { status: res.status, body: payload, text };
  };

  /** 小程序查房：某房型的 remainingRooms（找不到返回 -1，绝不静默算通过） */
  const miniRemaining = async (typeId, ci, co) => {
    if (!routes) return -1;
    const r = await call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${ci}&checkOut=${co}` });
    const t = (r.body?.data?.roomTypes ?? []).find((x) => Number(x.roomTypeId) === Number(typeId));
    return t ? Number(t.remainingRooms) : -1;
  };
  const miniCreate = (body) => call(routes.bookingCreate, { token: MINI_TOKEN, method: "POST", body });

  const rtMini = seedType("小程序窗口房型", [{ status: "VC" }, { status: "OOO", from: D1, to: D3 }], "MINIW");
  const miniRanges = [
    [D0, D1],
    [D1, D2],
    [D1, D3],
    [D0, D3],
    [D3, D4],
  ];
  /* 期望值：2 间房，1 间在 [D1,D3) 维修 → D0 剩 2、D1/D2 各剩 1、D3 剩 2 */
  const expectMini = new Map([
    [`${D0}~${D1}`, 2],
    [`${D1}~${D2}`, 1],
    [`${D1}~${D3}`, 1],
    [`${D0}~${D3}`, 1],
    [`${D3}~${D4}`, 2],
  ]);
  const miniDiffs = [];
  for (const [ci, co] of miniRanges) {
    const pc = Math.max(0, lib.roomTypeStock(STOCK_DB, HOTEL, ci, co).get(rtMini.typeId)?.minRemain ?? -1);
    const mini = await miniRemaining(rtMini.typeId, ci, co);
    if (pc !== mini) miniDiffs.push(`${ci}~${co}: PC=${pc} 小程序=${mini}`);
    const want = expectMini.get(`${ci}~${co}`);
    if (want !== undefined && mini !== want) miniDiffs.push(`${ci}~${co}: 小程序=${mini} 期望=${want}`);
  }
  check(
    `5 个区间：小程序 remainingRooms 与 PC 逐晚最低剩余完全相同（且等于窗口手算的 2/1/1/1/2）`,
    miniDiffs.length === 0,
    miniDiffs.join(" / ")
  );

  const miniIn = await miniCreate({
    roomTypeId: rtMini.typeId,
    checkInDate: D1,
    checkOutDate: D2,
    roomCount: 2,
    guestName: guestName("小程序窗口内"),
    mobile: MOBILE,
    requestId: `ooo-window-in-${stamp}`,
  });
  check(
    "小程序在窗口内下单 2 间（只剩 1 间）→ ROOM_NOT_ENOUGH",
    miniIn.body?.ok === false && miniIn.body?.code === "ROOM_NOT_ENOUGH",
    JSON.stringify(miniIn.body).slice(0, 180)
  );
  const miniOut = await miniCreate({
    roomTypeId: rtMini.typeId,
    checkInDate: D3,
    checkOutDate: D4,
    roomCount: 1,
    guestName: guestName("小程序窗口外"),
    mobile: MOBILE,
    requestId: `ooo-window-out-${stamp}`,
  });
  check("小程序在窗口结束日下单 1 间 → 成功（结束日不含，房晚可售）", miniOut.body?.ok === true, JSON.stringify(miniOut.body).slice(0, 180));
  check(`窗口结束日卖掉 1 间后 remainingRooms 变成 1（2 − 1）`, (await miniRemaining(rtMini.typeId, D3, D4)) === 1);

  /* ============================================================ 8. 渠道推送 */
  section("八、渠道推送 buildRateRows()：逐日 allotment 与 PC 逐晚可售完全一致");

  const rtCh = seedType("渠道窗口房型", [{ status: "VC" }, { status: "VC" }, { status: "OOO", from: D1, to: D3 }], "CHW");
  /** 把渠道推送行与该房型的逐晚容量−占用逐日对比，返回差异明细 */
  const channelDiffs = (typeId, rows, ci, co) => {
    const caps = capsOf(typeId, ci, co);
    const occ = lib.occupiedByNight(STOCK_DB, HOTEL, typeId, ci, co);
    const out = [];
    for (const row of rows.filter((r) => Number(r.roomTypeId) === Number(typeId))) {
      /* 渠道 allotment 是「物理可售」经 toChannelAllotment clamp 后的值（oversell=false → max(0, n)） */
      const want = Math.max(0, Number(caps.get(row.date) ?? 0) - Number(occ.get(row.date) ?? 0));
      if (Number(row.allotment) !== want) out.push(`${row.date}: 渠道=${row.allotment} PC=${want}`);
    }
    return out;
  };
  const allotOf = (rows, typeId) =>
    new Map(rows.filter((r) => Number(r.roomTypeId) === Number(typeId)).map((r) => [r.date, Number(r.allotment)]));

  const rows1 = channel.buildRateRows(HOTEL, "ctrip", D0, 4, false);
  const ch1 = allotOf(rows1, rtCh.typeId);
  check(
    `渠道推送 ${D0}..${D3} = 3 / 2 / 2 / 3（窗口内两晚按维修房扣 1 间）`,
    ch1.get(D0) === 3 && ch1.get(D1) === 2 && ch1.get(D2) === 2 && ch1.get(D3) === 3,
    JSON.stringify([...ch1.entries()])
  );
  const chDiffs1 = channelDiffs(rtCh.typeId, rows1, D0, D4);
  check("渠道 allotment 与 PC 逐晚可售完全一致（没有维修窗口的数据）", chDiffs1.length === 0, chDiffs1.join(" / "));

  /* 老数据在渠道侧同样整段排除：2 间房，1 间无窗口 OOO → 每天都只推 1 间 */
  const rtChOld = seedType("渠道无窗口房型", [{ status: "VC" }, { status: "OOO" }], "CHWO");
  const chOld = allotOf(channel.buildRateRows(HOTEL, "ctrip", D0, 4, false), rtChOld.typeId);
  check(
    "老数据（无窗口）OOO：渠道每一天都按整段排除推 1 间（与改造前一致）",
    [D0, D1, D2, D3].every((d) => chOld.get(d) === 1),
    JSON.stringify([...chOld.entries()])
  );

  /* 窗口外建单后：渠道跟着掉，且窗口内那晚仍是「容量 2 − 占用 1 = 1」 */
  const chBook = await book({ typeId: rtCh.typeId, ci: D0, co: D2, rooms: 1, name: guestName("渠道对比客") });
  check(`在渠道对比房型上真实建单 ${D0}~${D2} 1 间（两晚）→ 成功`, chBook.ok, chBook.err);
  const rows2 = channel.buildRateRows(HOTEL, "ctrip", D0, 4, false);
  const ch2 = allotOf(rows2, rtCh.typeId);
  check(
    `${D0} 渠道从 3 降到 2（占用 1）、${D1} 从 2 降到 1（容量 2 − 占用 1）`,
    ch2.get(D0) === 2 && ch2.get(D1) === 1 && ch2.get(D2) === 2 && ch2.get(D3) === 3,
    JSON.stringify([...ch2.entries()])
  );
  const chDiffs2 = channelDiffs(rtCh.typeId, rows2, D0, D4);
  check("建单后渠道 allotment 仍与 PC 逐晚可售完全一致", chDiffs2.length === 0, chDiffs2.join(" / "));

  /* ============================================================ 9. 房态操作 */
  section("九、setRoomStatusAction：改维修/锁房写窗口、改回空房清空、脏日期明确报错");

  const rtAct = seedType("房态操作房型", [{ status: "VC" }], "ACTW");
  const actRoomId = rtAct.roomIds[0];

  const setStatus = (fields) => invoke(roomsActions.setRoomStatusAction, fields);
  /*
   * setRoomStatusAction 成功时**没有返回值**（`return` / `return undefined`），
   * 所以不能套用 isOk（它要求 result.ok 为真）—— 只能按「正常返回且没有 error」判成功。
   */
  const okVoid = (r) => r?.kind === "returned" && !r?.result?.error;
  const roomRow = () => one(`SELECT status, block_from, block_to FROM rooms WHERE id = ?`, [actRoomId]);

  const s1 = await setStatus({ roomId: actRoomId, status: "OOO", reason: "空调维修", block_from: D1, block_to: D3 });
  let cur = roomRow();
  check("改成 OOO 并填起止日期 → 操作成功", okVoid(s1), msgOf(s1) || JSON.stringify(s1));
  check(
    `OOO 起止日期落库（block_from=${D1}, block_to=${D3}）`,
    cur?.status === "OOO" && cur?.block_from === D1 && cur?.block_to === D3,
    JSON.stringify(cur)
  );
  check(
    "落库后逐晚容量按窗口算（D0 可售、D1/D2 不可售、D3 可售）",
    capOn(rtAct.typeId, D0) === 1 && capOn(rtAct.typeId, D1) === 0 && capOn(rtAct.typeId, D2) === 0 && capOn(rtAct.typeId, D3) === 1,
    capsText(rtAct.typeId, D0, D4)
  );

  /* 重复提交同一房态可以改窗口（from === to 时 changeRoomStatus 直接返回 ok，窗口照样落库） */
  const s2 = await setStatus({ roomId: actRoomId, status: "OOO", reason: "工期顺延", block_from: D2, block_to: D4 });
  cur = roomRow();
  check(
    "重复提交 OOO 可以顺延窗口（房态不变、日期更新）",
    okVoid(s2) && cur?.status === "OOO" && cur?.block_from === D2 && cur?.block_to === D4,
    JSON.stringify(cur)
  );

  /* 改回 VC → 清空窗口 */
  const s3 = await setStatus({ roomId: actRoomId, status: "VC", reason: "修好了" });
  cur = roomRow();
  check(
    "改回 VC → 起止日期被清空（不留旧维修期，免得下次维修误关一批日期）",
    okVoid(s3) && cur?.status === "VC" && cur?.block_from === null && cur?.block_to === null,
    JSON.stringify(cur)
  );

  /* 只填结束日 → 明确报错，且房态没被改（校验先于改房态） */
  const beforeBad = roomRow();
  const bad1 = await setStatus({ roomId: actRoomId, status: "OOO", block_to: D3 });
  check("只填结束日 → 明确报错（缺开始日无法判断从哪天起不可售）", isErr(bad1) && /开始日/.test(msgOf(bad1)), msgOf(bad1));
  check("报错时房态没有被改成 OOO（日期校验先于改房态）", roomRow()?.status === beforeBad?.status, JSON.stringify(roomRow()));

  /* 结束日不晚于开始日 → 报错 */
  const bad2 = await setStatus({ roomId: actRoomId, status: "OOO", block_from: D3, block_to: D3 });
  check("结束日不晚于开始日 → 明确报错（结束日当天可售，区间不能为空）", isErr(bad2) && /晚于开始日/.test(msgOf(bad2)), msgOf(bad2));

  /* 非法日期 → 报错 */
  const bad3 = await setStatus({ roomId: actRoomId, status: "LOCK", block_from: "2026-13-99" });
  check("非法日期 → 明确报错（不会静默存成空窗口 = 永久不可售）", isErr(bad3) && /不是合法日期/.test(msgOf(bad3)), msgOf(bad3));

  /* 只填开始日 → 允许：从该日起永久不可售 */
  const s4 = await setStatus({ roomId: actRoomId, status: "LOCK", reason: "渠道预留", block_from: D1 });
  cur = roomRow();
  check(
    "只填开始日 → 允许，block_to 为空 = 从该日起永久不可售",
    okVoid(s4) && cur?.status === "LOCK" && cur?.block_from === D1 && cur?.block_to === null,
    JSON.stringify(cur)
  );
  check(
    "只填开始日：D0 可售、D1 起不可售",
    capOn(rtAct.typeId, D0) === 1 && capOn(rtAct.typeId, D1) === 0 && capOn(rtAct.typeId, D3) === 0,
    capsText(rtAct.typeId, D0, D4)
  );

  /* 不填日期（老行为）：整段不可售 */
  const rtNoDate = seedType("不填日期房型", [{ status: "VC" }], "ACTN");
  const s5 = await setStatus({ roomId: rtNoDate.roomIds[0], status: "OOO", reason: "只标维修" });
  cur = one(`SELECT status, block_from, block_to FROM rooms WHERE id = ?`, [rtNoDate.roomIds[0]]);
  check(
    "不填日期改成 OOO → 允许，两列为空 = 整段不可售（老行为，前台不排工期也能用）",
    okVoid(s5) && cur?.status === "OOO" && cur?.block_from === null && cur?.block_to === null,
    JSON.stringify(cur)
  );
  check(
    "不填日期的 OOO：D0 与 D4 都不可售（与改造前一致）",
    capOn(rtNoDate.typeId, D0) === 0 && capOn(rtNoDate.typeId, D4) === 0,
    capsText(rtNoDate.typeId, D0, localDate(6))
  );

  /* ============================================================ 10. 真库零写入 */
  section("十、真库零写入（全部断言只发生在 VACUUM INTO 副本上）");

  check(
    "真库没有本脚本建的测试房（房号前缀 WIN/LCK/MINI/CHW/TODAY/OLD/ACT）",
    ["WIN%", "LCKW%", "MINIW%", "CHW%", "TODAY%", "OLDW%", "ACTW%", "ACTN%"].every(
      (like) => h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_no LIKE ?`, [HOTEL, like]) === 0
    )
  );
  check(
    "真库没有本脚本的测试订单（remark = 维修窗口验收）",
    h.realCount(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND remark = ?`, [HOTEL, "维修窗口验收"]) === 0
  );
  let realWindows = -1;
  try {
    realWindows = h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE block_from IS NOT NULL OR block_to IS NOT NULL`);
  } catch {
    realWindows = -1;
  }
  check(
    "真库没有被写进任何维修窗口（block_from / block_to 全为空 → 老数据行为确实没变）",
    realWindows === 0,
    `真库带窗口的房间数 = ${realWindows}`
  );

  /* 评审场景小结（报告里直接贴这张表） */
  section("十一、评审场景小结");
  console.log(`   维修窗口：${WIN}（本次运行：今天=${D0}，窗口=${D1}~${D2}，结束日=${D3}）`);
  for (const [label, typeId] of [
    ["OOO 单间（窗口内）", rtOne.typeId],
    ["LOCK 单间（窗口内）", rtLock.typeId],
    ["OOO 无窗口（老数据）", rtOld.typeId],
  ]) {
    const caps = capsOf(typeId, D0, D4);
    console.log(`   ${label.padEnd(22, " ")} ${D0}=${caps.get(D0)}  ${D1}=${caps.get(D1)}  ${D2}=${caps.get(D2)}  ${D3}=${caps.get(D3)}`);
  }
} catch (e) {
  console.error("❌ 测试执行中断：", e?.stack ?? e);
  failed = 1;
} finally {
  failed = Math.max(failed, done());
  h.dispose();
}

process.exit(failed === 0 ? 0 : 1);
