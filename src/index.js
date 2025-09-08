// src/index.js
/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { format } = require('@fast-csv/format');

const START_URL = 'https://sps.mohw.gov.tw/mhs';

const SELECTORS = {
  countySelect: '#county, select#ctl00_ContentPlaceHolder1_ddlCounty, select#countySelect',
  hasQuotaBtn: 'text=有名額, text="有名額", [data-filter="yes"]',
  noQuotaBtn: 'text=無名額, text="無名額", [data-filter="no"]',
  submitBtn: 'button:has-text("查詢"), button:has-text("搜尋"), input[type="submit"][value*="查詢"]',
  resetBtn: 'button:has-text("重設"), button:has-text("清除"), input[type="reset"]',
  tableRows: 'table tbody tr',
  totalPagesText: '.total-pages, .pagination-total, span.total-pages',
  nextPageBtn: 'button:has-text("下一頁"), a:has-text("下一頁"), .pagination .next',
  colClinic: 'td:nth-child(1), [data-col="clinic"], .col-clinic',
  colAddress: 'td:nth-child(2), [data-col="address"], .col-address',
  colPhone: 'td:nth-child(3), [data-col="phone"], .col-phone',
  colWebsite: 'td:nth-child(4) a, [data-col="website"] a, .col-website a',
  colWeeks: 'td:nth-child(5), [data-col="weeks"], .col-weeks',
};

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function saveJSON(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data, null, 2)); console.log('📝 JSON saved:', p); }
function saveCSV(p, rows) {
  ensureDir(path.dirname(p));
  return new Promise((resolve, reject) => {
    const stream = format({ headers: true });
    const ws = fs.createWriteStream(p);
    stream.pipe(ws).on('finish', () => { console.log('📝 CSV saved:', p); resolve(); }).on('error', reject);
    rows.forEach((r) => stream.write(r));
    stream.end();
  });
}

function normalizeText(s) { return (s || '').replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim(); }

function mergeYesNoToClean(yesList, noList, countyCode, countyName) {
  const map = new Map();
  function put(arr, hasQuota) {
    for (const it of arr) {
      const key = `${normalizeText(it.clinic)}|${normalizeText(it.address)}`;
      const existed = map.get(key);
      if (!existed) {
        map.set(key, {
          countyCode, countyName,
          clinic: normalizeText(it.clinic),
          address: normalizeText(it.address),
          phone: normalizeText(it.phone),
          website: normalizeText(it.website),
          weeks: normalizeText(it.weeks),
          hasQuota: !!hasQuota,
        });
      } else {
        existed.hasQuota = existed.hasQuota || !!hasQuota;
        existed.phone ||= normalizeText(it.phone);
        existed.website ||= normalizeText(it.website);
        existed.weeks ||= normalizeText(it.weeks);
      }
    }
  }
  put(noList, false);
  put(yesList, true);
  return Array.from(map.values());
}

async function looksLikeChallenge(page) {
  const html = (await page.content()).toLowerCase();
  return html.includes('checking your browser')
      || html.includes('確認你的瀏覽器')
      || html.includes('cloudflare')
      || html.includes('just a moment')
      || html.includes('captcha')
      || html.includes('ddos');
}

