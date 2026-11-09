// First-person player.
//
// Your gloves are real particles in the physics world (3 kg each, the effective
// mass of fist + forearm). A PD controller pulls each glove toward a target
// that the punch animation moves around; arm length is a rope-style distance
// constraint to a shoulder anchor. Damage therefore comes from the glove's
// actual impact velocity: range, timing, footwork and stamina all matter.

import * as THREE from 'three';
import { Particle, DistanceConstraint, solveTwoBone } from './physics.js';

export const PUNCHES = {
  straight: { wind: 0.0, ext: 0.14, ret: 0.2, cost: 8, power: 1.0 },
  hook:     { wind: 0.06, ext: 0.18, ret: 0.22, cost: 12, power: 1.15 },
  uppercut: { wind: 0.07, ext: 0.16, ret: 0.22, cost: 12, power: 1.15 },
  bodyhook: { wind: 0.06, ext: 0.18, ret: 0.24, cost: 12, power: 1.1 },
};

const ARM = 0.72;
const RING = 2.85;
const smooth = (u) => u * u * (3 - 2 * u);
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _qf = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Player {
  constructor(world, scene) {
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.headBase = new THREE.Vector3();
    this.armBase = new THREE.Vector3();   // where the arms hang from: slips move the head more than the hands
    this.headPos = new THREE.Vector3();
    this.chestPos = new THREE.Vector3();
    this.headVel = new THREE.Vector3();
    this.headOff = new THREE.Vector3();
    this.headOffVel = new THREE.Vector3();
    this.rotOff = new THREE.Vector3();
    this.rotVel = new THREE.Vector3();
    this.dodgeOff = new THREE.Vector3();
    this.onDodge = null;  // (dir) => void
    this.headRadius = 0.14;
    this.keys = new Set();
    this.sensitivity = 0.0022;
    this.onPunch = null;  // (glove, type) => void  (punch started)
    this.onSwing = null;  // (glove) => void        (punch accelerating)

    this.headAnchor = world.addParticle(new Particle(new THREE.Vector3(), { mass: 0, radius: 0.12, name: 'playerHead' }));
    this.gloves = [-1, 1].map((side) => {
      const shoulder = world.addParticle(new Particle(new THREE.Vector3(), { mass: 0, name: 'playerShoulder' }));
      const particle = world.addParticle(new Particle(new THREE.Vector3(), {
        mass: 3, radius: 0.105, gravityScale: 0, friction: 0.3, damping: 0.004, name: side < 0 ? 'gloveL' : 'gloveR',
      }));
      particle.isPlayerGlove = true;
      world.addConstraint(new DistanceConstraint(shoulder, particle, { length: ARM, mode: 'max' }));
      world.addConstraint(new DistanceConstraint(this.headAnchor, particle, { length: 0.2, mode: 'min' }));
      const g = { side, shoulder, particle, punch: null, queued: null, target: new THREE.Vector3(), lastTarget: new THREE.Vector3(), omega: 18, maxAcc: 120 };
      particle.glove = g;
      return g;
    });
    world.addConstraint(new DistanceConstraint(this.gloves[0].particle, this.gloves[1].particle, { length: 0.2, mode: 'min' }));
    this.view = new GloveView(scene, this);
    this.avatar = new PlayerAvatar(scene, this);
    this.reset(0, 1.6, 0);
  }

  reset(x, z, yaw) {
    this.pos.set(x, 0, z); this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = -0.04; this.twist = 0; this.twistT = 0;
    this.standHeight = 1.6; this.duck = 0; this.lunge = 0; this.lungeT = 0; this.bobPhase = 0; this.clock = 0;
    this.headOff.set(0, 0, 0); this.headOffVel.set(0, 0, 0); this.rotOff.set(0, 0, 0); this.rotVel.set(0, 0, 0);
    this.health = 100; this.stamina = 100; this.knockdowns = 0;
    this.mode = 'idle'; this.downT = 0; this.recover = 0; this.fall = 0;
    this.dodge = null; this.dodgeCd = 0; this.dodgeOff.set(0, 0, 0); this.punchDuck = 0; this.punchDuckT = 0;
    for (const g of this.gloves) { g.punch = null; g.queued = null; }
    this.preStep(1 / 240);
    for (const g of this.gloves) { g.particle.teleport(g.target); g.particle.force.set(0, 0, 0); g.lastTarget.copy(g.target); }
  }

  resetKeepHealth(x, z, yaw) {
    const { health, knockdowns } = this;
    this.reset(x, z, yaw);
    this.health = health; this.knockdowns = knockdowns;
  }

  get staminaFactor() { return 0.45 + 0.55 * (this.stamina / 100); }
  get guarding() { return this.mode === 'fight' && this.keys.has('Space'); }

  look(dx, dy) {
    if (this.mode === 'down') return;
    this.yaw -= dx * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sensitivity, -0.6, 0.5);
  }

  requestPunch(index, type) {
    if (this.mode !== 'fight') return;
    this.gloves[index].queued = type;
  }

  /** Head movement: 'left' / 'right' slip or 'back' pull. */
  requestDodge(dir) {
    if (this.mode !== 'fight' || this.dodge || this.dodgeCd > 0 || this.stamina < 4) return false;
    this.stamina -= 6;
    this.dodge = { dir, t: 0 };
    this.onDodge?.(dir);
    return true;
  }

  get dodging() { return !!this.dodge && this.dodge.t < 0.65; }

  startPunch(g, type) {
    const def = PUNCHES[type];
    const tired = this.stamina < def.cost;
    this.stamina = Math.max(0, this.stamina - def.cost);
    g.punch = { type, def, t: 0, phase: 'wind', done: false, power: def.power * (tired ? 0.6 : 1) };
    this.onPunch?.(g, type);
  }

  preStep(h) {
    this.clock += h;
    const active = this.mode === 'fight';
    const k = this.keys;

    // --- footwork
    let fx = 0, fz = 0;
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    if (active && !shift) {
      if (k.has('KeyW')) fz += 1;
      if (k.has('KeyS')) fz -= 1;
      if (k.has('KeyD')) fx += 1;
      if (k.has('KeyA')) fx -= 1;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = fx * cy - fz * sy, wz = -fx * sy - fz * cy;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const maxSp = (this.guarding ? 1.5 : 2.3) * (0.7 + 0.3 * this.stamina / 100);
    const ka = 1 - Math.exp(-h * 10);
    this.vel.x += (wx * maxSp - this.vel.x) * ka;
    this.vel.z += (wz * maxSp - this.vel.z) * ka;
    this.pos.addScaledVector(this.vel, h);
    if (Math.abs(this.pos.x) > RING) { this.pos.x = Math.sign(this.pos.x) * RING; this.vel.x *= -0.2; }
    if (Math.abs(this.pos.z) > RING) { this.pos.z = Math.sign(this.pos.z) * RING; this.vel.z *= -0.2; }
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.bobPhase += sp * h * 7;

    // --- posture
    const duckT = (active && k.has('KeyC') ? 0.3 : 0) + this.punchDuck;
    this.punchDuck += (this.punchDuckT - this.punchDuck) * (1 - Math.exp(-h * 14));

    // --- head movement (slips / pull-back). Moves your head, shoulders and gloves.
    this.dodgeCd -= h;
    let ox = 0, oy = 0, oz = 0;
    if (this.dodge) {
      const d = this.dodge;
      d.t += h;
      if (d.t < 0.55) {
        if (d.dir === 'back') { oy = -0.03; oz = 0.34; }
        else { ox = d.dir === 'left' ? -0.34 : 0.34; oy = -0.1; oz = 0.04; }
      }
      if (d.t > 0.78) { this.dodge = null; this.dodgeCd = 0.1; }
    }
    const kd = 1 - Math.exp(-h * 20);
    this.dodgeOff.x += (ox - this.dodgeOff.x) * kd;
    this.dodgeOff.y += (oy - this.dodgeOff.y) * kd;
    this.dodgeOff.z += (oz - this.dodgeOff.z) * kd;
    const kp = 1 - Math.exp(-h * 14);
    this.duck += (duckT - this.duck) * kp;
    this.lunge += (this.lungeT - this.lunge) * kp;
    this.twist += (this.twistT - this.twist) * kp;

    // --- head & camera shake springs (punches you take move your head)
    this.headOffVel.addScaledVector(this.headOff, -130 * h).multiplyScalar(Math.exp(-h * 9));
    this.headOff.addScaledVector(this.headOffVel, h);
    if (this.headOff.length() > 0.3) this.headOff.setLength(0.3);
    this.rotVel.addScaledVector(this.rotOff, -110 * h).multiplyScalar(Math.exp(-h * 8));
    this.rotOff.addScaledVector(this.rotVel, h);

    // --- knockdown animation
    if (this.mode === 'down') this.fall = Math.min(1, this.fall + h / 0.7);
    else if (this.mode === 'rising') {
      this.fall = Math.max(0, this.fall - h / 1.1);
      if (this.fall <= 0) this.mode = 'fight';
    } else this.fall = 0;
    const fallE = smooth(this.fall);

    const height = THREE.MathUtils.lerp(this.standHeight - this.duck + this.dodgeOff.y + Math.sin(this.bobPhase * 2) * 0.012 * Math.min(1, sp) +
      Math.sin(this.clock * 2.2) * 0.004, 0.45, fallE);
    const fwx = -sy, fwz = -cy;
    const dxw = cy * this.dodgeOff.x - fwx * this.dodgeOff.z, dzw = -sy * this.dodgeOff.x - fwz * this.dodgeOff.z;
    this.headBase.set(this.pos.x + fwx * this.lunge + dxw, height, this.pos.z + fwz * this.lunge + dzw);
    this.headPos.copy(this.headBase).add(this.headOff);
    this.headAnchor.moveKinematic(this.headBase);
    this.armBase.set(this.headBase.x - dxw * 0.65, this.headBase.y - this.dodgeOff.y * 0.5, this.headBase.z - dzw * 0.65);
    this.chestPos.set(this.pos.x + (fwx * this.lunge + dxw) * 0.5, height - 0.42, this.pos.z + (fwz * this.lunge + dzw) * 0.5);
    this.headVel.copy(this.vel).add(this.headOffVel);

    // --- shoulders follow the torso (yaw + twist only)
    _qy.setFromEuler(_e.set(0, this.yaw + this.twist, 0));
    _qf.setFromEuler(_e.set(this.pitch * 0.6, this.yaw + this.twist, 0));
    for (const g of this.gloves) {
      _v.set(g.side * 0.19, -0.24, 0.02).applyQuaternion(_qy).add(this.armBase);
      g.shoulder.moveKinematic(_v);
    }

    // --- gloves
    this.lungeT = 0; this.twistT = 0; this.punchDuckT = 0;
    for (const g of this.gloves) {
      if (g.queued && (!g.punch || (g.punch.phase === 'ret' && g.punch.t > g.punch.def.wind + g.punch.def.ext + 0.08))) {
        this.startPunch(g, g.queued);
        g.queued = null;
      }
      this.gloveTarget(g, h, _t);
      g.target.copy(_t).applyQuaternion(_qf).add(this.armBase);
      this.driveGlove(g, h);
    }

    // --- stamina
    this.stamina = Math.min(100, this.stamina + h * (this.guarding ? 7 : 15));
  }

  /** Glove target in head-local coordinates: x right, y up, -z forward. */
  gloveTarget(g, h, out) {
    const s = g.side;
    const guard = this.guarding;
    // A tired guard is a weak guard: heavy shots push your own gloves into your face.
    const sf = this.stamina / 100;
    g.omega = guard ? 28 * (0.55 + 0.45 * sf) : 18;
    g.maxAcc = guard ? 170 * (0.3 + 0.7 * sf) : 120;
    if (this.mode === 'down' || this.mode === 'rising') { g.omega = 10; return out.set(s * 0.26, -0.55, -0.3); }
    if (guard) out.set(s * 0.1, -0.05, -0.27);
    else out.set(s * 0.2, -0.17, -0.36);

    const pu = g.punch;
    if (!pu) return out;
    pu.t += h;
    const d = pu.def;
    if (pu.t < d.wind) {
      pu.phase = 'wind';
      const u = smooth(pu.t / d.wind);
      if (pu.type === 'hook') { out.lerp(_a.set(s * 0.42, -0.1, -0.3), u); this.twistT = -s * 0.06; }
      else if (pu.type === 'uppercut') { out.lerp(_a.set(s * 0.13, -0.45, -0.28), u); this.lungeT = -0.02; }
      else if (pu.type === 'bodyhook') { out.lerp(_a.set(s * 0.4, -0.42, -0.28), u); this.twistT = -s * 0.06; this.punchDuckT = 0.1; }
    } else if (pu.t < d.wind + d.ext) {
      if (pu.phase !== 'ext') { pu.phase = 'ext'; this.onSwing?.(g); }
      const u = smooth((pu.t - d.wind) / d.ext);
      g.omega = 42;
      g.maxAcc = 240 * this.staminaFactor * pu.power;
      if (pu.type === 'straight') {
        out.set(s * 0.05, 0.0, -0.95);
        this.lungeT = 0.09; this.twistT = s * 0.05;
      } else if (pu.type === 'hook') {
        _a.set(s * 0.45, -0.03, -0.55); _b.set(-s * 0.3, -0.03, -0.62);
        out.lerpVectors(_a, _b, u);
        this.lungeT = 0.04; this.twistT = s * 0.1;
      } else if (pu.type === 'bodyhook') {
        _a.set(s * 0.45, -0.42, -0.55); _b.set(-s * 0.25, -0.4, -0.72);
        out.lerpVectors(_a, _b, u);
        this.lungeT = 0.16;   // step in: body shots are thrown from closer this.twistT = s * 0.1; this.punchDuckT = 0.12;
      } else {
        _a.set(s * 0.1, -0.35, -0.45); _b.set(s * 0.03, 0.18, -0.72);
        out.lerpVectors(_a, _b, u);
        this.lungeT = 0.05;
      }
    } else if (pu.t < d.wind + d.ext + d.ret) {
      pu.phase = 'ret';
      g.omega = 22;
    } else {
      g.punch = null;
    }
    return out;
  }

  driveGlove(g, h) {
    const p = g.particle;
    _v.subVectors(g.target, g.lastTarget).multiplyScalar(1 / h);
    const tv = _v.length();
    if (tv > 6) _v.multiplyScalar(6 / tv);
    _f.subVectors(p.pos, p.prev).multiplyScalar(1 / h);
    _f.subVectors(_v, _f).multiplyScalar(2 * 0.85 * g.omega);
    _f.addScaledVector(_a.subVectors(g.target, p.pos), g.omega * g.omega);
    const acc = _f.length();
    if (acc > g.maxAcc) _f.multiplyScalar(g.maxAcc / acc);
    p.force.addScaledVector(_f, p.mass);
    g.lastTarget.copy(g.target);
  }

  /** impulse: N·s delivered to your head/body by the opponent's glove. */
  takeHit(impulse, dmg, region) {
    const m = region === 'head' ? 5 : 20;
    _v.copy(impulse).multiplyScalar(1 / m);
    if (_v.length() > 4) _v.setLength(4);
    this.headOffVel.add(_v);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const lateral = impulse.x * cy - impulse.z * sy;
    const forward = -impulse.x * sy - impulse.z * cy;
    this.rotVel.z += -lateral * 0.05;
    this.rotVel.y += -lateral * 0.04;
    this.rotVel.x += impulse.y * 0.04 - forward * 0.02;
    this.vel.x += impulse.x / 70; this.vel.z += impulse.z / 70;
    this.health = Math.max(0, this.health - dmg);
  }

  knockDown() {
    this.mode = 'down';
    this.knockdowns++;
    this.recover = 0;
    for (const g of this.gloves) { g.punch = null; g.queued = null; }
  }

  rise(health) { this.mode = 'rising'; this.health = health; }

  updateCamera(camera) {
    const fallE = smooth(this.fall);
    camera.position.copy(this.headPos);
    camera.rotation.set(
      this.pitch + this.rotOff.x - fallE * 0.35,
      this.yaw + this.twist + this.rotOff.y,
      this.rotOff.z + fallE * 0.9 - this.dodgeOff.x * 0.5,
      'YXZ',
    );
  }
}

