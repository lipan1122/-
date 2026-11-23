"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { requireAdmin, requirePermission, requirePermissionOrRedirect } from "@/lib/session";
import { addDays, nowIso, round2, todayStr } from "@/lib/utils";

/**
 * 会员积分模块（积分代码 / 积分商品 / 积分明细 / 兑换记录）
 *
 * 三张表不在 scripts/init-db.mjs 内，首次访问本模块时懒创建并写入示例种子；
 * 积分余额一律按 score_records.points 累计计算（EARN 正、SPEND 负、ADJUST 正负均可）。
 */

const PAGE = "/points";

type GuestRow = {
  id: number;
  name: string;
  mobile: string | null;
  vip_level: number;
};

type CodeRow = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type GoodsRow = {
  id: number;
  name: string;
  points: number;
  stock: number;
  status: string;
};

/** 积分规则种子：住店消费 1:1、餐饮消费 2:1 */
const CODE_SEED: { code: string; name: string; ratio: number }[] = [
  { code: "STAY-1X", name: "住店消费 1:1", ratio: 1 },
  { code: "FNB-2X", name: "餐饮消费 2:1", ratio: 2 },
];

/** 积分商品种子：免费早餐 / 延迟退房 / 升级房型 / 洗衣券 / 饮料券 */
const GOODS_SEED: { name: string; points: number; stock: number; note: string }[] = [
  { name: "免费早餐", points: 500, stock: 50, note: "含单人自助早餐 1 份，需提前一天预约" },
  { name: "延迟退房", points: 300, stock: 30, note: "退房时间延至 18:00，视当班房态确认" },
  { name: "升级房型", points: 800, stock: 10, note: "标准房升级豪华房 1 晚，视当班房态确认" },
  { name: "洗衣券", points: 200, stock: 40, note: "衬衣 / 外套洗涤 1 件，次日 12:00 前取" },
  { name: "饮料券", points: 100, stock: 100, note: "大堂吧饮品 1 杯，领取后 7 天内有效" },
];

/**
 * 积分明细种子：按发生时间从早到晚写入，余额快照逐笔累计。
 * 每位会员的兑换（SPEND）都排在该会员的获得之后，避免种子数据出现负余额。
 */
const RECORD_SEED: {
  guestIdx: number;
  type: string;
  points: number;
  note: string;
  operator: string;
  daysAgo: number;
}[] = [
  { guestIdx: 0, type: "EARN", points: 1200, note: "住店消费 ¥1200（住店 1:1）", operator: "系统", daysAgo: 30 },
  { guestIdx: 1, type: "EARN", points: 680, note: "餐饮消费 ¥340（餐饮 2:1）", operator: "系统", daysAgo: 26 },
  { guestIdx: 2, type: "EARN", points: 360, note: "住店消费 ¥360（住店 1:1）", operator: "系统", daysAgo: 22 },
  { guestIdx: 0, type: "SPEND", points: -500, note: "兑换：免费早餐", operator: "前台-王琳", daysAgo: 18 },
  { guestIdx: 3, type: "ADJUST", points: 200, note: "会员日补赠积分", operator: "店长-李强", daysAgo: 15 },
  { guestIdx: 1, type: "EARN", points: 900, note: "住店消费 ¥900（住店 1:1）", operator: "系统", daysAgo: 12 },
  { guestIdx: 2, type: "SPEND", points: -300, note: "兑换：延迟退房", operator: "前台-王琳", daysAgo: 9 },
  { guestIdx: 4, type: "EARN", points: 240, note: "餐饮消费 ¥120（餐饮 2:1）", operator: "系统", daysAgo: 6 },
  { guestIdx: 3, type: "EARN", points: 1500, note: "长住消费 ¥1500 积分入账", operator: "系统", daysAgo: 3 },
  { guestIdx: 4, type: "ADJUST", points: -50, note: "跨年积分清理（过期扣减）", operator: "系统", daysAgo: 1 },
];

let schemaReady = false;
const seededHotels = new Set<number>();

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/* round2 用 @/lib/utils 的权威实现（整改清单 P2-1：全项目只允许一份） */

/** 取整数：空值 / 非法值回落 fallback */
function toInt(value: FormDataEntryValue | null, fallback = 0): number {
  const n = Number(str(value).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function isDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text);
}

