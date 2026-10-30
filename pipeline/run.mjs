// One-command build: Blender scene -> Wallpaper Engine web wallpaper.
//
//   npm run pipeline -- [--config wallpaper.config.json] [--blend <file>] [--blender <exe>]
//                       [--skip-export] [--rebake] [--check]
//
// Steps (each must succeed before the next runs):
//   export    Blender headless: .blend -> export/room.glb + export/scene.json      (skipped with --skip-export)
//   optimize  textures -> WebP, geometry -> meshopt: export/room.glb -> public/room.glb
//   runtime   wallpaper.config.json -> public/runtime.json, public/scene.json, public/project.json camera list
//   build     vite build -> dist/
//   package   dist/ -> wallpaper/ (what Wallpaper Engine imports) + release/<name>.zip
//   check     open wallpaper/index.html from disk, screenshot every camera, fail on page errors   (--check)
//
// Writes work/pipeline/report.json  { ok, steps: [{ name, ok, ms, log }], outputs: { wallpaper, zip, screenshots } }
// and the full output of each step to work/pipeline/<step>.log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// ---------------------------------------------------------------- args / config
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const CONFIG = path.resolve(opt('--config', 'wallpaper.config.json'));
let OUT_DIR = path.join(ROOT, 'work', 'pipeline');
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = { ok: false, started: new Date().toISOString(), config: CONFIG, steps: [], outputs: {} };
const writeReport = () => fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

