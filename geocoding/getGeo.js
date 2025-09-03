const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// 輸入 / 輸出路徑
const inputPath = path.join(__dirname, '21_金門縣_merged_clean'); // ✅ 改成你的檔名
const outputPath = path.join(__dirname, '21_金門縣_merged_clean_with_coords.json');

// 讀取資料
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const clinics = data.rows || data; // 判斷是否在 rows 裡

// 正則擷取經緯度
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
        headless: false, // 改為 false 開啟視窗
        slowMo: 500,
        args: ['--start-maximized'] // 最大化視窗（可選）    // 每個操作延遲 500ms

      });
  const page = await browser.newPage();

  for (let i = 0; i < clinics.length; i++) {
    const clinic = clinics[i];

    if (clinic.lat && clinic.lng) continue; // 已有經緯度就跳過
    if (!clinic.map_url) continue;

    console.log(`🔍 (${i + 1}/${clinics.length}) ${clinic.org_name} → 開啟地圖`);

    try {
      await page.goto(clinic.map_url, { timeout: 10000 });
      await page.waitForTimeout(3000); // 等跳轉
      const url = page.url();
      const coords = extractLatLngFromUrl(url);
      if (coords) {
        clinic.lat = coords.lat;
        clinic.lng = coords.lng;
        console.log(`✅ 經緯度：(${coords.lat}, ${coords.lng})`);
      } else {
        console.warn(`⚠️ 擷取失敗：${clinic.map_url}`);
      }
    } catch (err) {
      console.error(`❌ 讀取失敗：${clinic.map_url}`, err.message);
    }

    await page.waitForTimeout(1500); // 延遲避免被 ban
  }

  await browser.close();

  // 輸出
  fs.writeFileSync(outputPath, JSON.stringify({ rows: clinics }, null, 2), 'utf-8');
  console.log(`🎉 完成！已寫入 ${outputPath}`);
})();
