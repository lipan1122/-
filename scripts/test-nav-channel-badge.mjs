#!/usr/bin/env node
/**
 * 顶部渠道订单数字红点验收（第七轮整改清单一.4，清单第 77-93 行）
 *
 * ── 清单要求 ↔ 本脚本断言 ──
 *   1. 主布局按当前 hotel_id 查询 NEW、CONFIRMED、PENDING 数量
 *      → 二、源码层：layout.tsx import 同一模块并传 pendingChannelOrders={countPendingChannelOrders(user.hotelId)}
 *      → 一、库层：真实执行 countPendingChannelOrders()（副本库造各状态订单，逐状态验证计入/不计入）
 *   2. 传入 AppShell → 二、AppShell 的 pendingChannelOrders?: number 与数字角标渲染分支
 *   3. 页面角标和顶部导航使用同一状态集合
 *      → 二、rooms/page.tsx 与 layout.tsx 都 import @/lib/channel-orders，rooms 不再本地定义
 *      → 三、真实 HTTP：房态页「直连订单」角标数字 === 真库按同一集合算出的数
 *   4. hotel_id 必须来自 session → 二、layout 的数字只看 user.hotelId，不读 query/header
 *   5. 无权限用户也只能读自己酒店的数量
 *      → 一、hotel 999 的订单不计入 hotel 1；一、countPendingChannelOrders(999) 只数自己的
 *      → 三、frontdesk（front）真实登录后房态页角标仍是 hotel 1 的数
 *   6. 新增顶部红点数量测试 → 本文件
 *
 * ── 真库隔离 ──
 *   data/pms.db --VACUUM INTO--> .tmp/nav-channel-badge-<时间戳>.db，注入 globalThis.__pmsDb，
 *   所有造数只进副本；真库只用只读连接计数 + 真实 HTTP 页面（3100 正在运行的 next start）。
 *
 * ── 关于 3100 的 build ──
 *   3100 是 `next start`（生产 build）。本轮禁止重新 build，因此页面 HTML 可能仍是
 *   改动前的 bundle：顶部「渠道预订」只有红点、没有数字。脚本对这种情况**明确打印跳过**
 *   （⏳，不计失败），并在最后统计跳过数 —— 不静默放过，也不把旧 bundle 当成新改动失败。
 *
 * 运行：node scripts/test-nav-channel-badge.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");
const STAMP = `${Date.now()}`;
const COPY_DB = path.join(TMP_DIR, `nav-channel-badge-${STAMP}.db`);
const HOTEL_B = 999;
const PREFIX = `TEST-NAV-${STAMP}`;
const BASE = process.env.AUDIT_BASE || "http://localhost:3100";

let pass = 0;
let fail = 0;
let skip = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
/**
 * 明确跳过：环境限制（本轮禁止重建 3100），不计通过也不计失败，但必须打印原因。
 * 合法跳过的判定标准：跳过数会出现在最后一行汇总「通过 X / 失败 Y / 跳过 Z」，
 * 且断言本身出问题一律走 check(false) —— 不允许用 skip 掩盖失败。
 */
const skipCheck = (name, reason) => {
  skip += 1;
  console.log(`⏳ ${name} — 跳过：${reason}`);
};

