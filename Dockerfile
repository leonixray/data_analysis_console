# 数据分析管控台 — 独立运行镜像（Bun）。
#
# 构建上下文是仓库根目录：`docker build -t data-analysis-console .`
# （或 `docker compose up --build`）。
#
# 构建阶段做两件事：装 standalone/ 的依赖（postinstall 会在仓库根
# 建一个 node_modules 软链，供 Tailwind 编译 CSS @import 用），再跑
# `bun run build` 产出客户端（standalone/dist）与服务端包
# （standalone/dist-server/server.js）。
# 运行阶段只留运行时需要的文件：服务端包、客户端静态文件、drizzle
# 迁移（启动时建表）、.env.example（对照用）。数据库与密钥都不进
# 镜像：数据库走 /data 卷，密钥走 .env / 环境变量。

FROM oven/bun:1 AS build
WORKDIR /app
COPY standalone/package.json standalone/bun.lock ./standalone/
RUN cd standalone && bun install --frozen-lockfile
COPY . .
RUN cd standalone && bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/standalone/dist ./standalone/dist
COPY --from=build /app/standalone/dist-server ./standalone/dist-server
COPY --from=build /app/.env.example ./.env.example

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/app.db
ENV REFRESH_INTERVAL_MINUTES=60

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://localhost:3000/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["bun", "standalone/dist-server/server.js"]
