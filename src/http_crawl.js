// src/http_crawl.js — 直接打 JSON API，不開瀏覽器（含 Session/Token）
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');

const BASE = 'https://sps.mohw.gov.tw/mhs';
const FORM = `${BASE}/Home/QueryServiceOrg`;
const API  = `${BASE}/Home/QueryServiceOrgJsonList`;
const OUT  = path.resolve('./out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const COUNTY_VALUE = process.env.COUNTY_VALUE || '9'; // 桃園

// ------ 先 GET 表單頁，取得 Session cookie / 防偽 token ------
async function getSession() {
  const res = await fetch(FORM, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (CI http crawler)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GET FORM failed: ${res.status}`);

  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie
    .split(/, (?=[^;]+?=)/)  // 拆多個 Set-Cookie
    .map(s => s.split(';')[0])
    .filter(Boolean)
    .join('; ');

  const html = await res.text();
  let token = null;
  const m1 = html.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i);
  if (m1) token = m1[1];
  if (!token) {
    const m2 = html.match(/RequestVerificationToken["']?\s*[:=]\s*["']([^"']+)["']/i);
    if (m2) token = m2[1];
  }
  return { cookie, token };
}

// ------ POST datagrid API，帶上 cookie/token ------
async function postPage(pageNo, rows, isYes, session) {
  const body = new URLSearchParams({
    // 有些站欄位叫 county，有些叫 countyId；兩個都放不會壞
    county: COUNTY_VALUE,
    countyId: COUNTY_VALUE,
    isYes: isYes ? 'true' : 'false',
    page: String(pageNo),
    rows: String(rows || 10),
    sort: '',
    order: ''
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Origin': BASE,
    'Referer': FORM,
    'User-Agent': 'Mozilla/5.0 (CI http crawler)',
    'Cookie': session?.cookie || '',
  };
  if (session?.token) {
    headers['RequestVerificationToken'] = session.token;
    body.append('__RequestVerificationToken', session.token);
  }

  const res = await fetch(API, { method: 'POST', headers, body, redirect: 'follow' });
  if (res.status === 403 || res.status === 419) throw new Error(`Forbidden ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const js = await res.json().catch(() => ({}));
  const list = Array.isArray(js.rows) ? js.rows : (Array.isArray(js) ? js : []);
  const total = Number.isFinite(js.total) ? js.total : list.length;
  return { total, rows: list };
}

// ------ 清洗 / 合併 / 輔助 ------
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
const toInt = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
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
function toCSV(rows, headers) {
  const esc = v => (v === null || v === undefined) ? '' : /[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

// ------ 主流程：桃園（可擴大到全台） ------
(async () => {
  // 1) 取 session
  let session = await getSession();

  // 2) 有名額
  const perPage = 10;
  const firstYes = await postPage(1, perPage, true, session).catch(async e => {
    // 若剛好 session 失效，重取一次
    session = await getSession();
    return postPage(1, perPage, true, session);
  });
  const totalYes = firstYes.total || (firstYes.rows || []).length;
  const yesPages = Math.max(1, Math.ceil(totalYes / perPage));
  const yesRows = [...(firstYes.rows || [])];
  for (let p = 2; p <= yesPages; p++) {
    const js = await postPage(p, perPage, true, session);
    if (js.rows?.length) yesRows.push(...js.rows);
  }
  const yesUniq = uniqByKey(yesRows);
  fs.writeFileSync(path.join(OUT, 'taoyuan_yes_raw.json'), JSON.stringify({ total: yesUniq.length, rows: yesUniq }, null, 2), 'utf8');

  // 3) 無名額
  const firstNo = await postPage(1, perPage, false, session);
  const totalNo = firstNo.total || (firstNo.rows || []).length;
  const noPages = Math.max(1, Math.ceil(totalNo / perPage));
  const noRows = [...(firstNo.rows || [])];
  for (let p = 2; p <= noPages; p++) {
    const js = await postPage(p, perPage, false, session);
    if (js.rows?.length) noRows.push(...js.rows);
  }
  const noUniq = uniqByKey(noRows);
  fs.writeFileSync(path.join(OUT, 'taoyuan_no_raw.json'), JSON.stringify({ total: noUniq.length, rows: noUniq }, null, 2), 'utf8');

  // 4) 清洗 + 合併 + 輸出
  const cleanedYes = cleanRows(yesUniq);
  const cleanedNo  = cleanRows(noUniq);
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

  console.log('✅ HTTP 模式完成：out/taoyuan_* 已產生');
})().catch(e => {
  console.error('❌ HTTP 模式失敗：', e);
  process.exit(1);
});
