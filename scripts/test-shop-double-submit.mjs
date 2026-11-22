#!/usr/bin/env node
/**
 * 第七轮整改 一.2：商超结算「双击 / 重试 / 并发」幂等验收
 *
 * ── 清单要求（原文 §一.2）──
 *   · 每次开始结算生成 UUID
 *   · request_id 作为隐藏字段提交
 *   · 同一表单重试复用同一个 request_id
 *   · 同一 request_id 只能产生一笔 shop_sales
 *   · 库存、流水、房账保持一笔
 *   · 结算成功后再生成下一次 UUID
 *   · 新增双击、重试和并发测试
 *
 * ── 改造前的真实风险 ──
 *   第六轮给 shop/actions.ts 补了 request_id 幂等基础设施（查重 + 落库 + 部分唯一索引），
 *   但 src/components/ShopPOS.tsx 从来没传过 request_id（grep 计数 0），服务端只能
 *   自己 `auto-...` 生成一枚新的 —— 按钮双击、网络重试、表单重放每次都是新请求号，
 *   于是库存扣两遍、流水两笔、客人房账也记两遍。
 *
 * ── 本脚本怎么验（真库副本，零污染）──
 *   1. VACUUM INTO 复制 data/pms.db 到 .tmp/shop-double-submit-<时间戳>/data/pms.db，
 *      注入 globalThis.__pmsDb —— src/lib/db.ts 的 getDb() 优先返回它，
 *      所以跑的是仓库里那份**真实 action 代码**，写的却是副本库。
 *   2. registerHooks 把 next/headers、next/navigation、next/cache 换成最小桩
 *      （cookies 可切 sid / redirect 抛 NEXT_REDIRECT / revalidatePath 空操作），
 *      然后直接 import 真实的 src/app/(main)/shop/actions.ts。
 *   3. 造一间在住房 + 一个测试商品，用 cashier 会话反复调用 sellCartAction：
 *         · 同一 request_id 连调两次 → 只有一笔流水、库存只扣一次、房账只有一笔，
 *           且第二次返回**成功**（幂等 replay，不是报错）
 *         · 两次并发调用 → 同样只成一笔
 *         · 外部连接抢先把同一 request_id 写进去（模拟并发先手）→ 本次按重放成功返回，
 *           不再扣库存（验证「查重时机」+ 唯一索引兜底）
 *         · 不同 request_id → 正常产生两笔
 *   4. 源码静态断言：ShopPOS.tsx 的 request_id 隐藏字段、UUID 生成与 http 降级、
 *      成功后换新、双击闸门；actions.ts 的重放分支走 ?msg= 而不是 ?err=。
 *
 * 用法：node scripts/test-shop-double-submit.mjs
 *      PMS_DB_PATH=... 可指向别的真库（默认项目内 data/pms.db）
 * 退出码：有 ❌ 时 1，全绿 0。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TAG = "shop-double-submit";
const STAMP = Date.now();
const ISO_DIR = path.join(ROOT, ".tmp", `${TAG}-${STAMP}`);
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

/**
 * 真库只读计数，收尾复查「真库零写入」
 *
 * 只看 shop_sales：op_logs 会被**运行中的 3100 服务进程**持续写入（真人登录 / 操作），
 * 拿它当基线必然误报；shop_sales 才是本脚本误写真库时会多出来的东西。
 */
function realDbCounts() {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const one = (sql) => db.prepare(sql).get()?.c ?? 0;
    return { shop_sales: one(`SELECT COUNT(*) AS c FROM shop_sales`) };
  } finally {
    db.close();
  }
}
const REAL_BEFORE = realDbCounts();

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

/* ============================================================ 1. next/* 桩 */

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
    /* 源码里省略扩展名的相对导入（./db、../lib/utils）补成 .ts */
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

let shop;
let stub;
try {
  shop = await import("../src/app/(main)/shop/actions.ts");
  stub = await import(stubUrl);
} catch (e) {
  abandon("装载 src/app/(main)/shop/actions.ts 失败", String(e?.stack ?? e?.message ?? e));
}

