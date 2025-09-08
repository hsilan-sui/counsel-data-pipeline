# 設定一個變數 IMAGE_NAME，後面 docker build / run 都會用到
IMAGE_NAME=clinics-crawler

# .PHONY 告訴 make：以下這些名稱不是實際檔案，而是指令
.PHONY: build run-crawler shell

# =============================
# build：建置 Docker 映像
# =============================
# - 用 docker build 建立一個映像，名字叫 $(IMAGE_NAME)
# - Dockerfile 會在當前目錄裡尋找
build:
	docker build -t $(IMAGE_NAME) .

# =============================
# run-crawler：本地一鍵跑完整流程
# =============================
# - 用 docker run 啟動容器
# - 帶入兩個環境變數：
#     OPENCAGE_API_KEY（從本地環境傳進去）
#     NOMINATIM_USER_AGENT（自訂 UA）
# - 掛載目前目錄 $(PWD) → 容器內的 /app
# - 工作目錄設為 /app
# - 容器內要執行的流程：
#   1. 建立 out 資料夾
#   2. 跑爬蟲：輸出 taiwan_merged_clean.json
#   3. geocode-diff-merge：
#        - 跟 public/clinics.json 比對
#        - 新診所做 geocode，寫回 public/clinics.json
#        - 並產出 out/new_clinics.json
#   4. 驗證 JSON schema
#   5. 檢查 total 欄位是否正確
run-crawler:
	docker run --rm \
		-e OPENCAGE_API_KEY=$(OPENCAGE_API_KEY) \
		-e NOMINATIM_USER_AGENT="suihsilan-crawler/1.0" \
		-v $(PWD):/app \
		-w /app \
		$(IMAGE_NAME) \
		bash -lc '\
			mkdir -p out && \
			node src/index.js --out ./out/taiwan_merged_clean.json && \
			node src/geocode-diff-merge.js \
				--clean ./out/taiwan_merged_clean.json \
				--prev  ./public/clinics.json \
				--cache ./data/geocode-cache.json \
				--out   ./public/clinics.json \
				--diff  ./out/new_clinics.json && \
			npm run validate && \
			node scripts/check-total.js public/clinics.json \
		'

# =============================
# shell：進入容器內部除錯
# =============================
# - 開一個互動式容器（-it）
# - 帶入相同環境變數
# - 把本地目錄掛到 /app
# - 進去之後直接跑 bash，可以手動下指令測試
shell:
	docker run --rm -it \
		-e OPENCAGE_API_KEY=$(OPENCAGE_API_KEY) \
		-e NOMINATIM_USER_AGENT="suihsilan-crawler/1.0" \
		-v $(PWD):/app -w /app \
		$(IMAGE_NAME) bash
