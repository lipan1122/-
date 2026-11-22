/**
 * 会员储值（整改 P1-3：储值余额与流水割裂）
 *
 * ── 缺陷 ──
 * 原来 `member_wallet`（余额）与 `member_wallet_transactions`（流水）是两张割裂的表：
 *   · 余额可以单独改，流水另记，两边对不上时没有任何机制能发现；
 *   · 退款只校验「金额 > 0」，没有「累计退款 ≤ 累计充值 − 已消费」的约束，
 *     理论上可以把没充过的钱退出去。
 *
 * ── 收敛后的模型（唯一口径）──
 *   member_wallet_ledger  唯一记账明细：biz_type ∈ RECHARGE/CONSUME/REFUND/ADJUST，
 *                         amount 正数入账、负数出账，balance_after 是记账后余额快照。
 *   member_wallet.balance 仅作「当前余额缓存」，只允许由 recalcBalance() 用
 *                         SUM(ledger.amount) 回写；本文件之外不应再有 UPDATE 余额的代码。
 *
 * 余额恒等式：balance === SUM(member_wallet_ledger.amount)
 *
 * ── biz_type 与金额符号（务必按此调用，别再各自解释）──
 *   RECHARGE 充值 +      钱进卡，余额增
 *   CONSUME  消费 −      钱出卡（扣房费 / 店内消费），余额减
 *   REFUND   退款 −      把卡里的余额退还给客人（出账），余额减
 *   ADJUST   调整 ±      人工对账调整、历史数据迁移，双向
 *
 * 注意 REFUND 的语义：本项目「储值退款」= 把余额退给客人（出账）。
 * 旧页面 /members/wallet 的「退款退回储值账户」是反方向（入账），
 * 迁移脚本把历史 REFUND 统一改记为 ADJUST，保证历史余额不受影响。
 *
 * ── 事务 ──
 * 用 SAVEPOINT 而不是 db.ts 的 tx()：本文件既会被 server action 直接调用，
 * 也会被收银台在已有事务里调用（挂账 / 储值扣房费），BEGIN 嵌套会直接抛错。
 * SAVEPOINT 在无外层事务时等价于事务，在有外层事务时是嵌套保存点，两种场景都安全。
 */

import { all, get, getDb, run } from "@/lib/db";
import { fmtMoney, nowIso } from "@/lib/utils";

/** 记账类型：充值 / 消费 / 退款 / 调整 */
export type WalletBizType = "RECHARGE" | "CONSUME" | "REFUND" | "ADJUST";

/** 写入可选参数（requestId 为幂等键；refType/refId 关联业务单据，如 folio） */
export type WalletWriteOpts = {
  requestId?: string;
  operator?: string;
  remark?: string;
  refType?: string;
  refId?: number;
};

/** 写入结果：成功带最新余额，失败带可直接展示给前台的文案 */
export type WalletWriteResult = { ok: true; balance: number } | { error: string };

/** 单笔金额上限（与页面输入上限一致，防手滑多打一个 0） */
const MAX_AMOUNT = 999999;

/** 金额比较容差：两位小数记账，浮点误差只允许在这一档内 */
const EPS = 0.001;

/** 表结构只建一次（dev 热重载会重置模块，CREATE IF NOT EXISTS 幂等兜底） */
let schemaReady = false;

/** SAVEPOINT 名字递增，避免嵌套调用时重名 */
let savepointSeq = 0;

/** 两位小数（与 folio.ts 同一口径） */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 懒建表 + 补列（幂等）
 *
 * 与 scripts/migrate-all.mjs 的 DDL 保持完全一致：迁移脚本是 schema 的唯一来源，
 * 这里是「页面/服务先跑起来」的幂等兜底（项目既有约定，见 migrate-all.mjs 文件头）。
 */
export function ensureWalletSchema(): void {
  if (schemaReady) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS member_wallet_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      biz_type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      request_id TEXT,
      operator TEXT,
      remark TEXT,
      created_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_ledger_member ON member_wallet_ledger(hotel_id, member_id)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_request
       ON member_wallet_ledger(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );

  /* 账户表：旧库里是 rooms/actions.ts 懒建的形状（guest_name / amount / type / note），
   * 没有 member_id 与 balance。只补列、不删列不改名——旧写入路径 INSERT 的列必须继续存在。 */
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_wallet (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      member_id INTEGER,
      guest_name TEXT,
      balance REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      type TEXT DEFAULT 'RECHARGE',
      note TEXT,
      updated_at TEXT,
      created_at TEXT
    )
  `);
  for (const [col, ddl] of [
    ["member_id", "INTEGER"],
    ["balance", "REAL DEFAULT 0"],
    ["updated_at", "TEXT"],
  ] as const) {
    try {
      db.exec(`ALTER TABLE member_wallet ADD COLUMN ${col} ${ddl}`);
    } catch {
      /* 列已存在 → 跳过（SQLite 不支持 ADD COLUMN IF NOT EXISTS） */
    }
  }
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_account_member
         ON member_wallet(hotel_id, member_id) WHERE member_id IS NOT NULL`
    );
  } catch {
    /* 历史数据里有同一会员多行账户时先不建索引，待数据纠偏后由 migrate 重建 */
  }

  schemaReady = true;
}

