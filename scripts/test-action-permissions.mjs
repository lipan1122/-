#!/usr/bin/env node
/**
 * 整改验收：P0-3 动作层权限（Server Action 必须服务端拦越权）
 *
 * 背景：很多 Server Action 只用 `await requireUser()`（只校验登录），
 *       前台 / 收银 / 客房账号可以直接构造请求调用越权的写动作。
 *
 * 本脚本分两段：
 *   1) 【静态源码校验，必跑、为验收依据】
 *      - 逐个解析 night-audit / bookings / inhouse 的 actions.ts
 *      - 每个 export async function 必须在函数体最前面调用
 *        requirePermission("权限点") 或 requireAdmin()
 *      - 权限点必须存在于 src/lib/session.ts 的 PERMISSIONS 表
 *      - 权限点必须出现在任何一次写库（run/tx/INSERT/UPDATE/DELETE）之前
 *      - 收银 / 客房这类受限角色必须不在权限点的允许列表里（admin 由 hasPermission 默认全通过）
 *      - 函数清单必须与 EXPECT 表完全一致，防止新增 action 漏登记
 *   2) 【HTTP 运行时校验，可选】
 *      - 服务在 3100 时：用 front / cashier / housekeeper 账号登录，
 *        以 MPA 表单方式（$ACTION_ID_<id> + multipart）真实 POST 到页面路由
 *      - 期望：无权限角色被服务端拒绝（500 / FORBIDDEN），有权限角色不被拒
 *      - 服务没起 → 跳过并提示
 *      - 服务是「源码修改之前的旧构建」 → 跳过并提示（本次整改禁止 next build，
 *        否则会拿旧代码的运行结果误判）
 *
 * 用法：
 *   node scripts/test-action-permissions.mjs            # 默认（有需要时会跑 HTTP 段）
 *   node scripts/test-action-permissions.mjs --no-http  # 只做静态校验
 *   PMS_BASE=http://localhost:3100 node scripts/test-action-permissions.mjs
 *
 * 退出码：有 ❌ 时为 1，全绿为 0。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = process.env.PMS_BASE || "http://localhost:3100";
const NO_HTTP = process.argv.includes("--no-http") || process.env.PMS_NO_HTTP === "1";

/* ============================================================ 期望表 */

/**
 * 每个模块 → 每个导出 action 的期望权限点，以及「必须被拒」的受限角色。
 * 这张表同时充当「只读白名单」的补充：不在这里的导出函数会被判为漏登记。
 */
