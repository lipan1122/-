#!/usr/bin/env node
/**
 * 部署后收尾 —— 一条命令跑完「结构 + 数据 + 体检」，默认只读
 *
 * ── 本文件的来历（两版合并，别只看一半就改）──
 *   · 「10 步流程 + 子进程编排 + 步骤超时」来自并行的部署收尾版
 *     （含 sync-schema / 单号唯一约束 / preflight-db / health-check 这几步，
 *      它们解决的是「用户只记得修数据、忘了补结构/体检」的漏项）；
 *   · 「默认 --check 只读、--apply 才写库」「失败即停」「第 1 步前只备份一次」
 *     「3 列汇总表」「押金修复走 repairDepositResidual() 函数而不是再起一个进程」
 *     来自押金残留接进迁移的那一版。
 *
 *   合并时**刻意改掉**的两处旧语义：
 *   1. 旧版默认 apply、要加 `--dry-run` 才不写 —— 部署文档里写
 *      `node scripts/post-deploy.mjs --check` 的人以为是「检查一下」，
 *      实际已经在写生产库了。**默认必须只读**，写库要显式 `--apply`。
 *      （`--dry-run` 保留成 `--check` 的同义词，老脚本不会因此变成写库。）
 *   2. 旧版失败继续 —— 数据修复是有顺序的（日期滚动会平移账单日、超卖判定依赖
 *      滚动后的分布），前一步没修干净就往下走，后面的步骤会依据错的日期/余额做判断。
 *      所以任何一步失败立刻停下，并明确报出停在哪一步。
 *
 * ── 十步（顺序有依赖，改之前先看每步的「为什么」）──
 *   1. schema 迁移            migrate-all.mjs（含第 24 段：押金残留完整口径修复）
 *   2. 补齐表结构             sync-schema.mjs
 *   3. 单号唯一约束           rebuild-unique-constraints.mjs
 *   4. 押金残留修复           repairDepositResidual()（与 fix-deposit-residual.mjs 同一实现）
 *   5. 房态复位               resetOrphanRoomStatus 同口径 SQL（OC/OD 但无在住单 → VC）
 *   6. 演示日期滚动           roll-demo-dates.mjs
 *   7. 存量超卖修复           fix-oversell-bookings.mjs
 *   8. 客史回填               backfill-guest-id-last8.mjs
 *   9. 数据一致性体检         preflight-db.mjs（38 项，只读）
 *  10. 业务体检               health-check.mjs --no-persist（只读，不写 room_anomalies）
 *
 *   为什么 4 和 1 都修押金：第 1 步的第 24 段已经把残留修干净，第 4 步在正常流程里
 *   恒为「0 变更」—— 它是**独立复核与兜底**：单独 `--skip migrate` 部署、或有人手工
 *   改过账时它仍然会修，并且给汇总表一行明确的「押金残留 N 张 / 已清零」。
 *   为什么 4/5 用函数、2/3/6/7/8/9/10 用子进程：前者需要结构化计数与「人工置房跳过」
 *   这种细粒度判断（只有函数里才有）；后者是既有独立 CLI，子进程调用 = 同一份实现。
 *
 * ── 默认只读：`--check`（= 默认）与 `--apply` 的差异 ──
 *   --check：修复类步骤一律用各自脚本的「只读模式」跑
 *            （migrate-all --check / sync-schema --check / rebuild-unique --check /
 *             roll-demo-dates --check / fix-oversell 与 backfill 的默认报告模式），
 *            体检类步骤本来就只读。**一个字节都不写**；
 *   --apply：同样十步，修复类步骤带 `--apply` 真写库；第 1 步之前做一次
 *            `VACUUM INTO data/backup/pms.db.bak-post-deploy-<时间戳>` 备份
 *            （整个流程只此一次；第 6~8 步的独立脚本还有各自的备份，是既有行为，保留）。
 *
 * ── 失败即停 ──
 *   修复类步骤：退出码非 0 → 当场停下（不跑后续步骤），汇总表该行标「❌ 失败」，进程退出码 1；
 *   体检类步骤：0 = 通过，1 = 有告警（继续，这是它们本来的报告语义），>= 2 = 失败（停下）；
 *   异常/超时（默认 300s，`PMS_POST_DEPLOY_TIMEOUT_MS` 可覆盖）同样算失败。
 *   已经跑完的步骤是有效结果：每步幂等，修完就是修完了。
 *
 * ── 退出码 ──
 *   0 = 十步全部成功（允许「0 变更」）；1 = 有步骤失败 / 有严重数据问题 / 库不存在。
 *
 * ── sudo 与文件归属（部署流程里必须留的那一行）──
 *   `sudo node scripts/post-deploy.mjs --apply` 会让脚本以 root 运行，SQLite 顺手
 *   创建/改写的 `data/pms.db-wal`、`data/pms.db-shm` 归属就变成 root；而服务是
 *   `ubuntu` 跑的，下一个请求直接 `attempt to write a readonly database`（第九轮真踩过）。
 *   本脚本**不会**自己 chown（它不知道服务用户是哪个），所以部署流程里
 *   `sudo chown -R ubuntu:ubuntu data` 必须留在 post-deploy 之后、systemctl restart
 *   之前 —— 顺序错了照样踩坑。
 *
 * 用法：
 *   node scripts/post-deploy.mjs                      # = --check，只报告每步会改什么
 *   node scripts/post-deploy.mjs --check              # 同上（显式写法；--dry-run 是它的旧别名）
 *   node scripts/post-deploy.mjs --apply              # 备份一次 → 写库
 *   node scripts/post-deploy.mjs --apply --skip 房态复位 --skip roll-dates,oversell
 *   node scripts/post-deploy.mjs --apply --days 60    # 超卖检查窗口（默认 30 天）
 *   node scripts/post-deploy.mjs --apply --verbose     # 打印子脚本完整输出
 *   PMS_DB_PATH=/path/to/pms.db node scripts/post-deploy.mjs --check
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { runMigrations } from "./migrate-all.mjs";
import { repairDepositResidual } from "./fix-deposit-residual.mjs";

/* ============================================================ 环境 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DB_PATH = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const BACKUP_DIR = path.join(path.dirname(DB_PATH), "backup");

const ARGV = process.argv.slice(2);
/* 默认只读：只有显式 --apply 才写库；--dry-run 是 --check 的旧别名，同样只读 */
const APPLY = ARGV.includes("--apply");
const VERBOSE = ARGV.includes("--verbose");
const STEP_TIMEOUT_MS = Number(process.env.PMS_POST_DEPLOY_TIMEOUT_MS ?? 300000);

