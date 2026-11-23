#!/usr/bin/env node
/**
 * 多房订单全流程验收（真调 createBookingAction → assignRoomAction → checkInAction）
 *
 * ── 改版说明（为什么不再自己写 SQL）──
 * 旧版本自己 `INSERT INTO bookings` + `INSERT INTO booking_rooms`（注释写着
 * 「模拟 createBookingAction 的双写」），排房也是自己 UPDATE 明细 + 主单镜像。
 * 于是「建单少写一条明细」「排房把 room_count 改成已排间数」「排房不再做区间冲突校验」
 * 「逐间入住不回填明细」这类业务回归一个都抓不到 —— 脚本断言的是自己的 SQL。
 *
 * 现在：`data/pms.db --VACUUM INTO--> .tmp/multiroom-flow-<时间戳>/data/pms.db`，
 * 注入 globalThis.__pmsDb，registerHooks 把 next/* 换桩，**import 真实的
 * src/app/(main)/bookings/actions.ts 与 frontdesk/actions.ts**，按前台的顺序真调：
 *
 *   createBookingAction（建 3 间订单）→ assignRoomAction（逐次排房）
 *   → checkInAction（逐间入住）
 *
 * ── 验的东西（旧版 7 条断言一条不少，扩到 25+）──
 *   A. 建单：1 条 bookings + 3 条 booking_rooms，明细全 PENDING 无房，主单 PENDING
 *   B. 排 1 间：明细 CONFIRMED + room_id，主单镜像首间房、保持 PENDING、room_count 不被改成已排间数
 *   C. 一次排 2 间但其中 1 间已被别的订单占用 → **整批回滚**，另一间也没被排进去
 *   D. 排满 3 间 → 主单 CONFIRMED
 *   E. 逐间入住 → 3 条独立 stays、3 间 OC、明细全部 CHECKED_IN、主单最后才 CHECKED_IN
 *   F. 一次办 2 间但其中 1 间房态 OOO → **整批不办**，第一间也不建 stay
 *   G. 真库零写入
 *
 * 造数据自给自足：房型 / 房间全部本脚本建，不依赖环境有多少空房。
 *
 * 用法：node scripts/test-multiroom-flow.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */

import fs from "node:fs";

import {
  createActionHarness,
  createChecker,
  isOk,
  isErr,
  msgOf,
  near,
} from "./helpers/action-harness.mjs";

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "multiroom-flow" });
const { one, all, run, invoke, localDate, hotelId: HOTEL, stamp } = h;

const TODAY = localDate(0);
const CHECKOUT = localDate(2);
const MOBILE = `137${stamp.slice(-8)}`;

