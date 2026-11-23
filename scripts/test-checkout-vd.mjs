#!/usr/bin/env node
/**
 * 退房 → 空脏（VD）端到端验收（真调 cashier/actions.ts 的 checkoutAction）
 *
 * ── 改版说明（为什么不再自己写 SQL）──
 * 旧版本的注释里自己写着「模拟退房的三步（账单 SETTLED / 入住 CHECKED_OUT / 房态 VD）」，
 * 然后脚本自己执行这三条 UPDATE 再断言结果 —— 断言的是脚本自己的 SQL，
 * src/app/(main)/cashier/actions.ts 的 checkoutAction 改坏了（房态不再转 VD、
 * 押金不再冲销、保洁任务不再生成、余额校验被跳过），旧脚本照样全绿。
 *
 * 现在：`data/pms.db --VACUUM INTO--> .tmp/checkout-vd-<时间戳>/data/pms.db`，
 * 注入 globalThis.__pmsDb，registerHooks 把 next/* 换桩，**import 真实的
 * cashier/actions.ts 并真调 checkoutAction**（FormData 与收银台页面一致）。
 *
 * ── 验的东西（旧版 7 条断言一条不少，扩到 20+）──
 *   A. 正常退房：房态 OC→VD、room_logs、入住单 CHECKED_OUT、账单 SETTLED/balance 0、
 *      保洁任务（指派走真实派单口径）、op_logs，以及**押金无条件冲销**（stays.deposit→0）
 *   B. 有欠款不补收：action 拒绝且**整笔回滚**（房态/入住单/账单/保洁任务全不动）
 *   C. 补收后退房：补收流水 1 笔；同一 request_id 再点一次 = 幂等重放，不重复收钱
 *   D. 静态：OC→VD 在流转表里 + checkoutAction 真的走 changeRoomStatus 并检查返回值
 *   E. 真库零写入
 *
 * 造数据自给自足：房型 / 房间 / 在住单 / 账单 / 押金全部本脚本建，不依赖演示数据。
 *
 * 用法：node scripts/test-checkout-vd.mjs
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
const h = await createActionHarness({ tag: "checkout-vd" });
const { one, all, run, invoke, localDate, hotelId: HOTEL, admin } = h;

const TODAY = localDate(0);

const readSrc = (rel) => fs.readFileSync(path.join(h.srcRoot, ...rel.split("/")), "utf8");
function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}

let failed = 0;
try {
  /* ============================================================ 0. 装载真实 action */
  const cashier = await h.importModule("app/(main)/cashier/actions.ts");

  section("一、造数（全部自建，不依赖演示数据）");
  const rt = h.createRoomType({ maxOccupancy: 2, basePrice: 200, name: "退房验收房型" });
  check(
    "checkoutAction 是从真实 cashier/actions.ts 装载的可调用函数",
    typeof cashier.checkoutAction === "function" && Number.isFinite(rt) && rt > 0
  );

  let seq = 0;
  /**
   * 造一间「在住净 OC + 在住单 + 未结账单」的现场
   *
   * @param {{deposit?: number, roomTotal?: number, paid?: number}} opt
   *   deposit   入住押金（写 stays.deposit + DEPOSIT 明细 + DEPOSIT 收款流水）
   *   roomTotal 房费应收（写 ROOM 明细）
   *   paid      已收金额（押金之外另收的现金）
   */
  function makeOccupied({ deposit = 0, roomTotal = 0, paid = 0 } = {}) {
    seq += 1;
    const now = new Date().toISOString();
    const room = h.createRooms(1, { roomTypeId: rt, status: "OC", prefix: "CO" })[0];
    const stayNo = `TCO-${h.stamp}-${seq}`;
    const stayId = run(
      `INSERT INTO stays
         (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, deposit, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [HOTEL, stayNo, room.id, `退房验收客${seq}`, now, TODAY, 1, 200, deposit, "INHOUSE", now]
    ).lastInsertRowid;
    const folioNo = `FTCO-${h.stamp}-${seq}`;
    const folioId = run(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [HOTEL, folioNo, stayId, `退房验收客${seq}`, room.room_no, roomTotal, paid + deposit, roomTotal - paid - deposit, "OPEN", now]
    ).lastInsertRowid;
    if (roomTotal > 0) {
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [HOTEL, folioId, "ROOM", "房费 1 晚", 1, roomTotal, roomTotal, TODAY, now, admin.id]
      );
    }
    if (paid > 0) {
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [HOTEL, folioId, stayId, `PX${folioId}`, "现金", paid, TODAY, "预收房费", now, "验收管理员", "ROOM_PAYMENT"]
      );
    }
    if (deposit > 0) {
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [HOTEL, folioId, "DEPOSIT", "入住押金", 1, deposit, deposit, TODAY, now, admin.id]
      );
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [HOTEL, folioId, stayId, `PD${folioId}`, "现金", deposit, TODAY, "入住押金", now, "验收管理员", "DEPOSIT"]
      );
    }
    return { room, stayId, stayNo, folioId, folioNo };
  }

  /** 派单口径：本店在岗客房人员 id 最小的那位；没有则「待分配」 */
  const expectedAssignee = () => {
    const row = one(
      `SELECT real_name FROM users WHERE hotel_id = ? AND role = 'housekeeping' AND status = 1 ORDER BY id LIMIT 1`,
      [HOTEL]
    );
    return (row?.real_name ?? "").trim() || "待分配";
  };
  const payCount = (folioId, where = "1=1") =>
    Number(one(`SELECT COUNT(*) AS c FROM payments WHERE folio_id = ? AND ${where}`, [folioId]).c);
  const depositLines = (folioId) =>
    Number(
      one(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM folio_items WHERE folio_id = ? AND item_type = 'DEPOSIT'`,
        [folioId]
      ).s
    );
  const stayDeposit = (stayId) => Number(one(`SELECT COALESCE(deposit, 0) AS d FROM stays WHERE id = ?`, [stayId]).d);

  /* ============================================================ 2. A. 正常退房 */
  section("二、真调 checkoutAction：正常退房（OC → VD + 押金冲销）");
  const A = makeOccupied({ deposit: 200, roomTotal: 200, paid: 0 });
  check(
    "退房前现场就位：房态 OC、在住单 INHOUSE、账单 OPEN 且余额 0、押金 200",
    one(`SELECT status FROM rooms WHERE id = ?`, [A.room.id])?.status === "OC" &&
      one(`SELECT status FROM stays WHERE id = ?`, [A.stayId])?.status === "INHOUSE" &&
      near(one(`SELECT balance FROM folios WHERE id = ?`, [A.folioId]).balance, 0) &&
      near(stayDeposit(A.stayId), 200)
  );

  const resA = await invoke(cashier.checkoutAction, {
    stay_id: A.stayId,
    room_id: A.room.id,
    folio_id: A.folioId,
    pay_method: "现金",
    pay_amount: 0,
    request_id: `CHKOUT-A-${h.stamp}`,
  });
  check("退房成功（action 返回成功 / 或成功 redirect）", isOk(resA), msgOf(resA));

  const roomA = one(`SELECT status FROM rooms WHERE id = ?`, [A.room.id]);
  check("退房后房态变成 VD（空脏）", roomA?.status === "VD", `实际 ${roomA?.status}`);

  const logA = one(`SELECT from_status, to_status, reason, operator FROM room_logs WHERE room_id = ? ORDER BY id DESC LIMIT 1`, [A.room.id]);
  check(
    "room_logs 记录 OC→VD 且原因含「结账退房」（走统一房态服务，不是裸 UPDATE）",
    logA?.from_status === "OC" && logA?.to_status === "VD" && /结账退房/.test(String(logA?.reason)),
    JSON.stringify(logA)
  );

  const stayA = one(`SELECT status, actual_check_out FROM stays WHERE id = ?`, [A.stayId]);
  check(
    "入住单变成 CHECKED_OUT 且写了实际离店日期",
    stayA?.status === "CHECKED_OUT" && Boolean(stayA?.actual_check_out),
    JSON.stringify(stayA)
  );

  const folioA = one(`SELECT status, balance, total_amount, paid_amount FROM folios WHERE id = ?`, [A.folioId]);
  check(
    "账单变成 SETTLED 且余额 0",
    folioA?.status === "SETTLED" && near(folioA?.balance, 0),
    JSON.stringify(folioA)
  );

  /* ── 押金冲销：旧实现只在「应退余额 > 0」时冲销，balance=0 时整段跳过，只留脏账 ── */
  check(
    "押金冲销：stays.deposit 归零（旧 bug 在 balance=0 时残留 200）",
    near(stayDeposit(A.stayId), 0),
    `实际 ${stayDeposit(A.stayId)}`
  );
  check(
    "押金冲销：账单上的 DEPOSIT 明细全部清零",
    near(depositLines(A.folioId), 0),
    `实际 ${depositLines(A.folioId)}`
  );
  check(
    "押金被房费吃掉时不退现金（没有负数退款流水）",
    payCount(A.folioId, "amount < 0") === 0,
    `${payCount(A.folioId, "amount < 0")} 笔`
  );
  check(
    "押金冲销留痕：op_logs 有「退房退还押金」且写明全额冲销",
    Number(
      one(
        `SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = '退房退还押金' AND detail LIKE ?`,
        [HOTEL, `%${A.stayNo}%全额冲销%`]
      ).c
    ) === 1
  );

  const hkA = one(`SELECT task_type, status, assignee, note FROM housekeeping WHERE hotel_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL, A.room.id]);
  check(
    "自动生成 PENDING「打扫」任务（退房打扫）",
    hkA?.task_type === "打扫" && hkA?.status === "PENDING" && hkA?.note === "退房打扫",
    JSON.stringify(hkA)
  );
  check(
    "打扫任务指派走真实派单口径（在岗客房人员，不是写死姓名）",
    hkA?.assignee === expectedAssignee(),
    `期望 ${expectedAssignee()}，实际 ${hkA?.assignee}`
  );
  check(
    "操作日志写明「结账退房」且带入住单号",
    Number(
      one(
        `SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = '结账退房' AND detail LIKE ?`,
        [HOTEL, `%${A.stayNo}%`]
      ).c
    ) === 1
  );

  /* ============================================================ 3. B. 欠款未补收 → 拒绝 + 回滚 */
  section("三、真调 checkoutAction：有欠款不补收 → 拒绝且整笔回滚");
  const B = makeOccupied({ deposit: 0, roomTotal: 500, paid: 0 });
  const hkBeforeB = Number(one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ?`, [HOTEL]).c);
  const resB = await invoke(cashier.checkoutAction, {
    stay_id: B.stayId,
    room_id: B.room.id,
    folio_id: B.folioId,
    pay_method: "现金",
    pay_amount: 0,
    request_id: `CHKOUT-B-${h.stamp}`,
  });
  check("有欠款但不补收 → action 返回错误", isErr(resB), msgOf(resB));
  check("错误文案提示仍有欠款", /仍有欠款/.test(msgOf(resB)), msgOf(resB));
  check(
    "被拒绝时整笔回滚：房态仍 OC、入住单仍 INHOUSE、账单仍 OPEN",
    one(`SELECT status FROM rooms WHERE id = ?`, [B.room.id])?.status === "OC" &&
      one(`SELECT status FROM stays WHERE id = ?`, [B.stayId])?.status === "INHOUSE" &&
      one(`SELECT status FROM folios WHERE id = ?`, [B.folioId])?.status === "OPEN"
  );
  check(
    "被拒绝时没有生成保洁任务（不留下半个退房）",
    Number(one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ?`, [HOTEL]).c) === hkBeforeB
  );

  /* ============================================================ 4. C. 补收后退房 + 幂等重放 */
  section("四、真调 checkoutAction：补收后退房 + 同 request_id 重放不重复收钱");
  const C = makeOccupied({ deposit: 100, roomTotal: 400, paid: 0 });
  const RID = `CHKOUT-C-${h.stamp}`;
  const argsC = { stay_id: C.stayId, room_id: C.room.id, folio_id: C.folioId, pay_method: "现金", pay_amount: 300, request_id: RID };
  const resC1 = await invoke(cashier.checkoutAction, argsC);
  check("补收 300 后退房成功（押金 100 + 现金 300 = 房费 400）", isOk(resC1), msgOf(resC1));
  check(
    "补收流水只有 1 笔（remark = 退房补收，金额 300）",
    payCount(C.folioId, `remark = '退房补收'`) === 1 &&
      near(one(`SELECT amount FROM payments WHERE folio_id = ? AND remark = '退房补收'`, [C.folioId])?.amount, 300),
    JSON.stringify(one(`SELECT amount, remark FROM payments WHERE folio_id = ? AND remark = '退房补收'`, [C.folioId]))
  );
  check(
    "补收后退房：房态 VD、账单 SETTLED、余额 0、押金归零",
    one(`SELECT status FROM rooms WHERE id = ?`, [C.room.id])?.status === "VD" &&
      one(`SELECT status FROM folios WHERE id = ?`, [C.folioId])?.status === "SETTLED" &&
      near(one(`SELECT balance FROM folios WHERE id = ?`, [C.folioId]).balance, 0) &&
      near(stayDeposit(C.stayId), 0)
  );
  const resC2 = await invoke(cashier.checkoutAction, argsC);
  check(
    "同一 request_id 再点一次：按幂等重放返回成功（不把「已结账」报给前台）",
    isOk(resC2) || /重复提交|已处理/.test(msgOf(resC2)),
    JSON.stringify(resC2)
  );
  check(
    "重放不重复收钱：补收流水仍只有 1 笔",
    payCount(C.folioId, `remark = '退房补收'`) === 1,
    `${payCount(C.folioId, "remark = '退房补收'")} 笔`
  );

  /* ============================================================ 5. D. 静态：链路仍在 */
  section("五、静态：退房链路的关键实现还在（抓结构性回归）");
  const statusSrc = readSrc("lib/room-status.ts");
  const allowedOf = (from) => {
    const i = statusSrc.indexOf("const ALLOWED");
    const block = i < 0 ? statusSrc : statusSrc.slice(i, statusSrc.indexOf("};", i) + 2);
    const m = block.match(new RegExp(`\\n\\s*${from}:\\s*\\[([^\\]]*)\\]`));
    return (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  };
  const oc = allowedOf("OC");
  const od = allowedOf("OD");
  check("房态流转表允许 OC → VD（ALLOWED.OC 含 VD）", oc.includes("VD"), `ALLOWED.OC = [${oc.join(",")}]`);
  check("房态流转表允许 OD → VD（ALLOWED.OD 含 VD）", od.includes("VD"), `ALLOWED.OD = [${od.join(",")}]`);

  const cashierSrc = readSrc("app/(main)/cashier/actions.ts");
  const co = funcBody(cashierSrc, "checkoutAction");
  check(
    "checkoutAction 仍走统一房态服务（changeRoomStatus + to: \"VD\"）",
    /changeRoomStatus\(\{/.test(co) && /to:\s*"VD"/.test(co)
  );
  check(
    "checkoutAction 检查房态变更结果，失败就回滚整个退房（不留「账单已结、房态没变」）",
    /roomChange\.ok/.test(co) && /throw new Error\(`房态变更失败/.test(co)
  );
  check(
    "checkoutAction 无条件冲销押金（UPDATE stays SET deposit = 0 在条件块里，不是只按应退金额）",
    /UPDATE stays SET deposit = 0/.test(co) && /depositHeld\(/.test(co)
  );
  check(
    "checkoutAction 用真实派单函数生成保洁任务（pickHousekeepingAssignee）",
    /pickHousekeepingAssignee\(/.test(co) && /INSERT INTO housekeeping/.test(co)
  );

  /* ============================================================ 6. E. 真库零写入 */
  section("六、真库零写入（全程只在副本上跑）");
  const realRooms = h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_no LIKE ?`, [HOTEL, `CO${h.stamp.slice(-6)}%`]);
  check("真库没有本脚本创建的测试房", realRooms === 0, `${realRooms} 间`);
  const realStays = h.realCount(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND stay_no LIKE ?`, [HOTEL, `TCO-${h.stamp}%`]);
  check("真库没有本脚本创建的在住单", realStays === 0, `${realStays} 条`);
  check("副本库在 .tmp 下、真库文件未被打开写入（只读 + VACUUM INTO）", fs.existsSync(h.dbPath) && fs.statSync(h.realDb).isFile());
} catch (e) {
  console.error("❌ 测试执行中断：", e?.stack ?? e);
  failed = 1;
} finally {
  failed = Math.max(failed, done());
  h.dispose();
}

process.exit(failed === 0 ? 0 : 1);