/** --days N：透传给 fix-oversell-bookings.mjs（默认 30，与它自己的默认一致） */
const DAYS = (() => {
  const i = ARGV.indexOf("--days");
  if (i >= 0 && ARGV[i + 1] && /^\d+$/.test(ARGV[i + 1])) return Number(ARGV[i + 1]);
  const eq = ARGV.find((a) => a.startsWith("--days="));
  if (eq) return Number(eq.slice("--days=".length)) || 30;
  return 30;
})();

/* ============================================================ 小工具 */

const all = (db, sql, p = []) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (db, sql, p = []) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : undefined;
};
const tableExists = (db, name) =>
  Number(one(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`, [name])?.n ?? 0) > 0;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => round2(n).toFixed(2);
const todayYmd = (db) =>
  one(db, `SELECT date('now','localtime') AS d`)?.d ?? new Date().toISOString().slice(0, 10);

/** 日期 +n 天（纯整数运算，不经过时区 —— 与 scripts/fix-oversell-bookings.mjs 同一实现） */
function shiftDay(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function hotelIds(db) {
  if (!tableExists(db, "hotels")) return [1];
  const ids = all(db, `SELECT id FROM hotels ORDER BY id`).map((r) => Number(r.id));
  return ids.length > 0 ? ids : [1];
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

/* ============================================================ --skip / 步骤别名
 *
 * 三种写法都收（大小写 / 空格 / 下划线不敏感）：
 *   --skip 房态复位        --skip=room-status        --skip roll-dates,oversell
 *   --skip 5               （按序号跳过第 5 步）
 * 拼错直接报错并列出可选值 —— 静默忽略一个拼错的 --skip，会让人以为「跳过了」，
 * 实际照跑一遍，是最坑的失败模式。
 */

const STEP_DEFS = [
  {
    id: "migrate",
    name: "schema 迁移",
    unit: "项",
    kind: "fix",
    title: "数据库迁移 + 押金残留第 24 段",
    why: "补表/补列/补索引，并把押金残留修干净；缺了它页面直接 500",
  },
  {
    id: "sync-schema",
    name: "补齐表结构",
    unit: "项",
    kind: "fix",
    script: "sync-schema.mjs",
    checkArgs: ["--check"],
    applyArgs: [],
    title: "补齐表结构",
    why: "60 张表散落在页面里建，全新库靠它补齐（按 schema-fingerprint.json）",
  },
  {
    id: "unique",
    name: "单号唯一约束",
    unit: "项",
    kind: "fix",
    script: "rebuild-unique-constraints.mjs",
    checkArgs: ["--check"],
    applyArgs: [],
    title: "单号唯一约束",
    why: "booking/stay/folio 单号去掉全局 UNIQUE（多店部署必需），已是目标状态则跳过",
  },
  {
    id: "deposit",
    name: "押金残留修复",
    unit: "张",
    kind: "fix",
    title: "押金残留修复",
    why: "退房不冲销押金 → 在住押金虚高（真库曾残留 6800 元）",
  },
  {
    id: "room-status",
    name: "房态复位",
    unit: "间",
    kind: "fix",
    title: "房态复位",
    why: "OC/OD 却没有在住单的房间复位成 VC（人工置住净的跳过）",
  },
  {
    id: "roll-dates",
    name: "演示日期滚动",
    unit: "张",
    kind: "fix",
    script: "roll-demo-dates.mjs",
    checkArgs: ["--check"],
    applyArgs: ["--apply"],
    title: "演示日期滚动",
    why: "演示数据锚在导出日 → 隔几天全部逾期；基准记在 op_logs，重跑 0 变更",
  },
  {
    id: "oversell",
    name: "存量超卖修复",
    unit: "条",
    kind: "fix",
    script: "fix-oversell-bookings.mjs",
    checkArgs: [],
    applyArgs: ["--apply"],
    title: "存量超卖修复",
    why: "房型级预订数 > 物理房量（曾出租率 102%）",
  },
  {
    id: "guest-id",
    name: "客史回填",
    unit: "张",
    kind: "fix",
    script: "backfill-guest-id-last8.mjs",
    checkArgs: [],
    applyArgs: ["--apply"],
    title: "客史回填",
    why: "在住单 guest_id 为空 → 会员/积分/历史入住关联不上",
  },
  {
    id: "preflight",
    name: "数据一致性体检",
    unit: "",
    kind: "check",
    script: "preflight-db.mjs",
    checkArgs: [],
    applyArgs: [],
    title: "数据一致性体检（38 项）",
    why: "外键悬空 / 状态矛盾 / 金额对不上 / 重复记录",
  },
  {
    id: "health",
    name: "业务体检",
    unit: "",
    kind: "check",
    script: "health-check.mjs",
    checkArgs: ["--no-persist"],
    applyArgs: ["--no-persist"],
    title: "业务体检",
    why: "房态一致性 / 账务 / 积压（只读，不写 room_anomalies）",
  },
];

const SKIP_ALIASES = {
  migrate: ["migrate", "migration", "schema迁移", "迁移", "数据库迁移", "1"],
  "sync-schema": ["sync-schema", "sync_schema", "sync", "补表", "补齐表结构", "表结构", "2"],
  unique: ["unique", "唯一约束", "单号唯一约束", "约束", "3"],
  deposit: ["deposit", "押金", "押金残留", "押金残留修复", "4"],
  "room-status": ["room-status", "room_status", "房态", "房态复位", "5"],
  "roll-dates": ["roll-dates", "roll_dates", "roll-demo-dates", "日期", "日期滚动", "演示日期滚动", "6"],
  oversell: ["oversell", "超卖", "存量超卖", "存量超卖修复", "7"],
  "guest-id": ["guest-id", "guest_id", "客史", "客史回填", "8"],
  preflight: ["preflight", "体检", "一致性体检", "数据一致性体检", "9"],
  health: ["health", "业务体检", "健康", "10"],
};

function parseSkips() {
  const raw = [];
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (a === "--skip") {
      const v = ARGV[i + 1];
      if (!v || v.startsWith("--")) fail("--skip 后面要跟步骤名，例如 --skip 房态复位");
      raw.push(...v.split(","));
      i += 1;
    } else if (a.startsWith("--skip=")) {
      raw.push(...a.slice("--skip=".length).split(","));
    }
  }
  const out = new Set();
  for (const item of raw) {
    const key = String(item).trim().toLowerCase().replace(/[\s_]+/g, "");
    if (!key) continue;
    const hit = Object.entries(SKIP_ALIASES).find(([, aliases]) =>
      aliases.some((x) => x.toLowerCase().replace(/[\s_]+/g, "") === key || x.toLowerCase() === key)
    );
    if (!hit) {
      fail(
        `不认识的 --skip 步骤：${item}\n  可用：` +
          STEP_DEFS.map((s) => `${s.id}（${s.name}）`).join(" / ")
      );
    }
    out.add(hit[0]);
  }
  return out;
}

const SKIP = parseSkips();

/* ============================================================ 子进程 */

/**
 * 跑一个既有脚本（同一份实现，不复制逻辑）
 *
 * 用 spawnSync 而不是 execFileSync/execSync：
 *   · 要同时拿到「退出码 + stdout + stderr + 耗时 + 是否超时」；
 *   · execSync 会把 stderr 混进异常消息里，既拿不到干净输出，也分不清哪一步失败。
 * 用 process.execPath 而不是 "node"：部署机 PATH 里可能有多个 Node，
 * 必须和当前进程同一个二进制，node:sqlite 的行为才一致。
 */
function runChild(script, args) {
  const file = path.join(HERE, script);
  if (!fs.existsSync(file)) {
    return { ok: false, code: null, out: "", err: `脚本不存在：scripts/${script}`, missing: true, ms: 0 };
  }
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, PMS_DB_PATH: DB_PATH },
    /* migrate-all 会打一屏输出；给到 32MB 上限，超出被截断而不是崩 */
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = String(res.stdout ?? "");
  /* node:sqlite 的 ExperimentalWarning 走 stderr，会污染「有没有真错误」的判断，先剔掉 */
  const err = String(res.stderr ?? "")
    .split("\n")
    .filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings|MODULE_TYPELESS|Reparsing as ES module/.test(l))
    .join("\n")
    .trim();
  const timedOut = res.error?.code === "ETIMEDOUT" || Boolean(res.signal);
  const code = typeof res.status === "number" ? res.status : null;
  return { ok: !timedOut && code === 0, code, out, err, timedOut, ms };
}

/** 从子脚本输出里捞一个数字（措辞是既有的；捞不到就让调用方退回复核口径） */
function pickNum(out, patterns) {
  for (const re of patterns) {
    const m = re.exec(out);
    if (m) return Number(m[1]);
  }
  return null;
}

function tail(s, n = 3) {
  return String(s)
    .split("\n")
    .filter((x) => x.trim())
    .slice(-n)
    .join(" ⏎ ");
}

/** 默认只打印「带数字/结论」的那几行；--verbose 打印全部 */
function printChildOutput(out, err) {
  if (VERBOSE) {
    for (const line of String(out).split("\n")) if (line.trim()) console.log(`    │ ${line}`);
    for (const line of String(err).split("\n")) if (line.trim()) console.log(`    ! ${line}`);
    return;
  }
  const keep = [];
  for (const line of String(out).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^(数据库|模式|今天|检查范围|房型容量)[:：]/.test(t)) continue;
    if (/^(✅|❌|⚠️|!)|需要|已取消|已平移|已备份|重建|补|缺表|缺列|复核|汇总|超卖|逾期|guest_id 为空|在住单|检查项/.test(t)) {
      keep.push(t);
    }
  }
  for (const line of keep.slice(0, 14)) console.log(`    │ ${line}`);
  if (keep.length > 14) console.log(`    │ …… 还有 ${keep.length - 14} 行（--verbose 看全部）`);
}

/* ============================================================ 第 5 步：房态复位
 *
 * 与 `src/lib/seed-uniform.ts` 的 resetOrphanRoomStatus / `scripts/seed-uniform-demo.mjs`
 * 的 JS 版**同一口径**（三处改动必须同步）：
 *   · 孤儿 = rooms.status IN ('OC','OD') 且没有 INHOUSE 在住单；
 *   · room_logs 最后一笔 to_status ∈ (OC,OD) 且 reason 以「手工」开头 → 人工意图，跳过；
 *   · 其余 → rooms.status = 'VC'，写 room_logs，最后写一条 op_logs 汇总。
 *
 * 为什么不直接调 `fix-room-status.mjs`：它双向校准（有在住单的房间强制 OC/OD），
 * 但**不认「手工置住净」**，会把人有意留的住净房一起清掉；本步按用户要求的
 * 「OC/OD 但无在住单」口径做，方向一（有在住单房态不对）只报告不自动改。
 */
function resetOrphanRoomStatus(db, hotelId, apply) {
  const out = { planned: 0, reset: [], skippedManual: [], failed: [], logged: false };
  const hasRoomLogs = tableExists(db, "room_logs");

  const orphans = all(
    db,
    `SELECT r.id, r.room_no, r.status FROM rooms r
      WHERE r.hotel_id = ?
        AND r.status IN ('OC','OD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.hotel_id = r.hotel_id AND s.room_id = r.id AND s.status = 'INHOUSE'
        )
      ORDER BY r.floor, r.room_no, r.id`,
    [hotelId]
  );

  for (const room of orphans) {
    if (hasRoomLogs) {
      const last = one(
        db,
        `SELECT to_status, reason FROM room_logs
          WHERE hotel_id = ? AND room_id = ?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1`,
        [hotelId, room.id]
      );
      if (last && (last.to_status === "OC" || last.to_status === "OD") && /^手工/.test(last.reason ?? "")) {
        out.skippedManual.push({ id: room.id, room_no: room.room_no });
        continue;
      }
    }
    out.planned += 1;
    if (!apply) {
      out.reset.push({ id: room.id, room_no: room.room_no, from: room.status });
      continue;
    }
    try {
      db.prepare(`UPDATE rooms SET status = 'VC' WHERE id = ? AND hotel_id = ?`).run(room.id, hotelId);
      if (hasRoomLogs) {
        db.prepare(
          `INSERT INTO room_logs (hotel_id, room_id, from_status, to_status, reason, operator, created_at)
           VALUES (?,?,?,?,?,?,?)`
        ).run(
          hotelId,
          room.id,
          room.status,
          "VC",
          "系统修复 · 无在住单的住净房复位（post-deploy）",
          "系统修复",
          new Date().toISOString()
        );
      }
      out.reset.push({ id: room.id, room_no: room.room_no, from: room.status });
    } catch (e) {
      out.failed.push({ id: room.id, room_no: room.room_no, error: e?.message ?? String(e) });
    }
  }

  if (out.failed.length > 0) {
    throw new Error(
      `房态复位失败 ${out.failed.length} 间：` + out.failed.map((f) => `${f.room_no}（${f.error}）`).join("、")
    );
  }

  if (apply && out.reset.length > 0 && tableExists(db, "op_logs")) {
    db.prepare(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`).run(
      hotelId,
      "系统修复",
      "部署后·房态复位",
      `复位无在住单的住净/住脏房 ${out.reset.length} 间：` +
        out.reset.map((r) => `${r.room_no}(${r.from}→VC)`).join("、") +
        (out.skippedManual.length > 0
          ? `；跳过人工置住净 ${out.skippedManual.length} 间：${out.skippedManual.map((r) => r.room_no).join("、")}`
          : ""),
      new Date().toISOString()
    );
    out.logged = true;
  }
  return out;
}

