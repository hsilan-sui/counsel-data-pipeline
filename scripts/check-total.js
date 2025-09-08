#!/usr/bin/env node
/**
 * 檢查 JSON 的 total 與 rows 總數是否一致。
 * 用法：
 *   node scripts/check-total.js public/clinics.json          // 只檢查，不一致時退出碼 1
 *   node scripts/check-total.js public/clinics.json --fix    // 不一致時自動修正並寫回檔案
 *
 * 支援多種資料結構：
 *   1) { total: number, rows: [...] }
 *   2) { meta: { total: number }, rows: [...] }
 *   3) { total: number, data: [...] }
 *   4) { total: number, clinics: [...] }
 *   5) 頂層即為陣列（無 total 時僅提示）
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--')) || 'public/clinics.json';
const fix = args.includes('--fix');

function readJson(p) {
  const abs = path.resolve(process.cwd(), p);
  const raw = fs.readFileSync(abs, 'utf-8');
  return { abs, data: JSON.parse(raw) };
}

function findRows(d) {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.rows)) return d.rows;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d.clinics)) return d.clinics;
  return null;
}

function getTotalRef(d) {
  if (typeof d.total === 'number') return ['total'];
  if (d.meta && typeof d.meta.total === 'number') return ['meta', 'total'];
  return null; // 沒有 total 欄位
}

try {
  const { abs, data } = readJson(file);
  const rows = findRows(data);
  if (!rows) {
    console.error('找不到 rows 陣列：預期鍵 rows / data / clinics 或頂層即為陣列。');
    process.exit(1);
  }

  const actual = rows.length;
  const totalRef = getTotalRef(data);

  if (!totalRef) {
    console.warn(`找不到 total 欄位；rows.length=${actual}。若需自動補上可加 --fix。`);
    if (fix) {
      // 預設補在頂層 total
      if (!Array.isArray(data)) {
        data.total = actual;
        fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
        console.log(`已補上 total=${actual}`);
      } else {
        console.warn('頂層是純陣列，略過補寫 total。');
      }
    }
    process.exit(0);
  }

  const expected = totalRef.length === 1 ? data[totalRef[0]] : data[totalRef[0]][totalRef[1]];
  if (expected !== actual) {
    const loc = totalRef.join('.');
    const msg = `total 不一致：${loc}=${expected}，rows.length=${actual}`;
    if (fix) {
      if (totalRef.length === 1) data[totalRef[0]] = actual;
      else data[totalRef[0]][totalRef[1]] = actual;
      fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
      console.log(`${msg} → 已修正為 ${actual}`);
      process.exit(0);
    } else {
      console.error(msg);
      process.exit(1);
    }
  } else {
    console.log(`OK：total=${expected} 與 rows.length=${actual} 一致。`);
  }
} catch (e) {
  console.error('檢查失敗：', e.message);
  process.exit(1);
}
