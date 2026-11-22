export const ROOM_STATUS: Record<string, { label: string; short: string; color: string; bg: string; border: string }> = {
  VC: { label: "空净房", short: "VC", color: "#15803d", bg: "#dcfce7", border: "#86efac" },
  VD: { label: "空脏房", short: "VD", color: "#b45309", bg: "#fef3c7", border: "#fcd34d" },
  OC: { label: "在住净房", short: "OC", color: "#1d4ed8", bg: "#dbeafe", border: "#93c5fd" },
  OD: { label: "在住脏房", short: "OD", color: "#6b21a8", bg: "#f3e8ff", border: "#d8b4fe" },
  OOO: { label: "维修房", short: "OOO", color: "#4b5563", bg: "#e5e7eb", border: "#d1d5db" },
  LOCK: { label: "锁房", short: "LOCK", color: "#374151", bg: "#d1d5db", border: "#9ca3af" },
};

export const BOOKING_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "待排房", cls: "bg-amber-100 text-amber-700 border-amber-200" },
  CONFIRMED: { label: "已确认", cls: "bg-blue-100 text-blue-700 border-blue-200" },
  CHECKED_IN: { label: "已入住", cls: "bg-green-100 text-green-700 border-green-200" },
  CANCELLED: { label: "已取消", cls: "bg-gray-100 text-gray-500 border-gray-200" },
  NOSHOW: { label: "未到", cls: "bg-red-100 text-red-600 border-red-200" },
};

export function fmtMoney(n: number | null | undefined) {
  return `¥${Number(n ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ============================================================ 金额精度
 *
 * 整改清单 P2-1：`round2` 在项目里被复制了 20 多份，而且实现都是
 *   `Math.round((n + Number.EPSILON) * 100) / 100`
 * 这个写法有两个毛病：
 *
 *   1. 负数舍入不对称。
 *      `Math.round` 对 .5 一律向 +∞ 取整（Math.round(-267.5) === -267），
 *      所以 round2(-2.675) 得到 -2.67，而 round2(2.675) 得到 2.68。
 *      会计口径要求「四舍五入」对称：-2.675 应当变成 -2.68（远离零的方向进位），
 *      否则退款 / 冲减类金额与正向金额相加时会出现 1 分的系统性偏差。
 *
 *   2. Number.EPSILON 是「1 与下一个可表示浮点数之间的差」（约 2.22e-16），
 *      对 2.675 这种量级（二进制表示是 2.67499999999999982...）加 EPSILON
 *      根本推不过 .5 的门槛，`round2(2.675)` 在某些路径下仍然得到 2.67。
 *
 * 正确做法是「按符号补一个足够大的 epsilon」：
 *   正数 + 1e-9 / 负数 - 1e-9，再乘 100 取整。
 *   1e-9 相对「分」的量级（1e-2）有 7 个数量级的余量，
 *   足以把 2.6749999999999998 推到 2.675，又不可能把 2.6749 推成 2.68。
 *
 * 为什么把权威实现放在 utils.ts：它是全项目唯一一个「零依赖、任何模块都能安全
 * import」的文件（db.ts 会拉起 node:sqlite，folio.ts 会拉起 db）。28 份副本里
 * 由本文件导出的这一份是唯一来源，其余文件一律 `import { round2 } from "@/lib/utils"`。
 */
export function round2(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  return Math.round((v + sign * 1e-9) * 100) / 100;
}

/**
 * 金额转「分」的整数。
 *
 * 只要比较/对账就一律走它，不要拿两个浮点数直接 `===` 或 `<`：
 * `0.1 + 0.2 === 0.3` 为 false 的那点误差，在收款流水与账单对账时会变成
 * 「明明收平了却提示还差 0.01」。
 *
 * 实现刻意先过一遍 round2 再乘 100：直接 `Math.round(v * 100)` 在负数上
 * 会沿用 Math.round 的「向 +∞ 取整」语义，`toCent(-2.675)` 得到 -267 而
 * `toCent(2.675)` 得到 268 —— 两端不对称，退款与收款相加时又会差 1 分。
 */
export function toCent(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(round2(v) * 100);
}

/* ============================================================ CSV 导出
 *
 * 整改清单 P1-25：CSV 公式注入（CSV Injection）。
 *
 * 把一个名叫 `=cmd|'/c calc'!A0` 的客人导出成 CSV，用 Excel 打开时
 * 那个单元格会被**当成公式求值**，Windows 上直接弹出计算器（更糟的 payload
 * 可以执行任意命令）。只把 `"` 转义成 `""` 完全挡不住：Excel 解析 CSV 时
 * 先剥掉引号，再看剩下的内容是不是以 = + - @ 或制表/回车开头。
 *
 * 中和办法是加一个前导单引号（Excel / WPS 里表示「后面是纯文本」）。
 *
 * 为什么必须区分文本列与数值列：
 *   金额列天生可能以 - 开头（退款、冲减）。如果对它也加单引号，
 *   Excel 会把 `-123.00` 当成文本，整列无法求和、排序也乱 —— 修一个安全漏洞
 *   顺手制造一个财务事故，不划算。所以数值列只做标准转义。
 */
const CSV_INJECTION_PREFIX = /^[=+\-@\t\r]/;

/** CSV 文本单元格：中和公式注入 + 标准 CSV 转义（双引号翻倍并整格加引号） */
export function csvTextCell(value: unknown): string {
  const raw = String(value ?? "");
  const safe = CSV_INJECTION_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** CSV 数值单元格：只做标准 CSV 转义，不加前导单引号（否则 Excel 视为文本，负数无法计算） */
export function csvNumberCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date | string, n: number) {
  const x = typeof d === "string" ? new Date(`${d}T00:00:00`) : new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function nightsBetween(a: string, b: string) {
  const ms = new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime();
  return Math.max(1, Math.round(ms / 86400000));
}

/**
 * 纯审计时间戳（UTC ISO）
 *
 * 只用于 created_at / updated_at 这类「只做时间轴排序、不参与业务日期判断」的字段。
 * 需要按日期读的场景一律用 nowLocalIso()。
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 本地时间 ISO（整改清单 P1-6）
 *
 * 返回形如 `2026-11-18T02:30:00.000+08:00`，**前 10 位就是本地日期**。
 *
 * 为什么需要它：业务里有大量 `substr(字段,1,10)` 当日期用的地方
 * （如 stays.check_in_time 推营业日）。如果存 UTC，客人凌晨 2 点入住时
 * UTC 是前一天 18:00，取出来就落到前一天，房费/报表/夜审全部错位。
 *
 * 用「本地时间 + 带偏移」而不是「本地时间 + Z」：
 * 带偏移的字符串既保留了真实时区信息，前 10 位又是本地日期，
 * 两种用途都不丢。
 */
export function nowLocalIso(d = new Date()) {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offMin = -d.getTimezoneOffset(); // 东八区 = 480
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, "0")}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  manager: "店长",
  frontdesk: "前台",
  cashier: "收银",
  housekeeping: "客房",
};
