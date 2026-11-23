/**
 * 渠道直连适配器验收（整改清单 F1）
 *
 * 验证目标：
 *   1. 注册表：ctrip / meituan / fliggy / douyin / sandbox 都能被 getAdapter 拿到，
 *      都实现了 ChannelAdapter 的 4 个方法，label 非空；
 *      没有直连能力的渠道（qunar / elong / offline / direct / meituan_homestay）
 *      由沙箱承接且 label 注明「无直连能力」。
 *   2. 沙箱行为：testConnection 固定 12ms；pushRates 正常库存 accepted、负库存 rejected
 *      （reason 原文「库存不能为负」）；pullOrders 空数组且不造单；pushOrderStatus 接受。
 *   3. 沙箱幂等：连跑两次结果完全一致；不写任何业务数据（channel_orders / bookings /
 *      channel_sync_logs / channels.last_sync_at 前后一致）。
 *   4. 凭据判定：buildChannelConfig 默认值（无 app_secret 默认沙箱）、isConfigured 三种场景。
 *   5. 真实适配器在无凭据 / 掩码凭据时**不发请求**；抖音不支持状态回传时诚实返回 UNSUPPORTED。
 *   6. 统一入口 invokeWithLog：找不到渠道 / 渠道停用 → NOT_CONFIGURED（不调适配器）并落日志；
 *      成功日志带耗时；连续失败 retry_count 递增；日志在测试结束后清理干净。
 *   7. 全程不发起真实网络请求：monkey-patch globalThis.fetch 计数，最后断言为 0。
 *
 * 运行：node scripts/test-channel-adapters.mjs
 * 环境：Node ≥ 22.18（原生剥离 TS 类型）+ registerHooks 解析 `@/` 别名；
 *       本机 Node 24.22.3 已验证通过。
 * 说明：脚本只在 data/pms.db 里写少量带 ACCEPTANCE_ 前缀的同步日志用于验证 invokeWithLog，
 *       结束前删除并恢复 channels.last_sync_at；不碰任何业务表。
 */

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
const DB_FILE = path.join(ROOT, "data", "pms.db");

let pass = 0;
let fail = 0;
let skipped = 0;

const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

/*
 * 合法的跳过：只用于「环境 / 上游未就绪」这类客观限制（渠道沙箱未配密钥等），
 * 跳过数会打进最后一行汇总（通过 X / 失败 Y / 跳过 Z），失败数仍为 0 才退出 0。
 * 注意：任何断言本身出问题都必须走 check(false)，不许用 skip 掩盖。
 */
const skip = (name, reason = "") => {
  skipped += 1;
  console.log(`⏭️ ${name}${reason ? `（跳过：${reason}）` : ""}`);
};

