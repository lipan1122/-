/**
 * 小程序：购买早餐（codex 第九轮《微信小程序专项》第三节 API 清单）
 *
 * POST /api/mini/breakfast  { count, date?, requestId? }   （需要 Bearer token）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、与 PC 端 sellBreakfastAction 的关系（同一套落库口径）
 * ══════════════════════════════════════════════════════════════════════════
 * src/app/(main)/breakfast/actions.ts 的 sellBreakfastAction（第六轮改过权限）做三件事：
 *   ① stays.breakfast += N            在住单含早份数
 *   ② breakfast_records 当日记录 +N   待核销流水（早餐核销页看的就是这张表）
 *   ③ op_logs 写「卖早餐」            审计
 * 本接口与它对齐 ①②③，并且**多写一笔账**：folio_items 一条 OTHER 明细 +
 * recalcFolioBalance 重算账单。为什么 PC 端不加这一笔？PC 端「卖早餐」是前台
 * 给在住客加含早权益（可能已含在包价里），是否收钱由前台另外在收银台加收。
 * 小程序是客人自助购买，**必须当场生成应收账款**，否则客人点了「购买」钱没进账单，
 * 前台交接时对不上。金额一律服务端算（见第三节）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、身份与归属：一律从 token 推导，不信任客户端
 * ══════════════════════════════════════════════════════════════════════════
 * · hotelId  ← token 对应 mini_program_users.hotel_id（不读请求体）
 * · guestId  ← token 绑定关系 mini_program_users.guest_id（不读请求体）
 * · stayId   ← 由 guestId 反查本店 INHOUSE 在住单；请求体里的 stayId 只当
 *              「多间在住时选哪一间」的提示，**必须命中该客人自己的在住单**才用，
 *              否则一律忽略（清单第四节：不信任客户端 stayId）。
 * 未绑定手机号的用户直接 NOT_BOUND —— 没有客史就没有账单可以挂。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、金额由服务端算，单价来自 settings.breakfast_price
 * ══════════════════════════════════════════════════════════════════════════
 * 数据库里**没有**早餐单价字段（PC 端「卖早餐」不收钱，价格只体现在包价里），
 * 所以这里不硬编码任何价格（清单第 81 行同一原则：不许写死）：
 *   单价 = settings.breakfast_price（元/份，管理员在设置里配一行即可，也认
 *          mini_breakfast_price 这个别名）
 *   未配置 / 非正数 → 直接返回 NOT_CONFIGURED：「酒店尚未配置早餐价格，请到前台购买」。
 * 客户端传的 price / amount / unitPrice **全部丢弃**，总价 = 单价 × 份数（服务端算）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 四、幂等（request_id）
 * ══════════════════════════════════════════════════════════════════════════
 * folio_items 有部分唯一索引 (hotel_id, request_id)（迁移第 13 段）。
 * 客户端带 requestId 时：先查是否已入账 → 命中就直接回「重复提交已忽略」；
 * 并发下被抢先写入 → 捕获 UNIQUE 冲突，同样按重放处理（与 rooms/actions.ts
 * 的 addOtherChargeAction 同一手法）。不带 requestId 时服务端生成一个，
 * 保证每次请求都是一笔新账（前端连点由 UI 防抖负责）。
 */

