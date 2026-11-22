/**
 * 整改指令 6.1 验收（第二批 23 处）：UPDATE / DELETE 必须带 hotel_id
 *
 * 覆盖本次收尾的 23 处（settings / mini-auth / page.tsx 内联 action 等）：
 *   A 静态：23 处逐条锚点校验——22 处必须带 hotel_id，1 处（hotels 表）登记为豁免
 *           并在文件中确认有中文注释说明；同时用比 audit-gap 更严的扫描器复查
 *           这 11 个文件，确认没有漏网的「只按 id 定位」写操作。
 *   B 行为：造两家测试酒店（9998 / 9999）的同构数据，
 *           - 反例：A 店的行 id + B 店的 hotelId → 必须影响 0 行
 *           - 正例：B 店自己的行 id + B 店的 hotelId → 必须影响 1 行
 *           正例用来证明语句本身能正常命中，反例才说明租户条件真的生效。
 *   C 零残留：ROLLBACK 之后确认 9998 / 9999 的数据与酒店行全部消失。
 *
 * 全程一个事务（BEGIN IMMEDIATE ... ROLLBACK），不写生产租户（hotel 1）的任何行。
 * 用法：node scripts/test-tenant-writes2.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");

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
 * A 段：静态锚点
 * ======================================================================== */

/** 本次负责的文件（23 处分布在这 11 个文件里） */
const OWN_FILES = [
  "src/app/(main)/channels/actions.ts",
  "src/app/(main)/dummy-rooms/actions.ts",
  "src/app/(main)/lease/page.tsx",
  "src/app/(main)/lock-settings/actions.ts",
  "src/app/(main)/lost-found/actions.ts",
  "src/app/(main)/meal-vouchers/page.tsx",
  "src/app/(main)/notices/actions.ts",
  "src/app/(main)/quotes/actions.ts",
  "src/app/(main)/rooms/forecast/actions.ts",
  "src/app/(main)/settings/actions.ts",
  "src/lib/mini-auth.ts",
];

/**
 * 23 处修复点。count = 同一语句在文件里出现的次数（settings 三处同语句、mini-auth 两处同语句）。
 * sql 必须与源码逐字一致（空白归一化后 includes），防止脚本和代码各说各话。
 */
