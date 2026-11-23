#!/usr/bin/env node
/**
 * 性能基线（页面响应时间 + SQL 热点 + 索引体检）
 *
 * ── 为什么需要这个脚本 ──
 * 系统有 46 间房 / 831 条预订 / 384 张入住单 / 384 张账单，上线以来
 * **从没测过任何一个页面的响应时间**。没有基线就无法判断「改完变快还是变慢」，
 * 也没法回答「哪个页面该优化」。本脚本把三件事固定下来：
 *
 *   1. 页面级：用 curl 的 `-w "%{time_total}"` 测所有关键页面 + 全部报表，
 *      每页 5 次取中位数（先预热 1 次，避免把 Next.js 首次编译/冷缓存算进去）；
 *   2. SQL 级：静态扫描页面源码里的 `all()` / `get()` SQL，在
 *      `data/pms.db --VACUUM INTO--> .tmp/perf-<时间戳>/` 的**只读副本**上
 *      逐条 `EXPLAIN QUERY PLAN` + 实际执行计时（真库一个字节都不写）；
 *   3. 结构级：标记全表扫描（SCAN 大表）、相关子查询、临时 B 树排序、
 *      疑似 N+1（循环体内查库）、同一文件里重复查询。
 *
 * ── 判定口径 ──
 *   · 页面中位数 > 1000ms  → 「慢页面」，控制台用 ⚠️ 标出并汇总到报告；
 *   · 页面中位数 > 3000ms  → 「阻塞级」，单独一段列出；
 *   · 退出码只看「能不能测」：登录失败 / 页面非 200 / 副本建不出来 → 1；
 *     页面慢本身不算失败（基线是测量，不是验收门槛）。
 *
 * 用法：node scripts/perf-baseline.mjs
 * 依赖：本机 curl.exe；服务在 http://127.0.0.1:3100（admin/admin123）。
 * 安全：不跑 next build、不重启 3100、不写真库；并发只有 1（顺序测量）。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const BASE = process.env.PMS_BASE_URL ?? "http://127.0.0.1:3100";
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_ROOT = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
const STAMP = `${Date.now()}`;
const DIR = path.join(TMP_ROOT, `perf-${STAMP}`);
const COOKIE = path.join(DIR, "cookies.txt");
const COPY_DB = path.join(DIR, "data", "pms.db");
const RESULT_JSON = path.join(DIR, "result.json");
const RUNS = 5;
const WARMUP = 1;

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");
const round = (n, d = 2) => Math.round(Number(n) * 10 ** d) / 10 ** d;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

fs.mkdirSync(path.join(DIR, "data"), { recursive: true });

/* ============================================================ 0. curl 封装 */

function curl(args, timeout = 60000) {
  const r = spawnSync("curl", args, { encoding: "utf8", timeout, windowsHide: true });
  if (r.error) throw r.error;
  return { code: r.status, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
}

function serverUp() {
  try {
    const r = curl(["-sS", "-o", "NUL", "-w", "%{http_code}", `${BASE}/login`], 8000);
    return Number(r.out.trim().split(/\s+/).pop()) === 200;
  } catch {
    return false;
  }
}

function login() {
  /* 并行开发时别的 agent 可能在 next build / 重启 3100：等它起来再测，避免基线作废 */
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (!serverUp()) {
      if (attempt === 12) {
        console.error(`❌ ${BASE} 在等待约 60 秒后仍无响应（可能在 next build / 重启）`);
        process.exit(1);
      }
      console.log(`  服务暂时不可用，3 秒后重试（${attempt}/12）…`);
      sleep(3000);
      continue;
    }
    const r = curl([
      "-sS",
      "-c",
      COOKIE,
      "-o",
      "NUL",
      "-w",
      "%{http_code}",
      "-X",
      "POST",
      "-d",
      "username=admin&password=admin123",
      `${BASE}/api/login`,
    ]);
    const status = Number(r.out.trim().split(/\s+/).pop());
    const cookieText = fs.existsSync(COOKIE) ? fs.readFileSync(COOKIE, "utf8") : "";
    if (status === 200 && /pms_sid/.test(cookieText)) return;
    console.log(`  登录未成功（HTTP ${status}），3 秒后重试（${attempt}/12）…`);
    sleep(3000);
  }
  console.error("❌ 登录失败 — 确认 3100 在跑、admin/admin123 可用");
  process.exit(1);
}

