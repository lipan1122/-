/**
 * 重建 bookings / stays / folios，去掉单号列的**全局 UNIQUE**
 *
 * ── 解决的问题 ──
 *
 * 这三张表的建表语句把单号写成了列级唯一：
 *     booking_no TEXT UNIQUE NOT NULL     ← 全局唯一
 *     stay_no    TEXT UNIQUE NOT NULL
 *     folio_no   TEXT UNIQUE NOT NULL
 *
 * 而设计意图是「酒店内唯一」。后果：多店部署时，hotel 999 想用 hotel 1
 * 已经用过的单号会直接 `UNIQUE constraint failed`。
 *
 * `src/lib/channels/booking-no.ts` 的注释早就写着「唯一索引按酒店隔离，
 * 两个酒店可以有同号预订」——但注释和实际约束不符。
 *
 * ── 为什么必须重建表 ──
 *
 * SQLite 不支持 `ALTER TABLE ... DROP CONSTRAINT`。
 * 列级 UNIQUE 是表定义的一部分，只能「建新表 → 复制 → 删旧表 → 改名」。
 *
 * ── 风险与缓解 ──
 *
 * · 备份：执行前自动 `VACUUM INTO data/pms.db.bak-rebuild-<时间戳>`
 * · 外键：本项目**没有任何外键声明**（PRAGMA foreign_key_list 全空），
 *   所以不存在「删表时被引用」的问题，也不需要临时关掉外键检查
 * · 幂等：已经是目标状态时直接跳过，不会重复重建
 * · 校验：重建后跑 `PRAGMA integrity_check` + 断言行数不变 + 断言约束生效
 *
 * ── 用法 ──
 *   node scripts/rebuild-unique-constraints.mjs --check   # 只看会不会做
 *   node scripts/rebuild-unique-constraints.mjs           # 实际执行（自动备份）
 *   PMS_DB_PATH=.tmp/x.db node scripts/rebuild-unique-constraints.mjs  # 在副本上跑
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbFile = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(dbFile)) {
  console.error(`数据库不存在：${dbFile}`);
  process.exit(1);
}

/**
 * 要重建的表 + 单号列 + 组合唯一索引名
 *
 * `compositeIndex` 是「酒店内唯一」需要的索引。bookings 已经有了
 * （idx_bookings_no），stays / folios 缺，重建时一并补上。
 */
const TARGETS = [
  { table: "bookings", col: "booking_no", compositeIndex: "idx_bookings_no", alreadyHasComposite: true },
  { table: "stays", col: "stay_no", compositeIndex: "idx_stays_no", alreadyHasComposite: false },
  { table: "folios", col: "folio_no", compositeIndex: "idx_folios_no", alreadyHasComposite: false },
];

const db = new DatabaseSync(dbFile);

/* ─────────── 判断是否需要重建 ─────────── */
function hasColumnUnique(table, col) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table)?.sql;
  if (!sql) return false;
  /*
   * 只在「列定义这一行」里找 UNIQUE。
   * 形如：  booking_no TEXT UNIQUE NOT NULL,
   * 不能简单全文 grep "UNIQUE" —— 表里可能有别的组合唯一。
   */
  const line = sql.split("\n").find((l) => new RegExp(`^\\s*"?${col}"?\\s`, "i").test(l));
  return Boolean(line && /\bUNIQUE\b/i.test(line));
}

const need = TARGETS.filter((t) => hasColumnUnique(t.table, t.col));

