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
 *
 * ── 第九轮修复（F12）：两套台账原来各写各的，挂账在 AR 报表里查不到 ──
 *   chargeToCompanyAction 只调 postArCharge → 只写 ar_ledgers；
 *   AR 报表（reports/page.tsx 的 arAccountAgg）只读 ar_accounts + ar_transactions。
 *   于是「挂给协议单位的应收」在 AR 报表里命中 0 条 —— 财务看不到这笔钱。
 *
 *   修法：**双写**。以 ar_ledgers 为笔级权威（信用额度、账龄、逐笔核销都靠它），
 *   同时把同一笔金额写进账户维度总账：
 *     · 每个协议单位对应一个 AR 账户（company_id 精确绑定 / 名称唯一匹配 / 懒建镜像账户）；
 *     · 挂账 → ar_transactions 一条 POST + ar_accounts.balance 增加同额；
 *     · 核销 → ar_transactions 一条 PAY（负数）+ balance 减少同额。
 *   两处金额在同一个 SAVEPOINT 里写，任一步失败整体回滚，
 *   因此 ar_accounts.balance 始终等于该账户 SUM(ar_transactions.amount)，
 *   且「挂账/核销」那部分与 ar_ledgers 的 amount/settled_amount 一一对应，
 *   不存在两套互相打架的账。报表读账户总账即可看到挂账产生的应收。
 *
 *   为什么不让报表改读 ar_ledgers：ar_ledgers 没有账户/授信/流水概念，
 *   账龄、还款、转账、授信占用都建立在 ar_accounts 上；只改报表等于把
 *   /ar 页面（账户）与报表（协议单位）拆成两个宇宙，财务仍要对两本账。
 *   双写让两边在同一个账户下汇合，才是根因修复。
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
/** 账户总账表（ar_accounts / ar_transactions）是否已兜底建过（第九轮 F12 双写用） */
let arAccountSchemaReady = false;
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

/* ------------------------------------------------------------------ *
 * 账户维度总账双写（第九轮 F12）
 * ------------------------------------------------------------------ */

/**
 * 账户总账表兜底（幂等）
 *
 * ar_accounts / ar_transactions 正常由 scripts/schema-full.sql 建、
 * 老库由 scripts/migrate-all.mjs 补列、/ar 页面由 ensureArSchema 懒建。
 * 但 postArCharge 可能在「收银台第一次挂账、还没人打开过 /ar」时被调用，
 * 这时表可能不存在 —— 挂账不能因为别人没先建表而失败，这里兜底建。
 *
 * company_id 是本次修复新增的绑定列：
 *   · 新库直接建成带列的表；
 *   · 老库 CREATE TABLE IF NOT EXISTS 不会补列，用 ALTER 补（幂等，并发重复补吞掉
 *     duplicate column name）。
 */
