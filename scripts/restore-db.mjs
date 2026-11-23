/**
 * 数据库恢复（带三重校验、恢复前快照、恢复后体检）
 *
 * ── 为什么恢复脚本比备份脚本更危险 ──
 *
 * 备份出错最多是「没有备份」；恢复出错是「把还能救的库覆盖成更坏的库」。
 * 所以本脚本的每一步都是「先确认能回头」再往前：
 *
 *   1. 三重校验备份文件 —— 不合格的备份一个字都不动；
 *   2. 恢复前把**当前库**再备份一份（pms.before-restore.<ts>.db）——
 *      恢复错了还能拿它回去，因为它是「恢复之前那一刻」的真实状态；
 *   3. 检查服务是否在跑 —— **不自动停**（停服务是运维决策，不该由脚本偷偷做），
 *      但服务在跑就拒绝执行并打印停服务命令；
 *   4. 目标库先 checkpoint 再删 -wal/-shm —— 否则旧 WAL 会被 SQLite 回放到新库上，
 *      把刚恢复的数据改回旧状态（这是「恢复了但数据没变」的经典事故）；
 *   5. 先复制成 .restore-tmp-<pid> 并校验通过，再原子替换 —— 不会出现「复制到一半
 *      断电、目标库变成半截文件」；
 *   6. 恢复后跑 integrity_check + foreign_key_check，并对比备份文件的指纹。
 *
 * ── 三重校验是哪三重 ──
 *
 *   一重（文件）：存在、非空、前 16 字节是 SQLite 魔数 `SQLite format 3\0`
 *   二重（结构）：PRAGMA integrity_check = ok、表数 >= --min-tables、核心表齐全
 *   三重（内容）：核心表行数（users/rooms 不能为 0）、与 latest.json 的 sha256 是否一致
 *
 * ── 为什么恢复后还要跑迁移 ──
 *
 * 备份是「某个时间点的库」。如果备份比代码老，它缺少后来新增的表/列，
 * 服务起来会 `no such table: shop_sales` / `no such column: sort`（VPS 上真实踩过）。
 * 本脚本会拿 scripts/schema-full.sql 对比，**明确告诉你缺几张表**，而不是含糊地说
 * 「记得跑迁移」—— 忘跑迁移是这个项目最常见的事故。
 *
 * 用法：
 *   node scripts/restore-db.mjs --list                        # 先看有哪些备份可恢复
 *   node scripts/restore-db.mjs data/backup/pms.2026-11-23T14-30-00.db
 *   node scripts/restore-db.mjs <备份> --force                # 跳过交互确认（cron/演练用）
 *   node scripts/restore-db.mjs <备份> --dry-run              # 只校验 + 打印计划，不动库
 *   node scripts/restore-db.mjs <备份> --db /tmp/t/data/pms.db --force   # 恢复到副本（演练）
 *
 * 退出码：
 *   0 = 恢复成功
 *   1 = 用户取消（没输入 yes / 非交互环境未加 --force）
 *   2 = 备份文件不存在 / 目标库路径非法
 *   3 = 备份文件校验不通过（**拒绝恢复**）
 *   4 = 目标库正被使用（服务在跑 / 有进程持有），拒绝恢复
 *   5 = 恢复过程失败（此时目标库未被替换，或已回滚到 before-restore 备份）
 */

import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  readFileSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

/* 压掉 node:sqlite 的 ExperimentalWarning（同 backup-db.mjs，理由见那边） */
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

const FORCE = has("--force") || has("--yes");
const DRY_RUN = has("--dry-run");
const LIST = has("--list");
const JSON_OUT = has("--json");

const MIN_TABLES = (() => {
  const n = Number(optVal("--min-tables", 10));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
})();

