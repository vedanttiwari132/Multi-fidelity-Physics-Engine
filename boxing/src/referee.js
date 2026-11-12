// The referee: a third rigid-body ragdoll in the cage, with the same body, muscles and
// balance as the fighters, but a referee's brain. He keeps to the side of the action,
// backs off when the fighters come at him, and stands over a fighter who's down for the
// count. He never fights, but he's solid, and stray punches and kicks from either fighter
// hurt him. Knock him out and both fighters are knocked out with him (see main.js).

import * as THREE from 'three';
import { Opponent } from './fighter.js';
import { clampToOctagon } from './arena.js';

const _t = new THREE.Vector3(), _m = new THREE.Vector3(), _p = new THREE.Vector3(), _r = new THREE.Vector3();
const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

export class Referee extends Opponent {
  constructor(phys, scene) {
    super(phys, scene, {
      index: 2,
      // black shirt, grey trousers, black belt and shoes (trim)
      colors: { skin: 0xc8916a, shorts: 0x3a3b42, trim: 0x101012, hair: 0x8c8c8c, shirt: 0x15161c, trousers: true, mouthguard: 0x3a1a14, noGloves: true },
    });
    this.isReferee = true;
    this.active = true;
    this.side = 1;
    this.countArm = 0;
  }

  reset(x, z, yaw) {
    super.reset(x, z, yaw);
    this.mode = 'idle';
  }