/* ============================================================ 每步的「状态探针」
 *
 * 每步前后各打一次同样的状态行，数字自己说话：前 11 张 → 后 0 张，
 * 比「✅ 成功」有用得多。探针全是只读 SQL，--check 下也不会写。
 */

/** 押金残留：三段口径与 fix-deposit-residual.mjs 的复核段一致 */
function probeDeposit(db) {
  const stay =
    one(db, `SELECT COUNT(*) AS n FROM stays WHERE status = 'CHECKED_OUT' AND COALESCE(deposit, 0) > 0.005`) ?? {
      n: 0,
    };
  const settled =
    one(
      db,
      `SELECT COUNT(DISTINCT f.id) AS n FROM folios f
         JOIN folio_items i ON i.folio_id = f.id AND i.hotel_id = f.hotel_id
        WHERE f.status = 'SETTLED' AND i.item_type = 'DEPOSIT' AND COALESCE(i.amount, 0) > 0.005`
    ) ?? { n: 0 };
  const bad =
    one(db, `SELECT COUNT(*) AS n FROM folios WHERE status = 'SETTLED' AND ABS(COALESCE(balance, 0)) > 0.01`) ?? {
      n: 0,
    };
  return {
    n: Number(stay.n) + Number(settled.n) + Number(bad.n),
    text: `已退房残留押金 ${stay.n} 张 / SETTLED 挂押金明细 ${settled.n} 张 / SETTLED 余额非 0 ${bad.n} 张`,
  };
}

