/**
 * 微信小程序配置（整改清单 F12：微信小程序 / 会员端）
 *
 * ── 为什么要有这张表 ──
 * 小程序要用 `app_id` + `app_secret` 调微信的 jscode2session 换 openid，
 * 这两个值只有酒店自己能在 https://mp.weixin.qq.com 上拿到，代码里**绝不能硬编码**。
 * 所以配置统一落库（mini_program_config，单店一套，hotel_id 唯一），
 * 管理员在「设置 → 小程序配置」里填，接口运行时读取。
 *
 * ── 与 settings 表的关系 ──
 * 没有复用 settings 的 key-value：AppSecret 属于凭据，需要「未配置 / 已配置」这种
 * 结构化状态（app_id/app_secret 是否都填了、是否启用），塞进 key-value 后每次
 * 都要拼 4 个 key 才能判断状态，容易漏判（只填了 AppID 就以为配好了）。
 *
 * ── schema 来源 ──
 * 迁移脚本 scripts/migrate-all.mjs 是 schema 的唯一来源；本文件的
 * CREATE TABLE IF NOT EXISTS 只是「页面/接口先跑起来」的幂等兜底（项目既有约定）。
 *
 * 安全约定（务必遵守）：
 *   · 本文件不会把 app_secret 写进任何返回值以外的日志 / 页面；
 *   · 页面上只显示打码后的 AppID，AppSecret 一律不回显（留空 = 不修改）。
 */

import { all, get, run } from "@/lib/db";
import { nowIso } from "@/lib/utils";

/** 小程序配置（单店一条） */
export type MiniProgramConfig = {
  hotelId: number;
  /** 微信小程序 AppID（wx 开头 18 位） */
  appId: string;
  /** 微信小程序 AppSecret（32 位，只用于服务端换 openid，绝不外发） */
  appSecret: string;
  /** 微信支付商户号（可选，留空表示不做在线支付） */
  mchId: string;
  /** 微信支付 API 密钥（可选，落库前不加密，仅供内网部署使用） */
  mchKey: string;
  /** 是否启用（0 = 停止小程序登录，接口返回 NOT_CONFIGURED） */
  enabled: boolean;
  updatedAt: string | null;
};

/** 保存入参：字段全部可选，未传的字段保持原值（AppSecret 留空 = 不修改） */
export type MiniProgramConfigInput = {
  hotelId: number;
  appId?: string;
  appSecret?: string;
  mchId?: string;
  mchKey?: string;
  enabled?: boolean;
};

/** 表结构只建一次（dev 热重载会重置模块，CREATE IF NOT EXISTS 幂等兜底） */
let schemaReady = false;

