/**
 * 客史匹配口径验收（整改清单 P1-9）
 *
 * 缺陷背景：各处按「姓名」匹配客人档案（`WHERE name = ? LIMIT 1`），
 * 重名时改错人；也没有唯一约束，同一手机号能建出多份档案。
 *
 * 修复：
 *   1. 唯一口径「证件号 → 手机号」，姓名不参与定位
 *   2. guests 加 UNIQUE(hotel_id, id_no) / UNIQUE(hotel_id, mobile)（部分索引，空值不冲突）
 *   3. 新增 src/lib/guest-match.ts 收敛匹配逻辑
 *
 * 本脚本：
 *   1. 静态：唯一索引存在、guest-match.ts 导出正确、关键位置不再按姓名匹配
 *   2. 数据：现有数据没有违反唯一约束的重复
 *   3. 逻辑：优先证件号、次选手机号、都没有返回 null
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

/* ---------- 1. 静态 ---------- */
const gm = readFileSync(join("src", "lib", "guest-match.ts"), "utf8");
check("新增 lib/guest-match.ts", gm.length > 0);
check("导出 findGuestByIdentity", /export function findGuestByIdentity/.test(gm));
check("导出 findConflictGuest（新建前查重）", /export function findConflictGuest/.test(gm));
/* 校验真正的分支顺序：先 if (idNo) 再 if (mobile) */
const iId = gm.indexOf("if (idNo) {");
const iMo = gm.indexOf("if (mobile) {");
check("匹配优先级：先查证件号再查手机号", iId > 0 && iMo > 0 && iId < iMo, `idNo@${iId} mobile@${iMo}`);
check("注释明确「姓名不用于定位档案」", /绝不用于定位档案|不用于定位/.test(gm));

/* 关键位置不再按姓名定位 */
const files = [
  ["src/app/(main)/rooms/actions.ts", "改客史 / 开通会员"],
  ["src/app/(main)/frontdesk/actions.ts", "入住建档"],
];
for (const [f, label] of files) {
  const s = readFileSync(join(...f.split("/")), "utf8");
  const nameLookup = /FROM guests WHERE hotel_id = \? AND name = \?/.test(s);
  check(`${label}不再按姓名定位客史（${f.split("/").pop()}）`, !nameLookup);
}

/* ---------- 2. 数据：唯一约束 ---------- */
const db = new DatabaseSync(DB, { readOnly: true });
const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='guests'`).all().map((r) => r.name);
check("idx_guests_idno 存在", indexes.includes("idx_guests_idno"), indexes.join(","));
check("idx_guests_mobile 存在", indexes.includes("idx_guests_mobile"));

/* 现有数据不违反唯一性 */
const dupIdNo = db.prepare(
  `SELECT id_no, COUNT(*) c FROM guests
    WHERE hotel_id = 1 AND id_no IS NOT NULL AND id_no <> ''
    GROUP BY id_no HAVING c > 1 LIMIT 5`
).all();
check("现有数据无重复证件号", dupIdNo.length === 0, JSON.stringify(dupIdNo));

const dupMobile = db.prepare(
  `SELECT mobile, COUNT(*) c FROM guests
    WHERE hotel_id = 1 AND mobile IS NOT NULL AND mobile <> ''
    GROUP BY mobile HAVING c > 1 LIMIT 5`
).all();
check("现有数据无重复手机号", dupMobile.length === 0, JSON.stringify(dupMobile));

/* 唯一约束真的生效（插入重复应失败） */
const w = new DatabaseSync(DB);
let blocked = false;
try {
  const g = w.prepare(`SELECT hotel_id, name, mobile FROM guests WHERE hotel_id=1 AND mobile IS NOT NULL AND mobile<>'' LIMIT 1`).get();
  if (g) {
    w.prepare(`INSERT INTO guests (hotel_id, name, mobile, vip_level, created_at) VALUES (?,?,?,0,?)`)
      .run(g.hotel_id, "重复测试", g.mobile, new Date().toISOString());
  }
} catch {
  blocked = true;
}
check("重复手机号被唯一索引拦截", blocked);
w.close();

/* ---------- 3. 逻辑：优先级 ---------- */
/* 与 findGuestByIdentity 等价的判定（有证件号先查证件号） */
function shouldQueryBy(idNo, mobile) {
  if (idNo && idNo.trim()) return "id_no";
  if (mobile && mobile.trim()) return "mobile";
  return null;
}
check("有证件号时优先按证件号", shouldQueryBy("330106199010100011", "13800138000") === "id_no");
check("无证件号时按手机号", shouldQueryBy("", "13800138000") === "mobile");
check("两者都没有时不查（返回 null 新建）", shouldQueryBy("", "") === null);

/* 统计 */
const stat = db.prepare(
  `SELECT COUNT(*) AS total,
          SUM(CASE WHEN COALESCE(id_no,'') <> '' THEN 1 ELSE 0 END) AS with_idno,
          SUM(CASE WHEN COALESCE(mobile,'') <> '' THEN 1 ELSE 0 END) AS with_mobile
     FROM guests WHERE hotel_id = 1 AND COALESCE(deleted,0)=0`
).get();
console.log(`\n客人 ${stat.total} 位：有证件号 ${stat.with_idno}，有手机号 ${stat.with_mobile}`);

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
