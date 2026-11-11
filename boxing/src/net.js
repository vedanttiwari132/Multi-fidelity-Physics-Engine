// Online play. One interface, two ways to connect:
//
// - "room": on the hosted claude.ai page, the artifact `room` capability.
//   Everyone with the page open shares a lobby, so open matches are listed.
//   Each match runs in a named room ("km-<code>") that only the two fighters join.
//
// - "p2p": anywhere else (itch.io, GitHub Pages, your own site), a direct
//   WebRTC connection between the two browsers using PeerJS. The host registers
//   "knockout-physics-<code>" with the PeerJS matchmaking server and the guest
//   connects to it with the code. No server of your own is needed. Matches
//   can't be listed this way, so people join with the code.
//
// Either way each fighter keeps one state object (its "presence") and sends the
// whole thing about 30 times a second; the other side reads the latest copy.

import { NET_CONFIG, STUN_SERVERS, FALLBACK_RELAY } from './netconfig.js';

const ROOM_PREFIX = 'km-';
const PEER_PREFIX = 'knockout-physics-';
const CODE_RE = /^[a-z0-9]{4,8}$/;
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const STALE_MS = 15000;   // how long a silent opponent is kept around while reconnecting

const newCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export class Net {
  constructor() {
    this.t = null;         // transport
    this.kind = null;      // 'room' | 'p2p' | null
    this.name = 'Boxer';
    this.onLobby = null;   // (openMatches) => void
    this.initDone = false;
  }

  async init() {
    if (this.initDone) return this.available;
    this.initDone = true;
    const room = new RoomTransport(this);
    if (await room.init()) { this.t = room; this.kind = 'room'; return true; }
    // Inside claude.ai the page can't open direct connections, so don't try.
    if (typeof window !== 'undefined' && window.claude) { this.blockedHere = true; return false; }
    const p2p = new PeerTransport();
    if (await p2p.init()) { this.t = p2p; this.kind = 'p2p'; return true; }
    return false;
  }

  get available() { return !!this.t; }
  /** Whether open matches can be listed (only on the claude.ai page). */
  get canList() { return this.kind === 'room'; }
  get role() { return this.t?.role ?? null; }
  get code() { return this.t?.code ?? null; }
  /** The host said the match already has two fighters. */
  get full() { return !!this.t?.full; }
  /** The code didn't reach anyone (p2p only; the room just stays empty). */
  get unreachable() { return !!this.t?.unreachable; }
  /** Why joining failed (p2p): 'unreachable' (no such code) or 'blocked' (the networks couldn't connect). */
  get failReason() { return this.t?.failReason ?? null; }
  /** A relay (TURN) server is configured, so strict networks can still connect (p2p). */
  get hasRelay() { return !!this.t?.hasRelay; }

  openMatches() { return this.t?.openMatches?.() ?? []; }
  async host(name) { this.name = cleanName(name); return this.t.host(this.name); }
  async setListed(open) { return this.t?.setListed?.(open); }
  async join(code, name) {
    code = String(code || '').trim().toLowerCase();
    if (!CODE_RE.test(code)) throw new Error('bad_code');
    this.name = cleanName(name);
    return this.t.join(code);
  }
  async leave() { return this.t?.leave(); }
  myPeer() { return this.t?.myPeer() ?? null; }
  /** The other fighter(s): [{ peer, presence }]. */
  others() { return this.t?.others() ?? []; }
  /** Merge `patch` into this fighter's state and send it, at most ~30 times a second. */
  send(patch, now) { this.t?.send(patch, now); }
}

// ---------------------------------------------------------------------------
class RoomTransport {
  constructor(net) {
    this.net = net;
    this.room = null; this.match = null; this.role = null; this.code = null; this.lastSend = 0;
  }

  async init() {
    try { this.room = window.claude?.use ? await window.claude.use('room') : null; } catch { this.room = null; }
    if (!this.room) return false;
    this.room.onPeers(
      () => this.net.onLobby?.(this.openMatches()),
      () => { this.room = null; this.net.onLobby?.(null); },
    );
    return true;
  }

  openMatches() {
    if (!this.room) return [];
    const out = [];
    for (const p of this.room.peers()) {
      if (p.sameTab) continue;
      const h = p.presence?.host;
      if (!h || h.open !== true || typeof h.code !== 'string' || !CODE_RE.test(h.code)) continue;
      out.push({ code: h.code, name: cleanName(h.name), peer: p.peer });
    }
    return out;
  }

  async host() {
    const code = newCode();
    this.match = await this.room.join(ROOM_PREFIX + code);
    this.role = 'host';
    this.code = code;
    await this.setListed(true);
    return code;
  }

  async setListed(open) {
    if (!this.room || this.role !== 'host') return;
    try {
      await this.room.presence({ host: open ? { code: this.code, name: this.net.name, open: true } : null });
    } catch { /* listing is best-effort */ }
  }

