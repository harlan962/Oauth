# syntax=docker/dockerfile:1

# ---- 构建阶段：编译前端 ----
FROM node:22.15.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 运行阶段：仅生产依赖 + 构建产物 ----
FROM node:22.15.0-alpine
ENV NODE_ENV=production \
    ACCOUNT_DESK_HOST=0.0.0.0 \
    ACCOUNT_DESK_DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
VOLUME /app/data
EXPOSE 4318 4319
CMD ["node", "server/index.js"]