/** 房态漂移：没有在住单却挂着 OC/OD 的房间（「人工置住净」的单独标出来） */
function probeRooms(db) {
  const rows = all(
    db,
    `SELECT r.id, r.hotel_id, r.room_no, r.status FROM rooms r
      WHERE r.status IN ('OC','OD')
        AND NOT EXISTS (
          SELECT 1 FROM stays s
           WHERE s.hotel_id = r.hotel_id AND s.room_id = r.id AND s.status = 'INHOUSE'
        )
      ORDER BY r.hotel_id, r.room_no`
  );
  let manual = 0;
  if (tableExists(db, "room_logs") && rows.length > 0) {
    for (const r of rows) {
      const last = one(
        db,
        `SELECT to_status, reason FROM room_logs WHERE hotel_id = ? AND room_id = ?
          ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`,
        [r.hotel_id, r.id]
      );
      if (last && (last.to_status === "OC" || last.to_status === "OD") && /^手工/.test(last.reason ?? "")) manual += 1;
    }
  }
  return {
    n: rows.length - manual,
    manual,
    text:
      `无在住单的 OC/OD 房 ${rows.length} 间` +
      (manual > 0 ? `（其中人工置房 ${manual} 间，不复位）` : "") +
      (rows.length > 0 ? `：${rows.map((r) => `${r.room_no}(${r.status})`).join("、")}` : ""),
  };
}

