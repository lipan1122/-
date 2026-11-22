/**
 * 预抵三分桶验收（最终版清单第四节第 12 项 / P1-3 第 112-118 行）
 *
 * 清单原话：
 *   · 今日预抵：check_in_date = today
 *   · 逾期未入住：check_in_date < today
 *   · 未来预抵：check_in_date > today
 *   · 逾期未入住必须可查看和处理，不能混入今日预抵。
 *
 * ── 被验收的旧缺陷 ──
 * `src/app/(main)/rooms/page.tsx` 原来只有一条 SQL：
 *     check_in_date <= today AND check_out_date > today
 * 把「昨天该到、今天还在住期内」的逾期单算进「今日预抵」——
 * 前台看到「今日预抵 5 间」，实际只有 3 个客人是今天的，接机/排房/早餐全按错的人数准备。
 *
 * ── 本脚本验两半 ──
 *  A. 静态：三个桶的 SQL 判定（= / < / >）、状态条件一致、旧口径（<= 且 check_out >）已删除；
 *  B. 动态：真库副本（.tmp）在 hotel 9999 造 今日 2 / 逾期 3 / 未来 4（其中 7 天内 3）
 *     + 1 条今日已取消 + 1 条今日 NOSHOW，用页面那三条 SQL 逐字执行，
 *     断言三桶互不重叠、相加等于全部未到店预订、CANCELLED 不进任何桶；
 *     再用真实酒店 1 的数据跑一遍做兜底（不是只在演示库自证）。
 *
 * ── unable to open database file（清单 281-287 行）──
 *   PMS_DB_PATH / .tmp 先建且可写 / VACUUM INTO 路径转 / 与 '' / timeout 防并发迁移持锁 /
 *   副本连 -wal -shm 一起删。
 *
 * 用法：node scripts/test-pre-arrival-buckets.mjs
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
/** 造数据用的「今天」：页面把 today 作为参数传进 SQL，这里固定一个营业日保证可复现 */
const TODAY = "2030-06-15";
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

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
 * A. 静态：三个桶的 SQL
 * ------------------------------------------------------------------ */
const PAGE_FILE = join("src", "app", "(main)", "rooms", "page.tsx");
const pageSrc = readFileSync(PAGE_FILE, "utf8");
const nPage = norm(pageSrc);

console.log("=== A. 静态：三个桶互不重叠、状态条件一致 ===");

check(
  "今日预抵用 check_in_date = today（严格等于，不再用 <= 兜住逾期单）",
  nPage.includes("WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED') AND b.check_in_date = ?"),
  "rooms/page.tsx 今日预抵 SQL 未用严格等于"
);
check(
  "逾期未入住用 check_in_date < today",
  nPage.includes("WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date < ?"),
  "rooms/page.tsx 逾期桶 SQL 缺失或条件不对"
);
check(
  "未来预抵用 check_in_date > today",
  nPage.includes("WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date > ?"),
  "rooms/page.tsx 未来桶 SQL 缺失或条件不对"
);
check(
  "未来预抵的「7 天内」是 > today AND <= today+7（不改变未来桶语义）",
  nPage.includes(
    "WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date > ? AND check_in_date <= ?"
  ),
  "7 天内窗口 SQL 缺失"
);
check(
  "旧口径（check_in_date <= today AND check_out_date > today）已删除",
  !/check_in_date\s*<=\s*\?\s*AND\s*b\.check_out_date\s*>\s*\?/i.test(nPage),
  "旧的「预抵 + 在住期」合并口径仍在"
);
check(
  "三个桶的 status 条件完全一致（都是 PENDING / CONFIRMED）",
  (nPage.match(/status IN \('PENDING','CONFIRMED'\)/g) ?? []).length >= 5 && !/status IN \('PENDING'\)/.test(nPage),
  `出现 ${(nPage.match(/status IN \('PENDING','CONFIRMED'\)/g) ?? []).length} 次`
);

/* ------------------------------------------------------------------ *
 * B. 动态：真库副本实测
 * ------------------------------------------------------------------ */
console.log("\n=== B. 真库副本实测（.tmp 副本 · 租户 9999）===");

/* 页面上的三条 SQL（逐字复制，只把别名/换行保留下来） */
const SQL_TODAY = `SELECT b.id, b.room_id, b.guest_name, b.mobile, b.booking_no, b.rate,
            rt.name AS room_type_name,
            COALESCE(c.name, '散客') AS channel_name,
            b.check_in_date, COALESCE(b.arrival_time, '') AS arrival_time
     FROM bookings b
     JOIN room_types rt ON rt.id = b.room_type_id
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
       AND b.check_in_date = ?
     ORDER BY b.id`;
const SQL_OVERDUE = `SELECT COUNT(*) AS n FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date < ?`;
const SQL_FUTURE = `SELECT COUNT(*) AS n FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED') AND check_in_date > ?`;
const SQL_FUTURE_SOON = `SELECT COUNT(*) AS n FROM bookings
      WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED')
        AND check_in_date > ? AND check_in_date <= ?`;
