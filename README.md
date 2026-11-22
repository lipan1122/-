# 云栖 PMS 酒店管理系统

一个给中小酒店用的前台管理系统。覆盖房态、预订、入住、收银、夜审、报表、会员、渠道直连和员工移动端。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Next.js 16（App Router + Turbopack） |
| 语言 | TypeScript 5.9（strict） |
| UI | React 19 + Tailwind CSS v4 |
| 数据库 | SQLite（Node 内置 `node:sqlite`，零外部依赖） |
| 密码 | scrypt（N=16384, r=8, p=1） |

## 快速开始

```bash
# 1. 装依赖（Node 版本 >= 22.18，需要内置 node:sqlite）
npm install

# 2. 配置环境变量（本地演示可直接复制；生产必改 SESSION_SECRET）
cp .env.example .env

# 3. 初始化数据库（建表 + 灌演示数据 + 跑全部迁移）
npm run db:init

# 4. 起开发服务器
npm run dev
# 打开 http://localhost:3100

# 或者生产模式
npm run build
npm start
```

Windows 上也可以直接双击 `启动服务.bat`（会自动 build + 启动在 3100 端口）。

## 演示账号

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `admin123` | 管理员（全部功能） |
| `front` | `123456` | 前台（房态/预订/入住/收银） |
| `cashier` | `123456` | 收银（收银台/账务/应收） |
| `housekeeper` | `123456` | 客房（打扫任务） |

> 演示账号只在设置了 `PMS_SHOW_DEMO_HINT=1` 时才显示在登录页（本地演示用），交付包默认不显示。
> ⚠️ **上线前必须执行 `npm run reset:passwords`** 生成随机密码；生产模式会直接拒绝这些初始口令登录。

## 目录结构

```
src/
├── app/
│   ├── (main)/          电脑版 50 个页面
│   │   ├── rooms/       房态（含远期房态、房型预测）
│   │   ├── bookings/    预订（含新建、排房）
│   │   ├── frontdesk/   入住办理
│   │   ├── cashier/     收银台（收款/退款/拆账/挂账/发票）
│   │   ├── night-audit/ 夜审
│   │   ├── reports/     68 张报表
│   │   └── ...
│   ├── (mobile)/        员工移动端 8 个页面
│   ├── api/             11 个接口（登录、导出、小程序）
│   └── login/
├── lib/                 16 个核心业务库
│   └── channels/        渠道直连（携程/美团/飞猪/抖音）
├── components/          22 个 UI 组件
└── middleware.ts        路径透传（鉴权在 layout）
scripts/
├── init-db.mjs          建表 + 演示数据
├── migrate-all.mjs      统一迁移（16 段，幂等）
├── audit.mjs            81 项数据一致性检查
└── test-*.mjs           34 套测试
miniprogram/             微信小程序（原生 WXML，不用框架）
docs/                    设计文档与验收报告
```

## 核心设计

### 1. 房态流转有唯一合法表

`src/lib/room-status.ts` 的 `ALLOWED` 表决定「什么状态能转什么状态」，所有房态变更必须走 `changeRoomStatus()`，它同时写 `room_logs`（操作人/时间/原状态/新状态/原因）。

```ts
OC: ["OD", "VD", "VC", "OOO", "LOCK"],   // 住净 → 空脏 是退房必经路径
```

### 2. 账务重算只有一个口径

`src/lib/folio.ts` 的 `recalcFolioBalance()` 是全项目唯一实现。收银台、客房、在住、夜审、商超五处都调它，避免「同一张账单在不同入口算出不同余额」。

关键规则：排除「部分结账」写入的 ADJUST 负项（那是内部已结记录，不是客人消费）。

### 3. 房间占用按区间判，不靠唯一索引

`src/lib/room-availability.ts` 用半开区间判冲突：

```ts
existing.check_in < new.check_out AND existing.check_out > new.check_in
```

相等不算冲突（A 12:00 退房、B 14:00 入住可接续）。续住和换房必须查远期占用。

### 4. 权限在数据库里，不在代码里

`role_permissions` / `role_modules` / `permission_dict` 三张表。设置页改完立即生效（5 秒 TTL 缓存 + 保存时主动失效）。

缓存挂在 `globalThis` 而不是模块级变量 —— Next 分包后页面 / Server Action / Route Handler 各有一份，模块级缓存改了不生效。

### 5. 资金操作可重试

`payments` / `folio_items` / `shop_sales` 都有 `request_id` + 部分唯一索引（NULL 不冲突）。重复提交返回第一次结果，不重复记账。

