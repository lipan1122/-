#!/usr/bin/env node
/**
 * 会员模块 Server Action 权限 + 数据校验验收（第六轮清单 一.7）
 *
 * ── 清单要求（原文 §一.7）──
 *   · 新增、修改、导入会员使用 guest.modify 或 member.manage
 *   · 会员等级变更必须有 member.manage
 *   · 会员取消必须二次确认
 *   · 会员导入必须校验文件大小、列格式、重复身份证和手机号
 *   · 自动升级必须按配置规则执行并记录原因
 *   · 会员敏感信息仍需 member.view_sensitive
 *   · 不得通过姓名误改同名客史
 *
 * ── 本脚本怎么验（真库副本，零污染）──
 *   1. 用 `VACUUM INTO` 把 data/pms.db 复制到 .tmp/member-permissions-<时间戳>/data/pms.db，
 *      本进程打开副本并注入 `globalThis.__pmsDb` —— src/lib/db.ts 的 getDb() 优先返回它，
 *      所以**执行的是仓库里那份真实 action 代码**，写的却是副本库，真库一个字节都不动。
 *   2. 用 `node:module` 的 registerHooks 把 `next/headers`、`next/navigation`、`next/cache`
 *      换成最小桩（cookies()/redirect()/revalidatePath()），再直接 import 真实的
 *      `src/lib/session.ts` 与 `src/app/(main)/members/actions.ts`。
 *   3. 给 4 个岗位各造一条真实 sessions 行，通过切换桩里的 sid 以不同角色调用 action，
 *      断言「谁被拒 / 谁被放行」——这是跑源码，不是 grep 源码。
 *   4. 数据层断言：重复手机号/身份证整单拒绝、超大文件拒绝、列格式拒绝、
 *      同名客史不被误改、取消会员无原因被拒、自动升级只升不降且写原因。
 *
 * 用法：node scripts/test-member-permissions.mjs
 *      PMS_DB_PATH=... 可指向别的真库（默认项目内 data/pms.db）
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
const TAG = "member-permissions";
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

/* ============================================================ 0. 副本库 */

if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs）`);

/** 真库只读统计，收尾复查「真库零写入」 */
function realDbCounts() {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const one = (sql) => db.prepare(sql).get()?.c ?? 0;
    return {
      guests: one(`SELECT COUNT(*) AS c FROM guests`),
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

/* ============================================================ 1. 会话 + 模块装载 */

/**
 * next/* 最小桩：
 *   cookies() 只实现 session.ts 用到的 get()，sid 由 setSid 切换；
 *   redirect() 抛 NEXT_REDIRECT（与 Next 内部机制一致，action 里的回跳都能被捕获）；
 *   revalidatePath() 无操作。
 */
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

/* 生产代码读的库 = 副本库（db.ts 的 getDb() 优先返回 globalThis.__pmsDb） */
globalThis.__pmsDb = conn;

let session;
let members;
let stub;
try {
  session = await import("../src/lib/session.ts");
  members = await import("../src/app/(main)/members/actions.ts");
  stub = await import(stubUrl);
} catch (e) {
  abandon("装载 src/lib/session.ts 或 members/actions.ts 失败", String(e?.stack ?? e?.message ?? e));
}

const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();

/* 4 个岗位的验收会话（真实 sessions 行，复用真实 getSession/requirePermission 链路） */
const users = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
const sidOf = {};
for (const u of users) {
  const sid = `test-member-${u.role}-${STAMP}`;
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
}
check(
  "4 个岗位各有 1 条验收会话（admin / frontdesk / cashier / housekeeping）",
  ["admin", "frontdesk", "cashier", "housekeeping"].every((r) => !!sidOf[r]),
  Object.keys(sidOf).join(",")
);

/* 跨酒店账号：admin@999（权限有，但数据不属于他） */
run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [
  HOTEL_B,
  `TB${STAMP}`.slice(0, 20),
  "验收酒店B",
  NOW,
]);
run(
  `INSERT OR IGNORE INTO users (id, hotel_id, username, password, real_name, role, status)
   VALUES (?,?,?,?,?,?,?)`,
  [90001, HOTEL_B, `testadmin_b_${STAMP}`, "x", "B店管理员", "admin", 1]
);
const sidB = `test-member-hotelB-${STAMP}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  sidB,
  JSON.stringify({ id: 90001, username: `testadmin_b_${STAMP}`, realName: "B店管理员", role: "admin", hotelId: HOTEL_B, hotelName: "验收酒店B" }),
  NOW,
  EXPIRES,
]);
sidOf["admin@999"] = sidB;

