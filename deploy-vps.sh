#!/usr/bin/env bash
#
# 云栖 PMS 一键部署脚本（Ubuntu 22.04/24.04）
#
# 用法（在 VPS 上以有 sudo 权限的用户执行）：
#   bash deploy-vps.sh
#
# 做的事：
#   1. 装 Node.js 22 + git + 编译工具
#   2. 拉取代码（从 GitHub 公开仓库）
#   3. 生成 SESSION_SECRET，写 .env
#   4. 构建 + 初始化数据库
#   5. 装成 systemd 服务（开机自启、崩溃自动重启）
#   6. 打印访问地址
#
# 幂等：重复执行会更新代码并重启服务，不会重复建库（建库只在 pms.db 不存在时执行）。
set -euo pipefail

APP_DIR="/opt/pms"
APP_USER="${SUDO_USER:-$USER}"
REPO="https://github.com/lipan1122/-.git"
PORT=3100

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[警告] %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 执行：sudo bash deploy-vps.sh"
  exit 1
fi

# ─────────────────────────── 1. 系统依赖 ───────────────────────────
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates build-essential python3 sqlite3 >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 20 ]; then
  log "安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v) / npm $(npm -v)"

# ─────────────────────────── 2. 拉代码 ───────────────────────────
log "准备代码目录 $APP_DIR"
mkdir -p "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  log "已有仓库，拉取最新代码"
  git -C "$APP_DIR" fetch --all -q
  git -C "$APP_DIR" reset --hard origin/main -q
else
  log "首次克隆"
  git clone -q "$REPO" "$APP_DIR"
  cd "$APP_DIR" && git checkout -q main
fi
cd "$APP_DIR"

# ─────────────────────────── 3. 环境变量 ───────────────────────────
log "配置环境变量"
if [ ! -f .env ]; then
  SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  cat > .env <<EOF
# 由 deploy-vps.sh 生成于 $(date -Iseconds)
NODE_ENV=production
PORT=$PORT

# 会话签名密钥（无状态 token），泄露等于会话可伪造，不要提交到仓库
SESSION_SECRET=$SECRET

# 公网部署：HTTPS 未配时先允许 HTTP，否则 Cookie 带 Secure 导致登录不生效。
# 配好 HTTPS 后把它删掉或改成 0。
PMS_ALLOW_HTTP=1

# 演示账号「一键填入」：公网默认关闭，需要演示时改成 1
PMS_DEMO_LOGIN=0

# 自动灌演示数据（AR 账户/商品/积分/销售员）：生产必须 0
PMS_DEMO_SEED=0

# 数据库（默认就是 $APP_DIR/data/pms.db，一般不用改）
# PMS_DB_PATH=$APP_DIR/data/pms.db
EOF
  chmod 600 .env
  log "已生成 .env（SESSION_SECRET 随机 64 位）"
else
  log ".env 已存在，保留原配置"
fi

export NODE_ENV=production

# ─────────────────────────── 4. 构建 ───────────────────────────
log "安装依赖（约 1-2 分钟）"
npm ci --include=dev >/dev/null 2>&1 || npm install --include=dev >/dev/null 2>&1

log "构建（约 1-2 分钟，2G 内存够用；1G 会 OOM）"
npm run build

# ─────────────────────────── 5. 数据库 ───────────────────────────
mkdir -p data
# 判断「是否真的初始化过」，不能只看文件存不存在（VPS 上踩过这个坑）。
#
# npm run build 时 db.ts 会 new DatabaseSync(DB_FILE)，SQLite 会立刻创建
# 一个 4KB 的空库文件（里面一张表都没有）。于是：
#   [ -f data/pms.db ] 为真 → 跳过 init-db → migrate-all 在空库上跑 →
#   Error: no such table: channel_orders
#
# 正确判据是「有多少张表」。init-db 建完 22 张核心表（其余靠 ensure-schema 补），空库 0 张，
# 用 10 作阈值足够区分，也不会因为个别表缺失就误删已有数据。
# 用 node 数表（sqlite3 CLI 不一定装过；node 是硬前提）
TABLE_COUNT=$(node scripts/db-table-count.mjs 2>/dev/null || echo 0)
if [ "${TABLE_COUNT:-0}" -lt 10 ]; then
  log "数据库为空或未初始化（${TABLE_COUNT:-0} 张表），重新建库"
  rm -f data/pms.db data/pms.db-wal data/pms.db-shm
  node scripts/init-db.mjs
else
  log "数据库已初始化（${TABLE_COUNT} 张表），跳过建库"
fi
log "执行幂等迁移"
node scripts/migrate-all.mjs

# 补全表结构（全新部署必跑）
#
# 本项目有 60 张表的建表语句散落在各个 page/action 里，只有页面被访问时才创建。
# 老库上没问题（用久了都建出来了），但全新部署会缺表 —— VPS 上实测过：
#   Error: no such table: shop_sales   → /rooms 500
#   Error: no such column: sort        → /settings 500
#
# sync-schema.mjs 做三件事（三者都幂等，重复跑无害）：
#   1. 缺表 → 从 scripts/schema-full.sql 里取 DDL 建
#   2. 缺列 → ALTER TABLE ADD COLUMN（CREATE TABLE IF NOT EXISTS 补不了这个）
#   3. 缺索引 → CREATE INDEX IF NOT EXISTS
# 对比基准是 scripts/schema-fingerprint.json（从完整库导出的表→列清单）。
log "补全表结构（缺表补表、缺列补列）"
node scripts/sync-schema.mjs

