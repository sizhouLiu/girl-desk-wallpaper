import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { makeGradientMap, toonMaterial, outlineMaterial, bakeOutlineColors, animeU } from './toon.js';
import { AnimePass } from './anime.js';
import { setupInteractions } from './interact.js';
import { settings, onSettings, setCameraOptions, userSet } from './settings.js';

const info = document.getElementById('info');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07060a);
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 60);

const meta = await (await fetch('scene.json')).json();
// scene-specific runtime config (cameras, UV fixes, interactive object names), written by the pipeline
// from wallpaper.config.json -> runtime
const runtime = await fetch('runtime.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
setCameraOptions(runtime.cameras);
// runtime.lighting (all optional, absent = the original night-room look):
//   ambient: "world" -> hemisphere fill from the .blend world colour (ambientScale, groundColor)
//   background: "world" | "#rrggbb", exposure (multiplier), sunScale, bloomThreshold, shadows (false = off), shadowMapSize
const RL = runtime.lighting || {};
if (RL.bloomThreshold != null) settings.bloomThreshold = RL.bloomThreshold;
const exposureValue = () => Math.pow(2, meta.exposure ?? 0) * 1.6 * settings.exposure * (RL.exposure ?? 1);
renderer.toneMappingExposure = exposureValue();
if (RL.background === 'world' && meta.world) scene.background = new THREE.Color(...meta.world.color).multiplyScalar(meta.world.strength);
else if (typeof RL.background === 'string') scene.background = new THREE.Color(RL.background);
// runtime.style "realistic": keep the GLB's PBR materials, no toon shading / outlines / ink-line pass
const REAL = runtime.style === 'realistic';
// runtime.lighting.fog: [near, far] linear fog in the background colour (stands in for Blender volumetrics)
if (RL.fog) scene.fog = new THREE.Fog(scene.background.clone(), RL.fog[0], RL.fog[1]);
// realistic scenes get image-based lighting so PBR materials have soft reflections (envIntensity scales it)
if (REAL) {
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = RL.envIntensity ?? 0.6;
}
// "cover" (default): keep the Blender camera's horizontal FOV. "contain": keep the whole Blender frame visible,
// e.g. a square render shown on a 16:9 screen keeps its vertical FOV and gains width. ?fit= overrides for testing.
const cameraFit = new URLSearchParams(location.search).get('fit') || runtime.cameraFit || 'cover';
if (runtime.defaultCamera && !new URLSearchParams(location.search).has('camera') && !userSet.has('camera')) settings.camera = runtime.defaultCamera;
const glob = (p) => new RegExp('^' + p.replace(/\./g, '').replace(/[+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const globAny = (list) => (list && list.length ? list.map(glob) : null);

// ---------------- camera ----------------
const camBase = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 60 };
// Extra cameras not in the .blend (runtime.extraCameras): world position, yaw / pitch / roll, horizontal FOV.
// CAM_Front was solved from the reference render (渲染测试.png) by fitting monitor / desk / PC-case corners.
const EXTRA_CAMS = runtime.extraCameras || {};
function useCamera(name) {
  const x = EXTRA_CAMS[name];
  if (x) {
    camBase.pos.fromArray(x.pos);
    // three cameras look down local -Z: yaw + PI turns that to face (sin yaw, 0, cos yaw)
    camBase.quat.setFromEuler(new THREE.Euler(x.pitch, x.yaw + Math.PI, x.roll, 'YXZ'));
    camBase.hfov = x.hfov;
    camBase.frameAspect = null;
    camera.position.copy(camBase.pos);
    camera.quaternion.copy(camBase.quat);
    applyFov();
    return;
  }
  const c = meta.cameras[name] || Object.values(meta.cameras)[0];
  camBase.pos.fromArray(c.pos);
  // scene.json stores the Blender quaternion with axes swizzled (x, z, -y, w). A camera needs the
  // Z-up -> Y-up basis change applied on the world side only: q_three = C * q_blender, C = -90 deg about X.
  const [ex, ey, ez, ew] = c.quat;
  const qb = new THREE.Quaternion(ex, -ez, ey, ew);
  camBase.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2).multiply(qb);
  // Blender (sensor fit AUTO, landscape) fits the sensor width horizontally: keep that horizontal FOV
  camBase.hfov = 2 * Math.atan((c.sensor || 36) / 2 / c.lens);
  camBase.frameAspect = c.aspect || null;
  camera.position.copy(camBase.pos);
  camera.quaternion.copy(camBase.quat);
  applyFov();
}
function applyFov() {
  if (!camBase.hfov) return;
  const fa = cameraFit === 'contain' ? camBase.frameAspect : null;
  if (fa && camera.aspect > fa) camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(camBase.hfov / 2) / fa));
  else camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(camBase.hfov / 2) / camera.aspect));
  camera.updateProjectionMatrix();
}
useCamera(settings.camera);

