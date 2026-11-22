# PMS 部署说明

## 1. 环境要求

- Node.js >= 22.18（用到内置 `node:sqlite`；该 API 目前仍是实验特性，升级 Node 大版本前先跑 `npm run check`）
- 建议 Linux + 2 核 2G 以上；Windows Server 同样可用
- 端口 **3100**（package.json / 启动服务.bat / Dockerfile 已统一，不再用 3000）

## 2. 首次安装（裸机 / VPS）

```bash
tar -xzf <发布包>.tar.gz
cd <发布包目录>

npm ci                      # 构建需要 devDependencies，不要加 --omit=dev
cp .env.example .env
vi .env                     # 必改 SESSION_SECRET；公网部署删掉 PMS_ALLOW_HTTP 一行

npm run db:init             # 建表 + 基础字典 + 演示数据
npm run db:migrate          # 幂等，可重复跑
npm run reset:passwords     # 生成随机初始密码并打印，务必保存终端输出
npm run preflight           # 上线自检，全部通过才继续

npm run build
npm run start
```

`reset:passwords` 会为 4 个初始账号生成随机密码并打印。**必须在公网开放前执行**：
生产模式会直接拒绝 `admin123` / `123456` 等初始口令登录。

启动后访问 `http://<服务器IP>:3100`。

## 3. Docker 部署

```bash
docker build -t pms .
docker run -d --name pms --restart always -p 3100:3100 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v /opt/pms-data:/app/data pms
docker exec -it pms node scripts/reset-demo-passwords.mjs
```

镜像启动时会检查 `/app/data/pms.db`，不存在则自动建库并跑幂等迁移。
数据库在挂载卷里，容器重建不丢数据。

## 4. 关键环境变量

| 变量 | 说明 |
| --- | --- |
| `SESSION_SECRET` | **生产必配**。会话签名密钥，`openssl rand -hex 32` 生成；不配则生产模式拒绝登录 |
| `PMS_ALLOW_HTTP` | 仅本地/内网演示设 `1`。**公网部署必须删除**；删除后 HTTPS Cookie、登录失败锁定、初始口令拦截自动生效 |
| `PMS_SHOW_DEMO_HINT` | 本地演示设 `1` 才在登录页列出演示账号；生产不要设 |
| `PMS_DB_PATH` | 数据库路径，默认 `./data/pms.db` |
| `PMS_BASE_URL` | 站点基址，默认 `http://localhost:3100` |

> HTTP 反代说明：若公网入口是 HTTPS、nginx 到应用走 HTTP，仍不要设 `PMS_ALLOW_HTTP=1`，
> 浏览器看到的是 HTTPS，Secure Cookie 正常工作。只有「浏览器直接用 http:// 访问」时才需要设。

## 5. 升级

```bash
cp data/pms.db data/backup-$(date +%Y%m%d%H%M).db   # 先备份，务必
pm2 stop pms                                         # 或停掉 next start
tar -xzf <新版本>.tar.gz --strip-components=1        # 保留 data/ 目录
npm ci
npm run db:migrate
npm run build
npm run preflight
pm2 start pms
```

迁移幂等，重复执行 0 变更。

## 6. 回滚

```bash
cp data/backup-<时间戳>.db data/pms.db
rm -f data/pms.db-wal data/pms.db-shm
npm run start
```

代码回滚：解压上一个版本的发布包覆盖即可。

## 7. 备份

- 每日夜审后备份：`cp data/pms.db data/backup-$(date +%Y%m%d).db`，保留最近 30 天
- WAL 模式下建议先停服务或执行 `PRAGMA wal_checkpoint` 再复制
- 单文件数据库，复制即可；**备份文件不要放在 Web 可访问目录**

## 8. 健康检查

```bash
npm run health             # 数据一致性 + 业务积压
npm run db:migrate:check   # 检查未应用的迁移
npm run preflight          # 上线安全自检
npm run lint / typecheck
```

## 9. 上线前安全清单

- [ ] `SESSION_SECRET` 已用随机值配置，且未写进代码 / 镜像 / 版本库
- [ ] 已执行 `npm run reset:passwords`，4 个初始账号密码已换成随机值并妥善保存
- [ ] 公网部署已删除 `PMS_ALLOW_HTTP`，入口配好 HTTPS
- [ ] 已执行 `npm run preflight`，无 ❌ 项
- [ ] 演示数据已清空或换成真实门店基础数据
- [ ] `data/` 不在 Web 可访问路径下
- [ ] 每日备份已配置并验证过一次恢复
- [ ] 防火墙只开放 3100（或反代端口）
- [ ] 渠道密钥只写在 `.env`，未进代码或前端
