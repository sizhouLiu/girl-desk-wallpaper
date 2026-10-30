// Preview service for every built wallpaper (npm run preview):
//   GET /wallpapers.json   -> [{ id, title, path, defaultCamera, cameras: [{ id, label }], preview, builtAt }]
//   GET /w/<id>/...        -> that wallpaper's files (the page uses relative URLs, so it works under a sub-path)
//   GET /                  -> a plain list of links
// Listens on the loopback addresses only (127.0.0.1 and ::1), so "localhost" works and nothing outside this machine
// can reach it. Read-only, no auth: any page in this machine's browser can read these files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listWallpapers } from './wallpapers.mjs';

const PORT = Number(process.env.PORT || process.argv[2] || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
};
const head = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const strip = ({ dir, ...w }) => w;

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { ...head, 'Content-Type': type });
  res.end(body);
}

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'bad url'); }
  const p = decodeURIComponent(url.pathname);

  if (p === '/wallpapers.json') return send(res, 200, JSON.stringify(listWallpapers().map(strip), null, 1), TYPES['.json']);
  if (p === '/' || p === '/index.html') {
    const items = listWallpapers().map((w) => `<li><a href="${w.path}">${w.title}</a> <small>${w.id}</small></li>`).join('');
    return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Wallpapers</title><ul>${items || '<li>no built wallpaper yet: npm run pipeline</li>'}</ul>`, TYPES['.html']);
  }

  const m = p.match(/^\/w\/([^/]+)(\/.*)?$/);
  if (!m) return send(res, 404, 'not found');
  const w = listWallpapers().find((x) => x.id === m[1]);
  if (!w) return send(res, 404, 'unknown wallpaper: ' + m[1]);
  if (!m[2]) { res.writeHead(301, { ...head, Location: `/w/${encodeURIComponent(w.id)}/` }); return res.end(); }
  const rel = m[2] === '/' ? 'index.html' : m[2].slice(1);
  const file = path.resolve(w.dir, rel);
  if (file !== w.dir && !file.startsWith(w.dir + path.sep)) return send(res, 403, 'forbidden');   // no ../ escapes
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { ...head, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

let up = 0;
for (const host of ['127.0.0.1', '::1']) {
  http.createServer(handler)
    .on('error', (e) => {
      if (host === '::1' && e.code === 'EADDRNOTAVAIL') return;   // no IPv6 loopback on this machine
      console.error(`[preview] ${host}:${PORT}: ${e.message}`);
      if (e.code === 'EADDRINUSE') process.exit(1);
    })
    .listen(PORT, host, () => {
      if (++up === 1) {
        console.log(`[preview] http://localhost:${PORT}/  (wallpapers.json lists ${listWallpapers().length} built wallpaper(s))`);
        for (const w of listWallpapers()) console.log(`[preview]   ${w.title}: http://localhost:${PORT}/${w.path}`);
      }
    });
}
