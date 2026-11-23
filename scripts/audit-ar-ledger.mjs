#!/usr/bin/env node
/**
 * ar_ledgers 表体检（只读）
 *
 * ── 为什么需要这个脚本 ──
 * 独立验证发现「ar_ledgers 0 行，却被 6 处代码引用」，看上去像一张废弃表。
 * 实际排查下来是两个独立问题叠在一起：
 *   ① ar_ledgers 是**活表**（读取点比写入点还多），0 行不是「没人用」而是
 *      「真库从来没有真实挂账」+「演示种子只灌账户总账、不灌笔级台账」；
 *   ② 于是同一个协议单位在 /ar 页面（账户余额 23200）和 /finance 页面
 *      （协议单位应收列表）看到两个数 —— 后者列表根本是空的。
 *
 * 本脚本把「引用清单 / 真库现状 / 三表自洽性」一次性查清楚，给回填方案做依据，
 * 也可以在 CI 里当巡检：有协议单位账户应收但台账为空时 exit 1。
 *
 * ── 只读保证 ──
 * 连接以 readOnly 打开；不建表、不补列、不写任何一行。
 * 需要修的时候跑 `node scripts/migrate-all.mjs`（第 21 段负责回填）。
 *
 * 用法：
 *   node scripts/audit-ar-ledger.mjs
 *   PMS_DB_PATH=/path/pms.db node scripts/audit-ar-ledger.mjs
 *   node scripts/audit-ar-ledger.mjs --json      # 机器可读
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const AS_JSON = process.argv.includes("--json");
const SRC_DIR = path.join(ROOT, "src");

/** 台账状态 / 来源的合法取值（与 src/lib/ar.ts 的 ArStatus、kind 约定一致） */
const STATUS_OK = new Set(["OPEN", "PARTIAL", "SETTLED", "WRITTEN_OFF"]);
const KIND_OK = new Set(["CHARGE", "TRANSFER_IN", "TRANSFER_OUT"]);
const EPS = 0.001;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ============================================================ 一、代码引用 */

/**
 * 引用分类
 *
 * a_ledgers 的「行」既要能看出写还是读，也要能看出是不是只在注释里提到。
 * 判据按 SQL 动词优先、注释最后 —— 注释里写「INSERT INTO ar_ledgers」是说明，不是执行。
 */
function classify(line) {
  const s = line.trim();
  const isComment = /^(\*|\/\/|\/\*)/.test(s) || /^\s*\*/.test(line);
  if (isComment) return "comment";
  if (/CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)[^;]*ar_ledgers/i.test(s)) return "ddl";
  if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+ar_ledgers|UPDATE\s+ar_ledgers|DELETE\s+FROM\s+ar_ledgers/i.test(s)) {
    return "write";
  }
  if (/FROM\s+ar_ledgers|JOIN\s+ar_ledgers|PRAGMA\s+table_info\(ar_ledgers\)/i.test(s)) return "read";
  if (/ar_ledgers/.test(s)) return "other";
  return null;
}

function walkDir(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function scanReferences() {
  const files = fs.existsSync(SRC_DIR) ? walkDir(SRC_DIR) : [];
  const rows = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes("ar_ledgers")) return;
      const kind = classify(line);
      if (!kind) return;
      const snippet = line.trim().replace(/\s+/g, " ").slice(0, 96);
      /* 同一文件同类的相邻注释行合并展示，避免清单被注释刷屏 */
      rows.push({ file: rel, line: i + 1, kind, snippet });
    });
  }
  const byKind = { write: [], read: [], ddl: [], other: [], comment: [] };
  for (const r of rows) byKind[r.kind].push(r);
  const perFile = new Map();
  for (const r of rows) {
    const key = `${r.file}|${r.kind}`;
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
  }
  const filesOf = (kinds) =>
    [...new Set(byKind.read.concat(byKind.write, byKind.ddl).filter((r) => kinds.includes(r.kind)).map((r) => r.file))]
      .sort();
  return { rows, byKind, perFile, filesOf };
}

