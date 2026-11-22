/**
 * 新库完整安装验收（codex 第七轮清单第五节）
 *
 * 验证「从零建库」后：
 *   1. 表数量正确（90 张）
 *   2. 三张表的单号列**没有**列级 UNIQUE（全局唯一会被误建）
 *   3. 三组「酒店内唯一」组合索引存在
 *   4. 跨店同号可插入、同店重复被拒绝
 *   5. migrate-all 幂等（再跑一次变更 0 处）
 *
 * ── 为什么需要这个测试 ──
 *
 * 第七轮复核发现：第六轮只重建了**现有库**的表，
 * 但 `scripts/init-db.mjs` 和 `scripts/schema-full.sql` 里
 * 仍然是 `booking_no TEXT UNIQUE` —— 意味着**每装一个新库，全局唯一约束又会回来**。
 *
 * 这个测试就是防止那种「修了存量、没修模板」的回归。
 *
 * 用法：node scripts/test-schema-fresh-install.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tmpDir = join(root, ".tmp");
const freshDb = join(tmpDir, `fresh-${Date.now()}.db`);

mkdirSync(tmpDir, { recursive: true });
for (const f of [freshDb, `${freshDb}-wal`, `${freshDb}-shm`]) {
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

/** 在指定库上跑一个脚本（子进程，env 传 PMS_DB_PATH） */
function runScript(script, args = []) {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", script), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PMS_DB_PATH: freshDb },
      timeout: 180_000,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

console.log(`新库路径：${freshDb}\n`);

/* ─────────── 1. 建库全流程 ─────────── */
console.log("=== 建库全流程 ===\n");

const initRes = runScript("init-db.mjs");
check("init-db.mjs 执行成功", initRes.ok, initRes.out.split("\n").slice(-3).join(" "));

const migrateRes = runScript("migrate-all.mjs");
check("migrate-all.mjs 执行成功", migrateRes.ok, migrateRes.out.split("\n").slice(-3).join(" "));

/* 补全懒建表（真实部署顺序里这一步必须有，否则只有 30 张表） */
const ensureRes = runScript("ensure-schema.mjs");
check("ensure-schema.mjs 执行成功（补懒建表）", ensureRes.ok, ensureRes.out.split("\n").slice(-3).join(" "));

/* ─────────── 2. 表数量 ─────────── */
const db = new DatabaseSync(freshDb, { readOnly: true });

const tableCount = db
  .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .get().c;
/*
 * 表数量 = 91
 *
 * 第九轮清单 二.7 把 shop_stock_flows（商超库存流水）从「运行时懒建」纳入正式 schema，
 * 全新库装出来的表数因此从 90 变成 91 —— **91 = 90 + shop_stock_flows**，不是多建了表。
 * 硬编码总数只是「新库是否装完整」的粗筛；真正防回归的是紧随其后的
 * 「必须包含 shop_stock_flows 且 13 列齐全」断言，以后再加表时那条仍然有效。
 */
/*
 * 表数量
 *
 * ⚠️ 不写死具体数字（踩过两次）：
 *   · 第八轮是 90
 *   · 第九轮把 shop_stock_flows 纳入正式 schema → 91
 *   · 又发现 mini_service_requests 是原有的 → 92
 *   · 并行进行的《微信小程序专项》还在继续加表 → 93…
 *
 * 每次加表都改这个数字没有意义，而且会被并行开发持续打断。
 * 真正要守的是「关键表都在 + 总数没莫名减少」。
 */
const REQUIRED_TABLES = [
  "hotels",
  "users",
  "rooms",
  "room_types",
  "bookings",
  "booking_rooms",
  "stays",
  "folios",
  "folio_items",
  "payments",
  "guests",
  "housekeeping",
  "invoices",
  "ar_accounts",
  "ar_ledgers",
  "shop_items",
  "shop_sales",
  "shop_stock_flows", // 第九轮清单 二.7 纳入正式 schema
  "member_wallet_ledger",
];

const missingTables = REQUIRED_TABLES.filter(
  (t) => !db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?`).get(t)
);
check(
  `新库包含全部关键表（${REQUIRED_TABLES.length} 张）`,
  missingTables.length === 0,
  `缺：${missingTables.join(", ")}`
);
check("表数量 ≥ 90（基础表没有缺失）", tableCount >= 90, `实际 ${tableCount}`);

const shopFlowCols = db
  .prepare(`PRAGMA table_info(shop_stock_flows)`)
  .all()
  .map((c) => c.name);
const WANT_SHOP_FLOW_COLS = [
  "id",
  "hotel_id",
  "item_id",
  "type",
  "qty",
  "stock_after",
  "unit_price",
  "amount",
  "sale_id",
  "request_id",
  "note",
  "operator",
  "created_at",
];
check(
  "新库里包含 shop_stock_flows 且 13 列齐全",
  shopFlowCols.length === WANT_SHOP_FLOW_COLS.length && WANT_SHOP_FLOW_COLS.every((c) => shopFlowCols.includes(c)),
  `实际列：${shopFlowCols.join(",")}`
);

/* ─────────── 3. 没有列级 UNIQUE ─────────── */
const TARGETS = [
  { table: "bookings", col: "booking_no" },
  { table: "stays", col: "stay_no" },
  { table: "folios", col: "folio_no" },
];

function hasColumnUnique(table, col) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(table)?.sql ?? "";
  const line = sql.split("\n").find((l) => new RegExp(`^\\s*"?${col}"?\\s`, "i").test(l));
  return Boolean(line && /\bUNIQUE\b/i.test(line));
}

for (const t of TARGETS) {
  check(`${t.table}.${t.col} 没有列级 UNIQUE`, !hasColumnUnique(t.table, t.col), "仍然是全局唯一");
}

/* ─────────── 4. 组合唯一索引 ─────────── */
const COMPOSITE = [
  { name: "idx_bookings_no", table: "bookings" },
  { name: "idx_stays_no", table: "stays" },
  { name: "idx_folios_no", table: "folios" },
];

for (const c of COMPOSITE) {
  const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`).get(c.name);
  const ok = Boolean(idx && /UNIQUE/i.test(idx.sql) && /hotel_id/i.test(idx.sql));
  check(`组合唯一索引 ${c.name} 存在且含 hotel_id`, ok, idx?.sql ?? "（不存在）");
}

