// node taoyuan_mixed.playwright.js
// 流程：UI 先查第1頁 → 抓到 token/cookie → API 補第2..N頁 → 清洗合併 → 輸出
const { chromium, request } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE   = 'https://sps.mohw.gov.tw/mhs';
const FORM   = `${BASE}/Home/QueryServiceOrg`;
const ORIGIN = new URL(BASE).origin;
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

/* ---------- 清洗 / 合併 ---------- */
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
    // 若想改為「任一週 > 0」：o.has_quota = (o.this_week + o.next_week + o.next_2_week + o.next_3_week) > 0;
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

/* ---------- 等到 DataGrid 的 XHR（UI 點擊時抓當頁 JSON） ---------- */
function waitForGrid(page, pageNo, have) {
  return page.waitForResponse(res => {
    if (!res.url().includes('/mhs/Home/QueryServiceOrgJsonList')) return false;
    if (res.request().method() !== 'POST') return false;
    const body = res.request().postData() || '';
    const params = new URLSearchParams(body);
    return String(params.get('page') || '1') === String(pageNo) &&
           String(params.get('haveServiceCount')) === String(have);
  }, { timeout: 30000 });
}

/* ---------- 一定把表單載出來（圖片入口 .queryServiceOrg；失敗就直接開子頁） ---------- */
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

/* ---------- 穩定觸發「查詢」 ---------- */
async function triggerSearch(page) {
  // 先試直接呼叫 onclick 綁定的函式
  const ok = await page.evaluate(() => {
    if (typeof CSSM_SearchDataGrid === 'function') {
      CSSM_SearchDataGrid('QueryOrgServiceCaseDg');
      return true;
    }
    return false;
  });
  if (ok) return;
  // 備援：硬點擊有 onclick 的按鈕
  await page.click('button.btn.btn-success[onclick*="CSSM_SearchDataGrid"]', { force: true });
}

/* ---------- 從現有瀏覽流程建立 API context（同步 cookie + header） ---------- */
async function createApiFromPage(context, page) {
  const cookies = await context.cookies('https://sps.mohw.gov.tw');
  const api = await request.newContext({
    baseURL: 'https://sps.mohw.gov.tw',
    ignoreHTTPSErrors: true,
    storageState: { cookies, origins: [] },
    extraHTTPHeaders: {
      'origin': 'https://sps.mohw.gov.tw',
      'referer': 'https://sps.mohw.gov.tw/mhs/Home/QueryServiceOrg',
      'x-requested-with': 'XMLHttpRequest',
      'accept': '*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'user-agent': await page.evaluate(() => navigator.userAgent),
    },
  });
  return api;
}

/* ---------- 基準表單覆寫 + 發送（關鍵） ---------- */
// 用基準 body（UI 第一頁送出的 postData）建立下一頁要送的表單
function buildForm(base, overrides) {
  const f = new URLSearchParams(base);
  // 先刪除可能重複/過期的分頁欄位，再覆寫
  ['page','pageNumber','rows','pageSize','nd','__RequestVerificationToken'].forEach(k => f.delete(k));
  Object.entries(overrides).forEach(([k, v]) => f.set(k, String(v)));
  if (f.has('nd') === false) f.set('nd', String(Date.now())); // jqGrid 防快取
  return f;
}

// 以「基準表單」送出（帶 AntiForgery header，含重試）
async function postFormFromBase(api, baseForm, overrides, tag = 'A1') {
  const form = buildForm(baseForm, overrides);
  async function tryPost(headers, t) {
    const resp = await api.post('/mhs/Home/QueryServiceOrgJsonList', {
      data: form.toString(),
      headers
    });
    if (!resp.ok()) {
      const body = await resp.text().catch(() => '');
      console.error(`[API] ${resp.status()} ${resp.statusText()} tag=${t}\n${body.slice(0, 800)}`);
      throw new Error(`API ${resp.status()} ${resp.statusText()}`);
    }
    return resp.json();
  }
  try {
    return await tryPost({ 'RequestVerificationToken': form.get('__RequestVerificationToken') }, tag);
  } catch {
    await sleep(300);
    const tok = form.get('__RequestVerificationToken');
    try {
      return await tryPost({ 'RequestVerificationToken': `${tok}:${tok}` }, 'B1');
    } catch {
      await sleep(600);
      return tryPost({ 'RequestVerificationToken': tok }, 'A2');
    }
  }
}

// 回傳一個 fetcher，後續只要餵 pageNo/pageSize 即可
function makeApiFetcher(api, baseForm, token) {
  return async ({ pageNo, pageSize }) => {
    return postFormFromBase(api, baseForm, {
      '__RequestVerificationToken': token,
      'page': String(pageNo),
      'pageNumber': String(pageNo), // 關鍵：1-based
      'rows': String(pageSize),
      'pageSize': String(pageSize),
      'nd': String(Date.now())
      // 其它搜尋條件（countyValue、haveServiceCount…）都沿用 baseForm
    });
  };
}

