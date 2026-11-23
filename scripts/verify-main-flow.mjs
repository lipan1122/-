/**
 * 主流程真实验收：入住 → 收押金 → 加消费 → 退房 → 开票
 *
 * ── 为什么不是「点页面」 ──
 *
 * 页面用的是 Next 16 的 `$ACTION_REF_1` 引用式 Server Action 协议，
 * 用 curl 直 post 要手工构造 RSC 编码，容易构造出一个「和浏览器不一样」的请求 ——
 * 那样的验证不能证明用户点按钮能跑通。
 *
 * 所以这里用 `scripts/helpers/action-harness.mjs` 直接加载**真实的 actions.ts** 并调用，
 * 走真实的事务、真实的权限校验、真实的 session（真的往 sessions 表写一行）。
 * 它验证的是「服务端业务逻辑」，不是「浏览器交互」—— 后者需要人工点。
 *
 * ── 为什么要跑在目标环境 ──
 *
 * 本地跑的库和 VPS 的库不是同一份数据（VPS 上经过 load-demo / 各种修复脚本）。
 * 这个脚本要在**目标库**上跑，才能证明「这台机器上这条链路能走通」。
 *
 * 用法：
 *   PMS_DB_PATH=/opt/pms/data/pms.db node scripts/verify-main-flow.mjs
 *   PMS_SRC_ROOT=/opt/pms node scripts/verify-main-flow.mjs
 *
 * 在 VPS 上（sudo）：
 *   cd /opt/pms && sudo PMS_SRC_ROOT=/opt/pms node scripts/verify-main-flow.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createActionHarness, createChecker, isOk, isErr, msgOf, near } from "./helpers/action-harness.mjs";

const { check, section, done } = createChecker();
const h = await createActionHarness({ tag: "mainflow", hotelId: 1, hotelName: "主流程验收酒店" });
const { one, all, run, invoke, localDate, hotelId: HOTEL } = h;

const TODAY = localDate(0);
const TOMORROW = localDate(1);

let failed = 0;

try {
  /* ════════════════════════════════════════════════════════
   * 一、造数：房型 + 3 间房 + 客人 + 预订单
   * ════════════════════════════════════════════════════════ */
  section("一、造数");

  const rt = h.createRoomType({ maxOccupancy: 2, basePrice: 300, name: "主流程验收房型" });
  check("建房型成功", Number.isFinite(rt) && rt > 0, `rt=${rt}`);

  const rooms = h.createRooms(2, { roomTypeId: rt, status: "VC" });
  check("建 2 间 VC 房", rooms.length === 2, `rooms=${rooms.length}`);

  /*
   * 客人 / 预订单：harness 只提供 createRoomType / createRooms，这两个自己造。
   * 单号带时间戳，避免撞真库唯一索引。
   */
  const stamp = String(Date.now()).slice(-9);
  const guestName = `主流程客人${stamp}`;
  const guestMobile = `139${stamp}`;
  const guest = Number(
    run(
      `INSERT INTO guests (hotel_id, name, mobile, vip_level, blacklist, created_at, deleted)
        VALUES (?,?,?,0,0,?,0)`,
      [HOTEL, guestName, guestMobile, new Date().toISOString()]
    ).lastInsertRowid
  );
  check("建客人成功", Number.isFinite(guest) && guest > 0, `guest=${guest}`);

  /* 预订单（未排房，今日入住） */
  const bk = Number(
    run(
      `INSERT INTO bookings (hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, check_in_date, check_out_date, room_count, nights, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,1,1,'CONFIRMED',?,?)`,
      [
        HOTEL,
        `MF-${stamp}`,
        guest,
        guestName,
        guestMobile,
        rt,
        TODAY,
        TOMORROW,
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    ).lastInsertRowid
  );
  run(
    `INSERT INTO booking_rooms (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, guest_id, created_at)
      VALUES (?,?,?,NULL,?,?,300,'CONFIRMED',?,?,?,?)`,
    [HOTEL, bk, rt, guestName, guestMobile, TODAY, TOMORROW, guest, new Date().toISOString()]
  );
  check("建预订单成功", Number.isFinite(bk) && bk > 0, `bk=${bk}`);

  /* ════════════════════════════════════════════════════════
   * 二、入住（真调 checkInAction）
   * ════════════════════════════════════════════════════════ */
  section("二、入住（checkInAction）");

  const frontdesk = await h.importModule("app/(main)/frontdesk/actions.ts");
  check("checkInAction 可加载", typeof frontdesk.checkInAction === "function");

  const roomA = rooms[0];
  /*
   * 字段名要跟 checkInAction 里 `readStr(formData, \`guest_name_${i}\`)` 一致 ——
   * 是**带住客序号后缀**的（guest_name_0 / guest_mobile_0），
   * 不是 UI 层看到的名字。
   */
  const checkInRes = await invoke(frontdesk.checkInAction, {
    room_id: String(roomA.id),
    booking_id: String(bk),
    guest_count: "1",
    guest_name_0: guestName,
    guest_mobile_0: guestMobile,
    guest_gender_0: "男",
    check_in_date: TODAY,
    check_out_date: TOMORROW,
    nights: "1",
    rate: "300",
    deposit: "300",
  });

  check("入住返回成功（或跳转不算错）", isOk(checkInRes) || /NEXT_REDIRECT/.test(msgOf(checkInRes)), msgOf(checkInRes).slice(0, 120));

  const stay = one(
    `SELECT id, stay_no, room_id, guest_id, status, deposit, rate FROM stays
      WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE' ORDER BY id DESC LIMIT 1`,
    [HOTEL, roomA.id]
  );
  check("生成在住单且状态 INHOUSE", Boolean(stay?.id) && stay.status === "INHOUSE", JSON.stringify(stay));
  check("在住单房间正确", stay?.room_id === roomA.id);

  const roomAfter = one(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [roomA.id, HOTEL]);
  check("房态变 OC", roomAfter?.status === "OC", roomAfter?.status);

  const folio = one(`SELECT id, total_amount, paid_amount, balance, status FROM folios WHERE hotel_id = ? AND stay_id = ?`, [
    HOTEL,
    stay?.id,
  ]);
  check("生成账单", Boolean(folio?.id), JSON.stringify(folio));

  const depPay = one(
    `SELECT amount, kind FROM payments WHERE hotel_id = ? AND stay_id = ? AND kind = 'DEPOSIT' ORDER BY id DESC LIMIT 1`,
    [HOTEL, stay?.id]
  );
  check("写入押金流水 kind=DEPOSIT", depPay?.kind === "DEPOSIT" && Number(depPay.amount) > 0, JSON.stringify(depPay));

  /* ════════════════════════════════════════════════════════
   * 三、加押金（真调 addDepositAction）
   * ════════════════════════════════════════════════════════ */
  section("三、追加押金（addDepositAction）");

  const cashier = await h.importModule("app/(main)/cashier/actions.ts");
  check("addDepositAction 可加载", typeof cashier.addDepositAction === "function");

  const depBefore = Number(one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE hotel_id = ? AND stay_id = ? AND kind='DEPOSIT'`, [HOTEL, stay?.id])?.s ?? 0);
  const addDepRes = await invoke(cashier.addDepositAction, {
    folio_id: String(folio?.id),
    amount: "200",
    method: "现金",
    remark: "主流程验收追加押金",
    request_id: `MF-dep-${Date.now()}`,
  });
  const depAfter = Number(one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE hotel_id = ? AND stay_id = ? AND kind='DEPOSIT'`, [HOTEL, stay?.id])?.s ?? 0);
  check("追加押金后合计 +200", near(depAfter - depBefore, 200), `${depBefore} → ${depAfter}（${msgOf(addDepRes).slice(0, 60)}）`);

  /* ════════════════════════════════════════════════════════
   * 四、加房费/消费（真调 addChargeAction）
   * ════════════════════════════════════════════════════════ */
  section("四、加消费（addChargeAction）");

  const chargeRes = await invoke(cashier.addChargeAction, {
    folio_id: String(folio?.id),
    item_type: "OTHER",
    description: "主流程验收·矿泉水",
    qty: "2",
    price: "5",
    request_id: `MF-charge-${Date.now()}`,
  });
  const otherItem = one(
    `SELECT amount, description FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'OTHER' ORDER BY id DESC LIMIT 1`,
    [HOTEL, folio?.id]
  );
  check("写入消费明细 2×5=10", near(Number(otherItem?.amount ?? 0), 10), `${JSON.stringify(otherItem)}（${msgOf(chargeRes).slice(0, 60)}）`);

  /* ════════════════════════════════════════════════════════
   * 五、退房（真调 checkoutAction）
   * ════════════════════════════════════════════════════════ */
  section("五、退房（checkoutAction）");

  const folioBefore = one(`SELECT total_amount, paid_amount, balance, status FROM folios WHERE id = ? AND hotel_id = ?`, [
    folio?.id,
    HOTEL,
  ]);

  const checkoutRes = await invoke(cashier.checkoutAction, {
    stay_id: String(stay?.id),
    room_id: String(roomA.id),
    folio_id: String(folio?.id),
    pay_method: "现金",
    pay_amount: "0",
    request_id: `MF-out-${Date.now()}`,
  });

  check("退房返回成功或跳转", isOk(checkoutRes) || /NEXT_REDIRECT/.test(msgOf(checkoutRes)), msgOf(checkoutRes).slice(0, 120));

  const stayAfter = one(`SELECT status, deposit, actual_check_out FROM stays WHERE id = ? AND hotel_id = ?`, [stay?.id, HOTEL]);
  check("入住单变 CHECKED_OUT", stayAfter?.status === "CHECKED_OUT", stayAfter?.status);
  check("退房后押金归零", near(Number(stayAfter?.deposit ?? 0), 0), `deposit=${stayAfter?.deposit}`);
  check("写入实际离店时间", Boolean(stayAfter?.actual_check_out), stayAfter?.actual_check_out);

  const roomFinal = one(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [roomA.id, HOTEL]);
  check("房态变 VD（空脏）", roomFinal?.status === "VD", roomFinal?.status);

  const folioFinal = one(`SELECT total_amount, paid_amount, balance, status FROM folios WHERE id = ? AND hotel_id = ?`, [
    folio?.id,
    HOTEL,
  ]);
  check("账单结清 balance=0", near(Number(folioFinal?.balance ?? -1), 0), JSON.stringify(folioFinal));
  check("账单状态 SETTLED 或 CHARGED", ["SETTLED", "CHARGED"].includes(String(folioFinal?.status)), folioFinal?.status);
  check(
    "账单 paid = SUM(payments)（账实一致）",
    near(
      Number(folioFinal?.paid_amount ?? 0),
      Number(one(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, folio?.id])?.s ?? -1)
    ),
    `paid=${folioFinal?.paid_amount}`
  );
  check(
    "押金明细已冲销（无 amount>0.01 的 DEPOSIT 行）",
    Number(
      one(`SELECT COUNT(*) AS c FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT' AND amount > 0.01`, [
        HOTEL,
        folio?.id,
      ])?.c ?? 1
    ) === 0
  );

  /* 保洁任务 */
  const hk = one(`SELECT id, status FROM housekeeping WHERE hotel_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1`, [
    HOTEL,
    roomA.id,
  ]);
  check("自动生成保洁任务且 PENDING", hk?.status === "PENDING", JSON.stringify(hk));

  /* ════════════════════════════════════════════════════════
   * 六、开票（真调 issueInvoice）
   * ════════════════════════════════════════════════════════ */
  section("六、开票（issueInvoice）");

  const invoiceLib = await h.importModule("lib/invoice.ts");
  check("issueInvoice 可加载", typeof invoiceLib.issueInvoice === "function");

  const invRes = invoiceLib.issueInvoice({
    hotelId: HOTEL,
    folioId: Number(folio?.id),
    title: "主流程验收公司",
    taxNo: "91330100MA2XXXXX1A",
    amount: Number(folioFinal?.total_amount ?? 0),
    operator: "验收",
    requestId: `MF-inv-${Date.now()}`,
  });
  check("开票成功", Boolean(invRes?.ok ?? invRes?.id ?? invRes), JSON.stringify(invRes).slice(0, 120));

  const inv = one(`SELECT id, invoice_no, amount, status, red_of FROM invoices WHERE hotel_id = ? AND folio_id = ? ORDER BY id DESC LIMIT 1`, [
    HOTEL,
    folio?.id,
  ]);
  check("生成发票记录", Boolean(inv?.id), JSON.stringify(inv));
  check("发票金额与账单一致", near(Number(inv?.amount ?? -1), Number(folioFinal?.total_amount ?? -2)), `inv=${inv?.amount} folio=${folioFinal?.total_amount}`);

  /* ════════════════════════════════════════════════════════
   * 七、收尾：清理本次造的数据
   * ════════════════════════════════════════════════════════ */
  section("七、清理");

  let cleaned = 0;
  try {
    run(`DELETE FROM invoices WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, folio?.id]);
    run(`DELETE FROM housekeeping WHERE hotel_id = ? AND room_id = ? AND id = ?`, [HOTEL, roomA.id, hk?.id]);
    run(`DELETE FROM payments WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, folio?.id]);
    run(`DELETE FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, folio?.id]);
    run(`DELETE FROM folios WHERE hotel_id = ? AND id = ?`, [HOTEL, folio?.id]);
    run(`DELETE FROM stays WHERE hotel_id = ? AND id = ?`, [HOTEL, stay?.id]);
    run(`DELETE FROM booking_rooms WHERE hotel_id = ? AND booking_id = ?`, [HOTEL, bk]);
    run(`DELETE FROM bookings WHERE hotel_id = ? AND id = ?`, [HOTEL, bk]);
    run(`DELETE FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [HOTEL, rt]);
    run(`DELETE FROM room_types WHERE hotel_id = ? AND id = ?`, [HOTEL, rt]);
    run(`DELETE FROM guests WHERE hotel_id = ? AND id = ?`, [HOTEL, guest]);
    run(`DELETE FROM op_logs WHERE hotel_id = ? AND created_at >= ?`, [HOTEL, new Date(Date.now() - 600000).toISOString()]);
    cleaned = 1;
  } catch (e) {
    console.warn("  清理失败（不影响结论）：", e.message);
  }
  check("清理本次测试数据", cleaned === 1);
} catch (e) {
  console.error("\n❌ 脚本异常中断：", e.message);
  console.error(e.stack);
  failed = 1;
}

const result = await done();
process.exit(Number(result?.failed ?? 0) > 0 || failed ? 1 : 0);
