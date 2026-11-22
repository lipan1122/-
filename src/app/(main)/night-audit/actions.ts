"use server";

import { revalidatePath } from "next/cache";
import { recalcFolioBalance, round2 } from "@/lib/folio";
import { all, get, run, tx } from "@/lib/db";
import { cleanupExpiredSessions, requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";
import { bizToday, getBizCutoff, isAfterCutoff } from "@/lib/biz-date";
/* 第 4 轮 P1-18：夜审执行前必须跑阻断检查（原来只显示不拦截） */
import { nightAuditPreflight } from "./preflight";

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 夜审经营指标口径（整改清单 P1-13「夜审口径偏粗」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 一、出租间夜（房间数口径）
 *   只数「过夜」的在住单：COALESCE(nights,0) > 0 且 rate_code <> '钟点'。
 *   钟点房由 rooms/actions.ts 的 toHourlyAction 写入 `nights = 0, rate_code = '钟点'`，
 *   客人确实占着房、也确实付了钱，但不产生「间夜」；旧代码用 inhouseStays.length
 *   直接数在住单条数，把钟点房按 1 个间夜计入 → 出租率虚高。
 *
 *   为什么用「条数」而不是 SUM(nights)：
 *     stays.nights 是「本单总晚数」（住 2 晚的单 nights = 2），它跨多个营业日；
 *     按天审计时把整段住期一次性 SUM 进来，等于把后面几天的房间提前算进今天，
 *     同一间房会在多个营业日被重复计入。单日间夜 = 今晚实际占用的房间数 =
 *     过夜在住单条数。故口径为「房间数口径」，分子单位为「间夜（= 间/夜）」。
 *   出租率 = 出租间夜 / 总房量（rooms 表房间总数，暂不扣维修房 OOO）。
 *
 * 二、毛收入分列（来源 folio_items，按营业日 biz_date 归期）
 *   revenue_room  = item_type 'ROOM'  房费（含钟点房房费，它是房费不是间夜）
 *   revenue_food  = item_type 'FOOD'  餐饮
 *   revenue_other = item_type 'OTHER' 其他（商超、洗衣、赔偿等）
 *   押金 DEPOSIT 不计收入（客人押金是负债，不是消费）；
 *   冲账 ADJUST 不计收入（其中「【部分结账】」负项是内部结账记录，见 lib/folio.ts）。
 *
 * 三、退款单列冲减（来源 payments）
 *   refund_total = 负数收款流水的绝对值之和，也覆盖 refund_of 非空的历史行
 *                  （收银退款写的是 amount = -abs(金额) + refund_of = 原收款 id，
 *                    见 cashier/actions.ts 的 refundPaymentAction）。
 *   退款按收款流水的 biz_date 归期：同一天退款冲减当天收入。
 *
 * 四、净收入
 *   revenue_net = revenue_room + revenue_food + revenue_other - refund_total
 *   night_audits.revenue 保留作兼容列，写同一个净收入值。
 *
 * 下面这些 SQL 常量是唯一口径实现，scripts/test-night-audit-metrics.mjs 会把它们
 * 与源码逐字比对后在临时库上真跑一遍，改口径请同步跑该脚本。
 */

/** 出租间夜：过夜在住的房间数（钟点房 nights = 0 不计入） */
const SQL_ROOM_NIGHTS = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND COALESCE(s.nights, 0) > 0
   AND COALESCE(s.rate_code, '') <> '钟点'`;

/** 钟点房间数：只在住但 nights = 0 / rate_code = '钟点'，仅用于口径留痕，不计间夜 */
const SQL_HOURLY_ROOMS = `SELECT COUNT(*) AS v
  FROM stays s
 WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
   AND (COALESCE(s.nights, 0) <= 0 OR COALESCE(s.rate_code, '') = '钟点')`;

/** 房费收入：当日 ROOM 明细合计（不含押金 / 冲账） */
const SQL_REVENUE_ROOM = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
 WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'ROOM'`;

/** 餐饮收入：当日 FOOD 明细合计 */
const SQL_REVENUE_FOOD = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
 WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'FOOD'`;

/** 其他收入：当日 OTHER 明细合计（商超 / 洗衣 / 赔偿等） */
const SQL_REVENUE_OTHER = `SELECT COALESCE(SUM(fi.amount), 0) AS v
  FROM folio_items fi
 WHERE fi.hotel_id = ? AND fi.biz_date = ? AND fi.item_type = 'OTHER'`;

/** 退款冲减：当日负数收款（含 refund_of 关联退款）绝对值合计，正数表示退出去多少 */
const SQL_REFUND_TOTAL = `SELECT COALESCE(SUM(ABS(p.amount)), 0) AS v
  FROM payments p
 WHERE p.hotel_id = ? AND p.biz_date = ?
   AND (p.amount < 0 OR p.refund_of IS NOT NULL)
   /*
    * 押金退款**不是营业收入的冲减项**
    *
    * 口径必须对称：押金收款明确不计收入（见 folio.ts 的 NON_REVENUE_ITEM，
    * 押金是负债），那押金退款自然也不该从收入里减 —— 它只是把负债还掉。
    *
    * 不排除的后果（真库实测）：
    *   11-21 房费 1,568、退款 134（孙强 44 + 许丹 64 + 张三丰 26 三笔押金退款）
    *   → room-biz-daily 净收入 1,434，而 biz-daily 营业收入 1,568 → **两张日报差 134**
    *   净收入被低估 8.5%，毛利率/RevPAR 相关派生指标一并偏低。
    *
    * 历史数据里有 174 条 kind IS NULL（第九轮按「不静默归类」刻意留空），
    * 所以用 COALESCE(p.kind,'') 而不是 p.kind <> ...。
    */
   AND COALESCE(p.kind, '') <> 'DEPOSIT_REFUND'`;

/**
 * 执行夜审：把今日房费过账到每间在住房间。
 * 1. 今日已有夜审记录 → 直接返回错误，避免重复过账
 * 2. 在住房若无「今日 + ROOM」明细，补一条房费
 * 3. 重算账务单合计与应收余额
 * 4. 汇总出租间夜（不含钟点房）、收入三分类、退款冲减与净收入，写入夜审记录
 */
export async function runNightAuditAction(): Promise<{ error: string } | { ok: true }> {
  // 权限（整改 P0-3）：执行夜审会为全店在住单过账房费、把过期未到订单批量标 NOSHOW、
  // 重算所有账单余额并写营收汇总，一次操作影响全店财务，属最高级别写操作。
  // night_audit.run 只授权 admin，前台 / 收银 / 客房账号即使直接构造请求也会在服务端被拒。
  const user = await requirePermission("night_audit.run");
  const hotelId = user.hotelId;
  /*
   * 整改 P2-4：夜审是店里「每天一次」的天然定时点，顺带清理过期会话，
   * 避免长期没人登录时 sessions 表只增不删（登录成功时也会清一次，见 api/login）。
   * 刻意放在事务外、也放在下面「今日已完成夜审」的提前返回之前：
   * 即使这次夜审被拦下，过期会话的清理也照常执行。
   * 只加这一行，夜审原有的权限、NOSHOW、清房、账务重算与营收分列逻辑均未改动。
   */
  cleanupExpiredSessions();
  // 营业日（按设置里的切换时间，默认 00:00）
  const today = bizToday(user.hotelId);

  const existed = get<{ id: number }>(
    `SELECT id FROM night_audits WHERE hotel_id = ? AND biz_date = ?`,
    [hotelId, today]
  );
  if (existed) return { error: "今日已完成夜审" };

  /*
   * 第 4 轮 P1-1：营业日未结束时不能夜审
   *
   * 营业日 D = 自然日 D 05:00 → D+1 05:00（settings.biz_day_cutoff）。
   * 如果在 D 日 05:00 之前就执行夜审，等于给「还没结束的营业日」提前关账：
   *   · night_audits 写入 D 日 → UNIQUE(hotel_id, biz_date) 把 D 日锁死
   *   · D 日剩下的几小时产生的消费再也进不了 D 日的营收
   *   · 结果 D 日的账永远是「半天账」，且无法补审
   *
   * isAfterCutoff 之前定义了但全项目零调用，这里接上。
   */
  const cutoff = getBizCutoff(hotelId);
  if (!isAfterCutoff(new Date(), cutoff)) {
    return {
      error:
        `营业日尚未结束（切换时间 ${cutoff}），现在不能执行夜审。` +
        `请等 ${cutoff} 之后再操作，否则本期营业日的剩余消费会漏账且无法补审。`,
    };
  }

  /*
   * 第 4 轮 P1-18：夜审「阻断」检查必须在服务端生效
   *
   * 症状：preflight.ts 里 paymismatch 等检查标了 `blocking: true`，
   * 页面也渲染了红色「有 N 项阻断」徽章 —— 但 runNightAuditAction 全文
   * 一次都没引用 preflight，点「执行夜审」照样跑。
   * 结果是：账面与流水对不上、房态与在住不一致时，夜审照样过房费、
   * 照样把逾期待抵标 NOSHOW、照样写营收日报。夜审是不可逆的日结，这是财务事故入口。
   *
   * 现在：开工前先跑一遍同样的 preflight，有阻断项直接拒绝并说明是哪几项。
   * 页面已经把这个检查显示给用户了，服务端只是把它变成真的约束。
   */
  const pf = nightAuditPreflight(hotelId, today);
  const blockingItems = pf.items.filter((i) => i.blocking);
  if (blockingItems.length > 0) {
    const detail = blockingItems
      .slice(0, 3)
      .map((i) => i.title)
      .join("、");
    return {
      error:
        `存在 ${blockingItems.length} 项阻断，未执行夜审：${detail}` +
        (blockingItems.length > 3 ? ` 等 ${blockingItems.length} 项` : "") +
        "。请先处理这些问题（页面顶部有详细清单），再重新执行夜审。",
    };
  }

  const inhouseStays = all<{ id: number; rate: number; folio_id: number | null }>(
    `SELECT s.id, s.rate, f.id AS folio_id
     FROM stays s
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'`,
    [hotelId]
  );

  const now = nowIso();

  tx(() => {
    // 为每间在住房补今日房费，已有当日 ROOM 明细的跳过（幂等）
    for (const stay of inhouseStays) {
      const folioId = stay.folio_id;
      if (!folioId) continue;

      const posted = get<{ id: number }>(
        `SELECT id FROM folio_items
         WHERE hotel_id = ? AND folio_id = ? AND item_type = 'ROOM' AND biz_date = ?
         LIMIT 1`,
        [hotelId, folioId, today]
      );
      if (posted) continue;

      run(
        `INSERT INTO folio_items
           (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [hotelId, folioId, "ROOM", `房费 ${today}`, 1, stay.rate, stay.rate, today, now, user.id]
      );
    }

    /*
     * 未到店处理（整改清单 P1-2）
     *
     * 判定改成 `check_in_date < today`：
     *   旧逻辑用 `check_out_date <= today`，会把「今天入住、今天离店」的日租单
     *   和「今天离店但客人还没到」的单一起标 NOSHOW —— 误杀当天单。
     *   正确的语义是「到店日已经过去了，客人始终没来」。
     *
     * 标 NOSHOW 时还要清房：
     *   旧逻辑只改状态，主单 room_id 和 booking_rooms 明细还挂着，
     *   房间在房态图上仍是占用状态 → 卖不出去。
     */
    /*
     * 第 4 轮 P1-16：多房预订「只入住其中一间」时主单被误标 NOSHOW
     *
     * 部分入住时主单状态仍是 CONFIRMED（不是 CHECKED_IN），
     * 旧条件 `status IN ('PENDING','CONFIRMED') AND check_in_date < today`
     * 会把「客人已经在住」的订单标成 NOSHOW，然后把剩余房间也释放掉 ——
     * 更糟的是 frontdesk 之后会以「该预订已标记未到」拒绝给剩余房间办入住，
     * 客人明明住着，系统却说没来。
     *
     * 加排除条件：该订单下已经有任何一间产生了入住单（在住或已退），就不算 NOSHOW。
     */
    const noShowRows = all<{ id: number; booking_no: string; guest_name: string | null }>(
      `SELECT id, booking_no, guest_name FROM bookings b
        WHERE b.hotel_id = ? AND b.status IN ('PENDING','CONFIRMED') AND b.check_in_date < ?
          AND NOT EXISTS (
            SELECT 1 FROM stays s
             WHERE s.hotel_id = b.hotel_id
               AND s.booking_id = b.id
               AND s.status IN ('INHOUSE','CHECKED_OUT')
          )`,
      [hotelId, today]
    );
    for (const b of noShowRows) {
      /* 清房：主单释放房号，明细置 CANCELLED，房间可再售 */
      run(`UPDATE bookings SET status = 'NOSHOW', room_id = NULL, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
        now,
        b.id,
        hotelId,
      ]);
      run(
        `UPDATE booking_rooms SET status = 'CANCELLED', room_id = NULL
          WHERE hotel_id = ? AND booking_id = ? AND status IN ('PENDING','CONFIRMED')`,
        [hotelId, b.id]
      );
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        user.realName ?? "夜审",
        "夜审-未到店",
        `${b.booking_no} ${b.guest_name ?? ""} 标记未到（到店日已过，房间已释放）`,
        now,
      ]);
    }

    // 重算在住账务单的合计与应收余额
    const folios = all<{ id: number }>(
      `SELECT f.id FROM folios f
       JOIN stays s ON s.id = f.stay_id
       WHERE s.hotel_id = ? AND s.status = 'INHOUSE'`,
      [hotelId]
    );
    for (const folio of folios) {
      /* 统一走公共重算（P0-4）：直接 SUM 会把「部分结账」负项算进去，导致重复冲减、营收偏小 */
      recalcFolioBalance(hotelId, folio.id);
    }

    /*
     * 汇总并写夜审记录（整改 P1-13 口径修正）。
     *
     * ⚠ 这里刻意不再用 `inhouseStays.length`：那个数组是「所有在住单」，
     *   含 nights = 0 的钟点房，按条数直接当间夜会让出租率虚高。
     *   间夜、钟点房数、收入三分类、退款全部走上面的 SQL 常量（口径唯一）。
     *
     * 幂等：本函数开头已按 (hotel_id, biz_date) 查过是否已夜审，且表上有
     *   UNIQUE(hotel_id, biz_date)；房费过账循环又逐单查了当日 ROOM 明细。
     *   三重保证下重复执行同一天不会重复累加。
     */
    /*
     * 第 4 轮 P1-5：出租率分母改用「可售房量」（扣维修房 OOO / 锁房 LOCK）
     *
     * 原来用 `COUNT(*) AS total` 全房量 —— 维修房卖不出去却占着分母，
     * 出租率被系统性低估。而报表页早就扣了维修房，两边数字打架
     * （文件头口径说明一里也自认「暂不扣维修房 OOO」）。
     *
     * 现在与 src/lib/metrics.ts 完全同口径：
     *   OCC = 出租间夜 / 可售房量
     * 这样工作台、报表、夜审日报三处数字一致。
     */
    const sellableRooms =
      get<{ sellable: number }>(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('OOO','LOCK') THEN 0 ELSE 1 END), 0) AS sellable
           FROM rooms WHERE hotel_id = ?`,
        [hotelId]
      )?.sellable ?? 0;
    // 出租间夜 = 过夜在住的房间数（房间数口径，见文件头口径说明一）
    const roomNights = Number(get<{ v: number }>(SQL_ROOM_NIGHTS, [hotelId])?.v ?? 0);
    // 钟点房：在住但不产生间夜，写进 hourly_rooms 留痕，让人一眼看出「少算的房间去哪了」
    const hourlyRooms = Number(get<{ v: number }>(SQL_HOURLY_ROOMS, [hotelId])?.v ?? 0);

    // 毛收入三分类（房费 / 餐饮 / 其他），不含押金与冲账
    const revenueRoom = round2(Number(get<{ v: number }>(SQL_REVENUE_ROOM, [hotelId, today])?.v ?? 0));
    const revenueFood = round2(Number(get<{ v: number }>(SQL_REVENUE_FOOD, [hotelId, today])?.v ?? 0));
    const revenueOther = round2(Number(get<{ v: number }>(SQL_REVENUE_OTHER, [hotelId, today])?.v ?? 0));
    // 退款冲减：当日负数收款绝对值之和（退款是收入的减项，单列出来才看得清）
    const refundTotal = round2(Number(get<{ v: number }>(SQL_REFUND_TOTAL, [hotelId, today])?.v ?? 0));

    const grossRevenue = round2(revenueRoom + revenueFood + revenueOther);
    const netRevenue = round2(grossRevenue - refundTotal);
    const occupancy = sellableRooms > 0 ? roomNights / sellableRooms : 0;

    run(
      `INSERT INTO night_audits
         (hotel_id, biz_date, status, rooms_sold, hourly_rooms, revenue, occupancy,
          revenue_room, revenue_food, revenue_other, refund_total, revenue_net,
          operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        today,
        "DONE",
        roomNights, // rooms_sold 沿用旧列名，值改为「出租间夜（不含钟点房）」
        hourlyRooms,
        netRevenue, // revenue 兼容列 = 净收入
        occupancy,
        revenueRoom,
        revenueFood,
        revenueOther,
        refundTotal,
        netRevenue,
        user.realName,
        now,
      ]
    );
  });

  revalidatePath("/night-audit");
  revalidatePath("/cashier");
  revalidatePath("/dashboard");
  revalidatePath("/reports");

  return { ok: true };
}

