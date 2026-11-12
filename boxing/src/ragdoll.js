// An active ragdoll made of rigid bodies (Rapier).
//
// Fourteen solid body parts (pelvis, spine, chest, head, upper arms, forearms, thighs,
// shins, feet) joined by real joints: ball joints at the neck, spine, shoulders, hips and
// ankles, and hinges with hard limits at the elbows and knees (they can't bend backwards).
// Muscles are joint motors: each joint is driven toward a target rotation with a limited
// torque (its strength), and the torque acts between the two parts it joins, so muscles
// move the body against itself, never by pulling on it from outside. Lose muscle tone and
// the motors go slack: the body falls as what it is, a heavy jointed thing.
//
// Standing up is helped the way games usually do it: while the feet are on the floor a
// bounded support force and an upright torque act on the pelvis, and the legs' push toward
// the wanted velocity is limited by grip. Knock the balance far enough and the help fades,
// and the rest is real rigid-body physics.

import * as THREE from 'three';
import RAPIER from './rapier.js';
import { solveTwoBone } from './physics.js';
import { interactionGroups, fighterGroup } from './sim.js';

// Rest pose joint positions (facing +z, the body's left is +x). The skinned body is modelled
// in this pose, and every body part's rest rotation is the identity.
export const JOINTS = {
  head: [0.00, 1.66, 0.03], neck: [0.00, 1.49, 0.00], chest: [0.00, 1.31, 0.00],
  shoulderL: [0.21, 1.43, 0.00], shoulderR: [-0.21, 1.43, 0.00],
  elbowL: [0.27, 1.15, 0.14], elbowR: [-0.27, 1.15, 0.12],
  // forearms are 32 cm elbow to fist (the old rest pose had them at 17–21 cm and stretched the mesh to reach)
  handL: [0.165, 1.285, 0.41], handR: [-0.137, 1.417, 0.234],
  belly: [0.00, 1.09, 0.00], pelvis: [0.00, 0.93, 0.00],
  hipL: [0.11, 0.89, 0.00], hipR: [-0.11, 0.89, 0.00],
  kneeL: [0.15, 0.50, 0.13], kneeR: [-0.14, 0.50, -0.07],
  footL: [0.16, 0.07, 0.17], footR: [-0.16, 0.07, -0.15],
  ankleL: [0.16, 0.115, 0.15], ankleR: [-0.16, 0.115, -0.17],
};
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const J = Object.fromEntries(Object.entries(JOINTS).map(([k, v]) => [k, V(v)]));

// Body parts. at: the joint the part's frame sits on. joint: where it hangs from its parent.
// Strength: the most torque (N·m) its joint's muscles can make. swing / twist: soft range of
// a ball joint (rad, from the rest pose). Hinges: flex range from straight.
const S = (side, n) => n + side;
function partList() {
  const parts = [
    { name: 'pelvis', at: 'pelvis', mass: 11, part: 'TORSO', region: 'low' },
    { name: 'spine', at: 'belly', mass: 9, part: 'TORSO', region: 'body', parent: 'pelvis', joint: [0, 1.01, 0], strength: 650, swing: 0.55, twist: 0.45 },
    { name: 'chest', at: 'chest', mass: 15, part: 'TORSO', region: 'body', parent: 'spine', joint: [0, 1.2, 0], strength: 600, swing: 0.5, twist: 0.5 },
    { name: 'head', at: 'neck', mass: 6, part: 'HEAD', region: 'head', parent: 'chest', joint: [0, 1.47, 0], strength: 140, swing: 0.75, twist: 0.9 },
  ];
  for (const s of ['L', 'R']) {
    parts.push(
      { name: S(s, 'upperArm'), at: S(s, 'shoulder'), mass: 2.4, part: 'ARM', region: 'guard', parent: 'chest', joint: JOINTS[S(s, 'shoulder')], strength: 160, swing: 2.4, twist: 1.4, side: s },
      { name: S(s, 'foreArm'), at: S(s, 'elbow'), mass: 2.0, part: 'ARM', region: 'guard', parent: S(s, 'upperArm'), joint: JOINTS[S(s, 'elbow')], strength: 110, hinge: 'elbow', flex: [0.02, 2.6], side: s },
      { name: S(s, 'thigh'), at: S(s, 'hip'), mass: 8, part: 'THIGH', region: 'low', parent: 'pelvis', joint: JOINTS[S(s, 'hip')], strength: 480, swing: 1.75, twist: 0.7, side: s },
      { name: S(s, 'shin'), at: S(s, 'knee'), mass: 3.5, part: 'SHIN', region: 'low', parent: S(s, 'thigh'), joint: JOINTS[S(s, 'knee')], strength: 520, hinge: 'knee', flex: [0.0, 2.4], side: s },
      { name: S(s, 'foot'), at: S(s, 'ankle'), mass: 1.2, part: 'SHIN', region: 'low', parent: S(s, 'shin'), joint: JOINTS[S(s, 'ankle')], strength: 160, swing: 0.6, twist: 0.35, side: s },
    );
  }
  return parts;
}

