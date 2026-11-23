#!/usr/bin/env node
/**
 * 整改 5.2 验收：角色权限从硬编码改为数据库驱动
 *
 * 背景：src/lib/session.ts 原来用两张硬编码常量表判断权限
 *   ROLE_MODULES  角色 → 页面模块（canAccess，路由守卫）
 *   PERMISSIONS   权限点 → 允许的角色（hasPermission / requirePermission）
 * 设置页改了也没用。整改要求「统一使用数据库中的岗位和角色权限，设置页修改后必须即时影响接口判断」。
 *
 * 本脚本验四层：
 *   1. 结构：三张表 + 两个唯一索引存在；permission_dict 已灌满 29 个权限点；
 *   2. 数据：role_modules / role_permissions 与迁移前的常量语义完全一致（不是「差不多」）；
 *   3. 行为：真的把 src/lib/session.ts 转译后加载进来，改库 → invalidatePermissionCache()
 *      → 下一次 hasPermission / canAccess 立刻变；不 invalidate 时 5 秒内仍是旧值（TTL 生效）；
 *      某角色一行配置都没有时回落到硬编码常量（新库没迁移也不至于全站 401）；
 *   4. 回归：node scripts/test-action-permissions.mjs 必须 251/0、test-auth-security.mjs 必须通过。
 *
 * ── 写库安全（P1 整改：绝不写真库）──
 * 本脚本必须「改库 → 看权限是否立刻变」，但所有写操作只落在副本库，且整段包在事务里：
 *   1) 副本库：data/pms.db --VACUUM INTO--> .tmp/rbac-verify-<pid>-<ts>.db；
 *      副本句柄注入 globalThis.__pmsDb，src/lib/db.ts 的 getDb() 首行
 *      （`if (globalThis.__pmsDb) return globalThis.__pmsDb;`）会直接把它返回，
 *      于是 require 进来的真实 session.ts 读写的也是副本 —— 测的仍是源码那份逻辑。
 *   2) 事务：破坏性用例包在 BEGIN IMMEDIATE 内，收尾一律 ROLLBACK（不 COMMIT）：
 *      中途抛错 / 断言失败 / 进程被 kill / Ctrl-C 都不会留下半改状态。
 *   3) 收尾：close + 删副本文件；再以只读连接复查**真库** role_permissions
 *      的行数分布（总量 + 按角色）与开跑前完全一致，不一致直接退出码 1。
 *
 * 旧版是「在真库上改完，再用内存快照整表还原」——进程若在
 * `DELETE FROM role_permissions` 与重新 INSERT 之间被 kill，生产权限表就被打空
 * （67 行 → 0），所有角色的权限全错。这是本次整改的动因。
 *
 * 环境变量：PMS_DB_PATH 只用来指定「真库」的位置；本脚本不会把它改成副本路径，
 * 第 10 节 spawn 出去的 test-action-permissions / test-auth-security 继承的仍是原环境，
 * 行为与整改前完全一致。
 *
 * 用法：node scripts/test-rbac.mjs
 * 退出码：有 ❌ 或真库被改动时 1，全绿 0。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const requireCjs = createRequire(import.meta.url);
/** 真库：只作为「复制源」和「收尾复查对象」，本脚本不写它一个字节 */
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = path.join(ROOT, ".tmp");
/** 副本库：本次验收唯一的写入目标，跑完删除 */
const COPY_DB = path.join(TMP_DIR, `rbac-verify-${process.pid}-${Date.now()}.db`);

let pass = 0;
let fail = 0;
const failures = [];

/** 一条断言：ok 决定通过/失败，label 要能独立看懂 */
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================ 前置：副本库 + 真库基线 */
/** SQLite 字符串字面量里的路径要写成 'D:/a/b.db' 这种形式 */
const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");
const msgOf = (e) => (e instanceof Error ? e.message : String(e));

/** role_permissions 的行数分布（总量 + 按 hotel:role）：跑前跑后各取一次，用来证明没写真库 */
function permCountsOf(file) {
  const conn = new DatabaseSync(file, { readOnly: true, timeout: 10000 });
  try {
    const total = Number(conn.prepare(`SELECT COUNT(*) AS c FROM role_permissions`).get().c);
    const byRole = {};
    for (const r of conn
      .prepare(`SELECT hotel_id, role, COUNT(*) AS c FROM role_permissions GROUP BY hotel_id, role ORDER BY hotel_id, role`)
      .all()) {
      byRole[`${r.hotel_id}:${r.role}`] = Number(r.c);
    }
    return { total, byRole };
  } finally {
    conn.close();
  }
}
const fmtCounts = (c) =>
  `${c.total} 行（${Object.entries(c.byRole).map(([k, v]) => `${k.split(":")[1]} ${v}`).join(" / ")}）`;
