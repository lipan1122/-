#!/usr/bin/env node
/**
 * 房型库存「共享 lib」验收：PC 建单 与 小程序下单必须同一口径
 * （评审 P0-1 的第二步：把 fix-stock-nightly 写好的逐晚算法抽成 lib，两个入口共用）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本要证明的三件事
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **一份实现**：`src/lib/room-stock-nightly.ts` 的 physicalCapOfType /
 *     eachNight / occupiedByNight / stockShortage / roomTypeStock 都可用，
 *     且 `bookings/actions.ts`（PC）与 `api/mini/_shared.ts` 的 loadAvailability（小程序）
 *     用的是**同一份**——所以同一份数据、同一个区间，两边的「还能订几间」必须相等。
 *  2. **小程序那 3 个 bug 真的修好了**（修之前 loadAvailability 自己写了一份旧口径）：
 *       ① 只扣 OOO、不扣 LOCK          → 锁房被当成可售（超卖）
 *       ② 唯一一间房是 OOO/LOCK        → 房型照样能卖出去（超卖）
 *       ③ 按区间重叠计数、不按晚        → 跨日订单被误拒（该成功却成功不了）
 *     每个场景都同时给出「旧口径算出来是多少 / 新实现是多少 / 真实下单是成是败」。
 *  3. **PC 现有行为没退化**：真实调 createBookingAction，OOO/LOCK/跨日/最低夜文案
 *     四组判定全部符合逐晚口径（与 test-stock-nightly.mjs 的 57 条是同一份 action）。
 *
 * ── 旧口径为什么还留在脚本里 ──
 * 只用于「前后对比」的读数（把改造前 loadAvailability 的 4 段 SQL 原样复刻成
 * legacyMiniRemaining）；它**不参与**任何被测代码路径，生产代码里已经删掉了。
 * 没有这组读数就说不清「修之前会怎样」，所以保留。
 *
 * ── 怎么跑的是真实代码 ──
 *   · PC：与 test-stock-nightly.mjs 同一套底盘（scripts/helpers/action-harness.mjs），
 *     `data/pms.db --VACUUM INTO--> .tmp/stock-shared-<时间戳>/`，真库只读；
 *   · 小程序：esbuild 打包真实的 `/api/mini/rooms`、`/api/mini/bookings` 与 `_shared.ts`，
 *     在同一个副本库上直接调用 GET / POST（bundle 里的 src/lib/db.ts 会走
 *     globalThis.__pmsDb，即 harness 注入的那个副本连接，所以两边看的是同一个库）；
 *   · 真库全程只读，脚本末尾复查 sha256 一致。
 *
 * 用法：node scripts/test-stock-shared.mjs
 * 退出码：0 = 全绿；1 = 有失败 / 中断
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { createActionHarness, createChecker, isOk, msgOf } from "./helpers/action-harness.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "stock-shared" });
const { one, invoke, localDate, hotelId: HOTEL, stamp, dir, realDb } = h;

/** 真库指纹：跑完必须一模一样（所有写入都落在 VACUUM INTO 副本上） */
const sha256 = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const REAL_HASH_BEFORE = sha256(realDb);

/* 日期都在「明天」之后：PC 建单与小程序下单都有「到店日不早于今天」的校验 */
const D0 = localDate(1);
const D1 = localDate(2);
const D2 = localDate(3);
const D3 = localDate(4);
const D4 = localDate(5);
const MOBILE = `135${stamp.slice(-8)}`;
const nowIso = () => new Date().toISOString();

