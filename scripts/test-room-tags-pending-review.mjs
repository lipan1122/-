/**
 * 「待审」标签验收（最终版清单第四节第 8 项 / P1-4 第 153-154 行）
 *
 * ── 被验收的缺陷 ──
 * 上一版 `src/lib/room-tags.ts` 把「待审」映射成：
 *     ROOM_TAG_SQL.pendingApprove = 有 cancel_requests.status = 'PENDING' 的取消入住申请
 * 清单第 153 行原话：「待审不能映射 cancel_requests.status = 'PENDING'。
 * 那是取消入住审批，不是客房审核。」
 * 第 154 行：「增加明确的客房审核状态，例如 PENDING_REVIEW、APPROVED、REJECTED，
 * 或增加 review_status 字段。」
 *
 * ── 本脚本验四层 ──
 *  A. 源码：ROOM_TAG_SQL 的判定条件里没有 cancel_requests；
 *     pendingApprove 片段查 housekeeping.review_status = 'PENDING_REVIEW'；
 *     matchesRoomTag 用的行字段片段同样不碰取消审批。
 *  B. 迁移：migrate-all.mjs 有 addColumn("housekeeping", review_status/reviewed_by/reviewed_at)。
 *  C. 真库结构：housekeeping 真有三列。缺列时明确报「等待迁移」并 exit(1)——不跳过、不算过。
 *  D. 真库副本实测：造 5 种打扫任务 + 2 条 PENDING 取消申请，
 *     直接执行**从源码抽出的**片段，断言「待审」只等于 PENDING_REVIEW 那一间，
 *     且取消申请的多寡完全不影响计数。
 *
 * ── unable to open database file（清单 281-287 行）──
 *   PMS_DB_PATH / .tmp 目录必须先建且可写 / VACUUM INTO 目标路径用 / 分隔并转义单引号 /
 *   打开连接带 timeout（另一个 agent 可能正在跑迁移持写锁）/ 副本连 -wal -shm 一起清掉。
 *
 * 用法：node scripts/test-room-tags-pending-review.mjs
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
const norm = (s) => s.replace(/\s+/g, " ").trim();

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const H = 9999;
const REVIEW_COLS = ["review_status", "reviewed_by", "reviewed_at"];

const sqlPath = (p) => p.replace(/\\/g, "/").replace(/'/g, "''");

function openCopy(tag) {
  if (!existsSync(REAL_DB)) {
    console.error(`真实库不存在：${REAL_DB}（用 PMS_DB_PATH 指定，或先 init-db）`);
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
      `复制真库失败：${e.message}\n  真实库 ${REAL_DB}\n  目标 ${tmp}\n` +
        `  排查：PMS_DB_PATH / .tmp 写权限 / 路径分隔符与单引号转义 / 残留 -wal 占用`
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
 * A. 源码口径
 * ------------------------------------------------------------------ */
const TAGS_FILE = join("src", "lib", "room-tags.ts");
const MIGRATE_FILE = join("scripts", "migrate-all.mjs");
const tagsSrc = readFileSync(TAGS_FILE, "utf8");
const migrateSrc = readFileSync(MIGRATE_FILE, "utf8");

function constBlock(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  const j = src.indexOf("} as const", i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}
function fragmentOf(block, key) {
  const i = block.indexOf(`${key}:`);
  if (i < 0) return null;
  const a = block.indexOf("`", i);
  if (a < 0) return null;
  let b = a + 1;
  while (b < block.length && block[b] !== "`") b += 1;
  return block.slice(a + 1, b);
}
function tagDefBlock(src, key) {
  const i = src.indexOf(`key: "${key}"`);
  if (i < 0) return "";
  const j = src.indexOf("},", i);
  return src.slice(i, j < 0 ? Math.min(i + 400, src.length) : j);
}
function caseBlock(src, name) {
  const i = src.indexOf(`case "${name}":`);
  if (i < 0) return "";
  const rest = src.slice(i + 12);
  const stops = ["\n    case ", "\n    default:"].map((m) => rest.indexOf(m)).filter((x) => x >= 0);
  return rest.slice(0, stops.length ? Math.min(...stops) : rest.length);
}
/** 取出代码块里全部模板字符串 —— 只比 SQL，不把注释里的「上一版查过 cancel_requests」当实现 */
function templatesIn(block) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = block.indexOf("`", i);
    if (a < 0) break;
    let b = a + 1;
    while (b < block.length && block[b] !== "`") b += 1;
    out.push(block.slice(a + 1, b));
    i = b + 1;
  }
  return out;
}

