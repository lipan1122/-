"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { get, run, tx } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/** 会员升级规则在 settings 表的 key（值为 JSON） */
const UPGRADE_RULES_KEY = "member_upgrade_rules";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 表单值转数字，非法值回落默认 */
function toNumber(value: FormDataEntryValue | null, fallback = 0) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

/** op_logs 可能不存在（旧库），静默跳过避免保存失败 */
function writeOpLog(hotelId: number, operator: string, action: string, detail: string) {
  const exists =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'op_logs'`)
      ?.n ?? 0;
  if (exists <= 0) return;
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    operator,
    action,
    detail,
    nowIso(),
  ]);
}

/** 统一的回跳：始终回到会员升级 tab，方便看到结果提示 */
function backUpgrade(message: string, isError = false): never {
  const qs = new URLSearchParams({ tab: "upgrade" });
  qs.set(isError ? "err" : "msg", message);
  redirect(`/members?${qs.toString()}`);
}

/** 会员等级只允许 1-3，空值 / 非法值回落到 1 */
function levelOf(value: FormDataEntryValue | null) {
  const n = Math.trunc(Number(String(value ?? "").trim()));
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, n));
}

/** 新增会员：写入 guests（vip_level > 0 即会员） */
export async function createMemberAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const mobile = String(formData.get("mobile") ?? "").trim();
  const level = levelOf(formData.get("vip_level"));

  // 同一手机号已有客史：不重复建档，直接确保其为会员并取较高等级
  if (mobile) {
    const existed = get<{ id: number; vip_level: number }>(
      `SELECT id, vip_level FROM guests WHERE hotel_id = ? AND mobile = ? ORDER BY id LIMIT 1`,
      [user.hotelId, mobile]
    );
    if (existed) {
      if (Number(existed.vip_level ?? 0) < level) {
        run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [level, existed.id, user.hotelId]);
      }
      revalidatePath("/members");
      return;
    }
  }

  run(
    `INSERT INTO guests (hotel_id, name, mobile, vip_level, blacklist, created_at)
     VALUES (?,?,?,?,0,?)`,
    [user.hotelId, name, mobile, level, nowIso()]
  );
  revalidatePath("/members");
}

/** 升级会员等级：VIP1 → VIP2 → VIP3，VIP3 不再升级 */
export async function upgradeMemberAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (!id) return;

  const row = get<{ vip_level: number }>(
    `SELECT vip_level FROM guests WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) return;

  const current = Math.max(1, Number(row.vip_level ?? 0));
  const next = Math.min(3, current + 1);
  if (next === current) return;

  run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [next, id, user.hotelId]);
  revalidatePath("/members");
}

