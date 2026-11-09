# Knockout Physics — first-person physics boxing (browser)

A first-person boxing game where the fighting is driven by physics, not canned animations.

- **Your gloves** are 3 kg simulated bodies pulled toward punch targets by spring-damper (PD) "muscles", with arm length enforced by a distance constraint. Damage comes from the **actual impact speed** of the collision, so range, timing, footwork (stepping in adds speed) and stamina (tired = weaker muscles) all matter.
- **The opponent** is an *active ragdoll*: 17 Verlet particles joined by 36 constraints, held upright by muscle springs toward an animated pose. Hits physically snap his head back. Head shots daze him (muscle tone drops, he wobbles), and at 0 health his tone goes to zero and he collapses under gravity, then has to push himself back up.
- **Blocking is physical.** Your gloves and his gloves are colliders, so a guard only works if the gloves are actually in the way.
- **The ropes** are Verlet chains that he bounces off.
- Press **V** in-game to see the physics skeleton (particles + constraints).

## Run it

ES modules need to be served over HTTP (opening the file directly won't work):

```bash
cd boxing
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Three.js is vendored in `vendor/`, so it works offline. No build step.

## Controls

| Input | Action |
|---|---|
| Mouse | Look / aim punches |
| LMB / RMB | Left jab / right cross |
| Q / E | Left hook / right hook |
| Shift + click | Uppercut |
| Space (hold) | Guard |
| C (hold) | Duck |
| WASD | Footwork |
| V | Physics debug view |
| M | Mute |
| Esc | Pause |

3 rounds × 90 s. Knockout = no get-up by the count of 10; a third knockdown ends it. Otherwise it goes to a decision on damage.

## Code layout

| File | What it does |
|---|---|
| `src/physics.js` | Verlet engine: particles, distance constraints (equal / max / min), floor friction, sphere and segment contacts with impulses, two-bone IK |
| `src/fighter.js` | Opponent ragdoll, muscle controller, AI (stalk / combo / retreat, blocking and slipping), visuals |
| `src/player.js` | First-person controller, PD-driven gloves, punch trajectories, head-recoil springs |
| `src/arena.js` | Ring, physical ropes, lights, crowd |
| `src/main.js` | Fixed 240 Hz physics loop, contact → damage rules, rounds / knockdowns, HUD, input |
| `src/audio.js` | Synthesised WebAudio sound effects (no asset files) |

Tuning knobs worth playing with: `DIFFICULTY` and `PUNCHES` in `fighter.js`, `PUNCHES` and `ARM` in `player.js`, and the damage formulas in `onGloveContact` / `onPlayerStruck` in `main.js`.