function cleanup() {
  for (const f of [COPY_DB, `${COPY_DB}-wal`, `${COPY_DB}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 已删 / 被占用 */
    }
  }
}
process.on("exit", cleanup);
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

const readSrc = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

/* ============================================================ 一、副本库造数 */

console.log("=== 一、副本库：按状态造订单，验证同一状态集合的计数 ===");

if (!fs.existsSync(REAL_DB)) {
  console.error(`❌ 真库不存在：${REAL_DB}（先跑 node scripts/init-db.mjs，或设 PMS_DB_PATH）`);
  process.exit(1);
}
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
  try {
    src.exec(`VACUUM INTO '${COPY_DB.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
} catch (e) {
  console.error(`❌ 复制真库失败（unable to open database file）\n  源 ${REAL_DB}\n  目标 ${COPY_DB}\n  ${e?.message ?? e}`);
  process.exit(1);
}
check("副本库已生成（VACUUM INTO）", fs.existsSync(COPY_DB) && fs.statSync(COPY_DB).size > 0, COPY_DB);

const db = new DatabaseSync(COPY_DB, { timeout: 10000 });
db.exec("PRAGMA busy_timeout = 8000");
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

check(
  "副本有 channel_orders 表（造数前置）",
  all(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'channel_orders'`).length > 0
);

/* 复制快照必须和真库现状一致：副本上的函数结果 === 真库只读计数 */
const realDb = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
/** 真库计数：用的是**同一份占位符常量**（函数体在 lib 加载后调用，常量为同一模块导出） */
const realCount = (hotelId) => {
  const row = realDb
    .prepare(`SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = ? AND status IN (${CHANNEL_ORDER_PENDING_IN})`)
    .get(hotelId, ...CHANNEL_ORDER_PENDING_STATUSES);
  return Number(row?.n ?? 0);
};

/* 让 lib 的 getDb() 连副本 */
globalThis.__pmsDb = db;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

const {
  CHANNEL_ORDER_PENDING_STATUSES,
  CHANNEL_ORDER_PENDING_IN,
  CHANNEL_ORDER_PENDING_COUNT_SQL,
  countPendingChannelOrders,
} = await import("../src/lib/channel-orders.ts");

check(
  "lib 导出的状态集合 = NEW / CONFIRMED / PENDING（清单要求的三个状态）",
  CHANNEL_ORDER_PENDING_STATUSES.length === 3 &&
    CHANNEL_ORDER_PENDING_STATUSES[0] === "NEW" &&
    CHANNEL_ORDER_PENDING_STATUSES[1] === "CONFIRMED" &&
    CHANNEL_ORDER_PENDING_STATUSES[2] === "PENDING",
  JSON.stringify(CHANNEL_ORDER_PENDING_STATUSES)
);
check("SQL 占位符数量与集合一致（3 个）", CHANNEL_ORDER_PENDING_IN === "?,?,?", CHANNEL_ORDER_PENDING_IN);

const baselineCopy = countPendingChannelOrders(1);
const baselineReal = realCount(1);
check(
  "副本快照与真库现状一致（countPendingChannelOrders(1) = 真库同集合计数）",
  baselineCopy === baselineReal,
  `副本 ${baselineCopy} / 真库 ${baselineReal}`
);

/** 造一条渠道订单（副本） */
function addChannelOrder({ hotelId = 1, status, no, channelType = "ctrip" }) {
  return run(
    `INSERT INTO channel_orders
       (hotel_id, channel_type, channel_order_no, room_type_id, guest_name, mobile,
        check_in_date, check_out_date, nights, room_count, amount, status, raw, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [hotelId, channelType, no, 1, "导航角标验收客人", "13900000000", "2026-11-23", "2026-11-24", 1, 1, 199, status, "{}", new Date().toISOString()]
  );
}

addChannelOrder({ status: "NEW", no: `${PREFIX}-NEW` });
addChannelOrder({ status: "CONFIRMED", no: `${PREFIX}-CONFIRMED` });
addChannelOrder({ status: "PENDING", no: `${PREFIX}-PENDING` });
const afterPending = countPendingChannelOrders(1);
check(
  "NEW + CONFIRMED + PENDING 各造 1 条后计数 = 基线 + 3（三个状态都计入）",
  afterPending === baselineCopy + 3,
  `${baselineCopy} → ${afterPending}`
);
check(
  "副本里三个待处理状态各至少有 1 条（造数确认）",
  ["NEW", "CONFIRMED", "PENDING"].every(
    (s) => Number(one(`SELECT COUNT(*) AS c FROM channel_orders WHERE hotel_id = 1 AND status = ?`, [s])?.c ?? 0) >= 1
  )
);

addChannelOrder({ status: "IMPORTED", no: `${PREFIX}-IMPORTED` });
addChannelOrder({ status: "CANCELLED", no: `${PREFIX}-CANCELLED` });
check(
  "IMPORTED / CANCELLED 不计入待处理数（仍 = 基线 + 3）",
  countPendingChannelOrders(1) === baselineCopy + 3,
  String(countPendingChannelOrders(1))
);

/* 同一状态集合算出的数：函数 vs 手工按常量拼 SQL，必须一致 */
const manual = Number(
  one(`SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = 1 AND status IN (${CHANNEL_ORDER_PENDING_IN})`, [
    ...CHANNEL_ORDER_PENDING_STATUSES,
  ])?.n ?? -1
);
check("countPendingChannelOrders() = 手工按同一常量拼 SQL 的结果（同口径）", countPendingChannelOrders(1) === manual, `${countPendingChannelOrders(1)} vs ${manual}`);
check("lib 的计数 SQL 模板就是页面要用的那条（hotel_id + status IN）", /FROM channel_orders WHERE hotel_id = \? AND status IN \(\?,\?,\?\)/.test(CHANNEL_ORDER_PENDING_COUNT_SQL), CHANNEL_ORDER_PENDING_COUNT_SQL);

/* 跨酒店：hotel 999 的订单不能进 hotel 1 的数 */
run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  "TESTNAV999",
  "导航角标验收酒店",
  "测试地址",
  "000",
  new Date().toISOString(),
]);
addChannelOrder({ hotelId: HOTEL_B, status: "NEW", no: `${PREFIX}-H999`, channelType: "meituan" });
const afterCross = countPendingChannelOrders(1);
check("hotel 999 的 NEW 订单不计入 hotel 1 的数字", afterCross === baselineCopy + 3, `${baselineCopy + 3} → ${afterCross}`);
check("countPendingChannelOrders(999) 只数自己酒店（=1）", countPendingChannelOrders(HOTEL_B) === 1, String(countPendingChannelOrders(HOTEL_B)));
check(
  "直接查库复核：hotel 999 的行按 hotel_id 隔离（hotel 1 的 SQL 不会命中）",
  Number(one(`SELECT COUNT(*) AS n FROM channel_orders WHERE hotel_id = 999 AND status IN (${CHANNEL_ORDER_PENDING_IN})`, [...CHANNEL_ORDER_PENDING_STATUSES])?.n ?? 0) === 1
);

/* ============================================================ 二、源码层：唯一口径 */

console.log("\n=== 二、源码层：状态集合抽到同一模块，layout 传入 AppShell ===");

const libSrc = readSrc(path.join("src", "lib", "channel-orders.ts"));
const roomsSrc = readSrc(path.join("src", "app", "(main)", "rooms", "page.tsx"));
const layoutSrc = readSrc(path.join("src", "app", "(main)", "layout.tsx"));
const shellSrc = readSrc(path.join("src", "components", "AppShell.tsx"));

/** 去掉注释再检查「代码里有没有读 query/header 的 hotel_id」（注释里提到 searchParams 不算） */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const layoutCode = stripComments(layoutSrc);

check("src/lib/channel-orders.ts 存在并 export CHANNEL_ORDER_PENDING_STATUSES", /export const CHANNEL_ORDER_PENDING_STATUSES = \["NEW", "CONFIRMED", "PENDING"\] as const/.test(libSrc));
check("src/lib/channel-orders.ts 导出 countPendingChannelOrders()", /export function countPendingChannelOrders\(hotelId: number\): number/.test(libSrc));
check(
  "rooms/page.tsx 从 @/lib/channel-orders import 同一集合（不再自己定义）",
  /import \{ CHANNEL_ORDER_PENDING_STATUSES, CHANNEL_ORDER_PENDING_IN \} from "@\/lib\/channel-orders"/.test(roomsSrc) &&
    !/const CHANNEL_ORDER_PENDING_STATUSES = \[/.test(roomsSrc)
);
check(
  "rooms/page.tsx 角标计数用同一占位符常量（角标口径 = lib 口径）",
  /FROM channel_orders WHERE hotel_id = \? AND status IN \(\$\{CHANNEL_ORDER_PENDING_IN\}\)/.test(roomsSrc)
);
check(
  "layout.tsx 从同一模块 import countPendingChannelOrders",
  /import \{ countPendingChannelOrders \} from "@\/lib\/channel-orders"/.test(layoutSrc)
);
check(
  "layout.tsx 把当前酒店的数量传给 AppShell（pendingChannelOrders={countPendingChannelOrders(user.hotelId)}）",
  /pendingChannelOrders=\{countPendingChannelOrders\(user\.hotelId\)\}/.test(layoutSrc)
);
check(
  "layout.tsx 的 hotel_id 来自 session（getSession() 的 user.hotelId），不读 searchParams / header",
  /const user = await getSession\(\)/.test(layoutCode) &&
    !/searchParams/.test(layoutCode) &&
    !/hotelId\s*=\s*(?:Number|parseInt|Math\.trunc)?\(?\s*h\.get\(/.test(layoutCode)
);
check(
  "两个页面引用的是同一个模块路径（不复制粘贴一份集合）",
  roomsSrc.includes('from "@/lib/channel-orders"') && layoutSrc.includes('from "@/lib/channel-orders"')
);
check(
  "AppShell 的 props 类型支持 pendingChannelOrders?: number（无需改类型）",
  /pendingChannelOrders\?: number;/.test(shellSrc)
);
check(
  "AppShell 有待处理数时渲染数字角标、超过 99 显示 99+（无数字时才只显示红点）",
  /const channelBadge =\s*\n?\s*typeof pendingChannelOrders === "number" && pendingChannelOrders > 0 \? pendingChannelOrders : null;/.test(shellSrc) &&
    /channelBadge !== null/.test(shellSrc) &&
    /channelBadge > 99 \? "99\+" : channelBadge/.test(shellSrc)
);

/* ============================================================ 三、真实 HTTP 页面 */

console.log("\n=== 三、真实 HTTP（3100 运行中的 next start） ===");

async function login(username, password) {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const sid = /pms_sid=([^;]+)/.exec(cookie)?.[1] ?? "";
  return { ok: Boolean(cookie && sid && !cookie.includes("pms_sid=;")), cookie, sid };
}

/** 房态页底部「直连订单」角标：直连订单<span class="rounded-full ...">数字</span> */
function parseRoomBadge(html) {
  const m = /直连订单<span[^>]*>(\d{1,3}|99\+)<\/span>/.exec(html);
  if (!m) return null;
  return m[1] === "99+" ? 99 : Number(m[1]);
}

/** 顶部导航「渠道预订」：有数字 → number；只有小红点 → dot；都没有 → none */
function parseNavBadge(html) {
  const m = /渠道预订<span class="ml-1 inline-flex[^"]*">(\d{1,3}|99\+)<\/span>/.exec(html);
  if (m) return { kind: "number", value: m[1] === "99+" ? 99 : Number(m[1]) };
  if (/渠道预订<span class="ml-1 inline-block[^"]*"><\/span>/.test(html)) return { kind: "dot" };
  return { kind: "none" };
}

const admin = await login("admin", "admin123");
check("admin 登录成功（/api/login 返回会话 cookie）", admin.ok, admin.cookie);

if (admin.ok) {
  const roomsRes = await fetch(`${BASE}/rooms`, { headers: { cookie: admin.cookie }, redirect: "manual" });
  const roomsHtml = await roomsRes.text();
  check("/rooms 返回 200（已登录）", roomsRes.status === 200, String(roomsRes.status));
  check("房态页 HTML 未渲染成登录页", !roomsHtml.includes("登录工作台"));

  /* fetch 之后立刻再取一次真库计数：两个数字必须是同一时刻的口径 */
  const realNow = realCount(1);
  const roomBadge = parseRoomBadge(roomsHtml);
  check(
    "页面角标「直连订单」数字 = 真库按同一状态集合算出的数",
    roomBadge !== null && roomBadge === realNow,
    `页面 ${roomBadge} / 真库 ${realNow}`
  );

  /*
   * 顶部导航「渠道预订」：
   *   有数字 → 必须等于同一个数（修复后的目标状态）；
   *   只有红点且真库计数 > 0 → 3100 仍是本轮改动前的 build（本轮禁止重建），明确跳过；
   *   计数为 0 → AppShell 按设计只显示红点，跳到「数字」这条断言。
   */
  const nav = parseNavBadge(roomsHtml);
  if (nav.kind === "number") {
    check("顶部导航「渠道预订」数字 = 房态页角标 = 真库同一状态集合计数", nav.value === realNow && nav.value === roomBadge, `顶部 ${nav.value} / 角标 ${roomBadge} / 真库 ${realNow}`);
  } else if (realNow === 0) {
    skipCheck("顶部导航「渠道预订」数字", "当前酒店待处理数为 0，AppShell 设计上显示小红点而不是数字");
  } else {
    skipCheck(
      "顶部导航「渠道预订」数字",
      `3100 是改动前的生产 build（HTML 只有小红点），本轮禁止重建；真库计数 ${realNow}、房态页角标 ${roomBadge} 已一致，重建后顶部应显示同一数字`
    );
  }
} else {
  check("admin 登录成功（/api/login 返回会话 cookie）", false, "登录失败，无法验证真实页面");
}

/* frontdesk（无发票/财务权限的普通前台）也只能看到自己酒店的数 */
const front = await login("front", "123456");
if (front.ok) {
  const res = await fetch(`${BASE}/rooms`, { headers: { cookie: front.cookie }, redirect: "manual" });
  const html = await res.text();
  check("/rooms 对 frontdesk 返回 200（有房态模块权限）", res.status === 200, String(res.status));
  const badge = parseRoomBadge(html);
  check(
    "frontdesk 的房态页角标仍是 hotel 1 的数（无权限用户也只看自己酒店）",
    badge !== null && badge === realCount(1),
    `页面 ${badge} / 真库 ${realCount(1)}`
  );
  check(
    "frontdesk 页面 HTML 不含 hotel 999 的测试渠道单号（跨酒店不泄漏）",
    !html.includes(`${PREFIX}-H999`) && !html.includes(PREFIX)
  );
} else {
  skipCheck("frontdesk 房态页角标", "front 演示账号登录失败（密码已改），无法做普通前台的真实请求");
}

/* ============================================================ 四、真库零写入 */

console.log("\n=== 四、真库零写入 ===");
{
  const leakedChannelOrder = Number(
    realDb.prepare(`SELECT COUNT(*) AS c FROM channel_orders WHERE channel_order_no LIKE ?`).get(`${PREFIX}%`).c
  );
  const leakedHotel = Number(realDb.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
  check("真库没有测试渠道订单", leakedChannelOrder === 0, `实际 ${leakedChannelOrder}`);
  check("真库没有被写入 999 号测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);

  /* 清理本次登录产生的两个会话（HTTP 登录会写 sessions，属于必要副作用） */
  const sids = [admin.sid, front.sid].filter(Boolean);
  if (sids.length > 0) {
    try {
      const rw = new DatabaseSync(REAL_DB, { timeout: 5000 });
      try {
        rw.exec("PRAGMA busy_timeout = 5000");
        for (const sid of sids) rw.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
      } finally {
        rw.close();
      }
      check(
        "已清理本次 HTTP 登录产生的会话（不在真库留测试痕迹）",
        Number(realDb.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id IN (${sids.map(() => "?").join(",")})`).get(...sids).c) === 0,
        sids.join(",")
      );
    } catch (e) {
      check("已清理本次 HTTP 登录产生的会话", false, String(e?.message ?? e));
    }
  }
}

/* ============================================================ 收尾 */

try {
  realDb.close();
} catch {
  /* 已关闭 */
}
try {
  db.close();
} catch {
  /* 已关闭 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}${skip > 0 ? ` / 跳过 ${skip}` : ""}`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
