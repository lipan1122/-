/**
 * AR 应收台账（整改 P1-5：协议挂账未结转 AR）
 *
 * ── 缺陷 ──
 * chargeToCompanyAction 挂账时只往 stays.remark 盖一个「【挂账】公司名」标记：
 *   · 信用额度的「已挂账金额」靠 LIKE '%【挂账】公司名%' 匹配备注算出来，备注一改口径就失准；
 *   · 账根本没进 AR 台账，财务在应收报表里看不到这笔钱；
 *   · 没有账期到期日、没有逐笔核销，账龄只能靠估。
 *
 * ── 本文件提供的东西 ──
 *   ar_ledgers  笔级台账：一次挂账一行，带 folio 关联、营业日、账期到期日、
 *               已核销金额与状态（OPEN / PARTIAL / SETTLED / WRITTEN_OFF）。
 *   postArCharge         挂账时落台账（幂等：同账单同单位同金额的未结台账不重复建）
 *   getCompanyOutstanding 某协议单位当前未结应收 —— 信用额度校验改用它，不再看备注
 *   settleAr             逐笔核销（付款 / 减免），自动推进 PARTIAL → SETTLED
 *   listArAging          账龄分档（0–30 / 31–60 / 61–90 / 90+）
 *
 * ── 与既有 ar_accounts / ar_transactions 的关系（不重复造轮子，也不硬合并）──
 *   ar_accounts / ar_transactions 是「账户维度总账」：一个 AR 账户一个余额，
 *   由 src/app/(main)/ar/actions.ts 懒建并灌种子，报表与核销都按它算。
 *   ar_ledgers 是「协议单位维度的笔级明细」，主键 company_id。
 *   两者是总账 vs 明细的关系，company 与 ar_account 之间没有现成外键，
 *   强行合并会改变既有 5 个种子账户 / 55 条流水的口径，风险大于收益，
 *   因此新建台账表，并在 /ar 页面并排展示。
 *
 * ── 事务 ──
 * 与 member-wallet.ts 一致用 SAVEPOINT：本文件会在收银台已有的 tx() 内被调用，
 * BEGIN 嵌套会抛错，SAVEPOINT 在有/无外层事务两种场景下都安全。
 */

import { all, get, getDb, run } from "@/lib/db";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";

/** 台账状态：未结 / 部分核销 / 已结清 / 已核销（坏账注销） */
export type ArStatus = "OPEN" | "PARTIAL" | "SETTLED" | "WRITTEN_OFF";

/** 挂账入参：folio 与金额必须来自调用方已经校验过的账务数据 */
export type ArChargeInput = {
  companyId: number;
  folioId?: number;
  folioNo?: string;
  /** 应收金额（正数） */
  amount: number;
  /** 营业日 YYYY-MM-DD，缺省今天 */
  bizDate?: string;
  /** 账期天数，缺省 30 天，允许 0–365 */
  dueDays?: number;
  operator?: string;
  remark?: string;
};

/** 挂账结果 */
export type ArPostResult = { ok: true; id: number } | { error: string };

/** 核销结果：settled 为本次核销后该笔的累计已核销金额 */
export type ArSettleResult = { ok: true; settled: number; status: string } | { error: string };

/** 账龄分档 */
export type ArAgingBucket = { bucket: string; amount: number };

/** 台账行（页面 / 测试脚本用） */
export type ArLedgerRow = {
  id: number;
  company_id: number;
  company_name: string | null;
  folio_id: number | null;
  folio_no: string | null;
  biz_date: string;
  amount: number;
  settled_amount: number;
  outstanding: number;
  due_date: string | null;
  status: string;
  operator: string | null;
  remark: string | null;
  created_at: string | null;
};

const MAX_AMOUNT = 9999999;
const EPS = 0.001;
const DEFAULT_DUE_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 账龄分档定义（顺序固定，页面与报表按这个顺序渲染） */
const AGING_BUCKETS = ["0–30 天", "31–60 天", "61–90 天", "90 天以上"] as const;

let schemaReady = false;
let savepointSeq = 0;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 懒建表 + 索引（幂等）
 * DDL 与 scripts/migrate-all.mjs 第 9 段完全一致；迁移脚本是 schema 的唯一来源，
 * 这里是「页面先跑起来」的兜底。
 */
