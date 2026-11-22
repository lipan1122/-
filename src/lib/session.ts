import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { all, get, run } from "./db";
import { nowIso } from "./utils";

export type SessionUser = {
  id: number;
  username: string;
  realName: string;
  role: string;
  hotelId: number;
  hotelName: string;
};

export const SESSION_COOKIE = "pms_sid";
/** 旧版把用户信息塞进这个 Cookie（Base64，可伪造），只用于一次性清理，不再读取 */
export const LEGACY_USER_COOKIE = "pms_user";

/**
 * 读取当前登录用户
 *
 * 安全约束（整改报告 P0-2.1）：
 *   - 只信任服务端 sessions 表里的记录，客户端 Cookie 仅承载随机 session id
 *   - 不再解码/信任 `pms_user`（Base64 可伪造 → 身份接管）
 *   - session 过期、用户被停用、酒店不匹配 → 一律视为未登录
 */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  if (!sid) return null;

  const row = get<{ user_json: string; expires_at: string }>(
    `SELECT user_json, expires_at FROM sessions WHERE id = ?`,
    [sid]
  );
  if (!row) return null;
  if (row.expires_at && row.expires_at < nowIso()) {
    // 过期即删，避免堆积
    run(`DELETE FROM sessions WHERE id = ?`, [sid]);
    return null;
  }

  let u: SessionUser;
  try {
    u = JSON.parse(row.user_json) as SessionUser;
  } catch {
    return null;
  }
  if (!u?.id || !u?.hotelId) return null;

  /* 会话必须绑定「当前仍然启用」的用户，否则停用后旧 Cookie 还能用 */
  const dbUser = get<{ id: number; status: number; role: string; hotel_id: number }>(
    `SELECT id, status, role, hotel_id FROM users WHERE id = ?`,
    [u.id]
  );
  if (!dbUser || Number(dbUser.status) !== 1) {
    run(`DELETE FROM sessions WHERE id = ?`, [sid]);
    return null;
  }
  // 角色/酒店以数据库为准，防止旧 session 里带着过期角色
  return {
    ...u,
    role: dbUser.role,
    hotelId: Number(dbUser.hotel_id),
  };
}

/**
 * 清理过期会话，返回删除条数。建议每天跑一次（登录时顺带跑，或夜审时跑）
 *
 * 整改 P2-4：getSession 只在「有人带着过期 sid 访问」时顺手删那一条，
 * 大量已过期、但再也没人用的会话会一直留在 sessions 表里（只增不删），
 * 而每次登录都会让表变大。这里按 expires_at 批量删，配合迁移里的
 * idx_sessions_expires 索引，全表扫描变成一次范围扫描。
 *
 * 为什么不单独起定时器：Next.js 的多实例部署里每个进程各起一个定时器会互相打架，
 * 进程重启还会丢任务；登录本身就是天然的「每天至少发生几次」的触发点，
 * 把清理挂在登录成功后执行，频率够用、实现最简、没有额外运维成本。
 * 代价是「长期没人登录」时过期会话会多留一会儿 —— 那些记录本来也没人用，
 * 不影响正确性，只是占点磁盘。
 */
export function cleanupExpiredSessions(): number {
  const res = run(`DELETE FROM sessions WHERE expires_at < ?`, [nowIso()]);
  return res.changes;
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getSession();
  if (!u) redirect("/login");
  return u;
}

/* ============================================================ 角色权限
 *
 * 整改 5.2：权限配置必须来自数据库，设置页改完要立即影响接口判断。
 *
 *   权限数据表（scripts/migrate-all.mjs 第 16 段创建并首次灌数据）：
 *     role_modules      角色 → 可访问的页面模块（替代 ROLE_MODULES 常量，路由守卫用）
 *     role_permissions  角色 → 权限点（替代 PERMISSIONS 常量，接口/动作级判断用）
 *     permission_dict   权限点字典（中文名 / 归属模块 / 说明，设置页勾选矩阵展示用）
 *
 * 本文件只剩下三件事：
 *   1. 读库（带 5 秒进程内缓存，设置页保存后调 invalidatePermissionCache 立即失效）；
 *   2. 判断（hasPermission / canAccess / permissionsOf / modulesOf）；
 *   3. 兜底（库还没迁移、或某角色一行配置都没有时，降级用下面两张常量表，
 *      避免「迁移没跑 → 全站 401」这种上线事故）。
 *
 * 为什么保留常量：它们是「迁移前的历史配置」，也是唯一能保证新库/新酒店至少能用一份
 * 合理默认值的东西。它们不再是权威来源 —— 库里一旦有该角色的配置，就完全以库为准。
 */

