// Runtime settings. Wallpaper Engine pushes user properties through window.wallpaperPropertyListener;
// in a normal browser the defaults (or ?key=value in the URL) are used.
export const settings = {
  camera: 'CAM_Front',
  fps: 30,
  resolution: 1.0,
  adaptive: true,
  outline: 1.0,
  bloom: 0.3,
  exposure: 0.85,
  parallax: 1.0,
  realtimeDayNight: false,
  showStats: false,
  lights: 0.35,
  volume: 0.6,
  anime: 1.0,
  inkLines: 1.5,
  ambient: 1.0,
  bloomThreshold: 1.0,
};
const q = new URLSearchParams(location.search);
for (const [k, v] of q) {
  if (!(k in settings)) continue;
  settings[k] = typeof settings[k] === 'number' ? Number(v) : typeof settings[k] === 'boolean' ? v === '1' || v === 'true' : v;
}

const listeners = [];
export function onSettings(fn) { listeners.push(fn); }
function push(changed) { for (const fn of listeners) fn(settings, changed); }

// camera dropdown value (project.json) -> camera id; main.js replaces it with runtime.json's camera list
const cameraByValue = { 0: 'SCN_Camera', 1: 'CAM_Bedroom', 2: 'CAM_Shelf', 3: 'CAM_Front' };
export function setCameraOptions(list) {
  if (!Array.isArray(list) || !list.length) return;
  for (const k of Object.keys(cameraByValue)) delete cameraByValue[k];
  for (const c of list) cameraByValue[c.value] = c.id;
}
// settings Wallpaper Engine has pushed (so scene defaults loaded later don't overwrite the user's choice)
export const userSet = new Set();

// Wallpaper Engine property keys (see project.json) -> settings
const MAP = {
  camera: (v) => cameraByValue[Number(v)] || settings.camera,
  fps: (v) => Number(v),
  resolution: (v) => Number(v) / 100,
  adaptive: (v) => !!v,
  outline: (v) => Number(v) / 10,
  bloom: (v) => Number(v) / 100,
  exposure: (v) => Number(v) / 100,
  parallax: (v) => Number(v) / 100,
  realtimedaynight: (v) => !!v,
  showstats: (v) => !!v,
  lights: (v) => Number(v) / 100,
  volume: (v) => Number(v) / 100,
  anime: (v) => Number(v) / 100,
  inklines: (v) => Number(v) / 10,
};
const KEY = { realtimedaynight: 'realtimeDayNight', showstats: 'showStats', inklines: 'inkLines' };

window.wallpaperPropertyListener = window.wallpaperPropertyListener || {};
window.wallpaperPropertyListener.applyUserProperties = (props) => {
  const changed = {};
  for (const [k, p] of Object.entries(props)) {
    if (!(k in MAP) || p == null || p.value === undefined) continue;
    const key = KEY[k] || k;
    settings[key] = MAP[k](p.value);
    changed[key] = true;
    userSet.add(key);
  }
  push(changed);
};
window.wallpaperPropertyListener.applyGeneralProperties = (props) => {
  if (props.fps) { settings.fps = Math.min(settings.fps, props.fps); push({ fps: true }); }
};
