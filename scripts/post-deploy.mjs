/**
 * 部署后一键收尾（幂等、可重复执行、失败不中断）
 *
 * ── 为什么需要它 ──
 *
 * 这个项目前十几轮部署全是手工敲命令，顺序是口口相传的：
 *
 *   迁移 → 押金修复 → 房态复位 → 日期滚动 → 超卖修复 → 客史回填 → 体检
 *
 * 手工做的问题不是麻烦，是**会漏**：
 *   · 漏了 migrate-all → 页面 500（no such table / no such column）
 *   · 漏了押金修复   → 退房单还挂着押金，在住押金虚高 6800 元
 *   · 漏了日期滚动   → 演示库隔一周再看，21 张在住单全部「逾期 7~11 天」
 *   · 漏了超卖修复   → /rooms/predict 显示出租率 102%
 *   · 漏了客史回填   → 在住单没有 guest_id，会员/积分/历史入住全对不上
 *   · 漏了 chown     → attempt to write a readonly database（第九轮真踩过）
 *
 * 所以把这一串收进一个脚本：**一条命令、固定顺序、每步都有结论**。
 *
 * ── 三条设计原则 ──
 *
 * 1. **幂等**：每一步都由被调用脚本自身保证可重复执行（改过的行不会再改、
 *    基准日期记在 op_logs 里而不是从当前值累加）。所以这个脚本可以随意重跑，
 *    第二次跑应该全部「0 变更」——这也是验证部署是否真的完成的办法。
 *
 * 2. **失败不中断**：某一步失败（比如超卖修复遇到人工核对项）不应该让后面的
 *    客史回填和体检都不跑。每步独立 try，最后汇总，由人决定要不要重跑。
 *
 * 3. **体检放最后**：前 6 步是「修」，最后 2 步是「验」。修完必须有人签字，
 *    否则「脚本都跑完了」和「系统真的健康」是两件事。
 *
 * ── 退出码 ──
 *   0 = 全部步骤成功（允许「0 变更」「有残留但已报告」）
 *   1 = 有步骤真正失败（脚本崩溃 / 找不到 / 超时）
 *   2 = 有步骤失败，或者体检发现严重问题
 *
 * 用法：
 *   node scripts/post-deploy.mjs                 # 跑全部（默认 apply）
 *   node scripts/post-deploy.mjs --dry-run       # 只看会跑什么，不动库
 *   node scripts/post-deploy.mjs --skip roll-dates,oversell
 *   node scripts/post-deploy.mjs --only deposit,preflight
 *   node scripts/post-deploy.mjs --json          # 机器可读（CI/cron 用）
 *
 * 环境变量：
 *   PMS_DB_PATH   目标库（默认 cwd/data/pms.db），透传给每个子脚本
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/* ════════════════════════════════════════════════════════════ 参数 */

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const listOpt = (n) => {
  const i = argv.indexOf(n);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
};

const DRY_RUN = has("--dry-run");
const JSON_OUT = has("--json");
const SKIP = new Set(listOpt("--skip") ?? []);
const ONLY = listOpt("--only");
const STEP_TIMEOUT_MS = Number(process.env.PMS_POST_DEPLOY_TIMEOUT_MS ?? 300000);

const CWD = process.cwd();
const SCRIPTS_DIR = path.join(CWD, "scripts");
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(CWD, "data", "pms.db");

/* ════════════════════════════════════════════════════════════ 步骤定义 */

/**
 * 顺序是有意为之，改之前先看这条注释：
 *
 *   migrate-all      先补表补列 —— 后面每个脚本都假设表结构是最新的。
 *   sync-schema      再按 fingerprint 补齐「散落在页面里才建」的表/列。
 *   rebuild-unique   单号约束（多店必需），它自己也幂等，已经是目标状态就跳过。
 *   ───────────── 以上是「结构」，以下是「数据」 ─────────────
 *   fix-deposit      押金是担保不是收入，退房必须清零 —— 先修，因为后面的
 *                    账单重算（日期滚动会平移账单日）依赖余额已经正确。
 *   fix-room-status  房态由在住单推导，必须在「有在住单」的状态下修，所以排在
 *                    押金之后、日期滚动之前（滚动会改离店日，可能影响逾期判定）。
 *   roll-demo-dates  演示数据锚在「今天」，逾期归零。它平移 stays/folios/items/
 *                    payments 的所有日期，必须排在其它数据修复之后。
 *   fix-oversell     按「日期×房型」逐日查占用，滚完日期后的分布才是真实的。
 *   backfill-guest   客史最后回填：它要读 stays 的入住日期等（已被滚动过），
 *                    且在住单的姓名/手机要已是最终值。
 *   ───────────── 以下是「验」 ─────────────
 *   preflight-db     38 项数据一致性（外键悬空/状态矛盾/金额对不上）
 *   health-check     业务体检（房态/账务/积压），只读不落库
 */

