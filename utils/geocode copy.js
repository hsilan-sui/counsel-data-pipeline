// geocode.js
// WHAT: 讀取診所清單（支援「包 rows」或「平面陣列」），批次將 address → lat/lng 寫回同筆資料。
// HOW : 複合地址拆段（遇到分號直接截斷）→ 清洗(到「號」為止/去樓層地下) → 過濾(必含 路|街|巷|弄|道|大道 + 號)
//       → 變體(35-1號 → 35之1號/35號；巷弄退階；中文段→阿拉伯數字段；道路(+段)+號極簡版)；
//       OpenCage 主查 + (可選) Nominatim 備援；Bottleneck 節流；429/5xx 退避重試；快取；CLI 指定 in/out/cache。
// WHY : 解決「query too long」與噪音片段/細粒度地址造成的 MISS，最大化命中率與穩定性。

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

// ====== CLI：--in / --out / --cache / --nominatim ======
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const envName = `GEOCODE_${name.toUpperCase()}`;
  return process.env[envName] || def;
}
const INPUT_JSON  = path.resolve(arg('in',   path.join(__dirname, 'clinics_wrapped.json')));
const OUTPUT_JSON = path.resolve(arg('out',  path.join(__dirname, 'clinics_wrapped_geocoded.json')));
const CACHE_JSON  = path.resolve(arg('cache',path.join(__dirname, 'geocode-cache.json')));
const USE_NOMINATIM = args.includes('--nominatim') || String(process.env.GEOCODE_NOMINATIM || '').toLowerCase() === 'true';
const NOMINATIM_UA = process.env.NOMINATIM_USER_AGENT || 'crawler_counseling_geocoder/1.2 (+https://example.com)';

console.log('[PATH]', { INPUT_JSON, OUTPUT_JSON, CACHE_JSON, USE_NOMINATIM });

// ====== 地理與節流 ======
const TAIWAN_BOUNDS = [119.5, 21.5, 122.5, 25.5].join(','); // WGS84：minLon,minLat,maxLon,maxLat
const limiter = new Bottleneck({ minTime: 1200, maxConcurrent: 1 }); // ≤1 req/s（保守 1.2s）

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
  : {}; // { "<normalizedQuery>": { lat, lng, confidence, formatted, source } }

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

// ====== 字串工具 ======
function normalizeTWAddress(addr = '') {
  return String(addr)
    .replace(/台/g, '臺')        // OSM 對「臺」友善
    .replace(/\s+/g, '')         // 去空白
    .replace(/台灣|臺灣/g, '')    // 移除國名
    .replace(/RepublicofChina/gi, '');
}

// 只保留到「號」為止（去括號、去樓層/室別/地下等）
function trimToHouseNo(s = '') {
  const x = String(s)
    .replace(/（.*?）|\(.*?\)/g, '')   // 去括號
    .replace(/(地下\d*|地下一|B\d+|[一二三四五六七八九十\d]+樓(?:之\d+)?|之\d+室|室\d+).*/g, ''); // 樓層/室別等
  const i = x.indexOf('號');
  return i >= 0 ? x.slice(0, i + 1) : x;
}

// 中文「一段/二段…」 → 阿拉伯數字版本（也保留原版一起查）
function sectionArabicVariant(s = '') {
  const map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
  return s.replace(/([一二三四五六七八九十])段/g, (_, c) => `${map[c]}段`);
}

// 35-1號 → 35之1號 / 35號（都試試）
function hyphenNumberVariants(s = '') {
  const m = s.match(/(\d+)-(\d+)號/);
  if (!m) return [s];
  const [_, a, b] = m;
  const v1 = s.replace(/(\d+)-(\d+)號/, `${a}之${b}號`);
  const v2 = s.replace(/(\d+)-(\d+)號/, `${a}號`);
  return [s, v1, v2];
}

