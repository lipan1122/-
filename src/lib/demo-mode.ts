/**
 * 演示模式统一开关（上线评审 P0：演示入口在正式环境会暴露）
 *
 * ── 改前的问题：fail-open ──
 *
 * 登录页原来的判据是 `process.env.PMS_DEMO_LOGIN !== "0"`。
 * 看起来「设了 0 就关」，实际上**变量缺省**（正式环境最常见的状态：.env 里
 * 根本没写这一行、或者干脆忘了配）时表达式为 true —— 演示账号一键填入照样渲染。
 * 也就是说「漏配」= 「默认开启」，安全默认值反了。评审原文说的正是这条：
 * 「PMS_DEMO_LOGIN 缺省时会展示演示入口，正式环境需显式配置」。
 *
 * ── 改后：fail-safe ──
 *
 * 只有**显式**写成真值才算开启，其余一律关闭：
 *
 *   开启：1 / true / yes / on（大小写不敏感，首尾空格容忍）
 *   关闭：未设置、空字符串、0 / false / no / off、以及任何拼错的值（如 ture / enable）
 *
 * 两个刻意的取舍：
 *   · 拼错的值按「关闭」处理 —— 宁可演示入口不见了让运维去看日志，
 *     也不能让「打错一个字母」变成「正式环境把 admin 账号摆到登录页上」；
 *   · 判据只来自服务端环境变量，**不看 query / Cookie / Header** ——
 *     否则任何人构造一个请求就能在生产环境打开演示入口。
 *
 * ── 为什么单独一个文件、而不是留在页面里 ──
 *
 * 项目里「演示」相关入口不只一处，而且历史上是各写各的：
 *   · 登录页「一键填入演示账号」        → PMS_DEMO_LOGIN（原判据 fail-open）
 *   · 设置页「一键导入演示数据」        → 之前**没有任何开关**，无条件渲染
 *   · 工作台琥珀色「演示数据」提示卡    → 之前只按 role === "admin" 渲染，与环境无关
 *   · AR / 商品 / 积分 / 收银 / 渠道种子 → PMS_DEMO_SEED === "1"（这一批本来就是对的）
 *
 * 判据写在页面里，就会出现「改了一处漏一处，下次评审再挑出另一个入口」。
 * 所以统一收在这里，页面只负责调用：
 *
 *   · isDemoLoginEnabled()  登录页演示账号（精确：只看 PMS_DEMO_LOGIN）
 *   · isDemoSeedEnabled()   演示数据写入（精确：只看 PMS_DEMO_SEED）
 *   · isDemoMode()          演示模式总开关（任一显式开启即为 true，给「演示相关 UI」用）
 *
 * ── 服务端专用 ──
 *
 * 本文件按 `process.env` 判断，只能在 Server Component / Server Action / 脚本里 import。
 * 客户端组件里 import 会拿到构建期内联的空值 → 恒为「关闭」。
 * 这个方向是安全的（客户端永远打不开演示入口），但不要把这里当特性开关传给客户端。
 */

import { demoSeedEnabled } from "./channels/demo-mode";

/** 视为「开启」的取值。与 scripts/check-production-config.mjs 的口径保持一致 */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * 读取一个布尔型环境变量（fail-safe：只有显式真值才算开）
 *
 * 不用 `Number(value) === 1`：`Number("")` 是 0 还好，但 `Number("  ")`、`Number("1x")`
 * 这类写法会让口径变得难以解释；也不用 `!!value`：空串和 "0" 都是 truthy 字符串陷阱。
 */
function flagEnabled(name: string): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value.length > 0 && TRUTHY.has(value);
}

/**
 * 登录页是否显示「一键填入演示账号」
 *
 * 只看 PMS_DEMO_LOGIN：这是唯一决定「登录页上有没有演示账号口令」的开关。
 * 不要改成 isDemoMode() —— 否则 PMS_DEMO_SEED=1（只想灌演示数据）会把
 * 4 个演示账号一并摆到登录页上，等于把两个风险绑在一起。
 */
export function isDemoLoginEnabled(): boolean {
  return flagEnabled("PMS_DEMO_LOGIN");
}

/**
 * 是否允许写入演示数据（种子数据、一键导入演示库）
 *
 * 判据不在这里重新实现，直接复用 src/lib/channels/demo-mode.ts 的 demoSeedEnabled()：
 * 渠道页、AR、商品、积分、收银的种子数据都认那一份（口径是"=== 1"）。
 * 如果这里放宽成 true/yes，就会出现"PMS_DEMO_SEED=true 时渠道不灌、别的模块灌"
 * 这种半开状态 —— 演示数据开关只该有一个真相。
 *
 * （PMS_DEMO_LOGIN 不同：评审明确要求支持 1/true/yes，所以那一个用下面的 TRUTHY 集合。）
 */
export function isDemoSeedEnabled(): boolean {
  return demoSeedEnabled();
}

/**
 * 演示模式总开关：任一演示能力显式开启即为 true
 *
 * 用途是「演示相关的 UI 是否该出现」这类粗粒度判断（设置页演示数据 Tab、
 * 工作台演示数据提示卡）。注意它**不能**替代 isDemoLoginEnabled()：
 * 登录页账号口令必须跟 PMS_DEMO_LOGIN 一一对应。
 */
export function isDemoMode(): boolean {
  return isDemoLoginEnabled() || isDemoSeedEnabled();
}

/** 演示账号入口关闭时给页面用的统一文案（避免「入口突然没了」被当成故障） */
export const DEMO_LOGIN_DISABLED_MESSAGE =
  "演示账号入口已关闭（正式环境默认关闭）。如需开启，请在服务端设置 PMS_DEMO_LOGIN=1 后重启服务";

/* 演示数据关闭时的文案不重复定义，沿用渠道模块那一份，保证全站只有一句提示 */
export { DEMO_SEED_DISABLED_MESSAGE } from "./channels/demo-mode";
