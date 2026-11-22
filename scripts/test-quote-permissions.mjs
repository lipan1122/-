#!/usr/bin/env node
/**
 * 报价 / 协议单位 / 打扫员 三个模块的 Server Action 权限验收
 * （第六轮清单 一.8 报价和协议数据、一.9 打扫员档案）
 *
 * ── 清单要求 ──
 *  §一.8
 *   · 报价新增、修改、删除使用 settings.manage 或 quote.manage
 *   · 删除报价必须二次确认
 *   · 协议客户新增、修改、信用额度变更使用 settings.manage 或 company.manage
 *   · 信用额度变更必须记录旧值、新值、原因和操作人
 *   · 报价、公司和信用账务全部带 hotel_id
 *  §一.9
 *   · 新增、启停打扫员使用 settings.manage 或 housekeeping.manage
 *   · 客房人员不能修改打扫员档案
 *   · 停用前检查是否有未完成任务
 *   · 历史业绩保留
 *   · 变更写操作日志
 *
 * ── 验法（与 test-member-permissions.mjs 同一套）──
 *   VACUUM INTO 真库副本 + `globalThis.__pmsDb` 注入 + registerHooks 桩掉 next/*，
 *   直接 import 仓库里的真实 actions.ts / session.ts，用不同岗位的真实会话行调用。
 *   真库全程只读，收尾复查行数不变。
 *
 * 用法：node scripts/test-quote-permissions.mjs
 * 退出码：有 ❌ 时 1，全绿 0。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = path.join(ROOT, ".tmp");
const TAG = "quote-permissions";
const STAMP = Date.now();
const ISO_DIR = path.join(TMP_DIR, `${TAG}-${STAMP}`);
const ISO_DB = path.join(ISO_DIR, "data", "pms.db");
const STUB_FILE = path.join(ISO_DIR, "next-stub.mjs");
const HOTEL = 1;
const HOTEL_B = 999;

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${extra ? ` :: ${extra}` : ""}`);
    console.log(`  ❌ ${label}${extra ? `  ${extra}` : ""}`);
  }
};
const section = (title) => console.log(`\n=== ${title} ===`);

function abandon(message, detail = "") {
  console.error(`\n❌ ${message}${detail ? `\n   ${detail}` : ""}`);
  try {
    fs.rmSync(ISO_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不掩盖原错误 */
  }
  process.exit(1);
}

if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs）`);

function realDbCounts() {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const one = (sql) => db.prepare(sql).get()?.c ?? 0;
    return {
      quotes: one(`SELECT COUNT(*) AS c FROM quotes`),
      companies: one(`SELECT COUNT(*) AS c FROM companies`),
      cleaners: one(`SELECT COUNT(*) AS c FROM cleaners`),
      op_logs: one(`SELECT COUNT(*) AS c FROM op_logs`),
      sessions: one(`SELECT COUNT(*) AS c FROM sessions`),
    };
  } finally {
    db.close();
  }
}
const REAL_BEFORE = realDbCounts();

try {
  fs.mkdirSync(path.join(ISO_DIR, "data"), { recursive: true });
} catch (e) {
  abandon(`临时目录不可写：${ISO_DIR}`, String(e?.message ?? e));
}
try {
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${ISO_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
} catch (e) {
  abandon(`VACUUM INTO 复制真库失败：${REAL_DB} → ${ISO_DB}`, String(e?.message ?? e));
}
check("真库副本已生成（VACUUM INTO，脚本只在副本上写）", fs.existsSync(ISO_DB) && fs.statSync(ISO_DB).size > 0);

process.on("exit", () => {
  try {
    conn?.close();
  } catch {
    /* 已关闭 */
  }
  try {
    if (fs.existsSync(ISO_DIR)) fs.rmSync(ISO_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

const conn = new DatabaseSync(ISO_DB);
conn.exec("PRAGMA busy_timeout = 8000");
const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);
const one = (sql, params = []) => conn.prepare(sql).get(...params);

/* ============================================================ 1. 桩 + 装载真实模块 */

fs.writeFileSync(
  STUB_FILE,
  `let sid = null;