const MODULES = [
  {
    file: "src/app/(main)/night-audit/actions.ts",
    page: "/night-audit",
    actions: {
      // 夜审：过账全店房费 + 批量 NOSHOW + 重算所有账单 + 写营收汇总 → 仅 admin
      runNightAuditAction: {
        permission: "night_audit.run",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        // 运行时不能拿「有权限的角色」去真跑夜审（会写库），只验证受限角色被拦
        skipAllowedRuntime: true,
        params: {},
      },
      // 第 4 轮 P1-18：撤销夜审（冲正房费 + 还原 NOSHOW + 删营收日报）→ 仅 admin
      undoNightAuditAction: {
        permission: "night_audit.undo",
        rejected: ["frontdesk", "cashier", "housekeeping"],
        skipAllowedRuntime: true,
        params: { reason: "权限测试" },
      },
    },
  },
  {
    file: "src/app/(main)/bookings/actions.ts",
    page: "/bookings",
    actions: {
      createBookingAction: { permission: "booking.create", rejected: ["cashier", "housekeeping"], params: {} },
      cancelBookingAction: { permission: "booking.cancel", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      confirmBookingAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      deleteBookingAction: { permission: "booking.delete", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      batchConfirmBookingsAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchCancelBookingsAction: { permission: "booking.cancel", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchDeleteBookingsAction: { permission: "booking.delete", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchCancelTeamRoomsAction: { permission: "booking.cancel", rejected: ["cashier", "housekeeping"], params: { ids: "999999" } },
      batchAdjustRateBookingsAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { ids: "999999", rate: "1" } },
      updateBookingRemarkAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      updateOrderRemarkAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      assignRoomAction: { permission: "booking.assign_room", rejected: ["cashier", "housekeeping"], params: { bookingId: 999999, roomIds: "" } },
      // 调价给负数 → 命中「请填写正确的房价」提前返回，无库写入
      adjustPriceAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { id: 999999, rate: "-1" } },
      // 不传 id → 直接 redirect 返回，无库写入
      freeUpgradeAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: {} },
      joinGroupAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: {} },
    },
  },
  {
    file: "src/app/(main)/inhouse/actions.ts",
    page: "/inhouse",
    actions: {
      extendStayAction: { permission: "checkin.create", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999 } },
      changeRoomAction: { permission: "booking.assign_room", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999, new_room_id: 1 } },
      postRoomChargeAction: { permission: "folio.post_charge", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999 } },
      // 不传参数会去批量补过「昨日在住」的房费 → 只验证受限角色被拦，不让有权限角色真跑
      postAllMissingRoomChargesAction: {
        permission: "folio.post_charge",
        rejected: ["cashier", "housekeeping"],
        skipAllowedRuntime: true,
        params: {},
      },
      requestCancelAction: { permission: "checkin.cancel", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999, reason: "验收探针" } },
      approveCancelAction: { permission: "checkin.cancel", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      rejectCancelAction: { permission: "checkin.cancel", rejected: ["cashier", "housekeeping"], params: { id: 999999 } },
      convertStayModeAction: { permission: "booking.modify", rejected: ["cashier", "housekeeping"], params: { stay_id: 999999, mode: "daily", nights: 1 } },
    },
  },
];

/**
 * 只读操作白名单：允许继续用 requireUser() 的导出函数。
 * 当前这三个文件的导出全部是写操作，所以白名单为空；格式示例：
 *   { "src/app/(main)/bookings/actions.ts": ["listBookingsAction"] }
 */
const READ_ONLY = {};

/* ============================================================ 工具 */

let pass = 0;
let fail = 0;
const failures = [];
/** HTTP 运行时段被跳过的原因（非空 = 本次只验了静态段，汇总里必须说出来） */
let runtimeSkipReason = "";
/**
 * 是否要求 HTTP 运行时段必须执行：
 *   · 默认不要求（本地/本轮禁止 next build 时也能跑，跳过会打印原因）
 *   · PMS_REQUIRE_HTTP=1 或 --require-http → 跳过即判红，CI / 发布前用它防「假通过」
 */
const REQUIRE_HTTP = process.env.PMS_REQUIRE_HTTP === "1" || process.argv.includes("--require-http");
/** HTTP 段跳过入口：默认显式记录原因；要求在跑时直接判红 */
function skipRuntime(reason) {
  console.log(`  ⏭️  ${reason}`);
  if (REQUIRE_HTTP) {
    fail += 1;
    failures.push(`HTTP 运行时段未执行：${reason}（--require-http / PMS_REQUIRE_HTTP=1 要求必须跑）`);
    return;
  }
  runtimeSkipReason = reason;
}