// Colliders, in rest-pose world coordinates: [kind, a, b, radius, extra]. They are the
// hitboxes, sized to the skinned body (measured against the mesh in body.js).
function collidersFor(name) {
  const j = JOINTS, s = name.slice(-1), sd = s === 'L' ? 1 : -1;
  switch (name) {
    case 'pelvis': return [['cap', [0.075, 0.91, -0.01], [-0.075, 0.91, -0.01], 0.13]];
    case 'spine': return [['cap', [0, 1.03, 0], [0, 1.16, 0], 0.12]];
    case 'chest': return [
      ['cap', [0, 1.26, 0], [0, 1.36, 0], 0.145],
      ['cap', j.shoulderL, j.shoulderR, 0.08],
      ['cap', j.shoulderL, [0.08, 1.22, 0], 0.1], ['cap', j.shoulderR, [-0.08, 1.22, 0], 0.1],
    ];
    case 'head': return [
      ['cap', [0, 1.49, 0], [0, 1.58, 0.01], 0.075, { region: 'head' }],
      ['cap', [0, 1.625, 0.06], [0, 1.70, -0.01], 0.112],
      ['ball', [0, 1.70, -0.01], null, 0.125],
    ];
    default: break;
  }
  if (name.startsWith('upperArm')) return [['cap', j[S(s, 'shoulder')], j[S(s, 'elbow')], 0.07]];
  if (name.startsWith('foreArm')) {
    const e = V(j[S(s, 'elbow')]), h = V(j[S(s, 'hand')]);
    const w = h.clone().addScaledVector(h.clone().sub(e).normalize(), -0.06);
    return [['cap', j[S(s, 'elbow')], w.toArray(), 0.058], ['ball', j[S(s, 'hand')], null, 0.085, { fist: true }]];
  }
  if (name.startsWith('thigh')) {
    const hp = V(j[S(s, 'hip')]), k = V(j[S(s, 'knee')]);
    const m = hp.clone().lerp(k, 0.45);
    return [['cap', [hp.x + sd * 0.01, hp.y - 0.04, hp.z], m.toArray(), 0.11], ['cap', m.toArray(), j[S(s, 'knee')], 0.075]];
  }
  if (name.startsWith('shin')) return [['cap', j[S(s, 'knee')], j[S(s, 'ankle')], 0.062]];
  if (name.startsWith('foot')) {
    const f = j[S(s, 'foot')];
    return [['cap', [f[0], 0.045, f[2] - 0.07], [f[0], 0.045, f[2] + 0.15], 0.045, { foot: true }]];
  }
  return [];
}

// Joint points other code reads (camera, AI, replays framing): name -> [body, rest point].
const POINTS = {
  head: 'head', neck: 'head', chest: 'chest', shoulderL: 'chest', shoulderR: 'chest',
  elbowL: 'foreArmL', elbowR: 'foreArmR', handL: 'foreArmL', handR: 'foreArmR',
  belly: 'spine', pelvis: 'pelvis', hipL: 'thighL', hipR: 'thighR', kneeL: 'shinL', kneeR: 'shinR',
  footL: 'footL', footR: 'footR',
};
const POINT_RADIUS = { head: 0.125, neck: 0.07, chest: 0.17, shoulderL: 0.08, shoulderR: 0.08, elbowL: 0.06, elbowR: 0.06, handL: 0.085, handR: 0.085,
  belly: 0.16, pelvis: 0.15, hipL: 0.09, hipR: 0.09, kneeL: 0.075, kneeR: 0.075, footL: 0.07, footR: 0.07 };
