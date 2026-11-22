/**
 * 重算全部账单（押金口径修正）
 *
 * 背景：`src/lib/folio.ts` 改了口径 —— 押金 DEPOSIT 不再计入应收总额
 * （押金是负债，不是收入）。改了公式，历史数据必须按新口径重算，
 * 否则页面显示的还是旧值，退房流程也拿不到正确的「应退金额」。
 *
 * 影响：含押金的账单会从「余额 0 / 已结清」变成「余额为负 / 应退客人」。
 * 这是**修正**，不是错误 —— 原来把押金当消费，客人多付的钱退不回去。
 *
 * 用法：
 *   node scripts/recalc-all-folios.mjs --check   只报告会改多少张，不写库
 *   node scripts/recalc-all-folios.mjs           实际重算
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const CHECK_ONLY = process.argv.includes("--check");

const PREFIX = "【部分结账】";
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const db = new DatabaseSync(DB);
const all = (s, p = []) => db.prepare(s).all(...p);
const one = (s, p = []) => db.prepare(s).get(...p);

/* 用新模式算（与 lib/folio.ts 的 NON_REVENUE_ITEM 一致） */
const NEW_TOTAL_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items
   WHERE folio_id = ? AND hotel_id = ?
     AND NOT (item_type = 'DEPOSIT' OR (item_type = 'ADJUST' AND description LIKE '${PREFIX}%'))`;

/* 旧模式算（把押金算进去）—— 只用于对比 */
const OLD_TOTAL_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items
   WHERE folio_id = ? AND hotel_id = ?
     AND NOT (item_type = 'ADJUST' AND description LIKE '${PREFIX}%')`;

const folios = all(`SELECT id, hotel_id, folio_no, total_amount, paid_amount, balance, status FROM folios ORDER BY id`);

console.log(`\n共 ${folios.length} 张账单，模式：${CHECK_ONLY ? "只检查" : "实际重算"}\n`);

let changed = 0;
let unchanged = 0;
const samples = [];

db.exec("BEGIN");
try {
  for (const f of folios) {
    const newTotal = round2(one(NEW_TOTAL_SQL, [f.id, f.hotel_id])?.t ?? 0);
    const oldTotal = round2(one(OLD_TOTAL_SQL, [f.id, f.hotel_id])?.t ?? 0);
    const paid = round2(Number(f.paid_amount ?? 0));
    const newBalance = round2(newTotal - paid);
    const oldBalance = round2(Number(f.balance ?? 0));

    const totalDiff = Math.abs(newTotal - Number(f.total_amount ?? 0)) > 0.01;
    const balanceDiff = Math.abs(newBalance - oldBalance) > 0.01;

    if (!totalDiff && !balanceDiff) {
      unchanged++;
      continue;
    }

    changed++;
    if (samples.length < 10) {
      samples.push({
        no: f.folio_no,
        oldTotal: Number(f.total_amount ?? 0),
        newTotal,
        deposit: round2(oldTotal - newTotal),
        paid,
        oldBalance,
        newBalance,
        status: f.status,
      });
    }

    if (!CHECK_ONLY) {
      /*
       * 状态也跟着调整：
       *   · 新余额 ≈ 0       → SETTLED（已结清）
       *   · 新余额 > 0       → OPEN（还欠钱）
       *   · 新余额 < 0       → 保持原状态（退款是人工动作，不能自动置 REFUNDED）
       *     但如果是 SETTLED 且有应退，改成 OPEN 让前台看到「这里还有钱要退」
       */
      let newStatus = f.status;
      if (Math.abs(newBalance) <= 0.01) newStatus = "SETTLED";
      else if (newBalance > 0.01) newStatus = "OPEN";
      else if (f.status === "SETTLED") newStatus = "OPEN";

      db.prepare(`UPDATE folios SET total_amount = ?, balance = ?, status = ? WHERE id = ? AND hotel_id = ?`).run(
        newTotal,
        newBalance,
        newStatus,
        f.id,
        f.hotel_id
      );
    }
  }
  db.exec(CHECK_ONLY ? "ROLLBACK" : "COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.log("❌ 失败，已回滚：", e instanceof Error ? e.message : String(e));
  db.close();
  process.exit(1);
}

console.log(`需要重算：${changed} 张   无需变动：${unchanged} 张\n`);

if (samples.length > 0) {
  console.log("  样例（前 10 张）：");
  console.log("  单号      旧总额   新总额   其中押金  已收     旧余额    新余额");
  for (const s of samples) {
    console.log(
      `  ${s.no.padEnd(10)}${String(s.oldTotal).padStart(7)}  ${String(s.newTotal).padStart(7)}  ` +
        `${String(s.deposit).padStart(8)}  ${String(s.paid).padStart(7)}  ` +
        `${String(s.oldBalance).padStart(8)}  ${String(s.newBalance).padStart(8)}`
    );
  }
  console.log("\n  新余额为负 = 应该退给客人的押金");
}

/* 汇总：应退总额 */
const refundTotal = one(
  `SELECT COALESCE(SUM(-balance), 0) AS t FROM folios WHERE balance < -0.01`
)?.t ?? 0;
const oweTotal = one(
  `SELECT COALESCE(SUM(balance), 0) AS t FROM folios WHERE balance > 0.01`
)?.t ?? 0;
console.log(`\n  全店应退客人：¥${round2(Number(refundTotal)).toFixed(2)}`);
console.log(`  全店应收客人：¥${round2(Number(oweTotal)).toFixed(2)}\n`);

db.close();
