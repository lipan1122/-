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
 *   62 张表 / 3406 行（46 间房、588 条预订、200 张账单、45 个客人…）
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
import { requireAdmin } from "@/lib/session";

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
   * 切分语句
   *
   * 导出的 SQL 是「每行一条语句」的格式（DELETE ...; / INSERT ... VALUES ...;），
   * 且字符串里的分号已经转义成 ''，所以按「分号+换行」切分是安全的。
   * 注释行（-- 开头）单独丢弃。
   */
  const statements = sqlText
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"))
    .map((s) => s + ";");

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

  return {
    ok:
      `演示数据已导入（操作人 ${user.realName ?? user.username}）：\n` +
      `  ${after.rooms} 间房 / ${after.bookings} 条预订 / ${after.stays} 张入住单 / ${after.guests} 个客人\n` +
      `  导入前：${before.rooms} 间房 / ${before.bookings} 条预订（已被覆盖）\n` +
      `  执行 ${executed} 条语句，4 个演示账号密码已重置为 admin123 / 123456`,
  };
}
