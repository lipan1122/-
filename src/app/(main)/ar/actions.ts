"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { requireAdmin, requirePermission, requirePermissionOrRedirect } from "@/lib/session";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";
import { postAccountLedgerCharge, settleAr, syncAccountSettlement, syncAccountTransfer } from "@/lib/ar";

/**
 * AR 应收管理（去呼呼「AR 管理」）：账号 / 入账付款 / 转账 / 核销 / 历史核销 / 账龄。
 * 三张表不在 scripts/init-db.mjs 内，首次访问时懒创建（幂等），并按酒店写入种子数据。
 *
 * 表结构：
 *   ar_accounts      id, hotel_id, code, name, type(协议单位/挂账客户/内部),
 *                    credit_limit, balance, status(ON/OFF), contact, phone, created_at
 *   ar_transactions  id, hotel_id, ar_account_id, type(POST/PAY/TRANSFER/WRITE_OFF),
 *                    amount(有符号：正数增加应收，负数减少应收), balance_after,
 *                    note, operator, biz_date(YYYY-MM-DD), created_at
 *   ar_write_offs    id, hotel_id, ar_account_id, transaction_id(被核销的入账流水),
 *                    amount(正数), note, operator, created_at
 *
 * 一致性：所有写操作都在 tx() 事务内完成，账户余额始终等于该账户流水的
 *         SUM(amount)，balance_after 逐笔快照不会跳变。
 */

type ArTxType = "POST" | "PAY" | "TRANSFER" | "WRITE_OFF";

type ArAccountRow = {
  id: number;
  code: string;
  name: string;
  type: string;
  credit_limit: number;
  balance: number;
  status: string;
};

type SeedFlow = { type: ArTxType; amount: number; days: number; note: string };

type SeedAccount = {
  code: string;
  name: string;
  type: string;
  credit: number;
  contact: string;
  phone: string;
  opening: number;
  openingDays: number;
  flows: SeedFlow[];
};

const MAX_AMOUNT = 9999999;

/** 表结构只建一次；每个酒店的种子只写一次 */
let schemaReady = false;
const seededHotels = new Set<number>();

/** 业务校验失败：抛出后在 action 内转成页面错误横幅，事务自动 ROLLBACK */
class ArError extends Error {}

