#!/usr/bin/env node
/**
 * 发票红冲并发唯一约束验收（第七轮整改清单一.3，清单第 52-75 行）
 *
 * ── 清单要求 ↔ 本脚本断言 ──
 *   1. 增加 idx_invoices_red_of（on invoices(hotel_id, red_of) where red_of is not null）
 *      → 一、副本库索引结构：存在 / UNIQUE / 列顺序 / WHERE 条件 / 迁移幂等 / 三处 DDL 一致
 *   2. 应用层检查继续保留
 *      → 二、重复红冲仍被 lib 的应用层查询拦住（不是靠数据库报错）
 *   3. 数据库唯一约束必须保留
 *      → 三、绕开应用层直接 INSERT 同 (hotel_id, red_of)：第二次被真实唯一索引拒绝
 *   4. 并发红冲同一原票只允许一张红冲票
 *      → 四、两个写事务交错（连接 A 未提交 / 连接 B 被写锁挡住 / A 提交后 B 撞唯一索引）
 *   5. 红冲原因必须由服务端校验
 *      → 六、**真实调用 redFlushInvoiceAction**（stub next/* + 真实会话）：不传原因 / 空白原因被拒；
 *        lib 层再拦超长原因
 *   6. 原票状态不能通过普通更新重新变成可红冲
 *      → 二、把原票状态人工 UPDATE 回 ISSUED，redFlushInvoice 仍被拒（以「是否存在红冲票」为准）
 *   7. 新增并发红冲测试 → 本文件
 *
 * ── 真库隔离 ──
 *   data/pms.db --VACUUM INTO--> .tmp/invoice-red-flush-<时间戳>.db，注入 globalThis.__pmsDb。
 *   lib 的 getDb() 因此连副本；结尾用只读连接复查真库零写入。
 *
 * 运行：node scripts/test-invoice-red-flush-concurrency.mjs
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
const COPY_DB = path.join(TMP_DIR, `invoice-red-flush-${STAMP}.db`);
const STUB_FILE = path.join(TMP_DIR, `invoice-red-flush-stub-${STAMP}.mjs`);
const HOTEL_B = 999;
const PREFIX = `TEST-REDFLUSH-${STAMP}`;

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

function cleanup() {
  for (const f of [COPY_DB, `${COPY_DB}-wal`, `${COPY_DB}-shm`, STUB_FILE]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 已删 / 被占用 */
    }
  }
}
process.on("exit", cleanup);

/* Node 在 .ts 上会提示「package.json 没有 type: module」，属于噪音，过滤掉 */
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* ============================================================ 一、副本库 */

console.log("=== 一、副本库 + 索引结构 ===");

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
const tableExists = (name) =>
  all(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]).length > 0;

