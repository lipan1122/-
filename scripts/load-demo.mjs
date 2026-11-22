/**
 * 导入演示数据（把本机的完整演示库装到目标机）
 *
 * 用法：
 *   node scripts/load-demo.mjs              # 导入（会备份现有库）
 *   node scripts/load-demo.mjs --force      # 库里有真实数据也强制覆盖
 *   node scripts/load-demo.mjs --check      # 只看会做什么
 *
 * ── 演示数据包含什么 ──
 *   46 间客房（8 个房型，含 2 间维修房）
 *   588 条预订（PENDING / CONFIRMED / CHECKED_IN / CHECKED_OUT / CANCELLED / NOSHOW）
 *   200 张入住单、200 张账单、205 条收款流水
 *   45 个客人档案、会员储值、AR 应收、68 张报表都有数据
 *
 * ── 安全说明 ──
 * 包里所有客人姓名/手机号/证件号都是**虚构的**（张伟 13800001111 这类）。
 * 但 users 表的 password_hash 是真实计算过的 scrypt 哈希。
 * 导入后会把 4 个账号的密码统一重置为下面 DEMO_PASSWORDS 里的值
 * —— 就算哈希被抄走也只能登进这个演示环境，且我们会提示上线前改密码。
 *
 * ── 为什么不直接 git 里放 .db ──
 * .gitignore 明确排除 data/*.db（真实运营时必须），所以演示库单独打包成
 * gz 放在 scripts/demo-data/ 下，只在显式调用本脚本时解压覆盖。
 */
import { existsSync, copyFileSync, createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const demoGz = join(here, "demo-data", "pms-demo.db.gz");
const dataDir = join(root, "data");
const target = process.env.PMS_DB_PATH ?? join(dataDir, "pms.db");

const FORCE = process.argv.includes("--force");
const CHECK_ONLY = process.argv.includes("--check");

/** 演示账号口令（导入后会重置成这些） */
const DEMO_PASSWORDS = {
  admin: "admin123",
  front: "123456",
  cashier: "123456",
  housekeeper: "123456",
};

if (!existsSync(demoGz)) {
  console.error(`找不到演示数据包：${demoGz}`);
  console.error(`请确认 scripts/demo-data/pms-demo.db.gz 存在（或 git pull 拉取）`);
  process.exit(1);
}

/* ─────────── 1. 检查现有库是否已有真实数据 ─────────── */
let existing = { rooms: 0, bookings: 0, stays: 0 };
if (existsSync(target)) {
  try {
    const db = new DatabaseSync(target, { readOnly: true });
    const q = (t) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      } catch {
        return 0;
      }
    };
    existing = { rooms: q("rooms"), bookings: q("bookings"), stays: q("stays") };
    db.close();
  } catch {
    /* 损坏的库直接覆盖 */
  }
}

const hasRealData = existing.bookings > 0 || existing.stays > 0;

console.log(`演示数据包：${(statSync(demoGz).size / 1024).toFixed(0)} KB`);
console.log(`目标位置：${target}`);
if (existsSync(target)) {
  console.log(`现有库：${existing.rooms} 间房 / ${existing.bookings} 条预订 / ${existing.stays} 张入住单`);
}

if (hasRealData && !FORCE && !CHECK_ONLY) {
  console.error(`\n❌ 目标库已有业务数据（${existing.bookings} 条预订）。`);
  console.error(`   导入会覆盖掉它们。确认要覆盖请加 --force。`);
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log(`\n（--check 模式，未做任何修改）`);
  console.log(`  会做的事：`);
  console.log(`    1. 备份现有库 → ${target}.bak-demo-<时间戳>`);
  console.log(`    2. 解压演示包覆盖到 ${target}`);
  console.log(`    3. 重置 4 个账号密码为演示口令`);
  if (hasRealData) console.log(`    ⚠ 现有库有 ${existing.bookings} 条预订，会被覆盖（需 --force）`);
  process.exit(0);
}

/* ─────────── 2. 备份现有库 ─────────── */
mkdirSync(dataDir, { recursive: true });
if (existsSync(target)) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = `${target}.bak-demo-${ts}`;
  copyFileSync(target, backup);
  console.log(`\n✅ 已备份现有库 → ${backup}`);
  /* WAL/SHM 一起备份，避免恢复时不一致 */
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(target + ext)) copyFileSync(target + ext, backup + ext);
  }
}

/* ─────────── 3. 解压覆盖 ─────────── */
await new Promise((resolve, reject) => {
  const src = createReadStream(demoGz);
  const gunzip = createGunzip();
  const out = createWriteStream(target);
  src.pipe(gunzip).pipe(out);
  out.on("finish", resolve);
  out.on("error", reject);
  src.on("error", reject);
  gunzip.on("error", reject);
});
console.log(`✅ 已导入演示数据 → ${target}`);

/* 旧的 WAL/SHM 必须删掉，否则会跟新库文件不一致 */
for (const ext of ["-wal", "-shm"]) {
  const f = target + ext;
  if (existsSync(f)) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(f);
      console.log(`   已清理旧的 ${ext}`);
    } catch {
      /* 忽略 */
    }
  }
}

/* ─────────── 4. 重置演示账号密码 ─────────── */
const { hashPassword } = await import("../src/lib/password.ts").catch(() => ({ hashPassword: null }));

const db = new DatabaseSync(target);

/* 动态 import TS 可能失败（node 不认识 .ts 扩展名解析），退回用 scrypt 直接算 */
let hasher = hashPassword;
if (typeof hasher !== "function") {
  const { scryptSync, randomBytes } = await import("node:crypto");
  hasher = (plain) => {
    const N = 16384;
    const r = 8;
    const p = 1;
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(plain, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }).toString("hex");
    return `scrypt$${N}$${r}$${p}$${salt}$${hash}`;
  };
}

let reset = 0;
for (const [username, plain] of Object.entries(DEMO_PASSWORDS)) {
  try {
    db.prepare(`UPDATE users SET password_hash = ?, password = '' WHERE username = ?`).run(
      hasher(plain),
      username
    );
    reset++;
  } catch (e) {
    console.log(`   重置 ${username} 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ─────────── 5. 汇总 ─────────── */
const q = (t) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  } catch {
    return "-";
  }
};
const tables = db
  .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .get().c;

console.log(`\n演示数据概况：`);
console.log(`  表：${tables} 张`);
console.log(`  房间：${q("rooms")} 间　预订：${q("bookings")} 条　入住单：${q("stays")} 张`);
console.log(`  账单：${q("folios")} 张　流水：${q("payments")} 条　客人：${q("guests")} 个`);
console.log(`  用户：${q("users")} 个（已重置 ${reset} 个密码）`);

/* 汇总查完再关（原来 close 放在前面，导致上面全部显示 "-"） */
db.close();

console.log(`\n演示账号：`);
for (const [u, p] of Object.entries(DEMO_PASSWORDS)) {
  console.log(`  ${u.padEnd(12)} ${p}`);
}

console.log(`\n⚠ 这是演示数据。正式使用前请：`);
console.log(`   1. 清空演示数据（node scripts/init-db.mjs --reset）`);
console.log(`   2. 或直接删掉 data/pms.db 让系统重新初始化`);
console.log(`   3. 改掉这 4 个账号的密码`);
console.log(`\n✅ 导入完成。重启服务生效：sudo systemctl restart pms\n`);
