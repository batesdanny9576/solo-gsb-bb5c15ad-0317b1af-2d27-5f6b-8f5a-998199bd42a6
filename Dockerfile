FROM node:20-alpine

WORKDIR /app

# 先单独拷贝依赖清单，利用构建层缓存；npm ci 严格按 package-lock.json 安装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY replay.js ./
COPY compare.js ./
COPY archive.js ./
COPY public ./public
# public/replay-core.js 同时被浏览器 <script> 与 Node（compare.js）require 复用，
# 已随 public 目录一并拷入；两侧执行同一份事件折叠内核

# 事件日志目录：未挂载卷时容器也能直接读写（挂载 ./data 时由宿主机目录覆盖）
RUN mkdir -p data

ENV PORT=3000
EXPOSE 3000

# 容器内自检：单条 docker compose up 即可确认服务已就绪（仅打本机只读接口）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/replay/sessions',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