check("副本有 invoices 表", tableExists("invoices"));
const redIdx = one(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name = 'idx_invoices_red_of'`);
check("已加索引 idx_invoices_red_of（清单要求的数据库唯一约束）", Boolean(redIdx), JSON.stringify(redIdx));
const redIdxSql = String(redIdx?.sql ?? "");
check("idx_invoices_red_of 是 UNIQUE", /CREATE\s+UNIQUE\s+INDEX/i.test(redIdxSql), redIdxSql);
check(
  "idx_invoices_red_of 的列顺序是 (hotel_id, red_of)",
  /ON\s+invoices\s*\(\s*hotel_id\s*,\s*red_of\s*\)/i.test(redIdxSql),
  redIdxSql
);
check(
  "idx_invoices_red_of 带 WHERE red_of IS NOT NULL（正常票 NULL 不受约束）",
  /WHERE\s+red_of\s+IS\s+NOT\s+NULL/i.test(redIdxSql),
  redIdxSql
);
const idxCols = all(`PRAGMA index_info('idx_invoices_red_of')`).map((r) => r.name);
check(
  "PRAGMA index_info 证实索引列为 [hotel_id, red_of]",
  idxCols.length === 2 && idxCols[0] === "hotel_id" && idxCols[1] === "red_of",
  JSON.stringify(idxCols)
);

/* 迁移幂等：本项负责的条目不应再有「待处理」 */
const { runMigrations } = await import("./migrate-all.mjs");
const migrated = runMigrations(db, { checkOnly: true });
const pendingInv = migrated.applied.filter((x) => /invoices|idx_invoices/.test(x));
check("migrate-all --check 无 invoices 待迁移项（迁移可重复执行）", pendingInv.length === 0, pendingInv.join(", "));

/* 三处 DDL 必须一致：新库安装 / 旧库迁移 / 应用层兜底 */
const libSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "invoice.ts"), "utf8");
const migrateSrc = fs.readFileSync(path.join(ROOT, "scripts", "migrate-all.mjs"), "utf8");
const schemaSrc = fs.readFileSync(path.join(ROOT, "scripts", "schema-full.sql"), "utf8");
const ddlShape = /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?idx_invoices_red_of\s+ON\s+invoices\s*\(\s*hotel_id\s*,\s*red_of\s*\)\s*WHERE\s+red_of\s+IS\s+NOT\s+NULL/i;
check("src/lib/invoice.ts ensureInvoiceSchema() 兜底建同一索引", ddlShape.test(libSrc));
check("scripts/migrate-all.mjs 用 addIndex() 建同一索引", ddlShape.test(migrateSrc));
check("scripts/schema-full.sql 建同一索引", ddlShape.test(schemaSrc));
check(
  "应用层「是否已被红冲」查询仍在（保留清单要求的应用层检查）",
  /SELECT id, invoice_no FROM invoices WHERE hotel_id = \? AND red_of = \?/.test(libSrc)
);

/* ============================================================ 桩 + 真实源码 */

fs.writeFileSync(
  STUB_FILE,
  `let sid = null;
export function cookies() {
  return {
    get: (name) => (sid && name === "pms_sid" ? { value: sid } : undefined),
    set: () => {},
    delete: () => {},
  };
}
export function headers() { return new Map(); }
export function redirect(url) { throw new Error("NEXT_REDIRECT:" + url); }
export function notFound() { throw new Error("NEXT_NOT_FOUND"); }
export function revalidatePath() {}
export function revalidateTag() {}
export function setSid(v) { sid = v; }
`
);
const stubUrl = pathToFileURL(STUB_FILE).href;

/* 让 Node 能解析 Next 的 `@/` 别名与 next/* 桩：测的是真实 service / 真实 action */
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
    /* 源码里的相对导入多数省略扩展名（如 session.ts 的 `./db`），补 .ts 再交给 Node */
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(ts|tsx|js|mjs|json|css)$/.test(specifier)
    ) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* 交给默认解析 */
      }
    }
    return next(specifier, context);
  },
});

globalThis.__pmsDb = db;

const stub = await import(stubUrl);
const invoice = await import("../src/lib/invoice.ts");
const actions = await import("../src/app/(main)/invoices/actions.ts");
const { issueInvoice, redFlushInvoice, listInvoices } = invoice;
check(
  "已加载真实源码：src/lib/invoice.ts + invoices/actions.ts",
  typeof issueInvoice === "function" && typeof redFlushInvoice === "function" && typeof actions.redFlushInvoiceAction === "function"
);

/* 包一层：业务函数理论上不抛异常，真的抛了也记成失败而不是让脚本崩掉 */
const safe = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { error: `异常：${e?.message ?? e}` };
  }
};

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const NOW = now.toISOString();

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  "TEST999",
  "发票红冲验收酒店",
  "测试地址",
  "000",
  NOW,
]);

/** 造一张已结账账单（发票只能对已结账账单开） */
function addFolio(total) {
  const res = run(
    `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [1, `${PREFIX}-FOLIO-${Math.random().toString(36).slice(2, 8)}`, null, "红冲并发验收客人", "9999", total, total, 0, "SETTLED", NOW]
  );
  return Number(res.lastInsertRowid);
}

const redChildren = (id, hotelId = 1) =>
  all(`SELECT * FROM invoices WHERE hotel_id = ? AND red_of = ? ORDER BY id`, [hotelId, id]);

/* ============================================================ 二、应用层行为 */

console.log("\n=== 二、应用层：正常发票 → 红冲成功 → 再红冲被拒 ===");

const folioA = addFolio(100);
const invA = safe(() => issueInvoice({ hotelId: 1, title: "红冲并发验收抬头", amount: 100, folioId: folioA, operator: "验收脚本" }));
check("前置：对已结账账单开出正常票 A（issueInvoice 真实实现）", "ok" in invA && invA.ok === true, JSON.stringify(invA));