/**
 * 角色 → 可访问的模块前缀（降级兜底，权威来源是 role_modules 表）
 *
 * ⚠️ 必须与 scripts/migrate-all.mjs 的 RBAC_ROLE_MODULES 保持一致：
 *    迁移只负责把它原样搬进库一次，之后改库里的才是生效的。
 */
export const ROLE_MODULES: Record<string, string[] | "*"> = {
  admin: "*",
  frontdesk: [
    "/rooms",
    "/bookings",
    "/frontdesk",
    "/guests",
    "/guest-detail",
    "/inhouse",
    "/cashier",
    "/orders",
    "/channel-orders",
    "/housekeeping",
    "/cleaners",
    "/meal-vouchers",
    "/breakfast",
    "/today-todo",
    "/notices",
    "/lost-found",
    "/id-verify",
    "/members",
    "/member-cards",
    "/points",
    "/dashboard",
    "/handover",
    "/mobile-housekeeping",
  ],
  cashier: [
    "/cashier",
    "/finance",
    "/ar",
    // 发票台账（整改 P2-3）：收银员开票后要能查台账 / 红冲
    "/invoices",
    "/reports",
    "/members",
    "/member-cards",
    "/points",
    "/orders",
    "/shop",
    "/meal-vouchers",
    "/guest-detail",
    "/today-todo",
    "/notices",
    "/dashboard",
    "/handover",
  ],
  housekeeping: [
    "/rooms",
    "/housekeeping",
    "/mobile-housekeeping",
    "/cleaners",
    "/lost-found",
    "/today-todo",
    "/notices",
    "/dashboard",
  ],
};

/** 严格角色校验：不在允许范围时抛错（server action 用） */
export async function requireRole(...roles: string[]): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role === "admin") return u;
  if (roles.length && roles.includes(u.role)) return u;
  throw new Error("FORBIDDEN: 当前角色无权执行该操作");
}

/** 是否管理员（管理类页面/操作） */
export async function requireAdmin(): Promise<SessionUser> {
  return requireRole("admin");
}

/* ============================================================ 细粒度权限 */

/**
 * 动作级权限（整改报告 P0-3 / 整改 5.2）
 * 用法：await requirePermission("cashier.refund")
 *
 * 这是「降级兜底」版本，权威来源是 role_permissions 表。
 * ⚠️ 必须与 scripts/migrate-all.mjs 的 RBAC_PERMISSIONS 保持一致。
 *
 * 注意：scripts/test-action-permissions.mjs 会解析这段源码来校验各 action 的权限点是否登记，
 * 所以键必须保持 "xxx.yyy": ["role", ...] 的字面量形式，不要改成变量拼接。
 */
