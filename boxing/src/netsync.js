// Smooth playback of the other player (snapshot interpolation).
//
// Their state arrives about 30 times a second, unevenly (the internet adds jitter) and
// sometimes not at all (the channel is unreliable, for low latency). Instead of jumping to
// each update as it lands, we keep the last second or so of their snapshots, each stamped
// with their clock, and show them a little in the past (just over one update interval plus
// the jitter we've been seeing), blending between the two snapshots either side. A late or
// lost packet then costs nothing; if they stop arriving we carry on briefly along their
// last velocity, then hold.

export class SnapshotBuffer {
  /** delay: the least playback delay (ms); maxExtrap: how far past the last snapshot we may guess (ms). */
  constructor({ delay = 70, maxExtrap = 150 } = {}) {
    this.delay = delay;
    this.maxExtrap = maxExtrap;
    this.reset();
  }

  reset() {
    this.buf = [];
    this.off = null;     // our clock minus theirs, plus the quickest a packet has taken
    this.jitter = 0;     // how much later than that packets typically arrive (ms, smoothed)
  }

  /** A snapshot { ts (their clock, ms), ... } that arrived at `recv` (our clock, ms). Old and repeated ones are ignored. */
  push(snap, recv) {
    const last = this.buf[this.buf.length - 1];
    if (last && snap.ts <= last.ts) return false;
    const sample = recv - snap.ts;
    if (this.off === null || sample < this.off) this.off = sample;      // the fastest packet so far
    else this.off += (sample - this.off) * 0.002;                        // (and drift slowly, for clock drift)
    this.jitter += (Math.max(0, sample - this.off) - this.jitter) * 0.05;
    this.buf.push(snap);
    while (this.buf.length > 3 && this.buf[1].ts < snap.ts - 1500) this.buf.shift();
    return true;
  }

  /** How far in the past we're showing them (ms). */
  get playbackDelay() { return Math.min(260, Math.max(this.delay, 40 + this.jitter * 2.5)); }

  /**
   * What to show at `now` (our clock): { a, b, u, ex }: blend snapshot a to b by u, then carry
   * on ex seconds past b (only when we've run out of snapshots). null before the first one.
   */
  sample(now) {
    const B = this.buf;
    if (!B.length) return null;
    const T = now - this.off - this.playbackDelay;   // on their clock
    if (T <= B[0].ts) return { a: B[0], b: B[0], u: 0, ex: 0 };
    for (let i = B.length - 1; i >= 0; i--) {
      if (B[i].ts > T) continue;
      if (i === B.length - 1) return { a: B[i], b: B[i], u: 0, ex: Math.min(this.maxExtrap, T - B[i].ts) / 1000 };
      const a = B[i], b = B[i + 1];
      return { a, b, u: (T - a.ts) / (b.ts - a.ts), ex: 0 };
    }
    return { a: B[0], b: B[0], u: 0, ex: 0 };
  }
}

/** Shortest-way blend between two angles. */
export function lerpAngle(a, b, u) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * u;
}
