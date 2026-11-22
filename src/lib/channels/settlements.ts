/**
 * 渠道佣金对账（整改清单 P2-12）
 *
 * ── 原来错在哪 ──
 * 1. 库里没有任何「渠道账单 / 结算」表，佣金只是报表上的一个估算列：
 *    `channels.commission` 甚至没有写入路径（saveChannelAction 的 UPDATE 列清单里没有它），
 *    所以「佣金比例」永远是种子数据里的那一个数；
 * 2. 渠道页显示 `Number(commission).toFixed(1) + "%"` —— 库里存的是 0~1 的小数（0.15），
 *    页面显示成「0.1%」，比真实值小 100 倍；设置页用的是 `n > 1 ? n : n * 100` 的正确口径，
 *    两个页面同一字段两种显示。
 *
 * ── 现在怎么对 ──
 * 新增 `channel_settlements` 表（每单一行流水），来源用 `source` 区分：
 *   derived —— 本系统按「渠道订单金额 × 渠道佣金率」推算出来的对账快照（可重复重建，幂等）；
 *   channel —— 渠道后台导出的结算单（真实数据，将来由导入功能写入，本函数不碰）。
 *
 * 「对账」的实际含义：
 *   拿渠道结算单（source=channel）与本系统推算值（source=derived）逐单比金额）；
 *   页面同时展示两侧合计与差额，差额不为 0 的渠道就是要去渠道后台核对的。
 *
 * 注意：`derived` 行是**估算**，不是收入凭证。夜审收入 / 财务报表仍然只认 folios，
 * 这里只解决「渠道佣金到底收了多少、有没有对上」这个问题。
 */