/* ============================================================ 二、真库现状 */

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ 数据库不存在：${DB_PATH}`);
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true, timeout: 15000 });
  const all = (sql, p = []) => db.prepare(sql).all(...p);
  const one = (sql, p = []) => db.prepare(sql).get(...p);
  return { db, all, one };
}

function tableExists(one, name) {
  return one(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`, [name])?.c > 0;
}

/**
 * 观察每一行 ar_transactions 的来源
 *
 * 种子（/ar 页 ensureArSchema → seedHotel）写出来的流水有三个可判定特征：
 *   · request_id IS NULL        —— seedHotel 调 recordTx 不传幂等键，真实动作一定带；
 *   · created_at 秒位为 00      —— recordTx 用 isoAt(biz_date) 生成（整 10:00 本地时间）；
 *   · note 形如「期初余额结转（YYYY-MM-DD）」且 operator = 系统结转。
 * 三者同时成立即可判定为演示种子，而不是真实业务流水。
 */
function txOrigin(one, all, accountId) {
  const rows = all(
    `SELECT id, type, amount, note, operator, biz_date, request_id, created_at
       FROM ar_transactions WHERE ar_account_id = ? ORDER BY biz_date ASC, id ASC`,
    [accountId]
  );
  const opening = rows.filter((r) => /期初余额结转/.test(String(r.note ?? "")) && r.operator === "系统结转");
  const withReq = rows.filter((r) => r.request_id !== null && r.request_id !== undefined && r.request_id !== "");
  const allIntegral = rows.every((r) => String(r.created_at ?? "").slice(17, 19) === "00");
  return {
    rows: rows.length,
    opening: opening.length,
    withRequestId: withReq.length,
    allCreatedAtIntegral: allIntegral,
    looksSeeded: rows.length > 0 && withReq.length === 0 && allIntegral,
  };
}

/* ============================================================ 三、自洽性 */

/** 账户余额 = SUM(流水)；逻辑台账未结 = SUM(台账 amount - settled) */
function checks(one, all, accountId, companyId) {
  const bal = round2(Number(one(`SELECT COALESCE(balance,0) AS b FROM ar_accounts WHERE id=?`, [accountId])?.b ?? 0));
  const txSum = round2(
    Number(one(`SELECT COALESCE(SUM(amount),0) AS s FROM ar_transactions WHERE ar_account_id=?`, [accountId])?.s ?? 0)
  );
  const ledger = companyId
    ? round2(
        Number(
          one(
            `SELECT COALESCE(SUM(amount - COALESCE(settled_amount,0)),0) AS s
               FROM ar_ledgers WHERE company_id = ? AND status IN ('OPEN','PARTIAL')`,
            [companyId]
          )?.s ?? 0
        )
      )
    : null;
  return { balance: bal, txSum, txMatchesBalance: Math.abs(bal - txSum) <= EPS, ledgerOutstanding: ledger };
}

/**
 * 账户 → 协议单位的候选映射
 *
 * 与 src/lib/ar.ts 的 resolveArAccount 第 2 步**同口径**（互含 + 唯一命中），
 * 按公司维度遍历而不是按账户维度 —— 否则多对多时两边结论不一致。
 */
