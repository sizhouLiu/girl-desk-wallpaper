// Dragon effects for outdoor scenes (runtime.dragon):
//   eye trail  = gold glowing streaks that stream back from both eyes (UE Niagara trail stand-in)
//   steam      = idle puffs from the nostrils, synced to the breathing loop
//   click      = snort, rear up, lunge toward the camera and exhale a cone of frost breath
// The neck / head motion is added on top of the skeletal animation every frame, after mixer.update().
// All reference points in the config are three.js world positions at animation time 0; they are converted
// to head-bone space once, so they follow the head through both the breathing loop and the click motion.
import * as THREE from 'three';

const vert = /* glsl */`
attribute float aT;
attribute float aR;
uniform float uPx, uS0, uS1, uMaxPx;
varying float vT;
void main() {
  vT = aT;
  if (aT >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(mix(uS0, uS1, aT) * (0.7 + 0.6 * aR) * uPx / max(-mv.z, 0.05), uMaxPx);
  gl_Position = projectionMatrix * mv;
}`;
const frag = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha, uIn;
varying float vT;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  a *= a * smoothstep(0.0, uIn, vT) * (1.0 - vT) * uAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
}`;

// ring-buffer point particles: emit(pos, vel), then update() ages, drags and lifts them
class Particles {
  constructor(scene, o) {
    this.n = o.max; this.o = o; this.i = 0;
    this.pos = new Float32Array(this.n * 3); this.vel = new Float32Array(this.n * 3);
    this.t = new Float32Array(this.n).fill(1); this.life = new Float32Array(this.n).fill(1);
    const r = new Float32Array(this.n); for (let k = 0; k < this.n; k++) r[k] = Math.random();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(this.t, 1));
    g.setAttribute('aR', new THREE.BufferAttribute(r, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uPx: { value: 500 }, uS0: { value: o.size[0] }, uS1: { value: o.size[1] }, uMaxPx: { value: o.maxPx || 400 },
        uColor: { value: new THREE.Color(...o.color).multiplyScalar(o.intensity || 1) },
        uAlpha: { value: o.alpha ?? 1 }, uIn: { value: o.fadeIn ?? 0.1 },
      },
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }
  emit(p, v) {
    const k = this.i, j = k * 3; this.i = (k + 1) % this.n;
    this.pos[j] = p.x; this.pos[j + 1] = p.y; this.pos[j + 2] = p.z;
    this.vel[j] = v.x; this.vel[j + 1] = v.y; this.vel[j + 2] = v.z;
    const [a, b] = this.o.life; this.life[k] = a + Math.random() * (b - a); this.t[k] = 0;
  }
  update(dt, px) {
    const drag = Math.exp(-(this.o.drag || 0) * dt), lift = (this.o.lift || 0) * dt;
    for (let k = 0; k < this.n; k++) {
      if (this.t[k] >= 1) continue;
      this.t[k] = Math.min(1, this.t[k] + dt / this.life[k]);
      const j = k * 3;
      this.vel[j] *= drag; this.vel[j + 1] = this.vel[j + 1] * drag + lift; this.vel[j + 2] *= drag;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aT.needsUpdate = true;
    this.mat.uniforms.uPx.value = px;
  }
}

const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const UP = new THREE.Vector3(0, 1, 0);

export function setupDragon({ scene, room, camera, renderer, mixer, lightsByName, cfg }) {
  const bone = (n) => room.getObjectByName(n);
  const head = bone(cfg.headBone || 'DR_head');
  if (!head) { console.warn('dragon: head bone not found'); return null; }
  const chain = (cfg.chain || []).map(bone).filter(Boolean);
  const weights = chain.map((_, i) => i + 1), wsum = weights.reduce((a, b) => a + b, 0);

  // rest pose (animation time 0) -> reference points in head-bone space
  if (mixer) mixer.update(0);
  room.updateMatrixWorld(true);
  const animated = new Set(mixer ? mixer._actions.flatMap((a) => a.getClip().tracks.map((t) => t.name.split('.')[0])) : []);
  const rest = chain.map((b) => (animated.has(b.name) ? null : b.quaternion.clone()));
  const inv = head.matrixWorld.clone().invert();
  const local = (a) => new THREE.Vector3(...a).applyMatrix4(inv);
  const P = cfg.points;
  const L = { tip: local(P.tip), mouth: local(P.mouth), nl: local(P.nostrilL), nr: local(P.nostrilR), el: local(P.eyeL), er: local(P.eyeR) };
  const headW0 = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const dir0 = new THREE.Vector3(...P.tip).sub(headW0).normalize();
  const pitchAxis = new THREE.Vector3().crossVectors(dir0, UP).normalize();   // +angle lifts the snout
  const toCam = camera.position.clone().sub(headW0); toCam.y = 0;
  const yawSign = Math.sign(new THREE.Vector3().crossVectors(UP, dir0).dot(toCam)) || 1;   // +yaw turns toward the camera

  // invisible pick spheres on the neck and head bones (raycasting the 70k-triangle skinned mesh is too slow for hover)
  const pickables = [];
  const ws = new THREE.Vector3();
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const [name, radius] of cfg.pick || []) {
    const b = bone(name); if (!b) continue;
    b.getWorldScale(ws);
    const child = b.children.find((c) => c.isBone);
    const s = new THREE.Mesh(new THREE.SphereGeometry(radius / ws.x, 10, 8), pickMat);
    if (b === head) s.position.copy(L.tip).multiplyScalar(0.5);
    else if (child) s.position.copy(child.position).multiplyScalar(0.5);
    b.add(s); pickables.push(s);
  }

  const eyeTrail = new Particles(scene, { max: 1600, additive: true, color: [1.0, 0.68, 0.22], intensity: 12, size: [0.13, 0.03], maxPx: 26, alpha: 0.9, life: [0.9, 1.4], drag: 0.5, lift: 0.03, fadeIn: 0.02 });
  const steam = new Particles(scene, { max: 600, color: [0.95, 0.97, 1.0], intensity: 1.4, size: [0.08, 0.7], alpha: 0.5, life: [1.4, 2.4], drag: 1.2, lift: 0.25, fadeIn: 0.12 });
  const breath = new Particles(scene, { max: 1400, color: [0.92, 0.97, 1.0], intensity: 1.5, size: [0.25, 2.2], alpha: 0.38, life: [1.2, 2.0], drag: 1.1, lift: 0.2, fadeIn: 0.06 });
  const frost = new Particles(scene, { max: 700, additive: true, color: [0.6, 0.85, 1.0], intensity: 12, size: [0.07, 0.015], maxPx: 18, alpha: 1, life: [0.9, 1.6], drag: 0.8, lift: -0.15, fadeIn: 0.04 });

  const eyeLights = (cfg.eyeLights || []).map((n) => lightsByName[n]).filter(Boolean);
  const eyeBase = eyeLights.map((l) => l.intensity);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), pq = new THREE.Quaternion(), qi = new THREE.Quaternion();
  const W = { head: new THREE.Vector3(), tip: new THREE.Vector3(), mouth: new THREE.Vector3(), nl: new THREE.Vector3(), nr: new THREE.Vector3(), el: new THREE.Vector3(), er: new THREE.Vector3(), dir: new THREE.Vector3() };
  const tmp = new THREE.Vector3(), vel = new THREE.Vector3(), aim = new THREE.Vector3(), size = new THREE.Vector2();
  const jit = new THREE.Vector3();
  const rnd = (s) => jit.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(s * 2);
  const acc = { eye: 0, eyeR: 0, steam: 0, steamR: 0, breath: 0, frost: 0 };
  let clickT = -1, idleT = 0;
  const breathLoop = cfg.breathLoop || 4.04;
  const REAR = cfg.rear ?? 0.5, LUNGE = cfg.lunge ?? 0.2, TURN = cfg.turn ?? 0.45;   // radians

  // emit `rate` particles per second, frame-rate independent
  const emitN = (key, rate, dt, fn) => { acc[key] += rate * dt; while (acc[key] >= 1) { acc[key] -= 1; fn(); } };

  // click timeline (seconds): 0-0.4 snort, 0-0.55 rear up, 0.55-0.8 lunge, 0.7-2.7 frost breath, 2.8-4.2 settle
  function motion(t) {
    if (t < 0) return [0, 0, 0];
    let pitch, yaw;
    if (t < 0.55) { pitch = REAR * smooth(t / 0.55); yaw = -0.08 * smooth(t / 0.55); }
    else if (t < 0.8) { const k = smooth((t - 0.55) / 0.25); pitch = REAR - (REAR + LUNGE) * k; yaw = -0.08 + (TURN + 0.08) * k; }
    else if (t < 2.8) { pitch = -LUNGE + 0.015 * Math.sin(t * 38); yaw = TURN + 0.05 * Math.sin((t - 0.8) * 1.6); }
    else { const k = smooth((t - 2.8) / 1.4); pitch = -LUNGE * (1 - k); yaw = TURN * (1 - k); }
    const flare = t < 3 ? smooth(t / 0.3) : 1 - smooth((t - 3) / 1);
    return [pitch, yaw * yawSign, Math.max(0, flare)];
  }

  return {
    pickables,
    onClick() { if (clickT < 0 || clickT > 3.6) clickT = 0; },
    // call right after mixer.update(), before rendering
    update(dt) {
      if (clickT >= 0) { clickT += dt; if (clickT > 4.3) clickT = -1; }
      const [pitch, yaw, flare] = motion(clickT);
      chain.forEach((b, i) => { if (rest[i]) b.quaternion.copy(rest[i]); });
      // additive neck / head rotation about world axes, root to tip, weighted toward the head
      if (pitch || yaw) {
        chain.forEach((b, i) => {
          const w = weights[i] / wsum;
          qa.setFromAxisAngle(pitchAxis, pitch * w); qb.setFromAxisAngle(UP, yaw * w); qa.premultiply(qb);
          b.parent.updateWorldMatrix(true, false); b.parent.getWorldQuaternion(pq);
          qi.copy(pq).invert().multiply(qa).multiply(pq);
          b.quaternion.premultiply(qi);
        });
      }
      head.updateWorldMatrix(true, false);
      const m = head.matrixWorld;
      W.head.setFromMatrixPosition(m);
      for (const k of ['tip', 'mouth', 'nl', 'nr', 'el', 'er']) W[k].copy(L[k]).applyMatrix4(m);
      W.dir.copy(W.tip).sub(W.head).normalize();

      // eye trail: streams back from the eyes; brighter and denser while the dragon reacts
      const eyeRate = 110 + 220 * flare;
      for (const e of [W.el, W.er]) emitN(e === W.el ? 'eye' : 'eyeR', eyeRate, dt, () => {
        vel.copy(W.dir).multiplyScalar(-0.12 - 0.25 * flare).addScaledVector(UP, 0.06).add(rnd(0.03));
        eyeTrail.emit(tmp.copy(camera.position).sub(e).setLength(0.22).add(e).add(rnd(0.015)), vel);
      });
      eyeLights.forEach((l, i) => { l.position.copy(i ? W.er : W.el); l.intensity = eyeBase[i] * (1 + 3 * flare); });

      // nostril steam: a soft puff once per breathing cycle, plus a sharp snort at the start of a click
      idleT = (idleT + dt) % breathLoop;
      const puff = idleT < 0.7 ? 22 : 0;
      const snort = clickT >= 0 && clickT < 0.4 ? 160 : 0;
      const nose = tmp.copy(W.dir).multiplyScalar(0.75).addScaledVector(UP, -0.45).normalize().clone();
      for (const n of [W.nl, W.nr]) emitN(n === W.nl ? 'steam' : 'steamR', puff + snort, dt, () => {
        vel.copy(nose).multiplyScalar((snort ? 1.4 : 0.35) * (0.7 + Math.random() * 0.6)).add(rnd(0.08));
        steam.emit(n, vel);
      });

      // frost breath: a widening cone out of the mouth along the snout
      if (clickT > 0.7 && clickT < 2.7) {
        const fade = 1 - smooth((clickT - 2.2) / 0.5);
        aim.copy(camera.position).sub(W.mouth).multiplyScalar(cfg.breathReach ?? 0.6).add(W.mouth).addScaledVector(UP, -0.25).sub(W.mouth).normalize();
        emitN('breath', 520 * fade, dt, () => {
          vel.copy(aim).add(rnd(0.16)).normalize().multiplyScalar(3.6 + Math.random() * 1.8);
          breath.emit(tmp.copy(W.mouth).add(rnd(0.08)), vel);
        });
        emitN('frost', 260 * fade, dt, () => {
          vel.copy(aim).add(rnd(0.3)).normalize().multiplyScalar(2.5 + Math.random() * 2.5);
          frost.emit(tmp.copy(W.mouth).add(rnd(0.1)), vel);
        });
        // slight camera shake while the breath blows past
        camera.position.add(rnd(0.006 * fade));
      }

      renderer.getDrawingBufferSize(size);
      const px = size.y * 0.5 * camera.projectionMatrix.elements[5];
      for (const p of [eyeTrail, steam, breath, frost]) p.update(dt, px);
    },
  };
}