// ---------------- lights (Blender watts -> three intensity, physically-correct-ish) ----------------
const lightGroup = new THREE.Group(); scene.add(lightGroup);
const lightsByName = {};
const W2 = 1 / (4 * Math.PI) * 0.9;   // point/area W -> candela-ish
for (const L of meta.lights) {
  if (L.energy <= 0) continue;
  const col = new THREE.Color(...L.color);
  let l;
  if (L.type === 'POINT') {
    l = new THREE.PointLight(col, L.energy * W2 * 3, 0, 2);
  } else if (L.type === 'SUN') {
    // Blender sun strength is irradiance (W/m²), the same quantity as a DirectionalLight's intensity. The
    // "lights" setting (default 0.35) scales every light below, so divide it out here: default = Blender's value.
    l = new THREE.DirectionalLight(col, (L.energy * (RL.sunScale ?? 1)) / 0.35);
    l.userData.dir = new THREE.Vector3(...L.dir);   // direction the light travels; placed after the model loads
  } else {
    // area lights -> spot lights with a wide soft cone, aimed along the Blender light direction
    l = new THREE.SpotLight(col, L.energy * W2 * 4, 0, Math.PI / 2.2, 0.9, 2);
    const t = new THREE.Object3D();
    t.position.set(L.pos[0] + L.dir[0], L.pos[1] + L.dir[1], L.pos[2] + L.dir[2]);
    lightGroup.add(t); l.target = t;
  }
  l.position.fromArray(L.pos);
  l.name = L.name;
  l.userData.raw = l.intensity;
  l.intensity *= settings.lights;
  l.userData.base = l.intensity;
  lightGroup.add(l);
  lightsByName[L.name] = l;
}
// three's hemisphere irradiance is divided by pi in the diffuse term, so pi * world strength matches Blender
const ambient = RL.ambient === 'world' && meta.world
  ? new THREE.HemisphereLight(new THREE.Color(...meta.world.color), new THREE.Color(...(RL.groundColor || [0.3, 0.26, 0.22])),
    meta.world.strength * (RL.ambientScale ?? Math.PI) * settings.ambient)
  : new THREE.HemisphereLight(0x4a3a70, 0x120c10, 0.35 * settings.ambient);
scene.add(ambient);

// ---------------- model ----------------
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await new Promise((res, rej) => loader.load('room.glb', res, (e) => {
  if (e.total) info.textContent = `loading ${(e.loaded / e.total * 100).toFixed(0)}%`;
}, rej));
const room = gltf.scene;
scene.add(room);

