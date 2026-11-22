"use server";

import { revalidatePath } from "next/cache";
import { recalcFolioBalance } from "@/lib/folio";
import { redirect } from "next/navigation";
import { all, get, getDb, run, tx } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/session";
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

/** 事务内业务失败：抛出去让 tx() 回滚，外层统一转成页面提示 */
class ShopTxError extends Error {}

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
  salesSchemaReady = true;
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
 * 与 goods 的 ensureGoodsSchema 同一手法：这种「建表 / 补列」助手不该是可匿名调的 RPC，
 * 所以补登录守卫 + 酒店归属校验。页面本身已鉴权，这里只做结构兜底。
 */
export async function ensureShopPageSchema(hotelId: number): Promise<void> {
  const user = await requireUser();
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
      /* 幂等：同一个 request_id 只允许产生一笔交易 */
      const duplicated = get<{ id: number }>(
        `SELECT id FROM shop_sales WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
        [hotelId, requestId]
      );
      if (duplicated) throw new ShopTxError("该请求已处理（request_id 重复），本次未重复销售");

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
        `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, request_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [hotelId, item.name, qty, amount, `挂账 ${roomNo}`, roomNo, now, requestId]
      ).lastInsertRowid;

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
    if (e instanceof ShopTxError) redirect(failUrl(e.message));
    throw e;
  }

  revalidateShop();
  redirect(
    `/shop?ok=${encodeURIComponent(
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

/**
 * 购物车结算（去呼呼前台售卖：可多件、现金或挂房账）
 *
 * 与旧实现的三处差异（都属于清单点名的要求）：
 *   1. 库存不足 / 商品下架 / 商品不存在 → 整单失败，不再静默跳过还能报「已售出 N 件」；
 *   2. 挂房账时房号查不到在住单或账单 → 整单回滚（旧代码继续扣库存、写流水，账单却没记）；
 *   3. 扣库存用条件更新 + request_id 幂等，库存不会为负、重复提交不会重复销售。
 */
export async function sellCartAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  const hotelId = user.hotelId;
  ensureShopSchema(hotelId);

  const failUrl = (message: string) => `/shop?err=${encodeURIComponent(message)}`;

  const ids = String(formData.get("item_id") ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
  const method = str(formData.get("method")) || "现金";
  const roomNo = str(formData.get("room_no"));
  const requestId = resolveRequestId(formData);

  /* 挂房账是账务授权动作：清单要求额外校验 cashier.charge_company */
  if (roomNo) await requirePermission("cashier.charge_company");

  if (ids.length === 0) redirect(failUrl("购物车为空，请先选择商品"));

  /*
   * 单商品时 quantity 生效（POS 传的是购物车总件数）；多商品时按每件 1 件结算，
   * 与页面「一件一行」的流水展示保持一致。
   */
  const rawQty = Number(str(formData.get("qty")));
  const singleQty = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(99, Math.trunc(rawQty)) : 1;

  const now = nowIso();
  let outcome: { names: string[]; total: number; count: number };

  try {
    outcome = tx(() => {
      const duplicated = get<{ id: number }>(
        `SELECT id FROM shop_sales WHERE hotel_id = ? AND request_id = ? LIMIT 1`,
        [hotelId, requestId]
      );
      if (duplicated) throw new ShopTxError("该请求已处理（request_id 重复），本次未重复销售");

      const names: string[] = [];
      let total = 0;
      let count = 0;

      for (const id of ids) {
        const item = get<ShopItemRow>(
          `SELECT id, name, price, stock, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
          [id, hotelId]
        );
        if (!item) throw new ShopTxError(`商品 #${id} 不存在或已被删除，整单已取消`);
        if (item.status !== "ON") throw new ShopTxError(`商品「${item.name}」已下架，整单已取消`);
        const qty = ids.length === 1 ? singleQty : 1;

        const dec = run(
          `UPDATE shop_items SET stock = stock - ? WHERE id = ? AND hotel_id = ? AND stock >= ?`,
          [qty, id, hotelId, qty]
        );
        if (dec.changes === 0) {
          throw new ShopTxError(`商品「${item.name}」库存不足（需要 ${qty} 件，当前 ${item.stock} 件），整单已取消`);
        }

        const amount = round2(Number(item.price) * qty);
        run(
          `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at, request_id)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            item.name,
            qty,
            amount,
            roomNo ? `挂账 ${roomNo}` : method,
            roomNo || null,
            now,
            /* 部分唯一索引只约束非空 request_id：同一单只把幂等标识记在首行 */
            count === 0 ? requestId : null,
          ]
        );

        names.push(item.name);
        total += amount;
        count += 1;
      }

      /* 挂账：必须真的写进在住客人的账单，否则回滚（旧实现查不到就静默跳过） */
      if (roomNo) {
        const stay = get<StayFolioRow>(
          `SELECT s.id AS stay_id, s.guest_name, f.id AS folio_id
             FROM stays s JOIN rooms r ON r.id = s.room_id
             LEFT JOIN folios f ON f.stay_id = s.id
            WHERE s.hotel_id = ? AND r.room_no = ? AND s.status = 'INHOUSE'
            ORDER BY s.id DESC LIMIT 1`,
          [hotelId, roomNo]
        );
        if (!stay) throw new ShopTxError(`房号 ${roomNo} 当前没有在住客人，整单已取消（库存未扣、流水未记）`);

        const folioId = ensureStayFolio(hotelId, stay, roomNo, now);
        run(
          `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, biz_date, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [hotelId, folioId, "OTHER", `商超:${names.join("、")}`, round2(total), count, todayStr(), now]
        );
        /* 不再增量累加（部分结账后累加会把负项算漏），统一重算 */
        recalcFolioBalance(hotelId, folioId);
      }

      return { names, total: round2(total), count };
    });
  } catch (e) {
    if (e instanceof ShopTxError) redirect(failUrl(e.message));
    throw e;
  }

  writeOpLog(
    hotelId,
    user.realName || user.username,
    "商超结算",
    `${outcome.count} 件 · 合计 ${fmtMoney(outcome.total)} · ${roomNo ? `挂账房 ${roomNo}` : method} · 商品 ${outcome.names.join(
      "、"
    )} · request_id ${requestId}`
  );

  revalidatePath("/shop");
  redirect(
    `/shop?msg=${encodeURIComponent(
      `已售出 ${outcome.count} 件，合计 ¥${outcome.total.toFixed(2)}（${roomNo ? `挂账 ${roomNo}` : method}）`
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
      run(`UPDATE shop_items SET stock = stock + ? WHERE id = ? AND hotel_id = ?`, [
        Math.abs(Math.trunc(Number(sale.qty ?? 1))),
        item.id,
        hotelId,
      ]);

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
