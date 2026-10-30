// Shrink export/room.glb for real-time use -> public/room.glb
//   node tools/optimize.mjs dump    -> strips unused maps, writes every texture to work/tex_in/<i>.<ext> + work/tex.json
//   python tools/resize_textures.py -> work/tex_out/<i>.webp   (sharp is broken on this machine, PIL does the images)
//   node tools/optimize.mjs pack    -> puts the WebP images back, meshopt-compresses geometry, writes public/room.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, meshopt, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] || 'dump';
// paths / size rules can be overridden: --src <glb> --dst <glb> --config <wallpaper.config.json>
const argv = process.argv.slice(3), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SRC = opt('--src', 'export/room.glb'), DST = opt('--dst', 'public/room.glb');
const CFG = opt('--config', 'wallpaper.config.json');
const EXP = fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG, 'utf8')).export || {} : {};
const texMax = EXP.textureMax || {};
const maxFor = (name) => { for (const [k, v] of Object.entries(texMax)) if (k !== 'default' && name && name.includes(k)) return v; return texMax.default || 1024; };
const WORK = opt('--work', 'work');
const MID = path.join(WORK, 'stripped.glb');
const IN = path.join(WORK, 'tex_in'), OUT = path.join(WORK, 'tex_out'), MAP = path.join(WORK, 'tex.json');
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
});
const t0 = Date.now();

if (mode === 'dump') {
  fs.mkdirSync(IN, { recursive: true });
  const doc = await io.read(SRC);
  const root = doc.getRoot();
  let dropped = 0;
  for (const m of root.listMaterials()) {
    // export.keepPBR: realistic scenes keep normal / metallic-roughness maps, only occlusion is dropped
    for (const slot of EXP.keepPBR ? ['OcclusionTexture'] : ['NormalTexture', 'MetallicRoughnessTexture', 'OcclusionTexture']) {
      if (m['get' + slot]()) { m['set' + slot](null); dropped++; }
    }
    if (m.getExtension('KHR_materials_specular')) m.setExtension('KHR_materials_specular', null);
  }
  await doc.transform(prune(), dedup(), weld());
  const list = [];
  root.listTextures().forEach((t, i) => {
    const ext = t.getMimeType() === 'image/jpeg' ? 'jpg' : 'png';
    const f = path.join(IN, `${i}.${ext}`);
    fs.writeFileSync(f, t.getImage());
    list.push({ i, name: t.getName(), file: f, max: maxFor(t.getName()) });
  });
  fs.writeFileSync(MAP, JSON.stringify(list, null, 1));
  await io.write(MID, doc);
  console.log('dropped texture slots', dropped, '| textures dumped', list.length, '| wrote', MID);
} else {
  const doc = await io.read(MID);
  const root = doc.getRoot();
  const list = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const tex = root.listTextures();
  let swapped = 0, before = 0, after = 0;
  for (const e of list) {
    const t = tex[e.i]; const f = path.join(OUT, `${e.i}.webp`);
    if (!t || !fs.existsSync(f)) continue;
    before += t.getImage().byteLength;
    const buf = fs.readFileSync(f); after += buf.byteLength;
    t.setImage(new Uint8Array(buf)).setMimeType('image/webp');
    if (t.getURI()) t.setURI(t.getURI().replace(/\.(png|jpe?g)$/i, '.webp'));
    swapped++;
  }
  console.log('textures swapped', swapped, '/', tex.length, 'MB', (before / 1e6).toFixed(0), '->', (after / 1e6).toFixed(0));
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  fs.mkdirSync(path.dirname(DST), { recursive: true });
  await io.write(DST, doc);
  const gpu = tex.reduce((s, t) => { const [w, h] = t.getSize() || [0, 0]; return s + w * h * 4 * 1.33; }, 0);
  console.log('approx GPU texture MB', (gpu / 1e6).toFixed(0));
  console.log('wrote', DST, (fs.statSync(DST).size / 1e6).toFixed(1), 'MB in', ((Date.now() - t0) / 1000).toFixed(0), 's');
}
