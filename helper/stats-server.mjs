// Local system-stats helper for the wallpaper's dashboard monitor.
// A web wallpaper can't read CPU / GPU / network usage itself, so this tiny server samples them and serves JSON:
//   GET http://127.0.0.1:27183/stats
// It only listens on 127.0.0.1 (not reachable from other machines), is read-only and takes no input.
// Run:  node helper/stats-server.mjs      (or double-click helper/start-stats.bat)
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';

const PORT = 27183, HOST = '127.0.0.1', INTERVAL = 1000;

const run = (cmd, args) => new Promise((res) => {
  execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, out) => res(err ? '' : String(out)));
});

// ---- CPU: busy share of all cores since the last sample ----
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const d = Object.keys(c.times).reduce((s, k) => s + (c.times[k] - p[k]), 0);
    idle += c.times.idle - p.idle; total += d;
  });
  lastCpu = now;
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
}

// ---- GPU: nvidia-smi (NVIDIA only; other GPUs report null) ----
async function gpu() {
  const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits']);
  const line = out.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const [name, util, used, total, temp] = line.split(',').map((s) => s.trim());
  return { name, util: +util, memUsed: +used * 1048576, memTotal: +total * 1048576, temp: +temp };
}

// ---- network: total bytes from `netstat -e` (first row with two numbers = bytes, works in any locale) ----
let lastNet = null;
async function net() {
  const out = await run('netstat', ['-e']);
  const row = out.split(/\r?\n/).map((l) => l.trim().match(/(\d{3,})\s+(\d{3,})$/)).find(Boolean);
  if (!row) return null;
  const rx = +row[1], tx = +row[2], t = Date.now();
  let r = { down: 0, up: 0 };
  if (lastNet && t > lastNet.t) {
    const dt = (t - lastNet.t) / 1000;
    r = { down: Math.max(0, (rx - lastNet.rx) / dt), up: Math.max(0, (tx - lastNet.tx) / dt) };
  }
  lastNet = { rx, tx, t };
  return r;
}

let stats = { ok: false };
async function sample() {
  const [g, n] = await Promise.all([gpu(), net()]);
  const cpus = os.cpus();
  stats = {
    ok: true, time: Date.now(),
    host: os.hostname(), uptime: os.uptime(),
    cpu: { name: (cpus[0] && cpus[0].model || '').trim(), cores: cpus.length, util: cpuPercent() },
    mem: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
    gpu: g, net: n,
  };
}
await sample();
setInterval(sample, INTERVAL);

http.createServer((req, res) => {
  if (req.method !== 'GET' || !req.url.startsWith('/stats')) { res.writeHead(404); res.end(); return; }
  // the wallpaper page is a local file / other origin, so allow cross-origin reads of this JSON
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(stats));
}).listen(PORT, HOST, () => console.log(`stats helper on http://${HOST}:${PORT}/stats`));
