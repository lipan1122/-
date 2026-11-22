#!/usr/bin/env node
/**
 * stays.guest_id 存量安全回填（第九轮整改 §一.1）
 *
 * ── 问题 ──
 * 真库 21 张在住单里 18 张 `stays.guest_id` 为空。入住单靠 guest_id 串起
 * 会员储值、历史入住次数、会员等级、退款对象；缺了它，会员充值 / 消费 /
 * 退款只能按姓名回退 —— 同名客人要么被拒、要么把钱记到别人头上。
 *
 * ── 本脚本的匹配口径 ──
 * 与入住办理（frontdesk/actions.ts + lib/guest-match）同一套优先级，只是存量
 * 入住单上能拿到的字段少一个：
 *   入住办理：身份证号 → 手机号 → 唯一同名 → 都没有才建档
 *   存量回填：手机号  → 唯一同名 → 其余保持为空
 * 原因：`stays` 表没有身份证列（证件号只在入住表单/客史里），存量单能用的
 * 唯一身份字段只有 `mobile` 和 `guest_name`。所以这里**不会**假装按证件号匹配过。
 *
 * 三条额外的安全闸门（宁可不填，也不填错）：
 *   ① 手机号命中的客史姓名与单据姓名不一致 → 不写，列入待处理（可能换手机号/串号）；
 *   ② 同名客史多于 1 条 → 不写，列入待处理（要求人工选择，绝不取最早 id）；
 *   ③ 该客史在同一酒店已有另一张在住单 → 不写，列入待处理
 *      （写入就变成「同一证件号两张在住单」，与入住时的重复入住拦截自相矛盾，
 *        这类数据本身需要人工处理：联房或纠正重复登记）。
 *
 * 硬约束：
 *   · 只碰 `guest_id IS NULL` 的行（幂等：重复跑不会覆盖、也不会重复写日志）
 *   · 每条 UPDATE 都带 `hotel_id = ?`（不跨酒店）
 *   · 每回填一条写一条 op_logs，另有每店一条汇总日志
 *   · `--check` 只读不写；写模式先 VACUUM INTO 备份
 *
 * 用法：
 *   node scripts/backfill-stay-guest-id.mjs --check          # 只报告（推荐先跑）
 *   node scripts/backfill-stay-guest-id.mjs                  # 备份 + 回填全部状态
 *   node scripts/backfill-stay-guest-id.mjs --inhouse-only   # 只回填在住单
 *   node scripts/backfill-stay-guest-id.mjs --hotel=1        # 只处理指定酒店
 *   node scripts/backfill-stay-guest-id.mjs --no-backup      # 跳过备份（测试/副本库用）
 *   PMS_DB_PATH=... 可指向别的库（默认项目内 data/pms.db）
 *
 * 退出码：0 = 正常结束（含「没有可回填的记录」），1 = 环境/执行错误。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** op_logs.action：回填相关日志统一用这个前缀，便于报表/日志页检索 */
export const OP_ACTION = "客史回填";
/** op_logs.operator：脚本以系统身份写入，与前台人工操作区分开 */
export const OP_OPERATOR = "系统回填脚本(guest_id)";

/** 待处理原因（同时用于控制台提示与测试断言） */
export const PENDING = {
  NO_GUEST: "无客史档案",
  AMBIGUOUS_NAME: "同名多客史",
  MOBILE_NAME_MISMATCH: "手机号命中但姓名不一致",
  DUPLICATE_INHOUSE: "同一客史已有在住单",
  NO_NAME: "入住单没有客人姓名",
};

const trim = (v) => (typeof v === "string" ? v.trim() : "");

function guestsOf(db, hotelId, where, params) {
  return db
    .prepare(
      `SELECT id, name, mobile, id_no FROM guests
        WHERE hotel_id = ? AND COALESCE(deleted, 0) = 0 AND ${where}
        ORDER BY id`
    )
    .all(hotelId, ...params)
    .map((r) => ({ ...r }));
}

