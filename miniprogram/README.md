# 酒店会员端小程序（原生 WXML / WXSS / JS）

PMS 的「微信小程序 / 会员端」（整改清单 F12）。客人可以在小程序里查房、下单、看订单、看会员余额积分。

- **原生小程序**：只用 WXML / WXSS / JS，没有 Taro / uni-app / 任何 npm 依赖，微信开发者工具打开就能编译。
- **服务端已就绪**：`src/app/api/mini/**` 提供全部接口，你只需要填自己的 AppID / AppSecret。
- **不需要改代码就能换域名**：只有 `utils/api.js` 里的 `BASE_URL` 一个常量。

---

## 一、目录结构

```
miniprogram/
├── app.js                        // 启动时静默登录（wx.login → 换 token）
├── app.json                      // 页面注册 + tabBar
├── app.wxss                      // 全局样式（iOS 风格卡片）
├── project.config.json           // 开发者工具工程配置（appid 是占位符）
├── sitemap.json
├── utils/
│   ├── api.js                    // 请求封装：BASE_URL、token、错误处理
│   └── date.js                   // 日期工具（避开 iOS 的 UTC 解析坑）
└── pages/                        // 18 个页面，见「五、页面清单」
    ├── index/                    // 首页：查房 + 房型列表
    ├── booking/                  // 下单页
    ├── orders/                   // 我的订单
    ├── order-detail/             // 订单详情
    ├── pre-stay/                 // 到店前须知
    ├── in-stay/                  // 在住
    ├── folio/                    // 账单明细
    ├── extend/                   // 续住申请
    ├── change-room/              // 换房申请
    ├── late-checkout/            // 延迟退房
    ├── services/                 // 服务请求
    ├── room-detail/              // 房型详情
    ├── member/                   // 会员中心
    ├── wallet/                   // 储值钱包
    ├── invoices/                 // 发票
    ├── notifications/            // 通知
    ├── bind/                     // 绑定手机号
    └── contact/                  // 联系酒店
```

每个页面目录都有 `.wxml` / `.js` / `.json` / `.wxss` 四个文件。

---

## 二、开始之前你必须自己准备的东西

这两样东西**只能由酒店自己申请**，代码里不会有、也不能编造：

| 东西 | 去哪拿 | 说明 |
| --- | --- | --- |
| **AppID** | <https://mp.weixin.qq.com> → 开发管理 → 开发设置 → 开发者 ID | `wx` 开头 18 位 |
| **AppSecret** | 同页面「生成 / 重置」按钮 | 32 位，**只显示一次**，复制完整 |
| **已备案的 HTTPS 域名** | 你的服务器 + 域名备案 | 微信不允许 `request` 用 IP 或 http |

> 没有企业主体也能注册小程序（个人主体可以发布，但不能用微信支付，也不需要——本项目支付走「到店付款」）。
> 微信支付商户号 `mch_id` / `mch_key` 是**可选项**：留空照样能查房、下单，只是不做在线支付。

---

## 三、跑起来：五步

### 第 1 步：在 PMS 里填 AppID / AppSecret

1. 用管理员账号登录 PMS → **设置 → 小程序配置**（`/settings?tab=miniprogram`）
2. 填 AppID、AppSecret（商户号 / 商户密钥可留空）
3. 勾选「启用小程序登录」→ 保存
4. 页面右上角应显示 **已配置 / 已启用**

不填就直接调用接口时，`/api/mini/login` 会返回：

```json
{ "ok": false, "code": "NOT_CONFIGURED", "error": "小程序未配置，请管理员在系统设置里填写 AppID/AppSecret" }
```

**不会返回假 token** —— 这一点是故意的，假 token 会让小程序以为登录成功，之后每个接口都 401，问题极难定位。

> 配置存在 `mini_program_config` 表（一家店一条，`UNIQUE(hotel_id)`）。
> AppSecret 只存服务端，页面上不回显；表单里留空 = 保持原值不变。

### 第 2 步：在小程序后台配置服务器域名

小程序后台 → **开发管理 → 开发设置 → 服务器域名**：

- **request 合法域名**：填你的 PMS 域名，例如 `https://pms.example.com`
  - 必须带 `https://`
  - 必须是**已备案**域名，不能是 IP、不能带端口、不能是 localhost
  - 每月只能改 5 次，改之前想清楚
- 不需要配 uploadFile / downloadFile / socket / webview 域名（本项目只用 `wx.request`）

### 第 3 步：改 `project.config.json` 的 appid

```json
{
  "appid": "wx0000000000000000"
}
```

把 `wx0000000000000000` 换成**你自己的 AppID**（这个占位符是故意写成全 0 的，一眼能看出没改）。

### 第 4 步：改 `utils/api.js` 的 BASE_URL

```js
/** 服务端地址：改成你的域名（不要以 / 结尾） */
const BASE_URL = 'http://127.0.0.1:3100';
```

- **本机联调**：留 `http://127.0.0.1:3100`（PMS 默认端口 3100），并在开发者工具里勾选
  「详情 → 本地设置 → **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**」
