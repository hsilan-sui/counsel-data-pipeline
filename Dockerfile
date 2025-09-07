# 對齊 Playwright 版本（若 1.54.2 tag 找不到，可改 v1.54.0-jammy 或 v1.54-jammy）
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

# 先拷貝 lock 檔，讓快取生效
COPY package.json package-lock.json ./
# 需要 ajv（devDependencies），因此不要在這裡設 NODE_ENV=production
RUN npm ci

# 再拷貝程式碼
COPY . .

# 如果只需要 Chromium，可在程式上限定；基底 image 已帶好瀏覽器與系統相依
# RUN npx playwright install chromium

# 如需正式執行時只暴露生產環境，可在最底下再設環境變數
# ENV NODE_ENV=production
