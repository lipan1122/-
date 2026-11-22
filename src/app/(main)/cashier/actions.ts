"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { requirePermissionOrRedirect, requireUser } from "@/lib/session";
import { changeRoomStatus } from "@/lib/room-status";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";
import {
  NON_REVENUE_ITEM,
  depositHeld,
  ensurePaymentKindSchema,
  findDepositPayment,
  isDepositPayment,
  recalcFolioBalance,
  refundKindOf,
} from "@/lib/folio";
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

/* ------------------------------------------------------------------ *
 * 收银台幂等键（第十轮 P1：4 个写动作补 request_id）
 *
 * ── 缺陷 ──
 * 收银台只有 addPaymentAction 读 request_id：checkoutAction（退房补收 / 退押金流水）、
 * refundPaymentAction（退款流水）、addDepositAction（押金明细 + 收款流水）、
 * addChargeAction（入账明细）全部没有这个参数。
 * 而 payments / folio_items 上早就建好了
 * `UNIQUE(hotel_id, request_id) WHERE request_id IS NOT NULL` 的部分唯一索引 ——
 * 因为这 4 个动作从来不写该列，唯一索引一直是空转的死约束：
 *   · 双击「确认收取预收款」→ 押金收两笔、stays.deposit 翻倍；
 *   · 双击「退款」→ 钱退两次、余额多冲一次；
 *   · 双击「确认退房」→ 补收流水两笔（第二笔一般被「已结账」拦住，但补收已入账）；
 *   · 双击「确认入账」→ 同一笔消费记两遍。
 *
 * ── 修复（与 rooms/actions.ts 第九轮那套完全同款，字段名统一 request_id）──
 *   ① 客户端 src/components/CashierPanel.tsx 为**每个操作各持一枚** request_id，
 *      隐藏字段提交；换账单 / 换客人时整组换新，成功后才换新；
 *   ② 服务端每个写动作先按 (hotel_id, request_id) 查重，命中即按「幂等重放」
 *      返回成功（不再重复入账，也不重复写 op_logs —— 重放在进事务前就返回了）；
 *   ③ 并发下两次都通过查重时，后到的撞唯一索引 → catch 里同样按重放返回，
 *      整个事务已回滚，不会多出一笔。
 * ------------------------------------------------------------------ */

/** 只认 `request_id` 这个字段名（与 rooms/actions.ts、ShopPOS 一致） */
function readRequestId(formData: FormData): string | null {
  const id = str(formData, "request_id");
  return id ? id : null;
}

/** 唯一约束冲突判定：查重之后仍被抢写时走幂等分支，其它错误继续抛 */
function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(e instanceof Error ? e.message : e));
}

