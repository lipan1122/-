/**
 * 回填在住单的 guest_id（最后 8 张）
 *
 * ── 现状 ──
 *
 * 真库还有 8 张在住单 `guest_id` 为空：
 *   · 6 个客人**完全没有客史档案**（金泽宇×2、杨茜、朱吉玲、吴梦兰、黄心娜）
 *   · 2 个有同名客史但**手机号对不上**（刘洋 #10、徐宗令 #5）
 *
 * ── 为什么之前没修 ──
 *
 * 第九轮的 `backfill-stay-guest-id.mjs` 只按「身份证 → 手机号 → 唯一姓名」匹配**已有客史**，
 * 匹配不到就保持为空并列入待处理 —— 这是当时刻意的保守策略（不凭空造客史）。
 *
 * 但这 8 张单的客人**确实住着**，客史缺档是种子数据不完整造成的。
 * 演示环境里「在住单没有客史」会让会员充值/积分/历史入住次数都关联不上，
 * 所以这里主动**给它们建档**。
 *
 * ── 建档规则（保守） ──
 *
 * 1. 按「姓名 + 手机号」建档：同一个人不同手机号算两条（金泽宇有两张单、手机不同）
 * 2. `id_no` 留空 —— 没有真实证件号就不编造
 * 3. 建完立刻把该单的 `guest_id` 指过去
 * 4. 写 `op_logs`（每条一单 + 一条汇总）
 * 5. 幂等：已有客史的姓名+手机组合不重复建
 *
 * 用法：
 *   node scripts/backfill-guest-id-last8.mjs            # 只报告
 *   node scripts/backfill-guest-id-last8.mjs --apply    # 备份后写库
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dbPath = process.env.PMS_DB_PATH ?? join(root, "data", "pms.db");

const APPLY = process.argv.includes("--apply");
const HOTEL = 1;

const db = new DatabaseSync(dbPath);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

const rows = all(
  `SELECT s.id, s.stay_no, s.guest_name, s.mobile, s.check_in_time
     FROM stays s
    WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
      AND (s.guest_id IS NULL OR s.guest_id = 0)
    ORDER BY s.id`,
  [HOTEL]
);

if (rows.length === 0) {
  console.log("\n✅ 没有 guest_id 为空的在住单\n");
  db.close();
  process.exit(0);
}

console.log(`\n在住单 guest_id 为空：${rows.length} 张\n`);

/*
 * 逐单判断：能匹配已有客史就复用，否则新建
 *
 * ⚠️ 同批次内同一手机号只能建一个客史（idx_guests_mobile 是 UNIQUE）
 * VPS 上有 18 张单要补、其中好几张是同一手机号（同一客人的多间房），
 * 不合并就会撞「UNIQUE constraint failed: guests.hotel_id, guests.mobile」。
 */
const plan = [];
const plannedByMobile = new Map();
for (const r of rows) {
  const name = String(r.guest_name ?? "").trim();
  const mobile = String(r.mobile ?? "").trim();

  /* ① 手机号唯一命中（最可靠） */
  if (mobile) {
    const byMobile = all(`SELECT id, name FROM guests WHERE hotel_id = ? AND mobile = ? AND COALESCE(deleted,0) = 0`, [
      HOTEL,
      mobile,
    ]);
    if (byMobile.length === 1) {
      plan.push({ row: r, action: "reuse-mobile", guestId: byMobile[0].id, note: `手机号唯一命中 #${byMobile[0].id}` });
      continue;
    }
  }

  /* ② 姓名 + 手机号都一致（更严的组合键） */
  if (name && mobile) {
    const byBoth = all(
      `SELECT id FROM guests WHERE hotel_id = ? AND name = ? AND mobile = ? AND COALESCE(deleted,0) = 0`,
      [HOTEL, name, mobile]
    );
    if (byBoth.length === 1) {
      plan.push({ row: r, action: "reuse-both", guestId: byBoth[0].id, note: `姓名+手机命中 #${byBoth[0].id}` });
      continue;
    }
  }

  /* ③ 同批次内同手机号 → 复用前面已经计划要建的那个（稍后第一个人建完，后面直接指过去） */
  if (mobile && plannedByMobile.has(mobile)) {
    plan.push({ row: r, action: "reuse-batch", guestId: null, batchMobile: mobile, note: `同批次同手机号，复用先建的客史` });
    continue;
  }

  /* ④ 建新客史（按姓名+手机，同名不同手机算不同人 —— 金泽宇就有两个手机） */
  plan.push({
    row: r,
    action: "create",
    guestId: null,
    note: `新建客史：${name}${mobile ? ` / ${mobile}` : ""}`,
    batchMobile: mobile || null,
  });
  if (mobile) plannedByMobile.set(mobile, true);
}

