// index.js  — 桃園市「有名額」：查第1頁 → 讀出「共N頁」 → 逐次點「下一頁」 → 去重/清洗/輸出
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE   = 'https://sps.mohw.gov.tw/mhs';
const FORM   = `${BASE}/Home/QueryServiceOrg`;
const OUT    = path.resolve('./out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---------- 小工具 ---------- */
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const jitter = (ms, j=500)=> ms + Math.floor(Math.random()*j);
const toInt = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
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

/* ---------- 清洗 / 去重 ---------- */
function cleanRows(rows) {
  return (rows || []).map(r => {
    const org = parseAnchor(r.orgName);
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
    // 若想改為「任一週 > 0」可換：o.has_quota = (o.this_week + o.next_week + o.next_2_week + o.next_3_week) > 0;
    o.has_quota = o.in_4_weeks > 0;
    return o;
  });
}

// 以「縣市 + 名稱文字 + 地址文字」去重（避免重複列）
function uniqByKey(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const org = parseAnchor(r.orgName);
    const addr = parseAnchor(r.address);
    const k = `${r.countyName || ''}||${org.text || ''}||${addr.text || ''}`.trim();
    if (!m.has(k)) m.set(k, r);
  }
  return [...m.values()];
}

/* ---------- 等待該 JSON XHR（放寬條件，不卡在 haveServiceCount） ---------- */
function waitForAnyGrid(page) {
  return page.waitForResponse(res =>
    res.url().includes('/mhs/Home/QueryServiceOrgJsonList') &&
    res.request().method() === 'POST'
  , { timeout: 60000 });
}

/* ---------- 把表單載出來（圖片入口 .queryServiceOrg；失敗直接子頁） ---------- */
async function ensureFormLoaded(page) {
  if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
  const imgLink = page.locator('a.queryServiceOrg');
  if (await imgLink.count()) {
    await imgLink.first().scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForSelector('#QueryOrgServiceCaseForm', { timeout: 8000 }).catch(() => {}),
      imgLink.first().click({ timeout: 5000 })
    ]);
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
    await page.evaluate(() => document.querySelector('a.queryServiceOrg')?.click());
    await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator('#QueryOrgServiceCaseForm').count()) return;
  }
  await page.goto(FORM, { waitUntil: 'load', timeout: 60000 });
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

/* ---------- 「共N頁」讀取器：優先抓 span 文字，其次從「共X記錄」估算 ---------- */
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

    // 2) 從「顯示1到10,共X記錄」估（預設每頁10筆）
    const info = document.querySelector('.ui-paging-info, .pagination-info');
    if (info) {
      const m2 = (info.textContent || '').match(/共\s*(\d+)\s*記錄/);
      if (m2) {
        const total = parseInt(m2[1], 10);
        return Math.max(1, Math.ceil(total / 10));
      }
    }
    return 1; // 找不到就當 1 頁
  });
}

/* ---------- 下一頁按鈕 & 狀態 ---------- */
function nextBtn(page) {
  return page.locator('a.l-btn.l-btn-plain', { has: page.locator('.pagination-next') }).first();
}
async function isNextDisabled(page) {
  const a = nextBtn(page);
  if (!(await a.count())) return true;
  const cls = (await a.getAttribute('class')) || '';
  return /\bl-btn-disabled\b/.test(cls);
}

/* ---------- 點「下一頁」→ 等待任一 grid JSON 響應 → 回傳 rows ---------- */
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

/* ============================== 主程式（只做「有名額」） ============================== */
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // 1) 進站並確保表單載入
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await ensureFormLoaded(page);

  // 2) 桃園 + 有名額 → 查第 1 頁
  await page.selectOption('#county', '9'); // 桃園
  await page.check('#isYes');

  const [respP1] = await Promise.all([
    waitForAnyGrid(page),    // 放寬，只要該 JSON 端點的 POST
    triggerSearch(page)
  ]);
  const p1json = await respP1.json();
  const allRows = [...(p1json.rows || [])];

  // 3) // 已取得第 1 頁 rows → allRows
  const totalPages = await readTotalPages(page);  // 例如 2 或 4
  const clicks = Math.max(0, totalPages - 1);     // 需要點的次數

  for (let i = 0; i < clicks; i++) {
    const rows = await clickNextAndGetRows(page); // 會等待該次翻頁的 JSON 回來
    const pageNo = i + 2;                         // 目前抓到的是第 2..N 頁
    console.log(`第 ${pageNo}/${totalPages} 頁抓到 ${rows.length} 筆`);
    if (rows?.length) allRows.push(...rows);
    await sleep(jitter(200, 150));
    if (await isNextDisabled(page)) break;
 }

//   // 4) 若還有下一頁：逐頁點「下一頁」→ 等待 JSON → 收齊
//   for (let p = 2; p <= totalPages; p++) {
//     if (await isNextDisabled(page)) {
//       console.warn(`第 ${p} 頁按鈕顯示為 disabled，提前停止。`);
//       break;
//     }
//     const rows = await clickNextAndGetRows(page).catch(() => []);
//     console.log(`第 ${p} 頁抓到 ${rows.length} 筆`);
//     if (!rows.length) {
//       // 允許小抖動：短暫等一下再試一次點擊（最多一次）
//       await sleep(400);
//       if (!(await isNextDisabled(page))) {
//         const retry = await clickNextAndGetRows(page).catch(()=>[]);
//         console.log(`第 ${p} 頁重試抓到 ${retry.length} 筆`);
//         allRows.push(...retry);
//       }
//       continue;
//     }
//     allRows.push(...rows);
//     await sleep(jitter(200, 150));
//   }

  // 5) 去重 → 存 raw（去重後）
  const uniq = uniqByKey(allRows);
  const yesAll = { total: uniq.length, rows: uniq };
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_raw.json'), JSON.stringify(yesAll, null, 2), 'utf8');

  // 6) 清洗 → 存 clean / csv
  const cleaned = cleanRows(uniq);
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_clean.json'),
    JSON.stringify({ county: '桃園市', total: cleaned.length, rows: cleaned }, null, 2), 'utf8');

  const headersCsv = [
    'county','org_name','org_url','phone','address','map_url','pay_detail',
    'this_week','next_week','next_2_week','next_3_week','in_4_weeks',
    'edit_date','teleconsultation','has_quota'
  ];
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_clean.csv'), toCSV(cleaned, headersCsv), 'utf8');

  await context.close(); await browser.close();
  console.log(`✅ 完成：有名額——UI頁數=${totalPages}；raw唯一=${yesAll.total}；clean=${cleaned.length}`);
})().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
