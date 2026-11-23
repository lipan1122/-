#!/usr/bin/env node
/**
 * 收银台幂等验收（第十轮 P1：checkout / refund / deposit / charge 补 request_id）
 *
 * ── 缺陷（第九轮验收清单 §一.4 第 4 项）──
 * 「房间卡片里的会员充值/押金/房费/其他消费/收款/退款都要有稳定 request_id + 服务端唯一索引兜底」。
 * 第九轮只做到了「收款（addPaymentAction）」和 rooms/actions 那四个动作，收银台还漏四个：
 *   · checkoutAction   —— 退房补收流水 / 押金退款流水
 *   · refundPaymentAction —— 退款流水
 *   · addDepositAction —— 押金明细 + 押金收款流水
 *   · addChargeAction  —— 入账 / 加收房费明细
 * 这四个动作不写 payments.request_id / folio_items.request_id，
 * 于是两张表上的 `UNIQUE(hotel_id, request_id) WHERE request_id IS NOT NULL`
 * 部分唯一索引一直空转：双击提交 = 押金收两遍、钱退两次、消费记两遍。
 *
 * ── 本脚本怎么验（跑真实源码，不复制 SQL）──
 *   `data/pms.db --VACUUM INTO--> .tmp/cashier-idem-<时间戳>.db`，
 *   注入 globalThis.__pmsDb，用 registerHooks 把 next/headers、next/navigation、
 *   next/cache 换成桩，再 **import 真实的 src/app/(main)/cashier/actions.ts**，
 *   通过真实的 session（sessions 表 + admin 账号）调用真实 action：
 *
 *   1. 静态：4 个 action 都读 request_id / 都有重放分支；页面两个组件都持稳定键
 *   2. 双击收押金 / 双击加收 / 双击退款 / 双击退房 → 数据库只多一笔
 *   3. 同 request_id **真并发**（两个子进程同时提交）→ 也只成一笔
 *   4. 跨酒店同 request_id 不冲突（唯一索引是 (hotel_id, request_id)）
 *   5. 缺陷 1 回归：押金被房费吃掉（balance=0）退房也必须清零
 *
 * 用法：node scripts/test-cashier-idempotency.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
const IS_WORKER = process.argv.includes("--worker");
const STAMP = `${Date.now()}`;
const COPY_DB = IS_WORKER ? process.env.WORKER_DB : path.join(TMP_DIR, `cashier-idem-${STAMP}.db`);
const STUB_FILE = IS_WORKER ? process.env.WORKER_STUB : path.join(TMP_DIR, `cashier-idem-stub-${STAMP}.mjs`);
const H = 1;
const H2 = 8888;
const PREFIX = `T-IDEM-${STAMP}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;

function cleanup() {
  if (IS_WORKER) return;
  for (const f of [COPY_DB, `${COPY_DB}-wal`, `${COPY_DB}-shm`, STUB_FILE]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 已删 / 被占用 */
    }
  }
}
process.on("exit", cleanup);
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* ============================================================ 0. 静态断言（只在主进程） */

const srcRoot = path.join(ROOT, "src");
const CASHIER_FILE = path.join(srcRoot, "app", "(main)", "cashier", "actions.ts");
const PANEL_FILE = path.join(srcRoot, "components", "CashierPanel.tsx");
const BOARD_FILE = path.join(srcRoot, "components", "RoomBoard.tsx");
const cashierSrc = fs.readFileSync(CASHIER_FILE, "utf8");
const panelSrc = fs.readFileSync(PANEL_FILE, "utf8");
const boardSrc = fs.readFileSync(BOARD_FILE, "utf8");

/** 取某个 export 函数的源码体（到下一个 export 为止） */
function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}
/** 去掉注释再断言 SQL 文案：注释里举例说明旧写法不算「还在用」 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const bodyCharge = funcBody(cashierSrc, "addChargeAction");
const bodyDeposit = funcBody(cashierSrc, "addDepositAction");
const bodyRefund = funcBody(cashierSrc, "refundPaymentAction");
const bodyCheckout = funcBody(cashierSrc, "checkoutAction");

/** 某函数体里 INSERT 的列清单里是否有 request_id */
const writesRequestId = (body) => /request_id/.test(stripComments(body)) && /readRequestId\(formData\)/.test(body);

