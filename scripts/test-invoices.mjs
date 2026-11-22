/**
 * 发票台账验收（整改清单 P2-3：发票建台账 / 开票校验 / 红冲）
 *
 * 这份脚本分三层：
 *   1. 静态校验：service 是否按约定导出、收银台 invoiceAction 是否已改成调 issueInvoice、
 *      /invoices 页面与动作是否存在、session 的角色模块是否放行、迁移脚本是否包含建表与索引；
 *   2. 数据校验：真实库里的 invoices 表结构 / 索引 / 迁移幂等（--check 已是目标状态）；
 *   3. 行为校验：**直接导入 src/lib/invoice.ts 的真实实现**（Node 24 原生剥离 TS 类型 +
 *      registerHooks 解析 `@/` 别名），在事务里造一张测试账单实测：
 *        未结账不能开票 / 超开被拒 / 分次开票合计不超总额 / 红冲生成负数票且原票状态变更 /
 *        红冲后额度还回可重新开票 / 发票号唯一 / 跨酒店隔离 / 统计口径。
 *      测完 ROLLBACK，不污染业务数据。
 *
 * 用法：node scripts/test-invoices.mjs
 * 前置：node scripts/migrate-all.mjs 已经跑过（脚本会检查；即使没跑，service 也会懒建表兜底）
 * 运行环境：Node ≥ 22.18（原生剥离 TS 类型）且支持 module.registerHooks（≥ 22.15）；
 *           本机 Node 24.22.3 已验证通过。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { resolveDbPath, runMigrations } from "./migrate-all.mjs";

const ROOT = process.cwd();
const DB = resolveDbPath();

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

const readSrc = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Node 在 .ts 上会提示「package.json 没有 type: module」，属于噪音，过滤掉 */
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* 让 Node 能解析 Next 的 `@/` 路径别名（指向项目 src 目录），
 * 这样验收脚本测的是真实 service，而不是在脚本里再抄一份校验逻辑 */
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

console.log("=== 一、静态校验 ===");

const invoiceSrc = readSrc("src/lib/invoice.ts");
const migrateSrc = readSrc("scripts/migrate-all.mjs");
const sessionSrc = readSrc("src/lib/session.ts");
const cashierActionsSrc = readSrc("src/app/(main)/cashier/actions.ts");
const cashierPanelSrc = readSrc("src/components/CashierPanel.tsx");
const pageSrc = readSrc("src/app/(main)/invoices/page.tsx");
const pageActionsSrc = readSrc("src/app/(main)/invoices/actions.ts");

/* --- 1.1 service 文件与导出 --- */
check("src/lib/invoice.ts 存在", invoiceSrc.length > 0);
for (const fn of ["issueInvoice", "redFlushInvoice", "listInvoices", "invoiceStats"]) {
  check(`invoice.ts 导出 ${fn}`, new RegExp(`export function ${fn}\\s*\\(`).test(invoiceSrc));
}
for (const t of ["InvoiceIssueInput", "InvoiceResult", "InvoiceRow"]) {
  check(`invoice.ts 导出类型 ${t}`, new RegExp(`export type ${t}\\b`).test(invoiceSrc));
}

/* --- 1.2 校验逻辑确实在 service 里（防止有人为了「测试通过」把校验删掉） --- */
check("开票校验：账单状态必须 SETTLED", /status\s*!==\s*"SETTLED"/.test(invoiceSrc));
check("开票校验：比对账单 total_amount", /total_amount/.test(invoiceSrc));
check("开票校验：已开票净额按 SUM(amount) 计算", /SUM\(amount\)/.test(invoiceSrc));
check("红冲校验：必须引用原票 red_of", /red_of/.test(invoiceSrc));
check("红冲：生成负数金额", /round2\(-amount\)/.test(invoiceSrc));
check("红冲：原票状态置 RED", /SET status = 'RED'/.test(invoiceSrc));