const PERMISSIONS: Record<string, string[]> = {
  // 房态
  "room.view": ["admin", "frontdesk", "cashier", "housekeeping"],
  "room.change_status": ["admin", "frontdesk", "housekeeping"],
  // 预订
  "booking.view": ["admin", "frontdesk"],
  "booking.create": ["admin", "frontdesk"],
  "booking.assign_room": ["admin", "frontdesk"],
  "booking.cancel": ["admin", "frontdesk"],
  /*
   * 订单修改 / 删除（整改报告 P0-3 新增）：
   * 改价、改备注、确认、免费升级、入团、物理删除都只校验登录就能调用，
   * 这里的两个权限点给这类「改动订单金额或状态」的写操作一个可表达的角色边界；
   * 角色集与建单一致（admin / frontdesk），收银与客房不能再越权改单。
   */
  "booking.modify": ["admin", "frontdesk"],
  "booking.delete": ["admin", "frontdesk"],
  // 入住
  "checkin.create": ["admin", "frontdesk"],
  "checkin.cancel": ["admin", "frontdesk"],
  // 收银
  /*
   * 账单过账（整改报告 P0-3 新增）：空隔夜补过房费只往账单里记应收，不涉及收款 / 退款，
   * 与 cashier.receive 语义不同，故单列一个账务类权限点。
   * 入口只在 /inhouse（前台在住客人），收银有自己已经鉴权的入账动作，无需复用本权限点，
   * 因此只授权 admin / frontdesk —— 收银、客房账号即使直接构造请求也会被服务端拒绝。
   */
  /*
   * 在住补过房费（/inhouse 的空隔夜补过）
   *
   * 注意与收银台入账区分：
   *   · 收银台入账（addChargeAction）用 cashier.receive，收银员要做；
   *   · 在住补房费（postRoomChargeAction）在这里，收银员进不了 /inhouse，不该给。
   * 两个入口共用同一个权限点会互相牵制，所以分开。
   */
  "folio.post_charge": ["admin", "frontdesk"],
  "cashier.view": ["admin", "frontdesk", "cashier"],
  "cashier.receive": ["admin", "frontdesk", "cashier"],
  "cashier.refund": ["admin", "cashier"],
  "cashier.checkout": ["admin", "frontdesk", "cashier"],
  "cashier.reverse_checkout": ["admin"],
  "cashier.charge_company": ["admin", "cashier"],
  "cashier.transfer": ["admin", "cashier"],
  "cashier.split": ["admin", "cashier"],
  /*
   * 红冲发票（第六轮整改清单一.6 新增）
   *
   * 为什么单列一个点、而不是复用已有的两个候选：
   *   · report.view_finance 是**查看**财务报表，用它去控制「生成负数票 + 原票作废」这种
   *     不可逆的账务写操作，语义错位：给某人开报表就会顺带给他红冲权；
   *   · settings.manage 只授权 admin，而 ROLE_MODULES.cashier 明确放行了 /invoices
   *     （收银员开票后要能查台账 / 红冲），挂 settings.manage 会把收银的红冲入口锁死，
   *     等于把一个「收银台日常动作」变成管理员专属。
   * 所以按清单「invoice.manage 或 admin」的意图拆出更窄的 invoice.void（红冲专用），
   * 授权给真正做这件事的两个岗位：admin / cashier。
   */
  "invoice.void": ["admin", "cashier"],
  // 夜审 / 报表
  "night_audit.run": ["admin"],
  /* 第 4 轮 P1-18：撤销夜审（冲正房费 + 还原 NOSHOW + 删营收日报），不可逆，仅 admin */
  "night_audit.undo": ["admin"],
  "report.view_finance": ["admin", "cashier"],
  "report.view_operation": ["admin", "frontdesk", "cashier"],
  // 渠道 / 设置 / 账号
  "channel.configure": ["admin"],
  "channel.sync": ["admin"],
  "settings.manage": ["admin"],
  "user.manage": ["admin"],
  // 客人敏感数据
  "guest.view_sensitive": ["admin", "frontdesk"],
  "guest.modify": ["admin", "frontdesk"],
  /*
   * 会员等级变更（第六轮清单 一.7「会员等级变更必须有 member.manage」）
   *
   * 与 guest.modify 分开的理由：等级决定折扣与积分比例，是**会员权益**而不是档案字段。
   * 建档（guest.modify）与抬等级（member.manage）分开授权后，酒店可以把「录会员」
   * 交给前台，把「提等级 / 批量自动升级」留在更小的圈子里，不必为改等级而放开整个客史编辑。
   */
  "member.manage": ["admin", "frontdesk"],
  "member.view_sensitive": ["admin", "frontdesk", "cashier"],
  /*
   * 撤销早餐核销（整改报告第六轮 一.1 新增）
   *
   * 早餐的「核销」是把一份在住含早权益标记为已用餐，「撤销核销」是把它退回待核销。
   * 现有权限点都表达不了这个语义：
   *   · cashier.refund 是「把钱退给客人」——撤销核销不动任何金额；
   *   · cashier.reverse_checkout 是「撤销退房」——撤销核销不碰房态与账务。
   * 复用其中任何一个都会把「前台日常更正」错绑到收银/管理员的财务动作上，
   * 所以单列一个权限点，角色集与早餐核销的实际操作者一致（admin / frontdesk）。
   */
  "breakfast.void": ["admin", "frontdesk"],
};