/** 房态「方向一」：有在住单但房态不是 OC/OD（本步不自动改，只报告） */
function probeRoomsInhouseMismatch(db) {
  return all(
    db,
    `SELECT r.id, r.room_no, r.status FROM rooms r
       JOIN stays s ON s.room_id = r.id AND s.hotel_id = r.hotel_id AND s.status = 'INHOUSE'
      WHERE r.status NOT IN ('OC','OD')`
  );
}

/** 演示数据日期：在住逾期张数（roll-demo-dates 的目标是「逾期归零」） */
function probeDates(db) {
  const today = todayYmd(db);
  const r =
    one(
      db,
      `SELECT COUNT(*) AS total,
              CAST(SUM(CASE WHEN expect_check_out < ? THEN 1 ELSE 0 END) AS INTEGER) AS overdue,
              CAST(SUM(CASE WHEN stay_no LIKE 'SI%' AND expect_check_out < ? THEN 1 ELSE 0 END) AS INTEGER) AS overdueSi,
              CAST(SUM(CASE WHEN expect_check_out = ? THEN 1 ELSE 0 END) AS INTEGER) AS dueToday
         FROM stays WHERE status = 'INHOUSE'`,
      [today, today, today]
    ) ?? { total: 0, overdue: 0, overdueSi: 0, dueToday: 0 };
  return {
    n: Number(r.overdue ?? 0),
    text: `在住 ${r.total} 张 / 逾期 ${r.overdue} 张（其中演示单 ${r.overdueSi} 张）/ 今日应退 ${r.dueToday} 张`,
  };
}

/** 存量超卖：按「日期 × 房型」统计 PENDING/CONFIRMED 预定间数超过物理房量的组合 */
function probeOversell(db, days) {
  const today = todayYmd(db);
  const types = all(
    db,
    `SELECT rt.id, rt.name,
            (SELECT COUNT(*) FROM rooms r WHERE r.hotel_id = rt.hotel_id AND r.room_type_id = rt.id) AS cap
       FROM room_types rt ORDER BY rt.hotel_id, rt.sort, rt.id`
  );
  const combos = [];
  for (let i = 0; i < days; i++) {
    const day = shiftDay(today, i);
    for (const t of types) {
      if (Number(t.cap) <= 0) continue;
      const used = Number(
        one(
          db,
          `SELECT COALESCE(SUM(COALESCE(room_count, 1)), 0) AS s FROM bookings
            WHERE room_type_id = ? AND status IN ('PENDING','CONFIRMED')
              AND check_in_date <= ? AND check_out_date > ?`,
          [t.id, day, day]
        )?.s ?? 0
      );
      if (used > Number(t.cap)) combos.push(`${day} ${t.name} ${used}>${t.cap}`);
    }
  }
  return {
    n: combos.length,
    text: `未来 ${days} 天超卖组合 ${combos.length} 个` + (combos.length > 0 ? `：${combos.slice(0, 6).join("、")}` : ""),
  };
}

/** 客史：在住单 guest_id 为空 */
function probeGuestId(db) {
  const r =
    one(db, `SELECT COUNT(*) AS n FROM stays WHERE status = 'INHOUSE' AND (guest_id IS NULL OR guest_id = 0)`) ?? {
      n: 0,
    };
  return { n: Number(r.n), text: `在住单 guest_id 为空 ${r.n} 张` };
}

/* ============================================================ 十步的实现 */

/** 1. schema 迁移（进程内：直接拿 runMigrations 的结构化结果，含第 24 段押金修复） */
function stepMigrate({ db, apply }) {
  /* 先按 --check 口径扫一遍拿到「待变更 N 项」，--apply 再真跑一次（同一函数，天然幂等） */
  const pre = runMigrations(db, { checkOnly: true });
  const before = `待变更迁移 ${pre.applied.length} 项`;
  const res = apply ? runMigrations(db, { checkOnly: false }) : pre;
  const after = apply ? "待变更迁移 0 项" : before;
  return {
    changes: apply ? res.changed : res.applied.length,
    before,
    after,
    result: res.applied.length === 0 ? "已是目标状态" : apply ? "已迁移" : "待迁移",
    lines: res.applied.slice(0, 12),
    more: Math.max(0, res.applied.length - 12),
  };
}

/** 4. 押金残留修复（进程内：与 fix-deposit-residual.mjs 同一实现） */
function stepDeposit({ db, apply }) {
  const before = probeDeposit(db);
  const r = repairDepositResidual(db, null, {
    apply,
    settleOpen: true,
    zeroedDepositFallback: true,
  });
  const after = probeDeposit(db);
  const lines = [];
  if (r.planned > 0) {
    lines.push(
      `账单押金冲销 ${r.checked.folioDeposit} 张 / 仅入住单清零 ${r.checked.stayOnly} 张 / ` +
        `已退房仍 OPEN 置 SETTLED ${r.checked.openSettled} 张 / 余额归零 ${r.checked.balanceRecalc} 张`
    );
    lines.push(
      `退现金 ${money(r.totals.refundCash)} · 抵扣房费 ${money(r.totals.offsetToRoom)} · 残留押金 ${money(
        round2(r.totals.depositItems + r.totals.stayDeposit)
      )}`
    );
  } else {
    lines.push("没有残留押金：第 1 步的迁移第 24 段已把这类修复并入，本步是独立复核");
  }
  if (r.checked.balanceManual > 0) {
    lines.push(`⚠️ ${r.checked.balanceManual} 张已结账账单重算后余额仍非 0：只报告不动（需人工核对）`);
  }
  return {
    changes: apply ? r.changed : r.planned,
    before: before.text,
    after: after.text,
    result: r.planned === 0 ? "已是干净状态" : apply ? "已清零" : "待修复",
    lines,
  };
}

