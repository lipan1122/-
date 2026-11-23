"use server";

import { revalidatePath } from "next/cache";
import { recalcFolioBalance } from "@/lib/folio";
import { redirect } from "next/navigation";
import { all, get, getDb, run, tx } from "@/lib/db";
import { requirePermission, requirePermissionOrRedirect } from "@/lib/session";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";

/**
 * 商超销售（整改报告第六轮 一.2）
 *
 * 改造前：sellAction / sellCartAction / toggleItemStatusAction 只 requireUser()，
 * 任何登录账号都能卖货、改商品状态；挂房账不校验财务权限；
 * 库存扣减、账单入账、销售流水也没有被保证在同一个事务里（挂账时房号查不到就静默跳过，
 * 库存照扣、流水照写，客人房间却没记账）。本文件按清单逐条收紧：
 *
 *   · 销售 / 购物车结算      → cashier.receive（消费确认，与早餐核销同口径）
 *   · 挂房账（room_no 非空）  → 额外 cashier.charge_company（清单明确要求；
 *                              /shop 的可见角色是 admin + cashier，二者都持有该权限点）
 *   · 商品上下架              → settings.manage（配置变更）
 *   · 撤销销售（本轮新增）    → cashier.refund + 必填原因 + 二次确认（页面 ConfirmForm）
 *   · request_id 幂等         → shop_sales.request_id 上有部分唯一索引（迁移早已建好），
 *                              本文件补上真正使用它的代码；重复 request_id 不再重复销售
 *   · 库存扣减 / 账单入账 / 销售流水 → 同一个 tx() 内完成，任何一步不满足整单回滚
 *   · 库存不能为负            → 条件更新 stock >= qty，changes === 0 即回滚
 *   · 每笔写操作              → op_logs
 *
 * 跨酒店：shop_items / shop_sales / folios / stays 的每条 SQL 都带 hotel_id。
 */

type ShopItemRow = { id: number; name: string; price: number; stock: number; status: string };

type StayFolioRow = { stay_id: number; guest_name: string | null; folio_id: number | null };

type ShopSaleRow = {
  id: number;
  item_name: string;
  qty: number;
  amount: number;
  method: string | null;
  room_no: string | null;
  voided_at: string | null;
};

/**
 * 购物车明细行
 *
 * 前端提交 `items = [{ item_id, qty }, ...]`（整改报告 二：必须提交完整明细数组）。
 * 老调用方（历史表单 / 手工调用 / 旧验收脚本）只带 item_id（+ qty），按单商品兼容。
 */
type CartLine = { item_id: number; qty: number };

/** 幂等查重用的最小流水行（重放时按它的字段回显「原单已成交」） */
type SoldSaleRow = {
  id: number;
  hotel_id: number;
  item_name: string;
  qty: number;
  amount: number;
  method: string | null;
  room_no: string | null;
  order_no: string | null;
};

/** 拆好、校验过、可以直接落库的一行（金额在事务内按数据库里的价格算，绝不信任前端传的价） */
type CartPlan = { id: number; name: string; price: number; qty: number; amount: number };


/** 事务内业务失败：抛出去让 tx() 回滚，外层统一转成页面提示 */
class ShopTxError extends Error {}

/**
 * 幂等重放：同一个 request_id 已经成交过，本次不再写任何东西
 *
 * 第七轮 一.2 的要求是「第二次提交返回成功（幂等 replay）而不是报错」——
 * 所以它不能走 ShopTxError（那会跳 ?err= 让收银员以为失败了去重试）。
 * 抛它只是为了从 tx() 里带着原单信息干净地退出来，catch 里立刻转成 ?msg= 成功横幅。
 */
class ShopReplayedError extends Error {
  /* 不用 constructor 参数属性：Node 原生剥类型（strip-only）不支持，写成普通字段 */
  readonly sale: SoldSaleRow;
  constructor(sale: SoldSaleRow) {
    super("该请求已处理（幂等重放）");
    this.sale = sale;
  }
}

/** 商品种子：10 个常见商超商品 */
const SHOP_SEED: { name: string; barcode: string; price: number; stock: number; category: string }[] = [
  { name: "恒大冰泉 550ml", barcode: "6901234500011", price: 3, stock: 120, category: "饮品" },
  { name: "康师傅红烧牛肉面", barcode: "6901234500028", price: 6, stock: 60, category: "食品" },
  { name: "一次性拖鞋", barcode: "6901234500035", price: 15, stock: 40, category: "日用品" },
  { name: "牙具套装", barcode: "6901234500042", price: 10, stock: 50, category: "日用品" },
  { name: "雨伞", barcode: "6901234500059", price: 25, stock: 12, category: "日用品" },
  { name: "南孚电池 5 号", barcode: "6901234500066", price: 8, stock: 30, category: "日用品" },
  { name: "蒙牛纯牛奶 250ml", barcode: "6901234500073", price: 5.5, stock: 48, category: "饮品" },
  { name: "乐事薯片 70g", barcode: "6901234500080", price: 7.5, stock: 36, category: "食品" },
  { name: "全棉毛巾", barcode: "6901234500097", price: 20, stock: 25, category: "日用品" },
  { name: "蓝月亮洗衣液 500ml", barcode: "6901234500103", price: 18, stock: 18, category: "日用品" },
];

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 操作日志：op_logs 缺失（旧库）时静默跳过，审计失败不影响销售 */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string): void {
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
}

