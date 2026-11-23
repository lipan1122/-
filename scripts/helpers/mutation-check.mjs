#!/usr/bin/env node
/**
 * 「这些测试到底能不能抓到业务代码回归？」—— mutation 自检
 *
 * ── 为什么需要它 ──
 * 把 3 个「自己写 SQL 模拟业务」的验收脚本改成真调 action 之后，还要回答一个问题：
 * 现在故意改坏 src 里的一行，这些测试会变红吗？如果改坏了还是绿的，那等于白改。
 *
 * 本脚本对每一类回归做一次 mutation：
 *   1. 把 src/ 整份拷到 .tmp/mutation-src-<时间戳>/（不动真实源码 —— src/ 随时有别的 agent 在改）；
 *   2. 在副本里把某个 action 的关键一行改坏；
 *   3. 用 PMS_SRC_ROOT 指到副本，跑对应的测试；
 *   4. 断言：进程退出码 ≠ 0，且**预期的断言名**出现在 ❌ 行里（不是崩溃就算数）；
 *   5. 还原副本里的文件，跑下一个案例。
 *
 * 另外先跑一遍「副本未改坏」的基线，证明变红是 mutation 造成的，不是副本本身坏了。
 *
 * 用法：node scripts/helpers/mutation-check.mjs
 * 退出码：0 = 每个 mutation 都被抓到；1 = 有 mutation 漏网（测试不够严）
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STAMP = `${Date.now()}`;
const MUT_DIR = path.join(ROOT, ".tmp", `mutation-src-${STAMP}`);
const REAL_SRC = path.join(ROOT, "src");
const TMP_DIR = process.env.PMS_TEST_TMP_DIR ?? path.join(ROOT, ".tmp");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

/* ------------------------------------------------------------------ *
 * 案例清单
 *
 * file / find / replace 是在 src 副本里做的单点改动；
 * test 是要跑的验收脚本；expectRed 是「必须变红」的断言名关键片段。
 * ------------------------------------------------------------------ */
const CASES = [
  {
    id: "checkout-not-vd",
    title: "checkoutAction 退房后不再转 VD（改成 VC）",
    file: "app/(main)/cashier/actions.ts",
    find: 'to: "VD",',
    replace: 'to: "VC",',
    test: "scripts/test-checkout-vd.mjs",
    expectRed: [/退房后房态变成 VD/, /room_logs 记录 OC→VD/],
  },
  {
    id: "checkout-deposit-residual",
    title: "checkoutAction 不再冲销押金（模拟旧 bug：balance=0 时残留）",
    file: "app/(main)/cashier/actions.ts",
    find: "UPDATE stays SET deposit = 0",
    replace: "UPDATE stays SET deposit = deposit",
    test: "scripts/test-checkout-vd.mjs",
    expectRed: [/stays\.deposit 归零/, /押金冲销：账单上的 DEPOSIT 明细全部清零/],
  },
  {
    id: "checkout-hk-status",
    title: "checkoutAction 生成的保洁任务状态写错（PENDING → DOING）",
    file: "app/(main)/cashier/actions.ts",
    find: '"PENDING", pickHousekeepingAssignee',
    replace: '"DOING", pickHousekeepingAssignee',
    test: "scripts/test-checkout-vd.mjs",
    expectRed: [/自动生成 PENDING「打扫」任务/],
  },
  {
    id: "checkin-deposit-no-split",
    title: "checkInAction 押金不再按间分摊（每间都收整单押金）",
    file: "app/(main)/frontdesk/actions.ts",
    find: "const depositBase = roomCount > 0 ? round2(deposit / roomCount) : 0;",
    replace: "const depositBase = round2(deposit);",
    test: "scripts/test-per-room-checkin.mjs",
    expectRed: [/押金按间分摊/, /押金合计 = 整单 300/],
  },
  {
    id: "checkin-no-dup-id",
    title: "checkInAction 不再拦截重复身份证",
    file: "app/(main)/frontdesk/actions.ts",
    find: "if (dup) {",
    replace: "if (false && dup) {",
    test: "scripts/test-per-room-checkin.mjs",
    expectRed: [/同一身份证再办一间 → action 返回错误/, /兜住「已有在住单」|已有在住单/],
  },
  {
    id: "checkin-no-cap",
    title: "checkInAction 不再拦截超房型人数",
    file: "app/(main)/frontdesk/actions.ts",
    find: "if (cap > 0 && guestCount > cap) {",
    replace: "if (false && cap > 0 && guestCount > cap) {",
    test: "scripts/test-per-room-checkin.mjs",
    expectRed: [/3 人住 max_occupancy=2 的房型 → action 返回错误/, /错误文案写明房型上限/],
  },
  {
    id: "checkin-no-detail-backfill",
    title: "checkInAction 不再回填 booking_rooms 明细",
    file: "app/(main)/frontdesk/actions.ts",
    find: "if (detail) {",
    replace: "if (false && detail) {",
    test: "scripts/test-per-room-checkin.mjs",
    expectRed: [/3 条明细全部回填 stay_id 并置 CHECKED_IN/],
  },
  {
    id: "checkin-room-not-oc",
    title: "checkInAction 入住后房态不转 OC（改成 VC）",
    file: "app/(main)/frontdesk/actions.ts",
    find: 'to: "OC",',
    replace: 'to: "VC",',
    test: "scripts/test-per-room-checkin.mjs",
    expectRed: [/3 间房态全部变成 OC/],
  },
  {
    id: "create-booking-one-detail",
    title: "createBookingAction 双写只写 1 条明细（3 间订单只生成 1 条）",
    file: "app/(main)/bookings/actions.ts",
    find: "const detailCount = Math.max(1, line.roomCount);",
    replace: "const detailCount = 1;",
    test: "scripts/test-multiroom-flow.mjs",
    expectRed: [/建单同时生成 3 条明细/],
  },
  {
    id: "assign-no-clash-check",
    title: "assignRoomAction 不再做「明细区间冲突」校验",
    file: "app/(main)/bookings/actions.ts",
    find: "if (clashDetail > 0) {",
    replace: "if (false && clashDetail > 0) {",
    test: "scripts/test-multiroom-flow.mjs",
    expectRed: [/错误文案指出该房间已被其他订单的明细占用/],
  },
  {
    id: "assign-main-status",
    title: "assignRoomAction 排一间就把主单置 CONFIRMED（模拟旧 bug）",
    file: "app/(main)/bookings/actions.ts",
    find: "status = CASE WHEN ? > 0 THEN 'PENDING' ELSE 'CONFIRMED' END",
    replace: "status = CASE WHEN ? > 0 THEN 'CONFIRMED' ELSE 'CONFIRMED' END",
    test: "scripts/test-multiroom-flow.mjs",
    expectRed: [/还有待排房时主单保持 PENDING/],
  },
];

