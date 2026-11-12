// A tiny all-quad modelling kernel, for building characters the way a 3D artist box-models
// them: start from a box, extrude faces out into limbs, place each new ring of vertices,
// then smooth with Catmull–Clark subdivision. Every face stays a quad and every joint gets
// clean edge loops, so the meshes deform well.
//
// Each vertex carries D numbers: x, y, z first, then any attributes (bone weights, colour
// zones...). Subdivision averages the attributes with the same rules as the positions, so
// skin weights and colours come out smooth too. Each face has a group id (e.g. a colour),
// which the four faces it splits into inherit.

const key = (a, b, c, d) => [a, b, c, d].sort((x, y) => x - y).join(',');
const ekey = (a, b) => (a < b ? a * 1048576 + b : b * 1048576 + a);

export class QuadMesh {
  constructor(D) {
    this.D = D;
    this.v = [];        // Float64Array(D) per vertex
    this.f = [];        // [a, b, c, d] per face (counter-clockwise seen from outside)
    this.g = [];        // group per face
    this.index = new Map();
  }

  add(data) { const a = new Float64Array(this.D); a.set(data); this.v.push(a); return this.v.length - 1; }
  copy(i) { return this.add(this.v[i]); }

  quad(a, b, c, d, g = 0) {
    const i = this.f.length;
    this.f.push([a, b, c, d]); this.g.push(g);
    this.index.set(key(a, b, c, d), i);
    return i;
  }

  /** The face with these four corners (any order). */
  find(a, b, c, d) {
    const i = this.index.get(key(a, b, c, d));
    if (i === undefined) throw new Error(`no face ${a},${b},${c},${d}`);
    return i;
  }

  /** The faces of the cells of a vertex grid (grid[r][c]). */
  cells(grid, r0 = 0, r1 = grid.length - 1, c0 = 0, c1 = grid[0].length - 1) {
    const out = [];
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) out.push(this.find(grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]));
    return out;
  }

  /**
   * Extrude a connected set of faces: the faces move onto new copies of their vertices and
   * a wall of quads joins the old border to the new one. Returns old vertex -> new vertex.
   * (The new vertices start where the old ones were: place them afterwards.) g: the walls' group.
   */
  extrude(faces, g = null) {
    const inRegion = new Set();
    for (const fi of faces) { const f = this.f[fi]; for (let k = 0; k < 4; k++) inRegion.add(f[k] * 1048576 + f[(k + 1) % 4]); }
    const map = new Map();
    const border = [];
    for (const fi of faces) {
      const f = this.f[fi];
      for (let k = 0; k < 4; k++) {
        const a = f[k], b = f[(k + 1) % 4];
        if (!inRegion.has(b * 1048576 + a)) border.push([a, b, this.g[fi]]);
        if (!map.has(a)) map.set(a, this.copy(a));
      }
    }
    for (const fi of faces) {
      const f = this.f[fi];
      this.index.delete(key(...f));
      const n = f.map((i) => map.get(i));
      this.f[fi] = n;
      this.index.set(key(...n), fi);
    }
    for (const [a, b, fg] of border) this.quad(a, b, map.get(b), map.get(a), g ?? fg);
    return map;
  }

  /** Make every face's normal point away from `center` (for building the starting box). */
  orientAway(center) {
    for (let i = 0; i < this.f.length; i++) {
      const [a, b, c, d] = this.f[i].map((k) => this.v[k]);
      const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], wx = d[0] - b[0], wy = d[1] - b[1], wz = d[2] - b[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const mx = (a[0] + b[0] + c[0] + d[0]) / 4 - center[0], my = (a[1] + b[1] + c[1] + d[1]) / 4 - center[1], mz = (a[2] + b[2] + c[2] + d[2]) / 4 - center[2];
      if (nx * mx + ny * my + nz * mz < 0) {
        this.index.delete(key(...this.f[i]));
        this.f[i] = [this.f[i][0], this.f[i][3], this.f[i][2], this.f[i][1]];
        this.index.set(key(...this.f[i]), i);
      }
    }
  }

  /** One level of Catmull–Clark subdivision (the mesh must be closed). Returns a new mesh. */
  subdivide() {
    const D = this.D, V = this.v, F = this.f;
    const out = new QuadMesh(D);
    const used = new Int32Array(V.length).fill(-1);
    const vf = V.map(() => []), ve = V.map(() => []);
    const edges = new Map();
    F.forEach((f, fi) => {
      for (let k = 0; k < 4; k++) {
        const a = f[k], b = f[(k + 1) % 4], ek = ekey(a, b);
        let e = edges.get(ek);
        if (!e) { e = { a, b, faces: [] }; edges.set(ek, e); ve[a].push(e); ve[b].push(e); }
        e.faces.push(fi);
        vf[a].push(fi);
      }
    });
    // face points
    const fp = F.map((f) => {
      const p = new Float64Array(D);
      for (const i of f) for (let d = 0; d < D; d++) p[d] += V[i][d] * 0.25;
      return out.add(p);
    });
    // edge points
    for (const e of edges.values()) {
      const p = new Float64Array(D);
      const A = V[e.a], B = V[e.b];
      if (e.faces.length === 2) {
        const P0 = out.v[fp[e.faces[0]]], P1 = out.v[fp[e.faces[1]]];
        for (let d = 0; d < D; d++) p[d] = (A[d] + B[d] + P0[d] + P1[d]) * 0.25;
      } else for (let d = 0; d < D; d++) p[d] = (A[d] + B[d]) * 0.5;   // (a border: shouldn't happen)
      e.pt = out.add(p);
    }
    // moved original vertices
    for (let i = 0; i < V.length; i++) {
      const n = vf[i].length;
      if (!n) continue;
      const p = new Float64Array(D), Fa = new Float64Array(D), Ra = new Float64Array(D);
      for (const fi of vf[i]) { const q = out.v[fp[fi]]; for (let d = 0; d < D; d++) Fa[d] += q[d] / n; }
      for (const e of ve[i]) { const A = V[e.a], B = V[e.b]; for (let d = 0; d < D; d++) Ra[d] += (A[d] + B[d]) * 0.5 / ve[i].length; }
      for (let d = 0; d < D; d++) p[d] = (Fa[d] + 2 * Ra[d] + (n - 3) * V[i][d]) / n;
      used[i] = out.add(p);
    }
    F.forEach((f, fi) => {
      const E = (a, b) => edges.get(ekey(a, b)).pt;
      const [a, b, c, d] = f, m = fp[fi], g = this.g[fi];
      out.quad(used[a], E(a, b), m, E(d, a), g);
      out.quad(used[b], E(b, c), m, E(a, b), g);
      out.quad(used[c], E(c, d), m, E(b, c), g);
      out.quad(used[d], E(d, a), m, E(c, d), g);
    });
    return out;
  }

  /** Smooth vertex normals (area weighted), as a Float32Array (x, y, z per vertex). */
  normals() {
    const N = new Float32Array(this.v.length * 3);
    for (const f of this.f) {
      const [a, b, c, d] = f.map((k) => this.v[k]);
      const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], wx = d[0] - b[0], wy = d[1] - b[1], wz = d[2] - b[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      for (const k of f) { N[k * 3] += nx; N[k * 3 + 1] += ny; N[k * 3 + 2] += nz; }
    }
    for (let i = 0; i < this.v.length; i++) {
      const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
      N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
    }
    return N;
  }

  /** Triangle indices (two per quad). */
  triangles() {
    const idx = new Uint32Array(this.f.length * 6);
    this.f.forEach(([a, b, c, d], i) => { idx.set([a, b, c, a, c, d], i * 6); });
    return idx;
  }
}