/* ============================================================ 调用工具 */

const fd = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.append(k, v);
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

/** 以某个会话身份执行一次 action，把 redirect / 抛错 都收敛成结构体 */
async function as(role, fn) {
  stub.setSid(sidOf[role]);
  try {
    const value = await fn();
    return { status: "resolved", value };
  } catch (e) {
    const message = String((e && e.message) || e);
    if (message.startsWith("NEXT_REDIRECT:")) {
      return { status: "redirect", url: message.slice("NEXT_REDIRECT:".length), message: "" };
    }
    return { status: "throw", message };
  }
}

const like = (s, ...parts) => parts.every((p) => String(s).includes(p));

/* 测试会员 / 手机号（唯一，避免撞真库数据的唯一索引） */
const base8 = String(STAMP).slice(-8);
const mkMobile = (i) => `139${base8}${String(i).padStart(2, "0")}`;
const nameOf = (tag) => `测试会员${tag}${String(STAMP).slice(-4)}`;

const guestById = (id) => one(`SELECT * FROM guests WHERE id = ? AND hotel_id = ?`, [id, HOTEL]);
const opLogs = (action) =>
  all(`SELECT * FROM op_logs WHERE hotel_id = ? AND action = ? ORDER BY id DESC`, [HOTEL, action]);
