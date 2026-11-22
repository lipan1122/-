"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { requirePermission, requireUser } from "@/lib/session";
import { changeRoomStatus } from "@/lib/room-status";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";
import { NON_REVENUE_ITEM, recalcFolioBalance } from "@/lib/folio";
import { getCompanyOutstanding, postArCharge } from "@/lib/ar";
import { issueInvoice } from "@/lib/invoice";
/* 第 4 轮 P1-9：收银台支持会员储值卡支付（扣余额） */
import { consumeWallet, getWalletBalance } from "@/lib/member-wallet";
/* 整改 P2-5：退房打扫任务不再写死固定姓名，按本店在岗客房人员动态指派 */
import { pickHousekeepingAssignee } from "@/lib/housekeeping-assignee";
/* 第 4 轮 P1-20：退房回传渠道状态（CHECKED_OUT） */
import { pushOrderStatusForChannelOrder } from "@/lib/channels/order-status";

/** 统一返回：{ error } 失败提示，{ ok } 成功提示 */
type ActionState = { error?: string; ok?: string } | undefined;

/**
 * 部分结账写入的调整项前缀。
 * 这一项只作为「已结账金额」的账务记录（负项），不参与应收合计，
 * 否则 paid_amount 与本项会被重复扣减，余额会被多冲一次。
 */
const PARTIAL_SETTLE_PREFIX = "【部分结账】";

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** 表单值转数字，非法值返回兜底值 */
function num(value: FormDataEntryValue | null, fallback = 0) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function numOf(formData: FormData, key: string, fallback = 0) {
  return num(formData.get(key), fallback);
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 收款单号：P + 毫秒时间戳，尾随随机数避免同毫秒重复 */
function nextPayNo() {
  return `P${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

/**
 * 重算账单：total_amount = SUM(明细)，balance = total_amount - paid_amount
 * 「部分结账」写入的负项是已结记录，需从合计中排除。
 */

/** 账务操作日志（/logs 页面可查） */
function writeLog(hotelId: number, operator: string, action: string, detail: string) {
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

function revalidateCashier() {
  revalidatePath("/cashier");
  revalidatePath("/dashboard");
  revalidatePath("/logs");
}

function revalidateRooms() {
  revalidatePath("/rooms");
  revalidatePath("/inhouse");
  revalidatePath("/housekeeping");
}

/** 备注里写入/替换【挂账】标记，重复挂账时不会堆叠 */
function withCreditMark(remark: string | null, companyName: string) {
  const kept = (remark ?? "")
    .split("；")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("【挂账】"))
    .join("；");
  const mark = `【挂账】${companyName}`;
  return kept ? `${kept}；${mark}` : mark;
}

type FolioContext = {
  id: number;
  folio_no: string;
  status: string;
  total_amount: number;
  paid_amount: number;
  balance: number;
  stay_id: number;
  stay_no: string;
  room_no: string;
  guest_name: string;
};

function loadFolioContext(folioId: number, hotelId: number) {
  return get<FolioContext>(
    `SELECT f.id, f.folio_no, f.status, f.total_amount, f.paid_amount, f.balance,
            s.id AS stay_id, s.stay_no, r.room_no, s.guest_name
       FROM folios f
       JOIN stays s ON s.id = f.stay_id
       JOIN rooms r ON r.id = s.room_id
      WHERE f.id = ? AND f.hotel_id = ?`,
    [folioId, hotelId]
  );
}

/** 加收消费 / 入账：写入 folio_items 并重算账单 */
/**
 * 拆账（去呼呼「拆账」）：把选中的消费项目从当前账单移到一张新账单。
 * 分单号在原单号后加 -B / -C 后缀，两张单可各自结账。
 */
export async function splitFolioAction(formData: FormData): Promise<ActionState> {
  // 权限边界（上线前加固）：拆账单只对 admin / 收银开放，原来只校验登录
  const user = await requirePermission("cashier.split");
  const folioId = numOf(formData, "folio_id");
  const itemIds = formData
    .getAll("item_id")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!folioId) return { error: "账务单不存在" };
  if (itemIds.length === 0) return { error: "请先勾选要拆出去的消费项目" };

  const folio = get<{ id: number; folio_no: string; stay_id: number | null; guest_name: string | null; room_no: string | null; status: string }>(
    `SELECT id, folio_no, stay_id, guest_name, room_no, status FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, user.hotelId]
  );
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能拆账" };

  // 同一入住单已有的拆账单数量，决定后缀
  const siblings =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM folios WHERE hotel_id = ? AND stay_id = ? AND id <> ?`,
      [user.hotelId, folio.stay_id, folioId]
    )?.c ?? 0;
  const suffix = String.fromCharCode(66 + siblings); // B, C, D…

  let newFolioNo = "";
  tx(() => {
    newFolioNo = `${folio.folio_no}-${suffix}`;

    /*
     * 拆账要分摊「已收款 / 押金」（整改清单 P1-4 + 第 4 轮 P1-14）
     *
     * 旧实现：新单 paid_amount 直接给 0，原单 paid 一点不动 ——
     * 结果两单合计的 paid 变了，客户看着「已经付过的钱」凭空少了。
     *
     * 分摊比例的**分母必须是「消费明细合计」**，不能用「含押金的总额」：
     * 押金是负债不是消费，把它算进分母会让比例偏小，
     * 拆出去的消费拿走不到应得的已收款，原单剩下的 balance 变成虚假负数。
     *
     * 统一口径用 NON_REVENUE_ITEM（排除 DEPOSIT 和「部分结账」ADJUST），
     * 与 recalcFolioBalance 完全一致 —— 口径只有一份。
     */
    const oldTotal = round2(
      get<{ t: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items
          WHERE folio_id = ? AND hotel_id = ?
            AND NOT ${NON_REVENUE_ITEM}`,
        [folioId, user.hotelId]
      )?.t ?? 0
    );
    const moveTotal = round2(
      get<{ t: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items
          WHERE folio_id = ? AND hotel_id = ?
            AND id IN (${itemIds.map(() => "?").join(",")})
            AND NOT ${NON_REVENUE_ITEM}`,
        [folioId, user.hotelId, ...itemIds]
      )?.t ?? 0
    );
    const oldPaid = round2(
      Number(
        get<{ p: number }>(`SELECT COALESCE(paid_amount, 0) AS p FROM folios WHERE id = ? AND hotel_id = ?`, [
          folioId,
          user.hotelId,
        ])?.p ?? 0
      )
    );
    /* 分摊比例：拆出去的消费占原单的比例，按此切走已收款 */
    const ratio = oldTotal > 0 ? moveTotal / oldTotal : 0;
    const movePaid = round2(Math.min(oldPaid, Math.max(0, oldPaid * ratio)));
    const keepPaid = round2(oldPaid - movePaid);

    const newId = run(
      `INSERT INTO folios (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
       VALUES (?,?,?,?,?,0,?,0,'OPEN',?)`,
      [user.hotelId, newFolioNo, folio.stay_id, folio.guest_name, folio.room_no, movePaid, nowIso()]
    ).lastInsertRowid;

    /* 原单的已收款同步扣掉被分走的部分，两单合计守恒 */
    run(`UPDATE folios SET paid_amount = ? WHERE id = ? AND hotel_id = ?`, [keepPaid, folioId, user.hotelId]);

    /* 收款流水也跟着拆：把对应比例的 payments 挪到新单，账面可追溯 */
    if (movePaid > 0) {
      const pays = all<{ id: number; amount: number }>(
        `SELECT id, amount FROM payments WHERE hotel_id = ? AND folio_id = ? AND amount > 0 ORDER BY id`,
        [user.hotelId, folioId]
      );
      let remaining = movePaid;
      for (const p of pays) {
        if (remaining <= 0.001) break;
        const take = round2(Math.min(remaining, Number(p.amount)));
        if (take >= Number(p.amount) - 0.001) {
          /* 整笔挪走 */
          run(`UPDATE payments SET folio_id = ? WHERE id = ? AND hotel_id = ?`, [newId, p.id, user.hotelId]);
          remaining = round2(remaining - take);
        } else {
          /* 部分挪：原流水减额，新单记一笔负数冲抵，保持流水可核对 */
          run(`UPDATE payments SET amount = ? WHERE id = ? AND hotel_id = ?`, [
            round2(Number(p.amount) - take),
            p.id,
            user.hotelId,
          ]);
          run(
            `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              user.hotelId,
              newId,
              folio.stay_id,
              `${folio.folio_no}-SPLIT-${p.id}`,
              "拆账分摊",
              take,
              todayStr(),
              `从原单 ${folio.folio_no} 按比例分摊`,
              nowIso(),
              user.realName ?? user.username,
            ]
          );
          remaining = 0;
        }
      }
    }

    // 只挪属于本单的项目
    const placeholders = itemIds.map(() => "?").join(",");
    run(
      `UPDATE folio_items SET folio_id = ? WHERE hotel_id = ? AND folio_id = ? AND id IN (${placeholders})`,
      [newId, user.hotelId, folioId, ...itemIds]
    );

    recalcFolioBalance(user.hotelId, folioId);
    recalcFolioBalance(user.hotelId, Number(newId));

    /* 第 4 轮 P2-22a：拆账记审计（谁在什么时候把哪几个项目拆到哪张新单） */
    writeLog(
      user.hotelId,
      user.realName ?? user.username,
      "拆账",
      `原账单 ${folio.folio_no} · 新账单 ${newFolioNo} · 拆出 ${itemIds.length} 项 · 金额 ${fmtMoney(moveTotal)} · 分摊已收 ${fmtMoney(movePaid)}`
    );
  });

  revalidateCashier();
  return { ok: `已拆出 ${itemIds.length} 个项目到账单 ${newFolioNo}` };
}

