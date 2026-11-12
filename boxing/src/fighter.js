// The opponent: an "active ragdoll".
//
// The body is a set of Verlet particles held together by distance constraints.
// It stays upright only because every particle is pulled toward an animated
// target pose by a PD "muscle" spring and its weight is supported by the
// muscles. Muscle tone drops when the fighter is dazed and goes to zero on a
// knockdown, at which point the body simply collapses under gravity.

import * as THREE from 'three';
import { Particle, DistanceConstraint, HingeConstraint, solveTwoBone } from './physics.js';
import { clampToOctagon, OCT_APOTHEM } from './arena.js';
import { buildHumanTemplate, SkinnedBody, makeGlove, toonMaterial } from './body.js';

export const UPPER_ARM = 0.31, FOREARM = 0.34, THIGH = 0.41, SHIN = 0.44;
const G = 9.81;

// Local rest pose (facing +Z, its left side is +X): [x, y, z, mass kg, radius m, muscle omega rad/s]
const REST = {
  head:      [0.00, 1.66, 0.03, 5.0, 0.125, 9],
  neck:      [0.00, 1.49, 0.00, 2.0, 0.07, 12],
  chest:     [0.00, 1.31, 0.00, 14., 0.17, 14],
  shoulderL: [0.21, 1.43, 0.00, 3.0, 0.08, 14],
  shoulderR: [-0.21, 1.43, 0.00, 3.0, 0.08, 14],
  elbowL:    [0.27, 1.15, 0.14, 2.0, 0.06, 8],
  elbowR:    [-0.27, 1.15, 0.12, 2.0, 0.06, 8],
  handL:     [0.2, 1.24, 0.32, 2.5, 0.09, 18],   // small MMA gloves
  handR:     [-0.2, 1.29, 0.18, 2.5, 0.09, 18],
  belly:     [0.00, 1.09, 0.00, 10., 0.16, 14],
  pelvis:    [0.00, 0.93, 0.00, 12., 0.15, 16],
  hipL:      [0.11, 0.89, 0.00, 4.0, 0.09, 16],
  hipR:      [-0.11, 0.89, 0.00, 4.0, 0.09, 16],
  kneeL:     [0.15, 0.50, 0.13, 4.0, 0.075, 14],
  kneeR:     [-0.14, 0.50, -0.07, 4.0, 0.075, 14],
  footL:     [0.16, 0.07, 0.17, 3.0, 0.07, 30],
  footR:     [-0.16, 0.07, -0.15, 3.0, 0.07, 30],
};

// [a, b, stiffness, mode, length]
const LINKS = [
  ['head', 'neck', 1], ['neck', 'chest', 1], ['neck', 'shoulderL', 1], ['neck', 'shoulderR', 1],
  ['chest', 'shoulderL', 1], ['chest', 'shoulderR', 1], ['shoulderL', 'shoulderR', 1],
  ['chest', 'belly', 1], ['belly', 'pelvis', 1], ['chest', 'pelvis', 1], ['neck', 'belly', 0.8],
  ['shoulderL', 'belly', 0.9], ['shoulderR', 'belly', 0.9],
  ['pelvis', 'hipL', 1], ['pelvis', 'hipR', 1], ['hipL', 'hipR', 1], ['belly', 'hipL', 0.9], ['belly', 'hipR', 0.9],
  ['shoulderL', 'elbowL', 1, 'equal', UPPER_ARM], ['elbowL', 'handL', 1, 'equal', FOREARM],
  ['shoulderR', 'elbowR', 1, 'equal', UPPER_ARM], ['elbowR', 'handR', 1, 'equal', FOREARM],
  ['hipL', 'kneeL', 1, 'equal', THIGH], ['kneeL', 'footL', 1, 'equal', SHIN],
  ['hipR', 'kneeR', 1, 'equal', THIGH], ['kneeR', 'footR', 1, 'equal', SHIN],
  // joint limits (struts that only push)
  ['head', 'chest', 1, 'min'], ['head', 'shoulderL', 1, 'min', 0.2], ['head', 'shoulderR', 1, 'min', 0.2],
  ['shoulderL', 'handL', 1, 'min', 0.14], ['shoulderR', 'handR', 1, 'min', 0.14],
  ['hipL', 'footL', 1, 'min', 0.4], ['hipR', 'footR', 1, 'min', 0.4],
  ['handL', 'handR', 1, 'min', 0.21], ['kneeL', 'kneeR', 1, 'min', 0.16], ['footL', 'footR', 1, 'min', 0.18],
  // joint range limits
  ['head', 'belly', 1, 'min'],                                     // neck can't fold the head onto the chest
  ['neck', 'pelvis', 1, 'min', 0.5], ['chest', 'hipL', 0.8, 'min', 0.36], ['chest', 'hipR', 0.8, 'min', 0.36], // spine bend
  ['elbowL', 'belly', 1, 'min', 0.2], ['elbowR', 'belly', 1, 'min', 0.2],      // arms stay outside the torso
  ['elbowL', 'pelvis', 1, 'min', 0.2], ['elbowR', 'pelvis', 1, 'min', 0.2],
  ['kneeL', 'belly', 1, 'min', 0.3], ['kneeR', 'belly', 1, 'min', 0.3],        // thighs can't fold into the stomach
  ['kneeL', 'chest', 1, 'min', 0.42], ['kneeR', 'chest', 1, 'min', 0.42],
  ['footL', 'pelvis', 1, 'min', 0.3], ['footR', 'pelvis', 1, 'min', 0.3],
  // range limits as a fraction of the rest length: [shortest, longest]
  ['shoulderL', 'hipR', 0.7, 'range', [0.85, 1.12]], ['shoulderR', 'hipL', 0.7, 'range', [0.85, 1.12]],   // torso twist and side bend
  ['head', 'shoulderL', 0.8, 'range', [0.8, 1.15]], ['head', 'shoulderR', 0.8, 'range', [0.8, 1.15]],       // neck tilt
  ['head', 'pelvis', 0.6, 'range', [0.75, 1.04]],                                                          // spine flex
  ['elbowL', 'shoulderR', 1, 'min', 0.3], ['elbowR', 'shoulderL', 1, 'min', 0.3],                          // arms can't fold across the chest
  ['kneeL', 'kneeR', 1, 'max', 1.15], ['footL', 'footR', 1, 'max', 1.6],                                   // no splits
  ['kneeL', 'hipR', 1, 'min', 0.16], ['kneeR', 'hipL', 1, 'min', 0.16],                                    // legs can't cross through each other
];
// limb links that get joint damping when the body goes limp (so it falls like a body, not a rope)
const LIMBS = [['shoulderL', 'elbowL'], ['elbowL', 'handL'], ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['hipL', 'kneeL'], ['kneeL', 'footL'], ['hipR', 'kneeR'], ['kneeR', 'footR'], ['neck', 'head']];

const REGION = {
  head: 'head', neck: 'head',
  chest: 'body', belly: 'body', shoulderL: 'body', shoulderR: 'body',
  handL: 'guard', handR: 'guard', elbowL: 'guard', elbowR: 'guard',
  pelvis: 'low', hipL: 'low', hipR: 'low', kneeL: 'low', kneeR: 'low', footL: 'low', footR: 'low',
};

// kick / superman: how often he throws them. counter: chance to punish your misses and blocked shots.
// adapt: how much he reads your defensive habits. feint: chance a wind-up is fake, to bait your dodge.
export const DIFFICULTY = {
  easy:     { react: 0.42, block: 0.25, slip: 0.10, aggression: 0.55, telegraph: 0.42, damage: 0.6, power: 0.85, accuracy: 0.09, speed: 1.3,
    kick: 0.1, superman: 0.02, counter: 0.1, adapt: 0, feint: 0 },
  normal:   { react: 0.30, block: 0.42, slip: 0.20, aggression: 0.9, telegraph: 0.32, damage: 0.85, power: 1.0, accuracy: 0.06, speed: 1.6,
    kick: 0.18, superman: 0.04, counter: 0.3, adapt: 0.3, feint: 0.04 },
  hard:     { react: 0.19, block: 0.58, slip: 0.30, aggression: 1.3, telegraph: 0.24, damage: 1.1, power: 1.1, accuracy: 0.035, speed: 1.9,
    kick: 0.24, superman: 0.06, counter: 0.55, adapt: 0.6, feint: 0.1 },
  expert:   { react: 0.15, block: 0.68, slip: 0.38, aggression: 1.6, telegraph: 0.2, damage: 1.25, power: 1.15, accuracy: 0.025, speed: 2.1,
    kick: 0.28, superman: 0.07, counter: 0.75, adapt: 0.85, feint: 0.15 },
  champion: { react: 0.11, block: 0.78, slip: 0.48, aggression: 1.9, telegraph: 0.17, damage: 1.4, power: 1.2, accuracy: 0.015, speed: 2.3,
    kick: 0.3, superman: 0.08, counter: 0.9, adapt: 1, feint: 0.2 },
};

