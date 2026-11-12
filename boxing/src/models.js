// The characters, box-modelled in code (see quadmesh.js): a low-poly quad cage built by
// extruding a pelvis box into a torso, legs, arms, neck and head, ring by ring along the
// skeleton, then smoothed with Catmull–Clark subdivision. All quads, with an edge loop at
// every joint, so the body bends cleanly; bone weights are set on the cage and come out
// smooth after subdivision.

import * as THREE from 'three';
import { QuadMesh } from './quadmesh.js';

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const _q = new THREE.Quaternion();

// ---------------------------------------------------------------- shared helpers
/**
 * A box of nx × ny × nz cells on its surface (vertices shared along the edges), with its
 * faces pointing outwards. Returns the mesh-side grids of vertex ids:
 *   bottom/top: [z][x], left/right (+x/-x): [y][z], front/back (+z/-z): [y][x].
 */
function makeBox(M, nx, ny, nz, g = 0) {
  const id = new Map();
  const at = (i, j, k) => {
    const key = `${i},${j},${k}`;
    if (!id.has(key)) { const a = new Float64Array(M.D); a[0] = i / nx - 0.5; a[1] = j / ny - 0.5; a[2] = k / nz - 0.5; id.set(key, M.add(a)); }
    return id.get(key);
  };
  const grid = (rows, cols, f) => Array.from({ length: rows + 1 }, (_, r) => Array.from({ length: cols + 1 }, (_, c) => f(r, c)));
  const G = {
    bottom: grid(nz, nx, (k, i) => at(i, 0, k)), top: grid(nz, nx, (k, i) => at(i, ny, k)),
    left: grid(ny, nz, (j, k) => at(nx, j, k)), right: grid(ny, nz, (j, k) => at(0, j, k)),
    front: grid(ny, nx, (j, i) => at(i, j, nz)), back: grid(ny, nx, (j, i) => at(i, j, 0)),
  };
  for (const gr of Object.values(G)) {
    for (let r = 0; r < gr.length - 1; r++) for (let c = 0; c < gr[0].length - 1; c++) M.quad(gr[r][c], gr[r][c + 1], gr[r + 1][c + 1], gr[r + 1][c], g);
  }
  M.orientAway([0, 0, 0]);
  return G;
}

/** A coordinate frame along a limb: d (along it), u and v (across it). Moved without twisting. */
class Frame {
  constructor(d, u, v) { this.d = d.clone().normalize(); this.u = u.clone().normalize(); this.v = v.clone().normalize(); }
  /** Turn to point along d2, by the smallest rotation (parallel transport: no twist). */
  turn(d2) {
    const n = d2.clone().normalize();
    _q.setFromUnitVectors(this.d, n);
    this.u.applyQuaternion(_q); this.v.applyQuaternion(_q); this.d.copy(n);
    return this;
  }
}

const mapGrid = (grid, map) => grid.map((row) => row.map((i) => map.get(i) ?? i));
/** Every vertex of a box once (its faces share them along the edges). */
const boxVerts = (box) => { const s = new Set(); for (const gr of Object.values(box)) for (const row of gr) for (const i of row) s.add(i); return s; };

// ---------------------------------------------------------------- the body
/**
 * The cartoon fighter in the rest pose given by joint positions J ({name: [x,y,z]}).
 * boneNames: the skeleton's bones in order (the weights are per bone).
 * Returns { pos, nrm, weights (top 4: idx, w), zone, index }.
 */
