"use server";

import { revalidatePath } from "next/cache";
import { recalcFolioBalance } from "@/lib/folio";
import { redirect } from "next/navigation";
import { get, getDb, run, tx } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";

type ShopItemRow = { id: number; name: string; price: number; stock: number; status: string };

type StayFolioRow = { stay_id: number; guest_name: string | null; folio_id: number | null };

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

/** 懒建表 + 首次种子：第一次访问时建 shop_items 并写入 10 个商品 */
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

/** 今日商超销售流水（供页面与重新校验共用） */
function revalidateShop() {
  revalidatePath("/shop");
  revalidatePath("/cashier");
  revalidatePath("/inhouse");
  revalidatePath("/today-todo");
}

/**
 * 商超销售挂房账：
 * 1. 校验商品状态与库存，找到房号对应的在住客人
 * 2. 写入 folio_items（item_type = OTHER，摘要「商超：商品名」）
 * 3. 扣减库存并重算账单合计 / 应收余额
 */
export async function sellAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  ensureShopSchema(hotelId);

  /** 失败回跳地址：把错误文案带回页面横幅 */
  const failUrl = (message: string) => `/shop?err=${encodeURIComponent(message)}`;

  const rawItemId = Number(str(formData.get("item_id")));
  const itemId = Number.isFinite(rawItemId) && rawItemId > 0 ? Math.trunc(rawItemId) : 0;
  const rawQty = Number(str(formData.get("qty")));
  const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(99, Math.trunc(rawQty)) : 0;
  const roomNo = str(formData.get("room_no"));

  if (!itemId) redirect(failUrl("请选择要销售的商品"));
  if (!qty) redirect(failUrl("请填写正确的销售数量（1-99）"));
  if (!roomNo) redirect(failUrl("请填写挂账房号"));

  const item = get<ShopItemRow>(
    `SELECT id, name, price, stock, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
    [itemId, hotelId]
  );
  if (!item) redirect(failUrl("商品不存在或已被删除"));
  if (item.status !== "ON") redirect(failUrl(`商品「${item.name}」已下架，不能销售`));
  if (item.stock < qty) redirect(failUrl(`商品「${item.name}」库存不足（当前 ${item.stock} 件）`));

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

  tx(() => {
    // 在住客人理论上都有账务单；历史数据缺失时补建一张
    let folioId: number | null = stay.folio_id;
    if (!folioId) {
      const nextId = get<{ m: number | null }>(`SELECT COALESCE(MAX(id), 0) AS m FROM folios`)?.m ?? 0;
      folioId = run(
        `INSERT INTO folios
           (hotel_id, folio_no, stay_id, guest_name, room_no, total_amount, paid_amount, balance, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [hotelId, `F${nextId + 1 + 2000}`, stay.stay_id, stay.guest_name ?? "客人", roomNo, 0, 0, 0, "OPEN", now]
      ).lastInsertRowid;
    }
    const currentFolioId = folioId;

    run(
      `INSERT INTO folio_items
         (hotel_id, folio_id, item_type, description, qty, price, amount, biz_date, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [hotelId, currentFolioId, "OTHER", `商超：${item.name}`, qty, item.price, amount, today, now, user.id]
    );

    run(`UPDATE shop_items SET stock = stock - ? WHERE id = ? AND hotel_id = ?`, [qty, item.id, hotelId]);

    /* 统一走公共重算（P0-4）：部分结账负项的排除规则只写一份，避免各入口算出不同余额 */
    recalcFolioBalance(hotelId, currentFolioId);
  });

  revalidateShop();
  redirect(
    `/shop?ok=${encodeURIComponent(
      `已挂房账：${item.name} ×${qty}，${fmtMoney(amount)} → 房 ${
        roomNo
      } ${stay.guest_name ?? "客人"}`
    )}`
  );
}

/** 商品上架 / 下架切换 */
export async function toggleItemStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  ensureShopSchema(user.hotelId);

  const id = Number(str(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) return;

  const item = get<{ id: number; status: string }>(
    `SELECT id, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
    [Math.trunc(id), user.hotelId]
  );
  if (!item) return;

  run(`UPDATE shop_items SET status = ? WHERE id = ? AND hotel_id = ?`, [
    item.status === "ON" ? "OFF" : "ON",
    item.id,
    user.hotelId,
  ]);

  revalidatePath("/shop");
}

/** 购物车结算（去呼呼前台售卖：可多件、现金或挂房账） */
export async function sellCartAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  ensureShopSchema(hotelId);

  const ids = String(formData.get("item_id") ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  const method = str(formData.get("method")) || "现金";
  const roomNo = str(formData.get("room_no"));

  if (ids.length === 0) redirect(`/shop?err=${encodeURIComponent("购物车为空，请先选择商品")}`);

  const now = nowIso();
  const names: string[] = [];
  let total = 0;

  tx(() => {
    for (const id of ids) {
      const item = get<{ id: number; name: string; price: number; stock: number; status: string }>(
        `SELECT id, name, price, stock, status FROM shop_items WHERE id = ? AND hotel_id = ?`,
        [id, hotelId]
      );
      if (!item) continue;
      if (item.stock < 1) continue;
      run(`UPDATE shop_items SET stock = stock - 1 WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
      run(
        `INSERT INTO shop_sales (hotel_id, item_name, qty, amount, method, room_no, created_at) VALUES (?,?,?,?,?,?,?)`,
        [hotelId, item.name, 1, item.price, roomNo ? `挂账 ${roomNo}` : method, roomNo || null, now]
      );
      names.push(item.name);
      total += Number(item.price);
    }

    // 挂账：写入该房间在住单的账户
    if (roomNo) {
      const stay = get<{ id: number; guest_name: string | null }>(
        `SELECT s.id, s.guest_name FROM stays s JOIN rooms r ON r.id = s.room_id
         WHERE s.hotel_id = ? AND r.room_no = ? AND s.status = 'INHOUSE' LIMIT 1`,
        [hotelId, roomNo]
      );
      if (stay) {
        const folio = get<{ id: number }>(
          `SELECT id FROM folios WHERE hotel_id = ? AND stay_id = ? ORDER BY id DESC LIMIT 1`,
          [hotelId, stay.id]
        );
        if (folio) {
          run(
            `INSERT INTO folio_items (hotel_id, folio_id, item_type, description, amount, qty, biz_date, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [hotelId, folio.id, "OTHER", `商超:${names.join("、")}`, total, 1, todayStr(), now]
          );
          /* 不再增量累加（部分结账后累加会把负项算漏），统一重算 */
          recalcFolioBalance(hotelId, folio.id);
        }
      }
    }
  });

  revalidatePath("/shop");
  redirect(`/shop?msg=${encodeURIComponent(`已售出 ${names.length} 件，合计 ¥${total.toFixed(2)}（${roomNo ? `挂账 ${roomNo}` : method}）`)}`);
}