/**
 * 事务包装（SAVEPOINT）
 *
 * 无外层事务时等价于 BEGIN/COMMIT；被收银台的 tx() 包住时退化为保存点，
 * 不会出现「cannot start a transaction within a transaction」。
 */
function atomically<T>(fn: () => T): T {
  ensureWalletSchema();
  const db = getDb();
  const sp = `wallet_sp_${++savepointSeq}`;
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
      /* 回滚失败时保留原始异常，避免掩盖真实错误 */
    }
    throw e;
  }
}

/** 当前余额：直接由流水求和（余额缓存的真相来源永远是这张流水表） */
export function getWalletBalance(hotelId: number, memberId: number): number {
  ensureWalletSchema();
  const row = get<{ balance: number | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS balance
       FROM member_wallet_ledger
      WHERE hotel_id = ? AND member_id = ?`,
    [hotelId, memberId]
  );
  return round2(Number(row?.balance ?? 0));
}

/** 储值汇总（充值 / 消费 / 退款 / 调整 / 余额），页面与对账脚本共用 */
export function getWalletSummary(
  hotelId: number,
  memberId: number
): { balance: number; recharge: number; consume: number; refund: number; adjust: number } {
  ensureWalletSchema();
  const row =
    get<{ recharge: number | null; consume: number | null; refund: number | null; adjust: number | null }>(
      `SELECT
         COALESCE(SUM(CASE WHEN biz_type = 'RECHARGE' THEN amount ELSE 0 END), 0) AS recharge,
         COALESCE(SUM(CASE WHEN biz_type = 'CONSUME' THEN -amount ELSE 0 END), 0) AS consume,
         COALESCE(SUM(CASE WHEN biz_type = 'REFUND' THEN ABS(amount) ELSE 0 END), 0) AS refund,
         COALESCE(SUM(CASE WHEN biz_type = 'ADJUST' THEN amount ELSE 0 END), 0) AS adjust
       FROM member_wallet_ledger
      WHERE hotel_id = ? AND member_id = ?`,
      [hotelId, memberId]
    ) ?? null;

  return {
    balance: getWalletBalance(hotelId, memberId),
    recharge: round2(Number(row?.recharge ?? 0)),
    consume: round2(Number(row?.consume ?? 0)),
    refund: round2(Number(row?.refund ?? 0)),
    adjust: round2(Number(row?.adjust ?? 0)),
  };
}

/** 储值流水（展示 / 测试用），按时间倒序 */
export function listWalletLedger(
  hotelId: number,
  memberId: number,
  limit = 200
): {
  id: number;
  biz_type: string;
  amount: number;
  balance_after: number;
  ref_type: string | null;
  ref_id: number | null;
  operator: string | null;
  remark: string | null;
  created_at: string | null;
}[] {
  ensureWalletSchema();
  return all(
    `SELECT id, biz_type, amount, balance_after, ref_type, ref_id, operator, remark, created_at
       FROM member_wallet_ledger
      WHERE hotel_id = ? AND member_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [hotelId, memberId, Math.max(1, Math.min(1000, Math.trunc(limit)))]
  );
}

/** 会员存在性校验：member_id 就是 guests.id（现有储值页面用 guest_id 指向 guests） */
function memberNameOf(hotelId: number, memberId: number): string | undefined {
  const row = get<{ name: string }>(`SELECT name FROM guests WHERE id = ? AND hotel_id = ?`, [memberId, hotelId]);
  return row?.name;
}

/** 金额归一：非法 / 非正 / 超上限一律返回 0，由调用方给出文案 */
function normalizeAmount(amount: number): number {
  const n = round2(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_AMOUNT);
}

/**
 * 按流水重算并回写余额缓存
 *
 * 这是整个模块里唯一允许写 member_wallet.balance 的地方。
 * 账户行不存在时补一条（member_id 唯一索引保证一人一行）。
 */