/** 测一个 URL：预热 1 次 + 正式 5 次，返回中位数 / 最小 / 最大 / 状态码 / 字节数 */
function measurePage(urlPath) {
  const url = `${BASE}${urlPath}`;
  const one = () => {
    const r = curl(["-sS", "-b", COOKIE, "-o", "NUL", "-w", "%{http_code} %{time_total} %{size_download}", url]);
    const parts = r.out.trim().split(/\s+/);
    const status = Number(parts[0]);
    const sec = Number(parts[1]);
    const bytes = Number(parts[2]);
    return { status, ms: sec * 1000, bytes };
  };

  let warm;
  try {
    warm = one();
  } catch (e) {
    return { path: urlPath, error: String(e?.message ?? e), samples: [] };
  }
  if (!Number.isFinite(warm.status) || warm.status === 0) {
    return { path: urlPath, error: "curl 无响应", samples: [] };
  }

  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    try {
      samples.push(one());
    } catch (e) {
      samples.push({ status: 0, ms: NaN, bytes: 0, error: String(e?.message ?? e) });
    }
  }
  const times = samples.map((s) => s.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const statuses = [...new Set(samples.map((s) => s.status))];
  const median = times.length ? times[Math.floor((times.length - 1) / 2)] : NaN;
  return {
    path: urlPath,
    status: statuses.length === 1 ? statuses[0] : statuses.join(","),
    median: round(median),
    min: round(times[0] ?? NaN),
    max: round(times[times.length - 1] ?? NaN),
    bytes: samples[samples.length - 1]?.bytes ?? warm.bytes,
    warmup: round(warm.ms),
    samples: times.map((t) => round(t)),
  };
}

/* ============================================================ 1. 页面清单 */

const KEY_PAGES = [
  "/dashboard",
  "/rooms",
  "/rooms/forecast",
  "/rooms/predict",
  "/bookings",
  "/bookings/new",
  "/cashier",
  "/frontdesk",
  "/inhouse",
  "/night-audit",
  "/housekeeping",
  "/settings",
  "/finance",
  "/ar",
  "/members",
  "/guests",
  "/shop",
  "/channels",
  /* 关键页之外，实际运营里点得最多的几个页面，一并进基线 */
  "/orders",
  "/invoices",
  "/reports",
  "/today-todo",
  "/handover",
  "/breakfast",
];

