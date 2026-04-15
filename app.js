// app.js — orchestration for Hopfield.
// Owns the tick loop, the perturbation gesture, the settings panel, and
// the learn-mode interactions. Keeps network / audio / viz loosely coupled.

import {
  createNetwork, rebuildWeights, updateOnce, perturb, energy, isStable, reset,
  N, PITCH_NAMES, INTERVAL_NAMES, intervalIndex, weightBetween
} from './network.js';
import { Engine } from './audio.js';
import { Viz } from './viz.js';

// ---------- Options ----------

const options = {
  updateRateHz:       12,
  consonanceScale:    1.0,
  temperature:        0.25,
  reverb:             0.4,
  delay:              0.28,
  autoPerturbSeconds: 0,
  voicing:            'adaptive',     // 'adaptive' | 'chord' | 'arpeggio'
  arpRateHz:          6,
  volume:             0.75,
  learnMode:          false,
};

// ---------- Core state ----------

const net = createNetwork({ consonanceScale: options.consonanceScale });
const audio = new Engine();
const ctx = {
  net,
  energyHistory: [],
  learnMode: false,
  hoveredNode: null,
  hoveredEdge: null,
};

let viz;
let lastFrameMs = 0;
let updateAccumulator = 0;
let autoPerturbAccumulator = 0;
let paused = false;
let running = false;
let readoutClearTimer = null;

// Settledness tracking: 0 = freshly perturbed / chaotic, 1 = relaxed.
// Drives both the arp\u2192chord audio morph and the dormant-square fade.
const _prevState = new Float32Array(N);
let _settledness = 1.0;
let _msSinceLastPerturb = Infinity;

// ---------- Perturbation square (spring physics) ----------

const squish = {
  x: 0, y: 0, vx: 0, vy: 0,
  anchorX: 0, anchorY: 0,
  k: 40,
  c: 8,
  dragging: false,
  grabOffsetX: 0,
  grabOffsetY: 0,
  lastPointerX: 0,
  lastPointerY: 0,
  lastPointerT: 0,
  peakVelocity: 0,
  activePointerId: -1,
};

// ---------- DOM lookups ----------

const startOverlay = document.getElementById('start');
const vizContainer = document.getElementById('viz');
const squareEl     = document.getElementById('squish');
const readoutEl    = document.getElementById('readout');
const gearBtn      = document.getElementById('gear');
const helpBtn      = document.getElementById('help');
const settingsPanel= document.getElementById('settings-panel');
const learnPanel   = document.getElementById('learn-panel');
const stepBtn      = document.getElementById('step-btn');
const resumeBtn    = document.getElementById('resume-btn');
const resetBtn     = document.getElementById('reset-btn');

// ---------- Bootstrap ----------

function init() {
  viz = new Viz(vizContainer, ctx);
  viz.start();

  positionSquare(window.innerWidth * 0.62, window.innerHeight * 0.72);
  squish.anchorX = squish.x;
  squish.anchorY = squish.y;

  bindStart();
  bindSquish();
  bindPanels();
  bindSettings();
  bindLearn();
  bindVizTaps();

  window.addEventListener('resize', () => {
    squish.anchorX = Math.min(squish.anchorX, window.innerWidth  - 100);
    squish.anchorY = Math.min(squish.anchorY, window.innerHeight - 100);
    squish.anchorX = Math.max(20, squish.anchorX);
    squish.anchorY = Math.max(20, squish.anchorY);
  });
}

