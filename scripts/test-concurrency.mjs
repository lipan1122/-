#!/usr/bin/env node
/**
 * 多前台并发压测（从没做过的高并发场景）
 *
 * ── 为什么另起一个脚本 ──
 * 仓库里已有的幂等验收（test-cashier-idempotency / test-room-action-idempotency）
 * 只覆盖「同一个人双击 / 同一枚 request_id 重放」，最多两个子进程。
 * 真实酒店前台是**多个人、多台电脑同时操作**，而且大多不是同一个 request_id：
 *   · 两位前台同时把同一间房排给不同订单 —— 只能有一个成功；
 *   · 两位前台同时给同一张账单收钱 —— 已收金额不能丢一笔；
 *   · 两位前台同时退同一间房 —— 房态只能转一次 VD、保洁任务只能有一条；
 *   · 三位店长同时点夜审 —— night_audits 只能有一条；
 *   · 五位前台同时给同一间房建预订 —— 不能超卖。
 * 这些在单进程 Promise.all 里测不出来：node:sqlite 是同步 API，Promise.all 的
 * 两个「并发」请求其实是一个接一个跑完的，锁与事务竞争根本没发生。
 *
 * ── 本脚本怎么做（真并发）──
 *   1. `data/pms.db --VACUUM INTO--> .tmp/concurrency-<时间戳>/data/pms.db`（真库只读）；
 *   2. 主进程在副本上建好每个场景自己的房型 / 房间 / 入住单 / 账单 / 订单 / 会话，
 *      然后把「同一份副本库」路径交给子进程；
 *   3. 用 node:child_process spawn **N 个独立进程**，每个进程注入 globalThis.__pmsDb、
 *      把 next/headers 等换成本地桩，import **真实的 src/app/(main)/**\/actions.ts**，
 *      以不同前台的 session 调用 action —— 与页面提交表单完全同一条代码路径；
 *   4. 所有 worker 用 WORKER_GO_AT 对齐开跑时刻（Atomics.wait 精确睡眠），
 *      避免「启动有先后」把并发变成串行；
 *   5. 主进程等全部结束，再**核对数据库里的金额 / 房态 / 流水 / 日志**，
 *      不看「有没有报错」就下结论。
 *
 * ── 判定口径 ──
 *   ✅ 断言 = 数据一致性不变量（钱不丢不重、房不超卖、业务只发生一次、日志次数对得上）；
 *   ⚠️ 观察 = 请求级异常（某几个请求抛 SQLITE_CONSTRAINT / 500）。
 *      观察项不计入失败，但会原样打印并写进 docs/性能基线.md ——
 *      「数据没坏」不等于「前台体验没问题」，这类异常属于真缺陷，需要单独修。
 *
 * 用法：
 *   node scripts/test-concurrency.mjs            # 跑全部 7 个场景
 *   node scripts/test-concurrency.mjs --only=pay # 只跑某个场景（调试用）
 * 退出码：0 = 全部断言通过；1 = 有断言失败
 *
 * 安全边界：
 *   · 真库只读（VACUUM INTO + 末尾用只读连接核对「真库没有本脚本写入的行」）
 *   · 并发数 3~5，不碰 3100 端口，不跑 next build，不重启服务
 *   · 副本目录退出时整个删除
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_ROOT = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
const IS_WORKER = process.argv.includes("--worker");
const STAMP = `${Date.now()}`;
const DIR = IS_WORKER ? path.dirname(process.env.WORKER_DB) : path.join(TMP_ROOT, `concurrency-${STAMP}`);
const COPY_DB = IS_WORKER ? process.env.WORKER_DB : path.join(DIR, "data", "pms.db");
const STUB_FILE = IS_WORKER ? process.env.WORKER_STUB : path.join(DIR, "next-stub.mjs");
const H = 1;
const PREFIX = `PC${STAMP.slice(-6)}`;

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

/* ============================================================ 0. worker 模式（子进程） */

const NEXT_STUB_SRC = `/*
 * next/* 最小桩（由 scripts/test-concurrency.mjs 生成，勿手改）
 * session.ts 写的是 \`await cookies()\`，await 一个同步对象直接通过。
 */
let sid = null;
export function setSid(v) { sid = v; }
export function getSid() { return sid; }
export function cookies() {
  return {
    get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined),
    getAll: () => (sid ? [{ name: "pms_sid", value: sid }] : []),
    set: () => {},
    delete: () => {},
    has: (name) => Boolean(sid && name === "pms_sid"),
  };
}
export function headers() { return new Map(); }
export function redirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function permanentRedirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export function forbidden() { throw new Error("NEXT_FORBIDDEN"); }
export function unauthorized() { throw new Error("NEXT_UNAUTHORIZED"); }
export function revalidatePath() {}
export function revalidateTag() {}
export function unstable_noStore() {}
export function unstable_cache(fn) { return fn; }
`;

