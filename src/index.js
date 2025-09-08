// src/index.js
/* eslint-disable no-console */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { format } = require('@fast-csv/format');

// ========== 可調整區：目標站與選擇器 ==========
const START_URL = 'https://sps.mohw.gov.tw/mhs';

const SELECTORS = {
  countySelect: '#county, select#ctl00_ContentPlaceHolder1_ddlCounty, select#countySelect',
  // 「有名額 / 無名額」切換（盡量以文字命中；若站上是 radio/按鈕都可）
  hasQuotaBtn: 'text=有名額, text="有名額", [data-filter="yes"]',
  noQuotaBtn: 'text=無名額, text="無名額", [data-filter="no"]',

  // 查詢/送出按鈕
  submitBtn: 'button:has-text("查詢"), button:has-text("搜尋"), input[type="submit"][value*="查詢"]',

  // 分頁
  totalPagesText: '.total-pages, .pagination-total, span.total-pages',
  nextPageBtn: 'button:has-text("下一頁"), a:has-text("下一頁"), .pagination .next',

  // 表格資料（tbody > tr）
  tableRows: 'table tbody tr',

  // 每列欄位（盡量寬鬆，會 fallback 成用 td 的文字）
  colClinic: 'td:nth-child(1), [data-col="clinic"], .col-clinic',
  colAddress: 'td:nth-child(2), [data-col="address"], .col-address',
  colPhone: 'td:nth-child(3), [data-col="phone"], .col-phone',
  colWebsite: 'td:nth-child(4) a, [data-col="website"] a, .col-website a',
  colWeeks: 'td:nth-child(5), [data-col="weeks"], .col-weeks', // 站上常有「未來四週名額」欄
};

// ========== 輔助：寫檔 ==========
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function saveJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log('📝 JSON saved:', p);
}

function saveCSV(p, rows) {
  ensureDir(path.dirname(p));
  return new Promise((resolve, reject) => {
    const stream = format({ headers: true });
    const ws = fs.createWriteStream(p);
    stream.pipe(ws).on('finish', () => {
      console.log('📝 CSV saved:', p);
      resolve();
    }).on('error', reject);
    rows.forEach((r) => stream.write(r));
    stream.end();
  });
}

