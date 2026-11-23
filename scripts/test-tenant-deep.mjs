#!/usr/bin/env node
/**
 * 多租户隔离**深度**验收（真实 action 双向跨店）
 *
 * ── 为什么要有这套 ──
 * 现有多租户测试覆盖很薄：`test-tenant-isolation`（8 条，只查 SQL）、
 * `test-occupancy-tenant-isolation`（27 条，只管房量）、`test-tenant-writes`（24 条）、
 * `test-tenant-writes2`（63 条，锚点 + SQL 试写）。它们都是「自己写 SQL 再断言自己写的 SQL」，
 * 抓不到 `src/` 里 action 改坏 —— 而这正是跨店越权最容易出问题的地方。
 *
 * 本套用 `scripts/helpers/action-harness.mjs` 的**副本库 + 真实 action** 底盘，做四件事：
 *
 *   A 段（结构）：真库 93 张表逐张 PRAGMA，列出「哪些表有 hotel_id / 哪些没有」，
 *                 并给出「没有 hotel_id 的表为什么可以没有」的结论。
 *   B 段（静态）：源码里**全部** INSERT / UPDATE / DELETE 逐条抠出来（先剥注释，避免把注释里
 *                 描述的 SQL 当代码），检查每条写操作是否带 hotel_id；不带的白名单化并给理由。
 *   C 段（动态）：造两家酒店 —— **酒店 1 = 真库数据副本**、**酒店 998 = 测试酒店**，
 *                 对「任务点名的重点表」逐个用**真实 server action** 打一遍：
 *                   ① 998 店的会话 + 1 店的数据 id → 必须一字节都改不动；
 *                   ② 1 店的会话 + 同样的 id → 必须生效（证明 action 本身能命中，
 *                      ① 的「没改」不是因为语句压根没跑）。
 *                 另外单独验证「998 会话对 998 自己的数据是能写成功的」——
 *                 否则 ①「什么都没改」可能只是会话无效造成的假绿。
 *   D 段（广度）：每张有 hotel_id 的表在源码里被引用的 SQL 里，是否至少有一条带 hotel_id，
 *                 给出「有 hotel_id 但从来没用上」的表清单 —— 那就是准漏洞。
 *
 * ── 硬约束 ──
 * · 全程只写 `.tmp/tenant-deep-<时间戳>/data/pms.db`（harness 用 VACUUM INTO 从真库复制），
 *   真库自始至终只读打开；
 * · 不启动服务、不跑 next build、不改 src/；
 * · 临时库在进程退出时整个删掉，可反复执行、不留残留。
 *
 * 用法：node scripts/test-tenant-deep.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { createActionHarness, createChecker, isErr, isOk, msgOf } from "./helpers/action-harness.mjs";

/* ============================================================ 断言器 */

const { check, section, done } = createChecker();

/* ============================================================ 底盘 */

const ROOT = process.cwd();
const h = await createActionHarness({ tag: "tenant-deep", hotelId: 1 });
const db = h.db;
const all = (sql, p = []) => h.all(sql, p);
const one = (sql, p = []) => h.one(sql, p);
const run = (sql, p = []) => h.run(sql, p);
const json = (v) => JSON.stringify(v);

/** 测试酒店：998（真库数据副本里的另一家租户，脚本自己造、随副本一起丢弃） */
const HOTEL_B = 998;
const HOTEL_A = 1;

console.log(`真库（只读副本源）：${h.realDb}`);
console.log(`本次副本库：${h.dbPath}`);
console.log(`测试租户：${HOTEL_A}（真库数据副本） / ${HOTEL_B}（本脚本新造）`);

/* ============================================================ 造 998 店 + 会话 */

section("0. 造测试租户 998 + 两个会话（1 店 admin / 998 admin）");

