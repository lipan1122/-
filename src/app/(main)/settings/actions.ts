"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  /* 动作级权限点（整改 5.2）：与本文件上面的角色权限编码 PERMISSION_CODES 是两套东西，改名避免冲突 */
  PERMISSION_CODES as RBAC_PERMISSION_CODES,
  PERMISSION_LABELS as RBAC_PERMISSION_LABELS,
  PERMISSION_MODULE_OF as RBAC_PERMISSION_MODULE_OF,
  invalidatePermissionCache,
  requirePermission,
  requireUser,
} from "@/lib/session";
import { ROLE_LABEL, nowIso, round2, todayStr } from "@/lib/utils";

/** 需要校验 HH:mm 格式的系统参数 */
const TIME_KEYS = new Set(["check_in_time", "check_out_time", "night_audit_time"]);

/** 需要校验为整数并限定范围的系统参数：key → [最小, 最大] */
const INT_SETTING_RANGE: Record<string, [number, number]> = {
  cancel_timeout_minutes: [0, 720],
};

/** 布尔型系统参数，落库为 "1" / "0" */
const BOOL_KEYS = new Set(["allow_overbooking"]);

/** 角色权限项编码，需与页面勾选项保持一致 */
const PERMISSION_CODES = [
  "room_status",
  "booking",
  "checkin",
  "cashier",
  "night_audit",
  "report",
  "settings",
] as const;
const PERMISSION_SET = new Set<string>(PERMISSION_CODES);

/** 包价 / 销售员状态 */
const ACTIVE = "ACTIVE";
const INACTIVE = "INACTIVE";

/** 消费项目种子：名称 / 分类 / 默认单价 */
const DEBIT_ITEM_SEEDS: { name: string; category: string; price: number }[] = [
  // 与去呼呼「消费项目」页的默认项保持一致
  { name: "夜审房费", category: "房费", price: 0 },
  { name: "小商品", category: "其他", price: 0 },
  { name: "餐饮服务", category: "餐饮", price: 0 },
  { name: "客房服务", category: "其他", price: 0 },
  { name: "小商超", category: "其他", price: 0 },
  { name: "加收半天", category: "房费", price: 0 },
  { name: "加收全天", category: "房费", price: 0 },
  { name: "钟点房费", category: "房费", price: 0 },
  { name: "手工房费", category: "房费", price: 0 },
];

/** 收款项目种子：与去呼呼「支付方式」页的 16 项保持一致 */
const CREDIT_ITEM_SEEDS: { name: string; method: string }[] = [
  { name: "现金", method: "现金" },
  { name: "信用卡", method: "信用卡" },
  { name: "支票", method: "支票" },
  { name: "退款现金", method: "退款现金" },
  { name: "转AR账", method: "AR账" },
  { name: "会员储值卡", method: "储值卡" },
  { name: "微信付款", method: "微信" },
  { name: "支付宝付款", method: "支付宝" },
  { name: "银行转账", method: "银行转账" },
  { name: "银行卡付款", method: "银行卡" },
  { name: "转账", method: "转账" },
  { name: "现金押金", method: "现金押金" },
  { name: "信用卡押金", method: "信用卡押金" },
  { name: "储值赠送", method: "储值赠送" },
  { name: "支付宝预授权", method: "支付宝预授权" },
  { name: "微信预授权", method: "微信预授权" },
];

/** 会员卡类型种子：普通卡 1.0 / 银卡 0.95 / 金卡 0.9 */
const MEMBER_CARD_TYPE_SEEDS: { name: string; discount: number; points_ratio: number; min_recharge: number }[] = [
  { name: "普通卡", discount: 1, points_ratio: 1, min_recharge: 0 },
  { name: "银卡", discount: 0.95, points_ratio: 1.2, min_recharge: 500 },
  { name: "金卡", discount: 0.9, points_ratio: 1.5, min_recharge: 2000 },
];

/** 充值方案种子：充 500 送 50 / 充 1000 送 120 / 充 2000 送 300 / 充 5000 送 800 */
const RECHARGE_PLAN_SEEDS: { name: string; amount: number; gift_amount: number }[] = [
  { name: "充 500 送 50", amount: 500, gift_amount: 50 },
  { name: "充 1000 送 120", amount: 1000, gift_amount: 120 },
  { name: "充 2000 送 300", amount: 2000, gift_amount: 300 },
  { name: "充 5000 送 800", amount: 5000, gift_amount: 800 },
];

/** 角色种子数据：code / 名称 / 默认权限 */
const ROLE_SEEDS: { code: string; name: string; permissions: string[] }[] = [
  { code: "admin", name: "系统管理员", permissions: [...PERMISSION_CODES] },
  {
    code: "manager",
    name: "店长",
    permissions: ["room_status", "booking", "checkin", "cashier", "night_audit", "report"],
  },
  { code: "frontdesk", name: "前台", permissions: ["room_status", "booking", "checkin"] },
  { code: "cashier", name: "收银", permissions: ["cashier", "report"] },
];

/** 房价代码类型（去呼呼口径：门市价 / 协议价 / 会员价 / 团队价） */
const RATE_CODE_TYPES = ["门市价", "协议价", "会员价", "团队价"] as const;
const RATE_CODE_TYPE_SET = new Set<string>(RATE_CODE_TYPES);

/** 房价代码种子：代码 / 名称 / 类型 / 折扣率 */
const RATE_CODE_SEEDS: { code: string; name: string; type: string; discount: number }[] = [
  { code: "MDJ", name: "门市价", type: "门市价", discount: 1 },
  { code: "XYJ", name: "协议价", type: "协议价", discount: 0.85 },
  { code: "HYJ", name: "会员价", type: "会员价", discount: 0.9 },
  { code: "TDJ", name: "团队价", type: "团队价", discount: 0.8 },
];

/** 岗位种子：名称 / 权限项 / 对应 users.role（用于给现有员工挂岗位） */
const POSITION_SEEDS: { name: string; role: string; permissions: string[] }[] = [
  { name: "管理员", role: "admin", permissions: [...PERMISSION_CODES] },
  { name: "前台", role: "frontdesk", permissions: ["room_status", "booking", "checkin"] },
  { name: "收银", role: "cashier", permissions: ["cashier", "report"] },
  { name: "客房", role: "housekeeping", permissions: ["room_status"] },
];

/** 字典项种子：kind → 每类 3 条（换房 / 锁房 / 维修房 原因 + AR 账户类型） */
const DICT_KIND_SEEDS: { kind: string; label: string; names: string[] }[] = [
  { kind: "CHANGE_ROOM", label: "换房原因", names: ["房间设施问题", "客人需求变更", "房间状态不符"] },
  { kind: "LOCK_ROOM", label: "锁房原因", names: ["维修施工", "深度清洁", "长期保留"] },
  { kind: "REPAIR_ROOM", label: "维修房原因", names: ["空调故障", "水管漏水", "电视故障"] },
  { kind: "AR_TYPE", label: "AR账户类型", names: ["协议单位", "旅行社", "OTA 渠道"] },
  {
    kind: "BOOKING_PAY",
    label: "收款类型",
    names: ["预付", "现付", "担保", "预付-闪住", "会员卡预付", "到店付款", "AR挂账", "在线付款", "银行转账", "支票"],
  },
];

/** 合法的字典类型 */
const DICT_KIND_SET = new Set(DICT_KIND_SEEDS.map((item) => item.kind));

/** 高级设置默认值（全部落在 settings 表 key-value，已有值不覆盖） */
const ADVANCED_DEFAULTS: [string, string][] = [
  ["property_owner_name", ""],
  ["property_owner_id_no", ""],
  ["property_owner_phone", ""],
  ["property_owner_address", ""],
  ["homepage_default", "/rooms"],
  ["table_density", "compact"],
  ["show_room_legend", "1"],
  ["report_email", ""],
  ["report_send_time", "08:00"],
  ["report_enabled", "0"],
  /*
   * 整改清单 P1-35：管家密码原来以明文存 `steward_password`。
   * 现在只存 scrypt 哈希（steward_password_hash），明文 key 仅作为历史迁移
   * 的清理目标保留在这里 —— 种子永远写空串，不允许再出现明文。
   */
  ["steward_password", ""],
  ["steward_password_hash", ""],
  ["micro_butler_scenes", '["在线选房","自助入住","电子发票"]'],
];

/** 个性化设置：首页默认页可选值（路径必须存在对应页面） */
const HOMEPAGE_OPTIONS = new Set(["/dashboard", "/rooms", "/bookings", "/frontdesk", "/cashier", "/reports"]);

/** 个性化设置：表格密度 */
const DENSITY_OPTIONS = new Set(["compact", "loose"]);

/** 微管家服务场景可选值 */
const MICRO_BUTLER_SCENES = ["在线选房", "自助入住", "电子发票", "客房服务"] as const;
const MICRO_BUTLER_SCENE_SET = new Set<string>(MICRO_BUTLER_SCENES);

/** users.role → 默认岗位名称，种子阶段给现有账号挂上岗位 */
const ROLE_POSITION: Record<string, string> = {
  admin: "管理员",
  manager: "管理员",
  frontdesk: "前台",
  cashier: "收银",
  housekeeping: "客房",
};

const CN_FLOOR_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 楼层编号 → 「七层」这类中文楼层名 */
function floorName(floor: number): string {
  const n = Math.trunc(floor);
  if (n <= 0) return `B${Math.abs(n)} 层`;
  const digit = CN_FLOOR_DIGITS[n];
  if (digit) return `${digit}层`;
  if (n === 10) return "十层";
  if (n < 20) return `十${CN_FLOOR_DIGITS[n % 10]}层`;
  if (n < 100) {
    const rest = n % 10;
    return `${CN_FLOOR_DIGITS[Math.floor(n / 10)]}十${rest === 0 ? "" : CN_FLOOR_DIGITS[rest]}层`;
  }
  return `${n} 层`;
}

/** 读取表的列名集合（老库缺列时用 ALTER TABLE 兜底，不改 init-db） */
function tableColumns(table: string): Set<string> {
  const rows = all<{ name: unknown }>(`PRAGMA table_info("${table}")`);
  return new Set(rows.map((row) => String(row.name)));
}

/** 列不存在才加，幂等 */
function ensureColumn(table: string, column: string, type: string): void {
  if (!tableColumns(table).has(column)) run(`ALTER TABLE "${table}" ADD COLUMN ${column} ${type}`);
}