export function buildCartoonBody(J, boneNames, { levels = 2 } = {}) {
  const FULL = 1.14;   // ring sizes are what the smooth surface should show; the cage sits a little outside it
  const NB = boneNames.length, D = 3 + NB + 1, ZONE = 3 + NB;
  const bi = Object.fromEntries(boneNames.map((n, i) => [n, i]));
  const M = new QuadMesh(D);
  const P = Object.fromEntries(Object.entries(J).map(([k, v]) => [k, V3(v)]));
  const set = (i, p, w, zone) => {
    const a = M.v[i];
    a.fill(0);
    a[0] = p.x; a[1] = p.y; a[2] = p.z;
    let s = 0; for (const k in w) s += w[k];
    for (const k in w) a[3 + bi[k]] = w[k] / s;
    a[ZONE] = zone;
  };

  // ----- torso: a box 4 cells wide, 2 deep, extruded up through six levels
  // level: y, half width W, half depth Dp, centre z, bone weights
  const LV = [
    { y: 0.79, W: 0.155, Dp: 0.105, zc: -0.012, w: { pelvis: 1 } },                     // crotch
    { y: 0.92, W: 0.172, Dp: 0.128, zc: -0.018, w: { pelvis: 1 } },                     // hips and glutes
    { y: 1.06, W: 0.142, Dp: 0.112, zc: 0.000, w: { pelvis: 0.35, spine: 0.65 } },      // waist
    { y: 1.22, W: 0.2, Dp: 0.128, zc: 0.002, w: { spine: 0.4, chest: 0.6 } },           // lower ribs
    { y: 1.36, W: 0.238, Dp: 0.14, zc: 0.008, w: { chest: 1 } },                        // chest
    { y: 1.495, W: 0.19, Dp: 0.104, zc: -0.012, w: { chest: 0.85, neck: 0.15 } },       // shoulder tops
  ];
  const XS = [-1, -0.6, 0, 0.6, 1], ZS = [-1, 0, 1];
  const torsoAt = (L, r, c) => {
    let x = XS[c] * L.W * 1.07, z = ZS[r] * L.Dp * 1.07, y = L.y;
    const sideCol = c === 0 || c === 4;
    if (sideCol && r !== 1) { x *= 0.9; z *= 0.7; }                   // rounded corners
    if (!sideCol && r !== 1) z *= c === 2 ? 1.0 : 0.96;
    if (L === LV[4] && r === 2 && (c === 1 || c === 3)) z += 0.012; // pecs
    if (L === LV[1] && r === 0 && (c === 1 || c === 3)) z -= 0.02;  // glutes
    if (L === LV[0] && r === 1 && c === 2) y -= 0.025;              // crotch
    return new THREE.Vector3(x, y, z + L.zc);
  };
  const box = makeBox(M, 4, 1, 2);
  const G = [box.bottom, box.top];
  const placeLevel = (grid, L) => { for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) set(grid[r][c], torsoAt(L, r, c), L.w, 1); };
  placeLevel(G[0], LV[0]); placeLevel(G[1], LV[1]);
  for (let l = 2; l < LV.length; l++) {
    const map = M.extrude(M.cells(G[l - 1]));
    G[l] = mapGrid(G[l - 1], map);
    placeLevel(G[l], LV[l]);
  }

  /** Place a 3×3 cap grid as a ring around C (rows along v, columns along u), rounded. */
  const ring = (grid, C, fr, ru, rv, w, zone, cap = 0) => {
    ru *= FULL; rv *= FULL;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const a = i - 1, b = j - 1;
      const k = a && b ? 0.74 : 1;
      const p = C.clone().addScaledVector(fr.u, b * ru * k).addScaledVector(fr.v, a * rv * k);
      if (!a && !b) p.addScaledVector(fr.d, cap);
      set(grid[i][j], p, w, zone);
    }
  };
  const extrudeRing = (grid, ...args) => { const g2 = mapGrid(grid, M.extrude(M.cells(grid))); ring(g2, ...args); return g2; };

  // ----- legs: from each half of the bottom
  for (const [s, sd] of [['L', 1], ['R', -1]]) {
    const c0 = sd > 0 ? 2 : 0;
    let g = [0, 1, 2].map((r) => [0, 1, 2].map((k) => G[0][r][c0 + k]));
    const hip = P['hip' + s], knee = P['knee' + s], ankle = P['ankle' + s];
    const fr = new Frame(new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    const zl = 1;
    g = extrudeRing(g, new THREE.Vector3(sd * 0.088, 0.765, -0.012), fr, 0.102, 0.112, { pelvis: 0.45, ['thigh' + s]: 0.55 }, zl);
    fr.turn(knee.clone().sub(hip));
    g = extrudeRing(g, hip.clone().lerp(knee, 0.33).add(new THREE.Vector3(sd * 0.012, 0, 0)), fr, 0.124, 0.128, { ['thigh' + s]: 1 }, zl);   // shorts flare
    g = extrudeRing(g, hip.clone().lerp(knee, 0.72), fr, 0.092, 0.096, { ['thigh' + s]: 1 }, zl);
    g = extrudeRing(g, knee.clone(), fr, 0.066, 0.068, { ['thigh' + s]: 0.5, ['shin' + s]: 0.5 }, zl);
    fr.turn(ankle.clone().sub(knee));
    g = extrudeRing(g, knee.clone().lerp(ankle, 0.3).addScaledVector(fr.v, -0.014), fr, 0.07, 0.084, { ['shin' + s]: 1 }, zl);          // calf
    g = extrudeRing(g, knee.clone().lerp(ankle, 0.78), fr, 0.046, 0.048, { ['shin' + s]: 1 }, zl);
    const ankleRing = extrudeRing(g, ankle.clone(), fr, 0.044, 0.05, { ['shin' + s]: 0.4, ['foot' + s]: 0.6 }, zl);
    // the foot: down to a flat sole, then forward to the toes
    const sole = mapGrid(ankleRing, M.extrude(M.cells(ankleRing)));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const a = i - 1, b = j - 1;
      set(sole[i][j], new THREE.Vector3(ankle.x + b * 0.056 * (a ? 0.85 : 1), -0.014, ankle.z - 0.03 + a * 0.065), { ['foot' + s]: 1 }, zl);
    }
    // front of the foot: the wall between the ankle ring's and the sole's front rows
    const front = [ankleRing[2], sole[2]];
    let toe = mapGrid(front, M.extrude(M.cells(front)));
    const toeAt = (row, j, z, top, bot, half) => new THREE.Vector3(ankle.x + (j - 1) * half, row === 0 ? top : bot, ankle.z + z);
    // (toes end about 21 cm in front of the ankle, where the foot's collider ends)
    for (let j = 0; j < 3; j++) { set(toe[0][j], toeAt(0, j, 0.085, 0.09, 0, 0.058), { ['foot' + s]: 1 }, zl); set(toe[1][j], toeAt(1, j, 0.095, 0, -0.014, 0.062), { ['foot' + s]: 1 }, zl); }
    toe = mapGrid(toe, M.extrude(M.cells(toe)));
    for (let j = 0; j < 3; j++) { set(toe[0][j], toeAt(0, j, 0.16, 0.07, 0, 0.058), { ['foot' + s]: 1 }, zl); set(toe[1][j], toeAt(1, j, 0.175, 0, -0.014, 0.062), { ['foot' + s]: 1 }, zl); }
    toe = mapGrid(toe, M.extrude(M.cells(toe)));
    for (let j = 0; j < 3; j++) { set(toe[0][j], toeAt(0, j, 0.205, 0.048, 0, 0.048), { ['foot' + s]: 1 }, zl); set(toe[1][j], toeAt(1, j, 0.215, 0, -0.012, 0.052), { ['foot' + s]: 1 }, zl); }
  }

  // ----- arms: from the sides of the upper torso
  for (const [s, sd] of [['L', 1], ['R', -1]]) {
    const col = sd > 0 ? 4 : 0;
    let g = [3, 4, 5].map((l) => [0, 1, 2].map((r) => G[l][r][col]));   // rows: levels (y), columns: z
    const sh = P['shoulder' + s], el = P['elbow' + s], hd = P['hand' + s];
    const fr = new Frame(new THREE.Vector3(sd, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    const za = 0.25, zf = 0;   // upper arm (a short sleeve covers it) / forearm colour zones
    g = extrudeRing(g, sh.clone().add(new THREE.Vector3(sd * 0.045, -0.005, 0)), fr, 0.098, 0.1, { chest: 0.3, ['upperArm' + s]: 0.7 }, za);   // big deltoid
    fr.turn(el.clone().sub(sh));
    g = extrudeRing(g, sh.clone().lerp(el, 0.3), fr, 0.082, 0.082, { ['upperArm' + s]: 1 }, za);
    g = extrudeRing(g, sh.clone().lerp(el, 0.6), fr, 0.074, 0.08, { ['upperArm' + s]: 1 }, za);   // biceps
    g = extrudeRing(g, el.clone(), fr, 0.058, 0.06, { ['upperArm' + s]: 0.5, ['foreArm' + s]: 0.5 }, zf);
    const dF = hd.clone().sub(el);
    fr.turn(dF);
    dF.normalize();
    g = extrudeRing(g, el.clone().lerp(hd, 0.32), fr, 0.072, 0.066, { ['foreArm' + s]: 1 }, zf);    // big cartoon forearm
    g = extrudeRing(g, hd.clone().addScaledVector(dF, -0.08), fr, 0.042, 0.04, { ['foreArm' + s]: 0.6, ['hand' + s]: 0.4 }, zf);   // wrist
    g = extrudeRing(g, hd.clone().addScaledVector(dF, -0.03), fr, 0.05, 0.046, { ['hand' + s]: 1 }, zf);
    g = extrudeRing(g, hd.clone().addScaledVector(dF, 0.02), fr, 0.048, 0.044, { ['hand' + s]: 1 }, zf, 0.02);   // a fist
  }

  // ----- neck and head: from the middle of the shoulder tops
  {
    let g = [0, 1, 2].map((r) => [0, 1, 2].map((k) => G[5][r][1 + k]));   // rows: z, columns: x
    const fr = new Frame(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    const hz = J.head[2], hy = J.head[1];
    g = extrudeRing(g, new THREE.Vector3(0, 1.535, -0.008), fr, 0.078, 0.074, { neck: 0.7, chest: 0.3 }, 2);
    g = extrudeRing(g, new THREE.Vector3(0, 1.575, 0.0), fr, 0.072, 0.07, { neck: 0.5, head: 0.5 }, 2);
    const head = [];
    head.push(g = extrudeRing(g, new THREE.Vector3(0, hy - 0.06, hz + 0.02), fr, 0.112, 0.112, { head: 1 }, 2));   // jaw
    head.push(g = extrudeRing(g, new THREE.Vector3(0, hy - 0.005, hz - 0.002), fr, 0.142, 0.152, { head: 1 }, 2));  // cheeks
    head.push(g = extrudeRing(g, new THREE.Vector3(0, hy + 0.06, hz - 0.03), fr, 0.145, 0.158, { head: 1 }, 2));    // eyes / brow
    head.push(g = extrudeRing(g, new THREE.Vector3(0, hy + 0.13, hz - 0.045), fr, 0.122, 0.135, { head: 1 }, 2));   // forehead
    g = extrudeRing(g, new THREE.Vector3(0, hy + 0.19, hz - 0.05), fr, 0.075, 0.085, { head: 1 }, 2, 0.022);        // crown
    // a big nose: the front wall between the cheek and eye rings
    {
      const front = [head[1][2], head[2][2]];
      const n = mapGrid(front, M.extrude(M.cells(front)));
      for (let j = 0; j < 3; j++) {
        set(n[0][j], new THREE.Vector3((j - 1) * 0.024, hy - 0.008, hz + 0.155), { head: 1 }, 2);
        set(n[1][j], new THREE.Vector3((j - 1) * 0.018, hy + 0.035, hz + 0.135), { head: 1 }, 2);
      }
    }
    // ears: one face out of each side, between the cheek and eye rings, behind the middle
    for (const sd of [1, -1]) {
      const c = sd > 0 ? 2 : 0;
      const e = [[head[1][0][c], head[1][1][c]], [head[2][0][c], head[2][1][c]]];
      const m = M.extrude(M.cells(e));
      const ctr = new THREE.Vector3();
      for (const row of e) for (const i of row) ctr.add(V3(M.v[i]));
      ctr.multiplyScalar(0.25);
      for (const row of e) for (const i of row) {
        const p = V3(M.v[i]).sub(ctr).multiplyScalar(0.7).add(ctr).add(new THREE.Vector3(sd * 0.03, 0, -0.006));
        set(m.get(i), p, { head: 1 }, 2);
      }
    }
  }

  // ----- smooth it
  let S = M;
  for (let k = 0; k < levels; k++) S = S.subdivide();
  const n = S.v.length;
  const pos = new Float32Array(n * 3), zone = new Float32Array(n), skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = S.v[i];
    pos[i * 3] = a[0]; pos[i * 3 + 1] = a[1]; pos[i * 3 + 2] = a[2];
    zone[i] = a[ZONE];
    const top = [];
    for (let b = 0; b < NB; b++) if (a[3 + b] > 1e-4) top.push([b, a[3 + b]]);
    top.sort((x, y) => y[1] - x[1]);
    const t4 = top.slice(0, 4), sum = t4.reduce((s2, x) => s2 + x[1], 0) || 1;
    t4.forEach(([b, w], k) => { skinIndex[i * 4 + k] = b; skinWeight[i * 4 + k] = w / sum; });
  }
  return { pos, nrm: S.normals(), index: S.triangles(), zone, skinIndex, skinWeight, quads: S.f.length, cageQuads: M.f.length };
}

// ---------------------------------------------------------------- first-person arm
/**
 * Your arm in first person (shoulder at the origin, elbow at E, wrist at H), skinned to
 * three bones: 0 base, 1 upper arm, 2 forearm.
 */
export function buildCartoonArm(E, H, { levels = 2 } = {}) {
  const D = 3 + 3, M = new QuadMesh(D);
  const set = (i, p, w) => { const a = M.v[i]; a.fill(0); a[0] = p.x; a[1] = p.y; a[2] = p.z; a[3] = w[0]; a[4] = w[1]; a[5] = w[2]; };
  const S0 = new THREE.Vector3(0, 0, 0), El = V3(E), Hd = V3(H);
  const box = makeBox(M, 2, 2, 2);
  // the shoulder ball: place the whole box round the shoulder
  for (const i of boxVerts(box)) {
    const a = M.v[i];
    const f = new THREE.Vector3(a[0] * 2, a[1] * 2, a[2] * 2);
    const k = (Math.abs(f.x) > 0.5 ? 1 : 0) + (Math.abs(f.y) > 0.5 ? 1 : 0) + (Math.abs(f.z) > 0.5 ? 1 : 0);
    f.multiplyScalar(k === 3 ? 0.62 : k === 2 ? 0.74 : 1);
    set(i, new THREE.Vector3(f.x * 0.085, f.y * 0.08 + 0.01, f.z * 0.08), [0, 1, 0]);
  }
  const ring = (grid, C, fr, ru, rv, w, cap = 0) => {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const a = i - 1, b = j - 1, k = a && b ? 0.74 : 1;
      const p = C.clone().addScaledVector(fr.u, b * ru * k).addScaledVector(fr.v, a * rv * k);
      if (!a && !b) p.addScaledVector(fr.d, cap);
      set(grid[i][j], p, w);
    }
  };
  const ext = (grid, ...args) => { const g2 = mapGrid(grid, M.extrude(M.cells(grid))); ring(g2, ...args); return g2; };
  const fr = new Frame(El.clone().sub(S0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
  let g = box.bottom;   // rows z, columns x
  g = ext(g, S0.clone().lerp(El, 0.3), fr, 0.072, 0.072, [0, 1, 0]);
  g = ext(g, S0.clone().lerp(El, 0.62), fr, 0.066, 0.068, [0, 1, 0]);
  g = ext(g, El.clone(), fr, 0.054, 0.055, [0, 0.5, 0.5]);
  fr.turn(Hd.clone().sub(El));
  g = ext(g, El.clone().lerp(Hd, 0.3), fr, 0.062, 0.058, [0, 0, 1]);
  g = ext(g, El.clone().lerp(Hd, 0.8), fr, 0.045, 0.042, [0, 0, 1]);
  g = ext(g, Hd.clone(), fr, 0.04, 0.038, [0, 0, 1], 0.01);
  let S = M;
  for (let k = 0; k < levels; k++) S = S.subdivide();
  const n = S.v.length;
  const pos = new Float32Array(n * 3), skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = S.v[i];
    pos[i * 3] = a[0]; pos[i * 3 + 1] = a[1]; pos[i * 3 + 2] = a[2];
    const s = a[4] + a[5] || 1;
    skinIndex[i * 4] = 1; skinIndex[i * 4 + 1] = 2;
    skinWeight[i * 4] = a[4] / s; skinWeight[i * 4 + 1] = a[5] / s;
  }
  return { pos, nrm: S.normals(), index: S.triangles(), skinIndex, skinWeight };
}

// ---------------------------------------------------------------- toy-like MMA glove
/**
 * A big, puffy, toy-like open-finger MMA glove. Local frame: knuckles toward +z, back of the
 * hand +y, the wearer's left +x. thumbSide: -1 thumb at -x (a left glove), +1 at +x.
 * colors: { glove, strap, band, skin }. Returns a non-indexed BufferGeometry with flat
 * colour per face (crisp colour edges) and smooth normals.
 */
export function buildCartoonGlove(thumbSide, colors, { levels = 2 } = {}) {
  const s = thumbSide;
  const M = new QuadMesh(3);
  const GLOVE = 0, STRAP = 1, SKIN = 2, BAND = 3;
  const box = makeBox(M, 4, 2, 2, GLOVE);
  // the knuckle pad: a fat pillow, fuller at the knuckles and the back of the hand
  for (const i of boxVerts(box)) {
    const a = M.v[i];
    const fx = a[0] * 2, fy = a[1] * 2, fz = a[2] * 2;
    const k = (Math.abs(fx) > 0.99 ? 1 : 0) + (Math.abs(fy) > 0.99 ? 1 : 0) + (Math.abs(fz) > 0.99 ? 1 : 0);
    const r = k === 3 ? 0.84 : k === 2 ? 0.93 : 1;
    const x = fx * 0.094 * r;
    const y = (fy > 0 ? fy * 0.088 : fy * 0.06) * r + 0.01;
    const z = (fz > 0 ? fz * (0.112 + 0.018 * Math.max(0, fy)) : fz * 0.07) * r + 0.014;
    a[0] = x; a[1] = y; a[2] = z;
  }
  const mv = (i, p) => { M.v[i][0] = p.x; M.v[i][1] = p.y; M.v[i][2] = p.z; };
  const P = (i) => new THREE.Vector3(M.v[i][0], M.v[i][1], M.v[i][2]);
  // stubby fingers poking out under the pad: the bottom row of the front face, one per cell
  for (let c = 0; c < 4; c++) {
    let cell = [[box.front[0][c], box.front[0][c + 1]], [box.front[1][c], box.front[1][c + 1]]];
    for (const [fwd, down, shrink] of [[0.024, 0.012, 0.9], [0.016, 0.026, 0.86]]) {
      const m = M.extrude(M.cells(cell), SKIN);
      for (const fi of M.cells(mapGrid(cell, m))) M.g[fi] = SKIN;
      const ctr = new THREE.Vector3();
      for (const row of cell) for (const i of row) ctr.add(P(i));
      ctr.multiplyScalar(0.25);
      for (const row of cell) for (const i of row) mv(m.get(i), P(i).sub(ctr).multiplyScalar(shrink).add(ctr).add(new THREE.Vector3(0, -down, fwd)));
      cell = mapGrid(cell, m);
    }
  }
  // the thumb: out of the lower front of its side, then curled in across the front
  {
    const side = s > 0 ? box.left : box.right;   // rows y, columns z
    let cell = [[side[0][1], side[0][2]], [side[1][1], side[1][2]]];
    const steps = [[s * 0.03, 0.0, 0.01, 0.85, GLOVE], [s * 0.012, -0.012, 0.035, 0.85, SKIN], [-s * 0.02, -0.01, 0.025, 0.8, SKIN]];
    for (const [dx, dy, dz, shrink, grp] of steps) {
      const m = M.extrude(M.cells(cell), grp);
      for (const fi of M.cells(mapGrid(cell, m))) M.g[fi] = grp;
      const ctr = new THREE.Vector3();
      for (const row of cell) for (const i of row) ctr.add(P(i));
      ctr.multiplyScalar(0.25);
      for (const row of cell) for (const i of row) mv(m.get(i), P(i).sub(ctr).multiplyScalar(shrink).add(ctr).add(new THREE.Vector3(dx, dy, dz)));
      cell = mapGrid(cell, m);
    }
  }
  // the cuff: out of the back, a white band, then the thick wrist strap
  {
    let g = box.back;   // rows y, columns x
    const cuff = [[-0.068, GLOVE, 0.074, 0.064], [-0.092, BAND, 0.077, 0.067], [-0.106, STRAP, 0.079, 0.069], [-0.148, STRAP, 0.079, 0.069], [-0.158, STRAP, 0.056, 0.048]];
    for (const [z, grp, hx, hy] of cuff) {
      const m = M.extrude(M.cells(g), grp);
      g = mapGrid(g, m);
      for (const fi of M.cells(g)) M.g[fi] = grp;
      for (let j = 0; j < g.length; j++) for (let i = 0; i < g[0].length; i++) {
        const fx = (i / (g[0].length - 1)) * 2 - 1, fy = (j / (g.length - 1)) * 2 - 1;
        const k = Math.abs(fx) > 0.99 && Math.abs(fy) > 0.99 ? 0.78 : Math.abs(fx) > 0.4 && Math.abs(fy) > 0.99 ? 0.93 : 1;
        mv(g[j][i], new THREE.Vector3(fx * hx * k, fy * hy * k + 0.004, z));
      }
    }
  }
  let S = M;
  for (let k = 0; k < levels; k++) S = S.subdivide();
  // non-indexed, colour per face (so colour edges stay crisp), normals smoothed over the shape
  const N = S.normals();
  const palette = [colors.glove, colors.strap, colors.skin, colors.band ?? 0xf4f1ea].map((c) => new THREE.Color(c));
  const nf = S.f.length;
  const pos = new Float32Array(nf * 18), nrm = new Float32Array(nf * 18), col = new Float32Array(nf * 18);
  S.f.forEach((f, fi) => {
    const c = palette[S.g[fi]];
    [f[0], f[1], f[2], f[0], f[2], f[3]].forEach((vi, k) => {
      const o = fi * 18 + k * 3;
      pos[o] = S.v[vi][0]; pos[o + 1] = S.v[vi][1]; pos[o + 2] = S.v[vi][2];
      nrm[o] = N[vi * 3]; nrm[o + 1] = N[vi * 3 + 1]; nrm[o + 2] = N[vi * 3 + 2];
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
    });
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
