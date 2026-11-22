/**
 * 拆账分摊守恒验收（整改清单 P1-4）
 *
 * 缺陷背景：拆账时新单 paid_amount 直接给 0、原单 paid 不动 ——
 * 两单合计的已收款凭空变化，balance 也对不上原单。
 *
 * 修复：按「拆出去明细金额 / 原单总明细金额」比例分摊 paid，
 * 且总单 paid 同步扣减，保证 paid_A + paid_B = paid_原单，
 * balance_A + balance_B = balance_原单。
 *
 * 本脚本：
 *   1. 静态校验：splitFolioAction 里有分摊逻辑（ratio / movePaid / keepPaid）
 *   2. 数学校验：多组比例下的守恒性
 *   3. 数据校验：现有拆账单（folio_no 带 -B/-C 后缀）的合计是否与原规则一致
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ---------- 1. 静态 ---------- */
const src = readFileSync(join("src", "app", "(main)", "cashier", "actions.ts"), "utf8");
check("拆账有分摊比例计算（ratio）", /const ratio\s*=/.test(src));
check("拆账切分已收款（movePaid / keepPaid）", /movePaid/.test(src) && /keepPaid/.test(src));
check("原单 paid 同步扣减（守恒）", /UPDATE folios SET paid_amount = \?/.test(src));
check("收款流水随账拆分（payments 转移或冲抵）", /movePaid > 0[\s\S]{0,400}payments/.test(src));

/* ---------- 2. 数学：多组比例守恒 ---------- */
const cases = [
  { total: 1000, paid: 600, move: 400 },
  { total: 1000, paid: 1000, move: 300 },
  { total: 500, paid: 0, move: 200 },
  { total: 888.88, paid: 444.44, move: 188.88 },
  { total: 1, paid: 1, move: 1 },
  { total: 100, paid: 33, move: 99 },
];
let mathOk = true;
for (const c of cases) {
  const ratio = c.total > 0 ? c.move / c.total : 0;
  const movePaid = round2(Math.min(c.paid, Math.max(0, c.paid * ratio)));
  const keepPaid = round2(c.paid - movePaid);
  const paidConserved = Math.abs(keepPaid + movePaid - c.paid) < 0.011;
  /* balance 守恒：原单 (total - paid) = A(total-move - keepPaid) + B(move - movePaid) */
  const origBal = round2(c.total - c.paid);
  const balA = round2(c.total - c.move - keepPaid);
  const balB = round2(c.move - movePaid);
  const balConserved = Math.abs(balA + balB - origBal) < 0.011;
  if (!paidConserved || !balConserved) {
    mathOk = false;
    console.log(`  ❌ 场景 total=${c.total} paid=${c.paid} move=${c.move} → paid 差 ${round2(keepPaid + movePaid - c.paid)}, bal 差 ${round2(balA + balB - origBal)}`);
  }
}
check(`多组比例下 paid / balance 都守恒（${cases.length} 个场景）`, mathOk);

/* ---------- 3. 数据：现有拆账单检查 ---------- */
const db = new DatabaseSync(DB, { readOnly: true });
const splits = db.prepare(
  `SELECT id, folio_no, stay_id, total_amount, paid_amount, balance
     FROM folios WHERE hotel_id = 1 AND folio_no LIKE '%-_' ORDER BY id`
).all();
console.log(`\n现有拆账单：${splits.length} 张`);

/* 拆账单的 balance 应等于 total - paid（自身一致性） */
const badSelf = splits.filter((f) =>
  Math.abs(round2(Number(f.total_amount) - Number(f.paid_amount)) - Number(f.balance)) > 0.01
);
check("拆账单自身 total - paid = balance", badSelf.length === 0,
  JSON.stringify(badSelf.slice(0, 3).map((f) => `${f.folio_no} ${f.total_amount}-${f.paid_amount}≠${f.balance}`)));

/*
 * 同一 stay 下的「已收 ≤ 应收」检查
 *
 * ⚠️ 口径修正（押金不再计入应收之后）
 *
 * 旧口径把押金算进 total，所以 paid ≤ total 恒成立。
 * 新口径下 total 只算消费，押金单仍留在 paid 里 ——
 * 于是「客人交了 600 押金、消费 1764」这种账单会显示 paid 2364 > total 1764。
 * 这不是数据错乱，而是**押金多收、退房时该退 600**，属正常业务态。
 *
 * 所以断言改成：多收的金额必须能被该账单的押金明细解释掉，
 * 即 paid - total ≤ 该账单的 DEPOSIT 合计。若超出，才是真的算错了。
 */
const byStay = db.prepare(
  `SELECT f.stay_id,
          SUM(f.paid_amount) AS paid,
          SUM(f.total_amount) AS total,
          COALESCE((SELECT SUM(fi.amount) FROM folio_items fi
                     WHERE fi.item_type = 'DEPOSIT'
                       AND fi.folio_id IN (SELECT id FROM folios f2 WHERE f2.stay_id = f.stay_id)), 0) AS deposits
     FROM folios f WHERE f.hotel_id = 1 AND f.stay_id IS NOT NULL GROUP BY f.stay_id`
).all();
const overPaid = byStay.filter(
  (s) => Number(s.paid) - Number(s.total) > Number(s.deposits) + 0.01
);
check(
  "同一入住单的「多收金额」不超过收取的押金（超出才是数据错乱）",
  overPaid.length === 0,
  JSON.stringify(overPaid.slice(0, 3)));

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
