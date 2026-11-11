// One continuous, skinned human body.
//
// The body is modelled once, at load, as a signed distance field: smoothly
// blended ellipsoids and tapered capsules (torso, chest, glutes, limbs with
// muscle bulges, a head with jaw, nose and ears). A surface-nets pass turns
// that into a single smooth mesh, and every vertex is skinned to a 17-bone
// skeleton. Each frame the bones are placed from the physics points (the
// ragdoll's particles), so the whole body bends as one piece.

import * as THREE from 'three';

// ---------------------------------------------------------------- distance functions
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

function sdEllipsoid(x, y, z, c, r) {
  const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
  return k1 < 1e-9 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1;
}

/** Tapered capsule from a (radius r1) to b (radius r2). After Inigo Quilez's "round cone". */
function sdRoundCone(x, y, z, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = x - a[0], pay = y - a[1], paz = z - a[2];
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = yy * yy * l2, z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

const E = (c, r) => ({ e: true, c, r });
const C = (a, b, r1, r2) => ({ e: false, a, b, r1, r2 });
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add3 = (a, d) => [a[0] + d[0], a[1] + d[1], a[2] + d[2]];

function evalPrims(prims, k, x, y, z) {
  let d = 1e9;
  for (const p of prims) {
    const v = p.e ? sdEllipsoid(x, y, z, p.c, p.r) : sdRoundCone(x, y, z, p.a, p.b, p.r1, p.r2);
    d = d > 1e8 ? v : smin(d, v, k);
  }
  return d;
}

// ---------------------------------------------------------------- the human
/**
 * Body shape, in the rest pose given by joint positions J (arrays [x,y,z]),
 * facing +z with the body's left at +x. Parts are grouped so arms and legs
 * blend into the torso only where they attach (no webbing at elbows/knees).
 */
function humanGroups(J) {
  const sh = J.shoulderL[1], hipY = J.hipL[1];
  const torso = [
    E([0, J.pelvis[1] - 0.02, -0.01], [0.165, 0.12, 0.12]),           // hips
    E([0, J.belly[1], 0.0], [0.14, 0.14, 0.105]),                     // waist
    E([0, J.chest[1] + 0.01, -0.005], [0.172, 0.13, 0.112]),          // ribcage
    E([0.075, J.chest[1] + 0.015, 0.058], [0.085, 0.06, 0.055]),      // pecs
    E([-0.075, J.chest[1] + 0.015, 0.058], [0.085, 0.06, 0.055]),
    E([0, J.chest[1] - 0.04, -0.025], [0.19, 0.1, 0.09]),            // lats
    C([0.1, sh + 0.0, -0.02], [0, J.neck[1] + 0.04, -0.02], 0.05, 0.045),   // traps
    C([-0.1, sh + 0.0, -0.02], [0, J.neck[1] + 0.04, -0.02], 0.05, 0.045),
    E(add3(J.shoulderL, [0.015, 0, 0]), [0.072, 0.07, 0.066]),      // deltoids (shared with the arms)
    E(add3(J.shoulderR, [-0.015, 0, 0]), [0.072, 0.07, 0.066]),
    E([0.07, hipY - 0.03, -0.06], [0.085, 0.085, 0.072]),           // glutes (shared with the legs)
    E([-0.07, hipY - 0.03, -0.06], [0.085, 0.085, 0.072]),
    C([0, sh - 0.03, -0.005], [0, J.head[1] - 0.07, 0.0], 0.052, 0.047),    // neck
  ];
  const hy = J.head[1];
  const head = [
    C([0, sh + 0.02, -0.005], [0, hy - 0.07, 0.0], 0.052, 0.047),   // neck (shared)
    E([0, hy + 0.018, -0.005], [0.09, 0.108, 0.1]),                 // cranium
    E([0, hy - 0.05, 0.03], [0.068, 0.054, 0.07]),                  // jaw
    E([0, hy + 0.03, 0.072], [0.07, 0.02, 0.03]),                   // brow
    E([0, hy - 0.005, 0.1], [0.016, 0.026, 0.024]),                 // nose
    E([0.084, hy, -0.005], [0.014, 0.028, 0.02]),                   // ears
    E([-0.084, hy, -0.005], [0.014, 0.028, 0.02]),
  ];
  const arm = (s) => {
    const S = J['shoulder' + s], El = J['elbow' + s], H = J['hand' + s];
    const out = s === 'L' ? 1 : -1;
    return [
      E(add3(S, [out * 0.015, 0, 0]), [0.072, 0.07, 0.066]),       // deltoid (shared)
      C(S, El, 0.056, 0.043),                                      // upper arm
      E(lerp3(S, El, 0.5), [0.047, 0.05, 0.047]),                  // biceps
      C(El, H, 0.046, 0.034),                                      // forearm
      E(lerp3(El, H, 0.3), [0.048, 0.045, 0.048]),
      E(H, [0.042, 0.042, 0.048]),                                 // fist (under the glove)
    ];
  };
  const leg = (s) => {
    const Hp = J['hip' + s], K = J['knee' + s], F = J['foot' + s];
    const out = s === 'L' ? 1 : -1;
    const ankle = add3(F, [0, 0.04, -0.02]);
    return [
      E([out * 0.07, hipY - 0.03, -0.06], [0.085, 0.085, 0.072]),  // glute (shared)
      C(Hp, K, 0.092, 0.058),                                      // thigh
      E(add3(lerp3(Hp, K, 0.4), [0, 0, 0.02]), [0.075, 0.12, 0.07]), // quads
      C(K, ankle, 0.058, 0.038),                                   // shin
      E(add3(lerp3(K, ankle, 0.3), [0, 0, -0.03]), [0.05, 0.08, 0.05]), // calf
      E([F[0], 0.035, F[2] + 0.05], [0.046, 0.036, 0.112]),        // foot
    ];
  };
  return [
    { name: 'torso', prims: torso, k: 0.06 },
    { name: 'head', prims: head, k: 0.03 },
    { name: 'armL', prims: arm('L'), k: 0.045 },
    { name: 'armR', prims: arm('R'), k: 0.045 },
    { name: 'legL', prims: leg('L'), k: 0.05 },
    { name: 'legR', prims: leg('R'), k: 0.05 },
  ];
}

/** Bones: a segment from joint `from` to joint `to`, or a point bone at `from` aligned with `axis`. `lat` gives its sideways direction. */
export const HUMAN_BONES = [
  { name: 'pelvis', from: 'hipMid', to: 'belly', lat: ['hipL', 'hipR'] },
  { name: 'spine', from: 'belly', to: 'chest', lat: ['shoulderL', 'shoulderR'] },
  { name: 'chest', from: 'chest', to: 'neck', lat: ['shoulderL', 'shoulderR'] },
  { name: 'neck', from: 'neck', to: 'head', lat: ['shoulderL', 'shoulderR'] },
  { name: 'head', from: 'head', axis: ['neck', 'head'], lat: ['shoulderL', 'shoulderR'] },
  { name: 'upperArmL', from: 'shoulderL', to: 'elbowL', lat: ['shoulderL', 'shoulderR'] },
  { name: 'foreArmL', from: 'elbowL', to: 'handL', lat: ['shoulderL', 'shoulderR'] },
  { name: 'handL', from: 'handL', axis: ['elbowL', 'handL'], lat: ['shoulderL', 'shoulderR'] },
  { name: 'upperArmR', from: 'shoulderR', to: 'elbowR', lat: ['shoulderL', 'shoulderR'] },
  { name: 'foreArmR', from: 'elbowR', to: 'handR', lat: ['shoulderL', 'shoulderR'] },
  { name: 'handR', from: 'handR', axis: ['elbowR', 'handR'], lat: ['shoulderL', 'shoulderR'] },
  { name: 'thighL', from: 'hipL', to: 'kneeL', lat: ['hipL', 'hipR'] },
  { name: 'shinL', from: 'kneeL', to: 'footL', lat: ['hipL', 'hipR'] },
  { name: 'footL', from: 'footL', axis: ['kneeL', 'footL'], lat: ['hipL', 'hipR'] },
  { name: 'thighR', from: 'hipR', to: 'kneeR', lat: ['hipL', 'hipR'] },
  { name: 'shinR', from: 'kneeR', to: 'footR', lat: ['hipL', 'hipR'] },
  { name: 'footR', from: 'footR', axis: ['kneeR', 'footR'], lat: ['hipL', 'hipR'] },
];
// which bones each body part may be skinned to, and how strongly (neighbouring parts only pull a little)
const GROUP_BONES = {
  torso: [['pelvis', 1], ['spine', 1], ['chest', 1], ['neck', 1], ['upperArmL', 0.15], ['upperArmR', 0.15], ['thighL', 0.25], ['thighR', 0.25]],
  head: [['head', 1], ['neck', 0.6]],
  armL: [['upperArmL', 1], ['foreArmL', 1], ['handL', 1], ['chest', 0.4]],
  armR: [['upperArmR', 1], ['foreArmR', 1], ['handR', 1], ['chest', 0.4]],
  legL: [['thighL', 1], ['shinL', 1], ['footL', 1], ['pelvis', 0.5]],
  legR: [['thighR', 1], ['shinR', 1], ['footR', 1], ['pelvis', 0.5]],
};

// ---------------------------------------------------------------- meshing
/** Naive surface nets over a sampled distance field. Returns positions, normals and per-vertex group index. */
function surfaceNets(groups, bounds, h) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  const nx = Math.ceil((x1 - x0) / h) + 1, ny = Math.ceil((y1 - y0) / h) + 1, nz = Math.ceil((z1 - z0) / h) + 1;
  const field = new Float32Array(nx * ny * nz);
  const idx = (i, j, k) => i + nx * (j + ny * k);
  const sample = (x, y, z) => {
    let d = 1e9;
    for (const g of groups) { const v = evalPrims(g.prims, g.k, x, y, z); if (v < d) d = v; }
    return d;
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) field[idx(i, j, k)] = sample(x0 + i * h, y0 + j * h, z0 + k * h);

  const vertOf = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) { v[c] = field[idx(i + corners[c][0], j + corners[c][1], k + corners[c][2])]; if (v[c] < 0) inside++; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      n++;
    }
    vertOf[cidx(i, j, k)] = pos.length / 3;
    pos.push(x0 + (i + sx / n) * h, y0 + (j + sy / n) * h, z0 + (k + sz / n) * h);
  }
  // one quad per sign-changing grid edge, joining the four cells around it
  const tris = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c); else tris.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const s0 = field[idx(i, j, k)] < 0;
    if (s0 !== (field[idx(i + 1, j, k)] < 0)) quad(vertOf[cidx(i, j - 1, k - 1)], vertOf[cidx(i, j, k - 1)], vertOf[cidx(i, j, k)], vertOf[cidx(i, j - 1, k)], !s0);
    if (s0 !== (field[idx(i, j + 1, k)] < 0)) quad(vertOf[cidx(i - 1, j, k - 1)], vertOf[cidx(i - 1, j, k)], vertOf[cidx(i, j, k)], vertOf[cidx(i, j, k - 1)], !s0);
    if (s0 !== (field[idx(i, j, k + 1)] < 0)) quad(vertOf[cidx(i - 1, j - 1, k)], vertOf[cidx(i, j - 1, k)], vertOf[cidx(i, j, k)], vertOf[cidx(i - 1, j, k)], !s0);
  }
  // smooth normals from the field gradient; group = the part closest to each vertex
  const nrm = new Float32Array(pos.length), grp = new Uint8Array(pos.length / 3);
  const e = h * 0.5;
  for (let q = 0; q < pos.length; q += 3) {
    const x = pos[q], y = pos[q + 1], z = pos[q + 2];
    const gx = sample(x + e, y, z) - sample(x - e, y, z);
    const gy = sample(x, y + e, z) - sample(x, y - e, z);
    const gz = sample(x, y, z + e) - sample(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    nrm[q] = gx / l; nrm[q + 1] = gy / l; nrm[q + 2] = gz / l;
    let best = 1e9;
    groups.forEach((g, gi) => { const d = evalPrims(g.prims, g.k, x, y, z); if (d < best) { best = d; grp[q / 3] = gi; } });
  }
  return { pos: new Float32Array(pos), nrm, grp, index: tris };
}

