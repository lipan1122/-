#!/usr/bin/env bash
#
# 补完部署的最后三步（代码已经拉好、build 已经成功时用这个）
#
# 场景：deploy-vps.sh 在 `npm run build` 阶段失败过（database is locked），
# 后来修好重跑 build 成功了，但脚本已经中断 —— 所以
# 「初始化数据库」「幂等迁移」「装 systemd 服务」三步没执行。
#
# 这个脚本只做那三步，不重新 build。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/lipan1122/-/main/finish-vps.sh | sudo bash
#
set -euo pipefail

APP_DIR="/opt/pms"
PORT=3100
APP_USER="${SUDO_USER:-ubuntu}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[失败] %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 sudo 执行"
[ -d "$APP_DIR" ] || die "$APP_DIR 不存在，请先跑 deploy-vps.sh"
cd "$APP_DIR"

# ─────────────── 0. 前置检查：构建产物必须存在 ───────────────
if [ ! -f .next/BUILD_ID ]; then
  die ".next/BUILD_ID 不存在 —— 构建没成功，请先跑：cd $APP_DIR && sudo npm run build"
fi
log "构建产物检查通过（BUILD_ID: $(cat .next/BUILD_ID)）"

# ─────────────── 1. 环境变量 ───────────────
if [ ! -f .env ]; then
  log "生成 .env"
  SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  cat > .env <<ENVEOF
NODE_ENV=production
PORT=$PORT
SESSION_SECRET=$SECRET
PMS_ALLOW_HTTP=1
PMS_DEMO_LOGIN=0
PMS_DEMO_SEED=0
ENVEOF
  chmod 600 .env
else
  log ".env 已存在，保留"
fi
# 关键项兜底（.env 可能不完整）
grep -q '^SESSION_SECRET=' .env || echo "SESSION_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")" >> .env
grep -q '^PMS_ALLOW_HTTP=' .env || echo "PMS_ALLOW_HTTP=1" >> .env

# ─────────────── 2. 数据库 ───────────────
mkdir -p data
if [ ! -f data/pms.db ]; then
  log "首次初始化数据库（建表 + 基础配置，不含演示订单）"
  node scripts/init-db.mjs
else
  log "数据库已存在（$(du -h data/pms.db | cut -f1)），跳过初始化"
fi

log "执行幂等迁移"
node scripts/migrate-all.mjs

log "数据库概况"
sqlite3 data/pms.db "SELECT '房间 ' || COUNT(*) || ' 间' FROM rooms; SELECT '用户 ' || COUNT(*) || ' 个' FROM users;" 2>/dev/null || true

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ─────────────── 3. systemd ───────────────
log "安装 systemd 服务"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/pms.service <<SVCEOF
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
Environment=NODE_OPTIONS=--max-old-space-size=1536

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable pms >/dev/null 2>&1
systemctl restart pms
sleep 4

log "服务状态"
systemctl --no-pager --lines=8 status pms || true

# ─────────────── 4. 自检 ───────────────
log "本机自检"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/login" || echo 000)"
if [ "$CODE" = "200" ]; then
  echo "  ✓ http://127.0.0.1:$PORT/login 返回 200"
else
  echo "  ✗ 本机返回 $CODE，看日志：sudo journalctl -u pms -n 50 --no-pager"
fi

IP="$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"

cat <<DONE

================================================================
  部署完成

  访问地址：  http://$IP:$PORT
  初始账号：  admin / admin123
             front / 123456     前台
             cashier / 123456   收银
             housekeeper / 123456 客房

  ⚠ 上线前请：设置 → 授权 → 重置这 4 个账号的密码

  常用命令：
    sudo systemctl status pms
    sudo systemctl restart pms
    sudo journalctl -u pms -f

  如果外网打不开，去腾讯云控制台 → 防火墙，放行 TCP $PORT
================================================================

DONE
