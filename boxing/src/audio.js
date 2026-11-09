// All sounds are synthesised with WebAudio — no asset files needed.

export class Sfx {
  constructor() { this.ctx = null; this.muted = false; }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // Brown noise for the crowd bed
    this.brownBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const b = this.brownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    this.startCrowd();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.8;
    return this.muted;
  }

  noise({ dur = 0.1, type = 'lowpass', freq = 1000, q = 1, gain = 0.5, sweepTo = null, delay = 0 }) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  tone({ freq = 100, to = null, dur = 0.15, gain = 0.5, type = 'sine', delay = 0 }) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** intensity ~0..1.5 */
  punch(intensity, region = 'head') {
    const i = Math.min(1.5, Math.max(0.1, intensity));
    this.tone({ freq: 150 + i * 30, to: 45, dur: 0.14 + i * 0.05, gain: 0.5 * i });
    this.noise({ dur: 0.07 + i * 0.03, freq: 900 + i * 1800, gain: 0.45 * i });
    if (region === 'head') this.noise({ dur: 0.04, type: 'highpass', freq: 2500, gain: 0.25 * i });
    if (i > 0.9) this.crowdCheer(0.5 * i);
  }

  block(intensity) {
    const i = Math.min(1.2, Math.max(0.15, intensity));
    this.tone({ freq: 260, to: 120, dur: 0.08, gain: 0.25 * i, type: 'triangle' });
    this.noise({ dur: 0.06, freq: 600, gain: 0.3 * i });
  }

  whoosh(strength = 0.5) {
    this.noise({ dur: 0.16, type: 'bandpass', freq: 350, sweepTo: 1800, q: 1.2, gain: 0.12 * strength });
  }

  bell(times = 1) {
    for (let k = 0; k < times; k++) {
      const d = k * 0.45;
      for (const [f, g] of [[1180, 0.25], [2410, 0.12], [3300, 0.06], [590, 0.08]]) {
        this.tone({ freq: f, dur: 2.2, gain: g, type: 'sine', delay: d });
      }
    }
  }

  startCrowd() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.brownBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.5;
    this.crowdGain = c.createGain(); this.crowdGain.gain.value = 0.05;
    src.connect(f).connect(this.crowdGain).connect(this.master);
    src.start();
  }

  crowdCheer(amount = 1) {
    if (!this.crowdGain) return;
    const t = this.ctx.currentTime;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.05 + 0.3 * Math.min(1.5, amount), t + 0.15);
    g.linearRampToValueAtTime(0.05, t + 1.5 + amount * 2);
  }
}
