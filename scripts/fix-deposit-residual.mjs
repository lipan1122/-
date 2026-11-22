#!/usr/bin/env node
/**
 * 押金残留修复（第十轮 P0：退房不冲销押金 → 真库残留 6800 元）
 *
 * ── 缺陷 ──
 * `cashier/actions.ts` 的 checkoutAction 旧实现只按「应退余额」退押金：
 *     refundDue  = max(0, −balance)
 *     refundCash = min(refundDue, 押金明细)
 *     if (refundCash > 0) { 写负数收款 + 冲销明细 + 减 stays.deposit }
 * balance >= 0（客人不欠钱、或欠款已被「补收」抹平）时 refundCash = 0，
 * **整段冲销被 if 跳过** —— 客人退房走了，账上押金还挂着：
 *   · stays.deposit 不为 0 → 在住押金 / 在住列表虚高；
 *   · folio_items 的 DEPOSIT 明细不为 0 → 押金报表按明细汇总，「押金收取（区间）」虚高；
 *   · 账单已结（SETTLED）却还挂着押金负债 → 对账永远差这一块。
 * 真库实测：11 张 CHECKED_OUT 单残留押金 6800，3 张 SETTLED 账单还挂 2100。
 *
 * ── 本脚本做的事（与修复后的 checkoutAction 同一套规则）──
 *   规则：押金是担保不是收入，退房必须清零。
 *     应收 T、其它实收 R、押金明细 D 时 paid = R + D，balance = T − paid。
 *     · balance < 0（多收了钱）→ 退现金 refundCash = min(−balance, D)，
 *       写一条负数收款（kind=DEPOSIT_REFUND，refund_of 指向原押金），paid 同步减回；
 *     · balance >= 0（押金被房费吃掉 / 已被补收抹平）→ 不退现金，只做账面冲销。
 *     两种情况都把 DEPOSIT 明细清零、stays.deposit 归零。
 *
 *   A. stays.status='CHECKED_OUT' 且 stays.deposit > 0 —— 已退房押金残留
 *   B. folios.status='SETTLED' 且还挂 item_type='DEPOSIT' 明细 > 0 —— 已结账押金残留
 *   C. folios.status='SETTLED' 且 balance != 0（缺陷 3）——
 *      用统一口径 recalcFolioBalance 重算；**算完仍非 0 的只报告不动**（人工核对）
 *
 * ── 安全 / 幂等 ──
 *   · 默认 --check：只报告，一个字节都不写；
 *   · --apply：先 `VACUUM INTO data/backup/pms.db.bak-deposit-<时间戳>` 备份，再写库；
 *   · 每条修复写一条 op_logs（action='押金残留修复'），可在 /logs 页面追；
 *   · 幂等：修完 stays.deposit=0、DEPOSIT 明细=0，再跑一次 --check 应为 0 条
 *     （A/B 不再命中）；C 的「已归零」也不会再命中。
 *
 * 用法：
 *   node scripts/fix-deposit-residual.mjs              # = --check，只报告
 *   node scripts/fix-deposit-residual.mjs --check
 *   node scripts/fix-deposit-residual.mjs --apply      # 备份 + 写库
 *   node scripts/fix-deposit-residual.mjs --apply --no-settle-open   # 不顺手把已退房却仍 OPEN 的账单置 SETTLED
 *   PMS_DB_PATH=/path/to/pms.db node scripts/fix-deposit-residual.mjs --check
 *
 * 退出码：--check 有残留 → 0（只是报告）；--apply 失败 → 1。
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const BACKUP_DIR = path.join(path.dirname(DB_PATH), "backup");
const APPLY = process.argv.includes("--apply");
const SETTLE_OPEN = !process.argv.includes("--no-settle-open");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OPERATOR = "系统修复";
const LOG_ACTION = "押金残留修复";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => round2(n).toFixed(2);
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ 数据库不存在：${DB_PATH}\n  用 PMS_DB_PATH 指定，或先跑 node scripts/init-db.mjs`);
  process.exit(1);
}
console.log(`数据库：${DB_PATH}`);
console.log(`模式：${APPLY ? "APPLY（备份后写库）" : "CHECK（只报告，不写任何数据）"}\n`);

/* ============================================================ 备份 */