console.log(`数据库：${dbFile}`);
console.log(`需要重建：${need.length} 张`);
need.forEach((t) => console.log(`  · ${t.table}.${t.col} 有列级 UNIQUE`));
if (need.length === 0) {
  console.log(`\n✅ 已经是目标状态（三张表的单号列都没有全局 UNIQUE），无需重建\n`);
  db.close();
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(`\n（--check 模式，未做任何修改）`);
  console.log(`会做的事：`);
  console.log(`  1. VACUUM INTO 备份 → ${dbFile}.bak-rebuild-<时间戳>`);
  need.forEach((t) => {
    console.log(`  2. 重建 ${t.table}：去掉 ${t.col} 的列级 UNIQUE，保留其余列定义与数据`);
    if (!t.alreadyHasComposite) console.log(`     并新建组合唯一索引 ${t.compositeIndex}(hotel_id, ${t.col})`);
  });
  console.log(`  3. PRAGMA integrity_check + 行数比对 + 约束生效验证`);
  db.close();
  process.exit(0);
}

/* ─────────── 1. 备份 ─────────── */
mkdirSync(dirname(dbFile), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${dbFile}.bak-rebuild-${ts}`;
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\n✅ 已备份 → ${backup}`);

/* ─────────── 2. 逐表重建 ─────────── */
function rebuild(target) {
  const { table, col, compositeIndex, alreadyHasComposite } = target;

  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table).sql;
  const oldCount = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;

  /*
   * 生成新表 DDL：把目标列上的 UNIQUE 去掉
   *
   * 只改那一行，其余列定义逐字保留（包括 DEFAULT / NOT NULL / 类型）。
   * 这样能保证重建后的表与原表除了这一个约束外完全一致。
   */
  const newDdlRaw = ddl
    .split("\n")
    .map((line) => {
      const isTargetLine = new RegExp(`^\\s*"?${col}"?\\s`, "i").test(line);
      if (!isTargetLine) return line;
      /* 去掉 UNIQUE（连同前面可能的空白），保留其他修饰词 */
      return line.replace(/\s+UNIQUE\b/i, "");
    })
    .join("\n");

  const newTable = `${table}__rebuild`;
  /* 把 CREATE TABLE "bookings" 换成 CREATE TABLE bookings__rebuild */
  const createNew = newDdlRaw.replace(
    new RegExp(`^CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${table}["\`]?`, "i"),
    `CREATE TABLE ${newTable}`
  );

  /* 索引定义要留到最后重建（列名不变，可以直接用原 SQL） */
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`
    )
    .all(table)
    .map((r) => ({ name: r.name, sql: r.sql }));

  db.exec("BEGIN IMMEDIATE");
  try {
    /* 2a. 建新表（先删掉上次失败的残留） */
    db.exec(`DROP TABLE IF EXISTS ${newTable}`);
    db.exec(createNew);

    /* 2b. 复制数据（列名逐字相同，用 SELECT *） */
    db.exec(`INSERT INTO ${newTable} SELECT * FROM "${table}"`);

    /* 2c. 校验行数 */
    const newCount = db.prepare(`SELECT COUNT(*) AS c FROM ${newTable}`).get().c;
    if (newCount !== oldCount) {
      throw new Error(`行数不一致：原 ${oldCount} / 新 ${newCount}`);
    }

    /* 2d. 删旧表 + 改名 */
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE ${newTable} RENAME TO "${table}"`);

    /* 2e. 重建索引（keep: 原索引可能包含已被删掉的列？这里列没变，直接重建） */
    for (const idx of indexes) {
      db.exec(idx.sql);
    }

    /* 2f. 补组合唯一索引（stays / folios 缺，bookings 已有） */
    if (!alreadyHasComposite) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${compositeIndex} ON "${table}"(hotel_id, ${col})`);
    }

    db.exec("COMMIT");
    console.log(`\n✅ 重建 ${table}：${oldCount} 行，索引 ${indexes.length} 个` + (alreadyHasComposite ? "" : `，新增 ${compositeIndex}`));
    return true;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 可能已自动回滚 */
    }
    console.error(`\n❌ 重建 ${table} 失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

let ok = true;
for (const t of need) {
  if (!rebuild(t)) {
    ok = false;
    break;
  }
}

