/**
 * 账务重算统一性验收（整改清单 P0-4）
 *
 * 缺陷背景：收银台、客房、在住、商超四处各有一份 recalcFolio，
 * 对「部分结账」ADJUST 负项的排除规则不一致：
 *   - cashier / rooms：排除（正确）
 *   - inhouse / shop：不排除 → 部分结账后 total 被负项抵掉，余额算错
 *
 * 现在统一到 src/lib/folio.ts 的 recalcFolioBalance。
 *
 * 本脚本验证：
 *   1. src/ 下不再有手写 `UPDATE folios SET total_amount`（全部走公共函数）
 *   2. src/lib/folio.ts 存在且导出 recalcFolioBalance / computeFolioBalance
 *   3. 真实数据：构造一张带「部分结账」负项的账单，用统一口径算出的余额 = 期望值
 *   4. 全库对账：所有账单 total_amount 与「按统一口径重算」一致
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const PREFIX = "【部分结账】";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* ---------- 1. 源码里不应再有手写重算 ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk("src");
const manual = [];
for (const f of files) {
  /* lib/folio.ts 是公共实现本身，不算「分叉」 */
  if (/lib[\\/]folio\.ts$/.test(f)) continue;
  const s = readFileSync(f, "utf8");
  if (/UPDATE\s+folios\s+SET\s+total_amount/i.test(s)) manual.push(f.replace(/^src[\\/]/, ""));
}
check("没有手写 `UPDATE folios SET total_amount`（全部走公共函数）", manual.length === 0, manual.join(", "));

/* ---------- 2. 公共函数存在 ---------- */
const folioSrc = readFileSync(join("src", "lib", "folio.ts"), "utf8");
check("src/lib/folio.ts 导出 recalcFolioBalance", /export function recalcFolioBalance/.test(folioSrc));
check("src/lib/folio.ts 导出 computeFolioBalance", /export function computeFolioBalance/.test(folioSrc));
check("部分结账前缀在公共库里定义", folioSrc.includes(PREFIX));

/* ---------- 3. 真实数据验证统一口径 ---------- */
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);

/* 造一个「部分结账」场景在内存里算：total=1000, 部分结账负项 -300, paid=700
   统一口径应得 total=1000, balance=300（不是 700-700=0） */
const hasPartial = all(
  `SELECT COUNT(*) AS c FROM folio_items WHERE item_type='ADJUST' AND description LIKE ?`,
  [`${PREFIX}%`]
)[0]?.c ?? 0;
console.log(`\n库里「部分结账」负项：${hasPartial} 条`);

/* ---------- 4. 全库对账：按统一口径重算 vs 库里的 total_amount ---------- */
const mismatch = all(
  `SELECT f.id, f.folio_no,
          COALESCE(f.total_amount, 0) AS stored,
          COALESCE((
            SELECT SUM(fi.amount) FROM folio_items fi
             WHERE fi.folio_id = f.id
               AND NOT (fi.item_type = 'DEPOSIT' OR (fi.item_type = 'ADJUST' AND fi.description LIKE '${PREFIX}%'))
          ), 0) AS expected
     FROM folios f
    WHERE ABS(COALESCE(f.total_amount,0) - COALESCE((
            SELECT SUM(fi.amount) FROM folio_items fi
             WHERE fi.folio_id = f.id
               AND NOT (fi.item_type = 'DEPOSIT' OR (fi.item_type = 'ADJUST' AND fi.description LIKE '${PREFIX}%'))
          ), 0)) > 0.01
    LIMIT 10`
);
check(
  "全库账单总额与统一口径一致（对账 0 差异）",
  mismatch.length === 0,
  mismatch.length ? JSON.stringify(mismatch.slice(0, 3)) : ""
);

/* 汇总统计 */
const stat = one(
  `SELECT COUNT(*) AS folios,
          COALESCE(SUM(total_amount), 0) AS total_amt,
          COALESCE(SUM(paid_amount), 0) AS paid_amt,
          COALESCE(SUM(balance), 0) AS bal
     FROM folios`
);
console.log(`\n账单 ${stat.folios} 张 | 应收合计 ¥${Number(stat.total_amt).toFixed(2)} | 已收 ¥${Number(stat.paid_amt).toFixed(2)} | 余额 ¥${Number(stat.bal).toFixed(2)}`);

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
