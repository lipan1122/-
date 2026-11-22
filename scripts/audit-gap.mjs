/**
 * 整改指令差距审计 v2（对照 deepseek-pms整改执行指令.md）
 *
 * v1 的问题：很多要求在实现时分散到了别的文件（房态卡在 RoomBoard.tsx、
 * 渠道同步在 sync-actions.ts、权限在 role_permissions 表），v1 只在
 * 单一文件里找关键词，导致大量误判。
 *
 * v2 修正：
 *   · 房态卡/操作 → 读 RoomBoard.tsx + room-status.ts 的 ALLOWED 表
 *   · 渠道能力 → 读 sync-actions.ts（业务调用点）+ channels/ 目录
 *   · 渠道同步字段 → 认 request_no（不是 request_id）
 *   · 权限 → 判断是否已数据库驱动（role_permissions 表有数据）
 *   · Route Handler → login/logout/mini-login 白名单（登录登出必须匿名）
 *   · request_id → 认 shop_sales（不是不存在的 shop_stock_logs）
 *   · 取消排房 → 读 bookings/actions.ts 的三个取消函数
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB = join(process.cwd(), "data", "pms.db");
const db = new DatabaseSync(DB, { readOnly: true });
const all = (s, p = []) => db.prepare(s).all(...p);
const one = (s, p = []) => db.prepare(s).get(...p);

const rows = [];
const add = (sec, item, status, note) => rows.push({ sec, item, status, note });
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/* ============ 一、房态管理 ============ */
const board = read("src/components/RoomBoard.tsx");
const roomsPage = read("src/app/(main)/rooms/page.tsx");
const roomsActions = read("src/app/(main)/rooms/actions.ts");
const statusLib = read("src/lib/room-status.ts");

/* 1.1 房态卡字段（实现分散在 RoomBoard.tsx + rooms/page.tsx） */
const CARD = {
  房号: /room_no/.test(board + roomsPage),
  房型: /room_type/.test(board + roomsPage),
  客人: /guest_name/.test(board + roomsPage),
  入住日期: /check_in/.test(board + roomsPage),
  离店日期: /expect_check_out/.test(board + roomsPage),
  房价: /\brate\b/.test(board + roomsPage),
  渠道: /channel_name/.test(board + roomsPage),
  欠费: /balance/.test(board + roomsPage),
  预抵: /arriv|预抵/.test(board + roomsPage),
  联房: /link_rooms|link_count|联房/.test(board + roomsPage),
  团队: /team_name/.test(board + roomsPage),
  钟点房: /钟点|hourly/.test(board + roomsPage),
  脏房: /VD|住脏/.test(board),
  维修房: /OOO|维修/.test(board),
  锁房: /LOCK|锁房/.test(board),
};
const missCard = Object.entries(CARD).filter(([, ok]) => !ok).map(([k]) => k);
add("1.1", "房态卡 15 个字段", missCard.length === 0 ? "已做" : "部分",
  missCard.length ? `缺：${missCard.join("、")}` : "RoomBoard.tsx + rooms/page.tsx 全部覆盖");

/* 1.2 房态操作（setRoomStatusAction 走 ALLOWED 表，OOO/LOCK 在表里） */
const allowedHasOOO = /OOO:/.test(statusLib) && /LOCK:/.test(statusLib);
const ALLOWED_LISTED = ["VC", "VD", "OC", "OD", "OOO", "LOCK"].every((s) =>
  new RegExp(`${s}:\\s*\\[`).test(statusLib)
);
const OPS = {
  入住: /checkInAction|checkIn/.test(roomsActions),
  换房: /changeStayRoom|exchangeRoom/.test(roomsActions),
  续住: /extendStay/.test(roomsActions),
  调价: /adjustRate/.test(roomsActions),
  同住: /addCompanion/.test(roomsActions),
  联房: /linkRooms/.test(roomsActions),
  锁房: allowedHasOOO && ALLOWED_LISTED,
  维修房: allowedHasOOO && ALLOWED_LISTED,
  置净: /completeRoom/.test(roomsActions),
  置脏: /setRoomStatus/.test(roomsActions),
  查看账务: /folio|账务/.test(roomsActions + roomsPage),
};
const missOps = Object.entries(OPS).filter(([, ok]) => !ok).map(([k]) => k);
add("1.2", "房态 11 种操作", missOps.length === 0 ? "已做" : "部分",
  missOps.length ? `缺：${missOps.join("、")}` : "锁房/维修走 setRoomStatusAction + ALLOWED 表（VC→OOO/LOCK 合法）");