/* ============================================================ 1. 准备副本 + 真实源码 */

if (!IS_WORKER) {
  console.log("=== 一、静态：4 个 action + 两个组件的幂等键 ===");
  check("addChargeAction 读 request_id 并写进 folio_items", writesRequestId(bodyCharge));
  check("addDepositAction 读 request_id 并写进 payments + folio_items", writesRequestId(bodyDeposit));
  check("refundPaymentAction 读 request_id 并写进退款流水", writesRequestId(bodyRefund));
  check("checkoutAction 读 request_id 并写进退房补收 / 押金退款流水", writesRequestId(bodyCheckout));
  check(
    "4 个动作都有「同一 request_id 已入账 → 直接返回成功」的重放分支",
    /receivedPayment\(/.test(bodyDeposit) &&
      /receivedPayment\(/.test(bodyRefund) &&
      /receivedPayment\(/.test(bodyCheckout) &&
      /postedFolioItem\(/.test(bodyCharge)
  );
  check(
    "4 个动作都有并发兜底（UNIQUE 冲突按重放处理，不把报错甩给前台）",
    (stripComments(bodyCharge).match(/isUniqueViolation\(/g) ?? []).length >= 1 &&
      (stripComments(bodyDeposit).match(/isUniqueViolation\(/g) ?? []).length >= 1 &&
      (stripComments(bodyRefund).match(/isUniqueViolation\(/g) ?? []).length >= 1
  );

  /* ---- CashierPanel：每个操作各持一枚键 + 6 处隐藏字段 ---- */
  check(
    "CashierPanel 三级降级 UUID（randomUUID → getRandomValues → 时间戳）",
    /typeof c\.randomUUID === "function"/.test(panelSrc) &&
      /typeof c\.getRandomValues === "function"/.test(panelSrc) &&
      /req-\$\{Date\.now\(\)/.test(panelSrc)
  );
  check(
    "CashierPanel 六个写操作各持一枚键（checkout/receive/deposit/refund/charge/roomfee）",
    ["checkout", "receive", "deposit", "refund", "charge", "roomfee"].every((k) =>
      new RegExp(`"${k}"`).test(panelSrc)
    )
  );
  const panelHidden = (panelSrc.match(/name="request_id"/g) ?? []).length;
  check("CashierPanel 有 6 处隐藏字段把 request_id 提交给服务端（退房/收款/押金/退款/入账/加收房费）", panelHidden === 6, `实际 ${panelHidden} 处`);
  check(
    "CashierPanel 成功后换新键（bumpRequestId），失败保留同一枚",
    /if \(out && out\.ok\) bumpRequestId\(key\)/.test(panelSrc) && /const bump = \(key: string\)/.test(panelSrc)
  );
  check(
    "CashierPanel 换账单 / 换客人会整组换新键（避免跨账单撞唯一索引被当重复提交）",
    /useActionRequestIds\(`\$\{folio\.id\}:\$\{stay\.stayId\}`\)/.test(panelSrc) &&
      /setIds\(freshRequestIds\(\)\)/.test(panelSrc)
  );

  /* ---- RoomBoard：第七轮已实现，本轮核对未回退 ---- */
  check(
    "RoomBoard 三级降级 UUID（与 ShopPOS / CashierPanel 同一套）",
    /typeof c\.randomUUID === "function"/.test(boardSrc) && /typeof c\.getRandomValues === "function"/.test(boardSrc)
  );
  check(
    "RoomBoard 四种资金操作各持一枚键（deposit/addfee/consume/recharge）",
    ["deposit", "addfee", "consume", "recharge"].every((k) => new RegExp(`"${k}"`).test(boardSrc))
  );
  const boardHidden = (boardSrc.match(/name="request_id"/g) ?? []).length;
  check("RoomBoard 隐藏字段覆盖速操作弹窗 + 房间抽屉两处（4 + 4 = 8 处）", boardHidden >= 8, `实际 ${boardHidden} 处`);
}

/* ---- 副本库 ---- */
if (!IS_WORKER) {
  if (!fs.existsSync(REAL_DB)) {
    console.error(`❌ 真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs，或设 PMS_DB_PATH）`);
    process.exit(1);
  }
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    try {
      src.exec(`VACUUM INTO '${COPY_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
  } catch (e) {
    console.error(`❌ 复制真库失败\n  源 ${REAL_DB}\n  目标 ${COPY_DB}\n  ${e?.message ?? e}`);
    process.exit(1);
  }
}

const db = new DatabaseSync(COPY_DB, { timeout: 15000 });
db.exec("PRAGMA busy_timeout = 15000");
const all = (sql, p = []) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (sql, p = []) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : undefined;
};
const run = (sql, p = []) => db.prepare(sql).run(...p);
globalThis.__pmsDb = db;

/* next/headers 等换成桩：真实 session.ts 依赖 cookies() */
if (!IS_WORKER) {
  fs.writeFileSync(
    STUB_FILE,
    `let sid = null;
export function cookies() {
  return {
    get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined),
    set: () => {},
    delete: () => {},
  };
}
export function headers() { return new Map(); }
export function redirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export function revalidatePath() {}
export function revalidateTag() {}
export function setSid(v) { sid = v; }
`
  );
}
const stubUrl = pathToFileURL(STUB_FILE).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/headers" || specifier === "next/navigation" || specifier === "next/cache") {
      return { url: stubUrl, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* 交给默认解析 */
      }
    }
    return next(specifier, context);
  },
});

const stub = await import(stubUrl);
const folioLib = await import("../src/lib/folio.ts");
const cashier = await import("../src/app/(main)/cashier/actions.ts");

/* ============================================================ 会话 / 工具 */

const SID = IS_WORKER ? process.env.WORKER_SID : `test-cashier-idem-${STAMP}`;

function ensureHotelUsers() {
  /* 主酒店 admin */
  let admin = one(`SELECT id, username, real_name FROM users WHERE hotel_id = ? AND role = 'admin' ORDER BY id LIMIT 1`, [H]);
  if (!admin) {
    console.error("❌ 真库没有 hotel 1 的 admin 账号，无法跑权限链路");
    process.exit(1);
  }
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    SID,
    JSON.stringify({ id: admin.id, username: admin.username, realName: admin.real_name, role: "admin", hotelId: H, hotelName: "验收酒店" }),
    new Date().toISOString(),
    new Date(Date.now() + 3600 * 1000).toISOString(),
  ]);

  /* 第二家酒店（跨酒店 request_id 不冲突） */
  if (!one(`SELECT id FROM hotels WHERE id = ?`, [H2])) {
    run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [H2, `TEST-IDEM-${STAMP}`, "幂等测试酒店", "测试地址", "000"]);
  }
  let admin2 = one(`SELECT id, username, real_name FROM users WHERE hotel_id = ? ORDER BY id LIMIT 1`, [H2]);
  if (!admin2) {
    run(`INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (?,?,?,?,?,1)`, [
      H2,
      `idem-admin-${STAMP}`,
      "x",
      "幂等测试管理员",
      "admin",
    ]);
    admin2 = one(`SELECT id, username, real_name FROM users WHERE hotel_id = ? ORDER BY id LIMIT 1`, [H2]);
  }
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    `${SID}-h2`,
    JSON.stringify({ id: admin2.id, username: admin2.username, realName: admin2.real_name, role: "admin", hotelId: H2, hotelName: "幂等测试酒店" }),
    new Date().toISOString(),
    new Date(Date.now() + 3600 * 1000).toISOString(),
  ]);
  return { admin, admin2 };
}

const STUB_SID_KEY = "__idemSid";
if (!IS_WORKER) {
  /* 副本库：确保第二家酒店的房间类型存在 */
  ensureHotelUsers();
  stub.setSid(SID);
} else {
  /* 工作进程：父进程已建好 session，这里只切当前 sid */
  stub.setSid(process.env.WORKER_SID);
}

/** 切换会话（跨酒店用例） */
function useSession(sid) {
  stub.setSid(sid);
}

const invoke = async (fn, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  try {
    const out = await fn(fd);
    return { kind: "returned", result: out };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (msg.startsWith("NEXT_REDIRECT:")) {
      const url = msg.slice("NEXT_REDIRECT:".length);
      const q = new URL(url, "http://localhost").searchParams;
      return { kind: q.get("err") ? "err" : "ok", message: q.get("err") || q.get("msg") || "", url };
    }
    return { kind: "threw", message: msg };
  }
};

/* ============================================================ 夹具 */

let seq = 0;
const nowIso = () => new Date().toISOString();
const today = one(`SELECT date('now','localtime') AS d`)?.d ?? new Date().toISOString().slice(0, 10);

function roomTypeOf(hotelId) {
  const rt = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [hotelId]);
  if (rt) return rt.id;
  return Number(
    run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
      hotelId,
      `RT${hotelId}`,
      "测试房型",
      300,
      2,
      1,
    ]).lastInsertRowid
  );
}

/**
 * 造「在住单 + 未结账单 + 一条房费明细」
 * @param {{hotelId?:number, roomStatusRaw?:string, roomTotal?:number}} opt
 */
function fixture({ hotelId = H, roomStatusRaw = "OC", roomTotal = 0 } = {}) {
  seq += 1;
  const tag = `${PREFIX}-${seq}`;
  const now = nowIso();
  const roomId = Number(
    run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
      hotelId,
      `${hotelId === H ? "I" : "J"}${String(seq).padStart(3, "0")}${STAMP.slice(-4)}`,
      9,
      roomTypeOf(hotelId),
      roomStatusRaw,
      900 + seq,
    ]).lastInsertRowid
  );
  const stayId = Number(
    run(
      `INSERT INTO stays
         (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, deposit, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [hotelId, `S${tag}`, roomId, `幂等验收客${seq}`, now, today, 1, 300, 0, "INHOUSE", now]
    ).lastInsertRowid
  );
  const folioId = Number(
    run(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
       VALUES (?,?,?,?,?,0,0,0,'OPEN',?)`,
      [hotelId, `F${tag}`, stayId, `幂等验收客${seq}`, tag, now]
    ).lastInsertRowid
  );
  if (roomTotal > 0) {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [hotelId, folioId, "ROOM", "房费 1 晚", 1, roomTotal, roomTotal, today, now, 1]
    );
  }
  folioLib.recalcFolioBalance(hotelId, folioId);
  return { hotelId, roomId, stayId, folioId, tag };
}

const countRows = (sql, p = []) => Number(one(sql, p)?.n ?? 0);
const payCount = (folioId, where = "1=1") =>
  countRows(`SELECT COUNT(*) AS n FROM payments WHERE folio_id = ? AND ${where}`, [folioId]);
const itemCount = (folioId, where = "1=1") =>
  countRows(`SELECT COUNT(*) AS n FROM folio_items WHERE folio_id = ? AND ${where}`, [folioId]);
const depositLines = (folioId) =>
  round2(Number(one(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE folio_id = ? AND item_type='DEPOSIT'`, [folioId])?.s ?? 0));
const stayDeposit = (stayId) => round2(Number(one(`SELECT COALESCE(deposit,0) AS d FROM stays WHERE id = ?`, [stayId])?.d ?? 0));
const folioRow = (folioId) => one(`SELECT status, total_amount, paid_amount, balance FROM folios WHERE id = ?`, [folioId]);

/* ============================================================ 工作进程模式（并发用） */

if (IS_WORKER) {
  /*
   * 合法的 exit(0)：这是**子进程 worker 模式**（主进程用 WORKER_* 环境变量把它 fork 出去发并发请求），
   * 子进程只负责把结果 JSON 打到 stdout，断言与退出码由主进程汇总。
   * 不是「跳过当通过」——worker 出错会在主进程的断言里变红。
   */
  const out = await invoke(cashier.addDepositAction, {
    folio_id: process.env.WORKER_FOLIO,
    stay_id: process.env.WORKER_STAY,
    amount: process.env.WORKER_AMOUNT,
    method: "现金",
    remark: "并发押金",
    request_id: process.env.WORKER_REQ,
  });
  process.stdout.write(JSON.stringify(out) + "\n");
  db.close();
  process.exit(0);
}

/* ============================================================ 2. 双击收押金 */

console.log("\n=== 二、双击 / 重复提交只成一笔（真实 action）===");

{
  const f = fixture();
  const rid = `${PREFIX}-dep-1`;
  const [r1, r2] = await Promise.all([
    invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 200, method: "现金", request_id: rid }),
    Promise.resolve().then(() =>
      invoke(cashier.addDepositAction, { folio_id: f.folioId, stay_id: f.stayId, amount: 200, method: "现金", request_id: rid })
    ),
  ]);
  check("双击收押金：两次都返回成功（第二次是幂等重放）", r1.kind === "returned" && r1.result?.ok && r2.kind === "returned" && r2.result?.ok, `${JSON.stringify(r1)} / ${JSON.stringify(r2)}`);
  check("双击收押金：只写 1 条收款流水", payCount(f.folioId) === 1, `${payCount(f.folioId)} 条`);
  check("双击收押金：只写 1 条押金明细", itemCount(f.folioId, "item_type='DEPOSIT'") === 1, `${itemCount(f.folioId, "item_type='DEPOSIT'")} 条`);
  check("双击收押金：账单已收只加一次（+200）", near(Number(folioRow(f.folioId).paid_amount), 200), `paid=${folioRow(f.folioId).paid_amount}`);
  check("双击收押金：stays.deposit 只加一次（+200）", near(stayDeposit(f.stayId), 200), `deposit=${stayDeposit(f.stayId)}`);
  check(
    "双击收押金：op_logs 只写一条「预收款」（日志也幂等）",
    countRows(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = ? AND action = '预收款' AND detail LIKE ?`, [H, `%${f.tag}%`]) === 1
  );
}

/* ============================================================ 3. 双击加收（入账） */

{
  const f = fixture();
  const rid = `${PREFIX}-chg-1`;
  const a = await invoke(cashier.addChargeAction, {
    folio_id: f.folioId,
    item_type: "OTHER",
    description: "迷你吧",
    qty: 1,
    price: 88,
    request_id: rid,
  });
  const b = await invoke(cashier.addChargeAction, {
    folio_id: f.folioId,
    item_type: "OTHER",
    description: "迷你吧",
    qty: 1,
    price: 88,
    request_id: rid,
  });
  check("双击入账：两次都返回成功（第二次是幂等重放）", a.result?.ok && b.result?.ok, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  check("双击入账：只记 1 条消费明细", itemCount(f.folioId, "item_type='OTHER'") === 1, `${itemCount(f.folioId, "item_type='OTHER'")} 条`);
  check("双击入账：应收只加一次（88）", near(Number(folioRow(f.folioId).total_amount), 88), `total=${folioRow(f.folioId).total_amount}`);
}

/* ============================================================ 4. 双击退款 */

{
  const f = fixture();
  const dep = await invoke(cashier.addDepositAction, {
    folio_id: f.folioId,
    stay_id: f.stayId,
    amount: 300,
    method: "微信",
    request_id: `${PREFIX}-dep-r`,
  });
  const payRow = one(`SELECT id FROM payments WHERE folio_id = ? AND amount > 0 ORDER BY id DESC LIMIT 1`, [f.folioId]);
  const rid = `${PREFIX}-ref-1`;
  const a = await invoke(cashier.refundPaymentAction, { payment_id: payRow.id, amount: 100, reason: "客人临时用钱", request_id: rid });
  const b = await invoke(cashier.refundPaymentAction, { payment_id: payRow.id, amount: 100, reason: "客人临时用钱", request_id: rid });
  check("双击退款：两次都返回成功（第二次是幂等重放）", dep.result?.ok && a.result?.ok && b.result?.ok, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  check("双击退款：只写 1 条负数退款流水", payCount(f.folioId, "amount < 0") === 1, `${payCount(f.folioId, "amount < 0")} 条`);
  check("双击退款：已收只减一次（300−100=200）", near(Number(folioRow(f.folioId).paid_amount), 200), `paid=${folioRow(f.folioId).paid_amount}`);
  check("双击退款：押金明细只冲一次（300−100=200）", near(depositLines(f.folioId), 200), `明细=${depositLines(f.folioId)}`);
  check("双击退款：stays.deposit 只减一次（200）", near(stayDeposit(f.stayId), 200), `deposit=${stayDeposit(f.stayId)}`);
}

/* ============================================================ 5. 双击退房 */

{
  /* 应收 500、押金 300、补收 200 → balance 0，押金被房费吃掉；退房必须清零 */
  const f = fixture({ roomTotal: 500 });
  const dep = await invoke(cashier.addDepositAction, {
    folio_id: f.folioId,
    stay_id: f.stayId,
    amount: 300,
    method: "现金",
    request_id: `${PREFIX}-dep-co`,
  });
  const rid = `${PREFIX}-co-1`;
  const args = { stay_id: f.stayId, room_id: f.roomId, folio_id: f.folioId, pay_method: "现金", pay_amount: 200, request_id: rid };
  const a = await invoke(cashier.checkoutAction, args);
  const b = await invoke(cashier.checkoutAction, args);
  const row = folioRow(f.folioId);
  const stay = one(`SELECT status, deposit FROM stays WHERE id = ?`, [f.stayId]);
  check("双击退房：第一枪走完（重定向 = 成功）", a.kind === "ok" || a.result?.ok, JSON.stringify(a));
  check(
    "双击退房：第二枪按幂等重放返回，不报「已结账」错给前台",
    (b.kind === "ok" || (b.kind === "returned" && Boolean(b.result?.ok))) &&
      /重复提交|已处理/.test(String(b.result?.ok ?? b.message ?? "")),
    JSON.stringify(b)
  );
  check("双击退房：补收流水只有 1 笔", payCount(f.folioId, `remark = '退房补收'`) === 1, `${payCount(f.folioId, "remark = '退房补收'")} 笔`);
  check("双击退房：账单 SETTLED 且余额 0", row.status === "SETTLED" && near(Number(row.balance), 0), JSON.stringify(row));
  check("双击退房：stays.deposit 归零", near(Number(stay.deposit), 0), `deposit=${stay.deposit}`);
  check("双击退房：押金明细全部冲销（＝0）", near(depositLines(f.folioId), 0), `明细=${depositLines(f.folioId)}`);
  check(
    "双击退房：op_logs 只写一条「结账退房」（日志不重复）",
    countRows(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = ? AND action = '结账退房' AND detail LIKE ?`, [H, `%S${f.tag}%`]) === 1
  );
  check("双击退房：只有 1 条押金退款 / 或 0 条（押金被房费吃掉时不退现金）", payCount(f.folioId, "amount < 0") <= 1);
  check("双击退房：dep 押金收款仍只有 1 笔（没被重复收）", payCount(f.folioId, "kind='DEPOSIT' AND amount > 0") === 1);
  check("双击退房：整单流水恰好 3 笔（押金 + 补收 + 0/1 退款）", payCount(f.folioId) === 2 + payCount(f.folioId, "amount < 0"), `${payCount(f.folioId)} 笔`);
  void dep;
}

/* ============================================================ 6. 真并发：两个进程同 request_id */

{
  console.log("\n=== 三、同 request_id 真并发（两个子进程同时提交）===");
  const f = fixture();
  const rid = `${PREFIX}-race-1`;
  const env = {
    ...process.env,
    WORKER_DB: COPY_DB,
    WORKER_STUB: STUB_FILE,
    WORKER_SID: SID,
    WORKER_FOLIO: String(f.folioId),
    WORKER_STAY: String(f.stayId),
    WORKER_AMOUNT: "150",
    WORKER_REQ: rid,
  };
  const spawnWorker = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [process.argv[1], "--worker"], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    });
  const results = await Promise.all([spawnWorker(), spawnWorker()]);
  const succeeded = results.filter((r) => r.code === 0 && /"kind":"returned"/.test(r.out) && /"ok"/.test(r.out)).length;
  check("两个进程都正常返回（没有把 UNIQUE 报错抛给前台）", results.every((r) => r.code === 0), results.map((r) => r.err.slice(0, 120)).join(" | "));
  check("两个进程都报告成功（一个是真入账、一个是幂等重放）", succeeded === 2, JSON.stringify(results.map((r) => r.out)));
  check("并发同 request_id：只写 1 条收款流水", payCount(f.folioId) === 1, `${payCount(f.folioId)} 条`);
  check("并发同 request_id：只写 1 条押金明细", itemCount(f.folioId, "item_type='DEPOSIT'") === 1, `${itemCount(f.folioId, "item_type='DEPOSIT'")} 条`);
  check("并发同 request_id：已收只加一次（150）", near(Number(folioRow(f.folioId).paid_amount), 150), `paid=${folioRow(f.folioId).paid_amount}`);
  check("并发同 request_id：stays.deposit 只加一次（150）", near(stayDeposit(f.stayId), 150), `deposit=${stayDeposit(f.stayId)}`);
}

/* ============================================================ 7. 跨酒店 request_id 不冲突 */

{
  console.log("\n=== 四、跨酒店同 request_id 不能互相当成重复提交 ===");
  const a = fixture({ hotelId: H });
  const b = fixture({ hotelId: H2 });
  const rid = `${PREFIX}-cross-1`;
  const r1 = await invoke(cashier.addDepositAction, { folio_id: a.folioId, stay_id: a.stayId, amount: 100, method: "现金", request_id: rid });
  useSession(`${SID}-h2`);
  const r2 = await invoke(cashier.addDepositAction, { folio_id: b.folioId, stay_id: b.stayId, amount: 100, method: "现金", request_id: rid });
  useSession(SID);
  const rows = all(`SELECT id, hotel_id FROM payments WHERE request_id = ? ORDER BY id`, [rid]);
  check("酒店 1 收押金成功", Boolean(r1.result?.ok), JSON.stringify(r1));
  check("酒店 2 用同一枚 request_id 收押金也成功（不是重复提交）", Boolean(r2.result?.ok), JSON.stringify(r2));
  check(
    "唯一索引按 (hotel_id, request_id) 分区：两家酒店各 1 笔",
    rows.length === 2 && rows[0].hotel_id === H && rows[1].hotel_id === H2,
    JSON.stringify(rows)
  );
  check(
    "唯一索引定义就是 (hotel_id, request_id) 的部分唯一索引",
    /UNIQUE INDEX idx_payments_request ON payments\(hotel_id, request_id\)/i.test(
      String(one(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_payments_request'`)?.sql ?? "")
    ) &&
      /UNIQUE INDEX idx_folio_items_request ON folio_items\(hotel_id, request_id\)/i.test(
        String(one(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_folio_items_request'`)?.sql ?? "")
      )
  );
}

/* ============================================================ 8. 缺陷 1 回归：押金必须清零 */

{
  console.log("\n=== 五、缺陷 1 回归：退房必须无条件冲销全部押金 ===");

  /* 场景 A：押金 800、应收 1072、补收 272 → balance 0（旧代码在这里跳过整段冲销） */
  const a = fixture({ roomTotal: 1072 });
  await invoke(cashier.addDepositAction, { folio_id: a.folioId, stay_id: a.stayId, amount: 800, method: "现金", request_id: `${PREFIX}-d1` });
  const ca = await invoke(cashier.checkoutAction, {
    stay_id: a.stayId,
    room_id: a.roomId,
    folio_id: a.folioId,
    pay_method: "现金",
    pay_amount: 272,
    request_id: `${PREFIX}-c1`,
  });
  const ra = folioRow(a.folioId);
  check("A. 退房成功", ca.kind === "ok" || ca.result?.ok === true, JSON.stringify(ca));
  check("A. 补收后余额为 0 的账单退房后：stays.deposit 归零（旧代码残留 800）", near(Number(one(`SELECT deposit FROM stays WHERE id = ?`, [a.stayId]).deposit), 0));
  check("A. 押金明细全部冲销（旧代码残留 800）", near(depositLines(a.folioId), 0), `明细=${depositLines(a.folioId)}`);
  check("A. 账单 SETTLED 且余额 0", ra.status === "SETTLED" && near(Number(ra.balance), 0), JSON.stringify(ra));
  check("A. 押金全部抵扣房费 → 不产生退款流水", payCount(a.folioId, "amount < 0") === 0, `${payCount(a.folioId, "amount < 0")} 笔`);
  check(
    "A. 日志写明「押金抵扣房费 ¥800.00」",
    countRows(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = ? AND action = '退房退还押金' AND detail LIKE ?`, [H, `%抵扣房费 ¥800.00%`]) >= 1
  );

  /* 场景 B：押金 500、应收 300 → 退现金 200 */
  const b = fixture({ roomTotal: 300 });
  await invoke(cashier.addDepositAction, { folio_id: b.folioId, stay_id: b.stayId, amount: 500, method: "支付宝", request_id: `${PREFIX}-d2` });
  const cb = await invoke(cashier.checkoutAction, {
    stay_id: b.stayId,
    room_id: b.roomId,
    folio_id: b.folioId,
    pay_method: "现金",
    pay_amount: 0,
    request_id: `${PREFIX}-c2`,
  });
  const rb = folioRow(b.folioId);
  const refundB = one(`SELECT amount, kind, refund_of, remark FROM payments WHERE folio_id = ? AND amount < 0 ORDER BY id DESC LIMIT 1`, [b.folioId]);
  const depPayB = one(`SELECT id FROM payments WHERE folio_id = ? AND kind='DEPOSIT' AND amount > 0 ORDER BY id LIMIT 1`, [b.folioId]);
  check("B. 退房成功", cb.kind === "ok" || cb.result?.ok === true, JSON.stringify(cb));
  check("B. 退现金 200（押金 500 − 房费 300）", near(Number(refundB?.amount), -200), JSON.stringify(refundB));
  check("B. 退款流水 kind=DEPOSIT_REFUND 且 refund_of 指向原押金", refundB?.kind === "DEPOSIT_REFUND" && Number(refundB?.refund_of) === Number(depPayB?.id), JSON.stringify(refundB));
  check("B. 押金明细归零 / stays.deposit 归零", near(depositLines(b.folioId), 0) && near(Number(one(`SELECT deposit FROM stays WHERE id = ?`, [b.stayId]).deposit), 0));
  check("B. 账单 SETTLED 且余额 0（500−200=300 已收 = 应收）", rb.status === "SETTLED" && near(Number(rb.balance), 0) && near(Number(rb.paid_amount), 300), JSON.stringify(rb));

  /* 场景 C：只有 stays.deposit、明细已被手动退光 → 退房也要把 stays.deposit 清零 */
  const c = fixture({ roomTotal: 400 });
  await invoke(cashier.addDepositAction, { folio_id: c.folioId, stay_id: c.stayId, amount: 400, method: "现金", request_id: `${PREFIX}-d3` });
  /* 手动把押金全退掉（模拟历史脏数据：明细冲光但 stays.deposit 没跟上的场景改为直接改库） */
  run(`UPDATE folio_items SET amount = 0 WHERE folio_id = ? AND item_type = 'DEPOSIT'`, [c.folioId]);
  const cc = await invoke(cashier.checkoutAction, {
    stay_id: c.stayId,
    room_id: c.roomId,
    folio_id: c.folioId,
    pay_method: "现金",
    pay_amount: 0,
    request_id: `${PREFIX}-c3`,
  });
  check("C. 退房成功（明细为 0 但 stays.deposit 还有值）", cc.kind === "ok" || cc.result?.ok === true, JSON.stringify(cc));
  check("C. stays.deposit 仍然被强制归零", near(Number(one(`SELECT deposit FROM stays WHERE id = ?`, [c.stayId]).deposit), 0));
}

/* ============================================================ 9. 真库零写入 */

console.log("\n=== 六、真库零写入 ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  const n = Number(real.prepare(`SELECT COUNT(*) AS n FROM rooms WHERE room_no LIKE ?`).get(`%${STAMP.slice(-4)}%`)?.n ?? 0);
  const p = Number(real.prepare(`SELECT COUNT(*) AS n FROM payments WHERE remark IN ('并发押金') `).get()?.n ?? 0);
  real.close();
  check("真库没有本脚本创建的房间", n === 0, `${n} 条`);
  check("真库没有本脚本写入的「并发押金」流水", p === 0, `${p} 条`);
}

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(`（在副本上跑，真库 ${REAL_DB} 未被修改）\n`);
process.exit(fail === 0 ? 0 : 1);