const guestCount = () => one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ?`, [HOTEL]).c;

/* ============================================================ 2. 权限点与种子 */

section("2. 权限点 member.manage：常量 / 迁移 / 库三处一致");

const sessionSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "session.ts"), "utf8");
const migrateSrc = fs.readFileSync(path.join(ROOT, "scripts", "migrate-all.mjs"), "utf8");
const membersSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "members", "actions.ts"), "utf8");

check("session.ts 的 PERMISSIONS 里有 member.manage", /"member\.manage"\s*:\s*\["admin",\s*"frontdesk"\]/.test(sessionSrc));
check("migrate-all.mjs 的 RBAC_PERMISSIONS 同步了 member.manage", /"member\.manage": \["admin", "frontdesk"\]/.test(migrateSrc));
check("migrate-all.mjs 的权限字典同步了 member.manage", /permission: "member\.manage"/.test(migrateSrc));

const permRows = all(`SELECT role FROM role_permissions WHERE hotel_id = ? AND permission = 'member.manage'`, [HOTEL]).map(
  (r) => r.role
);
check("role_permissions 里 admin 有 member.manage", permRows.includes("admin"), permRows.join(","));
check("role_permissions 里 frontdesk 有 member.manage", permRows.includes("frontdesk"), permRows.join(","));
check("role_permissions 里 cashier 没有 member.manage", !permRows.includes("cashier"));
check("role_permissions 里 housekeeping 没有 member.manage", !permRows.includes("housekeeping"));
check(
  "permission_dict 里有 member.manage（设置页权限矩阵能勾选）",
  !!one(`SELECT permission FROM permission_dict WHERE permission = 'member.manage'`)
);
check(
  "hasPermission(frontdesk, member.manage) = true",
  session.hasPermission("frontdesk", "member.manage", HOTEL) === true
);
check(
  "hasPermission(housekeeping, member.manage) = false",
  session.hasPermission("housekeeping", "member.manage", HOTEL) === false
);

section("2b. 源码守卫：每个写操作都在写库之前校验权限");

const exportedFns = [...membersSrc.matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
const EXPECT = {
  createMemberAction: "guest.modify",
  upgradeMemberAction: "member.manage",
  cancelMemberAction: "guest.modify",
  saveUpgradeRulesAction: "settings.manage",
  applyUpgradeAction: "member.manage",
  autoUpgradeMembersAction: "member.manage",
  importMembersAction: "guest.modify",
};
check(
  `导出 action 与期望表一致（${exportedFns.length} 个）`,
  exportedFns.length === Object.keys(EXPECT).length && Object.keys(EXPECT).every((n) => exportedFns.includes(n)),
  exportedFns.join(",")
);
for (const [name, permission] of Object.entries(EXPECT)) {
  const i = membersSrc.indexOf(`export async function ${name}(`);
  const j = membersSrc.indexOf("\nexport ", i + 10);
  const body = membersSrc.slice(i, j < 0 ? membersSrc.length : j);
  const permAt = body.indexOf(`requirePermission("${permission}")`);
  const firstMutate = Math.min(
    ...[
      body.search(/\brun\s*\(/),
      body.search(/\btx\s*\(/),
      body.search(/\bINSERT\s+INTO\b/i),
      body.search(/\bUPDATE\s+\w+\s+SET\b/i),
      body.search(/\bDELETE\s+FROM\b/i),
    ].filter((n) => n >= 0)
  );
  check(
    `${name} 守卫是 requirePermission("${permission}") 且早于任何写库`,
    permAt >= 0 && (Number.isNaN(firstMutate) || permAt < firstMutate),
    `perm@${permAt} mutate@${Number.isNaN(firstMutate) ? "-" : firstMutate}`
  );
}
/** 源码去掉注释后再做静态断言（注释里会提到 requireUser()，不能当成残留） */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const membersCode = stripComments(membersSrc);

check("members/actions.ts 里没有残留 requireUser()", (membersCode.match(/requireUser\s*\(/g) || []).length === 0);

/* 不得按姓名定位要写的那条客史：guests 的 UPDATE 必须按 id + hotel_id */
const guestUpdates = [...membersCode.matchAll(/`UPDATE guests[\s\S]*?`/g)].map((m) => m[0].replace(/\s+/g, " "));
check(
  `guests 的 UPDATE 全部按 id + hotel_id 定位（共 ${guestUpdates.length} 条）`,
  guestUpdates.length >= 4 && guestUpdates.every((sql) => /WHERE id = \? AND hotel_id = \?/.test(sql)),
  guestUpdates.join(" | ").slice(0, 240)
);
check(
  "没有任何 `UPDATE … WHERE … name = ?` 的按姓名改档语句",
  !/UPDATE\s+guests[\s\S]*?WHERE[^`]*name\s*=\s*\?/i.test(membersCode)
);
check(
  "导入/新增不再用姓名做身份判定（无 `WHERE … name = ?` 的定位语句）",
  !/WHERE\s+hotel_id\s*=\s*\?\s+AND\s+name\s*=\s*\?/i.test(membersSrc)
);

