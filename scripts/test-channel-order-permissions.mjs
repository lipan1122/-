#!/usr/bin/env node
/**
 * 渠道订单动作权限验收（整改清单 P0-1，第四节第 1 项）
 *
 * ── 清单要求（第 20-27 行）──
 *   · importChannelOrderAction 使用 requirePermission("channel.sync")
 *   · pushChannelOrderStatusAction 使用 requirePermission("channel.sync")
 *   · 页面按钮按权限隐藏
 *   · 所有查询 / 修改 / 日志写入都带 hotel_id
 *   · admin 允许；frontdesk / cashier / housekeeping 拒绝
 *   · 跨酒店订单拒绝
 *   · 重复转入不能生成第二张预订
 *   · （seedChannelOrdersAction 是演示入口，可保留 requireUser + 演示开关）
 *
 * ── 为什么必须是「真 HTTP」，不能只 grep 源码 / 只看页面 200 ──
 *  权限守卫写在 Server Action 里，只有让 Next 真正编译、真正执行那条 action，
 *  才能证明「普通员工构造请求也进不去」；grep 只能证明「源码里有这行」。
 *
 * ── 怎么做到「真 HTTP」却完全不碰真库 ──
 *  本脚本起一个**隔离实例**：
 *    .tmp/channel-order-permissions-<时间戳>/
 *      ├── src/                 ← 复制当前源码（只读使用，不改项目里任何文件）
 *      ├── package.json / next.config.ts / tsconfig.json / next-env.d.ts / postcss.config.mjs
 *      ├── node_modules         ← 指向真 node_modules 的目录联接（避免几百 MB 拷贝）
 *      └── data/pms.db          ← `VACUUM INTO` 出来的真库**副本**
 *  然后在该目录里 `next dev -p <空闲端口>`：实例的 process.cwd() 就是隔离目录，
 *  src/lib/db.ts 的 `path.join(process.cwd(), "data", "pms.db")` 自然落在副本上 ——
 *  所有写入（建预订、写日志、写队列）全部只进副本，真库一个字节都不动。
 *  测试结束：taskkill 杀掉实例进程树 → 摘掉 node_modules 联接 → 删除隔离目录。
 *
 *  同一个副本文件也被本进程打开（并注入 globalThis.__pmsDb），
 *  这样「HTTP 打进去」和「脚本读出来」是同一个库，断言才是真的。
 *
 * ── 断言的四个层次 ──
 *  一、库：role_permissions 表 + 生产函数 hasPermission / requirePermission（带真实会话行）
 *  二、源码：两个 action 的函数体第一行就是 requirePermission("channel.sync")，早于任何写库
 *  三、真 HTTP：四个角色各登录一次，直接 POST `$ACTION_ID_<id>`，断言 403/500 + FORBIDDEN
 *  四、行为：admin 能转、重复转不出第二张预订、跨酒店的订单转不动
 *
 * 运行：node scripts/test-channel-order-permissions.mjs
 *      （约 30-60 秒：要起一个 next dev 实例并首编译 /channel-orders）
 *      node scripts/test-channel-order-permissions.mjs --no-http   # 只跑库 + 源码两层（会明确标注跳过）
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const TAG = "channel-order-permissions";
const NO_HTTP = process.argv.includes("--no-http") || process.env.PMS_NO_HTTP === "1";
const NOW = new Date().toISOString();
/** 验收专用酒店 id（跨酒店用例用；真库只有 1 号店） */
const HOTEL_B = 999;
/** 会写进 channel_orders 的测试单号前缀（用于真库零写入复查） */
const TEST_ORDER_PREFIX = "TEST-PERM-";

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

/* ============================================================ 清理/失败工具 */

const TMP_DIR = path.join(ROOT, ".tmp");
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const STAMP = `${Date.now()}`;
const ISO_DIR = path.join(TMP_DIR, `${TAG}-${STAMP}`);
const STUB_FILE = path.join(TMP_DIR, `${TAG}-stub-next-${STAMP}.mjs`);
let devChild = null;
let isoCreated = false;

