"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/session";
import { nowIso } from "@/lib/utils";

/**
 * 会员写操作（整改清单 第六轮 一.7）
 *
 * ── 原来的问题 ──
 * 六个 action 全部只调 `requireUser()`：任何登录账号（包括客房阿姨的 housekeeper）
 * 都能新增会员、抬等级、取消会员、导入 CSV、按规则批量升级 —— 等级直接换折扣与积分权益。
 *
 * ── 现在的权限口径 ──
 *   建档 / 改档案 / 导入       → guest.modify  （会员本质是客人档案）
 *   等级变更（升级 / 取消 / 自动升级） → member.manage（权益变更，单独授权）
 *   升级规则配置              → settings.manage（改规则＝改全店权益政策）
 *   敏感字段（手机号）展示     → member.view_sensitive（没有就脱敏，提示文案里也不给明文）
 *
 * ── 身份定位口径（清单「不得通过姓名误改同名客史」）──
 * 所有 UPDATE 一律 `WHERE id = ? AND hotel_id = ?`；
 * 任何按姓名的匹配只允许出现在「读取指标」（stays 老数据的 guest_id 为空时才能靠姓名回落），
 * 绝不用于定位要写哪一条客史。导入也不再按姓名查重（姓名不是唯一身份），
 * 只按手机号 / 证件号判重，且判重命中直接跳过，**不改动**已有档案。
 */

/** 会员升级规则在 settings 表的 key（值为 JSON） */
const UPGRADE_RULES_KEY = "member_upgrade_rules";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 表单值转数字，非法值回落默认 */
function toNumber(value: FormDataEntryValue | null, fallback = 0) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

/** 任意值转数字（解析 settings 里的 JSON 规则用） */
function numOf(v: unknown, fallback: number): number {
  const n = Number(v);
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

/** 会员列表 tab 的回跳（新增 / 取消 / 导入的结果提示） */
function backMembers(message: string, isError = false): never {
  const qs = new URLSearchParams({ tab: "members" });
  qs.set(isError ? "err" : "msg", message);
  redirect(`/members?${qs.toString()}`);
}

/** 会员等级只允许 1-3，空值 / 非法值回落到 1 */
function levelOf(value: FormDataEntryValue | null) {
  const n = Math.trunc(Number(String(value ?? "").trim()));
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, n));
}

/** 手机号归一化：去掉空格 / 连字符，便于判重（不做格式改写） */
function normalizeMobile(value: FormDataEntryValue | null): string {
  return String(value ?? "").replace(/[\s-]/g, "").trim();
}

/**
 * 手机号脱敏：调用方没有 member.view_sensitive 时，提示文案 / 错误信息里不出现明文。
 * 导入的「重复手机号」报错必须走它 —— 导出接口已按 guest.view_sensitive 脱敏，
 * 提示文案同样属于「把敏感数据回报给客户端」，不能成为新的泄露口子。
 */