- **真机 / 上线**：改成 `https://你的域名`，并确认第 2 步的白名单已生效

### 第 5 步：用微信开发者工具打开

1. 打开「微信开发者工具」→ 导入项目
2. 目录选择本文件夹 `miniprogram/`（不是项目根目录）
3. AppID 选「使用 `project.config.json` 里的 appid」或直接填自己的 AppID
4. 编译 → 首页应该能看到房型列表（先确认 PMS 已启动、库里有房型和房价）

---

## 四、体验流程

1. **首页**：默认查「今天 → 明天」，显示每个房型的剩余间数、每晚均价、区间总价
2. 点「立即预订」→ **下单页**：填姓名 / 手机号 / 间数 / 备注 → 提交
3. 成功后跳到 **我的订单**，能看到刚下的单（状态「待排房」）
4. **会员中心** → 「绑定手机号」→ 填手机号 + 姓名 → 绑定到酒店客史
5. 绑定后再回会员中心，能看到等级、储值余额、积分、累计消费、入住次数

订单在前台 PMS 的「预订列表」里同样能看到（单号 `BK3000+`，与前台建单同一号段）。
小程序订单落库状态是 `PENDING`（待排房），前台分配房间后才变 `CONFIRMED`。

---

## 五、页面清单（18 个）

`app.json` 里注册的全部页面：

| 页面 | 路径 | 作用 |
| --- | --- | --- |
| 首页 | `pages/index` | 查房入口、活动、快捷入口 |
| 预订 | `pages/booking` | 选房型 / 日期 / 间数 / 客人信息，提交下单 |
| 订单列表 | `pages/orders` | 我的订单（待入住 / 在住 / 已完成 / 已取消） |
| 订单详情 | `pages/order-detail` | 单笔订单详情 + 取消 / 修改入口 |
| 预抵信息 | `pages/pre-stay` | 到店前须知（地址 / 入离时间 / 押金说明） |
| 在住 | `pages/in-stay` | 当前在住：房号 / 离店日 / 账单余额 / 快捷服务 |
| 账单 | `pages/folio` | 账单明细（房费 / 消费 / 已付 / 余额） |
| 续住 | `pages/extend` | 续住申请（选新离店日，服务端校验远期冲突） |
| 换房 | `pages/change-room` | 换房申请（选目标房型，服务端校验归属） |
| 延迟退房 | `pages/late-checkout` | 延迟退房申请 |
| 服务 | `pages/services` | 服务请求（送物 / 维修 / 叫醒 / 其他） |
| 房型详情 | `pages/room-detail` | 单房型图片、设施、价格日历 |
| 会员 | `pages/member` | 等级 / 积分 / 累计消费 |
| 钱包 | `pages/wallet` | 储值余额与流水 |
| 发票 | `pages/invoices` | 我的发票（开具 / 查看） |
| 通知 | `pages/notifications` | 系统通知与消息 |
| 绑定 | `pages/bind` | 手机号 + 姓名绑定客史 |
| 联系 | `pages/contact` | 联系酒店（电话 / 地址 / 地图） |

---

## 六、接口清单（28 个路由）

所有接口统一返回 `{ ok, data?, error?, code? }`，全部 `no-store`。
鉴权头：`Authorization: Bearer <token>`（token 由 `/api/mini/login` 下发，有效期 7 天）。

### 6.1 登录与账号

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/mini/login` | 无 | body `{ code }`，换 token |
| POST | `/api/mini/logout` | Bearer | 注销当前 token |
| POST | `/api/mini/bind` | Bearer | body `{ mobile, guestName }`，绑定 / 新建客史 |
| POST | `/api/mini/member/unbind` | Bearer | 解绑 |
| GET | `/api/mini/member` | Bearer | 等级 / 储值余额 / 积分 / 累计消费 |
| GET | `/api/mini/member/ledger` | Bearer | 储值流水 |

### 6.2 房型与酒店信息（匿名，客人未登录也要能看）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/mini/rooms?checkIn=&checkOut=` | 无（有限流） | 房型 + 剩余房量 + 价格 |
| GET | `/api/mini/room-types/[id]` | 无 | 单房型详情 |
| GET | `/api/mini/hotel` | 无 | 酒店基础信息（名称/地址/电话/入离时间/押金说明，**不返回经营数据**） |

### 6.3 订单

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/mini/bookings` | Bearer | 下单（`request_id` 幂等） |
| GET | `/api/mini/bookings` | Bearer | 我的订单列表 |
| GET | `/api/mini/bookings/[id]` | Bearer | 单笔详情（**校验归属**） |
| POST | `/api/mini/bookings/[id]/cancel` | Bearer | 取消（**校验归属**） |
| POST | `/api/mini/bookings/[id]/modify` | Bearer | 修改（**校验归属**） |

### 6.4 在住服务

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/mini/stays/current` | Bearer | 当前在住（**校验归属**） |
| GET | `/api/mini/stays/[id]/folio` | Bearer | 账单明细（**校验归属**） |
| POST | `/api/mini/stays/[id]/extend` | Bearer | 续住（校验远期冲突） |
| POST | `/api/mini/stays/[id]/change-room` | Bearer | 换房申请 |
| POST | `/api/mini/stays/[id]/late-checkout` | Bearer | 延迟退房 |
| POST | `/api/mini/stays/[id]/service` | Bearer | 服务请求 |
| POST | `/api/mini/stays/[id]/wakeup` | Bearer | 叫醒 |