function bindStart() {
  // Must do the iOS unlock SYNCHRONOUSLY inside the event handler, before any
  // await. iOS Safari won't honor audio that was unlocked after an await
  // boundary — the browser stops associating it with the user gesture.
  let started = false;
  const start = (e) => {
    if (started) return;
    started = true;
    if (e) e.preventDefault();
    // 1. Synchronous unlock — plays a silent 1-sample buffer right now.
    audio.unlockSync();
    // 2. Fade overlay.
    startOverlay.classList.add('fade-out');
    setTimeout(() => startOverlay.style.display = 'none', 600);
    // 3. The rest (Tone.start, building the graph) can be async — the context
    //    is already unlocked so iOS is happy.
    (async () => {
      try {
        await audio.start();
        audio.setVolume(options.volume);
        audio.setReverb(options.reverb);
        audio.setDelay(options.delay);
        audio.setVoicing(options.voicing);
        audio.setArpRate(options.arpRateHz);
      } catch (err) {
        console.error('audio start failed', err);
      }
      running = true;
      lastFrameMs = performance.now();
      _prevState.set(net.state);
      requestAnimationFrame(tick);
    })();
  };
  // Listen for touch + pointer + click — on iOS, touchstart fires first and
  // is the most reliable gesture to attach audio unlock to.
  startOverlay.addEventListener('touchstart', start, { passive: false });
  startOverlay.addEventListener('pointerdown', start);
  startOverlay.addEventListener('click',       start);
}

// ---------- Main loop ----------

function tick(now) {
  const dtMs = Math.min(64, now - lastFrameMs);
  lastFrameMs = now;
  const dt = dtMs / 1000;

  audio.keepAwake();
  stepSpring(dt);

  if (!paused) {
    updateAccumulator += dtMs;
    const stepMs = 1000 / options.updateRateHz;
    while (updateAccumulator >= stepMs) {
      updateAccumulator -= stepMs;
      const info = updateOnce(net, { temperature: options.temperature, rate: 0.9 });
      viz.onStep(info);
      const delta = Math.abs(info.newValue - info.oldValue);
      if (delta > 0.15 && info.newValue > 0) audio.flash(info.index, Math.min(0.6, delta));
    }

    if (options.autoPerturbSeconds > 0) {
      autoPerturbAccumulator += dtMs;
      if (autoPerturbAccumulator >= options.autoPerturbSeconds * 1000) {
        autoPerturbAccumulator = 0;
        const bias = new Float32Array(N).fill(1);
        const eBefore = energy(net.state, net.weights);
        perturb(net, { magnitude: 0.3, bias });
        _msSinceLastPerturb = 0;
        _settledness = 0;
        squareEl.classList.add('dormant');
        flashReadout('auto-perturb', `\u0394E=+${(energy(net.state, net.weights) - eBefore).toFixed(2)}`);
      }
    }
  }

  updateSettledness(dtMs);
  audio.updateVoices(net.state, dtMs, _settledness);

  // The square re-emerges when things are calm and enough time has passed
  // since the last shake to feel like a deliberate return rather than a flicker.
  if (_settledness > 0.86 && _msSinceLastPerturb > 1200 && !squish.dragging) {
    squareEl.classList.remove('dormant');
  }
  _msSinceLastPerturb += dtMs;

  if (ctx.energyHistory.length === 0 || (now % 80) < dtMs) {
    ctx.energyHistory.push(energy(net.state, net.weights));
    if (ctx.energyHistory.length > 200) ctx.energyHistory.shift();
  }

  requestAnimationFrame(tick);
}

function updateSettledness(dtMs) {
  let delta = 0;
  for (let i = 0; i < N; i++) delta += Math.abs(net.state[i] - _prevState[i]);
  _prevState.set(net.state);
  const activity = delta / N;
  // Activity -> 0 means state not changing -> target settledness -> 1.
  const target = Math.exp(-activity * 22);
  // Smooth the estimate so the arp->chord morph and square fade don't jitter.
  const k = Math.min(1, dtMs / 180);
  _settledness = _settledness * (1 - k) + target * k;
}

// ---------- Perturbation square ----------

function positionSquare(x, y) {
  squish.x = x;
  squish.y = y;
  applySquareTransform();
}

function applySquareTransform() {
  const vx = squish.vx, vy = squish.vy;
  const speed = Math.hypot(vx, vy);
  const sx = 1 + Math.min(0.2, vx * 0.0008);
  const sy = 1 + Math.min(0.2, vy * 0.0008);
  const rot = (vx * 0.02);
  squareEl.style.transform =
    `translate(${squish.x}px, ${squish.y}px) rotate(${rot}deg) scale(${sx}, ${sy})`;
  squareEl.style.filter = speed > 400 ? `blur(${Math.min(3, speed / 800)}px)` : '';
}

