/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ====== 可調整設定 ======
const INPUT      = path.join(__dirname, '21_金門縣_merged_clean.json');
const OUTPUT     = path.join(__dirname, '21_金門縣_merged_clean_with_coords.json');
const FAILED_OUT = path.join(__dirname, 'failed.json');

// 是否信任既有 lat/lng（若你想覆蓋錯誤座標，設 false）
const TRUST_EXISTING = false;

// 等待 URL/DOM 出現座標的最長時間
const WAIT_MS = 15000;

// ====== 工具 ======
const isTWLat = (lat) => Number.isFinite(lat) && lat >= 21 && lat <= 26.5;
const isTWLng = (lng) => Number.isFinite(lng) && lng >= 119 && lng <= 123.5;

function normalizeLatLng(lat, lng) {
  // 防呆：若寫反，就交換
  const ok = isTWLat(lat) && isTWLng(lng);
  const swapped = isTWLat(lng) && isTWLng(lat);
  if (ok) return { lat, lng };
  if (!ok && swapped) return { lat: lng, lng: lat };
  return { lat, lng };
}

// 多種 URL 解析：@lat,lng、!3dLAT!4dLNG、q=lat,lng、ll=lat,lng
function extractLatLngFromUrl(url) {
  if (!url) return null;

  // @23.9741167,121.600954
  let m = url.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (isTWLat(lat) && isTWLng(lng)) return { lat, lng, from: '@' };
  }

  // !3d23.9741167!4d121.6035289（可能出現多組，取最後一組）
  const all34 = [...url.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  if (all34.length) {
    const last = all34[all34.length - 1];
    const lat = parseFloat(last[1]), lng = parseFloat(last[2]);
    if (isTWLat(lat) && isTWLng(lng)) return { lat, lng, from: '!3d4d' };
  }

  // &q=lat,lng 或 ll=lat,lng
  m = url.match(/[?&](?:q|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (isTWLat(lat) && isTWLng(lng)) return { lat, lng, from: 'q/ll' };
  }

  return null;
}

// 從 <meta property="og:image"> 或 <meta itemprop="image"> 解析 center / markers
function extractLatLngFromOgImage(ogUrl) {
  if (!ogUrl) return null;
  try {
    // center=LAT%2CLNG
    let m = ogUrl.match(/[?&]center=(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (isTWLat(lat) && isTWLng(lng)) return { lat, lng, from: 'og:center' };
    }
    // markers=LAT%2CLNG 或 markers=LAT,LNG
    m = ogUrl.match(/[?&]markers=(-?\d+(?:\.\d+)?)[,%](-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (isTWLat(lat) && isTWLng(lng)) return { lat, lng, from: 'og:markers' };
    }
  } catch {}
  return null;
}

// 從 DOM 抓 og:image
async function getOgImageContent(page) {
  return page.evaluate(() => {
    const m = document.querySelector('meta[property="og:image"], meta[itemprop="image"]');
    return m ? m.content : null;
  });
}

// ====== 讀入資料 ======
const input = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
const clinics = input.rows || input;

// 續跑：從舊 OUTPUT 套回已成功的座標
if (fs.existsSync(OUTPUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8')).rows || [];
    prev.forEach((item, idx) => {
      if (item.lat && item.lng && clinics[idx]) {
        clinics[idx].lat = item.lat;
        clinics[idx].lng = item.lng;
      }
    });
    console.log('🔄 已從舊輸出恢復進度');
  } catch {}
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
    args: ['--start-maximized'],
  });
  const context = await browser.newContext({
    viewport: null,         // 讓它使用整個視窗
    locale: 'zh-TW',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
  });
  const page = await context.newPage();

  const failed = [];

  for (let i = 0; i < clinics.length; i++) {
    const c = clinics[i];

    // 需要抓新座標的條件
    const hasCoords = Number.isFinite(c.lat) && Number.isFinite(c.lng);
    if (TRUST_EXISTING && hasCoords) {
      continue; // 信任舊值就跳過
    }

    if (!c.map_url) {
      if (!hasCoords) failed.push({ i, name: c.org_name, reason: 'no_map_url' });
      continue;
    }

    console.log(`🔍 (${i + 1}/${clinics.length}) ${c.org_name}`);

    try {
      await page.goto(c.map_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 等待 URL/DOM 出現座標線索
      await page.waitForFunction(() => {
        const url = location.href;
        const hasAt = /@-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?/.test(url);
        const has34 = /!3d-?\d+(\.\d+)?!4d-?\d+(\.\d+)?/.test(url);
        const og = document.querySelector('meta[property="og:image"], meta[itemprop="image"]');
        return hasAt || has34 || !!og;
      }, { timeout: WAIT_MS }).catch(() => {});

      // 先試 URL
      const urlNow = page.url();
      let coords = extractLatLngFromUrl(urlNow);

      // 不行就試 og:image
      if (!coords) {
        const og = await getOgImageContent(page);
        if (og) coords = extractLatLngFromOgImage(og);
      }

      if (coords) {
        const fixed = normalizeLatLng(coords.lat, coords.lng);
        if (isTWLat(fixed.lat) && isTWLng(fixed.lng)) {
          c.lat = fixed.lat;
          c.lng = fixed.lng;
          console.log(`✅ ${c.org_name} -> (${fixed.lat}, ${fixed.lng}) [${coords.from}]`);
        } else {
          console.warn(`⚠️ 解析座標超出台灣範圍：${coords.lat}, ${coords.lng}`);
          failed.push({ i, name: c.org_name, url: c.map_url, reason: 'out_of_tw', urlNow });
        }
      } else {
        console.warn(`⚠️ 解析失敗：${c.map_url}`);
        failed.push({ i, name: c.org_name, url: c.map_url, reason: 'no_coords_in_url_or_meta', urlNow });
      }
    } catch (err) {
      console.error(`❌ 讀取失敗：${c.map_url}`, err.message);
      failed.push({ i, name: c.org_name, url: c.map_url, error: err.message });
    }

    // 小停頓，避免被當爬蟲封鎖太快
    await page.waitForTimeout(300);
  }

  await browser.close();

  // 儲存
  fs.writeFileSync(OUTPUT, JSON.stringify({ rows: clinics }, null, 2), 'utf-8');
  fs.writeFileSync(FAILED_OUT, JSON.stringify(failed, null, 2), 'utf-8');

  const done = clinics.filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng)).length;
  console.log(`🎉 完成！共 ${done}/${clinics.length} 筆有經緯度，錯誤 ${failed.length} 筆`);
})();