// ---------------------------------------------------------------- bone frames
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _t = new THREE.Vector3();
const toV = (a) => (a.isVector3 ? a : _t.set(a[0], a[1], a[2]));

/** Write a bone's world matrix from joint positions. Returns the segment length (or 0 for point bones). */
function boneMatrix(bone, J, out, restLen) {
  const from = J[bone.from];
  let len = 0;
  if (bone.to) { _y.copy(toV(J[bone.to])).sub(toV(from)); len = _y.length(); }
  else _y.copy(toV(J[bone.axis[1]])).sub(toV(J[bone.axis[0]]));
  _y.normalize();
  _x.copy(toV(J[bone.lat[0]])).sub(toV(J[bone.lat[1]]));
  _x.addScaledVector(_y, -_x.dot(_y));
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y);
  const s = restLen ? len / restLen : 1;
  out.makeBasis(_x, _y.multiplyScalar(s), _z);
  out.setPosition(toV(from));
  return len;
}

/** Joint positions as plain arrays, adding the hip midpoint. */
function withHipMid(J) {
  const out = {};
  for (const [k, v] of Object.entries(J)) out[k] = v.isVector3 ? [v.x, v.y, v.z] : [...v];
  if (out.hipL && out.hipR) out.hipMid = lerp3(out.hipL, out.hipR, 0.5);
  return out;
}

