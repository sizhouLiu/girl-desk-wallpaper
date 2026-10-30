// Interaction smoke test: hover each interactive object, check the tooltip, click lamp / window / cat,
// and screenshot before/after.   node tools/interact_test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const url = 'http://localhost:5199/?parallax=0';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1920,1080'],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__wp && window.__wp.stats().fps > 0, { timeout: 180000 });
await new Promise((r) => setTimeout(r, 1500));

// for each interactive object: project sampled vertices and keep the first screen point whose ray really hits it
const targets = await page.evaluate(async () => {
  const meta = await (await fetch('scene.json')).json();
  const { scene, camera } = window.__wp;
  const V = camera.position.constructor;
  const out = {}, report = {};
  const names = Object.entries(meta.interactive).flatMap(([k, l]) => l.map((b) => [k, b.name]))
    .concat(Object.keys(meta.books).slice(0, 6).map((n) => ['book', n]));
  for (const [k, n] of names) {
    const root = scene.getObjectByName(n) || scene.getObjectByName(n.replace(/\./g, ''));
    if (!root) { report[n] = 'not in scene'; continue; }
    let found = null, tried = 0, inframe = 0;
    root.traverse((m) => {
      if (found || !m.isMesh || m.name.endsWith('__outline')) return;
      const pos = m.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 400));
      for (let i = 0; i < pos.count && !found; i += step) {
        const p = new V().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(camera);
        tried++;
        if (p.z >= 1 || Math.abs(p.x) > 0.97 || Math.abs(p.y) > 0.97) continue;
        inframe++;
        const x = Math.round((p.x + 1) / 2 * innerWidth), y = Math.round((1 - p.y) / 2 * innerHeight);
        const hits = window.__wp.pickAt(x, y) || [];
        if (hits[0] && hits[0].path.some((s) => s === n || s === n.replace(/\./g, '') || s.startsWith(n))) found = { name: n, x, y };
      }
    });
    report[n] = found ? 'ok' : `no unoccluded point (sampled ${tried}, in frame ${inframe})`;
    if (found && (out[k] ||= []).length < 3) out[k].push(found);
  }
  return { out, report };
});
console.log('target report', JSON.stringify(targets.report));
Object.assign(targets, targets.out); delete targets.out; delete targets.report;

const _unused = await page.evaluate(async () => {
  const meta = await (await fetch('scene.json')).json();
  const cam = window.__wp.camera;
  const THREE_V = cam.position.constructor;
  const out = {};
  for (const [k, list] of Object.entries(meta.interactive)) {
    for (const b of list) {
      const c = new THREE_V((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2).project(cam);
      if (c.z < 1 && Math.abs(c.x) < 0.98 && Math.abs(c.y) < 0.98)
        (out[k] ||= []).push({ name: b.name, x: Math.round((c.x + 1) / 2 * innerWidth), y: Math.round((1 - c.y) / 2 * innerHeight) });
    }
  }
  // a couple of books
  const books = Object.keys(meta.books).slice(0, 40);
  const scene = window.__wp.scene;
  out.book = [];
  for (const n of books) {
    const o = scene.getObjectByName(n); if (!o) continue;
    const p = new THREE_V(); o.getWorldPosition(p);
    const box = { x: 0, y: 0 };
    o.traverse((m) => { if (m.isMesh && !box.done) { m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld); bb.getCenter(p); box.done = true; } });
    const c = p.clone().project(cam);
    if (c.z < 1 && Math.abs(c.x) < 0.95 && Math.abs(c.y) < 0.95) out.book.push({ name: n, x: Math.round((c.x + 1) / 2 * innerWidth), y: Math.round((1 - c.y) / 2 * innerHeight) });
    if (out.book.length >= 3) break;
  }
  return out;
});
console.log('targets', JSON.stringify(targets));

const tip = async () => page.evaluate(() => { const t = document.getElementById('tooltip'); return t.style.display === 'block' ? t.textContent : ''; });
const results = {};
for (const [k, list] of Object.entries(targets)) {
  for (const t of list.slice(0, 3)) {
    await page.mouse.move(t.x, t.y);
    await new Promise((r) => setTimeout(r, 250));
    results[`${k}:${t.name}`] = await tip();
  }
}
console.log('hover', JSON.stringify(results, null, 0));

// state probes
const state = () => page.evaluate(() => {
  const s = window.__wp.scene;
  const L = (n) => { const l = s.getObjectByName(n); return l ? +l.intensity.toFixed(4) : null; };
  return { lamp: L('LGT_LampBulb'), moon: L('LGT_Moon'), win: L('LGT_Window') };
});
const clickAt = async (k) => { const t = (targets[k] || [])[0]; if (!t) return false; await page.mouse.move(t.x, t.y); await page.mouse.click(t.x, t.y); return true; };
const s0 = await state();
await page.screenshot({ path: 'work/it_before.png' });
const did = { lamp: await clickAt('lamp') };
await new Promise((r) => setTimeout(r, 1200));
const s1 = await state();
did.window = await clickAt('window');
await new Promise((r) => setTimeout(r, 3000));
const s2 = await state();
did.cat = await clickAt('cat');
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: 'work/it_after.png' });
console.log('clicked', JSON.stringify(did));
console.log('state before', JSON.stringify(s0), '| after lamp', JSON.stringify(s1), '| after window', JSON.stringify(s2));
console.log(errs.length ? 'errors:\n' + errs.slice(0, 10).join('\n') : 'no page errors');
await browser.close();