/** Node 在 .ts 上会提示「package.json 没有 type: module」，属于噪音，过滤掉 */
process.on("warning", (w) => {
  if (w && w.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(`${w?.name ?? "Warning"}: ${w?.message ?? w}`);
});

/* ============================================================ 禁止真实网络 */

let fetchCalls = 0;
globalThis.fetch = (..._args) => {
  fetchCalls += 1;
  return Promise.reject(new Error("验收脚本禁止真实网络请求，fetch 已被拦截"));
};

/* 让 Node 能解析 Next 的 `@/` 路径别名（指向项目 src 目录） */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = /\.(ts|tsx|js|mjs)$/.test(rel) ? rel : `${rel}.ts`;
      return next(new URL(`../src/${file}`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

/* ============================================================ 载入模块 */

const { buildChannelConfig, isConfigured } = await import("../src/lib/channels/types.ts");
const sandboxMod = await import("../src/lib/channels/sandbox.ts");
const { SandboxAdapter } = sandboxMod;
const { getAdapter, listAdapters, isDirectChannel, ADAPTERS } = await import(
  "../src/lib/channels/index.ts"
);
const {
  httpStatusFailure,
  readBizEnvelope,
  signParams,
  canonicalParams,
  resolveEndpoint,
  isMaskedSecret,
  missingCredentials,
  diffNights,
  truncate,
} = await import("../src/lib/channels/common.ts");
const { invokeWithLog, CHANNEL_ACTION } = await import("../src/lib/channels/invoke.ts");

const DIRECT_TYPES = ["ctrip", "meituan", "fliggy", "douyin"];
const INDIRECT_TYPES = ["qunar", "elong", "offline", "direct", "meituan_homestay"];

/* ============================================================ 数据库快照 */

let db = null;
try {
  db = new DatabaseSync(DB_FILE, { readOnly: true });
} catch {
  db = null;
}

const tableCount = (table) => {
  if (!db) return null;
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
  } catch {
    return null;
  }
};

const snapshotBusiness = () => ({
  channel_orders: tableCount("channel_orders"),
  bookings: tableCount("bookings"),
  channel_sync_logs: tableCount("channel_sync_logs"),
});

/* ============================================================ 测试用配置 */

const baseRow = (over = {}) => ({
  id: 1,
  hotel_id: 1,
  channel_type: "ctrip",
  name: null,
  store_id: null,
  app_key: null,
  app_secret: null,
  enabled: 1,
  auto_import: 0,
  commission: null,
  oversell: 0,
  ...over,
});

const cfgOf = (over = {}) =>
  buildChannelConfig(
    baseRow({
      store_id: "STORE-ACCEPTANCE",
      app_key: "app-key-placeholder",
      app_secret: "secret-placeholder",
      ...over,
    })
  );

const clone = (value) => JSON.parse(JSON.stringify(value));

/* ============================================================ 一、注册表 */

console.log("\n=== 一、注册表与接口完整性 ===");

for (const type of [...DIRECT_TYPES, "sandbox"]) {
  const adapter = getAdapter(type);
  check(`getAdapter("${type}") 能拿到适配器且 type 匹配`, Boolean(adapter) && adapter.type === type);
}

check(
  "getAdapter 对 4 家直连渠道都返回非沙箱实现",
  DIRECT_TYPES.every((type) => {
    const adapter = getAdapter(type);
    return adapter instanceof Object && !(adapter instanceof SandboxAdapter);
  })
);
check("getAdapter(\"sandbox\") 返回 SandboxAdapter", getAdapter("sandbox") instanceof SandboxAdapter);

for (const type of [...DIRECT_TYPES, "sandbox"]) {
  const adapter = getAdapter(type);
  const methods = ["testConnection", "pushRates", "pullOrders", "pushOrderStatus"];
  const missing = methods.filter((m) => typeof adapter[m] !== "function");
  check(`${type} 实现了 4 个适配器方法`, missing.length === 0, `缺少 ${missing.join(",")}`);
}

for (const type of [...DIRECT_TYPES, "sandbox"]) {
  const adapter = getAdapter(type);
  check(`${type} 的 label 非空`, typeof adapter.label === "string" && adapter.label.trim() !== "");
}

check(
  "ADAPTERS 注册表包含 4 家直连 + sandbox",
  [...DIRECT_TYPES, "sandbox"].every((type) => Boolean(ADAPTERS[type]))
);
check(
  "isDirectChannel 只对 4 家直连渠道为 true",
  DIRECT_TYPES.every((type) => isDirectChannel(type)) &&
    ["qunar", "offline", "direct", "sandbox"].every((type) => !isDirectChannel(type))
);

for (const type of INDIRECT_TYPES) {
  const adapter = getAdapter(type);
  check(
    `${type} 走沙箱且 label 注明「无直连能力」`,
    adapter instanceof SandboxAdapter && adapter.label.includes("无直连能力"),
    adapter.label
  );
}

const unknownAdapter = getAdapter("some-new-channel");
check(
  "未知渠道类型兜底到沙箱（label 带原类型）",
  unknownAdapter instanceof SandboxAdapter &&
    unknownAdapter.type === "some-new-channel" &&
    unknownAdapter.label.includes("无直连能力")
);

const listed = listAdapters();
check("listAdapters 返回非空清单", listed.length >= 10);
check(
  "listAdapters 里 direct 标记与 isDirectChannel 一致",
  listed.every((item) => item.direct === isDirectChannel(item.type))
);
check(
  "listAdapters 每条 label 都非空且不重复",
  listed.every((item) => typeof item.label === "string" && item.label.trim() !== "") &&
    new Set(listed.map((item) => item.type)).size === listed.length
);
check(
  "listAdapters 包含 sandbox 与全部已知无直连渠道",
  ["sandbox", ...INDIRECT_TYPES].every((type) => listed.some((item) => item.type === type))
);

/* ============================================================ 二、沙箱行为 */

console.log("\n=== 二、沙箱行为与幂等 ===");

const sandbox = getAdapter("sandbox");
const sandboxCfg = cfgOf({ sandbox: 1, id: 999, channel_type: "sandbox" });

const normalRows = [
  { channelRoomTypeCode: "RT-STD", date: "2026-12-01", allotment: 5, price: 399, closed: false },
  { channelRoomTypeCode: "RT-DLX", date: "2026-12-02", allotment: 0, price: 599, closed: true },
];
const negativeRow = {
  channelRoomTypeCode: "RT-NEG",
  date: "2026-12-03",
  allotment: -2,
  price: 299,
  closed: false,
};

const before = snapshotBusiness();
const beforeLastSync = db
  ? (() => {
      try {
        return db.prepare("SELECT last_sync_at FROM channels WHERE id = 1").get()?.last_sync_at ?? null;
      } catch {
        return null;
      }
    })()
  : null;

const tc1 = await sandbox.testConnection(sandboxCfg);
check(
  "沙箱 testConnection 固定 12ms 且标注未连接真实渠道",
  tc1.ok === true && tc1.data.latencyMs === 12 && tc1.data.message.includes("沙箱"),
  JSON.stringify(tc1)
);

const rateNormal = await sandbox.pushRates(sandboxCfg, normalRows);
check(
  "沙箱 pushRates 正常库存全部 accepted（含关房）",
  rateNormal.ok === true && rateNormal.data.accepted === 2 && rateNormal.data.rejected.length === 0,
  JSON.stringify(rateNormal)
);

const rateNegative = await sandbox.pushRates(sandboxCfg, [negativeRow]);
check(
  "沙箱 pushRates 负库存 rejected 且 reason=库存不能为负",
  rateNegative.ok === true &&
    rateNegative.data.accepted === 0 &&
    rateNegative.data.rejected.length === 1 &&
    rateNegative.data.rejected[0].reason === "库存不能为负",
  JSON.stringify(rateNegative)
);
check(
  "沙箱 rejected 能定位到房型+日期（code = 房型@营业日）",
  rateNegative.ok === true && rateNegative.data.rejected[0].code === "RT-NEG@2026-12-03",
  rateNegative.ok ? rateNegative.data.rejected[0].code : ""
);

const rateMixed = await sandbox.pushRates(sandboxCfg, [...normalRows, negativeRow]);
check(
  "沙箱 pushRates 混合库存只拒绝负库存那一行",
  rateMixed.ok === true &&
    rateMixed.data.accepted === 2 &&
    rateMixed.data.rejected.length === 1,
  JSON.stringify(rateMixed)
);

const pulled = await sandbox.pullOrders(sandboxCfg, "2026-11-01T00:00:00Z");
check(
  "沙箱 pullOrders 返回空数组（不造订单）",
  pulled.ok === true && Array.isArray(pulled.data) && pulled.data.length === 0,
  JSON.stringify(pulled)
);
check(
  "沙箱拉单说明文案指向 channel-orders/actions.ts 生成器",
  typeof sandboxMod.SANDBOX_PULL_NOTE === "string" &&
    sandboxMod.SANDBOX_PULL_NOTE.includes("channel-orders/actions.ts")
);

for (const status of ["CONFIRMED", "CHECKED_IN", "NOSHOW", "CANCELLED"]) {
  const res = await sandbox.pushOrderStatus(sandboxCfg, "SANDBOX-ORDER-1", status);
  check(
    `沙箱 pushOrderStatus(${status}) accepted`,
    res.ok === true && res.data.accepted === true,
    JSON.stringify(res)
  );
}

/* 幂等：同输入连跑两次，结果完全一致 */
const runOnce = async () => ({
  tc: await sandbox.testConnection(sandboxCfg),
  rates: await sandbox.pushRates(sandboxCfg, [...normalRows, negativeRow]),
  orders: await sandbox.pullOrders(sandboxCfg, "2026-11-01T00:00:00Z"),
  status: await sandbox.pushOrderStatus(sandboxCfg, "SANDBOX-ORDER-1", "CONFIRMED"),
});
const firstRun = await runOnce();
const secondRun = await runOnce();
check("沙箱幂等：连跑两次结果完全一致", JSON.stringify(firstRun) === JSON.stringify(secondRun));

const afterSandbox = snapshotBusiness();
if (before === null) {
  skip("沙箱不写任何业务数据（数据库不可读）");
} else {
  check(
    "沙箱不写任何业务数据（channel_orders / bookings / channel_sync_logs 前后一致）",
    afterSandbox !== null &&
      before.channel_orders === afterSandbox.channel_orders &&
      before.bookings === afterSandbox.bookings &&
      before.channel_sync_logs === afterSandbox.channel_sync_logs,
    `${JSON.stringify(before)} → ${JSON.stringify(afterSandbox)}`
  );
}
const afterSandboxLastSync = db
  ? (() => {
      try {
        return db.prepare("SELECT last_sync_at FROM channels WHERE id = 1").get()?.last_sync_at ?? null;
      } catch {
        return null;
      }
    })()
  : null;
check(
  "沙箱不刷新 channels.last_sync_at（无副作用）",
  before !== null ? beforeLastSync === afterSandboxLastSync : true,
  `${String(beforeLastSync)} → ${String(afterSandboxLastSync)}`
);

/* ============================================================ 三、配置与凭据 */

console.log("\n=== 三、buildChannelConfig 默认值与 isConfigured ===");

const noSecretCfg = buildChannelConfig(baseRow());
check("无 app_secret 时 sandbox 默认 true", noSecretCfg.sandbox === true);
check("name 缺省时回退为 channel_type", noSecretCfg.name === "ctrip");
check("commission 缺省为 0", noSecretCfg.commission === 0);
check("endpoint 缺省为 null", noSecretCfg.endpoint === null);
check(
  "enabled / auto_import 数字转布尔",
  buildChannelConfig(baseRow({ enabled: 1, auto_import: 1 })).enabled === true &&
    buildChannelConfig(baseRow({ enabled: 0, auto_import: 0 })).enabled === false &&
    buildChannelConfig(baseRow({ enabled: 1, auto_import: 1 })).autoImport === true
);

const withSecretCfg = buildChannelConfig(baseRow({ app_secret: "secret-placeholder" }));
check("有 app_secret 时 sandbox 默认 false", withSecretCfg.sandbox === false);
check(
  "显式 sandbox 标记优先于默认推导",
  buildChannelConfig(baseRow({ app_secret: "secret-placeholder", sandbox: 1 })).sandbox === true &&
    buildChannelConfig(baseRow({ sandbox: 0 })).sandbox === false
);

check(
  "isConfigured：无凭据 + 非沙箱 → false",
  isConfigured(cfgOf({ store_id: null, app_key: null, app_secret: "secret-placeholder", sandbox: 0 })) ===
    false
);
check(
  "isConfigured：凭据齐全 + 非沙箱 → true",
  isConfigured(cfgOf({ sandbox: 0 })) === true
);
check(
  "isConfigured：enabled=0 → false",
  isConfigured(buildChannelConfig(baseRow({ enabled: 0, app_secret: "secret-placeholder", sandbox: 0 }))) ===
    false
);
check(
  "isConfigured：沙箱模式无凭据也视为可用",
  isConfigured(buildChannelConfig(baseRow())) === true
);
check(
  "isConfigured：缺 appKey 即使有 secret 也是 false",
  isConfigured(cfgOf({ app_key: null, sandbox: 0 })) === false
);

/* ============================================================ 四、真实适配器无凭据分支 */

console.log("\n=== 四、真实适配器的无凭据 / 掩码凭据分支 ===");

const sandboxCfgOf = (type) => cfgOf({ channel_type: type, sandbox: 1 });
const emptyCredCfgOf = (type) =>
  cfgOf({ channel_type: type, sandbox: 0, store_id: null, app_key: null, app_secret: null });
const maskedCredCfgOf = (type) =>
  cfgOf({ channel_type: type, sandbox: 0, app_secret: "••••••••" });
const fullCredCfgOf = (type) => cfgOf({ channel_type: type, sandbox: 0 });

for (const type of DIRECT_TYPES) {
  const adapter = getAdapter(type);
  const cfg = sandboxCfgOf(type);
  const results = [
    await adapter.testConnection(cfg),
    await adapter.pushRates(cfg, [negativeRow]),
    await adapter.pullOrders(cfg, "2026-11-01T00:00:00Z"),
    await adapter.pushOrderStatus(cfg, "ORDER-1", "CONFIRMED"),
  ];
  check(
    `${type} 在沙箱模式走沙箱分支（4 个方法全部 ok）`,
    results.every((r) => r.ok === true),
    results.map((r) => (r.ok ? "ok" : r.code)).join(",")
  );
}

for (const type of DIRECT_TYPES) {
  const adapter = getAdapter(type);
  const cfg = emptyCredCfgOf(type);
  const results = [
    await adapter.testConnection(cfg),
    await adapter.pushRates(cfg, [negativeRow]),
    await adapter.pullOrders(cfg, "2026-11-01T00:00:00Z"),
  ];
  const statusRes = await adapter.pushOrderStatus(cfg, "ORDER-1", "CONFIRMED");
  const credentialsBlocked = results.every((r) => r.ok === false && r.code === "NOT_CONFIGURED");
  // 抖音的订单状态回传是「明确不支持」的操作，与凭据是否齐全无关，应保持 UNSUPPORTED
  const statusBlocked =
    type === "douyin"
      ? statusRes.ok === false && statusRes.code === "UNSUPPORTED"
      : statusRes.ok === false && statusRes.code === "NOT_CONFIGURED";
  check(
    `${type} 无凭据 + 非沙箱 → 凭据拦截/明确不支持（不发请求）`,
    credentialsBlocked && statusBlocked,
    [...results, statusRes].map((r) => (r.ok ? "ok" : r.code)).join(",")
  );
}

for (const type of DIRECT_TYPES) {
  const adapter = getAdapter(type);
  const res = await adapter.testConnection(maskedCredCfgOf(type));
  check(
    `${type} 掩码 appSecret → NOT_CONFIGURED（不拿占位值去撞网关）`,
    res.ok === false && res.code === "NOT_CONFIGURED",
    JSON.stringify(res)
  );
}

const douyinStatus = await getAdapter("douyin").pushOrderStatus(
  fullCredCfgOf("douyin"),
  "ORDER-1",
  "CONFIRMED"
);
check(
  "抖音推送订单状态如实返回 UNSUPPORTED",
  douyinStatus.ok === false && douyinStatus.code === "UNSUPPORTED",
  JSON.stringify(douyinStatus)
);

check(
  "真实适配器在以上所有分支都没有发起 fetch",
  fetchCalls === 0,
  `fetch 调用次数 = ${fetchCalls}`
);

/* ============================================================ 五、公共设施纯函数 */

console.log("\n=== 五、错误归一与签名工具（纯函数） ===");

check("HTTP 401 → AUTH_FAILED", httpStatusFailure(401).code === "AUTH_FAILED");
check("HTTP 403 → AUTH_FAILED", httpStatusFailure(403).code === "AUTH_FAILED");
check("HTTP 429 → RATE_LIMITED", httpStatusFailure(429).code === "RATE_LIMITED");
check("HTTP 500 → NETWORK", httpStatusFailure(500).code === "NETWORK");
check("HTTP 503 → NETWORK", httpStatusFailure(503).code === "NETWORK");
check("HTTP 400 → CHANNEL_ERROR", httpStatusFailure(400).code === "CHANNEL_ERROR");

const envOk = readBizEnvelope({ code: 0, message: "ok", data: { list: [] } });
check("业务包裹 code=0 判定成功", envOk.success === true && Array.isArray(envOk.data.list));
const envFail = readBizEnvelope({ code: "1001", message: "房型不存在" });
check(
  "业务包裹非成功码判定失败且保留渠道码",
  envFail.success === false && envFail.code === "1001" && envFail.message.includes("房型不存在")
);
const envBad = readBizEnvelope("<html>502 Bad Gateway</html>");
check("非 JSON 对象响应判定失败", envBad.success === false && envBad.code === "INVALID_RESPONSE");
const envExplicit = readBizEnvelope({ success: false, code: 0, message: "显式失败" });
check("显式 success=false 优先于成功码", envExplicit.success === false);

const canonical = canonicalParams({ b: 2, a: 1, sign: "should-be-ignored", c: undefined });
check("canonicalParams 按 key 排序并排除 sign/undefined", canonical === "a=1&b=2", canonical);

const sig1 = signParams({ appKey: "k", timestamp: "t" }, "secret-placeholder");
const sig2 = signParams({ appKey: "k", timestamp: "t" }, "secret-placeholder");
const sig3 = signParams({ appKey: "k", timestamp: "t" }, "another-secret");
check("签名是 64 位十六进制（HMAC-SHA256）", /^[0-9a-f]{64}$/.test(sig1), sig1);
check("同参数同密钥签名稳定", sig1 === sig2);
check("换密钥签名变化", sig1 !== sig3);

const endpointCfg = cfgOf({ endpoint: "https://test-gateway.example.invalid/base/" });
check(
  "endpoint 覆盖默认网关（去掉多余斜杠后拼接路径）",
  resolveEndpoint(endpointCfg, "https://default.invalid", "/v1/ping") ===
    "https://test-gateway.example.invalid/base/v1/ping",
  resolveEndpoint(endpointCfg, "https://default.invalid", "/v1/ping")
);
check(
  "endpoint 覆盖时 path 为空直接返回 base",
  resolveEndpoint(endpointCfg, "https://default.invalid", "") ===
    "https://test-gateway.example.invalid/base"
);

check("isMaskedSecret 识别圆点掩码", isMaskedSecret("••••••••") === true);
check("isMaskedSecret 识别星号掩码", isMaskedSecret("******") === true);
check("isMaskedSecret 不误伤普通占位值", isMaskedSecret("secret-placeholder") === false);
check(
  "missingCredentials 返回中文字段名",
  missingCredentials(cfgOf({ store_id: null, app_key: null })).join("、").includes("门店")
);
check("diffNights 计算间隔", diffNights("2026-12-01", "2026-12-04") === 3);
check("diffNights 对倒挂日期返回 0", diffNights("2026-12-04", "2026-12-01") === 0);
check("truncate 超长文本加省略号", truncate("abcdef", 3).startsWith("abc") && truncate("abcdef", 3).includes("…"));

/* ============================================================ 六、invokeWithLog */

console.log("\n=== 六、invokeWithLog 统一入口 ===");

let writable = null;
try {
  writable = new DatabaseSync(DB_FILE);
} catch {
  writable = null;
}

const totalChecksBeforeInvoke = pass + fail;

if (!writable) {
  skip("invokeWithLog 行为验证", "data/pms.db 不存在或不可写");
} else {
  const probeActions = [
    "ACCEPTANCE_NOT_FOUND",
    "ACCEPTANCE_WRONG_HOTEL",
    "ACCEPTANCE_DISABLED",
    "ACCEPTANCE_OK",
    "ACCEPTANCE_RETRY",
  ];

  /* channels.last_sync_at 是演示数据：先整表备份，测试结束统一还原（invoke 成功/失败都会刷新它） */
  const lastSyncBackup = new Map();
  try {
    for (const row of writable.prepare("SELECT id, last_sync_at FROM channels").all()) {
      lastSyncBackup.set(Number(row.id), row.last_sync_at ?? null);
    }
  } catch {
    // 备份失败时仍会跑测试，只是最后无法断言 last_sync_at 复原
  }

  const cleanup = () => {
    try {
      for (const action of probeActions) {
        writable.prepare("DELETE FROM channel_sync_logs WHERE action = ?").run(action);
      }
    } catch {
      // 清理失败不影响验收结果（只会留下几条带 ACCEPTANCE_ 前缀的诊断日志）
    }
    try {
      const restore = writable.prepare("UPDATE channels SET last_sync_at = ? WHERE id = ?");
      for (const [id, value] of lastSyncBackup) restore.run(value, id);
    } catch {
      // 还原失败不影响渠道适配器本身的验收结论
    }
  };

  /* 先清掉历史遗留的验收探针，避免重试计数受上次运行影响 */
  cleanup();

  const probeLog = (action) => {
    try {
      return writable
        .prepare("SELECT * FROM channel_sync_logs WHERE action = ? ORDER BY id DESC LIMIT 1")
        .get(action);
    } catch {
      return undefined;
    }
  };

  /* 6.1 渠道不存在：不调 fn、返回 NOT_CONFIGURED、落 FAILED 日志 */
  let called = 0;
  const notFound = await invokeWithLog(999999, 999999, "ACCEPTANCE_NOT_FOUND", async () => {
    called += 1;
    return { ok: true, data: null };
  });
  check(
    "找不到渠道 → NOT_CONFIGURED",
    notFound.ok === false && notFound.code === "NOT_CONFIGURED",
    JSON.stringify(notFound)
  );
  check("找不到渠道时不调用 fn", called === 0);
  const notFoundLog = probeLog("ACCEPTANCE_NOT_FOUND");
  check(
    "找不到渠道也留一条 FAILED 日志（error_code=NOT_CONFIGURED）",
    Boolean(notFoundLog) &&
      notFoundLog.status === "FAILED" &&
      notFoundLog.error_code === "NOT_CONFIGURED",
    JSON.stringify(notFoundLog)
  );

  /* 6.2 渠道 id 存在但 hotel_id 不匹配：租户隔离生效 */
  const anyChannel = writable
    .prepare("SELECT id, hotel_id FROM channels WHERE enabled = 1 ORDER BY id LIMIT 1")
    .get();
  let calledWrongHotel = 0;
  const wrongHotel = await invokeWithLog(
    Number(anyChannel?.id ?? 0),
    999999,
    "ACCEPTANCE_WRONG_HOTEL",
    async () => {
      calledWrongHotel += 1;
      return { ok: true, data: null };
    }
  );
  check(
    "channel_id 与 hotel_id 不匹配 → NOT_CONFIGURED（租户隔离）",
    wrongHotel.ok === false && wrongHotel.code === "NOT_CONFIGURED" && calledWrongHotel === 0,
    JSON.stringify(wrongHotel)
  );

  /* 6.3 渠道停用：isConfigured 拦下，不调适配器 */
  const disabled = writable
    .prepare("SELECT id, hotel_id, channel_type FROM channels WHERE enabled = 0 ORDER BY id LIMIT 1")
    .get();
  if (!disabled) {
    skip("渠道停用 → NOT_CONFIGURED", "库里没有 enabled=0 的渠道");
  } else {
    let calledDisabled = 0;
    const disabledRes = await invokeWithLog(
      Number(disabled.id),
      Number(disabled.hotel_id),
      "ACCEPTANCE_DISABLED",
      async () => {
        calledDisabled += 1;
        return { ok: true, data: null };
      }
    );
    check(
      "渠道停用 → NOT_CONFIGURED 且不调用 fn",
      disabledRes.ok === false &&
        disabledRes.code === "NOT_CONFIGURED" &&
        calledDisabled === 0,
      JSON.stringify(disabledRes)
    );
    const disabledLog = probeLog("ACCEPTANCE_DISABLED");
    check(
      "渠道停用的失败日志带上渠道类型与错误码",
      Boolean(disabledLog) &&
        disabledLog.channel_type === disabled.channel_type &&
        disabledLog.error_code === "NOT_CONFIGURED" &&
        disabledLog.message.includes("NOT_CONFIGURED"),
      JSON.stringify(disabledLog)
    );
  }

  /* 6.4 成功路径：日志带耗时、retry_count 归零、刷新 last_sync_at */
  const enabledChannel = writable
    .prepare(
      `SELECT id, hotel_id, last_sync_at FROM channels
        WHERE enabled = 1 AND store_id IS NOT NULL AND app_key IS NOT NULL AND app_secret IS NOT NULL
        ORDER BY id LIMIT 1`
    )
    .get();
  if (!enabledChannel) {
    skip("成功路径日志与 last_sync_at", "库里没有启用的直连渠道");
  } else {
    const originalLastSync = enabledChannel.last_sync_at ?? null;
    const okRes = await invokeWithLog(
      Number(enabledChannel.id),
      Number(enabledChannel.hotel_id),
      "ACCEPTANCE_OK",
      async () => ({ ok: true, data: { accepted: 2, rejected: [] } })
    );
    check("成功路径返回 ok", okRes.ok === true, JSON.stringify(okRes));
    const okLog = probeLog("ACCEPTANCE_OK");
    check(
      "成功日志 status=SUCCESS 且 message 带耗时",
      Boolean(okLog) &&
        okLog.status === "SUCCESS" &&
        /耗时 \d+ms/.test(String(okLog.message)) &&
        Number(okLog.retry_count) === 0,
      JSON.stringify(okLog)
    );
    check(
      "成功日志带动作名（自定义动作按原样记录）",
      Boolean(okLog) && String(okLog.message).includes("ACCEPTANCE_OK"),
      String(okLog?.message ?? "")
    );
    const synced = writable
      .prepare("SELECT last_sync_at FROM channels WHERE id = ?")
      .get(Number(enabledChannel.id));
    check(
      "真正调用过适配器后刷新 channels.last_sync_at",
      Boolean(synced?.last_sync_at) && synced.last_sync_at !== originalLastSync,
      String(synced?.last_sync_at ?? "")
    );
    /* 还原放到 6.6 的统一 cleanup：6.5 的重试测试还会再刷新一次 last_sync_at */
  }

  /* 6.5 连续失败：error_code 归一 + retry_count 递增 */
  const retryChannel = enabledChannel ?? anyChannel;
  if (!retryChannel) {
    skip("连续失败 retry_count 递增", "库里没有可用渠道");
  } else {
    const failFn = async () => ({ ok: false, code: "NETWORK", message: "模拟网络失败" });
    const firstFail = await invokeWithLog(
      Number(retryChannel.id),
      Number(retryChannel.hotel_id),
      "ACCEPTANCE_RETRY",
      failFn
    );
    const firstLogRow = probeLog("ACCEPTANCE_RETRY");
    const secondFail = await invokeWithLog(
      Number(retryChannel.id),
      Number(retryChannel.hotel_id),
      "ACCEPTANCE_RETRY",
      failFn
    );
    const secondLogRow = probeLog("ACCEPTANCE_RETRY");
    check(
      "失败路径返回归一化错误码 NETWORK",
      firstFail.ok === false && firstFail.code === "NETWORK",
      JSON.stringify(firstFail)
    );
    check(
      "首次失败日志 retry_count=0",
      Boolean(firstLogRow) &&
        firstLogRow.status === "FAILED" &&
        firstLogRow.error_code === "NETWORK" &&
        Number(firstLogRow.retry_count) === 0,
      JSON.stringify(firstLogRow)
    );
    check(
      "连续第二次失败 retry_count=1（重试计数生效）",
      secondFail.ok === false &&
        Number(secondLogRow?.retry_count) === 1 &&
        secondLogRow.error_code === "NETWORK",
      JSON.stringify(secondLogRow)
    );
    check(
      "失败日志 message 带具体原因",
      Boolean(secondLogRow) && String(secondLogRow.message).includes("模拟网络失败"),
      String(secondLogRow?.message ?? "")
    );
  }

  /* 6.6 清理验收日志，恢复业务表原状 */
  cleanup();
  const remainingProbe = writable
    .prepare("SELECT COUNT(*) AS c FROM channel_sync_logs WHERE action LIKE 'ACCEPTANCE_%'")
    .get();
  check(
    "验收探针日志已清理干净（不污染 channel_sync_logs）",
    Number(remainingProbe?.c ?? 0) === 0,
    String(remainingProbe?.c)
  );

  let lastSyncRestored = true;
  try {
    for (const row of writable.prepare("SELECT id, last_sync_at FROM channels").all()) {
      const expected = lastSyncBackup.get(Number(row.id)) ?? null;
      if ((row.last_sync_at ?? null) !== expected) lastSyncRestored = false;
    }
  } catch {
    lastSyncRestored = false;
  }
  check("channels.last_sync_at 已还原（测试不留副作用）", lastSyncRestored);
}

const invokeChecks = pass + fail - totalChecksBeforeInvoke;
check(
  "invokeWithLog 已导出且动作常量齐全",
  typeof invokeWithLog === "function" &&
    ["TEST_CONNECTION", "PUSH_RATES", "PULL_ORDERS", "PUSH_STATUS"].every(
      (key) => CHANNEL_ACTION[key] === key
    )
);
check("invokeWithLog 至少完成一组行为断言", invokeChecks > 0, `本段断言数 ${invokeChecks}`);

/* ============================================================ 七、源码静态检查 */

console.log("\n=== 七、源码静态检查 ===");

const readSrc = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const channelFiles = [
  "src/lib/channels/common.ts",
  "src/lib/channels/sandbox.ts",
  "src/lib/channels/ctrip.ts",
  "src/lib/channels/meituan.ts",
  "src/lib/channels/fliggy.ts",
  "src/lib/channels/douyin.ts",
  "src/lib/channels/index.ts",
  "src/lib/channels/invoke.ts",
];
check(
  "渠道模块文件齐全",
  channelFiles.every((rel) => readSrc(rel).length > 0),
  channelFiles.filter((rel) => readSrc(rel).length === 0).join(",")
);

const adapterFiles = channelFiles.slice(2, 6);
check(
  "4 家适配器注释里写明「联调 / 核对」",
  adapterFiles.every((rel) => {
    const src = readSrc(rel);
    return src.includes("联调") && src.includes("核对");
  })
);
check(
  "4 家适配器都使用 AbortSignal 超时（经 common.requestJson）",
  adapterFiles.every((rel) => {
    const src = readSrc(rel);
    return src.includes("requestJson") || src.includes("postSignedJson") || src.includes("topRequest");
  })
);
check("common.ts 用 node:crypto 做签名（不引入新依赖）", readSrc("src/lib/channels/common.ts").includes("node:crypto"));
check(
  "common.ts 的 fetch 统一挂 AbortSignal.timeout",
  readSrc("src/lib/channels/common.ts").includes("AbortSignal.timeout")
);
check(
  "invoke.ts 按 (id, hotel_id) 读渠道配置并写同步日志",
  readSrc("src/lib/channels/invoke.ts").includes("WHERE id = ? AND hotel_id = ?") &&
    readSrc("src/lib/channels/invoke.ts").includes("channel_sync_logs") &&
    readSrc("src/lib/channels/invoke.ts").includes("last_sync_at")
);
check("抖音适配器对状态回传返回 UNSUPPORTED", readSrc("src/lib/channels/douyin.ts").includes("UNSUPPORTED"));

/* 不得出现看起来像真实凭据的字面量（配置一律从 channels 表读） */
const credentialPatterns = [
  /sk-[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /app_secret\s*=\s*["'][^"']{12,}["']/,
  /app_secret\s*[:=]\s*["'][A-Za-z0-9+/]{24,}["']/,
];
const leaked = [];
for (const rel of channelFiles) {
  const src = readSrc(rel);
  for (const pattern of credentialPatterns) {
    if (pattern.test(src)) leaked.push(`${rel}:${pattern}`);
  }
}
check("渠道源码里没有硬编码的真实凭据字面量", leaked.length === 0, leaked.join("；"));

/* ============================================================ 八、无网络总结 */

console.log("\n=== 八、网络与数据库副作用 ===");

check(
  "全程没有发起任何真实网络请求（fetch 调用计数 = 0）",
  fetchCalls === 0,
  `fetch 调用次数 = ${fetchCalls}`
);

const finalBusiness = snapshotBusiness();
if (before === null) {
  skip("业务数据未被测试改写（数据库不可读）");
} else {
  check(
    "业务数据未被测试改写（channel_orders / bookings 前后一致）",
    finalBusiness !== null &&
      before.channel_orders === finalBusiness.channel_orders &&
      before.bookings === finalBusiness.bookings,
    `${JSON.stringify(before)} → ${JSON.stringify(finalBusiness)}`
  );
}

/* ============================================================ 收尾 */

try {
  writable?.close();
} catch {
  // 忽略关闭异常
}
try {
  db?.close();
} catch {
  // 忽略关闭异常
}

console.log("\n========================================");
console.log(`通过 ${pass} / 失败 ${fail}${skipped > 0 ? ` / 跳过 ${skipped}` : ""}`);
if (fail > 0) {
  console.log("存在失败项，请按上面的 ❌ 逐条排查。");
  process.exitCode = 1;
} else {
  console.log("渠道直连适配器验收通过（真实联调仍需渠道方凭据，见各适配器文件头）。");
}
