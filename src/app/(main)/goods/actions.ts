"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, getDb, run, tx } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, nowIso } from "@/lib/utils";

/**
 * 商品库存管理（商品类别 / 商品列表 / 库存管理 / 进货 / 退货 / 报废 / 明细查询 / 库存报表）
 *
 * 三张表不在 scripts/init-db.mjs 内，首次访问本模块时懒创建并写入示例种子：
 *   goods_categories 商品类别
 *   goods            商品档案（stock 为当前库存，随流水变动）
 *   goods_flows      库存流水（type：PURCHASE 进货 / RETURN 退货 / REJECT 报废 / SELL 销售）
 *
 * 约定：qty 带符号入库（进货为正，退货 / 报废 / 销售为负），stock_after 记录该笔变动后的结存，
 * 任何导致库存变动的操作都在一个事务内同时写 goods.stock 与 goods_flows。
 */

const PAGE = "/goods";

type FlowType = "PURCHASE" | "RETURN" | "REJECT" | "SELL";

const FLOW_LABEL: Record<FlowType, string> = {
  PURCHASE: "进货",
  RETURN: "退货",
  REJECT: "报废",
  SELL: "销售",
};

type GoodsRow = {
  id: number;
  name: string;
  unit: string;
  cost_price: number;
  sell_price: number;
  stock: number;
};

/* -------------------------------------------------------------------------- */
/* 种子数据：4 个类别 / 12 个商品 / 每个商品 8 条流水                            */
/* -------------------------------------------------------------------------- */

const CATEGORY_SEED: { name: string; sort: number }[] = [
  { name: "饮品", sort: 1 },
  { name: "食品", sort: 2 },
  { name: "日用品", sort: 3 },
  { name: "其他", sort: 4 },
];

const GOODS_SEED: {
  name: string;
  category: string;
  barcode: string;
  unit: string;
  cost: number;
  sell: number;
  /** 期初库存（种子里作为第一笔进货前的结转数量，当前库存 = 期初 + 8 条流水净变化） */
  opening: number;
  /** 预警库存（当前库存 ≤ 预警库存 即进入低库存清单） */
  warn: number;
}[] = [
  { name: "矿泉水 550ml", category: "饮品", barcode: "6901234501001", unit: "瓶", cost: 1.2, sell: 2.5, opening: 120, warn: 24 },
  { name: "可乐 330ml", category: "饮品", barcode: "6901234501018", unit: "罐", cost: 2, sell: 4, opening: 96, warn: 20 },
  { name: "泡面 红烧牛肉桶装", category: "食品", barcode: "6901234501025", unit: "桶", cost: 3.5, sell: 6, opening: 60, warn: 15 },
  { name: "薯片 70g", category: "食品", barcode: "6901234501032", unit: "袋", cost: 4.5, sell: 8, opening: 24, warn: 12 },
  { name: "拖鞋 一次性", category: "日用品", barcode: "6901234501049", unit: "双", cost: 2, sell: 6, opening: 2, warn: 20 },
  { name: "牙具套装", category: "日用品", barcode: "6901234501056", unit: "套", cost: 1.5, sell: 5, opening: 50, warn: 15 },
  { name: "雨伞 长柄", category: "日用品", barcode: "6901234501063", unit: "把", cost: 12, sell: 25, opening: 2, warn: 30 },
  { name: "充电宝 10000mAh", category: "其他", barcode: "6901234501070", unit: "个", cost: 45, sell: 88, opening: 8, warn: 6 },
  { name: "毛巾 全棉", category: "日用品", barcode: "6901234501087", unit: "条", cost: 8, sell: 18, opening: 25, warn: 8 },
  { name: "洗衣液 500ml", category: "日用品", barcode: "6901234501094", unit: "瓶", cost: 9.5, sell: 18, opening: 2, warn: 25 },
  { name: "牛奶 250ml", category: "饮品", barcode: "6901234501100", unit: "盒", cost: 2.8, sell: 5.5, opening: 72, warn: 20 },
  { name: "饼干 116g", category: "食品", barcode: "6901234501117", unit: "包", cost: 3.8, sell: 7, opening: 40, warn: 12 },
];