// ---------------------------------------------------------------------------
const Y = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _el = new THREE.Vector3(), _pole = new THREE.Vector3(), _up = new THREE.Vector3();

class GloveView {
  constructor(scene, player) {
    this.player = player;
    const leather = new THREE.MeshPhysicalMaterial({ color: 0xc8141c, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.2 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a27c, roughness: 0.6 });
    const sphere = new THREE.SphereGeometry(1, 28, 20);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
    this.items = player.gloves.map((g) => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(sphere, leather); body.scale.set(0.1, 0.095, 0.125);
      const knuckle = new THREE.Mesh(sphere, leather); knuckle.scale.set(0.085, 0.07, 0.06); knuckle.position.set(0, 0.03, 0.06);
      const thumb = new THREE.Mesh(sphere, leather); thumb.scale.set(0.035, 0.04, 0.065); thumb.position.set(-g.side * 0.07, 0.035, 0.02);
      const cuff = new THREE.Mesh(cyl, white); cuff.scale.set(0.072, 0.11, 0.072); cuff.rotation.x = Math.PI / 2; cuff.position.z = -0.12;
      group.add(body, knuckle, thumb, cuff);
      const fore = new THREE.Mesh(cyl, white);
      const upper = new THREE.Mesh(cyl, skin);
      for (const m of [body, knuckle, thumb, cuff, fore, upper]) { m.castShadow = true; m.receiveShadow = true; }
      scene.add(group, fore, upper);
      return { g, group, fore, upper };
    });
  }

  update(camera) {
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    for (const it of this.items) {
      const g = it.g;
      const gp = g.particle.pos, sp = g.shoulder.pos;
      _pole.set(g.side * 0.6, -1, 0.3).applyQuaternion(camera.quaternion);
      solveTwoBone(sp, gp, 0.33, 0.37, _pole, _el);

      _bz.subVectors(gp, _el).normalize();
      _bx.crossVectors(_up, _bz);
      if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
      _bx.normalize();
      _by.crossVectors(_bz, _bx);
      _m.makeBasis(_bx, _by, _bz);
      it.group.quaternion.setFromRotationMatrix(_m);
      it.group.position.copy(gp);

      placeCylinder(it.fore, _el, _v.copy(gp).addScaledVector(_bz, -0.1), 0.05);
      placeCylinder(it.upper, sp, _el, 0.06);
    }
  }
}

