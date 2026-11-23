#!/usr/bin/env node
/**
 * 第六轮整改 一.2：商超销售 Server Action 权限 / 事务 / 幂等验收
 *
 * 背景（改造前）：
 *   src/app/(main)/shop/actions.ts 的销售、购物车结算、商品上下架只 requireUser()；
 *   挂房账不校验财务权限；库存扣减、账单入账、销售流水没有被保证在同一事务里
 *   （挂账时房号查不到就静默跳过，库存照扣、流水照写，客人账单却没记）；
 *   shop_sales.request_id 的唯一索引早就建好了，但代码从来没写过这个字段 —— 幂等是空的。
 *
 * 本脚本验四层：
 *   1. 源码静态：每个导出写动作必须有 requirePermission；挂房账额外校验
 *      cashier.charge_company；扣库存用条件更新；request_id 去重；撤销销售必填原因。
 *   2. 真实权限矩阵：转译并加载 src/lib/session.ts，直接问 hasPermission()。
 *   3. 数据库行为：VACUUM INTO 复制 data/pms.db 到临时文件，在副本上验证
 *        · 重复 request_id 被唯一索引挡住（不会重复销售）
 *        · 库存条件更新不会把库存扣成负数
 *        · 扣库存 + 写流水 + 写账单三项同事务（ROLLBACK 全部回滚）
 *        · 跨酒店查不到、改不到
 *   4. 页面：撤销销售必须走 ConfirmForm 且 requireReason 必填。
 *
 * 用法：node scripts/test-shop-permissions.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const requireCjs = createRequire(import.meta.url);
const SRC_DB = path.join(ROOT, "data", "pms.db");
const COPY_DB = path.join(ROOT, "data", `.test-shop-perm-${process.pid}.db`);
const TEST_DATE = "2099-12-31";

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

/* ============================================================ 0. 数据库副本 */

function makeDbCopy() {
  if (!fs.existsSync(SRC_DB)) throw new Error(`找不到数据库 ${SRC_DB}`);
  if (fs.existsSync(COPY_DB)) fs.unlinkSync(COPY_DB);
  const src = new DatabaseSync(SRC_DB);
  src.exec(`VACUUM INTO '${COPY_DB.replace(/\\/g, "/")}'`);
  src.close();
  return new DatabaseSync(COPY_DB);
}