  async join(code) {
    this.match = await this.room.join(ROOM_PREFIX + code);
    this.role = 'guest';
    this.code = code;
  }

  async leave() {
    const m = this.match, wasHost = this.role === 'host';
    this.match = null; this.role = null; this.code = null;
    try { await m?.leave(); } catch { /* already gone */ }
    if (wasHost) { try { await this.room?.presence({ host: null }); } catch { /* ignore */ } }
  }

  myPeer() { return this.match?.peers().find((p) => p.sameTab)?.peer ?? null; }
  // Another tab of yours counts as another player. `t` = when their state last changed, on performance.now()'s clock.
  others() {
    if (!this.match) return [];
    const skew = performance.now() - Date.now();
    return this.match.peers().filter((p) => !p.sameTab).map((p) => ({ peer: p.peer, presence: p.presence, sameTab: false, t: p.updatedAt + skew }));
  }

  send(patch, now) {
    if (!this.match || now - this.lastSend < 33) return;
    this.lastSend = now;
    this.match.presence(patch).catch(() => { /* dropped; the next frame resends */ });
  }
}

// ---------------------------------------------------------------------------
const validIce = (x) => x && typeof x === 'object' && (typeof x.urls === 'string' || Array.isArray(x.urls));
const isRelay = (x) => [].concat(x.urls).some((u) => /^turns?:/.test(String(u)));

class PeerTransport {
  constructor() {
    this.Peer = null; this.peer = null; this.conns = new Map(); this.remote = new Map();
    this.state = {}; this.role = null; this.code = null; this.lastSend = 0;
    this.full = false; this.unreachable = false; this.failReason = null; this.hasRelay = false;
    this.conn = null; this.attempts = 0; this.everConnected = false; this.iceFailed = false;
    this.redialTimer = null; this.reconnectTimer = null; this.leaving = false;
    this.ice = null; this.iceAt = 0;
  }

  async init() {
    if (typeof RTCPeerConnection === 'undefined') return false;
    try {
      const mod = await import('peerjs');
      this.Peer = mod.Peer || mod.default;
    } catch { this.Peer = null; }
    return !!this.Peer;
  }

  settings() {
    const w = typeof window !== 'undefined' ? window : {};
    return { ...NET_CONFIG, ...(w.KNOCKOUT_NET || {}) };
  }

