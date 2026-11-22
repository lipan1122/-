/**
 * 上线前验收：逐条执行清单要求的 17 条命令并出报告
 *
 * 用法：
 *   node scripts/verify-release.mjs              # 全部跑
 *   node scripts/verify-release.mjs --skip-build # 跳过 next build（本地快验）
 *   node scripts/verify-release.mjs --only test:room,test:money
 *
 * 输出：
 *   每个命令的 退出码 / 通过数 / 失败数 / 耗时 / 数据库路径
 *   末尾一张汇总表 + 退出码（有失败则 1）
 *
 * ── 为什么需要它 ──
 * codex 上线前补充要求第四节要「报告每条命令的退出码、通过数、失败数和数据库路径」。
 * 手动一条条跑容易漏、也容易把「没输出」误当成「通过」。
 * 这个脚本**只认退出码**，同时从输出里尽力解析通过/失败数（解析不到就显示 -，
 * 不伪造数字）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/*
 * 清单点名要求的 17 条（顺序照抄清单，便于对照）
 *
 * 每条带一个 parser 标记：
 *   「通过 N / 失败 N」这种格式的项目里最常见，也有「通过 N 项，失败 N 项」
 *   audit 类脚本格式不同，用单独的正则。
 */
const COMMANDS = [
  { key: "typecheck", script: "typecheck", kind: "tsc" },
  { key: "lint", script: "lint", kind: "lint" },
  { key: "build", script: "build", kind: "build", slow: true },
  { key: "test:permissions", script: "test:permissions", kind: "passfail" },
  { key: "test:status", script: "test:status", kind: "passfail" },
  { key: "test:checkout", script: "test:checkout", kind: "passfail" },
  { key: "test:channel", script: "test:channel", kind: "passfail" },
  { key: "test:tenant", script: "test:tenant", kind: "passfail" },
  { key: "test:availability", script: "test:availability", kind: "passfail" },
  { key: "test:booking-validation", script: "test:booking-validation", kind: "passfail" },
  { key: "test:checkin-rules", script: "test:checkin-rules", kind: "passfail" },
  { key: "test:nightaudit", script: "test:nightaudit", kind: "passfail" },
  { key: "test:invoices", script: "test:invoices", kind: "passfail" },
  { key: "test:money", script: "test:money", kind: "passfail" },
  { key: "test:room", script: "test:room", kind: "passfail" },
  { key: "audit:gap", script: "audit:gap", kind: "audit" },
  { key: "audit:all", script: "audit:all", kind: "auditall" },
];

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes("--skip-build");
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1])?.split(",").map((s) => s.trim())
  : null;

const dbPath = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const dbSize = existsSync(dbPath) ? (statSync(dbPath).size / 1024 / 1024).toFixed(1) + " MB" : "（不存在）";

/**
 * 从输出里解析「通过 N / 失败 N」
 *
 * 项目里格式不统一，实测见过：
 *   通过 81 / 失败 0
 *   通过 37 项，失败 0 项
 *   结果：全部通过 ✅（0 个 ❌）
 *   共 41 页，失败 0 个
 *   报表 68 张：通过 68（其中未实现占位 11），失败 0
 * 解析不到就返回 null —— **不猜、不伪造**。
 */
function parsePassFail(out) {
  const text = out.replace(/\r/g, "");

  /* 「通过：262    失败：0」（test-action-permissions 用中文冒号） */
  let m = text.match(/通过[:：]\s*(\d+)\s+失败[:：]\s*(\d+)/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };

  /* 「通过 N / 失败 M」或「通过 N 项，失败 M 项」 */
  m = text.match(/通过\s*(\d+)\s*(?:项)?\s*[/，,]\s*失败\s*(\d+)/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };

  /* 「共 N 页，失败 M 个」/「共 N 页，失败 M」 */
  m = text.match(/共\s*(\d+)\s*(?:页|张|项)[^\n]*?失败\s*(\d+)/);
  if (m) return { pass: Number(m[1]) - Number(m[2]), fail: Number(m[2]) };

  /* 「报表 N 张：通过 N…失败 M」 */
  m = text.match(/通过\s*(\d+)[^\n]*?失败\s*(\d+)/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };

  /* 「全部通过 ✅（0 个 ❌）」：只有失败数，通过数无从得知 */
  m = text.match(/全部通过[^\n]*?(\d+)\s*个\s*❌/);
  if (m) return { pass: null, fail: Number(m[1]) };

  /* 「合计 27 项：已做 26 / 部分 1 / 缺 0」（audit-gap 的格式）
     「部分」不算失败但也不是完全做完，这里按「已做」作通过数、「缺」作失败数，
     并在 note 里标出「部分」的数量，避免把「部分」当完成。 */
  m = text.match(/合计\s*(\d+)\s*项：已做\s*(\d+)\s*\/\s*部分\s*(\d+)\s*\/\s*缺\s*(\d+)/);
  if (m) {
    return {
      pass: Number(m[2]),
      fail: Number(m[4]),
      note: `共 ${m[1]} 项，其中「部分」${m[3]} 项`,
    };
  }

  return null;
}