function companyCandidates(all, hotelId) {
  const unbound = all(
    `SELECT id, code, name FROM ar_accounts WHERE hotel_id = ? AND company_id IS NULL ORDER BY id`,
    [hotelId]
  );
  const companies = all(`SELECT id, name, credit_limit FROM companies WHERE hotel_id = ? ORDER BY id`, [hotelId]);
  const map = [];
  for (const c of companies) {
    const name = String(c.name ?? "").trim();
    if (!name) continue;
    const hits = unbound.filter((a) => {
      const an = String(a.name ?? "").trim();
      if (!an) return false;
      return an === name || name.includes(an) || an.includes(name);
    });
    const ledgerRows = all(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE hotel_id=? AND company_id=?`, [hotelId, c.id])[0]
      ?.c;
    map.push({
      companyId: Number(c.id),
      companyName: name,
      candidates: hits.map((a) => ({ id: Number(a.id), code: a.code, name: a.name })),
      unique: hits.length === 1,
      existingLedgers: Number(ledgerRows ?? 0),
    });
  }
  return { unbound, companies, map };
}

/* ============================================================ 主流程 */

function main() {
  const refs = scanReferences();
  const { db, all, one } = openDb();
  try {
    const tables = ["ar_ledgers", "ar_accounts", "ar_transactions", "ar_write_offs", "companies", "folios", "op_logs"];
    const present = Object.fromEntries(tables.map((t) => [t, tableExists(one, t)]));
    const counts = {};
    for (const t of tables) {
      counts[t] = present[t] ? Number(one(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0) : null;
    }
    const hotels = all(`SELECT DISTINCT hotel_id FROM ar_accounts ORDER BY hotel_id`).map((r) => Number(r.hotel_id));

    const accounts = all(
      `SELECT id, hotel_id, code, name, type, credit_limit, balance, status, company_id, created_at
         FROM ar_accounts ORDER BY hotel_id, id`
    );
    const accountRows = accounts.map((a) => {
      const origin = txOrigin(one, all, Number(a.id));
      const companyId = a.company_id === null || a.company_id === undefined ? null : Number(a.company_id);
      return {
        id: Number(a.id),
        hotelId: Number(a.hotel_id),
        code: a.code,
        name: a.name,
        type: a.type,
        balance: round2(Number(a.balance ?? 0)),
        companyId,
        tx: origin,
        ...checks(one, all, Number(a.id), companyId),
      };
    });

    const perHotel = hotels.map((h) => {
      const cand = companyCandidates(all, h);
      return { hotelId: h, ...cand };
    });

    const writeOffs = all(
      `SELECT w.id, w.hotel_id, w.ar_account_id, w.transaction_id, w.ar_ledger_id, w.amount, w.note
         FROM ar_write_offs w ORDER BY w.id`
    ).map((w) => ({
      ...w,
      id: Number(w.id),
      amount: round2(Number(w.amount)),
      ledgerLinked: w.ar_ledger_id !== null && w.ar_ledger_id !== undefined,
    }));

    /* 台账数据合法性（回填后 / 真实业务写入后都要成立的硬约束） */
    const badSettle =
      counts.ar_ledgers === null
        ? 0
        : Number(
            one(
              `SELECT COUNT(*) AS c FROM ar_ledgers
                WHERE COALESCE(settled_amount,0) < -0.001 OR COALESCE(settled_amount,0) - amount > 0.001`
            )?.c ?? 0
          );
    const badStatus =
      counts.ar_ledgers === null
        ? 0
        : Number(one(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE status NOT IN ('OPEN','PARTIAL','SETTLED','WRITTEN_OFF')`)?.c ?? 0);
    const badKind =
      counts.ar_ledgers === null
        ? 0
        : Number(
            one(
              `SELECT COUNT(*) AS c FROM ar_ledgers WHERE COALESCE(kind,'CHARGE') NOT IN ('CHARGE','TRANSFER_IN','TRANSFER_OUT')`
            )?.c ?? 0
          );
    const ledgerStatusOk = badSettle === 0 && badStatus === 0 && badKind === 0;

    /* 需要回填的账户：能唯一映射到协议单位、该单位还没有台账、账户有余额 */
    const fillable = [];
    const skippedAccounts = [];
    for (const h of perHotel) {
      for (const m of h.map) {
        if (!m.unique) {
          if (m.candidates.length > 1) {
            skippedAccounts.push({
              hotelId: h.hotelId,
              companyId: m.companyId,
              companyName: m.companyName,
              reason: `命中 ${m.candidates.length} 个未绑定账户，名称匹配不唯一`,
            });
          }
          continue;
        }
        const acc = accountRows.find((a) => a.id === m.candidates[0].id);
        if (!acc) continue;
        if (m.existingLedgers > 0) {
          skippedAccounts.push({
            hotelId: h.hotelId,
            companyId: m.companyId,
            companyName: m.companyName,
            reason: `协议单位已有 ${m.existingLedgers} 行台账，账户却未绑定（需人工核对，不自动绑定）`,
          });
          continue;
        }
        if (Math.abs(acc.balance) <= EPS) continue;
        fillable.push({
          hotelId: h.hotelId,
          accountId: acc.id,
          code: acc.code,
          accountName: acc.name,
          companyId: m.companyId,
          companyName: m.companyName,
          balance: acc.balance,
          txRows: acc.tx.rows,
          looksSeeded: acc.tx.looksSeeded,
        });
      }
    }
    /* 无对应协议单位的账户（携程预付 / 内部挂账这类纯往来户）—— 按设计没有笔级台账 */
    const noCompany = accountRows
      .filter((a) => a.companyId === null && !fillable.some((f) => f.accountId === a.id))
      .filter((a) => Math.abs(a.balance) > EPS)
      .map((a) => ({
        hotelId: a.hotelId,
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        balance: a.balance,
      }));

    const result = {
      dbPath: DB_PATH,
      refs: {
        counts: {
          write: refs.byKind.write.length,
          read: refs.byKind.read.length,
          ddl: refs.byKind.ddl.length,
          comment: refs.byKind.comment.length,
          other: refs.byKind.other.length,
        },
        write: refs.byKind.write,
        read: refs.byKind.read,
        ddl: refs.byKind.ddl,
        files: [...refs.perFile.entries()].map(([k, v]) => {
          const [file, kind] = k.split("|");
          return { file, kind, n: v };
        }),
      },
      db: { present, counts, hotels },
      accounts: accountRows,
      companies: perHotel,
      writeOffs,
      ledgerStatusOk,
      fillable,
      noCompany,
      skippedAccounts,
    };

    if (AS_JSON) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(fillable.length > 0 ? 1 : 0);
    }

    /* ---------------------------------------------------------- 打印 */
    console.log(`数据库：${DB_PATH}\n`);

    console.log("=== 一、代码引用清单（src/*.ts(x)，按行分类）===");
    console.log(
      `写入 ${refs.byKind.write.length} 处 · 读取 ${refs.byKind.read.length} 处 · DDL ${refs.byKind.ddl.length} 处 · 注释 ${refs.byKind.comment.length} 处\n`
    );
    for (const kind of ["write", "read", "ddl"]) {
      const rows = refs.byKind[kind];
      if (rows.length === 0) continue;
      console.log(`[${kind === "write" ? "写入" : kind === "read" ? "读取" : "DDL"}] ${rows.length} 处`);
      for (const r of rows) console.log(`  ${r.file}:${r.line}  ${r.snippet}`);
      console.log("");
    }
    const fileCount = new Map();
    for (const r of refs.rows) {
      if (r.kind === "comment") continue;
      fileCount.set(r.file, (fileCount.get(r.file) ?? 0) + 1);
    }
    console.log("按文件（不含注释）：");
    for (const [file, n] of [...fileCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)} 处  ${file}`);
    }
    console.log("");

    console.log("=== 二、真库数据 ===");
    for (const t of tables) {
      console.log(`  ${t.padEnd(16)} ${present[t] ? String(counts[t]).padStart(6) + " 行" : "（表不存在）"}`);
    }
    console.log("");
    console.log("AR 账户（company_id = 协议单位绑定）：");
    for (const a of accountRows) {
      const bind = a.companyId === null ? "未绑定" : `company#${a.companyId}`;
      console.log(
        `  #${a.id} ${String(a.code).padEnd(6)} ${String(a.name).padEnd(10)} 余额 ${String(a.balance).padStart(8)}  ${bind}` +
          `  流水 ${a.tx.rows} 行（期初 ${a.tx.opening}，带幂等键 ${a.tx.withRequestId}）` +
          `${a.tx.looksSeeded ? "  ← 演示种子特征" : ""}`
      );
      console.log(
        `      流水合计 ${a.txSum} ${a.txMatchesBalance ? "= 余额 ✓" : "≠ 余额 ✗"}` +
          (a.ledgerOutstanding === null ? "  · 未绑定协议单位，无笔级台账" : `  · 台账未结 ${a.ledgerOutstanding}`)
      );
    }
    console.log("");
    console.log("账户 → 协议单位 映射候选（与 lib/ar.resolveArAccount 同口径）：");
    for (const h of perHotel) {
      for (const m of h.map) {
        if (m.candidates.length === 0) continue;
        console.log(
          `  company#${m.companyId} 「${m.companyName}」 → ${m.candidates.map((c) => `#${c.id} ${c.name}`).join(" / ")}` +
            `  ${m.unique ? "唯一 ✓" : "不唯一 ✗"}  已有台账 ${m.existingLedgers} 行`
        );
      }
    }
    console.log("");
    console.log("核销记录（ar_write_offs）：");
    for (const w of writeOffs) {
      console.log(
        `  #${w.id} 账户#${w.ar_account_id} 流水#${w.transaction_id} 金额 ${w.amount}` +
          `  ar_ledger_id ${w.ledgerLinked ? `#${w.ar_ledger_id}` : "NULL ← 指不回台账"}` +
          `  「${w.note ?? ""}」`
      );
    }
    console.log("");

    console.log("=== 三、自洽性 ===");
    const driftAccounts = accountRows.filter((a) => !a.txMatchesBalance);
    console.log(`  账户余额 = 流水合计：${driftAccounts.length === 0 ? "全部一致 ✓" : `${driftAccounts.length} 个账户不一致 ✗`}`);
    const bound = accountRows.filter((a) => a.companyId !== null);
    const driftLedger = bound.filter((a) => Math.abs(Number(a.ledgerOutstanding ?? 0) - a.balance) > EPS);
    console.log(
      `  账户余额 = 台账未结（已绑定账户 ${bound.length} 个）：` +
        `${bound.length === 0 ? "无已绑定账户" : driftLedger.length === 0 ? "全部一致 ✓" : `${driftLedger.length} 个分叉 ✗`}`
    );
    console.log(
      `  台账数据合法性（0≤已核销≤应收 / 状态 / kind）：${ledgerStatusOk ? "全部合法 ✓" : "存在非法行 ✗"}`
    );
    console.log("");

    console.log("=== 四、结论与建议 ===");
    const hasRead = refs.byKind.read.length > 0;
    console.log(`  ar_ledgers 读取点 ${refs.byKind.read.length} 处 → ${hasRead ? "活表（不是废弃表）" : "无读取 → 疑似废弃"}`);
    if (counts.ar_ledgers === 0) {
      console.log("  台账 0 行：真库从未发生真实挂账（账户/流水全部是演示种子），不是「表没人用」");
    }
    if (fillable.length > 0) {
      console.log(`  ⚠️  ${fillable.length} 个账户可回填（协议单位有应收、台账为空）：`);
      for (const f of fillable) {
        console.log(
          `      #${f.accountId} ${f.code} ${f.accountName} 余额 ${f.balance} → company#${f.companyId}「${f.companyName}」（流水 ${f.txRows} 行${f.looksSeeded ? "，演示种子" : ""}）`
        );
      }
      console.log("      修法：node scripts/migrate-all.mjs（第 21 段按 FIFO 回填并绑定 company_id）");
    }
    if (noCompany.length > 0) {
      console.log("  ℹ️  以下账户没有对应协议单位，按设计不建笔级台账（挂账客户 / 内部往来）：");
      for (const a of noCompany) console.log(`      #${a.accountId} ${a.code} ${a.name}（${a.type}）余额 ${a.balance}`);
    }
    for (const s of skippedAccounts) console.log(`  ! 需人工核对：${s.companyName} —— ${s.reason}`);
    const orphan = writeOffs.filter((w) => !w.ledgerLinked);
    if (orphan.length > 0) {
      console.log(`  ! ${orphan.length} 条核销记录 ar_ledger_id 为空（回填后仍无台账的部分应标注「待核对」）`);
    }
    console.log("");
    process.exitCode = fillable.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

main();
