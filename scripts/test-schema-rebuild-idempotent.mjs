/**
 * 旧库表重建的幂等性验收（codex 第七轮清单第五节）
 *
 * 验证：
 *   1. 造一个「旧格式」库（单号列带列级 UNIQUE），跑重建后约束正确
 *   2. **再跑一次 → 直接跳过**（幂等，不会重复重建）
 *   3. 重建前后**行数不变**、数据内容不变
 *   4. 重建后跨店同号可用、同店重复被拒
 *   5. 重建脚本自动生成备份
 *
 * ── 为什么需要这个测试 ──
 *
 * `rebuild-unique-constraints.mjs` 会重建生产环境的表（DROP + RENAME），
 * 是最危险的一个迁移。幂等性一旦有 bug，重复执行会：
 *   · 把数据复制两遍（如果 DROP 漏了）
 *   · 或者第二次执行时表名冲突直接报错
 *
 * 所以必须证明「跑一次正确、跑两次也正确」。
 *
 * 用法：node scripts/test-schema-rebuild-idempotent.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tmpDir = join(root, ".tmp");
const oldDb = join(tmpDir, `oldfmt-${Date.now()}.db`);

mkdirSync(tmpDir, { recursive: true });
for (const f of [oldDb, `${oldDb}-wal`, `${oldDb}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}  ${extra}`);
  }
};

/** 在指定库上跑重建脚本 */
function runRebuild(args = []) {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", "rebuild-unique-constraints.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PMS_DB_PATH: oldDb },
      timeout: 180_000,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

/* ─────────── 1. 造一个「旧格式」库（带列级 UNIQUE） ─────────── */
console.log(`旧格式库：${oldDb}\n`);
console.log("=== 1. 造旧格式库（单号列带列级 UNIQUE） ===\n");

const db = new DatabaseSync(oldDb);

/*
 * 故意按「第 4 轮之前的建表方式」创建三张表，
 * 只保留重建脚本会碰的字段（重建脚本用 SELECT * 复制，字段要齐全）。
 */
db.exec(`
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_no TEXT NOT NULL,
  room_type_id INTEGER
);
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  booking_no TEXT UNIQUE NOT NULL,
  guest_name TEXT,
  status TEXT DEFAULT 'PENDING'
);
CREATE TABLE stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  stay_no TEXT UNIQUE NOT NULL,
  guest_name TEXT,
  status TEXT DEFAULT 'INHOUSE'
);
CREATE TABLE folios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_no TEXT UNIQUE NOT NULL,
  guest_name TEXT,
  status TEXT DEFAULT 'OPEN'
);
CREATE UNIQUE INDEX idx_bookings_no ON bookings(hotel_id, booking_no);
CREATE INDEX idx_bookings_status ON bookings(hotel_id, status);
CREATE INDEX idx_stays_status ON stays(hotel_id, status);
CREATE INDEX idx_folios_stay ON folios(hotel_id);
`);

/*
 * 造 20 条数据（两家酒店各 10 条）
 *
 * ⚠️ 注意这里用的是**不同单号**（hotel 1 用 1-10，hotel 2 用 11-20）。
 *
 * 原因：旧格式库的单号是**列级 UNIQUE（全局唯一）**，如果两家酒店用同一个号，
 * 造数据这一步就会 `UNIQUE constraint failed` —— 这一点本身就是个证据：
 * 「旧格式确实不允许跨店同号，正是这轮要修的问题」。
 *
 * 重建之后再验证「跨店同号」才是有意义的（见第 6 步）。
 */
