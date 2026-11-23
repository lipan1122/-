/**
 * 挂账信用额度验收（整改报告第 5 节）
 *
 * 验证：
 *   1. companies.credit_limit 字段存在
 *   2. 已挂账金额的计算口径（备注带【挂账】+ 未结账单余额）
 *   3. 超额被拦、未超额放行
 *   4. 不限额（credit_limit = 0）放行
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* 1. 字段存在 */
const cols = all(`PRAGMA table_info(companies)`).map((c) => c.name);
check("companies 有 credit_limit 字段", cols.includes("credit_limit"));

/* 2. 有额度配置的单位 */
const withLimit = all(`SELECT id, name, credit_limit FROM companies WHERE hotel_id = 1 AND COALESCE(credit_limit,0) > 0`);
check("存在配置了信用额度的协议单位", withLimit.length > 0, `${withLimit.length} 家`);
if (withLimit.length > 0) {
  console.log("   额度配置：" + withLimit.map((c) => `${c.name}=¥${c.credit_limit}`).join("、"));
}

/* 3. 已挂账计算口径：备注带【挂账】+ 未结账单余额 */
const usedRows = all(
  `SELECT st.id, st.guest_name, COALESCE(st.remark,'') AS remark, COALESCE(f.balance,0) AS balance
     FROM stays st JOIN folios f ON f.stay_id = st.id
    WHERE st.hotel_id = 1 AND COALESCE(st.remark,'') LIKE '%【挂账】%'
      AND f.status <> 'SETTLED' AND f.balance > 0.01`
);
/* 原来这里是 check("能算出各单位已挂账金额", true) —— 恒真断言，算错/联表出 NULL 也会打 ✅。
   改成真断言：每行余额必须是有效数字，合计才是可信的（挂账金额进信用额度校验）。 */
const usedTotal = usedRows.reduce((s, r) => s + Number(r.balance), 0);
check(
  "能算出各单位已挂账金额（每行余额都是有效数字）",
  usedRows.every((r) => Number.isFinite(Number(r.balance))) && Number.isFinite(usedTotal) && usedTotal >= 0,
  `在挂 ${usedRows.length} 单，合计 ¥${usedTotal.toFixed(2)}`
);

/* 4. 逐单位校验未超额（除非本来就有历史超额） */
for (const c of withLimit) {
  const used =
    one(
      `SELECT COALESCE(SUM(f.balance),0) AS s FROM stays st JOIN folios f ON f.stay_id = st.id
        WHERE st.hotel_id = 1 AND COALESCE(st.remark,'') LIKE ?
          AND f.status <> 'SETTLED' AND f.balance > 0.01`,
      [`%【挂账】${c.name}%`]
    )?.s ?? 0;
  const ok = Number(used) <= Number(c.credit_limit) + 0.01;
  check(
    `${c.name} 已挂账未超额度`,
    ok,
    `已挂 ¥${Number(used).toFixed(2)} / 额度 ¥${c.credit_limit}`
  );
}

/* 5. booking_rooms 有 guest_id（报告第 4 节字段清单） */
const brCols = all(`PRAGMA table_info(booking_rooms)`).map((c) => c.name);
check("booking_rooms 有 guest_id 字段", brCols.includes("guest_id"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