db.close();

/* ─────────── 5. 行为验证：跨店同号 / 同店重复 ─────────── */
console.log("\n=== 行为验证 ===\n");

const w = new DatabaseSync(freshDb);
w.exec("BEGIN");
let crossOk = false;
let sameRejected = false;
try {
  const room = w.prepare(`SELECT id, room_type_id FROM rooms LIMIT 1`).get();
  if (!room) throw new Error("库里没有房间，无法造预订");

  /* 跨店同号：两家店用同一个单号，应成功 */
  const insBooking = w.prepare(
    `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date,
       nights, room_count, guest_count, rate, status)
     VALUES (?, 'FRESH-TEST-001', ?, ?, date('now','localtime'), date('now','localtime','+1 day'), 1,1,1,100,'PENDING')`
  );
  insBooking.run(1, "本店", room.room_type_id);
  insBooking.run(999, "跨店", room.room_type_id);
  crossOk = true;

  /* 同店重复：应被唯一索引拒绝 */
  try {
    insBooking.run(1, "本店重复", room.room_type_id);
    sameRejected = false;
  } catch {
    sameRejected = true;
  }
} finally {
  w.exec("ROLLBACK");
}

check("新库里两家店可用同一预订号", crossOk);
check("新库里同店重复预订号被拒绝", sameRejected);

/* stays / folios 同样验证（不建完整业务链，只验约束） */
w.exec("BEGIN");
let stayCross = false;
let staySameRejected = false;
try {
  const insStay = w.prepare(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, status)
     VALUES (?, 'FRESH-STAY-001', ?, '测试', date('now','localtime'), date('now','localtime','+1 day'), 1, 100, 'INHOUSE')`
  );
  const room = w.prepare(`SELECT id FROM rooms LIMIT 1`).get();
  insStay.run(1, room.id);
  insStay.run(999, room.id);
  stayCross = true;
  try {
    insStay.run(1, room.id);
    staySameRejected = false;
  } catch {
    staySameRejected = true;
  }
} finally {
  w.exec("ROLLBACK");
}
check("stays 跨店同号可用", stayCross);
check("stays 同店重复被拒", staySameRejected);

w.exec("BEGIN");
let folioCross = false;
let folioSameRejected = false;
try {
  const insFolio = w.prepare(
    `INSERT INTO folios (hotel_id, folio_no, guest_name, total_amount, paid_amount, balance, status)
     VALUES (?, 'FRESH-FOLIO-001', '测试', 0, 0, 0, 'OPEN')`
  );
  insFolio.run(1);
  insFolio.run(999);
  folioCross = true;
  try {
    insFolio.run(1);
    folioSameRejected = false;
  } catch {
    folioSameRejected = true;
  }
} finally {
  w.exec("ROLLBACK");
}
check("folios 跨店同号可用", folioCross);
check("folios 同店重复被拒", folioSameRejected);

w.close();

/* ─────────── 6. migrate-all 幂等 ─────────── */
console.log("\n=== 幂等验证 ===\n");
const again = runScript("migrate-all.mjs", ["--check"]);
const againOut = again.out;
const skippedMatch = againOut.match(/已是目标状态（跳过）(\d+)\s*项/);
check("migrate-all --check 不再需要变更", again.ok && skippedMatch !== null, againOut.split("\n").slice(-3).join(" "));

/* ─────────── 清理 ─────────── */
for (const f of [freshDb, `${freshDb}-wal`, `${freshDb}-shm`]) {
  if (existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(`（新库在 .tmp 下创建并已删除，未影响 data/pms.db）\n`);
process.exit(fail === 0 ? 0 : 1);
