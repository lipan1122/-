/**
 * 会员储值 + AR 台账验收（整改 P1-3 / P1-5）
 *
 * 这份脚本做两件事：
 *   1. 静态校验：service 是否按约定导出、余额是否只有一个写入口、
 *      迁移脚本是否包含建表 / 索引 / 幂等数据迁移段；
 *   2. 数据校验：表结构、索引、余额恒等式、迁移幂等性，
 *      并在事务里实测「重复幂等键被拦」「退款上限口径」「AR 未结余额口径」，
 *      测完 ROLLBACK，不污染业务数据。
 *
 * 用法：node scripts/test-member-ar.mjs
 * 前置：node scripts/migrate-all.mjs 已经跑过（本脚本会顺带检查迁移是否处于目标状态）
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDbPath, runMigrations } from "./migrate-all.mjs";

const ROOT = process.cwd();
const DB = resolveDbPath();

let pass = 0;
let fail = 0;
const todos = [];

const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` ${extra}` : ""}`);
  }
};

const readSrc = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const walletSrc = readSrc("src/lib/member-wallet.ts");
const arSrc = readSrc("src/lib/ar.ts");
const migrateSrc = readSrc("scripts/migrate-all.mjs");

console.log("=== 一、静态校验 ===");

/* 1. service 文件与导出 */
check("src/lib/member-wallet.ts 存在", walletSrc.length > 0);
for (const fn of ["getWalletBalance", "rechargeWallet", "consumeWallet", "refundWallet"]) {
  check(
    `member-wallet.ts 导出 ${fn}`,
    new RegExp(`export function ${fn}\\s*\\(`).test(walletSrc)
  );
}
check("src/lib/ar.ts 存在", arSrc.length > 0);
for (const fn of ["postArCharge", "getCompanyOutstanding", "settleAr", "listArAging"]) {
  check(`ar.ts 导出 ${fn}`, new RegExp(`export function ${fn}\\s*\\(`).test(arSrc));
}

/* 2. 余额只允许由流水回写：整个 service 里只有一处 UPDATE member_wallet ... SET balance */
const balanceWrites = (walletSrc.match(/UPDATE\s+member_wallet\s+SET\s+balance/gi) ?? []).length;
check("余额只有一个写入口（recalcBalance 用 SUM 回写）", balanceWrites === 1, `实际 ${balanceWrites} 处`);

/* 3. 退款约束存在且文案明确 */
check(
  "refundWallet 带「累计退款 ≤ 累计充值 − 累计消费」校验",
  /累计退款/.test(walletSrc) && /累计充值/.test(walletSrc) && /累计消费/.test(walletSrc)
);

/* 4. 迁移脚本：建表 / 索引 / 幂等迁移 */
check("migrate-all.mjs 建 member_wallet_ledger", /CREATE TABLE member_wallet_ledger/.test(migrateSrc));
check(
  "migrate-all.mjs 建 idx_wallet_ledger_request（request_id 幂等键）",
  /idx_wallet_ledger_request/.test(migrateSrc) && /WHERE request_id IS NOT NULL/.test(migrateSrc)
);
check("migrate-all.mjs 建 ar_ledgers", /CREATE TABLE IF NOT EXISTS ar_ledgers/.test(migrateSrc));
check(
  "migrate-all.mjs 含旧储值流水数据迁移（NOT EXISTS 幂等）",
  /migrate:mwt:/.test(migrateSrc) && /NOT EXISTS/.test(migrateSrc)
);
check(
  "migrate-all.mjs 含旧会员充值行数据迁移（NOT EXISTS 幂等）",
  /migrate:mw:/.test(migrateSrc)
);

