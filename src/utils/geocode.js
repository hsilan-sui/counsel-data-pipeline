// geocode.js
// WHAT: 讀取診所清單（支援「包 rows」或「平面陣列」），批次將 address → lat/lng 寫回同筆資料。
// HOW : 分號截斷 → 到「號」為止/去樓層 → 過濾(必含 路|街|巷|弄|道|大道 + 號)
//       → 變體(35-1號→35之1號/35號；巷弄退階；中文段→阿拉伯數字段；中文數字街/巷/弄→阿拉伯數字；道路(+段)+號極簡；臺/台雙形)
//       → OpenCage 主查(加上縣市 proximity + 行政區驗證) + (可選) Nominatim 備援
//       → 找不到門牌就街道保底，再不行退行政區/縣市中心；Bottleneck 節流；429/5xx 退避重試；快取；CLI 指定 in/out/cache。
// WHY : 解決跨縣市誤配與資料覆蓋不足，降低 MISS / 錯位。

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios').default;
const Bottleneck = require('bottleneck');

// ====== 必要金鑰 ======
const API_KEY = process.env.OPENCAGE_API_KEY;
if (!API_KEY) {
  console.error('❌ 缺少金鑰：請在 .env 設定 OPENCAGE_API_KEY=你的金鑰');
  process.exit(1);
}

// ====== CLI：--in / --out / --cache / --nominatim / --debug ======
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const envName = `GEOCODE_${name.toUpperCase()}`;
  return process.env[envName] || def;
}
const INPUT_JSON   = path.resolve(arg('in',   path.join(__dirname, 'clinics_wrapped.json')));
const OUTPUT_JSON  = path.resolve(arg('out',  path.join(__dirname, 'clinics_wrapped_geocoded.json')));
const CACHE_JSON   = path.resolve(arg('cache',path.join(__dirname, 'geocode-cache.json')));
const USE_NOMINATIM = args.includes('--nominatim') || String(process.env.GEOCODE_NOMINATIM || '').toLowerCase() === 'true';
const DEBUG         = args.includes('--debug') || String(process.env.GEOCODE_DEBUG || '').toLowerCase() === 'true';
const NOMINATIM_UA  = process.env.NOMINATIM_USER_AGENT || 'crawler_counseling_geocoder/1.5 (+https://example.com)';

console.log('[PATH]', { INPUT_JSON, OUTPUT_JSON, CACHE_JSON, USE_NOMINATIM, DEBUG });

// ====== 地理與節流 ======
const TAIWAN_BOUNDS = [119.5, 21.5, 122.5, 25.5].join(','); // WGS84：minLon,minLat,maxLon,maxLat
const limiter = new Bottleneck({ minTime: 1200, maxConcurrent: 1 }); // ≤1 req/s（保守 1.2s）

// ====== 縣市重心（proximity bias）======
const COUNTY_CENTROIDS = {
  '臺北市': [25.0375, 121.5637], '台北市': [25.0375, 121.5637],
  '新北市': [25.012, 121.463],
  '桃園市': [24.993, 121.301],
  '新竹市': [24.8047, 120.9714],
  '新竹縣': [24.838, 121.007],
  '苗栗縣': [24.56, 120.82],
  '臺中市': [24.1477, 120.6736], '台中市': [24.1477, 120.6736],
  '彰化縣': [24.08, 120.54],
  '南投縣': [23.96, 120.97],
  '雲林縣': [23.708, 120.543],
  '嘉義市': [23.48, 120.44],
  '嘉義縣': [23.46, 120.32],
  '臺南市': [22.9997, 120.227], '台南市': [22.9997, 120.227],
  '高雄市': [22.627, 120.301],
  '屏東縣': [22.676, 120.494],
  '宜蘭縣': [24.757, 121.754],
  '花蓮縣': [23.976, 121.604],
  '臺東縣': [22.758, 121.144], '台東縣': [22.758, 121.144],
  '澎湖縣': [23.565, 119.586],
  '金門縣': [24.449, 118.37],
  '連江縣': [26.157, 119.95],
  '基隆市': [25.128, 121.741]
};

// ====== 讀檔 & 快取 ======
if (!fs.existsSync(INPUT_JSON)) {
  console.error(`❌ 找不到輸入檔：${INPUT_JSON}\n請確認路徑或用 --in 指定正確位置。`);
  process.exit(1);
}
let raw;
try {
  raw = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
} catch (e) {
  console.error('❌ 讀取/解析輸入檔失敗，請確認 JSON 格式是否正確：', e.message);
  process.exit(1);
}

