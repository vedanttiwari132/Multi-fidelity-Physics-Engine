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

const ROOM_PREFIX = 'km-';
const PEER_PREFIX = 'knockout-physics-';
const CODE_RE = /^[a-z0-9]{4,8}$/;
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const STALE_MS = 3000;

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
  // another tab of yours counts as another player
  others() { return this.match ? this.match.peers().filter((p) => !p.sameTab) : []; }

  send(patch, now) {
    if (!this.match || now - this.lastSend < 33) return;
    this.lastSend = now;
    this.match.presence(patch).catch(() => { /* dropped; the next frame resends */ });
  }
}

// ---------------------------------------------------------------------------
class PeerTransport {
  constructor() {
    this.Peer = null; this.peer = null; this.conns = new Map(); this.remote = new Map();
    this.state = {}; this.role = null; this.code = null; this.lastSend = 0;
    this.full = false; this.unreachable = false;
    // Optional override, e.g. your own PeerJS server: window.KNOCKOUT_PEER = { host, port, path, secure }
    this.opts = { debug: 0, ...(typeof window !== 'undefined' && window.KNOCKOUT_PEER ? window.KNOCKOUT_PEER : {}) };
  }

  async init() {
    if (typeof RTCPeerConnection === 'undefined') return false;
    try {
      const mod = await import('peerjs');
      this.Peer = mod.Peer || mod.default;
    } catch { this.Peer = null; }
    return !!this.Peer;
  }

  openPeer(id) {
    return new Promise((resolve, reject) => {
      const p = id ? new this.Peer(id, this.opts) : new this.Peer(this.opts);
      const timer = setTimeout(() => { p.destroy(); reject(new Error('timeout')); }, 12000);
      p.once('open', () => { clearTimeout(timer); resolve(p); });
      p.once('error', (e) => { clearTimeout(timer); p.destroy(); reject(e); });
    });
  }

  watch(peer) {
    peer.on('error', (e) => { if (e?.type === 'peer-unavailable') this.unreachable = true; });
    // Lost the matchmaking server (not the opponent): try to get back.
    peer.on('disconnected', () => { if (this.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch { /* ignore */ } } });
  }

  async host() {
    let lastErr = null;
    for (let i = 0; i < 4 && !this.peer; i++) {
      const code = newCode();
      try {
        this.peer = await this.openPeer(PEER_PREFIX + code);
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
    if (this.conns.size >= 1) {   // one opponent per match
      conn.on('open', () => { try { conn.send({ full: true }); } catch { /* ignore */ } setTimeout(() => conn.close(), 500); });
      return;
    }
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
    const drop = () => { this.conns.delete(conn.peer); this.remote.delete(conn.peer); };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  async join(code) {
    this.peer = await this.openPeer(null);
    this.watch(this.peer);
    this.role = 'guest';
    this.code = code;
    this.wire(this.peer.connect(PEER_PREFIX + code, { reliable: false, serialization: 'json' }));
  }

  async leave() {
    for (const c of this.conns.values()) { try { c.close(); } catch { /* ignore */ } }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.peer = null; this.conns.clear(); this.remote.clear(); this.state = {};
    this.role = null; this.code = null; this.full = false; this.unreachable = false;
  }

  myPeer() { return this.peer?.id ?? null; }

  others() {
    const now = performance.now(), out = [];
    for (const [peer, v] of this.remote) if (now - v.t < STALE_MS) out.push({ peer, presence: v.presence, sameTab: false });
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