const seqBlock = constBlock(tagsSrc, "export const ROOM_TAG_SQL");
const fieldBlock = constBlock(tagsSrc, "export const ROOM_TAG_FIELD_SQL");
const pendingFrag = seqBlock ? fragmentOf(seqBlock, "pendingApprove") : null;
const pendingDef = tagDefBlock(tagsSrc, "pendingApprove");
const pendingCase = caseBlock(tagsSrc, "pendingApprove");

/** matchesRoomTag 里「待审」实际读的行字段名（例如 room.hk_review_pending） */
const pendingFieldName = (pendingCase.match(/room\.([A-Za-z0-9_]+)/) ?? [])[1] ?? null;
const pendingFieldFrag = pendingFieldName && fieldBlock ? fragmentOf(fieldBlock, pendingFieldName) : null;

console.log("=== A. 源码口径：待审 = 客房审核，不是取消入住审批 ===");

check(
  "ROOM_TAG_SQL 全部标签的 SQL 片段里不含 cancel_requests",
  !!seqBlock && templatesIn(seqBlock).every((t) => !/cancel_requests/i.test(t)),
  seqBlock
    ? (templatesIn(seqBlock).find((t) => /cancel_requests/i.test(t)) ?? "").replace(/\s+/g, " ").slice(0, 140)
    : "取不到 ROOM_TAG_SQL"
);
check(
  "pendingApprove 片段查 housekeeping.review_status = 'PENDING_REVIEW'",
  !!pendingFrag && /housekeeping/i.test(pendingFrag) && /review_status/i.test(pendingFrag) && /'PENDING_REVIEW'/.test(pendingFrag),
  pendingFrag === null ? "取不到 pendingApprove 片段" : norm(pendingFrag).slice(0, 180)
);
check(
  "pendingApprove 片段不再引用 cancel_requests",
  !!pendingFrag && !/cancel_requests/i.test(pendingFrag),
  pendingFrag === null ? "" : norm(pendingFrag).slice(0, 180)
);
check(
  'matchesRoomTag("pendingApprove") 用的是审核字段，不是取消申请计数',
  !!pendingCase && !!pendingFieldName && !/pending_cancel/i.test(pendingCase) && /review/i.test(pendingFieldName),
  `字段=${pendingFieldName} 分支=${norm(pendingCase).slice(0, 120)}`
);
check(
  "该行字段片段（${pendingFieldName}）同样查 review_status 且不碰 cancel_requests",
  !!pendingFieldFrag && /review_status/i.test(pendingFieldFrag) && !/cancel_requests/i.test(pendingFieldFrag),
  pendingFieldFrag === null ? "行字段片段取不到" : norm(pendingFieldFrag).slice(0, 160)
);
check(
  '「待审」标签可用且说明写的是「客房验收」，不再写「取消申请」',
  /available:\s*true/.test(pendingDef) && !/取消(入住)?申请\"\s*$/.test(norm(pendingDef)) && /验收|审核/.test(pendingDef),
  norm(pendingDef).slice(0, 160)
);
check(
  "migrate-all.mjs 用 addColumn 补 housekeeping 的 3 个审核列",
  REVIEW_COLS.every((c) => new RegExp(`addColumn\\(\\s*"housekeeping"\\s*,\\s*"${c}"`).test(migrateSrc)),
  REVIEW_COLS.filter((c) => !new RegExp(`addColumn\\(\\s*"housekeeping"\\s*,\\s*"${c}"`).test(migrateSrc)).join(", ") || ""
);

/* ------------------------------------------------------------------ *
 * C. 真库结构（缺列 → 等待迁移，exit 1）
 * ------------------------------------------------------------------ */
console.log("\n=== B. 真库结构：housekeeping 审核三列 ===");
const realDb = new DatabaseSync(REAL_DB, { readOnly: true, timeout: 10000 });
let realHkCols = [];
try {
  realHkCols = realDb.prepare(`PRAGMA table_info(housekeeping)`).all().map((c) => c.name);
} finally {
  realDb.close();
}
const missingCols = REVIEW_COLS.filter((c) => !realHkCols.includes(c));
for (const c of REVIEW_COLS) {
  check(`真实库 housekeeping.${c} 存在`, !missingCols.includes(c), `现有列：${realHkCols.join(",")}`);
}
if (missingCols.length > 0) {
  check(
    "等待迁移：先执行 node scripts/migrate-all.mjs 再跑本脚本",
    false,
    `缺 ${missingCols.join(" / ")} —— 动态断言依赖这三列，缺列时不能静默跳过（清单 289 行：不能把异常退出当成通过）`
  );
}else{
  console.log(`   ℹ 三列已就位：${REVIEW_COLS.join(" / ")}，继续做数据实测`);
}

