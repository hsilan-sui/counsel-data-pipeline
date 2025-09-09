# ✅ 基底：Node 20 slim
FROM node:20-slim

# ✅ 非互動安裝
ENV DEBIAN_FRONTEND=noninteractive

# ✅ Chromium 需要的系統依賴（精簡版，足夠跑）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libcups2 libxshmfence1 libgbm1 libpango-1.0-0 libasound2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ✅ 先複製 lock 檔讓快取有效
COPY package.json package-lock.json ./

# ✅ 安裝包含 devDependencies（playwright 在 dev）
RUN npm ci --include=dev

# ✅ 當場驗證「模組存在」；這一步出錯就代表沒裝成功
RUN node -e "console.log('resolve:', require.resolve('playwright'))"

# ✅ 使用『本地』playwright（禁止臨時下載），列出版本確認
RUN npx --no-install playwright --version

# ✅ 下載對應版本的瀏覽器 + 系統依賴
RUN npx --no-install playwright install --with-deps

# ✅ 再拷貝程式碼（請搭配 .dockerignore，避免覆蓋 node_modules）
COPY . .

# （可選）執行階段切 production，避免影響上面的 npm ci
ENV NODE_ENV=production