const check = (ok, label, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${extra ? ` :: ${extra}` : ""}`);
    console.log(`  ❌ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const fmtTime = (ms) =>
  new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/* ============================================================ 1. 解析权限表 */

function parsePermissionTable() {
  const src = read("src/lib/session.ts");
  const start = src.indexOf("const PERMISSIONS");
  if (start < 0) throw new Error("src/lib/session.ts 里找不到 PERMISSIONS 表");
  const open = src.indexOf("{", start);
  // 表结束：从 open 开始找第一处 "\n};"
  const end = src.indexOf("\n};", open);
  if (end < 0) throw new Error("PERMISSIONS 表结构异常：找不到结束的 }");
  const body = src.slice(open + 1, end);

  /** @type {Record<string, string[]>} */
  const table = {};
  const re = /"([a-zA-Z0-9_.]+)"\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const roles = m[2]
      .split(",")
      .map((r) => r.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    table[m[1]] = roles;
  }
  return { src, table };
}

/* ============================================================ 2. 静态校验一个模块 */

/** 取一个导出函数的函数体（到下一个 export 或文件尾） */
function sliceFunction(src, name) {
  const sig = `export async function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const nextExport = src.indexOf("\nexport ", start + sig.length);
  const end = nextExport < 0 ? src.length : nextExport;
  return src.slice(start, end);
}

/** 函数体里第一处写库操作的下标（用于断言「权限校验在写库之前」） */
function firstMutationIndex(body) {
  const patterns = [/(?:^|\n)\s*run\s*\(/, /(?:^|\n)\s*tx\s*\(/, /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i];
  let min = -1;
  for (const p of patterns) {
    const m = body.match(p);
    if (m && m.index !== undefined && m.index + m[0].length > 0) {
      const at = m.index + (m[0].startsWith("\n") ? 1 : 0);
      if (min < 0 || at < min) min = at;
    }
  }
  return min;
}

function auditModule(mod, table) {
  console.log(`\n=== ${mod.file} ===`);
  const src = read(mod.file);
  const whitelist = READ_ONLY[mod.file] ?? [];

  /* 2.1 import 必须带 requirePermission */
  const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/session"\s*;/);
  const imported = importMatch ? importMatch[1].split(",").map((x) => x.trim()) : [];
  check(
    imported.includes("requirePermission"),
    `import 里包含 requirePermission（当前：${imported.join(", ") || "无"}）`
  );

  /* 2.2 找出所有导出函数 */
  const exported = [];
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) exported.push(m[1]);

  /* 2.3 期望表 ↔ 源码双向一致 */
  const expected = Object.keys(mod.actions);
  for (const name of exported) {
    if (expected.includes(name)) continue;
    if (whitelist.includes(name)) continue;
    check(false, `${name} 未在期望/只读白名单中登记（新增 action 请补登记）`);
  }
  for (const name of expected) {
    if (!exported.includes(name)) check(false, `${name} 在源码里不存在（期望表过期）`);
  }

  /* 2.4 逐个函数校验 */
  for (const name of exported) {
    if (whitelist.includes(name)) {
      console.log(`  ⚪ ${name} 只读操作（白名单，允许 requireUser）`);
      pass += 1;
      continue;
    }
    const spec = mod.actions[name];
    if (!spec) continue; // 上面已经报过「未登记」

    const body = sliceFunction(src, name);
    if (!body) {
      check(false, `${name} 函数体解析失败`);
      continue;
    }
    // 只扫描函数体开头（注释 + 权限校验通常在前几行）
    const head = body.slice(0, 900);
    const permMatch = head.match(/requirePermission\(\s*"([^"]+)"\s*\)/);
    const adminMatch = /requireAdmin\(\s*\)/.test(head);

    if (!permMatch && !adminMatch) {
      check(false, `${name} 缺权限校验`, `（函数体开头 900 字符内没有 requirePermission/requireAdmin）`);
      continue;
    }
    const actual = permMatch ? permMatch[1] : "@requireAdmin";
    const label = `${name} 有权限校验（${actual}）`;
    check(true, label);

    // 2.4.1 权限点与期望一致
    check(actual === spec.permission, `${name} 权限点符合期望（期望 ${spec.permission}，实际 ${actual}）`);

    // 2.4.2 权限点在 PERMISSIONS 表里
    if (actual !== "@requireAdmin") {
      const roles = table[actual];
      check(Array.isArray(roles) && roles.length > 0, `${name} 权限点 ${actual} 已在 session.ts PERMISSIONS 中定义`);
      if (Array.isArray(roles)) {
        // 2.4.3 admin 必须通过（hasPermission 里 admin 短路 + 表里也允许）
        check(roles.includes("admin"), `${name} 权限点 ${actual} 允许 admin`);
        // 2.4.4 受限角色必须被拒
        for (const role of spec.rejected) {
          check(
            !roles.includes(role),
            `${name} 拒绝 ${role}（权限点 ${actual} 允许：${roles.join(" / ")}）`
          );
        }
      }
    }

    // 2.4.5 权限校验必须发生在任何写库操作之前
    const permIdx = permMatch ? body.indexOf(permMatch[0]) : body.indexOf("requireAdmin");
    const mutIdx = firstMutationIndex(body);
    check(
      permIdx >= 0 && (mutIdx < 0 || permIdx < mutIdx),
      `${name} 权限校验在写库之前`,
      mutIdx >= 0 && permIdx > mutIdx ? "（发现写库早于权限校验）" : ""
    );
  }

  /* 2.5 没有 readOnly 白名单时不应再出现 requireUser（写操作已全部替换） */
  const requireUserLeft = (src.match(/requireUser\s*\(/g) || []).length;
  if (whitelist.length === 0) {
    check(requireUserLeft === 0, `文件内没有残留 requireUser()（写操作已全部改为 requirePermission）`, `（残留 ${requireUserLeft} 处）`);
  } else {
    check(requireUserLeft > 0, `只读白名单存在，允许保留 requireUser()`);
  }
}

/* ============================================================ 3. HTTP 运行时校验 */

/** 构造 multipart/form-data 请求体（MPA 表单提交 Server Action 的形态） */
function multipartBody(actionId, fields) {
  const boundary = `----pmsPermCheck${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const push = (name, value) => {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  };
  // Next 的 MPA 表单提交用 $ACTION_ID_<id> 隐藏域标识要执行的 action
  push(`$ACTION_ID_${actionId}`, "");
  for (const [k, v] of Object.entries(fields)) push(k, String(v));
  const body = Buffer.from(`${chunks.join("")}--${boundary}--\r\n`, "utf8");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual",
  });
  const html = await res.text();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { ok: html.includes("登录成功") && cookie.length > 0, cookie };
}