// ---------------------------------------------------------------- template + instances
/**
 * Build the body once. restJ: joint positions in the rest pose ({name: [x,y,z]}).
 * Returns a template: geometry (positions, normals, skin indices/weights, region ids) and bone rest data.
 */
export function buildHumanTemplate(restJ, { voxel = 0.015 } = {}) {
  const J = withHipMid(restJ);
  const groups = humanGroups(J);
  const t0 = performance.now();
  const mesh = surfaceNets(groups, [-0.42, 0.0, -0.3, 0.42, 1.84, 0.5], voxel);
  const bones = HUMAN_BONES;
  const boneIndex = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const rest = bones.map((b) => { const m = new THREE.Matrix4(); const len = boneMatrix(b, J, m, 0); return { m, len }; });

  // skinning: each vertex to its 3 nearest allowed bones, weighted by 1/d^4
  const n = mesh.pos.length / 3;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), region = new Uint8Array(n);
  const segDist = (b, x, y, z) => {
    const A = J[b.from];
    if (!b.to) return Math.hypot(x - A[0], y - A[1], z - A[2]);
    const B = J[b.to];
    const bx = B[0] - A[0], by = B[1] - A[1], bz = B[2] - A[2];
    const t = Math.min(1, Math.max(0, ((x - A[0]) * bx + (y - A[1]) * by + (z - A[2]) * bz) / (bx * bx + by * by + bz * bz)));
    return Math.hypot(x - A[0] - bx * t, y - A[1] - by * t, z - A[2] - bz * t);
  };
  for (let v = 0; v < n; v++) {
    const x = mesh.pos[v * 3], y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2];
    const gname = groups[mesh.grp[v]].name;
    const cands = GROUP_BONES[gname].map(([name, f]) => {
      const d = segDist(bones[boneIndex[name]], x, y, z);
      return { i: boneIndex[name], w: f / Math.pow(d + 0.012, 4) };
    }).sort((a, b) => b.w - a.w).slice(0, 3);
    const sum = cands.reduce((s, c) => s + c.w, 0);
    cands.forEach((c, k) => { skinIndex[v * 4 + k] = c.i; skinWeight[v * 4 + k] = c.w / sum; });
    // regions for colouring: 0 skin, 1 shorts, 2 waistband, 3 hair
    let r = 0;
    if ((gname === 'torso' || gname === 'legL' || gname === 'legR') && y < J.belly[1] - 0.03 && y > J.kneeL[1] + 0.17) r = 1;
    if (gname === 'torso' && y >= J.belly[1] - 0.06 && y < J.belly[1] - 0.03) r = 2;
    if (gname === 'head' && y > J.head[1] + 0.035 && z < 0.06) r = 3;
    region[v] = r;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(mesh.index);
  return { geometry, region, bones, rest, ms: performance.now() - t0, vertices: n };
}