const REGION = { head: 'head', neck: 'head', chest: 'body', belly: 'body', shoulderL: 'body', shoulderR: 'body',
  handL: 'guard', handR: 'guard', elbowL: 'guard', elbowR: 'guard',
  pelvis: 'low', hipL: 'low', hipR: 'low', kneeL: 'low', kneeR: 'low', footL: 'low', footR: 'low' };

/** A point on a body part, with the old particle shape ({ pos, prev, getVelocity }) so other code can read it. */
class JointPoint {
  constructor(name, body, local) {
    this.name = name; this.body = body; this.local = local;
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3();
    this.radius = POINT_RADIUS[name]; this.region = REGION[name]; this.mass = 1;
  }
  getVelocity(dt, out = new THREE.Vector3()) { return out.subVectors(this.pos, this.prev).multiplyScalar(1 / dt); }
}

// scratch
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const Y = new THREE.Vector3(0, 1, 0);
const tq = (r, out = new THREE.Quaternion()) => out.set(r.x, r.y, r.z, r.w);
const tv = (r, out = new THREE.Vector3()) => out.set(r.x, r.y, r.z);
/** Rotation vector (axis × angle) of a quaternion, shortest way round. */
function rotvec(q, out) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return out.set(0, 0, 0);
  const ang = 2 * Math.atan2(s, w);
  return out.set(x, y, z).multiplyScalar(ang / s);
}
/** Rotation taking frame (d0, n0) onto (d, n): d is the bone's direction, n its hinge axis. */
const _fa = new THREE.Vector3(), _fb = new THREE.Vector3(), _fc = new THREE.Vector3(), _m1 = new THREE.Matrix4(), _m0 = new THREE.Matrix4();
function frameQuat(d, n, d0, n0, out) {
  const b = (dd, nn, m) => {
    _fa.copy(dd).normalize(); _fb.copy(nn).addScaledVector(_fa, -nn.dot(_fa)).normalize(); _fc.crossVectors(_fa, _fb);
    return m.makeBasis(_fa, _fb, _fc);
  };
  b(d, n, _m1); b(d0, n0, _m0);
  return out.setFromRotationMatrix(_m1.multiply(_m0.transpose()));
}
const _sa = new THREE.Vector3();
const signedAngle = (a, b, axis) => Math.atan2(_sa.crossVectors(a, b).dot(axis), a.dot(b));
const _qr = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qe = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _err = new THREE.Vector3(), _wv = new THREE.Vector3();
const _fa2 = new THREE.Vector3(), _fb2 = new THREE.Vector3(), _fc2 = new THREE.Vector3();

