"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run } from "@/lib/db";
import { requirePermissionOrRedirect } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/** 人证核验：校验身份证号格式与校验码，并比对客史 */

type GuestHit = { id: number; name: string | null };

type IdCardInfo = { birthDate: string; gender: string; age: number };

type IdParseResult = { ok: true; info: IdCardInfo } | { ok: false; reason: string };

/** GB 11643 加权因子（前 17 位） */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;

/** 校验码对照表：加权和 % 11 的下标即末位字符 */
const ID_CHECK_CODES = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

let schemaReady = false;

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function back(key: "err" | "msg", message: string): never {
  redirect(`/id-verify?${key}=${encodeURIComponent(message)}`);
}

/** 懒建表（幂等）：核验记录表 */
export async function ensureIdVerifySchema(): Promise<void> {
  /*
   * 权限边界（整改 A 类缺口）：建表助手同样是可被直接 POST 的写动作。
   * 为什么是 guest.view_sensitive：身份证核验本身就是在**读取/落库客人证件号**
   * （敏感字段），该点授权 admin / frontdesk，与 /id-verify 页面的可见角色完全一致
   * （ROLE_MODULES 里只有 admin / frontdesk），补守卫不会影响正常核验流程。
   */
  await requirePermissionOrRedirect("guest.view_sensitive");
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS id_verify_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    name TEXT,
    id_no TEXT,
    result TEXT,
    operator TEXT,
    created_at TEXT
  )`);
  schemaReady = true;
}

/**
 * 解析 18 位身份证号：
 * 1. 位数 / 字符格式（前 17 位数字，末位数字或 X）
 * 2. 校验码算法（加权和 % 11 查表）
 * 3. 第 7-14 位出生日期是否真实存在
 * 4. 第 17 位奇偶判断性别，并按时差计算周岁
 */
function parseIdCard(raw: string): IdParseResult {
  const idNo = raw.trim().toUpperCase();

  if (!/^\d{17}[\dX]$/.test(idNo)) {
    return { ok: false, reason: "身份证号必须为 18 位（前 17 位数字，末位为数字或 X）" };
  }

  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += Number(idNo[i]) * ID_WEIGHTS[i];
  }
  const expected = ID_CHECK_CODES[sum % 11];
  if (expected !== idNo[17]) {
    return { ok: false, reason: `校验码不匹配，第 18 位应为 ${expected}` };
  }

  const year = Number(idNo.slice(6, 10));
  const month = Number(idNo.slice(10, 12));
  const day = Number(idNo.slice(12, 14));
  const now = new Date();
  const birth = new Date(year, month - 1, day);

  const invalidDate =
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    birth.getFullYear() !== year ||
    birth.getMonth() !== month - 1 ||
    birth.getDate() !== day ||
    birth.getTime() > now.getTime();

  if (invalidDate) {
    return { ok: false, reason: "出生日期无效（第 7-14 位），请核对证件号" };
  }

  let age = now.getFullYear() - year;
  const monthDiff = now.getMonth() + 1 - month;
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < day)) age -= 1;

  const gender = Number(idNo[16]) % 2 === 1 ? "男" : "女";

  return { ok: true, info: { birthDate: `${year}-${pad2(month)}-${pad2(day)}`, gender, age } };
}

/** 与 guests 客史表比对：先按证件号命中，再退回同名匹配 */
function matchGuest(hotelId: number, name: string, idNo: string): string {
  const byId = get<GuestHit>(
    `SELECT id, name FROM guests WHERE hotel_id = ? AND (id_no = ? OR UPPER(id_no) = ?) LIMIT 1`,
    [hotelId, idNo, idNo]
  );
  if (byId) {
    return byId.name && byId.name === name ? "客史已存在（姓名一致）" : `客史已存在（档案姓名：${byId.name ?? "未填"}）`;
  }

  const byName = get<GuestHit>(`SELECT id, name FROM guests WHERE hotel_id = ? AND name = ? LIMIT 1`, [
    hotelId,
    name,
  ]);
  if (byName) return "客史有同名记录，证件号未登记";
  return "客史无记录（新客人）";
}

/**
 * 人证核验：写核验日志（通过 / 未通过都记录），并带着结果回到页面显示
 */
export async function verifyIdAction(formData: FormData): Promise<void> {
  /*
   * 权限（整改 A 类缺口）：原来只有 requireUser()。
   * 本动作会把客人姓名 / 证件号写进 id_verify_logs 并返回核验结果，
   * 属「客人敏感信息」类操作，用 guest.view_sensitive（admin / frontdesk）。
   */
  const user = await requirePermissionOrRedirect("guest.view_sensitive");
  await ensureIdVerifySchema();

  const name = str(formData.get("name"));
  const idNo = str(formData.get("id_no")).toUpperCase().replace(/\s+/g, "");

  if (!name) back("err", "请填写客人姓名");
  if (!idNo) back("err", "请填写身份证号");

  const parsed = parseIdCard(idNo);
  const resultText = parsed.ok
    ? `校验通过：性别 ${parsed.info.gender}，出生日期 ${parsed.info.birthDate}，年龄 ${parsed.info.age} 岁，${matchGuest(
        user.hotelId,
        name,
        idNo
      )}`
    : `核验未通过：${parsed.reason}`;

  run(
    `INSERT INTO id_verify_logs (hotel_id, name, id_no, result, operator, created_at) VALUES (?,?,?,?,?,?)`,
    [user.hotelId, name, idNo, resultText, user.realName, nowIso()]
  );

  revalidatePath("/id-verify");

  back(parsed.ok ? "msg" : "err", resultText);
}
