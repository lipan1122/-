/**
 * 账务一致性修复：folios.paid_amount 与 payments 流水合计对不上的补录
 *
 * 背景：早期版本的「预收款（押金）」只累加了 folios.paid_amount，
 * 没有写 payments 流水，导致对账差异（整改报告 P1-5）。
 *
 * 规则：以 paid_amount 为准（它是业务上认可的已收金额），
 *       差额补一条 payments 流水，备注「历史押金补录」，让对账闭合。
 *
 * 用法：
 *   node scripts/fix-payment-mismatch.mjs            # dry-run
 *   node scripts/fix-payment-mismatch.mjs --apply
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB_PATH = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const APPLY = process.argv.includes("--apply");
const db = new DatabaseSync(DB_PATH);

const rows = db.prepare(
  `SELECT f.id, f.hotel_id, f.folio_no, f.stay_id, f.paid_amount,
          COALESCE((SELECT SUM(amount) FROM payments p WHERE p.folio_id = f.id), 0) AS sum_pay
     FROM folios f
    WHERE ABS(f.paid_amount - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.folio_id = f.id), 0)) > 0.01
    ORDER BY f.id`
).all();

console.log(`数据库：${DB_PATH}`);
console.log(`对账不一致账单 ${rows.length} 张\n`);

if (rows.length === 0) {
  console.log("账务已一致，无需修复 ✅");
  process.exit(0);
}

for (const r of rows) {
  const diff = Math.round((Number(r.paid_amount) - Number(r.sum_pay)) * 100) / 100;
  console.log(
    `  ${r.folio_no}  账单已收 ${Number(r.paid_amount).toFixed(2)}  流水 ${Number(r.sum_pay).toFixed(2)}  差额 ${diff.toFixed(2)}`
  );
}

if (!APPLY) {
  console.log("\ndry-run，未写入。加 --apply 补录流水。");
  process.exit(0);
}

const now = new Date().toISOString();
let fixed = 0;
db.exec("BEGIN");
try {
  for (const r of rows) {
    const diff = Math.round((Number(r.paid_amount) - Number(r.sum_pay)) * 100) / 100;
    if (Math.abs(diff) < 0.01) continue;
    const payNo = `HIST${Date.now()}${r.id}`;
    db.prepare(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      r.hotel_id,
      r.id,
      r.stay_id,
      payNo,
      "现金",
      diff,
      now.slice(0, 10),
      diff > 0 ? "历史押金补录（对账修复）" : "历史差异冲减（对账修复）",
      now,
      "系统修复"
    );
    fixed += 1;
  }
  db.exec("COMMIT");
  console.log(`\n已补录 ${fixed} 张账单的流水`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("修复失败已回滚:", e.message);
  process.exit(1);
}

const left = db.prepare(
  `SELECT COUNT(*) AS c FROM folios f
    WHERE ABS(f.paid_amount - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.folio_id = f.id), 0)) > 0.01`
).get().c;
console.log(`校验：剩余不一致 ${left} 张`);
db.close();
process.exit(left === 0 ? 0 : 1);
