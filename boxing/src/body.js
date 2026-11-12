// One continuous, skinned human body.
//
// The body is box-modelled in code (models.js): a quad cage extruded from a pelvis box
// into torso, legs, arms, neck and head, smoothed with Catmull–Clark subdivision, and
// skinned to a 17-bone skeleton on the cage. Each frame the bones ride on the ragdoll's
// rigid body parts, so the whole body bends as one piece.

import * as THREE from 'three';
import { buildCartoonBody, buildCartoonArm, buildCartoonGlove } from './models.js';

// ---------------------------------------------------------------- skeleton
/**
 * Bones. The pelvis and chest take their orientation from the hips / shoulders; the
 * spine is halfway between. Every other bone inherits its parent's rotation and then
 * only *swings* to point along its segment, so limbs never flip their twist or stretch.
 */
export const HUMAN_BONES = [
  { name: 'pelvis', root: true, from: 'hipMid', to: 'belly', up: ['hipMid', 'belly'], lat: ['hipL', 'hipR'] },
  { name: 'chest', root: true, from: 'chest', to: 'neck', up: ['belly', 'neck'], lat: ['shoulderL', 'shoulderR'] },
  { name: 'spine', between: ['pelvis', 'chest'], from: 'belly', to: 'chest' },
  { name: 'neck', parent: 'chest', from: 'neck', to: 'head' },
  { name: 'head', parent: 'neck', from: 'head', rigid: true },
  { name: 'upperArmL', parent: 'chest', from: 'shoulderL', to: 'elbowL' },
  { name: 'foreArmL', parent: 'upperArmL', from: 'elbowL', to: 'handL' },
  { name: 'handL', parent: 'foreArmL', from: 'handL', rigid: true },
  { name: 'upperArmR', parent: 'chest', from: 'shoulderR', to: 'elbowR' },
  { name: 'foreArmR', parent: 'upperArmR', from: 'elbowR', to: 'handR' },
  { name: 'handR', parent: 'foreArmR', from: 'handR', rigid: true },
  { name: 'thighL', parent: 'pelvis', from: 'hipL', to: 'kneeL' },
  { name: 'shinL', parent: 'thighL', from: 'kneeL', to: 'footL' },
  { name: 'footL', parent: 'shinL', from: 'footL', rigid: true },
  { name: 'thighR', parent: 'pelvis', from: 'hipR', to: 'kneeR' },
  { name: 'shinR', parent: 'thighR', from: 'kneeR', to: 'footR' },
  { name: 'footR', parent: 'shinR', from: 'footR', rigid: true },
];
// ---------------------------------------------------------------- bone poses
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _m = new THREE.Matrix4(), _qd = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const V = (a, out) => (a.isVector3 ? out.copy(a) : out.set(a[0], a[1], a[2]));

/** Rotation whose Y axis points along `up` and whose X axis points along `lat` (made perpendicular). */
function basisQuat(up, lat, out) {
  _y.copy(up).normalize();
  _x.copy(lat).addScaledVector(_y, -lat.dot(_y));
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Pose every bone from joint positions. rest: per-bone {q, dir} from the rest pose (or
 * null while building the rest pose itself). Writes rotations into qs and positions into ps.
 */
function poseBones(bones, index, J, rest, qs, ps) {
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    V(J[b.from], ps[i]);
    if (b.root) {
      basisQuat(V(J[b.up[1]], _a).sub(V(J[b.up[0]], _b)), V(J[b.lat[0]], _b).sub(V(J[b.lat[1]], _x).clone()), qs[i]);
    } else if (b.between) {
      qs[i].slerpQuaternions(qs[index[b.between[0]]], qs[index[b.between[1]]], 0.5);
    } else {
      const pi = index[b.parent];
      if (!rest) {
        // rest pose: aim along the segment, sideways like the parent
        _a.set(1, 0, 0).applyQuaternion(qs[pi]);
        if (b.rigid) qs[i].copy(qs[pi]);
        else basisQuat(V(J[b.to], _b).sub(ps[i]), _a, qs[i]);
        continue;
      }
      // how far the parent has turned since the rest pose...
      _qd.copy(qs[pi]).multiply(_qi.copy(rest[pi].q).invert());
      qs[i].copy(_qd).multiply(rest[i].q);
      if (!b.rigid) {
        // ...then swing (no twist) from where that leaves the segment to where it really points
        _a.copy(rest[i].dir).applyQuaternion(_qd);
        _b.copy(V(J[b.to], _b)).sub(ps[i]);
        if (_b.lengthSq() > 1e-10) qs[i].premultiply(_qs.setFromUnitVectors(_a.normalize(), _b.normalize()));
      }
    }
  }
}

