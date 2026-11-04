// Procedural idle motion layered on top of the skeletal animation (runtime.sway):
//   breathing = chest lifts and shoulders rise on the inhale; arms = slow, slightly lagging swing.
// Rotations are about the character's own axes (from the rest pose): "side" = shoulder to shoulder,
// "fwd" = facing direction. Each entry: { bone, axis: 'side' | 'fwd', deg, period, phase }; deg > 0 lifts the
// bone's tip. Call update() right after mixer.update(), before rendering.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export function setupSway({ room, mixer, cfg }) {
  const get = (n) => room.getObjectByName(n);
  const l = get(cfg.left), r = get(cfg.right);
  if (!l || !r) { console.warn('sway: shoulder bones not found'); return null; }
  if (mixer) mixer.update(0);
  room.updateMatrixWorld(true);
  const pos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
  const side = pos(r).sub(pos(l)); side.y = 0; side.normalize();
  const fwd = new THREE.Vector3().crossVectors(UP, side).normalize();
  const axes = { side, fwd };
  const animated = new Set(mixer ? mixer._actions.flatMap((a) => a.getClip().tracks.map((t) => t.name.split('.')[0])) : []);
  const items = [];
  for (const e of cfg.bones || []) {
    const b = get(e.bone); if (!b) continue;
    const axis = axes[e.axis] || side;
    // sign so that +deg moves the bone's tip upward (bone direction = head -> first child bone)
    const child = b.children.find((c) => c.isBone);
    const d = child ? pos(child).sub(pos(b)) : new THREE.Vector3(0, 1, 0);
    const lift = Math.sign(new THREE.Vector3().crossVectors(axis, d).y) || 1;
    items.push({ b, axis, rad: THREE.MathUtils.degToRad(e.deg) * lift, period: e.period || 4, phase: e.phase || 0,
      rest: animated.has(b.name) ? null : b.quaternion.clone() });
  }
  // hair (cfg.hair): bones bend downwind with a steady lean plus irregular gusts and a fast flutter.
  // { bones: [...], wind: [x, y, z] (world, three.js), lean, gust, flutter (degrees) }
  const hair = [];
  if (cfg.hair) {
    const H = cfg.hair, wind = new THREE.Vector3(...H.wind); wind.y = 0; wind.normalize();
    const axis = new THREE.Vector3().crossVectors(UP, wind).normalize();
    H.bones.forEach((n, k) => {
      const b = get(n); if (!b) return;
      // the bone's tip hangs down from its head; pick the sign that swings the tip downwind
      const tip = new THREE.Vector3(0, b.userData.len || 0.25, 0).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()));
      const sign = Math.sign(new THREE.Vector3().crossVectors(axis, tip).dot(wind)) || 1;
      hair.push({ b, rest: b.quaternion.clone(), sign, seed: k * 1.7 + 0.3 });
    });
    hair.cfg = { axis, lean: THREE.MathUtils.degToRad(H.lean ?? 8), gust: THREE.MathUtils.degToRad(H.gust ?? 6), flutter: THREE.MathUtils.degToRad(H.flutter ?? 1.5) };
  }
  // root to tip, so each bone's parent orientation already includes the offsets above it
  items.sort((a, b) => depth(a.b) - depth(b.b));
  const qa = new THREE.Quaternion(), pq = new THREE.Quaternion(), qi = new THREE.Quaternion();
  let t = 0;
  const qh = new THREE.Quaternion();
  // smooth irregular gust 0..1: three incommensurate sines, so the pattern never visibly repeats
  const gustAt = (x) => 0.5 + 0.22 * Math.sin(x * 0.83) + 0.17 * Math.sin(x * 1.37 + 1.1) + 0.11 * Math.sin(x * 2.31 + 2.3);
  return {
    update(dt) {
      t += dt;
      if (hair.length) {
        const c = hair.cfg;
        for (const h of hair) {
          const g = gustAt(t + h.seed * 0.15);
          const a = h.sign * (c.lean + c.gust * g + c.flutter * Math.sin(t * 9.0 + h.seed * 2.1) * (0.4 + g));
          h.b.quaternion.copy(h.rest);
          h.b.parent.updateWorldMatrix(true, false); h.b.parent.getWorldQuaternion(pq);
          qh.setFromAxisAngle(c.axis, a);
          qi.copy(pq).invert().multiply(qh).multiply(pq);
          h.b.quaternion.premultiply(qi);
        }
      }
      for (const it of items) {
        if (it.rest) it.b.quaternion.copy(it.rest);
        const a = it.rad * Math.sin((t / it.period + it.phase) * Math.PI * 2);
        qa.setFromAxisAngle(it.axis, a);
        it.b.parent.updateWorldMatrix(true, false); it.b.parent.getWorldQuaternion(pq);
        qi.copy(pq).invert().multiply(qa).multiply(pq);
        it.b.quaternion.premultiply(qi);
      }
    },
  };
}

function depth(o) { let n = 0; for (let p = o.parent; p; p = p.parent) n++; return n; }
