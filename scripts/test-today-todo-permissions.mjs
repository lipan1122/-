#!/usr/bin/env node
/**
 * 今日待办 / 逾期订单动作权限验收（第六轮整改清单一.4，清单第 57-71 行）
 *
 * ── 验收对象 ──
 *   src/app/(main)/today-todo/actions.ts 的 5 个写动作：
 *     confirmAllArrivalsAction / confirmArrivalAction   → booking.modify
 *     cancelAllOverdueAction  / cancelOverdueAction     → booking.cancel
 *     convertOverdueAction                              → booking.modify
 *
 * ── 清单要求 ↔ 本脚本的断言 ──
 *   1. 确认预抵使用 booking.modify、取消使用 booking.cancel、转今日预订使用 booking.modify
 *      → 一、库层权限点 + 二、源码守卫位置 + 三、逐角色行为
 *   2. 批量取消必须二次确认，显示订单数量、日期范围和库存影响
 *      → 二、页面源码里有 ConfirmForm + message/detail 同时含「订单数量 / 日期范围 / 库存影响」
 *   3. 取消后 booking_rooms 必须释放
 *      → 三、取消后明细 status='CANCELLED' 且 room_id IS NULL，覆盖当天的占房明细归零
 *   4. 所有操作写 op_logs
 *      → 三、每个动作执行后对应 action 的日志条数 +1，且 detail 带关键数字
 *   5. 不能跨酒店修改订单
 *      → 三、hotel 999 的单据在单条取消 / 批量取消后状态不变
 *
 * ── 为什么必须真开数据库 ──
 *   权限守卫和「释放 booking_rooms」都在服务端函数体里，grep 只能证明源码里有那几行；
 *   只有把真实的 actions.ts 加载起来、对着真库（VACUUM INTO 副本）执行，才能证明
 *   ① 客房账号调用时异常发生在写库之前；② admin 调用后房量占用真的没了。
 *
 * ── 数据库隔离 ──
 *   data/pms.db --VACUUM INTO--> .tmp/today-todo-permissions-<时间戳>.db
 *   副本打开后注入 globalThis.__pmsDb（src/lib/db.ts 的 getDb 优先用它），
 *   因此 actions.ts 里的每一次 run/get 都落在副本上，真库一个字节都不动（脚本最后复查）。
 *
 * 运行：node scripts/test-today-todo-permissions.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
const STAMP = `${Date.now()}`;
const COPY_DB = path.join(TMP_DIR, `today-todo-permissions-${STAMP}.db`);
const STUB_FILE = path.join(TMP_DIR, `today-todo-permissions-stub-${STAMP}.mjs`);
/** 跨酒店用例专用酒店（真库只有 1 号店） */
const HOTEL_B = 999;
/** 测试单号前缀：用于「真库零写入」复查 */
const PREFIX = `TEST-TODO-${STAMP}`;

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

function cleanup() {
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

/* ============================================================ 副本库 */

console.log("=== 一、副本库（VACUUM INTO）：权限点 + 会话 + 测试订单 ===");

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
  console.error(`❌ 复制真库失败（unable to open database file）\n  源 ${REAL_DB}\n  目标 ${COPY_DB}\n  ${e?.message ?? e}`);
  process.exit(1);
}
check("副本库已生成（VACUUM INTO）", fs.existsSync(COPY_DB) && fs.statSync(COPY_DB).size > 0, COPY_DB);

const db = new DatabaseSync(COPY_DB, { timeout: 10000 });
db.exec("PRAGMA busy_timeout = 8000");
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

/* 生产代码读的库 = 副本库（必须在动态 import 之前注入） */
globalThis.__pmsDb = db;

/* ============================================================ 桩 + 加载真实源码 */

