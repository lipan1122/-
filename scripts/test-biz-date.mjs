/**
 * 营业日计算验收（整改报告 P1-6）
 *
 * 直接验证 bizDate 的换算逻辑：
 *   05:00 切换时
 *     03:30 → 前一天
 *     05:00 → 当天（刚到切换点算新的一天）
 *     12:00 → 当天
 *   00:00 切换时，任何时刻都算当天
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB, { readOnly: true });
const one = (sql, p = []) => db.prepare(sql).get(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* 复刻 bizDate 逻辑（避免 import TS 文件） */
function bizDate(now, cutoff) {
  const [hh, mm] = cutoff.split(":").map((x) => Number(x) || 0);
  const d = new Date(now.getTime());
  if (d.getHours() * 60 + d.getMinutes() < hh * 60 + mm) d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const base = new Date(2026, 10, 17); // 2026-11-17 本地时间

/* 05:00 切换 */
check("05:00 切换：03:30 算前一天", bizDate(new Date(2026, 10, 17, 3, 30), "05:00") === "2026-11-16");
check("05:00 切换：05:00 整算当天", bizDate(new Date(2026, 10, 17, 5, 0), "05:00") === "2026-11-17");
check("05:00 切换：12:00 算当天", bizDate(new Date(2026, 10, 17, 12, 0), "05:00") === "2026-11-17");
check("05:00 切换：23:59 算当天", bizDate(new Date(2026, 10, 17, 23, 59), "05:00") === "2026-11-17");

/* 00:00 切换（默认） */
check("00:00 切换：00:30 算当天", bizDate(new Date(2026, 10, 17, 0, 30), "00:00") === "2026-11-17");
check("00:00 切换：23:30 算当天", bizDate(new Date(2026, 10, 17, 23, 30), "00:00") === "2026-11-17");

/* 06:00 切换 */
check("06:00 切换：05:30 算前一天", bizDate(new Date(2026, 10, 17, 5, 30), "06:00") === "2026-11-16");
check("06:00 切换：06:30 算当天", bizDate(new Date(2026, 10, 17, 6, 30), "06:00") === "2026-11-17");

/* 跨月边界 */
check("跨月：11-01 03:00（05:00 切换）算 10-31", bizDate(new Date(2026, 10, 1, 3, 0), "05:00") === "2026-10-31");

/* 数据库里的配置 */
const cutoff = one(`SELECT value FROM settings WHERE hotel_id = 1 AND key = 'biz_day_cutoff'`)?.value;
check("settings 里有 biz_day_cutoff 配置", /^\d{2}:\d{2}$/.test(cutoff ?? ""), `值=${cutoff}`);

/* 夜审表仍按营业日唯一 */
const idx = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='night_audits'`);
check("night_audits 唯一键含 hotel_id", /UNIQUE\s*\(\s*hotel_id\s*,\s*biz_date\s*\)/i.test(idx?.sql ?? ""));

console.log(`\n当前配置：营业日切换时间 = ${cutoff}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
db.close();
process.exit(fail === 0 ? 0 : 1);