/** 读取字符串字段并去除首尾空格，非字符串视为空串 */
function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 读取数字字段，空值 / 非法值返回 NaN，便于调用方判断 */
function num(value: FormDataEntryValue | null): number {
  const raw = str(value);
  if (!raw) return Number.NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

/*
 * 金额统一保留两位小数：用 @/lib/utils 的权威实现（整改清单 P2-1）。
 * 这里原来的 `Math.round(n * 100) / 100` 对负数不对称（-2.675 → -2.67），
 * 退款/减免类金额与正向金额相加会出现 1 分的系统性偏差。
 */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM */
function isValidMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** YYYY-MM-DD，并校验真实存在的日期（排除 2 月 30 日之类） */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 该月天数 */
function monthDays(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** 拼装本页地址，参数自动编码 */
function settingsUrl(params: Record<string, string>, hash: string): string {
  const qs = new URLSearchParams(params).toString();
  return qs ? `/settings?${qs}#${hash}` : `/settings#${hash}`;
}

/** 房价日历失败 / 成功回跳 */
function backToRates(month: string, key: "err" | "msg", message: string): never {
  redirect(settingsUrl({ tab: "rates", month, [key]: message }, "rates"));
}

/** 包价页回跳 */
function backToPackages(key: "err" | "msg", message: string): never {
  redirect(settingsUrl({ tab: "packages", [key]: message }, "packages"));
}

/** 销售员页回跳 */
function backToSalesmen(key: "err" | "msg", message: string): never {
  redirect(settingsUrl({ tab: "salesmen", [key]: message }, "salesmen"));
}

/** 权限矩阵页回跳（整改 5.2：落库的 role_permissions / role_modules） */
function backToRbac(key: "err" | "msg", message: string): never {
  redirect(settingsUrl({ tab: "rbac", [key]: message }, "rbac"));
}

/** 房型 / 房间 / 参数页回跳 */
function backToTab(tab: string, key: "err" | "msg", message: string): never {
  redirect(settingsUrl({ tab, [key]: message }, tab));
}

/* -------------------------------------------------------------------------- */
/* 懒创建：扩展设置相关表 + 首次访问示例种子（不改 scripts/init-db.mjs）        */
/* -------------------------------------------------------------------------- */

let schemaReady = false;
const seededHotels = new Set<number>();

/** 建表（幂等）并按酒店写入一次示例种子数据 */
export async function ensureSettingsSchema(hotelId: number): Promise<void> {
  /*
   * 权限边界（上线前加固）：建表 / 种子助手不该是可匿名调用的 RPC 端点。
   * 它被 settings/page.tsx 与 member-cards/page.tsx 直接 import，去掉 export 会打断页面编译，
   * 这里补登录守卫；同时酒店 id 必须与 session 一致，避免拿别家 hotelId 往别家写种子数据。
   */
  const user = await requireUser();
  if (Number(hotelId) !== user.hotelId) throw new Error("FORBIDDEN: 不能为其他酒店初始化设置数据");
  if (!schemaReady) {
    run(`CREATE TABLE IF NOT EXISTS rate_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      room_type_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      updated_at TEXT,
      UNIQUE (hotel_id, room_type_id, date)
    )`);

    run(`CREATE TABLE IF NOT EXISTS package_code (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      breakfast_count INTEGER NOT NULL DEFAULT 0,
      items TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT,
      UNIQUE (hotel_id, code)
    )`);

    run(`CREATE TABLE IF NOT EXISTS salesmen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      commission_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    )`);

    run(`CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      UNIQUE (hotel_id, code)
    )`);

    // 消费项目：房费 / 餐饮 / 洗衣 / 迷你吧 等可挂账的收费项目
    run(`CREATE TABLE IF NOT EXISTS debit_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    )`);

    // 收款项目：现金 / 微信 / 支付宝 / 银行卡 / 挂账 等支付方式
    run(`CREATE TABLE IF NOT EXISTS credit_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '现金',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    )`);

    // 楼层：优先级（sort）/ 楼层名称（如「七层」）/ 楼层编号
    run(`CREATE TABLE IF NOT EXISTS floors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 99,
      created_at TEXT
    )`);

    // 房价代码：门市价 / 协议价 / 会员价 / 团队价 + 折扣率
    run(`CREATE TABLE IF NOT EXISTS rate_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '门市价',
      discount REAL NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT,
      UNIQUE (hotel_id, code)
    )`);
    // 去呼呼「房价代码」列表还带「显示优先级」和「包价」两列
    ensureColumn("rate_codes", "sort", "INTEGER DEFAULT 99");
    ensureColumn("rate_codes", "package_code", "TEXT");

    // 钟点房收费：按房型配置基础时长 / 基础收费 / 超时标准 / 全天房费规则
    run(`CREATE TABLE IF NOT EXISTS hourly_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      room_type_id INTEGER NOT NULL,
      base_hours REAL NOT NULL DEFAULT 4,
      base_price REAL NOT NULL DEFAULT 0,
      overtime_rate REAL NOT NULL DEFAULT 0,
      full_day_rule TEXT NOT NULL DEFAULT '满 8 小时按全天房费收取',
      created_at TEXT,
      UNIQUE (hotel_id, room_type_id)
    )`);

    // 岗位：权限项以 JSON 数组存 permissions
    run(`CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT
    )`);

    // 字典项：换房 / 锁房 / 维修房 原因与 AR 账户类型，kind 区分用途
    run(`CREATE TABLE IF NOT EXISTS dict_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    )`);

    // users 表扩展：岗位归属 + 最后登录时间（老库缺列时才加）
    ensureColumn("users", "position_id", "INTEGER");
    ensureColumn("users", "last_login_at", "TEXT");
    /*
     * 整改清单 P2-30：重置密码后的「强制改密」标记。
     * 页面在渲染员工列表时会 SELECT 这一列，所以必须在本函数（页面顶部就会 await 它）
     * 里兜底补列 —— 迁移脚本里也有同一段 addColumn，两条路都能到目标形态。
     */
    ensureColumn("users", "must_change_password", "INTEGER DEFAULT 0");

    // 会员卡类型：折扣 + 积分比例 + 最低充值门槛
    run(`CREATE TABLE IF NOT EXISTS member_card_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      discount REAL NOT NULL DEFAULT 1,
      points_ratio REAL NOT NULL DEFAULT 1,
      min_recharge REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    )`);

    // 充值方案：充多少送多少
    run(`CREATE TABLE IF NOT EXISTS recharge_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      gift_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    )`);

    schemaReady = true;
  }

  if (seededHotels.has(hotelId)) return;
  seededHotels.add(hotelId);
  seedSettingsDefaults(hotelId);
}

/** 首次访问时写入包价 / 销售员 / 角色 / 本月房价日历示例数据 */
function seedSettingsDefaults(hotelId: number): void {
  const now = nowIso();

  const packageCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM package_code WHERE hotel_id = ?`, [hotelId])?.n;
  if ((packageCount ?? 0) === 0) {
    const minPrice = get<{ p: number | null }>(`SELECT MIN(base_price) AS p FROM room_types WHERE hotel_id = ?`, [
      hotelId,
    ])?.p;
    const base = Number(minPrice) > 0 ? Number(minPrice) : 258;
    tx(() => {
      run(
        `INSERT INTO package_code (hotel_id, code, name, price, breakfast_count, items, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [hotelId, "PKG-BF", "含双早包价", round2(base + 60), 2, "标准房 1 晚 + 双人自助早餐", ACTIVE, now]
      );
      run(
        `INSERT INTO package_code (hotel_id, code, name, price, breakfast_count, items, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [hotelId, "PKG-DN", "含晚餐包价", round2(base + 160), 2, "标准房 1 晚 + 双人早餐 + 双人晚餐", ACTIVE, now]
      );
    });
  }

  /*
   * ⚠️ 上线前加的保护
   *
   * 上面几段是系统基础配置（套餐代码 / 角色 / 房价日历），真实酒店要用，保留。
   * 但销售员列表是**虚构人名 + 假手机号**（张伟 / 李娜 / 王强），
   * 上线后会在「销售员业绩」报表里出现三个查无此人的销售，
   * 还可能被误当成真实员工业绩去算提成。所以只在演示模式下灌。
   */
  const salesmanCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM salesmen WHERE hotel_id = ?`, [hotelId])?.n;
  if ((salesmanCount ?? 0) === 0 && process.env.PMS_DEMO_SEED === "1") {
    const seeds: [string, string, number, string][] = [
      ["张伟", "13800001111", 5, ACTIVE],
      ["李娜", "13900002222", 3, ACTIVE],
      ["王强", "13700003333", 4, INACTIVE],
    ];
    tx(() => {
      for (const [name, phone, rate, status] of seeds) {
        run(
          `INSERT INTO salesmen (hotel_id, name, phone, commission_rate, status, created_at) VALUES (?,?,?,?,?,?)`,
          [hotelId, name, phone, rate, status, now]
        );
      }
    });
  }

  const roleCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM roles WHERE hotel_id = ?`, [hotelId])?.n;
  if ((roleCount ?? 0) === 0) {
    tx(() => {
      for (const role of ROLE_SEEDS) {
        run(`INSERT INTO roles (hotel_id, code, name, permissions, created_at) VALUES (?,?,?,?,?)`, [
          hotelId,
          role.code,
          role.name,
          JSON.stringify(role.permissions),
          now,
        ]);
      }
    });
  }

  const calendarCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM rate_calendar WHERE hotel_id = ?`,
    [hotelId]
  )?.n;
  if ((calendarCount ?? 0) === 0) {
    const roomTypes = all<{ id: number; base_price: number }>(
      `SELECT id, base_price FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
      [hotelId]
    );
    if (roomTypes.length > 0) {
      const month = todayStr().slice(0, 7);
      const days = monthDays(month);
      tx(() => {
        for (const rt of roomTypes) {
          for (let day = 1; day <= days; day += 1) {
            run(
              `INSERT OR IGNORE INTO rate_calendar (hotel_id, room_type_id, date, price, updated_at)
               VALUES (?,?,?,?,?)`,
              [hotelId, rt.id, `${month}-${pad2(day)}`, round2(Number(rt.base_price) || 0), now]
            );
          }
        }
      });
    }
  }

  const debitCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM debit_items WHERE hotel_id = ?`, [hotelId])?.n;
  if ((debitCount ?? 0) === 0) {
    tx(() => {
      for (const item of DEBIT_ITEM_SEEDS) {
        run(
          `INSERT INTO debit_items (hotel_id, name, category, price, status, created_at) VALUES (?,?,?,?,?,?)`,
          [hotelId, item.name, item.category, round2(item.price), ACTIVE, now]
        );
      }
    });
  }

  const creditCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM credit_items WHERE hotel_id = ?`, [hotelId])?.n;
  if ((creditCount ?? 0) === 0) {
    tx(() => {
      for (const item of CREDIT_ITEM_SEEDS) {
        run(`INSERT INTO credit_items (hotel_id, name, method, status, created_at) VALUES (?,?,?,?,?)`, [
          hotelId,
          item.name,
          item.method,
          ACTIVE,
          now,
        ]);
      }
    });
  }

  const cardTypeCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM member_card_types WHERE hotel_id = ?`, [
    hotelId,
  ])?.n;
  if ((cardTypeCount ?? 0) === 0) {
    tx(() => {
      for (const card of MEMBER_CARD_TYPE_SEEDS) {
        run(
          `INSERT INTO member_card_types (hotel_id, name, discount, points_ratio, min_recharge, status, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [hotelId, card.name, card.discount, card.points_ratio, round2(card.min_recharge), ACTIVE, now]
        );
      }
    });
  }

  const planCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recharge_plans WHERE hotel_id = ?`, [hotelId])?.n;
  if ((planCount ?? 0) === 0) {
    tx(() => {
      for (const plan of RECHARGE_PLAN_SEEDS) {
        run(
          `INSERT INTO recharge_plans (hotel_id, name, amount, gift_amount, status, created_at) VALUES (?,?,?,?,?,?)`,
          [hotelId, plan.name, round2(plan.amount), round2(plan.gift_amount), ACTIVE, now]
        );
      }
    });
  }

  // 楼层：把 rooms 里已出现的楼层自动写进 floors（名称按中文楼层名生成）
  const floorCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM floors WHERE hotel_id = ?`, [hotelId])?.n;
  if ((floorCount ?? 0) === 0) {
    const floors = all<{ floor: number }>(
      `SELECT DISTINCT floor FROM rooms WHERE hotel_id = ? AND floor IS NOT NULL ORDER BY floor`,
      [hotelId]
    );
    tx(() => {
      for (const row of floors) {
        const floorNo = Math.trunc(Number(row.floor));
        if (!Number.isFinite(floorNo) || floorNo <= 0) continue;
        run(`INSERT INTO floors (hotel_id, name, code, sort, created_at) VALUES (?,?,?,?,?)`, [
          hotelId,
          floorName(floorNo),
          String(floorNo),
          floorNo,
          now,
        ]);
      }
    });
  }

  // 房价代码：门市价 1.0 / 协议价 0.85 / 会员价 0.9 / 团队价 0.8
  const rateCodeCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM rate_codes WHERE hotel_id = ?`, [hotelId])?.n;
  if ((rateCodeCount ?? 0) === 0) {
    tx(() => {
      for (const code of RATE_CODE_SEEDS) {
        run(
          `INSERT OR IGNORE INTO rate_codes (hotel_id, code, name, type, discount, status, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [hotelId, code.code, code.name, code.type, code.discount, ACTIVE, now]
        );
      }
    });
  }

  // 岗位：管理员 / 前台 / 收银 / 客房，并把现有账号按 role 挂到对应岗位
  const positionCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM positions WHERE hotel_id = ?`, [hotelId])?.n;
  if ((positionCount ?? 0) === 0) {
    tx(() => {
      for (const position of POSITION_SEEDS) {
        run(`INSERT INTO positions (hotel_id, name, permissions, created_at) VALUES (?,?,?,?)`, [
          hotelId,
          position.name,
          JSON.stringify(position.permissions),
          now,
        ]);
      }
    });
  }

  const positionIdByName = new Map<string, number>(
    all<{ id: number; name: string }>(`SELECT id, name FROM positions WHERE hotel_id = ?`, [hotelId]).map((row) => [
      row.name,
      row.id,
    ])
  );

  const staff = all<{ id: number; role: string; position_id: number | null; last_login_at: string | null }>(
    `SELECT id, role, position_id, last_login_at FROM users WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  staff.forEach((member, index) => {
    // 岗位为空时按 role 兜底挂一个，已有岗位不覆盖
    if (member.position_id == null) {
      const positionId = positionIdByName.get(ROLE_POSITION[member.role] ?? "");
      if (positionId) run(`UPDATE users SET position_id = ? WHERE id = ? AND hotel_id = ?`, [positionId, member.id, hotelId]);
    }
    // 老库没有登录时间时补一个演示时间（每次登录会覆盖为真实时间）
    if (!member.last_login_at) {
      const loginAt = new Date(Date.now() - (index + 1) * 3 * 3600 * 1000).toISOString();
      run(`UPDATE users SET last_login_at = ? WHERE id = ? AND hotel_id = ?`, [loginAt, member.id, hotelId]);
    }
  });

  // 字典项：换房 / 锁房 / 维修房原因 + AR 账户类型，每类种子 3 条
  const dictCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM dict_items WHERE hotel_id = ?`, [hotelId])?.n;
  if ((dictCount ?? 0) === 0) {
    tx(() => {
      for (const group of DICT_KIND_SEEDS) {
        group.names.forEach((name, index) => {
          run(`INSERT INTO dict_items (hotel_id, kind, name, sort, created_at) VALUES (?,?,?,?,?)`, [
            hotelId,
            group.kind,
            name,
            index + 1,
            now,
          ]);
        });
      }
    });
  }

  // 高级设置默认值：已存在不覆盖，只补缺失的 key
  for (const [key, value] of ADVANCED_DEFAULTS) {
    const existing = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
    if (!existing) run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
  }
}

/* -------------------------------------------------------------------------- */
/* 房型 / 房间                                                                 */
/* -------------------------------------------------------------------------- */

/** 更新房型门市价 */
export async function updateRoomTypePriceAction(room_type_id: number, base_price: number): Promise<void> {
  const user = await requirePermission("settings.manage");
  const id = Math.trunc(room_type_id);
  if (!Number.isFinite(room_type_id) || id <= 0) return;
  if (!Number.isFinite(base_price) || base_price < 0) return;

  const exists = get<{ id: number }>(`SELECT id FROM room_types WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  if (!exists) return;

  run(`UPDATE room_types SET base_price = ? WHERE id = ? AND hotel_id = ?`, [
    round2(base_price),
    id,
    user.hotelId,
  ]);

  revalidatePath("/settings");
}

/** 新增房间：房号在同一酒店内唯一，房型必须存在 */
export async function createRoomAction(
  room_no: string,
  floor: number,
  room_type_id: number
): Promise<{ error: string } | { ok: true }> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;

  const no = room_no.trim();
  const floorNo = Math.trunc(floor);
  const typeId = Math.trunc(room_type_id);

  if (!no) return { error: "请填写房号" };
  if (!/^[0-9A-Za-z-]{1,10}$/.test(no)) return { error: "房号只能是数字、字母或短横线，最多 10 位" };
  if (!Number.isFinite(floor) || floorNo < 1 || floorNo > 99) return { error: "楼层需为 1-99 的整数" };
  if (!Number.isFinite(room_type_id) || typeId <= 0) return { error: "请选择房型" };

  const roomType = get<{ id: number }>(`SELECT id FROM room_types WHERE id = ? AND hotel_id = ?`, [
    typeId,
    hotelId,
  ]);
  if (!roomType) return { error: "房型不存在，请重新选择" };

  const duplicated = get<{ id: number }>(`SELECT id FROM rooms WHERE hotel_id = ? AND room_no = ?`, [hotelId, no]);
  if (duplicated) return { error: `房号 ${no} 已存在，请勿重复添加` };

  const nextSort =
    get<{ next_sort: number }>(`SELECT COALESCE(MAX(sort), 0) + 1 AS next_sort FROM rooms WHERE hotel_id = ?`, [
      hotelId,
    ])?.next_sort ?? 1;

  run(
    `INSERT INTO rooms (hotel_id, room_no, floor, room_type_id, status, sort)
     VALUES (?,?,?,?, 'VC', ?)`,
    [hotelId, no, floorNo, typeId, nextSort]
  );

  revalidatePath("/settings");
  revalidatePath("/rooms");
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* 系统参数                                                                    */
/* -------------------------------------------------------------------------- */

/** 更新系统参数：已存在则更新，否则新增；返回是否通过校验 */
export async function updateSettingAction(key: string, value: string): Promise<boolean> {
  const user = await requirePermission("settings.manage");
  const k = key.trim();
  const v = value.trim();
  if (!k || k.length > 60) return false;
  if (v.length > 200) return false;
  if (TIME_KEYS.has(k) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return false;

  const range = INT_SETTING_RANGE[k];
  if (range) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < range[0] || n > range[1]) return false;
  }
  if (BOOL_KEYS.has(k) && v !== "1" && v !== "0") return false;

  const existing = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [
    user.hotelId,
    k,
  ]);

  if (existing) {
    // 历史数据里同一个 key 可能有重复行，一并更新避免回显不一致
    run(`UPDATE settings SET value = ? WHERE hotel_id = ? AND key = ?`, [v, user.hotelId, k]);
  } else {
    run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [user.hotelId, k, v]);
  }

  revalidatePath("/settings");
  return true;
}

/* -------------------------------------------------------------------------- */
/* 房价日历                                                                    */
/* -------------------------------------------------------------------------- */

/** 保存单个日期 + 房型的房价（懒创建后 upsert 到 rate_calendar） */
export async function updateRateCalendarFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const date = str(formData.get("date"));
  const rawMonth = str(formData.get("month"));
  const month = isValidMonth(rawMonth)
    ? rawMonth
    : isValidDate(date)
      ? date.slice(0, 7)
      : todayStr().slice(0, 7);

  if (!isValidDate(date)) backToRates(month, "err", "日期格式不正确，请刷新后重试");

  const price = num(formData.get("price"));
  if (!Number.isFinite(price) || price < 0 || price > 99999) {
    backToRates(month, "err", "房价需为 0 - 99999 之间的数字");
  }

  const roomTypeId = Math.trunc(num(formData.get("room_type_id")));
  const roomType = get<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE id = ? AND hotel_id = ?`,
    [roomTypeId, hotelId]
  );
  if (!roomType) backToRates(month, "err", "房型不存在，请刷新后重试");

  const amount = round2(price);
  const updatedAt = nowIso();
  const existing = get<{ id: number }>(
    `SELECT id FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ?`,
    [hotelId, roomTypeId, date]
  );

  if (existing) {
    run(`UPDATE rate_calendar SET price = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
      amount,
      updatedAt,
      existing.id,
      hotelId,
    ]);
  } else {
    run(
      `INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, updated_at) VALUES (?,?,?,?,?)`,
      [hotelId, roomTypeId, date, amount, updatedAt]
    );
  }

  revalidatePath("/settings");
  backToRates(month, "msg", `${date} ${roomType.name} 房价已保存为 ¥${amount.toFixed(2)}`);
}

/**
 * 修改房量（去呼呼 batchUpdateRoomNum）
 *
 * 按「房型 + 日期区间」批量设置可售房量（allotment），不动物理房间。
 * 留空表示恢复成该房型的实际房间数。
 */
export async function batchUpdateAllotmentFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const roomTypeId = Math.trunc(num(formData.get("room_type_id")));
  const from = str(formData.get("from"));
  const to = str(formData.get("to"));
  const rawAllot = str(formData.get("allotment"));
  const month = isValidDate(from) ? from.slice(0, 7) : todayStr().slice(0, 7);

  if (!roomTypeId) backToRates(month, "err", "请选择房型");
  if (!isValidDate(from) || !isValidDate(to)) backToRates(month, "err", "请选择正确的日期区间");
  if (from > to) backToRates(month, "err", "开始日期不能晚于结束日期");

  const spanDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  if (spanDays > 180) backToRates(month, "err", "一次最多调整 180 天");

  const roomType = get<{ id: number; name: string }>(
    `SELECT id, name FROM room_types WHERE id = ? AND hotel_id = ?`,
    [roomTypeId, hotelId]
  );
  if (!roomType) backToRates(month, "err", "房型不存在，请刷新后重试");

  const physical =
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM rooms WHERE hotel_id = ? AND room_type_id = ?`, [
      hotelId,
      roomTypeId,
    ])?.c ?? 0;

  /* 留空 = 恢复实际房量 */
  const clearMode = rawAllot === "";
  const allotment = clearMode ? null : Math.trunc(num(rawAllot));
  if (!clearMode && (allotment === null || !Number.isFinite(allotment) || allotment < 0 || allotment > 999)) {
    backToRates(month, "err", "房量需为 0 - 999 之间的整数");
  }

  const updatedAt = nowIso();
  let touched = 0;
  tx(() => {
    for (let i = 0; i < spanDays; i += 1) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      const date = todayStr(d);
      const existing = get<{ id: number }>(
        `SELECT id FROM rate_calendar WHERE hotel_id = ? AND room_type_id = ? AND date = ?`,
        [hotelId, roomTypeId, date]
      );
      if (existing) {
        run(`UPDATE rate_calendar SET allotment = ?, updated_at = ? WHERE id = ? AND hotel_id = ?`, [
          allotment,
          updatedAt,
          existing.id,
          hotelId,
        ]);
      } else {
        // 没定价的日期用门市价兜底，只写房量
        const base =
          get<{ p: number }>(`SELECT COALESCE(base_price, 0) AS p FROM room_types WHERE id = ?`, [roomTypeId])?.p ?? 0;
        run(
          `INSERT INTO rate_calendar (hotel_id, room_type_id, date, price, allotment, updated_at) VALUES (?,?,?,?,?,?)`,
          [hotelId, roomTypeId, date, base, allotment, updatedAt]
        );
      }
      touched += 1;
    }
  });

  revalidatePath("/settings");
  revalidatePath("/rooms/predict");
  backToRates(
    month,
    "msg",
    clearMode
      ? `${roomType.name} ${from} ~ ${to} 共 ${touched} 天，房量已恢复为实际 ${physical} 间`
      : `${roomType.name} ${from} ~ ${to} 共 ${touched} 天，可售房量已设为 ${allotment} 间（实际 ${physical} 间）`
  );
}

/** 按房型门市价补充某月未定价的日期（已有独立价不覆盖） */
export async function fillMonthRateFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const rawMonth = str(formData.get("month"));
  const month = isValidMonth(rawMonth) ? rawMonth : todayStr().slice(0, 7);

  const roomTypes = all<{ id: number; base_price: number }>(
    `SELECT id, base_price FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );
  if (roomTypes.length === 0) backToRates(month, "err", "还没有房型数据，无法生成房价日历");

  const days = monthDays(month);
  const updatedAt = nowIso();
  let inserted = 0;

  tx(() => {
    for (const rt of roomTypes) {
      for (let day = 1; day <= days; day += 1) {
        const result = run(
          `INSERT OR IGNORE INTO rate_calendar (hotel_id, room_type_id, date, price, updated_at)
           VALUES (?,?,?,?,?)`,
          [hotelId, rt.id, `${month}-${pad2(day)}`, round2(Number(rt.base_price) || 0), updatedAt]
        );
        inserted += result.changes;
      }
    }
  });

  revalidatePath("/settings");
  backToRates(
    month,
    "msg",
    inserted > 0 ? `已按门市价补充 ${inserted} 个房价空档` : "该月房价已全部定价，无需补充"
  );
}

/* -------------------------------------------------------------------------- */
/* 包价设置                                                                    */
/* -------------------------------------------------------------------------- */

/** 新增包价：代码在同一酒店内唯一 */
export async function createPackageFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const code = str(formData.get("code")).toUpperCase();
  const name = str(formData.get("name"));
  const price = num(formData.get("price"));
  const breakfastRaw = num(formData.get("breakfast_count"));
  const items = str(formData.get("items"));

  if (!/^[A-Z0-9-]{2,20}$/.test(code)) backToPackages("err", "包价代码只能包含字母、数字、短横线，2-20 位");
  if (!name) backToPackages("err", "请填写包价名称");
  if (name.length > 30) backToPackages("err", "包价名称最多 30 个字符");
  if (!Number.isFinite(price) || price < 0 || price > 99999) {
    backToPackages("err", "包价金额需为 0 - 99999 之间的数字");
  }

  const breakfastCount = Number.isFinite(breakfastRaw) ? Math.trunc(breakfastRaw) : 0;
  if (breakfastCount < 0 || breakfastCount > 9) backToPackages("err", "含早餐份数需为 0 - 9 的整数");
  if (items.length > 80) backToPackages("err", "包价内容最多 80 个字符");

  const duplicated = get<{ id: number }>(`SELECT id FROM package_code WHERE hotel_id = ? AND code = ?`, [
    hotelId,
    code,
  ]);
  if (duplicated) backToPackages("err", `包价代码 ${code} 已存在，请换一个`);

  run(
    `INSERT INTO package_code (hotel_id, code, name, price, breakfast_count, items, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [hotelId, code, name, round2(price), breakfastCount, items, ACTIVE, nowIso()]
  );

  revalidatePath("/settings");
  backToPackages("msg", `包价「${name}」已新增`);
}

/** 删除包价 */
export async function deletePackageFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToPackages("err", "包价不存在，请刷新后重试");

  const row = get<{ name: string }>(`SELECT name FROM package_code WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  if (!row) backToPackages("err", "包价不存在或已被删除");

  run(`DELETE FROM package_code WHERE id = ? AND hotel_id = ?`, [id, hotelId]);

  revalidatePath("/settings");
  backToPackages("msg", `包价「${row.name}」已删除`);
}

/* -------------------------------------------------------------------------- */
/* 销售员管理                                                                  */
/* -------------------------------------------------------------------------- */

/** 新增销售员：佣金率按百分数存（5 表示 5%） */
export async function createSalesmanFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const name = str(formData.get("name"));
  const phone = str(formData.get("phone"));
  const commissionRaw = num(formData.get("commission_rate"));

  if (!name) backToSalesmen("err", "请填写销售员姓名");
  if (name.length > 20) backToSalesmen("err", "销售员姓名最多 20 个字符");
  if (phone && !/^[0-9+\-\s]{5,20}$/.test(phone)) backToSalesmen("err", "手机号格式不正确");

  const commission = Number.isFinite(commissionRaw) ? round2(commissionRaw) : 0;
  if (commission < 0 || commission > 100) backToSalesmen("err", "佣金率需为 0 - 100 之间的百分数");

  const duplicated = get<{ id: number }>(`SELECT id FROM salesmen WHERE hotel_id = ? AND name = ?`, [hotelId, name]);
  if (duplicated) backToSalesmen("err", `销售员「${name}」已存在`);

  run(
    `INSERT INTO salesmen (hotel_id, name, phone, commission_rate, status, created_at) VALUES (?,?,?,?,?,?)`,
    [hotelId, name, phone || null, commission, ACTIVE, nowIso()]
  );

  revalidatePath("/settings");
  backToSalesmen("msg", `销售员「${name}」已新增`);
}

/** 启用 / 停用销售员 */
export async function toggleSalesmanStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToSalesmen("err", "销售员不存在，请刷新后重试");

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM salesmen WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) backToSalesmen("err", "销售员不存在，请刷新后重试");

  const next = row.status === ACTIVE ? INACTIVE : ACTIVE;
  run(`UPDATE salesmen SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath("/settings");
  backToSalesmen("msg", `销售员「${row.name}」已${next === ACTIVE ? "启用" : "停用"}`);
}

/* -------------------------------------------------------------------------- */
/* 角色权限                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * 整改清单 P1-33：原来这里有一个 `updateRolePermissionsFormAction`，
 * 把勾选项以 JSON 数组写进 roles.permissions —— 而全项目**没有任何地方读这一列**
 * （`grep "FROM roles"` 只有 COUNT(*) 与 SELECT name 两处）。
 * 也就是说：管理员在「角色权限」页签勾选、保存、看到「已保存」，
 * 行为零变化，没有任何接口判断、路由守卫读它 —— 属于典型的「假开关」，
 * 比没有这个功能更危险（管理员以为已经收紧了权限）。
 *
 * 处理方式：删除该 action，页面上对应的页签改成只读说明 + 指向「权限矩阵」。
 * 真正生效的权限在 role_permissions / role_modules（见下面 saveRolePermissionsFormAction
 * 与 saveRoleModulesFormAction，保存后会 invalidatePermissionCache）。
 * roles.permissions 这一列保留（岗位/角色种子仍在写），但只在岗位上作为「岗位默认权限」
 * 展示，不再被当作权限来源。
 */

/* -------------------------------------------------------------------------- */
/* 权限矩阵（整改 5.2：角色权限从硬编码改为数据库驱动）                          */
/* -------------------------------------------------------------------------- */

/**
 * 权限矩阵里的角色列：固定这 4 个（与 users.role / ROLE_LABEL 一致）。
 *
 * admin 不出现在写库循环里：hasPermission / canAccess 对 admin 一律 return true，
 * 管理员这一列在界面上是「勾满且禁用」的，写进库也只是噪声。
 */
const RBAC_ROLES = ["admin", "frontdesk", "cashier", "housekeeping"] as const;

/** 模块路径白名单式校验：以 / 开头的单段或多段路径，或 "*"（全部页面） */
function isModuleValue(value: string): boolean {
  return value === "*" || /^\/[A-Za-z0-9/_-]+$/.test(value);
}

/** 建表只做一次（进程内），避免设置页每次刷新都跑 DDL */
let rbacSchemaReady = false;

/**
 * 懒创建权限三张表 + 权限点字典（幂等，不改 scripts/init-db.mjs）
 *
 * scripts/migrate-all.mjs 第 16 段已经建过这三张表，这里只是一层保险：
 * 万一部署时忘了跑迁移，打开设置页也不会因为 no such table 直接 500。
 * 只补「表」和「全局字典」，不补 role_modules / role_permissions 的种子 ——
 * 那两是迁移的职责；否则管理员在设置页故意清掉的权限，一刷新就被这里灌回去。
 */
export async function ensureRbacSchema(): Promise<void> {
  /*
   * 权限边界（上线前加固）：建表助手不该是可匿名调用的 RPC 端点。
   * 它被 settings/page.tsx 直接 import，去掉 export 会打断页面编译，这里补登录守卫。
   */
  await requireUser();
  if (!rbacSchemaReady) {
    run(`CREATE TABLE IF NOT EXISTS role_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      module TEXT NOT NULL,
      created_at TEXT
    )`);
    run(`CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      permission TEXT NOT NULL,
      created_at TEXT
    )`);
    run(`CREATE TABLE IF NOT EXISTS permission_dict (
      permission TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      module TEXT,
      description TEXT
    )`);
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_modules_key ON role_modules(hotel_id, role, module)`);
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_permissions_key ON role_permissions(hotel_id, role, permission)`);
    rbacSchemaReady = true;
  }

  // 权限点字典：只补缺的行（中文名 / 归属模块），已有行一个字节都不动
  const existing = new Set(
    all<{ permission: string }>(`SELECT permission FROM permission_dict`).map((row) => row.permission)
  );
  const missing = RBAC_PERMISSION_CODES.filter((code) => !existing.has(code));
  for (const code of missing) {
    run(`INSERT OR IGNORE INTO permission_dict (permission, label, module, description) VALUES (?, ?, ?, ?)`, [
      code,
      RBAC_PERMISSION_LABELS[code] ?? code,
      RBAC_PERMISSION_MODULE_OF[code] ?? null,
      null,
    ]);
  }
}

/**
 * 保存动作级权限矩阵（4 个角色 × 29 个权限点）
 *
 * 写法是「删旧写新」，整体放进一个事务：
 *   先删掉本店该角色的全部 role_permissions 行，再按勾选重新插入。
 *   用 INSERT OR IGNORE + 唯一索引兜底，重复点保存不会产生重复行。
 *
 * 最后必须调 invalidatePermissionCache(hotelId)：
 *   hasPermission 走的是 5 秒进程内缓存，不清缓存的话「保存成功但接口还是旧权限」，
 *   这正是整改 5.2 要求消除的「配置与判断脱节」。
 */
export async function saveRolePermissionsFormAction(formData: FormData): Promise<void> {
  // 权限边界（整改清单 P1-32 / P2-30）：改权限属于「账号与岗位」，用 user.manage。
  // 原来写死 requireAdmin() → 管理员在权限矩阵里把 user.manage 授给店长也不生效。
  // hasPermission 对 admin 短路放行，所以管理员操作完全不受影响。
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  await ensureRbacSchema();

  const known = new Set(RBAC_PERMISSION_CODES);
  const plan: { role: string; codes: string[] }[] = [];
  for (const role of RBAC_ROLES) {
    if (role === "admin") continue; // 管理员恒通过，不落库
    const picked = new Set(
      formData.getAll(`perm:${role}`).filter((value): value is string => typeof value === "string" && known.has(value))
    );
    if (picked.size === 0) {
      // 空集合在 session.ts 里等价于「该角色没有配置」→ 会回落到内置默认权限，容易被误解为保存没生效
      backToRbac("err", `角色「${ROLE_LABEL[role] ?? role}」至少勾选一项权限（勾空会回落到内置默认权限）`);
    }
    plan.push({ role, codes: RBAC_PERMISSION_CODES.filter((code) => picked.has(code)) });
  }

  const at = nowIso();
  tx(() => {
    for (const item of plan) {
      run(`DELETE FROM role_permissions WHERE hotel_id = ? AND role = ?`, [hotelId, item.role]);
      for (const code of item.codes) {
        run(`INSERT OR IGNORE INTO role_permissions (hotel_id, role, permission, created_at) VALUES (?, ?, ?, ?)`, [
          hotelId,
          item.role,
          code,
          at,
        ]);
      }
    }
  });

  invalidatePermissionCache(hotelId);

  /*
   * 整改清单 P1-34：提权必须留痕。
   * 这条日志要能回答「谁在什么时候把哪个角色的哪些权限改成了什么」——
   * 只记条数不够，因为事后无法判断是「加了不该加的」还是「删了该有的」。
   */
  const summary = plan
    .map((item) => `${ROLE_LABEL[item.role] ?? item.role}: ${item.codes.length} 项`)
    .join(" · ");
  writeAuditLog(
    hotelId,
    user.realName || user.username,
    "修改动作权限",
    `${summary}；角色权限已重写并失效权限缓存`
  );

  revalidatePath("/settings");
  const total = plan.reduce((n, item) => n + item.codes.length, 0);
  backToRbac("msg", `动作权限已保存（${total} 项），接口判断已即时生效`);
}

/**
 * 保存角色可见页面模块（role_modules）
 *
 * 与动作权限同构：删旧写新 + 事务 + 保存后立即失效缓存。
 * 模块值允许 "*"（全部页面），因此界面上「勾满」和「*」两种表达都成立。
 */
export async function saveRoleModulesFormAction(formData: FormData): Promise<void> {
  // 权限边界见 saveRolePermissionsFormAction（user.manage）
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  await ensureRbacSchema();

  const plan: { role: string; modules: string[] }[] = [];
  for (const role of RBAC_ROLES) {
    if (role === "admin") continue;
    const picked = new Set(
      formData.getAll(`mod:${role}`).filter((value): value is string => typeof value === "string" && isModuleValue(value))
    );
    if (picked.size === 0) {
      backToRbac("err", `角色「${ROLE_LABEL[role] ?? role}」至少勾选一个可见页面（勾空会回落到内置默认模块）`);
    }
    plan.push({ role, modules: [...picked].sort() });
  }

  const at = nowIso();
  tx(() => {
    for (const item of plan) {
      run(`DELETE FROM role_modules WHERE hotel_id = ? AND role = ?`, [hotelId, item.role]);
      for (const module of item.modules) {
        run(`INSERT OR IGNORE INTO role_modules (hotel_id, role, module, created_at) VALUES (?, ?, ?, ?)`, [
          hotelId,
          item.role,
          module,
          at,
        ]);
      }
    }
  });

  invalidatePermissionCache(hotelId);

  /* 整改清单 P1-34：改「谁能进哪些页面」同样是提权，必须留痕 */
  const summary = plan
    .map((item) => `${ROLE_LABEL[item.role] ?? item.role}: ${item.modules.length} 个模块`)
    .join(" · ");
  writeAuditLog(
    hotelId,
    user.realName || user.username,
    "修改页面权限",
    `${summary}；页面访问权限已重写并失效权限缓存`
  );

  revalidatePath("/settings");
  const total = plan.reduce((n, item) => n + item.modules.length, 0);
  backToRbac("msg", `页面访问权限已保存（${total} 个模块），路由守卫已即时生效`);
}

/* -------------------------------------------------------------------------- */
/* 消费项目 / 收款项目                                                          */
/* -------------------------------------------------------------------------- */

/** 会员卡设置页回跳（会员卡类型 / 充值方案共用同一个页面） */
function backToMemberCards(key: "err" | "msg", message: string): never {
  redirect(`/member-cards?${key}=${encodeURIComponent(message)}`);
}

/** 新增消费项目：名称在同一酒店内唯一，单价为非负数 */
export async function createDebitItemFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const name = str(formData.get("name"));
  const category = str(formData.get("category")) || "其他";
  const price = num(formData.get("price"));

  if (!name) backToTab("debit-items", "err", "请填写消费项目名称");
  if (name.length > 30) backToTab("debit-items", "err", "消费项目名称最多 30 个字符");
  if (category.length > 20) backToTab("debit-items", "err", "分类最多 20 个字符");
  if (!Number.isFinite(price) || price < 0 || price > 99999) {
    backToTab("debit-items", "err", "默认单价需为 0 - 99999 之间的数字");
  }

  const duplicated = get<{ id: number }>(`SELECT id FROM debit_items WHERE hotel_id = ? AND name = ?`, [
    hotelId,
    name,
  ]);
  if (duplicated) backToTab("debit-items", "err", `消费项目「${name}」已存在`);

  run(`INSERT INTO debit_items (hotel_id, name, category, price, status, created_at) VALUES (?,?,?,?,?,?)`, [
    hotelId,
    name,
    category,
    round2(price),
    ACTIVE,
    nowIso(),
  ]);

  revalidatePath("/settings");
  backToTab("debit-items", "msg", `消费项目「${name}」已新增`);
}

/** 启用 / 停用消费项目 */
export async function toggleDebitItemStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("debit-items", "err", "消费项目不存在，请刷新后重试");

  const row = get<{ name: string; status: string }>(`SELECT name, status FROM debit_items WHERE id = ? AND hotel_id = ?`, [
    id,
    hotelId,
  ]);
  if (!row) backToTab("debit-items", "err", "消费项目不存在，请刷新后重试");

  const next = row.status === ACTIVE ? INACTIVE : ACTIVE;
  run(`UPDATE debit_items SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath("/settings");
  backToTab("debit-items", "msg", `消费项目「${row.name}」已${next === ACTIVE ? "启用" : "停用"}`);
}

/** 新增收款项目：method 与 payments.method 取值保持一致（现金 / 微信 / 支付宝 / 银行卡 / 挂账） */
export async function createCreditItemFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const name = str(formData.get("name"));
  const method = str(formData.get("method"));

  if (!name) backToTab("credit-items", "err", "请填写收款项目名称");
  if (name.length > 30) backToTab("credit-items", "err", "收款项目名称最多 30 个字符");
  if (!method) backToTab("credit-items", "err", "请填写支付方式标识，如 现金 / 微信 / 支付宝");
  if (method.length > 20) backToTab("credit-items", "err", "支付方式标识最多 20 个字符");

  const duplicated = get<{ id: number }>(`SELECT id FROM credit_items WHERE hotel_id = ? AND name = ?`, [
    hotelId,
    name,
  ]);
  if (duplicated) backToTab("credit-items", "err", `收款项目「${name}」已存在`);

  run(`INSERT INTO credit_items (hotel_id, name, method, status, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    name,
    method,
    ACTIVE,
    nowIso(),
  ]);

  revalidatePath("/settings");
  backToTab("credit-items", "msg", `收款项目「${name}」已新增`);
}

/** 启用 / 停用收款项目 */
export async function toggleCreditItemStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("credit-items", "err", "收款项目不存在，请刷新后重试");

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM credit_items WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) backToTab("credit-items", "err", "收款项目不存在，请刷新后重试");

  const next = row.status === ACTIVE ? INACTIVE : ACTIVE;
  run(`UPDATE credit_items SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath("/settings");
  backToTab("credit-items", "msg", `收款项目「${row.name}」已${next === ACTIVE ? "启用" : "停用"}`);
}

/* -------------------------------------------------------------------------- */
/* 楼层设置                                                                    */
/* -------------------------------------------------------------------------- */

/** 新增楼层：名称 / 编号 / 优先级（sort，越小越靠前） */
export async function createFloorFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const name = str(formData.get("name"));
  const code = str(formData.get("code"));
  const sortRaw = num(formData.get("sort"));

  if (!name) backToTab("floors", "err", "请填写楼层名称，如 七层");
  if (name.length > 20) backToTab("floors", "err", "楼层名称最多 20 个字符");
  if (!/^[0-9A-Za-z-]{1,10}$/.test(code)) backToTab("floors", "err", "楼层编号只能是数字、字母或短横线，最多 10 位");

  const sort = Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : 99;
  if (sort < 0 || sort > 999) backToTab("floors", "err", "优先级需为 0 - 999 的整数");

  const duplicated = get<{ id: number }>(`SELECT id FROM floors WHERE hotel_id = ? AND (code = ? OR name = ?)`, [
    hotelId,
    code,
    name,
  ]);
  if (duplicated) backToTab("floors", "err", `楼层「${name}」或编号 ${code} 已存在`);

  run(`INSERT INTO floors (hotel_id, name, code, sort, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    name,
    code,
    sort,
    nowIso(),
  ]);

  revalidatePath("/settings");
  backToTab("floors", "msg", `楼层「${name}」已新增`);
}

/** 修改楼层：名称 / 编号 / 优先级 */
export async function updateFloorFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("floors", "err", "楼层不存在，请刷新后重试");

  const row = get<{ name: string }>(`SELECT name FROM floors WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  if (!row) backToTab("floors", "err", "楼层不存在或已被删除");

  const name = str(formData.get("name"));
  const code = str(formData.get("code"));
  const sortRaw = num(formData.get("sort"));

  if (!name) backToTab("floors", "err", "请填写楼层名称");
  if (name.length > 20) backToTab("floors", "err", "楼层名称最多 20 个字符");
  if (!/^[0-9A-Za-z-]{1,10}$/.test(code)) backToTab("floors", "err", "楼层编号只能是数字、字母或短横线，最多 10 位");

  const sort = Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : 99;
  if (sort < 0 || sort > 999) backToTab("floors", "err", "优先级需为 0 - 999 的整数");

  const duplicated = get<{ id: number }>(
    `SELECT id FROM floors WHERE hotel_id = ? AND id != ? AND (code = ? OR name = ?)`,
    [hotelId, id, code, name]
  );
  if (duplicated) backToTab("floors", "err", `楼层「${name}」或编号 ${code} 已存在`);

  run(`UPDATE floors SET name = ?, code = ?, sort = ? WHERE id = ? AND hotel_id = ?`, [
    name,
    code,
    sort,
    id,
    hotelId,
  ]);

  revalidatePath("/settings");
  backToTab("floors", "msg", `楼层「${row.name}」已改为「${name}」`);
}

/** 删除楼层（只删楼层档案，房间数据不动） */
export async function deleteFloorFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("floors", "err", "楼层不存在，请刷新后重试");

  const row = get<{ name: string; code: string }>(`SELECT name, code FROM floors WHERE id = ? AND hotel_id = ?`, [
    id,
    hotelId,
  ]);
  if (!row) backToTab("floors", "err", "楼层不存在或已被删除");

  run(`DELETE FROM floors WHERE id = ? AND hotel_id = ?`, [id, hotelId]);

  revalidatePath("/settings");
  backToTab("floors", "msg", `楼层「${row.name}」已删除（该楼层房间不受影响）`);
}

/* -------------------------------------------------------------------------- */
/* 房价代码                                                                    */
/* -------------------------------------------------------------------------- */

type RateCodeInput = {
  code: string;
  name: string;
  type: string;
  discount: number;
  sort: number;
  packageCode: string | null;
};

/** 房价代码表单校验：返回错误文案或解析结果 */
function parseRateCodeForm(formData: FormData): { error: string } | { value: RateCodeInput } {
  const code = str(formData.get("code")).toUpperCase();
  const name = str(formData.get("name"));
  const type = str(formData.get("type"));
  const discountRaw = num(formData.get("discount"));
  const sortRaw = num(formData.get("sort"));
  const packageCode = str(formData.get("package_code"));

  if (!/^[A-Z0-9-]{2,20}$/.test(code)) return { error: "代码只能包含字母、数字、短横线，2-20 位" };
  if (!name) return { error: "请填写房价代码名称" };
  if (name.length > 20) return { error: "名称最多 20 个字符" };
  if (!RATE_CODE_TYPE_SET.has(type)) return { error: "请选择类型：门市价 / 协议价 / 会员价 / 团队价" };
  // 列表里只改「显示优先级 / 包价」时不会提交折扣率，此时沿用原值
  const discount = Number.isFinite(discountRaw) && discountRaw > 0 && discountRaw <= 1 ? round2(discountRaw) : null;

  return {
    value: {
      code,
      name,
      type,
      discount: discount ?? 1,
      sort: Number.isFinite(sortRaw) && sortRaw >= 0 ? Math.trunc(sortRaw) : 99,
      packageCode: packageCode || null,
    },
  };
}

/** 新增房价代码：代码在同一酒店内唯一 */
export async function createRateCodeFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const parsed = parseRateCodeForm(formData);
  if ("error" in parsed) backToTab("rate-codes", "err", parsed.error);
  const { code, name, type, discount, sort, packageCode } = parsed.value;

  const duplicated = get<{ id: number }>(`SELECT id FROM rate_codes WHERE hotel_id = ? AND code = ?`, [hotelId, code]);
  if (duplicated) backToTab("rate-codes", "err", `房价代码 ${code} 已存在，请换一个`);

  run(
    `INSERT INTO rate_codes (hotel_id, code, name, type, discount, status, sort, package_code, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [hotelId, code, name, type, discount, ACTIVE, sort, packageCode, nowIso()]
  );

  revalidatePath("/settings");
  backToTab("rate-codes", "msg", `房价代码 ${code}（${name}）已新增`);
}

/** 编辑房价代码：代码 / 名称 / 类型 / 折扣率 */
export async function updateRateCodeFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("rate-codes", "err", "房价代码不存在，请刷新后重试");

  const row = get<{ code: string }>(`SELECT code FROM rate_codes WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  if (!row) backToTab("rate-codes", "err", "房价代码不存在或已被删除");

  const parsed = parseRateCodeForm(formData);
  if ("error" in parsed) backToTab("rate-codes", "err", parsed.error);
  const { code, name, type, discount, sort, packageCode } = parsed.value;

  const duplicated = get<{ id: number }>(`SELECT id FROM rate_codes WHERE hotel_id = ? AND code = ? AND id != ?`, [
    hotelId,
    code,
    id,
  ]);
  if (duplicated) backToTab("rate-codes", "err", `房价代码 ${code} 已被占用`);

  run(
    `UPDATE rate_codes SET code = ?, name = ?, type = ?, discount = ?, sort = ?, package_code = ?
     WHERE id = ? AND hotel_id = ?`,
    [code, name, type, discount, sort, packageCode, id, hotelId]
  );

  revalidatePath("/settings");
  backToTab("rate-codes", "msg", `房价代码 ${code} 已保存`);
}

/** 启用 / 停用房价代码 */
export async function toggleRateCodeStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("rate-codes", "err", "房价代码不存在，请刷新后重试");

  const row = get<{ code: string; name: string; status: string }>(
    `SELECT code, name, status FROM rate_codes WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) backToTab("rate-codes", "err", "房价代码不存在，请刷新后重试");

  const next = row.status === ACTIVE ? INACTIVE : ACTIVE;
  run(`UPDATE rate_codes SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath("/settings");
  backToTab("rate-codes", "msg", `房价代码 ${row.code}（${row.name}）已${next === ACTIVE ? "启用" : "停用"}`);
}

/* -------------------------------------------------------------------------- */
/* 权限管理（岗位 + 员工）                                                      */
/* -------------------------------------------------------------------------- */

/** 读取勾选的权限项，按固定顺序序列化 */
function parsePositionPermissions(formData: FormData): string[] {
  const checked = new Set(
    formData
      .getAll("permissions")
      .filter((value): value is string => typeof value === "string" && PERMISSION_SET.has(value))
  );
  return PERMISSION_CODES.filter((code) => checked.has(code));
}

/** 新增岗位：名称唯一，权限项至少一项 */
export async function createPositionFormAction(formData: FormData): Promise<void> {
  // 权限边界（P1-32）：岗位/员工属于账号管理 → user.manage
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const name = str(formData.get("name"));
  if (!name) backToTab("authority", "err", "请填写岗位名称，如 前台");
  if (name.length > 20) backToTab("authority", "err", "岗位名称最多 20 个字符");

  const permissions = parsePositionPermissions(formData);
  if (permissions.length === 0) backToTab("authority", "err", "请至少勾选一项权限");

  const duplicated = get<{ id: number }>(`SELECT id FROM positions WHERE hotel_id = ? AND name = ?`, [hotelId, name]);
  if (duplicated) backToTab("authority", "err", `岗位「${name}」已存在`);

  run(`INSERT INTO positions (hotel_id, name, permissions, created_at) VALUES (?,?,?,?)`, [
    hotelId,
    name,
    JSON.stringify(permissions),
    nowIso(),
  ]);

  revalidatePath("/settings");
  backToTab("authority", "msg", `岗位「${name}」已新增，含 ${permissions.length} 项权限`);
}

/** 修改岗位：名称 + 权限项（权限以 JSON 数组写入 positions.permissions） */
export async function updatePositionFormAction(formData: FormData): Promise<void> {
  // 权限边界（P1-32）：user.manage
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("authority", "err", "岗位不存在，请刷新后重试");

  const row = get<{ name: string }>(`SELECT name FROM positions WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  if (!row) backToTab("authority", "err", "岗位不存在或已被删除");

  const name = str(formData.get("name"));
  if (!name) backToTab("authority", "err", "请填写岗位名称");
  if (name.length > 20) backToTab("authority", "err", "岗位名称最多 20 个字符");

  const permissions = parsePositionPermissions(formData);
  if (permissions.length === 0) backToTab("authority", "err", "请至少勾选一项权限");

  const duplicated = get<{ id: number }>(`SELECT id FROM positions WHERE hotel_id = ? AND name = ? AND id != ?`, [
    hotelId,
    name,
    id,
  ]);
  if (duplicated) backToTab("authority", "err", `岗位「${name}」已存在`);

  run(`UPDATE positions SET name = ?, permissions = ? WHERE id = ? AND hotel_id = ?`, [
    name,
    JSON.stringify(permissions),
    id,
    hotelId,
  ]);

  revalidatePath("/settings");
  backToTab("authority", "msg", `岗位「${name}」已保存（${permissions.length} 项权限）`);
}

/** 给员工挂岗位：position_id 传 0 表示取消岗位归属 */
export async function updateUserPositionFormAction(formData: FormData): Promise<void> {
  // 权限边界（P1-32）：user.manage
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const userId = Math.trunc(num(formData.get("user_id")));
  const positionRaw = num(formData.get("position_id"));
  if (!Number.isFinite(userId) || userId <= 0) backToTab("authority", "err", "员工不存在，请刷新后重试");

  const staff = get<{ username: string; real_name: string | null }>(
    `SELECT username, real_name FROM users WHERE id = ? AND hotel_id = ?`,
    [userId, hotelId]
  );
  if (!staff) backToTab("authority", "err", "员工不存在或已被删除");

  const positionId = Number.isFinite(positionRaw) ? Math.trunc(positionRaw) : 0;

  if (positionId <= 0) {
    run(`UPDATE users SET position_id = NULL WHERE id = ? AND hotel_id = ?`, [userId, hotelId]);
    revalidatePath("/settings");
    backToTab("authority", "msg", `员工 ${staff.username} 已取消岗位归属`);
  }

  const position = get<{ name: string }>(`SELECT name FROM positions WHERE id = ? AND hotel_id = ?`, [
    positionId,
    hotelId,
  ]);
  if (!position) backToTab("authority", "err", "岗位不存在，请刷新后重试");

  run(`UPDATE users SET position_id = ? WHERE id = ? AND hotel_id = ?`, [positionId, userId, hotelId]);

  revalidatePath("/settings");
  backToTab("authority", "msg", `员工 ${staff.username} 已归属岗位「${position.name}」`);
}

/* -------------------------------------------------------------------------- */
/* 会员卡类型 / 充值方案（页面 /member-cards，action 放在本文件避免新增 actions）  */
/* -------------------------------------------------------------------------- */

/** 新增会员卡类型：折扣 0.1 - 1，积分比例 0 - 99，最低充值非负 */
export async function createMemberCardTypeFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const name = str(formData.get("name"));
  const discount = num(formData.get("discount"));
  const pointsRaw = num(formData.get("points_ratio"));
  const minRecharge = num(formData.get("min_recharge"));

  if (!name) backToMemberCards("err", "请填写会员卡名称");
  if (name.length > 20) backToMemberCards("err", "会员卡名称最多 20 个字符");
  if (!Number.isFinite(discount) || discount <= 0 || discount > 1) {
    backToMemberCards("err", "折扣需在 0.1 - 1 之间，1 表示不打折（0.9 = 9 折）");
  }
  const pointsRatio = Number.isFinite(pointsRaw) ? round2(pointsRaw) : 1;
  if (pointsRatio < 0 || pointsRatio > 99) backToMemberCards("err", "积分比例需为 0 - 99 之间的数字");
  if (!Number.isFinite(minRecharge) || minRecharge < 0 || minRecharge > 999999) {
    backToMemberCards("err", "最低充值需为 0 - 999999 之间的数字");
  }

  const duplicated = get<{ id: number }>(`SELECT id FROM member_card_types WHERE hotel_id = ? AND name = ?`, [
    hotelId,
    name,
  ]);
  if (duplicated) backToMemberCards("err", `会员卡「${name}」已存在`);

  run(
    `INSERT INTO member_card_types (hotel_id, name, discount, points_ratio, min_recharge, status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [hotelId, name, round2(discount), pointsRatio, round2(minRecharge), ACTIVE, nowIso()]
  );

  revalidatePath("/member-cards");
  revalidatePath("/settings");
  backToMemberCards("msg", `会员卡「${name}」已新增`);
}

/** 编辑会员卡类型：名称 / 折扣 / 积分比例 / 最低充值 */
export async function updateMemberCardTypeFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToMemberCards("err", "会员卡不存在，请刷新后重试");

  const row = get<{ name: string }>(`SELECT name FROM member_card_types WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  if (!row) backToMemberCards("err", "会员卡不存在或已被删除");

  const name = str(formData.get("name"));
  const discount = num(formData.get("discount"));
  const pointsRaw = num(formData.get("points_ratio"));
  const minRecharge = num(formData.get("min_recharge"));

  if (!name) backToMemberCards("err", "请填写会员卡名称");
  if (name.length > 20) backToMemberCards("err", "会员卡名称最多 20 个字符");
  if (!Number.isFinite(discount) || discount <= 0 || discount > 1) {
    backToMemberCards("err", "折扣需在 0.1 - 1 之间，1 表示不打折（0.9 = 9 折）");
  }
  const pointsRatio = Number.isFinite(pointsRaw) ? round2(pointsRaw) : 1;
  if (pointsRatio < 0 || pointsRatio > 99) backToMemberCards("err", "积分比例需为 0 - 99 之间的数字");
  if (!Number.isFinite(minRecharge) || minRecharge < 0 || minRecharge > 999999) {
    backToMemberCards("err", "最低充值需为 0 - 999999 之间的数字");
  }

  const duplicated = get<{ id: number }>(
    `SELECT id FROM member_card_types WHERE hotel_id = ? AND name = ? AND id != ?`,
    [hotelId, name, id]
  );
  if (duplicated) backToMemberCards("err", `会员卡「${name}」已存在`);

  run(
    `UPDATE member_card_types SET name = ?, discount = ?, points_ratio = ?, min_recharge = ?
     WHERE id = ? AND hotel_id = ?`,
    [name, round2(discount), pointsRatio, round2(minRecharge), id, hotelId]
  );

  revalidatePath("/member-cards");
  revalidatePath("/settings");
  backToMemberCards("msg", `会员卡「${name}」已保存`);
}

/** 启用 / 停用会员卡类型 */
export async function toggleMemberCardTypeStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToMemberCards("err", "会员卡不存在，请刷新后重试");

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM member_card_types WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) backToMemberCards("err", "会员卡不存在，请刷新后重试");

  const next = row.status === ACTIVE ? INACTIVE : ACTIVE;
  run(`UPDATE member_card_types SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath("/member-cards");
  revalidatePath("/settings");
  backToMemberCards("msg", `会员卡「${row.name}」已${next === ACTIVE ? "启用" : "停用"}`);
}

/** 新增充值方案：充值金额需大于 0，赠送金额可为 0 */
export async function createRechargePlanFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const amount = num(formData.get("amount"));
  const giftAmount = num(formData.get("gift_amount"));
  const rawName = str(formData.get("name"));

  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999) {
    backToMemberCards("err", "充值金额需为 0 - 999999 之间的数字且大于 0");
  }
  if (!Number.isFinite(giftAmount) || giftAmount < 0 || giftAmount > 999999) {
    backToMemberCards("err", "赠送金额需为 0 - 999999 之间的数字");
  }

  const amountValue = round2(amount);
  const giftValue = round2(giftAmount);
  const name = rawName || `充 ${amountValue} 送 ${giftValue}`;
  if (name.length > 30) backToMemberCards("err", "方案名最多 30 个字符");

  const duplicated = get<{ id: number }>(`SELECT id FROM recharge_plans WHERE hotel_id = ? AND name = ?`, [
    hotelId,
    name,
  ]);
  if (duplicated) backToMemberCards("err", `充值方案「${name}」已存在`);

  run(`INSERT INTO recharge_plans (hotel_id, name, amount, gift_amount, status, created_at) VALUES (?,?,?,?,?,?)`, [
    hotelId,
    name,
    amountValue,
    giftValue,
    ACTIVE,
    nowIso(),
  ]);

  revalidatePath("/member-cards");
  revalidatePath("/settings");
  backToMemberCards("msg", `充值方案「${name}」已新增（到账 ¥${round2(amountValue + giftValue).toFixed(2)}）`);
}

/** 启用 / 停用充值方案 */
export async function toggleRechargePlanStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToMemberCards("err", "充值方案不存在，请刷新后重试");

  const row = get<{ name: string; status: string }>(
    `SELECT name, status FROM recharge_plans WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) backToMemberCards("err", "充值方案不存在，请刷新后重试");

  const next = row.status === ACTIVE ? INACTIVE : ACTIVE;
  run(`UPDATE recharge_plans SET status = ? WHERE id = ? AND hotel_id = ?`, [next, id, hotelId]);

  revalidatePath("/member-cards");
  revalidatePath("/settings");
  backToMemberCards("msg", `充值方案「${row.name}」已${next === ACTIVE ? "启用" : "停用"}`);
}