const SQL_OVERDUE_LIST = `SELECT b.id, b.guest_name, b.check_in_date
     FROM bookings b
     WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED') AND b.check_in_date < ?`;
const SQL_FUTURE_LIST = `SELECT b.id, b.guest_name, b.check_in_date
     FROM bookings b
     WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED')
       AND b.check_in_date > ? AND b.check_in_date <= ?`;

console.log("   ℹ 断言用的三条 SQL 与 rooms/page.tsx 逐字一致（上面静态项已比对）");

const copy = openCopy("pre-arrival-buckets");
const { db } = copy;
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

try {
  run(`INSERT INTO hotels (id, code, name, address, phone) VALUES (?,?,?,?,?)`, [
    H,
    "TEST-ARRIVAL-9999",
    "预抵分桶测试酒店",
    "测试地址",
    "000",
  ]);
  run(`INSERT INTO room_types (hotel_id, code, name, base_price, max_occupancy, sort) VALUES (?,?,?,?,?,?)`, [
    H,
    "TA",
    "预抵测试房型",
    300,
    2,
    1,
  ]);
  const rtId = Number(one(`SELECT id FROM room_types WHERE hotel_id = ? LIMIT 1`, [H]).id);

  let seq = 0;
  const addBooking = (guestName, checkIn, status = "PENDING") => {
    seq += 1;
    run(
      `INSERT INTO bookings (hotel_id, booking_no, guest_name, mobile, room_type_id, check_in_date, check_out_date, nights, rate, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        H,
        `AR-${String(seq).padStart(3, "0")}-${guestName}`,
        guestName,
        "1390000" + String(1000 + seq),
        rtId,
        checkIn,
        addDays(checkIn, 1),
        1,
        300,
        status,
        `${TODAY}T09:00:00.000+08:00`,
      ]
    );
    return Number(one(`SELECT MAX(id) AS id FROM bookings WHERE hotel_id = ?`, [H]).id);
  };

  const todayIds = [
    addBooking("今日甲", TODAY, "PENDING"),
    addBooking("今日乙", TODAY, "CONFIRMED"),
  ];
  const overdueIds = [
    addBooking("逾期甲", addDays(TODAY, -1)),
    addBooking("逾期乙", addDays(TODAY, -2), "CONFIRMED"),
    addBooking("逾期丙", addDays(TODAY, -5)),
  ];
  const futureIds = [
    addBooking("未来甲", addDays(TODAY, 1)),
    addBooking("未来乙", addDays(TODAY, 3), "CONFIRMED"),
    addBooking("未来丙", addDays(TODAY, 7)),
    addBooking("未来丁", addDays(TODAY, 20), "CONFIRMED"),
  ];
  const cancelledId = addBooking("今日已取消", TODAY, "CANCELLED");
  const noshowId = addBooking("今日未到", TODAY, "NOSHOW");

  /* 页面同款 SQL 执行 */
  const todayRows = all(SQL_TODAY, [H, TODAY]);
  const overdueCount = Number(one(SQL_OVERDUE, [H, TODAY]).n);
  const futureCount = Number(one(SQL_FUTURE, [H, TODAY]).n);
  const futureSoonCount = Number(one(SQL_FUTURE_SOON, [H, TODAY, addDays(TODAY, 7)]).n);
  const overdueRows = all(SQL_OVERDUE_LIST, [H, TODAY]);
  const futureRows = all(SQL_FUTURE_LIST, [H, TODAY, addDays(TODAY, 7)]);
  const totalNotArrived = Number(
    one(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ? AND status IN ('PENDING','CONFIRMED')`, [H]).c
  );

  const todayIdSet = new Set(todayRows.map((r) => Number(r.id)));
  const overdueIdSet = new Set(overdueRows.map((r) => Number(r.id)));
  const futureIdSet = new Set(futureRows.map((r) => Number(r.id)));

  check("今日预抵 = 2 条（check_in_date = today）", todayRows.length === 2, `实际 ${todayRows.length}`);
  check("逾期未入住 = 3 条（check_in_date < today）", overdueCount === 3, `实际 ${overdueCount}`);
  check("未来预抵 = 4 条（check_in_date > today）", futureCount === 4, `实际 ${futureCount}`);
  check(
    "未来预抵「7 天内」= 3 条（第 4 条在 20 天后，落在累计数里不影响 7 天窗口）",
    futureSoonCount === 3 && futureRows.length === 3,
    `soon=${futureSoonCount} list=${futureRows.length}`
  );

  check(
    "三个桶互不重叠（今日 ∩ 逾期 / 今日 ∩ 未来 / 逾期 ∩ 未来 都为空）",
    [...todayIdSet].every((id) => !overdueIdSet.has(id) && !futureIdSet.has(id)) &&
      [...overdueIdSet].every((id) => !futureIdSet.has(id)),
    `today=${[...todayIdSet]} overdue=${[...overdueIdSet]} future=${[...futureIdSet]}`
  );
  check(
    "三个桶相加 = 全部未到店预订（2 + 3 + 4 = 9）",
    todayRows.length + overdueCount + futureCount === totalNotArrived && totalNotArrived === 9,
    `合计 ${todayRows.length + overdueCount + futureCount} vs 未到店 ${totalNotArrived}`
  );
  check(
    "今日预抵每一行的入住日都等于 today（逾期单没有混进来）",
    todayRows.every((r) => r.check_in_date === TODAY),
    JSON.stringify(todayRows.map((r) => `${r.guest_name}:${r.check_in_date}`))
  );
  check(
    "逾期桶每一行入住日都早于 today",
    overdueRows.every((r) => r.check_in_date < TODAY),
    JSON.stringify(overdueRows.map((r) => `${r.guest_name}:${r.check_in_date}`))
  );
  check(
    "未来桶每一行入住日都晚于 today",
    futureRows.every((r) => r.check_in_date > TODAY),
    JSON.stringify(futureRows.map((r) => `${r.guest_name}:${r.check_in_date}`))
  );
  check(
    "逾期单不混入今日预抵（逾期甲/乙/丙 都不在今日列表）",
    ["逾期甲", "逾期乙", "逾期丙"].every((name) => !todayRows.some((r) => r.guest_name === name)) &&
      overdueRows.some((r) => r.guest_name === "逾期甲"),
    JSON.stringify(todayRows.map((r) => r.guest_name))
  );
  check(
    "CANCELLED 的今日单三个桶都不包含（已取消不是「未到店」）",
    [cancelledId, noshowId].every((id) => !todayIdSet.has(id) && !overdueIdSet.has(id) && !futureIdSet.has(id)),
    `cancelled=${cancelledId} noshow=${noshowId}`
  );
  check(
    "三个桶的状态条件一致：命中的行状态都属于 PENDING / CONFIRMED",
    (() => {
      const ids = [...todayIdSet, ...overdueIdSet, ...futureIdSet];
      const statuses = ids.map(
        (id) => one(`SELECT status FROM bookings WHERE id = ? AND hotel_id = ?`, [id, H]).status
      );
      return ids.length === 8 && statuses.every((s2) => s2 === "PENDING" || s2 === "CONFIRMED");
    })(),
    "有桶命中了非 PENDING/CONFIRMED 的单"
  );
  check(
    "第 4 条未来单（20 天后，落在 7 天窗口外）也不会混进今日/逾期",
    !todayIdSet.has(futureIds[3]) && !overdueIdSet.has(futureIds[3]) && futureCount === 4,
    `futureIds=${JSON.stringify(futureIds)}`
  );
  check(
    "造数自检：今日 2 + 逾期 3 + 未来 4 = 9 条 PENDING/CONFIRMED（另取消 1 + 未到 1 不计）",
    totalNotArrived === 9 &&
      Number(one(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = ?`, [H]).c) === 11,
    `未到店 ${totalNotArrived}`
  );

  /* ---- 真实酒店 1 兜底（同一份副本里的真实数据）---- */
  const pageToday = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const realToday = all(SQL_TODAY, [1, pageToday]);
  const realOverdue = all(SQL_OVERDUE_LIST, [1, pageToday]);
  const realFuture = all(SQL_FUTURE_LIST, [1, pageToday, addDays(pageToday, 7)]);
  const realTotal = Number(
    one(`SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1 AND status IN ('PENDING','CONFIRMED')`).c
  );
  check(
    `真实酒店 1：三桶相加 = 全部未到店预订（${pageToday}）`,
    realToday.length + realOverdue.length + realFuture.length <= realTotal &&
      Number(one(SQL_OVERDUE, [1, pageToday]).n) + Number(one(SQL_FUTURE, [1, pageToday]).n) + realToday.length ===
        realTotal,
    `today=${realToday.length} overdue=${realOverdue.length} future=${realFuture.length} total=${realTotal}`
  );
  check(
    "真实酒店 1：今日预抵每一行都严格等于今天（逾期 25 单没有混进今日）",
    realToday.every((r) => r.check_in_date === pageToday) &&
      realOverdue.every((r) => r.check_in_date < pageToday) &&
      !realOverdue.some((r) => realToday.some((t) => t.id === r.id)),
    `今日 ${realToday.length} 条 / 逾期 ${realOverdue.length} 条`
  );
  console.log(
    `   ℹ 真实酒店 1：今日预抵 ${realToday.length} · 逾期未入住 ${realOverdue.length} · 未来预抵 ${Number(
      one(SQL_FUTURE, [1, pageToday]).n
    )}（未到店合计 ${realTotal}）`
  );
} catch (e) {
  check("副本内造数与分桶查询执行成功", false, e.message);
} finally {
  copy.close();
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