// ---------------- re-UV boxes whose Blender texture mapping didn't survive export ----------------
// These objects are plain boxes that Blender textured with procedural (object / generated) coordinates; the GLB
// only kept a default cube unwrap, so wood / metal came out stretched. Rebuild UVs by box projection in world
// metres (tile = metres per texture repeat), with the grain running along the object's long horizontal axis.
// runtime.boxUV: { material: { tile: metres per repeat, grain: 'z' | 'x' | 'long' (= longest horizontal axis) } }
const BOX_UV = runtime.boxUV || {};
const PANEL_UV = new Set(runtime.panelUV || []);
function boxProjectUV(mesh, tile, grainAlongZ) {
  const g = mesh.geometry = mesh.geometry.clone();
  const pos = g.attributes.position, nor = g.attributes.normal;
  // the GLB is quantized (uv = normalized ints, 0..1 only): tiled UVs need a float attribute
  const uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2); g.setAttribute('uv', uv);
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    n.fromBufferAttribute(nor, i).applyMatrix3(nm);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let u, v;
    if (ay >= ax && ay >= az) { u = grainAlongZ ? p.z : p.x; v = grainAlongZ ? p.x : p.z; }   // top / bottom
    else if (az >= ax) { u = p.x; v = p.y; }                                                  // faces along z
    else { u = p.z; v = p.y; }                                                                // faces along x
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}
// The PC side panel art must cover its big face exactly once (0..1), not a cube-unwrap strip of it.
function panelUV(mesh) {
  const g = mesh.geometry = mesh.geometry.clone();
  g.computeBoundingBox();
  const bb = g.boundingBox, size = bb.getSize(new THREE.Vector3());
  const k = ['x', 'y', 'z'].sort((a, b) => size[a] - size[b]);   // k[0] = thickness axis
  const [ua, va] = [k[1] === 'y' ? k[2] : k[1], 'y'];               // horizontal axis -> u, up -> v
  const pos = g.attributes.position;
  const uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2); g.setAttribute('uv', uv);
  for (let i = 0; i < pos.count; i++) {
    const q = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
    uv.setXY(i, (q[ua] - bb.min[ua]) / size[ua], 1 - (q[va] - bb.min[va]) / size[va]);
  }
  uv.needsUpdate = true;
  return { flipU: false };
}
room.updateMatrixWorld(true);
const resetTex = (t) => { if (!t) return; t.offset.set(0, 0); t.repeat.set(1, 1); t.rotation = 0; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; };
room.traverse((o) => {
  if (!o.isMesh || !o.material || !o.geometry.attributes.uv) return;
  const m = o.material, name = m.name;
  if (name in BOX_UV) {
    o.geometry.computeBoundingBox();
    const s = o.geometry.boundingBox.getSize(new THREE.Vector3()).applyMatrix3(new THREE.Matrix3().setFromMatrix4(o.matrixWorld));
    const b = BOX_UV[name];
    boxProjectUV(o, b.tile, b.grain === 'z' ? true : b.grain === 'x' ? false : Math.abs(s.z) > Math.abs(s.x));
    resetTex(m.map);
  } else if (PANEL_UV.has(name)) {
    panelUV(o);
    resetTex(m.map); resetTex(m.emissiveMap);
  }
});

const grad = makeGradientMap();
const outlined = new Set(meta.outlined || []);
const rimRes = globAny(runtime.rimObjects);   // characters that get the anime rim light
const isRim = (n) => !!rimRes && rimRes.some((r) => r.test(n || ''));
const emissiveMats = meta.emissive || {};
const outlines = [];
const matCache = new Map();
let tris = 0;
room.traverse((o) => {
  if (!o.isMesh) return;
  const src = o.material;
  const srcList = Array.isArray(src) ? src : [src];
  const dst = srcList.map((m) => {
    if (matCache.has(m)) return matCache.get(m);
    // screens, paintings, night view, glow panels keep their own (emissive) look; everything else goes toon
    const keep = (m.name in emissiveMats) || m.transparent;
    const nm = keep || REAL ? m : toonMaterial(m, grad);
    if (!keep && !REAL && (isRim(o.name) || isRim(o.parent && o.parent.name))) nm.userData.rimU.value = 1;
    if (m.emissiveIntensity !== undefined && m.name in emissiveMats) nm.emissiveIntensity = emissiveMats[m.name];
    matCache.set(m, nm);
    return nm;
  });
  o.material = Array.isArray(src) ? dst : dst[0];
  tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  // outline: GLB node names are the Blender object names (may carry a .001 suffix for multi-material splits)
  const base = (o.name || '').replace(/_\d+$/, '');
  const parentName = o.parent ? o.parent.name : '';
  if (!REAL && (outlined.has(o.name) || outlined.has(base) || outlined.has(parentName))) {
    bakeOutlineColors(o.geometry, Array.isArray(dst) ? dst[0] : dst);
    const om = outlineMaterial({ width: settings.outline, vertexColor: true });
    const hull = new THREE.Mesh(o.geometry, om);
    hull.name = o.name + '__outline';
    hull.raycast = () => {};
    hull.renderOrder = -1;
    o.add(hull);
    outlines.push(om);
  }
});

