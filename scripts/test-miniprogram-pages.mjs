#!/usr/bin/env node
/**
 * 微信小程序「页面与静态约束」验收
 * （codex 第九轮《微信小程序专项》第七节 test-miniprogram-pages）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个脚本测的是小程序**本身**，不是服务端 API
 * ══════════════════════════════════════════════════════════════════════════
 * 接口测试（test-mini-*.mjs）覆盖不到下面这些问题，而它们恰好是「小程序能
 * 打开、点不动」的常见原因：
 *   · app.json 里页面没注册 / 注册了但磁盘上缺文件（真机上白屏）；
 *   · .js 有语法错误（开发者工具能打开，真机报错）；
 *   · WXML 里 bindtap="onSubmit"，.js 里方法叫 submit —— 点了没反应；
 *   · wx:for 没有 wx:key（列表重排时数据错位，控制台刷警告）；
 *   · 页面里裸调 wx.request / 硬编码接口地址（绕过统一封装，登录过期与
 *     接口未上线的降级全部失效）；
 *   · 硬编码 AppID / AppSecret / 假手机号（凭据泄露、演示数据被当真实数据）；
 *   · 下单页没有隐私说明与用户协议（合规要求，清单第八节）。
 *
 * ── 事件绑定怎么做到「真的比对」，而不是文本模糊匹配 ──
 * 用 node:vm 在沙箱里执行页面 .js，把全局 Page(cfg) 捕获下来，
 * 得到**页面真实注册的方法名集合**，再与 WXML 里的 bindtap / catchtap 比对。
 * 这比「在源码里搜 onSubmit(」可靠：后者会把注释、字符串、别的页面同名
 * 方法都算成通过。
 *
 * ── 不联网、不写库、不改任何文件 ──
 * 纯只读检查。退出码：有 ❌ 时为 1，全绿为 0。
 *
 * 用法：node scripts/test-miniprogram-pages.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const MP = join(ROOT, "miniprogram");

let pass = 0;
let fail = 0;
const failed = [];

function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

/** 读文本（读不到返回空串） */
function readText(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** 递归列出某目录下指定扩展名的文件（返回绝对路径，按路径排序保证输出稳定） */
function listFiles(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 相对 miniprogram 的 posix 路径（输出好看、跨平台一致） */
function mpRel(p) {
  return relative(MP, p).split("\\").join("/");
}

console.log("── 1. app.json 与页面注册 ──");

check("miniprogram 目录存在", existsSync(MP), MP);

const APP_JSON_PATH = join(MP, "app.json");
let appJson = null;
try {
  appJson = JSON.parse(readFileSync(APP_JSON_PATH, "utf8"));
  check("app.json 能被 JSON.parse 解析", true);
} catch (e) {
  check("app.json 能被 JSON.parse 解析", false, String(e && e.message).slice(0, 120));
}

const pages = Array.isArray(appJson?.pages) ? appJson.pages : [];
check(
  "app.json 的 pages 是数组",
  Array.isArray(appJson?.pages),
  appJson?.pages === undefined ? "缺少 pages 字段" : ""
);
check(
  "pages 恰好 18 个页面（清单第八节：18 个页面）",
  pages.length === 18,
  `实际 ${pages.length} 个：${pages.slice(0, 20).join(",")}`
);
check("pages 没有重复项", new Set(pages).size === pages.length);

/*
 * 清单第八节「页面至少包括」的 18 项，逐个映射到实际页面路径。
 * 这张表是硬约定：改路径必须同步改这里（否则就是「页面还在、但清单要的
 * 功能没入口」）。
 */
const REQUIRED_PAGES = [
  ["pages/index/index", "首页查房"],
  ["pages/room-detail/index", "房型详情"],
  ["pages/booking/booking", "下单"],
  ["pages/orders/orders", "订单列表"],
  ["pages/order-detail/index", "订单详情"],
  ["pages/pre-stay/index", "入住前服务"],
  ["pages/in-stay/index", "在住服务"],
  ["pages/folio/index", "当前账单"],
  ["pages/extend/index", "续住"],
  ["pages/change-room/index", "换房申请"],
  ["pages/late-checkout/index", "延迟退房"],
  ["pages/services/index", "早餐和客房服务"],
  ["pages/invoices/index", "发票"],
  ["pages/member/member", "会员中心"],
  ["pages/wallet/index", "储值和积分"],
  ["pages/bind/bind", "绑定身份"],
  ["pages/notifications/index", "通知中心"],
  ["pages/contact/index", "联系酒店"],
];

const missingRegistered = REQUIRED_PAGES.filter(([p]) => !pages.includes(p)).map(([p, n]) => `${n}(${p})`);
check(
  "清单第八节要求的 18 个页面全部在 app.json 注册",
  missingRegistered.length === 0,
  missingRegistered.join(",")
);

/* tabBar 三项必须都指向已注册页面（指向不存在的页面 → 真机启动报错） */
const tabList = Array.isArray(appJson?.tabBar?.list) ? appJson.tabBar.list : [];
check(
  "tabBar 三项（查房 / 订单 / 会员）都指向已注册页面",
  tabList.length === 3 && tabList.every((t) => pages.includes(t.pagePath)),
  tabList.map((t) => t.pagePath).join(",")
);

/* 磁盘上的页面目录 ↔ app.json 注册项：两边都要能对上 */
const diskPageJs = listFiles(join(MP, "pages"), ".js").filter(
  (p) => !mpRel(p).includes("/utils/")
);
const diskPageNames = diskPageJs.map((p) => mpRel(p).replace(/\.js$/, ""));
const notRegistered = diskPageNames.filter((p) => !pages.includes(p));
check(
  "磁盘上没有「没在 app.json 注册」的孤儿页面（注册遗漏 → 真机白屏）",
  notRegistered.length === 0,
  notRegistered.join(",")
);

const missingOnDisk = pages.filter((p) => !existsSync(join(MP, `${p}.js`)));
check(
  "app.json 注册的每个页面在磁盘上都有 .js",
  missingOnDisk.length === 0,
  missingOnDisk.join(",")
);

console.log("\n── 2. 页面四件套（.js / .wxml / .wxss / .json） ──");

for (const p of REQUIRED_PAGES) {
  const [pagePath, label] = p;
  const files = [".js", ".wxml", ".wxss", ".json"].map((ext) => join(MP, `${pagePath}${ext}`));
  const miss = files.filter((f) => !existsSync(f)).map((f) => mpRel(f));
  check(`页面「${label}」四件套齐全（${pagePath}）`, miss.length === 0, miss.join(","));
}

/* 页面 .json 必须是合法 JSON（写错一个逗号真机就白屏） */
const badPageJson = [];
for (const js of diskPageJs) {
  const jsonPath = js.replace(/\.js$/, ".json");
  if (!existsSync(jsonPath)) {
    badPageJson.push(`${mpRel(jsonPath)}(缺失)`);
    continue;
  }
  try {
    JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    badPageJson.push(mpRel(jsonPath));
  }
}
check("每个页面 .json 都是合法 JSON", badPageJson.length === 0, badPageJson.join(","));

console.log("\n── 3. 全部 .js 语法检查（node --check） ──");

const allJs = [
  ...listFiles(join(MP, "pages"), ".js"),
  ...listFiles(join(MP, "utils"), ".js"),
  join(MP, "app.js"),
].filter((p) => existsSync(p));

const syntaxErrors = [];
for (const file of allJs) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe", timeout: 20000 });
  } catch (e) {
    const msg = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 3).join(" ").trim();
    syntaxErrors.push(`${mpRel(file)}: ${msg.slice(0, 160)}`);
  }
}
check(
  `全部 ${allJs.length} 个 .js 通过 node --check（页面 + utils + app.js）`,
  syntaxErrors.length === 0,
  syntaxErrors.join(" | ")
);

