/**
 * 夜审前后出租率一致性验收（最终版清单第四节第 11 项 / 第 333 行阻断条件）
 *
 * ── 被验收的口径 ──
 * 「页面口径」= src/lib/metrics.ts occupancyOfDay：
 *     可售房量 = 总房量 − 维修房(OOO) − 锁房(LOCK)
 *     出租间夜 = Σ 在住晚数（排除钟点房）
 *     出租率  = 出租间夜 / 可售房量
 * 夜审（night-audit/actions.ts）必须写同一个数进 night_audits.occupancy，
 * 否则「店长早上看工作台一个数、夜审日报另一个数」——这是清单反复点名的毛病。
 *
 * ── 本脚本验两半 ──
 *  A. 静态：两处 SQL 逐字同口径（页面房量 SQL / 页间夜 SQL / 夜审可售房量 SQL /
 *     夜审间夜 SQL），且夜审 occupancy 分母是可售房量而不是总房量；
 *  B. 动态：真库副本（.tmp）在 hotel 9999 造 46 间房（2 间 OOO + 1 间 LOCK → 可售 43），
 *     21 间在住 1 晚 + 2 间钟点房，分别用页面 SQL 与夜审 SQL 算出租率，
 *     断言两者到 6 位小数完全相同，且分母确实是 43 不是 46。
 *
 * ── unable to open database file（清单 281-287 行）──
 *   PMS_DB_PATH / .tmp 先建且可写 / VACUUM INTO 路径转 / 与 '' / timeout 防并发迁移持锁 /
 *   副本连 -wal -shm 一起删。
 *
 * 用法：node scripts/test-night-audit-occupancy.mjs
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
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const norm = (s) => s.replace(/\s+/g, " ").trim();
/** 6 位小数比较（清单要求浮点比到 6 位） */
const six = (n) => Number(n).toFixed(6);

const REAL_DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? join(process.cwd(), ".tmp");
const H = 9999;
const BIZ = "2030-06-15";
const NEXT = "2030-06-16";

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
        `  排查：PMS_DB_PATH / .tmp 写权限 / 路径分隔符与引号转义 / 残留 -wal 占用`
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
 * A. 静态：页面口径与夜审口径必须逐字一致
 * ------------------------------------------------------------------ */

/** 页面（src/lib/metrics.ts）房量 SQL：总数 + 可售数 */
const METRICS_ROOMS_SQL = `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
       FROM rooms WHERE hotel_id = ?`;

/** 页面（src/lib/metrics.ts）出租间夜 SQL：闭区间、在住算到今天、排除钟点房 */
const METRICS_NIGHTS_SQL = `SELECT COALESCE(SUM(
              MAX(0,
                  MIN(
                    julianday(CASE WHEN s.status = 'INHOUSE' THEN date(?, '+1 day') ELSE s.expect_check_out END),
                    julianday(date(?, '+1 day'))
                  )
                  - MAX(julianday(substr(s.check_in_time,1,10)), julianday(?))
              )
            ), 0) AS nights
       FROM stays s
      WHERE s.hotel_id = ?
        AND s.status IN ('INHOUSE','CHECKED_OUT')
        AND COALESCE(s.rate_code,'') <> '钟点'
        AND (
              (substr(s.check_in_time,1,10) <= ?
               AND COALESCE(s.expect_check_out, substr(s.check_in_time,1,10)) > ?)
           OR (s.status = 'INHOUSE' AND substr(s.check_in_time,1,10) <= ?)
        )`;

/** 夜审（night-audit/actions.ts）可售房量 SQL */
const AUDIT_SELLABLE_SQL = `SELECT COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
           FROM rooms WHERE hotel_id = ?`;

