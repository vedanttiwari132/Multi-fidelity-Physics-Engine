# Knockout Physics MMA — first-person physics fighting (browser)

A first-person MMA game in an octagon where the fighting is driven by physics, not canned animations. (No wrestling, for now: it's all striking.)

- **Your gloves** are 3 kg simulated bodies pulled toward punch targets by spring-damper (PD) "muscles", with arm length enforced by a distance constraint. Damage comes from the **actual impact speed** of the collision, so range, timing, footwork (stepping in adds speed) and stamina (tired = weaker muscles) all matter.
- **The opponent** is an *active ragdoll* made of rigid bodies ([Rapier](https://rapier.rs/)): fourteen solid body parts joined by real joints, ball joints at the neck, spine, shoulders, hips and ankles, and hinges at the elbows and knees that can't bend backwards. His muscles are joint motors with limited strength: they act between the parts they join, so they move the body against itself instead of pulling it around from outside, and when he goes limp the motors go slack and he falls as what he is, a heavy jointed body. His legs push against the floor (as hard as grip allows) to move him, and his weight is held up only while he's balanced over his feet. When a hit or shove moves his balance point (the capture point) past his feet he takes real recovery steps, stumbling several if he has to, and falls if no step can catch him. Struck areas go briefly slack, so heads snap and bodies fold before recovering, and he gets back up by tucking his legs under him and standing. Heavy hits freeze the moment for a few hundredths of a second (hit-stop).
- **Cartoon fighters with clean topology.** Each fighter (and the referee) is one smooth skinned mesh, box-modelled in code the way an artist would: a low-poly quad cage extruded out of a pelvis box into a torso, legs, feet, arms, fists, neck and a big cartoon head with a nose and ears, then smoothed with Catmull–Clark subdivision. Every face is a quad with an edge loop at each joint, and bone weights are set on the cage and smoothed with it, so joints bend cleanly. Each bone rides on its rigid body part, so the mesh turns exactly as the bodies do and can never twist or stretch, in the fight or in the knockout cam. Your first-person arms are built the same way.
- **No textures on the fighters.** Everything on them is a solid colour with toon (cel) shading and an ink outline; the shorts, waistband and hair are cut per pixel, so their edges are clean lines. The gloves are toy-like, extra-puffy open-finger MMA gloves (also box-modelled): a big pillowy knuckle pad, stubby curled fingers and a thumb poking out, a white band and a chunky wrist strap. His are red, yours blue.
- **Fight animation.** The opponent never keeps his head still (small rhythmic slips and dips), his guard hands breathe, the free hand covers his chin while the other punches or he kicks, straights and hooks are driven by a knee dip and hip twist, and his arms counterbalance his kicks.
- **You move exactly like he does.** Your body is the same active ragdoll as his, steered by your inputs instead of the AI: your legs push toward where you want to go as hard as grip allows, your feet stay planted and step, a hard shot or a big kick can make you stumble or sweep you, and when you go down your view goes down with your real falling body. Dashes are an explosive push-off and a planted stop. Footwork is snappy for both of you: strong leg drive, good grip, quick steps. Your eyes never end up inside him: bodies, heads included, are solid to each other, and a fighter who has just got up gets a moment to find his balance.
- **Accurate hitboxes.** The colliders are the hitboxes: capsules measured off the skinned model along the forearms, upper arms, neck, ribcage, waist, hips, thighs, shins and feet, and a head capsule from the jaw to the back of the skull that tilts and turns with the head, so the whole cartoon head counts. A forearm in the way blocks, shins take leg kicks, and when a strike touches the guard and the head at once, the guard wins. Your own head hitbox moves with your eyes, so a slip or a duck counts the instant you make it, and it's centred where your skull is (just behind your eyes).
- **Planted feet.** A foot that bears weight grips the canvas like a loaded sole, so feet don't skate around under the body; the body moves over them and steps. Everything is solid: a kick stops where it lands and comes back instead of swinging on through, the fighters can't sink into each other, and a fighter who's down can't bowl over the one still standing.
- **The referee** is in the cage with you: a third ragdoll with the same body and balance, who keeps to the side of the action, backs off when you come at him and stands over a fighter who's down for the count. He doesn't fight, but stray punches and kicks from either of you hurt him, and **if the referee is knocked out, both fighters are knocked out with him**: the match ends as a no contest. (Not in online matches yet.)
- **Blocking is physical.** Your gloves and his gloves are colliders, so a guard only works if the gloves are actually in the way.
- **The cage** is solid: eight panels you (and he) can be pushed into.
- **Telegraphed attacks.** The glove he's about to throw glows, and a ring around your sights lights up on the side it's coming from, with a hint for how to avoid it. Slip or duck it and he's left open for a counter.
- **Knockout cam.** Every knockdown is replayed in slow motion from a third-person camera, using a recording of the last couple of seconds of the physics simulation.
- **Ragdoll joint limits and self-collision.** Knees are hinges that can't bend backwards; the neck, spine and torso twist have range limits; arms can't fold across the chest and legs can't cross or do the splits; and every pair of body parts that isn't directly joined collides, so limbs can't pass through the body. The solver runs 10 passes per step for stiff joints, and a limp body keeps some damping in its joints so it falls heavily instead of flopping like rope.
- **Online play.** *Play online* lets you host a match with a short join code, or join one. On the claude.ai page open matches are also listed. Each fighter decides whether a punch reached their own head and reports it back, so a dodge that worked on your screen always counts. The host keeps the match clock.
- **Consciousness** (the gold bar under each fighter's health): head shots drain it fast, blocked shots a little, and it recovers when you stop getting hit. The lower it is the less stable you are: your view sways and blurs, your feet wander and your hands slow down; he wobbles. At zero you're knocked down, whatever your health.
- **Kicks** use real legs and wreck **balance**: a few leg kicks sweep a fighter off his feet (he's back up a moment later, no count). Jump over low kicks.
- **Difficulty** runs from Easy to **Expert** and **Champion**: the harder levels feint, punish your misses and blocked shots, throw superman punches, and read your habits (duck a lot and he'll uppercut; slip a lot and he'll hook; shell up and he'll kick your legs).
- **Knockout cam and highlight reel.** Your actions are grouped into combos as you fight. Good ones are kept for the highlight reel at the end of the match, and a knockdown replays its whole combo, slowing down at each key moment (a duck, a slip, a block) and going ultra slow-mo on the final blow.
- Press **V** in-game to see the physics (every collider and joint) and his hitboxes (guard yellow, head red, body orange, legs cyan).

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

That writes `dist/index.html`, which works on any static host, or opened straight from disk. (It's about 6 MB, most of it the Rapier physics engine, which is WebAssembly embedded in the page.) Some options:

- **itch.io**: zip `dist/index.html`, create a project with kind *HTML*, upload the zip and tick *This file will be played in the browser*.
- **Netlify**: drag the `dist` folder onto <https://app.netlify.com/drop>.
- **GitHub Pages**: no build needed. Publish the repository with Pages and the game is at `/boxing/` (`src/` loads directly; PeerJS comes from a CDN).

### How online play works there

Outside claude.ai, two browsers connect directly to each other over WebRTC using [PeerJS](https://peerjs.com/). The host's match code is registered with PeerJS's free public matchmaking server and the guest connects with that code, so you don't need a server of your own. Matches are joined by code; there's no list of open matches. If the connection drops mid-fight, the game reconnects by itself and the round clock waits; a fighter only forfeits after 12 seconds without a connection.

**Make it work on every network: add a relay.** Some networks (schools, offices, mobile carriers, some VPNs) block direct connections. A relay (TURN) server gets those players connected. Without your own, the game falls back to PeerJS's free relay, which only works on networks that allow UDP. To add a reliable one:

1. Sign up for Metered's free Open Relay plan at <https://www.metered.ca/tools/openrelay/> (20 GB a month).
2. Copy your TURN credentials URL (`https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=...`). It is designed to be used from web pages.
3. Paste it as `turnCredentialsUrl` in `src/netconfig.js` (then rebuild if you host `dist/`), or add `<script>window.KNOCKOUT_NET = { turnCredentialsUrl: '...' }</script>` to the page before the game's script.

To use your own PeerJS server instead of the public one, set `window.KNOCKOUT_PEER` (PeerJS options such as `{ host, port, path, secure }`).

On the claude.ai page the game uses the artifact `room` capability instead, which also lists open matches.

## Controls

| Input | Action |
|---|---|
| Mouse | Look / aim |
| LMB / RMB | Left jab / right cross |
| Q / E | Left / right hook |
| Shift + Q / E | Left / right body hook |
| Z / X | Left / right uppercut |
| Shift + Z / X | Left / right kick |
| Shift (hold) | Guard (blocks clean shots, but drains stamina and some damage and consciousness get through) |
| Space | Jump. Punch while in the air for a **superman punch** (huge damage, big telegraph) |
| Alt + A / D | Slip and sidestep left / right |
| Alt + W / S | Dash in / out |
| C (hold) | Duck |
| WASD | Footwork |
| V | Physics debug view |
| M | Mute |
| Esc or P | Pause / leave the match |

**Phones and tablets** (hold it sideways): left thumb moves (the stick appears where you touch), drag on the right side to look. The **LEFT** and **RIGHT** buttons throw with each glove: tap for a jab / cross, swipe sideways for a hook, up for an uppercut, down for a body hook. **KICK**: tap for a right kick, swipe left for a left kick. **JUMP**, then punch for a superman punch. Hold **GUARD** or **DUCK**, tap **◀ SLIP ▶** to slip and sidestep, and tap any button to get up after a knockdown. **II** pauses.

3 rounds × 90 s. Knockout = no get-up by the count of 10; a third knockdown ends it. Otherwise it goes to a decision on damage.

## Code layout

| File | What it does |
|---|---|
| `src/sim.js` | The physics world (Rapier): collision groups, the cage, the contact filter (resting gloves don't parry, body shots go around the guard), contact reports (who hit what, how fast), replay recording |
| `src/ragdoll.js` | The rigid-body active ragdoll: body parts and joints, colliders (= hitboxes), joint-motor muscles, standing help, grip, IK targets |
| `src/rapier.js` | Loads Rapier (WebAssembly) before the game starts |
| `src/physics.js` | Two-bone IK helper for the animation |
| `src/fighter.js` | A fighter's brain and animation (AI, combos, punches and kicks, balance and stepping) driving the ragdoll; the skinned view |
| `src/referee.js` | The referee's brain |
| `src/quadmesh.js` | A small all-quad modelling kernel: extrude faces, Catmull–Clark subdivision (positions, bone weights and colours together) |
| `src/models.js` | The box-modelled cartoon body, first-person arm and puffy MMA gloves |
| `src/body.js` | The skeleton, skinning (bones ride on the ragdoll's parts), toon shading, outlines and colour regions |
| `src/player.js` | First-person controller, PD-driven gloves, punch trajectories, head-recoil springs |
| `src/arena.js` | Octagon cage, lights, crowd |
| `src/main.js` | Fixed 240 Hz physics loop, contact → damage rules, the referee rule, rounds / knockdowns, knockout cam, online match flow, HUD, input |
| `src/net.js` | Hosting and joining matches: claude.ai `room` capability, or PeerJS (WebRTC) everywhere else, with retries and reconnects |
| `src/touch.js` | On-screen controls for phones and tablets |
| `src/netconfig.js` | Relay (TURN) settings for online play outside claude.ai |
| `build.mjs` | Bundles everything into `dist/index.html` for static hosting |
| `src/audio.js` | Synthesised WebAudio sound effects (no asset files) |

Tuning knobs worth playing with: `DIFFICULTY` and `PUNCHES` in `fighter.js`, `PUNCHES` and `ARM` in `player.js`, and the damage formulas in `onGloveContact` / `onPlayerStruck` in `main.js`.
