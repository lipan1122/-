/**
 * 生产发布包（整改报告 11 节）
 *
 * 打一个**不含数据库、不含密钥、不含构建产物**的源码发布包，
 * 附带部署说明与环境变量模板，方便交付到门店服务器。
 *
 * 用法：
 *   node scripts/build-release.mjs                 # 输出到 dist/
 *   node scripts/build-release.mjs --out D:/out    # 指定输出目录
 *
 * 打包后会做一次敏感内容扫描，发现数据库文件或疑似密钥直接失败。
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_DIR = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(ROOT, "dist");
const STAMP = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const PKG_NAME = `pms-release-${STAMP}`;
const STAGE = path.join(OUT_DIR, PKG_NAME);

/* 打进包里的内容（白名单，避免误带 node_modules / 数据库 / 构建产物） */
const INCLUDE = [
  "src",
  "scripts",
  "docs",
  "miniprogram",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "postcss.config.mjs",
  "tsconfig.json",
  "eslint.config.mjs",
  "README.md",
  "DEPLOY-SERVER.md",
  ".env.example",
  "DEPLOY.md",
  ".gitignore",
  "Dockerfile",
  ".dockerignore",
  "启动服务.bat",
  ".npmrc",
];

/* 显式排除（即使白名单里也应剔除） */
const EXCLUDE_PATTERN = [/\.db$/, /\.db-wal$/, /\.db-shm$/, /\.env(?!\.example)/, /\.log$/, /secret/i, /\.pem$/, /\.key$/];

function shouldExclude(rel) {
  return EXCLUDE_PATTERN.some((re) => re.test(rel));
}

function copyDir(from, to, base = "") {
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const rel = path.join(base, name);
    if (shouldExclude(rel)) {
      console.log(`  跳过（排除规则）：${rel}`);
      continue;
    }
    const st = statSync(src);
    const dest = path.join(to, name);
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyDir(src, dest, rel);
    } else {
      cpSync(src, dest);
    }
  }
}

/* ---------- 1. 准备暂存目录 ---------- */
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
console.log(`打包目录：${STAGE}\n`);

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!existsSync(src)) {
    console.log(`  跳过（不存在）：${item}`);
    continue;
  }
  const st = statSync(src);
  const dest = path.join(STAGE, item);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    copyDir(src, dest, item);
  } else {
    if (shouldExclude(item)) {
      console.log(`  跳过（排除规则）：${item}`);
      continue;
    }
    cpSync(src, dest);
  }
}

/* ---------- 2. 附带环境变量模板 ---------- */
writeFileSync(
  path.join(STAGE, ".env.example"),
  `# PMS 环境变量模板（复制为 .env 后按门店实际情况修改，不要提交到版本库）

# 数据库文件位置（默认 <项目>/data/pms.db）
PMS_DB_PATH=./data/pms.db

# 酒店 ID（多店部署时区分，默认 1）
PMS_HOTEL_ID=1

# 营业日切换时间（HH:MM，凌晨几点算新的一天；酒店业常用 05:00）
PMS_BIZ_DATE_CUTOFF=05:00

# 允许 HTTP（本地/内网无 HTTPS 时设为 1；公网必须去掉并启用 HTTPS）
PMS_ALLOW_HTTP=1

# 站点基址（用于登录跳转等绝对地址）
PMS_BASE_URL=http://localhost:3100

# 渠道直连密钥（每家门店各自填写，切勿写进代码）
# CTIP_APP_KEY=
# CTIP_APP_SECRET=
# MEITUAN_APP_KEY=
# MEITUAN_APP_SECRET=
`,
  "utf8"
);