fs.writeFileSync(
  STUB_FILE,
  `// 验收脚本用的最小桩：只实现 session.ts / actions.ts 用到的 next/* API
let sid = null;
export function cookies() {
  return {
    get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined),
    set: () => {},
    delete: () => {},
  };
}
export function headers() {
  return new Map();
}
export function redirect(url) {
  throw new Error("NEXT_REDIRECT:" + url);
}
export function notFound() {
  throw new Error("NEXT_NOT_FOUND");
}
export function revalidatePath() {}
export function revalidateTag() {}
export function unstable_cache(fn) { return fn; }
export function setSid(v) { sid = v; }
`
);
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
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)
    ) {
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
const session = await import("../src/lib/session.ts");
const actions = await import("../src/app/(main)/today-todo/actions.ts");
check(
  "已加载真实源码：src/lib/session.ts + src/app/(main)/today-todo/actions.ts",
  typeof session.hasPermission === "function" && typeof actions.cancelAllOverdueAction === "function"
);

/* ============================================================ 权限点（库 + 生产函数） */

const PERM_MODIFY = "booking.modify";
const PERM_CANCEL = "booking.cancel";
const ROLES = ["admin", "frontdesk", "cashier", "housekeeping"];

for (const perm of [PERM_MODIFY, PERM_CANCEL]) {
  const rows = all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = ?`, [perm]).map((r) => r.role);
  check(
    `role_permissions(hotel 1, ${perm}) 允许 admin + frontdesk`,
    rows.includes("admin") && rows.includes("frontdesk"),
    `实际 [${rows.join(",")}]`
  );
  check(
    `role_permissions(hotel 1, ${perm}) 不含 cashier / housekeeping`,
    !rows.includes("cashier") && !rows.includes("housekeeping"),
    `实际 [${rows.join(",")}]`
  );
  for (const role of ROLES) {
    const expected = role === "admin" || role === "frontdesk";
    const actual = session.hasPermission(role, perm, 1);
    check(`hasPermission(${role}, ${perm}) = ${expected}`, actual === expected, `实际 ${actual}`);
  }
}

/* 真会话行：requirePermission 走的是 sessions + users，不是传参 */
const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
const userRows = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = 1 ORDER BY id`);
const sidOf = {};
for (const u of userRows) {
  const sid = `test-todo-${u.role}-${STAMP}`;
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    sid,
    JSON.stringify({
      id: u.id,
      username: u.username,
      realName: u.real_name,
      role: u.role,
      hotelId: u.hotel_id,
      hotelName: "验收酒店",
    }),
    new Date().toISOString(),
    expiresAt,
  ]);
  sidOf[u.role] = sid;
}
check("4 个角色都有验收会话行（admin / frontdesk / cashier / housekeeping）", Object.keys(sidOf).length === 4, Object.keys(sidOf).join(","));

for (const perm of [PERM_MODIFY, PERM_CANCEL]) {
  stub.setSid(sidOf.admin);
  let adminOutcome;
  try {
    const u = await session.requirePermission(perm);
    adminOutcome = `ALLOWED:${u.role}`;
  } catch (e) {
    adminOutcome = `DENIED:${e?.message ?? e}`;
  }
  check(`requirePermission(${perm}) 对 admin 放行`, adminOutcome === "ALLOWED:admin", adminOutcome);

  stub.setSid(sidOf.housekeeping);
  let hkOutcome;
  try {
    await session.requirePermission(perm);
    hkOutcome = "ALLOWED";
  } catch (e) {
    hkOutcome = `DENIED:${e?.message ?? e}`;
  }
  check(
    `requirePermission(${perm}) 对 housekeeping 抛 FORBIDDEN`,
    hkOutcome.startsWith("DENIED") && hkOutcome.includes("FORBIDDEN") && hkOutcome.includes(perm),
    hkOutcome
  );
}

/* ============================================================ 源码层：守卫位置 + 页面二次确认 */

console.log("\n=== 二、源码层：守卫在写库之前 + 批量取消二次确认文案 ===");

const ACTIONS_REL = path.join("src", "app", "(main)", "today-todo", "actions.ts");
const PAGE_REL = path.join("src", "app", "(main)", "today-todo", "page.tsx");
const actionsSrc = fs.readFileSync(path.join(ROOT, ACTIONS_REL), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, PAGE_REL), "utf8");

