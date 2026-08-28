// UI state and rendering.

import { TunerEngine } from './audio.js';
import { resolveSources } from './sources.js';
import { TUNINGS, buildTargets, cents, matchString, median } from './music.js';

const IN_TUNE_CENTS = 5;      // green window
const HOLD_MS = 600;          // keep the last reading on screen this long after a note dies
const CLARITY_MIN = 0.85;     // reject weak / non-periodic frames
const HISTORY = 5;            // median filter length
const SMOOTHING = 0.25;       // needle easing per frame

const el = {
  body: document.body,
  note: document.getElementById('note'),
  cents: document.getElementById('cents'),
  hz: document.getElementById('hz'),
  needle: document.getElementById('needle'),
  ticks: document.getElementById('ticks'),
  strings: document.getElementById('strings'),
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
};

// --- setup -----------------------------------------------------------------

function buildTicks() {
  const frag = document.createDocumentFragment();
  for (let c = -50; c <= 50; c += 10) {
    const tick = document.createElement('div');
    tick.className = `tick ${c % 50 === 0 ? 'major' : 'minor'}`;
    tick.style.left = `${50 + c}%`;
    if (c === 0) continue;      // the detent covers centre
    frag.appendChild(tick);
  }
  el.ticks.appendChild(frag);
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
  if (!msg.found || msg.clarity < CLARITY_MIN) return;

  state.history.push(msg.freq);
  if (state.history.length > HISTORY) state.history.shift();
  if (state.history.length < 3) return;

  const freq = median(state.history);
  const target = matchString(freq, state.targets, state.held);
  state.held = target;
  state.lastGoodAt = performance.now();
  state.displayed = { target, centsOff: cents(freq, target.freq), freq };
}

// --- render ----------------------------------------------------------------

/** The meter spans +/-50 cents across the full track width. */
function moveNeedle(centsValue) {
  const halfWidth = el.needle.parentElement.clientWidth / 2;
  el.needle.style.transform = `translate(${(centsValue / 50) * halfWidth}px, -50%)`;
}

function render() {
  const active = state.displayed !== null && performance.now() - state.lastGoodAt < HOLD_MS;

  if (!active) {
    if (state.displayed && performance.now() - state.lastGoodAt > HOLD_MS * 3) {
      state.history = [];
      state.held = null;
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
    if (engineState === 'running') {
      el.overlay.hidden = true;
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

buildTicks();
buildTuningOptions();
refreshTargets();
requestAnimationFrame(render);

// Exposed for the end-to-end test harness.
window.__tuner = { state, engine };
