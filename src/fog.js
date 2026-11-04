// Atmosphere post pass for realistic outdoor scenes, ported from the TianNanGe UE level:
//   height fog  = UE ExponentialHeightFog (analytic line integral, exp2, start distance, max opacity)
//   cloud sea   = UE CloudSeaLayer.ush density (rolling top, erosion, interior boost, bridge clearance),
//                 ray-marched through a horizontal slab with procedural value noise instead of 3D textures
// Everything is in three.js world metres (UE x, z, y / 100). Runs on the linear HDR buffer before bloom.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const vert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const frag = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uFogOn, uFogDensity, uFogFalloff, uFogHeight, uFogStart, uFogMax;
uniform vec3 uFogColor;
uniform float uCloudOn, uSea, uWave, uWavePeriod, uBillowPeriod, uBillowStrength, uSoft, uErosion, uDetailPeriod;
uniform float uExt, uBoost, uEdgeFade, uClearStrength, uClearWidth, uMaxDist, uShadowK;
uniform vec2 uWind;
uniform vec3 uBoxMin, uBoxMax, uAlbedo, uCloudLit, uCloudShade;
uniform vec3 uTint, uShadowTint;
uniform float uSunOn, uSunExp, uSunHaze, uGlow, uGlowExp;
uniform vec3 uSunDir, uSunColor;
uniform float uGradeOn, uSat;
varying vec2 vUv;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { return noise(p) * 0.5 + noise(p * 2.03 + 1.7) * 0.3 + noise(p * 4.01 + 3.1) * 0.2; }

// UE exponential height fog: density * 2^(-falloff * (h - fogHeight)) integrated along the ray
float fogAmount(vec3 dir, float dist) {
  if (uFogOn < 0.5) return 0.0;
  float L = dist - uFogStart;
  if (L <= 0.0) return 0.0;
  vec3 p0 = uCamPos + dir * uFogStart;
  float k = uFogFalloff * dir.y * L;
  float line = abs(k) > 1e-4 ? (1.0 - exp2(-k)) / (k * 0.6931472) : 1.0;
  float od = uFogDensity * exp2(-uFogFalloff * (p0.y - uFogHeight)) * line * L;
  return min(1.0 - exp2(-od), uFogMax);
}

// UE keeps a shallow clear band under the walkable bridge deck (polyline in UE x)
float bridgeCut(vec3 p) {
  float x = p.x;
  float by = mix(0.45175742, 1.53741768, clamp((x - 1.0) / 5.5, 0.0, 1.0));
  float bz = mix(0.06422109, -0.75733158, clamp((x - 1.0) / 5.5, 0.0, 1.0));
  by = mix(by, 3.20417146, clamp((x - 6.5) / 5.5, 0.0, 1.0));  bz = mix(bz, -1.94377096, clamp((x - 6.5) / 5.5, 0.0, 1.0));
  by = mix(by, 2.59282778, clamp((x - 12.0) / 5.5, 0.0, 1.0)); bz = mix(bz, -1.46720279, clamp((x - 12.0) / 5.5, 0.0, 1.0));
  by = mix(by, 0.32789313, clamp((x - 17.5) / 4.0, 0.0, 1.0)); bz = mix(bz, 0.03879085, clamp((x - 17.5) / 4.0, 0.0, 1.0));
  float nearB = 1.0 - smoothstep(1.2 * uClearWidth, 2.6 * uClearWidth, abs(p.z - by));
  float above = smoothstep(bz - 0.40, bz - 0.1125, p.y);
  return 1.0 - nearB * above * uClearStrength;
}

float cloudDensity(vec3 p, out float depth) {
  vec3 q = p + vec3(uWind.x, 0.0, uWind.y) * uTime;
  // fbm sits around 0.5 with a narrow spread; stretch it to UE's remapped 0..1 range
  float large = clamp((fbm(vec3(q.xz / uWavePeriod, 0.37)) - 0.5) * 2.5 + 0.5, 0.0, 1.0);
  float billow = clamp((fbm(vec3(q.xz / uBillowPeriod, 0.63)) - 0.5) * 2.5 + 0.5, 0.0, 1.0);
  float top = uSea + (large - 0.5) * uWave * 2.0 + (billow - 0.5) * uWave * uBillowStrength;
  float erosion = 1.0 - fbm(q / uDetailPeriod);
  depth = top - p.y - erosion * uErosion;
  float body = smoothstep(-uSoft, uSoft, depth);
  if (body <= 0.0) return 0.0;
  float interior = mix(0.65, 1.0, noise(q / uBillowPeriod));
  vec2 de = min(p.xz - uBoxMin.xz, uBoxMax.xz - p.xz);
  float edge = smoothstep(0.0, uEdgeFade, min(de.x, de.y));
  float bottom = smoothstep(0.0, 1.6, p.y - uBoxMin.y);
  float core = mix(1.0, uBoost, smoothstep(0.35 * uSoft, 1.5 * uSoft, depth));
  return body * interior * core * edge * bottom * bridgeCut(p) * uExt;
}