/** 建表（幂等，与 scripts/migrate-all.mjs 的 DDL 完全一致） */
export function ensureMiniSchema(): void {
  if (schemaReady) return;
  run(`
    CREATE TABLE IF NOT EXISTS mini_program_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      app_id TEXT,
      app_secret TEXT,
      mch_id TEXT,
      mch_key TEXT,
      enabled INTEGER DEFAULT 0,
      updated_at TEXT,
      UNIQUE(hotel_id)
    )
  `);
  run(`
    CREATE TABLE IF NOT EXISTS mini_program_users (
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
    )
  `);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mini_users_openid ON mini_program_users(hotel_id, openid)`);
  run(`CREATE INDEX IF NOT EXISTS idx_mini_users_token ON mini_program_users(session_token)`);

  /*
   * 老库补列（整改 P0-11）：guests / stays / bookings 都是老表，
   * mini_program_users 在旧版本里没有绑定失败计数的列。SQLite 不支持
   * ADD COLUMN IF NOT EXISTS，只能 ALTER 后用异常判断「列已存在」。
   */
  for (const ddl of [
    `ALTER TABLE mini_program_users ADD COLUMN bind_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE mini_program_users ADD COLUMN bind_locked_until TEXT`,
  ]) {
    try {
      run(ddl);
    } catch {
      /* 列已存在 → 跳过（幂等兜底） */
    }
  }

  /*
   * 小程序用户 ↔ 订单关联（整改 P2-17）
   *
   * 为什么需要这张表：「未绑定手机号的用户看不到自己下的单」。
   * 旧实现靠写 mini_program_users.mobile 再按手机号反查 —— 而手机号是用户
   * 自己填的自由文本（下单时随手填别人的号就能看到别人的订单），属于
   * 「用可伪造字段做授权」，整改 P0-12 明确禁止。
   * 改成下单时记一行（openid 对应的 mini_user_id ↔ booking_id）：
   *   · 关联关系由服务端在事务里写，客户端无法伪造；
   *   · 未绑定用户也能看到「自己这个微信下过的单」；
   *   · 已绑定用户除此之外还能看到 guest_id 归到自己客史下的单。
   */
  run(`
    CREATE TABLE IF NOT EXISTS mini_program_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      mini_user_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      created_at TEXT,
      UNIQUE(hotel_id, booking_id)
    )
  `);
  run(`CREATE INDEX IF NOT EXISTS idx_mini_bookings_user ON mini_program_bookings(hotel_id, mini_user_id)`);
  schemaReady = true;
}

/** 数据库行（snake_case，只声明用得到的列） */
type ConfigRow = {
  hotel_id: number;
  app_id: string | null;
  app_secret: string | null;
  mch_id: string | null;
  mch_key: string | null;
  enabled: number | null;
  updated_at: string | null;
};

const SELECT_COLUMNS = `hotel_id, app_id, app_secret, mch_id, mch_key, enabled, updated_at`;

/** 行 → 领域对象：空值统一成空串，避免调用方到处判 null */
function toConfig(row: ConfigRow): MiniProgramConfig {
  return {
    hotelId: Number(row.hotel_id),
    appId: (row.app_id ?? "").trim(),
    appSecret: (row.app_secret ?? "").trim(),
    mchId: (row.mch_id ?? "").trim(),
    mchKey: (row.mch_key ?? "").trim(),
    enabled: Number(row.enabled ?? 0) === 1,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * 读取某酒店的配置。
 * 返回 null 表示「一条记录都没有」（从未保存过），与「保存了但没填 AppID」不同：
 * 后者需要让管理员看到表单里的启用开关状态，前者可以直接展示未配置。
 */
export function getMiniProgramConfig(hotelId: number): MiniProgramConfig | null {
  ensureMiniSchema();
  const row = get<ConfigRow>(`SELECT ${SELECT_COLUMNS} FROM mini_program_config WHERE hotel_id = ? LIMIT 1`, [
    hotelId,
  ]);
  return row ? toConfig(row) : null;
}

/** 全部酒店的配置（多店部署时给运营查看；单店通常只有一条） */
export function listMiniProgramConfigs(): MiniProgramConfig[] {
  ensureMiniSchema();
  return all<ConfigRow>(`SELECT ${SELECT_COLUMNS} FROM mini_program_config ORDER BY hotel_id`).map(toConfig);
}

/**
 * 读旧「微酒店 / 微信」配置里的同名配置（整改清单 P2-18）
 *
 * ── 为什么存在 ──
 * 项目里有两个配置入口，各存各的表：
 *   · `/wechat` 页（src/app/(main)/wechat/actions.ts）写 settings 表的
 *     wechat_appid / wechat_secret / wechat_mch_id / wechat_enabled；
 *   · `/settings?tab=miniprogram` 写 mini_program_config 表。
 * 管理员在 `/wechat` 填完 AppID + AppSecret 后，小程序登录仍然 NOT_CONFIGURED
 * —— 同一件事存两处，用户永远不知道自己该信哪个页面。
 *
 * ── 本批的收敛方式（只改读路径）──
 * `/wechat` 那份继续由原页面维护；小程序侧改成「优先 mini_program_config，
 * 没有可用配置时回退读 settings 的 wechat_*」：两个入口填任意一处都能登录。
 * 写入路径的收敛（让 /wechat 的保存动作直接写 mini_program_config，或把 /wechat 页
 * 引导到 /settings?tab=miniprogram）要改 (main) 页面，不在本批写作用域内，已记入整改报告。
 *
 * 返回 null 的三种情况都等价于「没有可用配置」：settings 表不存在（极老库）、
 * 没填过、填了但没启用 / 缺 AppID / 缺 AppSecret。
 */
function readWechatSettingsConfig(onlyHotelId?: number): MiniProgramConfig | null {
  if (onlyHotelId !== undefined) {
    const single = readWechatSettingsRows(onlyHotelId);
    return single ? buildWechatSettingsConfig(single) : null;
  }
  for (const bucket of readAllWechatSettingsRows()) {
    const cfg = buildWechatSettingsConfig(bucket);
    if (cfg) return cfg;
  }
  return null;
}

type WechatSettingsBucket = { hotelId: number; values: Record<string, string> };

/** 读一家店的 wechat_* 配置行（settings 表不存在时返回 null，不抛错） */
function readWechatSettingsRows(hotelId: number): WechatSettingsBucket | null {
  try {
    const rows = all<{ hotel_id: number; key: string; value: string | null }>(
      `SELECT hotel_id, key, value FROM settings
        WHERE hotel_id = ? AND key IN ('wechat_appid','wechat_secret','wechat_mch_id','wechat_enabled')
        ORDER BY id`,
      [hotelId]
    );
    if (rows.length === 0) return null;
    return { hotelId, values: toSettingsMap(rows) };
  } catch {
    return null;
  }
}

/** 读所有店的 wechat_* 配置行，按 hotel_id 升序（与「取 hotel_id 最小」的口径一致） */
function readAllWechatSettingsRows(): WechatSettingsBucket[] {
  try {
    const rows = all<{ hotel_id: number; key: string; value: string | null }>(
      `SELECT hotel_id, key, value FROM settings
        WHERE key IN ('wechat_appid','wechat_secret','wechat_mch_id','wechat_enabled')
        ORDER BY hotel_id, id`
    );
    const map = new Map<number, Record<string, string>>();
    for (const row of rows) {
      const h = Number(row.hotel_id);
      const bucket = map.get(h) ?? {};
      bucket[String(row.key)] = (row.value ?? "").trim();
      map.set(h, bucket);
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hotelId, values]) => ({ hotelId, values }));
  } catch {
    return [];
  }
}

function toSettingsMap(rows: { key: string; value: string | null }[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of rows) values[String(row.key)] = (row.value ?? "").trim();
  return values;
}

/**
 * 把 settings 里的 wechat_* 组装成 MiniProgramConfig。
 * 只认「启用 + AppID + AppSecret 齐全」，与 getActiveMiniConfig 的判定口径完全一致。
 * 微信页没有单独的「商户密钥」字段（mch_key 只在 settings 的微信支付模块里），所以这里留空。
 */
function buildWechatSettingsConfig(bucket: WechatSettingsBucket): MiniProgramConfig | null {
  const v = bucket.values;
  const appId = v.wechat_appid ?? "";
  const appSecret = v.wechat_secret ?? "";
  const enabled = (v.wechat_enabled ?? "") === "1";
  if (!enabled || !appId || !appSecret) return null;
  return {
    hotelId: bucket.hotelId,
    appId,
    appSecret,
    mchId: v.wechat_mch_id ?? "",
    mchKey: "",
    enabled: true,
    updatedAt: null,
  };
}

/**
 * 取「可用于登录」的配置：启用 且 AppID / AppSecret 都非空。
 * 返回 null 时 /api/mini/login 必须直接拒绝（NOT_CONFIGURED），不许假装登录成功。
 *
 * 多店说明：本项目按单店部署（迁移脚本里 hotel_id 唯一），
 * 若真有多条配置，取 hotel_id 最小的那条 —— 与 resolveMiniHotelId 保持同一口径。
 *
 * 整改 P2-18：mini_program_config 没有可用配置时，回退读 /wechat 页写入 settings 的
 * wechat_*（两个入口填任意一处都能登录，见 readWechatSettingsConfig 的说明）。
 */
export function getActiveMiniConfig(): MiniProgramConfig | null {
  ensureMiniSchema();
  const rows = all<ConfigRow>(`SELECT ${SELECT_COLUMNS} FROM mini_program_config ORDER BY hotel_id LIMIT 5`).map(
    toConfig
  );
  for (const cfg of rows) {
    if (cfg.enabled && cfg.appId && cfg.appSecret) return cfg;
  }
  return readWechatSettingsConfig();
}

/**
 * 小程序接口应该落在哪家酒店（rooms / bookings 这类不需要登录的接口用）。
 *
 * 判定顺序：
 *   1. mini_program_config 里配置过的那家店（有配置就一定有目标店）
 *   2. 否则退回 hotels 表第一家（单店部署就是唯一那家）
 *   3. 再没有就返回 1（空库兜底，接口层面会因为没有房型返回空列表）
 *
 * 为什么不要求小程序端传 hotelId：客户端传任何租户号都能被伪造，
 * 服务端自己决定落哪家店才是安全的；单店部署也没必要让用户选酒店。
 */
export function resolveMiniHotelId(): number {
  ensureMiniSchema();
  const cfg = get<{ hotel_id: number }>(
    `SELECT hotel_id FROM mini_program_config ORDER BY hotel_id LIMIT 1`
  );
  if (cfg?.hotel_id) return Number(cfg.hotel_id);
  /*
   * 整改 P2-18：只在 /wechat 页配过（settings 表有 wechat_* 行）时，用那份配置的
   * hotel_id —— 与 getActiveMiniConfig 的回退口径一致，否则会出现
   * 「登录认了 settings 那家店、查房价却落回 hotels 第一家」的租户错位。
   * 这里不要求 enabled：只要管理员在某个入口填过，就说明目标店是那家。
   */
  const fromSettings = readAllWechatSettingsRows()[0];
  if (fromSettings?.hotelId) return fromSettings.hotelId;
  const hotel = get<{ id: number }>(`SELECT id FROM hotels ORDER BY id LIMIT 1`);
  return Number(hotel?.id ?? 1);
}

/**
 * 保存配置（存在则更新，不存在则插入）
 *
 * AppSecret 的特殊处理：传空串 = 「不修改」（页面上不回显密钥，
 * 管理员只想改商户号时不用重新输入一次密钥）。
 * 要清空密钥请用 clearMiniProgramSecret（目前不提供，避免误清导致线上登录中断）。
 */
export function saveMiniProgramConfig(input: MiniProgramConfigInput): MiniProgramConfig {
  ensureMiniSchema();
  const hotelId = Number(input.hotelId);
  const exists = get<ConfigRow>(`SELECT ${SELECT_COLUMNS} FROM mini_program_config WHERE hotel_id = ?`, [hotelId]);
  const now = nowIso();

  if (!exists) {
    run(
      `INSERT INTO mini_program_config (hotel_id, app_id, app_secret, mch_id, mch_key, enabled, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        hotelId,
        (input.appId ?? "").trim(),
        (input.appSecret ?? "").trim(),
        (input.mchId ?? "").trim(),
        (input.mchKey ?? "").trim(),
        input.enabled ? 1 : 0,
        now,
      ]
    );
  } else {
    const prev = toConfig(exists);
    const secret = (input.appSecret ?? "").trim() === "" ? prev.appSecret : (input.appSecret ?? "").trim();
    run(
      `UPDATE mini_program_config
          SET app_id = ?, app_secret = ?, mch_id = ?, mch_key = ?, enabled = ?, updated_at = ?
        WHERE hotel_id = ?`,
      [
        input.appId === undefined ? prev.appId : input.appId.trim(),
        secret,
        input.mchId === undefined ? prev.mchId : input.mchId.trim(),
        input.mchKey === undefined ? prev.mchKey : input.mchKey.trim(),
        input.enabled === undefined ? (prev.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        now,
        hotelId,
      ]
    );
  }

  return getMiniProgramConfig(hotelId) ?? {
    hotelId,
    appId: "",
    appSecret: "",
    mchId: "",
    mchKey: "",
    enabled: false,
    updatedAt: now,
  };
}