/** 全部内置权限点（顺序稳定；设置页在权限字典表为空时用它兜底渲染） */
export const PERMISSION_CODES: string[] = Object.keys(PERMISSIONS);

/**
 * 权限点中文名（降级兜底；权威来源是 permission_dict 表）
 * ⚠️ 必须与 scripts/migrate-all.mjs 的 RBAC_PERMISSION_DICT 保持一致。
 */
export const PERMISSION_LABELS: Record<string, string> = {
  "room.view": "查看房态",
  "room.change_status": "修改房态",
  "booking.view": "查看预订",
  "booking.create": "创建预订",
  "booking.assign_room": "排房与换房",
  "booking.cancel": "取消预订",
  "booking.modify": "修改预订",
  "booking.delete": "删除预订",
  "checkin.create": "办理入住",
  "checkin.cancel": "取消入住",
  "folio.post_charge": "账单过账",
  "cashier.view": "查看收银台",
  "cashier.receive": "收款",
  "cashier.refund": "退款",
  "cashier.checkout": "退房结账",
  "cashier.reverse_checkout": "撤销退房",
  "cashier.charge_company": "挂公司账",
  "cashier.transfer": "账单转账",
  "cashier.split": "拆分账单",
  "invoice.void": "红冲发票",
  "night_audit.run": "执行夜审",
  "night_audit.undo": "撤销夜审",
  "report.view_finance": "查看财务报表",
  "report.view_operation": "查看经营报表",
  "channel.configure": "配置渠道",
  "channel.sync": "同步渠道",
  "settings.manage": "系统设置",
  "user.manage": "账号与岗位",
  "guest.view_sensitive": "查看客人敏感信息",
  "guest.modify": "修改客人资料",
  "member.manage": "会员等级变更",
  "member.view_sensitive": "查看会员敏感信息",
  "breakfast.void": "撤销早餐核销",
};

/** 权限点归属模块（降级兜底；权威来源是 permission_dict.module） */
export const PERMISSION_MODULE_OF: Record<string, string> = {
  "room.view": "room",
  "room.change_status": "room",
  "booking.view": "booking",
  "booking.create": "booking",
  "booking.assign_room": "booking",
  "booking.cancel": "booking",
  "booking.modify": "booking",
  "booking.delete": "booking",
  "checkin.create": "checkin",
  "checkin.cancel": "checkin",
  "folio.post_charge": "cashier",
  "cashier.view": "cashier",
  "cashier.receive": "cashier",
  "cashier.refund": "cashier",
  "cashier.checkout": "cashier",
  "cashier.reverse_checkout": "cashier",
  "cashier.charge_company": "cashier",
  "cashier.transfer": "cashier",
  "cashier.split": "cashier",
  "invoice.void": "cashier",
  "night_audit.run": "night_audit",
  "night_audit.undo": "night_audit",
  "report.view_finance": "report",
  "report.view_operation": "report",
  "channel.configure": "channel",
  "channel.sync": "channel",
  "settings.manage": "settings",
  "user.manage": "settings",
  "guest.view_sensitive": "guest",
  "guest.modify": "guest",
  "member.manage": "member",
  "member.view_sensitive": "member",
  "breakfast.void": "breakfast",
};

/* ------------------------- 读库 + 进程内缓存 ------------------------- */

/** 缓存有效期：5 秒 */
const RBAC_CACHE_TTL_MS = 5000;

type RbacSnapshot = {
  /** role → 允许的页面模块（库里可能有 "*" 表示全部） */
  modules: Map<string, string[]>;
  /** role → 允许的权限点 */
  permissions: Map<string, string[]>;
  /** 本店在库里是否已有任何权限配置（false = 还没迁移，全部走常量兜底） */
  configured: boolean;
  /** 写入缓存的时间戳（毫秒） */
  at: number;
};