function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `pms.db.bak-deposit-${STAMP}`);
  if (fs.existsSync(target)) {
    console.log(`备份已存在，跳过：${target}`);
    return target;
  }
  const src = new DatabaseSync(DB_PATH, { readOnly: true, timeout: 15000 });
  try {
    src.exec(`VACUUM INTO '${target.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  console.log(`✅ 已备份：${target}（${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB）\n`);
  return target;
}

/* ============================================================ 打开库 */

const db = new DatabaseSync(DB_PATH, { timeout: 15000 });
db.exec("PRAGMA busy_timeout = 15000");
globalThis.__pmsDb = db;

/* 复用生产口径（lib/folio.ts）：重算、押金明细、押金收款识别都只认一份实现 */
const srcRoot = path.join(ROOT, "src");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = path.join(srcRoot, specifier.slice(2));
      for (const ext of ["", ".ts", "/index.ts"]) {
        const p = base + ext;
        if (fs.existsSync(p) && !p.endsWith("/")) return { url: pathToFileURL(p).href, shortCircuit: true };
      }
    }
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
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

const folioLib = await import(pathToFileURL(path.join(srcRoot, "lib", "folio.ts")).href);

const all = (sql, p = []) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (sql, p = []) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : undefined;
};
const run = (sql, p = []) => db.prepare(sql).run(...p);

const today = one(`SELECT date('now','localtime') AS d`)?.d ?? new Date().toISOString().slice(0, 10);

/* ============================================================ 分析（只读） */

/** 该账单的押金明细行（> 0.005），后收先退 */
function depositLinesOf(folioId, hotelId) {
  return all(
    `SELECT id, amount FROM folio_items
      WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT' AND COALESCE(amount, 0) > 0.005
      ORDER BY id DESC`,
    [folioId, hotelId]
  );
}

/** 押金原收款（refund_of 要指向它）：kind='DEPOSIT' 优先，旧数据按备注兜底 */
function findDepositPay(hotelId, folioId) {
  const rows = all(
    `SELECT id, method, amount, kind, remark FROM payments
      WHERE hotel_id = ? AND folio_id = ? AND amount > 0 AND (kind = 'DEPOSIT' OR kind IS NULL)
      ORDER BY id ASC`,
    [hotelId, folioId]
  );
  return rows.find((r) => folioLib.isDepositPayment({ kind: r.kind, remark: r.remark }));
}

/**
 * 单张账单的押金冲销方案（纯计算，不写库）
 *
 * refundCash = min(max(0, −balance), 押金明细 D)
 * 冲销后 paid' = paid − refundCash，balance' = total − paid'
 */
function planFolio(folio) {
  const moneyNow = folioLib.computeFolioBalance(folio.hotel_id, folio.id);
  const depositItems = round2(folioLib.depositHeld(folio.hotel_id, folio.id));
  const refundDue = moneyNow.balance < -0.01 ? round2(-moneyNow.balance) : 0;
  const refundCash = round2(Math.min(refundDue, Math.max(0, depositItems)));
  const offsetToRoom = round2(Math.max(0, depositItems) - refundCash);
  const newPaid = round2(moneyNow.paid - refundCash);
  const newBalance = round2(moneyNow.total - newPaid);
  return {
    depositItems,
    refundDue,
    refundCash,
    offsetToRoom,
    total: moneyNow.total,
    paid: moneyNow.paid,
    balance: moneyNow.balance,
    newPaid,
    newBalance,
    lines: depositLinesOf(folio.id, folio.hotel_id),
  };
}

/** 退款流水的记账日：优先客人实际离店日，其次账单结账日，最后今天 */
function refundBizDate(stay, folio) {
  if (stay && isYmd(stay.actual_check_out)) return stay.actual_check_out;
  const settled = String(folio.settled_at ?? "").slice(0, 10);
  if (isYmd(settled)) return settled;
  return today;
}

/* ---- A. 已退房押金残留 ---- */
const checkedOutStays = all(
  `SELECT s.id, s.hotel_id, s.stay_no, s.deposit, s.status, s.actual_check_out, r.room_no
     FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
    WHERE s.status = 'CHECKED_OUT' AND COALESCE(s.deposit, 0) > 0.005
    ORDER BY s.hotel_id, s.id`
);

/** 入住单下的全部账单（含拆账单 -B/-C） */
function foliosOfStay(stayId, hotelId) {
  return all(
    `SELECT id, hotel_id, folio_no, status, total_amount, paid_amount, balance, settled_at
       FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id`,
    [stayId, hotelId]
  );
}

const plans = [];
const seenFolios = new Set();

for (const stay of checkedOutStays) {
  const folios = foliosOfStay(stay.id, stay.hotel_id);
  for (const folio of folios) {
    if (seenFolios.has(folio.id)) continue;
    const plan = planFolio(folio);
    if (plan.depositItems <= 0.005) continue;
    seenFolios.add(folio.id);
    plans.push({
      kind: "folio-deposit",
      hotelId: stay.hotel_id,
      stayId: stay.id,
      stayNo: stay.stay_no,
      roomNo: stay.room_no,
      folio,
      stay,
      bizDate: refundBizDate(stay, folio),
      ...plan,
    });
  }
}

/* ---- B. 已结账账单仍挂押金明细（不依赖入住单状态） ---- */
const settledFoliosWithDeposit = all(
  `SELECT f.id, f.hotel_id, f.folio_no, f.status, f.total_amount, f.paid_amount, f.balance, f.settled_at,
          f.stay_id, s.stay_no, s.deposit AS stay_deposit, s.status AS stay_status, s.actual_check_out, r.room_no
     FROM folios f
     LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
     LEFT JOIN rooms r ON r.id = s.room_id
    WHERE f.status = 'SETTLED'
      AND EXISTS (SELECT 1 FROM folio_items i
                   WHERE i.folio_id = f.id AND i.hotel_id = f.hotel_id
                     AND i.item_type = 'DEPOSIT' AND COALESCE(i.amount, 0) > 0.005)
    ORDER BY f.hotel_id, f.id`
);

let addedB = 0;
for (const folio of settledFoliosWithDeposit) {
  if (seenFolios.has(folio.id)) continue;
  const plan = planFolio(folio);
  seenFolios.add(folio.id);
  addedB += 1;
  plans.push({
    kind: "folio-deposit",
    hotelId: folio.hotel_id,
    stayId: folio.stay_id,
    stayNo: folio.stay_no,
    roomNo: folio.room_no,
    folio,
    stay: folio.stay_id
      ? { id: folio.stay_id, status: folio.stay_status, actual_check_out: folio.actual_check_out, deposit: folio.stay_deposit }
      : null,
    bizDate: refundBizDate({ actual_check_out: folio.actual_check_out }, folio),
    ...plan,
  });
}

/* ---- A2. 只有 stays.deposit、没有押金明细的历史脏数据 ---- */
const stayOnlyPlans = [];
for (const stay of checkedOutStays) {
  const folios = foliosOfStay(stay.id, stay.hotel_id);
  const hasItems = folios.some((f) => folioLib.depositHeld(stay.hotel_id, f.id) > 0.005);
  if (hasItems) continue; /* 明细一起清零的那条 plan 已经覆盖 stays.deposit */
  stayOnlyPlans.push(stay);
}

/* ---- A3. 已退房但账单仍 OPEN（且清账后余额为 0）→ 置 SETTLED ---- */
const openFolioPlans = [];
if (SETTLE_OPEN) {
  const newBalanceByFolio = new Map(plans.map((p) => [p.folio.id, p.newBalance]));
  for (const stay of checkedOutStays) {
    for (const folio of foliosOfStay(stay.id, stay.hotel_id)) {
      if (folio.status !== "OPEN") continue;
      const post = newBalanceByFolio.has(folio.id)
        ? newBalanceByFolio.get(folio.id)
        : folioLib.computeFolioBalance(folio.hotel_id, folio.id).balance;
      if (near(post, 0)) {
        openFolioPlans.push({ stay, folio, newBalance: post });
      }
    }
  }
}

/* ---- C. 已结账但余额未归零（缺陷 3） ---- */
const newBalanceByFolio = new Map(plans.map((p) => [p.folio.id, p.newBalance]));
const settledBadBalance = all(
  `SELECT f.id, f.hotel_id, f.folio_no, f.balance, f.total_amount, f.paid_amount, f.stay_id, s.stay_no
     FROM folios f LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
    WHERE f.status = 'SETTLED' ORDER BY f.hotel_id, f.id`
)
  .map((f) => {
    const post = newBalanceByFolio.has(f.id) ? newBalanceByFolio.get(f.id) : folioLib.computeFolioBalance(f.hotel_id, f.id).balance;
    return { ...f, postBalance: post, dbBalance: round2(f.balance) };
  })
  .filter((f) => !near(f.dbBalance, 0) || !near(f.postBalance, 0));

/* ============================================================ 报告 */

const sum = (arr, key) => round2(arr.reduce((s, x) => s + Number(x[key] ?? 0), 0));

console.log("=== A. 已退房（CHECKED_OUT）押金未冲销 ===");
if (plans.length === 0 && stayOnlyPlans.length === 0) {
  console.log("  ✅ 没有残留押金\n");
} else {
  for (const p of plans) {
    console.log(
      `  stay#${p.stayId} ${p.stayNo} 房间 ${p.roomNo ?? "-"} · 账单 ${p.folio.folio_no}(${p.folio.status})` +
        ` · 押金明细 ${money(p.depositItems)} · 应收 ${money(p.total)} 已收 ${money(p.paid)} 余额 ${money(p.balance)}` +
        ` → 退现金 ${money(p.refundCash)} / 抵扣房费 ${money(p.offsetToRoom)} → 余额 ${money(p.newBalance)}`
    );
  }
  for (const s of stayOnlyPlans) {
    console.log(
      `  stay#${s.id} ${s.stay_no} 房间 ${s.room_no ?? "-"} · 只有 stays.deposit ${money(s.deposit)}` +
        `（押金明细已为 0，押金已被房费吃掉）→ stays.deposit 归零（不动钱）`
    );
  }
  const depositSum = round2(
    sum(plans, "depositItems") + sum(stayOnlyPlans, "deposit")
  );
  console.log(
    `  合计：${plans.length} 张账单 + ${stayOnlyPlans.length} 张仅入住单 · 残留押金 ${money(depositSum)}` +
      ` · 退现金 ${money(sum(plans, "refundCash"))} · 抵扣房费 ${money(sum(plans, "offsetToRoom"))}`
  );
  if (openFolioPlans.length > 0) {
    console.log(
      `  ⚠️ 其中 ${openFolioPlans.length} 张账单是「客人已退房、账单仍 OPEN」：清账后余额已为 0，` +
        `顺手置 SETTLED（--no-settle-open 可关掉）`
    );
  }
  console.log("");
}

