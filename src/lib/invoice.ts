/**
 * 发票台账（整改清单 P2-3：发票建台账 / 开票校验 / 红冲）
 *
 * ── 改造前的缺陷 ──
 * 收银台「开发票」只在 op_logs 里写一段人类可读的文本（`开发票 · 入住单 … · 金额 ¥…`），
 * 由此带来三个问题：
 *   1. 开票记录不可查：没有表，只能到操作日志里按字符串 LIKE 翻；
 *   2. 不能红冲：日志无法被「负数对冲」，红冲只能靠人工在备注里写；
 *   3. 没有校验：既没判断账单是否已结账，也算不出同一张账单已经开过多少，
 *      重复开票 / 超额开票都拦不住。
 *
 * ── 本文件提供的东西 ──
 *   invoices 表（迁移见 scripts/migrate-all.mjs 第 10 段）
 *   issueInvoice        开票：校验账单归属 / 已结账或已挂账 / 不超应收，落台账
 *   redFlushInvoice     红冲：生成负数票 + 原票状态置 RED，开票额度自动还回
 *   listInvoices        台账查询（按账单 / 营业日 / 区间 / 状态）
 *   invoiceStats        开票金额 / 红冲金额 / 净开票额
 *
 * ── 金额口径（关键） ──
 *   amount 是**有符号**的：正常票为正、红冲票为负。
 *   某张账单的「已开票净额」= SUM(amount)，于是：
 *     · 分次开票：多次正数累加，合计不能超过账单总额（不能超开）；
 *     · 红冲：追加一笔负数，净额自动减少，等于把额度还回去（红冲 = 撤销）。
 *   这比「再存一列 remaining_amount 手工加减」更难算错。
 *
 * ── 事务 ──
 * 与 member-wallet.ts / ar.ts 一致使用 SAVEPOINT：本文件会在收银台已有的 tx() 内
 * 被调用，BEGIN 嵌套会抛错，SAVEPOINT 在有 / 无外层事务两种场景下都安全。
 */

import { all, get, getDb, run } from "@/lib/db";
import { bizToday } from "@/lib/biz-date";
import { fmtMoney, nowIso } from "@/lib/utils";

/** 开票入参：除 hotelId / title / amount 外都可缺省，folioId 缺省表示「不关联账单」 */
export type InvoiceIssueInput = {
  hotelId: number;
  /** 发票号；不填则自动生成 INV-yyyymmdd-序号 */
  invoiceNo?: string;
  /** 发票抬头 */
  title: string;
  /** 税号（统一社会信用代码，可空） */
  taxNo?: string;
  /** 开票金额（正数） */
  amount: number;
  /** 关联账单 id */
  folioId?: number;
  /** 关联入住单 id；传了 folioId 时以账单上的入住单为准 */
  stayId?: number;
  guestName?: string;
  roomNo?: string;
  /** 开票营业日 YYYY-MM-DD，缺省取当前营业日 */
  bizDate?: string;
  operator?: string;
  remark?: string;
};

/** 开票 / 红冲结果：成功带新记录 id 与最终发票号，失败带可直接展示给前台的文案 */
export type InvoiceResult = { ok: true; id: number; invoiceNo: string } | { error: string };

/** 台账行：与 invoices 表列一一对应，金额已归一为两位小数 */
export type InvoiceRow = {
  id: number;
  hotel_id: number;
  invoice_no: string;
  invoice_type: string;
  title: string;
  tax_no: string | null;
  amount: number;
  folio_id: number | null;
  folio_no: string | null;
  stay_id: number | null;
  guest_name: string | null;
  room_no: string | null;
  biz_date: string;
  operator: string | null;
  remark: string | null;
  red_of: number | null;
  status: string;
  created_at: string | null;
};

/**
 * 台账查询条件。
 * 除约定字段外额外支持 from / to（营业日闭区间），供 /invoices 页面的区间筛选使用；
 * 三者可叠加，bizDate 是「某一天」，from/to 是「一段区间」。
 */
export type InvoiceFilter = {
  folioId?: number;
  bizDate?: string;
  from?: string;
  to?: string;
  status?: string;
  limit?: number;
};