  /** STUN servers plus a relay: from the credentials URL, the configured list, or PeerJS's fallback. */
  async iceServers() {
    if (this.ice && performance.now() - this.iceAt < 10 * 60e3) return this.ice;
    const cfg = this.settings();
    let relays = (Array.isArray(cfg.iceServers) ? cfg.iceServers : []).filter(validIce);
    if (cfg.turnCredentialsUrl) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        const res = await fetch(cfg.turnCredentialsUrl, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(timer);
        const list = res.ok ? await res.json() : null;
        if (Array.isArray(list)) relays = relays.concat(list.filter(validIce));
      } catch { /* relay service unreachable: carry on with what we have */ }
    }
    this.hasRelay = relays.some(isRelay);
    this.ice = [...STUN_SERVERS, ...relays, ...(this.hasRelay ? [] : [FALLBACK_RELAY])];
    this.iceAt = performance.now();
    return this.ice;
  }

  async options() {
    const opts = { debug: 0, config: { iceServers: await this.iceServers(), sdpSemantics: 'unified-plan' } };
    // Optional override, e.g. your own PeerJS server: window.KNOCKOUT_PEER = { host, port, path, secure }
    const w = typeof window !== 'undefined' ? window : {};
    return { ...opts, ...(w.KNOCKOUT_PEER || {}) };
  }

  openPeer(id, opts) {
    return new Promise((resolve, reject) => {
      const p = id ? new this.Peer(id, opts) : new this.Peer(opts);
      const timer = setTimeout(() => { p.destroy(); reject(new Error('timeout')); }, 12000);
      p.once('open', () => { clearTimeout(timer); resolve(p); });
      p.once('error', (e) => { clearTimeout(timer); p.destroy(); reject(e); });
    });
  }

  /** Keep the link to the matchmaking server alive (needed to accept or re-dial connections). */
  watch(peer) {
    peer.on('error', (e) => {
      // "No one has that code": only meaningful before we ever connected.
      if (e?.type === 'peer-unavailable' && !this.everConnected) this.unreachable = true;
    });
    peer.on('disconnected', () => this.keepRegistered(peer));
  }

  keepRegistered(peer) {
    if (this.reconnectTimer || this.leaving || this.peer !== peer || peer.destroyed) return;
    const tryAgain = () => {
      this.reconnectTimer = null;
      if (this.leaving || this.peer !== peer || peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch { /* retried below */ }
      this.reconnectTimer = setTimeout(tryAgain, 3000);
    };
    this.reconnectTimer = setTimeout(tryAgain, 500);
  }

  async host() {
    this.leaving = false;
    const opts = await this.options();
    let lastErr = null;
    for (let i = 0; i < 4 && !this.peer; i++) {
      const code = newCode();
      try {
        this.peer = await this.openPeer(PEER_PREFIX + code, opts);
        this.code = code;
      } catch (e) {
        lastErr = e;
        if (e?.type !== 'unavailable-id') throw e;   // only retry when the code was taken
      }
    }
    if (!this.peer) throw lastErr || new Error('no_code');
    this.role = 'host';
    this.watch(this.peer);
    this.peer.on('connection', (c) => this.accept(c));
    return this.code;
  }

  accept(conn) {
    const current = [...this.conns.keys()];
    if (current.length && !current.includes(conn.peer)) {   // one opponent per match
      conn.on('open', () => { try { conn.send({ full: true }); } catch { /* ignore */ } setTimeout(() => conn.close(), 500); });
      return;
    }
    // Your opponent reconnecting: the new connection replaces the old one.
    const old = this.conns.get(conn.peer);
    if (old) { this.conns.delete(conn.peer); try { old.close(); } catch { /* ignore */ } }
    this.wire(conn);
  }

  wire(conn) {
    this.conns.set(conn.peer, conn);
    conn.on('open', () => { try { conn.send(this.state); } catch { /* ignore */ } });
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      if (d.full === true) { this.full = true; return; }
      this.remote.set(conn.peer, { presence: Object.freeze(d), t: performance.now() });
    });
    conn.on('iceStateChanged', (st) => { if (st === 'failed') this.iceFailed = true; });
    const drop = () => { if (this.conns.get(conn.peer) === conn) this.conns.delete(conn.peer); };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  async join(code) {
    this.leaving = false;
    this.peer = await this.openPeer(null, await this.options());
    this.watch(this.peer);
    this.role = 'guest';
    this.code = code;
    this.dial();
  }

  /** Guest: connect to the host, retrying a few times, and again whenever the link drops. */
  dial() {
    if (this.leaving || !this.peer || this.peer.destroyed) return;
    this.attempts++;
    const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: false, serialization: 'json' });
    this.conn = conn;
    this.wire(conn);
    const timer = setTimeout(() => { if (!conn.open) { try { conn.close(); } catch { /* ignore */ } this.redial(conn); } }, 9000);
    conn.on('open', () => { clearTimeout(timer); this.attempts = 0; this.everConnected = true; this.iceFailed = false; });
    conn.on('close', () => { clearTimeout(timer); this.redial(conn); });
    conn.on('error', () => { clearTimeout(timer); this.redial(conn); });
  }

  redial(conn) {
    if (conn !== this.conn || this.leaving || this.redialTimer || !this.peer || this.peer.destroyed) return;
    if (!this.everConnected && (this.unreachable || this.attempts >= 3)) {
      // The matchmaking server found the code (otherwise it says "unavailable"), so the
      // host exists and it's the connection between the two networks that failed.
      this.failReason = this.unreachable ? 'unreachable' : 'blocked';
      return;
    }
    const delay = Math.min(4000, 400 * 2 ** Math.min(3, this.attempts));
    this.redialTimer = setTimeout(() => { this.redialTimer = null; this.dial(); }, delay);
  }

  async leave() {
    this.leaving = true;
    clearTimeout(this.redialTimer); clearTimeout(this.reconnectTimer);
    this.redialTimer = this.reconnectTimer = null;
    for (const c of this.conns.values()) { try { c.close(); } catch { /* ignore */ } }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.peer = null; this.conn = null; this.conns.clear(); this.remote.clear(); this.state = {};
    this.role = null; this.code = null; this.full = false; this.unreachable = false; this.failReason = null;
    this.attempts = 0; this.everConnected = false; this.iceFailed = false;
  }

  myPeer() { return this.peer?.id ?? null; }

  /** Includes a few seconds of the last state heard, with `t` = when it arrived. */
  others() {
    const now = performance.now(), out = [];
    for (const [peer, v] of this.remote) if (now - v.t < STALE_MS) out.push({ peer, presence: v.presence, sameTab: false, t: v.t });
    return out;
  }

  send(patch, now) {
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete this.state[k]; else this.state[k] = v; }
    if (now - this.lastSend < 33) return;
    this.lastSend = now;
    for (const c of this.conns.values()) if (c.open) { try { c.send(this.state); } catch { /* channel closing */ } }
  }
}

// control and invisible formatting characters (built from a string so bundlers keep the escapes)
const HIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f]', 'g');

export function cleanName(s) {
  const t = String(s ?? '').replace(HIDDEN, '').trim().slice(0, 16);
  return t || 'Boxer';
}