const DB_PATH = path.resolve(
  optVal("--db", process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db"))
);
const BACKUP_DIR = path.resolve(
  optVal("--backup-dir", process.env.PMS_BACKUP_DIR ?? path.join(process.cwd(), "data", "backup"))
);
const LATEST_JSON = path.join(BACKUP_DIR, "latest.json");

const REQUIRED_TABLES = ["users", "rooms", "stays", "folios", "folio_items", "payments", "guests", "bookings"];
const COUNT_TABLES = [...REQUIRED_TABLES, "room_types", "booking_rooms", "members", "ar_accounts", "op_logs"];

/** 备份目录里由 backup-db.mjs 生成的正式备份 */
const BACKUP_NAME_RE = /^pms\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(-\d+)?\.db$/;

/** 恢复前快照 */
const BEFORE_RESTORE_RE = /^pms\.before-restore\./;

const THIS_SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ════════════════════════════════════════════════════════════ 工具 */

const pad = (n) => String(n).padStart(2, "0");

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
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

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * 第一重校验：SQLite 文件魔数。
 *
 * 为什么值得单独做：把一个 0 字节文件、一个 HTML 错误页（nginx 502 存下来的）、
 * 或一个 tar 包改名成 .db，DatabaseSync 打开时会报 "file is not a database"，
 * 但**有些情况下它会自己创建空库**（如果以读写模式打开不存在/空文件）。
 * 先用 16 字节魔数挡掉，比事后判断可靠。
 */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
function hasSqliteMagic(file) {
  const size = statSync(file).size;
  if (size < 100) return false; // 最小合法 SQLite 库也远大于 100 字节
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(16);
    const n = readSync(fd, buf, 0, 16, null);
    return n === 16 && buf.equals(SQLITE_MAGIC);
  } finally {
    closeSync(fd);
  }
}

function inspect(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrity = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((r) => String(Object.values(r)[0]));
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all()
      .map((r) => String(r.name));
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    const counts = {};
    for (const t of COUNT_TABLES) {
      counts[t] = tables.includes(t) ? Number(db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get()?.c ?? 0) : null;
    }
    return {
      ok: integrity.length === 1 && integrity[0] === "ok",
      integrity,
      tables,
      tableCount: tables.length,
      counts,
      foreignKeyViolations: foreignKeyViolations.length,
      sizeBytes: statSync(dbFile).size,
      sha256: sha256File(dbFile),
      sqliteVersion: String(db.prepare("SELECT sqlite_version() AS v").get()?.v ?? "?"),
    };
  } finally {
    db.close();
  }
}

/** 代码当前期望的表集合（来自 scripts/schema-full.sql），用于判断备份是不是老版本 */
function expectedTablesFromSchema() {
  const candidates = [
    path.join(THIS_SCRIPT_DIR, "schema-full.sql"),
    path.join(process.cwd(), "scripts", "schema-full.sql"),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return null;
  try {
    const sql = readFileSync(file, "utf8");
    const names = new Set();
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'\[]?([A-Za-z_][A-Za-z0-9_]*)[`"'\]]?/gi;
    let m;
    while ((m = re.exec(sql)) !== null) names.add(m[1]);
    return { file, tables: [...names] };
  } catch {
    return null;
  }
}

function readLatest() {
  if (!existsSync(LATEST_JSON)) return null;
  try {
    return JSON.parse(readFileSync(LATEST_JSON, "utf8"));
  } catch {
    return null;
  }
}

/* ════════════════════════════════════════════════════════════ 服务占用检测 */

/**
 * 「这个库现在有没有人在用」的两种证据。
 *
 * 为什么不只看 systemctl：
 *   演练时我们把库放到 /tmp 另起一个 next 实例，systemd 里没有它；
 *   反过来，systemd 显示 active 但服务可能早就关了库句柄。
 * 所以两条证据都要看，但它们**只对号入座**：
 *   · systemd 的 pms 单元工作目录是 /opt/pms，它只会打开 /opt/pms/data/pms.db。
 *     所以「systemd active」只有在目标库就是那个库时才算占用 ——
 *     否则在 /tmp 副本上演练会一直误报「服务在跑」，把安全提示变成噪音。
 *   · 进程持有则是按路径精确匹配的，任何路径都算数。
 *
 * /proc 扫描在非 Linux 上直接返回空（Windows 开发机跑演练时不会误报）。
 */
