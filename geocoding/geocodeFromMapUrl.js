const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// 檔案路徑設定
const inputPath = path.join(__dirname, 'taiwan_merged_clean.json'); // ✅ 你的輸入檔
const outputPath = path.join(__dirname, 'taiwan_with_coords.json');
const failedPath = path.join(__dirname, 'failed.json');

// 讀取輸入資料
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const clinics = data.rows || data;

// 嘗試從舊的輸出檔恢復進度（中斷續跑）
if (fs.existsSync(outputPath)) {
  const prev = JSON.parse(fs.readFileSync(outputPath, 'utf-8')).rows || [];
  prev.forEach((item, idx) => {
    if (item.lat && item.lng && clinics[idx]) {
      clinics[idx].lat = item.lat;
      clinics[idx].lng = item.lng;
    }
  });
  console.log('🔄 已從舊檔案恢復進度');
}

// 從 URL 擷取經緯度
function extractLatLngFromUrl(url) {
  const match = url.match(/@([\d.]+),([\d.]+),/);
  if (match) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  return null;
}

// 主程式
(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
    args: ['--start-maximized'],
  });

  const page = await browser.newPage();
  const failed = [];

  for (let i = 0; i < clinics.length; i++) {
    const clinic = clinics[i];

    if (clinic.lat && clinic.lng) continue;
    if (!clinic.map_url) continue;

    console.log(`🔍 (${i + 1}/${clinics.length}) ${clinic.org_name}`);

    try {
      await page.goto(clinic.map_url, { timeout: 15000 });
      await page.waitForTimeout(3000);

      const url = page.url();
      const coords = extractLatLngFromUrl(url);

      if (coords) {
        clinic.lat = coords.lat;
        clinic.lng = coords.lng;
        console.log(`✅ (${coords.lat}, ${coords.lng})`);
      } else {
        console.warn(`⚠️ 擷取失敗：${clinic.map_url}`);
        failed.push({ name: clinic.org_name, url: clinic.map_url });
      }
    } catch (err) {
      console.error(`❌ 讀取失敗：${clinic.map_url}`, err.message);
      failed.push({ name: clinic.org_name, url: clinic.map_url, error: err.message });
    }

    await page.waitForTimeout(1000);
  }

  await browser.close();

  // 儲存結果
  fs.writeFileSync(outputPath, JSON.stringify({ rows: clinics }, null, 2), 'utf-8');
  fs.writeFileSync(failedPath, JSON.stringify(failed, null, 2), 'utf-8');

  const done = clinics.filter(c => c.lat && c.lng).length;
  console.log(`🎉 完成！共 ${done}/${clinics.length} 筆有經緯度，錯誤 ${failed.length} 筆`);
})();