/** 取消会员：等级归零，客史保留 */
export async function cancelMemberAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (!id) return;

  run(`UPDATE guests SET vip_level = 0 WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  revalidatePath("/members");
}

/**
 * 保存会员升级规则：VIP1/VIP2/VIP3 的门槛（累计消费金额 / 入住次数）、折扣、积分比例。
 * 统一存 settings 表 key = member_upgrade_rules，值为 JSON：
 * { basis: "spend" | "stays", levels: [{ level, minSpend, minStays, discount, pointsRate }] }
 */
export async function saveUpgradeRulesAction(formData: FormData) {
  // 权限边界（上线前加固）：升级规则决定全店折扣与积分比例，仅 admin 可改，原来只校验登录
  const user = await requireAdmin();
  const hotelId = user.hotelId;

  const basisRaw = String(formData.get("basis") ?? "spend").trim();
  const basis: "spend" | "stays" = basisRaw === "stays" ? "stays" : "spend";

  const levels: {
    level: number;
    minSpend: number;
    minStays: number;
    discount: number;
    pointsRate: number;
  }[] = [];

  for (const lv of [1, 2, 3]) {
    const minSpend = Math.max(0, round2(toNumber(formData.get(`minSpend_${lv}`))));
    const minStays = Math.max(0, Math.trunc(toNumber(formData.get(`minStays_${lv}`))));

    // 折扣允许填 95（百分比）或 0.95（折扣率），统一落库为 0.1 ~ 1 的折扣率
    const dRaw = toNumber(formData.get(`discount_${lv}`), 100);
    const dNormalized = dRaw > 1 ? dRaw / 100 : dRaw;
    const discount = Math.min(1, Math.max(0.1, round2(dNormalized)));

    const pointsRate = Math.min(10, Math.max(0, round2(toNumber(formData.get(`pointsRate_${lv}`), 1))));

    levels.push({ level: lv, minSpend, minStays, discount, pointsRate });
  }

  // 高等级门槛不应低于低等级，否则升级判定会失真
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1];
    const cur = levels[i];
    if (cur.minSpend < prev.minSpend) {
      backUpgrade(`VIP${cur.level} 的累计消费门槛不能低于 VIP${prev.level}`, true);
    }
    if (cur.minStays < prev.minStays) {
      backUpgrade(`VIP${cur.level} 的入住次数门槛不能低于 VIP${prev.level}`, true);
    }
  }

  const value = JSON.stringify({ basis, levels });
  const updated = run(`UPDATE settings SET value = ? WHERE hotel_id = ? AND key = ?`, [
    value,
    hotelId,
    UPGRADE_RULES_KEY,
  ]);
  if (updated.changes <= 0) {
    run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, UPGRADE_RULES_KEY, value]);
  }

  writeOpLog(
    hotelId,
    user.realName,
    "保存会员升级规则",
    `口径：${basis === "stays" ? "入住次数" : "累计消费金额"} · VIP2 ≥ ${levels[1].minSpend} 元/${levels[1].minStays} 次 · VIP3 ≥ ${levels[2].minSpend} 元/${levels[2].minStays} 次`
  );

  revalidatePath("/members");
  backUpgrade("会员升级规则已保存（settings.member_upgrade_rules）");
}

/**
 * 待升级清单里的「升级」按钮：把会员等级真实抬到应得等级（target），并写 op_logs。
 * target 由页面按当前生效规则算出，服务端再次夹紧到 2~3 且必须高于当前等级。
 */
export async function applyUpgradeAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const targetRaw = Math.trunc(toNumber(formData.get("target"), 0));
  if (!id) backUpgrade("缺少会员 ID，升级未执行", true);

  const row = get<{ id: number; name: string; vip_level: number }>(
    `SELECT id, name, vip_level FROM guests WHERE id = ? AND hotel_id = ?`,
    [id, user.hotelId]
  );
  if (!row) backUpgrade("未找到该会员，升级未执行", true);

  const current = Math.max(1, Number(row.vip_level ?? 0));
  const target = Math.min(3, Math.max(1, targetRaw || current + 1));
  if (target <= current) {
    backUpgrade(`${row.name} 当前已是 VIP${current}，未产生升级`, true);
  }

  run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [target, id, user.hotelId]);
  writeOpLog(
    user.hotelId,
    user.realName,
    "会员升级",
    `会员 ${row.name}（ID ${row.id}）VIP${current} → VIP${target}`
  );

  revalidatePath("/members");
  backUpgrade(`${row.name} 已升级为 VIP${target}`);
}

/**
 * 会员 CSV 导入：表头 姓名,手机号,会员等级,会员卡号,备注
 *
 * 整改清单 P2-27：导入没有任何大小限制 —— 原来直接 `await file.text()`
 * 把整个上传文件读进内存，再把所有行一次性塞进一个事务。
 * 一个 200MB 的 CSV（或一份被误选的数据库文件）足以让 Node 进程 OOM，
 * 而 OOM 是不可捕获的，整个 PMS 会连同正在办理的入住一起挂掉。
 *
 * 两道闸：
 *   1. 文件大小 ≤ 5MB（10 万条会员的 CSV 通常也不到 2MB，够用）；
 *   2. 数据行数 ≤ 5000（即使文件很小，几十万行也会让单事务锁住 SQLite 几十秒，
 *      前台的入住/结账会全部排队等这把写锁）。
 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_MAX_ROWS = 5000;

export async function importMembersAction(formData: FormData) {
  const user = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/members?err=" + encodeURIComponent("请选择 CSV 文件"));
  }
  if (file.size > IMPORT_MAX_BYTES) {
    redirect(
      "/members?err=" +
        encodeURIComponent(
          `文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限，请拆分后再导入`
        )
    );
  }
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) redirect("/members?err=" + encodeURIComponent("文件为空或没有数据行"));
  if (lines.length - 1 > IMPORT_MAX_ROWS) {
    redirect(
      "/members?err=" +
        encodeURIComponent(`数据 ${lines.length - 1} 行超过单次 5000 行上限，请拆分后再导入`)
    );
  }

  const parse = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === "," && !inQ) {
        out.push(cur); cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  let inserted = 0;
  let skipped = 0;
  const now = nowIso();
  tx(() => {
    for (const line of lines.slice(1)) {
      const [name, mobile, level, cardNo, remark] = parse(line);
      if (!name) { skipped++; continue; }
      const exists = get<{ id: number }>(
        `SELECT id FROM guests WHERE hotel_id = ? AND (name = ? OR (mobile IS NOT NULL AND mobile = ?)) LIMIT 1`,
        [user.hotelId, name, mobile || null]
      );
      if (exists) { skipped++; continue; }
      const vip = /VIP(\d)/i.exec(level ?? "")?.[1];
      run(
        `INSERT INTO guests (hotel_id, name, mobile, vip_level, note, created_at) VALUES (?,?,?,?,?,?)`,
        [user.hotelId, name, mobile || null, vip ? Number(vip) : 0, [cardNo ? `卡号 ${cardNo}` : '', remark].filter(Boolean).join(' · ') || null, now]
      );
      inserted++;
    }
    run(
      `INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`,
      [user.hotelId, user.realName, "会员导入", `导入 ${inserted} 条，跳过 ${skipped} 条`, now]
    );
  });

  revalidatePath("/members");
  redirect(`/members?msg=${encodeURIComponent(`导入完成：新增 ${inserted} 条，跳过 ${skipped} 条（重名或手机号重复）`)}`);
}
