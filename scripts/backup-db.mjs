/**
 * 数据库备份（在线快照 + 自校验 + 保留策略）
 *
 * ── 为什么必须是 VACUUM INTO，而不是 cp ──
 *
 * 本项目跑在 WAL 模式（src/lib/db.ts: PRAGMA journal_mode = WAL）。WAL 模式下
 * **最近的写入还在 pms.db-wal 里，没合并进 pms.db**。所以：
 *
 *   cp data/pms.db 备份文件        → 丢最新写入（可能只差几秒，也可能是几千条）
 *   sqlite3 .backup 备份文件        → 需要 sqlite3 CLI（补丁机不一定装）
 *   VACUUM INTO 备份文件            → 通过连接读逻辑内容，WAL 里的也读得到，且顺带整理碎片
 *
 * VACUUM INTO 还有两个好处：
 *   1. 输出是一个**干净的单文件库**（无 -wal/-shm），恢复时不会有两份状态打架；
 *   2. 生成过程中对源库是读事务，**不需要停服务**，也不会阻塞正常业务写入。
 *
 * ── 保留策略为什么只删自己生成的 ──
 *
 * data/backup 目录里混着两类文件：
 *   · pms.<YYYY-MM-DDTHH-mm-ss>.db          ← 本脚本生成，纳入保留策略
 *   · pms.before-xxx.<ts>.db / pms.db.bak-*  ← 各修复脚本的一次性快照，**永不自动删**
 *
 * 后者是「某次危险操作之前」的证据，时间点和保留策略无关，删错了就再也找不回来。
 * 所以清理只匹配严格的文件名正则，其它文件只在报告里提示「有几份历史快照，请手动管理」。
 *
 * ── 幂等：内容没变就不生成新文件 ──
 *
 * 定时备份（cron）每天跑一次，但一天里大部分时间库是没变的。若每次都生成新文件，
 * 保留 10 份 = 10 份一模一样的副本，毫无意义。所以：
 *   先 VACUUM INTO 到临时文件 → 算 sha256 → 与 latest.json 里上一份的 sha256 比
 *   · 相同 → 删临时文件，报「无需备份（内容与上一份一致）」，退出码 0
 *   · 不同 → 改名成正式文件，写 latest.json
 * `--force` 可绕过这个判断（想要一份「时间戳是现在」的副本时用）。
 *
 * 用法：
 *   node scripts/backup-db.mjs                     # 备份一次
 *   node scripts/backup-db.mjs --dry-run           # 只看会做什么，零副作用
 *   node scripts/backup-db.mjs --keep 20           # 保留最近 20 份
 *   node scripts/backup-db.mjs --force             # 内容没变也强制生成
 *   node scripts/backup-db.mjs --json              # 机器可读输出（给 cron/监控吃）
 *   node scripts/backup-db.mjs --db /tmp/x/pms.db --backup-dir /tmp/x/backup
 *
 * 退出码：
 *   0 = 成功（含「无需备份」）
 *   2 = 源库不存在
 *   3 = 源库打不开 / 不是 SQLite 库
 *   4 = 备份生成了但校验不通过（**这份备份不可信，不要拿它恢复**）
 */

import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/*
 * 压掉 node:sqlite 的 ExperimentalWarning。
 *
 * `node:sqlite` 在 Node 22/24 上仍标 experimental，每次 require 都会往 stderr 打一行：
 *   (node:1234) ExperimentalWarning: SQLite is an experimental feature ...
 * 备份脚本会被 cron 调用，这行噪声会跟着邮件/日志到处跑，而且它掩盖不了任何真实问题。
 * 只过滤 ExperimentalWarning，其它 warning 照常打印。
 */
const defaultWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w?.name !== "ExperimentalWarning") {
    if (defaultWarningListeners.length > 0) for (const l of defaultWarningListeners) l(w);
    else console.warn(w);
  }
});

/* ════════════════════════════════════════════════════════════ 参数 */

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const optVal = (name, dflt) => {
  const i = argv.indexOf(name);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : dflt;
};

const DRY_RUN = has("--dry-run");
const FORCE = has("--force");
const JSON_OUT = has("--json");
const QUIET = has("--quiet");

const KEEP = (() => {
  const raw = Number(optVal("--keep", process.env.PMS_BACKUP_KEEP ?? 10));
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
})();

