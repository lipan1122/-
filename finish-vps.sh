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
#   sudo PMS_LOAD_DEMO=1 bash finish-vps.sh
#
if [ "${PMS_LOAD_DEMO:-0}" = "1" ]; then
  log "导入演示数据（PMS_LOAD_DEMO=1）"
  node scripts/load-demo.mjs --force
else
  log "跳过演示数据（需要的话设 PMS_LOAD_DEMO=1 重跑）"
fi

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