export function ensureArAccountSchema(): void {
  if (arAccountSchemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ar_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      credit_limit REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'ON',
      contact TEXT,
      phone TEXT,
      company_id INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ar_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      ar_account_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      note TEXT,
      operator TEXT,
      biz_date TEXT NOT NULL,
      request_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  const columnsOf = (table: string): string[] =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String((c as { name?: unknown }).name ?? ""));
  const addColumn = (table: string, ddl: string) => {
    try {
      db.exec(ddl);
    } catch (e) {
      /* 多实例并发补列时后到的会拿到 duplicate column name：列已经有了，不是故障 */
      if (!/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  };
  if (!columnsOf("ar_accounts").includes("company_id")) {
    addColumn("ar_accounts", `ALTER TABLE ar_accounts ADD COLUMN company_id INTEGER`);
  }
  if (!columnsOf("ar_transactions").includes("request_id")) {
    addColumn("ar_transactions", `ALTER TABLE ar_transactions ADD COLUMN request_id TEXT`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_tx_request
       ON ar_transactions (hotel_id, request_id) WHERE request_id IS NOT NULL`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ar_accounts_company
       ON ar_accounts (hotel_id, company_id) WHERE company_id IS NOT NULL`
  );
  arAccountSchemaReady = true;
}

/** 读账户当前余额（双写前取快照，与 ar/actions.ts 的 setBalance 同口径） */
function accountBalance(hotelId: number, accountId: number): number {
  const row = get<{ balance: number | null }>(
    `SELECT COALESCE(balance, 0) AS balance FROM ar_accounts WHERE id = ? AND hotel_id = ?`,
    [accountId, hotelId]
  );
  return round2(Number(row?.balance ?? 0));
}

/** 账户维度记一笔流水并同步余额（正数增加应收、负数减少应收） */
function addAccountTx(opts: {
  hotelId: number;
  accountId: number;
  type: "POST" | "PAY";
  amount: number;
  bizDate: string;
  operator: string;
  note: string;
  requestId?: string;
}): void {
  const { hotelId, accountId, type, amount, bizDate, operator, note, requestId } = opts;
  const after = round2(accountBalance(hotelId, accountId) + amount);
  run(
    `INSERT INTO ar_transactions
       (hotel_id, ar_account_id, type, amount, balance_after, note, operator, biz_date, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hotelId,
      accountId,
      type,
      round2(amount),
      after,
      note || null,
      operator,
      bizDate,
      requestId || null,
      nowIso(),
    ]
  );
  run(`UPDATE ar_accounts SET balance = ? WHERE id = ? AND hotel_id = ?`, [after, accountId, hotelId]);
}

/**
 * 该协议单位对应的 AR 账户
 *
 * 解析顺序（每一步都写回 company_id 固化，之后不再靠猜）：
 *   1. company_id 精确绑定 —— 主路径，挂账/核销都用它；
 *   2. 名称唯一匹配未绑定账户：种子账户用的是简称（「杭州云启科技」）而
 *      companies 是全称（「杭州云启科技有限公司」），互含即算命中，
 *      但**必须唯一命中**才认，避免把「西湖旅行社」和「春秋旅行社」之类配错；
 *   3. 都没有 → 懒建镜像账户（code = ARC + 三位 companyId）。
 *
 * 懒建时把该单位**历史 ar_ledgers 的未结余额**作为一条期初 POST 流水结转进账户，
 * 这样升级前已有挂账的老库不会在报表里凭空少掉一笔应收；
 * 绑定到既有账户（种子账户有自己的期初流水）时不再补期初，避免重复记账。
 *
 * @param excludeLedgerId 本次刚写/刚累加的那条台账 id（结转期初时必须排除，
 *                        否则「历史 500 + 本次 200」会被结转成 700 再加本次 200 = 900）
 */
function resolveArAccount(
  hotelId: number,
  companyId: number,
  companyName: string,
  excludeLedgerId?: number
): number {
  const bound = get<{ id: number }>(
    `SELECT id FROM ar_accounts WHERE hotel_id = ? AND company_id = ? ORDER BY id LIMIT 1`,
    [hotelId, companyId]
  );
  if (bound) return Number(bound.id);

  const name = companyName.trim();
  if (name) {
    const unbound = all<{ id: number; name: string | null }>(
      `SELECT id, name FROM ar_accounts WHERE hotel_id = ? AND company_id IS NULL ORDER BY id`,
      [hotelId]
    );
    const hits = unbound.filter((a) => {
      const an = String(a.name ?? "").trim();
      if (!an) return false;
      return an === name || name.includes(an) || an.includes(name);
    });
    if (hits.length === 1) {
      run(
        `UPDATE ar_accounts SET company_id = ? WHERE id = ? AND hotel_id = ? AND company_id IS NULL`,
        [companyId, hits[0].id, hotelId]
      );
      return Number(hits[0].id);
    }
  }

  /* 懒建前先看同 code 是否已被人工建过（老版本/手工录入），有就复用并绑定 */
  const code = `ARC${String(companyId).padStart(3, "0")}`;
  const byCode = get<{ id: number }>(
    `SELECT id FROM ar_accounts WHERE hotel_id = ? AND code = ? ORDER BY id LIMIT 1`,
    [hotelId, code]
  );
  if (byCode) {
    run(
      `UPDATE ar_accounts SET company_id = COALESCE(company_id, ?) WHERE id = ? AND hotel_id = ?`,
      [companyId, byCode.id, hotelId]
    );
    return Number(byCode.id);
  }

  const created = run(
    `INSERT INTO ar_accounts
       (hotel_id, code, name, type, credit_limit, balance, status, company_id, created_at)
     VALUES (?, ?, ?, '协议单位', 0, 0, 'ON', ?, ?)`,
    [hotelId, code, name || `协议单位#${companyId}`, companyId, nowIso()]
  );
  const accountId = created.lastInsertRowid;

  /* 历史台账结转：升级前只写了 ar_ledgers 的未结余额，不进账户就会在报表里消失 */
  const exclude = Number.isFinite(Number(excludeLedgerId)) && Number(excludeLedgerId) > 0 ? Math.trunc(Number(excludeLedgerId)) : 0;
  const carry = get<{ total: number | null; first_date: string | null }>(
    `SELECT COALESCE(SUM(amount - COALESCE(settled_amount, 0)), 0) AS total,
            MIN(biz_date) AS first_date
       FROM ar_ledgers
      WHERE hotel_id = ? AND company_id = ? AND status IN ('OPEN', 'PARTIAL')
        AND (? = 0 OR id <> ?)`,
    [hotelId, companyId, exclude, exclude]
  );
  const carryAmount = round2(Number(carry?.total ?? 0));
  if (carryAmount > EPS) {
    addAccountTx({
      hotelId,
      accountId,
      type: "POST",
      amount: carryAmount,
      bizDate: normalizeBizDate(carry?.first_date ?? undefined),
      operator: "系统结转",
      note: `期初余额结转：历史挂账台账（协议单位 #${companyId}）`,
    });
  }
  return Number(accountId);
}

/** 挂账双写：协议单位台账 → 账户维度一笔 POST */
function syncChargeToAccount(opts: {
  hotelId: number;
  companyId: number;
  companyName: string;
  amount: number;
  bizDate: string;
  operator: string;
  note: string;
  /** 本次挂账对应的台账 id：懒建账户结转历史余额时排除它 */
  ledgerId?: number;
}): void {
  ensureArAccountSchema();
  const accountId = resolveArAccount(opts.hotelId, opts.companyId, opts.companyName, opts.ledgerId);
  addAccountTx({
    hotelId: opts.hotelId,
    accountId,
    type: "POST",
    amount: opts.amount,
    bizDate: opts.bizDate,
    operator: opts.operator,
    note: opts.note,
  });
}

/** 核销双写：协议单位台账的 settled_amount 增加 → 账户维度一笔 PAY（负数） */
function syncSettleToAccount(opts: {
  hotelId: number;
  companyId: number;
  amount: number;
  bizDate: string;
  operator: string;
  note: string;
  requestId: string;
}): void {
  ensureArAccountSchema();
  const companyName = companyNameOf(opts.hotelId, opts.companyId) ?? `协议单位#${opts.companyId}`;
  const accountId = resolveArAccount(opts.hotelId, opts.companyId, companyName);
  addAccountTx({
    hotelId: opts.hotelId,
    accountId,
    type: "PAY",
    amount: round2(-opts.amount),
    bizDate: opts.bizDate,
    operator: opts.operator,
    note: opts.note,
    requestId: opts.requestId,
  });
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
      /*
       * 双写（第九轮 F12）：追加的金额同样要进账户总账，否则报表里的区间建账
       * 只算第一次挂账，与台账的未结余额越差越远。
       */
      syncChargeToAccount({
        hotelId,
        companyId,
        companyName,
        amount,
        bizDate,
        operator: input.operator ?? "系统",
        note: `挂账（追加）：账单 ${folioNo ?? "-"} · 协议单位 ${companyName}`,
        ledgerId: existed.id,
      });
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
    /* 双写（第九轮 F12）：同一事务内写账户流水 + 余额，报表读账户总账就能看到这笔应收 */
    syncChargeToAccount({
      hotelId,
      companyId,
      companyName,
      amount,
      bizDate,
      operator: input.operator ?? "系统",
      note: `挂账：账单 ${folioNo ?? "-"} · 协议单位 ${companyName}`,
      ledgerId: inserted.lastInsertRowid,
    });
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

  const row = get<{
    id: number;
    company_id: number;
    amount: number;
    settled_amount: number | null;
    status: string;
    folio_no: string | null;
  }>(
    `SELECT id, company_id, amount, settled_amount, status, folio_no
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
    /*
     * 双写（第九轮 F12）：核销在账户维度是一笔 PAY（负数），余额同步减少。
     * request_id 用「台账 id + 核销后累计值」：同一笔核销被重放时撞唯一索引，
     * 整个 SAVEPOINT 回滚，账户余额不会被扣第二次。
     */
    syncSettleToAccount({
      hotelId,
      companyId: Number(row.company_id),
      amount: amt,
      bizDate: normalizeBizDate(opts.bizDate),
      operator,
      note: `AR 核销：台账 #${id}${row.folio_no ? `（账单 ${row.folio_no}）` : ""}${tail}`,
      requestId: `arsettle-${id}-${settled}`,
    });
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