const PLACES = [
  {
    id: "channels#importOneOrder 渠道订单转预订",
    file: "src/app/(main)/channels/actions.ts",
    table: "channel_orders",
    sql: "UPDATE channel_orders SET status = 'IMPORTED', booking_id = ?, imported_at = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [null, null, id, hotel],
  },
  {
    id: "channels#toggleAutoImport 自动接单开关",
    file: "src/app/(main)/channels/actions.ts",
    table: "channels",
    sql: "UPDATE channels SET auto_import = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [0, id, hotel],
  },
  {
    id: "dummy-rooms#create 编码重复时复用",
    file: "src/app/(main)/dummy-rooms/actions.ts",
    table: "dummy_rooms",
    sql: "UPDATE dummy_rooms SET name = ?, category = ?, note = ?, status = 'ACTIVE' WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => ["TNTEST-改", "其他", null, id, hotel],
  },
  {
    id: "dummy-rooms#toggle 启用停用",
    file: "src/app/(main)/dummy-rooms/actions.ts",
    table: "dummy_rooms",
    sql: "UPDATE dummy_rooms SET status = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => ["DISABLED", id, hotel],
  },
  {
    id: "lease#return 租赁归还（page.tsx 内联 server action）",
    file: "src/app/(main)/lease/page.tsx",
    table: "lease_records",
    sql: "UPDATE lease_records SET status = 'RETURNED', returned_at = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => ["2030-01-01", id, hotel],
  },
  {
    id: "lock-settings#bindLock 重绑门锁",
    file: "src/app/(main)/lock-settings/actions.ts",
    table: "lock_devices",
    sql: "UPDATE lock_devices SET lock_code = ?, status = 'BOUND', bound_at = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => ["TNTEST-LK", null, id, hotel],
  },
  {
    id: "lost-found#markReturned 失物归还",
    file: "src/app/(main)/lost-found/actions.ts",
    table: "lost_items",
    sql: "UPDATE lost_items SET status = 'RETURNED' WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [id, hotel],
  },
  {
    id: "meal-vouchers#verifyBreakfast 早餐核销（page.tsx 内联 server action）",
    file: "src/app/(main)/meal-vouchers/page.tsx",
    table: "breakfast_records",
    sql: "UPDATE breakfast_records SET status = 'USED', count = ?, stay_id = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [0, 888888, id, hotel],
  },
  {
    id: "meal-vouchers#buyBreakfast 购买早餐（page.tsx 内联 server action）",
    file: "src/app/(main)/meal-vouchers/page.tsx",
    table: "stays",
    sql: "UPDATE stays SET breakfast = COALESCE(breakfast, 0) + ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [0, id, hotel],
  },
  {
    id: "notices#delete 删除公告",
    file: "src/app/(main)/notices/actions.ts",
    table: "notices",
    sql: "DELETE FROM notices WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [id, hotel],
  },
  {
    id: "quotes#delete 删除报价",
    file: "src/app/(main)/quotes/actions.ts",
    table: "quotes",
    sql: "DELETE FROM quotes WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [id, hotel],
  },
  {
    id: "forecast#batchAssign 批量排房写明细",
    file: "src/app/(main)/rooms/forecast/actions.ts",
    table: "booking_rooms",
    sql: "UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED' WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [888888, id, hotel],
  },
  {
    id: "settings#seedPosition 补岗位",
    file: "src/app/(main)/settings/actions.ts",
    table: "users",
    sql: "UPDATE users SET position_id = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [1, id, hotel],
  },
  {
    id: "settings#seedLastLogin 补登录时间",
    file: "src/app/(main)/settings/actions.ts",
    table: "users",
    sql: "UPDATE users SET last_login_at = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [null, id, hotel],
  },
  {
    id: "settings#saveRate 单日房价",
    file: "src/app/(main)/settings/actions.ts",
    table: "rate_calendar",
    sql: "UPDATE rate_calendar SET price = ?, updated_at = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [0, null, id, hotel],
  },
  {
    id: "settings#batchAllotment 批量房量",
    file: "src/app/(main)/settings/actions.ts",
    table: "rate_calendar",
    sql: "UPDATE rate_calendar SET allotment = ?, updated_at = ? WHERE id = ? AND hotel_id = ?",
    count: 1,
    args: (id, hotel) => [0, null, id, hotel],
  },
  {
    id: "settings#saveHotelInfo 系统信息 / 班次写 settings（3 处同语句）",
    file: "src/app/(main)/settings/actions.ts",
    table: "settings",
    sql: "UPDATE settings SET value = ? WHERE id = ? AND hotel_id = ?",
    count: 3,
    args: (id, hotel) => ["TNTEST-value", id, hotel],
  },
  {
    id: "mini-auth#token 过期清理 + revoke 两处同语句",
    file: "src/lib/mini-auth.ts",
    table: "mini_program_users",
    sql: "UPDATE mini_program_users SET session_token = NULL, token_expires_at = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?",
    count: 2,
    args: (id, hotel) => [null, id, hotel],
  },
  {
    id: "mini-auth#bindGuest 绑定客史",
    file: "src/lib/mini-auth.ts",
    table: "mini_program_users",
    /* P0-11 加固后加了绑定失败计数清零与「防换绑」条件 */
    sql: "UPDATE mini_program_users SET guest_id = ?, mobile = ?, bind_attempts = 0, bind_locked_until = NULL, updated_at = ? WHERE id = ? AND hotel_id = ? AND (guest_id IS NULL OR guest_id = ?)",
    count: 1,
    args: (id, hotel) => [1, "13800000000", null, id, hotel],
  },
];

/** 唯一一处「不需要也不必加 hotel_id」的写操作：hotels 表本身没有 hotel_id 列 */
const EXEMPT = {
  file: "src/app/(main)/settings/actions.ts",
  table: "hotels",
  sql: "UPDATE hotels SET name = ?, address = ?, phone = ? WHERE id = ?",
  reason: "hotels 表主键 id 即租户 id（表里没有 hotel_id 列），id 取自 user.hotelId",
};

console.log("========== A 段：静态锚点（23 处逐条校验）==========\n");

let anchored = 0;
let anchoredPlaces = 0;
const perFile = new Map();
for (const p of PLACES) {
  let src = "";
  try {
    src = squash(readSrc(p.file));
  } catch {
    /* 文件缺失交给断言报错 */
  }
  const hits = src.split(p.sql).length - 1;
  const ok = hits >= p.count;
  if (ok) {
    anchored++;
    anchoredPlaces += p.count;
  }
  check(`${p.id}：源码带 hotel_id（${p.count} 处）`, ok, `命中 ${hits}/${p.count}`);
  perFile.set(p.file, (perFile.get(p.file) ?? 0) + p.count);
}

/* 豁免：hotels 表语句必须还在，且文件里要有中文注释说明「id 即租户」 */
let exemptOk = false;
try {
  const src = squash(readSrc(EXEMPT.file));
  const sqlOk = src.includes(EXEMPT.sql);
  const noteOk = src.includes("hotels 表没有 hotel_id 列");
  exemptOk = sqlOk && noteOk;
  check(`豁免 1 处：${EXEMPT.table} 表（id 即租户）有语句 + 注释说明`, exemptOk, `语句=${sqlOk} 注释=${noteOk}`);
} catch {
  check(`豁免 1 处：${EXEMPT.table} 表（id 即租户）有语句 + 注释说明`, false, "文件读取失败");
}

