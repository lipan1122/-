/**
 * P2-1 / P2-2 验收
 *
 * P2-1 预订校验失败返回明确文案
 *   —— 新建预订的每个校验分支都必须 redirect 带 err，不能静默 return
 *
 * P2-2 排房后主单 room_count 保持原始间数
 *   —— room_count 是「客人订了几间房」（订单属性），
 *      已排/待排是「排房进度」，只能从 booking_rooms 明细统计
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const src = readFileSync(join("src", "app", "(main)", "bookings", "actions.ts"), "utf8");

/* ---------- P2-1 ---------- */
function funcBody(name) {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}
const create = funcBody("createBookingAction");

check("新建预订：客人姓名校验有明确文案", /请填写客人姓名/.test(create));
check("新建预订：到店日期校验有明确文案", /请选择到店日期/.test(create));
check("新建预订：离店日期校验有明确文案", /请选择离店日期/.test(create));
check("新建预订：团队名校验有明确文案", /必须填写团队名称/.test(create));
check("新建预订：日期顺序校验有明确文案", /离店日期必须晚于到店日期/.test(create));
check("新建预订：房型明细校验有明确文案", /至少添加一行房型明细/.test(create));
check("新建预订：无效房型有明确文案", /所选房型无效/.test(create));

/* 核心校验区不应再有裸 return（除了函数末尾） */
const coreRegion = create.slice(create.indexOf("const backNew"), create.indexOf("const nights ="));
const bareReturns = (coreRegion.match(/^\s*if \([^)]*\) return;$/gm) || []).length;
check("核心校验区没有静默 return", bareReturns === 0, `发现 ${bareReturns} 处`);

/* ---------- P2-2 ---------- */
const assign = funcBody("assignRoomAction");
check("排房不再写 room_count", !/SET[\s\S]{0,120}room_count\s*=/.test(assign));
check("排房仍更新 room_id 镜像", /room_id = COALESCE\(room_id, \?\)/.test(assign));
check("排房注释说明 P2-2 取舍", /P2-2/.test(assign));

/* 数据校验：room_count 与明细数应一致（排房不改它，所以两者应恒等） */
const db = new DatabaseSync(DB, { readOnly: true });
const mismatch = db.prepare(
  `SELECT b.booking_no, COALESCE(b.room_count,1) AS rc,
          (SELECT COUNT(*) FROM booking_rooms br WHERE br.booking_id = b.id) AS dt
     FROM bookings b
    WHERE b.hotel_id = 1 AND b.status NOT IN ('CANCELLED','NOSHOW')
      AND (SELECT COUNT(*) FROM booking_rooms br WHERE br.booking_id = b.id) > 0
      AND (SELECT COUNT(*) FROM booking_rooms br WHERE br.booking_id = b.id) <> MAX(1, COALESCE(b.room_count,1))
    LIMIT 10`
).all();
check("现有数据 room_count 与明细数一致", mismatch.length === 0,
  mismatch.slice(0, 3).map((b) => `${b.booking_no} ${b.rc}≠${b.dt}`).join("; "));

/* 待排房数应该能纯从明细算出来（不依赖主单 status） */
const pending = db.prepare(
  `SELECT COUNT(*) AS c FROM booking_rooms
    WHERE hotel_id = 1 AND room_id IS NULL AND status = 'PENDING'`
).get().c;
const mainPending = db.prepare(
  `SELECT COUNT(*) AS c FROM bookings WHERE hotel_id = 1 AND status = 'PENDING'`
).get().c;
console.log(`\n待排明细 ${pending} 条 / 主单 PENDING ${mainPending} 单`);
/* 原来这里是 check("待排房数可从明细直接统计", true) —— 恒真断言，什么都不校验。
   改成真断言：明细必须都能关联到主单，否则「按明细统计待排房」会漏掉孤儿明细。 */
const orphanDetails = db
  .prepare(
    `SELECT COUNT(*) AS c FROM booking_rooms br
       LEFT JOIN bookings b ON b.id = br.booking_id
      WHERE b.id IS NULL`
  )
  .get().c;
check("明细都能关联到主单（从明细统计待排房不会漏单）", Number(orphanDetails) === 0, `${orphanDetails} 条孤儿明细`);

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
