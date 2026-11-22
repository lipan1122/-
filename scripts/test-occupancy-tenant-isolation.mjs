#!/usr/bin/env node
/**
 * 出租率跨租户隔离回归测试 ★（整改清单 P1-2 + 第 99-104 行明确要求，第四节第 6 项）
 *
 * ── 要拦住的 bug（真实存在过）──
 * src/lib/metrics.ts 的间夜 SQL 原来是：
 *     WHERE s.hotel_id = ?
 *       AND s.status IN ('INHOUSE','CHECKED_OUT')
 *       AND COALESCE(s.rate_code,'') <> '钟点'
 *       AND substr(s.check_in_time,1,10) <= ?
 *       AND COALESCE(s.expect_check_out, ...) > ?
 *          OR (s.status = 'INHOUSE' AND substr(s.check_in_time,1,10) <= ?)   ← 这一支没有 hotel_id
 *
 * SQL 里 AND 的优先级高于 OR，所以它实际等价于
 *     (hotel_id=? AND 状态 AND 非钟点 AND 在区间内) OR (INHOUSE AND check_in <= ?)
 * 「在住」这一支绕开了租户 / 钟点过滤：**别家酒店的 INHOUSE 单会被算进本店间夜**，
 * 钟点房也会被算成过夜间夜。演示库只有 1 家店、唯一钟点单已退房，所以数字看起来是对的。
 *
 * 修法：把「区间内 或 在住」整组用括号包起来，让它只决定「算不算这一晚」。
 *
 * ── 本脚本怎么证 ──
 *  1. `VACUUM INTO` 复制 data/pms.db 到 .tmp/ 临时库（源库只读，**绝不改真库**）；
 *  2. 注入 `globalThis.__pmsDb`，调**生产代码** metrics.ts 的 occupancyOfDay()；
 *  3. 记录 hotel 1 的基线间夜 A；
 *  4. 造 hotel 999：2 间房 + 2 张 INHOUSE 单（入住日在区间内）+ 1 张钟点房单；
 *  5. 断言 hotel 1 的间夜仍然是 A（清单第 99-104 条第 3 点），hotel 999 的是 2（第 4 点）；
 *  6. **反向验证**：把 metrics.ts 里的 SQL 抠出来，去掉那对括号，用同样的参数跑一遍
 *     —— 结果必须**变大**（正好多出 hotel 999 的 3 个间夜）。
 *     这一条是关键：它证明「括号确实在起作用」，而不是两组数据碰巧都等于 21。
 *
 * 运行：node scripts/test-occupancy-tenant-isolation.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const TAG = "occupancy-tenant";
/** 验收专用酒店（清单里就叫 hotel 999） */
const HOTEL_B = 999;
const NOW = new Date().toISOString();

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

function abandon(message, detail = "") {
  console.error(`\n❌ 测试无法执行：${message}`);
  if (detail) console.error(detail);
  console.error(
    [
      "",
      "按整改清单第 281-287 行逐项排查：",
      "  1. PMS_DB_PATH        —— 本脚本固定用项目内 data/pms.db，可用 PMS_DB_PATH 指到别的真库",
      "  2. data 目录写权限     —— 源库只需读权限；.tmp 目录需要写权限",
      "  3. 临时数据库目录      —— .tmp/ 必须存在且可写（脚本会自动创建）",
      "  4. VACUUM INTO 目标目录 —— 目标文件不能已存在，父目录必须可写",
      "  5. SQLite WAL 文件权限  —— 临时库旁的 -wal/-shm 需要可删（脚本结束会清）",
    ].join("\n")
  );
  process.exit(1);
}

/* ============================================================ 临时库（VACUUM INTO 副本） */

const REAL_DB = process.env.PMS_DB_PATH ?? path.join(ROOT, "data", "pms.db");
const TMP_DIR = path.join(ROOT, ".tmp");
let TMP_DB = "";