/** 从 reports/page.tsx 里读出全部报表 key（不写死，新增报表自动纳入） */
function reportKeys() {
  const file = path.join(ROOT, "src", "app", "(main)", "reports", "page.tsx");
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("const REPORTS");
  const end = src.indexOf("\n};", start);
  const block = start >= 0 ? src.slice(start, end > start ? end : start + 20000) : "";
  const keys = [];
  const re = /(?:"([a-z0-9-]+)"|([a-z][a-z0-9-]*))\s*:\s*\{\s*label:/g;
  let m;
  while ((m = re.exec(block))) {
    const k = m[1] ?? m[2];
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const reportList = reportKeys().map((k) => `/reports?r=${k}`);
/* 代表性宽区间报表：默认区间只有一个月左右，宽区间才能压出 SQL 的真实成本 */
const heavyReports = [
  "/reports?r=room-biz-daily&from=2025-01-01&to=2026-12-31",
  "/reports?r=room-daily&from=2025-01-01&to=2026-12-31",
  "/reports?r=biz-daily&from=2025-01-01&to=2026-12-31",
  "/reports?r=consume-detail&from=2025-01-01&to=2026-12-31",
  "/reports?r=summary&from=2025-01-01&to=2026-12-31",
];
const heavyPages = [
  `/rooms/forecast?start=${today}&days=60`,
  `/rooms/forecast?start=${today}&days=365`,
  "/bookings?range=all",
  "/bookings?q=a&range=all",
];

const PAGES = [...KEY_PAGES, ...reportList, ...heavyReports, ...heavyPages];

/* ============================================================ 2. 页面测量 */

console.log(`性能基线开始：${BASE}`);
console.log(`测量 ${PAGES.length} 个 URL（每个预热 1 次 + 正式 ${RUNS} 次取中位数）…\n`);
login();

const pageResults = [];
for (const p of PAGES) {
  const r = measurePage(p);
  pageResults.push(r);
  const mark = r.error ? "❌" : r.median > 3000 ? "🛑" : r.median > 1000 ? "⚠️ " : "  ";
  const label = r.error ? r.error : `${String(r.median).padStart(8)} ms  (min ${r.min} / max ${r.max})  ${String(r.bytes).padStart(8)} B  ${r.status}`;
  console.log(`${mark} ${p.padEnd(62)} ${label}`);
  sleep(10);
}

const bad = pageResults.filter((r) => r.error || Number(r.status) !== 200);
const slow = pageResults.filter((r) => !r.error && r.median > 1000).sort((a, b) => b.median - a.median);
const blocker = slow.filter((r) => r.median > 3000);

console.log(`\n—— 页面级汇总 ——`);
console.log(`  测量 ${pageResults.length} 个 URL，非 200 / 无响应：${bad.length} 个`);
if (slow.length === 0) {
  console.log("  ✅ 没有页面中位数超过 1 秒（当前数据量下全部 < 1s）");
} else {
  console.log(`  ⚠️  超过 1 秒的页面：${slow.length} 个`);
  for (const s of slow) console.log(`     - ${s.path}：${s.median} ms`);
}
if (blocker.length > 0) {
  console.log(`  🛑 超过 3 秒的阻塞级页面：${blocker.length} 个`);
  for (const s of blocker) console.log(`     - ${s.path}：${s.median} ms`);
}

/* ============================================================ 3. 只读副本 + 表规模 */

if (!fs.existsSync(REAL_DB)) {
  console.error(`❌ 真库不存在：${REAL_DB}`);
  process.exit(1);
}
try {
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${sqlPath(COPY_DB)}'`);
  } finally {
    src.close();
  }
} catch (e) {
  console.error(`❌ 复制真库失败：${e?.message ?? e}`);
  process.exit(1);
}

const db = new DatabaseSync(COPY_DB, { timeout: 30000 });
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA query_only = ON"); /* 双保险：后面只做 SELECT / EXPLAIN，不写副本 */

const tableCounts = {};
for (const t of [
  "rooms",
  "bookings",
  "stays",
  "folios",
  "folio_items",
  "payments",
  "guests",
  "housekeeping",
  "op_logs",
  "night_audits",
  "room_logs",
  "ar_ledgers",
  "channels",
  "channel_orders",
]) {
  try {
    tableCounts[t] = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c ?? 0);
  } catch {
    tableCounts[t] = null;
  }
}
console.log(`\n—— 数据规模（副本只读）——`);
console.log(
  Object.entries(tableCounts)
    .map(([k, v]) => `${k}=${v ?? "?"}`)
    .join("  ")
);

/* ============================================================ 4. SQL 静态扫描 */

/** 是否是「以 SELECT/WITH 开头」的 SQL（排除 JSX 里带 select 字样的普通模板字符串） */
function isSelectSql(raw) {
  const cleaned = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--[^\n]*$/gm, "")
    .trim();
  return /^(SELECT|WITH)\b/i.test(cleaned);
}

/** 找出源码里所有「以 SELECT/WITH 开头的模板字符串」 */
function extractSqlBlocks(file) {
  const src = fs.readFileSync(file, "utf8");
  const blocks = [];
  const re = /`([^`]*?\b(?:SELECT|WITH)\b[^`]*?)`/gis;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1].trim();
    if (raw.length < 20) continue;
    if (!isSelectSql(raw)) continue;
    if (/\$\{/.test(raw)) continue; /* 有模板插值的 SQL 无法静态执行（多半在 lib 里，单独跳过） */
    const line = src.slice(0, m.index).split("\n").length;
    blocks.push({ sql: raw, line });
  }
  return blocks;
}

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(p);
      } else if (/page\.tsx$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(path.join(ROOT, "src", "app"));
  return out;
}