void main() {
  vec4 c = texture2D(tColor, vUv);
  float d = texture2D(tDepth, vUv).x;
  bool sky = d >= 0.99999;
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, (sky ? 1.0 : d) * 2.0 - 1.0, 1.0);
  vec3 wp = (uCamWorld * vec4(v.xyz / v.w, 1.0)).xyz;
  vec3 dir = normalize(wp - uCamPos);
  float dist = sky ? 1e4 : length(wp - uCamPos);
  // backlight: fog scatters the light source forward (UE directional inscattering), plus a halo in the sky
  float cosS = uSunOn > 0.5 ? max(dot(dir, uSunDir), 0.0) : 0.0;
  vec3 fogCol = uFogColor + uSunColor * uSunHaze * pow(cosS, uSunExp);
  vec3 col = mix(c.rgb, fogCol, fogAmount(dir, dist));
  if (sky) col += uSunColor * uGlow * pow(cosS, uGlowExp);

  if (uCloudOn > 0.5) {
    float yTop = uSea + uWave * (1.0 + 0.5 * uBillowStrength) + uSoft, yBot = uBoxMin.y;
    float t0 = 0.0, t1 = min(dist, uMaxDist);
    if (abs(dir.y) > 1e-5) {
      float ta = (yBot - uCamPos.y) / dir.y, tb = (yTop - uCamPos.y) / dir.y;
      t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
    } else if (uCamPos.y > yTop || uCamPos.y < yBot) t1 = -1.0;
    if (t1 > t0) {
      float dt = (t1 - t0) / float(STEPS);
      float t = t0 + dt * hash(vec3(gl_FragCoord.xy, fract(uTime) * 61.0));
      float T = 1.0; vec3 acc = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        vec3 p = uCamPos + dir * t;
        float dep; float s = cloudDensity(p, dep);
        if (s > 0.0) {
          float a = 1.0 - exp(-s * dt);
          // light from above: the deeper below the rolling top, the more self-shadowed
          vec3 cl = uAlbedo * mix(uCloudShade, uCloudLit, exp(-max(dep, 0.0) * uShadowK));
          cl = mix(cl, uFogColor, fogAmount(dir, t));
          acc += T * a * cl; T *= 1.0 - a;
          if (T < 0.01) break;
        }
        t += dt;
      }
      col = col * T + acc;
    }
  }
  // grade (linear HDR, before tone mapping): overall tint, cooler shadows, saturation around luminance
  if (uGradeOn > 0.5) {
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(uShadowTint, uTint, smoothstep(0.0, 0.6, l));
    l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, uSat), 0.0);
  }
  gl_FragColor = vec4(col, c.a);
}`;

export class FogPass extends Pass {
  // fog / cloud: runtime.lighting.heightFog and runtime.cloudSea from wallpaper.config.json (metres)
  constructor(camera, fog, cloud, grade, sun) {
    super();
    this.camera = camera;
    this.time = 0;
    const f = fog || {}, cs = cloud || {}, g = grade || {}, sn = sun || {};
    const v3 = (a, d) => new THREE.Vector3(...(a || d));
    this.material = new THREE.ShaderMaterial({
      defines: { STEPS: cs.steps || 48 },
      uniforms: {
        tColor: { value: null }, tDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uFogOn: { value: fog ? 1 : 0 }, uFogDensity: { value: f.density ?? 0.05 }, uFogFalloff: { value: f.falloff ?? 0.2 },
        uFogHeight: { value: f.height ?? 0 }, uFogStart: { value: f.start ?? 0 }, uFogMax: { value: f.maxOpacity ?? 1 },
        uFogColor: { value: v3(f.color, [0.6, 0.7, 0.8]) },
        uCloudOn: { value: cloud ? 1 : 0 }, uSea: { value: cs.sea ?? -1 }, uWave: { value: cs.wave ?? 0.4 },
        uWavePeriod: { value: cs.wavePeriod ?? 18 }, uBillowPeriod: { value: cs.billowPeriod ?? 5.5 }, uBillowStrength: { value: cs.billowStrength ?? 0.6 },
        uSoft: { value: cs.soft ?? 0.35 }, uErosion: { value: cs.erosion ?? 0.45 }, uDetailPeriod: { value: cs.detailPeriod ?? 1.7 },
        uExt: { value: cs.extinction ?? 6 }, uBoost: { value: cs.boost ?? 1 }, uEdgeFade: { value: cs.edgeFade ?? 9 },
        uClearStrength: { value: cs.clearStrength ?? 0 }, uClearWidth: { value: cs.clearWidth ?? 1 },
        uMaxDist: { value: cs.maxDist ?? 150 }, uShadowK: { value: cs.shadowK ?? 0.6 },
        uWind: { value: new THREE.Vector2(...(cs.wind || [0, 0])) },
        uBoxMin: { value: v3(cs.boxMin, [-50, -10, -50]) }, uBoxMax: { value: v3(cs.boxMax, [50, 2, 50]) },
        uAlbedo: { value: v3(cs.albedo, [0.66, 0.67, 0.64]) },
        uCloudLit: { value: v3(cs.lit, [1.3, 1.35, 1.4]) }, uCloudShade: { value: v3(cs.shade, [0.6, 0.68, 0.8]) },
        uGradeOn: { value: grade ? 1 : 0 }, uTint: { value: v3(g.tint, [1, 1, 1]) }, uShadowTint: { value: v3(g.shadowTint, g.tint || [1, 1, 1]) },
        uSat: { value: g.saturation ?? 1 },
        uSunOn: { value: sun ? 1 : 0 }, uSunDir: { value: v3(sn.dir, [0, 1, 0]).normalize() }, uSunColor: { value: v3(sn.color, [1, 0.95, 0.85]) },
        uSunExp: { value: sn.hazeExp ?? 6 }, uSunHaze: { value: sn.haze ?? 0.6 }, uGlow: { value: sn.glow ?? 0.8 }, uGlowExp: { value: sn.glowExp ?? 12 },
      },
      vertexShader: vert, fragmentShader: frag,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.material.uniforms;
    this.time += deltaTime || 0;
    u.uTime.value = this.time;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    this.camera.updateMatrixWorld();
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}