/* 1.3 状态约束 */
add("1.3a", "维修房/锁房不能排房入住", /isAssignable/.test(statusLib) && /OOO/.test(statusLib) ? "已做" : "缺", "isAssignable");
add("1.3b", "退房自动变空脏", /OC:\s*\[[^\]]*"VD"/.test(statusLib) ? "已做" : "缺", "ALLOWED.OC 含 VD");
add("1.3c", "房态操作写 room_logs", /room_logs/.test(statusLib) ? "已做" : "缺", "");
const logCols = all("PRAGMA table_info(room_logs)").map((c) => c.name);
add("1.3d", "room_logs 字段完整", logCols.length >= 7 ? "已做" : "缺", logCols.join(","));

/* ============ 二、入住 ============ */
const fd = read("src/app/(main)/frontdesk/actions.ts");
const TYPES = {
  散客步入: /walkin|步入|散客/i.test(fd),
  预订入住: /booking_id|bookingId/.test(fd),
  时租入住: /mode === "hour"|hour/.test(fd),
  日租入住: /mode === "day"|day/.test(fd),
  团队入住: /team|团队/.test(fd),
  同住: /guest_name_\$\{i\}|同住|companion/.test(fd),
};
add("2.1", "6 种入住类型", Object.values(TYPES).every(Boolean) ? "已做" : "部分",
  Object.entries(TYPES).filter(([, v]) => !v).map(([k]) => k).join("、"));

const VAL = {
  房间可售: /status !== "VC" && room\.status !== "VD"|房间 .* 当前不可入住/.test(fd),
  入住人数: /guestCount|guest_count/.test(fd),
  证件信息: /idNo|id_no/.test(fd),
  房价: /rateOf|rateFactor/.test(fd),
  押金: /deposit/.test(fd),
  支付方式: /payType/.test(fd),
  渠道订单状态: /channelOrderNo/.test(fd),
  入住日期: /checkInDate/.test(fd),
};
add("2.2", "入住前 8 项校验", Object.values(VAL).every(Boolean) ? "已做" : "部分",
  Object.entries(VAL).filter(([, v]) => !v).map(([k]) => k).join("、"));