function stepSpring(dt) {
  if (!squish.dragging) {
    const ax = -squish.k * (squish.x - squish.anchorX) - squish.c * squish.vx;
    const ay = -squish.k * (squish.y - squish.anchorY) - squish.c * squish.vy;
    squish.vx += ax * dt;
    squish.vy += ay * dt;
    squish.x += squish.vx * dt;
    squish.y += squish.vy * dt;
  }
  applySquareTransform();
}

function bindSquish() {
  // Mobile Safari's pointer events are flaky: sometimes pointermove never
  // fires after a touch pointerdown, or the pointerId silently changes
  // mid-drag. We handle BOTH pointer events (desktop, Android, non-touch iOS
  // Chrome) AND native touch events (iOS Safari primary path). Whichever
  // fires first wins; the other is ignored via the `squish.dragging` flag.

  const beginDrag = (clientX, clientY) => {
    if (squish.dragging) return;
    squish.dragging = true;
    squish.grabOffsetX = clientX - squish.x;
    squish.grabOffsetY = clientY - squish.y;
    squish.lastPointerX = clientX;
    squish.lastPointerY = clientY;
    squish.lastPointerT = performance.now();
    squish.peakVelocity = 0;
    squareEl.classList.add('grabbing');
    audio.noiseOn();
  };

  const updateDrag = (clientX, clientY) => {
    if (!squish.dragging) return;
    const t = performance.now();
    const ddt = Math.max(1, t - squish.lastPointerT);
    const nvx = (clientX - squish.lastPointerX) / (ddt / 1000);
    const nvy = (clientY - squish.lastPointerY) / (ddt / 1000);
    squish.vx = squish.vx * 0.6 + nvx * 0.4;
    squish.vy = squish.vy * 0.6 + nvy * 0.4;
    squish.x = clientX - squish.grabOffsetX;
    squish.y = clientY - squish.grabOffsetY;
    squish.lastPointerX = clientX;
    squish.lastPointerY = clientY;
    squish.lastPointerT = t;
    const speed = Math.hypot(squish.vx, squish.vy);
    if (speed > squish.peakVelocity) squish.peakVelocity = speed;

    const x01 = clamp01(squish.x / window.innerWidth);
    const y01 = clamp01(squish.y / window.innerHeight);
    const v01 = Math.min(1, speed / 2000);
    audio.setNoiseParams({ x: x01, y: y01, velocity: v01 });
    showDragReadout(x01, y01, speed);
  };

  const endDrag = () => {
    if (!squish.dragging) return;
    squish.dragging = false;
    squish.activePointerId = -1;
    squareEl.classList.remove('grabbing');
    audio.noiseOff();

    const x01 = clamp01(squish.x / window.innerWidth);
    const y01 = clamp01(squish.y / window.innerHeight);
    applyPerturbation(x01, y01, squish.peakVelocity);
  };

  // Shared state between pointer and touch paths so we can dedupe iOS, which
  // dispatches BOTH a synthetic pointerdown and a real touchstart for the
  // same finger. We let whichever fires first claim the drag and the other
  // short-circuits.
  let touchId = null;
  let ignoreNextPointer = false;

  // ---- Pointer event path (desktop + Android Chrome + non-touch iOS Chrome) ----
  const onPointerMove = (e) => {
    if (!squish.dragging || touchId != null) return;
    e.preventDefault();
    updateDrag(e.clientX, e.clientY);
  };
  const onPointerUp = (e) => {
    if (!squish.dragging) return;
    if (touchId != null) return; // touch path owns this drag
    endDrag();
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
  };
  squareEl.addEventListener('pointerdown', (e) => {
    // If a touch already claimed this drag, skip.
    if (ignoreNextPointer || touchId != null) {
      ignoreNextPointer = false;
      return;
    }
    e.preventDefault();
    squish.activePointerId = e.pointerId;
    beginDrag(e.clientX, e.clientY);
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
  });

  // ---- Touch event path (iOS Safari primary) ----
  // We track the identifier of the first touch that started the drag, ignore
  // other fingers until it ends.
  const findTouch = (touchList) => {
    for (let k = 0; k < touchList.length; k++) {
      if (touchList[k].identifier === touchId) return touchList[k];
    }
    return null;
  };
  const onTouchMove = (e) => {
    if (touchId == null) return;
    const tch = findTouch(e.touches);
    if (!tch) return;
    e.preventDefault();
    updateDrag(tch.clientX, tch.clientY);
  };
  const onTouchEnd = (e) => {
    if (touchId == null) return;
    // If our specific finger lifted, end the drag.
    const stillHeld = findTouch(e.touches);
    if (stillHeld) return;
    touchId = null;
    ignoreNextPointer = false; // clear in case no synthetic pointerdown ever arrived
    endDrag();
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchEnd);
  };
  squareEl.addEventListener('touchstart', (e) => {
    if (touchId != null) return;
    if (e.changedTouches.length === 0) return;
    const t = e.changedTouches[0];
    e.preventDefault();
    touchId = t.identifier;
    // Block the synthetic pointerdown that iOS Safari fires right after.
    ignoreNextPointer = true;
    beginDrag(t.clientX, t.clientY);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
  }, { passive: false });
}