/** Joint positions as plain arrays, adding the hip midpoint. */
function withHipMid(J) {
  const out = {};
  for (const [k, v] of Object.entries(J)) out[k] = v.isVector3 ? [v.x, v.y, v.z] : [...v];
  if (out.hipL && out.hipR) out.hipMid = lerp3(out.hipL, out.hipR, 0.5);
  return out;
}

function restOf(bones, J) {
  const index = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const qs = bones.map(() => new THREE.Quaternion()), ps = bones.map(() => new THREE.Vector3());
  poseBones(bones, index, J, null, qs, ps);
  return bones.map((b, i) => ({
    q: qs[i].clone(), p: ps[i].clone(),
    dir: b.to ? V(J[b.to], new THREE.Vector3()).sub(ps[i]).normalize() : new THREE.Vector3(0, 1, 0),
    m: new THREE.Matrix4().compose(ps[i], qs[i], new THREE.Vector3(1, 1, 1)),
  }));
}

// ---------------------------------------------------------------- materials: solid colours, toon shading, outline
let toonRamp = null;
/** A 4-step lighting ramp (generated, not an image) for flat cartoon shading. */
function rampTexture() {
  if (toonRamp) return toonRamp;
  const data = new Uint8Array([90, 90, 90, 255, 150, 150, 150, 255, 215, 215, 215, 255, 255, 255, 255, 255]);
  toonRamp = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;
  return toonRamp;
}
export function toonMaterial(opts = {}) {
  return new THREE.MeshToonMaterial({ gradientMap: rampTexture(), ...opts });
}
/**
 * Toon material that paints skin, shorts, waistband and hair as solid colours, deciding per
 * pixel from the rest-pose position (so the hems and hairline are clean lines, not the
 * sawtooth you get from colouring whole triangles).
 */
function regionMaterial(colors, cuts) {
  const m = toonMaterial();
  const C = (c) => new THREE.Color(c);
  const cut = (cuts || new THREE.Vector4(-9, 9, 9, 0)).clone();
  if (colors.trousers) cut.y = 0.13;   // full-length trousers instead of shorts
  const U = { uSkin: { value: C(colors.skin) }, uShorts: { value: C(colors.shorts) }, uTrim: { value: C(colors.trim) }, uHair: { value: C(colors.hair) },
    uShirt: { value: C(colors.shirt ?? colors.skin) }, uShirtOn: { value: colors.shirt != null ? 1 : 0 }, uCut: { value: cut } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aZone;\nvarying vec3 vRest;\nvarying float vZone;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRest = position; vZone = aZone;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSkin, uShorts, uTrim, uHair, uShirt;\nuniform float uShirtOn;\nuniform vec4 uCut;\nvarying vec3 vRest;\nvarying float vZone;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
  vec3 col = uSkin;
  float y = vRest.y;
  if (vZone > 0.5 && vZone < 1.5) {
    if (y >= uCut.x - 0.07 && y < uCut.x - 0.03) col = uTrim;
    else if (y < uCut.x - 0.03 && y > uCut.y) col = uShorts;
  }
  // a short-sleeved shirt (the referee): torso above the waistband, and the upper arms
  if (uShirtOn > 0.5 && ((vZone > 0.5 && vZone < 1.5 && y >= uCut.x - 0.03) || (vZone > 0.1 && vZone < 0.5))) col = uShirt;
  // ...and shoes under the trousers
  if (uShirtOn > 0.5 && vZone > 0.5 && vZone < 1.5 && y < uCut.y) col = uTrim;
  // hair: the crown, and down the back of the head
  if (vZone > 1.5 && ((y > uCut.z && vRest.z < uCut.w) || (y > uCut.z - 0.1 && vRest.z < uCut.w - 0.11))) col = uHair;
  vec4 diffuseColor = vec4( col, opacity );`);
  };
  m.customProgramCacheKey = () => 'region3';
  return m;
}

/** Dark outline: the mesh drawn again, inside out and pushed out along its normals. */
export function outlineMaterial(width = 0.011) {
  const m = new THREE.MeshBasicMaterial({ color: 0x14100e, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n  transformed += normalize(normal) * ${width.toFixed(4)};`);
  };
  return m;
}