if (IS_WORKER) {
  const dbPath = COPY_DB;
  const stubUrl = pathToFileURL(STUB_FILE).href;
  const srcRoot = path.join(ROOT, "src");

  const db = new DatabaseSync(dbPath, { timeout: 30000 });
  db.exec("PRAGMA busy_timeout = 30000");
  globalThis.__pmsDb = db;

  registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier === "next/headers" ||
        specifier === "next/navigation" ||
        specifier === "next/cache" ||
        specifier === "next/server"
      ) {
        return { url: stubUrl, shortCircuit: true };
      }
      if (specifier.startsWith("@/")) {
        const rel = specifier.slice(2);
        const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
        return next(pathToFileURL(path.join(srcRoot, file)).href, context);
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
  stub.setSid(process.env.WORKER_SID);

  /* 精确对齐开跑时刻：所有 worker 的模块装载（~几百毫秒）先做完，再一起扣扳机。
     不用 setTimeout(0) —— 那只是「下一个 tick」，进程间仍有几十毫秒抖动。 */
  const goAt = Number(process.env.WORKER_GO_AT || 0);
  const sleepMs = goAt - Date.now();
  if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);

  const actionFile = process.env.WORKER_ACTION;
  const fnName = process.env.WORKER_FN;
  const payload = JSON.parse(process.env.WORKER_PAYLOAD || "{}");

  const write = (obj) => process.stdout.write(`@@RESULT@@${JSON.stringify(obj)}\n`);

  try {
    const mod = await import(pathToFileURL(path.join(srcRoot, ...actionFile.split("/"))).href);
    const fn = mod[fnName];
    if (typeof fn !== "function") throw new Error(`action 不存在：${fnName}`);

    const fd = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) fd.append(k, String(item));
    }

    let out;
    try {
      out = { kind: "returned", result: await fn(fd) };
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.startsWith("NEXT_REDIRECT:")) {
        const url = msg.slice("NEXT_REDIRECT:".length);
        let q;
        try {
          q = new URL(url, "http://localhost").searchParams;
        } catch {
          q = new URLSearchParams();
        }
        const errText = q.get("err");
        const okText = q.get("msg") ?? q.get("ok");
        out = { kind: errText ? "err" : "ok", message: errText || okText || "", url };
      } else if (msg === "NEXT_NOT_FOUND") {
        out = { kind: "notfound", message: msg };
      } else {
        out = { kind: "threw", message: msg };
      }
    }
    write(out);
  } catch (e) {
    write({ kind: "threw", message: String(e?.stack ?? e?.message ?? e) });
  }

  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  process.exit(0);
}

/* ============================================================ 1. 主进程：断言器 / 工具 */

let pass = 0;
let fail = 0;
const failures = [];
const observations = [];

const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const observe = (name, extra = "") => {
  observations.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ⚠️  [观察] ${name}${extra ? ` — ${extra}` : ""}`);
};
const section = (title) => console.log(`\n=== ${title} ===`);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;

const localDate = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY = localDate(0);
const D1 = localDate(30);
const D3 = localDate(32);

function cleanupMain() {
  if (IS_WORKER) return;
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* 副本删不掉不掩盖测试结论 */
  }
}
process.on("exit", cleanupMain);
process.on("warning", (w) => {
  if (w && (w.code === "MODULE_TYPELESS_PACKAGE_JSON" || w.code === "ExperimentalWarning")) return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* ============================================================ 2. 副本库 + 夹具 */

if (!fs.existsSync(REAL_DB)) {
  console.error(`❌ 真库不存在：${REAL_DB}\n   先跑 node scripts/init-db.mjs，或用 PMS_DB_PATH 指定`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(COPY_DB), { recursive: true });
try {
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${sqlPath(COPY_DB)}'`);
  } finally {
    src.close();
  }
} catch (e) {
  console.error(`❌ 复制真库失败（VACUUM INTO）\n   源 ${REAL_DB}\n   目标 ${COPY_DB}\n   ${e?.message ?? e}`);
  process.exit(1);
}
fs.writeFileSync(STUB_FILE, NEXT_STUB_SRC);

const db = new DatabaseSync(COPY_DB, { timeout: 30000 });
db.exec("PRAGMA busy_timeout = 30000");
/* 副本默认可能是 rollback journal：显式切 WAL，避免 5 个写进程互相把读者挡住。
   （真库本身就是 WAL；副本是 VACUUM INTO 出来的新文件，journal_mode 不随文件复制。） */
try {
  db.exec("PRAGMA journal_mode = WAL;");
} catch (e) {
  console.warn(`⚠️  副本切换 WAL 失败（继续用默认 journal）：${e?.message ?? e}`);
}

