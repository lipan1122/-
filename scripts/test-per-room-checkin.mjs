#!/usr/bin/env node
/**
 * 逐间入住验收（真调 frontdesk/actions.ts 的 checkInAction）
 *
 * ── 改版说明（为什么不再自己写 SQL）──
 * 旧版本自己 `UPDATE booking_rooms SET stay_id / UPDATE bookings SET status`，
 * 断言的是脚本自己的 UPDATE 序列。src/ 里的入住逻辑改坏了（押金重复收取、
 * 身份证不再拦截、超员不再拦、逐间不回填明细），旧脚本照样全绿。
 *
 * 现在：`data/pms.db --VACUUM INTO--> .tmp/per-room-checkin-<时间戳>/data/pms.db`，
 * 注入 globalThis.__pmsDb，registerHooks 把 next/* 换桩，**import 真实的
 * src/app/(main)/frontdesk/actions.ts 并真调 checkInAction**（FormData 与页面一致）。
 *
 * ── 验的东西（旧版 7 条断言一条不少，扩到 20+）──
 *   A. 一次办 3 间：3 条独立 stays、房态全 OC、押金 300 按间分摊成 3×100（旧 bug 是每间各收 300）
 *   B. 逐间办 3 间：主单要等最后一间办完才 CHECKED_IN，中途保持 CONFIRMED
 *   C. 重复身份证拦截（`id_no` 已在住）
 *   D. 超房型人数拦截（guest_count > room_types.max_occupancy）
 *   E. 静态：VC→OC 走统一房态服务（room-status.ts 的 ALLOWED + action 里真的调 changeRoomStatus）
 *   F. 真库零写入
 *
 * 造数据自给自足：房型 / 房间 / 订单全部本脚本建（房号带时间戳），
 * 不依赖环境里正好有几间空房；副本库里连 admin 都没有时也会自建管理员。
 *
 * 用法：node scripts/test-per-room-checkin.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */

import fs from "node:fs";
import path from "node:path";

import {
  createActionHarness,
  createChecker,
  isOk,
  isErr,
  msgOf,
  near,
} from "./helpers/action-harness.mjs";

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "per-room-checkin" });
const { one, all, run, invoke, localDate, hotelId: HOTEL } = h;

const TODAY = localDate(0);
const CHECKOUT = localDate(2);

/** 读源码做静态断言（不是「恒真」那种：真的去匹配实现代码；跟随 h.srcRoot 便于 mutation 自检） */
const readSrc = (rel) => fs.readFileSync(path.join(h.srcRoot, ...rel.split("/")), "utf8");
/** 截出某个 export 函数的函数体（到下一个 export 为止） */
function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}

