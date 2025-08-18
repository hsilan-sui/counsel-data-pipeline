const fs = require('fs');
const axios = require('axios');
const path = require('path');

// 輸入 / 輸出檔案路徑
const inputPath = path.join(__dirname, 'test.json'); // ✅ 改成你的檔名
const outputPath = path.join(__dirname, 'taiwan_with_coords.json');

const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const clinics = data.rows || data; // 看你的結構是 rows 陣列或直接陣列

// Nominatim 免費地理編碼函式
async function geocodeNominatim(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'clinic-geocoder/1.0 (suihsilan@email.com)' // 建議加上 email 避免被 ban
      }
    });
    if (res.data && res.data.length > 0) {
      const loc = res.data[0];
      return { lat: parseFloat(loc.lat), lng: parseFloat(loc.lon) };
    }
    return null;
  } catch (err) {
    console.error(`❌ 查詢失敗: ${address}`, err.message);
    return null;
  }
}

// 主程序：逐筆查地址並補上 lat/lng
(async () => {
    for (let i = 0; i < clinics.length; i++) {
      const c = clinics[i];
      if (c.lat && c.lng) continue; // 已有經緯度就跳過
  
      const fullAddress = `${c.county || ''}${c.address}, Taiwan`;  // ✅ 加上縣市 + Taiwan
  
      console.log(`🔍 (${i + 1}/${clinics.length}) 查詢：${c.org_name} (${fullAddress})`);
  
      const coords = await geocodeNominatim(fullAddress);
      if (coords) {
        c.lat = coords.lat;
        c.lng = coords.lng;
        console.log(`✅ 找到：(${coords.lat}, ${coords.lng})`);
      } else {
        console.warn(`⚠️ 找不到位址：${fullAddress}`);
      }
  
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  
    fs.writeFileSync(outputPath, JSON.stringify({ rows: clinics }, null, 2), 'utf-8');
    console.log(`🎉 已補完經緯度，寫入 ${outputPath}`);
  })();
  