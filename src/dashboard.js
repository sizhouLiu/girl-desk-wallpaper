// Live system dashboard drawn on a canvas, shown on the PROP_Mon_Dash monitor.
// Data comes from the local helper (helper/stats-server.mjs) at http://127.0.0.1:27183/stats.
// Without the helper the screen says so and keeps showing the clock.
import * as THREE from 'three';

const URL = 'http://127.0.0.1:27183/stats';
const HIST = 60;

const C = {
  bg: '#0a1020', panel: '#0f1a2e', grid: '#1b2a44', text: '#dbe7ff', dim: '#7f93b8',
  cpu: '#38bdf8', gpu: '#a78bfa', ram: '#34d399', vram: '#f472b6', down: '#22d3ee', up: '#fbbf24',
  ok: '#34d399', bad: '#f87171',
};

const fmtBytes = (b) => b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1) + ' GB' : (b / 2 ** 20).toFixed(0) + ' MB';
const fmtRate = (b) => b >= 2 ** 20 ? (b / 2 ** 20).toFixed(1) + ' MB/s' : b >= 1024 ? (b / 1024).toFixed(0) + ' KB/s' : b.toFixed(0) + ' B/s';
const pad = (n) => String(n).padStart(2, '0');

export function createDashboard(aspect) {
  const W = 1024, H = Math.max(256, Math.round(W / aspect));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  let data = null, online = false;
  const hist = { cpu: [], gpu: [], down: [] };

  async function poll() {
    let next = 3000;
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 900);
      const r = await fetch(URL, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(to);
      const j = await r.json();
      if (j && j.ok) {
        data = j; online = true; next = 1000;
        const push = (k, v) => { hist[k].push(v); if (hist[k].length > HIST) hist[k].shift(); };
        push('cpu', j.cpu.util); push('gpu', j.gpu ? j.gpu.util : 0); push('down', j.net ? j.net.down : 0);
      }
    } catch { online = false; }
    draw();
    setTimeout(poll, next);
  }

  function ring(x, y, r, pct, col, label, sub) {
    g.lineCap = 'round';
    g.lineWidth = r * 0.2;
    g.strokeStyle = C.grid; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    if (pct != null) {
      g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = r * 0.25;
      g.beginPath(); g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.005, pct / 100)); g.stroke();
      g.shadowBlur = 0;
    }
    g.fillStyle = C.text; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold ${Math.round(r * 0.55)}px Consolas, "Segoe UI", monospace`;
    g.fillText(pct == null ? '--' : Math.round(pct) + '%', x, y);
    g.fillStyle = col; g.font = `bold ${Math.round(r * 0.32)}px "Segoe UI", sans-serif`;
    g.fillText(label, x, y + r * 1.48);
    g.fillStyle = C.dim; g.font = `${Math.round(r * 0.27)}px "Segoe UI", sans-serif`;
    g.fillText(sub, x, y + r * 1.9);
  }

  function line(arr, x, y, w, h, max, col, fill) {
    if (arr.length < 2) return;
    g.beginPath();
    arr.forEach((v, i) => { const px = x + w * (i + HIST - arr.length) / (HIST - 1), py = y + h - h * Math.min(1, v / max); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    if (fill) {
      g.save(); g.lineTo(x + w, y + h); g.lineTo(x + w * (HIST - arr.length) / (HIST - 1), y + h); g.closePath();
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, col + '55'); gr.addColorStop(1, col + '00');
      g.fillStyle = gr; g.fill(); g.restore();
      g.beginPath();
      arr.forEach((v, i) => { const px = x + w * (i + HIST - arr.length) / (HIST - 1), py = y + h - h * Math.min(1, v / max); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    }
    g.strokeStyle = col; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();
  }

  function panel(x, y, w, h, title) {
    g.fillStyle = C.panel; g.beginPath(); g.roundRect(x, y, w, h, 10); g.fill();
    g.fillStyle = C.dim; g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = `bold ${Math.round(H * 0.035)}px "Segoe UI", sans-serif`;
    g.fillText(title, x + 14, y + 10);
  }

  function draw() {
    const d = data, now = new Date();
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);

    // header
    const hh = H * 0.11;
    g.fillStyle = C.panel; g.fillRect(0, 0, W, hh);
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = C.text; g.font = `bold ${Math.round(hh * 0.45)}px "Segoe UI", sans-serif`;
    g.fillText('System Monitor', 22, hh / 2);
    g.fillStyle = online ? C.ok : C.bad;
    g.beginPath(); g.arc(W * 0.33, hh / 2, hh * 0.13, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.dim; g.font = `${Math.round(hh * 0.34)}px "Segoe UI", sans-serif`;
    g.fillText(online ? (d.host || 'localhost') : 'offline', W * 0.33 + hh * 0.3, hh / 2);
    g.textAlign = 'right'; g.fillStyle = C.text; g.font = `${Math.round(hh * 0.42)}px Consolas, monospace`;
    g.fillText(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, W - 22, hh / 2);

    // gauges
    const gy = hh + H * 0.2, r = Math.min(W * 0.075, H * 0.12);
    const cpu = online ? d.cpu.util : null, gpu = online && d.gpu ? d.gpu.util : null;
    const ram = online ? 100 * d.mem.used / d.mem.total : null;
    const vram = online && d.gpu ? 100 * d.gpu.memUsed / d.gpu.memTotal : null;
    const subs = online ? [
      `${d.cpu.cores} threads`,
      d.gpu ? `${d.gpu.temp}°C` : 'n/a',
      `${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)}`,
      d.gpu ? `${fmtBytes(d.gpu.memUsed)} / ${fmtBytes(d.gpu.memTotal)}` : 'n/a',
    ] : ['', '', '', ''];
    [[cpu, C.cpu, 'CPU'], [gpu, C.gpu, 'GPU'], [ram, C.ram, 'RAM'], [vram, C.vram, 'VRAM']].forEach(([v, col, lab], i) =>
      ring(W * (0.125 + i * 0.25), gy, r, v, col, lab, subs[i]));

    // bottom panels: usage history + network
    const py = hh + H * 0.47, ph = H - py - H * 0.04, gap = W * 0.02;
    const lw = W * 0.6;
    panel(gap, py, lw - gap, ph, 'CPU / GPU  ·  60s');
    const cx = gap + 14, cy = py + ph * 0.22, cw = lw - gap - 28, ch = ph * 0.68;
    g.strokeStyle = C.grid; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const yy = cy + ch * k / 4; g.beginPath(); g.moveTo(cx, yy); g.lineTo(cx + cw, yy); g.stroke(); }
    line(hist.gpu, cx, cy, cw, ch, 100, C.gpu, true);
    line(hist.cpu, cx, cy, cw, ch, 100, C.cpu, true);

    const nx = lw + gap, nw = W - nx - gap;
    panel(nx, py, nw, ph, 'Network');
    g.textAlign = 'left'; g.textBaseline = 'middle';
    const fs = Math.round(ph * 0.17);
    g.font = `bold ${fs}px Consolas, monospace`;
    g.fillStyle = C.down; g.fillText('↓ ' + (online && d.net ? fmtRate(d.net.down) : '--'), nx + 16, py + ph * 0.36);
    g.fillStyle = C.up; g.fillText('↑ ' + (online && d.net ? fmtRate(d.net.up) : '--'), nx + 16, py + ph * 0.58);
    const dmax = Math.max(64 * 1024, ...hist.down);
    line(hist.down, nx + 14, py + ph * 0.7, nw - 28, ph * 0.24, dmax, C.down, true);

    if (!online) {
      g.fillStyle = 'rgba(10,16,32,0.82)'; g.fillRect(cx - 4, cy - 4, cw + 8, ch + 8);
      g.fillStyle = C.text; g.textAlign = 'center';
      g.font = `bold ${Math.round(ch * 0.13)}px "Microsoft YaHei", "Segoe UI", sans-serif`;
      g.fillText('未连接本机监控', cx + cw / 2, cy + ch * 0.38);
      g.fillStyle = C.dim; g.font = `${Math.round(ch * 0.1)}px "Microsoft YaHei", "Segoe UI", sans-serif`;
      g.fillText('运行 helper\\start-stats.bat', cx + cw / 2, cy + ch * 0.64);
    }
    tex.needsUpdate = true;
  }

  draw();
  poll();
  setInterval(() => { if (!online) draw(); }, 1000);   // keep the header clock ticking while offline
  return { texture: tex };
}