function funcBody(src, name) {
  const sig = `export async function ${name}(`;
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + sig.length);
  return src.slice(i, j < 0 ? src.length : j);
}
function firstMutationIndex(body) {
  const patterns = [
    /(?:^|\n)\s*run\s*\(/,
    /(?:^|\n)\s*tx\s*\(/,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
  ];
  let min = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined) {
      const at = m.index + (m[0].startsWith("\n") ? 1 : 0);
      if (min < 0 || at < min) min = at;
    }
  }
  return min;
}

const EXPECT = {
  confirmAllArrivalsAction: PERM_MODIFY,
  confirmArrivalAction: PERM_MODIFY,
  cancelAllOverdueAction: PERM_CANCEL,
  cancelOverdueAction: PERM_CANCEL,
  convertOverdueAction: PERM_MODIFY,
};

for (const [fn, perm] of Object.entries(EXPECT)) {
  const body = funcBody(actionsSrc, fn);
  check(`${fn} 在源码里存在`, body.length > 0);
  if (!body) continue;
  const permAt = body.search(new RegExp(`requirePermission\\(\\s*"${perm.replace(".", "\\.")}"\\s*\\)`));
  check(`${fn} 的第一道守卫是 requirePermission("${perm}")`, permAt >= 0);
  check(
    `${fn} 不再只用 requireUser()（写动作已改为权限点校验）`,
    !/const\s+user\s*=\s*await\s+requireUser\(\)/.test(body.slice(0, 400)),
    body.split("\n").slice(0, 4).join(" / ")
  );
  const mutAt = firstMutationIndex(body);
  check(`${fn} 的权限断言早于任何写库操作`, permAt >= 0 && (mutAt < 0 || permAt < mutAt), `perm=${permAt} mutation=${mutAt}`);
}

check(
  "取消动作释放 booking_rooms（SET room_id = NULL, status = 'CANCELLED'）",
  /UPDATE\s+booking_rooms\s+SET\s+room_id\s*=\s*NULL,\s*status\s*=\s*'CANCELLED'/.test(actionsSrc)
);
check(
  "转今日预订同步顺延 booking_rooms 日期（否则顺延后不占房 → 超卖）",
  /UPDATE\s+booking_rooms[\s\S]{0,160}SET\s+check_in_date\s*=\s*\?,\s*check_out_date\s*=\s*\?/.test(actionsSrc)
);
/*
 * 跨酒店防护的静态检查：凡是读写 bookings / booking_rooms / op_logs 的 SQL，条件里必须有 hotel_id。
 * 不用「全文出现次数」这种弱断言（它跟 SQL 条数无关，删掉一条也会过），
 * 而是把每条模板字符串 SQL 拆出来逐条看。
 */
