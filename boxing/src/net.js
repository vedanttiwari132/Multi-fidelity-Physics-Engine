// Online play over the claude.ai artifact "room" capability.
//
// Everyone with the page open shares a lobby. A host advertises an open match
// in their lobby presence; the match itself runs in a named room
// ("km-<code>") that only the two fighters join. Each fighter publishes its
// own state in that room's presence about 30 times a second. Presence is used
// for everything (no event topics), so any signed-in viewer can play.
//
// Outside the hosted page (e.g. a local http server) the room is unavailable
// and online play is simply switched off.

const PREFIX = 'km-';
const CODE_RE = /^[a-z0-9]{4,8}$/;

export class Net {
  constructor() {
    this.room = null;      // lobby
    this.match = null;     // named room for the current match
    this.role = null;      // 'host' | 'guest'
    this.code = null;
    this.name = 'Boxer';
    this.lastSend = 0;
    this.onLobby = null;   // (openMatches) => void
  }

  async init() {
    try {
      this.room = window.claude?.use ? await window.claude.use('room') : null;
    } catch {
      this.room = null;
    }
    if (!this.room) return false;
    this.room.onPeers(
      () => this.onLobby?.(this.openMatches()),
      () => { this.room = null; this.onLobby?.(null); },
    );
    return true;
  }

  get available() { return !!this.room; }

  /** Matches other people are hosting right now. Everything here is untrusted text. */
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

  async host(name) {
    this.name = cleanName(name);
    const code = Array.from({ length: 5 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
    this.match = await this.room.join(PREFIX + code);
    this.role = 'host';
    this.code = code;
    await this.setListed(true);
    return code;
  }

  async setListed(open) {
    if (!this.room || this.role !== 'host') return;
    try {
      await this.room.presence({ host: open ? { code: this.code, name: this.name, open: true } : null });
    } catch { /* lobby listing is best-effort */ }
  }

  async join(code, name) {
    code = String(code || '').trim().toLowerCase();
    if (!CODE_RE.test(code)) throw new Error('bad_code');
    this.name = cleanName(name);
    this.match = await this.room.join(PREFIX + code);
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

  /** Other participants in the match room (another tab of yours counts as another player). */
  others() { return this.match ? this.match.peers().filter((p) => !p.sameTab) : []; }

  /** Publish this fighter's state, at most ~30 times a second. `force` skips the throttle. */
  send(state, now, force = false) {
    if (!this.match) return;
    if (!force && now - this.lastSend < 33) return;
    this.lastSend = now;
    this.match.presence(state).catch(() => { /* dropped; the next frame resends */ });
  }
}

// control and invisible formatting characters (built from a string so bundlers keep the escapes)
const HIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f]', 'g');

export function cleanName(s) {
  const t = String(s ?? '').replace(HIDDEN, '').trim().slice(0, 16);
  return t || 'Boxer';
}