// 只在啟動時用一次；之後不再做任何 page.goto()
async function gotoStable(page, url, {
  waitFor = SELECTORS.countySelect,  // 關鍵元素可操作即可
  timeout = 180000,
  tries = 4,
  label = 'goto_fail',
} = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i += 1) {
    try {
      await page.goto(url, { timeout });        // 不設定 waitUntil，提早回來
      if (await looksLikeChallenge(page)) {
        console.warn(`[gotoStable] challenge detected; waiting... (${i}/${tries})`);
        await page.waitForTimeout(6000);
      }
      await page.waitForSelector(waitFor, { timeout: Math.max(15000, timeout / 3) });
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[gotoStable] attempt ${i}/${tries} failed: ${err.message}`);
      try {
        const stamp = `try${i}`;
        await page.screenshot({ path: path.join('out', `${label}_${stamp}.png`), fullPage: true });
        const html = await page.content();
        fs.writeFileSync(path.join('out', `${label}_${stamp}.html`), html);
      } catch {}
      if (i < tries) {
        await page.waitForTimeout(3000 * i);
        try { await page.reload({ timeout: 60000 }); } catch {}
      }
    }
  }
  const msg = `Fatal: ${lastErr?.name || 'Error'}: ${lastErr?.message || lastErr}`;
  console.error(msg);
  fs.writeFileSync(path.join('out', 'fatal.txt'), msg);
  throw lastErr;
}

async function readResultTable(page) {
  const rows = await page.$$(SELECTORS.tableRows);
  const data = [];
  for (const r of rows) {
    const clinic = normalizeText(await r.locator(SELECTORS.colClinic).first().innerText().catch(() => ''));
    const address = normalizeText(await r.locator(SELECTORS.colAddress).first().innerText().catch(() => ''));
    const phone = normalizeText(await r.locator(SELECTORS.colPhone).first().innerText().catch(() => ''));
    const website = normalizeText(await r.locator(SELECTORS.colWebsite).first().getAttribute('href').catch(() => ''));
    const weeks = normalizeText(await r.locator(SELECTORS.colWeeks).first().innerText().catch(() => ''));
    if (clinic || address || phone || website || weeks) {
      data.push({ clinic, address, phone, website, weeks });
      continue;
    }
    const tds = await r.$$eval('td', (els) => els.map((el) => el.textContent || ''));
    if (tds.length) {
      data.push({
        clinic: normalizeText(tds[0] || ''),
        address: normalizeText(tds[1] || ''),
        phone: normalizeText(tds[2] || ''),
        website: '',
        weeks: normalizeText(tds[4] || tds[3] || ''),
      });
    }
  }
  return data;
}

async function getTotalPages(page) {
  const textHandle = await page.$(SELECTORS.totalPagesText);
  if (textHandle) {
    const text = await textHandle.innerText().catch(() => '');
    const m = text.match(/(\d+)\s*頁/);
    if (m) return parseInt(m[1], 10);
  }
  const nextExists = await page.$(SELECTORS.nextPageBtn);
  return nextExists ? 2 : 1;
}

async function clickIfExists(page, selector, timeout = 12000) {
  const el = await page.$(selector);
  if (el) {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout }),
      el.click().catch(() => {}),
    ]);
    await page.waitForTimeout(200);
    return true;
  }
  return false;
}

// ★ 不再 reload/回首頁，純切換 filter 與翻頁
async function runOneFilter(page, isYes) {
  const btn = isYes ? SELECTORS.hasQuotaBtn : SELECTORS.noQuotaBtn;
  await clickIfExists(page, btn, 20000);
  await clickIfExists(page, SELECTORS.submitBtn, 20000);
  return paginateAndCollect(page);
}

async function paginateAndCollect(page) {
  const all = [];
  all.push(...(await readResultTable(page)));
  let total = await getTotalPages(page);
  for (let i = 2; i <= total; i += 1) {
    const ok = await clickIfExists(page, SELECTORS.nextPageBtn, 15000);
    if (!ok) break;
    all.push(...(await readResultTable(page)));
  }
  return all;
}

// ★ 重新選縣市與清理查詢條件（不離開頁面）
async function setCountyAndReset(page, countyCode, countyName) {
  const select = await page.$(SELECTORS.countySelect);
  if (!select) throw new Error('找不到縣市下拉選單，請調整 SELECTORS.countySelect');

  // 先按重設（如果有），再選縣市
  await clickIfExists(page, SELECTORS.resetBtn, 8000).catch(() => {});
  await select.selectOption({ label: countyName }).catch(async () => {
    await select.selectOption({ value: countyCode.padStart(2, '0') });
  });

  // 一些站會用 onchange 發請求，等一下穩定
  await page.waitForTimeout(300);
}

async function crawlOneCounty(page, countyCode, countyName, outDir) {
  console.log(`\n==> 爬取縣市：${countyCode}_${countyName}`);
  await setCountyAndReset(page, countyCode, countyName);

  // 先跑「有名額」
  const yesList = await runOneFilter(page, true);
  saveJSON(path.join(outDir, `${countyCode}_${countyName}_yes_raw.json`), yesList);

  // 直接切到「無名額」（不 reload）
  await setCountyAndReset(page, countyCode, countyName);
  const noList = await runOneFilter(page, false);
  saveJSON(path.join(outDir, `${countyCode}_${countyName}_no_raw.json`), noList);

  const merged = mergeYesNoToClean(yesList, noList, countyCode, countyName);
  const jsonPath = path.join(outDir, `${countyCode}_${countyName}_merged_clean.json`);
  const csvPath = path.join(outDir, `${countyCode}_${countyName}_merged_clean.csv`);
  saveJSON(jsonPath, merged);
  await saveCSV(csvPath, merged);

  return merged;
}

async function getCountyOptions(page) {
  await page.waitForSelector(SELECTORS.countySelect, { timeout: 20000 });
  const options = await page.$$eval(
    `${SELECTORS.countySelect} option`,
    (els) => els
      .map((o) => ({ value: (o.value || '').trim(), label: (o.textContent || '').trim() }))
      .filter((o) => o.value && o.label && !/^(請選擇|全部)$/i.test(o.label))
  );
  return options.map((o) => ({ code: String(o.value).padStart(2, '0'), name: o.label.replace(/\s+/g, '') }));
}

(async () => {
  const OUT_ARG_IDX = process.argv.indexOf('--out');
  const OUTPUT_TAIWAN = OUT_ARG_IDX > -1 ? process.argv[OUT_ARG_IDX + 1] : './out/taiwan_merged_clean.json';
  const OUTPUT_DIR = path.dirname(OUTPUT_TAIWAN);

  ensureDir('out'); ensureDir('data'); ensureDir('public'); ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,900',
      // 有些 CDN/節點的 HTTP/2 實作在雲端環境容易 reset，可以嘗試關掉（可留可拿掉）
      '--disable-http2',
    ],
  });

  const NOMINATIM_UA = process.env.NOMINATIM_USER_AGENT || 'suihsilan-crawler/1.0';
  const context = await browser.newContext({
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36 ${NOMINATIM_UA}`,
    extraHTTPHeaders: {
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      'Sec-CH-UA-Platform': '"Linux"',
      'Sec-CH-UA-Mobile': '?0',
    },
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (type === 'image' || type === 'font' ||
        url.includes('google-analytics') || url.includes('gtag') ||
        url.includes('doubleclick') || url.includes('googletagmanager')) {
      return route.abort();
    }
    return route.continue();
  });

  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(180000);

  // ★ 只進站一次
  console.log('➡️  打開入口頁面：', START_URL);
  await gotoStable(page, START_URL, { label: 'goto_fail_once' });

  // 抓縣市列表（若你要固定順序，也可直接寫死那 22 個）
  const counties = await getCountyOptions(page);
  console.log('將處理縣市（共 %d 個）： %s', counties.length, counties.map((c) => `${c.code}_${c.name}`).join(', '));

  // 逐縣市（同一頁面內操作，不再做任何 page.goto）
  const taiwanAll = [];
  let processed = 0;
  for (const c of counties) {
    try {
      const merged = await crawlOneCounty(page, c.code, c.name, OUTPUT_DIR);
      taiwanAll.push(...merged);
      processed += 1;

      // 輕度節流，降低被風控判定
      if (processed % 5 === 0) await page.waitForTimeout(2500);
      else await page.waitForTimeout(300 + Math.floor(Math.random() * 500));
    } catch (err) {
      console.warn(`縣市 ${c.code}_${c.name} 失敗：${err.message}`);
    }
  }

  saveJSON(OUTPUT_TAIWAN, taiwanAll);
  await saveCSV(path.join(OUTPUT_DIR, 'taiwan_merged_clean.csv'), taiwanAll);

  await browser.close();
  console.log('✅ 全部完成（整個流程只進站一次，無再導回入口）');
})().catch((err) => {
  console.error(err);
  try {
    console.warn('[WARN] index.js 失敗，嘗試列出 out 目錄以利除錯');
    const files = fs.readdirSync('out');
    for (const f of files) {
      const stat = fs.statSync(path.join('out', f));
      console.log(stat.size.toString().padStart(10, ' '), f);
    }
  } catch {}
  process.exit(1);
});
