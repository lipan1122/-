#!/usr/bin/env node
/**
 * 正式环境配置体检（上线评审 P0：演示入口在正式环境会暴露）
 *
 * 背景：登录页原来用 `PMS_DEMO_LOGIN !== "0"` 判断，变量**缺省**就显示演示账号，
 * 也就是说「忘了配」=「默认开启」。现在代码侧已改成 fail-safe（见 src/lib/demo-mode.ts），
 * 但部署侧仍然会有人把 `PMS_DEMO_LOGIN=1` 连同 .env 一起拷到正式机，
 * 或者 SESSION_SECRET 根本没换 —— 这类问题代码里看不出来，只能在配置上查。
 *
 * 本脚本就是上线前的最后一道配置闸门：
 *
 *   严重（exit 2）：SESSION_SECRET 没配 / 还是占位符 / 太短 → 会话可伪造、渠道密钥可解密
 *   告警（exit 1）：演示登录开着、演示种子开着、库指向 demo、公网允许 HTTP
 *   干净（exit 0）：以上都没有
 *
 * 用法：
 *   node scripts/check-production-config.mjs              # 读 .env / .env.local + 进程环境变量
 *   node scripts/check-production-config.mjs --env-file=.env.production
 *   node scripts/check-production-config.mjs --json       # CI 用，输出 JSON
 *   node scripts/check-production-config.mjs --help
 *
 * 注意：
 *   · 不打印任何密钥明文，只报「是否存在 / 长度」；
 *   · 判定口径与 src/lib/demo-mode.ts 一致（1 / true / yes / on 才算开启）；
 *   · 变量优先级：.env < .env.local < 进程环境变量（与 Next.js 的加载顺序一致）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/* ── 退出码 ── */
const EXIT_OK = 0;
const EXIT_WARN = 1;
const EXIT_ERROR = 2;

/* 与 src/lib/demo-mode.ts 的 TRUTHY 保持一致：
   只有显式真值才算「开启」，拼错 / 空 / 0 一律按关闭处理 */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/* SESSION_SECRET 的底线：项目里 preflight.mjs 用 16，这里同样以 16 为「太短」的硬线，
   32 以上才是建议值（openssl rand -hex 32 产出 64 个字符） */
const SECRET_MIN = 16;
const SECRET_RECOMMENDED = 32;

/* 看着像占位符的取值：说明这一行是从 .env.example 原样拷过来的，等于没配 */
const PLACEHOLDER = /请替换|change[-_ ]?me|change-in-production|your[-_ ]?secret|example|demo|placeholder|xxx+/i;

const LEVEL = { ERROR: "error", WARN: "warn", OK: "ok" };
const MARK = { error: "✖", warn: "⚠", ok: "✔" };
const LABEL = { error: "严重", warn: "告警", ok: "通过" };

function parseArgs(argv) {
  const opts = { files: [], json: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--env-file=")) opts.files.push(arg.slice("--env-file=".length));
    else if (arg.startsWith("--file=")) opts.files.push(arg.slice("--file=".length));
    else if (arg === "--env-file" || arg === "--file") {
      /* 不做「下一个参数必须是路径」的猜测，直接提示清楚，避免悄悄读错文件 */
      throw new Error(`${arg} 需要写成 ${arg}=<路径>`);
    } else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

/** 极简 .env 解析：KEY=VALUE、忽略注释与空行、去掉成对引号、容忍 `export ` 前缀 */
function parseEnvFile(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      /* 未加引号时行内 `#` 视为注释（与 dotenv 一致：# 前需有空白） */
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out.set(key, value);
  }
  return out;
}

/**
 * 合并配置来源，返回 { env, sources }
 * 优先级：.env < .env.local < 进程环境变量
 */
function loadConfig(extraFiles) {
  const sources = [];
  const env = new Map();

  const defaultFiles = [".env", ".env.local"].map((f) => path.resolve(process.cwd(), f));
  const files = extraFiles.length > 0 ? extraFiles.map((f) => path.resolve(process.cwd(), f)) : defaultFiles;

  for (const file of files) {
    const parsed = parseEnvFile(file);
    sources.push({ file, exists: existsSync(file), keys: parsed.size });
    for (const [k, v] of parsed) env.set(k, v);
  }

  /* 进程环境变量最后覆盖：Next.js 不会覆盖已存在的 process.env，这里保持一致 */
  let fromProcess = 0;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (env.has(k)) fromProcess += 1;
    env.set(k, v);
  }
  sources.push({ file: "进程环境变量（已合并，同名优先）", exists: true, keys: fromProcess });

  return { env, sources };
}