function fail(msg) {
  report.ok = false;
  report.error = msg;
  writeReport();
  console.error('\n[pipeline] FAILED: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(CONFIG)) fail('config not found: ' + CONFIG);
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if ((cfg.paths || {}).root) {   // per-scene report / logs / screenshots
  OUT_DIR = path.join(ROOT, cfg.paths.root, 'work', 'pipeline');
  fs.mkdirSync(OUT_DIR, { recursive: true });
}
const name = cfg.name || 'wallpaper';
const BLEND = path.resolve(opt('--blend', cfg.blend || ''));
const BLENDER = opt('--blender', process.env.BLENDER || cfg.blender);
const SKIP_EXPORT = flag('--skip-export');
// output folders (relative to the project root). Defaults keep the original single-scene layout; a second scene
// sets e.g. "paths": { "root": "scenes/cafe" } so it never overwrites the first one's export / public / wallpaper.
const P = (() => {
  const r = (cfg.paths || {}).root;
  const d = (k, def) => (cfg.paths || {})[k] || (r ? path.join(r, def) : def);
  return {
    export: d('export', 'export'), public: d('public', 'public'), dist: d('dist', 'dist'),
    wallpaper: d('wallpaper', 'wallpaper'), release: d('release', 'release'), work: d('work', 'work'),
  };
})();
const PUBLIC_BASE = 'public';   // shared assets (sounds/, preview.jpg, project.json template) every scene starts from

// ---------------------------------------------------------------- helpers
// run a command, stream its output to the console and to work/pipeline/<step>.log, resolve with the output
function run(step, cmd, args, { okMarker } = {}) {
  return new Promise((resolve, reject) => {
    const logFile = fs.createWriteStream(path.join(OUT_DIR, step + '.log'), { flags: 'a' });
    logFile.write(`$ ${cmd} ${args.join(' ')}\n`);
    const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32' && !/\.exe$/i.test(cmd), windowsHide: true });
    let out = '';
    const onData = (d) => { const s = d.toString(); out += s; logFile.write(s); process.stdout.write(s); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { logFile.end(); reject(new Error(`${cmd}: ${e.message}`)); });
    child.on('close', (code) => {
      logFile.end();
      if (code !== 0) return reject(new Error(`${path.basename(cmd)} exited with code ${code}`, { cause: out }));
      if (okMarker && !out.includes(okMarker)) return reject(new Error(`${path.basename(cmd)} finished without ${okMarker}`, { cause: out }));
      resolve(out);
    });
  });
}

const tail = (s, n = 40) => String(s || '').split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');

async function step(stepName, fn) {
  const t0 = Date.now();
  fs.rmSync(path.join(OUT_DIR, stepName + '.log'), { force: true });
  console.log(`\n[pipeline] ── ${stepName} ──`);
  const rec = { name: stepName, ok: false, ms: 0, log: '' };
  report.steps.push(rec);
  try {
    const log = await fn();
    rec.ok = true;
    rec.log = tail(log, 20);
  } catch (e) {
    rec.log = tail((e.cause ? e.cause + '\n' : '') + e.message, 40);
    rec.ms = Date.now() - t0;
    fail(`step "${stepName}": ${e.message}`);
  }
  rec.ms = Date.now() - t0;
  writeReport();
  console.log(`[pipeline] ${stepName} ok (${(rec.ms / 1000).toFixed(1)} s)`);
}

const need = (p, what) => { if (!fs.existsSync(p)) throw new Error(`${what} missing: ${path.relative(ROOT, p)}`); };

// ---------------------------------------------------------------- steps
if (!SKIP_EXPORT) {
  await step('export', async () => {
    if (!BLENDER || !fs.existsSync(BLENDER)) throw new Error(`Blender not found: ${BLENDER || '(not set)'} — pass --blender <exe>, set BLENDER, or "blender" in the config`);
    need(BLEND, '.blend');
    const out = await run('export', BLENDER, [
      '-b', BLEND, '--python-exit-code', '1', '--python', 'pipeline/export_scene.py',
      '--', '--config', CONFIG, '--out', P.export, ...(flag('--rebake') ? ['--rebake'] : []),
    ], { okMarker: '@@EXPORT_OK@@' });
    need(path.join(P.export, 'room.glb'), 'export'); need(path.join(P.export, 'scene.json'), 'export');
    return out.split(/\r?\n/).filter((l) => l.startsWith('[export]')).join('\n');
  });
} else {
  report.steps.push({ name: 'export', ok: true, ms: 0, log: `skipped (--skip-export): reusing ${P.export}/room.glb`, skipped: true });
}

await step('optimize', async () => {
  need(path.join(P.export, 'room.glb'), 'Blender export (run without --skip-export first)');
  fs.rmSync(path.join(P.work, 'tex_in'), { recursive: true, force: true });
  fs.rmSync(path.join(P.work, 'tex_out'), { recursive: true, force: true });
  const io = ['--config', CONFIG, '--src', path.join(P.export, 'room.glb'), '--dst', path.join(P.public, 'room.glb'), '--work', P.work];
  let log = await run('optimize', process.execPath, ['tools/optimize.mjs', 'dump', ...io]);
  log += await run('optimize', process.platform === 'win32' ? 'python' : 'python3', ['tools/resize_textures.py', P.work]);
  log += await run('optimize', process.execPath, ['tools/optimize.mjs', 'pack', ...io]);
  need(path.join(P.public, 'room.glb'), 'optimized GLB');
  return log.split(/\r?\n/).filter((l) => /^(dropped|textures|approx|wrote)/.test(l)).join('\n');
});

await step('runtime', async () => {
  need(path.join(P.export, 'scene.json'), 'scene.json');
  // a scene with its own public folder starts from the shared assets (sounds, preview, project.json template)
  if (path.resolve(P.public) !== path.resolve(PUBLIC_BASE)) {
    for (const f of fs.readdirSync(PUBLIC_BASE)) {
      if (['room.glb', 'scene.json', 'runtime.json'].includes(f)) continue;
      fs.cpSync(path.join(PUBLIC_BASE, f), path.join(P.public, f), { recursive: true });
    }
    if (cfg.preview && fs.existsSync(cfg.preview)) fs.copyFileSync(cfg.preview, path.join(P.public, 'preview.jpg'));
  }
  fs.copyFileSync(path.join(P.export, 'scene.json'), path.join(P.public, 'scene.json'));
  const rt = cfg.runtime || {};
  fs.writeFileSync(path.join(P.public, 'runtime.json'), JSON.stringify(rt, null, 1));
  // Wallpaper Engine settings panel: title + camera dropdown follow the config
  const proj = JSON.parse(fs.readFileSync(path.join(P.public, 'project.json'), 'utf8'));
  if (cfg.description) proj.description = cfg.description;
  if (cfg.title) proj.title = cfg.title;
  const camProp = proj.general && proj.general.properties && proj.general.properties.camera;
  const cams = rt.cameras || [];
  if (camProp && cams.length) {
    camProp.options = cams.map((c) => ({ label: c.label || c.id, value: c.value }));
    const def = cams.find((c) => c.id === rt.defaultCamera) || cams[0];
    camProp.value = def.value;
  }
  fs.writeFileSync(path.join(P.public, 'project.json'), JSON.stringify(proj, null, 2) + '\n');
  // sanity: every interactive / book object named in the config should exist in the export
  const meta = JSON.parse(fs.readFileSync(path.join(P.public, 'scene.json'), 'utf8'));
  return `scene.json: ${Object.keys(meta.cameras).length} cameras, ${meta.lights.length} lights, ${Object.keys(meta.books).length} books, ` +
    `${Object.keys(meta.interactive).length} interactive groups\nruntime.json: ${Object.keys(rt).join(', ')}\nproject.json: ${cams.length} camera options`;
});

await step('build', async () => {
  process.env.WALLPAPER_PUBLIC = path.resolve(P.public);
  process.env.WALLPAPER_DIST = path.resolve(P.dist);
  const log = await run('build', process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  need(path.join(P.dist, 'index.html'), 'vite build output');
  return log;
});

await step('package', async () => {
  // replace wallpaper/ with the fresh build (public/ files come along: room.glb, scene.json, runtime.json, sounds/ ...)
  fs.rmSync(P.wallpaper, { recursive: true, force: true });
  fs.cpSync(P.dist, P.wallpaper, { recursive: true });
  for (const f of ['index.html', 'project.json', 'room.glb']) need(path.join(P.wallpaper, f), 'wallpaper');
  fs.mkdirSync(P.release, { recursive: true });
  const zip = path.join(ROOT, P.release, name + '.zip');
  fs.rmSync(zip, { force: true });
  if (process.platform === 'win32') {
    await run('package', 'powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${path.join(ROOT, P.wallpaper, '*')}' -DestinationPath '${zip}' -Force`]);
  } else {
    await run('package', 'zip', ['-qr', zip, '.'], {});
  }
  need(zip, 'zip');
  report.outputs.wallpaper = path.join(ROOT, P.wallpaper);
  report.outputs.zip = zip;
  const size = (p) => (fs.statSync(p).size / 1e6).toFixed(1) + ' MB';
  return `${P.wallpaper}/ ready (room.glb ${size(path.join(P.wallpaper, 'room.glb'))})\nzip: ${path.relative(ROOT, zip)} (${size(zip)})`;
});

if (flag('--check')) {
  await step('check', async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    if (!fs.existsSync(chrome)) throw new Error('Chrome not found: ' + chrome + ' (set CHROME)');
    const shotDir = path.join(OUT_DIR, 'shots');
    fs.rmSync(shotDir, { recursive: true, force: true });
    fs.mkdirSync(shotDir, { recursive: true });
    const url = pathToFileURL(path.join(ROOT, P.wallpaper, 'index.html')).href;   // the way Wallpaper Engine opens it
    const cams = ((cfg.runtime || {}).cameras || []).map((c) => c.id);
    const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new',
      args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
      defaultViewport: { width: 1920, height: 1080 } });
    const lines = [], problems = [];
    try {
      for (const cam of cams.length ? cams : ['']) {
        const p = await browser.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
        // the stats helper on 127.0.0.1:27183 is optional: ignore it being offline
        p.on('requestfailed', (r) => { if (!/127\.0\.0\.1:27183/.test(r.url())) errs.push('request failed: ' + r.url()); });
        p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
        await p.goto(url + (cam ? '?parallax=0&camera=' + cam : '?parallax=0'), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await p.waitForFunction(() => window.__wp && window.__wp.stats().fps > 0, { timeout: 180000 });
        await new Promise((r) => setTimeout(r, 2500));
        const st = await p.evaluate(() => ({ ...window.__wp.stats(), camera: window.__wp.settings.camera }));
        const shot = path.join(shotDir, (cam || 'default') + '.png');
        await p.screenshot({ path: shot });
        report.outputs.screenshots = [...(report.outputs.screenshots || []), shot];
        if (cam && st.camera !== cam) errs.push(`camera is ${st.camera}, expected ${cam}`);
        lines.push(`${cam || 'default'}: ${st.fps.toFixed(0)} fps, ${(st.tris / 1e6).toFixed(2)}M tris${errs.length ? ' — ' + errs.length + ' problem(s)' : ''}`);
        problems.push(...errs.map((e) => `${cam}: ${e}`));
        await p.close();
      }
    } finally {
      await browser.close();
    }
    if (problems.length) throw new Error(problems.length + ' page problem(s)', { cause: lines.concat(problems).join('\n') });
    return lines.join('\n');
  });
}

report.ok = true;
report.finished = new Date().toISOString();
writeReport();
console.log(`\n[pipeline] done: ${report.outputs.wallpaper}\n[pipeline] report: ${path.join(OUT_DIR, 'report.json')}`);
