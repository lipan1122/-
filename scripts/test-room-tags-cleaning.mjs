/**
 * 「打扫中」标签验收（最终版清单第四节第 7 项 / P1-4 第 152 行）
 *
 * ── 被验收的缺陷 ──
 * `src/lib/room-tags.ts` 把「打扫中」标成 **缺字段**：
 *     cleaning: { available: false, missing: "housekeeping.status 只有 PENDING / DONE / CANCELLED，没有「打扫中」状态" }
 *     ROOM_TAG_SQL.cleaning = `0`            ← SQL 恒假
 *     matchesRoomTag("cleaning") → return false
 * 但项目里 **早就有** housekeeping.status = 'DOING'：
 *     客房页 /mobile-housekeeping、批量打扫、派工、在住派房都在用 'PENDING','DOING' 过滤，
 *     housekeeping 页面的状态下拉里直接有 { value: "DOING", label: "进行中" }。
 * 清单第 152 行原话：「打扫中不能标记为缺字段。项目已有 housekeeping.status = 'DOING'，必须实现。」
 *
 * ── 本脚本怎么验（不能只 grep）──
 *  A. 源码口径：标签定义可用、SQL 片段引用 DOING、JS 判定不再恒假、且「待打扫」口径没被改坏；
 *  B. 真库副本实测：VACUUM INTO 复制 data/pms.db 到 .tmp/ → 在副本里造
 *     PENDING / DOING / DONE / 非打扫任务的 DOING / 双任务 五种房 → 直接执行
 *     **从源码里抽出来的** SQL 片段（不是测试自己写的等价物），断言命中集合。
 *     这样「测的 SQL」和「线上跑的 SQL」是同一份字符串。
 *  C. 真实酒店 1 数据兜底：真实库 17 条 PENDING 打扫任务必须被「待打扫」算到；
 *     「打扫中」必须等于真实 DOING 打扫任务的房间数。
 *
 * ── 关于 unable to open database file（清单 281-287 行）──
 *   1. PMS_DB_PATH：默认 data/pms.db，可用环境变量指向别的库；文件必须存在
 *   2. .tmp 目录必须**先创建**：VACUUM INTO 不会自建目录，目录不存在直接报
 *      "unable to open database file"（这里 mkdirSync recursive 兜底）
 *   3. 目标路径要转成 / 分隔并把 ' 转义成 ''（SQL 字符串字面量），否则 Windows
 *      反斜杠会被当转义符
 *   4. 打开连接带 timeout：另一个 agent 正在跑迁移时避免 SQLITE_BUSY 直接失败
 *   5. 副本用完连 -wal / -shm 一起删，避免残留文件让下次 VACUUM INTO 撞锁
 *
 * 用法：node scripts/test-room-tags-cleaning.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? " → " + extra : ""}`);
  }
};

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
/** 测试专用租户：所有造的数据都挂在 hotel 9999，不碰真实酒店 */
const H = 9999;

/** VACUUM INTO 的路径字面量：Windows 反斜杠 → /，单引号 → '' */
const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