/** tsc / lint / build：退出码即结论，顺便抓错误数 */
function parseTsc(out) {
  const errors = (out.match(/error TS\d+/g) ?? []).length;
  return { pass: errors === 0 ? 1 : 0, fail: errors, note: `${errors} 个 TS 错误` };
}
function parseLint(out) {
  const problems = out.match(/(\d+)\s+problems?/);
  const errors = (out.match(/\berror\b/g) ?? []).length;
  return { pass: errors === 0 ? 1 : 0, fail: errors, note: problems ? problems[0] : `${errors} 个 error` };
}

const results = [];

function runOne(cfg) {
  const label = cfg.key;
  process.stdout.write(`\n${"=".repeat(64)}\n▶ ${label}\n${"=".repeat(64)}\n`);

  const started = Date.now();
  const r = spawnSync("npm", ["run", "--silent", cfg.script], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: cfg.slow ? 600_000 : 300_000,
    env: { ...process.env },
  });
  const ms = Date.now() - started;

  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const code = r.status ?? -1;

  /* 打印尾部（完整输出太长，验收报告只需要关键部分） */
  const tail = out.split("\n").filter((l) => l.trim()).slice(-18).join("\n");
  console.log(tail);

  let pf = null;
  if (cfg.kind === "tsc") pf = parseTsc(out);
  else if (cfg.kind === "lint") pf = parseLint(out);
  else if (cfg.kind === "build") pf = { pass: code === 0 ? 1 : 0, fail: code === 0 ? 0 : 1, note: "构建产物" };
  else pf = parsePassFail(out);

  const rec = {
    key: label,
    code,
    pass: pf?.pass ?? null,
    fail: pf?.fail ?? null,
    note: pf?.note ?? "",
    ms,
    ok: code === 0,
  };
  results.push(rec);

  const icon = rec.ok ? "✅" : "❌";
  console.log(
    `\n${icon} ${label}  退出码 ${code}  ` +
      (rec.pass !== null ? `通过 ${rec.pass} / 失败 ${rec.fail}  ` : "") +
      `耗时 ${(ms / 1000).toFixed(1)}s`
  );
}

console.log(`数据库：${dbPath}（${dbSize}）`);
console.log(`项目：${root}`);

const list = COMMANDS.filter((c) => {
  if (only && !only.includes(c.key)) return false;
  if (SKIP_BUILD && c.key === "build") return false;
  return true;
});

for (const cfg of list) runOne(cfg);

/* ─────────── 汇总 ─────────── */
console.log(`\n\n${"=".repeat(64)}\n验收汇总\n${"=".repeat(64)}\n`);
console.log(
  "命令".padEnd(26) + "退出码".padEnd(10) + "通过".padEnd(10) + "失败".padEnd(10) + "耗时".padEnd(10)
);
console.log("-".repeat(66));
for (const r of results) {
  console.log(
    r.key.padEnd(26) +
      String(r.code).padEnd(10) +
      String(r.pass ?? "-").padEnd(10) +
      String(r.fail ?? "-").padEnd(10) +
      `${(r.ms / 1000).toFixed(1)}s`
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n数据库：${dbPath}（${dbSize}）`);
console.log(`执行 ${results.length} 条：通过 ${results.length - failed.length} / 失败 ${failed.length}`);

if (failed.length > 0) {
  console.log(`\n失败命令：`);
  failed.forEach((f) => console.log(`  ❌ ${f.key}（退出码 ${f.code}）`));
  console.log(`\n⚠️ 有失败项，不能标记为可上线。\n`);
  process.exit(1);
}

console.log(`\n✅ 全部通过\n`);