export function setSid(v) { sid = v; }
export function cookies() {
  return { get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined) };
}
export function headers() { return new Map(); }
export function redirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export function revalidatePath() {}
export function revalidateTag() {}
`
);
const stubUrl = pathToFileURL(STUB_FILE).href;

process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

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
        /* 不是 .ts，交给默认解析 */
      }
    }
    return next(specifier, context);
  },
});

globalThis.__pmsDb = conn;

let session;
let quotes;
let companies;
let cleaners;
let stub;
try {
  session = await import("../src/lib/session.ts");
  quotes = await import("../src/app/(main)/quotes/actions.ts");
  companies = await import("../src/app/(main)/companies/actions.ts");
  cleaners = await import("../src/app/(main)/cleaners/actions.ts");
  stub = await import(stubUrl);
} catch (e) {
  abandon("装载 quotes / companies / cleaners actions.ts 失败", String(e?.stack ?? e?.message ?? e));
}

const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const users = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
const sidOf = {};
for (const u of users) {
  const sid = `test-quote-${u.role}-${STAMP}`;
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
    EXPIRES,
  ]);
  sidOf[u.role] = sid;
  sidOf[`_realname_${u.role}`] = u.real_name;
}
check(
  "4 个岗位各有 1 条验收会话（admin / frontdesk / cashier / housekeeping）",
  ["admin", "frontdesk", "cashier", "housekeeping"].every((r) => !!sidOf[r]),
  Object.keys(sidOf).filter((k) => !k.startsWith("_")).join(",")
);

run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [
  HOTEL_B,
  `TB${STAMP}`.slice(0, 20),
  "验收酒店B",
  NOW,
]);
run(
  `INSERT OR IGNORE INTO users (id, hotel_id, username, password, real_name, role, status)
   VALUES (?,?,?,?,?,?,?)`,
  [90002, HOTEL_B, `testadmin_b_${STAMP}`, "x", "B店管理员", "admin", 1]
);
const sidB = `test-quote-hotelB-${STAMP}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  sidB,
  JSON.stringify({ id: 90002, username: `testadmin_b_${STAMP}`, realName: "B店管理员", role: "admin", hotelId: HOTEL_B, hotelName: "验收酒店B" }),
  NOW,
  EXPIRES,
]);
sidOf["admin@999"] = sidB;

/* ============================================================ 调用工具 */

const fd = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.append(k, String(v));
  return f;
};

function flashOf(res) {
  if (res.status !== "redirect") return { type: "", text: "" };
  const u = new URL(res.url, "http://local");
  const err = u.searchParams.get("err") ?? "";
  const msg = u.searchParams.get("msg") ?? "";
  return { type: err ? "err" : "msg", text: err || msg };
}

function isDenied(res, permission) {
  return res.status === "throw" && /FORBIDDEN/.test(res.message) && (!permission || res.message.includes(permission));
}

async function as(role, fn) {
  stub.setSid(sidOf[role]);
  try {
    const value = await fn();
    return { status: "resolved", value };
  } catch (e) {
    const message = String((e && e.message) || e);
    if (message.startsWith("NEXT_REDIRECT:")) {
      return { status: "redirect", url: message.slice("NEXT_REDIRECT:".length) };
    }
    return { status: "throw", message };
  }
}

const like = (s, ...parts) => parts.every((p) => String(s).includes(p));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const quotesSrc = stripComments(fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "quotes", "actions.ts"), "utf8"));
const companiesSrc = stripComments(fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "companies", "actions.ts"), "utf8"));
const cleanersSrc = stripComments(fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "cleaners", "actions.ts"), "utf8"));
const quotesPageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "quotes", "page.tsx"), "utf8");
const cleanersPageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "cleaners", "page.tsx"), "utf8");

const opLogs = (action) =>
  all(`SELECT * FROM op_logs WHERE hotel_id = ? AND action = ? ORDER BY id DESC`, [HOTEL, action]);

/* ============================================================ 2. 权限点与源码守卫 */

section("2. settings.manage 复用 + 四个文件的源码守卫");

const permRows = all(`SELECT role FROM role_permissions WHERE hotel_id = ? AND permission = 'settings.manage'`, [HOTEL]).map(
  (r) => r.role
);
check("settings.manage 只有 admin（价格 / 授信 / 人事配置的最严档）", permRows.length === 1 && permRows[0] === "admin", permRows.join(","));
check(
  "三处都没有 quote.manage / company.manage / housekeeping.manage 的定义（清单允许复用）",
  !/"quote\.manage"|"company\.manage"|"housekeeping\.manage"/.test(
    fs.readFileSync(path.join(ROOT, "src", "lib", "session.ts"), "utf8")
  )
);