// ---------------------------------------------------------------- template + instances
/**
 * Build the body once. restJ: joint positions in the rest pose ({name: [x,y,z]}).
 * Returns a template: geometry (positions, normals, skin indices/weights) and bone rest data.
 */
export function buildHumanTemplate(restJ) {
  const J = withHipMid(restJ);
  const t0 = performance.now();
  const bones = HUMAN_BONES;
  const rest = restOf(bones, J);
  // box-modelled in code with clean quad topology, skinned on the cage (see models.js)
  const mesh = buildCartoonBody(J, bones.map((b) => b.name));
  const n = mesh.pos.length / 3;
  // where the colours change, in the rest pose: waist, shorts hem, hairline
  const cuts = new THREE.Vector4(J.belly[1], J.kneeL[1] + 0.15, J.head[1] + 0.07, 0.07);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mesh.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(mesh.skinWeight, 4));
  geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  // colour zones: 1 torso and legs (shorts), 2 head (hair), 0 forearms, 0.25 upper arms (sleeves)
  geometry.setAttribute('aZone', new THREE.BufferAttribute(mesh.zone, 1));
  return { geometry, region: new Uint8Array(n), bones, rest, cuts, ms: performance.now() - t0, vertices: n, quads: mesh.quads, cageQuads: mesh.cageQuads };
}

/** One skinned body in the scene (solid colours, toon shaded, outlined), posed from joint positions each frame. */
export class SkinnedBody {
  constructor(scene, template, colors, { outline = 0.009 } = {}) {
    this.t = template;
    const geo = template.geometry.clone();
    if (!geo.getAttribute('aZone')) geo.setAttribute('aZone', new THREE.BufferAttribute(new Float32Array(template.region.length), 1));
    this.index = Object.fromEntries(template.bones.map((b, i) => [b.name, i]));
    this.qs = template.bones.map(() => new THREE.Quaternion());
    this.ps = template.bones.map(() => new THREE.Vector3());
    this.bones = template.bones.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.matrixWorldAutoUpdate = false; return b; });
    const inverses = template.rest.map((r) => r.m.clone().invert());
    for (let i = 0; i < this.bones.length; i++) this.bones[i].matrixWorld.copy(template.rest[i].m);
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
    this.mesh = new THREE.SkinnedMesh(geo, regionMaterial(colors, template.cuts));
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    if (outline) {
      this.outline = new THREE.SkinnedMesh(geo, outlineMaterial(outline));
      this.outline.bind(this.skeleton, new THREE.Matrix4());
      this.outline.frustumCulled = false;
      scene.add(this.outline);
    }
  }

  set visible(v) { this.mesh.visible = v; if (this.outline) this.outline.visible = v; }
  get visible() { return this.mesh.visible; }

  /**
   * Pose the skeleton straight from a rigid-body ragdoll: every bone rides on its body part
   * (bone = part's transform × the bone's rest pose relative to the part's rest), so the mesh
   * turns exactly as the bodies do and can never twist or stretch. The neck is the halfway
   * rotation between chest and head.
   */
  updateFromRig(rig, arms = null) {
    const bones = this.t.bones;
    if (!this._off) {
      this._off = bones.map((b, i) => {
        const part = rig.parts[BONE_PART[b.name]];
        return new THREE.Matrix4().makeTranslation(-part.origin.x, -part.origin.y, -part.origin.z).multiply(this.t.rest[i].m);
      });
      this._neck = this.index.neck;
    }
    for (let i = 0; i < bones.length; i++) {
      const part = rig.parts[BONE_PART[bones[i].name]];
      const t = part.body.translation(), r = part.body.rotation();
      _bq.set(r.x, r.y, r.z, r.w);
      const m = this.bones[i].matrixWorld.compose(_bp.set(t.x, t.y, t.z), _bq, ONE).multiply(this._off[i]);
      if (i === this._neck) {   // halfway between the chest and the head
        const c = rig.parts.chest.body.rotation();
        _bq2.set(c.x, c.y, c.z, c.w).slerp(_bq, 0.5).multiply(this.t.rest[i].q);
        _bp.setFromMatrixPosition(m);
        m.compose(_bp, _bq2, ONE);
      }
    }
    // arms drawn exactly onto given fists (see Ragdoll.armPose): each bone at its joint, turned
    // like its part, and stretched along its length (the bone's own x axis) if the fist is far
    if (arms) {
      for (const s of ['L', 'R']) {
        const a = arms[s];
        if (!a) continue;
        const iu = this.index['upperArm' + s], il = this.index['foreArm' + s], ih = this.index['hand' + s];
        _bs.set(a.k, 1, 1);
        this.bones[iu].matrixWorld.compose(a.S, _bq.copy(a.up).multiply(this.t.rest[iu].q), _bs);
        this.bones[il].matrixWorld.compose(a.E, _bq.copy(a.lo).multiply(this.t.rest[il].q), _bs);
        this.bones[ih].matrixWorld.compose(a.H, _bq.copy(a.lo).multiply(this.t.rest[ih].q), ONE);
      }
    }
  }

  /** J: joint name -> Vector3 (world). hipMid is derived when missing. */
  update(J) {
    if (!J.hipMid && J.hipL) J.hipMid = (this._hm || (this._hm = new THREE.Vector3())).addVectors(J.hipL, J.hipR).multiplyScalar(0.5);
    poseBones(this.t.bones, this.index, J, this.t.rest, this.qs, this.ps);
    for (let i = 0; i < this.bones.length; i++) this.bones[i].matrixWorld.compose(this.ps[i], this.qs[i], ONE);
  }
}
const ONE = new THREE.Vector3(1, 1, 1);
const _bp = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bq2 = new THREE.Quaternion(), _bs = new THREE.Vector3();
/** Which ragdoll body part each bone rides on. */
const BONE_PART = {
  pelvis: 'pelvis', spine: 'spine', chest: 'chest', neck: 'head', head: 'head',
  upperArmL: 'upperArmL', foreArmL: 'foreArmL', handL: 'foreArmL', upperArmR: 'upperArmR', foreArmR: 'foreArmR', handR: 'foreArmR',
  thighL: 'thighL', shinL: 'shinL', footL: 'footL', thighR: 'thighR', shinR: 'shinR', footR: 'footR',
};

