// UI state and rendering.

import { TunerEngine } from './audio.js';
import { resolveSources } from './sources.js';
import { TUNINGS, buildTargets, cents, matchString, median } from './music.js';

const IN_TUNE_CENTS = 5;      // green window
const HOLD_MS = 600;          // keep the last reading up this long after a note dies
const CLARITY_MIN = 0.85;     // reject weak / non-periodic frames
const HISTORY = 5;            // median filter length
const SMOOTHING = 0.25;       // needle easing per frame

// Input level meter, in dBFS. The scale is logarithmic because microphone
// levels are: a guitar that reads 5% of full scale linearly is a perfectly
// usable -26 dB, and a linear bar would show it as nearly nothing.
const LEVEL_MIN_DB = -80;     // left edge of the meter
const LEVEL_FLOOR_DB = -70;   // below here detection gets unreliable
const PEAK_FALL_DB_PER_SEC = 24;
const QUIET_HINT_AFTER_MS = 2500;

const el = {
  body: document.body,
  note: document.getElementById('note'),
  cents: document.getElementById('cents'),
  hz: document.getElementById('hz'),
  hint: document.getElementById('hint'),
  needle: document.getElementById('needle'),
  ticks: document.getElementById('ticks'),
  strings: document.getElementById('strings'),
  levelFill: document.getElementById('level-fill'),
  levelPeak: document.getElementById('level-peak'),
  levelFloor: document.getElementById('level-floor'),
  levelDb: document.getElementById('level-db'),
  levelTrack: document.querySelector('.level-track'),
  diag: document.getElementById('diag'),
  tuning: document.getElementById('tuning'),
  a4: document.getElementById('a4'),
  a4up: document.getElementById('a4up'),
  a4down: document.getElementById('a4down'),
  overlay: document.getElementById('overlay'),
  start: document.getElementById('start'),
  status: document.getElementById('status'),
};

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

const state = {
  tuningKey: TUNINGS[store.get('tuning', 'standard')] ? store.get('tuning', 'standard') : 'standard',
  a4: Math.min(466, Math.max(415, Number(store.get('a4', 440)) || 440)),
  targets: [],
  history: [],
  held: null,
  lastGoodAt: 0,
  displayCents: 0,
  displayed: null,          // { target, centsOff, freq }
  levelDb: -120,
  peakDb: -120,
  peakAt: 0,
  running: false,
  recovering: null,         // reason string while the engine is reconnecting
  showDiagnostics: new URLSearchParams(location.search).has('debug'),
  frameMark: { count: 0, at: 0, perSecond: 0 },
};

// --- setup -----------------------------------------------------------------

const dbToPercent = (db) =>
  Math.max(0, Math.min(100, ((db - LEVEL_MIN_DB) / -LEVEL_MIN_DB) * 100));

function buildTicks() {
  const frag = document.createDocumentFragment();
  for (let c = -50; c <= 50; c += 10) {
    if (c === 0) continue;              // the detent covers centre
    const tick = document.createElement('div');
    tick.className = `tick ${Math.abs(c) === 50 ? 'major' : 'minor'}`;
    tick.style.left = `${50 + c}%`;
    frag.appendChild(tick);
  }
  el.ticks.appendChild(frag);
  el.levelFloor.style.left = `${dbToPercent(LEVEL_FLOOR_DB)}%`;
}

