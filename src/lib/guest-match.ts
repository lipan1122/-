/**
 * 客史匹配（整改清单 P1-9）
 *
 * ── 缺陷 ──
 * 原来各处按「姓名」或「手机号」各自匹配客人档案，口径不一：
 *   · 按姓名匹配 → 重名时改错人（`WHERE name = ? LIMIT 1` 命中谁看运气）
 *   · 按手机号匹配 → 换手机号就认不出是同一人
 *   · 没有唯一约束 → 同一手机号能建出多份档案
 *
 * ── 收敛后的口径（唯一）──
 *   1. 优先证件号（唯一，最可靠）
 *   2. 次选手机号（次可靠）
 *   3. 姓名只用于「新建时预填展示」，绝不用于定位档案
 *
 * 数据库约束：
 *   UNIQUE(hotel_id, id_no)  WHERE id_no IS NOT NULL AND id_no <> ''
 *   UNIQUE(hotel_id, mobile) WHERE mobile IS NOT NULL AND mobile <> ''
 *   （部分索引：空值不参与唯一性判断，没有手机号/证件号的散客可以有多条）
 *
 * 改客史必须带 guest_id，不能再「按姓名改」。
 */

import { all, get } from "@/lib/db";

export type GuestMatchInput = {
  idNo?: string | null;
  mobile?: string | null;
  name?: string | null;
};

export type GuestHit = {
  id: number;
  name: string;
  mobile: string | null;
  idNo: string | null;
  vipLevel: number;
  /** 命中的依据：证件号 / 手机号 */
  matchedBy: "id_no" | "mobile";
};

function trim(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 按唯一字段查找客人档案。
 * 返回 null 表示「没有档案，需要新建」——注意这不等于「按姓名找不到」。
 */
export function findGuestByIdentity(hotelId: number, input: GuestMatchInput): GuestHit | null {
  const idNo = trim(input.idNo);
  const mobile = trim(input.mobile);

  if (idNo) {
    const row = get<Omit<GuestHit, "matchedBy">>(
      `SELECT id, name, mobile, id_no AS idNo, COALESCE(vip_level, 0) AS vipLevel
         FROM guests
        WHERE hotel_id = ? AND id_no = ? AND COALESCE(deleted, 0) = 0
        LIMIT 1`,
      [hotelId, idNo]
    );
    if (row) return { ...row, matchedBy: "id_no" };
  }

  if (mobile) {
    const row = get<Omit<GuestHit, "matchedBy">>(
      `SELECT id, name, mobile, id_no AS idNo, COALESCE(vip_level, 0) AS vipLevel
         FROM guests
        WHERE hotel_id = ? AND mobile = ? AND COALESCE(deleted, 0) = 0
        ORDER BY id
        LIMIT 1`,
      [hotelId, mobile]
    );
    if (row) return { ...row, matchedBy: "mobile" };
  }

  return null;
}

/**
 * 重名检查：只用于「提示前台这里有同名客人，确认是不是同一个人」，
 * **不用于定位档案**。返回同名客人列表供人工确认。
 */
export function findSameNameGuests(hotelId: number, name: string): { id: number; name: string; mobile: string | null }[] {
  const n = trim(name);
  if (!n) return [];
  return all<{ id: number; name: string; mobile: string | null }>(
    `SELECT id, name, mobile FROM guests
      WHERE hotel_id = ? AND name = ? AND COALESCE(deleted, 0) = 0
      ORDER BY id LIMIT 5`,
    [hotelId, n]
  );
}

/**
 * 判断「同一手机号/证件号是否已被别的档案占用」。
 * 新建客史前调用，避免撞唯一索引报 SQLITE_CONSTRAINT 给用户看天书。
 */
export function findConflictGuest(
  hotelId: number,
  input: GuestMatchInput,
  excludeGuestId?: number
): { field: "id_no" | "mobile"; guestId: number; name: string } | null {
  const idNo = trim(input.idNo);
  const mobile = trim(input.mobile);

  if (idNo) {
    const row = get<{ id: number; name: string }>(
      `SELECT id, name FROM guests
        WHERE hotel_id = ? AND id_no = ? AND COALESCE(deleted,0) = 0 AND (? IS NULL OR id <> ?)
        LIMIT 1`,
      [hotelId, idNo, excludeGuestId ?? null, excludeGuestId ?? null]
    );
    if (row) return { field: "id_no", guestId: row.id, name: row.name };
  }
  if (mobile) {
    const row = get<{ id: number; name: string }>(
      `SELECT id, name FROM guests
        WHERE hotel_id = ? AND mobile = ? AND COALESCE(deleted,0) = 0 AND (? IS NULL OR id <> ?)
        LIMIT 1`,
      [hotelId, mobile, excludeGuestId ?? null, excludeGuestId ?? null]
    );
    if (row) return { field: "mobile", guestId: row.id, name: row.name };
  }
  return null;
}