function maskMobile(mobile: string, canSeeSensitive: boolean): string {
  if (!mobile) return "";
  if (canSeeSensitive) return mobile;
  if (mobile.length <= 6) return "****";
  return `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
}

/* ============================================================ 升级规则 */

type UpgradeLevelRule = {
  level: number;
  minSpend: number;
  minStays: number;
  discount: number;
  pointsRate: number;
};

type UpgradeRules = { basis: "spend" | "stays"; levels: UpgradeLevelRule[] };

type MemberMetric = { stay_count: number; total_spend: number };

/** 与 /members 页面的默认值保持一致（规则没保存过时用它） */
const DEFAULT_UPGRADE_RULES: UpgradeRules = {
  basis: "spend",
  levels: [
    { level: 1, minSpend: 0, minStays: 0, discount: 1, pointsRate: 1 },
    { level: 2, minSpend: 3000, minStays: 5, discount: 0.95, pointsRate: 1.5 },
    { level: 3, minSpend: 10000, minStays: 15, discount: 0.9, pointsRate: 2 },
  ],
};

/**
 * 会员指标（累计入住次数 / 累计消费）。
 *
 * 口径说明：老数据里 stays.guest_id 大量为空（本期实测 200 条在住仅 5 条有 guest_id），
 * 所以姓名回落是**读取**必需；但只有 `guest_id IS NULL` 的历史行才允许按姓名回落，
 * 已经关联了 guest_id 的行不会再被同名客人「蹭」到指标。
 */
const MEMBER_METRIC_SQL = `
       (SELECT COUNT(*) FROM stays s
         WHERE s.hotel_id = g.hotel_id
           AND (s.guest_id = g.id OR (s.guest_id IS NULL AND s.guest_name = g.name))) AS stay_count,
       (SELECT COALESCE(SUM(fi.amount), 0)
          FROM folio_items fi
          JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
          JOIN stays s ON s.id = f.stay_id AND s.hotel_id = f.hotel_id
         WHERE s.hotel_id = g.hotel_id
           AND (s.guest_id = g.id OR (s.guest_id IS NULL AND s.guest_name = g.name))
           AND fi.item_type != 'DEPOSIT') AS total_spend`;

/** 解析 settings.member_upgrade_rules，字段缺失 / JSON 损坏时回落默认规则 */
function parseUpgradeRules(raw: string | null | undefined): UpgradeRules {
  if (!raw) return DEFAULT_UPGRADE_RULES;
  try {
    const data = JSON.parse(raw) as { basis?: unknown; levels?: unknown };
    const basis: UpgradeRules["basis"] = data?.basis === "stays" ? "stays" : "spend";
    const list = Array.isArray(data?.levels) ? (data.levels as unknown[]) : [];

    const levels: UpgradeLevelRule[] = [1, 2, 3].map((lv) => {
      const found = list.find((x) => {
        if (!x || typeof x !== "object") return false;
        return Math.trunc(numOf((x as Record<string, unknown>).level, -1)) === lv;
      }) as Record<string, unknown> | undefined;
      const def = DEFAULT_UPGRADE_RULES.levels.find((x) => x.level === lv) ?? DEFAULT_UPGRADE_RULES.levels[0];
      return {
        level: lv,
        minSpend: Math.max(0, round2(numOf(found?.minSpend, def.minSpend))),
        minStays: Math.max(0, Math.trunc(numOf(found?.minStays, def.minStays))),
        discount: Math.min(1, Math.max(0.1, numOf(found?.discount, def.discount))),
        pointsRate: Math.min(10, Math.max(0, numOf(found?.pointsRate, def.pointsRate))),
      };
    });

    return { basis, levels };
  } catch {
    return DEFAULT_UPGRADE_RULES;
  }
}

/** 读本店生效的升级规则（权威来源：settings 表，不信任前端传值） */
function readUpgradeRules(hotelId: number): UpgradeRules {
  const row = get<{ value: string }>(
    `SELECT value FROM settings WHERE hotel_id = ? AND key = ? ORDER BY id DESC LIMIT 1`,
    [hotelId, UPGRADE_RULES_KEY]
  );
  return parseUpgradeRules(row?.value);
}

/** 按生效口径判断会员应得等级（0 表示未达任何等级门槛） */
function targetLevelOf(member: MemberMetric, rules: UpgradeRules): number {
  let target = 0;
  for (const lv of rules.levels) {
    const reached =
      rules.basis === "stays"
        ? Number(member.stay_count ?? 0) >= lv.minStays
        : Number(member.total_spend ?? 0) >= lv.minSpend;
    if (reached && lv.level > target) target = lv.level;
  }
  return target;
}

/** 升级依据的可读描述（写进 op_logs，事后能解释「凭什么升」） */
function ruleBasisText(rules: UpgradeRules, member: MemberMetric, target: number): string {
  const rule = rules.levels.find((lv) => lv.level === target) ?? rules.levels[0];
  const basisLabel = rules.basis === "stays" ? "入住次数" : "累计消费金额";
  const actual =
    rules.basis === "stays"
      ? `${Number(member.stay_count ?? 0)} 次`
      : `¥${round2(Number(member.total_spend ?? 0))}`;
  const need = rules.basis === "stays" ? `${rule.minStays} 次` : `¥${rule.minSpend}`;
  return `按规则「${basisLabel}」：${actual} ≥ VIP${rule.level} 门槛 ${need}`;
}

/* ============================================================ 建档 */

/** 新增会员：写入 guests（vip_level > 0 即会员） */
export async function createMemberAction(formData: FormData) {
  // 权限：建档属于改客人档案
  const user = await requirePermission("guest.modify");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const mobile = normalizeMobile(formData.get("mobile"));
  const level = levelOf(formData.get("vip_level"));

  /*
   * 同一手机号已有客史：不重复建档，直接确保其为会员并取较高等级。
   * 判重只认手机号（唯一身份），命中才更新；姓名不参与定位。
   */
  if (mobile) {
    const existed = get<{ id: number; name: string; vip_level: number }>(
      `SELECT id, name, vip_level FROM guests
        WHERE hotel_id = ? AND mobile = ? AND COALESCE(deleted, 0) = 0
        ORDER BY id LIMIT 1`,
      [user.hotelId, mobile]
    );
    if (existed) {
      const current = Number(existed.vip_level ?? 0);
      if (current < level) {
        /*
         * 抬高已有客人的等级＝等级变更：只凭 guest.modify 就能改别人权益是不对的，
         * 这里再要一次 member.manage（默认角色集两者都有，边界留给酒店自配权限矩阵）。
         */
        if (!hasPermission(user.role, "member.manage", user.hotelId)) {
          throw new Error("FORBIDDEN: 缺少权限 member.manage（抬高已有会员等级）");
        }
        run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [level, existed.id, user.hotelId]);
        writeOpLog(
          user.hotelId,
          user.realName,
          "会员等级变更",
          `手机号已在档（ID ${existed.id}）· VIP${current} → VIP${level} · 来源：新增会员表单`
        );
      }
      revalidatePath("/members");
      return;
    }
  }

  run(
    `INSERT INTO guests (hotel_id, name, mobile, vip_level, blacklist, created_at)
     VALUES (?,?,?,?,0,?)`,
    [user.hotelId, name, mobile || null, level, nowIso()]
  );
  writeOpLog(user.hotelId, user.realName, "新增会员", `${name} · VIP${level}${mobile ? " · 手机号已在档校验" : " · 无手机号"}`);
  revalidatePath("/members");
}

/* ============================================================ 等级变更 */

/** 升级会员等级：VIP1 → VIP2 → VIP3，VIP3 不再升级 */
export async function upgradeMemberAction(formData: FormData) {
  // 权限：等级变更影响折扣与积分权益
  const user = await requirePermission("member.manage");
  const id = Number(formData.get("id"));
  if (!id) return;

  const row = get<{ id: number; name: string; vip_level: number }>(
    `SELECT id, name, vip_level FROM guests
      WHERE id = ? AND hotel_id = ? AND COALESCE(deleted, 0) = 0`,
    [id, user.hotelId]
  );
  if (!row) return;

  // 非会员（vip_level = 0）不是「升级」对象，避免把路人一键变成 VIP2
  if (Number(row.vip_level ?? 0) <= 0) return;

  const current = Math.max(1, Number(row.vip_level ?? 0));
  const next = Math.min(3, current + 1);
  if (next === current) return;

  run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [next, id, user.hotelId]);
  writeOpLog(
    user.hotelId,
    user.realName,
    "会员升级",
    `会员 ${row.name}（ID ${row.id}）VIP${current} → VIP${next} · 来源：手工升级（未校验门槛）`
  );
  revalidatePath("/members");
}

/**
 * 取消会员：等级归零，客史保留。
 *
 * 整改清单要求「会员取消必须二次确认」：页面用 ConfirmForm 弹窗并强制填写原因，
 * 服务端再校验一次原因非空（防绕过），并把原因写进 op_logs。
 * 权限用 guest.modify（取消=把会员资格摘掉，客史仍在；抬等级才是 member.manage）。
 */
export async function cancelMemberAction(formData: FormData) {
  const user = await requirePermission("guest.modify");
  const id = Number(formData.get("id"));
  if (!id) return;

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) backMembers("取消会员必须在确认框中填写原因（二次确认）", true);

  const row = get<{ id: number; name: string; vip_level: number }>(
    `SELECT id, name, vip_level FROM guests
      WHERE id = ? AND hotel_id = ? AND COALESCE(deleted, 0) = 0`,
    [id, user.hotelId]
  );
  if (!row) backMembers("未找到该会员，取消未执行", true);

  const current = Math.max(0, Number(row.vip_level ?? 0));
  if (current <= 0) backMembers(`${row.name} 当前不是会员，无需取消`, true);

  run(`UPDATE guests SET vip_level = 0 WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  writeOpLog(
    user.hotelId,
    user.realName,
    "取消会员",
    `会员 ${row.name}（ID ${row.id}）VIP${current} → 非会员 · 原因：${reason}`
  );

  revalidatePath("/members");
  backMembers(`${row.name} 已取消会员资格（客史保留）`);
}