function applyPerturbation(x01, y01, peakVelocity) {
  const magnitude = Math.min(1.2, 0.18 + peakVelocity / 1600);
  const bias = computeBias(x01, y01);
  const eBefore = energy(net.state, net.weights);
  perturb(net, { magnitude, bias });
  const eAfter = energy(net.state, net.weights);
  const dE = eAfter - eBefore;
  flashReadout(
    `shake`,
    `x=${x01.toFixed(2)}  y=${y01.toFixed(2)}  v=${Math.round(peakVelocity)}  \u0394E=${dE >= 0 ? '+' : ''}${dE.toFixed(2)}`
  );
  autoPerturbAccumulator = 0;
  _settledness = 0;
  _msSinceLastPerturb = 0;
  squareEl.classList.add('dormant');
}

function computeBias(x01, y01) {
  const center = x01 * N;
  const spread = 0.6 + y01 * 4.5;
  const bias = new Float32Array(N);
  let maxB = 0;
  for (let i = 0; i < N; i++) {
    const raw = Math.abs(i - center);
    const d = Math.min(raw, N - raw);
    const b = Math.exp(-(d * d) / (2 * spread * spread));
    bias[i] = b;
    if (b > maxB) maxB = b;
  }
  if (maxB > 0) for (let i = 0; i < N; i++) bias[i] /= maxB;
  return bias;
}

function showDragReadout(x01, y01, speed) {
  readoutEl.classList.add('visible');
  readoutEl.innerHTML =
    `<span class="key">x</span> ${x01.toFixed(2)}
     <span class="key">y</span> ${y01.toFixed(2)}
     <span class="key">v</span> ${Math.round(speed)}`;
  if (readoutClearTimer) { clearTimeout(readoutClearTimer); readoutClearTimer = null; }
}

function flashReadout(label, text) {
  readoutEl.classList.add('visible');
  readoutEl.innerHTML = `<span class="key">${label}</span> ${text}`;
  if (readoutClearTimer) clearTimeout(readoutClearTimer);
  readoutClearTimer = setTimeout(() => readoutEl.classList.remove('visible'), 1800);
}

// ---------- Panels (gear + help) ----------

function bindPanels() {
  gearBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    learnPanel.classList.remove('open');
    helpBtn.classList.remove('active');
    ctx.learnMode = false;
  });
  helpBtn.addEventListener('click', () => {
    const next = !ctx.learnMode;
    ctx.learnMode = next;
    learnPanel.classList.toggle('open', next);
    helpBtn.classList.toggle('active', next);
    settingsPanel.classList.remove('open');
  });
}