/* 注释里也会出现反引号包着的 SQL 片段（讲旧实现），先去掉注释再拆 SQL，避免误判 */
const codeOnly = actionsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const sqlBlocks = codeOnly.match(/`[^`]*`/g) ?? [];
const missingHotel = sqlBlocks.filter((block) => {
  const touches = /FROM\s+bookings\b|FROM\s+booking_rooms\b|\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b[\s\S]*\b(bookings|booking_rooms|op_logs)\b/i.test(
    block
  );
  return touches && !/hotel_id/i.test(block);
});
check(
  "每条读写 bookings / booking_rooms / op_logs 的 SQL 都带 hotel_id（禁止跨酒店改单）",
  sqlBlocks.length > 0 && missingHotel.length === 0,
  missingHotel.map((s) => s.slice(0, 60).replace(/\s+/g, " ")).join(" | ")
);

check("页面用要求二次确认的组件 ConfirmForm", /import\s+ConfirmForm\s+from\s+"@\/components\/ConfirmForm"/.test(pageSrc) && /<ConfirmForm/.test(pageSrc));
check(
  "批量取消的确认文案含「订单数量 / 日期范围 / 库存影响」三项",
  /订单数量：/.test(pageSrc) && /日期范围：/.test(pageSrc) && /库存影响：/.test(pageSrc),
  "确认框没把这三项显示出来"
);
check("批量取消的确认框要求填写取消原因（requireReason）", /action=\{cancelAllOverdueAction\}[\s\S]{0,900}requireReason="取消原因"/.test(pageSrc));
check(
  "页面按钮按权限隐藏（hasPermission booking.modify / booking.cancel）",
  /hasPermission\(\s*user\.role,\s*"booking\.modify"/.test(pageSrc) && /hasPermission\(\s*user\.role,\s*"booking\.cancel"/.test(pageSrc)
);

/* ============================================================ 测试数据 */

console.log("\n=== 三、行为：逐角色调用真实 action（副本库） ===");

const pad = (n) => String(n).padStart(2, "0");
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayOffset(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
const TODAY = dayOffset(0);

const room = one(`SELECT id, room_type_id FROM rooms WHERE hotel_id = 1 ORDER BY id LIMIT 1`);
check("真库里至少有 1 间房（用于造已排房号的明细）", Boolean(room?.id));

function addBooking(o) {
  const res = run(
    `INSERT INTO bookings
       (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
        check_in_date, check_out_date, nights, room_count, guest_count, rate, status,
        booking_type, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      o.hotelId ?? 1,
      o.no,
      o.guest ?? "权限验收客人",
      "13800000000",
      o.roomTypeId ?? (room?.room_type_id ?? 1),
      o.roomId ?? null,
      o.checkIn,
      o.checkOut,
      o.nights ?? 1,
      o.roomCount ?? 1,
      1,
      200,
      o.status ?? "PENDING",
      "guest",
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  );
  return Number(res.lastInsertRowid);
}
function addDetail(o) {
  const res = run(
    `INSERT INTO booking_rooms
       (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
        check_in_date, check_out_date, stay_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      o.hotelId ?? 1,
      o.bookingId,
      o.roomTypeId ?? (room?.room_type_id ?? 1),
      o.roomId ?? null,
      "权限验收客人",
      "13800000000",
      200,
      o.status ?? "PENDING",
      o.checkIn,
      o.checkOut,
      null,
      new Date().toISOString(),
    ]
  );
  return Number(res.lastInsertRowid);
}

/* 测试酒店（跨酒店用例） */
run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  "TEST999",
  "待办权限验收酒店",
  "测试地址",
  "000",
  new Date().toISOString(),
]);

/* A：今天到店、待确认（确认预抵对象，不能被批量取消误伤） */
const bkT = addBooking({ no: `${PREFIX}-TODAY`, checkIn: TODAY, checkOut: dayOffset(1), nights: 1, status: "PENDING" });
addDetail({ bookingId: bkT, checkIn: TODAY, checkOut: dayOffset(1) });

/* B：逾期未到、已确认、2 间房明细（其中 1 间已排房号）—— 批量取消的主对象 */
const bkOver1 = addBooking({
  no: `${PREFIX}-OVER1`,
  checkIn: dayOffset(-2),
  checkOut: dayOffset(1),
  nights: 3,
  roomCount: 2,
  status: "CONFIRMED",
});
const detail1 = addDetail({
  bookingId: bkOver1,
  roomId: room?.id ?? null,
  status: "CONFIRMED",
  checkIn: dayOffset(-2),
  checkOut: dayOffset(1),
});
addDetail({ bookingId: bkOver1, status: "PENDING", checkIn: dayOffset(-2), checkOut: dayOffset(1) });

/* C：逾期未到、NOSHOW、1 间明细（离店日 = 今天，不覆盖今天） */
const bkOver2 = addBooking({
  no: `${PREFIX}-OVER2`,
  checkIn: dayOffset(-3),
  checkOut: TODAY,
  nights: 3,
  status: "NOSHOW",
});
addDetail({ bookingId: bkOver2, status: "PENDING", checkIn: dayOffset(-3), checkOut: TODAY });

/* E：只给「转今日预订」用的逾期单 —— 注意必须在批量取消之后再造（见 3.6），
 *    否则它会被 3.4 的批量取消一起取消掉（批量取消覆盖本店全部逾期单）。
 *    这里先占位，3.6 再插入。 */

/* F：别家酒店（hotel 999）的逾期单 */
const bkB = addBooking({
  hotelId: HOTEL_B,
  no: `${PREFIX}-HOTEL999`,
  checkIn: dayOffset(-2),
  checkOut: dayOffset(1),
  nights: 3,
  status: "PENDING",
});
const detailB = addDetail({ hotelId: HOTEL_B, bookingId: bkB, checkIn: dayOffset(-2), checkOut: dayOffset(1) });

check("已造好 4 张测试订单（今天 1 / 逾期 2 / hotel 999 1）", bkT && bkOver1 && bkOver2 && bkB);

const statusOf = (id) => one(`SELECT status, check_in_date, check_out_date, nights, room_id FROM bookings WHERE id = ?`, [id]);
const detailRowsOf = (id) =>
  all(`SELECT id, status, room_id, check_in_date, check_out_date FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [id]);
const logCount = (action) => Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = 1 AND action = ?`, [action])?.c ?? 0);
const logsOf = (action) =>
  all(`SELECT operator, detail, created_at FROM op_logs WHERE hotel_id = 1 AND action = ? ORDER BY id DESC LIMIT 3`, [action]);

/** 与 lib/room-stock.ts 相同的占房口径：有效明细 + 区间覆盖某天 */
function occupiedDetails(day) {
  return Number(
    one(
      `SELECT COUNT(*) AS c
         FROM booking_rooms br
         JOIN bookings b ON b.id = br.booking_id AND b.hotel_id = br.hotel_id
        WHERE br.hotel_id = 1 AND br.status IN ('PENDING','CONFIRMED')
          AND br.check_in_date <= ? AND br.check_out_date > ?
          /*
           * 排除演示数据（DEMO- 前缀）
           *
           * 这个断言的本意是「批量取消逾期单后，今天只剩『我造的那张今天到店』」。
           * 但演示数据里每天还有 1 条未来预订、今天还有 3 条「今日预抵」
           * （都带 booking_rooms 明细），它们本来就会占今天的房。
           * 不排除的话这条永远从 4 → 4 红，而实际上批量取消是对的
           * （相邻那条 overdueOccupiedAfter === 0 已经证明释放成功）。
           */
          AND b.booking_no NOT LIKE 'DEMO-%'`,
      [day, day]
    )?.c ?? 0
  );
}

async function invoke(fn, fd) {
  try {
    await fn(fd);
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

/* ---------- 3.1 housekeeper：5 个动作全部被拒，且没有副作用 ---------- */
stub.setSid(sidOf.housekeeping);
const beforeTodayStatus = statusOf(bkT)?.status;
const beforeOver1 = statusOf(bkOver1);
const beforeOccupied = occupiedDetails(TODAY);

{
  const fd = new FormData();
  fd.set("id", String(bkT));
  const r = await invoke(actions.confirmArrivalAction, fd);
  check(
    "housekeeper 调 confirmArrivalAction → FORBIDDEN（booking.modify）",
    !r.ok && r.message.includes("FORBIDDEN") && r.message.includes(PERM_MODIFY),
    r.message
  );
  check("housekeeper 被拒后预抵订单仍是 PENDING（守卫早于写库）", statusOf(bkT)?.status === beforeTodayStatus, String(statusOf(bkT)?.status));
}
{
  const r = await invoke(actions.confirmAllArrivalsAction, new FormData());
  check("housekeeper 调 confirmAllArrivalsAction → FORBIDDEN", !r.ok && r.message.includes("FORBIDDEN"), r.message);
  check("housekeeper 被拒后预抵订单仍未被批量确认", statusOf(bkT)?.status === "PENDING");
}
{
  const fd = new FormData();
  fd.set("id", String(bkOver1));
  const r = await invoke(actions.cancelOverdueAction, fd);
  check(
    "housekeeper 调 cancelOverdueAction → FORBIDDEN（booking.cancel）",
    !r.ok && r.message.includes("FORBIDDEN") && r.message.includes(PERM_CANCEL),
    r.message
  );
  check("housekeeper 被拒后逾期订单仍 CONFIRMED、房明细仍占房", statusOf(bkOver1)?.status === "CONFIRMED" && occupiedDetails(TODAY) === beforeOccupied);
}
{
  const fd = new FormData();
  fd.set("reason", "越权测试");
  const r = await invoke(actions.cancelAllOverdueAction, fd);
  check("housekeeper 调 cancelAllOverdueAction → FORBIDDEN", !r.ok && r.message.includes("FORBIDDEN"), r.message);
  check("housekeeper 被拒后所有逾期订单状态未变", statusOf(bkOver1)?.status === beforeOver1?.status && statusOf(bkOver2)?.status === "NOSHOW");
}
{
  const fd = new FormData();
  fd.set("id", String(bkOver2));
  const r = await invoke(actions.convertOverdueAction, fd);
  check("housekeeper 调 convertOverdueAction → FORBIDDEN（booking.modify）", !r.ok && r.message.includes("FORBIDDEN"), r.message);
  check(
    "housekeeper 被拒后逾期单日期未变（没有被顺延到今天）",
    statusOf(bkOver2)?.check_in_date === dayOffset(-3),
    String(statusOf(bkOver2)?.check_in_date)
  );
}

/* ---------- 3.2 admin：确认预抵 ---------- */
stub.setSid(sidOf.admin);
const confirmLogBefore = logCount("确认预抵");
{
  const fd = new FormData();
  fd.set("id", String(bkT));
  const r = await invoke(actions.confirmArrivalAction, fd);
  check("admin 调 confirmArrivalAction 被放行", r.ok, r.message);
  check("admin 确认后订单状态 PENDING → CONFIRMED", statusOf(bkT)?.status === "CONFIRMED", String(statusOf(bkT)?.status));
  check("确认预抵写了一条 op_logs", logCount("确认预抵") === confirmLogBefore + 1, `${confirmLogBefore} → ${logCount("确认预抵")}`);
  const log = logsOf("确认预抵")[0];
  check(
    "op_logs 记了操作人与订单号",
    Boolean(log) && log.operator === "张经理" && String(log.detail).includes(`#${bkT}`),
    JSON.stringify(log)
  );
}

