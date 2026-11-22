#!/usr/bin/env node
/**
 * 第六轮整改 一.3：商品档案与库存 Server Action 权限 / 原因 / 事务 / 非负验收
 *
 * 背景（改造前）：
 *   src/app/(main)/goods/actions.ts 的商品类别、商品档案、上下架、进货、退货、报废
 *   全都只校验登录；退货 / 报废可以不填原因；库存更新用「先读再写绝对值」，
 *   并发下可能把库存写回旧值；价格改动没有任何审计。
 *
 * 本脚本验四层：
 *   1. 源码静态：每个导出写动作必须有 requirePermission("settings.manage")；
 *      退货 / 报废强制填写原因；库存与 goods_flows 在同一事务；
 *      条件更新 stock + delta >= 0 保证库存不为负；价格改动写 op_logs。
 *   2. 真实权限矩阵：转译并加载 src/lib/session.ts，直接问 hasPermission()。
 *   3. 数据库行为：VACUUM INTO 复制 data/pms.db 到临时文件，在副本上验证
 *        · 库存不足时条件更新影响 0 行、库存不变
 *        · goods.stock 与 goods_flows 同事务（ROLLBACK 后两者都不变）
 *        · stock_after 与真实库存一致
 *        · 跨酒店读不到、改不到
 *   4. 页面：退货 / 报废走 ConfirmForm 且 requireReason 必填。
 *
 * 用法：node scripts/test-goods-permissions.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const requireCjs = createRequire(import.meta.url);
const SRC_DB = path.join(ROOT, "data", "pms.db");
const COPY_DB = path.join(ROOT, "data", `.test-goods-perm-${process.pid}.db`);

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
  const outDir = path.join(ROOT, ".tmp", "perm-goods-harness");
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

const ACTIONS_SRC_PATH = "src/app/(main)/goods/actions.ts";
const PAGE_SRC_PATH = "src/app/(main)/goods/page.tsx";

function sliceFunction(src, name) {
  const sig = `export async function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const nextExport = src.indexOf("\nexport ", start + sig.length);
  if (nextExport < 0) {
    /* 最后一个导出函数：切到文件尾，但排除后面的私有函数 */
    return src.slice(start);
  }
  return src.slice(start, nextExport);
}