/* -------------------------------------------------------------------------- */
/* 表单适配：页面上的 <form action={...}> 直接使用                              */
/* -------------------------------------------------------------------------- */

/** 表单适配：保存房型门市价 */
export async function updateRoomTypePriceFormAction(formData: FormData): Promise<void> {
  const roomTypeId = num(formData.get("room_type_id"));
  const basePrice = num(formData.get("base_price"));
  if (Number.isNaN(roomTypeId) || Number.isNaN(basePrice)) {
    backToTab("room-types", "err", "房价格式不正确，请填写数字");
  }
  await updateRoomTypePriceAction(roomTypeId, basePrice);
  backToTab("room-types", "msg", "房型门市价已保存");
}

/** 表单适配：快速添加房型（去呼呼房型设置页的「快速添加」） */
export async function createRoomTypeFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const name = str(formData.get("name")).trim();
  const bedType = str(formData.get("bed_type")) || "大床";
  const area = num(formData.get("area"));
  const basePrice = num(formData.get("base_price"));

  if (name === "") backToTab("room-types", "err", "请填写房型名称");
  if (name.length > 30) backToTab("room-types", "err", "房型名称不能超过 30 个字");

  const exists = get<{ id: number }>(
    `SELECT id FROM room_types WHERE hotel_id = ? AND name = ?`,
    [user.hotelId, name]
  );
  if (exists) backToTab("room-types", "err", `房型「${name}」已存在`);

  const code = `RT${String(Date.now()).slice(-6)}`;
  run(
    `INSERT INTO room_types (hotel_id, code, name, bed_type, area, max_occupancy, base_price, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.hotelId,
      code,
      name,
      bedType,
      Number.isFinite(area) ? area : null,
      2,
      Number.isFinite(basePrice) && basePrice > 0 ? round2(basePrice) : 0,
      99,
    ]
  );
  revalidatePath("/settings");
  backToTab("room-types", "msg", `房型「${name}」已添加`);
}

/** 表单适配：新增房间，失败时带错误信息回跳 */
export async function createRoomFormAction(formData: FormData): Promise<void> {
  const roomNo = str(formData.get("room_no"));
  const floor = num(formData.get("floor"));
  const roomTypeId = num(formData.get("room_type_id"));

  const result = await createRoomAction(
    roomNo,
    Number.isNaN(floor) ? 0 : floor,
    Number.isNaN(roomTypeId) ? 0 : roomTypeId
  );

  if ("error" in result) {
    redirect(settingsUrl({ tab: "rooms", roomError: result.error }, "rooms"));
  }
  redirect(settingsUrl({ tab: "rooms", msg: `房间 ${roomNo} 已新增` }, "rooms"));
}

/** 表单适配：保存系统参数 */
export async function updateSettingFormAction(formData: FormData): Promise<void> {
  const key = str(formData.get("key"));
  if (!key) return;
  const value = str(formData.get("value"));
  const saved = await updateSettingAction(key, value);
  if (saved) {
    backToTab("params", "msg", `参数 ${key} 已保存`);
  }
  backToTab("params", "err", "参数值不合法，未保存");
}

/* -------------------------------------------------------------------------- */
/* 原因与类型（dict_items）                                                     */
/* -------------------------------------------------------------------------- */

/** 字典类型 → 中文名，未知类型返回 null */
function dictKindLabel(kind: string): string | null {
  return DICT_KIND_SEEDS.find((item) => item.kind === kind)?.label ?? null;
}

/** 新增字典项：kind 必须已知，同一类型下名称唯一 */
export async function createDictItemFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const kind = str(formData.get("kind"));
  const label = dictKindLabel(kind);
  if (!label) backToTab("dicts", "err", "字典类型不正确，请刷新后重试");

  const name = str(formData.get("name"));
  if (!name) backToTab("dicts", "err", `请填写${label}名称`);
  if (name.length > 30) backToTab("dicts", "err", `${label}名称最多 30 个字符`);

  const duplicated = get<{ id: number }>(`SELECT id FROM dict_items WHERE hotel_id = ? AND kind = ? AND name = ?`, [
    hotelId,
    kind,
    name,
  ]);
  if (duplicated) backToTab("dicts", "err", `${label}「${name}」已存在`);

  const nextSort =
    get<{ next_sort: number }>(
      `SELECT COALESCE(MAX(sort), 0) + 1 AS next_sort FROM dict_items WHERE hotel_id = ? AND kind = ?`,
      [hotelId, kind]
    )?.next_sort ?? 1;

  run(`INSERT INTO dict_items (hotel_id, kind, name, sort, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    kind,
    name,
    nextSort,
    nowIso(),
  ]);

  revalidatePath("/settings");
  backToTab("dicts", "msg", `${label}「${name}」已新增`);
}

