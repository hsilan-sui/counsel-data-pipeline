// index.js — 逐縣市：有名額→關閉→回首頁→無名額→合併；輸出縣市與全台 JSON/CSV
// ------------------------------------------------------------
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

/* ===================== 常數與輸出目錄 ===================== */
const BASE = 'https://sps.mohw.gov.tw/mhs';
const FORM = `${BASE}/Home/QueryServiceOrg`;
const OUT  = path.resolve('./out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// 可用環境變數調整（CI 也有傳入）
const NAV_TIMEOUT   = Number(process.env.GOTO_TIMEOUT_MS  || 120000);
const SEL_TIMEOUT   = Number(process.env.SEL_TIMEOUT_MS   || 120000);
const GOTO_TRIES    = Number(process.env.GOTO_TRIES       || 4);
const BACKOFF_START = Number(process.env.GOTO_BACKOFF_MS  || 3000);

/* ===================== 小工具 ===================== */
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

/* ===================== 清洗 / 合併 / 去重 ===================== */
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

/* ===================== 人類化操作 / 防偵測 ===================== */
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

// 偏移點擊 + 滑鼠軌跡
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

/* ===================== 穩定導航（CI 友善） ===================== */
async function gotoStable(page, url, {
  selector   = 'body',
  attempts   = GOTO_TRIES,
  navTimeout = NAV_TIMEOUT,
  selTimeout = SEL_TIMEOUT,
  backoffMs  = BACKOFF_START
} = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      await page.waitForSelector(selector, { timeout: selTimeout });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[gotoStable] attempt ${i}/${attempts} failed:`, err?.message || err);
      try { await page.screenshot({ path: path.join(OUT, `goto_fail_try${i}.png`), fullPage: true }); } catch {}
      try { const html = await page.content(); fs.writeFileSync(path.join(OUT, `goto_fail_try${i}.html`), html || ''); } catch {}
      await sleep(backoffMs * (2 ** (i - 1)));
    }
  }
  throw lastErr;
}

/* ===================== Grid 載入 / Query 流程 ===================== */
function waitForAnyGrid(page) {
  return page.waitForResponse(res =>
    res.url().includes('/mhs/Home/QueryServiceOrgJsonList') &&
    res.request().method() === 'POST'
  , { timeout: 60000 });
}

async function ensureFormLoaded(page) {
  if (await page.locator('#QueryOrgServiceCaseForm').count()) return;

  // 首頁上點「查詢服務機構」
  const imgLink = page.locator('a.queryServiceOrg');
  if (await imgLink.count()) {
    await imgLink.first().scrollIntoViewIfNeeded().catch(()=>{});
    await Promise.all([
      page.waitForSelector('#QueryOrgServiceCaseForm', { timeout: 15000 }).catch(() => {}),
      (async () => { await humanClickEl(imgLink.first(), page); })()
    ]);
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;

    // 備援：直接觸發 click
    await page.evaluate(() => document.querySelector('a.queryServiceOrg')?.click());
    await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
  }

  // 再備援：直接進表單頁
  await gotoStable(page, FORM, { selector: '#QueryOrgServiceCaseForm' });
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
    return 1;
  });
}

function nextBtn(page) {
  // easyUI Pagination 的下一頁按鈕
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
  await gotoStable(page, BASE, { selector: 'a.queryServiceOrg' });
  await ensureFormLoaded(page);
  await humanPause('long');
}

/* ===================== 讀取縣市 select options（動態） ===================== */
async function readCountyOptions(page) {
  const opts = await page.$$eval('#county option', list =>
    list.map(o => ({ value: (o.value || '').trim(), text: (o.textContent || '').trim() }))
  );
  return opts.filter(o => o.value && o.value !== '0' && !/請選/.test(o.text));
}

/* ===================== 依條件抓取一個縣市的所有頁 ===================== */
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
  const p1 = await respP1.json().catch(()=>({ rows: [] }));
  const rows = [...(p1.rows || [])];

  await humanPause('medium');

  const totalPages = await readTotalPages(page);
  const clicks = Math.max(0, totalPages - 1);
  for (let i = 0; i < clicks; i++) {
    const r = await clickNextAndGetRows(page);
    console.log(`[${haveFlag ? '有' : '無'}名額] 第 ${i+2}/${totalPages} 頁抓到 ${r.length} 筆`);
    if (r?.length) rows.push(...r);
    if (i % 2 === 0) { try { await page.mouse.wheel(0, rand(200, 1200)); } catch {} }
    await humanPause('medium');
  }

  const uniq = uniqByKey(rows);
  return { total: uniq.length, rows: uniq, totalPages };
}

/* ===================== 處理單一縣市：有→關→回首頁→無→合併輸出 ===================== */
async function processOneCounty(page, county) {
  const code = pad2(county.value);
  const name = county.text.replace(/\s+/g, '');

  console.log(`\n=== ${name}（代碼 ${code}）開始 ===`);
  // 有名額
  const yes = await collectByCondition(page, county.value, 1);
  fs.writeFileSync(path.join(OUT, `${code}_${name}_yes_raw.json`), JSON.stringify(yes, null, 2), 'utf8');
  console.log(`${name} → 有名額：唯一 ${yes.total}；UI 頁數：${yes.totalPages}`);

  // 關閉→回首頁→重開（避免頁碼殘留）
  await closeGridDialog(page).catch(()=>{});
  await reopenFormFromHome(page);

  // 無名額
  const no = await collectByCondition(page, county.value, 0);
  fs.writeFileSync(path.join(OUT, `${code}_${name}_no_raw.json`), JSON.stringify(no, null, 2), 'utf8');
  console.log(`${name} → 無名額：唯一 ${no.total}；UI 頁數：${no.totalPages}`);

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
  return { merged };
}

/* ===================== 主程式 ===================== */
(async () => {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 50 + rand(0, 40),
    args: ['--disable-dev-shm-usage'] // CI 上 /dev/shm 偏小，減少崩潰機率
  });

  // 固定 UA（避免預設 Playwright UA）
  const FIXED_UA = process.env.NOMINATIM_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36 suihsilan-crawler/1.0';

  // 先用一個 context 讀 options（之後每縣市都 fresh context）
  const bootCtx = await browser.newContext({
    userAgent: FIXED_UA,
    ignoreHTTPSErrors: true,
    viewport: pickViewport(),
    deviceScaleFactor: [1, 2][rand(0, 1)],
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: ['light', 'dark'][rand(0, 1)],
  });
  await bootCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const bootPage = await bootCtx.newPage();
  bootPage.setDefaultTimeout(NAV_TIMEOUT);
  bootPage.setDefaultNavigationTimeout(NAV_TIMEOUT);

  // 進站與開表單
  await gotoStable(bootPage, BASE, { selector: 'a.queryServiceOrg' });
  await ensureFormLoaded(bootPage);
  await humanPause('long');

  // 讀取所有縣市 option
  const counties = await readCountyOptions(bootPage);
  await bootCtx.close();

  // 可用 COUNTIES=9,1,2 指定只跑某些縣市（值用 option value）
  const pick = (process.env.COUNTIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const targets = pick.length ? counties.filter(c => pick.includes(c.value)) : counties;

  console.log(`將處理縣市（共 ${targets.length} 個）：`, targets.map(c => `${pad2(c.value)}_${c.text}`).join(', '));

  const allMerged = [];
  const failures  = [];

  // ★★★ 每縣市都用 fresh context/page，避免 session 汙染 ★★★
  for (const county of targets) {
    let ctx, page;
    try {
      ctx = await browser.newContext({
        userAgent: FIXED_UA,
        ignoreHTTPSErrors: true,
        viewport: pickViewport(),
        deviceScaleFactor: [1, 2][rand(0, 1)],
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
        colorScheme: ['light', 'dark'][rand(0, 1)],
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      page = await ctx.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);

      // 每輪都重新走首頁→表單，最乾淨
      await gotoStable(page, BASE, { selector: 'a.queryServiceOrg' });
      await ensureFormLoaded(page);
      await humanPause('long');

      const { merged } = await processOneCounty(page, county);
      allMerged.push(...merged);

      await ctx.close().catch(()=>{});
      await humanPause('county');
    } catch (e) {
      console.error(`❌ ${county.text} 失敗：`, e?.message || e);
      try {
        if (page) {
          await page.screenshot({ path: path.join(OUT, `fail_${pad2(county.value)}_${county.text}.png`), fullPage: true }).catch(()=>{});
          const html = await page.content().catch(()=>null);
          if (html) fs.writeFileSync(path.join(OUT, `fail_${pad2(county.value)}_${county.text}.html`), html);
        }
      } catch {}
      failures.push({ county: county.text, error: String(e?.message || e) });
      try { await ctx?.close(); } catch {}
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

  await browser.close();
})().catch(e => {
  console.error('❌ Fatal:', e);
  try {
    fs.writeFileSync(path.join(OUT, 'fatal.txt'), String(e?.stack || e?.message || e || 'unknown'));
  } catch {}
  process.exit(1);
});