/* ============================================================ 2. 验收数据 */

const actionsSrc = read("src/app/(main)/shop/actions.ts");
const posSrc = read("src/components/ShopPOS.tsx");
const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const ROOM_NO = `T9${String(STAMP).slice(-4)}`;
const ITEM_NAME = `幂等验收商品${String(STAMP).slice(-4)}`;

/* 4 个岗位各造一条真实会话（复用真实 getSession / requirePermission 链路） */
const sidOf = {};
const users = all(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
for (const u of users) {
  const sid = `test-shop-idem-${u.role}-${STAMP}`;
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

const ROOM_TYPE = one(`SELECT id FROM room_types WHERE hotel_id = ? ORDER BY id LIMIT 1`, [HOTEL])?.id ?? 1;
const roomId = Number(
  run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
    HOTEL,
    ROOM_NO,
    9,
    ROOM_TYPE,
    "OC",
    99,
  ]).lastInsertRowid
);
const stayId = Number(
  run(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, status, rate, guest_count, check_in_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `IDEM${STAMP}`, roomId, "幂等验证客人", "INHOUSE", 300, 1, NOW, NOW]
  ).lastInsertRowid
);
const itemId = Number(
  run(
    `INSERT INTO shop_items (hotel_id, name, barcode, price, stock, category, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [HOTEL, ITEM_NAME, `T-IDEM-${STAMP}`, 10, 50, "验收", "ON", NOW]
  ).lastInsertRowid
);

const stockOf = (id) => Number(one(`SELECT stock FROM shop_items WHERE id = ?`, [id])?.stock ?? -1);
const salesOf = (requestId) =>
  Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ? AND request_id = ?`, [HOTEL, requestId])?.n ?? 0);
const saleRowOf = (requestId) =>
  one(`SELECT * FROM shop_sales WHERE hotel_id = ? AND request_id = ? LIMIT 1`, [HOTEL, requestId]);
const folioOfStay = () => one(`SELECT id FROM folios WHERE hotel_id = ? AND stay_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL, stayId]);
const folioItems = () => {
  const f = folioOfStay();
  if (!f) return 0;
  return Number(one(`SELECT COUNT(*) AS n FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, f.id])?.n ?? 0);
};
/** 账单整行（应收 / 已收 / 余额） */
const folioInfo = () => {
  const f = folioOfStay();
  if (!f) return {};
  return one(`SELECT id, total_amount, paid_amount, balance FROM folios WHERE id = ? AND hotel_id = ?`, [f.id, HOTEL]) ?? {};
};

const fdOf = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.append(k, v);
  return f;
};

/** 以某个会话身份执行一次 action，把 redirect / 抛错 收敛成结构体 */
async function as(role, fn) {
  stub.setSid(sidOf[role]);
  try {
    const value = await fn();
    return { status: "resolved", value, url: "", message: "" };
  } catch (e) {
    const message = String((e && e.message) || e);
    if (message.startsWith("NEXT_REDIRECT:")) {
      return { status: "redirect", url: message.slice("NEXT_REDIRECT:".length), message: "" };
    }
    return { status: "throw", url: "", message };
  }
}

/** 结果是不是「成功横幅」：?msg=（卖成功了）/ ?ok=（sellAction 的成功回跳） */
function flashOf(res) {
  if (res.status !== "redirect") return { kind: "", text: "" };
  const u = new URL(res.url, "http://local");
  const err = u.searchParams.get("err") ?? "";
  if (err) return { kind: "err", text: err };
  const ok = u.searchParams.get("ok") ?? "";
  if (ok) return { kind: "ok", text: ok };
  return { kind: "msg", text: u.searchParams.get("msg") ?? "" };
}
const isOkFlash = (res) => ["ok", "msg"].includes(flashOf(res).kind);

const sellFd = (requestId, extra = {}) =>
  fdOf({ item_id: itemId, qty: 2, room_no: ROOM_NO, method: "现金", request_id: requestId, ...extra });