/** 页面回跳地址：带 tab、可选会员与提示文案 */
function pointsUrl(opts: { tab: string; guest?: number; key?: "err" | "msg"; message?: string }): string {
  const qs = new URLSearchParams();
  qs.set("tab", opts.tab);
  if (opts.guest) qs.set("guest", String(opts.guest));
  if (opts.key && opts.message) qs.set(opts.key, opts.message);
  return `${PAGE}?${qs.toString()}`;
}

function back(tab: string, key: "err" | "msg", message: string, guest?: number): never {
  redirect(pointsUrl({ tab, guest, key, message }));
}

/* -------------------------------------------------------------------------- */
/* 懒创建：积分三表 + 首次访问种子（不改动 scripts/init-db.mjs）                */
/* -------------------------------------------------------------------------- */

export async function ensurePointsSchema(hotelId: number): Promise<void> {
  /*
   * 权限边界（整改 A 类缺口）：建表 + 种子写入是写动作，不能只校验登录。
   * 为什么是 member.view_sensitive：积分三表（score_codes / score_goods / score_records）
   * 直接承载会员权益数据，该点的角色集 admin / cashier / frontdesk 与 /points 页面的
   * 可见角色完全一致；本文件调用它的写动作（settings.manage × 4、requireAdmin × 1、
   * redeemPointsAction）的持有者都被这个点覆盖，补守卫不会锁死已有路径。
   */
  const user = await requirePermissionOrRedirect("member.view_sensitive");
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化积分数据");
  if (!schemaReady) {
    run(`CREATE TABLE IF NOT EXISTS score_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      ratio REAL NOT NULL DEFAULT 1,
      valid_from TEXT,
      valid_to TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      UNIQUE (hotel_id, code)
    )`);

    run(`CREATE TABLE IF NOT EXISTS score_goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      note TEXT,
      created_at TEXT NOT NULL
    )`);

    run(`CREATE TABLE IF NOT EXISTS score_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      guest_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      type TEXT NOT NULL,
      points INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      note TEXT,
      operator TEXT,
      created_at TEXT NOT NULL
    )`);

    run(`CREATE INDEX IF NOT EXISTS idx_score_records_guest ON score_records (hotel_id, guest_id)`);
    run(`CREATE INDEX IF NOT EXISTS idx_score_records_type ON score_records (hotel_id, type)`);

    schemaReady = true;
  }

  if (seededHotels.has(hotelId)) return;
  seededHotels.add(hotelId);
  seedPointsDefaults(hotelId);
}