/**
 * 保存会员升级规则：VIP1/VIP2/VIP3 的门槛（累计消费金额 / 入住次数）、折扣、积分比例。
 * 统一存 settings 表 key = member_upgrade_rules，值为 JSON：
 * { basis: "spend" | "stays", levels: [{ level, minSpend, minStays, discount, pointsRate }] }
 *
 * 权限：规则决定全店折扣与积分比例，属于系统配置 → settings.manage（当前仅 admin）。
 */
export async function saveUpgradeRulesAction(formData: FormData) {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;

  const basisRaw = String(formData.get("basis") ?? "spend").trim();
  const basis: "spend" | "stays" = basisRaw === "stays" ? "stays" : "spend";

  const levels: UpgradeLevelRule[] = [];

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
 * 待升级清单里的「升级」按钮：把单个会员升到**服务端按生效规则算出的**应得等级。
 *
 * 整改清单「自动升级必须按配置规则执行并记录原因」：
 * 原来前端把 target 一起提交（hidden input），服务端只做 1~3 夹紧就落库 ——
 * 构造一个 target=3 的请求就能把任何会员抬到 VIP3。现在 target 完全由服务端算。
 */
export async function applyUpgradeAction(formData: FormData) {
  const user = await requirePermission("member.manage");
  // 兼容旧页面字段名 guest_id，但优先级仍是 id
  const id = Number(formData.get("id") ?? formData.get("guest_id") ?? 0);
  if (!id) backUpgrade("缺少会员 ID，升级未执行", true);

  const rules = readUpgradeRules(user.hotelId);
  const row = get<{ id: number; name: string; vip_level: number; stay_count: number; total_spend: number }>(
    `SELECT g.id, g.name, g.vip_level, ${MEMBER_METRIC_SQL}
       FROM guests g
      WHERE g.id = ? AND g.hotel_id = ? AND COALESCE(g.deleted, 0) = 0`,
    [id, user.hotelId]
  );
  if (!row) backUpgrade("未找到该会员，升级未执行", true);

  const current = Math.max(0, Number(row.vip_level ?? 0));
  if (current <= 0) backUpgrade(`${row.name} 当前不是会员，请先在会员列表重新加入`, true);

  const target = targetLevelOf(row, rules);
  if (target <= current) {
    backUpgrade(`${row.name} 当前已是 VIP${current}，未达更高等级门槛，未产生升级`, true);
  }

  run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [target, id, user.hotelId]);
  writeOpLog(
    user.hotelId,
    user.realName,
    "会员升级",
    `会员 ${row.name}（ID ${row.id}）VIP${current} → VIP${target} · 依据：${ruleBasisText(rules, row, target)}`
  );

  revalidatePath("/members");
  backUpgrade(`${row.name} 已按规则升级为 VIP${target}`);
}