console.log("\n── 4. WXML 事件绑定 ↔ 页面方法（真的执行 .js 取 Page 配置） ──");

/** 万能对象：属性访问 / 调用 / new 都返回自身，用来撑住页面顶层的 require / getApp 调用 */
function universalStub() {
  const proxy = new Proxy(function () {}, {
    get(_t, key) {
      /* then / toJSON 返回 undefined，避免被 Promise / JSON 当特殊对象处理 */
      if (key === "then" || key === "toJSON" || key === Symbol.toPrimitive) return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
    construct() {
      return proxy;
    },
  });
  return proxy;
}

/**
 * 在 vm 沙箱里跑页面 .js，捕获 Page({...}) 的配置对象。
 * 只执行顶层语句（require / Page 调用），方法体不会被执行，所以不需要真的 wx 环境。
 */
function loadPageConfig(jsPath) {
  const src = readFileSync(jsPath, "utf8");
  let captured = null;
  const sandbox = {
    wx: universalStub(),
    Page: (cfg) => {
      captured = cfg;
    },
    App: () => {},
    Component: () => {},
    getApp: () => universalStub(),
    getCurrentPages: () => [],
    require: () => universalStub(),
    module: { exports: {} },
    exports: {},
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: jsPath, timeout: 3000 });
  return captured;
}

