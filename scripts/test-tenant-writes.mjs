/**
 * 整改指令 6.1 验收：所有 UPDATE / DELETE 必须带 hotel_id
 *
 * 三段：
 *   A 静态：扫描本次整改负责的文件，找出「只按 id 定位」的 UPDATE/DELETE（目标 0 处）
 *   B 行为：造假租户 hotel 9999，用它的上下文去改 hotel 1 的真实行，必须影响 0 行；
 *           再用同租户的正常上下文命中自己造的行，必须影响 1 行——
 *           正例用来证明「不是语句写坏了导致永远 0 行」，反例才说明租户条件真的生效。
 *   C 回归：node scripts/test-tenant-isolation.mjs 必须仍是 8/8
 *
 * 全程在一个事务里跑，最后 ROLLBACK，不改动生产数据。
 * 用法：node scripts/test-tenant-writes.mjs
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");

/** 本次整改负责的文件（其他文件由别人改，不在此断言） */
const OWN_FILES = [
  "src/app/(main)/cashier/actions.ts",
  "src/app/(main)/shop/actions.ts",
  "src/app/(main)/members/actions.ts",
  "src/app/(main)/companies/actions.ts",
  "src/app/(main)/finance/actions.ts",
  "src/app/(main)/inhouse/actions.ts",
  "src/app/(main)/night-audit/actions.ts",
  "src/app/(main)/invoices/actions.ts",
  "src/app/(main)/handover/actions.ts",
  "src/app/(main)/ar/actions.ts",
  "src/app/(main)/guests/actions.ts",
];