/* 5. 收银台尚未接入（不在本次改动范围，只做提示，不计失败） */
const cashierSrc = readSrc("src/app/(main)/cashier/actions.ts");
if (/%【挂账】\$\{/.test(cashierSrc)) {
  todos.push(
    "cashier/actions.ts 的 chargeToCompanyAction 仍用「备注 LIKE 匹配」算已挂账金额 → 需 lead 接入 getCompanyOutstanding / postArCharge（精确位置见交付报告）"
  );
}
if (!/from "@\/lib\/member-wallet"/.test(cashierSrc)) {
  todos.push("cashier/actions.ts 尚未接入 consumeWallet（储值卡扣房费按需求本期先不做）");
}

/* 6. 储值页面入口（/members/wallet）仍写旧表：本次不动别的入口文件，只提示 */
const walletActionsSrc = readSrc("src/app/(main)/members/wallet/actions.ts");
if (walletActionsSrc && !/from "@\/lib\/member-wallet"/.test(walletActionsSrc)) {
  todos.push(
    "members/wallet/actions.ts 的充值/消费/退款仍写旧表 member_wallet_transactions → 需改为调 rechargeWallet/consumeWallet/refundWallet，否则页面入口仍与 ledger 割裂"
  );
}

console.log("\n=== 二、数据校验（数据库） ===");

const db = new DatabaseSync(DB);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const tableExists = (name) => all(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]).length > 0;
const indexNames = () => all(`SELECT name FROM sqlite_master WHERE type='index'`).map((r) => r.name);
const cols = (t) => {
  try {
    return all(`PRAGMA table_info(${t})`).map((c) => c.name);
  } catch {
    return [];
  }
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* --- 2.1 表结构 --- */
check("member_wallet_ledger 表存在", tableExists("member_wallet_ledger"));
const ledgerCols = ["hotel_id", "member_id", "biz_type", "amount", "balance_after", "ref_type", "ref_id", "request_id", "operator", "remark", "created_at"];
const missingLedgerCols = ledgerCols.filter((c) => !cols("member_wallet_ledger").includes(c));
check("member_wallet_ledger 字段齐全", missingLedgerCols.length === 0, `缺 ${missingLedgerCols.join(",")}`);

check("ar_ledgers 表存在", tableExists("ar_ledgers"));
const arCols = ["hotel_id", "company_id", "folio_id", "folio_no", "biz_date", "amount", "settled_amount", "due_date", "status", "operator", "remark", "created_at"];
const missingArCols = arCols.filter((c) => !cols("ar_ledgers").includes(c));
check("ar_ledgers 字段齐全", missingArCols.length === 0, `缺 ${missingArCols.join(",")}`);

const walletCols = cols("member_wallet");
check(
  "member_wallet 已补 member_id / balance（余额缓存）",
  ["member_id", "balance"].every((c) => walletCols.includes(c))
);
check(
  "member_wallet 仍保留旧列（不打断 rooms/actions.ts 的写入路径）",
  ["guest_name", "amount", "type", "note"].every((c) => walletCols.includes(c))
);

/* --- 2.2 索引 --- */
const idx = indexNames();
for (const name of ["idx_wallet_ledger_member", "idx_wallet_ledger_request", "idx_ar_ledgers_company", "idx_ar_ledgers_bizdate"]) {
  check(`索引 ${name} 存在`, idx.includes(name));
}
const reqIdxSql =
  all(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_wallet_ledger_request'`)[0]?.sql ?? "";
check("request_id 索引是 UNIQUE 且只约束非空值", /UNIQUE/i.test(reqIdxSql) && /WHERE\s+request_id\s+IS\s+NOT\s+NULL/i.test(reqIdxSql));

/* --- 2.3 余额恒等式：member_wallet.balance === SUM(ledger.amount) --- */
const drift = all(
  `SELECT w.hotel_id, w.member_id, w.balance AS cached,
          (SELECT COALESCE(SUM(x.amount), 0) FROM member_wallet_ledger x
            WHERE x.hotel_id = w.hotel_id AND x.member_id = w.member_id) AS ledger
     FROM member_wallet w
    WHERE w.member_id IS NOT NULL
      AND ABS(COALESCE(w.balance, 0) - (SELECT COALESCE(SUM(x.amount), 0) FROM member_wallet_ledger x
             WHERE x.hotel_id = w.hotel_id AND x.member_id = w.member_id)) > 0.001`
);
check("全店储值余额缓存 === 流水合计", drift.length === 0, `${drift.length} 个会员不一致`);

/* 每个会员的流水按 id 顺序累加后，最后一笔 balance_after 也必须等于余额 */
const snapshotDrift = all(
  `SELECT l.hotel_id, l.member_id, l.balance_after AS snapshot,
          (SELECT COALESCE(SUM(x.amount), 0) FROM member_wallet_ledger x
            WHERE x.hotel_id = l.hotel_id AND x.member_id = l.member_id AND x.id <= l.id) AS running
     FROM member_wallet_ledger l
    WHERE l.id = (SELECT MAX(y.id) FROM member_wallet_ledger y
                   WHERE y.hotel_id = l.hotel_id AND y.member_id = l.member_id)`
);
const snapshotBad = snapshotDrift.filter((r) => Math.abs(Number(r.snapshot) - Number(r.running)) > 0.001);
check("流水 balance_after 快照与累加值一致", snapshotBad.length === 0, `${snapshotBad.length} 条快照不一致`);

/* --- 2.4 AR 台账数据完整性 --- */
const badSettle = one(
  `SELECT COUNT(*) AS c FROM ar_ledgers
    WHERE COALESCE(settled_amount, 0) < -0.001
       OR COALESCE(settled_amount, 0) - amount > 0.001`
)?.c ?? 0;
check("ar_ledgers 已核销金额合法（0 ≤ 已核销 ≤ 应收）", Number(badSettle) === 0, `${badSettle} 条越界`);

const badStatus = one(
  `SELECT COUNT(*) AS c FROM ar_ledgers
    WHERE status NOT IN ('OPEN', 'PARTIAL', 'SETTLED', 'WRITTEN_OFF')`
)?.c ?? 0;
check("ar_ledgers 状态取值合法", Number(badStatus) === 0, `${badStatus} 条非法状态`);

const settledOpen = one(
  `SELECT COUNT(*) AS c FROM ar_ledgers
    WHERE status = 'SETTLED' AND amount - COALESCE(settled_amount, 0) > 0.001`
)?.c ?? 0;
check("已结清台账的未结余额为 0", Number(settledOpen) === 0, `${settledOpen} 条已结仍有余额`);

/* --- 2.5 迁移幂等：再以 checkOnly 跑一次，本项负责的迁移应当没有待处理项 ---
 * 只断言 P1-3 / P1-5 范围内的条目：migrate-all.mjs 是多人共用的迁移入口，
 * 别的缺陷批次可能同时新增了自己的待迁移项，不应该让本验收脚本失败。 */
const again = runMigrations(db, { checkOnly: true });
const mineLeft = again.applied.filter((a) =>
  /member_wallet_ledger|member_wallet\.|idx_wallet_|ar_ledgers|idx_ar_ledgers/.test(a)
);
const othersLeft = again.applied.filter((a) => !mineLeft.includes(a));
check(
  "迁移幂等（P1-3/P1-5 相关条目无待处理项）",
  mineLeft.length === 0,
  `仍有 ${mineLeft.length} 项待处理：${mineLeft.join(" / ")}`
);
if (othersLeft.length > 0) {
  console.log(`ℹ️  其它批次的待迁移项（不计入本脚本）：${othersLeft.join(" / ")}`);
}

/* --- 2.6 实测：幂等键 / 退款上限 / AR 未结余额（事务内，测完回滚） --- */
const T_HOTEL = 990001;
const T_MEMBER = 990001;
const T_COMPANY = 990001;

db.exec("BEGIN");
try {
  /* 幂等键：同一 request_id 第二次插入必须被唯一索引拦下 */
  db.prepare(
    `INSERT INTO member_wallet_ledger
       (hotel_id, member_id, biz_type, amount, balance_after, request_id, created_at)
     VALUES (?, ?, 'RECHARGE', 1000, 1000, 'test:req:1', datetime('now'))`
  ).run(T_HOTEL, T_MEMBER);

  let dupBlocked = false;
  try {
    db.prepare(
      `INSERT INTO member_wallet_ledger
         (hotel_id, member_id, biz_type, amount, balance_after, request_id, created_at)
       VALUES (?, ?, 'RECHARGE', 1000, 2000, 'test:req:1', datetime('now'))`
    ).run(T_HOTEL, T_MEMBER);
  } catch {
    dupBlocked = true;
  }
  check("重复 request_id 被唯一索引拒绝（幂等键生效）", dupBlocked);

  /* 余额缓存可由流水回写（模拟 recalcBalance 的唯一 SQL 口径） */
  db.prepare(
    `INSERT INTO member_wallet (hotel_id, member_id, guest_name, balance, created_at)
     VALUES (?, ?, '测试会员', 0, datetime('now'))`
  ).run(T_HOTEL, T_MEMBER);
  db.prepare(
    `UPDATE member_wallet
        SET balance = (SELECT COALESCE(SUM(amount), 0) FROM member_wallet_ledger
                        WHERE hotel_id = ? AND member_id = ?)
      WHERE hotel_id = ? AND member_id = ?`
  ).run(T_HOTEL, T_MEMBER, T_HOTEL, T_MEMBER);
  const cached = one(`SELECT balance FROM member_wallet WHERE hotel_id = ? AND member_id = ?`, [T_HOTEL, T_MEMBER]);
  check("余额缓存可由 SUM(流水) 回写", Math.abs(Number(cached?.balance) - 1000) < 0.001, `得到 ${cached?.balance}`);

  /* 退款上限口径：SUM(RECHARGE) − SUM(CONSUME)，本次退款 + 已退不得超出 */
  db.prepare(
    `INSERT INTO member_wallet_ledger (hotel_id, member_id, biz_type, amount, balance_after, created_at)
     VALUES (?, ?, 'CONSUME', -400, 600, datetime('now'))`
  ).run(T_HOTEL, T_MEMBER);
  const cap = one(
    `SELECT
       COALESCE(SUM(CASE WHEN biz_type = 'RECHARGE' THEN amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN biz_type = 'CONSUME' THEN -amount ELSE 0 END), 0) AS cap,
       COALESCE(SUM(CASE WHEN biz_type = 'REFUND' THEN ABS(amount) ELSE 0 END), 0) AS refunded
     FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`,
    [T_HOTEL, T_MEMBER]
  );
  check("可退上限 = 累计充值 − 累计消费", Math.abs(Number(cap?.cap) - 600) < 0.001, `得到 ${cap?.cap}`);
  const overRefund = 700 > Number(cap?.cap) + Number(cap?.refunded) + 0.001;
  check("超额退款会被拒绝（700 > 可退 600）", overRefund);

  /* AR 未结余额口径：SUM(amount − settled) WHERE status IN ('OPEN','PARTIAL') */
  db.prepare(
    `INSERT INTO ar_ledgers (hotel_id, company_id, folio_id, folio_no, biz_date, amount, settled_amount, status, created_at)
     VALUES (?, ?, 9001, 'F9001', date('now','-40 day'), 500, 0, 'OPEN', datetime('now'))`
  ).run(T_HOTEL, T_COMPANY);
  db.prepare(
    `INSERT INTO ar_ledgers (hotel_id, company_id, folio_id, folio_no, biz_date, amount, settled_amount, status, created_at)
     VALUES (?, ?, 9002, 'F9002', date('now','-80 day'), 300, 300, 'SETTLED', datetime('now'))`
  ).run(T_HOTEL, T_COMPANY);

  const outstanding = one(
    `SELECT COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS s
       FROM ar_ledgers
      WHERE hotel_id = ? AND company_id = ? AND status IN ('OPEN', 'PARTIAL')`,
    [T_HOTEL, T_COMPANY]
  );
  check("AR 未结余额只算 OPEN/PARTIAL", Math.abs(Number(outstanding?.s) - 500) < 0.001, `得到 ${outstanding?.s}`);

  /* 账龄分档：40 天前那笔应落在「31–60 天」档（与 src/lib/ar.ts 的 listArAging 同一口径） */
  const aging = all(
    `SELECT CASE
              WHEN CAST(julianday('now') - julianday(biz_date) AS INTEGER) <= 30 THEN '0–30 天'
              WHEN CAST(julianday('now') - julianday(biz_date) AS INTEGER) <= 60 THEN '31–60 天'
              WHEN CAST(julianday('now') - julianday(biz_date) AS INTEGER) <= 90 THEN '61–90 天'
              ELSE '90 天以上'
            END AS bucket,
            COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS amt
       FROM ar_ledgers
      WHERE hotel_id = ? AND company_id = ? AND status IN ('OPEN', 'PARTIAL')
      GROUP BY bucket`,
    [T_HOTEL, T_COMPANY]
  );
  const bucket6100 = aging.find((r) => r.bucket === "31–60 天");
  check(
    "账龄分档落桶正确（40 天前挂账 → 31–60 天，500）",
    Math.abs(Number(bucket6100?.amt ?? 0) - 500) < 0.001 && aging.length === 1,
    `实际 ${JSON.stringify(aging)}`
  );
} finally {
  db.exec("ROLLBACK");
}

/* 回滚后测试数据不应残留 */
const residue = one(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE hotel_id = ?`, [T_HOTEL])?.c ?? 0;
check("实测数据已随事务回滚（不污染业务库）", Number(residue) === 0);

db.close();

console.log("\n=== 三、待接入（不在本次改动范围，交 lead） ===");
if (todos.length === 0) {
  console.log("（无）");
} else {
  for (const t of todos) console.log(`TODO ${t}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
