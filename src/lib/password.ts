/**
 * 密码哈希与校验
 *
 * 用 node:crypto 的 scrypt（无外部依赖，抗 GPU 暴力破解优于 pbkdf2）。
 * 存储格式：scrypt$N$r$p$salt$hash（全部 hex/base64url）
 *
 * 整改报告 P0-2.2：users.password 明文 → password_hash
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384; // CPU/内存成本
const R = 8;
const P = 1;
const KEYLEN = 64;

/** 生成哈希串 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** 校验密码（哈希串非法或密码错都返回 false） */
export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, sN, sR, sP, saltB64, hashB64] = parts;
  const n = Number(sN);
  const r = Number(sR);
  const p = Number(sP);
  if (!n || !r || !p) return false;
  try {
    const salt = Buffer.from(saltB64, "base64url");
    const expect = Buffer.from(hashB64, "base64url");
    const actual = scryptSync(plain, salt, expect.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
    return actual.length === expect.length && timingSafeEqual(actual, expect);
  } catch {
    return false;
  }
}

/** 是否是本模块产出的哈希串 */
export function isHashed(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}