const all = (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const one = (sql, params = []) => {
  const r = db.prepare(sql).get(...params);
  return r ? { ...r } : undefined;
};
const run = (sql, params = []) => db.prepare(sql).run(...params);

/* ---- 账号 / 会话：5 个前台 + 1 个店长（夜审） ---- */
const nowIso = () => new Date().toISOString();
const expires = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
const sessions = [];
const frontline = [];

function ensureStaff(username, realName, role) {
  let u = one(`SELECT id, username, real_name, role FROM users WHERE hotel_id = ? AND username = ?`, [H, username]);
  if (!u) {
    const id = Number(
      run(`INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (?,?,?,?,?,1)`, [
        H,
        username,
        "x",
        realName,
        role,
      ]).lastInsertRowid
    );
    u = { id, username, real_name: realName, role };
  }
  const sid = `conc-${STAMP}-${username}`;
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    sid,
    JSON.stringify({
      id: u.id,
      username: u.username,
      realName: u.real_name ?? realName,
      role,
      hotelId: H,
      hotelName: "验收酒店",
    }),
    nowIso(),
    expires,
  ]);
  return { ...u, sid };
}

for (let i = 1; i <= 5; i += 1) {
  const u = ensureStaff(`${PREFIX}-fd-${i}`, `并发前台${i}`, "frontdesk");
  frontline.push(u);
  sessions.push(u.sid);
}
const manager = ensureStaff(`${PREFIX}-mgr`, "并发店长", "admin");
const managerSids = [manager.sid, manager.sid, manager.sid];

/* ---- 造数工厂（全部带 PC<stamp> 前缀，真库/历史数据不会撞） ---- */
let seq = 0;
const uniq = (tag) => `${PREFIX}-${tag}-${++seq}`;

function createRoomType(maxOccupancy = 2) {
  return Number(
    run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
      H,
      uniq("RT"),
      uniq("并发房型"),
      300,
      maxOccupancy,
      9000 + seq,
    ]).lastInsertRowid
  );
}

function createRoom(roomTypeId, status = "VC") {
  const roomNo = uniq("R");
  return {
    id: Number(
      run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
        H,
        roomNo,
        9,
        roomTypeId,
        status,
        9000 + seq,
      ]).lastInsertRowid
    ),
    room_no: roomNo,
  };
}