export class Ragdoll {
  /**
   * phys: PhysicsWorld. index: 0 for your body, 1 for his. owner: the fighter (for hit info).
   */
  constructor(phys, index, owner) {
    this.phys = phys;
    this.world = phys.world;
    this.index = index;
    this.owner = owner;
    this.parts = {};
    this.list = [];
    this.colliders = [];
    this.M = 0;
    const R = RAPIER;
    for (const d of partList()) {
      const origin = V(JOINTS[d.at]);
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(origin.x, origin.y, origin.z)
        // (no CCD: at 240 Hz limbs move a few cm a step, and CCD's pull-back ignores joints and tore ankles open)
        .setLinearDamping(0.05).setAngularDamping(0.6).setCanSleep(false));
      const part = { ...d, body, origin, parentPart: null, joint: null, jointPoint: d.joint ? V(d.joint) : null,
        target: new THREE.Quaternion(), lastLocal: new THREE.Quaternion(), hasLast: false, strengthNow: 0 };
      // colliders (the first carries the part's mass)
      const g = interactionGroups(fighterGroup(index, d.part));
      collidersFor(d.name).forEach(([kind, a, b, r, extra = {}], i) => {
        let desc;
        if (kind === 'ball') {
          desc = R.ColliderDesc.ball(r).setTranslation(a[0] - origin.x, a[1] - origin.y, a[2] - origin.z);
        } else {
          const A = V(a).sub(origin), B = V(b).sub(origin);
          const len = A.distanceTo(B);
          const q = new THREE.Quaternion().setFromUnitVectors(Y, B.clone().sub(A).normalize());
          desc = R.ColliderDesc.capsule(len / 2, r).setTranslation((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2)
            .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        }
        if (i === 0) desc.setMass(d.mass); else desc.setDensity(0);
        desc.setCollisionGroups(g).setFriction(extra.foot ? 1.5 : 0.5).setRestitution(0.05)
          .setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1);
        const c = this.world.createCollider(desc, body);
        const info = { kind: 'body', owner, rig: this, part: d.name, region: extra.region || d.region, mass: d.mass,
          name: extra.fist ? S(d.side, 'hand') : d.name.startsWith('foot') ? S(d.side, 'foot') : d.name,
          fist: !!extra.fist, foot: !!extra.foot, striker: !!(extra.fist || extra.foot), shape: kind, r };
        phys.register(c, info);
        this.colliders.push(info);
      });
      this.parts[d.name] = part;
      this.list.push(part);
      this.M += d.mass;
      phys.recorded.push(body);
      phys.tracked.add(body);
    }
    // joints
    for (const p of this.list) {
      if (!p.parent) continue;
      const par = this.parts[p.parent];
      p.parentPart = par;
      const a1 = p.jointPoint.clone().sub(par.origin), a2 = p.jointPoint.clone().sub(p.origin);
      let data;
      if (p.hinge) {
        // hinge axis: sideways for the knee (positive bends the shin back); for the elbow, the
        // normal of the arm's rest plane (positive bends it further)
        const s = p.side;
        if (p.hinge === 'knee') p.axis = new THREE.Vector3(1, 0, 0);
        else {
          const d1 = J[S(s, 'elbow')].clone().sub(J[S(s, 'shoulder')]), d2 = J[S(s, 'hand')].clone().sub(J[S(s, 'elbow')]);
          p.axis = d1.clone().cross(d2).normalize();
        }
        const prox = p.hinge === 'knee' ? J[S(s, 'hip')] : J[S(s, 'shoulder')];
        const end = p.hinge === 'knee' ? J[S(s, 'ankle')] : J[S(s, 'hand')];
        p.d1 = p.origin.clone().sub(prox).normalize();     // parent bone direction at rest
        p.d2 = end.clone().sub(p.origin).normalize();      // this bone's direction at rest
        p.rest = signedAngle(p.d1, p.d2, p.axis);          // its bend at rest
        data = R.JointData.revolute({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z }, { x: p.axis.x, y: p.axis.y, z: p.axis.z });
      } else {
        data = R.JointData.spherical({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z });
        // the bone's own axis at rest (for swing / twist limits)
        const next = { spine: 'chest', chest: 'neck', head: 'head' }[p.name];
        const tip = p.name === 'head' ? J.head : p.name.startsWith('upperArm') ? J[S(p.side, 'elbow')]
          : p.name.startsWith('thigh') ? J[S(p.side, 'knee')] : p.name.startsWith('foot') ? J[S(p.side, 'foot')].clone().setY(0.045).add(new THREE.Vector3(0, 0, 0.1)) : J[next];
        p.boneAxis = tip.clone().sub(p.jointPoint);
        if (p.boneAxis.lengthSq() < 1e-6) p.boneAxis.set(0, 1, 0);
        p.boneAxis.normalize();
      }
      p.joint = this.world.createImpulseJoint(data, par.body, p.body, true);
      p.joint.setContactsEnabled(false);
      if (p.hinge) {
        p.joint.configureMotorModel(R.MotorModel.AccelerationBased);
        p.joint.setLimits(p.flex[0] - p.rest, p.flex[1] - p.rest);
      } else {
        const raw = this.world.impulseJoints.raw;
        for (const ax of [3, 4, 5]) raw.jointConfigureMotorModel(p.joint.handle, ax, R.MotorModel.AccelerationBased);
      }
    }
    // the joint points other code reads
    this.p = {};
    for (const [name, part] of Object.entries(POINTS)) {
      const pt = new JointPoint(name, this.parts[part].body, V(JOINTS[name]).sub(this.parts[part].origin));
      pt.owner = owner;
      this.p[name] = pt;
    }
    this.points = Object.values(this.p);
    this.com = new THREE.Vector3(); this.comVel = new THREE.Vector3();
    this.grounded = { footL: false, footR: false };
    this.ik = {
      arm: { L: [J.shoulderL.distanceTo(J.elbowL), J.elbowL.distanceTo(J.handL)], R: [J.shoulderR.distanceTo(J.elbowR), J.elbowR.distanceTo(J.handR)] },
      leg: { L: [J.hipL.distanceTo(J.kneeL), J.kneeL.distanceTo(J.ankleL)], R: [J.hipR.distanceTo(J.kneeR), J.kneeR.distanceTo(J.ankleR)] },
    };
    phys.afterStep.push(() => this.sync());
    this.sync();
  }

  // ---------------------------------------------------------------- state
  /** Stand in the rest pose at (x, z), facing yaw. */
  reset(x, z, yaw) {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
    for (const p of this.list) {
      _v.copy(p.origin).applyQuaternion(q).add(_w.set(x, 0, z));
      p.body.setTranslation({ x: _v.x, y: _v.y, z: _v.z }, true);
      p.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.hasLast = false;
      p.pin = null;
    }
    this.sync(true);
  }

  /** Refresh joint points, centre of mass and foot contact (after every step). */
  sync(teleport = false) {
    for (const pt of this.points) {
      pt.prev.copy(pt.pos);
      const t = pt.body.translation(), r = pt.body.rotation();
      pt.pos.copy(pt.local).applyQuaternion(tq(r, _q)).add(tv(t, _v));
      if (teleport) pt.prev.copy(pt.pos);
    }
    let M = 0;
    this.com.set(0, 0, 0); this.comVel.set(0, 0, 0);
    for (const p of this.list) {
      const c = p.body.worldCom(), lv = p.body.linvel();
      this.com.x += c.x * p.mass; this.com.y += c.y * p.mass; this.com.z += c.z * p.mass;
      this.comVel.x += lv.x * p.mass; this.comVel.y += lv.y * p.mass; this.comVel.z += lv.z * p.mass;
      M += p.mass;
    }
    this.com.multiplyScalar(1 / M); this.comVel.multiplyScalar(1 / M);
    for (const f of ['footL', 'footR']) {
      const t = this.parts[f].body.translation();
      this.grounded[f] = t.y < 0.15;
    }
  }

  partQuat(name, out) { return tq(this.parts[name].body.rotation(), out); }
  partPos(name, out) { return tv(this.parts[name].body.translation(), out); }

  /** Contact dominance: a higher group can't be pushed by a lower one (it acts as infinitely heavy to it). */
  setDominance(g) {
    if (this.dominance === g) return;
    this.dominance = g;
    for (const p of this.list) p.body.setDominanceGroup(g);
  }

  /** Push a part (an impulse at a point, N·s). */
  hit(partName, impulse, point) {
    const b = this.parts[partName].body;
    b.applyImpulseAtPoint({ x: impulse.x, y: impulse.y, z: impulse.z }, { x: point.x, y: point.y, z: point.z }, true);
  }

  /** Move every part by d (keeps velocities). */
  shift(d) {
    for (const p of this.list) {
      const t = p.body.translation();
      p.body.setTranslation({ x: t.x + d.x, y: t.y + d.y, z: t.z + d.z }, true);
    }
  }

  // ---------------------------------------------------------------- muscles
  /**
   * Drive the body for one step.
   * pose: {
   *   yaw, lean, slip, crouch, twist        posture (same units as before: metres of lean/slip/crouch/twist)
   *   hands: { L: { target, pole, speed }, R }       world targets for the fists; pole = where the elbow points (world)
   *   feet:  { L: { target, pole, kick }, R }        world targets for the ankles; pole = where the knee points
   *   tone (0..1), relax: { head, body } (s), support (0..1), drive (horizontal force wanted, m/s² as a vector),
   *   standY: pelvis height to hold, strong: true for your own body (it follows you closely)
   * }
   */
  drive(h, pose) {
    const tone = pose.tone;
    const P = this.parts;
    const yawQ = _q2.setFromAxisAngle(Y, pose.yaw);
    const leanA = Math.atan2(pose.lean, 0.45), slipA = Math.atan2(pose.slip, 0.45), twistA = Math.atan2(pose.twist, 0.21);

    // ---- target world rotations of the spine chain
    const setT = (name, pitch, roll, yawOff) => {
      _e.set(pitch, yawOff, roll);
      P[name].target.copy(yawQ).multiply(_q.setFromEuler(_e));
    };
    setT('pelvis', leanA * 0.15, -slipA * 0.1, 0);
    setT('spine', leanA * 0.55, -slipA * 0.5, twistA * 0.45);
    setT('chest', leanA, -slipA, twistA);
    setT('head', leanA * 0.6 + (pose.headPitch || 0), -slipA * 1.2, twistA * 0.6);

    // ---- arms (IK to the fist targets) and legs (IK to the ankle targets)
    for (const s of ['L', 'R']) {
      const hd = pose.hands[s];
      const sh = this.p[S(s, 'shoulder')].pos;
      this.limbTargets(S(s, 'upperArm'), S(s, 'foreArm'), sh, hd.target, hd.pole, this.ik.arm[s]);
      const ft = pose.feet[s];
      const hip = this.p[S(s, 'hip')].pos;
      this.limbTargets(S(s, 'thigh'), S(s, 'shin'), hip, ft.target, ft.pole, this.ik.leg[s]);
      // feet: flat on the floor, facing where the body faces (a kicking foot follows its shin)
      const foot = P[S(s, 'foot')];
      if (ft.kick) foot.target.copy(P[S(s, 'shin')].targetWorld || yawQ);
      else foot.target.copy(yawQ);
    }

    // ---- joint motors
    const raw = this.world.impulseJoints.raw;
    const limp = tone < 0.12;
    for (const p of this.list) {
      if (!p.joint) continue;
      let str = p.strength * (0.04 + 0.96 * tone);
      if (pose.relax.head > 0 && (p.name === 'head')) str *= 0.3;
      if (pose.relax.body > 0 && (p.name === 'chest' || p.name === 'spine')) str *= 0.5;
      if (pose.strong && (p.part === 'ARM' || p.name === 'head')) str *= 2.5;   // your own arms follow your gloves closely
      const fast = p.part === 'ARM' ? (pose.hands[p.side]?.fast ? 1.7 : 1) : p.name.startsWith('thigh') || p.name.startsWith('shin') ? (pose.feet[p.side]?.kick ? 1.7 : 1) : 1;
      const rate = 22 * fast, wmax = 22 * fast;
      tq(p.parentPart.body.rotation(), _qp);
      tq(p.body.rotation(), _qc);
      const rel = _qr.copy(_qp).invert().multiply(_qc);            // child relative to parent (parent's frame)
      if (p.hinge) {
        const angle = 2 * Math.atan2(rel.x * p.axis.x + rel.y * p.axis.y + rel.z * p.axis.z, rel.w);
        let wv = 0;
        if (!limp) wv = THREE.MathUtils.clamp((p.hingeTarget - angle) * rate, -wmax, wmax);
        p.joint.configureMotorVelocity(wv, limp ? 30 : 400);
        p.joint.setMotorMaxForce(limp ? 1.5 + p.strength * 0.01 : str);
        continue;
      }
      // ball joint: the rotation still to go, in the parent's frame (Rapier's motor axes)
      const want = _qw.copy(_qp).invert().multiply(p.target);     // target relative rotation
      const err = rotvec(_qe.copy(want).multiply(_qi.copy(rel).invert()), _err);
      const wv = limp ? _wv.set(0, 0, 0) : _wv.copy(err).multiplyScalar(rate);
      if (wv.length() > wmax) wv.setLength(wmax);
      // soft range of motion: past its swing or twist limit a joint is pushed back hard
      let limitF = 0;
      const ax = _a.copy(p.boneAxis), now = _b.copy(p.boneAxis).applyQuaternion(rel);
      const swing = Math.acos(THREE.MathUtils.clamp(ax.dot(now), -1, 1));
      if (swing > p.swing) {
        const sAxis = _c.crossVectors(ax, now);
        if (sAxis.lengthSq() > 1e-10) { sAxis.normalize(); wv.addScaledVector(sAxis, -(swing - p.swing) * 30); limitF = 300; }
      }
      // twist about the bone: angle of rel's twist part
      const tw = 2 * Math.atan2(rel.x * ax.x + rel.y * ax.y + rel.z * ax.z, rel.w);
      const twn = Math.atan2(Math.sin(tw), Math.cos(tw));
      if (Math.abs(twn) > p.twist) { wv.addScaledVector(ax, -Math.sign(twn) * (Math.abs(twn) - p.twist) * 30); limitF = 300; }
      const force = limp ? Math.max(limitF, 1.5 + p.strength * 0.01) : Math.max(str, limitF);
      const factor = limp && !limitF ? 30 : 400;
      for (let i = 0; i < 3; i++) {
        raw.jointConfigureMotorVelocity(p.joint.handle, 3 + i, i === 0 ? wv.x : i === 1 ? wv.y : wv.z, factor);
        raw.jointSetMotorMaxForce(p.joint.handle, 3 + i, force);
      }
    }

    // ---- standing help (only with a foot on the floor)
    const pel = P.pelvis.body;
    // planted: on the floor and meant to stay there (gets the grip); grounded: any foot on the floor
    // (a stepping foot touching down still holds the body up)
    const planted = ['footL', 'footR'].filter((f) => this.grounded[f] && !pose.feet[f.slice(-1)].lifted);
    const grounded = (this.grounded.footL ? 1 : 0) + (this.grounded.footR ? 1 : 0);
    // A planted foot carries the body's weight, so it grips the canvas with that weight, not just
    // its own: while it bears weight it is made heavy (its friction then holds it, and the legs move
    // the body over it instead of dragging it about). A lifted foot is just a foot again.
    for (const f of ['footL', 'footR']) {
      const load = planted.includes(f) ? Math.min(1, pose.support * tone * 1.4) : 0;
      const extra = Math.round(load * 24);
      if (extra !== P[f].extra) { P[f].extra = extra; P[f].body.setAdditionalMass(extra, true); }
      // static friction: a loaded foot stays where it was put down; dragged further than a few
      // centimetres it slips, and grips again where it ends up
      const pin = P[f].pin || (P[f].pin = { on: false, x: 0, z: 0 });
      const b = P[f].body, t = b.translation();
      if (load > 0.5) {
        if (!pin.on) { pin.on = true; pin.x = t.x; pin.z = t.z; }
        let dx = t.x - pin.x, dz = t.z - pin.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.05) { pin.x += dx * (1 - 0.05 / d); pin.z += dz * (1 - 0.05 / d); dx = t.x - pin.x; dz = t.z - pin.z; }
        b.setTranslation({ x: t.x - dx * 0.8, y: t.y, z: t.z - dz * 0.8 }, true);
        const v = b.linvel();
        b.setLinvel({ x: v.x * 0.2, y: v.y, z: v.z * 0.2 }, true);
      } else pin.on = false;
    }
    const rising = pose.rising != null;
    const sup = rising ? 1 : grounded || pose.airborne ? pose.support * Math.min(1, tone * 1.4) : 0;
    if (rising) {
      // getting up: hold the pelvis over the spot it lay on while it's lifted
      const t = pel.translation(), v = pel.linvel();
      const ax = (pose.anchor.x - t.x) * 40 - v.x * 10, az = (pose.anchor.z - t.z) * 40 - v.z * 10;
      for (const n of ['pelvis', 'spine', 'chest']) {
        const m = P[n].mass * this.M / (P.pelvis.mass + P.spine.mass + P.chest.mass);
        P[n].body.applyImpulse({ x: ax * m * h, y: 0, z: az * m * h }, true);
      }
    }
    if (sup > 0) {
      const t = pel.translation(), v = pel.linvel();
      // hold the pelvis up (the legs' job, done as one bounded force)
      const Mg = this.M * 9.81;
      const fy = THREE.MathUtils.clamp(Mg * sup + this.M * (60 * (pose.standY - t.y) - 12 * v.y) * sup, 0, Mg * 1.6);
      pel.applyImpulse({ x: 0, y: fy * h, z: 0 }, true);
      // keep the pelvis upright and turned the way it should face
      tq(pel.rotation(), _qc);
      rotvec(_q.copy(P.pelvis.target).multiply(_qc.invert()), _w);
      const av = pel.angvel();
      _v.set(av.x, av.y, av.z);
      // a whole body's worth of inertia about the pelvis, tracked a fraction per step (stable)
      const Iw = _a.set(9, 2.2, 9);
      const tx = Iw.x * (_w.x * 14 - _v.x) * 0.25, ty = Iw.y * (_w.y * 14 - _v.y) * 0.35, tz = Iw.z * (_w.z * 14 - _v.z) * 0.25;
      const lim = (rising ? 2200 : 900) * sup * h;
      const tl = Math.hypot(tx, tz), k = tl > lim ? lim / tl : 1;
      pel.applyTorqueImpulse({ x: tx * k, y: THREE.MathUtils.clamp(ty, -lim, lim), z: tz * k }, true);
      // the chest too (a fighter stays tall: the back holds the upper body over the hips)
      const ch = P.chest.body;
      tq(ch.rotation(), _qc);
      rotvec(_q.copy(P.chest.target).multiply(_qc.invert()), _w);
      const cav = ch.angvel();
      const cx = 4 * (_w.x * 12 - cav.x) * 0.25, cz = 4 * (_w.z * 12 - cav.z) * 0.25;
      const clim = (rising ? 900 : 380) * sup * h, cl = Math.hypot(cx, cz), ck = cl > clim ? clim / cl : 1;
      ch.applyTorqueImpulse({ x: cx * ck, y: 0, z: cz * ck }, true);
    }
    // the legs push the body where it wants to go (limited by grip), only with a foot down
    // (spread over the whole body, so it moves as one instead of being tipped over its planted feet)
    if (grounded && pose.drive) {
      let moving = 0;
      for (const p of this.list) if (!planted.includes(p.name)) moving += p.mass;
      const share = this.M / moving;
      for (const p of this.list) {
        if (planted.includes(p.name)) continue;
        const m = p.mass * share;
        p.body.applyImpulse({ x: pose.drive.x * m * h, y: 0, z: pose.drive.z * m * h }, true);
      }
    }
  }

  /** Two-bone IK for a limb, then its parts' targets: the upper bone's world rotation and the hinge angle. */
  limbTargets(upperName, lowerName, root, target, pole, [l1, l2]) {
    const up = this.parts[upperName], lo = this.parts[lowerName];
    const mid = solveTwoBone(root, target, l1, l2, pole, _a.clone());
    const end = _b.copy(target).sub(root);
    const reach = Math.min(end.length(), l1 + l2 - 1e-4);
    end.setLength(reach).add(root);
    const d1 = mid.clone().sub(root).normalize(), d2 = end.clone().sub(mid).normalize();
    let n = d1.clone().cross(d2);
    if (n.lengthSq() < 0.0025) n = pole.clone().cross(end.clone().sub(root)); // nearly straight: from the pole
    n.normalize();
    // the hinge axis at rest, in the upper bone's rest frame, is lo.axis (rest rotations are the identity)
    frameQuat(d1, n, lo.d1, lo.axis, up.target);
    lo.hingeTarget = THREE.MathUtils.clamp(signedAngle(d1, d2, n) - lo.rest, lo.flex[0] - lo.rest, lo.flex[1] - lo.rest);
    lo.targetWorld = (lo.targetWorld || new THREE.Quaternion()).copy(up.target).multiply(_q.setFromAxisAngle(lo.axis, lo.hingeTarget));
  }

  /**
   * Where an arm should be drawn so its fist is exactly at `target` (your first-person glove, or
   * the other player's glove online): two-bone IK from the real shoulder, stretched along its
   * length (up to maxStretch) when the glove is further away than the arm reaches.
   * Returns { S, E, H, up, lo, k }: shoulder, elbow, fist, the upper arm's and forearm's world
   * rotations, and the stretch.
   */
  armPose(s, target, pole, maxStretch = 1.45, out = { S: new THREE.Vector3(), E: new THREE.Vector3(), H: new THREE.Vector3(), up: new THREE.Quaternion(), lo: new THREE.Quaternion(), k: 1 }) {
    const [l1, l2] = this.ik.arm[s];
    const lo = this.parts[S(s, 'foreArm')];
    out.S.copy(this.p[S(s, 'shoulder')].pos);
    const dist = out.H.copy(target).sub(out.S).length();
    out.k = THREE.MathUtils.clamp(dist / (l1 + l2 - 0.005), 1, maxStretch);
    const reach = (l1 + l2) * out.k - 0.005;
    if (dist > reach) out.H.setLength(reach);
    out.H.add(out.S);
    solveTwoBone(out.S, out.H, l1 * out.k, l2 * out.k, pole, out.E);
    const d1 = _fa2.subVectors(out.E, out.S).normalize(), d2 = _fb2.subVectors(out.H, out.E).normalize();
    const n = _fc2.crossVectors(d1, d2);
    if (n.lengthSq() < 0.0025) n.copy(pole).cross(_v.subVectors(out.H, out.S));
    n.normalize();
    frameQuat(d1, n, lo.d1, lo.axis, out.up);
    const bend = THREE.MathUtils.clamp(signedAngle(d1, d2, n) - lo.rest, lo.flex[0] - lo.rest, lo.flex[1] - lo.rest);
    out.lo.copy(out.up).multiply(_q.setFromAxisAngle(lo.axis, bend));
    return out;
  }

  get mass() { return this.M; }
}