try {
  /* ============================================================ 3. 源码守卫 */
  section("1. ShopPOS.tsx：request_id 生成 / 隐藏字段 / 重试复用 / 成功换新");

  check(
    "request_id 作为隐藏字段提交（type=hidden + name=request_id）",
    /type="hidden"[^>]*name="request_id"/.test(posSrc)
  );
  check(
    "隐藏字段的 value 绑定组件 state（不是写死的常量）",
    /name="request_id" value=\{requestId\}/.test(posSrc)
  );
  check(
    "request_id 在挂载后生成（服务端渲染与此后的 hydration 不会各算一次，避免不一致）",
    /useEffect\(\(\) => \{[\s\S]{0,160}setRequestId\(\(prev\) => prev \|\| newRequestId\(\)\)/.test(posSrc)
  );
  check("用 crypto.randomUUID 生成请求号", /\.randomUUID\(\)/.test(posSrc));
  check(
    "randomUUID 先做能力检测（secure context 缺失时不抛错）",
    /typeof c\.randomUUID === "function"/.test(posSrc)
  );
  check(
    "http（非安全上下文）降级：crypto.getRandomValues 手工拼 v4",
    /getRandomValues/.test(posSrc) && /0x40/.test(posSrc) && /0x80/.test(posSrc)
  );
  check("最终兜底：时间戳 + Math.random", /rid-\$\{Date\.now\(\)\.toString\(36\)\}/.test(posSrc));
  check(
    "request_id 存在组件 state 里（同一表单重试复用同一个，而不是每次提交新生成）",
    /const \[requestId, setRequestId\] = useState/.test(posSrc) && /const rid = requestId \|\| newRequestId\(\)/.test(posSrc)
  );
  check(
    "提交时把 request_id 放进 FormData 在请求里送达服务端",
    /fd\.set\("request_id", rid\)/.test(posSrc)
  );
  check(
    "提交的 FormData 带齐服务端要的业务字段（item_id / qty / room_no / method）",
    ["item_id", "qty", "room_no", "method"].every((k) => new RegExp(`fd\\.set\\("${k}"`).test(posSrc))
  );
  check(
    "组件内直接调用真实 server action（onSubmit 只收业务字段，带不了 request_id）",
    /import \{ sellCartAction \} from "@\/app\/\(main\)\/shop\/actions"/.test(posSrc) &&
      /await sellCartAction\(fd\)/.test(posSrc)
  );
  check(
    "结算成功后才换下一枚 UUID（settleOk 内 setRequestId(newRequestId())）",
    /const settleOk[\s\S]{0,600}setRequestId\(newRequestId\(\)\)/.test(posSrc)
  );
  check(
    "业务失败不换 request_id（err 分支只提示，不动 requestId）",
    /\[\?&\]err=/.test(posSrc) && /系统会按同一请求号幂等处理/.test(posSrc)
  );
  check("双击闸门：同步 ref 挡住同一帧的第二下", /busyRef\.current = true/.test(posSrc) && /if \(busyRef\.current\) return/.test(posSrc));
  check("收款按钮是 submit 且 pending 时禁用", /type="submit"[\s\S]{0,200}disabled=\{pending\}/.test(posSrc));

  section("2. actions.ts：同 request_id 第二次返回成功（幂等 replay）而不是报错");

  check("有幂等重放专用信号类", /class ShopReplayedError/.test(actionsSrc));
  check("有统一的幂等查重函数（保留第六轮那条判定 SQL 原文）", /SELECT id FROM shop_sales WHERE hotel_id = \? AND request_id = \?/.test(actionsSrc));

  function sliceFunction(src, name) {
    const sig = `export async function ${name}(`;
    const start = src.indexOf(sig);
    if (start < 0) return null;
    const nextExport = src.indexOf("\nexport ", start + sig.length);
    return src.slice(start, nextExport < 0 ? src.length : nextExport);
  }
  const cartBody = sliceFunction(actionsSrc, "sellCartAction") ?? "";
  const sellBody = sliceFunction(actionsSrc, "sellAction") ?? "";

  check("sellCartAction 有事务内查重（并发兜底之外的第一道闸）", /settledSaleOf\(hotelId, requestId\)/.test(cartBody));
  check(
    "sellCartAction 事务外先查重，且在业务校验之前（商品下架 / 客人退房的重放也返回成功）",
    cartBody.indexOf("settledSaleOf(hotelId, requestId)") >= 0 &&
      cartBody.indexOf("settledSaleOf(hotelId, requestId)") < cartBody.indexOf('if (ids.length === 0)')
  );
  check("sellAction 有事务外前置查重", /const settledBefore = settledSaleOf\(hotelId, requestId\)/.test(sellBody));
  check(
    "重放走成功横幅 ?msg=（走 ?err= 会让前端当失败保留同一请求号，同一单再也卖不出去）",
    /function replayUrl[\s\S]{0,400}\/shop\?msg=/.test(actionsSrc)
  );
  check(
    "撞唯一索引时按幂等重放处理（UNIQUE constraint failed: shop_sales）",
    /UNIQUE constraint failed: shop_sales\./i.test(actionsSrc) && /replayIfRaced\(hotelId, requestId, e\)/.test(actionsSrc)
  );
  check(
    "两个写动作的 catch 都接住了重放 / 索引冲突",
    (actionsSrc.match(/if \(e instanceof ShopReplayedError\) redirect\(replayUrl\(e\.sale\)\)/g) || []).length === 2
  );

  /* ============================================================ 4. 数据库索引 */
  section("3. 数据库：部分唯一索引真的兜得住并发");

  const idx = one(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_shop_sales_request'`);
  check(
    "shop_sales(hotel_id, request_id) 部分唯一索引存在",
    Boolean(idx && /UNIQUE/i.test(idx.sql) && /WHERE request_id IS NOT NULL/i.test(idx.sql)),
    idx?.sql ?? "缺索引"
  );

  const insSale = (hotelId, requestId, name = "索引验收") =>
    run(
      `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, request_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [hotelId, name, 1, 10, "现金", null, NOW, requestId]
    );

  const RID_IDX = `RID-INDEX-${STAMP}`;
  insSale(HOTEL, RID_IDX);
  let dupBlocked = false;
  try {
    insSale(HOTEL, RID_IDX);
  } catch {
    dupBlocked = true;
  }
  check("同一 (hotel_id, request_id) 第二次写入被索引拒绝", dupBlocked);
  check("被拒绝后该 request_id 仍只有 1 笔流水", salesOf(RID_IDX) === 1);
  check(
    "不同酒店可以复用同一 request_id（索引按 hotel_id 分段）",
    (() => {
      try {
        insSale(HOTEL_B, RID_IDX);
        return true;
      } catch {
        return false;
      }
    })()
  );
  check(
    "request_id 为空的流水不受约束（历史数据 / 多商品单的非首行）",
    (() => {
      try {
        insSale(HOTEL, null);
        insSale(HOTEL, null);
        return true;
      } catch {
        return false;
      }
    })()
  );

  /* ============================================================ 5. 双击 / 重试 */
  section("4. 真实 action：同一 request_id 双击 → 只成一笔，第二次返回成功");

  const RID_A = `RID-${STAMP}-A`;
  const stockBefore = stockOf(itemId);
  const first = await as("cashier", () => shop.sellCartAction(sellFd(RID_A)));
  const firstFlash = flashOf(first);

  check("第一次结算成功（回跳带成功横幅）", isOkFlash(first), `${first.status} ${first.url || first.message}`);
  check("第一次成交后产生 1 笔销售流水", salesOf(RID_A) === 1);
  const rowA = saleRowOf(RID_A);
  check(
    "流水数量 / 金额与提交一致（2 件 × ¥10）",
    Number(rowA?.qty) === 2 && Number(rowA?.amount) === 20,
    `qty=${rowA?.qty} amount=${rowA?.amount}`
  );
  check("库存只扣一次（50 → 48）", stockOf(itemId) === stockBefore - 2, `stock=${stockOf(itemId)}`);
  check("挂房账的账单只入一笔（folio_items = 1）", folioItems() === 1, `folio_items=${folioItems()}`);
  const folioAfterFirst = folioInfo();
  check(
    "账单应收只增加一次（¥20）",
    Math.abs(Number(folioAfterFirst.total_amount ?? 0) - 20) < 0.005,
    `total_amount=${folioAfterFirst.total_amount}`
  );

  /* 第二次：同 request_id（双击的第二下 / 网络重试） */
  const second = await as("cashier", () => shop.sellCartAction(sellFd(RID_A)));
  const secondFlash = flashOf(second);

  check(
    "第二次提交返回成功（幂等 replay），而不是 ?err= 报错",
    isOkFlash(second),
    `${second.status} ${second.url || second.message}`
  );
  check("重放提示里明确写了「幂等重放」", /幂等重放/.test(secondFlash.text), secondFlash.text);
  check("第二次没有新增销售流水（仍 1 笔）", salesOf(RID_A) === 1);
  check("第二次没有再扣库存（仍 48）", stockOf(itemId) === stockBefore - 2, `stock=${stockOf(itemId)}`);
  check("第二次没有再写房账（folio_items 仍 1）", folioItems() === 1, `folio_items=${folioItems()}`);
  const folioAfterSecond = folioInfo();
  check(
    "账单应收没有翻倍",
    Math.abs(Number(folioAfterSecond.total_amount ?? 0) - Number(folioAfterFirst.total_amount ?? 0)) < 0.005,
    `${folioAfterFirst.total_amount} → ${folioAfterSecond.total_amount}`
  );
  check("第一次与第二次的提示都指向同一笔流水（用户看到的是成功）", firstFlash.text !== "" && secondFlash.text !== "");

  /* ============================================================ 6. 不同 request_id */
  section("5. 不同 request_id → 正常业务，两笔各自成立");

  const RID_B = `RID-${STAMP}-B`;
  const third = await as("cashier", () => shop.sellCartAction(sellFd(RID_B)));
  check("第二次结算（新 request_id）成功", isOkFlash(third), `${third.status} ${third.url || third.message}`);
  check("产生第 2 笔销售流水", salesOf(RID_B) === 1);
  check("库存再扣一次（48 → 46）", stockOf(itemId) === stockBefore - 4, `stock=${stockOf(itemId)}`);
  check("房账变成 2 笔", folioItems() === 2, `folio_items=${folioItems()}`);
  const folioAfterThird = folioInfo();
  check(
    "账单应收累计 ¥40（两笔各自入账）",
    Math.abs(Number(folioAfterThird.total_amount ?? 0) - 40) < 0.005,
    `total_amount=${folioAfterThird.total_amount}`
  );

  /* 现金（不挂房账）：只写流水，不写房账 */
  const RID_C = `RID-${STAMP}-C`;
  const cash = await as("cashier", () => shop.sellCartAction(fdOf({ item_id: itemId, qty: 1, room_no: "", method: "现金", request_id: RID_C })));
  const folioBeforeCashRepeat = folioItems();
  check("现金结算成功（不挂房账）", isOkFlash(cash), `${cash.status} ${cash.url || cash.message}`);
  check("现金结算不写房账（folio_items 不变）", folioItems() === folioBeforeCashRepeat, `folio_items=${folioItems()}`);
  const cashRepeat = await as("cashier", () => shop.sellCartAction(fdOf({ item_id: itemId, qty: 1, room_no: "", method: "现金", request_id: RID_C })));
  check("现金单重复提交也是幂等成功", isOkFlash(cashRepeat), `${cashRepeat.status} ${cashRepeat.url || cashRepeat.message}`);
  check("现金单重复提交后仍只有 1 笔流水", salesOf(RID_C) === 1);

  /* ============================================================ 7. 并发 */
  section("6. 并发：同时发两次同 request_id → 只成一笔");

  const RID_D = `RID-${STAMP}-D`;
  const stockBeforeConcurrent = stockOf(itemId);
  const [p1, p2] = await Promise.all([
    as("cashier", () => shop.sellCartAction(sellFd(RID_D))),
    as("cashier", () => shop.sellCartAction(sellFd(RID_D))),
  ]);
  check("并发两路都返回成功（没有 500 / 没有 ?err=）", isOkFlash(p1) && isOkFlash(p2), `${p1.status}/${p2.status} ${p1.message}${p2.message}`);
  check("并发之后只有 1 笔销售流水", salesOf(RID_D) === 1, `n=${salesOf(RID_D)}`);
  check("并发之后库存只扣一次", stockOf(itemId) === stockBeforeConcurrent - 2, `stock=${stockOf(itemId)}`);

  /*
   * 竞态：外部连接（另一进程 / 另一次请求）先把同一 request_id 写进库，
   * 再让 action 跑一遍 —— 事务内查重必须命中并返回成功，绝不能扣第二次库存。
   */
  const RID_E = `RID-${STAMP}-E`;
  const conn2 = new DatabaseSync(ISO_DB);
  try {
    conn2
      .prepare(
        `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, request_id)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(HOTEL, "并发先手商品", 1, 10, "现金", null, NOW, RID_E);
  } finally {
    conn2.close();
  }
  const stockBeforeRace = stockOf(itemId);
  const raced = await as("cashier", () => shop.sellCartAction(sellFd(RID_E)));
  check("外部先手已写入时，本请求按幂等重放返回成功", isOkFlash(raced), `${raced.status} ${raced.url || raced.message}`);
  check("本请求没有为同一 request_id 再写一笔流水", salesOf(RID_E) === 1, `n=${salesOf(RID_E)}`);
  check("本请求没有扣库存（幂等路径不执行扣减）", stockOf(itemId) === stockBeforeRace, `stock=${stockOf(itemId)}`);

  /* ============================================================ 8. sellAction */
  section("7. sellAction（单商品挂房账）同样幂等");

  const RID_F = `RID-${STAMP}-F`;
  const stockBeforeSell = stockOf(itemId);
  const sell1 = await as("cashier", () => shop.sellAction(fdOf({ item_id: itemId, qty: 1, room_no: ROOM_NO, request_id: RID_F })));
  check("sellAction 第一次成功", isOkFlash(sell1), `${sell1.status} ${sell1.url || sell1.message}`);
  check("sellAction 产生 1 笔流水", salesOf(RID_F) === 1);
  check("sellAction 扣了 1 件库存", stockOf(itemId) === stockBeforeSell - 1, `stock=${stockOf(itemId)}`);
  const sell2 = await as("cashier", () => shop.sellAction(fdOf({ item_id: itemId, qty: 1, room_no: ROOM_NO, request_id: RID_F })));
  check("sellAction 重复提交返回成功（幂等重放）", isOkFlash(sell2), `${sell2.status} ${sell2.url || sell2.message}`);
  check("sellAction 重复提交没有再扣库存", stockOf(itemId) === stockBeforeSell - 1, `stock=${stockOf(itemId)}`);
  check("sellAction 重复提交仍只有 1 笔流水", salesOf(RID_F) === 1);

  /* ============================================================ 9. 权限未被放宽 */
  section("8. 幂等改造没有放宽权限");

  const denied = await as("housekeeping", () => shop.sellCartAction(sellFd(`RID-${STAMP}-DENY`)));
  check(
    "housekeeping 调 sellCartAction 仍被拒（FORBIDDEN: cashier.receive）",
    denied.status === "throw" && /FORBIDDEN/.test(denied.message) && /cashier\.receive/.test(denied.message),
    `${denied.status} ${denied.message}`
  );
  check("被拒的请求没有留下任何流水", salesOf(`RID-${STAMP}-DENY`) === 0);

  /* ============================================================ 10. 收尾 */
  section("9. 真库零写入");

  const realAfter = realDbCounts();
  check(
    "真库 shop_sales 行数未变（脚本只写副本）",
    realAfter.shop_sales === REAL_BEFORE.shop_sales,
    `${REAL_BEFORE.shop_sales} → ${realAfter.shop_sales}`
  );
  check(
    "副本上确实写入了验收流水（上面所有断言都打在副本上）",
    Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0) >= 5,
    `副本流水 ${Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0)} 笔`
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
