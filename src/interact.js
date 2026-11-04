// Interactions: hover tooltip, desk lamp toggle, live clock, monitors on/off, window day/night, curtains, book links, cat.
import * as THREE from 'three';
import { settings } from './settings.js';
import { BOOK_LINKS } from './bookLinks.js';
import { purr, meow, strum } from './sound.js';
import { createDashboard } from './dashboard.js';

export function setupInteractions({ THREE, scene, room, camera, renderer, meta, lightsByName, runtime, dragon }) {
  const RT = runtime || {}, IC = RT.interact || {};
  const tooltip = document.getElementById('tooltip');
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2(-9, -9);
  let pointerPx = { x: 0, y: 0 };

  // GLB keeps Blender object names; the exporter strips dots ("ShelfLamp.001" -> "ShelfLamp001")
  const byName = (n) => room.getObjectByName(n) || room.getObjectByName(n.replace(/\./g, ''));
  const meshesOf = (o) => { const out = []; o && o.traverse((c) => c.isMesh && !c.name.endsWith('__outline') && out.push(c)); return out; };
  // objects by glob ("WIN_Slat_*"): outermost matches only (not their sub-meshes), natural name order
  const glob = (p) => new RegExp('^' + p.replace(/\./g, '').replace(/[+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const findAll = (pat) => {
    if (!pat) return [];
    const re = glob(pat), out = [];
    room.traverse((o) => { if (re.test(o.name) && !o.name.endsWith('__outline') && !(o.parent && re.test(o.parent.name))) out.push(o); });
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  };

  const groups = {};
  for (const [key, list] of Object.entries(meta.interactive || {})) {
    const ms = [];
    for (const x of list) ms.push(...meshesOf(byName(x.name)));
    for (const m of ms) m.userData.kind = key;
    groups[key] = ms;
  }
  const bookMeshes = [];
  for (const [n, title] of Object.entries(meta.books || {})) {
    for (const m of meshesOf(byName(n))) { m.userData.kind = 'book'; m.userData.title = title; bookMeshes.push(m); }
  }
  const curtains = ((IC.curtains || {}).objects || []).map(byName).filter(Boolean);
  for (const c of curtains) for (const m of meshesOf(c)) m.userData.kind = 'curtain';
  const slats = [];
  slats.push(...findAll((IC.blinds || {}).slats));
  const blindGlass = (IC.blinds || {}).glass ? byName(IC.blinds.glass) : null;
  const blindMeshes = [...slats, blindGlass].filter(Boolean).flatMap(meshesOf);
  for (const m of blindMeshes) m.userData.kind = 'blinds';
  const guitarRoots = Object.keys(IC.guitars || {}).map(byName).filter(Boolean);
  const guitars = Object.entries(IC.guitars || {}).flatMap(([n, type]) =>
    meshesOf(byName(n)).map((m) => (m.userData.kind = type === 'electric' ? 'guitarE' : 'guitarA', m)));
  const pickables = [...Object.values(groups).flat(), ...bookMeshes, ...curtains.flatMap(meshesOf), ...blindMeshes, ...guitars];
  // dragon.js provides its own invisible pick spheres on the neck / head bones
  if (dragon) for (const m of dragon.pickables) { m.userData.kind = 'dragon'; pickables.push(m); }

  // ---- blinds: tilt every slat about its long axis; closed = slats stand flat against the window ----
  const slatAxis = new THREE.Vector3(0, 0, 1);   // slats run along world Z on the left wall
  const blindRot = slats.map((o) => {
    o.geometry.computeBoundingBox();
    const sz = o.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(o.scale);
    const k = sz.x <= sz.y && sz.x <= sz.z ? 'x' : sz.y <= sz.z ? 'y' : 'z';   // thinnest local axis = slat face normal
    const nrm = new THREE.Vector3(+(k === 'x'), +(k === 'y'), +(k === 'z')).applyQuaternion(o.quaternion);
    let ang = Math.atan2(nrm.y, nrm.x);                            // angle from world +X (facing into the room)
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    // widest cross axis = slat width; when shut, stretch it so neighbouring slats overlap (no gaps)
    const w = k === 'x' ? (sz.y < sz.z ? 'z' : 'y') : k === 'y' ? (sz.x < sz.z ? 'x' : 'z') : (sz.x < sz.y ? 'x' : 'y');
    return { q0: o.quaternion.clone(), shut: -ang, w, s0: o.scale[w], width: sz[w] };
  });
  const slatGap = slats.length > 1 ? slats[1].position.distanceTo(slats[0].position) : 0.065;
  const _bq = new THREE.Quaternion();
  let blindT = 0, blindTarget = 0;

  // ---- books: open a search page for the title ----
  // free / open edition when one exists, otherwise a search for the title
  const bookUrl = (t) => BOOK_LINKS[t] ? BOOK_LINKS[t].url : /[一-鿿]/.test(t)
    ? 'https://search.douban.com/book/subject_search?search_text=' + encodeURIComponent(t)
    : 'https://www.google.com/search?q=' + encodeURIComponent(t + ' book');

  // ---- curtains: open = bunched beside the window (as modelled), closed = each covers half the glass ----
  const curtainOpen = curtains.map((c) => ({ x: c.position.x, sx: c.scale.x }));
  // window centre from the glass bounding box (scene.json), curtain overhang past it from the config (m)
  const gb = (meta.interactive.window || []).find((b) => b.name === (IC.window || {}).glass);
  const glassMid = gb ? (gb.min[0] + gb.max[0]) / 2 : curtains.reduce((s, c) => s + c.position.x, 0) / (curtains.length || 1);
  const edge = (IC.curtains || {}).overhang ?? 0.9;
  const curtainShut = curtains.map((c, i) => {
    const outer = i === 0 ? glassMid - edge : glassMid + edge;
    return { x: (outer + glassMid) / 2, sx: Math.abs(outer - glassMid) / 2 };
  });
  let curtainT = 0, curtainTarget = 0;

  // ---- lamp ----
  const lampLights = (RT.lampLights || [])
    .map((n) => lightsByName[n]).filter(Boolean);
  let lampOn = true, lampT = 1;

  // ---- clock: real time on a canvas laid over the clock's screen ----
  // screen = the flat, dark (display-coloured) face of the clock that faces the camera
  const cc = document.createElement('canvas'); cc.width = 256; cc.height = 128;
  const cg = cc.getContext('2d');
  const clockTex = new THREE.CanvasTexture(cc); clockTex.colorSpace = THREE.SRGBColorSpace;
  const clockMesh = (groups.clock || [])[0];
  if (clockMesh && clockMesh.material.map) {
    // modelled behind the monitors where no camera sees it: move it to the free desk corner in front of the
    // desk camera, screen turned toward the camera (the screen is the model's local +x face)
    const mv = (IC.clock || {}).moveTo;   // [x, z] on the desk, from the config
    if (mv) {
      clockMesh.position.x = mv[0]; clockMesh.position.z = mv[1];
      clockMesh.rotation.y = Math.atan2(camera.position.x - mv[0], camera.position.z - mv[1]) - Math.PI / 2;
    }
    clockMesh.updateWorldMatrix(true, true);
    const S = 128, tc = document.createElement('canvas'); tc.width = tc.height = S;
    const tg = tc.getContext('2d'); tg.drawImage(clockMesh.material.map.image, 0, 0, S, S);
    const px = tg.getImageData(0, 0, S, S).data;
    const pos = clockMesh.geometry.attributes.position, uv = clockMesh.geometry.attributes.uv, idx = clockMesh.geometry.index;
    const n = idx ? idx.count : pos.count, planes = [];
    const camL = clockMesh.worldToLocal(camera.position.clone());
    clockMesh.geometry.computeBoundingBox();
    const lb = clockMesh.geometry.boundingBox, tol = lb.getSize(new THREE.Vector3()).length() * 0.02;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a)), area = nrm.length() / 2; if (!area) continue; nrm.normalize();
      if (nrm.dot(camL.clone().sub(a)) <= 0) continue;
      const u = (uv.getX(ia) + uv.getX(ib) + uv.getX(ic)) / 3, v = (uv.getY(ia) + uv.getY(ib) + uv.getY(ic)) / 3;
      const k = (Math.min(S - 1, Math.max(0, Math.floor(v * S))) * S + Math.min(S - 1, Math.max(0, Math.floor(u * S)))) * 4;
      const dark = Math.max(px[k], px[k + 1], px[k + 2]) < 64;
      const d = nrm.dot(a);
      let pl = planes.find((q) => q.n.dot(nrm) > 0.99 && Math.abs(q.d - d) < tol);
      if (!pl) planes.push(pl = { n: nrm, d, area: 0, dark: 0, all: [] });
      pl.area += area; if (dark) pl.dark += area; pl.all.push(a.clone(), b.clone(), c.clone());
    }
    const scr = planes.filter((q) => q.dark > q.area * 0.6).sort((x, y) => y.area - x.area)[0];
    if (scr) {
      const nN = scr.n, ax = new THREE.Vector3(0, 1, 0).cross(nN).normalize(), ay = nN.clone().cross(ax);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of scr.all) { const x = q.dot(ax), y = q.dot(ay); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      // the screen is centred left/right in the body and spans ~80% of its width
      const corners = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => new THREE.Vector3(i ? lb.max.x : lb.min.x, j ? lb.max.y : lb.min.y, k ? lb.max.z : lb.min.z).dot(ax))));
      const bx0 = Math.min(...corners), bx1 = Math.max(...corners), cx = (bx0 + bx1) / 2, half = (bx1 - bx0) * 0.4;
      x0 = Math.max(x0, cx - half); x1 = Math.min(x1, cx + half);
      const w = x1 - x0, h = y1 - y0;
      // the modelled screen is not flat: a slanted layer with the baked digits stands in front of the screen plane.
      // Float the overlay just in front of the furthest-forward point inside the opening (but behind the bezel front).
      let zMax = 0, zFront = 0;
      {
        const Q = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          Q.fromBufferAttribute(pos, i);
          const x = Q.dot(ax), y = Q.dot(ay), z = Q.dot(nN) - scr.d;
          zFront = Math.max(zFront, z);
          if (z > 0 && x > x0 + w * 0.02 && x < x1 - w * 0.02 && y > y0 + h * 0.02 && y < y1 - h * 0.02) zMax = Math.max(zMax, z);
        }
        zMax = Math.min(zMax, zFront * 0.9);
      }
      cc.width = 512; cc.height = Math.max(64, Math.round(512 * h / w));
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: clockTex, toneMapped: false, alphaTest: 0.5,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }));
      plane.raycast = () => {};
      plane.position.copy(nN).multiplyScalar(scr.d + zMax + tol * 0.1).addScaledVector(ax, (x0 + x1) / 2).addScaledVector(ay, (y0 + y1) / 2);
      plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ax, ay, nN));
      clockMesh.add(plane);
    }
  }
  let lastSec = -1;
  function drawClock() {
    const d = new Date(), sec = d.getSeconds();
    if (sec === lastSec) return; lastSec = sec;
    const W = cc.width, H = cc.height, hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    cg.clearRect(0, 0, W, H);
    cg.fillStyle = '#050608'; cg.beginPath(); cg.roundRect(0, 0, W, H, H * 0.1); cg.fill();
    cg.textAlign = 'center'; cg.textBaseline = 'middle'; cg.shadowColor = '#ffb060'; cg.shadowBlur = H * 0.08;
    // fit each line to 86% of the width
    const fit = (txt, px, fam) => { cg.font = `${px}px ${fam}`; const k = Math.min(1, W * 0.86 / cg.measureText(txt).width); cg.font = `${Math.floor(px * k)}px ${fam}`; };
    const time = hh + (sec % 2 ? ' ' : ':') + mm, date = `${d.getMonth() + 1}/${d.getDate()} 周${'日一二三四五六'[d.getDay()]}`;
    cg.fillStyle = '#ffd9a8'; fit(time, Math.round(H * 0.5), 'bold Consolas, "Segoe UI", monospace');
    cg.fillText(time, W / 2, H * 0.42);
    cg.shadowBlur = 0; cg.fillStyle = '#c99a6a'; fit(date, Math.round(H * 0.17), '"Microsoft YaHei", "Segoe UI", sans-serif');
    cg.fillText(date, W / 2, H * 0.8);
    clockTex.needsUpdate = true;
  }
  drawClock();

  // ---- window day / night ----
  const nightMeshes = (IC.window || {}).view ? meshesOf(byName(IC.window.view)) : [];
  // no light sources at the windows or above the bed: their hotspots on the blinds / wall / headboard looked wrong. Day vs night is carried
  // by the view texture plus a brighter ambient during the day.
  for (const n of RT.dropLights || []) { const l = lightsByName[n]; if (l) { l.parent.remove(l); delete lightsByName[n]; } }
  // daylight: an extra soft sky ambient that only exists in the day, dimmed by closed curtains / blinds
  const daylight = new THREE.HemisphereLight(0xfff1dc, 0x8a7560, 0);
  scene.add(daylight);
  const DAYLIGHT = 1.6;
  // the room's base ambient doubles as moonlight at night: closing curtains / blinds dims it
  const moonAmb = scene.children.find((o) => o.isHemisphereLight && o !== daylight), moonBase = moonAmb ? moonAmb.intensity : 0;
  let night = 1, nightTarget = 1;
  // day view: a painted sky + skyline plane in front of the night view, cross-faded by `night`
  const dayMat = new THREE.MeshBasicMaterial({ map: dayTexture(), transparent: true, opacity: 0, toneMapped: false, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  for (const m of nightMeshes) {
    const d = new THREE.Mesh(m.geometry, dayMat);
    d.raycast = () => {}; d.renderOrder = 1;
    m.add(d);
  }
  const realNight = () => {
    const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
    return h < 6.5 || h > 18.5 ? 1 : h < 7.5 ? 1 - (h - 6.5) : h > 17.5 ? h - 17.5 : 0;
  };

  // ---- monitors: screen and bezel share one texture, so "off" is a black overlay on the screen face only ----
  // screen face = front-facing triangles coplanar with the largest front-facing triangle cluster
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x020203, transparent: true, opacity: 0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  const monFlicker = [];
  for (const m of groups.monitors || []) {
    m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
    const tris = [], camDir = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a)); const area = nrm.length() / 2; if (!area) continue;
      nrm.normalize(); camDir.copy(camera.position).sub(a).normalize();
      if (nrm.dot(camDir) > 0.3) tris.push({ p: [a.clone(), b.clone(), c.clone()], nrm, area });
    }
    // group by plane (normal + offset), keep the plane with the most area
    const planes = [];
    for (const t of tris) {
      const d = t.nrm.dot(t.p[0]);
      let pl = planes.find((q) => q.n.dot(t.nrm) > 0.995 && Math.abs(q.d - d) < 0.01);
      if (!pl) planes.push(pl = { n: t.nrm, d, area: 0, tris: [] });
      pl.area += t.area; pl.tris.push(t);
    }
    planes.sort((x, y) => y.area - x.area); if (!planes.length) continue;
    // a screen split over several near-coplanar pieces: keep every plane at least 40% the size of the largest
    const sel = planes.filter((q) => q.area > planes[0].area * 0.4 && q.n.dot(planes[0].n) > 0.98).flatMap((q) => q.tris);
    // one rectangle spanning the screen face (screens are rectangles; avoids seams between their triangles)
    const nN = planes[0].n, ax = new THREE.Vector3(0, 1, 0).cross(nN).normalize(), ay = nN.clone().cross(ax);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, dd = 0, cnt = 0;
    for (const t of sel) for (const q of t.p) {
      const x = q.dot(ax), y = q.dot(ay); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      dd += q.dot(nN); cnt++;
    }
    const o = nN.clone().multiplyScalar(dd / cnt + 0.0015);
    const P = (x, y) => o.clone().addScaledVector(ax, x).addScaledVector(ay, y).toArray();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...P(x0, y0), ...P(x1, y0), ...P(x1, y1), ...P(x0, y0), ...P(x1, y1), ...P(x0, y1)]), 3));
    screenMat.side = THREE.DoubleSide;
    // the dashboard monitor shows live system stats instead of its baked screenshot
    const dashName = IC.dashboard ? IC.dashboard.replace(/\./g, '') : null;
    if (dashName && (m.name.startsWith(dashName) || (m.parent && m.parent.name.startsWith(dashName)))) {
      const o2 = nN.clone().multiplyScalar(dd / cnt + 0.0008), Q = (x, y) => o2.clone().addScaledVector(ax, x).addScaledVector(ay, y).toArray();
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...Q(x0, y0), ...Q(x1, y0), ...Q(x1, y1), ...Q(x0, y0), ...Q(x1, y1), ...Q(x0, y1)]), 3));
      dg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
      const dash = createDashboard((x1 - x0) / (y1 - y0));
      const dm = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ map: dash.texture, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
      dm.raycast = () => {}; dm.renderOrder = 1; scene.add(dm);
    }
    const ov = new THREE.Mesh(g, screenMat); ov.raycast = () => {}; ov.renderOrder = 2; scene.add(ov);
    for (const mt of Array.isArray(m.material) ? m.material : [m.material])
      if (mt.emissiveIntensity > 0 && !monFlicker.some((x) => x.mt === mt)) monFlicker.push({ mt, base: mt.emissiveIntensity });
  }
  let screenOn = 1;

  // ---- cat: breathing in the vertex shader, twitch when clicked ----
  const catU = { uTime: { value: 0 }, uPoke: { value: 0 }, uCatC: { value: new THREE.Vector3() }, uCatS: { value: 0.5 } };
  const catBox = (meta.interactive.cat || [])[0];
  if (catBox) {
    const mn = new THREE.Vector3().fromArray(catBox.min), mx = new THREE.Vector3().fromArray(catBox.max);
    catU.uCatC.value.copy(mn).add(mx).multiplyScalar(0.5);
    catU.uCatS.value = mx.clone().sub(mn).length();
  }
  for (const m of groups.cat || []) {
    for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
      mt.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, catU);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uPoke; uniform vec3 uCatC; uniform float uCatS;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vec4 cwp = modelMatrix * vec4(position, 1.0);
            vec3 rel = cwp.xyz - uCatC;
            float up = clamp(rel.y / (uCatS * 0.35) + 0.5, 0.0, 1.0);
            float br = sin(uTime * 2.1) * 0.5 + 0.5;
            float s = 1.0 + (0.012 + 0.03 * uPoke) * br * up;
            vec3 wn = uCatC + vec3(rel.x * s, rel.y * (1.0 + (s - 1.0) * 1.6), rel.z * s);
            wn.y += uPoke * 0.012 * sin(uTime * 22.0) * up;
            transformed = (inverse(modelMatrix) * vec4(wn, 1.0)).xyz;`);
      };
      mt.needsUpdate = true;
    }
  }
  let poke = 0, catClicks = 0;
  // guitar: a short wobble when strummed
  let twang = 0, twangObj = null; const twangRest = new Map();

  // ---- pointer ----
  window.addEventListener('pointermove', (e) => {
    pointerPx = { x: e.clientX, y: e.clientY };
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  });
  const LABEL = { lamp: '台灯 · 点击开关', cat: '睡觉的大橘猫 · 点一下', window: '窗户 · 点击切换昼夜', monitors: '显示器 · 点击开关', curtain: '窗帘 · 点击拉开/拉上', blinds: '百叶窗 · 点击开合', guitarE: '电吉他 · 点击弹一下', guitarA: '木吉他 · 点击弹一下', ...(RT.labels || {}) };
  let monitorsOn = true;
  const pick = () => { ray.setFromCamera(ndc, camera); const h = ray.intersectObjects(pickables, false)[0]; return h ? h.object : null; };
  // inside the canvas "壁纸预览" node (an iframe): double-click on empty space asks the node to enlarge / restore.
  // Objects keep their own click behaviour. Standalone (Wallpaper Engine) there is no parent, so nothing is sent.
  window.addEventListener('dblclick', () => {
    if (window.parent !== window && !pick()) window.parent.postMessage({ type: 'wallpaper-preview:dblclick' }, '*');
  });
  // keyboard focus is inside this page while it's shown enlarged, so Esc must be forwarded for the node to close it
  window.addEventListener('keydown', (e) => {
    if (window.parent !== window && e.key === 'Escape') window.parent.postMessage({ type: 'wallpaper-preview:escape' }, '*');
  });
  window.addEventListener('click', () => {
    const o = pick(); if (!o) return;
    const k = o.userData.kind;
    if (k === 'lamp') lampOn = !lampOn;
    else if (k === 'window') { settings.realtimeDayNight = false; nightTarget = nightTarget > 0.5 ? 0 : 1; }
    else if (k === 'cat') { poke = 1; catClicks++; if (catClicks % 3 === 0) meow(); else purr(); if (catClicks % 3 === 1 && Math.random() < 0.4) setTimeout(meow, 900); }
    else if (k === 'guitarE' || k === 'guitarA') { strum(k === 'guitarE'); twang = 1; twangObj = o; }
    else if (k === 'monitors') monitorsOn = !monitorsOn;
    else if (k === 'curtain') curtainTarget = curtainTarget > 0.5 ? 0 : 1;
    else if (k === 'blinds') blindTarget = blindTarget > 0.5 ? 0 : 1;
    else if (k === 'book') window.open(bookUrl(o.userData.title), '_blank');
    else if (k === 'dragon') dragon.onClick();
  });

  let hoverT = 0, hover = null;
  return {
    update(dt, t) {
      hoverT += dt;
      if (hoverT > 0.066) {
        hoverT = 0;
        const o = pick();
        if (o !== hover) { hover = o; renderer.domElement.style.cursor = o ? 'pointer' : 'default'; }
        const k = o && o.userData.kind;
        const text = !o ? '' : k === 'book' ? o.userData.title + (BOOK_LINKS[o.userData.title] ? (BOOK_LINKS[o.userData.title].kind === 'free' ? ' · 点击阅读免费版' : ' · 点击打开配套代码') : ' · 点击搜索')
          : k === 'clock' ? new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : (LABEL[k] || '');
        tooltip.textContent = text;
        tooltip.style.display = text ? 'block' : 'none';
        if (text) { tooltip.style.left = (pointerPx.x + 14) + 'px'; tooltip.style.top = (pointerPx.y + 14) + 'px'; }
      }
      lampT += ((lampOn ? 1 : 0) - lampT) * Math.min(1, dt * 6);
      for (const l of lampLights) l.intensity = l.userData.base * lampT;
      drawClock();
      if (settings.realtimeDayNight) nightTarget = realNight();
      night += (nightTarget - night) * Math.min(1, dt * 1.5);
      dayMat.opacity = 1 - night;
      const k6 = Math.min(1, dt * 6);
      screenOn += ((monitorsOn ? 1 : 0) - screenOn) * k6;
      if (Math.abs(screenOn - (monitorsOn ? 1 : 0)) < 0.002) screenOn = monitorsOn ? 1 : 0;
      screenMat.opacity = 1 - screenOn;
      screenMat.visible = screenOn < 0.999;
      for (const x of monFlicker) x.mt.emissiveIntensity = x.base * (1 + 0.015 * Math.sin(t * 7.3 + x.base) * screenOn);
      blindT += (blindTarget - blindT) * Math.min(1, dt * 3);
      slats.forEach((o, i) => {
        const r = blindRot[i];
        o.quaternion.copy(_bq.setFromAxisAngle(slatAxis, r.shut * blindT)).multiply(r.q0);
        o.scale[r.w] = r.s0 * (1 + (Math.max(1, slatGap * 1.15 / r.width) - 1) * blindT);
      });
      curtainT += (curtainTarget - curtainT) * Math.min(1, dt * 3);
      // bedroom window (curtains) lets in most of the daylight, the blinds window the rest
      daylight.intensity = DAYLIGHT * settings.lights / 0.35 * (1 - night) * (1 - 0.65 * curtainT - 0.35 * blindT);
      if (moonAmb) moonAmb.intensity = moonBase * (1 - night * (0.7 * curtainT + 0.25 * blindT));
      curtains.forEach((c, i) => {
        c.position.x = curtainOpen[i].x + (curtainShut[i].x - curtainOpen[i].x) * curtainT;
        c.scale.x = curtainOpen[i].sx + (curtainShut[i].sx - curtainOpen[i].sx) * curtainT;
      });
      poke = Math.max(0, poke - dt * 0.9);
      if (twangObj) {
        const root = guitarRoots.find((g) => { for (let p = twangObj; p; p = p.parent) if (p === g) return true; return false; }) || twangObj;
        if (!twangRest.has(root)) twangRest.set(root, root.rotation.z);
        twang = Math.max(0, twang - dt * 1.8);
        root.rotation.z = twangRest.get(root) + 0.012 * twang * Math.sin(t * 40);
        if (twang === 0) twangObj = null;
      }
      catU.uTime.value = t; catU.uPoke.value = poke;
    },
  };
}

// Daytime view out of the window: sky gradient, a few clouds and a soft city skyline (matches the night view's framing).
function dayTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 576;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 576);
  sky.addColorStop(0, '#6fa8e6'); sky.addColorStop(0.6, '#bcd9f2'); sky.addColorStop(1, '#f4e6cf');
  g.fillStyle = sky; g.fillRect(0, 0, 1024, 576);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 9; i++) {
    const x = rnd() * 1024, y = 40 + rnd() * 200, r = 18 + rnd() * 26;
    for (let j = 0; j < 5; j++) { g.beginPath(); g.ellipse(x + j * r * 0.9, y + Math.sin(j) * r * 0.25, r * 1.2, r * 0.7, 0, 0, Math.PI * 2); g.fill(); }
  }
  for (const [col, base, hMax] of [['#9fb3c8', 430, 160], ['#7f93aa', 470, 140], ['#5f6f84', 520, 110]]) {
    g.fillStyle = col;
    for (let x = -20; x < 1044;) {
      const w = 30 + rnd() * 60, h = 40 + rnd() * hMax;
      g.fillRect(x, base - h, w, 576);
      x += w + 2 + rnd() * 10;
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;   // glTF UVs
  return t;
}