export function ensureArLedgerSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ar_ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      folio_id INTEGER,
      folio_no TEXT,
      biz_date TEXT NOT NULL,
      amount REAL NOT NULL,
      settled_amount REAL DEFAULT 0,
      due_date TEXT,
      status TEXT DEFAULT 'OPEN',
      operator TEXT,
      remark TEXT,
      created_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_ledgers_company ON ar_ledgers(hotel_id, company_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_ledgers_bizdate ON ar_ledgers(hotel_id, biz_date)`);
  schemaReady = true;
}

/** 事务包装（SAVEPOINT）：可安全嵌在别处已经开启的 tx() 里 */
function atomically<T>(fn: () => T): T {
  ensureArLedgerSchema();
  const db = getDb();
  const sp = `ar_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    try {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    } catch {
      /* 回滚失败时保留原始异常 */
    }
    throw e;
  }
}

/** 营业日归一：非法输入回落到今天 */
function normalizeBizDate(value?: string): string {
  const raw = String(value ?? "").trim();
  return DATE_RE.test(raw) ? raw : todayStr();
}

/** 营业日 + N 天，返回 YYYY-MM-DD */
function addDaysTo(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

/** 自然日差（同日为 0） */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

/** 账龄天数 → 分档下标 */
function bucketIndex(days: number): number {
  if (days <= 30) return 0;
  if (days <= 60) return 1;
  if (days <= 90) return 2;
  return 3;
}

/** 协议单位存在性校验（挂账前必须确认单位属本酒店） */
function companyNameOf(hotelId: number, companyId: number): string | undefined {
  const row = get<{ name: string | null }>(`SELECT name FROM companies WHERE id = ? AND hotel_id = ?`, [
    companyId,
    hotelId,
  ]);
  return row?.name ?? undefined;
}

/**
 * 挂账入账：把一次「协议单位挂账」写进 AR 台账
 *
 * 幂等：同一酒店 + 同一协议单位 + 同一账单 + 同一金额且仍未结清时，
 * 认为这是重复提交（双击 / 网络重试），直接返回已存在的那一笔 id，不重复记应收。
 * 分两次挂不同金额（部分挂账）不受影响。
 *
 * 调用方（收银台）应在自己的事务内调用；本函数自身带 SAVEPOINT，嵌套安全。
 */
export function postArCharge(hotelId: number, input: ArChargeInput): ArPostResult {
  ensureArLedgerSchema();

  const companyId = Math.trunc(Number(input.companyId));
  if (!Number.isInteger(companyId) || companyId <= 0) return { error: "请选择协议单位后再挂账" };

  const companyName = companyNameOf(hotelId, companyId);
  if (companyName === undefined) return { error: `协议单位（ID ${companyId}）不存在，或不属于当前酒店` };

  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "挂账金额必须大于 0" };
  if (amount > MAX_AMOUNT) return { error: `挂账金额不能超过 ${fmtMoney(MAX_AMOUNT)}` };

  const bizDate = normalizeBizDate(input.bizDate);
  const rawDue = Number(input.dueDays ?? DEFAULT_DUE_DAYS);
  const dueDays = Number.isFinite(rawDue) ? Math.min(365, Math.max(0, Math.trunc(rawDue))) : DEFAULT_DUE_DAYS;
  const dueDate = addDaysTo(bizDate, dueDays);

  const folioId = Number.isFinite(Number(input.folioId)) && Number(input.folioId) > 0 ? Math.trunc(Number(input.folioId)) : null;
  const folioNo = input.folioNo ? String(input.folioNo).trim() || null : null;

  return atomically(() => {
    /*
     * 第 4 轮 P1-15：幂等键不能含金额，否则同一账单多次挂账会重复记账
     *
     * 旧逻辑只认「同单位 + 同账单 + **同金额** + 未结」的那一笔，
     * 于是同一账单分两次挂账（第一次 1000、后来消费 500 再挂 1500）时，
     * 金额不匹配 → 新增一行 → 台账未结余额虚增（实际应结 1500，变成 2500），
     * 而额度统计直接 SUM(amount - settled_amount)，额度被提前占死。
     *
     * 正确的幂等语义：「同一张账单在同一单位下只应有一条未结台账」。
     * 命中已有未结台账时**累加金额**，而不是新增一行。
     */
    const existed = get<{ id: number; amount: number }>(
      `SELECT id, amount FROM ar_ledgers
        WHERE hotel_id = ? AND company_id = ?
          AND COALESCE(folio_id, -1) = COALESCE(?, -1)
          AND status IN ('OPEN', 'PARTIAL')
        ORDER BY id ASC
        LIMIT 1`,
      [hotelId, companyId, folioId]
    );
    if (existed) {
      /*
       * 已有一条未结台账：把本次金额累加进去（同一账单继续挂账的场景）。
       * 但如果本次金额与已有金额完全相同，视为**重复提交**，直接返回不累加
       * —— 这是原来那个防重复提交的意图，用「金额相等」作为启发式判断保留，
       * 但只在「已有金额正好等于本次」时才判定为重复。
       */
      if (Math.abs(Number(existed.amount) - amount) < 0.001) {
        return { ok: true as const, id: existed.id };
      }
      run(
        `UPDATE ar_ledgers
            SET amount = amount + ?, remark = COALESCE(remark, '') || ?
          WHERE id = ? AND hotel_id = ?`,
        [amount, `；追加挂账 ${amount}`, existed.id, hotelId]
      );
      return { ok: true as const, id: existed.id };
    }

    const inserted = run(
      `INSERT INTO ar_ledgers
         (hotel_id, company_id, folio_id, folio_no, biz_date, amount, settled_amount,
          due_date, status, operator, remark, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'OPEN', ?, ?, ?)`,
      [
        hotelId,
        companyId,
        folioId,
        folioNo,
        bizDate,
        amount,
        dueDate,
        input.operator ?? null,
        input.remark ?? `协议单位挂账（${companyName}）`,
        nowIso(),
      ]
    );
    return { ok: true as const, id: inserted.lastInsertRowid };
  });
}

