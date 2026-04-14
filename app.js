// app.js — orchestration for Hopfield Harmonics.
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
  updateRateHz:       8,
  consonanceScale:    1.0,
  temperature:        0.25,
  reverb:             0.4,
  delay:              0.28,
  autoPerturbSeconds: 0,
  arpeggiate:         'chord',       // 'chord' | 'arpeggio'
  arpRateHz:          5,
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

// ---------- Perturbation square (spring physics) ----------

const squish = {
  x: 0, y: 0, vx: 0, vy: 0,
  anchorX: 0, anchorY: 0,
  k: 40,             // spring stiffness
  c: 8,              // damping
  dragging: false,
  grabOffsetX: 0,
  grabOffsetY: 0,
  lastPointerX: 0,
  lastPointerY: 0,
  lastPointerT: 0,
  peakVelocity: 0,
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
    const nx = Math.min(squish.x, window.innerWidth - 100);
    const ny = Math.min(squish.y, window.innerHeight - 100);
    squish.anchorX = Math.max(20, nx);
    squish.anchorY = Math.max(20, ny);
  });
}

function bindStart() {
  const start = async () => {
    startOverlay.classList.add('fade-out');
    setTimeout(() => startOverlay.style.display = 'none', 600);
    try {
      await audio.start();
      audio.setVolume(options.volume);
      audio.setReverb(options.reverb);
      audio.setDelay(options.delay);
      audio.setMode(options.arpeggiate);
      audio.setArpRate(options.arpRateHz);
    } catch (err) {
      console.error('audio start failed', err);
    }
    running = true;
    lastFrameMs = performance.now();
    requestAnimationFrame(tick);
  };
  startOverlay.addEventListener('pointerdown', start, { once: true });
}

// ---------- Main loop ----------

function tick(now) {
  const dtMs = Math.min(64, now - lastFrameMs);
  lastFrameMs = now;
  const dt = dtMs / 1000;

  stepSpring(dt);

  // Network updates — N updates per "iteration" so each tick roughly touches every node.
  if (!paused) {
    updateAccumulator += dtMs;
    const stepMs = 1000 / options.updateRateHz;
    while (updateAccumulator >= stepMs) {
      updateAccumulator -= stepMs;
      const info = updateOnce(net, { temperature: options.temperature, rate: 0.9 });
      viz.onStep(info);
      // Flash the audio voice if the node meaningfully changed its on-ness.
      const delta = Math.abs(info.newValue - info.oldValue);
      if (delta > 0.15 && info.newValue > 0) audio.flash(info.index, Math.min(0.6, delta));
    }

    // Auto-perturb timer (0 = off).
    if (options.autoPerturbSeconds > 0) {
      autoPerturbAccumulator += dtMs;
      if (autoPerturbAccumulator >= options.autoPerturbSeconds * 1000) {
        autoPerturbAccumulator = 0;
        const bias = new Float32Array(N).fill(1);
        perturb(net, { magnitude: 0.3, bias });
        flashReadout('auto-perturb', '+\u03c3 = 0.30');
      }
    }
  }

  audio.updateVoices(net.state, dtMs);

  // Track energy history every ~80ms.
  if (ctx.energyHistory.length === 0 || (now % 80) < dtMs) {
    ctx.energyHistory.push(energy(net.state, net.weights));
    if (ctx.energyHistory.length > 200) ctx.energyHistory.shift();
  }

  requestAnimationFrame(tick);
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
  squareEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    squish.dragging = true;
    squish.grabOffsetX = e.clientX - squish.x;
    squish.grabOffsetY = e.clientY - squish.y;
    squish.lastPointerX = e.clientX;
    squish.lastPointerY = e.clientY;
    squish.lastPointerT = performance.now();
    squish.peakVelocity = 0;
    squareEl.setPointerCapture(e.pointerId);
    squareEl.classList.add('grabbing');
    audio.noiseOn();
  });

  squareEl.addEventListener('pointermove', (e) => {
    if (!squish.dragging) return;
    const t = performance.now();
    const ddt = Math.max(1, t - squish.lastPointerT);
    const nvx = (e.clientX - squish.lastPointerX) / (ddt / 1000);
    const nvy = (e.clientY - squish.lastPointerY) / (ddt / 1000);
    // Exponential smoothing so velocity reads aren't jittery.
    squish.vx = squish.vx * 0.6 + nvx * 0.4;
    squish.vy = squish.vy * 0.6 + nvy * 0.4;
    squish.x = e.clientX - squish.grabOffsetX;
    squish.y = e.clientY - squish.grabOffsetY;
    squish.lastPointerX = e.clientX;
    squish.lastPointerY = e.clientY;
    squish.lastPointerT = t;
    const speed = Math.hypot(squish.vx, squish.vy);
    if (speed > squish.peakVelocity) squish.peakVelocity = speed;

    const x01 = clamp01(squish.x / window.innerWidth);
    const y01 = clamp01(squish.y / window.innerHeight);
    const v01 = Math.min(1, speed / 2000);
    audio.setNoiseParams({ x: x01, y: y01, velocity: v01 });
    showDragReadout(x01, y01, speed);
  });

  const release = (e) => {
    if (!squish.dragging) return;
    squish.dragging = false;
    squareEl.classList.remove('grabbing');
    try { squareEl.releasePointerCapture(e.pointerId); } catch {}
    audio.noiseOff();

    const x01 = clamp01(squish.x / window.innerWidth);
    const y01 = clamp01(squish.y / window.innerHeight);
    const peak = squish.peakVelocity;
    applyPerturbation(x01, y01, peak);
  };

  squareEl.addEventListener('pointerup', release);
  squareEl.addEventListener('pointercancel', release);
}

function applyPerturbation(x01, y01, peakVelocity) {
  const magnitude = Math.min(1.2, 0.15 + peakVelocity / 1600);
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
}

function computeBias(x01, y01) {
  // x picks a center pitch (around the chromatic circle); y widens the
  // perturbation — low y = targeted disturbance, high y = broad shake.
  const center = x01 * N;
  const spread = 0.6 + y01 * 4.5;
  const bias = new Float32Array(N);
  let maxB = 0;
  for (let i = 0; i < N; i++) {
    const raw = Math.abs(i - center);
    const d = Math.min(raw, N - raw);                 // wrap-around distance
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

  // Chord / arpeggio radios.
  document.querySelectorAll('input[name="s-arpeggiate"]').forEach(r => {
    r.checked = (r.value === options.arpeggiate);
    r.addEventListener('change', () => {
      if (!r.checked) return;
      options.arpeggiate = r.value;
      audio.setMode(r.value);
    });
  });

  resetBtn.addEventListener('click', () => {
    reset(net);
    ctx.energyHistory = [];
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