function isTruthy(value) {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v.length > 0 && TRUTHY.has(v);
}

/** 脱敏描述：绝不回显密钥内容 */
function describeSecret(value) {
  if (value === undefined || value.trim() === "") return "未设置";
  const trimmed = value.trim();
  return `已设置（长度 ${trimmed.length}）`;
}

function checkSessionSecret(env, add) {
  const raw = env.get("SESSION_SECRET");
  const value = (raw ?? "").trim();
  if (value === "") {
    add(LEVEL.ERROR, "SESSION_SECRET", "未设置「会话签名密钥」：生产模式会拒绝登录，渠道密钥也没有派生来源");
    return;
  }
  if (PLACEHOLDER.test(value)) {
    add(
      LEVEL.ERROR,
      "SESSION_SECRET",
      `仍是占位符（长度 ${value.length}）：从 .env.example 拷来的值不能上生产，请用 openssl rand -hex 32 重新生成`
    );
    return;
  }
  if (value.length < SECRET_MIN) {
    add(LEVEL.ERROR, "SESSION_SECRET", `太短（长度 ${value.length}，至少 ${SECRET_MIN}）：容易离线穷举，请重新生成 32 字节随机值`);
    return;
  }
  if (value.length < SECRET_RECOMMENDED) {
    add(LEVEL.WARN, "SESSION_SECRET", `偏短（长度 ${value.length}，建议 ≥ ${SECRET_RECOMMENDED}）：openssl rand -hex 32 生成更稳`);
    return;
  }
  add(LEVEL.OK, "SESSION_SECRET", `已配置（长度 ${value.length}）`);
}

/** 演示配置项：只要显式开启就告警（这正是评审 P0 的场景） */
function checkDemoFlag(env, add, key, message) {
  const raw = env.get(key);
  const value = (raw ?? "").trim();
  if (value === "") {
    add(LEVEL.OK, key, "未设置（默认关闭，fail-safe）");
    return;
  }
  if (isTruthy(value)) {
    add(LEVEL.WARN, key, `${value} → ${message}`);
    return;
  }
  /* 0 / false / 拼错的值：代码侧已按「关闭」处理，这里只确认一下口径 */
  if (/^(0|false|no|off)$/i.test(value)) {
    add(LEVEL.OK, key, `${value}（显式关闭）`);
    return;
  }
  add(LEVEL.WARN, key, `取值「${value}」既不是开启值也不是关闭值：代码按「关闭」处理，但建议改成 0 或整行删除，避免下次误判`);
}

function checkDbPath(env, add) {
  const value = (env.get("PMS_DB_PATH") ?? "").trim();
  if (value === "") {
    add(LEVEL.OK, "PMS_DB_PATH", "未设置（默认 ./data/pms.db）");
    return;
  }
  if (/demo|sample|test/i.test(value)) {
    add(LEVEL.WARN, "PMS_DB_PATH", `${value} → 数据库路径带 demo/sample/test 字样，检查是不是指到了演示库`);
    return;
  }
  add(LEVEL.OK, "PMS_DB_PATH", value);
}

