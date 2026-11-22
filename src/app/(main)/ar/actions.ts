"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { requireAdmin, requirePermission, requireUser } from "@/lib/session";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";
import { settleAr } from "@/lib/ar";

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

/** 写一条流水并回填余额快照；amount 有符号（正=增加应收，负=减少应收） */
function recordTx(opts: {
  hotelId: number;
  accountId: number;
  type: ArTxType;
  amount: number;
  balanceAfter: number;
  note: string;
  operator: string;
  bizDate: string;
}): number {
  const { hotelId, accountId, type, amount, balanceAfter, note, operator, bizDate } = opts;
  const res = run(
    `INSERT INTO ar_transactions
       (hotel_id, ar_account_id, type, amount, balance_after, note, operator, biz_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [hotelId, accountId, type, round2(amount), round2(balanceAfter), note || null, operator, bizDate, isoAt(bizDate)]
  );
  return res.lastInsertRowid;
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
   * 它被 ar/page.tsx 直接 import，去掉 export 会打断页面编译，这里补登录守卫；
   * 同时酒店 id 必须与 session 一致，避免拿别家 hotelId 往别家写种子数据。
   */
  const user = await requireUser();
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
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ar_write_offs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        ar_account_id INTEGER NOT NULL,
        transaction_id INTEGER,
        amount REAL NOT NULL,
        note TEXT,
        operator TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_tx_account ON ar_transactions (hotel_id, ar_account_id, biz_date)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ar_wo_account ON ar_write_offs (hotel_id, ar_account_id)`);
    schemaReady = true;
  }

  if (seededHotels.has(hotelId)) return;
  seedHotel(hotelId);
  seededHotels.add(hotelId);
}

/* ------------------------------------------------------------------ 业务动作 */

/** 入账（POST）：增加应收余额，写一条正数流水 */
export async function postArAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureArSchema(hotelId);

  const accountId = toId(formData.get("account_id"));
  if (!accountId) back(0, "err", "请先选择一个 AR 账户");

  const amount = parseAmount(formData.get("amount"));
  if (!(amount > 0)) back(accountId, "err", "请填写正确的入账金额（大于 0）");

  const note = str(formData.get("note"));
  const bizDate = parseBizDate(formData.get("biz_date"));

  let message = "";
  try {
    message = tx(() => {
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
      });
      setBalance(hotelId, accountId, after);
      return `已为「${account.name}」入账 ${fmtMoney(amount)}，当前应收余额 ${fmtMoney(after)}`;
    });
  } catch (e) {
    if (e instanceof ArError) back(accountId, "err", e.message);
    throw e;
  }

  revalidatePath("/ar");
  back(accountId, "ok", message);
}

/** 付款（PAY）：客户还款，减少应收余额；不允许超过当前余额 */
export async function payArAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureArSchema(hotelId);

  const accountId = toId(formData.get("account_id"));
  if (!accountId) back(0, "err", "请先选择一个 AR 账户");

  const amount = parseAmount(formData.get("amount"));
  if (!(amount > 0)) back(accountId, "err", "请填写正确的付款金额（大于 0）");

  const note = str(formData.get("note"));
  const bizDate = parseBizDate(formData.get("biz_date"));

  let message = "";
  try {
    message = tx(() => {
      const account = mustAccount(hotelId, accountId);
      if (account.status !== "ON") fail(`账户「${account.name}」已停用，不能办理付款`);

      const balance = round2(Number(account.balance));
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
      });
      setBalance(hotelId, accountId, after);
      return `「${account.name}」已付款 ${fmtMoney(amount)}，剩余应收 ${fmtMoney(after)}`;
    });
  } catch (e) {
    if (e instanceof ArError) back(accountId, "err", e.message);
    throw e;
  }

  revalidatePath("/ar");
  back(accountId, "ok", message);
}

/** 转账（TRANSFER）：把应收从本账户调账到目标账户，两账户各写一条流水 */
export async function transferArAction(formData: FormData): Promise<void> {
  const user = await requireUser();
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

  let message = "";
  try {
    message = tx(() => {
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
      });

      setBalance(hotelId, from.id, fromAfter);
      setBalance(hotelId, to.id, toAfter);
      return `已将 ${fmtMoney(amount)} 从「${from.name}」调账至「${to.name}」`;
    });
  } catch (e) {
    if (e instanceof ArError) back(fromId, "err", e.message);
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

  let message = "";
  try {
    message = tx(() => {
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
      });
      run(
        `INSERT INTO ar_write_offs
           (hotel_id, ar_account_id, transaction_id, amount, note, operator, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          hotelId,
          accountId,
          transactionId,
          round2(amount),
          note || `核销 ${post.biz_date} 入账流水 #${post.id}`,
          user.realName,
          // 核销时间取真实操作时刻，营业日另存于流水 biz_date
          nowIso(),
        ]
      );
      setBalance(hotelId, accountId, after);
      return `已核销「${account.name}」${fmtMoney(amount)}，剩余应收 ${fmtMoney(after)}`;
    });
  } catch (e) {
    if (e instanceof ArError) back(accountId, "err", e.message);
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