function recalcBalance(hotelId: number, memberId: number, guestName?: string): number {
  ensureWalletSchema();
  const balance = getWalletBalance(hotelId, memberId);
  const now = nowIso();

  const updated = run(
    `UPDATE member_wallet
        SET balance = ?, updated_at = ?
      WHERE hotel_id = ? AND member_id = ?`,
    [balance, now, hotelId, memberId]
  );
  if (updated.changes <= 0) {
    run(
      `INSERT INTO member_wallet (hotel_id, member_id, guest_name, balance, amount, type, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'ACCOUNT', '储值账户（余额由 member_wallet_ledger 推导）', ?, ?)`,
      [hotelId, memberId, guestName ?? `会员${memberId}`, balance, now, now]
    );
  }
  return balance;
}

/** 幂等键命中：同一 request_id 已记过账，直接返回当前余额 */
function findByRequestId(hotelId: number, requestId: string): { id: number } | undefined {
  return get<{ id: number }>(
    `SELECT id FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`,
    [hotelId, requestId]
  );
}

/** 写一条流水 + 回写余额缓存（必须在 atomically 内调用） */
function insertLedger(opts: {
  hotelId: number;
  memberId: number;
  guestName?: string;
  bizType: WalletBizType;
  signedAmount: number;
  requestId?: string;
  operator?: string;
  remark?: string;
  refType?: string;
  refId?: number;
}): { ledgerId: number; balance: number } {
  const { hotelId, memberId, guestName, bizType, signedAmount } = opts;

  const before = getWalletBalance(hotelId, memberId);
  const after = round2(before + signedAmount);

  const inserted = run(
    `INSERT INTO member_wallet_ledger
       (hotel_id, member_id, biz_type, amount, balance_after,
        ref_type, ref_id, request_id, operator, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hotelId,
      memberId,
      bizType,
      round2(signedAmount),
      after,
      opts.refType ?? null,
      opts.refId ?? null,
      opts.requestId ?? null,
      opts.operator ?? null,
      opts.remark ?? null,
      nowIso(),
    ]
  );

  // 余额一律用流水求和回写，不用上面的 after 直接写——保证「缓存 === 流水」恒等式
  const balance = recalcBalance(hotelId, memberId, guestName);
  return { ledgerId: inserted.lastInsertRowid, balance };
}

/** 前置校验结果：失败带展示文案；成功带会员名与归一化金额；replay 表示幂等命中 */
type Precheck =
  | { ok: false; error: string }
  | { ok: true; guestName: string; amount: number; replay?: number };

/** 统一前置校验：会员、金额、幂等 */
function precheck(hotelId: number, memberId: number, amount: number, requestId?: string): Precheck {
  ensureWalletSchema();

  const id = Math.trunc(Number(memberId));
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "缺少会员 ID，无法办理储值业务" };

  const name = memberNameOf(hotelId, id);
  if (!name) return { ok: false, error: `会员（ID ${id}）不存在，或不属于当前酒店` };

  const amt = normalizeAmount(amount);
  if (!(amt > 0)) return { ok: false, error: `金额必须大于 0 且不超过 ${fmtMoney(MAX_AMOUNT)}` };

  if (requestId) {
    const hit = findByRequestId(hotelId, requestId);
    // 幂等命中：不重复记账，直接返回最新余额（重试 / 重复点击拿到的结果一致）
    if (hit) return { ok: true, guestName: name, amount: amt, replay: getWalletBalance(hotelId, id) };
  }
  return { ok: true, guestName: name, amount: amt };
}

/**
 * 充值：RECHARGE 正数入账
 *
 * @param opts.requestId 幂等键，同一键重复调用只记一次
 */
export function rechargeWallet(
  hotelId: number,
  memberId: number,
  amount: number,
  opts: WalletWriteOpts = {}
): WalletWriteResult {
  const pre = precheck(hotelId, memberId, amount, opts.requestId);
  if (!pre.ok) return { error: pre.error };
  // 幂等命中：这笔请求早就记过账，直接返回当前余额，不再重复记账
  if (pre.replay !== undefined) return { ok: true, balance: pre.replay };

  try {
    return atomically(() => {
      const snapshot = getWalletBalance(hotelId, memberId);
      const out = insertLedger({
        hotelId,
        memberId,
        guestName: pre.guestName,
        bizType: "RECHARGE",
        signedAmount: pre.amount,
        requestId: opts.requestId,
        operator: opts.operator,
        remark: opts.remark ?? `储值充值 ${fmtMoney(pre.amount)}（原余额 ${fmtMoney(snapshot)}）`,
        refType: opts.refType,
        refId: opts.refId,
      });
      return { ok: true as const, balance: out.balance };
    });
  } catch (e) {
    // 并发下同一幂等键被别的请求先写入：唯一索引拦下，回读余额即可
    if (opts.requestId) {
      const hit = findByRequestId(hotelId, opts.requestId);
      if (hit) return { ok: true, balance: getWalletBalance(hotelId, memberId) };
    }
    throw e;
  }
}

/**
 * 消费：CONSUME 负数出账，余额不足直接拒绝
 *
 * 收银台「储值卡扣房费」接这个函数：金额传正数，内部记负数流水。
 */
export function consumeWallet(
  hotelId: number,
  memberId: number,
  amount: number,
  opts: WalletWriteOpts = {}
): WalletWriteResult {
  const pre = precheck(hotelId, memberId, amount, opts.requestId);
  if (!pre.ok) return { error: pre.error };
  // 幂等命中：这笔请求早就记过账，直接返回当前余额，不再重复记账
  if (pre.replay !== undefined) return { ok: true, balance: pre.replay };

  const balance = getWalletBalance(hotelId, memberId);
  if (pre.amount > balance + EPS) {
    return {
      error: `储值余额不足：当前余额 ${fmtMoney(balance)}，本次需扣 ${fmtMoney(pre.amount)}`,
    };
  }

  try {
    return atomically(() => {
      const out = insertLedger({
        hotelId,
        memberId,
        guestName: pre.guestName,
        bizType: "CONSUME",
        signedAmount: -pre.amount,
        requestId: opts.requestId,
        operator: opts.operator,
        remark: opts.remark ?? `储值消费 ${fmtMoney(pre.amount)}（原余额 ${fmtMoney(balance)}）`,
        refType: opts.refType,
        refId: opts.refId,
      });
      return { ok: true as const, balance: out.balance };
    });
  } catch (e) {
    if (opts.requestId) {
      const hit = findByRequestId(hotelId, opts.requestId);
      if (hit) return { ok: true, balance: getWalletBalance(hotelId, memberId) };
    }
    throw e;
  }
}

/**
 * 退款：REFUND 负数出账（把余额退还给客人）
 *
 * 硬约束（整改 P1-3 第 3 条）：
 *   SUM(REFUND 绝对值) + 本次金额 ≤ SUM(RECHARGE) − SUM(CONSUME 绝对值)
 * 超了拒绝，并明确告知累计充值 / 累计消费 / 已退 / 可退上限，避免前台只看到「失败」。
 */
export function refundWallet(
  hotelId: number,
  memberId: number,
  amount: number,
  opts: WalletWriteOpts = {}
): WalletWriteResult {
  const pre = precheck(hotelId, memberId, amount, opts.requestId);
  if (!pre.ok) return { error: pre.error };
  // 幂等命中：这笔请求早就记过账，直接返回当前余额，不再重复记账
  if (pre.replay !== undefined) return { ok: true, balance: pre.replay };

  const sum = getWalletSummary(hotelId, memberId);
  /*
   * 可退上限（第 4 轮 P1-10：漏算 ADJUST，余额可被退成负数）
   *
   * 旧公式：cap = 累计充值 − 累计消费
   *
   * 问题：ADJUST（对账调整）不参与计算。举实际例子：
   *   充值 1000 → 消费 200 → 管理员发现充错了，ADJUST −800
   *   真实余额 = 0，但 cap = 1000 − 200 = 800
   *   → 前台能退 800，退完余额变成 −800（客人倒欠酒店，账永远平不了）
   *
   * 修正：cap 同时受两个约束夹住，取小值：
   *   ① 业务约束：客人能退的不会超过「他实际充进来且没消费掉的钱」
   *      = 累计充值 − 累计消费 + 累计调整（调整带符号：正为加、负为减）
   *   ② 资金约束：不能超过**当前真实余额**（余额是唯一能付出去的钱）
   *
   * 两个都取小，既不会退超实际余额，也不会把赠送/调整的钱当现金退出去。
   */
  const bizCap = round2(sum.recharge - sum.consume + sum.adjust);
  const currentBalance = getWalletBalance(hotelId, memberId);
  /*
   * 两个上限必须**分开校验**，不能先取小再比累计
   *
   * 上一版是：
   *     const cap = min(bizCap, currentBalance);
   *     if (sum.refund + amount > cap) 拒;
   *
   * 问题是 currentBalance 里**已经扣过历史退款**，而 bizCap 没有。
   * 于是「已退金额」被扣了两次：
   *   充值 1000 / 消费 200 → bizCap 800，余额 800
   *   退 300 → 余额 500，sum.refund 300
   *   再退 500 → cap = min(800, 500) = 500，累计 800 > 500 → **被拒**
   * 但累计退 800 正好等于 bizCap，业务上完全允许 —— 退一半后剩下的退不出来。
   *
   * 正确做法：
   *   ① 累计约束：sum.refund + 本次 ≤ bizCap   （业务上限，与余额无关）
   *   ② 单笔约束：本次 ≤ currentBalance       （不能退不存在的钱）
   * 两条各自独立成立即可，不需要先取小。
   */
  const afterRefund = round2(sum.refund + pre.amount);

  /* ① 累计退款不能超过「实际充进来且没消费掉的钱」 */
  if (afterRefund > bizCap + EPS) {
    return {
      error:
        `退款超出可退上限：累计退款 ${fmtMoney(sum.refund)} + 本次 ${fmtMoney(pre.amount)} = ${fmtMoney(afterRefund)}，` +
        `上限 ${fmtMoney(bizCap)}（累计充值 ${fmtMoney(sum.recharge)} − 累计消费 ${fmtMoney(sum.consume)}` +
        `${sum.adjust !== 0 ? ` + 调整 ${fmtMoney(sum.adjust)}` : ""}）`,
    };
  }

  /* ② 单笔不能超过当前真实余额（余额是唯一能付出去的钱） */
  if (pre.amount > currentBalance + EPS) {
    return {
      error:
        `退款金额 ${fmtMoney(pre.amount)} 超过会员当前储值余额 ${fmtMoney(currentBalance)}，` +
        `不能退不存在的钱`,
    };
  }

  try {
    return atomically(() => {
      const out = insertLedger({
        hotelId,
        memberId,
        guestName: pre.guestName,
        bizType: "REFUND",
        signedAmount: -pre.amount,
        requestId: opts.requestId,
        operator: opts.operator,
        remark: opts.remark ?? `储值退款 ${fmtMoney(pre.amount)}（累计退款将达 ${fmtMoney(afterRefund)}）`,
        refType: opts.refType,
        refId: opts.refId,
      });
      return { ok: true as const, balance: out.balance };
    });
  } catch (e) {
    if (opts.requestId) {
      const hit = findByRequestId(hotelId, opts.requestId);
      if (hit) return { ok: true, balance: getWalletBalance(hotelId, memberId) };
    }
    throw e;
  }
}

/**
 * 人工调整：ADJUST 双向（对账差异、迁移纠偏）
 *
 * 不走退款校验，因为人工调整本身就是「让账对得上」的手段；
 * 仍然必须留备注与操作人，便于审计。
 */
export function adjustWallet(
  hotelId: number,
  memberId: number,
  amount: number,
  opts: WalletWriteOpts = {}
): WalletWriteResult {
  const signed = round2(Number(amount));
  if (!Number.isFinite(signed) || Math.abs(signed) < 0.01 || Math.abs(signed) > MAX_AMOUNT) {
    return { error: `调整金额不能为 0，且绝对值不超过 ${fmtMoney(MAX_AMOUNT)}` };
  }
  const id = Math.trunc(Number(memberId));
  const guestName = memberNameOf(hotelId, id);
  if (!guestName) return { error: `会员（ID ${id}）不存在，或不属于当前酒店` };

  return atomically(() => {
    const out = insertLedger({
      hotelId,
      memberId: id,
      guestName,
      bizType: "ADJUST",
      signedAmount: signed,
      requestId: opts.requestId,
      operator: opts.operator,
      remark: opts.remark ?? `人工调整 ${signed > 0 ? "+" : ""}${fmtMoney(Math.abs(signed))}`,
      refType: opts.refType,
      refId: opts.refId,
    });
    return { ok: true as const, balance: out.balance };
  });
}

/**
 * 对账自检：余额缓存与流水不一致的会员清单（体检脚本 / 夜审可用）
 * 返回空数组表示「缓存 === 流水」恒等式在全店成立。
 */
export function findWalletDrift(hotelId: number): { memberId: number; cached: number; ledger: number }[] {
  ensureWalletSchema();
  const rows = all<{ member_id: number; cached: number | null; ledger: number | null }>(
    `SELECT w.member_id,
            w.balance AS cached,
            (SELECT COALESCE(SUM(x.amount), 0)
               FROM member_wallet_ledger x
              WHERE x.hotel_id = w.hotel_id AND x.member_id = w.member_id) AS ledger
       FROM member_wallet w
      WHERE w.hotel_id = ? AND w.member_id IS NOT NULL`,
    [hotelId]
  );
  return rows
    .map((r) => ({
      memberId: Number(r.member_id),
      cached: round2(Number(r.cached ?? 0)),
      ledger: round2(Number(r.ledger ?? 0)),
    }))
    .filter((r) => Math.abs(r.cached - r.ledger) > EPS);
}
