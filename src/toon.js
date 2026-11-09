// Toon look for the wallpaper.
//  - toonMaterial(): cel-shaded lighting (4 hard bands, like the Blender ramp), keeps map / emissive
//  - outlineMaterial(): inverted hull pushed out in clip space, so the line is a constant pixel width
//    at any distance (same idea as the Blender GN outline, without duplicating geometry on the CPU)
import * as THREE from 'three';

export function makeGradientMap() {
  const stops = [0.01, 0.055, 0.21, 0.62];
  const data = new Uint8Array(stops.length * 4);
  stops.forEach((v, i) => {
    const c = Math.round(Math.pow(v, 1 / 2.2) * 255);
    data.set([c, c, c, 255], i * 4);
  });
  const t = new THREE.DataTexture(data, stops.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---- anime (三渲二) look: shared uniforms, driven by settings.anime (0 = original 4-band toon, 1 = full cel) ----
export const animeU = {
  uAnime: { value: 1 },
  uShadeTint: { value: new THREE.Color(0.55, 0.45, 0.85) },   // shadows lean cool purple instead of going grey
  uRimColor: { value: new THREE.Color(0.85, 0.8, 1.0) },
};

// Replaces three's toon lighting: a hard light / shadow terminator (one cel step) with a tinted shadow,
// blended with the original gradient bands by uAnime. Adds a hard rim light on materials with uRim = 1.
const CEL_LIGHTING = /* glsl */`
uniform float uAnime;
uniform vec3 uShadeTint;
uniform vec3 uRimColor;
uniform float uRim;
varying vec3 vViewPosition;
struct ToonMaterial { vec3 diffuseColor; };
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 bands = getGradientIrradiance( geometryNormal, directLight.direction );
  float dotNL = dot( geometryNormal, directLight.direction );
  float lit = smoothstep( -0.02, 0.05, dotNL );
  vec3 cel = mix( uShadeTint * 0.3, vec3( 0.8 ), lit );   // 0.8 = brightest original band (gamma-encoded ramp)
  vec3 irradiance = mix( bands, cel, uAnime ) * directLight.color;
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Toon
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
`;
const RIM = /* glsl */`
{
  float ndv = saturate( dot( normal, normalize( vViewPosition ) ) );
  float rimMask = smoothstep( 0.8, 0.86, 1.0 - ndv );
  outgoingLight += rimMask * uRim * uAnime * uRimColor * ( 0.015 + 0.12 * diffuseColor.rgb );
}
#include <opaque_fragment>`;

// `this` = the material (three calls material.onBeforeCompile(shader, renderer))
function animeCompile(sh) {
  Object.assign(sh.uniforms, animeU);
  sh.uniforms.uRim = this.userData.rimU;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <lights_toon_pars_fragment>', CEL_LIGHTING)
    .replace('#include <opaque_fragment>', RIM);
}

export function toonMaterial(src, gradientMap) {
  const m = new THREE.MeshToonMaterial({
    name: src.name,
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    map: src.map || null,
    emissive: src.emissive ? src.emissive.clone() : new THREE.Color(0, 0, 0),
    emissiveMap: src.emissiveMap || null,
    emissiveIntensity: src.emissiveIntensity ?? 1,
    gradientMap,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
  });
  m.userData.rimU = { value: 0 };   // set to 1 for characters (girl, cat)
  m.onBeforeCompile = animeCompile;
  return m;
}

const outlineVert = /* glsl */`
uniform float uWidth;
uniform vec2  uResolution;
attribute vec3 color;
varying vec3 vCol;
#include <skinning_pars_vertex>
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  vec3 n = normalize(normalMatrix * objectNormal);
  vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(0.0);
  clip.xy += dir * uWidth * 2.0 / uResolution * clip.w;
  gl_Position = clip;
  vCol = color;
}`;

const outlineFrag = /* glsl */`
uniform vec3 uTint;
uniform float uUseVertexColor;
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(mix(uTint, vCol, uUseVertexColor), 1.0);
  #include <colorspace_fragment>
}`;

export function outlineMaterial({ width = 1.0, color = new THREE.Color(0.03, 0.022, 0.045), vertexColor = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uWidth: { value: width },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uTint: { value: color },
      uUseVertexColor: { value: vertexColor ? 1 : 0 },
    },
    vertexShader: outlineVert,
    fragmentShader: outlineFrag,
    side: THREE.BackSide,
  });
}

// Per-vertex outline colour = darkened, slightly more saturated surface colour (same recipe as the Blender bake).
const _px = new Map();
function texturePixels(tex) {
  if (_px.has(tex)) return _px.get(tex);
  const img = tex.image;
  if (!img || !img.width) { _px.set(tex, null); return null; }
  const S = 128;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, S, S);
  const p = { data: g.getImageData(0, 0, S, S).data, S };
  _px.set(tex, p);
  return p;
}

export function bakeOutlineColors(geometry, material) {
  if (geometry.attributes.color) return;
  const n = geometry.attributes.position.count;
  const out = new Float32Array(n * 3);
  const base = material.color || new THREE.Color(0.5, 0.5, 0.5);
  const px = material.map ? texturePixels(material.map) : null;
  const uv = geometry.attributes.uv;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    if (px && uv) {
      let u = uv.getX(i) % 1, v = uv.getY(i) % 1; if (u < 0) u += 1; if (v < 0) v += 1;
      const x = Math.min(px.S - 1, Math.floor(u * px.S));
      const y = Math.min(px.S - 1, Math.floor(v * px.S));
      const k = (y * px.S + x) * 4;
      c.setRGB(px.data[k] / 255, px.data[k + 1] / 255, px.data[k + 2] / 255, THREE.SRGBColorSpace).multiply(base);
    } else c.copy(base);
    const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    out[i * 3]     = Math.max(0, l + (c.r - l) * 1.35) * 0.16 + 0.004;
    out[i * 3 + 1] = Math.max(0, l + (c.g - l) * 1.35) * 0.16 + 0.004;
    out[i * 3 + 2] = Math.max(0, l + (c.b - l) * 1.35) * 0.16 + 0.004;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(out, 3));
}
