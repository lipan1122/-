# 部署到「快 + 电脑关机也能用」的服务器

> 你的需求：**国内访问快** + **自己电脑关机后同事还能测**。
> 免费方案（Vercel）满足第二条但慢 2-3 秒；要快就必须有独立服务器。
>
> ⚠️ Vercel 还有个更硬的限制：SQLite 会被复制到各函数实例的 `/tmp`，实例间不共享、冷启动重置。
> 它只适合单人看界面演示，不能给多个同事同时测业务数据——写入会丢、各人看到的不一致。

---

## 先做决定：买哪种

| 方案 | 国内延迟 | 价格 | 备案 | 适合 |
| --- | --- | --- | --- | --- |
| **阿里云香港轻量** | 30-80 ms | **¥24/月**（1核1G，新手首选） | **不需要** | ✅ 推荐 |
| 腾讯云香港轻量 | 30-80 ms | ¥28/月 | 不需要 | ✅ 推荐 |
| 阿里云国内 ECS | 20-50 ms | ¥100/月 | **必须备案** | 要长期上生产 |
| Railway | 100-300 ms | $5/月 | 不需要 | 不想碰 Linux |
| Fly.io | 100-300 ms | 免费额度 | 不需要 | 想省钱 |

**为什么推荐香港轻量**：
- 不用备案（备案要 7-20 天，还要域名）
- 国内延迟 30-80 ms，比 Vercel 快 30-50 倍
- 有公网 IP，直接用 `http://IP:3100` 就能访问
- ¥24/月 ≈ 一杯咖啡

**1核1G 够不够**：这个项目构建时内存峰值约 800 MB，**1G 会 OOM**。建议：
- 买 **2核2G**（¥40-60/月），或
- 1核1G + 加 2G swap（我可以教你配）

---

## 买完之后怎么做（3 种方式，选一种）

### 方式 A：Docker（最简单，推荐）

项目根目录已有 `Dockerfile`（多阶段构建，暴露 3100，`/app/data` 为持久卷，首次启动自动建库并跑迁移）。

```bash
# 1. 传代码到服务器
scp -r pms root@你的服务器IP:/opt/

# 2. 登录服务器
ssh root@你的服务器IP

# 3. 装 Docker（Ubuntu/Debian）
curl -fsSL https://get.docker.com | sh

# 4. 构建并启动
cd /opt/pms
docker build -t pms .
docker run -d \
  --name pms \
  --restart always \
  -p 3100:3100 \
  -v /opt/pms-data:/app/data \
  pms

# 5. 换掉初始口令（第一次，务必保存终端输出）
docker exec -it pms node scripts/reset-demo-passwords.mjs
```

访问 `http://你的服务器IP:3100`

**数据在哪**：`/opt/pms-data/pms.db`（挂载的持久卷，容器重建也不丢）

---

### 方式 B：直接装 Node（不装 Docker）

```bash
# 1. 装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git

# 2. 传代码
scp -r pms root@你的服务器IP:/opt/

# 3. 构建
cd /opt/pms
npm install --legacy-peer-deps
npm run build

# 4. 初始化数据库
node scripts/init-db.mjs

# 5. 用 pm2 常驻
npm install -g pm2
pm2 start "node node_modules/next/dist/bin/next start -p 3100 -H 0.0.0.0" --name pms
pm2 save
pm2 startup   # 开机自启
```

---

### 方式 C：Railway（不碰 Linux）

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Railway 会自动识别 Dockerfile。**注意**：Railway 免费额度有睡眠，付费 $5/月不休眠。

数据挂载：Railway → Settings → Volumes → Mount Path 填 `/app/data`

---

## 配 nginx 反代 + 域名（可选，但要 80/443 端口）

不用域名也能用（`http://IP:3100`），但端口号难看。用 nginx 把它变成 80 端口：

```bash
apt install -y nginx
cat > /etc/nginx/sites-available/pms <<'EOF'
server {
    listen 80;
    server_name _;
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
ln -s /etc/nginx/sites-available/pms /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

然后访问 `http://你的服务器IP`（不用带端口）。

**要 HTTPS**：用 Let's Encrypt 需要域名。没域名就 HTTP 用着（内网测试够）。

---

## 防火牆 / 安全组

**必须放行端口**，否则外网访问不了：

- 云控制台 → 安全组 → 入方向 → 添加规则
- 端口：`3100`（或 `80`）
- 源：`0.0.0.0/0`

---

## 部署后必做

1. **换掉初始口令**：执行 `node scripts/reset-demo-passwords.mjs`（或宿主机 `npm run reset:passwords`），
   会为 4 个初始账号生成随机密码并打印，务必保存。生产模式会直接拒绝 `admin/admin123` 登录。
2. **配 SESSION_SECRET**（容器环境变量，不配则生产模式拒绝登录）：
   ```bash
   docker run ... -e SESSION_SECRET=$(openssl rand -hex 32) pms
   ```
3. **跑上线自检**：`npm run preflight`，确认无 ❌ 项再对外开端口。
4. **配置备份**：`pms.db` 定时备份到对象存储
   ```bash
   # 每天凌晨 3 点备份
   echo "0 3 * * * cp /opt/pms-data/pms.db /opt/backup/pms-\$(date +\%F).db" | crontab -
   ```

---

## 迁移数据：从你本机搬到服务器

本机现在的 `data/pms.db` 有演示数据（46 房间、588 预订等）。搬到服务器：

```bash
# 本机执行
scp "D:/dsh-home/downloads/pms酒管系统/pms/data/pms.db" root@服务器IP:/opt/pms-data/pms.db
```

或者服务器上重新初始化（`node scripts/init-db.mjs`）只带种子数据。

---

## 各方案速度实测参考

| | 首字节 TTFB | 说明 |
| --- | --- | --- |
| 香港轻量服务器 | 30-80 ms | 你的目标 |
| 国内云（已备案） | 20-50 ms | 最快但要备案 |
| Railway 亚洲 | 100-300 ms | 可接受 |
| **Natapp（现在的）** | **200-400 ms** | 快，但依赖你电脑 |
| Vercel | 2200-3600 ms | 慢 |

---

## 现在就能做的

代码这边我已经准备好了：

- ✅ `Dockerfile`（多阶段构建，带持久卷挂载点）
- ✅ 启动时自动跑迁移（幂等，不会重复改表）
- ✅ 索引已补（查询 0.07 ms）
- ✅ 分页已加（页面 281 KB）

**你只需要**：
1. 买服务器（10 分钟）
2. 拿到 IP 和 root 密码
3. 告诉我，我给你逐条命令

或者你自己按上面「方式 A」做，遇到问题再问我。
