#!/usr/bin/env node
/**
 * 房间卡资金操作幂等验收（第九轮整改 §一.4）
 *
 * ── 清单要求（原文第 126-151 行）──
 *   房间卡片里的这些操作都要有稳定 request_id：
 *     会员充值 / 押金 / 房费 / 其他消费 / 收款 / 退款
 *   · 页面生成稳定 request_id
 *   · 隐藏字段提交
 *   · 网络结果未知时重试复用同一个 request_id
 *   · 成功后下一次操作才生成新 request_id
 *   · 服务端唯一索引兜底
 *   · 双击只产生一笔流水
 *   新增测试：双击充值 / 双击押金 / 双击房费 / 网络重试 / 并发提交 /
 *            request_id 跨酒店不能复用
 *
 * ── 入口对照（房间卡里这 6 个操作分别落在哪）──
 *   会员充值   → RoomBoard「会员充值」表单 + rooms/actions.memberRechargeAction
 *   押金       → RoomBoard「预收款(押金)」表单 + rooms/actions.addDepositAction
 *   房费       → RoomBoard「加收房费」表单 + rooms/actions.addRoomFeeAction
 *   其他消费   → RoomBoard「客房消费」表单 + rooms/actions.addOtherChargeAction
 *   收款       → 房间卡里的收款按钮就是「预收款(押金)·确认收款」，同一个 addDepositAction
 *                （账单收款 /cashier 的 addPaymentAction 属收银台入口，不在本次可改范围）
 *   退款       → 房间卡没有退款入口，退款走收银台 refundPaymentAction（payments.request_id
 *                同一套唯一索引；本文件第 4 节验证 payments 的索引与跨酒店边界）
 *
 * ── 本脚本怎么验（真库副本，零污染）──
 *   1. VACUUM INTO 复制 data/pms.db → .tmp/room-action-idem-<时间戳>/data/pms.db，
 *      注入 globalThis.__pmsDb，跑仓库里**真实的** rooms/actions.ts。
 *   2. registerHooks 把 next/* 换成最小桩，用真实 sessions 表造岗位会话。
 *   3. 同一 request_id 连调两次 / 并发调两次 / 外部连接抢先写 → 断言只落一笔，
 *      且第二次返回成功（幂等重放）而不是报错。
 *
 * 用法：node scripts/test-room-action-idempotency.mjs
 * 退出码：有 ❌ 时 1，全绿 0。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const STAMP = Date.now();
const ISO_DIR = path.join(ROOT, ".tmp", `room-action-idem-${STAMP}`);
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function abandon(message, detail = "") {
  console.error(`\n❌ ${message}${detail ? `\n   ${detail}` : ""}`);
  try {
    fs.rmSync(ISO_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不掩盖原错误 */
  }
  process.exit(1);
}