// 巷弄退階：原 / 去弄 / 去巷 / 同時去巷+弄（保留號）
function alleyDegradeVariants(s = '') {
  const out = new Set([s]);
  // 去「弄XXX」（保留號）
  out.add(s.replace(/弄\d+(?:-\d+)?號/, '號'));
  // 去「巷XXX」（若後面接 弄...號 或 直接號）
  out.add(s.replace(/巷\d+(?:-\d+)?(?=(?:弄\d+(?:-\d+)?)?號)/, ''));
  // 同時去「巷」與「弄」
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

// ====== 複合地址拆段（關鍵修正：分號後面整段丟掉） ======
function splitCompositeSegments(address = '') {
  // 先移括號內容
  let s = String(address).replace(/（.*?）|\(.*?\)/g, '');
  // ✅ 遇到分號直接截斷：分號後多為備註（例如「;地下1樓」）
  s = s.split(/[;；]/)[0];
  // 其他標點→「、」，連接詞→「、」
  s = s.replace(/[，,。\.]/g, '、').replace(/及|和|與/g, '、');
  return s.split('、').map(x => x.trim()).filter(Boolean);
}

// 從完整地址萃取「縣市 + 區/鄉鎮市」前綴
function extractRegionPrefix(full = '') {
  const s = String(full);
  let m = s.match(/^([\u4e00-\u9fa5]{2,3}[縣市][\u4e00-\u9fa5]{1,3}[區鄉鎮市])/);
  if (m) return m[1];
  m = s.match(/^([\u4e00-\u9fa5]{2,3}[縣市])/);
  return m ? m[1] : '';
}
function hasRegionInfo(seg = '') {
  return /[縣市].*[區鄉鎮市]/.test(seg) || /[\u4e00-\u9fa5]{2,3}[縣市]/.test(seg);
}

// 限長（避免任何 query too long）；以 URL 編碼長度判斷
function clampQuery(q, maxBytes = 512, fallbackChars = 120) {
  return encodeURIComponent(q).length <= maxBytes ? q : q.slice(0, fallbackChars);
}

// 只保留「道路(+段)+號」的極簡版（吃阿拉伯數字段版本）
function roadOnlyVariant(s = '') {
  const t = sectionArabicVariant(s);
  // group1: 道路名稱（優先配「大道」，其次「道/路/街」）
  // group2: 可選「N段」
  // group3: 門牌號（含連字號）
  const m = t.match(/^(.+?(?:大道|道|路|街))(?:((?:\d+)段))?(?:\d+(?:-\d+)?巷)?(?:\d+(?:-\d+)?弄)?(\d+(?:-\d+)?)號$/);
  if (!m) return null;
  const road = m[1], sec = m[2] || '', no = m[3];
  return `${road}${sec}${no}號`;
}

// 建立「單段」候選（到號為止 + 變體）
function buildSingleSegmentVariants(seg, orgName, regionPrefix) {
  const segWithRegion = hasRegionInfo(seg) ? seg : (regionPrefix ? regionPrefix + seg : seg);
  const base = trimToHouseNo(segWithRegion);          // 到「號」為止
  const withArabic = sectionArabicVariant(base);      // 一段 → 1段 的版本
  const bases = Array.from(new Set([base, withArabic].filter(Boolean)));

  const candidates = new Set();
  for (const b of bases) {
    for (const h of hyphenNumberVariants(b)) {
      for (const a of alleyDegradeVariants(h)) {
        candidates.add(a);
        if (orgName) candidates.add(orgName + a); // 名稱 + 地址也試
        const ro = roadOnlyVariant(a);            // 極簡：道路(+段)+號
        if (ro) {
          candidates.add(ro);
          if (orgName) candidates.add(orgName + ro);
        }
      }
    }
  }

  // 標準化、過濾非位址、限長
  const out = [];
  for (const c of candidates) {
    const q = normalizeTWAddress(c);
    if (!looksLikeAddress(q)) continue; // 丟掉「地下1樓」這類非地址片段
    out.push(clampQuery(q));
  }
  return Array.from(new Set(out));
}

// 建立「一筆 row」的候選查詢（多段 × 多變體）
function buildQueryCandidates(row) {
  const segments = splitCompositeSegments(row.address || '');
  const prefix = extractRegionPrefix(row.address || '');
  const cand = [];
  for (const seg of segments) {
    cand.push(...buildSingleSegmentVariants(seg, row.org_name || '', prefix));
  }
  return Array.from(new Set(cand)); // 去重
}

// ====== 打 API（單次）======
async function geocodeAddressOneOC(q) {
  const params = {
    key: API_KEY,
    q,
    countrycode: 'tw',
    language: 'zh-TW',
    limit: 1,
    no_annotations: 1,
    bounds: TAIWAN_BOUNDS
  };
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
    source: 'opencage'
  };
}

async function geocodeAddressOneNominatim(q) {
  const params = {
    format: 'jsonv2',
    q,
    limit: 1,
    addressdetails: 0,
    countrycodes: 'tw',
    bounded: 1,
    viewbox: '119.5,25.5,122.5,21.5' // 左上、右下
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
    source: 'nominatim'
  };
}

// ====== 退避重試（429/5xx/網路錯誤）；4xx 視為 miss ======
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
      if (status && status >= 400 && status < 500) return null; // 4xx 當 miss
      throw err;
    }
  }
}

// ====== 單筆解析（多變體 + 備援）======
async function resolveOneRow(row) {
  const queries = buildQueryCandidates(row);

  // 1) 快取
  for (const q of queries) {
    if (cache[q]) return { geo: cache[q], usedQuery: q };
  }

  // 2) OpenCage
  for (const q of queries) {
    const geo = await withRetry(() => geocodeAddressOneOC(q));
    if (geo) { cache[q] = geo; return { geo, usedQuery: q }; }
  }

  // 3) Nominatim 備援（可選）
  if (USE_NOMINATIM) {
    for (const q of queries) {
      const geo = await withRetry(() => geocodeAddressOneNominatim(q));
      if (geo) { cache[q] = geo; return { geo, usedQuery: q }; }
    }
  }

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
        const shownQ = usedQuery.length > 40 ? usedQuery.slice(0, 40) + '…' : usedQuery;
        console.log(`[OK ${i + 1}/${rows.length}] ${r.org_name || ''} | ${r.address || ''} -> ${geo.lat}, ${geo.lng} (src=${geo.source}${geo.confidence != null ? `, conf=${geo.confidence}` : ''}) q="${shownQ}"`);
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