### 6.5 服务工单

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/mini/service-orders` | Bearer | 我的服务请求列表 |
| POST | `/api/mini/service-orders/[id]/cancel` | Bearer | 取消（**校验归属**） |

### 6.6 其他

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/mini/breakfast` | Bearer | 早餐购买情况 |
| GET | `/api/mini/invoices` | Bearer | 我的发票（**校验归属**） |
| GET | `/api/mini/notifications` | Bearer | 通知列表 |
| POST | `/api/mini/notifications/read` | Bearer | 标记已读 |

> **「校验归属」** 指接口会校验「这个订单 / 入住单 / 发票是不是当前 token 对应的那个客人」。
> 缺了它就能按 id 枚举别人的数据（IDOR）。`scripts/test-mini-order-access.mjs` 的 100 条断言在守这条线。

---

## 七、常见问题

**Q：登录报「小程序未配置」**
A：PMS → 设置 → 小程序配置里 AppID/AppSecret 没填，或「启用」没勾。

**Q：登录报 errcode 40013 / invalid appid**
A：`project.config.json` 里的 appid 与 PMS 里填的 AppID 不是同一个小程序。

**Q：登录报 errcode 40125 / invalid appsecret**
A：PMS 里的 AppSecret 复制不完整（应 32 位）或已被重置。重新生成后填一次。

**Q：真机报「不在以下 request 合法域名列表中」**
A：第 2 步的服务器域名没配或没生效（配置后要重新编译 + 真机重启小程序）；域名必须 https + 已备案。

**Q：一直转圈，最后提示网络请求失败**
A：`BASE_URL` 不对（IP / 端口 / http vs https），或服务端没启动。

**Q：订单里看不到刚下的单**
A：没绑定手机号时，订单按小程序用户上留的手机号匹配；绑定后按客史匹配。
姓名 / 手机号与下单时填的不一致会查不到，去「会员中心 → 更换绑定手机号」重新绑一次。

---

## 八、安全提醒（务必看）

1. **AppSecret 绝不能写进小程序代码**。小程序包是可以被反编译的，密钥只放在 PMS 服务端（`mini_program_config` 表）。
2. 本目录里所有 appid 都是占位符 `wx0000000000000000`，**不要把真实 AppID/Secret 提交进 git**。
3. token 存 `wx.storage`，7 天过期；PC 端用 Cookie session，两套互不影响（服务端实现见 `src/lib/mini-auth.ts`）。
4. 小程序拿不到微信手机号（除非走 `getPhoneNumber` + 企业主体权限），所以绑定手机号是**用户手动填**的，
   服务端只做格式校验 + 客史匹配，不做「先验证再绑定」的短信验证（PMS 侧无短信通道）。

---

## 九、服务端自测

服务端有 **6 套**验收脚本，全部真开数据库 / 真调路由：

```bash
node scripts/test-miniprogram-pages.mjs          # 78 项：18 个页面四件套齐全 + app.json 注册一致
node scripts/test-miniprogram.mjs                # 82 项：表结构 / 登录未配置分支 / token / 房量 / 密钥泄露
node scripts/test-mini-order-access.mjs          # 100 项：订单归属校验（防 IDOR）
node scripts/test-mini-bind-security.mjs         # 66 项：绑定安全（手机号 / 姓名 / 重复绑定）
node scripts/test-mini-booking-idempotency.mjs   # 47 项：下单幂等（同 request_id 只产生一笔）
node scripts/test-mini-service-orders.mjs        # 68 项：服务请求幂等 + 归属
```

每套都应输出 `通过 N / 失败 0`。

> 这些测试要求 `.tmp` 目录可写（它们会 `VACUUM INTO` 出副本库）。
> 如果在 Windows 上遇到 `EPERM` / `unable to open database file`，
> 先确认项目根下的 `.tmp/` 有写权限，不要把它当「测试通过」。

数据表由迁移脚本创建，老库升级跑一次即可（幂等）：

```bash
node scripts/migrate-all.mjs
```

### 还没做的验证（必须有真机才能做）

| 项 | 为什么做不了 |
| --- | --- |
| 微信开发者工具编译 | 需要本机装开发者工具并登录 |
| 真机 HTTPS / 合法域名 | 需要已备案域名 + 小程序后台配置 |
| 断网重试 / token 过期真机表现 | 需要在真机上操作 |
| 小程序真机下单全链路 | 需要真实 AppID / AppSecret |