/** 5. 房态复位（进程内：seed-uniform 同口径 SQL） */
function stepRoomStatus({ db, apply }) {
  const before = probeRooms(db);
  let planned = 0;
  const done = [];
  let skippedManual = 0;
  for (const hid of hotelIds(db)) {
    const r = resetOrphanRoomStatus(db, hid, apply);
    planned += r.planned;
    skippedManual += r.skippedManual.length;
    for (const x of r.reset) done.push(x.room_no);
  }
  const after = probeRooms(db);
  const mismatch = probeRoomsInhouseMismatch(db);
  const lines = [];
  if (planned > 0) {
    lines.push(apply ? `已复位：${done.map((x) => `${x}(→VC)`).join("、")}` : `待复位：${done.map((x) => `${x}(→VC)`).join("、")}`);
  } else {
    lines.push("没有「OC/OD 却没有在住单」的房间");
  }
  if (skippedManual > 0) lines.push(`跳过人工置住净 ${skippedManual} 间（尊重人工意图，不算脏数据）`);
  if (mismatch.length > 0) {
    lines.push(
      `另有 ${mismatch.length} 间「有在住单但房态不是 OC/OD」：${mismatch
        .map((x) => `${x.room_no}(${x.status})`)
        .join("、")} —— 本步不动（口径冲突），需要时单独跑 node scripts/fix-room-status.mjs --apply`
    );
  }
  return {
    changes: apply ? done.length : planned,
    before: before.text,
    after: after.text,
    result: planned === 0 ? "已是目标状态" : apply ? "已复位" : "待复位",
    lines,
  };
}

/** 子进程类步骤：统一外壳（跑 → 解析计数 → 前后状态） */
function runScriptStep(step, ctx) {
  const { db, apply, def } = ctx;
  /* 脚本与参数来自 STEP_DEFS（def），step 只提供 probe / count / shape 三件套 */
  const base = def;
  const args = [...(apply ? base.applyArgs ?? [] : base.checkArgs ?? [])];
  if (base.id === "oversell") args.push("--days", String(DAYS));

  const before = step.probe ? step.probe(db) : null;
  const out = runChild(base.script, args);
  if (out.missing) throw new Error(out.err);
  if (out.timedOut) throw new Error(`超时（>${Math.round(STEP_TIMEOUT_MS / 1000)}s 被终止）`);
  if (!out.ok) {
    printChildOutput(out.out, out.err);
    const stderrTail = out.err ? `stderr：${tail(out.err)}` : "";
    throw new Error(`${base.script} 退出码 ${out.code}${stderrTail ? "；" + stderrTail : `；输出尾部：${tail(out.out)}`}`);
  }
  printChildOutput(out.out, out.err);
  const after = step.probe ? step.probe(db) : null;
  const parsed = step.count ? step.count(out.out) : null;
  const fallback = before && after ? Math.max(0, before.n - after.n) : 0;
  const changes = apply ? parsed ?? fallback : parsed ?? (before ? before.n : 0);
  return step.shape({ db, apply, before, after, changes, out });
}

/* ============================================================ 步骤执行器 */