const pass = { n: 0 };
const fail = { n: 0 };
const failures = [];
function check(name, ok, extra = "") {
  if (ok) {
    pass.n++;
    console.log(`✅ ${name}`);
  } else {
    fail.n++;
    failures.push(name);
    console.log(`❌ ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}

const squash = (s) => s.replace(/\s+/g, " ").trim();
const readSrc = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/* ==========================================================================
 * A 段：静态扫描
 * ======================================================================== */

/**
 * 把源码里每条 UPDATE / DELETE 语句整体抠出来（以反引号或分号收尾），
 * 判断它是否「按 id 定位」且没有 hotel_id。
 *
 * 比 audit-gap.mjs 的 300 字窗口更严：多行 SQL、WHERE id IN (...) 批量语句都能覆盖。
 */
function findUnscopedWrites(src) {
  const hits = [];
  const re = /\b(UPDATE|DELETE\s+FROM)\s+(\w+)/gi;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    let end = start;
    while (end < src.length && src[end] !== "`" && src[end] !== ";") end++;
    const raw = squash(src.slice(start, end));
    // 只看按 id 定位的语句
    const byId = /\bid\s*=\s*\?/i.test(raw) || /\bid\s+IN\s*\(/i.test(raw);
    if (!byId) continue;
    if (/hotel_id/i.test(raw)) continue;
    hits.push({ line: src.slice(0, start).split("\n").length, kind: m[1].toUpperCase(), table: m[2], text: raw.slice(0, 240) });
  }
  return hits;
}

console.log("========== A 段：静态扫描（只按 id 定位的 UPDATE/DELETE）==========\n");
let aStatic = 0;
const missingFiles = [];
for (const rel of OWN_FILES) {
  let src = "";
  try {
    src = readSrc(rel);
  } catch {
    /*
     * 原来这里只打一句 ⚠️ 就 continue —— 假通过：
     * 目标文件被删除 / 改名 / 挪位置时，这个文件「0 处违规」自动算过，
     * A 段照样打 ✅（aStatic 仍是 0）。缺文件必须判红。
     */
    console.log(`❌ 文件不存在：${rel}`);
    missingFiles.push(rel);
    continue;
  }
  const hits = findUnscopedWrites(src);
  const brief = rel.replace("src/app/(main)/", "");
  if (hits.length === 0) {
    console.log(`✅ ${brief}`);
  } else {
    aStatic += hits.length;
    console.log(`❌ ${brief}  发现 ${hits.length} 处`);
    for (const h of hits) console.log(`     L${h.line} ${h.kind} ${h.table} — ${h.text}`);
  }
}
check(
  "A 段：负责文件内「只按 id 定位」的 UPDATE/DELETE = 0 处",
  aStatic === 0 && missingFiles.length === 0,
  `实际 ${aStatic} 处${missingFiles.length ? `，缺文件：${missingFiles.join(", ")}` : ""}`
);

/* ==========================================================================
 * B 段：行为验证
 * ======================================================================== */

/**
 * 审计出的 13 处修复点对应的 SQL（去重后 10 条唯一语句）。
 * args(id, hotelId) 只负责把 WHERE 的两个参数放到正确位置：
 *   - 反例：id = hotel 1 的真实行 id，hotelId = 9999（假租户）
 *   - 正例：id = hotel 9999 自己造的行 id，hotelId = 9999
 * sql 必须与源码里实际执行的语句逐字一致（下面会校验锚点）。
 */
const TARGETS = [
  {
    id: "cashier#pay 收款加分",
    file: "src/app/(main)/cashier/actions.ts",
    table: "folios",
    /* 第 4 轮 P0-1：收款不再手算 balance，只加 paid_amount 后调 recalcFolioBalance */
    sql: "UPDATE folios SET paid_amount = COALESCE(paid_amount,0) + ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [0, id, hotel],
  },
  {
    id: "cashier#refund 退款减分",
    file: "src/app/(main)/cashier/actions.ts",
    table: "folios",
    /* 第 4 轮 P0-1/P0-3：退款同样不再手算 balance */
    sql: "UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [0, id, hotel],
  },
  {
    id: "cashier#deposit 预收款累加（另有 partialSettle 同语句）",
    file: "src/app/(main)/cashier/actions.ts",
    table: "folios",
    sql: "UPDATE folios SET paid_amount = paid_amount + ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [0, id, hotel],
  },
  {
    id: "cashier#checkout 账单核销",
    file: "src/app/(main)/cashier/actions.ts",
    table: "folios",
    sql: "UPDATE folios SET status = 'SETTLED', settled_at = ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [null, id, hotel],
  },
  {
    id: "cashier#checkout 退房",
    file: "src/app/(main)/cashier/actions.ts",
    table: "stays",
    sql: "UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [null, id, hotel],
  },
  {
    id: "members#create/upgrade 会员等级（两处同语句）",
    file: "src/app/(main)/members/actions.ts",
    table: "guests",
    sql: "UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [2, id, hotel],
  },
  {
    id: "companies#delete 删除协议单位",
    file: "src/app/(main)/companies/actions.ts",
    table: "companies",
    sql: "DELETE FROM companies WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [id, hotel],
  },
  {
    id: "finance#settleAr AR 结清",
    file: "src/app/(main)/finance/actions.ts",
    table: "folios",
    sql: "UPDATE folios SET paid_amount = ?, balance = ?, status = ?, settled_at = ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [0, 0, "OPEN", null, id, hotel],
  },
  {
    id: "inhouse#extend 续住",
    file: "src/app/(main)/inhouse/actions.ts",
    table: "stays",
    sql: "UPDATE stays SET nights = ?, expect_check_out = ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [1, "2030-01-01", id, hotel],
  },
  {
    id: "inhouse#changeRoom 换房",
    file: "src/app/(main)/inhouse/actions.ts",
    table: "stays",
    sql: "UPDATE stays SET room_id = ? WHERE id = ? AND hotel_id = ?",
    args: (id, hotel) => [1, id, hotel],
  },
];

const BAD_HOTEL = 9999;
const PROD_HOTEL = 1;

console.log("\n========== B 段：行为验证（跨租户写入必须影响 0 行）==========\n");

/* 先校验每条 SQL 与源码逐字一致，防止脚本和代码各说各话 */
let anchorsOk = 0;
for (const t of TARGETS) {
  let src = "";
  try {
    src = squash(readSrc(t.file));
  } catch {
    /* 交给下面的断言报错 */
  }
  if (src.includes(t.sql)) anchorsOk++;
  else console.log(`⚠️  源码锚点未命中：${t.id}（${t.file}）`);
}
check(`B 段前置：${TARGETS.length} 条 SQL 与源码逐字一致`, anchorsOk === TARGETS.length, `命中 ${anchorsOk}/${TARGETS.length}`);

const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 5000");
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

/** 表上「单列且不含 hotel_id」的唯一索引列：复制到假租户时要改名避冲突 */
function uniqueSingleCols(table) {
  const cols = [];
  for (const idx of all(`PRAGMA index_list("${table}")`)) {
    if (!idx.unique) continue;
    const parts = all(`PRAGMA index_info("${idx.name}")`).map((c) => c.name);
    if (parts.length === 1 && parts[0] !== "hotel_id") cols.push(parts[0]);
  }
  return cols;
}

/** 把 hotel 1 的一条真实行复制成 hotel 9999 的同结构行，返回新 id */
function cloneToBadHotel(table, srcId, newId) {
  if (!srcId) throw new Error(`${table} 没有 hotel 1 的样本行`);
  const cols = all(`PRAGMA table_info("${table}")`)
    .map((c) => c.name)
    .filter((c) => c !== "id" && c !== "hotel_id");
  const uniq = uniqueSingleCols(table);
  const exprs = cols.map((c) => (uniq.includes(c) ? `'TNTEST-' || "${c}"` : `"${c}"`));
  const sql = `INSERT INTO "${table}" (id, hotel_id, ${cols.map((c) => `"${c}"`).join(", ")})
               SELECT ?, ?, ${exprs.join(", ")} FROM "${table}" WHERE id = ?`;
  run(sql, [newId, BAD_HOTEL, srcId]);
  return newId;
}

const results = [];
let scenarioError = "";

try {
  db.exec("BEGIN IMMEDIATE");

  // 1. 假租户（测试数据，事务结束回滚）
  run(`INSERT INTO hotels (id, code, name) VALUES (?, ?, ?)`, [BAD_HOTEL, "TNTEST", "多租户写入测试酒店"]);

  // 2. hotel 1 的真实样本行 id + 复制出 hotel 9999 的自有行
  const prodId = {};
  for (const table of ["folios", "stays", "guests", "companies"]) {
    prodId[table] = one(`SELECT id FROM "${table}" WHERE hotel_id = ? ORDER BY id LIMIT 1`, [PROD_HOTEL])?.id;
  }
  const ownId = {};
  let nextId = 900000;
  for (const table of Object.keys(prodId)) {
    ownId[table] = cloneToBadHotel(table, prodId[table], ++nextId);
  }

  // 3. 逐条试写
  for (const t of TARGETS) {
    const cross = run(t.sql, t.args(prodId[t.table], BAD_HOTEL));
    const same = run(t.sql, t.args(ownId[t.table], BAD_HOTEL));
    results.push({
      id: t.id,
      table: t.table,
      crossChanges: Number(cross.changes),
      sameChanges: Number(same.changes),
      prodId: prodId[t.table],
      ownId: ownId[t.table],
    });
  }
} catch (e) {
  scenarioError = e instanceof Error ? e.message : String(e);
  results.length = 0;
} finally {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* 已经回滚过 */
  }
  db.close();
}

if (scenarioError) {
  console.log(`❌ B 段场景搭建失败：${scenarioError}`);
}
for (const r of results) {
  console.log(`\n· ${r.id}`);
  console.log(`    SQL 目标表：${r.table}（hotel 1 真实行 id=${r.prodId}，hotel 9999 自有行 id=${r.ownId}）`);
  const crossOk = r.crossChanges === 0;
  const sameOk = r.sameChanges === 1;
  if (crossOk) console.log(`   跨租户写入（hotel 9999 → hotel 1 数据）：影响 ${r.crossChanges} 行  ✅`);
  if (sameOk) console.log(`   同租户写入（hotel 9999 → 自己数据）：  影响 ${r.sameChanges} 行  ✅（说明语句本身可正常命中）`);
  check(`B 段：${r.id} 跨租户影响 0 行`, crossOk, `实际 ${r.crossChanges} 行`);
  check(`B 段：${r.id} 同租户影响 1 行（正例）`, sameOk, `实际 ${r.sameChanges} 行`);
}

if (!scenarioError) check(`B 段：${TARGETS.length} 条语句全部完成试写`, results.length === TARGETS.length, `完成 ${results.length} 条`);

/* ==========================================================================
 * C 段：回归
 * ======================================================================== */

console.log("\n========== C 段：回归 test-tenant-isolation.mjs ==========\n");
const reg = spawnSync(process.execPath, [path.join("scripts", "test-tenant-isolation.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
});
const regOut = `${reg.stdout ?? ""}${reg.stderr ?? ""}`;
const regLine = regOut.split("\n").filter((l) => l.includes("通过")).pop() ?? "";
const regMatch = regOut.match(/通过 (\d+) \/ 失败 (\d+)/);
console.log(regOut.trim().split("\n").slice(-14).join("\n"));
check(
  "C 段：test-tenant-isolation.mjs 8/8 通过",
  Boolean(regMatch) && Number(regMatch[1]) === 8 && Number(regMatch[2]) === 0,
  regMatch ? `实际 ${regMatch[1]}/${regMatch[2]}` : `未解析到结果行（${regLine}）`
);

/* ==========================================================================
 * 汇总
 * ======================================================================== */
console.log("\n========================== 汇总 ==========================");
console.log(`A 段静态扫描文件：${OWN_FILES.length} 个，违规 ${aStatic} 处`);
console.log(`B 段行为验证语句：${TARGETS.length} 条（覆盖 13 处修复点）`);
console.log(`C 段回归：${regLine.trim() || "未取到"}`);
console.log(`\n通过 ${pass.n} / 失败 ${fail.n}`);
if (fail.n > 0) {
  console.log(`失败项：\n  - ${failures.join("\n  - ")}`);
}
process.exit(fail.n === 0 ? 0 : 1);