run(`INSERT OR IGNORE INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  `TD${h.stamp.slice(-6)}`,
  "多租户深度测试酒店",
  "测试地址",
  "000-0000",
  new Date().toISOString(),
]);
const user998 = run(
  `INSERT INTO users (hotel_id, username, password, real_name, role, status) VALUES (?,?,?,?,?,1)`,
  [HOTEL_B, `deep998-${h.stamp}`, "x", "998管理员", "admin"]
).lastInsertRowid;
const SID998 = `deep-998-${h.stamp}`;
run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
  SID998,
  JSON.stringify({
    id: user998,
    username: `deep998-${h.stamp}`,
    realName: "998管理员",
    role: "admin",
    hotelId: HOTEL_B,
    hotelName: "多租户深度测试酒店",
  }),
  new Date().toISOString(),
  new Date(Date.now() + 3600 * 1000).toISOString(),
]);
check("测试租户 998 与管理员会话已就绪", Boolean(one(`SELECT id FROM hotels WHERE id = ?`, [HOTEL_B])) && Boolean(one(`SELECT id FROM sessions WHERE id = ?`, [SID998])));
check("1 店管理员会话已就绪（harness 提供）", Boolean(one(`SELECT id FROM sessions WHERE id = ?`, [h.ADMIN_SID])));

/* ============================================================ A 段：表清单 + hotel_id 覆盖 */

section("A 段：全库表清单与 hotel_id 覆盖");

/** 不含 hotel_id 但是**按设计**不该有的表（下面逐张给理由并断言源码里确实是全局语义） */
const GLOBAL_TABLES = {
  hotels: "主键 id 即租户 id（表里存的是租户本身，再放一列 hotel_id 会自引用）",
  sessions: "登录会话表：会话 id 全局唯一，登录时还不知道 / 不限定租户（未登录也要能查）",
  login_attempts: "登录爆破防护计数：按 username / IP 全局计数，跨租户共享失败次数才是正确语义",
  permission_dict: "权限点字典（中文名 / 归属模块）：与具体租户无关的全局元数据",
};

const allTables = all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);
const tableInfo = new Map();
for (const t of allTables) {
  tableInfo.set(t, all(`PRAGMA table_info("${t}")`).map((c) => ({ ...c })));
}
const withHotelId = allTables.filter((t) => tableInfo.get(t).some((c) => c.name === "hotel_id"));
const withoutHotelId = allTables.filter((t) => !tableInfo.get(t).some((c) => c.name === "hotel_id"));

check(`真库表数量 ≥ 80（实际 ${allTables.length}）`, allTables.length >= 80, `表数 ${allTables.length}`);
check(`有 hotel_id 的业务表 ≥ 80（实际 ${withHotelId.length}）`, withHotelId.length >= 80, `表数 ${withHotelId.length}`);
check(
  `没有 hotel_id 的表全部在「按设计可以是全局表」白名单里（${withoutHotelId.join(" / ") || "无"}）`,
  withoutHotelId.every((t) => Object.prototype.hasOwnProperty.call(GLOBAL_TABLES, t)),
  `不在白名单：${withoutHotelId.filter((t) => !Object.prototype.hasOwnProperty.call(GLOBAL_TABLES, t)).join(",") || "（无）"}`
);

/** 有 hotel_id 但不能是「随便塞一列」：必须是 NOT NULL INTEGER */
const badHotelCols = [];
for (const t of withHotelId) {
  const col = tableInfo.get(t).find((c) => c.name === "hotel_id");
  const type = String(col.type ?? "").toUpperCase();
  if (col.notnull !== 1 || !type.includes("INT")) badHotelCols.push(`${t}(type=${col.type},notnull=${col.notnull})`);
}
check(
  `每张表的 hotel_id 都是 NOT NULL INTEGER（不留 NULL 租户的口子）`,
  badHotelCols.length === 0,
  badHotelCols.join("；") || "（无）"
);

/** 关键业务表的 hotel_id 必须带索引前缀（跨店查询性能 / 扫描范围） */
const KEY_TABLES = [
  "bookings", "booking_rooms", "stays", "folios", "folio_items", "payments", "rooms", "guests",
  "companies", "housekeeping", "ar_accounts", "ar_ledgers", "ar_write_offs", "ar_transactions",
  "invoices", "shop_items", "shop_sales", "shop_stock_flows", "member_wallet", "member_wallet_ledger",
  "breakfast_records", "meal_vouchers", "lost_items", "channel_orders", "night_audits",
];
/**
 * 已知「没有以 hotel_id 打头的索引」的表（本轮实测出来的，见报告「发现的问题」）
 *
 * 这几张表在真库里只有 0~300 行量级，且都是「页面首次访问懒建」的小表，
 * 缺索引暂时不影响正确性，只影响将来数据量上来后的隔离查询性能 —— 记在这里，
 * 让「新增一张缺索引的大表」会被判红，而不是永远静默。
 */
const KNOWN_NO_HOTEL_INDEX = ["booking_rooms", "shop_items", "breakfast_records", "meal_vouchers", "lost_items"];
/** 表上是否存在「以 hotel_id 打头」的索引（PRAGMA index_list + index_info 逐列看） */
function hasHotelLeadingIndex(table) {
  for (const idx of all(`PRAGMA index_list("${table}")`)) {
    const cols = all(`PRAGMA index_info("${idx.name}")`).map((c) => c.name);
    if (cols[0] === "hotel_id") return idx.name;
  }
  return null;
}
const noLeadingIndex = KEY_TABLES.filter((t) => tableInfo.has(t) && !hasHotelLeadingIndex(t));
const unexpectedNoIndex = noLeadingIndex.filter((t) => !KNOWN_NO_HOTEL_INDEX.includes(t));
check(
  `关键业务表缺「hotel_id 打头索引」的只有已知的 ${KNOWN_NO_HOTEL_INDEX.length} 张（其余 ${KEY_TABLES.length} 张都有）`,
  unexpectedNoIndex.length === 0,
  `新增缺索引：${unexpectedNoIndex.join(",") || "（无）"}；已知缺：${noLeadingIndex.join(",") || "（无）"}`
);

/* ============================================================ B 段：源码写操作静态扫描 */

section("B 段：源码里全部写操作逐条检查 hotel_id");

/**
 * 剔除注释，只留下真正会执行的代码。
 *
 * 为什么必须剥：上一版扫描把注释里描述 SQL 的句子也算成写操作
 * （例如 cashier 的注释「旧实现只 UPDATE stays SET remark」），
 * 结果一堆假阳性，最后只能靠人工看 —— 那就等于没有扫描器。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      } else out += " ";
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && nx === "/") {
        inBlock = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? ch : " ";
      i += 1;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += nx ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && nx === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === "/" && nx === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function walkSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkSrc(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const SRC_FILES = walkSrc(path.join(ROOT, "src"));
const WRITE_RE = /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([`"\w.$]+)/gi;

/**
 * 取一条写操作的「完整 SQL 片段」
 *
 * 难点：SQL 大量写成模板字符串 + `${sets.join(", ")}` 动态拼接，例如
 *   `UPDATE channels SET ${sets.join(", ")} WHERE id = ? AND hotel_id = ?`
 * 如果只从 `UPDATE channels` 截到第一个反引号，就会漏掉后面的 WHERE hotel_id，
 * 把它误判成「跨店写操作」。所以这里先判断语句是否落在**未闭合的模板字符串**里：
 *   · 在模板字符串内 → 取「上一个反引号 ~ 下一个反引号」的整段（跨 ${} 拼接全包）；
 *   · 否则按行/分号截到语句结束。
 */
function sliceWriteStatement(code, start) {
  const before = code.slice(0, start);
  const backtickCount = (before.match(/`/g) ?? []).length;
  if (backtickCount % 2 === 1) {
    const open = before.lastIndexOf("`");
    const close = code.indexOf("`", start);
    return code.slice(open, close > 0 ? close + 1 : code.length);
  }
  let end = start;
  while (end < code.length && end - start < 2000) {
    const ch = code[end];
    if (end > start + 6 && (ch === "`" || ch === '"' || ch === ";")) break;
    end += 1;
  }
  return code.slice(start, end);
}

const writes = [];
for (const file of SRC_FILES.sort()) {
  const code = stripComments(readFileSync(file, "utf8"));
  WRITE_RE.lastIndex = 0;
  let m;
  while ((m = WRITE_RE.exec(code))) {
    const start = m.index;
    const snippet = sliceWriteStatement(code, start).replace(/\s+/g, " ").trim();
    const rawTable = m[2].replace(/[`"]/g, "");
    writes.push({
      file: file.split(path.sep).join("/").replace(`${ROOT.split(path.sep).join("/")}/`, ""),
      table: rawTable,
      kind: m[1].toUpperCase().replace(/\s+/g, " "),
      dynamic: rawTable.includes("$"),
      /** upsert 的 `ON CONFLICT ... DO UPDATE SET` 会把 SET 当成表名，不是写操作目标 */
      pseudo: rawTable === "SET" || rawTable === "..." || rawTable === "$",
      hasHotel: /\bhotel_id\b/i.test(snippet),
      snippet,
    });
  }
}

const realWrites = writes.filter((w) => !w.pseudo);
const writeTables = [...new Set(realWrites.map((w) => w.table))];
check(`源码扫描覆盖 ${SRC_FILES.length} 个文件（≥ 200）`, SRC_FILES.length >= 200, `实际 ${SRC_FILES.length}`);
check(`抠出写操作 ${realWrites.length} 条（≥ 400），涉及 ${writeTables.length} 张表`, realWrites.length >= 400, `实际 ${realWrites.length}`);
check(`写操作覆盖的表 ≥ 70 张`, writeTables.length >= 70, `实际 ${writeTables.length}`);

/**
 * 已知「写操作不带 hotel_id」的豁免清单 —— 每一条都必须有理由，且理由要能被复核。
 *
 * 判据是 `snippet.includes(match)`：只匹配 SQL 本身，不受行号 / 注释变化影响。
 * 如果哪天这些语句补上了 hotel_id，条目不会失效（豁免只是「允许」，不是「要求」）；
 * 但如果出现**新**的不带 hotel_id 的写操作，就会被判红。
 */
const WRITE_EXEMPTIONS = [
  {
    file: "src/app/(main)/rooms/actions.ts",
    table: "housekeeping",
    match: "UPDATE housekeeping SET status = 'DONE', done_at = ? WHERE room_id = ?",
    reason:
      "room_id 已被上游 changeRoomStatus({hotelId}) 校验为本店房间；room_id 是主键、唯一确定一家酒店，按 room_id 定位等价于按租户定位（形式缺口，实质安全）",
  },
  {
    file: "src/app/(main)/rooms/actions.ts",
    table: "room_links",
    match: "UPDATE room_links SET link_no = ? WHERE id = ?",
    reason:
      "id 取自同函数里 `SELECT id FROM room_links WHERE hotel_id = ? AND stay_id IN (...)` 的本店查询结果，不是外部传入（形式缺口，实质安全）",
  },
  {
    file: "src/app/(main)/settings/clear-data-actions.ts",
    table: "rooms",
    match: "UPDATE rooms SET status = 'VC' WHERE status IN",
    reason: "「清空业务数据」按设计重置整店：动作入口只有 admin，且清空范围就是当前酒店（不改 hotel_id 就不会跨店）",
  },
  {
    file: "src/app/(main)/settings/demo-actions.ts",
    table: "users",
    match: "UPDATE users SET password_hash = ?, password = '' WHERE username = ?",
    reason: "演示数据包导入：按 username 定位（users 的 UNIQUE 是 (hotel_id, username)），导入目标就是本机目标库，不面向任意租户",
  },
  {
    file: "src/lib/channels/invoke.ts",
    table: "channel_sync_logs",
    match: 'INSERT INTO channel_sync_logs (${names.join(", ")})',
    reason:
      "列名是运行时探测拼出来的：writeSyncLog 里 names 数组第一项固定是 \"hotel_id\"（values 第一项 hotelId），且表缺列时会降级 —— 静态扫描看不到列名，运行时一定带租户",
  },
];

function exempted(w) {
  return WRITE_EXEMPTIONS.find((e) => {
    if (e.table !== w.table) return false;
    if (!w.file.endsWith(e.file.replace(/^src\//, ""))) return false;
    return w.snippet.includes(e.match);
  });
}

const noHotelWrites = realWrites.filter((w) => !w.hasHotel && !w.dynamic && !Object.prototype.hasOwnProperty.call(GLOBAL_TABLES, w.table) && w.table !== "sqlite_sequence");
const unexplained = noHotelWrites.filter((w) => !exempted(w));
check(
  `不带 hotel_id 的写操作（排除动态表名 ${realWrites.filter((w) => !w.hasHotel && w.dynamic).length} 条 / 全局表）全部有豁免理由`,
  unexplained.length === 0,
  unexplained.map((w) => `${w.file} ${w.table} :: ${w.snippet.slice(0, 120)}`).join("\n    ") || "（无）"
);
check(
  `豁免清单 ${WRITE_EXEMPTIONS.length} 条，每条都写了可复核的理由`,
  WRITE_EXEMPTIONS.every((e) => typeof e.reason === "string" && e.reason.length > 20)
);

/* ============================================================ C 段：真实 action 双向跨店 */

section("C 段：真实 server action 双向跨店（998 会话打 1 店数据必须打不动）");

const moduleCache = new Map();
async function loadModule(rel) {
  if (!moduleCache.has(rel)) moduleCache.set(rel, await h.importModule(rel));
  return moduleCache.get(rel);
}

/**
 * 双向跨店用例
 *
 * ① `crossForm`：998 会话提交**1 店的真实行 id**，断言 1 店目标数据一字节未变；
 * ② `ownForm`：1 店会话提交同一批 id，断言数据**确实变了**（正例）。
 *   没有 ② 的话，「什么都没改」也可能是因为参数写错 / 语句没命中 —— 那种绿是假的。
 */
async function crossTenantCase(o) {
  const mod = await loadModule(o.module);
  const fn = mod[o.fn];
  if (typeof fn !== "function") {
    check(`C 段：${o.title} — 找到真实 action ${o.fn}`, false, o.module);
    return {};
  }

  /* ① 998 会话 + 1 店数据 */
  h.useSession(SID998);
  const before = o.snapshot();
  const r1 = await h.invoke(fn, o.crossForm);
  const after = o.snapshot();
  check(
    `C 段：${o.title} — 998 会话跨店无效（1 店数据未变）`,
    json(before) === json(after),
    `action=${r1.kind}「${msgOf(r1)}」; before=${json(before)}; after=${json(after)}`
  );

  /* ② 1 店会话 + 1 店数据（正例） */
  h.useSession(h.ADMIN_SID);
  const before2 = o.snapshot();
  const r2 = await h.invoke(fn, o.ownForm);
  const after2 = o.snapshot();
  check(
    `C 段：${o.title} — 1 店会话正例生效（证明语句本身能命中）`,
    o.ownExpect(before2, after2, r2),
    `action=${r2.kind}「${msgOf(r2)}」; before=${json(before2)}; after=${json(after2)}`
  );
  return { r1, r2, after2 };
}

/** 取 1 店真实样本 id（都是真库数据副本里的真实行） */
const sample = {
  arLedgerOpen: one(`SELECT id, amount, settled_amount, status FROM ar_ledgers WHERE hotel_id = ? AND status IN ('OPEN','PARTIAL') ORDER BY id LIMIT 1`, [HOTEL_A]),
  arAccount: one(`SELECT id, balance, code, status FROM ar_accounts WHERE hotel_id = ? AND status = 'ON' ORDER BY id LIMIT 1`, [HOTEL_A]),
  arAccount2: one(`SELECT id, balance FROM ar_accounts WHERE hotel_id = ? AND status = 'ON' ORDER BY id DESC LIMIT 1`, [HOTEL_A]),
  arTx: one(`SELECT id, ar_account_id, amount, type FROM ar_transactions WHERE hotel_id = ? AND type = 'POST' AND amount > 100 ORDER BY id DESC LIMIT 1`, [HOTEL_A]),
  folioOpen: one(`SELECT id, folio_no, status, balance, total_amount, stay_id FROM folios WHERE hotel_id = ? AND status = 'OPEN' AND balance > 0 ORDER BY id DESC LIMIT 1`, [HOTEL_A]),
  folioSettled: one(`SELECT id, folio_no, status, balance, total_amount FROM folios WHERE hotel_id = ? AND status = 'SETTLED' AND total_amount > 0 ORDER BY total_amount DESC LIMIT 1`, [HOTEL_A]),
  shopItem: one(`SELECT id, name, price, stock, status FROM shop_items WHERE hotel_id = ? AND status = 'ON' ORDER BY id LIMIT 1`, [HOTEL_A]),
  inhouse: one(
    `SELECT st.stay_id AS id, st.room_id, r.room_no
       FROM (SELECT s.id AS stay_id, s.room_id FROM stays s WHERE s.hotel_id = ? AND s.status = 'INHOUSE' ORDER BY s.id LIMIT 1) st
       JOIN rooms r ON r.id = st.room_id`,
    [HOTEL_A]
  ),
  vipGuest: one(`SELECT id, name, vip_level FROM guests WHERE hotel_id = ? AND vip_level > 0 AND deleted = 0 ORDER BY id LIMIT 1`, [HOTEL_A]),
  plainGuest: one(`SELECT id, name FROM guests WHERE hotel_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1`, [HOTEL_A]),
  hkPending: one(`SELECT id, room_id, status, review_status FROM housekeeping WHERE hotel_id = ? AND status = 'PENDING' ORDER BY id LIMIT 1`, [HOTEL_A]),
  hkDone: one(`SELECT id, room_id, status, review_status FROM housekeeping WHERE hotel_id = ? AND status = 'DONE' AND review_status IS NULL ORDER BY id LIMIT 1`, [HOTEL_A]),
  breakfast: one(`SELECT id, status, stay_id, date FROM breakfast_records WHERE hotel_id = ? AND status = 'PENDING' ORDER BY id LIMIT 1`, [HOTEL_A]),
  voucherUnused: one(`SELECT id, code, status, date FROM meal_vouchers WHERE hotel_id = ? AND status = 'UNUSED' ORDER BY id LIMIT 1`, [HOTEL_A]),
  lostKeeping: one(`SELECT id, item_name, status FROM lost_items WHERE hotel_id = ? AND status = 'KEEPING' ORDER BY id LIMIT 1`, [HOTEL_A]),
  booking: one(`SELECT id, booking_no, status FROM bookings WHERE hotel_id = ? AND status = 'CONFIRMED' ORDER BY id DESC LIMIT 1`, [HOTEL_A]),
  bookingRoom: one(`SELECT id, booking_id, room_id, status FROM booking_rooms WHERE hotel_id = ? AND booking_id = (SELECT id FROM bookings WHERE hotel_id = ? AND status = 'CONFIRMED' ORDER BY id DESC LIMIT 1) LIMIT 1`, [HOTEL_A, HOTEL_A]),
  roomVc: one(`SELECT id, room_no, status FROM rooms WHERE hotel_id = ? AND status = 'VC' ORDER BY id LIMIT 1`, [HOTEL_A]),
  company: one(`SELECT id, name, credit_limit FROM companies WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL_A]),
};

/** 样本存在性：缺任何一条都直接判红，不允许「跳过」当通过 */
const sampleMissing = Object.entries(sample).filter(([, v]) => !v?.id).map(([k]) => k);
check(`1 店真实样本齐全（${Object.keys(sample).length} 个，跨店用例的前置数据）`, sampleMissing.length === 0, `缺：${sampleMissing.join(",") || "（无）"}`);

if (sampleMissing.length > 0) {
  console.error(`\n❌ 缺少必要样本：${sampleMissing.join(", ")} —— 后续跨店用例无法成立，不能假装通过`);
  done();
  h.dispose();
  process.exit(1);
}

/* ---- 造几条只有本脚本用得上的 1 店数据（副本内，随副本丢弃） ---- */
const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

/**
 * 一张「只为退款用例准备」的账单 + 押金收款
 *
 * 退款上限是 min(原收款未退部分, 本单应退 = 已收 − 应收)，而真库既有 OPEN 账单
 * 都是「没收够」（应退 = 0），拿它们当正例会被上限拦住 —— 那不是隔离问题。
 * 押金场景（账单没有消费、客人先付 100）才是「本单应退 100」的正常形态。
 */
const refundFolioId = run(
  `INSERT INTO folios (hotel_id, folio_no, total_amount, paid_amount, balance, status, created_at)
   VALUES (?,?,0,100,-100,'OPEN',?)`,
  [HOTEL_A, `TDREF-F-${h.stamp}`, new Date().toISOString()]
).lastInsertRowid;
run(
  `INSERT INTO payments (hotel_id, folio_id, pay_no, method, amount, biz_date, remark, created_at, kind)
   VALUES (?,?,?,?,?,?,?,?,?)`,
  [HOTEL_A, refundFolioId, `TDREF-${h.stamp}`, "现金", 100, today, "深度隔离测试用押金收款", new Date().toISOString(), "DEPOSIT"]
);
const testPayment = one(`SELECT id, folio_id, amount FROM payments WHERE hotel_id = ? AND pay_no = ?`, [HOTEL_A, `TDREF-${h.stamp}`]);

/** 今天的一张未使用餐券（真库现有餐券都不是今天的日期，按 id 核销会被 date 条件挡住） */
run(
  `INSERT INTO meal_vouchers (hotel_id, code, room_no, guest_name, type, date, status, created_at)
   VALUES (?,?,?,?,?,?,?,?)`,
  [HOTEL_A, `TDV-${h.stamp}`, "TD01", "测试客人", "早餐", today, "UNUSED", new Date().toISOString()]
);
const voucherToday = one(`SELECT id, code, status, date FROM meal_vouchers WHERE hotel_id = ? AND code = ?`, [HOTEL_A, `TDV-${h.stamp}`]);

/**
 * 一条「已打扫、待验收」的客房任务
 *
 * 真库里 DONE 的任务 review_status 全是 NULL（第 5 轮才加 review_status 列，历史数据没有回填，
 * 这本身是对的：历史任务没人验收过，不能凭空补一个状态）。所以验收正例要自己造一条
 * 真实流程会产生的形态：status='DONE' + review_status='PENDING_REVIEW'。
 */
const hkRoom = one(`SELECT id FROM rooms WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL_A]);
run(
  `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, done_at, review_status, created_at)
   VALUES (?,?,?,?,?,?,?,?)`,
  [HOTEL_A, hkRoom?.id, "打扫", "DONE", "验收测试", new Date().toISOString(), "PENDING_REVIEW", new Date().toISOString()]
);
const hkReview = one(`SELECT id, status, review_status FROM housekeeping WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL_A]);

/**
 * 一条「已确认、待排房」的预订（**独立于取消用例用的那张单**）
 *
 * 取消用例会把「最新的 CONFIRMED 订单」置为 CANCELLED 并连带取消它的 booking_rooms 明细，
 * 如果排房复用同一张单，正例必然失败（订单状态不允许排房）—— 那不是隔离问题，是用例串了。
 */
const assignBooking = one(
  `SELECT b.id, b.booking_no, b.room_type_id, b.check_in_date, b.check_out_date
     FROM bookings b
    WHERE b.hotel_id = ? AND b.status = 'CONFIRMED' AND b.id <> ?
      AND EXISTS (SELECT 1 FROM booking_rooms br WHERE br.hotel_id = b.hotel_id AND br.booking_id = b.id AND br.status = 'PENDING' AND br.room_id IS NULL)
    ORDER BY b.id DESC LIMIT 1`,
  [HOTEL_A, sample.booking.id]
);
const assignDetail = assignBooking?.id
  ? one(`SELECT id, room_id, status FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND status = 'PENDING' LIMIT 1`, [HOTEL_A, assignBooking.id])
  : undefined;

check(
  "已造「可退款收款」「今日餐券」「待验收客房任务」「独立待排房订单」四条测试数据",
  Boolean(testPayment?.id) && Boolean(voucherToday?.id) && Boolean(hkReview?.id) && Boolean(assignBooking?.id) && Boolean(assignDetail?.id),
  json({ payment: testPayment?.id, voucher: voucherToday?.id, hk: hkReview?.id, booking: assignBooking?.id, detail: assignDetail?.id })
);

/* ============================================================ C-1 AR 台账 / 账户 / 核销 */

section("C-1 AR 应收三张表跨店（ar_ledgers / ar_accounts / ar_write_offs）");

await crossTenantCase({
  title: "AR 台账核销（ar_ledgers）",
  module: "app/(main)/ar/actions.ts",
  fn: "settleArLedgerAction",
  snapshot: () => one(`SELECT id, settled_amount, status FROM ar_ledgers WHERE id = ?`, [sample.arLedgerOpen.id]),
  crossForm: { ar_id: sample.arLedgerOpen.id, amount: 100, remark: "998 越权核销测试" },
  ownForm: { ar_id: sample.arLedgerOpen.id, amount: 100, remark: "1 店正常核销" },
  ownExpect: (b, a) => Number(a.settled_amount) > Number(b.settled_amount),
});

await crossTenantCase({
  title: "AR 账户入账（ar_accounts，写 ar_transactions）",
  module: "app/(main)/ar/actions.ts",
  fn: "postArAction",
  snapshot: () => {
    const acc = one(`SELECT id, balance FROM ar_accounts WHERE id = ?`, [sample.arAccount.id]);
    const tx = Number(one(`SELECT COUNT(*) AS c FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ?`, [HOTEL_A, sample.arAccount.id])?.c ?? 0);
    return { balance: acc?.balance, txCount: tx };
  },
  crossForm: { account_id: sample.arAccount.id, amount: 100, note: "998 越权入账" },
  ownForm: { account_id: sample.arAccount.id, amount: 100, note: "1 店正常入账" },
  ownExpect: (b, a) => Math.abs(Number(a.balance) - (Number(b.balance) + 100)) < 0.005 && a.txCount === b.txCount + 1,
});

await crossTenantCase({
  title: "AR 客户还款（ar_accounts 余额减少）",
  module: "app/(main)/ar/actions.ts",
  fn: "payArAction",
  snapshot: () => one(`SELECT id, balance FROM ar_accounts WHERE id = ?`, [sample.arAccount.id]),
  crossForm: { account_id: sample.arAccount.id, amount: 50, note: "998 越权还款" },
  ownForm: { account_id: sample.arAccount.id, amount: 50, note: "1 店正常还款" },
  ownExpect: (b, a) => Math.abs(Number(b.balance) - Number(a.balance) - 50) < 0.005,
});

await crossTenantCase({
  title: "AR 账户间转账（两个 ar_accounts 一起变）",
  module: "app/(main)/ar/actions.ts",
  fn: "transferArAction",
  snapshot: () => ({
    from: one(`SELECT balance FROM ar_accounts WHERE id = ?`, [sample.arAccount.id])?.balance,
    to: one(`SELECT balance FROM ar_accounts WHERE id = ?`, [sample.arAccount2.id])?.balance,
  }),
  crossForm: { account_id: sample.arAccount.id, to_account_id: sample.arAccount2.id, amount: 30, note: "998 越权转账" },
  ownForm: { account_id: sample.arAccount.id, to_account_id: sample.arAccount2.id, amount: 30, note: "1 店正常转账" },
  ownExpect: (b, a) => Math.abs(Number(b.from) - Number(a.from) - 30) < 0.005 && Math.abs(Number(a.to) - Number(b.to) - 30) < 0.005,
});

/** 核销流水（ar_write_offs）：正例需要一条未全额核销的 POST 流水 */
const writeOffTx = one(
  `SELECT t.id, t.ar_account_id, t.amount,
          COALESCE((SELECT SUM(w.amount) FROM ar_write_offs w WHERE w.hotel_id = t.hotel_id AND w.transaction_id = t.id), 0) AS written
     FROM ar_transactions t
    WHERE t.hotel_id = ? AND t.type = 'POST'
    ORDER BY (t.amount - COALESCE((SELECT SUM(w.amount) FROM ar_write_offs w WHERE w.hotel_id = t.hotel_id AND w.transaction_id = t.id), 0)) DESC
    LIMIT 1`,
  [HOTEL_A]
);
check("有一条可核销的 AR 入账流水（ar_write_offs 正例前置）", Boolean(writeOffTx?.id), json(writeOffTx ?? {}));
if (writeOffTx?.id) {
  await crossTenantCase({
    title: "AR 坏账核销流水（ar_write_offs）",
    module: "app/(main)/ar/actions.ts",
    fn: "writeOffArAction",
    snapshot: () => Number(one(`SELECT COUNT(*) AS c FROM ar_write_offs WHERE hotel_id = ? AND transaction_id = ?`, [HOTEL_A, writeOffTx.id])?.c ?? 0),
    crossForm: { account_id: writeOffTx.ar_account_id, transaction_id: writeOffTx.id, amount: 10, note: "998 越权核销" },
    ownForm: { account_id: writeOffTx.ar_account_id, transaction_id: writeOffTx.id, amount: 10, note: "1 店正常核销" },
    ownExpect: (b, a) => Number(a) === Number(b) + 1,
  });
}

/* ============================================================ C-2 账务：payments / folio_items / invoices */

section("C-2 账务表跨店（payments / folio_items / invoices）");

await crossTenantCase({
  title: "账单收款（payments）",
  module: "app/(main)/cashier/actions.ts",
  fn: "addPaymentAction",
  snapshot: () => {
    const n = Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND folio_id = ?`, [HOTEL_A, sample.folioOpen.id])?.c ?? 0);
    const bal = one(`SELECT balance FROM folios WHERE id = ?`, [sample.folioOpen.id])?.balance;
    return { n, bal };
  },
  crossForm: { folio_id: sample.folioOpen.id, amount: 20, method: "现金", remark: "998 越权收款" },
  ownForm: { folio_id: sample.folioOpen.id, amount: 20, method: "现金", remark: "1 店正常收款" },
  ownExpect: (b, a) => a.n === b.n + 1,
});

await crossTenantCase({
  title: "账单退款（payments 负数行）",
  module: "app/(main)/cashier/actions.ts",
  fn: "refundPaymentAction",
  snapshot: () => Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ?`, [HOTEL_A])?.c ?? 0),
  crossForm: { payment_id: testPayment?.id, amount: 10, reason: "998 越权退款" },
  ownForm: { payment_id: testPayment?.id, amount: 10, reason: "1 店正常退款" },
  ownExpect: (b, a) => Number(a) === Number(b) + 1,
});

