# 云栖 PMS 生产镜像
# 构建：docker build -t pms .
# 运行：docker run -d -p 3100:3100 -e SESSION_SECRET=<随机值> -v /opt/pms-data:/app/data pms

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/package-lock.json /app/.npmrc ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/.env.example ./.env.example
RUN mkdir -p /app/data

EXPOSE 3100
VOLUME ["/app/data"]

# 首次启动自动建库；已有挂载卷时只跑幂等迁移。
# 注意：不要在这里设 PMS_ALLOW_HTTP —— 公网部署由 docker run 传入 SESSION_SECRET，
# 不设该变量才会启用 HTTPS Cookie、登录锁定与初始口令拦截。
CMD ["sh", "-c", "if [ ! -f /app/data/pms.db ]; then node scripts/init-db.mjs; fi; node scripts/migrate-all.mjs; exec node node_modules/next/dist/bin/next start -p 3100 -H 0.0.0.0"]