const cache = fs.existsSync(CACHE_JSON)
  ? JSON.parse(fs.readFileSync(CACHE_JSON, 'utf8'))
  : {}; // { "<normalizedQuery>": { lat, lng, confidence, formatted, source, components, approx? } }

// 支援兩種輸入：A) { county,total,rows:[...] }  B) [ ... ]
let wrapper, rows;
if (Array.isArray(raw)) {
  wrapper = { county: '', total: raw.length, rows: raw };
  rows = wrapper.rows;
} else if (raw && Array.isArray(raw.rows)) {
  wrapper = raw;
  rows = raw.rows;
} else {
  console.error('❌ 輸入 JSON 結構不符，需為「陣列」或「含 rows 的物件」。');
  process.exit(1);
}

// ====== 中文數字工具（十/十一/二十 等 1–99）======
const zhDigit = { '零':0,'〇':0,'一':1,'二':2,'兩':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9 };
function parseZh1to99(s = '') {
  s = s.trim();
  if (!s) return null;
  if (s === '十') return 10;
  let m = s.match(/^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] ? zhDigit[m[1]] : 1;
    const ones = m[2] ? zhDigit[m[2]] : 0;
    return tens * 10 + ones;
  }
  if (/^[零〇一二兩三四五六七八九]$/.test(s)) return zhDigit[s];
  return null;
}
// 「中文數字 + (街|巷|弄)」→ 阿拉伯數字（保留原字串＋數字版）
function streetOrdinalArabicVariants(s = '') {
  const out = new Set([s]);
  const replaced = s.replace(/([零〇一二兩三四五六七八九十]{1,3})(?=(街|巷|弄))/g, (m) => {
    const n = parseZh1to99(m);
    return (n != null) ? String(n) : m;
  });
  if (replaced !== s) out.add(replaced);
  return Array.from(out);
}

// ====== 字串工具 ======
function normalizeTWAddress(addr = '') {
  return String(addr)
    .replace(/^\s*\d{3,5}(?:[-\s])?/, '') // 去掉開頭郵遞區號（710/71087…）
    .replace(/\s+/g, '')                   // 去空白
    .replace(/台灣|臺灣/g, '')             // 移除國名
    .replace(/RepublicofChina/gi, '');
}
// 產生「臺/台」雙形
function taiVariants(s = '') {
  const a = s.replace(/台/g, '臺');
  const b = s.replace(/臺/g, '台');
  return Array.from(new Set([a, b]));
}

// 去括號/樓層；只保留到「號」
function trimToHouseNo(s = '') {
  const x = String(s)
    .replace(/（.*?）|\(.*?\)/g, '')   // 去括號
    .replace(/(地下\d*|地下一|B\d+|[一二三四五六七八九十\d]+樓(?:之\d+)?|之\d+室|室\d+).*/g, ''); // 樓層/室別等
  const i = x.indexOf('號');
  return i >= 0 ? x.slice(0, i + 1) : x;
}
// 去門牌（保留到路/街/巷/弄）
function dropHouseNo(s='') {
  return String(s).replace(/\d+(?:-\d+)?號.*$/, '');
}

// 中文「一段/二段…」 → 阿拉伯數字版本（也保留原版一起查）
function sectionArabicVariant(s = '') {
  const map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
  return s.replace(/([一二三四五六七八九十])段/g, (_, c) => `${map[c]}段`);
}

// 35-1號 → 35之1號 / 35號
function hyphenNumberVariants(s = '') {
  const m = s.match(/(\d+)-(\d+)號/);
  if (!m) return [s];
  const [_, a, b] = m;
  const v1 = s.replace(/(\d+)-(\d+)號/, `${a}之${b}號`);
  const v2 = s.replace(/(\d+)-(\d+)號/, `${a}號`);
  return [s, v1, v2];
}

// 巷弄退階
function alleyDegradeVariants(s = '') {
  const out = new Set([s]);
  out.add(s.replace(/弄\d+(?:-\d+)?號/, '號'));
  out.add(s.replace(/巷\d+(?:-\d+)?(?=(?:弄\d+(?:-\d+)?)?號)/, ''));
  let noBoth = s.replace(/巷\d+(?:-\d+)?/g, '').replace(/弄\d+(?:-\d+)?/g, '');
  if (!/號/.test(noBoth)) {
    const m = s.match(/(\d+(?:-\d+)?)號/);
    if (m) noBoth = noBoth.replace(/$/, m[0]);
  }
  out.add(noBoth);
  return Array.from(out);
}

// 位址合理性檢查：必須同時含「(路|街|巷|弄|道|大道)」之一，且含「號」
function looksLikeAddress(s = '') {
  return /(路|街|巷|弄|道|大道)/.test(s) && /號/.test(s);
}

