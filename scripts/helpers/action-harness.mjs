#!/usr/bin/env node
/**
 * 真调 Server Action 的测试底盘（共享 helper）
 *
 * ── 为什么需要它 ──
 * 一批验收脚本原来是「自己写 SQL 模拟业务流程」，断言的是脚本自己的 UPDATE 序列
 * （例：退房三步、逐间入住、排房镜像）。它们能防「表结构 / 流转约定漂移」，
 * 但抓不到业务代码回归 —— src/ 里的 action 改坏了，脚本照样全绿。
 *
 * 本 helper 把 test-cashier-idempotency.mjs / test-room-action-idempotency.mjs
 * 里已经验证过的做法抽出来：
 *   1. `data/pms.db --VACUUM INTO--> .tmp/<tag>-<时间戳>/data/pms.db`（真库只读，零写入）；
 *   2. 注入 `globalThis.__pmsDb`，让 `src/lib/db.ts` 连副本；
 *   3. `registerHooks` 把 `next/headers` / `next/navigation` / `next/cache` 换成本地桩；
 *   4. 动态 import **真实的** `src/app/(main)/**\/actions.ts`；
 *   5. 用真实 sessions 表造会话，然后像页面一样 `new FormData()` 调 action。
 *
 * ── 造数据自给自足 ──
 * 房型 / 房间 / 订单 / 账单全部由测试自己建（房号带时间戳，不会撞真库历史），
 * 不依赖「环境里正好有几间空房」。admin 会话也自己造 —— 副本库里连 admin 都没有时
 * 也能跑，不会把「跳过」当通过。
 *
 * ── 清理 ──
 * 副本目录（连同 -wal / -shm）在进程退出时整个删掉；真库自始至终只读打开。
 *
 * 用法：
 *   import { createActionHarness, createChecker, isOk, isErr, msgOf, near } from "./helpers/action-harness.mjs";
 *   const h = await createActionHarness({ tag: "per-room-checkin" });
 *   const frontdesk = await h.importModule("app/(main)/frontdesk/actions.ts");
 *   const res = await h.invoke(frontdesk.checkInAction, { room_id: [1, 2], ... });
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_ROOT = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
/*
 * 源码根目录。
 *
 * 默认就是仓库里的 src/。设了 PMS_SRC_ROOT 才换成副本 —— 用来做「mutation 自检」：
 * 把 src 整份拷到 .tmp 下、故意改坏 action 的某一行，再跑本套测试，确认它会变红。
 * 这样做是因为 src/ 随时有别的 agent 在改，不能为了验证测试有效而原地改坏它。
 * 同时也证明了这些测试 assert 的确实是**源码里的 action**，不是脚本内复制品。
 */
const SRC_ROOT = process.env.PMS_SRC_ROOT ? path.resolve(ROOT, process.env.PMS_SRC_ROOT) : path.join(ROOT, "src");

/** SQLite 路径字面量：反斜杠转正斜杠 + 单引号翻倍（Windows 上不转就 VACUUM INTO 失败） */
const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

/* ============================================================ 共享工具 */

export const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** action 调用结果判定：返回 {ok} / 成功 redirect 都算成功 */
export const isOk = (r) => r?.kind === "ok" || (r?.kind === "returned" && Boolean(r.result?.ok) && !r.result?.error);
/** 失败：{error} / 失败 redirect（?err=）/ 抛错 都算失败 */
export const isErr = (r) =>
  r?.kind === "err" ||
  r?.kind === "threw" ||
  r?.kind === "notfound" ||
  (r?.kind === "returned" && Boolean(r.result?.error));
/** 取提示文案（成功或失败都一样：优先 action 返回值，其次 redirect 上的 err/msg） */
export const msgOf = (r) => String(r?.result?.error ?? r?.result?.ok ?? r?.message ?? "");

/** 统一断言器：✅/❌ 输出 + 末尾汇总（与仓库里其他 test-*.mjs 的输出格式一致） */
export function createChecker() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  const check = (name, ok, extra = "") => {
    if (ok) {
      pass += 1;
      console.log(`✅ ${name}`);
    } else {
      fail += 1;
      failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
      console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
    }
  };
  const section = (title) => console.log(`\n=== ${title} ===`);
  const done = () => {
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    for (const f of failures) console.log(`  ❌ ${f}`);
    return fail;
  };

  return { check, section, done, get pass() { return pass; }, get fail() { return fail; } };
}