/* ============================== 主程式 ============================== */
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // 1) 進站並確保表單載入
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await ensureFormLoaded(page);

  // 2) UI 操作「桃園=9、有名額=是」→ 抓第1頁 JSON
  await page.selectOption('#county', '9');
  await page.check('#isYes');

  const [respYes1] = await Promise.all([
    waitForGrid(page, 1, 1),
    triggerSearch(page)
  ]);
  const yesPage1 = await respYes1.json();
  const yesRowsAll = [...(yesPage1.rows || [])];
  const yesTotal    = Number.isFinite(yesPage1?.total) ? yesPage1.total : yesRowsAll.length;
  const yesPageSize = yesRowsAll.length || 10;
  const yesPages    = Math.max(1, Math.ceil(yesTotal / yesPageSize));

  // 取得第一頁實際 POST 的 body 當基準
  const baseYesForm = new URLSearchParams(respYes1.request().postData() || '');

  // 3) 抓 CSRF token（hidden input；必要時拉 HTML 備援）
  let token = await page.getAttribute('#QueryOrgServiceCaseForm input[name="__RequestVerificationToken"]', 'value');
  if (!token) {
    const resp = await context.request.get(FORM, { headers: { origin: ORIGIN, referer: BASE } });
    const html = await resp.text();
    token = (html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/)||[])[1];
  }
  if (!token) throw new Error('取不到 __RequestVerificationToken');

  // 4) 建立與目前瀏覽流程一致的 API context（帶 cookie）
  const api = await createApiFromPage(context, page);

  // 5) 用 API 補「有名額」第2..N頁（使用基準表單 fetcher）
  const fetchYes = makeApiFetcher(api, baseYesForm, token);
  for (let p = 2; p <= yesPages; p++) {
    await sleep(jitter(700, 500));
    const pj = await fetchYes({ pageNo: p, pageSize: yesPageSize });
    if (pj.rows?.length) yesRowsAll.push(...pj.rows);
  }
  const yesAll = { total: yesRowsAll.length, rows: yesRowsAll };

  // 6) UI 切到「無名額=否」→ 抓第1頁 JSON
  await page.check('#isNo');
  const [respNo1] = await Promise.all([
    waitForGrid(page, 1, 0),
    triggerSearch(page)
  ]);
  const noPage1   = await respNo1.json();
  const noRowsAll = [...(noPage1.rows || [])];
  const noTotal    = Number.isFinite(noPage1?.total) ? noPage1.total : noRowsAll.length;
  const noPageSize = noRowsAll.length || 10;
  const noPages    = Math.max(1, Math.ceil(noTotal / noPageSize));

  // 取得「無名額」第一頁的基準表單 + 用 fetcher 補頁
  const baseNoForm = new URLSearchParams(respNo1.request().postData() || '');
  const fetchNo = makeApiFetcher(api, baseNoForm, token);
  for (let p = 2; p <= noPages; p++) {
    await sleep(jitter(700, 500));
    const pj = await fetchNo({ pageNo: p, pageSize: noPageSize });
    if (pj.rows?.length) noRowsAll.push(...pj.rows);
  }
  const noAll = { total: noRowsAll.length, rows: noRowsAll };

  // 8) 存 raw
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_raw.json'), JSON.stringify(yesAll, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'taoyuan_no_raw.json'),  JSON.stringify(noAll,  null, 2), 'utf8');
  console.log(`桃園市 → 有名額：${yesAll.total} 筆；無名額：${noAll.total} 筆`);

  // 9) 清洗 + 合併 → 輸出
  const cleanedYes = cleanRows(yesAll.rows);
  const cleanedNo  = cleanRows(noAll.rows);
  const merged     = mergeYesNo(cleanedYes, cleanedNo);

  fs.writeFileSync(path.join(OUT, 'taoyuan_merged_clean.json'),
    JSON.stringify({ county: '桃園市', total: merged.length, rows: merged }, null, 2), 'utf8');

  const headersCsv = [
    'county','org_name','org_url','phone','address','map_url','pay_detail',
    'this_week','next_week','next_2_week','next_3_week','in_4_weeks',
    'edit_date','teleconsultation','has_quota'
  ];
  fs.writeFileSync(path.join(OUT, 'taoyuan_merged_clean.csv'), toCSV(merged, headersCsv), 'utf8');

  await api.dispose().catch(()=>{});
  await context.close();
  await browser.close();
  console.log('✅ 完成：out/taoyuan_* 檔案已產生');
})().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