// ---------- Settings wiring ----------

function bindSettings() {
  const bind = (id, key, transform = (v) => +v, onChange = () => {}) => {
    const el = document.getElementById(id);
    if (!el) return;
    const initial = options[key];
    if (el.type === 'range' || el.type === 'number') el.value = initial;
    else if (el.tagName === 'SELECT') el.value = initial;
    el.addEventListener('input', () => {
      options[key] = transform(el.value);
      onChange(options[key]);
      updateSettingsLabels();
    });
  };

  bind('s-update-rate',   'updateRateHz');
  bind('s-consonance',    'consonanceScale', v => +v, v => rebuildWeights(net.weights, v));
  bind('s-temperature',   'temperature');
  bind('s-reverb',        'reverb',           v => +v, v => audio.setReverb(v));
  bind('s-delay',         'delay',            v => +v, v => audio.setDelay(v));
  bind('s-auto-perturb',  'autoPerturbSeconds');
  bind('s-arp-rate',      'arpRateHz',        v => +v, v => audio.setArpRate(v));
  bind('s-volume',        'volume',           v => +v, v => audio.setVolume(v));

  document.querySelectorAll('input[name="s-voicing"]').forEach(r => {
    r.checked = (r.value === options.voicing);
    r.addEventListener('change', () => {
      if (!r.checked) return;
      options.voicing = r.value;
      audio.setVoicing(r.value);
    });
  });

  // Default update-rate slider reflects the higher default now.
  const urEl = document.getElementById('s-update-rate');
  if (urEl) urEl.value = options.updateRateHz;

  resetBtn.addEventListener('click', () => {
    reset(net);
    ctx.energyHistory = [];
    _settledness = 0;
    _msSinceLastPerturb = 0;
    squareEl.classList.add('dormant');
  });

  updateSettingsLabels();
}

function updateSettingsLabels() {
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('v-update-rate',   `${options.updateRateHz} Hz`);
  setText('v-consonance',    options.consonanceScale.toFixed(2));
  setText('v-temperature',   options.temperature.toFixed(2));
  setText('v-reverb',        options.reverb.toFixed(2));
  setText('v-delay',         options.delay.toFixed(2));
  setText('v-auto-perturb',  options.autoPerturbSeconds === 0 ? 'off' : `${options.autoPerturbSeconds}s`);
  setText('v-arp-rate',      `${options.arpRateHz} Hz`);
  setText('v-volume',        `${Math.round(options.volume * 100)}%`);
}

// ---------- Learn mode ----------

function bindLearn() {
  stepBtn.addEventListener('click', () => {
    paused = true;
    const info = updateOnce(net, { temperature: options.temperature, rate: 1.0 });
    viz.onStep(info);
    if (Math.abs(info.newValue - info.oldValue) > 0.1 && info.newValue > 0) {
      audio.flash(info.index, 0.5);
    }
    const learnInfo = document.getElementById('learn-step-info');
    if (learnInfo) {
      learnInfo.textContent =
        `updated ${PITCH_NAMES[info.index]}: ` +
        `h = ${info.field.toFixed(2)}, ` +
        `s: ${info.oldValue.toFixed(2)} \u2192 ${info.newValue.toFixed(2)}`;
    }
  });
  resumeBtn.addEventListener('click', () => { paused = false; });
}

function bindVizTaps() {
  vizContainer.addEventListener('pointermove', (e) => {
    if (!ctx.learnMode) { ctx.hoveredEdge = null; ctx.hoveredNode = null; return; }
    const r = vizContainer.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    ctx.hoveredNode = viz.nodeAt(x, y);
    ctx.hoveredEdge = ctx.hoveredNode == null ? viz.edgeAt(x, y) : null;
  });
  vizContainer.addEventListener('pointerleave', () => {
    ctx.hoveredNode = null; ctx.hoveredEdge = null;
  });
}

// ---------- Utils ----------

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// ---------- Go ----------

init();