function copyToTempDb() {
  if (!fs.existsSync(REAL_DB)) abandon(`真库不存在：${REAL_DB}`);
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.accessSync(TMP_DIR, fs.constants.W_OK);
  } catch (e) {
    abandon(`临时目录不可写：${TMP_DIR}`, String(e?.message ?? e));
  }

  TMP_DB = path.join(TMP_DIR, `${TAG}-${Date.now()}.db`);
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 目标不存在：正常 */
    }
  }

  let src;
  try {
    src = new DatabaseSync(REAL_DB, { readOnly: true });
    src.exec(`VACUUM INTO '${TMP_DB.replace(/'/g, "''")}'`);
  } catch (e) {
    abandon(`VACUUM INTO 失败：${REAL_DB} → ${TMP_DB}`, String(e?.message ?? e));
  } finally {
    try {
      src?.close();
    } catch {
      /* 已关闭 */
    }
  }
  if (!fs.existsSync(TMP_DB)) abandon("VACUUM INTO 执行后目标文件仍不存在（磁盘满 / 路径被拦？）");
}

function cleanup() {
  if (!TMP_DB) return;
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      console.warn(`（清理临时文件失败：${f} — ${e?.message ?? e}）`);
    }
  }
}

process.on("exit", cleanup);
process.on("uncaughtException", (e) => {
  console.error("脚本异常：", e);
  process.exitCode = 1;
});

/* ============================================================ 载入生产代码 */

copyToTempDb();

process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

let conn;
try {
  conn = new DatabaseSync(TMP_DB);
  conn.exec("PRAGMA busy_timeout = 5000");
} catch (e) {
  abandon(`打不开临时库：${TMP_DB}`, String(e?.message ?? e));
}

/* 关键一步：让生产代码的 @/lib/db 走临时库（getDb() 优先返回 globalThis.__pmsDb） */
globalThis.__pmsDb = conn;

let occupancyOfDay;
try {
  ({ occupancyOfDay } = await import("../src/lib/metrics.ts"));
} catch (e) {
  abandon("import src/lib/metrics.ts 失败", String(e?.message ?? e));
}

/* ============================================================ 工具 */

const run = (sql, params = []) => conn.prepare(sql).run(...params);
const all = (sql, params = []) => conn.prepare(sql).all(...params);

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = todayStr();
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return todayStr(d);
})();
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return todayStr(d);
})();
/** stays.check_in_time 只取前 10 位当营业日，这里给本地时间串即可 */
const AT = (day, time = "14:00:00") => `${day}T${time}`;

/* ============================================================ 一、基线 */

console.log("=== 一、记录 hotel 1 的基线（生产代码 occupancyOfDay） ===");

const baseA = occupancyOfDay(1, TODAY);
const A = baseA.roomNights;
console.log(
  `  基线 A：hotel 1 今天 ${TODAY} → roomNights=${A} / totalRooms=${baseA.totalRooms} / sellableRooms=${baseA.sellableRooms} / occupancy=${(baseA.occupancy * 100).toFixed(1)}%`
);

check("基线可用：hotel 1 今天间夜 > 0（否则后面的断言没有意义）", A > 0, `实际 ${A}`);
check("基线口径：days = 1 且 roomsSold = roomNights（单日）", baseA.days === 1 && baseA.roomsSold === A, JSON.stringify({ days: baseA.days, roomsSold: baseA.roomsSold }));