/**
 * 按当前生效规则批量自动升级。
 *
 * 整改清单「自动升级必须按配置规则执行并记录原因」：
 * 逐个会员用 settings 里的规则算应得等级，只升不降；每位会员与整批都写 op_logs，
 * 日志里带「口径 + 实际值 + 门槛值」，事后能解释每一次等级变化。
 * 权限：member.manage（改等级的人才能批量改等级；规则本身仍锁在 settings.manage）。
 */
export async function autoUpgradeMembersAction() {
  const user = await requirePermission("member.manage");
  const rules = readUpgradeRules(user.hotelId);

  const members = all<{
    id: number;
    name: string;
    vip_level: number;
    stay_count: number;
    total_spend: number;
  }>(
    `SELECT g.id, g.name, g.vip_level, ${MEMBER_METRIC_SQL}
       FROM guests g
      WHERE g.hotel_id = ? AND g.vip_level > 0 AND COALESCE(g.deleted, 0) = 0`,
    [user.hotelId]
  );

  const plan = members
    .map((m) => ({ member: m, target: targetLevelOf(m, rules) }))
    .filter((x) => x.target > Math.max(0, Number(x.member.vip_level ?? 0)));

  if (plan.length === 0) {
    backUpgrade(
      `当前没有达到升级门槛的会员（口径：${rules.basis === "stays" ? "入住次数" : "累计消费金额"}），未产生变更`
    );
  }

  const basisLabel = rules.basis === "stays" ? "入住次数" : "累计消费金额";
  tx(() => {
    for (const { member, target } of plan) {
      const current = Math.max(0, Number(member.vip_level ?? 0));
      run(`UPDATE guests SET vip_level = ? WHERE id = ? AND hotel_id = ?`, [target, member.id, user.hotelId]);
      writeOpLog(
        user.hotelId,
        user.realName,
        "会员自动升级",
        `会员 ${member.name}（ID ${member.id}）VIP${current} → VIP${target} · 依据：${ruleBasisText(rules, member, target)}`
      );
    }
    writeOpLog(
      user.hotelId,
      user.realName,
      "会员自动升级（批量）",
      `按当前规则（${basisLabel}）升级 ${plan.length} 位；未达门槛的会员保持原等级`
    );
  });

  revalidatePath("/members");
  backUpgrade(`自动升级完成：${plan.length} 位会员已按规则升级（明细见操作日志）`);
}

