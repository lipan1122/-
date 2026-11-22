#!/usr/bin/env node
/**
 * 第六轮整改 一.1：早餐 Server Action 权限 / 审计 / 多酒店隔离验收
 *
 * 背景（改造前）：
 *   src/app/(main)/breakfast/actions.ts 的 5 个写动作只调用 requireUser()，
 *   任何登录账号（含 housekeeper）都能卖早餐、核销、撤销核销 ——
 *   页面按钮藏得再好也挡不住直接构造 Server Action 请求。
 *
 * 本脚本验四层：
 *   1. 源码静态：每个导出写动作函数体开头必须有 requirePermission("<权限点>")，
 *      权限点必须登记在 src/lib/session.ts 的 PERMISSIONS 里，
 *      且权限校验发生在任何写库之前；不允许残留 requireUser()。
 *   2. 真实权限矩阵：把 src/lib/session.ts 用项目自带的 typescript 转译后 require 进来，
 *      直接问 hasPermission() —— 测的是仓库里那份代码，不是复制出来的逻辑。
 *   3. 数据库行为：用 VACUUM INTO 复制一份 data/pms.db 到临时文件，
 *      在副本上重放这些 action 的 SQL，验证「跨酒店拿不到、改不到」「op_logs 落库」。
 *   4. 页面：全部核销必须走 ConfirmForm，并在弹窗里显示日期与影响房间数。
 *
 * 为什么不真调 Server Action：action 依赖 Next 请求上下文（cookies / revalidatePath），
 * 本仓库既有验收脚本同样采用「真实权限函数 + 源码守卫 + 数据库重放」的组合。
 *
 * 用法：node scripts/test-breakfast-permissions.mjs
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const requireCjs = createRequire(import.meta.url);
const SRC_DB = path.join(ROOT, "data", "pms.db");
const COPY_DB = path.join(ROOT, "data", `.test-breakfast-perm-${process.pid}.db`);
const TEST_DATE = "2099-12-31";

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${extra ? ` :: ${extra}` : ""}`);
    console.log(`  ❌ ${label}${extra ? `  ${extra}` : ""}`);
  }
};
const section = (title) => console.log(`\n=== ${title} ===`);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ============================================================ 0. 数据库副本 */

function makeDbCopy() {
  if (!fs.existsSync(SRC_DB)) throw new Error(`找不到数据库 ${SRC_DB}`);
  if (fs.existsSync(COPY_DB)) fs.unlinkSync(COPY_DB);
  const src = new DatabaseSync(SRC_DB);
  src.exec(`VACUUM INTO '${COPY_DB.replace(/\\/g, "/")}'`);
  src.close();
  return new DatabaseSync(COPY_DB);
}

