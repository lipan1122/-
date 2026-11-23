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
node scripts/post-deploy.mjs --check   # 部署后收尾：先看会改什么（只读，默认就是这个模式）
node scripts/post-deploy.mjs --apply   # 备份一次 → 写库（结构 + 数据修复 + 体检，一条命令）
npm run reset:passwords     # 生成随机初始密码并打印，务必保存终端输出
npm run preflight           # 上线自检，全部通过才继续

npm run build
npm run start
```

`post-deploy --apply` 就是原来的「migrate-all + 押金/房态/日期/超卖/客史五个修复脚本」，
十步固定顺序、每步幂等、失败即停，最后两步是体检。**默认只读**：
不加 `--apply` 只打印报告，一个字节都不写。详见第 5 节。

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

## 5. 升级 / 部署后数据收尾（一条命令）

原来升级要按顺序敲 5~7 条命令（migrate-all → 押金 → 日期 → 超卖 → 客史 → chown → 重启），
**漏一条不报错，数据就一直错着**（押金修复漏跑过两次，在住押金虚高 6800 元）。现在收成一条：

```bash
cp data/pms.db data/backup-$(date +%Y%m%d%H%M).db   # 先备份，务必
pm2 stop pms                                         # 或停掉 next start
tar -xzf <新版本>.tar.gz --strip-components=1        # 保留 data/ 目录
npm ci

node scripts/post-deploy.mjs --check   # ① 只报告：十步各自会改什么（默认模式，不写库）
node scripts/post-deploy.mjs --apply   # ② 备份一次 → 写库（结构 + 数据修复 + 体检）

npm run build
npm run preflight
pm2 start pms
```

VPS（systemd + sudo 跑脚本）的标准顺序：

```bash
sudo node scripts/post-deploy.mjs --apply
sudo chown -R ubuntu:ubuntu data       # ← 这行必须留！见下面的「坑」
sudo systemctl restart pms
```

⚠️ **`chown` 那行不能删、位置不能挪**（第九轮在 VPS 上真踩过）：
`sudo node scripts/post-deploy.mjs --apply` 是**以 root 运行**的，SQLite 会顺手创建/改写
`data/pms.db-wal`、`data/pms.db-shm`，它们的归属变成 `root`；而服务是 `ubuntu` 跑的，
结果服务下一个请求就报 `attempt to write a readonly database` —— 页面全挂，但脚本输出全绿。
所以：**任何 `sudo node scripts/x.mjs` 之后，都要在重启服务前 `chown` 一次 `data/`**。

`--check` / `--apply` 的差别（这是本条命令唯一容易用错的地方）：

| 参数 | 行为 | 用在哪 |
| --- | --- | --- |
| （不加）/ `--check` / `--dry-run` | 十步全部**只读**：修复类步骤用各自脚本的检查模式跑，体检类本来就只读。一个字节都不写 | 上线前预演、排查「部署后该不该修」 |
| `--apply` | 第 1 步之前做一次 `VACUUM INTO data/backup/pms.db.bak-post-deploy-<时间戳>`，然后十步真写库。失败即停 | 真正的部署 / 升级 |

十步（顺序有依赖，别改）：schema 迁移（含押金残留第 24 段）→ 补齐表结构 → 单号唯一约束 →
押金残留 → 房态复位 → 演示日期滚动 → 超卖修复 → 客史回填 → 数据一致性体检（38 项）→ 业务体检。
第 4 步在正常流程里恒为 0 变更（第 1 步已经修过），它是独立复核与兜底；
`--skip <步骤名>` 可以跳过某步（如 `--skip oversell --skip roll-dates`）。

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
node scripts/post-deploy.mjs --check   # 十步收尾全跑一遍「只读版」：该修什么一眼看完
npm run db:migrate:check   # 只看迁移（post-deploy 第 1 步的子集）
npm run preflight          # 上线安全自检
npm run lint / typecheck
```

## 9. 上线前安全清单

- [ ] `SESSION_SECRET` 已用随机值配置，且未写进代码 / 镜像 / 版本库
- [ ] 已执行 `npm run reset:passwords`，4 个初始账号密码已换成随机值并妥善保存
- [ ] 公网部署已删除 `PMS_ALLOW_HTTP`，入口配好 HTTPS
- [ ] 已执行 `npm run preflight`，无 ❌ 项
- [ ] 演示数据已清空或换成真实门店基础数据
- [ ] `post-deploy.mjs --apply` 跑过一遍，且**紧接着 `chown -R <服务用户>:<服务用户> data`**
      （sudo 跑脚本会留下 root 的 `pms.db-wal`/`-shm`，漏了 chown 服务就写不了库）
- [ ] `data/` 不在 Web 可访问路径下
- [ ] 每日备份已配置并验证过一次恢复
- [ ] 防火墙只开放 3100（或反代端口）
- [ ] 渠道密钥只写在 `.env`，未进代码或前端