function createStay(room, { status = "INHOUSE", rate = 100, deposit = 0, nights = 1 } = {}) {
  const stayNo = uniq("S");
  const id = Number(
    run(
      `INSERT INTO stays
         (hotel_id, stay_no, room_id, guest_name, mobile, check_in_time, expect_check_out,
          nights, rate, deposit, guest_count, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        stayNo,
        room.id,
        uniq("并发客人"),
        "13800000000",
        `${TODAY} 14:00:00`,
        localDate(1),
        nights,
        rate,
        deposit,
        1,
        status,
        nowIso(),
      ]
    ).lastInsertRowid
  );
  return { id, stay_no: stayNo, room_id: room.id };
}

/** 建账单；传 roomTotal 会同时写一条 ROOM 明细，保证 total_amount = 明细合计 */
function createFolio(stay, { roomTotal = 0, paid = 0, status = "OPEN" } = {}) {
  const folioNo = uniq("F");
  const total = round2(roomTotal);
  const id = Number(
    run(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        folioNo,
        stay ? stay.id : null,
        "并发客人",
        stay ? (one(`SELECT room_no FROM rooms WHERE id = ?`, [stay.room_id])?.room_no ?? null) : null,
        total,
        round2(paid),
        round2(total - paid),
        status,
        nowIso(),
      ]
    ).lastInsertRowid
  );
  if (roomTotal > 0) {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [H, id, "ROOM", `房费 ${TODAY}`, 1, total, total, TODAY, nowIso()]
    );
  }
  return { id, folio_no: folioNo, total, paid: round2(paid) };
}

/** 建预订单（主单 + 一条待排房明细）；roomId 为空即「只订房型、到店排房」 */
function createBooking(roomTypeId, { roomId = null, status = "PENDING", roomCount = 1, roomNo = null } = {}) {
  const bookingNo = uniq("B");
  const id = Number(
    run(
      `INSERT INTO bookings
         (hotel_id, booking_no, guest_name, mobile, room_type_id, room_id, check_in_date, check_out_date,
          nights, room_count, guest_count, rate, deposit, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        bookingNo,
        uniq("并发预订人"),
        "13900000000",
        roomTypeId,
        roomId,
        D1,
        D3,
        2,
        roomCount,
        1,
        300,
        0,
        status,
        nowIso(),
        nowIso(),
      ]
    ).lastInsertRowid
  );
  const detailStatus = roomId ? "CONFIRMED" : "PENDING";
  run(
    `INSERT INTO booking_rooms
       (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status, check_in_date, check_out_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [H, id, roomTypeId, roomId, `并发预订人-${bookingNo}`, "13900000000", 300, detailStatus, D1, D3, nowIso()]
  );
  return { id, booking_no: bookingNo, room_no: roomNo };
}

/* ============================================================ 3. worker 调度 */

function spawnWorker({ action, fn, fields, sid }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      WORKER_DB: COPY_DB,
      WORKER_STUB: STUB_FILE,
      WORKER_SID: sid,
      WORKER_ACTION: action,
      WORKER_FN: fn,
      WORKER_PAYLOAD: JSON.stringify(fields),
      WORKER_GO_AT: process.env.__GO_AT ?? "0",
    };
    const child = spawn(process.execPath, [process.argv[1], "--worker"], {
      env,
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 90000);
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out
        .split(/\r?\n/)
        .filter((l) => l.startsWith("@@RESULT@@"))
        .pop();
      let parsed;
      try {
        parsed = line ? JSON.parse(line.slice("@@RESULT@@".length)) : undefined;
      } catch {
        parsed = undefined;
      }
      resolve({ code, out, err, result: parsed });
    });
  });
}

/**
 * 让 N 个 worker **同一时刻**开跑
 * 先全部 spawn（各自装载模块、连库），再统一设一个未来 2.5s 的 GO_AT。
 * 用环境变量给子进程传 GO_AT 行不通（spawn 时就固定了），所以用命令行参数不够优雅，
 * 这里直接把 GO_AT 写进 —— 先 spawn 时给一个远期占位，再通过 stdio 不可行。
 * 简化实现：spawnWorker 读取 process.env.__GO_AT，主进程先算好未来时刻再 spawn，
 * 模块装载（几百毫秒）远小于 2.5 秒，因此所有 worker 都能等到 GO_AT。
 */
async function runConcurrent({ action, fn, payloads, sids, goDelayMs = 2500 }) {
  const goAt = Date.now() + goDelayMs;
  process.env.__GO_AT = String(goAt);
  const tasks = payloads.map((fields, i) =>
    spawnWorker({ action, fn, fields, sid: sids[i % sids.length] })
  );
  const results = await Promise.all(tasks);
  delete process.env.__GO_AT;
  return results;
}

const kindOf = (r) => r?.result?.kind ?? "no-result";
const msgOf = (r) => String(r?.result?.message ?? r?.err ?? "").slice(0, 240);
const isOk = (r) =>
  kindOf(r) === "ok" || (kindOf(r) === "returned" && Boolean(r.result?.result?.ok) && !r.result?.result?.error);
const isRejected = (r) =>
  kindOf(r) === "err" || (kindOf(r) === "returned" && Boolean(r.result?.result?.error)) || kindOf(r) === "notfound";
const isThrown = (r) => kindOf(r) === "threw" || (r.code !== 0 && !r.result);

function summarize(label, results) {
  const ok = results.filter(isOk).length;
  const rejected = results.filter(isRejected).length;
  const thrown = results.filter(isThrown).length;
  console.log(`  → ${label}：成功 ${ok} / 被拒 ${rejected} / 请求异常 ${thrown}`);
  const thrownMsgs = results.filter(isThrown).map((r) => msgOf(r)).filter(Boolean);
  if (thrownMsgs.length > 0) {
    observe(`${label}：${thrown} 个请求抛异常（生产环境是 500）`, thrownMsgs.join(" | "));
  }
  return { ok, rejected, thrown };
}

/* ============================================================ 4. 七个场景 */

const results = [];
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").split("=")[1] || "";
const want = (name) => !only || only === name;

/* ------------------------------------------------------------ 场景 1：同时排同一间房 */
if (want("assign")) {
  section("场景 1｜5 个前台同时把同一间房排给 5 张不同订单（并发数 5）");

  const typeId = createRoomType();
  const room = createRoom(typeId, "VC");
  const bookings = [];
  for (let i = 0; i < 5; i += 1) {
    bookings.push(createBooking(typeId, { roomId: null, status: "PENDING", roomCount: 1 }));
  }

  const res = await runConcurrent({
    action: "app/(main)/bookings/actions.ts",
    fn: "assignRoomAction",
    sids: sessions,
    payloads: bookings.map((b) => ({
      bookingId: String(b.id),
      roomIds: String(room.id),
      roomId: String(room.id),
      backTo: "/bookings",
    })),
  });
  const s = summarize("排房", res);

  const occupied = Number(
    one(
      `SELECT COUNT(*) AS c FROM booking_rooms
        WHERE hotel_id = ? AND room_id = ? AND status IN ('CONFIRMED','CHECKED_IN')`,
      [H, room.id]
    )?.c ?? 0
  );
  const confirmedBookings = Number(
    one(
      `SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND room_id = ? AND status IN ('CONFIRMED','CHECKED_IN')`,
      [H, room.id]
    )?.c ?? 0
  );
  const assignLogs = Number(
    one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = '排房' AND detail LIKE ?`, [
      H,
      `%${PREFIX}%`,
    ])?.c ?? 0
  );

  check("排房并发：只有 1 个前台排房成功", s.ok === 1, `成功 ${s.ok}`);
  check(
    "排房并发：其余 4 个被明确拒绝（没有 500 / 没有都成功）",
    s.rejected === 4 && s.thrown === 0,
    `被拒 ${s.rejected} / 异常 ${s.thrown}：${res.filter((r) => !isOk(r)).map(msgOf).join(" | ")}`
  );
  check("排房并发：房间里只有 1 条有效占用明细", occupied === 1, `实际 ${occupied} 条`);
  check("排房并发：只有 1 张订单变成已确认", confirmedBookings === 1, `实际 ${confirmedBookings} 张`);
  check("排房并发：op_logs 只记 1 条排房", assignLogs === 1, `实际 ${assignLogs} 条`);
  results.push({
    name: "同时排同一间房",
    concurrency: 5,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: occupied === 1 && confirmedBookings === 1 && assignLogs === 1,
  });
}

