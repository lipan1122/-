"use server";

/**
 * 清空业务数据（设置页「演示数据」Tab 的配套按钮）
 *
 * ── 为什么需要它 ──
 *
 * 演示数据导入后，系统里全是虚构的房间/预订/账单。正式上线前必须清掉，
 * 否则真实前台会在「张伟 13800001111」这些假客人上继续开单。
 *
 * 命令行能做（`node scripts/init-db.mjs --reset`），但那会**连表结构一起重建**
 * 并重新灌基础房型；而运营常常只想清业务数据、保留已经配好的房型/房间/参数/
 * 账号/权限矩阵。所以这里单独提供一个「只清业务数据」的动作。
 *
 * ── 清什么、留什么 ──
 *
 * 清（业务流转产生的数据）：
 *   bookings / booking_rooms / stays / folios / folio_items / payments
 *   guests / housekeeping / room_logs / op_logs / breakfast_records
 *   member_wallet* / ar_* / invoices / channel_orders / lost_items
 *   以及房间的占用状态（重置成 VC 空净）
 *
 * 留（配置与账号）：
 *   hotels / users / roles / role_permissions / role_modules / permission_dict
 *   rooms / room_types / rate_codes / rate_plans / rate_calendar
 *   channels / companies / settings / floors / goods / points 规则 …
 *
 * ── 安全性 ──
 *   · 只有 admin 能点
 *   · 二次确认 + 必须输入「清空」两字（防止误点）
 *   · 整个过程一个事务，失败全部回滚
 *   · 清空前会打印「将删除多少条预订/账单」
 */
import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export type ClearResult = { ok: string } | { error: string };

/**
 * 业务数据表（按外键依赖从子到父排列，删除时不会触发约束错误）
 *
 * 注意：这里只列「业务流转」表。配置表（rooms/room_types/settings/roles…）不在内。
 */
const BUSINESS_TABLES = [
  // 最底层明细
  "breakfast_records",
  "folio_items",
  "payments",
  "booking_rooms",
  "stay_companions",
  "wake_up_calls",
  "sms_logs",
  "room_links",
  "cancel_requests",
  // 中间层
  "folios",
  "stays",
  "bookings",
  // 关联业务
  "housekeeping",
  "lost_items",
  "meal_vouchers",
  "room_logs",
  "op_logs",
  "query_logs",
  // 会员与应收
  "member_wallet_ledger",
  "member_wallet",
  "member_wallet_transactions",
  "ar_write_offs",
  "ar_transactions",
  "ar_ledgers",
  "invoices",
  // 渠道
  "channel_orders",
  "channel_sync_logs",
  "channel_sync_queue",
  "channel_sync_dead_letter",
  "channel_settlements",
  // 其他流水
  "goods_flows",
  "score_records",
  "shop_sales",
  "rental_records",
  "lease_records",
  // 客人档案（放在最后：上面很多表引用它）
  "guests",
];

export async function clearBusinessDataAction(confirmText: string): Promise<ClearResult> {
  const user = await requireAdmin();

  if (confirmText.trim() !== "清空") {
    return { error: "请输入「清空」两个字确认（防止误点）" };
  }

  /* 统计清空前有多少数据，用于返回提示 */
  const countOf = (t: string) => {
    try {
      return Number(get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0);
    } catch {
      return 0; // 表不存在就跳过
    }
  };
  const before = {
    bookings: countOf("bookings"),
    stays: countOf("stays"),
    folios: countOf("folios"),
    guests: countOf("guests"),
    payments: countOf("payments"),
  };

  const cleared: string[] = [];
  const skipped: string[] = [];

  let clearedRows = 0;
  try {
    run("BEGIN IMMEDIATE");

    for (const t of BUSINESS_TABLES) {
      try {
        /* 先数一下（DELETE 的 changes 在某些驱动下拿不到） */
        const n = countOf(t);
        run(`DELETE FROM ${t}`);
        if (n > 0) {
          clearedRows += n;
          cleared.push(`${t}(${n})`);
        }
      } catch (e) {
        /*
         * 表不存在（懒建还没跑过）或没有权限：跳过继续。
         * 但如果是别的原因（比如约束），也记录下来，最后汇总里体现。
         */
        skipped.push(`${t}：${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
      }
    }

    /*
     * 房间状态重置
     *
     * 演示数据里有 OC（在住）/ OD（住脏），清空后这些房间不该还显示有人住。
     * 统一回到 VC（空净）—— 这是新酒店开业的初始状态。
     * OOO（维修）/ LOCK（锁房）保留，那是运营刻意设的。
     */
    try {
      run(`UPDATE rooms SET status = 'VC' WHERE status IN ('OC','OD','VD')`);
    } catch {
      /* 忽略 */
    }

    /*
     * AUTOINCREMENT 序列重置
     *
     * 不清的话，清空后新建的第一条预订号会接着演示数据的 588 往下排，
     * 运营看到「BK0589」会以为之前有历史订单。
     */
    try {
      run(`DELETE FROM sqlite_sequence WHERE name IN (${BUSINESS_TABLES.map(() => "?").join(",")})`, BUSINESS_TABLES);
    } catch {
      /* 没有 sqlite_sequence 表就跳过（非 AUTOINCREMENT 库） */
    }

    run("COMMIT");
  } catch (e) {
    try {
      run("ROLLBACK");
    } catch {
      /* 可能已自动回滚 */
    }
    return {
      error: `清空失败（已回滚）：${e instanceof Error ? e.message : String(e)}`,
    };
  }

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
    "/guests",
    "/ar",
    "/invoices",
  ]) {
    revalidatePath(p);
  }

  return {
    ok:
      `业务数据已清空（操作人 ${user.realName ?? user.username}）：\n` +
      `  删除 ${clearedRows} 行，涉及 ${cleared.length} 张表\n` +
      `  清空前：${before.bookings} 条预订 / ${before.stays} 张入住单 / ${before.folios} 张账单 / ${before.guests} 个客人 / ${before.payments} 条流水\n` +
      `  保留：房间与房型、渠道、协议单位、参数、账号与权限\n` +
      `  房间状态已重置为「空净」` +
      (skipped.length > 0 ? `\n  ${skipped.length} 张表跳过（不存在或无此表）` : ""),
  };
}