const insB = db.prepare(`INSERT INTO bookings (hotel_id, booking_no, guest_name, status) VALUES (?,?,?,?)`);
const insS = db.prepare(`INSERT INTO stays (hotel_id, stay_no, guest_name, status) VALUES (?,?,?,?)`);
const insF = db.prepare(`INSERT INTO folios (hotel_id, folio_no, guest_name, status) VALUES (?,?,?,?)`);
for (let i = 1; i <= 10; i++) {
  insB.run(1, `OLD-B-${i}`, `客人${i}`, "PENDING");
  insB.run(2, `OLD-B-${i + 10}`, `客人${i + 10}`, "CONFIRMED");
  insS.run(1, `OLD-S-${i}`, `客人${i}`, "INHOUSE");
  insS.run(2, `OLD-S-${i + 10}`, `客人${i + 10}`, "INHOUSE");
  insF.run(1, `OLD-F-${i}`, `客人${i}`, "OPEN");
  insF.run(2, `OLD-F-${i + 10}`, `客人${i + 10}`, "OPEN");
}

const before = {
  bookings: db.prepare(`SELECT COUNT(*) AS c FROM bookings`).get().c,
  stays: db.prepare(`SELECT COUNT(*) AS c FROM stays`).get().c,
  folios: db.prepare(`SELECT COUNT(*) AS c FROM folios`).get().c,
  /* 校验和：所有单号排序后拼起来，用于断言「内容没变」 */
  bookingsSum: db.prepare(`SELECT GROUP_CONCAT(booking_no, '|') AS s FROM (SELECT booking_no FROM bookings ORDER BY id)`).get().s,
};

function hasColumnUnique(conn, table, col) {
  const sql = conn.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table)?.sql ?? "";
  const line = sql.split("\n").find((l) => new RegExp(`^\\s*"?${col}"?\\s`, "i").test(l));
  return Boolean(line && /\bUNIQUE\b/i.test(line));
}

check("造库成功：bookings 20 行", before.bookings === 20, `实际 ${before.bookings}`);
check("造库成功：stays 20 行", before.stays === 20);
check("造库成功：folios 20 行", before.folios === 20);
check("造库成功：bookings.booking_no 带列级 UNIQUE", hasColumnUnique(db, "bookings", "booking_no"));
check("造库成功：stays.stay_no 带列级 UNIQUE", hasColumnUnique(db, "stays", "stay_no"));
check("造库成功：folios.folio_no 带列级 UNIQUE", hasColumnUnique(db, "folios", "folio_no"));

db.close();

/* ─────────── 2. 第一次重建 ─────────── */
console.log("\n=== 2. 第一次重建 ===\n");
const r1 = runRebuild();
if (!r1.ok) {
  console.log(r1.out);
}
check("第一次重建执行成功", r1.ok);
check("输出里有「重建 bookings」", r1.out.includes("重建 bookings"), r1.out.slice(-200));
check("输出里有「重建 stays」", r1.out.includes("重建 stays"));
check("输出里有「重建 folios」", r1.out.includes("重建 folios"));
check("输出里有「全部验证通过」", r1.out.includes("全部验证通过"), r1.out.slice(-200));

/* 备份文件存在 */
const backups = readdirSync(tmpDir).filter((f) => f.startsWith(`oldfmt-`) && f.includes(".bak-rebuild-"));
check("自动生成了备份文件", backups.length >= 1, `找到 ${backups.length} 个`);

/* ─────────── 3. 重建后的约束与数据 ─────────── */
console.log("\n=== 3. 重建后检查 ===\n");
const after = new DatabaseSync(oldDb, { readOnly: true });

check("重建后：bookings 列级 UNIQUE 已移除", !hasColumnUnique(after, "bookings", "booking_no"));
check("重建后：stays 列级 UNIQUE 已移除", !hasColumnUnique(after, "stays", "stay_no"));
check("重建后：folios 列级 UNIQUE 已移除", !hasColumnUnique(after, "folios", "folio_no"));

const afterCounts = {
  bookings: after.prepare(`SELECT COUNT(*) AS c FROM bookings`).get().c,
  stays: after.prepare(`SELECT COUNT(*) AS c FROM stays`).get().c,
  folios: after.prepare(`SELECT COUNT(*) AS c FROM folios`).get().c,
};
check("重建后行数不变：bookings", afterCounts.bookings === before.bookings, `${before.bookings} → ${afterCounts.bookings}`);
check("重建后行数不变：stays", afterCounts.stays === before.stays);
check("重建后行数不变：folios", afterCounts.folios === before.folios);

