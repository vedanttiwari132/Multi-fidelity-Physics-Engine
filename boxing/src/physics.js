// Small position-based (Verlet) physics engine.
//
// Everything that moves in the game — the opponent's ragdoll, your gloves and
// the ring ropes — is made of point masses ("particles") joined by distance
// constraints. Velocity is implicit: v = (pos - prev) / dt.

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();

export class Particle {
  constructor(position, {
    mass = 1, radius = 0.05, friction = 0.6, gravityScale = 1, damping = 0.002, name = '',
  } = {}) {
    this.pos = position.clone();
    this.prev = position.clone();
    this.force = new THREE.Vector3();
    this.setMass(mass);
    this.radius = radius;
    this.friction = friction;       // Coulomb friction coefficient against the floor
    this.gravityScale = gravityScale;
    this.damping = damping;         // fraction of velocity lost per step (air drag)
    this.name = name;
    this.onGround = false;
  }

  setMass(m) { this.mass = m; this.invMass = m > 0 ? 1 / m : 0; }
  getVelocity(dt, out = new THREE.Vector3()) { return out.subVectors(this.pos, this.prev).multiplyScalar(1 / dt); }
  setVelocity(v, dt) { this.prev.copy(this.pos).addScaledVector(v, -dt); }
  applyImpulse(j, dt) { if (this.invMass > 0) this.prev.addScaledVector(j, -this.invMass * dt); }
  teleport(p) { this.pos.copy(p); this.prev.copy(p); }
  /** Kinematic particles (mass 0) are driven by game code instead of forces. */
  moveKinematic(p) { this.prev.copy(this.pos); this.pos.copy(p); }
}

export class DistanceConstraint {
  /** mode: 'equal' keeps the distance, 'max' acts like a rope, 'min' like a strut that only pushes. */
  constructor(a, b, { length = null, stiffness = 1, mode = 'equal' } = {}) {
    this.a = a;
    this.b = b;
    const rest = a.pos.distanceTo(b.pos);
    this.length = length ?? (mode === 'min' ? rest * 0.9 : rest);
    this.stiffness = stiffness;
    this.mode = mode;
    this.enabled = true;
  }

  solve() {
    const a = this.a, b = this.b;
    const w = a.invMass + b.invMass;
    if (w === 0) return;
    _a.subVectors(b.pos, a.pos);
    const len = _a.length();
    if (len < 1e-9) return;
    if (this.mode === 'max' && len <= this.length) return;
    if (this.mode === 'min' && len >= this.length) return;
    const k = ((len - this.length) / (len * w)) * this.stiffness;
    a.pos.addScaledVector(_a, k * a.invMass);
    b.pos.addScaledVector(_a, -k * b.invMass);
  }
}

export class World {
  constructor({ gravity = new THREE.Vector3(0, -9.81, 0), iterations = 6, groundY = 0 } = {}) {
    this.gravity = gravity;
    this.iterations = iterations;
    this.groundY = groundY;
    this.particles = [];
    this.constraints = [];
    /** Optional callback(dt, iteration) for game-specific contacts, run inside the solver loop. */
    this.collisionHook = null;
    this.time = 0;
    this.steps = 0;
  }

  addParticle(p) { this.particles.push(p); return p; }
  addConstraint(c) { this.constraints.push(c); return c; }

  step(dt) {
    const dt2 = dt * dt;
    const g = this.gravity;

    // 1. Verlet integration
    for (const p of this.particles) {
      if (p.invMass === 0) { p.force.set(0, 0, 0); continue; }
      _v.subVectors(p.pos, p.prev).multiplyScalar(1 - p.damping);
      p.prev.copy(p.pos);
      p.pos.add(_v)
        .addScaledVector(g, p.gravityScale * dt2)
        .addScaledVector(p.force, p.invMass * dt2);
      p.force.set(0, 0, 0);
    }

    // 2. Relaxation: constraints, contacts, floor
    for (let i = 0; i < this.iterations; i++) {
      for (const c of this.constraints) if (c.enabled) c.solve();
      if (this.collisionHook) this.collisionHook(dt, i);
      this.solveGround();
    }

    // 3. Floor friction (Coulomb, normal force ~ m g)
    this.applyGroundFriction(dt);
    this.time += dt;
    this.steps++;
  }

  solveGround() {
    const gy = this.groundY;
    for (const p of this.particles) {
      if (p.invMass && p.pos.y < gy + p.radius) p.pos.y = gy + p.radius;
    }
  }

  applyGroundFriction(dt) {
    const gy = this.groundY;
    const drop = 9.81 * dt * dt;
    for (const p of this.particles) {
      if (!p.invMass) continue;
      p.onGround = p.pos.y <= gy + p.radius + 1e-4;
      if (!p.onGround) continue;
      if (p.prev.y > p.pos.y) p.prev.y = p.pos.y; // no bounce
      const vx = p.pos.x - p.prev.x, vz = p.pos.z - p.prev.z;
      const sp = Math.hypot(vx, vz);
      if (sp < 1e-12) continue;
      const s = Math.max(0, sp - p.friction * drop) / sp;
      p.prev.x = p.pos.x - vx * s;
      p.prev.z = p.pos.z - vz * s;
    }
  }
}

