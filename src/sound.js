// Sound effects (Web Audio): procedural cat purr and guitar strum, CC0 recordings for the meow.
// The AudioContext is created on the first click, since browsers / Wallpaper Engine only allow audio after a gesture.
import { settings } from './settings.js';

let ctx = null, master = null;
function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    loadMeows();
  }
  if (ctx.state === 'suspended') ctx.resume();
  master.gain.value = settings.volume;
  return ctx;
}

let noiseBuf = null;
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  return s;
}

// ---- purr: low rumble pulsed ~25 Hz, slow inhale / exhale swell ----
let purring = null;
export function purr(seconds = 4.5) {
  if (!ac() || settings.volume <= 0) return;
  if (purring) purring.stop();
  const t0 = ctx.currentTime, t1 = t0 + seconds;
  const src = noise();
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.7;
  const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 110; body.gain.value = 10; body.Q.value = 1.2;
  // the purr pulse: a gain driven by a ~25 Hz oscillator
  const pulse = ctx.createGain(); pulse.gain.value = 0;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 25;
  const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.5;
  const dc = ctx.createConstantSource(); dc.offset.value = 0.5;
  lfo.connect(lfoAmt).connect(pulse.gain); dc.connect(pulse.gain);
  // breath envelope: a few swells, purr pitch rises slightly on inhale
  const env = ctx.createGain(); env.gain.value = 0;
  const breath = 1.6;
  for (let t = t0, i = 0; t < t1; t += breath, i++) {
    env.gain.setTargetAtTime(i % 2 ? 0.9 : 1.3, t, 0.25);
    lfo.frequency.setTargetAtTime(i % 2 ? 23 : 27, t, 0.3);
  }
  env.gain.setTargetAtTime(0, t1 - 0.4, 0.15);
  src.connect(lp).connect(body).connect(pulse).connect(env).connect(master);
  [src, lfo, dc].forEach((n) => { n.start(t0); n.stop(t1 + 0.5); });
  purring = { stop: () => { env.gain.cancelScheduledValues(ctx.currentTime); env.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } };
  src.onended = () => { purring = null; };
}

// ---- meow: CC0 recordings from Wikimedia Commons (see public/sounds/CREDITS.txt) ----
// start = where the meow begins in the file, peak = file peak level (used to even out loudness)
const MEOWS = [
  { file: 'sounds/meow_1.ogg', start: 0.0, peak: 0.59 },
  { file: 'sounds/meow_2.wav', start: 0.22, peak: 1.0 },
  { file: 'sounds/meow_3.wav', start: 0.5, peak: 0.14 },
  { file: 'sounds/meow_4.ogg', start: 0.33, peak: 0.76 },
];
const meowBufs = new Map();
function loadMeows() {
  for (const m of MEOWS) {
    if (meowBufs.has(m.file)) continue;
    meowBufs.set(m.file, null);
    fetch(m.file).then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a))
      .then((buf) => meowBufs.set(m.file, buf)).catch(() => meowBufs.delete(m.file));
  }
}
let lastMeow = -1;
export function meow() {
  if (!ac() || settings.volume <= 0) return;
  loadMeows();
  const ready = MEOWS.filter((m) => meowBufs.get(m.file));
  if (!ready.length) { setTimeout(() => { if (MEOWS.some((m) => meowBufs.get(m.file))) meow(); }, 400); return; }
  let i = Math.floor(Math.random() * ready.length);
  if (ready.length > 1 && ready[i].file === lastMeow) i = (i + 1) % ready.length;   // don't repeat the same one
  const m = ready[i]; lastMeow = m.file;
  const src = ctx.createBufferSource(); src.buffer = meowBufs.get(m.file);
  src.playbackRate.value = 0.95 + Math.random() * 0.12;
  const g = ctx.createGain(); g.gain.value = Math.min(4, 0.7 / m.peak);
  src.connect(g).connect(master);
  src.start(ctx.currentTime + 0.01, m.start);
}

// ---- guitar: Karplus-Strong plucked strings, strummed chord ----
const CHORDS = [
  [82.41, 123.47, 164.81, 207.65, 246.94, 329.63],   // E
  [110.0, 164.81, 220.0, 277.18, 329.63],             // A
  [146.83, 220.0, 293.66, 369.99],                    // D
  [98.0, 123.47, 146.83, 196.0, 246.94, 392.0],       // G
  [130.81, 164.81, 196.0, 261.63, 329.63],            // C
  [110.0, 164.81, 220.0, 261.63, 329.63],             // Am
];
let chordIdx = 0;
function pluck(freq, when, { decay = 0.996, bright = 0.5, len = 2.5 } = {}) {
  const sr = ctx.sampleRate, n = Math.floor(sr * len), out = new Float32Array(n);
  const period = Math.max(2, Math.round(sr / freq));
  const buf = new Float32Array(period);
  for (let i = 0; i < period; i++) buf[i] = Math.random() * 2 - 1;
  // soften the attack: pre-filter the excitation (lower `bright` = darker pick)
  for (let k = 0; k < 2; k++) for (let i = 1; i < period; i++) buf[i] = buf[i] * bright + buf[i - 1] * (1 - bright);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const nx = (j + 1) % period, v = buf[j];
    out[i] = v;
    buf[j] = decay * 0.5 * (v + buf[nx]);
    j = nx;
  }
  const b = ctx.createBuffer(1, n, sr); b.copyToChannel(out, 0);
  const s = ctx.createBufferSource(); s.buffer = b;
  s.start(when);
  return s;
}
let distCurve = null;
export function strum(electric = false) {
  if (!ac() || settings.volume <= 0) return;
  const chord = CHORDS[chordIdx++ % CHORDS.length];
  const t0 = ctx.currentTime + 0.02;
  const bus = ctx.createGain(); bus.gain.value = electric ? 0.22 : 0.3;
  if (electric) {
    // light overdrive + cabinet-ish lowpass
    if (!distCurve) { distCurve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; distCurve[i] = Math.tanh(x * 3) / Math.tanh(3); } }
    const ws = ctx.createWaveShaper(); ws.curve = distCurve; ws.oversample = '2x';
    const cab = ctx.createBiquadFilter(); cab.type = 'lowpass'; cab.frequency.value = 3200;
    bus.connect(ws).connect(cab).connect(master);
  } else {
    // acoustic body resonance
    const bodyRes = ctx.createBiquadFilter(); bodyRes.type = 'peaking'; bodyRes.frequency.value = 180; bodyRes.gain.value = 5; bodyRes.Q.value = 1;
    bus.connect(bodyRes).connect(master);
  }
  chord.forEach((f, i) => {
    const s = pluck(f, t0 + i * 0.028, electric ? { decay: 0.998, bright: 0.7, len: 3 } : { decay: 0.995, bright: 0.45, len: 2.5 });
    s.connect(bus);
  });
}