check(
  "A 段：23 处全部有交代（22 处带 hotel_id + 1 处豁免）",
  anchoredPlaces === 22 && exemptOk,
  `带 hotel_id ${anchoredPlaces} 处 / 锚点 ${anchored}/${PLACES.length} 条`
);

/**
 * 比 audit-gap.mjs 更严的扫描：把每条 UPDATE / DELETE 整体抠出来（多行、IN 批量都覆盖），
 * 只要「按 id 定位」且全文找不到 hotel_id 就算违规。
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
    const byId = /\bid\s*=\s*\?/i.test(raw) || /\bid\s+IN\s*\(/i.test(raw);
    if (!byId) continue;
    if (/hotel_id/i.test(raw)) continue;
    hits.push({ line: src.slice(0, start).split("\n").length, kind: m[1].toUpperCase(), table: m[2], text: raw.slice(0, 200) });
  }
  return hits;
}

let unscoped = 0;
let exemptHits = 0;
for (const rel of OWN_FILES) {
  let src = "";
  try {
    src = readSrc(rel);
  } catch {
    console.log(`⚠️  文件不存在：${rel}`);
    continue;
  }
  const hits = findUnscopedWrites(src);
  const brief = rel.replace("src/app/(main)/", "");
  const exempt = hits.filter((h) => rel === EXEMPT.file && h.table === EXEMPT.table);
  const bad = hits.filter((h) => !(rel === EXEMPT.file && h.table === EXEMPT.table));
  exemptHits += exempt.length;
  unscoped += bad.length;
  if (bad.length === 0 && exempt.length === 0) {
    console.log(`✅ ${brief}：无「只按 id 定位」的写操作`);
  } else if (bad.length === 0) {
    console.log(`✅ ${brief}：仅 ${exempt.length} 处豁免（${EXEMPT.table} 表 id 即租户）`);
  } else {
    console.log(`❌ ${brief}：发现 ${bad.length} 处`);
    for (const h of bad) console.log(`     L${h.line} ${h.kind} ${h.table} — ${h.text}`);
  }
}
check(
  "A 段：负责文件内「只按 id 定位且无 hotel_id」的写操作 = 0 处（hotels 豁免 1 处）",
  unscoped === 0 && exemptHits === 1,
  `违规 ${unscoped} 处 / 豁免 ${exemptHits} 处`
);

/* ==========================================================================
 * B 段：行为验证（两家测试酒店互写）
 * ======================================================================== */

const HOTEL_A = 9998; // 反例里的「被越权酒店」：行属于 A
const HOTEL_B = 9999; // 正例里的「本店」：行属于 B
const CODE_A = "TNTEST-A";
const CODE_B = "TNTEST-B";

console.log("\n========== B 段：行为验证（跨租户写入必须影响 0 行）==========\n");

const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 5000");
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

/** 每张表 1 条最小可用种子（NOT NULL 列都写到），A / B 两店各一条 */
const SEEDS = {
  channel_orders: () => [["channel_type", "channel_order_no"], ["tntest", "TNT-ORDER"]],
  channels: () => [["name", "channel_type"], ["TNTEST 渠道", "tntest"]],
  dummy_rooms: () => [["name", "code", "category", "status"], ["TNTEST 哑房", null, "其他", "ACTIVE"]],
  lease_records: () => [["item_name", "status", "leased_at"], ["TNTEST 租赁", "LEASED", "2030-01-01"]],
  lock_devices: () => [["room_id", "status"], [888888, "BOUND"]],
  lost_items: () => [["item_name", "status"], ["TNTEST 失物", "KEEPING"]],
  breakfast_records: () => [["stay_id", "date", "count", "status"], [888888, "2030-01-01", 0, "PENDING"]],
  // stay_no 全局唯一，按酒店生成不同编号
  stays: (h) => [["stay_no", "room_id", "rate", "status"], [`TNTEST-${h}`, 888888, 0, "INHOUSE"]],
  notices: () => [["title"], ["TNTEST 公告"]],
  quotes: () => [["name"], ["TNTEST 报价"]],
  // 占用唯一索引是 (room_id, check_in_date, check_out_date)，不含 hotel_id，两店要错开
  booking_rooms: (h) => [
    ["booking_id", "room_id", "status", "check_in_date", "check_out_date"],
    [888888, h === HOTEL_A ? 880001 : 880002, "PENDING", h === HOTEL_A ? "2030-01-01" : "2030-01-02", h === HOTEL_A ? "2030-01-03" : "2030-01-04"],
  ],
  users: () => [["username", "password", "real_name", "role"], ["tntest", "x", "TNTEST 员工", "frontdesk"]],
  rate_calendar: () => [["room_type_id", "date", "price"], [888888, "2030-01-01", 0]],
  settings: () => [["key", "value"], ["tntest_key", "seed"]],
  mini_program_users: () => [["openid", "session_token", "token_expires_at"], ["tntest-openid", null, null]],
};

