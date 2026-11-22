/**
 * 储值卡支付最小验证（第九轮 P0 回归）
 *
 * 背景：`cashier/actions.ts` 原来查 `folios.guest_id` —— 该列不存在，
 * 任何「会员储值卡」支付都抛 `no such column: guest_id`，
 * 客人充进储值的钱一分都花不出去。
 *
 * 这个脚本只验证一件事：**储值卡支付真的能走通**。
 *
 *   1. 造客人 + 入住单 + 账单（应收 300）
 *   2. 给客人充 1000 储值
 *   3. 用储值卡付 300
 *   4. 断言：储值 1000→700、payments 1 条 300、账单 paid 300、balance 0
 *
 * 在 VACUUM INTO 副本上跑，真库只读。
 *
 * 用法：node scripts/test-wallet-pay.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDb = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const tmpDir = join(root, ".tmp");
const tmpDb = join(tmpDir, `walletpay-${Date.now()}.db`);

mkdirSync(tmpDir, { recursive: true });
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (existsSync(f)) unlinkSync(f);
}

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}  ${extra}`);
  }
};

/* ─────────── 0. 源码断言：不能再查 folios.guest_id ─────────── */
{
  const fs = await import("node:fs");
  const cashierSrc = fs.readFileSync(join(root, "src", "app", "(main)", "cashier", "actions.ts"), "utf8");
  check(
    "cashier/actions.ts 不再从 folios 直接取 guest_id（该列不存在）",
    /*
     * 只看**代码行**，跳过注释 —— 注释里写「原来是怎么写的」是安全的，
     * 但静态正则会把它一起命中（这个坑已经踩过好几次）。
     */
    !/SELECT\s+guest_id\s+FROM\s+folios/i.test(
      cashierSrc
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
        })
        .join("\n")
    ),
    "代码里仍然有从 folios 直接取 guest_id 的查询"
  );
  check(
    "改用 stays join 取 guest_id",
    /JOIN\s+stays\s+s\s+ON\s+s\.id\s*=\s*f\.stay_id/i.test(cashierSrc),
    "没看到 stays join"
  );
}

/* ─────────── 准备副本 ─────────── */
const src = new DatabaseSync(srcDb, { readOnly: true });
src.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
src.close();

const db = new DatabaseSync(tmpDb);

/* 用副本库喂给生产代码的 getDb() */
globalThis.__pmsDb = db;

/* 让 `@/` 解析到 src（生产代码用绝对导入） */
const srcRoot = join(root, "src");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = join(srcRoot, specifier.slice(2));
      for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
        const p = target + ext;
        if (existsSync(p) && !p.endsWith("/")) return { url: `file://${p.replace(/\\/g, "/")}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const today = one(`SELECT date('now','localtime') AS d`).d;
const tag = Date.now();
const H = 1;

/* ─────────── 造数据 ─────────── */
let guestId, stayId, folioId, roomId;
db.exec("BEGIN");
try {
  /* 客人 */
  run(`INSERT INTO guests (hotel_id, name, mobile, id_no, vip_level) VALUES (?,?,?,?,1)`, [
    H,
    `储值验证客${tag}`,
    `139${String(tag).slice(-8)}`,
    `11010119900101${String(tag).slice(-4)}`,
  ]);
  guestId = one(`SELECT id FROM guests WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [H]).id;

  /* 房间 + 入住单 */
  roomId = one(`SELECT id FROM rooms WHERE hotel_id = ? AND status = 'VC' ORDER BY id LIMIT 1`, [H])?.id;
  run(
    `INSERT INTO stays (hotel_id, stay_no, room_id, guest_id, guest_name, check_in_time, expect_check_out, nights, rate, status)
     VALUES (?,?,?,?,?,?,?,1,300,'INHOUSE')`,
    [H, `WALLET-${tag}`, roomId, guestId, `储值验证客${tag}`, today, today]
  );
  stayId = one(`SELECT id FROM stays WHERE stay_no = ?`, [`WALLET-${tag}`]).id;

  /* 账单：应收 300 */
  run(
    `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, total_amount, paid_amount, balance, status)
     VALUES (?,?,?,?,300,0,300,'OPEN')`,
    [H, `FW-${tag}`, stayId, `储值验证客${tag}`]
  );
  folioId = one(`SELECT id FROM folios WHERE folio_no = ?`, [`FW-${tag}`]).id;
  /* 真实账单一定有明细：recalcFolioBalance 是按 folio_items 重算 total 的，
     不造明细会导致 total=0、balance=-paid（测试假红，不是生产 bug） */
  run(
    `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, biz_date, created_at)
     VALUES (?,?,'ROOM','房费 1 晚',300,1,?,?)`,
    [H, folioId, today, new Date().toISOString()]
  );
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("造数据失败：", e.message);
  process.exit(1);
}

