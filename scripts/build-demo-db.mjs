/**
 * 打「整库演示包」scripts/demo-data/pms-demo.db.gz（`npm run db:load-demo` 用）
 *
 * ── 为什么需要这个脚本 ──
 *
 * `npm run db:load-demo` 走的是「解压一个 .db 覆盖过去」的路径，它不像设置页的
 * 「一键导入」那样有机会在导入后跑 SQL 日期滚动 / 均匀补数据。所以整库包一旦
 * 打出来，里面的日期就**锚死在打包那天**：
 *   · 在住单的 expect_check_out 会逐天变成「逾期」
 *   · 均匀补数据的 DEMO 单会一天天变旧，报表某天突然空一片
 * 之前 pms-demo.db.gz 就是这么变旧的（21 张在住全逾期、5 张 nights 不符）。
 *
 * 所以整库包不能手工 gzip 一次就完事，必须有可重复的打包流程：
 *
 *   1. 从当前真库 `VACUUM INTO` 出一致性快照（含已提交的 WAL，不锁库）
 *   2. 在快照里清掉所有「DEMO 前缀单」及其派生行（口径见 demo-data-filter.mjs）
 *   3. 用 `scripts/seed-uniform-demo.mjs` 按**打包当天**重新均匀补一遍
 *      （今天 3 张在住 + 1 张今日预离 + 3 张预抵，历史每天 3 张已退房）
 *   4. 再 `VACUUM INTO` 出一个单文件成品（不带 -wal / -shm），gzip 覆盖旧包
 *   5. 打开成品自检：逾期 0 / nights 不符 0 / 零额押金 0 / ar_ledgers 23
 *      —— 任何一条不过就不写盘，旧包保持原样
 *
 * ── 什么时候重打 ──
 *   · 演示数据有改动（种子 / 订单 / 报表口径变化）之后
 *   · 包放了一段时间、在住单又开始「逾期」的时候（重打即刷新日期锚点）
 *
 * 用法：
 *   node scripts/build-demo-db.mjs                 # 快照 → 清生成单 → 补近 61 天 → 打包
 *   node scripts/build-demo-db.mjs --no-uniform    # 不补均匀数据（只留种子数据）
 *   node scripts/build-demo-db.mjs --keep-tmp      # 保留中间快照，便于排查
 *   PMS_DB_PATH=/path/to/pms.db node scripts/build-demo-db.mjs   # 指定源库
 */
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteDemoResidue, checkDemoMetrics, inspectDemoMetrics, collectDemoIds, demoIdCounts } from "./demo-data-filter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbFile = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");
const outGz = join(here, "demo-data", "pms-demo.db.gz");

const NO_UNIFORM = process.argv.includes("--no-uniform");
const KEEP_TMP = process.argv.includes("--keep-tmp");