const STEP_RUNNERS = {
  migrate: stepMigrate,
  deposit: stepDeposit,
  "room-status": stepRoomStatus,

  /* 2. 补齐表结构 */
  "sync-schema": (ctx) =>
    runScriptStep(
      {
        probe: (db) => {
          const r = one(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'`) ?? { n: 0 };
          return { n: 0, text: `索引 ${r.n} 个（缺表/缺列/缺索引由脚本按指纹比对）` };
        },
        count: (s) =>
          (pickNum(s, [/缺表：(\d+) 张/]) ?? 0) +
          (pickNum(s, [/缺列：(\d+) 个/]) ?? 0) +
          (pickNum(s, [/补索引：(\d+) 条/]) ?? 0) +
          (pickNum(s, [/补表 (\d+) 张/, /新建表 (\d+) 张/]) ?? 0),
        shape: ({ apply, changes, out }) => ({
          changes,
          result: changes === 0 ? (apply ? "已是目标状态" : "已是目标状态") : apply ? "已同步" : "待同步",
          lines: [
            `缺表 ${pickNum(out, [/缺表：(\d+) 张/]) ?? 0} 张 / 缺列 ${pickNum(out, [/缺列：(\d+) 个/]) ?? 0} 个` +
              ((pickNum(out, [/补索引：(\d+) 条/]) ?? 0) > 0 ? ` / 补索引 ${pickNum(out, [/补索引：(\d+) 条/])} 条` : ""),
          ],
        }),
      },
      ctx
    ),

  /* 3. 单号唯一约束 */
  unique: (ctx) =>
    runScriptStep(
      {
        count: (s) => pickNum(s, [/需要重建：(\d+) 张/]) ?? 0,
        shape: ({ apply, changes, out }) => ({
          changes,
          result: changes === 0 ? "已是目标状态" : apply ? "已重建" : "待重建",
          lines: [/已经是目标状态[^\n]*/.test(out) ? "三张表的单号列都没有全局 UNIQUE" : `需要重建 ${changes} 张表（SQLite 无 DROP CONSTRAINT，按 建表→搬数据→改名 做）`],
        }),
      },
      ctx
    ),

  /* 6. 演示日期滚动 */
  "roll-dates": (ctx) =>
    runScriptStep(
      {
        probe: probeDates,
        count: (s) => pickNum(s, [/已平移：(\d+) 张/, /需要平移：(\d+) 张/]),
        shape: ({ apply, before, after, changes }) => ({
          changes,
          before: before.text,
          after: after.text,
          result: changes === 0 ? "无需滚动" : apply ? "已滚动" : "待滚动",
          lines: [
            changes > 0
              ? apply
                ? `已平移 ${changes} 张入住单（含账单/明细/流水/早餐/关联预订）`
                : `需要平移 ${changes} 张入住单`
              : "全部已在目标窗口内（幂等：重复执行不会累积偏移）",
            `逾期：${before.n} → ${after.n} 张`,
          ],
        }),
      },
      ctx
    ),

  /* 7. 存量超卖修复 */
  oversell: (ctx) =>
    runScriptStep(
      {
        probe: (db) => probeOversell(db, DAYS),
        count: (s) => pickNum(s, [/已取消 (\d+) 条预订/, /需要取消：(\d+) 条预订/]),
        shape: ({ apply, before, after, changes }) => ({
          changes,
          before: before.text,
          after: after.text,
          result: before.n === 0 && after.n === 0 ? "无超卖" : apply ? "已取消超卖单" : "待取消超卖单",
          lines: [
            `超卖组合：${before.n} → ${after.n} 个`,
            ...(changes > 0
              ? [`${apply ? "已取消" : "待取消"} ${changes} 条预订（保留 id 最小的：越早订的越可能是真实需求）`]
              : []),
          ],
        }),
      },
      ctx
    ),

  /* 8. 客史回填（计数用前后探针：脚本报的「新建客史 N 个」是客人档案数，不是单数） */
  "guest-id": (ctx) =>
    runScriptStep(
      {
        probe: probeGuestId,
        count: () => null,
        shape: ({ apply, before, after }) => ({
          changes: apply ? Math.max(0, before.n - after.n) : before.n,
          before: before.text,
          after: after.text,
          result: before.n === 0 ? "无需回填" : apply ? "已回填" : "待回填",
          lines: [
            ...(apply && before.n > 0 ? [`回填 ${before.n - after.n} 张在住单的 guest_id（新建客史数见上）`] : []),
            `guest_id 为空：${before.n} → ${after.n} 张`,
          ],
        }),
      },
      ctx
    ),

  /* 9. 数据一致性体检（只读） */
  preflight: (ctx) => {
    const out = runChild("preflight-db.mjs", []);
    if (out.missing) throw new Error(out.err);
    if (out.timedOut) throw new Error(`超时（>${Math.round(STEP_TIMEOUT_MS / 1000)}s 被终止）`);
    const severe = pickNum(out.out, [/检查项 \d+ 项：严重 (\d+)/]) ?? 0;
    const total = pickNum(out.out, [/检查项 (\d+) 项/]) ?? 0;
    const warn = pickNum(out.out, [/严重 \d+ \/ 警告 (\d+)/]) ?? 0;
    const pass = pickNum(out.out, [/通过 (\d+)/]) ?? 0;
    if (out.code !== 0 && out.code !== 1) {
      printChildOutput(out.out, out.err);
      throw new Error(`preflight-db.mjs 退出码 ${out.code}；${tail(out.err || out.out)}`);
    }
    printChildOutput(out.out, out.err);
    return {
      changes: 0,
      unitText: "—",
      result: `${total} 项：严重 ${severe} / 警告 ${warn} / 通过 ${pass}`,
      lines: [severe > 0 ? `❌ 有 ${severe} 项严重问题，不能上线` : warn > 0 ? `⚠️ ${warn} 项警告（不阻断）` : "✅ 无严重问题"],
      fatal: severe,
    };
  },

  /* 10. 业务体检（只读） */
  health: (ctx) => {
    const out = runChild("health-check.mjs", ["--no-persist"]);
    if (out.missing) throw new Error(out.err);
    if (out.timedOut) throw new Error(`超时（>${Math.round(STEP_TIMEOUT_MS / 1000)}s 被终止）`);
    const problems = pickNum(out.out, [/共 (\d+) 处待处理/]);
    if (out.code !== 0 && out.code !== 1) {
      printChildOutput(out.out, out.err);
      throw new Error(`health-check.mjs 退出码 ${out.code}；${tail(out.err || out.out)}`);
    }
    printChildOutput(out.out, out.err);
    return {
      changes: 0,
      unitText: "—",
      result: problems === null ? "体检通过" : `${problems} 处待处理`,
      lines: [],
    };
  },
};

/* ============================================================ 汇总表（中文按 2 列宽） */

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}
const padRight = (s, w) => String(s) + " ".repeat(Math.max(0, w - dispWidth(s)));
const padLeft = (s, w) => " ".repeat(Math.max(0, w - dispWidth(s))) + String(s);

