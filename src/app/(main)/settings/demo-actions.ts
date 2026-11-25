"use server";

/**
 * 演示数据一键导入（设置页按钮）
 *
 * ── 为什么用 SQL 而不是替换 .db 文件 ──
 *
 * 运行时进程已经打开了数据库连接，直接替换文件会导致：
 *   · 旧连接指着被删掉的 inode（后续读写全部出错）
 *   · -wal / -shm 与新文件不一致
 *   · 必须重启进程才生效，而用户点完按钮不该被要求去敲命令行
 *
 * 用 SQL 导入则全程走同一个连接，一个事务内完成，页面刷新就能看到数据。
 *
 * ── 数据来源 ──
 *
 * `scripts/demo-data/demo-data.sql.gz`（63KB gzip，解压 483KB）
 * 由 `scripts/export-demo-sql.mjs` 从完整的演示库导出：
 *   63 张表 / 3474 行（46 间房、588 条预订、200 张账单、45 个客人…）
 *
 * 刻意排除了：操作日志、渠道同步日志、1222 条渠道订单、会话表
 * —— 这些对演示没价值，却占了数据量的一半。
 *
 * ── 安全性 ──
 *
 * · 只有 admin 能点（requireAdmin）
 * · 整个导入在一个事务里，任何一条失败全部回滚（不会留半套数据）
 * · 导入前会统计当前库有多少业务数据，有真实数据时提醒会覆盖
 * · 二次确认（页面上用 ConfirmForm）
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { requireAdmin, requirePermissionOrRedirect, requireUser } from "@/lib/session";
import { seedUniformDemo } from "@/lib/seed-uniform";
import { DEMO_SEED_DISABLED_MESSAGE, isDemoSeedEnabled } from "@/lib/demo-mode";

export type DemoLoadResult =
  | { ok: string }
  | { error: string };

const SQL_FILE = join(process.cwd(), "scripts", "demo-data", "demo-data.sql.gz");

/** 当前库里有多少业务数据（用于提示会覆盖什么） */
export async function countBusinessDataAction(): Promise<{

  rooms: number;
  bookings: number;
  stays: number;
  folios: number;
}> {
  await requireAdmin();
  /*
   * 非演示模式：不暴露「库里有多少业务数据」
   *
   * 这不是权限问题（下面还有 requireAdmin），是**场景问题**：
   * 正式环境不该存在「演示数据」这个概念，返回真实计数只会让人以为
   * 这个功能在生产可用（然后真的去点「一键导入」）。
   */
  if (!isDemoSeedEnabled()) return { rooms: 0, bookings: 0, stays: 0, folios: 0 };
  const q = (t: string) => {
    try {
      return Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0);
    } catch {
      return 0;
    }
  };
  return { rooms: q("rooms"), bookings: q("bookings"), stays: q("stays"), folios: q("folios") };
}

/**
 * 导入演示数据
 *
 * 流程：
 *   1. 读 gz → 解压 → 拿到 SQL 文本
 *   2. 按语句切分（导出时每条 INSERT 自带分号）
 *   3. 逐条执行；任一条失败抛错 → 整体回滚
 *   4. 重置演示账号密码为已知口令（避免沿用真实哈希）
 */