const afterSum = after.prepare(`SELECT GROUP_CONCAT(booking_no, '|') AS s FROM (SELECT booking_no FROM bookings ORDER BY id)`).get().s;
check("重建后数据内容不变（单号序列一致）", afterSum === before.bookingsSum);

/* 原有非单号索引是否被重建（idx_bookings_status / idx_stays_status / idx_folios_stay） */
const idxNames = after
  .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
  .all()
  .map((r) => r.name);
check("原有索引已重建：idx_bookings_status", idxNames.includes("idx_bookings_status"), idxNames.join(","));
check("原有索引已重建：idx_stays_status", idxNames.includes("idx_stays_status"));
check("原有索引已重建：idx_folios_stay", idxNames.includes("idx_folios_stay"));

/* 新组合唯一索引 */
check("新增组合索引：idx_stays_no", idxNames.includes("idx_stays_no"), idxNames.join(","));
check("新增组合索引：idx_folios_no", idxNames.includes("idx_folios_no"));
check("组合索引：idx_bookings_no（本来就有）", idxNames.includes("idx_bookings_no"));

after.close();

/* ─────────── 4. 第二次重建（幂等） ─────────── */
console.log("\n=== 4. 第二次重建（幂等验证） ===\n");
const r2 = runRebuild();
if (!r2.ok) {
  console.log(r2.out);
}
check("第二次重建执行成功（不报错）", r2.ok);
check("第二次重建识别为「已经是目标状态」", r2.out.includes("已经是目标状态"), r2.out.slice(-200));
check("第二次重建「需要重建：0 张」", r2.out.includes("需要重建：0 张"), r2.out.slice(-200));

/* 数据仍然完好 */
const final = new DatabaseSync(oldDb, { readOnly: true });
check("二次重建后 bookings 行数仍 20", final.prepare(`SELECT COUNT(*) AS c FROM bookings`).get().c === 20);
check("二次重建后 stays 行数仍 20", final.prepare(`SELECT COUNT(*) AS c FROM stays`).get().c === 20);
check("二次重建后 folios 行数仍 20", final.prepare(`SELECT COUNT(*) AS c FROM folios`).get().c === 20);
final.close();

/* ─────────── 5. --check 模式 ─────────── */
console.log("\n=== 5. --check 模式 ===\n");
const rc = runRebuild(["--check"]);
check("--check 执行成功", rc.ok);
check("--check 判为已是目标状态", rc.out.includes("已经是目标状态"));

/* ─────────── 6. 行为验证 ─────────── */
console.log("\n=== 6. 行为验证 ===\n");
const w = new DatabaseSync(oldDb);
w.exec("BEGIN");
let crossOk = false;
let sameRejected = false;
try {
  /* 已有 OLD-B-1 在 hotel 1 和 hotel 2；再插一条 hotel 3 的同号应成功 */
  insBAgain(w, 3, "OLD-B-1");
  crossOk = true;
  try {
    insBAgain(w, 1, "OLD-B-1");
    sameRejected = false;
  } catch {
    sameRejected = true;
  }
} finally {
  w.exec("ROLLBACK");
}
function insBAgain(conn, hotelId, no) {
  conn.prepare(`INSERT INTO bookings (hotel_id, booking_no, guest_name, status) VALUES (?,?,?,?)`).run(hotelId, no, "测试", "PENDING");
}
check("重建后：第三家店可用同号", crossOk);
check("重建后：同店重复被拒绝", sameRejected);
w.close();

/* ─────────── 清理 ─────────── */
for (const f of readdirSync(tmpDir)) {
  if (f.startsWith("oldfmt-")) {
    try {
      unlinkSync(join(tmpDir, f));
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(`（测试库在 .tmp 下创建并已删除，未影响 data/pms.db）\n`);
process.exit(fail === 0 ? 0 : 1);
