/**
 * 对称加密工具（整改清单 P2-11）
 *
 * ── 为什么需要它 ──
 * `channels` 表把携程 / 美团 / 飞猪 / 抖音的 app_secret 以**明文 TEXT** 存库。
 * 拿到 `data/pms.db`（备份、云盘同步、开发机拷贝）的任何人都能直接读走渠道密钥，
 * 再拿它去调用渠道方接口改房态房价。清单 P2-11 的要求是「至少加密」。
 *
 * ── 算法与密钥 ──
 *   · AES-256-GCM：现代 Node 自带，**不引入任何新依赖**（只用 node:crypto）；
 *   · 密钥 = scrypt(SESSION_SECRET, 固定盐)，32 字节；
 *     SESSION_SECRET 是 .env.example 里已约定的必配项（生产缺省会拒绝登录）。
 *   · 每条密文自带 12 字节随机 IV，因此同一明文两次加密结果不同
 *     （不会出现「密文相同 = 密钥相同」的推断）。
 *
 * ── 密文格式（单列 TEXT 即可存下，不需要额外的 iv / tag 列）──
 *   `enc:v1:<iv base64>:<auth tag base64>:<ciphertext base64>`
 *   前缀带版本号，将来换算法时能按前缀区分新旧数据、平滑迁移。
 *
 * ── 兼容既有明文 ──
 * `decryptSecret()` 对**不是本格式**的值原样返回：老库里还是明文的行、
 * 演示库里的 `••••••••` 掩码占位、以及测试里的普通占位串都能直接读取，
 * 不会因为「还没跑迁移」就把渠道配置读成空字符串。
 *
 * ⚠️ 部署注意：换 SESSION_SECRET 会导致已加密的渠道密钥无法解密。
 * 换密钥时必须先解密再重新加密（scripts/migrate-all.mjs 的加密迁移是幂等的，
 * 但只能用当时进程里的 SESSION_SECRET）。这一点写进 DEPLOY 文档更稳妥。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** 密文前缀（含版本号）；改算法时升到 v2 */
export const SECRET_ENVELOPE_PREFIX = "enc:v1:";

/** 派生密钥用的固定盐：盐不是秘密，作用只是把同一 SESSION_SECRET 用在别处时不会撞出同一把钥 */
const KEY_SALT = "pms:channel-secret:v1";

/** 未配置 SESSION_SECRET 时的兜底material（仅开发 / 演示；生产必须配 SESSION_SECRET） */
const DEV_FALLBACK_MATERIAL = "pms-dev-only-channel-secret";

/** 页面上代替真实密钥显示的掩码 */
export const MASKED_SECRET = "••••••••";

let cachedKey: Buffer | null = null;

/** 派生 32 字节 AES key（scrypt 有成本，进程内缓存一次） */
function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = (process.env.SESSION_SECRET ?? "").trim();
  const material = configured === "" ? DEV_FALLBACK_MATERIAL : configured;
  cachedKey = scryptSync(material, KEY_SALT, 32);
  return cachedKey;
}

/** 是否是本模块产出的密文（老库明文 / 掩码返回 false） */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(SECRET_ENVELOPE_PREFIX);
}

/**
 * 加密一个密钥。
 *
 * 空串 / 掩码占位**不做加密**，原样返回：掩码表示「这次没改」，
 * 加密后变成一段看起来像真密钥的密文，反而会掩盖「其实没配」这件事。
 */
export function encryptSecret(plain: string | null | undefined): string {
  const value = typeof plain === "string" ? plain : "";
  if (value === "" || isEncryptedSecret(value)) return value;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${SECRET_ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * 解密（容错版）。
 *
 * 返回空字符串的情形：空值、解密失败（密钥换了 / 数据被截断）。
 * 返回原文的情形：不是本模块的密文格式（历史明文、掩码占位）。
 * 这样调用方（buildChannelConfig）永远拿到一个 string，不用到处判空。
 */
export function decryptSecret(value: string | null | undefined): string {
  const stored = typeof value === "string" ? value : "";
  if (!isEncryptedSecret(stored)) return stored;

  const body = stored.slice(SECRET_ENVELOPE_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) return "";
  const [ivB64, tagB64, dataB64] = parts;

  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // 认证标签校验失败 = 密钥不匹配或密文损坏；宁可当作「没配」也不要拿半截密钥去撞渠道网关
    return "";
  }
}

/** 掩码显示：有值就只回显 8 个圆点，空值回空串（页面据此显示「未配置」） */
export function maskSecret(value: string | null | undefined): string {
  const plain = decryptSecret(value);
  return plain === "" ? "" : MASKED_SECRET;
}
