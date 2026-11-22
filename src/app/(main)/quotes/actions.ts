"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 报价维护（整改清单 第六轮 一.8）
 *
 * ── 原来的问题 ──
 * 保存 / 删除都只调 `requireUser()`：任何登录账号都能改全店报价、删掉正在被活动引用的价格。
 * 报价是**价格配置**，和房型房价同级，不是前台日常作业。
 *
 * ── 现在 ──
 *   · 增 / 改 / 删 全部 `requirePermission("settings.manage")`（当前仅 admin）；
 *   · 删除是二次确认：页面用 ConfirmForm 弹窗并强制填写原因，服务端再校验一次原因（防绕过），
 *     并把被删报价的名称、价格、有效期写进 op_logs；
 *   · 每条写操作都带 hotel_id（UPDATE / DELETE 的 WHERE 里，INSERT 直接带列），
 *     跨酒店构造 id 只会命中 0 行。
 */

/** 回跳 /quotes，文案带在 query 上，页面顶部渲染横幅 */
function back(key: "err" | "msg", message: string): never {
  redirect(`/quotes?${key}=${encodeURIComponent(message)}`);
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

/** 新增 / 修改报价（id 有值即修改） */
export async function saveQuoteAction(formData: FormData) {
  // 权限：报价 = 价格配置 → settings.manage
  const user = await requirePermission("settings.manage");
  const id = Number(formData.get("id") ?? 0);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const values = [
    name,
    Number(formData.get("room_type_id")) || null,
    Number(formData.get("price")) || 0,
    String(formData.get("start_date") ?? ""),
    String(formData.get("end_date") ?? ""),
    String(formData.get("note") ?? ""),
  ];

  if (id) {
    // 读旧值只为日志能说清改了哪条（未命中本店 → 不改任何行）
    const old = get<{ name: string; price: number }>(
      `SELECT name, price FROM quotes WHERE id = ? AND hotel_id = ?`,
      [id, user.hotelId]
    );
    if (!old) back("err", "报价不存在或不属于本店，未保存");

    run(
      `UPDATE quotes SET name=?, room_type_id=?, price=?, start_date=?, end_date=?, note=? WHERE id=? AND hotel_id=?`,
      [...values, id, user.hotelId]
    );
    writeOpLog(
      user.hotelId,
      user.realName,
      "修改报价",
      `「${old.name}」→「${name}」· 价格 ¥${Number(old.price ?? 0)} → ¥${values[2]} · 有效期 ${values[3]} ~ ${values[4]}`
    );
    revalidatePath("/quotes");
    back("msg", `报价「${name}」已保存`);
  } else {
    run(
      `INSERT INTO quotes (hotel_id, name, room_type_id, price, start_date, end_date, note, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [user.hotelId, ...values, nowIso()]
    );
    writeOpLog(
      user.hotelId,
      user.realName,
      "新增报价",
      `「${name}」· 价格 ¥${values[2]} · 有效期 ${values[3]} ~ ${values[4]}`
    );
    revalidatePath("/quotes");
    back("msg", `报价「${name}」已新增`);
  }
}

/**
 * 删除报价：二次确认 + 原因必填（服务端校验，防绕过）。
 *
 * 不改用「软删除」的理由：quotes 表没有订单外键（协议价走 bookings.company_id / 报价快照），
 * 删掉不会留孤儿引用；不可逆性由「原因必填 + op_logs 留痕」控住。
 */
export async function deleteQuoteAction(formData: FormData) {
  // 权限：删除价格配置 → settings.manage
  const user = await requirePermission("settings.manage");
  const id = Number(formData.get("id"));
  if (!id) back("err", "报价不存在，请刷新后重试");

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) back("err", "删除报价必须在确认框中填写原因（二次确认）");

  const quote = get<{ id: number; name: string; price: number; start_date: string | null; end_date: string | null }>(
    `SELECT id, name, price, start_date, end_date FROM quotes WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!quote) back("err", "报价不存在或不属于本店，未删除");

  run(`DELETE FROM quotes WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);

  writeOpLog(
    user.hotelId,
    user.realName,
    "删除报价",
    `「${quote.name}」（ID ${id}）· 价格 ¥${Number(quote.price ?? 0)} · 有效期 ${quote.start_date ?? "-"} ~ ${
      quote.end_date ?? "-"
    } · 原因：${reason}`
  );

  revalidatePath("/quotes");
  back("msg", `报价「${quote.name}」已删除`);
}
