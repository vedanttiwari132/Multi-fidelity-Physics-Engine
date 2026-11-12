// A fighter: the brain and the animation, on top of a rigid-body active ragdoll (ragdoll.js).
//
// The AI decides what to do (footwork, combos, defence, reading your habits), and the
// animation turns that into a pose each physics step: where the fists and feet should be,
// how the body leans, slips, crouches and twists. The ragdoll's muscles (joint motors with
// limited strength) then try to reach that pose; the physics decides what really happens.
// The same class is your own body (driven by your inputs, opts.pilot) and, online, the
// other player's body (driven by what they send, this.remote).

import * as THREE from 'three';
import { clampToOctagon, OCT_APOTHEM } from './arena.js';
import { buildHumanTemplate, SkinnedBody, makeGlove, toonMaterial } from './body.js';
import { Ragdoll, JOINTS } from './ragdoll.js';

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
/** Rest pose, in the fighter's own frame (facing +z, its left is +x). */
const LOCAL = Object.fromEntries(Object.entries(JOINTS).map(([k, v]) => [k, V3(v)]));
const STAND_Y = JOINTS.pelvis[1];
const RISE_TIME = 1.1;   // seconds to get up

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

export class Opponent {
  /**
   * opts.pilot: drive this body from a Player's inputs instead of the AI. Your body then moves
   * with exactly the same physics as the AI fighter. opts.colors: { skin, shorts, mouthguard }.
   * opts.index: 0 for your body, 1 for his (collision groups); 2 for the referee.
   */
  constructor(phys, scene, opts = {}) {
    this.phys = phys;
    this.pilot = opts.pilot || null;
    this.index = opts.index ?? (this.pilot ? 0 : 1);
    this.rig = new Ragdoll(phys, this.index, this);
    this.p = this.rig.p;
    this.list = this.rig.points;
    this.hurt = this.rig.colliders;

    this.hands = {
      L: { side: 1, name: 'handL', elbow: 'elbowL', shoulder: 'shoulderL', punch: null, fast: false, pole: new THREE.Vector3(), target: new THREE.Vector3() },
      R: { side: -1, name: 'handR', elbow: 'elbowR', shoulder: 'shoulderR', punch: null, fast: false, pole: new THREE.Vector3(), target: new THREE.Vector3() },
    };
    this.handList = [this.hands.L, this.hands.R];
    // kicks are tracked like a third hand, so blocking, dodging and hit checks treat them the same way
    this.kickSlot = { name: 'kick', punch: null };
    for (const c of this.rig.colliders) {
      if (c.part.startsWith('foreArm')) c.hand = this.hands[c.part.slice(-1)];
      if (c.foot) c.kicker = this.kickSlot;
    }
    this.p.handL.hand = this.hands.L; this.p.handR.hand = this.hands.R;
    this.p.footL.kicker = this.kickSlot; this.p.footR.kicker = this.kickSlot;

    this.base = new THREE.Vector3();
    this.home = new THREE.Vector3();
    this.plant = { footL: new THREE.Vector3(), footR: new THREE.Vector3() };
    this.footT = { footL: new THREE.Vector3(), footR: new THREE.Vector3() };
    this._stepTo = new THREE.Vector3();
    this.stepping = null; this.support = 1; this.offBalance = 0;
    this.relax = { head: 0, body: 0 };
    this.moveVel = new THREE.Vector3();
    this.desiredVel = new THREE.Vector3();
    this.burst = new THREE.Vector3(); this.burstT = 0;
    this.drive = new THREE.Vector3();
    this.diff = DIFFICULTY.normal;
    /** Online play: when set, the body is driven by another player's state instead of the AI.
     *  { pos, vel, head, gloves: [left, right], yaw, kickPos, jumpY } in world space (their camera yaw). */
    this.remote = null;
    this.onSwing = null;
    this.pose = {
      yaw: 0, lean: 0, slip: 0, crouch: 0, twist: 0, tone: 1, support: 1, standY: STAND_Y, relax: this.relax, strong: !!this.pilot,
      hands: { L: { target: this.hands.L.target, pole: new THREE.Vector3(), fast: false }, R: { target: this.hands.R.target, pole: new THREE.Vector3(), fast: false } },
      feet: { L: { target: this.footT.footL, pole: new THREE.Vector3(), kick: false }, R: { target: this.footT.footR, pole: new THREE.Vector3(), kick: false } },
      drive: this.drive, airborne: false, headPitch: 0,
    };
    this.view = new FighterView(scene, this, opts.colors);
    this.reset(0, -1.6, 0);
  }

