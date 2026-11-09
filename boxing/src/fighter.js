// The opponent: an "active ragdoll".
//
// The body is a set of Verlet particles held together by distance constraints.
// It stays upright only because every particle is pulled toward an animated
// target pose by a PD "muscle" spring and its weight is supported by the
// muscles. Muscle tone drops when the fighter is dazed and goes to zero on a
// knockdown, at which point the body simply collapses under gravity.

import * as THREE from 'three';
import { Particle, DistanceConstraint, solveTwoBone } from './physics.js';

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
  handL:     [0.2, 1.24, 0.32, 2.5, 0.11, 18],
  handR:     [-0.2, 1.29, 0.18, 2.5, 0.11, 18],
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
  ['chest', 'belly', 1], ['belly', 'pelvis', 1], ['chest', 'pelvis', 0.6], ['neck', 'belly', 0.4],
  ['shoulderL', 'belly', 0.6], ['shoulderR', 'belly', 0.6],
  ['pelvis', 'hipL', 1], ['pelvis', 'hipR', 1], ['hipL', 'hipR', 1], ['belly', 'hipL', 0.6], ['belly', 'hipR', 0.6],
  ['shoulderL', 'elbowL', 1, 'equal', UPPER_ARM], ['elbowL', 'handL', 1, 'equal', FOREARM],
  ['shoulderR', 'elbowR', 1, 'equal', UPPER_ARM], ['elbowR', 'handR', 1, 'equal', FOREARM],
  ['hipL', 'kneeL', 1, 'equal', THIGH], ['kneeL', 'footL', 1, 'equal', SHIN],
  ['hipR', 'kneeR', 1, 'equal', THIGH], ['kneeR', 'footR', 1, 'equal', SHIN],
  // joint limits (struts that only push)
  ['head', 'chest', 1, 'min'], ['head', 'shoulderL', 1, 'min', 0.2], ['head', 'shoulderR', 1, 'min', 0.2],
  ['shoulderL', 'handL', 1, 'min', 0.14], ['shoulderR', 'handR', 1, 'min', 0.14],
  ['hipL', 'footL', 1, 'min', 0.4], ['hipR', 'footR', 1, 'min', 0.4],
  ['handL', 'handR', 1, 'min', 0.21], ['kneeL', 'kneeR', 1, 'min', 0.16], ['footL', 'footR', 1, 'min', 0.18],
];

const REGION = {
  head: 'head', neck: 'head',
  chest: 'body', belly: 'body', shoulderL: 'body', shoulderR: 'body',
  handL: 'guard', handR: 'guard', elbowL: 'guard', elbowR: 'guard',
  pelvis: 'low', hipL: 'low', hipR: 'low', kneeL: 'low', kneeR: 'low', footL: 'low', footR: 'low',
};

export const DIFFICULTY = {
  easy:   { react: 0.42, block: 0.25, slip: 0.10, aggression: 0.55, telegraph: 0.20, damage: 0.6, power: 0.85, accuracy: 0.09, speed: 1.3 },
  normal: { react: 0.30, block: 0.42, slip: 0.20, aggression: 0.9, telegraph: 0.13, damage: 0.85, power: 1.0, accuracy: 0.06, speed: 1.6 },
  hard:   { react: 0.19, block: 0.58, slip: 0.30, aggression: 1.3, telegraph: 0.08, damage: 1.1, power: 1.1, accuracy: 0.035, speed: 1.9 },
};