if (!existsSync(dbFile)) {
  console.error(`❌ 源库不存在：${dbFile}`);
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const tmpDir = join(root, ".tmp", `demo-db-build-${ts}`);
const snapshot = join(tmpDir, "snapshot.db");
const packed = join(tmpDir, "pms-demo.db");

mkdirSync(tmpDir, { recursive: true });
mkdirSync(join(here, "demo-data"), { recursive: true });

/** VACUUM INTO（目标必须不存在） */
function vacuumInto(db, target) {
  if (existsSync(target)) rmSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

let failed = false;
try {
  /* ─────────── 1. 一致性快照 ─────────── */
  console.log(`源库：${dbFile}`);
  console.log(`模板：${outGz}`);
  {
    const src = new DatabaseSync(dbFile, { readOnly: true });
    vacuumInto(src, snapshot);
    src.close();
  }
  console.log(`\n1) 快照完成：${snapshot}（${kb(statSync(snapshot).size)}）`);

  /* ─────────── 2. 清 DEMO 前缀残留 ─────────── */
  const residue = (() => {
    const db = new DatabaseSync(snapshot);
    try {
      const before = demoIdCounts(collectDemoIds(db));
      const res = deleteDemoResidue(db);
      return { before, ...res };
    } finally {
      db.close();
    }
  })();
  console.log(
    `2) 清生成单：删除 ${residue.total} 行（入住单 ${residue.before.stays} / 预订 ${residue.before.bookings} / ` +
      `账单 ${residue.before.folios} / 流水 ${residue.before.payments}），迭代 ${residue.rounds} 轮`
  );
  for (const [t, n] of Object.entries(residue.removed)) console.log(`     - ${t}: ${n} 行`);

  /* ─────────── 3. 按打包当天重新均匀补数据 ─────────── */
  if (NO_UNIFORM) {
    console.log(`3) 跳过均匀补数据（--no-uniform）`);
  } else {
    const seedScript = join(here, "seed-uniform-demo.mjs");
    const run = spawnSync(process.execPath, [seedScript, "--days", "60"], {
      cwd: root,
      env: { ...process.env, PMS_DB_PATH: snapshot },
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
    });
    if (run.status !== 0) {
      console.error(`3) ❌ 均匀补数据失败（退出码 ${run.status}）`);
      console.error((run.stdout ?? "").trim());
      console.error((run.stderr ?? "").trim());
      throw new Error("seed-uniform-demo 失败，已中止打包（旧包未改动）");
    }
    const lines = (run.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /今天|覆盖|房态自愈|跳过|新增|自洽校验/.test(s));
    console.log(`3) 均匀补数据完成（按 ${new Date().toISOString().slice(0, 10)} 为锚）：`);
    for (const line of lines) console.log(`     ${line}`);
  }

  /* ─────────── 4. 单文件成品 + gzip ─────────── */
  {
    const db = new DatabaseSync(snapshot);
    vacuumInto(db, packed);
    db.close();
  }

  /* 成品自检：不过就不覆盖旧包 */
  const db = new DatabaseSync(packed, { readOnly: true });
  let metrics;
  let integrity;
  try {
    integrity = String(db.prepare("PRAGMA integrity_check").get().integrity_check ?? "");
    metrics = inspectDemoMetrics(db);
  } finally {
    db.close();
  }

  const checks = checkDemoMetrics(metrics);
  console.log(`\n4) 成品自检（${packed}，${kb(statSync(packed).size)}）`);
  console.log(`   integrity_check：${integrity}`);
  console.log(
    `   表 ${metrics.tables} 张 · 房 ${metrics.rooms} 间 · 预订 ${metrics.bookings} 条 · 入住单 ${metrics.stays} 张 · ` +
      `账单 ${metrics.folios} 张 · 流水 ${metrics.payments} 条 · 客人 ${metrics.guests} 个`
  );
  console.log(
    `   在住 ${metrics.inhouse} 张（今日应退 ${metrics.dueToday} / 未到期 ${metrics.future}）· ` +
      `生成单：入住单 ${metrics.demo.stays} / 预订 ${metrics.demo.bookings} / 账单 ${metrics.demo.folios} / 流水 ${metrics.demo.payments}`
  );
  for (const c of checks) {
    console.log(`   ${c.ok ? "✅" : "❌"} ${c.name}：${c.value} ${c.unit}（要求 ${c.expect}）`);
  }
  if (integrity !== "ok") {
    console.error(`   ❌ integrity_check 不是 ok，中止打包`);
    failed = true;
  }
  if (checks.some((c) => !c.ok)) {
    console.error(`   ❌ 自检未通过，中止打包（旧包保持原样）`);
    failed = true;
  }

  if (!failed) {
    /* ─────────── 5. 写盘 ─────────── */
    const buf = readFileSync(packed);
    const gz = gzipSync(buf, { level: 9 });
    writeFileSync(outGz, gz);
    console.log(`\n5) 已写入：${outGz}`);
    console.log(
      `   解压后 ${kb(buf.length)}，gzip 后 ${kb(gz.length)}（原包大小以 git 记录为准；` +
        `load-demo.mjs 解压后覆盖 data/pms.db）`
    );
  }
} finally {
  if (!KEEP_TMP) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用，留个目录不影响 */
    }
  } else {
    console.log(`\n（--keep-tmp）中间文件保留在：${tmpDir}`);
  }
}

if (failed) process.exit(1);