/** 把种子按酒店写入，返回新行 id */
function seedRow(table, hotelId) {
  const [cols, vals] = SEEDS[table](hotelId);
  const keys = ["hotel_id", ...cols];
  const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")})
               VALUES (${keys.map(() => "?").join(", ")})`;
  return Number(run(sql, [hotelId, ...vals]).lastInsertRowid);
}

const results = [];
let scenarioError = "";

try {
  db.exec("BEGIN IMMEDIATE");

  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [HOTEL_A, CODE_A, "多租户写入测试酒店A", new Date().toISOString()]);
  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [HOTEL_B, CODE_B, "多租户写入测试酒店B", new Date().toISOString()]);

  const ids = {};
  for (const table of Object.keys(SEEDS)) {
    ids[table] = {
      crossId: seedRow(table, HOTEL_A),
      ownId: seedRow(table, HOTEL_B),
    };
  }

  for (const p of PLACES) {
    const { crossId, ownId } = ids[p.table];
    const cross = run(p.sql, p.args(crossId, HOTEL_B)); // A 店的行 id + B 店的 hotelId → 越权
    const same = run(p.sql, p.args(ownId, HOTEL_B)); // B 店自己的行 + B 店的 hotelId → 正常
    results.push({
      id: p.id,
      table: p.table,
      crossChanges: Number(cross.changes),
      sameChanges: Number(same.changes),
      crossId,
      ownId,
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
}

if (scenarioError) console.log(`❌ B 段场景搭建失败：${scenarioError}`);
for (const r of results) {
  console.log(`\n· ${r.id}`);
  console.log(`    目标表：${r.table}（${HOTEL_A} 店行 id=${r.crossId}，${HOTEL_B} 店行 id=${r.ownId}）`);
  console.log(`    ${HOTEL_B} 写 ${HOTEL_A} 的数据：影响 ${r.crossChanges} 行${r.crossChanges === 0 ? "  ✅" : "  ❌"}`);
  console.log(`    ${HOTEL_B} 写自己的数据：    影响 ${r.sameChanges} 行${r.sameChanges === 1 ? "  ✅（语句本身可命中）" : "  ❌"}`);
  check(`B 段：${r.id} 跨租户影响 0 行`, r.crossChanges === 0, `实际 ${r.crossChanges} 行`);
  check(`B 段：${r.id} 同租户影响 1 行（正例）`, r.sameChanges === 1, `实际 ${r.sameChanges} 行`);
}
if (!scenarioError) {
  check(`B 段：${PLACES.length} 条语句全部完成试写`, results.length === PLACES.length, `完成 ${results.length} 条`);
}

/* ==========================================================================
 * C 段：零残留（ROLLBACK 之后）
 * ======================================================================== */

console.log("\n========== C 段：零残留校验 ==========\n");
let residue = 0;
for (const table of Object.keys(SEEDS)) {
  const c = Number(one(`SELECT COUNT(*) AS c FROM "${table}" WHERE hotel_id IN (?, ?)`, [HOTEL_A, HOTEL_B])?.c ?? 0);
  if (c > 0) {
    residue += c;
    console.log(`❌ ${table} 残留 ${c} 行`);
  }
}
const hotelLeft = Number(one(`SELECT COUNT(*) AS c FROM hotels WHERE id IN (?, ?)`, [HOTEL_A, HOTEL_B])?.c ?? 0);
check(
  `C 段：ROLLBACK 后 ${Object.keys(SEEDS).length} 张表无测试租户残留`,
  residue === 0,
  `残留 ${residue} 行`
);
check("C 段：测试酒店行已回滚", hotelLeft === 0, `残留 ${hotelLeft} 行`);
db.close();

/* ==========================================================================
 * 汇总
 * ======================================================================== */
console.log("\n========================== 汇总 ==========================");
console.log(`A 段：${PLACES.length} 条锚点（覆盖 ${anchoredPlaces} 处带 hotel_id + 1 处豁免 = 23 处），违规扫描 ${unscoped} 处`);
console.log(`B 段：${PLACES.length} 条语句 ×（跨租户 0 行 / 同租户 1 行）`);
console.log(`C 段：零残留`);
console.log(`\n通过 ${pass.n} / 失败 ${fail.n}`);
if (fail.n > 0) {
  console.log(`失败项：\n  - ${failures.join("\n  - ")}`);
}
process.exit(fail.n === 0 ? 0 : 1);