async function invokeAction(pagePath, actionId, fields, cookie) {
  const { body, contentType } = multipartBody(actionId, fields);
  const res = await fetch(`${BASE}${pagePath}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": contentType,
      "content-length": String(body.length),
      accept: "text/x-component",
    },
    body,
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location") || "", text };
}

/** 被服务端拒绝的判据：500，或响应里出现 FORBIDDEN（dev 构建会带错误文案） */
function isDenied(result) {
  return result.status >= 500 || /FORBIDDEN|无权执行|缺少权限/.test(result.text);
}

function loadActionIds() {
  const manifestPath = path.join(ROOT, ".next", "server", "server-reference-manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const map = {};
  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    if (!entry || !entry.filename || !entry.exportedName) continue;
    map[`${entry.filename}#${entry.exportedName}`] = id;
  }
  return map;
}

async function runtimeAudit() {
  console.log("\n=== HTTP 运行时校验（front / cashier / housekeeper 直接构造请求） ===");

  if (NO_HTTP) {
    skipRuntime("已用 --no-http / PMS_NO_HTTP=1 关闭，跳过");
    return;
  }

  // 3.1 服务探活（3 秒超时；用 Promise.race 而不是 AbortSignal，避免脚本依赖未声明的全局）
  let alive = false;
  try {
    const probe = fetch(`${BASE}/login`);
    const timeout = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("探活超时")), 3000)
    );
    const res = await Promise.race([probe, timeout]);
    alive = res.status === 200;
  } catch {
    /* 服务没起 / 超时 → alive 保持 false */
  }
  if (!alive) {
    skipRuntime(`服务未启动（${BASE}）→ 跳过运行时校验；静态校验已覆盖全部 action（服务起来后可重跑本脚本）`);
    return;
  }

  // 3.2 构建是否比源码新：旧构建跑不出新代码，运行时结果无意义
  const buildIdPath = path.join(ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    skipRuntime("找不到 .next/BUILD_ID（非 next start 生产构建）→ 跳过运行时校验");
    return;
  }
  const buildTime = fs.statSync(buildIdPath).mtimeMs;
  const srcTime = Math.max(...MODULES.map((m) => fs.statSync(path.join(ROOT, m.file)).mtimeMs));
  if (buildTime < srcTime) {
    skipRuntime(
      `3100 上运行的是 ${fmtTime(buildTime)} 的预构建产物，早于本次源码修改（${fmtTime(srcTime)}）；` +
        "需要重新 next build / 启动后本段才会真正执行（本轮整改禁止 next build，故以静态校验为准）"
    );
    return;
  }

  // 3.3 账号准备（密码见 scripts/init-db.mjs 种子数据）
  const accounts = {
    frontdesk: ["front", "123456"],
    cashier: ["cashier", "123456"],
    housekeeping: ["housekeeper", "123456"],
  };
  const cookies = {};
  for (const [role, [user, pwd]] of Object.entries(accounts)) {
    const r = await login(user, pwd);
    check(r.ok, `登录 ${user}（${role}）成功`);
    cookies[role] = r.cookie;
  }

  // 3.4 action id 映射
  const ids = loadActionIds();
  if (!ids) {
    skipRuntime("找不到 .next/server/server-reference-manifest.json → 跳过运行时 action 调用");
    return;
  }

  // 3.5 逐个 action：受限角色必须被拒
  for (const mod of MODULES) {
    for (const [name, spec] of Object.entries(mod.actions)) {
      const actionId = ids[`${mod.file}#${name}`];
      if (!actionId) {
        check(false, `${name} 在构建产物里找不到 action id`, "（构建可能是旧的或该 action 未导出）");
        continue;
      }
      for (const role of spec.rejected) {
        const result = await invokeAction(mod.page, actionId, spec.params, cookies[role]);
        check(
          isDenied(result),
          `${name} 拒绝 ${role} 的越权请求`,
          `（HTTP ${result.status}${result.location ? ` → ${result.location}` : ""}）`
        );
      }
      if (spec.skipAllowedRuntime) {
        console.log(`  ⚪ ${name} 有权限角色会被真跑（会写库），运行时只验证拒绝面，允许面由静态校验保证`);
        continue;
      }
      // 有权限的角色（前台）不应被拒：证明上面的 500 是权限拦截而不是参数错误
      const allowed = await invokeAction(mod.page, actionId, spec.params, cookies.frontdesk);
      check(!isDenied(allowed), `${name} 前台请求未被权限拦截（对照：HTTP ${allowed.status}）`);
    }
  }
}