/** 复制真库到 .tmp 下的副本（只读方式打开源库，绝不写源库） */
function openCopy(tag) {
  if (!existsSync(REAL_DB)) {
    console.error(`真实库不存在：${REAL_DB}\n  用 PMS_DB_PATH 指定库文件，或先跑 node scripts/init-db.mjs`);
    process.exit(1);
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const tmp = join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}.db`);
  try {
    const src = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
    try {
      src.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
    } finally {
      src.close();
    }
  } catch (e) {
    console.error(
      `复制真库失败：${e.message}\n` +
        `  真实库 ${REAL_DB}\n  目标   ${tmp}\n` +
        `  排查：PMS_DB_PATH 是否正确 / .tmp 是否可写 / 路径分隔符与引号是否已转义 / 是否有残留 -wal 占用`
    );
    process.exit(1);
  }
  const db = new DatabaseSync(tmp, { timeout: 10000 });
  return {
    db,
    tmp,
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-wal`, { force: true });
      rmSync(`${tmp}-shm`, { force: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * A. 源码静态口径
 * ------------------------------------------------------------------ */
const TAGS_FILE = join("src", "lib", "room-tags.ts");
const tagsSrc = readFileSync(TAGS_FILE, "utf8");

/** 取某个标签定义块（从 key: "xxx" 到下一个 }, ） */
function tagDefBlock(src, key) {
  const i = src.indexOf(`key: "${key}"`);
  if (i < 0) return "";
  const j = src.indexOf("},", i);
  return src.slice(i, j < 0 ? Math.min(i + 400, src.length) : j);
}

/** 取 `export const XXX = { ... } as const` 整块 */
function constBlock(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  const j = src.indexOf("} as const", i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

/** 取块内某个 key 的模板字符串片段（本文件的 SQL 片段没有 ${} 插值） */
function fragmentOf(block, key) {
  const i = block.indexOf(`${key}:`);
  if (i < 0) return null;
  const a = block.indexOf("`", i);
  if (a < 0) return null;
  let b = a + 1;
  while (b < block.length && block[b] !== "`") b += 1;
  return block.slice(a + 1, b);
}

/** 取 matchesRoomTag 里某个 case 分支 */
function caseBlock(src, name) {
  const i = src.indexOf(`case "${name}":`);
  if (i < 0) return "";
  const rest = src.slice(i + 12);
  const stops = ["\n    case ", "\n    default:"].map((m) => rest.indexOf(m)).filter((x) => x >= 0);
  const end = stops.length ? Math.min(...stops) : rest.length;
  return rest.slice(0, end);
}

const cleaningDef = tagDefBlock(tagsSrc, "cleaning");
const dirtyDef = tagDefBlock(tagsSrc, "dirty");
const sqlBlock = constBlock(tagsSrc, "export const ROOM_TAG_SQL");
const fieldBlock = constBlock(tagsSrc, "export const ROOM_TAG_FIELD_SQL");
const cleaningFrag = sqlBlock ? fragmentOf(sqlBlock, "cleaning") : null;
const dirtyFrag = sqlBlock ? fragmentOf(sqlBlock, "dirty") : null;
const cleaningCase = caseBlock(tagsSrc, "cleaning");

console.log("=== A. 源码口径：打扫中必须由 housekeeping.status='DOING' 实现 ===");

check(
  '「打扫中」标签已启用（available: true，不再标缺字段）',
  /available:\s*true/.test(cleaningDef) && !/missing:/.test(cleaningDef),
  cleaningDef.replace(/\s+/g, " ").slice(0, 120)
);
check(
  '「打扫中」标签说明写的是「进行中」，不是「缺字段」',
  /进行中|DOING/.test(cleaningDef) && !/缺字段/.test(cleaningDef),
  cleaningDef.replace(/\s+/g, " ").slice(0, 120)
);
check(
  "ROOM_TAG_SQL.cleaning 引用 housekeeping 且状态为 'DOING'（不再是常量 0）",
  !!cleaningFrag && /housekeeping/i.test(cleaningFrag) && /'DOING'/.test(cleaningFrag),
  cleaningFrag === null ? "取不到 cleaning 片段" : cleaningFrag.replace(/\s+/g, " ").slice(0, 160)
);
check(
  "ROOM_TAG_SQL.cleaning 不是恒假表达式（不等于 `0`）",
  !!cleaningFrag && cleaningFrag.trim() !== "0",
  cleaningFrag
);
check(
  'matchesRoomTag("cleaning") 不再恒假，且用 DOING 计数参与判定',
  cleaningCase.length > 0 && !/^\s*\/?\*?[\s\S]*?return false;/.test(cleaningCase) && /hk_doing|hk_cleaning|doing/i.test(cleaningCase),
  cleaningCase.replace(/\s+/g, " ").slice(0, 140)
);
check(
  "ROOM_TAG_FIELD_SQL 提供 DOING 计数字段（与统计同口径）",
  !!fieldBlock && /hk_doing|hk_cleaning/i.test(fieldBlock) && /'DOING'/.test(fieldBlock),
  fieldBlock ? "未找到 hk_doing / hk_cleaning 字段" : "取不到 ROOM_TAG_FIELD_SQL"
);
check(
  "「待打扫」口径没被改坏：仍只统计 PENDING（未混入 DOING）",
  !!dirtyFrag && /'PENDING'/.test(dirtyFrag) && !/'DOING'/.test(dirtyFrag),
  dirtyFrag === null ? "取不到 dirty 片段" : dirtyFrag.replace(/\s+/g, " ").slice(0, 160)
);
check(
  "「待打扫」标签仍是可用状态且任务类型限定为「打扫」",
  /available:\s*true/.test(dirtyDef) && !!dirtyFrag && /task_type\s*=\s*'打扫'/.test(dirtyFrag),
  dirtyFrag === null ? "" : dirtyFrag.replace(/\s+/g, " ").slice(0, 160)
);

/* ------------------------------------------------------------------ *
 * B. 真库副本实测
 * ------------------------------------------------------------------ */
console.log("\n=== B. 真库副本实测（.tmp 副本 · 租户 9999）===");

const copy = openCopy("room-tags-cleaning");
const { db } = copy;
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

/** 房间 → 在住单 → 账单 → 客人 的固定别名（与 room-tags.ts 文件头的别名约定一致） */
const ROOM_JOIN = `rooms r
  LEFT JOIN stays s ON s.id = (
    SELECT MAX(sx.id) FROM stays sx
     WHERE sx.room_id = r.id AND sx.hotel_id = r.hotel_id AND sx.status = 'INHOUSE'
  )
  LEFT JOIN folios f ON f.stay_id = s.id
  LEFT JOIN guests g ON g.id = s.guest_id
 WHERE r.hotel_id = ?`;

/** 用源码里的 SQL 片段跑命中房间号（不自己重写条件） */
function hitRooms(frag) {
  if (!frag) return null;
  return all(
    `SELECT DISTINCT r.room_no AS room_no FROM ${ROOM_JOIN} AND (${frag}) ORDER BY r.room_no`,
    [H]
  ).map((r) => r.room_no);
}

let cleanup = true;
try {
  /* 造租户 + 房型 + 房间（房号 T901..T905） */
  run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [
    H,
    "TEST-TAGS-9999",
    "标签测试酒店",
    "测试地址",
    "000",
  ]);
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
    H,
    "TT",
    "标签测试房型",
    300,
    2,
    1,
  ]);
  const rtId = Number(one(`SELECT id FROM room_types WHERE hotel_id = ? LIMIT 1`, [H]).id);
  const addRoom = (roomNo, status) =>
    run(`INSERT INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort) VALUES (?,?,?,?,?,?)`, [
      H,
      rtId,
      roomNo,
      9,
      status,
      1,
    ]);
  for (const [no, st] of [
    ["T901", "VC"], // 只有 PENDING  → 只算「待打扫」
    ["T902", "VD"], // 只有 DOING    → 只算「打扫中」
    ["T903", "VC"], // 只有 DONE     → 两个都不算
    ["T904", "VC"], // DOING 但任务类型是维修 → 不算「打扫中」
    ["T905", "VD"], // PENDING + DOING → 两个都算
  ]) {
    addRoom(no, st);
  }
  const roomIdOf = (no) => Number(one(`SELECT id FROM rooms WHERE hotel_id = ? AND room_no = ?`, [H, no]).id);

  /* 造 housekeeping 记录 */
  let seq = 0;
  const addTask = (roomNo, taskType, status) => {
    seq += 1;
    run(
      `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [H, roomIdOf(roomNo), taskType, status, "测试保洁", `造数#${seq}`, "2030-06-15T09:00:00.000+08:00"]
    );
  };
  addTask("T901", "打扫", "PENDING");
  addTask("T902", "打扫", "DOING");
  addTask("T903", "打扫", "DONE");
  addTask("T904", "维修", "DOING");
  addTask("T905", "打扫", "PENDING");
  addTask("T905", "打扫", "DOING");

  const dirtyHits = hitRooms(dirtyFrag);
  const cleaningHits = hitRooms(cleaningFrag);

  check(
    "「打扫中」命中集合 = 有 DOING 打扫任务的房（T902 / T905）",
    JSON.stringify(cleaningHits) === JSON.stringify(["T902", "T905"]),
    `实际 ${JSON.stringify(cleaningHits)}（期望 ["T902","T905"]）`
  );
  check(
    "「待打扫」命中集合 = 有 PENDING 打扫任务的房（T901 / T905）",
    JSON.stringify(dirtyHits) === JSON.stringify(["T901", "T905"]),
    `实际 ${JSON.stringify(dirtyHits)}（期望 ["T901","T905"]）`
  );
  check(
    "「打扫中」只统计 DOING，不把 PENDING 房间算进来（T901 不在其中）",
    !!cleaningHits && !cleaningHits.includes("T901"),
    JSON.stringify(cleaningHits)
  );
  check(
    "「待打扫」只统计 PENDING，不把 DOING 房间算进来（T902 不在其中）",
    !!dirtyHits && !dirtyHits.includes("T902"),
    JSON.stringify(dirtyHits)
  );
  check(
    "DONE 的打扫任务两个标签都不算（T903 都不在）",
    !!cleaningHits && !!dirtyHits && !cleaningHits.includes("T903") && !dirtyHits.includes("T903"),
    `dirty=${JSON.stringify(dirtyHits)} cleaning=${JSON.stringify(cleaningHits)}`
  );
  check(
    "非「打扫」任务的 DOING（维修）不算「打扫中」",
    !!cleaningHits && !cleaningHits.includes("T904"),
    JSON.stringify(cleaningHits)
  );
  check(
    "两个标签互不重叠地各自可达（同一房可同时待打扫+打扫中，属预期）",
    !!dirtyHits && !!cleaningHits && dirtyHits.length === 2 && cleaningHits.length === 2,
    `dirty=${JSON.stringify(dirtyHits)} cleaning=${JSON.stringify(cleaningHits)}`
  );

  /* ------------------------------------------------------------------ *
   * C. 真实酒店 1 数据（同一份副本里的真实行，不是造的数据）
   * ------------------------------------------------------------------ */
  console.log("\n=== C. 真实酒店 1 数据兜底 ===");
  const realDirtyHits = all(
    `SELECT DISTINCT r.room_no AS room_no FROM ${ROOM_JOIN} AND (${dirtyFrag ?? "0"})`,
    [1]
  ).map((r) => r.room_no);
  const directDirty = all(
    `SELECT DISTINCT hk.room_id AS id FROM housekeeping hk
      WHERE hk.hotel_id = 1 AND hk.task_type = '打扫' AND hk.status = 'PENDING'`
  ).length;
  check(
    "真实库「待打扫」房间数 = 真实 PENDING 打扫任务覆盖的房间数（口径自洽）",
    realDirtyHits.length === directDirty && directDirty > 0,
    `标签=${realDirtyHits.length} 直接统计=${directDirty}`
  );

  const realCleaningHits = all(
    `SELECT DISTINCT r.room_no AS room_no FROM ${ROOM_JOIN} AND (${cleaningFrag ?? "0"})`,
    [1]
  ).map((r) => r.room_no);
  const directDoing = all(
    `SELECT DISTINCT hk.room_id AS id FROM housekeeping hk
      WHERE hk.hotel_id = 1 AND hk.task_type = '打扫' AND hk.status = 'DOING'`
  ).length;
  check(
    "真实库「打扫中」房间数 = 真实 DOING 打扫任务覆盖的房间数",
    realCleaningHits.length === directDoing,
    `标签=${realCleaningHits.length}（${JSON.stringify(realCleaningHits)}） 直接统计=${directDoing}`
  );
  console.log(`   ℹ 真实库：待打扫 ${realDirtyHits.length} 间 / 打扫中 ${realCleaningHits.length} 间（DOING 任务 ${directDoing} 条）`);
} catch (e) {
  cleanup = false;
  check("副本内造数与查询执行成功", false, e.message);
} finally {
  copy.close();
  if (!cleanup) {
    console.log("   ℹ 异常退出前已尝试清理副本；若 .tmp 有残留请手动删除");
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