/* 幂等：重复确认（已是 CONFIRMED）不重复写日志、不改状态 */
const confirmLogAfter = logCount("确认预抵");
{
  const fd = new FormData();
  fd.set("id", String(bkT));
  await invoke(actions.confirmArrivalAction, fd);
  check("重复确认同一条预抵不重复写日志（res.changes = 0 才写）", logCount("确认预抵") === confirmLogAfter);
}

/* ---------- 3.3 admin：单条取消逾期（核心：booking_rooms 必须释放） ---------- */
const cancelLogBefore = logCount("取消逾期预订");
const occupiedBeforeCancel = occupiedDetails(TODAY);
{
  const fd = new FormData();
  fd.set("id", String(bkOver1));
  fd.set("reason", "客人未到店，电话确认取消");
  const r = await invoke(actions.cancelOverdueAction, fd);
  check("admin 调 cancelOverdueAction 被放行", r.ok, r.message);

  const bk = statusOf(bkOver1);
  check("单条取消后订单状态 = CANCELLED", bk?.status === "CANCELLED", String(bk?.status));
  check("单条取消后主单 room_id 被清空（房态图不再显示占用）", bk?.room_id === null, String(bk?.room_id));

  const details = detailRowsOf(bkOver1);
  check(
    "★ 单条取消后 booking_rooms 真的释放了（2 条明细全部 CANCELLED）",
    details.length === 2 && details.every((d) => d.status === "CANCELLED"),
    JSON.stringify(details)
  );
  check(
    "★ 释放时同时清空 room_id（占房唯一索引不再算这间房）",
    details.every((d) => d.room_id === null),
    JSON.stringify(details)
  );
  const occupiedAfter = occupiedDetails(TODAY);
  check(
    "★ 覆盖今天的占房明细减少 2 条（库存真的回来了）",
    occupiedAfter === occupiedBeforeCancel - 2,
    `${occupiedBeforeCancel} → ${occupiedAfter}`
  );

  check("取消逾期写了一条 op_logs", logCount("取消逾期预订") === cancelLogBefore + 1);
  const log = logsOf("取消逾期预订")[0];
  check(
    "op_logs 带释放间数与取消原因",
    String(log?.detail).includes("释放 2 间") && String(log?.detail).includes("客人未到店"),
    JSON.stringify(log)
  );
}