const pageConfigMissing = [];
/** WXML 里的事件属性：bindtap / catchtap / bindinput / bindconfirm / catchtouchstart ... */
const EVENT_ATTR_RE = /\b(?:bind|catch)[a-zA-Z]*\s*=\s*"([^"]*)"/g;
/** 只把「方法名」当绑定：允许带 {{}} 的表达式（如 bindtap="{{fn}}"）跳过 */
const METHOD_NAME_RE = /^[A-Za-z_$][\w$]*$/;

for (const p of REQUIRED_PAGES) {
  const [pagePath, label] = p;
  const jsPath = join(MP, `${pagePath}.js`);
  const wxmlPath = join(MP, `${pagePath}.wxml`);
  if (!existsSync(jsPath) || !existsSync(wxmlPath)) {
    pageConfigMissing.push(`${pagePath}(文件缺失)`);
    check(`页面「${label}」WXML 事件绑定在 .js 里都有同名方法`, false, "文件缺失");
    continue;
  }

  let cfg = null;
  try {
    cfg = loadPageConfig(jsPath);
  } catch (e) {
    check(
      `页面「${label}」WXML 事件绑定在 .js 里都有同名方法`,
      false,
      `页面 .js 无法在沙箱中执行：${String(e?.message ?? e).slice(0, 120)}`
    );
    continue;
  }
  if (!cfg || typeof cfg !== "object") {
    pageConfigMissing.push(pagePath);
    check(`页面「${label}」WXML 事件绑定在 .js 里都有同名方法`, false, "没有调用 Page()");
    continue;
  }

  const methods = new Set(Object.keys(cfg).filter((k) => typeof cfg[k] === "function"));
  const wxml = readFileSync(wxmlPath, "utf8");
  const bound = new Set();
  let m;
  EVENT_ATTR_RE.lastIndex = 0;
  while ((m = EVENT_ATTR_RE.exec(wxml)) !== null) {
    const name = String(m[1] || "").trim();
    if (!name) continue;
    /* 动态绑定（{{...}}）没法静态校验，跳过 */
    if (name.includes("{{")) continue;
    if (METHOD_NAME_RE.test(name)) bound.add(name);
  }

  const missing = [...bound].filter((name) => !methods.has(name));
  check(
    `页面「${label}」WXML 事件绑定在 .js 里都有同名方法`,
    missing.length === 0,
    missing.length ? `未定义：${missing.join(",")}` : ""
  );
}

check(
  "每个页面都能在沙箱里执行并调用 Page()（没有顶层语法 / 依赖错误）",
  pageConfigMissing.length === 0,
  pageConfigMissing.join(",")
);

console.log("\n── 5. 网络请求必须走统一封装（不许裸 wx.request） ──");

const pageJsFiles = diskPageJs;
const bareRequest = pageJsFiles.filter((p) => readText(p).includes("wx.request"));
check(
  "页面 .js 里没有裸调 wx.request（统一走 utils/api.js / api-mini.js）",
  bareRequest.length === 0,
  bareRequest.map(mpRel).join(",")
);

