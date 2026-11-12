// The physics world: Rapier rigid bodies for both fighters, your gloves and kicking foot,
// your head, the canvas and the cage. Wraps the Rapier world with the game's collision
// groups, a contact filter (for rules like "a resting glove doesn't parry"), and contact
// reports (who hit what, how fast, with what impulse) for the damage code.

import * as THREE from 'three';
import RAPIER from './rapier.js';
import { OCT_APOTHEM } from './arena.js';

// ---------------------------------------------------------------- collision groups
// Bit per group. Each fighter has five: torso, head, arms, thighs, shins (shins include feet).
// Fighter 0 is you, fighter 1 is him (the AI, or the other player online).
// The referee is one more group (all his parts): solid to both fighters and their strikes.
export const GROUP = { STATIC: 0, GLOVE: 1, PHEAD: 2, REF: 13 };
const PARTS = ['TORSO', 'HEAD', 'ARM', 'THIGH', 'SHIN'];
export const fighterGroup = (k, part) => (k === 2 ? GROUP.REF : 3 + k * 5 + PARTS.indexOf(part));
const N_GROUPS = 14;

/** Which groups touch. `cosmetic`: your own body's arms and head (your first-person gloves and head do that job). */
function allowed(a, b, cosmetic) {
  const f = (g) => (g >= 3 && g < GROUP.REF ? { k: Math.floor((g - 3) / 5), part: PARTS[(g - 3) % 5] } : null);
  const A = f(a), B = f(b);
  const cos = (X) => X && X.k === 0 && cosmetic.has(X.part);
  // fixed scenery
  if (a === GROUP.STATIC || b === GROUP.STATIC) return a !== b;
  // the referee: everything but himself (his own parts are kept apart by his joints) and your head
  if (a === GROUP.REF || b === GROUP.REF) {
    const o = a === GROUP.REF ? b : a;
    if (o === GROUP.REF || o === GROUP.PHEAD) return false;
    const X = f(o);
    return !cos(X);
  }
  // your gloves and kicking foot: each other, and him
  if (a === GROUP.GLOVE || b === GROUP.GLOVE) {
    const o = a === GROUP.GLOVE ? B : A;
    if (!o) return a === b;      // glove vs glove
    return o.k === 1;
  }
  // your head: his fists, his kicks and his head
  if (a === GROUP.PHEAD || b === GROUP.PHEAD) {
    const o = a === GROUP.PHEAD ? B : A;
    return !!o && o.k === 1 && (o.part === 'ARM' || o.part === 'SHIN' || o.part === 'HEAD');
  }
  if (A.k !== B.k) return !cos(A) && !cos(B);   // two fighters: everything is solid
  // one fighter's own parts (jointed neighbours are switched off per joint)
  const pair = (x, y) => (A.part === x && B.part === y) || (A.part === y && B.part === x);
  return pair('ARM', 'ARM') || pair('TORSO', 'ARM') || pair('HEAD', 'ARM') || pair('SHIN', 'SHIN') || pair('TORSO', 'SHIN');
}

/** Rapier interaction groups for a group id: membership in the high 16 bits, filter in the low 16. */
const groupCache = new Map();
export function interactionGroups(g, cosmetic = COSMETIC) {
  if (groupCache.has(g)) return groupCache.get(g);
  let filter = 0;
  for (let o = 0; o < N_GROUPS; o++) if (allowed(g, o, cosmetic)) filter |= 1 << o;
  const v = ((1 << g) << 16) | filter;
  groupCache.set(g, v >>> 0);
  return v >>> 0;
}
const COSMETIC = new Set(['ARM', 'HEAD']);

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _p = new THREE.Vector3();