if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs）`);

const realCounts = () => {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const one = (sql) => Number(db.prepare(sql).get()?.c ?? -1);
    return {
      payments: one(`SELECT COUNT(*) AS c FROM payments`),
      folioItems: one(`SELECT COUNT(*) AS c FROM folio_items`),
      ledger: one(`SELECT COUNT(*) AS c FROM member_wallet_ledger`),
    };
  } finally {
    db.close();
  }
};
const REAL_BEFORE = realCounts();

try {
  fs.mkdirSync(path.join(ISO_DIR, "data"), { recursive: true });
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${ISO_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
} catch (e) {
  abandon(`复制真库失败：${REAL_DB} → ${ISO_DB}`, String(e?.message ?? e));
}

let conn;
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

conn = new DatabaseSync(ISO_DB);
conn.exec("PRAGMA busy_timeout = 8000");
const one = (sql, params = []) => conn.prepare(sql).get(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);
const run = (sql, params = []) => conn.prepare(sql).run(...params);

/* ============================================================ 1. next/* 桩 + 模块解析 */
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
  if (w && w.code === "ExperimentalWarning") return;
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

globalThis.__pmsDb = conn;

let rooms;
let stub;
try {
  rooms = await import("../src/app/(main)/rooms/actions.ts");
  stub = await import(stubUrl);
} catch (e) {
  abandon("装载 src/app/(main)/rooms/actions.ts 失败", String(e?.stack ?? e?.message ?? e));
}

/* ============================================================ 2. 会话与验收数据 */
const NOW = new Date().toISOString();
const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const sidOf = {};
for (const u of all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL])) {
  const sid = `test-room-idem-${u.role}-${STAMP}`;
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
if (!sidOf.admin) abandon("副本库里没有 admin 用户");

const as = async (role, fn) => {
  stub.setSid(sidOf[role]);
  try {
    return { status: "resolved", value: await fn(), message: "" };
  } catch (e) {
    return { status: "throw", value: undefined, message: String((e && e.message) || e) };
  }
};
const fdOf = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.append(k, v);
  return f;
};
const isOk = (res) => Boolean(res.status === "resolved" && res.value && res.value.ok && !res.value.error);
const msgOf = (res) => res.value?.error ?? res.value?.ok ?? res.message ?? "";

/* 验收用房间 + 在住单 + 账单 */
const rt = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL]);
if (!rt) abandon("房间类型不存在，无法造验收房间");
const testRoom = Number(
  run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
    HOTEL,
    `RM${String(STAMP).slice(-5)}`,
    9,
    rt.id,
    "OC",
    77,
  ]).lastInsertRowid
);
const testStay = Number(
  run(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, rate, status, check_in_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `IDEM${String(STAMP).slice(-6)}`, testRoom, null, "幂等验收客人", null, 300, "INHOUSE", NOW, NOW]
  ).lastInsertRowid
);
const testFolio = Number(
  run(
    `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `FIDEM${String(STAMP).slice(-6)}`, testStay, "幂等验收客人", `RM${String(STAMP).slice(-5)}`, 0, 0, 0, "OPEN", NOW]
  ).lastInsertRowid
);
const guestId = Number(
  run(
    `INSERT INTO guests (hotel_id, name, mobile, vip_level, blacklist, created_at) VALUES (?,?,?,?,?,?)`,
    [HOTEL, `幂等会员${String(STAMP).slice(-4)}`, `135${String(STAMP).slice(-8)}`, 0, 0, NOW]
  ).lastInsertRowid
);
/* 会员充值按 stay_id 找客史：把入住单挂到这个会员上 */
run(`UPDATE stays SET guest_id = ? WHERE id = ? AND hotel_id = ?`, [guestId, testStay, HOTEL]);

const folioRow = () => one(`SELECT total_amount, paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`, [testFolio, HOTEL]);
const stayRow = () => one(`SELECT deposit FROM stays WHERE id = ? AND hotel_id = ?`, [testStay, HOTEL]);
const payCount = (rid) =>
  rid
    ? Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND request_id = ?`, [HOTEL, rid])?.c ?? 0)
    : Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND stay_id = ?`, [HOTEL, testStay])?.c ?? 0);
const itemCount = (rid, type) =>
  Number(
    one(
      `SELECT COUNT(*) AS c FROM folio_items
        WHERE hotel_id = ? AND folio_id = ? AND request_id = ? ${type ? "AND item_type = ?" : ""}`,
      type ? [HOTEL, testFolio, rid, type] : [HOTEL, testFolio, rid]
    )?.c ?? 0
  );
const ledgerCount = (rid) =>
  Number(one(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [HOTEL, rid])?.c ?? 0);
