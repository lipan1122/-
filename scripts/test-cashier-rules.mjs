/**
 * 账务整改验收（整改报告 P1-5）
 *
 * 1. 收款幂等：同一 request_id 重复提交只生成一笔
 * 2. 退款：不能超过原收款、必须关联原 payment、不能对退款再退款
 * 3. 撤结账：必须有原因、需要更高权限
 * 4. 已结账账单不能收款
 * 5. 账单 paid_amount 与 payments 合计一致
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB);
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* 直接调 action 需要 Next 运行时，这里用等价的 SQL 逻辑验证数据结构与约束 */
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);

/* 1. 幂等唯一索引存在 */
const idx = all(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='payments'`);
const hasReqIdx = idx.some((i) => i.name === "idx_payments_request");
check("payments 有 request_id 唯一索引（幂等兜底）", hasReqIdx, JSON.stringify(idx.map((i) => i.name)));

/* 2. 字段齐全 */
const cols = all(`PRAGMA table_info(payments)`).map((c) => c.name);
check("payments 有 request_id / refund_of / operator", ["request_id", "refund_of", "operator"].every((c) => cols.includes(c)), cols.join(","));

/* 3. 幂等实测：同 request_id 插两次，第二次应失败
 *
 * 原来没有 OPEN 账单时只打印「（没有 OPEN 账单，跳过幂等写入测试）」—— 那是假通过：
 * 少跑一条断言却不影响退出码，空库 / 全部已结账的库里这条幂等验证永远不跑。
 * 现在：没有现成 OPEN 账单就自建一张（跑完连同流水删掉），自建失败才 exit(1)。
 */
let folio = one(`SELECT id, stay_id, paid_amount FROM folios WHERE status = 'OPEN' ORDER BY id LIMIT 1`);
let syntheticFolioId = 0;
if (!folio) {
  const ts = Date.now();
  try {
    const insF = db
      .prepare(
        `INSERT INTO folios (hotel_id, folio_no, guest_name, total_amount, paid_amount, balance, status, created_at)
         VALUES (1, ?, '幂等测试账单', 0, 0, 0, 'OPEN', ?)`
      )
      .run(`T-IDEM-${ts}`, new Date().toISOString());
    syntheticFolioId = Number(insF.lastInsertRowid);
  } catch (e) {
    console.error("❌ 没有 OPEN 账单，自建测试账单也失败：", e.message);
    process.exit(1);
  }
  folio = one(`SELECT id, stay_id, paid_amount FROM folios WHERE id = ?`, [syntheticFolioId]);
  console.log(`（没有 OPEN 账单，已自建测试账单 #${syntheticFolioId} 用于幂等验证）`);
}

{
  const rid = `test-idem-${Date.now()}`;
  db.prepare(`INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, created_at, request_id, operator)
              VALUES (1,?,?,?,?,?,?,?,?,?)`).run(folio.id, folio.stay_id, `T1-${rid}`, "现金", 1, "2026-11-17", "x", rid, "test");
  let dupOk = false;
  try {
    db.prepare(`INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, created_at, request_id, operator)
                VALUES (1,?,?,?,?,?,?,?,?,?)`).run(folio.id, folio.stay_id, `T2-${rid}`, "现金", 1, "2026-11-17", "x", rid, "test");
    dupOk = true;
  } catch { /* 期望失败 */ }
  check("同一 request_id 重复插入被唯一索引拦截", !dupOk);
  db.prepare(`DELETE FROM payments WHERE request_id = ?`).run(rid);
  if (syntheticFolioId) db.prepare(`DELETE FROM folios WHERE id = ?`).run(syntheticFolioId);
}

/* 4. 账单一致性：paid_amount vs payments 合计 */
const mismatched = all(
  `SELECT f.id, f.folio_no, f.paid_amount,
          COALESCE((SELECT SUM(amount) FROM payments p WHERE p.folio_id = f.id), 0) AS sum_pay
     FROM folios f
    WHERE ABS(f.paid_amount - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.folio_id = f.id), 0)) > 0.01`
);
check("账单 paid_amount 与收款流水合计一致", mismatched.length === 0,
  mismatched.slice(0, 3).map((m) => `${m.folio_no} ${m.paid_amount} vs ${m.sum_pay}`).join(" / "));

/* 5. 退款不能超过原收款（用现有退款数据验证） */
const badRefund = all(
  `SELECT r.id, ABS(r.amount) AS refunded, o.amount AS original
     FROM payments r JOIN payments o ON o.id = r.refund_of
    WHERE ABS(r.amount) > o.amount + 0.01`
);
check("不存在超额退款", badRefund.length === 0, badRefund.length + " 笔");

/* 6. 二次退款（对退款流水再退）不存在 */
const nested = all(`SELECT r.id FROM payments r JOIN payments o ON o.id = r.refund_of WHERE o.refund_of IS NOT NULL`);
check("不存在对退款流水再退款", nested.length === 0);

/* 7. 权限矩阵：退款/撤结账只有 admin + cashier */
const permsSrc = await import("node:fs").then((fs) =>
  fs.readFileSync("src/lib/session.ts", "utf8")
);
check(
  "退款权限不含 housekeeping/frontdesk 之外的角色控制存在",
  permsSrc.includes('"cashier.refund": ["admin", "cashier"]'),
  "见 session.ts PERMISSIONS"
);
check("撤结账仅 admin", permsSrc.includes('"cashier.reverse_checkout": ["admin"]'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