export async function addChargeAction(formData: FormData): Promise<ActionState> {
  /*
   * 权限边界（上线前加固）：入账必须校验权限，原来只校验登录。
   *
   * 用 cashier.receive（收银员本职）而不是 folio.post_charge：
   * /cashier 页面对能进该页的所有角色都渲染入账表单，收银员必须能用；
   * 而 folio.post_charge 同时被 /inhouse 的「补过房费」用到，
   * 那个入口收银员根本进不去 —— 共用一个权限点会互相牵制。
   */
  const user = await requirePermission("cashier.receive");
  const folioId = numOf(formData, "folio_id");
  const rawType = str(formData, "item_type") || "OTHER";
  const itemType = rawType === "ROOM" || rawType === "FOOD" || rawType === "OTHER" ? rawType : "OTHER";
  const description = str(formData, "description");
  const qty = numOf(formData, "qty", 1);
  const price = numOf(formData, "price");
  const bizDate = str(formData, "biz_date") || bizToday(user.hotelId);

  if (!folioId) return { error: "账务单不存在" };
  if (qty <= 0) return { error: "数量必须大于 0" };
  if (price < 0) return { error: "单价不能为负数" };

  const folio = get<{ id: number; status: string }>(
    `SELECT id, status FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, user.hotelId]
  );
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能再入账" };

  const amount = round2(qty * price);
  const desc =
    description || (itemType === "ROOM" ? `房费 ${bizDate}` : itemType === "FOOD" ? "餐饮消费" : "其他消费");

  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folioId, itemType, desc, qty, price, amount, bizDate, nowIso(), user.id]
    );
    recalcFolioBalance(user.hotelId, folioId);
  });
  revalidateCashier();
  return { ok: `已入账 ${fmtMoney(amount)}` };
}

/**
 * 收款：写入 payments 并累加已收金额
 *
 * 整改报告 P1-5：
 *   - 幂等：同一 request_id 重复提交只生成一笔（唯一索引兜底）
 *   - 记录 operator
 *   - 金额后端复算，不信任前端
 */
export async function addPaymentAction(formData: FormData): Promise<ActionState> {
  const user = await requirePermission("cashier.receive");
  const folioId = numOf(formData, "folio_id");
  const method = str(formData, "method") || "现金";
  const amount = round2(numOf(formData, "amount"));
  const remark = str(formData, "remark");
  const requestId = str(formData, "request_id") || null;

  if (!folioId) return { error: "账务单不存在" };
  if (amount <= 0) return { error: "收款金额必须大于 0" };
  if (amount > 999999) return { error: "收款金额超出上限" };

  /* 幂等：同一 request_id 已经收过，直接返回成功（不重复入账） */
  if (requestId) {
    const dup = get<{ id: number; amount: number }>(
      `SELECT id, amount FROM payments WHERE hotel_id = ? AND request_id = ?`,
      [user.hotelId, requestId]
    );
    if (dup) return { ok: `该笔收款已入账 ${fmtMoney(Number(dup.amount))}（重复提交已忽略）` };
  }

  const folio = get<{ id: number; stay_id: number | null; status: string; balance: number }>(
    `SELECT id, stay_id, status, balance FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, user.hotelId]
  );
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能再收款" };

  const stayId = numOf(formData, "stay_id") || folio.stay_id || null;

  /*
   * 会员储值卡支付（第 4 轮 P1-9：储值模块建好了但收银台用不了，钱花不出去）
   *
   * 旧实现：收银台支付方式是硬编码 5 项（现金/微信/支付宝/银行卡/挂账），
   * 储值卡只能去 /members/wallet 单独操作，结账时用不上 ——
   * 酒店做「充 5000 送 800」，钱进得来花不出去，等于白送。
   *
   * 现在 method = "会员储值卡" 时，在**同一个事务内**：
   *   ① 账单 → 客人 → 会员，校验有绑定会员档案
   *   ② consumeWallet 扣余额（自带余额校验 + 流水 + 幂等）
   *   ③ 写 payments + paid_amount + recalcFolioBalance
   * 任一失败整体回滚，不会出现「钱扣了但没入账」或「入账了但没扣钱」。
   */
  const useWallet = method === "会员储值卡";
  /* 事务内要用的会员 id（提前查出来做友好提示，真正的校验在事务里再确认一次） */
  let walletMemberId: number | null = null;
  if (useWallet) {
    const g = get<{ guest_id: number | null }>(
      `SELECT guest_id FROM folios WHERE id = ? AND hotel_id = ?`,
      [folioId, user.hotelId]
    );
    if (!g?.guest_id) {
      return { error: "该账单没有关联会员档案，不能用储值卡支付。请先在会员里建档并绑定客人。" };
    }
    walletMemberId = g.guest_id;
    const bal = getWalletBalance(user.hotelId, walletMemberId);
    if (bal + 0.001 < amount) {
      return {
        error: `储值余额不足：当前 ${fmtMoney(bal)}，本次需要 ${fmtMoney(amount)}。请先充值或换其他支付方式。`,
      };
    }
  }

  try {
    tx(() => {
      /* 储值扣款（在事务内，失败会连带回滚后面的收款） */
      if (useWallet && walletMemberId) {
        const deducted = consumeWallet(user.hotelId, walletMemberId, amount, {
          requestId: requestId ?? undefined,
          remark: `结账收款 · 账单 ${folioId}`,
          refType: "folio",
          refId: folioId,
          operator: user.realName ?? user.username,
        });
        if ("error" in deducted) throw new Error(`储值扣款失败：${deducted.error}`);
      }

      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, operator)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folioId,
          stayId,
          nextPayNo(),
          method,
          amount,
          todayStr(),
          remark || "结账收款",
          nowIso(),
          requestId,
          user.realName ?? user.username,
        ]
      );
      /*
       * 收款后重算（第 4 轮 P0-1）
       *
       * 旧写法 `balance = total_amount - (paid_amount + ?)` 在 SQL 里手算，
       * 用的是库里的 total_amount —— 而建单时 total_amount 曾是押金（错误值），
       * 于是每收一次钱余额就差一个押金数。
       * 改为：只加 paid_amount，然后用统一口径 recalcFolioBalance 重算 total/balance。
       */
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) + ? WHERE id = ? AND hotel_id = ?`, [
        amount,
        folioId,
        user.hotelId,
      ]);
      recalcFolioBalance(user.hotelId, folioId);
    });
  } catch (e) {
    // 唯一索引冲突 = 并发下的重复提交，按幂等处理
    if (String(e instanceof Error ? e.message : e).includes("UNIQUE")) {
      return { ok: "该笔收款已入账（并发重复提交已忽略）" };
    }
    throw e;
  }

  revalidateCashier();
  return { ok: `已收款 ${fmtMoney(amount)}` };
}

/**
 * 退款：从某笔原收款里退钱
 *
 * 整改报告 P1-5：
 *   - 必须关联原 payment（refund_of）
 *   - 退款总额不能超过原收款金额
 *   - 单独权限 cashier.refund（前台不可退）
 *   - 写负数 payments 流水，余额回补
 */
export async function refundPaymentAction(formData: FormData): Promise<ActionState> {
  const user = await requirePermission("cashier.refund");
  const paymentId = numOf(formData, "payment_id");
  const amount = round2(numOf(formData, "amount"));
  const reason = str(formData, "reason");

  if (!paymentId) return { error: "请选择要退款的收款记录" };
  if (amount <= 0) return { error: "退款金额必须大于 0" };
  if (!reason) return { error: "请填写退款原因" };

  const pay = get<{ id: number; hotel_id: number; folio_id: number | null; stay_id: number | null; method: string; amount: number; refund_of: number | null }>(
    `SELECT id, hotel_id, folio_id, stay_id, method, amount, refund_of FROM payments
      WHERE id = ? AND hotel_id = ?`,
    [paymentId, user.hotelId]
  );
  if (!pay) return { error: "收款记录不存在" };
  if (pay.refund_of) return { error: "不能对退款流水再退款" };
  if (!pay.folio_id) return { error: "该收款没有关联账单，无法退款" };
  /* 收窄后的局部变量：闭包里 TS 不会保留 pay.folio_id 的非空推断 */
  const refundFolioId: number = pay.folio_id;

  /* 已退多少（按原收款流水累计） */
  const refunded =
    get<{ s: number }>(
      `SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM payments
        WHERE hotel_id = ? AND refund_of = ?`,
      [user.hotelId, pay.id]
    )?.s ?? 0;

  /*
   * 退款上限（第 4 轮 P0-3：原来只看「原收款金额」，可以超额退）
   *
   * 旧逻辑上限 = 原收款金额。但客人可能已经消费掉一部分 ——
   * 押金收 700、消费 656 时，实际只该退 44，旧逻辑允许退 700。
   * 退 700 后 paid_amount 变负、balance 变正数，等于酒店倒贴现金。
   *
   * 正确上限 = min(
   *     原收款金额 - 已退（这笔流水本身还能退多少）,
   *     本单应退金额（按统一口径重算：已收 - 应收）
   * )
   *
   * 「本单应退」必须用 recalcFolioBalance 算，不能用库里的 balance ——
   * balance 可能是历史脏数据（建单时押金算进应收留下的）。
   */
  const moneyBefore = recalcFolioBalance(user.hotelId, refundFolioId);
  const refundableByFolio = round2(Math.max(0, moneyBefore.paid - moneyBefore.total));
  const refundable = round2(
    Math.min(Number(pay.amount) - Number(refunded), refundableByFolio)
  );

  if (amount > refundable + 0.001) {
    return {
      error:
        `最多还能退 ${fmtMoney(refundable)}` +
        `（原收款 ${fmtMoney(pay.amount)}，已退 ${fmtMoney(refunded)}，` +
        `本单应退 ${fmtMoney(refundableByFolio)}）`,
    };
  }

  const folio = get<{ id: number; status: string }>(
    `SELECT id, status FROM folios WHERE id = ? AND hotel_id = ?`,
    [refundFolioId, user.hotelId]
  );
  if (!folio) return { error: "关联账单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") {
    return { error: "账单已结账，请先撤销结账再退款" };
  }

  try {
    tx(() => {
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          refundFolioId,
          pay.stay_id,
          nextPayNo(),
          pay.method,
          -Math.abs(amount), // 负数记账
          todayStr(),
          `退款：${reason}`,
          nowIso(),
          pay.id,
          user.realName ?? user.username,
        ]
      );
      /*
       * 退款后重算（第 4 轮 P0-1 + P0-3）
       *
       * 不再在 SQL 里手算 balance；只扣 paid_amount，再统一重算。
       *
       * 另外补两件旧实现漏掉的事（P0-3）：退款必须同步冲销押金口径，
       * 否则「退了钱但押金明细和 stays.deposit 还是原值」，账实不符。
       * 这两行只对 DEPOSIT 明细生效（没有押金时 UPDATE 影响 0 行，无副作用）。
       */
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [
        amount,
        refundFolioId,
        user.hotelId,
      ]);
      recalcFolioBalance(user.hotelId, refundFolioId);
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "退款失败" };
  }

  revalidateCashier();
  return { ok: `已退款 ${fmtMoney(amount)}（原因：${reason}）` };
}

/**
 * 预收款（押金）：单独收一笔押金
 * → folio_items 记 DEPOSIT 明细 + payments 流水 + folios.paid_amount 累加
 */
export async function addDepositAction(formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const folioId = numOf(formData, "folio_id");
  const stayId = numOf(formData, "stay_id");
  const amount = round2(numOf(formData, "amount"));
  const method = str(formData, "method") || "现金";
  const remark = str(formData, "remark");
  const bizDate = str(formData, "biz_date") || bizToday(user.hotelId);

  if (!folioId) return { error: "账务单不存在" };
  if (amount <= 0) return { error: "预收款金额必须大于 0" };

  const folio = loadFolioContext(folioId, user.hotelId);
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能再收预收款" };

  const desc = remark ? `预收款（${remark}）` : "预收款（押金）";

  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folioId, "DEPOSIT", desc, 1, amount, amount, bizDate, nowIso(), user.id]
    );
    run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, folioId, stayId || folio.stay_id, nextPayNo(), method, amount, bizDate, remark || "预收款", nowIso()]
    );
    run(`UPDATE folios SET paid_amount = paid_amount + ? WHERE id = ? AND hotel_id = ?`, [
      amount,
      folioId,
      user.hotelId,
    ]);
    if (stayId || folio.stay_id) {
      run(`UPDATE stays SET deposit = COALESCE(deposit, 0) + ? WHERE id = ? AND hotel_id = ?`, [
        amount,
        stayId || folio.stay_id,
        user.hotelId,
      ]);
    }
    recalcFolioBalance(user.hotelId, folioId);
    writeLog(
      user.hotelId,
      user.realName,
      "预收款",
      `入住单 ${folio.stay_no} · 账单 ${folio.folio_no} · 房间 ${folio.room_no} · 方式 ${method} · 金额 ${fmtMoney(amount)}`
    );
  });
  revalidateCashier();
  return { ok: `已收预收款 ${fmtMoney(amount)}` };
}

/**
 * 部分结账：先结一部分，余额保留
 * → payments 记收款流水 + folio_items 记 ADJUST 负项（已结记录）
 */
export async function partialSettleAction(formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const folioId = numOf(formData, "folio_id");
  const amount = round2(numOf(formData, "amount"));
  const method = str(formData, "method") || "现金";
  const remark = str(formData, "remark");

  if (!folioId) return { error: "账务单不存在" };
  if (amount <= 0) return { error: "结账金额必须大于 0" };

  const folio = loadFolioContext(folioId, user.hotelId);
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，请先撤销结账" };

  const balance = round2(Number(folio.balance ?? 0));
  if (balance <= 0.01) return { error: "当前账单没有应收余额，无需部分结账" };
  if (amount > balance + 0.001) return { error: `结账金额不能超过应收余额 ${fmtMoney(balance)}` };

  tx(() => {
    run(
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        user.hotelId,
        folioId,
        folio.stay_id,
        nextPayNo(),
        method,
        amount,
        todayStr(),
        remark || "部分结账",
        nowIso(),
      ]
    );
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        user.hotelId,
        folioId,
        "ADJUST",
        `${PARTIAL_SETTLE_PREFIX}${method} 结账`,
        1,
        -amount,
        -amount,
        todayStr(),
        nowIso(),
        user.id,
      ]
    );
    run(`UPDATE folios SET paid_amount = paid_amount + ? WHERE id = ? AND hotel_id = ?`, [
      amount,
      folioId,
      user.hotelId,
    ]);
    recalcFolioBalance(user.hotelId, folioId);
    writeLog(
      user.hotelId,
      user.realName,
      "部分结账",
      `入住单 ${folio.stay_no} · 账单 ${folio.folio_no} · 房间 ${folio.room_no} · 方式 ${method} · 金额 ${fmtMoney(amount)}`
    );
  });
  revalidateCashier();
  return { ok: `已部分结账 ${fmtMoney(amount)}，余额保留` };
}

/**
 * 挂账：把账单余额挂到协议单位
 *
 * 整改报告第 5 节要求：挂账必须检查协议单位信用额度。
 * 规则：
 *   1. credit_limit 为 0 / 空 → 视为「不限额」，放行（老数据兼容）
 *   2. 已挂账金额 = 该单位所有在住 + 已挂账未结的余额合计
 *   3. 本次挂账后超过额度 → 拒绝，并告知剩余可用额度
 */
export async function chargeToCompanyAction(formData: FormData): Promise<ActionState> {
  const user = await requirePermission("cashier.charge_company");
  const folioId = numOf(formData, "folio_id");
  const stayId = numOf(formData, "stay_id");
  const companyId = numOf(formData, "company_id");

  if (!folioId || !stayId) return { error: "入住信息不完整，请重新选择客人" };
  const company = companyId
    ? get<{ id: number; name: string; credit_limit: number | null }>(
        `SELECT id, name, COALESCE(credit_limit, 0) AS credit_limit
           FROM companies WHERE id = ? AND hotel_id = ?`,
        [companyId, user.hotelId]
      )
    : undefined;
  if (!company) return { error: "请选择协议单位" };

  const folio = loadFolioContext(folioId, user.hotelId);
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能再挂账" };

  const stay = get<{ id: number; stay_no: string; remark: string | null; room_no: string }>(
    `SELECT s.id, s.stay_no, s.remark, r.room_no
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.id = ? AND s.hotel_id = ?`,
    [stayId, user.hotelId]
  );
  if (!stay) return { error: "入住单不存在" };

  const balance = round2(Number(folio.balance ?? 0));
  if (balance <= 0.01) return { error: "当前账单没有应收余额，无需挂账" };

  /* ---------- 信用额度检查（P1-5：改查 AR 台账，不再用备注 LIKE 估算） ---------- */
  const limit = round2(Number(company.credit_limit ?? 0));
  if (limit > 0) {
    /*
     * 已挂账 = 该协议单位 ar_ledgers 里的未结余额。
     * 旧口径 `stays.remark LIKE '%【挂账】公司名%'` 有两个毛病：
     *   1. 备注被人改了额度就失准
     *   2. 账根本没进 AR 台账，财务看不到应收
     */
    const usedR = getCompanyOutstanding(user.hotelId, company.id);
    const available = round2(limit - usedR);
    if (balance > available + 0.001) {
      return {
        error: `${company.name} 信用额度不足：额度 ${fmtMoney(limit)}，已挂账 ${fmtMoney(
          usedR
        )}，可用 ${fmtMoney(available)}，本次需 ${fmtMoney(balance)}`,
      };
    }
  }

  try {
    tx(() => {
      run(`UPDATE stays SET remark = ? WHERE id = ? AND hotel_id = ?`, [
        withCreditMark(stay.remark, company.name),
        stayId,
        user.hotelId,
      ]);

      /* P1-5：挂账落 AR 台账。postArCharge 内部用 SAVEPOINT，嵌在本事务里安全；
         同账单+同金额的重复提交会返回原 id，不会重复记应收。 */
      const posted = postArCharge(user.hotelId, {
        companyId: company.id,
        folioId,
        folioNo: folio.folio_no,
        amount: balance,
        bizDate: bizToday(user.hotelId),
        dueDays: 30,
        operator: user.realName,
        remark: `入住单 ${folio.stay_no} · 房间 ${stay.room_no} · 协议单位 ${company.name}`,
      });
      if (!("ok" in posted)) throw new Error(`挂账台账写入失败：${posted.error}`);

      /*
       * 核销账单（第 4 轮 P0-4：旧实现只改备注，同一笔钱能收两次）
       *
       * 旧实现挂账后只 `UPDATE stays SET remark`，folios 的 balance 一概不动，后果：
       *   ① 收银台「收款」按钮照常可用 → 挂给公司的钱还能再向客人收一次
       *   ② /finance 的应收列表（WHERE status='OPEN' AND balance>0）把它算成酒店应收，
       *      与 ar_ledgers 台账双重记账
       *   ③ checkoutAction 要求 balance<=0.01 → 挂账单永远退不了房
       *
       * 现在：balance 归 0（对客人不再是应收，钱在公司那里），
       * status 置 CHARGED（标记来源，前台和报表能区分「挂账结清」与「现金结清」）。
       * paid_amount 不动 —— 钱确实没收到，不能虚增已收。
       */
      run(
        `UPDATE folios
            SET balance = 0, status = 'CHARGED', settled_at = ?
          WHERE id = ? AND hotel_id = ?`,
        [nowIso(), folioId, user.hotelId]
      );

      writeLog(
        user.hotelId,
        user.realName,
        "挂账",
        `入住单 ${folio.stay_no} · 账单 ${folio.folio_no} · 房间 ${stay.room_no} · 协议单位 ${company.name} · 挂账金额 ${fmtMoney(balance)}${
          limit > 0 ? ` · 额度 ${fmtMoney(limit)}` : ""
        } · AR 台账 #${posted.id}`
      );
    });
  } catch (e) {
    /* 台账写入失败（如单位不存在）→ 整个事务回滚，把原因转成表单提示而不是 500 */
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("挂账台账写入失败")) return { error: msg };
    throw e;
  }
  revalidateCashier();
  revalidatePath("/ar");
  return {
    ok: `已挂账到 ${company.name}${
      limit > 0 ? `（本次 ${fmtMoney(balance)}，额度 ${fmtMoney(limit)}）` : ""
    }`,
  };
}