/* 重复取消（已 CANCELLED）不写日志、不改状态 */
const cancelLogAfter = logCount("取消逾期预订");
{
  const fd = new FormData();
  fd.set("id", String(bkOver1));
  await invoke(actions.cancelOverdueAction, fd);
  check("重复取消已取消的订单不重复写日志（状态守卫）", logCount("取消逾期预订") === cancelLogAfter);
  check("重复取消没有把已取消订单改成别的状态", statusOf(bkOver1)?.status === "CANCELLED");
}

/* ---------- 3.4 admin：批量取消逾期 ---------- */
const batchLogBefore = logCount("批量取消逾期");
const occupiedBeforeBatch = occupiedDetails(TODAY);
{
  const fd = new FormData();
  fd.set("reason", "逾期未到批量清理");
  const r = await invoke(actions.cancelAllOverdueAction, fd);
  check("admin 调 cancelAllOverdueAction 被放行", r.ok, r.message);

  check("批量取消后剩余逾期单（NOSHOW）也变成 CANCELLED", statusOf(bkOver2)?.status === "CANCELLED", String(statusOf(bkOver2)?.status));
  check(
    "★ 批量取消后 booking_rooms 全部释放（NO 有效明细残留）",
    detailRowsOf(bkOver2).every((d) => d.status === "CANCELLED" && d.room_id === null),
    JSON.stringify(detailRowsOf(bkOver2))
  );
  const overdueOccupiedAfter = Number(
    one(
      `SELECT COUNT(*) AS c
         FROM booking_rooms br
        WHERE br.hotel_id = 1 AND br.booking_id IN (?,?)
          AND br.status IN ('PENDING','CONFIRMED')
          AND br.check_in_date <= ? AND br.check_out_date > ?`,
      [bkOver1, bkOver2, TODAY, TODAY]
    )?.c ?? 0
  );
  check("★ 批量取消后逾期单在 booking_rooms 里再无有效占房明细", overdueOccupiedAfter === 0, `实际 ${overdueOccupiedAfter}`);
  check(
    "★ 今日占房明细只剩今天到店那张有效单（逾期单占用已清零）",
    occupiedDetails(TODAY) === 1,
    `${occupiedBeforeBatch} → ${occupiedDetails(TODAY)}`
  );
  check("批量取消后今天到店的那张单不受影响（仍是 CONFIRMED）", statusOf(bkT)?.status === "CONFIRMED");

  check("批量取消写了一条 op_logs", logCount("批量取消逾期") === batchLogBefore + 1);
  const log = logsOf("批量取消逾期")[0];
  check(
    "op_logs 带日期范围与释放间数（对账要能看出影响了哪段库存）",
    /日期 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/.test(String(log?.detail)) && /释放 \d+ 间/.test(String(log?.detail)),
    JSON.stringify(log)
  );
}

