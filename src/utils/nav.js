// src/utils/nav.js
async function gotoWithRetries(page, url, { tries = 4, baseTimeoutMs = 60_000 } = {}) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
      const timeout = baseTimeoutMs * Math.pow(2, i - 1);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForSelector('#county', { timeout: 30_000 });
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`goto attempt ${i}/${tries} failed: ${err?.message}`);
        const jitter = Math.floor(Math.random() * 1500);
        await page.waitForTimeout(2000 * i + jitter);
      }
    }
    throw lastErr;
  }
  module.exports = { gotoWithRetries };
  