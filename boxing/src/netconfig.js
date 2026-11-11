// Settings for online play outside claude.ai (itch.io, GitHub Pages, your own site).
//
// Players' browsers connect directly to each other. Some networks (schools,
// offices, mobile carriers, some VPNs) block direct connections; a relay
// ("TURN") server lets those players connect anyway. Without one, some pairs
// of players simply can't reach each other.
//
// Free relay: sign up at https://www.metered.ca/tools/openrelay/ (free plan,
// 20 GB a month, which is roughly 90 hours of relayed fights), open your TURN
// credentials and copy the "credentials URL". It looks like
//   https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=<your-key>
// and is meant to be used from web pages, so it is fine to publish.
//
// You can also set these without rebuilding, by adding this to index.html
// before the game's script:
//   <script>window.KNOCKOUT_NET = { turnCredentialsUrl: 'https://...' }</script>

export const NET_CONFIG = {
  /** URL that returns a JSON array of ICE servers (Metered's format). */
  turnCredentialsUrl: 'https://knockoutphysics.metered.live/api/v1/turn/credentials?apiKey=00e5ab637edde6914f61b5035351a6b51075',
  /** Relay servers listed directly instead, e.g. your own coturn: [{ urls, username, credential }]. */
  iceServers: [],
};

/** Public STUN servers: let each browser find its own public address. */
export const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

/** PeerJS's own free relay. UDP only and best-effort: used only when no other relay is set. */
export const FALLBACK_RELAY = {
  urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
  username: 'peerjs',
  credential: 'peerjsp',
};