/* ---------- 3.5 跨酒店：不能改别家订单 ---------- */
{
  const fd = new FormData();
  fd.set("id", String(bkB));
  const r = await invoke(actions.cancelOverdueAction, fd);
  check("跨酒店单条取消：admin(1) 取消 hotel 999 的订单被放行但无副作用（按 hotel_id 过滤）", r.ok, r.message);
  check(
    "★ 跨酒店：hotel 999 的订单状态仍是 PENDING（没被别家酒店改动）",
    statusOf(bkB)?.status === "PENDING",
    String(statusOf(bkB)?.status)
  );
  check(
    "★ 跨酒店：hotel 999 的房明细仍占房（没被别家酒店释放）",
    detailRowsOf(bkB).every((d) => d.status === "PENDING"),
    JSON.stringify(detailRowsOf(bkB))
  );

  const fd2 = new FormData();
  fd2.set("id", String(bkB));
  const r2 = await invoke(actions.convertOverdueAction, fd2);
  check("跨酒店转今日预订：被放行但无副作用", r2.ok, r2.message);
  check("★ 跨酒店：hotel 999 的订单日期未被顺延", statusOf(bkB)?.check_in_date === dayOffset(-2), String(statusOf(bkB)?.check_in_date));
}

/* ---------- 3.6 admin：逾期转今日预订（主单 + 明细日期一起顺延） ---------- */
/* 现在才造这张单：3.4 的批量取消会取消掉本店全部逾期单，早造就会被「合法」取消掉 */
const bkConvert = addBooking({
  no: `${PREFIX}-CONVERT`,
  checkIn: dayOffset(-5),
  checkOut: dayOffset(-3),
  nights: 2,
  status: "CONFIRMED",
});
const detailConvert = addDetail({
  bookingId: bkConvert,
  roomId: room?.id ?? null,
  status: "CONFIRMED",
  checkIn: dayOffset(-5),
  checkOut: dayOffset(-3),
});
check("已造好「逾期未到」的转预订用单（1 间 2 晚，已排房号）", bkConvert > 0 && detailConvert > 0);
const occupiedBeforeConvert = occupiedDetails(TODAY);
const convertLogBefore = logCount("逾期转预订");
{
  const fd = new FormData();
  fd.set("id", String(bkConvert));
  const r = await invoke(actions.convertOverdueAction, fd);
  check("admin 调 convertOverdueAction 被放行", r.ok, r.message);

  const bk = statusOf(bkConvert);
  check("转今日预订后入住日 = 今天", bk?.check_in_date === TODAY, String(bk?.check_in_date));
  check("转今日预订后离店日 = 今天 + 2 晚（按原晚数重算）", bk?.check_out_date === dayOffset(2), String(bk?.check_out_date));
  check("转今日预订后状态 = CONFIRMED", bk?.status === "CONFIRMED", String(bk?.status));

  const detail = detailRowsOf(bkConvert)[0];
  check(
    "★ 房明细日期同步顺延（否则主单顺延后不占房 → 超卖）",
    detail?.check_in_date === TODAY && detail?.check_out_date === dayOffset(2),
    JSON.stringify(detail)
  );
  check("★ 顺延时释放原房号并回到待排房（不把客人塞进未必空着的房）", detail?.room_id === null && detail?.status === "PENDING", JSON.stringify(detail));
  check(
    "★ 顺延后今天确实被占用了（库存口径能看到这张单）",
    occupiedDetails(TODAY) === occupiedBeforeConvert + 1,
    `${occupiedBeforeConvert} → ${occupiedDetails(TODAY)}`
  );

  check("转今日预订写了一条 op_logs", logCount("逾期转预订") === convertLogBefore + 1);
  const log = logsOf("逾期转预订")[0];
  check("op_logs 记了新的日期区间与晚数", String(log?.detail).includes(`${TODAY} → ${dayOffset(2)}`) && String(log.detail).includes("2 晚"), JSON.stringify(log));
}

