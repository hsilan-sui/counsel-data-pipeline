// 我把「逐縣市 → 有名額 → 無名額 → 關閉 → 下一縣市」做成迴圈了，並且幫你把全台合併的 JSON/CSV 一起輸出（功能1+功能2一次到位）。重點做法：

// 動態抓下拉選單 #county 的所有 option，不用手刻代碼表。

// 每個縣市：

// 查「有名額」→ 讀 UI「共N頁」→ 點「下一頁」(N-1) 次

// 關閉表單 → 回首頁重開

// 查「無名額」→ 同上

// 存該縣市 *_yes_raw.json、*_no_raw.json、*_merged_clean.json/csv

// 最後把全台合併：taiwan_merged_clean.json / taiwan_merged_clean.csv

// 檔名格式：out/<代碼>_<縣市名>_*.json/csv（代碼會自動以 option 的 value 補零到 2 位）
// 把「人類化操作 / 防抖動」整包都融合進你的多縣市版程式，包含：

// 隨機 viewport / 裝置縮放 / 色彩模式

// 人類化停頓 humanPause()（短/中/長/換縣市）

// 偏移點擊 + 滑鼠軌跡 humanClickEl()

// 觸發查詢、點「下一頁」都改用人類化點擊

// 在關鍵步驟穿插自然停頓、換縣市加長休息

// index.js — 逐縣市：有名額→無名額→關閉→下一縣市；並輸出全台合併 JSON/CSV
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://sps.mohw.gov.tw/mhs';
const FORM = `${BASE}/Home/QueryServiceOrg`;
const OUT  = path.resolve('./out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---------- 小工具 ---------- */
const sleep  = (ms)=>new Promise(r=>setTimeout(r, ms));
const jitter = (ms, j=500)=> ms + Math.floor(Math.random()*j);
const toInt  = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const pad2   = v => String(v).padStart(2, '0');

const unesc = s => typeof s === 'string'
  ? s.replace(/\\u003c/g,'<').replace(/\\u003e/g,'>').replace(/\\u0026/g,'&').replace(/&amp;/g,'&')
  : s;

function parseAnchor(html) {
  if (!html) return { text: null, href: null };
  const s = unesc(String(html));
  const m = s.match(/<a[^>]*href=['"]([^'"]+)['"][^>]*>(.*?)<\/a>/i);
  if (m) return { href: unesc(m[1]) || null, text: unesc(m[2].replace(/<[^>]*>/g,'')) };
  return { text: unesc(s.replace(/<[^>]*>/g,'')), href: null };
}
function toCSV(rows, headers) {
  const esc = v => (v === null || v === undefined) ? '' : /[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return [headers.join(','), ...rows.map(r=>headers.map(h=>esc(r[h])).join(','))].join('\n');
}

/* ---------- 清洗 / 合併 / 去重 ---------- */
function cleanRows(rows) {
  return (rows || []).map(r => {
    const org  = parseAnchor(r.orgName);
    const addr = parseAnchor(r.address);
    const o = {
      county: r.countyName ?? null,
      org_name: org.text,
      org_url: (org.href && org.href !== '無') ? org.href : null,
      phone: r.phone ?? null,
      address: addr.text,
      map_url: (addr.href && addr.href !== '無') ? addr.href : null,
      pay_detail: r.payDetail ?? null,
      this_week: toInt(r.thisWeekCount),
      next_week: toInt(r.nextWeekCount),
      next_2_week: toInt(r.next2WeekCount),
      next_3_week: toInt(r.next3WeekCount),
      in_4_weeks: toInt(r.in4WeekTotleCount),
      edit_date: r.editDate ?? null,
      teleconsultation: r.strTeleconsultation === '是'
    };
    // 若要「任一週 > 0」改判：o.this_week + o.next_week + o.next_2_week + o.next_3週 > 0
    o.has_quota = o.in_4_weeks > 0;
    return o;
  });
}
function mergeYesNo(yesRows, noRows) {
  const key = r => `${r.county}||${r.org_name}||${r.address}`.trim();
  const map = new Map();
  [...yesRows, ...noRows].forEach(r => {
    const k = key(r);
    if (!map.has(k)) map.set(k, r);
    else {
      const p = map.get(k);
      map.set(k, {
        ...p,
        this_week:   Math.max(p.this_week,   r.this_week),
        next_week:   Math.max(p.next_week,   r.next_week),
        next_2_week: Math.max(p.next_2_week, r.next_2_week),
        next_3_week: Math.max(p.next_3_week, r.next_3_week),
        in_4_weeks:  Math.max(p.in_4_weeks,  r.in_4_weeks),
        teleconsultation: p.teleconsultation || r.teleconsultation,
        has_quota: (Math.max(p.in_4_weeks, r.in_4_weeks) > 0)
      });
    }
  });
  return [...map.values()].sort((a,b)=>Number(b.has_quota)-Number(a.has_quota));
}
// 以「縣市 + 名稱文字 + 地址文字」去重（避免同頁重複）
function uniqByKey(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const org  = parseAnchor(r.orgName);
    const addr = parseAnchor(r.address);
    const k = `${r.countyName || ''}||${org.text || ''}||${addr.text || ''}`.trim();
    if (!m.has(k)) m.set(k, r);
  }
  return [...m.values()];
}

/* ---------- Human-like tools（防抖動 / 人類化） ---------- */
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
async function humanPause(kind = 'short') {
  const table = {
    short:  [120, 450],
    medium: [300, 900],
    long:   [900, 1800],
    county: [2000, 6000],
  };
  const [a, b] = table[kind] || table.short;
  await sleep(rand(a, b));
}
function pickViewport() {
  const VIEWPORTS = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
  ];
  return VIEWPORTS[rand(0, VIEWPORTS.length - 1)];
}
// 偏移點擊 + 移動軌跡
async function humanClickEl(el, page) {
  await el.scrollIntoViewIfNeeded().catch(()=>{});
  await humanPause('short');
  const box = await el.boundingBox().catch(()=>null);
  if (!box) { await el.click().catch(()=>{}); return; }
  const x = box.x + rand(Math.floor(box.width * 0.2),  Math.ceil(box.width * 0.8));
  const y = box.y + rand(Math.floor(box.height * 0.2), Math.ceil(box.height * 0.8));
  await page.mouse.move(x - rand(40, 90), y - rand(20, 60), { steps: rand(5, 15) }).catch(()=>{});
  await humanPause('short');
  await page.mouse.move(x, y, { steps: rand(2, 6) }).catch(()=>{});
  await humanPause('short');
  await page.mouse.down().catch(()=>{});
  await humanPause('short');
  await page.mouse.up().catch(()=>{});
}