/** 发票类型：NORMAL 正常 / RED 红冲 / VOID 作废 */
export type InvoiceType = "NORMAL" | "RED" | "VOID";

/** 发票状态：ISSUED 已开 / RED 已红冲 / VOID 已作废 */
export type InvoiceStatus = "ISSUED" | "RED" | "VOID";

/** 单张账单的开票上下文（只取校验需要的列） */
type FolioBrief = {
  id: number;
  folio_no: string;
  status: string;
  total_amount: number;
  stay_id: number | null;
  guest_name: string | null;
  room_no: string | null;
};

const MAX_AMOUNT = 9999999;
/** 金额比较容差：浮点两位小数累加后可能有 1e-12 级误差 */
const EPS = 0.001;
const MAX_NO_LENGTH = 64;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 状态中文名（错误文案用；页面有自己的带色标签，不从这里取） */
const STATUS_LABEL: Record<string, string> = {
  ISSUED: "已开票",
  RED: "已红冲",
  VOID: "已作废",
};

/** 账单状态中文名（错误文案用） */
const FOLIO_STATUS_LABEL: Record<string, string> = {
  OPEN: "未结账",
  SETTLED: "已结账",
  /* 第九轮缺陷修复：挂公司账也是「客账已结清」，只是钱由协议单位付 */
  CHARGED: "已挂公司账",
  VOID: "已作废",
};

let schemaReady = false;
let savepointSeq = 0;

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function failText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 懒建表（幂等）。
 *
 * 正常部署由 `node scripts/migrate-all.mjs` 建好；这里兜底是为了「克隆仓库直接 dev」
 * 或验收脚本单独跑时不会 no such table —— 与 src/lib/ar.ts 的 ensureArLedgerSchema 同思路。
 */
export function ensureInvoiceSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      invoice_no TEXT NOT NULL,
      invoice_type TEXT DEFAULT 'NORMAL',
      title TEXT NOT NULL,
      tax_no TEXT,
      amount REAL NOT NULL,
      folio_id INTEGER,
      folio_no TEXT,
      stay_id INTEGER,
      guest_name TEXT,
      room_no TEXT,
      biz_date TEXT NOT NULL,
      operator TEXT,
      remark TEXT,
      red_of INTEGER,
      status TEXT DEFAULT 'ISSUED',
      created_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_folio ON invoices(hotel_id, folio_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_bizdate ON invoices(hotel_id, biz_date)`);
  // 唯一索引带 WHERE：允许 invoice_no 为空串占位，避免多张「待补号」发票互相冲突
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_no ON invoices(hotel_id, invoice_no) WHERE invoice_no <> ''`
  );
  /*
   * 红冲唯一性（第七轮整改清单一.3）：同一酒店、同一张原票只允许一张红冲票。
   *
   * 应用层在 redFlushInvoice() 里已经查过「是否已存在 red_of = 原票」，但两个并发请求
   * 可以同时通过那条 SELECT，各自插入一张负数票 —— 应用层检查挡不住这个窗口，
   * 只有数据库唯一约束能挡：后到的那条 INSERT 直接抛 UNIQUE。
   *
   * 本文件是「克隆仓库直接 dev / 验收脚本单跑」的兜底建表路径；正常部署由
   * scripts/migrate-all.mjs 建（DDL 必须完全一致），新库由 scripts/schema-full.sql 建。
   */
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_red_of ON invoices(hotel_id, red_of) WHERE red_of IS NOT NULL`
  );
  schemaReady = true;
}

/** 在 SAVEPOINT 中执行多步写操作：失败整段回滚，外层事务不受影响 */
function withSavepoint<T>(fn: () => T): T {
  const db = getDb();
  const name = `sp_invoice_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw e;
  }
}

