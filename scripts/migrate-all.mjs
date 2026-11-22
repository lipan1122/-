/**
 * 统一数据库迁移
 *
 * 整改报告第 11/13 节要求：schema 迁移必须可重复执行，跑多少次结果一致。
 *
 * ── P0-1「建表与迁移不同步」的根治方式 ──
 * 以前所有增量变更只写在 scripts/migrate-all.mjs，scripts/init-db.mjs 完全不知道，
 * 于是「全新部署」跑 npm run db:init 出来的库缺 booking_rooms / shifts / room_anomalies
 * 三张表，缺 payments / housekeeping 的新列，缺一批索引 —— 入住、收款、渠道、夜审在干净
 * 环境上一律报 no such table / no such column。
 *
 * 现在把本脚本拆成两层：
 *   1. runMigrations(db, { checkOnly })：可被 import 的纯逻辑，CLI 与 init-db 共用同一份；
 *   2. 文件末尾的 CLI 入口：仍然是 node scripts/migrate-all.mjs [--check]。
 * 以后新增迁移只需要改 runMigrations 一处，init-db 自动跟着走，
 * 不会再出现「两份 schema 各自演化」的漂移。
 *
 * 用法：
 *   node scripts/migrate-all.mjs                          # 默认 data/pms.db
 *   PMS_DB_PATH=/path/pms.db node scripts/migrate-all.mjs
 *   node scripts/migrate-all.mjs --check                  # 只检查不修改
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 渠道凭据加密（整改清单 P2-11）
 *
 * 直接复用运行时那份实现，**不在这里另抄一份 AES-GCM**：
 * 密文格式（enc:v1:iv:tag:data）和派生方式只要有一处不一致，迁移写进去的密文
 * 运行时就读不出来，表现为「渠道配置突然全没了」——这种事故排查成本极高。
 * 这是本仓库唯一一处 .mjs 引 .ts：Node ≥ 22.18 原生剥离类型，实测可用。
 */
import { encryptSecret, isEncryptedSecret } from "../src/lib/crypto.ts";

/** 数据库路径：命令行、init-db、体检脚本统一口径 */
export function resolveDbPath() {
  return process.env.PMS_DB_PATH ?? path.join(process.cwd(), "data", "pms.db");
}

/* ============================================================ 密码哈希
 *
 * 整改 8.1 / 8.3：users.password（明文/历史上就地的哈希）→ 独立的 password_hash 列。
 *
 * 为什么这里自带一份实现，而不是 import src/lib/password.ts：
 *   runMigrations 是同步函数（init-db.mjs 在收尾处同步调用它），无法 await 加载 TS 模块；
 *   迁移脚本又必须在全新库（init-db 路径）和老库（CLI 路径）上都能跑。
 *
 * 与 src/lib/password.ts 的契约（改动必须两边同步）：
 *   参数：scrypt N=16384 r=8 p=1 KEYLEN=64，salt 16 字节随机
 *   格式：scrypt$N$r$p$<salt base64url>$<hash base64url>
 *   scripts/test-security-fix.mjs 会用真正的 password.ts 去 verify 本脚本产出的哈希，
 *   两份实现一旦漂移，测试会直接失败。
 */
const PWD_N = 16384;
const PWD_R = 8;
const PWD_P = 1;
const PWD_KEYLEN = 64;