const PUNCHES = {
  jab:    { side: 1, kind: 'straight', wind: 0.04, ext: 0.15, ret: 0.22, aim: 'head', power: 0.85 },
  cross:  { side: -1, kind: 'straight', wind: 0.08, ext: 0.17, ret: 0.26, aim: 'head', power: 1.15 },
  hookL:  { side: 1, kind: 'hook', wind: 0.1, ext: 0.2, ret: 0.26, aim: 'head', power: 1.2 },
  hookR:  { side: -1, kind: 'hook', wind: 0.12, ext: 0.2, ret: 0.28, aim: 'head', power: 1.25 },
  bodyR:  { side: -1, kind: 'straight', wind: 0.08, ext: 0.17, ret: 0.26, aim: 'chest', power: 1.0 },
  upperR: { side: -1, kind: 'upper', wind: 0.12, ext: 0.17, ret: 0.28, aim: 'head', power: 1.3 },
};
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
  constructor(world, scene) {
    this.world = world;
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
    for (const [a, b, stiffness, mode = 'equal', length = null] of LINKS) {
      world.addConstraint(new DistanceConstraint(this.p[a], this.p[b], { stiffness, mode, length }));
    }

    this.hands = {
      L: { side: 1, name: 'handL', elbow: 'elbowL', shoulder: 'shoulderL', punch: null, omega: 18, maxAcc: 90, pole: new THREE.Vector3() },
      R: { side: -1, name: 'handR', elbow: 'elbowR', shoulder: 'shoulderR', punch: null, omega: 18, maxAcc: 90, pole: new THREE.Vector3() },
    };
    this.handList = [this.hands.L, this.hands.R];
    this.p.handL.hand = this.hands.L;
    this.p.handR.hand = this.hands.R;

    this.base = new THREE.Vector3();
    this.home = new THREE.Vector3();
    this.moveVel = new THREE.Vector3();
    this.desiredVel = new THREE.Vector3();
    this.diff = DIFFICULTY.normal;
    this.onSwing = null;
    this.view = new FighterView(scene, this);
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
    this.mode = 'idle'; this.tactic = 'stalk'; this.tacticT = 1;
    this.comboQueue = []; this.attackCd = 1.0; this.coverT = 0; this.slipTimer = 0; this.slipDir = 1;
    this.staggerT = 0; this.circleDir = Math.random() < 0.5 ? -1 : 1; this.incoming = null; this.lastPunchAt = -10;
    this.cover = false;
    for (const h of this.handList) h.punch = null;
    this.computeTargets(1 / 240, null);
    for (const name in this.p) {
      this.p[name].teleport(this.target[name]);
      this.lastTarget[name].copy(this.target[name]);
    }
  }

  resetKeepHealth(x, z, yaw) {
    const { health, knockdowns } = this;
    this.reset(x, z, yaw);
    this.health = health; this.knockdowns = knockdowns;
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
    const k = 1 - Math.exp(-h * 12);
    const bounce = this.mode === 'fight' ? 0.012 * (1 + Math.sin(this.clock * Math.PI * 2 * 1.8)) : 0;
    this.lean += (this.leanT - this.lean) * k;
    this.slip += (this.slipT - this.slip) * k;
    this.crouch += (this.crouchT + bounce - this.crouch) * k;
    this.twist += (this.twistT - this.twist) * k;

    const upright = this.mode === 'fight' || this.mode === 'idle';
    if (upright && this.tone > 0.3) {
      this.moveVel.lerp(this.desiredVel, 1 - Math.exp(-h * 8));
      this.base.addScaledVector(this.moveVel, h);
      // Let the stance "give" when the body is shoved: base follows the real pelvis.
      const pel = this.p.pelvis.pos, pt = this.target.pelvis;
      this.base.x += (pel.x - pt.x) * 3 * h;
      this.base.z += (pel.z - pt.z) * 3 * h;
      let dy = this.desiredYaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += Math.max(-6 * h, Math.min(6 * h, dy));
    } else {
      this.moveVel.set(0, 0, 0);
    }
    this.base.x = Math.max(-2.65, Math.min(2.65, this.base.x));
    this.base.z = Math.max(-2.65, Math.min(2.65, this.base.z));

    const speed = Math.hypot(this.moveVel.x, this.moveVel.z);
    this.stepPhase += speed * h * 11;

    this.computeTargets(h, ctx);
    this.applyMuscles(h);
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
    for (const [name, ph] of [['footL', 0], ['footR', Math.PI]]) {
      const sn = Math.sin(this.stepPhase + ph);
      _l.copy(this.local[name]);
      _l.y += Math.max(0, sn) * 0.09 * amt;
      _l.x += (mvx / ml) * Math.cos(this.stepPhase + ph) * 0.08 * amt;
      _l.z += (mvz / ml) * Math.cos(this.stepPhase + ph) * 0.08 * amt;
      this.toWorld(_l, T[name]);
    }

    // Knees via IK
    for (const [hip, knee, foot, side] of [['hipL', 'kneeL', 'footL', 1], ['hipR', 'kneeR', 'footR', -1]]) {
      this.dirToWorld(_pole.set(side * 0.25, 0, 1), _w);
      solveTwoBone(T[hip], T[foot], THIGH, SHIN, _w, T[knee]);
    }

    // Hands & elbows
    for (const hand of this.handList) {
      this.handTarget(hand, h, ctx, T[hand.name]);
      this.dirToWorld(hand.pole, _w);
      solveTwoBone(T[hand.shoulder], T[hand.name], UPPER_ARM, FOREARM, _w, T[hand.elbow]);
    }
  }

  handTarget(hand, h, ctx, out) {
    const sd = hand.side;
    hand.omega = 18; hand.maxAcc = 90;
    hand.pole.set(sd * 0.7, -1, -0.2);
    // guard position (local)
    if (this.cover) _l.set(sd * 0.09, 1.6, 0.24);
    else _l.copy(this.local[hand.name]);
    if (this.mode !== 'fight' && this.mode !== 'idle') _l.set(sd * 0.25, 1.0, 0.1);
    _l.y -= Math.min(1, this.daze) * 0.18;
    _l.x += this.slip; _l.y -= this.crouch; _l.z += this.lean;
    this.toWorld(_l, out);
    if (this.cover) { hand.omega = 26; hand.maxAcc = 150; }

    const pu = hand.punch;
    if (!pu) return out;
    pu.t += h;
    const d = pu.def;
    const X = this.dirToWorld(_l.set(1, 0, 0), _x);  // its left
    const Z = this.forward;
    const P = this.diff.power * d.power;
    if (pu.t < pu.wind) {
      pu.phase = 'wind';
      if (d.kind === 'hook') { out.addScaledVector(X, sd * 0.16); out.addScaledVector(Z, -0.04); hand.pole.set(sd, 0.3, -0.3); this.twistT = -sd * 0.05; }
      else if (d.kind === 'upper') { out.y -= 0.2; this.crouchT = 0.1; hand.pole.set(sd * 0.5, -1, 0.2); }
      else { out.addScaledVector(Z, -0.05); out.y -= 0.02; }
    } else if (pu.t < pu.wind + d.ext) {
      if (pu.phase !== 'ext') { pu.phase = 'ext'; this.onSwing?.(this); this.moveVel.addScaledVector(Z, 0.6); }
      const u = (pu.t - pu.wind) / d.ext;
      hand.omega = 34 * P; hand.maxAcc = 320 * P;
      if (d.kind === 'straight') {
        _w.subVectors(pu.aim, this.target[hand.shoulder]).normalize();
        out.copy(pu.aim).addScaledVector(_w, 0.3);
        this.leanT = 0.12; this.twistT = sd * 0.07;
      } else if (d.kind === 'hook') {
        _w.copy(pu.aim).addScaledVector(X, sd * 0.5).addScaledVector(Z, -0.12);
        _f.copy(pu.aim).addScaledVector(X, -sd * 0.32).addScaledVector(Z, 0.1);
        out.lerpVectors(_w, _f, smooth(u));
        hand.pole.set(sd, 0.4, -0.2);
        this.leanT = 0.08; this.twistT = sd * 0.1;
      } else {
        _w.copy(pu.aim).addScaledVector(Z, -0.1); _w.y -= 0.45;
        _f.copy(pu.aim).addScaledVector(Z, 0.1); _f.y += 0.35;
        out.lerpVectors(_w, _f, smooth(u));
        hand.pole.set(sd * 0.5, -1, 0.3);
        this.leanT = 0.08; this.crouchT = -0.03;
      }
    } else if (pu.t < pu.wind + d.ext + d.ret) {
      pu.phase = 'ret';
      hand.omega = 20;
      this.leanT = 0; this.twistT = 0; this.crouchT = 0;
    } else {
      hand.punch = null;
    }
    return out;
  }

  applyMuscles(h) {
    const tone = this.tone;
    const grav = Math.min(1, tone * 1.25);
    for (const name in this.p) {
      const p = this.p[name];
      const T = this.target[name], LT = this.lastTarget[name];
      let w = p.omega, maxAcc = 75;
      if (p.hand) { w = p.hand.omega; maxAcc = p.hand.maxAcc; }
      // target velocity (clamped to avoid spikes when a target jumps)
      _w.subVectors(T, LT).multiplyScalar(1 / h);
      const tv = _w.length();
      if (tv > 8) _w.multiplyScalar(8 / tv);
      _f.subVectors(p.pos, p.prev).multiplyScalar(1 / h); // particle velocity
      _f.subVectors(_w, _f).multiplyScalar(2 * 0.8 * w);  // damping term
      _f.addScaledVector(_l.subVectors(T, p.pos), w * w); // spring term
      const a = _f.length();
      if (a > maxAcc) _f.multiplyScalar(maxAcc / a);
      p.force.addScaledVector(_f, p.mass * tone);
      p.force.y += p.mass * G * grav;
      LT.copy(T);
    }
  }

  // ----- AI (per frame) ----------------------------------------------------
  notifyIncoming(time) {
    if (this.mode !== 'fight' || this.incoming) return;
    this.incoming = { at: time + this.diff.react * (0.8 + Math.random() * 0.5) };
  }

  think(dt, ctx) {
    this.daze = Math.max(0, this.daze - dt * 0.22);
    this.coverT -= dt; this.slipTimer -= dt; this.tacticT -= dt; this.attackCd -= dt; this.staggerT -= dt;

    if (this.mode === 'down') this.tone = Math.max(0, this.tone - dt * 5);
    else if (this.mode === 'rising') {
      this.tone = Math.min(1, this.tone + dt * 0.75);
      if (this.tone >= 1) { this.mode = 'fight'; this.coverT = 1.2; this.tactic = 'retreat'; this.tacticT = 1.2; }
    } else this.tone = THREE.MathUtils.clamp(1 - this.daze * 0.45, 0.5, 1);

    const dx = ctx.playerPos.x - this.base.x, dz = ctx.playerPos.z - this.base.z;
    const dist = Math.hypot(dx, dz) || 1e-3;
    const ux = dx / dist, uz = dz / dist;
    this.desiredVel.set(0, 0, 0);
    this.cover = this.coverT > 0;
    this.slipT = this.slipTimer > 0 ? this.slipDir * 0.16 : 0;
    if (!this.handList.some((h) => h.punch)) {
      this.leanT = 0; this.twistT = 0; this.crouchT = this.slipTimer > 0 ? 0.07 : 0;
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
      const r = Math.random();
      if (r < this.diff.block) this.coverT = 0.55;
      else if (r < this.diff.block + this.diff.slip) { this.slipTimer = 0.35; this.slipDir = Math.random() < 0.5 ? -1 : 1; }
      this.incoming = null;
    }

    const dazed = this.daze > 0.6;
    const speed = this.diff.speed * (dazed ? 0.5 : 1);
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
        this.comboQueue = [...COMBOS[Math.floor(Math.random() * COMBOS.length)]];
      }
    } else if (this.tactic === 'combo') {
      radial = THREE.MathUtils.clamp((dist - (range - 0.06)) * 3, -1, 1);
      const busy = this.handList.some((h) => h.punch && h.punch.phase !== 'ret');
      if (this.comboQueue.length && !busy && ctx.time - this.lastPunchAt > 0.12 && dist < 1.2) {
        this.startPunch(this.comboQueue.shift(), ctx);
      }
      if (!this.comboQueue.length && !this.handList.some((h) => h.punch)) {
        this.tactic = Math.random() < 0.5 ? 'retreat' : 'stalk';
        this.tacticT = 0.4 + Math.random() * 0.6;
        this.attackCd = (0.5 + Math.random() * 1.3) / this.diff.aggression;
      }
      if (dist > 1.5) { this.tactic = 'stalk'; this.comboQueue = []; }
    } else if (this.tactic === 'retreat') {
      radial = THREE.MathUtils.clamp((dist - 1.35) * 3, -1, 1);
      lateral = this.circleDir * 0.6;
      if (this.tacticT < 0) { this.tactic = 'stalk'; this.tacticT = 1; }
    }
    // Back away from the ropes
    const edge = Math.max(Math.abs(this.base.x), Math.abs(this.base.z));
    if (edge > 2.3) { lateral += this.circleDir * 0.6; }

    this.desiredVel.set((ux * radial + px * lateral) * speed, 0, (uz * radial + pz * lateral) * speed);
  }

  startPunch(name, ctx) {
    const def = PUNCHES[name];
    const hand = def.side > 0 ? this.hands.L : this.hands.R;
    if (hand.punch) return false;
    const tgt = def.aim === 'head' ? ctx.playerHead : ctx.playerChest;
    const a = this.diff.accuracy;
    const aim = tgt.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a));
    hand.punch = { def, name, t: 0, wind: def.wind + this.diff.telegraph, aim, phase: 'wind', hit: false };
    this.lastPunchAt = ctx.time;
    return true;
  }

  isPunching() { return this.handList.some((h) => h.punch && h.punch.phase === 'ext'); }

  takeHit(dmg, region) {
    this.health = Math.max(0, this.health - dmg);
    if (region === 'head') this.daze += dmg * 0.035;
    if (dmg > 5) {
      for (const h of this.handList) if (h.punch && h.punch.phase !== 'ret') h.punch.t = h.punch.wind + h.punch.def.ext;
      this.comboQueue = [];
      this.staggerT = 0.12 + dmg * 0.015;
      if (Math.random() < 0.5) this.coverT = 0.6;
    }
  }

  knockDown() {
    this.mode = 'down';
    this.knockdowns = (this.knockdowns || 0) + 1;
    for (const h of this.handList) h.punch = null;
    this.comboQueue = [];
  }

  rise(health) {
    this.mode = 'rising';
    this.health = health;
    this.daze = 0.4;
    this.base.set(this.p.pelvis.pos.x, 0, this.p.pelvis.pos.z);
    this.base.x = Math.max(-2.5, Math.min(2.5, this.base.x));
    this.base.z = Math.max(-2.5, Math.min(2.5, this.base.z));
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

class FighterView {
  constructor(scene, f) {
    this.f = f;
    this.group = new THREE.Group();
    scene.add(this.group);
    const skin = new THREE.MeshStandardMaterial({ color: 0xb87a55, roughness: 0.55 });
    const shorts = new THREE.MeshStandardMaterial({ color: 0x9c1020, roughness: 0.4, metalness: 0.1 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xf2e6c8, roughness: 0.5 });
    const glove = new THREE.MeshPhysicalMaterial({ color: 0x141414, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.25 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1210, roughness: 0.8 });
    const sphere = new THREE.SphereGeometry(1, 24, 16);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
    const add = (geo, mat, parent = this.group) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    this.limbs = [];
    const limb = (a, b, r0, mat) => {
      const m = add(cyl, mat);
      this.limbs.push({ m, a: f.p[a], b: f.p[b], r: r0 });
    };
    limb('neck', 'head', 0.06, skin);
    limb('shoulderL', 'elbowL', 0.058, skin); limb('shoulderR', 'elbowR', 0.058, skin);
    limb('elbowL', 'handL', 0.048, skin); limb('elbowR', 'handR', 0.048, skin);
    limb('hipL', 'kneeL', 0.08, skin); limb('hipR', 'kneeR', 0.08, skin);
    limb('kneeL', 'footL', 0.058, skin); limb('kneeR', 'footR', 0.058, skin);

    this.joints = [];
    for (const [n, r] of [['shoulderL', 0.075], ['shoulderR', 0.075], ['elbowL', 0.055], ['elbowR', 0.055], ['kneeL', 0.068], ['kneeR', 0.068]]) {
      const m = add(sphere, skin); m.scale.setScalar(r);
      this.joints.push({ m, p: f.p[n] });
    }

    this.chest = add(sphere, skin); this.chest.scale.set(0.21, 0.19, 0.13);
    this.abs = add(sphere, skin); this.abs.scale.set(0.165, 0.17, 0.115);
    this.shorts = add(sphere, shorts); this.shorts.scale.set(0.19, 0.17, 0.14);
    this.belt = add(cyl, trim); this.belt.scale.set(0.18, 0.05, 0.13);

    // Head with a simple face
    this.head = new THREE.Group(); this.group.add(this.head);
    const skull = add(sphere, skin, this.head); skull.scale.set(0.105, 0.125, 0.115);
    const hair = add(sphere, dark, this.head); hair.scale.set(0.108, 0.07, 0.112); hair.position.set(0, 0.06, -0.01);
    for (const sx of [-1, 1]) {
      const eye = add(sphere, dark, this.head); eye.scale.setScalar(0.014); eye.position.set(sx * 0.038, 0.02, 0.103);
      const brow = add(sphere, dark, this.head); brow.scale.set(0.03, 0.008, 0.01); brow.position.set(sx * 0.04, 0.045, 0.104);
      const ear = add(sphere, skin, this.head); ear.scale.set(0.015, 0.03, 0.022); ear.position.set(sx * 0.105, 0.0, 0.0);
    }
    const nose = add(sphere, skin, this.head); nose.scale.set(0.02, 0.028, 0.025); nose.position.set(0, -0.005, 0.118);
    const guard = add(sphere, new THREE.MeshStandardMaterial({ color: 0x2060ff, roughness: 0.3 }), this.head);
    guard.scale.set(0.045, 0.015, 0.02); guard.position.set(0, -0.06, 0.1);

    this.gloves = [];
    for (const side of ['L', 'R']) {
      const g = new THREE.Group(); this.group.add(g);
      const body = add(sphere, glove, g); body.scale.set(0.1, 0.095, 0.125);
      const thumb = add(sphere, glove, g); thumb.scale.set(0.035, 0.04, 0.06);
      thumb.position.set(side === 'L' ? -0.07 : 0.07, 0.04, 0.02);
      const cuff = add(cyl, trim, g); cuff.scale.set(0.07, 0.09, 0.07); cuff.rotation.x = Math.PI / 2; cuff.position.z = -0.12;
      this.gloves.push({ g, hand: f.p['hand' + side], elbow: f.p['elbow' + side] });
    }
    this.shoes = [];
    for (const side of ['L', 'R']) {
      const s = add(new THREE.BoxGeometry(0.1, 0.08, 0.25), shoe);
      this.shoes.push({ m: s, foot: f.p['foot' + side], knee: f.p['knee' + side] });
    }
  }

  update() {
    const p = this.f.p;
    for (const l of this.limbs) {
      _bx.subVectors(l.b.pos, l.a.pos);
      const len = _bx.length() || 1e-4;
      l.m.position.addVectors(l.a.pos, l.b.pos).multiplyScalar(0.5);
      l.m.quaternion.setFromUnitVectors(Y, _bx.multiplyScalar(1 / len));
      l.m.scale.set(l.r, len, l.r);
    }
    for (const j of this.joints) j.m.position.copy(j.p.pos);

    const right = _w.subVectors(p.shoulderL.pos, p.shoulderR.pos);
    const up = _f.subVectors(p.neck.pos, p.belly.pos);
    basisQuat(right, up, _q);
    this.chest.quaternion.copy(_q); this.chest.position.copy(p.chest.pos).addScaledVector(_by, 0.02);
    this.abs.quaternion.copy(_q); this.abs.position.copy(p.belly.pos);

    basisQuat(_w.subVectors(p.hipL.pos, p.hipR.pos), _f.subVectors(p.belly.pos, p.pelvis.pos), _q);
    this.shorts.quaternion.copy(_q); this.shorts.position.copy(p.pelvis.pos).addScaledVector(_by, -0.02);
    this.belt.quaternion.copy(_q); this.belt.position.copy(p.pelvis.pos).addScaledVector(_by, 0.11);

    basisQuat(_w.subVectors(p.shoulderL.pos, p.shoulderR.pos), _f.subVectors(p.head.pos, p.neck.pos), _q);
    this.head.quaternion.copy(_q); this.head.position.copy(p.head.pos);

    for (const g of this.gloves) {
      const fwd = _w.subVectors(g.hand.pos, g.elbow.pos).normalize();
      _bz.copy(fwd);
      _bx.crossVectors(Y, _bz);
      if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
      _bx.normalize();
      _by.crossVectors(_bz, _bx);
      _m.makeBasis(_bx, _by, _bz);
      g.g.quaternion.setFromRotationMatrix(_m);
      g.g.position.copy(g.hand.pos);
    }
    for (const s of this.shoes) {
      const fwdx = Math.sin(this.f.yaw), fwdz = Math.cos(this.f.yaw);
      _bz.set(fwdx, 0, fwdz);
      _by.subVectors(s.knee.pos, s.foot.pos).normalize();
      _bx.crossVectors(_by, _bz).normalize();
      _bz.crossVectors(_bx, _by);
      _m.makeBasis(_bx, _by, _bz);
      s.m.quaternion.setFromRotationMatrix(_m);
      s.m.position.copy(s.foot.pos).addScaledVector(_bz, 0.05);
      s.m.position.y -= 0.02;
    }
  }
}
