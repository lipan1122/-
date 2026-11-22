"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run, tx } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtMoney, nowIso } from "@/lib/utils";

/** 物品租赁：新表不在 init-db.mjs 内，首次访问时懒创建 */

type RentalItemRow = {
  id: number;
  name: string;
  price: number;
  deposit: number;
  stock: number;
  status: string;
};

type RentalRecordRow = {
  id: number;
  item_id: number;
  qty: number;
  status: string;
};

type InHouseStayRow = { stay_id: number; guest_name: string | null };

/** 租赁物品种子：酒店前台常备的五种出借物品 */
const RENTAL_SEED: { name: string; price: number; deposit: number; stock: number }[] = [
  { name: "充电宝", price: 10, deposit: 50, stock: 6 },
  { name: "雨伞", price: 5, deposit: 30, stock: 10 },
  { name: "转换插头", price: 5, deposit: 20, stock: 8 },
  { name: "电吹风", price: 8, deposit: 50, stock: 5 },
  { name: "婴儿床", price: 20, deposit: 100, stock: 3 },
];

let schemaReady = false;
const seededHotels = new Set<number>();

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPositiveInt(value: FormDataEntryValue | null): number {
  const n = Number(str(value));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 失败回跳：错误 / 成功文案通过 query 带回页面横幅 */
function back(key: "err" | "msg", message: string): never {
  redirect(`/rental?${key}=${encodeURIComponent(message)}`);
}

/** 懒建表（幂等）+ 首次为各酒店写入五种出借物品 */
export async function ensureRentalSchema(hotelId: number): Promise<void> {
  /*
   * 权限边界（上线前加固）：建表 / 种子助手不该是可匿名调用的 RPC 端点。
   * 它被 rental/page.tsx 直接 import，去掉 export 会打断页面编译，这里补登录守卫；
   * 同时酒店 id 必须与 session 一致，避免拿别家 hotelId 往别家写种子数据。
   */
  const user = await requireUser();
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化租借数据");
  if (!schemaReady) {
    run(`CREATE TABLE IF NOT EXISTS rental_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      deposit REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ON',
      created_at TEXT
    )`);

    run(`CREATE TABLE IF NOT EXISTS rental_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      stay_id INTEGER,
      room_no TEXT,
      guest_name TEXT,
      qty INTEGER DEFAULT 1,
      deposit REAL DEFAULT 0,
      rent_at TEXT,
      return_at TEXT,
      status TEXT DEFAULT 'RENTED'
    )`);

    schemaReady = true;
  }

  if (seededHotels.has(hotelId)) return;
  seededHotels.add(hotelId);

  const existing = get<{ n: number }>(`SELECT COUNT(*) AS n FROM rental_items WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (existing > 0) return;

  const now = nowIso();
  for (const item of RENTAL_SEED) {
    run(
      `INSERT INTO rental_items (hotel_id, name, price, deposit, stock, status, created_at) VALUES (?,?,?,?,?,?,?)`,
      [hotelId, item.name, item.price, item.deposit, item.stock, "ON", now]
    );
  }
}

/**
 * 租出物品：
 * 1. 房号自动匹配在住 stay（没有在住客人不允许租借）
 * 2. 校验物品状态与可租库存
 * 3. 写租赁记录 + 扣减库存
 */
export async function rentItemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureRentalSchema(hotelId);

  const itemId = toPositiveInt(formData.get("item_id"));
  const qty = toPositiveInt(formData.get("qty"));
  const roomNo = str(formData.get("room_no"));

  if (!itemId) back("err", "请选择要租出的物品");
  if (!qty) back("err", "请填写正确的租借数量（1-99）");
  if (qty > 99) back("err", "单次租借数量不能超过 99");
  if (!roomNo) back("err", "请填写房号，系统会自动匹配在住客人");

  const item = get<RentalItemRow>(
    `SELECT id, name, price, deposit, stock, status FROM rental_items WHERE id = ? AND hotel_id = ?`,
    [itemId, hotelId]
  );
  if (!item) back("err", "物品不存在或已被删除");
  if (item.status !== "ON") back("err", `物品「${item.name}」已停用，不能租出`);
  if (item.stock < qty) back("err", `物品「${item.name}」可租库存不足（当前 ${item.stock} 件）`);

  const stay = get<InHouseStayRow>(
    `SELECT s.id AS stay_id, s.guest_name
       FROM stays s
       JOIN rooms r ON r.id = s.room_id
      WHERE s.hotel_id = ? AND s.status = 'INHOUSE' AND r.room_no = ?
      ORDER BY s.id DESC
      LIMIT 1`,
    [hotelId, roomNo]
  );
  if (!stay) back("err", `房号 ${roomNo} 当前没有在住客人，无法办理物品租赁`);

  const deposit = round2(item.deposit * qty);
  const rentAt = nowIso();

  tx(() => {
    run(
      `INSERT INTO rental_records
         (hotel_id, item_id, stay_id, room_no, guest_name, qty, deposit, rent_at, return_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [hotelId, item.id, stay.stay_id, roomNo, stay.guest_name ?? "客人", qty, deposit, rentAt, null, "RENTED"]
    );

    run(`UPDATE rental_items SET stock = stock - ? WHERE id = ? AND hotel_id = ?`, [qty, item.id, hotelId]);
  });

  revalidatePath("/rental");

  back(
    "msg",
    `已租出：${item.name} ×${qty}，押金 ${fmtMoney(deposit)} → 房 ${roomNo} ${stay.guest_name ?? "客人"}`
  );
}

/** 归还物品：记录归还时间，押金对应的物品回库存 */
export async function returnRentalAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const hotelId = user.hotelId;
  await ensureRentalSchema(hotelId);

  const id = toPositiveInt(formData.get("id"));
  if (!id) back("err", "租赁记录不存在");

  const record = get<RentalRecordRow>(
    `SELECT id, item_id, qty, status FROM rental_records WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!record) back("err", "租赁记录不存在或已被删除");
  if (record.status !== "RENTED") back("err", "该租赁记录已归还，无需重复操作");

  const qty = record.qty > 0 ? record.qty : 1;
  const returnAt = nowIso();

  tx(() => {
    run(`UPDATE rental_records SET status = 'RETURNED', return_at = ? WHERE id = ? AND hotel_id = ?`, [
      returnAt,
      record.id,
      hotelId,
    ]);

    run(`UPDATE rental_items SET stock = stock + ? WHERE id = ? AND hotel_id = ?`, [qty, record.item_id, hotelId]);
  });

  revalidatePath("/rental");

  back("msg", `已归还 ${qty} 件物品，库存已回补，押金可退还客人`);
}
