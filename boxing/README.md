# Knockout Physics — first-person physics boxing (browser)

A first-person boxing game where the fighting is driven by physics, not canned animations.

- **Your gloves** are 3 kg simulated bodies pulled toward punch targets by spring-damper (PD) "muscles", with arm length enforced by a distance constraint. Damage comes from the **actual impact speed** of the collision, so range, timing, footwork (stepping in adds speed) and stamina (tired = weaker muscles) all matter.
- **The opponent** is an *active ragdoll*: 17 Verlet particles joined by 36 constraints, held upright by muscle springs toward an animated pose. Hits physically snap his head back. Head shots daze him (muscle tone drops, he wobbles), and at 0 health his tone goes to zero and he collapses under gravity, then has to push himself back up.
- **Blocking is physical.** Your gloves and his gloves are colliders, so a guard only works if the gloves are actually in the way.
- **The ropes** are Verlet chains that he bounces off.
- **Telegraphed attacks.** The glove he's about to throw glows, and a ring around your sights lights up on the side it's coming from, with a hint for how to avoid it. Slip or duck it and he's left open for a counter.
- **Knockout cam.** Every knockdown is replayed in slow motion from a third-person camera, using a recording of the last couple of seconds of the physics simulation.
- **Ragdoll joint limits and self-collision.** Knees are hinges that can't bend backwards, the neck and spine have range limits, and every pair of body parts that isn't directly joined collides, so limbs can't pass through the body.
- **Online play.** *Play online* lets you host a match with a short join code, or join one. On the claude.ai page open matches are also listed. Each fighter decides whether a punch reached their own head and reports it back, so a dodge that worked on your screen always counts. The host keeps the match clock.
- Press **V** in-game to see the physics skeleton (particles + constraints).

## Run it

For development, serve the folder (ES modules don't load from `file://`):

```bash
cd boxing
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Put it online so anyone can play

Build one self-contained page (game, Three.js and PeerJS in a single file):

```bash
cd boxing
npm install
npm run build
```

That writes `dist/index.html`, which works on any static host, or opened straight from disk. Some options:

- **itch.io**: zip `dist/index.html`, create a project with kind *HTML*, upload the zip and tick *This file will be played in the browser*.
- **Netlify**: drag the `dist` folder onto <https://app.netlify.com/drop>.
- **GitHub Pages**: no build needed. Publish the repository with Pages and the game is at `/boxing/` (`src/` loads directly; PeerJS comes from a CDN).

### How online play works there

Outside claude.ai, two browsers connect directly to each other over WebRTC using [PeerJS](https://peerjs.com/). The host's match code is registered with PeerJS's free public matchmaking server, and the guest connects with that code, so you don't need a server of your own. Matches are joined by code; there's no list of open matches. On very strict networks (some offices and schools) a direct connection can fail; adding a TURN server fixes that. To use your own PeerJS server or a TURN server, set `window.KNOCKOUT_PEER` (PeerJS options, e.g. `{ host, port, path, secure, config: { iceServers: [...] } }`) before the game script runs.

On the claude.ai page the game uses the artifact `room` capability instead, which also lists open matches.

## Controls

| Input | Action |
|---|---|
| Mouse | Look / aim punches |
| LMB / RMB | Left jab / right cross |
| Q / E | Left hook / right hook |
| Shift + Q / E | Left / right body hook |
| Z / X | Left / right uppercut |
| Space (hold) | Guard (blocks clean shots, but drains stamina and some damage gets through) |
| Shift + LMB / RMB | Slip left / right |
| C (hold) | Duck |
| WASD | Footwork |
| V | Physics debug view |
| M | Mute |
| Esc or P | Pause / leave the match |

3 rounds × 90 s. Knockout = no get-up by the count of 10; a third knockdown ends it. Otherwise it goes to a decision on damage.

## Code layout

| File | What it does |
|---|---|
| `src/physics.js` | Verlet engine: particles, distance constraints (equal / max / min), floor friction, sphere and segment contacts with impulses, two-bone IK |
| `src/fighter.js` | Opponent ragdoll, muscle controller, AI (stalk / combo / retreat, blocking and slipping), visuals |
| `src/player.js` | First-person controller, PD-driven gloves, punch trajectories, head-recoil springs |
| `src/arena.js` | Ring, physical ropes, lights, crowd |
| `src/main.js` | Fixed 240 Hz physics loop, contact → damage rules, rounds / knockdowns, knockout cam, online match flow, HUD, input |
| `src/net.js` | Hosting and joining matches: claude.ai `room` capability, or PeerJS (WebRTC) everywhere else |
| `build.mjs` | Bundles everything into `dist/index.html` for static hosting |
| `src/audio.js` | Synthesised WebAudio sound effects (no asset files) |

Tuning knobs worth playing with: `DIFFICULTY` and `PUNCHES` in `fighter.js`, `PUNCHES` and `ARM` in `player.js`, and the damage formulas in `onGloveContact` / `onPlayerStruck` in `main.js`.