/**
 * 为一张入住单找客史（纯函数，不改库；测试直接调用它）
 *
 * @param {DatabaseSync} db
 * @param {number} hotelId
 * @param {{id?:number, guest_name?:string|null, mobile?:string|null, status?:string|null}} stay
 * @param {{inhouseGuestIds?: Set<number>}} [opts] 同店其他在住单已占用的客史 id（闸门③）
 * @returns {{guestId:number, matchedBy:"mobile"|"name", guestName:string}|{guestId:null, reason:string, detail?:string}}
 */
export function matchGuestForStay(db, hotelId, stay, opts = {}) {
  const name = trim(stay.guest_name);
  const mobile = trim(stay.mobile);
  if (!name && !mobile) return { guestId: null, reason: PENDING.NO_NAME };

  /* ① 手机号：guests 上有 UNIQUE(hotel_id, mobile) 部分索引，正常最多 1 条；仍显式判唯一 */
  if (mobile) {
    const hits = guestsOf(db, hotelId, "mobile = ?", [mobile]);
    if (hits.length > 1) {
      return { guestId: null, reason: PENDING.AMBIGUOUS_NAME, detail: `手机号 ${mobile} 命中 ${hits.length} 份客史` };
    }
    if (hits.length === 1) {
      const hit = hits[0];
      if (name && hit.name !== name) {
        /* 手机号是强身份，但和单据姓名对不上 → 可能换机主/录错，不猜 */
        return {
          guestId: null,
          reason: PENDING.MOBILE_NAME_MISMATCH,
          detail: `手机号 ${mobile} 属于客史 #${hit.id}「${hit.name}」，单据姓名「${name}」`,
        };
      }
      return { guestId: hit.id, matchedBy: "mobile", guestName: hit.name };
    }
  }

  /* ② 姓名：只有唯一同名才允许辅助关联；0 条 / 多条都不写 */
  if (!name) return { guestId: null, reason: PENDING.NO_NAME };
  const sameName = guestsOf(db, hotelId, "name = ?", [name]);
  if (sameName.length === 0) return { guestId: null, reason: PENDING.NO_GUEST, detail: `「${name}」在本店没有客史` };
  if (sameName.length > 1) {
    return {
      guestId: null,
      reason: PENDING.AMBIGUOUS_NAME,
      detail: `「${name}」有 ${sameName.length} 份客史：${sameName.map((g) => `#${g.id}`).join("、")}`,
    };
  }

  const only = sameName[0];
  /* ③ 同一客史已在住 → 写入会造出「一张客史两张在住单」，留给人工处理 */
  if (stay.status === "INHOUSE" && opts.inhouseGuestIds?.has(only.id)) {
    return {
      guestId: null,
      reason: PENDING.DUPLICATE_INHOUSE,
      detail: `客史 #${only.id}「${only.name}」已有另一张在住单`,
    };
  }
  return { guestId: only.id, matchedBy: "name", guestName: only.name };
}

/** 取某酒店当前被在住单占用的客史 id（不含 excludeStayId 自己） */
export function inhouseGuestIdSet(db, hotelId, excludeStayId = null) {
  const rows = db
    .prepare(
      `SELECT DISTINCT guest_id FROM stays
        WHERE hotel_id = ? AND status = 'INHOUSE' AND guest_id IS NOT NULL
          AND (? IS NULL OR id <> ?)`
    )
    .all(hotelId, excludeStayId, excludeStayId);
  return new Set(rows.map((r) => Number(r.guest_id)));
}

/**
 * 生成某酒店的回填计划（只读）
 * @returns {{hotelId:number, todo:Array, matched:Array, pending:Array, stats:object}}
 */