const PUNCHES = {
  jab:    { side: 1, kind: 'straight', wind: 0.04, ext: 0.15, ret: 0.22, aim: 'head', power: 0.85 },
  cross:  { side: -1, kind: 'straight', wind: 0.08, ext: 0.17, ret: 0.26, aim: 'head', power: 1.15 },
  hookL:  { side: 1, kind: 'hook', wind: 0.1, ext: 0.2, ret: 0.26, aim: 'head', power: 1.2 },
  hookR:  { side: -1, kind: 'hook', wind: 0.12, ext: 0.2, ret: 0.28, aim: 'head', power: 1.25 },
  bodyR:  { side: -1, kind: 'straight', wind: 0.08, ext: 0.17, ret: 0.26, aim: 'chest', power: 1.0 },
  upperR: { side: -1, kind: 'upper', wind: 0.12, ext: 0.17, ret: 0.28, aim: 'head', power: 1.3 },
  // leaps in from range: hits like a truck, but the wind-up is long and obvious
  superman: { side: -1, kind: 'superman', wind: 0.45, ext: 0.22, ret: 0.34, aim: 'head', power: 1.6 },
  // roundhouse kicks with the real legs, mostly at your thighs
  kickL:  { side: 1, kind: 'kick', wind: 0.14, ext: 0.22, ret: 0.3, aim: 'legs', power: 1.3 },
  kickR:  { side: -1, kind: 'kick', wind: 0.16, ext: 0.22, ret: 0.32, aim: 'legs', power: 1.4 },
  kickBody: { side: -1, kind: 'kick', wind: 0.18, ext: 0.22, ret: 0.32, aim: 'chest', power: 1.4 },
};
export const PUNCH_LABEL = {
  jab: 'JAB', cross: 'CROSS', hookL: 'LEFT HOOK', hookR: 'RIGHT HOOK', bodyR: 'BODY SHOT', upperR: 'UPPERCUT',
  superman: 'SUPERMAN PUNCH', kickL: 'LEFT KICK', kickR: 'RIGHT KICK', kickBody: 'BODY KICK',
};
const KICK_COMBOS = [['kickR'], ['jab', 'kickR'], ['kickL'], ['jab', 'cross', 'kickR'], ['kickBody'], ['cross', 'kickL']];
const COUNTERS = [['cross'], ['hookR'], ['cross', 'hookL'], ['upperR'], ['hookL', 'cross']];
// what beats each defensive habit
const READS = {
  duck: [['upperR', 'hookL'], ['jab', 'upperR'], ['kickBody']],
  slip: [['hookL', 'hookR'], ['jab', 'hookR'], ['cross', 'hookL']],
  block: [['bodyR', 'hookL'], ['kickR'], ['jab', 'kickL'], ['bodyR', 'kickR']],
  jump: [['kickBody'], ['jab', 'cross']],
};
const pick = (list) => list[Math.floor(Math.random() * list.length)];
function distToSegment(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 1e-9 ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2)) : 0;
  return Math.hypot(p.x - a.x - abx * t, p.z - a.z - abz * t);
}
const COMBOS = [
  ['jab'], ['jab', 'cross'], ['jab', 'jab', 'cross'], ['cross', 'hookL'], ['jab', 'cross', 'hookL'],
  ['bodyR', 'hookL'], ['hookR'], ['upperR', 'hookL'], ['jab', 'bodyR'], ['jab', 'upperR'],
];

const smooth = (u) => u * u * (3 - 2 * u);
const _l = new THREE.Vector3();
const _w = new THREE.Vector3();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _pole = new THREE.Vector3();