console.log("=== B. 已结账（SETTLED）账单仍挂 DEPOSIT 明细 ===");
const planB = plans.filter((p) => p.folio.status === "SETTLED");
if (planB.length === 0) {
  console.log("  ✅ 没有残留押金明细\n");
} else {
  for (const p of planB) {
    console.log(
      `  ${p.folio.folio_no}（stay#${p.stayId} ${p.stayNo ?? "-"}）· 押金明细 ${money(p.depositItems)}` +
        ` · 余额 ${money(p.balance)} → 退现金 ${money(p.refundCash)} / 抵扣房费 ${money(p.offsetToRoom)}` +
        ` → 余额 ${money(p.newBalance)}`
    );
  }
  console.log(`  合计：${planB.length} 张 · 押金明细 ${money(sum(planB, "depositItems"))}\n`);
}

console.log("=== C. 已结账但余额未归零（缺陷 3）===");
if (settledBadBalance.length === 0) {
  console.log("  ✅ 全部已结账账单余额为 0\n");
} else {
  for (const f of settledBadBalance) {
    const willFix = !near(f.postBalance, 0) ? "仍非 0，只报告不动（需人工核对）" : "清账后归零";
    console.log(
      `  ${f.folio_no}（stay#${f.stay_id} ${f.stay_no ?? "-"}）· 库内余额 ${money(f.dbBalance)}` +
        ` · 应收 ${money(f.total_amount)} 已收 ${money(f.paid_amount)} · 重算后 ${money(f.postBalance)} → ${willFix}`
    );
  }
  const manual = settledBadBalance.filter((f) => !near(f.postBalance, 0));
  console.log(`  合计：${settledBadBalance.length} 张 · 自动归零 ${settledBadBalance.length - manual.length} 张 · 需人工 ${manual.length} 张\n`);
}

