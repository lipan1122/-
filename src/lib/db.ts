import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DB_DIR, "pms.db");

declare global {
  // eslint-disable-next-line no-var
  var __pmsDb: DatabaseSync | undefined;
}

export function getDb(): DatabaseSync {
  if (globalThis.__pmsDb) return globalThis.__pmsDb;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  /*
   * 写锁等待（整改清单 P2-29 配套）：
   * tx() 改成 BEGIN IMMEDIATE 后，事务开头就要取 RESERVED 锁。
   * 多实例部署（DEPLOY-SERVER.md）时两个进程同时开事务，后到的那个必须排队等，
   * 而不是立刻抛 SQLITE_BUSY —— 而 SQLite 默认 busy_timeout 是 0（不等待）。
   * 10 秒上限与 scripts/migrate-all.mjs 的 CLI 保持一致：
   * 正常的业务事务是亚毫秒级，真等满 10 秒说明有长事务卡住，此时报错比无限等更好。
   */
  db.exec("PRAGMA busy_timeout = 10000;");
  globalThis.__pmsDb = db;
  return db;
}

export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const rows = getDb().prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  // node:sqlite 返回 null-prototype 对象，转成普通对象才能传给 Client Component
  return rows.map((r) => ({ ...r })) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  const row = getDb().prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  return row ? ({ ...row } as T) : undefined;
}

export function run(sql: string, params: unknown[] = []) {
  const r = getDb().prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/**
 * 同步事务包装
 *
 * 整改清单 P2-29：原来用 `BEGIN`（deferred），在多实例部署下会出问题。
 *
 * SQLite 的 `BEGIN` 是 deferred：事务开始时不拿任何锁，第一条**读**语句拿 SHARED，
 * 第一条**写**语句才尝试升级成 RESERVED。如果两个进程几乎同时「先读后写」，
 * 后写的那一方在升级锁时会拿到 `SQLITE_BUSY_SNAPSHOT`（WAL 模式下读快照已不可升级），
 * 而这个错误**不会**被 busy_timeout 重试 —— 它直接失败，业务表现为偶发的
 * 「结账失败」「排房失败」，而且日志里只有一句 database is locked。
 *
 * `BEGIN IMMEDIATE` 在事务开头就取 RESERVED 写锁：
 *   · 单进程内完全等价（本来就没有并发）；
 *   · 多进程时后来的事务在 BEGIN 处就排队（busy_timeout 生效），
 *     不会出现「读到旧快照再想写」的不可恢复冲突。
 *
 * 只用 BEGIN IMMEDIATE 而不用 EXCLUSIVE：
 *   IMMEDIATE 允许其它连接继续读（WAL 下读不阻塞），开房态图这类只读页面不受影响；
 *   EXCLUSIVE 会把所有读者挡在门外，前台一边开房一边就刷不出房态了。
 *
 * 注意：本函数是全同步的（node:sqlite 同步 API），不支持 await。
 * 需要 await 的逻辑请先算完再进事务，不要在 fn 里写 await —— 那会让事务跨越
 * 多个事件循环 tick，把锁持有时间从微秒级拉长到无法预估。
 */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    // 回滚本身也可能失败（连接已断/事务已被 SQLite 自动回滚），
    // 那种情况下不能掩盖原始错误 —— 保留业务异常是排查的第一手线索。
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已结束，忽略 */
    }
    throw e;
  }
}