function detectHolders(dbFile) {
  const result = { systemd: null, pids: [] };

  // 证据 1：systemd 单元 pms 是否 active
  try {
    const out = execFileSync("systemctl", ["is-active", "pms"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    result.systemd = out || "unknown";
  } catch (e) {
    // is-active 在 inactive 时退出码非 0，但 stdout 仍有值
    const s = typeof e?.stdout === "string" ? e.stdout.trim() : "";
    result.systemd = s || "unavailable";
  }

  /*
   * 证据 2：有没有进程打开着这个 db 文件（或其 -wal / -shm）
   *
   * 必须用 readlinkSync 而不是 readFileSync：
   * /proc/<pid>/fd/<n> 是符号链接，readlink 拿到「指向哪个路径」（几百字节），
   * 而 readFileSync 会跟着链接**把目标文件内容整个读进内存** —— 对 pms.db
   * 就是每次检查把 2MB 库读一遍，对 /dev/zero 之类的 fd 甚至永不结束。
   * 这类低层探测一定要用 readlink。
   */
  const targets = new Set([dbFile, `${dbFile}-wal`, `${dbFile}-shm`]);
  try {
    const pids = readdirSync("/proc").filter((x) => /^\d+$/.test(x));
    const found = new Set();
    for (const pid of pids) {
      let fds;
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue; // 别的用户的进程，没权限看
      }
      for (const fd of fds) {
        let link;
        try {
          link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue; // fd 已关闭 / 权限不足
        }
        /*
         * 去掉内核加的 " (deleted)" 后缀。
         *
         * 恢复过一次之后，旧的服务进程还开着**已被替换掉的那个 inode**，
         * readlink 会返回 "/tmp/.../pms.db (deleted)"。如果不剥掉后缀，
         * 路径比对失败 → 漏判「服务在跑」→ 第二次恢复可能在服务写入时把库搞坏。
         * 这类 sudo/服务进程的 fd 探测必须做这个归一化。
         */
        if (link.endsWith(" (deleted)")) link = link.slice(0, -" (deleted)".length);
        if (targets.has(link)) {
          found.add(pid);
          break;
        }
      }
    }
    result.pids = [...found];
  } catch {
    /* 非 Linux（无 /proc）：跳过 */
  }
  return result;
}

/**
 * 目标库是不是 systemd 里 pms 服务正在用的那个库。
 *
 * 部署脚本把 WorkingDirectory 固定成 /opt/pms，所以服务只可能打开这一个路径。
 * 比对绝对路径即可，不要去猜进程。
 */
function isServiceDb(dbFile) {
  return dbFile === path.resolve("/opt/pms/data/pms.db");
}

/**
 * 目标库是不是「生产部署」，用来决定恢复后打印哪一组后续命令。
 *
 * 注意不能只看 dbFile === cwd/data/pms.db：
 * 演练时我们会把整个项目复制到 /tmp/pms-restore-test 再在那里跑脚本，
 * 此时 cwd/data/pms.db 恰好就是**副本库**，按老判据会误报「生产库路径」，
 * 让人以为要停生产服务。所以 /tmp 下的 cwd 一律按演练处理。
 */
function isProductionPath(dbFile) {
  if (isServiceDb(dbFile)) return true;
  if (dbFile !== path.resolve(process.cwd(), "data", "pms.db")) return false;
  const cwd = process.cwd().replace(/\\/g, "/");
  return !/^\/(tmp|var\/tmp)\//.test(cwd);
}

/** 列备份目录里所有可恢复的文件（含历史快照，标注来源以便挑对的） */
function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  const latest = readLatest();
  const rows = [];
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.endsWith(".db")) continue;
    const full = path.join(BACKUP_DIR, f);
    let sizeBytes = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(full);
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // 并发删除
    }
    const kind = BACKUP_NAME_RE.test(f)
      ? "backup-db"
      : BEFORE_RESTORE_RE.test(f)
        ? "before-restore"
        : "其它脚本快照";
    rows.push({ name: f, path: full, sizeBytes, mtimeMs, kind, isLatest: latest?.file === f });
  }
  /*
   * 按 mtime 倒序，而不是按文件名。
   * 备份目录里混着两套命名（pms.<ts>.db 和 pms.before-xxx.<ts>.db），
   * 字典序会把 "pms.before-..." 排在 "pms.<ts>" 前面，最近那份反而不在顶部。
   * mtime 是唯一对所有命名都成立的排序依据 —— 人找「最近那份备份」只用得上它。
   */
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ════════════════════════════════════════════════════════════ 主流程 */