  setDifficulty(key) { this.diff = DIFFICULTY[key] || DIFFICULTY.normal; }

  reset(x, z, yaw) {
    this.base.set(x, 0, z);
    this.home.set(x, 0, z);
    this.yaw = yaw; this.desiredYaw = yaw;
    this.moveVel.set(0, 0, 0); this.desiredVel.set(0, 0, 0); this.burst.set(0, 0, 0); this.burstT = 0;
    this.lean = this.leanT = 0; this.slip = this.slipT = 0; this.crouch = this.crouchT = 0; this.twist = this.twistT = 0;
    this.clock = 0;
    this.tone = 1; this.daze = 0; this.health = 100;
    this.cons = 100; this.balance = 100; this.lastHitT = -10; this.tripT = 0; this.jumpV = 0; this.steadyT = 0;
    this.habits = { duck: 0, slip: 0, block: 0, jump: 0 };
    this.kickSlot.punch = null;
    this.mode = 'idle'; this.tactic = 'stalk'; this.tacticT = 1;
    this.comboQueue = []; this.attackCd = 1.0; this.coverT = 0; this.slipTimer = 0; this.slipDir = 1;
    this.staggerT = 0; this.circleDir = Math.random() < 0.5 ? -1 : 1; this.incoming = null; this.lastPunchAt = -10;
    this.cover = false; this.coverLow = false; this.coverLowT = 0; this.winded = 0;
    for (const h of this.handList) h.punch = null;
    this.stepping = null;
    this.rig.reset(x, z, yaw);
    for (const n of ['footL', 'footR']) this.toWorld(LOCAL[n === 'footL' ? 'ankleL' : 'ankleR'], this.plant[n]);
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
  /** Compatibility: the centre of mass and its velocity (from the ragdoll). */
  get com() { return this.rig.com; }
  get comVel() { return this.rig.comVel; }

  // ----- per physics step --------------------------------------------------
  preStep(h, ctx) {
    this.clock += h;
    const k = 1 - Math.exp(-h * 20);
    const bounce = this.mode === 'fight' ? 0.012 * (1 + Math.sin(this.clock * Math.PI * 2 * 1.8)) : 0;
    this.lean += (this.leanT - this.lean) * k;
    this.slip += (this.slipT - this.slip) * k;
    this.crouch += (this.crouchT + bounce - this.crouch) * k;
    this.twist += (this.twistT - this.twist) * k;
    this.burstT -= h;
    if (this.mode === 'rising') this.riseT = (this.riseT || 0) + h;

    const upright = this.mode === 'fight' || this.mode === 'idle';
    if (this.pilot) this.thinkPilot(h);
    if (upright || this.mode === 'rising') {
      if (this.remote) {
        // follow the other player's feet (slightly ahead, to hide network delay)
        const r = this.remote;
        _w.set(r.pos.x + r.vel.x * 0.05, 0, r.pos.z + r.vel.z * 0.05);
        this.desiredVel.set(r.vel.x + (_w.x - this.rig.com.x) * 6, 0, r.vel.z + (_w.z - this.rig.com.z) * 6);
        const sp = Math.hypot(this.desiredVel.x, this.desiredVel.z);
        if (sp > 5) this.desiredVel.multiplyScalar(5 / sp);   // (a burst of lag never flings the body)
        this.desiredYaw = r.yaw + Math.PI;
      }
      if (this.pilot) this.balance = this.pilot.balance;
      this.balanceStep(h);
      if (this.pilot) this.pilot.balance = this.balance;
      let dy = this.desiredYaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const turn = this.pilot || this.remote ? 14 : 10;   // you turn your body as fast as you can step it round
      this.yaw += Math.max(-turn * h, Math.min(turn * h, dy));
    } else {
      this.support = 0;
      this.drive.set(0, 0, 0);
      this.base.set(this.rig.p.pelvis.pos.x, 0, this.rig.p.pelvis.pos.z);
    }
    for (const r in this.relax) this.relax[r] = Math.max(0, this.relax[r] - h);
    // jumping (the superman punch; yours comes from the Player)
    if (this.pilot) this.base.y = this.pilot.jumpY;
    else if (this.remote) this.base.y = this.remote.jumpY || 0;
    else if (this.jumpV > 0 || this.base.y > 0) {
      this.jumpV -= 9.81 * h;
      this.base.y = Math.max(0, this.base.y + this.jumpV * h);
      if (this.base.y === 0) this.jumpV = 0;
    }
    // Someone who's down, swept or getting up can't push a standing fighter about (a knocked-out
    // body collapsing into you doesn't knock you over), but stays solid: standing bodies dominate.
    this.rig.setDominance(this.mode === 'fight' || this.mode === 'idle' ? 1 : 0);
    this.moveVel.copy(this.rig.comVel);
    this.computePose(h, ctx);
    this.rig.drive(h, this.pose);
  }

  /**
   * Balance (all upright fighters). The pose frame rides on the real pelvis; the legs push
   * toward where the brain wants to go (as hard as grip allows); feet stay planted until a
   * step is needed: to walk and turn, and to catch the body when the capture point (where
   * it would have to put a foot to stop) leaves the feet. Weight is only held up while that
   * balance holds; past it, support fades and it falls.
   */
  balanceStep(h) {
    const rig = this.rig, p = this.p;
    const cx = rig.com.x, cz = rig.com.z, vx = rig.comVel.x, vz = rig.comVel.z;

    // the pose frame rides on the real pelvis
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ox = this.slip * 0.15, oz = this.lean * 0.05;
    this.base.x = p.pelvis.pos.x - (ox * c + oz * s);
    this.base.z = p.pelvis.pos.z - (-ox * s + oz * c);

    // which feet are on the floor
    const kick = this.kickSlot.punch;
    const onFloor = (n) => rig.grounded[n] && !(kick && kick.foot === n) && !(this.stepping && this.stepping.foot === n);
    const gL = onFloor('footL'), gR = onFloor('footR');
    const grounded = (gL ? 1 : 0) + (gR ? 1 : 0);
    this.pose.airborne = this.base.y > 0.02;

    // capture point vs the support area (a foot mid-step counts where it's landing)
    const w0 = Math.sqrt(9.81 / 1.0);
    _w.set(cx + vx / w0, 0, cz + vz / w0);
    const st = this.stepping;
    const fL = st && st.foot === 'footL' ? st.to : this.plant.footL;
    const fR = st && st.foot === 'footR' ? st.to : this.plant.footR;
    let off;
    if (kick) off = _w.distanceTo(_f.copy(kick.foot === 'footL' ? fR : fL).setY(0)) - 0.15;
    else if (grounded || st) off = distToSegment(_w, fL, fR) - 0.15;
    else off = this.base.y > 0.02 ? 0 : 0.3;
    this.offBalance += (Math.max(0, off) - this.offBalance) * (1 - Math.exp(-h * 30));
    const rising = this.mode === 'rising';
    this.support = rising ? this.tone : (grounded || st || this.base.y > 0.02 ? THREE.MathUtils.clamp(1 - this.offBalance / 0.5, 0, 1) : 0.35);
    // a dash is an explosive push-off and a planted stop: the feet grip harder, and you mean to be moving
    const dash = this.pilot && this.pilot.dashT > -0.35;
    if (!dash && !rising) this.balance -= this.offBalance * h * (kick ? 60 : 200);
    // (just back on your feet: a moment to find your balance before you can be put down by it again)
    this.steadyT = Math.max(0, (this.steadyT || 0) - h);
    if (this.steadyT > 0) this.balance = Math.max(this.balance, 40);
    if ((this.balance <= 0 || this.offBalance > (dash ? 1.2 : 0.6)) && this.mode === 'fight' && this.steadyT <= 0) { this.trip(); return; }
    // already going over (bent far over, or sunk to the floor): that's a fall, whatever the feet say
    const tilt = Math.atan2(Math.hypot(p.neck.pos.x - p.pelvis.pos.x, p.neck.pos.z - p.pelvis.pos.z), p.neck.pos.y - p.pelvis.pos.y);
    if ((tilt > 1.3 || p.pelvis.pos.y < 0.4 + this.base.y) && this.mode !== 'rising' && this.steadyT <= 0) { this.trip(true); return; }

    // the legs push the body toward where it wants to go, limited by grip (off balance, even less)
    this.drive.set(0, 0, 0);
    if (grounded && this.tone > 0.3) {
      const want = _f.copy(this.desiredVel);
      if (this.burstT > 0) want.add(this.burst);
      let ax = (want.x - vx) * 11, az = (want.z - vz) * 11;
      const lim = 0.85 * 9.81 * (grounded === 2 ? 1 : 0.6) * this.tone * (0.4 + 0.6 * this.support) * (dash ? (this.pilot.dashT > 0 ? 2.6 : 2.0) : 1);
      const al = Math.hypot(ax, az);
      if (al > lim) { ax *= lim / al; az *= lim / al; }
      this.drive.set(ax, 0, az);
    }

    // stepping
    if (this.stepping) {
      const s2 = this.stepping;
      s2.t += h;
      if (s2.t >= s2.dur) { this.plant[s2.foot].copy(s2.to); this.stepping = null; }
    } else if (!kick && (this.tone > 0.5 && this.mode === 'fight' || this.mode === 'idle' || rising)) {
      // where each foot would like to be: its stance spot, a little ahead of where the body is heading
      let best = null, bestErr = 0, stretched = false;
      const sp = Math.hypot(vx, vz);
      for (const n of ['footL', 'footR']) {
        this.toWorld(LOCAL[n === 'footL' ? 'ankleL' : 'ankleR'], _x);
        _x.x += vx * 0.2; _x.z += vz * 0.2; _x.y = LOCAL.ankleL.y;
        let err = Math.hypot(_x.x - this.plant[n].x, _x.z - this.plant[n].z);
        // a planted leg that's nearly straight can't hold the body any further: step it now
        const hip = p[n === 'footL' ? 'hipL' : 'hipR'].pos;
        if (Math.hypot(hip.x - this.plant[n].x, hip.z - this.plant[n].z) > 0.3) { err += 1; stretched = true; }
        if (err > bestErr) { bestErr = err; best = n; this._stepTo.copy(_x); }
      }
      const urgent = this.offBalance > 0.02;
      if (best && (bestErr > 0.13 || urgent || stretched)) {
        if (urgent) { this._stepTo.x += (_w.x - cx) * 0.6; this._stepTo.z += (_w.z - cz) * 0.6; }   // reach toward the capture point
        const from = this.plant[best];
        const dx = this._stepTo.x - from.x, dz = this._stepTo.z - from.z, d = Math.hypot(dx, dz);
        if (d > 0.62) { this._stepTo.x = from.x + (dx / d) * 0.62; this._stepTo.z = from.z + (dz / d) * 0.62; }
        clampToOctagon(this._stepTo, 0.25);
        const dur = urgent ? 0.13 : THREE.MathUtils.clamp(0.19 - 0.035 * sp, 0.12, 0.19);
        this.stepping = { foot: best, from: from.clone(), to: this._stepTo.clone(), t: 0, dur };
      }
    }
  }

  /** Put both feet down where they are now (after getting up). */
  replant() {
    for (const n of ['footL', 'footR']) { const f = this.rig.parts[n].body.translation(); this.plant[n].set(f.x, LOCAL.ankleL.y, f.z); }
    this.stepping = null;
  }

  /** The pose the muscles aim for this step: posture, fist and ankle targets. */
  computePose(h, ctx) {
    const pose = this.pose;
    pose.yaw = this.yaw;
    pose.lean = this.lean; pose.slip = this.slip; pose.crouch = this.crouch; pose.twist = this.twist;
    pose.tone = this.tone;
    pose.support = this.support;
    pose.standY = STAND_Y - this.crouch * 0.9 + this.base.y;
    // getting up: the pelvis is brought up from where it lay to standing height along an eased
    // path, over the spot where it lay, while the feet are put under it
    pose.rising = null;
    if (this.mode === 'rising') {
      const u = Math.min(1, (this.riseT || 0) / RISE_TIME);
      pose.rising = u;
      pose.standY = THREE.MathUtils.lerp(this.riseFrom ?? 0.3, STAND_Y, smooth(u));
      pose.anchor = this.riseAt;
      pose.tone = Math.max(this.tone, 0.85);
      pose.support = 1;
    }

    // feet: planted, stepping, lifted with a jump, or kicking
    const kick = this.kickSlot.punch;
    for (const [n, side] of [['footL', 'L'], ['footR', 'R']]) {
      const T = this.footT[n];
      const st = this.stepping;
      if (st && st.foot === n) {
        const u = smooth(Math.min(1, st.t / st.dur));
        T.lerpVectors(st.from, st.to, u);
        T.y = LOCAL.ankleL.y + Math.sin(Math.PI * u) * 0.09;
      } else T.copy(this.plant[n]);
      T.y += this.base.y * 1.6;   // knees tucked in a jump
      const kicking = kick && kick.foot === n;
      if (kicking) {
        if (this.remote) T.copy(this.remote.kickPos);
        else if (this.pilot) T.copy(this.pilot.leg.particle.pos);
        else this.kickTarget(kick, h, T);
      }
      const sd = side === 'L' ? 1 : -1;
      this.dirToWorld(_l.set(sd * (kicking ? 0.6 : 0.2), kicking ? 0.6 : 0, 1), pose.feet[side].pole);
      pose.feet[side].kick = !!kicking;
      pose.feet[side].lifted = !!kicking || !!(st && st.foot === n) || this.base.y > 0.02;
    }
    // fists
    for (const hand of this.handList) {
      this.handTarget(hand, h, ctx, hand.target);
      const s = hand.side > 0 ? 'L' : 'R';
      this.dirToWorld(hand.pole, pose.hands[s].pole);
      pose.hands[s].fast = hand.fast;
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
      if (k.phase !== 'ext') { k.phase = 'ext'; this.onSwing?.(this); this.pushOff(Z, 0.4); }
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
      this.toWorld(_l.copy(LOCAL[k.foot === 'footL' ? 'ankleL' : 'ankleR']).setY(0.3), out);
      this.twistT = 0; this.leanT = 0;
    } else {
      this.kickSlot.punch = null;
      this.replantFoot(k.foot);
    }
    return out;
  }

  /** A foot that's been kicking lands where it is. */
  replantFoot(n) {
    const f = this.rig.parts[n].body.translation();
    this.plant[n].set(f.x, LOCAL.ankleL.y, f.z);
    clampToOctagon(this.plant[n], 0.25);
  }

  /** A burst of footwork in direction dir (stepping into a punch, a leap). */
  pushOff(dir, speed, dur = 0.15) {
    this.burst.copy(dir).multiplyScalar(speed);
    this.burstT = dur;
  }

  handTarget(hand, h, ctx, out) {
    const sd = hand.side;
    hand.fast = false;
    if (this.remote || this.pilot) {
      // their left glove is this body's left hand
      out.copy(this.remote ? this.remote.gloves[sd > 0 ? 0 : 1] : this.pilot.gloves[sd > 0 ? 0 : 1].particle.pos);
      hand.fast = true;
      hand.pole.set(sd * 0.7, -1, -0.2);
      return out;
    }
    hand.pole.set(sd * 0.7, -1, -0.2);
    // guard position (local)
    if (this.cover) _l.set(sd * 0.09, 1.6, 0.26);
    else if (this.coverLow) _l.set(sd * 0.13, 1.08, 0.26);
    else _l.copy(LOCAL[hand.name]);
    if (this.mode !== 'fight' && this.mode !== 'idle') _l.set(sd * 0.25, 1.0, 0.1);
    _l.y -= Math.min(1, this.daze) * 0.18;
    const fighting = this.mode === 'fight';
    if (fighting && !hand.punch) {
      const kick = this.kickSlot.punch;
      const otherBusy = this.handList.some((o) => o !== hand && o.punch && o.punch.phase !== 'ret');
      if (kick && kick.def.side === sd && kick.phase !== 'ret') { _l.set(sd * 0.33, 1.05, -0.12); hand.pole.set(sd, -0.5, -0.5); }   // counterbalance the kick
      else if (otherBusy || kick) { _l.set(sd * 0.08, 1.53, 0.2); hand.fast = true; }                                              // cover the chin
      else if (!this.cover && !this.coverLow) {                                                                                     // hands breathe in guard
        _l.x += Math.sin(this.clock * 2.1 + sd) * 0.012;
        _l.y += Math.cos(this.clock * 2.6 + sd * 1.3) * 0.014;
      }
    }
    _l.x += this.slip; _l.y -= this.crouch; _l.z += this.lean;
    this.toWorld(_l, out);
    if (this.cover || this.coverLow) hand.fast = true;

    const pu = hand.punch;
    if (!pu) return out;
    pu.t += h;
    const d = pu.def;
    const X = this.dirToWorld(_l.set(1, 0, 0), _x);  // its left
    const Z = this.forward;
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
        pu.phase = 'ext'; this.onSwing?.(this); this.pushOff(Z, 1.1, 0.18);   // step into it
        if (d.kind === 'superman') { this.jumpV = 2.4; this.pushOff(Z, 3.4, 0.35); this.crouchT = -0.05; }
      }
      const u = (pu.t - pu.wind) / d.ext;
      hand.fast = true;
      if (d.kind === 'straight' || d.kind === 'superman') {
        _w.subVectors(pu.aim, this.p[hand.shoulder].pos).normalize();
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
      this.leanT = 0; this.twistT = 0; this.crouchT = 0;
    } else {
      hand.punch = null;
    }
    return out;
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
      if (this.riseT >= RISE_TIME + 0.15) { this.tone = 1; this.mode = 'fight'; this.steadyT = 1; }
    } else this.tone = 1;
    const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw);   // their forward
    const lx = -Math.cos(r.yaw), lz = Math.sin(r.yaw);    // their left
    const dx = r.head.x - r.pos.x, dz = r.head.z - r.pos.z;
    this.leanT = THREE.MathUtils.clamp((dx * fx + dz * fz) / 1.4, -0.2, 0.3);
    this.slipT = THREE.MathUtils.clamp((dx * lx + dz * lz) / 1.4, -0.3, 0.3);
    this.crouchT = THREE.MathUtils.clamp(1.6 - r.head.y, -0.05, 0.45);
    this.twistT = 0;
    this.cover = false; this.coverLow = false;
    const kp = this.kickSlot.punch;
    if (kp && !kp.foot) kp.foot = kp.name === 'kickL' ? 'footL' : 'footR';
  }

  /**
   * Your own body: the same muscles, legs and balance as the AI fighter, but steered by
   * your inputs. Posture follows where you hold your head, the fists follow your gloves,
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
      if (this.riseT >= RISE_TIME + 0.15 && m !== 'rising') { this.tone = 1; this.mode = m; this.steadyT = 1; this.offBalance = 0; }
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
    this.pose.headPitch = -pl.pitch * 0.6;
    // your kick: the standing leg takes the weight and the kicking leg follows your foot
    const lp = pl.leg.punch;
    if (lp && this.mode === 'fight') {
      const foot = pl.leg.side < 0 ? 'footL' : 'footR';
      if (!this.kickSlot.punch) this.kickSlot.punch = { def: { power: 1, kind: 'kick' }, foot, phase: lp.phase, t: 0, wind: 1 };
      this.kickSlot.punch.phase = lp.phase;
    } else if (this.kickSlot.punch) { const f = this.kickSlot.punch.foot; this.kickSlot.punch = null; this.replantFoot(f); }
  }

  /** Your body reacts to a hit you take (the damage is handled by the Player). */
  react(imp, region) {
    if (!imp || imp.lengthSq() < 1e-8) return;
    const part = region === 'head' ? 'head' : 'chest';
    this.rig.hit(part, imp, this.p[part === 'head' ? 'head' : 'chest'].pos);
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
      if (this.riseT >= RISE_TIME + 0.15) { this.tone = 1; this.mode = 'fight'; this.coverT = 1.2; this.tactic = 'retreat'; this.tacticT = 1.2; this.steadyT = 1; this.offBalance = 0; }
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
    const range = 0.84;   // (arms are rigid now: 64 cm shoulder to fist, so he has to be in range to land)
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
      const reach = this.comboQueue[0] === 'superman' ? 2.0 : 1.05;
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
    this.stepping = null;
  }

  /** Swept off his feet: down briefly, then straight back up (no count). */
  trip(fell = false) {
    if (this.pilot) {
      if (this.pilot.mode === 'fight') this.pilot.trip(fell);
      if (this.pilot.mode === 'tripped') { this.mode = 'tripped'; this.stepping = null; }
      return;
    }
    this.mode = 'tripped';
    this.tripT = 0;
    this.balance = 70;
    for (const h of this.handList) h.punch = null;
    this.kickSlot.punch = null;
    this.comboQueue = [];
    this.stepping = null;
    this.onTrip?.(this);
  }

  rise(health, fromTrip = false) {
    this.mode = 'rising';
    this.riseT = 0;
    this.riseFrom = this.p.pelvis.pos.y;
    this.riseAt = this.rig.p.pelvis.pos.clone().setY(0);
    this.offBalance = 0; this.support = 0; this.steadyT = 1.4;
    this.health = health;
    if (!fromTrip) this.cons = Math.max(this.cons, 60);
    this.balance = Math.max(this.balance, 80);
    this.base.set(this.p.pelvis.pos.x, 0, this.p.pelvis.pos.z);
    clampToOctagon(this.base, 0.9);
    // get the feet under the body, facing the way the body lies
    for (const n of ['footL', 'footR']) this.toWorld(LOCAL[n === 'footL' ? 'ankleL' : 'ankleR'], this.plant[n]);
    this.stepping = null;
  }
}