export async function loadDemoDataAction(): Promise<DemoLoadResult> {
  const user = await requireAdmin();
  /*
   * 关键：UI 隐藏 ≠ 动作禁止
   *
   * 藏掉「一键导入」按钮只让人看不见，直接 POST 这个 action 照样能往**正式库**
   * 灌一整套虚构业务数据（46 房 / 588 预订 / 200 账单，而且会覆盖现有业务数据）。
   * 所以动作层也必须挡，与登录页同一个 env 判据。
   */
  if (!isDemoSeedEnabled()) return { error: DEMO_SEED_DISABLED_MESSAGE };

  if (!existsSync(SQL_FILE)) {
    return {
      error:
        `找不到演示数据文件：${SQL_FILE}\n` +
        `请在项目根目录执行 node scripts/export-demo-sql.mjs 重新生成，` +
        `或确认部署包里带了 scripts/demo-data/demo-data.sql.gz`,
    };
  }

  let sqlText: string;
  try {
    sqlText = gunzipSync(readFileSync(SQL_FILE)).toString("utf8");
  } catch (e) {
    return { error: `演示数据文件损坏：${e instanceof Error ? e.message : String(e)}` };
  }

  /*
   * 切分语句（这里踩过坑，注释要单独处理）
   *
   * 导出的 SQL 长这样：
   *     -- ar_accounts：5 行          ← 注释
   *     DELETE FROM "ar_accounts";    ← 语句
   *     INSERT INTO "ar_accounts" ...;
   *
   * 如果按「分号+换行」切完后过滤 startsWith("--")，会把
   * 「注释 + DELETE」那一整块丢掉 → DELETE 不执行 → 插入时主键冲突：
   *     UNIQUE constraint failed: ar_accounts.id
   *
   * 所以先逐行去掉注释，再按分号切。
   */
  const statements = sqlText
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith(";") ? s : s + ";"));

  if (statements.length === 0) {
    return { error: "演示数据文件里没有可执行的语句" };
  }

  /* 统计导入前数据量，用于返回提示 */
  const before = {
    rooms: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM rooms`)?.c ?? 0),
    bookings: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM bookings`)?.c ?? 0),
  };

  let executed = 0;
  try {
    /*
     * 用 BEGIN IMMEDIATE 显式开事务：
     * 导入要写几十张表，deferred 事务在中途才升级写锁，遇到并发会等；
     * IMMEDIATE 一开始就拿 RESERVED 锁，行为可预期。
     */
    run("BEGIN IMMEDIATE");
    for (const stmt of statements) {
      run(stmt);
      executed++;
    }

    /*
     * 重置演示账号密码
     *
     * 导出的数据里 users 表是「本机演示环境」的哈希，直接搬过来等于把
     * 本机的口令扩散到每台部署机。这里统一重算成已知的演示口令。
     */
    const { hashPassword } = await import("@/lib/password");
    const DEMO = [
      ["admin", "admin123"],
      ["front", "123456"],
      ["cashier", "123456"],
      ["housekeeper", "123456"],
    ] as const;
    for (const [username, plain] of DEMO) {
      run(`UPDATE users SET password_hash = ?, password = '' WHERE username = ?`, [
        hashPassword(plain),
        username,
      ]);
    }

    run("COMMIT");
  } catch (e) {
    try {
      run("ROLLBACK");
    } catch {
      /* 事务可能已自动回滚 */
    }
    return {
      error:
        `导入失败（已回滚，数据未变动）：${e instanceof Error ? e.message : String(e)}\n` +
        `执行到第 ${executed + 1}/${statements.length} 条语句。`,
    };
  }

  /* 刷新所有可能受影响的页面缓存 */
  for (const p of [
    "/dashboard",
    "/rooms",
    "/bookings",
    "/cashier",
    "/inhouse",
    "/frontdesk",
    "/reports",
    "/night-audit",
    "/finance",
    "/members",
    "/channels",
    "/housekeeping",
  ]) {
    revalidatePath(p);
  }

  const after = {
    rooms: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM rooms`)?.c ?? 0),
    bookings: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM bookings`)?.c ?? 0),
    stays: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM stays`)?.c ?? 0),
    guests: Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM guests`)?.c ?? 0),
  };

  /*
   * 导入完再补「按天均匀」的近期数据
   *
   * 为什么要在导入后**额外**补：
   *   演示 SQL 是某一次从真实库导出的快照，它内部的日期分布很不均匀
   *   （近 30 天里 7 天没有任何账单、5 天没有流水，而 11-14 一天 19 张账单）。
   *   演示时点进「统计报表」某一天经常看到空白，房态页今天也没有在住/预抵。
   *
   * `seedUniformDemo` 会从**今天**往前每天补一批（今天补在住+预抵，历史补已退房），
   * 让任何一天点进去都有数据。它本身幂等（已有 DEMO 单的日期跳过），
   * 所以重复导入不会越补越多。
   *
   * 失败不阻断导入：主体数据已经进库了，补数据是增强，失败只提示不报错。
   */
  let seedNote = "";
  try {
    const seeded = seedUniformDemo(user.hotelId ?? 1, 60, false);
    if (seeded.error) {
      seedNote = `\n  均匀补数据跳过：${seeded.error}`;
    } else {
      seedNote =
        `\n  均匀补数据：新增 ${seeded.stays} 张入住单 / ${seeded.folios} 张账单 / ${seeded.payments} 笔流水` +
        `（覆盖近 61 天，跳过已有 ${seeded.skippedDays} 天）` +
        (seeded.unbalanced ? `\n  ⚠ 自洽校验 ${seeded.unbalanced} 张账单不平，请报障` : "");
    }
  } catch (e) {
    seedNote = `\n  均匀补数据失败（不影响主数据）：${e instanceof Error ? e.message : String(e)}`;
  }

  return {
    ok:
      `演示数据已导入（操作人 ${user.realName ?? user.username}）：\n` +
      `  ${after.rooms} 间房 / ${after.bookings} 条预订 / ${after.stays} 张入住单 / ${after.guests} 个客人\n` +
      `  导入前：${before.rooms} 间房 / ${before.bookings} 条预订（已被覆盖）\n` +
      `  执行 ${executed} 条语句，4 个演示账号密码已重置为 admin123 / 123456` +
      seedNote,
  };
}

/**
 * 只补「均匀数据」，不覆盖主数据
 *
 * 用途：用户之前已经导入过演示数据（或者在自己录真实数据），
 * 只想让近期每一天都有内容可看，不想被覆盖 —— 设置页单独一个按钮。
 */
export async function fillUniformDemoAction(): Promise<{ ok?: string; error?: string }> {
  const user = await requireUser();
  /* 同上：这个动作会写 183 张演示单，正式环境必须挡住 */
  if (!isDemoSeedEnabled()) return { error: DEMO_SEED_DISABLED_MESSAGE };
  /*
   * ⚠️ 这个 await 不能少
   *
   * `requirePermission` 是 async 函数，它靠 `throw new Error("FORBIDDEN: ...")` 拒绝。
   * 漏掉 await → 返回的 Promise 被丢弃、throw 变成无人处理的 rejection，
   * **权限判断完全不生效**。
   *
   * 实测后果（chk-demo）：前台账号 front 调这个 action → HTTP 200，
   * 副本库 stays 0 → 183（写进 183 张入住单 + 183 张账单 + 183 笔流水 + 243 条预订）。
   *
   * 这里用 `requirePermissionOrRedirect` 而不是 `requirePermission`：
   * 后者在生产构建下会被脱敏成 500「操作失败」，
   * 前者会 303 到 /no-permission 并显示「没有该操作权限」。
   */
  await requirePermissionOrRedirect("settings.manage");

  try {
    const res = seedUniformDemo(user.hotelId ?? 1, 60, false);
    if (res.error) return { error: res.error };
    revalidatePath("/dashboard");
    revalidatePath("/rooms");
    revalidatePath("/rooms/forecast");
    revalidatePath("/reports");
    revalidatePath("/cashier");
    return { ok: res.ok ?? "补数据完成" };
  } catch (e) {
    return { error: `补数据失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