/**
 * 缓存：hotelId → 本店的权限快照
 *
 * 策略：每个酒店缓存 5 秒 + 设置页保存后调 invalidatePermissionCache() 立即失效。
 * 为什么不用无限缓存：多实例部署时一个实例改了设置，别的实例要能较快感知；
 * 5 秒窗口对单次请求完全没有影响（一次跳转最多查两次库），
 * 又足够短，不至于让两个实例的权限长期不一致。
 *
 * ⚠️ 缓存表必须挂在 globalThis 上，不能用模块级 const：
 *   Next.js 会把页面、Server Action、Route Handler 分别打包，同一份 session.ts
 *   会被打进多个 bundle，模块级变量各有一份 —— 设置页保存时 invalidatePermissionCache()
 *   只清掉页面那一份，/api/* 的 Route Handler 还留着自己的旧缓存，
 *   表现就是「设置页已经保存成功，接口却还要等 5 秒 TTL 才生效」，
 *   正好违背整改 5.2 要求的「即时影响实际接口判断」。
 *   挂在 globalThis（与 src/lib/db.ts 的 __pmsDb 同一手法）后，同进程内所有 bundle
 *   共用一份缓存，保存完的下一个请求就按新权限判断。
 *   多进程/多实例之间仍然靠 5 秒 TTL 兜底。
 */
declare global {
  // eslint-disable-next-line no-var
  var __pmsRbacCache: Map<number, RbacSnapshot> | undefined;
}

function rbacCache(): Map<number, RbacSnapshot> {
  if (!globalThis.__pmsRbacCache) globalThis.__pmsRbacCache = new Map<number, RbacSnapshot>();
  return globalThis.__pmsRbacCache;
}