if ("ok" in invA) {
  const flushA = safe(() => redFlushInvoice(1, invA.id, { operator: "验收脚本", remark: "并发验收首次红冲" }));
  check("红冲成功（应用层正常路径）", "ok" in flushA && flushA.ok === true, JSON.stringify(flushA));

  if ("ok" in flushA) {
    const redRow = one(`SELECT * FROM invoices WHERE id = ?`, [flushA.id]);
    const srcRow = one(`SELECT * FROM invoices WHERE id = ?`, [invA.id]);
    check("红冲票 amount = -原票金额（-100）", Number(redRow?.amount) === -100, String(redRow?.amount));
    check("红冲票 red_of 指向原票", Number(redRow?.red_of) === invA.id, String(redRow?.red_of));
    check("红冲票 invoice_type = RED", redRow?.invoice_type === "RED", String(redRow?.invoice_type));
    check("原票 status 由 ISSUED 改为 RED", srcRow?.status === "RED", String(srcRow?.status));

    /* 应用层检查仍然生效：重复红冲被 lib 拦住（不是靠数据库报错） */
    const again = safe(() => redFlushInvoice(1, invA.id, { operator: "验收脚本", remark: "重复红冲" }));
    check(
      "重复红冲被应用层拒绝（文案含「已红冲」，不是 SQLite 原始错误）",
      "error" in again && /已红冲/.test(again.error) && !/UNIQUE constraint failed/i.test(again.error),
      JSON.stringify(again)
    );
    check("重复红冲被拒后负数票仍只有 1 张", redChildren(invA.id).length === 1, String(redChildren(invA.id).length));

    /* 原票状态不能通过普通更新重新变成可红冲：把 status 改回 ISSUED 也红冲不出来 */
    run(`UPDATE invoices SET status = 'ISSUED' WHERE id = ? AND hotel_id = 1`, [invA.id]);
    check(
      "前置：已把原票状态人工改回 ISSUED（模拟普通更新改状态）",
      one(`SELECT status FROM invoices WHERE id = ?`, [invA.id])?.status === "ISSUED"
    );
    const afterRevert = safe(() => redFlushInvoice(1, invA.id, { operator: "验收脚本", remark: "状态回滚后重复红冲" }));
    check(
      "★ 状态改回 ISSUED 后 redFlushInvoice 仍被拒（以「是否存在红冲票」为准，双条件）",
      "error" in afterRevert && /已红冲/.test(afterRevert.error),
      JSON.stringify(afterRevert)
    );
    check("★ 状态改回后负数票仍然只有 1 张（没有第二张红冲票）", redChildren(invA.id).length === 1, String(redChildren(invA.id).length));
    run(`UPDATE invoices SET status = 'RED' WHERE id = ? AND hotel_id = 1`, [invA.id]);
  }
}

/* ============================================================ 三、数据库唯一约束 */

console.log("\n=== 三、数据库唯一约束（绕开应用层，直接 INSERT）===");

const folioB = addFolio(50);
const invB = safe(() => issueInvoice({ hotelId: 1, title: "红冲并发验收抬头", amount: 50, folioId: folioB, operator: "验收脚本" }));
check("前置：开出正常票 B", "ok" in invB && invB.ok === true, JSON.stringify(invB));