/* ------------------------------------------------------------------ *
 * D. 真库副本实测
 * ------------------------------------------------------------------ */
console.log("\n=== C. 真库副本实测（.tmp 副本 · 租户 9999）===");

const copy = openCopy("room-tags-pending-review");
const { db } = copy;
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const ROOM_JOIN = `rooms r
  LEFT JOIN stays s ON s.id = (
    SELECT MAX(sx.id) FROM stays sx
     WHERE sx.room_id = r.id AND sx.hotel_id = r.hotel_id AND sx.status = 'INHOUSE'
  )
  LEFT JOIN folios f ON f.stay_id = s.id
  LEFT JOIN guests g ON g.id = s.guest_id
 WHERE r.hotel_id = ?`;

function hitRooms(frag, hotelId = H) {
  if (!frag) return null;
  return all(`SELECT DISTINCT r.room_no AS room_no FROM ${ROOM_JOIN} AND (${frag}) ORDER BY r.room_no`, [hotelId]).map(
    (r) => r.room_no
  );
}

try {
  run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [
    H,
    "TEST-REVIEW-9999",
    "待审标签测试酒店",
    "测试地址",
    "000",
  ]);
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
    H,
    "TR",
    "待审测试房型",
    300,
    2,
    1,
  ]);
  const rtId = Number(one(`SELECT id FROM room_types WHERE hotel_id = ? LIMIT 1`, [H]).id);
  const ROOMS = [
    ["R901", "DONE", "PENDING_REVIEW"], // ① 打扫完成待验收 → 唯一应命中「待审」
    ["R902", "DONE", "APPROVED"], // ② 已通过 → 不算
    ["R903", "DONE", "REJECTED"], // ③ 已驳回 → 不算
    ["R904", "DOING", null], // ④ 还在打扫，未进审核 → 不算
    ["R905", "DONE", "PENDING_REVIEW"], // ⑤ 待验收但任务类型是维修 → 不算「打扫」待审
  ];
  for (const [no] of ROOMS) {
    run(`INSERT INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort) VALUES (?,?,?,?,?,?)`, [
      H,
      rtId,
      no,
      9,
      "VC",
      1,
    ]);
  }
  const roomIdOf = (no) => Number(one(`SELECT id FROM rooms WHERE hotel_id = ? AND room_no = ?`, [H, no]).id);

  /* 造在住单（取消申请挂在 stay_id 上，旧口径要靠它命中） */
  let staySeq = 0;
  const addStay = (roomNo) => {
    staySeq += 1;
    run(
      `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [H, `TR-${staySeq}`, roomIdOf(roomNo), `待审客${staySeq}`, "2030-06-15T14:00:00.000+08:00", "2030-06-16", 1, 300, "INHOUSE", "2030-06-15T14:00:00.000+08:00"]
    );
    return Number(one(`SELECT MAX(id) AS id FROM stays WHERE hotel_id = ?`, [H]).id);
  };
  const stayR901 = addStay("R901");
  const stayR902 = addStay("R902");
  const stayR903 = addStay("R903");

  /* 造打扫任务：review_status 是本次新增的审核维度 */
  let seq = 0;
  for (const [no, status, reviewStatus] of ROOMS) {
    seq += 1;
    run(
      `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at, done_at, review_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        H,
        roomIdOf(no),
        no === "R905" ? "维修" : "打扫",
        status,
        "测试保洁",
        `造数#${seq}`,
        "2030-06-15T09:00:00.000+08:00",
        status === "DONE" ? "2030-06-15T10:00:00.000+08:00" : null,
        reviewStatus,
      ]
    );
  }

  /* 造 2 条 PENDING 取消入住申请（旧口径会把 R902 / R903 算进「待审」） */
  let crSeq = 0;
  const addCancelRequest = (stayId, roomNo) => {
    crSeq += 1;
    run(
      `INSERT INTO cancel_requests (hotel_id, stay_id, room_no, guest_name, reason, status, requested_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [H, stayId, roomNo, `待审客${crSeq}`, "客人临时有事", "PENDING", "前台", "2030-06-15T11:00:00.000+08:00"]
    );
  };
  addCancelRequest(stayR902, "R902");
  addCancelRequest(stayR903, "R903");
  void stayR901;

  const reviewHits = hitRooms(pendingFrag);
  check(
    "「待审」命中集合 = housekeeping.review_status='PENDING_REVIEW' 的打扫房（仅 R901）",
    JSON.stringify(reviewHits) === JSON.stringify(["R901"]),
    `实际 ${JSON.stringify(reviewHits)}（期望 ["R901"]）`
  );

  /* 旧口径（cancel_requests.status='PENDING'）在同一批数据上会算到 R902 / R903 */
  const oldHits = all(
    `SELECT DISTINCT r.room_no AS room_no FROM ${ROOM_JOIN}
       AND EXISTS (SELECT 1 FROM cancel_requests cr
                    WHERE cr.hotel_id = r.hotel_id AND cr.stay_id = s.id AND cr.status = 'PENDING')
     ORDER BY r.room_no`,
    [H]
  ).map((r) => r.room_no);
  check(
    "同一批数据按旧口径（cancel_requests PENDING）会命中 R902/R903 —— 说明新口径确实换了语义",
    JSON.stringify(oldHits) === JSON.stringify(["R902", "R903"]),
    `旧口径命中 ${JSON.stringify(oldHits)}`
  );
  check(
    "取消申请的房间不进入「待审」（R902 / R903 都不在）",
    !!reviewHits && !reviewHits.includes("R902") && !reviewHits.includes("R903"),
    JSON.stringify(reviewHits)
  );
  check(
    "只有 1 条 PENDING 取消申请时待审计数不变（与取消申请多寡解耦）",
    (() => {
      run(`DELETE FROM cancel_requests WHERE hotel_id = ? AND room_no = 'R903'`, [H]);
      const after = hitRooms(pendingFrag);
      return JSON.stringify(after) === JSON.stringify(reviewHits) && after.length === 1;
    })(),
    "待审计数随取消申请变化"
  );
  check(
    "APPROVED / REJECTED 的审核结果不计入「待审」",
    !!reviewHits && !reviewHits.includes("R902") && !reviewHits.includes("R903") && reviewHits.includes("R901"),
    JSON.stringify(reviewHits)
  );
  check(
    "DOING（尚未提交验收）不计入「待审」",
    !!reviewHits && !reviewHits.includes("R904"),
    JSON.stringify(reviewHits)
  );
  check(
    "非「打扫」任务（维修）的 PENDING_REVIEW 不计入「待审」",
    !!reviewHits && !reviewHits.includes("R905"),
    JSON.stringify(reviewHits)
  );
  check(
    "行字段片段与统计片段同口径（同一间房同时被判定为待审）",
    (() => {
      if (!pendingFieldFrag) return false;
      const fieldHits = hitRooms(`(${pendingFieldFrag}) > 0`);
      return JSON.stringify(fieldHits) === JSON.stringify(reviewHits);
    })(),
    `行字段=${pendingFieldName}`
  );

  /* 真实酒店 1 数据兜底 */
  const realReviewHits = hitRooms(`(${pendingFrag ?? "0"})`, 1);
  const realPendingReview = all(
    `SELECT DISTINCT hk.room_id AS id FROM housekeeping hk
      WHERE hk.hotel_id = 1 AND hk.task_type = '打扫' AND hk.review_status = 'PENDING_REVIEW'`
  ).length;
  check(
    "真实酒店 1「待审」房间数 = 真实 PENDING_REVIEW 打扫任务覆盖的房间数",
    realReviewHits.length === realPendingReview,
    `标签=${realReviewHits.length} 直接统计=${realPendingReview}`
  );
  console.log(
    `   ℹ 真实库：待审 ${realReviewHits.length} 间（PENDING_REVIEW 打扫任务 ${realPendingReview} 条）· 取消申请共 ${
      one(`SELECT COUNT(*) AS c FROM cancel_requests WHERE hotel_id = 1 AND status = 'PENDING'`).c
    } 条 PENDING`
  );
} catch (e) {
  check("副本内造数与查询执行成功", false, e.message);
} finally {
  copy.close();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