/** 取私有函数体（到下一个顶层 async function / export 或文件尾） */
function slicePrivate(src, name) {
  const sig = `async function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const next = src.indexOf("\nasync function ", start + sig.length);
  const nextExport = src.indexOf("\nexport ", start + sig.length);
  const candidates = [next, nextExport].filter((n) => n > 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
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
  console.log("========== 第六轮 一.3 商品档案与库存动作权限验收 ==========");
  console.log(`项目：${ROOT}`);

  const actionsSrc = read(ACTIONS_SRC_PATH);
  const pageSrc = read(PAGE_SRC_PATH);
  const session = loadSessionModule();
  const db = makeDbCopy();
  console.log(`数据库副本：${COPY_DB}`);

  try {
    /* ---------------------------------------------------------- 1. 源码守卫 */
    section("1. 源码：动作级权限 + 退货/报废必填原因 + 同事务 + 非负库存");
    check(
      "actions.ts 导入 requirePermission",
      /import\s*\{[^}]*requirePermission[^}]*\}\s*from\s*"@\/lib\/session"/.test(actionsSrc)
    );
    check(
      "库存 / 档案动作不再只靠 requireUser（requirePermission 出现 4 次：3 个档案动作 + 库存统一入口）",
      (actionsSrc.match(/requirePermission\(/g) || []).length >= 4
    );

    for (const name of ["createCategoryAction", "saveGoodsAction", "toggleGoodsStatusAction"]) {
      const body = sliceFunction(actionsSrc, name);
      if (!body) {
        check(`${name} 存在`, false);
        continue;
      }
      const m = body.slice(0, 900).match(/requirePermission\(\s*"([^"]+)"\s*\)/);
      check(`${name} 有动作级权限校验且为 settings.manage`, m ? m[1] === "settings.manage" : false, m ? `实际 ${m[1]}` : "无");
      const permIdx = m ? body.indexOf(m[0]) : -1;
      const mutIdx = firstMutationIndex(body);
      check(`${name} 权限校验在写库之前`, permIdx >= 0 && (mutIdx < 0 || permIdx < mutIdx));
    }

    /* 进货 / 退货 / 报废：统一走 applyStockMove，权限点在私有函数里 */
    const stockMove = slicePrivate(actionsSrc, "applyStockMove");
    check("applyStockMove 存在（进货 / 退货 / 报废的统一实现）", Boolean(stockMove));
    const movePerm = stockMove ? stockMove.slice(0, 900).match(/requirePermission\(\s*"([^"]+)"\s*\)/) : null;
    check(
      "进货 / 退货 / 报废都有动作级权限（settings.manage）",
      movePerm ? movePerm[1] === "settings.manage" : false,
      movePerm ? `实际 ${movePerm[1]}` : "无"
    );
    for (const [fn, type] of [
      ["purchaseAction", "PURCHASE"],
      ["returnAction", "RETURN"],
      ["rejectAction", "REJECT"],
    ]) {
      const body = sliceFunction(actionsSrc, fn);
      check(`${fn} 调用受权限保护的 applyStockMove("${type}")`, Boolean(body) && body.includes(`applyStockMove("${type}"`));
    }

    check(
      "退货 / 报废必须填写原因（服务端强制，且页面弹窗同样必填）",
      Boolean(stockMove) &&
        /type !== "PURCHASE" && !note/.test(stockMove) &&
        /必须填写原因/.test(stockMove)
    );
    check(
      "原因字段兼容 ConfirmForm 的 reason 与库存表单的 note",
      Boolean(stockMove) &&
        /formData\.get\("note"\)/.test(stockMove) &&
        /formData\.get\("reason"\)/.test(stockMove)
    );

    /* 同事务：goods.stock 与 goods_flows */
    const txIdx = stockMove ? stockMove.indexOf("tx(() =>") : -1;
    const stockIdx = stockMove ? stockMove.indexOf("UPDATE goods SET stock = stock +") : -1;
    const flowIdx = stockMove ? stockMove.indexOf("INSERT INTO goods_flows") : -1;
    check(
      "库存更新与 goods_flows 写入在同一个 tx() 内",
      txIdx >= 0 && stockIdx > txIdx && flowIdx > txIdx,
      `tx=${txIdx} stock=${stockIdx} flow=${flowIdx}`
    );
    check(
      "库存用条件更新（stock + ? >= 0），不会为负",
      Boolean(stockMove) && /stock \+ \? >= 0/.test(stockMove)
    );
    check(
      "库存不足返回失败并回滚（changes === 0 判定）",
      Boolean(stockMove) && /updated\.changes === 0/.test(stockMove)
    );
    check(
      "goods_flows.stock_after 取更新后的真实结存（同事务内回读）",
      Boolean(stockMove) && /SELECT stock FROM goods WHERE id = \? AND hotel_id = \?/.test(stockMove)
    );

    /* 价格修改日志 */
    const saveGoods = sliceFunction(actionsSrc, "saveGoodsAction");
    check(
      "商品价格修改写 op_logs（含成本价 / 售价变化）",
      Boolean(saveGoods) &&
        /writeOpLog\(/.test(saveGoods) &&
        /商品改价/.test(saveGoods) &&
        /成本价 \$\{fmtMoney\(existed\.cost_price\)\}/.test(saveGoods)
    );
    check(
      "库存操作同样写 op_logs（涉及金额的变动可追溯）",
      Boolean(stockMove) && /库存\$\{label\}/.test(stockMove) && /writeOpLog\(/.test(stockMove)
    );
    check(
      "商品上下架写 op_logs",
      /商品上下架/.test(actionsSrc) && /writeOpLog\(/.test(actionsSrc)
    );

    /* 多酒店隔离（源码） */
    const goodsRefs = [...actionsSrc.matchAll(/(?:FROM|UPDATE|INSERT INTO)\s+goods\b/g)];
    const goodsLeaks = goodsRefs.filter((m) => !actionsSrc.slice(m.index, m.index + 420).includes("hotel_id"));
    check(
      `goods 的 ${goodsRefs.length} 处读写都带 hotel_id`,
      goodsRefs.length > 0 && goodsLeaks.length === 0,
      goodsLeaks.length > 0 ? `${goodsLeaks.length} 处未带 hotel_id` : ""
    );
    const catRefs = [...actionsSrc.matchAll(/(?:FROM|UPDATE|INSERT INTO)\s+goods_categories\b/g)];
    const catLeaks = catRefs.filter((m) => !actionsSrc.slice(m.index, m.index + 320).includes("hotel_id"));
    check(`goods_categories 的 ${catRefs.length} 处读写都带 hotel_id`, catRefs.length > 0 && catLeaks.length === 0);
    check(
      "goods_flows 写入带 hotel_id（流水同样按酒店隔离）",
      /INSERT INTO goods_flows[\s\S]{0,220}hotel_id/.test(actionsSrc)
    );

    /* ---------------------------------------------------------- 2. 页面 */
    section("2. 页面：退货 / 报废二次确认 + 必填原因");
    check("page.tsx 引入 ConfirmForm", /import\s+ConfirmForm\s+from\s+"@\/components\/ConfirmForm"/.test(pageSrc));
    check(
      "退货 / 报废表单包在 ConfirmForm 内且带 requireReason",
      /<ConfirmForm[\s\S]{0,600}requireReason=\{`\$\{f\.title\}原因`\}/.test(pageSrc)
    );
    check(
      "只有退货 / 报废需要原因（进货保持普通表单）",
      /const reasonRequired = f\.type !== "PURCHASE"/.test(pageSrc)
    );

    /* ---------------------------------------------------------- 3. 真实权限矩阵 */
    section("3. 真实权限矩阵（加载 session.ts 的 hasPermission 判定）");
    session.invalidatePermissionCache();
    check("admin 拥有 settings.manage（商品档案 / 库存 / 上下架都放行）", session.hasPermission("admin", "settings.manage", 1) === true);
    check(
      "frontdesk / cashier / housekeeping 都没有 settings.manage（不能改进货、退货、报废）",
      ["frontdesk", "cashier", "housekeeping"].every((r) => session.hasPermission(r, "settings.manage", 1) === false)
    );
    check(
      "没有凭空新增 goods.stock（复用现有 settings.manage 表达库存权限）",
      !/"goods\.stock"\s*:/.test(read("src/lib/session.ts"))
    );

    /* ---------------------------------------------------------- 4. 数据库行为 */
    section("4. 数据库副本：非负库存 / 同事务 / 跨酒店隔离");
    /* 三张表在本仓库是懒建的：副本里没有就按 actions.ts 的 DDL 建（等价于页面首次访问） */
    db.exec(`CREATE TABLE IF NOT EXISTS goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      category_id INTEGER,
      name TEXT NOT NULL,
      barcode TEXT,
      unit TEXT NOT NULL DEFAULT '件',
      cost_price REAL NOT NULL DEFAULT 0,
      sell_price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      warn_stock INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ON',
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS goods_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      goods_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      qty INTEGER NOT NULL,
      stock_after INTEGER NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT,
      operator TEXT,
      created_at TEXT NOT NULL
    )`);
    const goodsCols = db.prepare(`PRAGMA table_info(goods)`).all().map((c) => c.name);
    check("goods 有 hotel_id 列（多酒店隔离的前提）", goodsCols.includes("hotel_id"), goodsCols.join(","));
    const flowCols = db.prepare(`PRAGMA table_info(goods_flows)`).all().map((c) => c.name);
    check("goods_flows 有 hotel_id / stock_after 列", flowCols.includes("hotel_id") && flowCols.includes("stock_after"));

    const now = new Date().toISOString();
    const insGoods = db.prepare(
      `INSERT INTO goods (hotel_id, category_id, name, barcode, unit, cost_price, sell_price, stock, warn_stock, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const goodsA = insGoods.run(1, null, "验收库存商品", "G-A", "件", 2, 5, 2, 1, "ON", now).lastInsertRowid;
    const goodsOther = insGoods.run(2, null, "他店库存商品", "G-B", "件", 3, 8, 100, 1, "ON", now).lastInsertRowid;
    check("副本可写入本店 / 他店验收商品", Number(goodsA) > 0 && Number(goodsOther) > 0);

    const stockOf = (id) => Number(db.prepare(`SELECT stock FROM goods WHERE id = ?`).get(id)?.stock ?? -1);

    /* 条件更新：库存不足被拒 */
    const tooMany = db
      .prepare(`UPDATE goods SET stock = stock + ? WHERE id = ? AND hotel_id = ? AND stock + ? >= 0`)
      .run(-3, goodsA, 1, -3);
    check(`库存 2 件时退货 3 件 → changes = 0（实际 ${tooMany.changes}），库存不会被扣成负数`, Number(tooMany.changes) === 0);
    check("被拒之后库存仍是 2", stockOf(goodsA) === 2);

    /* 入库 +5，同事务写流水，stock_after 与库存一致 */
    const insFlow = db.prepare(
      `INSERT INTO goods_flows (hotel_id, goods_id, type, qty, stock_after, unit_price, amount, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE goods SET stock = stock + ? WHERE id = ? AND hotel_id = ? AND stock + ? >= 0`).run(5, goodsA, 1, 5);
    const afterIn = stockOf(goodsA);
    insFlow.run(1, goodsA, "PURCHASE", 5, afterIn, 2, 10, "验收入库", "验收脚本", now);
    db.exec("COMMIT");
    check("进货后库存 = 7", afterIn === 7);
    const flowRow = db
      .prepare(`SELECT qty, stock_after FROM goods_flows WHERE hotel_id = 1 AND goods_id = ? AND type = 'PURCHASE' ORDER BY id DESC LIMIT 1`)
      .get(goodsA);
    check("流水 qty / stock_after 与商品库存一致（同事务）", Boolean(flowRow) && Number(flowRow.stock_after) === 7 && Number(flowRow.qty) === 5);

    /* 回滚：库存与流水都不落地 */
    const flowCountBefore = Number(
      db.prepare(`SELECT COUNT(*) AS n FROM goods_flows WHERE hotel_id = 1 AND goods_id = ?`).get(goodsA)?.n ?? 0
    );
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE goods SET stock = stock + ? WHERE id = ? AND hotel_id = ? AND stock + ? >= 0`).run(-2, goodsA, 1, -2);
    insFlow.run(1, goodsA, "REJECT", -2, 5, 2, 4, "验收报废", "验收脚本", now);
    db.exec("ROLLBACK");
    check("事务回滚后库存仍是 7（不会「报废了但库存没变」或反之）", stockOf(goodsA) === 7);
    check(
      "事务回滚后 goods_flows 没有新增",
      Number(db.prepare(`SELECT COUNT(*) AS n FROM goods_flows WHERE hotel_id = 1 AND goods_id = ?`).get(goodsA)?.n ?? 0) ===
        flowCountBefore
    );

    /* 跨酒店：本店身份读不到 / 改不到他店商品 */
    const crossRead = db.prepare(`SELECT id FROM goods WHERE id = ? AND hotel_id = ?`).get(goodsOther, 1);
    check("用本店身份读他店商品 → 查不到", crossRead === undefined);
    const crossUpdate = db
      .prepare(`UPDATE goods SET stock = stock + ? WHERE id = ? AND hotel_id = ? AND stock + ? >= 0`)
      .run(-1, goodsOther, 1, -1);
    check("用本店身份改他店商品库存 → changes = 0", Number(crossUpdate.changes) === 0);
    check("他店商品库存保持 100", stockOf(goodsOther) === 100);
    const crossFlow = db.prepare(`SELECT id FROM goods_flows WHERE hotel_id = ? AND goods_id = ?`).all(1, goodsOther);
    check("他店商品的流水不会出现在本店查询结果里", crossFlow.length === 0);

    /* 收尾：清掉本脚本插入的验收数据（副本随后删除） */
    db.prepare(`DELETE FROM goods_flows WHERE goods_id IN (?, ?)`).run(goodsA, goodsOther);
    db.prepare(`DELETE FROM goods WHERE barcode IN ('G-A','G-B')`).run();
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
