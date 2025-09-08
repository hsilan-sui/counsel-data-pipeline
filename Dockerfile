# 放在 FROM 後、任何 apt 指令之前
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Taipei

# 安裝 tzdata / curl / ca-certificates / jq（非互動）
RUN set -eux; \
    ln -fs /usr/share/zoneinfo/${TZ} /etc/localtime; \
    apt-get update; \
    apt-get install -y --no-install-recommends tzdata curl ca-certificates jq; \
    dpkg-reconfigure -f noninteractive tzdata; \
    rm -rf /var/lib/apt/lists/*


# 預設不啟動；由外部 docker run 指令決定要跑什麼


# # 對齊 Playwright 版本（若 v1.54.2 tag 取不到，可用 v1.54.0-jammy 或 v1.54-jammy）
# FROM mcr.microsoft.com/playwright:v1.54.2-jammy

# WORKDIR /app

# # 先拷貝 lock 檔，讓層快取有效
# COPY package.json package-lock.json ./
# RUN npm ci

# # 再拷貝程式碼
# COPY . .

# # 可選：若你的程式只用 Chromium，程式碼中 launch 時加 { channel: 'chromium' } 即可
# # 基底 image 已帶好瀏覽器與依賴，通常不必再 install
# # RUN npx playwright install chromium

# # 可選：若你要讓容器直接執行主程式，可加 CMD
# # 但你的 workflow 會用 docker run 覆蓋命令，所以不強制加
# # CMD ["node", "src/index.js"]