/* 页面侧：取消会员必须走 ConfirmForm 二次确认；升级不再由前端传 target */
const membersPageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "(main)", "members", "page.tsx"), "utf8");
check(
  "members/page.tsx 用 ConfirmForm 包裹取消会员（弹窗 + 原因必填）",
  /<ConfirmForm[\s\S]{0,420}action=\{cancelMemberAction\}/.test(membersPageSrc) &&
    /requireReason="取消原因"/.test(membersPageSrc)
);
check(
  "取消会员不再是裸表单（没有任何 <form action={cancelMemberAction}>）",
  !/<form[^>]*action=\{cancelMemberAction\}/.test(membersPageSrc)
);
check(
  "批量自动升级入口由 ConfirmForm 二次确认",
  /<ConfirmForm[\s\S]{0,420}action=\{autoUpgradeMembersAction\}/.test(membersPageSrc)
);
check(
  "applyUpgradeAction 表单不再提交前端 target / target_level（服务端按规则算）",
  !/name="target_level"/.test(membersPageSrc) && !/name="target"/.test(membersPageSrc)
);
check(
  "升级规则保存按钮按 settings.manage 隐藏（非 admin 岗位只读）",
  /canManageSettings \?/.test(membersPageSrc) && /hasPermission\(user\.role, "settings\.manage"/.test(membersPageSrc)
);

/* ============================================================ 3. createMemberAction */

section("3. createMemberAction：guest.modify，housekeeper / cashier 被拒");

const beforeCreate = guestCount();
const createFd = () => fd({ name: nameOf("新建"), mobile: mkMobile(1), vip_level: "2" });

let r = await as("housekeeping", () => members.createMemberAction(createFd()));
check("housekeeper 新增会员被拒（FORBIDDEN guest.modify）", isDenied(r, "guest.modify"), r.message);
r = await as("cashier", () => members.createMemberAction(createFd()));
check("cashier 新增会员被拒（FORBIDDEN guest.modify）", isDenied(r, "guest.modify"), r.message);
check("被拒的请求没有建出会员", guestCount() === beforeCreate);

r = await as("frontdesk", () => members.createMemberAction(createFd()));
check(
  "frontdesk 新增会员放行",
  r.status === "resolved",
  `${r.status} ${r.message ?? ""}`
);
const created = one(`SELECT * FROM guests WHERE hotel_id = ? AND mobile = ?`, [HOTEL, mkMobile(1)]);
check("会员已落库且带 hotel_id / vip_level", !!created && created.hotel_id === HOTEL && Number(created.vip_level) === 2);
check("新增会员写了 op_logs（新增会员）", opLogs("新增会员").some((l) => like(l.detail, nameOf("新建"))));

/* 同一手机号再来一次：不重复建档；抬高等级要 member.manage（这里两个角色都有，只验不重复建档） */
r = await as("admin", () => members.createMemberAction(fd({ name: "手机号重复", mobile: mkMobile(1), vip_level: "3" })));
check(
  "同手机号再次新增不重复建档，按手机号抬等级",
  guestCount() === beforeCreate + 1 &&
    Number(guestById(created.id).vip_level) === 3 &&
    r.status === "resolved",
  `count=${guestCount()} level=${guestById(created.id).vip_level}`
);

/* ============================================================ 4. 等级变更 / 取消 */

section("4. 等级变更：member.manage；取消会员：二次确认（原因必填）");

run(
  `INSERT INTO guests (hotel_id, name, mobile, vip_level, blacklist, created_at) VALUES (?,?,?,?,0,?)`,
  [HOTEL, nameOf("甲"), mkMobile(2), 1, NOW]
);
const guestA = one(`SELECT * FROM guests WHERE hotel_id = ? AND mobile = ?`, [HOTEL, mkMobile(2)]);

r = await as("housekeeping", () => members.upgradeMemberAction(fd({ id: String(guestA.id) })));
check("housekeeper 升级会员被拒（FORBIDDEN member.manage）", isDenied(r, "member.manage"), r.message);
check("被拒后等级没变（VIP1）", Number(guestById(guestA.id).vip_level) === 1);

r = await as("cashier", () => members.upgradeMemberAction(fd({ id: String(guestA.id) })));
check("cashier 升级会员被拒（FORBIDDEN member.manage）", isDenied(r, "member.manage"), r.message);

r = await as("frontdesk", () => members.upgradeMemberAction(fd({ id: String(guestA.id) })));
check("frontdesk 升级会员放行", r.status === "resolved", `${r.status} ${r.message ?? ""}`);
check("等级已 VIP1 → VIP2", Number(guestById(guestA.id).vip_level) === 2);
check(
  "升级写了 op_logs（含 VIP1 → VIP2）",
  opLogs("会员升级").some((l) => like(l.detail, nameOf("甲"), "VIP1 → VIP2"))
);

r = await as("housekeeping", () => members.cancelMemberAction(fd({ id: String(guestA.id), reason: "测试" })));
check("housekeeper 取消会员被拒（FORBIDDEN guest.modify）", isDenied(r, "guest.modify"), r.message);

r = await as("frontdesk", () => members.cancelMemberAction(fd({ id: String(guestA.id) })));
const noReason = flashOf(r);
check(
  "取消会员不填原因被拒（服务端二次确认兜底）",
  r.status === "redirect" && noReason.type === "err" && like(noReason.text, "原因", "二次确认"),
  `${r.status} ${r.status === "redirect" ? r.url : r.message}`
);
check("无原因的取消没有改动等级", Number(guestById(guestA.id).vip_level) === 2);

r = await as("frontdesk", () => members.cancelMemberAction(fd({ id: String(guestA.id), reason: "客人主动退会" })));
check("取消会员（带原因）放行", r.status === "redirect" && flashOf(r).type === "msg", `${r.status} ${r.url ?? r.message}`);
check("等级已归零、客史保留", Number(guestById(guestA.id).vip_level) === 0 && !!guestById(guestA.id));
const cancelLog = opLogs("取消会员")[0];
check(
  "op_logs 记了取消原因 / 操作人 / 原等级",
  !!cancelLog && like(cancelLog.detail, "原因：客人主动退会", "VIP2 → 非会员") && cancelLog.operator.length > 0,
  cancelLog ? cancelLog.detail : "无日志"
);

/* 跨酒店：B 店 admin 改不动 1 号店的会员 */
r = await as("admin@999", () => members.cancelMemberAction(fd({ id: String(created.id), reason: "越权" })));
check(
  "跨酒店取消会员被拒（查不到该会员）",
  r.status === "redirect" && flashOf(r).type === "err",
  `${r.status} ${r.url ?? r.message}`
);
check("跨酒店请求没有改动目标会员", Number(guestById(created.id).vip_level) === 3);

/* ============================================================ 5. 自动升级（规则） */

section("5. 升级规则：applyUpgradeAction / autoUpgradeMembersAction 按 settings 规则执行");

/* 规则落库（默认与页面一致：累计消费 3000 → VIP2，10000 → VIP3） */
run(`INSERT OR REPLACE INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [
  HOTEL,
  "member_upgrade_rules",
  JSON.stringify({
    basis: "spend",
    levels: [
      { level: 1, minSpend: 0, minStays: 0, discount: 1, pointsRate: 1 },
      { level: 2, minSpend: 3000, minStays: 5, discount: 0.95, pointsRate: 1.5 },
      { level: 3, minSpend: 10000, minStays: 15, discount: 0.9, pointsRate: 2 },
    ],
  }),
]);

const roomId = one(`SELECT id FROM rooms WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL])?.id ?? 1;

