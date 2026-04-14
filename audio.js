// audio.js — Tone.js engine. Twelve sustained voices (one per pitch class),
// their amplitudes driven by positive node activations. Plus a gesture noise
// layer that the perturbation square paints with as you drag.
//
// Mobile Web Audio requires a user gesture to unlock, so call start() from
// the tap-to-begin handler.

import { N } from './network.js';

const Tone = window.Tone;

export class Engine {
  constructor() {
    this.started = false;
    this.voices = [];
    this.mode = 'chord';              // 'chord' | 'arpeggio'
    this.arpRate = 5;                  // Hz — steps per second in arpeggio mode
    this._arpIndex = 0;
    this._arpAccumulator = 0;
    this._currentState = new Float32Array(N);
    this.flashIntensity = new Float32Array(N);
    this._noiseActive = false;
  }

  async start() {
    if (this.started) return;
    await Tone.start();

    this.master = new Tone.Gain(0.75).toDestination();

    this.reverb = new Tone.Reverb({ decay: 6, wet: 0.4 }).connect(this.master);
    await this.reverb.ready;

    this.delay = new Tone.FeedbackDelay({
      delayTime: 0.42,
      feedback: 0.38,
      wet: 0.28,
    }).connect(this.reverb);

    this.voiceBus = new Tone.Gain(1).connect(this.delay);

    // 12 sine voices, one per pitch class, tuned to the C4 octave.
    const baseNote = 'C4';
    for (let i = 0; i < N; i++) {
      const freq = Tone.Frequency(baseNote).transpose(i).toFrequency();
      const osc = new Tone.Oscillator({ frequency: freq, type: 'sine' });
      // Tiny detune per voice avoids phase-locked beating and adds life.
      osc.detune.value = (Math.random() - 0.5) * 4;
      const gain = new Tone.Gain(0).connect(this.voiceBus);
      osc.connect(gain);
      osc.start();
      this.voices.push({ osc, gain, freq });
    }

    // Gesture noise layer — pink noise through a bandpass, amplitude is
    // ramped in/out at gesture start/end, filter params track the drag.
    this.noise = new Tone.Noise('pink');
    this.noiseFilter = new Tone.Filter({ type: 'bandpass', frequency: 800, Q: 1.5 });
    this.noiseGain = new Tone.Gain(0).connect(this.reverb);
    this.noise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noise.start();

    this.started = true;
  }

  setVolume(v)   { if (this.master) this.master.gain.rampTo(v, 0.1); }
  setReverb(amt) { if (this.reverb) this.reverb.wet.rampTo(amt, 0.2); }
  setDelay(amt)  { if (this.delay)  this.delay.wet.rampTo(amt, 0.2); }
  setMode(mode)  { this.mode = mode; this._arpIndex = 0; this._arpAccumulator = 0; }
  setArpRate(hz) { this.arpRate = Math.max(0.25, hz); }

  // Call from the animation loop with the current network state and elapsed ms.
  updateVoices(state, dtMs) {
    if (!this.started) return;
    for (let i = 0; i < N; i++) this._currentState[i] = state[i];

    if (this.mode === 'chord') {
      for (let i = 0; i < N; i++) {
        const target = Math.max(0, state[i]);
        // Perceptual curve + a small additive boost from any recent flash event.
        const amp = Math.pow(target, 0.8) * 0.32 + this.flashIntensity[i] * 0.18;
        this.voices[i].gain.gain.rampTo(amp, 0.1);
        this.flashIntensity[i] *= 0.88;
      }
    } else {
      // Arpeggio: silence all voices, then pluck whichever step we're on.
      this._arpAccumulator += dtMs;
      const stepMs = 1000 / this.arpRate;
      const active = [];
      for (let i = 0; i < N; i++) if (state[i] > 0.15) active.push(i);
      if (this._arpAccumulator >= stepMs) {
        this._arpAccumulator = 0;
        if (active.length > 0) {
          const pick = active[this._arpIndex % active.length];
          this._arpIndex++;
          const amp = Math.pow(state[pick], 0.8) * 0.45;
          const t = Tone.now();
          for (let i = 0; i < N; i++) {
            const g = this.voices[i].gain.gain;
            g.cancelScheduledValues(t);
            if (i === pick) {
              g.setValueAtTime(amp, t);
              g.linearRampToValueAtTime(0, t + Math.min(0.6, stepMs / 1000));
            } else {
              g.setTargetAtTime(0, t, 0.04);
            }
          }
        }
      }
      for (let i = 0; i < N; i++) this.flashIntensity[i] *= 0.88;
    }
  }

  // Called when a specific node has just flipped — brief brightening of both
  // sound and visuals ties the update event to something audible.
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

  // x, y in [0,1]; velocity roughly 0..2 (unclamped, scaled by caller).
  setNoiseParams({ x = 0.5, y = 0.5, velocity = 0 }) {
    if (!this.started) return;
    // Map y to filter center (200 Hz .. 3200 Hz, log scale).
    const freq = 200 * Math.pow(16, 1 - y);
    this.noiseFilter.frequency.rampTo(freq, 0.05);
    // Map x to Q (narrow to wide band).
    this.noiseFilter.Q.rampTo(0.5 + x * 6, 0.05);
    // Velocity boosts gain (capped).
    if (this._noiseActive) {
      const g = 0.06 + Math.min(0.25, velocity * 0.2);
      this.noiseGain.gain.rampTo(g, 0.05);
    }
  }
}
