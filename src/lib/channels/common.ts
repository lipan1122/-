/**
 * 渠道直连公共设施（整改清单 F1）
 *
 * 这里只放「四家渠道都会用到、且与具体渠道协议无关」的东西：
 *   · HTTP 请求 + 15 秒超时 + 错误码归一（401/403→AUTH_FAILED、429→RATE_LIMITED、5xx→NETWORK…）
 *   · OTA 通用签名结构（参数按 key 排序 → k=v 用 & 连接 → HMAC-SHA256(拼接串, app_secret)）
 *   · 凭据缺失 / 掩码占位的识别
 *   · 响应包裹（code / message / data）的通用读取与业务错误转 ChannelResult
 *
 * ⚠️ 签名算法说明（重要，别当成任何一家的官方算法）
 * ------------------------------------------------------------------
 * 下面这套「参数按 key 字典序排序 → k=v 用 & 连接 → 对拼接串做 HMAC-SHA256(secret)」
 * 是 OTA / 开放平台里**最常见的一种结构**，但四家的官方算法各不相同：
 *   携程、美团、飞猪（淘宝开放平台 TOP）、抖音各自有明确的签名文档，
 *   有的用 md5、有的要求把 secret 拼在首尾、有的按「key+value 直接拼接」而不是 k=v、
 *   有的要求排除 sign 字段、有的签名只覆盖业务参数。
 * 本仓库没有开发者账号、也没有签约开通接口，**无法用真机验证**。
 * 首次联调时必须对着各渠道官方文档逐个字段核对；核对后只需要改
 * 各渠道文件里的 request 封装函数（ctrip.ts 的 signedPost 等），不要动这里的工具。
 *
 * 反过来，本文件里的超时 / 错误归一 / 日志口径与渠道无关，可以直接用。
 */

import { createHmac } from "node:crypto";
import type { ChannelConfig, ChannelErrorCode, ChannelResult } from "@/lib/channels/types";

/* ============================================================ 基础类型 */

/** 所有渠道请求的硬超时（毫秒）；fetch 统一挂 AbortSignal.timeout */
export const REQUEST_TIMEOUT_MS = 15_000;

/** 失败分支（= ChannelResult 的 ok:false 一支），复用它省得每处重复写联合类型 */
export type ChannelFailure = Extract<ChannelResult<never>, { ok: false }>;

/** 签名 / 请求参数允许的标量类型 */
export type ParamValue = string | number | boolean | null | undefined;

/** HTTP 请求成功的中间结果（响应体已解析为 JSON） */
export type HttpOk = { ok: true; status: number; body: unknown; text: string };

/** HTTP 请求结果：成功带 body，失败直接就是归一化后的 ChannelResult 失败分支 */
export type HttpResult = HttpOk | ChannelFailure;

/** 业务包裹（假设响应形如 { code, message, data }） */
export type BizEnvelope = {
  success: boolean;
  code: string;
  message: string;
  data: unknown;
};

/* ============================================================ 错误构造 */