/** 造一位会员 + 一笔消费，用来验证「按规则升级」 */
function makeMemberWithSpend(tag, spend, vip, mobileNo) {
  run(`INSERT INTO guests (hotel_id, name, mobile, vip_level, blacklist, created_at) VALUES (?,?,?,?,0,?)`, [
    HOTEL,
    nameOf(tag),
    mkMobile(mobileNo),
    vip,
    NOW,
  ]);
  const g = one(`SELECT * FROM guests WHERE hotel_id = ? AND name = ? ORDER BY id DESC LIMIT 1`, [HOTEL, nameOf(tag)]);
  run(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, rate, check_in_time, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `TEST-STAY-${tag}-${STAMP}`, roomId, g.id, g.name, 0, NOW, "CHECKED_OUT", NOW]
  );
  const stay = one(`SELECT id FROM stays WHERE hotel_id = ? AND stay_no = ?`, [HOTEL, `TEST-STAY-${tag}-${STAMP}`]);
  run(
    `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `TEST-FOLIO-${tag}-${STAMP}`, stay.id, g.name, spend, 0, spend, "OPEN", NOW]
  );
  const folio = one(`SELECT id FROM folios WHERE hotel_id = ? AND folio_no = ?`, [HOTEL, `TEST-FOLIO-${tag}-${STAMP}`]);
  run(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [HOTEL, folio.id, "ROOM", "验收房费", 1, spend, spend, NOW.slice(0, 10), NOW]
  );
  return g;
}

const guestB = makeMemberWithSpend("乙", 20000, 1, 40); // 累计消费 20000 → 应得 VIP3
const guestC = makeMemberWithSpend("丙", 0, 1, 41); // 无消费 → 应得 VIP1
const guestD = makeMemberWithSpend("丁", 5000, 1, 42); // 5000 → 应得 VIP2
const guestE = makeMemberWithSpend("戊", 0, 3, 43); // 已是 VIP3，不许被降级

r = await as("housekeeping", () => members.applyUpgradeAction(fd({ id: String(guestB.id) })));
check("housekeeper 单条升级被拒（FORBIDDEN member.manage）", isDenied(r, "member.manage"), r.message);
check("被拒后 VIP2 门槛也没动（仍是 VIP1）", Number(guestById(guestB.id).vip_level) === 1);

/* 前端伪造 target=3：服务端必须按规则重算，丙（无消费）不能被抬成 VIP3 */
r = await as("frontdesk", () => members.applyUpgradeAction(fd({ id: String(guestC.id), target: "3", target_level: "3" })));
check(
  "伪造 target=3 不生效：未达门槛的会员被拒",
  r.status === "redirect" && flashOf(r).type === "err" && Number(guestById(guestC.id).vip_level) === 1,
  `${r.status} ${r.url ?? r.message}`
);

r = await as("frontdesk", () => members.applyUpgradeAction(fd({ id: String(guestB.id), target: "1" })));
check(
  "伪造 target=1 也不生效：按规则升到 VIP3（服务端算，不信前端）",
  Number(guestById(guestB.id).vip_level) === 3,
  `level=${guestById(guestB.id).vip_level}`
);
const ruleLog = opLogs("会员升级").find((l) => like(l.detail, nameOf("乙")));
check(
  "升级日志记录了规则依据（口径 + 实际值 + 门槛）",
  !!ruleLog && like(ruleLog.detail, "按规则", "累计消费", "≥ VIP3 门槛"),
  ruleLog ? ruleLog.detail : "无日志"
);

r = await as("housekeeping", () => members.autoUpgradeMembersAction());
check("housekeeper 批量自动升级被拒（FORBIDDEN member.manage）", isDenied(r, "member.manage"), r.message);

r = await as("frontdesk", () => members.autoUpgradeMembersAction());
const autoMsg = flashOf(r);
check(
  "frontdesk 批量自动升级放行并回报升级数量",
  r.status === "redirect" && autoMsg.type === "msg" && /自动升级完成：\d+ 位/.test(autoMsg.text),
  `${r.status} ${autoMsg.text || r.message}`
);
check("按规则把 5000 元消费的会员升到 VIP2", Number(guestById(guestD.id).vip_level) === 2);
check("VIP3 会员不被降级", Number(guestById(guestE.id).vip_level) === 3);
const autoLog = opLogs("会员自动升级")[0];
check(
  "自动升级逐会员写日志（含规则依据）",
  !!autoLog && like(autoLog.detail, "按规则", "VIP"),
  autoLog ? autoLog.detail : "无日志"
);
const autoBatchLog = opLogs("会员自动升级（批量）")[0];
check(
  "自动升级整批写日志（口径 + 人数）",
  !!autoBatchLog && like(autoBatchLog.detail, "按当前规则", "升级", "位"),
  autoBatchLog ? autoBatchLog.detail : "无日志"
);

r = await as("admin", () => members.autoUpgradeMembersAction());
check("admin 批量自动升级也放行", r.status === "redirect", `${r.status} ${r.message ?? ""}`);

r = await as("admin@999", () => members.autoUpgradeMembersAction());
check(
  "跨酒店账号批量自动升级不会碰 1 号店会员（本店无会员 → 提示无可升级）",
  r.status === "redirect" && /没有达到升级门槛/.test(flashOf(r).text),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("跨酒店运行后 1 号店会员等级未被二次改动", Number(guestById(guestB.id).vip_level) === 3);

/* ============================================================ 6. 导入校验 */

section("6. importMembersAction：文件大小 / 列格式 / 重复身份证与手机号");

const csvForm = (header, rows, fileName = "members.csv") => {
  const text = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const f = new FormData();
  f.append("file", new File([text], fileName, { type: "text/csv" }));
  return f;
};

r = await as("housekeeping", () => members.importMembersAction(csvForm(["姓名", "手机号"], [["导入甲", mkMobile(30)]])));
check("housekeeper 导入会员被拒（FORBIDDEN guest.modify）", isDenied(r, "guest.modify"), r.message);

const beforeImport = guestCount();

/* 6.1 超大文件：4MB + 1 字节（与 next.config.ts 的 serverActions.bodySizeLimit=4mb 对齐） */
{
  const big = new FormData();
  big.append("file", new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.csv", { type: "text/csv" }));
  r = await as("frontdesk", () => members.importMembersAction(big));
  const f = flashOf(r);
  check(
    "超过 4MB 的文件被拒（不进内存解析）",
    r.status === "redirect" && f.type === "err" && like(f.text, "超过 4MB 上限"),
    `${r.status} ${f.text || r.message}`
  );
  check("超大文件没有入库任何会员", guestCount() === beforeImport);
}

/* 6.2 列格式：表头没有「姓名」列 */
r = await as("frontdesk", () =>
  members.importMembersAction(csvForm(["序号", "手机号"], [["1", mkMobile(31)]]))
);
check(
  "表头缺「姓名」列被整单拒绝（列格式校验）",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "缺少「姓名」列"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("列格式不符时没有入库", guestCount() === beforeImport);

/* 6.3 文件内重复手机号 → 整单拒绝 */
r = await as("frontdesk", () =>
  members.importMembersAction(
    csvForm(["姓名", "手机号"], [["导入重复甲", mkMobile(32)], ["导入重复乙", mkMobile(32)]])
  )
);
check(
  "文件内重复手机号被整单拒绝",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "重复手机号", "导入已取消"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("重复手机号没有产生半截导入", guestCount() === beforeImport);

/* 6.4 文件内重复身份证 → 整单拒绝 */
r = await as("frontdesk", () =>
  members.importMembersAction(
    csvForm(
      ["姓名", "手机号", "身份证号"],
      [["导入证件甲", mkMobile(33), "330106199001011234"], ["导入证件乙", mkMobile(34), "330106199001011234"]]
    )
  )
);
check(
  "文件内重复身份证号被整单拒绝",
  r.status === "redirect" && flashOf(r).type === "err" && like(flashOf(r).text, "重复身份证号"),
  `${r.status} ${flashOf(r).text || r.message}`
);
check("重复身份证号没有产生半截导入", guestCount() === beforeImport);

/* 6.5 正常导入：同名不同手机号要新建（姓名不是身份），库里已有手机号跳过且不改原档 */
const guestBName = guestById(guestB.id).name;
r = await as("frontdesk", () =>
  members.importMembersAction(
    csvForm(
      ["姓名", "手机号", "会员等级", "备注"],
      [
        ["导入会员一" + String(STAMP).slice(-4), mkMobile(35), "VIP2", "验收导入"],
        [guestBName, mkMobile(36), "VIP1", "同名不同人"],
        ["改名尝试" + String(STAMP).slice(-4), mkMobile(2), "VIP3", "手机号已在档"],
      ]
    )
  )
);
const importMsg = flashOf(r);
check(
  "正常文件导入成功并回报新增 / 跳过数量",
  r.status === "redirect" && importMsg.type === "msg" && like(importMsg.text, "新增 2 条", "跳过 1 条"),
  `${r.status} ${importMsg.text || r.message}`
);
check(
  "同名不同手机号会新建档案（不按姓名判重）",
  !!one(`SELECT id FROM guests WHERE hotel_id = ? AND mobile = ?`, [HOTEL, mkMobile(36)])
);
check(
  "库里已有手机号被跳过（没有给「改名尝试」建档，原档仍是甲）",
  one(`SELECT name FROM guests WHERE hotel_id = ? AND mobile = ?`, [HOTEL, mkMobile(2)])?.name === nameOf("甲")
);
const guestBAfter = guestById(guestB.id);
check(
  "判重命中时原档一字未动（不得借导入误改客史）",
  guestBAfter.name === guestBName && Number(guestBAfter.vip_level) === 3,
  `name=${guestBAfter.name} level=${guestBAfter.vip_level}`
);
check(
  "导入会员的等级按 CSV 落库（VIP2）",
  Number(one(`SELECT vip_level FROM guests WHERE hotel_id = ? AND mobile = ?`, [HOTEL, mkMobile(35)]).vip_level) === 2
);
check(
  "导入写了 op_logs（含新增 / 跳过条数）",
  opLogs("会员导入").some((l) => like(l.detail, "新增 2 条", "跳过 1 条"))
);

/* 6.6 敏感信息：没有 member.view_sensitive 时，错误文案里的手机号必须脱敏 */
run(`DELETE FROM role_permissions WHERE hotel_id = ? AND role = 'frontdesk' AND permission = 'member.view_sensitive'`, [HOTEL]);
session.invalidatePermissionCache(HOTEL);
check(
  "临时收回 frontdesk 的 member.view_sensitive（模拟权限矩阵收紧）",
  session.hasPermission("frontdesk", "member.view_sensitive", HOTEL) === false
);
r = await as("frontdesk", () =>
  members.importMembersAction(
    csvForm(["姓名", "手机号"], [["脱敏甲", mkMobile(37)], ["脱敏乙", mkMobile(37)]])
  )
);
const maskedMsg = flashOf(r).text;
check(
  "重复手机号报错里手机号已脱敏（member.view_sensitive 生效）",
  like(maskedMsg, "****") && !maskedMsg.includes(mkMobile(37)),
  maskedMsg
);
run(
  `INSERT OR IGNORE INTO role_permissions (hotel_id, role, permission, created_at) VALUES (?,?,?,?)`,
  [HOTEL, "frontdesk", "member.view_sensitive", NOW]
);
session.invalidatePermissionCache(HOTEL);
check(
  "还原 member.view_sensitive 后 frontdesk 权限恢复",
  session.hasPermission("frontdesk", "member.view_sensitive", HOTEL) === true
);

/* ============================================================ 7. 汇总 + 真库零写入 */

section("7. 收尾：真库零写入复查");

const REAL_AFTER = realDbCounts();
check(
  "真库 guests / op_logs / sessions 行数未变（所有写入都在副本里）",
  REAL_AFTER.guests === REAL_BEFORE.guests &&
    REAL_AFTER.op_logs === REAL_BEFORE.op_logs &&
    REAL_AFTER.sessions === REAL_BEFORE.sessions,
  `before=${JSON.stringify(REAL_BEFORE)} after=${JSON.stringify(REAL_AFTER)}`
);

try {
  conn.close();
} catch {
  /* 已关闭 */
}
try {
  fs.rmSync(ISO_DIR, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log("\n========== 汇总 ==========");
if (fail > 0) {
  console.log("❌ 未通过项：");
  for (const f of failures) console.log(`   - ${f}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