/** 收款流水的幂等查重（押金 / 退款 / 退房补收共用） */
function receivedPayment(hotelId: number, requestId: string | null) {
  if (!requestId) return undefined;
  return get<{ id: number; folio_id: number | null; amount: number }>(
    `SELECT id, folio_id, amount FROM payments WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
    [hotelId, requestId]
  );
}

/** 明细类（入账 / 加收房费）的幂等查重 */
function postedFolioItem(hotelId: number, requestId: string | null) {
  if (!requestId) return undefined;
  return get<{ id: number; folio_id: number | null; item_type: string; amount: number }>(
    `SELECT id, folio_id, item_type, amount FROM folio_items
      WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
    [hotelId, requestId]
  );
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
  const user = await requirePermissionOrRedirect("cashier.split");
  /* 拆账会复制收款流水的 kind（第九轮 P1-2），老库先兜底补列 */
  ensurePaymentKindSchema();
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
      const pays = all<{ id: number; amount: number; kind: string | null }>(
        `SELECT id, amount, kind FROM payments WHERE hotel_id = ? AND folio_id = ? AND amount > 0 ORDER BY id`,
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
            `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
              /* 拆账只是挪账，性质跟随原收款（押金仍然是押金） */
              p.kind ?? null,
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
  const user = await requirePermissionOrRedirect("cashier.receive");
  const folioId = numOf(formData, "folio_id");
  const rawType = str(formData, "item_type") || "OTHER";
  const itemType = rawType === "ROOM" || rawType === "FOOD" || rawType === "OTHER" ? rawType : "OTHER";
  const description = str(formData, "description");
  const qty = numOf(formData, "qty", 1);
  const price = numOf(formData, "price");
  const bizDate = str(formData, "biz_date") || bizToday(user.hotelId);
  /* 第十轮 P1：入账幂等键（明细落 folio_items.request_id，唯一索引兜底） */
  const requestId = readRequestId(formData);

  if (!folioId) return { error: "账务单不存在" };
  if (qty <= 0) return { error: "数量必须大于 0" };
  if (price < 0) return { error: "单价不能为负数" };

  /*
   * 幂等重放要放在「账单状态」校验之前：
   * 双击提交时第一笔已入账成功、随后收银台又退了房，第二次提交若先校验状态，
   * 前台看到的会是「该账单已结账」这句报错，而不是「已入账（重复提交已忽略）」。
   */
  const replayed = postedFolioItem(user.hotelId, requestId);
  if (replayed) {
    return { ok: `该笔入账已记账 ${fmtMoney(Number(replayed.amount))}（重复提交已忽略）` };
  }

  const folio = get<{ id: number; status: string }>(
    `SELECT id, status FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, user.hotelId]
  );
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能再入账" };

  const amount = round2(qty * price);
  const desc =
    description || (itemType === "ROOM" ? `房费 ${bizDate}` : itemType === "FOOD" ? "餐饮消费" : "其他消费");

  try {
    tx(() => {
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by, request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [user.hotelId, folioId, itemType, desc, qty, price, amount, bizDate, nowIso(), user.id, requestId]
      );
      recalcFolioBalance(user.hotelId, folioId);
    });
  } catch (e) {
    /* 并发双击：两次都通过查重，后到的撞 folio_items 唯一索引；事务已整体回滚 */
    if (isUniqueViolation(e)) return { ok: "该笔入账已记账（并发重复提交已忽略）" };
    throw e;
  }
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
  const user = await requirePermissionOrRedirect("cashier.receive");
  /* 第九轮 P1-2：收款要写结构化性质 kind，老库先兜底补列 */
  ensurePaymentKindSchema();
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
    /*
     * 会员 id 从「账单 → 入住单 → 客人」拿，**不是**从 folios 拿
     *
     * ⚠️ 这里原来写的是 `SELECT guest_id FROM folios WHERE id = ?`，
     *    但 `folios` 表**没有 guest_id 列**（只有 stay_id / guest_name / room_no）。
     *    于是任何一次「会员储值卡」支付都会抛：
     *        no such column: guest_id
     *    → 客人充进储值的钱**一分都花不出去**（收银台收不了，只有
     *      /members/wallet 页面的「消费」能花，而结账场景用不上）。
     *
     * 为什么一直没被发现：`scripts/check-round4-coverage.mjs` 对 P1-9 的两条断言
     * 只是 `includes("会员储值卡")` / `includes("consumeWallet")` 的**字符串 grep**，
     * 从来没有真正跑过一次储值卡支付 —— 静态自查把 100% 崩溃的路径判成了「已落地」。
     *
     * 修法：改用 `folios.stay_id → stays.guest_id` 的 join，不改表结构
     * （folios 是账单，账单本身不该冗余客人 id；客人属于入住单）。
     */
    const g = get<{ guest_id: number | null }>(
      `SELECT s.guest_id AS guest_id
         FROM folios f
         LEFT JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
        WHERE f.id = ? AND f.hotel_id = ?`,
      [folioId, user.hotelId]
    );
    if (!g?.guest_id) {
      return {
        error:
          "该账单没有关联会员档案，不能用储值卡支付。请先在会员里建档并绑定客人（或确认这张账单关联的入住单有 guest_id）。",
      };
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
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          /* 第九轮 P1-2：收银台普通收款 = 房费收款（押金走 addDepositAction，kind=DEPOSIT） */
          "ROOM_PAYMENT",
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
  const user = await requirePermissionOrRedirect("cashier.refund");
  /* 第九轮 P1-2：退款流水要写结构化性质 kind，老库先兜底补列 */
  ensurePaymentKindSchema();
  const paymentId = numOf(formData, "payment_id");
  const amount = round2(numOf(formData, "amount"));
  const reason = str(formData, "reason");
  /* 第十轮 P1：退款幂等键（负数流水写 payments.request_id） */
  const requestId = readRequestId(formData);

  if (!paymentId) return { error: "请选择要退款的收款记录" };
  if (amount <= 0) return { error: "退款金额必须大于 0" };
  if (!reason) return { error: "请填写退款原因" };

  /*
   * 幂等重放：同一 request_id 已经退过款 → 直接返回成功。
   * 放在最前面（早于退款上限 / 账单状态校验）：
   * 双击时第二笔若先撞上「最多还能退 0.00」或「账单已结账」，前台看到的是报错，
   * 而实际第一笔已经退成功 —— 收银员会以为没退成，再退一次（真正的重复退款风险）。
   */
  const replayedRefund = receivedPayment(user.hotelId, requestId);
  if (replayedRefund) {
    return { ok: `该笔退款已入账 ${fmtMoney(Math.abs(Number(replayedRefund.amount)))}（重复提交已忽略）` };
  }

  const pay = get<{ id: number; hotel_id: number; folio_id: number | null; stay_id: number | null; method: string; amount: number; refund_of: number | null; remark: string | null; kind: string | null }>(
    `SELECT id, hotel_id, folio_id, stay_id, method, amount, refund_of, remark, kind FROM payments
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

  let appliedDepositOffset = 0;
  try {
    appliedDepositOffset = tx(() => {
      /*
       * 押金冲销（第八轮业务冒烟 D3b）
       *
       * 旧实现这里只有 paid_amount -= amount + recalcFolioBalance，
       * 注释承诺的「同步冲销押金口径」并没有落 SQL：
       * 手动退了押金，folio_items 的 DEPOSIT 明细与 stays.deposit 还是原值。
       * 后果不是「钱少退/多退」而是**押金负债口径错**：
       *   · 「在住押金」报表 / 在住列表按 stays.deposit 汇总，会一直虚高；
       *   · 前台按押金明细判断「还能退多少」，会重复退一次；
       *   · 退房时 checkoutAction 还按剩余押金明细继续冲减，账实始终对不上。
       *
       * 判定「这笔退款动到了押金」的两个来源（满足其一）：
       *   ① 原收款本身就是押金收款：remark 含「押金」/「预收」
       *      —— 入住建押金写「入住押金」，addDepositAction 写「预收款（…）」/「预收款」；
       *      checkoutAction 找押金原收款也用 `remark LIKE '%押金%'` 这套业务标记。
       *   ② 退款金额超过「非押金已收」：非押金已收 = 已收 − 押金明细，即客人实付的消费款；
       *      退的钱超过这一块，超出部分只可能出自押金。
       *
       * 冲销额 = min(判定金额, 押金明细余额, stays.deposit)：
       *   两条上限各自兜底，任一维度都不会被减成负数。
       *
       * 注意这里**不再**减 folios.paid_amount：下面的退款流水已经让 paid 减过一次，
       * 押金冲销只改「押金负债」，不重复扣收款（否则余额会多算一次退款）。
       */
      const moneyBeforeRefund = recalcFolioBalance(user.hotelId, refundFolioId);
      const depositHeldBefore = depositHeld(user.hotelId, refundFolioId);
      const payRemark = String(pay.remark ?? "");
      /*
       * 第九轮 P1-2：判定「这笔退款动到了押金」不再看备注正则，改走统一口径
       * isDepositPayment（kind='DEPOSIT' 优先，旧数据才看备注）。
       * 这样原押金收款备注被写成「订金」也能认出，与 checkoutAction 完全同一口径。
       */
      const depositSource = isDepositPayment({ kind: pay.kind, remark: payRemark });
      const nonDepositPaid = round2(moneyBeforeRefund.paid - depositHeldBefore);
      const depositPortion = depositSource
        ? amount
        : round2(Math.max(0, amount - Math.max(0, nonDepositPaid)));

      /*
       * 押金冲销要落到入住单：收款行的 stay_id 可能为空（旧数据 / 挂账收款），
       * 用账单上的 stay_id 兜底 —— 否则会出现「明细冲销了、stays.deposit 没减」，
       * 在住列表与「在住押金」报表仍虚高。
       */
      const depositStayId =
        pay.stay_id ??
        get<{ stay_id: number | null }>(`SELECT stay_id FROM folios WHERE id = ? AND hotel_id = ?`, [
          refundFolioId,
          user.hotelId,
        ])?.stay_id ??
        null;
      let stayDeposit = 0;
      if (depositStayId) {
        stayDeposit = round2(
          Number(
            get<{ d: number | null }>(
              `SELECT COALESCE(deposit, 0) AS d FROM stays WHERE id = ? AND hotel_id = ?`,
              [depositStayId, user.hotelId]
            )?.d ?? 0
          )
        );
      }
      const depositOffset = round2(
        Math.min(
          depositPortion,
          Math.max(0, depositHeldBefore),
          depositStayId ? Math.max(0, stayDeposit) : Math.max(0, depositHeldBefore)
        )
      );

      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, request_id, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          refundFolioId,
          pay.stay_id,
          nextPayNo(),
          pay.method,
          -Math.abs(amount), // 负数记账
          todayStr(),
          /*
           * 押金退款的摘要明确写「押金退款」（房费退款仍写「退款」）
           *
           * 结构化识别已由下面的 kind 承担；这里保留「押金」二字是给**旧报表口径**兜底：
           * reports/page.tsx 的「押金退款流水」仍按 remark LIKE '%押金%' 取数（该文件不在本轮
           * 改动范围）。摘要带锚点，报表就不会漏记手动退的押金；等报表改读 kind 后这行可简化为
           * `退款：${reason}`，不影响任何判定。
           */
          depositSource ? `押金退款：${reason}` : `退款：${reason}`,
          nowIso(),
          pay.id,
          /* 第十轮 P1：退款幂等键（唯一索引 idx_payments_request 兜底并发双击） */
          requestId,
          user.realName ?? user.username,
          /*
           * 第九轮 P1-2：退款性质由**原收款**决定（押金退款 / 房费退款），
           * 与 checkoutAction 的退房退款共用 refundKindOf，两条退款路径口径唯一。
           */
          refundKindOf({ kind: pay.kind, remark: payRemark }),
        ]
      );

      if (depositOffset > 0.001) {
        /*
         * 逐行冲销押金明细（取代「只冲最新一行」的旧写法）
         *
         * 旧写法用子查询锁一行，但**没限制「冲销额 ≤ 该行余额」**：
         * 若最新一笔押金只有 300、而应冲 600，那一行会被冲成 -300（负押金）。
         * 真库目前每张账单只有 1 条押金明细所以不暴露，多次收押金后就会踩到。
         *
         * 现在与 checkoutAction 同款：
         *   · 优先冲最新的那笔
         *   · 单笔 ≤ 该行余额
         *   · 总额 ≤ stays.deposit（明细不足时不会把 stays.deposit 减成负数）
         *   · stays.deposit 按「实际冲销额」减，不按应冲额
         */
        let left = depositOffset;
        const depLines = all<{ id: number; amount: number }>(
          `SELECT id, amount FROM folio_items
            WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT' AND amount > 0.005
            ORDER BY id DESC`,
          [refundFolioId, user.hotelId]
        );
        let applied = 0;
        for (const line of depLines) {
          if (left <= 0.005) break;
          const take = Math.min(left, Number(line.amount));
          run(
            `UPDATE folio_items SET amount = amount - ?
              WHERE id = ? AND folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
            [take, line.id, refundFolioId, user.hotelId]
          );
          left = Math.round((left - take) * 100) / 100;
          applied = Math.round((applied + take) * 100) / 100;
        }
        if (depositStayId && applied > 0) {
          run(`UPDATE stays SET deposit = MAX(0, COALESCE(deposit, 0) - ?) WHERE id = ? AND hotel_id = ?`, [
            applied,
            depositStayId,
            user.hotelId,
          ]);
        }
        writeLog(
          user.hotelId,
          user.realName,
          "退款冲销押金",
          `账单 #${refundFolioId} · 退款 ${fmtMoney(amount)}（原收款 #${pay.id}，${payRemark || pay.method}）· 冲销押金 ${fmtMoney(depositOffset)}`
        );
      }

      /*
       * 退款后重算（第 4 轮 P0-1 + P0-3）
       *
       * 不再在 SQL 里手算 balance；只扣 paid_amount，再统一重算。
       */
      run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [
        amount,
        refundFolioId,
        user.hotelId,
      ]);
      recalcFolioBalance(user.hotelId, refundFolioId);
      return depositOffset;
    });
  } catch (e) {
    /*
     * 并发双击兜底：两个请求都通过了幂等查重，后到的撞 payments.request_id
     * 唯一索引（事务已整体回滚），按幂等重放返回成功而不是把 UNIQUE 报错甩给前台。
     */
    if (isUniqueViolation(e)) return { ok: "该笔退款已入账（并发重复提交已忽略）" };
    return { error: e instanceof Error ? e.message : "退款失败" };
  }

  revalidateCashier();
  return appliedDepositOffset > 0.001
    ? { ok: `已退款 ${fmtMoney(amount)}（原因：${reason}），其中同步冲销押金 ${fmtMoney(appliedDepositOffset)}` }
    : { ok: `已退款 ${fmtMoney(amount)}（原因：${reason}）` };
}

