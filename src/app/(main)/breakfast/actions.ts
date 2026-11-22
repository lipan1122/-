"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso, todayStr } from "@/lib/utils";

/**
 * 早餐核销的动作级权限（整改报告第六轮 一.1）
 *
 * 改造前：5 个写动作只调用 requireUser()，任何登录账号（含 housekeeper）
 * 都能卖早餐、核销、撤销核销 —— 页面按钮藏得再好也挡不住直接构造 Server Action 请求。
 *
 * 权限点选择（优先复用，只有语义确实无法表达才新增）：
 *   · 卖早餐（sellBreakfastAction）      → folio.post_charge
 *       本质是「给在住客人的含早权益加收一笔」，不是收款；与 /inhouse 补过房费同语义，
 *       角色集 admin / frontdesk 与早餐操作者一致。
 *   · 核销 / 批量核销 / 全部核销          → cashier.receive
 *       核销 = 确认这份消费已发生（客人已用餐），属于消费确认；清单允许「前台或收银」。
 *   · 撤销核销（revokeAction）            → breakfast.void（本轮新增）
 *       cashier.refund 是退钱、cashier.reverse_checkout 是撤销退房，都与「撤销用餐标记」不同义；
 *       复用会让前台日常更正被错绑到财务动作上。已写进 session.ts 与 RBAC 种子。
 *
 * 跨酒店：所有读写都带 hotel_id（breakfast_records 有 hotel_id 列），
 * 拿别家的记录 id 过来查不到、更新不到。
 */

/**
 * 懒建表：早餐核销记录。
 * status：PENDING 待核销 / USED 已核销；一份记录对应一间在住房间的一个早餐日。
 */
function ensureBreakfastTable(): void {
  getDb().exec(`
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
    );
  `);
}

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: FormDataEntryValue | null): number {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 操作日志：op_logs 在极老库里可能不存在，审计写失败绝不能反过来让业务失败 */
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

/** 回到指定日期的列表页，可带成功 / 失败提示 */
function backTo(date: string, msg?: string, err?: string): string {
  const p = new URLSearchParams();
  if (date) p.set("date", date);
  if (msg) p.set("msg", msg);
  if (err) p.set("err", err);
  const qs = p.toString();
  return qs ? `/breakfast?${qs}` : "/breakfast";
}

/**
 * 业务日期归一化：只接受 YYYY-MM-DD，其余一律回落今天。
 * 直接信任表单里的 date 会把「全部核销」作用到任意一天（甚至非法字符串），
 * 这个参数必须先在服务端收窄。跨酒店仍由 hotel_id 条件过滤。
 */
function safeDate(value: FormDataEntryValue | null): string {
  const raw = str(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayStr();
}

/** 单条核销：把一条待核销记录置为已核销 */
export async function redeemAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  ensureBreakfastTable();

  const id = num(formData.get("id"));
  const date = safeDate(formData.get("date"));
  if (!id) redirect(backTo(date, undefined, "没有找到要核销的早餐记录"));

  const row = get<{ count: number; status: string; room_no: string | null }>(
    `SELECT count, status, room_no FROM breakfast_records WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) redirect(backTo(date, undefined, "该早餐记录不存在或已删除"));
  if (row.status === "USED") redirect(backTo(date, undefined, `${row.room_no ?? "该房"} 早餐已核销，无需重复核销`));

  const result = run(
    `UPDATE breakfast_records
        SET status = 'USED',
            note = CASE WHEN note IS NULL OR note = '' THEN '已核销' ELSE note END
      WHERE id = ? AND hotel_id = ? AND status = 'PENDING'`,
    [id, user.hotelId]
  );

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "早餐核销",
    `记录 ${id} · 房间 ${row.room_no ?? "-"} · ${row.count} 份 · 日期 ${date} · 影响 ${result.changes} 条`
  );

  revalidatePath("/breakfast");
  redirect(backTo(date, `${row.room_no ?? "该房"} 早餐 ${row.count} 份已核销`));
}

/** 批量核销：勾选多行后一次核销（表单里以 name="ids" 的复选框传递） */
export async function bulkRedeemAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  ensureBreakfastTable();

  const date = safeDate(formData.get("date"));
  const ids = formData
    .getAll("ids")
    .map((v) => num(v))
    .filter((n) => n > 0)
    /* 上限 200：防止构造超大 IN 列表把单条 SQL 撑爆 */
    .slice(0, 200);

  if (ids.length === 0) redirect(backTo(date, undefined, "请先勾选要核销的房间"));

  const placeholders = ids.map(() => "?").join(", ");
  const result = run(
    `UPDATE breakfast_records
        SET status = 'USED'
      WHERE hotel_id = ? AND date = ? AND status = 'PENDING' AND id IN (${placeholders})`,
    [user.hotelId, date, ...ids]
  );

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "早餐批量核销",
    `日期 ${date} · 勾选 ${ids.length} 条 · 实际核销 ${result.changes} 条`
  );

  revalidatePath("/breakfast");
  if (result.changes === 0) redirect(backTo(date, undefined, "勾选的早餐都已核销，无需重复操作"));
  redirect(backTo(date, `已批量核销 ${result.changes} 间房的早餐`));
}

/**
 * 全部核销：一次核销当日所有待核销早餐
 *
 * 页面侧用 ConfirmForm 做二次确认，弹窗里显示日期与受影响房间数（整改清单要求）。
 * 服务端仍然只认「当前酒店 + 当前日期 + PENDING」，跨酒店记录不受影响。
 */
export async function redeemAllAction(formData: FormData): Promise<void> {
  const user = await requirePermission("cashier.receive");
  ensureBreakfastTable();

  const date = safeDate(formData.get("date"));
  const result = run(
    `UPDATE breakfast_records SET status = 'USED' WHERE hotel_id = ? AND date = ? AND status = 'PENDING'`,
    [user.hotelId, date]
  );

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "早餐全部核销",
    `日期 ${date} · 实际核销 ${result.changes} 间房`
  );

  revalidatePath("/breakfast");
  if (result.changes === 0) redirect(backTo(date, undefined, "当日没有待核销的早餐"));
  redirect(backTo(date, `已将当日全部早餐核销（${result.changes} 间房）`));
}

/** 撤销核销：已核销记录回退为待核销 */
export async function revokeAction(formData: FormData): Promise<void> {
  const user = await requirePermission("breakfast.void");
  ensureBreakfastTable();

  const id = num(formData.get("id"));
  const date = safeDate(formData.get("date"));
  if (!id) redirect(backTo(date, undefined, "没有找到要撤销的早餐记录"));

  const row = get<{ room_no: string | null; status: string; count: number }>(
    `SELECT room_no, status, count FROM breakfast_records WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) redirect(backTo(date, undefined, "该早餐记录不存在或已删除"));
  if (row.status !== "USED") redirect(backTo(date, undefined, `${row.room_no ?? "该房"} 当前是待核销状态`));

  const result = run(
    `UPDATE breakfast_records SET status = 'PENDING', note = '撤销核销' WHERE id = ? AND hotel_id = ? AND status = 'USED'`,
    [id, user.hotelId]
  );

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "早餐撤销核销",
    `记录 ${id} · 房间 ${row.room_no ?? "-"} · ${row.count} 份 · 日期 ${date} · 回退 ${result.changes} 条`
  );

  revalidatePath("/breakfast");
  redirect(backTo(date, `${row.room_no ?? "该房"} 早餐已撤销核销`));
}