/* 非逾期订单不能被这个动作往前推 */
{
  const fd = new FormData();
  fd.set("id", String(bkT));
  const r = await invoke(actions.convertOverdueAction, fd);
  check("非逾期订单调转今日预订：无副作用（入住日仍 = 今天）", r.ok && statusOf(bkT)?.check_in_date === TODAY, r.message);
}

/* ---------- 3.7 真库零写入 ---------- */
console.log("\n=== 四、真库零写入（所有写入都只进副本） ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const leakedBooking = Number(real.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE booking_no LIKE ?`).get(`${PREFIX}%`).c);
    const leakedDetail = Number(
      real.prepare(`SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id IN (SELECT id FROM bookings WHERE booking_no LIKE ?)`).get(`${PREFIX}%`).c
    );
    const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
    const leakedSession = Number(real.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id LIKE ?`).get(`test-todo-%`).c);
    check(`真库没有测试订单（${PREFIX}* = 0）`, leakedBooking === 0, `实际 ${leakedBooking}`);
    check("真库没有测试房明细残留", leakedDetail === 0, `实际 ${leakedDetail}`);
    check("真库没有被写入 999 号测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);
    check("真库没有测试会话行", leakedSession === 0, `实际 ${leakedSession}`);
  } finally {
    real.close();
  }
}

try {
  db.close();
} catch {
  /* 已关闭 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
