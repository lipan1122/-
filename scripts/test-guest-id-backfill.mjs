#!/usr/bin/env node
/**
 * `stays.guest_id` 回填与入住关联验收（第九轮整改 §一.1）
 *
 * ── 清单要求（原文第 22-39 行）──
 *   · 入住创建 stay 时必须写入 guest_id
 *   · 优先按身份证号匹配，其次按手机号
 *   · 只有唯一客史时才允许姓名辅助匹配
 *   · 多个同名客史时必须拒绝并要求前台选择
 *   · 不能选最早 id 作为默认客人
 *   · 对已有在住单执行安全回填，无法唯一匹配的保持为空并生成待处理提示
 *   · 回填必须写操作日志、不能跨酒店
 *   新增测试：唯一身份证匹配 / 唯一手机号匹配 / 同名多客史拒绝 /
 *            跨酒店同名不匹配 / 充值、消费、退款使用同一个 guest_id
 *
 * ── 本脚本怎么验（真库副本，零污染）──
 *   1. `VACUUM INTO` 把 data/pms.db 复制到 .tmp/guest-id-backfill-<时间戳>/data/pms.db，
 *      注入 `globalThis.__pmsDb`（src/lib/db.ts 的 getDb() 优先返回它），
 *      于是跑的是仓库里**真实的** checkInAction / memberRechargeAction /
 *      backfill-stay-guest-id.mjs，写的却是副本库。
 *   2. `registerHooks` 把 next/headers、next/navigation、next/cache 换成最小桩，
 *      并用真实 sessions 表造岗位会话（复用真实 requirePermission 链路）。
 *   3. 数据库层用**自建酒店 901/902 的固定数据**验回填口径（不受真库现状影响，
 *      真库回填后再跑本脚本仍然稳定），入住层用真实 checkInAction 验写入。
 *
 * 用法：node scripts/test-guest-id-backfill.mjs
 *      PMS_DB_PATH=... 可指向别的库（默认项目内 data/pms.db）
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
const ISO_DIR = path.join(ROOT, ".tmp", `guest-id-backfill-${STAMP}`);
const ISO_DB = path.join(ISO_DIR, "data", "pms.db");
const STUB_FILE = path.join(ISO_DIR, "next-stub.mjs");
const HOTEL = 1;
const H_A = 901; // 回填口径固定用例
const H_B = 902; // 跨酒店干扰

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

/* 真库只读指纹：本脚本只写副本 */
const realCounts = () => {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const one = (sql) => Number(db.prepare(sql).get()?.c ?? -1);
    return {
      stays: one(`SELECT COUNT(*) AS c FROM stays`),
      staysNullGuest: one(`SELECT COUNT(*) AS c FROM stays WHERE guest_id IS NULL`),
      guests: one(`SELECT COUNT(*) AS c FROM guests`),
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

/* 生产代码读的库 = 副本库 */
globalThis.__pmsDb = conn;

let frontdesk;
let rooms;
let backfill;
let stub;
try {
  frontdesk = await import("../src/app/(main)/frontdesk/actions.ts");
  rooms = await import("../src/app/(main)/rooms/actions.ts");
  backfill = await import("./backfill-stay-guest-id.mjs");
  stub = await import(stubUrl);
} catch (e) {
  abandon("装载生产代码失败", String(e?.stack ?? e?.message ?? e));
}

/* ============================================================ 2. 固定数据与工具 */
const NOW = new Date().toISOString();
const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const fdOf = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.append(k, v);
  return f;
};
const as = async (role, fn) => {
  stub.setSid(sidOf[role]);
  try {
    return { status: "resolved", value: await fn(), message: "" };
  } catch (e) {
    return { status: "throw", value: undefined, message: String((e && e.message) || e) };
  }
};

/* 真实 sessions 表造岗位会话（复用真实会话/权限链路） */
const sidOf = {};
for (const u of all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL])) {
  const sid = `test-guest-id-${u.role}-${STAMP}`;
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
if (!sidOf.admin) abandon("副本库里没有 admin 用户，无法造会话");

let roomSeq = 0;
/** 新建一间空净房（入住用例用，避免与真库在住单互相干扰） */
function makeVacantRoom(hotelId = HOTEL) {
  roomSeq += 1;
  const rt = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [hotelId]);
  if (!rt) abandon(`酒店 ${hotelId} 没有房型，无法造验收房间`);
  const roomNo = `GT${String(STAMP).slice(-5)}${roomSeq}`;
  const id = Number(
    run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
      hotelId,
      roomNo,
      9,
      rt.id,
      "VC",
      80 + roomSeq,
    ]).lastInsertRowid
  );
  return { id, room_no: roomNo };
}