export class Opponent {
  /**
   * opts.pilot: drive this body from a Player's inputs instead of the AI. The player's
   * body then moves with exactly the same physics as the AI fighter: grip-limited leg
   * drive, planted feet and recovery steps, balance, stumbles and real ragdoll falls.
   * opts.colors: { skin, shorts, mouthguard }.
   */
  constructor(world, scene, opts = {}) {
    this.world = world;
    this.pilot = opts.pilot || null;
    this.p = {};
    this.list = [];
    this.local = {};
    this.target = {};
    this.lastTarget = {};
    for (const [name, d] of Object.entries(REST)) {
      const part = new Particle(new THREE.Vector3(d[0], d[1], d[2]), {
        mass: d[3], radius: d[4], name, friction: name.startsWith('foot') ? 1.2 : 0.6, damping: 0.003,
      });
      part.omega = d[5];
      part.region = REGION[name];
      part.owner = this;
      this.p[name] = part;
      this.list.push(part);
      world.addParticle(part);
      this.local[name] = new THREE.Vector3(d[0], d[1], d[2]);
      this.target[name] = new THREE.Vector3();
      this.lastTarget[name] = new THREE.Vector3();
    }
    const linked = new Set();
    for (const [a, b, stiffness, mode = 'equal', length = null] of LINKS) {
      if (mode === 'range') {
        const rest = this.p[a].pos.distanceTo(this.p[b].pos);
        world.addConstraint(new DistanceConstraint(this.p[a], this.p[b], { stiffness, mode: 'min', length: rest * length[0] }));
        world.addConstraint(new DistanceConstraint(this.p[a], this.p[b], { stiffness, mode: 'max', length: rest * length[1] }));
      } else world.addConstraint(new DistanceConstraint(this.p[a], this.p[b], { stiffness, mode, length }));
      linked.add(a + '|' + b); linked.add(b + '|' + a);
    }
    this.limbs = LIMBS.map(([a, b]) => [this.p[a], this.p[b]]);
    // Knees only bend forwards.
    for (const s of ['L', 'R']) {
      world.addConstraint(new HingeConstraint(this.p['hip' + s], this.p['knee' + s], this.p['foot' + s], this.p.hipR, this.p.hipL));
    }
    // Self-collision: every pair of body parts that isn't directly joined and doesn't
    // overlap at rest is kept at least (r1 + r2) apart, so limbs can't pass through the body.
    const names = Object.keys(REST);
    this.selfCollisions = 0;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        if (linked.has(a + '|' + b)) continue;
        const pa = this.p[a], pb = this.p[b];
        const minD = pa.radius + pb.radius;
        if (pa.pos.distanceTo(pb.pos) < minD * 1.02) continue;
        world.addConstraint(new DistanceConstraint(pa, pb, { mode: 'min', length: minD, stiffness: 1 }));
        this.selfCollisions++;
      }
    }

    this.hands = {
      L: { side: 1, name: 'handL', elbow: 'elbowL', shoulder: 'shoulderL', punch: null, omega: 18, maxAcc: 90, pole: new THREE.Vector3() },
      R: { side: -1, name: 'handR', elbow: 'elbowR', shoulder: 'shoulderR', punch: null, omega: 18, maxAcc: 90, pole: new THREE.Vector3() },
    };
    this.handList = [this.hands.L, this.hands.R];
    this.p.handL.hand = this.hands.L;
    this.p.handR.hand = this.hands.R;
    // kicks are tracked like a third hand, so blocking, dodging and hit checks treat them the same way
    this.kickSlot = { name: 'kick', punch: null };
    // Hitboxes along the limbs and torso (capsules between particles, sized to the visible body),
    // so a forearm blocks, a shin takes a kick and nothing slips through the gaps between joints.
    const P = this.p;
    const seg = (a, b, r, region, extra = {}) => ({ a: P[a], b: P[b], r, region, name: a + '-' + b, mass: (P[a].mass + P[b].mass) / 2, owner: this, ...extra });
    this.segs = [
      seg('shoulderL', 'elbowL', 0.065, 'guard'), seg('elbowL', 'handL', 0.06, 'guard', { hand: this.hands.L }),
      seg('shoulderR', 'elbowR', 0.065, 'guard'), seg('elbowR', 'handR', 0.06, 'guard', { hand: this.hands.R }),
      seg('neck', 'head', 0.065, 'head'),
      seg('chest', 'belly', 0.15, 'body'), seg('shoulderL', 'shoulderR', 0.08, 'body'),
      seg('belly', 'pelvis', 0.14, 'low'),
      seg('hipL', 'kneeL', 0.09, 'low'), seg('kneeL', 'footL', 0.065, 'low', { kicker: this.kickSlot, name: 'footL' }),
      seg('hipR', 'kneeR', 0.09, 'low'), seg('kneeR', 'footR', 0.065, 'low', { kicker: this.kickSlot, name: 'footR' }),
    ];
    // what a strike meets, in order: the guard first, then the head, body and legs
    const RANK = { guard: 0, head: 1, body: 2, low: 3 };
    this.hurt = [...this.list, ...this.segs].sort((x, y) => RANK[x.region] - RANK[y.region]);

    this.base = new THREE.Vector3();
    this.home = new THREE.Vector3();
    this.com = new THREE.Vector3(); this.comVel = new THREE.Vector3();
    this.plant = { footL: new THREE.Vector3(), footR: new THREE.Vector3() };
    this._stepTo = new THREE.Vector3();
    this.stepping = null; this.support = 1; this.offBalance = 0;
    this.relax = { head: 0, body: 0 };
    this.moveVel = new THREE.Vector3();
    this.desiredVel = new THREE.Vector3();
    this.diff = DIFFICULTY.normal;
    /** Online play: when set, the body is driven by another player's state instead of the AI.
     *  { pos, vel, head, gloves: [left, right], yaw } in world space (their camera yaw). */
    this.remote = null;
    this.onSwing = null;
    this.view = new FighterView(scene, this, opts.colors);
    this.reset(0, -1.6, 0);
  }

  setDifficulty(key) { this.diff = DIFFICULTY[key] || DIFFICULTY.normal; }

  reset(x, z, yaw) {
    this.base.set(x, 0, z);
    this.home.set(x, 0, z);
    this.yaw = yaw; this.desiredYaw = yaw;
    this.moveVel.set(0, 0, 0); this.desiredVel.set(0, 0, 0);
    this.lean = this.leanT = 0; this.slip = this.slipT = 0; this.crouch = this.crouchT = 0; this.twist = this.twistT = 0;
    this.stepPhase = 0; this.clock = 0;
    this.tone = 1; this.daze = 0; this.health = 100;
    this.cons = 100; this.balance = 100; this.lastHitT = -10; this.tripT = 0; this.jumpV = 0;
    this.habits = { duck: 0, slip: 0, block: 0, jump: 0 };
    this.kickSlot.punch = null;
    this.mode = 'idle'; this.tactic = 'stalk'; this.tacticT = 1;
    this.comboQueue = []; this.attackCd = 1.0; this.coverT = 0; this.slipTimer = 0; this.slipDir = 1;
    this.staggerT = 0; this.circleDir = Math.random() < 0.5 ? -1 : 1; this.incoming = null; this.lastPunchAt = -10;
    this.cover = false; this.coverLow = false; this.coverLowT = 0; this.winded = 0;
    for (const h of this.handList) h.punch = null;
    this.stepping = null;
    for (const n of ['footL', 'footR']) { this.toWorld(_l.copy(this.local[n]), this.plant[n]); this.plant[n].y = this.local[n].y; }
    this.computeTargets(1 / 240, null);
    for (const name in this.p) {
      this.p[name].teleport(this.target[name]);
      this.lastTarget[name].copy(this.target[name]);
    }
    this.support = 1; this.offBalance = 0; this.relax.head = this.relax.body = 0;
  }

  resetKeepHealth(x, z, yaw) {
    const { health, knockdowns, cons, habits } = this;
    this.reset(x, z, yaw);
    this.health = health; this.knockdowns = knockdowns; this.cons = Math.max(60, cons); this.habits = habits;
  }

  // ----- frames ------------------------------------------------------------
  toWorld(local, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(this.base.x + local.x * c + local.z * s, this.base.y + local.y, this.base.z - local.x * s + local.z * c);
  }
  dirToWorld(local, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(local.x * c + local.z * s, local.y, -local.x * s + local.z * c);
  }
  get forward() { return _z.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  // ----- per physics step --------------------------------------------------
  preStep(h, ctx) {
    this.clock += h;
    const k = 1 - Math.exp(-h * 20);
    const bounce = this.mode === 'fight' ? 0.012 * (1 + Math.sin(this.clock * Math.PI * 2 * 1.8)) : 0;
    this.lean += (this.leanT - this.lean) * k;
    this.slip += (this.slipT - this.slip) * k;
    this.crouch += (this.crouchT + bounce - this.crouch) * k;
    this.twist += (this.twistT - this.twist) * k;

    const upright = this.mode === 'fight' || this.mode === 'idle';
    if (this.remote && upright) {
      // Follow the other player's feet, slightly extrapolated to hide network delay.
      const r = this.remote;
      _w.set(r.pos.x + r.vel.x * 0.05, 0, r.pos.z + r.vel.z * 0.05);
      this.base.lerp(_w, 1 - Math.exp(-h * 14));
      this.moveVel.copy(r.vel);
      this.base.y += ((r.jumpY || 0) - this.base.y) * (1 - Math.exp(-h * 20));
      let dy = (r.yaw + Math.PI) - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * (1 - Math.exp(-h * 16));
    } else if (upright) {
      if (this.pilot) { this.thinkPilot(h); this.balance = this.pilot.balance; }
      this.balanceStep(h);
      if (this.pilot) this.pilot.balance = this.balance;
      let dy = this.desiredYaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const turn = this.pilot ? 14 : 10;   // you turn your body as fast as you can step it round
      this.yaw += Math.max(-turn * h, Math.min(turn * h, dy));
    } else {
      if (this.pilot) this.thinkPilot(h);
      this.moveVel.set(0, 0, 0);
      this.support = 1;
    }
    if (this.remote) clampToOctagon(this.base, 0.7);
    for (const r in this.relax) this.relax[r] = Math.max(0, this.relax[r] - h);
    // jumping (the superman punch)
    if (this.pilot) this.base.y = this.pilot.jumpY;
    else if (!this.remote && (this.jumpV > 0 || this.base.y > 0)) {
      this.jumpV -= 9.81 * h;
      this.base.y = Math.max(0, this.base.y + this.jumpV * h);
      if (this.base.y === 0) this.jumpV = 0;
    }

    const speed = Math.hypot(this.moveVel.x, this.moveVel.z);
    this.stepPhase += speed * h * 11;

    this.computeTargets(h, ctx);
    this.applyMuscles(h);
  }

  /**
   * Active-ragdoll balance (AI fighter). The body isn't anchored anywhere: its pose
   * follows the real pelvis, its legs push against the floor (as far as grip allows)
   * to move it, and its feet stay planted until a step is needed. Steps are taken
   * to walk and turn, and to catch the body when the capture point (where it would
   * have to put a foot to stop) leaves the feet. Weight is only held up while that
   * balance holds; past it, support fades and it falls.
   */
  balanceStep(h) {
    const p = this.p;
    // centre of mass and its velocity
    let M = 0, cx = 0, cz = 0, vx = 0, vz = 0;
    for (const q of this.list) {
      M += q.mass; cx += q.pos.x * q.mass; cz += q.pos.z * q.mass;
      vx += (q.pos.x - q.prev.x) * q.mass; vz += (q.pos.z - q.prev.z) * q.mass;
    }
    cx /= M; cz /= M; vx /= M * h; vz /= M * h;
    this.com.set(cx, 0, cz); this.comVel.set(vx, 0, vz);

    // the pose frame rides on the real pelvis
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ox = this.slip * 0.15, oz = this.lean * 0.05;
    this.base.x = p.pelvis.pos.x - (ox * c + oz * s);
    this.base.z = p.pelvis.pos.z - (-ox * s + oz * c);

    // which feet are on the floor
    const kick = this.kickSlot.punch;
    const onFloor = (n) => p[n].pos.y < p[n].radius + 0.04 && !(kick && kick.foot === n) && !(this.stepping && this.stepping.foot === n);
    const gL = onFloor('footL'), gR = onFloor('footR');
    const grounded = (gL ? 1 : 0) + (gR ? 1 : 0);

    // capture point vs the support area: both feet (a foot mid-step counts where it's landing,
    // since weight shifts onto it), plus foot size. A kicking foot doesn't count.
    const w0 = Math.sqrt(9.81 / 1.0);
    _w.set(cx + vx / w0, 0, cz + vz / w0);
    const st = this.stepping;
    const fL = st && st.foot === 'footL' ? st.to : this.plant.footL;
    const fR = st && st.foot === 'footR' ? st.to : this.plant.footR;
    let off;
    if (kick) off = _w.distanceTo(_f.copy(kick.foot === 'footL' ? fR : fL).setY(0)) - 0.15;
    else if (grounded || st) off = distToSegment(_w, fL, fR) - 0.15;
    else off = this.base.y > 0.02 ? 0 : 0.3;   // mid-jump: fine; otherwise both feet are off the floor
    this.offBalance += (Math.max(0, off) - this.offBalance) * (1 - Math.exp(-h * 30));
    this.support = grounded || st || this.base.y > 0.02 ? THREE.MathUtils.clamp(1 - this.offBalance / 0.5, 0, 1) : 0.35;
    // being off balance uses up balance (a kick does too); run out, or get knocked
    // further than any step could catch, and you go down
    // a dash is an explosive push-off and a planted stop: the feet grip harder, and you mean to be moving
    const dash = this.pilot && this.pilot.dashT > -0.35;
    if (!dash) this.balance -= this.offBalance * h * (kick ? 60 : 200);
    // (just back on your feet: a moment to find your balance before you can be put down by it again)
    this.steadyT = Math.max(0, (this.steadyT || 0) - h);
    if (this.steadyT > 0) this.balance = Math.max(this.balance, 40);
    if ((this.balance <= 0 || this.offBalance > (dash ? 1.2 : 0.6)) && this.mode === 'fight' && this.steadyT <= 0) { this.trip(); return; }

    // legs push the body toward where the AI wants to go, limited by grip
    if (grounded && this.tone > 0.3) {
      let ax = (this.desiredVel.x - vx) * 11, az = (this.desiredVel.z - vz) * 11;
      // feet can only push (or brake) as hard as their grip allows; off balance, even less
      const lim = 0.85 * 9.81 * (grounded === 2 ? 1 : 0.6) * this.tone * (0.4 + 0.6 * this.support) * (dash ? (this.pilot.dashT > 0 ? 2.6 : 2.0) : 1);
      const al = Math.hypot(ax, az);
      if (al > lim) { ax *= lim / al; az *= lim / al; }
      for (const n of ['pelvis', 'belly', 'chest', 'hipL', 'hipR']) { p[n].force.x += ax * p[n].mass * M / 50; p[n].force.z += az * p[n].mass * M / 50; }
    }
    this.moveVel.copy(this.comVel);

    // stepping
    if (this.stepping) {
      const st = this.stepping;
      st.t += h;
      if (st.t >= st.dur) { this.plant[st.foot].copy(st.to); this.stepping = null; }
    } else if (!kick && this.tone > 0.5 && this.mode === 'fight' || (!kick && this.mode === 'idle')) {
      // where each foot would like to be: its stance spot, a little ahead of where the body is heading
      let best = null, bestErr = 0;
      for (const n of ['footL', 'footR']) {
        this.toWorld(_l.copy(this.local[n]), _x);
        _x.x += vx * 0.2; _x.z += vz * 0.2; _x.y = this.local[n].y;   // step to where the body is going
        const err = Math.hypot(_x.x - this.plant[n].x, _x.z - this.plant[n].z);
        if (err > bestErr) { bestErr = err; best = n; this._stepTo.copy(_x); }
      }
      const urgent = this.offBalance > 0.02;
      if (best && (bestErr > 0.13 || urgent)) {
        if (urgent) {   // reach toward the capture point to catch the fall
          this._stepTo.x += (_w.x - cx) * 0.6; this._stepTo.z += (_w.z - cz) * 0.6;
        }
        const from = this.plant[best];
        const dx = this._stepTo.x - from.x, dz = this._stepTo.z - from.z, d = Math.hypot(dx, dz);
        if (d > 0.62) { this._stepTo.x = from.x + (dx / d) * 0.62; this._stepTo.z = from.z + (dz / d) * 0.62; }
        clampToOctagon(this._stepTo, 0.25);
        this.stepping = { foot: best, from: from.clone(), to: this._stepTo.clone(), t: 0, dur: urgent ? 0.13 : 0.19 };
      }
    }
  }

  /** Put both feet down where they stand now (after a reset or getting up). */
  replant() {
    for (const n of ['footL', 'footR']) this.plant[n].set(this.p[n].pos.x, this.local[n].y, this.p[n].pos.z);
    this.stepping = null;
  }

  computeTargets(h, ctx) {
    const T = this.target;
    const upper = ['head', 'neck', 'chest', 'shoulderL', 'shoulderR'];
    for (const name of upper) {
      _l.copy(this.local[name]);
      _l.x += this.slip; _l.y -= this.crouch; _l.z += this.lean;
      if (name === 'head') { _l.x += this.slip * 0.4; _l.z += this.lean * 0.4; }
      if (name === 'shoulderL') _l.z += this.twist;
      if (name === 'shoulderR') _l.z -= this.twist;
      this.toWorld(_l, T[name]);
    }
    _l.copy(this.local.belly); _l.x += this.slip * 0.5; _l.y -= this.crouch; _l.z += this.lean * 0.5;
    this.toWorld(_l, T.belly);
    for (const name of ['pelvis', 'hipL', 'hipR']) {
      _l.copy(this.local[name]); _l.x += this.slip * 0.15; _l.y -= this.crouch; _l.z += this.lean * 0.05;
      this.toWorld(_l, T[name]);
    }

    // Feet: stance + a simple stepping cycle while moving
    const speed = Math.hypot(this.moveVel.x, this.moveVel.z);
    const amt = Math.min(1, speed * 1.5);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const mvx = this.moveVel.x * c - this.moveVel.z * s;   // move direction in local frame
    const mvz = this.moveVel.x * s + this.moveVel.z * c;
    const ml = Math.hypot(mvx, mvz) || 1;
    const planted = !this.remote && (this.mode === 'fight' || this.mode === 'idle');
    for (const [name, ph] of [['footL', 0], ['footR', Math.PI]]) {
      if (planted) {
        const st = this.stepping;
        if (st && st.foot === name) {
          const u = smooth(Math.min(1, st.t / st.dur));
          T[name].lerpVectors(st.from, st.to, u);
          T[name].y = this.local[name].y + Math.sin(Math.PI * u) * 0.09;
        } else T[name].copy(this.plant[name]);
        T[name].y += this.base.y * 2.1;   // lifted with a jump, knees tucked
        continue;
      }
      const sn = Math.sin(this.stepPhase + ph);
      _l.copy(this.local[name]);
      _l.y += Math.max(0, sn) * 0.09 * amt;
      _l.x += (mvx / ml) * Math.cos(this.stepPhase + ph) * 0.08 * amt;
      _l.z += (mvz / ml) * Math.cos(this.stepPhase + ph) * 0.08 * amt;
      this.toWorld(_l, T[name]);
    }

    // A kicking leg swings through instead
    const kick = this.kickSlot.punch;
    if (kick) {
      if (this.remote) T[kick.foot].copy(this.remote.kickPos);
      else if (this.pilot) T[kick.foot].copy(this.pilot.leg.particle.pos);
      else this.kickTarget(kick, h, T[kick.foot]);
    }

    // Knees via IK
    for (const [hip, knee, foot, side] of [['hipL', 'kneeL', 'footL', 1], ['hipR', 'kneeR', 'footR', -1]]) {
      const kicking = kick && kick.foot === foot;
      this.dirToWorld(_pole.set(side * (kicking ? 0.6 : 0.25), kicking ? 0.6 : 0, 1), _w);
      solveTwoBone(T[hip], T[foot], THIGH, SHIN, _w, T[knee]);
    }

    // Hands & elbows
    for (const hand of this.handList) {
      this.handTarget(hand, h, ctx, T[hand.name]);
      this.dirToWorld(hand.pole, _w);
      solveTwoBone(T[hand.shoulder], T[hand.name], UPPER_ARM, FOREARM, _w, T[hand.elbow]);
    }
  }

  /** Roundhouse kick path for the kicking foot. */
  kickTarget(k, h, out) {
    k.t += h;
    const d = k.def, sd = d.side;
    const X = this.dirToWorld(_l.set(1, 0, 0), _x);  // its left
    const Z = this.forward;
    if (k.t < k.wind) {
      k.phase = 'wind';
      this.toWorld(_l.set(sd * 0.28, 0.5, 0.12), out);   // chamber the knee
      this.twistT = -sd * 0.06; this.leanT = -0.04;
    } else if (k.t < k.wind + d.ext) {
      if (k.phase !== 'ext') { k.phase = 'ext'; this.onSwing?.(this); this.moveVel.addScaledVector(Z, 0.4); }
      const u = smooth((k.t - k.wind) / d.ext);
      _w.copy(k.aim).addScaledVector(X, sd * 0.75).addScaledVector(Z, -0.25);
      _f.copy(k.aim).addScaledVector(X, -sd * 0.35).addScaledVector(Z, 0.15);
      out.lerpVectors(_w, _f, u);
      this.twistT = sd * 0.16; this.leanT = -0.08;
    } else if (k.t < k.wind + d.ext + d.ret) {
      if (k.phase !== 'ret') {
        k.phase = 'ret';
        if (!k.hit && !k.interrupted) this.onWhiff?.(this, this.kickSlot);
      }
      this.toWorld(_l.copy(this.local[k.foot]).setY(0.25), out);
      this.twistT = 0; this.leanT = 0;
    } else {
      this.kickSlot.punch = null;
    }
    return out;
  }

  handTarget(hand, h, ctx, out) {
    const sd = hand.side;
    if (this.remote || this.pilot) {
      // Their left glove is this body's left hand.
      out.copy(this.remote ? this.remote.gloves[sd > 0 ? 0 : 1] : this.pilot.gloves[sd > 0 ? 0 : 1].particle.pos);
      hand.omega = 30; hand.maxAcc = 420;
      hand.pole.set(sd * 0.7, -1, -0.2);
      return out;
    }
    hand.omega = 18; hand.maxAcc = 90;
    hand.pole.set(sd * 0.7, -1, -0.2);
    // guard position (local)
    if (this.cover) _l.set(sd * 0.09, 1.6, 0.24);
    else if (this.coverLow) _l.set(sd * 0.13, 1.08, 0.22);
    else _l.copy(this.local[hand.name]);
    if (this.mode !== 'fight' && this.mode !== 'idle') _l.set(sd * 0.25, 1.0, 0.1);
    _l.y -= Math.min(1, this.daze) * 0.18;
    const fighting = this.mode === 'fight';
    if (fighting && !hand.punch) {
      const kick = this.kickSlot.punch;
      const otherBusy = this.handList.some((o) => o !== hand && o.punch && o.punch.phase !== 'ret');
      if (kick && kick.def.side === sd && kick.phase !== 'ret') { _l.set(sd * 0.33, 1.05, -0.12); hand.pole.set(sd, -0.5, -0.5); }   // counterbalance the kick
      else if (otherBusy || kick) { _l.set(sd * 0.08, 1.53, 0.17); hand.omega = 24; hand.maxAcc = 130; }                           // cover the chin
      else if (!this.cover && !this.coverLow) {                                                                                   // hands breathe in guard
        _l.x += Math.sin(this.clock * 2.1 + sd) * 0.012;
        _l.y += Math.cos(this.clock * 2.6 + sd * 1.3) * 0.014;
      }
    }
    _l.x += this.slip; _l.y -= this.crouch; _l.z += this.lean;
    this.toWorld(_l, out);
    if (this.cover || this.coverLow) { hand.omega = 26; hand.maxAcc = 150; }

    const pu = hand.punch;
    if (!pu) return out;
    pu.t += h;
    const d = pu.def;
    const X = this.dirToWorld(_l.set(1, 0, 0), _x);  // its left
    const Z = this.forward;
    const P = this.diff.power * d.power;
    if (pu.t < pu.wind) {
      pu.phase = 'wind';
      if (pu.feint && pu.t + h >= pu.wind) {   // a fake: pull it back and throw the real one
        hand.punch = null;
        this.comboQueue.unshift(pu.name);
        return out;
      }
      if (d.kind === 'superman') { out.addScaledVector(Z, -0.18); out.y -= 0.12; this.crouchT = 0.2; this.twistT = -sd * 0.08; }
      else if (d.kind === 'hook') { out.addScaledVector(X, sd * 0.16); out.addScaledVector(Z, -0.04); hand.pole.set(sd, 0.3, -0.3); this.twistT = -sd * 0.05; }
      else if (d.kind === 'upper') { out.y -= 0.2; this.crouchT = 0.1; hand.pole.set(sd * 0.5, -1, 0.2); }
      else { out.addScaledVector(Z, -0.09); out.y -= 0.03; this.twistT = -sd * 0.04; }
    } else if (pu.t < pu.wind + d.ext) {
      if (pu.phase !== 'ext') {
        pu.phase = 'ext'; this.onSwing?.(this); this.moveVel.addScaledVector(Z, 0.6);
        if (d.kind === 'superman') { this.jumpV = 2.4; this.moveVel.addScaledVector(Z, 3); this.crouchT = -0.05; }
      }
      const u = (pu.t - pu.wind) / d.ext;
      hand.omega = 34 * Math.min(1.3, P); hand.maxAcc = 320 * P;
      if (d.kind === 'straight' || d.kind === 'superman') {
        _w.subVectors(pu.aim, this.target[hand.shoulder]).normalize();
        out.copy(pu.aim).addScaledVector(_w, 0.3);
        this.leanT = 0.12; this.twistT = sd * 0.09; this.crouchT = 0.04;   // drive from the legs and hips
      } else if (d.kind === 'hook') {
        _w.copy(pu.aim).addScaledVector(X, sd * 0.5).addScaledVector(Z, -0.12);
        _f.copy(pu.aim).addScaledVector(X, -sd * 0.32).addScaledVector(Z, 0.1);
        out.lerpVectors(_w, _f, smooth(u));
        hand.pole.set(sd, 0.4, -0.2);
        this.leanT = 0.08; this.twistT = sd * 0.14; this.crouchT = 0.05;
      } else {
        _w.copy(pu.aim).addScaledVector(Z, -0.1); _w.y -= 0.45;
        _f.copy(pu.aim).addScaledVector(Z, 0.1); _f.y += 0.35;
        out.lerpVectors(_w, _f, smooth(u));
        hand.pole.set(sd * 0.5, -1, 0.3);
        this.leanT = 0.08; this.crouchT = -0.03;
      }
    } else if (pu.t < pu.wind + d.ext + d.ret) {
      if (pu.phase !== 'ret') {
        pu.phase = 'ret';
        if (!pu.hit && !pu.interrupted) this.onWhiff?.(this, hand);
      }
      hand.omega = pu.whiffed ? 9 : 20;
      this.leanT = 0; this.twistT = 0; this.crouchT = 0;
    } else {
      hand.punch = null;
    }
    return out;
  }

  applyMuscles(h) {
    const tone = this.tone;
    const support = this.remote ? 1 : this.support;
    // Muscles are internal: they shape the pose but can't push the whole body around.
    // Only the feet (through the floor) and the legs' drive move it, so a shove keeps its momentum.
    const internal = !this.remote && (this.mode === 'fight' || this.mode === 'idle');
    let sumX = 0, sumZ = 0, sumM = 0;
    for (const name in this.p) {
      const p = this.p[name];
      const T = this.target[name], LT = this.lastTarget[name];
      let w = p.omega, maxAcc = 75;
      if (p.hand) { w = p.hand.omega; maxAcc = p.hand.maxAcc; }
      // arms and head are carried by the torso; the torso and legs only hold weight while balanced
      const carried = p.hand || p.region === 'guard' || name === 'head' || name === 'neck';
      const hold = carried ? 1 : 0.35 + 0.65 * support;
      const grav = Math.min(1, tone * 1.25) * (carried ? 1 : support) * (name.startsWith('foot') ? 0 : 1);
      // a hit relaxes the struck area for a moment: the head snaps, the body folds, then recovers
      if (this.relax.head > 0 && (name === 'head' || name === 'neck')) { w *= 0.35; maxAcc *= 0.3; }
      if (this.relax.body > 0 && (name === 'chest' || name === 'belly')) { w *= 0.55; maxAcc *= 0.5; }
      // in the air the legs tuck up fast (it's how you clear a low kick)
      if (this.base.y > 0.02 && (name.startsWith('foot') || name.startsWith('knee'))) { w = 30; maxAcc = 320; }
      const k = this.kickSlot.punch;
      if (k && k.foot === name) {
        const P = this.remote ? 1 : this.diff.power * k.def.power;
        w = k.phase === 'ext' || this.remote ? 34 : 22; maxAcc = k.phase === 'ext' || this.remote ? 380 * P : 160;
      }
      // target velocity (clamped to avoid spikes when a target jumps)
      _w.subVectors(T, LT).multiplyScalar(1 / h);
      const tv = _w.length();
      if (tv > 8) _w.multiplyScalar(8 / tv);
      _f.subVectors(p.pos, p.prev).multiplyScalar(1 / h); // particle velocity
      _f.subVectors(_w, _f).multiplyScalar(2 * 0.8 * w);  // damping term
      _f.addScaledVector(_l.subVectors(T, p.pos), w * w); // spring term
      const a = _f.length();
      if (a > maxAcc) _f.multiplyScalar(maxAcc / a);
      _f.multiplyScalar(p.mass * tone * hold);
      p.force.add(_f);
      p.force.y += p.mass * G * grav;
      if (internal && !name.startsWith('foot')) { sumX += _f.x; sumZ += _f.z; sumM += p.mass; }
      LT.copy(T);
    }
    // Joint damping: a limp body keeps some resistance in its joints, so limbs swing heavily
    // instead of whipping around like rope. Fades out as muscle tone comes back.
    const jd = 1 - Math.exp(-h * 9 * Math.max(0, 1 - tone * 1.6));
    if (jd > 1e-4) {
      for (const [a, b] of this.limbs) {
        const rx = (b.pos.x - b.prev.x) - (a.pos.x - a.prev.x), ry = (b.pos.y - b.prev.y) - (a.pos.y - a.prev.y), rz = (b.pos.z - b.prev.z) - (a.pos.z - a.prev.z);
        const wa = a.invMass / (a.invMass + b.invMass), wb = 1 - wa;
        a.prev.x -= rx * jd * wa; a.prev.y -= ry * jd * wa; a.prev.z -= rz * jd * wa;
        b.prev.x += rx * jd * wb; b.prev.y += ry * jd * wb; b.prev.z += rz * jd * wb;
      }
    }
    if (internal && sumM > 0) {
      const ax = sumX / sumM, az = sumZ / sumM;
      for (const name in this.p) {
        if (name.startsWith('foot')) continue;
        const p = this.p[name];
        p.force.x -= ax * p.mass; p.force.z -= az * p.mass;
      }
    }
  }

  // ----- AI (per frame) ----------------------------------------------------
  /** big: a superman punch's jump, which he reads much more easily. */
  notifyIncoming(time, low = false, big = false) {
    if (this.mode !== 'fight' || (this.incoming && !big)) return;
    this.incoming = { at: time + this.diff.react * (big ? 0.6 : 1) * (0.8 + Math.random() * 0.5), low, big };
  }

  /** Online: posture follows where the other player holds their head (slips, ducks, leans). */
  thinkRemote(dt) {
    const r = this.remote;
    if (this.mode === 'down' || this.mode === 'tripped') this.tone = Math.max(0, this.tone - dt * 5);
    else if (this.mode === 'rising') {
      this.tone = Math.min(1, this.tone + dt * 0.75);
      if (this.tone >= 1) this.mode = 'fight';
    } else this.tone = 1;
    const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw);   // their forward
    const lx = -Math.cos(r.yaw), lz = Math.sin(r.yaw);    // their left
    const dx = r.head.x - r.pos.x, dz = r.head.z - r.pos.z;
    this.leanT = THREE.MathUtils.clamp((dx * fx + dz * fz) / 1.4, -0.2, 0.3);
    this.slipT = THREE.MathUtils.clamp((dx * lx + dz * lz) / 1.4, -0.3, 0.3);
    this.crouchT = THREE.MathUtils.clamp(1.6 - r.head.y, -0.05, 0.45);
    this.twistT = 0;
    this.cover = false; this.coverLow = false;
    this.desiredVel.set(0, 0, 0);
  }

  /**
   * Your own body: the same muscles, legs and balance as the AI fighter, but steered by
   * your inputs. Posture follows where you hold your head, the hands chase your gloves,
   * and the legs push toward the velocity you ask for.
   */
  thinkPilot(dt) {
    const pl = this.pilot, m = pl.mode;
    if (m === 'down' || m === 'tripped') {
      if (this.mode !== m) { this.mode = m; this.stepping = null; this.tripT = 0; }
      this.tone = Math.max(m === 'tripped' ? 0.03 : 0, this.tone - dt * (m === 'tripped' ? 6 : 5));
    } else if (this.mode === 'down' || this.mode === 'tripped') {
      this.rise(this.health, true);
    } else if (this.mode === 'rising') {
      this.tone = Math.min(1, this.tone + dt * 0.9);
      if (this.tone >= 1 && m !== 'rising') { this.mode = m; this.steadyT = 1; this.offBalance = 0; }
    } else {
      this.mode = m === 'rising' ? 'fight' : m;
      this.tone = 0.45 + 0.55 * Math.pow(pl.cons / 100, 0.7);   // the lower your consciousness, the wobblier
    }
    const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);   // your forward
    const lx = -Math.cos(pl.yaw), lz = Math.sin(pl.yaw);    // your left
    const dx = pl.headBase.x - pl.pos.x, dz = pl.headBase.z - pl.pos.z;
    this.leanT = THREE.MathUtils.clamp((dx * fx + dz * fz) / 1.4, -0.2, 0.3);
    this.slipT = THREE.MathUtils.clamp((dx * lx + dz * lz) / 1.4, -0.3, 0.3);
    this.crouchT = THREE.MathUtils.clamp(pl.standHeight - (pl.headBase.y - pl.jumpY), -0.05, 0.45);
    this.twistT = 0;
    this.cover = false; this.coverLow = false;
    this.cons = pl.cons; this.health = pl.health;
    this.desiredVel.copy(pl.wishVel);
    this.desiredYaw = pl.yaw + Math.PI;
    // your kick, so the standing leg takes the weight and the kicking leg follows your foot
    const lp = pl.leg.punch;
    if (lp && this.mode === 'fight') {
      const foot = pl.leg.side < 0 ? 'footL' : 'footR';
      if (!this.kickSlot.punch) this.kickSlot.punch = { def: { power: 1, kind: 'kick' }, foot, phase: lp.phase, t: 0, wind: 1 };
      this.kickSlot.punch.phase = lp.phase;
    } else this.kickSlot.punch = null;
  }

  /** Your body reacts to a hit you take (the damage is handled by the Player). */
  react(imp, region, h) {
    if (!imp || imp.lengthSq() < 1e-8) return;
    const p = region === 'head' ? this.p.head : this.p.chest;
    p.applyImpulse(imp, h);
    this.relax[region === 'head' ? 'head' : 'body'] = 0.25;
  }

  think(dt, ctx) {
    if (this.pilot) return;   // driven every physics step instead (thinkPilot)
    if (this.remote) { this.thinkRemote(dt); return; }
    this.winded = Math.max(0, (this.winded || 0) - dt * 0.08);
    this.coverT -= dt; this.coverLowT = (this.coverLowT || 0) - dt; this.slipTimer -= dt; this.tacticT -= dt; this.attackCd -= dt; this.staggerT -= dt;
    for (const k in this.habits) this.habits[k] *= Math.exp(-dt * 0.08);

    // consciousness and balance come back when he stops getting hit
    if (this.mode === 'fight' || this.mode === 'idle') {
      if (this.clock - this.lastHitT > 2) this.cons = Math.min(100, this.cons + dt * 5);
      if (!this.kickSlot.punch) this.balance = Math.min(100, this.balance + dt * 28 * (0.5 + 0.5 * this.cons / 100));
    }
    this.daze = Math.max(0, (65 - this.cons) / 35);   // drops his guard and slows him as he fades

    if (this.mode === 'down') this.tone = Math.max(0, this.tone - dt * 5);
    else if (this.mode === 'tripped') {
      this.tone = Math.max(0.03, this.tone - dt * 6);
      this.tripT += dt;
      if (this.tripT > 1.7) this.rise(this.health, true);
    } else if (this.mode === 'rising') {
      this.tone = Math.min(1, this.tone + dt * 0.75);
      if (this.tone >= 1) { this.mode = 'fight'; this.coverT = 1.2; this.tactic = 'retreat'; this.tacticT = 1.2; this.steadyT = 1; this.offBalance = 0; }
    } else this.tone = 0.45 + 0.55 * Math.pow(this.cons / 100, 0.7);   // the lower his consciousness, the wobblier

    const dx = ctx.playerPos.x - this.base.x, dz = ctx.playerPos.z - this.base.z;
    const dist = Math.hypot(dx, dz) || 1e-3;
    const ux = dx / dist, uz = dz / dist;
    this.desiredVel.set(0, 0, 0);
    this.cover = this.coverT > 0;
    this.coverLow = this.coverLowT > 0;
    this.slipT = this.slipTimer > 0 ? this.slipDir * 0.16 : 0;
    if (!this.handList.some((h) => h.punch) && !this.kickSlot.punch) {
      this.leanT = 0; this.twistT = 0; this.crouchT = this.slipTimer > 0 ? 0.07 : 0;
      // dazed: he sways on his feet
      const inst = Math.pow(1 - this.cons / 100, 1.5);
      this.leanT += Math.sin(this.clock * 1.7) * 0.09 * inst;
      this.slipT += Math.sin(this.clock * 1.1 + 1) * 0.12 * inst;
      // a fighter never keeps his head still: small slips and dips in rhythm
      if (this.mode === 'fight') {
        this.slipT += Math.sin(this.clock * 1.6) * 0.035 + Math.sin(this.clock * 3.7) * 0.012;
        this.leanT += Math.sin(this.clock * 2.2 + 0.5) * 0.015;
        this.crouchT += 0.03 + Math.max(0, Math.sin(this.clock * 1.6 + 1.2)) * 0.02;
      }
    }

    if (this.mode === 'idle') {
      this.desiredYaw = Math.atan2(dx, dz);
      const hx = this.home.x - this.base.x, hz = this.home.z - this.base.z;
      const hd = Math.hypot(hx, hz);
      if (hd > 0.1) this.desiredVel.set((hx / hd) * 1.2, 0, (hz / hd) * 1.2);
      return;
    }
    if (this.mode !== 'fight') return;
    this.desiredYaw = Math.atan2(dx, dz);

    // defensive reaction to the player's punches
    if (this.incoming && ctx.time >= this.incoming.at) {
      const r = Math.random() - (this.incoming.big ? 0.35 : 0);
      if (r < this.diff.block) { if (this.incoming.low) this.coverLowT = 0.55; else this.coverT = 0.55; }
      else if (r < this.diff.block + this.diff.slip) { this.slipTimer = 0.35; this.slipDir = Math.random() < 0.5 ? -1 : 1; }
      this.incoming = null;
    }

    const dazed = this.daze > 0.6;
    const speed = this.diff.speed * (dazed ? 0.5 : 1) * (1 - 0.4 * (this.winded || 0));
    const range = 0.96;
    const px = -uz, pz = ux;
    let radial = 0, lateral = 0;

    if (this.staggerT > 0) {
      radial = -0.4; lateral = Math.sin(this.clock * 3) * 0.5;
    } else if (this.tactic === 'stalk') {
      radial = THREE.MathUtils.clamp((dist - range) * 3, -1, 1);
      lateral = this.circleDir * 0.45;
      if (this.tacticT < 0) { this.tacticT = 1 + Math.random() * 2; if (Math.random() < 0.4) this.circleDir *= -1; }
      if (dist < range + 0.15 && this.attackCd <= 0 && !this.cover && !dazed) {
        this.tactic = 'combo';
        this.comboQueue = this.chooseCombo();
      } else if (dist > 1.25 && dist < 1.9 && this.attackCd <= 0 && !dazed && Math.random() < this.diff.superman * dt * 6) {
        this.tactic = 'combo';
        this.comboQueue = ['superman'];   // from range: leap in
      }
    } else if (this.tactic === 'combo') {
      radial = THREE.MathUtils.clamp((dist - (range - 0.06)) * 3, -1, 1);
      const busy = this.handList.some((h) => h.punch && h.punch.phase !== 'ret') || (this.kickSlot.punch && this.kickSlot.punch.phase !== 'ret');
      const reach = this.comboQueue[0] === 'superman' ? 2.0 : 1.2;
      if (this.comboQueue.length && !busy && ctx.time - this.lastPunchAt > 0.12 && dist < reach) {
        this.startPunch(this.comboQueue.shift(), ctx);
      }
      if (!this.comboQueue.length && !this.handList.some((h) => h.punch) && !this.kickSlot.punch) {
        this.tactic = Math.random() < 0.5 ? 'retreat' : 'stalk';
        this.tacticT = 0.4 + Math.random() * 0.6;
        this.attackCd = (0.5 + Math.random() * 1.3) / this.diff.aggression;
      }
      if (dist > (this.comboQueue[0] === 'superman' ? 2.2 : 1.5)) { this.tactic = 'stalk'; this.comboQueue = []; }
    } else if (this.tactic === 'retreat') {
      radial = THREE.MathUtils.clamp((dist - 1.35) * 3, -1, 1);
      lateral = this.circleDir * 0.6;
      if (this.tacticT < 0) { this.tactic = 'stalk'; this.tacticT = 1; }
    }
    // Circle off the fence
    if (Math.hypot(this.base.x, this.base.z) > OCT_APOTHEM - 1.1) { lateral += this.circleDir * 0.6; }

    this.desiredVel.set((ux * radial + px * lateral) * speed, 0, (uz * radial + pz * lateral) * speed);
  }

  /** Pick an attack: kicks, or (on harder levels) whatever beats your habits. */
  chooseCombo() {
    const d = this.diff;
    if (d.adapt > 0 && Math.random() < d.adapt) {
      let best = null, top = 1.5;
      for (const [k, v] of Object.entries(this.habits)) if (v > top) { best = k; top = v; }
      if (best) return [...pick(READS[best])];
    }
    if (Math.random() < d.kick) return [...pick(KICK_COMBOS)];
    return [...pick(COMBOS)];
  }

  /** Your defensive move, seen by the AI (it learns your habits on harder levels). */
  noteHabit(kind) { if (kind in this.habits) this.habits[kind] += 1; }

  /** You missed, or he blocked: a chance to punish it straight away. */
  onOpening(time) {
    if (this.mode !== 'fight' || this.staggerT > 0 || Math.random() > this.diff.counter) return;
    this.tactic = 'combo';
    this.comboQueue = [...pick(COUNTERS)];
    this.attackCd = 0;
    this.lastPunchAt = time - 1;
  }

  startPunch(name, ctx) {
    const def = PUNCHES[name];
    const tele = this.diff.telegraph;
    if (def.kind === 'kick') {
      if (this.kickSlot.punch) return false;
      const tgt = def.aim === 'legs' ? ctx.playerLegs : ctx.playerChest;
      this.kickSlot.punch = { def, name, t: 0, wind: def.wind + tele, aim: tgt.clone(), phase: 'wind', hit: false,
        foot: def.side > 0 ? 'footL' : 'footR' };
      this.lastPunchAt = ctx.time;
      return true;
    }
    const hand = def.side > 0 ? this.hands.L : this.hands.R;
    if (hand.punch) return false;
    const tgt = def.aim === 'head' ? ctx.playerHead : ctx.playerChest;
    const a = this.diff.accuracy;
    const aim = tgt.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a));
    // the superman's wind-up is long and obvious: that's the trade-off for its damage
    const wind = def.wind + tele * (name === 'jab' ? 0.8 : def.kind === 'superman' ? 2 : 1);
    hand.punch = { def, name, t: 0, wind, aim, phase: 'wind', hit: false,
      feint: def.kind !== 'superman' && Math.random() < this.diff.feint };
    this.lastPunchAt = ctx.time;
    return true;
  }

  isPunching() { return this.handList.some((h) => h.punch && h.punch.phase === 'ext') || this.kickSlot.punch?.phase === 'ext'; }

  /** dmg: health. extra.cons / extra.bal: consciousness and balance lost (defaults from region). */
  takeHit(dmg, region, extra = {}) {
    this.health = Math.max(0, this.health - dmg);
    this.cons = Math.max(0, this.cons - (extra.cons ?? (region === 'head' ? dmg * 1.7 : dmg * 0.35)));
    this.balance -= (extra.bal || 0) * (1 + 0.8 * (1 - this.cons / 100));   // dazed fighters are easier to sweep
    this.lastHitT = this.clock;
    this.relax[region === 'head' ? 'head' : 'body'] = Math.min(0.5, 0.15 + dmg * 0.012);
    if (region !== 'head') this.winded = Math.min(1, (this.winded || 0) + dmg * 0.05);
    if (this.balance <= 0 && this.mode === 'fight' && this.cons > 0 && this.health > 0) { this.trip(); return; }
    if (dmg > 5) {
      for (const h of [...this.handList, this.kickSlot]) if (h.punch && h.punch.phase !== 'ret') { h.punch.interrupted = true; h.punch.t = h.punch.wind + h.punch.def.ext; }
      this.comboQueue = [];
      this.staggerT = 0.12 + dmg * 0.015;
      if (Math.random() < 0.5) this.coverT = 0.6;
    }
  }

  knockDown() {
    this.mode = 'down';
    this.knockdowns = (this.knockdowns || 0) + 1;
    for (const h of this.handList) h.punch = null;
    this.kickSlot.punch = null;
    this.comboQueue = [];
  }

  /** Swept off his feet: down briefly, then straight back up (no count). */
  trip() {
    if (this.pilot) {
      if (this.pilot.mode === 'fight') this.pilot.trip();
      if (this.pilot.mode === 'tripped') { this.mode = 'tripped'; this.stepping = null; }
      return;
    }
    this.mode = 'tripped';
    this.tripT = 0;
    this.balance = 70;
    for (const h of this.handList) h.punch = null;
    this.kickSlot.punch = null;
    this.comboQueue = [];
    this.onTrip?.(this);
  }

  rise(health, fromTrip = false) {
    this.mode = 'rising';
    this.offBalance = 0; this.support = 1; this.steadyT = 1.2;
    this.health = health;
    if (!fromTrip) this.cons = Math.max(this.cons, 60);
    this.balance = Math.max(this.balance, 80);
    this.base.set(this.p.pelvis.pos.x, 0, this.p.pelvis.pos.z);
    clampToOctagon(this.base, 0.9);
    // stand up over the feet: put them under the body, then let balance take over
    for (const n of ['footL', 'footR']) { this.toWorld(_l.copy(this.local[n]), this.plant[n]); this.plant[n].y = this.local[n].y; }
    this.stepping = null;
  }
}

