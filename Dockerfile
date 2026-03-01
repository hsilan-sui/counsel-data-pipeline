# Dockerfile
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci \
 && npx playwright install --with-deps   # 把瀏覽器裝進 image
COPY . .
CMD ["node", "src/index.js"]