/* ---------- 網格 XHR 等待/翻頁 ---------- */
function waitForAnyGrid(page) {
  return page.waitForResponse(res =>
    res.url().includes('/mhs/Home/QueryServiceOrgJsonList') &&
    res.request().method() === 'POST'
  , { timeout: 60000 });
}
async function ensureFormLoaded(page) {
  if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
  const imgLink = page.locator('a.queryServiceOrg');
  if (await imgLink.count()) {
    await imgLink.first().scrollIntoViewIfNeeded();
    // 用人類化點擊打開
    await Promise.all([
      page.waitForSelector('#QueryOrgServiceCaseForm', { timeout: 8000 }).catch(() => {}),
      (async () => { await humanClickEl(imgLink.first(), page); })()
    ]);
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
    await page.evaluate(() => document.querySelector('a.queryServiceOrg')?.click());
    await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
  }
  await page.goto(FORM, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#QueryOrgServiceCaseForm', { timeout: 30000 });
}
async function triggerSearch(page) {
  const ok = await page.evaluate(() => {
    if (typeof CSSM_SearchDataGrid === 'function') {
      CSSM_SearchDataGrid('QueryOrgServiceCaseDg');
      return true;
    }
    return false;
  }).catch(()=>false);
  if (ok) return;
  await humanPause('short');
  await humanClickEl(page.locator('button.btn.btn-success[onclick*="CSSM_SearchDataGrid"]').first(), page);
}
async function readTotalPages(page) {
  return await page.evaluate(() => {
    const grabText = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .map(n => (n.textContent || '').trim())
        .filter(Boolean);
    for (const t of grabText('span, div')) {
      const m = t.match(/共\s*(\d+)\s*頁/);
      if (m) return Math.max(0, parseInt(m[1], 10));
    }
    const info = document.querySelector('.ui-paging-info, .pagination-info');
    if (info) {
      const m2 = (info.textContent || '').match(/共\s*(\d+)\s*記錄/);
      if (m2) {
        const total = parseInt(m2[1], 10);
        return Math.max(0, Math.ceil(total / 10));
      }
    }
    return 1; // 預設至少 1 頁
  });
}
function nextBtn(page) {
  return page.locator('a.l-btn.l-btn-plain', { has: page.locator('.pagination-next') }).first();
}
async function clickNextAndGetRows(page) {
  const btn = nextBtn(page);
  const [resp] = await Promise.all([
    waitForAnyGrid(page),
    (async () => { await humanPause('medium'); await humanClickEl(btn, page); })()
  ]);
  try {
    const js = await resp.json();
    return Array.isArray(js.rows) ? js.rows : [];
  } catch {
    return [];
  }
}
async function closeGridDialog(page) {
  const ok = await page.evaluate(() => {
    if (typeof CSSM_CloseDialog === 'function') {
      CSSM_CloseDialog(false, 'QueryServiceOrgDialog') || CSSM_CloseDialog(false, 'QueryOrgServiceDialog');
      return true;
    }
    return false;
  }).catch(()=>false);
  if (ok) {
    await page.waitForSelector('#QueryOrgServiceCaseForm', { state: 'detached', timeout: 5000 }).catch(()=>{});
    return;
  }
  const btn = page.locator('button.btn.btn-danger[onclick*="CSSM_CloseDialog"]');
  if (await btn.count()) {
    await humanClickEl(btn.first(), page);
    await page.waitForSelector('#QueryOrgServiceCaseForm', { state: 'detached', timeout: 5000 }).catch(()=>{});
  }
}
async function reopenFormFromHome(page) {
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await ensureFormLoaded(page);
  await humanPause('long');
}

/* ---------- 讀取 #county option（動態） ---------- */
async function readCountyOptions(page) {
  const opts = await page.$$eval('#county option', list =>
    list.map(o => ({ value: (o.value || '').trim(), text: (o.textContent || '').trim() }))
  );
  // 過濾掉空值/請選擇
  return opts.filter(o => o.value && o.value !== '0' && !/請選/.test(o.text));
}

/* ---------- 核心：依條件(有/無名額)抓一個縣市的所有頁 ---------- */
async function collectByCondition(page, countyValue, haveFlag /* 1:有, 0:無 */) {
  await page.selectOption('#county', countyValue);
  await humanPause('short');
  if (haveFlag) {
    await page.check('#isYes');
  } else {
    await page.check('#isNo');
  }
  await humanPause('short');

  const [respP1] = await Promise.all([
    waitForAnyGrid(page),
    triggerSearch(page)
  ]);
  const p1 = await respP1.json();
  const rows = [...(p1.rows || [])];

  await humanPause('medium');

  const totalPages = await readTotalPages(page);
  const clicks = Math.max(0, totalPages - 1);
  for (let i = 0; i < clicks; i++) {
    const r = await clickNextAndGetRows(page);
    console.log(`[${haveFlag ? '有' : '無'}名額] 第 ${i+2}/${totalPages} 頁抓到 ${r.length} 筆`);
    if (r?.length) rows.push(...r);
    // 偶爾滾一下
    if (i % 2 === 0) { try { await page.mouse.wheel(0, rand(200, 1200)); } catch {} }
    await humanPause('medium');
  }

  const uniq = uniqByKey(rows);
  return { total: uniq.length, rows: uniq, totalPages };
}

/* ---------- 一個縣市完整流程：有→關閉→重開→無 → 輸出 ---------- */
async function processOneCounty(page, county) {
  const code = pad2(county.value);
  const name = county.text.replace(/\s+/g, '');

  console.log(`\n=== ${name}（代碼 ${code}）開始 ===`);
  // 有名額
  const yes = await collectByCondition(page, county.value, 1);
  fs.writeFileSync(path.join(OUT, `${code}_${name}_yes_raw.json`), JSON.stringify(yes, null, 2), 'utf8');
  console.log(`${name} → 有名額：唯一${yes.total}；UI頁數：${yes.totalPages}`);

  // 關閉→回首頁→重開（避免頁碼殘留）
  await closeGridDialog(page);
  await reopenFormFromHome(page);

  // 無名額
  const no = await collectByCondition(page, county.value, 0);
  fs.writeFileSync(path.join(OUT, `${code}_${name}_no_raw.json`), JSON.stringify(no, null, 2), 'utf8');
  console.log(`${name} → 無名額：唯一${no.total}；UI頁數：${no.totalPages}`);

  // 清洗 + 合併 → 輸出
  const cleanedYes = cleanRows(yes.rows);
  const cleanedNo  = cleanRows(no.rows);
  const merged     = mergeYesNo(cleanedYes, cleanedNo);

  const mergedJsonPath = path.join(OUT, `${code}_${name}_merged_clean.json`);
  const mergedCsvPath  = path.join(OUT, `${code}_${name}_merged_clean.csv`);
  fs.writeFileSync(mergedJsonPath, JSON.stringify({ county: name, total: merged.length, rows: merged }, null, 2), 'utf8');

  const headersCsv = [
    'county','org_name','org_url','phone','address','map_url','pay_detail',
    'this_week','next_week','next_2_week','next_3_week','in_4_weeks',
    'edit_date','teleconsultation','has_quota'
  ];
  fs.writeFileSync(mergedCsvPath, toCSV(merged, headersCsv), 'utf8');

  console.log(`✅ ${name} 完成：${path.basename(mergedJsonPath)} / ${path.basename(mergedCsvPath)}`);
  return { yes, no, merged };
}

/* ============================== 主程式 ============================== */
(async () => {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 50 + rand(0, 40) // 讓每步驟稍有差異
  });
  const vp = pickViewport();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: vp,
    deviceScaleFactor: [1, 2][rand(0, 1)],
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: ['light', 'dark'][rand(0, 1)],
  });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await ensureFormLoaded(page);
  await humanPause('long');

  // 讀取所有縣市 option
  const counties = await readCountyOptions(page);

  // 你可以用環境變數指定要跑哪些（例如：COUNTIES=9,1,2）
  const pick = (process.env.COUNTIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const targets = pick.length ? counties.filter(c => pick.includes(c.value)) : counties;

  console.log(`將處理縣市（共 ${targets.length} 個）：`, targets.map(c => `${pad2(c.value)}_${c.text}`).join(', '));

  const allMerged = [];
  const failures  = [];

  for (const county of targets) {
    try {
      await ensureFormLoaded(page);
      const { merged } = await processOneCounty(page, county);
      allMerged.push(...merged);
      await closeGridDialog(page).catch(()=>{});
      await humanPause('county'); // 換縣市前休息一下
    } catch (e) {
      console.error(`❌ ${county.text} 失敗：`, e?.message || e);
      failures.push({ county: county.text, error: String(e?.message || e) });
      await reopenFormFromHome(page).catch(()=>{});
      await humanPause('county');
    }
  }

  // 全台合併（僅清洗後合併過的 merged）
  const allJsonPath = path.join(OUT, 'taiwan_merged_clean.json');
  const allCsvPath  = path.join(OUT, 'taiwan_merged_clean.csv');
  fs.writeFileSync(allJsonPath, JSON.stringify({ county: '全台灣', total: allMerged.length, rows: allMerged }, null, 2), 'utf8');

  const headersCsv = [
    'county','org_name','org_url','phone','address','map_url','pay_detail',
    'this_week','next_week','next_2_week','next_3_week','in_4_weeks',
    'edit_date','teleconsultation','has_quota'
  ];
  fs.writeFileSync(allCsvPath, toCSV(allMerged, headersCsv), 'utf8');

  console.log(`\n=== 全台完成 ===`);
  console.log(`合併輸出：${path.basename(allJsonPath)} / ${path.basename(allCsvPath)}`);
  if (failures.length) {
    console.log('以下縣市未成功：', failures);
  }

  await context.close(); await browser.close();
})().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
