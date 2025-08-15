// node taoyuan_mixed.playwright.js
// 流程：UI 先查第1頁 → 點「下一頁」逐頁抓 → 清洗合併 → 輸出
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
    // 若想改為「任一週 > 0」可換：o.has_quota = (o.this_week + o.next_week + o.next_2_week + o.next_3_week) > 0;
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
    const org = parseAnchor(r.orgName);
    const addr = parseAnchor(r.address);
    const k = `${r.countyName || ''}||${org.text || ''}||${addr.text || ''}`.trim();
    if (!m.has(k)) m.set(k, r);
  }
  return [...m.values()];
}

/* ---------- 等到 DataGrid 的 XHR（UI 點擊/翻頁） ---------- */
// 放寬：page or pageNumber 其一；haveServiceCount 可缺席
function waitForGrid(page, pageNo, have) {
  return page.waitForResponse(res => {
    if (!res.url().includes('/mhs/Home/QueryServiceOrgJsonList')) return false;
    if (res.request().method() !== 'POST') return false;
    const body = res.request().postData() || '';
    const params = new URLSearchParams(body);
    const p = params.get('page') || params.get('pageNumber') || '1';
    if (String(p) !== String(pageNo)) return false;
    const hv = (params.get('haveServiceCount') || '').toLowerCase();
    if (hv) {
      const want = have ? ['1','true','是'] : ['0','false','否'];
      if (!want.includes(hv)) return false;
    }
    return true;
  }, { timeout: 60000 });
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

/* ---------- 下一頁按鈕（找得到就回傳 <a>） ---------- */
function nextBtnLocator(page) {
  // 抓 a.l-btn.l-btn-plain 內含 .pagination-next 的按鈕
  return page.locator('a.l-btn.l-btn-plain', { has: page.locator('.pagination-next') }).first();
}
async function isNextDisabled(page) {
  const a = nextBtnLocator(page);
  if (!(await a.count())) return true;
  const cls = (await a.getAttribute('class')) || '';
  return /\bl-btn-disabled\b/.test(cls);
}

/* ---------- 點下一頁並等待該頁 XHR ---------- */
async function clickNextAndWait(page, nextPageNo, have) {
  const btn = nextBtnLocator(page);
  await Promise.all([
    waitForGrid(page, nextPageNo, have),
    btn.click({ force: true })
  ]);
}

/* ---------- 關閉彈窗 → 回主頁重開（讓另一個條件回到第1頁） ---------- */
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
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await ensureFormLoaded(page);
}

/* ---------- 以 UI 逐頁蒐集（第一頁已查到，再一路按「下一頁」） ---------- */
async function collectAllPagesByClick(page, have, firstJson) {
  const all = [...(firstJson.rows || [])];
  let pageNo = 1;
  // 最多保護 30 頁，避免意外無限迴圈
  for (let guard = 0; guard < 30; guard++) {
    if (await isNextDisabled(page)) break;
    pageNo += 1;
    const resp = await clickNextAndWait(page, pageNo, have);
    // waitForGrid 已確保對應頁碼，這裡再讀取最新回應
    const matchRes = await page.waitForResponse(r => {
      return r.url().includes('/mhs/Home/QueryServiceOrgJsonList') && r.request().method() === 'POST';
    }, { timeout: 10000 }).catch(() => null);
    const js = matchRes ? await matchRes.json().catch(()=>null) : null;
    const rows = (js && Array.isArray(js.rows)) ? js.rows : [];
    if (!rows.length) break;
    all.push(...rows);
    await sleep(jitter(200, 150));
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

  // ====== 有名額 ======
  await page.selectOption('#county', '9'); // 桃園
  await page.check('#isYes');

  const [respYes1] = await Promise.all([
    waitForGrid(page, 1, 1),
    triggerSearch(page)
  ]);
  const yesP1 = await respYes1.json();
  const yesAllRaw = await collectAllPagesByClick(page, 1, yesP1);
  const yesUniq = uniqByKey(yesAllRaw);
  const yesAll = { total: yesUniq.length, rows: yesUniq };
  const uiInfoYes = await page.locator('.ui-paging-info, .pagination-info').first().textContent().catch(()=>null);
  console.log(`有名額 → 原始:${yesAllRaw.length} 唯一:${yesUniq.length}`, uiInfoYes ? `| UI: ${uiInfoYes.trim()}` : '');

  // 重置為「無名額」必回到第 1 頁：關閉 → 回首頁 → 重開表單
  await closeGridDialog(page);
  await reopenFormFromHome(page);

  // ====== 無名額 ======
  await page.selectOption('#county', '9'); // 桃園
  await page.check('#isNo');

  const [respNo1] = await Promise.all([
    waitForGrid(page, 1, 0),
    triggerSearch(page)
  ]);
  const noP1 = await respNo1.json();
  const noAllRaw = await collectAllPagesByClick(page, 0, noP1);
  const noUniq = uniqByKey(noAllRaw);
  const noAll = { total: noUniq.length, rows: noUniq };
  const uiInfoNo = await page.locator('.ui-paging-info, .pagination-info').first().textContent().catch(()=>null);
  console.log(`無名額 → 原始:${noAllRaw.length} 唯一:${noUniq.length}`, uiInfoNo ? `| UI: ${uiInfoNo.trim()}` : '');

  // 3) 存 raw（已去重）
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_raw.json'), JSON.stringify(yesAll, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'taoyuan_no_raw.json'),  JSON.stringify(noAll,  null, 2), 'utf8');
  console.log(`桃園市 → 有名額：${yesAll.total}；無名額：${noAll.total}`);

  // 4) 清洗 + 合併 → 輸出
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

  await context.close(); await browser.close();
  console.log('✅ 完成：out/taoyuan_* 檔案已產生');
})().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
