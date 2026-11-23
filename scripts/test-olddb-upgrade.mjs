#!/usr/bin/env node
/**
 * 老库升级路径验收：**第 4 轮真实库 → 当前最新 schema**
 *
 * ── 为什么要有这套测试 ──
 * `scripts/migrate-all.mjs` 以前只在「当前真库」上验证过幂等（`db:migrate:check` 报 0 处），
 * 从没造过一个「第 4 轮的老库」升级到最新，也就从没验证过：
 *   · 老库缺表 / 缺列时迁移会不会半路崩（VPS 上踩过：`no such column: ar_accounts.company_id`）；
 *   · `CREATE TABLE IF NOT EXISTS` 补不了列 —— 后加的列到底有没有被 `ALTER TABLE ADD COLUMN` 补上；
 *   · 迁移里的数据修复（payments.kind 回填、AR 笔级台账回填）在老数据上跑会不会把数据搞坏；
 *   · 升完再跑一次是不是真的 0 处变更（幂等），而不是「每次都补一点」。
 *
 * ── 老库怎么造（可复现，不靠手工） ──
 * 1. `git show 62c1fb3:scripts/init-db.mjs`（第 4 轮整改完成版）导出到 .tmp 下的隔离目录；
 * 2. 连同那一版的 `migrate-all.mjs` 与 `src/lib/crypto.ts` 一起导出 —— 第 4 轮的迁移脚本
 *    `import "../src/lib/crypto.ts"`，同版本一起跑才能得到「第 4 轮部署时真实生成的那个库」；
 * 3. 用该版 `init-db.mjs` 建库（自带第 4 轮种子：1 酒店 / 30 房 / 4 用户 / 8 客人 / 6 在住）；
 * 4. 再手工灌一点**可识别的最小数据**（2 间房 + 1 个客人 + 1 个用户），用来证明升级不丢数据；
 * 5. 跑**当前** `scripts/migrate-all.mjs`，然后逐项检查补列 / 补表 / 数据 / 幂等 / 完整性。
 *
 * 另外单独造一个「AR 页面已经用过、但还没有 company_id」的老库（库 B）：
 * 第 4 轮 `/ar` 页面首次访问时会懒建 `ar_accounts`（**没有 company_id 列**），
 * 这正是 VPS 上第 21 段「先查 company_id 后 addColumn」当场炸掉的那种库形态。
 * 该库同时验证第 21 段的 AR 笔级台账回填（账户绑定 + 按 FIFO 生成 ar_ledgers）。
 *
 * ── 硬约束 ──
 * · 全程只在 `.tmp/olddb-upgrade-<时间戳>/` 里建库，**真库 data/pms.db 一次都不打开**；
 * · 不启动服务、不跑 next build、不改 src/；
 * · 每个子步骤失败都如实判红，不把「跳过」当通过；跑完整个目录删掉（可反复执行）。
 *
 * 用法：node scripts/test-olddb-upgrade.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* ============================================================ 断言器 */

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const section = (t) => console.log(`\n========== ${t} ==========\n`);

/* ============================================================ 环境 */

const ROOT = process.cwd();
/** 第 4 轮整改完成版提交（仓库根提交） */
const ROUND4 = "62c1fb3";
const STAMP = `${Date.now()}`;
const TMP = path.join(ROOT, ".tmp", `olddb-upgrade-${STAMP}`);
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");

/** SQLite 路径字面量：Windows 反斜杠必须转正斜杠，单引号翻倍 */
const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** 跑一个子进程；失败也返回结果，不抛（失败由断言判定） */
function execNode(scriptPath, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      status: typeof e?.status === "number" ? e.status : -1,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? ""),
    };
  }
}

