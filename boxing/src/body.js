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

// ---------------------------------------------------------------- the human (cartoon proportions)
/**
 * Body shape, in the rest pose given by joint positions J (arrays [x,y,z]),
 * facing +z with the body's left at +x. Chunky cartoon proportions: a big head,
 * strong jaw, thick neck, V-shaped torso, big shoulders and forearms, flared shorts.
 * Parts are grouped so arms and legs blend into the torso only where they attach.
 */
function humanGroups(J) {
  const sh = J.shoulderL[1], hipY = J.hipL[1];
  const hy = J.head[1];
  const torso = [
    E([0, J.pelvis[1] - 0.02, -0.01], [0.17, 0.13, 0.125]),          // hips
    E([0, J.belly[1], 0.005], [0.135, 0.14, 0.11]),                   // waist
    E([0, J.chest[1] + 0.02, -0.005], [0.2, 0.15, 0.13]),             // ribcage
    E([0.085, J.chest[1] + 0.02, 0.065], [0.1, 0.07, 0.065]),         // pecs
    E([-0.085, J.chest[1] + 0.02, 0.065], [0.1, 0.07, 0.065]),
    E([0, J.chest[1] - 0.03, -0.03], [0.225, 0.11, 0.1]),            // lats
    C([0.11, sh + 0.01, -0.02], [0, J.neck[1] + 0.06, -0.02], 0.062, 0.055),   // traps
    C([-0.11, sh + 0.01, -0.02], [0, J.neck[1] + 0.06, -0.02], 0.062, 0.055),
    E(add3(J.shoulderL, [0.02, 0.005, 0]), [0.088, 0.085, 0.08]),   // big deltoids (shared with the arms)
    E(add3(J.shoulderR, [-0.02, 0.005, 0]), [0.088, 0.085, 0.08]),
    E([0.072, hipY - 0.03, -0.065], [0.09, 0.09, 0.078]),           // glutes (shared with the legs)
    E([-0.072, hipY - 0.03, -0.065], [0.09, 0.09, 0.078]),
    C([0, sh - 0.03, -0.01], [0, hy - 0.06, -0.005], 0.072, 0.065),  // thick neck
  ];
  const head = [
    C([0, sh + 0.02, -0.01], [0, hy - 0.06, -0.005], 0.072, 0.065),  // neck (shared)
    E([0, hy + 0.03, -0.01], [0.124, 0.138, 0.128]),                // big round cranium
    E([0, hy - 0.05, 0.03], [0.108, 0.085, 0.1]),                   // strong jaw (hides most of the neck)
    E([0, hy + 0.045, 0.095], [0.1, 0.03, 0.04]),                   // heavy brow
    E([0, hy + 0.0, 0.132], [0.03, 0.036, 0.034]),                  // big nose
    E([0, hy - 0.062, 0.122], [0.044, 0.022, 0.022]),               // chin / lips
    E([0.122, hy + 0.01, -0.01], [0.022, 0.038, 0.028]),            // ears
    E([-0.122, hy + 0.01, -0.01], [0.022, 0.038, 0.028]),
  ];
  const arm = (s) => {
    const S = J['shoulder' + s], El = J['elbow' + s], H = J['hand' + s];
    const out = s === 'L' ? 1 : -1;
    return [
      E(add3(S, [out * 0.02, 0.005, 0]), [0.088, 0.085, 0.08]),    // deltoid (shared)
      C(S, El, 0.066, 0.05),                                       // upper arm
      E(lerp3(S, El, 0.48), [0.058, 0.062, 0.058]),                // biceps
      C(El, H, 0.056, 0.04),                                       // big forearm
      E(lerp3(El, H, 0.3), [0.06, 0.055, 0.06]),
      E(H, [0.045, 0.045, 0.05]),                                  // fist (under the glove)
    ];
  };
  const leg = (s) => {
    const Hp = J['hip' + s], K = J['knee' + s], F = J['foot' + s];
    const out = s === 'L' ? 1 : -1;
    const ankle = add3(F, [0, 0.045, -0.02]);
    return [
      E([out * 0.072, hipY - 0.03, -0.065], [0.09, 0.09, 0.078]), // glute (shared)
      C(Hp, K, 0.098, 0.066),                                      // thigh
      E(add3(lerp3(Hp, K, 0.28), [out * 0.012, 0, 0.005]), [0.112, 0.12, 0.11]), // flared shorts leg
      C(K, ankle, 0.064, 0.042),                                   // shin
      E(add3(lerp3(K, ankle, 0.3), [0, 0, -0.035]), [0.058, 0.085, 0.056]), // calf
      E([F[0], 0.04, F[2] + 0.05], [0.052, 0.042, 0.122]),         // big foot
    ];
  };
  return [
    { name: 'torso', prims: torso, k: 0.06 },
    { name: 'head', prims: head, k: 0.035 },
    { name: 'armL', prims: arm('L'), k: 0.05 },
    { name: 'armR', prims: arm('R'), k: 0.05 },
    { name: 'legL', prims: leg('L'), k: 0.05 },
    { name: 'legR', prims: leg('R'), k: 0.05 },
  ];
}

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
// which bones each body part may be skinned to, and how strongly (neighbouring parts only pull a little)
const GROUP_BONES = {
  torso: [['pelvis', 1], ['spine', 1], ['chest', 1], ['neck', 0.8], ['upperArmL', 0.08], ['upperArmR', 0.08], ['thighL', 0.15], ['thighR', 0.15]],
  head: [['head', 1], ['neck', 0.5]],
  armL: [['upperArmL', 1], ['foreArmL', 1], ['handL', 0.6], ['chest', 0.25]],
  armR: [['upperArmR', 1], ['foreArmR', 1], ['handR', 0.6], ['chest', 0.25]],
  legL: [['thighL', 1], ['shinL', 1], ['footL', 1], ['pelvis', 0.4]],
  legR: [['thighR', 1], ['shinR', 1], ['footR', 1], ['pelvis', 0.4]],
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
  const out = { pos: new Float32Array(pos), nrm, grp, index: tris };
  smoothMesh(out, 3);
  return out;
}