function routeOf(file) {
  const rel = path.relative(path.join(ROOT, "src", "app"), file).replace(/\\/g, "/");
  return (
    "/" +
    rel
      .replace(/\/page\.tsx$/, "")
      .replace(/^page\.tsx$/, "")
      .replace(/\((main|mobile|auth)\)\/?/g, "")
      .replace(/\/$/, "")
  );
}

function countParams(sql) {
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i += 1;
        else quote = null;
      }
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "?") {
      n += 1;
    }
  }
  return n;
}

function planFor(sql, binds) {
  const st = db.prepare(`EXPLAIN QUERY PLAN ${sql.replace(/;\s*$/, "")}`);
  return st.all(...binds).map((r) => String(r.detail ?? ""));
}

function timeSql(sql, binds) {
  const st = db.prepare(sql.replace(/;\s*$/, ""));
  /* 先跑一次，判断是否重查询：>120ms 只跑 1 次，避免基线脚本本身跑几分钟 */
  const t0 = process.hrtime.bigint();
  st.all(...binds);
  const first = Number(process.hrtime.bigint() - t0) / 1e6;
  if (first > 120) return round(first);
  const times = [first];
  for (let i = 0; i < 2; i += 1) {
    const a = process.hrtime.bigint();
    st.all(...binds);
    times.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  times.sort((a, b) => a - b);
  return round(times[1]);
}

const pageFiles = sourceFiles();
const sqlRecords = [];
let sqlSkipped = 0;

for (const file of pageFiles) {
  let blocks;
  try {
    blocks = extractSqlBlocks(file);
  } catch {
    continue;
  }
  const seen = new Set();
  for (const b of blocks) {
    const key = b.sql.replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const params = countParams(b.sql);
    const binds = Array(params).fill(1);
    let plan;
    try {
      plan = planFor(b.sql, binds);
    } catch {
      sqlSkipped += 1;
      continue;
    }
    let ms;
    try {
      ms = timeSql(b.sql, binds);
    } catch {
      sqlSkipped += 1;
      continue;
    }
    const scans = [];
    for (const line of plan) {
      const m = line.match(/^SCAN (\w+)/);
      if (m && !/CONSTANT ROW|SUBQUERY/.test(line)) scans.push({ table: m[1], mode: "SCAN" });
      const s = line.match(/^SEARCH (\w+) USING/);
      if (s) scans.push({ table: s[1], mode: "SEARCH" });
    }
    sqlRecords.push({
      file: path.relative(ROOT, file).replace(/\\/g, "/"),
      route: routeOf(file),
      line: b.line,
      sql: b.sql,
      oneLine: key.slice(0, 220),
      params,
      ms,
      plan,
      scans,
      correlated: /CORRELATED/.test(plan.join(" ")),
      tempBtree: /TEMP B-TREE/.test(plan.join(" ")),
    });
  }
}

sqlRecords.sort((a, b) => b.ms - a.ms);
const slowSql = sqlRecords.filter((r) => r.ms >= 5);

console.log(`\n—— SQL 静态扫描 ——`);
console.log(`  页面源码 ${pageFiles.length} 个，可执行 SQL ${sqlRecords.length} 条（${sqlSkipped} 条无法静态执行/有插值，已跳过）`);
console.log(`  ≥5ms 的 SQL：${slowSql.length} 条；全部 SQL 合计耗时 ${round(sqlRecords.reduce((s, r) => s + r.ms, 0))} ms`);

/* ---- 全表扫描（大表）---- */
const bigTables = new Set(
  Object.entries(tableCounts)
    .filter(([, c]) => Number(c) >= 200)
    .map(([t]) => t)
);
const fullScans = sqlRecords.filter((r) => r.scans.some((s) => s.mode === "SCAN" && bigTables.has(s.table)));
console.log(`  全表扫描大表（≥200 行）的 SQL：${fullScans.length} 条`);

/* ---- 疑似 N+1：循环体内出现 all()/get() ---- */

/** 从循环行开始，按花括号配对截出循环体（忽略字符串/注释的粗糙实现，够用即可） */
function loopBodyOf(lines, start) {
  let depth = 0;
  let started = false;
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    body.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (started && depth <= 0) break;
    if (!started && i > start) break; /* 没有花括号 = 单语句循环，不可能是查库 */
  }
  return body.join("\n");
}

const nPlusOne = [];