const guardSpecs = [
  ["quotes", quotesSrc, { saveQuoteAction: "settings.manage", deleteQuoteAction: "settings.manage" }],
  [
    "companies",
    companiesSrc,
    {
      createCompanyAction: "settings.manage",
      updateCompanyAction: "settings.manage",
      deleteCompanyAction: "settings.manage",
    },
  ],
  [
    "cleaners",
    cleanersSrc,
    { addCleanerAction: "settings.manage", setCleanerStatusAction: "settings.manage" },
  ],
];
for (const [label, src, spec] of guardSpecs) {
  for (const [name, permission] of Object.entries(spec)) {
    const i = src.indexOf(`export async function ${name}(`);
    const j = src.indexOf("\nexport ", i + 10);
    const body = src.slice(i, j < 0 ? src.length : j);
    const permAt = body.indexOf(`requirePermission("${permission}")`);
    const mutateAt = Math.min(
      ...[body.search(/\brun\s*\(/), body.search(/\btx\s*\(/), body.search(/\bINSERT\s+INTO\b/i), body.search(/\bUPDATE\s+\w+\s+SET\b/i), body.search(/\bDELETE\s+FROM\b/i)].filter(
        (n) => n >= 0
      )
    );
    check(
      `${label}/${name} 守卫是 requirePermission("${permission}") 且早于写库`,
      permAt >= 0 && (Number.isNaN(mutateAt) || permAt < mutateAt),
      `perm@${permAt} mutate@${Number.isNaN(mutateAt) ? "-" : mutateAt}`
    );
  }
  check(`${label}/actions.ts 里没有残留 requireUser()`, (src.match(/requireUser\s*\(/g) || []).length === 0);
}

/* hotel_id 全覆盖（清单：报价、公司和信用账务全部带 hotel_id） */
check(
  "quotes 的 INSERT 带 hotel_id",
  /INSERT INTO quotes \(hotel_id/.test(quotesSrc)
);
check(
  "quotes 的 UPDATE / DELETE 都按 id + hotel_id 定位",
  /UPDATE quotes SET[\s\S]*?WHERE id=\? AND hotel_id=\?/.test(quotesSrc) &&
    /DELETE FROM quotes WHERE id = \? AND hotel_id = \?/.test(quotesSrc)
);
check("companies 的 INSERT 带 hotel_id", /INSERT INTO companies \(hotel_id/.test(companiesSrc));
check(
  "companies 的 UPDATE / DELETE 都按 id + hotel_id 定位",
  /UPDATE companies SET[\s\S]*?WHERE id = \? AND hotel_id = \?/.test(companiesSrc) &&
    /DELETE FROM companies WHERE id = \? AND hotel_id = \?/.test(companiesSrc)
);
check("cleaners 的 INSERT 带 hotel_id", /INSERT INTO cleaners \(hotel_id/.test(cleanersSrc));
check(
  "cleaners 的 UPDATE 按 id + hotel_id 定位",
  /UPDATE cleaners SET status = \? WHERE id = \? AND hotel_id = \?/.test(cleanersSrc)
);
check("cleaners 从不 DELETE（停用只改状态，历史业绩保留）", !/DELETE\s+FROM\s+cleaners/i.test(cleanersSrc));
check(
  "停用前检查未完成任务（status IN ('PENDING','DOING') + assignee）",
  /status IN \('PENDING','DOING'\)/.test(cleanersSrc) && /assignee = \?/.test(cleanersSrc)
);

/* 页面侧：删除报价必须二次确认 */
check(
  "quotes/page.tsx 用 ConfirmForm 包裹删除（二次确认 + 原因必填）",
  /import ConfirmForm from "@\/components\/ConfirmForm"/.test(quotesPageSrc) &&
    /<ConfirmForm[\s\S]{0,400}action=\{deleteQuoteAction\}/.test(quotesPageSrc) &&
    /requireReason="删除原因"/.test(quotesPageSrc)
);
check(
  "cleaners/page.tsx 按 settings.manage 隐藏新增 / 启停（客房岗位看不到改档入口）",
  /hasPermission\(user\.role, "settings\.manage"/.test(cleanersPageSrc) &&
    /\{canManage \? \(/.test(cleanersPageSrc)
);

/* ============================================================ 3. 报价 */

section("3. 报价：增删改要 settings.manage；删除必须填原因");

const quoteSample = one(`SELECT id, name, price, start_date, end_date FROM quotes WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL]);
check("副本里有可用的报价样本", !!quoteSample, quoteSample ? quoteSample.name : "无");

const quotesBefore = one(`SELECT COUNT(*) AS c FROM quotes WHERE hotel_id = ?`, [HOTEL]).c;
let r = await as("housekeeping", () => quotes.saveQuoteAction(fd({ name: "越权报价", price: 1 })));
check("housekeeping 新增报价被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("frontdesk", () => quotes.saveQuoteAction(fd({ name: "越权报价", price: 1 })));
check("frontdesk 新增报价被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("cashier", () => quotes.saveQuoteAction(fd({ name: "越权报价", price: 1 })));
check("cashier 新增报价被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check("被拒的请求没有建出报价", one(`SELECT COUNT(*) AS c FROM quotes WHERE hotel_id = ?`, [HOTEL]).c === quotesBefore);

r = await as("admin", () =>
  quotes.saveQuoteAction(fd({ name: `验收报价${String(STAMP).slice(-4)}`, room_type_id: 1, price: 288, start_date: "2026-12-01", end_date: "2026-12-31", note: "权限验收" }))
);
check("admin 新增报价放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${r.url ?? r.message}`);
const newQuote = one(`SELECT * FROM quotes WHERE hotel_id = ? AND name = ?`, [HOTEL, `验收报价${String(STAMP).slice(-4)}`]);
check("报价落库且带 hotel_id", !!newQuote && Number(newQuote.hotel_id) === HOTEL && Number(newQuote.price) === 288);
check(
  "新增报价写 op_logs（新增报价）",
  opLogs("新增报价").some((l) => like(l.detail, `验收报价${String(STAMP).slice(-4)}`))
);

r = await as("admin", () => quotes.saveQuoteAction(fd({ id: newQuote.id, name: newQuote.name, room_type_id: 1, price: 388, start_date: "2026-12-01", end_date: "2026-12-31" })));
check("admin 修改报价放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${r.url ?? r.message}`);
check("报价价格已更新", Number(one(`SELECT price FROM quotes WHERE id = ? AND hotel_id = ?`, [newQuote.id, HOTEL]).price) === 388);
const quoteUpdateLog = opLogs("修改报价")[0];
check(
  "修改报价日志记了旧值 → 新值",
  !!quoteUpdateLog && like(quoteUpdateLog.detail, "288", "388", "→"),
  quoteUpdateLog ? quoteUpdateLog.detail : "无日志"
);

r = await as("housekeeping", () => quotes.deleteQuoteAction(fd({ id: newQuote.id, reason: "越权删除" })));
check("housekeeping 删除报价被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check("被拒后报价还在", !!one(`SELECT id FROM quotes WHERE id = ? AND hotel_id = ?`, [newQuote.id, HOTEL]));

r = await as("admin", () => quotes.deleteQuoteAction(fd({ id: newQuote.id })));
check(
  "删除报价不填原因被拒（服务端二次确认兜底）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "原因", "二次确认"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("无原因的删除没有生效", !!one(`SELECT id FROM quotes WHERE id = ? AND hotel_id = ?`, [newQuote.id, HOTEL]));

r = await as("admin@999", () => quotes.deleteQuoteAction(fd({ id: newQuote.id, reason: "跨店删除" })));
check(
  "跨酒店删除报价被拒（查不到本店报价）",
  r.status === "redirect" && flashOf(r).type === "err",
  `${r.status} ${flashOf(r).text || r.message}`
);
check("跨酒店请求没有删掉 1 号店报价", !!one(`SELECT id FROM quotes WHERE id = ? AND hotel_id = ?`, [newQuote.id, HOTEL]));

r = await as("admin", () => quotes.deleteQuoteAction(fd({ id: newQuote.id, reason: "活动取消，价格作废" })));
check("admin 删除报价（带原因）放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check("报价已删除", !one(`SELECT id FROM quotes WHERE id = ? AND hotel_id = ?`, [newQuote.id, HOTEL]));
const quoteDeleteLog = opLogs("删除报价")[0];
check(
  "删除报价日志记了名称 / 价格 / 有效期 / 原因",
  !!quoteDeleteLog && like(quoteDeleteLog.detail, `验收报价${String(STAMP).slice(-4)}`, "388", "原因：活动取消，价格作废"),
  quoteDeleteLog ? quoteDeleteLog.detail : "无日志"
);

/* ============================================================ 4. 协议单位 */

section("4. 协议单位：增改要 settings.manage；信用额度变更记旧值 / 新值 / 原因 / 操作人");

const company = one(`SELECT * FROM companies WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL]);
check("副本里有可用的协议单位样本", !!company, company ? company.name : "无");
const oldCredit = Number(company.credit_limit);

const companiesBefore = one(`SELECT COUNT(*) AS c FROM companies WHERE hotel_id = ?`, [HOTEL]).c;
r = await as("housekeeping", () => companies.createCompanyAction(fd({ name: "越权单位", credit_limit: 1 })));
check("housekeeping 新增协议单位被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
r = await as("frontdesk", () => companies.createCompanyAction(fd({ name: "越权单位", credit_limit: 1 })));
check("frontdesk 新增协议单位被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check("被拒的请求没有建出协议单位", one(`SELECT COUNT(*) AS c FROM companies WHERE hotel_id = ?`, [HOTEL]).c === companiesBefore);

r = await as("admin", () => companies.createCompanyAction(fd({ name: `验收单位${String(STAMP).slice(-4)}`, contact: "验收人", phone: "0571-1234", discount: 0.8, credit_limit: 8000 })));
check("admin 新增协议单位放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
const newCompany = one(`SELECT * FROM companies WHERE hotel_id = ? AND name = ?`, [HOTEL, `验收单位${String(STAMP).slice(-4)}`]);
check("协议单位落库且带 hotel_id / 信用额度", !!newCompany && Number(newCompany.hotel_id) === HOTEL && Number(newCompany.credit_limit) === 8000);
check("新增协议单位写 op_logs", opLogs("新增协议单位").some((l) => like(l.detail, `验收单位${String(STAMP).slice(-4)}`)));

/* 改信用额度但不填原因 → 拒绝且数值不变 */
r = await as("housekeeping", () => companies.updateCompanyAction(fd({ id: company.id, name: company.name, contact: company.contact ?? "", phone: company.phone ?? "", discount: company.discount, credit_limit: 99999 })));
check("housekeeping 改信用额度被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check("被拒后信用额度没变", Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]).credit_limit) === oldCredit);

r = await as("admin", () => companies.updateCompanyAction(fd({ id: company.id, name: company.name, contact: company.contact ?? "", phone: company.phone ?? "", discount: company.discount, credit_limit: 88888 })));
check(
  "改信用额度不填原因被拒（授信变更必须说明原因）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "原因"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("无原因的额度调整没有落库", Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]).credit_limit) === oldCredit);

r = await as("admin", () => companies.updateCompanyAction(fd({ id: company.id, name: company.name, contact: company.contact ?? "", phone: company.phone ?? "", discount: company.discount, credit_limit: 88888, reason: "年度合同续签提额" })));
check("admin 改信用额度（带原因）放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check("信用额度已更新为新值", Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]).credit_limit) === 88888);

const creditLog = opLogs("变更信用额度")[0];
check(
  "op_logs 记了「变更信用额度」",
  !!creditLog,
  creditLog ? creditLog.detail : "无日志"
);
const creditDigits = String((creditLog && creditLog.detail) || "").replace(/,/g, "");
check(
  "信用额度日志含旧值与新值",
  !!creditLog && like(creditLog.detail, "旧值", "新值") && creditDigits.includes(String(oldCredit)) && creditDigits.includes("88888"),
  creditLog ? creditLog.detail : "无日志"
);
check(
  "信用额度日志含原因与操作人",
  !!creditLog && like(creditLog.detail, "原因：年度合同续签提额", "操作人："),
  creditLog ? creditLog.detail : "无日志"
);
check(
  "信用额度日志的 operator 列就是当前操作人",
  !!creditLog && String(creditLog.operator).length > 0 && String(creditLog.detail).includes(`操作人：${creditLog.operator}`),
  creditLog ? `${creditLog.operator} / ${creditLog.detail}` : "无日志"
);

/* 只改档案不改额度 → 不需要原因，单独记「修改协议单位」 */
const contactBefore = String(company.contact ?? "");
r = await as("admin", () => companies.updateCompanyAction(fd({ id: company.id, name: company.name, contact: "新联系人", phone: company.phone ?? "", discount: company.discount, credit_limit: 88888 })));
check("只改联系人（不动额度）不需要原因", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text || r.message}`);
check(
  "联系人已更新、额度不变",
  String(one(`SELECT contact FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]).contact) === "新联系人" &&
    Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]).credit_limit) === 88888
);
check(
  "档案修改写 op_logs（修改协议单位，含旧联系人）",
  opLogs("修改协议单位").some((l) => like(l.detail, contactBefore, "新联系人")),
  (opLogs("修改协议单位")[0] ?? {}).detail ?? "无日志"
);

/* 跨酒店：B 店 admin 改不动 1 号店单位 */
r = await as("admin@999", () => companies.updateCompanyAction(fd({ id: company.id, name: company.name, contact: "越权", phone: "", discount: 1, credit_limit: 1, reason: "越权" })));
check(
  "跨酒店修改协议单位被拒（不属于本店）",
  r.status === "redirect" && flashOf(r).type === "err",
  `${r.status} ${flashOf(r).text || r.message}`
);
check("跨酒店请求没有改动 1 号店单位", Number(one(`SELECT credit_limit FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]).credit_limit) === 88888);

r = await as("admin", () => companies.updateCompanyAction(fd({ id: company.id, name: company.name, contact: "x", phone: "", discount: 1, credit_limit: -1, reason: "负数" })));
check(
  "负数信用额度被拒",
  r.status === "redirect" && flashOf(r).type === "err",
  `${r.status} ${flashOf(r).text || r.message}`
);

r = await as("housekeeping", () => companies.deleteCompanyAction(fd({ id: company.id, reason: "越权删除" })));
check("housekeeping 删除协议单位被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check("被拒后单位还在", !!one(`SELECT id FROM companies WHERE id = ? AND hotel_id = ?`, [company.id, HOTEL]));

/* ============================================================ 5. 打扫员 */

section("5. 打扫员：客房岗位不能改档案；停用前检查未完成任务；历史业绩保留");

const zhao = one(`SELECT * FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, "赵阿姨"]);
const qian = one(`SELECT * FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, "钱阿姨"]);
check("副本里赵阿姨有未完成任务（停用应被拒）", !!zhao && Number(one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status IN ('PENDING','DOING')`, [HOTEL, "赵阿姨"]).c) > 0);
check("副本里钱阿姨没有未完成任务（停用应放行）", !!qian && Number(one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status IN ('PENDING','DOING')`, [HOTEL, "钱阿姨"]).c) === 0);

const cleanersBefore = one(`SELECT COUNT(*) AS c FROM cleaners WHERE hotel_id = ?`, [HOTEL]).c;
const newCleanerName = `验收阿姨${String(STAMP).slice(-4)}`;

r = await as("housekeeping", () => cleaners.addCleanerAction(fd({ name: newCleanerName, phone: "13800009999" })));
check(
  "客房岗位（housekeeper）新增打扫员被拒（清单：客房人员不能修改打扫员档案）",
  isDenied(r, "settings.manage"),
  r.message
);
r = await as("frontdesk", () => cleaners.addCleanerAction(fd({ name: newCleanerName, phone: "13800009999" })));
check("frontdesk 新增打扫员被拒（FORBIDDEN settings.manage）", isDenied(r, "settings.manage"), r.message);
check("被拒的请求没有建出打扫员", one(`SELECT COUNT(*) AS c FROM cleaners WHERE hotel_id = ?`, [HOTEL]).c === cleanersBefore);

r = await as("admin", () => cleaners.addCleanerAction(fd({ name: newCleanerName, phone: "13800009999" })));
check("admin 新增打扫员放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text ?? r.message}`);
const newCleaner = one(`SELECT * FROM cleaners WHERE hotel_id = ? AND name = ?`, [HOTEL, newCleanerName]);
check("打扫员落库（ACTIVE，带 hotel_id）", !!newCleaner && newCleaner.status === "ACTIVE" && Number(newCleaner.hotel_id) === HOTEL);
check("新增打扫员写 op_logs", opLogs("新增打扫员").some((l) => like(l.detail, newCleanerName, "ACTIVE")));

/* 客房岗位改状态被拒 */
r = await as("housekeeping", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check(
  "客房岗位（housekeeper）停用打扫员被拒（FORBIDDEN settings.manage）",
  isDenied(r, "settings.manage"),
  r.message
);
check("被拒后赵阿姨仍在岗", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE");

/* 停用前检查未完成任务：赵阿姨有 17 条 PENDING */
const pendingOfZhao = Number(
  one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status IN ('PENDING','DOING')`, [HOTEL, "赵阿姨"]).c
);
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check(
  "赵阿姨有未完成任务时停用被拒（提示未完成条数）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "未完成", String(pendingOfZhao)),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("被拒后赵阿姨仍是 ACTIVE", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE");

/* 跨酒店：B 店 admin 停用 1 号店打扫员 → 查不到 */
r = await as("admin@999", () => cleaners.setCleanerStatusAction(fd({ id: zhao.id, status: "INACTIVE" })));
check(
  "跨酒店停用打扫员被拒（该打扫员不属于本店）",
  r.status === "redirect" && flashOf(r).type === "err",
  `${r.status} ${flashOf(r).text || r.message}`
);
check("跨酒店请求没有改动 1 号店打扫员", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [zhao.id, HOTEL]).status === "ACTIVE");

/* 钱阿姨没有未完成任务 → 可停用；停用只改状态，历史业绩仍在 */
const qianDone = Number(
  one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status = 'DONE'`, [HOTEL, "钱阿姨"]).c
);
check("钱阿姨有历史已完成任务（业绩样本）", qianDone > 0, `done=${qianDone}`);
r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: qian.id, status: "INACTIVE" })));
check("无未完成任务时停用放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text ?? r.message}`);
check("钱阿姨状态改为 INACTIVE", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]).status === "INACTIVE");
check("打扫员行没有被删除（历史业绩的姓名来源保留）", !!one(`SELECT id FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]));
check(
  "停用后历史已完成任务数不变（业绩保留）",
  Number(one(`SELECT COUNT(*) AS c FROM housekeeping WHERE hotel_id = ? AND assignee = ? AND status = 'DONE'`, [HOTEL, "钱阿姨"]).c) === qianDone
);
const disableLog = opLogs("停用打扫员")[0];
check(
  "停用写 op_logs（含 ACTIVE → INACTIVE）",
  !!disableLog && like(disableLog.detail, "钱阿姨", "ACTIVE → INACTIVE"),
  disableLog ? disableLog.detail : "无日志"
);

r = await as("admin", () => cleaners.setCleanerStatusAction(fd({ id: qian.id, status: "ACTIVE" })));
check("admin 重新启用放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${flashOf(r).text ?? r.message}`);
check("钱阿姨状态恢复 ACTIVE", one(`SELECT status FROM cleaners WHERE id = ? AND hotel_id = ?`, [qian.id, HOTEL]).status === "ACTIVE");
check(
  "启用写 op_logs（含 INACTIVE → ACTIVE）",
  opLogs("启用打扫员").some((l) => like(l.detail, "钱阿姨", "INACTIVE → ACTIVE")),
  (opLogs("启用打扫员")[0] ?? {}).detail ?? "无日志"
);

/* ============================================================ 6. 汇总 + 真库零写入 */

section("6. 收尾：真库零写入复查");

const REAL_AFTER = realDbCounts();
check(
  "真库 quotes / companies / cleaners / op_logs / sessions 行数未变（所有写入都在副本里）",
  REAL_AFTER.quotes === REAL_BEFORE.quotes &&
    REAL_AFTER.companies === REAL_BEFORE.companies &&
    REAL_AFTER.cleaners === REAL_BEFORE.cleaners &&
    REAL_AFTER.op_logs === REAL_BEFORE.op_logs &&
    REAL_AFTER.sessions === REAL_BEFORE.sessions,
  `before=${JSON.stringify(REAL_BEFORE)} after=${JSON.stringify(REAL_AFTER)}`
);

console.log("\n========== 汇总 ==========");
if (fail > 0) {
  console.log("❌ 未通过项：");
  for (const f of failures) console.log(`   - ${f}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