// ---------------- sun shadows (only scenes with a SUN light) ----------------
// Static scene: the shadow map is rendered once (autoUpdate off), so dappled leaf shadows cost nothing per frame.
// meta.shadowOnly = Blender objects hidden from camera rays but casting shadows (e.g. a leaf canopy above the
// camera), meta.noShadow = visible but not casting (e.g. a foreground branch card).
const suns = Object.values(lightsByName).filter((l) => l.isDirectionalLight);
if (suns.length && RL.shadows !== false) {
  const norm = (n) => (n || '').replace(/\./g, '');
  const shadowOnly = new Set((meta.shadowOnly || []).map(norm)), noShadow = new Set((meta.noShadow || []).map(norm));
  const under = (set, o) => { for (let p = o; p; p = p.parent) if (set.has(p.name)) return true; return false; };
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  room.traverse((o) => {
    if (!o.isMesh || o.name.endsWith('__outline')) return;
    const so = under(shadowOnly, o);
    o.castShadow = !under(noShadow, o);
    o.receiveShadow = !so;
    if (so) {
      const hide = (m) => { const c = m.clone(); c.colorWrite = false; c.depthWrite = false; return c; };
      o.material = Array.isArray(o.material) ? o.material.map(hide) : hide(o.material);
      o.raycast = () => {};
      for (const c of o.children) if (c.name.endsWith('__outline')) c.visible = false;
    }
  });
  const box = new THREE.Box3().setFromObject(room);
  const center = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
  for (const sun of suns) {
    const d = sun.userData.dir.clone().normalize();
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(d, -r * 1.5);
    scene.add(sun.target);
    if (Math.abs(d.y) > 0.99) sun.shadow.camera.up.set(0, 0, 1);
    const sh = sun.shadow, size = RL.shadowMapSize || 4096;
    sh.mapSize.set(size, size);
    Object.assign(sh.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.05, far: r * 3 });
    sh.camera.updateProjectionMatrix();
    sh.bias = -0.0004;
    sh.normalBias = 0.02;
    sun.castShadow = true;
  }
}

// ---------------- post: selective-ish bloom (threshold keeps it on screens / lamps) ----------------
// both ping-pong targets carry a depth texture, so the anime pass can read depth from whichever one was drawn into
const rt = new THREE.WebGLRenderTarget(1920, 1080, { type: THREE.HalfFloatType });
rt.depthTexture = new THREE.DepthTexture(1920, 1080);
rt.depthTexture.type = THREE.UnsignedIntType;
const composer = new EffectComposer(renderer, rt);
// the composer clones rt for its second buffer, and a cloned depth texture shares the same GPU texture: give it its
// own, otherwise the anime pass samples the depth attached to the target it draws into (feedback loop -> black frame)
composer.renderTarget2.depthTexture = new THREE.DepthTexture(1920, 1080);
composer.renderTarget2.depthTexture.type = THREE.UnsignedIntType;
composer.addPass(new RenderPass(scene, camera));
// 三渲二: depth ink lines on every object + saturation lift, before bloom so the glow stays soft
const anime = new AnimePass(camera);
if (!REAL) composer.addPass(anime);
const bloom = new UnrealBloomPass(new THREE.Vector2(1920, 1080), 0.55, 0.45, settings.bloomThreshold);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------- resize / resolution scale ----------------
let scale = settings.resolution;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
  const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
  renderer.setDrawingBufferSize(bw, bh, 1);
  composer.setSize(bw, bh);
  bloom.setSize(bw, bh);
  anime.setSize(bw, bh);
  for (const m of outlines) m.uniforms.uResolution.value.set(bw, bh);
  camera.aspect = w / h;
  applyFov();
}
window.addEventListener('resize', resize);
resize();