/** git show <commit>:<path>；失败返回 null（由断言判红） */
function gitShow(spec) {
  try {
    return execFileSync("git", ["show", spec], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/* ============================================================ 库工具 */

const openDb = (file, readOnly = false) => new DatabaseSync(file, { readOnly, timeout: 15000 });
const all = (db, sql, p = []) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (db, sql, p = []) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : undefined;
};
const run = (db, sql, p = []) => Number(db.prepare(sql).run(...p).changes ?? 0);

const hasTable = (db, t) => Boolean(one(db, `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`, [t]));
const tableCols = (db, t) => (hasTable(db, t) ? all(db, `PRAGMA table_info("${t}")`).map((c) => c.name) : []);
const hasColumn = (db, t, c) => tableCols(db, t).includes(c);
const indexNames = (db) =>
  new Set(all(db, `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`).map((r) => r.name));
const tableNames = (db) =>
  all(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);

/** 全库 schema 快照：表 → 列，外加索引名与视图；用于「老库升级后 == 全新库」形态对比 */
function schemaSnapshot(db) {
  const tables = new Map();
  for (const t of tableNames(db)) tables.set(t, tableCols(db, t));
  return { tables, indexes: indexNames(db) };
}

/** 全库行数快照（只统计 sqlite_ 之外的表） */
function rowCounts(db) {
  const out = new Map();
  for (const t of tableNames(db)) out.set(t, Number(one(db, `SELECT COUNT(*) AS c FROM "${t}"`)?.c ?? 0));
  return out;
}

function diffSchema(base, target) {
  const missingTables = [];
  const missingCols = [];
  const missingIndexes = [];
  for (const [t, cols] of base.tables) {
    if (!target.tables.has(t)) {
      missingTables.push(t);
      continue;
    }
    const want = target.tables.get(t);
    const miss = want.filter((c) => !cols.includes(c));
    if (miss.length > 0) missingCols.push(`${t}.${miss.join(",")}`);
  }
  for (const idx of base.indexes) if (!target.indexes.has(idx)) missingIndexes.push(idx);
  return { missingTables, missingCols, missingIndexes };
}

/* ============================================================ 第 4 轮源码导出 */

/**
 * 第 4 轮 `src/app/(main)/ar/actions.ts` 里 `ensureArSchema` 的三段 CREATE TABLE
 *
 * 提取方式：按 `CREATE TABLE IF NOT EXISTS <name> (` 定位，再用括号计数找语句结尾。
 * 提取而不是硬抄，是为了「老库形态」永远等于那一版源码真实建出来的形态。
 */
function extractCreateTables(src) {
  const out = [];
  const marker = "CREATE TABLE IF NOT EXISTS";
  let from = 0;
  for (;;) {
    const start = src.indexOf(marker, from);
    if (start < 0) break;
    const parenStart = src.indexOf("(", start);
    if (parenStart < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = parenStart; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    const stmt = src.slice(start, end + 1);
    const name = /CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(stmt)?.[1] ?? "?";
    out.push({ name, sql: stmt });
    from = end + 1;
  }
  return out;
}

/**
 * 造一个「第 4 轮真实老库」
 *
 * 目录结构（与仓库同构，让那一版 migrate-all 的 `../src/lib/crypto.ts` 能解析到）：
 *   <dir>/scripts/init-db.mjs      第 4 轮 init-db
 *   <dir>/scripts/migrate-all.mjs  第 4 轮 migrate-all
 *   <dir>/src/lib/crypto.ts        第 4 轮 crypto（migrate-all 的依赖）
 *   <dir>/data/old.db              产物
 */
function buildRound4Db(dir) {
  mkdirp(path.join(dir, "scripts"));
  mkdirp(path.join(dir, "src", "lib"));
  mkdirp(path.join(dir, "data"));

  const spec = [
    ["scripts/init-db.mjs", path.join(dir, "scripts", "init-db.mjs")],
    ["scripts/migrate-all.mjs", path.join(dir, "scripts", "migrate-all.mjs")],
    ["src/lib/crypto.ts", path.join(dir, "src", "lib", "crypto.ts")],
  ];
  const exported = {};
  for (const [repoPath, target] of spec) {
    const content = gitShow(`${ROUND4}:${repoPath}`);
    exported[repoPath] = content;
    if (typeof content === "string") fs.writeFileSync(target, content, "utf8");
  }

  const dbFile = path.join(dir, "data", "old.db");
  const result = execNode(path.join(dir, "scripts", "init-db.mjs"), {
    cwd: dir,
    env: { PMS_DB_PATH: dbFile },
  });
  return { dbFile, result, exported };
}

/* ============================================================ 主流程 */

console.log(`项目根：${ROOT}`);
console.log(`工作目录：${TMP}`);
mkdirp(TMP);

try {
  /* ------------------------------------------------------------------ 前置 */
  section("0. 前置：找到第 4 轮提交并导出那一版的建库脚本");

  const commitExists = (() => {
    try {
      execFileSync("git", ["cat-file", "-e", `${ROUND4}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  check(`git 里存在第 4 轮提交 ${ROUND4}`, commitExists);

  const round4Dir = path.join(TMP, "round4");
  const builtA = buildRound4Db(round4Dir);
  const exportedInit = builtA.exported["scripts/init-db.mjs"] ?? "";
  const exportedMigrate = builtA.exported["scripts/migrate-all.mjs"] ?? "";
  const exportedCrypto = builtA.exported["src/lib/crypto.ts"] ?? "";

  check(
    "第 4 轮 init-db.mjs 已导出且含建表语句",
    exportedInit.includes("CREATE TABLE IF NOT EXISTS hotels"),
    `长度 ${exportedInit.length}`
  );
  check(
    "第 4 轮 migrate-all.mjs 已导出且导出 runMigrations",
    exportedMigrate.includes("export function runMigrations"),
    `长度 ${exportedMigrate.length}`
  );
  /**
   * 第 4 轮 migrate-all 依赖 `../src/lib/crypto.ts`（渠道密钥加密）。
   * 同版本一起导出，才能保证「老库」是那一版真实跑出来的，而不是用今天的方法造的。
   */
  check(
    "第 4 轮 crypto.ts 已导出（migrate-all 的加密依赖）",
    exportedCrypto.includes("export function encryptSecret"),
    `长度 ${exportedCrypto.length}`
  );

  /* ------------------------------------------------------------------ 库 A：纯迁移路径 */
  section("1. 造「第 4 轮老库」（库 A）：用第 4 轮 init-db 建库 + 灌最小数据");

  check(
    "第 4 轮 init-db 建库成功（exit 0）",
    builtA.result.status === 0 && fs.existsSync(builtA.dbFile),
    `exit=${builtA.result.status} ${builtA.result.stderr.slice(0, 300)}`
  );

  const dbA = openDb(builtA.dbFile);

  /** 升级前的老库形态：这些「后续轮次才有」的表/列此时都应该不存在 */
  const OLD_MISSING_TABLES = ["shop_stock_flows", "mini_notifications", "mini_service_requests"];
  const OLD_MISSING_COLUMNS = [
    ["payments", "kind"],
    ["housekeeping", "review_status"],
    ["housekeeping", "reviewed_by"],
    ["housekeeping", "reviewed_at"],
    ["stays", "self_use"],
    ["booking_rooms", "guest_id"],
    ["bookings", "mini_request_id"],
    ["room_types", "images"],
    ["room_types", "facilities"],
  ];
  const missingTablesBefore = OLD_MISSING_TABLES.filter((t) => !hasTable(dbA, t));
  const missingColumnsBefore = OLD_MISSING_COLUMNS.filter(([t, c]) => hasTable(dbA, t) && !hasColumn(dbA, t, c));
  const absentTablesBefore = OLD_MISSING_TABLES.filter((t) => !hasTable(dbA, t));

  check(
    `老库确实缺后续轮次才建的表（${OLD_MISSING_TABLES.join(" / ")}）`,
    absentTablesBefore.length === OLD_MISSING_TABLES.length,
    `缺 ${absentTablesBefore.length}/${OLD_MISSING_TABLES.length}；缺的表：${absentTablesBefore.join(",") || "（无）"}`
  );
  check(
    `老库确实缺后续轮次才加的列（${OLD_MISSING_COLUMNS.length} 项）`,
    missingColumnsBefore.length === OLD_MISSING_COLUMNS.length,
    `缺 ${missingColumnsBefore.length}/${OLD_MISSING_COLUMNS.length}；还存在的：${OLD_MISSING_COLUMNS.filter(
      (x) => !missingColumnsBefore.some((y) => y[0] === x[0] && y[1] === x[1])
    )
      .map((x) => x.join("."))
      .join(",") || "（无）"}`
  );

  /* 第 4 轮种子基线：30 房 / 8 客 / 4 用户 / 6 在住（用「至少」判定，种子将来变化不至于误判） */
  const seedRow = (sql, p = []) => Number(one(dbA, sql, p)?.c ?? 0);
  const baseRooms = seedRow(`SELECT COUNT(*) c FROM rooms WHERE hotel_id = 1`);
  const baseGuests = seedRow(`SELECT COUNT(*) c FROM guests WHERE hotel_id = 1`);
  const baseUsers = seedRow(`SELECT COUNT(*) c FROM users WHERE hotel_id = 1`);
  const baseInhouse = seedRow(`SELECT COUNT(*) c FROM stays WHERE hotel_id = 1 AND status = 'INHOUSE'`);
  check(
    "第 4 轮老库自带种子数据（酒店 1 / 房间 / 客人 / 用户 / 在住）",
    baseRooms >= 1 && baseGuests >= 1 && baseUsers >= 1 && baseInhouse >= 1,
    `房 ${baseRooms} 客 ${baseGuests} 用户 ${baseUsers} 在住 ${baseInhouse}`
  );

  /* ---- 灌「可识别的最小数据」：2 间房 + 1 个客人 + 1 个用户 ---- */
  const suffix = STAMP.slice(-6);
  const seedRoomTypeId = Number(one(dbA, `SELECT id FROM room_types WHERE hotel_id = 1 ORDER BY id LIMIT 1`)?.id ?? 0);
  check("老库有房型可用于挂房（灌数据前置）", seedRoomTypeId > 0);

  const markRooms = [];
  for (const tag of ["OLDDB-A", "OLDDB-B"]) {
    const roomNo = `${tag}-${suffix}`;
    const changes = run(
      dbA,
      `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (1, ?, 9, ?, 'VC', 9901)`,
      [roomNo, seedRoomTypeId]
    );
    check(`灌入标记房间 ${roomNo}`, changes === 1, `changes=${changes}`);
    markRooms.push({ id: Number(one(dbA, `SELECT id FROM rooms WHERE hotel_id = 1 AND room_no = ?`, [roomNo])?.id ?? 0), roomNo });
  }
  const markGuestName = `老库客人-${suffix}`;
  run(dbA, `INSERT INTO guests (hotel_id, name, mobile, vip_level) VALUES (1, ?, ?, 0)`, [markGuestName, "13700000001"]);
  const markGuest = one(dbA, `SELECT id, name FROM guests WHERE hotel_id = 1 AND name = ?`, [markGuestName]);
  check("灌入标记客人", Boolean(markGuest?.id), JSON.stringify(markGuest ?? {}));

  const markUserName = `olddbuser${suffix}`;
  run(dbA, `INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (1, ?, 'olddb-plain-pwd', '老库标记员工', 'frontdesk', 1)`, [
    markUserName,
  ]);
  const markUser = one(dbA, `SELECT id, username, password FROM users WHERE hotel_id = 1 AND username = ?`, [markUserName]);
  check(
    "灌入标记用户（第 4 轮 users.password 是明文列）",
    Boolean(markUser?.id) && markUser.password === "olddb-plain-pwd",
    JSON.stringify(markUser ?? {})
  );

  /* ---- 升级前快照 ---- */
  const countsBefore = rowCounts(dbA);
  const paymentsSumBefore = Number(one(dbA, `SELECT COALESCE(SUM(amount), 0) AS s FROM payments`)?.s ?? 0);
  const paymentsRowsBefore = Number(one(dbA, `SELECT COUNT(*) AS c FROM payments`)?.c ?? 0);
  const stayIdsBefore = all(dbA, `SELECT id, stay_no, status FROM stays WHERE hotel_id = 1 ORDER BY id`).map((r) => r.id);
  const folioItemsBefore = Number(one(dbA, `SELECT COUNT(*) AS c FROM folio_items`)?.c ?? 0);
  const folioItemsSumBefore = Number(one(dbA, `SELECT COALESCE(SUM(amount), 0) AS s FROM folio_items`)?.s ?? 0);
  const schemaBefore = schemaSnapshot(dbA);

  /* ------------------------------------------------------------------ 升级 */
  section("2. 跑当前 migrate-all.mjs 升级老库 A（这是从没测过的一步）");

  const migrateScript = path.join(ROOT, "scripts", "migrate-all.mjs");
  const upgrade1 = execNode(migrateScript, { cwd: ROOT, env: { PMS_DB_PATH: builtA.dbFile } });
  const upgrade1Out = `${upgrade1.stdout}\n${upgrade1.stderr}`;

  check("老库升级进程 exit 0（没有半路崩）", upgrade1.status === 0, `exit=${upgrade1.status}\n${upgrade1Out.slice(-1200)}`);
  check("升级输出没有 no such column（缺列错误）", !/no such column/i.test(upgrade1Out), upgrade1Out.match(/no such column[^\n]*/i)?.[0] ?? "");
  check("升级输出没有 no such table（缺表错误）", !/no such table/i.test(upgrade1Out), upgrade1Out.match(/no such table[^\n]*/i)?.[0] ?? "");
  check(
    "升级输出没有 SQLite 错误 / 迁移失败字样",
    !/(SQLITE_ERROR|SqliteError|迁移失败|UNIQUE constraint failed|FOREIGN KEY constraint failed)/i.test(upgrade1Out),
    upgrade1Out.match(/(SQLITE_ERROR|SqliteError|迁移失败|UNIQUE constraint failed|FOREIGN KEY constraint failed)[^\n]*/i)?.[0] ?? ""
  );

  const changed1 = Number(/迁移完成，变更 (\d+) 处/.exec(upgrade1Out)?.[1] ?? -1);
  check("升级确实做了变更（changed > 0，不是空跑）", changed1 > 0, `解析到 changed=${changed1}`);

  /* ------------------------------------------------------------------ 补列 / 补表 */
  section("3. 检查后续轮次新增的列 / 表是否都被补上");

  const dbA2 = openDb(builtA.dbFile);

  /** 必须补上的列（第 5~13 轮陆续加的，老库上一个都没有） */
  const REQUIRED_COLUMNS = [
    ["payments", "kind"],
    ["payments", "request_id"],
    ["payments", "refund_of"],
    ["payments", "operator"],
    ["housekeeping", "review_status"],
    ["housekeeping", "reviewed_by"],
    ["housekeeping", "reviewed_at"],
    ["housekeeping", "photos"],
    ["housekeeping", "room_status_snapshot"],
    ["stays", "self_use"],
    ["booking_rooms", "guest_id"],
    ["bookings", "mini_request_id"],
    ["bookings", "total_price"],
    ["room_types", "images"],
    ["room_types", "facilities"],
    ["room_types", "breakfast_note"],
    ["room_types", "cancellation_policy"],
    ["room_types", "check_in_time"],
    ["room_types", "check_out_time"],
    ["room_types", "deposit_note"],
    ["ar_ledgers", "kind"],
    ["ar_write_offs", "ar_ledger_id"],
    ["users", "password_hash"],
    ["users", "must_change_password"],
    ["users", "position_id"],
  ];
  const stillMissingCols = REQUIRED_COLUMNS.filter(([t, c]) => !hasColumn(dbA2, t, c));
  check(
    `后续轮次新增的 ${REQUIRED_COLUMNS.length} 个列全部补上（ALTER TABLE ADD COLUMN）`,
    stillMissingCols.length === 0,
    `缺：${stillMissingCols.map((x) => x.join(".")).join(",") || "（无）"}`
  );

  /**
   * 关键点：`CREATE TABLE IF NOT EXISTS` 补不了列。
   * 老库 payments / housekeeping 表本来就存在，只是没有新列 —— 这些列只可能由
   * `ALTER TABLE ... ADD COLUMN` 补上，所以上面那条断言同时证明了 addColumn 生效。
   */
  check(
    "payments.kind 由 ALTER TABLE 补上（老表已存在，CREATE IF NOT EXISTS 无法补列）",
    hasColumn(dbA2, "payments", "kind") && hasColumn(dbA2, "housekeeping", "review_status")
  );

  /** 必须补上的表（第 9~13 轮新建，老库里没有） */
  const REQUIRED_TABLES = [
    "ar_ledgers",
    "shop_stock_flows",
    "mini_notifications",
    "mini_service_requests",
    "room_anomalies",
    "shifts",
    "channel_settlements",
    "channel_sync_queue",
    "channel_sync_dead_letter",
    "channel_rate_plans",
  ];
  const stillMissingTables = REQUIRED_TABLES.filter((t) => !hasTable(dbA2, t));
  check(
    `后续轮次新增的 ${REQUIRED_TABLES.length} 张表全部补上`,
    stillMissingTables.length === 0,
    `缺：${stillMissingTables.join(",") || "（无）"}`
  );

  /** shop_stock_flows 的每一列（任务点名要验的表） */
  const shopFlowCols = tableCols(dbA2, "shop_stock_flows");
  const shopFlowWant = ["hotel_id", "item_id", "type", "qty", "stock_after", "unit_price", "amount", "sale_id", "request_id", "note", "operator", "created_at"];
  const shopFlowMiss = shopFlowWant.filter((c) => !shopFlowCols.includes(c));
  check("shop_stock_flows 列齐全（任务点名的表）", shopFlowMiss.length === 0 && shopFlowCols.length > 0, `缺：${shopFlowMiss.join(",") || "（无）"}`);

  /** 需要补上的索引 */
  const REQUIRED_INDEXES = ["idx_payments_kind", "idx_shop_stock_flows_item", "idx_mini_notifications_user", "idx_housekeeping_review", "idx_stays_no"];
  const idxAfter = indexNames(dbA2);
  const missingIndexes = REQUIRED_INDEXES.filter((n) => !idxAfter.has(n));
  check(`后续轮次新增的 ${REQUIRED_INDEXES.length} 个索引补上`, missingIndexes.length === 0, `缺：${missingIndexes.join(",") || "（无）"}`);

  /** payments.kind 回填：第 4 轮种子里 6 条押金（备注含「押金」）→ 应回填成 DEPOSIT，不留 NULL */
  const kindDist = all(dbA2, `SELECT kind, COUNT(*) AS c FROM payments GROUP BY kind ORDER BY kind`);
  const kindNull = Number(one(dbA2, `SELECT COUNT(*) AS c FROM payments WHERE kind IS NULL`)?.c ?? 0);
  check(
    "payments.kind 旧数据回填成 DEPOSIT（押金靠备注可判定的部分）",
    kindDist.some((r) => r.kind === "DEPOSIT" && Number(r.c) > 0),
    JSON.stringify(kindDist)
  );
  check("payments.kind 没有遗留 NULL（第 4 轮种子的押金都可判定）", kindNull === 0, `NULL ${kindNull} 条`);

  /* ------------------------------------------------------------------ 数据完好 */
  section("4. 数据有没有被破坏（升级前灌的标记数据 + 原有种子）");

  const markRoomsAfter = all(dbA2, `SELECT id, room_no, status FROM rooms WHERE hotel_id = 1 AND room_no IN (?,?)`, [
    markRooms[0].roomNo,
    markRooms[1].roomNo,
  ]);
  check("升级后 2 间标记房间都还在", markRoomsAfter.length === 2, JSON.stringify(markRoomsAfter));
  check(
    "升级后标记房间 id 未变（不是删了重建）",
    markRoomsAfter.length === 2 && markRoomsAfter.every((r) => markRooms.some((m) => m.id === Number(r.id) && m.roomNo === r.room_no)),
    JSON.stringify(markRooms)
  );

  const markGuestAfter = one(dbA2, `SELECT id, name, mobile FROM guests WHERE hotel_id = 1 AND name = ?`, [markGuestName]);
  check(
    "升级后标记客人还在且字段未变",
    Boolean(markGuestAfter) && Number(markGuestAfter.id) === Number(markGuest.id) && markGuestAfter.mobile === "13700000001",
    JSON.stringify(markGuestAfter ?? {})
  );

  const markUserAfter = one(dbA2, `SELECT id, username, password, password_hash FROM users WHERE hotel_id = 1 AND username = ?`, [markUserName]);
  check("升级后标记用户还在", Boolean(markUserAfter) && Number(markUserAfter.id) === Number(markUser.id), JSON.stringify(markUserAfter ?? {}));
  /**
   * 第 14 段会把老的明文 password 迁到 password_hash 并把 password 清空。
   * 这里同时验证「升级把明文密码洗干净了」与「哈希真的写进去了」。
   */
  check(
    "标记用户的明文密码已迁走（password 清空 + password_hash 写入）",
    markUserAfter?.password === "" && typeof markUserAfter?.password_hash === "string" && markUserAfter.password_hash.startsWith("scrypt$"),
    JSON.stringify({ password: markUserAfter?.password, hash: String(markUserAfter?.password_hash ?? "").slice(0, 24) })
  );

  const roomsAfter = Number(one(dbA2, `SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = 1`)?.c ?? 0);
  const guestsAfter = Number(one(dbA2, `SELECT COUNT(*) AS c FROM guests WHERE hotel_id = 1`)?.c ?? 0);
  const usersAfter = Number(one(dbA2, `SELECT COUNT(*) AS c FROM users WHERE hotel_id = 1`)?.c ?? 0);
  check(
    "房间数 = 原有 + 灌入 2 间（没丢没重）",
    roomsAfter === baseRooms + 2,
    `${baseRooms} + 2 = ${roomsAfter}`
  );
  check("客人数 = 原有 + 灌入 1 个（没丢没重）", guestsAfter === baseGuests + 1, `${baseGuests} + 1 = ${guestsAfter}`);
  check("用户数 = 原有 + 灌入 1 个（没丢没重）", usersAfter === baseUsers + 1, `${baseUsers} + 1 = ${usersAfter}`);

  const stayIdsAfter = all(dbA2, `SELECT id FROM stays WHERE hotel_id = 1 ORDER BY id`).map((r) => Number(r.id));
  check(
    "原有 6 张在住/历史单全部还在（按 id 逐个比对）",
    stayIdsBefore.every((id) => stayIdsAfter.includes(Number(id))) && stayIdsBefore.length === baseInhouse + 0 + (stayIdsBefore.length - baseInhouse),
    `升级前 ${stayIdsBefore.length} 张，升级后 ${stayIdsAfter.length} 张`
  );

  const paymentsSumAfter = Number(one(dbA2, `SELECT COALESCE(SUM(amount), 0) AS s FROM payments`)?.s ?? 0);
  const paymentsRowsAfter = Number(one(dbA2, `SELECT COUNT(*) AS c FROM payments`)?.c ?? 0);
  check("payments 行数不变（迁移只加列，不多记一笔）", paymentsRowsAfter === paymentsRowsBefore, `${paymentsRowsBefore} → ${paymentsRowsAfter}`);
  check(
    "payments 金额合计不变（kind 回填不改金额）",
    Math.abs(paymentsSumAfter - paymentsSumBefore) < 0.005,
    `${paymentsSumBefore} → ${paymentsSumAfter}`
  );

  const folioItemsAfter = Number(one(dbA2, `SELECT COUNT(*) AS c FROM folio_items`)?.c ?? 0);
  const folioItemsSumAfter = Number(one(dbA2, `SELECT COALESCE(SUM(amount), 0) AS s FROM folio_items`)?.s ?? 0);
  /**
   * 第 23 段「押金残留安全子集」会把 SETTLED 账单上的押金明细置 0 —— 这是**设计内**的数据变更，
   * 会减少 folio_items 的金额合计，但行数不能变。这里按「行数不变 + 金额不增加」判定。
   */
  check("folio_items 行数不变（迁移不删明细）", folioItemsAfter === folioItemsBefore, `${folioItemsBefore} → ${folioItemsAfter}`);
  check(
    "folio_items 金额合计没有增加，且只可能被押金置 0 压小（不虚增）",
    folioItemsSumAfter <= folioItemsSumBefore + 0.005,
    `${folioItemsSumBefore} → ${folioItemsSumAfter}`
  );

  /** 行数不减少：迁移可以补种子（permission_dict / role_permissions），但绝不能把业务数据删掉 */
  const countsAfter = rowCounts(dbA2);
  const shrank = [];
  for (const [t, n] of countsBefore) {
    const m = countsAfter.get(t);
    if (typeof m === "number" && m < n) shrank.push(`${t}: ${n} → ${m}`);
  }
  check(
    `升级后没有任何老表行数变少（${countsBefore.size} 张表逐表比对）`,
    shrank.length === 0,
    shrank.join("；") || "（无）"
  );

  /** 第 4 轮老表集合必须全部保留（迁移只允许加表） */
  const lostTables = [...schemaBefore.tables.keys()].filter((t) => !hasTable(dbA2, t));
  check("老库原有表一张都没少", lostTables.length === 0, `丢：${lostTables.join(",") || "（无）"}`);

  /* ------------------------------------------------------------------ 幂等 */
  section("5. 再跑一次必须幂等（0 处变更）");

  const upgrade2 = execNode(migrateScript, { cwd: ROOT, env: { PMS_DB_PATH: builtA.dbFile } });
  const upgrade2Out = `${upgrade2.stdout}\n${upgrade2.stderr}`;
  const changed2 = Number(/迁移完成，变更 (\d+) 处/.exec(upgrade2Out)?.[1] ?? -1);
  check("第二次升级 exit 0", upgrade2.status === 0, `exit=${upgrade2.status}`);
  check("第二次升级 0 处变更（幂等）", changed2 === 0, `解析到 changed=${changed2}\n${upgrade2Out.slice(-600)}`);
  check("第二次升级输出「没有需要变更的项目」", upgrade2Out.includes("没有需要变更的项目"));

  const checkRun = execNode(migrateScript, { cwd: ROOT, env: { PMS_DB_PATH: builtA.dbFile, ...{} } });
  /* --check 需要额外参数，用 spawn 语义补：直接再跑一次 execFileSync 带 --check */
  const checkOnly = (() => {
    try {
      const out = execFileSync(process.execPath, [migrateScript, "--check"], {
        cwd: ROOT,
        env: { ...process.env, PMS_DB_PATH: builtA.dbFile },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return { status: 0, out };
    } catch (e) {
      return { status: e?.status ?? -1, out: `${e?.stdout ?? ""}${e?.stderr ?? ""}` };
    }
  })();
  void checkRun;
  check(
    "migrate-all --check 在升级后的老库上报 0 处待处理",
    checkOnly.status === 0 && checkOnly.out.includes("没有需要变更的项目"),
    `exit=${checkOnly.status}\n${checkOnly.out.slice(-600)}`
  );

  /* ------------------------------------------------------------------ 完整性 */
  section("6. 完整性收尾：PRAGMA integrity_check / foreign_key_check");

  const integrity = all(dbA2, `PRAGMA integrity_check`).map((r) => Object.values(r)[0]);
  check("integrity_check = ok", integrity.length === 1 && integrity[0] === "ok", integrity.join(","));
  const fkIssues = all(dbA2, `PRAGMA foreign_key_check`);
  check("foreign_key_check 无违规行", fkIssues.length === 0, `${fkIssues.length} 行`);

  /* ------------------------------------------------------------------ 库 B：AR 懒建过的老库 */
  section("7. 库 B：模拟「/ar 页面已经用过」的老库（ar_accounts 有表无 company_id）");

  const dirB = path.join(TMP, "round4-ar");
  const builtB = buildRound4Db(dirB);
  check("库 B 用第 4 轮 init-db 建库成功", builtB.result.status === 0 && fs.existsSync(builtB.dbFile), `exit=${builtB.result.status}`);

  const round4ArSrc = gitShow(`${ROUND4}:src/app/(main)/ar/actions.ts`) ?? "";
  const arTables = extractCreateTables(round4ArSrc);
  const arTableNames = arTables.map((x) => x.name);
  check(
    "从第 4 轮 ar/actions.ts 提取到 3 张懒建表的 DDL（ar_accounts / ar_transactions / ar_write_offs）",
    ["ar_accounts", "ar_transactions", "ar_write_offs"].every((t) => arTableNames.includes(t)),
    arTableNames.join(",")
  );

  const dbB = openDb(builtB.dbFile);
  for (const t of arTables) dbB.exec(`${t.sql};`);
  dbB.exec(`CREATE INDEX IF NOT EXISTS idx_ar_tx_account ON ar_transactions (hotel_id, ar_account_id, biz_date)`);
  dbB.exec(`CREATE INDEX IF NOT EXISTS idx_ar_wo_account ON ar_write_offs (hotel_id, ar_account_id)`);

  check(
    "库 B 的 ar_accounts 存在但**没有** company_id（VPS 报错的库形态就位）",
    hasTable(dbB, "ar_accounts") && !hasColumn(dbB, "ar_accounts", "company_id"),
    `列：${tableCols(dbB, "ar_accounts").join(",")}`
  );

  /* 造一笔可回填的 AR 数据：公司「杭州云栖旅行社」↔ 账户「云栖旅行社」余额 1000 */
  const companyName = "杭州云栖旅行社";
  run(dbB, `INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (1, ?, '张经理', '13800000000', 1.0, 50000)`, [companyName]);
  const companyB = one(dbB, `SELECT id, name FROM companies WHERE hotel_id = 1 AND name = ?`, [companyName]);
  run(
    dbB,
    `INSERT INTO ar_accounts (hotel_id, code, name, type, credit_limit, balance, status, contact, phone, created_at)
     VALUES (1, 'AR-OLD-1', '云栖旅行社', '协议单位', 50000, 1000, 'ON', '张经理', '13800000000', ?)`,
    [new Date().toISOString()]
  );
  const accountB = one(dbB, `SELECT id, code, name, balance FROM ar_accounts WHERE hotel_id = 1 AND code = 'AR-OLD-1'`);
  run(
    dbB,
    `INSERT INTO ar_transactions (hotel_id, ar_account_id, type, amount, balance_after, note, operator, biz_date, created_at)
     VALUES (1, ?, 'POST', 1000, 1000, '期初挂账', '老系统', '2030-01-01', ?)`,
    [accountB?.id ?? 0, new Date().toISOString()]
  );
  check("库 B 灌入可回填的 AR 账户 + 流水（余额 1000）", Boolean(accountB?.id) && Number(accountB.balance) === 1000, JSON.stringify(accountB ?? {}));
  check(
    "库 B 升级前 ar_ledgers 是 0 行（账户总账与笔级台账分叉）",
    Number(one(dbB, `SELECT COUNT(*) AS c FROM ar_ledgers WHERE hotel_id = 1`)?.c ?? -1) === 0
  );

  const upgradeB = execNode(migrateScript, { cwd: ROOT, env: { PMS_DB_PATH: builtB.dbFile } });
  const upgradeBOut = `${upgradeB.stdout}\n${upgradeB.stderr}`;
  check("库 B 升级 exit 0（第 21 段不再打断迁移）", upgradeB.status === 0, `exit=${upgradeB.status}\n${upgradeBOut.slice(-1500)}`);
  check(
    "库 B 升级输出没有 no such column: company_id（VPS 踩过的那个错）",
    !/no such column[^\n]*company_id/i.test(upgradeBOut),
    upgradeBOut.match(/no such column[^\n]*/i)?.[0] ?? ""
  );

  const dbB2 = openDb(builtB.dbFile);
  check("升级后 ar_accounts.company_id 列被补上（第 21 段自己兜底，不靠第 9 段顺序）", hasColumn(dbB2, "ar_accounts", "company_id"));

  const accountAfterB = one(dbB2, `SELECT id, code, company_id, balance FROM ar_accounts WHERE hotel_id = 1 AND code = 'AR-OLD-1'`);
  check(
    "AR 账户被绑定到协议单位（company_id 非空且指向「杭州云栖旅行社」）",
    Boolean(accountAfterB?.company_id) && Number(accountAfterB.company_id) === Number(companyB?.id),
    JSON.stringify({ account: accountAfterB, wantCompanyId: companyB?.id })
  );
  check("AR 账户余额没被回填改掉（仍是 1000）", Math.abs(Number(accountAfterB?.balance ?? -1) - 1000) < 0.005, `余额 ${accountAfterB?.balance}`);

  const ledgerRows = all(dbB2, `SELECT id, company_id, amount, settled_amount, status, kind FROM ar_ledgers WHERE hotel_id = 1`);
  check(
    "AR 笔级台账回填出 1 行 CHARGE / 1000 / OPEN（账户总账 → 台账分叉被修好）",
    ledgerRows.length === 1 &&
      Number(ledgerRows[0].company_id) === Number(companyB?.id) &&
      Math.abs(Number(ledgerRows[0].amount) - 1000) < 0.005 &&
      Number(ledgerRows[0].settled_amount) === 0 &&
      ledgerRows[0].status === "OPEN" &&
      ledgerRows[0].kind === "CHARGE",
    JSON.stringify(ledgerRows)
  );

  const upgradeB2 = execNode(migrateScript, { cwd: ROOT, env: { PMS_DB_PATH: builtB.dbFile } });
  const changedB2 = Number(/迁移完成，变更 (\d+) 处/.exec(`${upgradeB2.stdout}\n${upgradeB2.stderr}`)?.[1] ?? -1);
  check("库 B 再跑一次 0 处变更（AR 回填不重复插台账）", changedB2 === 0, `changed=${changedB2}`);
  check(
    "库 B 再跑一次 ar_ledgers 仍只有 1 行（回填幂等）",
    Number(one(dbB2, `SELECT COUNT(*) AS c FROM ar_ledgers WHERE hotel_id = 1`)?.c ?? -1) === 1
  );
  const integrityB = all(dbB2, `PRAGMA integrity_check`).map((r) => Object.values(r)[0]);
  check("库 B integrity_check = ok", integrityB.length === 1 && integrityB[0] === "ok", integrityB.join(","));

  /* ------------------------------------------------------------------ 形态等价 */
  section("8. 老库升级后的形态 == 当前全新库（init-db 一次建出来的库）");

  const freshDir = path.join(TMP, "fresh");
  mkdirp(path.join(freshDir, "data"));
  const freshDbFile = path.join(freshDir, "data", "fresh.db");
  const freshRun = execNode(path.join(ROOT, "scripts", "init-db.mjs"), { cwd: freshDir, env: { PMS_DB_PATH: freshDbFile } });
  check("当前 init-db 建全新库成功（对照组）", freshRun.status === 0 && fs.existsSync(freshDbFile), `exit=${freshRun.status}\n${freshRun.stderr.slice(0, 600)}`);

  const dbFresh = openDb(freshDbFile);
  const schemaFresh = schemaSnapshot(dbFresh);
  const schemaUpgraded = schemaSnapshot(dbA2);

  check("全新库有表（对照组非空）", schemaFresh.tables.size > 40, `表数 ${schemaFresh.tables.size}`);

  const freshDiff = diffSchema(schemaFresh, schemaUpgraded);
  check(
    "老库升级后没有缺表（表集合与全新库一致）",
    freshDiff.missingTables.length === 0,
    `缺：${freshDiff.missingTables.join(",") || "（无）"}`
  );
  check(
    "老库升级后没有缺列（逐表逐列比对新库，这是「CREATE IF NOT EXISTS 补不了列」的最终证据）",
    freshDiff.missingCols.length === 0,
    `缺：${freshDiff.missingCols.join("；") || "（无）"}`
  );
  check(
    "老库升级后没有缺索引",
    freshDiff.missingIndexes.length === 0,
    `缺：${freshDiff.missingIndexes.join(",") || "（无）"}`
  );
  const upgradedExtraTables = [...schemaUpgraded.tables.keys()].filter((t) => !schemaFresh.tables.has(t));
  check(
    "老库升级后也没有多出全新库没有的表（多出来的只可能是测试灌的数据表）",
    upgradedExtraTables.length === 0,
    `多：${upgradedExtraTables.join(",") || "（无）"}`
  );
  check(
    "两边表数一致",
    schemaUpgraded.tables.size === schemaFresh.tables.size,
    `老库 ${schemaUpgraded.tables.size} / 全新库 ${schemaFresh.tables.size}`
  );

  /* ------------------------------------------------------------------ 收尾 */
  dbA.close();
  dbA2.close();
  dbB.close();
  dbB2.close();
  dbFresh.close();
} catch (e) {
  console.error(`\n❌ 脚本异常中断：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  fail += 1;
  failures.push(`脚本异常：${e instanceof Error ? e.message : String(e)}`);
} finally {
  /* 清理：整个临时目录删掉，保证可以反复跑、不留垃圾 */
  const keep = process.env.PMS_KEEP_TMP === "1";
  if (!keep) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 清理失败不改变测试结论 */
    }
  } else {
    console.log(`\n（PMS_KEEP_TMP=1，保留工作目录：${TMP}）`);
  }
}

console.log("\n========================== 汇总 ==========================");
console.log(`真库 data/pms.db：${fs.existsSync(REAL_DB) ? "存在（本脚本全程未打开，只读约束自动满足）" : "不存在（本脚本不依赖它）"}`);
console.log(`第 4 轮提交：${ROUND4}`);
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`\n失败项：\n  - ${failures.join("\n  - ")}`);
}
process.exit(fail === 0 ? 0 : 1);