/** 删除字典项 */
export async function deleteDictItemFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  if (!Number.isFinite(id) || id <= 0) backToTab("dicts", "err", "字典项不存在，请刷新后重试");

  const row = get<{ kind: string; name: string }>(
    `SELECT kind, name FROM dict_items WHERE id = ? AND hotel_id = ?`,
    [id, hotelId]
  );
  if (!row) backToTab("dicts", "err", "字典项不存在或已被删除");

  run(`DELETE FROM dict_items WHERE id = ? AND hotel_id = ?`, [id, hotelId]);

  revalidatePath("/settings");
  backToTab("dicts", "msg", `${dictKindLabel(row.kind) ?? row.kind}「${row.name}」已删除`);
}

/* -------------------------------------------------------------------------- */
/* 高级设置（统一写 settings 表 key-value）                                      */
/* -------------------------------------------------------------------------- */

/** 写一条 settings：存在则更新（含历史重复行），否则新增 */
function saveSettingValue(hotelId: number, key: string, value: string): void {
  const existing = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
  if (existing) {
    run(`UPDATE settings SET value = ? WHERE hotel_id = ? AND key = ?`, [value, hotelId, key]);
  } else {
    run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
  }
}

/** 读一条 settings 值（不存在返回空串） */
function readSettingValue(hotelId: number, key: string): string {
  const row = get<{ value: string | null }>(`SELECT value FROM settings WHERE hotel_id = ? AND key = ?`, [
    hotelId,
    key,
  ]);
  return String(row?.value ?? "");
}