// ---------------------------------------------------------------------------
// Visuals: meshes positioned from the particles every frame
// ---------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

function basisQuat(xDir, yDir, out) {
  _bx.copy(xDir).normalize();
  _by.copy(yDir).addScaledVector(_bx, -yDir.dot(_bx)).normalize();
  _bz.crossVectors(_bx, _by);
  _m.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_m);
}

/** The human body template, built once and shared by every fighter. */
let humanTemplate = null;
export function getHumanTemplate() {
  if (!humanTemplate) {
    const J = Object.fromEntries(Object.entries(REST).map(([k, v]) => [k, [v[0], v[1], v[2]]]));
    humanTemplate = buildHumanTemplate(J);
  }
  return humanTemplate;
}

class FighterView {
  constructor(scene, f, colors = {}) {
    this.f = f;
    const C = { skin: 0xb87a55, shorts: 0x9c1020, trim: 0xf2e6c8, hair: 0x1b1210, mouthguard: 0x2060ff, ...colors };
    this.group = new THREE.Group();
    scene.add(this.group);
    // one continuous skinned body, posed from the ragdoll's particles
    this.body = new SkinnedBody(scene, getHumanTemplate(), { skin: C.skin, shorts: C.shorts, trim: C.trim, hair: C.hair });
    this.joints = f.p;   // particle name -> particle; positions read each frame
    this.J = {};

    const dark = toonMaterial({ color: 0x1b1210 });
    const white = toonMaterial({ color: 0xf6f2ea });
    const sphere = new THREE.SphereGeometry(1, 24, 16);
    const add = (geo, mat, parent = this.group) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // cartoon face details ride on the skinned head bone (placed in the rest pose, then carried by the bone)
    this.head = new THREE.Group(); this.group.add(this.head);
    this.head.matrixAutoUpdate = false;
    const hb = this.body.index.head;
    this.headBone = this.body.bones[hb];
    this.headRest = new THREE.Matrix4().copy(getHumanTemplate().rest[hb].m).invert()
      .multiply(new THREE.Matrix4().makeTranslation(REST.head[0], REST.head[1], REST.head[2]));
    for (const sx of [-1, 1]) {
      const eye = add(sphere, white, this.head); eye.scale.set(0.024, 0.026, 0.012); eye.position.set(sx * 0.046, 0.016, 0.106);
      const pupil = add(sphere, dark, this.head); pupil.scale.set(0.011, 0.013, 0.006); pupil.position.set(sx * 0.043, 0.014, 0.117);
      const brow = add(new THREE.BoxGeometry(1, 1, 1), dark, this.head); brow.scale.set(0.044, 0.012, 0.014);
      brow.position.set(sx * 0.047, 0.052, 0.13); brow.rotation.z = sx * -0.25;   // a scowl
    }
    // a set mouth, sitting on the face surface (found from the body mesh), with the gumshield just showing
    const tpl = getHumanTemplate().geometry.getAttribute('position');
    const front = (y0) => {
      let z = 0;
      for (let v = 0; v < tpl.count; v++) if (Math.abs(tpl.getX(v)) < 0.012 && Math.abs(tpl.getY(v) - y0) < 0.008) z = Math.max(z, tpl.getZ(v));
      return z - REST.head[2];
    };
    const my = -0.058, mz = front(REST.head[1] + my);
    const mouth = add(new THREE.BoxGeometry(1, 1, 1), dark, this.head); mouth.scale.set(0.046, 0.013, 0.01); mouth.position.set(0, my, mz - 0.002);
    const gum = add(new THREE.BoxGeometry(1, 1, 1), toonMaterial({ color: C.mouthguard }), this.head); gum.scale.set(0.036, 0.006, 0.01); gum.position.set(0, my + 0.001, mz);

    // 4 oz open-finger MMA gloves (left glove: thumb toward its right, i.e. local -x)
    this.gloves = [];
    for (const side of ['L', 'R']) {
      const { group: g, material: mat } = makeGlove(side === 'L' ? -1 : 1, { glove: 0x18181c, strap: 0xc0141c, skin: C.skin });
      this.group.add(g);
      this.gloves.push({ g, mat, handState: f.hands[side], hand: f.p['hand' + side], elbow: f.p['elbow' + side] });
    }
    // a kicking foot glows as a warning
    this.footGlow = ['L', 'R'].map((side) => {
      const m = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0xff5020, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.scale.set(0.07, 0.06, 0.14);
      this.group.add(m);
      return { m, name: 'foot' + side, foot: f.p['foot' + side], glow: 0 };
    });
  }