/**
 * 某协议单位的当前未结应收
 *
 * 口径：SUM(amount − settled_amount)，只算 OPEN / PARTIAL。
 * 这是信用额度校验的唯一来源（整改要求：不再用备注 LIKE 匹配）。
 */
export function getCompanyOutstanding(hotelId: number, companyId: number): number {
  ensureArLedgerSchema();
  const row = get<{ s: number | null }>(
    `SELECT COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS s
       FROM ar_ledgers
      WHERE hotel_id = ? AND company_id = ?
        AND status IN ('OPEN', 'PARTIAL')`,
    [hotelId, companyId]
  );
  return round2(Number(row?.s ?? 0));
}

/** 操作日志：op_logs 可能不存在（旧库），静默跳过，绝不因为审计失败而回滚账务 */
function writeArOpLog(hotelId: number, operator: string, action: string, detail: string): void {
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    /* 旧库没有 op_logs：账务已经写成功，审计缺失只记不到，不抛 */
  }
}

/**
 * 逐笔核销：登记协议单位还了多少钱（或财务减免）
 *
 * 规则：
 *   · 只能对 OPEN / PARTIAL 的台账核销；
 *   · 本次核销不能超过该笔未结余额；
 *   · 核销后自动推进状态：结清 → SETTLED，未结清 → PARTIAL。
 *
 * @param opts.remark 作为操作日志正文的一部分（便于对账时追溯是「付款」还是「减免」）
 */