/**
 * 请求幂等标识
 *
 * 客户端带 request_id（按钮双击、网络重试、表单重放）时按它去重；
 * 没带就生成一个唯一值 —— 不能留空，否则两条空值在唯一索引里不会冲突，
 * 「重复提交」会重新变成两笔销售。
 */
function resolveRequestId(formData: FormData): string {
  const raw = str(formData.get("request_id"));
  if (raw) return raw.slice(0, 64);
  return `auto-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 幂等查重：这个 request_id 在本酒店是否已经有销售流水
 *
 * 保留第六轮那条判定 SQL 的原文（脚本 scripts/test-shop-permissions.mjs 会静态断言它），
 * 拿到 id 之后再补齐重放时要用到的字段。
 */
function settledSaleOf(hotelId: number, requestId: string): SoldSaleRow | undefined {
  const hit = get<{ id: number }>(
    `SELECT id FROM shop_sales WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
    [hotelId, requestId]
  );
  if (!hit) return undefined;
  return get<SoldSaleRow>(
    `SELECT id, hotel_id, item_name, qty, amount, method, room_no, order_no FROM shop_sales WHERE id = ? AND hotel_id = ?`,
    [hit.id, hotelId]
  );
}

/**
 * 整单汇总（多商品单）
 *
 * 多商品购物车按「一行一个商品」写 shop_sales，request_id 只落在首行
 * （shop_sales(hotel_id, request_id) 是唯一索引，多行都带会被自己挡下来）。
 * 为了让同一单的所有行仍可整体追溯 / 对账，同时写 order_no = request_id，
 * 这里按 order_no 汇总行数与金额，用于幂等重放的提示与前台账面核对。
 */
function orderTotalsOf(hotelId: number, orderNo: string): { n: number; total: number } | undefined {
  if (!orderNo) return undefined;
  return get<{ n: number; total: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM shop_sales WHERE hotel_id = ? AND order_no = ?`,
    [hotelId, orderNo]
  );
}

/**
 * 幂等重放的跳转地址
 *
 * 必须走 ?msg=（成功横幅）而不是 ?err=：
 *   · 页面按它显示绿色成功提示；
 *   · ShopPOS 据此认为「已成交」，清空购物车并换下一枚 request_id。
 * 用 err= 的话前端会当成失败保留同一枚 request_id，同一单就再也卖不出去了。
 */
function replayUrl(sale: SoldSaleRow): string {
  const order = orderTotalsOf(sale.hotel_id, sale.order_no ?? "");
  const body =
    order && order.n > 1
      ? `本单 ${order.n} 行，合计 ${fmtMoney(Number(order.total ?? 0))}`
      : `${sale.item_name} ×${Number(sale.qty ?? 0)}，${fmtMoney(Number(sale.amount ?? 0))}`;
  return `/shop?msg=${encodeURIComponent(
    `该请求已处理（幂等重放），本次未重复销售：${body}${
      sale.room_no ? ` → 房 ${sale.room_no}` : sale.method ? ` · ${sale.method}` : ""
    }`
  )}`;
}

/**
 * 唯一索引冲突识别（并发兜底）
 *
 * 两个同 request_id 的请求同时通过事务内查重时，后写的那一个会被
 * shop_sales(hotel_id, request_id) 的部分唯一索引拒绝（node:sqlite 抛
 * UNIQUE constraint failed: shop_sales.hotel_id, shop_sales.request_id）。
 * 那不是业务失败 —— 先手已经成交，按幂等重放返回成功。
 */
function isRequestIdConflict(e: unknown): boolean {
  const message = String((e as Error)?.message ?? e);
  return /UNIQUE constraint failed: shop_sales\./i.test(message);
}

/** 幂等兜底：撞唯一索引时重新查一次，查到了就当作重放 */
function replayIfRaced(hotelId: number, requestId: string, e: unknown): SoldSaleRow | undefined {
  if (!isRequestIdConflict(e)) return undefined;
  return settledSaleOf(hotelId, requestId);
}

/** shop_sales 的补列：旧库可能缺 request_id / 作废字段 */
let salesSchemaReady = false;

function ensureShopSalesTable(): void {
  if (salesSchemaReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS shop_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      item_name TEXT,
      qty INTEGER DEFAULT 1,
      amount REAL DEFAULT 0,
      method TEXT,
      room_no TEXT,
      created_at TEXT,
      request_id TEXT
    );
  `);

  const cols = new Set(all<{ name: string }>(`PRAGMA table_info(shop_sales)`).map((c) => c.name));
  for (const [name, ddl] of [
    ["request_id", "ALTER TABLE shop_sales ADD COLUMN request_id TEXT"],
    ["voided_at", "ALTER TABLE shop_sales ADD COLUMN voided_at TEXT"],
    ["void_reason", "ALTER TABLE shop_sales ADD COLUMN void_reason TEXT"],
    /*
     * 整单号（多商品单）：request_id 只落首行（唯一索引限制），
     * order_no 让同一单的所有商品行仍能被整体查询 / 对账 / 汇总。
     */
    ["order_no", "ALTER TABLE shop_sales ADD COLUMN order_no TEXT"],
  ] as const) {
    if (cols.has(name)) continue;
    try {
      getDb().exec(ddl);
    } catch {
      /* 并发下另一个进程刚补过这列：忽略 */
    }
  }
  /* 部分唯一索引：只约束「真的带 request_id」的行，历史空值行不受影响 */
  getDb().exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sales_request
       ON shop_sales(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );
  getDb().exec(`CREATE INDEX IF NOT EXISTS idx_shop_sales_order ON shop_sales(hotel_id, order_no)`);
  salesSchemaReady = true;
}