/* ============================================================ 主流程 */

async function main() {
  console.log("========== P0-3 动作层权限验收 ==========");
  console.log(`项目：${ROOT}`);

  const { src: sessionSrc, table } = parsePermissionTable();
  const permCount = Object.keys(table).length;
  console.log(`\n=== src/lib/session.ts PERMISSIONS ===`);
  check(permCount >= 26, `权限点表解析正常（${permCount} 个）`);
  check(
    /if\s*\(\s*role\s*===\s*"admin"\s*\)\s*return true;/.test(sessionSrc),
    "hasPermission 里 admin 默认全通过（不会误伤管理员）"
  );

  for (const mod of MODULES) auditModule(mod, table);

  await runtimeAudit();

  /* ---------- 汇总 ---------- */
  console.log("\n========== 汇总 ==========");
  const actionTotal = MODULES.reduce((n, m) => n + Object.keys(m.actions).length, 0);
  console.log(`受检 action：${actionTotal} 个（夜审 1 / 预订 15 / 在住 8）`);
  console.log(`通过：${pass}    失败：${fail}`);
  /*
   * 跳过不是静默的：HTTP 段没跑时必须在最后一行说出来，避免「只看退出码 = 以为端到端过了」。
   * 需要强制跑时用 --require-http / PMS_REQUIRE_HTTP=1（跳过会被 skipRuntime 判红）。
   */
  if (runtimeSkipReason) {
    console.log(`⚠️  HTTP 运行时段未执行：${runtimeSkipReason}`);
    console.log("    本次结果只覆盖静态源码段；端到端未验证（加 --require-http 可强制要求执行）");
  }
  if (fail > 0) {
    console.log("\n❌ 未通过项：");
    for (const f of failures) console.log(`   - ${f}`);
    console.log("\n结果：不通过 ❌");
    process.exit(1);
  }
  console.log("\n结果：全部通过 ✅（0 个 ❌）");
}

main().catch((e) => {
  console.error("脚本执行失败：", e);
  process.exit(1);
});