/** 卖早餐：给某间在住房间加早餐份数，同步更新 stays.breakfast 与当日核销记录 */
export async function sellBreakfastAction(formData: FormData): Promise<void> {
  const user = await requirePermission("folio.post_charge");
  ensureBreakfastTable();

  const today = todayStr();
  const stayId = num(formData.get("stayId"));
  const count = num(formData.get("count"));

  if (!stayId) redirect(backTo(today, undefined, "请选择要加早餐的在住房间"));
  if (count < 1 || count > 20) redirect(backTo(today, undefined, "早餐份数需为 1 - 20 份的整数"));

  const stay = get<{ room_no: string | null; guest_name: string | null; breakfast: number | null }>(
    `SELECT r.room_no, s.guest_name, COALESCE(s.breakfast, 0) AS breakfast
       FROM stays s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.id = ? AND s.hotel_id = ? AND s.status = 'INHOUSE'`,
    [stayId, user.hotelId]
  );
  if (!stay) redirect(backTo(today, undefined, "该房间当前不在住，无法加卖早餐"));

  const record = get<{ id: number; count: number }>(
    `SELECT id, count FROM breakfast_records
      WHERE hotel_id = ? AND stay_id = ? AND date = ?
      ORDER BY id LIMIT 1`,
    [user.hotelId, stayId, today]
  );

  // 1) 在住单早餐份数 + N
  run(`UPDATE stays SET breakfast = COALESCE(breakfast, 0) + ? WHERE id = ? AND hotel_id = ?`, [
    count,
    stayId,
    user.hotelId,
  ]);

  // 2) 当日记录 + N；原来没有记录（无早房）则新建一条待核销
  if (record) {
    run(
      `UPDATE breakfast_records SET count = count + ?, status = 'PENDING', note = ?
        WHERE id = ? AND hotel_id = ?`,
      [count, `卖早餐 +${count} 份`, record.id, user.hotelId]
    );
  } else {
    run(
      `INSERT INTO breakfast_records
         (hotel_id, stay_id, room_no, guest_name, date, count, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.hotelId, stayId, stay.room_no, stay.guest_name ?? "散客", today, count, "PENDING", `卖早餐 ${count} 份`, nowIso()]
    );
  }

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "卖早餐",
    `入住单 ${stayId} · 房间 ${stay.room_no ?? "-"} · 客人 ${stay.guest_name ?? "散客"} · +${count} 份 · 日期 ${today}`
  );

  const total = (record ? record.count : 0) + count;
  revalidatePath("/breakfast");
  revalidatePath("/inhouse");
  redirect(
    backTo(
      today,
      `${stay.room_no ?? "该房"}${stay.guest_name ? `（${stay.guest_name}）` : ""} 加卖早餐 ${count} 份，当前待核销 ${total} 份`
    )
  );
}