/* ============================================================ 导入 */

/**
 * 会员 CSV 导入：表头 姓名,手机号,会员等级,会员卡号,备注（可选 身份证号）
 *
 * 整改清单（第六轮 一.7）要求校验四件事，这里逐条落地：
 *   1. 文件大小：≤ 4MB（与 Next Server Action 的 4MB 请求体上限一致）（否则一个 200MB 的 CSV / 误选的数据库文件能把 Node 进程 OOM 掉，
 *      OOM 不可捕获，正在办理的入住会一起挂）；
 *   2. 行数：≤ 5000（单事务锁 SQLite 太久，会堵住前台）；
 *   3. 列格式：必须先解析表头并按列名取数 —— 表头没有「姓名」列直接整单拒绝，
 *      不再像原来那样按位置硬取，把「姓名」写成「手机号」也不会静默错位入库；
 *   4. 重复身份证 / 手机号：文件内重复 → **整单拒绝**（不做半截导入）；
 *      与库里已有档案重复 → 该行跳过且**不改动**已有档案。
 *
 * 另外「不得通过姓名误改同名客史」：本函数**不做任何姓名匹配**，
 * 既不会因为同名而跳过，也不会因为同名而更新别人的手机号/等级。
 */
/**
 * 导入上限：4MB / 5000 行。
 *
 * 为什么是 4MB 而不是 5MB：next.config.ts 里 `serverActions.bodySizeLimit = "4mb"`，
 * HTTP 表单提交超过 4MB 会被 Next 在进入 action 之前就挡掉（拿不到我们的提示文案）。
 * action 内的这道闸是**纵深防御**：直接调用（脚本 / 未来调大 bodySizeLimit）时同样受控，
 * 也仍然避免「5MB 以上整个读进内存」——超大 CSV / 误选的数据库文件足以让 Node 进程 OOM，
 * 而 OOM 不可捕获，会连同正在办理的入住一起挂掉。
 */
const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const IMPORT_MAX_ROWS = 5000;

/** 表头别名 → 标准列（顺序无关，按名字取列，避免模板列序变了就静默错位） */
const IMPORT_HEADER_ALIASES: Record<string, string[]> = {
  name: ["姓名", "会员姓名", "名字"],
  mobile: ["手机号", "手机", "联系电话", "电话"],
  level: ["会员等级", "等级", "vip等级", "VIP等级"],
  cardNo: ["会员卡号", "卡号"],
  remark: ["备注", "说明"],
  idNo: ["身份证号", "身份证", "证件号"],
};

function headerIndexOf(header: string[]): Record<string, number> {
  const out: Record<string, number> = { name: -1, mobile: -1, level: -1, cardNo: -1, remark: -1, idNo: -1 };
  const normalized = header.map((h) => h.replace(/\s/g, "").trim().toLowerCase());
  for (const [key, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.some((a) => a.toLowerCase() === h));
    out[key] = idx;
  }
  return out;
}