/**
 * Relax the surface (Taubin smoothing: shrink-free) to remove the voxel stair-steps,
 * then recompute area-weighted normals. Gives clean bands under flat toon shading.
 */
function smoothMesh(mesh, iterations) {
  const n = mesh.pos.length / 3, idx = mesh.index;
  const nbr = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  const tmp = new Float32Array(mesh.pos.length);
  const pass = (lambda) => {
    for (let v = 0; v < n; v++) {
      let sx = 0, sy = 0, sz = 0, k = 0;
      for (const u of nbr[v]) { sx += mesh.pos[u * 3]; sy += mesh.pos[u * 3 + 1]; sz += mesh.pos[u * 3 + 2]; k++; }
      const i = v * 3;
      if (!k) { tmp[i] = mesh.pos[i]; tmp[i + 1] = mesh.pos[i + 1]; tmp[i + 2] = mesh.pos[i + 2]; continue; }
      tmp[i] = mesh.pos[i] + lambda * (sx / k - mesh.pos[i]);
      tmp[i + 1] = mesh.pos[i + 1] + lambda * (sy / k - mesh.pos[i + 1]);
      tmp[i + 2] = mesh.pos[i + 2] + lambda * (sz / k - mesh.pos[i + 2]);
    }
    mesh.pos.set(tmp);
  };
  for (let it = 0; it < iterations; it++) { pass(0.5); pass(-0.53); }
  // area-weighted vertex normals
  const nrm = new Float32Array(mesh.pos.length);
  const p = mesh.pos;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { nrm[q] += nx; nrm[q + 1] += ny; nrm[q + 2] += nz; }
  }
  // keep the field's outward direction (in case a quad was wound the other way)
  for (let i = 0; i < nrm.length; i += 3) {
    let x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    if (x * mesh.nrm[i] + y * mesh.nrm[i + 1] + z * mesh.nrm[i + 2] < 0) { x = -x; y = -y; z = -z; }
    mesh.nrm[i] = x; mesh.nrm[i + 1] = y; mesh.nrm[i + 2] = z;
  }
}

// ---------------------------------------------------------------- bone poses
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
export function buildHumanTemplate(restJ, { voxel = 0.015 } = {}) {
  const J = withHipMid(restJ);
  const groups = humanGroups(J);
  const t0 = performance.now();
  const mesh = surfaceNets(groups, [-0.45, 0.0, -0.32, 0.45, 1.9, 0.52], voxel);
  const bones = HUMAN_BONES;
  const boneIndex = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const rest = restOf(bones, J);

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
      return { i: boneIndex[name], w: f / Math.pow(d + 0.015, 4) };
    }).sort((a, b) => b.w - a.w).slice(0, 3);
    const sum = cands.reduce((s, c) => s + c.w, 0);
    cands.forEach((c, k) => { skinIndex[v * 4 + k] = c.i; skinWeight[v * 4 + k] = c.w / sum; });
    // regions for colouring: 0 skin, 1 shorts, 2 waistband, 3 hair, 4 eyebrows
    let r = 0;
    if ((gname === 'torso' || gname === 'legL' || gname === 'legR') && y < J.belly[1] - 0.03 && y > J.kneeL[1] + 0.15) r = 1;
    if (gname === 'torso' && y >= J.belly[1] - 0.07 && y < J.belly[1] - 0.03) r = 2;
    if (gname === 'head' && y > J.head[1] + 0.07 && z < 0.07) r = 3;
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

/** One skinned body in the scene (solid colours, toon shaded, outlined), posed from joint positions each frame. */
export class SkinnedBody {
  constructor(scene, template, colors, { outline = 0.009 } = {}) {
    this.t = template;
    const geo = template.geometry.clone();
    const n = template.region.length;
    const col = new Float32Array(n * 3);
    const palette = [colors.skin, colors.shorts, colors.trim, colors.hair].map((c) => new THREE.Color(c));
    for (let v = 0; v < n; v++) { const c = palette[template.region[v]]; col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.index = Object.fromEntries(template.bones.map((b, i) => [b.name, i]));
    this.qs = template.bones.map(() => new THREE.Quaternion());
    this.ps = template.bones.map(() => new THREE.Vector3());
    this.bones = template.bones.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.matrixWorldAutoUpdate = false; return b; });
    const inverses = template.rest.map((r) => r.m.clone().invert());
    for (let i = 0; i < this.bones.length; i++) this.bones[i].matrixWorld.copy(template.rest[i].m);
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
    this.mesh = new THREE.SkinnedMesh(geo, toonMaterial({ vertexColors: true }));
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