if ("ok" in invB) {
  const insertRedDirect = (invoiceNo, redOf, hotelId = 1) =>
    run(
      `INSERT INTO invoices
         (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [hotelId, invoiceNo, "RED", "红冲并发验收抬头", -50, redOf, "ISSUED", TODAY, NOW]
    );

  const c1 = safe(() => insertRedDirect(`${PREFIX}-C1`, invB.id));
  check("① 绕开应用层，第一张红冲票直接 INSERT 成功（唯一索引放行首张）", Boolean(c1?.lastInsertRowid), JSON.stringify(c1));

  let c2Err = null;
  try {
    insertRedDirect(`${PREFIX}-C2`, invB.id);
  } catch (e) {
    c2Err = e;
  }
  check(
    "② 第二次 INSERT 同 (hotel_id, red_of) 被唯一索引拒绝（真实约束生效）",
    c2Err !== null && /UNIQUE/i.test(String(c2Err?.message)),
    String(c2Err?.message ?? "没有抛错 —— 唯一索引没生效")
  );
  check(
    "③ 拒绝原因指向 red_of（不是票号冲突）",
    c2Err !== null && /red_of|idx_invoices_red_of/i.test(String(c2Err?.message)),
    String(c2Err?.message ?? "")
  );
  check("④ 该原票负数票仍然只有 1 张（第二张没写进去）", redChildren(invB.id).length === 1, String(redChildren(invB.id).length));

  /* 换一个连接再试：约束是库级的，不是单连接缓存 */
  const db2 = new DatabaseSync(COPY_DB, { timeout: 8000 });
  let crossErr = null;
  try {
    db2
      .prepare(
        `INSERT INTO invoices
           (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(1, `${PREFIX}-C3`, "RED", "红冲并发验收抬头", -50, invB.id, "ISSUED", TODAY, NOW);
  } catch (e) {
    crossErr = e;
  } finally {
    db2.close();
  }
  check(
    "⑤ 另一个数据库连接插入同 (hotel_id, red_of) 同样被拒（库级约束）",
    crossErr !== null && /UNIQUE/i.test(String(crossErr?.message)),
    String(crossErr?.message ?? "没有抛错")
  );
  check("⑥ 跨连接尝试失败后负数票仍只有 1 张", redChildren(invB.id).length === 1, String(redChildren(invB.id).length));
}

/* ============================================================ 四、并发交错 */

console.log("\n=== 四、并发：两个写事务交错，只允许一张红冲票 ===");

const folioC = addFolio(30);
const invC = safe(() => issueInvoice({ hotelId: 1, title: "红冲并发验收抬头", amount: 30, folioId: folioC, operator: "验收脚本" }));
check("前置：开出正常票 C（并发目标）", "ok" in invC && invC.ok === true, JSON.stringify(invC));

if ("ok" in invC) {
  const writer = new DatabaseSync(COPY_DB, { timeout: 8000 });
  const racer = new DatabaseSync(COPY_DB, { timeout: 200 }); // 只等 200ms：证明写锁互斥
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare(
        `INSERT INTO invoices
           (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(1, `${PREFIX}-W1`, "RED", "红冲并发验收抬头", -30, invC.id, "ISSUED", TODAY, NOW);
    const invisible = Number(one(`SELECT COUNT(*) AS c FROM invoices WHERE hotel_id = 1 AND red_of = ?`, [invC.id])?.c ?? -1);
    check(
      "① 写事务 A 插入成功但尚未提交，另一个连接看不到（并发窗口真的打开了）",
      invisible === 0,
      `另一个连接看到 ${invisible} 张`
    );

    let lockErr = null;
    try {
      racer.exec("BEGIN IMMEDIATE");
      racer
        .prepare(
          `INSERT INTO invoices
             (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(1, `${PREFIX}-W2`, "RED", "红冲并发验收抬头", -30, invC.id, "ISSUED", TODAY, NOW);
    } catch (e) {
      lockErr = e;
    }
    check(
      "② 第二个写事务被 SQLite 写锁挡住（BUSY/locked）—— 并发写被串行化，不会同时通过",
      lockErr !== null && /busy|locked/i.test(String(lockErr?.message)),
      String(lockErr?.message ?? "没有抛错：两个连接同时写成功（异常）")
    );

    writer.exec("COMMIT");
    const visible = Number(one(`SELECT COUNT(*) AS c FROM invoices WHERE hotel_id = 1 AND red_of = ?`, [invC.id])?.c ?? -1);
    check("③ 写事务 A 提交后红冲票对其它连接可见", visible === 1, `看到 ${visible} 张`);

    let dupErr = null;
    try {
      racer.exec("BEGIN IMMEDIATE");
      racer
        .prepare(
          `INSERT INTO invoices
             (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(1, `${PREFIX}-W2`, "RED", "红冲并发验收抬头", -30, invC.id, "ISSUED", TODAY, NOW);
    } catch (e) {
      dupErr = e;
    } finally {
      try {
        racer.exec("ROLLBACK");
      } catch {
        /* 没有活动事务 */
      }
    }
    check(
      "④ 串行化后的第二次插入撞 UNIQUE（red_of）—— 并发下最终只有一张红冲票",
      dupErr !== null && /UNIQUE/i.test(String(dupErr?.message)) && /red_of|idx_invoices_red_of/i.test(String(dupErr?.message)),
      String(dupErr?.message ?? "没有抛错")
    );
    check("⑤ 并发目标原票最终只有 1 张负数票", redChildren(invC.id).length === 1, String(redChildren(invC.id).length));
  } finally {
    try {
      writer.close();
    } catch {
      /* 已关闭 */
    }
    try {
      racer.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/* ============================================================ 五、跨酒店 */

console.log("\n=== 五、跨酒店：组合索引含 hotel_id，别家店可用同一 red_of ===");

if ("ok" in invB) {
  let crossHotelErr = null;
  try {
    run(
      `INSERT INTO invoices
         (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [HOTEL_B, `${PREFIX}-H999`, "RED", "红冲并发验收抬头", -50, invB.id, "ISSUED", TODAY, NOW]
    );
  } catch (e) {
    crossHotelErr = e;
  }
  check(
    "① hotel 999 使用与 hotel 1 相同的 red_of 被允许（索引是 (hotel_id, red_of) 组合）",
    crossHotelErr === null,
    String(crossHotelErr?.message ?? "")
  );
  check("② hotel 1 该原票的红冲票仍只有 1 张", redChildren(invB.id, 1).length === 1, String(redChildren(invB.id, 1).length));
  check("③ hotel 999 有自己的一张红冲票", redChildren(invB.id, HOTEL_B).length === 1, String(redChildren(invB.id, HOTEL_B).length));

  /* 反向验证：hotel 1 再插一张同 red_of 仍必须被拒（别家店那张不影响本店约束） */
  let stillDup = null;
  try {
    run(
      `INSERT INTO invoices
         (hotel_id, invoice_no, invoice_type, title, amount, red_of, status, biz_date, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [1, `${PREFIX}-C4`, "RED", "红冲并发验收抬头", -50, invB.id, "ISSUED", TODAY, NOW]
    );
  } catch (e) {
    stillDup = e;
  }
  check(
    "④ hotel 1 再插同 red_of 仍被拒（跨酒店那张不会放行本店第二张）",
    stillDup !== null && /UNIQUE/i.test(String(stillDup?.message)),
    String(stillDup?.message ?? "没有抛错")
  );
}

/* ============================================================ 六、错误文案 + 原因校验 */

console.log("\n=== 六、错误可读文案 + 红冲原因服务端校验 ===");

const folioD = addFolio(20);
const invD = safe(() => issueInvoice({ hotelId: 1, title: "红冲并发验收抬头", amount: 20, folioId: folioD, operator: "验收脚本" }));
check("前置：开出正常票 D（用于验证 UNIQUE 错误翻译）", "ok" in invD && invD.ok === true, JSON.stringify(invD));

if ("ok" in invD) {
  /*
   * 单线程 Node 里没法在「lib 查完 → lib 插入」之间插进另一个请求，所以用临时触发器
   * 复现 SQLite 的原始错误文案，让 lib 的 catch 翻译分支真实执行一次：
   * 页面绝不能收到 `UNIQUE constraint failed: invoices.hotel_id, invoices.red_of`。
   */
  db.exec(`
    CREATE TRIGGER tmp_red_guard
    BEFORE INSERT ON invoices
    WHEN NEW.red_of IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'UNIQUE constraint failed: invoices.hotel_id, invoices.red_of');
    END;
  `);
  try {
    const guarded = safe(() => redFlushInvoice(1, invD.id, { operator: "验收脚本", remark: "错误翻译验收" }));
    check(
      "① UNIQUE（red_of）错误被翻译成「已红冲」，页面看不到原始 SQLite 文案",
      "error" in guarded && /已红冲/.test(guarded.error) && !/UNIQUE constraint failed/i.test(guarded.error),
      JSON.stringify(guarded)
    );
    check(
      "② 被拒后原票状态没有被改成 RED（SAVEPOINT 已回滚）",
      one(`SELECT status FROM invoices WHERE id = ?`, [invD.id])?.status === "ISSUED",
      String(one(`SELECT status FROM invoices WHERE id = ?`, [invD.id])?.status)
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS tmp_red_guard");
  }
  check("③ 触发器已清理，正常路径恢复", all(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='tmp_red_guard'`).length === 0);

  /* --- 红冲原因：lib 层长度上限（服务端校验的另一半） --- */
  const tooLong = safe(() => redFlushInvoice(1, invD.id, { operator: "验收脚本", remark: "长".repeat(201) }));
  check(
    "④ lib 层拒绝超长红冲原因（服务端校验，脚本 / 小程序直调也拦得住）",
    "error" in tooLong && /红冲原因过长/.test(tooLong.error),
    JSON.stringify(tooLong)
  );

  /* --- 红冲原因：真实 action 路径（未填写 / 全空格都必须被拒） --- */
  const admin = one(`SELECT id, username, real_name, role, hotel_id FROM users WHERE hotel_id = 1 AND role = 'admin' ORDER BY id LIMIT 1`);
  const sid = `test-redflush-admin-${STAMP}`;
  const expires = new Date(Date.now() + 3600 * 1000).toISOString();
  run(`INSERT OR REPLACE INTO sessions (id, user_json, created_at, expires_at) VALUES (?,?,?,?)`, [
    sid,
    JSON.stringify({
      id: admin?.id ?? 1,
      username: admin?.username ?? "admin",
      realName: admin?.real_name ?? "验收管理员",
      role: "admin",
      hotelId: 1,
      hotelName: "验收酒店",
    }),
    NOW,
    expires,
  ]);
  stub.setSid(sid);

  const invokeAction = async (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
    try {
      await actions.redFlushInvoiceAction(fd);
      return { kind: "returned" };
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (msg.startsWith("NEXT_REDIRECT:")) {
        const url = msg.slice("NEXT_REDIRECT:".length);
        const q = new URL(url, "http://localhost").searchParams;
        return { kind: q.get("err") ? "err" : "ok", message: q.get("err") || q.get("ok") || "", url };
      }
      return { kind: "threw", message: msg };
    }
  };

  const noReason = await invokeAction({ invoice_id: invD.id });
  check(
    "⑤ 真实 action：不传红冲原因被服务端拒绝（前端 requireReason 可绕过）",
    noReason.kind === "err" && noReason.message.includes("请填写红冲原因"),
    JSON.stringify(noReason)
  );
  const blankReason = await invokeAction({ invoice_id: invD.id, reason: "   " });
  check(
    "⑥ 真实 action：全空格原因同样被拒",
    blankReason.kind === "err" && blankReason.message.includes("请填写红冲原因"),
    JSON.stringify(blankReason)
  );
  check(
    "⑦ 原因校验失败没有副作用（原票仍 ISSUED、没有负数票）",
    one(`SELECT status FROM invoices WHERE id = ?`, [invD.id])?.status === "ISSUED" && redChildren(invD.id).length === 0,
    `status=${one(`SELECT status FROM invoices WHERE id = ?`, [invD.id])?.status} red=${redChildren(invD.id).length}`
  );

  const validReason = await invokeAction({ invoice_id: invD.id, reason: "客人退票，红冲原票（并发验收）" });
  check("⑧ 真实 action：带原因正常红冲成功（权限与原因校验都满足时放行）", validReason.kind === "ok", JSON.stringify(validReason));
  check(
    "⑨ 正常红冲后原票状态 = RED、负数票 1 张",
    one(`SELECT status FROM invoices WHERE id = ?`, [invD.id])?.status === "RED" && redChildren(invD.id).length === 1,
    `status=${one(`SELECT status FROM invoices WHERE id = ?`, [invD.id])?.status} red=${redChildren(invD.id).length}`
  );
  stub.setSid(null);
}

/* ============================================================ 七、真库零写入 */

console.log("\n=== 七、真库零写入 ===");
{
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    const leakedInv = Number(real.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE invoice_no LIKE ?`).get(`${PREFIX}%`).c);
    const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
    const leakedSession = Number(real.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id LIKE ?`).get(`test-redflush-%`).c);
    check("真库没有测试发票", leakedInv === 0, `实际 ${leakedInv}`);
    check("真库没有被写入 999 号测试酒店", leakedHotel === 0, `实际 ${leakedHotel}`);
    check("真库没有测试会话行", leakedSession === 0, `实际 ${leakedSession}`);
  } finally {
    real.close();
  }
}

try {
  db.close();
} catch {
  /* 已关闭 */
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