/** hotelId 归一化：缺省/非法一律按 1 处理（单店部署兼容） */
function normalizeHotelId(hotelId?: number): number {
  const n = Number(hotelId);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

/** 直接读库构建快照；表还不存在（迁移没跑）时返回「未配置」 */
function loadRbacFromDb(hotelId: number): RbacSnapshot {
  const modules = new Map<string, string[]>();
  const permissions = new Map<string, string[]>();

  try {
    for (const row of all<{ role: string; module: string }>(
      `SELECT role, module FROM role_modules WHERE hotel_id = ?`,
      [hotelId]
    )) {
      const list = modules.get(row.role);
      if (list) list.push(row.module);
      else modules.set(row.role, [row.module]);
    }
    for (const row of all<{ role: string; permission: string }>(
      `SELECT role, permission FROM role_permissions WHERE hotel_id = ?`,
      [hotelId]
    )) {
      const list = permissions.get(row.role);
      if (list) list.push(row.permission);
      else permissions.set(row.role, [row.permission]);
    }
  } catch {
    /*
     * 表不存在 = 迁移还没跑（比如刚部署打完包就有人登录）。
     * 这里不抛错，交给调用方走常量兜底 —— 权限查询失败绝不能变成「全站 401」。
     */
    return { modules: new Map(), permissions: new Map(), configured: false, at: Date.now() };
  }

  return {
    modules,
    permissions,
    configured: modules.size > 0 || permissions.size > 0,
    at: Date.now(),
  };
}

/** 取本店权限快照（命中新鲜缓存则直接返回） */
function rbacOf(hotelId: number): RbacSnapshot {
  const cached = rbacCache().get(hotelId);
  if (cached && Date.now() - cached.at < RBAC_CACHE_TTL_MS) return cached;
  const fresh = loadRbacFromDb(hotelId);
  rbacCache().set(hotelId, fresh);
  return fresh;
}

/**
 * 设置页保存权限后调用，立即失效缓存
 * @param hotelId 省略/非法 = 清空所有酒店的缓存
 */
export function invalidatePermissionCache(hotelId?: number): void {
  if (hotelId === undefined) {
    rbacCache().clear();
    return;
  }
  rbacCache().delete(normalizeHotelId(hotelId));
}

/** 本店的权限是否已经由数据库配置（false = 正在用内置常量兜底，建议跑一次迁移） */
export function isRbacDbBacked(hotelId?: number): boolean {
  return rbacOf(normalizeHotelId(hotelId)).configured;
}

/* ------------------------------ 判断函数 ------------------------------ */

/**
 * 判断角色是否拥有某个权限点
 *
 * 数据来源优先级：
 *   1. admin → 永远放行（管理员不能被权限表锁死）；
 *   2. role_permissions 里该角色有配置 → 完全以库为准（没勾就是没有）；
 *   3. 该角色在库里一行都没有（新库 / 新角色 / 迁移没跑）→ 降级到 PERMISSIONS 常量。
 *
 * @param role 角色 code
 * @param permission 权限点，如 booking.create
 * @param hotelId 酒店 id，默认 1（保持旧签名 hasPermission(role, permission) 兼容）
 */
export function hasPermission(role: string, permission: string, hotelId?: number): boolean {
  if (role === "admin") return true;
  const snapshot = rbacOf(normalizeHotelId(hotelId));
  const granted = snapshot.permissions.get(role);
  if (granted) return granted.includes(permission);

  // 兜底：库里没有该角色的配置
  const fallback = PERMISSIONS[permission];
  return Array.isArray(fallback) ? fallback.includes(role) : false;
}

/** checkPermission 的返回：不通过时 permission 原样带回，方便跳转时带上权限点 */
export type PermissionCheck = {
  ok: boolean;
  permission: string;
};

/**
 * 结构化权限判断（**不抛错**）
 *
 * 用法（页面 / 高频动作里替代 requirePermission）：
 *   const perm = checkPermission(user, "report.view_finance");
 *   if (!perm.ok) redirect(`/no-permission?p=${encodeURIComponent(perm.permission)}`);
 *
 * 为什么需要它（第十轮验收 P2，真浏览器复现）：
 *   生产构建下 Server Action 抛出的错误会被 Next 脱敏成只剩 digest
 *   （响应体形如 `1:E{"digest":"1475647473"}`，没有 message），
 *   error.tsx 的 parsePermissionError 靠匹配 `FORBIDDEN` 文本，永远命中不到，
 *   用户看到的是「操作失败」而不是「没有该操作权限」。
 *   改成「先判断、不通过就 redirect」后，呈现不再依赖任何错误文案。
 *
 * 与 requirePermission 的分工：
 *   · requirePermission：抛错，给接口 / 100+ 个还没迁移的 action 兜底（安全边界不变）；
 *   · checkPermission：只想「拿到结果自己决定怎么呈现」的调用方用（页面、高危按钮）。
 *   两者共用同一个 hasPermission 口径，不存在两套权限逻辑。
 */
export function checkPermission(
  user: Pick<SessionUser, "role" | "hotelId">,
  permission: string
): PermissionCheck {
  return { ok: hasPermission(user.role, permission, user.hotelId), permission };
}

/**
 * 「只要求登录、不做模块授权」的提示页白名单
 *
 * 语义（往数组里加路径前必读）：
 *   · 这里匹配到的路径，canAccess 直接返回 true —— 只保证 session 有效（已登录），
 *     **不做 role_modules 模块授权判断**；
 *   · 因为不做模块授权，这些页面绝不能承载任何业务数据 / 写操作，只能放文案与链接；
 *   · 以后要往这里加路径，先确认它同样「无数据、无副作用」。
 *
 * 为什么 /no-permission 必须放行（第十轮验收 P2）：
 *   权限被拒时会跳到 /no-permission（见 requirePermissionOrRedirect / reports 页），
 *   而 (main)/layout.tsx 对非 admin 还会按 role_modules 再拦一次 ——
 *   /no-permission 不在任何角色的模块清单里，不放行的话被拒用户会被第二次重定向回
 *   /dashboard?err=…，永远看不到「没有该操作权限」这句话，等于没做。
 *   该页只读 session（角色 / 权限点中文名），不碰任何业务数据，放行无越权风险。
 */
const AUTHENTICATED_ONLY_PATHS = ["/no-permission"];

/**
 * 判断角色能否访问某个路径（页面守卫用）
 *
 * 与 hasPermission 同构：库里该角色有配置就以库为准，否则降级到 ROLE_MODULES 常量。
 * 库里用模块 "*"（或任意一条 "*"）表示「全部页面」。
 *
 * @param pathname 已去掉查询串的路径，如 /rooms
 * @param hotelId 酒店 id，默认 1（保持旧签名 canAccess(role, pathname) 兼容）
 */
export function canAccess(role: string, pathname: string, hotelId?: number): boolean {
  if (role === "admin") return true;
  if (AUTHENTICATED_ONLY_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  const snapshot = rbacOf(normalizeHotelId(hotelId));
  const dbModules = snapshot.modules.get(role);
  const modules: string[] | "*" | undefined = dbModules ?? ROLE_MODULES[role];
  if (modules === "*") return true;
  if (!modules) return false;
  if (modules.includes("*")) return true;
  return modules.some((m) => pathname === m || pathname.startsWith(m + "/"));
}

/** 已知的全部权限点：内置常量 ∪ 本店库里出现过的（排序后稳定） */
function knownPermissionCodes(snapshot: RbacSnapshot): string[] {
  const codes = new Set<string>(PERMISSION_CODES);
  for (const list of snapshot.permissions.values()) {
    for (const p of list) codes.add(p);
  }
  return [...codes].sort();
}

/**
 * 当前角色拥有的权限点清单（前端按权限隐藏按钮用，不代替服务端校验）
 * admin 返回全部已知权限点。
 */
export function permissionsOf(role: string, hotelId?: number): string[] {
  const snapshot = rbacOf(normalizeHotelId(hotelId));
  if (role === "admin") return knownPermissionCodes(snapshot);
  const granted = snapshot.permissions.get(role);
  if (granted) return [...granted].sort();
  // 兜底：常量里包含该角色的权限点
  return PERMISSION_CODES.filter((p) => PERMISSIONS[p].includes(role));
}

/**
 * 当前角色可访问的页面模块清单（设置页 / 调试用）
 * admin 返回 ["*"]；库里没有该角色的配置时降级到 ROLE_MODULES 常量。
 */
export function modulesOf(role: string, hotelId?: number): string[] {
  const snapshot = rbacOf(normalizeHotelId(hotelId));
  const dbModules = snapshot.modules.get(role);
  if (dbModules) return [...dbModules].sort();
  const fallback = ROLE_MODULES[role];
  if (!fallback) return [];
  return fallback === "*" ? ["*"] : [...fallback];
}

/** 动作级权限断言：无权限抛错 */
export async function requirePermission(permission: string): Promise<SessionUser> {
  const u = await requireUser();
  if (!hasPermission(u.role, permission, u.hotelId)) {
    throw new Error(`FORBIDDEN: 缺少权限 ${permission}`);
  }
  return u;
}

/**
 * 动作级权限断言（redirect 版）：无权限直接跳 /no-permission，不抛错
 *
 * 为什么需要它（第十轮验收 P2）：
 *   见 checkPermission 的注释 —— 生产构建会把 Server Action 的错误消息脱敏成 digest，
 *   error.tsx 拿不到 `FORBIDDEN: 缺少权限 xxx` 这段文字，只能显示「操作失败」。
 *   redirect 是 Next 的受控返回，不经过错误脱敏，页面上一定能看到「没有该操作权限」。
 *
 * 覆盖范围（如实说明）：只覆盖主动改用本函数的 action（当前是收银台 10 个动作）。
 *   其余 100+ 处仍是 requirePermission（抛错），生产构建下继续显示「操作失败」，
 *   这是本方案的已知限制：逐页迁移，不改变任何服务端拒绝逻辑。
 *
 * 安全边界不变：判断仍然是 hasPermission（admin 短路 + 库为准 + 常量兜底），
 * 只是把「失败后的出口」从抛错换成跳提示页，不会让无权限的人真的执行到写库代码。
 */
export async function requirePermissionOrRedirect(permission: string): Promise<SessionUser> {
  const u = await requireUser();
  if (!hasPermission(u.role, permission, u.hotelId)) {
    redirect(`/no-permission?p=${encodeURIComponent(permission)}`);
  }
  return u;
}
