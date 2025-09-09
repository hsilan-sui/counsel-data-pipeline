# 輕量 + 穩定（你也可用 node:20-bullseye）
FROM node:20-slim

# 非互動、prod 環境
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production

# 建議先裝必要系統套件，確保 playwright 安裝依賴順利
# --no-install-recommends 可保持映像小
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    # 字型（避免中文亂碼/方塊字），可視需求增減
    fonts-noto fonts-noto-cjk \
    # 常見瀏覽器依賴（npx playwright install --with-deps 也會處理大多數）
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libcups2 libxshmfence1 libgbm1 libpango-1.0-0 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先複製 lock 檔，讓快取生效
COPY package.json package-lock.json ./
RUN npm ci

# 依你 package.json 版本（^1.54.2）安裝對應瀏覽器與系統依賴
# --with-deps 會自動處理 OS 依賴，能補齊上面沒裝齊的套件
RUN npx playwright install --with-deps

# 再拷貝程式碼
COPY . .

# 預設由 CI 指定要跑什麼指令（不設 CMD/ENTRYPOINT）
