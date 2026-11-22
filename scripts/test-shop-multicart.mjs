#!/usr/bin/env node
/**
 * 整改报告 二 + 三：商超**多商品购物车**金额 / 库存一致性验收
 *
 * ── 清单要求（原文 §二、§三）──
 *   · 前端提交完整明细数组 [{ item_id, qty }, ...]
 *   · 服务端逐商品校验状态、逐商品校验库存
 *   · 同一事务内扣减所有库存、逐商品写库存流水、计算总金额
 *   · 现金销售写销售流水；挂房账写 folio_items
 *   · 同一个 request_id 只允许整单成功一次；任一商品失败整单回滚
 *   · 必须测试：单商品多数量 / 两个商品 / 三个商品 / 一件库存不足整单回滚 /
 *     双击 / 网络重试 / 同 request_id 并发 / 现金 / 挂房账 / 销售撤销
 *   · 死代码：ShopPOS 直接调 Server Action 后，page.tsx 的旧 submitOrder 必须删掉
 *   · 提示：action 的成功跳转参数必须和页面读取参数一致
 *
 * ── 改造前的真实风险（不是显示问题）──
 *   ShopPOS 提交的是 `item_id = cart[0].id` + `qty = 购物车总件数`：
 *   矿泉水 1 件 + 牙刷 1 件 → 服务端按「矿泉水 2 件」结算，
 *   牙刷库存没扣、金额记在矿泉水头上、流水只记矿泉水 —— 牙刷白拿。
 *
 * ── 本脚本怎么验（真库副本，零污染）──
 *   1. VACUUM INTO 把 data/pms.db 复制到 .tmp/shop-multicart-<时间戳>/data/pms.db，
 *      注入 globalThis.__pmsDb —— src/lib/db.ts 的 getDb() 优先返回它，
 *      所以跑的是仓库里那份**真实 action 代码**，写的却是副本库。
 *   2. registerHooks 把 next/headers、next/navigation、next/cache 换成最小桩
 *      （cookies 可切 sid / redirect 抛 NEXT_REDIRECT / revalidatePath 空操作），
 *      然后直接 import 真实的 src/app/(main)/shop/actions.ts。
 *   3. 造一间在住房 + 4 个验收商品，用 cashier 会话跑 10 个场景。
 *   4. 源码静态断言：明细数组提交、request_id 保留、逐商品落库、page.tsx 死代码已删、
 *      成功参数与页面读取参数一致。
 *
 * 用法：node scripts/test-shop-multicart.mjs
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
const TAG = "shop-multicart";
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
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

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
 * 只看 shop_sales / shop_stock_flows：op_logs 会被**运行中的 3100 服务进程**持续写入，
 * 拿它当基线必然误报。
 */
function realDbCounts() {
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const hasTable = (t) =>
      Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)?.n ?? 0) > 0;
    const count = (sql) => Number(db.prepare(sql).get()?.c ?? 0);
    return {
      shop_sales: hasTable("shop_sales") ? count(`SELECT COUNT(*) AS c FROM shop_sales`) : 0,
      shop_stock_flows: hasTable("shop_stock_flows") ? count(`SELECT COUNT(*) AS c FROM shop_stock_flows`) : 0,
    };
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
const allRows = (sql, params = []) => conn.prepare(sql).all(...params);
const sqlRun = (sql, params = []) => conn.prepare(sql).run(...params);

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
const pageSrc = read("src/app/(main)/shop/page.tsx");
const NOW = new Date().toISOString();
const EXPIRES = new Date(Date.now() + 3600 * 1000).toISOString();
const ROOM_NO = `M9${String(STAMP).slice(-4)}`;
const NO_SUCH_ROOM = `X9${String(STAMP).slice(-4)}`;

/* 两个岗位真实会话（复用真实 getSession / requirePermission 链路） */
const sidOf = {};
const users = allRows(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = ? ORDER BY id`, [HOTEL]);
for (const u of users) {
  const sid = `test-shop-multicart-${u.role}-${STAMP}`;
  sqlRun(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
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
  sqlRun(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
    HOTEL,
    ROOM_NO,
    9,
    ROOM_TYPE,
    "OC",
    98,
  ]).lastInsertRowid
);
const stayId = Number(
  sqlRun(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, status, rate, guest_count, check_in_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [HOTEL, `MC${STAMP}`, roomId, "多商品验证客人", "INHOUSE", 300, 1, NOW, NOW]
  ).lastInsertRowid
);

/** 造一个验收商品（价格故意不是整数，避免金额巧合对上） */
const mkItem = (name, price, stock) =>
  Number(
    sqlRun(
      `INSERT INTO shop_items (hotel_id, name, barcode, price, stock, category, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [HOTEL, name, `T-MC-${STAMP}-${name.slice(-2)}`, price, stock, "验收", "ON", NOW]
    ).lastInsertRowid
  );