  /** J: joint name -> Vector3 (world). hipMid is derived when missing. */
  update(J) {
    if (!J.hipMid && J.hipL) J.hipMid = (this._hm || (this._hm = new THREE.Vector3())).addVectors(J.hipL, J.hipR).multiplyScalar(0.5);
    poseBones(this.t.bones, this.index, J, this.t.rest, this.qs, this.ps);
    for (let i = 0; i < this.bones.length; i++) this.bones[i].matrixWorld.compose(this.ps[i], this.qs[i], ONE);
  }
}
const ONE = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------- first-person arm
/** A single arm (shoulder, upper arm, forearm, wrist) as one skinned piece, for your own first-person view. */
export function buildArmTemplate({ voxel = 0.01 } = {}) {
  const S = [0, 0, 0], El = [0, -0.32, 0.04], H = [0, -0.32, 0.4];
  const prims = [
    E([0, 0.01, 0], [0.085, 0.082, 0.078]),
    C(S, El, 0.066, 0.05),
    E(lerp3(S, El, 0.48), [0.058, 0.062, 0.058]),
    C(El, H, 0.056, 0.04),
    E(lerp3(El, H, 0.3), [0.06, 0.055, 0.06]),
  ];
  const groups = [{ name: 'arm', prims, k: 0.05 }];
  const mesh = surfaceNets(groups, [-0.11, -0.44, -0.11, 0.11, 0.11, 0.47], voxel);
  const J = { shoulder: S, elbow: El, hand: H, base: [0, 0.3, 0], latA: [1, 0, 0], latB: [0, 0, 0] };
  const bones = [
    { name: 'base', root: true, from: 'shoulder', to: 'base', up: ['shoulder', 'base'], lat: ['latA', 'latB'] },
    { name: 'upper', parent: 'base', from: 'shoulder', to: 'elbow' },
    { name: 'fore', parent: 'upper', from: 'elbow', to: 'hand' },
  ];
  const rest = restOf(bones, J);
  const n = mesh.pos.length / 3;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    // blend across the elbow by distance along the arm
    const y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2];
    const along = y > -0.25 ? 0 : z > 0.12 ? 1 : 0.5 + Math.max(-0.5, Math.min(0.5, (z - 0.04) / 0.14));
    skinIndex[v * 4] = 1; skinIndex[v * 4 + 1] = 2;
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

// ---------------------------------------------------------------- MMA glove
/**
 * A 4 oz open-finger MMA glove on a fist, modelled the same way (distance field + surface nets).
 * Local frame: knuckles toward +z, back of the hand +y, the wearer's left +x.
 * thumbSide: -1 puts the thumb at -x (a left glove), +1 at +x (a right glove).
 * Vertex colours: skin for the fingers and thumb, the glove colour for the padding and cuff,
 * the accent colour for the wrist strap.
 */
export function buildGloveGeometry(thumbSide, colors, { voxel = 0.0045 } = {}) {
  const s = thumbSide;
  const pad = [
    E([0, 0.018, 0.04], [0.058, 0.04, 0.034]),                      // knuckle padding
    E([0, 0.032, -0.005], [0.054, 0.026, 0.06]),                     // back of the hand
    E([0, -0.006, -0.002], [0.052, 0.036, 0.052]),                   // around the palm
    C([0, 0.0, -0.045], [0, 0.0, -0.11], 0.047, 0.045),              // wrist cuff
  ];
  const strap = [E([0, 0.002, -0.078], [0.052, 0.05, 0.02])];        // velcro strap
  const hand = [E([0, -0.012, 0.02], [0.048, 0.038, 0.048])];
  for (let i = 0; i < 4; i++) {                                      // curled fingers poking out
    const x = (i - 1.5) * 0.024;
    hand.push(C([x, -0.004, 0.062], [x, -0.036, 0.04], 0.0125, 0.012));
  }
  hand.push(C([s * 0.044, -0.008, 0.0], [s * 0.022, -0.04, 0.04], 0.015, 0.013));   // thumb
  const groups = [
    { name: 'pad', prims: pad, k: 0.02 },
    { name: 'strap', prims: strap, k: 0.01 },
    { name: 'hand', prims: hand, k: 0.012 },
  ];
  const mesh = surfaceNets(groups, [-0.085, -0.075, -0.135, 0.085, 0.085, 0.1], voxel);
  const palette = [colors.glove, colors.strap, colors.skin].map((c) => new THREE.Color(c));
  const col = new Float32Array(mesh.pos.length);
  for (let v = 0; v < mesh.grp.length; v++) { const c = palette[mesh.grp[v]]; col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(mesh.index);
  return g;
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
