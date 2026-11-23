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
 * ── 可复用函数（第十三轮：接进迁移 / 部署流程）──
 *
 * 每次 `load-demo`（演示快照覆盖库）之后，押金残留就会回来；而本脚本是独立 CLI，
 * 必须记得单独跑一次 —— 已经漏过两次。所以把核心逻辑抽成：
 *
 *     import { repairDepositResidual } from "./scripts/fix-deposit-residual.mjs";
 *     const r = repairDepositResidual(db, hotelId, { apply: true });
 *
 *   · `db`      : 已打开的 node:sqlite 连接（函数内部会把 folio.ts 的取值口径指到它上面）
 *   · `hotelId` : 数字 = 只修这家店；`null` = 全库（与 CLI 同一口径）
 *   · `opts`    : { apply, settleOpen, zeroedDepositFallback, operator, logAction,
 *                   writeLog, onBeforeWrite }
 *                 `onBeforeWrite` 在「确认有事要改、事务开始前」调用一次 ——
 *                 CLI 用它做 VACUUM INTO 备份，调用方（migrate-all / post-deploy）
 *                 自己决定要不要备份，函数本身**永不备份**，避免一条命令里备份好几份。
 *
 *   返回（`RepairDepositResidualResult`）：
 *     { hotelId, apply, settleOpen,
 *       planned,                    // 命中的修复点数量（--check 就是「待修复 N 处」）
 *       changed,                    // 真正落库的修复点数（--check 恒为 0）
 *       checked: { folioDeposit, stayOnly, openSettled, balanceRecalc, balanceManual },
 *       applied: { folios, stays, openSettled, balance },
 *       totals:  { depositItems, stayDeposit, refundCash, offsetToRoom },
 *       report:  string[],          // 与 CLI 完全一致的报告行（调用方直接逐行 console.log）
 *       notes:   string[],          // 需要人看一眼的补充说明
 *       remaining: { stayDeposit:{n,s}, settledDeposit:{n,s}, badBalance:[], openCheckedOut:n },
 *       ok }                        // 复核：残留是否已归零
 *
 *   幂等：修完 stays.deposit=0、DEPOSIT 明细=0、余额=0，再跑一次 planned 必为 0。
 *
 * ── 安全 ──
 *   · 默认 --check：只报告，一个字节都不写；
 *   · --apply：先 `VACUUM INTO data/backup/pms.db.bak-deposit-<时间戳>` 备份，再写库；
 *   · 每条修复写一条 op_logs（action='押金残留修复'），可在 /logs 页面追；
 *   · hotel_id 过滤：传数字时每条 SQL 都带 hotel_id 校验，不跨租户。
 *
 * 用法：
 *   node scripts/fix-deposit-residual.mjs              # = --check，只报告
 *   node scripts/fix-deposit-residual.mjs --check
 *   node scripts/fix-deposit-residual.mjs --apply      # 备份 + 写库
 *   node scripts/fix-deposit-residual.mjs --apply --no-settle-open   # 不顺手把已退房却仍 OPEN 的账单置 SETTLED
 *   PMS_DB_PATH=/path/to/pms.db node scripts/fix-deposit-residual.mjs --check
 *
 * 退出码：--check 有残留 → 0（只是报告）；--apply 失败或复核仍有残留 → 1。
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 项目根：**按脚本位置算**，不依赖 cwd
 *
 * 以前用 process.cwd()：被 post-deploy.mjs / migrate-all.mjs import 时，
 * 只要调用方不在项目根（例如 `cd /opt/pms && node /tmp/x.mjs`），
 * `src/lib/folio.ts` 就解析不到。真正执行的 CLI 仍然在项目根跑，两种算法等价。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const BACKUP_DIR = path.join(path.dirname(DB_PATH), "backup");
const OPERATOR = "系统修复";
const LOG_ACTION = "押金残留修复";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => round2(n).toFixed(2);
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ============================================================ 复用生产口径
 *
 * lib/folio.ts 的 recalcFolioBalance / computeFolioBalance / depositHeld / isDepositPayment
 * 是账务的唯一口径（押金不计收入、部分结账负项排除…）。修复脚本**不准另抄一份**：
 * 两份口径一旦漂移，脚本「修好了」的断言和运行时算出来的余额会不一样。
 *
 * 两个技术点：
 *   1. `@/` 别名：Node 不认 tsconfig paths，用 registerHooks 把 `@/x` 映射到 `src/x(.ts)`；
 *   2. 顶层 await：本文件被 migrate-all.mjs **静态 import** 时，Node 会先把这个 await
 *      跑完再执行 import 方的模块体 —— 于是 repairDepositResidual 可以保持同步，
 *      migrate-all 的 runMigrations（同步函数，init-db.mjs 也在同步调用）才调得动它。
 *      换成「函数里再 await import」会直接变成 Promise，同步迁移链就断了。
 */
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

