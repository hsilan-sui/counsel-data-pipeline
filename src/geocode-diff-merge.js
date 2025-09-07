#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* ================ 工具函數 ================ */
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function toWrapper(rows, county='全台灣') { return { county, total: rows.length, rows }; }

function normalizePhone(s='') {
  return String(s || '').replace(/[^\d]/g, ''); // 只保留數字
}
function domainOf(url='') {
  try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
}
function pushMap(map, key, val) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(val);
}
// 只保留 geocode 相關欄位
function pickGeo(r={}) {
  const { lat, lng, confidence, formatted, components, source, approx, usedQuery, note } = r;
  return { lat, lng, confidence, formatted, components, source, approx, usedQuery, note };
}

/* ================ CLI/ENV 參數 ================ */
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const env = process.env[`GEODIFF_${name.toUpperCase()}`];
  return env ?? def;
}

const CLEAN_IN   = path.resolve(arg('clean',  './out/taiwan_merged_clean.json')); // 今日爬蟲輸出
const PREV_FULL  = path.resolve(arg('prev',   './public/clinics.json'));         // 昨日完整 geocoded
const CACHE_JSON = path.resolve(arg('cache',  './data/geocode-cache.json'));     // geocode 快取
const OUT_FULL   = path.resolve(arg('out',    './public/clinics.json'));         // 最終輸出
const DIFF_OUT   = path.resolve(arg('diff',   './out/new_clinics.json'));        // 新診所清單
const TMP_DIR    = path.resolve(arg('tmpdir', './.tmp-geodiff'));
const USE_NOMI   = (arg('nominatim', 'true') + '').toLowerCase() === 'true';
const DEBUG      = (arg('debug', 'false') + '').toLowerCase() === 'true';

console.log('[geocode-diff] paths:', { CLEAN_IN, PREV_FULL, CACHE_JSON, OUT_FULL, DIFF_OUT });

/* ================ 讀入檔案 ================ */
if (!fs.existsSync(CLEAN_IN)) {
  console.error('❌ 找不到最新 clean 檔：', CLEAN_IN);
  process.exit(1);
}
const cleanRaw  = readJSON(CLEAN_IN);
const cleanRows = Array.isArray(cleanRaw?.rows) ? cleanRaw.rows
  : Array.isArray(cleanRaw) ? cleanRaw : [];

const prevRaw  = fs.existsSync(PREV_FULL) ? readJSON(PREV_FULL) : { county:'全台灣', total:0, rows:[] };
const prevRows = Array.isArray(prevRaw?.rows) ? prevRaw.rows : [];

/* ================ 建索引（電話 & 網域） ================ */
const prevByPhone  = new Map();
const prevByDomain = new Map();

for (const old of prevRows) {
  pushMap(prevByPhone,  normalizePhone(old.phone), old);
  pushMap(prevByDomain, domainOf(old.org_url) || domainOf(old.map_url), old);
}

/* ================ 差異挑選 ================ */
const needGeo = [];
const carryFromPrev = [];

for (const r of cleanRows) {
  const phoneKey  = normalizePhone(r.phone);
  const domainKey = domainOf(r.org_url) || domainOf(r.map_url);

  let match = null;

  if (phoneKey && prevByPhone.has(phoneKey)) {
    match = prevByPhone.get(phoneKey).find(x => x.lat != null && x.lng != null);
  } else if (domainKey && prevByDomain.has(domainKey)) {
    match = prevByDomain.get(domainKey).find(x => x.lat != null && x.lng != null);
  }

  if (match) {
    carryFromPrev.push({ ...r, ...pickGeo(match) });
  } else {
    needGeo.push(r);
  }
}

console.log(`📦 今日總筆數：${cleanRows.length}`);
console.log(`↩︎ 沿用舊座標：${carryFromPrev.length}`);
console.log(`🧭 需要 geocode：${needGeo.length}`);

/* ================ 輸出新診所清單 ================ */
writeJSON(DIFF_OUT, needGeo);
console.log(`🆕 新診所清單已輸出：${DIFF_OUT}`);

/* ================ 無需 geocode → 直接輸出 ================ */
if (needGeo.length === 0) {
  writeJSON(OUT_FULL, toWrapper(carryFromPrev));
  console.log(`✅ 完成（無需 geocode），輸出：${OUT_FULL}`);
  process.exit(0);
}

/* ================ 執行 geocode.js 處理新診所 ================ */
fs.mkdirSync(TMP_DIR, { recursive: true });
const tmpIn  = path.join(TMP_DIR, 'need-geocode.json');
const tmpOut = path.join(TMP_DIR, 'need-geocoded.json');

writeJSON(tmpIn, toWrapper(needGeo));

const nomiFlag = USE_NOMI ? ['--nominatim'] : [];
const env = { ...process.env, GEOCODE_DEBUG: DEBUG ? 'true' : 'false' };

console.log('🚀 執行 geocode.js（僅新診所）...');
const proc = spawnSync(process.execPath, [
  path.resolve('src/geocode.js'),
  '--in', tmpIn,
  '--out', tmpOut,
  '--cache', CACHE_JSON,
  ...nomiFlag
], { stdio: 'inherit', env });

if (proc.status !== 0) {
  console.error('❌ geocode.js 執行失敗');
  process.exit(proc.status || 1);
}

/* ================ 合併結果 ================ */
const newly = readJSON(tmpOut);
const newlyRows = Array.isArray(newly?.rows) ? newly.rows : [];

// 用 phone+domain 作 key
function key3(r) {
  return `${normalizePhone(r.phone)}|${domainOf(r.org_url)||domainOf(r.map_url)}`;
}
const mapNew = new Map(newlyRows.map(r => [key3(r), r]));

const finalRows = [];
for (const r of cleanRows) {
  const carried = carryFromPrev.find(x => key3(x) === key3(r));
  if (carried) { finalRows.push(carried); continue; }

  const n = mapNew.get(key3(r));
  if (n) { finalRows.push({ ...r, ...pickGeo(n) }); continue; }

  // fallback → 沒找到就當無座標
  finalRows.push({ ...r, lat:null, lng:null });
}

// 輸出完整 clinics.json
writeJSON(OUT_FULL, toWrapper(finalRows));
console.log(`✅ 完成合併，輸出：${OUT_FULL}`);
