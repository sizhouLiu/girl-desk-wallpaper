// Built wallpapers of this project, for the preview service and the canvas "壁纸预览" node.
// A wallpaper = a wallpaper.config.json (the root one, plus scenes/*/wallpaper.config.json) whose build output
// (paths.wallpaper, default <root>/wallpaper) has an index.html. Read fresh on every call, so a new build shows up
// without restarting anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configFiles() {
  const files = [path.join(ROOT, 'wallpaper.config.json')];
  const scenes = path.join(ROOT, 'scenes');
  if (fs.existsSync(scenes)) {
    for (const d of fs.readdirSync(scenes, { withFileTypes: true })) {
      const f = path.join(scenes, d.name, 'wallpaper.config.json');
      if (d.isDirectory() && fs.existsSync(f)) files.push(f);
    }
  }
  return files.filter((f) => fs.existsSync(f));
}

// output folder of a config, same rule as pipeline/run.mjs
export function wallpaperDir(cfg) {
  const p = cfg.paths || {};
  return path.resolve(ROOT, p.wallpaper || (p.root ? path.join(p.root, 'wallpaper') : 'wallpaper'));
}

export function listWallpapers() {
  const out = [];
  for (const file of configFiles()) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const dir = wallpaperDir(cfg);
    const index = path.join(dir, 'index.html');
    if (!fs.existsSync(index)) continue;
    const id = cfg.name || path.basename(path.dirname(file));
    if (out.some((w) => w.id === id)) continue;
    const rt = cfg.runtime || {};
    out.push({
      id,
      title: cfg.title || id,
      path: `w/${encodeURIComponent(id)}/`,
      defaultCamera: rt.defaultCamera || '',
      cameras: (rt.cameras || []).map((c) => ({ id: c.id, label: c.label || c.id })),
      preview: fs.existsSync(path.join(dir, 'preview.jpg')) ? `w/${encodeURIComponent(id)}/preview.jpg` : null,
      builtAt: fs.statSync(index).mtime.toISOString(),
      dir,
    });
  }
  return out;
}