import { randomUUID } from "node:crypto";
import { all, get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { recalcFolioBalance } from "@/lib/folio";
import { requireMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { nowIso } from "@/lib/utils";
import { fail, int, isDateStr, maskGuestName, miniConfigBlocked, ok, readJsonBody, round2, str } from "../_shared";
import { MINI_NOTIFY_TYPE, safeNotify } from "../notifications/_notify";

export const dynamic = "force-dynamic";

/** 购买类写操作限流：比查询更严（网络重试 + 双击都不该打穿） */
const BREAKFAST_RATE_LIMIT_PER_MINUTE = 20;

/** 单次可买份数（与 PC 端 sellBreakfastAction 的 1 - 20 保持一致） */
const MIN_COUNT = 1;
const MAX_COUNT = 20;

/** 早餐单价上限（元/份）：防止 settings 里写错一个小数点就生成天价账单 */
const MAX_UNIT_PRICE = 9999;

/** breakfast_records 由 PC 端 actions.ts 懒建，老库可能没有；这里幂等兜底一次 */
let breakfastSchemaReady = false;

function ensureBreakfastRecordsSchema(): void {
  if (breakfastSchemaReady) return;
  run(`
    CREATE TABLE IF NOT EXISTS breakfast_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      guest_name TEXT,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      note TEXT,
      created_at TEXT
    )
  `);
  breakfastSchemaReady = true;
}

/** folio_items.request_id 列是否已存在（极老库还没跑迁移 13 段时降级写入） */
let requestIdColumnReady: boolean | null = null;

function hasRequestIdColumn(): boolean {
  if (requestIdColumnReady !== null) return requestIdColumnReady;
  try {
    const cols = all<{ name: string }>(`PRAGMA table_info(folio_items)`).map((c) => String(c.name));
    requestIdColumnReady = cols.includes("request_id");
  } catch {
    requestIdColumnReady = false;
  }
  return requestIdColumnReady;
}

/** 读一个 settings 值（表不存在 / 没配都返回空串） */
function readSetting(hotelId: number, keys: string[]): string {
  try {
    for (const key of keys) {
      const row = get<{ value: string | null }>(
        `SELECT value FROM settings WHERE hotel_id = ? AND key = ? ORDER BY id LIMIT 1`,
        [hotelId, key]
      );
      const v = (row?.value ?? "").trim();
      if (v) return v;
    }
  } catch {
    /* settings 表缺失 → 视为未配置 */
  }
  return "";
}

/** 操作日志：op_logs 缺失时不能反过来让业务失败（与 PC 端 writeOpLog 同一约定） */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string): void {
  try {
    const exists =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)?.n ?? 0;
    if (!exists) return;
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    /* 审计失败不影响业务结果 */
  }
}

/** UNIQUE 冲突判定（并发重复提交的兜底） */
function isUniqueViolation(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(text);
}

/** 在住单行（只取用得到的列） */
type StayRow = {
  id: number;
  stay_no: string;
  room_id: number;
  room_no: string | null;
  guest_name: string | null;
  breakfast: number | null;
  expect_check_out: string | null;
};

/** 账单摘要 */
type FolioRow = { id: number; folio_no: string; status: string | null };