for (const p of plan) {
  console.log(`  ${p.row.stay_no.padEnd(10)} ${String(p.row.guest_name ?? "").padEnd(6)} → ${p.action === "create" ? "新建" : "复用"}：${p.note}`);
}

const createCount = plan.filter((p) => p.action === "create").length;
console.log(`\n汇总：复用 ${plan.length - createCount} 张 / 新建客史 ${createCount} 张`);

if (!APPLY) {
  console.log(`\n【只报告】加 --apply 备份后写库\n`);
  db.close();
  process.exit(0);
}

/* 备份 */
const backupDir = join(root, "data", "backup");
if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `pms.before-guest-id-last8.${stamp}.db`);
copyFileSync(dbPath, backupPath);
console.log(`已备份：${backupPath}`);

let created = 0;
let linked = 0;
/* 本次运行内「手机号 → 新建出来的 guestId」，处理同手机号的多张单 */
const createdByMobile = new Map();
db.exec("BEGIN");
try {
  for (const p of plan) {
    let guestId = p.guestId;

    /* 同批次同手机号：前面已经建过就复用 */
    if (guestId === null && p.action === "reuse-batch" && p.batchMobile && createdByMobile.has(p.batchMobile)) {
      guestId = createdByMobile.get(p.batchMobile);
    }

    if (guestId === null) {
      const name = String(p.row.guest_name ?? "").trim();
      const mobile = String(p.row.mobile ?? "").trim();
      run(
        `INSERT INTO guests (hotel_id, name, mobile, gender, id_type, id_no, vip_level, blacklist, note, created_at, deleted)
         VALUES (?,?,?, NULL, NULL, NULL, 0, 0, ?, ?, 0)`,
        [
          HOTEL,
          name,
          mobile || null,
          `演示数据补档：从入住单 ${p.row.stay_no}（${String(p.row.check_in_time ?? "").slice(0, 10)} 入住）回填，原单无客史档案`,
          new Date().toISOString(),
        ]
      );
      guestId = Number(one(`SELECT id FROM guests WHERE hotel_id = ? ORDER BY id DESC LIMIT 1`, [HOTEL]).id);
      created++;
      if (mobile) createdByMobile.set(mobile, guestId);
    }

    /* 回填（只改仍然为空的行，幂等） */
    const r = run(`UPDATE stays SET guest_id = ? WHERE id = ? AND hotel_id = ? AND (guest_id IS NULL OR guest_id = 0)`, [
      guestId,
      p.row.id,
      HOTEL,
    ]);
    if (Number(r.changes) > 0) {
      linked++;
      run(`INSERT INTO op_logs (hotel_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)`, [
        HOTEL,
        "客史回填",
        `入住单 ${p.row.stay_no}（${p.row.guest_name}）guest_id → #${guestId}（${p.action === "create" ? "新建客史" : "复用已有客史"}）`,
        "系统补档",
        new Date().toISOString(),
      ]);
    }
  }

  run(`INSERT INTO op_logs (hotel_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)`, [
    HOTEL,
    "客史回填",
    `最后 ${plan.length} 张在住单补 guest_id：新建客史 ${created} 个、复用 ${plan.length - created} 个、回填 ${linked} 张单`,
    "系统补档",
    new Date().toISOString(),
  ]);

  db.exec("COMMIT");
  console.log(`\n✅ 新建客史 ${created} 个、回填 ${linked} 张单`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`\n❌ 失败已回滚：${e.message}`);
  db.close();
  process.exit(1);
}

/* 复核 */
const left = Number(
  one(
    `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND status = 'INHOUSE' AND (guest_id IS NULL OR guest_id = 0)`,
    [HOTEL]
  ).c
);
console.log(`复核：guest_id 为空的在住单 ${left} 张（应为 0）\n`);

db.close();
process.exit(left === 0 ? 0 : 1);