/** 首次访问：2 个积分规则 + 5 个积分商品 + 10 条积分记录 */
function seedPointsDefaults(hotelId: number): void {
  const now = new Date();
  const createdAt = now.toISOString();
  const today = todayStr(now);
  const validTo = todayStr(addDays(now, 365));

  const codeCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_codes WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (codeCount === 0) {
    for (const item of CODE_SEED) {
      run(
        `INSERT INTO score_codes (hotel_id, code, name, ratio, valid_from, valid_to, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [hotelId, item.code, item.name, item.ratio, today, validTo, "ACTIVE", createdAt]
      );
    }
  }

  const goodsCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_goods WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (goodsCount === 0) {
    for (const item of GOODS_SEED) {
      run(
        `INSERT INTO score_goods (hotel_id, name, points, stock, status, note, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [hotelId, item.name, item.points, item.stock, "ACTIVE", item.note, createdAt]
      );
    }
  }

  const recordCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_records WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (recordCount > 0) return;

  // 种子记录挂到真实会员上；会员不足 5 位时按取模复用
  /*
   * ⚠️ 上线前加的保护
   *
   * 上面两段（积分规则 CODE_SEED / 兑换商品 GOODS_SEED）是**系统默认配置**，
   * 真实酒店也要用，保留自动创建。
   *
   * 但从这里往下会给**真实会员**灌假的积分流水（RECORD_SEED），
   * 上线后会表现成「会员积分余额凭空多了/少了」，对账根本查不出来。
   * 所以只在 PMS_DEMO_SEED=1 时灌。
   */
  if (process.env.PMS_DEMO_SEED !== "1") return;

  const members = all<GuestRow>(
    `SELECT id, name, mobile, vip_level
       FROM guests
      WHERE hotel_id = ? AND vip_level > 0
      ORDER BY vip_level DESC, id
      LIMIT 5`,
    [hotelId]
  );
  if (members.length === 0) return;

  for (const seed of RECORD_SEED) {
    const guest = members[seed.guestIdx % members.length];
    if (!guest) continue;
    // 余额不足的兑换跳过，保证种子数据不会写出负余额
    if (seed.type === "SPEND" && balanceOf(hotelId, guest.id) + seed.points < 0) continue;
    const when = new Date(now.getTime() - seed.daysAgo * 86400000).toISOString();
    recordPoints({
      hotelId,
      guest,
      type: seed.type,
      points: seed.points,
      note: seed.note,
      operator: seed.operator,
      createdAt: when,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 积分余额 / 明细写入                                                         */
/* -------------------------------------------------------------------------- */

/** 会员当前积分：score_records.points 累计（EARN 正、SPEND 负、ADJUST 正负） */
function balanceOf(hotelId: number, guestId: number): number {
  const row = get<{ balance: number }>(
    `SELECT COALESCE(SUM(points), 0) AS balance
       FROM score_records
      WHERE hotel_id = ? AND guest_id = ?`,
    [hotelId, guestId]
  );
  return Math.trunc(Number(row?.balance ?? 0));
}

function loadGuest(hotelId: number, guestId: number): GuestRow | undefined {
  return get<GuestRow>(`SELECT id, name, mobile, vip_level FROM guests WHERE id = ? AND hotel_id = ?`, [guestId, hotelId]);
}

/** 事务内写一条积分明细并回填余额快照，返回写入后的余额 */
function recordPoints(opts: {
  hotelId: number;
  guest: GuestRow;
  type: string;
  points: number;
  note: string;
  operator: string;
  createdAt?: string;
}): number {
  const { hotelId, guest, type, points, note, operator, createdAt } = opts;
  return tx(() => {
    const balanceAfter = balanceOf(hotelId, guest.id) + points;
    run(
      `INSERT INTO score_records (hotel_id, guest_id, guest_name, type, points, balance_after, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [hotelId, guest.id, guest.name, type, points, balanceAfter, note || null, operator, createdAt ?? nowIso()]
    );
    return balanceAfter;
  });
}

/* -------------------------------------------------------------------------- */
/* Tab 1 积分规则                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 新增积分规则：代码唯一，比例（每消费 1 元积多少分）必须大于 0
 *
 * 权限边界（整改清单 P2-28）：积分规则 / 积分商品属于系统配置（决定全店积分发放比例
 * 与兑换成本），不在前台的职责范围内，原来只校验登录 → 任何能进 /points 的账号
 * （前台、收银）都能改。改用 settings.manage，与设置页的配置类 action 一致。
 */
export async function createScoreCodeAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensurePointsSchema(hotelId);

  const code = str(formData.get("code")).toUpperCase();
  const name = str(formData.get("name"));
  const ratio = round2(Number(str(formData.get("ratio"))));
  const fromText = str(formData.get("valid_from"));
  const toText = str(formData.get("valid_to"));

  if (!code) back("rules", "err", "请填写积分规则代码，如 STAY-1X");
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) back("rules", "err", "规则代码只允许字母、数字、下划线、连字符（2-20 位）");
  if (!name) back("rules", "err", "请填写积分规则名称");
  if (!Number.isFinite(ratio) || ratio <= 0) back("rules", "err", "积分配比必须大于 0（如 1 表示消费 1 元积 1 分）");
  if (ratio > 100) back("rules", "err", "积分配比不能超过 100");

  const validFrom = isDate(fromText) ? fromText : todayStr();
  const validTo = isDate(toText) ? toText : todayStr(addDays(new Date(), 365));
  if (validTo < validFrom) back("rules", "err", "有效期结束日期不能早于开始日期");

  const existed = get<{ id: number }>(
    `SELECT id FROM score_codes WHERE hotel_id = ? AND code = ? LIMIT 1`,
    [hotelId, code]
  );
  if (existed) back("rules", "err", `积分规则代码「${code}」已存在，请换一个`);

  run(
    `INSERT INTO score_codes (hotel_id, code, name, ratio, valid_from, valid_to, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [hotelId, code, name, ratio, validFrom, validTo, "ACTIVE", nowIso()]
  );

  revalidatePath(PAGE);
  back("rules", "msg", `已新增积分规则「${name}」（${code}），比例 1 元 = ${ratio} 分`);
}

/** 启用 / 停用积分规则（权限边界见 createScoreCodeAction：settings.manage） */
export async function toggleScoreCodeAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensurePointsSchema(hotelId);

  const id = toInt(formData.get("id"));
  if (!id) back("rules", "err", "积分规则不存在");

  const row = get<CodeRow>(`SELECT id, code, name, status FROM score_codes WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  if (!row) back("rules", "err", "积分规则不存在或已被删除");

  const next = row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
  run(`UPDATE score_codes SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath(PAGE);
  back(
    "rules",
    "msg",
    next === "ACTIVE" ? `已启用积分规则「${row.name}」` : `已停用积分规则「${row.name}」，停用后不再累计积分`
  );
}

/* -------------------------------------------------------------------------- */
/* Tab 2 积分商品                                                              */
/* -------------------------------------------------------------------------- */

/** 新增积分商品：名称、所需积分、库存（权限边界见 createScoreCodeAction：settings.manage） */
export async function createScoreGoodsAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensurePointsSchema(hotelId);

  const name = str(formData.get("name"));
  const points = toInt(formData.get("points"));
  const stock = toInt(formData.get("stock"));
  const note = str(formData.get("note"));

  if (!name) back("goods", "err", "请填写积分商品名称");
  if (!(points > 0)) back("goods", "err", "所需积分必须大于 0");
  if (points > 999999) back("goods", "err", "所需积分不能超过 999999");
  if (stock < 0) back("goods", "err", "库存不能为负数");
  if (stock > 99999) back("goods", "err", "库存不能超过 99999");

  const existed = get<{ id: number }>(
    `SELECT id FROM score_goods WHERE hotel_id = ? AND name = ? LIMIT 1`,
    [hotelId, name]
  );
  if (existed) back("goods", "err", `积分商品「${name}」已存在，请直接修改库存或换个名称`);

  run(
    `INSERT INTO score_goods (hotel_id, name, points, stock, status, note, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [hotelId, name, points, stock, "ACTIVE", note || null, nowIso()]
  );

  revalidatePath(PAGE);
  back("goods", "msg", `已上架积分商品「${name}」，${points} 分 / 件，库存 ${stock}`);
}

/** 上架 / 下架积分商品（权限边界见 createScoreCodeAction：settings.manage） */
export async function toggleScoreGoodsAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensurePointsSchema(hotelId);

  const id = toInt(formData.get("id"));
  if (!id) back("goods", "err", "积分商品不存在");

  const row = get<GoodsRow>(
    `SELECT id, name, points, stock, status FROM score_goods WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) back("goods", "err", "积分商品不存在或已被删除");

  const next = row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
  run(`UPDATE score_goods SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath(PAGE);
  back("goods", "msg", next === "ACTIVE" ? `已上架「${row.name}」` : `已下架「${row.name}」，下架后不可兑换`);
}

/* -------------------------------------------------------------------------- */
/* Tab 3 积分明细：手工调积分                                                   */
/* -------------------------------------------------------------------------- */

/** 手工调整积分：方向 + 数值 + 备注，扣减时不允许把余额调成负数 */
export async function adjustPointsAction(formData: FormData): Promise<void> {
  // 权限边界（上线前加固）：手工调积分等于直接发钱，仅 admin 可操作，原来只校验登录
  const user = await requireAdmin();
  const hotelId = user.hotelId;
  await ensurePointsSchema(hotelId);

  const guestId = toInt(formData.get("guest_id"));
  const direction = str(formData.get("direction")) === "-" ? "-" : "+";
  const amount = Math.abs(toInt(formData.get("amount")));
  const note = str(formData.get("note"));

  if (!guestId) back("records", "err", "请先选择要调整积分的会员");
  const guest = loadGuest(hotelId, guestId);
  if (!guest) back("records", "err", "宾客不存在或已删除");
  if (!(amount > 0)) back("records", "err", "请填写大于 0 的调整分值", guestId);
  if (amount > 999999) back("records", "err", "单次调整不能超过 999999 分", guestId);

  const before = balanceOf(hotelId, guestId);
  const delta = direction === "-" ? -amount : amount;
  if (before + delta < 0) {
    back("records", "err", `扣减后余额为负：当前 ${before} 分，本次扣减 ${amount} 分`, guestId);
  }

  const balanceAfter = recordPoints({
    hotelId,
    guest,
    type: "ADJUST",
    points: delta,
    note: note || `手工${direction === "-" ? "扣减" : "增加"}积分`,
    operator: user.realName,
  });

  revalidatePath(PAGE);
  back(
    "records",
    "msg",
    `已为 ${guest.name} ${direction === "-" ? "扣减" : "增加"} ${amount} 分，当前余额 ${balanceAfter} 分`,
    guestId
  );
}

/* -------------------------------------------------------------------------- */
/* Tab 4 兑换记录：积分兑换                                                    */
/* -------------------------------------------------------------------------- */

/** 积分兑换：校验积分与库存 → 扣积分、减库存、写 SPEND 明细 */
export async function redeemPointsAction(formData: FormData): Promise<void> {
  /*
   * 权限（整改 A 类缺口）：原来只有 requireUser()。
   * 兑换会**扣减会员积分**并减库存 —— 直接改变会员权益，属会员权益类写操作，
   * 用 member.manage（admin / frontdesk）。同文件的 adjustPointsAction 已经是
   * requireAdmin（积分调整只能管理员），这里保持「改积分 = 会员权益」的同一把锁。
   *
   * 影响（如实说明）：/points 页面对 cashier 也可见，但改造后收银不能执行兑换
   * （cashier 没有 member.manage）。这与它本来就不能调整积分是一致的；
   * 若业务要求收银也能兑换，应新增 points.redeem 并授权三岗，而不是退回 requireUser()。
   */
  const user = await requirePermissionOrRedirect("member.manage");
  const hotelId = user.hotelId;
  await ensurePointsSchema(hotelId);

  const guestId = toInt(formData.get("guest_id"));
  const goodsId = toInt(formData.get("goods_id"));

  if (!guestId) back("redeem", "err", "请选择要兑换的会员");
  if (!goodsId) back("redeem", "err", "请选择要兑换的积分商品", guestId);

  const guest = loadGuest(hotelId, guestId);
  if (!guest) back("redeem", "err", "宾客不存在或已删除");
  if (Number(guest.vip_level ?? 0) <= 0) back("redeem", "err", `${guest.name} 不是会员，无法使用积分兑换`);

  const goods = get<GoodsRow>(
    `SELECT id, name, points, stock, status FROM score_goods WHERE id = ? AND hotel_id = ?`,
    [goodsId, hotelId]
  );
  if (!goods) back("redeem", "err", "积分商品不存在或已被删除", guestId);
  if (goods.status !== "ACTIVE") back("redeem", "err", `积分商品「${goods.name}」已下架，暂不可兑换`, guestId);

  const cost = Math.trunc(Number(goods.points ?? 0));
  const stock = Math.trunc(Number(goods.stock ?? 0));
  if (cost <= 0) back("redeem", "err", `积分商品「${goods.name}」所需积分配置异常`, guestId);
  if (stock <= 0) back("redeem", "err", `积分商品「${goods.name}」库存不足，暂不可兑换`, guestId);

  const before = balanceOf(hotelId, guestId);
  if (before < cost) {
    back("redeem", "err", `积分不足：${guest.name} 当前 ${before} 分，兑换「${goods.name}」需要 ${cost} 分`, guestId);
  }

  // 扣积分与减库存在同一事务内完成，避免超兑
  const balanceAfter = tx(() => {
    const current = balanceOf(hotelId, guestId);
    if (current < cost) throw new Error("POINTS_NOT_ENOUGH");
    const after = current - cost;
    run(
      `INSERT INTO score_records (hotel_id, guest_id, guest_name, type, points, balance_after, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [hotelId, guest.id, guest.name, "SPEND", -cost, after, `兑换：${goods.name}`, user.realName, nowIso()]
    );
    run(`UPDATE score_goods SET stock = stock - 1 WHERE id = ? AND hotel_id = ?`, [goods.id, hotelId]);
    return after;
  });

  revalidatePath(PAGE);
  back(
    "redeem",
    "msg",
    `已为 ${guest.name} 兑换「${goods.name}」，扣减 ${cost} 分（剩余 ${balanceAfter} 分），库存已减少 1 件`,
    guestId
  );
}
