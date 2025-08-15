// node taoyuan_mixed.playwright.js
// 流程：UI 先查第1頁 → 以 UI 強制翻頁逐頁抓 → 清洗合併 → 輸出
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

/* ---------- 清洗 / 合併 / 去重 ---------- */
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

// jqGrid：優先用 records（總筆數）；否則用 total（總頁數）
function getPagerMeta(r, pageSize) {
  const rec = Number(r?.records);
  if (Number.isFinite(rec) && rec > 0) {
    return { records: rec, pages: Math.max(1, Math.ceil(rec / pageSize)) };
  }
  const pagesMaybe = Number(r?.total);
  if (Number.isFinite(pagesMaybe) && pagesMaybe > 0) {
    return { records: pagesMaybe * pageSize, pages: Math.max(1, pagesMaybe) };
  }
  return { records: pageSize, pages: 1 };
}

// 以「縣市 + 機構名稱文字 + 地址文字」去重
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

/* ---------- 等到 DataGrid 的 XHR（UI 點擊或翻頁時抓 JSON） ---------- */
// 寬鬆比對 true/false 與 1/0
function waitForGrid(page, pageNo, have) {
  return page.waitForResponse(res => {
    if (!res.url().includes('/mhs/Home/QueryServiceOrgJsonList')) return false;
    if (res.request().method() !== 'POST') return false;
    const body = res.request().postData() || '';
    const params = new URLSearchParams(body);
    const hv = params.get('haveServiceCount');
    const want = String(have); // '1' or '0'
    const hvOk = (hv === want) || (want === '1' && hv === 'true') || (want === '0' && hv === 'false');
    return String(params.get('page') || '1') === String(pageNo) && hvOk;
  }, { timeout: 30000 });
}

/* ---------- 把表單載出來（圖片入口 .queryServiceOrg；失敗就直接開子頁） ---------- */
async function ensureFormLoaded(page) {
  if (await page.locator('#QueryOrgServiceCaseForm, #QueryOrgServiceCaseForm, #QueryOrgServiceCaseForm'.replace(/Case/g,'OrgServiceCase')).count()) {
    // 上面只為兼容不同 id；實際以 #QueryOrgServiceCaseForm 為主
    return;
  }
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
      CSSM_SearchDataGrid('QueryOrgServiceCaseDg'); // 若站上是 QueryOrgServiceCaseDg / QueryServiceOrgCaseDg 皆可覆蓋
      return true;
    }
    return false;
  }).catch(()=>false);
  if (ok) return;
  await page.click('button.btn.btn-success[onclick*="CSSM_SearchDataGrid"]', { force: true });
}

/* ---------- 關閉查詢彈窗（Dialog） ---------- */
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

/* ---------- 回主頁並重開表單（確保回到第 1 頁） ---------- */
async function reopenFormFromHome(page) {
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await ensureFormLoaded(page);
}

/* ---------- 用 UI 強制翻到指定頁並重載 grid ---------- */
async function gotoGridPage(page, pageNo) {
  const used = await page.evaluate((p) => {
    try {
      if (window.$ && $('#QueryOrgServiceCaseDg').length && $('#QueryOrgServiceCaseDg').jqGrid) {
        $('#QueryOrgServiceCaseDg').jqGrid('setGridParam', { page: p });
        $('#QueryOrgServiceCaseDg').trigger('reloadGrid');
        return 'jqgrid';
      }
    } catch(_) {}
    // 備援：改 hidden 欄位 + 再按查詢
    const setIf = (name, val) => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (el) el.value = String(val);
    };
    setIf('page', p);
    setIf('pageNumber', p);
    if (typeof CSSM_SearchDataGrid === 'function') {
      CSSM_SearchDataGrid('QueryOrgServiceCaseDg');
      return 'fallback-func';
    }
    const btn = document.querySelector('button.btn.btn-success[onclick*="CSSM_SearchDataGrid"]');
    btn?.click();
    return 'fallback-click';
  }, pageNo);
  return used;
}

/* ---------- 以 UI 逐頁蒐集 ---------- */
async function collectPagesViaUI(page, have, firstJson, totalPages) {
  const all = [...(firstJson.rows || [])];
  for (let p = 2; p <= totalPages; p++) {
    await gotoGridPage(page, p);
    const resp = await waitForGrid(page, p, have);
    const js = await resp.json();
    if (Array.isArray(js.rows) && js.rows.length) all.push(...js.rows);
    await sleep(jitter(250, 150));
  }
  return all;
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
  const yesPage1   = await respYes1.json();
  const yesRowsP1  = [...(yesPage1.rows || [])];
  const yesPageSz  = yesRowsP1.length || 10;
  const { pages: yesPages, records: yesRecords } = getPagerMeta(yesPage1, yesPageSz);

  // 用 UI 逐頁抓第 2..N 頁
  const yesRowsAllRaw = yesPages > 1
    ? await collectPagesViaUI(page, 1, yesPage1, yesPages)
    : yesRowsP1;

  // 去重
  const yesRowsAll = uniqByKey(yesRowsAllRaw);
  const yesAll = { total: yesRowsAll.length, rows: yesRowsAll };
  const uiInfoYes = await page.locator('.ui-paging-info').first().textContent().catch(()=>null);
  console.log(`有名額 → 原始:${yesRowsAllRaw.length} 唯一:${yesAll.total}（伺服器 records≈${yesRecords}, pages=${yesPages}, pageSize=${yesPageSz}）`,
              uiInfoYes ? ` | UI: ${uiInfoYes.trim()}` : '');

  /* ====== 硬重置：關閉彈窗 → 回主頁重開表單 ====== */
  await closeGridDialog(page);
  await reopenFormFromHome(page);

  // 3) UI 操作「桃園=9、無名額=否」→ 抓第1頁 JSON（從第 1 頁開始）
  await page.selectOption('#county', '9');
  await page.check('#isNo');

  const [respNo1] = await Promise.all([
    waitForGrid(page, 1, 0),
    triggerSearch(page)
  ]);
  const noPage1   = await respNo1.json();
  const noRowsP1  = [...(noPage1.rows || [])];
  const noPageSz  = noRowsP1.length || 10;
  const { pages: noPages, records: noRecords } = getPagerMeta(noPage1, noPageSz);

  const noRowsAllRaw = noPages > 1
    ? await collectPagesViaUI(page, 0, noPage1, noPages)
    : noRowsP1;

  const noRowsAll = uniqByKey(noRowsAllRaw);
  const noAll = { total: noRowsAll.length, rows: noRowsAll };
  const uiInfoNo = await page.locator('.ui-paging-info').first().textContent().catch(()=>null);
  console.log(`無名額 → 原始:${noRowsAllRaw.length} 唯一:${noAll.total}（伺服器 records≈${noRecords}, pages=${noPages}, pageSize=${noPageSz}）`,
              uiInfoNo ? ` | UI: ${uiInfoNo.trim()}` : '');

  // 4) 存 raw（已去重）
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_raw.json'), JSON.stringify(yesAll, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'taoyuan_no_raw.json'),  JSON.stringify(noAll,  null, 2), 'utf8');

  // 5) 清洗 + 合併 → 輸出
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

  await context.close();
  await browser.close();
  console.log('✅ 完成：out/taoyuan_* 檔案已產生');
})().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