# 去掉单号列的全局 UNIQUE（多店部署必需）
#
# bookings/stays/folios 的单号列原本是列级 UNIQUE（全局唯一），
# 但设计意图是「酒店内唯一」—— 多店部署时 hotel 999 用 hotel 1 的单号会冲突。
# SQLite 不支持 DROP CONSTRAINT，必须重建表（自动 VACUUM INTO 备份 + 幂等）。
log "检查单号唯一约束"
node scripts/rebuild-unique-constraints.mjs

# 可选：导入演示数据（默认不导，显式设 PMS_LOAD_DEMO=1 才导）
#
# 演示数据包含 46 间房 / 588 条预订 / 200 张账单 / 45 个客人 / 会员储值 / AR 应收，
# 适合给客户演示、给同事试用、培训。正式运营不要导，直接在「设置」里录真实房型。
#
#   sudo PMS_LOAD_DEMO=1 bash deploy-vps.sh
#
if [ "${PMS_LOAD_DEMO:-0}" = "1" ]; then
  log "导入演示数据（PMS_LOAD_DEMO=1）"
  node scripts/load-demo.mjs --force
else
  log "跳过演示数据（需要的话设 PMS_LOAD_DEMO=1 重跑）"
fi

# ── 数据收尾：一条命令跑完「结构 + 数据 + 体检」 ──
#
# 前面几步只解决**结构**。真正让系统能对外服务的是后面这串**数据修复**，
# 而它们以前全靠部署完手动一条条敲，顺序还是口口相传的：
#
#   押金残留 → 房态复位 → 演示日期滚动 → 超卖修复 → 客史回填 → 体检
#
# 漏哪一步出事，这个项目全都真实发生过：
#   漏押金修复 → 退房单还挂着押金，在住押金虚高 6800 元
#   漏日期滚动 → 演示库隔一周，21 张在住单全部「逾期 7~11 天」
#   漏超卖修复 → /rooms/predict 显示占用 47 > 总房量 46，出租率 102%
#   漏客史回填 → 在住单没有 guest_id，会员/积分/历史入住全关联不上
#
# scripts/post-deploy.mjs 把这串收成固定顺序 + 每步幂等 + 失败即停 + 最后自体检。
# 重复执行是安全的：第二次跑应该看到「变更 0 处」。
#
# ⚠️ 默认只读，**必须显式 --apply**（不写库的话这条命令只会打印报告）：
#    node scripts/post-deploy.mjs --check   # 只报告（默认行为，部署脚本里不要用这个）
#    node scripts/post-deploy.mjs --apply --structure-only   # 只做结构迁移 + 只读体检（默认）
#    node scripts/post-deploy.mjs --apply --data             # 含数据修复（会自动取消超卖订单，必须人工确认）
# ⚠️ 退出码：0 = 十步全部成功；1 = 有步骤失败（脚本当场停下，不会继续往后跑）。
#    部署不因它中断（服务要能起来），但非 0 必须立刻看上面报告排查。
# ⚠️ 紧跟其后的 chown 不能省！sudo 跑脚本会让 SQLite 创建归属 root 的
#    data/pms.db-wal / -shm，而服务以 $APP_USER 运行 —— 漏了这行，
#    下一个请求就 attempt to write a readonly database（第九轮真踩过）。
if [ -f scripts/post-deploy.mjs ]; then
  log "数据收尾：结构迁移 + 只读体检（--structure-only；数据修复需人工确认后单独跑 --data）"
  if node scripts/post-deploy.mjs --apply --structure-only; then
    log "数据收尾全部通过"
  else
    RC=$?
    warn "数据收尾失败（退出码 $RC）：已按「失败即停」处理，后续步骤未执行，部署继续但请立刻排查"
  fi
else
  warn "scripts/post-deploy.mjs 不存在（老代码？），跳过数据收尾"
  warn "手动补跑：node scripts/migrate-all.mjs && node scripts/fix-deposit-residual.mjs --apply && node scripts/roll-demo-dates.mjs --apply && node scripts/fix-oversell-bookings.mjs --apply && node scripts/backfill-guest-id-last8.mjs --apply"
fi

# 权限：服务以 $APP_USER 运行，data 目录要可写
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# 数据目录归属必须回到服务用户
#
# 部署过程中会多次 （migrate-all / sync-schema / 客史回填等），
# 它们会创建归属 root 的 -wal / -shm 文件。服务以 $APP_USER 运行，
# 结果下一个请求就报 attempt to write a readonly database（第九轮在 VPS 上踩过）。
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/data"

# ─────────────────────────── 6. systemd ───────────────────────────
log "安装 systemd 服务（开机自启 + 崩溃自动重启）"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/pms.service <<EOF
[Unit]
Description=云栖 PMS 酒店管理系统
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN node_modules/next/dist/bin/next start -p $PORT -H 0.0.0.0
Restart=always
RestartSec=5
# 2G 机器上 Node 默认堆可能过大，限制一下避免 OOM killer 直接杀掉
Environment=NODE_OPTIONS=--max-old-space-size=1536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pms >/dev/null 2>&1
systemctl restart pms
sleep 3

# ─────────────────────────── 7. 结果 ───────────────────────────
IP="$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"

log "部署完成"
systemctl --no-pager --lines=0 status pms || true

cat <<EOF

================================================================
  访问地址：  http://$IP:$PORT
  初始账号：  admin / admin123
             （首次登录后请立刻在「设置 → 授权」改密码）

  配置文件：  $APP_DIR/.env
  数据目录：  $APP_DIR/data/pms.db
  服务管理：
    sudo systemctl status pms      # 看状态
    sudo systemctl restart pms     # 重启
    sudo journalctl -u pms -f      # 看日志

  更新代码：
    cd $APP_DIR && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart pms
    （或者重新执行本脚本，它是幂等的）

  防火墙：如果打不开，在云控制台「防火墙/安全组」放行 TCP $PORT
================================================================

EOF