function placeCylinder(mesh, a, b, r) {
  _f.subVectors(b, a);
  const len = _f.length() || 1e-4;
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y, _f.multiplyScalar(1 / len));
  mesh.scale.set(r, len, r);
}

// ---------------------------------------------------------------------------
// Third-person body, only shown by the knockout cam (you never see it in first person).
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3();
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3(), _p4 = new THREE.Vector3();

function orient(obj, xDir, yDir) {
  _ax.copy(xDir).normalize();
  _ay.copy(yDir).addScaledVector(_ax, -yDir.dot(_ax)).normalize();
  _az.crossVectors(_ax, _ay);
  _m.makeBasis(_ax, _ay, _az);
  obj.quaternion.setFromRotationMatrix(_m);
}

class PlayerAvatar {
  constructor(scene, player) {
    this.player = player;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a27c, roughness: 0.55 });
    const shorts = new THREE.MeshStandardMaterial({ color: 0x1840c0, roughness: 0.4, metalness: 0.1 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.8 });
    const sphere = new THREE.SphereGeometry(1, 20, 14);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10);
    const add = (geo, mat, parent = this.group) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m; };
    this.head = new THREE.Group(); this.group.add(this.head);
    add(sphere, skin, this.head).scale.set(0.105, 0.125, 0.115);
    const hair = add(sphere, dark, this.head); hair.scale.set(0.11, 0.075, 0.115); hair.position.set(0, 0.06, -0.015);
    for (const sx of [-1, 1]) {
      const eye = add(sphere, dark, this.head); eye.scale.setScalar(0.013); eye.position.set(sx * 0.038, 0.02, 0.103);
      const ear = add(sphere, skin, this.head); ear.scale.set(0.015, 0.03, 0.022); ear.position.set(sx * 0.105, 0, 0);
    }
    const nose = add(sphere, skin, this.head); nose.scale.set(0.02, 0.028, 0.025); nose.position.set(0, -0.005, 0.118);
    this.neck = add(cyl, skin);
    this.chest = add(sphere, skin); this.chest.scale.set(0.21, 0.19, 0.13);
    this.abs = add(sphere, skin); this.abs.scale.set(0.165, 0.17, 0.115);
    this.shorts = add(sphere, shorts); this.shorts.scale.set(0.19, 0.17, 0.14);
    this.belt = add(cyl, trim); this.belt.scale.set(0.18, 0.05, 0.13);
    this.shoulders = [add(sphere, skin), add(sphere, skin)];
    for (const m of this.shoulders) m.scale.setScalar(0.075);
    this.legs = [-1, 1].map(() => ({ thigh: add(cyl, skin), shin: add(cyl, skin), knee: add(sphere, skin),
      shoe: add(new THREE.BoxGeometry(0.1, 0.08, 0.25), trim) }));
  }

  update() {
    const p = this.player;
    const yaw = p.yaw + p.twist;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const left = _p1.set(-cy, 0, sy);          // the player's left
    const fwd = _p2.set(-sy, 0, -cy);
    const head = p.headAnchor.pos;
    const sL = p.gloves[0].shoulder.pos, sR = p.gloves[1].shoulder.pos;
    const sMid = _p3.addVectors(sL, sR).multiplyScalar(0.5);
    const hip = _p4.set(p.pos.x, 0.93 - p.duck * 0.6 - p.punchDuck * 0.5, p.pos.z);
    const up = _v.subVectors(sMid, hip);

    orient(this.chest, left, up); this.chest.position.copy(sMid).addScaledVector(_ay, -0.11);
    orient(this.abs, left, up); this.abs.position.lerpVectors(sMid, hip, 0.62);
    orient(this.shorts, left, up); this.shorts.position.copy(hip).addScaledVector(_ay, -0.02);
    orient(this.belt, left, up); this.belt.position.copy(hip).addScaledVector(_ay, 0.11);
    this.shoulders[0].position.copy(sL); this.shoulders[1].position.copy(sR);
    _f.subVectors(head, sMid);
    orient(this.head, left, _f); this.head.position.copy(head);
    placeCylinder(this.neck, sMid, head, 0.06);

    this.legs.forEach((leg, i) => {
      const side = i === 0 ? 1 : -1;        // +1 = left
      const fwdOff = side > 0 ? 0.17 : -0.15;
      const hipJ = _t.copy(hip).addScaledVector(left, side * 0.11);
      const foot = _b.set(p.pos.x + left.x * side * 0.15 + fwd.x * fwdOff, 0.07, p.pos.z + left.z * side * 0.15 + fwd.z * fwdOff);
      _a.copy(fwd).addScaledVector(left, side * 0.25);
      solveTwoBone(hipJ, foot, 0.41, 0.44, _a, _el);
      placeCylinder(leg.thigh, hipJ, _el, 0.08);
      placeCylinder(leg.shin, _el, foot, 0.058);
      leg.knee.position.copy(_el); leg.knee.scale.setScalar(0.068);
      leg.shoe.position.copy(foot).addScaledVector(fwd, 0.05); leg.shoe.position.y = 0.05;
      leg.shoe.rotation.set(0, yaw, 0);
    });
  }
}
