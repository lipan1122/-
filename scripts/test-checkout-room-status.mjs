/**
 * 退房房态流转 + 押金/退款不计收入验收（最终版清单第四节第 10 项 / P2-2 第 260 行）
 *
 * ── 被验收的两处 ──
 * 1. 退房后房间必须是 **VD（空脏）**，不是 VC（空净）。
 *    历史真实 bug：房态流转表 ALLOWED.OC 漏了 VD，退房时
 *    「账单已结、入住单已退、房态没变」，房间被长期占用。
 * 2. 清单第 260 行：「押金不能被算成收入，退款不能被算成正收入。」
 *
 * ── 本脚本验两半 ──
 *  A. 静态：退房动作走统一房态服务、流转表允许 OC/OD → VD、失败抛错回滚、
 *     同事务内 SETTLED/CHECKED_OUT/生成打扫任务、押金在账务口径里被排除。
 *  B. 动态：真库副本（.tmp）里在 hotel 9999 造「OC 房 + 在住单 + 房费 800 + 押金 500
 *     + 已收 1300」，按 cashier/actions.ts checkoutAction 的 SQL 逐步执行（含自动退押金），
 *     断言房态、账单、押金归零、收入口径。OD 房再跑一遍验证 OD → VD。
 *
 * ── unable to open database file（清单 281-287 行）──
 *   PMS_DB_PATH / .tmp 先建且可写 / VACUUM INTO 路径转 / 与 '' / timeout 防并发迁移持锁 /
 *   副本连 -wal -shm 一起删。
 *
 * 用法：node scripts/test-checkout-room-status.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? " → " + extra : ""}`);
  }
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cent = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const norm = (s) => s.replace(/\s+/g, " ").trim();

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const H = 9999;
const BIZ = "2030-06-15";
const NEXT = "2030-06-16";

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

function openCopy(tag) {
  if (!existsSync(REAL_DB)) {
    console.error(`真实库不存在：${REAL_DB}（用 PMS_DB_PATH 指定，或先 init-db）`);
    process.exit(1);
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}.db`);
  try {
    const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    try {
      src.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
    } finally {
      src.close();
    }
  } catch (e) {
    console.error(
      `复制真库失败：${e.message}\n  真实库 ${REAL_DB}\n  目标 ${tmp}\n` +
        `  排查：PMS_DB_PATH / .tmp 写权限 / 路径分隔符与引号转义 / 残留 -wal 占用`
    );
    process.exit(1);
  }
  const db = new DatabaseSync(tmp, { timeout: 10000 });
  return {
    db,
    tmp,
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-wal`, { force: true });
      rmSync(`${tmp}-shm`, { force: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * A. 静态：退房链路
 * ------------------------------------------------------------------ */
const CASHIER_FILE = join("src", "app", "(main)", "cashier", "actions.ts");
const STATUS_FILE = join("src", "lib", "room-status.ts");
const FOLIO_FILE = join("src", "lib", "folio.ts");

const cashierSrc = readFileSync(CASHIER_FILE, "utf8");
const statusSrc = readFileSync(STATUS_FILE, "utf8");
const folioSrc = readFileSync(FOLIO_FILE, "utf8");

function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}
const checkoutBody = funcBody(cashierSrc, "checkoutAction");