/** One skinned body in the scene, posed from joint positions each frame. */
export class SkinnedBody {
  constructor(scene, template, colors) {
    this.t = template;
    const geo = template.geometry.clone();
    const n = template.region.length;
    const col = new Float32Array(n * 3);
    const palette = [colors.skin, colors.shorts, colors.trim, colors.hair].map((c) => new THREE.Color(c));
    for (let v = 0; v < n; v++) { const c = palette[template.region[v]]; col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.bones = template.bones.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.matrixWorldAutoUpdate = false; return b; });
    const inverses = template.rest.map((r) => r.m.clone().invert());
    for (let i = 0; i < this.bones.length; i++) this.bones[i].matrixWorld.copy(template.rest[i].m);
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
    this.mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02 }));
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }

  /** J: joint name -> Vector3 (world). hipMid is derived when missing. */
  update(J) {
    if (!J.hipMid && J.hipL) J.hipMid = (this._hm || (this._hm = new THREE.Vector3())).addVectors(J.hipL, J.hipR).multiplyScalar(0.5);
    const bones = this.t.bones;
    for (let i = 0; i < bones.length; i++) boneMatrix(bones[i], J, this.bones[i].matrixWorld, this.t.rest[i].len);
  }
}

// ---------------------------------------------------------------- first-person arm
/** A single arm (shoulder, upper arm, forearm, wrist) as one skinned piece, for your own first-person view. */
export function buildArmTemplate({ voxel = 0.01 } = {}) {
  const S = [0, 0, 0], El = [0, -0.32, 0.04], H = [0, -0.32, 0.4];
  const prims = [
    E([0, 0.01, 0], [0.07, 0.068, 0.064]),
    C(S, El, 0.056, 0.043),
    E(lerp3(S, El, 0.5), [0.047, 0.05, 0.047]),
    C(El, H, 0.046, 0.033),
    E(lerp3(El, H, 0.3), [0.048, 0.045, 0.048]),
  ];
  const groups = [{ name: 'arm', prims, k: 0.045 }];
  const mesh = surfaceNets(groups, [-0.1, -0.42, -0.1, 0.1, 0.1, 0.46], voxel);
  const J = { shoulder: S, elbow: El, hand: H, latA: [1, 0, 0], latB: [0, 0, 0] };
  const bones = [
    { name: 'upper', from: 'shoulder', to: 'elbow', lat: ['latA', 'latB'] },
    { name: 'fore', from: 'elbow', to: 'hand', lat: ['latA', 'latB'] },
  ];
  const rest = bones.map((b) => { const m = new THREE.Matrix4(); const len = boneMatrix(b, J, m, 0); return { m, len }; });
  const n = mesh.pos.length / 3;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    // blend across the elbow by distance along the arm
    const y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2];
    const along = y > -0.25 ? 0 : z > 0.1 ? 1 : 0.5 + Math.max(-0.5, Math.min(0.5, (z - 0.04) / 0.12));
    skinIndex[v * 4] = 0; skinIndex[v * 4 + 1] = 1;
    skinWeight[v * 4] = 1 - along; skinWeight[v * 4 + 1] = along;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(mesh.index);
  return { geometry, region: new Uint8Array(n), bones, rest };
}