/** 转账：把当前账单的部分金额转到另一个在住账单 */
export async function transferAction(formData: FormData): Promise<ActionState> {
  // 权限边界（上线前加固）：账单转账涉及两个账单的金额搬移，原来只校验登录
  const user = await requirePermission("cashier.transfer");
  const fromFolioId = numOf(formData, "folio_id");
  const targetFolioId = numOf(formData, "target_folio_id");
  const amount = round2(numOf(formData, "amount"));
  const remark = str(formData, "remark");

  if (!fromFolioId || !targetFolioId) return { error: "请选择转入账单" };
  if (fromFolioId === targetFolioId) return { error: "不能转入当前账单，请选择其他房间" };
  if (amount <= 0) return { error: "转账金额必须大于 0" };

  const from = loadFolioContext(fromFolioId, user.hotelId);
  if (!from) return { error: "账务单不存在" };
  if (from.status === "SETTLED" || from.status === "CHARGED") return { error: "当前账单已结账，不能转账" };
  const fromBalance = round2(Number(from.balance ?? 0));
  if (fromBalance <= 0.01) return { error: "当前账单没有应收余额，无需转账" };
  if (amount > fromBalance + 0.001) return { error: `转账金额不能超过应收余额 ${fmtMoney(fromBalance)}` };

  const target = loadFolioContext(targetFolioId, user.hotelId);
  if (!target) return { error: "转入账单不存在" };
  if (target.status === "SETTLED" || target.status === "CHARGED") return { error: "转入账单已结账，不能接收转账" };

  const desc = remark ? `｜${remark}` : "";
  tx(() => {
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        user.hotelId,
        fromFolioId,
        "ADJUST",
        `【转出】转至 ${target.room_no} ${target.guest_name}${desc}`,
        1,
        -amount,
        -amount,
        todayStr(),
        nowIso(),
        user.id,
      ]
    );
    run(
      `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        user.hotelId,
        targetFolioId,
        "ADJUST",
        `【转入】来自 ${from.room_no} ${from.guest_name}${desc}`,
        1,
        amount,
        amount,
        todayStr(),
        nowIso(),
        user.id,
      ]
    );
    recalcFolioBalance(user.hotelId, fromFolioId);
    recalcFolioBalance(user.hotelId, targetFolioId);
    writeLog(
      user.hotelId,
      user.realName,
      "转账",
      `入住单 ${from.stay_no} · 账单 ${from.folio_no} → ${target.room_no}（${target.stay_no} / ${target.folio_no}）· 金额 ${fmtMoney(amount)}`
    );
  });
  revalidateCashier();
  return { ok: `已转账 ${fmtMoney(amount)} 到 ${target.room_no}` };
}

/**
 * 开发票（整改 P2-3）：抬头 + 税号 + 金额 → 写发票台账 invoices。
 *
 * 改造前：只往 op_logs 写一段文本，开票记录不可查、不能红冲，也不校验「已结账 / 不超应收」。
 * 现在：真正的台账写入交给 src/lib/invoice.ts 的 issueInvoice —— 账单归属、账单必须
 * SETTLED、开票金额不超过「账单总额 - 已开票净额」都在那里校验，失败文案原样返回给面板。
 * 唯一保留的旧行为是 op_logs 仍写一条「开发票」日志：/cashier 的「已开发票」汇总
 * 与 /logs 页面都按 action='开发票' 读日志，动它会连带打断别的页面。
 */
export async function invoiceAction(formData: FormData): Promise<ActionState> {
  // 权限边界（上线前加固）：开票受财务权限约束（与收款同组），原来只校验登录
  const user = await requirePermission("cashier.receive");
  const folioId = numOf(formData, "folio_id");
  const title = str(formData, "title");
  const taxNo = str(formData, "tax_no");
  const amount = round2(numOf(formData, "amount"));
  const remark = str(formData, "remark");

  if (!folioId) return { error: "账务单不存在" };

  const folio = loadFolioContext(folioId, user.hotelId);
  if (!folio) return { error: "账务单不存在" };

  // 未结账 / 超开 / 抬头或金额不合法，都在 service 内返回可读文案
  const result = issueInvoice({
    hotelId: user.hotelId,
    title,
    taxNo,
    amount,
    folioId,
    stayId: folio.stay_id,
    guestName: folio.guest_name,
    roomNo: folio.room_no,
    // bizDate 不传：由 service 按酒店营业日切点取当前营业日
    operator: user.realName,
    remark,
  });
  if ("error" in result) return { error: result.error };

  // 操作日志保留旧格式（含「入住单 X」「金额 ¥Y」），供收银台汇总与日志页解析
  writeLog(
    user.hotelId,
    user.realName,
    "开发票",
    `开票 · 发票号 ${result.invoiceNo} · 入住单 ${folio.stay_no} · 账单 ${folio.folio_no} · 房间 ${
      folio.room_no
    } · 抬头 ${title} · 税号 ${taxNo || "—"} · 金额 ${fmtMoney(amount)}${remark ? ` · ${remark}` : ""}`
  );
  revalidateCashier();
  revalidatePath("/invoices");
  return { ok: `已开具发票 ${result.invoiceNo}，金额 ${fmtMoney(amount)}` };
}

/**
 * 撤销结账：已退房账单 → 账单 OPEN / 入住单 INHOUSE / 房间 OC / 清除 actual_check_out
 */
export async function reverseCheckoutAction(formData: FormData): Promise<ActionState> {
  // 撤结账是高危操作：独立权限 + 必须填写原因
  const user = await requirePermission("cashier.reverse_checkout");
  const stayId = numOf(formData, "stay_id");
  const folioId = numOf(formData, "folio_id");
  const reason = str(formData, "reason");
  if (!stayId || !folioId) return { error: "入住信息不完整，请重新选择客人" };
  if (!reason) return { error: "请填写撤销结账的原因" };

  const row = get<{
    folio_status: string;
    folio_no: string;
    stay_status: string;
    stay_no: string;
    room_id: number;
    room_no: string;
    room_status: string;
    guest_name: string;
  }>(
    `SELECT f.status AS folio_status, f.folio_no, s.status AS stay_status, s.stay_no,
            s.room_id, r.room_no, r.status AS room_status, s.guest_name
       FROM folios f
       JOIN stays s ON s.id = f.stay_id
       JOIN rooms r ON r.id = s.room_id
      WHERE f.id = ? AND s.id = ? AND f.hotel_id = ?`,
    [folioId, stayId, user.hotelId]
  );
  if (!row) return { error: "该账单不存在" };
  if (row.folio_status !== "SETTLED") return { error: "仅已结账（已退房）的账单可以撤销结账" };

  tx(() => {
    run(`UPDATE folios SET status = 'OPEN', settled_at = NULL WHERE id = ? AND hotel_id = ?`, [
      folioId,
      user.hotelId,
    ]);
    run(`UPDATE stays SET status = 'INHOUSE', actual_check_out = NULL WHERE id = ? AND hotel_id = ?`, [
      stayId,
      user.hotelId,
    ]);
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId: row.room_id,
      to: "OC",
      operator: user.realName,
      reason: `撤销结账（${row.guest_name}）`,
      source: { kind: "checkin", stayId, stayNo: row.stay_no },
    });
    writeLog(
      user.hotelId,
      user.realName,
      "撤销结账",
      `入住单 ${row.stay_no} · 账单 ${row.folio_no} · 房间 ${row.room_no} · 账单恢复 OPEN，房间恢复在住`
    );
  });
  revalidateCashier();
  revalidateRooms();
  return { ok: "已撤销结账，账单恢复为未结，房间恢复在住" };
}

/** 是否为合法 YYYY-MM-DD 日期串 */
function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

/** 两个 YYYY-MM-DD 之间相差的天数（b - a） */
function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00`).getTime();
  const tb = new Date(`${b}T00:00:00`).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/**
 * 延迟退房：把预计离店日期顺延到更晚的日期，同步入住晚数
 */
export async function delayCheckoutAction(formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const stayId = numOf(formData, "stay_id");
  const newDate = str(formData, "new_date");

  if (!stayId) return { error: "入住信息不完整，请重新选择客人" };
  if (!isYmd(newDate)) return { error: "请选择新的离店日期" };

  const stay = get<{
    id: number;
    stay_no: string;
    status: string;
    guest_name: string;
    expect_check_out: string | null;
    nights: number | null;
    room_no: string;
  }>(
    `SELECT s.id, s.stay_no, s.status, s.guest_name, s.expect_check_out, s.nights, r.room_no
       FROM stays s JOIN rooms r ON r.id = s.room_id
      WHERE s.id = ? AND s.hotel_id = ?`,
    [stayId, user.hotelId]
  );
  if (!stay) return { error: "入住单不存在" };
  if (stay.status !== "INHOUSE") return { error: "只有当前在住的客人才可以延迟退房" };

  const today = todayStr();
  if (newDate < today) return { error: "新的离店日期不能早于今天" };
  if (stay.expect_check_out && newDate <= stay.expect_check_out) {
    return { error: `新的离店日期需晚于当前预计离店日期 ${stay.expect_check_out}` };
  }

  const oldExpect = stay.expect_check_out ?? newDate;
  const extra = Math.max(0, daysBetween(oldExpect, newDate));
  const nights = Math.max(1, Math.trunc(Number(stay.nights ?? 1)) + extra);

  tx(() => {
    run(`UPDATE stays SET expect_check_out = ?, nights = ? WHERE id = ? AND hotel_id = ?`, [
      newDate,
      nights,
      stayId,
      user.hotelId,
    ]);
    writeLog(
      user.hotelId,
      user.realName,
      "延迟退房",
      `入住单 ${stay.stay_no} · 房间 ${stay.room_no} · ${stay.guest_name} · 离店 ${stay.expect_check_out ?? "-"} → ${newDate} · 共 ${nights} 晚`
    );
  });
  revalidateCashier();
  revalidateRooms();
  return { ok: `已将离店日期延至 ${newDate}（共 ${nights} 晚）` };
}

/**
 * 重新入住：已退房账单重新开房
 * → 账单 OPEN（清 settled_at）/ 入住单 INHOUSE（清 actual_check_out）/ 房间 OC
 */
export async function reopenStayAction(formData: FormData): Promise<ActionState> {
  // 权限边界（上线前加固）：重新入住等同于撤销退房，仅 admin 可执行，原来只校验登录
  const user = await requirePermission("cashier.reverse_checkout");
  const stayId = numOf(formData, "stay_id");
  const folioId = numOf(formData, "folio_id");
  if (!stayId) return { error: "入住信息不完整，请重新选择客人" };

  const row = get<{
    folio_id: number;
    folio_status: string;
    folio_no: string;
    stay_status: string;
    stay_no: string;
    room_id: number;
    room_no: string;
    room_status: string;
    guest_name: string;
  }>(
    `SELECT f.id AS folio_id, f.status AS folio_status, f.folio_no,
            s.status AS stay_status, s.stay_no, s.room_id, r.room_no, r.status AS room_status, s.guest_name
       FROM folios f
       JOIN stays s ON s.id = f.stay_id
       JOIN rooms r ON r.id = s.room_id
      WHERE s.id = ? AND f.hotel_id = ? ${folioId ? "AND f.id = ?" : ""}
      ORDER BY f.id DESC
      LIMIT 1`,
    folioId ? [stayId, user.hotelId, folioId] : [stayId, user.hotelId]
  );
  if (!row) return { error: "该入住单暂无账单，无法重新入住" };
  if (row.stay_status === "INHOUSE") return { error: "该客人仍在住，无需重新入住" };

  const occupied = get<{ id: number }>(
    `SELECT id FROM stays WHERE hotel_id = ? AND room_id = ? AND status = 'INHOUSE' AND id <> ? LIMIT 1`,
    [user.hotelId, row.room_id, stayId]
  );
  if (occupied) return { error: `房间 ${row.room_no} 已有其他在住客人，请先换房` };

  tx(() => {
    run(`UPDATE folios SET status = 'OPEN', settled_at = NULL WHERE id = ? AND hotel_id = ?`, [
      row.folio_id,
      user.hotelId,
    ]);
    run(`UPDATE stays SET status = 'INHOUSE', actual_check_out = NULL WHERE id = ? AND hotel_id = ?`, [
      stayId,
      user.hotelId,
    ]);
    changeRoomStatus({
      hotelId: user.hotelId,
      roomId: row.room_id,
      to: "OC",
      operator: user.realName,
      reason: `重新入住（${row.guest_name}）`,
      source: { kind: "checkin", stayId, stayNo: row.stay_no },
    });
    writeLog(
      user.hotelId,
      user.realName,
      "重新入住",
      `入住单 ${row.stay_no} · 账单 ${row.folio_no} · 房间 ${row.room_no} · 账单恢复 OPEN，房间恢复在住`
    );
  });
  revalidateCashier();
  revalidateRooms();
  return { ok: "已重新入住，账单恢复为未结，房间恢复在住" };
}

/** 结账退房：补收 → 核销账单 → 退房 → 房态 VD → 打扫任务 */
export async function checkoutAction(formData: FormData): Promise<ActionState> {
  // 权限边界（上线前加固）：结账退房同时改钱和房态，必须校验 cashier.checkout，原来只校验登录
  const user = await requirePermission("cashier.checkout");
  const stayId = numOf(formData, "stay_id");
  const roomId = numOf(formData, "room_id");
  const folioId = numOf(formData, "folio_id");
  const payMethod = str(formData, "pay_method") || "现金";
  const payAmount = round2(numOf(formData, "pay_amount"));

  if (!stayId || !roomId || !folioId) return { error: "入住信息不完整，请重新选择客人" };

  const folio = get<{ id: number; status: string; stay_id: number | null; folio_no: string }>(
    `SELECT id, status, stay_id, folio_no FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, user.hotelId]
  );
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，无需重复退房" };

  const stay = get<{
    id: number;
    status: string;
    guest_name: string | null;
    stay_no: string;
    channel_order_no: string | null;
  }>(
    /* 第 4 轮 P1-20：退房要回传渠道，需要渠道单号 */
    `SELECT id, status, guest_name, stay_no, channel_order_no FROM stays WHERE id = ? AND hotel_id = ?`,
    [stayId, user.hotelId]
  );
  if (!stay) return { error: "入住单不存在" };
  if (stay.status !== "INHOUSE") return { error: "该客人已退房" };

  const room = get<{ status: string; room_no: string }>(
    `SELECT status, room_no FROM rooms WHERE id = ? AND hotel_id = ?`,
    [roomId, user.hotelId]
  );
  if (!room) return { error: "房间不存在" };

  let result: { error: string } | { ok: string };
  try {
    result = tx((): { error: string } | { ok: string } => {
    // 1. 补收（第 4 轮 P0-1：只加 paid_amount，余额交给 recalcFolioBalance 统一算）
    if (payAmount > 0) {
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folioId,
          stayId,
          nextPayNo(),
          payMethod,
          payAmount,
          todayStr(),
          "退房补收",
          nowIso(),
          user.realName ?? user.username,
        ]
      );
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) + ? WHERE id = ? AND hotel_id = ?`, [
        payAmount,
        folioId,
        user.hotelId,
      ]);
    }

    // 2. 重算并校验余额（补收不足时已收金额保留，页面刷新后按最新余额继续补收）
    const money = recalcFolioBalance(user.hotelId, folioId);
    if (money.balance > 0.01) {
      return { error: `仍有欠款 ${fmtMoney(money.balance)}，请补收后再结账` };
    }

    /*
     * 2b. 退房时自动退还押金（第 4 轮 P0-2：原来提示与守卫互相矛盾，死锁）
     *
     * 旧实现：退房时只提示「有应退押金，请去退款」，
     * 但置 SETTLED 之后 refundPaymentAction 会以「账单已结账」拒绝退款 ——
     * 前台按提示操作必然被拒，唯一出路是「撤销结账」，
     * 而撤销结账会把已离店客人改回 INHOUSE、房间改回 OC（人离店了却被复活）。
     *
     * 现在：在置 SETTLED **之前**，同事务内把押金退掉：
     *   ① 写负数收款流水（refund_of 指向押金那笔，method 同原方式）
     *   ② 冲销 DEPOSIT 明细（押金不再挂账）
     *   ③ 减 stays.deposit
     *   ④ 减 folios.paid_amount，recalcFolioBalance 重算
     * 退完 balance 归 0，账单才能真正「已结清」。
     *
     * 退款金额取 min(应退余额, 该账单还挂着的押金) ——
     * 防止「部分结账后负余额里的非押金部分」被当成押金退掉。
     */
    const refundDue = money.balance < -0.01 ? round2(-money.balance) : 0;
    /* 该账单当前还挂着的押金总额（明细口径） */
    const depositOnFolio = round2(
      get<{ t: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM folio_items
          WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
        [folioId, user.hotelId]
      )?.t ?? 0
    );
    const refundCash = round2(Math.min(refundDue, Math.max(0, depositOnFolio)));

    if (refundCash > 0) {
      /* ① 找押金那笔原始收款（refund_of 要指向它，便于对账） */
      const depositPay = get<{ id: number; method: string }>(
        `SELECT id, method FROM payments
          WHERE folio_id = ? AND hotel_id = ? AND amount > 0 AND remark LIKE '%押金%'
          ORDER BY id LIMIT 1`,
        [folioId, user.hotelId]
      );
      run(
        `INSERT INTO payments
           (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, operator)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folioId,
          stayId,
          nextPayNo(),
          depositPay?.method ?? "现金",
          -Math.abs(refundCash),
          todayStr(),
          "退房退还押金",
          nowIso(),
          depositPay?.id ?? null,
          user.realName ?? user.username,
        ]
      );
      /* ② 冲销押金明细 */
      run(
        `UPDATE folio_items SET amount = amount - ?
          WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
        [refundCash, folioId, user.hotelId]
      );
      /* ③ 减入住单押金 */
      run(`UPDATE stays SET deposit = COALESCE(deposit, 0) - ? WHERE id = ? AND hotel_id = ?`, [
        refundCash,
        stayId,
        user.hotelId,
      ]);
      /* ④ 减已收并重算 */
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [
        refundCash,
        folioId,
        user.hotelId,
      ]);
      recalcFolioBalance(user.hotelId, folioId);
      writeLog(
        user.hotelId,
        user.realName,
        "退房退还押金",
        `入住单 ${stay.stay_no} · 账单 ${folio.folio_no} · 退还 ${fmtMoney(refundCash)}（${depositPay?.method ?? "现金"}）`
      );
    }

    // 3. 核销账单
    run(`UPDATE folios SET status = 'SETTLED', settled_at = ? WHERE id = ? AND hotel_id = ?`, [
      nowIso(),
      folioId,
      user.hotelId,
    ]);

    // 4. 退房
    run(`UPDATE stays SET status = 'CHECKED_OUT', actual_check_out = ? WHERE id = ? AND hotel_id = ?`, [
      todayStr(),
      stayId,
      user.hotelId,
    ]);

    /*
     * 5. 房态 OC/OD → VD（走统一房态服务）
     *
     * 返回值必须检查：如果流转被拒（历史上 OC→VD 就漏在允许表里），
     * 退房会「账单已结、入住单已退、房态没变」，房间被长期占用。
     * 这种情况要直接抛错回滚整个事务，让前台看到明确原因。
     */
    const roomChange = changeRoomStatus({
      hotelId: user.hotelId,
      roomId,
      to: "VD",
      operator: user.realName,
      reason: "结账退房",
      source: { kind: "checkout", stayId, stayNo: stay.stay_no },
    });
    if (!roomChange.ok) {
      throw new Error(`房态变更失败：${roomChange.error}`);
    }

    // 6. 生成打扫任务（P2-5：指派本店在岗客房人员，无人在岗则写「待分配」）
    run(
      `INSERT INTO housekeeping (hotel_id, room_id, task_type, status, assignee, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [user.hotelId, roomId, "打扫", "PENDING", pickHousekeepingAssignee(user.hotelId), "退房打扫", nowIso()]
    );

    // 7. 操作日志
    writeLog(
      user.hotelId,
      user.realName,
      "结账退房",
      `入住单 ${stay.stay_no} · 账单 ${folio.folio_no} · 房间 ${room.room_no} · 补收 ${fmtMoney(payAmount)}（${payMethod}）` +
        (refundDue > 0 ? ` · **应退押金 ${fmtMoney(refundDue)}**` : "")
    );

    /*
     * 应退押金要明确告诉前台 —— 不能只写日志了事。
     * 客人在前台等着，系统不提示「还有 600 要退」，这钱就留下了。
     */
    return {
      ok:
        refundCash > 0
          ? `退房成功，已退还押金 ${fmtMoney(refundCash)}` + (refundDue > refundCash ? `（另有 ${fmtMoney(refundDue - refundCash)} 需人工核对）` : "")
          : "结账退房成功",
    };
    });
  } catch (e) {
    /*
     * 事务内抛错（房态流转被拒、并发冲突等）→ 整个退房回滚，
     * 把原因原样返回，不留下「账单已结但房态没变」的脏数据。
     */
    const msg = e instanceof Error ? e.message : String(e);
    revalidatePath("/cashier");
    revalidatePath("/rooms");
    return { error: msg.startsWith("房态变更失败") ? msg : `退房失败：${msg}` };
  }

  if ("error" in result) {
    // 补收已入账但仍有欠款：刷新页面，让汇总与补收金额同步最新余额
    revalidatePath("/cashier");
    return result;
  }

  /*
   * 第 4 轮 P1-20：退房回传渠道（CHECKED_OUT）
   *
   * 放在事务外、redirect 之前：渠道推送要走网络（可能几秒），
   * 放进事务会长时间持有写锁，而且渠道失败不该回滚退房。
   * pushOrderStatusForChannelOrder 自带日志与失败留痕，返回结果不抛异常。
   */
  if (stay.channel_order_no) {
    await pushOrderStatusForChannelOrder({
      hotelId: user.hotelId,
      channelOrderNo: stay.channel_order_no,
      status: "CHECKED_OUT",
      operator: user.realName,
      source: "cashier-checkout",
    });
  }

  revalidatePath("/rooms");
  revalidatePath("/inhouse");
  revalidatePath("/cashier");
  revalidatePath("/dashboard");
  revalidatePath("/housekeeping");
  revalidatePath("/logs");
  redirect("/cashier");
}
