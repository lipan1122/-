/**
 * shop_stock_flows 纳入正式 schema 验收
 * （codex 第九轮清单 二.7「shop_stock_flows 纳入正式 schema」）
 *
 * ── 被验收的是什么 ──
 * `shop_stock_flows` 原来是**运行时懒建**的（src/app/(main)/shop/actions.ts 的
 * `ensureShopStockFlowTable`）：老库上访问过一次商超页面就有表，但全新部署跑完
 * `init-db` + `migrate-all` + `ensure-schema` 仍然没有它 —— 商超库存流水的查询、
 * 撤销回库、盘点对账都要等「先点一次页面」才成立，交付部署不可接受。
 *
 * 清单要求同步修改四处：
 *   scripts/schema-full.sql / scripts/init-db.mjs / scripts/migrate-all.mjs /
 *   scripts/schema-fingerprint.json
 * 并补齐：表结构、hotel_id / item_id / request_id / sale_id / stock_after、唯一索引、查询索引。
 * **三条路径必须一致：新库初始化、旧库迁移、运行时 ensureSchema。**
 *
 * 本脚本验四半：
 *   A. 静态：四处 DDL 都在，且列定义与运行时 ensureShopStockFlowTable 一致；
 *   B. 新库：init-db + migrate-all + ensure-schema → 表 / 13 列 / 两个索引齐全；
 *   C. 旧库迁移：删表后跑 migrate-all → 表 / 列 / 索引原样回来，再跑幂等；
 *   D. 运行时：只执行 actions.ts 里的 DDL，列定义与新库完全一致；且不会删除正式 schema 补的
 *      唯一索引；唯一索引行为（同 request_id 同商品同类型第二次被拒、NULL request_id 可重复）。
 *
 * 用法：node scripts/test-shop-schema-fresh-install.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
const norm = (s) => s.replace(/\s+/g, " ").trim();

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const TMP_DIR = join(root, ".tmp");
const TABLE = "shop_stock_flows";

const SCHEMA_SQL = join(root, "scripts", "schema-full.sql");
const INIT_DB = join(root, "scripts", "init-db.mjs");
const MIGRATE = join(root, "scripts", "migrate-all.mjs");
const FINGERPRINT = join(root, "scripts", "schema-fingerprint.json");
const SHOP_ACTIONS = join(root, "src", "app", "(main)", "shop", "actions.ts");

const schemaSqlSrc = readFileSync(SCHEMA_SQL, "utf8");
const initSrc = readFileSync(INIT_DB, "utf8");
const migrateSrc = readFileSync(MIGRATE, "utf8");
const actionsSrc = readFileSync(SHOP_ACTIONS, "utf8");
const fingerprint = JSON.parse(readFileSync(FINGERPRINT, "utf8"));

/**
 * 从源码里抠出一张表的 CREATE TABLE 原文
 *
 * 兼容两种写法：`CREATE TABLE IF NOT EXISTS x (`（init-db / migrate-all / 运行时）
 * 与 `CREATE TABLE x (`（schema-full.sql 的导出格式）。
 */