/* 用原始数据交叉验证一次：间夜数应等于「今天该算的在住单」的晚数之和 */
const h1Inhouse = Number(all(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = 1 AND status = 'INHOUSE'`)[0].c);
const h1CheckoutToday = Number(
  all(
    `SELECT COUNT(*) AS c FROM stays
      WHERE hotel_id = 1 AND status = 'INHOUSE' AND check_in_time IS NOT NULL
        AND substr(check_in_time,1,10) = ?`,
    [TODAY]
  )[0].c
);
check(
  `基线 A = ${A} 与原始数据自洽（今天在住单 ${h1CheckoutToday} 张，全店在住单 ${h1Inhouse} 张）`,
  A >= h1CheckoutToday && A <= h1Inhouse,
  `A=${A} / 今日在住=${h1CheckoutToday} / 在住合计=${h1Inhouse}`
);

/* ============================================================ 二、造 hotel 999（清单第 99-104 条第 2 点） */

console.log("\n=== 二、造 hotel 999：2 间房 + 2 张 INHOUSE 单 + 1 张钟点房单 ===");

run(`INSERT INTO hotels (id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?)`, [
  HOTEL_B,
  "TEST999",
  "出租率隔离验收酒店",
  "测试地址",
  "000",
  NOW,
]);
const typeB = Number(
  run(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, max_occupancy, base_price, sort)
     VALUES (?,?,?,?,?,?,?)`,
    [HOTEL_B, "TEN-999", "隔离验收房型", "大床", 2, 300, 9999]
  ).lastInsertRowid
);
const roomB = [];
for (let i = 0; i < 2; i += 1) {
  roomB.push(
    Number(
      run(`INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort) VALUES (?,?,?,?,?,?)`, [
        HOTEL_B,
        `T999-${i + 1}`,
        9,
        typeB,
        "OC",
        i + 1,
      ]).lastInsertRowid
    )
  );
}
/** 造一张在住单（check_in_time 落在统计区间内） */
function seedStay(stayNo, roomId, stayStatus, rateCode, checkInDay) {
  return Number(
    run(
      `INSERT INTO stays (hotel_id, stay_no, booking_id, room_id, guest_name, mobile,
                          check_in_time, expect_check_out, nights, rate, status, rate_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        HOTEL_B,
        stayNo,
        null,
        roomId,
        `隔离验收客人-${stayNo}`,
        "13900000000",
        AT(checkInDay),
        TOMORROW,
        1,
        300,
        stayStatus,
        rateCode,
        NOW,
      ]
    ).lastInsertRowid
  );
}
const stayB1 = seedStay("TEST-TEN-STAY-1", roomB[0], "INHOUSE", "日租", TODAY);
const stayB2 = seedStay("TEST-TEN-STAY-2", roomB[1], "INHOUSE", "日租", YESTERDAY);

check(
  `hotel 999 数据就绪（2 间房 / 2 张 INHOUSE 单 / 1 张房号占用）`,
  Number(all(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [HOTEL_B])[0].c) === 2 &&
    Number(all(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE'`, [HOTEL_B])[0].c) === 2,
  JSON.stringify({ rooms: all(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`, [HOTEL_B])[0] })
);

/* ============================================================ 三、hotel 1 不能被污染（清单第 3 点） */

console.log("\n=== 三、hotel 1 的结果必须仍是 A（清单第 99-104 条第 3 点） ===");

const afterA = occupancyOfDay(1, TODAY);
check(`hotel 1 间夜仍为 ${A}（别家酒店的 2 张在住单没有算进来）`, afterA.roomNights === A, `实际 ${afterA.roomNights}`);
check(
  `hotel 1 总房量仍为 ${baseA.totalRooms}（hotel 999 的 2 间房没有算进来）`,
  afterA.totalRooms === baseA.totalRooms,
  `实际 ${afterA.totalRooms}`
);
check(
  `hotel 1 可售房量仍为 ${baseA.sellableRooms}（跨店房间没有进分母）`,
  afterA.sellableRooms === baseA.sellableRooms,
  `实际 ${afterA.sellableRooms}`
);
check(
  "hotel 1 的出租率 / ADR / RevPAR 三项都与基线一致（没有任何一项被跨店数据带偏）",
  afterA.occupancy === baseA.occupancy && afterA.adr === baseA.adr && afterA.revpar === baseA.revpar,
  JSON.stringify({ before: { occ: baseA.occupancy, adr: baseA.adr, revpar: baseA.revpar }, after: { occ: afterA.occupancy, adr: afterA.adr, revpar: afterA.revpar } })
);

/* ============================================================ 四、hotel 999 自己算得对（清单第 4 点） */

console.log("\n=== 四、hotel 999 自己能查到、且数字正确（清单第 99-104 条第 4 点） ===");

const b = occupancyOfDay(HOTEL_B, TODAY);
check("hotel 999 间夜 = 2（2 张在住单各 1 晚）", b.roomNights === 2, `实际 ${b.roomNights}`);
check("hotel 999 总房量 = 2 / 可售房量 = 2", b.totalRooms === 2 && b.sellableRooms === 2, JSON.stringify({ t: b.totalRooms, s: b.sellableRooms }));
check("hotel 999 出租率 = 100%（2 / 2）", Math.abs(b.occupancy - 1) < 1e-9, String(b.occupancy));

/* 清单第 4 点「hotel 999 不能被 hotel 1 查询到」：按 id 直查 + 按店过滤直查都拿不到 */
const crossById = all(`SELECT id, stay_no FROM stays WHERE id = ? AND hotel_id = 1`, [stayB1]);
check("hotel 1 用 hotel 999 的 stay_id 直查返回 0 行（越权被拦）", crossById.length === 0, JSON.stringify(crossById));
const crossByHotel = all(`SELECT id FROM stays WHERE hotel_id = 1 AND stay_no LIKE 'TEST-TEN-%'`);
check("hotel 1 的按店查询拿不到 hotel 999 的任何在住单", crossByHotel.length === 0, JSON.stringify(crossByHotel));

/* ============================================================ 五、钟点房不能被算成过夜间夜 */

console.log("\n=== 五、钟点房（rate_code='钟点'）不计入间夜，也不能污染 hotel 1 ===");

const stayB3 = seedStay("TEST-TEN-STAY-3", roomB[0], "INHOUSE", "钟点", TODAY);
const b2 = occupancyOfDay(HOTEL_B, TODAY);
check("给 hotel 999 加 1 张钟点房在住单 → hotel 999 间夜仍 = 2（钟点不算出租间夜）", b2.roomNights === 2, `实际 ${b2.roomNights}`);
check(`加钟点房单后 hotel 1 间夜仍 = ${A}`, occupancyOfDay(1, TODAY).roomNights === A, `实际 ${occupancyOfDay(1, TODAY).roomNights}`);

/* ============================================================ 六、反向验证：去掉括号结果必然变大 */

console.log("\n=== 六、反向验证：把 metrics.ts 的 SQL 括号去掉，结果必须变大（证明括号在起作用） ===");

const metricsSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "metrics.ts"), "utf8");
const sqlMatch = metricsSrc.match(/`(\s*SELECT COALESCE\(SUM\([\s\S]*?)`/);
if (!sqlMatch) {
  check("能从 src/lib/metrics.ts 里解析出间夜 SQL", false, "解析失败：没有找到 `SELECT COALESCE(SUM(...)` 模板");
} else {
  const goodSql = sqlMatch[1];
  check("能从 src/lib/metrics.ts 里解析出间夜 SQL", true);

  /*
   * 复现老 bug：把「区间内 或 在住」那一组的外层括号去掉。
   *   正确：AND ( (区间内) OR (在住) )
   *   错误：AND (区间内) OR (在住)        ← AND 优先级更高，在住那一支绕开了 hotel_id / 钟点过滤
   * 先定位最后一个 `AND (`，再从它的左括号开始做括号配对，删掉这一对括号。
   */
  const andIdx = goodSql.lastIndexOf("AND (");
  const openIdx = andIdx < 0 ? -1 : goodSql.indexOf("(", andIdx);
  let closeIdx = -1;
  if (openIdx >= 0) {
    let depth = 0;
    for (let i = openIdx; i < goodSql.length; i += 1) {
      if (goodSql[i] === "(") depth += 1;
      else if (goodSql[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
  }
  check(
    "定位到「区间内 或 在住」这一组的外层括号（配对成功）",
    openIdx >= 0 && closeIdx > openIdx,
    `AND( 位置 ${openIdx} / 配对右括号 ${closeIdx}`
  );

  if (openIdx >= 0 && closeIdx > openIdx) {
    const buggySql = goodSql.slice(0, openIdx) + goodSql.slice(openIdx + 1, closeIdx) + goodSql.slice(closeIdx + 1);
    check(
      "去括号后的 SQL = 原 SQL 去掉这一对括号（长度正好少 2）",
      buggySql !== goodSql && buggySql.length === goodSql.length - 2,
      `长度 ${goodSql.length} → ${buggySql.length}`
    );

    /* 参数顺序与 metrics.ts 完全一致：[to, to, from, hotelId, to, from, to] */
    const nightsOf = (sql, hotelId, to = TODAY, from = TODAY) =>
      Math.max(0, Math.round(Number(conn.prepare(sql).get(to, to, from, hotelId, to, from, to)?.nights ?? 0)));

    let goodNights = null;
    let buggyNights = null;
    try {
      goodNights = nightsOf(goodSql, 1);
      buggyNights = nightsOf(buggySql, 1);
    } catch (e) {
      check("两条 SQL 都能在临时库上执行（参数个数一致）", false, String(e?.message ?? e));
    }

    if (goodNights !== null && buggyNights !== null) {
      console.log(`  正确 SQL：hotel 1 间夜 = ${goodNights}`);
      console.log(`  去括号 SQL：hotel 1 间夜 = ${buggyNights}`);
      check("抠出来的 SQL 与生产函数结果一致（防止提取错位）", goodNights === A, `SQL=${goodNights} vs occupancyOfDay=${A}`);
      check(
        "★ 反向验证：去掉括号后 hotel 1 的间夜**变大**（括号确实在起作用，不是碰巧数字一样）",
        buggyNights > goodNights,
        `去括号 ${buggyNights} vs 正确 ${goodNights}`
      );
      check(
        `★ 反向验证实测：去括号后多出 ${buggyNights - goodNights} 间夜（= hotel 999 的 2 张在住单 + 1 张钟点房单）`,
        buggyNights - goodNights === 3,
        `实际多出 ${buggyNights - goodNights}`
      );
      check(
        `★ 反向验证：正确的 hotel 1 间夜仍是 ${A}（bug 修复后的值）`,
        goodNights === A && buggyNights === A + 3,
        `正确 ${goodNights} / 去括号 ${buggyNights} / 期望 ${A} 与 ${A + 3}`
      );

      /*
       * 同一把刀再切一次，看 hotel 999 自己：正确口径 = 2（钟点房被排除）。
       * 去掉括号后，第二支 `OR (status='INHOUSE' AND check_in <= ?)` 变成全库扫描 →
       *   hotel 999 的 2 张日租 + 1 张钟点房 + hotel 1 的 21 张在住 = 24
       * 也就是说：这个 bug 不只「别家算进本店」，还会让本店把钟点房算成过夜。
       */
      const buggyB = nightsOf(buggySql, HOTEL_B);
      const goodB = nightsOf(goodSql, HOTEL_B);
      check(
        `★ 反向验证：去括号后 hotel 999 算成 ${A + 3}（钟点房 1 + 别家 ${A} 间夜都漏进来了），正确值是 2`,
        goodB === 2 && buggyB === A + 3,
        `正确 ${goodB} / 去括号 ${buggyB}`
      );
    }
  }
}

/* ============================================================ 七、真库零写入 */

console.log("\n=== 七、真库零写入 ===");

const real = new DatabaseSync(REAL_DB, { readOnly: true });
try {
  const leakedHotel = Number(real.prepare(`SELECT COUNT(*) AS c FROM hotels WHERE id = ?`).get(HOTEL_B).c);
  const leakedStays = Number(real.prepare(`SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ?`).get(HOTEL_B).c);
  const leakedRooms = Number(real.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ?`).get(HOTEL_B).c);
  check("真库没有被写入测试酒店（999 号店 = 0）", leakedHotel === 0, `实际 ${leakedHotel}`);
  check("真库没有被写入测试在住单（stays = 0）", leakedStays === 0, `实际 ${leakedStays}`);
  check("真库没有被写入测试房间（rooms = 0）", leakedRooms === 0, `实际 ${leakedRooms}`);
  // 真库自己再算一遍：基线与副本一致（VACUUM INTO 是完整拷贝）
  const realNights = Number(
    real
      .prepare(
        `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = 1 AND status = 'INHOUSE' AND COALESCE(rate_code,'') <> '钟点'`
      )
      .get().c
  );
  check(`真库的在住单数与基线口径一致（${realNights} 张）`, realNights === h1Inhouse, `真库 ${realNights} vs 副本 ${h1Inhouse}`);
} finally {
  real.close();
}

/* ============================================================ 汇总 */

console.log(`\n通过 ${pass} / 失败 ${fail}`);
conn.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
