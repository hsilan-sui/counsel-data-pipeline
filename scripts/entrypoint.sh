#!/usr/bin/env bash
set -euo pipefail

: "${OPENCAGE_API_KEY:?missing}"
: "${NOMINATIM_USER_AGENT:=suihsilan-crawler/1.0}"
: "${GCS_BUCKET:=counsel-data}"
: "${GCS_PATH_CURRENT:=clinics/current/clinics.json}"
: "${GCS_PATH_SNAPSHOT:=clinics/snapshots}"
: "${GH_REPO:=hsilan-sui/counsel-data-pipeline}"
: "${GH_PAT:?missing}"
: "${DISPATCH_TYPE:=clinics_update}"
: "${REGION:=asia-east1}"

mkdir -p public data out

echo "📥 下載上一版（若無則空物件）"
node -e "require('./src/gcs-io').downloadOrEmpty(process.env.GCS_BUCKET, process.env.GCS_PATH_CURRENT, 'public/clinics.json')"

echo '🕷️  執行爬蟲'
node src/index.js --out ./out/taiwan_merged_clean.json

echo '🧩  合併 + geocode + diff'
node src/geocode-diff-merge.js \
  --clean ./out/taiwan_merged_clean.json \
  --prev  ./public/clinics.json \
  --cache ./data/geocode-cache.json \
  --out   ./out/next_clinics.json \
  --diff  ./out/new_clinics.json

echo '✅  資料驗證'
npm run validate
node scripts/check-total.js ./out/next_clinics.json

CHANGE_COUNT=$(node -e "const fs=require('fs');try{process.stdout.write(String(JSON.parse(fs.readFileSync('./out/new_clinics.json','utf8')).length||0))}catch(e){process.stdout.write('0')}")
if [ "${CHANGE_COUNT}" -gt 0 ]; then
  echo "🔁 偵測到 ${CHANGE_COUNT} 筆變更，開始上傳與 dispatch"
  SNAP_TS=$(date -u +%Y%m%dT%H%M%SZ)

  node -e "require('./src/gcs-io').upload(process.env.GCS_BUCKET, './out/next_clinics.json', process.env.GCS_PATH_CURRENT)"
  node -e "require('./src/gcs-io').upload(process.env.GCS_BUCKET, './out/next_clinics.json', process.env.GCS_PATH_SNAPSHOT + '/clinics_${SNAP_TS}.json')"

  echo "📡  發送 repository_dispatch 到 ${GH_REPO}"
  curl -sS -X POST \
    -H "Authorization: token ${GH_PAT}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GH_REPO}/dispatches" \
    -d @- <<EOF
{
  "event_type": "${DISPATCH_TYPE}",
  "client_payload": {
    "gcs_uri": "gs://${GCS_BUCKET}/${GCS_PATH_CURRENT}",
    "snapshot": "gs://${GCS_BUCKET}/${GCS_PATH_SNAPSHOT}/clinics_${SNAP_TS}.json",
    "change_count": ${CHANGE_COUNT},
    "region": "${REGION}"
  }
}
EOF

  echo "🎉 已送出 repository_dispatch"
else
  echo "ℹ️ 無差異，結束 Job。"
fi