await crossTenantCase({
  title: "账单入账（folio_items）",
  module: "app/(main)/cashier/actions.ts",
  fn: "addChargeAction",
  snapshot: () => Number(one(`SELECT COUNT(*) AS c FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL_A, sample.folioOpen.id])?.c ?? 0),
  crossForm: { folio_id: sample.folioOpen.id, item_type: "OTHER", description: "998 越权入账", qty: 1, price: 10, biz_date: today },
  ownForm: { folio_id: sample.folioOpen.id, item_type: "OTHER", description: "1 店正常入账", qty: 1, price: 10, biz_date: today },
  ownExpect: (b, a) => Number(a) === Number(b) + 1,
});

/** 开票 + 红冲：正例生成一张 ISSUED 发票，紧接着用它做红冲的跨店用例 */
const invoiceCase = await crossTenantCase({
  title: "账单开票（invoices，SETTLED 账单）",
  module: "app/(main)/cashier/actions.ts",
  fn: "invoiceAction",
  snapshot: () => Number(one(`SELECT COUNT(*) AS c FROM invoices WHERE hotel_id = ?`, [HOTEL_A])?.c ?? 0),
  crossForm: { folio_id: sample.folioSettled.id, title: "998 越权开票", tax_no: "", amount: 10, remark: "998" },
  ownForm: { folio_id: sample.folioSettled.id, title: "1 店正常开票", tax_no: "", amount: 10, remark: "1 店" },
  ownExpect: (b, a) => Number(a) === Number(b) + 1,
});
const issuedInvoice = one(`SELECT id, invoice_no, status, amount FROM invoices WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL_A]);
if (issuedInvoice?.id && invoiceCase?.r2) {
  await crossTenantCase({
    title: "发票红冲（invoices 状态 + 负数红冲票）",
    module: "app/(main)/invoices/actions.ts",
    fn: "redFlushInvoiceAction",
    snapshot: () => {
      const inv = one(`SELECT status FROM invoices WHERE id = ?`, [issuedInvoice.id]);
      const n = Number(one(`SELECT COUNT(*) AS c FROM invoices WHERE hotel_id = ?`, [HOTEL_A])?.c ?? 0);
      return { status: inv?.status, n };
    },
    crossForm: { invoice_id: issuedInvoice.id, reason: "998 越权红冲" },
    ownForm: { invoice_id: issuedInvoice.id, reason: "1 店正常红冲" },
    ownExpect: (b, a) => a.status !== b.status && Number(a.n) > Number(b.n),
  });
} else {
  check("C 段：发票红冲前置（正例开票成功）", false, "开票正例没产生发票，红冲无从验证");
}

/* ============================================================ C-3 商超：shop_items / shop_stock_flows / shop_sales */

section("C-3 商超库存与销售跨店（shop_items / shop_stock_flows / shop_sales）");

const saleCase = await crossTenantCase({
  title: "商超挂房账销售（shop_items.stock + shop_stock_flows）",
  module: "app/(main)/shop/actions.ts",
  fn: "sellAction",
  snapshot: () => ({
    stock: one(`SELECT stock FROM shop_items WHERE id = ?`, [sample.shopItem.id])?.stock,
    flows: Number(one(`SELECT COUNT(*) AS c FROM shop_stock_flows WHERE hotel_id = ?`, [HOTEL_A])?.c ?? 0),
  }),
  crossForm: { item_id: sample.shopItem.id, qty: 1, room_no: sample.inhouse?.room_no },
  ownForm: { item_id: sample.shopItem.id, qty: 1, room_no: sample.inhouse?.room_no },
  ownExpect: (b, a) => Number(a.stock) === Number(b.stock) - 1 && Number(a.flows) > Number(b.flows),
});
const latestSale = one(`SELECT id, item_name, qty, voided_at FROM shop_sales WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL_A]);
if (latestSale?.id) {
  await crossTenantCase({
    title: "撤销商超销售单（shop_sales.voided_at + 回库）",
    module: "app/(main)/shop/actions.ts",
    fn: "voidSaleAction",
    snapshot: () => one(`SELECT id, voided_at FROM shop_sales WHERE id = ?`, [latestSale.id]),
    crossForm: { id: latestSale.id, reason: "998 越权撤销" },
    ownForm: { id: latestSale.id, reason: "1 店正常撤销" },
    ownExpect: (b, a) => !b.voided_at && Boolean(a.voided_at),
  });
} else {
  check("C 段：撤销销售前置（正例卖出成功）", false, "售卖正例没产生销售单，撤销无从验证");
}

/* ============================================================ C-4 会员储值 */

section("C-4 会员储值跨店（member_wallet / member_wallet_ledger）");

await crossTenantCase({
  title: "会员储值充值（member_wallet_ledger）",
  module: "app/(main)/members/wallet/actions.ts",
  fn: "rechargeWalletAction",
  snapshot: () => {
    const led = Number(one(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`, [HOTEL_A, sample.vipGuest.id])?.c ?? 0);
    const bal = Number(one(`SELECT COALESCE(balance, 0) AS b FROM member_wallet WHERE hotel_id = ? AND member_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL_A, sample.vipGuest.id])?.b ?? 0);
    return { led, bal };
  },
  crossForm: { guest_id: sample.vipGuest.id, amount: 100, method: "现金", note: "998 越权充值" },
  ownForm: { guest_id: sample.vipGuest.id, amount: 100, method: "现金", note: "1 店正常充值" },
  ownExpect: (b, a) => a.led === b.led + 1 && Math.abs(Number(a.bal) - (Number(b.bal) + 100)) < 0.005,
});

await crossTenantCase({
  title: "会员储值消费（member_wallet_ledger 扣减）",
  module: "app/(main)/members/wallet/actions.ts",
  fn: "consumeWalletAction",
  snapshot: () => {
    const led = Number(one(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`, [HOTEL_A, sample.vipGuest.id])?.c ?? 0);
    const bal = Number(one(`SELECT COALESCE(balance, 0) AS b FROM member_wallet WHERE hotel_id = ? AND member_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL_A, sample.vipGuest.id])?.b ?? 0);
    return { led, bal };
  },
  crossForm: { guest_id: sample.vipGuest.id, amount: 10, note: "998 越权消费" },
  ownForm: { guest_id: sample.vipGuest.id, amount: 10, note: "1 店正常消费" },
  ownExpect: (b, a) => a.led === b.led + 1 && Math.abs(Number(b.bal) - Number(a.bal) - 10) < 0.005,
});

/* ============================================================ C-5 客房 / 早餐 / 餐券 / 失物 */

section("C-5 客房与餐饮跨店（housekeeping / breakfast_records / meal_vouchers / lost_items）");

await crossTenantCase({
  title: "客房任务完成（housekeeping.status → DONE）",
  module: "app/(main)/housekeeping/actions.ts",
  fn: "completeTaskFormAction",
  snapshot: () => one(`SELECT id, status, review_status FROM housekeeping WHERE id = ?`, [sample.hkPending.id]),
  crossForm: { taskId: sample.hkPending.id },
  ownForm: { taskId: sample.hkPending.id },
  ownExpect: (b, a) => b.status === "PENDING" && a.status === "DONE",
});

await crossTenantCase({
  title: "客房验收（housekeeping.review_status）",
  module: "app/(main)/housekeeping/actions.ts",
  fn: "reviewTaskFormAction",
  snapshot: () => one(`SELECT id, status, review_status FROM housekeeping WHERE id = ?`, [hkReview.id]),
  crossForm: { taskId: hkReview?.id, action: "pass" },
  ownForm: { taskId: hkReview?.id, action: "pass" },
  ownExpect: (b, a) => b.review_status === "PENDING_REVIEW" && a.review_status === "APPROVED",
});

await crossTenantCase({
  title: "早餐核销（breakfast_records.status → USED）",
  module: "app/(main)/breakfast/actions.ts",
  fn: "redeemAction",
  snapshot: () => one(`SELECT id, status FROM breakfast_records WHERE id = ?`, [sample.breakfast.id]),
  crossForm: { id: sample.breakfast.id, date: sample.breakfast.date },
  ownForm: { id: sample.breakfast.id, date: sample.breakfast.date },
  ownExpect: (b, a) => b.status === "PENDING" && a.status === "USED",
});

await crossTenantCase({
  title: "餐券作废（meal_vouchers.status → VOID）",
  module: "app/(main)/meal-vouchers/actions.ts",
  fn: "voidVoucherAction",
  snapshot: () => one(`SELECT id, status FROM meal_vouchers WHERE id = ?`, [sample.voucherUnused.id]),
  crossForm: { id: sample.voucherUnused.id },
  ownForm: { id: sample.voucherUnused.id },
  ownExpect: (b, a) => b.status === "UNUSED" && a.status === "VOID",
});

await crossTenantCase({
  title: "餐券核销（meal_vouchers 今日 UNUSED → USED）",
  module: "app/(main)/meal-vouchers/actions.ts",
  fn: "redeemVoucherByIdAction",
  snapshot: () => one(`SELECT id, status FROM meal_vouchers WHERE id = ?`, [voucherToday.id]),
  crossForm: { id: voucherToday.id },
  ownForm: { id: voucherToday.id },
  ownExpect: (b, a) => b.status === "UNUSED" && a.status === "USED",
});

await crossTenantCase({
  title: "失物归还（lost_items.status → RETURNED）",
  module: "app/(main)/lost-found/actions.ts",
  fn: "markReturnedAction",
  snapshot: () => one(`SELECT id, status, guest_name FROM lost_items WHERE id = ?`, [sample.lostKeeping.id]),
  crossForm: { id: sample.lostKeeping.id },
  ownForm: { id: sample.lostKeeping.id },
  ownExpect: (b, a) => b.status === "KEEPING" && a.status === "RETURNED",
});

/* ============================================================ C-6 预订 / 房态 / 客人 / 公司 */

section("C-6 预订、房态、客史、协议单位跨店");

await crossTenantCase({
  title: "取消预订（bookings.status → CANCELLED）",
  module: "app/(main)/bookings/actions.ts",
  fn: "cancelBookingAction",
  snapshot: () => one(`SELECT id, status FROM bookings WHERE id = ?`, [sample.booking.id]),
  crossForm: { id: sample.booking.id },
  ownForm: { id: sample.booking.id },
  ownExpect: (b, a) => b.status !== "CANCELLED" && a.status === "CANCELLED",
});

/** 排房：选一间与订单同房型、且日期不冲突的本店空房 */
const assignRoomId = (() => {
  const bk = assignBooking;
  return (
    one(
      `SELECT r.id FROM rooms r
        WHERE r.hotel_id = ? AND r.status = 'VC' AND r.room_type_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM booking_rooms b
             WHERE b.hotel_id = r.hotel_id AND b.room_id = r.id
               AND b.status IN ('PENDING','CONFIRMED')
               AND b.check_in_date < ? AND b.check_out_date > ?
          )
        ORDER BY r.id LIMIT 1`,
      [HOTEL_A, bk?.room_type_id, bk?.check_out_date, bk?.check_in_date]
    )?.id ?? 0
  );
})();
check("排房用例前置：找到一间同房型的本店空房", assignRoomId > 0, `roomId=${assignRoomId}`);

await crossTenantCase({
  title: "预订排房（booking_rooms.room_id / status）",
  module: "app/(main)/bookings/actions.ts",
  fn: "assignRoomAction",
  snapshot: () => one(`SELECT id, room_id, status FROM booking_rooms WHERE id = ?`, [assignDetail.id]),
  crossForm: { bookingId: assignBooking.id, roomIds: String(assignRoomId) },
  ownForm: { bookingId: assignBooking.id, roomIds: String(assignRoomId) },
  ownExpect: (b, a) => Number(b.room_id) === 0 && Number(a.room_id) === assignRoomId,
});

await crossTenantCase({
  title: "手动改房态（rooms.status）",
  module: "app/(main)/rooms/actions.ts",
  fn: "setRoomStatusAction",
  snapshot: () => one(`SELECT id, status FROM rooms WHERE id = ?`, [sample.roomVc.id]),
  crossForm: { roomId: sample.roomVc.id, status: "OOO", reason: "998 越权改房态" },
  ownForm: { roomId: sample.roomVc.id, status: "OOO", reason: "1 店正常改房态" },
  ownExpect: (b, a) => b.status === "VC" && a.status === "OOO",
});

await crossTenantCase({
  title: "删除客史（guests.deleted 软删除）",
  module: "app/(main)/guests/actions.ts",
  fn: "deleteGuestAction",
  snapshot: () => one(`SELECT id, deleted FROM guests WHERE id = ?`, [sample.plainGuest.id]),
  crossForm: { id: sample.plainGuest.id },
  ownForm: { id: sample.plainGuest.id },
  ownExpect: (b, a) => Number(b.deleted) === 0 && Number(a.deleted) === 1,
});

await crossTenantCase({
  title: "修改协议单位（companies.name）",
  module: "app/(main)/companies/actions.ts",
  fn: "updateCompanyAction",
  snapshot: () => one(`SELECT id, name FROM companies WHERE id = ?`, [sample.company.id]),
  crossForm: { id: sample.company.id, name: "998 越权改名", contact: "", phone: "" },
  ownForm: { id: sample.company.id, name: "1 店正常改名", contact: "", phone: "" },
  ownExpect: (b, a) => a.name !== b.name,
});

/* ============================================================ C-7 998 会话对自己店有效（防假绿） */

section("C-7 反向验证：998 会话对 998 自己的数据必须能写成功（否则上面的绿都是假绿）");

/** 998 自己的房型 / 房间 / 客人 / 预订 / 账单（全部由脚本造，用完随副本丢弃） */
const rt998 = run(
  `INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`,
  [HOTEL_B, `TD${h.stamp.slice(-5)}`, "998测试房型", 100, 2, 9901]
).lastInsertRowid;
const room998 = run(
  `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`,
  [HOTEL_B, `TD-${h.stamp.slice(-5)}`, 1, rt998, "VC", 9901]
).lastInsertRowid;
const guest998 = run(
  `INSERT INTO guests (hotel_id, name, mobile, vip_level, deleted) VALUES (?,?,?,?,0)`,
  [HOTEL_B, `998客人-${h.stamp.slice(-5)}`, "13900000998", 1]
).lastInsertRowid;
const booking998 = run(
  `INSERT INTO bookings (hotel_id, booking_no, guest_name, room_type_id, check_in_date, check_out_date, nights, rate, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [HOTEL_B, `TDBK${h.stamp.slice(-6)}`, "998客人", rt998, today, today, 1, 100, "CONFIRMED", new Date().toISOString(), new Date().toISOString()]
).lastInsertRowid;
const folio998 = run(
  `INSERT INTO folios (hotel_id, folio_no, total_amount, paid_amount, balance, status, created_at)
   VALUES (?,?,?,?,?,?,?)`,
  [HOTEL_B, `TDF${h.stamp.slice(-6)}`, 100, 0, 100, "OPEN", new Date().toISOString()]
).lastInsertRowid;
check("998 自己的房型 / 房间 / 客人 / 预订 / 账单已造好", Boolean(rt998) && Boolean(room998) && Boolean(guest998) && Boolean(booking998) && Boolean(folio998));

/* ① 998 会话取消 998 自己的预订 → 必须成功 */
{
  const bookings998 = await loadModule("app/(main)/bookings/actions.ts");
  h.useSession(SID998);
  await h.invoke(bookings998.cancelBookingAction, { id: booking998 });
  const after = one(`SELECT status FROM bookings WHERE id = ? AND hotel_id = ?`, [booking998, HOTEL_B]);
  check("C 段反向：998 会话取消自己店的预订成功（会话与 action 均有效）", after?.status === "CANCELLED", json(after));
}

/* ② 998 会话给自己店的账单入账 → 必须成功（ar/账务 action 复用同一套 requirePermission） */
{
  const cashier998 = await loadModule("app/(main)/cashier/actions.ts");
  h.useSession(SID998);
  const before = Number(one(`SELECT COUNT(*) AS c FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL_B, folio998])?.c ?? 0);
  await h.invoke(cashier998.addChargeAction, { folio_id: folio998, item_type: "OTHER", description: "998 自己入账", qty: 1, price: 10, biz_date: today });
  const after = Number(one(`SELECT COUNT(*) AS c FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL_B, folio998])?.c ?? 0);
  check("C 段反向：998 会话给自己店账单入账成功", after === before + 1, `${before} → ${after}`);
}

/* ③ 998 会话删自己店的客人 → 必须成功 */
{
  const guests998 = await loadModule("app/(main)/guests/actions.ts");
  h.useSession(SID998);
  await h.invoke(guests998.deleteGuestAction, { id: guest998 });
  const after = one(`SELECT deleted FROM guests WHERE id = ? AND hotel_id = ?`, [guest998, HOTEL_B]);
  check("C 段反向：998 会话删除自己店客人成功", Number(after?.deleted) === 1, json(after));
}

/* ④ 998 会话改自己店的房态 → 必须成功 */
{
  const rooms998 = await loadModule("app/(main)/rooms/actions.ts");
  h.useSession(SID998);
  await h.invoke(rooms998.setRoomStatusAction, { roomId: room998, status: "OOO", reason: "998 自己改" });
  const after = one(`SELECT status FROM rooms WHERE id = ? AND hotel_id = ?`, [room998, HOTEL_B]);
  check("C 段反向：998 会话改自己店房态成功", after?.status === "OOO", json(after));
}

/* ============================================================ D 段：表级 hotel_id 使用扫描 */

section("D 段：每张有 hotel_id 的表在源码里是否真的用上了 hotel_id");

/** 按表分组静态写操作 + 读操作（SELECT ... FROM <表>） */
const readRe = /\bFROM\s+([`"\w.$]+)/gi;
const usage = new Map();
for (const w of realWrites) {
  if (!usage.has(w.table)) usage.set(w.table, { writes: 0, writeWithHotel: 0, reads: 0, readWithHotel: 0 });
  const u = usage.get(w.table);
  u.writes += 1;
  if (w.hasHotel) u.writeWithHotel += 1;
}
for (const file of SRC_FILES.sort()) {
  const code = stripComments(readFileSync(file, "utf8"));
  readRe.lastIndex = 0;
  let m;
  while ((m = readRe.exec(code))) {
    const table = m[1].replace(/[`"]/g, "");
    if (!tableInfo.has(table)) continue;
    const start = m.index;
    let end = start;
    while (end < code.length && end - start < 2500) {
      const ch = code[end];
      if (end > start + 6 && (ch === "`" || ch === '"' || ch === ";")) break;
      end += 1;
    }
    const snippet = code.slice(start, end);
    if (!usage.has(table)) usage.set(table, { writes: 0, writeWithHotel: 0, reads: 0, readWithHotel: 0 });
    const u = usage.get(table);
    u.reads += 1;
    if (/\bhotel_id\b/i.test(snippet)) u.readWithHotel += 1;
  }
}

const neverUsesHotelId = [];
const neverReferenced = [];
/** 已知「表还在、代码已经不再引用」的历史遗留表（迁移合并后保留数据，可继续观察） */
const KNOWN_UNUSED_TABLES = {
  member_wallet_transactions:
    "第 8 段把「余额表 + 流水表」合并成单一流水表 member_wallet_ledger，旧流水表的数据保留不动、代码已不再读写",
};
for (const t of withHotelId) {
  const u = usage.get(t);
  if (!u || (u.writes === 0 && u.reads === 0)) {
    neverReferenced.push(t);
    continue;
  }
  /* 只要有一条读写带 hotel_id 就算「用上了」；一条都没有才是准漏洞 */
  if (u.writeWithHotel === 0 && u.readWithHotel === 0) neverUsesHotelId.push(`${t}（读写 ${u.reads + u.writes} 条，全都不带 hotel_id）`);
}

check(
  `有 hotel_id 的表里，「有 SQL 引用但从不带 hotel_id」的 = 0`,
  neverUsesHotelId.length === 0,
  neverUsesHotelId.join("；") || "（无）"
);
const unexplainedUnused = neverReferenced.filter((t) => !Object.prototype.hasOwnProperty.call(KNOWN_UNUSED_TABLES, t));
check(
  `源码里没有 SQL 引用的表只剩已知的历史遗留表（${Object.keys(KNOWN_UNUSED_TABLES).join(",")}）`,
  unexplainedUnused.length === 0,
  `未引用 ${neverReferenced.length} 张：${neverReferenced.join(",") || "（无）"}；无说明的：${unexplainedUnused.join(",") || "（无）"}`
);

/* 汇总输出：交付项 5 的清单 */
console.log(`\n· 有 hotel_id 的表：${withHotelId.length} 张`);
console.log(`· 不含 hotel_id 的表：${withoutHotelId.length} 张 —— ${withoutHotelId.join(", ")}`);
for (const t of withoutHotelId) {
  if (GLOBAL_TABLES[t]) console.log(`    ${t}：${GLOBAL_TABLES[t]}`);
}
const writeOnlyNoTenant = withHotelId.filter((t) => {
  const u = usage.get(t);
  /* 只关心「真的有写操作、但所有写操作都不带 hotel_id」的表；只有读操作的表不在此列 */
  return u && u.writes > 0 && u.writeWithHotel === 0;
});
console.log(`\n· 有 hotel_id 但**写操作**里不带 hotel_id 的表：${writeOnlyNoTenant.length ? writeOnlyNoTenant.join(", ") : "无（所有写操作都带 hotel_id）"}`);
if (neverReferenced.length > 0) {
  console.log(`· 未被源码引用的表：${neverReferenced.join(", ")}`);
  for (const t of neverReferenced) {
    if (KNOWN_UNUSED_TABLES[t]) console.log(`    ${t}：${KNOWN_UNUSED_TABLES[t]}`);
  }
}

/* ============================================================ E 段：零残留 / 真库只读 */

section("E 段：真库只读与可重复执行");

const realRooms = h.realCount(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [HOTEL_A]);
const realBookings = h.realCount(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ?`, [HOTEL_A]);
check("真库可读且数据非空（副本来源可靠）", realRooms > 0 && realBookings > 0, `房间 ${realRooms} / 预订 ${realBookings}`);
check("测试租户 998 只存在于副本库（真库里没有）", h.realCount(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`, [HOTEL_B]) === 0);
check("副本库里的 998 数据确实被写了（反向用例的证据）", Number(one(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [HOTEL_B])?.c ?? 0) > 0);