const DB_PATH = path.resolve(
  optVal("--db", process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db"))
);
const BACKUP_DIR = path.resolve(
  optVal("--backup-dir", process.env.PMS_BACKUP_DIR ?? path.join(process.cwd(), "data", "backup"))
);
const LATEST_JSON = path.join(BACKUP_DIR, "latest.json");

/**
 * 备份文件命名：pms.<YYYY-MM-DDTHH-mm-ss>.db
 *
 * 用本地时间而不是 UTC：文件名是给人看的，「下午 2 点的备份」比「06-00 的备份」
 * 在 VPS 上（UTC 时区）对照 journalctl 时间戳时不容易搞混。需要精确 UTC 时看 latest.json。
 */
const BACKUP_NAME_RE = /^pms\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$/;

/**
 * 恢复时必须存在的表。
 *
 * 只放「没有它就不是这个系统」的核心表 —— 房、人、单、账、客史。
 * 不放 shop_* / channel_* 这类可选模块表：老备份里可能还没有它们，
 * 但那不影响「这是一个能用的 PMS 库」这个判断（缺的让 migrate-all 补）。
 */
const REQUIRED_TABLES = ["users", "rooms", "stays", "folios", "folio_items", "payments", "guests", "bookings"];

/**
 * 用于指纹/健康度的行数统计表。
 *
 * 比 REQUIRED_TABLES 多几个：它们不影响「库是否可用」，但**行数掉了一半**
 * 是「备份截断了 / 恢复了老版本」的强信号，所以纳入指纹对比。
 */
const COUNT_TABLES = [
  ...REQUIRED_TABLES,
  "room_types",
  "booking_rooms",
  "members",
  "ar_accounts",
  "housekeeping_tasks",
  "op_logs",
];

/* ════════════════════════════════════════════════════════════ 工具 */

const pad = (n) => String(n).padStart(2, "0");

/** 本地时间戳 → 2026-11-23T14-30-00（文件名安全，无冒号） */
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

/** 本地时间戳 → ISO 8601 带时区偏移（latest.json 里给人看） */
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`
  );
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 流式 sha256（备份可能有几百 MB，不整个读进内存） */
function sha256File(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** SQL 字符串字面量转义（Windows 路径里的反斜杠不用动，单引号要翻倍） */
function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 读一个库文件的完整指纹。
 *
 * 备份前对源库跑一次、备份后对产物跑一次，两边能对比 —— 这样「备份成功」
 * 就不是靠 VACUUM INTO 没抛异常来假设，而是拿证据说话。
 */
function inspect(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    // PRAGMA integrity_check 正常返回单行 'ok'；损坏时返回多行问题描述
    const integrity = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((r) => String(Object.values(r)[0]));

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all()
      .map((r) => String(r.name));

    const indexCount = Number(
      db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index'`).get()?.c ?? 0
    );

    // 本项目目前没有任何 FOREIGN KEY 声明（rebuild-unique-constraints.mjs 的注释也确认过），
    // 所以这里预期恒为 0 行；一旦非 0 说明有人加了外键约束或数据被外部工具改过，值得报警。
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();

    const counts = {};
    for (const t of COUNT_TABLES) {
      counts[t] = tables.includes(t) ? Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get()?.c ?? 0) : null;
    }

    const sqliteVersion = String(db.prepare("SELECT sqlite_version() AS v").get()?.v ?? "?");

    return {
      ok: integrity.length === 1 && integrity[0] === "ok",
      integrity,
      tables,
      tableCount: tables.length,
      indexCount,
      counts,
      foreignKeyViolations: foreignKeyViolations.length,
      sqliteVersion,
      sizeBytes: statSync(dbFile).size,
      sha256: sha256File(dbFile),
    };
  } finally {
    db.close();
  }
}

/** 备份目录里符合命名规范的备份，按时间倒序（字典序 == 时间序） */
function listManagedBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(full).size;
      } catch {
        /* 并发删除，忽略 */
      }
      return { name: f, path: full, sizeBytes };
    });
}

/** 备份目录里**不**归本脚本管的文件（历史快照），只统计不删除 */
function listForeignBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR).filter((f) => {
    if (!f.endsWith(".db")) return false;
    if (BACKUP_NAME_RE.test(f)) return false;
    if (f === "latest.json") return false;
    return true;
  });
}