// ====== 把「里」移除（常見：關東里光復路…）======
function removeNeighborhoodLi(s='') {
  // 僅在路名/門牌前面出現時移除
  return s.replace(/[\u4e00-\u9fa5]{1,4}里(?=[^號]*?(路|街|巷|弄|道|大道))/g, '');
}

// ====== 複合地址拆段（分號後面整段丟掉）======
function splitCompositeSegments(address = '') {
  let s = String(address).replace(/（.*?）|\(.*?\)/g, '');
  s = s.split(/[;；]/)[0];
  s = removeNeighborhoodLi(s);
  s = s.replace(/[，,。\.]/g, '、').replace(/及|和|與/g, '、');
  return s.split('、').map(x => x.trim()).filter(Boolean);
}

// 行政區前綴/拆解
function parseRegionParts(full = '') {
  const s = String(full);
  const m = s.match(/^([\u4e00-\u9fa5]{2,3}[縣市])([\u4e00-\u9fa5]{1,3}[區鄉鎮市])?/);
  return { county: m ? m[1] : '', district: (m && m[2]) ? m[2] : '' };
}
function hasRegionInfo(seg = '') {
  return /[縣市].*[區鄉鎮市]/.test(seg) || /[\u4e00-\u9fa5]{2,3}[縣市]/.test(seg);
}

// 限長（避免任何 query too long）
function clampQuery(q, maxBytes = 512, fallbackChars = 120) {
  return encodeURIComponent(q).length <= maxBytes ? q : q.slice(0, fallbackChars);
}

// 道路(+段)+號 極簡（吃阿拉伯數字段版本）
function roadOnlyVariant(s = '') {
  const t = sectionArabicVariant(s);
  const m = t.match(/^(.+?(?:大道|道|路|街))(?:((?:\d+)段))?(?:\d+(?:-\d+)?巷)?(?:\d+(?:-\d+)?弄)?(\d+(?:-\d+)?)號$/);
  if (!m) return null;
  const road = m[1], sec = m[2] || '', no = m[3];
  return `${road}${sec}${no}號`;
}

// 最後一個「…大道/道/路/街」token（純路名）
function extractLastRoadToken(s = '') {
  const all = Array.from(String(s).matchAll(/([^\d、，；;（）()\s]+?(?:大道|道|路|街))/g));
  if (all.length === 0) return null;
  let token = all[all.length - 1][1];
  const m = token.match(/([^\d、，；;（）()\s]+?(?:大道|道|路|街))$/);
  if (m) token = m[1];
  return Array.from(new Set([token.replace(/台/g, '臺'), token.replace(/臺/g, '台')]));
}

// ====== 建立候選查詢（含：中文數字街/巷/弄 → 阿拉伯數字；臺/台雙形；行政區組合）======
function buildSingleSegmentVariants(seg, orgName, fullAddress) {
  const { county, district } = parseRegionParts(fullAddress);
  const segWithRegion = hasRegionInfo(seg) ? seg : (county || district ? county + district + seg : seg);
  const base0 = trimToHouseNo(segWithRegion);

  // 依序展開：段數字化 → 街/巷/弄中文數字數字化
  const bases = new Set();
  for (const b1 of [base0, sectionArabicVariant(base0)].filter(Boolean)) {
    for (const b2 of streetOrdinalArabicVariants(b1)) bases.add(b2);
  }

  const candidates = new Set();
  for (const b of bases) {
    for (const h of hyphenNumberVariants(b)) {
      for (const a of alleyDegradeVariants(h)) {
        candidates.add(a);
        if (orgName) candidates.add(orgName + a);

        const ro = roadOnlyVariant(a);
        if (ro) {
          candidates.add(ro);
          if (orgName) candidates.add(orgName + ro);
          const { county, district } = parseRegionParts(fullAddress);
          if (county) {
            candidates.add(county + ro);
            if (orgName) candidates.add(orgName + county + ro);
          }
          if (district) {
            candidates.add(district + ro);
            if (orgName) candidates.add(orgName + district + ro);
          }
          if (county || district) candidates.add((county || '') + (district || '') + ro);
        }
      }
    }
  }

  // 標準化（臺/台雙形）＋位址過濾＋限長
  const out = new Set();
  for (const c of candidates) {
    for (const t of taiVariants(c)) {
      const q = clampQuery(normalizeTWAddress(t));
      if (looksLikeAddress(q)) out.add(q);
    }
  }
  return Array.from(out);
}