/* ------------------------------------------------------------------ */

function runTest(rel) {
  return spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    env: { ...process.env, PMS_SRC_ROOT: MUT_DIR, PMS_TEST_TMP_DIR: TMP_DIR },
    encoding: "utf8",
    timeout: 240000,
  });
}

/** 从输出里挑出「变红的断言名」 */
function redLines(out) {
  return String(out)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("❌"))
    .map((line) => line.replace(/^❌\s*/, ""));
}

console.log(`副本源码目录：${MUT_DIR}\n（真实 src/ 全程不动，src 里其他 agent 的改动不受影响）\n`);

/* 复制 src → 副本 */
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.rmSync(MUT_DIR, { recursive: true, force: true });
  fs.cpSync(REAL_SRC, MUT_DIR, { recursive: true });
} catch (e) {
  console.error(`❌ 复制 src 失败：${e?.message ?? e}`);
  process.exit(1);
}

let summary = [];
try {
  /* ---------- 基线：副本未改动时 3 个测试必须全绿 ---------- */
  console.log("=== 基线：未改任何代码，用副本跑 3 个测试（必须全绿） ===");
  for (const t of ["scripts/test-per-room-checkin.mjs", "scripts/test-checkout-vd.mjs", "scripts/test-multiroom-flow.mjs"]) {
    const r = runTest(t);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const passed = /通过 (\d+) \/ 失败 0/.exec(out);
    check(
      `基线下 ${path.basename(t)} 全绿（证明变红是 mutation 造成的）`,
      r.status === 0 && Boolean(passed),
      `status=${r.status} ${redLines(out).slice(0, 2).join(" | ")}`
    );
    summary.push({ id: `baseline:${path.basename(t)}`, ok: r.status === 0 && Boolean(passed) });
  }

  /* ---------- 逐个 mutation ---------- */
  for (const c of CASES) {
    console.log(`\n=== mutation：${c.title} ===`);
    const full = path.join(MUT_DIR, ...c.file.split("/"));
    if (!fs.existsSync(full)) {
      check(`[${c.id}] 能找到源码文件 ${c.file}`, false);
      summary.push({ id: c.id, ok: false });
      continue;
    }
    const original = fs.readFileSync(full, "utf8");
    if (!original.includes(c.find)) {
      /* 源码被别的 agent 改过、或这行已经不存在 —— 这个案例作废，明确报出来（不当成通过） */
      check(`[${c.id}] 源码里仍能找到被改坏的那一行`, false, `找不到：${c.find.slice(0, 60)}`);
      summary.push({ id: c.id, ok: false });
      continue;
    }
    fs.writeFileSync(full, original.replace(c.find, c.replace));
    let r;
    try {
      r = runTest(c.test);
    } finally {
      fs.writeFileSync(full, original); // 立刻还原，避免影响后续案例
    }
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const reds = redLines(out);
    const hit = c.expectRed.filter((re) => reds.some((line) => re.test(line)));
    const crashed = /测试执行中断/.test(out);
    const ok = r.status !== 0 && hit.length > 0 && !crashed;
    check(
      `[${c.id}] 改坏「${c.title}」→ ${path.basename(c.test)} 变红并命中预期断言`,
      ok,
      crashed
        ? "测试是崩溃而不是断言失败"
        : r.status === 0
          ? "测试竟然还是绿的（漏网）"
          : `命中 ${hit.length}/${c.expectRed.length}；红：${reds.slice(0, 3).join(" | ")}`
    );
    if (reds.length > 0) console.log(`    变红的断言（前 3 条）：${reds.slice(0, 3).join("；")}`);
    summary.push({ id: c.id, ok });
  }
} finally {
  try {
    fs.rmSync(MUT_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log(`（mutation 全部在 .tmp 的 src 副本上做，真实 src/ 未被修改）`);
if (fail > 0) {
  console.log("\n漏网 / 作废的案例：");
  for (const s of summary.filter((x) => !x.ok)) console.log(`  - ${s.id}`);
}
process.exit(fail === 0 ? 0 : 1);
