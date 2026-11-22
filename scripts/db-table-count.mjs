/**
 * 输出数据库里的表数量（供 shell 脚本判断「是否已初始化」）
 *
 * 用法：
 *   node scripts/db-table-count.mjs            # 输出数字，失败输出 0
 *   node scripts/db-table-count.mjs data/x.db  # 指定库文件
 *
 * 为什么需要它：
 *   部署脚本原来用 `[ -f data/pms.db ]` 判断「数据库是否已初始化」，
 *   但 `next build` 时 db.ts 会 new DatabaseSync() —— SQLite 立刻创建一个
 *   4KB 的空库文件（0 张表）。于是脚本误以为已初始化、跳过 init-db，
 *   接着 migrate-all 在空库上跑就报 `no such table: channel_orders`。
 *
 *   正确的判据是「有多少张表」：空库 0 张，init-db 建完 80+ 张。
 *
 * 为什么用 node 而不是 sqlite3 命令：
 *   sqlite3 CLI 需要 apt 安装，补丁脚本（finish-vps.sh）不一定装过；
 *   node 是运行的硬前提，一定存在。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const file = process.argv[2] ?? "data/pms.db";

if (!existsSync(file)) {
  console.log(0);
  process.exit(0);
}

try {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'`).get();
  db.close();
  console.log(Number(row?.c ?? 0));
} catch {
  /* 文件损坏 / 不是 SQLite 库 / 权限不足：一律当 0 处理，让调用方重建 */
  console.log(0);
}
