/**
 * 整改验收：P2-4 会话清理 + 登录多店判定，P2-5 打扫任务指派人
 *
 * 覆盖的缺陷：
 *   1. sessions 表只增不删：过期会话没人清，表一直变大；
 *   2. 登录 SQL 只有 `WHERE u.username = ?`：多店部署同名账号静默串店；
 *   3. 退房 / 取消入住生成打扫任务时写死「赵阿姨」：不管谁当班都派给同一人。
 *
 * 本脚本做四类检查：
 *   A. 静态校验：cleanupExpiredSessions 导出与 SQL、登录多店判定、登录页输入框、
 *      夜审清理调用（并确认夜审既有逻辑没被改坏）、迁移脚本的 sessions 索引、
 *      两处派单已换成 pickHousekeepingAssignee；
 *   B. 硬编码扫描：src 下「赵阿姨」作为写库指派人的字面量必须为 0；
 *   C. 真实库校验：idx_sessions_expires 真的建出来了；把 housekeeping-assignee.ts
 *      用 TypeScript 转译后真跑，验证「有在岗客房人员 → 返回姓名」「没有 → 待分配」；
 *   D. 内存库校验：清理 SQL 只删过期会话、不误删未过期 / expires_at 为 NULL 的行。
 *
 * 不修改真实库数据（只有读查询），临时文件写在 data/.tmp-hk-assignee 并在结束时删除。
 *
 * 用法：
 *   node scripts/migrate-all.mjs          # 先落 sessions 索引
 *   node scripts/test-session-hk.mjs
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import ts from "typescript";

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

const SESSION_SRC = join("src", "lib", "session.ts");
const LOGIN_ROUTE = join("src", "app", "api", "login", "route.ts");
const LOGIN_PAGE = join("src", "app", "login", "page.tsx");
const NIGHT_AUDIT = join("src", "app", "(main)", "night-audit", "actions.ts");
const CASHIER = join("src", "app", "(main)", "cashier", "actions.ts");
const INHOUSE = join("src", "app", "(main)", "inhouse", "actions.ts");
const HK_ACTIONS = join("src", "app", "(main)", "housekeeping", "actions.ts");
const ASSIGNEE_LIB = join("src", "lib", "housekeeping-assignee.ts");
const MIGRATE = join("scripts", "migrate-all.mjs");

const read = (p) => readFileSync(p, "utf8");
const src = read(SESSION_SRC);
const loginSrc = read(LOGIN_ROUTE);
const loginPageSrc = read(LOGIN_PAGE);
const nightSrc = read(NIGHT_AUDIT);
const cashierSrc = read(CASHIER);
const inhouseSrc = read(INHOUSE);
const hkActionsSrc = read(HK_ACTIONS);
const assigneeSrc = read(ASSIGNEE_LIB);
const migrateSrc = read(MIGRATE);
const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * 把注释（// 与 /* *\/）替换成空格，保留字符串内容与换行。
 *
 * 只用于「这段中文是不是真代码」的判定：注释里举例「?assignee=赵阿姨」
 * 不算硬编码，真正的 INSERT 参数才算。
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | line | block | str | tpl
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'") { mode = "str"; out += c; i += 1; continue; }
      if (c === "`") { mode = "tpl"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += "\n"; } else { out += " "; }
      i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1; continue;
    }
    // 字符串 / 模板字符串：原样保留，处理转义
    out += c;
    if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
    if ((mode === "str" && (c === '"' || c === "'")) || (mode === "tpl" && c === "`")) mode = "code";
    i += 1;
  }
  return out;
}

const hkCode = stripComments(assigneeSrc);

/* ══════════════════════════════════════════════════════════════════════
 * A. 静态校验
 * ══════════════════════════════════════════════════════════════════════ */
console.log("=== A. 静态校验 ===");

