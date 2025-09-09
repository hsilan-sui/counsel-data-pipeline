// index.js — 桃園市「有名額」+「無名額」：查第1頁 → 讀UI共N頁 → 逐次點「下一頁」 → 去重/清洗/合併/輸出

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://sps.mohw.gov.tw/mhs';
const FORM = `${BASE}/Home/QueryServiceOrg`;
const OUT  = path.resolve('./out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---------- 小工具 ---------- */
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (ms, j = 500) => ms + Math.floor(Math.random() * j);
const toInt  = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const unesc  = s => typeof s === 'string'
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
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
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
    // 若想改為「任一週 > 0」可換：o.has_quota = (o.this_week + o.next_week + o.next_2_week + o.next_3週) > 0;
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
        this_week: Math.max(p.this_week, r.this_week),
        next_week: Math.max(p.next_week, r.next_week),
        next_2_week: Math.max(p.next_2_week, r.next_2_week),
        next_3_week: Math.max(p.next_3_week, r.next_3_week),
        in_4_weeks: Math.max(p.in_4_weeks, r.in_4_weeks),
        teleconsultation: p.teleconsultation || r.teleconsultation,
        has_quota: (Math.max(p.in_4_weeks, r.in_4_weeks) > 0)
      });
    }
  });
  return [...map.values()].sort((a,b)=>Number(b.has_quota)-Number(a.has_quota));
}

// 以「縣市 + 名稱文字 + 地址文字」去重（避免重複列）
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

/* ---------- 網格 XHR 等待（放寬/加長） ---------- */
function waitForAnyGrid(page) {
  return page.waitForResponse(
    res => res.url().includes('/mhs/Home/QueryServiceOrgJsonList') && res.request().method() === 'POST',
    { timeout: 120000 } // 由 60s 提到 120s
  );
}

/* ---------- 表單載入（更寬鬆 & 重試） ---------- */
async function ensureFormLoaded(page) {
  // 已有表單就不再處理
  if (await page.locator('#QueryOrgServiceCaseForm').count()) return;

  // 有圖片入口按鈕的情況（首頁），嘗試點開
  const imgLink = page.locator('a.queryServiceOrg');
  if (await imgLink.count()) {
    await imgLink.first().scrollIntoViewIfNeeded();
    await Promise.allSettled([
      page.waitForSelector('#QueryOrgServiceCaseForm', { timeout: 8000 }),
      imgLink.first().click({ timeout: 5000 })
    ]);
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
  }

  // 直接打表單頁面（更穩）
  await gotoStable(page, FORM);
  await page.waitForSelector('#QueryOrgServiceCaseForm', { timeout: 30000 });
}

/* ---------- 觸發「查詢」 ---------- */
async function triggerSearch(page) {
  const ok = await page.evaluate(() => {
    if (typeof CSSM_SearchDataGrid === 'function') {
      CSSM_SearchDataGrid('QueryOrgServiceCaseDg');
      return true;
    }
    return false;
  }).catch(()=>false);
  if (ok) return;
  await page.click('button.btn.btn-success[onclick*="CSSM_SearchDataGrid"]', { force: true });
}

/* ---------- 讀 UI「共N頁」 ---------- */
async function readTotalPages(page) {
  return await page.evaluate(() => {
    const grabText = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .map(n => (n.textContent || '').trim())
        .filter(Boolean);

    // 1) 直接找「共N頁」
    const spans = grabText('span, div');
    for (const t of spans) {
      const m = t.match(/共\s*(\d+)\s*頁/);
      if (m) return Math.max(1, parseInt(m[1], 10));
    }

    // 2) 由「共X記錄」估算（預設每頁10筆）
    const info = document.querySelector('.ui-paging-info, .pagination-info');
    if (info) {
      const m2 = (info.textContent || '').match(/共\s*(\d+)\s*記錄/);
      if (m2) {
        const total = parseInt(m2[1], 10);
        return Math.max(1, Math.ceil(total / 10));
      }
    }
    return 1;
  });
}

/* ---------- 下一頁按鈕 ---------- */
function nextBtn(page) {
  return page.locator('a.l-btn.l-btn-plain', { has: page.locator('.pagination-next') }).first();
}

/* ---------- 點「下一頁」→ 等待 JSON → 回傳 rows ---------- */
async function clickNextAndGetRows(page) {
  const btn = nextBtn(page);
  const [resp] = await Promise.all([
    waitForAnyGrid(page),
    btn.click({ force: true })
  ]);
  try {
    const js = await resp.json();
    return Array.isArray(js.rows) ? js.rows : [];
  } catch {
    return [];
  }
}

/* ---------- 關閉 Datagrid → 回首頁重開（避免頁碼殘留） ---------- */
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
    await btn.first().click({ force: true });
    await page.waitForSelector('#QueryOrgServiceCaseForm', { state: 'detached', timeout: 5000 }).catch(()=>{});
  }
}
async function reopenFormFromHome(page) {
  await gotoStable(page, FORM);
  await ensureFormLoaded(page);
}

