FROM node:20-slim
ENV DEBIAN_FRONTEND=noninteractive

# （精簡版依賴，足夠跑 Chromium；要更穩可用你之前較長那份）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libcups2 libxshmfence1 libgbm1 libpango-1.0-0 libasound2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只複製 lock 檔，利用快取
COPY package.json package-lock.json ./

# ⭐ 一定要把 devDependencies 裝進來（playwright 在這裡）
RUN npm ci --include=dev

# ⭐ 立即驗證「套件在 node_modules 裡」
RUN node -e "console.log('resolve:', require.resolve('playwright'))"

# ⭐ 要求 npx 使用『本地』套件，不許臨時下載
RUN npx --no-install playwright --version

# ⭐ 安裝對應版本的瀏覽器與系統依賴
RUN npx --no-install playwright install --with-deps

# 再拷貝程式碼（因為有 .dockerignore，不會覆蓋 node_modules）
COPY . .

# （可選）執行階段再切 production，避免影響上述 npm ci
ENV NODE_ENV=production