/* A1. cleanupExpiredSessions 导出与实现 */
check(
  "session.ts 导出 cleanupExpiredSessions(): number",
  /export\s+function\s+cleanupExpiredSessions\s*\(\s*\)\s*:\s*number/.test(src)
);
check(
  "清理 SQL 是 DELETE FROM sessions WHERE expires_at < ?",
  /DELETE\s+FROM\s+sessions\s+WHERE\s+expires_at\s*<\s*\?/i.test(src)
);
check("清理用 nowIso() 取当前时间", /cleanupExpiredSessions[\s\S]{0,300}nowIso\(\)/.test(src));
check("清理函数返回删除条数（changes）", /cleanupExpiredSessions[\s\S]{0,400}return\s+\w+\.changes/.test(src));

/* A2. 登录接口：不再裸查 username；有 hotel_code 过滤 + 多行判定 + 登录时清理 */
const loginNoComment = stripComments(loginSrc);
check("登录 SQL 先按 username 查全部匹配行（用 all() 而不是只取一行）", /all<[^>]+>\(\s*`SELECT[\s\S]*WHERE\s+u\.username\s*=\s*\?/.test(loginNoComment));
check(
  "登录 SQL 填了酒店标识时按 hotels.code / hotel_id 过滤",
  /hotel_code/.test(loginNoComment) && /h\.code\s+COLLATE\s+NOCASE\s*=\s*\?/.test(loginNoComment) && /CAST\(h\.id\s+AS\s+TEXT\)\s*=\s*\?/.test(loginNoComment)
);
check(
  "多店重复时有明确分支（rows.length > 1）",
  /rows\.length\s*>\s*1/.test(loginNoComment) && /账号在多店重复/.test(loginSrc)
);
check("登录页会显示「账号在多店重复，请补充酒店标识」", /error=dup/.test(loginNoComment) && /dupError/.test(loginPageSrc));
const iInsert = loginNoComment.indexOf("INSERT INTO sessions");
const iCleanupCall = loginNoComment.indexOf("cleanupExpiredSessions()");
check(
  "登录写 session 之后调用 cleanupExpiredSessions()",
  iInsert >= 0 && iCleanupCall > iInsert
);
/* A2b. 原有安全约束没被破坏 */
check("登录失败仍统一「账号或密码不正确」（不暴露账号是否存在）", /账号或密码不正确/.test(loginSrc));
/*
 * 密码校验（整改指令 8.1/8.2 之后）
 *
 * 旧断言要求「保留明文升级逻辑」（isHashed + hashPassword(明文)），
 * 但整改指令 8.2 明确要求「删除登录时的明文密码回退逻辑」——
 * 现在密码只在 password_hash 里，用 verifyPassword 校验，不再有任何明文分支。
 */
check(
  "登录只读 password_hash 并用 verifyPassword 校验",
  /password_hash/.test(loginSrc) && /verifyPassword\s*\(/.test(loginSrc)
);
check(
  "登录没有任何明文密码比较或自动升级分支",
  !/hashPassword\s*\(/.test(loginSrc) && !/password\s*===\s*(?:password|u\.password|user\.password)/.test(loginSrc)
);
check("旧 pms_user Cookie 仍被清掉", /pms_user/.test(loginSrc) && /maxAge:\s*0/.test(loginSrc));

/* A3. 登录页可选酒店标识输入框 */
check("登录页有可选输入框 name=\"hotel_code\"", /name=["']hotel_code["']/.test(loginPageSrc));
check("登录页标签写明「酒店标识（多店部署时填写，单店留空）」", /酒店标识（多店部署时填写，单店留空）/.test(loginPageSrc));

/* A4. 夜审：加了一次清理，且既有逻辑全部保留 */
const nightNoComment = stripComments(nightSrc);
check("夜审调用 cleanupExpiredSessions()", /cleanupExpiredSessions\(\)/.test(nightNoComment));
check("夜审仍校验 night_audit.run", /requirePermission\(\s*"night_audit\.run"\s*\)/.test(nightSrc));
check("夜审仍用 bizToday(user.hotelId) 取营业日", /bizToday\(\s*user\.hotelId\s*\)/.test(nightSrc));
check("夜审仍调 recalcFolioBalance(hotelId, folio.id)", /recalcFolioBalance\(\s*hotelId\s*,\s*folio\.id\s*\)/.test(nightSrc));
check("NOSHOW 判定仍是 check_in_date < ?", /check_in_date\s*<\s*\?/.test(nightSrc));
check("NOSHOW 仍清房 room_id = NULL", /status\s*=\s*'NOSHOW'[\s\S]{0,140}room_id\s*=\s*NULL/.test(nightSrc));
check("NOSHOW 明细仍置 CANCELLED", /booking_rooms\s+SET\s+status\s*=\s*'CANCELLED'/.test(nightSrc));
check(
  "营收分列列（房费/餐饮/其他/退款/净收入）仍写入",
  /revenue_room/.test(nightSrc) && /revenue_food/.test(nightSrc) && /revenue_other/.test(nightSrc) && /refund_total/.test(nightSrc) && /revenue_net/.test(nightSrc)
);

/* A5. 迁移脚本加了 sessions 索引 */
check(
  "migrate-all.mjs 含 idx_sessions_expires 的建索引语句",
  /idx_sessions_expires/.test(migrateSrc) && /CREATE INDEX idx_sessions_expires ON sessions\(expires_at\)/.test(migrateSrc)
);
check("迁移脚本对 sessions 表不存在做了保护", /hasTable\("sessions"\)/.test(migrateSrc));

/* A6. 派单硬编码已替换 */
check("housekeeping-assignee.ts 已创建且导出 pickHousekeepingAssignee", /export\s+function\s+pickHousekeepingAssignee\s*\(/.test(assigneeSrc));
check(
  "指派实现按 hotel_id + role='housekeeping' + status=1 取人",
  /FROM\s+users[\s\S]{0,200}role\s*=\s*'housekeeping'[\s\S]{0,100}status\s*=\s*1/i.test(hkCode)
);
check("无人可派时返回「待分配」而不是空串", /HOUSEKEEPING_UNASSIGNED\s*=\s*"待分配"/.test(hkCode) && /待分配/.test(assigneeSrc));
check("cashier/actions.ts 退房打扫改用 pickHousekeepingAssignee(user.hotelId)", /pickHousekeepingAssignee\(user\.hotelId\)/.test(cashierSrc));
check("inhouse/actions.ts 取消入住打扫改用 pickHousekeepingAssignee(user.hotelId)", /pickHousekeepingAssignee\(user\.hotelId\)/.test(inhouseSrc));
check("两处都 import 了 pickHousekeepingAssignee", /from\s+"@\/lib\/housekeeping-assignee"/.test(cashierSrc) && /from\s+"@\/lib\/housekeeping-assignee"/.test(inhouseSrc));
check("报修默认「工程部」保留（不是打扫员，不在本次替换范围）", /"工程部"/.test(hkActionsSrc));

/* ══════════════════════════════════════════════════════════════════════
 * B. 硬编码扫描：「赵阿姨」写进 housekeeping 指派必须 0 处
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n=== B. 硬编码扫描 ===");

const ROOT = join(process.cwd(), "src");
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 打扫员名册种子的例外：cleaners 页面用「赵阿姨/钱阿姨/孙阿姨」生成演示名册与业绩 */
const SEED_WHITELIST = new Set([join("src", "app", "(main)", "cleaners", "page.tsx")]);

const hits = [];
const assignHits = [];
for (const file of walk(ROOT)) {
  const raw = read(file);
  if (!raw.includes("赵阿姨")) continue;
  const code = stripComments(raw);
  const rawLines = raw.split("\n");
  const codeLines = code.split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    if (!rawLines[i].includes("赵阿姨")) continue;
    const inCode = (codeLines[i] ?? "").includes("赵阿姨");
    const rel = file.replace(process.cwd() + "\\", "").replace(/\\/g, "/");
    const relPosix = join("src", ...rel.split("/").filter((s) => s !== "src"));
    const kind = !inCode ? "注释" : SEED_WHITELIST.has(relPosix) ? "名册种子数据" : "运行时代码";
    hits.push({ file: rel, line: i + 1, kind });
    if (inCode) {
      /* 同一行或前后 3 行内出现 housekeeping 的 INSERT / assignee 赋值 → 视为指派硬编码 */
      const window = codeLines.slice(Math.max(0, i - 3), i + 4).join("\n");
      if (/INSERT\s+INTO\s+housekeeping|assignee\s*[:=]/i.test(window)) {
        assignHits.push({ file: rel, line: i + 1 });
      }
    }
  }
}

const runtimeHits = hits.filter((h) => h.kind === "运行时代码");
check("src 中「赵阿姨」作为运行时指派/写库代码为 0 处", assignHits.length === 0, JSON.stringify(assignHits));
check(
  "src 中除 cleaners 名册种子外没有「赵阿姨」运行时代码",
  runtimeHits.length === 0,
  JSON.stringify(runtimeHits)
);

console.log("  扫描到「赵阿姨」的位置（全部，供人工复核）：");
for (const h of hits) console.log(`    - ${h.file}:${h.line}（${h.kind}）`);
const scriptsHits = [];
for (const name of readdirSync(join(process.cwd(), "scripts"))) {
  if (!name.endsWith(".mjs")) continue;
  /* 本脚本自身要写出被检查的关键词，排除掉，否则清单里全是自己 */
  if (name === "test-session-hk.mjs") continue;
  const p = join("scripts", name);
  const lines = read(p).split("\n");
  lines.forEach((line, i) => {
    if (line.includes("赵阿姨")) scriptsHits.push({ file: `scripts/${name}`, line: i + 1 });
  });
}
if (scriptsHits.length > 0) {
  console.log("    （scripts/ 下仅演示种子 / 测试构造数据，不属于运行时派单，未改动）");
  for (const h of scriptsHits) console.log(`    - ${h.file}:${h.line}`);
}

/* ══════════════════════════════════════════════════════════════════════
 * C. 真实库：索引 + pickHousekeepingAssignee 真跑
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n=== C. 真实库校验 ===");

const dbPath = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(dbPath);

const sessionCols = db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
check("sessions 表有 expires_at 列", sessionCols.includes("expires_at"));
const sessionIdx = db.prepare(`PRAGMA index_list(sessions)`).all().map((r) => r.name);
check("sessions 表已建 idx_sessions_expires 索引", sessionIdx.includes("idx_sessions_expires"), String(sessionIdx));
const totalSessions = db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get().c;
const expiredSessions = db
  .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE expires_at < ?`)
  .get(new Date().toISOString()).c;
console.log(`  sessions 现有 ${totalSessions} 行，其中已过期 ${expiredSessions} 行（登录 / 夜审时会清掉）`);

/*
 * 真跑 pickHousekeepingAssignee：把 TS 源码用 TypeScript 转译成 CommonJS 落到
 * data/ 下的临时目录再 require（不引入新依赖，也不改 src）。
 * db.ts 用 process.cwd() 定位 data/pms.db，所以脚本必须在项目根目录执行。
 */
const tmpDir = join(process.cwd(), "data", ".tmp-hk-assignee");
const requireCjs = createRequire(import.meta.url);
let pickHousekeepingAssignee = null;
let loadError = "";
try {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const compile = (file, outName) => {
    const js = ts.transpileModule(read(file), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      fileName: file,
    }).outputText;
    const out = join(tmpDir, outName);
    writeFileSync(out, js, "utf8");
    return out;
  };
  compile(join("src", "lib", "db.ts"), "db.js");
  const assigneeOut = compile(join("src", "lib", "housekeeping-assignee.ts"), "housekeeping-assignee.js");
  const mod = requireCjs(assigneeOut);
  pickHousekeepingAssignee = mod.pickHousekeepingAssignee;
} catch (e) {
  loadError = e instanceof Error ? e.message : String(e);
}