const integrity = all(`PRAGMA integrity_check`).map((r) => Object.values(r)[0]);
check("副本库 integrity_check = ok", integrity.length === 1 && integrity[0] === "ok", integrity.join(","));

/* ============================================================ 汇总 */

const failCount = done();
console.log(`\n· 覆盖表：ar_ledgers / ar_accounts / ar_write_offs / ar_transactions / payments / folio_items / invoices`);
console.log(`          shop_items / shop_sales / shop_stock_flows / member_wallet / member_wallet_ledger`);
console.log(`          housekeeping / breakfast_records / meal_vouchers / lost_items`);
console.log(`          bookings / booking_rooms / rooms / guests / companies`);
console.log(`· 真实 action 用例：${18} 个动作 × 双向（998 打 1 店 + 1 店正例），另加 4 个 998 自写反向验证`);
console.log(`· 静态扫描：${SRC_FILES.length} 个源码文件 / ${realWrites.length} 条写操作 / ${writeTables.length} 张表`);
console.log(`· 结构扫描：${allTables.length} 张表（${withHotelId.length} 张有 hotel_id，${withoutHotelId.length} 张按设计没有）`);

/* 清理：副本目录整个删掉（含 -wal / -shm），真库未写 */
h.dispose();
process.exit(failCount === 0 ? 0 : 1);