// ---------------------------------------------------------------------------
// Visuals: the skinned body rides on the ragdoll's parts
// ---------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

/** The human body template, built once and shared by every fighter. */
let humanTemplate = null;
export function getHumanTemplate() {
  if (!humanTemplate) humanTemplate = buildHumanTemplate(JOINTS);
  return humanTemplate;
}

class FighterView {
  constructor(scene, f, colors = {}) {
    this.f = f;
    const C = { skin: 0xb87a55, shorts: 0x9c1020, trim: 0xf2e6c8, hair: 0x1b1210, mouthguard: 0x2060ff, glove: 0xd42a2a, ...colors };
    this.group = new THREE.Group();
    scene.add(this.group);
    // one continuous skinned body, posed from the ragdoll's parts
    this.body = new SkinnedBody(scene, getHumanTemplate(), { skin: C.skin, shorts: C.shorts, trim: C.trim, hair: C.hair, shirt: C.shirt, trousers: C.trousers });

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
      .multiply(new THREE.Matrix4().makeTranslation(JOINTS.head[0], JOINTS.head[1], JOINTS.head[2]));
    // the face sits on the face surface (found from the body mesh, so it fits the head's shape)
    const tpl = getHumanTemplate().geometry.getAttribute('position');
    const front = (y0, x0 = 0) => {
      let z = -1;
      for (let v = 0; v < tpl.count; v++) if (Math.abs(tpl.getX(v) - x0) < 0.014 && Math.abs(tpl.getY(v) - y0) < 0.01) z = Math.max(z, tpl.getZ(v));
      return z - JOINTS.head[2];
    };
    for (const sx of [-1, 1]) {
      const ey = 0.03, ez = front(JOINTS.head[1] + ey, sx * 0.05);
      const eye = add(sphere, white, this.head); eye.scale.set(0.026, 0.028, 0.012); eye.position.set(sx * 0.05, ey, ez - 0.002);
      const pupil = add(sphere, dark, this.head); pupil.scale.set(0.012, 0.014, 0.006); pupil.position.set(sx * 0.047, ey - 0.002, ez + 0.008);
      const brow = add(new THREE.BoxGeometry(1, 1, 1), dark, this.head); brow.scale.set(0.05, 0.013, 0.014);
      brow.position.set(sx * 0.05, ey + 0.04, front(JOINTS.head[1] + ey + 0.04, sx * 0.05) + 0.002); brow.rotation.z = sx * -0.25;   // a scowl
    }
    // a set mouth with the gumshield just showing
    const my = -0.045, mz = front(JOINTS.head[1] + my);
    const mouth = add(new THREE.BoxGeometry(1, 1, 1), dark, this.head); mouth.scale.set(0.046, 0.013, 0.01); mouth.position.set(0, my, mz - 0.002);
    const gum = add(new THREE.BoxGeometry(1, 1, 1), toonMaterial({ color: C.mouthguard }), this.head); gum.scale.set(0.036, 0.006, 0.01); gum.position.set(0, my + 0.001, mz);

    // 4 oz open-finger MMA gloves (left glove: thumb toward its right, i.e. local -x); the referee has none
    this.gloves = [];
    for (const side of C.noGloves ? [] : ['L', 'R']) {
      const { group: g, material: mat } = makeGlove(side === 'L' ? -1 : 1, { glove: C.glove, strap: 0x1e1e24, band: 0xf6f2ea, skin: C.skin });
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
    // Your body (and the other player's, online) is drawn with its fists exactly on the gloves that
    // really punched: the arms are posed onto them from its shoulders (and stretch a little if they
    // were further than the arm reaches), instead of trailing behind them on their motors.
    const f = this.f;
    let arms = null;
    if (f.pilot || f.remote) {
      arms = this.arms || (this.arms = { L: undefined, R: undefined });
      for (const h of f.handList) {
        const s = h.side > 0 ? 'L' : 'R';
        const glove = f.remote ? f.remote.gloves[h.side > 0 ? 0 : 1] : f.pilot.gloves[h.side > 0 ? 0 : 1].particle.pos;
        arms[s] = f.rig.armPose(s, glove, f.dirToWorld(_l.set(h.side * 0.7, -1, -0.2), _w), 1.45, arms[s]);
      }
    }
    this.body.updateFromRig(f.rig, arms);
    this.head.matrix.multiplyMatrices(this.headBone.matrixWorld, this.headRest);

    for (const g of this.gloves) {
      const a = arms && arms[g.handState.side > 0 ? 'L' : 'R'];
      const hand = a ? a.H : g.hand.pos, elbow = a ? a.E : g.elbow.pos;
      const fwd = _x.subVectors(hand, elbow).normalize();
      _bz.copy(fwd);
      _bx.crossVectors(Y, _bz);
      if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
      _bx.normalize();
      _by.crossVectors(_bz, _bx);
      _m.makeBasis(_bx, _by, _bz);
      g.g.quaternion.setFromRotationMatrix(_m);
      g.g.position.copy(hand).addScaledVector(fwd, 0.015);
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