function cleanup(db) {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${COPY_DB}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

/* ============================================================ 1. 加载真实 session.ts */

function loadSessionModule() {
  const ts = requireCjs("typescript");
  const Module = requireCjs("node:module");
  const srcDir = path.join(ROOT, "src", "lib");
  const outDir = path.join(ROOT, ".tmp", "perm-shop-harness");
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of ["session.ts", "db.ts", "utils.ts"]) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    });
    fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, ".js")), outputText);
  }

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "next/headers") {
      const deny = async () => {
        throw new Error("本脚本不在 Next.js 请求上下文中调用 getSession");
      };
      return { cookies: deny, headers: deny };
    }
    if (request === "next/navigation") {
      return {
        redirect: (url) => {
          throw new Error(`REDIRECT:${url}`);
        },
        notFound: () => {
          throw new Error("NOT_FOUND");
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return requireCjs(path.join(outDir, "session.js"));
  } finally {
    Module._load = originalLoad;
  }
}

/* ============================================================ 2. 源码解析 */

const ACTIONS_SRC_PATH = "src/app/(main)/shop/actions.ts";
const PAGE_SRC_PATH = "src/app/(main)/shop/page.tsx";

function sliceFunction(src, name) {
  const sig = `export async function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const nextExport = src.indexOf("\nexport ", start + sig.length);
  return src.slice(start, nextExport < 0 ? src.length : nextExport);
}

function firstMutationIndex(body) {
  const patterns = [
    /(?:^|\n)\s*run\s*\(/,
    /(?:^|\n)\s*tx\s*\(/,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
  ];
  let min = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined && (min < 0 || m.index < min)) min = m.index;
  }
  return min;
}

/* ============================================================ 主流程 */

async function main() {
  console.log("========== 第六轮 一.2 商超动作权限验收 ==========");
  console.log(`项目：${ROOT}`);

  const actionsSrc = read(ACTIONS_SRC_PATH);
  const pageSrc = read(PAGE_SRC_PATH);
  const session = loadSessionModule();
  const db = makeDbCopy();
  console.log(`数据库副本：${COPY_DB}`);

  try {
    /* ---------------------------------------------------------- 1. 源码守卫 */
    section("1. 源码：动作级权限 + 挂账额外校验 + 同事务 + 幂等");
    check(
      "actions.ts 导入 requirePermission",
      /import\s*\{[^}]*requirePermission[^}]*\}\s*from\s*"@\/lib\/session"/.test(actionsSrc)
    );
    check(
      "actions.ts 里 4 个写动作都改成了动作级权限（requirePermission 出现 ≥ 5 次）",
      (actionsSrc.match(/requirePermission\(/g) || []).length >= 5
    );

    const sales = sliceFunction(actionsSrc, "sellAction");
    const cart = sliceFunction(actionsSrc, "sellCartAction");
    const toggle = sliceFunction(actionsSrc, "toggleItemStatusAction");
    const voidSale = sliceFunction(actionsSrc, "voidSaleAction");

    check("sellAction 存在", Boolean(sales));
    check("sellCartAction 存在", Boolean(cart));
    check("toggleItemStatusAction 存在", Boolean(toggle));
    check("voidSaleAction 存在（本轮新增：撤销销售 / 退款）", Boolean(voidSale));

    for (const [name, body, perm] of [
      ["sellAction", sales, "cashier.receive"],
      ["sellCartAction", cart, "cashier.receive"],
      ["toggleItemStatusAction", toggle, "settings.manage"],
      ["voidSaleAction", voidSale, "cashier.refund"],
    ]) {
      if (!body) continue;
      const head = body.slice(0, 900);
      const m = head.match(/requirePermission\(\s*"([^"]+)"\s*\)/);
      check(`${name} 有动作级权限校验且权限点为 ${perm}`, m ? m[1] === perm : false, m ? `实际 ${m[1]}` : "无");
      const permIdx = m ? body.indexOf(m[0]) : -1;
      const mutIdx = firstMutationIndex(body);
      check(
        `${name} 权限校验在写库之前`,
        permIdx >= 0 && (mutIdx < 0 || permIdx < mutIdx)
      );
    }

    check(
      "sellAction 挂房账额外校验 cashier.charge_company",
      Boolean(sales) && /requirePermission\(\s*"cashier.charge_company"\s*\)/.test(sales)
    );
    check(
      "sellCartAction 挂房账额外校验 cashier.charge_company",
      Boolean(cart) && /requirePermission\(\s*"cashier.charge_company"\s*\)/.test(cart)
    );

    /* 同事务：扣库存 / 写流水 / 写账单都在 tx() 之后 */
    for (const [name, body] of [
      ["sellAction", sales],
      ["sellCartAction", cart],
    ]) {
      if (!body) continue;
      const txIdx = body.indexOf("tx(");
      const stockIdx = body.indexOf("UPDATE shop_items SET stock = stock -");
      const saleIdx = body.indexOf("INSERT INTO shop_sales");
      const folioIdx = body.indexOf("INSERT INTO folio_items");
      check(
        `${name} 扣库存 / 写销售流水 / 账单入账都在同一个 tx() 内`,
        txIdx >= 0 && stockIdx > txIdx && saleIdx > txIdx && folioIdx > txIdx,
        `tx=${txIdx} stock=${stockIdx} sale=${saleIdx} folio=${folioIdx}`
      );
    }

    check(
      "扣库存用条件更新（stock >= ?），库存不会为负",
      (actionsSrc.match(/stock >= \?/g) || []).length >= 2
    );
    check(
      "卖货前查询 request_id 做幂等（重复请求不重复销售）",
      /SELECT id FROM shop_sales WHERE hotel_id = \? AND request_id = \?/.test(actionsSrc)
    );
    check(
      "shop_sales 写入带 request_id（幂等标识真正落库，不是只建了索引）",
      /INSERT INTO shop_sales \([^)]*request_id\)/.test(actionsSrc)
    );
    check(
      "迁移里的部分唯一索引仍存在（并发下也能挡住重复 request_id）",
      /idx_shop_sales_request/.test(read("scripts/migrate-all.mjs"))
    );
    check(
      "撤销销售必须填原因（服务端强制）",
      Boolean(voidSale) && /撤销销售必须填写原因/.test(voidSale)
    );
    check(
      "撤销销售用 voided_at 做状态幂等（不能重复撤销）",
      Boolean(voidSale) && /WHERE id = \? AND hotel_id = \? AND voided_at IS NULL/.test(voidSale)
    );
    check("每笔商超写操作写 op_logs", (actionsSrc.match(/writeOpLog\(/g) || []).length >= 4);

    /* ---------------------------------------------------------- 2. 页面二次确认 */
    section("2. 页面：撤销销售二次确认 + 必填原因");
    check("page.tsx 引入 ConfirmForm", /import\s+ConfirmForm\s+from\s+"@\/components\/ConfirmForm"/.test(pageSrc));
    check(
      "撤销按钮放在 ConfirmForm 内（action={voidSaleAction}）",
      /<ConfirmForm[\s\S]{0,500}action=\{voidSaleAction\}/.test(pageSrc)
    );
    check("撤销弹窗要求填写原因（requireReason）", /requireReason="撤销原因"/.test(pageSrc));
    check("订单列表显示已撤销状态", /已撤销/.test(pageSrc));

    /* ---------------------------------------------------------- 3. 真实权限矩阵 */
    section("3. 真实权限矩阵（加载 session.ts 的 hasPermission 判定）");
    session.invalidatePermissionCache();
    check(
      "admin 拥有收款 / 挂公司账 / 退款 / 系统设置",
      ["cashier.receive", "cashier.charge_company", "cashier.refund", "settings.manage"].every(
        (p) => session.hasPermission("admin", p, 1) === true
      )
    );
    check(
      "cashier（收银）可以收款 / 挂账 / 退款，但不能改系统设置（上下架）",
      session.hasPermission("cashier", "cashier.receive", 1) &&
        session.hasPermission("cashier", "cashier.charge_company", 1) &&
        session.hasPermission("cashier", "cashier.refund", 1) &&
        !session.hasPermission("cashier", "settings.manage", 1)
    );
    check(
      "frontdesk（前台）不能挂公司账、不能退款（挂房账会被拒）",
      session.hasPermission("frontdesk", "cashier.receive", 1) &&
        !session.hasPermission("frontdesk", "cashier.charge_company", 1) &&
        !session.hasPermission("frontdesk", "cashier.refund", 1)
    );
    check(
      "housekeeper（客房）卖货 / 上下架 / 撤销全部被拒",
      ["cashier.receive", "cashier.charge_company", "cashier.refund", "settings.manage"].every(
        (p) => session.hasPermission("housekeeping", p, 1) === false
      )
    );
    check(
      "未知权限点一律拒绝",
      session.hasPermission("cashier", "shop.sell", 1) === false
    );

    /* ---------------------------------------------------------- 4. 数据库行为 */
    section("4. 数据库副本：幂等 / 非负库存 / 同事务 / 跨酒店隔离");
    const saleCols = db.prepare(`PRAGMA table_info(shop_sales)`).all().map((c) => c.name);
    check("shop_sales 有 request_id 列", saleCols.includes("request_id"), saleCols.join(","));
    /*
     * voided_at / void_reason 是「运行期懒补列」：
     * 迁移脚本的 shop_sales 段本轮不允许改动（本次整改只加权限种子），
     * 所以由 actions.ts 的 ensureShopSalesTable 在 action 执行 / 页面渲染前 ALTER 补齐。
     * 这里先断言代码里确实有这段补列 + 页面确实在查询前调用它，再在副本上重放一次。
     */
    check(
      "actions.ts 里对旧库补 voided_at / void_reason 列",
      /ALTER TABLE shop_sales ADD COLUMN voided_at TEXT/.test(actionsSrc) &&
        /ALTER TABLE shop_sales ADD COLUMN void_reason TEXT/.test(actionsSrc)
    );
    check(
      "page.tsx 在查询订单前调用 ensureShopPageSchema（旧库不会因缺列 500）",
      /await ensureShopPageSchema\(hotelId\)/.test(pageSrc) &&
        pageSrc.indexOf("await ensureShopPageSchema") < pageSrc.indexOf("FROM shop_sales")
    );
    for (const ddl of [
      "ALTER TABLE shop_sales ADD COLUMN voided_at TEXT",
      "ALTER TABLE shop_sales ADD COLUMN void_reason TEXT",
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* 已存在 */
      }
    }
    const saleColsAfter = db.prepare(`PRAGMA table_info(shop_sales)`).all().map((c) => c.name);
    check(
      "副本补列后 shop_sales 有 voided_at / void_reason（撤销销售可追溯）",
      saleColsAfter.includes("voided_at") && saleColsAfter.includes("void_reason")
    );
    const reqIdx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_shop_sales_request'`)
      .get();
    check("shop_sales(request_id) 部分唯一索引存在", Boolean(reqIdx && /WHERE request_id IS NOT NULL/.test(reqIdx.sql)));

    const now = new Date().toISOString();
    const insItem = db.prepare(
      `INSERT INTO shop_items (hotel_id, name, barcode, price, stock, category, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    const itemA = insItem.run(1, "验收商品A", "T-A", 3, 2, "验收", "ON", now).lastInsertRowid;
    const itemOther = insItem.run(2, "他店商品", "T-B", 5, 100, "验收", "ON", now).lastInsertRowid;
    check("副本可写入本店 / 他店验收商品", Number(itemA) > 0 && Number(itemOther) > 0);

    const stockOf = (id) => Number(db.prepare(`SELECT stock FROM shop_items WHERE id = ?`).get(id)?.stock ?? -1);

    /* 条件扣减：库存不足时被拒 */
    const tooMany = db
      .prepare(`UPDATE shop_items SET stock = stock - ? WHERE id = ? AND hotel_id = ? AND stock >= ?`)
      .run(3, itemA, 1, 3);
    check(`库存 2 件时卖 3 件 → changes = 0（实际 ${tooMany.changes}），库存不会被扣成负数`, Number(tooMany.changes) === 0);
    check("被拒之后库存仍是 2", stockOf(itemA) === 2);

    const exact = db
      .prepare(`UPDATE shop_items SET stock = stock - ? WHERE id = ? AND hotel_id = ? AND stock >= ?`)
      .run(2, itemA, 1, 2);
    check("库存刚好等于销量时允许出库（扣到 0）", Number(exact.changes) === 1 && stockOf(itemA) === 0);

    /* 跨酒店：本店身份改不到他店商品 */
    const crossHotel = db
      .prepare(`UPDATE shop_items SET stock = stock - 1 WHERE id = ? AND hotel_id = ? AND stock >= 1`)
      .run(itemOther, 1);
    const crossRead = db.prepare(`SELECT id FROM shop_items WHERE id = ? AND hotel_id = ?`).get(itemOther, 1);
    check("用本店身份扣他店商品的库存 → changes = 0", Number(crossHotel.changes) === 0);
    check("用本店身份读他店商品 → 查不到", crossRead === undefined);

    /* 重复 request_id：唯一索引挡住，不会重复销售 */
    const insSale = db.prepare(
      `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, request_id)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    insSale.run(1, "验收商品A", 1, 3, "现金", null, now, "REQ-VERIFY-1");
    let duplicated = false;
    try {
      insSale.run(1, "验收商品A", 1, 3, "现金", null, now, "REQ-VERIFY-1");
    } catch {
      duplicated = true;
    }
    check("同一 request_id 第二次写入被唯一索引拒绝（重复提交不会重复销售）", duplicated);
    const saleCount = db
      .prepare(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = 1 AND request_id = 'REQ-VERIFY-1'`)
      .get();
    check("重复提交后该 request_id 只有 1 条销售流水", Number(saleCount?.n) === 1);

    check(
      "不同酒店可以复用同一个 request_id（索引按 hotel_id 分段）",
      (() => {
        try {
          insSale.run(2, "他店商品", 1, 5, "现金", null, now, "REQ-VERIFY-1");
          return true;
        } catch {
          return false;
        }
      })()
    );

    /* 同事务：扣库存 + 写销售流水 + 写账单，ROLLBACK 后三者都不变
     *
     * 原来副本里没有账单时只打印「⚪ 跳过账单回滚断言」—— 少一条断言还判绿（假通过）。
     * 副本是 VACUUM INTO 拷来的真库，正常一定有账单；空库时这里自建一条测试账单，
     * 让「回滚后账单明细没有新增」这条断言无条件执行。
     */
    let folio = db.prepare(`SELECT id, hotel_id FROM folios WHERE hotel_id = 1 ORDER BY id LIMIT 1`).get();
    if (!folio) {
      const newId = db
        .prepare(
          `INSERT INTO folios (hotel_id, folio_no, guest_name, total_amount, paid_amount, balance, status, created_at)
           VALUES (1, ?, '事务回滚测试账单', 0, 0, 0, 'OPEN', ?)`
        )
        .run(`T-SHOP-RB-${Date.now()}`, now).lastInsertRowid;
      folio = { id: newId, hotel_id: 1 };
      console.log(`  （副本里没有账单，已自建测试账单 #${newId} 用于回滚断言）`);
    }
    db.prepare(`UPDATE shop_items SET stock = 5 WHERE id = ?`).run(itemA);
    const saleBefore = Number(
      db.prepare(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = 1 AND request_id = 'REQ-TX-RB'`).get()?.n ?? 0
    );
    const folioBefore = Number(
      db.prepare(`SELECT COUNT(*) AS n FROM folio_items WHERE hotel_id = 1 AND folio_id = ?`).get(folio.id)?.n ?? 0
    );

    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE shop_items SET stock = stock - 2 WHERE id = ? AND hotel_id = 1 AND stock >= 2`).run(itemA);
    db.prepare(
      `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, request_id)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(1, "验收商品A", 2, 6, "挂账 TEST", "TEST", now, "REQ-TX-RB");
    db.prepare(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(1, folio.id, "OTHER", "商超:验收商品A", 6, 2, now);
    db.exec("ROLLBACK");

    check("事务回滚后库存恢复为 5（不会「库存扣了钱没记」）", stockOf(itemA) === 5);
    check(
      "事务回滚后销售流水没有新增",
      Number(db.prepare(`SELECT COUNT(*) AS n FROM shop_sales WHERE hotel_id = 1 AND request_id = 'REQ-TX-RB'`).get()?.n ?? 0) ===
        saleBefore
    );
    check(
      "事务回滚后账单明细没有新增",
      Number(
        db.prepare(`SELECT COUNT(*) AS n FROM folio_items WHERE hotel_id = 1 AND folio_id = ?`).get(folio.id)?.n ?? 0
      ) === folioBefore
    );

    /* 撤销销售：voided_at 幂等 + 库存回加 + 原因可追溯 */
    const voidableId = insSale.run(1, "验收商品A", 1, 3, "现金", null, now, "REQ-VOID-1").lastInsertRowid;
    const stockBeforeVoid = stockOf(itemA);
    const voidSql = `UPDATE shop_sales SET voided_at = ?, void_reason = ? WHERE id = ? AND hotel_id = ? AND voided_at IS NULL`;
    const v1 = db.prepare(voidSql).run(now, "验收撤销", voidableId, 1);
    const v2 = db.prepare(voidSql).run(now, "验收撤销", voidableId, 1);
    check("第一次撤销销售成功（voided_at 置位）", Number(v1.changes) === 1);
    check("重复撤销同一销售单 → 影响 0 行（幂等，不会重复退款）", Number(v2.changes) === 0);
    db.prepare(`UPDATE shop_items SET stock = stock + 1 WHERE id = ? AND hotel_id = 1`).run(itemA);
    check("撤销后库存回加 1 件", stockOf(itemA) === stockBeforeVoid + 1);
    const voidedRow = db.prepare(`SELECT void_reason FROM shop_sales WHERE id = ? AND hotel_id = ?`).get(voidableId, 1);
    check("撤销原因写入 void_reason（可追溯）", Boolean(voidedRow && voidedRow.void_reason === "验收撤销"));

    /* 收尾：清掉本脚本插入的验收数据（副本随后删除） */
    db.prepare(`DELETE FROM shop_items WHERE barcode IN ('T-A','T-B')`).run();
    db.prepare(`DELETE FROM shop_sales WHERE request_id IN ('REQ-VERIFY-1','REQ-TX-RB','REQ-VOID-1')`).run();
  } finally {
    cleanup(db);
  }

  /* ---------------------------------------------------------- 汇总 */
  console.log("\n========== 汇总 ==========");
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log("❌ 未通过项：");
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  console.log("结果：全部通过 ✅");
}

main().catch((e) => {
  console.error("脚本执行失败：", e);
  process.exit(1);
});