/**
 * 商超库存流水表 shop_stock_flows
 *
 * 为什么不写 goods_flows：goods_flows.goods_id 指向**仓库商品** goods 表
 * （进货 / 退货 / 报废 / 销售，/goods 页面按 goods_id 关联展示变动后结存）。
 * 商超商品在 shop_items 里是另一套台账，把 shop_items.id 塞进 goods_flows.goods_id
 * 会让 /goods 的流水把毫不相干的仓库商品串成一条（两套自增 id 必然撞车），
 * 等于用「修商超」的名义污染现有仓库账。
 * 所以商超单独记账，字段与 goods_flows 对齐（type / qty / stock_after / unit_price /
 * amount / note / operator / created_at），以后要合并报表直接 UNION 即可。
 */
let stockFlowReady = false;

function ensureShopStockFlowTable(): void {
  if (stockFlowReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS shop_stock_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      qty INTEGER NOT NULL,
      stock_after INTEGER NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      sale_id INTEGER,
      request_id TEXT,
      note TEXT,
      operator TEXT,
      created_at TEXT NOT NULL
    );
  `);
  getDb().exec(
    `CREATE INDEX IF NOT EXISTS idx_shop_stock_flows_item ON shop_stock_flows (hotel_id, item_id, type)`
  );
  stockFlowReady = true;
}

/** 写一条商超库存流水（调用方必须已经在同一个 tx() 里改完 shop_items.stock） */
function writeShopFlow(flow: {
  hotelId: number;
  itemId: number;
  type: "SELL" | "VOID";
  qty: number;
  stockAfter: number;
  unitPrice: number;
  amount: number;
  saleId: number | null;
  requestId: string | null;
  note: string;
  operator: string;
  createdAt: string;
}): void {
  run(
    `INSERT INTO shop_stock_flows
       (hotel_id, item_id, type, qty, stock_after, unit_price, amount, sale_id, request_id, note, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      flow.hotelId,
      flow.itemId,
      flow.type,
      flow.qty,
      flow.stockAfter,
      flow.unitPrice,
      flow.amount,
      flow.saleId,
      flow.requestId,
      flow.note,
      flow.operator,
      flow.createdAt,
    ]
  );
}

/** 懒建表 + 首次种子：第一次访问时建 shop_items / shop_sales 并写入 10 个商品 */
function ensureShopSchema(hotelId: number): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      barcode TEXT,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      category TEXT,
      status TEXT DEFAULT 'ON',
      created_at TEXT
    );
  `);
  ensureShopSalesTable();
  ensureShopStockFlowTable();

  const existing =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM shop_items WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (existing > 0) return;

  const now = nowIso();
  for (const item of SHOP_SEED) {
    run(
      `INSERT INTO shop_items (hotel_id, name, barcode, price, stock, category, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [hotelId, item.name, item.barcode, item.price, item.stock, item.category, "ON", now]
    );
  }
}

/**
 * 页面渲染前补齐表结构（旧库可能还没有 voided_at 等列）
 *
 * 与 goods 的 ensureGoodsSchema 同一手法：这种「建表 / 补列」助手不该是可匿名调的 RPC。
 * 页面本身已鉴权，这里只做结构兜底。
 *
 * 权限（整改 A 类缺口）：原来只有 requireUser() —— 它是 DDL 写入，属写动作。
 * 为什么是 cashier.view：/shop 的可见角色是 admin + cashier，二者都持有该点，
 * 补守卫既能拦住客房/前台直接 POST，又不会把收银挡在自己页面之外
 * （不能直接套销售用的 cashier.receive，否则「只是渲染页面」就要求收款权限，
 *   语义过重；这里要的是「这个人在商超这个模块里」）。
 */
export async function ensureShopPageSchema(hotelId: number): Promise<void> {
  const user = await requirePermissionOrRedirect("cashier.view");
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化商超数据");
  ensureShopSchema(hotelId);
}