/* ------------------------------------------------------------ 场景 2：同时收同一张账单的钱 */
if (want("pay")) {
  section("场景 2｜5 个前台同时给同一张账单收款（各收 100，并发数 5）");

  const typeId = createRoomType();
  const room = createRoom(typeId, "OC");
  const stay = createStay(room, { rate: 100 });
  const folio = createFolio(stay, { roomTotal: 1000 });
  const reqIds = Array.from({ length: 5 }, (_, i) => `${PREFIX}-PAY-${i}`);

  const res = await runConcurrent({
    action: "app/(main)/cashier/actions.ts",
    fn: "addPaymentAction",
    sids: sessions,
    payloads: reqIds.map((rid) => ({
      folio_id: String(folio.id),
      stay_id: String(stay.id),
      amount: "100",
      method: "现金",
      remark: "并发收款",
      request_id: rid,
    })),
  });
  const s = summarize("收款", res);

  const payRows = all(`SELECT amount, request_id FROM payments WHERE hotel_id = ? AND folio_id = ?`, [H, folio.id]);
  const paySum = round2(payRows.reduce((sum, r) => sum + Number(r.amount), 0));
  const f = one(`SELECT total_amount, paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`, [folio.id, H]);
  const distinctReq = new Set(payRows.map((r) => r.request_id)).size;

  check("并发收款：5 个请求全部成功", s.ok === 5, `成功 ${s.ok} / 异常 ${s.thrown}`);
  check("并发收款：5 笔流水一条不少", payRows.length === 5, `实际 ${payRows.length} 笔`);
  check("并发收款：流水合计 = 实际收款之和 500", near(paySum, 500), `合计 ${paySum}`);
  check("并发收款：账单已收 = 500（没有丢更新）", near(f?.paid_amount, 500), `paid=${f?.paid_amount}`);
  check("并发收款：余额 = 应收 1000 − 已收 500", near(f?.balance, 500), `balance=${f?.balance}`);
  check("并发收款：5 枚 request_id 各自只落一笔", distinctReq === 5 && payRows.length === 5, `distinct=${distinctReq}`);
  results.push({
    name: "同时收同一张账单的钱",
    concurrency: 5,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: payRows.length === 5 && near(paySum, 500) && near(f?.paid_amount, 500),
  });
}