/* ---------- 3. 附带部署说明 ---------- */
writeFileSync(
  path.join(STAGE, "DEPLOY.md"),
  `# PMS 部署说明

## 1. 环境要求

- Node.js >= 22.5（用到内置 \`node:sqlite\`）
- 建议 Linux + 4GB 内存；Windows Server 同样可用
- 端口 3100（可在 \`npm run start\` 里改）

## 2. 首次安装

\`\`\`bash
# 解压发布包
tar -xzf ${PKG_NAME}.tar.gz
cd ${PKG_NAME}

# 安装依赖（生产环境不装 devDependencies）
npm ci --omit=dev

# 配置环境变量
cp .env.example .env
vi .env            # 至少确认 PMS_DB_PATH 与 PMS_BASE_URL

# 初始化空库（只建表 + 基础字典，不含演示数据）
npm run db:init

# 执行数据库迁移（幂等，可重复跑）
npm run db:migrate

# 构建并启动
npm run build
npm run start
\`\`\`

启动后访问 \`http://<服务器IP>:3100\`，默认管理员账号见初始化脚本输出。
**首次登录后请立即修改默认密码**（设置 → 员工管理）。

## 3. 演示环境（可选）

需要带演示数据的库时：

\`\`\`bash
cp data/pms.db data/pms-demo.db
PMS_DB_PATH=./data/pms-demo.db npm run start
\`\`\`

## 4. 升级

\`\`\`bash
# 1. 备份数据库（务必先做）
cp data/pms.db data/backup-$(date +%Y%m%d%H%M).db

# 2. 停服务
pm2 stop pms    # 或 kill 掉 next start 进程

# 3. 解压新版本，覆盖代码（保留 data/ 目录）
tar -xzf pms-release-新版本.tar.gz --strip-components=1

# 4. 装依赖 + 迁移 + 重建
npm ci --omit=dev
npm run db:migrate
npm run build

# 5. 启动
npm run start
\`\`\`

迁移脚本是幂等的：跑重复了不会有副作用；已应用的项目会自动跳过。

## 5. 回滚

\`\`\`bash
# 代码回滚：解压上一个版本的包
# 数据回滚：用升级前的备份覆盖
cp data/backup-202611171300.db data/pms.db
rm -f data/pms.db-wal data/pms.db-shm
npm run start
\`\`\`

## 6. 备份建议

- **每日夜审后**备份一次：\`cp data/pms.db data/backup-$(date +%Y%m%d).db\`
- 保留最近 30 天
- 数据库是单文件，直接复制即可（WAL 模式下建议先停服务或执行 \`PRAGMA wal_checkpoint\`）

## 7. 健康检查

\`\`\`bash
npm run health                    # 数据一致性 + 业务积压
npm run db:migrate:check          # 检查是否还有未应用的迁移
npm run lint                      # ESLint
npm run typecheck                 # TypeScript
\`\`\`

## 8. 安全清单（上线前逐条确认）

- [ ] 已修改所有默认账号密码
- [ ] \`PMS_ALLOW_HTTP\` 在公网部署时已去掉，并配置 HTTPS
- [ ] 渠道密钥只写在 \`.env\`，没有进代码或前端
- [ ] \`data/\` 目录不在 Web 可访问路径下
- [ ] 已配置每日备份
- [ ] 防火墙只开放 3100（或反代端口）
`,
  "utf8"
);

/* ---------- 3.5 用项目根目录维护的部署文档覆盖内置模板 ----------
 * 内置模板是最早版本的兜底；根目录的 .env.example / DEPLOY.md 是随代码一起
 * 维护的权威版本（含 SESSION_SECRET、reset:passwords、Docker 等加固内容）。
 * 存在时以根目录为准，避免「改了代码没改打包模板」导致发布包文档过期。
 */
for (const f of [".env.example", "DEPLOY.md"]) {
  const maintained = path.join(ROOT, f);
  if (existsSync(maintained)) {
    /* 用 writeFileSync 覆盖而不是 cpSync：Windows 上 cpSync 覆盖已存在文件会报
       errno 0 / unlink 失败（内置模板刚生成过同名文件）。 */
    writeFileSync(path.join(STAGE, f), readFileSync(maintained, "utf8"), "utf8");
  }
}

/* ---------- 4. 敏感内容扫描 ---------- */
console.log("\n敏感内容扫描：");
const problems = [];
function scan(dir, base = "") {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.join(base, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      scan(p, rel);
      continue;
    }
    if (/\.db($|-wal$|-shm$)/.test(name)) problems.push(`数据库文件：${rel}`);
    const size = st.size;
    if (size < 2 * 1024 * 1024 && /\.(tsx?|mjs|json|md)$/.test(name)) {
      const text = readFileSync(p, "utf8");
      if (/app_secret\s*[:=]\s*["'][A-Za-z0-9]{16,}/i.test(text)) problems.push(`疑似硬编码密钥：${rel}`);
    }
  }
}
scan(STAGE);

if (problems.length > 0) {
  console.log("  ❌ 发现敏感内容：");
  for (const p of problems) console.log("     " + p);
  console.log("\n打包中止。请清理后重试。");
  process.exit(1);
}
console.log("  ✅ 未发现数据库文件或硬编码密钥");

/* ---------- 5. 打 tar.gz ---------- */
const tarball = path.join(OUT_DIR, `${PKG_NAME}.tar.gz`);

/**
 * 选可用的 tar：
 *   1. Windows 自带 C:\Windows\System32\tar.exe（bsdtar，最稳）
 *   2. PATH 里的 tar
 * 某些环境里的 MSYS2 tar 会因为权限问题崩掉，所以优先用系统自带的。
 */
function pickTar() {
  const candidates = [
    "C:\\Windows\\System32\\tar.exe",
    "/c/Windows/System32/tar.exe",
    "tar",
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const tarBin = pickTar();
if (!tarBin) {
  console.log("\n未找到可用的 tar，保留暂存目录供手工打包：" + STAGE);
  process.exit(1);
}

try {
  execFileSync(tarBin, ["-czf", tarball, "-C", OUT_DIR, PKG_NAME], { stdio: "inherit" });
} catch (e) {
  console.log(`\ntar 打包失败（${tarBin}）：${e.message}`);
  console.log("保留暂存目录供手工打包：" + STAGE);
  process.exit(1);
}

const sizeKb = Math.round(statSync(tarball).size / 1024);
console.log(`\n发布包：${tarball}`);
console.log(`大小：${sizeKb} KB`);
console.log("\n包含内容：");
for (const item of INCLUDE) {
  if (existsSync(path.join(STAGE, item))) console.log("  " + item);
}
console.log("  .env.example");
console.log("  DEPLOY.md");