/**
 * Sphere-sphere contact between two particles with an impulse (restitution e).
 * Returns the closing speed along the contact normal (>= 0) when touching, -1 otherwise.
 * `outImpulse` (optional) receives the impulse applied to `b`.
 */
export function collideParticles(a, b, dt, e = 0.2, outImpulse = null) {
  _n.subVectors(b.pos, a.pos);
  const minD = a.radius + b.radius;
  const d2 = _n.lengthSq();
  if (d2 >= minD * minD) return -1;
  const w = a.invMass + b.invMass;
  if (w === 0) return -1;
  const d = Math.sqrt(d2) || 1e-6;
  _n.multiplyScalar(1 / d);

  const vrel = (((a.pos.x - a.prev.x) - (b.pos.x - b.prev.x)) * _n.x +
                ((a.pos.y - a.prev.y) - (b.pos.y - b.prev.y)) * _n.y +
                ((a.pos.z - a.prev.z) - (b.pos.z - b.prev.z)) * _n.z) / dt;

  if (vrel > 0) {
    const j = ((1 + e) * vrel) / w;
    a.prev.addScaledVector(_n, j * a.invMass * dt);
    b.prev.addScaledVector(_n, -j * b.invMass * dt);
    if (outImpulse) outImpulse.copy(_n).multiplyScalar(j);
  } else if (outImpulse) outImpulse.set(0, 0, 0);

  // Separate without injecting velocity (shift prev along with pos).
  const pen = minD - d;
  const sa = (pen * a.invMass) / w, sb = (pen * b.invMass) / w;
  a.pos.addScaledVector(_n, -sa); a.prev.addScaledVector(_n, -sa);
  b.pos.addScaledVector(_n, sb); b.prev.addScaledVector(_n, sb);
  return Math.max(vrel, 0);
}

/**
 * Contact between a particle and a game-driven sphere (e.g. the player's head).
 * The sphere is pushed back only through `outImpulse` (the impulse it receives).
 */
export function collideParticleSphere(p, center, radius, centerVel, bodyInvMass, dt, e = 0.1, outImpulse = null) {
  _n.subVectors(p.pos, center);
  const minD = p.radius + radius;
  const d2 = _n.lengthSq();
  if (d2 >= minD * minD || !p.invMass) return -1;
  const d = Math.sqrt(d2) || 1e-6;
  _n.multiplyScalar(1 / d);
  _v.subVectors(p.pos, p.prev).multiplyScalar(1 / dt);
  const vrel = (centerVel.x - _v.x) * _n.x + (centerVel.y - _v.y) * _n.y + (centerVel.z - _v.z) * _n.z;
  if (vrel > 0) {
    const j = ((1 + e) * vrel) / (p.invMass + bodyInvMass);
    p.prev.addScaledVector(_n, -j * p.invMass * dt);
    if (outImpulse) outImpulse.copy(_n).multiplyScalar(-j);
  } else if (outImpulse) outImpulse.set(0, 0, 0);
  const pen = minD - d;
  p.pos.addScaledVector(_n, pen);
  p.prev.addScaledVector(_n, pen);
  return Math.max(vrel, 0);
}

/** Particle vs a capsule segment between two particles (used for rope segments). */
export function collideParticleSegment(p, a, b, segRadius) {
  _a.subVectors(b.pos, a.pos);
  const l2 = _a.lengthSq();
  let t = l2 > 1e-12 ? _v.subVectors(p.pos, a.pos).dot(_a) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  _v.copy(a.pos).addScaledVector(_a, t);       // closest point
  _n.subVectors(p.pos, _v);
  const minD = p.radius + segRadius;
  const d2 = _n.lengthSq();
  if (d2 >= minD * minD) return false;
  const d = Math.sqrt(d2) || 1e-6;
  _n.multiplyScalar(1 / d);
  const wa = a.invMass * (1 - t), wb = b.invMass * t;
  const denom = p.invMass + (1 - t) * wa + t * wb;
  if (denom === 0) return false;
  const lambda = (minD - d) / denom;
  p.pos.addScaledVector(_n, lambda * p.invMass);
  a.pos.addScaledVector(_n, -lambda * wa);
  b.pos.addScaledVector(_n, -lambda * wb);
  return true;
}

const _ikDir = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
/** Analytic two-bone IK: finds the middle joint (elbow/knee) between root and end. */
export function solveTwoBone(root, end, l1, l2, pole, out) {
  _ikDir.subVectors(end, root);
  const raw = _ikDir.length() || 1e-6;
  _ikDir.multiplyScalar(1 / raw);
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, raw));
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _ikPole.copy(pole).addScaledVector(_ikDir, -pole.dot(_ikDir));
  if (_ikPole.lengthSq() < 1e-8) _ikPole.set(0, -1, 0);
  _ikPole.normalize();
  return out.copy(root).addScaledVector(_ikDir, along).addScaledVector(_ikPole, h);
}