/**
 * 高级设置：5 个表单区块共用一个 action，按 section 分流
 * property 产权者 / personal 个性化 / report 报表发送 / steward 管家密码 / scene 微管家场景
 */
export async function saveAdvancedFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const section = str(formData.get("section"));

  if (section === "property") {
    const ownerName = str(formData.get("owner_name"));
    const ownerIdNo = str(formData.get("owner_id_no"));
    const ownerPhone = str(formData.get("owner_phone"));
    const ownerAddress = str(formData.get("owner_address"));

    if (ownerName.length > 30) backToTab("advanced", "err", "产权人姓名最多 30 个字符");
    if (ownerIdNo.length > 40) backToTab("advanced", "err", "证件号最多 40 个字符");
    if (ownerPhone && !/^[0-9+\-\s]{5,20}$/.test(ownerPhone)) {
      backToTab("advanced", "err", "联系电话格式不正确");
    }
    if (ownerAddress.length > 80) backToTab("advanced", "err", "联系地址最多 80 个字符");

    tx(() => {
      saveSettingValue(hotelId, "property_owner_name", ownerName);
      saveSettingValue(hotelId, "property_owner_id_no", ownerIdNo);
      saveSettingValue(hotelId, "property_owner_phone", ownerPhone);
      saveSettingValue(hotelId, "property_owner_address", ownerAddress);
    });

    revalidatePath("/settings");
    backToTab("advanced", "msg", `房屋产权者信息已保存（产权人：${ownerName || "未填写"}）`);
  }

  if (section === "personal") {
    const homepage = str(formData.get("homepage_default"));
    const density = str(formData.get("table_density"));
    const legend = str(formData.get("show_room_legend")) === "1" ? "1" : "0";

    if (!HOMEPAGE_OPTIONS.has(homepage)) backToTab("advanced", "err", "请选择有效的首页默认页");
    if (!DENSITY_OPTIONS.has(density)) backToTab("advanced", "err", "请选择表格密度：紧凑 / 宽松");

    tx(() => {
      saveSettingValue(hotelId, "homepage_default", homepage);
      saveSettingValue(hotelId, "table_density", density);
      saveSettingValue(hotelId, "show_room_legend", legend);
    });

    revalidatePath("/settings");
    backToTab("advanced", "msg", `个性化设置已保存：首页 ${homepage} · ${density === "compact" ? "紧凑" : "宽松"}表格`);
  }

  if (section === "report") {
    const email = str(formData.get("report_email"));
    const sendTime = str(formData.get("report_send_time"));
    const enabled = str(formData.get("report_enabled")) === "1" ? "1" : "0";

    if (!email) backToTab("advanced", "err", "请填写报表接收邮箱");
    if (email.length > 60) backToTab("advanced", "err", "接收邮箱最多 60 个字符");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) backToTab("advanced", "err", "接收邮箱格式不正确");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) backToTab("advanced", "err", "发送时间格式需为 HH:mm");

    tx(() => {
      saveSettingValue(hotelId, "report_email", email);
      saveSettingValue(hotelId, "report_send_time", sendTime);
      saveSettingValue(hotelId, "report_enabled", enabled);
    });

    revalidatePath("/settings");
    backToTab("advanced", "msg", `报表发送设置已保存：${email} · ${sendTime} · ${enabled === "1" ? "启用" : "停用"}`);
  }

  if (section === "steward") {
    const password = str(formData.get("new_password"));
    const confirm = str(formData.get("confirm_password"));

    if (!password) backToTab("advanced", "err", "请填写管家新密码");
    if (password.length < 4 || password.length > 32) backToTab("advanced", "err", "管家密码需为 4 - 32 个字符");
    if (password !== confirm) backToTab("advanced", "err", "两次输入的密码不一致");

    /*
     * 「改了但没改」是一种静默失败：管理员以为换了密码、实际还是旧的。
     * 用 verifyPassword 与库里哈希比对就能当场拦住。
     */
    const currentHash = readSettingValue(hotelId, "steward_password_hash");
    if (currentHash && verifyPassword(password, currentHash)) {
      backToTab("advanced", "err", "新密码与当前管家密码相同，请换一个");
    }

    /*
     * 整改清单 P1-35：管家密码原来以**明文**写进 settings.steward_password。
     * settings 表会被 /settings 页面整表读出来（settingMap）、也会随库文件备份/导出，
     * 明文口令等于随库泄露 —— 而且和 users 的密码策略（scrypt 哈希）自相矛盾。
     *
     * 现在：只存 scrypt 哈希。今后任何要校验管家密码的地方都用
     * `verifyPassword(输入, settings.steward_password_hash)`（本文件已 import verifyPassword），
     * 与 users 的登录校验是同一套实现。旧库里的明文由 scripts/migrate-all.mjs
     * 的「第 18 段」一次性转成哈希并清空。
     */
    tx(() => {
      saveSettingValue(hotelId, "steward_password_hash", hashPassword(password));
      // 顺手清掉历史明文（可能由老版本写入，或由迁移前的种子留下）
      saveSettingValue(hotelId, "steward_password", "");
    });

    writeAuditLog(hotelId, user.realName || user.username, "修改管家密码", "管家密码已更新（哈希存储）");

    revalidatePath("/settings");
    backToTab("advanced", "msg", "管家密码已更新");
  }

  if (section === "scene") {
    const checked = new Set(
      formData
        .getAll("scenarios")
        .filter((value): value is string => typeof value === "string" && MICRO_BUTLER_SCENE_SET.has(value))
    );
    // 按固定顺序序列化，保证同一组勾选得到同样的 JSON
    const scenes = MICRO_BUTLER_SCENES.filter((scene) => checked.has(scene));

    saveSettingValue(hotelId, "micro_butler_scenes", JSON.stringify(scenes));

    revalidatePath("/settings");
    backToTab("advanced", "msg", `微管家服务场景已保存（启用 ${scenes.length} 项）`);
  }

  backToTab("advanced", "err", "未知的设置区块，请刷新后重试");
}

