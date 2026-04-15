// viz.js — p5.js sketch for Hopfield.
// Draws 12 nodes on a circle, connected by edges whose brightness tracks
// |weight| and whose warmth tracks sign(weight). A subtle field of drifting
// equation fragments sits behind everything. Nodes glow based on their
// activation, and the most recently updated node pulses briefly.

import { N, PITCH_NAMES, INTERVAL_NAMES, intervalIndex, weightBetween } from './network.js';

const p5Lib = window.p5;

// Map pitch class -> hue via circle-of-fifths ordering, so consonant
// neighbours (fifths, fourths) end up in adjacent hues.
function pitchHue(i) {
  const pos = (i * 7) % N;
  return (pos / N) * 360;
}

const EQUATION_FRAGMENTS = [
  'E = \u2212\u00bd \u03a3\u03a3 W\u1d62\u2c7c s\u1d62 s\u2c7c',
  's\u1d62 \u2190 tanh(\u03a3 W\u1d62\u2c7c s\u2c7c / T)',
  'h\u1d62 = \u03a3\u2c7c W\u1d62\u2c7c s\u2c7c',
  '\u0394E \u2264 0',
  'W\u1d62\u2c7c = W\u2c7c\u1d62',
  'W\u1d62\u1d62 = 0',
  'attractor \u2192 local min',
  's \u2208 [\u22121, 1]\u00b9\u00b2',
  'T \u2192 0  \u21d2  s \u2192 sign(h)',
  'perturb \u2192 escape basin',
];

export class Viz {
  constructor(containerEl, ctx) {
    this.containerEl = containerEl;
    this.ctx = ctx;                 // shared: { net, energyHistory, learnMode, showSpectrogram, hoveredNode, hoveredEdge, overlay }
    this.pulses = new Float32Array(N); // 1.0 when a node just updated, decays
    this.lastUpdatedIndex = -1;
    this.fragments = [];
    this.sketch = null;
    this.nodePositions = new Array(N);
    this.radius = 0;
    this.cx = 0;
    this.cy = 0;
    this.nodeRadius = 0;
  }

  start() {
    const s = (p) => {
      p.setup = () => {
        const c = p.createCanvas(this.containerEl.clientWidth, this.containerEl.clientHeight);
        c.parent(this.containerEl);
        p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
        p.textFont('ui-monospace, "SF Mono", Menlo, monospace');
        this._seedFragments(p);
        this._recomputeLayout(p);
      };

      p.windowResized = () => {
        p.resizeCanvas(this.containerEl.clientWidth, this.containerEl.clientHeight);
        this._recomputeLayout(p);
      };

      p.draw = () => {
        p.clear();
        p.background(10, 12, 18);

        this._drawFragments(p);
        this._drawEdges(p);
        this._drawNodes(p);
        if (this.ctx.learnMode) this._drawLearnOverlay(p);
        this._drawEnergyTrail(p);

        // Decay pulses and recent-update highlight.
        for (let i = 0; i < N; i++) this.pulses[i] *= 0.92;
      };
    };

    this.sketch = new p5Lib(s, this.containerEl);
  }

  // Let app.js notify us that node `index` just updated in the network.
  onStep(info) {
    this.pulses[info.index] = 1.0;
    this.lastUpdatedIndex = info.index;
  }

  // Hit-testing for taps/clicks in learn mode. Returns node index or null.
  nodeAt(x, y) {
    for (let i = 0; i < N; i++) {
      const pos = this.nodePositions[i];
      if (!pos) continue;
      const dx = x - pos.x, dy = y - pos.y;
      if (dx * dx + dy * dy <= this.nodeRadius * this.nodeRadius * 1.6) return i;
    }
    return null;
  }

