"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run } from "@/lib/db";
import { requirePermissionOrRedirect } from "@/lib/session";
import { nowIso, todayStr } from "@/lib/utils";

/**
 * 失物招领动作（整改清单 P2-25）
 *
 * 本文件是失物招领的**唯一定义处**：页面 `page.tsx` 只做渲染。
 * 之前同一套登记 / 认领 / 删除逻辑在页面里又内联了一份，改一处漏一处 ——
 * 典型的 bug 是内联版读 `place` / `desc`、本文件读 `keeper` / `note`，
 * 表单字段一换，「拾获人」「备注」就静默存不进去了。
 * 所以字段名以页面表单为准（name / place / room_no / desc），只保留这一份实现。
 *
 * ── 权限（整改 A 类缺口：本文件 4 个动作原来只有 requireUser()）──
 * 失物招领没有独立权限点（PERMISSION_CODES 里没有 lost_found.*），而它的实际操作者
 * 正好是「前台 + 客房」——客房打扫时拾到物品要登记、前台要办理认领。
 * 现有权限点里同时授权 admin / frontdesk / housekeeping 的**操作类**点只有
 * room.change_status（room.view 是查看语义，不能拿来守写动作），
 * 所以 4 个动作统一用它；它与 /lost-found 的页面可见角色完全一致，不会锁死正常作业。
 * 若以后要单独控制（例如「删除」只给主管），需要新增 lost_found.manage 并同步
 * session.ts 的 PERMISSIONS 与 permission_dict —— 那超出本次改造的文件范围。
 *
 * 用 requirePermissionOrRedirect 而不是 requirePermission：生产构建会把
 * Server Action 抛出的错误脱敏成「操作失败」，跳 /no-permission 才能给出明确原因。
 */

/** 失败 / 成功回跳：文案带在 query 上，页面顶部渲染横幅 */
function backLostFound(message: string, isError = false): never {
  const qs = new URLSearchParams();
  qs.set(isError ? "err" : "msg", message);
  redirect(`/lost-found?${qs.toString()}`);
}

/**
 * 登记失物
 *
 * 字段名对齐页面表单：name（物品名称）/ place（拾获人）/ room_no（房号）/ desc（备注）。
 * 状态写 PENDING（待认领），拾获日期在登记时写一次，之后认领不再覆盖（P1-30）。
 */
export async function createLostItemAction(formData: FormData) {
  const user = await requirePermissionOrRedirect("room.change_status");
  const name = String(formData.get("name") ?? "").trim();
  const keeper = String(formData.get("place") ?? "").trim();
  const roomNo = String(formData.get("room_no") ?? "").trim();
  const note = String(formData.get("desc") ?? "").trim();
  if (!name) return;
  run(
    `INSERT INTO lost_items (hotel_id, item_name, keeper, room_no, note, status, found_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [user.hotelId, name, keeper, roomNo, note, "PENDING", todayStr(), nowIso()]
  );
  revalidatePath("/lost-found");
}

/**
 * 认领失物
 *
 * 整改清单 P1-30：原来这条 SQL 带 `found_at = ?`，把「拾获日期」覆盖成认领当天。
 * found_at 是列表里「拾获日期」的唯一来源，客人一认领，原始拾获时间就永久丢失 ——
 * 事后追问「这件东西是什么时候、在哪儿捡到的」已经不可能回答，
 * 而拾获时间恰恰是失物招领最核心的追溯信息。
 *
 * 现在：found_at 只在登记时写一次；认领时间写进 claimed_at（老库由页面 ALTER TABLE 兜底补列）。
 */
export async function claimLostItemAction(formData: FormData) {
  const user = await requirePermissionOrRedirect("room.change_status");
  const id = Number(formData.get("id") ?? 0);
  const claimant = String(formData.get("claimant") ?? "").trim();
  if (!id) return;

  const item = get<{ item_name: string; status: string | null }>(
    `SELECT item_name, status FROM lost_items WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!item) backLostFound("未找到该失物记录，认领未执行", true);
  if (item.status === "CLAIMED") backLostFound(`「${item.item_name}」已被认领，无需重复操作`, true);
  if (!claimant) backLostFound("请填写认领人后在点「认领」", true);

  run(
    `UPDATE lost_items SET status = 'CLAIMED', guest_name = ?, claimed_at = ? WHERE id = ? AND hotel_id = ?`,
    [claimant, nowIso(), id, user.hotelId]
  );

  /* 整改清单 P1-34：失物认领属于「物品已交给外部人员」的敏感操作，必须留痕 */
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName || user.username,
      "失物认领",
      `${item.item_name}（ID ${id}）由 ${claimant} 认领`,
      nowIso(),
    ]);
  } catch {
    /* op_logs 不存在 → 跳过审计 */
  }

  revalidatePath("/lost-found");
  backLostFound(`「${item.item_name}」已登记为 ${claimant} 认领`);
}

/**
 * 删除失物记录
 *
 * 整改清单 P1-31：不可逆物理删除，原来既没有二次确认也没有引用检查。
 * 这里的引用检查按业务语义定：
 *   · 已认领（CLAIMED）的记录是对客交付凭证，不允许删；
 *   · 已归还（RETURNED）同理不允许删；
 * 二次确认由页面上的 ConfirmForm 承担（要求填写删除原因），服务端再校验一次原因。
 */
export async function deleteLostItemAction(formData: FormData) {
  const user = await requirePermissionOrRedirect("room.change_status");
  const id = Number(formData.get("id") ?? 0);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!id) return;

  const row = get<{ item_name: string; status: string | null; guest_name: string | null }>(
    `SELECT item_name, status, guest_name FROM lost_items WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) backLostFound("未找到该失物记录，删除未执行", true);

  if (row.status === "CLAIMED") {
    backLostFound(`「${row.item_name}」已由 ${row.guest_name || "客人"} 认领，属对客交付凭证，不能删除`, true);
  }
  if (row.status === "RETURNED") {
    backLostFound(`「${row.item_name}」已归还，属对客交付凭证，不能删除`, true);
  }
  if (!reason) backLostFound("删除失物记录必须填写原因", true);

  run(`DELETE FROM lost_items WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);

  /* 整改清单 P1-34：物理删除必须留痕（含原因），否则事后无法解释记录去哪了 */
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName || user.username,
      "删除失物记录",
      `${row.item_name}（ID ${id}）· 原因：${reason}`,
      nowIso(),
    ]);
  } catch {
    /* op_logs 不存在 → 跳过审计 */
  }

  revalidatePath("/lost-found");
  backLostFound(`「${row.item_name}」已删除`);
}

/**
 * 标记失物已归还（历史链路保留）
 *
 * 页面当前的流转是「待认领 → 已认领（对客交付）」，没有单独的归还按钮；
 * 但 `scripts/test-tenant-writes2.mjs` 把这条带 hotel_id 的语句当作多租户写入的
 * 静态锚点（lost-found#markReturned），删掉会让验收脚本失去对照点。
 * 保留导出，后续若补「客人未取走、由员工归还入库」的流程可直接接线。
 */
export async function markReturnedAction(formData: FormData) {
  const user = await requirePermissionOrRedirect("room.change_status");
  const id = Number(formData.get("id"));
  if (id) run(`UPDATE lost_items SET status = 'RETURNED' WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  revalidatePath("/lost-found");
}
