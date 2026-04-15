// audio.js — Tone.js engine for Hopfield.
// 12 sustained voices, algorithmic reverb (Freeverb — no IR generation, which
// avoids the iOS offline-render hang that Tone.Reverb can trigger), a gesture
// noise layer, a unified voicing model that crossfades between plucked
// arpeggio and sustained chord as the network settles, and a Limiter before
// Destination so 12 voices summing doesn't clip.

import { N } from './network.js';

const Tone = window.Tone;

export class Engine {
  constructor() {
    this.started = false;
    this.voices = [];
    this.voicing = 'adaptive';         // 'adaptive' | 'chord' | 'arpeggio'
    this.arpRate = 6;                  // Hz
    this._arpIndex = 0;
    this._arpAccumulator = 0;
    this._pluckAmp = new Float32Array(N);
    this.flashIntensity = new Float32Array(N);
    this._noiseActive = false;
  }

  // Synchronous iOS unlock. Must be called from inside the user-gesture event
  // handler BEFORE any await — otherwise iOS Safari treats the resulting
  // AudioContext as "not user-initiated" and silently refuses to play sound.
  // Plays a single-sample silent buffer on the raw WebAudio context; that's
  // the classic iOS unlock pattern, robust across Safari/Chrome/Firefox iOS.
  unlockSync() {
    try {
      const ctx = Tone.context.rawContext || Tone.context;
      if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
        ctx.resume();
      }
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      if (typeof src.start === 'function') src.start(0); else src.noteOn(0);
    } catch (e) {
      console.warn('unlockSync failed', e);
    }
  }

  async start() {
    if (this.started) return;
    // Tone.start() is idempotent and fast once the context has been unlocked
    // synchronously above. Still await it to be sure the Transport is ready.
    await Tone.start();
    try { await Tone.context.resume(); } catch {}

    // Limiter at -3 dB prevents the 12-voice summing bus from clipping under
    // peak activations or delay feedback pileups. This was the laptop distortion.
    this.limiter = new Tone.Limiter(-3).toDestination();
    this.master = new Tone.Gain(0.6).connect(this.limiter);

    // Algorithmic reverb. No `await ready` — unlike Tone.Reverb, Freeverb has
    // no offline IR render, so it works reliably on iOS.
    this.reverb = new Tone.Freeverb({
      roomSize: 0.85,
      dampening: 3200,
      wet: 0.4,
    }).connect(this.master);

    this.delay = new Tone.FeedbackDelay({
      delayTime: 0.42,
      feedback: 0.32,
      wet: 0.22,
    }).connect(this.reverb);

    // Per-voice budget: 12 voices × max ~0.45 = ~5.4 peak. Voice-bus gain
    // scales that to ~0.9 going into the effects + limiter chain.
    this.voiceBus = new Tone.Gain(0.16).connect(this.delay);

    const baseNote = 'C4';
    for (let i = 0; i < N; i++) {
      const freq = Tone.Frequency(baseNote).transpose(i).toFrequency();
      const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' });
      osc.detune.value = (Math.random() - 0.5) * 4;
      const gain = new Tone.Gain(0).connect(this.voiceBus);
      osc.connect(gain);
      osc.start();
      this.voices.push({ osc, gain, freq });
    }

    // Gesture noise layer.
    this.noise = new Tone.Noise('pink');
    this.noiseFilter = new Tone.Filter({ type: 'bandpass', frequency: 800, Q: 1.5 });
    this.noiseGain = new Tone.Gain(0).connect(this.reverb);
    this.noise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noise.start();

    // Prime tone — a quiet brief blip confirms the pipeline is wired. On iOS
    // this also forces the context to actually render a sample right away.
    const blip = new Tone.Oscillator({ frequency: 196, type: 'sine' }).connect(this.master);
    const t = Tone.now();
    blip.volume.value = -80;
    blip.start(t);
    blip.volume.linearRampToValueAtTime(-24, t + 0.04);
    blip.volume.linearRampToValueAtTime(-80, t + 0.7);
    blip.stop(t + 0.8);

    this.started = true;
    console.log('[audio] started. ctx state:', Tone.context.state, 'sampleRate:', Tone.context.sampleRate);
  }

  // iOS can re-suspend the audio context after a silent stretch. A tick from
  // app.js's loop nudges it back awake. Safe to call every frame — no-op if
  // already running.
  keepAwake() {
    if (!this.started) return;
    if (Tone.context.state !== 'running') {
      Tone.context.resume().catch(() => {});
    }
  }

  setVolume(v)   { if (this.master) this.master.gain.rampTo(v * 0.8, 0.1); }
  setReverb(amt) { if (this.reverb) this.reverb.wet.rampTo(amt, 0.2); }
  setDelay(amt)  { if (this.delay)  this.delay.wet.rampTo(amt, 0.2); }
  setVoicing(v)  { this.voicing = v; this._arpIndex = 0; this._arpAccumulator = 0; }
  setArpRate(hz) { this.arpRate = Math.max(0.25, hz); }

  // settledness \u2208 [0, 1]: 0 = freshly perturbed / chaotic, 1 = fully relaxed.
  // App.js computes it from recent state change and passes it in every frame.
  updateVoices(state, dtMs, settledness = 1.0) {
    if (!this.started) return;

    const active = [];
    for (let i = 0; i < N; i++) if (state[i] > 0.15) active.push(i);

    // Advance arpeggio step.
    this._arpAccumulator += dtMs;
    const stepMs = 1000 / this.arpRate;
    let justPicked = -1;
    if (this._arpAccumulator >= stepMs) {
      this._arpAccumulator -= stepMs;
      if (active.length > 0) {
        justPicked = active[this._arpIndex % active.length];
        this._arpIndex++;
      }
    }

    // Decay any pluck envelopes currently ringing.
    const decay = Math.exp(-dtMs / 140);
    for (let i = 0; i < N; i++) this._pluckAmp[i] *= decay;
    if (justPicked >= 0) {
      this._pluckAmp[justPicked] = 0.6 * Math.pow(Math.max(0, state[justPicked]), 0.8);
    }

    // Decide chord vs arp mix.
    let chordW, arpW;
    if (this.voicing === 'chord')         { chordW = 1; arpW = 0; }
    else if (this.voicing === 'arpeggio') { chordW = 0; arpW = 1; }
    else {
      // Adaptive: the closer the network is to settled, the more chord-like.
      chordW = Math.pow(Math.max(0, Math.min(1, settledness)), 1.2);
      arpW   = 1 - chordW;
    }

    for (let i = 0; i < N; i++) {
      const sustain = Math.pow(Math.max(0, state[i]), 0.8) * 0.32;
      const pluck   = this._pluckAmp[i] * 0.55;
      const amp     = sustain * chordW + pluck * arpW + this.flashIntensity[i] * 0.16;
      this.voices[i].gain.gain.rampTo(amp, 0.04);
      this.flashIntensity[i] *= 0.88;
    }
  }

  flash(index, intensity = 0.4) {
    this.flashIntensity[index] = Math.max(this.flashIntensity[index], intensity);
  }

  noiseOn() {
    if (!this.started || this._noiseActive) return;
    this.noiseGain.gain.rampTo(0.08, 0.1);
    this._noiseActive = true;
  }

  noiseOff() {
    if (!this.started || !this._noiseActive) return;
    this.noiseGain.gain.rampTo(0, 0.25);
    this._noiseActive = false;
  }

  setNoiseParams({ x = 0.5, y = 0.5, velocity = 0 }) {
    if (!this.started) return;
    const freq = 200 * Math.pow(16, 1 - y);
    this.noiseFilter.frequency.rampTo(freq, 0.05);
    this.noiseFilter.Q.rampTo(0.5 + x * 6, 0.05);
    if (this._noiseActive) {
      const g = 0.06 + Math.min(0.25, velocity * 0.2);
      this.noiseGain.gain.rampTo(g, 0.05);
    }
  }
}