  // Returns { i, j } or null for the closest edge under the point within a tolerance.
  edgeAt(x, y, tol = 8) {
    let best = null, bestDist = tol;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = this.nodePositions[i], b = this.nodePositions[j];
        const d = pointToSegment(x, y, a.x, a.y, b.x, b.y);
        if (d < bestDist) { bestDist = d; best = { i, j }; }
      }
    }
    return best;
  }

  // ---- Internals ----

  _recomputeLayout(p) {
    this.cx = p.width / 2;
    this.cy = p.height / 2;
    this.radius = Math.min(p.width, p.height) * 0.36;
    this.nodeRadius = Math.max(14, Math.min(p.width, p.height) * 0.035);
    for (let i = 0; i < N; i++) {
      // Start at 12 o'clock and go clockwise — C at top, ascending.
      const angle = -Math.PI / 2 + (i / N) * Math.PI * 2;
      this.nodePositions[i] = {
        x: this.cx + Math.cos(angle) * this.radius,
        y: this.cy + Math.sin(angle) * this.radius,
        angle,
      };
    }
  }

  _seedFragments(p) {
    this.fragments = [];
    const count = 8;
    for (let k = 0; k < count; k++) {
      this.fragments.push({
        text: EQUATION_FRAGMENTS[k % EQUATION_FRAGMENTS.length],
        x: Math.random() * p.width,
        y: Math.random() * p.height,
        vx: (Math.random() * 2 - 1) * 0.25,
        vy: (Math.random() * 2 - 1) * 0.15,
        phase: Math.random() * Math.PI * 2,
        size: 11 + Math.random() * 5,
      });
    }
  }

  _drawFragments(p) {
    p.noStroke();
    for (const f of this.fragments) {
      f.x += f.vx;
      f.y += f.vy;
      f.phase += 0.005;
      if (f.x < -200) f.x = p.width + 100;
      if (f.x > p.width + 200) f.x = -100;
      if (f.y < -50) f.y = p.height + 50;
      if (f.y > p.height + 50) f.y = -50;
      // Alpha breathes slowly, peaking around ~8% opacity.
      const a = 25 + 20 * Math.sin(f.phase);
      p.fill(180, 200, 230, a);
      p.textSize(f.size);
      p.text(f.text, f.x, f.y);
    }
  }

  _drawEdges(p) {
    const { net } = this.ctx;
    if (!net) return;
    const state = net.state;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const w = weightBetween(net, i, j);
        if (Math.abs(w) < 0.02) continue;
        const a = this.nodePositions[i], b = this.nodePositions[j];
        const s = Math.abs(w);                   // 0..1
        // Reinforce edges that are currently "satisfied" — consonant edge
        // between two co-positive nodes, or dissonant edge between opposite-
        // sign nodes. Satisfaction = -W * s_i * s_j (negative contribution
        // to energy is positive satisfaction).
        const sat = -w * state[i] * state[j];
        const activity = Math.max(0, sat);        // 0..1-ish
        const alpha = Math.min(220, 30 + s * 100 + activity * 120);
        const hue = w > 0 ? 35 : 210;            // amber vs cyan
        p.colorMode(p.HSL, 360, 100, 100, 255);
        p.stroke(hue, 80, 55 + activity * 20, alpha);
        p.strokeWeight(0.6 + s * 1.8 + activity * 1.4);
        p.line(a.x, a.y, b.x, b.y);
        p.colorMode(p.RGB, 255, 255, 255, 255);
      }
    }
  }

  _drawNodes(p) {
    const { net } = this.ctx;
    if (!net) return;
    const state = net.state;
    for (let i = 0; i < N; i++) {
      const pos = this.nodePositions[i];
      const a = state[i];                          // -1..1
      const pos01 = Math.max(0, a);                // "on-ness"
      const neg01 = Math.max(0, -a);               // "anti-on-ness"
      const hue = pitchHue(i);
      const pulse = this.pulses[i];

      const baseSize = this.nodeRadius * (1 + pos01 * 0.45 + pulse * 0.3);
      const glow = 10 + pos01 * 60 + pulse * 40;

      p.colorMode(p.HSL, 360, 100, 100, 255);
      // Soft outer glow — positive activation paints colour, negative paints a dark cool ring.
      p.drawingContext.shadowBlur = glow;
      p.drawingContext.shadowColor = pos01 > 0.05
        ? `hsla(${hue}, 90%, 65%, ${0.35 + pos01 * 0.5})`
        : `hsla(220, 30%, 40%, ${0.15 + neg01 * 0.3})`;

      // Core fill — blend between cool grey (negative) and hue-saturated (positive).
      const sat = 10 + pos01 * 70;
      const light = 25 + pos01 * 45 - neg01 * 10;
      p.noStroke();
      p.fill(hue, sat, light, 255);
      p.ellipse(pos.x, pos.y, baseSize * 2);

      // Inner highlight
      p.drawingContext.shadowBlur = 0;
      p.fill(hue, 30, 90, 40 + pos01 * 100);
      p.ellipse(pos.x - baseSize * 0.2, pos.y - baseSize * 0.25, baseSize * 0.8);

      // Pitch label only in learn mode, or always for the currently pulsing node.
      if (this.ctx.learnMode || pulse > 0.35) {
        p.fill(230, 10, 95, 220);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(Math.max(10, baseSize * 0.55));
        p.text(PITCH_NAMES[i], pos.x, pos.y);
      }

      p.colorMode(p.RGB, 255, 255, 255, 255);
    }
  }

  _drawLearnOverlay(p) {
    const hi = this.ctx.hoveredEdge;
    if (!hi) return;
    const a = this.nodePositions[hi.i];
    const b = this.nodePositions[hi.j];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const iv = intervalIndex(hi.i, hi.j);
    const w = weightBetween(this.ctx.net, hi.i, hi.j);
    const label = `${INTERVAL_NAMES[iv]}   w = ${w >= 0 ? '+' : ''}${w.toFixed(2)}`;
    p.noStroke();
    p.fill(10, 14, 22, 220);
    p.rectMode(p.CENTER);
    p.rect(mx, my, p.textWidth(label) + 16, 22, 6);
    p.fill(230, 235, 245, 240);
    p.textSize(12);
    p.textAlign(p.CENTER, p.CENTER);
    p.text(label, mx, my);
  }

  _drawEnergyTrail(p) {
    const hist = this.ctx.energyHistory;
    if (!hist || hist.length < 2) return;
    // Rolling plot down in the bottom-left corner, very muted.
    const w = Math.min(220, p.width * 0.25);
    const h = 36;
    const x0 = 20, y0 = p.height - 20 - h;
    let min = Infinity, max = -Infinity;
    for (const e of hist) { if (e < min) min = e; if (e > max) max = e; }
    const span = Math.max(0.001, max - min);
    p.noFill();
    p.stroke(180, 210, 255, 90);
    p.strokeWeight(1.2);
    p.beginShape();
    for (let k = 0; k < hist.length; k++) {
      const xx = x0 + (k / (hist.length - 1)) * w;
      const yy = y0 + h - ((hist[k] - min) / span) * h;
      p.vertex(xx, yy);
    }
    p.endShape();
    p.noStroke();
    p.fill(180, 210, 255, 120);
    p.textSize(10);
    p.textAlign(p.LEFT, p.TOP);
    p.text('energy', x0, y0 - 14);
  }
}

function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}