export function collectPlan(db, hotelId, { inhouseOnly = false } = {}) {
  const stale = db
    .prepare(
      `SELECT id, hotel_id, stay_no, guest_id, guest_name, mobile, status
         FROM stays
        WHERE hotel_id = ? AND guest_id IS NULL
          ${inhouseOnly ? "AND status = 'INHOUSE'" : ""}
        ORDER BY id`
    )
    .all(hotelId)
    .map((r) => ({ ...r }));

  /*
   * 在住身份不能重复：闸门③不只看「库里已经填过 guest_id 的在住单」，
   * 还要看「本轮计划里刚被匹配上的在住单」——
   * 真库里 SI1114 与 SI1122 都是「刘洋」，两条都空；只查库的话两条都会匹配到
   * 客史 #10，回填完成后就变成「同一证件号两张在住单」，正好违反入住时的重复入住拦截。
   * 同一客史的多张在住单只认 id 最小那张，其余列入待处理交人工（联房 / 纠正重复登记）。
   */
  const occupiedInhouse = inhouseGuestIdSet(db, hotelId);
  const matched = [];
  const pending = [];
  for (const stay of stale) {
    const hit = matchGuestForStay(db, hotelId, stay, { inhouseGuestIds: occupiedInhouse });
    if (hit.guestId === null) {
      pending.push({ stay, reason: hit.reason, detail: hit.detail ?? "" });
      continue;
    }
    matched.push({ stay, guestId: hit.guestId, matchedBy: hit.matchedBy, guestName: hit.guestName });
    if (stay.status === "INHOUSE") occupiedInhouse.add(hit.guestId);
  }

  const byStatus = {};
  for (const stay of stale) byStatus[stay.status] = (byStatus[stay.status] ?? 0) + 1;
  const stats = {
    total: stale.length,
    matched: matched.length,
    pending: pending.length,
    byStatus,
    byMatchedBy: matched.reduce((acc, m) => ({ ...acc, [m.matchedBy]: (acc[m.matchedBy] ?? 0) + 1 }), {}),
    pendingByReason: pending.reduce((acc, p) => ({ ...acc, [p.reason]: (acc[p.reason] ?? 0) + 1 }), {}),
    inhouseTotal: stale.filter((s) => s.status === "INHOUSE").length,
    inhouseMatched: matched.filter((m) => m.stay.status === "INHOUSE").length,
  };
  return { hotelId, todo: stale, matched, pending, stats };
}

/** VACUUM INTO 备份（回填前必做；只在写模式调用） */
export function backupDb(db, dbPath, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  const dir = path.join(path.dirname(dbPath), "backup");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pms-before-guest-id-backfill-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  return file;
}

/**
 * 执行回填（幂等）
 *
 * 每条 UPDATE 都带 `guest_id IS NULL` 与 `hotel_id = ?`：重复运行既不会覆盖
 * 已有值，也不会把日志写两遍（changes 为 0 就不写日志）。
 */
export function applyPlan(db, plan, { operator = OP_OPERATOR, now = new Date().toISOString() } = {}) {
  const update = db.prepare(`UPDATE stays SET guest_id = ? WHERE id = ? AND hotel_id = ? AND guest_id IS NULL`);
  const log = db.prepare(
    `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`
  );
  let updated = 0;
  let logRows = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of plan.matched) {
      const r = update.run(item.guestId, item.stay.id, plan.hotelId);
      if (Number(r.changes) !== 1) continue; // 被别的进程先回填 / 已不是空值 → 跳过，不重复记日志
      updated += 1;
      log.run(
        plan.hotelId,
        operator,
        OP_ACTION,
        `入住单 ${item.stay.stay_no} · 房间单据客人「${item.stay.guest_name ?? "-"}」` +
          `${item.stay.mobile ? ` · 手机 ${item.stay.mobile}` : ""} · 关联客史 #${item.guestId}「${item.guestName}」` +
          `（匹配依据：${item.matchedBy === "mobile" ? "手机号" : "唯一同名"}）`,
        now
      );
      logRows += 1;
    }
    /*
     * 只有真的写了东西才写汇总日志：
     * 重复运行时 updated = 0（幂等），此时再写一条「写入 0 条」既没信息量，
     * 又会让「重复执行不会重复写日志」这条约束破功。
     */
    if (updated > 0) {
      log.run(
        plan.hotelId,
        operator,
        OP_ACTION,
        `回填写入 ${updated} 条，待人工处理 ${plan.stats.pending} 条` +
          `${Object.keys(plan.stats.pendingByReason).length > 0 ? `（${Object.entries(plan.stats.pendingByReason).map(([k, v]) => `${k} ${v}`).join("，")}）` : ""}`,
        now
      );
      logRows += 1;
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已结束 */
    }
    throw e;
  }
  return { updated, logRows };
}