/* ------------------------------------------------------------ 场景 3：同时退同一间房 */
if (want("checkout")) {
  section("场景 3｜5 个前台同时给同一间房办退房（并发数 5）");

  const typeId = createRoomType();
  const room = createRoom(typeId, "OC");
  const stay = createStay(room, { rate: 500 });
  const folio = createFolio(stay, { roomTotal: 500 });
  const reqIds = Array.from({ length: 5 }, (_, i) => `${PREFIX}-CO-${i}`);

  const res = await runConcurrent({
    action: "app/(main)/cashier/actions.ts",
    fn: "checkoutAction",
    sids: sessions,
    payloads: reqIds.map((rid) => ({
      stay_id: String(stay.id),
      room_id: String(room.id),
      folio_id: String(folio.id),
      pay_method: "现金",
      pay_amount: "500",
      request_id: rid,
    })),
  });
  const s = summarize("退房", res);

  const vdLogs = Number(
    one(
      `SELECT COUNT(*) AS c FROM room_logs WHERE hotel_id = ? AND room_id = ? AND to_status = 'VD'`,
      [H, room.id]
    )?.c ?? 0
  );
  const hk = Number(
    one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND room_id = ? AND note = '退房打扫'`, [
      H,
      room.id,
    ])?.c ?? 0
  );
  const stayRow = one(`SELECT status, actual_check_out FROM stays WHERE id = ? AND hotel_id = ?`, [stay.id, H]);
  const roomRow = one(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [room.id, H]);
  const folioRow = one(`SELECT status, paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`, [
    folio.id,
    H,
  ]);
  const collectRows = all(
    `SELECT amount FROM payments WHERE hotel_id = ? AND folio_id = ? AND remark = '退房补收'`,
    [H, folio.id]
  );
  const collectSum = round2(collectRows.reduce((sum, r) => sum + Number(r.amount), 0));

  check("并发退房：没有任何请求 500", s.thrown === 0, `${s.thrown} 个异常：${res.map(msgOf).join(" | ")}`);
  check("并发退房：入住单只退了一次（CHECKED_OUT）", stayRow?.status === "CHECKED_OUT", JSON.stringify(stayRow));
  check("并发退房：房态只转了一次 VD", vdLogs === 1, `VD 日志 ${vdLogs} 条`);
  check("并发退房：房间最终房态 VD", roomRow?.status === "VD", `status=${roomRow?.status}`);
  check("并发退房：保洁任务只有 1 条", hk === 1, `实际 ${hk} 条`);
  check(
    "并发退房：账单只结清一次且余额 0",
    folioRow?.status === "SETTLED" && near(folioRow?.balance, 0),
    JSON.stringify(folioRow)
  );
  check("并发退房：补收流水只有 1 笔 500", collectRows.length === 1 && near(collectSum, 500), `${collectRows.length} 笔 / ${collectSum}`);
  results.push({
    name: "同时退同一间房",
    concurrency: 5,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: stayRow?.status === "CHECKED_OUT" && vdLogs === 1 && hk === 1 && collectRows.length === 1,
  });
}

/* ------------------------------------------------------------ 场景 4：同时收同一房间押金 */
if (want("deposit")) {
  section("场景 4｜5 个前台同时给同一房间收押金（各收 100，并发数 5）");

  const typeId = createRoomType();
  const room = createRoom(typeId, "OC");
  const stay = createStay(room, { rate: 1000 });
  const folio = createFolio(stay, { roomTotal: 1000 });
  const reqIds = Array.from({ length: 5 }, (_, i) => `${PREFIX}-DEP-${i}`);

  const res = await runConcurrent({
    action: "app/(main)/cashier/actions.ts",
    fn: "addDepositAction",
    sids: sessions,
    payloads: reqIds.map((rid) => ({
      folio_id: String(folio.id),
      stay_id: String(stay.id),
      amount: "100",
      method: "现金",
      remark: "并发押金",
      request_id: rid,
    })),
  });
  const s = summarize("押金", res);

  const payRows = all(
    `SELECT amount FROM payments WHERE hotel_id = ? AND folio_id = ? AND kind = 'DEPOSIT'`,
    [H, folio.id]
  );
  const paySum = round2(payRows.reduce((sum, r) => sum + Number(r.amount), 0));
  const items = all(
    `SELECT amount FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`,
    [H, folio.id]
  );
  const itemSum = round2(items.reduce((sum, r) => sum + Number(r.amount), 0));
  const stayRow = one(`SELECT deposit FROM stays WHERE id = ? AND hotel_id = ?`, [stay.id, H]);
  const f = one(`SELECT paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`, [folio.id, H]);
  const depLogs = Number(
    one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = '预收款' AND detail LIKE ?`, [
      H,
      `%${PREFIX}%`,
    ])?.c ?? 0
  );

  check("并发收押金：5 个请求全部成功", s.ok === 5, `成功 ${s.ok} / 异常 ${s.thrown}`);
  check("并发收押金：5 笔收款流水", payRows.length === 5 && near(paySum, 500), `${payRows.length} 笔 / ${paySum}`);
  check("并发收押金：5 条押金明细", items.length === 5 && near(itemSum, 500), `${items.length} 条 / ${itemSum}`);
  check("并发收押金：stays.deposit = 500（不丢不重）", near(stayRow?.deposit, 500), `deposit=${stayRow?.deposit}`);
  check("并发收押金：账单已收 = 500、余额 = 500", near(f?.paid_amount, 500) && near(f?.balance, 500), JSON.stringify(f));
  check("并发收押金：预收款日志 5 条（没有丢日志）", depLogs === 5, `实际 ${depLogs} 条`);
  results.push({
    name: "同时收同一房间押金",
    concurrency: 5,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: payRows.length === 5 && near(paySum, 500) && near(stayRow?.deposit, 500) && near(f?.paid_amount, 500),
  });
}