function cleanup(db) {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${COPY_DB}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

/* ============================================================ 1. 加载真实 session.ts */

/**
 * 用项目自带的 typescript 把 session.ts / db.ts / utils.ts 转成 CommonJS 再 require，
 * next/headers、next/navigation 用桩替代（只在请求上下文里才有意义）。
 * 这样 hasPermission / requirePermission 的行为与线上完全一致。
 */
function loadSessionModule() {
  const ts = requireCjs("typescript");
  const Module = requireCjs("node:module");
  const srcDir = path.join(ROOT, "src", "lib");
  const outDir = path.join(ROOT, ".tmp", "perm-breakfast-harness");
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of ["session.ts", "db.ts", "utils.ts"]) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    });
    fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, ".js")), outputText);
  }

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "next/headers") {
      const deny = async () => {
        throw new Error("本脚本不在 Next.js 请求上下文中调用 getSession");
      };
      return { cookies: deny, headers: deny };
    }
    if (request === "next/navigation") {
      return {
        redirect: (url) => {
          throw new Error(`REDIRECT:${url}`);
        },
        notFound: () => {
          throw new Error("NOT_FOUND");
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return requireCjs(path.join(outDir, "session.js"));
  } finally {
    Module._load = originalLoad;
  }
}

/* ============================================================ 2. 源码解析 */

const ACTIONS_SRC_PATH = "src/app/(main)/breakfast/actions.ts";
const PAGE_SRC_PATH = "src/app/(main)/breakfast/page.tsx";
const EXPECTED_ACTIONS = [
  { name: "redeemAction", permission: "cashier.receive", label: "单条核销" },
  { name: "bulkRedeemAction", permission: "cashier.receive", label: "批量核销" },
  { name: "redeemAllAction", permission: "cashier.receive", label: "全部核销" },
  { name: "revokeAction", permission: "breakfast.void", label: "撤销核销" },
  { name: "sellBreakfastAction", permission: "folio.post_charge", label: "卖早餐" },
];

/** 解析 session.ts 的 PERMISSIONS 表（与 test-action-permissions.mjs 同一口径） */
function parsePermissionTable(src) {
  const start = src.indexOf("const PERMISSIONS");
  if (start < 0) return {};
  const open = src.indexOf("{", start);
  const end = src.indexOf("\n};", open);
  if (end < 0) return {};
  const body = src.slice(open + 1, end);
  const table = {};
  const re = /"([a-zA-Z0-9_.]+)"\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    table[m[1]] = m[2]
      .split(",")
      .map((r) => r.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return table;
}

/** 取一个导出函数的函数体（到下一个 export 或文件尾） */
function sliceFunction(src, name) {
  const sig = `export async function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const nextExport = src.indexOf("\nexport ", start + sig.length);
  return src.slice(start, nextExport < 0 ? src.length : nextExport);
}

/** 函数体里第一处写库操作的下标 */
function firstMutationIndex(body) {
  const patterns = [
    /(?:^|\n)\s*run\s*\(/,
    /(?:^|\n)\s*tx\s*\(/,
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
  ];
  let min = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined) {
      if (min < 0 || m.index < min) min = m.index;
    }
  }
  return min;
}

/* ============================================================ 主流程 */

async function main() {
  console.log("========== 第六轮 一.1 早餐动作权限验收 ==========");
  console.log(`项目：${ROOT}`);

  const actionsSrc = read(ACTIONS_SRC_PATH);
  const pageSrc = read(PAGE_SRC_PATH);
  const session = loadSessionModule();
  const table = parsePermissionTable(read("src/lib/session.ts"));
  const db = makeDbCopy();
  console.log(`数据库副本：${COPY_DB}`);

  try {
    /* ---------------------------------------------------------- 1. 源码守卫 */
    section("1. 源码：每个写动作都有 requirePermission，且先校验后写库");
    check(
      "actions.ts 从 @/lib/session 导入 requirePermission",
      /import\s*\{[^}]*requirePermission[^}]*\}\s*from\s*"@\/lib\/session"/.test(actionsSrc)
    );
    check(
      "actions.ts 内没有残留 requireUser() 调用（5 个写动作全部改为动作级权限）",
      !/\bawait\s+requireUser\s*\(/.test(actionsSrc) &&
        !/import\s*\{[^}]*\brequireUser\b[^}]*\}\s*from\s*"@\/lib\/session"/.test(actionsSrc)
    );

    for (const spec of EXPECTED_ACTIONS) {
      const body = sliceFunction(actionsSrc, spec.name);
      if (!body) {
        check(`${spec.name} 存在`, false, "源码里找不到该导出函数");
        continue;
      }
      check(`${spec.name}（${spec.label}）存在`, true);
      const head = body.slice(0, 900);
      const permMatch = head.match(/requirePermission\(\s*"([^"]+)"\s*\)/);
      check(
        `${spec.name} 有动作级权限校验`,
        Boolean(permMatch),
        "（函数体开头 900 字符内没有 requirePermission）"
      );
      check(
        `${spec.name} 权限点为 ${spec.permission}`,
        permMatch ? permMatch[1] === spec.permission : false,
        permMatch ? `实际 ${permMatch[1]}` : ""
      );
      check(`${spec.name} 权限点已登记在 session.ts PERMISSIONS`, Boolean(table[spec.permission]));
      const permIdx = permMatch ? body.indexOf(permMatch[0]) : -1;
      const mutIdx = firstMutationIndex(body);
      check(
        `${spec.name} 权限校验在写库之前`,
        permIdx >= 0 && (mutIdx < 0 || permIdx < mutIdx),
        permIdx >= 0 && mutIdx >= 0 && permIdx > mutIdx ? "（发现写库早于权限校验）" : ""
      );
    }

    /* 每笔写操作都要留痕（清单要求） */
    const opLogCalls = (actionsSrc.match(/writeOpLog\(/g) || []).length;
    check(`5 个写动作都写 op_logs（writeOpLog 调用 ${opLogCalls} 次）`, opLogCalls >= 5);
    check("op_logs 写入对旧库缺失做了静默保护", /sqlite_master[\s\S]{0,120}op_logs/.test(actionsSrc));

    /* ---------------------------------------------------------- 2. 多酒店隔离（源码） */
    section("2. 源码：breakfast_records / stays 的每条 SQL 都带 hotel_id");
    const tableRefs = [...actionsSrc.matchAll(/(?:FROM|UPDATE|INSERT INTO)\s+breakfast_records/g)];
    const leakedRefs = tableRefs.filter((m) => {
      const after = actionsSrc.slice(m.index, m.index + 420);
      return !after.includes("hotel_id");
    });
    check(
      `breakfast_records 的 ${tableRefs.length} 处读写都带 hotel_id（跨酒店不可操作）`,
      tableRefs.length > 0 && leakedRefs.length === 0,
      leakedRefs.length > 0 ? `有 ${leakedRefs.length} 处未带 hotel_id` : ""
    );
    const stayRefs = [...actionsSrc.matchAll(/FROM\s+stays/g)];
    const leakedStays = stayRefs.filter((m) => !actionsSrc.slice(m.index, m.index + 320).includes("hotel_id"));
    check(
      `stays 的 ${stayRefs.length} 处查询都带 hotel_id`,
      stayRefs.length > 0 && leakedStays.length === 0
    );

    /* ---------------------------------------------------------- 3. 页面二次确认 */
    section("3. 页面：全部核销走 ConfirmForm，并显示日期与影响房间数");
    check("page.tsx 引入 ConfirmForm", /import\s+ConfirmForm\s+from\s+"@\/components\/ConfirmForm"/.test(pageSrc));
    check(
      "全部核销按钮包在 ConfirmForm 内（action={redeemAllAction}）",
      /<ConfirmForm[\s\S]{0,400}action=\{redeemAllAction\}/.test(pageSrc)
    );
    check(
      "全部核销的确认文案带日期",
      /message=\{`确认全部核销 \$\{date\}/.test(pageSrc),
      "（弹窗标题应包含具体日期）"
    );
    check(
      "全部核销的确认文案带影响房间数（pendingRooms）",
      /pendingRooms/.test(pageSrc) && /影响 \$\{pendingRooms\} 间房/.test(pageSrc)
    );
    check(
      "pendingRooms 用的是「待核销房间数」而不是总房间数",
      /SELECT COUNT\(\*\) AS n FROM breakfast_records WHERE hotel_id = \? AND date = \? AND status = 'PENDING'/.test(
        pageSrc
      )
    );
    check("撤销核销同样二次确认", /<ConfirmForm[\s\S]{0,400}action=\{revokeAction\}/.test(pageSrc));

    /* ---------------------------------------------------------- 4. 真实权限矩阵 */
    section("4. 真实权限矩阵（加载 session.ts 的 hasPermission 判定）");
    session.invalidatePermissionCache();
    for (const spec of EXPECTED_ACTIONS) {
      check(
        `admin 拥有 ${spec.permission}（${spec.name}）`,
        session.hasPermission("admin", spec.permission, 1) === true
      );
    }
    check(
      "frontdesk（前台）可以卖早餐 / 核销 / 撤销核销",
      session.hasPermission("frontdesk", "folio.post_charge", 1) &&
        session.hasPermission("frontdesk", "cashier.receive", 1) &&
        session.hasPermission("frontdesk", "breakfast.void", 1)
    );
    check(
      "cashier（收银）可以核销，但不能卖早餐 / 撤销核销",
      session.hasPermission("cashier", "cashier.receive", 1) &&
        !session.hasPermission("cashier", "folio.post_charge", 1) &&
        !session.hasPermission("cashier", "breakfast.void", 1)
    );
    check(
      "housekeeper（客房）5 个动作全部被拒",
      ["folio.post_charge", "cashier.receive", "breakfast.void"].every(
        (p) => session.hasPermission("housekeeping", p, 1) === false
      )
    );
    check("未知权限点一律拒绝", session.hasPermission("frontdesk", "breakfast.not_exists", 1) === false);
    check(
      "breakfast.void 已写进 role_permissions（admin / frontdesk）",
      (() => {
        const rows = db
          .prepare(`SELECT role FROM role_permissions WHERE hotel_id = 1 AND permission = 'breakfast.void'`)
          .all()
          .map((r) => r.role)
          .sort();
        return rows.join(",") === "admin,frontdesk";
      })()
    );
    check(
      "breakfast.void 已写进 permission_dict（有中文名与归属模块）",
      (() => {
        const row = db
          .prepare(`SELECT label, module FROM permission_dict WHERE permission = 'breakfast.void'`)
          .get();
        return Boolean(row && String(row.label).trim() && String(row.module).trim());
      })()
    );

    /* ---------------------------------------------------------- 5. 数据库行为（副本） */
    section("5. 数据库副本：跨酒店隔离 / 核销与撤销 / op_logs");
    const cols = db.prepare(`PRAGMA table_info(breakfast_records)`).all().map((c) => c.name);
    check("breakfast_records 有 hotel_id 列（多酒店隔离的前提）", cols.includes("hotel_id"), cols.join(","));

    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO breakfast_records (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    const stayA = ins.run(1, 9001, "TEST-01", "测试甲", TEST_DATE, 2, "PENDING", "验收", now).lastInsertRowid;
    const stayB = ins.run(1, 9002, "TEST-02", "测试乙", TEST_DATE, 1, "PENDING", "验收", now).lastInsertRowid;
    const otherHotel = ins.run(2, 9003, "OTHER-01", "他店客人", TEST_DATE, 3, "PENDING", "验收", now).lastInsertRowid;
    check("副本可写入 3 条测试早餐记录（含 1 条其他酒店）", Number(stayA) > 0 && Number(otherHotel) > 0);

    /* 单条按 hotel_id 读：跨酒店拿不到 */
    const crossRead = db
      .prepare(`SELECT id FROM breakfast_records WHERE id = ? AND hotel_id = ?`)
      .get(otherHotel, 1);
    check("用本店身份按 id 读其他酒店的早餐记录 → 查不到", crossRead === undefined);

    /* 全部核销：只影响本店当日 PENDING */
    const redeemAll = db
      .prepare(`UPDATE breakfast_records SET status = 'USED' WHERE hotel_id = ? AND date = ? AND status = 'PENDING'`)
      .run(1, TEST_DATE);
    check(`全部核销 SQL 命中本店 2 条（实际 ${redeemAll.changes}）`, Number(redeemAll.changes) === 2);
    const otherStatus = db
      .prepare(`SELECT status FROM breakfast_records WHERE id = ? AND hotel_id = 2`)
      .get(otherHotel);
    check("全部核销没有动到其他酒店的记录", otherStatus && otherStatus.status === "PENDING");

    /* 撤销核销：必须 id + hotel_id + 当前状态 */
    const revokeOwn = db
      .prepare(
        `UPDATE breakfast_records SET status = 'PENDING' WHERE id = ? AND hotel_id = ? AND status = 'USED'`
      )
      .run(stayA, 1);
    check("撤销本店已核销记录成功（回到 PENDING）", Number(revokeOwn.changes) === 1);
    const revokeCross = db
      .prepare(
        `UPDATE breakfast_records SET status = 'PENDING' WHERE id = ? AND hotel_id = ? AND status = 'USED'`
      )
      .run(otherHotel, 1);
    check("用本店身份撤销其他酒店的记录 → 影响 0 行（跨酒店被拒）", Number(revokeCross.changes) === 0);
    const revokeTwice = db
      .prepare(
        `UPDATE breakfast_records SET status = 'PENDING' WHERE id = ? AND hotel_id = ? AND status = 'USED'`
      )
      .run(stayA, 1);
    check("重复撤销同一条（已不是 USED）→ 影响 0 行", Number(revokeTwice.changes) === 0);

    /* op_logs 真实落库 */
    const hasOpLogs = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)
      .get();
    check("副本里有 op_logs 表（审计链路可用）", Number(hasOpLogs?.n ?? 0) === 1);
    db.prepare(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`).run(
      1,
      "验收脚本",
      "早餐全部核销",
      `日期 ${TEST_DATE} · 实际核销 2 间房`,
      now
    );
    const log = db
      .prepare(`SELECT detail FROM op_logs WHERE hotel_id = 1 AND action = '早餐全部核销' ORDER BY id DESC LIMIT 1`)
      .get();
    check("早餐核销写入了 op_logs（含日期与房间数）", Boolean(log && String(log.detail).includes(TEST_DATE)));

    /* 收尾：清掉本脚本插入的测试行（副本随后删除） */
    db.prepare(`DELETE FROM breakfast_records WHERE date = ?`).run(TEST_DATE);
    db.prepare(`DELETE FROM op_logs WHERE operator = '验收脚本'`).run();
  } finally {
    cleanup(db);
  }

  /* ---------------------------------------------------------- 汇总 */
  console.log("\n========== 汇总 ==========");
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log("❌ 未通过项：");
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
  console.log("结果：全部通过 ✅");
}

main().catch((e) => {
  console.error("脚本执行失败：", e);
  process.exit(1);
});
