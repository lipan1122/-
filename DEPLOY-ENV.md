# 上线前检查与环境变量

> 这份清单是「上线前体检」的结论。跑完下面的检查 + 配好环境变量，就可以交付了。

## 一、必须配的环境变量

| 变量 | 值 | 作用 | 不配的后果 |
| --- | --- | --- | --- |
| **`PMS_DEMO_LOGIN`** | `0` | 关闭登录页的「一键填入演示账号」 | 登录页会显示 4 个演示账号，点一下自动填入明文口令 |
| **`SESSION_SECRET`** | 32 字节随机串 | 无状态会话的签名密钥（Serverless 部署用） | 用内置常量，会话 token 可被伪造 |
| **`PMS_DEMO_SEED`** | `0` 或不设 | 关闭自动灌演示数据（AR 账户/商品/积分/销售员） | 首次打开 AR、商品、积分页面会灌入虚构数据 |
| `PMS_ALLOW_HTTP` | `1` | 允许 HTTP 下登录（不加 Secure Cookie） | 纯 HTTP 部署（无 HTTPS）时登录不生效 |

### 生成 SESSION_SECRET

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### Windows 启动脚本里怎么配

编辑 `启动服务.bat`，在 `node ...` 前面加：

```bat
set PMS_DEMO_LOGIN=0
set SESSION_SECRET=你生成的32字节串
set PMS_DEMO_SEED=0
```

### Docker / systemd 里怎么配

```bash
docker run -d -p 3000:3000 \
  -e PMS_DEMO_LOGIN=0 \
  -e SESSION_SECRET=xxxx \
  -e PMS_DEMO_SEED=0 \
  -v /opt/pms-data:/app/data \
  pms
```

---

## 二、上线前必跑的检查

```bash
# 一条命令跑全部
npm run audit:all

# 或者分开跑
npm run tsc              # 类型检查（应为 0 错误）
npm run lint             # 代码规范（应为 0 error）
node scripts/audit.mjs           # 业务规则审计 81 项
node scripts/audit-pages.mjs     # 41 页可访问
node scripts/audit-reports.mjs   # 68 张报表
node scripts/preflight-db.mjs    # 38 项数据体检
node scripts/check-sql-params.mjs  # 361 处 SQL 参数
node scripts/check-report-map.mjs  # 报表映射完整性
```

---

## 三、数据准备

### 如果要从演示数据清空

```bash
node scripts/init-db.mjs --reset
```

会重建空库 + 灌入**必需的基础配置**（房间/房型/渠道/角色/权限/积分规则/房价日历），
不含任何演示订单、客人、账单。

### 如果要保留现有数据上线

```bash
# 先备份
cp data/pms.db data/pms.db.bak-$(date +%Y%m%d)
```

### 押金口径重算（如果从旧版本升级）

```bash
node scripts/recalc-all-folios.mjs --check   # 先看会改多少张
node scripts/recalc-all-folios.mjs           # 实际重算
```

---

## 四、上线后第一件事

**改密码**。4 个账号还是 seeds 里的口令：

| 账号 | 初始口令 | 必须改 |
| --- | --- | --- |
| admin | admin123 | ✅ |
| front | 123456 | ✅ |
| cashier | 123456 | ✅ |
| housekeeper | 123456 | ✅ |

改法：系统设置 → 用户管理 → 重置密码
（或设 `PMS_DEMO_LOGIN=0` 后登录，进设置页改）

---

## 五、已知未完成项

| 项 | 状态 | 影响 |
| --- | --- | --- |
| 11 张报表 | 显示「尚未实现」占位 | 渠道统计/会员报表/发票明细等，需要按实际表结构改 SQL |
| 渠道直连 | 骨架完成，需凭据 | 没填 app_key 时走沙箱，不产生真实订单 |
| 微信小程序 | 代码完整，需 AppID | 未配置时 `/api/mini/login` 返回 NOT_CONFIGURED |
| 交班汇总 | 不分收银员 | 多个收银员同时交班时长款会算错（单人收银不受影响） |
| 夜审阻断 | 只提示不拦截 | 账面异常时仍能执行夜审 |
| error.tsx | 无错误边界 | 越权/报错时白屏，用户看不到原因 |
| 入住制卡/退房废卡 | 未联动 | 门卡需手工在房态图操作 |

详细清单见 `docs/上线前审计报告.md`。