  get visible() { return this.group.visible; }
  set visible(v) { this.group.visible = v; this.body.visible = v; }

  update() {
    const p = this.f.p, J = this.J;
    for (const k in p) J[k] = p[k].pos;
    J.hipMid = null;
    this.body.update(J);

    this.head.matrix.multiplyMatrices(this.headBone.matrixWorld, this.headRest);

    for (const g of this.gloves) {
      const fwd = _w.subVectors(g.hand.pos, g.elbow.pos).normalize();
      _bz.copy(fwd);
      _bx.crossVectors(Y, _bz);
      if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
      _bx.normalize();
      _by.crossVectors(_bz, _bx);
      _m.makeBasis(_bx, _by, _bz);
      g.g.quaternion.setFromRotationMatrix(_m);
      g.g.position.copy(g.hand.pos).addScaledVector(fwd, 0.015);
      // Telegraph: the glove about to be thrown glows, brightening as the punch nears
      const pu = g.handState.punch;
      let glow = 0;
      if (pu && pu.phase === 'wind') glow = 0.4 + 2.2 * Math.min(1, pu.t / pu.wind);
      else if (pu && pu.phase === 'ext') glow = 1.2;
      g.glow = (g.glow || 0) + (glow - (g.glow || 0)) * 0.35;
      g.mat.emissive.setRGB(1, pu && pu.def.aim === 'chest' ? 0.55 : 0.18, 0.02);
      g.mat.emissiveIntensity = g.glow;
      g.g.scale.setScalar(1 + g.glow * 0.04);
    }
    const k = this.f.pilot ? null : this.f.kickSlot.punch;   // only his kicks are telegraphed
    for (const fg of this.footGlow) {
      const glow = k && k.foot === fg.name ? (k.phase === 'wind' ? 0.25 + 0.5 * Math.min(1, k.t / k.wind) : k.phase === 'ext' ? 0.55 : 0) : 0;
      fg.glow += (glow - fg.glow) * 0.35;
      fg.m.material.opacity = fg.glow;
      fg.m.visible = fg.glow > 0.01;
      fg.m.position.copy(fg.foot.pos);
      fg.m.rotation.y = this.f.yaw;
    }
  }
}