const totalChanges =
  plans.length + stayOnlyPlans.length + openFolioPlans.length + settledBadBalance.filter((f) => near(f.postBalance, 0)).length;

if (!APPLY) {
  console.log(`CHECK 完成：待修复 ${totalChanges} 处。加 --apply 备份后写库。`);
  db.close();
  process.exit(0);
}

if (totalChanges === 0) {
  console.log("没有需要修复的数据，无需备份 / 写库 ✅");
  db.close();
  process.exit(0);
}

/* ============================================================ 写库 */

backup();

let seq = 0;
const payNo = () => `FDR${Date.now()}${String(++seq).padStart(3, "0")}`;
let fixedFolios = 0;
let fixedStays = 0;
let fixedOpen = 0;
let fixedBalance = 0;

db.exec("BEGIN IMMEDIATE");
try {
  for (const p of plans) {
    /* ① 退现金：写负数收款（refund_of 指向原押金；kind 与生产口径一致） */
    if (p.refundCash > 0.005) {
      const dep = findDepositPay(p.hotelId, p.folio.id);
      run(
        `INSERT INTO payments
           (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          p.hotelId,
          p.folio.id,
          p.stayId ?? null,
          payNo(),
          dep?.method ?? "现金",
          -Math.abs(p.refundCash),
          p.bizDate,
          "退房退还押金（数据修复）",
          new Date().toISOString(),
          dep?.id ?? null,
          OPERATOR,
          "DEPOSIT_REFUND",
        ]
      );
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount, 0) - ? WHERE id = ? AND hotel_id = ?`, [
        p.refundCash,
        p.folio.id,
        p.hotelId,
      ]);
    }
    /* ② 押金明细全部清零（按行逐笔，避免批量 UPDATE 把多行各减一遍） */
    for (const line of p.lines) {
      run(
        `UPDATE folio_items SET amount = 0
          WHERE id = ? AND folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
        [line.id, p.folio.id, p.hotelId]
      );
    }
    /* ③ 入住单押金归零 */
    if (p.stayId) {
      run(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`, [p.stayId, p.hotelId]);
    }
    /* ④ 统一口径重算（total_amount / balance 一并落库） */
    folioLib.recalcFolioBalance(p.hotelId, p.folio.id);
    /* ⑤ 操作日志 */
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      p.hotelId,
      OPERATOR,
      LOG_ACTION,
      `账单 ${p.folio.folio_no}（${p.folio.status}）· 入住单 ${p.stayNo ?? "-"} · 押金明细 ${money(p.depositItems)} 全额冲销` +
        ` · 退现金 ${money(p.refundCash)} · 抵扣房费 ${money(p.offsetToRoom)} · 余额 ${money(p.newBalance)}` +
        ` · 应收 ${money(p.total)} 已收 ${money(p.newPaid)}`,
      new Date().toISOString(),
    ]);
    fixedFolios += 1;
  }

  /* 只有 stays.deposit 的历史脏数据：只清负债，不动钱 */
  for (const s of stayOnlyPlans) {
    run(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`, [s.id, s.hotel_id]);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      s.hotel_id,
      OPERATOR,
      LOG_ACTION,
      `入住单 ${s.stay_no}（已退房）· stays.deposit ${money(s.deposit)} → 0` +
        `（押金明细已为 0：押金已被房费吃掉，不退现金）`,
      new Date().toISOString(),
    ]);
    fixedStays += 1;
  }

  /* 已退房却仍 OPEN 的账单：余额已清 → 置 SETTLED（否则前台永远看到一张「未结」幽灵账） */
  for (const o of openFolioPlans) {
    run(`UPDATE folios SET status = 'SETTLED', settled_at = COALESCE(settled_at, ?) WHERE id = ? AND hotel_id = ?`, [
      new Date().toISOString(),
      o.folio.id,
      o.folio.hotel_id,
    ]);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      o.folio.hotel_id,
      OPERATOR,
      LOG_ACTION,
      `账单 ${o.folio.folio_no} · 客人已退房（入住单 ${o.stay.stay_no}）但账单仍 OPEN，余额已为 ${money(o.newBalance)} → 置 SETTLED`,
      new Date().toISOString(),
    ]);
    fixedOpen += 1;
  }

  /* 缺陷 3：已结账账单余额未归零 —— 用统一口径重算；算完仍非 0 的只报告不动 */
  for (const f of settledBadBalance) {
    if (!near(f.postBalance, 0)) continue;
    folioLib.recalcFolioBalance(f.hotel_id, f.id);
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      f.hotel_id,
      OPERATOR,
      LOG_ACTION,
      `账单 ${f.folio_no}（已结账）· 余额 ${money(f.dbBalance)} → 0（统一口径重算：应收 ${money(f.total_amount)} 已收 ${money(f.paid_amount)}）`,
      new Date().toISOString(),
    ]);
    fixedBalance += 1;
  }

  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`\n❌ 修复失败，已回滚：${e?.message ?? e}`);
  db.close();
  process.exit(1);
}

console.log("=== 修复结果 ===");
console.log(`  账单押金冲销：${fixedFolios} 张`);
console.log(`  仅入住单押金清零：${fixedStays} 张`);
console.log(`  已退房但 OPEN 的账单置 SETTLED：${fixedOpen} 张`);
console.log(`  已结账账单余额重算归零：${fixedBalance} 张`);

/* ============================================================ 复核（幂等） */

const leftStays = one(
  `SELECT COUNT(*) AS n, COALESCE(SUM(deposit), 0) AS s FROM stays
    WHERE status = 'CHECKED_OUT' AND COALESCE(deposit, 0) > 0.005`
);
const leftSettledDeposit = one(
  `SELECT COUNT(*) AS n, COALESCE(SUM(i.amount), 0) AS s
     FROM folios f JOIN folio_items i ON i.folio_id = f.id AND i.hotel_id = f.hotel_id
    WHERE f.status = 'SETTLED' AND i.item_type = 'DEPOSIT' AND COALESCE(i.amount, 0) > 0.005`
);
const leftBadBalance = all(
  `SELECT id, folio_no, balance FROM folios WHERE status = 'SETTLED' AND ABS(COALESCE(balance, 0)) > 0.01`
);
const leftOpenCheckedOut = one(
  `SELECT COUNT(*) AS n FROM stays s JOIN folios f ON f.stay_id = s.id AND f.hotel_id = s.hotel_id
    WHERE s.status = 'CHECKED_OUT' AND f.status = 'OPEN'`
);

console.log("\n=== 复核 ===");
console.log(`  CHECKED_OUT 仍残留押金：${leftStays.n} 张 / ${money(leftStays.s)} 元`);
console.log(`  SETTLED 仍挂押金明细：${leftSettledDeposit.n} 张 / ${money(leftSettledDeposit.s)} 元`);
console.log(`  SETTLED 余额非 0：${leftBadBalance.length} 张${leftBadBalance.length ? "：" + leftBadBalance.map((x) => `${x.folio_no}=${money(x.balance)}`).join(" / ") : ""}`);
console.log(`  已退房但仍 OPEN 的账单：${leftOpenCheckedOut.n} 张`);

const ok =
  Number(leftStays.n) === 0 &&
  Number(leftSettledDeposit.n) === 0 &&
  leftOpenCheckedOut.n === 0;
db.close();
console.log(ok ? "\n✅ 押金残留已清零（再跑一次 --check 应报告 0 条）" : "\n⚠️ 仍有残留，见上");
process.exit(ok ? 0 : 1);