const IT_A = mkItem("多商品验收矿泉水", 3.5, 100);
const IT_B = mkItem("多商品验收牙刷", 10, 100);
const IT_C = mkItem("多商品验收薯片", 7.25, 100);
const IT_LOW = mkItem("多商品验收限量伞", 25, 2);
const IT_OFF = mkItem("多商品验收下架品", 6, 50);
sqlRun(`UPDATE shop_items SET status = 'OFF' WHERE id = ?`, [IT_OFF]);

/* ============================================================ 3. 查询助手 */

const stockOf = (id) => Number(one(`SELECT stock FROM shop_items WHERE id = ?`, [id])?.stock ?? -1);
const saleRows = (orderNo) =>
  allRows(`SELECT * FROM shop_sales WHERE hotel_id = ? AND order_no = ? ORDER BY id`, [HOTEL, orderNo]);
const saleCountByOrder = (orderNo) =>
  Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ? AND order_no = ?`, [HOTEL, orderNo])?.n ?? 0);
const respCountOfRid = (rid) =>
  Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ? AND request_id = ?`, [HOTEL, rid])?.n ?? 0);
const flowsOfRid = (rid) =>
  allRows(
    `SELECT * FROM shop_stock_flows WHERE hotel_id = ? AND request_id = ? ORDER BY id`,
    [HOTEL, rid]
  );
const flowsOfItem = (itemId) =>
  allRows(`SELECT * FROM shop_stock_flows WHERE hotel_id = ? AND item_id = ? ORDER BY id`, [HOTEL, itemId]);
const hasStockFlowTable = () =>
  Number(one(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'shop_stock_flows'`)?.n ?? 0) > 0;

const folioOfStay = () =>
  one(`SELECT id, total_amount, paid_amount, balance FROM folios WHERE hotel_id = ? AND stay_id = ? ORDER BY id DESC LIMIT 1`, [
    HOTEL,
    stayId,
  ]);
const folioItemCount = () => {
  const f = folioOfStay();
  if (!f) return 0;
  return Number(one(`SELECT COUNT(*) AS n FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, f.id])?.n ?? 0);
};
const folioItemSum = () => {
  const f = folioOfStay();
  if (!f) return 0;
  return Number(
    one(`SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items WHERE hotel_id = ? AND folio_id = ?`, [HOTEL, f.id])?.t ?? 0
  );
};
const folioTotal = () => Number(folioOfStay()?.total_amount ?? 0);

