import type { ReactNode } from "react";
import Link from "next/link";
import { all, get, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  PERMISSION_CODES,
  PERMISSION_LABELS,
  PERMISSION_MODULE_OF,
  ROLE_MODULES,
  isRbacDbBacked,
} from "@/lib/session";
import { ROLE_LABEL, ROOM_STATUS, fmtMoney, todayStr } from "@/lib/utils";
import ConfirmForm from "@/components/ConfirmForm";
import { createCreditItemFormAction, createDebitItemFormAction, createDictItemFormAction, createFloorFormAction, createPackageFormAction, createPositionFormAction, createRateCodeFormAction, createRoomFormAction, createSalesmanFormAction, createStaffFormAction, deleteDictItemFormAction, deleteFloorFormAction, deletePackageFormAction, resetStaffPasswordFormAction, toggleStaffStatusFormAction, ensureSettingsSchema, ensureRbacSchema, saveRoleModulesFormAction, saveRolePermissionsFormAction, batchUpdateAllotmentFormAction, fillMonthRateFormAction, saveAdvancedFormAction, saveHotelInfoAction, saveCleaningTemplateAction, deleteCleaningTemplateAction, saveHourlyRateAction, toggleCreditItemStatusFormAction, toggleDebitItemStatusFormAction, toggleRateCodeStatusFormAction, toggleSalesmanStatusFormAction, updateFloorFormAction, updatePositionFormAction, updateRateCalendarFormAction, updateRateCodeFormAction, updateRoomTypePriceFormAction, createRoomTypeFormAction, updateSettingFormAction, deleteStaffAction, updateUserPositionFormAction, /* 小程序配置（整改清单 F12） */
  saveMiniProgramConfigAction } from "./actions";
import { getMiniProgramConfig, maskAppId } from "@/lib/mini-config";
/* 演示数据一键导入面板（设置页「演示数据」Tab） */
import DemoDataPanel from "./DemoDataPanel";

export const dynamic = "force-dynamic";

type RoomTypeRow = {
  id: number;
  code: string;
  name: string;
  bed_type: string | null;
  area: number | null;
  max_occupancy: number | null;
  base_price: number;
  /** 显示优先级（去呼呼房型设置页第一列） */
  sort: number;
};

type RoomRow = {
  id: number;
  room_no: string;
  floor: number | null;
  status: string;
  room_type_name: string | null;
};

type ChannelRow = {
  id: number;
  name: string | null;
  commission: number | null;
  channel_type: string | null;
  enabled: number | null;
  sort: number | null;
};

type SettingRow = {
  key: string;
  value: string | null;
};

type OperatorRow = {
  id: number;
  username: string;
  real_name: string | null;
  role: string;
};

type RateRow = {
  room_type_id: number;
  date: string;
  price: number;
};

type PackageRow = {
  id: number;
  code: string;
  name: string;
  price: number;
  breakfast_count: number;
  items: string | null;
  status: string;
};

type SalesmanRow = {
  id: number;
  name: string;
  phone: string | null;
  commission_rate: number;
  status: string;
};

type RoleRow = {
  id: number;
  code: string;
  name: string;
  permissions: string | null;
};

type RatePlanRow = {
  id: number;
  name: string | null;
  is_default: number | null;
};

/** 消费项目（debit_items）：房费 / 餐饮 / 洗衣 / 迷你吧… */
type DebitItemRow = {
  id: number;
  name: string;
  category: string | null;
  price: number;
  status: string;
};

/** 收款项目（credit_items）：现金 / 微信 / 支付宝 / 银行卡 / 挂账 */
type CreditItemRow = {
  id: number;
  name: string;
  method: string;
  status: string;
};

/** 楼层档案（floors）：sort 为显示优先级，越小越靠前 */
type FloorRow = {
  id: number;
  name: string;
  code: string;
  sort: number;
};

/** 房价代码（rate_codes）：折扣率 1 表示不打折，0.85 表示 8.5 折 */
type HourlyRateRow = {
  room_type_id: number;
  type_name: string;
  base_hours: number;
  base_price: number;
  overtime_rate: number;
  full_day_rule: string;
};

type RateCodeRow = {
  id: number;
  code: string;
  name: string;
  type: string;
  discount: number;
  status: string;
  sort: number | null;
  package_code: string | null;
};

/** 岗位（positions）：permissions 存 JSON 数组 */
type PositionRow = {
  id: number;
  name: string;
  permissions: string | null;
};

/** 员工（users + positions）：岗位下拉绑定 position_id */
type StaffRow = {
  id: number;
  username: string;
  real_name: string | null;
  role: string;
  position_id: number | null;
  position_name: string | null;
  status: number | null;
  /** 整改清单 P2-30：管理员重置密码后置 1，提示本人下次登录自行改密 */
  must_change_password: number | null;
  last_login_at: string | null;
  mobile: string | null;
};

/** 字典项（dict_items）：kind 区分换房 / 锁房 / 维修房原因与 AR 账户类型 */
type DictItemRow = {
  id: number;
  kind: string;
  name: string;
  sort: number;
};

/** 顶部 tab 定义：顺序即界面顺序 */
const TABS = [
  { key: "room-types", label: "房型" },
  { key: "rooms", label: "房间" },
  { key: "channels", label: "渠道" },
  { key: "rates", label: "房价日历" },
  { key: "packages", label: "包价设置" },
  { key: "debit-items", label: "消费项目" },
  { key: "credit-items", label: "收款项目" },
  { key: "hourly", label: "钟点房收费" },
  { key: "salesmen", label: "销售员管理" },
  { key: "roles", label: "角色权限" },
  /* 整改 5.2：动作级权限 / 页面模块落库（上面那个 roles tab 写的是 roles.permissions JSON，仅展示用） */
  { key: "rbac", label: "权限矩阵" },
  { key: "params", label: "系统参数" },
  { key: "operators", label: "操作员" },
  { key: "floors", label: "楼层设置" },
  { key: "rate-codes", label: "房价代码" },
  { key: "authority", label: "岗位与员工" },
  { key: "dicts", label: "原因与类型" },
  { key: "hotel-info", label: "酒店信息" },
  { key: "task-templates", label: "任务中心" },
  { key: "advanced", label: "高级设置" },
  /* 小程序配置（整改清单 F12）：微信小程序 / 会员端的 AppID、AppSecret、商户号 */
  { key: "miniprogram", label: "小程序配置" },
  /* 演示数据：一键导入一整套可演示的业务数据（46 房 / 588 预订 / 200 账单） */
  { key: "demo", label: "演示数据" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/* --------------------- 左侧竖向菜单（对齐去呼呼设置页结构） --------------------- */

type NavItem = {
  /** 菜单文案 */
  label: string;
  /** 本页 tab（与 href 二选一），决定选中态 */
  tab?: TabKey;
  /** 跳转到其他页面（本页不实现） */
  href?: string;
};

type NavGroup = {
  /** 分组标题（可折叠） */
  label: string;
  items: NavItem[];
};

/** 分组顺序与去呼呼截图一致：分组标题 + 缩进子项 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "客房信息",
    items: [
      { label: "房型设置", tab: "room-types" },
      { label: "楼层设置", tab: "floors" },
      { label: "房号设置", tab: "rooms" },
      { label: "房价代码", tab: "rate-codes" },
      { label: "房价设置", tab: "rates" },
      { label: "包价设置", tab: "packages" },
    ],
  },
  {
    label: "商品库存管理",
    items: [
      { label: "商品类别", href: "/goods?tab=categories" },
      { label: "商品列表", href: "/goods" },
      { label: "库存管理", href: "/goods?tab=stock" },
    ],
  },
  {
    label: "财务信息",
    items: [
      { label: "消费项目", tab: "debit-items" },
      { label: "收款项目", tab: "credit-items" },
      { label: "钟点房收费", tab: "hourly" },
    ],
  },
  {
    label: "设置中心",
    items: [
      { label: "酒店信息", tab: "hotel-info" },
      { label: "渠道来源", tab: "channels" },
      { label: "销售员设置", tab: "salesmen" },
      { label: "原因与类型", tab: "dicts" },
      { label: "高级设置", tab: "advanced" },
      /* 小程序配置（整改清单 F12） */
      { label: "小程序配置", tab: "miniprogram" },
      /*
       * 演示数据：一键导入 46 房 / 588 预订 / 200 账单，给客户演示、同事试用、培训用。
       *
       * 注意：这个 Tab 必须同时出现在两处 ——
       *   · 上面的 TABS（决定 tab 是否合法、共几项）
       *   · 这里的 NAV_GROUPS（左侧菜单实际渲染的就是它）
       * 只加 TABS 的话 `?tab=demo` 能打开，但菜单里找不到入口（踩过）。
       */
      { label: "演示数据", tab: "demo" },
    ],
  },
  {
    label: "权限管理",
    items: [
      { label: "角色权限", tab: "roles" },
      /* 整改 5.2：真正决定接口 / 路由判断的权限矩阵（role_permissions / role_modules） */
      { label: "权限矩阵", tab: "rbac" },
      { label: "任务中心", tab: "task-templates" },
      { label: "岗位与员工", tab: "authority" },
    ],
  },
  {
    label: "其他",
    items: [
      { label: "系统参数", tab: "params" },
      { label: "操作员", tab: "operators" },
    ],
  },
];

/** 菜单项链接：本页 tab 走 ?tab=，其余走独立路由 */
function navHref(item: NavItem): string {
  return item.href ?? `/settings?tab=${item.tab ?? "room-types"}`;
}

/** 找到 tab 所属分组，用于右侧内容区页面标题 */
function findNavEntry(tab: TabKey): { groupLabel: string; label: string } | undefined {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => entry.tab === tab);
    if (item) return { groupLabel: group.label, label: item.label };
  }
  return undefined;
}

/** 权限项，与 actions.ts 中的 PERMISSION_CODES 保持一致 */
const PERMISSIONS: { code: string; label: string }[] = [
  { code: "room_status", label: "房态" },
  { code: "booking", label: "预订" },
  { code: "checkin", label: "入住" },
  { code: "cashier", label: "收银" },
  { code: "night_audit", label: "夜审" },
  { code: "report", label: "报表" },
  { code: "settings", label: "设置" },
];

const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/* ------------------------- 权限矩阵（整改 5.2） ------------------------- */

/** 权限分组中文名（与 permission_dict.module / PERMISSION_MODULE_OF 对应） */
const PERMISSION_MODULE_LABELS: Record<string, string> = {
  room: "房态",
  booking: "预订",
  checkin: "入住",
  cashier: "收银",
  night_audit: "夜审",
  report: "报表",
  channel: "渠道",
  settings: "设置",
  guest: "客人",
  member: "会员",
};

/** 权限矩阵的角色列（admin 恒通过，界面上勾满且禁用） */
const RBAC_ROLE_CODES = ["admin", "frontdesk", "cashier", "housekeeping"] as const;

type PermissionDictRow = {
  permission: string;
  label: string;
  module: string | null;
  description: string | null;
};

type RbacView = {
  /** 权限点字典（中文名 / 归属模块） */
  dict: PermissionDictRow[];
  /** 角色 → 已勾选的权限点 */
  granted: Map<string, Set<string>>;
  /** 角色 → 已勾选的页面模块（可能含 "*"） */
  roleModules: Map<string, Set<string>>;
  /** 候选页面模块（内置常量 ∪ 库里出现过的） */
  moduleList: string[];
  /** 本店权限是否已由数据库配置（false = 正在回落内置默认值） */
  dbBacked: boolean;
};

/**
 * 读取权限矩阵所需数据（整改 5.2）
 *
 * 只在 ?tab=rbac 时执行：这三张表跟其它设置页无关，没必要每次进设置都查。
 * 勾选状态一律以数据库为准，界面不参与任何默认值推断。
 */
async function loadRbacView(hotelId: number): Promise<RbacView> {
  // 保险：迁移没跑时也能打开页面（只建表 + 补权限字典，不补角色权限种子）
  await ensureRbacSchema();

  const dictRows = all<PermissionDictRow>(
    `SELECT permission, label, module, description FROM permission_dict ORDER BY module, permission`
  );
  // 字典为空（迁移没跑、懒初始化也失败）→ 用内置常量兜底，界面不至于空白
  const dict: PermissionDictRow[] =
    dictRows.length > 0
      ? dictRows
      : PERMISSION_CODES.map((code) => ({
          permission: code,
          label: PERMISSION_LABELS[code] ?? code,
          module: PERMISSION_MODULE_OF[code] ?? null,
          description: null,
        }));

  const granted = new Map<string, Set<string>>();
  for (const row of all<{ role: string; permission: string }>(
    `SELECT role, permission FROM role_permissions WHERE hotel_id = ?`,
    [hotelId]
  )) {
    const set = granted.get(row.role);
    if (set) set.add(row.permission);
    else granted.set(row.role, new Set([row.permission]));
  }

  const roleModules = new Map<string, Set<string>>();
  for (const row of all<{ role: string; module: string }>(
    `SELECT role, module FROM role_modules WHERE hotel_id = ?`,
    [hotelId]
  )) {
    const set = roleModules.get(row.role);
    if (set) set.add(row.module);
    else roleModules.set(row.role, new Set([row.module]));
  }

  // 候选模块 = 内置 ROLE_MODULES 的全部模块 ∪ 库里出现过的（"*" 只做标记，不单独成行）
  const moduleSet = new Set<string>();
  for (const mods of Object.values(ROLE_MODULES)) {
    if (mods === "*") continue;
    for (const m of mods) moduleSet.add(m);
  }
  for (const set of roleModules.values()) {
    for (const m of set) if (m !== "*") moduleSet.add(m);
  }

  return {
    dict,
    granted,
    roleModules,
    moduleList: [...moduleSet].sort(),
    dbBacked: isRbacDbBacked(hotelId),
  };
}

/** 房价代码类型（与 actions.ts 中 RATE_CODE_TYPES 对应） */
const RATE_CODE_TYPES = ["门市价", "协议价", "会员价", "团队价"] as const;

/** 字典类型分组（与 actions.ts 中 DICT_KIND_SEEDS 对应） */
const DICT_GROUPS: { kind: string; label: string; desc: string }[] = [
  { kind: "CHANGE_ROOM", label: "换房原因", desc: "办理换房时可选的原因" },
  { kind: "LOCK_ROOM", label: "锁房原因", desc: "房态改为锁房时可选的原因" },
  { kind: "REPAIR_ROOM", label: "维修房原因", desc: "房态改为维修房时可选的原因" },
  { kind: "AR_TYPE", label: "AR账户类型", desc: "挂账账户的类型划分" },
  { kind: "BOOKING_PAY", label: "收款类型", desc: "预订与入住时选择的收款方式类型" },
];

/** 首页默认页候选（路径必须存在对应页面） */
const HOMEPAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "/dashboard", label: "首页看板" },
  { value: "/rooms", label: "房态图" },
  { value: "/bookings", label: "预订列表" },
  { value: "/frontdesk", label: "前台入住" },
  { value: "/cashier", label: "收银台" },
  { value: "/reports", label: "报表中心" },
];

/** 微管家服务场景（与 actions.ts 中 MICRO_BUTLER_SCENES 对应） */
const MICRO_BUTLER_SCENES = ["在线选房", "自助入住", "电子发票", "客房服务"] as const;

type SettingsSearchParams = {
  tab?: string;
  month?: string;
  roomError?: string;
  err?: string;
  msg?: string;
  /** 房型设置页的「房型名称」筛选 */
  q?: string;
};