export class PhysicsWorld {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 240;
    this.world.numSolverIterations = 6;
    this.events = new RAPIER.EventQueue(true);
    /** collider handle -> info: { owner, region, name, kind, ... } (what it is, for the game) */
    this.info = new Map();
    /** (infoA, infoB) => false to let two colliders pass through each other this step */
    this.filter = null;
    /** Called after every step (to refresh joint points, glove positions and so on). */
    this.afterStep = [];
    /** Bodies that replays record (position, rotation and velocities). */
    this.recorded = [];
    /** Bodies whose pre-step velocities are kept, to measure impact speeds. */
    this.tracked = new Set();
    this.vcache = new Map();
    const self = this;
    this.hooks = {
      filterContactPair(c1, c2) {
        if (self.filter && !self.filter(self.info.get(c1), self.info.get(c2))) return RAPIER.SolverFlags.EMPTY;
        return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      },
      filterIntersectionPair() { return true; },
    };
    this.buildArena();
  }

  buildArena() {
    const w = this.world;
    const ground = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const st = interactionGroups(GROUP.STATIC);
    this.floor = this.register(w.createCollider(RAPIER.ColliderDesc.cuboid(12, 0.5, 12).setTranslation(0, -0.5, 0)
      .setFriction(1.0).setCollisionGroups(st), ground), { kind: 'floor' });
    // the cage: eight flat panels (a flat side faces each of +x, -x, +z, -z)
    const half = OCT_APOTHEM * Math.tan(Math.PI / 8) + 0.25;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      this.register(w.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 1.3, half)
        .setTranslation(Math.cos(a) * (OCT_APOTHEM + 0.15), 1.3, Math.sin(a) * (OCT_APOTHEM + 0.15))
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(0.4).setRestitution(0.3).setCollisionGroups(st), ground), { kind: 'cage' });
    }
  }

  register(collider, info) { this.info.set(collider.handle, info); info.collider = collider; return collider; }
  infoOf(collider) { return this.info.get(collider.handle); }

  /**
   * One physics step. `onContact(report)` is called for every pair that touched where at
   * least one side is a striker (a glove, fist or foot), with
   * { a, b (infos), point, normal (a -> b), speed (closing speed, m/s, >= 0), impulse (N·s) }.
   */
  step(h, onContact) {
    const w = this.world;
    w.timestep = h;
    // velocities before the step, to measure how fast things met
    for (const b of this.tracked) {
      let c = this.vcache.get(b);
      if (!c) { c = { v: new THREE.Vector3(), w: new THREE.Vector3(), com: new THREE.Vector3() }; this.vcache.set(b, c); }
      const lv = b.linvel(), av = b.angvel(), cm = b.worldCom();
      c.v.set(lv.x, lv.y, lv.z); c.w.set(av.x, av.y, av.z); c.com.set(cm.x, cm.y, cm.z);
    }
    w.step(this.events, this.hooks);
    for (const f of this.afterStep) f(h);
    if (!onContact) { this.events.clear(); return; }
    const seen = new Set(), pairs = [];
    const add = (h1, h2, force) => {
      const key = h1 < h2 ? h1 * 65536 + h2 : h2 * 65536 + h1;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push([h1, h2, force]);
    };
    this.events.drainCollisionEvents((h1, h2, started) => { if (started) add(h1, h2, 0); });
    this.events.drainContactForceEvents((e) => add(e.collider1(), e.collider2(), e.totalForceMagnitude()));
    for (const [h1, h2, force] of pairs) {
      const a = this.info.get(h1), b = this.info.get(h2);
      if (!a || !b || (!a.striker && !b.striker)) continue;
      const c1 = a.collider, c2 = b.collider;
      let got = false;
      w.contactPair(c1, c2, (m, flipped) => {
        if (got || m.numSolverContacts() === 0) return;
        got = true;
        const n = m.normal();
        _n.set(n.x, n.y, n.z);
        if (flipped) _n.negate();
        const sp = m.solverContactPoint(0);
        _p.set(sp.x, sp.y, sp.z);
      });
      if (!got) continue;
      const va = this.pointVel(c1.parent(), _p, _v), vb = this.pointVel(c2.parent(), _p, _w);
      const speed = Math.max(0, va.sub(vb).dot(_n));
      onContact({ a, b, point: _p.clone(), normal: _n.clone(), speed, impulse: force * h });
    }
  }

  /** Velocity of a point on a body, as it was before the last step (if tracked). */
  pointVel(body, p, out) {
    if (!body) return out.set(0, 0, 0);
    const c = this.vcache.get(body);
    if (!c) { const lv = body.linvel(); return out.set(lv.x, lv.y, lv.z); }
    return out.subVectors(p, c.com).cross(c.w).negate().add(c.v);   // v + w × r
  }

  /** Record / restore bodies for replays: [px,py,pz, qx,qy,qz,qw] per body. */
  get recordSize() { return this.recorded.length * 7; }
  writeState(arr, o = 0) {
    for (const b of this.recorded) {
      const t = b.translation(), r = b.rotation();
      arr[o++] = t.x; arr[o++] = t.y; arr[o++] = t.z; arr[o++] = r.x; arr[o++] = r.y; arr[o++] = r.z; arr[o++] = r.w;
    }
  }
  readState(arr, o = 0, arrB = null, u = 0) {
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    for (const b of this.recorded) {
      let x = arr[o], y = arr[o + 1], z = arr[o + 2];
      qa.set(arr[o + 3], arr[o + 4], arr[o + 5], arr[o + 6]);
      if (arrB) {
        x += (arrB[o] - x) * u; y += (arrB[o + 1] - y) * u; z += (arrB[o + 2] - z) * u;
        qa.slerp(qb.set(arrB[o + 3], arrB[o + 4], arrB[o + 5], arrB[o + 6]), u);
      }
      b.setTranslation({ x, y, z }, false);
      b.setRotation({ x: qa.x, y: qa.y, z: qa.z, w: qa.w }, false);
      o += 7;
    }
    for (const f of this.afterStep) f(0);
  }
  /** Full live state, velocities included (to resume the fight after a replay). */
  saveLive() {
    return this.recorded.map((b) => ({ t: { ...b.translation() }, r: { ...b.rotation() }, v: { ...b.linvel() }, w: { ...b.angvel() } }));
  }
  restoreLive(s) {
    this.recorded.forEach((b, i) => {
      b.setTranslation(s[i].t, true); b.setRotation(s[i].r, true); b.setLinvel(s[i].v, true); b.setAngvel(s[i].w, true);
    });
    for (const f of this.afterStep) f(0);
  }
}