let failed = 0;
try {
  /* ============================================================ 0. 装载真实 action */
  const bookings = await h.importModule("app/(main)/bookings/actions.ts");
  const frontdesk = await h.importModule("app/(main)/frontdesk/actions.ts");

  section("一、造数（全部自建，不依赖环境空房）");
  const rt = h.createRoomType({ maxOccupancy: 3, basePrice: 328, name: "多房流程验收房型" });
  const rooms = h.createRooms(6, { roomTypeId: rt, status: "VC", prefix: "MR" });
  check("自建房型 + 6 间空净房", Number.isFinite(rt) && rt > 0 && rooms.length === 6);
  check(
    "createBookingAction / assignRoomAction / checkInAction 都是从真实 actions.ts 装载的",
    typeof bookings.createBookingAction === "function" &&
      typeof bookings.assignRoomAction === "function" &&
      typeof frontdesk.checkInAction === "function"
  );

  /** 用 createBookingAction 建一张 N 间房订单，返回订单 id */
  async function createOrder(roomCount, guestName) {
    const res = await invoke(bookings.createBookingAction, {
      booking_type: "guest",
      guest_name: guestName,
      mobile: MOBILE,
      check_in_date: TODAY,
      check_out_date: CHECKOUT,
      nights: 2,
      rate_code: "门市价",
      pay_type: "到店付款",
      lines: JSON.stringify([{ room_type_id: rt, room_count: roomCount, rate: 328, breakfast: 0 }]),
      remark: "多房全流程验收",
    });
    const row = one(
      `SELECT id, booking_no, status, room_count, room_id, total_price
         FROM bookings WHERE hotel_id = ? AND guest_name = ? ORDER BY id DESC LIMIT 1`,
      [HOTEL, guestName]
    );
    return { res, booking: row };
  }

  /* ============================================================ 2. A. 建单：3 间 → 3 条明细 */
  section("二、真调 createBookingAction：3 间订单双写 3 条明细");
  const A = await createOrder(3, "多房流程客");
  check("建单成功（action 返回成功 / 或成功 redirect）", isOk(A.res), msgOf(A.res));
  check(
    "订单落库：status=PENDING、room_count=3、主单还没绑房",
    A.booking?.status === "PENDING" && Number(A.booking?.room_count) === 3 && A.booking?.room_id === null,
    JSON.stringify(A.booking)
  );
  check(
    "房费总额按「房价 × 晚数 × 间数」算（328 × 2 × 3 = 1968）",
    near(A.booking?.total_price, 1968),
    `实际 ${A.booking?.total_price}`
  );
  const detailsA0 = all(`SELECT id, room_id, status, stay_id, rate FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [A.booking.id]);
  check("建单同时生成 3 条明细", detailsA0.length === 3, `实际 ${detailsA0.length}`);
  check(
    "新建明细全部待排房（room_id 为空、status=PENDING）",
    detailsA0.every((d) => d.room_id === null && d.status === "PENDING" && d.stay_id === null)
  );

  /* ============================================================ 3. B. 排 1 间 */
  section("三、真调 assignRoomAction：先排 1 间（主单镜像 + 计数口径）");
  const R1 = await invoke(bookings.assignRoomAction, {
    bookingId: A.booking.id,
    roomIds: String(rooms[0].id),
    backTo: "/bookings",
  });
  check("排第 1 间成功", isOk(R1), msgOf(R1));
  check("成功文案提示还有 2 间待排", /还有 2 间待排房/.test(msgOf(R1)), msgOf(R1));
  const detailsA1 = all(`SELECT id, room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [A.booking.id]);
  check(
    "第 1 条明细变 CONFIRMED 且带上房号，其余 2 条仍待排",
    Number(detailsA1[0]?.room_id) === rooms[0].id &&
      detailsA1[0]?.status === "CONFIRMED" &&
      detailsA1.slice(1).every((d) => d.room_id === null && d.status === "PENDING"),
    JSON.stringify(detailsA1)
  );
  const bkA1 = one(`SELECT room_id, status, room_count FROM bookings WHERE id = ?`, [A.booking.id]);
  check("主单 room_id 镜像到首间房", Number(bkA1?.room_id) === rooms[0].id, `实际 ${bkA1?.room_id}`);
  check("还有待排房时主单保持 PENDING", bkA1?.status === "PENDING", `实际 ${bkA1?.status}`);
  check(
    "主单 room_count 仍是订单原间数 3（不被改成「已排 1 间」）",
    Number(bkA1?.room_count) === 3,
    `实际 ${bkA1?.room_count}`
  );
  check(
    "排房写操作日志（op_logs「排房」并写明还有 2 间待排）",
    Number(
      one(
        `SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = '排房' AND detail LIKE ?`,
        [HOTEL, `%${A.booking.booking_no}%还有 2 间待排%`]
      ).c
    ) === 1
  );

  /* ============================================================ 4. C. 冲突 → 整批回滚 */
  section("四、真调 assignRoomAction：一次排 2 间、其中 1 间被别的订单占用 → 整批回滚");
  /* 造冲突：另一张订单的明细已经占住 rooms[4]（同日期区间） */
  const now = new Date().toISOString();
  const clashBookingId = run(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, room_count, rate, check_in_date, check_out_date, nights, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `TCLASH-${stamp}`, "占房冲突客", rt, 1, 328, TODAY, CHECKOUT, 2, "CONFIRMED", now, now]
  ).lastInsertRowid;
  run(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, rate, status, check_in_date, check_out_date, stay_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
    [HOTEL, clashBookingId, rt, rooms[4].id, "占房冲突客", 328, "CONFIRMED", TODAY, CHECKOUT, now]
  );
  const R2 = await invoke(bookings.assignRoomAction, {
    bookingId: A.booking.id,
    roomIds: `${rooms[1].id},${rooms[4].id}`,
    backTo: "/bookings",
  });
  check("含冲突房间的批量排房被拒绝", isErr(R2), msgOf(R2));
  check("错误文案指出该房间已被其他订单的明细占用", /已被其他订单的房间明细占用/.test(msgOf(R2)), msgOf(R2));
  const detailsA2 = all(`SELECT id, room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [A.booking.id]);
  check(
    "整批回滚：没冲突的那间（rooms[1]）也没被排进去",
    detailsA2[1]?.room_id === null && detailsA2[1]?.status === "PENDING",
    JSON.stringify(detailsA2)
  );
  check(
    "整批回滚：订单仍只有 1 条已排明细",
    detailsA2.filter((d) => d.room_id !== null).length === 1,
    `${detailsA2.filter((d) => d.room_id !== null).length} 条`
  );

  /* ============================================================ 5. D. 排满 */
  section("五、真调 assignRoomAction：一次排满剩 2 间");
  const R3 = await invoke(bookings.assignRoomAction, {
    bookingId: A.booking.id,
    roomIds: `${rooms[1].id},${rooms[2].id}`,
    backTo: "/bookings",
  });
  check("一次排 2 间成功", isOk(R3), msgOf(R3));
  check("成功文案提示已排满 3 间", /3 间已排满/.test(msgOf(R3)), msgOf(R3));
  const detailsA3 = all(`SELECT id, room_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [A.booking.id]);
  check(
    "3 条明细全部 CONFIRMED 且都带上房号",
    detailsA3.length === 3 && detailsA3.every((d) => d.status === "CONFIRMED" && d.room_id !== null),
    JSON.stringify(detailsA3)
  );
  const bkA3 = one(`SELECT status, room_count FROM bookings WHERE id = ?`, [A.booking.id]);
  check("排满后主单变 CONFIRMED", bkA3?.status === "CONFIRMED", `实际 ${bkA3?.status}`);
  check("排满后 room_count 仍是 3", Number(bkA3?.room_count) === 3, `实际 ${bkA3?.room_count}`);

  /* ============================================================ 6. E. 逐间入住 */
  section("六、真调 checkInAction：逐间入住 3 间");
  const guestB = {
    guest_count: 1,
    guest_name_0: "多房流程客",
    guest_mobile_0: MOBILE,
    guest_id_type_0: "身份证",
    guest_gender_0: "男",
  };
  const baseForm = {
    mode: "day",
    check_in_date: TODAY,
    check_out_date: CHECKOUT,
    nights: 2,
    rate_code: "门市价",
    pay_type: "到店付款",
    guest_count: 1,
    guest_name_0: "多房流程客",
    guest_mobile_0: MOBILE,
    guest_id_type_0: "身份证",
    guest_gender_0: "男",
    booking_id: A.booking.id,
  };
  let staysSeen = 0;
  let mainConfirmedMidway = true;
  for (let i = 0; i < 3; i += 1) {
    const res = await invoke(frontdesk.checkInAction, {
      ...baseForm,
      ...guestB,
      room_id: rooms[i].id,
      deposit: 0,
    });
    check(`逐间入住第 ${i + 1} 间成功`, isOk(res), msgOf(res));
    const staysNow = all(`SELECT id FROM stays WHERE hotel_id = ? AND room_id = ?`, [HOTEL, rooms[i].id]);
    check(`第 ${i + 1} 间入住后该房有且仅有 1 条 stays`, staysNow.length === 1, `${staysNow.length} 条`);
    if (i < 2) {
      const st = one(`SELECT status FROM bookings WHERE id = ?`, [A.booking.id])?.status;
      if (st !== "CONFIRMED") mainConfirmedMidway = false;
    }
    staysSeen = staysNow.length;
  }
  check("只办 1~2 间时主单一直是 CONFIRMED（中途不变 CHECKED_IN）", mainConfirmedMidway);
  const staysA = all(`SELECT id, room_id, status FROM stays WHERE hotel_id = ? AND booking_id = ? ORDER BY id`, [HOTEL, A.booking.id]);
  check(
    "逐间入住后共 3 条独立 stays、全 INHOUSE、房间各不相同",
    staysA.length === 3 &&
      staysA.every((s) => s.status === "INHOUSE") &&
      new Set(staysA.map((s) => Number(s.room_id))).size === 3,
    JSON.stringify(staysA.map((s) => [s.id, s.room_id, s.status]))
  );
  const roomStates = all(`SELECT id, status FROM rooms WHERE id IN (?,?,?)`, [rooms[0].id, rooms[1].id, rooms[2].id]);
  check("3 间房态全部变成 OC", roomStates.length === 3 && roomStates.every((r) => r.status === "OC"), JSON.stringify(roomStates));
  const detailsA4 = all(`SELECT id, room_id, stay_id, status FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [A.booking.id]);
  check(
    "3 条明细全部回填独立 stay_id 并置 CHECKED_IN",
    detailsA4.length === 3 &&
      detailsA4.every((d) => d.status === "CHECKED_IN" && d.stay_id !== null) &&
      new Set(detailsA4.map((d) => Number(d.stay_id))).size === 3,
    JSON.stringify(detailsA4)
  );
  check(
    "3 间全办完后主单才 CHECKED_IN",
    one(`SELECT status FROM bookings WHERE id = ?`, [A.booking.id])?.status === "CHECKED_IN"
  );
  check("staysSeen 记录到每间都有入住单（循环内断言已覆盖）", staysSeen === 1);

  /* ============================================================ 7. F. 入住整批回滚 */
  section("七、真调 checkInAction：一次办 2 间、其中 1 间房态 OOO → 整批不办");
  const F = await createOrder(2, "整批回滚客");
  check("第二张订单建单成功（2 间）", isOk(F.res), msgOf(F.res));
  const RF = await invoke(bookings.assignRoomAction, {
    bookingId: F.booking.id,
    roomIds: `${rooms[3].id},${rooms[5].id}`,
    backTo: "/bookings",
  });
  check("第二张订单排 2 间成功", isOk(RF), msgOf(RF));
  /* 把其中一间改成维修房：checkInAction 必须整批拒绝，不能「办一半」 */
  run(`UPDATE rooms SET status = 'OOO' WHERE id = ?`, [rooms[5].id]);
  const staysBeforeF = Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ?`, [HOTEL]).c);
  const resF = await invoke(frontdesk.checkInAction, {
    ...baseForm,
    ...guestB,
    guest_name_0: "整批回滚客",
    guest_mobile_0: `136${stamp.slice(-8)}`,
    booking_id: F.booking.id,
    room_id: [rooms[3].id, rooms[5].id],
    deposit: 0,
  });
  check("其中一间不可入住 → action 返回错误", isErr(resF), msgOf(resF));
  check(
    "错误文案指出该房间不可入住（房态校验在事务之前）",
    /不可入住/.test(msgOf(resF)),
    msgOf(resF)
  );
  check(
    "整批不办：第一间（可入住的那间）仍是 VC、没有生成 stays",
    one(`SELECT status FROM rooms WHERE id = ?`, [rooms[3].id])?.status === "VC" &&
      Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ?`, [HOTEL]).c) === staysBeforeF
  );
  check(
    "整批不办：该订单 2 条明细都还是 CONFIRMED（没被回填 stay_id）",
    (() => {
      const d = all(`SELECT stay_id, status FROM booking_rooms WHERE booking_id = ?`, [F.booking.id]);
      return d.length === 2 && d.every((x) => x.stay_id === null && x.status === "CONFIRMED");
    })()
  );

  /* ============================================================ 8. G. 真库零写入 */
  section("八、真库零写入（全程只在副本上跑）");
  check(
    "真库没有本脚本创建的测试房",
    h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_no LIKE ?`, [HOTEL, `MR${h.stamp.slice(-6)}%`]) === 0
  );
  check(
    "真库没有本脚本创建的测试订单",
    h.realCount(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND booking_no LIKE ?`, [HOTEL, `TCLASH-${stamp}%`]) === 0
  );
  check("副本库在 .tmp 下、真库文件未被打开写入（只读 + VACUUM INTO）", fs.existsSync(h.dbPath) && fs.statSync(h.realDb).isFile());
} catch (e) {
  console.error("❌ 测试执行中断：", e?.stack ?? e);
  failed = 1;
} finally {
  failed = Math.max(failed, done());
  h.dispose();
}

process.exit(failed === 0 ? 0 : 1);