/** 营业日：显式传入则校验格式，缺省取当前营业日；格式非法返回 null */
function normalizeBizDate(value: string | undefined, hotelId: number): string | null {
  const v = (value ?? "").trim();
  if (!v) return bizToday(hotelId);
  if (!DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return v;
}

/** 该发票号在本酒店是否已被占用 */
function invoiceNoTaken(hotelId: number, invoiceNo: string): boolean {
  return Boolean(
    get<{ id: number }>(`SELECT id FROM invoices WHERE hotel_id = ? AND invoice_no = ? LIMIT 1`, [
      hotelId,
      invoiceNo,
    ])
  );
}

/**
 * 生成发票号：`${prefix}-yyyymmdd-序号`，同酒店内不重复。
 *
 * 序号取「同酒店同一天同前缀」的最大值 +1，再逐个向后找空位，
 * 因此即使历史数据里被手工改过号也不会撞唯一索引。生成失败（极端情况）返回 null，
 * 由调用方提示「请手工填写发票号」，不抛异常。
 */
function nextInvoiceNo(hotelId: number, bizDate: string, prefix: "INV" | "RED"): string | null {
  const head = `${prefix}-${bizDate.replace(/-/g, "")}-`;
  const rows = all<{ invoice_no: string }>(
    `SELECT invoice_no FROM invoices WHERE hotel_id = ? AND invoice_no LIKE ?`,
    [hotelId, `${head}%`]
  );
  let max = 0;
  for (const r of rows) {
    const seq = Number(r.invoice_no.slice(head.length));
    if (Number.isFinite(seq) && seq > max) max = Math.trunc(seq);
  }
  for (let i = 0; i < 500; i += 1) {
    const candidate = `${head}${String(max + 1 + i).padStart(3, "0")}`;
    if (!invoiceNoTaken(hotelId, candidate)) return candidate;
  }
  return null;
}

/** 从账单上取开票上下文（含归属校验） */
function loadFolio(hotelId: number, folioId: number): FolioBrief | undefined {
  return get<FolioBrief>(
    `SELECT f.id, f.folio_no, f.status, f.total_amount, f.stay_id, f.guest_name, f.room_no
       FROM folios f
      WHERE f.id = ? AND f.hotel_id = ?`,
    [folioId, hotelId]
  );
}

/** 某张账单的已开票净额（正数为净开、可能为负说明红冲多于开票） */
function folioNetInvoiced(hotelId: number, folioId: number): number {
  const row = get<{ n: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM invoices WHERE hotel_id = ? AND folio_id = ?`,
    [hotelId, folioId]
  );
  return round2(Number(row?.n ?? 0));
}

/* ============================================================ 开票 */

/**
 * 开票：写一条发票台账。
 *
 * 校验顺序（错误文案直接面向收银台，所以写得能照着改）：
 *   1. 抬头必填、金额 > 0 且不超过上限；
 *   2. 传了 folioId 时：账单必须属于当前酒店 → 必须已结清客账（SETTLED 或 CHARGED）→
 *      「该账单已开票净额 + 本次」不能超过账单 total_amount（同一账单可分次开）；
 *   3. invoice_no 为空时自动生成 INV-yyyymmdd-xxx，同酒店唯一。
 *
 * ── 为什么 CHARGED（挂公司账）允许开票（第九轮修复）──
 * chargeToCompanyAction 把账单 balance 归 0、status 置 CHARGED：客账已结清，
 * 钱转成协议单位的应收账款（ar_ledgers），但账务主体仍是这张 folio。
 * 财务给协议单位开票时，抬头是公司、依据就是这张账单 —— 不放行等于「挂给公司的账
 * 开不出公司抬头发票」，发票台账与账单永远对不上。
 *
 * 金额上限仍取 folios.total_amount、不是 folios.balance：挂账把 balance 归 0 了，
 * 用 balance 会把可开额度算成 0；total_amount 是这张账单的应收总额，与是否收到钱无关。
 * 红冲的唯一约束（idx_invoices_red_of）只认 invoices 表的 red_of，不涉及账单状态，
 * 因此放开 CHARGED 不改变「一张原票只能红冲一次」。
 *
 * 仍不放行 OPEN（未结清）/ VOID（已作废）：前者客人还没付钱就先开票，
 * 账单可能继续消费或被拆分，开票额度会随 balance 变动而失真；后者账单已作废。
 * 这两档是刻意保留的业务风控，不是遗漏。
 *
 * 不抛异常：所有业务校验都以 `{ error }` 返回，方便 server action 直接转成表单提示。
 */
export function issueInvoice(input: InvoiceIssueInput): InvoiceResult {
  ensureInvoiceSchema();

  const hotelId = Math.trunc(Number(input.hotelId));
  if (!(hotelId > 0)) return { error: "缺少酒店信息，无法开票" };

  const title = (input.title ?? "").trim();
  if (!title) return { error: "请填写发票抬头" };
  if (title.length > 200) return { error: "发票抬头过长（最多 200 个字符）" };

  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "开票金额必须大于 0" };
  if (amount > MAX_AMOUNT) return { error: `开票金额不能超过 ${fmtMoney(MAX_AMOUNT)}` };

  const taxNo = (input.taxNo ?? "").trim();
  if (taxNo.length > MAX_NO_LENGTH) return { error: "税号过长（最多 64 个字符）" };

  const bizDate = normalizeBizDate(input.bizDate, hotelId);
  if (!bizDate) return { error: "开票营业日格式不正确，应为 YYYY-MM-DD" };

  /* ---------- 关联账单校验：客账已结清（已结账 / 已挂账）+ 不超应收 ---------- */
  let folio: FolioBrief | null = null;
  const rawFolioId = input.folioId;
  if (rawFolioId !== undefined && rawFolioId !== null) {
    const folioId = Math.trunc(Number(rawFolioId));
    if (!Number.isFinite(folioId) || folioId <= 0) return { error: "关联账单编号不正确" };

    folio = loadFolio(hotelId, folioId) ?? null;
    if (!folio) return { error: "关联账单不存在或不属于当前酒店" };

    /*
     * 允许 SETTLED（客人已付）与 CHARGED（已挂协议单位，见上方口径说明）；
     * OPEN / VOID 一律拒绝，错误文案按状态给出准确原因。
     */
    if (folio.status !== "SETTLED" && folio.status !== "CHARGED") {
      const label = FOLIO_STATUS_LABEL[folio.status] ?? folio.status;
      if (folio.status === "OPEN") {
        return {
          error: `账单 ${folio.folio_no} 当前为「${label}」，未结账不能开发票（请先结账或挂公司账）`,
        };
      }
      return {
        error: `账单 ${folio.folio_no} 当前为「${label}」，不能开发票`,
      };
    }

    const total = round2(Number(folio.total_amount ?? 0));
    const netInvoiced = folioNetInvoiced(hotelId, folio.id);
    const remaining = round2(total - netInvoiced);
    if (remaining <= EPS) {
      return {
        error: `账单 ${folio.folio_no} 已开满发票（账单总额 ${fmtMoney(total)}，已开票 ${fmtMoney(
          netInvoiced
        )}），不能再开`,
      };
    }
    if (amount > remaining + EPS) {
      return {
        error: `开票金额 ${fmtMoney(amount)} 超过账单可开余额 ${fmtMoney(remaining)}（账单总额 ${fmtMoney(
          total
        )}，已开票 ${fmtMoney(netInvoiced)}）`,
      };
    }
  }

  /* ---------- 入住单 / 客人 / 房间：有账单就跟着账单走，防止张冠李戴 ---------- */
  let stayId: number | null = null;
  if (input.stayId !== undefined && input.stayId !== null) {
    const sid = Math.trunc(Number(input.stayId));
    if (!Number.isFinite(sid) || sid <= 0) return { error: "关联入住单编号不正确" };
    stayId = sid;
  }
  if (folio) {
    if (stayId !== null && folio.stay_id !== null && Number(folio.stay_id) !== stayId) {
      return { error: "入住单与账单不匹配，无法关联开票" };
    }
    stayId = folio.stay_id ?? stayId;
  } else if (stayId !== null) {
    const stay = get<{ id: number }>(`SELECT id FROM stays WHERE id = ? AND hotel_id = ?`, [stayId, hotelId]);
    if (!stay) return { error: "关联入住单不存在或不属于当前酒店" };
  }

  const guestName = ((input.guestName ?? "").trim() || folio?.guest_name || "").trim() || null;
  const roomNo = ((input.roomNo ?? "").trim() || folio?.room_no || "").trim() || null;
  const operator = (input.operator ?? "").trim() || null;
  const remark = (input.remark ?? "").trim() || null;

  /* ---------- 发票号：用户填的要查重，不填的自动生成 ---------- */
  let invoiceNo = (input.invoiceNo ?? "").trim();
  if (invoiceNo) {
    if (invoiceNo.length > MAX_NO_LENGTH) return { error: "发票号过长（最多 64 个字符）" };
    if (invoiceNoTaken(hotelId, invoiceNo)) {
      return { error: `发票号 ${invoiceNo} 已存在（同一酒店内不能重复）` };
    }
  } else {
    const generated = nextInvoiceNo(hotelId, bizDate, "INV");
    if (!generated) return { error: "自动生成发票号失败，请手工填写发票号" };
    invoiceNo = generated;
  }

  try {
    const result = withSavepoint(() =>
      run(
        `INSERT INTO invoices
           (hotel_id, invoice_no, invoice_type, title, tax_no, amount,
            folio_id, folio_no, stay_id, guest_name, room_no,
            biz_date, operator, remark, red_of, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          invoiceNo,
          "NORMAL",
          title,
          taxNo || null,
          amount,
          folio ? folio.id : null,
          folio ? folio.folio_no : null,
          stayId,
          guestName,
          roomNo,
          bizDate,
          operator,
          remark,
          null,
          "ISSUED",
          nowIso(),
        ]
      )
    );
    return { ok: true, id: result.lastInsertRowid, invoiceNo };
  } catch (e) {
    // 并发下唯一索引可能先被别的请求占用；给出可读文案而不是抛 500
    if (/UNIQUE/i.test(failText(e))) {
      return { error: `发票号 ${invoiceNo} 已存在（同一酒店内不能重复）` };
    }
    return { error: "开票失败，请稍后重试" };
  }
}