/** 夜审（night-audit/actions.ts）出租间夜 SQL */
const AUDIT_ROOM_NIGHTS_SQL = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND COALESCE(s.nights, 0) > 0
   AND COALESCE(s.rate_code, '') <> '钟点'`;

const METRICS_FILE = join("src", "lib", "metrics.ts");
const AUDIT_FILE = join("src", "app", "(main)", "night-audit", "actions.ts");
const metricsSrc = readFileSync(METRICS_FILE, "utf8");
const auditSrc = readFileSync(AUDIT_FILE, "utf8");
const nMetrics = norm(metricsSrc);
const nAudit = norm(auditSrc);

console.log("=== A. 静态：页面口径 == 夜审口径 ===");

check(
  "页面房量 SQL 与源码一致（可售 = 总数 − OOO − LOCK）",
  nMetrics.includes(norm(METRICS_ROOMS_SQL)),
  "metrics.ts 房量 SQL 已变，请同步本脚本"
);
check(
  "页面出租间夜 SQL 与源码一致（排除钟点房、在住算到今天）",
  nMetrics.includes(norm(METRICS_NIGHTS_SQL)),
  "metrics.ts 间夜 SQL 已变，请同步本脚本"
);
check(
  "夜审可售房量 SQL 与页面同口径（同样扣 OOO / LOCK）",
  nAudit.includes(norm(AUDIT_SELLABLE_SQL)),
  "night-audit/actions.ts 可售房量 SQL 已变"
);
check(
  "夜审出租间夜 SQL 与页面同口径（在住 + nights>0 + 非钟点）",
  nAudit.includes(norm(AUDIT_ROOM_NIGHTS_SQL)),
  "night-audit/actions.ts 出租间夜 SQL 已变"
);
check(
  "夜审出租率分母是可售房量 sellableRooms，不是总房量 totalRooms",
  /const\s+sellableRooms\s*=[\s\S]{0,220}FROM\s+rooms\s+WHERE\s+hotel_id\s*=\s*\?/i.test(auditSrc) &&
    /const\s+occupancy\s*=\s*sellableRooms\s*>\s*0\s*\?\s*roomNights\s*\/\s*sellableRooms\s*:\s*0/.test(auditSrc) &&
    !/occupancy\s*=\s*roomNights\s*\/\s*totalRooms/.test(auditSrc),
  (auditSrc.match(/const occupancy =[^;]{0,120};/) ?? [""])[0]
);
check(
  "夜审把 occupancy / rooms_sold / hourly_rooms 一起落库",
  /INSERT INTO night_audits[\s\S]{0,200}occupancy/.test(auditSrc) && /rooms_sold/.test(auditSrc) && /hourly_rooms/.test(auditSrc),
  "夜审未写 occupancy"
);

/* ------------------------------------------------------------------ *
 * B. 动态：46 间房、2 OOO + 1 LOCK、21 在住 + 2 钟点
 * ------------------------------------------------------------------ */
console.log("\n=== B. 真库副本实测（.tmp 副本 · 租户 9999 · 46 间房）===");

const copy = openCopy("night-audit-occupancy");
const { db } = copy;
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

try {
  run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [
    H,
    "TEST-OCC-9999",
    "出租率测试酒店",
    "测试地址",
    "000",
  ]);
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
    H,
    "TO",
    "出租率测试房型",
    300,
    2,
    1,
  ]);
  const rtId = Number(one(`SELECT id FROM room_types WHERE hotel_id = ? LIMIT 1`, [H]).id);

  const TOTAL = 46;
  const roomIds = [];
  for (let i = 1; i <= TOTAL; i += 1) {
    /* 1..21 在住（OC）、22..23 钟点（OC）、44..45 OOO、46 LOCK，其余 VC */
    let status = "VC";
    if (i <= 23) status = "OC";
    else if (i === 44 || i === 45) status = "OOO";
    else if (i === 46) status = "LOCK";
    run(`INSERT INTO rooms (hotel_id, room_type_id, room_no, floor, status, sort) VALUES (?,?,?,?,?,?)`, [
      H,
      rtId,
      `O${String(i).padStart(3, "0")}`,
      Math.ceil(i / 20),
      status,
      1,
    ]);
    roomIds.push(Number(one(`SELECT MAX(id) AS id FROM rooms WHERE hotel_id = ?`, [H]).id));
  }

  let seq = 0;
  const addStay = (roomIdx, nights, rateCode, status = "INHOUSE") => {
    seq += 1;
    run(
      `INSERT INTO stays (hotel_id, stay_no, room_id, guest_name, check_in_time, expect_check_out, nights, rate, status, rate_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        `SO-${seq}`,
        roomIds[roomIdx],
        `出租率客${seq}`,
        `${BIZ}T14:00:00.000+08:00`,
        NEXT,
        nights,
        300,
        status,
        rateCode,
        `${BIZ}T14:00:00.000+08:00`,
      ]
    );
  };
  /* 21 间过夜在住（每单 1 晚，rate_code = 门市价） */
  for (let i = 0; i < 21; i += 1) addStay(i, 1, "门市价");
  /* 2 间钟点房：nights = 0 / rate_code = '钟点'，占着房间但不算间夜 */
  addStay(21, 0, "钟点");
  addStay(22, 2, "钟点");

  /* ---- 页面口径（metrics.ts 的两条 SQL 逐字执行）---- */
  const roomRow = one(METRICS_ROOMS_SQL, [H]);
  const totalRooms = Number(roomRow.total);
  const sellableRooms = Number(roomRow.sellable);

  /* 参数顺序（与 metrics.ts 调用一致）：[to, to, from, hotelId, to, from, to] */
  const from = BIZ;
  const to = BIZ;
  const nightRow = one(METRICS_NIGHTS_SQL, [to, to, from, H, to, from, to]);
  const pageRoomNights = Math.max(0, Math.round(Number(nightRow?.nights ?? 0)));
  const days = 1;
  const pageRoomsSold = round2(pageRoomNights / days);
  const X = sellableRooms > 0 ? pageRoomsSold / sellableRooms : 0;

  console.log(`   总房量 ${totalRooms} · 可售 ${sellableRooms} · 页面出租间夜 ${pageRoomNights}`);
  check("总房量 = 46", totalRooms === 46, `实际 ${totalRooms}`);
  check(
    "可售房量 = 43（2 间 OOO + 1 间 LOCK 被扣掉）",
    sellableRooms === 43 && totalRooms - sellableRooms === 3,
    `可售 ${sellableRooms}（总 ${totalRooms}）`
  );
  check(
    "钟点房不计出租间夜：在住 23 单，间夜仍是 21",
    pageRoomNights === 21 &&
      Number(one(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [H]).c) === 23,
    `间夜 ${pageRoomNights}`
  );
  check(
    "页面口径出租率 X = 21 / 43（约 0.488372）",
    six(X) === six(21 / 43),
    `X=${six(X)}`
  );
  check(
    "分母确实是 43 不是 46：X ≠ 21/46",
    six(X) !== six(21 / 46),
    `X=${six(X)} 21/46=${six(21 / 46)}`
  );

  /* ---- 执行夜审写入 SQL（与 actions.ts 同口径）---- */
  const auditSellable = Number(one(AUDIT_SELLABLE_SQL, [H]).sellable);
  const auditRoomNights = Number(one(AUDIT_ROOM_NIGHTS_SQL, [H]).v);
  const hourlyRooms = Number(
    one(
      `SELECT COUNT(*) AS v FROM stays s
        WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
          AND (COALESCE(s.nights, 0) <= 0 OR COALESCE(s.rate_code, '') = '钟点')`,
      [H]
    ).v
  );
  const Y = auditSellable > 0 ? auditRoomNights / auditSellable : 0;

  run(
    `INSERT INTO night_audits
       (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
        revenue_room, revenue_food, revenue_other, refund_total, revenue_net, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [H, BIZ, "DONE", auditRoomNights, hourlyRooms, 0, Y, 0, 0, 0, 0, 0, "测试夜审", `${BIZ}T23:59:00.000+08:00`]
  );
  const auditRow = one(`SELECT * FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, BIZ]);

  check("夜审可售房量 SQL 也算出 43（与页面同一分母）", auditSellable === 43, `实际 ${auditSellable}`);
  check("夜审出租间夜 SQL 也算出 21（与页面同一分子）", auditRoomNights === 21, `实际 ${auditRoomNights}`);
  check(
    "夜审前后出租率一致：X === Y（浮点比到 6 位小数）",
    six(X) === six(Number(auditRow.occupancy)) && six(Y) === six(X),
    `X=${six(X)} Y=${six(auditRow.occupancy)}`
  );
  check(
    "夜审落库的 occupancy 分母是 43 不是 46",
    six(Number(auditRow.occupancy)) !== six(21 / 46),
    `occupancy=${six(auditRow.occupancy)} 21/46=${six(21 / 46)}`
  );
  check("夜审 rooms_sold = 21（出租间夜，不是 23 单在住）", Number(auditRow.rooms_sold) === 21, `实际 ${auditRow.rooms_sold}`);
  check("夜审 hourly_rooms = 2（钟点房单独留痕，不混进间夜）", Number(auditRow.hourly_rooms) === 2, `实际 ${auditRow.hourly_rooms}`);

  /* 幂等：同一天重复夜审被唯一键挡住，出租率不会被重复累加 */
  let dupErr = null;
  try {
    run(
      `INSERT INTO night_audits (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [H, BIZ, "DONE", 999, 0, 0, 0.99, "重复夜审", `${BIZ}T23:59:30.000+08:00`]
    );
  } catch (e) {
    dupErr = e;
  }
  const rows = Number(one(`SELECT COUNT(*) AS c FROM night_audits WHERE hotel_id = ? AND biz_date = ?`, [H, BIZ]).c);
  check(
    "同一天重复夜审被 UNIQUE(hotel_id, biz_date) 拒绝，出租率不被覆盖/累加",
    /UNIQUE/i.test(String(dupErr?.message ?? "")) && rows === 1,
    `${String(dupErr?.message ?? "未报错")} rows=${rows}`
  );
} catch (e) {
  check("副本内造数与夜审流程执行成功", false, e.message);
} finally {
  copy.close();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