/** 今日商超销售流水（供页面与重新校验共用） */
function revalidateShop() {  revalidatePath("/shop");
  revalidatePath("/cashier");
  revalidatePath("/inhouse");
  revalidatePath("/today-todo");
}

/** 在住客人的账单：没有就补建一张，绝不「库存扣了、账单没记」 */
function ensureStayFolio(hotelId: number, stay: StayFolioRow, roomNo: string, now: string): number {
  if (stay.folio_id) return stay.folio_id;
  const nextId = get<{ m: number | null }>(`SELECT COALESCE(MAX(id), 0) AS m FROM folios`)?.m ?? 0;
  return run(
    `INSERT INTO folios
       (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [hotelId, `F${nextId + 1 + 2000}`, stay.stay_id, stay.guest_name ?? "客人", roomNo, 0, 0, 0, "OPEN", now]
  ).lastInsertRowid;
}

/**
 * 商超销售挂房账：
 * 1. 校验商品状态与库存（条件更新，库存不可能被扣成负数）
 * 2. 写入 folio_items（item_type = OTHER，摘要「商超：商品名」）
 * 3. 写销售流水 shop_sales（含 request_id，重复请求在这里被唯一索引挡住）
 * 4. 重算账单合计 / 应收余额
 *
 * 以上四步在同一个事务里；任何一步失败整单回滚，不会出现「库存扣了钱没记」。
 */
export async function sellAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  const hotelId = user.hotelId;
  ensureShopSchema(hotelId);
  /*
   * 本动作只做挂房账（必须给 room_no），本质是把消费记到客人的账单上，
   * 与「挂公司账」同属账务授权动作，清单要求额外校验 cashier.charge_company。
   */
  await requirePermission("cashier.charge_company");

  /** 失败回跳地址：把错误文案带回页面横幅 */
  const failUrl = (message: string) => `/shop?err=${encodeURIComponent(message)}`;

  const rawItemId = Number(str(formData.get("item_id")));
  const itemId = Number.isFinite(rawItemId) && rawItemId > 0 ? Math.trunc(rawItemId) : 0;
  const rawQty = Number(str(formData.get("qty")));
  const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(99, Math.trunc(rawQty)) : 0;
  const roomNo = str(formData.get("room_no"));
  const requestId = resolveRequestId(formData);

  /*
   * 幂等第一道闸（第七轮 一.2）：这个 request_id 已经成交过 → 直接按首次结果返回成功。
   * 放在业务校验之前 —— 重放请求即使商品已下架、客人已退房，也应该得到「已处理」，
   * 而不是一条会把收银员引去重新下单的错误。
   */
  const settledBefore = settledSaleOf(hotelId, requestId);
  if (settledBefore) redirect(replayUrl(settledBefore));

  if (!itemId) redirect(failUrl("请选择要销售的商品"));
  if (!qty) redirect(failUrl("请填写正确的销售数量（1-99）"));
  if (!roomNo) redirect(failUrl("请填写挂账房号"));

  const item = get<ShopItemRow>(
    `SELECT id, name, price, stock, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
    [itemId, hotelId]
  );
  if (!item) redirect(failUrl("商品不存在或已被删除"));
  if (item.status !== "ON") redirect(failUrl(`商品「${item.name}」已下架，不能销售`));

  const stay = get<StayFolioRow>(
    `SELECT s.id AS stay_id, s.guest_name, f.id AS folio_id
     FROM stays s
     JOIN rooms r ON r.id = s.room_id
     LEFT JOIN folios f ON f.stay_id = s.id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND r.room_no = ?
     ORDER BY s.id DESC
     LIMIT 1`,
    [hotelId, roomNo]
  );
  if (!stay) redirect(failUrl(`房号 ${roomNo} 当前没有在住客人，无法挂房账`));

  const today = todayStr();
  const now = nowIso();
  const amount = round2(item.price * qty);

  try {
    tx(() => {
      /* 幂等：同一个 request_id 只允许产生一笔交易（并发时还有唯一索引兜底） */
      const duplicated = settledSaleOf(hotelId, requestId);
      if (duplicated) throw new ShopReplayedError(duplicated);

      /* 条件扣减：库存不足时 changes === 0，整单回滚 */
      const dec = run(
        `UPDATE shop_items SET stock = stock - ? WHERE id = ? AND hotel_id = ? AND stock >= ?`,
        [qty, itemId, hotelId, qty]
      );
      if (dec.changes === 0) throw new ShopTxError(`商品「${item.name}」库存不足（当前 ${item.stock} 件）`);

      const folioId = ensureStayFolio(hotelId, stay, roomNo, now);
      run(
        `INSERT INTO folio_items
           (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [hotelId, folioId, "OTHER", `商超：${item.name}`, qty, item.price, amount, today, now, user.id]
      );

      /* 销售流水与库存、账单同事务落地 */
      const saleId = run(
        `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, order_no, request_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [hotelId, item.name, qty, amount, `挂账 ${roomNo}`, roomNo, now, requestId, requestId]
      ).lastInsertRowid;

      /* 库存变动必须有库存流水：单商品挂账走这里，购物车走 sellCartAction，两边口径一致 */
      writeShopFlow({
        hotelId,
        itemId,
        type: "SELL",
        qty,
        stockAfter: Number(
          get<{ stock: number }>(`SELECT stock FROM shop_items WHERE id = ? AND hotel_id = ?`, [itemId, hotelId])
            ?.stock ?? 0
        ),
        unitPrice: Number(item.price),
        amount,
        saleId,
        requestId,
        note: `挂账房 ${roomNo} · 商超挂账 单 ${saleId}`,
        operator: user.realName || user.username,
        createdAt: now,
      });

      /* 统一走公共重算（P0-4）：部分结账负项的排除规则只写一份，避免各入口算出不同余额 */
      recalcFolioBalance(hotelId, folioId);

      writeOpLog(
        hotelId,
        user.realName || user.username,
        "商超挂房账",
        `销售单 ${saleId} · ${item.name} ×${qty} · ${fmtMoney(amount)} · 房 ${roomNo} · 客人 ${
          stay.guest_name ?? "客人"
        } · request_id ${requestId}`
      );
    });
  } catch (e) {
    if (e instanceof ShopReplayedError) redirect(replayUrl(e.sale));
    if (e instanceof ShopTxError) redirect(failUrl(e.message));
    /* 并发兜底：两个同 request_id 的请求同时通过查重时，后写的会撞唯一索引 */
    const raced = replayIfRaced(hotelId, requestId, e);
    if (raced) redirect(replayUrl(raced));
    throw e;
  }

  revalidateShop();
  redirect(
    `/shop?msg=${encodeURIComponent(
      `已挂房账：${item.name} ×${qty}，${fmtMoney(amount)} → 房 ${roomNo} ${stay.guest_name ?? "客人"}`
    )}`
  );
}