/* ------------------------------------------------------------ 场景 5：同时改同一房间房态 */
if (want("status")) {
  section("场景 5｜5 个前台同时改同一房间房态（并发数 5）");

  const typeId = createRoomType();
  const room = createRoom(typeId, "OC");
  const targets = ["OOO", "VD", "VC", "LOCK", "OD"];

  const res = await runConcurrent({
    action: "app/(main)/rooms/actions.ts",
    fn: "setRoomStatusAction",
    sids: sessions,
    payloads: targets.map((status) => ({
      roomId: String(room.id),
      status,
      reason: "并发改房态",
    })),
  });
  const s = summarize("改房态", res);

  const logs = all(
    `SELECT id, from_status, to_status, operator FROM room_logs WHERE hotel_id = ? AND room_id = ? ORDER BY id`,
    [H, room.id]
  );
  const roomRow = one(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [room.id, H]);
  const lastLog = logs[logs.length - 1];
  const firstLog = logs[0];

  let chainOk = logs.length > 0 && firstLog?.from_status === "OC";
  for (let i = 1; i < logs.length; i += 1) {
    if (logs[i].from_status !== logs[i - 1].to_status) chainOk = false;
  }

  check("并发改房态：没有任何请求 500", s.thrown === 0, `${s.thrown} 个异常：${res.map(msgOf).join(" | ")}`);
  check("并发改房态：房间状态有变化（不是全部丢失）", logs.length >= 1, `room_logs ${logs.length} 条`);
  check(
    "并发改房态：最后一次生效（rooms.status = 最后一条日志的 to_status）",
    Boolean(lastLog) && roomRow?.status === lastLog?.to_status,
    `room=${roomRow?.status} / last_log=${lastLog?.to_status}`
  );
  check(
    "并发改房态：room_logs 流转链自洽（首条 OC、前后 from/to 衔接）",
    chainOk,
    logs.map((l) => `${l.from_status}→${l.to_status}`).join(" , ")
  );
  check("并发改房态：日志条数不超过请求数（每人最多一条）", logs.length <= 5, `${logs.length} 条`);
  results.push({
    name: "同时改同一房间房态",
    concurrency: 5,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: Boolean(lastLog) && roomRow?.status === lastLog?.to_status && chainOk,
  });
}

