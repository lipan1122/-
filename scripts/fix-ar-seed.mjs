/**
 * 修复 AR：账户有余额、但流水/台账为空
 *
 * ── 症状 ──
 *
 * `ar_accounts` 5 个账户余额合计 105,740，但：
 *   ar_transactions  0 笔
 *   ar_ledgers       0 行
 *   ar_write_offs    0 行
 *
 * 结果：/ar 页面显示余额，但没有一笔流水能解释它；
 *       /finance 的「协议单位应收」为空（它读 ar_ledgers）；
 *       体检项「AR 账户余额 ≠ 流水合计」直接红（实测 VPS 5/5 全不符）。
 *
 * ── 为什么会这样 ──
 *
 * 这几个表是「页面首次访问时懒建」的（`ensureArSchema`）。某个操作
 * （重导演示库 / 清空业务数据 / 恢复旧备份）把表清了，但 `ar_accounts`
 * 的种子行还在 —— 两张表就此分叉。
 *
 * ── 修法 ──
 *
 * 对每个「余额 ≠ 流水合计」的账户，把它缺的那部分补成一条**期初余额结转**流水
 * （`type='POST'`，`biz_date` 取该账户最早的一笔业务日，没有就取今天），
 * 让 `balance = SUM(ar_transactions.amount)` 重新成立。
 *
 * 然后（可选 `--ledgers`）按 `company_id` 同步生成 `ar_ledgers` 台账行，
 * 让 `/finance` 的「协议单位应收」也有数。
 *
 * 幂等：补完之后 `balance === txsum`，再跑就是 0 处变更。
 *
 * ── 用法 ──
 *
 *   node scripts/fix-ar-seed.mjs                 # 只报告
 *   node scripts/fix-ar-seed.mjs --apply         # 备份后补流水
 *   node scripts/fix-ar-seed.mjs --apply --ledgers  # 同时补台账
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbPath = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");

const APPLY = process.argv.includes("--apply");
const WITH_LEDGERS = process.argv.includes("--ledgers");
const HOTEL = Number(process.env.PMS_HOTEL_ID ?? 1);

const db = new DatabaseSync(dbPath);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const nowIso = () => new Date().toISOString();

/* 表存在性：老库可能根本没有 AR 表 */
const has = (t) => all(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [t]).length > 0;
if (!has("ar_accounts") || !has("ar_transactions")) {
  console.log("\n本库没有 ar_accounts / ar_transactions，跳过\n");
  db.close();
  process.exit(0);
}

const accounts = all(
  `SELECT a.id, a.code, a.name, a.company_id, COALESCE(a.balance, 0) AS balance,
          (SELECT COALESCE(SUM(amount), 0) FROM ar_transactions t WHERE t.ar_account_id = a.id) AS txsum,
          (SELECT COUNT(*) FROM ar_transactions t WHERE t.ar_account_id = a.id) AS cnt
     FROM ar_accounts a
    WHERE a.hotel_id = ?
    ORDER BY a.id`,
  [HOTEL]
);

const drift = accounts.filter((a) => Math.abs(round2(a.balance) - round2(a.txsum)) > 0.005);

console.log(`\n账户 ${accounts.length} 个，其中「余额 ≠ 流水合计」${drift.length} 个\n`);

if (drift.length === 0) {
  console.log("✅ 全部自洽，无需修复\n");
  db.close();
  process.exit(0);
}

for (const a of drift) {
  const gap = round2(a.balance - a.txsum);
  console.log(`  ${String(a.code).padEnd(7)} ${String(a.name).padEnd(14)} 余额 ${String(a.balance).padStart(8)} · 流水 ${String(a.txsum).padStart(8)}（${a.cnt} 笔）· 差 ${gap}`);
}

if (!APPLY) {
  console.log("\n【只报告】加 --apply 备份后写库；要同时补台账再加 --ledgers\n");
  db.close();
  process.exit(0);
}

/* 备份 */
const backupDir = join(root, "data", "backup");
if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `pms.db.bak-ar-seed-${stamp}.db`);
copyFileSync(dbPath, backupPath);
console.log(`\n已备份：${backupPath}`);

let fixedTx = 0;
let fixedLedger = 0;

