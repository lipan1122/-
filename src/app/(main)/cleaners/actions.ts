"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, getDb, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 打扫员档案（整改清单 第六轮 一.9）
 *
 * ── 原来的问题 ──
 * 新增 / 启停只调 `requireUser()`。而 housekeeper 角色**本来就能进 /cleaners**（看自己的业绩），
 * 于是「客房人员」可以直接改打扫员档案：把自己停用、把别人的名字改掉都不受拦。
 *
 * ── 现在 ──
 *   · 新增 / 启停 → `requirePermission("settings.manage")`（当前仅 admin）：
 *     客房岗位没有任何配置权限，构造请求也会收到 FORBIDDEN；
 *     页面上「新增打扫员 / 停用 / 启用」按钮也按同一权限隐藏（housekeeper 只看得到列表和业绩）。
 *   · 停用前检查未完成任务：housekeeping 里还有 `assignee = 姓名 AND status IN ('PENDING','DOING')`
 *     就不允许停用 —— 否则这些任务会指向一个「不存在在岗人员」，房态页的待打扫队列没人接手。
 *   · 历史业绩保留：停用只改 `cleaners.status = 'INACTIVE'`，**从不 DELETE**，
 *     业绩报表按 assignee 姓名汇总 housekeeping 的历史任务，停用后数字一分不少。
 *   · 每次新增 / 启停都写 op_logs（谁、什么时候、把谁从什么状态改到什么状态）。
 */

/**
 * 懒建表：打扫员。
 * status：ACTIVE 在岗 / INACTIVE 已停用；业绩来自 housekeeping 表中 assignee = 姓名的已完成任务。
 */
function ensureCleanersTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS cleaners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
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

function backTo(msg?: string, err?: string): string {
  const p = new URLSearchParams();
  if (msg) p.set("msg", msg);
  if (err) p.set("err", err);
  const qs = p.toString();
  return qs ? `/cleaners?${qs}` : "/cleaners";
}

/** op_logs 可能不存在（旧库），失败不影响主流程 */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string) {
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator,
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    /* 老库没有 op_logs → 跳过审计 */
  }
}

/** 该打扫员名下未完成（待打扫 / 打扫中）的任务数，停用前的安全检查用 */
function pendingTasksOf(hotelId: number, name: string): number {
  return (
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM housekeeping
        WHERE hotel_id = ? AND assignee = ? AND status IN ('PENDING','DOING')`,
      [hotelId, name]
    )?.c ?? 0
  );
}

/** 新增打扫员：姓名必填且不重名，电话可空 */
export async function addCleanerAction(formData: FormData): Promise<void> {
  // 权限：人事档案配置 → settings.manage（客房岗位被拒）
  const user = await requirePermission("settings.manage");
  ensureCleanersTable();

  const name = str(formData.get("name"));
  const phone = str(formData.get("phone"));

  if (!name) redirect(backTo(undefined, "请输入打扫员姓名"));
  if (name.length > 20) redirect(backTo(undefined, "姓名不能超过 20 个字"));
  if (phone && !/^[\d+\-\s]{5,20}$/.test(phone)) redirect(backTo(undefined, "电话格式不正确，请填写 5-20 位号码"));

  const dup = get<{ id: number }>(`SELECT id FROM cleaners WHERE hotel_id = ? AND name = ?`, [
    user.hotelId,
    name,
  ]);
  if (dup) redirect(backTo(undefined, `已存在名为「${name}」的打扫员`));

  run(`INSERT INTO cleaners (hotel_id, name, phone, status, created_at) VALUES (?,?,?,?,?)`, [
    user.hotelId,
    name,
    phone || null,
    "ACTIVE",
    nowIso(),
  ]);

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    "新增打扫员",
    `${name}${phone ? `（${phone}）` : ""} · 状态 ACTIVE`
  );

  revalidatePath("/cleaners");
  redirect(backTo(`已新增打扫员 ${name}`));
}

/**
 * 停用 / 启用打扫员：停用后不再参与派单，历史业绩保留。
 *
 * 停用前必须先清空未完成任务 —— 否则房态页 / 客房中心的待打扫队列里会留着一批
 * 指派给「已停用人员」的任务，前台既看不到人也不知道该转给谁。
 */
export async function setCleanerStatusAction(formData: FormData): Promise<void> {
  // 权限：人事档案配置 → settings.manage（客房岗位被拒）
  const user = await requirePermission("settings.manage");
  ensureCleanersTable();

  const id = num(formData.get("id"));
  const status = str(formData.get("status")) === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  if (!id) redirect(backTo(undefined, "没有找到要操作的打扫员"));

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM cleaners WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) redirect(backTo(undefined, "该打扫员不存在或已删除"));
  if (row.status === status) {
    redirect(backTo(undefined, `${row.name} 已经是${status === "ACTIVE" ? "在岗" : "停用"}状态`));
  }

  /* 停用前检查未完成任务（整改清单 一.9 明确要求） */
  if (status === "INACTIVE") {
    const pending = pendingTasksOf(user.hotelId, row.name);
    if (pending > 0) {
      redirect(
        backTo(
          undefined,
          `${row.name} 还有 ${pending} 条未完成的打扫任务（待打扫 / 打扫中），请先转派或完成后再停用`
        )
      );
    }
  }

  /*
   * 只改状态，不删行：cleaners 行是业绩汇总的姓名来源，
   * housekeeping 里 assignee = 姓名的历史任务会一直算进报表。
   */
  run(`UPDATE cleaners SET status = ? WHERE id = ? AND hotel_id = ?`, [status, id, user.hotelId]);

  writeOpLog(
    user.hotelId,
    user.realName || user.username,
    status === "ACTIVE" ? "启用打扫员" : "停用打扫员",
    `${row.name}（ID ${id}）· ${row.status} → ${status} · 历史业绩保留（不改删任务记录）`
  );

  revalidatePath("/cleaners");
  redirect(backTo(`${row.name} 已${status === "ACTIVE" ? "启用" : "停用"}`));
}