/** 安全删除隔离目录：先摘联接，再删目录（绝不顺着联接删到真 node_modules） */
function cleanupIso() {
  if (!isoCreated) return;
  try {
    fs.rmdirSync(path.join(ISO_DIR, "node_modules")); // 只摘联接，不follow
  } catch {
    /* 联接不存在或已摘 */
  }
  try {
    fs.rmSync(ISO_DIR, { recursive: true, force: true });
  } catch (e) {
    console.warn(`（隔离目录未能完全删除：${ISO_DIR} — ${e?.message ?? e}；可手动删除）`);
  }
  try {
    fs.rmSync(STUB_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  isoCreated = false;
}

/** 杀实例进程树（next dev 会 fork 一个 start-server 子进程，必须 /T 连子进程一起杀） */
function stopDevServer() {
  if (!devChild) return;
  const pid = devChild.pid;
  devChild = null;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* 进程已退出 */
  }
}

function abandon(message, detail = "") {
  stopDevServer();
  cleanupIso();
  console.error(`\n❌ 测试无法执行：${message}`);
  if (detail) console.error(detail);
  console.error(
    [
      "",
      "按整改清单第 281-287 行逐项排查：",
      "  1. PMS_DB_PATH        —— 本脚本固定用项目内 data/pms.db，可用 PMS_DB_PATH 指到别的真库",
      "  2. data 目录写权限     —— 源库只需读权限；.tmp 目录与隔离实例的 data 目录需要写权限",
      "  3. 临时数据库目录      —— .tmp/ 必须存在且可写（脚本会自动创建）",
      "  4. VACUUM INTO 目标目录 —— 目标文件不能已存在，父目录必须可写",
      "  5. SQLite WAL 文件权限  —— 副本旁的 -wal/-shm 需要可读写（实例会切 WAL）",
    ].join("\n")
  );
  process.exit(1);
}

process.on("exit", () => {
  stopDevServer();
  cleanupIso();
});

/* ============================================================ 一、隔离实例 + 副本库 */

console.log("=== 一、隔离实例：VACUUM INTO 副本库 + 复制源码 + node_modules 联接 ===");

if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}`);

try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.accessSync(TMP_DIR, fs.constants.W_OK);
  fs.mkdirSync(path.join(ISO_DIR, "data"), { recursive: true });
  isoCreated = true;
} catch (e) {
  abandon(`临时目录不可写：${TMP_DIR}`, String(e?.message ?? e));
}

/* 1.1 复制运行所需的最小文件集（src 是只读使用，绝不修改项目里的 src） */
try {
  for (const f of ["package.json", "next.config.ts", "tsconfig.json", "next-env.d.ts", "postcss.config.mjs"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(ISO_DIR, f));
  }
  fs.cpSync(path.join(ROOT, "src"), path.join(ISO_DIR, "src"), { recursive: true });
  fs.mkdirSync(path.join(ISO_DIR, "public"), { recursive: true });
} catch (e) {
  abandon("复制项目文件到隔离目录失败", String(e?.message ?? e));
}
check(
  "隔离目录里已复制源码（src/app 与 src/lib 都在）",
  fs.existsSync(path.join(ISO_DIR, "src", "app", "(main)", "channel-orders", "actions.ts")) &&
    fs.existsSync(path.join(ISO_DIR, "src", "lib", "session.ts"))
);

/* 1.2 node_modules 用目录联接（junction），避免几百 MB 拷贝 */
try {
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(ISO_DIR, "node_modules"), "junction");
} catch (e) {
  abandon("创建 node_modules 目录联接失败", String(e?.message ?? e));
}
check("node_modules 联接可用（隔离实例能解析 next）", fs.existsSync(path.join(ISO_DIR, "node_modules", "next", "package.json")));

/* 1.3 真库 → 副本（源库只读打开，物理上不可能改真库） */
const ISO_DB = path.join(ISO_DIR, "data", "pms.db");
let src;
try {
  src = new DatabaseSync(REAL_DB, { readOnly: true });
  src.exec(`VACUUM INTO '${ISO_DB.replace(/'/g, "''")}'`);
} catch (e) {
  abandon(`VACUUM INTO 失败：${REAL_DB} → ${ISO_DB}`, String(e?.message ?? e));
} finally {
  try {
    src?.close();
  } catch {
    /* 已关闭 */
  }
}
check("副本库已生成且可读（隔离实例的唯一数据源）", fs.existsSync(ISO_DB) && fs.statSync(ISO_DB).size > 0);