export function settleAr(
  hotelId: number,
  arId: number,
  amount: number,
  opts: { operator?: string; remark?: string; bizDate?: string } = {}
): ArSettleResult {
  ensureArLedgerSchema();

  const id = Math.trunc(Number(arId));
  if (!Number.isInteger(id) || id <= 0) return { error: "缺少应收台账 ID" };

  const amt = round2(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return { error: "核销金额必须大于 0" };

  const row = get<{ id: number; amount: number; settled_amount: number | null; status: string; folio_no: string | null }>(
    `SELECT id, amount, settled_amount, status, folio_no
       FROM ar_ledgers WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) return { error: "应收台账不存在，或不属于当前酒店" };
  if (row.status === "SETTLED") return { error: "该笔应收已结清，不能重复核销" };
  if (row.status === "WRITTEN_OFF") return { error: "该笔应收已注销（坏账），不能核销" };

  const total = round2(Number(row.amount ?? 0));
  const settledBefore = round2(Number(row.settled_amount ?? 0));
  const outstanding = round2(total - settledBefore);
  if (amt > outstanding + EPS) {
    return {
      error: `核销金额不能超过该笔未结余额 ${fmtMoney(outstanding)}${row.folio_no ? `（账单 ${row.folio_no}）` : ""}`,
    };
  }

  const settled = round2(settledBefore + amt);
  const status: ArStatus = settled >= total - EPS ? "SETTLED" : "PARTIAL";
  const operator = String(opts.operator ?? "").trim() || "系统";
  const tail = opts.remark ? ` · ${opts.remark}` : "";

  return atomically(() => {
    run(
      `UPDATE ar_ledgers
          SET settled_amount = ?, status = ?
        WHERE id = ? AND hotel_id = ?`,
      [settled, status, id, hotelId]
    );
    writeArOpLog(
      hotelId,
      operator,
      "AR核销",
      `台账 #${id}${row.folio_no ? `（账单 ${row.folio_no}）` : ""} 核销 ${fmtMoney(amt)}，累计 ${fmtMoney(settled)} / ${fmtMoney(
        total
      )}，状态 ${status}${tail}`
    );
    return { ok: true as const, settled, status };
  });
}

/**
 * 账龄分档
 *
 * 账龄 = 今天 − 挂账营业日（biz_date），与 /ar 页面既有 FIFO 账龄口径一致。
 * 只统计 OPEN / PARTIAL 的未结余额；始终返回四个分档（无数据时为 0），
 * 让调用方不必判断分档是否存在。
 *
 * @param companyId 传了就只看这家协议单位，不传看全店
 */
export function listArAging(hotelId: number, companyId?: number): ArAgingBucket[] {
  ensureArLedgerSchema();

  const byCompany =
    Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? Math.trunc(Number(companyId)) : 0;
  const rows = all<{ biz_date: string; outstanding: number }>(
    `SELECT biz_date, amount - COALESCE(settled_amount, 0) AS outstanding
       FROM ar_ledgers
      WHERE hotel_id = ?
        AND status IN ('OPEN', 'PARTIAL')
        AND amount - COALESCE(settled_amount, 0) > 0.001
        ${byCompany > 0 ? "AND company_id = ?" : ""}`,
    byCompany > 0 ? [hotelId, byCompany] : [hotelId]
  );

  const today = todayStr();
  const sums = [0, 0, 0, 0];
  for (const r of rows) {
    const idx = bucketIndex(daysBetween(String(r.biz_date ?? today), today));
    sums[idx] = round2(sums[idx] + Number(r.outstanding ?? 0));
  }

  return AGING_BUCKETS.map((bucket, i) => ({ bucket, amount: sums[i] }));
}

/** 台账明细（页面展示用），按营业日倒序 */
export function listArLedgers(hotelId: number, companyId?: number, limit = 200): ArLedgerRow[] {
  ensureArLedgerSchema();

  const byCompany =
    Number.isFinite(Number(companyId)) && Number(companyId) > 0 ? Math.trunc(Number(companyId)) : 0;
  const take = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const rows = all<{
    id: number;
    company_id: number;
    company_name: string | null;
    folio_id: number | null;
    folio_no: string | null;
    biz_date: string;
    amount: number;
    settled_amount: number | null;
    due_date: string | null;
    status: string;
    operator: string | null;
    remark: string | null;
    created_at: string | null;
  }>(
    `SELECT l.id, l.company_id, c.name AS company_name, l.folio_id, l.folio_no, l.biz_date,
            l.amount, l.settled_amount, l.due_date, l.status, l.operator, l.remark, l.created_at
       FROM ar_ledgers l
       LEFT JOIN companies c ON c.id = l.company_id AND c.hotel_id = l.hotel_id
      WHERE l.hotel_id = ?
        ${byCompany > 0 ? "AND l.company_id = ?" : ""}
      ORDER BY l.biz_date DESC, l.id DESC
      LIMIT ?`,
    byCompany > 0 ? [hotelId, byCompany, take] : [hotelId, take]
  );

  return rows.map((r) => ({
    ...r,
    settled_amount: round2(Number(r.settled_amount ?? 0)),
    amount: round2(Number(r.amount ?? 0)),
    outstanding: round2(Number(r.amount ?? 0) - Number(r.settled_amount ?? 0)),
  }));
}

/**
 * 全店各协议单位未结应收汇总（页面卡片 / 额度占用率用）
 */
export function listCompanyOutstanding(hotelId: number): { companyId: number; companyName: string; outstanding: number }[] {
  ensureArLedgerSchema();
  const rows = all<{ company_id: number; company_name: string | null; outstanding: number | null }>(
    `SELECT l.company_id,
            c.name AS company_name,
            COALESCE(SUM(l.amount - COALESCE(l.settled_amount, 0)), 0) AS outstanding
       FROM ar_ledgers l
       LEFT JOIN companies c ON c.id = l.company_id AND c.hotel_id = l.hotel_id
      WHERE l.hotel_id = ? AND l.status IN ('OPEN', 'PARTIAL')
      GROUP BY l.company_id, c.name
      ORDER BY outstanding DESC`,
    [hotelId]
  );
  return rows
    .map((r) => ({
      companyId: Number(r.company_id),
      companyName: r.company_name ?? `协议单位#${r.company_id}`,
      outstanding: round2(Number(r.outstanding ?? 0)),
    }))
    .filter((r) => Math.abs(r.outstanding) > EPS);
}