function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, PWD_KEYLEN, { N: PWD_N, r: PWD_R, p: PWD_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${PWD_N}$${PWD_R}$${PWD_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function isHashedPassword(stored) {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

/* ============================================================ 权限配置种子（整改 5.2）
 *
 * 背景：整改要求「统一使用数据库中的岗位和角色权限，设置页改完必须即时影响接口判断」。
 * 以前 src/lib/session.ts 有两张硬编码表，迁移只负责把它们「原样搬进库」这一次：
 *
 *   ROLE_MODULES  → role_modules      角色 → 可访问的页面模块（canAccess / 路由守卫）
 *   PERMISSIONS   → role_permissions  角色 → 权限点（hasPermission / requirePermission）
 *   （新增）      → permission_dict   权限点字典：中文名 + 归属模块 + 说明，给设置页渲染矩阵
 *
 * ⚠️ 一致性契约：下面两份常量必须与 src/lib/session.ts 的 ROLE_MODULES / PERMISSIONS 一致。
 *    迁移之后数据库才是权威来源，session.ts 里的常量退化为「库还没迁移 / 某角色没配置」时的
 *    降级兜底值。两边漂移不会报错，只会让兜底默认值与库里已有配置不同 —— 所以改一边要同时改另一边。
 */

/** 角色 → 页面模块（与 session.ts 的 ROLE_MODULES 同构，admin 用 "*" 表示全部） */
const RBAC_ROLE_MODULES = {
  admin: "*",
  frontdesk: [
    "/rooms",
    "/bookings",
    "/frontdesk",
    "/guests",
    "/guest-detail",
    "/inhouse",
    "/cashier",
    "/orders",
    "/channel-orders",
    "/housekeeping",
    "/cleaners",
    "/meal-vouchers",
    "/breakfast",
    "/today-todo",
    "/notices",
    "/lost-found",
    "/id-verify",
    "/members",
    "/member-cards",
    "/points",
    "/dashboard",
    "/handover",
    "/mobile-housekeeping",
  ],
  cashier: [
    "/cashier",
    "/finance",
    "/ar",
    "/invoices",
    "/reports",
    "/members",
    "/member-cards",
    "/points",
    "/orders",
    "/shop",
    "/meal-vouchers",
    "/guest-detail",
    "/today-todo",
    "/notices",
    "/dashboard",
    "/handover",
  ],
  housekeeping: [
    "/rooms",
    "/housekeeping",
    "/mobile-housekeeping",
    "/cleaners",
    "/lost-found",
    "/today-todo",
    "/notices",
    "/dashboard",
  ],
};

/** 权限点 → 允许的角色（与 session.ts 的 PERMISSIONS 同构） */
const RBAC_PERMISSIONS = {
  "room.view": ["admin", "frontdesk", "cashier", "housekeeping"],
  "room.change_status": ["admin", "frontdesk", "housekeeping"],
  "booking.view": ["admin", "frontdesk"],
  "booking.create": ["admin", "frontdesk"],
  "booking.assign_room": ["admin", "frontdesk"],
  "booking.cancel": ["admin", "frontdesk"],
  "booking.modify": ["admin", "frontdesk"],
  "booking.delete": ["admin", "frontdesk"],
  "checkin.create": ["admin", "frontdesk"],
  "checkin.cancel": ["admin", "frontdesk"],
  "folio.post_charge": ["admin", "frontdesk"],
  "cashier.view": ["admin", "frontdesk", "cashier"],
  "cashier.receive": ["admin", "frontdesk", "cashier"],
  "cashier.refund": ["admin", "cashier"],
  "cashier.checkout": ["admin", "frontdesk", "cashier"],
  "cashier.reverse_checkout": ["admin"],
  "cashier.charge_company": ["admin", "cashier"],
  "cashier.transfer": ["admin", "cashier"],
  "cashier.split": ["admin", "cashier"],
  "invoice.void": ["admin", "cashier"],
  "night_audit.run": ["admin"],
  "report.view_finance": ["admin", "cashier"],
  "report.view_operation": ["admin", "frontdesk", "cashier"],
  "channel.configure": ["admin"],
  "channel.sync": ["admin"],
  "settings.manage": ["admin"],
  "user.manage": ["admin"],
  "guest.view_sensitive": ["admin", "frontdesk"],
  "guest.modify": ["admin", "frontdesk"],
  "member.manage": ["admin", "frontdesk"],
  "member.view_sensitive": ["admin", "frontdesk", "cashier"],
  // 第六轮整改 一.1：撤销早餐核销（cashier.refund 是退钱、reverse_checkout 是撤销退房，都不同义）
  "breakfast.void": ["admin", "frontdesk"],
};

/**
 * 权限点字典：设置页「权限矩阵」的中文名与说明。
 * label 必须是给人看的中文；module 是归属分组（矩阵按它分组显示）。
 */
const RBAC_PERMISSION_DICT = [
  { permission: "room.view", label: "查看房态", module: "room", description: "房态图、房间列表等只读查看" },
  { permission: "room.change_status", label: "修改房态", module: "room", description: "置净 / 置脏 / 锁房 / 维修等房态变更" },
  { permission: "booking.view", label: "查看预订", module: "booking", description: "预订列表与预订详情" },
  { permission: "booking.create", label: "创建预订", module: "booking", description: "新建预订、批量建单" },
  { permission: "booking.assign_room", label: "排房与换房", module: "booking", description: "给预订排房、在住换房" },
  { permission: "booking.cancel", label: "取消预订", module: "booking", description: "取消预订、批量取消" },
  { permission: "booking.modify", label: "修改预订", module: "booking", description: "改价、改备注、确认、免费升级、入团" },
  { permission: "booking.delete", label: "删除预订", module: "booking", description: "物理删除预订记录" },
  { permission: "checkin.create", label: "办理入住", module: "checkin", description: "入住登记、续住" },
  { permission: "checkin.cancel", label: "取消入住", module: "checkin", description: "发起 / 审批入住取消" },
  { permission: "folio.post_charge", label: "账单过账", module: "cashier", description: "把房费等应收记入账单（不涉及收款）" },
  { permission: "cashier.view", label: "查看收银台", module: "cashier", description: "查看账单、流水与在住账务" },
  { permission: "cashier.receive", label: "收款", module: "cashier", description: "收取押金、房费、消费款" },
  { permission: "cashier.refund", label: "退款", module: "cashier", description: "退回已收款项" },
  { permission: "cashier.checkout", label: "退房结账", module: "cashier", description: "结清账单并办理退房" },
  { permission: "cashier.reverse_checkout", label: "撤销退房", module: "cashier", description: "撤销已完成的退房，恢复在住" },
  { permission: "cashier.charge_company", label: "挂公司账", module: "cashier", description: "把账单转为单位挂账（AR）" },
  { permission: "cashier.transfer", label: "账单转账", module: "cashier", description: "在账单之间转移金额" },
  { permission: "cashier.split", label: "拆分账单", module: "cashier", description: "把一张账单拆成多张" },
  { permission: "invoice.void", label: "红冲发票", module: "cashier", description: "对已开发票红冲：生成负数票并把原票置为已红冲" },
  { permission: "night_audit.run", label: "执行夜审", module: "night_audit", description: "过账房费、NOSHOW、营收汇总（影响全店）" },
  { permission: "report.view_finance", label: "查看财务报表", module: "report", description: "营收、账务类报表" },
  { permission: "report.view_operation", label: "查看经营报表", module: "report", description: "出租率、客源等经营类报表" },
  { permission: "channel.configure", label: "配置渠道", module: "channel", description: "OTA 渠道参数与房型映射" },
  { permission: "channel.sync", label: "同步渠道", module: "channel", description: "手动推送房态 / 拉取订单" },
  { permission: "settings.manage", label: "系统设置", module: "settings", description: "房型、房价、参数等系统配置" },
  { permission: "user.manage", label: "账号与岗位", module: "settings", description: "操作员账号、岗位与员工管理" },
  { permission: "guest.view_sensitive", label: "查看客人敏感信息", module: "guest", description: "证件号、手机号等敏感字段" },
  { permission: "guest.modify", label: "修改客人资料", module: "guest", description: "编辑客人档案与联系方式" },
  { permission: "member.manage", label: "会员等级变更", module: "member", description: "升级 / 取消会员等级、按规则批量自动升级（影响折扣与积分权益）" },
  { permission: "member.view_sensitive", label: "查看会员敏感信息", module: "member", description: "会员余额、手机号等敏感字段" },
  {
    permission: "breakfast.void",
    label: "撤销早餐核销",
    module: "breakfast",
    description: "把已核销的早餐记录退回待核销（不改金额、不退房）",
  },
];

/**
 * 执行（或仅检查）全部增量迁移。
 *
 * @param {import("node:sqlite").DatabaseSync} db 已打开的连接；本函数不负责关闭
 * @param {{ checkOnly?: boolean }} [options] 只检查不落库
 * @returns {{ changed: number, applied: string[], skipped: string[], notes: string[], checkOnly: boolean }}
 *   changed 为实际落库的变更数；applied 是本次应用到（checkOnly 时指「待应用」）的条目；
 *   skipped 是已是目标状态被跳过的条目；notes 是给调用方打印的补充信息（不含业务错误）。
 */
export function runMigrations(db, { checkOnly = false } = {}) {
  const all = (sql, p = []) => db.prepare(sql).all(...p);

  let changed = 0;
  const applied = [];
  const skipped = [];
  const notes = [];

  function hasColumn(table, column) {
    try {
      return all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
    } catch {
      return false;
    }
  }
  function hasIndex(name) {
    return all(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`, [name]).length > 0;
  }
  function hasTable(name) {
    return all(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]).length > 0;
  }

  function addColumn(table, column, ddl) {
    if (!hasTable(table)) {
      skipped.push(`${table}（表不存在）`);
      return;
    }
    if (hasColumn(table, column)) {
      skipped.push(`${table}.${column}`);
      return;
    }
    if (checkOnly) {
      applied.push(`${table}.${column}（待加）`);
      return;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    applied.push(`${table}.${column}`);
    changed += 1;
  }

  function addIndex(name, ddl) {
    if (hasIndex(name)) {
      skipped.push(name);
      return;
    }
    /*
     * 建表同步保护（整改清单 P2-2）
     *
     * 项目里有相当一批表只在页面/action 里懒创建（lost_items / channel_room_types /
     * ar_accounts ...）。迁移脚本给它们建索引时，如果全新部署的库还没有那张表，
     * CREATE INDEX 会抛 `no such table: main.xxx` —— 整段 runMigrations 崩在中途，
     * 而 init-db.mjs 收尾就是调 runMigrations，结果是「全新部署初始化直接失败」，
     * 连缺表提示都看不到。
     *
     * 这里从 DDL 里解析出目标表名，表不存在就跳过（而不是崩）。
     * checkOnly 下仍然如实报「待建」，不静默：先把这个缺表补齐再谈目标状态。
     */
    const onTable = /ON\s+([A-Za-z_]\w*)/i.exec(ddl)?.[1];
    if (onTable && !hasTable(onTable)) {
      if (checkOnly) applied.push(`${name}（待建：表 ${onTable} 尚未创建）`);
      else skipped.push(`${name}（表 ${onTable} 还不存在，跳过）`);
      return;
    }
    if (checkOnly) {
      applied.push(`${name}（待建）`);
      return;
    }
    db.exec(ddl);
    applied.push(name);
    changed += 1;
  }

  /**
   * payments.kind 旧数据回填（第九轮 P1-2）
   *
   * 只处理 kind IS NULL 的行，返回本次填了多少、还剩多少待核对。
   * 「可判定」的两种情形见 1b 段注释；其余保持 NULL —— 清单要求
   * 「无法判断的旧记录标记待核对，不要静默归类」，NULL 就是那个标记。
   */
  function backfillPaymentKind() {
    const update = (sql) => Number(db.prepare(sql).run().changes ?? 0);

    /* ① 押金 / 预收（非退款行）：备注锚点是旧数据唯一的可靠线索 */
    const deposit = update(
      `UPDATE payments
          SET kind = 'DEPOSIT'
        WHERE kind IS NULL
          AND refund_of IS NULL
          AND (remark LIKE '%押金%' OR remark LIKE '%预收%')`
    );

    /* ② 退款行：按原收款的 kind 定性。原收款自己也是 NULL → 本行同样留 NULL（待核对） */
    const refund = update(
      `UPDATE payments
          SET kind = CASE
                       WHEN (SELECT o.kind FROM payments o
                              WHERE o.id = payments.refund_of AND o.hotel_id = payments.hotel_id) = 'DEPOSIT'
                         THEN 'DEPOSIT_REFUND'
                       ELSE 'ROOM_REFUND'
                     END
        WHERE kind IS NULL
          AND refund_of IS NOT NULL
          AND (SELECT o.kind FROM payments o
                WHERE o.id = payments.refund_of AND o.hotel_id = payments.hotel_id) IS NOT NULL`
    );

    const pending = Number(
      all(`SELECT COUNT(*) AS n FROM payments WHERE kind IS NULL`)[0]?.n ?? 0
    );
    return { filled: deposit + refund, deposit, refund, pending };
  }

  /* ---------- 1. 收款：幂等键 / 退款关联 / 操作人 ---------- */
  addColumn("payments", "request_id", "TEXT");
  addColumn("payments", "refund_of", "INTEGER");
  addColumn("payments", "operator", "TEXT");
  addIndex(
    "idx_payments_request",
    `CREATE UNIQUE INDEX idx_payments_request ON payments(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );

  /* ---------- 1b. 收款性质 kind（第九轮 P1-2：押金不能再靠备注识别） ----------
   *
   * ── 缺陷 ──
   * payments 只有 remark：押金靠「备注含押金/预收」识别。
   * 备注写成「订金」→ 退房找不到原押金（refund_of 为空、押金退不回去）；
   * 手动退款与退房退款各写一套判断 → 口径不一致，同一笔押金可能被退两次；
   * 押金退款报表按备注 LIKE 匹配 → 漏记。
   *
   * ── 修法 ──
   * 加结构化列 kind：ROOM_PAYMENT / DEPOSIT / DEPOSIT_REFUND / ROOM_REFUND / OTHER_PAYMENT。
   * 新写入一律带 kind（收银台/入住/退款/退房/核销），备注写什么都无所谓。
   *
   * ── 旧数据回填（清单第 72-73 行：尽量回填，无法判断的标记待核对，不要静默归类）──
   *   ① 备注含「押金」/「预收」且不是退款 → DEPOSIT（可判定）
   *   ② 退款行（refund_of 非空）→ 按原收款的 kind 决定 DEPOSIT_REFUND / ROOM_REFUND
   *   ③ 其余一律留 NULL（= 待核对），**不猜**：
   *      例如「退房结账」既可能是房费收款也可能是别的，归成 ROOM_PAYMENT 属于静默归类，
   *      会让对账时无法区分「本来就是房费收款」和「我们猜的」。
   *   回填只碰 kind IS NULL 的行，反复执行结果一致（幂等）。
   */
  addColumn("payments", "kind", "TEXT");
  addIndex("idx_payments_kind", `CREATE INDEX idx_payments_kind ON payments(hotel_id, kind, biz_date)`);
  if (!checkOnly && hasTable("payments") && hasColumn("payments", "kind")) {
    const stat = backfillPaymentKind();
    if (stat.filled > 0) {
      applied.push(`payments.kind 旧数据回填（${stat.filled} 条可判定）`);
      changed += 1;
    }
    if (stat.filled > 0 || stat.pending > 0) {
      notes.push(
        `payments.kind 回填：本次 ${stat.filled} 条（押金 ${stat.deposit} / 退款 ${stat.refund}），` +
          `仍留空 ${stat.pending} 条（无判定依据 → kind=NULL 标记待核对，按备注兜底识别）`
      );
    }
  }

  /* ---------- 2. 夜审：唯一键按酒店隔离 ---------- */
  const naSql = all(`SELECT sql FROM sqlite_master WHERE type='table' AND name='night_audits'`)[0]?.sql ?? "";
  if (/biz_date\s+TEXT\s+UNIQUE/i.test(naSql) && !/UNIQUE\s*\(\s*hotel_id\s*,\s*biz_date\s*\)/i.test(naSql)) {
    if (checkOnly) {
      applied.push("night_audits 唯一键待改为 (hotel_id, biz_date)");
    } else {
      db.exec("BEGIN");
      try {
        db.exec(`CREATE TABLE night_audits_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          biz_date TEXT NOT NULL,
          status TEXT,
          rooms_sold INTEGER DEFAULT 0,
          revenue REAL DEFAULT 0,
          occupancy REAL DEFAULT 0,
          operator TEXT,
          created_at TEXT,
          UNIQUE(hotel_id, biz_date)
        )`);
        db.exec(`INSERT INTO night_audits_new (id,hotel_id,biz_date,status,rooms_sold,revenue,occupancy,operator,created_at)
                 SELECT id,hotel_id,biz_date,status,rooms_sold,revenue,occupancy,operator,created_at FROM night_audits`);
        db.exec("DROP TABLE night_audits");
        db.exec("ALTER TABLE night_audits_new RENAME TO night_audits");
        db.exec("COMMIT");
        applied.push("night_audits 唯一键 → (hotel_id, biz_date)");
        changed += 1;
      } catch (e) {
        db.exec("ROLLBACK");
        notes.push(`夜审表改造失败：${e.message}`);
      }
    }
  } else {
    skipped.push("night_audits 唯一键");
  }

  /* ---------- 2b. 夜审营收分列（整改清单 P1-13「夜审口径偏粗」） ----------
   * 背景：night_audits 原来只有一列 revenue（总营收），报表分不出房费 / 餐饮 / 其他，
   *   退款（payments 里 amount < 0 的流水）既没单列也没冲减，页面只能看到一个总数，
   *   回答不了「毛收入 - 退款 = 净收入」这个最基本的问题。
   *
   * 新增列（全部带 DEFAULT 0，老行自动取 0，不破坏任何既有 SELECT）：
   *   revenue_room   房费   —— folio_items.item_type = 'ROOM'
   *   revenue_food   餐饮   —— folio_items.item_type = 'FOOD'
   *   revenue_other  其他   —— folio_items.item_type = 'OTHER'（商超、洗衣等）
   *   refund_total   退款冲减 —— payments.amount < 0（或有 refund_of 的）绝对值之和，
   *                             正数表示「当天退出去多少钱」
   *   revenue_net    净收入 —— 房费 + 餐饮 + 其他 - 退款冲减
   *   hourly_rooms   当日钟点房间数（nights = 0 / rate_code = '钟点'）：
   *                  只做口径留痕，明确「这 N 间房在住但不计出租间夜」，
   *                  免得对账时有人以为系统漏数了房间。
   *
   * revenue 列保留作兼容：夜审继续往里写净收入（= revenue_net），
   *   /reports、/api/export、/today-todo 这些老读法不用改也不用迁移数据。
   *
   * 为什么不回填历史行：总额无法反推三个分类金额，把 revenue_net 直接抄成 revenue
   *   等于把「不知道」伪装成「净收入」。所以历史行 revenue_net 保持 0 作为「未分列」标记，
   *   夜审页据此原样展示历史 revenue（见 night-audit/page.tsx 的 legacy 判定）。
   *
   * 为什么排在「2. 唯一键重建」之后：那一步是整表 CREATE + INSERT..SELECT 固定 9 列，
   *   必须在新列还不存在时完成，否则重建会把分列数据丢掉。同一次迁移里先重建、后补列，
   *   老库升级与全新库最终形态一致。
   *
   * 幂等：addColumn 内部先 PRAGMA table_info 查列，重复执行只进 skipped。
   */
  addColumn("night_audits", "revenue_room", "REAL DEFAULT 0");
  addColumn("night_audits", "revenue_food", "REAL DEFAULT 0");
  addColumn("night_audits", "revenue_other", "REAL DEFAULT 0");
  addColumn("night_audits", "refund_total", "REAL DEFAULT 0");
  addColumn("night_audits", "revenue_net", "REAL DEFAULT 0");
  addColumn("night_audits", "hourly_rooms", "INTEGER DEFAULT 0");

  /* ---------- 3. 渠道订单：酒店内唯一（先清重复再建索引） ---------- */
  // checkOnly 下只统计重复组，让 --check 也能提前暴露「建索引会失败」的库里现状
  if (!hasIndex("idx_channel_orders_key")) {
    const dup =
      all(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM channel_orders GROUP BY hotel_id, channel_type, channel_order_no HAVING COUNT(*) > 1
         )`
      )[0]?.c ?? 0;
    if (dup > 0) {
      if (checkOnly) {
        applied.push(`${dup} 组重复渠道订单（待清理）`);
      } else {
        const r = db
          .prepare(
            `DELETE FROM channel_orders WHERE id NOT IN (
               SELECT MIN(id) FROM channel_orders GROUP BY hotel_id, channel_type, channel_order_no
             )`
          )
          .run();
        notes.push(`清理重复渠道订单 ${r.changes} 条（保留每组最早一条）`);
        changed += 1;
      }
    }
  }
  addIndex(
    "idx_channel_orders_key",
    `CREATE UNIQUE INDEX idx_channel_orders_key ON channel_orders(hotel_id, channel_type, channel_order_no)`
  );

  /* ---------- 3b. 渠道同步日志：失败原因 / 重试次数（报告第 8 节） ---------- */
  // 原来同步日志只有一句 message，失败时看不出是超时、鉴权还是数据问题，
  // 也没法回答「这条已经重试过几次」。补三个诊断列，页面才能把失败详情和重试入口做出来。
  addColumn("channel_sync_logs", "error_code", "TEXT");
  addColumn("channel_sync_logs", "retry_count", "INTEGER DEFAULT 0");
  addColumn("channel_sync_logs", "next_retry_at", "TEXT");

  /* ---------- 4. 房价日历：建表（含可售房量）+ 老表补 allotment ----------
   * 为什么迁移脚本要负责建这张表：
   *   rate_calendar 原本只在 src/app/(main)/settings/actions.ts 里懒创建，而且那份 DDL
   *   没有 allotment。结果是两条路都不完整 ——
   *     · 全新库没人打开「房价设置」→ 表都不存在，rooms/predict 直接 no such table；
   *     · 老库打开过设置 → 表有但缺 allotment，查可售房量报 no such column。
   *   把建表收敛到这里（migrate-all 是 schema 的唯一来源），init-db 收尾跑一遍迁移即得
   *   完整表，老库升级也一并补上，两条路的最终形态完全一致。
   *   注：src 里的 CREATE TABLE IF NOT EXISTS 是幂等兜底，见到已存在的表会直接跳过。
   */
  if (!hasTable("rate_calendar")) {
    if (checkOnly) {
      applied.push("rate_calendar 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE rate_calendar (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          room_type_id INTEGER NOT NULL,
          date TEXT NOT NULL,
          price REAL NOT NULL DEFAULT 0,
          updated_at TEXT,
          allotment INTEGER,
          UNIQUE (hotel_id, room_type_id, date)
        );
      `);
      applied.push("rate_calendar 表");
      changed += 1;
    }
  } else {
    skipped.push("rate_calendar 表");
  }
  addColumn("rate_calendar", "allotment", "INTEGER");

  /* ---------- 5. 多房预订明细表 ---------- */
  if (!hasTable("booking_rooms")) {
    if (checkOnly) {
      applied.push("booking_rooms 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE booking_rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          booking_id INTEGER NOT NULL,
          room_type_id INTEGER,
          room_id INTEGER,
          guest_name TEXT,
          mobile TEXT,
          rate REAL DEFAULT 0,
          status TEXT DEFAULT 'PENDING',
          check_in_date TEXT,
          check_out_date TEXT,
          stay_id INTEGER,
          created_at TEXT
        );
      `);
      applied.push("booking_rooms 表");
      changed += 1;
    }
  } else {
    skipped.push("booking_rooms 表");
  }
  addIndex("idx_booking_rooms_booking", `CREATE INDEX idx_booking_rooms_booking ON booking_rooms(booking_id)`);
  addIndex("idx_booking_rooms_room", `CREATE INDEX idx_booking_rooms_room ON booking_rooms(room_id)`);
  addIndex(
    "idx_booking_rooms_occupied",
    `CREATE UNIQUE INDEX idx_booking_rooms_occupied ON booking_rooms(room_id, check_in_date, check_out_date)
      WHERE room_id IS NOT NULL AND status IN ('CONFIRMED','CHECKED_IN')`
  );

  /* ---------- 4b. 协议单位去重 + 唯一索引（挂账信用额度需要唯一单位） ---------- */
  if (!hasIndex("idx_companies_name")) {
    const dups = all(
      `SELECT hotel_id, name, GROUP_CONCAT(id) AS ids FROM companies
        GROUP BY hotel_id, name HAVING COUNT(*) > 1`
    );
    if (dups.length > 0) {
      if (checkOnly) {
        applied.push(`${dups.length} 组重复协议单位（待合并）`);
      } else {
        for (const d of dups) {
          const ids = String(d.ids).split(",").map(Number).sort((a, b) => a - b);
          const keep = ids[0];
          const drop = ids.slice(1);
          if (drop.length === 0) continue;
          db.prepare(`UPDATE bookings SET company_id = ? WHERE company_id IN (${drop.join(",")})`).run(keep);
          db.prepare(`DELETE FROM companies WHERE id IN (${drop.join(",")})`).run();
          applied.push(`协议单位 ${d.name} 合并 ${drop.length} 条重复`);
          changed += 1;
        }
      }
    }
  }
  addIndex("idx_companies_name", `CREATE UNIQUE INDEX idx_companies_name ON companies(hotel_id, name)`);

  /* ---------- 5a. 多房明细补 guest_id（报告第 4 节字段清单） ---------- */
  addColumn("booking_rooms", "guest_id", "INTEGER");

  /* ---------- 5a2. 为缺少房间明细的预订补生成（数据迁移，不只是 schema） ----------
   * 老库升级时 booking_rooms 是空的新表，历史预订一条明细都没有；
   * init-db 灌完种子预订后同样需要这一步，全新库的多房流程才不会「有预订、没房明细」。
   */
  if (hasTable("booking_rooms")) {
    const missing = all(
      `SELECT b.id, b.hotel_id, b.room_type_id, b.room_id, b.guest_name, b.mobile, b.rate,
              b.status, COALESCE(b.room_count, 1) AS room_count, b.check_in_date, b.check_out_date
         FROM bookings b
        WHERE b.status <> 'CANCELLED'
          AND NOT EXISTS (SELECT 1 FROM booking_rooms br WHERE br.booking_id = b.id)`
    );
    const missingRooms = missing.reduce((n, b) => n + Math.max(1, Number(b.room_count ?? 1)), 0);
    if (missing.length > 0 && checkOnly) {
      applied.push(`为 ${missing.length} 条预订补 ${missingRooms} 条房间明细（待补）`);
    } else if (!checkOnly) {
      const nowIso = new Date().toISOString();
      const ins = db.prepare(
        `INSERT INTO booking_rooms
           (hotel_id, booking_id, room_type_id, room_id, guest_name, mobile, rate, status,
            check_in_date, check_out_date, stay_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      let made = 0;
      for (const b of missing) {
        const n = Math.max(1, Number(b.room_count ?? 1));
        /*
         * 明细状态按「有没有排房」判定，不按主单状态：
         * 主单 CONFIRMED 只表示订单确认，房间还没分配时明细必须是 PENDING。
         * （曾经用主单状态导致 100+ 条未排房明细被标成 CONFIRMED，
         *   这些明细会被占房唯一索引误占、也会让「待排房数」永远算 0。）
         */
        const bookedStatus = b.status === "CHECKED_IN" ? "CHECKED_IN" : "PENDING";
        for (let i = 0; i < n; i += 1) {
          ins.run(
            b.hotel_id,
            b.id,
            b.room_type_id,
            i === 0 ? b.room_id : null, // 只有第 1 间带原房号
            b.guest_name,
            b.mobile,
            b.rate ?? 0,
            b.room_id && i === 0 ? "CONFIRMED" : bookedStatus,
            b.check_in_date,
            b.check_out_date,
            null,
            nowIso
          );
          made += 1;
        }
      }
      if (made > 0) {
        applied.push(`为 ${missing.length} 条预订补生成 ${made} 条房间明细`);
        changed += 1;
      }
    }
  }

  /* ---------- 5a3. 清理「CHECKED_IN 但没有入住单」的脏主单 ----------
   * 种子数据造过一批 status='CHECKED_IN' 的预订但没配套 stays，
   * 导致 booking_rooms 明细永远停在 PENDING、待排房数虚高 165 条。
   * 判断依据：离店日已过 + 没有入住单 → 实际早已离店，状态应为 CHECKED_OUT。
   */
  if (!checkOnly) {
    const today = new Date().toISOString().slice(0, 10);
    const fixMain = db
      .prepare(
        `UPDATE bookings SET status = 'CHECKED_OUT', updated_at = ?
          WHERE status = 'CHECKED_IN'
            AND NOT EXISTS (SELECT 1 FROM stays s WHERE s.booking_id = bookings.id)
            AND check_out_date < ?`
      )
      .run(new Date().toISOString(), today);
    if (Number(fixMain.changes) > 0) {
      const fixDetail = db
        .prepare(
          `UPDATE booking_rooms SET status = 'CHECKED_OUT'
            WHERE status IN ('PENDING','CONFIRMED','CHECKED_IN')
              AND booking_id IN (SELECT id FROM bookings WHERE status = 'CHECKED_OUT')`
        )
        .run();
      applied.push(
        `${fixMain.changes} 条无入住单的 CHECKED_IN 主单修正为 CHECKED_OUT（明细同步 ${fixDetail.changes} 条）`
      );
      changed += 1;
    }
  }

  /* ---------- 5d. 预订房费总价 total_price（整改 P1-12：钟点房价格语义混用） ----------
   * 为什么加这一列：
   *   bookings.rate 在两种业务下语义不一样 ——
   *     日租：rate = 每晚房价，房费总额 = rate × nights × room_count；
   *     钟点：代码里用「nights = 0 + rate = 钟点总价」表示（转钟点房时把总价写进 rate），
   *           再按 rate × nights 汇总就会把钟点房金额算成 0；若某处按「rate × max(1,nights)」算
   *           又会翻倍。同一个字段两种语义，报表/账单按房费口径汇总时金额必然错。
   *   解法是把「真实总价」拆到独立列 total_price：写入时一次算清（日租 = rate × 晚数 × 间数，
   *   钟点 = rate 本身），读取方统一用 COALESCE(total_price, rate × nights × room_count) ——
   *   老数据 total_price 为 NULL 时自动回退原口径，不需要回填、也不会算错。
   * 幂等：addColumn 内部先 PRAGMA 查列，重复执行只会 skip。
   */
  addColumn("bookings", "total_price", "REAL");

  /* ---------- 4c. 客史唯一约束（P1-9：同一手机号/证件号不能有多份档案） ---------- */
  /* 部分索引：空值不参与唯一性判断，没有手机号/证件号的散客可以有多条 */
  addIndex(
    "idx_guests_idno",
    `CREATE UNIQUE INDEX idx_guests_idno ON guests(hotel_id, id_no)
       WHERE id_no IS NOT NULL AND id_no <> ''`
  );
  addIndex(
    "idx_guests_mobile",
    `CREATE UNIQUE INDEX idx_guests_mobile ON guests(hotel_id, mobile)
       WHERE mobile IS NOT NULL AND mobile <> ''`
  );

/* ---------- 5b. 交班记录表 ---------- */
  if (!hasTable("shifts")) {
    if (checkOnly) {
      applied.push("shifts 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE shifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          biz_date TEXT NOT NULL,
          shift_code TEXT NOT NULL,
          shift_name TEXT,
          start_at TEXT,
          end_at TEXT,
          operator TEXT,
          receiver TEXT,
          opening_cash REAL DEFAULT 0,
          cash_in REAL DEFAULT 0,
          cash_out REAL DEFAULT 0,
          expect_cash REAL DEFAULT 0,
          actual_cash REAL DEFAULT 0,
          diff REAL DEFAULT 0,
          pay_summary TEXT,
          note TEXT,
          status TEXT DEFAULT 'OPEN',
          created_at TEXT
        );
      `);
      applied.push("shifts 表");
      changed += 1;
    }
  } else {
    skipped.push("shifts 表");
  }
  addIndex("idx_shifts_hotel_date", `CREATE INDEX idx_shifts_hotel_date ON shifts(hotel_id, biz_date)`);
  addIndex(
    "idx_shifts_open",
    `CREATE UNIQUE INDEX idx_shifts_open ON shifts(hotel_id, operator) WHERE status = 'OPEN'`
  );

  /* ---------- 5c. 房态异常记录表（整改报告第 7 节） ----------
   * 为什么要有这张表：
   *   房态（rooms.status）和入住单（stays.status）是两份独立维护的数据，对不上的时候
   *   原来只在体检脚本里打印一遍，没有记录、没人认领、无法统计处理时长。
   *   这里把不一致落成可追踪的记录：detected_at 发现时间、resolved_at/resolved_by 处理留痕。
   *
   * 为什么不加唯一约束：
   *   「同一房间同类型未处理只留一条」的去重逻辑在写入端做（src/lib/room-anomaly.ts /
   *   scripts/detect-room-anomalies.mjs）。因为异常要能被重复出现统计到 ——
   *   处理完（resolved_at 有值）以后再犯必须能新开一条，唯一索引会挡住这种合法场景。
   *   所以这里只建一个「未处理清单」的部分索引，供体检脚本和报表快速筛。
   */
  if (!hasTable("room_anomalies")) {
    if (checkOnly) {
      applied.push("room_anomalies 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS room_anomalies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          room_id INTEGER,
          room_no TEXT,
          anomaly_type TEXT NOT NULL,
          detail TEXT,
          detected_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          note TEXT
        );
      `);
      applied.push("room_anomalies 表");
      changed += 1;
    }
  } else {
    skipped.push("room_anomalies 表");
  }
  // 部分索引：只索引未处理的异常，加 resolved_at IS NULL 条件让它保持很小
  addIndex(
    "idx_room_anomalies_open",
    `CREATE INDEX IF NOT EXISTS idx_room_anomalies_open ON room_anomalies(hotel_id, resolved_at) WHERE resolved_at IS NULL`
  );

  /* ---------- 6. 营业日切换时间默认配置 ---------- */
  // P0-1 清单里的 settings 默认项：夜审/营业日按 05:00 切，缺这条配置新库的营业日算不出来。
  // checkOnly 下不写库，但要能报出「还缺几家酒店没配」，否则 --check 会漏掉这类数据迁移。
  if (hasTable("hotels") && hasTable("settings")) {
    const hotels = all(`SELECT id FROM hotels`);
    const missingCutoff = [];
    for (const h of hotels) {
      const ex = all(`SELECT id FROM settings WHERE hotel_id = ? AND key = 'biz_day_cutoff'`, [h.id]);
      if (ex.length === 0) missingCutoff.push(h.id);
    }
    if (missingCutoff.length > 0) {
      if (checkOnly) {
        applied.push(`hotel#${missingCutoff.join(",hotel#")} 待补 biz_day_cutoff=05:00`);
      } else {
        for (const hotelId of missingCutoff) {
          db.prepare(`INSERT INTO settings (hotel_id, key, value) VALUES (?,?,?)`).run(hotelId, "biz_day_cutoff", "05:00");
          applied.push(`hotel#${hotelId} biz_day_cutoff=05:00`);
          changed += 1;
        }
      }
    } else {
      skipped.push("biz_day_cutoff");
    }
  }

  /* ---------- 7. 客房中心：维修图片 + 任务创建时房态快照（整改报告第 10 节） ---------- */
  // photos：JSON 数组文本，存维修图片的 data URL 或路径（前端 useFileReader 转 data URL）
  // room_status_snapshot：任务创建那一刻的房间状态（VD/VC/OOO…），便于事后按房态统计
  addColumn("housekeeping", "photos", "TEXT");
  addColumn("housekeeping", "room_status_snapshot", "TEXT");

  /* ---------- 8. 会员储值：余额与流水合并成单一流水表（整改 P1-3） ----------
   * 缺陷：member_wallet（余额）与 member_wallet_transactions（流水）是两张割裂的表，
   *   余额可以单独改、流水另记，两边永远对不上；退款也没有
   *   「累计退款 ≤ 累计充值 − 已消费」的约束。
   *
   * 收敛后的模型：
   *   · member_wallet_ledger：唯一记账明细。biz_type ∈ RECHARGE/CONSUME/REFUND/ADJUST，
   *     amount 正数入账、负数出账，balance_after 是记账后的余额快照（对账用）。
   *   · member_wallet.balance：只作「当前余额缓存」，一律由 ledger 求和后回写，
   *     业务代码不再允许单独 UPDATE 余额（见 src/lib/member-wallet.ts 的 recalcBalance）。
   *   · member_wallet.member_id：会员主键（guests.id）。账户行 = member_id 非空的行；
   *     member_id 为空的行是历史遗留的「单笔充值行」（rooms/actions.ts 的用户会员充值
   *     懒建旧表留下的形状），保留不删，以免打断仍在写旧表的入口。
   */
  if (!hasTable("member_wallet_ledger")) {
    if (checkOnly) {
      applied.push("member_wallet_ledger 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE member_wallet_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          biz_type TEXT NOT NULL,
          amount REAL NOT NULL,
          balance_after REAL NOT NULL,
          ref_type TEXT,
          ref_id INTEGER,
          request_id TEXT,
          operator TEXT,
          remark TEXT,
          created_at TEXT
        );
      `);
      applied.push("member_wallet_ledger 表");
      changed += 1;
    }
  } else {
    skipped.push("member_wallet_ledger 表");
  }
  addIndex(
    "idx_wallet_ledger_member",
    `CREATE INDEX idx_wallet_ledger_member ON member_wallet_ledger(hotel_id, member_id)`
  );
  // 幂等键：同一酒店内 request_id 唯一（为空的历史行不受约束）
  addIndex(
    "idx_wallet_ledger_request",
    `CREATE UNIQUE INDEX idx_wallet_ledger_request ON member_wallet_ledger(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );

  /* 账户表：旧库里 member_wallet 是 rooms/actions.ts 懒建的
   * （hotel_id / guest_name / amount / type / note / created_at），没有 member_id 与 balance。
   * 这里只「补列」不删列、不改名——旧写入路径 INSERT 的列必须继续存在，否则前台会员充值会直接报错。
   * 余额缓存列加默认 0，避免旧行出现 NULL 参与求和。 */
  if (!hasTable("member_wallet")) {
    if (checkOnly) {
      applied.push("member_wallet 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE member_wallet (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          member_id INTEGER,
          guest_name TEXT,
          balance REAL DEFAULT 0,
          amount REAL DEFAULT 0,
          type TEXT DEFAULT 'RECHARGE',
          note TEXT,
          updated_at TEXT,
          created_at TEXT
        );
      `);
      applied.push("member_wallet 表");
      changed += 1;
    }
  } else {
    skipped.push("member_wallet 表");
  }
  addColumn("member_wallet", "member_id", "INTEGER");
  addColumn("member_wallet", "balance", "REAL DEFAULT 0");
  addColumn("member_wallet", "updated_at", "TEXT");
  // 一个会员在 member_wallet 里最多一条账户行（member_id 为空的历史单笔行不受约束）
  addIndex(
    "idx_wallet_account_member",
    `CREATE UNIQUE INDEX idx_wallet_account_member ON member_wallet(hotel_id, member_id) WHERE member_id IS NOT NULL`
  );

  /* ---------- 8b. 数据迁移：两张旧表 → member_wallet_ledger ----------
   * 幂等口径（两道保险）：
   *   1. request_id 用旧表主键确定性生成（migrate:mwt:<id> / migrate:mw:<id>），
   *      配合上面的唯一索引，重复执行必然冲突；
   *   2. 再套一层 WHERE NOT EXISTS，让 --check 也能在不写库的前提下统计「还差几条」。
   *
   * 金额符号：新表「正入负出」。旧表 amount 全部是正数，按类型定符号：
   *   RECHARGE → +amount      CONSUME → -amount
   *   REFUND   → 记成 ADJUST 且保留正数
   *     （旧口径的「退款」是「退回储值账户 = 入账」，与新的 refundWallet「退款给客人 = 出账」
   *       语义相反；直接标 REFUND 会让新表的退款校验口径被历史数据污染，
   *       所以历史行改记 ADJUST 调整，余额求和结果与旧系统完全一致。）
   */
  if (hasTable("member_wallet_ledger") && hasTable("member_wallet_transactions")) {
    const MWT_REQ = `'migrate:mwt:' || t.id`;
    const pendingMwt =
      all(
        `SELECT COUNT(*) AS c
           FROM member_wallet_transactions t
          WHERE NOT EXISTS (
                  SELECT 1 FROM member_wallet_ledger l
                   WHERE l.hotel_id = t.hotel_id AND l.request_id = ${MWT_REQ}
                )`
      )[0]?.c ?? 0;

    if (pendingMwt > 0) {
      if (checkOnly) {
        applied.push(`${pendingMwt} 条旧储值流水待搬入 member_wallet_ledger`);
      } else {
        db.exec("BEGIN");
        try {
          db.prepare(
            `INSERT INTO member_wallet_ledger
               (hotel_id, member_id, biz_type, amount, balance_after,
                ref_type, ref_id, request_id, operator, remark, created_at)
             SELECT t.hotel_id,
                    t.guest_id,
                    CASE t.type
                      WHEN 'CONSUME' THEN 'CONSUME'
                      WHEN 'REFUND'  THEN 'ADJUST'
                      ELSE 'RECHARGE'
                    END,
                    CASE t.type WHEN 'CONSUME' THEN -ROUND(t.amount, 2) ELSE ROUND(t.amount, 2) END,
                    0,
                    'member_wallet_transactions',
                    t.id,
                    ${MWT_REQ},
                    t.operator,
                    '历史迁移：' || COALESCE(t.note, ''),
                    COALESCE(t.created_at, datetime('now'))
               FROM member_wallet_transactions t
              WHERE NOT EXISTS (
                      SELECT 1 FROM member_wallet_ledger l
                       WHERE l.hotel_id = t.hotel_id AND l.request_id = ${MWT_REQ}
                    )`
          ).run();
          db.exec("COMMIT");
          applied.push(`搬入 ${pendingMwt} 条旧储值流水 → member_wallet_ledger`);
          changed += 1;
        } catch (e) {
          db.exec("ROLLBACK");
          notes.push(`旧储值流水迁移失败：${e.message}`);
        }
      }
    } else {
      skipped.push("member_wallet_transactions → member_wallet_ledger");
    }
  } else if (checkOnly && hasTable("member_wallet_transactions")) {
    /* ledger 表本次才建（checkOnly 不落库），无法用 NOT EXISTS 比对；
     * 这里直接数旧表行数，让 --check 也能提前报出「还有多少条要搬」。 */
    const rows = all(`SELECT COUNT(*) AS c FROM member_wallet_transactions`)[0]?.c ?? 0;
    if (rows > 0) applied.push(`${rows} 条旧储值流水待搬入 member_wallet_ledger（表待建）`);
  }

  /* 8c. 旧 member_wallet 单笔充值行 → ledger
   * 旧行只有 guest_name、没有 guest_id，按 (hotel_id, 姓名) 反查 guests 拿会员主键；
   * 同名客人取最早一条（MIN(id)），避免重名把一笔充值拆成多条。
   * 匹配不到客史的旧行无法落到会员维度，保留在原表但不再参与余额（notes 里报数量）。 */
  if (hasTable("member_wallet_ledger") && hasTable("member_wallet") && hasTable("guests")) {
    const MW_REQ = `'migrate:mw:' || w.id`;
    const pendingMw =
      all(
        `SELECT COUNT(*) AS c
           FROM member_wallet w
           JOIN (SELECT hotel_id, name, MIN(id) AS gid FROM guests GROUP BY hotel_id, name) gg
             ON gg.hotel_id = w.hotel_id AND gg.name = w.guest_name
          WHERE w.member_id IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM member_wallet_ledger l
                   WHERE l.hotel_id = w.hotel_id AND l.request_id = ${MW_REQ}
                )`
      )[0]?.c ?? 0;

    if (pendingMw > 0) {
      if (checkOnly) {
        applied.push(`${pendingMw} 条旧会员充值行待搬入 member_wallet_ledger`);
      } else {
        db.exec("BEGIN");
        try {
          db.prepare(
            `INSERT INTO member_wallet_ledger
               (hotel_id, member_id, biz_type, amount, balance_after,
                ref_type, ref_id, request_id, operator, remark, created_at)
             SELECT w.hotel_id,
                    gg.gid,
                    CASE w.type
                      WHEN 'CONSUME' THEN 'CONSUME'
                      WHEN 'REFUND'  THEN 'ADJUST'
                      ELSE 'RECHARGE'
                    END,
                    CASE w.type WHEN 'CONSUME' THEN -ROUND(COALESCE(w.amount, 0), 2)
                                ELSE ROUND(COALESCE(w.amount, 0), 2) END,
                    0,
                    'member_wallet',
                    w.id,
                    ${MW_REQ},
                    NULL,
                    '历史迁移：' || COALESCE(w.note, ''),
                    COALESCE(w.created_at, datetime('now'))
               FROM member_wallet w
               JOIN (SELECT hotel_id, name, MIN(id) AS gid FROM guests GROUP BY hotel_id, name) gg
                 ON gg.hotel_id = w.hotel_id AND gg.name = w.guest_name
              WHERE w.member_id IS NULL
                AND NOT EXISTS (
                      SELECT 1 FROM member_wallet_ledger l
                       WHERE l.hotel_id = w.hotel_id AND l.request_id = ${MW_REQ}
                    )`
          ).run();
          db.exec("COMMIT");
          applied.push(`搬入 ${pendingMw} 条旧会员充值行 → member_wallet_ledger`);
          changed += 1;
        } catch (e) {
          db.exec("ROLLBACK");
          notes.push(`旧会员充值行迁移失败：${e.message}`);
        }
      }
    } else {
      skipped.push("member_wallet 旧单笔行 → member_wallet_ledger");
    }

    // 旧行里匹配不到客史的（重命名 / 手填错名）：只提示，不猜、不删
    const orphan = all(
      `SELECT COUNT(*) AS c FROM member_wallet w
        WHERE w.member_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM guests g WHERE g.hotel_id = w.hotel_id AND g.name = w.guest_name)`
    )[0]?.c ?? 0;
    if (orphan > 0) notes.push(`${orphan} 条旧会员充值行找不到同名客史，未迁入（原表保留，可人工核对后补 member_id）`);
  } else if (checkOnly && hasTable("member_wallet")) {
    const rows = all(`SELECT COUNT(*) AS c FROM member_wallet WHERE member_id IS NULL`)[0]?.c ?? 0;
    if (rows > 0) applied.push(`${rows} 条旧会员充值行待搬入 member_wallet_ledger（表待建）`);
  }

  /* 8d. 历史流水的 balance_after 快照回填（只补迁移进来的行，按 id 顺序累加）
   * 新表写入时自带快照，这里只处理 request_id 以 migrate: 开头的历史行；
   * 反复执行结果恒等，因此不计入 applied/changed。 */
  if (!checkOnly && hasTable("member_wallet_ledger")) {
    db.exec(`
      UPDATE member_wallet_ledger
         SET balance_after = (
               SELECT COALESCE(SUM(x.amount), 0)
                 FROM member_wallet_ledger x
                WHERE x.hotel_id = member_wallet_ledger.hotel_id
                  AND x.member_id = member_wallet_ledger.member_id
                  AND x.id <= member_wallet_ledger.id
             )
       WHERE request_id LIKE 'migrate:%'
    `);
  }

  /* 8e. 按流水重建余额缓存（唯一口径）
   * 为每个有流水的会员补一条账户行，再把 balance 全量重算一遍。
   * 这一步是幂等的「纠偏」，不算迁移变更项：--check 不报，执行时也永远跑一次，
   * 这样历史数据怎么歪，跑完 migrate 余额都与流水一致。 */
  if (!checkOnly && hasTable("member_wallet_ledger") && hasTable("member_wallet")) {
    const nowText = new Date().toISOString();
    db.prepare(
      `INSERT INTO member_wallet (hotel_id, member_id, guest_name, balance, amount, type, note, created_at, updated_at)
       SELECT l.hotel_id,
              l.member_id,
              COALESCE(g.name, '会员' || l.member_id),
              ROUND(COALESCE(SUM(l.amount), 0), 2),
              0,
              'ACCOUNT',
              '储值账户（余额由 member_wallet_ledger 推导）',
              ?,
              ?
         FROM member_wallet_ledger l
         LEFT JOIN guests g ON g.id = l.member_id AND g.hotel_id = l.hotel_id
        WHERE l.member_id IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM member_wallet w
                 WHERE w.hotel_id = l.hotel_id AND w.member_id = l.member_id
              )
        GROUP BY l.hotel_id, l.member_id`
    ).run(nowText, nowText);

    db.prepare(
      `UPDATE member_wallet
          SET balance = (
                SELECT COALESCE(SUM(x.amount), 0)
                  FROM member_wallet_ledger x
                 WHERE x.hotel_id = member_wallet.hotel_id
                   AND x.member_id = member_wallet.member_id
              ),
              updated_at = ?
        WHERE member_id IS NOT NULL`
    ).run(nowText);
  }

  /* ---------- 9. AR 应收台账（整改 P1-5：协议挂账未结转 AR） ----------
   * 现状：chargeToCompanyAction 只在 stays.remark 上盖一个「【挂账】公司名」的标记，
   *   信用额度靠 LIKE 匹配备注算已挂账金额 —— 备注被改就失准，账压根没进 AR 台账，
   *   财务看不到应收。
   *
   * 与既有 ar_accounts / ar_transactions 的关系（不重复造轮子，也不硬合并）：
   *   ar_accounts     账户维度总账（一个 AR 账户一个余额），主键 ar_account_id，
   *                   由 src/app/(main)/ar/actions.ts 懒建并灌种子，报表 / 核销都按它算。
   *   ar_ledgers      「笔级」台账：一次挂账一行，主键是 company_id（协议单位），
   *                   带 folio 关联、账期到期日、已核销金额与状态，用来回答
   *                   「某家公司现在还欠多少、欠了多久、哪一笔结了」。
   *   两者是总账 vs 明细的关系，company 与 ar_account 也没有现成外键，
   *   强行合并会动到既有 5 个种子账户与 55 条流水的口径，风险大于收益。
   *   故新建 ar_ledgers，并在 /ar 页面并排展示。
   */
  if (!hasTable("ar_ledgers")) {
    if (checkOnly) {
      applied.push("ar_ledgers 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ar_ledgers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          company_id INTEGER NOT NULL,
          folio_id INTEGER,
          folio_no TEXT,
          biz_date TEXT NOT NULL,
          amount REAL NOT NULL,
          settled_amount REAL DEFAULT 0,
          due_date TEXT,
          status TEXT DEFAULT 'OPEN',
          kind TEXT DEFAULT 'CHARGE',
          operator TEXT,
          remark TEXT,
          created_at TEXT
        );
      `);
      applied.push("ar_ledgers 表");
      changed += 1;
    }
  } else {
    skipped.push("ar_ledgers 表");
  }
  addIndex(
    "idx_ar_ledgers_company",
    `CREATE INDEX idx_ar_ledgers_company ON ar_ledgers(hotel_id, company_id, status)`
  );
  addIndex("idx_ar_ledgers_bizdate", `CREATE INDEX idx_ar_ledgers_bizdate ON ar_ledgers(hotel_id, biz_date)`);
  /*
   * 第九轮 P1-3：账户总账与协议单位台账必须同步
   *
   * 原来「挂账」双写（ar_ledgers + ar_accounts/ar_transactions），
   * 但「收款 / 转账 / 坏账核销」只动账户总账，ar_ledgers 不跟：
   * 核销后协议单位台账仍显示未结，财务和客户对账必然对不上。
   *
   * kind 用来区分台账行的来源：
   *   CHARGE       正常挂账 / 账户入账（增加应收）
   *   TRANSFER_IN  从其他 AR 账户调账转入（增加本单位应收）
   *   TRANSFER_OUT 调账转出的审计行（amount = settled_amount，净额 0，只留痕）
   * 老库补列时默认 CHARGE —— 历史上 ar_ledgers 只有「挂账」一种来源，可判定。
   */
  addColumn("ar_ledgers", "kind", "TEXT DEFAULT 'CHARGE'");
  /*
   * 核销记录挂到被冲减的台账行：一次核销可能跨多条未结台账（FIFO 分摊），
   * 因此 ar_write_offs 按分摊行各记一条，ar_ledger_id 指向具体台账。
   *
   * 注意：ar_write_offs 和 ar_accounts / ar_transactions 一样属于「页面首次访问时懒建」的表
   * （由 ar/actions.ts ensureArSchema 与 lib/ar.ts ensureArAccountSchema 兜底建），
   * 全新部署的库在这里还没有它。所以只补列、不在迁移里建索引 ——
   * 索引由运行时兜底建（CREATE INDEX IF NOT EXISTS），
   * 否则 `db:migrate:check` 在全新库上会永远挂一条「待建：表尚未创建」，把目标状态检查搞脏。
   */
  addColumn("ar_write_offs", "ar_ledger_id", "INTEGER");


  /* ---------- 10. 发票台账（整改清单 P2-3：发票建台账 + 开票校验 + 红冲） ----------
   * 现状：收银台「开发票」只在 op_logs 写一段文本，没有台账表 —— 开票记录不可查、
   *   不能红冲、也无法校验「账单已结账 / 不超应收」。op_logs 是字符串日志，
   *   既算不出某账单已开票合计（超额开票拦不住），也无法用外键关联账单 / 入住单。
   *
   * 设计要点：
   *   invoice_type  NORMAL 正常 / RED 红冲 / VOID 作废
   *   amount        有符号：正常票为正，红冲票为负数。某账单「已开票净额」= SUM(amount)，
   *                 因此红冲自动把额度还回去（红冲 = 撤销），分次开票也不会重复占用额度。
   *   red_of        红冲指向的原发票 id；原发票 status 由 ISSUED 改为 RED。
   *   invoice_no    NOT NULL，但允许空串占位（用户不填时由 service 自动生成）；
   *                 唯一索引带 WHERE invoice_no <> ''，避免空串互相冲突。
   *   索引          (hotel_id, folio_id) 支撑「该账单已开票多少」的额度校验，
   *                 (hotel_id, biz_date) 支撑营业日区间筛选，
   *                 (hotel_id, invoice_no) 保证同酒店发票号唯一。
   */
  if (!hasTable("invoices")) {
    if (checkOnly) {
      applied.push("invoices 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          invoice_no TEXT NOT NULL,
          invoice_type TEXT DEFAULT 'NORMAL',
          title TEXT NOT NULL,
          tax_no TEXT,
          amount REAL NOT NULL,
          folio_id INTEGER,
          folio_no TEXT,
          stay_id INTEGER,
          guest_name TEXT,
          room_no TEXT,
          biz_date TEXT NOT NULL,
          operator TEXT,
          remark TEXT,
          red_of INTEGER,
          status TEXT DEFAULT 'ISSUED',
          created_at TEXT
        );
      `);
      applied.push("invoices 表");
      changed += 1;
    }
  } else {
    skipped.push("invoices 表");
  }
  addIndex("idx_invoices_folio", `CREATE INDEX idx_invoices_folio ON invoices(hotel_id, folio_id)`);
  addIndex("idx_invoices_bizdate", `CREATE INDEX idx_invoices_bizdate ON invoices(hotel_id, biz_date)`);
  addIndex(
    "idx_invoices_no",
    `CREATE UNIQUE INDEX idx_invoices_no ON invoices(hotel_id, invoice_no) WHERE invoice_no <> ''`
  );
  /*
   * 红冲幂等约束（第七轮整改清单一.3）
   *
   * 同一酒店、同一张原票只允许一张红冲票。应用层（src/lib/invoice.ts）已经查过
   * 「是否已存在 red_of = 原票」，但并发两请求能同时通过那条 SELECT，各自插入负数票 ——
   * 数据库唯一约束是唯一能挡住这个窗口的东西，清单要求必须保留。
   *
   * DDL 与三处必须完全一致（否则「新库/旧库/兜底」三个形态会分叉）：
   *   · scripts/schema-full.sql（新库安装）
   *   · src/lib/invoice.ts ensureInvoiceSchema()（克隆仓库直接 dev 的兜底）
   * 正常票 red_of 为 NULL，WHERE 让索引只覆盖红冲票（NULL 在唯一索引里本来也不冲突）。
   * addIndex() 已按索引名判重，可重复执行。
   */
  addIndex(
    "idx_invoices_red_of",
    `CREATE UNIQUE INDEX idx_invoices_red_of ON invoices(hotel_id, red_of) WHERE red_of IS NOT NULL`
  );

  /* ---------- 11. 会话过期清理索引（整改 P2-4） ----------
   * sessions 表只增不删：每次登录插一行，过期后除了「过期 sid 再次访问」时
   * getSession 顺手删掉那一条，其余全部留在表里。现在登录成功与夜审都会调用
   * cleanupExpiredSessions() 批量执行 `DELETE FROM sessions WHERE expires_at < ?`，
   * 没有索引就是全表扫描 —— 表越大清理越慢，反过来又让清理更难做。
   * 这里按 expires_at 建普通索引，把清理变成一次范围扫描。
   *
   * 表不存在（非本项目的库）时只跳过、不抛错，保持脚本「可重复执行」的约定。
   */
  if (!hasTable("sessions")) {
    skipped.push("sessions（表不存在）");
  } else {
    addIndex("idx_sessions_expires", `CREATE INDEX idx_sessions_expires ON sessions(expires_at)`);
  }

  /* ---------- 12. 微信小程序 / 会员端（整改清单 F12） ----------
   * 两张表都是新功能，老库升级与全新库必须得到同一个形态，所以建表收敛在这里
   * （init-db 收尾会调 runMigrations，全新库也会带上）。
   *
   * mini_program_config：单店一套小程序配置。
   *   为什么要单表而不是塞 settings：AppSecret 是凭据，需要「AppID + AppSecret 都填了」
   *   这种结构化状态判断；只填 AppID 就显示「已配置」会误导管理员去排查小程序代码。
   *   UNIQUE(hotel_id) 保证一家店只有一套，避免同一酒店两条配置互相覆盖。
   *
   * mini_program_users：openid ↔ 酒店客人档案（guests）绑定。
   *   session_token 是服务端签发的登录态（7 天），小程序用 Authorization: Bearer 携带；
   *   客户端不保存任何身份信息，身份一律以本表为准（与 PC 端 sessions 表同一安全口径）。
   *   guest_id 允许为空：客人可以先登录、下单，之后再绑定手机号补建客史。
   */
  if (!hasTable("mini_program_config")) {
    if (checkOnly) {
      applied.push("mini_program_config 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE mini_program_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          app_id TEXT,
          app_secret TEXT,
          mch_id TEXT,
          mch_key TEXT,
          enabled INTEGER DEFAULT 0,
          updated_at TEXT,
          UNIQUE(hotel_id)
        );
      `);
      applied.push("mini_program_config 表");
      changed += 1;
    }
  } else {
    skipped.push("mini_program_config 表");
  }

  if (!hasTable("mini_program_users")) {
    if (checkOnly) {
      applied.push("mini_program_users 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE mini_program_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          openid TEXT NOT NULL,
          unionid TEXT,
          guest_id INTEGER,
          mobile TEXT,
          session_token TEXT,
          token_expires_at TEXT,
          bind_attempts INTEGER DEFAULT 0,
          bind_locked_until TEXT,
          created_at TEXT,
          updated_at TEXT
        );
      `);
      applied.push("mini_program_users 表");
      changed += 1;
    }
  } else {
    skipped.push("mini_program_users 表");
  }
  // 同一家店同一 openid 只能有一行：防止并发登录时插出两条、token 互相覆盖
  addIndex(
    "idx_mini_users_openid",
    `CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid)`
  );
  // 每次带 token 的请求都按 session_token 反查身份，没有索引就是全表扫描
  addIndex("idx_mini_users_token", `CREATE INDEX idx_mini_users_token ON mini_program_users(session_token)`);

  /* ---------- 12.1 整改 P0-11：绑定校验失败计数 / 锁定截止 ----------
   * 绑定会员改成「手机号 + 入住单号/房号」双因素（见 src/app/api/mini/bind/route.ts）。
   * 预订号是连续编号（BK3001 起），不加次数限制就能被枚举；计数落库而不是放内存，
   * 保证进程重启后「已经试错 4 次」仍然生效。
   */
  addColumn("mini_program_users", "bind_attempts", "INTEGER DEFAULT 0");
  addColumn("mini_program_users", "bind_locked_until", "TEXT");

  /* ---------- 12.2 整改 P2-17：小程序用户 ↔ 订单关联 ----------
   * 「未绑定手机号的用户看不到自己下的单」的根因是旧实现用用户自填的
   * mini_program_users.mobile 反查订单 —— 手机号可伪造，等于用可伪造字段做授权
   * （与 P0-12 同类）。改成下单时在服务端事务里记一行关联，
   * 未绑定用户也能看到「自己这个微信下过的单」，且客户端无法伪造。
   * UNIQUE(hotel_id, booking_id)：一张单最多关联一个微信用户（重试/重复提交幂等）。
   */
  if (!hasTable("mini_program_bookings")) {
    if (checkOnly) {
      applied.push("mini_program_bookings 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE mini_program_bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          mini_user_id INTEGER NOT NULL,
          booking_id INTEGER NOT NULL,
          created_at TEXT,
          UNIQUE(hotel_id, booking_id)
        );
      `);
      applied.push("mini_program_bookings 表");
      changed += 1;
    }
  } else {
    skipped.push("mini_program_bookings 表");
  }
  addIndex(
    "idx_mini_bookings_user",
    `CREATE INDEX idx_mini_bookings_user ON mini_program_bookings(hotel_id, mini_user_id)`
  );

  /* ---------- 12.3 房型详情展示字段（第九轮《微信小程序专项》第二节 / 第 81 行） ----------
   *
   * 缺陷：room_types 只有 code / name / bed_type / area / max_occupancy / base_price / sort。
   * 小程序房型详情页需要「图片 / 设施 / 早餐说明 / 取消政策 / 入离时间 / 押金说明」，
   * 数据库里一个都没有 —— 前端只能写死假图假设施（虚假宣传），或者什么都不显示。
   *
   * 整改清单第 81 行的原话是「如果数据库没有图片和设施字段，增加明确的数据表或配置
   * 字段，不要在页面写死虚假信息」，所以这里补列（而不是让页面编）：
   *   images              图片 URL 的 JSON 数组，如 ["https://cdn/x/1.jpg"]
   *   facilities          设施的 JSON 数组，如 ["免费WiFi","独立卫浴"]
   *   breakfast_note      早餐说明（「含双早（自助）」/「不含早餐」）
   *   cancellation_policy 取消政策（「入住前 1 天 18:00 前可免费取消」）
   *   check_in_time       该房型可入住时间 HH:MM（空 = 用 settings.check_in_time）
   *   check_out_time      该房型离店时间 HH:MM（空 = 用 settings.check_out_time）
   *   deposit_note        押金说明（空 = 用 settings.hotel_deposit_note）
   *
   * 全部可空、无默认值：**NULL 就是「酒店还没配」**，接口据此返回 null 并标注未配置，
   * 不给空串默认值（空串和「未配置」在展示层分不开，会让人误以为「配了但为空」）。
   *
   * 回滚说明（清单第六节「备份和回滚脚本」）：本段与 12.4 都是**只增不改**——
   * 加列 / 加表不动任何既有数据与既有列，旧代码读不到新列也照常运行。
   * 因此回滚只需要「升级前备份的 data/pms.db 覆盖回去」（scripts/build-release.mjs
   * 生成的部署说明第 5 节就是这套流程），不需要单独的 down 迁移脚本。
   */
  addColumn("room_types", "images", "TEXT");
  addColumn("room_types", "facilities", "TEXT");
  addColumn("room_types", "breakfast_note", "TEXT");
  addColumn("room_types", "cancellation_policy", "TEXT");
  addColumn("room_types", "check_in_time", "TEXT");
  addColumn("room_types", "check_out_time", "TEXT");
  addColumn("room_types", "deposit_note", "TEXT");

  /* ---------- 12.4 小程序站内通知 mini_notifications（第九轮 第三节 / 第 302 行） ----------
   *
   * 清单第 302 行：「通知必须只发给对应 mini_user_id，不能按手机号群发」。
   *
   * 为什么必须是新表而不是复用 notices / sms_logs：
   *   · notices 是酒店对内的公告（全店可见），没有收件人维度；
   *   · sms_logs 按手机号记，正是清单禁止的「按手机号群发」的载体 ——
   *     手机号在绑定流程里是用户自填的、可被冒用的字段（P0-12），不能当收件人主键。
   *
   * 收件人唯一键是 mini_user_id（mini_program_users.id，由服务端 token 解析）：
   * 这张表**刻意不存 mobile / guest_id** —— 一旦存了手机号，将来一定有人写出
   * 「按手机号发通知」的群发 SQL，而这里连列都没有，写不出来。
   *
   * read_at 用时间戳而不是 0/1：客人问「我什么时候看的」能答，
   * 也便于将来做「未读超过 N 天清理」。NULL = 未读。
   */
  if (!hasTable("mini_notifications")) {
    if (checkOnly) {
      applied.push("mini_notifications 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE mini_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          mini_user_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          read_at TEXT,
          created_at TEXT,
          ref_type TEXT,
          ref_id INTEGER
        );
      `);
      applied.push("mini_notifications 表");
      changed += 1;
    }
  } else {
    skipped.push("mini_notifications 表");
  }
  /*
   * 列表固定按 (hotel_id, mini_user_id, read_at) 过滤（未读角标 = read_at IS NULL），
   * 缺索引时每刷一次消息页就全表扫一遍，通知一多就是明显的慢查询。
   */
  addIndex(
    "idx_mini_notifications_user",
    `CREATE INDEX idx_mini_notifications_user ON mini_notifications(hotel_id, mini_user_id, read_at)`
  );

  /* ---------- 12.3 小程序服务请求 mini_service_requests（第九轮清单第六节） ----------
   *
   * 小程序「在住服务」产生的全部申请都落这一张表，前台按 status 处理：
   *   客房清洁 / 送物 / 维修 / 延迟退房 / 换房 / 唤早 / 续住申请。
   *
   * 为什么要单独一张表而不是塞 housekeeping / cancel_requests：
   *   · 那些表是 PC 端各业务的内部单据（housekeeping 是打扫任务、cancel_requests 是退房审批），
   *     语义不同、字段不同，混进去会让 PC 端列表出现「不是自己要处理的东西」；
   *   · 小程序侧需要一条「客人自己提过什么」的完整台账，且必须只能按 mini_user_id 取数
   *     （整改要求：不返回其他客人的数据）。独立表天然做到这一点。
   *
   * 字段（与清单第 396-411 行逐列一致）：
   *   hotel_id / mini_user_id / guest_id / stay_id / booking_id —— 全部由服务端推导或校验后写入，
   *   客户端传来的 id 一律先按「属于当前 mini_user」验过才落库（不信任客户端 id）。
   *   request_id —— 客户端幂等键；唯一索引 (hotel_id, request_id) 部分唯一（WHERE request_id IS NOT NULL），
   *   保证「同一个 request_id 重复提交只建一条」。历史行 request_id 为 NULL，不进索引。
   *   operator / completed_at —— PC 端处理人与处理时间，小程序侧留空。
   *
   * ⚠️ 这条 DDL 必须与 scripts/schema-full.sql、scripts/init-db.mjs 以及运行时
   *    src/app/api/mini/_shared.ts 的 ensureMiniServiceSchema() 逐列一致。
   */
  if (!hasTable("mini_service_requests")) {
    if (checkOnly) {
      applied.push("mini_service_requests 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE mini_service_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          mini_user_id INTEGER NOT NULL,
          guest_id INTEGER,
          stay_id INTEGER,
          booking_id INTEGER,
          service_type TEXT NOT NULL,
          status TEXT DEFAULT 'PENDING',
          request_id TEXT,
          note TEXT,
          operator TEXT,
          created_at TEXT,
          updated_at TEXT,
          completed_at TEXT
        );
      `);
      applied.push("mini_service_requests 表");
      changed += 1;
    }
  } else {
    skipped.push("mini_service_requests 表");
  }
  // request_id 幂等：同一家店同一 request_id 只能落一行（部分唯一，NULL 不进索引）
  addIndex(
    "idx_mini_service_requests_req",
    `CREATE UNIQUE INDEX idx_mini_service_requests_req ON mini_service_requests(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );
  // 「我的服务请求」按 (hotel_id, mini_user_id) 取数，没有索引就是全表扫描
  addIndex(
    "idx_mini_service_requests_user",
    `CREATE INDEX idx_mini_service_requests_user ON mini_service_requests(hotel_id, mini_user_id, id)`
  );
  // 前台按入住单 / 房间查这家客人提过什么
  addIndex(
    "idx_mini_service_requests_stay",
    `CREATE INDEX idx_mini_service_requests_stay ON mini_service_requests(hotel_id, stay_id)`
  );
  // 前台处理队列按状态取
  addIndex(
    "idx_mini_service_requests_status",
    `CREATE INDEX idx_mini_service_requests_status ON mini_service_requests(hotel_id, status, id)`
  );

  /* ---------- 12.5 小程序下单幂等键 bookings.mini_request_id（第九轮清单第 109 行） ----------
   *
   * 缺陷（第九轮专项测试实测）：`POST /api/mini/bookings` 全文没有任何 request_id 校验。
   * 同一个 requestId 顺序提交两次 → 建出两张单（BK3003 / BK3004）；并发两次 → 同样两张。
   * 现实后果是客人网络超时后重点一次就多一张重复单 —— 前台重复排房 / 重复锁房，
   * 接入在线支付后还可能重复收款。清单第 109 行明确要求「request_id 幂等」
   * 「网络超时重试不重复建单」。
   *
   * 为什么是「订单表加一列」而不是新建一张 request_id 映射表：
   *   · 幂等键必须是**订单的不可分割属性**：同一事务写入，不会出现「单建了、键没写」，
   *     也就不会因为键缺失而在重试时重复建单（映射表要多一次写入 + 一张表的一致性维护）；
   *   · 唯一约束落在订单表上，SQLite 单表写入即可保证「一家店一个键最多一张单」；
   *   · 查重就是一次带索引的等值查询，不额外增加读路径。
   *
   * 为什么用**部分**唯一索引（WHERE mini_request_id IS NOT NULL）：
   *   历史订单 / 前台 / 渠道建的单没有幂等键，全是 NULL。SQLite 里 NULL 互不相等，
   *   但显式排除掉更清楚，索引也更小更快；将来若有人把 NULL 当作「空串」写入，
   *   也不会因为一批空串互相冲突而在迁移阶段炸掉。
   *
   * ⚠️ 本段必须与 scripts/schema-full.sql（建表 + 索引）、scripts/init-db.mjs（建表）、
   *    运行时 src/app/api/mini/bookings/route.ts 的 ensureBookingRequestSchema()
   *    以及 scripts/schema-fingerprint.json 一致（5 处同步，清单第六节第 387-394 行）。
   *
   * 回滚：只增列 + 只增索引，不动任何既有列与数据；回滚方式仍是「还原升级前备份的库」。
   */
  addColumn("bookings", "mini_request_id", "TEXT");
  addIndex(
    "idx_bookings_mini_request",
    `CREATE UNIQUE INDEX idx_bookings_mini_request ON bookings(hotel_id, mini_request_id) WHERE mini_request_id IS NOT NULL`
  );

  /* ---------- 13. 幂等键：账务明细 + 商品库存流水（整改 7.1） ----------
   * 资金 / 库存类写操作必须能挡住「网络重试、连点两次、客户端重发」造成的重复入账：
   * 客户端带一个 request_id，唯一索引保证同一家店同一 request_id 只能落一行。
   *
   * 为什么是「部分索引」：
   *   历史行没有 request_id（NULL）。部分索引只约束「带键的新数据」，
   *   老数据不进索引、也不会因为 NULL 之间「相等/不等」的语义差异产生意外冲突，
   *   索引本身也更小。
   *
   * 本段只加列和索引，不改任何业务写入逻辑 —— 各写入点接入 request_id 由业务侧推进。
   */
  addColumn("folio_items", "request_id", "TEXT");
  addIndex(
    "idx_folio_items_request",
    `CREATE UNIQUE INDEX idx_folio_items_request ON folio_items(hotel_id, request_id) WHERE request_id IS NOT NULL`
  );

  /*
   * 商品库存流水：整改指令写的是 shop_stock_logs，但 PRAGMA 查过本库没有这张表 ——
   * 商品销售 / 扣库存流水实际记在 shop_sales（写入点 src/app/(main)/shop/actions.ts）。
   * 两边的口径都按同一规则补齐：
   *   - shop_stock_logs 若存在（将来建表、或别的分店库）就补；
   *   - shop_sales 在本库一定存在，必须补。
   * 表都不存在时只留一条说明，不抛错，保持脚本「任何库都能重复执行」的约定。
   */
  if (hasTable("shop_stock_logs")) {
    addColumn("shop_stock_logs", "request_id", "TEXT");
    addIndex(
      "idx_shop_stock_logs_request",
      `CREATE UNIQUE INDEX idx_shop_stock_logs_request ON shop_stock_logs(hotel_id, request_id) WHERE request_id IS NOT NULL`
    );
  } else {
    notes.push("shop_stock_logs 表不存在（本库库存流水记为 shop_sales），跳过该表");
  }
  if (hasTable("shop_sales")) {
    addColumn("shop_sales", "request_id", "TEXT");
    addIndex(
      "idx_shop_sales_request",
      `CREATE UNIQUE INDEX idx_shop_sales_request ON shop_sales(hotel_id, request_id) WHERE request_id IS NOT NULL`
    );
  }

  /* ---------- 13.1 商超库存流水 shop_stock_flows（第九轮清单 二.7） ----------
   *
   * 这张表原来只在 src/app/(main)/shop/actions.ts 的 ensureShopStockFlowTable
   * 里「运行时懒建」：老库上访问过一次商超页面就有了，但全新部署跑完
   * init-db + migrate-all + ensure-schema 仍然缺表 —— 商超库存流水的查询、
   * 撤销回库、盘点对账都要等「先点一次页面」才成立，交付部署不可接受。
   *
   * 现在三条路径都建同一张表、同一套索引：
   *   1. 新库：scripts/init-db.mjs 直接建（建完由本函数收尾）；
   *   2. 旧库：本段补齐（幂等，已有表/索引就跳过）；
   *   3. 运行时：ensureShopStockFlowTable 仍是兜底（IF NOT EXISTS，不覆盖不删除）。
   *
   * ⚠️ 列定义必须与 ensureShopStockFlowTable 的 CREATE TABLE 逐列一致
   *    （scripts/test-shop-schema-fresh-install.mjs 会解析源码逐列比对，漂移即红）。
   */
  if (!hasTable("shop_stock_flows")) {
    if (checkOnly) {
      applied.push("shop_stock_flows 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shop_stock_flows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          item_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          qty INTEGER NOT NULL,
          stock_after INTEGER NOT NULL,
          unit_price REAL NOT NULL DEFAULT 0,
          amount REAL NOT NULL DEFAULT 0,
          sale_id INTEGER,
          request_id TEXT,
          note TEXT,
          operator TEXT,
          created_at TEXT NOT NULL
        );
      `);
      applied.push("shop_stock_flows 表");
      changed += 1;
    }
  } else {
    skipped.push("shop_stock_flows 表");
  }
  // 查询索引：按「酒店 + 商品 + 类型」查某件商品的出入库流水（与运行时同名同列）
  addIndex(
    "idx_shop_stock_flows_item",
    `CREATE INDEX idx_shop_stock_flows_item ON shop_stock_flows (hotel_id, item_id, type)`
  );
  /*
   * 唯一索引（请求幂等的最后一道闸）：
   * 同一 request_id 下同一个商品只允许一条同类流水 —— 双击 / 网络重试 / 并发提交
   * 最多留下一条 SELL 或一条 VOID，不会把库存扣两次。
   * 用部分索引（WHERE request_id IS NOT NULL）：撤销流水与历史老数据的 request_id 为空，
   * 不参与唯一约束，所以旧库补索引不会因为历史行冲突而失败。
   */
  addIndex(
    "idx_shop_stock_flows_request",
    `CREATE UNIQUE INDEX idx_shop_stock_flows_request
       ON shop_stock_flows(hotel_id, request_id, item_id, type) WHERE request_id IS NOT NULL`
  );

  /* ---------- 14. 密码：password_hash 列 + 明文迁移 + 清空旧列（整改 8.1 / 8.3） ----------
   * 跑完之后的目标形态：
   *   users.password_hash = scrypt$N$r$p$salt$hash  ← 唯一可信的密码来源
   *   users.password      = ''                      ← 旧列保留（老代码 SELECT 不报错），但值全空
   *
   * ⚠️ 为什么清成空串而不是 NULL：本项目 users.password 的建表语句是 `password TEXT NOT NULL`
   * （init-db.mjs；为了兼容还没升级的旧代码），SQLite 不能就地改列约束，设 NULL 会直接
   * `NOT NULL constraint failed` 并把整段迁移回滚。空串同样表示「没有密码」——
   * isHashed / verifyPassword 对空串都返回 false，与 NULL 行为一致；整改 8.3 的判定
   * （password IS NOT NULL AND password <> ''）也认这个形态。
   *
   * 逐行迁移规则（幂等，跑多少次结果一致）：
   *   password_hash 已是 scrypt 串         → 跳过（重复执行不会重算、不会换盐，原密码不变）
   *   password 已是 scrypt 串（历史状态）  → 原样复制到 password_hash（不改盐 → 原密码仍可登录）
   *   password 是明文                      → hashPassword() 后写入 password_hash
   *   两列都空                             → 跳过（该账号无密码，登录会被要求联系管理员重置）
   *
   * 关键：绝不把「已经是哈希」的旧值再 hash 一次 —— 二次 hash 会换掉 salt，
   * 原密码立刻失效（verifyPassword 是逐字节比对），等于全员登不进去。
   * 所以下面 copyHash 分支是原样 `= password`，只有真明文才走 hashPassword。
   *
   * 顺序是硬约束：所有 password_hash 写成功并校验通过之后，才允许清空旧列。
   * 整个过程一个事务，任何一行 hash 失败即 ROLLBACK，
   * 旧列一个字节都不动（避免「清空了明文、哈希却没写成」这种谁都登不进去的状态）。
   */
  if (!hasTable("users")) {
    skipped.push("users（表不存在）");
  } else {
    addColumn("users", "password_hash", "TEXT");

    // checkOnly 且列还不存在时，addColumn 不会真的加列，只能按旧列统计待迁移行数
    const colReady = hasColumn("users", "password_hash");
    const rows = all(`SELECT id, username, password${colReady ? ", password_hash" : ""} FROM users ORDER BY id`);

    const toHash = []; // 旧列是明文 → 需要算 hash
    const toCopy = []; // 旧列已经是 hash → 原样搬（不重算）
    const noPwd = []; // 两列都没有值
    for (const r of rows) {
      const current = typeof r.password_hash === "string" ? r.password_hash : "";
      if (isHashedPassword(current)) continue; // 已迁移：幂等跳过
      const legacy = typeof r.password === "string" ? r.password : "";
      if (!legacy) {
        noPwd.push(r.username);
        continue;
      }
      if (isHashedPassword(legacy)) toCopy.push(r);
      else toHash.push(r);
    }
    const pending = toHash.length + toCopy.length;

    if (checkOnly) {
      if (pending > 0) {
        applied.push(
          `users 密码迁移到 password_hash（${pending} 行待处理：明文 ${toHash.length} / 已有哈希 ${toCopy.length}）`
        );
      } else {
        skipped.push("users 密码数据迁移");
      }
    } else if (pending === 0) {
      skipped.push("users 密码数据迁移");
    } else {
      db.exec("BEGIN");
      try {
        const setHash = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);
        const copyHash = db.prepare(`UPDATE users SET password_hash = password WHERE id = ?`);
        for (const r of toHash) setHash.run(hashPassword(String(r.password)), r.id);
        for (const r of toCopy) copyHash.run(r.id);

        /* 落库后自检：不允许出现「密码迁移成功但哈希列仍是空/脏」的行 */
        const bad = all(
          `SELECT id, username FROM users WHERE password_hash IS NULL OR password_hash NOT LIKE 'scrypt$%'`
        );
        if (bad.length > 0) {
          throw new Error(
            `校验失败：${bad.length} 行的 password_hash 不是 scrypt 哈希（${bad
              .map((r) => `${r.username}#${r.id}`)
              .join(", ")}）`
          );
        }

        /*
         * 到这里才清旧列。用空串而不是 NULL：
         *   users.password 是 `TEXT NOT NULL`（SQLite 不支持改列约束），设 NULL 会整段回滚；
         *   空串在 isHashed / verifyPassword 眼里同样是「没有密码」，语义一致。
         * 条件里带 password <> ''，重复执行时 changes = 0，保持幂等。
         */
        const cleared = db
          .prepare(`UPDATE users SET password = '' WHERE password IS NOT NULL AND password <> ''`)
          .run();
        db.exec("COMMIT");

        applied.push(
          `users 密码迁移到 password_hash（${pending} 行：明文 ${toHash.length} / 已有哈希 ${toCopy.length}）`
        );
        notes.push(`users.password 已清空（${Number(cleared.changes ?? 0)} 行置空串）`);
        changed += 1;
      } catch (e) {
        db.exec("ROLLBACK");
        throw new Error(
          `密码哈希迁移失败，已回滚（users.password 保持原样）：${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    if (noPwd.length > 0) {
      notes.push(
        `${noPwd.length} 个账号没有任何密码（${noPwd.slice(0, 5).join(", ")}${noPwd.length > 5 ? " 等" : ""}），登录会被要求联系管理员重置`
      );
    }
  }

  /* ---------- 14b. 强制改密标记（整改清单 P2-30） ----------
   * 重置密码后要求本人下次登录自行改密，标记必须落库（页面要能显示「待改密」）。
   * DEFAULT 0：老账号一律视为「无需强制改密」，不会因为加列把所有人挡在门外。
   */
  addColumn("users", "must_change_password", "INTEGER DEFAULT 0");

  /* ---------- 15. 渠道同步记录全字段（整改清单 4.2） ----------
   * 背景：一次渠道同步原来只留一句 message（"推送成功" / "拉单失败"），没法回答：
   *   这是哪一次请求？推的是哪一单？什么时候结束的、花了多久？成功几条、失败几条？
   *   有没有落到本系统的预订 / 账单上？
   *
   * 补 8 列：
   *   request_no       本次同步的请求编号（UUID，一次调用一个，同一次调用写的多条日志共用）
   *   channel_order_no 渠道订单号（拉单 / 状态回传时填，便于按单号追一条订单的全过程）
   *   finished_at      结束时间（与 created_at 配对算时间窗，排查时不用猜）
   *   duration_ms      耗时（毫秒，含适配器内部请求与兜底超时）
   *   success_count    成功数量（PUSH_RATES = accepted，PULL_ORDERS = 拉到的订单数）
   *   fail_count       失败数量（PUSH_RATES = rejected.length；整次失败记 1）
   *   booking_id       这次同步落地到的 PMS 预订
   *   folio_id         这次同步关联的账单（如退房状态回传时挂账的那张）
   *
   * 全部可空 / 计数默认 0：老日志行的这些信息本来就不存在，NULL 表示「当时没记录」，
   * 比填 0 更诚实（0 会被误读成「成功了 0 条」）。
   *
   * 索引都带 hotel_id 打头：多租户下不能只按 request_no / channel_order_no 查，
   * 否则可能捞出别家酒店的同步记录。
   */
  addColumn("channel_sync_logs", "request_no", "TEXT");
  addColumn("channel_sync_logs", "channel_order_no", "TEXT");
  addColumn("channel_sync_logs", "finished_at", "TEXT");
  addColumn("channel_sync_logs", "duration_ms", "INTEGER");
  addColumn("channel_sync_logs", "success_count", "INTEGER DEFAULT 0");
  addColumn("channel_sync_logs", "fail_count", "INTEGER DEFAULT 0");
  addColumn("channel_sync_logs", "booking_id", "INTEGER");
  addColumn("channel_sync_logs", "folio_id", "INTEGER");
  addIndex("idx_sync_logs_request", `CREATE INDEX idx_sync_logs_request ON channel_sync_logs(hotel_id, request_no)`);
  addIndex(
    "idx_sync_logs_channel_order",
    `CREATE INDEX idx_sync_logs_channel_order ON channel_sync_logs(hotel_id, channel_order_no)`
  );

  /* ---------- 15b. 渠道库存待同步队列（整改清单 4.1：房态回传的前置） ----------
   * 房态 / 订单一变就实时推渠道会把渠道接口打爆（四家 OTA 都有频控），
   * 所以「变化」只落一条待同步任务，由后台按队列合并后再统一推送。
   *
   * 为什么单独建表而不是复用 channel_sync_logs：
   *   sync_logs 是「已经发生的调用」的账本（审计用，只追加不消费）；
   *   queue 是「还没做的工作」（会被消费、会重试、会累计 attempts）。
   *   两者生命周期完全不同，混在一张表里会让清理和统计都变复杂。
   *   status: PENDING / DONE / FAILED；attempts 由消费者负责 +1。
   */
  if (!hasTable("channel_sync_queue")) {
    if (checkOnly) {
      applied.push("channel_sync_queue 表（待建）");
    } else {
      db.exec(`
        CREATE TABLE channel_sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          reason TEXT,
          status TEXT DEFAULT 'PENDING',
          attempts INTEGER DEFAULT 0,
          created_at TEXT,
          done_at TEXT
        );
      `);
      applied.push("channel_sync_queue 表");
      changed += 1;
    }
  } else {
    skipped.push("channel_sync_queue 表");
  }
  // 消费者只扫 PENDING：索引 (hotel_id, status, id) 正好覆盖「本店待办按先来后到」
  addIndex("idx_sync_queue_pending", `CREATE INDEX idx_sync_queue_pending ON channel_sync_queue(hotel_id, status, id)`);

  /* ---------- 15c. 渠道直连整改（第 4 轮：P1-21 / P1-22 / P2-10 ~ P2-14） ----------
   *
   * 这一段把渠道模块从「能演示」推到「能上线」，共 9 件事，全部幂等：
   *
   *   P1-21  stays.channel_order_no + 索引 + 从 bookings / remark 回填
   *   P1-22  channels.last_order_sync_at（拉单增量游标，与 last_sync_at 分离）
   *   P2-10  channel_room_types 唯一索引；channel_rate_plans 价格方案表
   *   P2-11  channels.sandbox / endpoint / app_secret_enc + 明文密钥加密迁移
   *   P2-12  channel_settlements 渠道佣金对账表
   *   P2-13  channel_sync_queue 的消费列（退避时间 / 最后错误）
   *   P1-20  channel_sync_dead_letter 死信表（重试超限后落这里，不再反复打渠道）
   *   P2-14  bookings.booking_no 唯一索引（生成侧配合 booking-no.ts 重试）
   *
   * 注意：`init-db.mjs` 收尾会调用本函数，所以全新库也会一次建全，
   * 不需要（也不应该）在 init-db 里再抄一份建表语句 —— 抄两份必然漂移（P2-2 的教训）。
   */

  /* --- 15c-1. channels：直连开关 / 自定义端点 / 加密密钥 / 佣金 / 拉单游标 --- */
  addColumn("channels", "sandbox", "INTEGER DEFAULT 1");
  addColumn("channels", "endpoint", "TEXT");
  addColumn("channels", "app_secret_enc", "TEXT");
  addColumn("channels", "commission", "REAL DEFAULT 0");
  addColumn("channels", "last_order_sync_at", "TEXT");

  /*
   * 15c-2. 把已有的明文 app_secret 加密（整改清单 P2-11）
   *
   * 判据与运行时代码一致（common.isMaskedSecret）：
   *   · 空值、`••••••••` / `******` 这类掩码占位**不是密钥**，不加密也不清空 ——
   *     它们表示「这一项没配」，加密成一段看起来像真密钥的密文反而会掩盖事实；
   *   · 真实的明文密钥加密后写入 app_secret_enc，同时把明文列置 NULL。
   *
   * 幂等：只处理 `app_secret_enc IS NULL` 且明文非空非掩码的行，
   * 重复执行不会二次加密，也不会把已清空的明文「复原」。
   */
  if (hasTable("channels") && hasColumn("channels", "app_secret_enc")) {
    const masked = (value) => {
      const s = String(value ?? "").trim();
      if (s === "") return true;
      return /[•＊]/.test(s) || /^\*+$/.test(s);
    };
    let pendingSecrets = [];
    try {
      pendingSecrets = all(
        `SELECT id, app_secret FROM channels
          WHERE app_secret IS NOT NULL AND TRIM(app_secret) <> '' AND app_secret_enc IS NULL`
      ).filter((row) => !masked(row.app_secret));
    } catch {
      pendingSecrets = [];
    }
    if (pendingSecrets.length === 0) {
      skipped.push("channels.app_secret 明文加密");
    } else if (checkOnly) {
      applied.push(`channels.app_secret 明文加密（待处理 ${pendingSecrets.length} 条）`);
    } else {
      let encrypted = 0;
      const update = db.prepare(`UPDATE channels SET app_secret_enc = ?, app_secret = NULL WHERE id = ?`);
      for (const row of pendingSecrets) {
        const cipher = encryptSecret(String(row.app_secret));
        if (!isEncryptedSecret(cipher)) continue;
        update.run(cipher, row.id);
        encrypted += 1;
      }
      applied.push(`channels.app_secret 明文加密（${encrypted} 条，明文列已清空）`);
      changed += 1;
    }
  }

  /* --- 15c-3. stays.channel_order_no（整改清单 P1-21） ---
   * 为什么入住的重复校验一直失效：stays 表根本没有渠道单号列，
   * 前台只能拿 remark 里的「渠道订单号：XXX」做 LIKE 匹配，而机器写入的入住单
   * remark 里未必带这段文字 —— 于是同一渠道单可以反复入住，第二张 stay + folio +
   * 第二次房费过账。列补上后，校验条件改为 `WHERE hotel_id=? AND channel_order_no=?`
   * （不限状态，退房后也不能再办一次）。
   */
  addColumn("stays", "channel_order_no", "TEXT");
  addIndex("idx_stays_channel_order", `CREATE INDEX idx_stays_channel_order ON stays(hotel_id, channel_order_no)`);

  /*
   * 回填历史数据（幂等：只补 NULL 行）：
   *   ① 有 booking_id 的入住单 → 取 bookings.channel_order_no；
   *   ② 没有 booking_id 的老数据 → 从 remark 里抽「渠道订单号：XXX」。
   * remark 解析放在 JS 里做（SQLite 的 instr/substr 对中文分隔符组合太绕，容易写错）。
   */
  if (hasTable("stays")) {
    let backfillRows = [];
    try {
      backfillRows = all(
        `SELECT s.id, s.remark,
                (SELECT b.channel_order_no FROM bookings b WHERE b.id = s.booking_id) AS booking_channel_no
           FROM stays s
          WHERE s.channel_order_no IS NULL`
      );
    } catch {
      backfillRows = [];
    }
    const extract = (remark) => {
      const matched = /渠道订单号[：:]\s*([A-Za-z0-9_-]+)/.exec(String(remark ?? ""));
      return matched ? matched[1] : null;
    };
    const todo = backfillRows
      .map((row) => {
        const fromBooking = String(row.booking_channel_no ?? "").trim();
        const orderNo = fromBooking !== "" ? fromBooking : extract(row.remark);
        return orderNo ? { id: row.id, orderNo } : null;
      })
      .filter(Boolean);

    if (todo.length === 0) {
      skipped.push("stays.channel_order_no 历史回填");
    } else if (checkOnly) {
      applied.push(`stays.channel_order_no 历史回填（待补 ${todo.length} 条）`);
    } else {
      const update = db.prepare(`UPDATE stays SET channel_order_no = ? WHERE id = ? AND channel_order_no IS NULL`);
      let filled = 0;
      for (const item of todo) {
        filled += Number(update.run(item.orderNo, item.id).changes);
      }
      applied.push(`stays.channel_order_no 历史回填（${filled} 条）`);
      changed += 1;
    }
  }

  /* --- 15c-4. channel_room_types 唯一索引（整改清单 P2-10） ---
   * 同一渠道同一个「渠道房型名」只能映射到一个本系统房型。
   * 没有唯一键时，重复配置会让推送与拉单各用一条映射（同名单价不同），
   * 排查时完全看不出用的哪条。建索引前先按「保留最早那条」去重。
   *
   * 建表兜底（整改清单 P2-2「建表与迁移不同步」）：
   * 这张表原来只由早期的 scripts/seed-extra.mjs 建，全新部署跑 init-db 时并不存在，
   * 紧接着的 CREATE UNIQUE INDEX 会抛 `no such table: main.channel_room_types`，
   * 让整段 runMigrations 崩掉 —— 而 init-db 收尾正是调它，表现为「全新部署初始化直接失败」。
   * DDL 与生产库现有结构逐字一致，IF NOT EXISTS 保证老库不受影响。
   */
  if (!hasTable("channel_room_types")) {
    if (checkOnly) {
      applied.push("channel_room_types 表（待建）");
    } else {
      db.exec(`CREATE TABLE channel_room_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT,
        channel_room_name TEXT,
        room_type_id INTEGER,
        created_at TEXT
      )`);
      applied.push("channel_room_types 表");
      changed += 1;
    }
  }
  if (hasTable("channel_room_types")) {
    let dupGroups = [];
    try {
      dupGroups = all(
        `SELECT hotel_id, channel_type, channel_room_name, COUNT(*) AS c, MIN(id) AS keep_id
           FROM channel_room_types
          GROUP BY hotel_id, channel_type, channel_room_name
         HAVING c > 1`
      );
    } catch {
      dupGroups = [];
    }
    if (dupGroups.length > 0) {
      if (checkOnly) {
        applied.push(`channel_room_types 映射去重（待清理 ${dupGroups.length} 组）`);
      } else {
        const del = db.prepare(
          `DELETE FROM channel_room_types
            WHERE hotel_id = ? AND channel_type = ? AND channel_room_name = ? AND id <> ?`
        );
        let removed = 0;
        for (const group of dupGroups) {
          removed += Number(del.run(group.hotel_id, group.channel_type, group.channel_room_name, group.keep_id).changes);
        }
        notes.push(`channel_room_types 重复映射已清理 ${removed} 条（每组保留最早的一条）`);
        applied.push(`channel_room_types 映射去重（清理 ${removed} 条）`);
        changed += 1;
      }
    }
  }
  addIndex(
    "idx_channel_room_types_key",
    `CREATE UNIQUE INDEX idx_channel_room_types_key ON channel_room_types(hotel_id, channel_type, channel_room_name)`
  );

  /* --- 15c-5. channel_rate_plans（整改清单 P2-10 问题 3） ---
   * 渠道的「价格方案 / rate code」与本系统房价的对应关系：
   *   factor 是加价 / 折扣系数（1 = 原价，1.15 = 加价 15%），room_type_id 为空表示渠道通用方案。
   * 推价时按房型专属方案 → 渠道通用方案 → 基准价 的顺序取，
   * 取不到就在操作日志里写明「未配置价格方案，按基准价推送」，不再静默换价。
   */
  if (hasTable("channel_rate_plans")) {
    skipped.push("channel_rate_plans 表");
  } else if (checkOnly) {
    applied.push("channel_rate_plans 表（待建）");
  } else {
    db.exec(`
      CREATE TABLE channel_rate_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT NOT NULL,
        rate_code TEXT NOT NULL,
        channel_rate_name TEXT,
        factor REAL DEFAULT 1,
        room_type_id INTEGER,
        created_at TEXT
      );
    `);
    applied.push("channel_rate_plans 表");
    changed += 1;
  }
  addIndex(
    "idx_channel_rate_plans_key",
    `CREATE UNIQUE INDEX idx_channel_rate_plans_key ON channel_rate_plans(hotel_id, channel_type, rate_code)`
  );

  /* --- 15c-6. channel_settlements 渠道佣金对账（整改清单 P2-12） ---
   * source = derived（本系统按订单金额 × 渠道佣金率推算） / channel（渠道结算单导入）。
   * 唯一键带上 source：同一订单的推算值与渠道值各存一行，页面并排比对差额；
   * order_no 为空的行（渠道账单里的汇总行）不参与唯一约束（partial index）。
   */
  if (hasTable("channel_settlements")) {
    skipped.push("channel_settlements 表");
  } else if (checkOnly) {
    applied.push("channel_settlements 表（待建）");
  } else {
    db.exec(`
      CREATE TABLE channel_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT NOT NULL,
        biz_date TEXT NOT NULL,
        order_no TEXT,
        gross_amount REAL DEFAULT 0,
        commission_amount REAL DEFAULT 0,
        net_amount REAL DEFAULT 0,
        source TEXT DEFAULT 'derived',
        raw TEXT,
        created_at TEXT
      );
    `);
    applied.push("channel_settlements 表");
    changed += 1;
  }
  addIndex(
    "idx_channel_settlements_key",
    `CREATE UNIQUE INDEX idx_channel_settlements_key
       ON channel_settlements(hotel_id, source, channel_type, biz_date, order_no)
       WHERE order_no IS NOT NULL`
  );
  addIndex(
    "idx_channel_settlements_date",
    `CREATE INDEX idx_channel_settlements_date ON channel_settlements(hotel_id, biz_date)`
  );

  /* --- 15c-7. 队列消费列（整改清单 P2-13） ---
   * 消费者需要知道「这条任务什么时候可以再试」「上次为什么失败」：
   *   没有 next_attempt_at 就只能立刻重试（打爆渠道接口），
   *   没有 last_error 页面就只能显示「失败」两个字。
   */
  addColumn("channel_sync_queue", "next_attempt_at", "TEXT");
  addColumn("channel_sync_queue", "last_error", "TEXT");

  /* --- 15c-8. 渠道同步死信表（整改清单 P1-20） ---
   * 重试到第 5 次仍失败的记录落到这里并置 DEAD：
   *   · 原日志不再被「到期重试」捞起，避免无限打渠道接口；
   *   · 死信保留最后一次错误与重试次数，运维修好配置后可以按单号手工重放。
   */
  if (hasTable("channel_sync_dead_letter")) {
    skipped.push("channel_sync_dead_letter 表");
  } else if (checkOnly) {
    applied.push("channel_sync_dead_letter 表（待建）");
  } else {
    db.exec(`
      CREATE TABLE channel_sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT,
        action TEXT,
        log_id INTEGER,
        error_code TEXT,
        message TEXT,
        retry_count INTEGER DEFAULT 0,
        created_at TEXT
      );
    `);
    applied.push("channel_sync_dead_letter 表");
    changed += 1;
  }
  addIndex(
    "idx_channel_dead_letter",
    `CREATE INDEX idx_channel_dead_letter ON channel_sync_dead_letter(hotel_id, created_at)`
  );

  /* --- 15c-9. bookings.booking_no 唯一约束（整改清单 P2-14 后半） ---
   * 预订号原来是 `BK(MAX(id)+3001)` 现算现用且没有任何唯一约束，
   * 并发下两单拿到同一个号 → 按号查单 / 对账 / 套打全部二义。
   *
   * 建唯一索引前必须先保证数据里没有重复（否则 CREATE UNIQUE INDEX 直接失败，
   * 整个迁移停在半截）。这里自动修：每组重复保留 id 最小的一条，
   * 其余的号追加 `-DUP{id}` 后缀（可追溯、不与新号冲突），并写进 notes 提示人工核对。
   */
  if (hasTable("bookings")) {
    let dupBookings = [];
    try {
      dupBookings = all(
        `SELECT hotel_id, booking_no, COUNT(*) AS c, MIN(id) AS keep_id
           FROM bookings
          WHERE booking_no IS NOT NULL AND TRIM(booking_no) <> ''
          GROUP BY hotel_id, booking_no
         HAVING c > 1`
      );
    } catch {
      dupBookings = [];
    }
    if (dupBookings.length > 0) {
      if (checkOnly) {
        applied.push(`bookings.booking_no 重复修正（待处理 ${dupBookings.length} 组）`);
      } else {
        const pick = db.prepare(
          `SELECT id FROM bookings
            WHERE hotel_id = ? AND booking_no = ? AND id <> ?
            ORDER BY id`
        );
        const rename = db.prepare(`UPDATE bookings SET booking_no = ? WHERE id = ?`);
        let fixed = 0;
        for (const group of dupBookings) {
          for (const row of pick.all(group.hotel_id, group.booking_no, group.keep_id)) {
            rename.run(`${group.booking_no}-DUP${row.id}`, row.id);
            fixed += 1;
          }
        }
        notes.push(`bookings 重复预订号已修正 ${fixed} 条（后缀 -DUP<id>，请人工核对这些单）`);
        applied.push(`bookings.booking_no 重复修正（${fixed} 条）`);
        changed += 1;
      }
    }
  }
  addIndex("idx_bookings_no", `CREATE UNIQUE INDEX idx_bookings_no ON bookings(hotel_id, booking_no)`);

  /*
   * 单号「酒店内唯一」——stays / folios 的组合唯一索引
   *
   * bookings 一直有 idx_bookings_no，但 stays / folios 没有，
   * 它们的单号只有建表时的**列级 UNIQUE（全局唯一）**，多店部署会撞号。
   *
   * 列级 UNIQUE 已经在两处改成「只做 NOT NULL + 组合唯一索引」：
   *   · 新库：scripts/init-db.mjs + scripts/schema-full.sql
   *   · 旧库：scripts/rebuild-unique-constraints.mjs（重建表，SQLite 不支持 DROP CONSTRAINT）
   *
   * 这里补索引是「新库/旧库口径统一」的第三道保险：即使某个库的表结构已经重建过、
   * 但索引因为某种原因没建上，跑一次 migrate-all 就会补齐。幂等。
   */
  addIndex("idx_stays_no", `CREATE UNIQUE INDEX idx_stays_no ON stays(hotel_id, stay_no)`);
  addIndex("idx_folios_no", `CREATE UNIQUE INDEX idx_folios_no ON folios(hotel_id, folio_no)`);

  /* ---------- 16. 权限配置落库：role_modules / role_permissions / permission_dict（整改 5.2） ----------
   * 整改指令：「统一使用数据库中的岗位和角色权限。设置页面修改权限后必须即时影响实际接口判断，
   * 不能继续使用与数据库配置脱节的硬编码权限。」
   *
   * 迁移分三步，全部幂等（跑多少次结果一致）：
   *   1. 建表 + 唯一索引（IF NOT EXISTS）；
   *   2. 把 RBAC_ROLE_MODULES / RBAC_PERMISSIONS 原样灌进两张权限表 —— 迁移前后行为完全一致，
   *      不会因为「库是空的」突然把谁锁在门外；
   *   3. permission_dict 用 29 个权限点的 key 填充中文名 / 归属模块 / 说明。
   *
   * 灌数据用 INSERT OR IGNORE（配合唯一索引），已存在的行一个字节都不动：
   * 管理员在设置页调过的权限不会被重复迁移覆盖回去。
   *
   * 多店：hotel_id 按本库 hotels 表逐店各灌一份（当前库只有 1 家店，实际结果是 hotel_id = 1）。
   * 今后新增酒店必须补一次本段逻辑（或走设置页保存），否则该店会命中
   * session.ts 里「查不到配置 → 降级到硬编码常量」的分支，表现为「新店权限跟着代码走」。
   */
  const rbacHotelIds = (() => {
    if (!hasTable("hotels")) return [1];
    const ids = all(`SELECT id FROM hotels ORDER BY id`)
      .map((r) => Number(r.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    return ids.length > 0 ? ids : [1];
  })();

  const rbacTables = [
    [
      "role_modules",
      `CREATE TABLE IF NOT EXISTS role_modules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        module TEXT NOT NULL,
        created_at TEXT
      )`,
    ],
    [
      "role_permissions",
      `CREATE TABLE IF NOT EXISTS role_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        permission TEXT NOT NULL,
        created_at TEXT
      )`,
    ],
    [
      "permission_dict",
      `CREATE TABLE IF NOT EXISTS permission_dict (
        permission TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        module TEXT,
        description TEXT
      )`,
    ],
  ];
  for (const [name, ddl] of rbacTables) {
    if (hasTable(name)) {
      skipped.push(`${name} 表`);
      continue;
    }
    if (checkOnly) {
      applied.push(`${name} 表（待建）`);
      continue;
    }
    db.exec(ddl);
    applied.push(`${name} 表`);
    changed += 1;
  }

  // 唯一索引保证「同一酒店 + 同一角色 + 同一模块/权限点」只有一行，也是 INSERT OR IGNORE 的去重依据
  addIndex(
    "idx_role_modules_key",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_role_modules_key ON role_modules(hotel_id, role, module)`
  );
  addIndex(
    "idx_role_permissions_key",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_role_permissions_key ON role_permissions(hotel_id, role, permission)`
  );

  /** 按酒店把 (role, 值) 行补进权限表；返回「待补行数 / 实际插入行数」 */
  function seedRbacRoleRows(table, column, rows) {
    if (!hasTable(table)) return { missing: 0, inserted: 0 };
    let missing = 0;
    let inserted = 0;
    for (const hotelId of rbacHotelIds) {
      const existing = new Set(
        all(`SELECT role, ${column} AS v FROM ${table} WHERE hotel_id = ?`, [hotelId]).map(
          (r) => `${r.role}\u0001${r.v}`
        )
      );
      const todo = rows.filter((r) => !existing.has(`${r.role}\u0001${r[column]}`));
      missing += todo.length;
      if (checkOnly || todo.length === 0) continue;
      const ins = db.prepare(
        `INSERT OR IGNORE INTO ${table} (hotel_id, role, ${column}, created_at) VALUES (?, ?, ?, ?)`
      );
      const at = new Date().toISOString();
      for (const r of todo) {
        ins.run(hotelId, r.role, r[column], at);
        inserted += 1;
      }
    }
    return { missing, inserted };
  }

  /** 补齐 permission_dict（权限点字典没有 hotel_id，是全局表） */
  function seedPermissionDict() {
    if (!hasTable("permission_dict")) return { missing: 0, inserted: 0 };
    const existing = new Set(all(`SELECT permission FROM permission_dict`).map((r) => r.permission));
    const todo = RBAC_PERMISSION_DICT.filter((d) => !existing.has(d.permission));
    if (checkOnly || todo.length === 0) return { missing: todo.length, inserted: 0 };
    const ins = db.prepare(
      `INSERT OR IGNORE INTO permission_dict (permission, label, module, description) VALUES (?, ?, ?, ?)`
    );
    for (const d of todo) ins.run(d.permission, d.label, d.module, d.description ?? null);
    return { missing: todo.length, inserted: todo.length };
  }

  const rbacModuleRows = Object.entries(RBAC_ROLE_MODULES).flatMap(([role, mods]) =>
    mods === "*" ? [{ role, module: "*" }] : mods.map((module) => ({ role, module }))
  );
  const rbacPermissionRows = Object.entries(RBAC_PERMISSIONS).flatMap(([permission, roles]) =>
    roles.map((role) => ({ role, permission }))
  );

  const moduleSeed = seedRbacRoleRows("role_modules", "module", rbacModuleRows);
  if (moduleSeed.missing === 0) {
    skipped.push("role_modules 种子数据");
  } else if (checkOnly) {
    applied.push(`role_modules 种子数据（待补 ${moduleSeed.missing} 行）`);
  } else {
    applied.push(`role_modules 种子数据（补 ${moduleSeed.inserted} 行）`);
    changed += 1;
  }

  const permissionSeed = seedRbacRoleRows("role_permissions", "permission", rbacPermissionRows);
  if (permissionSeed.missing === 0) {
    skipped.push("role_permissions 种子数据");
  } else if (checkOnly) {
    applied.push(`role_permissions 种子数据（待补 ${permissionSeed.missing} 行）`);
  } else {
    applied.push(`role_permissions 种子数据（补 ${permissionSeed.inserted} 行）`);
    changed += 1;
  }

  const dictSeed = seedPermissionDict();
  if (dictSeed.missing === 0) {
    skipped.push("permission_dict 字典");
  } else if (checkOnly) {
    applied.push(`permission_dict 字典（待补 ${dictSeed.missing} 个权限点）`);
  } else {
    applied.push(`permission_dict 字典（补 ${dictSeed.inserted} 个权限点）`);
    changed += 1;
  }

  /* ---------- 16b. 建表同步：主流程依赖的表与列（整改清单 P2-2 / P1-30） ----------
   *
   * 背景（P2-2）：init-db.mjs 只建「基础表」，其余表散落在各页面/action 里懒创建
   * （lost_items / score_codes / lock_devices / lease_records / ar_accounts ...）。
   * init-db 收尾会调用本文件的 runMigrations，所以**这里建的 = 新部署必然有的**；
   * 反过来，只懒建不迁移的表，就是「新库第一次打开某个页面才出现」的漂移来源。
   *
   * 本轮只补两处有硬依赖的：
   *   1. lock_devices —— 下面第 17 段的性能索引 idx_lock_devices_room 直接建在它上面。
   *      表不存在时 CREATE INDEX 失败，于是全新库跑完 init-db 之后
   *      `migrate-all --check` 永远报「性能索引（待建 1 个）」，与「已是目标状态」的
   *      部署验收口径冲突。这是实测复现的（用空库跑 init-db 即可看到）。
   *   2. lost_items —— 失物招领的主表，且本轮要给它补 claimed_at 列（P1-30）。
   *      先建表再 addColumn，新库与老库最终形态一致。
   *
   * DDL 与懒创建处（src/app/(main)/lock-settings/actions.ts、
   * src/app/(main)/lost-found/page.tsx）逐字保持一致：IF NOT EXISTS 保证
   * 两边谁先跑都不冲突，但列定义必须一样，否则新库/老库结构会分叉。
   */
  const SYNC_TABLES = [
    [
      "lock_devices",
      `CREATE TABLE IF NOT EXISTS lock_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        room_id INTEGER NOT NULL,
        lock_code TEXT,
        status TEXT NOT NULL DEFAULT 'BOUND',
        signal INTEGER,
        battery INTEGER,
        bound_at TEXT,
        UNIQUE (hotel_id, room_id)
      )`,
    ],
    [
      "lost_items",
      `CREATE TABLE IF NOT EXISTS lost_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        room_no TEXT,
        guest_name TEXT,
        mobile TEXT,
        found_at TEXT,
        keeper TEXT,
        status TEXT DEFAULT 'PENDING',
        note TEXT,
        claimed_at TEXT,
        created_at TEXT
      )`,
    ],
  ];
  for (const [name, ddl] of SYNC_TABLES) {
    if (hasTable(name)) {
      skipped.push(`${name} 表`);
      continue;
    }
    if (checkOnly) {
      applied.push(`${name} 表（待建）`);
      continue;
    }
    db.exec(ddl);
    applied.push(`${name} 表`);
    changed += 1;
  }
  /* 失物认领时间（P1-30）：老库的 lost_items 没有这一列，认领时就不能再覆盖 found_at */
  addColumn("lost_items", "claimed_at", "TEXT");

  /* ---------- 17. 性能索引（Serverless 部署后暴露出的性能问题） ----------
   * 房态页在 Vercel 上一次要 2~5 秒，拆解发现 stays/folios/bookings/rooms
   * 这些核心表一个索引都没有 —— 46 间房 × 6 个关联子查询 = 276 次全表扫描。
   * 补上索引后走 COVERING INDEX，本地单次查询从毫秒级降到 0.07ms。
   */
  const PERF_INDEXES = [
    ["idx_stays_room", "stays(hotel_id, room_id, status)"],
    ["idx_stays_guest", "stays(hotel_id, guest_id)"],
    ["idx_stays_status", "stays(hotel_id, status, expect_check_out)"],
    ["idx_folios_stay", "folios(hotel_id, stay_id)"],
    ["idx_folio_items_folio", "folio_items(hotel_id, folio_id)"],
    ["idx_payments_stay", "payments(hotel_id, stay_id)"],
    ["idx_payments_bizdate", "payments(hotel_id, biz_date)"],
    ["idx_bookings_status", "bookings(hotel_id, status, check_in_date)"],
    ["idx_bookings_checkin", "bookings(hotel_id, check_in_date)"],
    ["idx_rooms_sort", "rooms(hotel_id, sort)"],
    ["idx_housekeeping_status", "housekeeping(hotel_id, status, room_id)"],
    ["idx_op_logs_time", "op_logs(hotel_id, id DESC)"],
    ["idx_lock_devices_room", "lock_devices(hotel_id, room_id)"],
    ["idx_rate_calendar_key", "rate_calendar(hotel_id, room_type_id, date)"],
  ];
  const missingIdx = PERF_INDEXES.filter(
    (n) =>
      !db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`)
        .get(n[0])
  );
  if (missingIdx.length === 0) {
    skipped.push("性能索引（14 个）");
  } else if (checkOnly) {
    applied.push(`性能索引（待建 ${missingIdx.length} 个）`);
  } else {
    let built = 0;
    for (const [name, cols] of missingIdx) {
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${cols}`);
        built += 1;
      } catch (e) {
        notes.push(`索引 ${name} 建失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    db.exec("ANALYZE");
    applied.push(`性能索引（新建 ${built} 个）`);
    changed += 1;
  }

  /* ---------- 17. 登录爆破防护（上线加固） ----------
   * 认证辅助表：按账号记失败次数与锁定截止时间，不含业务数据，故不带 hotel_id。
   * 登录接口对「表不存在」做了降级，所以老库没跑迁移也不会登不进系统。
   * 新增表必须在 init-db.mjs 里同步建一份，否则全新部署会缺表。
   */
  if (hasTable("login_attempts")) {
    skipped.push("login_attempts（登录失败计数）");
  } else if (checkOnly) {
    applied.push("login_attempts（待建）");
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
      login_key   TEXT PRIMARY KEY,
      fail_count  INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at  TEXT
    )`);
    applied.push("login_attempts（登录失败计数）");
    changed += 1;
  }

  /* ---------- 18. 管家密码：明文 → scrypt 哈希（整改清单 P1-35） ----------
   *
   * 背景：settings.steward_password 原来以**明文**落库（settings/actions.ts 的
   * saveAdvancedFormAction 直接 saveSettingValue(hotelId, "steward_password", password)）。
   * settings 表会被设置页整表读出来、也会随 data/pms.db 一起备份/导出，
   * 明文口令等于随库泄露；而且与 users 的 scrypt 哈希策略自相矛盾。
   *
   * 规则（与第 14 段的 users 密码迁移同构）：
   *   · 值已是 scrypt 串（历史误写/重复执行）→ 原样搬进 steward_password_hash，不二次 hash；
   *   · 值是明文                              → hashPassword(value) 后写入；
   *   · 写入成功之后才把明文置空串（幂等：置空后下次条件不命中）。
   *
   * 为什么一个事务：避免「明文清空了、哈希没写成」—— 那等于把管家密码彻底弄丢。
   */
  if (!hasTable("settings")) {
    skipped.push("settings（表不存在）");
  } else {
    const plainSteward = all(
      `SELECT id, hotel_id, value FROM settings
        WHERE key = 'steward_password' AND value IS NOT NULL AND value <> ''
        ORDER BY id`
    );
    if (plainSteward.length === 0) {
      skipped.push("steward_password 明文迁移");
    } else if (checkOnly) {
      applied.push(`steward_password 明文 → scrypt 哈希（待处理 ${plainSteward.length} 行）`);
    } else {
      db.exec("BEGIN");
      try {
        const insertHash = db.prepare(
          `INSERT INTO settings (hotel_id, key, value) VALUES (?, 'steward_password_hash', ?)`
        );
        const updateHash = db.prepare(`UPDATE settings SET value = ? WHERE id = ?`);
        const clearPlain = db.prepare(`UPDATE settings SET value = '' WHERE id = ?`);
        for (const row of plainSteward) {
          const hotelId = Number(row.hotel_id);
          const raw = String(row.value);
          const hashed = raw.startsWith("scrypt$") ? raw : hashPassword(raw);
          const existing = all(
            `SELECT id FROM settings WHERE hotel_id = ? AND key = 'steward_password_hash'`,
            [hotelId]
          );
          if (existing.length > 0) updateHash.run(hashed, existing[0].id);
          else insertHash.run(hotelId, hashed);
          clearPlain.run(row.id);
        }
        db.exec("COMMIT");
        applied.push(`steward_password 明文 → scrypt 哈希（${plainSteward.length} 行）`);
        notes.push("管家密码已改为哈希存储，settings.steward_password 明文已清空");
        changed += 1;
      } catch (e) {
        db.exec("ROLLBACK");
        notes.push(
          `管家密码哈希迁移失败，已回滚（明文保持原样）：${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  /* ---------- 19. 报表查询索引（整改清单 P2-3） ----------
   *
   * 报表中心单页会重复扫同一批表 5 次。用 EXPLAIN QUERY PLAN 实测（演示库
   * 46 间房 / 200 张账单 / 446 条明细），三张表在报表的 WHERE 条件下都没有可用索引：
   *
   *   SELECT … FROM folio_items WHERE hotel_id=? AND biz_date BETWEEN ? AND ?
   *          AND item_type IN ('ROOM','FOOD','OTHER')          → SCAN folio_items
   *   SELECT … FROM folios WHERE hotel_id=? AND balance > 0.005  → SCAN folios
   *   SELECT … FROM rooms WHERE hotel_id=? GROUP BY status      → SCAN rooms
   *
   * 第 17 段的索引只覆盖了 folio_id / stay_id / 房态页路径：
   *   · idx_folio_items_folio(hotel_id, folio_id) 不含 biz_date —— 报表按营业日
   *     区间取数时用不上，只能全表扫；
   *   · folios 只有 (hotel_id, stay_id)，应收合计/催账按 balance 过滤同样全表扫；
   *   · rooms 只有 (hotel_id, sort)，实时房态按 status 汇总也要扫全表。
   *
   * 只加这三条（不给每列都加），依据是报表 SQL 里真实被 WHERE / GROUP BY 用到的列：
   *   · folio_items(hotel_id, biz_date, item_type)
   *       hotel_id 等值 + biz_date 范围走同一索引；item_type 放第三位既服务
   *       `item_type IN ('ROOM','FOOD','OTHER')`，也让 `GROUP BY biz_date`
   *       直接吃索引顺序，省掉 TEMP B-TREE。
   *   · rooms(hotel_id, status)
   *       房态分布 / 出租率按状态分组。
   *   · folios(hotel_id, balance)
   *       应收合计、催账 `balance > 0.005`、`ORDER BY balance DESC LIMIT 200`
   *       都命中这一个索引。
   *
   * 用 addIndex()：它先查 sqlite_master（幂等）、checkOnly 只报「待建」、
   * 目标表不存在时跳过而不是让整个迁移崩在中间（新库初始化也会跑这段）。
   */
  const REPORT_IDX_NAMES = ["idx_folio_items_bizdate", "idx_rooms_status", "idx_folios_balance"];
  const reportIdxMissing = REPORT_IDX_NAMES.filter((n) => !hasIndex(n));
  addIndex(
    "idx_folio_items_bizdate",
    "CREATE INDEX IF NOT EXISTS idx_folio_items_bizdate ON folio_items(hotel_id, biz_date, item_type)"
  );
  addIndex(
    "idx_rooms_status",
    "CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(hotel_id, status)"
  );
  addIndex(
    "idx_folios_balance",
    "CREATE INDEX IF NOT EXISTS idx_folios_balance ON folios(hotel_id, balance)"
  );
  /*
   * 刚建出来的索引在 sqlite_stat1 里还没有分布信息，多候选索引时规划器可能仍挑旧索引
   * （第 17 段只在首次建房态索引时 ANALYZE 过一次）。这里只在本段确实新建了索引时补一次；
   * checkOnly 不写库。单独 try：ANALYZE 要写锁，服务在跑时拿不到不该让迁移失败。
   */
  if (!checkOnly && reportIdxMissing.length > 0) {
    try {
      db.exec("ANALYZE");
      notes.push(`报表索引新建 ${reportIdxMissing.length} 个，已更新统计信息（ANALYZE）`);
    } catch (e) {
      notes.push(`ANALYZE 失败（不影响功能，可稍后手动执行）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ---------- 20. 客房审核状态 + 入住自用标记（第 5 轮 P1-4 语义修复） ----------
   *
   * 背景：房态页 12 个快捷标签里有两个上一版把语义映射错了：
   *   · 「待审」原来查 cancel_requests.status = 'PENDING' ——
   *     那是**取消入住审批**（客人要退房、等主管批不批），与客房打扫验收毫无关系。
   *     拿它当「待审」的后果是双向漏处理：真的有人申请取消入住在等着批，
   *     前台看到的却是「房间要验收」；而真正打扫完等验收的房间，标签里没有。
   *   · 「自用」没有任何字段可查，界面上只能显示「缺字段」。
   *
   * ── 为什么新增 housekeeping.review_status，而不是复用 housekeeping.status ──
   * housekeeping.status 表达的是**任务流转**：
   *   PENDING 待打扫 → DOING 打扫中 → DONE 已完成 / CANCELLED 已取消
   * 而「审核」表达的是**验收**：这个任务做得合不合格、谁验的。
   * 两者是正交的两个维度。塞进同一个字段会有两个绕不开的问题：
   *   1. 「已打扫完但还没人验收」和「正在打扫」无法同时存在：
   *      要么把 DONE 一律当待审（已验收过的历史任务也全进待审，越用越脏），
   *      要么再造 DONE_REVIEW / APPROVED 之类状态 —— 那 status 里就一半流转
   *      一半验收，任何按 status 做的统计（今日完成量、待打扫数）都开始算错。
   *   2. 维修/查房任务共用这张表，它们不走打扫验收流程；
   *      混一个字段后 `status = 'PENDING_REVIEW'` 到底是「打扫待验收」
   *      还是「维修待验收」说不清，只能再加 task_type 条件去猜。
   *
   * 独立一列的取值约定（代码里只有这四个值，NULL 是默认）：
   *   NULL           不需要审核（非打扫任务，以及本段之前的打扫历史数据）
   *   PENDING_REVIEW 打扫完成，等主管验收     ← 房态页「待审」标签只数这个
   *   APPROVED       验收通过
   *   REJECTED       打回重做（同时把任务 status 退回 PENDING 重新进待打扫列表）
   *
   * ── 「自用」为什么放 stays 不放 rooms ──
   * 自用是**这一次入住的性质**（员工自己住 / 招待用房），同一间房上一次自用
   * 不代表这一次也是。放 rooms 等于把房间永久标成自用房，每次退房后还得手动清，
   * 漏清一次就把正常售卖的房间一直算进「自用」。stays.self_use 随入住单按次生效，
   * 退房即结束，不需要额外清理。
   *
   * 明确**不把 rate = 0（免费房）当自用**：免费房有促销免单、赔付、招待、OTA
   * 预付等多种来源，用房价反推入住性质必然算错。自用必须由前台在入住时显式勾选。
   */
  addColumn("housekeeping", "review_status", "TEXT");
  addColumn("housekeeping", "reviewed_by", "TEXT");
  addColumn("housekeeping", "reviewed_at", "TEXT");
  addColumn("stays", "self_use", "INTEGER DEFAULT 0");
  /*
   * 「打扫中」「待审」两个标签都是「按房间找任务」，房态页的子查询写法是
   *   WHERE hotel_id = ? AND room_id = ? AND task_type = '打扫' AND status/review_status = ?
   * 现有 idx_housekeeping_status 只有 (hotel_id, status)，room_id 不在索引里，
   * 按房间反查仍要回表扫。补两条更贴实际写法的索引：
   *   · (hotel_id, room_id, status)        待打扫 / 打扫中
   *   · (hotel_id, room_id, review_status) 待审
   * 分成两条而不是合成一条，是因为 status 的高频值（PENDING / DONE）与
   * review_status 的筛选值（PENDING_REVIEW，绝大多数行是 NULL）在选择性上完全不同，
   * 一条三列索引无法同时服务两种过滤。两个索引都很小（房子 × 任务），维护成本可忽略。
   */
  addIndex(
    "idx_housekeeping_room_status",
    "CREATE INDEX IF NOT EXISTS idx_housekeeping_room_status ON housekeeping(hotel_id, room_id, status)"
  );
  addIndex(
    "idx_housekeeping_review",
    "CREATE INDEX IF NOT EXISTS idx_housekeeping_review ON housekeeping(hotel_id, room_id, review_status)"
  );

  return { changed, applied, skipped, notes, checkOnly };
}

/* ---------- CLI 入口：只有直接执行时才建连接、打印、退出 ---------- */
function cli() {
  const checkOnly = process.argv.includes("--check");
  const dbPath = resolveDbPath();
  const db = new DatabaseSync(dbPath);
  /*
   * 迁移经常要在服务运行中执行（3100 还在跑，前台在用）。
   * 拿不到写锁时默认立刻 SQLITE_BUSY，这里等最多 10 秒，避免被一次几毫秒的
   * 业务写事务顶掉；真等不到才报错退出，而不是留下半截迁移。
   */
  db.exec("PRAGMA busy_timeout = 10000");

  console.log(`数据库：${dbPath}`);
  console.log(checkOnly ? "模式：仅检查\n" : "模式：执行迁移\n");

  const result = runMigrations(db, { checkOnly });

  for (const n of result.notes) console.log("  ! " + n);
  if (result.applied.length > 0) {
    console.log(`本次${checkOnly ? "待处理" : "已应用"}（${result.applied.length}）：`);
    for (const a of result.applied) console.log("  + " + a);
  } else {
    console.log("没有需要变更的项目");
  }
  console.log(`已是目标状态（跳过）${result.skipped.length} 项`);
  console.log(`\n${checkOnly ? "检查完成" : `迁移完成，变更 ${result.changed} 处`}`);

  db.close();
  process.exit(0);
}

// 只有直接执行时才跑主流程；被 init-db.mjs import 时只提供 runMigrations
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) cli();