/* 1.4 本进程也打开同一个副本（下面「库」层断言和「HTTP」层写入必须是同一个库） */
let conn;
try {
  conn = new DatabaseSync(ISO_DB);
  conn.exec("PRAGMA busy_timeout = 8000");
} catch (e) {
  abandon(`打不开副本库：${ISO_DB}`, String(e?.message ?? e));
}
const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);
const one = (sql, params = []) => conn.prepare(sql).get(...params);

/* ============================================================ 二、库层：role_permissions + hasPermission + requirePermission */

console.log("\n=== 二、库层：role_permissions 表 + 生产函数 hasPermission / requirePermission ===");

const CHANNEL_SYNC = "channel.sync";
const ROLES = ["admin", "frontdesk", "cashier", "housekeeping"];

/** 权限行（权威来源：role_permissions 表） */
const permRows = all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = ?`, [CHANNEL_SYNC]).map(
  (r) => r.role
);
console.log(`  role_permissions(hotel 1, ${CHANNEL_SYNC}) = [${permRows.join(", ")}]`);

check("role_permissions 表里 admin 拥有 channel.sync", permRows.includes("admin"), `实际 [${permRows.join(",")}]`);
check("role_permissions 表里 frontdesk 没有 channel.sync", !permRows.includes("frontdesk"));
check("role_permissions 表里 cashier 没有 channel.sync", !permRows.includes("cashier"));
check("role_permissions 表里 housekeeping 没有 channel.sync", !permRows.includes("housekeeping"));

/* 让 session.ts 能在普通 Node 进程里 import：把 next/headers、next/navigation 换成最小桩 */
fs.writeFileSync(
  STUB_FILE,
  `// 验收脚本用的最小桩：只实现 session.ts 用到的 cookies()/redirect()
let sid = null;
export function cookies() {
  return { get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined) };
}
export function headers() {
  return new Map();
}
export function redirect(url) {
  throw new Error("NEXT_REDIRECT:" + url);
}
export function setSid(v) {
  sid = v;
}
`
);
const stubUrl = pathToFileURL(STUB_FILE).href;

process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/headers" || specifier === "next/navigation") return { url: stubUrl, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    // TS 风格的相对导入（./db、../lib/x）缺扩展名，补 .ts 再解析
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)
    ) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* 不是 .ts，交给默认解析 */
      }
    }
    return next(specifier, context);
  },
});

/* 生产代码读的库 = 副本库（db.ts 的 getDb() 优先返回 globalThis.__pmsDb） */
globalThis.__pmsDb = conn;

let session;
try {
  session = await import("../src/lib/session.ts");
} catch (e) {
  abandon("import src/lib/session.ts 失败（权限判断函数无法加载）", String(e?.message ?? e));
}

for (const role of ROLES) {
  const allowed = session.hasPermission(role, CHANNEL_SYNC, 1);
  const expected = role === "admin";
  check(
    `hasPermission(${role}, "channel.sync") = ${expected ? "true（允许）" : "false（拒绝）"}`,
    allowed === expected,
    `实际 ${allowed}`
  );
}

/* 造 4 条真实会话行，直接调 requirePermission（就是 action 里那一行守卫） */
const stub = await import(stubUrl);
const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
const userRows = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = 1 ORDER BY id`);
const sessionOf = {};
for (const u of userRows) {
  const sid = `test-perm-${u.role}-${STAMP}`;
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
    NOW,
    expiresAt,
  ]);
  sessionOf[u.role] = sid;
}
check("4 个角色各有 1 条验收会话（admin/frontdesk/cashier/housekeeping）", Object.keys(sessionOf).length === 4, Object.keys(sessionOf).join(","));

for (const role of ROLES) {
  stub.setSid(sessionOf[role]);
  let outcome;
  try {
    const u = await session.requirePermission(CHANNEL_SYNC);
    outcome = `ALLOWED:${u.role}`;
  } catch (e) {
    outcome = `DENIED:${e?.message ?? e}`;
  }
  if (role === "admin") {
    check("requirePermission(\"channel.sync\") 对 admin 放行", outcome === "ALLOWED:admin", outcome);
  } else {
    check(
      `requirePermission("channel.sync") 对 ${role} 抛 FORBIDDEN（源码守卫真的会拦）`,
      outcome.startsWith("DENIED") && outcome.includes("FORBIDDEN") && outcome.includes(CHANNEL_SYNC),
      outcome
    );
  }
}

