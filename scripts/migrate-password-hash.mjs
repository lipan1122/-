/**
 * 密码哈希迁移（整改报告 P0-2.2）
 *
 * 把 users.password 里的明文密码转换成 scrypt 哈希，已经是哈希的跳过。
 *
 * 用法：
 *   node scripts/migrate-password-hash.mjs            # dry-run
 *   node scripts/migrate-password-hash.mjs --apply    # 真正写入
 *   PMS_DB_PATH=/path/pms.db node scripts/migrate-password-hash.mjs --apply
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";

const DB_PATH = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const APPLY = process.argv.includes("--apply");

const N = 16384, R = 8, P = 1, KEYLEN = 64;
function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
const isHashed = (s) => typeof s === "string" && s.startsWith("scrypt$");

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(`SELECT id, username, password FROM users`).all();

const plain = rows.filter((r) => r.password && !isHashed(r.password));
const hashed = rows.filter((r) => isHashed(r.password));

console.log(`数据库：${DB_PATH}`);
console.log(`用户 ${rows.length} 个：已哈希 ${hashed.length}，明文 ${plain.length}\n`);
for (const r of plain) console.log(`  ${r.username}（id=${r.id}）明文待迁移`);

if (!APPLY) {
  console.log("\ndry-run，未写入。加 --apply 执行迁移。");
  process.exit(0);
}

db.exec("BEGIN");
try {
  for (const r of plain) {
    db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hashPassword(r.password), r.id);
  }
  db.exec("COMMIT");
  console.log(`\n已迁移 ${plain.length} 个账号为 scrypt 哈希`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("迁移失败已回滚:", e.message);
  process.exit(1);
}

const after = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE password LIKE 'scrypt$%'`).get().c;
console.log(`校验：现在 ${after} / ${rows.length} 个账号使用哈希`);