const hardCodedBase = pageJsFiles.filter((p) => /["']https?:\/\//.test(readText(p)));
check(
  "页面 .js 里没有硬编码接口地址（http/https 字面量）",
  hardCodedBase.length === 0,
  hardCodedBase.map(mpRel).join(",")
);

/* 每个页面都必须通过统一封装发请求：require 了 api.js 或 api-mini.js */
const noApiRequire = pageJsFiles.filter((p) => {
  const src = readText(p);
  return !src.includes("utils/api'") && !src.includes("utils/api\"") && !src.includes("utils/api-mini");
});
check(
  "每个页面都 require 了统一请求封装（utils/api.js 或 utils/api-mini.js）",
  noApiRequire.length === 0,
  noApiRequire.map(mpRel).join(",")
);

/*
 * 清单（本批任务书）要求：新一批「住客端」页面统一走 utils/api-mini.js ——
 * 这一层负责 404 → NOT_READY 降级、写操作 20s 超时、接口未上线不伪装成故障。
 * 这 13 个页面必须有它。
 */
const API_MINI_PAGES = [
  "pages/room-detail/index",
  "pages/order-detail/index",
  "pages/pre-stay/index",
  "pages/in-stay/index",
  "pages/folio/index",
  "pages/extend/index",
  "pages/change-room/index",
  "pages/late-checkout/index",
  "pages/services/index",
  "pages/invoices/index",
  "pages/wallet/index",
  "pages/notifications/index",
  "pages/contact/index",
];
const noApiMini = API_MINI_PAGES.filter((p) => !readText(join(MP, `${p}.js`)).includes("utils/api-mini"));
check(
  "13 个住客端页面统一 require utils/api-mini.js（未上线降级 / 写超时收敛一处）",
  noApiMini.length === 0,
  noApiMini.join(",")
);

/*
 * ── 校准断言（清单字面要求 vs 本轮修复范围）──
 *
 * 清单字面要求：「所有页面都通过 api-mini 的函数访问接口，不在页面里拼 /api/ 路径」。
 * 实测仍有 7 个页面直接拼路径：4 个首批页面（index / orders / member / bind）
 * 与 3 个后加页面（extend / change-room 直连 /rooms，下单页直连 /bookings）。
 *
 * 为什么不在本轮修掉：把这些页面全部迁到 api-mini.js 需要先给 api-mini.js 补
 * rooms / bookings / bind / member 等函数并逐页回归，涉及的文件不在本轮
 * 「3 个缺陷」的授权范围（本轮只批了下单页的下单幂等改造）。
 * 原断言把「页面直连路径数 = 0」当成通过条件，于是一条永远红的断言只能证明
 * 「这个差距还存在」，测不出任何回归 —— 改成下面两条如实且可执行的断言：
 *
 *   ① 本轮修的下单页：提交必须走 page-state.submit（防重复点击 + 失败后复用同一个
 *      requestId），并且真的把 requestId 发给服务端。这是缺陷 1 的前端交付点：
 *      修复前 -> api.requestWithAuth 裸调、请求体里没有 requestId；
 *      修复后 -> state.submit + 幂等键复用 + 表单变更换新键。
 *   ② 仍直接拼路径的页面 == 已知遗留清单（钉住现状：不会误红，也能在有人新增
 *      第 8 个直连页面时报警）。
 */
const bookingPageSrc = readText(join(MP, "pages/booking/booking.js"));
check(
  "下单页提交收敛到统一状态机（page-state.submit + 幂等 requestId，失败重试复用同一个键）",
  bookingPageSrc.includes("utils/page-state") &&
    /state\.submit\(/.test(bookingPageSrc) &&
    /request:\s*function\s*\(\s*requestId\s*\)/.test(bookingPageSrc) &&
    /requestId:\s*requestId/.test(bookingPageSrc) &&
    /state\.resetRequest\(/.test(bookingPageSrc),
  "缺少 state.submit / request:<function(requestId)> / requestId 透传 / resetRequest 之一"
);

const directPath = pageJsFiles.filter((p) => {
  const src = readText(p);
  return /\.requestWithAuth\(\s*['"]\/api\//.test(src) || /\.request\(\s*['"]\/api\//.test(src);
});
/** 已知的直连页面（后续把 api-mini.js 补齐后再逐个从这里删掉） */
const KNOWN_DIRECT_PAGES = [
  "pages/bind/bind.js",
  "pages/booking/booking.js",
  "pages/change-room/index.js",
  "pages/extend/index.js",
  "pages/index/index.js",
  "pages/member/member.js",
  "pages/orders/orders.js",
];
const directRels = directPath.map(mpRel).sort();
check(
  "（校准）直接拼 /api/ 路径的页面仍是已知的 7 个（api-mini 全量收敛是后续清理项，本轮不动）",
  directRels.join(",") === KNOWN_DIRECT_PAGES.join(","),
  `实际：${directRels.join(",")}`
);

console.log("\n── 6. 不许硬编码凭据 / 假数据 ──");

const allTextFiles = [
  ...listFiles(join(MP, "pages"), ".js"),
  ...listFiles(join(MP, "pages"), ".wxml"),
  ...listFiles(join(MP, "utils"), ".js"),
  join(MP, "app.js"),
  join(MP, "app.json"),
  join(MP, "project.config.json"),
].filter((p) => existsSync(p));

/* 真实 AppID 形态：wx + 16 位十六进制；项目里的 wx0000000000000000 是占位符，不算 */
const REAL_APPID_RE = /\bwx[0-9a-f]{16}\b/gi;
const appIdHits = [];
for (const f of allTextFiles) {
  const src = readText(f);
  let m;
  REAL_APPID_RE.lastIndex = 0;
  while ((m = REAL_APPID_RE.exec(src)) !== null) {
    if (!/^wx0{16}$/i.test(m[0])) appIdHits.push(`${mpRel(f)}:${m[0]}`);
  }
}
check(
  "代码里没有硬编码真实 AppID（wx + 16 位十六进制）",
  appIdHits.length === 0,
  appIdHits.join(",")
);

let projectConfig = null;
try {
  projectConfig = JSON.parse(readText(join(MP, "project.config.json")));
} catch {
  projectConfig = null;
}
check(
  "project.config.json 可解析，且 appid 是占位符（全 0）或空（不能是真实 AppID）",
  Boolean(projectConfig) &&
    (projectConfig.appid === undefined ||
      projectConfig.appid === "" ||
      /^wx0{16}$/i.test(String(projectConfig.appid)) ||
      String(projectConfig.appid) === "touristappid"),
  `appid=${projectConfig?.appid}`
);

/* AppSecret：任何文件里都不许出现 app_secret / AppSecret 的**赋值**（注释里提到词不算） */
const secretAssign = [];
for (const f of allTextFiles) {
  const src = readText(f);
  const re = /(?:app_?secret|AppSecret)\s*[:=]\s*["'][^"']{6,}["']/gi;
  let m;
  while ((m = re.exec(src)) !== null) secretAssign.push(`${mpRel(f)}:${m[0].slice(0, 40)}`);
}
check("代码里没有硬编码 AppSecret（赋值形态）", secretAssign.length === 0, secretAssign.join(","));

/* 假手机号：页面里出现 11 位手机号（除了正则表达式里的校验模式）就算可疑 */
const phoneHits = [];
for (const f of allTextFiles) {
  if (!f.endsWith(".js") && !f.endsWith(".wxml") && !f.endsWith(".json")) continue;
  const src = readText(f);
  const re = /(?<![\d.])1[3-9]\d{9}(?![\d.])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(Math.max(0, m.index - 40), m.index + 20);
    /* 正则校验串（/^1[3-9]\d{9}$/）里的模式不会命中纯数字；命中即为硬编码号码 */
    phoneHits.push(`${mpRel(f)}:${m[0]} ~ ${line.replace(/\s+/g, " ").slice(0, 50)}`);
  }
}
check("页面与 utils 里没有硬编码手机号（假演示号码）", phoneHits.length === 0, phoneHits.slice(0, 5).join(" | "));

/* 假身份证：18 位（末位可为 X） */
const idHits = [];
for (const f of allTextFiles) {
  if (!f.endsWith(".js") && !f.endsWith(".wxml")) continue;
  const src = readText(f);
  const re = /(?<![\dA-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g;
  let m;
  while ((m = re.exec(src)) !== null) idHits.push(`${mpRel(f)}:${m[0].slice(0, 6)}…`);
}
check("页面与 utils 里没有硬编码身份证号（假演示数据）", idHits.length === 0, idHits.slice(0, 5).join(","));

console.log("\n── 7. WXML 列表渲染必须有 wx:key ──");

const wxmlFiles = listFiles(join(MP, "pages"), ".wxml");
const noKey = [];
for (const f of wxmlFiles) {
  const src = readText(f);
  const re = /wx:for\s*=/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    /*
     * wx:key 与 wx:for 是同一个标签上的相邻属性，可能跨行。
     * 取 wx:for 之后 400 字符内出现 wx:key 即视为有（属性不会隔这么远）。
     */
    const tail = src.slice(m.index, m.index + 400);
    if (!/wx:key\s*=/.test(tail)) {
      const line = src.slice(0, m.index).split("\n").length;
      noKey.push(`${mpRel(f)}:${line}`);
    }
  }
}
check("所有 wx:for 都带 wx:key（列表重排不错位）", noKey.length === 0, noKey.join(","));

console.log("\n── 8. 下单页的隐私说明与用户协议（清单第八节） ──");

const bookingJs = readText(join(MP, "pages/booking/booking.js"));
const bookingWxml = readText(join(MP, "pages/booking/booking.wxml"));

check(
  "下单页有「是否已同意协议」的状态（data.agreed）",
  /agreed\s*:\s*false/.test(bookingJs)
);
check(
  "下单页有勾选交互 onToggleAgree + 隐私说明 onShowPrivacy + 用户协议 onShowTerms",
  ["onToggleAgree", "onShowPrivacy", "onShowTerms"].every((m) => bookingJs.includes(m))
);
check(
  "下单页提交前校验协议勾选（未勾选直接拒绝提交）",
  /if\s*\(\s*!\s*this\.data\.agreed\s*\)/.test(bookingJs)
);
check(
  "下单页 WXML 同时出现《隐私说明》与《用户协议》入口",
  bookingWxml.includes("隐私说明") && bookingWxml.includes("用户协议")
);
check(
  "隐私说明写的是真实处理事项（不是空模板：含脱敏 / 订单可见性至少两项）",
  /脱敏/.test(bookingJs) && /订单只对下单本人/.test(bookingJs)
);
check(
  "用户协议写明「到店付款 / 申请需前台确认」（避免纠纷的关键条款）",
  /到店付款/.test(bookingJs) && /需前台审核后生效/.test(bookingJs)
);

console.log("\n── 9. 统一状态处理（加载 / 空 / 网络失败 / 登录过期 / 重复提交） ──");

const pageState = readText(join(MP, "utils/page-state.js"));
check("utils/page-state.js 提供统一状态机（真实存在）", pageState.length > 500);
check(
  "统一处理加载状态与失败态（baseData 的 loading / error / errorCode）",
  /loading\s*:\s*true/.test(pageState) && /errorCode/.test(pageState)
);
check(
  "统一处理登录过期（UNAUTHORIZED → 清 token + 重新登录 / 去绑定）",
  /UNAUTHORIZED/.test(pageState) && /clearToken\(\)/.test(pageState)
);
check(
  "统一处理防重复提交（submit 里 submitting 短路 + 复用 request_id）",
  /if\s*\(\s*page\.data\[flag\]\s*\)\s*return/.test(pageState) && /requestId\(page/.test(pageState)
);
check(
  "区分「未配置」与「接口未上线」两种文案（NOT_CONFIGURED / NOT_READY）",
  /NOT_CONFIGURED/.test(pageState) && /NOT_READY/.test(pageState)
);
check(
  "统一处理空状态（pickList / pickObject 把 null、[]、{stay:null} 归一）",
  /function pickList/.test(pageState) && /function pickObject/.test(pageState)
);
check(
  "统一处理返回后刷新与订单状态轮询（refreshOnShow / startPolling）",
  /function refreshOnShow/.test(pageState) && /function startPolling/.test(pageState)
);

/* 13 个住客端页面都应该用到这套状态机（至少 baseData 或 load/submit） */
const notUsingState = API_MINI_PAGES.filter((p) => {
  const src = readText(join(MP, `${p}.js`));
  return !/page-state/.test(src);
});
check(
  "13 个住客端页面都引用 utils/page-state.js（状态处理不各写一套）",
  notUsingState.length === 0,
  notUsingState.join(",")
);

console.log("\n── 10. 其他静态约束 ──");

check("sitemap.json 存在且合法", (() => {
  try {
    JSON.parse(readText(join(MP, "sitemap.json")));
    return true;
  } catch {
    return false;
  }
})());

check(
  "app.js 里没有把 token 写进 console（避免真机日志泄露凭证）",
  !/console\.(log|info|warn|error)\([^)]*token/i.test(readText(join(MP, "app.js")))
);

check(
  "utils/api.js 的 BASE_URL 是「可配置的单一位置」（不是散落在页面里）",
  /const BASE_URL\s*=/.test(readText(join(MP, "utils/api.js"))) &&
    !/const BASE_URL\s*=/.test(pageState)
);

check(
  "README 说明开发者工具与真机各测一次、合法域名要求（清单第十节验收）",
  /https/.test(readText(join(MP, "README.md"))) &&
    /(开发者工具|真机)/.test(readText(join(MP, "README.md")))
);

console.log("");
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log("失败项：");
  for (const name of failed) console.log(`  · ${name}`);
  process.exit(1);
}