function isTabKey(value: string | undefined): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 校验 ?month=YYYY-MM，非法时回落到当前月 */
function normalizeMonth(value: string | undefined): string {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const d = new Date(year, mon - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 解析 roles.permissions 里的 JSON 数组，损坏时按空数组处理 */
function parsePermissions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** 佣金率可能是小数（0.15）也可能是百分数（15），统一显示为百分比 */
function fmtCommission(v: number | null): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0.0%";
  const p = n > 1 ? n : n * 100;
  return `${p.toFixed(1)}%`;
}

function fmtPrice(v: number): string {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** ISO 时间 → YYYY-MM-DD HH:mm，空值显示 — */
function fmtDateTime(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`;
}

/** 折扣率显示：1 不打折，0.85 → 0.85（8.5 折） */
function fmtDiscount(v: number): string {
  const n = Number(v ?? 1);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1 ? "1.00" : `${n.toFixed(2)}（${(n * 10).toFixed(1)} 折）`;
}

/* --------------------- 视觉常量（对齐去呼呼紧凑后台风） ---------------------- */

/** 表头：12px 灰字 + 下边框 */
const TH = "h-[30px] whitespace-nowrap border-b border-[#eee] bg-white px-2 align-middle text-[12px] font-normal text-[#888]";

/** 单元格：行高 34px，边框 #eee */
const TD = "h-[34px] border-b border-[#eee] px-2 align-middle text-[12px] text-[#333]";

/** 表格行 hover 浅灰 */
const ROW_HOVER = "hover:bg-[#fafafa]";

/** 输入框：30px 高、12px 字 */
const INPUT =
  "h-[30px] rounded-[4px] border border-[#ddd] bg-white px-2 text-[12px] text-[#333] outline-none focus:border-[#32c141] focus:ring-2 focus:ring-[#d8f2dd]";

/** 主按钮：绿色 #32c141，26px 高 */
const BTN_PRIMARY =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[3px] border border-[#32c141] bg-[#32c141] px-2.5 text-[12px] font-medium text-white transition-colors hover:border-[#2bb038] hover:bg-[#2bb038] disabled:cursor-not-allowed disabled:opacity-50";

/** 次要按钮：白底描边 */
const BTN_SECOND =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[3px] border border-[#ddd] bg-white px-2.5 text-[12px] text-[#444] transition-colors hover:border-[#32c141] hover:text-[#32c141] disabled:cursor-not-allowed disabled:opacity-50";

/** 危险按钮：白底红字描边 */
const BTN_DANGER =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1 rounded-[3px] border border-[#f0c0c0] bg-white px-2.5 text-[12px] text-[#e04545] transition-colors hover:bg-[#fff3f3] disabled:cursor-not-allowed disabled:opacity-50";

/* ------------------------------- 展示组件 -------------------------------- */

/**
 * 折叠箭头：
 * - chev-group（菜单分组）：折叠时朝右 ›（rotate -90°），details[open] 时朝下 ˅（0°）
 * - chev-drop（移动端下拉）：折叠时朝下 ˅（0°），details[open] 时朝上（180°）
 * 旋转由各自 details 上的 [&[open]_.chev-*] 变体驱动，无需客户端 state。
 */
function Chevron({
  className = "",
  marker = "chev-group",
}: {
  className?: string;
  marker?: "chev-group" | "chev-drop";
}) {
  const base = marker === "chev-group" ? "rotate-[-90deg]" : "rotate-[0deg]";
  return (
    <svg
      viewBox="0 0 10 6"
      width="10"
      height="6"
      aria-hidden
      className={`${marker} ${base} shrink-0 text-[#b5b5b5] transition-[rotate,transform] duration-150 ${className}`}
    >
      <path
        d="M1 1l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 左侧竖向树形菜单（移动端下拉复用同一棵树）。
 * 折叠用原生 details/summary：点击分组标题即展开/折叠，默认只展开当前 tab 所在分组。
 */
function SettingsNav({
  activeTab,
  tabCounts,
  variant = "sidebar",
}: {
  activeTab: TabKey;
  tabCounts: Partial<Record<TabKey, number>>;
  variant?: "sidebar" | "dropdown";
}) {
  return (
    <nav aria-label="设置菜单" className={`flex flex-col ${variant === "sidebar" ? "pb-0.5" : "py-0.5"}`}>
      {NAV_GROUPS.map((group) => {
        const expanded = group.items.some((item) => item.tab === activeTab);
        return (
          <details key={group.label} open={expanded} className="[&[open]_.chev-group]:rotate-[0deg]">
            <summary className="flex h-9 cursor-pointer list-none select-none items-center gap-1 px-3 text-[13px] text-[#868686] hover:bg-[#fafafa] [&::-webkit-details-marker]:hidden">
              <span className="truncate">{group.label}</span>
              <Chevron className="ml-auto" />
            </summary>
            <div className="flex flex-col pb-0.5">
              {group.items.map((item) => {
                const active = item.tab != null && item.tab === activeTab;
                const count = item.tab ? tabCounts[item.tab] : undefined;
                return (
                  <Link
                    key={item.label}
                    href={navHref(item)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex h-[34px] items-center pl-4 pr-2.5 text-[13px] transition-colors ${
                      active
                        ? "bg-[#eef9f0] font-medium text-[#0f8f6f]"
                        : "text-[#555] hover:bg-[#f6f9f7] hover:text-[#0f8f6f]"
                    }`}
                  >
                    {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[#0f8f6f]" />}
                    <span className="truncate">{item.label}</span>
                    {item.href && (
                      <span aria-hidden className="ml-auto pl-1 text-[11px] text-[#c6c6c6]">
                        ↗
                      </span>
                    )}
                    {typeof count === "number" && (
                      <span
                        className={`ml-auto rounded-[2px] px-1 text-[11px] leading-[15px] tabular-nums ${
                          active ? "bg-white text-[#0f8f6f]" : "bg-[#f2f2f2] text-[#999]"
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </details>
        );
      })}
    </nav>
  );
}

function Section({
  id,
  title,
  desc,
  extra,
  children,
}: {
  id: string;
  title: string;
  desc?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-14 overflow-x-auto rounded-[4px] border border-[#eee] bg-white">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#eee] p-3">
        <div>
          <div className="text-[13px] font-semibold text-[#222]">{title}</div>
          {desc && <div className="mt-0.5 text-[11px] leading-[16px] text-[#999]">{desc}</div>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Banner({ tone, text, closeHref }: { tone: "error" | "ok"; text: string; closeHref: string }) {
  const cls =
    tone === "error" ? "border-[#f0c0c0] bg-[#fff3f3] text-[#e04545]" : "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-center justify-between rounded-[4px] border px-3 py-1.5 text-[12px] ${cls}`}
    >
      <span>{text}</span>
      <Link href={closeHref} className="ml-3 shrink-0 text-[11px] opacity-70 hover:opacity-100">
        关闭
      </Link>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`rounded-[2px] border px-1 text-[11px] leading-[15px] ${
        active ? "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]" : "border-[#eee] bg-[#f7f7f7] text-[#999]"
      }`}
    >
      {active ? "启用" : "停用"}
    </span>
  );
}

function ParamCard({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="rounded-[4px] border border-[#eee] bg-white p-3">
      <div className="text-[12px] font-medium text-[#444]">{title}</div>
      <div className="mt-1.5">{children}</div>
      {desc && <p className="mt-1.5 text-[11px] leading-[16px] text-[#999]">{desc}</p>}
    </div>
  );
}

function TimeParam({
  settingKey,
  label,
  value,
  desc,
}: {
  settingKey: string;
  label: string;
  value: string;
  desc: string;
}) {
  return (
    <ParamCard title={label} desc={desc}>
      <form action={updateSettingFormAction} className="flex items-center gap-2">
        <input type="hidden" name="key" value={settingKey} />
        <input id={settingKey} name="value" type="time" defaultValue={value} aria-label={label} className={`${INPUT} w-32`} />
        <button type="submit" className={`${BTN_PRIMARY} px-3`}>
          保存
        </button>
      </form>
    </ParamCard>
  );
}

function NumberParam({
  settingKey,
  label,
  value,
  min,
  max,
  desc,
}: {
  settingKey: string;
  label: string;
  value: string;
  min: number;
  max: number;
  desc: string;
}) {
  return (
    <ParamCard title={label} desc={desc}>
      <form action={updateSettingFormAction} className="flex items-center gap-2">
        <input type="hidden" name="key" value={settingKey} />
        <input
          id={settingKey}
          name="value"
          type="number"
          min={min}
          max={max}
          step={1}
          defaultValue={value}
          aria-label={label}
          className={`${INPUT} w-32`}
        />
        <button type="submit" className={`${BTN_PRIMARY} px-3`}>
          保存
        </button>
      </form>
    </ParamCard>
  );
}

function TextParam({
  settingKey,
  label,
  value,
  maxLength,
  desc,
}: {
  settingKey: string;
  label: string;
  value: string;
  maxLength: number;
  desc: string;
}) {
  return (
    <ParamCard title={label} desc={desc}>
      <form action={updateSettingFormAction} className="flex items-center gap-2">
        <input type="hidden" name="key" value={settingKey} />
        <input
          id={settingKey}
          name="value"
          defaultValue={value}
          maxLength={maxLength}
          aria-label={label}
          className={`${INPUT} w-full`}
        />
        <button type="submit" className={`${BTN_PRIMARY} px-3`}>
          保存
        </button>
      </form>
    </ParamCard>
  );
}

/* -------------------------------- 页面主体 -------------------------------- */

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SettingsSearchParams> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;

  // 新表懒创建 + 首次访问写入示例种子（保持数据可用，不改 init-db）
  await ensureSettingsSchema(hotelId);

  const activeTab: TabKey = isTabKey(sp.tab) ? sp.tab : "room-types";
  const month = normalizeMonth(sp.month);
  const [monthYear, monthIndex] = month.split("-").map(Number);
  const daysInMonth = new Date(monthYear, monthIndex, 0).getDate();
  const today = todayStr();

  const roomTypes = all<RoomTypeRow>(
    `SELECT id, code, name, bed_type, area, max_occupancy, base_price, COALESCE(sort, 100) AS sort
     FROM room_types WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );

  const rooms = all<RoomRow>(
    `SELECT r.id, r.room_no, r.floor, r.status, rt.name AS room_type_name
     FROM rooms r
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.hotel_id = ?
     ORDER BY r.sort, r.room_no`,
    [hotelId]
  );

  const channels = all<ChannelRow>(
    `SELECT id, name, commission, channel_type, enabled, sort
     FROM channels WHERE hotel_id = ? ORDER BY COALESCE(sort, 100), id`,
    [hotelId]
  );

  const settings = all<SettingRow>(`SELECT key, value FROM settings WHERE hotel_id = ?`, [hotelId]);
  const settingMap = new Map<string, string | null>(settings.map((s) => [s.key, s.value]));

  const operators = all<OperatorRow>(
    `SELECT id, username, real_name, role FROM users WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const packages = all<PackageRow>(
    `SELECT id, code, name, price, breakfast_count, items, status
     FROM package_code WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const debitItems = all<DebitItemRow>(
    `SELECT id, name, category, price, status FROM debit_items WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const creditItems = all<CreditItemRow>(
    `SELECT id, name, method, status FROM credit_items WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const salesmen = all<SalesmanRow>(
    `SELECT id, name, phone, commission_rate, status FROM salesmen WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const roles = all<RoleRow>(
    `SELECT id, code, name, permissions FROM roles WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const roleUserCounts = new Map<string, number>(
    all<{ role: string; n: number }>(
      `SELECT role, COUNT(*) AS n FROM users WHERE hotel_id = ? GROUP BY role`,
      [hotelId]
    ).map((row) => [row.role, row.n])
  );

  const rateRows = all<RateRow>(
    `SELECT room_type_id, date, price FROM rate_calendar
     WHERE hotel_id = ? AND date >= ? AND date <= ?`,
    [hotelId, `${month}-01`, `${month}-${pad2(daysInMonth)}`]
  );

  const ratePlans = all<RatePlanRow>(
    `SELECT id, name, is_default FROM rate_plans WHERE hotel_id = ? ORDER BY is_default DESC, id`,
    [hotelId]
  );

  // 楼层：按显示优先级排序（sort 越小越靠前）
  const floors = all<FloorRow>(
    `SELECT id, name, code, sort FROM floors WHERE hotel_id = ? ORDER BY sort, id`,
    [hotelId]
  );

  // 房价代码：门市价 / 协议价 / 会员价 / 团队价 + 折扣率
  /*
   * 钟点房收费：按房型左连接配置表。缺配置时展示的是「把历史口径换算成配置后的等价值」——
   * 历史口径是「门市价 × 15% × 小时数」，所以基础收费默认取 4 小时（默认基础时长）的价，
   * 超时收费默认取 1 小时价。这样管理员直接点保存不会把价格改低，
   * 也避免出现「设置页显示基础收费 ¥49、前台实际算出来 ¥197」这种对不上的情况。
   */
  const hourlyRows = all<HourlyRateRow>(
    `SELECT rt.id AS room_type_id, rt.name AS type_name,
            COALESCE(h.base_hours, 4) AS base_hours,
            COALESCE(h.base_price, ROUND(rt.base_price * 0.15 * 4, 2)) AS base_price,
            COALESCE(h.overtime_rate, ROUND(rt.base_price * 0.15, 2)) AS overtime_rate,
            COALESCE(h.full_day_rule, '满 8 小时按全天房费收取') AS full_day_rule
     FROM room_types rt
     LEFT JOIN hourly_rates h ON h.room_type_id = rt.id AND h.hotel_id = rt.hotel_id
     WHERE rt.hotel_id = ? ORDER BY rt.sort`,
    [hotelId]
  );

  // 保洁任务模板：懒建表（避免首访 500）
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
  const tplCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM cleaning_templates WHERE hotel_id = ?`, [hotelId])?.n ?? 0;
  if (tplCount === 0) {
    run(
      `INSERT INTO cleaning_templates (hotel_id, task_type, floor, room_type, points, work_items, restock_items, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [hotelId, "保洁", "所有楼层", "所有房型", 4, "打扫卫生,更换布草(毛巾,浴巾);更换床单和被套", "矿泉水", new Date().toISOString()]
    );
  }

  // 酒店信息：hotels 表 + settings 键值
  const hotelRow = get<{ name: string; address: string | null; phone: string | null; created_at: string | null }>(
    `SELECT name, address, phone, created_at FROM hotels WHERE id = ?`,
    [hotelId]
  );
  const hotelInfoMap = new Map<string, string>();
  for (const row of all<{ key: string; value: string | null }>(
    `SELECT key, value FROM settings WHERE hotel_id = ?`,
    [hotelId]
  )) {
    hotelInfoMap.set(row.key, row.value ?? "");
  }
  const hotelInfoRows = {
    name: hotelRow?.name ?? "未命名酒店",
    address: hotelRow?.address ?? "",
    phone: hotelRow?.phone ?? "",
    createdAt: hotelRow?.created_at ?? "",
    type: hotelInfoMap.get("hotel_type") ?? "其他",
    servicePhone: hotelInfoMap.get("hotel_service_phone") ?? "",
    province: hotelInfoMap.get("hotel_province") ?? "",
    city: hotelInfoMap.get("hotel_city") ?? "",
    district: hotelInfoMap.get("hotel_district") ?? "",
    halfDayFeeTime: hotelInfoMap.get("half_day_fee_time") ?? "12:00",
    fullDayFeeTime: hotelInfoMap.get("full_day_fee_time") ?? "18:00",
    /** 营业日切换时间（凌晨几点算新的一天） */
    bizDayCutoff: hotelInfoMap.get("biz_day_cutoff") ?? "00:00",
    shiftMorning: hotelInfoMap.get("shift_morning") ?? "08:00 - 16:00",
    shiftMiddle: hotelInfoMap.get("shift_middle") ?? "16:00 - 00:00",
    shiftNight: hotelInfoMap.get("shift_night") ?? "00:00 - 08:00",
  };

  const cleaningTemplates = all<{
    id: number;
    task_type: string;
    floor: string;
    room_type: string;
    points: number;
    work_items: string | null;
    restock_items: string | null;
    created_at: string | null;
  }>(
    `SELECT id, task_type, floor, room_type, points, work_items, restock_items, created_at
     FROM cleaning_templates WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const rateCodes = all<RateCodeRow>(
    `SELECT id, code, name, type, discount, status, sort, package_code
     FROM rate_codes WHERE hotel_id = ? ORDER BY COALESCE(sort, 99), id`,
    [hotelId]
  );

  // 岗位与员工：员工按 position_id 关联岗位名称
  const positions = all<PositionRow>(
    `SELECT id, name, permissions FROM positions WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const staff = all<StaffRow>(
    `SELECT u.id, u.username, u.real_name, u.role, u.position_id, p.name AS position_name,
            u.status, u.must_change_password, u.last_login_at, u.mobile
     FROM users u
     LEFT JOIN positions p ON p.id = u.position_id
     WHERE u.hotel_id = ?
     ORDER BY u.id`,
    [hotelId]
  );

  // 原因与类型：一次取出全部字典项，页面按 kind 分组渲染
  const dictItems = all<DictItemRow>(
    `SELECT id, kind, name, sort FROM dict_items WHERE hotel_id = ? ORDER BY kind, sort, id`,
    [hotelId]
  );

  const dictByKind = new Map<string, DictItemRow[]>();
  for (const item of dictItems) {
    const list = dictByKind.get(item.kind) ?? [];
    list.push(item);
    dictByKind.set(item.kind, list);
  }

  const positionHeadcount = new Map<number, number>();
  for (const member of staff) {
    if (member.position_id != null) {
      positionHeadcount.set(member.position_id, (positionHeadcount.get(member.position_id) ?? 0) + 1);
    }
  }

  const rateMap = new Map<string, number>();
  for (const row of rateRows) rateMap.set(`${row.room_type_id}|${row.date}`, Number(row.price) || 0);

  const calendarDays = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = `${month}-${pad2(day)}`;
    const weekday = new Date(monthYear, monthIndex - 1, day).getDay();
    return { day, date, weekday, isWeekend: weekday === 0 || weekday === 6, isToday: date === today };
  });

  const checkIn = settingMap.get("check_in_time") ?? "14:00";
  const checkOut = settingMap.get("check_out_time") ?? "12:00";
  const nightAudit = settingMap.get("night_audit_time") ?? "02:00";
  const cancelTimeout = settingMap.get("cancel_timeout_minutes") ?? "30";
  const allowOverbooking = settingMap.get("allow_overbooking") ?? "0";
  const receiptHeader = settingMap.get("receipt_header") ?? user.hotelName;
  const defaultPlan = ratePlans.find((plan) => Number(plan.is_default) === 1) ?? ratePlans[0];
  const defaultRateCode = settingMap.get("default_rate_code") ?? defaultPlan?.name ?? "门市价";

  // 高级设置：5 个区块全部落在 settings 表 key-value
  const ownerName = settingMap.get("property_owner_name") ?? "";
  const ownerIdNo = settingMap.get("property_owner_id_no") ?? "";
  const ownerPhone = settingMap.get("property_owner_phone") ?? "";
  const ownerAddress = settingMap.get("property_owner_address") ?? "";
  const homepageDefault = settingMap.get("homepage_default") ?? "/rooms";
  const tableDensity = settingMap.get("table_density") ?? "compact";
  const showRoomLegend = settingMap.get("show_room_legend") ?? "1";
  const reportEmail = settingMap.get("report_email") ?? "";
  const reportSendTime = settingMap.get("report_send_time") ?? "08:00";
  const reportEnabled = settingMap.get("report_enabled") ?? "0";
  const stewardPasswordSet = (settingMap.get("steward_password") ?? "").length > 0;
  // parsePermissions 本质是「解析 JSON 字符串数组」，这里复用来解析微管家场景
  const microButlerScenes = parsePermissions(settingMap.get("micro_butler_scenes") ?? null);

  /*
   * 小程序配置（整改清单 F12）
   * 只在打开「小程序配置」tab 时读库：其它 tab 不需要这份数据，不必每次都查。
   * AppID 可以回显（它本身不是密钥，反编译小程序包也能看到），
   * AppSecret 一律不回显 —— 表单留空 = 保持原值（见 saveMiniProgramConfigAction）。
   */
  const miniConfig = activeTab === "miniprogram" ? getMiniProgramConfig(hotelId) : null;
  const miniConfigured = Boolean(miniConfig?.appId && miniConfig?.appSecret);
  const miniAppIdMasked = maskAppId(miniConfig?.appId ?? "");

  /*
   * 权限矩阵（整改 5.2）：同样只在打开该 tab 时读库。
   * 勾选状态直接来自 role_permissions / role_modules，保存后由 action 调
   * invalidatePermissionCache() 让下一次请求立即按新配置判断。
   */
  const rbacView = activeTab === "rbac" ? await loadRbacView(hotelId) : null;

  /* 权限字典按模块分组：矩阵里每个模块一段，比 29 行平铺清楚 */
  const rbacGroups = new Map<string, PermissionDictRow[]>();
  for (const row of rbacView?.dict ?? []) {
    const key = row.module ?? "other";
    const list = rbacGroups.get(key);
    if (list) list.push(row);
    else rbacGroups.set(key, [row]);
  }

  /*
   * 整改 P1-29 / P2-25：原「钟点房收费」全局配置（settings.hourly_base_hours /
   * hourly_rate / hourly_min_charge）已被按房型的 hourly_rates 取代，
   * 写入动作 updateHourlyChargeFormAction 与这里的只读推算一起删除 ——
   * 它们没有任何读消费方，留着只会让管理员以为改这里能影响计费。
   */

  const tabCounts: Partial<Record<TabKey, number>> = {
    "room-types": roomTypes.length,
    rooms: rooms.length,
    channels: channels.length,
    rates: rateRows.length,
    packages: packages.length,
    "debit-items": debitItems.length,
    "credit-items": creditItems.length,
    salesmen: salesmen.length,
    roles: roles.length,
    operators: operators.length,
    floors: floors.length,
    "rate-codes": rateCodes.length,
    authority: positions.length,
    dicts: dictItems.length,
  };

  const tabHref = (tab: TabKey) => `/settings?tab=${tab}`;
  const currentHref = tabHref(activeTab);
  const navEntry = findNavEntry(activeTab) ?? { groupLabel: "客房信息", label: "房型设置" };

  /* 房型设置页的「房型名称」筛选（去呼呼房型设置页工具栏） */
  const typeQuery = typeof sp.q === "string" ? sp.q : "";
  const typeRows = typeQuery
    ? roomTypes.filter((rt) => rt.name === typeQuery || rt.name.includes(typeQuery))
    : roomTypes;

  return (
    <div className="flex min-h-full items-stretch">
      {/* 左侧竖向树形菜单：对齐去呼呼设置页（168px 白底 / 右侧 1px 分隔线） */}
      <aside className="sticky top-0 hidden h-fit max-h-screen shrink-0 self-start overflow-y-auto border-r border-[#e8e8e8] bg-white pt-1 lg:block lg:w-[168px]">
        <SettingsNav activeTab={activeTab} tabCounts={tabCounts} />
        <p className="mt-1 border-t border-[#f0f0f0] px-3 py-2 text-[11px] text-[#c2c2c2]">
          共 {TABS.length} 项设置
        </p>
      </aside>

      {/* 右侧内容区 */}
      <div className="min-w-0 flex-1 space-y-3 p-4">
        {/* 页面标题 + 操作按钮：原顶部「基础设置 + 副标题」区块迁移到此 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[11px] text-[#999]">{navEntry.groupLabel}</span>
            <h1 className="truncate text-[15px] font-semibold text-[#222]">{navEntry.label}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/member-cards" className={`${BTN_SECOND} px-2.5`}>
              会员卡设置
            </Link>
            <span className="rounded-[3px] border border-[#eee] bg-white px-2 py-[3px] text-[11px] text-[#888]">
              当前酒店：{user.hotelName}
            </span>
          </div>
        </div>

        {/* 移动端（<1024px）：左侧菜单折叠成顶部下拉 */}
        <details className="group overflow-hidden rounded-[4px] border border-[#e8e8e8] bg-white [&[open]_.chev-drop]:rotate-180 lg:hidden">
          <summary className="flex h-[38px] cursor-pointer list-none select-none items-center gap-2 px-3 text-[13px] [&::-webkit-details-marker]:hidden">
            <svg viewBox="0 0 16 16" aria-hidden className="h-[14px] w-[14px] shrink-0 text-[#0f8f6f]">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            <span className="shrink-0 text-[#999]">设置菜单</span>
            <span className="truncate font-medium text-[#0f8f6f]">{navEntry.label}</span>
            <Chevron marker="chev-drop" className="ml-auto" />
          </summary>
          <div className="border-t border-[#eee] px-1">
            <SettingsNav activeTab={activeTab} tabCounts={tabCounts} variant="dropdown" />
          </div>
        </details>

      {sp.roomError && <Banner tone="error" text={sp.roomError} closeHref={currentHref} />}
      {sp.err && <Banner tone="error" text={sp.err} closeHref={currentHref} />}
      {sp.msg && <Banner tone="ok" text={sp.msg} closeHref={currentHref} />}

      {activeTab === "room-types" && (
        <Section
          id="room-types"
          title="房型设置"
          extra={<span className="text-[11px] text-[#999]">共 {roomTypes.length} 个房型</span>}
        >
          {/* 工具栏：房型名称筛选 + 查询 / 清空 / 快速添加 */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[#f0f0f0] bg-white px-3 py-2">
            <form method="get" className="flex items-center gap-2">
              <input type="hidden" name="tab" value="room-types" />
              <span className="text-[12px] text-[#666]">房型名称：</span>
              <select
                name="q"
                defaultValue={typeQuery}
                className="h-7 w-[150px] rounded-[2px] border border-[#dcdcdc] bg-white px-1 text-[12px] text-[#333] outline-none focus:border-[#58bc62]"
              >
                <option value="">请选择</option>
                {roomTypes.map((rt) => (
                  <option key={rt.id} value={rt.name}>
                    {rt.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="h-7 rounded-[2px] bg-[#58bc62] px-3 text-[12px] text-white hover:bg-[#4fae59]">
                查询
              </button>
              <Link
                href="/settings?tab=room-types"
                className="flex h-7 items-center rounded-[2px] border border-[#dcdcdc] px-3 text-[12px] text-[#555] hover:border-[#58bc62] hover:text-[#58bc62]"
              >
                清空
              </Link>
            </form>
            <details className="relative ml-1">
              <summary className="flex h-7 cursor-pointer list-none items-center rounded-[2px] border border-dashed border-[#58bc62] px-3 text-[12px] text-[#58bc62] hover:bg-[#f4fbf5] [&::-webkit-details-marker]:hidden">
                + 快速添加
              </summary>
              <form
                action={createRoomTypeFormAction}
                className="absolute left-0 top-full z-30 mt-1 w-[280px] space-y-1.5 rounded-[3px] border border-[#e5e5e5] bg-white p-3 shadow-lg"
              >
                <label className="block text-[11px] text-[#888]">房型名称</label>
                <input
                  name="name"
                  required
                  maxLength={30}
                  className="h-7 w-full rounded-[2px] border border-[#dcdcdc] px-1.5 text-[12px] outline-none focus:border-[#58bc62]"
                />
                <div className="flex gap-1.5">
                  <div className="min-w-0 flex-1">
                    <label className="block text-[11px] text-[#888]">床型</label>
                    <select name="bed_type" className="h-7 w-full rounded-[2px] border border-[#dcdcdc] bg-white px-1 text-[12px]">
                      <option>大床</option>
                      <option>双床</option>
                      <option>单人床</option>
                    </select>
                  </div>
                  <div className="w-[80px]">
                    <label className="block text-[11px] text-[#888]">面积(㎡)</label>
                    <input
                      name="area"
                      type="number"
                      min="0"
                      className="h-7 w-full rounded-[2px] border border-[#dcdcdc] px-1 text-[12px]"
                    />
                  </div>
                </div>
                <label className="block text-[11px] text-[#888]">门市价</label>
                <input
                  name="base_price"
                  type="number"
                  min="0"
                  step="0.01"
                  className="h-7 w-full rounded-[2px] border border-[#dcdcdc] px-1.5 text-[12px]"
                />
                <button type="submit" className="h-7 w-full rounded-[2px] bg-[#58bc62] text-[12px] text-white hover:bg-[#4fae59]">
                  添加房型
                </button>
              </form>
            </details>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-[#e8f5e9]">
                  {["显示优先级", "房型名称", "超售数量", "床型", "面积", "是否有效", "备注", "操作"].map((label) => (
                    <th
                      key={label}
                      className={`h-10 whitespace-nowrap border-b border-[#d9ead9] px-3 text-[12px] font-normal text-[#333] ${
                        label === "超售数量" || label === "操作" ? "text-center" : "text-left"
                      }`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {typeRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-[12px] text-[#999]">
                      {typeQuery ? "没有匹配的房型，点击「清空」查看全部" : "暂无房型，可用「快速添加」新建"}
                    </td>
                  </tr>
                )}
                {typeRows.map((rt) => (
                  <tr key={rt.id} className="hover:bg-[#fafafa]">
                    <td className="h-10 border-b border-[#eee] px-3 text-[13px] text-[#333]">{rt.sort}</td>
                    <td className="h-10 border-b border-[#eee] px-3 text-[13px] text-[#333]">{rt.name}</td>
                    <td className="h-10 border-b border-[#eee] px-3 text-center text-[13px] tabular-nums text-[#333]">0</td>
                    <td className="h-10 border-b border-[#eee] px-3 text-[13px] text-[#333]">{rt.bed_type ?? "—"}</td>
                    <td className="h-10 border-b border-[#eee] px-3 text-[13px] text-[#333]">
                      {rt.area != null ? `${rt.area}平方米` : "—"}
                    </td>
                    <td className="h-10 border-b border-[#eee] px-3 text-[13px] text-[#333]">有效</td>
                    <td className="h-10 border-b border-[#eee] px-3 text-[13px] text-[#999]">—</td>
                    <td className="h-10 border-b border-[#eee] px-3 text-center">
                      <details className="relative inline-block text-left">
                        <summary className="inline-flex h-6 cursor-pointer list-none items-center gap-1 rounded-[2px] border border-[#58bc62] px-2 text-[12px] text-[#58bc62] hover:bg-[#f4fbf5] [&::-webkit-details-marker]:hidden">
                          <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3">
                            <path
                              d="M11.3 2.3l2.4 2.4-8.2 8.2H3.1v-2.4z"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinejoin="round"
                            />
                          </svg>
                          编辑
                        </summary>
                        <form
                          action={updateRoomTypePriceFormAction}
                          className="absolute right-0 top-full z-30 mt-1 w-[200px] rounded-[3px] border border-[#e5e5e5] bg-white p-2 shadow-lg"
                        >
                          <input type="hidden" name="room_type_id" value={rt.id} />
                          <label className="mb-1 block text-[11px] text-[#888]">门市价</label>
                          <div className="flex items-center gap-1.5">
                            <input
                              name="base_price"
                              type="number"
                              step="0.01"
                              min="0"
                              defaultValue={rt.base_price}
                              aria-label={`${rt.name} 门市价`}
                              className="h-7 min-w-0 flex-1 rounded-[2px] border border-[#dcdcdc] px-1.5 text-[12px] tabular-nums outline-none focus:border-[#58bc62]"
                            />
                            <button
                              type="submit"
                              className="h-7 rounded-[2px] bg-[#58bc62] px-2 text-[12px] text-white hover:bg-[#4fae59]"
                            >
                              保存
                            </button>
                          </div>
                        </form>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {activeTab === "rooms" && (
        <Section
          id="rooms"
          title="房间"
          desc="新增房间默认空净 VC；房号在同一酒店内不可重复"
          extra={<span className="text-[11px] text-[#999]">共 {rooms.length} 间</span>}
        >
          <form
            action={createRoomFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="room_no">
                房号
              </label>
              <input id="room_no" name="room_no" className={`${INPUT} w-28`} placeholder="如 701" />
            </div>
            <div>
              <label className="label" htmlFor="floor">
                楼层
              </label>
              <input id="floor" name="floor" type="number" min={1} max={99} defaultValue={7} className={`${INPUT} w-20`} />
            </div>
            <div>
              <label className="label" htmlFor="room_type_id">
                房型
              </label>
              <select id="room_type_id" name="room_type_id" defaultValue="" className={`${INPUT} w-44`}>
                <option value="">请选择房型</option>
                {roomTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增房间
            </button>
          </form>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>房号</th>
                  <th className={`${TH} text-right`}>楼层</th>
                  <th className={`${TH} text-left`}>房型</th>
                  <th className={`${TH} text-left`}>房态</th>
                </tr>
              </thead>
              <tbody>
                {rooms.length === 0 && (
                  <tr>
                    <td colSpan={4} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无房间，请使用上方表单新增
                    </td>
                  </tr>
                )}
                {rooms.map((r) => {
                  const st = ROOM_STATUS[r.status];
                  return (
                    <tr key={r.id} className={ROW_HOVER}>
                      <td className={`${TD} font-medium tabular-nums text-[#222]`}>{r.room_no}</td>
                      <td className={`${TD} text-right tabular-nums text-[#555]`}>{r.floor ?? "—"}</td>
                      <td className={`${TD} text-[#555]`}>{r.room_type_name ?? "—"}</td>
                      <td className={TD}>
                        <span
                          className="rounded-[2px] border px-1 text-[11px] leading-[15px]"
                          style={{ color: st?.color, backgroundColor: st?.bg, borderColor: st?.border }}
                        >
                          {st ? st.label : r.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {activeTab === "channels" && (
        <Section
          id="channels"
          title="渠道来源"
          desc="客源渠道与返佣比例，显示优先级决定渠道在筛选与报表中的排列顺序"
          extra={<span className="text-[11px] text-[#999]">共 {channels.length} 个渠道</span>}
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>显示优先级</th>
                  <th className={`${TH} text-left`}>渠道名称</th>
                  <th className={`${TH} text-left`}>渠道类型</th>
                  <th className={`${TH} text-right`}>佣金率</th>
                  <th className={`${TH} text-left`}>是否有效</th>
                </tr>
              </thead>
              <tbody>
                {channels.length === 0 && (
                  <tr>
                    <td colSpan={5} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无渠道数据
                    </td>
                  </tr>
                )}
                {channels.map((c) => (
                  <tr key={c.id} className={ROW_HOVER}>
                    <td className={`${TD} tabular-nums text-[#555]`}>{c.sort ?? 100}</td>
                    <td className={`${TD} text-[#222]`}>{c.name ?? "未命名渠道"}</td>
                    <td className={`${TD} text-[#555]`}>{c.channel_type === "online" ? "线上" : "线下"}</td>
                    <td className={`${TD} text-right tabular-nums text-[#555]`}>{fmtCommission(c.commission)}</td>
                    <td className={TD}>
                      <StatusBadge active={Boolean(c.enabled)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {activeTab === "rates" && (
        <Section
          id="rates"
          title="房价日历"
          desc="按月维护各房型的每日售价 · 点击单元格价格可展开编辑框，保存后立即生效"
          extra={
            <div className="flex items-center gap-1">
              <Link
                href={`/settings?tab=rates&month=${shiftMonth(month, -1)}`}
                className={`${BTN_SECOND} px-2`}
              >
                上一月
              </Link>
              <span className="min-w-[92px] text-center text-[12px] font-medium tabular-nums text-[#222]">
                {monthYear} 年 {monthIndex} 月
              </span>
              <Link
                href={`/settings?tab=rates&month=${shiftMonth(month, 1)}`}
                className={`${BTN_SECOND} px-2`}
              >
                下一月
              </Link>
              <Link href="/settings?tab=rates" className={`${BTN_SECOND} px-2`}>
                回到本月
              </Link>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2">
            <form action={fillMonthRateFormAction}>
              <input type="hidden" name="month" value={month} />
              <button type="submit" className={`${BTN_SECOND} px-2`}>
                按门市价补齐空档
              </button>
            </form>
            <span className="text-[11px] text-[#999]">
              灰色金额 = 未单独定价（按门市价） · 深色金额 = 已单独定价 · 当月已定价 {rateRows.length} /{" "}
              {roomTypes.length * calendarDays.length} 条
            </span>
          </div>

          {/* 修改房量（去呼呼 batchUpdateRoomNum）：按房型 + 日期区间批量设可售房量 */}
          <details className="border-b border-[#eee] bg-[#f7faf8] px-3 py-2">
            <summary className="cursor-pointer list-none text-[12px] text-[#2a9d3c] [&::-webkit-details-marker]:hidden">
              ▾ 修改房量（按房型 + 日期区间批量调整可售房量）
            </summary>
            <form action={batchUpdateAllotmentFormAction} className="mt-2 flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-[#888]">房型</span>
                <select name="room_type_id" className="input h-7 w-[180px] text-[12px]" required>
                  <option value="">请选择房型</option>
                  {roomTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-[#888]">开始</span>
                <input type="date" name="from" defaultValue={today} className="input h-7 w-[132px] text-[12px]" required />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-[#888]">结束</span>
                <input type="date" name="to" defaultValue={today} className="input h-7 w-[132px] text-[12px]" required />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] text-[#888]">可售房量（留空恢复实际）</span>
                <input
                  type="number"
                  name="allotment"
                  min={0}
                  max={999}
                  placeholder="如 20"
                  className="input h-7 w-[150px] text-[12px]"
                />
              </label>
              <button type="submit" className={`${BTN_PRIMARY} h-7 px-2.5`}>
                保存房量
              </button>
              <span className="text-[11px] text-[#999]">
                实际房间数以房型设置为准；这里改的是可售量（用于临时加房 / 减房 / 关房）
              </span>
            </form>
          </details>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 h-[42px] min-w-[132px] border-r border-b border-[#eee] bg-white px-2 text-left align-middle text-[12px] font-normal text-[#888]">
                    房型 \ 日期
                  </th>
                  {calendarDays.map((d) => (
                    <th
                      key={d.date}
                      className={`h-[42px] min-w-[54px] border-l border-[#eee] px-1 text-center align-middle font-normal ${
                        d.isToday
                          ? "bg-[#eef6ff] text-[#1d54d8]"
                          : d.isWeekend
                            ? "bg-[#fffbe6] text-[#b8860b]"
                            : "bg-white text-[#888]"
                      }`}
                    >
                      <div className="text-[12px] leading-[16px] tabular-nums">{d.day}</div>
                      <div className="text-[11px] leading-[15px] opacity-80">周{WEEK_LABELS[d.weekday]}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roomTypes.length === 0 && (
                  <tr>
                    <td colSpan={calendarDays.length + 1} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无房型，请先在「房型」页签维护房型
                    </td>
                  </tr>
                )}
                {roomTypes.map((rt, rtIndex) => (
                  <tr key={rt.id} className={ROW_HOVER}>
                    <td className="sticky left-0 z-10 h-[34px] min-w-[132px] border-r border-b border-[#eee] bg-white px-2 align-middle">
                      <div className="text-[12px] font-medium leading-[16px] text-[#222]">{rt.name}</div>
                      <div className="text-[11px] leading-[15px] text-[#999]">门市价 {fmtMoney(rt.base_price)}</div>
                    </td>
                    {calendarDays.map((d) => {
                      const explicit = rateMap.get(`${rt.id}|${d.date}`);
                      const price = explicit ?? rt.base_price;
                      return (
                        <td
                          key={d.date}
                          className={`relative h-[34px] border-l border-b border-[#eee] p-0 align-middle ${
                            d.isToday ? "bg-[#eef6ff]" : d.isWeekend ? "bg-[#fffbe6]" : "bg-white"
                          }`}
                        >
                          <details className="group/cell">
                            <summary
                              title={
                                explicit != null
                                  ? `已单独定价 ${fmtMoney(explicit)}，点击修改`
                                  : `未单独定价，按门市价 ${fmtMoney(rt.base_price)}，点击设置`
                              }
                              className={`block cursor-pointer list-none px-1 py-[9px] text-center text-[12px] tabular-nums [&::-webkit-details-marker]:hidden ${
                                explicit != null
                                  ? "font-medium text-[#222] hover:bg-[#eef9ef]"
                                  : "text-[#bbb] hover:bg-[#eef9ef]"
                              }`}
                            >
                              {fmtPrice(price)}
                            </summary>
                            <div
                              className={`absolute z-40 w-[136px] rounded-[4px] border border-[#eee] bg-white p-2 shadow-[0_4px_16px_rgba(0,0,0,0.12)] ${
                                d.day > daysInMonth - 2 ? "right-0" : "left-0"
                              } ${rtIndex === roomTypes.length - 1 ? "bottom-0" : "top-0"}`}
                            >
                              <div className="mb-1 text-[11px] leading-[15px] text-[#888]">
                                {rt.name} · {d.day} 日
                              </div>
                              <form action={updateRateCalendarFormAction}>
                                <input type="hidden" name="room_type_id" value={rt.id} />
                                <input type="hidden" name="date" value={d.date} />
                                <input type="hidden" name="month" value={month} />
                                <input
                                  name="price"
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  defaultValue={price}
                                  aria-label={`${rt.name} ${d.date} 房价`}
                                  className={`${INPUT} w-full text-center tabular-nums`}
                                />
                                <button type="submit" className={`${BTN_PRIMARY} mt-1.5 w-full`}>
                                  保存
                                </button>
                              </form>
                            </div>
                          </details>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            <span>本月 {daysInMonth} 天 · {roomTypes.length} 个房型</span>
            <span>周末列底色为黄色，今日列底色为蓝色</span>
            <span>修改房价不会影响已入住房价的账单</span>
          </div>
        </Section>
      )}

      {activeTab === "packages" && (
        <Section
          id="packages"
          title="包价设置"
          desc="打包售卖的产品（含早 / 含餐等），可在预订、入住时选择"
          extra={<span className="text-[11px] text-[#999]">共 {packages.length} 个包价</span>}
        >
          <form
            action={createPackageFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="pkg_code">
                包价代码
              </label>
              <input id="pkg_code" name="code" className={`${INPUT} w-28`} placeholder="如 PKG-BF" />
            </div>
            <div>
              <label className="label" htmlFor="pkg_name">
                包价名称
              </label>
              <input id="pkg_name" name="name" className={`${INPUT} w-36`} placeholder="如 含双早包价" />
            </div>
            <div>
              <label className="label" htmlFor="pkg_price">
                包价金额
              </label>
              <input id="pkg_price" name="price" type="number" min="0" step="0.01" defaultValue={0} className={`${INPUT} w-24`} />
            </div>
            <div>
              <label className="label" htmlFor="pkg_breakfast">
                含早餐
              </label>
              <input
                id="pkg_breakfast"
                name="breakfast_count"
                type="number"
                min={0}
                max={9}
                defaultValue={2}
                className={`${INPUT} w-20`}
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="label" htmlFor="pkg_items">
                包价内容
              </label>
              <input id="pkg_items" name="items" className={`${INPUT} w-full`} placeholder="如 标准房 1 晚 + 双人早餐" />
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增包价
            </button>
          </form>
          {/* 去呼呼的包价设置是卡片网格，每张卡片一个包价 */}
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
            {packages.length === 0 && (
              <div className="col-span-full py-8 text-center text-[12px] text-[#999]">
                暂无包价，请使用上方表单新增
              </div>
            )}
            {packages.map((p) => (
              <div key={p.id} className="rounded-[2px] border border-[#eee] bg-[#f5f5f5] px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-[13px] ${p.status === "ACTIVE" ? "text-[#333]" : "text-[#aaa] line-through"}`}>
                    {p.name}
                  </span>
                  <form action={deletePackageFormAction} className="shrink-0">
                    <input type="hidden" name="id" value={p.id} />
                    <button
                      type="submit"
                      title="删除该包价"
                      className="text-[#bbb] hover:text-rose-500"
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </button>
                  </form>
                </div>
                <div className="mt-1 truncate text-[11px] text-[#999]">
                  {p.code} · {fmtMoney(p.price)} · 早 {p.breakfast_count} 份
                  {p.status !== "ACTIVE" && " · 已停用"}
                </div>
                {p.items && <div className="mt-0.5 truncate text-[11px] text-[#999]" title={p.items}>{p.items}</div>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {activeTab === "debit-items" && (
        <Section
          id="debit-items"
          title="消费项目"
          desc="可挂入客账的收费项目（房费 / 餐饮 / 洗衣 / 迷你吧等），停用后不再出现在开单选择列表"
          extra={<span className="text-[11px] text-[#999]">共 {debitItems.length} 个项目</span>}
        >
          <form
            action={createDebitItemFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="debit_name">
                项目名称
              </label>
              <input id="debit_name" name="name" className={`${INPUT} w-40`} placeholder="如 洗衣服务" />
            </div>
            <div>
              <label className="label" htmlFor="debit_category">
                分类
              </label>
              <input
                id="debit_category"
                name="category"
                list="debit-category-options"
                defaultValue="其他"
                className={`${INPUT} w-32`}
              />
              <datalist id="debit-category-options">
                {["房费", "餐饮", "洗衣", "迷你吧", "其他"].map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label" htmlFor="debit_price">
                默认单价
              </label>
              <input
                id="debit_price"
                name="price"
                type="number"
                min="0"
                step="0.01"
                defaultValue={0}
                className={`${INPUT} w-28`}
              />
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增消费项目
            </button>
            <span className="text-[11px] text-[#999]">分类可自由填写，已内置房费 / 餐饮 / 洗衣 / 迷你吧联想</span>
          </form>
          {/* 去呼呼的消费项目是 4 列卡片网格，不是表格 */}
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
            {debitItems.length === 0 && (
              <div className="col-span-full py-8 text-center text-[12px] text-[#999]">
                暂无消费项目，请使用上方表单新增
              </div>
            )}
            {debitItems.map((item) => (
              <div key={item.id} className="rounded-[2px] border border-[#eee] bg-[#f5f5f5] px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-[13px] ${item.status === "ACTIVE" ? "text-[#333]" : "text-[#aaa] line-through"}`}>
                    {item.name}
                  </span>
                  <form action={toggleDebitItemStatusFormAction} className="shrink-0">
                    <input type="hidden" name="id" value={item.id} />
                    <button
                      type="submit"
                      title={item.status === "ACTIVE" ? "停用该项目" : "启用该项目"}
                      className="text-[#bbb] hover:text-[#0f8f6f]"
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </form>
                </div>
                <div className="mt-1 truncate text-[11px] text-[#999]">
                  {item.category || "其他"}
                  {Number(item.price) > 0 && ` · ${fmtMoney(item.price)}`}
                  {item.status !== "ACTIVE" && " · 已停用"}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {activeTab === "credit-items" && (
        <Section
          id="credit-items"
          title="收款项目"
          desc="收银台可选的收款方式，支付方式标识与收款流水 payments.method 取值保持一致"
          extra={<span className="text-[11px] text-[#999]">共 {creditItems.length} 个项目</span>}
        >
          <form
            action={createCreditItemFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="credit_name">
                项目名称
              </label>
              <input id="credit_name" name="name" className={`${INPUT} w-40`} placeholder="如 微信收款" />
            </div>
            <div>
              <label className="label" htmlFor="credit_method">
                支付方式标识
              </label>
              <input
                id="credit_method"
                name="method"
                list="credit-method-options"
                defaultValue="现金"
                className={`${INPUT} w-36`}
              />
              <datalist id="credit-method-options">
                {["现金", "微信", "支付宝", "银行卡", "挂账"].map((method) => (
                  <option key={method} value={method} />
                ))}
              </datalist>
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增收款项目
            </button>
            <span className="text-[11px] text-[#999]">标识直接写入收款流水，建议沿用 现金 / 微信 / 支付宝 / 银行卡 / 挂账</span>
          </form>
          {/* 去呼呼的「支付方式」也是 4 列卡片网格 */}
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
            {creditItems.length === 0 && (
              <div className="col-span-full py-8 text-center text-[12px] text-[#999]">
                暂无支付方式，请使用上方表单新增
              </div>
            )}
            {creditItems.map((item) => (
              <div key={item.id} className="rounded-[2px] border border-[#eee] bg-[#f5f5f5] px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-[13px] ${item.status === "ACTIVE" ? "text-[#333]" : "text-[#aaa] line-through"}`}>
                    {item.name}
                  </span>
                  <form action={toggleCreditItemStatusFormAction} className="shrink-0">
                    <input type="hidden" name="id" value={item.id} />
                    <button
                      type="submit"
                      title={item.status === "ACTIVE" ? "停用该支付方式" : "启用该支付方式"}
                      className="text-[#bbb] hover:text-[#0f8f6f]"
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </form>
                </div>
                <div className="mt-1 truncate text-[11px] text-[#999]">
                  标识 {item.method || "现金"}
                  {item.status !== "ACTIVE" && " · 已停用"}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {activeTab === "hourly" && (
        <Section
          id="hourly"
          title="钟点房收费设置"
          desc="按房型配置钟点房的基础时长、基础收费、超时收费标准与全房费收取规则"
          extra={<span className="text-[11px] text-[#999]">共 {hourlyRows.length} 个房型</span>}
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>房型</th>
                  <th className={`${TH} text-left`}>基础时长</th>
                  <th className={`${TH} text-left`}>基础收费</th>
                  <th className={`${TH} text-left`}>超时收费标准</th>
                  <th className={`${TH} text-left`}>全房费收取规则</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {hourlyRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className={`${TD} py-10 text-center text-[12px] text-[#999]`}>
                      <span className="text-[#f0a020]">⚠</span> 暂无房型列表
                    </td>
                  </tr>
                )}
                {hourlyRows.map((row) => (
                  <tr key={row.room_type_id} className={ROW_HOVER}>
                    <td className={`${TD} font-medium text-[#222]`}>{row.type_name}</td>
                    <td className={TD}>
                      <input
                        form={`hourly-form-${row.room_type_id}`}
                        name="base_hours"
                        type="number"
                        min={1}
                        max={24}
                        step={1}
                        defaultValue={row.base_hours}
                        aria-label={`${row.type_name} 基础时长`}
                        className={`${INPUT} w-20 tabular-nums`}
                      />
                      <span className="ml-1 text-[11px] text-[#999]">小时</span>
                    </td>
                    <td className={TD}>
                      <input
                        form={`hourly-form-${row.room_type_id}`}
                        name="base_price"
                        type="number"
                        min={0}
                        step="0.01"
                        defaultValue={row.base_price}
                        aria-label={`${row.type_name} 基础收费`}
                        className={`${INPUT} w-24 tabular-nums`}
                      />
                    </td>
                    <td className={TD}>
                      <input
                        form={`hourly-form-${row.room_type_id}`}
                        name="overtime_rate"
                        type="number"
                        min={0}
                        step="0.01"
                        defaultValue={row.overtime_rate}
                        aria-label={`${row.type_name} 超时收费`}
                        className={`${INPUT} w-24 tabular-nums`}
                      />
                      <span className="ml-1 text-[11px] text-[#999]">/小时</span>
                    </td>
                    <td className={TD}>
                      <input
                        form={`hourly-form-${row.room_type_id}`}
                        name="full_day_rule"
                        defaultValue={row.full_day_rule}
                        aria-label={`${row.type_name} 全房费规则`}
                        className={`${INPUT} w-52`}
                      />
                    </td>
                    <td className={`${TD} text-right`}>
                      <form id={`hourly-form-${row.room_type_id}`} action={saveHourlyRateAction} className="inline-block">
                        <input type="hidden" name="room_type_id" value={row.room_type_id} />
                        <button type="submit" className={`${BTN_SECOND} px-2`}>
                          保存
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-[#eee] px-3 py-2 text-[11px] leading-[18px] text-[#999]">
            钟点房报价 = 基础收费 + 超出基础时长的整点小时数 × 超时收费标准，且不超过全天房费；达到全房费规则里的「满
            N 小时」时按全天房费收取。保存后前台「转钟点房」立即按此计算（P1-29）；从未保存过配置的房型仍按门市价 ×
            15% × 小时数折算，表格里显示的是该口径换算成配置后的等价值。
          </p>
        </Section>
      )}

      {activeTab === "salesmen" && (
        <Section
          id="salesmen"
          title="销售员管理"
          desc="销售员与佣金比例，停用后不再出现在销售员选择列表中"
          extra={<span className="text-[11px] text-[#999]">共 {salesmen.length} 人</span>}
        >
          <form
            action={createSalesmanFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="sm_name">
                姓名
              </label>
              <input id="sm_name" name="name" className={`${INPUT} w-36`} placeholder="如 张伟" />
            </div>
            <div>
              <label className="label" htmlFor="sm_phone">
                手机号
              </label>
              <input id="sm_phone" name="phone" className={`${INPUT} w-36`} placeholder="13800001111" />
            </div>
            <div>
              <label className="label" htmlFor="sm_commission">
                佣金率（%）
              </label>
              <input
                id="sm_commission"
                name="commission_rate"
                type="number"
                min="0"
                max="100"
                step="0.1"
                defaultValue={5}
                className={`${INPUT} w-24`}
              />
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增销售员
            </button>
            <span className="text-[11px] text-[#999]">佣金率按百分数填写，5 表示 5%</span>
          </form>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>姓名</th>
                  <th className={`${TH} text-left`}>手机号</th>
                  <th className={`${TH} text-left`}>状态</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {salesmen.length === 0 && (
                  <tr>
                    <td colSpan={4} className={`${TD} py-10 text-center text-[12px] text-[#999]`}>
                      <span className="text-[#f0a020]">⚠</span> 暂无销售员信息
                    </td>
                  </tr>
                )}
                {salesmen.map((s) => (
                  <tr key={s.id} className={ROW_HOVER}>
                    <td className={`${TD} font-medium text-[#222]`}>
                      {s.name}
                      <span className="ml-1.5 text-[11px] text-[#999]">
                        佣金 {Number(s.commission_rate ?? 0).toFixed(1)}%
                      </span>
                    </td>
                    <td className={`${TD} tabular-nums text-[#555]`}>{s.phone || "—"}</td>
                    <td className={TD}>
                      <StatusBadge active={s.status === "ACTIVE"} />
                    </td>
                    <td className={`${TD} text-right`}>
                      <form action={toggleSalesmanStatusFormAction} className="inline-block">
                        <input type="hidden" name="id" value={s.id} />
                        <button
                          type="submit"
                          className={`${s.status === "ACTIVE" ? BTN_DANGER : BTN_SECOND} px-2`}
                        >
                          {s.status === "ACTIVE" ? "停用" : "启用"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {activeTab === "roles" && (
        <Section
          id="roles"
          title="角色权限（历史配置 · 只读）"
          desc="本页签展示 roles.permissions 里保存过的历史勾选结果；它不参与任何接口判断，也不能再从这里修改权限"
          extra={<span className="text-[11px] text-[#999]">共 {roles.length} 个角色</span>}
        >
          {/*
            整改清单 P1-33：这一块原来是一个可提交的表单，保存时把勾选项写进
            roles.permissions —— 而全项目没有任何地方读这一列（`grep "FROM roles"`
            只有 COUNT(*) 与 SELECT name）。管理员勾选、保存、看到「已保存…立即生效」，
            实际上行为零变化，属于「假开关」。
            现已删除 updateRolePermissionsFormAction，这里改为只读展示 + 指路。
          */}
          <div className="border-b border-[#f3c6c6] bg-[#fdf3f3] px-3 py-2 text-[12px] leading-relaxed text-[#c0392b]">
            <b>这一页签不再生效</b>：原来保存的 roles.permissions 不参与任何权限判断。
            真正会拦截接口与页面的是按「角色 × 权限点」落库的 role_permissions / role_modules，
            请在
            <Link href="/settings?tab=rbac" className="mx-1 underline">
              「权限矩阵」
            </Link>
            页签里配置，保存后立即生效（action 会调用 invalidatePermissionCache）。
          </div>
          {roles.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-[#999]">暂无角色数据，请刷新页面自动初始化</div>
          ) : (
            <div className="grid gap-2.5 p-3 lg:grid-cols-2">
              {roles.map((role) => {
                const granted = parsePermissions(role.permissions);
                const userCount = roleUserCounts.get(role.code) ?? 0;
                return (
                  <div key={role.id} className="rounded-[4px] border border-[#eee] bg-[#fafafa] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-[#222]">
                          {role.name || ROLE_LABEL[role.code] || role.code}
                        </span>
                        <span className="rounded-[2px] border border-[#eee] bg-[#f7f7f7] px-1 text-[11px] leading-[15px] text-[#888]">
                          {role.code}
                        </span>
                      </div>
                      <span className="text-[11px] text-[#999]">{userCount} 名操作员</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {granted.length === 0 ? (
                        <span className="text-[11px] text-[#999]">未保存任何历史权限项</span>
                      ) : (
                        granted.map((code) => (
                          <span
                            key={code}
                            className="rounded-[2px] border border-[#eee] bg-white px-1 text-[11px] leading-[16px] text-[#888]"
                          >
                            {PERMISSIONS.find((p) => p.code === code)?.label ?? code}
                          </span>
                        ))
                      )}
                    </div>
                    <div className="mt-2 text-[11px] text-[#999]">仅展示历史值，不参与接口判断</div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {activeTab === "rbac" && rbacView && (
        <Section
          id="rbac"
          title="权限矩阵"
          desc="勾选直接决定接口与页面放行：保存后 action 会调用 invalidatePermissionCache()，下一次请求立即按新权限判断（数据表 role_permissions / role_modules，判断逻辑见 src/lib/session.ts）"
          extra={
            <span className={`text-[11px] ${rbacView.dbBacked ? "text-[#999]" : "text-[#e04545]"}`}>
              {rbacView.dbBacked ? "当前权限来源：数据库" : "数据库中还没有本店权限配置，正在使用内置默认值"}
            </span>
          }
        >
          {user.role !== "admin" ? (
            <div className="px-3 py-8 text-center text-[12px] text-[#999]">只有管理员可以配置角色权限</div>
          ) : (
            <div className="space-y-3 p-3">
              {/* ---------- 动作级权限：4 个角色 × 每个权限点 ---------- */}
              <form
                action={saveRolePermissionsFormAction}
                className="overflow-hidden rounded-[4px] border border-[#eee]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2">
                  <div className="text-[12px] font-medium text-[#444]">
                    动作级权限（{rbacView.dict.length} 个权限点 · 接口与 Server Action 判断）
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[#999]">
                    <span>管理员始终拥有全部权限，不参与勾选</span>
                    <button type="submit" className={`${BTN_PRIMARY} px-3`}>
                      保存动作权限
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={`${TH} text-left`}>权限点</th>
                        <th className={`${TH} text-left`}>说明</th>
                        {RBAC_ROLE_CODES.map((role) => (
                          <th key={role} className={`${TH} w-[76px] text-center`} title={role}>
                            {ROLE_LABEL[role] ?? role}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...rbacGroups.entries()].flatMap(([group, rows]) => [
                        <tr key={`group-${group}`}>
                          <td
                            colSpan={2 + RBAC_ROLE_CODES.length}
                            className="border-b border-[#eee] bg-[#f7f7f7] px-2 py-[3px] text-[11px] font-medium text-[#888]"
                          >
                            {PERMISSION_MODULE_LABELS[group] ?? group}
                          </td>
                        </tr>,
                        ...rows.map((row) => (
                          <tr key={row.permission} className={ROW_HOVER}>
                            <td className={`${TD} whitespace-nowrap font-mono text-[11px] text-[#666]`}>
                              {row.permission}
                            </td>
                            <td className={TD}>
                              <span className="text-[#333]">{row.label}</span>
                              {row.description && (
                                <span className="ml-1.5 text-[11px] text-[#aaa]">{row.description}</span>
                              )}
                            </td>
                            {RBAC_ROLE_CODES.map((role) => (
                              <td key={role} className={`${TD} text-center`}>
                                {role === "admin" ? (
                                  <input
                                    type="checkbox"
                                    defaultChecked
                                    disabled
                                    aria-label={`管理员 ${row.label}（始终允许）`}
                                    className="h-3.5 w-3.5 accent-[#32c141]"
                                  />
                                ) : (
                                  <input
                                    type="checkbox"
                                    name={`perm:${role}`}
                                    value={row.permission}
                                    defaultChecked={rbacView.granted.get(role)?.has(row.permission) ?? false}
                                    aria-label={`${ROLE_LABEL[role] ?? role} ${row.label}`}
                                    className="h-3.5 w-3.5 accent-[#32c141]"
                                  />
                                )}
                              </td>
                            ))}
                          </tr>
                        )),
                      ])}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-[#eee] px-3 py-1.5 text-[11px] leading-[16px] text-[#999]">
                  保存时按角色「删旧写新」在同一个事务里完成；角色至少保留一项（勾空会回落到内置默认权限）。
                  修改 booking.create 这类权限后，下一个请求就会被 requirePermission() 拒掉，无需重启服务。
                </p>
              </form>

              {/* ---------- 页面可见模块：4 个角色 × 模块前缀 ---------- */}
              <form action={saveRoleModulesFormAction} className="overflow-hidden rounded-[4px] border border-[#eee]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2">
                  <div className="text-[12px] font-medium text-[#444]">
                    可见页面模块（{rbacView.moduleList.length} 个模块 · 路由守卫 canAccess）
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[#999]">
                    <span>命中前缀即放行，如 /rooms 同时放行 /rooms/123</span>
                    <button type="submit" className={`${BTN_PRIMARY} px-3`}>
                      保存页面权限
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={`${TH} text-left`}>页面模块（路由前缀）</th>
                        {RBAC_ROLE_CODES.map((role) => {
                          const all = rbacView.roleModules.get(role)?.has("*") ?? false;
                          return (
                            <th key={role} className={`${TH} w-[76px] text-center`} title={role}>
                              {ROLE_LABEL[role] ?? role}
                              {all && <span className="ml-0.5 text-[10px] text-[#e04545]">全部</span>}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rbacView.moduleList.map((module) => (
                        <tr key={module} className={ROW_HOVER}>
                          <td className={`${TD} whitespace-nowrap font-mono text-[11px] text-[#666]`}>{module}</td>
                          {RBAC_ROLE_CODES.map((role) => {
                            const picked = rbacView.roleModules.get(role);
                            // 库里是 "*"（全部页面）时把整列都勾上，避免「明明全部可见却显示全空」的误解
                            const checked = picked?.has("*") ? true : (picked?.has(module) ?? false);
                            return (
                              <td key={role} className={`${TD} text-center`}>
                                {role === "admin" ? (
                                  <input
                                    type="checkbox"
                                    defaultChecked
                                    disabled
                                    aria-label={`管理员 ${module}（始终允许）`}
                                    className="h-3.5 w-3.5 accent-[#32c141]"
                                  />
                                ) : (
                                  <input
                                    type="checkbox"
                                    name={`mod:${role}`}
                                    value={module}
                                    defaultChecked={checked}
                                    aria-label={`${ROLE_LABEL[role] ?? role} ${module}`}
                                    className="h-3.5 w-3.5 accent-[#32c141]"
                                  />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-[#eee] px-3 py-1.5 text-[11px] leading-[16px] text-[#999]">
                  保存后主布局的 canAccess() 立即按新模块判断；角色至少保留一个模块（勾空会回落到内置默认模块）。
                </p>
              </form>
            </div>
          )}
        </Section>
      )}

      {activeTab === "params" && (
        <Section id="params" title="系统参数" desc="入住 / 退房 / 夜审时间格式 HH:mm；保存后立即生效">
          <div className="grid gap-2.5 p-3 sm:grid-cols-2 xl:grid-cols-3">
            <TimeParam
              settingKey="check_in_time"
              label="入住时间"
              value={checkIn}
              desc="标准入住时间，早于该时间视为提前入住"
            />
            <TimeParam
              settingKey="check_out_time"
              label="退房时间"
              value={checkOut}
              desc="标准退房时间，超过该时间按加收半天房费处理"
            />
            <TimeParam
              settingKey="night_audit_time"
              label="夜审时间"
              value={nightAudit}
              desc="每日自动夜审开始时间，默认 02:00"
            />
            <NumberParam
              settingKey="cancel_timeout_minutes"
              label="超时取消（分钟）"
              value={cancelTimeout}
              min={0}
              max={720}
              desc="预订超过该分钟数未确认则自动取消，0 表示不自动取消"
            />
            <ParamCard title="是否允许超订" desc="允许后房量售完仍可接单，仅做提示，不会拦截">
              <form action={updateSettingFormAction} className="flex items-center gap-2">
                <input type="hidden" name="key" value="allow_overbooking" />
                <select
                  id="allow_overbooking"
                  name="value"
                  defaultValue={allowOverbooking === "1" ? "1" : "0"}
                  aria-label="是否允许超订"
                  className={`${INPUT} w-32`}
                >
                  <option value="0">不允许</option>
                  <option value="1">允许</option>
                </select>
                <button type="submit" className={`${BTN_PRIMARY} px-3`}>
                  保存
                </button>
              </form>
            </ParamCard>
            <ParamCard title="默认房价代码" desc="预订 / 入住默认带出的房价方案，取自 rate_plans">
              <form action={updateSettingFormAction} className="flex items-center gap-2">
                <input type="hidden" name="key" value="default_rate_code" />
                <select
                  id="default_rate_code"
                  name="value"
                  defaultValue={defaultRateCode}
                  aria-label="默认房价代码"
                  className={`${INPUT} w-40`}
                >
                  {ratePlans.length === 0 && <option value="门市价">门市价</option>}
                  {ratePlans.map((plan) => (
                    <option key={plan.id} value={plan.name ?? ""}>
                      {plan.name ?? "未命名方案"}
                    </option>
                  ))}
                  {ratePlans.length > 0 && ratePlans.every((plan) => (plan.name ?? "") !== defaultRateCode) && (
                    <option value={defaultRateCode}>{defaultRateCode}</option>
                  )}
                </select>
                <button type="submit" className={`${BTN_PRIMARY} px-3`}>
                  保存
                </button>
              </form>
            </ParamCard>
            <TextParam
              settingKey="receipt_header"
              label="打印小票抬头"
              value={receiptHeader}
              maxLength={40}
              desc="收银小票与结账单顶部显示的抬头名称"
            />
          </div>
        </Section>
      )}

      {activeTab === "operators" && (
        <Section
          id="operators"
          title="操作员"
          desc="仅展示账号基础信息，密码等敏感字段不做展示"
          extra={<span className="text-[11px] text-[#999]">共 {operators.length} 个账号</span>}
        >
          <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${TH} text-left`}>用户名</th>
                <th className={`${TH} text-left`}>姓名</th>
                <th className={`${TH} text-left`}>角色</th>
              </tr>
            </thead>
            <tbody>
              {operators.length === 0 && (
                <tr>
                  <td colSpan={3} className={`${TD} py-8 text-center text-[#999]`}>
                    暂无操作员账号
                  </td>
                </tr>
              )}
              {operators.map((o) => (
                <tr key={o.id} className={ROW_HOVER}>
                  <td className={`${TD} tabular-nums text-[#222]`}>{o.username}</td>
                  <td className={`${TD} text-[#555]`}>{o.real_name ?? "—"}</td>
                  <td className={TD}>
                    <span className="rounded-[2px] border border-[#eee] bg-[#f7f7f7] px-1 text-[11px] leading-[15px] text-[#666]">
                      {ROLE_LABEL[o.role] ?? o.role}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Section>
      )}

      {activeTab === "floors" && (
        <Section
          id="floors"
          title="楼层设置"
          desc="维护楼层档案与显示顺序；优先级数字越小越靠前，楼层编号对应房间的楼层"
          extra={<span className="text-[11px] text-[#999]">共 {floors.length} 个楼层</span>}
        >
          <form
            action={createFloorFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="floor_name">
                楼层名称
              </label>
              <input id="floor_name" name="name" maxLength={20} className={`${INPUT} w-32`} placeholder="如 七层" />
            </div>
            <div>
              <label className="label" htmlFor="floor_code">
                楼层编号
              </label>
              <input id="floor_code" name="code" maxLength={10} className={`${INPUT} w-24`} placeholder="如 7" />
            </div>
            <div>
              <label className="label" htmlFor="floor_sort">
                优先级
              </label>
              <input
                id="floor_sort"
                name="sort"
                type="number"
                min={0}
                max={999}
                step={1}
                defaultValue={floors.length > 0 ? Math.max(...floors.map((f) => f.sort)) + 1 : 1}
                className={`${INPUT} w-20 tabular-nums`}
              />
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增楼层
            </button>
            <span className="text-[11px] text-[#999]">快速添加：楼层名称 + 楼层编号 + 优先级，保存后立即出现在房态与房间列表</span>
          </form>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} w-[110px] text-left`}>显示优先级</th>
                  <th className={`${TH} text-left`}>楼层名称</th>
                  <th className={`${TH} text-left`}>楼层编号</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {floors.length === 0 && (
                  <tr>
                    <td colSpan={4} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无楼层，请使用上方表单新增
                    </td>
                  </tr>
                )}
                {floors.map((f) => (
                  <tr key={f.id} className={ROW_HOVER}>
                    <td className={TD}>
                      <input
                        form={`floor-form-${f.id}`}
                        name="sort"
                        type="number"
                        min={0}
                        max={999}
                        step={1}
                        defaultValue={f.sort}
                        aria-label={`${f.name} 显示优先级`}
                        className={`${INPUT} w-20 tabular-nums`}
                      />
                    </td>
                    <td className={TD}>
                      <input
                        form={`floor-form-${f.id}`}
                        name="name"
                        defaultValue={f.name}
                        maxLength={20}
                        aria-label={`${f.name} 楼层名称`}
                        className={`${INPUT} w-36`}
                      />
                    </td>
                    <td className={TD}>
                      <input
                        form={`floor-form-${f.id}`}
                        name="code"
                        defaultValue={f.code}
                        maxLength={10}
                        aria-label={`${f.name} 楼层编号`}
                        className={`${INPUT} w-24`}
                      />
                    </td>
                    <td className={`${TD} text-right`}>
                      <form id={`floor-form-${f.id}`} action={updateFloorFormAction} className="inline-block">
                        <input type="hidden" name="id" value={f.id} />
                        <button type="submit" className={`${BTN_SECOND} px-2`}>
                          保存
                        </button>
                      </form>
                      <form action={deleteFloorFormAction} className="ml-1 inline-block">
                        <input type="hidden" name="id" value={f.id} />
                        <button type="submit" className={`${BTN_DANGER} px-2`}>
                          删除
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            存储位置：floors 表（name 楼层名称 / code 楼层编号 / sort 显示优先级）· 删除楼层不会删除该层房间
          </p>
        </Section>
      )}

      {activeTab === "rate-codes" && (
        <Section
          id="rate-codes"
          title="房价代码"
          desc="房价方案代码与折扣率，预订 / 入住时按折扣率折算门市价；停用后不再出现在选择列表"
          extra={<span className="text-[11px] text-[#999]">共 {rateCodes.length} 个代码</span>}
        >
          <form
            action={createRateCodeFormAction}
            className="flex flex-wrap items-end gap-2 border-b border-[#eee] bg-[#fafafa] px-3 py-2.5"
          >
            <div>
              <label className="label" htmlFor="rate_code_code">
                代码
              </label>
              <input id="rate_code_code" name="code" maxLength={20} className={`${INPUT} w-24`} placeholder="如 XYJ2" />
            </div>
            <div>
              <label className="label" htmlFor="rate_code_name">
                名称
              </label>
              <input id="rate_code_name" name="name" maxLength={20} className={`${INPUT} w-32`} placeholder="如 协议价 B" />
            </div>
            <div>
              <label className="label" htmlFor="rate_code_type">
                类型
              </label>
              <select id="rate_code_type" name="type" defaultValue="门市价" className={`${INPUT} w-28`}>
                {RATE_CODE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="rate_code_discount">
                折扣率
              </label>
              <input
                id="rate_code_discount"
                name="discount"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                defaultValue={1}
                className={`${INPUT} w-24 tabular-nums`}
              />
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增房价代码
            </button>
            <span className="text-[11px] text-[#999]">折扣率 1 表示不打折，0.85 表示 8.5 折</span>
          </form>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>显示优先级</th>
                  <th className={`${TH} text-left`}>房价名称</th>
                  <th className={`${TH} text-left`}>包价</th>
                  <th className={`${TH} text-left`}>房价类型</th>
                  <th className={`${TH} text-left`}>是否有效</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rateCodes.length === 0 && (
                  <tr>
                    <td colSpan={6} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无房价代码，请使用上方表单新增
                    </td>
                  </tr>
                )}
                {rateCodes.map((rc) => (
                  <tr key={rc.id} className={ROW_HOVER}>
                    <td className={`${TD} tabular-nums text-[#555]`}>{rc.sort ?? 99}</td>
                    <td className={`${TD} font-medium text-[#222]`}>
                      {rc.name}
                      <span className="ml-1.5 rounded-[2px] border border-[#eee] bg-[#f7f7f7] px-1 text-[11px] leading-[15px] text-[#888]">
                        {rc.code}
                      </span>
                    </td>
                    <td className={`${TD} text-[#666]`}>{rc.package_code || "无"}</td>
                    <td className={TD}>
                      <span className="rounded-[2px] border border-[#d8f2dd] bg-[#f3fbf4] px-1 text-[11px] leading-[15px] text-[#2a9d3a]">
                        {rc.type}
                      </span>
                    </td>
                    <td className={TD}>
                      <StatusBadge active={rc.status === "ACTIVE"} />
                    </td>
                    <td className={`${TD} text-right`}>
                      <form id={`rate-code-form-${rc.id}`} action={updateRateCodeFormAction} className="inline-block">
                        <input type="hidden" name="id" value={rc.id} />
                        <input type="hidden" name="code" value={rc.code} />
                        <input type="hidden" name="name" value={rc.name} />
                        <input type="hidden" name="type" value={rc.type} />
                        <button type="submit" className={`${BTN_SECOND} px-2`}>
                          保存折扣
                        </button>
                      </form>
                      <form action={toggleRateCodeStatusFormAction} className="ml-1 inline-block">
                        <input type="hidden" name="id" value={rc.id} />
                        <button
                          type="submit"
                          className={`${rc.status === "ACTIVE" ? BTN_DANGER : BTN_SECOND} px-2`}
                        >
                          {rc.status === "ACTIVE" ? "停用" : "启用"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            存储位置：rate_codes 表（code 代码 / type 类型 / discount 折扣率 / status 状态）
          </p>
        </Section>
      )}

      {activeTab === "authority" && (
        <Section
          id="authority"
          title="岗位与员工"
          desc="岗位决定可使用的功能模块；员工归属岗位后按岗位权限使用系统"
          extra={
            <span className="text-[11px] text-[#999]">
              {positions.length} 个岗位 · {staff.length} 名员工
            </span>
          }
        >
          <div className="border-b border-[#eee] bg-[#fafafa] px-3 py-2 text-[12px] font-medium text-[#444]">岗位管理</div>
          <form action={createPositionFormAction} className="flex flex-wrap items-end gap-2 border-b border-[#eee] px-3 py-2.5">
            <div>
              <label className="label" htmlFor="position_name">
                岗位名称
              </label>
              <input id="position_name" name="name" maxLength={20} className={`${INPUT} w-36`} placeholder="如 店长" />
            </div>
            <div>
              <span className="label">权限项</span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-1">
                {PERMISSIONS.map((permission) => (
                  <label
                    key={permission.code}
                    className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[#555]"
                  >
                    <input
                      type="checkbox"
                      name="permissions"
                      value={permission.code}
                      className="h-3.5 w-3.5 accent-[#32c141]"
                    />
                    {permission.label}
                  </label>
                ))}
              </div>
            </div>
            <button type="submit" className={BTN_PRIMARY}>
              新增岗位
            </button>
            <span className="text-[11px] text-[#999]">权限项至少勾选一项</span>
          </form>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>岗位</th>
                  <th className={`${TH} text-right`}>在岗人数</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 && (
                  <tr>
                    <td colSpan={3} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无岗位，请使用上方表单新增
                    </td>
                  </tr>
                )}
                {positions.map((position) => {
                  const granted = parsePermissions(position.permissions);
                  const headcount = positionHeadcount.get(position.id) ?? 0;
                  return (
                    <tr key={position.id} className={ROW_HOVER}>
                      <td className={`${TD} font-medium text-[#222]`}>{position.name}</td>
                      <td className={`${TD} text-right tabular-nums text-[#555]`}>{headcount}</td>
                      <td className={`${TD} text-right`}>
                        <details className="relative inline-block">
                          <summary
                            className={`${BTN_SECOND} inline-flex cursor-pointer list-none items-center gap-1 px-2 [&::-webkit-details-marker]:hidden`}
                          >
                            查看权限（{granted.length} 项）
                          </summary>
                          <form
                            action={updatePositionFormAction}
                            className="absolute right-0 z-20 mt-1 w-[300px] rounded border border-[#e5e5e5] bg-white p-2.5 shadow-lg"
                          >
                            <input type="hidden" name="id" value={position.id} />
                            <input type="hidden" name="name" value={position.name} />
                            <div className="mb-1.5 text-[12px] font-medium text-[#333]">分配权限</div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {PERMISSIONS.map((permission) => (
                                <label
                                  key={permission.code}
                                  className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[#555]"
                                >
                                  <input
                                    type="checkbox"
                                    name="permissions"
                                    value={permission.code}
                                    defaultChecked={granted.includes(permission.code)}
                                    className="h-3.5 w-3.5 accent-[#32c141]"
                                  />
                                  {permission.label}
                                </label>
                              ))}
                            </div>
                            <button type="submit" className={`${BTN_PRIMARY} mt-2 w-full`}>
                              保存权限
                            </button>
                          </form>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-[#eee] bg-[#fafafa] px-3 py-2">
            <span className="text-[12px] font-medium text-[#444]">员工管理</span>
            <span className="text-[11px] text-[#999]">
              账号密码只以 scrypt 哈希落库；有在住单 / 未结账明细的账号请用「停用」而不是删除
            </span>
          </div>

          {/*
            整改清单 P2-30：新增员工账号入口。
            原来全项目没有任何 `INSERT INTO users` —— 账号泄露只能删号重建，
            user.manage 权限点因此永远用不上。折叠起来，避免日常不常建号时占满屏。
          */}
          <details className="border-b border-[#eee] bg-white">
            <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-[#2a9d5c] [&::-webkit-details-marker]:hidden">
              + 新增员工账号
            </summary>
            <form action={createStaffFormAction} className="grid gap-2 border-t border-[#eee] p-3 md:grid-cols-3 lg:grid-cols-6">
              <div>
                <label className="label" htmlFor="staff-username">
                  登录账号 *
                </label>
                <input
                  id="staff-username"
                  name="username"
                  required
                  placeholder="3-20 位字母数字"
                  className={`${INPUT} w-full`}
                />
              </div>
              <div>
                <label className="label" htmlFor="staff-realname">
                  员工姓名
                </label>
                <input id="staff-realname" name="real_name" className={`${INPUT} w-full`} />
              </div>
              <div>
                <label className="label" htmlFor="staff-mobile">
                  联系方式
                </label>
                <input id="staff-mobile" name="mobile" className={`${INPUT} w-full`} />
              </div>
              <div>
                <label className="label" htmlFor="staff-role">
                  角色 *
                </label>
                <select id="staff-role" name="role" defaultValue="frontdesk" className={`${INPUT} w-full`}>
                  {["admin", "manager", "frontdesk", "cashier", "housekeeping"].map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role] ?? role}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="staff-password">
                  初始密码 *
                </label>
                <input
                  id="staff-password"
                  name="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  className={`${INPUT} w-full`}
                />
              </div>
              <div>
                <label className="label" htmlFor="staff-confirm">
                  确认密码 *
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id="staff-confirm"
                    name="confirm_password"
                    type="password"
                    required
                    autoComplete="new-password"
                    className={`${INPUT} w-full`}
                  />
                  <button type="submit" className={`${BTN_PRIMARY} shrink-0 px-2.5`}>
                    建号
                  </button>
                </div>
              </div>
            </form>
          </details>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>员工姓名</th>
                  <th className={`${TH} text-left`}>联系方式</th>
                  <th className={`${TH} text-left`}>角色</th>
                  <th className={`${TH} text-left`}>岗位</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {staff.length === 0 && (
                  <tr>
                    <td colSpan={5} className={`${TD} py-8 text-center text-[#999]`}>
                      暂无员工账号
                    </td>
                  </tr>
                )}
                {staff.map((member) => {
                  const active = Number(member.status ?? 0) === 1;
                  const needChange = Number(member.must_change_password ?? 0) === 1;
                  return (
                    <tr key={member.id} className={ROW_HOVER}>
                      <td className={`${TD} font-medium text-[#222]`}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>{member.real_name ?? member.username}</span>
                          <span className="rounded-[2px] border border-[#eee] bg-[#f7f7f7] px-1 text-[11px] leading-[15px] text-[#888]">
                            {member.username}
                          </span>
                          {!active && (
                            <span className="rounded-[2px] bg-[#f5f5f5] px-1 text-[11px] leading-[15px] text-[#999]">
                              已停用
                            </span>
                          )}
                          {needChange && (
                            <span
                              className="rounded-[2px] bg-[#fff7e6] px-1 text-[11px] leading-[15px] text-[#b8860b]"
                              title="管理员重置过密码，本人应尽快自行改密"
                            >
                              待改密
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`${TD} tabular-nums text-[#555]`}>{member.mobile ?? "—"}</td>
                      <td className={`${TD} text-[#555]`}>{ROLE_LABEL[member.role] ?? member.role}</td>
                      <td className={TD}>
                        <select
                          form={`staff-form-${member.id}`}
                          name="position_id"
                          defaultValue={member.position_id != null ? String(member.position_id) : "0"}
                          aria-label={`${member.username} 岗位`}
                          className={`${INPUT} w-32`}
                        >
                          <option value="0">未分配</option>
                          {positions.map((position) => (
                            <option key={position.id} value={position.id}>
                              {position.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={`${TD} text-right`}>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <form id={`staff-form-${member.id}`} action={updateUserPositionFormAction} className="inline-block">
                            <input type="hidden" name="user_id" value={member.id} />
                            <button type="submit" className={`${BTN_SECOND} px-2`}>
                              修改岗位
                            </button>
                          </form>

                          {/* 重置密码（P2-30）：旧密码立即失效，并打强制改密标记 */}
                          <details className="relative inline-block">
                            <summary
                              className={`${BTN_SECOND} inline-flex cursor-pointer list-none items-center px-2 [&::-webkit-details-marker]:hidden`}
                            >
                              重置密码
                            </summary>
                            <form
                              action={resetStaffPasswordFormAction}
                              className="absolute right-0 z-20 mt-1 w-[230px] rounded border border-[#e5e5e5] bg-white p-2.5 text-left shadow-lg"
                            >
                              <input type="hidden" name="user_id" value={member.id} />
                              <div className="mb-1.5 text-[12px] font-medium text-[#333]">
                                重置「{member.username}」的密码
                              </div>
                              <input
                                name="new_password"
                                type="password"
                                required
                                autoComplete="new-password"
                                placeholder="新密码 6-32 位"
                                className={`${INPUT} mb-1.5 w-full`}
                              />
                              <input
                                name="confirm_password"
                                type="password"
                                required
                                autoComplete="new-password"
                                placeholder="再次输入新密码"
                                className={`${INPUT} mb-1.5 w-full`}
                              />
                              <button type="submit" className={`${BTN_PRIMARY} w-full`}>
                                确认重置
                              </button>
                            </form>
                          </details>

                          <form action={toggleStaffStatusFormAction} className="inline-block">
                            <input type="hidden" name="user_id" value={member.id} />
                            <button type="submit" className={`${BTN_SECOND} px-2`}>
                              {active ? "停用" : "启用"}
                            </button>
                          </form>

                          {/* 删除员工（P1-31）：二次确认 + 服务端引用检查 */}
                          <ConfirmForm
                            action={deleteStaffAction}
                            message={`确认删除员工「${member.username}」？`}
                            detail="删除后该账号的登录权限立即消失，且无法恢复。有在住单 / 未结账明细 / 未交接班次的账号会被拒绝删除，请改用「停用」。"
                            confirmLabel="删除"
                          >
                            <input type="hidden" name="user_id" value={member.id} />
                            <button type="submit" className={`${BTN_DANGER} px-2`}>
                              删除员工
                            </button>
                          </ConfirmForm>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            存储位置：positions 表（岗位名称 + permissions JSON 数组）· users.position_id（员工归属岗位）· users.password_hash（scrypt）· users.must_change_password（重置密码后置 1）· 最后登录取自 users.last_login_at
          </p>
        </Section>
      )}

      {activeTab === "dicts" && (
        <Section
          id="dicts"
          title="原因与类型"
          desc="换房 / 锁房 / 维修房原因与 AR 账户类型，供各业务单据下拉选择"
          extra={<span className="text-[11px] text-[#999]">共 {dictItems.length} 条</span>}
        >
          <div className="grid gap-2.5 p-3 lg:grid-cols-2">
            {DICT_GROUPS.map((group) => {
              const items = dictByKind.get(group.kind) ?? [];
              return (
                <div key={group.kind} className="rounded-[4px] border border-[#eee] bg-white">
                  <div className="border-b border-[#eee] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-[#222]">{group.label}</span>
                      <span className="text-[11px] text-[#999]">{items.length} 条</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#999]">
                      {group.desc} · {group.kind}
                    </div>
                  </div>
                  <form
                    action={createDictItemFormAction}
                    className="flex items-center gap-1.5 border-b border-[#eee] bg-[#fafafa] px-3 py-2"
                  >
                    <input type="hidden" name="kind" value={group.kind} />
                    <input
                      name="name"
                      maxLength={30}
                      placeholder={`新增${group.label}`}
                      aria-label={`新增${group.label}`}
                      className={`${INPUT} w-full`}
                    />
                    <button type="submit" className={`${BTN_PRIMARY} px-2`}>
                      新增
                    </button>
                  </form>
                  <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <tbody>
                      {items.length === 0 && (
                        <tr>
                          <td className={`${TD} py-6 text-center text-[#999]`}>暂无{group.label}</td>
                        </tr>
                      )}
                      {items.map((item) => (
                        <tr key={item.id} className={ROW_HOVER}>
                          <td className={`${TD} text-[#333]`}>{item.name}</td>
                          <td className={`${TD} w-[80px] text-right`}>
                            <form action={deleteDictItemFormAction} className="inline-block">
                              <input type="hidden" name="id" value={item.id} />
                              <button type="submit" className={`${BTN_DANGER} px-2`}>
                                删除
                              </button>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            存储位置：dict_items 表（kind 区分用途 / name 名称 / sort 排序）
          </p>
        </Section>
      )}

      {activeTab === "hotel-info" && (
        <Section id="hotel-info" title="基本信息" desc="酒店对外展示名称、联系方式与地址" extra={null}>
          <form action={saveHotelInfoAction} className="grid gap-2.5 p-3 md:grid-cols-4">
            <input type="hidden" name="section" value="basic" />
            <div className="md:col-span-2">
              <label className="label">酒店名称</label>
              <input name="name" defaultValue={hotelInfoRows.name} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">酒店类型</label>
              <input name="type" defaultValue={hotelInfoRows.type} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">前台电话</label>
              <input name="phone" defaultValue={hotelInfoRows.phone} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">客服电话</label>
              <input name="service_phone" defaultValue={hotelInfoRows.servicePhone} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">所属省份</label>
              <input name="province" defaultValue={hotelInfoRows.province} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">所属城市</label>
              <input name="city" defaultValue={hotelInfoRows.city} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">所属区域</label>
              <input name="district" defaultValue={hotelInfoRows.district} className={`${INPUT} w-full`} />
            </div>
            <div className="md:col-span-4">
              <label className="label">详细地址</label>
              <input name="address" defaultValue={hotelInfoRows.address} className={`${INPUT} w-full`} />
            </div>
            <div>
              <button type="submit" className={BTN_PRIMARY}>
                修改信息
              </button>
            </div>
          </form>
        </Section>
      )}

      {activeTab === "hotel-info" && (
        <Section id="hotel-system" title="系统信息" desc="房费自动收取时间与营业日" extra={null}>
          <form action={saveHotelInfoAction} className="grid gap-2.5 p-3 md:grid-cols-4">
            <input type="hidden" name="section" value="system" />
            <div>
              <label className="label">半日房费收取时间</label>
              <input name="half_day_fee_time" defaultValue={hotelInfoRows.halfDayFeeTime} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">营业日</label>
              <input value={today} readOnly className={`${INPUT} w-full bg-[#f7f7f7]`} title="按下方切换时间自动计算" />
            </div>
            <div>
              <label className="label">营业日切换时间</label>
              <input
                name="biz_day_cutoff"
                defaultValue={hotelInfoRows.bizDayCutoff}
                placeholder="05:00"
                className={`${INPUT} w-full`}
                title="凌晨几点算新的一天；05:00 表示 05:00 前进店仍算前一营业日"
              />
            </div>
            <div>
              <label className="label">全日房费收取时间</label>
              <input name="full_day_fee_time" defaultValue={hotelInfoRows.fullDayFeeTime} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">夜审日期</label>
              <input value={today} readOnly className={`${INPUT} w-full bg-[#f7f7f7]`} />
            </div>
            <div>
              <button type="submit" className={BTN_PRIMARY}>
                修改信息
              </button>
            </div>
          </form>
        </Section>
      )}

      {activeTab === "hotel-info" && (
        <Section id="hotel-shifts" title="班次" desc="三班倒时间段，交接班与报表按班次统计" extra={null}>
          <form action={saveHotelInfoAction} className="grid gap-2.5 p-3 md:grid-cols-4">
            <input type="hidden" name="section" value="shifts" />
            <div>
              <label className="label">早班</label>
              <input name="shift_morning" defaultValue={hotelInfoRows.shiftMorning} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">中班</label>
              <input name="shift_middle" defaultValue={hotelInfoRows.shiftMiddle} className={`${INPUT} w-full`} />
            </div>
            <div>
              <label className="label">晚班</label>
              <input name="shift_night" defaultValue={hotelInfoRows.shiftNight} className={`${INPUT} w-full`} />
            </div>
            <div className="flex items-end">
              <button type="submit" className={BTN_PRIMARY}>
                修改班次
              </button>
            </div>
          </form>
        </Section>
      )}

      {activeTab === "hotel-info" && (
        <Section id="hotel-validity" title="有效期" desc="建店与到期时间，到期前请续费" extra={null}>
          <div className="grid gap-2.5 p-3 text-[12px] text-[#555] md:grid-cols-3">
            <div>
              建店时间：<b className="tabular-nums text-[#222]">{(hotelInfoRows.createdAt || "").slice(0, 19).replace("T", " ")}</b>
            </div>
            <div>
              到期时间：<b className="tabular-nums text-[#222]">{(hotelInfoRows.createdAt || "").slice(0, 10).replace(/(\d{4})/, (y) => String(Number(y) + 1))}</b>
            </div>
            <div>
              <button type="button" className={BTN_SECOND}>
                续费
              </button>
            </div>
          </div>
        </Section>
      )}

      {activeTab === "task-templates" && (
        <Section
          id="task-templates"
          title="任务中心"
          desc="保洁任务模板：按任务类型 / 楼层 / 房型配置工作内容与积分，派单时按模板生成任务"
          extra={<span className="text-[11px] text-[#999]">共 {cleaningTemplates.length} 条模板</span>}
        >
          <details className="border-b border-[#eee] bg-[#fafafa]">
            <summary className="cursor-pointer list-none px-3 py-2 text-[12px] text-[#0f8f6f] [&::-webkit-details-marker]:hidden">
              + 新建保洁任务
            </summary>
            <form action={saveCleaningTemplateAction} className="grid gap-2 px-3 pb-3 md:grid-cols-6">
              <div>
                <label className="label">任务类型</label>
                <input name="task_type" defaultValue="保洁" className={`${INPUT} w-full`} />
              </div>
              <div>
                <label className="label">楼层</label>
                <input name="floor" defaultValue="所有楼层" className={`${INPUT} w-full`} />
              </div>
              <div>
                <label className="label">房型</label>
                <input name="room_type" defaultValue="所有房型" className={`${INPUT} w-full`} />
              </div>
              <div>
                <label className="label">积分</label>
                <input name="points" type="number" min="0" defaultValue={4} className={`${INPUT} w-full tabular-nums`} />
              </div>
              <div className="md:col-span-2">
                <label className="label">保洁项目</label>
                <input name="work_items" placeholder="打扫卫生,更换布草(毛巾,浴巾)" className={`${INPUT} w-full`} />
              </div>
              <div className="md:col-span-2">
                <label className="label">补货项目</label>
                <input name="restock_items" placeholder="矿泉水" className={`${INPUT} w-full`} />
              </div>
              <div className="flex items-end">
                <button type="submit" className={BTN_PRIMARY}>
                  保存模板
                </button>
              </div>
            </form>
          </details>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>任务类型</th>
                  <th className={`${TH} text-left`}>楼层</th>
                  <th className={`${TH} text-left`}>房型</th>
                  <th className={`${TH} text-right`}>积分</th>
                  <th className={`${TH} text-left`}>工作内容</th>
                  <th className={`${TH} text-left`}>创建日期</th>
                  <th className={`${TH} text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {cleaningTemplates.length === 0 && (
                  <tr>
                    <td colSpan={7} className={`${TD} py-10 text-center text-[12px] text-[#999]`}>
                      ⚠ 暂无保洁任务模板
                    </td>
                  </tr>
                )}
                {cleaningTemplates.map((t) => (
                  <tr key={t.id} className={ROW_HOVER}>
                    <td className={`${TD} font-medium text-[#222]`}>{t.task_type}</td>
                    <td className={`${TD} text-[#555]`}>{t.floor}</td>
                    <td className={`${TD} text-[#555]`}>{t.room_type}</td>
                    <td className={`${TD} text-right tabular-nums text-[#555]`}>{t.points}</td>
                    <td className={`${TD} max-w-[420px] text-[#555]`}>
                      <div>保洁项目　{t.work_items || "—"}</div>
                      <div>补货项目　{t.restock_items || "—"}</div>
                    </td>
                    <td className={`${TD} tabular-nums text-[#999]`}>
                      {(t.created_at ?? "").slice(5, 16).replace("T", " ")}
                    </td>
                    <td className={`${TD} text-right`}>
                      <form action={deleteCleaningTemplateAction} className="inline-block">
                        <input type="hidden" name="id" value={t.id} />
                        <button type="submit" className={`${BTN_DANGER} px-2`}>
                          删除
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {activeTab === "advanced" && (
        <Section
          id="advanced"
          title="高级设置"
          desc="产权者、个性化、报表发送、管家密码与微管家场景，全部写入 settings 表 key-value"
          extra={<span className="text-[11px] text-[#999]">保存后立即生效</span>}
        >
          <div className="grid gap-2.5 p-3 xl:grid-cols-2">
            <form
              action={saveAdvancedFormAction}
              className="rounded-[4px] border border-[#eee] bg-white p-3 xl:col-span-2"
            >
              <input type="hidden" name="section" value="property" />
              <div className="text-[12px] font-medium text-[#444]">房屋产权者信息</div>
              <p className="mt-0.5 text-[11px] text-[#999]">用于租赁合同、发票开具与产权备案</p>
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <label className="label" htmlFor="owner_name">
                    产权人
                  </label>
                  <input
                    id="owner_name"
                    name="owner_name"
                    defaultValue={ownerName}
                    maxLength={30}
                    className={`${INPUT} w-full`}
                    placeholder="如 张三"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="owner_id_no">
                    证件号
                  </label>
                  <input
                    id="owner_id_no"
                    name="owner_id_no"
                    defaultValue={ownerIdNo}
                    maxLength={40}
                    className={`${INPUT} w-full`}
                    placeholder="身份证 / 营业执照号"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="owner_phone">
                    联系电话
                  </label>
                  <input
                    id="owner_phone"
                    name="owner_phone"
                    defaultValue={ownerPhone}
                    maxLength={20}
                    className={`${INPUT} w-full`}
                    placeholder="13800001111"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="owner_address">
                    地址
                  </label>
                  <input
                    id="owner_address"
                    name="owner_address"
                    defaultValue={ownerAddress}
                    maxLength={80}
                    className={`${INPUT} w-full`}
                    placeholder="如 杭州市西湖区文三路 100 号"
                  />
                </div>
              </div>
              <div className="mt-2.5 flex justify-end">
                <button type="submit" className={BTN_PRIMARY}>
                  保存产权者信息
                </button>
              </div>
            </form>

            <form action={saveAdvancedFormAction} className="rounded-[4px] border border-[#eee] bg-white p-3">
              <input type="hidden" name="section" value="personal" />
              <div className="text-[12px] font-medium text-[#444]">个性化设置</div>
              <p className="mt-0.5 text-[11px] text-[#999]">登录后的默认页面与列表显示习惯</p>
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-3">
                <div>
                  <label className="label" htmlFor="homepage_default">
                    首页默认页
                  </label>
                  <select
                    id="homepage_default"
                    name="homepage_default"
                    defaultValue={homepageDefault}
                    className={`${INPUT} w-full`}
                  >
                    {HOMEPAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="table_density">
                    表格密度
                  </label>
                  <select
                    id="table_density"
                    name="table_density"
                    defaultValue={tableDensity === "loose" ? "loose" : "compact"}
                    className={`${INPUT} w-full`}
                  >
                    <option value="compact">紧凑</option>
                    <option value="loose">宽松</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="show_room_legend">
                    显示房态图例
                  </label>
                  <select
                    id="show_room_legend"
                    name="show_room_legend"
                    defaultValue={showRoomLegend === "1" ? "1" : "0"}
                    className={`${INPUT} w-full`}
                  >
                    <option value="1">显示</option>
                    <option value="0">隐藏</option>
                  </select>
                </div>
              </div>
              <div className="mt-2.5 flex justify-end">
                <button type="submit" className={BTN_PRIMARY}>
                  保存个性化设置
                </button>
              </div>
            </form>

            <form action={saveAdvancedFormAction} className="rounded-[4px] border border-[#eee] bg-white p-3">
              <input type="hidden" name="section" value="report" />
              <div className="text-[12px] font-medium text-[#444]">报表发送设置</div>
              <p className="mt-0.5 text-[11px] text-[#999]">营业日报 / 夜审报表按设定时间自动发送</p>
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="report_email">
                    接收邮箱
                  </label>
                  <input
                    id="report_email"
                    name="report_email"
                    type="email"
                    defaultValue={reportEmail}
                    maxLength={60}
                    className={`${INPUT} w-full`}
                    placeholder="boss@example.com"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="report_send_time">
                    发送时间
                  </label>
                  <input
                    id="report_send_time"
                    name="report_send_time"
                    type="time"
                    defaultValue={reportSendTime}
                    className={`${INPUT} w-full`}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="report_enabled">
                    是否启用
                  </label>
                  <select
                    id="report_enabled"
                    name="report_enabled"
                    defaultValue={reportEnabled === "1" ? "1" : "0"}
                    className={`${INPUT} w-full`}
                  >
                    <option value="0">停用</option>
                    <option value="1">启用</option>
                  </select>
                </div>
              </div>
              <div className="mt-2.5 flex justify-end">
                <button type="submit" className={BTN_PRIMARY}>
                  保存报表设置
                </button>
              </div>
            </form>

            <form action={saveAdvancedFormAction} className="rounded-[4px] border border-[#eee] bg-white p-3">
              <input type="hidden" name="section" value="steward" />
              <div className="flex items-center justify-between gap-2">
                <div className="text-[12px] font-medium text-[#444]">管家密码</div>
                <span
                  className={`rounded-[2px] border px-1 text-[11px] leading-[15px] ${
                    stewardPasswordSet
                      ? "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]"
                      : "border-[#eee] bg-[#f7f7f7] text-[#999]"
                  }`}
                >
                  {stewardPasswordSet ? "已设置" : "未设置"}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-[#999]">微管家 / 移动端管家入口密码，已保存的密码不回显</p>
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="new_password">
                    新密码
                  </label>
                  <input
                    id="new_password"
                    name="new_password"
                    type="password"
                    maxLength={32}
                    autoComplete="new-password"
                    className={`${INPUT} w-full`}
                    placeholder="4 - 32 位"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="confirm_password">
                    确认密码
                  </label>
                  <input
                    id="confirm_password"
                    name="confirm_password"
                    type="password"
                    maxLength={32}
                    autoComplete="new-password"
                    className={`${INPUT} w-full`}
                    placeholder="再输入一次"
                  />
                </div>
              </div>
              <div className="mt-2.5 flex justify-end">
                <button type="submit" className={BTN_PRIMARY}>
                  更新管家密码
                </button>
              </div>
            </form>

            <form action={saveAdvancedFormAction} className="rounded-[4px] border border-[#eee] bg-white p-3">
              <input type="hidden" name="section" value="scene" />
              <div className="text-[12px] font-medium text-[#444]">微管家服务场景</div>
              <p className="mt-0.5 text-[11px] text-[#999]">启用后可在微管家 / 小程序中向客人开放对应服务</p>
              <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                {MICRO_BUTLER_SCENES.map((scene) => (
                  <label key={scene} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[#555]">
                    <input
                      type="checkbox"
                      name="scenarios"
                      value={scene}
                      defaultChecked={microButlerScenes.includes(scene)}
                      className="h-3.5 w-3.5 accent-[#32c141]"
                    />
                    {scene}
                  </label>
                ))}
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-[#eee] pt-2">
                <span className="text-[11px] text-[#999]">已启用 {microButlerScenes.length} 项</span>
                <button type="submit" className={`${BTN_PRIMARY} px-2.5`}>
                  保存服务场景
                </button>
              </div>
            </form>
          </div>
          <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            存储位置：settings 表 · key 分别为 property_owner_name / property_owner_id_no / property_owner_phone /
            property_owner_address / homepage_default / table_density / show_room_legend / report_email /
            report_send_time / report_enabled / steward_password / micro_butler_scenes
          </p>
        </Section>
      )}

      {/* ===== 小程序配置（整改清单 F12：微信小程序 / 会员端） ===== */}
      {activeTab === "miniprogram" && (
        <Section
          id="miniprogram"
          title="小程序配置"
          desc="会员端小程序用 wx.login 拿到 code 后，服务端用这里的 AppID + AppSecret 调微信 jscode2session 换 openid。未填写时 /api/mini/login 一律返回 NOT_CONFIGURED，不会假装登录成功。"
          extra={
            <span className="flex items-center gap-1.5">
              <span
                className={`rounded-[2px] border px-1 text-[11px] leading-[15px] ${
                  miniConfigured
                    ? "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]"
                    : "border-[#f0c0c0] bg-[#fff3f3] text-[#e04545]"
                }`}
              >
                {miniConfigured ? "已配置" : "未配置"}
              </span>
              <span
                className={`rounded-[2px] border px-1 text-[11px] leading-[15px] ${
                  miniConfig?.enabled
                    ? "border-[#bfe6c6] bg-[#f3fbf4] text-[#2a9d3a]"
                    : "border-[#eee] bg-[#f7f7f7] text-[#999]"
                }`}
              >
                {miniConfig?.enabled ? "已启用" : "未启用"}
              </span>
            </span>
          }
        >
          <form action={saveMiniProgramConfigAction} className="space-y-2.5 p-3">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12px] text-[#555]">AppID（小程序 ID）</span>
                <input
                  name="app_id"
                  defaultValue={miniConfig?.appId ?? ""}
                  maxLength={64}
                  placeholder="wx0000000000000000"
                  aria-label="小程序 AppID"
                  className={`${INPUT} mt-1 w-full font-mono`}
                />
                <span className="mt-0.5 block text-[11px] text-[#999]">
                  小程序后台 → 开发管理 → 开发设置 → 开发者 ID 里的 AppID（wx 开头 18 位）
                </span>
              </label>

              <label className="block">
                <span className="text-[12px] text-[#555]">AppSecret（小程序密钥）</span>
                <input
                  name="app_secret"
                  type="password"
                  autoComplete="new-password"
                  maxLength={64}
                  defaultValue=""
                  placeholder={miniConfigured ? "已保存（不显示），留空表示不修改" : "32 位 AppSecret"}
                  aria-label="小程序 AppSecret"
                  className={`${INPUT} mt-1 w-full font-mono`}
                />
                <span className="mt-0.5 block text-[11px] text-[#999]">
                  同一页面的「生成/重置」按钮可得，<b>只显示一次</b>，复制完整 32 位；本页永不回显
                </span>
              </label>

              <label className="block">
                <span className="text-[12px] text-[#555]">微信支付商户号（可选）</span>
                <input
                  name="mch_id"
                  defaultValue={miniConfig?.mchId ?? ""}
                  maxLength={20}
                  placeholder="留空表示不做在线支付"
                  aria-label="微信支付商户号"
                  className={`${INPUT} mt-1 w-full font-mono`}
                />
                <span className="mt-0.5 block text-[11px] text-[#999]">
                  在线支付时用于下单；当前版本只做房量查询与预订，支付走前台到店付款
                </span>
              </label>

              <label className="block">
                <span className="text-[12px] text-[#555]">商户密钥（可选）</span>
                <input
                  name="mch_key"
                  type="password"
                  autoComplete="new-password"
                  maxLength={64}
                  defaultValue=""
                  placeholder={miniConfig?.mchKey ? "已保存（不显示），留空表示不修改" : "APIv3 密钥 / API 密钥"}
                  aria-label="微信支付商户密钥"
                  className={`${INPUT} mt-1 w-full font-mono`}
                />
                <span className="mt-0.5 block text-[11px] text-[#999]">商户平台 → 账户中心 → API 安全里设置</span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#eee] pt-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[#555]">
                <input
                  type="checkbox"
                  name="enabled"
                  value="1"
                  defaultChecked={Boolean(miniConfig?.enabled)}
                  className="h-3.5 w-3.5 accent-[#32c141]"
                />
                启用小程序登录
                <span className="text-[11px] text-[#999]">（停用后 /api/mini/login 直接返回 NOT_CONFIGURED）</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[#999]">
                  {miniConfig?.updatedAt ? `最近更新 ${fmtDateTime(miniConfig.updatedAt)}` : "尚未保存过"}
                  {miniConfig?.appId ? ` · 当前 AppID ${miniAppIdMasked}` : ""}
                </span>
                <button type="submit" className={BTN_PRIMARY}>
                  保存小程序配置
                </button>
              </div>
            </div>
          </form>

          <div className="space-y-1.5 border-t border-[#eee] bg-[#fbfbfb] px-3 py-2 text-[11px] leading-[18px] text-[#666]">
            <p>
              <b className="text-[#333]">还需要在小程序后台配两处，否则真机一定连不上服务端：</b>
            </p>
            <p>
              1. 开发管理 → 开发设置 → <b>服务器域名</b>：把 <code className="rounded-[2px] bg-white px-1">request 合法域名</code>{" "}
              填成本系统的 HTTPS 域名（必须是<b>已备案</b>的域名，且带 https://，不能填 IP）。
            </p>
            <p>
              2. 本地调试可在微信开发者工具「详情 → 本地设置」勾选{" "}
              <b>不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书</b>，用 http://127.0.0.1:3100 联调。
            </p>
            <p>
              3. 小程序源码在项目的 <code className="rounded-[2px] bg-white px-1">miniprogram/</code> 目录，用微信开发者工具
              直接打开该目录，把 <code className="rounded-[2px] bg-white px-1">project.config.json</code> 的 appid 换成自己的，
              并把 <code className="rounded-[2px] bg-white px-1">utils/api.js</code> 里的 BASE_URL 改成上面的 HTTPS 域名。
            </p>
          </div>

          <p className="border-t border-[#eee] px-3 py-2 text-[11px] text-[#999]">
            存储位置：mini_program_config 表（UNIQUE(hotel_id)，一家店一套）· 会员绑定关系在 mini_program_users 表 ·
            AppSecret / 商户密钥只存服务端，接口与页面均不回显
          </p>
        </Section>
      )}
      </div>

      {/* ===== 演示数据（一键导入 46 房 / 588 预订 / 200 账单，给客户演示用） ===== */}
      {activeTab === "demo" && (
        <Section
          id="demo"
          title="演示数据"
          desc="给客户演示、给同事试用、培训新人时，一键导入一整套有数的业务数据。导入会覆盖现有业务数据（房间/预订/入住/账单/客人/会员），配置类数据保留。"
        >
          <DemoDataPanel />
        </Section>
      )}
    </div>
  );
}
