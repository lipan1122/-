/**
 * 小程序：预订下单 / 我的订单（整改清单 F12）
 *
 * POST /api/mini/bookings   下单（需要 Bearer token）
 * GET  /api/mini/bookings   我的订单（需要 Bearer token）
 *
 * ── 与 PC 端 createBookingAction 的口径对齐 ──
 *   · 必填：客人姓名、到店日、离店日；离店必须晚于到店
 *   · 房型必须属于本酒店（不能拿别家的房型 ID 下单）
 *   · 房费总额 = 每晚价 × 晚数 × 间数，一次算清写进 bookings.total_price
 *   · 建单同时落 booking_rooms 明细（每间一行），前台才能排房
 * 差异（小程序端有意简化）：
 *   · 只支持「单房型单行」，多房型 / 团队单请走前台
 *   · 一律 PENDING（小程序不排具体房间，由前台分配后再 CONFIRMED）
 */

import { all, get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { requireMiniToken } from "@/lib/mini-auth";
import { rateLimit } from "@/lib/mini-rate-limit";
import { nowIso } from "@/lib/utils";
import {
  dayDiff,
  fail,
  int,
  isDateStr,
  isMobile,
  isRequestId,
  loadAvailability,
  MAX_NIGHTS,
  MAX_ROOM_COUNT,
  MiniBizError,
  miniConfigBlocked,
  nextBookingSeq,
  ok,
  readJsonBody,
  round2,
  str,
} from "../_shared";

export const dynamic = "force-dynamic";

/** 订单状态中文名（与 utils.BOOKING_STATUS 一致，这里只取文案不打样式） */
const STATUS_LABEL: Record<string, string> = {
  PENDING: "待排房",
  CONFIRMED: "已确认",
  CHECKED_IN: "已入住",
  CHECKED_OUT: "已离店",
  CANCELLED: "已取消",
  NOSHOW: "未到",
};

/* ========================================================================== */
/*                                   下单                                      */
/* ========================================================================== */

/* ------------------------- 下单幂等（mini_request_id） -------------------------
 *
 * 第九轮专项测试发现的 P0 缺陷：本接口**完全没有** request_id 幂等 ——
 * 同一个 requestId 顺序提交两次会建两张单（实测 BK3003 / BK3004），
 * 并发提交两次同样建两张。现实后果：
 *   · 客人点了「提交订单」网络超时，看没反应又点一次 → 两张重复单；
 *   · 前台看到两张单 → 重复排房 / 重复锁房，最后一间被自己的重复单占掉；
 *   · 若接入在线支付，同一笔入住可能被收两次房费。
 * 整改清单第 109 行明确要求「request_id 幂等」「网络超时重试不重复建单」。
 *
 * 实现三层，缺一层都不够：
 *   1. **先查**：带 requestId 的请求先按 (hotel_id, mini_request_id) 查一次，
 *      命中就原样返回原订单（replayed: true），不再校验房量/日期 ——
 *      重放必须成功，否则「第一次其实已经成功、第二次却报房量不足」会误导客人；
 *   2. **同事务写入**：mini_request_id 与订单在同一个 tx 里落库，不会出现
 *      「订单建了、幂等键没写」导致的重放失效；
 *   3. **唯一索引兜底**：并发时两个请求都可能先查不到，靠
 *      `idx_bookings_mini_request`（部分唯一，NULL 不进索引）让后插入的那个抛错，
 *      catch 后重查一次按重放返回 —— 不把 500 抛给小程序。
 *
 * 不带 requestId 时**保持原有行为**（照常建单）：小程序历史版本、联调脚本、
 * 其他调用方都还在用不带键的请求体，强制必传会让它们全部 400；
 * 幂等是加强而不是破坏性变更。新版本小程序（pages/booking）一定带键。
 */

/** 表结构只建一次（dev 热重载会重置模块，IF NOT EXISTS / 列已存在判断都幂等） */
let bookingRequestSchemaReady = false;

/**
 * 运行时懒建幂等键列 + 部分唯一索引（清单第六节第 387-394 行的「第 4 处同步」）。
 *
 * ⚠️ 这里的 DDL 必须与 scripts/schema-full.sql（建表 + 索引）、
 *    scripts/init-db.mjs（建表）、scripts/migrate-all.mjs（12.5 段）、
 *    scripts/schema-fingerprint.json（导出）逐列/逐索引一致。
 *
 * 为什么必须 try/catch 包住 ALTER：SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
 * 列已存在时只能靠异常判断（项目里 bind / mini-config 都是同一写法）。
 */
function ensureBookingRequestSchema(): void {
  if (bookingRequestSchemaReady) return;
  const table = get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bookings'`);
  /* 表都不存在时不在这里制造第二个错误：后面的业务 SQL 会自己报出来 */
  if (Number(table?.n ?? 0) === 0) return;

  try {
    run(`ALTER TABLE bookings ADD COLUMN mini_request_id TEXT`);
  } catch {
    /* 列已存在 → 跳过 */
  }
  run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_mini_request
       ON bookings(hotel_id, mini_request_id) WHERE mini_request_id IS NOT NULL`
  );
  bookingRequestSchemaReady = true;
}

/**
 * 读幂等键：请求体 `requestId` / `request_id`，或请求头 `x-request-id`。
 *
 * 为什么两处都收：小程序页面走 body（与 cancel / modify / breakfast 等接口一致），
 * 而「网关重试 / 中间层补偿」这类调用方通常只在请求头带 trace id ——
 * 统一在这一处归一，业务代码只认一个字符串。
 */
function readMiniRequestId(req: Request, body: Record<string, unknown>): string {
  const fromBody = str(body.requestId) || str(body.request_id);
  if (fromBody) return fromBody;
  return (req.headers.get("x-request-id") ?? "").trim();
}

/** 已存在订单的重放视图（字段与首次下单响应保持一致，前端不用分支处理） */
type ReplayBooking = {
  bookingId: number;
  bookingNo: string;
  roomTypeName: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  roomCount: number;
  totalPrice: number;
  /** 下单人（mini_program_bookings.mini_user_id；历史单可能没有关联行 → null） */
  miniUserId: number | null;
};

type ReplayRow = {
  id: number;
  booking_no: string | null;
  room_type_name: string | null;
  check_in_date: string | null;
  check_out_date: string | null;
  nights: number | null;
  room_count: number | null;
  total_price: number | null;
  mini_user_id: number | null;
};

/** 按幂等键查已有订单（带 hotel_id：不同门店可能各自生成同一串 requestId） */
function findBookingByRequestId(hotelId: number, requestId: string): ReplayBooking | null {
  if (!requestId) return null;
  ensureBookingRequestSchema();
  const row = get<ReplayRow>(
    `SELECT b.id, b.booking_no, rt.name AS room_type_name,
            b.check_in_date, b.check_out_date, b.nights, b.room_count,
            COALESCE(b.total_price, 0) AS total_price,
            (SELECT mb.mini_user_id FROM mini_program_bookings mb
              WHERE mb.hotel_id = b.hotel_id AND mb.booking_id = b.id
              LIMIT 1) AS mini_user_id
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id
      WHERE b.hotel_id = ? AND b.mini_request_id = ?
      LIMIT 1`,
    [hotelId, requestId]
  );
  if (!row) return null;
  return {
    bookingId: Number(row.id),
    bookingNo: (row.booking_no ?? "").trim(),
    roomTypeName: (row.room_type_name ?? "").trim() || "房型",
    checkInDate: (row.check_in_date ?? "").trim(),
    checkOutDate: (row.check_out_date ?? "").trim(),
    nights: Number(row.nights ?? 0),
    roomCount: Number(row.room_count ?? 1),
    totalPrice: round2(Number(row.total_price ?? 0)),
    miniUserId: row.mini_user_id == null ? null : Number(row.mini_user_id),
  };
}

/**
 * 重放 / 首次下单的统一响应体。
 *
 * `replayed` 是小程序端判断「这张单是刚建的还是早就有的」的唯一依据：
 * 重放时前端不能再说「预订成功，请查收」，而应提示「该订单已提交」并直接去订单详情。
 */
function bookingPayload(row: {
  bookingId: number;
  bookingNo: string;
  roomTypeName: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  roomCount: number;
  totalPrice: number;
}, replayed: boolean) {
  return {
    bookingNo: row.bookingNo,
    bookingId: row.bookingId,
    roomTypeName: row.roomTypeName,
    checkInDate: row.checkInDate,
    checkOutDate: row.checkOutDate,
    nights: row.nights,
    roomCount: row.roomCount,
    totalPrice: row.totalPrice,
    /* 幂等重放标记：true = 命中已有订单，没有新建任何数据 */
    replayed,
    /* 兼容第九轮测试脚本早期写法（duplicated 与 replayed 语义相同） */
    duplicated: replayed,
  };
}

export async function POST(req: Request) {
  /* ---------- 1. 鉴权 ---------- */
  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * 限流（其余写接口都有，唯独下单这条原来漏了）
   *
   * 下单是唯一会**真实占房量**的写接口：不限流的话脚本可以批量建单把房卖光，
   * 而且每条都会进前台的排房队列。这里 10 次/分钟 —— 与「取消/改单/续住/换房」
   * 等写接口同一档（正常客人一分钟点不出 10 张单，脚本会被挡住）。
   *
   * 放在鉴权之后、配置与业务校验之前：未登录的请求不该消耗配额。
   */
  const limited = rateLimit(req, { scope: "mini:booking:create", limit: 10 });
  if (limited.limited) {
    return fail("RATE_LIMITED", "操作太频繁，请稍后再试", 429);
  }

  /*
   * 配置门槛（整改清单第 431 行）：管理员停用小程序后不能再自助下单。
   * 放在鉴权之后、任何读写之前 —— 停用期间建单会直接进前台的排房队列。
   */
  const blocked = miniConfigBlocked(user);
  if (blocked) return blocked;

  const body = await readJsonBody(req);
  if (!body) return fail("BAD_REQUEST", "请求体必须是 JSON 对象", 400);

  /*
   * 无条件先确保幂等键列/索引存在（不只在带 requestId 时才建）：
   * 下面的 INSERT 语句**固定列出** mini_request_id 列（不带键时写 NULL），
   * 老库/未跑迁移的库若缺这一列，连「不带键下单」都会 no such column。
   * 放在事务外、业务校验前，一次进程只执行一次。
   */
  ensureBookingRequestSchema();

  /* ---------- 1.5 幂等键：有则先查已有订单，命中直接原样返回 ---------- */
  const requestId = readMiniRequestId(req, body);
  if (requestId && !isRequestId(requestId)) {
    /*
     * 格式不合法的键不能静默忽略：忽略 = 退化成「没有幂等」，重试照样重复建单。
     * 文案引导回上一页重新进入（page-state 会生成一个合法的新 requestId）。
     */
    return fail("BAD_REQUEST", "请求标识格式不正确，请返回上一页重新进入小程序后再提交", 400);
  }

  const hotelId = user.hotelId;

  if (requestId) {
    const replay = findBookingByRequestId(hotelId, requestId);
    if (replay) {
      /*
       * 幂等键是客户端生成的字符串，理论上两个微信号可能撞同一个值。
       * 命中别人的单时**不能**把单号 / 金额回给当前用户（那就是一个拿订单的越权口），
       * 只回一个明确的重试指引。
       */
      if (replay.miniUserId !== null && replay.miniUserId !== user.id) {
        return fail("REQUEST_ID_CONFLICT", "该请求标识已被其他订单使用，请返回上一页重新进入小程序后再提交", 409);
      }
      return ok(bookingPayload(replay, true));
    }
  }

  const roomTypeId = int(body.roomTypeId);
  const checkInDate = str(body.checkInDate);
  const checkOutDate = str(body.checkOutDate);
  const roomCount = int(body.roomCount) || 1;
  const guestName = str(body.guestName);
  const mobile = str(body.mobile);
  const remark = str(body.remark).slice(0, 200);

  /* ---------- 2. 入参校验（文案要能直接展示给客人） ---------- */
  if (!guestName) return fail("BAD_REQUEST", "请填写入住人姓名", 400);
  if (guestName.length > 30) return fail("BAD_REQUEST", "入住人姓名最多 30 个字", 400);
  if (!isDateStr(checkInDate)) return fail("BAD_REQUEST", "请选择到店日期", 400);
  if (!isDateStr(checkOutDate)) return fail("BAD_REQUEST", "请选择离店日期", 400);

  const nights = dayDiff(checkInDate, checkOutDate);
  if (nights <= 0) return fail("BAD_REQUEST", "离店日期必须晚于到店日期", 400);
  if (nights > MAX_NIGHTS) return fail("BAD_REQUEST", `单笔预订最多 ${MAX_NIGHTS} 晚`, 400);
  if (checkInDate < bizToday(user.hotelId)) return fail("BAD_REQUEST", "到店日期不能早于今天", 400);

  if (!isMobile(mobile)) return fail("BAD_REQUEST", "请填写正确的 11 位手机号", 400);
  if (roomCount < 1 || roomCount > MAX_ROOM_COUNT) {
    return fail("BAD_REQUEST", `单笔最多预订 ${MAX_ROOM_COUNT} 间`, 400);
  }
  if (!roomTypeId) return fail("BAD_REQUEST", "请选择房型", 400);

  /* ---------- 3. 房型归属校验（与 PC 端一致：只认本酒店的房型） ---------- */
  const roomType = get<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE id = ? AND hotel_id = ?`,
    [roomTypeId, hotelId]
  );
  if (!roomType) return fail("BAD_REQUEST", "所选房型无效，请刷新后重新选择", 400);

  /* ---------- 4. 房量校验（事务外先查一次，给出明确文案；事务内再查一次防并发） ---------- */
  const pre = loadAvailability(hotelId, checkInDate, checkOutDate);
  const preType = pre.roomTypes.find((t) => t.roomTypeId === roomTypeId);
  if (!preType) return fail("BAD_REQUEST", "所选房型无效，请刷新后重新选择", 400);
  if (preType.remainingRooms < roomCount) {
    return fail(
      "ROOM_NOT_ENOUGH",
      `「${roomType.name}」在该日期区间仅剩 ${preType.remainingRooms} 间，无法预订 ${roomCount} 间`
    );
  }

  /* ---------- 5. 会员身份：已绑客史就取 vip_level / guest_id ---------- */
  let guestId: number | null = user.guestId;
  let memberCard: string | null = null;
  let memberType: string | null = null;
  if (guestId) {
    const guest = get<{ id: number; name: string; mobile: string | null; vip_level: number | null }>(
      `SELECT id, name, mobile, vip_level FROM guests WHERE id = ? AND hotel_id = ?`,
      [guestId, hotelId]
    );
    if (guest) {
      memberCard = (guest.mobile ?? "").trim() || null;
      const vip = Number(guest.vip_level ?? 0);
      memberType = vip > 0 ? `VIP${vip}` : "普通";
    } else {
      // 档案被删除 / 换了酒店：不阻断下单，但不要带着脏 guest_id 落库
      guestId = null;
    }
  }

  /* ---------- 6. 落库（主单 + N 条房间明细） ---------- */
  const now = nowIso();
  const finalRemark = remark ? `微信小程序下单；${remark}` : "微信小程序下单";

  let created: { bookingId: number; bookingNo: string; totalPrice: number };
  try {
    created = tx(() => {
      /*
       * 并发兜底：事务内用同一口径再算一次房量。
       * 两个人同时点「提交」时，事务外的检查都会通过；
       * 事务内再查一次能挡住「最后一间被抢走」，宁可让后一个人看到提示重选，
       * 也不能把同一间房卖两次（前台排房才会有房可排）。
       */
      const fresh = loadAvailability(hotelId, checkInDate, checkOutDate);
      const freshType = fresh.roomTypes.find((t) => t.roomTypeId === roomTypeId);
      if (!freshType || freshType.remainingRooms < roomCount) {
        throw new MiniBizError(
          "ROOM_NOT_ENOUGH",
          `「${roomType.name}」在该日期区间房量不足，请重新选择日期或房型`
        );
      }

      // 订单一律按现行房价日历计价，不接受客户端传价格（防止改价下单）
      const rate = round2(freshType.avgPrice);
      const totalPrice = round2(rate * nights * roomCount);

      const maxId = get<{ max_id: number }>(`SELECT COALESCE(MAX(id), 0) AS max_id FROM bookings`)?.max_id ?? 0;
      const bookingNo = nextBookingSeq(Number(maxId));

      const inserted = run(
        `INSERT INTO bookings (
           hotel_id, booking_no, guest_id, guest_name, mobile, room_type_id, room_id,
           channel_id, company_id, check_in_date, check_out_date, nights,
           room_count, guest_count, rate, deposit, total_price, status, remark,
           booking_type, team_name, member_card, member_type, arrival_time,
           rate_code, salesman, package_code, invoice_party, retain_time,
           pay_type, breakfast, channel_order_no, created_by, created_at, updated_at,
           mini_request_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          bookingNo,
          guestId,
          guestName,
          mobile,
          roomTypeId,
          null, // room_id：小程序不排具体房间
          null,
          null,
          checkInDate,
          checkOutDate,
          nights,
          roomCount,
          1,
          rate,
          0,
          totalPrice,
          "PENDING",
          finalRemark,
          "guest",
          null,
          memberCard,
          memberType,
          "12:00",
          "门市价",
          null,
          null,
          "酒店",
          null,
          "到店付款",
          0,
          null,
          null, // created_by：小程序客人不是系统用户
          now,
          now,
          /*
           * 幂等键与订单**同一个事务**落库：不会出现「单建了、键没写」导致的重放失效。
           * 不带键时落 NULL —— 部分唯一索引 (hotel_id, mini_request_id) WHERE
           * mini_request_id IS NOT NULL 不约束历史 NULL 行，老单可以共存。
           */
          requestId || null,
        ]
      );

      const bookingId = Number(inserted.lastInsertRowid);

      /* 每间一行明细：前台「待排房」列表靠它统计间数，入住时逐条排房 */
      for (let i = 0; i < roomCount; i += 1) {
        run(
          `INSERT INTO booking_rooms
             (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
              check_in_date, check_out_date, stay_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [hotelId, bookingId, roomTypeId, null, guestName, mobile, rate, "PENDING", checkInDate, checkOutDate, null, now]
        );
      }

      /*
       * 整改 P2-17：把这笔单记到「当前微信用户」名下（服务端事务内写，客户端无法伪造）。
       * 旧实现只把手机号写进 mini_program_users.mobile，再按手机号反查订单 ——
       * 手机号是下单时用户自填的自由文本，随手填别人的号就能把别人的订单拉进
       * 「我的订单」（与 P0-12 同类的越权）。现在身份关联只认这张关联表，
       * mobile 列仅作联系信息冗余，**不参与任何授权判断**。
       */
      run(
        `INSERT OR IGNORE INTO mini_program_bookings (hotel_id, mini_user_id, booking_id, created_at)
         VALUES (?,?,?,?)`,
        [hotelId, user.id, bookingId, now]
      );
      run(`UPDATE mini_program_users SET mobile = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
        mobile,
        now,
        user.id,
        hotelId,
      ]);

      /* 操作日志：小程序来的单在前台 op_logs 里能查到，出问题好追溯 */
      run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        "微信小程序",
        "小程序预订",
        `${bookingNo} ${guestName} ${roomType.name} ${checkInDate}~${checkOutDate} ${roomCount} 间`,
        now,
      ]);

      return { bookingId, bookingNo, totalPrice };
    });
  } catch (e) {
    /*
     * 并发兜底（幂等键的唯一索引）：两个请求几乎同时进来时，外层「先查」都会落空，
     * 事务里只有一个能插入成功；后到的那个会撞 idx_bookings_mini_request 抛
     * UNIQUE constraint failed。
     *
     * 这个分支**不能**直接回 500 / BOOKING_FAILED —— 那对小程序来说就是「下单失败」，
     * 客人会再点一次，而订单其实已经建好了。这里按幂等键重查一次，命中就按重放返回
     * （与上层先查的响应完全一致），重查不到才认为是真的写库失败。
     *
     * 重查放在 MiniBizError 之前：如果另一个进程刚好在我们算房量期间建好了这张单，
     * 事务内取到的房量可能已经「不足」并抛 ROOM_NOT_ENOUGH —— 但同一个幂等键的订单
     * 明明已经成功建好了，此时该回订单而不是「房量不足」。
     */
    if (requestId) {
      const existing = findBookingByRequestId(hotelId, requestId);
      if (existing) {
        if (existing.miniUserId !== null && existing.miniUserId !== user.id) {
          return fail("REQUEST_ID_CONFLICT", "该请求标识已被其他订单使用，请返回上一页重新进入小程序后再提交", 409);
        }
        return ok(bookingPayload(existing, true));
      }
    }
    if (e instanceof MiniBizError) return fail(e.code, e.message);
    return fail("BOOKING_FAILED", "下单失败，请稍后重试或联系酒店前台");
  }

  return ok(
    bookingPayload(
      {
        bookingId: created.bookingId,
        bookingNo: created.bookingNo,
        roomTypeName: roomType.name,
        checkInDate,
        checkOutDate,
        nights,
        roomCount,
        totalPrice: created.totalPrice,
      },
      false
    )
  );
}

/* ========================================================================== */
/*                                 我的订单                                    */
/* ========================================================================== */

export async function GET(req: Request) {
  const user = requireMiniToken(req);
  if (!user) return fail("UNAUTHORIZED", "未登录或登录已过期，请重新进入小程序", 401);

  /*
   * 配置门槛（整改清单第 431 行）：停用小程序后「我的订单」也要停。
   * 订单里有单号 / 房型 / 金额 / 日期 —— 属于停用后不应继续下发的业务数据。
   */
  const blocked = miniConfigBlocked(user);
  if (blocked) return blocked;

  const hotelId = user.hotelId;

  /*
   * 身份口径（整改清单 P0-12 / P2-17）：只认服务端关系，不接受任何请求参数
   *
   *   1. 已绑定客史 → b.guest_id = token 推出的 guestId
   *      （前台代建、渠道来的单都算「我的」，这才是会员该看到的全量订单）
   *   2. 这个微信用户在小程序下过的单 → mini_program_bookings 关联行
   *      （未绑定手机号也能看到自己下的单，P2-17 的诉求）
   *
   * **旧实现已删除**：`b.mobile = mini_program_users.mobile` 的兜底。
   * 它把「用户自填/绑定请求里的手机号」当成授权凭证：只要在绑定或下单时填上
   * 别人的手机号，就能把对方名下的订单拉进自己的「我的订单」（P0-12 的越权形态）。
   * 现在 mobile 列只作联系信息冗余，绝不参与取数条件。
   */
  const guestId = user.guestId;

  const rows = all<{
    id: number;
    booking_no: string;
    guest_name: string | null;
    room_type_name: string | null;
    check_in_date: string;
    check_out_date: string;
    nights: number | null;
    room_count: number | null;
    amount: number | null;
    status: string;
    created_at: string | null;
  }>(
    `SELECT b.id, b.booking_no, b.guest_name,
            rt.name AS room_type_name,
            b.check_in_date, b.check_out_date, b.nights, b.room_count,
            COALESCE(
              b.total_price,
              ROUND(COALESCE(b.rate, 0) * COALESCE(NULLIF(b.nights, 0), 1) * COALESCE(b.room_count, 1), 2)
            ) AS amount,
            b.status, b.created_at
       FROM bookings b
       LEFT JOIN room_types rt ON rt.id = b.room_type_id AND rt.hotel_id = b.hotel_id
      WHERE b.hotel_id = ?
        AND (
          (? IS NOT NULL AND b.guest_id = ?)
          OR EXISTS (
            SELECT 1 FROM mini_program_bookings mb
             WHERE mb.hotel_id = b.hotel_id
               AND mb.booking_id = b.id
               AND mb.mini_user_id = ?
          )
        )
      ORDER BY b.check_in_date DESC, b.id DESC
      LIMIT 100`,
    [hotelId, guestId, guestId, user.id]
  );

  return ok({
    bound: Boolean(guestId),
    total: rows.length,
    bookings: rows.map((r) => ({
      bookingId: r.id,
      bookingNo: r.booking_no,
      guestName: r.guest_name,
      roomTypeName: r.room_type_name ?? "—",
      checkInDate: r.check_in_date,
      checkOutDate: r.check_out_date,
      nights: Number(r.nights ?? 0),
      roomCount: Number(r.room_count ?? 1),
      amount: round2(Number(r.amount ?? 0)),
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      createdAt: r.created_at,
    })),
  });
}