/** 房态流转表里某个 from 允许的 to 列表 */
function allowedTos(src, from) {
  const i = src.indexOf("const ALLOWED");
  const block = i < 0 ? src : src.slice(i, src.indexOf("};", i) + 2);
  const m = block.match(new RegExp(`\\n\\s*${from}:\\s*\\[([^\\]]*)\\]`));
  return (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
}
const ocAllowed = allowedTos(statusSrc, "OC");
const odAllowed = allowedTos(statusSrc, "OD");

console.log("=== A. 静态：退房链路（OC/OD → VD，同事务结账）===");

check(
  "房态流转表允许 OC → VD（住净退房必须能直接转空脏）",
  ocAllowed.includes("VD"),
  `OC 允许：${ocAllowed.join(" / ") || "取不到 ALLOWED.OC"}`
);
check(
  "房态流转表允许 OD → VD",
  odAllowed.includes("VD"),
  `OD 允许：${odAllowed.join(" / ") || "取不到 ALLOWED.OD"}`
);
check(
  "退房动作通过统一房态服务 changeRoomStatus 写 VD（不裸写 UPDATE rooms）",
  /changeRoomStatus\(\{[\s\S]{0,200}to:\s*"VD"/.test(checkoutBody) &&
    /source:\s*\{\s*kind:\s*"checkout"/.test(checkoutBody),
  norm(checkoutBody).slice(0, 160)
);
check(
  "房态流转失败会抛错回滚，不留「账单已结但房态没变」的脏数据",
  /if\s*\(\s*!roomChange\.ok\s*\)\s*\{?\s*throw/.test(checkoutBody),
  "未校验 changeRoomStatus 返回值"
);
check(
  "退房同事务把账单置 SETTLED、入住单置 CHECKED_OUT",
  /status\s*=\s*'SETTLED'/.test(checkoutBody) && /status\s*=\s*'CHECKED_OUT'/.test(checkoutBody),
  ""
);
check(
  "退房自动生成 PENDING 打扫任务",
  /INSERT INTO housekeeping/.test(checkoutBody) && /"PENDING"/.test(checkoutBody),
  ""
);
check(
  "退房自动退还押金：写负数收款（refund_of 指向原押金）并冲销 DEPOSIT 明细",
  /退房退还押金/.test(checkoutBody) && /refund_of/.test(checkoutBody) && /item_type\s*=\s*'DEPOSIT'/.test(checkoutBody),
  ""
);
check(
  "账务统一口径把押金 DEPOSIT 排除在应收之外（不是收入）",
  /NON_REVENUE_ITEM\s*=\s*`\(item_type = 'DEPOSIT'/.test(folioSrc),
  (folioSrc.match(/NON_REVENUE_ITEM = [^;]{0,120};/) ?? [""])[0]
);

/* ------------------------------------------------------------------ *
 * B. 动态：真库副本里跑退房
 * ------------------------------------------------------------------ */
console.log("\n=== B. 真库副本实测（.tmp 副本 · 租户 9999）===");

const copy = openCopy("checkout-room-status");
const { db } = copy;
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

/** 与 src/lib/folio.ts recalcFolioBalance 同口径（排除押金与部分结账调整） */
function recalcFolio(hotelId, folioId) {
  const total = round2(
    Number(
      one(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items
          WHERE folio_id = ? AND hotel_id = ?
            AND NOT (item_type = 'DEPOSIT' OR (item_type = 'ADJUST' AND description LIKE '【部分结账】%'))`,
        [folioId, hotelId]
      ).t
    )
  );
  run(`UPDATE folios SET total_amount = ?, balance = ? - COALESCE(paid_amount, 0) WHERE id = ? AND hotel_id = ?`, [
    total,
    total,
    folioId,
    hotelId,
  ]);
  const row = one(`SELECT total_amount, paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`, [folioId, hotelId]);
  return {
    total: round2(Number(row.total_amount)),
    paid: round2(Number(row.paid_amount)),
    balance: round2(Number(row.balance)),
  };
}

/**
 * 1:1 复刻 cashier/actions.ts checkoutAction 的事务体（只保留房态/账务/打扫三步）
 * 返回关键中间量，便于断言。
 */
function checkoutSim({ hotelId, stayId, roomId, folioId, operator = "测试收银" }) {
  const stay = one(`SELECT id, stay_no, deposit, status, room_id FROM stays WHERE id = ? AND hotel_id = ?`, [
    stayId,
    hotelId,
  ]);
  if (!stay) return { error: "入住单不存在" };
  if (stay.status !== "INHOUSE") return { error: "该客人已退房" };
  const room = one(`SELECT status, room_no FROM rooms WHERE id = ? AND hotel_id = ?`, [roomId, hotelId]);
  if (!room) return { error: "房间不存在" };
  const depositPay = one(
    `SELECT id, method FROM payments
      WHERE folio_id = ? AND hotel_id = ? AND amount > 0 AND remark LIKE '%押金%'
      ORDER BY id LIMIT 1`,
    [folioId, hotelId]
  );

  /* 1. 重算并校验余额（补收在这里省略：夹具已收满） */
  const money = recalcFolio(hotelId, folioId);
  if (money.balance > 0.01) return { error: `仍有欠款 ${money.balance}，请补收后再结账` };

  /* 2. 退房自动退押金 */
  const refundDue = money.balance < -0.01 ? round2(-money.balance) : 0;
  const depositOnFolio = round2(
    Number(
      one(`SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`, [
        folioId,
        hotelId,
      ]).t
    )
  );
  const refundCash = round2(Math.min(refundDue, Math.max(0, depositOnFolio)));
  if (refundCash > 0) {
    run(
      `INSERT INTO payments
         (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        folioId,
        stayId,
        `TP-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        depositPay?.method ?? "现金",
        -Math.abs(refundCash),
        BIZ,
        "退房退还押金",
        `${BIZ}T12:00:00.000+08:00`,
        depositPay?.id ?? null,
        operator,
      ]
    );
    run(`UPDATE folio_items SET amount = amount - ? WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`, [
      refundCash,
      folioId,
      hotelId,
    ]);
    run(`UPDATE stays SET deposit = COALESCE(deposit, 0) - ? WHERE id = ? AND hotel_id = ?`, [refundCash, stayId, hotelId]);
    run(`UPDATE folios SET paid_amount = COALESCE(paid_amount, 0) - ? WHERE id = ? AND hotel_id = ?`, [
      refundCash,
      folioId,
      hotelId,
    ]);
    recalcFolio(hotelId, folioId);
  }

  /* 3. 核销账单 / 4. 退房 */
  run(`UPDATE folios SET status = 'SETTLED', settled_at = ? WHERE id = ? AND hotel_id = ?`, [
    `${BIZ}T12:00:00.000+08:00`,
    folioId,
    hotelId,
  ]);
  run(`UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ? AND hotel_id = ?`, [
    BIZ,
    stayId,
    hotelId,
  ]);

  /* 5. 房态 OC/OD → VD（走统一房态服务：校验 + 写 room_logs） */
  const fromStatus = room.status;
  const ALLOWED_TO = { OC: ["OD", "VD", "VC", "OOO", "LOCK"], OD: ["OC", "VD", "OOO", "LOCK"] };
  if (!(ALLOWED_TO[fromStatus] ?? []).includes("VD")) {
    throw new Error(`房态变更失败：不能把 ${room.room_no} 从「${fromStatus}」直接改成「VD」`);
  }
  run(`UPDATE rooms SET status = 'VD' WHERE id = ? AND hotel_id = ?`, [roomId, hotelId]);
  run(
    `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [hotelId, roomId, fromStatus, "VD", `退房 ${stay.stay_no} · 结账退房`, operator, `${BIZ}T12:00:00.000+08:00`]
  );

  /* 6. 生成打扫任务 */
  run(
    `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [hotelId, roomId, "打扫", "PENDING", "测试保洁", "退房打扫", `${BIZ}T12:00:00.000+08:00`]
  );

  return { ok: true, refundCash, refundDue, depositOnFolio, fromStatus, moneyBefore: money };
}

/** 与 night-audit/actions.ts 完全一致的收入口径（只算 ROOM/FOOD/OTHER） */
const SQL_REVENUE = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
  WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type IN ('ROOM','FOOD','OTHER')`;
/** 退款冲减：当日负数收款的绝对值 */
const SQL_REFUND = `SELECT COALESCE(SUM(ABS(p.amount)), 0) AS v
  FROM payments p
  WHERE p.hotel_id = ? AND p.biz_date = ?
    AND (p.amount < 0 OR p.refund_of IS NOT NULL)`;
/** 收款流入：只算正数收款（退款不算正收入） */
const SQL_CASH_IN = `SELECT COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END), 0) AS v
  FROM payments p
  WHERE p.hotel_id = ? AND p.biz_date = ?`;

try {
  /* 租户 + 房型 + 两间房（OC 与 OD 各一间） */
  run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [
    H,
    "TEST-CHECKOUT-9999",
    "退房测试酒店",
    "测试地址",
    "000",
  ]);
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
    H,
    "TC",
    "退房测试房型",
    800,
    2,
    1,
  ]);
  const rtId = Number(one(`SELECT id FROM room_types WHERE hotel_id = ? LIMIT 1`, [H]).id);
  const ROOMS = [
    ["C801", "OC"], // 住净退房
    ["C802", "OD"], // 住脏退房
  ];
  for (const [no, st] of ROOMS) {
    run(`INSERT INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort) VALUES (?,?,?,?,?,?)`, [
      H,
      rtId,
      no,
      8,
      st,
      1,
    ]);
  }

  /** 造一间「房费 800 + 押金 500 + 已收 1300」的在住单 */
  let seq = 0;
  function seedStay(roomNo) {
    seq += 1;
    const roomId = Number(one(`SELECT id FROM rooms WHERE hotel_id = ? AND room_no = ?`, [H, roomNo]).id);
    run(
      `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, deposit, status, rate_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [H, `SC-${seq}`, roomId, `退房客${seq}`, `${BIZ}T14:00:00.000+08:00`, NEXT, 1, 800, 500, "INHOUSE", "门市价", `${BIZ}T14:00:00.000+08:00`]
    );
    const stayId = Number(one(`SELECT MAX(id) AS id FROM stays WHERE hotel_id = ?`, [H]).id);
    run(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, `SF-${seq}`, stayId, `退房客${seq}`, roomNo, 0, 1300, 0, "OPEN", `${BIZ}T14:00:00.000+08:00`]
    );
    const folioId = Number(one(`SELECT MAX(id) AS id FROM folios WHERE hotel_id = ?`, [H]).id);
    const addItem = (type, desc, amount) =>
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [H, folioId, type, desc, 1, amount, amount, BIZ, `${BIZ}T14:00:00.000+08:00`, 1]
      );
    addItem("ROOM", "房费 1 晚", 800);
    addItem("DEPOSIT", "押金", 500);
    const addPay = (amount, remark) =>
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [H, folioId, stayId, `SP-${seq}-${amount}`, "现金", amount, BIZ, remark, `${BIZ}T14:00:00.000+08:00`, "测试收银"]
      );
    addPay(500, "押金");
    addPay(800, "预付房费");
    recalcFolio(H, folioId);
    return { roomId, stayId, folioId };
  }

  /* ---- 场景 1：OC 房退房 ---- */
  const s1 = seedStay("C801");
  const before1 = one(`SELECT balance, paid_amount, total_amount FROM folios WHERE id = ?`, [s1.folioId]);
  const r1 = checkoutSim({ hotelId: H, stayId: s1.stayId, roomId: s1.roomId, folioId: s1.folioId });

  const room1 = one(`SELECT status FROM rooms WHERE id = ?`, [s1.roomId]);
  const stay1 = one(`SELECT status, deposit FROM stays WHERE id = ?`, [s1.stayId]);
  const folio1 = one(`SELECT status, balance, total_amount, paid_amount FROM folios WHERE id = ?`, [s1.folioId]);
  const depositItem1 = one(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items WHERE folio_id = ? AND item_type = 'DEPOSIT'`,
    [s1.folioId]
  );
  const log1 = one(`SELECT from_status, to_status, reason FROM room_logs WHERE room_id = ? ORDER BY id DESC LIMIT 1`, [
    s1.roomId,
  ]);
  const hk1 = one(`SELECT task_type, status FROM housekeeping WHERE room_id = ? ORDER BY id DESC LIMIT 1`, [s1.roomId]);
  const refundPay1 = one(
    `SELECT amount, refund_of, remark FROM payments WHERE folio_id = ? AND amount < 0 ORDER BY id DESC LIMIT 1`,
    [s1.folioId]
  );
  const depositPay1 = one(
    `SELECT id FROM payments WHERE folio_id = ? AND amount > 0 AND remark LIKE '%押金%' ORDER BY id LIMIT 1`,
    [s1.folioId]
  );

  check("退房前余额应为 -500（押金挂账、押金不计入应收）", cent(before1.balance) === -500, JSON.stringify(before1));
  check("退房后房态是 VD（空脏），不是 VC（空净）", room1.status === "VD", `实际 ${room1.status}`);
  check("退房后入住单 CHECKED_OUT", stay1.status === "CHECKED_OUT", `实际 ${stay1.status}`);
  check("退房后账单 SETTLED 且余额 0.00", folio1.status === "SETTLED" && cent(folio1.balance) === 0, JSON.stringify(folio1));
  check("押金明细被冲销为 0（押金余额归零）", cent(depositItem1.t) === 0, `押金明细 ${depositItem1.t}`);
  check("入住单 stays.deposit 归零（自动退押金后不再挂账）", cent(stay1.deposit) === 0, `deposit=${stay1.deposit}`);
  check(
    "自动退押金写了负数收款（-500），refund_of 指向原押金那笔",
    cent(refundPay1?.amount) === -500 &&
      Number(refundPay1?.refund_of) === Number(depositPay1?.id) &&
      /押金/.test(String(refundPay1?.remark)),
    JSON.stringify(refundPay1)
  );
  check(
    "room_logs 记录 OC → VD（结账退房）",
    log1?.from_status === "OC" && log1?.to_status === "VD" && /退房/.test(log1?.reason ?? ""),
    JSON.stringify(log1)
  );
  check("退房自动生成 PENDING 打扫任务", hk1?.task_type === "打扫" && hk1?.status === "PENDING", JSON.stringify(hk1));

  /* ---- 收入口径：押金不算收入、退款不算正收入 ---- */
  const revenue1 = round2(Number(one(SQL_REVENUE, [H, BIZ]).v));
  const refundTotal1 = round2(Number(one(SQL_REFUND, [H, BIZ]).v));
  const cashIn1 = round2(Number(one(SQL_CASH_IN, [H, BIZ]).v));
  const net1 = round2(revenue1 - refundTotal1);
  check(
    "押金不计入收入：收入 = 房费 800（不是 1300，也不是 800 + 500）",
    cent(revenue1) === 800 && cent(revenue1) !== 1300,
    `revenue=${revenue1}`
  );
  check(
    "退款不算正收入：正数收款合计仍是 1300（-500 没有被加进去）",
    cent(cashIn1) === 1300,
    `cashIn=${cashIn1}`
  );
  check(
    "退款单列为减项：refund_total = 500，净收入 = 800 − 500 = 300",
    cent(refundTotal1) === 500 && cent(net1) === 300,
    `refund=${refundTotal1} net=${net1}`
  );

  /* ---- 场景 2：OD 房退房（住脏也要能直接到空脏）---- */
  const s2 = seedStay("C802");
  const r2 = checkoutSim({ hotelId: H, stayId: s2.stayId, roomId: s2.roomId, folioId: s2.folioId });
  const room2 = one(`SELECT status FROM rooms WHERE id = ?`, [s2.roomId]);
  const log2 = one(`SELECT from_status, to_status FROM room_logs WHERE room_id = ? ORDER BY id DESC LIMIT 1`, [
    s2.roomId,
  ]);
  check("住脏 OD 房退房同样落到 VD", !r2.error && room2.status === "VD", `实际 ${room2.status} ${r2.error ?? ""}`);
  check("room_logs 记录 OD → VD", log2?.from_status === "OD" && log2?.to_status === "VD", JSON.stringify(log2));

  /* ---- 两间房都退房后的全店口径 ---- */
  const revAll = round2(Number(one(SQL_REVENUE, [H, BIZ]).v));
  const netAll = round2(revAll - round2(Number(one(SQL_REFUND, [H, BIZ]).v)));
  check(
    "两间房退房后：收入 1600、退款 1000、净收入 600（押金 1000 全程不计收入）",
    cent(revAll) === 1600 && cent(netAll) === 600,
    `revenue=${revAll} net=${netAll}`
  );
} catch (e) {
  check("副本内造数与退房流程执行成功", false, e.message);
} finally {
  copy.close();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