function insertGuest({ hotelId = HOTEL, name, mobile = null, idNo = null }) {
  return Number(
    run(
      `INSERT INTO guests (hotel_id, name, gender, id_type, id_no, mobile, vip_level, blacklist, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [hotelId, name, "男", "身份证", idNo, mobile, 0, 0, NOW]
    ).lastInsertRowid
  );
}

const stayOfRoom = (roomId, hotelId = HOTEL) =>
  one(`SELECT * FROM stays WHERE hotel_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1`, [hotelId, roomId]);

function checkInForm({ roomId, name, mobile = "", idNo = "", deposit = 0 }) {
  return fdOf({
    mode: "day",
    room_id: String(roomId),
    guest_count: "1",
    guest_name_0: name,
    guest_mobile_0: mobile,
    guest_id_no_0: idNo,
    guest_id_type_0: "身份证",
    guest_gender_0: "男",
    guest_breakfast_0: "0",
    check_in_date: TODAY,
    nights: "1",
    rate_code: "门市价",
    pay_type: "到店付款",
    deposit: String(deposit),
  });
}

try {
  /* ============================================================ 3. 源码守卫 */
  section("1. 源码：入住按「证件号 → 手机号 → 唯一同名」，多同名拒绝");

  const frontSrc = read("src/app/(main)/frontdesk/actions.ts");
  const backSrc = read("scripts/backfill-stay-guest-id.mjs");

  check("入住动作复用 lib/guest-match 的唯一口径", /findGuestByIdentity/.test(frontSrc) && /@\/lib\/guest-match/.test(frontSrc));
  check("同名客史用 findSameNameGuests 查全部候选（不是 LIMIT 1 取一条）", /findSameNameGuests/.test(frontSrc));
  check(
    "不再出现「按姓名 / 按 id 取最早一条」的客史定位",
    !/FROM guests\s+WHERE hotel_id = \? AND id_no = \? ORDER BY id LIMIT 1/.test(frontSrc) &&
      !/FROM guests\s+WHERE hotel_id = \? AND mobile = \? ORDER BY id LIMIT 1/.test(frontSrc)
  );
  check("同名多条时抛错拒绝（提示前台补证件号/手机号或指定客史）", /份同名客史[\s\S]{0,120}guest_id_\$\{gi\}/.test(frontSrc));
  check("允许前台显式指定客史编号（guest_id_<i>）", /readNum\(formData, `guest_id_\$\{gi\}`\)/.test(frontSrc));
  check("主住客客史为空时拒绝开单（不会写出 guest_id 为空的入住单）", /primaryGuestId === null\) throw new Error/.test(frontSrc));
  check(
    "INSERT INTO stays 使用 primaryGuestId 写入 guest_id",
    /INSERT INTO stays[\s\S]{0,700}primaryGuestId,/.test(frontSrc)
  );

  check("回填脚本支持 --check（只报告不写）", /--check/.test(backSrc) && /checkOnly/.test(backSrc));
  check("回填写 op_logs", /INSERT INTO op_logs/.test(backSrc));
  check("回填按 hotel_id 限定（不跨酒店）", /WHERE id = \? AND hotel_id = \? AND guest_id IS NULL/.test(backSrc));
  check("回填只处理 guest_id IS NULL（幂等、不覆盖已有值）", /guest_id IS NULL/.test(backSrc));
  check("回填前 VACUUM INTO 备份", /VACUUM INTO/.test(backSrc));
  check("回填不按最早 id 取默认客人（同名多条一律待处理）", /sameName\.length > 1/.test(backSrc) && /PENDING\.AMBIGUOUS_NAME/.test(backSrc));

  /* ============================================================ 4. 入住：唯一身份证匹配 */
  section("2. 入住：唯一身份证匹配（最可靠，优先于手机号）");

  const idNoA = `GTID${STAMP}A`;
  const guestIdNo = insertGuest({ name: "证件号命中客", idNo: idNoA, mobile: null });
  const room1 = makeVacantRoom();
  const r1 = await as("admin", () =>
    frontdesk.checkInAction(
      checkInForm({ roomId: room1.id, name: "证件号命中客", idNo: idNoA, mobile: `139${String(STAMP).slice(-8)}`, deposit: 100 })
    )
  );
  check("入住成功", r1.value?.ok && !r1.value?.error, `${r1.status} ${r1.value?.error ?? r1.message}`);
  const stay1 = stayOfRoom(room1.id);
  check("入住单已创建", Boolean(stay1));
  check("stays.guest_id 写入的是证件号命中的客史", Number(stay1?.guest_id) === guestIdNo, `guest_id=${stay1?.guest_id} 期望 ${guestIdNo}`);
  check(
    "没有因为手机号不像而新建重复客史",
    Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND name = ?`, [HOTEL, "证件号命中客"])?.c ?? 0) === 1
  );

  /* ============================================================ 5. 入住：唯一手机号匹配 */
  section("3. 入住：唯一手机号匹配（无证件号时的次优身份）");

  const mobileB = `139${String(STAMP).slice(-4)}0001`;
  const guestMobile = insertGuest({ name: "手机号命中客", mobile: mobileB, idNo: null });
  const room2 = makeVacantRoom();
  const r2 = await as("admin", () => frontdesk.checkInAction(checkInForm({ roomId: room2.id, name: "手机号命中客", mobile: mobileB })));
  check("入住成功", r2.value?.ok && !r2.value?.error, `${r2.status} ${r2.value?.error ?? r2.message}`);
  const stay2 = stayOfRoom(room2.id);
  check("stays.guest_id 写入的是手机号命中的客史", Number(stay2?.guest_id) === guestMobile, `guest_id=${stay2?.guest_id} 期望 ${guestMobile}`);
  check("入住单的 guest_id 不为空（P0 的核心断言）", stay2?.guest_id !== null && stay2?.guest_id !== undefined);

  /* ============================================================ 6. 入住：同名多客史拒绝 */
  section("4. 入住：同名多客史必须拒绝（不能选最早 id）");

  const dupName = `同名入住客${String(STAMP).slice(-4)}`;
  const dupA = insertGuest({ name: dupName, mobile: `137${String(STAMP).slice(-4)}0001` });
  const dupB = insertGuest({ name: dupName, mobile: `137${String(STAMP).slice(-4)}0002` });
  const room3 = makeVacantRoom();
  const r3 = await as("admin", () => frontdesk.checkInAction(checkInForm({ roomId: room3.id, name: dupName })));
  const err3 = r3.value?.error ?? "";
  check("同名多条时拒绝办理入住", Boolean(err3), `${r3.status} ok=${r3.value?.ok ?? ""}`);
  check("拒绝提示里写明同名客史数量与候选", /2 份同名客史/.test(err3) && new RegExp(`#${dupA}`).test(err3) && new RegExp(`#${dupB}`).test(err3), err3.slice(0, 120));
  check("拒绝提示里给了出路（补证件号/手机号或指定客史编号）", /guest_id_0/.test(err3), err3.slice(0, 160));
  check("被拒后没有留下入住单", !stayOfRoom(room3.id));
  check("被拒后房间仍是空净（事务已回滚）", one(`SELECT status FROM rooms WHERE id = ?`, [room3.id])?.status === "VC");
  check(
    "被拒后没有偷偷建档/挂到最早那条客史",
    Number(one(`SELECT COUNT(*) AS c FROM guests WHERE hotel_id = ? AND name = ?`, [HOTEL, dupName])?.c ?? 0) === 2
  );

  /* 显式指定客史编号 → 允许通过（前台的唯一出路真的能用） */
  const room3b = makeVacantRoom();
  const r3b = await as("admin", () =>
    frontdesk.checkInAction(checkInForm({ roomId: room3b.id, name: dupName, extra: undefined }))
  );
  check("同名歧义下再次直接提交仍被拒（口径稳定）", Boolean(r3b.value?.error), r3b.value?.error ?? "");
  const fd3c = checkInForm({ roomId: room3b.id, name: dupName });
  fd3c.set("guest_id_0", String(dupB));
  const r3c = await as("admin", () => frontdesk.checkInAction(fd3c));
  check("带 guest_id_0 指定客史后可以办理入住", Boolean(r3c.value?.ok), r3c.value?.error ?? "");
  check("入住单挂的正是前台选中的那条客史", Number(stayOfRoom(room3b.id)?.guest_id) === dupB, `guest_id=${stayOfRoom(room3b.id)?.guest_id} 期望 ${dupB}`);

  /* ============================================================ 7. 入住：跨酒店同名不匹配 */
  section("5. 入住：跨酒店同名不能串档");

  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [H_B, `T${STAMP}`, "验收酒店B", NOW]);
  const crossName = `跨店入住客${String(STAMP).slice(-4)}`;
  const crossGuestB = insertGuest({ hotelId: H_B, name: crossName, mobile: `136${String(STAMP).slice(-4)}0009` });
  const room4 = makeVacantRoom();
  const r4 = await as("admin", () => frontdesk.checkInAction(checkInForm({ roomId: room4.id, name: crossName })));
  check("入住成功（本店没有同名档案 → 新建，而不是拒绝）", Boolean(r4.value?.ok), r4.value?.error ?? "");
  const stay4 = stayOfRoom(room4.id);
  const newGuest4 = one(`SELECT id, hotel_id, name FROM guests WHERE hotel_id = ? AND name = ? ORDER BY id DESC LIMIT 1`, [HOTEL, crossName]);
  check("本店新建了自己的客史", Boolean(newGuest4) && newGuest4.hotel_id === HOTEL);
  check("没有挂到另一家酒店的同名客史", Number(stay4?.guest_id) === Number(newGuest4?.id) && Number(stay4?.guest_id) !== crossGuestB, `guest_id=${stay4?.guest_id} 别店=${crossGuestB}`);
  check(
    "别店（hotel_id=902）的客史没有被改写",
    Number(one(`SELECT COUNT(*) AS c FROM guests WHERE id = ? AND hotel_id = ?`, [crossGuestB, H_B])?.c ?? 0) === 1
  );

  /* ============================================================ 8. 回填脚本口径 */
  section("6. 回填脚本：手机号 → 唯一同名 → 其余保持为空（固定用例）");

  run(`INSERT OR IGNORE INTO hotels (id, code, name, created_at) VALUES (?,?,?,?)`, [H_A, `A${STAMP}`, "验收酒店A", NOW]);
  const gA = insertGuest({ hotelId: H_A, name: "手机号命中客", mobile: `MOB${STAMP}` });
  const gB = insertGuest({ hotelId: H_A, name: "唯一姓名客", mobile: null });
  const gC1 = insertGuest({ hotelId: H_A, name: "同名客", mobile: `1390000${String(STAMP).slice(-4)}1` });
  insertGuest({ hotelId: H_A, name: "同名客", mobile: `1390000${String(STAMP).slice(-4)}2` });
  insertGuest({ hotelId: H_B, name: "跨店同名", mobile: null });

  /* 回填用例用酒店 A 自己的房型/房间（stays.room_id 非空） */
  const rtA = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL]);
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy) VALUES (?,?,?,?,?)`, [
    H_A,
    `BFRT${String(STAMP).slice(-4)}`,
    "验收房型",
    200,
    2,
  ]);
  const rtAown = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [H_A]);
  const roomA = Number(
    run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
      H_A,
      `BF${String(STAMP).slice(-4)}`,
      1,
      rtAown?.id ?? rtA?.id,
      "VC",
      1,
    ]).lastInsertRowid
  );
  const mkStay = (label, { name, mobile = null, status = "CHECKED_OUT", guestId = null }) =>
    Number(
      run(
        `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, mobile, rate, status, check_in_time, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [H_A, `BF${STAMP}${label}`, roomA, guestId, name, mobile, 200, status, NOW, NOW]
      ).lastInsertRowid
    );

  const sMobile = mkStay("M1", { name: "手机号命中客", mobile: `MOB${STAMP}` });
  const sName = mkStay("N1", { name: "唯一姓名客", status: "INHOUSE" });
  const sDup = mkStay("D1", { name: "同名客" });
  const sNoGuest = mkStay("X1", { name: "查无此人", mobile: `1399${String(STAMP).slice(-6)}` });
  const sSecondInhouse = mkStay("N2", { name: "唯一姓名客", status: "INHOUSE" });
  const sCross = mkStay("C1", { name: "跨店同名" });
  const sAlready = mkStay("A1", { name: "已关联客", guestId: gA });

  const plan = backfill.collectPlan(conn, H_A);
  check("待回填只统计 guest_id IS NULL 的入住单", plan.stats.total === 6, `total=${plan.stats.total}`);
  check("可安全匹配 2 条", plan.stats.matched === 2, JSON.stringify(plan.stats.byMatchedBy));
  check("手机号命中 1 条、唯一同名 1 条", plan.stats.byMatchedBy.mobile === 1 && plan.stats.byMatchedBy.name === 1, JSON.stringify(plan.stats.byMatchedBy));
  check("待处理 4 条", plan.stats.pending === 4, JSON.stringify(plan.stats.pendingByReason));
  const mByStay = new Map(plan.matched.map((m) => [m.stay.id, m]));
  check("手机号命中 → 客史正确", Number(mByStay.get(sMobile)?.guestId) === gA);
  check("唯一同名 → 客史正确", Number(mByStay.get(sName)?.guestId) === gB);
  const pByStay = new Map(plan.pending.map((p) => [p.stay.id, p]));
  check("同名多客史 → 待处理（不选最早 id）", pByStay.get(sDup)?.reason === backfill.PENDING.AMBIGUOUS_NAME && !mByStay.has(sDup), pByStay.get(sDup)?.reason ?? "missing");
  check("同名多客史没有被挂到 #gC1（最早那条）", Number(one(`SELECT guest_id FROM stays WHERE id = ?`, [sDup])?.guest_id ?? 0) !== gC1);
  check("查无客史 → 待处理", pByStay.get(sNoGuest)?.reason === backfill.PENDING.NO_GUEST);
  check("同一客史已有在住单 → 待处理（不造一客两住）", pByStay.get(sSecondInhouse)?.reason === backfill.PENDING.DUPLICATE_INHOUSE, pByStay.get(sSecondInhouse)?.reason ?? "missing");
  check("跨酒店同名 → 待处理（本店没有该客史）", pByStay.get(sCross)?.reason === backfill.PENDING.NO_GUEST);
  check("已有 guest_id 的入住单不在候选里", !plan.todo.some((s) => s.id === sAlready));

  /* ============================================================ 9. 回填写库：日志 / 幂等 / 不跨酒店 */
  section("7. 回填写库：op_logs、幂等、不覆盖、不跨酒店");

  const logsBefore = Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ?`, [H_A])?.c ?? 0);
  const applied = backfill.applyPlan(conn, plan, { now: NOW });
  check("回填写入 2 条", applied.updated === 2, `updated=${applied.updated}`);
  check("每条回填都写一条 op_logs + 每店一条汇总", applied.logRows === 3, `logRows=${applied.logRows}`);
  check(
    "op_logs 真的落库（action=客史回填）",
    Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = ?`, [H_A, backfill.OP_ACTION])?.c ?? 0) === 3
  );
  check("op_logs 增加了对应条数", Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ?`, [H_A])?.c ?? 0) === logsBefore + 3);
  check(
    "日志内容可追溯（含入住单号与客史编号）",
    Boolean(one(`SELECT id FROM op_logs WHERE hotel_id = ? AND detail LIKE ? AND detail LIKE ?`, [H_A, `%${mByStay.get(sMobile).stay.stay_no}%`, `%#${gA}%`]))
  );
  check("手机号命中的入住单已写入 guest_id", Number(one(`SELECT guest_id FROM stays WHERE id = ?`, [sMobile])?.guest_id) === gA);
  check("唯一同名的入住单已写入 guest_id", Number(one(`SELECT guest_id FROM stays WHERE id = ?`, [sName])?.guest_id) === gB);
  check("待处理记录保持为空", one(`SELECT guest_id FROM stays WHERE id = ?`, [sDup])?.guest_id === null);
  check("已有 guest_id 的记录未被改写", Number(one(`SELECT guest_id FROM stays WHERE id = ?`, [sAlready])?.guest_id) === gA);
  check(
    "不跨酒店：别店同名客史没被挂上",
    Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND guest_id IS NOT NULL`, [H_B])?.c ?? 0) === 0
  );

  const planAgain = backfill.collectPlan(conn, H_A);
  const appliedAgain = backfill.applyPlan(conn, planAgain, { now: NOW });
  check("第二次运行没有可回填的（幂等）", planAgain.stats.matched === 0 && appliedAgain.updated === 0, `matched=${planAgain.stats.matched} updated=${appliedAgain.updated}`);
  check(
    "第二次运行没有重复写 op_logs",
    Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = ?`, [H_A, backfill.OP_ACTION])?.c ?? 0) === 3
  );
  check("第二次运行待处理清单仍完整（人工处理项不消失）", planAgain.stats.pending === 4, `pending=${planAgain.stats.pending}`);

  /* ============================================================ 10. 资金流水使用同一个 guest_id */
  section("8. 充值 / 消费 / 退款使用同一个 guest_id");

  const stayId8 = Number(stay1.id);
  const guestId8 = Number(stay1.guest_id);
  const ridRecharge = `GT-RC-${STAMP}`;
  const recharge = await as("admin", () =>
    rooms.memberRechargeAction(
      fdOf({
        stay_id: String(stayId8),
        amount: "500",
        method: "现金",
        reason: "验收充值",
        request_id: ridRecharge,
      })
    )
  );
  check("会员充值（只带 stay_id）成功", Boolean(recharge.value?.ok), recharge.value?.error ?? recharge.message);
  const ledger = one(`SELECT member_id, amount FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [HOTEL, ridRecharge]);
  check("充值记到入住单的 guest_id 上", Number(ledger?.member_id) === guestId8, `member_id=${ledger?.member_id} 期望 ${guestId8}`);

  const ridCharge = `GT-CH-${STAMP}`;
  const charge = await as("admin", () =>
    rooms.addOtherChargeAction(
      fdOf({ stay_id: String(stayId8), description: "验收消费", amount: "30", request_id: ridCharge })
    )
  );
  check("客房消费成功", Boolean(charge.value?.ok), charge.value?.error ?? charge.message);
  const chargeLink = one(
    `SELECT s.guest_id AS guestId FROM folio_items fi
       JOIN folios f ON f.id = fi.folio_id
       JOIN stays s ON s.id = f.stay_id
      WHERE fi.hotel_id = ? AND fi.request_id = ?`,
    [HOTEL, ridCharge]
  );
  check("消费明细回溯到同一个 guest_id", Number(chargeLink?.guestId) === guestId8, `guestId=${chargeLink?.guestId}`);

  /* 退款：payments.refund_of 关联原收款，原收款与退款都落在同一账单 → 同一 stay → 同一 guest */
  const pay = one(`SELECT id, folio_id, stay_id FROM payments WHERE hotel_id = ? AND stay_id = ? ORDER BY id LIMIT 1`, [HOTEL, stayId8]);
  check("入住押金留下了收款流水（退款的对象）", Boolean(pay));
  const ridRefund = `GT-RF-${STAMP}`;
  run(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, refund_of, operator)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [HOTEL, pay?.folio_id ?? null, stayId8, `P-RF-${STAMP}`, "现金", -100, TODAY, "验收退款", NOW, ridRefund, pay?.id ?? null, "验收"]
  );
  const refundLink = one(
    `SELECT p.id, p.refund_of, s.guest_id AS guestId
       FROM payments p
       JOIN folios f ON f.id = p.folio_id
       JOIN stays s ON s.id = f.stay_id
      WHERE p.hotel_id = ? AND p.request_id = ?`,
    [HOTEL, ridRefund]
  );
  check("退款流水挂在原收款上（refund_of）", Number(refundLink?.refund_of) === Number(pay?.id));
  check("退款流水回溯到同一个 guest_id（不会退错人）", Number(refundLink?.guestId) === guestId8, `guestId=${refundLink?.guestId} 期望 ${guestId8}`);
  check(
    "充值 / 消费 / 退款三条链路解析出同一个 guest_id",
    Number(ledger?.member_id) === guestId8 && Number(chargeLink?.guestId) === guestId8 && Number(refundLink?.guestId) === guestId8
  );

  /* ============================================================ 11. 收尾 */
  section("9. 真库零写入");

  const REAL_AFTER = realCounts();
  check(
    "真库 stays / guests 行数与空 guest_id 数量都未变（只写副本）",
    REAL_AFTER.stays === REAL_BEFORE.stays &&
      REAL_AFTER.guests === REAL_BEFORE.guests &&
      REAL_AFTER.staysNullGuest === REAL_BEFORE.staysNullGuest,
    `${JSON.stringify(REAL_BEFORE)} → ${JSON.stringify(REAL_AFTER)}`
  );
  check(
    "副本上确实写过回填结果（断言都打在副本上）",
    Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND guest_id IS NOT NULL`, [H_A])?.c ?? 0) >= 2 &&
      Number(one(`SELECT COUNT(*) AS c FROM op_logs WHERE hotel_id = ? AND action = ?`, [H_A, backfill.OP_ACTION])?.c ?? 0) >= 3
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
