// Headless check: open the wallpaper in local Chrome, wait for it to render,
// print console errors + stats, and save a screenshot.
//   node tools/shot.mjs [url] [out.png] [wait-seconds]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:5199/?showStats=1';
const out = process.argv[3] || 'work/shot.png';
const wait = Number(process.argv[4] || 12);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080',
         ...(process.env.NOVSYNC ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
const probe = (process.env.PROBE || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__wp && window.__wp.stats().fps > 0, { timeout: 180000 }).catch(() => logs.push('[timeout] never rendered a frame'));
const loadS = ((Date.now() - t0) / 1000).toFixed(1);
await new Promise((r) => setTimeout(r, wait * 1000));
const stats = await page.evaluate(() => {
  if (!window.__wp) return null;
  const gl = window.__wp.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { ...window.__wp.stats(), gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?',
           geometries: window.__wp.renderer.info.memory.geometries, textures: window.__wp.renderer.info.memory.textures };
});
if (probe.length) {
  const hits = await page.evaluate((pts) => window.__wp.pickAt ? pts.map(([x, y]) => [x, y, window.__wp.pickAt(x, y)]) : 'no pickAt', probe);
  console.log('probe', JSON.stringify(hits));
}
await page.screenshot({ path: out });
console.log('load', loadS, 's');
console.log('stats', JSON.stringify(stats));
console.log(logs.slice(0, 25).join('\n') || 'no console errors');
await browser.close();