let failed = 0;
try {
  /* ============================================================ 0. 装载真实 action */
  const frontdesk = await h.importModule("app/(main)/frontdesk/actions.ts");

  /* ============================================================ 1. 自给自足的底座 */
  section("一、造数（全部自建，不依赖环境空房）");
  const rt = h.createRoomType({ maxOccupancy: 2, basePrice: 300, name: "逐间入住验收房型" });
  const rooms = h.createRooms(6, { roomTypeId: rt, status: "VC", prefix: "CHK" });
  check("自建房型（max_occupancy=2）+ 6 间空净房", Number.isFinite(rt) && rt > 0 && rooms.length === 6);
  check(
    "checkInAction 是从真实 actions.ts 装载的可调用函数（不是脚本内复制品）",
    typeof frontdesk.checkInAction === "function" && frontdesk.checkInAction.length >= 1
  );

  /** 造一条「已排房待入住」的订单 + N 条 booking_rooms（模拟前台的排房结果） */
  let orderSeq = 0;
  function makeOrder(roomIds, { guestName = "逐间入住测试客", mobile = "", deposit = 0 } = {}) {
    orderSeq += 1;
    const now = new Date().toISOString();
    const bookingNo = `TBK-CHK-${h.stamp}-${orderSeq}`;
    const bookingId = run(
      `INSERT INTO bookings
         (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id, room_count, rate,
          check_in_date, check_out_date, nights, guest_count, deposit, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [HOTEL, bookingNo, guestName, mobile || null, rt, roomIds[0], roomIds.length, 300, TODAY, CHECKOUT, 2, 1, deposit, "CONFIRMED", now, now]
    ).lastInsertRowid;
    for (const rid of roomIds) {
      run(
        `INSERT INTO booking_rooms
           (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
            check_in_date, check_out_date, stay_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`,
        [HOTEL, bookingId, rt, rid, guestName, mobile || null, 300, "CONFIRMED", TODAY, CHECKOUT, now]
      );
    }
    return bookingId;
  }

  const guestInfo = (name, mobile, idNo) => ({
    guest_count: 1,
    guest_name_0: name,
    guest_mobile_0: mobile,
    guest_id_type_0: "身份证",
    guest_id_no_0: idNo,
    guest_gender_0: "男",
  });
  const baseForm = {
    mode: "day",
    check_in_date: TODAY,
    check_out_date: CHECKOUT,
    nights: 2,
    rate_code: "门市价",
    pay_type: "到店付款",
  };

  /* ============================================================ 2. 一次办 3 间 */
  section("二、真调 checkInAction：一次办 3 间（每间独立 stays + 押金按间分摊）");
  const orderA = makeOrder(rooms.slice(0, 3).map((r) => r.id), { guestName: "批入客人", mobile: `139${h.stamp.slice(-8)}` });
  const ID_NO_A = `IDCHK${h.stamp}-A`;
  const resA = await invoke(frontdesk.checkInAction, {
    ...baseForm,
    ...guestInfo("批入客人", `139${h.stamp.slice(-8)}`, ID_NO_A),
    room_id: rooms.slice(0, 3).map((r) => r.id),
    deposit: 300,
    booking_id: orderA,
    team_name: "",
  });
  check("一次办 3 间：action 返回成功", isOk(resA), msgOf(resA));

  const staysA = all(
    `SELECT id, stay_no, room_id, deposit, status, guest_name FROM stays WHERE hotel_id = ? AND booking_id = ? ORDER BY id`,
    [HOTEL, orderA]
  );
  check(
    "每间生成独立的 stays 行（3 条、3 个不同 id、房间各不相同）",
    staysA.length === 3 &&
      new Set(staysA.map((s) => Number(s.id))).size === 3 &&
      new Set(staysA.map((s) => Number(s.room_id))).size === 3 && [0, 1, 2].every((i) => Number(staysA[i].room_id) === rooms[i].id),
    JSON.stringify(staysA.map((s) => [s.id, s.room_id]))
  );
  check("3 条 stays 全部 INHOUSE", staysA.every((s) => s.status === "INHOUSE"), JSON.stringify(staysA.map((s) => s.status)));

  const roomStatusA = all(`SELECT id, status FROM rooms WHERE id IN (${rooms.slice(0, 3).map(() => "?").join(",")})`, rooms.slice(0, 3).map((r) => r.id));
  check("3 间房态全部变成 OC", roomStatusA.length === 3 && roomStatusA.every((r) => r.status === "OC"), JSON.stringify(roomStatusA));
  check(
    "房态变化走统一房态服务（每间一条 room_logs VC→OC）",
    all(
      `SELECT from_status, to_status, reason FROM room_logs WHERE hotel_id = ? AND room_id IN (${rooms.slice(0, 3).map(() => "?").join(",")})`,
      [HOTEL, ...rooms.slice(0, 3).map((r) => r.id)]
    ).filter((l) => l.from_status === "VC" && l.to_status === "OC").length === 3
  );

  check(
    "押金按间分摊：整单 300 → 每间 100",
    staysA.every((s) => near(s.deposit, 100)),
    JSON.stringify(staysA.map((s) => s.deposit))
  );
  const depositSum = staysA.reduce((sum, s) => sum + Number(s.deposit), 0);
  check(
    "押金合计 = 整单 300（旧 bug 每间各收 300 → 收了 900）",
    near(depositSum, 300),
    `合计 ${depositSum}`
  );
  const foliosA = all(
    `SELECT f.id, f.total_amount, f.paid_amount, f.balance FROM folios f
      JOIN stays s ON s.id = f.stay_id WHERE s.booking_id = ? ORDER BY f.id`,
    [orderA]
  );
  check(
    "每间一张账单：已收各 100、余额各 −100（押金是负债不是应收）",
    foliosA.length === 3 && foliosA.every((f) => near(f.paid_amount, 100) && near(f.balance, -100) && near(f.total_amount, 0)),
    JSON.stringify(foliosA)
  );
  const depositItems = all(
    `SELECT i.amount FROM folio_items i JOIN folios f ON f.id = i.folio_id
       JOIN stays s ON s.id = f.stay_id
      WHERE s.booking_id = ? AND i.item_type = 'DEPOSIT' ORDER BY i.id`,
    [orderA]
  );
  check(
    "押金明细 3 条各 100（合计 300）",
    depositItems.length === 3 && near(depositItems.reduce((a, b) => a + Number(b.amount), 0), 300),
    JSON.stringify(depositItems.map((d) => d.amount))
  );
  const depositPays = all(
    `SELECT p.amount FROM payments p JOIN stays s ON s.id = p.stay_id
      WHERE s.booking_id = ? AND p.kind = 'DEPOSIT' ORDER BY p.id`,
    [orderA]
  );
  check(
    "押金收款流水 3 笔各 100（合计 300）",
    depositPays.length === 3 && near(depositPays.reduce((a, b) => a + Number(b.amount), 0), 300),
    JSON.stringify(depositPays.map((p) => p.amount))
  );

  const detailsA = all(`SELECT id, room_id, stay_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [orderA]);
  check(
    "3 条明细全部回填 stay_id 并置 CHECKED_IN",
    detailsA.length === 3 && detailsA.every((d) => d.stay_id !== null && d.status === "CHECKED_IN")
  );
  check(
    "明细 stay_id 与 stays 一一对应（不是全部写同一个）",
    new Set(detailsA.map((d) => Number(d.stay_id))).size === 3 &&
      detailsA.every((d) => staysA.some((s) => Number(s.id) === Number(d.stay_id) && Number(s.room_id) === Number(d.room_id)))
  );
  const bA = one(`SELECT status, room_id FROM bookings WHERE id = ?`, [orderA]);
  check("3 间全办完主单才 CHECKED_IN", bA?.status === "CHECKED_IN", `实际 ${bA?.status}`);

  /* ============================================================ 3. 逐间办入住 */
  section("三、真调 checkInAction：逐间办入住（主单按剩余明细推进）");
  const orderB = makeOrder(rooms.slice(3, 6).map((r) => r.id), { guestName: "逐间客人", mobile: `138${h.stamp.slice(-8)}` });
  const gB = guestInfo("逐间客人", `138${h.stamp.slice(-8)}`, "");

  const rB1 = await invoke(frontdesk.checkInAction, {
    ...baseForm,
    ...gB,
    room_id: rooms[3].id,
    deposit: 0,
    booking_id: orderB,
  });
  check("逐间入住第 1 间成功", isOk(rB1), msgOf(rB1));
  check(
    "只办 1 间时明细 1 变 CHECKED_IN、其余仍 CONFIRMED",
    (() => {
      const d = all(`SELECT status, stay_id FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [orderB]);
      return d.length === 3 && d[0].status === "CHECKED_IN" && d[1].status === "CONFIRMED" && d[2].status === "CONFIRMED";
    })()
  );
  const bB1 = one(`SELECT status FROM bookings WHERE id = ?`, [orderB]);
  check("只办 1 间时主单仍是 CONFIRMED（不整单变已入住）", bB1?.status === "CONFIRMED", `实际 ${bB1?.status}`);
  check(
    "剩余未入住明细 = 2",
    Number(
      one(
        `SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ? AND status NOT IN ('CHECKED_IN','CHECKED_OUT','CANCELLED')`,
        [orderB]
      ).c
    ) === 2
  );

  const rB2 = await invoke(frontdesk.checkInAction, { ...baseForm, ...gB, room_id: rooms[4].id, deposit: 0, booking_id: orderB });
  check("逐间入住第 2 间成功", isOk(rB2), msgOf(rB2));
  const bB2 = one(`SELECT status FROM bookings WHERE id = ?`, [orderB]);
  check("办到 2 间时主单仍是 CONFIRMED", bB2?.status === "CONFIRMED", `实际 ${bB2?.status}`);

  const rB3 = await invoke(frontdesk.checkInAction, { ...baseForm, ...gB, room_id: rooms[5].id, deposit: 0, booking_id: orderB });
  check("逐间入住第 3 间成功", isOk(rB3), msgOf(rB3));
  const bB3 = one(`SELECT status FROM bookings WHERE id = ?`, [orderB]);
  check("3 间全办完主单才 CHECKED_IN", bB3?.status === "CHECKED_IN", `实际 ${bB3?.status}`);
  const staysB = all(`SELECT id, room_id FROM stays WHERE booking_id = ? ORDER BY id`, [orderB]);
  check(
    "逐间入住每间独立 stay_id（3 条 / 3 个不同）",
    staysB.length === 3 && new Set(staysB.map((s) => Number(s.id))).size === 3
  );
  check(
    "逐间入住后 3 条明细全部 CHECKED_IN 且各有自己的 stay_id",
    (() => {
      const d = all(`SELECT stay_id, status FROM booking_rooms WHERE booking_id = ?`, [orderB]);
      return d.length === 3 && d.every((x) => x.status === "CHECKED_IN" && x.stay_id !== null) && new Set(d.map((x) => Number(x.stay_id))).size === 3;
    })()
  );

  /* ============================================================ 4. 重复身份证拦截 */
  section("四、真调 checkInAction：重复身份证拦截");
  const stayCountBeforeDup = Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ?`, [HOTEL]).c);
  const dupRoom = h.createRooms(1, { roomTypeId: rt, status: "VC", prefix: "CHKD" })[0];
  const resDup = await invoke(frontdesk.checkInAction, {
    ...baseForm,
    ...guestInfo("批入客人", `139${h.stamp.slice(-8)}`, ID_NO_A),
    room_id: dupRoom.id,
    deposit: 0,
  });
  check("同一身份证再办一间 → action 返回错误", isErr(resDup), msgOf(resDup));
  check(
    "错误文案明确指出「已有在住单」（拦截来自 checkInAction 的校验③）",
    /已有在住单/.test(msgOf(resDup)),
    msgOf(resDup)
  );
  check(
    "被拦截时零写入：房间仍 VC、stays 没多出来",
    one(`SELECT status FROM rooms WHERE id = ?`, [dupRoom.id])?.status === "VC" &&
      Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ?`, [HOTEL]).c) === stayCountBeforeDup
  );

  /* ============================================================ 5. 超房型人数拦截 */
  section("五、真调 checkInAction：超房型人数拦截");
  const overRoom = h.createRooms(1, { roomTypeId: rt, status: "VC", prefix: "CHKO" })[0];
  const resOver = await invoke(frontdesk.checkInAction, {
    ...baseForm,
    guest_count: 3,
    guest_name_0: "超员甲",
    guest_name_1: "超员乙",
    guest_name_2: "超员丙",
    room_id: overRoom.id,
    deposit: 0,
  });
  check("3 人住 max_occupancy=2 的房型 → action 返回错误", isErr(resOver), msgOf(resOver));
  check(
    "错误文案写明房型上限（拦截来自 checkInAction 的校验②）",
    /最多住 2 人/.test(msgOf(resOver)),
    msgOf(resOver)
  );
  check(
    "被拦截时零写入：房间仍 VC、没有生成 stays",
    one(`SELECT status FROM rooms WHERE id = ?`, [overRoom.id])?.status === "VC" &&
      Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND room_id = ?`, [HOTEL, overRoom.id]).c) === 0
  );

  /* ============================================================ 6. 静态：房态流转 + 分摊实现 */
  section("六、静态：入住链路的关键实现还在（抓结构性回归）");
  const statusSrc = readSrc("lib/room-status.ts");
  const vcMatch = statusSrc.match(/\n\s*VC:\s*\[([^\]]*)\]/);
  check(
    "房态流转表允许 VC → OC（src/lib/room-status.ts ALLOWED.VC）",
    Boolean(vcMatch) && /["']OC["']/.test(vcMatch[1]),
    vcMatch ? `ALLOWED.VC = [${vcMatch[1].trim()}]` : "找不到 ALLOWED.VC"
  );
  const frontSrc = readSrc("app/(main)/frontdesk/actions.ts");
  const checkinBody = funcBody(frontSrc, "checkInAction");
  check(
    "checkInAction 仍走统一房态服务（changeRoomStatus + to: \"OC\"），不自己 UPDATE rooms",
    /changeRoomStatus\(\{/.test(checkinBody) && /to:\s*"OC"/.test(checkinBody)
  );
  check(
    "checkInAction 仍按间数分摊押金（depositBase = deposit / roomCount）",
    /deposit\s*\/\s*roomCount/.test(checkinBody) && /depositThisRoom/.test(checkinBody)
  );
  check(
    "checkInAction 仍有三道业务拦截（重复身份证 / 超员 / 房间被占）",
    /已有在住单/.test(checkinBody) && /max_occupancy/.test(checkinBody) && /已被在住单/.test(checkinBody)
  );

  /* ============================================================ 7. 真库零写入 */
  section("七、真库零写入（全程只在副本上跑）");
  const realRooms = h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_no LIKE ?`, [HOTEL, `CHK${h.stamp.slice(-6)}%`]);
  check("真库没有本脚本创建的测试房（房号带本次时间戳）", realRooms === 0, `${realRooms} 间`);
  const realBookings = h.realCount(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND booking_no LIKE ?`, [HOTEL, `TBK-CHK-${h.stamp}%`]);
  check("真库没有本脚本创建的测试订单", realBookings === 0, `${realBookings} 条`);
  check(
    "副本库在 .tmp 下、真库文件本身未被打开写入（只读 + VACUUM INTO）",
    fs.existsSync(h.dbPath) && fs.statSync(h.realDb).isFile(),
    `副本 ${h.dbPath}`
  );
} catch (e) {
  console.error("❌ 测试执行中断：", e?.stack ?? e);
  failed = 1;
} finally {
  failed = Math.max(failed, done());
  h.dispose();
}

process.exit(failed === 0 ? 0 : 1);
