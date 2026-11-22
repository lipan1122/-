/**
 * 退款二次确认 + 储值退款约束验收（最终版清单第四节第 9 项 / P2-1 第 233-240 行）
 *
 * 清单原话（退款表单必须满足）：
 *   · 预设金额按钮不能 type="submit"
 *   · 预设按钮只填金额
 *   · 最终提交经过 ConfirmForm
 *   · 显示会员姓名、退款金额、退款后余额
 *   · 退款原因必填
 *   · Server Action 仍校验权限、余额、累计可退金额和幂等 request_id
 *
 * ── 被验收的旧缺陷 ──
 * 旧退款表单在 Server Component 里，预设金额按钮是 `type="submit"`：
 * 点 100 / 500 / 1000 / 2000 直接提交退款，误点一下钱就出去了，且全程没有二次确认。
 *
 * ── 本脚本验两半 ──
 *  A. 静态：RefundForm.tsx 的预设按钮、ConfirmForm 包裹、原因必填、
 *     Server Action 的权限 / 幂等键、lib 的可退上限公式；
 *  B. 动态：真库副本（.tmp）里在 hotel 9999 造会员与储值流水，
 *     把 `src/lib/member-wallet.ts` 的 refundWallet 记账/校验逻辑按源码 1:1 复刻执行
 *     （含 request_id 唯一索引），断言余额精确到分、超额被拒、幂等只退一次。
 *
 * ── 关于「退款后余额」的方向 ──
 * member-wallet.ts 文件头把 REFUND 定义为**出账**（signedAmount = -amount，
 * 「把卡里的余额退还给客人」），refundWalletAction 的成功文案也是
 * 「已从 X 储值账户退款 … 余额 r.balance」。所以退款后余额 = 退款前 − 退款额。
 * 测试按这个**唯一记账口径**断言，并额外断言表单展示的方向必须与之相同
 * （清单要求确认框显示「退款后余额」，显示错的数字等于没显示）。
 *
 * ── unable to open database file（清单 281-287 行）──
 *   PMS_DB_PATH / .tmp 先建且可写 / VACUUM INTO 路径转 / 与 '' / timeout 防并发迁移持锁 /
 *   副本连 -wal -shm 一起删。
 *
 * 用法：node scripts/test-refund-confirmation.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? " → " + extra : ""}`);
  }
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cent = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const norm = (s) => s.replace(/\s+/g, " ").trim();

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const H = 9999;
const EPS = 0.001;

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

function openCopy(tag) {
  if (!existsSync(REAL_DB)) {
    console.error(`真实库不存在：${REAL_DB}（用 PMS_DB_PATH 指定，或先 init-db）`);
    process.exit(1);
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}.db`);
  try {
    const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    try {
      src.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
    } finally {
      src.close();
    }
  } catch (e) {
    console.error(
      `复制真库失败：${e.message}\n  真实库 ${REAL_DB}\n  目标 ${tmp}\n` +
        `  排查：PMS_DB_PATH / .tmp 写权限 / 路径分隔符与引号转义 / 残留 -wal 占用`
    );
    process.exit(1);
  }
  const db = new DatabaseSync(tmp, { timeout: 10000 });
  return {
    db,
    tmp,
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-wal`, { force: true });
      rmSync(`${tmp}-shm`, { force: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * A. 静态：退款表单 + Server Action
 * ------------------------------------------------------------------ */
const FORM_FILE = join("src", "app", "(main)", "members", "wallet", "RefundForm.tsx");
const ACTION_FILE = join("src", "app", "(main)", "members", "wallet", "actions.ts");
const CONFIRM_FILE = join("src", "components", "ConfirmForm.tsx");
const WALLET_FILE = join("src", "lib", "member-wallet.ts");

const formSrc = readFileSync(FORM_FILE, "utf8");
const actionSrc = readFileSync(ACTION_FILE, "utf8");
const confirmSrc = readFileSync(CONFIRM_FILE, "utf8");
const walletSrc = readFileSync(WALLET_FILE, "utf8");
const nForm = norm(formSrc);
const nWallet = norm(walletSrc);

/** 预设金额按钮区块：从 PRESETS.map 到该段 </div> */
function presetBlock(src) {
  const i = src.indexOf("PRESETS.map");
  if (i < 0) return "";
  const j = src.indexOf("</div>", i);
  return src.slice(i, j < 0 ? Math.min(i + 900, src.length) : j);
}
const presetSrc = presetBlock(formSrc);

console.log("=== A. 静态：预设按钮只填值，最终提交经过 ConfirmForm ===");