/** 子脚本里「值得单独拎出来看」的行（其它输出折叠掉，避免刷屏） */
const KEY_LINE_RE =
  /(改动|变更|更新|修复|回填|新建|插入|跳过|无需|没有需要|已修|条$|共 |检查项|严重|警告|余额|押金|超卖|逾期|不一致|✅|⚠|❌)/;

const STEPS = [
  {
    id: "migrate",
    title: "数据库迁移",
    script: "migrate-all.mjs",
    args: [],
    why: "补表/补列/补索引；缺了它页面直接 500",
  },
  {
    id: "sync-schema",
    title: "补齐表结构",
    script: "sync-schema.mjs",
    args: [],
    why: "60 张表散落在页面里建，全新库靠它补齐",
  },
  {
    id: "unique",
    title: "单号唯一约束",
    script: "rebuild-unique-constraints.mjs",
    args: [],
    why: "去全局 UNIQUE（多店部署必需）；已是目标状态则跳过",
  },
  {
    id: "deposit",
    title: "押金残留修复",
    script: "fix-deposit-residual.mjs",
    args: ["--apply"],
    why: "退房不冲销押金 → 在住押金虚高（真库曾残留 6800 元）",
  },
  {
    id: "room-status",
    title: "房态复位",
    script: "fix-room-status.mjs",
    args: ["--apply"],
    why: "房态与在住单对不上（VC 有人住 / OC 没人住）",
  },
  {
    id: "roll-dates",
    title: "演示日期滚动",
    script: "roll-demo-dates.mjs",
    args: ["--apply"],
    why: "演示数据锚在导出日 → 隔几天全部逾期；基准记在 op_logs，重跑 0 变更",
  },
  {
    id: "oversell",
    title: "超卖修复",
    script: "fix-oversell-bookings.mjs",
    args: ["--apply"],
    why: "房型级预订数 > 物理房量（曾出租率 102%）",
  },
  {
    id: "guest-id",
    title: "客史回填",
    script: "backfill-guest-id-last8.mjs",
    args: ["--apply"],
    why: "在住单 guest_id 为空 → 会员/积分/历史入住关联不上",
  },
  {
    id: "preflight",
    title: "数据一致性体检（38 项）",
    script: "preflight-db.mjs",
    args: [],
    why: "外键悬空 / 状态矛盾 / 金额对不上 / 重复记录",
    check: true,
  },
  {
    id: "health",
    title: "业务体检",
    script: "health-check.mjs",
    args: ["--no-persist"],
    why: "房态一致性 / 账务 / 积压（只读，不写 room_anomalies）",
    check: true,
  },
];

/* ════════════════════════════════════════════════════════════ 工具 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = c("32");
const red = c("31");
const yellow = c("33");
const dim = c("2");
const bold = c("1");

/**
 * 跑一个脚本。
 *
 * 用 spawnSync 而不是 execSync：
 *   · 需要拿到「退出码 + stdout + stderr + 耗时」四件套；
 *   · execSync 会把 stderr 混进异常消息里，既拿不到干净输出也分不清是哪一步失败。
 * 用 `node` 显式调用而不是 `npm run xxx`：
 *   npm 会额外套一层，多花 200~400ms，并且把脚本的退出码包成 npm 的退出码
 *   （npm 还会打自己的日志），汇总时不好判断「是脚本报残留还是 npm 本身出错」。
 */