/* ---------- 穩定版導航：先 DOM，再 networkidle，最後 load（含重試） ---------- */
async function gotoStable(page, url) {
  const plans = [
    { waitUntil: 'domcontentloaded', timeout: 120000 },
    { waitUntil: 'networkidle',      timeout: 150000 },
    { waitUntil: 'load',             timeout: 150000 },
  ];
  for (let i = 0; i < plans.length; i++) {
    try {
      await page.goto(url, plans[i]);
      return;
    } catch (e) {
      console.warn(`goto ${url} 第${i + 1}次方案失敗：${plans[i].waitUntil} → ${e.name}`);
      if (i === plans.length - 1) throw e;
      await page.waitForTimeout(2000 * (i + 1));
    }
  }
}

/* ============================== 主程式 ============================== */
let page; // 讓 catch 可以截圖
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(180000);

  // （可選）降低資源：擋掉影像與媒體，讓 CI 更穩更快
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  // 進站並確保表單載入（直接從 FORM 開始，較穩）
  await gotoStable(page, FORM);
  await ensureFormLoaded(page);

  /* ====== 桃園→有名額 ====== */
  const COUNTY_VALUE = process.env.COUNTY_VALUE || '9'; // 桃園
  await page.selectOption('#county', COUNTY_VALUE);
  await page.check('#isYes');

  const [respYesP1] = await Promise.all([
    waitForAnyGrid(page),
    triggerSearch(page)
  ]);
  const yesP1 = await respYesP1.json();
  const yesRows = [...(yesP1.rows || [])];

  const yesTotalPages = await readTotalPages(page);
  const yesClicks = Math.max(0, yesTotalPages - 1);
  for (let i = 0; i < yesClicks; i++) {
    const rows = await clickNextAndGetRows(page);
    const pageNo = i + 2;
    console.log(`[有名額] 第 ${pageNo}/${yesTotalPages} 頁抓到 ${rows.length} 筆`);
    if (rows?.length) yesRows.push(...rows);
    await sleep(jitter(200, 150));
  }

  const yesUniq = uniqByKey(yesRows);
  const yesAll  = { total: yesUniq.length, rows: yesUniq };
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_raw.json'), JSON.stringify(yesAll, null, 2), 'utf8');
  console.log(`有名額 → 原始:${yesRows.length}；唯一:${yesAll.total}；UI頁數:${yesTotalPages}`);

  /* ====== 關閉 → 回首頁 → 重開表單（避免頁碼殘留） ====== */
  await closeGridDialog(page);
  await reopenFormFromHome(page);

  /* ====== 桃園→無名額 ====== */
  await page.selectOption('#county', COUNTY_VALUE);
  await page.check('#isNo');

  const [respNoP1] = await Promise.all([
    waitForAnyGrid(page),
    triggerSearch(page)
  ]);
  const noP1 = await respNoP1.json();
  const noRows = [...(noP1.rows || [])];

  const noTotalPages = await readTotalPages(page);
  const noClicks = Math.max(0, noTotalPages - 1);
  for (let i = 0; i < noClicks; i++) {
    const rows = await clickNextAndGetRows(page);
    const pageNo = i + 2;
    console.log(`[無名額] 第 ${pageNo}/${noTotalPages} 頁抓到 ${rows.length} 筆`);
    if (rows?.length) noRows.push(...rows);
    await sleep(jitter(200, 150));
  }

  const noUniq = uniqByKey(noRows);
  const noAll  = { total: noUniq.length, rows: noUniq };
  fs.writeFileSync(path.join(OUT, 'taoyuan_no_raw.json'), JSON.stringify(noAll, null, 2), 'utf8');
  console.log(`無名額 → 原始:${noRows.length}；唯一:${noAll.total}；UI頁數:${noTotalPages}`);

  /* ====== 清洗 + 合併 → 輸出 ====== */
  const cleanedYes = cleanRows(yesAll.rows);
  const cleanedNo  = cleanRows(noAll.rows);
  const merged     = mergeYesNo(cleanedYes, cleanedNo);

  fs.writeFileSync(
    path.join(OUT, 'taoyuan_merged_clean.json'),
    JSON.stringify({ county: '桃園市', total: merged.length, rows: merged }, null, 2),
    'utf8'
  );

  const headersCsv = [
    'county','org_name','org_url','phone','address','map_url','pay_detail',
    'this_week','next_week','next_2_week','next_3_week','in_4_weeks',
    'edit_date','teleconsultation','has_quota'
  ];
  fs.writeFileSync(path.join(OUT, 'taoyuan_merged_clean.csv'), toCSV(merged, headersCsv), 'utf8');

  await context.close(); await browser.close();
  console.log('✅ 完成：out/taoyuan_* 檔案已產生');
})().catch(async e => {
  try {
    if (page) await page.screenshot({ path: path.join(OUT, 'debug_failure.png'), fullPage: true });
  } catch {}
  console.error('❌ Fatal:', e);
  process.exit(1);
});