function buildQueryCandidates(row) {
  const segments = splitCompositeSegments(row.address || '');
  const cand = [];
  for (const seg of segments) {
    cand.push(...buildSingleSegmentVariants(seg, row.org_name || '', row.address || ''));
  }
  return Array.from(new Set(cand));
}

// ====== proximity & 驗證 ======
function getExpectedCounty(row) {
  // 以欄位為主，否則從地址拆
  return (row.county && String(row.county).trim()) || parseRegionParts(row.address || '').county || '';
}
function getProximity(row) {
  const county = getExpectedCounty(row);
  return COUNTY_CENTROIDS[county] || null;
}
function countyMatches(components = {}, formatted = '', expectedCounty = '') {
  if (!expectedCounty) return true; // 沒得比就不限制
  const text = [
    components.city, components.town, components.village,
    components.county, components.state, components.region,
    formatted
  ].filter(Boolean).join('|');
  return text.includes(expectedCounty) || text.includes(expectedCounty.replace(/臺/g, '台')) || text.includes(expectedCounty.replace(/台/g, '臺'));
}

// ====== 打 API（單次）======
async function geocodeAddressOneOC(q, proximityLatLng) {
  const params = {
    key: API_KEY,
    q,
    countrycode: 'tw',
    language: 'zh-TW',
    limit: 1,
    no_annotations: 1,
    bounds: TAIWAN_BOUNDS
  };
  if (proximityLatLng) params.proximity = proximityLatLng.join(',');
  const url = 'https://api.opencagedata.com/geocode/v1/json';
  const res = await axios.get(url, { params, timeout: 15000 });
  const data = res.data;
  if (!data || !data.results || data.results.length === 0) return null;

  const best = data.results[0];
  return {
    lat: best.geometry.lat,
    lng: best.geometry.lng,
    confidence: best.confidence ?? null,
    formatted: best.formatted ?? null,
    components: best.components || {},
    source: 'opencage'
  };
}

async function geocodeAddressOneNominatim(q) {
  const params = {
    format: 'jsonv2',
    q,
    limit: 1,
    addressdetails: 1,
    countrycodes: 'tw',
    bounded: 1,
    viewbox: '119.5,25.5,122.5,21.5'
  };
  const url = 'https://nominatim.openstreetmap.org/search';
  const res = await axios.get(url, {
    params,
    timeout: 15000,
    headers: { 'User-Agent': NOMINATIM_UA }
  });
  const arr = res.data;
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const best = arr[0];
  return {
    lat: parseFloat(best.lat),
    lng: parseFloat(best.lon),
    confidence: null,
    formatted: best.display_name || null,
    components: best.address || {},
    source: 'nominatim'
  };
}