check("pickHousekeepingAssignee 可被真实加载执行", typeof pickHousekeepingAssignee === "function", loadError);

if (typeof pickHousekeepingAssignee === "function") {
  /* 真实酒店：期望值从库里现查，避免把某个姓名写死在验收脚本里 */
  const hotel = db.prepare(`SELECT id, name FROM hotels ORDER BY id LIMIT 1`).get();
  if (hotel) {
    const row = db
      .prepare(
        `SELECT real_name FROM users
          WHERE hotel_id = ? AND role = 'housekeeping' AND status = 1
          ORDER BY id LIMIT 1`
      )
      .get(hotel.id);
    const expected = (row?.real_name ?? "").trim() || "待分配";
    const got = pickHousekeepingAssignee(hotel.id);
    check(
      `有在岗客房人员时返回其姓名（hotel ${hotel.id} → ${expected}）`,
      got === expected,
      `返回 ${JSON.stringify(got)}`
    );
  } else {
    check("真实库存在酒店，可验证派单", false, "hotels 表为空");
  }

  /* 没有在岗客房人员的酒店：用不存在的 ID 模拟，不污染真实数据 */
  const ghostHotelId = 900000 + Math.floor(Math.random() * 1000);
  const ghostName = pickHousekeepingAssignee(ghostHotelId);
  check(`没有在岗客房人员时返回「待分配」（hotel ${ghostHotelId}）`, ghostName === "待分配", `返回 ${JSON.stringify(ghostName)}`);
  check(
    "非法 hotelId 也兜底为「待分配」（0 / NaN）",
    pickHousekeepingAssignee(0) === "待分配" && pickHousekeepingAssignee(Number.NaN) === "待分配"
  );

  /* 返回的是「本店的人」，不是全局第一个人：用另一个店的 ID 验证不会串店 */
  const usersHotelIds = db.prepare(`SELECT DISTINCT hotel_id FROM users`).all().map((r) => r.hotel_id);
  if (usersHotelIds.length >= 1) {
    const noHkHotel = String(ghostHotelId);
    check(
      "按 hotel_id 隔离：不存在的店不会取到别店的客房人员",
      pickHousekeepingAssignee(Number(noHkHotel)) === "待分配"
    );
  }
}