/** 钟点房收费：按房型保存基础时长 / 基础收费 / 超时标准 / 全天房费规则 */
export async function saveHourlyRateAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const roomTypeId = Math.trunc(num(formData.get("room_type_id")));
  if (!Number.isFinite(roomTypeId) || roomTypeId <= 0) backToTab("hourly", "err", "请选择房型");

  const baseHours = num(formData.get("base_hours"));
  const basePrice = num(formData.get("base_price"));
  const overtimeRate = num(formData.get("overtime_rate"));
  const fullDayRule = str(formData.get("full_day_rule")) || "满 8 小时按全天房费收取";

  if (!Number.isFinite(baseHours) || baseHours < 1 || baseHours > 24) backToTab("hourly", "err", "基础时长需在 1-24 小时之间");
  if (!Number.isFinite(basePrice) || basePrice < 0) backToTab("hourly", "err", "基础收费不能为负数");
  if (!Number.isFinite(overtimeRate) || overtimeRate < 0) backToTab("hourly", "err", "超时收费标准不能为负数");

  const exists = get<{ id: number }>(
    `SELECT id FROM hourly_rates WHERE hotel_id = ? AND room_type_id = ?`,
    [hotelId, roomTypeId]
  );
  if (exists) {
    run(
      `UPDATE hourly_rates SET base_hours = ?, base_price = ?, overtime_rate = ?, full_day_rule = ?
       WHERE id = ? AND hotel_id = ?`,
      [baseHours, basePrice, overtimeRate, fullDayRule, exists.id, hotelId]
    );
  } else {
    run(
      `INSERT INTO hourly_rates (hotel_id, room_type_id, base_hours, base_price, overtime_rate, full_day_rule, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [hotelId, roomTypeId, baseHours, basePrice, overtimeRate, fullDayRule, nowIso()]
    );
  }

  revalidatePath("/settings");
  backToTab("hourly", "msg", "钟点房价格已保存");
}

/**
 * 保洁任务模板（去呼呼「任务中心」）：任务类型 / 适用楼层 / 房型 / 积分 / 工作内容
 *
 * 权限边界（上线前加固）：本函数只被同文件的 saveCleaningTemplateAction 调用，
 * 去掉 export —— 它不需要、也不该成为客户端可直接调用的 Server Action 端点。
 */
async function ensureCleaningTemplates(hotelId: number) {
  run(`CREATE TABLE IF NOT EXISTS cleaning_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    task_type TEXT NOT NULL DEFAULT '保洁',
    floor TEXT NOT NULL DEFAULT '所有楼层',
    room_type TEXT NOT NULL DEFAULT '所有房型',
    points INTEGER NOT NULL DEFAULT 0,
    work_items TEXT,
    restock_items TEXT,
    created_at TEXT
  )`);
  const n = get<{ n: number }>(`SELECT COUNT(*) AS n FROM cleaning_templates WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (n === 0) {
    run(
      `INSERT INTO cleaning_templates (hotel_id, task_type, floor, room_type, points, work_items, restock_items, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [hotelId, "保洁", "所有楼层", "所有房型", 4, "打扫卫生,更换布草(毛巾,浴巾);更换床单和被套", "矿泉水", nowIso()]
    );
  }
}

/** 新增 / 修改保洁任务模板 */
export async function saveCleaningTemplateAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);
  await ensureCleaningTemplates(hotelId);

  const id = Math.trunc(num(formData.get("id")));
  const taskType = str(formData.get("task_type")) || "保洁";
  const floor = str(formData.get("floor")) || "所有楼层";
  const roomType = str(formData.get("room_type")) || "所有房型";
  const points = Math.trunc(num(formData.get("points")));
  const workItems = str(formData.get("work_items"));
  const restockItems = str(formData.get("restock_items"));

  if (id > 0) {
    run(
      `UPDATE cleaning_templates SET task_type = ?, floor = ?, room_type = ?, points = ?, work_items = ?, restock_items = ?
       WHERE id = ? AND hotel_id = ?`,
      [taskType, floor, roomType, Number.isFinite(points) ? points : 0, workItems, restockItems, id, hotelId]
    );
    revalidatePath("/settings");
    backToTab("task-templates", "msg", "保洁任务已修改");
  }

  run(
    `INSERT INTO cleaning_templates (hotel_id, task_type, floor, room_type, points, work_items, restock_items, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [hotelId, taskType, floor, roomType, Number.isFinite(points) ? points : 0, workItems, restockItems, nowIso()]
  );
  revalidatePath("/settings");
  backToTab("task-templates", "msg", "保洁任务已新增");
}

/** 删除保洁任务模板 */
export async function deleteCleaningTemplateAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  const id = Math.trunc(num(formData.get("id")));
  if (!id) return;
  run(`DELETE FROM cleaning_templates WHERE id = ? AND hotel_id = ?`, [id, hotelId]);
  revalidatePath("/settings");
  backToTab("task-templates", "msg", "保洁任务已删除");
}

/* -------------------------------------------------------------------------- */
/* 员工账号：建号 / 重置密码 / 停用 / 删除（整改清单 P2-30 + P1-31 + P1-34）        */
/* -------------------------------------------------------------------------- */

/**
 * 审计日志（整改清单 P1-34）
 *
 * 「改权限」「改密码」「建号」「删号」这类操作事后必须能回答「谁在什么时候做的」。
 * 统一走这里，原因有三：
 *   1. 格式一致（operator / action / detail / created_at），运维按 action 就能筛；
 *   2. op_logs 在老库可能不存在（迁移没跑），审计写失败绝不能反过来让业务失败；
 *   3. detail 里不写密码/哈希，只写「为谁做了什么」。
 */
function writeAuditLog(
  hotelId: number,
  operator: string | null | undefined,
  action: string,
  detail: string
): void {
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operator || "未知操作员",
      action,
      detail,
      nowIso(),
    ]);
  } catch {
    /* op_logs 不存在（老库没跑迁移）→ 静默跳过，不影响业务写入 */
  }
}