// ====== 退避重試 ======
async function withRetry(fn, { retries = 3, baseDelayMs = 1500 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const status = err.response?.status;
      const retriable = status === 429 || (status >= 500 || !status);
      if (attempt <= retries && retriable) {
        const delay = baseDelayMs * attempt;
        console.warn(`[WARN] 重試第 ${attempt} 次，狀態=${status || 'network'}，等待 ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (status && status >= 400 && status < 500) return null;
      throw err;
    }
  }
}

// ====== 街道保底 → 回傳街道中心點 ======
function buildStreetCentroidCandidates(fullAddress = '', orgName = '') {
  const { county, district } = parseRegionParts(fullAddress);
  const roadOnlyBase = dropHouseNo(trimToHouseNo(fullAddress)) || fullAddress;
  const roadTokens = extractLastRoadToken(roadOnlyBase); // 「調和街／自由路／…」
  if (!roadTokens || roadTokens.length === 0) return [];

  const out = new Set();
  for (const road of roadTokens) {
    if (county || district) out.add((county || '') + (district || '') + road);
    if (county) out.add(county + road);
    if (district) out.add(district + road);
    out.add(road);

    if (orgName) {
      if (county || district) out.add(orgName + (county || '') + (district || '') + road);
      if (county) out.add(orgName + county + road);
      if (district) out.add(orgName + district + road);
      out.add(orgName + road);
    }
  }

  // 也把原本「縣市+區+路」的臺/台雙形丟進去
  for (const v of taiVariants(roadOnlyBase)) {
    const vv = normalizeTWAddress(v);
    if (/(大道|道|路|街)/.test(vv)) out.add(vv);
  }

  return Array.from(out).map(q => clampQuery(q)).sort((a, b) => b.length - a.length);
}

async function streetCentroidFallback(fullAddress, orgName, proximity) {
  const qs = buildStreetCentroidCandidates(fullAddress, orgName);
  for (const q of qs) {
    const geo = await withRetry(() => geocodeAddressOneOC(q, proximity));
    if (geo) return { ...geo, approx: 'street', usedQuery: q };
  }
  if (USE_NOMINATIM) {
    for (const q of qs) {
      const geo = await withRetry(() => geocodeAddressOneNominatim(q));
      if (geo) return { ...geo, approx: 'street', usedQuery: q };
    }
  }
  return null;
}

// ====== 行政區/縣市中心保底 ======
async function adminCentroidFallback(row, proximity) {
  const { county, district } = parseRegionParts(row.address || '');
  const tries = [];
  if (county && district) tries.push(county + district);
  if (county) tries.push(county);

  for (const q of tries) {
    const geo = await withRetry(() => geocodeAddressOneOC(q, proximity));
    if (geo) return { ...geo, approx: 'admin', usedQuery: q };
  }

  // 最後用內建縣市中心
  const prox = getProximity(row);
  if (prox) {
    return {
      lat: prox[0],
      lng: prox[1],
      confidence: null,
      formatted: (county || '') + (district || '') || 'county-centroid',
      components: {},
      source: 'centroid',
      approx: 'county_table',
      usedQuery: 'county_table'
    };
  }
  return null;
}

// ====== 單筆解析（多變體 + proximity + 行政區驗證 + 多層保底）======
async function resolveOneRow(row) {
  const queries = buildQueryCandidates(row);
  const proximity = getProximity(row);
  const expectedCounty = getExpectedCounty(row);

  // 1) 快取
  for (const q of queries) {
    const hit = cache[q];
    if (hit && countyMatches(hit.components, hit.formatted, expectedCounty)) {
      return { geo: hit, usedQuery: q };
    }
  }

  // 2) OpenCage（縣市 proximity + 行政區驗證）
  for (const q of queries) {
    const geo = await withRetry(() => geocodeAddressOneOC(q, proximity));
    if (geo && countyMatches(geo.components, geo.formatted, expectedCounty)) {
      cache[q] = geo; return { geo, usedQuery: q };
    }
  }

  // 3) Nominatim 備援（若啟用）
  if (USE_NOMINATIM) {
    for (const q of queries) {
      const geo = await withRetry(() => geocodeAddressOneNominatim(q));
      if (geo && countyMatches(geo.components, geo.formatted, expectedCounty)) {
        cache[q] = geo; return { geo, usedQuery: q };
      }
    }
  }

  // 4) 街道中心保底
  const street = await streetCentroidFallback(row.address || '', row.org_name || '', proximity);
  if (street && countyMatches(street.components, street.formatted, expectedCounty)) {
    return { geo: street, usedQuery: street.usedQuery };
  }

  // 5) 行政區/縣市中心保底
  const admin = await adminCentroidFallback(row, proximity);
  if (admin) return { geo: admin, usedQuery: admin.usedQuery };

  return { geo: null, usedQuery: queries[0] || '' };
}

// ====== Main ======
async function main() {
  let success = 0, miss = 0, error = 0;
  const outRows = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const task = limiter.schedule(() => resolveOneRow(r));

    try {
      const { geo, usedQuery } = await task;
      if (geo) {
        outRows.push({ ...r, ...geo });
        success++;
        const extras = [
          `src=${geo.source}`,
          geo.confidence != null ? `conf=${geo.confidence}` : null,
          geo.approx ? `approx=${geo.approx}` : null
        ].filter(Boolean).join(', ');
        const shownQ = usedQuery && usedQuery.length > 60 ? usedQuery.slice(0, 60) + '…' : usedQuery;
        console.log(`[OK ${i + 1}/${rows.length}] ${r.org_name || ''} | ${r.address || ''} -> ${geo.lat}, ${geo.lng} (${extras}) q="${shownQ}"`);
      } else {
        outRows.push({ ...r, lat: null, lng: null, note: 'No result' });
        miss++;
        console.warn(`[MISS ${i + 1}/${rows.length}] ${r.org_name || ''} | ${r.address || ''}`);
      }
      fs.writeFileSync(CACHE_JSON, JSON.stringify(cache, null, 2), 'utf8'); // 每筆即時落盤
    } catch (e) {
      error++;
      const msg = e.response?.data || e.message;
      console.error(`[ERR ${i + 1}/${rows.length}] ${r.org_name || ''} | ${r.address || ''} →`, msg);
      outRows.push({ ...r, lat: null, lng: null, error: String(msg) });
    }
  }

  const output = { ...wrapper, rows: outRows };
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n完成 ✅ 成功=${success}，MISS=${miss}，ERR=${error}`);
  console.log(`輸出檔：${OUTPUT_JSON}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
