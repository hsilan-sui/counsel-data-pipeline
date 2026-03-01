IMAGE_NAME=clinics-crawler

.PHONY: build run-crawler shell cloud-job

build:
	docker build -t $(IMAGE_NAME) .

# 本地流程（覆寫 CMD，直接跑你的 script）
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

# 本地除錯：進容器
shell:
	docker run --rm -it \
		-e OPENCAGE_API_KEY=$(OPENCAGE_API_KEY) \
		-e NOMINATIM_USER_AGENT="suihsilan-crawler/1.0" \
		-v $(PWD):/app -w /app \
		$(IMAGE_NAME) bash

# 模擬 Cloud Run Job：直接跑 entrypoint.sh（不覆寫 CMD）
cloud-job:
	docker run --rm \
		-e OPENCAGE_API_KEY=$(OPENCAGE_API_KEY) \
		-e GH_PAT=dummy \
		-e NOMINATIM_USER_AGENT="suihsilan-crawler/1.0" \
		-e GCS_BUCKET=counsel-data \
		$(IMAGE_NAME)