/** 每个商品 8 条流水的模板（daysAgo 从大到小 = 时间从早到晚，最后一条落在今天） */
const FLOW_SEED: { type: FlowType; qty: number; daysAgo: number; note: string }[] = [
  { type: "PURCHASE", qty: 12, daysAgo: 20, note: "首批进货入库" },
  { type: "SELL", qty: 3, daysAgo: 16, note: "客房迷你吧领用" },
  { type: "PURCHASE", qty: 6, daysAgo: 13, note: "供应商补货" },
  { type: "RETURN", qty: 1, daysAgo: 10, note: "临期商品退回供应商" },
  { type: "SELL", qty: 2, daysAgo: 7, note: "前台零售出库" },
  { type: "REJECT", qty: 1, daysAgo: 4, note: "破损报废" },
  { type: "PURCHASE", qty: 5, daysAgo: 2, note: "小批量补货" },
  { type: "SELL", qty: 2, daysAgo: 0, note: "客房消费出库" },
];

const SEED_OPERATORS = ["系统", "前台-王琳", "库管-张伟"];

/** 按商品序号微调种子流水数量，让 12 个商品的历史不完全相同（保持确定性，可重复生成） */
function seedQty(flow: { type: FlowType; qty: number }, index: number): number {
  const jitter = index % 4;
  if (flow.type === "PURCHASE") return flow.qty + jitter * 3;
  if (flow.type === "SELL") return flow.qty + (jitter % 3);
  return flow.qty + (index % 3 === 0 ? 1 : 0);
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function toInt(value: FormDataEntryValue | null, fallback = 0): number {
  const raw = str(value).replace(/,/g, "");
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNum(value: FormDataEntryValue | null, fallback = 0): number {
  const raw = str(value).replace(/,/g, "");
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 回跳页面：tab + 提示文案（msg 绿色 / err 红色） */
function back(tab: string, key: "msg" | "err", message: string): never {
  redirect(`${PAGE}?tab=${tab}&${key}=${encodeURIComponent(message)}`);
}

/* -------------------------------------------------------------------------- */
/* 懒创建：三张表 + 首次访问种子（不改动 scripts/init-db.mjs）                  */
/* -------------------------------------------------------------------------- */

let schemaReady = false;

function createTables(): void {
  if (schemaReady) return;
  const db = getDb();

  db.exec(`CREATE TABLE IF NOT EXISTS goods_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ON',
    created_at TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS goods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    category_id INTEGER,
    name TEXT NOT NULL,
    barcode TEXT,
    unit TEXT NOT NULL DEFAULT '件',
    cost_price REAL NOT NULL DEFAULT 0,
    sell_price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    warn_stock INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ON',
    created_at TEXT NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS goods_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    goods_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    unit_price REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
  )`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_goods_hotel ON goods (hotel_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goods_flows_hotel ON goods_flows (hotel_id, goods_id, type)`);

  schemaReady = true;
}

/**
 * 首次访问写入种子：4 个类别、12 个商品、每个商品 8 条流水。
 * 商品当前库存 = 期初库存 + 8 条流水回放结果，保证流水结存与 goods.stock 一致。
 *
 * ⚠️ 上线前加的保护
 *
 * 这 12 个商品（矿泉水、拖鞋、浴巾等）和 32 条入库/销售流水都是**演示数据**。
 * 真实酒店上线后会看到一堆自己没录的商品和假流水，对库存盘点造成干扰。
 * 所以只有显式设置 PMS_DEMO_SEED=1 才灌，默认空列表。
 *
 * 注意：类别（CATEGORY_SEED）是基础分类，真实酒店基本都要用，保留自动创建。
 */
function seedGoodsDefaults(hotelId: number): void {
  const catCount =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM goods_categories WHERE hotel_id = ?`, [hotelId])?.n ?? 0;

  if (catCount === 0) {
    const createdAt = nowIso();
    for (const item of CATEGORY_SEED) {
      run(`INSERT INTO goods_categories (hotel_id, name, sort, status, created_at) VALUES (?,?,?,?,?)`, [
        hotelId,
        item.name,
        item.sort,
        "ON",
        createdAt,
      ]);
    }
  }

  /*
   * 商品 + 流水是演示数据，默认不灌（真实酒店自己录）。
   * 显式设 PMS_DEMO_SEED=1 才灌，用于演示环境。
   */
  if (process.env.PMS_DEMO_SEED !== "1") return;

  const goodsCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM goods WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (goodsCount > 0) return;

  const categories = all<{ id: number; name: string }>(
    `SELECT id, name FROM goods_categories WHERE hotel_id = ?`,
    [hotelId]
  );
  const categoryMap = new Map<string, number>(categories.map((c) => [c.name, c.id] as const));
  if (categoryMap.size === 0) return;

  const now = new Date();

  tx(() => {
    GOODS_SEED.forEach((item, index) => {
      // 1) 先按期初库存 + 流水模板回放，算出每笔结存与最终库存
      let running = item.opening;
      const flows: {
        type: FlowType;
        qty: number;
        stockAfter: number;
        unitPrice: number;
        amount: number;
        note: string;
        operator: string;
        createdAt: string;
      }[] = [];

      FLOW_SEED.forEach((flow, fi) => {
        let qty = seedQty(flow, index);
        if (qty <= 0) return;
        const inbound = flow.type === "PURCHASE";
        // 出库不能把库存做成负数：不足时按现有库存截断
        if (!inbound && running - qty < 0) qty = Math.max(0, running);
        if (qty <= 0) return;

        running = inbound ? running + qty : running - qty;
        const unitPrice = flow.type === "SELL" ? item.sell : item.cost;
        const when = new Date(now.getTime() - flow.daysAgo * 86400000);
        when.setHours(9 + (index % 8), (index * 7) % 60, 0, 0);

        flows.push({
          type: flow.type,
          qty: inbound ? qty : -qty,
          stockAfter: running,
          unitPrice,
          amount: round2(unitPrice * qty),
          note: fi === 0 ? `${flow.note}（期初库存 ${item.opening} ${item.unit}）` : flow.note,
          operator: SEED_OPERATORS[(index + fi) % SEED_OPERATORS.length] ?? "系统",
          createdAt: when.toISOString(),
        });
      });

      // 2) 商品按回放后的库存落库
      const goodsCreated = new Date(now.getTime() - 30 * 86400000).toISOString();
      const goodsId = run(
        `INSERT INTO goods
           (hotel_id, category_id, name, barcode, unit, cost_price, sell_price, stock, warn_stock, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          categoryMap.get(item.category) ?? null,
          item.name,
          item.barcode,
          item.unit,
          item.cost,
          item.sell,
          running,
          item.warn,
          "ON",
          goodsCreated,
        ]
      ).lastInsertRowid;

      // 3) 8 条流水按时间顺序写入
      for (const flow of flows) {
        run(
          `INSERT INTO goods_flows
             (hotel_id, goods_id, type, qty, stock_after, unit_price, amount, note, operator, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            hotelId,
            goodsId,
            flow.type,
            flow.qty,
            flow.stockAfter,
            flow.unitPrice,
            flow.amount,
            flow.note,
            flow.operator,
            flow.createdAt,
          ]
        );
      }
    });
  });
}

/** 建表 + 首次种子（页面与所有写操作共用） */
export async function ensureGoodsSchema(hotelId: number): Promise<void> {
  /*
   * 权限边界（上线前加固）：建表 / 种子助手不该是可匿名调用的 RPC 端点。
   * 它被 goods/page.tsx 直接 import，去掉 export 会打断页面编译，这里补登录守卫；
   * 同时酒店 id 必须与 session 一致，避免拿别家 hotelId 往别家写种子数据。
   */
  const user = await requireUser();
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化商品数据");
  createTables();
  seedGoodsDefaults(hotelId);
}

/** 库存写操作统一回跳并刷新页面缓存 */
function revalidateGoods(): void {
  revalidatePath(PAGE);
  revalidatePath("/shop");
}

/* -------------------------------------------------------------------------- */
/* 商品类别                                                                    */
/* -------------------------------------------------------------------------- */

/** 新增商品类别：名称在当前酒店内唯一，排序取当前最大值 + 1 */
export async function createCategoryAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureGoodsSchema(hotelId);

  const name = str(formData.get("name"));
  if (!name) back("goods", "err", "请填写类别名称，如「饮品」");
  if (name.length > 20) back("goods", "err", "类别名称请控制在 20 个字以内");

  const existed = get<{ id: number }>(
    `SELECT id FROM goods_categories WHERE hotel_id = ? AND name = ? LIMIT 1`,
    [hotelId, name]
  );
  if (existed) back("goods", "err", `类别「${name}」已存在，请换一个名称`);

  const maxSort =
    get<{ m: number | null }>(`SELECT MAX(sort) AS m FROM goods_categories WHERE hotel_id = ?`, [hotelId])?.m ?? 0;

  run(`INSERT INTO goods_categories (hotel_id, name, sort, status, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    name,
    Math.trunc(Number(maxSort)) + 1,
    "ON",
    nowIso(),
  ]);

  revalidateGoods();
  back("goods", "msg", `已新增商品类别「${name}」`);
}

/* -------------------------------------------------------------------------- */
/* 商品档案                                                                    */
/* -------------------------------------------------------------------------- */

/** 新增 / 编辑商品（带 id 为编辑，编辑不改库存，库存只能通过进货 / 退货 / 报废调整） */
export async function saveGoodsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureGoodsSchema(hotelId);

  const id = toInt(formData.get("id"));
  const name = str(formData.get("name"));
  const categoryId = toInt(formData.get("category_id"));
  const barcode = str(formData.get("barcode"));
  const unit = str(formData.get("unit")) || "件";
  const costPrice = round2(toNum(formData.get("cost_price")));
  const sellPrice = round2(toNum(formData.get("sell_price")));
  const warnStock = toInt(formData.get("warn_stock"));
  const opening = toInt(formData.get("stock"));

  if (!name) back("goods", "err", "请填写商品名称");
  if (name.length > 40) back("goods", "err", "商品名称请控制在 40 个字以内");
  if (costPrice < 0) back("goods", "err", "成本价不能为负数");
  if (sellPrice < 0) back("goods", "err", "售价不能为负数");
  if (warnStock < 0) back("goods", "err", "预警库存不能为负数");

  if (categoryId) {
    const category = get<{ id: number }>(
      `SELECT id FROM goods_categories WHERE id = ? AND hotel_id = ?`,
      [categoryId, hotelId]
    );
    if (!category) back("goods", "err", "所选商品类别不存在，请重新选择");
  }

  const duplicated = get<{ id: number }>(
    `SELECT id FROM goods WHERE hotel_id = ? AND name = ? AND id <> ? LIMIT 1`,
    [hotelId, name, id]
  );
  if (duplicated) back("goods", "err", `商品「${name}」已存在，请换一个名称`);

  const operator = user.realName || user.username;
  const now = nowIso();

  if (id) {
    const existed = get<{ id: number }>(`SELECT id FROM goods WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
    if (!existed) back("goods", "err", "商品不存在或已被删除");

    run(
      `UPDATE goods
          SET category_id = ?, name = ?, barcode = ?, unit = ?, cost_price = ?, sell_price = ?, warn_stock = ?
        WHERE id = ? AND hotel_id = ?`,
      [categoryId || null, name, barcode || null, unit, costPrice, sellPrice, warnStock, id, hotelId]
    );

    revalidateGoods();
    back("goods", "msg", `已保存商品「${name}」档案（库存请通过进货 / 退货 / 报废调整）`);
  }

  if (opening < 0) back("goods", "err", "期初库存不能为负数");

  tx(() => {
    const goodsId = run(
      `INSERT INTO goods
         (hotel_id, category_id, name, barcode, unit, cost_price, sell_price, stock, warn_stock, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        hotelId,
        categoryId || null,
        name,
        barcode || null,
        unit,
        costPrice,
        sellPrice,
        opening,
        warnStock,
        "ON",
        now,
      ]
    ).lastInsertRowid;

    // 期初库存 > 0 时补一笔进货流水，保证流水结存与商品库存对得上
    if (opening > 0) {
      run(
        `INSERT INTO goods_flows
           (hotel_id, goods_id, type, qty, stock_after, unit_price, amount, note, operator, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          hotelId,
          goodsId,
          "PURCHASE",
          opening,
          opening,
          costPrice,
          round2(costPrice * opening),
          "期初建账入库",
          operator,
          now,
        ]
      );
    }
  });

  revalidateGoods();
  back(
    "goods",
    "msg",
    `已新增商品「${name}」${opening > 0 ? `，期初库存 ${opening} ${unit}（已写入期初进货流水）` : ""}`
  );
}

/** 商品上架 / 下架切换（下架商品不出现在库存操作的默认可选列表，仍需先处理库存） */
export async function toggleGoodsStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureGoodsSchema(hotelId);

  const id = toInt(formData.get("id"));
  if (!id) back("goods", "err", "商品不存在或已被删除");

  const row = get<{ id: number; name: string; status: string }>(
    `SELECT id, name, status FROM goods WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) back("goods", "err", "商品不存在或已被删除");

  const next = row.status === "ON" ? "OFF" : "ON";
  run(`UPDATE goods SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidateGoods();
  back("goods", "msg", next === "ON" ? `已上架商品「${row.name}」` : `已下架商品「${row.name}」，下架后不可用于零售出库`);
}

/* -------------------------------------------------------------------------- */
/* 库存操作：进货 / 退货 / 报废（事务内同时写 goods.stock 与 goods_flows）        */
/* -------------------------------------------------------------------------- */

async function applyStockMove(type: FlowType, formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureGoodsSchema(hotelId);

  const label = FLOW_LABEL[type];
  const goodsId = toInt(formData.get("goods_id"));
  const qty = toInt(formData.get("qty"));
  const rawPrice = toNum(formData.get("unit_price"), -1);
  const note = str(formData.get("note"));

  if (!goodsId) back("stock", "err", `请先选择要${label}的商品`);
  if (qty <= 0) back("stock", "err", `${label}数量必须大于 0`);
  if (qty > 99999) back("stock", "err", `${label}数量过大（上限 99999），请分次操作`);

  const goods = get<GoodsRow>(
    `SELECT id, name, unit, cost_price, sell_price, stock FROM goods WHERE id = ? AND hotel_id = ?`,
    [goodsId, hotelId]
  );
  if (!goods) back("stock", "err", "商品不存在或已被删除");

  // 单价留空时回落成本价；进货单价作为最新成本价写回商品档案
  const unitPrice = round2(rawPrice >= 0 ? rawPrice : goods.cost_price);
  if (unitPrice > 100000) back("stock", "err", "单价过大（上限 100000），请确认后再提交");
  const amount = round2(unitPrice * qty);
  const operator = user.realName || user.username;

  const result = tx(() => {
    const current = get<{ stock: number }>(`SELECT stock FROM goods WHERE id = ? AND hotel_id = ?`, [
      goodsId,
      hotelId,
    ]);
    if (!current) return { ok: false as const, current: 0 };

    const before = Math.trunc(Number(current.stock ?? 0));
    const delta = type === "PURCHASE" ? qty : -qty;
    const after = before + delta;
    if (after < 0) return { ok: false as const, current: before };

    if (type === "PURCHASE" && unitPrice > 0) {
      run(`UPDATE goods SET stock = ?, cost_price = ? WHERE id = ? AND hotel_id = ?`, [
        after,
        unitPrice,
        goodsId,
        hotelId,
      ]);
    } else {
      run(`UPDATE goods SET stock = ? WHERE id = ? AND hotel_id = ?`, [after, goodsId, hotelId]);
    }

    run(
      `INSERT INTO goods_flows
         (hotel_id, goods_id, type, qty, stock_after, unit_price, amount, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [hotelId, goodsId, type, delta, after, unitPrice, amount, note || null, operator, nowIso()]
    );

    return { ok: true as const, after };
  });

  if (!result.ok) {
    back(
      "stock",
      "err",
      `商品「${goods.name}」库存不足：当前 ${result.current} ${goods.unit}，本次${label} ${qty} ${goods.unit}`
    );
  }

  revalidateGoods();
  back(
    "stock",
    "msg",
    `已${label}：${goods.name} ${type === "PURCHASE" ? "+" : "-"}${qty} ${goods.unit} · 单价 ${fmtMoney(
      unitPrice
    )} · 金额 ${fmtMoney(amount)} · 结存 ${result.after} ${goods.unit}`
  );
}

/** 进货：增加库存，同时写入 goods_flows 的 PURCHASE 流水（单价同步为最新成本价） */
export async function purchaseAction(formData: FormData): Promise<void> {
  await applyStockMove("PURCHASE", formData);
}

/** 退货：把商品退回供应商，扣减库存，同时写入 goods_flows 的 RETURN 流水 */
export async function returnAction(formData: FormData): Promise<void> {
  await applyStockMove("RETURN", formData);
}

/** 报废：破损 / 过期报损，扣减库存，同时写入 goods_flows 的 REJECT 流水 */
export async function rejectAction(formData: FormData): Promise<void> {
  await applyStockMove("REJECT", formData);
}