import { all, get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { normalizeCommission } from "@/lib/channels/common";

/** 结算来源 */
export type SettlementSource = "derived" | "channel";

/** 结算流水一行 */
export type ChannelSettlementRow = {
  id: number;
  hotel_id: number;
  channel_type: string;
  biz_date: string;
  order_no: string | null;
  gross_amount: number;
  commission_amount: number;
  net_amount: number;
  source: string;
  raw: string | null;
};

/** 按渠道汇总的一行（页面对账表用） */
export type SettlementChannelSummary = {
  channelType: string;
  channelName: string;
  /** 本系统推算（derived） */
  derivedCount: number;
  derivedGross: number;
  derivedCommission: number;
  /** 渠道结算单（channel，可能为 0 行） */
  channelCount: number;
  channelGross: number;
  channelCommission: number;
  /** 差额 = 渠道结算佣金 − 系统推算佣金（正数 = 渠道多收，负数 = 少收） */
  commissionDiff: number;
};

/** 金额保两位（对账口径不接受 0.0000001 的浮点尾巴） */
function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 佣金率归一成 0~1：库里可能是 0.15 也可能是 15 */
function commissionRatio(value: number | null | undefined): number {
  const normalized = normalizeCommission(value ?? 0);
  return normalized === null ? 0 : normalized;
}

/* ============================================================ 查询 */

/** 列出结算流水（页面表格用） */
export function listChannelSettlements(
  hotelId: number,
  opts: { from?: string; to?: string; channelType?: string; source?: SettlementSource; limit?: number } = {}
): ChannelSettlementRow[] {
  const from = opts.from ?? "";
  const to = opts.to ?? "";
  const params: unknown[] = [hotelId];
  let sql = `SELECT * FROM channel_settlements WHERE hotel_id = ?`;
  if (from !== "") {
    sql += ` AND biz_date >= ?`;
    params.push(from);
  }
  if (to !== "") {
    sql += ` AND biz_date <= ?`;
    params.push(to);
  }
  if (opts.channelType) {
    sql += ` AND channel_type = ?`;
    params.push(opts.channelType);
  }
  if (opts.source) {
    sql += ` AND source = ?`;
    params.push(opts.source);
  }
  sql += ` ORDER BY biz_date DESC, id DESC LIMIT ?`;
  params.push(Math.min(500, Math.max(1, Math.trunc(Number(opts.limit ?? 200)))));
  try {
    return all<ChannelSettlementRow>(sql, params);
  } catch {
    // 表还没迁移：页面显示 0 行，不整页崩
    return [];
  }
}

/**
 * 按渠道汇总对账结果（左侧渠道菜单旁的「对账」Tab 用）。
 *
 * 每一行同时给出「系统推算」与「渠道结算单」两侧金额；
 * commissionDiff 不为 0 就是要人工跟渠道核的。
 */
export function summarizeSettlements(
  hotelId: number,
  opts: { from?: string; to?: string } = {}
): SettlementChannelSummary[] {
  const rows = listChannelSettlements(hotelId, { from: opts.from, to: opts.to, limit: 500 });
  const channelNames = new Map<string, string>();
  try {
    for (const ch of all<{ channel_type: string | null; name: string | null }>(
      `SELECT channel_type, name FROM channels WHERE hotel_id = ?`,
      [hotelId]
    )) {
      channelNames.set(String(ch.channel_type ?? ""), ch.name ?? String(ch.channel_type ?? ""));
    }
  } catch {
    // channels 表异常时退化成用类型当名字
  }

  const map = new Map<string, SettlementChannelSummary>();
  for (const row of rows) {
    const key = String(row.channel_type ?? "");
    const item =
      map.get(key) ??
      ({
        channelType: key,
        channelName: channelNames.get(key) ?? key,
        derivedCount: 0,
        derivedGross: 0,
        derivedCommission: 0,
        channelCount: 0,
        channelGross: 0,
        channelCommission: 0,
        commissionDiff: 0,
      } satisfies SettlementChannelSummary);

    const gross = Number(row.gross_amount ?? 0);
    const commission = Number(row.commission_amount ?? 0);
    if (row.source === "channel") {
      item.channelCount += 1;
      item.channelGross = round2(item.channelGross + gross);
      item.channelCommission = round2(item.channelCommission + commission);
    } else {
      item.derivedCount += 1;
      item.derivedGross = round2(item.derivedGross + gross);
      item.derivedCommission = round2(item.derivedCommission + commission);
    }
    item.commissionDiff = round2(item.channelCommission - item.derivedCommission);
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.derivedGross - a.derivedGross);
}

/* ============================================================ 重建推算快照 */

/**
 * 按渠道订单重建一段时间的「系统推算」结算流水（幂等）。
 *
 * 做法：先删掉该区间 source='derived' 的旧行，再按当前渠道订单重新生成。
 * 为什么不做增量 upsert：佣金率是配置项，改一次费率就该整段重算；
 * 而 source='channel' 的真实结算单**绝不删除**（那是渠道给的对账依据）。
 *
 * 数据范围：本店、该区间内 check_in_date 落在 [from, to] 的、非取消的渠道订单。
 *
 * @returns removed 删除的旧推算行数；inserted 新写入行数；skipped 没有金额 / 无渠道配置而跳过的单
 */
export function rebuildDerivedSettlements(
  hotelId: number,
  opts: { from: string; to: string }
): { removed: number; inserted: number; skipped: number } {
  const { from, to } = opts;
  const channels = new Map<string, number>();
  try {
    for (const ch of all<{ channel_type: string | null; commission: number | null }>(
      `SELECT channel_type, commission FROM channels WHERE hotel_id = ?`,
      [hotelId]
    )) {
      channels.set(String(ch.channel_type ?? ""), commissionRatio(ch.commission));
    }
  } catch {
    // channels 表不可读：全部按 0 佣金处理
  }

  let orders: {
    channel_type: string;
    channel_order_no: string;
    check_in_date: string | null;
    amount: number | null;
    status: string | null;
  }[] = [];
  try {
    orders = all(
      `SELECT channel_type, channel_order_no, check_in_date, amount, status
         FROM channel_orders
        WHERE hotel_id = ?
          AND check_in_date IS NOT NULL AND check_in_date >= ? AND check_in_date <= ?
          AND COALESCE(status, '') NOT IN ('CANCELLED')`,
      [hotelId, from, to]
    );
  } catch {
    return { removed: 0, inserted: 0, skipped: 0 };
  }

  let removed = 0;
  try {
    const row = get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM channel_settlements WHERE hotel_id = ? AND source = 'derived' AND biz_date >= ? AND biz_date <= ?`,
      [hotelId, from, to]
    );
    removed = Number(row?.c ?? 0);
    run(
      `DELETE FROM channel_settlements WHERE hotel_id = ? AND source = 'derived' AND biz_date >= ? AND biz_date <= ?`,
      [hotelId, from, to]
    );
  } catch {
    return { removed: 0, inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  const createdAt = nowIso();
  for (const order of orders) {
    const gross = round2(Number(order.amount ?? 0));
    if (gross <= 0 || !order.check_in_date) {
      skipped += 1;
      continue;
    }
    const ratio = channels.get(String(order.channel_type ?? "")) ?? 0;
    const commission = round2(gross * ratio);
    try {
      run(
        `INSERT OR REPLACE INTO channel_settlements
           (hotel_id, channel_type, biz_date, order_no, gross_amount, commission_amount, net_amount, source, raw, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          String(order.channel_type ?? ""),
          order.check_in_date,
          order.channel_order_no,
          gross,
          commission,
          round2(gross - commission),
          "derived",
          JSON.stringify({
            channel_order_no: order.channel_order_no,
            status: order.status,
            commission_rate: ratio,
            generated_at: createdAt,
          }),
          createdAt,
        ]
      );
      inserted += 1;
    } catch {
      skipped += 1;
    }
  }

  return { removed, inserted, skipped };
}