/** lib/folio.ts（账务唯一口径）；顶层 await 见上面第 2 点 */
const folioLib = await import(pathToFileURL(path.join(srcRoot, "lib", "folio.ts")).href);

/* ============================================================ 小工具 */

const all = (db, sql, p = []) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (db, sql, p = []) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : undefined;
};
const tableExists = (db, name) =>
  Number(one(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`, [name])?.n ?? 0) > 0;

/* ============================================================ 分析（只读） */

/** 该账单的押金明细行（> 0.005），后收先退 */
function depositLinesOf(db, folioId, hotelId) {
  return all(
    db,
    `SELECT id, amount FROM folio_items
      WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT' AND COALESCE(amount, 0) > 0.005
      ORDER BY id DESC`,
    [folioId, hotelId]
  );
}

/** 押金原收款（refund_of 要指向它）：kind='DEPOSIT' 优先，旧数据按备注兜底 */
function findDepositPay(db, hotelId, folioId) {
  const rows = all(
    db,
    `SELECT id, method, amount, kind, remark FROM payments
      WHERE hotel_id = ? AND folio_id = ? AND amount > 0 AND (kind = 'DEPOSIT' OR kind IS NULL)
      ORDER BY id ASC`,
    [hotelId, folioId]
  );
  return rows.find((r) => folioLib.isDepositPayment({ kind: r.kind, remark: r.remark }));
}

/**
 * 「押金明细已被清零」时，还能从流水里捞回的押金余额（正数 = 尚未冲销的押金收取）
 *
 * 为什么需要它：`migrate-all.mjs` 第 23 段是「安全子集」——把 SETTLED 账单上
 * 金额 > 0 的 DEPOSIT 明细**直接置 0**（它不知道该怎么退钱，只保证体检不红）。
 * 但真正的修复（本脚本）靠 depositHeld() 也就是明细来判断「最多能退多少」，
 * 明细被置 0 之后，`min(−balance, 明细)` 恒等于 0：
 *   · 账单还是一张「已结账、余额 −44」的幽灵账（缺陷 3 的残留）；
 *   · 而 `fix-deposit-residual.mjs` 的 C 段只会报「需人工核对」，永远修不掉。
 * 于是迁移跑完比不跑更糟：信息被抹掉，钱还欠着。
 *
 * 兜底口径只用于「明细已经归零」的库：
 *   未冲销押金 = Σ(kind/备注=押金的收款) + Σ(DEPOSIT_REFUND 负数金额)
 * 仍然只认 lib/folio.ts 的 isDepositPayment，不另立判定。
 */
function unreversedDepositPaid(db, hotelId, folioId) {
  const rows = all(
    db,
    `SELECT amount, kind, remark FROM payments
      WHERE hotel_id = ? AND folio_id = ? AND COALESCE(amount, 0) <> 0
      ORDER BY id`,
    [hotelId, folioId]
  );
  let sum = 0;
  for (const p of rows) {
    if (folioLib.isDepositPayment({ kind: p.kind, remark: p.remark })) sum += Number(p.amount ?? 0);
    else if (String(p.kind ?? "").toUpperCase() === "DEPOSIT_REFUND") sum += Number(p.amount ?? 0); /* 负数 */
  }
  return round2(sum);
}

/**
 * 单张账单的押金冲销方案（纯计算，不写库）
 *
 * refundCash = min(max(0, −balance), 押金明细 D)
 * 冲销后 paid' = paid − refundCash，balance' = total − paid'
 *
 * @param {boolean} zeroedDepositFallback 明细已归零时按未冲销押金流水兜底（见上）
 */
function planFolio(db, folio, zeroedDepositFallback = false) {
  const moneyNow = folioLib.computeFolioBalance(folio.hotel_id, folio.id);
  const itemDeposit = round2(folioLib.depositHeld(folio.hotel_id, folio.id));
  const refundDue = moneyNow.balance < -0.01 ? round2(-moneyNow.balance) : 0;

  /*
   * 兜底：明细为 0 但还欠着钱 → 用未冲销押金流水当上限。
   * 只在「确实有未冲销押金、且 balance 是欠钱（< 0）」时才介入，
   * 不改变有明细时的既有算法。
   */
  let fallbackDeposit = 0;
  if (zeroedDepositFallback && itemDeposit <= 0.005 && refundDue > 0) {
    const open = unreversedDepositPaid(db, folio.hotel_id, folio.id);
    if (open > 0.005) fallbackDeposit = open;
  }
  const depositItems = itemDeposit > 0.005 ? itemDeposit : fallbackDeposit;
  const refundCash = round2(Math.min(refundDue, Math.max(0, depositItems)));
  /* 兜底模式下「抵扣房费」早已发生在明细清零那一刻，不能再报一次 */
  const offsetToRoom = fallbackDeposit > 0 ? 0 : round2(Math.max(0, depositItems) - refundCash);
  const newPaid = round2(moneyNow.paid - refundCash);
  const newBalance = round2(moneyNow.total - newPaid);
  return {
    depositItems,
    itemDeposit,
    fallbackDeposit,
    refundDue,
    refundCash,
    offsetToRoom,
    total: moneyNow.total,
    paid: moneyNow.paid,
    balance: moneyNow.balance,
    newPaid,
    newBalance,
    lines: itemDeposit > 0.005 ? depositLinesOf(db, folio.id, folio.hotel_id) : [],
  };
}

/** 退款流水的记账日：优先客人实际离店日，其次账单结账日，最后今天 */
function refundBizDate(stay, folio, today) {
  if (stay && isYmd(stay.actual_check_out)) return stay.actual_check_out;
  const settled = String(folio.settled_at ?? "").slice(0, 10);
  if (isYmd(settled)) return settled;
  return today;
}

/** 入住单下的全部账单（含拆账单 -B/-C） */
function foliosOfStay(db, stayId, hotelId) {
  return all(
    db,
    `SELECT id, hotel_id, folio_no, status, total_amount, paid_amount, balance, settled_at
       FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id`,
    [stayId, hotelId]
  );
}

/* ============================================================ 核心：可复用修复函数 */

/**
 * 押金残留修复（规格见文件头「可复用函数」一节）
 *
 * @param {import("node:sqlite").DatabaseSync} db 已打开的连接；本函数不关闭、不备份
 * @param {number|null} hotelId 数字 = 只修该店；null = 全库（CLI 口径）
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false] false = 只报告（计划数仍会算出来）
 * @param {boolean} [opts.settleOpen=true] 已退房却仍 OPEN、且清账后余额为 0 的账单 → 置 SETTLED
 * @param {boolean} [opts.zeroedDepositFallback=false] 明细已被安全子集清零时按流水兜底
 * @param {string}  [opts.operator] op_logs 操作人
 * @param {string}  [opts.logAction] op_logs 动作名
 * @param {boolean} [opts.writeLog=true] 是否写 op_logs（表不存在时自动跳过）
 * @param {() => void} [opts.onBeforeWrite] 确认有变更、事务开始前调用一次（CLI 用它备份）
 * @returns {object} 结果对象（字段见文件头）
 */
export function repairDepositResidual(db, hotelId = null, opts = {}) {
  const apply = opts.apply === true;
  const settleOpen = opts.settleOpen !== false;
  const zeroedDepositFallback = opts.zeroedDepositFallback === true;
  const operator = opts.operator ?? OPERATOR;
  const logAction = opts.logAction ?? LOG_ACTION;
  const writeLog = opts.writeLog !== false;
  const onBeforeWrite = typeof opts.onBeforeWrite === "function" ? opts.onBeforeWrite : null;

  /*
   * lib/folio.ts 通过 globalThis.__pmsDb 取连接（src/lib/db.ts）。
   * CLI 口径是「进程里只有这一个库」；被 migrate-all / post-deploy 调用时
   * 必须显式指过去，否则 folio 口径会去开默认的 data/pms.db —— 在副本库上验证时
   * 就是「读了 A 库、写了 B 库」这种最难查的错。
   */
  const prevDb = globalThis.__pmsDb;
  globalThis.__pmsDb = db;
  try {
    const today =
      one(db, `SELECT date('now','localtime') AS d`)?.d ?? new Date().toISOString().slice(0, 10);
    const byHotel = hotelId === null || hotelId === undefined ? "" : " AND s.hotel_id = ?";
    const byHotelF = hotelId === null || hotelId === undefined ? "" : " AND f.hotel_id = ?";
    const hp = hotelId === null || hotelId === undefined ? [] : [Number(hotelId)];

    const report = [];
    const notes = [];

    /* ---- A. 已退房押金残留 ---- */
    const checkedOutStays = all(
      db,
      `SELECT s.id, s.hotel_id, s.stay_no, s.deposit, s.status, s.actual_check_out, r.room_no
         FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
        WHERE s.status = 'CHECKED_OUT' AND COALESCE(s.deposit, 0) > 0.005${byHotel}
        ORDER BY s.hotel_id, s.id`,
      hp
    );

    const plans = [];
    const seenFolios = new Set();

    for (const stay of checkedOutStays) {
      for (const folio of foliosOfStay(db, stay.id, stay.hotel_id)) {
        if (seenFolios.has(folio.id)) continue;
        const plan = planFolio(db, folio, zeroedDepositFallback);
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
          bizDate: refundBizDate(stay, folio, today),
          ...plan,
        });
      }
    }

    /* ---- B. 已结账账单仍挂押金明细（不依赖入住单状态） ---- */
    const settledFoliosWithDeposit = all(
      db,
      `SELECT f.id, f.hotel_id, f.folio_no, f.status, f.total_amount, f.paid_amount, f.balance, f.settled_at,
              f.stay_id, s.stay_no, s.deposit AS stay_deposit, s.status AS stay_status, s.actual_check_out, r.room_no
         FROM folios f
         LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
         LEFT JOIN rooms r ON r.id = s.room_id
        WHERE f.status = 'SETTLED'
          AND EXISTS (SELECT 1 FROM folio_items i
                       WHERE i.folio_id = f.id AND i.hotel_id = f.hotel_id
                         AND i.item_type = 'DEPOSIT' AND COALESCE(i.amount, 0) > 0.005)${byHotelF}
        ORDER BY f.hotel_id, f.id`,
      hp
    );

    for (const folio of settledFoliosWithDeposit) {
      if (seenFolios.has(folio.id)) continue;
      const plan = planFolio(db, folio, zeroedDepositFallback);
      seenFolios.add(folio.id);
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
        bizDate: refundBizDate({ actual_check_out: folio.actual_check_out }, folio, today),
        ...plan,
      });
    }

    /* ---- B2. 明细已被安全子集清零、但还欠着退款的已结账账单（兜底模式才扫） ---- */
    if (zeroedDepositFallback) {
      const settledNegative = all(
        db,
        `SELECT f.id, f.hotel_id, f.folio_no, f.status, f.total_amount, f.paid_amount, f.balance, f.settled_at,
                f.stay_id, s.stay_no, s.status AS stay_status, s.actual_check_out, s.deposit AS stay_deposit, r.room_no
           FROM folios f
           LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
           LEFT JOIN rooms r ON r.id = s.room_id
          WHERE f.status = 'SETTLED' AND COALESCE(f.balance, 0) < -0.01${byHotelF}
          ORDER BY f.hotel_id, f.id`,
        hp
      );
      for (const folio of settledNegative) {
        if (seenFolios.has(folio.id)) continue;
        const plan = planFolio(db, folio, true);
        if (plan.depositItems <= 0.005) continue;
        seenFolios.add(folio.id);
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
          bizDate: refundBizDate({ actual_check_out: folio.actual_check_out }, folio, today),
          ...plan,
        });
      }
    }

    /* ---- A2. 只有 stays.deposit、没有押金明细的历史脏数据 ---- */
    const stayOnlyPlans = [];
    const stayHasPlan = new Set(plans.map((p) => p.stayId).filter((x) => x !== null && x !== undefined));
    for (const stay of checkedOutStays) {
      /*
       * 已经有 plan 的入住单不再重复计入：
       *   有明细时靠 hasItems 天然不会重叠；但「明细已被安全子集清零、按流水兜底」
       *   （zeroedDepositFallback）时明细是 0，hasItems 变成 false —— 不拦一下就会
       *   同一张单既算「账单押金冲销」又算「仅入住单清零」，计划数虚高、还多写一遍
       *   stays.deposit = 0（值相同，但计数和报告会骗人）。
       */
      if (stayHasPlan.has(stay.id)) continue;
      const hasItems = foliosOfStay(db, stay.id, stay.hotel_id).some(
        (f) => folioLib.depositHeld(stay.hotel_id, f.id) > 0.005
      );
      if (hasItems) continue; /* 明细一起清零的那条 plan 已经覆盖 stays.deposit */
      stayOnlyPlans.push(stay);
    }

    /* ---- A3. 已退房但账单仍 OPEN（且清账后余额为 0）→ 置 SETTLED ---- */
    const openFolioPlans = [];
    if (settleOpen) {
      const newBalanceByFolio = new Map(plans.map((p) => [p.folio.id, p.newBalance]));
      for (const stay of checkedOutStays) {
        for (const folio of foliosOfStay(db, stay.id, stay.hotel_id)) {
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
      db,
      `SELECT f.id, f.hotel_id, f.folio_no, f.balance, f.total_amount, f.paid_amount, f.stay_id, s.stay_no
         FROM folios f LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
        WHERE f.status = 'SETTLED'${byHotelF} ORDER BY f.hotel_id, f.id`,
      hp
    )
      .map((f) => {
        const post = newBalanceByFolio.has(f.id)
          ? newBalanceByFolio.get(f.id)
          : folioLib.computeFolioBalance(f.hotel_id, f.id).balance;
        return { ...f, postBalance: post, dbBalance: round2(f.balance) };
      })
      .filter((f) => !near(f.dbBalance, 0) || !near(f.postBalance, 0));

    /* ============================================================ 报告 */

    const sum = (arr, key) => round2(arr.reduce((s, x) => s + Number(x[key] ?? 0), 0));

    report.push("=== A. 已退房（CHECKED_OUT）押金未冲销 ===");
    if (plans.length === 0 && stayOnlyPlans.length === 0) {
      report.push("  ✅ 没有残留押金");
      report.push("");
    } else {
      for (const p of plans) {
        report.push(
          `  stay#${p.stayId} ${p.stayNo} 房间 ${p.roomNo ?? "-"} · 账单 ${p.folio.folio_no}(${p.folio.status})` +
            ` · 押金明细 ${money(p.depositItems)} · 应收 ${money(p.total)} 已收 ${money(p.paid)} 余额 ${money(p.balance)}` +
            ` → 退现金 ${money(p.refundCash)} / 抵扣房费 ${money(p.offsetToRoom)} → 余额 ${money(p.newBalance)}` +
            (p.fallbackDeposit > 0
              ? `（押金明细已被安全子集清零：按未冲销押金流水 ${money(p.fallbackDeposit)} 兜底）`
              : "")
        );
      }
      for (const s of stayOnlyPlans) {
        report.push(
          `  stay#${s.id} ${s.stay_no} 房间 ${s.room_no ?? "-"} · 只有 stays.deposit ${money(s.deposit)}` +
            `（押金明细已为 0，押金已被房费吃掉）→ stays.deposit 归零（不动钱）`
        );
      }
      const depositSum = round2(sum(plans, "depositItems") + sum(stayOnlyPlans, "deposit"));
      report.push(
        `  合计：${plans.length} 张账单 + ${stayOnlyPlans.length} 张仅入住单 · 残留押金 ${money(depositSum)}` +
          ` · 退现金 ${money(sum(plans, "refundCash"))} · 抵扣房费 ${money(sum(plans, "offsetToRoom"))}`
      );
      if (openFolioPlans.length > 0) {
        report.push(
          `  ⚠️ 其中 ${openFolioPlans.length} 张账单是「客人已退房、账单仍 OPEN」：清账后余额已为 0，` +
            `顺手置 SETTLED（--no-settle-open 可关掉）`
        );
      }
      report.push("");
    }

    report.push("=== B. 已结账（SETTLED）账单仍挂 DEPOSIT 明细 ===");
    const planB = plans.filter((p) => p.folio.status === "SETTLED");
    if (planB.length === 0) {
      report.push("  ✅ 没有残留押金明细");
      report.push("");
    } else {
      for (const p of planB) {
        report.push(
          `  ${p.folio.folio_no}（stay#${p.stayId} ${p.stayNo ?? "-"}）· 押金明细 ${money(p.depositItems)}` +
            ` · 余额 ${money(p.balance)} → 退现金 ${money(p.refundCash)} / 抵扣房费 ${money(p.offsetToRoom)}` +
            ` → 余额 ${money(p.newBalance)}`
        );
      }
      report.push(`  合计：${planB.length} 张 · 押金明细 ${money(sum(planB, "depositItems"))}`);
      report.push("");
    }

    report.push("=== C. 已结账但余额未归零（缺陷 3）===");
    if (settledBadBalance.length === 0) {
      report.push("  ✅ 全部已结账账单余额为 0");
      report.push("");
    } else {
      for (const f of settledBadBalance) {
        const willFix = !near(f.postBalance, 0) ? "仍非 0，只报告不动（需人工核对）" : "清账后归零";
        report.push(
          `  ${f.folio_no}（stay#${f.stay_id} ${f.stay_no ?? "-"}）· 库内余额 ${money(f.dbBalance)}` +
            ` · 应收 ${money(f.total_amount)} 已收 ${money(f.paid_amount)} · 重算后 ${money(f.postBalance)} → ${willFix}`
        );
      }
      const manual = settledBadBalance.filter((f) => !near(f.postBalance, 0));
      report.push(
        `  合计：${settledBadBalance.length} 张 · 自动归零 ${settledBadBalance.length - manual.length} 张 · 需人工 ${manual.length} 张`
      );
      report.push("");
    }

    const balanceManual = settledBadBalance.filter((f) => !near(f.postBalance, 0));
    const planned =
      plans.length +
      stayOnlyPlans.length +
      openFolioPlans.length +
      (settledBadBalance.length - balanceManual.length);

    const result = {
      hotelId: hotelId ?? null,
      apply,
      settleOpen,
      planned,
      changed: 0,
      checked: {
        folioDeposit: plans.length,
        stayOnly: stayOnlyPlans.length,
        openSettled: openFolioPlans.length,
        balanceRecalc: settledBadBalance.length - balanceManual.length,
        balanceManual: balanceManual.length,
      },
      applied: { folios: 0, stays: 0, openSettled: 0, balance: 0 },
      totals: {
        depositItems: sum(plans, "depositItems"),
        stayDeposit: sum(stayOnlyPlans, "deposit"),
        refundCash: sum(plans, "refundCash"),
        offsetToRoom: sum(plans, "offsetToRoom"),
      },
      report,
      notes,
      remaining: null,
      ok: false,
    };

    if (!apply || planned === 0) {
      result.remaining = readRemaining(db, hotelId);
      result.ok =
        Number(result.remaining.stayDeposit.n) === 0 &&
        Number(result.remaining.settledDeposit.n) === 0 &&
        result.remaining.badBalance.length === 0 &&
        Number(result.remaining.openCheckedOut) === 0;
      return result;
    }

    /* ============================================================ 写库 */

    if (onBeforeWrite) onBeforeWrite();

    let seq = 0;
    const payNo = () => `FDR${Date.now()}${String(++seq).padStart(3, "0")}`;
    const canLog = writeLog && tableExists(db, "op_logs");
    if (writeLog && !canLog) notes.push("op_logs 表不存在：本次修复未写审计日志");
    const log = (hid, detail) => {
      if (!canLog) return;
      db.prepare(
        `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`
      ).run(hid, operator, logAction, detail, new Date().toISOString());
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of plans) {
        /* ① 退现金：写负数收款（refund_of 指向原押金；kind 与生产口径一致） */
        if (p.refundCash > 0.005) {
          const dep = findDepositPay(db, p.hotelId, p.folio.id);
          db.prepare(
            `INSERT INTO payments
               (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator, kind)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
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
            operator,
            "DEPOSIT_REFUND"
          );
          db.prepare(`UPDATE folios SET paid_amount = COALESCE(paid_amount, 0) - ? WHERE id = ? AND hotel_id = ?`).run(
            p.refundCash,
            p.folio.id,
            p.hotelId
          );
        }
        /* ② 押金明细全部清零（按行逐笔，避免批量 UPDATE 把多行各减一遍） */
        for (const line of p.lines) {
          db.prepare(
            `UPDATE folio_items SET amount = 0
              WHERE id = ? AND folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`
          ).run(line.id, p.folio.id, p.hotelId);
        }
        /* ③ 入住单押金归零 */
        if (p.stayId) {
          db.prepare(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`).run(p.stayId, p.hotelId);
        }
        /* ④ 统一口径重算（total_amount / balance 一并落库） */
        folioLib.recalcFolioBalance(p.hotelId, p.folio.id);
        /* ⑤ 操作日志 */
        log(
          p.hotelId,
          `账单 ${p.folio.folio_no}（${p.folio.status}）· 入住单 ${p.stayNo ?? "-"} · 押金明细 ${money(p.depositItems)} 全额冲销` +
            ` · 退现金 ${money(p.refundCash)} · 抵扣房费 ${money(p.offsetToRoom)} · 余额 ${money(p.newBalance)}` +
            ` · 应收 ${money(p.total)} 已收 ${money(p.newPaid)}` +
            (p.fallbackDeposit > 0 ? ` · 明细已被安全子集清零，按未冲销押金流水 ${money(p.fallbackDeposit)} 兜底` : "")
        );
        result.applied.folios += 1;
      }

      /* 只有 stays.deposit 的历史脏数据：只清负债，不动钱 */
      for (const s of stayOnlyPlans) {
        db.prepare(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`).run(s.id, s.hotel_id);
        log(
          s.hotel_id,
          `入住单 ${s.stay_no}（已退房）· stays.deposit ${money(s.deposit)} → 0` +
            `（押金明细已为 0：押金已被房费吃掉，不退现金）`
        );
        result.applied.stays += 1;
      }

      /* 已退房却仍 OPEN 的账单：余额已清 → 置 SETTLED（否则前台永远看到一张「未结」幽灵账） */
      for (const o of openFolioPlans) {
        db.prepare(
          `UPDATE folios SET status = 'SETTLED', settled_at = COALESCE(settled_at, ?) WHERE id = ? AND hotel_id = ?`
        ).run(new Date().toISOString(), o.folio.id, o.folio.hotel_id);
        log(
          o.folio.hotel_id,
          `账单 ${o.folio.folio_no} · 客人已退房（入住单 ${o.stay.stay_no}）但账单仍 OPEN，余额已为 ${money(o.newBalance)} → 置 SETTLED`
        );
        result.applied.openSettled += 1;
      }

      /* 缺陷 3：已结账账单余额未归零 —— 用统一口径重算；算完仍非 0 的只报告不动 */
      for (const f of settledBadBalance) {
        if (!near(f.postBalance, 0)) continue;
        folioLib.recalcFolioBalance(f.hotel_id, f.id);
        log(
          f.hotel_id,
          `账单 ${f.folio_no}（已结账）· 余额 ${money(f.dbBalance)} → 0（统一口径重算：应收 ${money(f.total_amount)} 已收 ${money(f.paid_amount)}）`
        );
        result.applied.balance += 1;
      }

      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务已被 SQLite 自动回滚 */
      }
      throw new Error(`押金残留修复失败，已回滚：${e?.message ?? e}`);
    }

    result.changed =
      result.applied.folios + result.applied.stays + result.applied.openSettled + result.applied.balance;

    /* 复核 */
    result.remaining = readRemaining(db, hotelId);
    result.ok =
      Number(result.remaining.stayDeposit.n) === 0 &&
      Number(result.remaining.settledDeposit.n) === 0 &&
      result.remaining.badBalance.length === 0 &&
      Number(result.remaining.openCheckedOut) === 0;

    if (result.remaining.badBalance.length > 0) {
      notes.push(
        `仍有 ${result.remaining.badBalance.length} 张已结账账单余额非 0，需人工核对：` +
          result.remaining.badBalance.map((x) => `${x.folio_no}=${money(x.balance)}`).join(" / ")
      );
    }

    return result;
  } finally {
    if (prevDb === undefined) delete globalThis.__pmsDb;
    else globalThis.__pmsDb = prevDb;
  }
}

/* ============================================================ 复核（只读） */

function readRemaining(db, hotelId) {
  const byHotel = hotelId === null || hotelId === undefined ? "" : " AND s.hotel_id = ?";
  const byHotelF = hotelId === null || hotelId === undefined ? "" : " AND f.hotel_id = ?";
  const hp = hotelId === null || hotelId === undefined ? [] : [Number(hotelId)];

  const stayDeposit = one(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(s.deposit), 0) AS s FROM stays s
      WHERE s.status = 'CHECKED_OUT' AND COALESCE(s.deposit, 0) > 0.005${byHotel}`,
    hp
  ) ?? { n: 0, s: 0 };
  const settledDeposit = one(
    db,
    `SELECT COUNT(DISTINCT f.id) AS n, COALESCE(SUM(i.amount), 0) AS s
       FROM folios f JOIN folio_items i ON i.folio_id = f.id AND i.hotel_id = f.hotel_id
      WHERE f.status = 'SETTLED' AND i.item_type = 'DEPOSIT' AND COALESCE(i.amount, 0) > 0.005${byHotelF}`,
    hp
  ) ?? { n: 0, s: 0 };
  const badBalance = all(
    db,
    `SELECT f.id, f.folio_no, f.balance FROM folios f
      WHERE f.status = 'SETTLED' AND ABS(COALESCE(f.balance, 0)) > 0.01${byHotelF}`,
    hp
  );
  const openCheckedOut = one(
    db,
    `SELECT COUNT(*) AS n FROM stays s JOIN folios f ON f.stay_id = s.id AND f.hotel_id = s.hotel_id
      WHERE s.status = 'CHECKED_OUT' AND f.status = 'OPEN'${byHotel}`,
    hp
  )?.n ?? 0;

  return {
    stayDeposit: { n: Number(stayDeposit.n ?? 0), s: Number(stayDeposit.s ?? 0) },
    settledDeposit: { n: Number(settledDeposit.n ?? 0), s: Number(settledDeposit.s ?? 0) },
    badBalance: badBalance.map((x) => ({ ...x })),
    openCheckedOut: Number(openCheckedOut),
  };
}