/* ============================================================ 红冲 */

/**
 * 红冲：把一张已开出的正常发票作废。
 *
 * 不物理删除原票（台账要留痕），而是：
 *   1. 追加一条 invoice_type = RED、amount = -原金额、red_of = 原票 id 的负数记录；
 *   2. 原票 status 由 ISSUED 改为 RED。
 *
 * 因为账单「已开票净额」是按 SUM(amount) 算的，红冲后净额自动减少，
 * 该账单的额度等于还回去了，可以重新开票。
 *
 * 只允许对「正常票 + 已开状态」红冲；红冲票自身不能再红冲。
 */
export function redFlushInvoice(
  hotelId: number,
  invoiceId: number,
  opts: { operator?: string; remark?: string } = {}
): InvoiceResult {
  ensureInvoiceSchema();

  const hotel = Math.trunc(Number(hotelId));
  if (!(hotel > 0)) return { error: "缺少酒店信息，无法红冲" };

  const id = Math.trunc(Number(invoiceId));
  if (!Number.isFinite(id) || id <= 0) return { error: "发票不存在" };

  const src = get<InvoiceRow>(`SELECT * FROM invoices WHERE id = ? AND hotel_id = ?`, [id, hotel]);
  if (!src) return { error: "发票不存在或不属于当前酒店" };

  if (src.invoice_type !== "NORMAL") return { error: "红冲发票不能再红冲（仅正常发票可红冲）" };

  /*
   * 「这张票有没有被红冲过」= 状态机 + 不变量，双条件（第七轮整改清单一.3
   * 「原票状态不能通过普通更新重新变成可红冲」）。
   *
   * status 是可写列：一条 `UPDATE invoices SET status = 'ISSUED'`（数据库工具、脚本、
   * 或者以后新增的某个「撤销红冲」半成品功能）就能把原票改回「已开票」，
   * 于是纯状态判断会放行第二次红冲，负数票翻倍、账单净额被少算一遍。
   *
   *   条件 1  status 必须是 ISSUED（状态机本身）；RED 直接拒。
   *   条件 2  同酒店内不存在 red_of = 原票 id 的记录（不变量，改状态改不掉）。
   * 数据库层再加 idx_invoices_red_of 唯一索引兜住并发窗口，三处一起才算「只能红冲一次」。
   */
  if (src.status === "RED") return { error: `发票 ${src.invoice_no} 已红冲，不能重复红冲` };

  const existingRed = get<{ id: number; invoice_no: string }>(
    `SELECT id, invoice_no FROM invoices WHERE hotel_id = ? AND red_of = ? ORDER BY id LIMIT 1`,
    [hotel, src.id]
  );
  if (existingRed) {
    return {
      error: `发票 ${src.invoice_no} 已红冲（红冲票号 ${existingRed.invoice_no}），不能重复红冲`,
    };
  }

  if (src.status !== "ISSUED") {
    const label = STATUS_LABEL[src.status] ?? src.status;
    return { error: `发票 ${src.invoice_no} 当前为「${label}」，不能红冲` };
  }

  const amount = round2(Number(src.amount ?? 0));
  if (!(amount > 0)) return { error: "原发票金额不是正数，无法红冲" };

  // 红冲是今天发生的账务动作，营业日取当前营业日（原票营业日保持不变，便于追溯）
  const bizDate = bizToday(hotel);
  const operator = (opts.operator ?? "").trim() || null;
  const remark = (opts.remark ?? "").trim() || `红冲 ${src.invoice_no}`;
  /*
   * 红冲原因的服务端校验（第七轮整改清单一.3）
   *
   * 「原因必填」在动作层（app/(main)/invoices/actions.ts）已经做了 —— 那是页面路径
   * 唯一入口，构造 POST 也绕不过；这里再补一道长度上限，因为 service 也可以被脚本、
   * 小程序端、以后的批量红冲直接调用，不能让一条超长备注进财务台账。
   */
  if (remark.length > 200) return { error: "红冲原因过长（最多 200 个字符）" };

  const invoiceNo = nextInvoiceNo(hotel, bizDate, "RED");
  if (!invoiceNo) return { error: "自动生成红冲票号失败，请联系管理员" };

  try {
    const newId = withSavepoint(() => {
      const inserted = run(
        `INSERT INTO invoices
           (hotel_id, invoice_no, invoice_type, title, tax_no, amount,
            folio_id, folio_no, stay_id, guest_name, room_no,
            biz_date, operator, remark, red_of, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotel,
          invoiceNo,
          "RED",
          src.title,
          src.tax_no,
          round2(-amount),
          src.folio_id,
          src.folio_no,
          src.stay_id,
          src.guest_name,
          src.room_no,
          bizDate,
          operator,
          remark,
          src.id,
          // 红冲票自身是「已开具」的有效记录；原票才被标记为已红冲
          "ISSUED",
          nowIso(),
        ]
      );
      run(`UPDATE invoices SET status = 'RED' WHERE id = ? AND hotel_id = ?`, [src.id, hotel]);
      return inserted.lastInsertRowid;
    });
    return { ok: true, id: newId, invoiceNo };
  } catch (e) {
    const msg = failText(e);
    if (/UNIQUE/i.test(msg)) {
      /*
       * 唯一约束冲突翻译成前台看得懂的话（第七轮整改清单一.3）
       *
       * 并发红冲同一张原票时，两个请求都能通过应用层的「已存在 red_of？」查询
       * （它们互相还看不见对方未提交的行），随后后提交的那个会撞上
       * idx_invoices_red_of —— 这里必须返回「该发票已红冲」，不能把
       * `UNIQUE constraint failed: invoices.hotel_id, invoices.red_of` 抛到页面上。
       *
       * 另一个可能命中的是 idx_invoices_no（红冲票号被抢），文案不同，别混。
       * SQLite 通常报列名列表，少数版本报索引名，两种形式都认。
       */
      if (/red_of|idx_invoices_red_of/i.test(msg)) {
        return { error: `发票 ${src.invoice_no} 已红冲，不能重复红冲` };
      }
      return { error: `红冲票号 ${invoiceNo} 冲突，请重试` };
    }
    return { error: "红冲失败，请稍后重试" };
  }
}

/* ============================================================ 查询 */

/**
 * 台账查询。
 *
 * @param filter 账单 / 单日 / 区间 / 状态过滤 + limit（默认 200，上限 2000）
 * @returns 按营业日倒序、同一天按 id 倒序（最新的在最上面）
 */
export function listInvoices(hotelId: number, filter: InvoiceFilter = {}): InvoiceRow[] {
  ensureInvoiceSchema();

  const hotel = Math.trunc(Number(hotelId));
  if (!(hotel > 0)) return [];

  const where: string[] = ["hotel_id = ?"];
  const params: unknown[] = [hotel];

  const folioId = Math.trunc(Number(filter.folioId ?? 0));
  if (Number.isFinite(folioId) && folioId > 0) {
    where.push("folio_id = ?");
    params.push(folioId);
  }
  const bizDate = (filter.bizDate ?? "").trim();
  if (DATE_RE.test(bizDate)) {
    where.push("biz_date = ?");
    params.push(bizDate);
  }
  const from = (filter.from ?? "").trim();
  if (DATE_RE.test(from)) {
    where.push("biz_date >= ?");
    params.push(from);
  }
  const to = (filter.to ?? "").trim();
  if (DATE_RE.test(to)) {
    where.push("biz_date <= ?");
    params.push(to);
  }
  const status = (filter.status ?? "").trim();
  if (status) {
    where.push("status = ?");
    params.push(status);
  }

  const limitRaw = Math.trunc(Number(filter.limit ?? DEFAULT_LIMIT));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  params.push(limit);

  const rows = all<InvoiceRow>(
    `SELECT id, hotel_id, invoice_no, invoice_type, title, tax_no, amount,
            folio_id, folio_no, stay_id, guest_name, room_no,
            biz_date, operator, remark, red_of, status, created_at
       FROM invoices
      WHERE ${where.join(" AND ")}
      ORDER BY biz_date DESC, id DESC
      LIMIT ?`,
    params
  );

  return rows.map((r) => ({ ...r, amount: round2(Number(r.amount ?? 0)) }));
}

/**
 * 开票统计（营业日闭区间，缺省统计全部）。
 *
 *   issued  已开票金额：正常票合计（含后来被红冲的，因为「开过」是事实）
 *   red     红冲金额：红冲票绝对值合计
 *   net     净开票额 = issued - red（红冲等于撤销，净额自动回落）
 *
 * 已作废（VOID）的记录不计入任何一项 —— 作废票视为从未生效。
 */
export function invoiceStats(
  hotelId: number,
  from?: string,
  to?: string
): { issued: number; red: number; net: number } {
  ensureInvoiceSchema();

  const hotel = Math.trunc(Number(hotelId));
  if (!(hotel > 0)) return { issued: 0, red: 0, net: 0 };

  const where: string[] = ["hotel_id = ?", "status <> 'VOID'"];
  const params: unknown[] = [hotel];
  const f = (from ?? "").trim();
  if (DATE_RE.test(f)) {
    where.push("biz_date >= ?");
    params.push(f);
  }
  const t = (to ?? "").trim();
  if (DATE_RE.test(t)) {
    where.push("biz_date <= ?");
    params.push(t);
  }

  const row = get<{ issued: number; red: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN invoice_type = 'NORMAL' THEN amount ELSE 0 END), 0) AS issued,
       COALESCE(SUM(CASE WHEN invoice_type = 'RED' THEN -amount ELSE 0 END), 0) AS red
     FROM invoices
    WHERE ${where.join(" AND ")}`,
    params
  );

  const issued = round2(Number(row?.issued ?? 0));
  const red = round2(Number(row?.red ?? 0));
  return { issued, red, net: round2(issued - red) };
}

/** 某张账单的已开票净额（页面提示「还可开 ¥X」用） */
export function getFolioInvoiced(hotelId: number, folioId: number): number {
  ensureInvoiceSchema();
  const hotel = Math.trunc(Number(hotelId));
  const fid = Math.trunc(Number(folioId));
  if (!(hotel > 0) || !(fid > 0)) return 0;
  return folioNetInvoiced(hotel, fid);
}