db.exec("BEGIN IMMEDIATE");
try {
  for (const a of drift) {
    const gap = round2(a.balance - a.txsum);
    if (Math.abs(gap) < 0.005) continue;

    /*
     * 补一条期初余额结转流水
     *
     * biz_date：优先取该账户最早一条台账的营业日；没有台账就取今天。
     * 这样期初结转排在所有业务之前，账龄计算不会把它算成「刚发生」。
     */
    const earliest = has("ar_ledgers")
      ? one(`SELECT MIN(biz_date) AS d FROM ar_ledgers WHERE hotel_id = ? AND company_id = ?`, [HOTEL, a.company_id])?.d
      : null;
    const bizDate = earliest ?? new Date().toISOString().slice(0, 10);

    const cols = all(`PRAGMA table_info(ar_transactions)`).map((c) => c.name);
    const payload = {
      hotel_id: HOTEL,
      ar_account_id: a.id,
      /* type：老库可能叫 kind 或 type，两个都试 */
      type: "POST",
      kind: "POST",
      amount: gap,
      biz_date: bizDate,
      remark: `期初余额结转（自动补齐：原余额 ${a.balance}，原流水合计 ${a.txsum}，差额 ${gap}）`,
      operator: "系统补档",
      created_at: nowIso(),
    };
    const use = Object.keys(payload).filter((k) => cols.includes(k));
    run(
      `INSERT INTO ar_transactions (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`,
      use.map((k) => payload[k])
    );
    fixedTx++;

    /* 台账：只有绑了协议单位才建（ar_ledgers.company_id NOT NULL） */
    if (WITH_LEDGERS && has("ar_ledgers") && a.company_id != null) {
      const lcols = all(`PRAGMA table_info(ar_ledgers)`).map((c) => c.name);
      const dueDate = (() => {
        const [y, m, d] = bizDate.split("-").map(Number);
        const t = Date.UTC(y, m - 1, d) + 30 * 86400000;
        const dt = new Date(t);
        return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
      })();
      const lpayload = {
        hotel_id: HOTEL,
        company_id: a.company_id,
        folio_id: null,
        folio_no: null,
        kind: "CHARGE",
        amount: gap,
        settled_amount: 0,
        status: gap > 0 ? "OPEN" : "SETTLED",
        biz_date: bizDate,
        due_date: dueDate,
        remark: `期初余额结转（自动补齐）`,
        created_at: nowIso(),
      };
      const luse = Object.keys(lpayload).filter((k) => lcols.includes(k));
      run(
        `INSERT INTO ar_ledgers (${luse.join(",")}) VALUES (${luse.map(() => "?").join(",")})`,
        luse.map((k) => lpayload[k])
      );
      fixedLedger++;
    }
  }

  run(`INSERT INTO op_logs (hotel_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)`, [
    HOTEL,
    "AR 流水补齐",
    `补期初余额结转 ${fixedTx} 条${WITH_LEDGERS ? `、台账 ${fixedLedger} 行` : ""}（账户有余额但流水为空）`,
    "系统补档",
    nowIso(),
  ]);

  db.exec("COMMIT");
  console.log(`\n✅ 补流水 ${fixedTx} 条${WITH_LEDGERS ? `、补台账 ${fixedLedger} 行` : ""}`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`\n❌ 失败已回滚：${e.message}`);
  db.close();
  process.exit(1);
}

/* 复核 */
const left = all(
  `SELECT a.id, a.code, COALESCE(a.balance,0) AS b,
          (SELECT COALESCE(SUM(amount),0) FROM ar_transactions t WHERE t.ar_account_id = a.id) AS s
     FROM ar_accounts a WHERE a.hotel_id = ?`,
  [HOTEL]
).filter((x) => Math.abs(round2(x.b) - round2(x.s)) > 0.005);

console.log(`复核：余额 ≠ 流水合计的账户 ${left.length} 个（应为 0）`);
if (has("ar_ledgers")) {
  const lc = one(`SELECT COUNT(*) AS c FROM ar_ledgers WHERE hotel_id = ?`, [HOTEL])?.c ?? 0;
  console.log(`      ar_ledgers ${lc} 行`);
}
console.log("");

db.close();
process.exit(left.length === 0 ? 0 : 1);