// ========== 輔助：清洗 ==========
function normalizeText(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function mergeYesNoToClean(yesList, noList, countyCode, countyName) {
  // 基本策略：以「機構名 + 地址」當 key 去重
  const map = new Map();
  function put(arr, hasQuota) {
    for (const it of arr) {
      const key = `${normalizeText(it.clinic)}|${normalizeText(it.address)}`;
      const existed = map.get(key);
      if (!existed) {
        map.set(key, {
          countyCode,
          countyName,
          clinic: normalizeText(it.clinic),
          address: normalizeText(it.address),
          phone: normalizeText(it.phone),
          website: normalizeText(it.website),
          weeks: normalizeText(it.weeks),
          hasQuota: !!hasQuota,
        });
      } else {
        // 若 yes/no 兩邊都有，以 yes 為主
        existed.hasQuota = existed.hasQuota || !!hasQuota;
        existed.phone = existed.phone || normalizeText(it.phone);
        existed.website = existed.website || normalizeText(it.website);
        existed.weeks = existed.weeks || normalizeText(it.weeks);
      }
    }
  }
  put(noList, false);
  put(yesList, true);
  return Array.from(map.values());
}

// ========== Playwright 進站強化 ==========
async function looksLikeChallenge(page) {
  const html = (await page.content()).toLowerCase();
  return (
    html.includes('checking your browser') ||
    html.includes('確認你的瀏覽器') ||
    html.includes('cloudflare') ||
    html.includes('just a moment') ||
    html.includes('captcha') ||
    html.includes('ddos')
  );
}

async function gotoStable(page, url, {
  waitUntil = 'domcontentloaded',
  timeout = 180000,
  tries = 4,
  label = 'goto_fail',
} = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i += 1) {
    try {
      await page.goto(url, { waitUntil, timeout });

      if (await looksLikeChallenge(page)) {
        console.warn(`[gotoStable] challenge detected; waiting... (${i}/${tries})`);
        await page.waitForTimeout(6000);
        if (await looksLikeChallenge(page)) {
          throw new Error('Challenge page still present');
        }
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[gotoStable] attempt ${i}/${tries} failed: ${err.message}`);
      try {
        const stamp = `try${i}`;
        await page.screenshot({ path: path.join('out', `${label}_${stamp}.png`), fullPage: true });
        const html = await page.content();
        fs.writeFileSync(path.join('out', `${label}_${stamp}.html`), html);
      } catch { /* ignore */ }

      if (i < tries) {
        await page.waitForTimeout(3000 * i); // 3s,6s,9s...
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { /* ignore */ }
      }
    }
  }
  const msg = `Fatal: ${lastErr?.name || 'Error'}: ${lastErr?.message || lastErr}`;
  console.error(msg);
  fs.writeFileSync(path.join('out', 'fatal.txt'), msg);
  throw lastErr;
}

// ========== 抓取核心：逐頁讀表格 ==========
async function readResultTable(page) {
  const rows = await page.$$(SELECTORS.tableRows);
  const data = [];

  for (const r of rows) {
    // 嘗試多種欄位抓法，若 selector 失敗則 fallback 讀所有 td
    const clinic = normalizeText(await r.locator(SELECTORS.colClinic).first().innerText().catch(() => ''));
    const address = normalizeText(await r.locator(SELECTORS.colAddress).first().innerText().catch(() => ''));
    const phone = normalizeText(await r.locator(SELECTORS.colPhone).first().innerText().catch(() => ''));
    const website = normalizeText(await r.locator(SELECTORS.colWebsite).first().getAttribute('href').catch(() => ''));
    const weeks = normalizeText(await r.locator(SELECTORS.colWeeks).first().innerText().catch(() => ''));

    if (clinic || address || phone || website || weeks) {
      data.push({ clinic, address, phone, website, weeks });
      continue;
    }

    // fallback：讀所有 td 文字，盡量猜測欄位順序
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
  // 常見寫法：頁面有「共 N 頁」；若沒有，就用下一頁按鈕是否存在推測
  const textHandle = await page.$(SELECTORS.totalPagesText);
  if (textHandle) {
    const text = await textHandle.innerText().catch(() => '');
    const m = text.match(/(\d+)\s*頁/);
    if (m) return parseInt(m[1], 10);
  }
  // fallback：看是否有下一頁，若沒有就 1 頁
  const nextExists = await page.$(SELECTORS.nextPageBtn);
  return nextExists ? 2 : 1; // 2 代表至少還有下一頁（之後會 while 檢查）
}

async function clickIfExists(page, selector, timeout = 5000) {
  const el = await page.$(selector);
  if (el) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {}),
      el.click().catch(() => {}),
    ]);
    await page.waitForTimeout(300); // 稍微等一下動態變更
    return true;
  }
  return false;
}

async function paginateAndCollect(page) {
  const all = [];
  // 先讀當前頁
  all.push(...(await readResultTable(page)));

  // 嘗試讀「共 N 頁」；若無，改以「能不能點下一頁」的方式跑
  let total = await getTotalPages(page);
  if (total <= 1) return all;

  // 若有總頁數，以「下一頁」按 N-1 次
  for (let i = 2; i <= total; i += 1) {
    const ok = await clickIfExists(page, SELECTORS.nextPageBtn, 15000);
    if (!ok) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    all.push(...(await readResultTable(page)));
  }
  return all;
}

async function runOneFilter(page, isYes) {
  const btn = isYes ? SELECTORS.hasQuotaBtn : SELECTORS.noQuotaBtn;
  // 先切換「有名額/無名額」
  await clickIfExists(page, btn, 15000);
  // 按查詢/送出
  await clickIfExists(page, SELECTORS.submitBtn, 20000);
  // 收集
  return paginateAndCollect(page);
}

async function crawlOneCounty(page, countyCode, countyName, outDir) {
  console.log(`\n==> 爬取縣市：${countyCode}_${countyName}`);

  // 選縣市
  const select = await page.$(SELECTORS.countySelect);
  if (!select) throw new Error('找不到縣市下拉選單，請調整 SELECTORS.countySelect');
  await select.selectOption({ label: countyName }).catch(async () => {
    // 如果以 label 失敗，試 value（可能是兩位數代碼）
    await select.selectOption({ value: countyCode.padStart(2, '0') });
  });

  // 有名額
  const yesList = await runOneFilter(page, true);
  const yesPath = path.join(outDir, `${countyCode}_${countyName}_yes_raw.json`);
  saveJSON(yesPath, yesList);

  // 回首頁/或重設（保守作法：回到起始頁再選一次）
  await gotoStable(page, START_URL, { label: `revisit_${countyCode}` });
  const select2 = await page.$(SELECTORS.countySelect);
  if (!select2) throw new Error('回首頁後找不到縣市下拉選單');
  await select2.selectOption({ label: countyName }).catch(async () => {
    await select2.selectOption({ value: countyCode.padStart(2, '0') });
  });

  // 無名額
  const noList = await runOneFilter(page, false);
  const noPath = path.join(outDir, `${countyCode}_${countyName}_no_raw.json`);
  saveJSON(noPath, noList);

  // 合併清洗
  const merged = mergeYesNoToClean(yesList, noList, countyCode, countyName);
  const jsonPath = path.join(outDir, `${countyCode}_${countyName}_merged_clean.json`);
  const csvPath = path.join(outDir, `${countyCode}_${countyName}_merged_clean.csv`);
  saveJSON(jsonPath, merged);
  await saveCSV(csvPath, merged);

  return { merged, yes: yesList.length, no: noList.length };
}

async function getCountyOptions(page) {
  await page.waitForSelector(SELECTORS.countySelect, { timeout: 20000 });
  const options = await page.$$eval(
    `${SELECTORS.countySelect} option`,
    (els) => els
      .map((o) => ({ value: (o.value || '').trim(), label: (o.textContent || '').trim() }))
      .filter((o) => o.value && o.label && !/^(請選擇|全部)$/i.test(o.label))
  );
  // 將 value 補零到兩位（如 1 -> 01）
  return options.map((o) => ({
    code: String(o.value).padStart(2, '0'),
    name: o.label.replace(/\s+/g, ''),
  }));
}

// ========== 主流程 ==========
(async () => {
  const OUT_ARG_IDX = process.argv.indexOf('--out');
  const OUTPUT_TAIWAN = OUT_ARG_IDX > -1 ? process.argv[OUT_ARG_IDX + 1] : './out/taiwan_merged_clean.json';
  const OUTPUT_DIR = path.dirname(OUTPUT_TAIWAN);

  ensureDir('out');
  ensureDir('data');
  ensureDir('public');
  ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
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
  });

  const page = await context.newPage();

  // 阻擋圖片/字型/追蹤，提升載入速率
  await page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (
      type === 'image' ||
      type === 'font' ||
      url.includes('google-analytics') ||
      url.includes('gtag') ||
      url.includes('doubleclick') ||
      url.includes('googletagmanager')
    ) return route.abort();
    return route.continue();
  });

  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(180000);

  console.log('➡️  打開入口頁面：', START_URL);
  await gotoStable(page, START_URL, { label: 'goto_fail' });

  // 抓縣市列表
  const counties = await getCountyOptions(page);

  // 若你只想跑固定的 22 個（與你 log 一致），可在此排序/過濾
  // 這裡僅印出開頭
  console.log('將處理縣市（共 %d 個）： %s', counties.length,
    counties.map((c) => `${c.code}_${c.name}`).join(', '));

  const taiwanAll = [];
  for (const c of counties) {
    try {
      const { merged } = await crawlOneCounty(page, c.code, c.name, OUTPUT_DIR);
      taiwanAll.push(...merged);
    } catch (err) {
      console.warn(`縣市 ${c.code}_${c.name} 失敗：${err.message}`);
      // 保留不中斷，繼續下個縣市
    }
  }

  // 全台彙總
  saveJSON(OUTPUT_TAIWAN, taiwanAll);
  const TAIWAN_CSV = path.join(OUTPUT_DIR, 'taiwan_merged_clean.csv');
  await saveCSV(TAIWAN_CSV, taiwanAll);

  await browser.close();
  console.log('✅ 全部完成');
})().catch((err) => {
  console.error(err);
  // 儘量列出 out 目錄，便於 CI 上除錯（與你現有做法一致）
  try {
    console.warn('[WARN] index.js 失敗，嘗試列出 out 目錄以利除錯');
    const files = fs.readdirSync('out');
    for (const f of files) {
      const stat = fs.statSync(path.join('out', f));
      console.log(stat.size.toString().padStart(10, ' '), f);
    }
  } catch { /* ignore */ }
  process.exit(1);
});