/** AppID 打码：wx1234567890abcd → wx12****abcd（页面展示用，避免完整凭据出现在日志/截图里） */
export function maskAppId(appId: string): string {
  const v = (appId ?? "").trim();
  if (!v) return "";
  if (v.length <= 6) return `${v.slice(0, 2)}****`;
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

/** 配置状态（页面顶部「已配置 / 未配置」徽标用） */
export type MiniProgramConfigStatus = {
  /** 有配置行（保存过） */
  saved: boolean;
  /** AppID / AppSecret 都填了 */
  configured: boolean;
  /** 启用开关打开 */
  enabled: boolean;
  /** 打码后的 AppID，未填为空串 */
  appIdMasked: string;
  /** 是否填了商户号（在线支付用） */
  hasMch: boolean;
  updatedAt: string | null;
};

/**
 * 计算配置状态。
 *
 * 「已配置」的判定必须同时满足 AppID + AppSecret 非空：
 * 只有 AppID 时调 jscode2session 一定会失败（微信返回 invalid appsecret），
 * 页面上显示「已配置」会误导管理员去排查小程序代码。
 */
export function getMiniProgramConfigStatus(hotelId: number): MiniProgramConfigStatus {
  const cfg = getMiniProgramConfig(hotelId);
  if (!cfg) {
    return { saved: false, configured: false, enabled: false, appIdMasked: "", hasMch: false, updatedAt: null };
  }
  return {
    saved: true,
    configured: Boolean(cfg.appId && cfg.appSecret),
    enabled: cfg.enabled,
    appIdMasked: maskAppId(cfg.appId),
    hasMch: Boolean(cfg.mchId && cfg.mchKey),
    updatedAt: cfg.updatedAt,
  };
}