  /** In or out of the cage (out: his bodies leave the physics world and he isn't drawn). */
  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    for (const p of this.rig.list) p.body.setEnabled(on);
    this.view.visible = on;
  }

  /**
   * ctx: { a, b (the fighters' positions), down (position of a fighter who's down, or null),
   *        counting (true while he counts), time }
   */
  think(dt, ctx) {
    if (this.net) { this.followNet(dt); return; }
    if (this.mode === 'down') { this.tone = Math.max(0, this.tone - dt * 5); return; }
    if (this.mode === 'tripped') {
      this.tone = Math.max(0.03, this.tone - dt * 6);
      this.tripT += dt;
      if (this.tripT > 1.9) this.rise(this.health, true);
      return;
    }
    if (this.mode === 'rising') {
      this.tone = Math.min(1, this.tone + dt * 0.75);
      if (this.riseT >= 1.25) { this.tone = 1; this.mode = 'idle'; this.steadyT = 1; this.offBalance = 0; }
      return;
    }
    // he gets his wits back when he stops getting hit
    if (this.clock - this.lastHitT > 2) this.cons = Math.min(100, this.cons + dt * 4);
    this.balance = Math.min(100, this.balance + dt * 25);
    this.tone = 0.45 + 0.55 * Math.pow(this.cons / 100, 0.7);
    this.daze = Math.max(0, (65 - this.cons) / 35);

    const A = ctx.a, B = ctx.b;
    _m.addVectors(A, B).multiplyScalar(0.5).setY(0);
    let tx, tz;
    if (ctx.down) {
      // over the fighter who's down, a little way off
      _r.subVectors(this.base, ctx.down).setY(0);
      if (_r.lengthSq() < 1e-4) _r.set(1, 0, 0);
      _r.normalize();
      tx = ctx.down.x + _r.x * 1.15; tz = ctx.down.z + _r.z * 1.15;
    } else {
      // beside the action: off the line between them, on whichever side he's on
      const dx = B.x - A.x, dz = B.z - A.z, l = Math.hypot(dx, dz) || 1;
      const px = -dz / l, pz = dx / l;
      const s = (this.base.x - _m.x) * px + (this.base.z - _m.z) * pz;
      if (Math.abs(s) > 0.4) this.side = Math.sign(s);
      tx = _m.x + px * this.side * 1.75; tz = _m.z + pz * this.side * 1.75;
    }
    _t.set(tx, 0, tz);
    clampToOctagon(_t, 0.9);
    // walk there (no rush), and get out of the fighters' way
    this.desiredVel.set((_t.x - this.base.x) * 1.4, 0, (_t.z - this.base.z) * 1.4);
    for (const f of [A, B]) {
      _p.subVectors(this.base, f).setY(0);
      const d = _p.length();
      if (d < 1.15 && d > 1e-3) this.desiredVel.addScaledVector(_p, ((1.15 - d) / d) * 4);
    }
    const sp = this.desiredVel.length();
    if (sp > 1.8) this.desiredVel.multiplyScalar(1.8 / sp);
    // watch the fight
    const look = ctx.down || _m;
    this.desiredYaw = Math.atan2(look.x - this.base.x, look.z - this.base.z);
    // a ref's stance: upright, a slight crouch, a dazed sway if he's been hit
    const inst = Math.pow(1 - this.cons / 100, 1.5);
    this.leanT = 0.03 + Math.sin(this.clock * 1.7) * 0.09 * inst;
    this.slipT = Math.sin(this.clock * 1.1 + 1) * 0.12 * inst;
    this.crouchT = ctx.down ? 0.12 : 0.03;
    this.twistT = 0;
    // counting: his right arm chops down once a second
    this.counting = !!ctx.counting;
    this.countArm = this.counting ? (ctx.time % 1) : 0;
  }

  /**
   * Online (guest): the host runs the referee, and this copy follows what the host sends:
   * where he is, which way he faces, whether he's down, and when he's counting.
   * this.net: { pos, yaw, mode, counting, cons }.
   */
  followNet(dt) {
    const t = this.net;
    if (t.mode === 'down' && this.mode !== 'down') this.knockDown();
    else if (t.mode === 'tripped' && (this.mode === 'idle' || this.mode === 'fight')) this.trip();
    else if ((t.mode === 'idle' || t.mode === 'fight' || t.mode === 'rising') && (this.mode === 'down' || this.mode === 'tripped')) this.rise(this.health, true);
    if (this.mode === 'down' || this.mode === 'tripped') { this.tone = Math.max(this.mode === 'tripped' ? 0.03 : 0, this.tone - dt * 5); return; }
    if (this.mode === 'rising') {
      this.tone = Math.min(1, this.tone + dt * 0.75);
      if (this.riseT >= 1.25) { this.tone = 1; this.mode = 'idle'; this.steadyT = 1; }
      return;
    }
    this.cons = t.cons;
    this.tone = 0.45 + 0.55 * Math.pow(this.cons / 100, 0.7);
    // walk to where the host has him (a little ahead of the error, and no faster than he walks)
    this.desiredVel.set((t.pos.x - this.base.x) * 3, 0, (t.pos.z - this.base.z) * 3);
    const sp = this.desiredVel.length();
    if (sp > 2.2) this.desiredVel.multiplyScalar(2.2 / sp);
    this.desiredYaw = t.yaw;
    this.leanT = 0.03; this.slipT = 0; this.twistT = 0; this.crouchT = t.counting ? 0.12 : 0.03;
    this.counting = t.counting;
    this.countArm = this.counting ? (performance.now() / 1000) % 1 : 0;
  }

  handTarget(hand, h, ctx, out) {
    const sd = hand.side;
    hand.fast = false;
    hand.pole.set(sd * 0.7, -1, -0.3);
    _p.set(sd * 0.22, 1.0, 0.16);          // hands relaxed in front, ready to step in
    if (this.mode !== 'idle' && this.mode !== 'fight') _p.set(sd * 0.25, 0.95, 0.05);
    if (this.counting && sd < 0) {         // the count: arm raised in front, then a chop down
      const u = this.countArm;
      const y = u < 0.5 ? 1.62 : 1.62 - smoothstep((u - 0.5) / 0.35) * 0.5;
      _p.set(-0.24, y, 0.42);
      hand.pole.set(-0.6, -0.5, -0.6);   // elbow out to the side and a little back, not twisted over the head
      hand.fast = true;
    }
    _p.y -= this.crouch;
    return this.toWorld(_p, out);
  }

  isPunching() { return false; }
}