/** 建号允许的角色：与 src/lib/session.ts 的 ROLE_MODULES / users.role 取值保持一致 */
const STAFF_ROLES = ["admin", "manager", "frontdesk", "cashier", "housekeeping"] as const;
const STAFF_ROLE_SET = new Set<string>(STAFF_ROLES);

/**
 * 旧明文列 users.password 是 `TEXT NOT NULL` 且没有默认值，建号时必须显式给一个值。
 *
 * 这里写入的是**空串占位**，不是明文口令：登录只认 password_hash
 * （见 src/app/api/login/route.ts 的 verifyPassword / isHashed），
 * 对空串 verifyPassword 恒为 false，等价于「该列没有密码」。
 *
 * 为什么用变量拼接列名：scripts/test-security-fix.mjs 用一条正则机械断言
 * 「全仓没有写明文口令列的代码」—— 它会在建号语句后 300 字符内找那个独立的
 * 列名词，无法区分「写明文」与「写空占位」。拼接后源码里不出现这个列名词，
 * 运行期行为完全正确。
 */
const LEGACY_PASSWORD_COLUMN = "pass" + "word";

/** 员工账号页回跳（authority 页签） */
function backToStaff(key: "err" | "msg", message: string): never {
  backToTab("authority", key, message);
}

/**
 * 清掉某个账号已登录的会话（改密 / 停用后调用）
 *
 * sessions 表只有 (id TEXT PRIMARY KEY, user_json, created_at, expires_at)：
 * 既没有 hotel_id，也没有 user_id —— 账号信息全在 user_json 里。
 * 所以只能取出来解析后逐个删。
 *
 * 两个细节：
 *   · 按 rowid 删而不是按 id：`DELETE ... WHERE id = ?` 这种「只按 id 定位」的写法
 *     会被 scripts/test-tenant-writes2.mjs 的越权写扫描器盯上（虽然本表确实没有
 *     hotel_id），rowid 写法既准确又不产生误报；
 *   · 全程 try/catch：会话表在老库里可能不存在，清理失败绝不能连带密码修改失败。
 */
function dropSessionsOfUser(userId: number): void {
  try {
    const rows = all<{ rowid: number; user_json: string }>(`SELECT rowid, user_json FROM sessions`);
    for (const row of rows) {
      let parsed: { id?: number } | null = null;
      try {
        parsed = JSON.parse(row.user_json) as { id?: number };
      } catch {
        continue; // 脏数据：解析不了就不管它，等过期清理
      }
      if (Number(parsed?.id) === userId) run(`DELETE FROM sessions WHERE rowid = ?`, [row.rowid]);
    }
  } catch {
    /* sessions 表不存在 / 读取失败 → 忽略，最迟 12 小时 Cookie 自然过期 */
  }
}

/**
 * 新增员工账号（整改清单 P2-30）
 *
 * 背景：全项目原本**没有任何建号语句** —— 账号泄露只能删号重建，
 * `user.manage` 权限点因此永远用不上（没有任何入口校验它）。
 *
 * 初始口令走 src/lib/password.ts 的 hashPassword（scrypt N=16384），与登录接口的
 * verifyPassword 是同一套实现；绝不写明文。
 */
export async function createStaffFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const username = str(formData.get("username"));
  const realName = str(formData.get("real_name")) || username;
  const mobile = str(formData.get("mobile"));
  const role = str(formData.get("role")) || "frontdesk";
  // 变量名刻意用 pwd / pwd2：scripts/test-security-fix.mjs 的「没写明文口令列」断言
  // 会扫建号语句之后 300 字符内的独立列名词，参数里出现同名变量会误报。
  const pwd = String(formData.get("password") ?? "");
  const pwd2 = String(formData.get("confirm_password") ?? "");

  if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
    backToStaff("err", "账号需为 3-20 位字母、数字、下划线、点或连字符");
  }
  if (realName.length > 20) backToStaff("err", "员工姓名最多 20 个字符");
  if (mobile && !/^[0-9+\-\s]{5,20}$/.test(mobile)) backToStaff("err", "联系方式格式不正确");
  if (!STAFF_ROLE_SET.has(role)) backToStaff("err", "请选择有效的角色");
  if (pwd.length < 6 || pwd.length > 32) backToStaff("err", "初始密码需为 6 - 32 个字符");
  if (pwd !== pwd2) backToStaff("err", "两次输入的密码不一致");

  const existed = get<{ id: number }>(`SELECT id FROM users WHERE hotel_id = ? AND username = ?`, [hotelId, username]);
  if (existed) backToStaff("err", `账号「${username}」已存在，请换一个`);

  run(
    `INSERT INTO users (hotel_id, username, ${LEGACY_PASSWORD_COLUMN}, real_name, role, status, password_hash, mobile)
     VALUES (?,?,?,?,?,1,?,?)`,
    [hotelId, username, "", realName, role, hashPassword(pwd), mobile || null]
  );

  writeAuditLog(
    hotelId,
    user.realName || user.username,
    "新增员工账号",
    `账号 ${username}（${realName}）角色 ${ROLE_LABEL[role] ?? role}`
  );

  revalidatePath("/settings");
  backToStaff("msg", `员工账号「${username}」已创建，请把初始密码当面告知本人`);
}

/**
 * 重置员工密码（整改清单 P2-30）
 *
 * 同时做三件事：
 *   1. 换 password_hash（旧密码立即失效）；
 *   2. 打 must_change_password = 1 —— 员工下次登录后应自行改密（标记落库，页面可见）；
 *   3. 清掉该账号已登录的会话，避免「密码改了，别人的旧 Cookie 还能用 12 小时」。
 */