check(
  "预设金额按钮是 type=\"button\"（不再是 type=\"submit\"）",
  /type="button"/.test(presetSrc),
  norm(presetSrc).slice(0, 160)
);
check(
  "预设按钮点击只把金额填进输入框（setAmount），不提交",
  /onClick=\{\(\)\s*=>\s*setAmount\(/.test(presetSrc) && /setAmount\(String\(v\)\)/.test(presetSrc),
  norm(presetSrc).slice(0, 160)
);
check(
  "预设按钮区块里没有 type=\"submit\"（误点不会提交退款）",
  !/type="submit"/.test(presetSrc),
  norm(presetSrc).slice(0, 160)
);
check(
  '最终提交经过 ConfirmForm（import + <ConfirmForm action={action}>）',
  /import\s+ConfirmForm\s+from/.test(formSrc) && /<ConfirmForm/.test(formSrc) && /action=\{action\}/.test(formSrc),
  "未找到 ConfirmForm 包裹"
);
check(
  "ConfirmForm 收到 requireReason（退款原因必填）",
  /requireReason="退款原因"/.test(formSrc) || /requireReason=\{?"退款原因"/.test(formSrc),
  (nForm.match(/requireReason=[^ >]{0,40}/) ?? [""])[0]
);
check(
  "确认框展示会员姓名 + 退款金额 + 退款后余额",
  /guestName/.test(formSrc) && /fmtMoney\(num\)/.test(formSrc) && /fmtMoney\(after\)/.test(formSrc) && /余额/.test(formSrc),
  "确认文案缺姓名/金额/退款后余额之一"
);
check(
  "ConfirmForm 自身会拦截提交、原因为空时禁止确认，并把 reason 注入 FormData",
  /if\s*\(requireReason\s*&&\s*reason\.trim\(\)\.length\s*===\s*0\)\s*return/.test(confirmSrc) &&
    /fd\.set\("reason"/.test(confirmSrc) &&
    /action\(fd\)/.test(confirmSrc),
  "ConfirmForm 未强制原因或未注入 reason"
);
check(
  "RefundForm 里真正触发确认的按钮是 type=\"button\"（原生提交被 ConfirmForm 接管）",
  /*
   * 按钮文案可能是三元链（先判 exceed 再判 valid），不能写死 `>{valid ? "退款"`。
   * 另外这个文件的注释里解释了「原来预设按钮是 type="submit"」，
   * 直接搜 `type="submit"` 会命中注释 —— 必须只匹配真实 <button> 标签。
   */
  /<button[\s\S]{0,300}type="button"[\s\S]{0,300}>[\s\S]{0,120}"退款"/.test(formSrc) &&
    !/<button[^>]*\btype="submit"/.test(formSrc),
  norm(formSrc.slice(formSrc.indexOf("confirmLabel"), formSrc.indexOf("</ConfirmForm>"))).slice(0, 160)
);

/* Server Action：权限 / 幂等 / 余额 */
function funcBody(src, name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}
const refundActionBody = funcBody(actionSrc, "refundWalletAction");

check(
  'Server Action 仍校验权限 requirePermission("cashier.refund")',
  /requirePermission\(\s*"cashier\.refund"\s*\)/.test(refundActionBody),
  norm(refundActionBody).slice(0, 120)
);
check(
  "Server Action 仍读取幂等键 request_id 并透传给 refundWallet",
  /formData\.get\("request_id"\)/.test(refundActionBody) && /requestId/.test(refundActionBody),
  norm(refundActionBody).slice(0, 160)
);
check(
  "Server Action 调服务层 refundWallet（不自己 UPDATE 余额）",
  /refundWallet\(\s*hotelId/.test(refundActionBody) && !/UPDATE\s+member_wallet/i.test(actionSrc),
  "退款绕过了服务层"
);
check(
  "lib 的可退上限：累计约束与单笔约束分开校验（不是先取小再比累计）",
  /* ① bizCap 的算法不变 */
  /bizCap\s*=\s*round2\(\s*sum\.recharge\s*-\s*sum\.consume\s*\+\s*sum\.adjust\s*\)/.test(walletSrc) &&
    /* ② 旧写法 min(bizCap, currentBalance) 必须已经不存在 */
    !/Math\.min\(\s*bizCap\s*,\s*currentBalance\s*\)/.test(walletSrc) &&
    /* ③ 存在「累计退款 + 本次 > bizCap」的独立校验 */
    /afterRefund\s*>\s*bizCap\s*\+\s*EPS/.test(walletSrc) &&
    /* ④ 存在「本次 > currentBalance」的独立校验 */
    /pre\.amount\s*>\s*currentBalance\s*\+\s*EPS/.test(walletSrc),
  (nWallet.match(/const (?:cap|afterRefund|bizCap) =[^;]{0,120};/) ?? [""])[0]
);

/* 方向一致性：表单展示的「退款后余额」必须与服务端记账方向相同 */
const formAfterExpr = (formSrc.match(/const after = valid \? ([^:]+):/) ?? [])[1] ?? "";
const formUsesMinus = /balance\s*-\s*num/.test(formAfterExpr);
check(
  "确认框的「退款后余额」与服务端记账方向一致（REFUND 出账 → 余额减少）",
  formUsesMinus,
  formAfterExpr.trim()
    ? `表单算的是 ${formAfterExpr.trim()}，而 refundWallet 记 signedAmount = -amount（余额减少）`
    : "取不到 after 表达式"
);
check(
  "确认框填写的「退款原因」会落进流水备注（服务端读取 reason）",
  /formData\.get\("reason"\)/.test(refundActionBody) || /reason/.test(refundActionBody),
  "refundWalletAction 只读 note，确认框注入的 reason 被丢弃"
);

/* ------------------------------------------------------------------ *
 * B. 动态：真库副本里跑退款
 * ------------------------------------------------------------------ */
console.log("\n=== B. 真库副本实测（.tmp 副本 · 租户 9999 储值账户）===");

const copy = openCopy("refund-confirmation");
const { db } = copy;
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

/* 与 member-wallet.ts 同口径的只读汇总 */
function balanceOf(hotelId, memberId) {
  return round2(
    Number(
      one(`SELECT COALESCE(SUM(amount), 0) AS b FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`, [
        hotelId,
        memberId,
      ]).b
    )
  );
}
function summaryOf(hotelId, memberId) {
  const r = one(
    `SELECT
       COALESCE(SUM(CASE WHEN biz_type = 'RECHARGE' THEN amount ELSE 0 END), 0) AS recharge,
       COALESCE(SUM(CASE WHEN biz_type = 'CONSUME' THEN -amount ELSE 0 END), 0) AS consume,
       COALESCE(SUM(CASE WHEN biz_type = 'REFUND' THEN ABS(amount) ELSE 0 END), 0) AS refund,
       COALESCE(SUM(CASE WHEN biz_type = 'ADJUST' THEN amount ELSE 0 END), 0) AS adjust
     FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`,
    [hotelId, memberId]
  );
  return {
    recharge: round2(Number(r.recharge)),
    consume: round2(Number(r.consume)),
    refund: round2(Number(r.refund)),
    adjust: round2(Number(r.adjust)),
    balance: balanceOf(hotelId, memberId),
  };
}
function ledgerInsert(hotelId, memberId, bizType, signedAmount, requestId = null, remark = "") {
  run(
    `INSERT INTO member_wallet_ledger
       (hotel_id, member_id, biz_type, amount, balance_after, request_id, operator, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      hotelId,
      memberId,
      bizType,
      round2(signedAmount),
      balanceOf(hotelId, memberId) + round2(signedAmount),
      requestId,
      "测试收银",
      remark,
      "2030-06-15T10:00:00.000+08:00",
    ]
  );
}

/**
 * 1:1 复刻 src/lib/member-wallet.ts 的 refundWallet：
 *   precheck（会员 / 金额 / 幂等）→ 可退上限 min(bizCap, balance) → 插负数 REFUND 流水
 * 幂等命中直接返回当前余额；并发下唯一索引拦下也算幂等。
 */
function refundWalletSim(hotelId, memberId, amount, requestId) {
  const guest = one(`SELECT name FROM guests WHERE id = ? AND hotel_id = ?`, [memberId, hotelId]);
  if (!guest) return { error: "会员不存在" };
  const amt = round2(Number(amount));
  if (!(amt > 0)) return { error: "金额必须大于 0" };
  if (requestId) {
    const hit = one(`SELECT id FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [hotelId, requestId]);
    if (hit) return { ok: true, balance: balanceOf(hotelId, memberId), replay: true };
  }
  const sum = summaryOf(hotelId, memberId);
  const currentBalance = sum.balance;
  /*
   * 两个上限分开校验（与 src/lib/member-wallet.ts 当前的实现一致）
   *
   * 原来这里复制的是旧逻辑 `cap = min(bizCap, currentBalance)`，
   * 而 currentBalance 已扣过历史退款、bizCap 没有 → 已退金额被扣两次：
   * 充值 1000 / 消费 200（bizCap 800），退 300 后余额 500，
   * 再退 500 → cap = min(800,500) = 500，累计 800 > 500 → 被拒。
   * 但累计退满 800 正好等于业务上限，应当允许。
   *
   * ⚠️ 这个 sim 是 lib 实现的副本，改 member-wallet.ts 时要同步改这里。
   */
  const bizCap = round2(sum.recharge - sum.consume + sum.adjust);
  const afterRefund = round2(sum.refund + amt);

  /* ① 累计约束：累计退款 ≤ 累计充值 − 累计消费 + 调整 */
  if (afterRefund > bizCap + EPS) {
    return {
      error: `退款超出可退上限：累计退款 ${sum.refund} + 本次 ${amt} = ${afterRefund}，上限 ${bizCap}`,
    };
  }
  /* ② 单笔约束：本次 ≤ 当前余额 */
  if (amt > currentBalance + EPS) {
    return {
      error: `退款金额 ${amt} 超过当前储值余额 ${currentBalance}`,
    };
  }
  try {
    ledgerInsert(hotelId, memberId, "REFUND", -amt, requestId, `储值退款 ${amt}`);
    return { ok: true, balance: balanceOf(hotelId, memberId) };
  } catch (e) {
    if (requestId && /UNIQUE/i.test(String(e.message))) {
      return { ok: true, balance: balanceOf(hotelId, memberId), replay: true };
    }
    throw e;
  }
}

try {
  /* 租户 + 会员 */
  run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [
    H,
    "TEST-REFUND-9999",
    "退款测试酒店",
    "测试地址",
    "000",
  ]);
  let guestSeq = 0;
  const addMember = (name) => {
    guestSeq += 1;
    run(`INSERT INTO guests (hotel_id, name, mobile, vip_level) VALUES (?,?,?,?)`, [H, name, `1390000${1000 + guestSeq}`, 1]);
    return Number(one(`SELECT id FROM guests WHERE hotel_id = ? AND name = ?`, [H, name]).id);
  };
  const memberId = addMember("储值测试会员");

  /* ---- 场景 1：单笔退款的方向与精度 ---- */
  ledgerInsert(H, memberId, "RECHARGE", 1000, `req-recharge-${H}`);
  ledgerInsert(H, memberId, "CONSUME", -200, `req-consume-${H}`);
  check("充值 1000 − 消费 200 = 余额 800.00（精确到分）", cent(balanceOf(H, memberId)) === 800, `余额 ${balanceOf(H, memberId)}`);

  const r1 = refundWalletSim(H, memberId, 500, `req-refund-${H}-1`);
  check("退款 500 被接受（未超可退上限 800）", !("error" in r1), JSON.stringify(r1));
  check("退款后余额 = 退款前 − 退款额：800.00 − 500.00 = 300.00", !("error" in r1) && cent(r1.balance) === 300, JSON.stringify(r1));
  const refundRow = one(
    `SELECT amount, biz_type, balance_after FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`,
    [H, `req-refund-${H}-1`]
  );
  check(
    "流水记的是 REFUND 负数（-500），balance_after 快照 = 300.00",
    refundRow?.biz_type === "REFUND" && cent(refundRow.amount) === -500 && cent(refundRow.balance_after) === 300,
    JSON.stringify(refundRow)
  );
  check(
    "余额恒等式：balance = SUM(流水) = 300.00（缓存与流水不分叉）",
    cent(balanceOf(H, memberId)) ===
      cent(
        one(`SELECT COALESCE(SUM(amount), 0) AS s FROM member_wallet_ledger WHERE hotel_id = ? AND member_id = ?`, [
          H,
          memberId,
        ]).s
      ) && cent(balanceOf(H, memberId)) === 300
  );

  /* ---- 场景 2：单笔超过可退上限必须被拒，且不落流水 ---- */
  const m2 = addMember("超额退款会员");
  ledgerInsert(H, m2, "RECHARGE", 1000, null);
  ledgerInsert(H, m2, "CONSUME", -200, null);
  const over = refundWalletSim(H, m2, 900, `req-over-${H}`);
  check(
    "单笔退款 900 > 可退上限 800 被拒（文案含「可退上限」）",
    "error" in over && /可退上限/.test(over.error),
    JSON.stringify(over)
  );
  check(
    "被拒的退款不写流水、不动余额（余额仍 800.00）",
    cent(balanceOf(H, m2)) === 800 &&
      Number(one(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [H, `req-over-${H}`]).c) === 0,
    `余额 ${balanceOf(H, m2)}`
  );

  /* ---- 场景 3：余额为 0 时再退 0.01 必须被拒，绝不退成负数 ---- */
  const m3 = addMember("零余额会员");
  ledgerInsert(H, m3, "RECHARGE", 100, null);
  ledgerInsert(H, m3, "CONSUME", -100, null);
  const zeroTry = refundWalletSim(H, m3, 0.01, `req-zero-${H}`);
  check(
    "余额 0 时再退 0.01 被拒，余额保持 0（不会退成负数）",
    "error" in zeroTry && cent(balanceOf(H, m3)) === 0,
    JSON.stringify(zeroTry)
  );

  /* ---- 场景 4：分单位精度 1000.10 − 200.05 − 300.05 = 500.00 ---- */
  const m4 = addMember("分精度会员");
  ledgerInsert(H, m4, "RECHARGE", 1000.1, null);
  ledgerInsert(H, m4, "CONSUME", -200.05, null);
  const p1 = refundWalletSim(H, m4, 300.05, `req-cent-${H}`);
  check(
    "分单位精度：1000.10 − 200.05 − 300.05 = 500.00（无浮点尾差）",
    !("error" in p1) && cent(p1.balance) === 500,
    JSON.stringify(p1)
  );

  /* ---- 场景 5：分两笔退满「累计可退」（源码注释里的硬约束）----
   * member-wallet.ts 文件头写的硬约束是：
   *   SUM(REFUND 绝对值) + 本次金额 ≤ SUM(RECHARGE) − SUM(CONSUME) = 800
   * 所以 300 + 500 应当允许（恰好退满）。
   * 但实现里 cap 又夹了「当前余额」，而余额已被第一笔退掉 → 累计退款被重复扣减。
   */
  const m5 = addMember("分笔退满会员");
  ledgerInsert(H, m5, "RECHARGE", 1000, null);
  ledgerInsert(H, m5, "CONSUME", -200, null);
  const part1 = refundWalletSim(H, m5, 300, `req-split-${H}-1`);
  const part2 = refundWalletSim(H, m5, 500, `req-split-${H}-2`);
  check(
    "分两笔退满累计可退额度（300 + 500 = 800 = 累计充值 − 累计消费）",
    !("error" in part1) && !("error" in part2) && cent(balanceOf(H, m5)) === 0,
    `第一笔 ${JSON.stringify(part1)} / 第二笔 ${JSON.stringify(part2)}`
  );

  /* ---- 场景 6：幂等 request_id 只退一次 ---- */
  const m6 = addMember("幂等退款会员");
  ledgerInsert(H, m6, "RECHARGE", 1000, null);
  const reqId = `req-idem-${H}`;
  const i1 = refundWalletSim(H, m6, 200, reqId);
  const balAfterFirst = balanceOf(H, m6);
  const i2 = refundWalletSim(H, m6, 200, reqId);
  const ledgerRows = Number(
    one(`SELECT COUNT(*) AS c FROM member_wallet_ledger WHERE hotel_id = ? AND request_id = ?`, [H, reqId]).c
  );
  check(
    "同一 request_id 重复提交只退一次（流水 1 条，余额不再减少）",
    !("error" in i1) && !("error" in i2) && ledgerRows === 1 && cent(balanceOf(H, m6)) === cent(balAfterFirst),
    `流水 ${ledgerRows} 条，余额 ${balanceOf(H, m6)}（首退后 ${balAfterFirst}）`
  );
  check("幂等第二次调用返回 replay（与服务端 precheck 命中分支一致）", i2.replay === true, JSON.stringify(i2));
  check(
    "DB 层幂等键（唯一索引 idx_wallet_ledger_request）真实存在",
    /CREATE UNIQUE INDEX[\s\S]{0,120}idx_wallet_ledger_request/i.test(
      one(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_wallet_ledger_request'`)?.sql ?? ""
    ),
    "缺唯一索引 → 并发重复提交会退两次"
  );

  /* ---- 权限面：cashier.refund 不是人人都有 ---- */
  const granted = all(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = 'cashier.refund'`).map(
    (r) => r.role
  );
  check(
    "cashier.refund 只授予 admin / cashier（housekeeping、frontdesk 无退款权限）",
    granted.length > 0 && granted.every((r) => r === "admin" || r === "cashier"),
    `实际授予：${granted.join(", ") || "无"}`
  );
} catch (e) {
  check("副本内造数与退款流程执行成功", false, e.message);
} finally {
  copy.close();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
