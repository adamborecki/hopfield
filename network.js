// network.js — Hopfield network core.
// 12 pitch-class nodes, continuous-valued activations in [-1, 1] via tanh update.
// Weights come from a consonance table indexed by |i - j| mod 12, so consonant
// intervals pull nodes toward matching signs (co-activation) and dissonant
// intervals push them apart. Stable attractors therefore tend to be chords.

export const N = 12;
export const PITCH_NAMES = ['C', 'C\u266f', 'D', 'D\u266f', 'E', 'F', 'F\u266f', 'G', 'G\u266f', 'A', 'A\u266f', 'B'];

// Consonance weights for interval |i - j| mod 12. Starting point from spec;
// tune by ear. Negative = dissonant (repulsive), positive = consonant (attractive).
const CONSONANCE_TABLE = [
   0.0, // 0  unison (diagonal is zeroed out anyway)
  -1.0, // 1  minor 2nd
  -0.3, // 2  major 2nd
   0.6, // 3  minor 3rd
   0.8, // 4  major 3rd
   0.9, // 5  perfect 4th
  -0.8, // 6  tritone
   1.0, // 7  perfect 5th
   0.6, // 8  minor 6th
   0.7, // 9  major 6th
  -0.2, // 10 minor 7th
  -0.7, // 11 major 7th
];

export const INTERVAL_NAMES = [
  'unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd',
  'perfect 4th', 'tritone', 'perfect 5th', 'minor 6th', 'major 6th',
  'minor 7th', 'major 7th'
];

export function createNetwork({ consonanceScale = 1.0 } = {}) {
  const state = new Float32Array(N);
  const weights = new Float32Array(N * N);
  for (let i = 0; i < N; i++) state[i] = (Math.random() * 2 - 1) * 0.2;
  rebuildWeights(weights, consonanceScale);
  return { state, weights, consonanceScale };
}

export function rebuildWeights(weights, consonanceScale) {
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) {
        weights[i * N + j] = 0;
      } else {
        const d = Math.abs(i - j) % N;
        weights[i * N + j] = CONSONANCE_TABLE[d] * consonanceScale;
      }
    }
  }
}

// E = -0.5 * sum_{i,j} W[i][j] * s[i] * s[j]
// Under asynchronous tanh updates with zero diagonal this is a Lyapunov
// function — it monotonically decreases as the network relaxes (ignoring noise).
export function energy(state, weights) {
  let E = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      E += weights[i * N + j] * state[i] * state[j];
    }
  }
  return -0.5 * E;
}

// Local field on node i: h_i = sum_j W[i][j] * s[j]
export function localField(net, i) {
  const { state, weights } = net;
  let h = 0;
  for (let j = 0; j < N; j++) h += weights[i * N + j] * state[j];
  return h;
}

// Update a single node (async rule). Blends toward tanh(h/T) by `rate` in (0, 1].
// rate = 1 is full replacement; smaller rates give smoother animation/audio.
// Returns info the caller can use to drive visuals/audio/learn mode.
export function updateOnce(net, { temperature = 0.3, rate = 1.0, nodeIndex = null } = {}) {
  const { state } = net;
  const i = nodeIndex == null ? Math.floor(Math.random() * N) : nodeIndex;
  const h = localField(net, i);
  const T = Math.max(0.01, temperature);
  const target = Math.tanh(h / T);
  const oldVal = state[i];
  const newVal = oldVal + (target - oldVal) * Math.min(1, Math.max(0, rate));
  state[i] = newVal;
  return { index: i, oldValue: oldVal, newValue: newVal, target, field: h };
}

// Add Gaussian noise to node states, optionally biased per-node.
// `bias` is an array of length N with values in [0, 1] — 0 means "leave alone".
// Returns a list of {index, before, after, delta} describing the injection.
export function perturb(net, { magnitude = 0.5, bias = null } = {}) {
  const { state } = net;
  const injections = [];
  for (let i = 0; i < N; i++) {
    const w = bias ? bias[i] : 1;
    const noise = gaussian() * magnitude * w;
    const before = state[i];
    const after = clamp(state[i] + noise, -1, 1);
    state[i] = after;
    injections.push({ index: i, before, after, delta: after - before });
  }
  return injections;
}

// Re-randomize state (used by the reset button in settings).
export function reset(net, { spread = 0.2 } = {}) {
  for (let i = 0; i < N; i++) net.state[i] = (Math.random() * 2 - 1) * spread;
}

// Fixed-point test: is each node close to tanh(h/T) already?
export function isStable(net, { threshold = 0.02, temperature = 0.3 } = {}) {
  const { state } = net;
  const T = Math.max(0.01, temperature);
  for (let i = 0; i < N; i++) {
    const target = Math.tanh(localField(net, i) / T);
    if (Math.abs(target - state[i]) > threshold) return false;
  }
  return true;
}

export function intervalIndex(i, j) {
  return Math.abs(i - j) % N;
}

export function intervalName(i, j) {
  return INTERVAL_NAMES[intervalIndex(i, j)];
}

export function weightBetween(net, i, j) {
  return net.weights[i * N + j];
}

// Box-Muller Gaussian sample.
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
