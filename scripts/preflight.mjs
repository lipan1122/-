/**
 * 上线前安全自检。用法：npm run preflight
 *
 * 生产意图（未设 PMS_ALLOW_HTTP=1）下发现阻断项会 exit 1。
 * 本地演示模式会把「初始口令」降级为警告，不打断开发。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scryptSync, timingSafeEqual } from "node:crypto";

const ROOT = process.cwd();
const results = [];
const ok = (m) => results.push(["ok", m]);
const warn = (m) => results.push(["warn", m]);
const bad = (m) => results.push(["bad", m]);

/* 独立 node 脚本不会自动加载 .env，这里手工解析（不覆盖已有环境变量） */
const env = { ...process.env };
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
/* 是否演示模式只看 PMS_ALLOW_HTTP：本地/内网显式设 1 才宽松。
 * 独立 node 脚本的 NODE_ENV 通常未设，不能用它判断，否则生产机上也会误判成演示。 */
const DEMO = env.PMS_ALLOW_HTTP === "1";

/* 1. 会话签名密钥 */
const secret = env.SESSION_SECRET || "";
if (!secret || /请替换|change-in-production|example|demo/i.test(secret) || secret.length < 16) {
  (DEMO ? warn : bad)("SESSION_SECRET 未配置有效随机值（生产模式会拒绝登录）");
} else {
  ok("SESSION_SECRET 已配置");
}

/* 2. 交付文件齐备 */
for (const f of ["Dockerfile", ".dockerignore", "DEPLOY.md", ".env.example"]) {
  if (fs.existsSync(path.join(ROOT, f))) ok(`存在 ${f}`);
  else bad(`缺少 ${f}（发布包会不完整）`);
}

/* 3. 版本控制不会误提交数据与密钥 */
const giPath = path.join(ROOT, ".gitignore");
const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
for (const p of ["node_modules", "data/*.db", ".env"]) {
  if (gi.includes(p)) ok(`.gitignore 覆盖 ${p}`);
  else bad(`.gitignore 未覆盖 ${p}`);
}

/* 4. 源码不再含固定密钥常量 */
const sessionPath = path.join(ROOT, "src", "lib", "session.ts");
const sessionSrc = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, "utf8") : "";
/* 只认真实的代码写法，不认注释里提到的历史字符串（避免误报） */
const hasHardcodedSecret =
  /process\.env\.SESSION_SECRET\s*\|\|\s*["']/.test(sessionSrc) ||
  /\bconst\s+SECRET\s*=\s*["']/.test(sessionSrc);
if (hasHardcodedSecret) bad("session.ts 仍把固定密钥写死在代码里");
else ok("session.ts 无固定密钥常量");

/* 5. 数据库结构 */
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

const dbFile = env.PMS_DB_PATH || path.join(ROOT, "data", "pms.db");
if (!fs.existsSync(dbFile)) {
  warn(`未找到数据库 ${dbFile}（新部署请先执行 npm run db:init）`);
} else {
  const db = new DatabaseSync(dbFile);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  if (tables.includes("login_attempts")) ok("login_attempts 表已建（登录限流可用）");
  else bad("缺少 login_attempts 表，请执行 npm run db:migrate");

  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("password_hash")) {
    bad("users 表缺 password_hash 列，请执行 npm run db:migrate");
  } else {
    const weak = ["admin123", "123456"];
    const left = [];
    for (const row of db.prepare("SELECT username, password_hash FROM users").all()) {
      if (weak.some((w) => verifyPassword(w, row.password_hash))) left.push(row.username);
    }
    if (left.length === 0) ok("初始演示口令已全部更换");
    else {
      (DEMO ? warn : bad)(
        `仍用初始口令的账号：${left.join(", ")}（上线前执行 npm run reset:passwords）`
      );
    }
  }
  db.close();
}

/* 6. 模式提示 */
if (DEMO) warn("当前按本地/演示模式检查：公网部署请删除 PMS_ALLOW_HTTP 后重跑本自检");
else ok("生产模式：登录锁定 / 初始口令拦截 / SECRET 校验均已启用");

console.log("\n上线自检：");
for (const [lv, m] of results) {
  console.log(`  ${lv === "ok" ? "✅" : lv === "warn" ? "⚠️ " : "❌"} ${m}`);
}
const nOk = results.filter((r) => r[0] === "ok").length;
const nWarn = results.filter((r) => r[0] === "warn").length;
const nBad = results.filter((r) => r[0] === "bad").length;
console.log(`\n结果：通过 ${nOk} / 警告 ${nWarn} / 阻断 ${nBad}`);
if (nBad > 0) {
  console.log("存在阻断项，请勿上线。\n");
  process.exit(1);
}
console.log("可以进入构建与发布环节。\n");
