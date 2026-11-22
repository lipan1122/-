/**
 * 登录接口加暴力破解防护（上线前安全加固）
 *
 * ── 为什么必须加 ──
 * 审计发现：登录接口零防护，配合「登录页明文写着 admin/admin123」，
 * 任何人都能直接接管管理员。就算口令改了，没有限速也能暴力猜解。
 *
 * 数据库里早有 login_attempts 表（字段 login_key / fail_count / locked_until），
 * 但 src/ 里 0 处引用 —— 表建了从来没用过。
 *
 * ── 策略 ──
 *   · 维度：IP + 账号 双 key（防同一 IP 换账号爆破，也防同一账号换 IP 爆破）
 *   · 阈值：同一 key 连续失败 5 次 → 锁 15 分钟
 *   · 成功即清零
 *   · 失败/锁定都写 op_logs，事后可查
 *   · 锁定期间统一返回「尝试过多，请稍后再试」，不暴露是「账号错」还是「被锁」
 */
import { get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export type AttemptResult =
  | { ok: true }
  | { ok: false; reason: "locked"; remainMinutes: number }
  | { ok: false; reason: "recorded"; fails: number };

/** 确保表存在（迁移里建过，这里兜底） */
function ensureTable(): void {
  try {
    run(`CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_key TEXT NOT NULL,
      fail_count INTEGER DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT
    )`);
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(login_key)`);
  } catch {
    /* 只读库等异常情况跳过，不阻断登录 */
  }
}

/** 组合 key：IP 一份、账号一份，任一超限都锁 */
function keysOf(ip: string, username: string): string[] {
  return [`ip:${ip}`, `user:${username.toLowerCase()}`];
}

/**
 * 登录前检查：是否已被锁定
 * 返回 locked 时直接拒绝，不必再验密码（也避免时序泄露账号是否存在）
 */
export function checkLocked(ip: string, username: string): { locked: boolean; remainMinutes: number } {
  ensureTable();
  const now = new Date();
  let worst = 0;
  for (const key of keysOf(ip, username)) {
    const row = get<{ locked_until: string | null; fail_count: number }>(
      `SELECT locked_until, fail_count FROM login_attempts WHERE login_key = ?`,
      [key]
    );
    if (!row?.locked_until) continue;
    const until = new Date(row.locked_until);
    if (until > now) {
      const mins = Math.ceil((until.getTime() - now.getTime()) / 60000);
      if (mins > worst) worst = mins;
    }
  }
  return { locked: worst > 0, remainMinutes: worst };
}

/**
 * 记录一次失败。
 * 达到阈值后写 locked_until，并返回 locked。
 */
export function recordFailure(
  ip: string,
  username: string,
  hotelId: number | null,
  operatorLabel: string
): AttemptResult {
  ensureTable();
  const now = new Date();
  let locked = false;
  let remain = 0;
  let maxFails = 0;

  for (const key of keysOf(ip, username)) {
    const row = get<{ fail_count: number }>(
      `SELECT fail_count FROM login_attempts WHERE login_key = ?`,
      [key]
    );
    const fails = (row?.fail_count ?? 0) + 1;
    if (fails > maxFails) maxFails = fails;

    if (fails >= MAX_FAILS) {
      locked = true;
      remain = LOCK_MINUTES;
      const until = new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString();
      run(
        row
          ? `UPDATE login_attempts SET fail_count = ?, locked_until = ?, updated_at = ? WHERE login_key = ?`
          : `INSERT INTO login_attempts (fail_count, locked_until, updated_at, login_key) VALUES (?,?,?,?)`,
        row ? [fails, until, now.toISOString(), key] : [fails, until, now.toISOString(), key]
      );
    } else {
      run(
        row
          ? `UPDATE login_attempts SET fail_count = ?, locked_until = NULL, updated_at = ? WHERE login_key = ?`
          : `INSERT INTO login_attempts (fail_count, locked_until, updated_at, login_key) VALUES (?,?,?,?)`,
        row ? [fails, now.toISOString(), key] : [fails, null, now.toISOString(), key]
      );
    }
  }

  /* 审计留痕：失败也记，事后能查出被爆破 */
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId ?? 0,
      operatorLabel,
      locked ? "登录锁定" : "登录失败",
      `${locked ? `连续失败 ${maxFails} 次，锁定 ${LOCK_MINUTES} 分钟` : `失败 ${maxFails} 次`}（IP ${ip}）`,
      nowIso(),
    ]);
  } catch {
    /* 日志写失败不影响登录流程 */
  }

  return locked
    ? { ok: false, reason: "locked", remainMinutes: remain }
    : { ok: false, reason: "recorded", fails: maxFails };
}

/** 登录成功：清空该 IP + 账号的失败计数，并记审计 */
export function clearFailures(ip: string, username: string, hotelId: number, operatorLabel: string): void {
  ensureTable();
  for (const key of keysOf(ip, username)) {
    try {
      run(`DELETE FROM login_attempts WHERE login_key = ?`, [key]);
    } catch {
      /* 忽略 */
    }
  }
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      hotelId,
      operatorLabel,
      "登录成功",
      `IP ${ip}`,
      nowIso(),
    ]);
  } catch {
    /* 忽略 */
  }
}

/** 从请求头取真实 IP（走 nginx / 隧道时取 x-forwarded-for 首段） */
export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim().slice(0, 64);
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim().slice(0, 64);
  return "unknown";
}