/** 控制台打印一份计划（--check 与写模式共用） */
function printReport(plan, { checkOnly }) {
  const { stats, pending, matched, hotelId } = plan;
  console.log(`\n酒店 #${hotelId}：guest_id 为空 ${stats.total} 条` +
    (Object.keys(stats.byStatus).length > 0
      ? `（${Object.entries(stats.byStatus).map(([k, v]) => `${k} ${v}`).join(" / ")}）`
      : ""));
  if (stats.inhouseTotal > 0) {
    console.log(`  在住单：${stats.inhouseTotal} 条，可安全匹配 ${stats.inhouseMatched} 条`);
  }
  console.log(`  可回填 ${stats.matched} 条` +
    (Object.keys(stats.byMatchedBy).length > 0
      ? `（${Object.entries(stats.byMatchedBy).map(([k, v]) => `${k === "mobile" ? "手机号" : "唯一同名"} ${v}`).join("，")}）`
      : ""));
  console.log(`  待人工处理 ${stats.pending} 条` +
    (Object.keys(stats.pendingByReason).length > 0
      ? `（${Object.entries(stats.pendingByReason).map(([k, v]) => `${k} ${v}`).join("，")}）`
      : ""));

  if (checkOnly) {
    for (const m of matched) {
      console.log(
        `    · 将回填 ${m.stay.stay_no}（${m.stay.status}）「${m.stay.guest_name ?? "-"}」` +
          `${m.stay.mobile ? ` ${m.stay.mobile}` : ""} → 客史 #${m.guestId}「${m.guestName}」[${m.matchedBy}]`
      );
    }
  }
  for (const p of pending) {
    console.log(
      `    ! 待处理 ${p.stay.stay_no}（${p.stay.status}）「${p.stay.guest_name ?? "-"}」` +
        `${p.stay.mobile ? ` ${p.stay.mobile}` : ""} → ${p.reason}${p.detail ? `：${p.detail}` : ""}`
    );
  }
}

/* ============================================================ CLI */

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const inhouseOnly = argv.includes("--inhouse-only");
  const noBackup = argv.includes("--no-backup");
  const hotelArg = argv.find((a) => a.startsWith("--hotel="));
  const hotelFilter = hotelArg ? Number(hotelArg.split("=")[1]) : null;

  const dbPath = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ 数据库不存在：${dbPath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    console.log(`数据库：${dbPath}`);
    console.log(checkOnly ? "模式：仅检查（不写任何数据）\n" : "模式：执行回填\n");

    const hotelIds = (
      hotelFilter
        ? [hotelFilter]
        : db
            .prepare(`SELECT DISTINCT hotel_id FROM stays WHERE guest_id IS NULL ORDER BY hotel_id`)
            .all()
            .map((r) => Number(r.hotel_id))
    ).filter((n) => Number.isFinite(n) && n > 0);

    if (hotelIds.length === 0) {
      console.log("没有 guest_id 为空的入住单，无需回填。");
      return;
    }

    const plans = hotelIds.map((id) => collectPlan(db, id, { inhouseOnly }));
    for (const plan of plans) printReport(plan, { checkOnly });

    if (checkOnly) {
      const total = plans.reduce((s, p) => s + p.stats.total, 0);
      const matched = plans.reduce((s, p) => s + p.stats.matched, 0);
      console.log(`\n检查完成：待回填 ${total} 条，其中可安全匹配 ${matched} 条，其余保持为空等待人工处理。`);
      console.log("（未写任何数据；确认无误后去掉 --check 再跑一次执行回填，脚本会先 VACUUM INTO 备份。）");
      return;
    }

    if (!noBackup) {
      const file = backupDb(db, dbPath);
      console.log(`\n已备份真库：${file}`);
    }

    let updated = 0;
    let logs = 0;
    for (const plan of plans) {
      const r = applyPlan(db, plan);
      updated += r.updated;
      logs += r.logRows;
      console.log(`酒店 #${plan.hotelId}：写入 ${r.updated} 条，操作日志 ${r.logRows} 条`);
    }
    console.log(`\n回填完成：写入 ${updated} 条 stays.guest_id，op_logs 共 ${logs} 条。`);
    console.log("重复执行本脚本不会重复写入（只处理 guest_id IS NULL 的行）。");
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(`❌ 回填失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