/* --- 1.3 迁移脚本建表 / 索引 --- */
check("migrate-all.mjs 含 invoices 建表段", /CREATE TABLE IF NOT EXISTS invoices/.test(migrateSrc));
const invDdlStart = migrateSrc.indexOf("CREATE TABLE IF NOT EXISTS invoices");
const invDdl = invDdlStart >= 0 ? migrateSrc.slice(invDdlStart, invDdlStart + 1200) : "";
const invCols = [
  "id",
  "hotel_id",
  "invoice_no",
  "invoice_type",
  "title",
  "tax_no",
  "amount",
  "folio_id",
  "folio_no",
  "stay_id",
  "guest_name",
  "room_no",
  "biz_date",
  "operator",
  "remark",
  "red_of",
  "status",
  "created_at",
];
const missingCols = invCols.filter((c) => !new RegExp(`\\b${c}\\b`).test(invDdl));
check("迁移 DDL 字段齐全（18 列）", missingCols.length === 0, `缺 ${missingCols.join(",")}`);
check(
  "迁移脚本建 idx_invoices_folio（账单维度，撑住额度校验）",
  /idx_invoices_folio/.test(migrateSrc)
);
check("迁移脚本建 idx_invoices_bizdate（营业日维度）", /idx_invoices_bizdate/.test(migrateSrc));
check(
  "迁移脚本建唯一索引 idx_invoices_no（同酒店发票号唯一、空串豁免）",
  /CREATE UNIQUE INDEX idx_invoices_no ON invoices\(hotel_id, invoice_no\) WHERE invoice_no <> ''/.test(migrateSrc)
);
check(
  "迁移脚本用 hasTable()/addIndex() 辅助（可重复执行）",
  /if \(!hasTable\("invoices"\)\)/.test(migrateSrc) && /addIndex\(\s*"idx_invoices_no"/.test(migrateSrc)
);

/* --- 1.4 收银台接入 --- */
check("cashier/actions.ts 引入 @/lib/invoice", /from "@\/lib\/invoice"/.test(cashierActionsSrc));
check("cashier/actions.ts 的发票动作调用 issueInvoice", /issueInvoice\(\{/.test(cashierActionsSrc));
check("cashier/actions.ts 不再只写日志（保留 op_logs 同时返回台账票号）", /result\.invoiceNo/.test(cashierActionsSrc));
check(
  "收银台动作名仍是 invoiceAction（CashierPanel 的 import 不变）",
  /export async function invoiceAction\(/.test(cashierActionsSrc) && /invoiceAction/.test(cashierPanelSrc)
);
check("旧日志「开发票」仍保留（收银台已开票汇总靠它）", /"开发票"/.test(cashierActionsSrc) && /writeLog\(/.test(cashierActionsSrc));

/* --- 1.5 页面与动作 --- */
check("src/app/(main)/invoices/page.tsx 存在", pageSrc.length > 0);
check("台账页是 force-dynamic（每次查最新台账）", /export const dynamic = "force-dynamic"/.test(pageSrc));
check("台账页展示统计（已开 / 红冲 / 净额）", /invoiceStats\(/.test(pageSrc) && /净开票额/.test(pageSrc));
check("台账页用 listInvoices 查询", /listInvoices\(/.test(pageSrc));
check("台账页红冲用 ConfirmForm 二次确认", /ConfirmForm/.test(pageSrc) && /确认红冲/.test(pageSrc));
check("台账页只有 NORMAL + ISSUED 可红冲", /canRedFlush/.test(pageSrc) && /invoice_type === "NORMAL"/.test(pageSrc));
check("src/app/(main)/invoices/actions.ts 存在", pageActionsSrc.length > 0);
check(
  "红冲动作调 redFlushInvoice 并写操作日志",
  /redFlushInvoice\(/.test(pageActionsSrc) && /"红冲发票"/.test(pageActionsSrc) && /requireUser\(\)/.test(pageActionsSrc)
);

/* --- 1.6 权限：cashier 放行 /invoices（admin 是通配） --- */
const cashierBlock = /cashier:\s*\[([\s\S]*?)\]/.exec(sessionSrc)?.[1] ?? "";
check("ROLE_MODULES.cashier 包含 /invoices", cashierBlock.includes('"/invoices"'));
check("ROLE_MODULES.admin 仍是通配 *", /admin:\s*"\*"/.test(sessionSrc));

console.log("\n=== 二、数据校验（表结构 / 迁移幂等） ===");

const db = new DatabaseSync(DB);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const tableExists = (name) => all(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]).length > 0;
const indexNames = () => all(`SELECT name FROM sqlite_master WHERE type='index'`).map((r) => r.name);
const cols = (t) => {
  try {
    return all(`PRAGMA table_info(${t})`);
  } catch {
    return [];
  }
};

check("invoices 表存在", tableExists("invoices"));
const liveCols = cols("invoices");
const missingLive = invCols.filter((c) => !liveCols.some((x) => x.name === c));
check("invoices 表字段齐全", missingLive.length === 0, `缺 ${missingLive.join(",")}`);

const typeCol = liveCols.find((c) => c.name === "invoice_type");
const statusCol = liveCols.find((c) => c.name === "status");
check("invoice_type 默认 'NORMAL'", String(typeCol?.dflt_value ?? "").includes("NORMAL"));
check("status 默认 'ISSUED'", String(statusCol?.dflt_value ?? "").includes("ISSUED"));

const idx = indexNames();
for (const name of ["idx_invoices_folio", "idx_invoices_bizdate", "idx_invoices_no"]) {
  check(`索引 ${name} 存在`, idx.includes(name));
}
const noIdxSql = all(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_invoices_no'`)[0]?.sql ?? "";
check(
  "idx_invoices_no 是 UNIQUE 且只约束非空发票号",
  /UNIQUE/i.test(noIdxSql) && /WHERE\s+invoice_no\s*<>\s*''/i.test(noIdxSql)
);

/* 迁移幂等：本项负责的条目不应再有「待处理」 */
const migrated = runMigrations(db, { checkOnly: true });
const pendingInv = migrated.applied.filter((x) => /invoices|idx_invoices/.test(x));
check("migrate-all --check 无 invoices 待迁移项", pendingInv.length === 0, pendingInv.join(", "));

/* CLI 输出自检：要求打印「已是目标状态」 */
try {
  const out = execFileSync(process.execPath, ["scripts/migrate-all.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  check("`node scripts/migrate-all.mjs --check` 输出「已是目标状态」", /已是目标状态/.test(out));
} catch (e) {
  check("`node scripts/migrate-all.mjs --check` 输出「已是目标状态」", false, String(e?.message ?? e));
}

db.close();

console.log("\n=== 三、行为校验（真实 service 调用 + 事务回滚） ===");

const { issueInvoice, redFlushInvoice, listInvoices, invoiceStats, getFolioInvoiced } = await import(
  "../src/lib/invoice.ts"
);
const { getDb } = await import("../src/lib/db.ts");
const { bizToday } = await import("../src/lib/biz-date.ts");

/** 包一层：业务函数理论上不抛异常，真的抛了也记成失败而不是让脚本崩掉 */
const safe = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { error: `异常：${e?.message ?? e}` };
  }
};

const d = getDb();
const hotelRow = d.prepare("SELECT id FROM hotels ORDER BY id LIMIT 1").get();
const hotelId = Number(hotelRow?.id ?? 0);
check("存在酒店数据（行为测试前置）", hotelId > 0);

if (hotelId > 0) {
  const bizDate = bizToday(hotelId);
  const base = invoiceStats(hotelId, bizDate, bizDate);

  /* 测试用账单：总额 300，先 OPEN 后 SETTLED */
  const folioNo = `TEST-INV-${Date.now()}`;
  d.exec("BEGIN");
  try {
    const folioRes = d
      .prepare(
        `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(hotelId, folioNo, null, "发票测试客人", "9999", 300, 300, 0, "OPEN", new Date().toISOString());
    const folioId = Number(folioRes.lastInsertRowid);

    /* --- 3.1 未结账不能开票 --- */
    const rOpen = safe(() => issueInvoice({ hotelId, title: "发票测试抬头", amount: 100, folioId }));
    check(
      "未结账（OPEN）不能开票",
      "error" in rOpen && /未结账/.test(rOpen.error),
      JSON.stringify(rOpen)
    );
    check("未结账被拒后台账里没有新增", safe(() => listInvoices(hotelId, { folioId })).length === 0);

    /* --- 3.2 已结账可分次开票，超额被拒 --- */
    d.prepare("UPDATE folios SET status = 'SETTLED' WHERE id = ?").run(folioId);

    const r1 = safe(() => issueInvoice({ hotelId, title: "发票测试抬头", amount: 150, folioId, operator: "验收脚本" }));
    check("已结账可分次开票（第一张 150）", "ok" in r1 && r1.ok === true, JSON.stringify(r1));
    check(
      "自动生成发票号 INV-yyyymmdd-序号",
      "ok" in r1 && /^INV-\d{8}-\d{3,}$/.test(r1.invoiceNo),
      "error" in r1 ? r1.error : r1.invoiceNo
    );

    const rOver = safe(() => issueInvoice({ hotelId, title: "发票测试抬头", amount: 151, folioId }));
    check(
      "超开被拒（151 > 可开余额 150）",
      "error" in rOver && /超过账单可开余额/.test(rOver.error),
      JSON.stringify(rOver)
    );

    const r2 = safe(() => issueInvoice({ hotelId, title: "发票测试抬头", amount: 150, folioId, operator: "验收脚本" }));
    check("分次开票第二张 150（合计 300 = 账单总额）", "ok" in r2 && r2.ok === true, JSON.stringify(r2));
    check("两张发票号不同（同酒店唯一）", "ok" in r1 && "ok" in r2 && r1.invoiceNo !== r2.invoiceNo);
    check("账单已开票净额 = 300", round2(getFolioInvoiced(hotelId, folioId)) === 300);

    const rFull = safe(() => issueInvoice({ hotelId, title: "发票测试抬头", amount: 0.01, folioId }));
    check(
      "已开满后再开被拒（合计不能超总额）",
      "error" in rFull && /已开满/.test(rFull.error),
      JSON.stringify(rFull)
    );

    /* --- 3.3 其它入参校验 --- */
    const rNoTitle = safe(() => issueInvoice({ hotelId, title: "", amount: 10, folioId }));
    check("抬头为空被拒", "error" in rNoTitle && /请填写发票抬头/.test(rNoTitle.error));
    const rZero = safe(() => issueInvoice({ hotelId, title: "发票测试抬头", amount: 0, folioId }));
    check("金额 <= 0 被拒", "error" in rZero && /开票金额必须大于 0/.test(rZero.error));
    const rOtherHotel = safe(() =>
      issueInvoice({ hotelId: hotelId + 1, title: "发票测试抬头", amount: 10, folioId })
    );
    check(
      "账单跨酒店开票被拒（归属校验）",
      "error" in rOtherHotel && /不存在或不属于当前酒店/.test(rOtherHotel.error),
      JSON.stringify(rOtherHotel)
    );
    const rDupNo = safe(() =>
      issueInvoice({ hotelId, title: "发票测试抬头", amount: 10, invoiceNo: "ok" in r1 ? r1.invoiceNo : "DUP" })
    );
    check("重复发票号被拒", "error" in rDupNo && /已存在/.test(rDupNo.error), JSON.stringify(rDupNo));

    /* --- 3.4 红冲：负数票 + 原票状态变更 --- */
    if ("ok" in r1 && "ok" in r2) {
      const before = invoiceStats(hotelId, bizDate, bizDate);
      check(
        "红冲前统计：本次已开票增量 300 / 红冲 0",
        round2(before.issued - base.issued) === 300 && round2(before.red - base.red) === 0,
        JSON.stringify({ before, base })
      );

      const rf = safe(() =>
        redFlushInvoice(hotelId, r1.id, { operator: "验收脚本", remark: "验收脚本红冲" })
      );
      check("红冲成功", "ok" in rf && rf.ok === true, JSON.stringify(rf));
      check(
        "红冲票号 RED-yyyymmdd-序号",
        "ok" in rf && /^RED-\d{8}-\d{3,}$/.test(rf.invoiceNo),
        "error" in rf ? rf.error : rf.invoiceNo
      );

      if ("ok" in rf) {
        const redRow = d.prepare("SELECT * FROM invoices WHERE id = ?").get(rf.id);
        const srcRow = d.prepare("SELECT * FROM invoices WHERE id = ?").get(r1.id);
        check(
          "红冲生成负数记录（type=RED / amount=-150 / red_of=原票）",
          redRow?.invoice_type === "RED" &&
            round2(Number(redRow?.amount)) === -150 &&
            Number(redRow?.red_of) === r1.id,
          JSON.stringify(redRow)
        );
        check("原票状态由 ISSUED 改为 RED", srcRow?.status === "RED", JSON.stringify(srcRow));
        check(
          "红冲后账单净开票额回到 150（额度还回）",
          round2(getFolioInvoiced(hotelId, folioId)) === 150,
          String(getFolioInvoiced(hotelId, folioId))
        );

        /* 红冲本身也要防重复 */
        const rfAgain = safe(() => redFlushInvoice(hotelId, r1.id, {}));
        check("同一张票不能重复红冲", "error" in rfAgain && /已红冲/.test(rfAgain.error), JSON.stringify(rfAgain));
        const rfRed = safe(() => redFlushInvoice(hotelId, rf.id, {}));
        check(
          "红冲票不能再红冲",
          "error" in rfRed && /红冲发票不能再红冲/.test(rfRed.error),
          JSON.stringify(rfRed)
        );

        /* --- 3.5 红冲后重新开票（额度算回去） --- */
        const r3 = safe(() =>
          issueInvoice({ hotelId, title: "发票测试抬头", amount: 150, folioId, operator: "验收脚本" })
        );
        check("红冲后可重新开票 150", "ok" in r3 && r3.ok === true, JSON.stringify(r3));
        check("重新开票后净额回到 300", round2(getFolioInvoiced(hotelId, folioId)) === 300);

        /* --- 3.6 台账查询 --- */
        const list = safe(() => listInvoices(hotelId, { folioId }));
        check("listInvoices 按账单过滤返回 4 条（正常 3 + 红冲 1）", list.length === 4, `实际 ${list.length}`);
        check(
          "listInvoices 按营业日倒序（最新在最前）",
          list[0]?.id === ("ok" in r3 ? r3.id : -1),
          JSON.stringify(list.map((r) => r.id))
        );
        const redOnly = safe(() => listInvoices(hotelId, { folioId, status: "RED" }));
        check(
          "listInvoices status=RED 只返回被红冲的原票",
          redOnly.length === 1 && redOnly[0].id === r1.id,
          JSON.stringify(redOnly.map((r) => r.id))
        );
        check(
          "台账行包含负数红冲金额",
          list.some((r) => r.invoice_type === "RED" && round2(r.amount) === -150)
        );

        /* --- 3.7 统计口径 --- */
        const stats = invoiceStats(hotelId, bizDate, bizDate);
        check(
          "统计口径：已开票 +450 / 红冲 150 / 净额 +300（本次增量）",
          round2(stats.issued - base.issued) === 450 &&
            round2(stats.red - base.red) === 150 &&
            round2(stats.net - base.net) === 300,
          JSON.stringify({ stats, base })
        );
        const outOfRange = invoiceStats(hotelId, "1999-01-01", "1999-01-02");
        check("统计按营业日区间过滤（区间外为 0）", outOfRange.issued === 0 && outOfRange.red === 0);
      }
    }
  } catch (e) {
    check("行为测试执行未抛异常", false, String(e?.message ?? e));
  } finally {
    d.exec("ROLLBACK");
  }

  /* --- 3.8 回滚后不污染业务库 --- */
  const residueInv = d.prepare("SELECT COUNT(*) AS c FROM invoices WHERE folio_no = ?").get(folioNo)?.c ?? 0;
  const residueFolio = d.prepare("SELECT COUNT(*) AS c FROM folios WHERE folio_no = ?").get(folioNo)?.c ?? 0;
  check("实测数据已随事务回滚（发票不残留）", Number(residueInv) === 0, `残留 ${residueInv}`);
  check("实测数据已随事务回滚（账单不残留）", Number(residueFolio) === 0, `残留 ${residueFolio}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