export async function POST(req: Request) {
  /* ---------- 0. 限流（最前面，未登录的请求也计数） ---------- */
  const limited = rateLimit(req, { scope: "mini:breakfast", limit: BREAKFAST_RATE_LIMIT_PER_MINUTE });
  if (limited.limited) {
    const res = fail("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
    res.headers.set("retry-after", String(limited.retryAfterSeconds));
    return res;
  }

  /* ---------- 1. 鉴权：身份 / 租户 / 客史全部来自 token ---------- */
  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * 配置门槛（整改清单第 431 行）：停用小程序后不能再预购早餐。
   * 这一条尤其重要 —— 早餐会挂房账（folio_items）并写收银口径，
   * 停用期间继续入账会出现「小程序说买了、前台没看到」的金额差异。
   */
  const blocked = miniConfigBlocked(user);
  if (blocked) return blocked;

  if (!user.guestId) {
    return fail("NOT_BOUND", "尚未绑定手机号，请先绑定后再购买早餐");
  }

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  const hotelId = user.hotelId;
  const guestId = user.guestId;

  /* ---------- 2. 入参校验（文案可以直接展示给客人） ---------- */
  const count = int(body.count) || 0;
  if (count < MIN_COUNT || count > MAX_COUNT) {
    return fail("BAD_REQUEST", `早餐份数需为 ${MIN_COUNT} - ${MAX_COUNT} 份的整数`, 400);
  }

  const today = bizToday(hotelId);
  const dateRaw = str(body.date);
  const date = dateRaw || today;
  if (!isDateStr(date)) return fail("BAD_REQUEST", "早餐日期格式不正确（应为 YYYY-MM-DD）", 400);
  if (date < today) return fail("BAD_REQUEST", "不能购买过去日期的早餐", 400);

  /* ---------- 3. 单价：只认服务端配置，没配置就不卖（绝不编造价格） ---------- */
  const unitPriceText = readSetting(hotelId, ["breakfast_price", "mini_breakfast_price"]);
  const unitPrice = round2(Number(unitPriceText));
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return fail("NOT_CONFIGURED", "酒店尚未配置早餐价格，请到前台购买早餐");
  }
  if (unitPrice > MAX_UNIT_PRICE) {
    return fail("NOT_CONFIGURED", "早餐价格配置异常，请到前台购买早餐");
  }
  /* 总价服务端算：份数已在上面收窄，单价已校验，两者相乘即可；客户端传来的金额一律忽略 */
  const amount = round2(unitPrice * count);

  /* ---------- 4. 在住单：只能是「本店 + 本客史 + INHOUSE」 ---------- */
  const stays = all<StayRow>(
    `SELECT s.id, s.stay_no, s.room_id, r.room_no, s.guest_name,
            COALESCE(s.breakfast, 0) AS breakfast, s.expect_check_out
       FROM stays s
       LEFT JOIN rooms r ON r.id = s.room_id AND r.hotel_id = s.hotel_id
      WHERE s.hotel_id = ? AND s.guest_id = ? AND s.status = 'INHOUSE'
      ORDER BY s.id DESC`,
    [hotelId, guestId]
  );
  if (stays.length === 0) {
    /* 不含「有几间在住」这类信息，也不区分「没绑定」以外的原因 */
    return fail("NO_STAY", "当前没有在住的房间，无法购买早餐（如需购买请到前台）");
  }

  const hintStayId = int(body.stayId);
  const stay =
    (hintStayId > 0 ? stays.find((s) => s.id === hintStayId) : undefined) ?? stays[0];
  if (!stay) return fail("NO_STAY", "当前没有在住的房间，无法购买早餐（如需购买请到前台）");

  /* 早餐只能买到离店日当天（含）：离店日之后的早餐客人已经不在了 */
  const expectOut = (stay.expect_check_out ?? "").trim();
  if (expectOut && date > expectOut) {
    return fail("BAD_REQUEST", `早餐日期不能晚于离店日期 ${expectOut}`, 400);
  }

  /* ---------- 5. 账单：没有账单 / 已结账都不能挂账 ---------- */
  const folio = get<FolioRow>(
    `SELECT id, folio_no, status FROM folios WHERE stay_id = ? AND hotel_id = ? ORDER BY id DESC LIMIT 1`,
    [stay.id, hotelId]
  );
  if (!folio) {
    return fail("NO_FOLIO", "当前账单尚未生成，请到前台购买早餐");
  }
  if (folio.status === "SETTLED" || folio.status === "VOID") {
    return fail("FOLIO_CLOSED", "当前账单已结清，请到前台购买早餐");
  }

  /* ---------- 6. 幂等键 ---------- */
  const clientRequestId = str(body.requestId).slice(0, 64);
  /* 只接受 URL 安全字符：request_id 会进唯一索引与日志，脏字符没有好处 */
  const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId)
    ? clientRequestId
    : `minibf-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const withRequestId = hasRequestIdColumn();

  if (withRequestId) {
    const replayed = get<{ id: number; amount: number | null }>(
      `SELECT id, amount FROM folio_items WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
      [hotelId, requestId]
    );
    if (replayed) {
      /* 网络重试 / 双击第二下：直接按成功返回，不再重复挂账 */
      return ok({
        replayed: true,
        message: "该笔早餐已入账（重复提交已忽略）",
        stayNo: stay.stay_no,
        roomNo: stay.room_no,
        date,
        count,
        unitPrice,
        amount: round2(Number(replayed.amount ?? amount)),
        folioNo: folio.folio_no,
        balance: null,
        breakfastPending: null,
        paymentMode: "PAY_AT_HOTEL",
      });
    }
  }

  ensureBreakfastRecordsSchema();

  /* ---------- 7. 落库：账务明细 + 在住单份数 + 核销记录，一个事务 ---------- */
  const description = `早餐 ${count} 份（${date}）`;
  const operator = `小程序会员#${user.id}`;
  /*
   * 事务里回填的三项（TS 的控制流分析看不到闭包内的赋值，所以给默认值而不是裸声明，
   * 同时默认值也保证异常分支不会读到 undefined）
   */
  let balance = 0;
  let pendingCount = count;
  let breakfastTotal = Number(stay.breakfast ?? 0) + count;

  try {
    const result = tx(() => {
      if (withRequestId) {
        run(
          `INSERT INTO folio_items
             (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by, request_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [hotelId, folio.id, "OTHER", description, count, unitPrice, amount, date, nowIso(), null, requestId]
        );
      } else {
        run(
          `INSERT INTO folio_items
             (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [hotelId, folio.id, "OTHER", description, count, unitPrice, amount, date, nowIso(), null]
        );
      }

      /* 在住单含早份数 +N（与 PC 端 sellBreakfastAction 同口径，前台看到的是同一个数） */
      run(`UPDATE stays SET breakfast = COALESCE(breakfast, 0) + ? WHERE id = ? AND hotel_id = ?`, [
        count,
        stay.id,
        hotelId,
      ]);

      /* 早餐核销记录：当日已有记录就累加，没有就新建一条待核销（与 PC 端一致） */
      const record = get<{ id: number; count: number }>(
        `SELECT id, count FROM breakfast_records
          WHERE hotel_id = ? AND stay_id = ? AND date = ?
          ORDER BY id LIMIT 1`,
        [hotelId, stay.id, date]
      );
      if (record) {
        run(
          `UPDATE breakfast_records SET count = count + ?, status = 'PENDING', note = ?
            WHERE id = ? AND hotel_id = ?`,
          [count, `小程序购买 +${count} 份`, record.id, hotelId]
        );
        pendingCount = Number(record.count ?? 0) + count;
      } else {
        run(
          `INSERT INTO breakfast_records
             (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            stay.id,
            stay.room_no,
            stay.guest_name ?? "散客",
            date,
            count,
            "PENDING",
            `小程序购买 ${count} 份`,
            nowIso(),
          ]
        );
        pendingCount = count;
      }

      const money = recalcFolioBalance(hotelId, folio.id);
      const after = get<{ breakfast: number | null }>(
        `SELECT COALESCE(breakfast, 0) AS breakfast FROM stays WHERE id = ? AND hotel_id = ?`,
        [stay.id, hotelId]
      );
      breakfastTotal = Number(after?.breakfast ?? 0);

      /* 审计：动作名与 PC 端保持「卖早餐」，/logs 与早餐页汇总能一起看见 */
      writeOpLog(
        hotelId,
        operator,
        "卖早餐",
        `小程序购买 · 入住单 ${stay.stay_no} · 房间 ${stay.room_no ?? "-"} · +${count} 份 · ${date} · ${round2(
          amount
        )} 元 · 账单 ${folio.folio_no} · 余额 ${money.balance}`
      );

      return money.balance;
    });
    balance = result;
  } catch (e) {
    if (isUniqueViolation(e)) {
      /* 并发兜底：查重之后被另一个请求抢先写入 → 按重放处理，不报 500 */
      return ok({
        replayed: true,
        message: "该笔早餐已入账（并发重复提交已忽略）",
        stayNo: stay.stay_no,
        roomNo: stay.room_no,
        date,
        count,
        unitPrice,
        amount,
        folioNo: folio.folio_no,
        balance: null,
        breakfastPending: null,
        paymentMode: "PAY_AT_HOTEL",
      });
    }
    /* 不把数据库原始异常抛给小程序（清单第四节：不暴露 SQL / 堆栈） */
    return fail("SERVER_ERROR", "早餐下单失败，请稍后重试或到前台购买", 500);
  }

  /* ---------- 8. 站内通知：只发给当前这个 mini_user_id（清单第 302 行） ---------- */
  safeNotify({
    hotelId,
    miniUserId: user.id,
    type: MINI_NOTIFY_TYPE.BREAKFAST_PURCHASED,
    title: "早餐购买成功",
    body: `已为房间 ${stay.room_no ?? "-"} 购买 ${count} 份早餐（${date}），合计 ${amount} 元，已计入房费，请到餐厅凭房号用餐。`,
    refType: "breakfast",
    refId: folio.id,
  });

  return ok({
    replayed: false,
    stayNo: stay.stay_no,
    roomNo: stay.room_no,
    /** 姓名脱敏（响应体会被截图 / 前端日志落地，不下发全名） */
    guestName: maskGuestName(stay.guest_name ?? ""),
    date,
    count,
    /** 服务端算的单价 / 总价（客户端传来的金额一律不采信） */
    unitPrice,
    amount,
    currency: "CNY",
    folioNo: folio.folio_no,
    /** 记账后账单余额（正数 = 还应收，负数 = 应退） */
    balance: round2(balance),
    /** 该日待核销份数（早餐核销页 / 餐券页看到的是同一个数） */
    breakfastPending: pendingCount,
    /** 在住单累计含早份数 */
    breakfastTotal,
    status: "PENDING",
    statusLabel: "待核销",
    /** 项目当前默认到店付款：早餐计入房费，退房时一起结（不显示虚假在线支付） */
    paymentMode: "PAY_AT_HOTEL",
    paymentLabel: "计入房费 · 到店结账",
  });
}