function checkAllowHttp(env, add) {
  const value = (env.get("PMS_ALLOW_HTTP") ?? "").trim();
  if (isTruthy(value)) {
    const baseUrl = (env.get("PMS_BASE_URL") ?? "").trim();
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl);
    if (local) add(LEVEL.OK, "PMS_ALLOW_HTTP", `${value}（PMS_BASE_URL 是内网/本地地址，演示环境可接受）`);
    else add(LEVEL.WARN, "PMS_ALLOW_HTTP", `${value} → 允许明文 HTTP，公网部署应删除这一行并配置 HTTPS`);
    return;
  }
  add(LEVEL.OK, "PMS_ALLOW_HTTP", value === "" ? "未设置（要求 HTTPS，符合公网部署）" : `${value}（已关闭）`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`参数错误：${e.message}`);
    return EXIT_ERROR;
  }

  if (opts.help) {
    printHelp();
    return EXIT_OK;
  }

  const { env, sources } = loadConfig(opts.files);
  const findings = [];
  const add = (level, key, detail) => findings.push({ level, key, detail });

  checkSessionSecret(env, add);
  checkDemoFlag(env, add, "PMS_DEMO_LOGIN", "正式环境不应开启演示登录（登录页会渲染「一键填入」4 个演示账号，含 admin）");
  checkDemoFlag(env, add, "PMS_DEMO_SEED", "正式环境不应开启演示数据种子（首次进 AR/商品/积分页会自动往库里灌虚构数据）");
  checkDbPath(env, add);
  checkAllowHttp(env, add);

  const errors = findings.filter((f) => f.level === LEVEL.ERROR);
  const warns = findings.filter((f) => f.level === LEVEL.WARN);
  const exitCode = errors.length > 0 ? EXIT_ERROR : warns.length > 0 ? EXIT_WARN : EXIT_OK;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: exitCode === EXIT_OK,
          exitCode,
          summary: { errors: errors.length, warnings: warns.length, passed: findings.length - errors.length - warns.length },
          sources: sources.map((s) => ({ file: s.file, exists: s.exists, keys: s.keys })),
          findings,
        },
        null,
        2
      )
    );
    return exitCode;
  }

  const line = "─".repeat(66);
  console.log("PMS 正式环境配置体检（演示入口不应出现在正式环境）");
  console.log(line);
  console.log("配置来源（后者覆盖前者同名变量）：");
  for (const s of sources) {
    const state = s.exists ? `已读取 ${s.keys} 项` : "不存在";
    console.log(`  · ${s.file}  ${state}`);
  }
  console.log(line);
  findings.forEach((f, i) => {
    console.log(`[${i + 1}/${findings.length}] ${MARK[f.level]} ${LABEL[f.level]}  ${f.key}`);
    console.log(`        ${f.detail}`);
  });
  console.log(line);

  if (exitCode === EXIT_OK) {
    console.log("结论：干净，可以上线（0 项严重 / 0 项告警）→ 退出码 0");
  } else if (exitCode === EXIT_WARN) {
    console.log(`结论：${errors.length} 项严重、${warns.length} 项告警 —— 告警项请逐条确认后再上线 → 退出码 1`);
    console.log("提示：演示相关开关的正确状态是「不设置」或「=0」；SESSION_SECRET 必配随机值。");
  } else {
    console.log(`结论：${errors.length} 项严重、${warns.length} 项告警 —— 严重项必须修掉才能上线 → 退出码 2`);
    console.log("提示：SESSION_SECRET 用 openssl rand -hex 32 生成后写进 .env（不要提交到版本库）。");
  }
  if (!sources[0]?.exists && opts.files.length === 0) {
    console.log("说明：本地开发没建 .env 属正常，此时 SESSION_SECRET 缺失是本脚本的预期结果；正式环境必须有 .env。");
  }
  return exitCode;
}

function printHelp() {
  console.log(`用法：node scripts/check-production-config.mjs [选项]

检查项：
  SESSION_SECRET     未设置 / 仍是占位符 / 长度 < ${SECRET_MIN} → 严重；< ${SECRET_RECOMMENDED} → 告警
  PMS_DEMO_LOGIN     显式开启 → 告警（正式环境不应开启演示登录）
  PMS_DEMO_SEED      显式开启 → 告警（正式环境不应开启演示数据种子）
  PMS_DB_PATH        路径含 demo / sample / test → 告警
  PMS_ALLOW_HTTP     开启且 PMS_BASE_URL 不是内网地址 → 告警（公网明文 HTTP）

退出码：0 干净 / 1 有告警 / 2 有严重问题

选项：
  --env-file=<路径>   只读指定的 env 文件（默认读 .env + .env.local）
  --file=<路径>       同 --env-file
  --json              输出 JSON（CI 用）
  --help, -h          显示本帮助`);
}

process.exitCode = main();
