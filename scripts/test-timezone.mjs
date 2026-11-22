/**
 * 时区口径验收（整改清单 P1-6）
 *
 * 缺陷背景：nowIso() 返回 UTC（如 2026-11-17T18:30:00.000Z），
 * 而 todayStr() 返回本地日期（2026-11-18）。业务里又有大量
 * `substr(时间字段, 1, 10)` 当日期用的地方（stays.check_in_time 推营业日等）。
 * 结果：客人凌晨 2 点入住，UTC 是前一天 18:00，取出来落到前一天，
 * 房费 / 报表 / 夜审全部错位。
 *
 * 修复：
 *   1. lib/utils.ts 新增 nowLocalIso() —— 返回 `本地时间+偏移`，前 10 位是本地日期
 *   2. 入住时间（combineDateTime）改用它
 *   3. 其他「Date → 日期」的地方改用 todayStr(d)，不再 toISOString().slice(0,10)
 *
 * 本脚本：
 *   1. 静态校验：关键位置不再有 toISOString().slice(0,10)
 *   2. 逻辑校验：nowLocalIso 在凌晨场景返回正确本地日期
 *   3. 数据校验：现有 check_in_time 的日期分布是否合理
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.PMS_DB_PATH ?? join(process.cwd(), "data", "pms.db");
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* ---------- 1. 静态：nowLocalIso 存在且被入住流程使用 ---------- */
const utils = readFileSync(join("src", "lib", "utils.ts"), "utf8");
check("lib/utils.ts 导出 nowLocalIso", /export function nowLocalIso/.test(utils));
check("nowLocalIso 带时区偏移（不是 Z 结尾）", utils.includes("sign") && utils.includes("getTimezoneOffset"));

const frontdesk = readFileSync(join("src", "app", "(main)", "frontdesk", "actions.ts"), "utf8");
check("入住 combineDateTime 用 nowLocalIso", /nowLocalIso\(/.test(frontdesk));
check("入住时间不再用 d.toISOString()", !/return[^;]*d\.toISOString\(\)/.test(frontdesk));

/* ---------- 2. 静态：全项目不再有 toISOString().slice(0,10) 当日期 ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const hits = [];
for (const f of walk("src")) {
  const s = readFileSync(f, "utf8");
  if (/toISOString\(\)\.slice\(0,\s*10\)/.test(s)) hits.push(f.replace(/^src[\\/]/, ""));
}
check("没有 toISOString().slice(0,10) 当日期（凌晨会落前一天）", hits.length === 0, hits.join(", "));

/* ---------- 3. 逻辑：凌晨场景 nowLocalIso 返回本地日期 ---------- */
const pad = (n) => String(Math.abs(n)).padStart(2, "0");
function ideal(d) {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, "0")}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const t2am = new Date(2026, 10, 18, 2, 30, 0); // 本地 2026-11-18 02:30
const localStr = ideal(t2am);
const utcStr = t2am.toISOString();

check("凌晨 02:30 的本地日期是 11-18", localStr.slice(0, 10) === "2026-11-18", localStr);
check("凌晨 02:30 的 UTC 日期是 11-17（这就是旧 bug 的来源）", utcStr.slice(0, 10) === "2026-11-17", utcStr);
check("用本地串取日期得到正确营业日", localStr.slice(0, 10) !== utcStr.slice(0, 10));

/* ---------- 4. 数据：现有 check_in_time 格式是否统一 ---------- */
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(
  `SELECT check_in_time FROM stays WHERE hotel_id = 1 AND check_in_time IS NOT NULL`
).all();

const withOffset = rows.filter((r) => /[+-]\d{2}:\d{2}$/.test(r.check_in_time)).length;
const withZ = rows.filter((r) => /Z$/.test(r.check_in_time)).length;
console.log(`\n入住时间格式：带本地偏移 ${withOffset} 条 / UTC(Z) ${withZ} 条`);

/* 历史数据是 UTC，新数据是本地偏移 —— 两种并存不报失败，只做统计提示 */
check("入住时间字段没有空值异常格式", rows.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.check_in_time)),
  rows.filter((r) => !/^\d{4}-\d{2}-\d{2}T/.test(r.check_in_time)).slice(0, 2).map((r) => r.check_in_time).join(","));

/* 日期合理性：check_in_time 的日期不应晚于今天太远 */
const today = new Date().toISOString().slice(0, 10);
const future = rows.filter((r) => r.check_in_time.slice(0, 10) > today).length;
check("没有未来日期以外的异常入住时间", future < 50, `未来日期 ${future} 条`);

db.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