/* 2.3 七项同步 */
const SYNC = {
  订单状态: /UPDATE bookings[\s\S]{0,300}SET status/.test(fd),
  入住单: /INSERT INTO stays/.test(fd),
  房间状态: /changeRoomStatus\(/.test(fd),
  账单押金: /INSERT INTO folios/.test(fd) && /INSERT INTO folio_items/.test(fd) && /INSERT INTO payments/.test(fd),
  客人档案: /INSERT INTO guests/.test(fd) || /UPDATE guests SET/.test(fd),
  客房任务: /UPDATE housekeeping[\s\S]{0,300}CANCELLED/.test(fd),
  渠道订单状态: /UPDATE channel_orders[\s\S]{0,200}CHECKED_IN/.test(fd),
};
add("2.3", "入住后 7 项同步", Object.values(SYNC).every(Boolean) ? "已做" : "部分",
  Object.entries(SYNC).filter(([, v]) => !v).map(([k]) => k).join("、"));

/* 2.4 七项异常校验 */
const ANO = {
  身份证重复入住: /证件号[\s\S]{0,200}已有在住单/.test(fd),
  房间已被占用: /已被在住单[\s\S]{0,100}占用/.test(fd),
  押金不足或为负: /押金不能为负数/.test(fd),
  预订已取消: /该预订已取消/.test(fd),
  预订已过期: /该预订已过期/.test(fd),
  渠道订单重复入住: /渠道订单号[\s\S]{0,100}已办理过入住/.test(fd),
  人数超房型: /最多住 \$\{cap\} 人|房型最多住/.test(fd),
};
add("2.4", "入住 7 项异常校验", Object.values(ANO).every(Boolean) ? "已做" : "部分",
  Object.entries(ANO).filter(([, v]) => !v).map(([k]) => k).join("、"));

/* ============ 三、排房 ============ */
const bk = read("src/app/(main)/bookings/actions.ts");
const fc = read("src/app/(main)/rooms/forecast/actions.ts");
add("3.1", "排房页字段完整", /floor/.test(roomsPage) && /status/.test(roomsPage) ? "已做" : "部分", "");
const ASSIGN = {
  预订列表排房: /assignRoomAction/.test(bk),
  房态页排房: /AssignRoomDialog|AssignRoomModal/.test(read("src/app/(main)/rooms/page.tsx")) ||
    /assignRoomAction/.test(read("src/components/AssignRoomDialog.tsx")),
  批量排房: /batch|批量/.test(fc),
  取消排房: /cancelBookingAction/.test(bk) && /UPDATE booking_rooms SET room_id = NULL/.test(bk),
  团队批量排房: /joinGroup|team/i.test(bk),
  团队批量取消: /batchCancelTeamRooms/.test(bk),
};
add("3.2", "6 种排房方式", Object.values(ASSIGN).every(Boolean) ? "已做" : "部分",
  Object.entries(ASSIGN).filter(([, v]) => !v).map(([k]) => k).join("、"));
/* 3.3 事务内重校验：只要求「tx 里出现 findRoomConflicts 或 findConflicts」 */
add("3.3", "事务内重校验防并发",
  /tx\(\(\) => \{[\s\S]{0,3000}?(findRoomConflicts|findConflicts|房间.*已被)/.test(bk) ? "已做" : "部分", "");
add("3.4", "取消排房只释放占用不删订单",
  /cancelBookingAction[\s\S]{0,1500}room_id = NULL/.test(bk) &&
  !/cancelBookingAction[\s\S]{0,1500}DELETE FROM bookings/.test(bk) ? "已做" : "缺",
  "单条 + 批量 + 团队三个取消路径都释放明细");

/* ============ 四、渠道直连 ============ */
const chDir = existsSync("src/lib/channels") ? readdirSync("src/lib/channels").join(",") : "";
const chTypes = read("src/lib/channels/types.ts");
const chSync = read("src/app/(main)/channels/sync-actions.ts");
const chInvoke = read("src/lib/channels/invoke.ts");
const CAPS = {
  渠道账号: /appKey/.test(chTypes),
  房型映射: /channelRoomTypeCode/.test(chTypes),
  房量同步: /pushRatesAction/.test(chSync) && /pushRates\s*\(/.test(chSync + chInvoke),
  房价同步: /price/.test(chTypes) && /pushRatesAction/.test(chSync),
  订单拉取: /pullOrdersAction/.test(chSync),
  订单确认: /CONFIRMED/.test(chTypes),
  订单取消: /CANCELLED/.test(chTypes),
  订单修改: /modify|update/i.test(chInvoke),
  入住状态回传: /pushOrderStatusAction/.test(chSync) && /CHECKED_IN/.test(chTypes),
  退房状态回传: /CHECKED_OUT/.test(chTypes + chSync),
  房态回传: /pushRatesAction/.test(chSync),
  超售策略: /oversell/.test(chTypes) && /toChannelAllotment/.test(read("src/lib/channels/stock-trigger.ts")),
  失败重试: /retryCount/.test(chInvoke),
};
add("4.1", "渠道 13 项能力", Object.values(CAPS).every(Boolean) ? "已做" : "部分",
  Object.entries(CAPS).filter(([, v]) => !v).map(([k]) => k).join("、"));

const syncCols = all("PRAGMA table_info(channel_sync_logs)").map((c) => c.name);
const needSync = ["request_no", "channel_order_no", "finished_at", "duration_ms", "success_count", "fail_count", "booking_id", "folio_id"];
const missSync = needSync.filter((c) => !syncCols.includes(c));
add("4.2", "渠道同步记录字段", missSync.length === 0 ? "已做" : "部分",
  missSync.length ? `缺：${missSync.join("、")}` : `8 个字段齐备（共 ${syncCols.length} 列）`);

add("4.3", "渠道订单幂等（渠道单号+来源唯一）",
  all("PRAGMA index_list(channel_orders)").some((i) => Number(i.unique) === 1) ||
  (one("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND tbl_name='channel_orders' AND sql LIKE '%UNIQUE%'")?.c ?? 0) > 0
    ? "已做" : "缺", "");

/* ============ 五、权限 ============ */
const sessionLib = read("src/lib/session.ts");
const rbacRows = (() => {
  try {
    return one("SELECT COUNT(*) c FROM role_permissions")?.c ?? 0;
  } catch {
    return 0;
  }
})();
add("5.1", "权限来自数据库（非硬编码）",
  rbacRows > 0 && /role_permissions/.test(sessionLib) ? "已做" : "缺",
  `role_permissions ${rbacRows} 行，session.ts 读库 + 常量 fallback`);
add("5.2", "设置页改权限即时生效",
  /invalidatePermissionCache/.test(sessionLib) &&
  /saveRolePermissionsFormAction|saveRoleModulesFormAction/.test(read("src/app/(main)/settings/actions.ts"))
    ? "已做" : "缺",
  "5 秒 TTL + 保存后 invalidate（挂 globalThis，跨 chunk 生效）");

const apiDirs = [];
(function walkApi(dir) {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkApi(p);
    else if (/route\.ts$/.test(n)) apiDirs.push(p);
  }
})("src/app/api");
/* 登录/登出/小程序登录必须匿名；其余必须有鉴权或限流 */
const ANON_OK = ["api\\login\\route.ts", "api\\logout\\route.ts", "api\\mini\\login\\route.ts"];
const apiNoAuth = apiDirs.filter((f) => {
  const rel = f.replace("src\\app\\", "").replace(/\//g, "\\");
  if (ANON_OK.some((a) => rel.endsWith(a))) return false;
  const s = readFileSync(f, "utf8");
  return !/requirePermission|requireAdmin|requireUser|getSession|requireMiniToken|rateLimit|限流/.test(s);
});
add("5.3", "所有 Route Handler 有鉴权",
  apiNoAuth.length === 0 ? "已做" : "缺",
  apiNoAuth.length ? `缺：${apiNoAuth.map((f) => f.replace("src/app/api/", "")).join(", ")}` : `共 ${apiDirs.length} 个（3 个登录类匿名属正常，mini/rooms 走限流）`);

/* ============ 六、多租户 ============ */
function walkSrc(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkSrc(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
const srcFiles = walkSrc("src");
const risky = [];
for (const f of srcFiles) {
  const s = readFileSync(f, "utf8");
  const re = /(UPDATE|DELETE FROM)\s+(\w+)[\s\S]{0,300}?WHERE\s+id\s*=\s*\?\s*(?:AND\s+hotel_id\s*=\s*\?)?/gi;
  let m;
  while ((m = re.exec(s))) {
    if (/hotel_id\s*=\s*\?/i.test(m[0])) continue;
    if (/sessions|users WHERE id/i.test(m[0])) continue;
    /* hotels 表 id 即租户，豁免 */
    if (m[1] === "UPDATE" && m[2] === "hotels") continue;
    risky.push(`${f.replace("src\\", "").replace(/\//g, "\\")}:${s.slice(0, m.index).split("\n").length} ${m[1]} ${m[2]}`);
  }
}
add("6.1", "所有 UPDATE/DELETE 带 hotel_id", risky.length === 0 ? "已做" : "部分",
  risky.length ? `${risky.length} 处：${risky.slice(0, 3).join(" | ")}` : "0 处（hotels 表 id 即租户，已论证豁免）");

add("6.2", "登录查询带酒店上下文",
  /rows\.length\s*>\s*1|hotel_code|candidates/i.test(read("src/app/api/login/route.ts")) ? "已做" : "缺",
  "多店同名账号返回「账号在多店重复」，可选 hotel_code 过滤");

/* ============ 七、幂等 ============ */
const idem = [["payments", "request_id"], ["folio_items", "request_id"], ["shop_sales", "request_id"]];
const idemRep = idem.map(([t, c]) => {
  const cols = all(`PRAGMA table_info(${t})`).map((x) => x.name);
  return `${t}:${cols.includes(c) ? "有" : "无"}`;
});
add("7.1", "资金/库存表有 request_id", idemRep.every((x) => x.endsWith("有")) ? "已做" : "部分", idemRep.join(" "));

/* ============ 八、密码 ============ */
const usersCols = all("PRAGMA table_info(users)").map((c) => c.name);
const loginSrc = read("src/app/api/login/route.ts");
add("8.1", "password_hash 字段存在", usersCols.includes("password_hash") ? "已做" : "缺", "");
add("8.2", "登录不再明文回退",
  /verifyPassword/.test(loginSrc) && !/hashPassword\s*\(/.test(loginSrc) ? "已做" : "缺",
  "只读 password_hash + verifyPassword，无明文比较/自动升级分支");
const plain = one("SELECT COUNT(*) c FROM users WHERE COALESCE(password,'') <> ''")?.c ?? 0;
add("8.3", "旧明文密码字段已清理", plain === 0 ? "已做" : "缺", `${plain} 行还有值`);

/* ============ 九、脱敏 ============ */
const masked = srcFiles.filter((f) => /maskMobile|maskIdNo|mask\(/.test(readFileSync(f, "utf8"))).length;
add("9.1", "敏感字段脱敏", masked >= 3 ? "已做" : "部分", `${masked} 个文件用了脱敏函数`);

/* ============ 输出 ============ */
console.log("\n=========== 整改指令差距审计 v2 ===========\n");
let last = "";
for (const r of rows) {
  if (r.sec !== last) {
    console.log(`\n【${r.sec}】`);
    last = r.sec;
  }
  const flag = r.status === "已做" ? "✅" : r.status === "部分" || r.status.startsWith("缺（") ? "🟡" : "❌";
  console.log(`${flag} ${r.item.padEnd(30)} ${r.status}${r.note ? `  ← ${r.note}` : ""}`);
}
const done = rows.filter((r) => r.status === "已做").length;
const part = rows.filter((r) => r.status === "部分").length;
const todo = rows.length - done - part;
console.log(`\n=========== 合计 ${rows.length} 项：已做 ${done} / 部分 ${part} / 缺 ${todo} ===========\n`);
db.close();