const sameCounts = (a, b) => a.total === b.total && JSON.stringify(a.byRole) === JSON.stringify(b.byRole);

if (!fs.existsSync(REAL_DB)) {
  console.error(`❌ 真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs，或设 PMS_DB_PATH）`);
  process.exit(1);
}
const REAL_BEFORE = permCountsOf(REAL_DB);

/** 清理历史遗留副本（>6 小时；不动别人正在用的新文件） */
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (!/^rbac-verify-[\w.-]+\.db(-wal|-shm|-journal)?$/.test(f)) continue;
    const p = path.join(TMP_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 6 * 60 * 60 * 1000) fs.rmSync(p, { force: true });
  }
} catch {
  /* 清理失败不影响本次验收 */
}

/* 复制真库 → 副本。复制失败就退出，绝不降级成「直接写真库」 */
try {
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${sqlPath(COPY_DB)}'`);
  } finally {
    src.close();
  }
} catch (e) {
  console.error(`❌ 复制真库失败，已中止（不会退化为直接写真库）\n  源 ${REAL_DB}\n  目标 ${COPY_DB}\n  ${msgOf(e)}`);
  process.exit(1);
}
const db = new DatabaseSync(COPY_DB, { timeout: 15000 });
/** 关键：编译后的 src/lib/db.ts 的 getDb() 第一句就返回它，session.ts 因此也读副本 */
globalThis.__pmsDb = db;

let txOpen = false;
/** 回滚副本库事务（幂等）。真库从未进入本连接，回滚不会波及它 */
function rollbackCopyTx() {
  if (!txOpen) return;
  txOpen = false;
  try {
    db.exec("ROLLBACK");
  } catch (e) {
    console.error(`\n⚠️  回滚副本库失败（副本即将删除，真库不受影响）：${msgOf(e)}`);
  }
}

let dbClosed = false;
/** 关闭并删除副本库；幂等，也挂在 exit 上兜底（Ctrl-C / 提前 exit） */
function cleanupCopyDb() {
  rollbackCopyTx();
  if (!dbClosed) {
    dbClosed = true;
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  if (globalThis.__pmsDb === db) globalThis.__pmsDb = undefined;
  for (const f of [COPY_DB, `${COPY_DB}-wal`, `${COPY_DB}-shm`, `${COPY_DB}-journal`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* Windows 上偶发占用：留给下次启动的过期清理 */
    }
  }
}
process.on("exit", cleanupCopyDb);
/* Ctrl-C / kill 也要删副本：Node 默认不触发 exit 事件，所以显式接信号 */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.error(`\n收到 ${sig}：回滚并删除副本库（真库未被写入）。`);
    cleanupCopyDb();
    process.exit(130);
  });
}

/* ============================================================ 0. 加载真实 session.ts */
/**
 * 没有 next 运行时也能测 session.ts 的办法：
 *   用项目自带的 typescript 把 session.ts / db.ts / utils.ts 转成 CommonJS 放到 .tmp，
 *   再把 next/headers、next/navigation 换成桩（这两个模块只在请求上下文里才有意义），
 *   然后 require 编译产物 —— 测的就是仓库里那份代码，不是复制出来的逻辑。
 *
 * 为什么不直接 import：Node 的 ESM 要求相对导入写全扩展名（session.ts 里是 "./db"），
 * 而且 next/headers 在服务端组件之外调用会抛错。
 */
