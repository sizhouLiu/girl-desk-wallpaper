// usage: node tools/_shot.mjs out.png [query]
import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [out, q = ''] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1536, height: 864 } });
const p = await b.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/favicon|404|27183/.test(m.text()) && errs.push(m.text()));
await p.goto('http://localhost:5199/?parallax=0' + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__wp && window.__wp.stats().fps > 0, { timeout: 180000 });
await sleep(2500); await p.mouse.move(1530, 860); await sleep(300);
await p.screenshot({ path: out });
console.log(out, JSON.stringify(await p.evaluate(() => window.__wp.stats())), errs.join(' | ') || 'no errors');
await b.close();