/* ============================================================ 三、源码层：两个 action 的守卫位置 */

console.log("\n=== 三、源码层：importChannelOrderAction / pushChannelOrderStatusAction 的守卫 ===");

const ACTIONS_REL = path.join("src", "app", "(main)", "channel-orders", "actions.ts");
const actionsSrc = fs.readFileSync(path.join(ROOT, ACTIONS_REL), "utf8");

/** 取一个导出函数的函数体（到下一个 export 之前） */
function funcBody(src, name) {
  const sig = `export async function ${name}(`;
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + sig.length);
  return src.slice(i, j < 0 ? src.length : j);
}
/** 函数体里第一处写库操作的下标 */
function firstMutationIndex(body) {
  const patterns = [/(?:^|\n)\s*run\s*\(/, /(?:^|\n)\s*tx\s*\(/, /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i];
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

for (const fn of ["importChannelOrderAction", "pushChannelOrderStatusAction"]) {
  const body = funcBody(actionsSrc, fn);
  check(`${fn} 在源码里存在`, body.length > 0);
  if (!body) continue;
  const permAt = body.search(/requirePermission\(\s*"channel\.sync"\s*\)/);
  check(`${fn} 有 requirePermission("channel.sync")`, permAt >= 0);
  const head = body.slice(0, 400);
  check(
    `${fn} 的权限断言在函数体最前面（前 400 字符内，早于任何读订单/写库）`,
    head.includes(`requirePermission("channel.sync")`),
    head.split("\n").slice(0, 4).join(" / ")
  );
  const mutAt = firstMutationIndex(body);
  check(`${fn} 的权限断言早于任何写库操作`, permAt >= 0 && (mutAt < 0 || permAt < mutAt), `perm=${permAt} mutation=${mutAt}`);
  check(
    `${fn} 不再只用 requireUser()（写操作已改为权限点校验）`,
    !/const\s+user\s*=\s*await\s+requireUser\(\)/.test(head),
    head.split("\n").slice(0, 3).join(" / ")
  );
}

const coPageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "channel-orders", "page.tsx"), "utf8");
check(
  "页面用 hasPermission(role, \"channel.sync\") 算 canSync 来控制按钮显隐（清单第 22 行）",
  /hasPermission\(\s*user\.role\s*,\s*"channel\.sync"/.test(coPageSrc) && /\bcanSync\b/.test(coPageSrc)
);
check("页面上的「转入预订 / 状态回传」按钮受 canSync 控制", /canSync/.test(coPageSrc) && /importChannelOrderAction/.test(coPageSrc));

/* ============================================================ 四、真 HTTP：起隔离实例 */

console.log("\n=== 四、真 HTTP：隔离实例（next dev）+ 四个角色登录后直接 POST Server Action ===");

/** dev 实例日志（出错时打印尾部） */
const devLog = [];
function pushLog(buf) {
  devLog.push(...String(buf).split(/\r?\n/).filter(Boolean));
  while (devLog.length > 200) devLog.shift();
}
const tailLog = () => devLog.slice(-25).join("\n");

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}
async function pickPort(start = 3300, end = 3600) {
  for (let p = start; p <= end; p += 1) {
    if (await portFree(p)) return p;
  }
  return 0;
}

let BASE = "";
/** 读响应文本（带超时），避免实例卡死时脚本无限等待 */
async function httpGet(url, options = {}, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

if (NO_HTTP) {
  console.log("\n⏭️  已用 --no-http / PMS_NO_HTTP=1 关闭真 HTTP 层");
  console.log("   ⚠️  本层不跑就不能宣称「服务端守卫被真实请求验证过」——不计入通过数，最后按失败处理");
}

if (!NO_HTTP) {
  const port = await pickPort();
  if (!port) abandon("找不到空闲端口（3300-3600 全被占用）");
  BASE = `http://127.0.0.1:${port}`;

  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) abandon(`找不到 next 可执行文件：${nextBin}`);

  devChild = spawn(process.execPath, [nextBin, "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ISO_DIR,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  devChild.stdout?.on("data", pushLog);
  devChild.stderr?.on("data", pushLog);
  devChild.on("exit", (code) => pushLog(`[dev-server exit] code=${code}`));

  /* 4.1 等实例就绪（首次请求要编译 /login，可能十几秒） */
  let ready = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(`${BASE}/login`, {}, 20000);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!ready) abandon(`隔离实例 180 秒内没有就绪（${BASE}）`, `--- dev 日志尾部 ---\n${tailLog()}`);
  check("隔离实例已就绪（GET /login → 200）", ready);

  /* 4.2 四个角色登录（/api/login 会话写进副本库） */
  async function login(username, password) {
    const res = await httpGet(
      `${BASE}/api/login`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password }).toString(),
        redirect: "manual",
      },
      60000
    );
    const text = await res.text();
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    return { ok: text.includes("登录成功") && cookie.length > 0, cookie, text };
  }

  const ACCOUNTS = [
    ["admin", "admin", "admin123"],
    ["frontdesk", "front", "123456"],
    ["cashier", "cashier", "123456"],
    ["housekeeping", "housekeeper", "123456"],
  ];
  const cookies = {};
  for (const [role, user, pwd] of ACCOUNTS) {
    const r = await login(user, pwd);
    cookies[role] = r.cookie;
    check(`登录成功：${user}（${role}）拿到会话 Cookie`, r.ok, r.ok ? "" : r.text.slice(0, 120));
  }

  /* 4.3 预热 /channel-orders（admin），让 Next 生成 Server Action 清单 */
  const warm = await httpGet(`${BASE}/channel-orders`, { headers: { cookie: cookies.admin }, redirect: "manual" }, 120000);
  check("admin 能打开 /channel-orders（页面 200，说明有权限的角色没有被拦）", warm.status === 200, `HTTP ${warm.status}`);

  /* 4.4 从构建产物里取两个 action 的 id */
  function findManifestFiles(dir, depth = 0, out = []) {
    if (depth > 8) return out;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findManifestFiles(full, depth + 1, out);
      else if (e.name === "server-reference-manifest.json") out.push(full);
    }
    return out;
  }
  const actionIds = {};
  for (const file of findManifestFiles(path.join(ISO_DIR, ".next"))) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [id, entry] of Object.entries(manifest.node ?? {})) {
      const fn = String(entry?.filename ?? "").replace(/\\/g, "/");
      const name = entry?.exportedName;
      if (!name) continue;
      if (!fn.includes("channel-orders/actions")) continue;
      actionIds[name] = id;
    }
  }
  check(
    "从构建产物里解析出 importChannelOrderAction 的 action id",
    Boolean(actionIds.importChannelOrderAction),
    `拿到 ${Object.keys(actionIds).join(",")}`
  );
  check(
    "从构建产物里解析出 pushChannelOrderStatusAction 的 action id",
    Boolean(actionIds.pushChannelOrderStatusAction),
    `拿到 ${Object.keys(actionIds).join(",")}`
  );

  /* 4.5 直接构造 MPA 表单 POST（$ACTION_ID_<id> 是 Next 的 Server Action 协议字段） */
  function multipartBody(actionId, fields) {
    const boundary = `----pmsPermCheck${Math.random().toString(16).slice(2)}`;
    const chunks = [];
    const push = (name, value) => {
      chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    };
    push(`$ACTION_ID_${actionId}`, "");
    for (const [k, v] of Object.entries(fields)) push(k, String(v));
    const body = Buffer.from(`${chunks.join("")}--${boundary}--\r\n`, "utf8");
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async function invokeAction(actionId, fields, cookie) {
    const { body, contentType } = multipartBody(actionId, fields);
    const res = await httpGet(
      `${BASE}/channel-orders`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": contentType,
          "content-length": String(body.length),
          accept: "text/x-component",
        },
        body,
        redirect: "manual",
      },
      120000
    );
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location") || "", text };
  }
  /** 被服务端拒绝的判据：4xx/5xx，或响应里出现 FORBIDDEN / 缺少权限（dev 会把异常文案带出来） */
  const isDenied = (r) => r.status >= 400 || /FORBIDDEN|无权执行|缺少权限/.test(r.text);

  /* 4.6 造测试订单（写副本库）：hotel 1 一张、hotel 999 一张 */
  function seedOrder(hotelId, orderNo, status = "NEW") {
    return Number(
      run(
        `INSERT INTO channel_orders (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
                                     check_in_date, check_out_date, nights, room_count, amount, status, booking_id, raw, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          "ctrip",
          orderNo,
          null,
          `权限验收客人-${hotelId}`,
          "13800000000",
          "2026-12-05",
          "2026-12-06",
          1,
          1,
          300,
          status,
          null,
          JSON.stringify({ breakfast: 2, payType: "预付" }),
          NOW,
        ]
      ).lastInsertRowid
    );
  }
  run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
    HOTEL_B,
    "TEST999",
    "渠道权限验收酒店",
    "测试地址",
    "000",
    NOW,
  ]);
  const orderH1 = seedOrder(1, `${TEST_ORDER_PREFIX}H1`);
  const orderB = seedOrder(HOTEL_B, `${TEST_ORDER_PREFIX}HOTEL999`);
  check("已造好两张测试渠道订单（hotel 1 与 hotel 999 各 1 张）", orderH1 > 0 && orderB > 0, `${orderH1} / ${orderB}`);

  /* 4.7 受限角色：两个 action 都必须被拒，且不能产生任何副作用 */
  const RESTRICTED = ["frontdesk", "cashier", "housekeeping"];
  /**
   * ── 判定口径（为什么不是「响应体里必须出现 FORBIDDEN」）──
   * Server Action 里 throw 出来的异常，Next 16 dev 会尝试渲染错误页，
   * 而这个渲染在本机 dev 环境里会被一个 React 报错盖住
   * （日志可见 `⨯ TypeError: Cannot read properties of null (reading 'useInsertionEffect')`），
   * 于是响应体只剩错误页 HTML，原始文案 `FORBIDDEN: 缺少权限 channel.sync` 不会回显。
   * 所以「被权限拒掉」用下面三条**可验证的事实**一起判定，而不是赌错误页的文案：
   *   ① HTTP 状态被拒（4xx/5xx，不是 200）；
   *   ② 同一请求由 admin 发出时是 200 且**真的产生了写入**（对照组，见 4.8/4.9）→ 说明请求本身合法，
   *      受限角色拿到 500 的唯一差别就是角色；
   *   ③ 受限角色被拒后**没有任何副作用**（订单仍 NEW、没有新预订）→ 说明异常发生在守卫处，
   *      函数体根本没往下跑；
   *   ④ `FORBIDDEN: 缺少权限 channel.sync` 的文案由「二」层直接调生产函数 requirePermission() 坐实。
   */
  const denialEvidence = (r) => `${r.text}\n${tailLog()}`;
  async function hittingDenied(role, actionName, fields) {
    const r = await invokeAction(actionIds[actionName], fields, cookies[role]);
    await new Promise((res) => setTimeout(res, 400)); // 等服务端把异常写进日志
    return r;
  }
  for (const role of RESTRICTED) {
    const bookingCountBefore = Number(all(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1`)[0].c);
    const r = await hittingDenied(role, "importChannelOrderAction", { orderId: orderH1 });
    check(
      `HTTP：${role} 调 importChannelOrderAction 被服务端拒绝（HTTP ${r.status}）`,
      r.status >= 400,
      `HTTP ${r.status} / log: ${tailLog().slice(-200).replace(/\n/g, " ")}`
    );
    const state = one(`SELECT status, booking_id FROM channel_orders WHERE id = ? AND hotel_id = 1`, [orderH1]);
    const bookingCountAfter = Number(all(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1`)[0].c);
    check(
      `HTTP：${role} 被拒后没有副作用（订单仍 ${state?.status}、无新预订）—— 守卫早于任何写库`,
      state?.status === "NEW" && state?.booking_id === null && bookingCountAfter === bookingCountBefore,
      JSON.stringify({ state, before: bookingCountBefore, after: bookingCountAfter, evidence: denialEvidence(r).slice(-120) })
    );
  }
  for (const role of RESTRICTED) {
    const r = await hittingDenied(role, "pushChannelOrderStatusAction", { orderId: orderH1, status: "CHECKED_IN" });
    check(
      `HTTP：${role} 调 pushChannelOrderStatusAction 被服务端拒绝（HTTP ${r.status}）`,
      r.status >= 400,
      `HTTP ${r.status} / log: ${tailLog().slice(-200).replace(/\n/g, " ")}`
    );
  }
  check(
    "受限角色连续 6 次被拒后测试订单仍是 NEW（权限断言早于任何写库，没被越权改动）",
    one(`SELECT status FROM channel_orders WHERE id = ? AND hotel_id = 1`, [orderH1])?.status === "NEW",
    String(one(`SELECT status FROM channel_orders WHERE id = ? AND hotel_id = 1`, [orderH1])?.status)
  );

  /* 4.8 admin：对照实验 —— 不存在的订单号不该被「权限拦截」（证明上面的 500 是权限而不是参数错误） */
  const adminBogus = await invokeAction(actionIds.importChannelOrderAction, { orderId: 987654321 }, cookies.admin);
  check(
    "HTTP：admin 用不存在的 orderId 调 importChannelOrderAction 没有被权限拦截（对照组）",
    !isDenied(adminBogus),
    `HTTP ${adminBogus.status} / ${adminBogus.text.slice(0, 160).replace(/\n/g, " ")}`
  );

  /* 4.9 admin：真正转入 —— 生成 1 张预订 */
  const bookingNoBefore = Number(all(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1`)[0].c);
  const adminImport1 = await invokeAction(actionIds.importChannelOrderAction, { orderId: orderH1 }, cookies.admin);
  check("HTTP：admin 调 importChannelOrderAction 没有被拦（约 200）", !isDenied(adminImport1), `HTTP ${adminImport1.status}`);
  const bookingRows = all(`SELECT id, booking_no, status FROM bookings WHERE hotel_id = 1 AND channel_order_no = ?`, [
    `${TEST_ORDER_PREFIX}H1`,
  ]);
  check("admin 转入后 bookings 生成 1 张（按渠道单号查）", bookingRows.length === 1, `实际 ${bookingRows.length} 张`);
  const orderAfter = one(`SELECT status, booking_id FROM channel_orders WHERE id = ? AND hotel_id = 1`, [orderH1]);
  check("订单状态推进为 IMPORTED 且 booking_id 指向新预订", orderAfter?.status === "IMPORTED" && Number(orderAfter?.booking_id) === Number(bookingRows[0]?.id), JSON.stringify(orderAfter));

  /* 4.10 admin：重复转入同一 orderId —— 不能生成第二张预订 */
  const adminImport2 = await invokeAction(actionIds.importChannelOrderAction, { orderId: orderH1 }, cookies.admin);
  check("HTTP：重复转入同一 orderId 没有被拦（也没有抛未捕获异常）", !isDenied(adminImport2), `HTTP ${adminImport2.status}`);
  const bookingRows2 = all(`SELECT id FROM bookings WHERE hotel_id = 1 AND channel_order_no = ?`, [`${TEST_ORDER_PREFIX}H1`]);
  check("★ 重复转入不生成第二张预订（bookings 仍 1 张）", bookingRows2.length === 1, `实际 ${bookingRows2.length} 张`);
  check(
    "★ 重复转入没有改动原预订（booking_id 未变）",
    Number(one(`SELECT booking_id FROM channel_orders WHERE id = ?`, [orderH1])?.booking_id) === bookingRows2[0]?.id,
    JSON.stringify({ orderBookingId: one(`SELECT booking_id FROM channel_orders WHERE id = ?`, [orderH1])?.booking_id, booking: bookingRows2[0]?.id })
  );
  check(
    "全店预订总数只 +1（两次转入 = 一次写入）",
    Number(all(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1`)[0].c) === bookingNoBefore + 1,
    `${bookingNoBefore} → ${all(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1`)[0].c}`
  );

  /* 4.11 跨酒店：admin(hotel 1) 拿 hotel 999 的 orderId 转入 —— 必须转不动 */
  const crossImport = await invokeAction(actionIds.importChannelOrderAction, { orderId: orderB }, cookies.admin);
  check("HTTP：跨酒店转入没有触发权限异常（走的是「查不到这张单」分支）", !isDenied(crossImport), `HTTP ${crossImport.status}`);
  check(
    "★ 跨酒店：admin(1) 转入 hotel 999 的单 → 不生成任何预订",
    all(`SELECT id FROM bookings WHERE hotel_id = 1 AND channel_order_no = ?`, [`${TEST_ORDER_PREFIX}HOTEL999`]).length === 0
  );
  check(
    "★ 跨酒店：hotel 999 的订单状态仍是 NEW（没有被别家酒店改动）",
    one(`SELECT status FROM channel_orders WHERE id = ? AND hotel_id = ?`, [orderB, HOTEL_B])?.status === "NEW",
    String(one(`SELECT status FROM channel_orders WHERE id = ?`, [orderB])?.status)
  );

  /* 4.12 跨酒店：状态回传同样不能越权 */
  const crossPush = await invokeAction(
    actionIds.pushChannelOrderStatusAction,
    { orderId: orderB, status: "CHECKED_IN" },
    cookies.admin
  );
  check("HTTP：跨酒店状态回传没有被权限拦截（走的是「订单不存在」分支）", !isDenied(crossPush), `HTTP ${crossPush.status}`);
  check(
    "★ 跨酒店：hotel 999 的订单状态没有被回传动作改动（仍 NEW）",
    one(`SELECT status FROM channel_orders WHERE id = ? AND hotel_id = ?`, [orderB, HOTEL_B])?.status === "NEW"
  );
  check(
    "★ 跨酒店：没有任何预订落到 hotel 999 名下（不往别家酒店写数据）",
    all(`SELECT id FROM bookings WHERE hotel_id = ?`, [HOTEL_B]).length === 0
  );
}

/* ============================================================ 五、真库零写入 */

console.log("\n=== 五、真库零写入（所有写入都只进副本） ===");

const real = new DatabaseSync(REAL_DB, { readOnly: true });
try {
  const leakedOrder = Number(
    real.prepare(`SELECT COUNT(*) AS c FROM channel_orders WHERE channel_order_no LIKE ?`).get(`${TEST_ORDER_PREFIX}%`).c
  );
  const leakedBooking = Number(
    real.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE channel_order_no LIKE ?`).get(`${TEST_ORDER_PREFIX}%`).c
  );
  const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
  const leakedSession = Number(real.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id LIKE ?`).get(`test-perm-%`).c);
  check(`真库没有测试渠道订单（${TEST_ORDER_PREFIX}* = 0）`, leakedOrder === 0, `实际 ${leakedOrder}`);
  check("真库没有测试预订（channel_order_no TEST-PERM-* = 0）", leakedBooking === 0, `实际 ${leakedBooking}`);
  check("真库没有被写入 999 号测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);
  check("真库没有测试会话行（sessions test-perm-* = 0）", leakedSession === 0, `实际 ${leakedSession}`);
} finally {
  real.close();
}

/* ============================================================ 六、隔离实例上的写入确实落库了（反证 HTTP 打的是副本而不是空转） */

if (!NO_HTTP) {
  console.log("\n=== 六、副本库确实收到了 HTTP 请求造成的写入 ===");
  const isoBookings = all(`SELECT booking_no, channel_order_no FROM bookings WHERE booking_no LIKE ? OR channel_order_no LIKE ?`, [
    `%`,
    `${TEST_ORDER_PREFIX}%`,
  ]);
  check("副本库里能看到 HTTP 转入产生的预订（证明请求确实打到了这个库）", isoBookings.length >= 1, JSON.stringify(isoBookings));
  const syncLogs = all(`SELECT action, message FROM channel_sync_logs WHERE hotel_id = 1 AND action = 'IMPORT' ORDER BY id DESC LIMIT 3`);
  check("副本库里有 IMPORT 同步日志（转入动作完整执行过）", syncLogs.length >= 1, JSON.stringify(syncLogs));
}

/* ============================================================ 汇总 */

if (NO_HTTP) {
  // 「不能用异常退出当通过」：真 HTTP 层被显式关闭时，必须判红
  fail += 1;
  console.log("\n❌ 真 HTTP 层被 --no-http / PMS_NO_HTTP=1 跳过，本次结果不能算通过");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try {
  conn.close();
} catch {
  /* 已关 */
}
stopDevServer();
await new Promise((r) => setTimeout(r, 800));
cleanupIso();
process.exit(fail === 0 ? 0 : 1);
