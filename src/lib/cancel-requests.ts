/**
 * 取消入住审批表（cancel_requests）的建表与懒初始化
 *
 * ── 为什么单独一个文件 ──
 *
 * 这张表是「懒建」的（不在 init-db / migrate-all 里），原来 DDL 和 `run(DDL)`
 * 都直接写在 `src/app/(main)/inhouse/actions.ts` 的**模块顶层**，带来两个问题：
 *
 * 1. **构建期写库导致失败**（VPS 上暴露）
 *    `next build` 的 Collecting page data 阶段开多个 worker 并行 import 页面模块，
 *    每个 worker 都执行顶层 `run(DDL)` → 多进程同时对同一 SQLite 文件写 →
 *      Error: database is locked (errcode 5)
 *      Error: Failed to collect page data for /inhouse
 *
 * 2. **Server Component 拿不到这个函数**
 *    `actions.ts` 是 `"use server"`，只能导出 async 函数，导出别的会被当成
 *    server action 处理；而 `inhouse/page.tsx` 是 Server Component，直接 import
 *    调用会变成 action 代理（异步），没法在渲染时同步等它。
 *
 * 所以把「DDL + 幂等建表」放到普通模块，页面和 action 都从这里拿。
 *
 * ── 使用约定 ──
 * 任何会读写 cancel_requests 的地方，**先调一次 ensureCancelRequestsTable()**。
 * 它有内存态短路，稳态下只是一次布尔判断。
 */
import { run } from "@/lib/db";

const DDL = `CREATE TABLE IF NOT EXISTS cancel_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  stay_id INTEGER,
  room_no TEXT,
  guest_name TEXT,
  reason TEXT,
  status TEXT DEFAULT 'PENDING',
  requested_by TEXT,
  approved_by TEXT,
  created_at TEXT,
  approved_at TEXT
)`;

let ready = false;

/** 幂等建表（首次调用执行 DDL，之后直接返回） */
export function ensureCancelRequestsTable(): void {
  if (ready) return;
  run(DDL);
  ready = true;
}