rmSync(tmpDir, { recursive: true, force: true });
db.close();

/* ══════════════════════════════════════════════════════════════════════
 * D. 内存库：清理 SQL 的语义（只删过期，不误删未过期 / NULL）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n=== D. 清理 SQL 语义 ===");

const delSql = /DELETE\s+FROM\s+sessions\s+WHERE\s+expires_at\s*<\s*\?/.exec(src)?.[0] ?? "";
check("能从源码中取出清理 SQL 语句", delSql.startsWith("DELETE FROM sessions"));

const mem = new DatabaseSync(":memory:");
mem.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_json TEXT, created_at TEXT, expires_at TEXT)`);
const now = new Date().toISOString();
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const ins = mem.prepare(`INSERT INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`);
ins.run("expired-1", "{}", past, past);
ins.run("expired-2", "{}", past, past);
ins.run("alive-1", "{}", now, future);
ins.run("no-expiry", "{}", now, null);
const delResult = mem.prepare(delSql).run(now);
const left = mem.prepare(`SELECT id FROM sessions ORDER BY id`).all().map((r) => r.id);
check("清理删除 2 条已过期会话", delResult.changes === 2, `changes=${delResult.changes}`);
check("未过期会话保留", left.includes("alive-1"));
check("expires_at 为 NULL 的旧行不会被 SQL 误删（NULL 比较为 NULL）", left.includes("no-expiry"));
mem.close();

/* ══════════════════════════════════════════════════════════════════════
 * 汇总
 * ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 存在失败项"}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