/* ============================================================ CLI 入口
 *
 * 只有直接执行时才跑：被 migrate-all.mjs / post-deploy.mjs 静态 import 时，
 * 本文件的顶层只提供 repairDepositResidual（以及已经 await 好的 folioLib）。
 * isMain 判断放在文件末尾，保持「先定义、后执行」的老阅读顺序。
 */

function cli() {
  const APPLY = process.argv.includes("--apply");
  const SETTLE_OPEN = !process.argv.includes("--no-settle-open");
  const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");

  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ 数据库不存在：${DB_PATH}\n  用 PMS_DB_PATH 指定，或先跑 node scripts/init-db.mjs`);
    process.exit(1);
  }
  console.log(`数据库：${DB_PATH}`);
  console.log(`模式：${APPLY ? "APPLY（备份后写库）" : "CHECK（只报告，不写任何数据）"}\n`);

  const backup = () => {
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
  };

  const db = new DatabaseSync(DB_PATH, { timeout: 15000 });
  db.exec("PRAGMA busy_timeout = 15000");
  globalThis.__pmsDb = db;

  let result;
  try {
    result = repairDepositResidual(db, null, {
      apply: APPLY,
      settleOpen: SETTLE_OPEN,
      onBeforeWrite: backup,
    });
  } catch (e) {
    console.error(`\n❌ ${e?.message ?? e}`);
    db.close();
    process.exit(1);
  }

  for (const line of result.report) console.log(line);
  for (const n of result.notes) console.log(`  ! ${n}`);

  if (!APPLY) {
    console.log(`CHECK 完成：待修复 ${result.planned} 处。加 --apply 备份后写库。`);
    db.close();
    process.exit(0);
  }

  if (result.planned === 0) {
    console.log("没有需要修复的数据，无需备份 / 写库 ✅");
    db.close();
    process.exit(0);
  }

  console.log("=== 修复结果 ===");
  console.log(`  账单押金冲销：${result.applied.folios} 张`);
  console.log(`  仅入住单押金清零：${result.applied.stays} 张`);
  console.log(`  已退房但 OPEN 的账单置 SETTLED：${result.applied.openSettled} 张`);
  console.log(`  已结账账单余额重算归零：${result.applied.balance} 张`);

  console.log("\n=== 复核 ===");
  console.log(
    `  CHECKED_OUT 仍残留押金：${result.remaining.stayDeposit.n} 张 / ${money(result.remaining.stayDeposit.s)} 元`
  );
  console.log(
    `  SETTLED 仍挂押金明细：${result.remaining.settledDeposit.n} 张 / ${money(result.remaining.settledDeposit.s)} 元`
  );
  console.log(
    `  SETTLED 余额非 0：${result.remaining.badBalance.length} 张${
      result.remaining.badBalance.length
        ? "：" + result.remaining.badBalance.map((x) => `${x.folio_no}=${money(x.balance)}`).join(" / ")
        : ""
    }`
  );
  console.log(`  已退房但仍 OPEN 的账单：${result.remaining.openCheckedOut} 张`);

  db.close();
  console.log(result.ok ? "\n✅ 押金残留已清零（再跑一次 --check 应报告 0 条）" : "\n⚠️ 仍有残留，见上");
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) cli();