/** 商品上架 / 下架切换 */
export async function toggleItemStatusAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  ensureShopSchema(user.hotelId);

  const id = Number(str(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) return;

  const item = get<{ id: number; name: string; status: string }>(
    `SELECT id, name, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
    [Math.trunc(id), user.hotelId]
  );
  if (!item) return;

  const next = item.status === "ON" ? "OFF" : "ON";
  run(`UPDATE shop_items SET status = ? WHERE id = ? AND hotel_id = ?`, [next, item.id, user.hotelId]);

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "商超商品上下架",
    `商品 ${item.id} · ${item.name} · ${item.status} → ${next}`
  );

  revalidatePath("/shop");
}

/** 单笔结算最多几种商品（挡住异常超长 payload，避免一次事务里跑上千次查询） */
const CART_MAX_LINES = 50;

/** 单个商品一次最多卖多少件（与 sellAction 的 1-99 同一口径） */
const LINE_MAX_QTY = 99;

/**
 * 解析购物车明细（整改报告 二：前端必须提交完整明细数组）
 *
 * 新格式（优先）：
 *   items = [{ "item_id": 1, "qty": 1 }, { "item_id": 2, "qty": 1 }]
 * 旧格式（items 缺失时兼容老调用方）：
 *   item_id（可逗号分隔多个）+ qty —— 单个 id 用 qty 件；多个 id 时每件 1 件，
 *   与改造前的口径完全一致，历史调用不会因为本轮改造少卖或多卖。
 *
 * 同一个 item_id 出现多次会合并数量：一行一个商品，库存流水与销售流水都是一行一条，
 * 不合并的话同一商品会被拆成两条流水，对账时分不清是同一件还是两件。
 *
 * 任何一行不合法（商品 id 不是正整数 / qty 不是正数）一律判定**整单非法**：
 * 绝不能悄悄丢掉那一行接着卖，否则又回到「购物车里有东西没结算」的老问题。
 */
function parseCartLines(formData: FormData): { lines: CartLine[]; invalid: boolean } {
  const merged = new Map<number, number>();
  const add = (rawId: unknown, rawQty: unknown): boolean => {
    const id = Math.trunc(Number(rawId));
    const qty = Math.trunc(Number(rawQty));
    if (!Number.isFinite(id) || id <= 0) return false;
    if (!Number.isFinite(qty) || qty <= 0) return false;
    merged.set(id, Math.min(LINE_MAX_QTY, (merged.get(id) ?? 0) + qty));
    return true;
  };
  const toLines = (): CartLine[] => [...merged.entries()].map(([item_id, qty]) => ({ item_id, qty }));

  const rawItems = str(formData.get("items"));
  if (rawItems) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawItems);
    } catch {
      return { lines: [], invalid: true };
    }
    if (!Array.isArray(parsed)) return { lines: [], invalid: true };
    for (const entry of parsed) {
      const row = entry as { item_id?: unknown; qty?: unknown } | null;
      if (!add(row?.item_id, row?.qty)) return { lines: [], invalid: true };
    }
    return { lines: toLines(), invalid: false };
  }

  /* 兼容旧调用：item_id（可逗号分隔）+ qty */
  const legacyIds = str(formData.get("item_id"))
    .split(",")
    .map((x) => Math.trunc(Number(x)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rawQty = Math.trunc(Number(str(formData.get("qty"))));
  const singleQty = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(LINE_MAX_QTY, rawQty) : 1;
  for (const id of legacyIds) {
    if (!add(id, legacyIds.length === 1 ? singleQty : 1)) return { lines: [], invalid: true };
  }
  return { lines: toLines(), invalid: false };
}

/**
 * 购物车结算（去呼呼前台售卖：多商品、现金或挂房账）
 *
 * 整改报告 二（多商品购物车）的核心改动：
 *   1. 前端提交 items = [{ item_id, qty }, ...]，本动作逐行解析（旧 item_id 仍兼容）；
 *   2. 逐商品校验「存在 + 上架 + 库存够」，任何一行不合格 → 整单取消、整单回滚，
 *      绝不会出现「扣了甲商品的库存、乙商品没扣」这种半截账；
 *   3. 同一个 tx() 内按顺序落库：逐商品条件扣库存 → 逐商品写库存流水 → 逐商品写销售流水
 *      → （挂账时）逐商品写 folio_items → 重算账单；
 *   4. 金额一律按数据库里的 price × qty 汇总，不采信前端传来的任何金额；
 *   5. 幂等：request_id 反复提交只有第一单成交（唯一索引 + 两道查重）；
 *      request_id 只落首行（唯一索引限制），同单所有行的 order_no = request_id 便于整单对账；
 *   6. 现金只写 shop_sales；挂房账额外每商品一条 folio_items，账单上能按商品逐条核对与撤销。
 */
export async function sellCartAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  const hotelId = user.hotelId;
  ensureShopSchema(hotelId);

  const failUrl = (message: string) => `/shop?err=${encodeURIComponent(message)}`;

  const operator = user.realName || user.username;
  const method = str(formData.get("method")) || "现金";
  const roomNo = str(formData.get("room_no"));
  const requestId = resolveRequestId(formData);

  /* 挂房账是账务授权动作：清单要求额外校验 cashier.charge_company */
  if (roomNo) await requirePermission("cashier.charge_company");

  /*
   * 幂等第一道闸（第七轮 一.2）：同一个 request_id 已经成交过 → 按首次结果返回成功。
   * 双击的第二下、网络重试的那一次都会走到这里，得到的是成功横幅而不是错误，
   * 所以前端不会把它当成失败去反复重试。
   * 放在明细解析之前：重放请求即使购物车已清空 / 商品已下架，也应该拿到「已处理」。
   */
  const settledBefore = settledSaleOf(hotelId, requestId);
  if (settledBefore) redirect(replayUrl(settledBefore));

  const parsed = parseCartLines(formData);
  if (parsed.invalid) {
    redirect(failUrl("购物车明细里有非法商品行（商品或数量不合法），整单已取消。请刷新页面重新加购"));
  }
  const lines = parsed.lines;
  const ids = lines.map((line) => line.item_id);
  if (ids.length === 0) redirect(failUrl("购物车为空，请先选择商品"));
  if (ids.length > CART_MAX_LINES) redirect(failUrl(`单笔结算最多 ${CART_MAX_LINES} 种商品，请分单结算`));

  const now = nowIso();
  const today = todayStr();
  let outcome: { names: string[]; total: number; count: number; qty: number; orderNo: string };

  try {
    outcome = tx(() => {
      /* 幂等：同一个 request_id 只允许产生一笔交易（并发时还有唯一索引兜底） */
      const duplicated = settledSaleOf(hotelId, requestId);
      if (duplicated) throw new ShopReplayedError(duplicated);

      /* ① 逐商品预校验（只读）：商品存在 / 上架 / 库存够，任何一条不合格整单不写库 */
      const plans: CartPlan[] = [];
      for (const line of lines) {
        const item = get<ShopItemRow>(
          `SELECT id, name, price, stock, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
          [line.item_id, hotelId]
        );
        if (!item) throw new ShopTxError(`商品 #${line.item_id} 不存在或已被删除，整单已取消`);
        if (item.status !== "ON") throw new ShopTxError(`商品「${item.name}」已下架，整单已取消`);
        if (Number(item.stock) < line.qty) {
          throw new ShopTxError(
            `商品「${item.name}」库存不足（需要 ${line.qty} 件，当前 ${item.stock} 件），整单已取消`
          );
        }
        plans.push({
          id: item.id,
          name: item.name,
          price: Number(item.price),
          qty: line.qty,
          amount: round2(Number(item.price) * line.qty),
        });
      }

      /* ② 挂房账前置校验：房号必须真有在住客人，查不到就整单回滚（库存一件都不扣、流水一条不写） */
      let stay: StayFolioRow | undefined;
      if (roomNo) {
        stay = get<StayFolioRow>(
          `SELECT s.id AS stay_id, s.guest_name, f.id AS folio_id
             FROM stays s JOIN rooms r ON r.id = s.room_id
             LEFT JOIN folios f ON f.stay_id = s.id
            WHERE s.hotel_id = ? AND r.room_no = ? AND s.status = 'INHOUSE'
            ORDER BY s.id DESC LIMIT 1`,
          [hotelId, roomNo]
        );
        if (!stay) throw new ShopTxError(`房号 ${roomNo} 当前没有在住客人，整单已取消（库存未扣、流水未记）`);
      }

      /* ③ 逐商品：条件扣库存（stock >= qty）→ 库存流水 → 销售流水 */
      const names: string[] = [];
      const saleIds: number[] = [];
      let total = 0;
      let qtyTotal = 0;
      for (const plan of plans) {
        const dec = run(
          `UPDATE shop_items SET stock = stock - ? WHERE id = ? AND hotel_id = ? AND stock >= ?`,
          [plan.qty, plan.id, hotelId, plan.qty]
        );
        if (dec.changes === 0) {
          /* 预校验之外再挡一次：两人同时买最后一件时，条件更新才是真正的并发闸 */
          throw new ShopTxError(`商品「${plan.name}」库存不足（需要 ${plan.qty} 件），整单已取消`);
        }
        const stockAfter = Number(
          get<{ stock: number }>(`SELECT stock FROM shop_items WHERE id = ? AND hotel_id = ?`, [plan.id, hotelId])
            ?.stock ?? 0
        );

        const saleId = run(
          `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, order_no, request_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            plan.name,
            plan.qty,
            plan.amount,
            roomNo ? `挂账 ${roomNo}` : method,
            roomNo || null,
            now,
            /* 整单号：同单每一行都写，便于整单查询 / 对账 / 汇总 */
            requestId,
            /* 部分唯一索引只约束非空 request_id：同一单只把幂等标识记在首行 */
            saleIds.length === 0 ? requestId : null,
          ]
        ).lastInsertRowid;

        writeShopFlow({
          hotelId,
          itemId: plan.id,
          type: "SELL",
          qty: plan.qty,
          stockAfter,
          unitPrice: plan.price,
          amount: plan.amount,
          saleId,
          requestId,
          note: `${roomNo ? `挂账房 ${roomNo}` : method} · 商超销售 单 ${saleId}`,
          operator,
          createdAt: now,
        });

        saleIds.push(saleId);
        names.push(plan.name);
        total += plan.amount;
        qtyTotal += plan.qty;
      }

      /* ④ 挂房账：每个商品一条 folio_items（账单上可按商品逐条核对、逐条撤销） */
      if (roomNo && stay) {
        const folioId = ensureStayFolio(hotelId, stay, roomNo, now);
        for (const plan of plans) {
          run(
            `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [hotelId, folioId, "OTHER", `商超：${plan.name}`, plan.qty, plan.price, plan.amount, today, now, user.id]
          );
        }
        /* 不再增量累加（部分结账后累加会把负项算漏），统一重算 */
        recalcFolioBalance(hotelId, folioId);
      }

      return { names, total: round2(total), count: names.length, qty: qtyTotal, orderNo: requestId };
    });
  } catch (e) {
    if (e instanceof ShopReplayedError) redirect(replayUrl(e.sale));
    if (e instanceof ShopTxError) redirect(failUrl(e.message));
    /* 并发兜底：两个同 request_id 的请求同时通过查重时，后写的会撞唯一索引 */
    const raced = replayIfRaced(hotelId, requestId, e);
    if (raced) redirect(replayUrl(raced));
    throw e;
  }

  writeOpLog(
    hotelId,
    operator,
    "商超结算",
    `${outcome.count} 种 ${outcome.qty} 件 · 合计 ${fmtMoney(outcome.total)} · ${
      roomNo ? `挂账房 ${roomNo}` : method
    } · 商品 ${outcome.names.join("、")} · 整单号 ${outcome.orderNo}`
  );

  revalidateShop();
  redirect(
    `/shop?msg=${encodeURIComponent(
      `已售出 ${outcome.qty} 件（${outcome.count} 种商品），合计 ¥${outcome.total.toFixed(2)}（${
        roomNo ? `挂账 ${roomNo}` : method
      }）`
    )}`
  );
}