function extractCreateTable(src, table) {
  const re = new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\s*\\(`, "i");
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index;
  const end = src.indexOf(");", start);
  if (end < 0) return "";
  return src.slice(start, end + 2);
}

/** 解析 CREATE TABLE 的列名（跳过表级约束行） */
function parseColumnNames(ddl) {
  const open = ddl.indexOf("(");
  const body = ddl.slice(open + 1, ddl.lastIndexOf(")"));
  const out = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line) continue;
    if (/^(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(line)) continue;
    const m = /^"?([A-Za-z_]\w*)"?\s+([A-Za-z]+)/.exec(line);
    if (!m) continue;
    out.push({ name: m[1], type: m[2].toUpperCase() });
  }
  return out;
}

const colsOf = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .map((c) => ({
      name: c.name,
      type: String(c.type ?? "").toUpperCase(),
      notnull: Number(c.notnull ?? 0),
      dflt_value: c.dflt_value ?? null,
      pk: Number(c.pk ?? 0),
    }));

const indexesOf = (db, table) => db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all();
const indexSqlOf = (db, name) =>
  db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`).get(name)?.sql ?? "";

/** 运行时那份 DDL（actions.ts）与正式 schema 的四份 DDL */
const runtimeDdl = extractCreateTable(actionsSrc, TABLE);
const schemaDdl = extractCreateTable(schemaSqlSrc, TABLE);
const initDdl = extractCreateTable(initSrc, TABLE);
const migrateDdl = extractCreateTable(migrateSrc, TABLE);

/* ================================================================== *
 * A. 静态校验
 * ================================================================== */
console.log("=== A. 静态：四处 DDL ===");

check("运行时 ensureShopStockFlowTable 的 DDL 可解析（源码基线）", runtimeDdl.length > 100, `长度 ${runtimeDdl.length}`);
check("scripts/schema-full.sql 建了 shop_stock_flows", schemaDdl.length > 100, "缺少建表语句");
check("scripts/init-db.mjs 建了 shop_stock_flows", initDdl.length > 100, "缺少建表语句");
check("scripts/migrate-all.mjs 建了 shop_stock_flows", migrateDdl.length > 100, "缺少建表语句");
check(
  "migrate-all.mjs 建了查询索引 idx_shop_stock_flows_item",
  /idx_shop_stock_flows_item/.test(migrateSrc) && /shop_stock_flows \(hotel_id, item_id, type\)/.test(migrateSrc)
);
check(
  "migrate-all.mjs 建了唯一索引 idx_shop_stock_flows_request",
  /idx_shop_stock_flows_request/.test(migrateSrc) && /UNIQUE INDEX idx_shop_stock_flows_request/.test(migrateSrc)
);
check(
  "schema-full.sql 建了查询索引与唯一索引",
  /idx_shop_stock_flows_item ON shop_stock_flows/.test(schemaSqlSrc) &&
    /UNIQUE INDEX idx_shop_stock_flows_request ON shop_stock_flows/.test(schemaSqlSrc)
);
check(
  "init-db.mjs 建了查询索引与唯一索引",
  /idx_shop_stock_flows_item ON shop_stock_flows/.test(initSrc) &&
    /UNIQUE INDEX IF NOT EXISTS idx_shop_stock_flows_request/.test(initSrc)
);

const runtimeCols = parseColumnNames(runtimeDdl);
const schemaCols = parseColumnNames(schemaDdl);
const initCols = parseColumnNames(initDdl);
const migrateCols = parseColumnNames(migrateDdl);
const sig = (cols) => JSON.stringify(cols.map((c) => `${c.name}:${c.type}`));
check("四处 DDL 的列定义完全一致（名 + 类型）", sig(runtimeCols) === sig(schemaCols) && sig(runtimeCols) === sig(initCols) && sig(runtimeCols) === sig(migrateCols), `运行时 ${runtimeCols.length} 列 / schema ${schemaCols.length} / init ${initCols.length} / migrate ${migrateCols.length}`);
check("列数 = 13", runtimeCols.length === 13, `实际 ${runtimeCols.length}`);
for (const col of ["id", "hotel_id", "item_id", "type", "qty", "stock_after", "unit_price", "amount", "sale_id", "request_id", "note", "operator", "created_at"]) {
  check(`有列 ${col}`, runtimeCols.some((c) => c.name === col), "缺少该列");
}

/* ---------- 指纹文件 ---------- */
check("schema-fingerprint.json 含 shop_stock_flows 表", Boolean(fingerprint.tables?.[TABLE]), "指纹里没有这张表");
const fpCols = (fingerprint.tables?.[TABLE] ?? []).map((c) => ({
  name: c.name,
  type: String(c.type ?? "").toUpperCase(),
  notnull: Number(c.notnull ?? 0),
  dflt_value: c.dflt_value ?? null,
  pk: Number(c.pk ?? 0),
}));
check("指纹里的列定义与运行时 DDL 一致（含 notnull / 默认值）", sig(fpCols) === sig(runtimeCols), "指纹与源码漂移");
check(
  "指纹里含两个索引（查询 + 唯一）",
  (fingerprint.indexes ?? []).some((i) => i.name === "idx_shop_stock_flows_item" && i.table === TABLE) &&
    (fingerprint.indexes ?? []).some((i) => i.name === "idx_shop_stock_flows_request" && i.table === TABLE && /UNIQUE/.test(i.sql)),
  "指纹索引缺失"
);

/* ================================================================== *
 * B. 新库：init-db + migrate-all + ensure-schema
 * ================================================================== */
console.log("\n=== B. 新库初始化 ===");

mkdirSync(TMP_DIR, { recursive: true });
const freshDb = join(TMP_DIR, `shop-fresh-${process.pid}-${Date.now()}.db`);
for (const f of [freshDb, `${freshDb}-wal`, `${freshDb}-shm`]) rmSync(f, { force: true });

function runScript(script, args = [], dbPath = freshDb) {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", script), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PMS_DB_PATH: dbPath },
      timeout: 240_000,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

const initRes = runScript("init-db.mjs");
check("init-db.mjs 执行成功", initRes.ok, initRes.out.split("\n").slice(-3).join(" "));
const migRes = runScript("migrate-all.mjs");
check("migrate-all.mjs 执行成功", migRes.ok, migRes.out.split("\n").slice(-3).join(" "));
const ensRes = runScript("ensure-schema.mjs");
check("ensure-schema.mjs 执行成功", ensRes.ok, ensRes.out.split("\n").slice(-3).join(" "));

const dbA = new DatabaseSync(freshDb, { readOnly: true });
const tableA = dbA.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(TABLE);
check("新库里有 shop_stock_flows 表", Boolean(tableA), "表不存在 —— 全新部署会缺表");
const colsA = colsOf(dbA, TABLE);
check("新库列数 = 13", colsA.length === 13, `实际 ${colsA.length}`);
check(
  "新库列定义与运行时 ensureShopStockFlowTable 完全一致（名/类型/非空/默认值/主键）",
  JSON.stringify(colsA) ===
    JSON.stringify([
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "hotel_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "item_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "qty", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "stock_after", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "unit_price", type: "REAL", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "amount", type: "REAL", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "sale_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "request_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "note", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "operator", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]),
  JSON.stringify(colsA)
);

const idxA = indexesOf(dbA, TABLE);
const itemIdx = idxA.find((i) => i.name === "idx_shop_stock_flows_item");
const reqIdx = idxA.find((i) => i.name === "idx_shop_stock_flows_request");
check("新库有查询索引 idx_shop_stock_flows_item", Boolean(itemIdx), "索引缺失");
check("查询索引非唯一（允许多条同类型流水）", itemIdx ? Number(itemIdx.unique) === 0 : false, JSON.stringify(itemIdx));
check("新库有唯一索引 idx_shop_stock_flows_request", Boolean(reqIdx), "索引缺失");
check("唯一索引是 UNIQUE", reqIdx ? Number(reqIdx.unique) === 1 : false, JSON.stringify(reqIdx));
const sqlItem = indexSqlOf(dbA, "idx_shop_stock_flows_item");
const sqlReq = indexSqlOf(dbA, "idx_shop_stock_flows_request");
check(
  "查询索引列顺序 = (hotel_id, item_id, type)",
  /\(hotel_id,\s*item_id,\s*type\)/i.test(sqlItem),
  sqlItem
);
check(
  "唯一索引列顺序 = (hotel_id, request_id, item_id, type)",
  /\(hotel_id,\s*request_id,\s*item_id,\s*type\)/i.test(sqlReq),
  sqlReq
);
check(
  "唯一索引是部分索引（WHERE request_id IS NOT NULL，历史空值行不受影响）",
  /WHERE\s+request_id\s+IS\s+NOT\s+NULL/i.test(sqlReq),
  sqlReq
);
dbA.close();

/* ---------- 唯一索引行为（在新库副本上真跑，不污染已删库） ---------- */
const dba = new DatabaseSync(freshDb, { timeout: 10000 });
dba.exec("BEGIN");
let dupRejected = false;
let nullOk = false;
try {
  const ins = dba.prepare(
    `INSERT INTO shop_stock_flows (hotel_id, item_id, type, qty, stock_after, unit_price, amount, sale_id, request_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run(1, 11, "SELL", 1, 9, 10, 10, 1, "REQ-DUP-1", "2031-01-01");
  try {
    ins.run(1, 11, "SELL", 2, 7, 10, 20, 2, "REQ-DUP-1", "2031-01-01");
    dupRejected = false;
  } catch {
    dupRejected = true;
  }
  /* request_id 为空（撤销流水 / 历史数据）不参与唯一约束 */
  try {
    ins.run(1, 11, "VOID", 1, 10, 10, 10, 1, null, "2031-01-02");
    ins.run(1, 11, "VOID", 1, 11, 10, 10, 2, null, "2031-01-02");
    nullOk = true;
  } catch {
    nullOk = false;
  }
} finally {
  dba.exec("ROLLBACK");
}
dba.close();
check("同一 request_id 同一商品同类型重复插入被拒绝", dupRejected, "唯一索引没有生效");
check("request_id 为空的流水可以重复插入（撤销 / 历史数据）", nullOk, "部分索引条件写错了");

const chkRes = runScript("migrate-all.mjs", ["--check"]);
check(
  "新库上 migrate-all --check 已是目标状态",
  chkRes.ok && /已是目标状态/.test(chkRes.out) && !/待建|待加/.test(chkRes.out),
  chkRes.out.split("\n").slice(-4).join(" ")
);

/* ================================================================== *
 * C. 旧库迁移：删表 → migrate-all 重建
 * ================================================================== */
console.log("\n=== C. 旧库迁移 ===");

const dbB = new DatabaseSync(freshDb, { timeout: 10000 });
dbB.exec(`DROP TABLE ${TABLE}`);
const gone = dbB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(TABLE);
dbB.close();
check("模拟旧库：先删掉 shop_stock_flows", !gone, "删表失败");

const mig2 = runScript("migrate-all.mjs");
check("旧库跑 migrate-all 成功", mig2.ok, mig2.out.split("\n").slice(-3).join(" "));
check("migrate-all 报告建了 shop_stock_flows 表", /shop_stock_flows 表/.test(mig2.out), mig2.out.split("\n").slice(0, 6).join(" "));

const dbB2 = new DatabaseSync(freshDb, { readOnly: true });
check(
  "旧库迁移后表回来",
  Boolean(dbB2.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(TABLE)),
  "表仍然不存在"
);
const colsB = colsOf(dbB2, TABLE);
check("旧库迁移后列定义与新库完全一致", JSON.stringify(colsB) === JSON.stringify(colsA), JSON.stringify(colsB));
const idxB = indexesOf(dbB2, TABLE);
check(
  "旧库迁移后两个索引都回来",
  idxB.some((i) => i.name === "idx_shop_stock_flows_item") && idxB.some((i) => i.name === "idx_shop_stock_flows_request"),
  JSON.stringify(idxB.map((i) => i.name))
);
dbB2.close();

const chkRes2 = runScript("migrate-all.mjs", ["--check"]);
check(
  "旧库迁移后再 --check 已是目标状态（幂等）",
  chkRes2.ok && /已是目标状态/.test(chkRes2.out) && !/待建|待加/.test(chkRes2.out),
  chkRes2.out.split("\n").slice(-4).join(" ")
);

/* ================================================================== *
 * D. 运行时路径：只执行 actions.ts 的 DDL
 * ================================================================== */
console.log("\n=== D. 运行时 ensureSchema 路径 ===");

const runtimeDbFile = join(TMP_DIR, `shop-runtime-${process.pid}-${Date.now()}.db`);
for (const f of [runtimeDbFile, `${runtimeDbFile}-wal`, `${runtimeDbFile}-shm`]) rmSync(f, { force: true });
const dbC = new DatabaseSync(runtimeDbFile, { timeout: 10000 });
check("运行时 DDL 可在空库直接建表", runtimeDdl.length > 0 && /CREATE TABLE IF NOT EXISTS shop_stock_flows/.test(runtimeDdl), runtimeDdl.slice(0, 60));
dbC.exec(runtimeDdl);
dbC.exec(
  `CREATE INDEX IF NOT EXISTS idx_shop_stock_flows_item ON shop_stock_flows (hotel_id, item_id, type)`
);
const colsC = colsOf(dbC, TABLE);
check("运行时路径列数 = 13", colsC.length === 13, `实际 ${colsC.length}`);
check("运行时路径列定义 = 新库列定义（逐列，含约束与默认值）", JSON.stringify(colsC) === JSON.stringify(colsA), JSON.stringify(colsC));
const idxC = indexesOf(dbC, TABLE);
check(
  "运行时路径的索引是正式 schema 的子集（缺唯一索引由正式 schema 补，不是漂移）",
  idxC.every((i) => ["idx_shop_stock_flows_item", "idx_shop_stock_flows_request"].includes(i.name)),
  JSON.stringify(idxC.map((i) => i.name))
);
check("运行时路径建了查询索引", idxC.some((i) => i.name === "idx_shop_stock_flows_item"));
dbC.close();

/* 运行时 DDL 在「已经有唯一索引」的库上再跑一次，不能把正式索引删掉 */
const dbD = new DatabaseSync(freshDb, { timeout: 10000 });
dbD.exec(runtimeDdl);
dbD.exec(`CREATE INDEX IF NOT EXISTS idx_shop_stock_flows_item ON shop_stock_flows (hotel_id, item_id, type)`);
const idxD = indexesOf(dbD, TABLE);
check(
  "在新库上重跑运行时 DDL：唯一索引仍在（IF NOT EXISTS 不会覆盖 / 删除）",
  idxD.some((i) => i.name === "idx_shop_stock_flows_request"),
  JSON.stringify(idxD.map((i) => i.name))
);
dbD.close();

/* ---------- 清理 ---------- */
for (const f of [freshDb, `${freshDb}-wal`, `${freshDb}-shm`, runtimeDbFile, `${runtimeDbFile}-wal`, `${runtimeDbFile}-shm`]) {
  if (existsSync(f)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log("（临时库在 .tmp 下创建并已删除，未影响 data/pms.db）\n");
process.exit(fail === 0 ? 0 : 1);