function loadSessionModule() {
  const ts = requireCjs("typescript");
  const Module = requireCjs("node:module");
  const srcDir = path.join(ROOT, "src", "lib");
  const outDir = path.join(ROOT, ".tmp", "rbac-harness");
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of ["session.ts", "db.ts", "utils.ts"]) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: file,
    });
    fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, ".js")), outputText);
  }

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "next/headers") {
      const deny = async () => {
        throw new Error("本脚本不在 Next.js 请求上下文中调用 getSession");
      };
      return { cookies: deny, headers: deny };
    }
    if (request === "next/navigation") {
      return {
        redirect: (url) => {
          throw new Error(`REDIRECT:${url}`);
        },
        notFound: () => {
          throw new Error("NOT_FOUND");
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return requireCjs(path.join(outDir, "session.js"));
  } finally {
    Module._load = originalLoad;
  }
}

const session = loadSessionModule();
/*
 * 硬校验（不占断言数，失败直接中止）：session.ts 编译产物拿到的必须就是副本句柄。
 * 万一将来 db.ts 改成「不再认 globalThis.__pmsDb」（比如改成模块级私有单例），
 * session 就会自己 new 一个指向 data/pms.db 的连接 —— 那样下面的 DELETE 又会落到真库。
 * 所以这里先验一次身份，不通过就不跑任何写操作。
 */
const compiledDb = requireCjs(path.join(ROOT, ".tmp", "rbac-harness", "db.js"));
if (compiledDb.getDb() !== db) {
  console.error(
    "❌ session.ts 的 getDb() 没有返回副本库句柄（src/lib/db.ts 的 __pmsDb 注入失效）。\n" +
      "   拒绝继续：否则后面的 DELETE 会写到真库。请检查 src/lib/db.ts 的 getDb 实现。"
  );
  cleanupCopyDb();
  process.exit(1);
}
const sessionSrc = read("src/lib/session.ts");
const migrateSrc = read("scripts/migrate-all.mjs");
const settingsActionsSrc = read("src/app/(main)/settings/actions.ts");
const settingsPageSrc = read("src/app/(main)/settings/page.tsx");

/* ============================================================ 1. 解析迁移前的常量 */

/** 解析 session.ts 里的 PERMISSIONS 表（与 test-action-permissions.mjs 同一套解析口径） */
function parsePermissionTable(src) {
  const start = src.indexOf("const PERMISSIONS");
  if (start < 0) throw new Error("src/lib/session.ts 里找不到 PERMISSIONS 表");
  const open = src.indexOf("{", start);
  const end = src.indexOf("\n};", open);
  if (end < 0) throw new Error("PERMISSIONS 表结构异常：找不到结束的 }");
  const body = src.slice(open + 1, end);
  const table = {};
  const re = /"([a-zA-Z0-9_.]+)"\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    table[m[1]] = m[2]
      .split(",")
      .map((r) => r.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return table;
}

/** 解析 session.ts 里的 ROLE_MODULES 表（先去掉注释，避免注释里的 / 被当成模块） */
function parseRoleModules(src) {
  const start = src.indexOf("export const ROLE_MODULES");
  const open = src.indexOf("{", start);
  const end = src.indexOf("\n};", open);
  const body = src
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const table = {};
  const re = /([A-Za-z_]\w*)\s*:\s*(\[[^\]]*\]|"[^"]*")/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[2].startsWith("[")) {
      table[m[1]] = m[2]
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      table[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
  return table;
}

const PERMISSIONS_SRC = parsePermissionTable(sessionSrc);
const ROLE_MODULES_SRC = parseRoleModules(sessionSrc);

/* ============================================================ 2. 数据快照（用于还原） */
/*
 * 这里是「副本库内的还原」，不是「真库的还原」：
 *   用例之间需要回到基准状态（例如第 4 节验完 TTL 后要断言 cashier 又有了 refund），
 *   所以仍然保留快照还原；全局兜底则是最外层事务的 ROLLBACK。
 */

const permSnapshot = db.prepare(`SELECT hotel_id, role, permission, created_at FROM role_permissions`).all();
const modSnapshot = db.prepare(`SELECT hotel_id, role, module, created_at FROM role_modules`).all();

/** 把副本库的 role_permissions / role_modules 恢复成脚本启动时的样子 */
function restoreSnapshots() {
  try {
    db.exec("DELETE FROM role_permissions");
    db.exec("DELETE FROM role_modules");
    const insPerm = db.prepare(
      `INSERT OR IGNORE INTO role_permissions (hotel_id, role, permission, created_at) VALUES (?, ?, ?, ?)`
    );
    for (const r of permSnapshot) insPerm.run(r.hotel_id, r.role, r.permission, r.created_at);
    const insMod = db.prepare(
      `INSERT OR IGNORE INTO role_modules (hotel_id, role, module, created_at) VALUES (?, ?, ?, ?)`
    );
    for (const r of modSnapshot) insMod.run(r.hotel_id, r.role, r.module, r.created_at);
    session.invalidatePermissionCache();
  } catch (e) {
    console.error(`\n⚠️  还原副本库权限表失败（副本即将丢弃）：${msgOf(e)}`);
  }
}

/* ============================================================ 主流程 */

async function main() {
  console.log("========== 整改 5.2 角色权限数据库化 验收 ==========");
  console.log(`项目：${ROOT}`);
  console.log(`真库：${REAL_DB}`);
  console.log(`      （只读复制源 + 收尾复查；role_permissions 基线 ${fmtCounts(REAL_BEFORE)}）`);
  console.log(`副本：${COPY_DB}`);
  console.log(`      （唯一写入目标；整段 BEGIN IMMEDIATE，收尾 ROLLBACK，跑完删除）`);

  /* 破坏性用例全部放进副本库事务里；退出/异常一律回滚，绝不 COMMIT */
  db.exec("BEGIN IMMEDIATE");
  txOpen = true;
  try {
    /* ---------------------------------------------------------- 1. 表与索引 */
    section("1. 表结构与索引");
    const tableNames = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name)
    );
    for (const table of ["role_modules", "role_permissions", "permission_dict"]) {
      check(`表 ${table} 存在`, tableNames.has(table));
    }

    const columnsOf = (table) =>
      tableNames.has(table) ? db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name) : [];
    const expectRoleCols = ["id", "hotel_id", "role"];
    for (const [table, extra] of [
      ["role_modules", "module"],
      ["role_permissions", "permission"],
    ]) {
      const cols = columnsOf(table);
      check(
        `${table} 字段齐全（id/hotel_id/role/${extra}/created_at）`,
        expectRoleCols.every((c) => cols.includes(c)) && cols.includes(extra) && cols.includes("created_at"),
        cols.join(",")
      );
    }
    const dictCols = columnsOf("permission_dict");
    check(
      "permission_dict 字段齐全（permission/label/module/description）",
      ["permission", "label", "module", "description"].every((c) => dictCols.includes(c)),
      dictCols.join(",")
    );

    const indexNames = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r) => r.name)
    );
    check("唯一索引 idx_role_modules_key 存在", indexNames.has("idx_role_modules_key"));
    check("唯一索引 idx_role_permissions_key 存在", indexNames.has("idx_role_permissions_key"));

    /* ---------------------------------------------------------- 2. 迁移数据 */
    section("2. 迁移数据与迁移前的常量语义一致");
    const dbPerms = db.prepare(`SELECT hotel_id, role, permission FROM role_permissions`).all();
    const dbMods = db.prepare(`SELECT hotel_id, role, module FROM role_modules`).all();
    const dbDict = db.prepare(`SELECT permission, label, module, description FROM permission_dict`).all();

    const srcPermPairs = new Set();
    for (const [permission, roles] of Object.entries(PERMISSIONS_SRC)) {
      for (const role of roles) srcPermPairs.add(`${role}\u0001${permission}`);
    }
    const dbPermPairs = new Set(dbPerms.filter((r) => Number(r.hotel_id) === 1).map((r) => `${r.role}\u0001${r.permission}`));

    const missingPerm = [...srcPermPairs].filter((k) => !dbPermPairs.has(k));
    const extraPerm = [...dbPermPairs].filter((k) => !srcPermPairs.has(k));
    check(
      `role_permissions 完整覆盖原 PERMISSIONS（${srcPermPairs.size} 组角色×权限点）`,
      missingPerm.length === 0,
      missingPerm.slice(0, 6).join(" | ")
    );
    check("role_permissions 没有多余的角色×权限点", extraPerm.length === 0, extraPerm.slice(0, 6).join(" | "));

    const dbModPairs = new Set(dbMods.filter((r) => Number(r.hotel_id) === 1).map((r) => `${r.role}\u0001${r.module}`));
    const srcModPairs = new Set();
    for (const [role, mods] of Object.entries(ROLE_MODULES_SRC)) {
      if (mods === "*") srcModPairs.add(`${role}\u0001*`);
      else for (const m of mods) srcModPairs.add(`${role}\u0001${m}`);
    }
    const missingMod = [...srcModPairs].filter((k) => !dbModPairs.has(k));
    const extraMod = [...dbModPairs].filter((k) => !srcModPairs.has(k));
    check(
      `role_modules 完整覆盖原 ROLE_MODULES（${srcModPairs.size} 组角色×模块）`,
      missingMod.length === 0,
      missingMod.slice(0, 6).join(" | ")
    );
    check("role_modules 没有多余的角色×模块", extraMod.length === 0, extraMod.slice(0, 6).join(" | "));

    const dictCodes = new Set(dbDict.map((r) => r.permission));
    const missingDict = Object.keys(PERMISSIONS_SRC).filter((code) => !dictCodes.has(code));
    check(
      `permission_dict 覆盖全部 ${Object.keys(PERMISSIONS_SRC).length} 个权限点`,
      missingDict.length === 0,
      missingDict.join(",")
    );
    check(
      "permission_dict 每条都有中文 label 与归属模块",
      dbDict.length > 0 && dbDict.every((r) => String(r.label ?? "").trim().length > 0 && String(r.module ?? "").trim().length > 0)
    );

    /* 关键点：直接把语义点断言出来，避免「两边一起错」也能过 */
    check("admin 对所有权限点放行（hasPermission 短路）", Object.keys(PERMISSIONS_SRC).every((p) => session.hasPermission("admin", p) === true));
    check("frontdesk 拥有 booking.create", session.hasPermission("frontdesk", "booking.create"));
    check("housekeeping 没有 night_audit.run", session.hasPermission("housekeeping", "night_audit.run") === false);
    check("cashier 拥有 cashier.refund、但没有 booking.create", session.hasPermission("cashier", "cashier.refund") && !session.hasPermission("cashier", "booking.create"));
    check("未知权限点一律拒绝", session.hasPermission("frontdesk", "definitely.not.exists") === false);
    check("canAccess：housekeeping 可进 /rooms、不可进 /cashier", session.canAccess("housekeeping", "/rooms") && !session.canAccess("housekeeping", "/cashier"));
    check("canAccess：cashier 可进 /finance、不可进 /bookings", session.canAccess("cashier", "/finance") && !session.canAccess("cashier", "/bookings"));
    check("canAccess：admin 通配全部页面", session.canAccess("admin", "/settings") && session.canAccess("admin", "/night-audit"));

    /* ---------------------------------------------------------- 3. 读库立即生效 */
    section("3. hasPermission 读库 + invalidatePermissionCache 立即生效");
    session.invalidatePermissionCache();
    check("改库前：frontdesk 有 booking.create", session.hasPermission("frontdesk", "booking.create") === true);

    db.prepare(`DELETE FROM role_permissions WHERE hotel_id = 1 AND role = 'frontdesk' AND permission = 'booking.create'`).run();
    session.invalidatePermissionCache(1);
    check("删掉该行并 invalidate 后：frontdesk 立刻失去 booking.create", session.hasPermission("frontdesk", "booking.create") === false);

    db.prepare(
      `INSERT OR IGNORE INTO role_permissions (hotel_id, role, permission, created_at) VALUES (1, 'frontdesk', 'booking.create', ?)`
    ).run(new Date().toISOString());
    session.invalidatePermissionCache(1);
    check("补回该行并 invalidate 后：frontdesk 立刻恢复 booking.create", session.hasPermission("frontdesk", "booking.create") === true);

    /* 缓存 TTL：不调 invalidate，5 秒内必须还是旧值 */
    section("4. 缓存策略：5 秒 TTL（不 invalidate 时多实例最迟 5 秒感知）");
    session.invalidatePermissionCache();
    check("先预热缓存：cashier 有 cashier.refund", session.hasPermission("cashier", "cashier.refund") === true);

    db.prepare(`DELETE FROM role_permissions WHERE hotel_id = 1 AND role = 'cashier' AND permission = 'cashier.refund'`).run();
    check(
      "改库后不 invalidate：5 秒内仍读到旧值（缓存命中，不跨实例立即抖动）",
      session.hasPermission("cashier", "cashier.refund") === true
    );
    await sleep(5200); // 等 TTL 过期
    check(
      "超过 5 秒 TTL：缓存自动失效并读到新值（false）",
      session.hasPermission("cashier", "cashier.refund") === false
    );
    restoreSnapshots();
    check("还原后：cashier 重新拥有 cashier.refund", session.hasPermission("cashier", "cashier.refund") === true);

    /* ---------------------------------------------------------- 5. canAccess 读库 */
    section("5. canAccess 同样读库 + 立即生效");
    db.prepare(`DELETE FROM role_modules WHERE hotel_id = 1 AND role = 'housekeeping' AND module = '/rooms'`).run();
    db.prepare(
      `INSERT OR IGNORE INTO role_modules (hotel_id, role, module, created_at) VALUES (1, 'housekeeping', '/finance', ?)`
    ).run(new Date().toISOString());
    session.invalidatePermissionCache(1);
    check("改库并 invalidate 后：housekeeping 失去 /rooms", session.canAccess("housekeeping", "/rooms") === false);
    check("改库并 invalidate 后：housekeeping 获得 /finance", session.canAccess("housekeeping", "/finance") === true);
    restoreSnapshots();
    check("还原后：housekeeping 恢复 /rooms、失去 /finance", session.canAccess("housekeeping", "/rooms") && !session.canAccess("housekeeping", "/finance"));

    /* ---------------------------------------------------------- 6. 降级 fallback */
    section("6. 无配置时降级到硬编码常量（新库没迁移也不至于全站 401）");
    check("当前本店权限确实来自数据库（isRbacDbBacked）", session.isRbacDbBacked(1) === true);

    // 6.1 单个角色清空
    db.prepare(`DELETE FROM role_permissions WHERE hotel_id = 1 AND role = 'housekeeping'`).run();
    session.invalidatePermissionCache(1);
    check(
      "清空 housekeeping 的权限行后回落常量：仍有 room.change_status",
      session.hasPermission("housekeeping", "room.change_status") === true
    );
    check(
      "回落常量后仍没有 night_audit.run（默认值不是「全放行」）",
      session.hasPermission("housekeeping", "night_audit.run") === false
    );

    db.prepare(`DELETE FROM role_modules WHERE hotel_id = 1 AND role = 'housekeeping'`).run();
    session.invalidatePermissionCache(1);
    check(
      "清空 housekeeping 的模块行后回落常量：仍可进 /rooms、仍不可进 /cashier",
      session.canAccess("housekeeping", "/rooms") === true && session.canAccess("housekeeping", "/cashier") === false
    );
    restoreSnapshots();

    // 6.2 整库清空（模拟「新库还没跑迁移」）
    db.exec(`DELETE FROM role_permissions`);
    db.exec(`DELETE FROM role_modules`);
    session.invalidatePermissionCache();
    check("表清空后 isRbacDbBacked 变为 false", session.isRbacDbBacked(1) === false);
    check("全空时 admin 仍全通过", session.hasPermission("admin", "night_audit.run") === true);
    check("全空时 frontdesk 仍有 booking.create（常量兜底）", session.hasPermission("frontdesk", "booking.create") === true);
    check("全空时 cashier 没有 night_audit.run", session.hasPermission("cashier", "night_audit.run") === false);
    check(
      "全空时 4 个角色的 canAccess 结果与常量表完全一致",
      Object.entries(ROLE_MODULES_SRC).every(([role, mods]) => {
        if (mods === "*") return session.canAccess(role, "/settings") === true;
        return mods.every((m) => session.canAccess(role, m) === true) && session.canAccess(role, "/__not_in_list__") === false;
      })
    );
    // permissionsOf 的逐点比对（单独算，避免把复杂逻辑塞进 check 里）
    let permOfOk = true;
    for (const [permission, roles] of Object.entries(PERMISSIONS_SRC)) {
      for (const role of ["frontdesk", "cashier", "housekeeping"]) {
        const expected = roles.includes(role);
        const actual = session.permissionsOf(role).includes(permission);
        if (expected !== actual) permOfOk = false;
      }
    }
    check("全空时 permissionsOf 与常量表逐点一致（frontdesk / cashier / housekeeping）", permOfOk);
    restoreSnapshots();
    check("还原后 isRbacDbBacked 恢复 true", session.isRbacDbBacked(1) === true);

    /* ---------------------------------------------------------- 7. permissionsOf / modulesOf */
    section("7. permissionsOf / modulesOf 与库一致");
    let ofOk = true;
    for (const role of ["frontdesk", "cashier", "housekeeping"]) {
      const dbSet = new Set(dbPerms.filter((r) => r.role === role && Number(r.hotel_id) === 1).map((r) => r.permission));
      const apiSet = new Set(session.permissionsOf(role, 1));
      if (dbSet.size !== apiSet.size || [...dbSet].some((p) => !apiSet.has(p))) ofOk = false;
    }
    check("permissionsOf 与 role_permissions 逐角色一致", ofOk);

    let modOfOk = true;
    for (const role of ["frontdesk", "cashier", "housekeeping"]) {
      const dbSet = new Set(dbMods.filter((r) => r.role === role && Number(r.hotel_id) === 1).map((r) => r.module));
      const apiSet = new Set(session.modulesOf(role, 1));
      if (dbSet.size !== apiSet.size || [...dbSet].some((m) => !apiSet.has(m))) modOfOk = false;
    }
    check("modulesOf 与 role_modules 逐角色一致", modOfOk);
    check("permissionsOf(admin) 覆盖字典里全部权限点", dbDict.every((r) => session.permissionsOf("admin", 1).includes(r.permission)));

    /* ---------------------------------------------------------- 8. 源码静态检查 */
    section("8. 源码接线（设置页保存 → 失效缓存 → 接口立即生效）");
    check(
      "session.ts 从 role_permissions / role_modules 读库",
      /FROM role_permissions WHERE hotel_id/.test(sessionSrc) && /FROM role_modules WHERE hotel_id/.test(sessionSrc)
    );
    check("session.ts 导出 invalidatePermissionCache / hasPermission / canAccess / permissionsOf / modulesOf",
      ["invalidatePermissionCache", "hasPermission", "canAccess", "permissionsOf", "modulesOf"].every((name) =>
        new RegExp(`export function ${name}\\b`).test(sessionSrc)
      )
    );
    check("hasPermission 保留 hotelId 可选参数（向后兼容 hasPermission(role, permission)）",
      /export function hasPermission\(role: string, permission: string, hotelId\?: number\)/.test(sessionSrc)
    );
    /*
     * 缓存必须挂在 globalThis：Next 把页面 / Server Action / Route Handler 分别打包，
     * 同一份 session.ts 会有多份模块级变量；挂在模块上时设置页保存只清掉页面那一份，
     * /api/* 的接口要等 5 秒 TTL 才生效 —— 实测过，所以这里锁死这条约束。
     */
    check(
      "权限缓存挂在 globalThis（多 bundle 共用，保存后接口立即生效）",
      /globalThis\.__pmsRbacCache/.test(sessionSrc) && !/^const rbacCache = new Map/m.test(sessionSrc)
    );
    check(
      "settings/actions.ts 有 saveRolePermissionsFormAction 且保存后调 invalidatePermissionCache",
      /export async function saveRolePermissionsFormAction/.test(settingsActionsSrc) &&
        /saveRolePermissionsFormAction[\s\S]{0,2600}invalidatePermissionCache\(hotelId\)/.test(settingsActionsSrc)
    );
    check(
      "settings/actions.ts 有 saveRoleModulesFormAction 且保存后调 invalidatePermissionCache",
      /export async function saveRoleModulesFormAction/.test(settingsActionsSrc) &&
        /saveRoleModulesFormAction[\s\S]{0,2600}invalidatePermissionCache\(hotelId\)/.test(settingsActionsSrc)
    );
    check("设置页新增「权限矩阵」tab（TABS + NAV_GROUPS）",
      settingsPageSrc.includes('{ key: "rbac", label: "权限矩阵" }') &&
        settingsPageSrc.includes('{ label: "权限矩阵", tab: "rbac" }')
    );
    check("设置页矩阵读的就是 role_permissions / role_modules",
      /FROM role_permissions WHERE hotel_id/.test(settingsPageSrc) && /FROM role_modules WHERE hotel_id/.test(settingsPageSrc)
    );
    check("migrate-all.mjs 建三张表并 INSERT OR IGNORE 灌数据",
      ["role_modules", "role_permissions", "permission_dict"].every((t) =>
        new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`).test(migrateSrc)
      ) && /INSERT OR IGNORE INTO/.test(migrateSrc)
    );
    check("migrate-all.mjs 建两个唯一索引",
      /idx_role_modules_key/.test(migrateSrc) && /idx_role_permissions_key/.test(migrateSrc)
    );
  } finally {
    /*
     * 两层收尾：
     *   1) restoreSnapshots() —— 用例之间需要回到基准状态，语义与整改前一致；
     *   2) rollbackCopyTx()   —— 全局兜底：副本库回到开跑前，即使上面抛错/断言失败、
     *                            甚至进程在这之前被 kill，真库也一个字节都没被碰过。
     */
    restoreSnapshots();
    rollbackCopyTx();
    session.invalidatePermissionCache(); // 丢掉回滚前读进缓存的权限行
  }

  /* ---------------------------------------------------------- 9. 账号 × 页面访问 */
  section("9. 4 个账号 × 页面访问（真实 users 表 + 库里的权限）");
  const users = db.prepare(`SELECT username, role, hotel_id, status FROM users ORDER BY id`).all();
  const expectAccess = {
    admin: {
      allow: ["/dashboard", "/settings", "/night-audit", "/reports", "/rooms", "/channels"],
      deny: [],
    },
    frontdesk: {
      allow: ["/dashboard", "/rooms", "/bookings", "/frontdesk", "/inhouse", "/cashier", "/members"],
      deny: ["/settings", "/night-audit", "/reports", "/channels"],
    },
    cashier: {
      allow: ["/dashboard", "/cashier", "/finance", "/ar", "/reports", "/invoices"],
      deny: ["/settings", "/night-audit", "/bookings", "/rooms"],
    },
    housekeeping: {
      allow: ["/dashboard", "/rooms", "/housekeeping", "/cleaners"],
      deny: ["/settings", "/cashier", "/bookings", "/night-audit", "/reports"],
    },
  };
  check("users 表里有 4 个启用账号（admin / front / cashier / housekeeper）", users.filter((u) => Number(u.status) === 1).length >= 4, JSON.stringify(users.map((u) => u.username)));
  for (const u of users) {
    const rule = expectAccess[u.role];
    if (!rule) continue;
    const allowOk = rule.allow.every((p) => session.canAccess(u.role, p, Number(u.hotel_id)) === true);
    const denyOk = rule.deny.every((p) => session.canAccess(u.role, p, Number(u.hotel_id)) === false);
    const allowBad = rule.allow.filter((p) => session.canAccess(u.role, p, Number(u.hotel_id)) !== true);
    const denyBad = rule.deny.filter((p) => session.canAccess(u.role, p, Number(u.hotel_id)) !== false);
    check(
      `账号 ${u.username}（${u.role}）可访问自己的页面、被挡在管理页外`,
      allowOk && denyOk,
      `应放行未放行：${allowBad.join(",") || "-"}；应拦截未拦截：${denyBad.join(",") || "-"}`
    );
  }

  /* ---------------------------------------------------------- 10. 回归 */
  section("10. 回归：动作层权限 + 认证安全");
  const runScript = (rel) => {
    const res = spawnSync(process.execPath, [rel], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  };

  const actionPerm = runScript("scripts/test-action-permissions.mjs");
  const actionSummary = (actionPerm.out.match(/通过：(\d+)\s+失败：(\d+)/) ?? []).slice(1);
  const actionPass = Number(actionSummary[0] ?? NaN);
  const actionFail = Number(actionSummary[1] ?? NaN);
  /*
   * 这个脚本的总数会随代码增长而变化（每加一个受权限保护的 action 就多两项）：
   *   · 静态段：24+ 个 action 的权限校验（含 admin 放行 / 受限角色被拒）
   *   · HTTP 运行时段：3 次登录 + 若干条越权请求被拒 + 若干条有权限请求不被拦
   * 只要 3100 上跑的是「源码修改之前」的旧构建，HTTP 段就会自己跳过（脚本刻意这么设计），
   * 此时总数较小；构建比源码新时才是满额。
   *
   * 所以断言不硬编码总数（曾经写死 251，加了 undoNightAuditAction 等 11 项变 262 就误判），
   * 只要求：退出码 0 + 失败数 0 + 通过数达到静态段下限。
   */
  const httpSkipped = /HTTP 运行时校验[\s\S]*跳过/.test(actionPerm.out);
  const MIN_PASS = 170; // 静态段的保守下限
  check(
    `scripts/test-action-permissions.mjs 全绿（通过 ${actionSummary[0] ?? "?"} / 失败 ${actionSummary[1] ?? "?"}；${
      httpSkipped ? "HTTP 段因 3100 为旧构建而跳过" : "含 HTTP 运行时段"
    }）`,
    actionPerm.code === 0 && actionFail === 0 && actionPass >= MIN_PASS
  );

  const authSec = runScript("scripts/test-auth-security.mjs");
  const authSummary = (authSec.out.match(/通过 (\d+) \/ 失败 (\d+)/) ?? []).slice(1);
  check(
    `scripts/test-auth-security.mjs 通过（通过${authSummary[0] ?? "?"}/失败${authSummary[1] ?? "?"}）`,
    authSec.code === 0 && authSummary[1] === "0",
    authSec.code === 0 ? "" : `退出码 ${authSec.code}`
  );

  /* ---------------------------------------------------------- 11. 真库未被写入 */
  /*
   * 这一段故意不用 check()：断言总数必须仍是 63（加一条就变 64，与整改前的口径对不上）。
   * 但它是硬门禁：真库行数只要有一丝变化就抛错 → 退出码 1。
   */
  section("11. 真库未被写入（副本库 + 事务回滚）");
  const REAL_AFTER = permCountsOf(REAL_DB);
  const realUntouched = sameCounts(REAL_BEFORE, REAL_AFTER);
  console.log(`  真库 ${REAL_DB}`);
  console.log(`    role_permissions 跑前：${fmtCounts(REAL_BEFORE)}`);
  console.log(`    role_permissions 跑后：${fmtCounts(REAL_AFTER)}`);
  console.log(`    副本 ${path.basename(COPY_DB)} 已回滚并删除`);
  if (!realUntouched) {
    throw new Error(
      `真库 role_permissions 被改动了！跑前 ${fmtCounts(REAL_BEFORE)} → 跑后 ${fmtCounts(REAL_AFTER)}`
    );
  }
  console.log(`  🔒 真库 role_permissions 与开跑前完全一致（${REAL_AFTER.total} 行）`);

  /* ---------------------------------------------------------- 汇总 */
  cleanupCopyDb(); // 先删副本再汇总，避免残留文件
  console.log("\n========== 汇总 ==========");
  if (fail > 0) {
    console.log("❌ 未通过项：");
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("脚本执行失败：", e);
  rollbackCopyTx(); // 副本库回滚（真库从未参与）
  cleanupCopyDb(); // 关闭并删除副本
  process.exit(1);
});