// ---------------- parallax ----------------
const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener('pointermove', (e) => {
  mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
});
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _off = new THREE.Vector3();
function applyParallax(dt) {
  const k = 1 - Math.exp(-dt * 3.0);
  mouse.x += (mouse.tx - mouse.x) * k; mouse.y += (mouse.ty - mouse.y) * k;
  const amt = settings.parallax;
  _e.set(-mouse.y * 0.035 * amt, -mouse.x * 0.06 * amt, 0, 'YXZ');
  _q.setFromEuler(_e);
  camera.quaternion.copy(camBase.quat).multiply(_q);
  _off.set(mouse.x * 0.06 * amt, -mouse.y * 0.03 * amt, 0).applyQuaternion(camBase.quat);
  camera.position.copy(camBase.pos).add(_off);
}

// ---------------- interactions ----------------
const interact = setupInteractions({ THREE, scene, room, camera, renderer, meta, lightsByName, matCache, runtime });

// ---------------- settings live-update (Wallpaper Engine user properties) ----------------
onSettings((s, changed) => {
  if (changed.camera) useCamera(s.camera);
  if (changed.outline) for (const m of outlines) m.uniforms.uWidth.value = s.outline;
  if (changed.bloom) bloom.strength = s.bloom;
  if (changed.anime) animeU.uAnime.value = s.anime;
  if (changed.inkLines) anime.material.uniforms.uWidth.value = s.inkLines;
  if (changed.resolution) { scale = s.resolution; resize(); }
  if (changed.exposure) renderer.toneMappingExposure = exposureValue();
  if (changed.lights) for (const l of Object.values(lightsByName)) {
    l.userData.base = l.userData.raw * s.lights;
    l.intensity = l.userData.base;   // lamp / day-night code re-applies its own factor on the next frame
  }
});
bloom.strength = settings.bloom;
animeU.uAnime.value = settings.anime;
anime.material.uniforms.uWidth.value = settings.inkLines;

// ---------------- loop: fps cap, pause when hidden, adaptive resolution ----------------
let paused = false;
document.addEventListener('visibilitychange', () => { paused = document.hidden; });
window.wallpaperPropertyListener = window.wallpaperPropertyListener || {};
window.wallpaperPropertyListener.setPaused = (p) => { paused = p; };

let last = performance.now(), acc = 0, frames = 0, fpsT = 0, fps = 0, slow = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (paused) { last = now; return; }
  const minDt = 1000 / settings.fps;
  if (now - last < minDt - 1) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  applyParallax(dt);
  interact.update(dt, now / 1000);
  composer.render(dt);
  frames++; fpsT += dt;
  if (fpsT >= 1) {
    fps = frames / fpsT; frames = 0; fpsT = 0;
    if (settings.adaptive) {
      if (fps < settings.fps * 0.8 && scale > 0.5) { if (++slow >= 2) { scale = Math.max(0.5, scale - 0.1); resize(); slow = 0; } }
      else slow = 0;
    }
    info.textContent = settings.showStats ? `${fps.toFixed(0)} fps · ${(scale * 100).toFixed(0)}% · ${(tris / 1000).toFixed(0)}k tris · ${renderer.info.render.calls} calls` : '';
  }
}
info.textContent = '';
requestAnimationFrame(frame);
const _rc = new THREE.Raycaster();
window.__wp = {
  renderer, scene, camera, settings,
  stats: () => ({ fps, scale, tris, calls: renderer.info.render.calls }),
  pickAt: (x, y) => {
    _rc.setFromCamera(new THREE.Vector2(x / window.innerWidth * 2 - 1, -(y / window.innerHeight) * 2 + 1), camera);
    const hs = _rc.intersectObject(scene, true).slice(0, 3);
    return hs.map((h) => {
      let o = h.object, path = [];
      while (o && o !== scene) { path.push(o.name || o.type); o = o.parent; }
      return { path: path.slice(0, 3), dist: +h.distance.toFixed(2), mat: h.object.material?.name || h.object.material?.type };
    });
  },
};