function renderTable(rows) {
  const head = ["步骤", "变更", "结果"];
  const w1 = Math.max(15, ...rows.map((r) => dispWidth(r[0])), dispWidth(head[0]));
  const w2 = Math.max(6, ...rows.map((r) => dispWidth(r[1])), dispWidth(head[1]));
  const w3 = Math.max(12, ...rows.map((r) => dispWidth(r[2])), dispWidth(head[2]));
  const line = (l, m, r) => `${l}${"─".repeat(w1 + 2)}${m}${"─".repeat(w2 + 2)}${m}${"─".repeat(w3 + 2)}${r}`;
  const out = [];
  out.push(line("┌", "┬", "┐"));
  out.push(`│ ${padRight(head[0], w1)} │ ${padRight(head[1], w2)} │ ${padRight(head[2], w3)} │`);
  out.push(line("├", "┼", "┤"));
  for (const [a, b, c] of rows) {
    out.push(`│ ${padRight(a, w1)} │ ${padLeft(b, w2)} │ ${padRight(c, w3)} │`);
  }
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}

/* ============================================================ 主流程 */

/** 整个流程只备份一次（第 1 步之前） */
function backupOnce(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const target = path.join(BACKUP_DIR, `pms.db.bak-post-deploy-${stamp}`);
  if (fs.existsSync(target)) {
    console.log(`备份已存在，跳过：${target}`);
    return target;
  }
  const escaped = target.replace(/\\/g, "/").replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(2);
  console.log(`✅ 统一备份（整个流程只此一次）：${target}（${mb} MB）`);
  return target;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    fail(
      `数据库不存在：${DB_PATH}\n` +
        `  用 PMS_DB_PATH 指定，或先跑 node scripts/init-db.mjs / node scripts/load-demo.mjs`
    );
  }

  const steps = STEP_DEFS.filter((s) => !SKIP.has(s.id));

  console.log("═".repeat(78));
  console.log("部署后收尾（结构 → 数据 → 体检）");
  console.log(`数据库：${DB_PATH}`);
  console.log(`模式：${APPLY ? "APPLY（写库）" : "CHECK（只报告，不写任何数据）"}`);
  console.log(`步骤：${steps.length}/${STEP_DEFS.length} 个${SKIP.size > 0 ? `；跳过 ${[...SKIP].join("、")}` : ""}`);
  console.log(`超卖检查窗口：${DAYS} 天；单步超时：${Math.round(STEP_TIMEOUT_MS / 1000)}s`);
  console.log("═".repeat(78) + "\n");

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 15000");
  let failed = null;
  let fatal = 0;

  try {
    /* 账务口径（lib/folio.ts）通过 globalThis.__pmsDb 取连接，必须先指过来 */
    globalThis.__pmsDb = db;

    let backupPath = null;
    if (APPLY) {
      backupPath = backupOnce(db);
      console.log("   （第 6~8 步是既有独立脚本，它们有变更时会各自再写一份自己的备份 —— 既有行为，保留）\n");
    }

    const rows = [];

    for (let i = 0; i < steps.length; i++) {
      const def = steps[i];
      const tag = `[${i + 1}/${steps.length}] ${def.name}`;
      console.log(tag);

      let res;
      const t0 = Date.now();
      try {
        const runner = STEP_RUNNERS[def.id];
        if (!runner) throw new Error(`没有实现（内部错误）`);
        res = runner({ db, apply: APPLY, def });
      } catch (e) {
        const failRow = def.kind === "fix" ? "❌ 失败" : "❌ 失败";
        rows.push([def.name, "—", failRow]);
        failed = { def, index: i, error: e };
        console.log(`  ❌ 失败：${e?.message ?? e}\n`);
        break;
      }
      const ms = Date.now() - t0;

      if (res.before) console.log(`  前：${res.before}`);
      if (res.after) console.log(`  后：${res.after}`);
      for (const l of res.lines ?? []) console.log(`  · ${l}`);
      if (res.more > 0) console.log(`  · …… 还有 ${res.more} 项（--verbose 或单独跑脚本看全部）`);

      /* 体检类步骤的「变更」列没有意义，用「—」；修复类给「N 单位」 */
      const changeText =
        def.kind === "check"
          ? res.unitText ?? "—"
          : res.changes === 0
            ? `0 ${def.unit}`
            : `${res.changes} ${def.unit}`;

      console.log(`  → ${APPLY ? "" : "（未写库）"}${res.result}${ms > 300 ? `  · ${ms}ms` : ""}\n`);
      rows.push([def.name, changeText, res.result]);
      if (typeof res.fatal === "number") fatal += res.fatal;
    }

    /* 汇总表 */
    console.log("═".repeat(78));
    console.log(renderTable(rows));
    console.log("═".repeat(78));

    const changed = rows.reduce((s, r) => s + (Number.parseInt(r[1], 10) || 0), 0);
    console.log(`合计：${steps.length} 步${SKIP.size > 0 ? `（跳过 ${SKIP.size} 步）` : ""} · 变更 ${changed} 处`);
    if (APPLY) {
      console.log(`备份：${backupPath}`);
      console.log("");
      console.log("⚠️ 下一步必须把 data 的归属还回服务用户（sudo 跑脚本会产生 root 的 -wal/-shm）：");
      console.log("     sudo chown -R ubuntu:ubuntu data");
      console.log("   （用户/目录按实际部署改；漏了这行，服务下一个请求就 readonly database）");
    } else {
      console.log("");
      console.log("以上是 --check 的结果：一个字节都没写。确认无误后加 --apply 执行。");
    }

    if (failed) {
      console.log("");
      console.log(
        `❌ 已在第 ${failed.index + 1} 步「${failed.def.name}」停下，后续步骤未执行。` +
          `原始错误：${failed.error?.message ?? failed.error}`
      );
      process.exitCode = 1;
    } else if (fatal > 0) {
      console.log("");
      console.log(`❌ 体检发现 ${fatal} 项严重数据问题，不能上线（见第 9 步）。`);
      process.exitCode = 1;
    }
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  process.exit(process.exitCode ?? 0);
}

main();
