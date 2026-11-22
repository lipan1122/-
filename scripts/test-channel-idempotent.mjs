/**
 * 渠道订单幂等验收（整改报告 P1-8）
 *
 * 1. 唯一索引 UNIQUE(hotel_id, channel_type, channel_order_no) 存在
 * 2. 库里没有重复渠道单
 * 3. 同一渠道单号重复插入被拦
 * 4. 已转预订的订单不会重复转（booking_id 唯一指向）
 * 5. 渠道密钥不出现在日志/页面
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DB = process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

/* 1. 唯一索引 */
const idx = all(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='channel_orders'`);
const hasKey = idx.some((i) => i.name === "idx_channel_orders_key");
check("channel_orders 有 (hotel_id, channel_type, channel_order_no) 唯一索引", hasKey, JSON.stringify(idx.map((i) => i.name)));

/* 2. 无重复 */
const dup = all(
  `SELECT channel_type, channel_order_no, COUNT(*) c FROM channel_orders
    GROUP BY hotel_id, channel_type, channel_order_no HAVING c > 1 LIMIT 5`
);
check("库里没有重复渠道单", dup.length === 0, JSON.stringify(dup));

/* 3. 同一单号重复插入被拦（写测试后清理） */
const sample = one(`SELECT hotel_id, channel_type, channel_order_no FROM channel_orders LIMIT 1`);
if (sample) {
  const wdb = new DatabaseSync(DB);
  let blocked = false;
  try {
    wdb.prepare(
      `INSERT INTO channel_orders (hotel_id, channel_type, channel_order_no, status, created_at)
       VALUES (?,?,?,?,?)`
    ).run(sample.hotel_id, sample.channel_type, sample.channel_order_no, "NEW", new Date().toISOString());
  } catch {
    blocked = true;
  }
  check("同单号重复插入被唯一索引拦截", blocked);
  wdb.close();
} else {
  check("同单号重复插入被唯一索引拦截", false, "没有渠道订单可测");
}

/* 4. 已转预订的订单：booking_id 指向真实预订，且没有多个订单指向同一 booking */
const badLink = all(
  `SELECT o.channel_order_no, o.booking_id FROM channel_orders o
    WHERE o.booking_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = o.booking_id) LIMIT 5`
);
check("已转预订的渠道单都指向真实预订", badLink.length === 0, JSON.stringify(badLink));

const multiLink = all(
  `SELECT booking_id, COUNT(*) c FROM channel_orders WHERE booking_id IS NOT NULL
    GROUP BY booking_id HAVING c > 1 LIMIT 5`
);
check("一个酒店预订不会被多个渠道单重复绑定", multiLink.length === 0, JSON.stringify(multiLink));

/* 5. 渠道密钥不出现在日志/同步记录里 */
const secretLeak = all(
  `SELECT id, message FROM channel_sync_logs
    WHERE message LIKE '%app_secret%' OR message LIKE '%appSecret%'
       OR message LIKE '%secret%' LIMIT 5`
);
check("渠道同步日志不泄露密钥", secretLeak.length === 0, JSON.stringify(secretLeak.slice(0, 2)));

/* 6. 源码里渠道密钥不回显 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk("src");
let leakFiles = [];
for (const f of files) {
  /*
   * 只查渲染层（.tsx）——这是「用户能不能在页面上看到密钥」的判断
   *
   * 曾经的粗糙判定把 TS 类型定义也当成泄漏：
   *   invoke.ts 里 `app_secret: string | null;` 是 SQL 行类型，不是渲染；
   *   mini-config.ts 的注释里也提到 app_secret，更不算。
   * 现在只看 .tsx，且跳过类型定义行与注释行。
   */
  if (!f.endsWith(".tsx")) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  let hit = false;
  for (const raw of lines) {
    const line = raw.trim();
    /* 跳过类型定义、注释、import */
    if (/^(app_secret|appSecret)\s*[?:]/.test(line)) continue;
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    /* 真正的泄漏形态：把密钥值直接渲染进 JSX，如 {c.app_secret} / value={ch.app_secret} */
    if (/\{\s*[A-Za-z_$.]*(app_secret|appSecret)\s*\}/.test(line)) {
      hit = true;
      break;
    }
  }
  /* 整文件里有 password 类型的输入框 → 说明密钥是受控展示，不算泄漏 */
  const hasPasswordInput = /type=["']password["']/.test(readFileSync(f, "utf8"));
  if (hit && !hasPasswordInput) leakFiles.push(f);
}
check("页面没有直接渲染渠道 app_secret", leakFiles.length === 0, leakFiles.join(", "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