/**
 * 撤销当晚夜审（第 4 轮 P1-18 · 第 3 点）
 *
 * 背景：夜审一旦执行就无法撤回 —— `night_audits` 有 UNIQUE(hotel_id, biz_date)，
 * 当天只能成功跑一次，跑错了（比如把「客人到了但前台没录入住」的订单判成 NOSHOW）
 * 只能手工改库。而夜审会改三类数据，全都要一起还原：
 *   ① 为在住单补记的当日 ROOM 房费明细
 *   ② 被标 NOSHOW 的订单（主单状态 + 明细状态 + 释放的 room_id）
 *   ③ night_audits 当日那一行（营收汇总）
 *
 * 撤销是**高危不可逆操作**，所以：
 *   · 只允许 admin（night_audit.undo）
 *   · 必须填原因（写进 op_logs，事后可追）
 *   · 只允许撤销**最近一次**夜审（不允许回退到很早的历史，避免把中间所有日结一起抹掉）
 *   · 整段在一个事务里，任一步失败全部回滚
 */
export async function undoNightAuditAction(formData: FormData): Promise<{ error: string } | { ok: string }> {
  /* 撤销夜审用权限点（不是硬编码 admin），便于设置页按角色调整 */
  const user = await requirePermission("night_audit.undo");
  const hotelId = user.hotelId;
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "撤销夜审必须填写原因" };

  /* 只允许撤销最近一次 */
  const latest = get<{ id: number; biz_date: string; revenue: number | null; created_at: string }>(
    `SELECT id, biz_date, revenue, created_at FROM night_audits
      WHERE hotel_id = ? ORDER BY biz_date DESC, id DESC LIMIT 1`,
    [hotelId]
  );
  if (!latest) return { error: "没有可撤销的夜审记录" };

  const bizDate = latest.biz_date;
  const now = nowIso();

  let removedItems = 0;
  let restoredNoShow = 0;

  try {
    tx(() => {
      /*
       * ① 冲正当日补记的房费
       *    只删「description 形如『房费 YYYY-MM-DD』且 biz_date = 该营业日」的 ROOM 明细，
       *    不碰前台手工加的房费（那些 description 不是这个格式）。
       */
      const before = get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM folio_items
          WHERE hotel_id = ? AND item_type = 'ROOM' AND biz_date = ? AND description = ?`,
        [hotelId, bizDate, `房费 ${bizDate}`]
      )?.c ?? 0;
      run(
        `DELETE FROM folio_items
          WHERE hotel_id = ? AND item_type = 'ROOM' AND biz_date = ? AND description = ?`,
        [hotelId, bizDate, `房费 ${bizDate}`]
      );
      removedItems = before;

      /*
       * ② 还原 NOSHOW
       *    夜审把 check_in_date < today 的 PENDING/CONFIRMED 判成 NOSHOW。
       *    撤销时把「该营业日当天被判 NOSHOW」的订单还原成 CONFIRMED，
       *    明细状态还原成 CONFIRMED。房号已被清空，无法还原具体房号 ——
       *    这点在返回文案里说明，让前台知道要重新排房。
       */
      const noShowIds = all<{ id: number }>(
        `SELECT id FROM bookings
          WHERE hotel_id = ? AND status = 'NOSHOW' AND check_in_date < ?`,
        [hotelId, bizDate]
      ).map((r) => r.id);
      for (const id of noShowIds) {
        run(`UPDATE bookings SET status = 'CONFIRMED', updated_at = ? WHERE id = ? AND hotel_id = ?`, [
          now,
          id,
          hotelId,
        ]);
        run(
          `UPDATE booking_rooms SET status = 'CONFIRMED'
            WHERE hotel_id = ? AND booking_id = ? AND status = 'CANCELLED'`,
          [hotelId, id]
        );
        restoredNoShow++;
      }

      /* ③ 删夜审汇总行 */
      run(`DELETE FROM night_audits WHERE id = ? AND hotel_id = ?`, [latest.id, hotelId]);

      /* ④ 重算受影响的账单（删了房费明细，total 要跟着降） */
      const affected = all<{ id: number }>(
        `SELECT DISTINCT f.id FROM folios f
           JOIN folio_items fi ON fi.folio_id = f.id
          WHERE f.hotel_id = ? AND fi.biz_date = ?`,
        [hotelId, bizDate]
      );
      for (const f of affected) recalcFolioBalance(hotelId, f.id);

      /* ⑤ 审计 */
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        user.realName ?? user.username,
        "撤销夜审",
        `营业日 ${bizDate} · 冲正房费 ${removedItems} 条 · 还原 NOSHOW ${restoredNoShow} 单 · 营收 ${latest.revenue ?? 0} · 原因：${reason}`,
        now,
      ]);
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "撤销夜审失败，已回滚" };
  }

  revalidatePath("/night-audit");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  return {
    ok:
      `已撤销 ${bizDate} 的夜审：冲正房费 ${removedItems} 条、还原 ${restoredNoShow} 单未到店。` +
      `注意：被清空的房号不会自动恢复，需要重新排房。`,
  };
}