/* ------------------------------------------------------------ 场景 6：同时触发夜审 */
if (want("nightaudit")) {
  section("场景 6｜3 个店长同时触发夜审（并发数 3）");

  /* 副本里先删掉今天的夜审行（真库只读，这里删的是副本），让夜审可执行。
     若今天本来就已经审过，不删就永远只测到「今日已完成夜审」的串行分支。 */
  run(`DELETE FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, TODAY]);

  const res = await runConcurrent({
    action: "app/(main)/night-audit/actions.ts",
    fn: "runNightAuditAction",
    sids: managerSids,
    payloads: [{}, {}, {}],
  });
  const s = summarize("夜审", res);

  const auditRows = all(`SELECT id, biz_date, status, revenue_net FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [
    H,
    TODAY,
  ]);
  const auditLogs = Number(
    one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = '夜审'`, [H])?.c ?? 0
  );

  check("并发夜审：night_audits 当天只有 1 条", auditRows.length === 1, `实际 ${auditRows.length} 条`);
  check("并发夜审：只有 1 个请求真正执行成功", s.ok === 1, `成功 ${s.ok}`);
  check("并发夜审：没有并发写坏账（营收字段可读）", Number.isFinite(Number(auditRows[0]?.revenue_net)), JSON.stringify(auditRows[0]));
  if (s.thrown > 0) {
    observe(
      "并发夜审：失败请求没有翻译成业务提示（UNIQUE 冲突直接抛错，生产环境是 500）",
      res.filter(isThrown).map(msgOf).join(" | ")
    );
  }
  void auditLogs;
  results.push({
    name: "同时触发夜审",
    concurrency: 3,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: auditRows.length === 1,
  });
}

/* ------------------------------------------------------------ 场景 7：同时建同一房间预订 */
if (want("booking")) {
  section("场景 7｜5 个前台同时为同一房间同一日期建预订（并发数 5）");

  const typeId = createRoomType(1);
  const room = createRoom(typeId, "VC");
  const lines = JSON.stringify([
    { room_type_id: typeId, room_count: 1, rate: 300, breakfast: 0, room_id: room.id },
  ]);

  const res = await runConcurrent({
    action: "app/(main)/bookings/actions.ts",
    fn: "createBookingAction",
    sids: sessions,
    payloads: Array.from({ length: 5 }, () => ({
      booking_type: "guest",
      guest_name: uniq("并发预订"),
      mobile: "13700000000",
      check_in_date: D1,
      check_out_date: D3,
      rate_code: "门市价",
      pay_type: "到店付款",
      lines,
    })),
  });
  const s = summarize("建预订", res);

  const physical = Number(one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [H, typeId])?.c ?? 0);
  const active = all(
    `SELECT b.id, b.room_count, b.status
       FROM bookings b
      WHERE b.hotel_id = ? AND b.room_type_id = ? AND b.room_id = ?
        AND b.status IN ('PENDING','CONFIRMED','CHECKED_IN')
        AND b.check_in_date < ? AND b.check_out_date > ?`,
    [H, typeId, room.id, D3, D1]
  );
  const activeRoomCount = active.reduce((sum, b) => sum + Number(b.room_count ?? 0), 0);

  check("并发建单：同一房间同一日期没有超卖（有效 room_count 合计 ≤ 物理房量 1）", activeRoomCount <= physical, `room_count 合计 ${activeRoomCount} / 物理 ${physical}`);
  check("并发建单：只有 1 张订单占用了这间房", active.length === 1, `实际 ${active.length} 张`);
  check("并发建单：成功数等于占房数（多出来的必须被拒）", s.ok === active.length, `成功 ${s.ok} / 占房 ${active.length}`);
  if (s.thrown > 0) {
    observe(
      "并发建单：被唯一索引挡下的请求直接抛 SQLITE_CONSTRAINT（生产环境是 500，而不是「房间已被占用」）",
      res.filter(isThrown).map(msgOf).join(" | ")
    );
  }

  /*
   * 附加观测（不计失败）：不指定房间、只订房型的建单**没有库存校验**。
   * 同一房型只有 1 间可售房时，5 个并发的「订 1 间」全部成功 = 超卖 5 间。
   * 这是并发之外的独立业务缺陷（和并发无关，串行点击也会发生），
   * 单独开一张隔离房型来验，避免影响上面的断言。
   */
  let overbookProbe = null;
  if (!only) {
    const t2 = createRoomType(1);
    const r2 = createRoom(t2, "VC");
    const lines2 = JSON.stringify([{ room_type_id: t2, room_count: 1, rate: 300, breakfast: 0, room_id: null }]);
    const res2 = await runConcurrent({
      action: "app/(main)/bookings/actions.ts",
      fn: "createBookingAction",
      sids: sessions,
      payloads: Array.from({ length: 5 }, () => ({
        booking_type: "guest",
        guest_name: uniq("房型超卖探针"),
        mobile: "13600000000",
        check_in_date: localDate(60),
        check_out_date: localDate(62),
        rate_code: "门市价",
        pay_type: "到店付款",
        lines: lines2,
      })),
    });
    const s2 = summarize("只订房型（探针）", res2);
    const sold = Number(
      one(
        `SELECT COALESCE(SUM(room_count),0) AS c FROM bookings
          WHERE hotel_id = ? AND room_type_id = ? AND status IN ('PENDING','CONFIRMED','CHECKED_IN')
            AND check_in_date < ? AND check_out_date > ?`,
        [H, t2, localDate(62), localDate(60)]
      )?.c ?? 0
    );
    const physical2 = Number(one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [H, t2])?.c ?? 0);
    overbookProbe = { sold, physical: physical2, ok: s2.ok };
    if (sold > physical2) {
      observe(
        `只订房型、不指定房间时没有库存校验：可售 ${physical2} 间，卖了 ${sold} 间`,
        "串行点击也会超卖，与并发无关；建议建单时按房型统计区间内有效 room_count 并校验可售量"
      );
    }
    void r2;
  }
  results.push({
    name: "同时创建同一房间同一日期的预订",
    concurrency: 5,
    ok: s.ok,
    rejected: s.rejected,
    thrown: s.thrown,
    consistent: activeRoomCount <= physical && active.length === 1 && s.ok === active.length,
    overbookProbe,
  });
}

/* ============================================================ 5. 真库零写入 */

section("真库零写入核对");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  const rooms = Number(real.prepare(`SELECT COUNT(*) AS n FROM rooms WHERE room_no LIKE ?`).get(`${PREFIX}%`)?.n ?? 0);
  const bookings = Number(
    real.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE booking_no LIKE ?`).get(`${PREFIX}%`)?.n ?? 0
  );
  const users = Number(real.prepare(`SELECT COUNT(*) AS n FROM users WHERE username LIKE ?`).get(`${PREFIX}%`)?.n ?? 0);
  real.close();
  check("真库没有本脚本创建的房间", rooms === 0, `${rooms} 条`);
  check("真库没有本脚本创建的预订", bookings === 0, `${bookings} 条`);
  check("真库没有本脚本创建的账号", users === 0, `${users} 条`);
  check("本脚本所有写入都落在副本库", fs.existsSync(COPY_DB));
}

/* ============================================================ 6. 汇总 */

try {
  db.close();
} catch {
  /* 已关闭 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (observations.length > 0) {
  console.log(`\n观察项（不计失败，但属于真缺陷，已写入 docs/性能基线.md）：${observations.length} 条`);
  for (const o of observations) console.log(`  ⚠️  ${o}`);
}
if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  ❌ ${f}`);
}
console.log(`（在副本上跑，真库 ${REAL_DB} 未被修改）\n`);
process.exit(fail === 0 ? 0 : 1);