### 6. 多租户隔离

所有业务表的 `UPDATE` / `DELETE` 都带 `hotel_id`。测试脚本 `scripts/test-tenant-writes*.mjs` 用「错误租户写入影响 0 行、正确租户影响 1 行」双向证明。

### 7. 时间口径

- `nowIso()` → UTC，只用于 `created_at` 这类纯时间轴字段
- `nowLocalIso()` → 本地时间+偏移，用于会被 `substr(x,1,10)` 当日期读的字段（如 `check_in_time`）
- 营业日统一走 `src/lib/biz-date.ts`（默认 05:00 切换）

## 渠道直连

`src/lib/channels/` 里有 4 家渠道适配器（携程/美团/飞猪/抖音）+ 沙箱。

**当前状态：代码骨架完成，但未接通真实渠道。** 因为携程/美团/飞猪/抖音的开放平台都需要：

1. 商户资质（营业执照、特种行业许可证、星级材料）
2. 企业开发者账号
3. 签约 + 部分要保证金
4. 拿到 `app_key` / `app_secret` / 门店 id

拿到后填到「系统设置 → 渠道管理」即可发请求。没填时走沙箱模式：流程能跑通，但不产生真实订单。

每家「哪些字段待联调核对」写在各自文件头和 `docs/渠道对接清单.md`。

## 微信小程序

`miniprogram/` 是原生 WXML/WXSS/JS 代码（不用 Taro/uni-app）。服务端 API 在 `src/app/api/mini/`。

**当前状态：代码完成，未配置 AppID。** 需要：

1. 在 https://mp.weixin.qq.com 注册小程序，拿 AppID / AppSecret
2. 在 PMS「设置 → 小程序配置」填入并启用
3. 小程序后台配置「服务器域名 → request 合法域名」（必须是已备案 HTTPS 域名）
4. 把 `miniprogram/project.config.json` 的 appid 换成自己的，`utils/api.js` 的 `BASE_URL` 换成域名

未配置时 `/api/mini/login` 返回 `NOT_CONFIGURED`，不会发假 token。

详见 `miniprogram/README.md`。

## 测试

```bash
node scripts/audit.mjs              # 81 项数据一致性
node scripts/audit-pages.mjs        # 41 页可访问性
node scripts/audit-reports.mjs      # 68 张报表
node scripts/audit-gap.mjs          # 27 项需求审计

# 34 套业务测试
node scripts/test-auth-security.mjs
node scripts/test-cashier-rules.mjs
node scripts/test-folio-recalc.mjs
node scripts/test-room-availability.mjs
# ... 见 scripts/test-*.mjs
```

约 1100 项断言。

## 数据库

SQLite 文件在 `data/pms.db`。

- 建表：`scripts/init-db.mjs`（末尾自动调 `runMigrations`）
- 迁移：`scripts/migrate-all.mjs`（16 段，幂等，`--check` 只检查不改）
- 全新环境：`npm run db:init` 一条命令建好
- 老库升级：`npm run db:migrate`

改了表结构一定要同时改两处（`migrate-all.mjs` + 如果新增表也要在 `init-db.mjs` 建），否则全新部署会缺表。

## 已知限制

| 项 | 原因 |
| --- | --- |
| 渠道未接通 | 需要商户资质和渠道方凭据 |
| 小程序未跑起来 | 需要 AppID 和备案域名 |
| 抖音订单状态回传 | 接口权限开通方式和参数没把握，返回 `UNSUPPORTED` |
| 金额用 REAL 不用整数分 | 选了「统一 round2 + 按分对账」的方案，实测 0 尾差 |
| 多店需初始化权限 | `role_permissions` 按 `hotel_id=1` 灌的，新店要补一次 |
| 改密码后旧会话仍有效 | 无状态 token 12 小时内自包含，改密只影响新登录；要强制下线请重启服务或清 Cookie |

## 部署到生产前必须做

完整步骤见 [DEPLOY.md](./DEPLOY.md)；最小化清单：

1. 配置 `SESSION_SECRET`（`openssl rand -hex 32`），并删除 `PMS_ALLOW_HTTP`
2. 执行 `npm run reset:passwords` 生成随机初始密码并保存
3. 执行 `npm run preflight`，确认无 ❌ 项
4. 把 `data/pms.db` 换成自己的库（不要用演示数据）
5. 配置 HTTPS（`next start` 前面挂 nginx 或 Caddy）
6. 设置 `settings.biz_day_cutoff`（营业日切换时间，默认 05:00）
7. 检查 `channels` 表里的门店号/凭据，删掉演示值