/**
 * 预收款（押金）：单独收一笔押金
 * → folio_items 记 DEPOSIT 明细 + payments 流水 + folios.paid_amount 累加
 */
export async function addDepositAction(formData: FormData): Promise<ActionState> {
  /*
   * 收押金 = 收款动作，必须有 cashier.receive
   *
   * 原来这里是 requireUser() —— **任何登录用户都能收押金**。
   * 实测（chk-perm）：撤销前台 cashier.receive 后，收款被拒（303 /no-permission），
   * 但同一个账号调 addDepositAction 仍然成功写库（payments + folio.paid_amount）。
   */
  const user = await requirePermissionOrRedirect("cashier.receive");
  /* 第九轮 P1-2：押金收款写 kind=DEPOSIT（不再靠备注识别），老库先兜底补列 */
  ensurePaymentKindSchema();
  const folioId = numOf(formData, "folio_id");
  const stayId = numOf(formData, "stay_id");
  const amount = round2(numOf(formData, "amount"));
  const method = str(formData, "method") || "现金";
  const remark = str(formData, "remark");
  const bizDate = str(formData, "biz_date") || bizToday(user.hotelId);
  /* 第十轮 P1：押金幂等键（payments 与 folio_items 两处都写，两张表各有唯一索引） */
  const requestId = readRequestId(formData);

  if (!folioId) return { error: "账务单不存在" };
  if (amount <= 0) return { error: "预收款金额必须大于 0" };

  /*
   * 幂等重放：同一 request_id 的押金已经收过（收款流水是「钱到账」的唯一事实来源）。
   * 必须在账单状态校验之前 —— 双击时第一笔已收成功、随后退房，第二笔若先撞
   * 「该账单已结账」就会把重复提交显示成业务报错，收银员会以为没收到再收一次。
   */
  const replayed = receivedPayment(user.hotelId, requestId);
  if (replayed) {
    return { ok: `该笔预收款已入账 ${fmtMoney(Number(replayed.amount))}（重复提交已忽略）` };
  }

  const folio = loadFolioContext(folioId, user.hotelId);
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") return { error: "该账单已结账，不能再收预收款" };

  const desc = remark ? `预收款（${remark}）` : "预收款（押金）";

  try {
    tx(() => {
      run(
        `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by, request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [user.hotelId, folioId, "DEPOSIT", desc, 1, amount, amount, bizDate, nowIso(), user.id, requestId]
      );
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          user.hotelId,
          folioId,
          stayId || folio.stay_id,
          nextPayNo(),
          method,
          amount,
          bizDate,
          remark || "预收款",
          nowIso(),
          requestId,
          user.realName ?? user.username,
          /*
           * 第九轮 P1-2：kind 是押金的唯一结构标记。
           * 备注是自由文本（客人/前台可能写「订金」「保证金」「刷卡预授权」），
           * 一律不再参与押金识别；退房与手动退款都按这个字段找原押金收款。
           */
          "DEPOSIT",
        ]
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
  } catch (e) {
    /* 并发双击：两次都通过查重 → 后到的撞唯一索引，事务整体回滚，按重放返回成功 */
    if (isUniqueViolation(e)) return { ok: "该笔预收款已入账（并发重复提交已忽略）" };
    throw e;
  }
  revalidateCashier();
  return { ok: `已收预收款 ${fmtMoney(amount)}` };
}

/**
 * 部分结账：先结一部分，余额保留
 * → payments 记收款流水 + folio_items 记 ADJUST 负项（已结记录）
 */
export async function partialSettleAction(formData: FormData): Promise<ActionState> {
  /* 部分结账也是收款：撤销 cashier.receive 后本来应该一起被拒（原来只有 requireUser） */
  const user = await requirePermissionOrRedirect("cashier.receive");
  /* 第九轮 P1-2：部分结账收款写 kind=ROOM_PAYMENT，老库先兜底补列 */
  ensurePaymentKindSchema();
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
      `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, operator, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
        user.realName ?? user.username,
        /* 部分结账收到的是消费款（押金已单列），性质为房费收款 */
        "ROOM_PAYMENT",
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
  const user = await requirePermissionOrRedirect("cashier.charge_company");
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
  const user = await requirePermissionOrRedirect("cashier.transfer");
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
  const user = await requirePermissionOrRedirect("cashier.receive");
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
  const user = await requirePermissionOrRedirect("cashier.reverse_checkout");
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
  /*
   * 延住会改 stays.expect_check_out / nights，进而影响库存、房费与报表
   *
   * 实测（chk-perm）：housekeeper 调它能把离店日从 11-14 改到 11-26（nights 1→13）
   * 而且不收任何房费。归到 cashier.receive —— 它本质是「改房费/加收」类动作。
   */
  const user = await requirePermissionOrRedirect("cashier.receive");
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
  const user = await requirePermissionOrRedirect("cashier.reverse_checkout");
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

/** 结账退房：补收 → 无条件冲销押金 → 核销账单 → 退房 → 房态 VD → 打扫任务 */
export async function checkoutAction(formData: FormData): Promise<ActionState> {
  // 权限边界（上线前加固）：结账退房同时改钱和房态，必须校验 cashier.checkout，原来只校验登录
  const user = await requirePermissionOrRedirect("cashier.checkout");
  const stayId = numOf(formData, "stay_id");
  const roomId = numOf(formData, "room_id");
  const folioId = numOf(formData, "folio_id");
  const payMethod = str(formData, "pay_method") || "现金";
  const payAmount = round2(numOf(formData, "pay_amount"));
  /* 第十轮 P1：退房幂等键（补收流水 / 押金退款流水都写 payments.request_id） */
  const requestId = readRequestId(formData);

  if (!stayId || !roomId || !folioId) return { error: "入住信息不完整，请重新选择客人" };

  const folio = get<{ id: number; status: string; stay_id: number | null; folio_no: string }>(
    `SELECT id, status, stay_id, folio_no FROM folios WHERE id = ? AND hotel_id = ?`,
    [folioId, user.hotelId]
  );
  if (!folio) return { error: "账务单不存在" };
  if (folio.status === "SETTLED" || folio.status === "CHARGED") {
    /*
     * 双击退房：第一枪已经把账单置 SETTLED。
     * 同一 request_id 的重放按幂等返回成功（不再写第二遍补收 / 押金退款 / 日志）；
     * 换了一枚新键才说明是「真的再点一次」，那才是业务错误。
     */
    if (receivedPayment(user.hotelId, requestId)) {
      return { ok: "该笔退房已处理（重复提交已忽略）" };
    }
    return { error: "该账单已结账，无需重复退房" };
  }

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
  /*
   * 第九轮 P1-2：退房会写两类收款流水（补收 / 退押金），都要带结构化的 kind。
   * 老库可能还没有 kind 列，先兜底补上再进事务。
   */
  ensurePaymentKindSchema();
  try {
    result = tx((): { error: string } | { ok: string } => {
    /*
     * 0. 事务内再确认一次账单状态（并发双击兜底）
     *
     * 预检在事务外：两个请求可能都读到 OPEN。tx() 是 BEGIN IMMEDIATE（写锁串行），
     * 第二个请求进来时第一枪已经提交，账单已 SETTLED ——
     * 这里直接按幂等重放返回，不再写第二遍补收 / 押金退款 / 操作日志。
     */
    const folioNow = get<{ status: string }>(
      `SELECT status FROM folios WHERE id = ? AND hotel_id = ?`,
      [folioId, user.hotelId]
    );
    if (folioNow && (folioNow.status === "SETTLED" || folioNow.status === "CHARGED")) {
      return { ok: "该笔退房已处理（重复提交已忽略）" };
    }

    // 1. 补收（第 4 轮 P0-1：只加 paid_amount，余额交给 recalcFolioBalance 统一算）
    if (payAmount > 0) {
      run(
        `INSERT INTO payments (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, request_id, operator, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          /*
           * 第十轮 P1：补收流水带幂等键。
           * 押金退款流水用 `${requestId}#dep` 派生键，避免与补收撞同一个唯一索引；
           * 补收本身用「裸键」—— 双击时第二枪能靠 payments.request_id 认出重放。
           */
          requestId,
          user.realName ?? user.username,
          /* 补收的是消费欠款，不是押金 */
          "ROOM_PAYMENT",
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
     * 2b. 退房「无条件冲销全部押金」（第十轮 P0）
     *
     * ── 缺陷（第九轮验收 agent 在真库实测）──
     * 旧实现只按「应退余额」退押金：
     *     refundDue  = max(0, −balance)
     *     refundCash = min(refundDue, 押金明细)
     *     if (refundCash > 0) { 写负数收款 + 冲销明细 + 减 stays.deposit }
     * balance >= 0（客人不欠钱，或欠款已被补收抹平）时 refundCash = 0，
     * **整段冲销被 if 跳过** —— 客人拿走行李走了，账上押金还挂着：
     *   · stays.deposit 仍是 800，「在住押金」/在住列表虚高；
     *   · folio_items 的 DEPOSIT 明细仍是 800，押金报表按明细汇总 → 收取额虚高；
     *   · 再入住/再收费时前台按「还挂着押金」判断，容易重复退。
     * 真库实测：11 张 CHECKED_OUT 单残留押金 6800，3 张 SETTLED 账单还挂 2100。
     *
     * ── 押金是担保，不是收入：退房必须清零 ──
     * 账务上押金早就计入 folios.paid_amount（收款事实），所以「押金先抵扣房费」
     * 在账面天然成立：应收 T、其它实收 R、押金 D 时 paid = R + D，balance = T − (R + D)。
     *   · balance < 0（多收了钱）→ 退现金 refundCash = min(−balance, D)；
     *     这部分写负数收款（refund_of 指向原押金），paid 同步减回去；
     *   · balance >= 0（押金被房费吃掉 / 已被补收抹平）→ 不退现金，
     *     押金明细与 stays.deposit 照样清零（担保结束）。
     * 两种情况下押金都要清零，区别只在退多少现金。
     *
     * ── 与旧实现的唯一行为差异 ──
     * balance >= 0 时旧代码什么都不做（残留），新代码做完整账面冲销（不动钱）。
     * balance < 0 时 refundCash 与旧实现完全一致（min(应退, 押金)），
     * 既有押金退回的流水 / 日志 / 报表口径不变。
     */
    const refundDue = money.balance < -0.01 ? round2(-money.balance) : 0;
    /* 该账单还挂着的押金明细总额（押金负债的唯一权威口径，等同 lib/folio.depositHeld） */
    const depositOnFolio = depositHeld(user.hotelId, folioId);
    const stayDepositRow = get<{ d: number | null }>(
      `SELECT COALESCE(deposit, 0) AS d FROM stays WHERE id = ? AND hotel_id = ?`,
      [stayId, user.hotelId]
    );
    const stayDeposit = round2(Math.max(0, Number(stayDepositRow?.d ?? 0)));
    /* 退现金的部分：只能退「多收的钱」，且不超过押金本身 */
    const refundCash = round2(Math.min(refundDue, Math.max(0, depositOnFolio)));
    /* 押金被房费吃掉的部分：不产生现金流动，钱本来就留在 paid_amount 里 */
    const depositOffsetToRoom = round2(Math.max(0, depositOnFolio) - refundCash);

    if (depositOnFolio > 0.005 || stayDeposit > 0.005) {
      /* ① 押金退现金：写负数收款流水（refund_of 指向原押金那笔，method 同原方式） */
      if (refundCash > 0.005) {
        /*
         * 找押金那笔原始收款（refund_of 要指向它，便于对账）
         *
         * 第九轮 P1-2：原来用 `remark LIKE '%押金%'` 找 —— 押金备注写成「订金」就找不到，
         * refund_of 为空、押金退不回去，还可能被当成房费退款重复退。
         * 现在走唯一口径 findDepositPayment：kind = 'DEPOSIT' 优先，旧数据（kind 为空）才按备注兜底。
         */
        const depositPay = findDepositPayment(user.hotelId, folioId);
        run(
          `INSERT INTO payments
             (hotel_id, folio_id, stay_id, pay_no, method, amount, biz_date, remark, created_at, refund_of, request_id, operator, kind)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            /* 第十轮 P1：派生幂等键（与补收的裸键区分；没有补收时用裸键，便于识别重放） */
            requestId ? (payAmount > 0 ? `${requestId}#dep` : requestId) : null,
            user.realName ?? user.username,
            /* 押金退款的结构化标记（与手动退款 refundKindOf 的口径一致） */
            "DEPOSIT_REFUND",
          ]
        );
        /* ② 减已收：退出去的押金不再是酒店的钱 */
        run(`UPDATE folios SET paid_amount = COALESCE(paid_amount,0) - ? WHERE id = ? AND hotel_id = ?`, [
          refundCash,
          folioId,
          user.hotelId,
        ]);
      }

      /*
       * ③ 押金明细全部清零（含「被房费吃掉」的部分）
       *
       * 按行逐笔 UPDATE，一条语句只改一行：
       * 写成 `UPDATE ... WHERE item_type = 'DEPOSIT'` 的批量语句会把**每条**都减一遍，
       * 账单挂 3 条押金（各 600）时总额会从 1800 掉到 1200 —— 被多冲了 2 次。
       * 这里直接把每行置 0（而不是减 refundCash）：
       * 旧实现只冲 refundCash、balance>=0 时一条都不冲，正是真库残留 6800 的成因。
       */
      const depositLines = all<{ id: number; amount: number | null }>(
        `SELECT id, amount FROM folio_items
          WHERE folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT' AND COALESCE(amount, 0) > 0.005
          ORDER BY id DESC`,
        [folioId, user.hotelId]
      );
      for (const line of depositLines) {
        run(
          `UPDATE folio_items SET amount = 0
            WHERE id = ? AND folio_id = ? AND hotel_id = ? AND item_type = 'DEPOSIT'`,
          [line.id, folioId, user.hotelId]
        );
      }

      /* ④ 入住单押金无条件归零（担保结束；明细不足 / 只有 stays 有值的历史脏数据也一并清掉） */
      run(`UPDATE stays SET deposit = 0 WHERE id = ? AND hotel_id = ?`, [stayId, user.hotelId]);

      /* ⑤ 重算余额 */
      recalcFolioBalance(user.hotelId, folioId);
      writeLog(
        user.hotelId,
        user.realName,
        "退房退还押金",
        `入住单 ${stay.stay_no} · 账单 ${folio.folio_no} · 押金 ${fmtMoney(depositOnFolio)} 全额冲销` +
          `（退现金 ${fmtMoney(refundCash)} · 抵扣房费 ${fmtMoney(depositOffsetToRoom)} · ` +
          `${depositLines.length} 条押金明细清零 · stays.deposit ${fmtMoney(stayDeposit)}→0）`
      );
    }

    /*
     * 2c. 冲销押金后再确认一次余额
     *
     * 理论上 balance 已归零（应退的钱退掉了、抵扣的部分留在 paid 里）。
     * 若仍非 0（例如现金多收、超出押金的部分退不出去），写一条日志留痕，
     * 不再静默把「已结清」的账单挂着一个非 0 余额 —— 缺陷 3 就是这种账。
     */
    const settledMoney = recalcFolioBalance(user.hotelId, folioId);
    if (Math.abs(settledMoney.balance) > 0.01) {
      writeLog(
        user.hotelId,
        user.realName,
        "退房后余额未归零",
        `入住单 ${stay.stay_no} · 账单 ${folio.folio_no} · 余额 ${fmtMoney(settledMoney.balance)}` +
          `（应收 ${fmtMoney(settledMoney.total)} · 已收 ${fmtMoney(settledMoney.paid)}）需人工核对`
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
        (refundDue > 0 ? ` · **应退押金 ${fmtMoney(refundDue)}**` : "") +
        (depositOnFolio > 0.005 || stayDeposit > 0.005
          ? ` · 押金冲销 ${fmtMoney(depositOnFolio)}（退现金 ${fmtMoney(refundCash)} / 抵扣房费 ${fmtMoney(depositOffsetToRoom)}）`
          : "")
    );

    /*
     * 应退押金要明确告诉前台 —— 不能只写日志了事。
     * 客人在前台等着，系统不提示「还有 600 要退」，这钱就留下了。
     *
     * 第十轮 P0：押金是「无条件冲销」的，所以成功文案要把三件事讲清楚：
     *   · 退了多少现金；
     *   · 有多少押金被房费吃掉了（不退现金，但账已平）；
     *   · 还有多少「没有押金可冲」的应退余额需要人工处理（例如现金多收）。
     */
    const notes: string[] = [];
    if (refundCash > 0.005) notes.push(`已退还押金 ${fmtMoney(refundCash)}`);
    if (depositOffsetToRoom > 0.005) notes.push(`押金 ${fmtMoney(depositOffsetToRoom)} 已抵扣房费`);
    if (refundDue > refundCash + 0.005) notes.push(`另有 ${fmtMoney(refundDue - refundCash)} 无押金可冲，需人工核对`);
    if (Math.abs(settledMoney.balance) > 0.01) notes.push(`账单余额 ${fmtMoney(settledMoney.balance)} 需人工核对`);
    return { ok: notes.length > 0 ? `退房成功，${notes.join("，")}` : "结账退房成功" };
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