try {
  /* ====================================================================== */
  /* 0. 装载共享 lib + 打包小程序真实接口                                     */
  /* ====================================================================== */

  section("〇、装载共享 lib（真实 src/lib/room-stock-nightly.ts）");

  const lib = await h.importModule("lib/room-stock-nightly.ts");
  const LIB_FNS = ["physicalCapOfType", "eachNight", "occupiedByNight", "stockShortage", "roomTypeStock"];
  check(
    "lib 导出 5 个函数：physicalCapOfType / eachNight / occupiedByNight / stockShortage / roomTypeStock",
    LIB_FNS.every((f) => typeof lib[f] === "function"),
    LIB_FNS.filter((f) => typeof lib[f] !== "function").join(",")
  );

  /** 交给 lib 的句柄：与 actions.ts 里的 `{ all, get }` 同构 */
  const STOCK_DB = { all: h.all, get: h.one };

  /** lib 角度：某房型某区间的 cap / minRemain / 逐晚占用 */
  const stockOf = (typeId, ci, co) => lib.roomTypeStock(STOCK_DB, HOTEL, ci, co).get(typeId);
  const capOf = (typeId) => lib.physicalCapOfType(STOCK_DB, HOTEL, typeId);

  /* ── 纯函数：eachNight ── */
  check(
    "eachNight 入住日含、离店日不含（D0~D2 → 两晚 [D0, D1]）",
    JSON.stringify(lib.eachNight(D0, D2)) === JSON.stringify([D0, D1]),
    JSON.stringify(lib.eachNight(D0, D2))
  );
  check("eachNight 对非法日期返回空数组（不抛错、不无限循环）", lib.eachNight("2026-13-01", D1).length === 0);
  check("eachNight 离店 ≤ 入住返回空数组", lib.eachNight(D1, D1).length === 0 && lib.eachNight(D2, D1).length === 0);

  /* ── 小程序真实接口（esbuild 打包） ── */
  section("〇·二、打包小程序真实接口（/api/mini/rooms · /api/mini/bookings · _shared.loadAvailability）");

  const srcAbs = (rel) => path.join(ROOT, "src", ...rel.split("/")).replace(/\\/g, "/");
  const ENTRY = path.join(dir, "stock-shared-entry.ts");
  const BUNDLE = path.join(dir, "stock-shared-bundle.cjs");
  fs.writeFileSync(
    ENTRY,
    `
export { GET as rooms } from ${JSON.stringify(srcAbs("app/api/mini/rooms/route.ts"))};
export { POST as bookingCreate } from ${JSON.stringify(srcAbs("app/api/mini/bookings/route.ts"))};
export { loadAvailability } from ${JSON.stringify(srcAbs("app/api/mini/_shared.ts"))};
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
    check(
      "小程序真实路由编译成功，并导出 rooms(GET) / bookingCreate(POST) / loadAvailability",
      typeof routes.rooms === "function" &&
        typeof routes.bookingCreate === "function" &&
        typeof routes.loadAvailability === "function"
    );
  } catch (e) {
    check("小程序真实路由编译成功", false, String(e?.message ?? e).slice(0, 240));
  }

  /* 小程序配置 + 一个 7 天有效的 token（写副本库，真库不受影响） */
  h.run(
    `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, enabled, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(hotel_id) DO UPDATE SET app_id = excluded.app_id, app_secret = excluded.app_secret,
       enabled = 1, updated_at = excluded.updated_at`,
    [HOTEL, "wxstock0001", "secret-stock-0001", 1, nowIso()]
  );
  const MINI_TOKEN = `stock-shared-${stamp}`;
  h.run(
    `INSERT INTO mini_program_users (hotel_id, openid, session_token, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    [HOTEL, `openid-${stamp}`, MINI_TOKEN, new Date(Date.now() + 6 * 86400000).toISOString(), nowIso(), nowIso()]
  );

  let uaSeq = 0;
  function makeReq({ token, method = "GET", url = "http://127.0.0.1/api/mini/x", body }) {
    const headers = { "user-agent": `stock-shared-test-${(uaSeq += 1)}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function call(handler, opts = {}) {
    const res = await handler(makeReq(opts), { params: Promise.resolve({}) });
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { __raw: text.slice(0, 300) };
    }
    return { status: res.status, body: payload, text };
  }

  /** 小程序查房（真实 GET /api/mini/rooms）→ 某房型的 remainingRooms（找不到返回 -1） */
  const miniRemaining = async (typeId, ci, co) => {
    if (!routes) return -1;
    const r = await call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${ci}&checkOut=${co}` });
    const t = (r.body?.data?.roomTypes ?? []).find((x) => Number(x.roomTypeId) === Number(typeId));
    return t ? Number(t.remainingRooms) : -1;
  };
  const miniSoldOut = async (typeId, ci, co) => {
    const r = await call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${ci}&checkOut=${co}` });
    return (r.body?.data?.roomTypes ?? []).find((x) => Number(x.roomTypeId) === Number(typeId))?.soldOut;
  };
  const miniCreate = (body) => call(routes.bookingCreate, { token: MINI_TOKEN, method: "POST", body });

  /* ====================================================================== */
  /* 1. PC 建单：真实 createBookingAction                                     */
  /* ====================================================================== */

  section("〇·三、装载 PC 真实 createBookingAction（与小程序同一个副本库）");

  const bookings = await h.importModule("app/(main)/bookings/actions.ts");
  check("createBookingAction 加载成功", typeof bookings.createBookingAction === "function");

  let guestSeq = 0;
  const guestName = (tag) => `${tag}#${(guestSeq += 1)}`;

  /** 像前台页面一样提交建单表单；返回 {ok, err, name} */
  async function pcBook({ typeId, ci, co, rooms = 1, name }) {
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
      remark: "库存共享口径验收",
    });
    return { ok: isOk(res), err: msgOf(res), name };
  }

  /**
   * 旧口径复刻（改造前 `_shared.loadAvailability` 的公式，只用于前后对比）
   *
   *   remaining = max(0, 全部房间数 − 维修(OOO) − 区间重叠占用)
   *   区间重叠占用 = 在住覆盖 + 明细（stay_id 为空，含 CHECKED_IN）+ 无明细主单
   * 注意它**不扣 LOCK**、也**不按晚**——正是小程序那两个 bug 的来源。
   */
  function legacyMiniRemaining(typeId, ci, co) {
    const head = one(
      `SELECT
         (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS total_rooms,
         (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id AND r.status = 'OOO') AS ooo_rooms
       FROM room_types rt WHERE rt.id = ? AND rt.hotel_id = ?`,
      [typeId, HOTEL]
    );
    if (!head) return -1;
    const stay = Number(
      one(
        `SELECT COUNT(*) AS n FROM stays s
           JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
          WHERE s.hotel_id = ? AND r.room_type_id = ? AND s.status = 'INHOUSE'
            AND COALESCE(substr(s.check_in_time, 1, 10), '') < ?
            AND COALESCE(s.expect_check_out, '') > ?`,
        [HOTEL, typeId, co, ci]
      )?.n ?? 0
    );
    const detail = Number(
      one(
        `SELECT COUNT(*) AS n FROM booking_rooms br
           JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
          WHERE br.hotel_id = ? AND br.room_type_id = ? AND br.stay_id IS NULL
            AND br.status IN ('PENDING','CONFIRMED','CHECKED_IN')
            AND b.status IN ('PENDING','CONFIRMED','CHECKED_IN')
            AND br.check_in_date < ? AND br.check_out_date > ?`,
        [HOTEL, typeId, co, ci]
      )?.n ?? 0
    );
    const legacy = Number(
      one(
        `SELECT COALESCE(SUM(COALESCE(b.room_count, 1)), 0) AS n FROM bookings b
          WHERE b.hotel_id = ? AND b.room_type_id = ?
            AND b.status IN ('PENDING','CONFIRMED','CHECKED_IN')
            AND b.check_in_date < ? AND b.check_out_date > ?
            AND NOT EXISTS (SELECT 1 FROM booking_rooms x WHERE x.booking_id = b.id)`,
        [HOTEL, typeId, co, ci]
      )?.n ?? 0
    );
    return Math.max(0, Number(head.total_rooms) - Number(head.ooo_rooms) - stay - detail - legacy);
  }

  /* 对比表：报告里直接贴这张表（PC / 小程序在同一时刻各取一次读数，避免中途下单造成错位） */
  const matrix = [];
  const record = async (scenario, typeId, ci, co) => {
    const s = stockOf(typeId, ci, co);
    const pcRemain = s ? s.minRemain : -1;
    matrix.push({
      scenario,
      roomTypeId: typeId,
      range: `${ci}~${co}`,
      legacy: legacyMiniRemaining(typeId, ci, co),
      pc: pcRemain,
      mini: await miniRemaining(typeId, ci, co),
    });
    return pcRemain;
  };

  /* ====================================================================== */
  /* 2. bug ①：容量必须扣 LOCK（旧口径只扣 OOO）                              */
  /* ====================================================================== */

  section("一、bug① 锁房被当成可售：3 间房 = 1 空净 + 1 锁房 + 1 维修");

  const rtA = h.createRoomType({ name: "共享口径A-含锁房", basePrice: 300 });
  const roomA = h.createRooms(3, { roomTypeId: rtA, status: "VC", prefix: "SHA" });
  h.run(`UPDATE rooms SET status = 'LOCK' WHERE id = ?`, [roomA[1].id]);
  h.run(`UPDATE rooms SET status = 'OOO' WHERE id = ?`, [roomA[2].id]);
  check(
    "造数：1 间 VC + 1 间 LOCK + 1 间 OOO",
    roomA.length === 3 &&
      one(`SELECT status FROM rooms WHERE id = ?`, [roomA[0].id])?.status === "VC" &&
      one(`SELECT status FROM rooms WHERE id = ?`, [roomA[1].id])?.status === "LOCK" &&
      one(`SELECT status FROM rooms WHERE id = ?`, [roomA[2].id])?.status === "OOO"
  );
  check("lib physicalCapOfType = 1（3 − OOO − LOCK；旧代码只扣 OOO 会得 2）", capOf(rtA) === 1, `cap=${capOf(rtA)}`);

  await record("bug①-扣LOCK", rtA, D0, D1);
  const aPcRemain = stockOf(rtA, D0, D1)?.minRemain;
  const aLegacy = legacyMiniRemaining(rtA, D0, D1);
  check("旧口径在这份数据上算成 2 间可售（多卖 1 间 = 卖锁房）", aLegacy === 2, `旧=${aLegacy}`);
  check("新口径 PC 最低剩余 = 1，与旧口径差 1 间（锁房不再当库存）", aPcRemain === 1 && aLegacy - aPcRemain === 1);
  check("小程序查房 remainingRooms = 1（与 PC 同口径）", (await miniRemaining(rtA, D0, D1)) === 1);

  const a1 = await pcBook({ typeId: rtA, ci: D0, co: D1, rooms: 1, name: guestName("共享A客") });
  check("PC 建单 1 间 → 成功（唯一的物理可售房被卖掉）", a1.ok, a1.err);
  const a2 = await pcBook({ typeId: rtA, ci: D0, co: D1, rooms: 1, name: guestName("共享A客超卖") });
  check("PC 再订 1 间 → 库存不足（旧口径此时还会算成 1 间可售）", !a2.ok && /只剩 0 间/.test(a2.err), a2.err);
  check(
    "旧口径在「已卖 1 间」后仍认为可卖 1 间（超卖的直接证据）",
    legacyMiniRemaining(rtA, D0, D1) === 1,
    `旧=${legacyMiniRemaining(rtA, D0, D1)}`
  );
  check("小程序 remainingRooms 同步变成 0（与 PC 一致）", (await miniRemaining(rtA, D0, D1)) === 0);
  const aMiniReject = await miniCreate({
    roomTypeId: rtA,
    checkInDate: D0,
    checkOutDate: D1,
    roomCount: 1,
    guestName: "共享A客小程序",
    mobile: MOBILE,
    requestId: "shared-a-0001",
  });
  check(
    "小程序下单 → ROOM_NOT_ENOUGH（旧实现会成功：把锁房卖给客人）",
    aMiniReject.body?.ok === false && aMiniReject.body?.code === "ROOM_NOT_ENOUGH",
    JSON.stringify(aMiniReject.body).slice(0, 180)
  );

  /* ====================================================================== */
  /* 3. bug ① 极端：唯一一间房是 LOCK / OOO                                   */
  /* ====================================================================== */

  section("二、bug① 极端：房型唯一一间房是锁房（旧口径算成 1 间可售）");

  const rtB = h.createRoomType({ name: "共享口径B-仅锁房", basePrice: 300 });
  h.createRooms(1, { roomTypeId: rtB, status: "LOCK", prefix: "SHB" });
  await record("bug①-仅锁房", rtB, D1, D2);
  check("lib physicalCapOfType = 0（唯一一间被锁）", capOf(rtB) === 0, `cap=${capOf(rtB)}`);
  check("旧口径算成 1 间可售（锁房被当库存）", legacyMiniRemaining(rtB, D1, D2) === 1);
  check("小程序 remainingRooms = 0 且 soldOut = true", (await miniRemaining(rtB, D1, D2)) === 0 && (await miniSoldOut(rtB, D1, D2)) === true);
  const bPc = await pcBook({ typeId: rtB, ci: D1, co: D2, rooms: 1, name: guestName("共享B客") });
  check("PC 建单 → 拒绝，文案说明没有可售房（不是静默跳过校验）", !bPc.ok && /没有可售房/.test(bPc.err), bPc.err);
  const bMini = await miniCreate({
    roomTypeId: rtB,
    checkInDate: D1,
    checkOutDate: D2,
    roomCount: 1,
    guestName: "共享B客小程序",
    mobile: MOBILE,
    requestId: "shared-b-0001",
  });
  check(
    "小程序下单 → ROOM_NOT_ENOUGH（旧实现会卖出去）",
    bMini.body?.ok === false && bMini.body?.code === "ROOM_NOT_ENOUGH",
    JSON.stringify(bMini.body).slice(0, 180)
  );

  /* ====================================================================== */
  /* 4. bug ②：跨日订单被误拒（按晚拆开就该成功）                             */
  /* ====================================================================== */

  section("三、bug② 跨日误拒：2 间房，A 占 D1~D2、B 占 D2~D3，再订 D1~D3 一间");

  /** 造「相邻两晚各占一间」的数据，返回房型 id */
  async function buildAdjacentOccupancy(typeName, prefix) {
    const typeId = h.createRoomType({ name: typeName, basePrice: 300 });
    h.createRooms(2, { roomTypeId: typeId, status: "VC", prefix });
    const first = await pcBook({ typeId, ci: D1, co: D2, rooms: 1, name: guestName(`${prefix}首夜`) });
    const second = await pcBook({ typeId, ci: D2, co: D3, rooms: 1, name: guestName(`${prefix}次夜`) });
    return { typeId, first, second };
  }

  const casePc = await buildAdjacentOccupancy("共享口径C1-PC跨日", "SHC");
  check(
    "造数（房型 C1）：A 占 D1~D2、B 占 D2~D3 两单都由 PC 建单成功（两晚各占 1 间）",
    casePc.first.ok && casePc.second.ok,
    `${casePc.first.err} | ${casePc.second.err}`
  );
  await record("bug②-跨日前(PC)", casePc.typeId, D1, D3);
  const cPcRemain = stockOf(casePc.typeId, D1, D3)?.minRemain;
  const cLegacy = legacyMiniRemaining(casePc.typeId, D1, D3);
  check("旧口径：区间重叠算成「已占 2 间」→ 可售 0（这就是误拒）", cLegacy === 0, `旧=${cLegacy}`);
  check("新口径：逐晚算 D1 剩 1、D2 剩 1 → 最低剩余 1（该卖得掉）", cPcRemain === 1, `新=${cPcRemain}`);
  check("小程序查房 remainingRooms = 1（与 PC 一致，不再是 0）", (await miniRemaining(casePc.typeId, D1, D3)) === 1);

  const cPcCross = await pcBook({ typeId: casePc.typeId, ci: D1, co: D3, rooms: 1, name: guestName("共享C1跨日") });
  check("PC 真实建单「跨两晚 1 间」→ 成功（旧口径会误拒）", cPcCross.ok, cPcCross.err);
  check("PC 跨日单落地后，两边都变成 0 间可售", (await miniRemaining(casePc.typeId, D1, D3)) === 0 && stockOf(casePc.typeId, D1, D3)?.minRemain === 0);
  const cPcOver = await pcBook({ typeId: casePc.typeId, ci: D1, co: D3, rooms: 1, name: guestName("共享C1超卖") });
  check("PC 再订 1 间 → 拒绝（两晚都满了，不是误拒也不是超卖）", !cPcOver.ok && /只剩 0 间/.test(cPcOver.err), cPcOver.err);

  /* 对称场景：让**小程序**来卖这一间跨日房 */
  section("三·二、对称验证：同一组数据，改由小程序下单跨两晚 1 间");
  const caseMini = await buildAdjacentOccupancy("共享口径C2-小程序跨日", "SHM");
  check("造数（房型 C2）：A 占 D1~D2、B 占 D2~D3", caseMini.first.ok && caseMini.second.ok);
  await record("bug②-跨日前(小程序)", caseMini.typeId, D1, D3);
  check("旧口径同样算成 0 间（旧实现会直接拒单）", legacyMiniRemaining(caseMini.typeId, D1, D3) === 0);
  check("新口径/小程序 remainingRooms = 1", (await miniRemaining(caseMini.typeId, D1, D3)) === 1);
  const cMiniCross = await miniCreate({
    roomTypeId: caseMini.typeId,
    checkInDate: D1,
    checkOutDate: D3,
    roomCount: 1,
    guestName: "共享C2跨日",
    mobile: MOBILE,
    requestId: "shared-c2-0001",
  });
  check(
    "小程序真实下单「跨两晚 1 间」→ 成功（修之前是 ROOM_NOT_ENOUGH）",
    cMiniCross.body?.ok === true,
    JSON.stringify(cMiniCross.body).slice(0, 200)
  );
  check(
    "该跨日单真的落库（booking_rooms 一行，日期 D1~D3）",
    Number(
      one(
        `SELECT COUNT(*) AS n FROM booking_rooms br
           JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
          WHERE br.hotel_id = ? AND br.room_type_id = ? AND br.check_in_date = ? AND br.check_out_date = ?`,
        [HOTEL, caseMini.typeId, D1, D3]
      )?.n ?? 0
    ) === 1
  );
  check(
    "小程序跨日单落地后 remainingRooms = 0 且 soldOut（两晚都满）",
    (await miniRemaining(caseMini.typeId, D1, D3)) === 0 && (await miniSoldOut(caseMini.typeId, D1, D3)) === true
  );
  const cMiniThenPc = await pcBook({ typeId: caseMini.typeId, ci: D1, co: D3, rooms: 1, name: guestName("共享C2满后") });
  check("随后 PC 建单 → 拒绝（两个入口看到的是同一份满房状态）", !cMiniThenPc.ok && /只剩 0 间/.test(cMiniThenPc.err), cMiniThenPc.err);

  /* ====================================================================== */
  /* 5. 文案要指出「哪一晚最低」                                              */
  /* ====================================================================== */

  section("四、库存不足的文案要指出最低的那一晚（前台才知道该减间数还是换日期）");

  const rtE = h.createRoomType({ name: "共享口径E-最低夜", basePrice: 300 });
  h.createRooms(3, { roomTypeId: rtE, status: "VC", prefix: "SHE" });
  const eFill = await pcBook({ typeId: rtE, ci: D2, co: D3, rooms: 3, name: guestName("共享E占满D2") });
  check("造数：D2 这一晚被订满 3 间", eFill.ok, eFill.err);
  check("D0~D1 一晚要 3 间仍然卖得掉（stockShortage 返回 null）", lib.stockShortage(STOCK_DB, HOTEL, rtE, "最低夜房型", D0, D1, 3) === null);
  const eOver = await pcBook({ typeId: rtE, ci: D2, co: D4, rooms: 1, name: guestName("共享E最低夜") });
  check(
    `PC 拒绝文案指出 D2 当晚最低（${D2}）`,
    !eOver.ok && eOver.err.includes(D2) && /当晚最低/.test(eOver.err) && /只剩 0 间/.test(eOver.err),
    eOver.err
  );
  await record("最低夜文案", rtE, D2, D4);
  check(
    "小程序 remainingRooms 也是 0（区间内最低那晚，不是平均值）",
    (await miniRemaining(rtE, D2, D4)) === 0
  );
  check("同一房型 D3~D4（D2 之后）仍是 3 间可售（逐晚不会被别晚连坐）", (await miniRemaining(rtE, D3, D4)) === 3);

  /* ====================================================================== */
  /* 6. PC 与小程序 remainingRooms 逐房型 / 逐区间全量对比                    */
  /* ====================================================================== */

  section("五、PC 与小程序「还能订几间」全量对比（同一副本库、同一区间）");

  if (routes) {
    const ranges = [
      [D0, D1],
      [D0, D3],
      [D1, D3],
      [D2, D4],
      [D3, D4],
    ];
    const diffs = [];
    let compared = 0;
    for (const [ci, co] of ranges) {
      const pcMap = lib.roomTypeStock(STOCK_DB, HOTEL, ci, co);
      const miniRows = await call(routes.rooms, { url: `http://127.0.0.1/api/mini/rooms?checkIn=${ci}&checkOut=${co}` });
      const miniMap = new Map((miniRows.body?.data?.roomTypes ?? []).map((t) => [Number(t.roomTypeId), t]));
      if (miniMap.size !== pcMap.size) diffs.push(`${ci}~${co}: 房型数量 ${pcMap.size}≠${miniMap.size}`);
      for (const [typeId, s] of pcMap) {
        const m = miniMap.get(typeId);
        compared += 1;
        if (!m) {
          diffs.push(`${ci}~${co} 房型${typeId}: 小程序缺该房型`);
          continue;
        }
        /* 对外不返回负数（实现里 clamp 到 0），比较时按同一规则 */
        const pc = Math.max(0, s.minRemain);
        if (Number(m.remainingRooms) !== pc) diffs.push(`${ci}~${co} 房型${typeId}: PC=${pc} 小程序=${m.remainingRooms}`);
        if (Boolean(m.soldOut) !== (pc <= 0)) diffs.push(`${ci}~${co} 房型${typeId}: soldOut 不一致`);
      }
    }
    check(
      `5 个区间 × 全部房型（共 ${compared} 组）PC remaining 与小程序 remainingRooms 完全相同`,
      diffs.length === 0,
      diffs.slice(0, 6).join(" / ")
    );

    /* 判定一致性：PC 的 stockShortage 与「小程序 remaining >= need」必须同真同假 */
    const decisionDiffs = [];
    for (const [ci, co] of ranges) {
      for (const [typeId, s] of lib.roomTypeStock(STOCK_DB, HOTEL, ci, co)) {
        const mini = Math.max(0, s.minRemain);
        for (const need of [1, 2, 3]) {
          const pcPass = lib.stockShortage(STOCK_DB, HOTEL, typeId, "对比房型", ci, co, need) === null;
          const miniPass = mini >= need;
          if (pcPass !== miniPass) decisionDiffs.push(`${ci}~${co} 房型${typeId} need=${need}: PC=${pcPass} 小程序=${miniPass}`);
        }
      }
    }
    check(
      "同一批数据上，PC 判定与小程序判定（remaining >= need）逐条一致",
      decisionDiffs.length === 0,
      decisionDiffs.slice(0, 6).join(" / ")
    );
  } else {
    check("PC / 小程序全量对比可执行", false, "小程序 bundle 未就绪");
  }

  /* ====================================================================== */
  /* 7. 对比表（报告用） + 真库零写入                                        */
  /* ====================================================================== */

  section("六、场景对比表（旧口径 → 新口径 → 小程序 remainingRooms）");
  for (const row of matrix) {
    const pcClamped = Math.max(0, row.pc);
    const miniClamped = Math.max(0, row.mini);
    console.log(
      `   ${row.scenario.padEnd(22, " ")} 房型${String(row.roomTypeId).padEnd(4)} ${row.range}` +
        `  旧口径=${String(row.legacy).padStart(2)}  新PC=${String(pcClamped).padStart(2)}  小程序=${String(miniClamped).padStart(2)}`
    );
    check(
      `表项「${row.scenario}」：小程序 remainingRooms 与 PC 最低剩余相同（${pcClamped}）`,
      miniClamped === pcClamped,
      `PC=${pcClamped} 小程序=${miniClamped}`
    );
  }

  section("七、真库零写入（全部断言只发生在 VACUUM INTO 副本上）");
  check("副本库在 .tmp 下，真库文件仍然存在", fs.existsSync(h.dbPath) && fs.statSync(realDb).isFile());
  check(
    "真库 data/pms.db 零写入（测试前后 sha256 一致）",
    REAL_HASH_BEFORE === sha256(realDb) && REAL_HASH_BEFORE !== "",
    `before=${REAL_HASH_BEFORE.slice(0, 12)} after=${sha256(realDb).slice(0, 12)}`
  );
} finally {
  const fails = done();
  process.exitCode = fails > 0 ? 1 : 0;
}