function runStep(step) {
  const scriptPath = path.join(SCRIPTS_DIR, step.script);
  if (!existsSync(scriptPath)) {
    return {
      ...step,
      status: "missing",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      keyLines: [`脚本不存在：scripts/${step.script}`],
      note: "跳过（文件缺失）",
    };
  }

  const t0 = Date.now();
  const res = spawnSync(process.execPath, [scriptPath, ...step.args], {
    cwd: CWD,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, PMS_DB_PATH: DB_PATH },
    // 输出可能很大（migrate-all 会打一屏），给到 32MB 上限，超出部分会被截断而不是崩
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;

  const stdout = String(res.stdout ?? "");
  // node:sqlite 的 ExperimentalWarning 走 stderr，会污染「有没有真错误」的判断，先剔掉
  const stderr = String(res.stderr ?? "")
    .split("\n")
    .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
    .join("\n")
    .trim();

  /*
   * 三种「不成功」要分开看，否则汇总报告会误导人：
   *   exit 0      → 成功
   *   exit 1      → 脚本**正常跑完**但报告「还有残留」（这些脚本用 1 表示"没修干净，
   *                  需人工核对"，不是崩溃）。部署时常见：欠费挂账本来就该留着。
   *   exit >=2 / signal / 超时 → 真失败
   */
  let status;
  if (res.error?.code === "ETIMEDOUT" || res.signal) status = "failed";
  else if (res.status === 0) status = "ok";
  else if (res.status === 1) status = "residual";
  else status = "failed";

  const allLines = stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  // 关键行优先；一行都没有就退回最后 3 行（脚本通常把总结打在最后）
  let keyLines = allLines.filter((l) => KEY_LINE_RE.test(l));
  if (keyLines.length === 0) keyLines = allLines.slice(-3);
  // 再不行就退到 stderr 的最后一行（真正的崩溃原因在那里）
  if (keyLines.length === 0 && stderr) keyLines = stderr.split("\n").slice(-3);

  return {
    ...step,
    scriptPath,
    status,
    exitCode: res.status,
    signal: res.signal ?? null,
    durationMs,
    stdout,
    stderr,
    keyLines: keyLines.slice(-6),
    note:
      res.error?.code === "ETIMEDOUT"
        ? `超时（>${Math.round(STEP_TIMEOUT_MS / 1000)}s 被终止）`
        : status === "residual"
          ? "完成，但脚本报告仍有残留（见上）"
          : undefined,
  };
}

/** 从体检脚本输出里抠出结论行，塞进汇总报告 */
function parseCheckOutput(step, result) {
  if (!result || !result.stdout) return null;
  const text = result.stdout;
  const out = {};

  if (step.id === "preflight") {
    // 「检查项 38 项：严重 0 / 警告 1 / 通过 37」
    const m = text.match(/检查项\s*(\d+)\s*项：\s*严重\s*(\d+)\s*\/\s*警告\s*(\d+)\s*\/\s*通过\s*(\d+)/);
    if (m) {
      out.total = Number(m[1]);
      out.fatal = Number(m[2]);
      out.warn = Number(m[3]);
      out.pass = Number(m[4]);
    }
    out.summary = (text.match(/(✅|❌)\s*[^\n]*(?:可以上线|不可上线)[^\n]*/) ?? [])[0] ?? null;
  }

  if (step.id === "health") {
    // 「共 58 处待处理」或「体检通过 ✅」
    const m = text.match(/共\s*(\d+)\s*处待处理/);
    out.problems = m ? Number(m[1]) : /体检通过/.test(text) ? 0 : null;
    // 「规模：房间 46 | 在住 21 | 预订 651 ...」
    out.scale = (text.match(/规模：[^\n]+/) ?? [])[0] ?? null;
    out.roomStatus = (text.match(/房态：(?:[A-Z]{2}\s*\d+\s*)+/) ?? [])[0] ?? null;
  }

  return out;
}

/* ════════════════════════════════════════════════════════════ 主流程 */

function main() {
  const startedAt = Date.now();

  let steps = STEPS;
  if (SKIP.size > 0) steps = steps.filter((s) => !SKIP.has(s.id));
  if (ONLY && ONLY.length > 0) {
    const unknown = ONLY.filter((id) => !STEPS.some((s) => s.id === id));
    if (unknown.length > 0) {
      console.error(`[失败] --only 里有未知步骤：${unknown.join(", ")}`);
      console.error(`       可用：${STEPS.map((s) => s.id).join(", ")}`);
      return 1;
    }
    steps = steps.filter((s) => ONLY.includes(s.id));
  }

  if (!JSON_OUT) {
    console.log(bold(`部署后收尾：${steps.length} 步（库：${DB_PATH}）`));
    console.log(dim(`项目根：${CWD}${DRY_RUN ? "   [dry-run]" : ""}`));
    console.log("");
  }

  if (DRY_RUN) {
    for (const [i, s] of steps.entries()) {
      console.log(`${String(i + 1).padStart(2)}. ${s.title}  ${dim(`node scripts/${s.script} ${s.args.join(" ")}`)}`);
      console.log(`    ${dim(s.why)}`);
    }
    console.log("");
    console.log(dim("dry-run：以上步骤都没有执行，数据库未改动。"));
    return 0;
  }

  const results = [];
  for (const [i, step] of steps.entries()) {
    if (!JSON_OUT) {
      process.stdout.write(`${String(i + 1).padStart(2)}/${steps.length} ${step.title} … `);
    }
    const r = runStep(step);
    results.push(r);
    if (!JSON_OUT) {
      const tag =
        r.status === "ok"
          ? green("OK")
          : r.status === "residual"
            ? yellow("有残留")
            : r.status === "missing"
              ? dim("缺失")
              : red("失败");
      console.log(`${tag} ${dim(`${r.durationMs}ms`)}`);
      for (const line of r.keyLines) console.log(`      ${dim("│")} ${line}`);
      if (r.status === "failed" && r.stderr) {
        for (const line of r.stderr.split("\n").slice(-5)) console.log(red(`      ✗ ${line}`));
      }
    }
  }

  /* ── 体检结论 ── */
  const checks = {};
  for (const r of results) {
    if (r.check) {
      const parsed = parseCheckOutput(r, r);
      if (parsed) checks[r.id] = parsed;
    }
  }

  /* ── 汇总 ── */
  const okCount = results.filter((r) => r.status === "ok").length;
  /*
   * 「有残留」要分成两类，否则退出码会误伤部署流程：
   *
   *   · 数据修复步骤返回 1（如超卖没修干净、客史还有空缺）→ 真的需要人处理
   *   · 体检步骤返回 1（preflight 的警告项 / health-check 的欠费积压）→ 这是**业务现状**，
   *     不是部署失败。演示库里「58 处待处理」是本来就有的欠费挂账，
   *     如果它让 post-deploy 返回 1，deploy-vps.sh（set -e）会在 chown/重启之前直接中断。
   *
   * 所以体检类的非零只展示、不参与退出码；真正的失败（崩溃/超时）才算。
   */
  const dataResidual = results.filter((r) => r.status === "residual" && !r.check).length;
  const checkResidual = results.filter((r) => r.status === "residual" && r.check).length;
  const missingCount = results.filter((r) => r.status === "missing").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const totalMs = Date.now() - startedAt;

  const fatal = checks.preflight?.fatal ?? 0;
  const healthProblems = checks.health?.problems ?? null;

  let exitCode = 0;
  if (failedCount > 0) exitCode = 2;
  else if (failedCount === 0 && fatal > 0) exitCode = 2;
  else if (dataResidual > 0 || missingCount > 0) exitCode = 1;

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          db: DB_PATH,
          cwd: CWD,
          dryRun: DRY_RUN,
          totalMs,
          summary: {
            total: results.length,
            ok: okCount,
            residual: residualCount,
            missing: missingCount,
            failed: failedCount,
            exitCode,
          },
          checks,
          steps: results.map((r) => ({
            id: r.id,
            title: r.title,
            command: `node scripts/${r.script} ${r.args.join(" ")}`.trim(),
            status: r.status,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            keyLines: r.keyLines,
            error: r.stderr ? r.stderr.split("\n").slice(-8) : undefined,
          })),
        },
        null,
        2
      )
    );
    return exitCode;
  }

  console.log("");
  console.log("════════════════ 收尾汇总 ════════════════");
  console.log(`  步骤    ${results.length} 步：成功 ${okCount} / 有残留 ${residualCount} / 缺失 ${missingCount} / 失败 ${failedCount}`);
  console.log(`  耗时    ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  数据库  ${DB_PATH}`);

  if (checks.preflight) {
    const p = checks.preflight;
    if (p.total !== undefined) {
      const icon = p.fatal > 0 ? "❌" : p.warn > 0 ? "⚠️" : "✅";
      console.log(
        `  体检1   ${icon} ${p.total} 项：严重 ${p.fatal} / 警告 ${p.warn} / 通过 ${p.pass}` +
          (p.summary ? `  ${dim(p.summary.trim())}` : "")
      );
    }
  }
  if (checks.health) {
    const h = checks.health;
    if (h.problems !== null && h.problems !== undefined) {
      console.log(`  体检2   ${h.problems === 0 ? "✅" : "⚠️"} ${h.problems} 处待处理`);
      if (h.scale) console.log(`          ${dim(h.scale)}`);
      if (h.roomStatus) console.log(`          ${dim(h.roomStatus)}`);
    }
  }

  const bad = results.filter((r) => r.status === "failed" || r.status === "residual" || r.status === "missing");
  if (bad.length > 0) {
    console.log("");
    console.log("  需要关注的步骤：");
    for (const r of bad) {
      const tag = r.status === "failed" ? red("失败") : r.status === "missing" ? dim("缺失") : yellow("有残留");
      console.log(`    ${tag}  ${r.title}  ${dim(`node scripts/${r.script} ${r.args.join(" ")}`)}`);
      if (r.note) console.log(`          ${dim(r.note)}`);
    }
  }

  console.log("");
  if (exitCode === 0) {
    console.log(green("  ✅ 全部步骤通过，系统可以对外服务"));
    console.log(dim("     建议再手工确认一次：curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3100/login"));
  } else if (exitCode === 1) {
    console.log(yellow("  ⚠️ 步骤跑完但有残留/缺失，按上面提示处理后再跑一次（幂等，重跑无害）"));
  } else {
    console.log(red("  ❌ 有步骤失败或体检发现严重问题，先别对外服务"));
    console.log(dim("     排查：单独重跑失败的那一步，看完整输出"));
  }
  console.log("");

  return exitCode;
}

process.exit(main());