export async function importMembersAction(formData: FormData) {
  // 权限：批量建档同样是改客人档案；提示文案里的手机号按 member.view_sensitive 决定是否脱敏
  const user = await requirePermission("guest.modify");
  const canSeeSensitive = hasPermission(user.role, "member.view_sensitive", user.hotelId);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    backMembers("请选择 CSV 文件", true);
  }
  if (file.size > IMPORT_MAX_BYTES) {
    backMembers(
      `文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 4MB 上限，请拆分后再导入`,
      true
    );
  }
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) backMembers("文件为空或没有数据行", true);
  if (lines.length - 1 > IMPORT_MAX_ROWS) {
    backMembers(`数据 ${lines.length - 1} 行超过单次 5000 行上限，请拆分后再导入`, true);
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

  /* 4.1 列格式：必须能按表头取到「姓名」列 */
  const header = parse(lines[0]);
  const idx = headerIndexOf(header);
  if (idx.name < 0) {
    backMembers(
      "CSV 表头缺少「姓名」列，请使用模版（姓名,手机号,会员等级,会员卡号,备注；可选 身份证号）",
      true
    );
  }

  /* 4.2 逐行校验 + 文件内判重（不碰库，先把文件看干净） */
  type ImportRow = { line: number; name: string; mobile: string; idNo: string; levelRaw: string; cardNo: string; remark: string };
  const rows: ImportRow[] = [];
  const mobileSeen = new Set<string>();
  const idSeen = new Set<string>();
  const dupMobiles = new Set<string>();
  const dupIdNos = new Set<string>();
  let noName = 0;
  let badMobile = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parse(lines[i]);
    const cell = (k: string) => (idx[k] >= 0 ? String(cols[idx[k]] ?? "").trim() : "");
    const name = cell("name");
    if (!name) { noName++; continue; }

    const mobile = cell("mobile").replace(/[\s-]/g, "");
    if (mobile && !/^\d{5,20}$/.test(mobile)) { badMobile++; continue; }

    const idNo = cell("idNo").replace(/\s/g, "");
    if (mobile) {
      if (mobileSeen.has(mobile)) dupMobiles.add(mobile);
      else mobileSeen.add(mobile);
    }
    if (idNo) {
      if (idSeen.has(idNo)) dupIdNos.add(idNo);
      else idSeen.add(idNo);
    }

    rows.push({
      line: i + 1,
      name,
      mobile,
      idNo,
      levelRaw: cell("level"),
      cardNo: cell("cardNo"),
      remark: cell("remark"),
    });
  }

  /* 4.3 文件内有重复身份证 / 手机号 → 整单拒绝（半截导入比不导入更难收拾） */
  if (dupMobiles.size > 0 || dupIdNos.size > 0) {
    const mobileExamples = [...dupMobiles].slice(0, 3).map((m) => maskMobile(m, canSeeSensitive));
    backMembers(
      `导入已取消：文件内有 ${dupMobiles.size} 个重复手机号、${dupIdNos.size} 个重复身份证号` +
        (mobileExamples.length ? `（如 ${mobileExamples.join("、")}）` : "") +
        "，请先去重后重新导入",
      true
    );
  }

  let inserted = 0;
  let skippedDup = 0;
  const now = nowIso();
  tx(() => {
    for (const r of rows) {
      /* 与库里已有档案重复：按手机号 / 证件号判重（唯一身份），命中就跳过，绝不改已有档案 */
      if (r.mobile) {
        const ex = get<{ id: number }>(
          `SELECT id FROM guests WHERE hotel_id = ? AND mobile = ? LIMIT 1`,
          [user.hotelId, r.mobile]
        );
        if (ex) { skippedDup++; continue; }
      }
      if (r.idNo) {
        const ex = get<{ id: number }>(
          `SELECT id FROM guests WHERE hotel_id = ? AND id_no = ? LIMIT 1`,
          [user.hotelId, r.idNo]
        );
        if (ex) { skippedDup++; continue; }
      }

      const vipMatch = /VIP\s*(\d)/i.exec(r.levelRaw)?.[1] ?? (/^[1-3]$/.test(r.levelRaw) ? r.levelRaw : null);
      const vip = vipMatch ? Math.min(3, Math.max(1, Number(vipMatch))) : 0;
      const note = [r.cardNo ? `卡号 ${r.cardNo}` : "", r.remark].filter(Boolean).join(" · ") || null;
      run(
        `INSERT INTO guests (hotel_id, name, mobile, id_no, vip_level, note, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [user.hotelId, r.name, r.mobile || null, r.idNo || null, vip, note, now]
      );
      inserted++;
    }

    writeOpLog(
      user.hotelId,
      user.realName,
      "会员导入",
      `文件 ${(file.size / 1024).toFixed(1)}KB · 新增 ${inserted} 条 · 跳过 ${skippedDup} 条（手机号/身份证已建档）` +
        ` · 跳过 ${badMobile} 条（手机号格式非法）· 跳过 ${noName} 条（无姓名）`
    );
  });

  revalidatePath("/members");
  const skipped = skippedDup + badMobile + noName;
  backMembers(
    `导入完成：新增 ${inserted} 条，跳过 ${skipped} 条` +
      `（已在档 ${skippedDup} / 手机号格式 ${badMobile} / 无姓名 ${noName}）`
  );
}