if (!ok) {
  console.error(`\n⚠️ 重建中断。数据库可能处于部分重建状态，请用备份恢复：`);
  console.error(`   cp ${backup} ${dbFile}`);
  console.error(`   rm -f ${dbFile}-wal ${dbFile}-shm`);
  db.close();
  process.exit(1);
}

/* ─────────── 3. 验证 ─────────── */
console.log(`\n${"=".repeat(56)}\n验证\n${"=".repeat(56)}`);

/* 3a. 完整性 */
const integrity = db.prepare(`PRAGMA integrity_check`).get();
const integrityOk = integrity?.integrity_check === "ok";

/* 3b. 外键检查（本项目没有外键，应该返回空） */
let fkViolations = [];
try {
  fkViolations = db.prepare(`PRAGMA foreign_key_check`).all();
} catch {
  /* 老版本 SQLite 可能不支持 */
}

/* 3c. 列级 UNIQUE 是否真的没了 */
const stillUnique = TARGETS.filter((t) => hasColumnUnique(t.table, t.col));

/* 3d. 组合唯一索引是否存在 */
const compositeOk = TARGETS.every((t) => {
  const idx = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name = ?`).get(t.compositeIndex);
  return Boolean(idx);
});

/*
 * 3e. 行为验证：用事务插入两条同号数据，一个同酒店（应失败）
 *     一个不同酒店（应成功），然后回滚
 */
let crossHotelOk = false;
let sameHotelRejected = false;
db.exec("BEGIN");
try {
  const room = db.prepare(`SELECT id, room_type_id FROM rooms WHERE hotel_id = 1 LIMIT 1`).get();
  /* 跨店同号 */
  db
    .prepare(
      `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date,
         nights, room_count, guest_count, rate, status)
       VALUES (999, 'ZZ-TEST-UNIQUE', '跨店测试', ?, date('now','localtime'), date('now','localtime','+1 day'), 1,1,1,100,'PENDING')`
    )
    .run(room.room_type_id);
  db
    .prepare(
      `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date,
         nights, room_count, guest_count, rate, status)
       VALUES (1, 'ZZ-TEST-UNIQUE', '本店测试', ?, date('now','localtime'), date('now','localtime','+1 day'), 1,1,1,100,'PENDING')`
    )
    .run(room.room_type_id);
  crossHotelOk = true;

  /* 同店重复（应被拒） */
  try {
    db
      .prepare(
        `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date,
           nights, room_count, guest_count, rate, status)
         VALUES (1, 'ZZ-TEST-UNIQUE', '同店重复', ?, date('now','localtime'), date('now','localtime','+1 day'), 1,1,1,100,'PENDING')`
      )
      .run(room.room_type_id);
    sameHotelRejected = false;
  } catch {
    sameHotelRejected = true;
  }
} finally {
  db.exec("ROLLBACK");
}

console.log(`  完整性检查：${integrityOk ? "✅ ok" : "❌ " + JSON.stringify(integrity)}`);
console.log(`  外键违规：${fkViolations.length === 0 ? "✅ 0 条" : "❌ " + fkViolations.length + " 条"}`);
console.log(`  列级 UNIQUE 已移除：${stillUnique.length === 0 ? "✅" : "❌ 仍在：" + stillUnique.map((t) => t.table).join(", ")}`);
console.log(`  组合唯一索引齐备：${compositeOk ? "✅" : "❌"}`);
console.log(`  跨店同号可插入：${crossHotelOk ? "✅" : "❌"}`);
console.log(`  同店重复被拒绝：${sameHotelRejected ? "✅" : "❌"}`);

db.close();

const allOk = integrityOk && fkViolations.length === 0 && stillUnique.length === 0 && compositeOk && crossHotelOk && sameHotelRejected;
console.log(allOk ? `\n✅ 迁移完成，全部验证通过\n` : `\n❌ 验证未通过，请用备份恢复：${backup}\n`);
process.exit(allOk ? 0 : 1);