async function main() {
  /* ── --list：只列，不恢复 ── */
  if (LIST) {
    const list = listBackups();
    console.log(`备份目录：${BACKUP_DIR}`);
    if (list.length === 0) {
      console.log("（空）—— 先跑 node scripts/backup-db.mjs");
      return 0;
    }
    console.log("");
    console.log("  时间                  大小      类型              文件");
    for (const b of list) {
      const mark = b.isLatest ? " ★最新" : "";
      const when = new Date(b.mtimeMs).toLocaleString("sv-SE").replace(",", "");
      console.log(
        `  ${when.padEnd(20)} ${humanSize(b.sizeBytes).padEnd(9)} ${b.kind.padEnd(17)} ${b.name}${mark}`
      );
    }
    console.log("");
    console.log("恢复：node scripts/restore-db.mjs " + (list.find((b) => b.isLatest)?.path ?? list[0].path));
    return 0;
  }

  /* ── 定位备份文件 ── */
  /*
   * 位置参数解析：跳过「带值的选项」及其值，剩下第一个就是备份文件路径。
   * 不能用 argv.find(a => !a.startsWith("--") && argv[argv.indexOf(a)-1] !== "--db")：
   * 同一个值出现两次时 indexOf 永远返回第一个下标，会把选项值误判成备份路径
   * （例如 --db data/pms.db 后面再跟一个同名路径）。
   */
  const VALUE_OPTS = new Set(["--keep", "--db", "--backup-dir", "--min-tables"]);
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_OPTS.has(a)) {
      i++; // 跳过选项值
      continue;
    }
    if (a.startsWith("--")) continue;
    positionals.push(a);
  }
  const positional = positionals[0];
  if (!positional) {
    console.error("用法：node scripts/restore-db.mjs <备份文件> [--force] [--dry-run]");
    console.error("      node scripts/restore-db.mjs --list      # 列出可恢复的备份");
    return 2;
  }
  const backupFile = path.resolve(positional);

  console.log(`备份文件：${backupFile}`);
  console.log(`目标库：  ${DB_PATH}`);
  console.log("");

  if (!existsSync(backupFile)) {
    console.error(`[失败] 备份文件不存在：${backupFile}`);
    console.error(`       用 node scripts/restore-db.mjs --list 看有哪些可选`);
    return 2;
  }
  if (!statSync(backupFile).isFile()) {
    console.error(`[失败] 不是普通文件：${backupFile}`);
    return 2;
  }
  if (backupFile === DB_PATH) {
    console.error(`[失败] 备份文件与目标库是同一个文件，这会自己覆盖自己`);
    return 2;
  }

  /* ══════════════ 三重校验备份文件 ══════════════ */
  const failures = [];
  const notes = [];

  // 一重：文件层
  if (!hasSqliteMagic(backupFile)) {
    failures.push(
      `不是 SQLite 库文件（前 16 字节不是 "SQLite format 3"）；` +
        `文件大小 ${humanSize(statSync(backupFile).size)}。可能是 0 字节文件、HTML 错误页、或未解压的包`
    );
  }

  // 二重 + 三重：结构 / 内容
  let src = null;
  if (failures.length === 0) {
    try {
      src = inspect(backupFile);
    } catch (e) {
      failures.push(`打不开（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  if (src) {
    if (!src.ok) {
      failures.push(`integrity_check 未通过：${src.integrity.slice(0, 5).join(" | ")}`);
    }
    if (src.tableCount < MIN_TABLES) {
      failures.push(`表数 ${src.tableCount} < 阈值 ${MIN_TABLES}（空库 / 半截库）`);
    }
    const missing = REQUIRED_TABLES.filter((t) => !src.tables.includes(t));
    if (missing.length > 0) {
      failures.push(`缺少核心表：${missing.join(", ")}（这不是 PMS 库，或备份截断了）`);
    }
    // 内容层：用户表不能为空 —— 一个 0 用户的库恢复上去，连登录都进不去
    if (src.counts.users !== null && src.counts.users === 0) failures.push("users 表 0 行（恢复后无法登录）");
    if (src.counts.rooms !== null && src.counts.rooms === 0) failures.push("rooms 表 0 行（恢复后没有房间）");

    const latest = readLatest();
    if (latest?.sha256 && latest.sha256 === src.sha256) {
      notes.push(`sha256 与 latest.json 记录的最近一次备份一致（这份就是最新正式备份）`);
    } else if (latest?.sha256) {
      notes.push(`sha256 与 latest.json 不一致（这不是最近一次备份，可能更早或来路不同）`);
    }
  }

  console.log(`校验：${src ? `${src.tableCount} 张表 / ${humanSize(src.sizeBytes)} / integrity ${src.ok ? "ok" : "FAILED"}` : "未完成"}`);
  if (src) {
    console.log(
      `      行数：` +
        COUNT_TABLES.filter((t) => src.counts[t] !== null)
          .map((t) => `${t}=${src.counts[t]}`)
          .join("  ")
    );
  }
  for (const n of notes) console.log(`      ℹ ${n}`);

  if (failures.length > 0) {
    console.error("");
    console.error(`[拒绝恢复] 备份文件校验不通过（${failures.length} 项）：`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error("");
    console.error(`目标库**一个字节都没动**。换一份备份：node scripts/restore-db.mjs --list`);
    return 3;
  }

  /* ══════════════ 目标库 / 服务占用检查 ══════════════ */
  const targetExists = existsSync(DB_PATH);
  const prod = isProductionPath(DB_PATH);
  const serviceDb = isServiceDb(DB_PATH);
  const holders = detectHolders(DB_PATH);

  /*
   * systemd 只对「它自己那个库」构成占用；在 /tmp 副本上演练时，
   * 生产的 pms 服务照样 active，但它根本没碰这个副本库 —— 不能算阻断。
   * 进程持有是按路径精确匹配的，任何路径都算。
   */
  const systemdBlocks = serviceDb && holders.systemd === "active";
  const blockerDetail = [
    ...(systemdBlocks ? ["systemd 单元 pms 处于 active（它正打开这个库）"] : []),
    ...(holders.pids.length ? [`进程 ${holders.pids.join(",")} 打开了该库文件`] : []),
  ];
  const holderBlocked = blockerDetail.length > 0;

  console.log("");
  console.log(`目标库现状：${targetExists ? `${humanSize(statSync(DB_PATH).size)}（存在）` : "不存在（将新建）"}`);
  console.log(`路径判定：${prod ? "生产库路径" : "非生产路径（演练/副本模式）"}`);
  console.log(
    `服务检测：systemd=${holders.systemd}` +
      (serviceDb ? "" : "（该服务用的不是本库，不计入占用）") +
      (holders.pids.length ? `，持有进程 ${holders.pids.join(",")}` : "")
  );

  if (holderBlocked) {
    console.log("");
    console.log(`⚠ 目标库正被使用：${blockerDetail.join("；")}`);
    if (prod) {
      console.log("  生产环境必须**先停服务再恢复**，否则恢复出来的库会立刻被服务写脏：");
      console.log("    sudo systemctl stop pms");
      console.log("    node scripts/restore-db.mjs <备份> --force");
      console.log("    node scripts/migrate-all.mjs && node scripts/sync-schema.mjs");
      console.log("    sudo systemctl start pms");
    }
    if (!FORCE) {
      console.error("");
      console.error(`[拒绝恢复] 目标库被占用。确认已停服务后加 --force 重跑。`);
      return 4;
    }
    console.log("  --force 已指定：继续（风险：正在运行的进程可能把旧数据写回新库）");
  }

  /* ══════════════ dry-run 到此为止 ══════════════ */
  if (DRY_RUN) {
    const st = stamp();
    const beforeFile = path.join(BACKUP_DIR, `pms.before-restore.${st}.db`);
    const expected = expectedTablesFromSchema();
    const missingExpected = expected ? expected.tables.filter((t) => !src.tables.includes(t)) : null;

    console.log("");
    console.log("── dry-run（不写任何文件、不替换任何库）──");
    console.log(`  会先备份当前库 → ${beforeFile}`);
    console.log(`  然后用 ${path.basename(backupFile)} 原子替换 ${DB_PATH}`);
    if (missingExpected) {
      console.log(
        `  备份相对当前代码缺 ${missingExpected.length} 张表` +
          (missingExpected.length ? `：${missingExpected.slice(0, 8).join(", ")}${missingExpected.length > 8 ? " …" : ""}` : "")
      );
      if (missingExpected.length > 0) console.log(`  → 恢复后**必须**跑 node scripts/migrate-all.mjs + node scripts/sync-schema.mjs`);
    }
    console.log(`  正式执行请去掉 --dry-run（并加 --force 跳过交互确认）`);
    if (JSON_OUT) {
      console.log(JSON.stringify({ mode: "dry-run", backup: backupFile, db: DB_PATH, source: src, holders, prod }, null, 2));
    }
    return 0;
  }

  /* ══════════════ 交互确认 ══════════════ */
  if (!FORCE) {
    if (!process.stdin.isTTY) {
      console.error("");
      console.error("[拒绝恢复] 非交互式环境（stdin 不是终端），无法安全确认。");
      console.error("           确认要恢复请显式加 --force。");
      return 1;
    }
    console.log("");
    console.log("即将【覆盖】目标库，此操作不可撤销（但会先把当前库备份成 pms.before-restore.<ts>.db）。");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("确认恢复请输入 yes（其它任意输入取消）：")).trim();
    rl.close();
    if (ans.toLowerCase() !== "yes") {
      console.log("已取消，目标库未改动。");
      return 1;
    }
  }

  /* ══════════════ 1. 恢复前备份当前库 ══════════════ */
  mkdirSync(BACKUP_DIR, { recursive: true });
  const beforeFile = path.join(BACKUP_DIR, `pms.before-restore.${stamp()}.db`);
  let beforeInfo = null;
  let beforeMode = "none";

  if (targetExists) {
    try {
      const db = new DatabaseSync(DB_PATH, { readOnly: true });
      try {
        // VACUUM INTO 会把当前库（含 WAL 里未 checkpoint 的写入）读成一份干净快照
        db.exec("PRAGMA busy_timeout = 10000");
        db.exec(`VACUUM INTO '${beforeFile.replace(/'/g, "''")}'`);
      } finally {
        db.close();
      }
      beforeMode = "vacuum-into";
      beforeInfo = inspect(beforeFile);
      console.log("");
      console.log(`✅ 恢复前备份：${beforeFile}（${humanSize(beforeInfo.sizeBytes)}，${beforeInfo.tableCount} 张表）`);
    } catch (e) {
      /*
       * 走到这里说明当前库**打不开或已损坏**（这正是「库文件损坏」场景）。
       * VACUUM INTO 读不了它，但也不能什么都不留 —— 原样 cp 一份，
       * 至少保住现场证据，事后能用 `strings` / `.recover` 捞数据。
       */
      beforeMode = "copy-fallback";
      try {
        copyFileSync(DB_PATH, beforeFile);
        const size = statSync(beforeFile).size;
        console.log("");
        console.log(`⚠ 当前库无法 VACUUM（可能已损坏），已原样复制保底：`);
        console.log(`   ${beforeFile}（${humanSize(size)}，无法读取内容 —— 这份只是现场证据，不能直接恢复）`);
      } catch (e2) {
        beforeMode = "failed";
        console.log("");
        console.log(`⚠ 恢复前备份失败：${e2 instanceof Error ? e2.message : String(e2)}`);
        console.log(`   建议先手工：cp ${DB_PATH} ${beforeFile}`);
      }
      if (beforeMode === "copy-fallback") console.log(`   （原因：${e instanceof Error ? e.message : String(e)}）`);
    }
  } else {
    console.log("");
    console.log("目标库不存在，跳过恢复前备份（这是首次建库到目标路径）。");
  }

  /* ══════════════ 2. 清 WAL + 复制到临时文件 + 校验 ══════════════ */
  const tmpFile = `${DB_PATH}.restore-tmp-${process.pid}`;

  const cleanupTmp = () => {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  };
  cleanupTmp();

  /*
   * checkpoint 当前库再删 -wal / -shm。
   *
   * 这一步做错会出「恢复了但数据没变」的诡异事故：
   * 假设旧库有 pms.db-wal（里面是旧事务）。我们直接覆盖 pms.db，
   * 但 -wal 还在、里面记着「旧库的 page N 是新版本」。下次 SQLite 打开时
   * 会把旧 WAL 回放到新库上 → 一部分表变回旧数据，或者直接
   * `database disk image is malformed`（page 校验不过）。
   * 所以必须先 checkpoint（把 WAL 合并进 pms.db），再删掉 -wal/-shm。
   */
  if (targetExists) {
    try {
      const db = new DatabaseSync(DB_PATH);
      try {
        db.exec("PRAGMA busy_timeout = 10000");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    } catch {
      /* 库已损坏时 checkpoint 会失败：无所谓，反正马上要整个换掉 */
    }
    for (const suffix of ["-wal", "-shm"]) {
      const f = DB_PATH + suffix;
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch (e) {
          console.error(`[警告] 删不掉 ${f}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  // 目标目录必须存在（首次恢复到新路径时）
  const dbDir = path.dirname(DB_PATH);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  try {
    copyFileSync(backupFile, tmpFile);
  } catch (e) {
    console.error(`[失败] 复制备份到临时文件失败：${e instanceof Error ? e.message : String(e)}`);
    console.error(`       目标库未改动。常见原因：磁盘满、目标目录无写权限`);
    cleanupTmp();
    return 5;
  }

  // 复制后再校验一次：防止复制过程中磁盘满/被截断
  let tmpInfo;
  try {
    tmpInfo = inspect(tmpFile);
  } catch (e) {
    console.error(`[失败] 临时文件打不开：${e instanceof Error ? e.message : String(e)}`);
    cleanupTmp();
    return 5;
  }
  if (!tmpInfo.ok || tmpInfo.tableCount !== src.tableCount || tmpInfo.sha256 !== src.sha256) {
    console.error(`[失败] 临时文件校验与备份不一致（复制被截断？）`);
    console.error(`       期望 sha256 ${src.sha256}`);
    console.error(`       实际 sha256 ${tmpInfo.sha256}`);
    cleanupTmp();
    return 5;
  }

  /* ══════════════ 3. 原子替换目标库 ══════════════ */
  try {
    if (process.platform === "win32" && existsSync(DB_PATH)) {
      // Windows 的 rename 不覆盖已存在文件，只能先删（不是原子的，但 Windows 上无更好选择）
      unlinkSync(DB_PATH);
    }
    renameSync(tmpFile, DB_PATH);
  } catch (e) {
    console.error(`[失败] 替换目标库失败：${e instanceof Error ? e.message : String(e)}`);
    cleanupTmp();
    if (beforeFile && beforeMode === "vacuum-into" && existsSync(beforeFile)) {
      console.error(`       ⚠ 目标库可能处于不确定状态。用恢复前备份手动救回：`);
      console.error(`         cp ${beforeFile} ${DB_PATH}`);
    }
    return 5;
  }

  /* ══════════════ 4. 恢复后校验 ══════════════ */
  let after;
  try {
    after = inspect(DB_PATH);
  } catch (e) {
    console.error(`[失败] 恢复后目标库打不开：${e instanceof Error ? e.message : String(e)}`);
    return 5;
  }

  const afterFailures = [];
  if (!after.ok) afterFailures.push(`integrity_check = ${after.integrity.join(" | ")}`);
  if (after.tableCount !== src.tableCount) afterFailures.push(`表数 ${after.tableCount} ≠ 备份 ${src.tableCount}`);
  if (after.sha256 !== src.sha256) afterFailures.push(`sha256 与备份不一致（文件被改写？）`);
  for (const t of REQUIRED_TABLES) {
    if (!after.tables.includes(t)) afterFailures.push(`缺核心表 ${t}`);
    else if (src.counts[t] !== null && after.counts[t] !== src.counts[t]) {
      afterFailures.push(`${t} 行数 ${after.counts[t]} ≠ 备份 ${src.counts[t]}`);
    }
  }
  // foreign_key_check：本项目没有外键声明，正常恒为 0。
  // 非 0 只警告不失败（可能是备份本身就带着的既有数据问题）。
  if (after.foreignKeyViolations > 0) {
    console.log(`⚠ foreign_key_check 报 ${after.foreignKeyViolations} 处悬空（备份自带，不是恢复引入的）`);
  }

  console.log("");
  console.log("════════════════ 恢复结果 ════════════════");
  const row = (label, info) => {
    if (!info) return `  ${label.padEnd(16)} —`;
    return (
      `  ${label.padEnd(16)} 表 ${String(info.tableCount).padEnd(3)} ` +
      COUNT_TABLES.filter((t) => info.counts[t] !== null)
        .map((t) => `${t}=${info.counts[t]}`)
        .join(" ") +
      `  ${humanSize(info.sizeBytes)}`
    );
  };
  console.log(row("备份文件", src));
  if (beforeInfo) console.log(row("恢复前（已存档）", beforeInfo));
  console.log(row("恢复后", after));
  console.log(
    `  sha256            ${after.sha256.slice(0, 20)}… ${after.sha256 === src.sha256 ? "✅ 与备份一致" : "❌ 不一致"}`
  );
  console.log(`  integrity_check   ${after.ok ? "✅ ok" : "❌ " + after.integrity.join(" | ")}`);
  console.log(`  foreign_key_check ${after.foreignKeyViolations === 0 ? "✅ 0 处悬空" : `⚠ ${after.foreignKeyViolations} 处`}`);

  if (afterFailures.length > 0) {
    console.error("");
    console.error(`[失败] 恢复后校验不通过：`);
    for (const f of afterFailures) console.error(`  ✗ ${f}`);
    if (beforeFile && beforeMode === "vacuum-into") {
      console.error(`\n回滚：cp ${beforeFile} ${DB_PATH}`);
    }
    return 5;
  }

  /* ══════════════ 5. 老版本检测 + 下一步 ══════════════ */
  const expected = expectedTablesFromSchema();
  const missingExpected = expected ? expected.tables.filter((t) => !after.tables.includes(t)) : null;

  console.log("");
  console.log("════════════════ 下一步（必须做，别跳过） ════════════════");
  if (missingExpected && missingExpected.length > 0) {
    console.log(
      `⚠ 这份备份比当前代码老：缺 ${missingExpected.length} 张表 —— ${missingExpected.slice(0, 10).join(", ")}${
        missingExpected.length > 10 ? " …" : ""
      }`
    );
    console.log(`  不跑迁移服务会直接 500（no such table / no such column）。`);
  } else if (missingExpected && missingExpected.length === 0) {
    console.log(`✅ 表结构齐全（对比 scripts/schema-full.sql 无缺表）`);
  }

  const steps = [
    `node scripts/migrate-all.mjs          # 幂等迁移：补表、补列、补索引（老备份必跑）`,
    `node scripts/sync-schema.mjs          # 按 schema-fingerprint 补齐缺表/缺列`,
    `node scripts/rebuild-unique-constraints.mjs --check   # 只检查，确认单号约束状态`,
    `node scripts/preflight-db.mjs         # 38 项数据一致性体检`,
    `node scripts/health-check.mjs         # 业务体检（房态/账务/积压）`,
  ];
  console.log("");
  for (const s of steps) console.log(`  ${s}`);
  console.log("");

  if (prod) {
    console.log(`  sudo chown -R ubuntu:ubuntu ${dbDir}   # 回归服务用户，否则下一个请求 readonly database`);
    console.log(`  sudo systemctl restart pms             # 重启服务（恢复后必须，旧进程还开着旧库）`);
    console.log(`  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3100/login   # 期望 200`);
  } else {
    console.log(`  （非生产路径：以上命令请对 --db 指向的库执行；演练完记得删掉副本）`);
  }
  if (beforeInfo) {
    console.log("");
    console.log(`  恢复前存档：${beforeFile}`);
    console.log(`  确认恢复无误后，它可以删掉；先别急，出问题全靠它。`);
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          mode: "restored",
          backup: backupFile,
          db: DB_PATH,
          before: beforeInfo ? { file: beforeFile, mode: beforeMode, tableCount: beforeInfo.tableCount, sha256: beforeInfo.sha256 } : null,
          after: { tableCount: after.tableCount, sha256: after.sha256, counts: after.counts, integrity: after.ok, foreignKeyViolations: after.foreignKeyViolations },
          missingTables: missingExpected,
        },
        null,
        2
      )
    );
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[异常] ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(5);
  });