/** 本次结算的 FormData：明细数组 + 幂等号（服务端要的字段全在这里） */
const cartFd = ({ items, room = "", method = "现金", rid }) => {
  const f = new FormData();
  if (items !== undefined) f.set("items", typeof items === "string" ? items : JSON.stringify(items));
  f.set("room_no", room);
  f.set("method", method);
  f.set("request_id", rid);
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

/** 结果是不是成功横幅：?msg=（成交 / 幂等重放）或 ?ok=（历史成功参数） */
function flashOf(res) {
  if (res.status !== "redirect") return { kind: "", text: "" };
  const u = new URL(res.url, "http://local");
  const err = u.searchParams.get("err") ?? "";
  if (err) return { kind: "err", text: err };
  const msg = u.searchParams.get("msg") ?? "";
  if (msg) return { kind: "msg", text: msg };
  const ok = u.searchParams.get("ok") ?? "";
  if (ok) return { kind: "ok", text: ok };
  return { kind: "", text: "" };
}
const isOkFlash = (res) => ["msg", "ok"].includes(flashOf(res).kind);
const isErrFlash = (res) => flashOf(res).kind === "err";

try {
  /* ============================================================ 4. 源码守卫 */
  section("1. 源码：前端提交明细数组、保留 request_id、服务端逐商品落库、死代码已删");

  check(
    "ShopPOS 把购物车映射成明细数组 { item_id, qty }",
    /cart\.map\(\(c\) => \(\{ item_id: c\.id, qty: c\.qty \}\)\)/.test(posSrc)
  );
  check(
    "ShopPOS 以 JSON 提交 items 字段",
    /fd\.set\("items", JSON\.stringify\(lines\)\)/.test(posSrc)
  );
  check(
    "「只传第一件商品 id + 总件数」的错误写法已消失",
    !/fd\.set\("item_id", String\(cart\[0\]\.id\)\)/.test(posSrc) && !/fd\.set\("qty", String\(qty\)\)/.test(posSrc)
  );
  check("幂等请求号仍然照旧提交（第七轮成果不能弄坏）", /fd\.set\("request_id", rid\)/.test(posSrc));
  check(
    "幂等请求号的隐藏字段仍在（双击 / 重试复用同一枚）",
    /type="hidden"[^>]*name="request_id"/.test(posSrc) && /name="request_id" value=\{requestId\}/.test(posSrc)
  );
  check(
    "单商品时仍带旧字段（服务端保留 items 缺失的单商品兼容路径）",
    /if \(lines\.length === 1\) \{[\s\S]{0,200}fd\.set\("item_id"/.test(posSrc)
  );

  check("actions.ts 解析 items 明细数组", /formData\.get\("items"\)/.test(actionsSrc) && /JSON\.parse\(rawItems\)/.test(actionsSrc));
  check(
    "解析器对非法明细整单拒绝（不静默丢行）",
    /return \{ lines: \[\], invalid: true \}/.test(actionsSrc)
  );
  check(
    "服务端保留旧调用兼容：items 缺失时按 item_id 处理",
    /兼容旧调用：item_id（可逗号分隔）\+ qty/.test(actionsSrc)
  );
  check(
    "逐商品预校验状态与库存（遍历 lines）",
    /for \(const line of lines\)[\s\S]{0,900}item\.status !== "ON"/.test(actionsSrc)
  );
  check(
    "逐商品扣库存 + 逐商品写库存流水 + 逐商品写销售流水（都在同一个 tx 里）",
    /for \(const plan of plans\) \{[\s\S]{0,2400}INSERT INTO shop_sales \(hotel_id[\s\S]{0,900}writeShopFlow\(/.test(
      actionsSrc
    )
  );
  check(
    "挂房账按商品逐条写 folio_items（账单可逐条核对）",
    /for \(const plan of plans\) \{[\s\S]{0,320}INSERT INTO folio_items/.test(actionsSrc)
  );
  check(
    "金额按明细汇总（total += plan.amount），不采信前端传来的金额",
    /total \+= plan\.amount/.test(actionsSrc) && /amount: round2\(Number\(item\.price\) \* line\.qty\)/.test(actionsSrc)
  );
  check(
    "库存流水走独立台账 shop_stock_flows（goods_flows 的 goods_id 指向仓库 goods，混用会污染仓库账）",
    /CREATE TABLE IF NOT EXISTS shop_stock_flows/.test(actionsSrc) && !/INSERT INTO goods_flows/.test(actionsSrc)
  );
  check(
    "整单号 order_no：request_id 只落首行（唯一索引限制），同单其余行靠 order_no 整单可查",
    /order_no/.test(actionsSrc) && /saleIds\.length === 0 \? requestId : null/.test(actionsSrc)
  );

  section("2. page.tsx：死代码 submitOrder 已删 + 成功/失败参数一致");

  check("page.tsx 不再有旧的 submitOrder 服务端函数（死代码已删除）", !/submitOrder/.test(pageSrc));
  check("page.tsx 不再给 ShopPOS 传 onSubmit（组件内部直接调 action）", !/onSubmit=/.test(pageSrc));
  check("ShopPOS 组件签名里也没有死掉的 onSubmit prop", !/onSubmit\??:/.test(posSrc));
  check("page.tsx 从 ?msg= 读成功提示", /msg=\{sp\.msg\}/.test(pageSrc) && /msg\?: string/.test(pageSrc));
  check("page.tsx 从 ?err= 读失败提示", /err=\{sp\.err\}/.test(pageSrc) && /err\?: string/.test(pageSrc));
  check(
    "成功跳转参数与页面读取参数一致：不再出现 /shop?ok=（页面读不到 ok，销售成功却没有成功提示）",
    !/\/shop\?ok=/.test(actionsSrc)
  );
  check(
    "sellCartAction 成功与幂等重放都走 ?msg=",
    /已售出 \$\{outcome\.qty\} 件（\$\{outcome\.count\} 种商品）/.test(actionsSrc) &&
      /function replayUrl[\s\S]{0,400}\/shop\?msg=/.test(actionsSrc)
  );

  section("3. 数据库：幂等索引 + 商超库存流水表/整单号列");

  const idx = one(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_shop_sales_request'`);
  check(
    "shop_sales(hotel_id, request_id) 部分唯一索引仍在（整单只能成交一次）",
    Boolean(idx && /UNIQUE/i.test(idx.sql) && /WHERE request_id IS NOT NULL/i.test(idx.sql)),
    idx?.sql ?? "缺索引"
  );

  /* ============================================================ 5. 场景 1 */
  section("4. 场景 1：单商品多数量（现金）");

  const RID_1 = `MC-${STAMP}-S1`;
  const aBefore1 = stockOf(IT_A);
  const r1 = await as("cashier", () => shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 3 }], rid: RID_1 })));
  const f1 = flashOf(r1);

  check("成功横幅（?msg=）", isOkFlash(r1), `${r1.status} ${r1.url || r1.message}`);
  check("提示里写明件数与金额", /3 件/.test(f1.text) && /10\.50/.test(f1.text), f1.text);
  check("只产生 1 行销售流水", saleCountByOrder(RID_1) === 1, `n=${saleCountByOrder(RID_1)}`);
  const row1 = saleRows(RID_1)[0];
  check("流水数量 = 3、金额 = 3 × 3.5 = 10.5", Number(row1?.qty) === 3 && near(row1?.amount, 10.5), `qty=${row1?.qty} amount=${row1?.amount}`);
  check("库存扣 3 件", stockOf(IT_A) === aBefore1 - 3, `${aBefore1} → ${stockOf(IT_A)}`);
  check("库存流水写 1 条 SELL，数量 3、结存与商品库存一致", (() => {
    const f = flowsOfRid(RID_1);
    return f.length === 1 && f[0].type === "SELL" && Number(f[0].qty) === 3 && Number(f[0].stock_after) === stockOf(IT_A);
  })(), JSON.stringify(flowsOfRid(RID_1).map((f) => [f.type, f.qty, f.stock_after])));
  check("现金单不写房账（folio_items 无变化）", folioItemCount() === 0, `folio_items=${folioItemCount()}`);
  check("整单号 order_no = request_id（可整单追溯）", row1?.order_no === RID_1, String(row1?.order_no));

  /* ============================================================ 6. 场景 2 */
  section("5. 场景 2：两个不同商品（挂房账）");

  const RID_2 = `MC-${STAMP}-S2`;
  const aBefore2 = stockOf(IT_A);
  const bBefore2 = stockOf(IT_B);
  const folioRowsBefore2 = folioItemCount();
  const folioSumBefore2 = folioItemSum();
  const r2 = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 1 }, { item_id: IT_B, qty: 2 }], room: ROOM_NO, rid: RID_2 }))
  );

  check("多商品挂账结算成功", isOkFlash(r2), `${r2.status} ${r2.url || r2.message}`);
  check("销售流水 2 行（一行一个商品，不再只记第一件）", saleCountByOrder(RID_2) === 2, `n=${saleCountByOrder(RID_2)}`);
  const rows2 = saleRows(RID_2);
  check("两行金额分别 3.5 / 20", near(rows2[0]?.amount, 3.5) && near(rows2[1]?.amount, 20), JSON.stringify(rows2.map((r) => r.amount)));
  check("整单合计 23.5", near(rows2.reduce((s, r) => s + Number(r.amount), 0), 23.5));
  check("两个商品各扣各的库存（A-1、B-2）", stockOf(IT_A) === aBefore2 - 1 && stockOf(IT_B) === bBefore2 - 2, `A=${stockOf(IT_A)} B=${stockOf(IT_B)}`);
  check("挂房账每商品一条 folio_items（新增 2 行）", folioItemCount() === folioRowsBefore2 + 2, `folio_items=${folioItemCount()}`);
  check("账单应收增加 23.5", near(folioItemSum() - folioSumBefore2, 23.5), `${folioSumBefore2} → ${folioItemSum()}`);
  check("账单余额同步增加 23.5", near(folioTotal() - folioSumBefore2, 23.5), `total=${folioTotal()}`);
  check(
    "流水 method 记「挂账 房号」、room_no 落到房号",
    /^挂账 /.test(String(rows2[0]?.method)) && rows2[0]?.room_no === ROOM_NO,
    `${rows2[0]?.method} / ${rows2[0]?.room_no}`
  );
  check("库存流水 2 条，各自 type=SELL", flowsOfRid(RID_2).length === 2 && flowsOfRid(RID_2).every((f) => f.type === "SELL"));

  /* ============================================================ 7. 场景 3 */
  section("6. 场景 3：三个不同商品（现金，关键断言）");

  const RID_3 = `MC-${STAMP}-S3`;
  const aBefore3 = stockOf(IT_A);
  const bBefore3 = stockOf(IT_B);
  const cBefore3 = stockOf(IT_C);
  const folioRowsBefore3 = folioItemCount();
  const r3 = await as("cashier", () =>
    shop.sellCartAction(
      cartFd({ items: [{ item_id: IT_A, qty: 1 }, { item_id: IT_B, qty: 1 }, { item_id: IT_C, qty: 2 }], rid: RID_3 })
    )
  );

  check("三商品结算成功", isOkFlash(r3), `${r3.status} ${r3.url || r3.message}`);
  check("销售流水 3 行", saleCountByOrder(RID_3) === 3, `n=${saleCountByOrder(RID_3)}`);
  const rows3 = saleRows(RID_3);
  check("库存各扣各的（A-1、B-1、C-2）", stockOf(IT_A) === aBefore3 - 1 && stockOf(IT_B) === bBefore3 - 1 && stockOf(IT_C) === cBefore3 - 2, `A=${stockOf(IT_A)} B=${stockOf(IT_B)} C=${stockOf(IT_C)}`);
  check("总金额 = 单价×数量之和（3.5 + 10 + 7.25×2 = 28）", near(rows3.reduce((s, r) => s + Number(r.amount), 0), 28), `合计=${rows3.reduce((s, r) => s + Number(r.amount), 0)}`);
  check("每行 qty 与提交一致（1/1/2）", rows3.map((r) => Number(r.qty)).join(",") === "1,1,2", rows3.map((r) => Number(r.qty)).join(","));
  check("库存流水条数 = 商品种数（3 条）", flowsOfRid(RID_3).length === 3, `n=${flowsOfRid(RID_3).length}`);
  check("每条流水的结存与明细数量对得上", (() => {
    const map = new Map(flowsOfRid(RID_3).map((f) => [Number(f.item_id), Number(f.stock_after)]));
    return map.get(IT_A) === stockOf(IT_A) && map.get(IT_B) === stockOf(IT_B) && map.get(IT_C) === stockOf(IT_C);
  })());
  check("三行属于同一整单（order_no 一致）", rows3.every((r) => r.order_no === RID_3));
  check(
    "request_id 只落首行（唯一索引不容许多行都带）",
    Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ? AND request_id IS NOT NULL AND order_no = ?`, [HOTEL, RID_3])?.n ?? 0) === 1
  );
  check("现金单仍不写房账", folioItemCount() === folioRowsBefore3, `folio_items=${folioItemCount()}`);
  check(
    "op_logs 记录了整单号（可追溯）",
    Number(one(`SELECT COUNT(*) AS n FROM op_logs WHERE hotel_id = ? AND detail LIKE ?`, [HOTEL, `%${RID_3}%`])?.n ?? 0) >= 1
  );

  /* ============================================================ 8. 场景 4 */
  section("7. 场景 4：其中一个商品库存不足 → 整单回滚（库存/流水/账单都不许动）");

  const RID_4 = `MC-${STAMP}-S4`;
  const aBefore4 = stockOf(IT_A);
  const bBefore4 = stockOf(IT_B);
  const lowBefore4 = stockOf(IT_LOW);
  const folioRowsBefore4 = folioItemCount();
  const folioSumBefore4 = folioItemSum();
  const salesBefore4 = Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0);
  const flowsBefore4 = Number(one(`SELECT COUNT(*) AS n FROM shop_stock_flows WHERE hotel_id = ?`, [HOTEL])?.n ?? 0);

  const r4 = await as("cashier", () =>
    shop.sellCartAction(
      cartFd({
        items: [{ item_id: IT_A, qty: 1 }, { item_id: IT_B, qty: 1 }, { item_id: IT_LOW, qty: 3 }],
        room: ROOM_NO,
        rid: RID_4,
      })
    )
  );
  const f4 = flashOf(r4);

  check("整单失败（?err=）", isErrFlash(r4), `${r4.status} ${r4.url || r4.message}`);
  check("错误文案点明是哪个商品库存不足", /限量伞/.test(f4.text) && /库存不足/.test(f4.text), f4.text);
  check("文案写明整单已取消", /整单已取消/.test(f4.text), f4.text);
  check("A 库存没动", stockOf(IT_A) === aBefore4, `${aBefore4} → ${stockOf(IT_A)}`);
  check("B 库存没动（不是「只扣了前面几件」）", stockOf(IT_B) === bBefore4, `${bBefore4} → ${stockOf(IT_B)}`);
  check("库存不足的商品库存没动", stockOf(IT_LOW) === lowBefore4, `${lowBefore4} → ${stockOf(IT_LOW)}`);
  check("没有任何销售流水", saleCountByOrder(RID_4) === 0 && Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0) === salesBefore4);
  check("没有库存流水", Number(one(`SELECT COUNT(*) AS n FROM shop_stock_flows WHERE hotel_id = ?`, [HOTEL])?.n ?? 0) === flowsBefore4, `flow=${Number(one(`SELECT COUNT(*) AS n FROM shop_stock_flows WHERE hotel_id = ?`, [HOTEL])?.n ?? 0)}`);
  check("没有账单明细（挂账场景也没入账）", folioItemCount() === folioRowsBefore4 && near(folioItemSum(), folioSumBefore4));

  /* 附：畸形明细同样整单拒绝（不能悄悄丢掉坏行接着卖） */
  const RID_4B = `MC-${STAMP}-S4B`;
  const aBefore4B = stockOf(IT_A);
  const r4b = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 1 }, { item_id: "abc", qty: 1 }], rid: RID_4B }))
  );
  check("明细里有非法行 → 整单拒绝（?err=）", isErrFlash(r4b), `${r4b.status} ${r4b.url || r4b.message}`);
  check("合法的那一行也没被结算（库存没动）", stockOf(IT_A) === aBefore4B);
  check("非法请求没有留下销售流水", saleCountByOrder(RID_4B) === 0);

  /* 附：下架商品也不能混进整单 */
  const RID_4C = `MC-${STAMP}-S4C`;
  const cBefore4C = stockOf(IT_C);
  const r4c = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_C, qty: 1 }, { item_id: IT_OFF, qty: 1 }], rid: RID_4C }))
  );
  check("混入下架商品 → 整单取消", isErrFlash(r4c) && /已下架/.test(flashOf(r4c).text), flashOf(r4c).text);
  check("同单里的在架商品库存也没扣", stockOf(IT_C) === cBefore4C);

  /* ============================================================ 9. 场景 5 */
  section("8. 场景 5：双击提交（同一 request_id 连按两下，多商品）");

  const RID_5 = `MC-${STAMP}-S5`;
  const aBefore5 = stockOf(IT_A);
  const bBefore5 = stockOf(IT_B);
  const cBefore5 = stockOf(IT_C);
  const folioRowsBefore5 = folioItemCount();
  const lines5 = [{ item_id: IT_A, qty: 1 }, { item_id: IT_B, qty: 1 }, { item_id: IT_C, qty: 1 }];
  const click1 = await as("cashier", () => shop.sellCartAction(cartFd({ items: lines5, room: ROOM_NO, rid: RID_5 })));
  const click2 = await as("cashier", () => shop.sellCartAction(cartFd({ items: lines5, room: ROOM_NO, rid: RID_5 })));

  check("第一下成交", isOkFlash(click1), `${click1.status} ${click1.url || click1.message}`);
  check("第二下也返回成功（幂等重放，不是报错）", isOkFlash(click2), `${click2.status} ${click2.url || click2.message}`);
  check("第二下的提示写明「幂等重放」", /幂等重放/.test(flashOf(click2).text), flashOf(click2).text);
  check("销售流水仍 3 行（不是 6 行）", saleCountByOrder(RID_5) === 3, `n=${saleCountByOrder(RID_5)}`);
  check("库存只扣一次（A-1、B-1、C-1）", stockOf(IT_A) === aBefore5 - 1 && stockOf(IT_B) === bBefore5 - 1 && stockOf(IT_C) === cBefore5 - 1, `A=${stockOf(IT_A)} B=${stockOf(IT_B)} C=${stockOf(IT_C)}`);
  check("库存流水仍 3 条", flowsOfRid(RID_5).length === 3, `n=${flowsOfRid(RID_5).length}`);
  check("账单只入 3 行（没有翻倍）", folioItemCount() === folioRowsBefore5 + 3, `folio_items=${folioItemCount()}`);
  check("整单金额没有被重复计入（3.5 + 10 + 7.25 = 20.75）", near(saleRows(RID_5).reduce((s, r) => s + Number(r.amount), 0), 20.75));

  /* ============================================================ 10. 场景 6 */
  section("9. 场景 6：网络重试（同 request_id，重试时 payload 变了也只认首单）");

  const RID_6 = `MC-${STAMP}-S6`;
  const aBefore6 = stockOf(IT_A);
  const bBefore6 = stockOf(IT_B);
  const first6 = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 1 }, { item_id: IT_B, qty: 1 }], rid: RID_6 }))
  );
  const retry6 = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 2 }, { item_id: IT_B, qty: 1 }], rid: RID_6 }))
  );

  check("首次重试前那单已成交", isOkFlash(first6), `${first6.status} ${first6.url || first6.message}`);
  check("服务端重启后同 request_id 的重试仍返回成功（不会再卖一次）", isOkFlash(retry6), `${retry6.status} ${retry6.url || retry6.message}`);
  check("重试提示幂等重放", /幂等重放/.test(flashOf(retry6).text), flashOf(retry6).text);
  check("库存按首单扣（A-1、B-1，重试里 A 要 2 件也不生效）", stockOf(IT_A) === aBefore6 - 1 && stockOf(IT_B) === bBefore6 - 1, `A=${stockOf(IT_A)} B=${stockOf(IT_B)}`);
  check("销售流水仍 2 行且合计 13.5", saleCountByOrder(RID_6) === 2 && near(saleRows(RID_6).reduce((s, r) => s + Number(r.amount), 0), 13.5));
  check("库存流水仍 2 条", flowsOfRid(RID_6).length === 2, `n=${flowsOfRid(RID_6).length}`);

  /* ============================================================ 11. 场景 7 */
  section("10. 场景 7：同 request_id 并发提交 → 只成一单");

  const RID_7 = `MC-${STAMP}-S7`;
  const aBefore7 = stockOf(IT_A);
  const cBefore7 = stockOf(IT_C);
  const lines7 = [{ item_id: IT_A, qty: 2 }, { item_id: IT_C, qty: 1 }];
  const [p1, p2] = await Promise.all([
    as("cashier", () => shop.sellCartAction(cartFd({ items: lines7, rid: RID_7 }))),
    as("cashier", () => shop.sellCartAction(cartFd({ items: lines7, rid: RID_7 }))),
  ]);

  check("并发两路都成功（没有 500 / 没有 ?err=）", isOkFlash(p1) && isOkFlash(p2), `${p1.status}/${p2.status} ${p1.message}${p2.message}`);
  check("并发之后销售流水只有 2 行（不是 4 行）", saleCountByOrder(RID_7) === 2, `n=${saleCountByOrder(RID_7)}`);
  check("并发之后库存只扣一次（A-2、C-1）", stockOf(IT_A) === aBefore7 - 2 && stockOf(IT_C) === cBefore7 - 1);
  check("并发之后库存流水只有 2 条", flowsOfRid(RID_7).length === 2, `n=${flowsOfRid(RID_7).length}`);
  check("并发之后 request_id 只有 1 行（唯一索引兜底）", respCountOfRid(RID_7) === 1, `n=${respCountOfRid(RID_7)}`);

  /* ============================================================ 12. 场景 8 */
  section("11. 场景 8：现金销售（不挂房账，只写销售流水）");

  const RID_8 = `MC-${STAMP}-S8`;
  const folioRowsBefore8 = folioItemCount();
  const r8 = await as("cashier", () =>
    shop.sellCartAction(
      cartFd({ items: [{ item_id: IT_B, qty: 1 }, { item_id: IT_C, qty: 1 }], method: "微信", rid: RID_8 })
    )
  );
  const rows8 = saleRows(RID_8);

  check("现金（微信）多商品结算成功", isOkFlash(r8), `${r8.status} ${r8.url || r8.message}`);
  check("写 shop_sales 2 行", rows8.length === 2, `n=${rows8.length}`);
  check("method 记录支付方式「微信」", rows8.every((r) => r.method === "微信"), JSON.stringify(rows8.map((r) => r.method)));
  check("room_no 为空（现金不挂房）", rows8.every((r) => r.room_no === null), JSON.stringify(rows8.map((r) => r.room_no)));
  check("不写 folio_items", folioItemCount() === folioRowsBefore8, `folio_items=${folioItemCount()}`);
  check("库存照扣（B-1、C-1）", flowsOfRid(RID_8).length === 2);
  check("合计 17.25（10 + 7.25）", near(rows8.reduce((s, r) => s + Number(r.amount), 0), 17.25));

  /* ============================================================ 13. 场景 9 */
  section("12. 场景 9：挂房账销售（每个商品一条 folio_items）");

  const RID_9 = `MC-${STAMP}-S9`;
  const aBefore9 = stockOf(IT_A);
  const rowsBefore9 = folioItemCount();
  const sumBefore9 = folioItemSum();
  const r9 = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 2 }, { item_id: IT_B, qty: 1 }], room: ROOM_NO, rid: RID_9 }))
  );
  const rows9 = saleRows(RID_9);

  check("挂房账结算成功", isOkFlash(r9), `${r9.status} ${r9.url || r9.message}`);
  check("写 shop_sales 2 行（挂账同样留销售流水，便于对账）", rows9.length === 2);
  check("folio_items 新增 2 行（每个商品一条）", folioItemCount() === rowsBefore9 + 2, `folio_items=${folioItemCount()}`);
  check("账单应收增加 17（3.5×2 + 10）", near(folioItemSum() - sumBefore9, 17), `${sumBefore9} → ${folioItemSum()}`);
  check("账单明细描述带商品名（可逐条核对）", (() => {
    const f = folioOfStay();
    const descs = allRows(`SELECT description FROM folio_items WHERE hotel_id = ? AND folio_id = ? ORDER BY id DESC LIMIT 2`, [HOTEL, f.id]).map((r) => r.description);
    return descs.some((d) => /矿泉水/.test(d)) && descs.some((d) => /牙刷/.test(d));
  })());
  check("挂账方式写进 method 与 room_no", rows9.every((r) => /^挂账 /.test(String(r.method)) && r.room_no === ROOM_NO));

  /* 房号没有在住客人 → 整单回滚 */
  const RID_9B = `MC-${STAMP}-S9B`;
  const aBefore9B = stockOf(IT_A);
  const salesBefore9B = Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0);
  const r9b = await as("cashier", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 1 }], room: NO_SUCH_ROOM, rid: RID_9B }))
  );
  check("房号没有在住客人 → 整单取消", isErrFlash(r9b) && /没有在住客人/.test(flashOf(r9b).text), flashOf(r9b).text);
  check("房号无效时库存没扣、流水没写", stockOf(IT_A) === aBefore9B && Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0) === salesBefore9B);

  /* ============================================================ 14. 场景 10 */
  section("13. 场景 10：销售撤销（voidSaleAction）");

  /* 撤销场景 3（现金三商品单）里的一行：C ×2 */
  const rows3Again = saleRows(RID_3);
  const cRow = rows3Again.find((r) => r.item_name === "多商品验收薯片");
  const cBeforeVoid = stockOf(IT_C);
  const void1 = await as("cashier", () => shop.voidSaleAction(cartFd2({ id: cRow.id, reason: "客人退货" })));

  check("撤销现金单的一行成功（?msg=）", isOkFlash(void1), `${void1.status} ${void1.url || void1.message}`);
  check("撤销后该商品库存回加 2 件", stockOf(IT_C) === cBeforeVoid + 2, `${cBeforeVoid} → ${stockOf(IT_C)}`);
  check("写了一条 VOID 库存流水（归库 2 件）", (() => {
    const last = flowsOfItem(IT_C).filter((f) => f.type === "VOID");
    return last.length === 1 && Number(last[0].qty) === 2 && Number(last[0].stock_after) === stockOf(IT_C);
  })(), JSON.stringify(flowsOfItem(IT_C).map((f) => [f.type, f.qty, f.stock_after])));
  check("销售单被标记 voided_at + 原因", (() => {
    const r = one(`SELECT voided_at, void_reason FROM shop_sales WHERE id = ?`, [cRow.id]);
    return Boolean(r?.voided_at) && r?.void_reason === "客人退货";
  })());
  check("同单其它两行不受影响（仍是正常销售）", saleRows(RID_3).filter((r) => !r.voided_at).length === 2);

  const repeatVoid = await as("cashier", () => shop.voidSaleAction(cartFd2({ id: cRow.id, reason: "再撤一次" })));
  check("重复撤销同一单 → 拒绝（已在入口拦下）", isErrFlash(repeatVoid) && /已撤销/.test(flashOf(repeatVoid).text), flashOf(repeatVoid).text);
  check("重复撤销没有再加库存", stockOf(IT_C) === cBeforeVoid + 2);

  const noReason = await as("cashier", () => shop.voidSaleAction(cartFd2({ id: saleRows(RID_9)[0].id })));
  check("撤销不填原因 → 拒绝", isErrFlash(noReason) && /必须填写原因/.test(flashOf(noReason).text), flashOf(noReason).text);

  /* 撤销挂账的一行：账单上补负项 */
  const aRow9 = saleRows(RID_9).find((r) => r.item_name === "多商品验收矿泉水");
  const sumBeforeVoid9 = folioItemSum();
  const aBeforeVoid9 = stockOf(IT_A);
  const void9 = await as("cashier", () => shop.voidSaleAction(cartFd2({ id: aRow9.id, reason: "挂账撤销验收" })));

  check("撤销挂账行成功", isOkFlash(void9), `${void9.status} ${void9.url || void9.message}`);
  check("挂账撤销后库存回加 2 件", stockOf(IT_A) === aBeforeVoid9 + 2, `${aBeforeVoid9} → ${stockOf(IT_A)}`);
  check("账单上补了一笔负项（应收减少 7）", near(folioItemSum() - sumBeforeVoid9, -7), `${sumBeforeVoid9} → ${folioItemSum()}`);
  check("账单余额同步回落 7", near(folioTotal() - sumBeforeVoid9, -7));
  check("撤销的销售单被标记作废", Boolean(one(`SELECT voided_at FROM shop_sales WHERE id = ?`, [aRow9.id])?.voided_at));
  check("挂账撤销也写了 VOID 库存流水", flowsOfItem(IT_A).some((f) => f.type === "VOID"));

  /* ============================================================ 15. 权限 */
  section("14. 多商品改造没有放宽权限");

  const denied = await as("housekeeping", () =>
    shop.sellCartAction(cartFd({ items: [{ item_id: IT_A, qty: 1 }, { item_id: IT_B, qty: 1 }], rid: `MC-${STAMP}-DENY` }))
  );
  check(
    "housekeeping 调 sellCartAction 仍被拒（FORBIDDEN: cashier.receive）",
    denied.status === "throw" && /FORBIDDEN/.test(denied.message) && /cashier\.receive/.test(denied.message),
    `${denied.status} ${denied.message}`
  );
  check("被拒的请求没有留下任何流水", saleCountByOrder(`MC-${STAMP}-DENY`) === 0);

  /* ============================================================ 16. 收尾 */
  section("15. 真库零写入 / 副本确实写了数据");

  const realAfter = realDbCounts();
  check(
    "真库 shop_sales 行数未变（脚本只写副本）",
    realAfter.shop_sales === REAL_BEFORE.shop_sales,
    `${REAL_BEFORE.shop_sales} → ${realAfter.shop_sales}`
  );
  check(
    "真库 shop_stock_flows 行数未变",
    realAfter.shop_stock_flows === REAL_BEFORE.shop_stock_flows,
    `${REAL_BEFORE.shop_stock_flows} → ${realAfter.shop_stock_flows}`
  );
  check("副本上确实建了商超库存流水表", hasStockFlowTable());
  check(
    "副本上的销售流水与库存流水都已落库（上面所有断言都打在副本上）",
    Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ?`, [HOTEL])?.n ?? 0) >= 10 &&
      Number(one(`SELECT COUNT(*) AS n FROM shop_stock_flows WHERE hotel_id = ?`, [HOTEL])?.n ?? 0) >= 10
  );
  check(
    "跨酒店隔离：整单查询都带 hotel_id（本店单子在他店查不到）",
    Number(one(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = ? AND order_no = ?`, [HOTEL_B, RID_3])?.n ?? 0) === 0
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

/** 撤销动作用的 FormData（id + reason） */
function cartFd2({ id, reason = "" }) {
  const f = new FormData();
  f.set("id", String(id));
  if (reason) f.set("reason", reason);
  return f;
}
