/**
 * 上线加固：把仍在使用初始弱口令的演示账号换成随机密码。
 *
 * 用法：npm run reset:passwords
 * 只重置「当前口令仍是初始弱口令」的账号，你自己改过的密码不会被覆盖。
 * 新密码只打印这一次，请立即保存。
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_FILE = process.env.PMS_DB_PATH || path.join(process.cwd(), "data", "pms.db");
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const WEAK = ["admin123", "123456", "password", "12345678", "admin", "123456789"];
const ACCOUNTS = ["admin", "front", "cashier", "housekeeper"];

function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** 与 src/lib/password.ts 保持同一套格式，供独立脚本校验老口令 */
function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, sN, sR, sP, saltB64, hashB64] = parts;
  const n = Number(sN);
  const r = Number(sR);
  const p = Number(sP);
  if (!n || !r || !p) return false;
  try {
    const salt = Buffer.from(saltB64, "base64url");
    const expect = Buffer.from(hashB64, "base64url");
    const actual = scryptSync(plain, salt, expect.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
    return actual.length === expect.length && timingSafeEqual(actual, expect);
  } catch {
    return false;
  }
}

if (!fs.existsSync(DB_FILE)) {
  console.error(`找不到数据库：${DB_FILE}\n请先执行 npm run db:init，或用 PMS_DB_PATH 指定路径。`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA busy_timeout = 10000");

const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!cols.includes("password_hash")) {
  console.error("users 表还没有 password_hash 列，请先执行 npm run db:migrate");
  db.close();
  process.exit(1);
}

const placeholders = ACCOUNTS.map(() => "?").join(",");
const rows = db
  .prepare(`SELECT id, username, password_hash FROM users WHERE username IN (${placeholders})`)
  .all(...ACCOUNTS);

const reset = [];
for (const row of rows) {
  const stillWeak = WEAK.some((w) => verifyPassword(w, row.password_hash));
  if (!stillWeak) continue;
  const newPass = randomBytes(9).toString("hex");
  db.prepare(`UPDATE users SET password_hash = ?, password = '' WHERE id = ?`).run(
    hashPassword(newPass),
    row.id
  );
  reset.push([row.username, newPass]);
}

db.close();

if (reset.length === 0) {
  console.log("没有账号仍在使用初始弱口令，无需重置。");
} else {
  console.log("\n已生成新密码（只显示这一次，请立即保存）：\n");
  for (const [u, p] of reset) console.log(`  ${u.padEnd(14)} ${p}`);
  console.log("\n登录后可在「系统设置 → 用户管理」再自行修改。");
  console.log("生产模式会拒绝初始口令，这一步必须在公网开放前完成。\n");
}