/**
 * 撤销销售（退款）
 *
 * 清单要求「退款、撤销销售必须二次确认和权限校验」：
 *   · 权限 → cashier.refund（admin / cashier，与收款分开）
 *   · 原因 → 必填，页面用 ConfirmForm 的 requireReason 收集，同时写进 op_logs
 *   · 账务 → 挂房账的销售在客人账单上补一笔负项并重算；库存回加
 *   · 幂等 → 已撤销的流水不能再撤销
 */
export async function voidSaleAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.refund");
  const hotelId = user.hotelId;
  ensureShopSchema(hotelId);

  const failUrl = (message: string) => `/shop?tab=orders&err=${encodeURIComponent(message)}`;

  const id = Math.trunc(Number(str(formData.get("id"))));
  const reason = str(formData.get("reason")) || str(formData.get("note"));
  if (!id) redirect(failUrl("没有找到要撤销的销售单"));
  if (!reason) redirect(failUrl("撤销销售必须填写原因"));

  const sale = get<ShopSaleRow>(
    `SELECT id, item_name, qty, amount, method, room_no, voided_at
       FROM shop_sales WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!sale) redirect(failUrl("销售单不存在或已被删除"));
  if (sale.voided_at) redirect(failUrl(`销售单 #${id} 已撤销，不能重复撤销`));

  const now = nowIso();
  let outcome: { stockRestored: boolean; folioReversed: boolean };

  try {
    outcome = tx(() => {
      const result = run(
        `UPDATE shop_sales SET voided_at = ?, void_reason = ? WHERE id = ? AND hotel_id = ? AND voided_at IS NULL`,
        [now, reason, id, hotelId]
      );
      if (result.changes === 0) throw new ShopTxError(`销售单 #${id} 已撤销，不能重复撤销`);

      /* 回加库存：shop_sales 只存商品名，按名称在同酒店内找当前商品 */
      const item = get<{ id: number; stock: number }>(
        `SELECT id, stock FROM shop_items WHERE hotel_id = ? AND name = ? ORDER BY id LIMIT 1`,
        [hotelId, sale.item_name]
      );
      if (!item) return { stockRestored: false, folioReversed: true };
      const restoredQty = Math.abs(Math.trunc(Number(sale.qty ?? 1)));
      run(`UPDATE shop_items SET stock = stock + ? WHERE id = ? AND hotel_id = ?`, [
        restoredQty,
        item.id,
        hotelId,
      ]);

      /*
       * 撤销也要有库存流水（type = VOID，qty 记回库的绝对值）：
       * 只回加库存不记流水，shop_stock_flows 的结存就会与 shop_items.stock 对不上，
       * 盘点时查不出这 N 件是怎么回来的。
       */
      writeShopFlow({
        hotelId,
        itemId: item.id,
        type: "VOID",
        qty: restoredQty,
        stockAfter: Number(
          get<{ stock: number }>(`SELECT stock FROM shop_items WHERE id = ? AND hotel_id = ?`, [item.id, hotelId])
            ?.stock ?? 0
        ),
        unitPrice: round2(Number(sale.amount ?? 0) / Math.max(1, restoredQty)),
        amount: Math.abs(round2(Number(sale.amount ?? 0))),
        saleId: id,
        requestId: null,
        note: `撤销销售单 #${id}：${reason}`,
        operator: user.realName || user.username,
        createdAt: now,
      });

      /* 挂房账的销售：在客人账单上补一笔负项冲减（否则账单还欠着这笔钱） */
      let folioReversed = true;
      if (sale.room_no) {
        const folio = get<{ id: number }>(
          `SELECT id FROM folios WHERE hotel_id = ? AND room_no = ? ORDER BY id DESC LIMIT 1`,
          [hotelId, sale.room_no]
        );
        if (!folio) {
          /* 客人已退房 / 账单不存在：账务冲减做不到，如实标记，交给人工追账 */
          folioReversed = false;
        } else {
          run(
            `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, biz_date, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              hotelId,
              folio.id,
              "OTHER",
              `撤销商超:${sale.item_name}${reason ? `（${reason}）` : ""}`,
              -Math.abs(round2(Number(sale.amount ?? 0))),
              1,
              todayStr(),
              now,
            ]
          );
          recalcFolioBalance(hotelId, folio.id);
        }
      }
      return { stockRestored: true, folioReversed };
    });
  } catch (e) {
    if (e instanceof ShopTxError) redirect(failUrl(e.message));
    throw e;
  }

  writeOpLog(
    hotelId,
    user.realName || user.username,
    "商超撤销销售",
    `销售单 ${id} · ${sale.item_name} ×${sale.qty} · 退款 ${fmtMoney(Number(sale.amount ?? 0))} · ${
      sale.room_no ? `挂账房 ${sale.room_no}` : sale.method ?? "现金"
    } · 原因：${reason}${outcome.stockRestored ? "" : " · 未找到同名商品，库存未回加"}${
      outcome.folioReversed ? "" : " · 未找到对应账单，挂账未冲减（需人工处理）"
    }`
  );

  revalidateShop();
  redirect(
    `/shop?tab=orders&msg=${encodeURIComponent(
      `已撤销销售单 #${id}：${sale.item_name} ×${sale.qty}，退款 ¥${Number(sale.amount ?? 0).toFixed(2)}${
        outcome.stockRestored ? "" : "（未找到同名商品，库存未回加）"
      }${outcome.folioReversed ? "" : "（未找到对应账单，挂账未冲减，请人工处理）"}`
    )}`
  );
}