/** 构造失败结果；detail 为空时不下发该字段，避免日志里出现 "undefined" */
export function fail(code: ChannelErrorCode, message: string, detail?: string): ChannelFailure {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

/** 把任意异常压成一行文本（不把堆栈塞进渠道日志） */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 截断长文本，避免把渠道返回的整页 HTML 写进 channel_sync_logs */
export function truncate(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（已截断，原长 ${text.length}）`;
}

/** JSON.stringify 的安全版本（循环引用 / BigInt 都不会抛） */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/* ============================================================ 签名 */

/**
 * OTA 通用签名：HMAC-SHA256(排序拼接串, app_secret) 的十六进制小写形式。
 *
 * 再次强调：这是通用模式，不是任何一家的官方算法（见文件头）。
 */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * 把参数按 key 字典序排好，拼成 `k1=v1&k2=v2`（key/value 做 URL 编码）。
 *
 * - 跳过 sign 本身，避免「把签名也算进签名」；
 * - 跳过 undefined / null（缺省参数不参与签名）；
 * - 保留空字符串：有些渠道把空值也算签名的一部分。
 */
export function canonicalParams(params: Record<string, ParamValue>): string {
  return Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join("&");
}

/** 通用签名入口：canonicalParams + hmacSha256Hex */
export function signParams(params: Record<string, ParamValue>, secret: string): string {
  return hmacSha256Hex(secret, canonicalParams(params));
}

/* ============================================================ 端点 */

/**
 * 解析请求地址：
 *   - 渠道配置里填了 endpoint（测试环境 / 私有化部署）就用它当 base；
 *   - 否则用适配器文件里的默认网关；
 *   - path 为空时直接返回 base（飞猪 TOP 网关就是「一个地址 + method 参数」的形态）。
 *
 * 注意：endpoint 按 base 处理（可以带路径前缀，但不能再拼查询串）。
 */
export function resolveEndpoint(cfg: ChannelConfig, defaultBase: string, path: string): string {
  const base = (cfg.endpoint?.trim() || defaultBase).replace(/\/+$/, "");
  if (!path) return base;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/* ============================================================ 凭据 */

const CREDENTIAL_LABELS: Record<string, string> = {
  storeId: "门店/酒店 id（storeId）",
  appKey: "appKey",
  appSecret: "appSecret",
};

/**
 * 凭据里哪些字段是空的（返回中文名，直接进日志）。
 * 默认要求 storeId + appKey + appSecret，与 types.ts 的 isConfigured 口径一致。
 */
export function missingCredentials(
  cfg: ChannelConfig,
  fields: readonly (keyof ChannelConfig)[] = ["storeId", "appKey", "appSecret"]
): string[] {
  return fields
    .filter((field) => {
      const value = cfg[field];
      return typeof value !== "string" || value.trim() === "";
    })
    .map((field) => CREDENTIAL_LABELS[String(field)] ?? String(field));
}

/**
 * 密钥是否是掩码 / 占位值。
 *
 * 背景：演示库与渠道配置页回填的 app_secret 常常是「••••••••」「******」这类掩码，
 * 如果拿它当真实密钥去拼签名、请求渠道网关，只会得到一次莫名其妙的 AUTH_FAILED，
 * 还可能把无效请求打到渠道方。这里提前识别成 NOT_CONFIGURED，便于页面提示「请补真实密钥」。
 */
export function isMaskedSecret(secret: string | null | undefined): boolean {
  if (typeof secret !== "string") return true;
  const s = secret.trim();
  if (s === "") return true;
  return /[•＊]/.test(s) || /^\*+$/.test(s);
}

/* ============================================================ 佣金口径 */

/**
 * 佣金率显示（整改清单 P2-12）。
 *
 * 库里 `channels.commission` 有两种历史写法：小数（0.15）和百分数（15）。
 * 整改前渠道页直接 `Number(commission).toFixed(1)}%`，0.15 被显示成「0.1%」——
 * 少了一个数量级，对账时按这个数字算佣金会差 100 倍。
 *
 * 判据与设置页（settings/page.tsx 的 fmtCommission）保持一致：
 *   n > 1 视为百分数原样显示；n <= 1 视为小数乘 100。
 * 这样 0.1 与 10 都显示成 10.0%，0.15 与 15 都显示成 15.0%。
 */
export function formatCommissionPercent(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0.0%";
  const percent = n > 1 ? n : n * 100;
  return `${percent.toFixed(1)}%`;
}

/**
 * 把用户填的佣金率归一成 0~1 的小数（写库前校验）。
 *
 * 允许输入 0~100 的百分数（如 15）或 0~1 的小数（如 0.15），统一存成小数；
 * 超出范围、负数、非数字一律返回 null，由调用方回一句明确的错误提示，
 * 而不是把 150 写进库再让报表算出天价佣金。
 */
export function normalizeCommission(raw: unknown): number | null {
  const n = Number(typeof raw === "string" ? raw.trim() : raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const ratio = n > 1 ? n / 100 : n;
  if (ratio > 1) return null;
  return Math.round(ratio * 10000) / 10000;
}

/* ============================================================ HTTP */

/**
 * 把 HTTP 状态码归一成渠道错误码：
 *   401/403 → AUTH_FAILED   凭据 / 授权问题
 *   429     → RATE_LIMITED  限流
 *   408 / 5xx → NETWORK     超时 / 渠道服务不可用
 *   其它 4xx → CHANNEL_ERROR 请求被渠道拒绝（参数 / 房型不存在等）
 */
export function httpStatusFailure(status: number, responseText = ""): ChannelFailure {
  const detail = responseText ? truncate(responseText) : undefined;
  if (status === 401 || status === 403) {
    return fail("AUTH_FAILED", `渠道鉴权失败（HTTP ${status}），请核对 appKey / appSecret / 门店授权`, detail);
  }
  if (status === 429) {
    return fail("RATE_LIMITED", "渠道限流（HTTP 429），请降低同步频率后重试", detail);
  }
  if (status === 408) {
    return fail("NETWORK", "渠道请求超时（HTTP 408）", detail);
  }
  if (status >= 500) {
    return fail("NETWORK", `渠道服务不可用（HTTP ${status}）`, detail);
  }
  return fail("CHANNEL_ERROR", `渠道拒绝请求（HTTP ${status}）`, detail);
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

function parseJson(text: string): unknown | undefined {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 发一个 JSON 请求并把结果归一化。
 *
 * - 每次 fetch 都带 AbortSignal.timeout(REQUEST_TIMEOUT_MS)，不会把同步任务挂死；
 * - 网络层异常（DNS / TLS / 超时）→ NETWORK；
 * - HTTP 非 2xx → httpStatusFailure；
 * - 2xx 但不是合法 JSON → CHANNEL_ERROR（协议不符，不是网络问题）。
 */
export async function requestJson(url: string, init: RequestInit = {}): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const message = isTimeoutError(e)
      ? `请求渠道超时（${REQUEST_TIMEOUT_MS}ms）`
      : `请求渠道失败：${errText(e)}`;
    return fail("NETWORK", message, truncate(errText(e), 300));
  }

  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return fail("NETWORK", `读取渠道响应失败：${errText(e)}`, truncate(errText(e), 300));
  }

  if (!res.ok) return httpStatusFailure(res.status, text);

  const body = parseJson(text);
  if (body === undefined) {
    return fail("CHANNEL_ERROR", "渠道返回的不是合法 JSON", truncate(text));
  }
  return { ok: true, status: res.status, body, text };
}

/**
 * 通用「签名 + POST JSON」请求。
 *
 * 报文结构（通用模式，联调核对）：
 *   body = { ...公共参数, ...业务参数, sign }
 *   公共参数：appKey / storeId / timestamp / nonce / action
 *   签名：对公共参数 + 业务参数（不含 sign）做 HMAC-SHA256
 *
 * 正式密钥只用于本地计算签名，**不会出现在报文里**。
 */
export async function postSignedJson(
  cfg: ChannelConfig,
  path: string,
  defaultEndpoint: string,
  action: string,
  bizParams: Record<string, ParamValue>
): Promise<HttpResult> {
  const common: Record<string, ParamValue> = {
    appKey: cfg.appKey,
    storeId: cfg.storeId,
    timestamp: new Date().toISOString(),
    nonce: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    action,
  };
  const params: Record<string, ParamValue> = { ...common, ...bizParams };
  const sign = signParams(params, cfg.appSecret ?? "");
  const url = resolveEndpoint(cfg, defaultEndpoint, path);

  return requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...params, sign }),
  });
}

/* ============================================================ 响应包裹 */

/** 默认视为「成功」的 code（数字和字符串两种写法都算） */
const DEFAULT_SUCCESS_CODES = ["0", "200", "SUCCESS", "success", "OK", "ok", "true", "TRUE"];

/**
 * 读取 `{ code, message, data }` 形态的业务包裹。
 *
 * 字段别名按公开文档的常见结构取：code / errCode / errorCode，
 * message / msg / errMsg / description，data / result / content。
 * **这些别名不是权威字段表**：联调时按官方文档核对，核对结果落在各渠道文件里。
 *
 * 成功判定顺序：
 *   1. 有布尔 success → 以它为准；
 *   2. 有 code → 命中 successCodes 才算成功；
 *   3. 两样都没有 → 按 HTTP 2xx 视为成功（部分渠道的 ping 接口只回 200 空体）。
 */
export function readBizEnvelope(
  body: unknown,
  options: { successCodes?: readonly (string | number)[] } = {}
): BizEnvelope {
  const successCodes = new Set<string>([
    ...DEFAULT_SUCCESS_CODES,
    ...(options.successCodes ?? []).map((c) => String(c)),
  ]);

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { success: false, code: "INVALID_RESPONSE", message: "渠道返回不是 JSON 对象", data: body };
  }

  const rec = asRecord(body);
  const explicit = rec.success;
  const codeRaw = rec.code ?? rec.errCode ?? rec.errorCode;
  const code = codeRaw === undefined || codeRaw === null ? "" : String(codeRaw);
  const messageRaw = rec.message ?? rec.msg ?? rec.errMsg ?? rec.description;
  const message = typeof messageRaw === "string" ? messageRaw : "";
  const data = rec.data ?? rec.result ?? rec.content ?? null;

  let success: boolean;
  if (explicit === true) success = true;
  else if (explicit === false) success = false;
  else if (code !== "") success = successCodes.has(code);
  else success = true;

  return { success, code, message, data };
}

/** 业务错误 → 归一化 CHANNEL_ERROR（code 保留渠道原值，便于人工对文档） */
export function bizFailure(env: BizEnvelope, rawBody?: unknown): ChannelFailure {
  const code = env.code || "UNKNOWN";
  const message = `渠道业务失败 [${code}]${env.message ? `：${env.message}` : ""}`;
  const detail = rawBody === undefined ? undefined : truncate(safeStringify(rawBody));
  return fail("CHANNEL_ERROR", message, detail);
}

/* ============================================================ 报文取值 */

/** 安全取对象（非对象一律给空对象，避免下游到处判空） */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 安全取数组（非数组一律给空数组） */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 取字符串值：字符串 trim、有限数字转字符串，其它给空串 */
export function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 取数字值：数字原样、数字字符串转换，其它给 fallback */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * 两个 YYYY-MM-DD 之间相差几晚；任一不可解析或倒挂时返回 0。
 * 渠道给的 nights 字段常常缺失，用日期兜底比默认 1 晚更接近真实。
 */
export function diffNights(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00`);
  const b = Date.parse(`${checkOut}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}