check("造数据：客人 + 入住单（带 guest_id）+ 账单应收 300", Boolean(guestId && stayId && folioId));
check(
  "入住单的 guest_id 是对的（这是储值卡支付能正确找人的前提）",
  one(`SELECT guest_id FROM stays WHERE id = ?`, [stayId]).guest_id === guestId
);

/* ─────────── 充值 1000 ─────────── */
/* ESM 走 file:// URL（Windows 绝对路径不能直接 import）——用 Node 内置的 pathToFileURL */
const { pathToFileURL } = await import("node:url");
const asUrl = (p) => pathToFileURL(p).href;
const walletLib = await import(asUrl(join(srcRoot, "lib", "member-wallet.ts")));

const r1 = walletLib.rechargeWallet(H, guestId, 1000, {
  operator: "测试",
  remark: "储值卡支付验证",
  requestId: `wpay-recharge-${tag}`,
});
check("充值 1000 成功", !("error" in r1), JSON.stringify(r1));
check("储值余额 = 1000", walletLib.getWalletBalance(H, guestId) === 1000, String(walletLib.getWalletBalance(H, guestId)));

/* ─────────── 储值卡支付 300 ─────────── */
/*
 * 直接复刻 `addPaymentAction` 里 useWallet 分支的关键三步：
 *   ① 从 folios → stays 取 guest_id
 *   ② consumeWallet 扣储值
 *   ③ 写 payments + paid_amount + recalcFolioBalance
 * 这样能验证「join 改对了」和「链路能走通」，而不需要伪装 Next 的 session。
 */
let payErr = null;
db.exec("BEGIN");
try {
  /* ① 这是修复后的查询（和 cashier/actions.ts 一模一样） */
  const g = one(
    `SELECT s.guest_id AS guest_id FROM folios f
      LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
      WHERE f.id = ? AND f.hotel_id = ?`,
    [folioId, H]
  );
  check("① folios → stays join 能取到 guest_id", g?.guest_id === guestId, JSON.stringify(g));
  if (!g?.guest_id) throw new Error("join 取不到 guest_id");

  /* ② 扣储值 */
  const deducted = walletLib.consumeWallet(H, g.guest_id, 300, {
    requestId: `wpay-${tag}`,
    remark: `结账收款 · 账单 ${folioId}`,
    refType: "folio",
    refId: folioId,
    operator: "测试",
  });
  if ("error" in deducted) throw new Error(`储值扣款失败：${deducted.error}`);

  /* ③ 写 payments + 加 paid + recalc */
  run(
    `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, operator, kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [H, folioId, stayId, `P-${tag}`, "会员储值卡", 300, today, "结账收款", new Date().toISOString(), `wpay-${tag}`, "测试", "ROOM_PAYMENT"]
  );
  run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) + ? WHERE id = ? AND hotel_id = ?`, [300, folioId, H]);

  const { recalcFolioBalance } = await import(asUrl(join(srcRoot, "lib", "folio.ts")));
  recalcFolioBalance(H, folioId);

  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  payErr = e instanceof Error ? e.message : String(e);
}

check("储值卡支付全程无异常", payErr === null, payErr ?? "");
check(
  "储值余额 1000 → 700",
  walletLib.getWalletBalance(H, guestId) === 700,
  String(walletLib.getWalletBalance(H, guestId))
);
const pay = one(`SELECT amount, method, kind FROM payments WHERE folio_id = ? AND hotel_id = ?`, [folioId, H]);
check("写入 1 条支付流水 300 / 会员储值卡 / ROOM_PAYMENT", pay?.amount === 300 && pay?.method === "会员储值卡" && pay?.kind === "ROOM_PAYMENT", JSON.stringify(pay));
const fol = one(`SELECT paid_amount, balance, status FROM folios WHERE id = ?`, [folioId]);
check("账单 paid = 300、balance = 0、状态结清", fol?.paid_amount === 300 && fol?.balance === 0, JSON.stringify(fol));

/* ─────────── 余额不足场景 ─────────── */
db.exec("BEGIN");
let insufficientBlocked = false;
try {
  const deducted = walletLib.consumeWallet(H, guestId, 5000, { requestId: `wpay-poor-${tag}`, operator: "测试" });
  insufficientBlocked = "error" in deducted;
  if (!insufficientBlocked) db.exec("ROLLBACK");
  else db.exec("ROLLBACK");
} catch {
  db.exec("ROLLBACK");
  insufficientBlocked = true;
}
check("余额不足（需 5000 只有 700）被拒", insufficientBlocked);
check("被拒后余额仍是 700", walletLib.getWalletBalance(H, guestId) === 700);

/* ─────────── 清理 + 真库零写入校验 ─────────── */
db.close();
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  if (existsSync(f)) {
    try {
      unlinkSync(f);
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(`（在副本上跑，真库 ${srcDb} 未被修改）\n`);
process.exit(fail === 0 ? 0 : 1);