/** 本文件里「函数体包含 all()/get()」的函数名（用于识别 for/while 里调用 helper 的隐式 N+1） */
function helperFunctionsWithQuery(lines) {
  const map = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const decl = lines[i].match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
    const arrow = lines[i].match(/^\s*const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
    if (!decl && !arrow) continue;
    /* 表达式体的箭头函数（=> 后面不是花括号）不含独立的函数体，跳过，避免把后面的循环误算进来 */
    if (!decl) {
      const afterArrow = lines[i].slice(lines[i].indexOf("=>") + 2).trim();
      const nextLine = lines.slice(i + 1).find((l) => l.trim().length > 0) ?? "";
      if (!afterArrow.startsWith("{") && !nextLine.trim().startsWith("{")) continue;
    }
    const body = loopBodyOf(lines, i);
    if (/(?:all|get)\s*(?:<[^>]*>)?\s*\(\s*`/.test(body)) map.set((decl ?? arrow)[1], i + 1);
  }
  return map;
}

for (const file of pageFiles) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  const helpers = helperFunctionsWithQuery(lines);
  const reported = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*(for\s*\(|while\s*\(|.*\.(forEach|map)\s*\()/.test(line)) continue;
    const body = loopBodyOf(lines, i);
    const q = body.match(/(?:all|get)\s*(?:<[^>]*>)?\s*\(\s*`([^`]{20,})`/);
    let via = "";
    let sqlHint = "";
    if (q && isSelectSql(q[1])) {
      via = "直接查库";
      sqlHint = q[1].replace(/\s+/g, " ").trim().slice(0, 120);
    } else {
      for (const [name, defLine] of helpers) {
        if (defLine === i + 1) continue;
        if (new RegExp(`\\b${name}\\s*\\(`).test(body)) {
          via = `调用 helper ${name}()`;
          sqlHint = `见 ${path.relative(ROOT, file).replace(/\\/g, "/")}:${defLine}`;
          break;
        }
      }
    }
    if (!via) continue;
    const key = `${i + 1}`;
    if (reported.has(key)) continue;
    reported.add(key);
    nPlusOne.push({
      file: path.relative(ROOT, file).replace(/\\/g, "/"),
      route: routeOf(file),
      line: i + 1,
      loop: line.trim().slice(0, 100),
      via,
      sqlHint,
    });
  }
}
console.log(`  疑似 N+1（循环体内查库 / 循环内调用的 helper 查库）：${nPlusOne.length} 处`);

/* ---- 重复查询：同一页面里同一条 SQL 出现多次 ---- */
const dupQueries = [];
for (const file of pageFiles) {
  const blocks = extractSqlBlocks(file).map((b) => b.sql.replace(/\s+/g, " ").trim());
  const count = new Map();
  for (const b of blocks) count.set(b, (count.get(b) ?? 0) + 1);
  for (const [sql, n] of count) {
    if (n > 1) {
      dupQueries.push({
        file: path.relative(ROOT, file).replace(/\\/g, "/"),
        route: routeOf(file),
        times: n,
        sql: sql.slice(0, 180),
      });
    }
  }
}
console.log(`  同一页面重复出现的 SQL：${dupQueries.length} 条`);

/* ============================================================ 5. 索引体检 */

const indexRows = db
  .prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name`
  )
  .all()
  .map((r) => ({ ...r }));
console.log(`\n—— 索引体检 ——`);
console.log(`  显式索引共 ${indexRows.length} 个；大表：${[...bigTables].join(", ")}`);

/* ============================================================ 6. 输出 JSON */

const result = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  node: process.version,
  buildId: (() => {
    try {
      return fs.readFileSync(path.join(ROOT, ".next", "BUILD_ID"), "utf8").trim();
    } catch {
      return null;
    }
  })(),
  runs: RUNS,
  tableCounts,
  pages: pageResults,
  slowPages: slow.map((s) => ({ path: s.path, median: s.median })),
  blockerPages: blocker.map((s) => ({ path: s.path, median: s.median })),
  sql: {
    total: sqlRecords.length,
    skipped: sqlSkipped,
    sumMs: round(sqlRecords.reduce((s, r) => s + r.ms, 0)),
    all: sqlRecords.map((r) => ({
      file: r.file,
      route: r.route,
      line: r.line,
      ms: r.ms,
      sql: r.oneLine,
      plan: r.plan,
      scans: r.scans,
      correlated: r.correlated,
      tempBtree: r.tempBtree,
    })),
    slow: slowSql.map((r) => ({
      file: r.file,
      route: r.route,
      line: r.line,
      ms: r.ms,
      sql: r.oneLine,
      plan: r.plan,
      scans: r.scans,
      correlated: r.correlated,
      tempBtree: r.tempBtree,
    })),
    fullScans: fullScans.map((r) => ({ file: r.file, route: r.route, line: r.line, ms: r.ms, sql: r.oneLine, scans: r.scans })),
    correlated: sqlRecords
      .filter((r) => r.correlated)
      .map((r) => ({ file: r.file, route: r.route, line: r.line, ms: r.ms, sql: r.oneLine, plan: r.plan })),
  },
  pageSqlSummary: (() => {
    const map = new Map();
    for (const r of sqlRecords) {
      if (!map.has(r.route)) map.set(r.route, []);
      map.get(r.route).push(r);
    }
    return [...map.entries()]
      .map(([route, rows]) => ({
        route,
        queries: rows.length,
        sumMs: round(rows.reduce((s, r) => s + r.ms, 0)),
        maxMs: round(Math.max(...rows.map((r) => r.ms))),
        slowest: rows
          .filter((r) => r.ms === Math.max(...rows.map((x) => x.ms)))
          .slice(0, 1)
          .map((r) => ({ file: r.file, line: r.line, ms: r.ms, sql: r.oneLine })),
      }))
      .sort((a, b) => b.sumMs - a.sumMs);
  })(),
  nPlusOne,
  dupQueries,
  indexes: indexRows,
};
fs.writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2));

/* ============================================================ 7. 控制台重点 */

console.log(`\n—— 最慢的 15 条 SQL（副本上实测）——`);
for (const r of sqlRecords.slice(0, 15)) {
  const flags = [
    r.correlated ? "相关子查询" : "",
    r.tempBtree ? "临时B树" : "",
    r.scans.filter((s) => s.mode === "SCAN" && bigTables.has(s.table)).length > 0
      ? `全表扫描:${r.scans.filter((s) => s.mode === "SCAN" && bigTables.has(s.table)).map((s) => s.table).join(",")}`
      : "",
  ]
    .filter(Boolean)
    .join(" / ");
  console.log(`  ${String(r.ms).padStart(7)} ms  ${r.route}${flags ? `  [${flags}]` : ""}`);
  console.log(`      ${r.file}:${r.line}  ${r.oneLine.slice(0, 150)}`);
}

if (slowSql.length > 0) {
  console.log(`\n—— 慢 SQL 的 EXPLAIN QUERY PLAN（前 5 条）——`);
  for (const r of slowSql.slice(0, 5)) {
    console.log(`  ${r.ms} ms  ${r.file}:${r.line}`);
    for (const p of r.plan.slice(0, 8)) console.log(`      ${p}`);
  }
}

if (nPlusOne.length > 0) {
  console.log(`\n—— 疑似 N+1（循环体内查库）前 10 处 ——`);
  for (const n of nPlusOne.slice(0, 10)) {
    console.log(`  ${n.route}  ${n.file}:${n.line}  ${n.loop}`);
    console.log(`      ${n.sqlHint}`);
  }
}

if (dupQueries.length > 0) {
  console.log(`\n—— 同一页面重复查询 前 10 条 ——`);
  for (const d of dupQueries.slice(0, 10)) console.log(`  ${d.route}  ×${d.times}  ${d.sql}`);
}

db.close();
console.log(`\n结果 JSON：${RESULT_JSON}`);
console.log(`副本目录：${DIR}（不含 -wal/-shm；可直接删除）`);

if (bad.length > 0) {
  console.log(`\n❌ ${bad.length} 个页面无法测量（非 200 / curl 无响应）：`);
  for (const b of bad) console.log(`   - ${b.path}：${b.error ?? b.status}`);
  process.exit(1);
}
console.log(`\n页面测量完成：${pageResults.length} 个 URL 全部 200，无测量失败。`);
process.exit(0);