/* ============================================================ next/* 桩 */

const NEXT_STUB_SRC = `/*
 * next/* 的最小桩（由 scripts/helpers/action-harness.mjs 生成，勿手改）
 *
 * cookies() 返回同步对象：真实 session.ts 写的是 \`await cookies()\`，
 * await 一个非 Promise 值直接通过，所以不需要真的实现 AsyncLocalStorage。
 * redirect() 抛 NEXT_REDIRECT 前缀的错误，由 harness 的 invoke() 翻译成成功/失败。
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

let hooksInstalled = false;
let stubUrl = "";

/**
 * 模块解析钩子
 *
 * - `next/headers|navigation|cache|server` → 统一换成本地桩；
 * - `@/xxx` → `<SRC_ROOT>/xxx.ts`（缺扩展名时补 .ts，与 tsconfig paths 一致）；
 * - `./xxx` / `../xxx` 无扩展名 → 先试 `.ts`（真实源码里是 TS 的 ESM 写法）。
 */
function harnessResolve(specifier, context, next) {
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
    return next(pathToFileURL(path.join(SRC_ROOT, file)).href, context);
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)
  ) {
    try {
      return next(`${specifier}.ts`, context);
    } catch {
      /* 不是 .ts：交给默认解析 */
    }
  }
  return next(specifier, context);
}

/* ============================================================ 主入口 */

/**
 * 建一个「副本库 + 真实 action」的执行环境
 *
 * @param {{tag?: string, hotelId?: number, hotelName?: string}} options
 * @returns {Promise<object>} harness 对象（见下方 return）
 */
export async function createActionHarness({ tag = "action", hotelId = 1, hotelName = "验收酒店" } = {}) {
  if (!fs.existsSync(REAL_DB)) {
    console.error(`❌ 真库不存在：${REAL_DB}\n   先跑 node scripts/init-db.mjs，或用 PMS_DB_PATH 指定`);
    process.exit(1);
  }

  const stamp = `${Date.now()}`;
  const dir = path.join(TMP_ROOT, `${tag}-${stamp}`);
  const dbPath = path.join(dir, "data", "pms.db");
  const stubFile = path.join(dir, "next-stub.mjs");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });

  try {
    const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    try {
      src.exec(`VACUUM INTO '${sqlPath(dbPath)}'`);
    } finally {
      src.close();
    }
  } catch (e) {
    console.error(
      `❌ 复制真库失败（VACUUM INTO）\n   源 ${REAL_DB}\n   目标 ${dbPath}\n   ${e?.message ?? e}`
    );
    process.exit(1);
  }

  fs.writeFileSync(stubFile, NEXT_STUB_SRC);
  stubUrl = pathToFileURL(stubFile).href;
  if (!hooksInstalled) {
    registerHooks({ resolve: harnessResolve });
    hooksInstalled = true;
  }

  const db = new DatabaseSync(dbPath, { timeout: 15000 });
  db.exec("PRAGMA busy_timeout = 15000");
  /* db.ts 的 getDb() 每次都看这个全局：必须在 import 真实 action 之前注入 */
  globalThis.__pmsDb = db;

  const stub = await import(stubUrl);

  /* ---- 基础查询封装（同步，与 node:sqlite 一致） ---- */
  const all = (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
  const one = (sql, params = []) => {
    const r = db.prepare(sql).get(...params);
    return r ? { ...r } : undefined;
  };
  const run = (sql, params = []) => {
    const r = db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  };

  /* ---- 会话：优先用副本库里的 admin，没有就自己造（空库也能跑） ---- */
  let admin = one(`SELECT id, username, real_name, role FROM users WHERE hotel_id = ? AND role = 'admin' AND status = 1 ORDER BY id LIMIT 1`, [hotelId]);
  if (!admin) {
    const username = `harness-admin-${stamp}`;
    const uid = run(
      `INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (?,?,?,?,?,1)`,
      [hotelId, username, "x", "验收管理员", "admin"]
    ).lastInsertRowid;
    admin = { id: uid, username, real_name: "验收管理员", role: "admin" };
  }
  const nowIso = () => new Date().toISOString();
  const ADMIN_SID = `harness-${tag}-admin-${stamp}`;
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    ADMIN_SID,
    JSON.stringify({
      id: admin.id,
      username: admin.username,
      realName: admin.real_name ?? admin.username,
      role: "admin",
      hotelId,
      hotelName,
    }),
    nowIso(),
    new Date(Date.now() + 3600 * 1000).toISOString(),
  ]);
  stub.setSid(ADMIN_SID);

  /* ---- 造数工厂 ---- */
  let seq = 0;
  const suffix = stamp.slice(-6);

  /**
   * 建一个房型（默认最多 2 人：入住超员拦截要用到 max_occupancy）
   */
  const createRoomType = ({ maxOccupancy = 2, basePrice = 300, name = "验收房型" } = {}) => {
    seq += 1;
    return run(
      `INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`,
      [hotelId, `H${suffix}${seq}`, `${name}${seq}`, basePrice, maxOccupancy, 9000 + seq]
    ).lastInsertRowid;
  };

  /** 建 n 间房（房号带时间戳，避免撞真库房号唯一索引） */
  const createRooms = (count, { roomTypeId, status = "VC", prefix = "TH", floor = 9 } = {}) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      const roomNo = `${prefix}${suffix}-${seq}`;
      const id = run(
        `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`,
        [hotelId, roomNo, floor, roomTypeId, status, 9000 + seq]
      ).lastInsertRowid;
      out.push({ id, room_no: roomNo });
    }
    return out;
  };

  /** 本地日期（与 action 里 todayStr() 同口径，不用 toISOString 免得跨时区少一天） */
  const localDate = (offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /* ---- 调用 action ---- */
  /**
   * 像页面提交表单一样调 action
   *
   * fields 的值是数组时会 `append` 多次（checkInAction 用 getAll("room_id") 支持多间），
   * 单个值 append 一次。
   */
  const invoke = async (fn, fields = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) fd.append(k, String(item));
    }
    try {
      const out = await fn(fd);
      return { kind: "returned", result: out, message: String(out?.error ?? out?.ok ?? "") };
    } catch (e) {
      const msg = e?.message ?? String(e);
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
        return { kind: errText ? "err" : "ok", result: undefined, message: errText || okText || "", url };
      }
      if (msg === "NEXT_NOT_FOUND") return { kind: "notfound", result: undefined, message: msg };
      return { kind: "threw", result: undefined, message: msg };
    }
  };

  /** 动态 import 真实源码（.ts 由 Node 的类型剥离处理，@/ 由上面的 hook 解析） */
  const importModule = (rel) => import(pathToFileURL(path.join(SRC_ROOT, ...rel.split("/"))).href);

  /** 只读查真库（用于「真库零写入」断言） */
  const realCount = (sql, params = []) => {
    const real = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    try {
      const r = real.prepare(sql).get(...params);
      return Number(r?.c ?? r?.n ?? -1);
    } finally {
      real.close();
    }
  };

  /** 切换会话（跨酒店 / 跨角色用例）；传 null 表示未登录 */
  const useSession = (sid) => stub.setSid(sid);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不掩盖测试结论 */
    }
  };
  process.on("exit", dispose);
  process.on("warning", (w) => {
    if (w && (w.code === "MODULE_TYPELESS_PACKAGE_JSON" || w.code === "ExperimentalWarning")) return;
    console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
  });

  return {
    /* 环境 */
    tag,
    stamp,
    hotelId,
    hotelName,
    dir,
    dbPath,
    realDb: REAL_DB,
    srcRoot: SRC_ROOT,
    db,
    stub,
    ADMIN_SID,
    admin,
    /* 查询 */
    all,
    one,
    run,
    /* 调用 / 装载 */
    invoke,
    importModule,
    useSession,
    /* 造数 */
    createRoomType,
    createRooms,
    localDate,
    /* 断言辅助 */
    realCount,
    /* 收尾 */
    dispose,
  };
}
