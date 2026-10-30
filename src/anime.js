// Anime (三渲二) post pass: ink lines on every object from the depth buffer, plus a saturation lift.
// Lines come from 1/viewZ, which is linear across any flat surface in screen space, so:
//   silhouettes = a neighbour much further away than this pixel (line drawn on the front object only)
//   creases     = non-zero second difference of 1/z (corners, desk edges, box edges)
// Line colour is the darkened, saturated scene colour, not pure black, which reads softer and more hand-drawn.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { animeU } from './toon.js';

const vert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const frag = /* glsl */`
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar, uAnime, uWidth, uSat;
varying vec2 vUv;

float invZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (d >= 0.99999) return 0.0;                              // background
  return -1.0 / perspectiveDepthToViewZ(d, uNear, uFar);     // 1 / distance
}

void main() {
  vec4 c = texture2D(tColor, vUv);
  if (uAnime <= 0.001) { gl_FragColor = c; return; }
  vec3 col = c.rgb;

  float edge = 0.0;
  if (uWidth > 0.01) {
    vec2 o = uTexel * uWidth;
    float wC = invZ(vUv);
    if (wC > 0.0) {
      float wL = invZ(vUv - vec2(o.x, 0.0)), wR = invZ(vUv + vec2(o.x, 0.0));
      float wD = invZ(vUv - vec2(0.0, o.y)), wU = invZ(vUv + vec2(0.0, o.y));
      float sil = max(max(wC - wL, wC - wR), max(wC - wD, wC - wU)) / wC;   // this pixel is in front of a neighbour
      float bg  = max(max(wL - wC, wR - wC), max(wD - wC, wU - wC)) / wC;   // a neighbour is in front of this pixel
      float lap = (abs(wL + wR - 2.0 * wC) + abs(wD + wU - 2.0 * wC)) / wC;
      edge = smoothstep(0.02, 0.05, sil);
      edge = max(edge, smoothstep(0.012, 0.035, lap) * 0.8 * (1.0 - smoothstep(0.02, 0.05, bg)));
    }
  }

  // colour: saturation lift (applied in linear HDR, before bloom / tone mapping)
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 g = max(vec3(0.0), mix(vec3(l), col, uSat));
  vec3 ink = g * 0.15 + vec3(0.003, 0.002, 0.006);
  vec3 outc = mix(g, ink, edge * 0.92);
  gl_FragColor = vec4(mix(col, outc, uAnime), c.a);
}`;

export class AnimePass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uNear: { value: 0.05 }, uFar: { value: 60 },
        uAnime: animeU.uAnime,
        uWidth: { value: 1.5 },
        uSat: { value: 1.3 },
      },
      vertexShader: vert, fragmentShader: frag,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  setSize(w, h) { this.material.uniforms.uTexel.value.set(1 / w, 1 / h); }
  // reads the buffer the RenderPass just drew into (both composer targets carry a depth texture)
  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.uNear.value = this.camera.near; u.uFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}