// ---------------------------------------------------------------- first-person arm
/** A single arm (shoulder, upper arm, forearm, wrist) as one skinned piece, for your own first-person view. */
export function buildArmTemplate() {
  const S = [0, 0, 0], El = [0, -0.32, 0.04], H = [0, -0.32, 0.4];
  const mesh = buildCartoonArm(El, H);
  const J = { shoulder: S, elbow: El, hand: H, base: [0, 0.3, 0], latA: [1, 0, 0], latB: [0, 0, 0] };
  const bones = [
    { name: 'base', root: true, from: 'shoulder', to: 'base', up: ['shoulder', 'base'], lat: ['latA', 'latB'] },
    { name: 'upper', parent: 'base', from: 'shoulder', to: 'elbow' },
    { name: 'fore', parent: 'upper', from: 'elbow', to: 'hand' },
  ];
  const rest = restOf(bones, J);
  const n = mesh.pos.length / 3;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mesh.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(mesh.skinWeight, 4));
  geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  return { geometry, region: new Uint8Array(n), bones, rest };
}

// ---------------------------------------------------------------- MMA glove
/**
 * A toy-like, extra-puffy open-finger MMA glove (box-modelled with clean quads: see models.js).
 * Local frame: knuckles toward +z, back of the hand +y, the wearer's left +x.
 * thumbSide: -1 puts the thumb at -x (a left glove), +1 at +x (a right glove).
 * colors: { glove, strap, band, skin }.
 */
export function buildGloveGeometry(thumbSide, colors) {
  return buildCartoonGlove(thumbSide, colors);
}

/** A glove as a ready-to-place group: toon shaded with an outline. Returns { group, material }. */
export function makeGlove(thumbSide, colors, outline = 0.004) {
  const geo = buildGloveGeometry(thumbSide, colors);
  const material = toonMaterial({ vertexColors: true });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  group.add(mesh);
  if (outline) group.add(new THREE.Mesh(geo, outlineMaterial(outline)));
  return { group, material };
}