function buildTuningOptions() {
  for (const [key, { label }] of Object.entries(TUNINGS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    el.tuning.appendChild(option);
  }
  el.tuning.value = state.tuningKey;
}

function refreshTargets() {
  state.targets = buildTargets(state.tuningKey, state.a4);
  state.held = null;
  state.history = [];
  el.strings.innerHTML = '';
  for (const target of state.targets) {
    const cell = document.createElement('div');
    cell.className = 'string';
    cell.dataset.on = 'false';
    cell.dataset.note = target.note;
    cell.textContent = target.label;
    el.strings.appendChild(cell);
  }
  el.a4.textContent = `A4 ${state.a4}`;
}

// --- detection stream ------------------------------------------------------

function onResult(msg) {
  // The level meter updates on every frame, detected pitch or not — it is the
  // only thing that can tell you the microphone is working but too quiet.
  const now = performance.now();
  state.levelDb = msg.rms > 0 ? 20 * Math.log10(msg.rms) : -120;
  if (state.levelDb > state.peakDb) {
    state.peakDb = state.levelDb;
    state.peakAt = now;
  }

  if (!msg.found || msg.clarity < CLARITY_MIN) return;

  state.history.push(msg.freq);
  if (state.history.length > HISTORY) state.history.shift();
  if (state.history.length < 3) return;

  const freq = median(state.history);
  const target = matchString(freq, state.targets, state.held);
  state.held = target;
  state.lastGoodAt = now;
  state.displayed = { target, centsOff: cents(freq, target.freq), freq };
}

// --- render ----------------------------------------------------------------

/** The meter spans +/-50 cents across the full track width. */
function moveNeedle(centsValue) {
  const halfWidth = el.needle.parentElement.clientWidth / 2;
  el.needle.style.transform = `translate(${(centsValue / 50) * halfWidth}px, -50%)`;
}

let lastFrameAt = performance.now();

function renderLevel(now, elapsedSec) {
  // Peak marker falls back at a fixed rate rather than snapping, so a single
  // pluck stays readable long enough to see how hard you hit it.
  state.peakDb = Math.max(state.levelDb, state.peakDb - PEAK_FALL_DB_PER_SEC * elapsedSec);

  const audible = state.levelDb > LEVEL_MIN_DB;
  el.levelFill.style.width = `${dbToPercent(state.levelDb)}%`;
  el.levelFill.dataset.hot = String(state.levelDb >= LEVEL_FLOOR_DB);
  el.levelPeak.style.left = `${dbToPercent(state.peakDb)}%`;
  el.levelPeak.style.opacity = state.peakDb > LEVEL_MIN_DB ? '0.45' : '0';
  el.levelDb.textContent = audible ? `${state.levelDb.toFixed(0)} dB` : '—';

  // Reconnecting takes priority: the screen is frozen for a real reason and
  // saying so beats letting it look broken.
  if (state.recovering) {
    el.hint.dataset.show = 'true';
    el.hint.textContent = 'Audio stopped — reconnecting…';
    return;
  }

  // Signal is arriving but nothing is being detected: say why.
  const starved = state.running
    && now - state.lastGoodAt > QUIET_HINT_AFTER_MS
    && state.peakDb < LEVEL_FLOOR_DB;
  el.hint.dataset.show = String(starved);
  if (starved) {
    el.hint.textContent = state.peakDb < -95
      ? 'No signal — is the right microphone selected?'
      : 'Too quiet to detect — move closer to the mic.';
  }
}

/**
 * Frames per second is the number that matters when something goes wrong:
 * a healthy pipeline delivers ~43/s, and zero means capture has died even
 * though the rest of the page looks fine.
 */
function renderDiagnostics(now) {
  if (!state.showDiagnostics) return;
  const mark = state.frameMark;
  if (now - mark.at >= 1000) {
    mark.perSecond = ((engine.frameCount - mark.count) * 1000) / (now - mark.at);
    mark.count = engine.frameCount;
    mark.at = now;
  }
  el.diag.textContent =
    `${mark.perSecond.toFixed(0)} frames/s · ${engine.frameCount} total · ` +
    `${engine.stallCount} stalls · ${engine.recoveryCount} recoveries · ` +
    `${engine.context ? engine.context.state : '—'} @ ${engine.context ? (engine.context.sampleRate / 1000).toFixed(1) : '—'} kHz`;
}

function clearReadout() {
  el.note.textContent = '–';
  el.cents.textContent = '';
  el.hz.textContent = '';
  for (const cell of el.strings.children) cell.dataset.on = 'false';
}

function render() {
  const now = performance.now();
  const elapsedSec = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  renderLevel(now, elapsedSec);
  renderDiagnostics(now);

  const active = state.displayed !== null && now - state.lastGoodAt < HOLD_MS;

  if (!active) {
    if (state.displayed && now - state.lastGoodAt > HOLD_MS * 3) {
      // Fully let go: clear the readout instead of leaving a stale note on
      // screen, which reads as the tuner having frozen.
      state.displayed = null;
      state.history = [];
      state.held = null;
      clearReadout();
    }
    el.body.dataset.active = 'false';
    el.body.dataset.tuned = 'false';
    state.displayCents += (0 - state.displayCents) * SMOOTHING;
    moveNeedle(state.displayCents);
    requestAnimationFrame(render);
    return;
  }

  const { target, centsOff, freq } = state.displayed;
  const tuned = Math.abs(centsOff) <= IN_TUNE_CENTS;

  el.body.dataset.active = 'true';
  el.body.dataset.tuned = String(tuned);

  el.note.innerHTML = `${target.label}<sub>${target.octave}</sub>`;
  el.cents.textContent = tuned
    ? 'in tune'
    : `${centsOff > 0 ? '+' : '−'}${Math.abs(centsOff).toFixed(1)} ¢`;
  el.hz.textContent = `${freq.toFixed(2)} Hz · target ${target.freq.toFixed(2)} Hz`;

  for (const cell of el.strings.children) {
    cell.dataset.on = String(cell.dataset.note === target.note);
  }

  const clamped = Math.max(-50, Math.min(50, centsOff));
  state.displayCents += (clamped - state.displayCents) * SMOOTHING;
  moveNeedle(state.displayCents);

  requestAnimationFrame(render);
}

// --- wiring ----------------------------------------------------------------

const engine = new TunerEngine({
  ...resolveSources(),
  onResult,
  onStateChange(engineState, detail) {
    state.running = engineState === 'running';
    state.recovering = engineState === 'recovering' ? (detail || 'reconnecting') : null;
    if (engineState === 'running') {
      el.overlay.hidden = true;
      state.lastGoodAt = performance.now();
    } else if (engineState === 'recovering') {
      // Leave the readout alone; the hint line explains what is happening.
    } else if (engineState === 'error') {
      el.overlay.hidden = false;
      el.start.textContent = 'Try again';
      el.status.textContent = detail;
      el.status.dataset.error = 'true';
    } else if (engineState === 'starting') {
      el.start.disabled = true;
      el.status.textContent = 'Waiting for microphone permission…';
    }
    if (engineState !== 'starting') el.start.disabled = false;
  },
});

el.start.addEventListener('click', () => engine.start());

// Tap the level bar to show pipeline diagnostics (or load with ?debug).
el.levelTrack.addEventListener('click', () => {
  state.showDiagnostics = !state.showDiagnostics;
  el.diag.hidden = !state.showDiagnostics;
});

if (location.protocol === 'file:') {
  el.status.textContent = 'Serve this over http:// — opening it straight from disk will not work.';
}

el.tuning.addEventListener('change', () => {
  state.tuningKey = el.tuning.value;
  store.set('tuning', state.tuningKey);
  refreshTargets();
});

function nudgeA4(delta) {
  state.a4 = Math.min(466, Math.max(415, state.a4 + delta));
  store.set('a4', String(state.a4));
  refreshTargets();
}
el.a4up.addEventListener('click', () => nudgeA4(1));
el.a4down.addEventListener('click', () => nudgeA4(-1));

el.diag.hidden = !state.showDiagnostics;
buildTicks();
buildTuningOptions();
refreshTargets();
requestAnimationFrame(render);

// Exposed for the end-to-end test harness.
window.__tuner = { state, engine };