const opLogCount = (action) =>
  Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = ?`, [HOTEL, action])?.c ?? 0);

try {
  /* ============================================================ 3. 源码守卫：页面 */
  section("1. RoomBoard.tsx：四种资金操作都有稳定 request_id 隐藏字段");

  const boardSrc = read("src/components/RoomBoard.tsx");
  const actionsSrc = read("src/app/(main)/rooms/actions.ts");

  check("用 crypto.randomUUID 生成请求号", /\.randomUUID\(\)/.test(boardSrc));
  check("randomUUID 先做能力检测（非安全上下文不抛错）", /typeof c\.randomUUID === "function"/.test(boardSrc));
  check(
    "http（内网 IP + 非安全上下文）降级：getRandomValues 手工拼 v4",
    /c\.getRandomValues\(buf\)/.test(boardSrc) && /0x40/.test(boardSrc) && /0x80/.test(boardSrc)
  );
  check("最终兜底：时间戳 + Math.random", /`rid-\$\{Date\.now\(\)\.toString\(36\)\}/.test(boardSrc));
  check(
    "request_id 存在组件 state 里（同一表单重试复用同一枚）",
    /function useMoneyRequestIds\(\)[\s\S]{0,400}useState<Record<string, string>>/.test(boardSrc)
  );
  check(
    "挂载后才生成（首帧空串，服务端渲染与 hydration 一致）",
    /useState<Record<string, string>>\(\{\}\)/.test(boardSrc) && /useEffect\(\(\) => \{[\s\S]{0,600}newRequestId\(\)/.test(boardSrc)
  );
  check("押金 / 房费 / 消费 / 充值各一枚键，互不串号", /\{ ids, bump \}/.test(boardSrc) && /MONEY_REQUEST_KEYS = \["deposit", "addfee", "consume", "recharge"\]/.test(boardSrc));

  const hiddenByKey = ["deposit", "addfee", "consume", "recharge"].map((k) => ({
    k,
    n: (boardSrc.match(new RegExp(`name="request_id" value=\\{requestIds\\.${k} \\?\\? ""\\}`, "g")) || []).length,
  }));
  check(
    "四种资金操作各两处（悬停面板 + 房间抽屉）都提交隐藏字段 request_id",
    hiddenByKey.every((x) => x.n === 2),
    JSON.stringify(hiddenByKey)
  );
  check("隐藏字段用 type=hidden 提交（不是拼在 URL 上）", (boardSrc.match(/type="hidden" name="request_id"/g) || []).length === 8);
  check(
    "悬停面板：成功才换新键（失败/结果未知保留同一枚重试）",
    /if \(!r\.error\) \{[\s\S]{0,220}bumpRequestId\(op\)/.test(boardSrc)
  );
  check(
    "房间抽屉：成功才换新键，失败直接 return 不动 request_id",
    /if \(result && result\.error\) \{[\s\S]{0,200}return;[\s\S]{0,300}if \(moneyKey\) bumpRequestId\(moneyKey\)/.test(boardSrc)
  );
  check(
    "四种资金操作在抽屉里都带上了幂等键名",
    /submitWith\(addDepositAction, "deposit"\)/.test(boardSrc) &&
      /submitWith\(addRoomFeeAction, "addfee"\)/.test(boardSrc) &&
      /submitWith\(addOtherChargeAction, "consume"\)/.test(boardSrc) &&
      /submitWith\(memberRechargeAction, "recharge"\)/.test(boardSrc)
  );
  check("没有用 useState(() => newRequestId()) 在渲染期取随机值（会 hydration mismatch）", !/useState\(\(\) => newRequestId\(\)\)/.test(boardSrc));

  /* ============================================================ 4. 源码守卫：服务端 */
  section("2. rooms/actions.ts：查重 + 唯一索引兜底");

  check("统一读取 request_id", /function readRequestId\(formData: FormData\)/.test(actionsSrc));
  check("加收类明细查重（folio_items 按 hotel_id + request_id）", /FROM folio_items[\s\S]{0,160}WHERE hotel_id = \? AND request_id = \?/.test(actionsSrc));
  check("收款流水查重（payments 按 hotel_id + request_id）", /FROM payments[\s\S]{0,120}WHERE hotel_id = \? AND request_id = \?/.test(actionsSrc));
  check("唯一冲突按幂等重放处理（UNIQUE → 成功提示，不抛 500）", /function isUniqueViolation[\s\S]{0,220}UNIQUE constraint failed/.test(actionsSrc));
  check(
    "三个资金动作的 INSERT 都写 request_id",
    (actionsSrc.match(/INSERT INTO folio_items \(hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by, request_id\)/g) || []).length >= 3 &&
      /*
       * payments 的列清单后面允许跟 `kind`（第九轮清单第一.2 给押金加的结构化字段）。
       * 断言的核心是「request_id 在这条 INSERT 的列清单里」，
       * 不该因为后面又加了别的列就变红。
       */
      /INSERT INTO payments \(hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, operator(?:, kind)?\)/.test(
        actionsSrc
      )
  );
  check("会员充值把 request_id 传给唯一记账入口 rechargeWallet", /const requestId = str\(formData, "request_id"\) \|\| undefined;/.test(actionsSrc) && /requestId,\n\s*\}\);/.test(actionsSrc));

  /* ============================================================ 5. 唯一索引 */
  section("3. 数据库：request_id 唯一索引兜得住（按酒店分段）");

  for (const [name, table] of [
    ["idx_payments_request", "payments"],
    ["idx_folio_items_request", "folio_items"],
    ["idx_wallet_ledger_request", "member_wallet_ledger"],
  ]) {
    const idx = one(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [name]);
    check(
      `${table}(hotel_id, request_id) 部分唯一索引存在`,
      Boolean(idx && /UNIQUE/i.test(idx.sql) && /WHERE request_id IS NOT NULL/i.test(idx.sql)),
      idx?.sql ?? "缺索引"
    );
  }

  const RID_IDX = `RID-IDX-${STAMP}`;
  run(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, testFolio, "OTHER", "索引验收", 1, 10, 10, TODAY, NOW, RID_IDX]
  );
  let blocked = false;
  try {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [HOTEL, testFolio, "OTHER", "索引验收重复", 1, 10, 10, TODAY, NOW, RID_IDX]
    );
  } catch {
    blocked = true;
  }
  check("同一 (hotel_id, request_id) 第二次写入被索引拒绝", blocked);
  run(`DELETE FROM folio_items WHERE hotel_id = ? AND request_id = ?`, [HOTEL, RID_IDX]);

  /* 跨酒店：同一枚 request_id 在另一家酒店可以各自存在，但互不影响 */
  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [HOTEL_B, `RID${STAMP}`, "验收酒店B", NOW]);
  const RID_CROSS = `RID-CROSS-${STAMP}`;
  let crossOk = true;
  try {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [HOTEL_B, 0, "OTHER", "别店同键", 1, 10, 10, TODAY, NOW, RID_CROSS]
    );
  } catch {
    crossOk = false;
  }
  check("同一 request_id 在另一家酒店可以存在（索引按 hotel_id 分段）", crossOk);

  /* ============================================================ 6. 押金双击 */
  section("4. 押金：双击只收一笔（payments / folio_items / paid_amount / stays.deposit 都不翻倍）");

  const RID_DEP = `RID-DEP-${STAMP}`;
  const depFd = () => fdOf({ stay_id: String(testStay), amount: "100", method: "现金", request_id: RID_DEP });
  const depLogsBefore = opLogCount("预收款");
  const dep1 = await as("admin", () => rooms.addDepositAction(depFd()));
  check("第一次收押金成功", isOk(dep1), msgOf(dep1));
  check("只产生 1 笔收款流水", payCount(RID_DEP) === 1, `n=${payCount(RID_DEP)}`);
  check("只产生 1 条 DEPOSIT 明细", itemCount(RID_DEP, "DEPOSIT") === 1, `n=${itemCount(RID_DEP, "DEPOSIT")}`);
  const folioAfterDep1 = folioRow();
  const stayAfterDep1 = stayRow();
  check("账单已收 +100", Math.abs(Number(folioAfterDep1?.paid_amount) - 100) < 0.005, `paid=${folioAfterDep1?.paid_amount}`);
  check("入住单押金 +100", Math.abs(Number(stayAfterDep1?.deposit) - 100) < 0.005, `deposit=${stayAfterDep1?.deposit}`);

  const dep2 = await as("admin", () => rooms.addDepositAction(depFd()));
  check("第二次提交（双击第二下 / 网络重试）返回成功而不是报错", isOk(dep2), msgOf(dep2));
  check("第二次提示是「重复提交已忽略」", /重复提交已忽略/.test(msgOf(dep2)), msgOf(dep2));
  check("第二次没有再收款（payments 仍 1 笔）", payCount(RID_DEP) === 1, `n=${payCount(RID_DEP)}`);
  check("第二次没有再加明细（DEPOSIT 仍 1 条）", itemCount(RID_DEP, "DEPOSIT") === 1);
  check("账单 paid_amount 没有翻倍", Math.abs(Number(folioRow()?.paid_amount) - 100) < 0.005, `paid=${folioRow()?.paid_amount}`);
  check("stays.deposit 没有翻倍", Math.abs(Number(stayRow()?.deposit) - 100) < 0.005, `deposit=${stayRow()?.deposit}`);
  check("操作日志只有 1 条（重放不重复写日志）", opLogCount("预收款") === depLogsBefore + 1, `${depLogsBefore} → ${opLogCount("预收款")}`);

  /* 新 request_id = 新的一笔（成功后换键的效果） */
  const RID_DEP2 = `RID-DEP2-${STAMP}`;
  const dep3 = await as("admin", () =>
    rooms.addDepositAction(fdOf({ stay_id: String(testStay), amount: "50", method: "微信", request_id: RID_DEP2 }))
  );
  check("换新 request_id 后可以正常收第二笔", isOk(dep3), msgOf(dep3));
  check("第二笔独立成流水（总额 2 笔）", payCount(RID_DEP) + payCount(RID_DEP2) === 2);
  check("押金累计 150", Math.abs(Number(stayRow()?.deposit) - 150) < 0.005, `deposit=${stayRow()?.deposit}`);

  /* ============================================================ 7. 押金并发 + 唯一索引兜底 */
  section("5. 押金：并发同键 + 外部先手（唯一索引兜底）");

  const RID_DEPC = `RID-DEPC-${STAMP}`;
  const [dc1, dc2] = await Promise.all([
    as("admin", () => rooms.addDepositAction(fdOf({ stay_id: String(testStay), amount: "20", method: "现金", request_id: RID_DEPC }))),
    as("admin", () => rooms.addDepositAction(fdOf({ stay_id: String(testStay), amount: "20", method: "现金", request_id: RID_DEPC }))),
  ]);
  check("并发两路都返回成功（没有 500 / 没有 error）", isOk(dc1) && isOk(dc2), `${msgOf(dc1)} | ${msgOf(dc2)}`);
  check("并发之后只收一笔", payCount(RID_DEPC) === 1, `n=${payCount(RID_DEPC)}`);

  /*
   * 竞态：外部连接（另一进程）先把同一 request_id 的**明细**写进去，
   * 但还没有收款流水 —— 本请求靠明细唯一索引兜底，整个事务回滚并按重放返回成功。
   */
  const RID_DEPR = `RID-DEPR-${STAMP}`;
  const conn2 = new DatabaseSync(ISO_DB);
  try {
    conn2
      .prepare(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(HOTEL, testFolio, "DEPOSIT", "并发先手押金", 1, 30, 30, TODAY, NOW, RID_DEPR);
  } finally {
    conn2.close();
  }
  const depRace = await as("admin", () =>
    rooms.addDepositAction(fdOf({ stay_id: String(testStay), amount: "30", method: "现金", request_id: RID_DEPR }))
  );
  check("外部已写明细时，本请求按幂等重放返回成功（唯一索引兜底，不抛 500）", isOk(depRace), msgOf(depRace));
  check("兜底路径没有留下半截收款（payments 仍 0 笔）", Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND request_id = ?`, [HOTEL, RID_DEPR])?.c ?? 0) === 0);

  /* ============================================================ 8. 房费双击 */
  section("6. 房费：双击只加一笔（账单应收不翻倍）");

  const RID_FEE = `RID-FEE-${STAMP}`;
  const feeFd = () => fdOf({ stay_id: String(testStay), amount: "80", biz_date: TODAY, remark: "验收房费", request_id: RID_FEE });
  const totalBeforeFee = Number(folioRow()?.total_amount ?? 0);
  const fee1 = await as("admin", () => rooms.addRoomFeeAction(feeFd()));
  check("第一次加收房费成功", isOk(fee1), msgOf(fee1));
  check("只产生 1 条房费明细", itemCount(RID_FEE, "ROOM") === 1, `n=${itemCount(RID_FEE, "ROOM")}`);
  const totalAfterFee1 = Number(folioRow()?.total_amount ?? 0);
  check("账单应收 +80", Math.abs(totalAfterFee1 - totalBeforeFee - 80) < 0.005, `${totalBeforeFee} → ${totalAfterFee1}`);

  const fee2 = await as("admin", () => rooms.addRoomFeeAction(feeFd()));
  check("第二次提交返回成功（幂等重放）", isOk(fee2), msgOf(fee2));
  check("第二次提示「重复提交已忽略」", /重复提交已忽略/.test(msgOf(fee2)), msgOf(fee2));
  check("房费明细仍 1 条", itemCount(RID_FEE, "ROOM") === 1);
  check(
    "账单应收没有翻倍",
    Math.abs(Number(folioRow()?.total_amount ?? 0) - totalAfterFee1) < 0.005,
    `${totalAfterFee1} → ${folioRow()?.total_amount}`
  );

  /* ============================================================ 9. 其他消费双击 */
  section("7. 其他消费：双击只记一笔");

  const RID_OTH = `RID-OTH-${STAMP}`;
  const othFd = () => fdOf({ stay_id: String(testStay), description: "迷你吧", amount: "25", request_id: RID_OTH });
  const totalBeforeOth = Number(folioRow()?.total_amount ?? 0);
  const oth1 = await as("admin", () => rooms.addOtherChargeAction(othFd()));
  check("第一次记消费成功", isOk(oth1), msgOf(oth1));
  check("只产生 1 条 OTHER 明细", itemCount(RID_OTH, "OTHER") === 1, `n=${itemCount(RID_OTH, "OTHER")}`);
  const oth2 = await as("admin", () => rooms.addOtherChargeAction(othFd()));
  check("第二次返回成功（幂等重放）", isOk(oth2), msgOf(oth2));
  check("消费明细仍 1 条", itemCount(RID_OTH, "OTHER") === 1);
  check(
    "账单应收只加了一次",
    Math.abs(Number(folioRow()?.total_amount ?? 0) - totalBeforeOth - 25) < 0.005,
    `${totalBeforeOth} → ${folioRow()?.total_amount}`
  );

  /* ============================================================ 10. 会员充值双击 */
  section("8. 会员充值：双击只入账一笔储值");

  const RID_RC = `RID-RC-${STAMP}`;
  const rcFd = () =>
    fdOf({ stay_id: String(testStay), amount: "300", method: "微信", reason: "验收充值", request_id: RID_RC })
      ;
  const rc1 = await as("admin", () => rooms.memberRechargeAction(rcFd()));
  check("第一次充值成功", isOk(rc1), msgOf(rc1));
  check("储值流水 1 笔", ledgerCount(RID_RC) === 1, `n=${ledgerCount(RID_RC)}`);
  check("流水记到入住单的 guest_id 上", Number(one(`SELECT member_id FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [HOTEL, RID_RC])?.member_id) === guestId);
  const rc2 = await as("admin", () => rooms.memberRechargeAction(rcFd()));
  check("第二次返回成功（幂等重放）", isOk(rc2), msgOf(rc2));
  check("储值流水仍 1 笔（没有充两次）", ledgerCount(RID_RC) === 1, `n=${ledgerCount(RID_RC)}`);
  check(
    "储值余额只加了一次",
    Math.abs(Number(one(`SELECT COALESCE(SUM(amount),0) AS s FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`, [HOTEL, guestId])?.s ?? 0) - 300) < 0.005
  );

  /* ============================================================ 11. 跨酒店 request_id */
  section("9. request_id 跨酒店不串号");

  const RID_X = `RID-X-${STAMP}`;
  run(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL_B, 0, "ROOM", "别店同键房费", 1, 999, 999, TODAY, NOW, RID_X]
  );
  const xFee = await as("admin", () =>
    rooms.addRoomFeeAction(fdOf({ stay_id: String(testStay), amount: "10", biz_date: TODAY, remark: "跨店同键", request_id: RID_X }))
  );
  check("别店已有同 key 不影响本店入账（不跨店查重）", isOk(xFee), msgOf(xFee));
  check("本店照常记了这笔房费", itemCount(RID_X, "ROOM") === 1, `n=${itemCount(RID_X, "ROOM")}`);
  check(
    "别店那条明细没有被改写",
    Number(one(`SELECT COUNT(*) AS c FROM folio_items WHERE hotel_id = ? AND request_id = ? AND amount = 999`, [HOTEL_B, RID_X])?.c ?? 0) === 1
  );

  /* ============================================================ 12. 权限没放宽 */
  section("10. 幂等改造没有放宽权限");

  const denied = await as("housekeeping", () =>
    rooms.addDepositAction(fdOf({ stay_id: String(testStay), amount: "10", method: "现金", request_id: `RID-DENY-${STAMP}` }))
  );
  check(
    "housekeeping 收押金仍被拒（FORBIDDEN: cashier.receive）",
    denied.status === "throw" && /FORBIDDEN/.test(denied.message) && /cashier\.receive/.test(denied.message),
    `${denied.status} ${denied.message}`
  );
  check("被拒的请求没有留下流水", payCount(`RID-DENY-${STAMP}`) === 0);

  /* ============================================================ 13. 收尾 */
  section("11. 真库零写入");

  const REAL_AFTER = realCounts();
  check(
    "真库 payments / folio_items / 储值流水行数未变（只写副本）",
    REAL_AFTER.payments === REAL_BEFORE.payments &&
      REAL_AFTER.folioItems === REAL_BEFORE.folioItems &&
      REAL_AFTER.ledger === REAL_BEFORE.ledger,
    `${JSON.stringify(REAL_BEFORE)} → ${JSON.stringify(REAL_AFTER)}`
  );
  check(
    "副本上确实写入了验收流水（断言都打在副本上）",
    Number(one(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND request_id LIKE 'RID-%'`, [HOTEL])?.c ?? 0) >= 3
  );
} finally {
  try {
    conn.close();
  } catch {
    /* 已关闭 */
  }
}

console.log("\n========== 汇总 ==========");
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("❌ 未通过项：");
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("结果：全部通过 ✅");