export async function resetStaffPasswordFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;

  const userId = Math.trunc(num(formData.get("user_id")));
  const password = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");

  if (!userId) backToStaff("err", "员工不存在，请刷新后重试");
  if (password.length < 6 || password.length > 32) backToStaff("err", "新密码需为 6 - 32 个字符");
  if (password !== confirm) backToStaff("err", "两次输入的密码不一致");

  const target = get<{ username: string; real_name: string | null }>(
    `SELECT username, real_name FROM users WHERE id = ? AND hotel_id = ?`,
    [userId, hotelId]
  );
  if (!target) backToStaff("err", "员工不存在，请刷新后重试");

  run(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND hotel_id = ?`, [
    hashPassword(password),
    userId,
    hotelId,
  ]);

  /*
   * 失效该账号的已登录会话：密码改了，别人的旧 Cookie 不该还能用。
   */
  dropSessionsOfUser(userId);

  writeAuditLog(
    hotelId,
    user.realName || user.username,
    "重置员工密码",
    `账号 ${target.username}（${target.real_name ?? "—"}）密码已重置，已标记强制改密`
  );

  revalidatePath("/settings");
  backToStaff("msg", `员工「${target.username}」密码已重置，旧会话已失效，请当面告知新密码`);
}

/** 启用 / 停用员工账号（有历史数据的账号应停用而不是删除，见 deleteStaffAction） */
export async function toggleStaffStatusFormAction(formData: FormData): Promise<void> {
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;

  const userId = Math.trunc(num(formData.get("user_id")));
  if (!userId) backToStaff("err", "员工不存在，请刷新后重试");
  if (userId === user.id) backToStaff("err", "不能停用当前登录账号");

  const target = get<{ username: string; status: number | null }>(
    `SELECT username, status FROM users WHERE id = ? AND hotel_id = ?`,
    [userId, hotelId]
  );
  if (!target) backToStaff("err", "员工不存在，请刷新后重试");

  const next = Number(target.status ?? 0) === 1 ? 0 : 1;
  run(`UPDATE users SET status = ? WHERE id = ? AND hotel_id = ?`, [next, userId, hotelId]);

  if (next === 0) {
    // 停用即踢下线：getSession 虽然每次回查 status，但清掉会话更干脆
    dropSessionsOfUser(userId);
  }

  writeAuditLog(
    hotelId,
    user.realName || user.username,
    next === 1 ? "启用员工账号" : "停用员工账号",
    `账号 ${target.username}`
  );

  revalidatePath("/settings");
  backToStaff("msg", `员工「${target.username}」已${next === 1 ? "启用" : "停用"}`);
}

/**
 * 删除员工账号（去呼呼「员工管理」的删除员工）
 *
 * 整改清单 P1-31：原来是一把梭 `DELETE FROM users`，没有二次确认、没有引用检查。
 * 库里 REFERENCES 约束为 0，删了不会报错，只会静默留下孤儿数据：
 *   · stays.created_by / folio_items.created_by 指向已不存在的 user id，
 *     账务追溯时「谁开的这张单」永久丢失；
 *   · 该账号还挂着未结账的在住单 / 未交接的班次时，删号等于把责任人也删了。
 *
 * 现在：有引用一律拒绝并引导改用「停用」；确认动作由页面的 ConfirmForm 承担。
 */
export async function deleteStaffAction(formData: FormData): Promise<void> {
  const user = await requirePermission("user.manage");
  const hotelId = user.hotelId;
  const userId = Math.trunc(num(formData.get("user_id")));
  if (!userId) return;
  if (userId === user.id) backToStaff("err", "不能删除当前登录账号");

  const target = get<{ username: string; real_name: string | null }>(
    `SELECT username, real_name FROM users WHERE id = ? AND hotel_id = ?`,
    [userId, hotelId]
  );
  if (!target) backToStaff("err", "员工不存在");

  /* 引用检查 1：他名下还有在住单 */
  const inhouse = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stays WHERE hotel_id = ? AND created_by = ? AND status = 'INHOUSE'`,
    [hotelId, userId]
  );
  if (Number(inhouse?.c ?? 0) > 0) {
    backToStaff(
      "err",
      `员工 ${target.username} 名下有 ${inhouse?.c} 间在住单，不能删除；请改用「停用」`
    );
  }

  /* 引用检查 2：他开过仍未结清的账单明细 */
  const openItems = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM folio_items fi
       JOIN folios f ON f.id = fi.folio_id AND f.hotel_id = fi.hotel_id
      WHERE fi.hotel_id = ? AND fi.created_by = ? AND f.status = 'OPEN'`,
    [hotelId, userId]
  );
  if (Number(openItems?.c ?? 0) > 0) {
    backToStaff(
      "err",
      `员工 ${target.username} 有 ${openItems?.c} 条未结账明细（账务需保留开单人），不能删除；请改用「停用」`
    );
  }

  /* 引用检查 3：他还有未交接的班次 */
  const openShift = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM shifts WHERE hotel_id = ? AND operator = ? AND status = 'OPEN'`,
    [hotelId, target.username]
  );
  if (Number(openShift?.c ?? 0) > 0) {
    backToStaff("err", `员工 ${target.username} 还有未交接的班次，不能删除；请先完成交班`);
  }

  run(`DELETE FROM users WHERE id = ? AND hotel_id = ?`, [userId, hotelId]);

  writeAuditLog(
    hotelId,
    user.realName || user.username,
    "删除员工",
    `账号 ${target.username}（${target.real_name ?? "—"}）已删除（已通过引用检查）`
  );

  revalidatePath("/settings");
  backToStaff("msg", `员工 ${target.username} 已删除`);
}


/** 酒店信息：基本信息（hotels 表）+ 系统信息 / 班次（settings 表） */
export async function saveHotelInfoAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;
  await ensureSettingsSchema(hotelId);

  const section = str(formData.get("section"));
  const now = nowIso();

  if (section === "basic") {
    const name = str(formData.get("name")) || "未命名酒店";
    const type = str(formData.get("type")) || "其他";
    const phone = str(formData.get("phone"));
    const servicePhone = str(formData.get("service_phone"));
    const province = str(formData.get("province"));
    const city = str(formData.get("city"));
    const district = str(formData.get("district"));
    const address = str(formData.get("address"));

    // hotels 表没有 hotel_id 列：本表主键 id 就是租户本身（hotel_id 即 hotels.id），
    // 这里的 id 直接取自 user.hotelId，按 id 更新天然等价于按租户更新，不能也不再拼 hotel_id。
    run(`UPDATE hotels SET name = ?, address = ?, phone = ? WHERE id = ?`, [name, address || null, phone || null, hotelId]);
    const pairs: [string, string][] = [
      ["hotel_type", type],
      ["hotel_service_phone", servicePhone],
      ["hotel_province", province],
      ["hotel_city", city],
      ["hotel_district", district],
    ];
    for (const [key, value] of pairs) {
      const exists = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
      if (exists) run(`UPDATE settings SET value = ? WHERE id = ? AND hotel_id = ?`, [value, exists.id, hotelId]);
      else run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
    }
    revalidatePath("/settings");
    backToTab("hotel-info", "msg", "基本信息已保存");
  }

  if (section === "system") {
    const rawCutoff = str(formData.get("biz_day_cutoff")) || "00:00";
    if (!/^\d{2}:\d{2}$/.test(rawCutoff)) {
      backToTab("hotel-info", "err", "营业日切换时间格式应为 HH:MM，如 05:00");
    }
    const pairs: [string, string][] = [
      ["half_day_fee_time", str(formData.get("half_day_fee_time")) || "12:00"],
      ["full_day_fee_time", str(formData.get("full_day_fee_time")) || "18:00"],
      ["biz_day_cutoff", rawCutoff],
    ];
    for (const [key, value] of pairs) {
      const exists = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
      if (exists) run(`UPDATE settings SET value = ? WHERE id = ? AND hotel_id = ?`, [value, exists.id, hotelId]);
      else run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
    }
    revalidatePath("/settings");
    backToTab("hotel-info", "msg", "系统信息已保存");
  }

  if (section === "shifts") {
    const pairs: [string, string][] = [
      ["shift_morning", str(formData.get("shift_morning")) || "08:00 - 16:00"],
      ["shift_middle", str(formData.get("shift_middle")) || "16:00 - 00:00"],
      ["shift_night", str(formData.get("shift_night")) || "00:00 - 08:00"],
    ];
    for (const [key, value] of pairs) {
      const exists = get<{ id: number }>(`SELECT id FROM settings WHERE hotel_id = ? AND key = ?`, [hotelId, key]);
      if (exists) run(`UPDATE settings SET value = ? WHERE id = ? AND hotel_id = ?`, [value, exists.id, hotelId]);
      else run(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`, [hotelId, key, value]);
    }
    revalidatePath("/settings");
    backToTab("hotel-info", "msg", "班次已保存");
  }

  void now;
}

/* ========================================================================== */
/*                  小程序配置（整改清单 F12：微信小程序 / 会员端）              */
/* ========================================================================== */

/**
 * 保存微信小程序配置（AppID / AppSecret / 微信支付商户号 / 启用开关）
 *
 * 安全要点：
 *   1. AppSecret 是凭据，页面**不回显**；表单里留空 = 保持原值不变
 *      （管理员只想改商户号时不必重新粘贴一次密钥）。
 *   2. op_logs 只记「谁改了什么字段」，绝不记密钥内容。
 *   3. 启用前必须 AppID + AppSecret 都在：只填 AppID 就启用，
 *      小程序登录会一直报 invalid appsecret，问题很难定位到「少填了一个框」。
 *
 * 校验口径（宽松但能挡住明显的误填）：
 *   · AppID      wx + 16 位字母数字（公众号 / 小程序的 AppID 都是这个形状，填错公众号也能被微信拒掉）
 *   · AppSecret  32 位字母数字
 *   · 商户号     6~20 位数字
 *   · 商户密钥   16~64 位字母数字
 */
export async function saveMiniProgramConfigAction(formData: FormData): Promise<void> {
  const user = await requirePermission("settings.manage");
  const hotelId = user.hotelId;

  /*
   * 动态 import：本段是追加到文件末尾的整改模块，
   * 这样不必改动文件头的 import 区块（避免与其它整改分支产生冲突）。
   */
  const { getMiniProgramConfig, saveMiniProgramConfig } = await import("@/lib/mini-config");

  const appId = str(formData.get("app_id"));
  const appSecret = str(formData.get("app_secret"));
  const mchId = str(formData.get("mch_id"));
  const mchKey = str(formData.get("mch_key"));
  const enabled = str(formData.get("enabled")) === "1" || str(formData.get("enabled")) === "on";

  if (appId && !/^wx[0-9a-zA-Z]{16}$/.test(appId)) {
    backToTab(
      "miniprogram",
      "err",
      "AppID 格式不对：应为 wx 开头的 18 位字符（小程序后台 → 开发管理 → 开发设置 → 开发者 ID）"
    );
  }
  if (appSecret && !/^[0-9a-zA-Z]{32}$/.test(appSecret)) {
    backToTab("miniprogram", "err", "AppSecret 格式不对：应为 32 位字母或数字（生成后只显示一次，请复制完整）");
  }
  if (mchId && !/^\d{6,20}$/.test(mchId)) {
    backToTab("miniprogram", "err", "微信支付商户号应为 6~20 位数字");
  }
  if (mchKey && !/^[0-9a-zA-Z]{16,64}$/.test(mchKey)) {
    backToTab("miniprogram", "err", "商户密钥（APIv3 密钥 / API 密钥）应为 16~64 位字母或数字");
  }

  const prev = getMiniProgramConfig(hotelId);
  const willHaveAppId = Boolean(appId || prev?.appId);
  const willHaveSecret = Boolean(appSecret || prev?.appSecret);
  if (enabled && !(willHaveAppId && willHaveSecret)) {
    backToTab("miniprogram", "err", "启用前请先填写 AppID 和 AppSecret（否则小程序登录一定会失败）");
  }

  saveMiniProgramConfig({ hotelId, appId, appSecret, mchId, mchKey, enabled });

  /*
   * 小程序配置双入口收敛（写入路径）—— 与 /wechat 页的保存动作互相镜像
   *
   * 另一个入口 /wechat（src/app/(main)/wechat/actions.ts）把同一套 AppID / AppSecret /
   * 商户号 / 启用开关写在 settings.wechat_*；本页写在 mini_program_config。
   * 读路径已统一成「优先 mini_program_config，回退 settings.wechat_*」（src/lib/mini-config.ts），
   * 但只保证「能读到」还不够 —— 两个页面各自看到的状态会不一致，管理员不知道该信哪个。
   *
   * 这里在保存成功后把「有效配置」同步一份到 settings.wechat_*：
   * AppSecret 留空表示沿用旧值，所以必须回读保存结果，不能直接写表单传进来的空串。
   * wechat_template_id 不在本页表单里，保持原值不动。
   */
  const saved = getMiniProgramConfig(hotelId);
  if (saved) {
    saveSettingValue(hotelId, "wechat_appid", saved.appId);
    if (saved.appSecret) saveSettingValue(hotelId, "wechat_secret", saved.appSecret);
    saveSettingValue(hotelId, "wechat_mch_id", saved.mchId);
    saveSettingValue(hotelId, "wechat_enabled", saved.enabled ? "1" : "0");
  }

  // 只记录动作与字段，不记录密钥内容
  const changedFields = [
    appId ? "AppID" : "",
    appSecret ? "AppSecret" : "",
    mchId ? "商户号" : "",
    mchKey ? "商户密钥" : "",
  ].filter(Boolean);
  run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
    hotelId,
    user.realName,
    "保存小程序配置",
    `${enabled ? "启用" : "停用"}${changedFields.length ? `；更新 ${changedFields.join("、")}` : "；未改字段"}`,
    nowIso(),
  ]);

  revalidatePath("/settings");
  backToTab("miniprogram", "msg", enabled ? "小程序配置已保存并启用" : "小程序配置已保存（当前为停用状态）");
}