function fail(message: string): never {
  throw new ArError(message);
}

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toId(value: FormDataEntryValue | null): number {
  const n = Number(str(value));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 金额：接受 1,200 这类带千分位的输入，统一两位小数并设上限 */
function parseAmount(value: FormDataEntryValue | null): number {
  const n = Number(str(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return round2(Math.min(n, MAX_AMOUNT));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 营业日：非法输入（含空）回落到今天 */
function parseBizDate(value: FormDataEntryValue | null): string {
  const raw = str(value);
  return DATE_RE.test(raw) ? raw : todayStr();
}

function isoAt(bizDate: string, time = "10:00"): string {
  const d = new Date(`${bizDate}T${time}:00`);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}

function daysAgoStr(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return todayStr(d);
}

/** 失败 / 成功回跳：文案带在 query 上，页面顶部渲染横幅；带上账户保持选中态 */
function back(accountId: number, key: "ok" | "err", message: string): never {
  const q = new URLSearchParams();
  if (accountId > 0) q.set("account", String(accountId));
  q.set(key, message);
  redirect(`/ar?${q.toString()}`);
}

function readAccount(hotelId: number, accountId: number): ArAccountRow | undefined {
  return get<ArAccountRow>(
    `SELECT id, code, name, type, credit_limit, balance, status
       FROM ar_accounts WHERE id = ? AND hotel_id = ?`,
    [accountId, hotelId]
  );
}

function mustAccount(hotelId: number, accountId: number): ArAccountRow {
  const row = readAccount(hotelId, accountId);
  if (!row) fail("AR 账户不存在或已被删除");
  return row;
}

function setBalance(hotelId: number, accountId: number, balance: number): void {
  run(`UPDATE ar_accounts SET balance = ? WHERE id = ? AND hotel_id = ?`, [balance, accountId, hotelId]);
}

/**
 * 写一条流水并回填余额快照；amount 有符号（正=增加应收，负=减少应收）
 *
 * requestId（第六轮整改 一.5）：幂等键。同一酒店内 (hotel_id, request_id) 唯一，
 * 重复提交（前台双击 / 网络超时后重试）第二次会撞唯一索引，整个事务回滚，
 * 余额与流水都不会再变一次。
 */
function recordTx(opts: {
  hotelId: number;
  accountId: number;
  type: ArTxType;
  amount: number;
  balanceAfter: number;
  note: string;
  operator: string;
  bizDate: string;
  requestId?: string;
}): number {
  const { hotelId, accountId, type, amount, balanceAfter, note, operator, bizDate, requestId } = opts;
  const res = run(
    `INSERT INTO ar_transactions
       (hotel_id, ar_account_id, type, amount, balance_after, note, operator, biz_date, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hotelId,
      accountId,
      type,
      round2(amount),
      round2(balanceAfter),
      note || null,
      operator,
      bizDate,
      requestId || null,
      isoAt(bizDate),
    ]
  );
  return res.lastInsertRowid;
}

/* ------------------------------------------------------- 幂等键 / 操作日志 */

/**
 * 幂等键归一：页面每次渲染生成一个 request_id 放进隐藏域，
 * 双击 / 超时重试带的是同一个值 → 服务端只能记一次账。
 * 只保留安全字符并限长，避免脏输入被写进唯一索引。
 */
function readRequestId(value: FormDataEntryValue | null): string {
  return str(value)
    .replace(/[^A-Za-z0-9._:#-]/g, "")
    .slice(0, 56);
}

/** 该 request_id 是否已经记过账（命中 = 重复提交，直接返回提示，不再动余额） */
function replayOf(hotelId: number, requestId: string): { id: number } | undefined {
  if (!requestId) return undefined;
  return get<{ id: number }>(
    `SELECT id FROM ar_transactions WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
    [hotelId, requestId]
  );
}

/** 异常文案（判唯一索引冲突用） */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** op_logs 表可能还没建的旧库：存在才写，避免日志表缺失把整笔账务拖失败 */
let opLogsChecked = false;
let opLogsPresent = false;
function logArOp(hotelId: number, operator: string, action: string, detail: string): void {
  if (!opLogsChecked) {
    opLogsPresent =
      (get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0) >
      0;
    opLogsChecked = true;
  }
  if (!opLogsPresent) return;
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

/* ------------------------------------------------------------------ 种子数据 */

/**
 * 5 个 AR 账户：各带期初余额 + 10 条流水。
 * 金额有符号：POST 为正（增加应收），PAY / WRITE_OFF 为负，TRANSFER 转出为负、转入为正。
 * A1 转出 1500 → A2 转入 1500，是同一次内部调账的两条腿。
 */
const AR_SEED: SeedAccount[] = [
  {
    code: "AR001",
    name: "杭州云启科技",
    type: "协议单位",
    credit: 80000,
    contact: "王经理",
    phone: "13805710001",
    opening: 18600,
    openingDays: 96,
    flows: [
      { type: "POST", amount: 4200, days: 88, note: "9 月房费挂账（12 间夜）" },
      { type: "POST", amount: 5600, days: 72, note: "10 月长包房挂账" },
      { type: "PAY", amount: -8000, days: 65, note: "银行对公转账还款" },
      { type: "POST", amount: 3200, days: 45, note: "会议用餐挂账" },
      { type: "WRITE_OFF", amount: -1200, days: 40, note: "尾差核销（对账差异）" },
      { type: "POST", amount: 2600, days: 22, note: "团组客房挂账" },
      { type: "PAY", amount: -3000, days: 18, note: "部分还款（网银）" },
      { type: "POST", amount: 1800, days: 12, note: "洗衣费挂账" },
      { type: "TRANSFER", amount: -1500, days: 6, note: "内部调账：转至 AR002 西湖旅行社" },
      { type: "POST", amount: 900, days: 2, note: "杂费挂账" },
    ],
  },
  {
    code: "AR002",
    name: "西湖旅行社",
    type: "协议单位",
    credit: 50000,
    contact: "陈经理",
    phone: "13805710002",
    opening: 9800,
    openingDays: 97,
    flows: [
      { type: "POST", amount: 6800, days: 90, note: "国庆团房挂账" },
      { type: "POST", amount: 5400, days: 70, note: "10 月团队房费" },
      { type: "PAY", amount: -12000, days: 58, note: "月结付款" },
      { type: "POST", amount: 3600, days: 48, note: "导游房挂账" },
      { type: "POST", amount: 2400, days: 36, note: "加床及早餐挂账" },
      { type: "PAY", amount: -5000, days: 26, note: "转账还款" },
      { type: "POST", amount: 1500, days: 15, note: "杂费挂账" },
      { type: "POST", amount: 2600, days: 9, note: "11 月团队房费" },
      { type: "TRANSFER", amount: 1500, days: 6, note: "内部调账：自 AR001 杭州云启科技转入" },
      { type: "PAY", amount: -3000, days: 3, note: "预付款抵扣" },
    ],
  },
  {
    code: "AR003",
    name: "东方航空",
    type: "挂账客户",
    credit: 120000,
    contact: "赵主管",
    phone: "13805710003",
    opening: 42000,
    openingDays: 98,
    flows: [
      { type: "POST", amount: 15600, days: 92, note: "机组用房挂账（9 月）" },
      { type: "POST", amount: 18900, days: 61, note: "机组用房挂账（10 月）" },
      { type: "PAY", amount: -20000, days: 52, note: "航司月结付款" },
      { type: "POST", amount: 8600, days: 44, note: "地面服务人员用房" },
      { type: "WRITE_OFF", amount: -2600, days: 38, note: "争议房费核销" },
      { type: "POST", amount: 7200, days: 25, note: "临时机组用房" },
      { type: "PAY", amount: -15000, days: 20, note: "银行转账" },
      { type: "POST", amount: 4800, days: 14, note: "洗衣及餐饮挂账" },
      { type: "POST", amount: 3300, days: 7, note: "加床挂账" },
      { type: "PAY", amount: -9000, days: 1, note: "部分付款" },
    ],
  },
  {
    code: "AR004",
    name: "携程预付",
    type: "挂账客户",
    credit: 30000,
    contact: "平台客服",
    phone: "13805710004",
    opening: 12000,
    openingDays: 95,
    flows: [
      { type: "POST", amount: 9000, days: 85, note: "预付订单挂账" },
      { type: "PAY", amount: -15000, days: 60, note: "预付打款到账" },
      { type: "POST", amount: 6400, days: 50, note: "预付订单消费" },
      { type: "POST", amount: 4800, days: 33, note: "预付订单消费" },
      { type: "PAY", amount: -8000, days: 24, note: "预付打款到账" },
      { type: "POST", amount: 2600, days: 16, note: "预付订单消费" },
      { type: "POST", amount: 1800, days: 8, note: "预付订单消费" },
      { type: "PAY", amount: -5000, days: 5, note: "预付打款到账" },
      { type: "POST", amount: 1200, days: 3, note: "预付订单消费" },
      { type: "POST", amount: 900, days: 1, note: "预付订单消费" },
    ],
  },
  {
    code: "AR005",
    name: "内部挂账",
    type: "内部",
    credit: 0,
    contact: "财务部",
    phone: "13805710005",
    opening: 3200,
    openingDays: 99,
    flows: [
      { type: "POST", amount: 1200, days: 80, note: "员工内部挂账（房费）" },
      { type: "PAY", amount: -800, days: 55, note: "员工还款" },
      { type: "POST", amount: 600, days: 30, note: "内部餐饮挂账" },
      { type: "POST", amount: 450, days: 21, note: "内部洗衣挂账" },
      { type: "PAY", amount: -500, days: 13, note: "员工还款" },
      { type: "POST", amount: 380, days: 10, note: "内部停车挂账" },
      { type: "WRITE_OFF", amount: -200, days: 4, note: "小额尾差核销" },
      { type: "POST", amount: 260, days: 2, note: "内部杂费挂账" },
      { type: "PAY", amount: -300, days: 1, note: "员工还款" },
      { type: "POST", amount: 150, days: 0, note: "内部挂账（当日）" },
    ],
  },
];

/**
 * 首次访问：写入种子账户 + 期初余额 + 10 条流水，余额与流水严格对齐
 *
 * ⚠️ 上线前加的保护
 *
 * 这段种子数据是**演示用**的（5 个虚构协议单位、假电话、假期初余额）。
 * 真实酒店上线后，财务第一次打开「应收管理」就会看到这 5 个不存在的账户，
 * 很可能以为是之前录的、拿去对账，后果比缺功能更严重。
 *
 * 所以：只有**显式**设置环境变量 PMS_DEMO_SEED=1 时才灌演示数据，
 * 默认不灌 —— 真实上线看到的是空列表（页面有空态提示）。
 */
function seedHotel(hotelId: number): void {
  if (process.env.PMS_DEMO_SEED !== "1") return;

  const existing =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM ar_accounts WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (existing > 0) return;

  tx(() => {
    for (const seed of AR_SEED) {
      const openingDate = daysAgoStr(seed.openingDays);
      const accountId = run(
        `INSERT INTO ar_accounts
           (hotel_id, code, name, type, credit_limit, balance, status, contact, phone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [hotelId, seed.code, seed.name, seed.type, seed.credit, 0, "ON", seed.contact, seed.phone, isoAt(openingDate, "09:30")]
      ).lastInsertRowid;

      let balance = 0;
      let lastPostId = 0;

      // 期初余额：作为一条 POST 入账流水落地，账龄从期初日开始计算
      balance = round2(balance + seed.opening);
      lastPostId = recordTx({
        hotelId,
        accountId,
        type: "POST",
        amount: seed.opening,
        balanceAfter: balance,
        note: `期初余额结转（${openingDate}）`,
        operator: "系统结转",
        bizDate: openingDate,
      });

      for (const flow of seed.flows) {
        const bizDate = daysAgoStr(flow.days);
        balance = round2(balance + flow.amount);
        const txId = recordTx({
          hotelId,
          accountId,
          type: flow.type,
          amount: flow.amount,
          balanceAfter: balance,
          note: flow.note,
          operator: flow.type === "WRITE_OFF" ? "财务核销" : flow.type === "PAY" ? "收银" : "前台",
          bizDate,
        });
        if (flow.type === "POST" && flow.amount > 0) lastPostId = txId;
        if (flow.type === "WRITE_OFF") {
          // 核销同时落 ar_write_offs，关联到最近一条入账流水
          run(
            `INSERT INTO ar_write_offs
               (hotel_id, ar_account_id, transaction_id, amount, note, operator, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [hotelId, accountId, lastPostId || null, round2(Math.abs(flow.amount)), flow.note, "财务核销", isoAt(bizDate, "14:00")]
          );
        }
      }

      setBalance(hotelId, accountId, balance);
    }
  });
}

/** 懒建表（幂等）+ 首次为各酒店写入 AR 种子账户 */
export async function ensureArSchema(hotelId: number): Promise<void> {
  /*
   * 权限边界（上线前加固）：建表 / 种子助手不该是可匿名调用的 RPC 端点。
   * 它被 ar/page.tsx 直接 import，去掉 export 会打断页面编译，这里必须补权限；
   * 同时酒店 id 必须与 session 一致，避免拿别家 hotelId 往别家写种子数据。
   *
   * 为什么是 cashier.view（整改 A 类缺口）：
   *   只有 requireUser() 时，任何登录账号（含客房）直接 POST 这个 action 就能让
   *   本店凭空多出种子应收账户 / 让 DDL 被执行 —— 它是写动作，必须有权限点。
   *
   *   选点依据是「调用方角色交集」，不是随便挑一个账务点：
   *   · 页面：ar/page.tsx（admin / cashier）
   *   · 本文件调用它的 4 个写动作：postArAction=cashier.charge_company(admin/cashier)、
   *     payArAction=cashier.receive(admin/frontdesk/cashier)、
   *     transferArAction=cashier.transfer(admin/cashier)、writeOffArAction=requireAdmin
   *   这四类角色合计是 admin / frontdesk / cashier，正好等于 cashier.view 的角色集。
   *   如果这里用更窄的 report.view_finance（admin/cashier），
   *   frontdesk 调 payArAction 时会被这个**内部**助手 307 到 /no-permission ——
   *   等于把一个明确授权给前台的收款动作弄坏，那才是真正的回归。
   *   AR 的写权限由上面每个动作自己的权限点负责，这里只负责「不能是随便一个登录用户」。
   *
   * 用 OrRedirect 而非 requirePermission：生产构建会把 Server Action 抛出的错误消息
   * 脱敏成「操作失败」，跳 /no-permission 才能让用户看到「没有该操作权限」。
   */
  const user = await requirePermissionOrRedirect("cashier.view");
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化应收数据");
  if (!schemaReady) {
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
    /*
     * 幂等键（第六轮整改 一.5「余额不能因重复提交重复变化」）
     *
     * 老库的 ar_transactions 没有 request_id，这里补列（PRAGMA 查一次，幂等）；
     * 唯一索引 (hotel_id, request_id) 是「重复提交只记一次账」的硬保证：
     * 第二次插入直接 UNIQUE 失败 → 整个 tx 回滚 → 余额不会被加/减第二次。
     * 用 partial index 是因为历史流水 request_id 全为 NULL（NULL 不参与唯一约束，
     * 但显式 WHERE 让索引更小、意图更直白）。
     */
    const arTxCols = db
      .prepare(`PRAGMA table_info(ar_transactions)`)
      .all()
      .map((c) => String((c as { name?: unknown }).name ?? ""));
    if (!arTxCols.includes("request_id")) {
      try {
        db.exec(`ALTER TABLE ar_transactions ADD COLUMN request_id TEXT`);
      } catch (e) {
        /*
         * 多实例并发首访时两个进程可能都读到「没有该列」并同时 ALTER：
         * SQLite 串行执行，后到的那个会拿到 duplicate column name。
         * 这不是故障（列已经被前一个进程加好了），吞掉即可，不能让 /ar 变成 500。
         */
        if (!/duplicate column name/i.test(errText(e))) throw e;
      }
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_tx_request
         ON ar_transactions (hotel_id, request_id) WHERE request_id IS NOT NULL`
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS ar_write_offs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        ar_account_id INTEGER NOT NULL,
        transaction_id INTEGER,
        ar_ledger_id INTEGER,
        amount REAL NOT NULL,
        note TEXT,
        operator TEXT,
        created_at TEXT NOT NULL
      )
    `);
    /*
     * 第九轮 P1-3：核销要同时冲减协议单位逐笔台账（ar_ledgers），
     * ar_write_offs 记录被冲减的台账行 id。老库 CREATE TABLE IF NOT EXISTS 不补列，这里 ALTER。
     */
    const woCols = db
      .prepare(`PRAGMA table_info(ar_write_offs)`)
      .all()
      .map((c) => String((c as { name?: unknown }).name ?? ""));
    if (!woCols.includes("ar_ledger_id")) {
      try {
        db.exec(`ALTER TABLE ar_write_offs ADD COLUMN ar_ledger_id INTEGER`);
      } catch (e) {
        if (!/duplicate column name/i.test(errText(e))) throw e;
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_tx_account ON ar_transactions (hotel_id, ar_account_id, biz_date)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_wo_account ON ar_write_offs (hotel_id, ar_account_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ar_wo_ledger
         ON ar_write_offs (hotel_id, ar_ledger_id) WHERE ar_ledger_id IS NOT NULL`
    );
    schemaReady = true;
  }

  if (seededHotels.has(hotelId)) return;
  seedHotel(hotelId);
  seededHotels.add(hotelId);
}

/* ------------------------------------------------------------------ 业务动作 */

/** 入账（POST）：增加应收余额，写一条正数流水 */
export async function postArAction(formData: FormData): Promise<void> {
  /*
   * 权限（第六轮整改清单一.5）：
   *   入账 = 把账单转成单位挂账（增加应收），语义上就是「挂公司账」，
   *   复用已有的 cashier.charge_company（admin / cashier），不新造 ar.manage。
   *   原来只 requireUser()：前台 / 客房都能给任意账户记应收。
   */
  const user = await requirePermission("cashier.charge_company");
  const hotelId = user.hotelId;
  await ensureArSchema(hotelId);

  const accountId = toId(formData.get("account_id"));
  if (!accountId) back(0, "err", "请先选择一个 AR 账户");

  const amount = parseAmount(formData.get("amount"));
  if (!(amount > 0)) back(accountId, "err", "请填写正确的入账金额（大于 0）");

  const note = str(formData.get("note"));
  const bizDate = parseBizDate(formData.get("biz_date"));
  const requestId = readRequestId(formData.get("request_id"));

  let message = "";
  try {
    message = tx(() => {
      // 幂等：同一 request_id 已经记过账 → 直接返回提示，不再加一次余额
      const replay = replayOf(hotelId, requestId);
      if (replay) return `该请求已处理过（流水 #${replay.id}），本次重复提交未再次增加应收`;

      const account = mustAccount(hotelId, accountId);
      if (account.status !== "ON") fail(`账户「${account.name}」已停用，不能办理入账`);

      const after = round2(Number(account.balance) + amount);
      recordTx({
        hotelId,
        accountId,
        type: "POST",
        amount,
        balanceAfter: after,
        note: note || `挂账入账（${bizDate}）`,
        operator: user.realName,
        bizDate,
        requestId,
      });
      setBalance(hotelId, accountId, after);
      /*
       * 第九轮 P1-3：账户「入账」也要在协议单位台账留笔迹
       *
       * 只写 ar_transactions 的话，绑定协议单位的账户余额会当场与单位台账分叉
       * （账户加了钱、台账没有这一笔）。绑定单位 → 台账补一条 CHARGE；
       * 纯账户（没有 company_id）没有逐笔台账，如实写进日志，不假装同步过。
       */
      const ledger = postAccountLedgerCharge(hotelId, {
        accountId,
        amount,
        bizDate,
        operator: user.realName,
        note: note || `账户入账（营业日 ${bizDate}）`,
      });
      // 余额、流水、台账、操作日志同一个事务：任何一步失败整体回滚
      logArOp(
        hotelId,
        user.realName,
        "AR 入账",
        `${account.code} ${account.name} 入账 ${fmtMoney(amount)}，应收余额 ${fmtMoney(after)}（营业日 ${bizDate}）` +
          (ledger.ledgerId ? ` · 协议单位台账 #${ledger.ledgerId}` : " · 账户未绑定协议单位，无逐笔台账")
      );
      return `已为「${account.name}」入账 ${fmtMoney(amount)}，当前应收余额 ${fmtMoney(after)}`;
    });
  } catch (e) {
    if (e instanceof ArError) back(accountId, "err", e.message);
    // 并发重复提交：唯一索引拦下 → 事务已回滚，余额没有被改第二次
    if (requestId && /UNIQUE/i.test(errText(e))) {
      back(accountId, "ok", "同一请求的重复提交已被忽略（唯一索引拦下，应收余额未再次变动）");
    }
    throw e;
  }

  revalidatePath("/ar");
  back(accountId, "ok", message);
}

/** 付款（PAY）：客户还款，减少应收余额；不允许超过当前余额 */
export async function payArAction(formData: FormData): Promise<void> {
  /*
   * 权限（清单第 82 行）：客户还款 = 收款，复用已有的 cashier.receive（admin / frontdesk / cashier）。
   */
  const user = await requirePermission("cashier.receive");
  const hotelId = user.hotelId;
  await ensureArSchema(hotelId);

  const accountId = toId(formData.get("account_id"));
  if (!accountId) back(0, "err", "请先选择一个 AR 账户");

  const amount = parseAmount(formData.get("amount"));
  if (!(amount > 0)) back(accountId, "err", "请填写正确的付款金额（大于 0）");

  const note = str(formData.get("note"));
  const bizDate = parseBizDate(formData.get("biz_date"));
  const requestId = readRequestId(formData.get("request_id"));

  let message = "";
  try {
    message = tx(() => {
      const replay = replayOf(hotelId, requestId);
      if (replay) return `该请求已处理过（流水 #${replay.id}），本次重复提交未再次扣减应收`;

      const account = mustAccount(hotelId, accountId);
      if (account.status !== "ON") fail(`账户「${account.name}」已停用，不能办理付款`);

      const balance = round2(Number(account.balance));
      // 清单第 87 行：不允许超过当前应收余额还款（否则余额被扣成负数 = 少收钱）
      if (amount > balance + 0.001) {
        fail(`付款金额不能超过应收余额，当前余额 ${fmtMoney(balance)}，本次付款 ${fmtMoney(amount)}`);
      }

      const after = round2(balance - amount);
      recordTx({
        hotelId,
        accountId,
        type: "PAY",
        amount: -amount,
        balanceAfter: after,
        note: note || `客户还款（${bizDate}）`,
        operator: user.realName,
        bizDate,
        requestId,
      });
      setBalance(hotelId, accountId, after);
      /*
       * 第九轮 P1-3：收款必须同时冲减协议单位逐笔台账
       *
       * 旧实现只改账户余额与 ar_transactions，ar_ledgers 的未结余额一动不动：
       * 财务在台账区看到的仍是「单位欠 1 万」，而账户已显示收完 —— 对账必然失败。
       * FIFO 冲减：先到先冲，单笔不超过该行未结，冲完推进 PARTIAL → SETTLED。
       * 台账不足以覆盖时（历史账户没有逐笔台账）照常收款 —— 钱不能拒收 ——
       * 但把差额写进操作日志「待核对」，不静默当成已同步。
       */
      const ledgerSync = syncAccountSettlement(hotelId, {
        accountId,
        amount,
        bizDate,
        operator: user.realName,
        note: `收款冲销（账户 ${account.code}）`,
      });
      const gapNote =
        ledgerSync.gap > 0.001 && ledgerSync.companyId
          ? ` · 协议单位台账仅冲减 ${fmtMoney(ledgerSync.applied)}，差额 ${fmtMoney(ledgerSync.gap)} 待核对`
          : "";
      logArOp(
        hotelId,
        user.realName,
        "AR 收款",
        `${account.code} ${account.name} 还款 ${fmtMoney(amount)}，应收余额 ${fmtMoney(balance)} → ${fmtMoney(
          after
        )}（营业日 ${bizDate}）` + gapNote
      );
      return `「${account.name}」已付款 ${fmtMoney(amount)}，剩余应收 ${fmtMoney(after)}${gapNote}`;
    });
  } catch (e) {
    if (e instanceof ArError) back(accountId, "err", e.message);
    if (requestId && /UNIQUE/i.test(errText(e))) {
      back(accountId, "ok", "同一请求的重复提交已被忽略（唯一索引拦下，应收余额未再次变动）");
    }
    throw e;
  }

  revalidatePath("/ar");
  back(accountId, "ok", message);
}

/** 转账（TRANSFER）：把应收从本账户调账到目标账户，两账户各写一条流水 */
export async function transferArAction(formData: FormData): Promise<void> {
  /*
   * 权限（清单第 83 行）：转账调账 = 账单 / 账务在账户之间转移，语义最接近已有的
   * cashier.transfer（admin / cashier）；清单写的 ar.manage 不存在，不另造窄点。
   */
  const user = await requirePermission("cashier.transfer");
  const hotelId = user.hotelId;
  await ensureArSchema(hotelId);

  const fromId = toId(formData.get("account_id"));
  if (!fromId) back(0, "err", "请先选择一个 AR 账户");

  const toId2 = toId(formData.get("to_account_id"));
  if (!toId2) back(fromId, "err", "请选择转入账户");
  if (toId2 === fromId) back(fromId, "err", "转出账户与转入账户不能相同");

  const amount = parseAmount(formData.get("amount"));
  if (!(amount > 0)) back(fromId, "err", "请填写正确的转账金额（大于 0）");

  const note = str(formData.get("note"));
  const bizDate = parseBizDate(formData.get("biz_date"));
  const requestId = readRequestId(formData.get("request_id"));

  let message = "";
  try {
    message = tx(() => {
      // 一次调账写两条流水，幂等键各带 #OUT / #IN 后缀（唯一索引仍能逐条拦住重复）
      const outKey = requestId ? `${requestId}#OUT` : "";
      const inKey = requestId ? `${requestId}#IN` : "";
      const replay = replayOf(hotelId, outKey);
      if (replay) return `该请求已处理过（流水 #${replay.id}），本次重复提交未再次调账`;

      const from = mustAccount(hotelId, fromId);
      const to = mustAccount(hotelId, toId2);
      if (from.status !== "ON") fail(`转出账户「${from.name}」已停用，不能调账`);
      if (to.status !== "ON") fail(`转入账户「${to.name}」已停用，不能调账`);

      const fromBalance = round2(Number(from.balance));
      if (amount > fromBalance + 0.001) {
        fail(`转出账户「${from.name}」应收余额不足，当前 ${fmtMoney(fromBalance)}，本次转出 ${fmtMoney(amount)}`);
      }

      const fromAfter = round2(fromBalance - amount);
      const toAfter = round2(Number(to.balance) + amount);
      const tail = note ? `；${note}` : "";

      recordTx({
        hotelId,
        accountId: from.id,
        type: "TRANSFER",
        amount: -amount,
        balanceAfter: fromAfter,
        note: `调账转出至 ${to.code} ${to.name}${tail}`,
        operator: user.realName,
        bizDate,
        requestId: outKey || undefined,
      });
      recordTx({
        hotelId,
        accountId: to.id,
        type: "TRANSFER",
        amount,
        balanceAfter: toAfter,
        note: `调账转入自 ${from.code} ${from.name}${tail}`,
        operator: user.realName,
        bizDate,
        requestId: inKey || undefined,
      });

      setBalance(hotelId, from.id, fromAfter);
      setBalance(hotelId, to.id, toAfter);
      /*
       * 第九轮 P1-3：一次调账两条腿都要落到协议单位台账
       *
       * ar_ledgers 没有「账户间转账」这个概念（主键是 company_id，无源/目标字段），
       * 所以这里按「源单位 FIFO 冲减 + TRANSFER_OUT 审计行 / 目标单位 TRANSFER_IN 台账」表达：
       *   · 源单位未结减少 —— 与收款用同一原语，账龄与核销口径不分裂；
       *   · 目标单位未结增加 —— 新台账行从转账营业日开始计账龄；
       *   · 两边账户余额 = 各自单位台账未结余额，转账前后都成立。
       * 源单位台账不足以覆盖时，把差额写进日志待核对（不能因为台账不全就阻止调账）。
       */
      const ledgerSync = syncAccountTransfer(hotelId, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount,
        bizDate,
        operator: user.realName,
        note: note || undefined,
      });
      const ledgerNote =
        ledgerSync.fromCompanyId
          ? ` · 源单位台账冲减 ${fmtMoney(ledgerSync.applied)}${ledgerSync.outLedgerId ? `（转出行 #${ledgerSync.outLedgerId}）` : ""}` +
            (ledgerSync.gap > 0.001 ? `，差额 ${fmtMoney(ledgerSync.gap)} 待核对` : "")
          : " · 转出账户未绑定协议单位，台账侧跳过";
      logArOp(
        hotelId,
        user.realName,
        "AR 转账",
        `${from.code} ${from.name} → ${to.code} ${to.name} 调账 ${fmtMoney(amount)}；` +
          `转出余额 ${fmtMoney(fromBalance)} → ${fmtMoney(fromAfter)}，转入余额 ${fmtMoney(to.balance)} → ${fmtMoney(
            toAfter
          )}（营业日 ${bizDate}）` +
          ledgerNote
      );
      return `已将 ${fmtMoney(amount)} 从「${from.name}」调账至「${to.name}」`;
    });
  } catch (e) {
    if (e instanceof ArError) back(fromId, "err", e.message);
    if (requestId && /UNIQUE/i.test(errText(e))) {
      back(fromId, "ok", "同一请求的重复提交已被忽略（唯一索引拦下，账户余额未再次变动）");
    }
    throw e;
  }

  revalidatePath("/ar");
  back(fromId, "ok", message);
}

/** 核销（WRITE_OFF）：针对某笔入账流水做核销，写 ar_write_offs 并减少余额 */
export async function writeOffArAction(formData: FormData): Promise<void> {
  // 权限边界（上线前加固）：坏账核销直接冲减应收余额，仅 admin 可操作，原来只校验登录
  const user = await requireAdmin();
  const hotelId = user.hotelId;
  await ensureArSchema(hotelId);

  const accountId = toId(formData.get("account_id"));
  if (!accountId) back(0, "err", "请先选择一个 AR 账户");

  const transactionId = toId(formData.get("transaction_id"));
  if (!transactionId) back(accountId, "err", "请选择要核销的入账流水");

  const amount = parseAmount(formData.get("amount"));
  if (!(amount > 0)) back(accountId, "err", "请填写正确的核销金额（大于 0）");

  const note = str(formData.get("note"));
  const bizDate = parseBizDate(formData.get("biz_date"));
  const requestId = readRequestId(formData.get("request_id"));

  let message = "";
  try {
    message = tx(() => {
      const replay = replayOf(hotelId, requestId);
      if (replay) return `该请求已处理过（流水 #${replay.id}），本次重复提交未再次核销`;

      const account = mustAccount(hotelId, accountId);
      if (account.status !== "ON") fail(`账户「${account.name}」已停用，不能办理核销`);

      const post = get<{ id: number; type: string; amount: number; biz_date: string }>(
        `SELECT id, type, amount, biz_date FROM ar_transactions
          WHERE id = ? AND hotel_id = ? AND ar_account_id = ?`,
        [transactionId, hotelId, accountId]
      );
      if (!post) fail("未找到对应的入账流水，可能已被删除");
      if (post.type !== "POST") fail("只能对「入账」流水做核销");

      const written =
        get<{ n: number }>(
          `SELECT COALESCE(SUM(amount), 0) AS n FROM ar_write_offs
            WHERE hotel_id = ? AND ar_account_id = ? AND transaction_id = ?`,
          [hotelId, accountId, transactionId]
        )?.n ?? 0;
      const remaining = round2(Number(post.amount) - Number(written));
      if (remaining <= 0.001) fail("该笔入账已全部核销，请选择其他流水");

      if (amount > remaining + 0.001) {
        fail(`核销金额不能超过该笔入账的可核销余额 ${fmtMoney(remaining)}`);
      }

      const balance = round2(Number(account.balance));
      if (amount > balance + 0.001) {
        fail(`核销金额不能超过账户应收余额 ${fmtMoney(balance)}`);
      }

      const after = round2(balance - amount);
      recordTx({
        hotelId,
        accountId,
        type: "WRITE_OFF",
        amount: -amount,
        balanceAfter: after,
        note: note || `核销 ${post.biz_date} 入账 ${fmtMoney(Number(post.amount))}`,
        operator: user.realName,
        bizDate,
        requestId,
      });
      const writeOffNote = note || `核销 ${post.biz_date} 入账流水 #${post.id}`;
      /*
       * 第九轮 P1-3：坏账核销必须同时冲减协议单位逐笔台账（第四条同步规则）
       *
       * 旧实现只写账户流水 + ar_write_offs：账户余额减了，ar_ledgers 的未结仍是原值，
       * 于是「核销后台账仍显示未结」，财务和协议客户对账失败。
       * 现在按单位未结台账 FIFO 冲减（settled_amount 增加、状态推进），
       * 并为每条被冲减的台账各写一条 ar_write_offs（ar_ledger_id 指回台账行）：
       *   · 一次核销跨多条台账时，金额按分摊行相加 = 核销总额，不重复计；
       *   · 台账不足（纯账户 / 历史账户没有逐笔台账）的部分单列一条 ar_ledger_id=NULL，
       *     备注「待核对」，不静默归类。
       */
      const ledgerSync = syncAccountSettlement(hotelId, {
        accountId,
        amount,
        bizDate,
        operator: user.realName,
        note: `坏账核销（入账流水 #${post.id}）`,
      });
      for (const alloc of ledgerSync.allocations) {
        run(
          `INSERT INTO ar_write_offs
             (hotel_id, ar_account_id, transaction_id, ar_ledger_id, amount, note, operator, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            hotelId,
            accountId,
            transactionId,
            alloc.ledgerId,
            round2(alloc.amount),
            `${writeOffNote}（台账 #${alloc.ledgerId}）`,
            user.realName,
            // 核销时间取真实操作时刻，营业日另存于流水 biz_date
            nowIso(),
          ]
        );
      }
      if (ledgerSync.gap > 0.001) {
        run(
          `INSERT INTO ar_write_offs
             (hotel_id, ar_account_id, transaction_id, ar_ledger_id, amount, note, operator, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
          [
            hotelId,
            accountId,
            transactionId,
            round2(ledgerSync.gap),
            ledgerSync.companyId
              ? `${writeOffNote}（无逐笔台账可对应，待核对）`
              : `${writeOffNote}（账户未绑定协议单位，无逐笔台账）`,
            user.realName,
            nowIso(),
          ]
        );
      }
      setBalance(hotelId, accountId, after);
      const ledgerNote = ledgerSync.companyId
        ? ` · 台账冲减 ${fmtMoney(ledgerSync.applied)}${ledgerSync.allocations.length ? `（${ledgerSync.allocations.length} 笔）` : ""}` +
          (ledgerSync.gap > 0.001 ? `，差额 ${fmtMoney(ledgerSync.gap)} 待核对` : "")
        : " · 账户未绑定协议单位，台账侧跳过";
      logArOp(
        hotelId,
        user.realName,
        "AR 坏账核销",
        `${account.code} ${account.name} 核销 ${fmtMoney(amount)}（入账流水 #${post.id} ${post.biz_date}），` +
          `应收余额 ${fmtMoney(balance)} → ${fmtMoney(after)}` +
          ledgerNote
      );
      return `已核销「${account.name}」${fmtMoney(amount)}，剩余应收 ${fmtMoney(after)}`;
    });
  } catch (e) {
    if (e instanceof ArError) back(accountId, "err", e.message);
    if (requestId && /UNIQUE/i.test(errText(e))) {
      back(accountId, "ok", "同一请求的重复提交已被忽略（唯一索引拦下，应收余额未再次变动）");
    }
    throw e;
  }

  revalidatePath("/ar");
  back(accountId, "ok", message);
}

/**
 * 核销挂账台账（第 4 轮 P1-15 · 问题 2）
 *
 * 背景：`src/lib/ar.ts` 的 `settleAr()`（按 ar_ledgers 笔级核销）**全项目零调用**，
 * 所以 `ar_ledgers` 只单向增长 —— 收了公司的钱也核销不掉，
 * AR 台账上的未结余额永远减不下去，账龄报表全是陈旧数字。
 *
 * 这里补上入口：选中一条未结合账，输入本次到账金额，
 * 调用 settleAr 把那笔台账的 settled_amount 加上去、状态推进到 PARTIAL / SETTLED。
 *
 * 与 `writeOffArAction`（坏账核销，仅 admin）不同，这里是**正常收款核销**，
 * 用 cashier.receive 权限（收银/前台都要能用）。
 */
export async function settleArLedgerAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  const hotelId = user.hotelId;

  const arId = Number(formData.get("ar_id"));
  const amount = round2(Number(formData.get("amount") ?? 0));
  const remark = String(formData.get("remark") ?? "").trim();
  const backTo = String(formData.get("backTo") ?? "/ar");

  if (!Number.isInteger(arId) || arId <= 0) {
    redirect(`${backTo}?err=${encodeURIComponent("缺少应收台账 ID")}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    redirect(`${backTo}?err=${encodeURIComponent("核销金额必须大于 0")}`);
  }

  const result = settleAr(hotelId, arId, amount, {
    operator: user.realName ?? user.username,
    remark: remark || "收到协议单位款项",
    bizDate: bizToday(user.hotelId),
  });

  if ("error" in result) {
    redirect(`${backTo}?err=${encodeURIComponent(result.error)}`);
  }

  revalidatePath("/ar");
  revalidatePath("/finance");
  redirect(
    `${backTo}?msg=${encodeURIComponent(
      `已核销 ${fmtMoney(amount)}${result.status ? `，台账状态 ${result.status}` : ""}`
    )}`
  );
}