function readLatest() {
  if (!existsSync(LATEST_JSON)) return null;
  try {
    return JSON.parse(readFileSync(LATEST_JSON, "utf8"));
  } catch {
    // latest.json 被写坏了不该让备份失败 —— 没有它只是判断不了「内容是否变化」
    return null;
  }
}

const out = (s = "") => {
  if (!QUIET && !JSON_OUT) console.log(s);
};

/* ════════════════════════════════════════════════════════════ 1. 前置检查 */

const startedAt = Date.now();

if (!existsSync(DB_PATH)) {
  console.error(`[失败] 数据库不存在：${DB_PATH}`);
  process.exit(2);
}

let src;
try {
  // 源库只读打开：备份不该、也不需要写源库。
  // 用只读还能保证「备份脚本本身永远不会损坏生产库」——这是安全边界，不是性能优化。
  src = inspect(DB_PATH);
} catch (e) {
  console.error(`[失败] 数据库打不开（不是 SQLite 库 / 权限不足）：${DB_PATH}`);
  console.error(`       ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}

const missingTables = REQUIRED_TABLES.filter((t) => !src.tables.includes(t));
const srcWarnings = [];
if (!src.ok) {
  srcWarnings.push(`源库 integrity_check 未通过：${src.integrity.slice(0, 3).join(" | ")}`);
}
if (missingTables.length > 0) {
  srcWarnings.push(`源库缺少核心表：${missingTables.join(", ")}（可能是全新空库，先跑 migrate-all）`);
}
if (src.foreignKeyViolations > 0) {
  srcWarnings.push(`源库有 ${src.foreignKeyViolations} 处外键悬空`);
}

out(`数据库：${DB_PATH}`);
out(
  `源库：${src.tableCount} 张表 / ${humanSize(src.sizeBytes)} / integrity ${src.ok ? "ok" : "FAILED"}` +
    ` / sqlite ${src.sqliteVersion}`
);
out(
  `行数：` +
    COUNT_TABLES.filter((t) => src.counts[t] !== null)
      .map((t) => `${t}=${src.counts[t]}`)
      .join("  ")
);
for (const w of srcWarnings) out(`[警告] ${w}`);

/* ════════════════════════════════════════════════════════════ 2. --dry-run：只出计划 */

if (DRY_RUN) {
  const target = path.join(BACKUP_DIR, `pms.${stamp()}.db`);
  const managed = listManagedBackups();
  // dry-run 下不生成文件，所以「删哪几份」只能按"假设新增一份后"来算
  const wouldKeep = [target, ...managed.map((m) => m.path)].slice(0, KEEP);
  const wouldDelete = managed.filter((m) => !wouldKeep.includes(m.path));
  const foreign = listForeignBackups();
  const latest = readLatest();

  out("");
  out("── dry-run（不写任何文件、不删任何文件）──");
  out(`  将生成：${target}`);
  out(`  保留策略：最近 ${KEEP} 份，当前已有 ${managed.length} 份`);
  if (wouldDelete.length > 0) {
    out(`  将删除 ${wouldDelete.length} 份：${wouldDelete.map((d) => d.name).join(", ")}`);
  } else {
    out(`  将删除 0 份（新增后共 ${wouldKeep.length} 份，未超过 ${KEEP}）`);
  }
  out(`  将写入：${LATEST_JSON}`);
  if (latest) {
    out(`  上一份：${latest.file ?? "?"}（${latest.generatedAt ?? "?"}，sha256 ${String(latest.sha256 ?? "").slice(0, 12)}…）`);
    out(`  提示：内容若无变化，正式跑会报「无需备份」而不是生成新文件（--force 可强制生成）`);
  } else {
    out(`  上一份：无（首次备份）`);
  }
  if (foreign.length > 0) {
    out(`  另有 ${foreign.length} 份历史快照（非本脚本生成，不纳入保留策略，也不会被删）`);
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          db: DB_PATH,
          backupDir: BACKUP_DIR,
          target,
          keep: KEEP,
          existing: managed.length,
          wouldDelete: wouldDelete.map((d) => d.name),
          source: { tableCount: src.tableCount, sizeBytes: src.sizeBytes, ok: src.ok, counts: src.counts },
          warnings: srcWarnings,
        },
        null,
        2
      )
    );
  }
  // dry-run 的退出码：源库健康就是 0。
  // 源库不健康也返回 0 会让 cron 误以为一切正常，所以这里只在「库都打不开」时非 0（已在上方 exit 3）。
  process.exit(0);
}

/* ════════════════════════════════════════════════════════════ 3. 生成快照（先落临时文件） */

mkdirSync(BACKUP_DIR, { recursive: true });

// 临时文件名带 pid：同一个 backup 目录被两个进程同时跑（cron + 手工）时不会互相覆盖
const tmpFile = path.join(BACKUP_DIR, `.tmp-${process.pid}-${Date.now()}.db`);

const vacuumTo = (from, to) => {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    /*
     * busy_timeout：如果此刻恰好有业务在写（WAL 模式下写锁是短暂的），
     * 让 VACUUM 等一下而不是立刻抛 SQLITE_BUSY。10 秒与 migrate-all 的口径一致。
     */
    try {
      db.exec("PRAGMA busy_timeout = 10000");
    } catch {
      /* 极老的 sqlite 不认这个 pragma，忽略 */
    }
    db.exec(`VACUUM INTO ${sqlStr(to)}`);
  } finally {
    db.close();
  }
};

let elapsedMs = 0;
try {
  const t0 = Date.now();
  vacuumTo(DB_PATH, tmpFile);
  elapsedMs = Date.now() - t0;
} catch (e) {
  try {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
  console.error(`[失败] VACUUM INTO 失败：${e instanceof Error ? e.message : String(e)}`);
  console.error(`       常见原因：磁盘满（df -h）、目标目录无权写、源库被长时间独占`);
  process.exit(3);
}

if (!existsSync(tmpFile) || statSync(tmpFile).size === 0) {
  try {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
  console.error(`[失败] VACUUM INTO 未产出有效文件（0 字节）`);
  process.exit(3);
}

const tmpSha = sha256File(tmpFile);
const latest = readLatest();

/* ════════════════════════════════════════════════════════════ 4. 内容没变就不生成新文件 */

if (!FORCE && latest && latest.sha256 === tmpSha && latest.file && existsSync(path.join(BACKUP_DIR, latest.file))) {
  const prev = path.join(BACKUP_DIR, latest.file);
  unlinkSync(tmpFile);
  out("");
  out(`✅ 无需备份：内容与上一份完全一致（sha256 ${tmpSha.slice(0, 16)}…）`);
  out(`   上一份：${latest.file}（${latest.generatedAt ?? "?"}）`);
  out(`   需要一份新时间戳的副本时加 --force`);
  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          mode: "skipped",
          reason: "unchanged",
          db: DB_PATH,
          file: latest.file,
          path: prev,
          sha256: tmpSha,
          generatedAt: latest.generatedAt,
          tableCount: src.tableCount,
          counts: src.counts,
          durationMs: Date.now() - startedAt,
        },
        null,
        2
      )
    );
  }
  process.exit(0);
}

/* ════════════════════════════════════════════════════════════ 5. 定名 + 校验产物 */

const stampStr = stamp();
let finalName = `pms.${stampStr}.db`;
let finalPath = path.join(BACKUP_DIR, finalName);

// 同一秒内跑两次（脚本循环 / 测试）会撞名：加 -2/-3 后缀，绝不覆盖已有备份
if (existsSync(finalPath)) {
  let n = 2;
  while (existsSync(path.join(BACKUP_DIR, `pms.${stampStr}-${n}.db`)) && n < 100) n++;
  finalName = `pms.${stampStr}-${n}.db`;
  finalPath = path.join(BACKUP_DIR, finalName);
}

renameSync(tmpFile, finalPath);

let verified;
try {
  verified = inspect(finalPath);
} catch (e) {
  console.error(`[失败] 备份已生成但打不开（${finalName}）：${e instanceof Error ? e.message : String(e)}`);
  process.exit(4);
}

/* ── 校验项：任何一项不过，这份备份就不能算「可用」 ── */
const failures = [];
if (!verified.ok) failures.push(`integrity_check 未通过：${verified.integrity.slice(0, 3).join(" | ")}`);
if (verified.tableCount !== src.tableCount) {
  failures.push(`表数不一致：源库 ${src.tableCount} → 备份 ${verified.tableCount}`);
}
const missingInBackup = REQUIRED_TABLES.filter((t) => !verified.tables.includes(t));
if (missingInBackup.length > 0) failures.push(`备份缺少核心表：${missingInBackup.join(", ")}`);
// 行数逐个对：VACUUM INTO 是快照读，备份与源库的行数必须完全一致；
// 除非备份期间正好有业务写入（此时源库的计数是「读之前」的，允许备份行数 >= 源库）
for (const t of COUNT_TABLES) {
  const a = src.counts[t];
  const b = verified.counts[t];
  if (a === null || b === null) continue;
  if (b < a) failures.push(`${t} 行数变少：源库 ${a} → 备份 ${b}（快照被截断？）`);
}
if (verified.foreignKeyViolations > 0) {
  // 外键悬空不阻断（本项目无外键声明，真出现说明数据本身有问题，源库同样会有）
  failures.push(`外键悬空 ${verified.foreignKeyViolations} 处（与源库一致则属既有数据问题）`);
}

if (failures.length > 0) {
  console.error(`\n[失败] 备份产物校验不通过：${finalPath}`);
  for (const f of failures) console.error(`       ✗ ${f}`);
  console.error(`       **这份备份不可信，不要拿它做恢复演练/恢复生产**。`);
  process.exit(4);
}

/* ════════════════════════════════════════════════════════════ 6. latest.json */

const latestPayload = {
  generatedAt: isoLocal(),
  generatedAtUtc: new Date().toISOString(),
  file: finalName,
  path: finalPath,
  sizeBytes: verified.sizeBytes,
  sizeHuman: humanSize(verified.sizeBytes),
  sha256: verified.sha256,
  tableCount: verified.tableCount,
  indexCount: verified.indexCount,
  counts: verified.counts,
  integrity: verified.ok ? "ok" : verified.integrity.join(" | "),
  foreignKeyViolations: verified.foreignKeyViolations,
  sqliteVersion: verified.sqliteVersion,
  source: { path: DB_PATH, tableCount: src.tableCount, sizeBytes: src.sizeBytes },
  keep: KEEP,
  durationMs: elapsedMs,
  node: process.version,
  warnings: srcWarnings,
};
writeFileSync(LATEST_JSON, JSON.stringify(latestPayload, null, 2) + "\n", "utf8");

/* ════════════════════════════════════════════════════════════ 7. 保留策略 */

const managed = listManagedBackups();
const keepSet = new Set(managed.slice(0, KEEP).map((m) => m.path));
const removed = [];
const removeFailed = [];
for (const m of managed.slice(KEEP)) {
  if (keepSet.has(m.path)) continue;
  try {
    unlinkSync(m.path);
    removed.push(m.name);
  } catch (e) {
    removeFailed.push(`${m.name}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/* ════════════════════════════════════════════════════════════ 8. 输出 */

const foreign = listForeignBackups();
const totalBytes = listManagedBackups().reduce((s, m) => s + m.sizeBytes, 0);

out("");
out(`✅ 备份完成：${finalPath}`);
out(`   大小      ${humanSize(verified.sizeBytes)}（${verified.sizeBytes} 字节），VACUUM 耗时 ${elapsedMs}ms`);
out(`   sha256    ${verified.sha256}`);
out(`   表数      ${verified.tableCount}（与源库 ${src.tableCount} 一致）`);
out(
  `   关键行数  ` +
    COUNT_TABLES.filter((t) => verified.counts[t] !== null)
      .map((t) => `${t}=${verified.counts[t]}`)
      .join("  ")
);
out(`   完整性    integrity_check = ok，外键悬空 ${verified.foreignKeyViolations} 处`);
out(`   清单      ${LATEST_JSON}`);
out(`   保留      ${managed.length - removed.length} 份 / 上限 ${KEEP}（占用 ${humanSize(totalBytes)}）`);
if (removed.length > 0) out(`   已清理    ${removed.join(", ")}`);
if (removeFailed.length > 0) out(`   [警告] 清理失败：${removeFailed.join(", ")}`);
if (foreign.length > 0) {
  out(`   另有 ${foreign.length} 份历史快照（非本脚本生成，永不自动删除；用不着时手动清）`);
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        mode: "created",
        ...latestPayload,
        removed,
        removeFailed,
        foreignCount: foreign.length,
      },
      null,
      2
    )
  );
}
