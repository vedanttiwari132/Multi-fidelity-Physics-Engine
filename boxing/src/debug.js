// Press V in game to see the physics: every Rapier collider and joint (green), and the
// fighters' hitboxes coloured by what they count as (guard yellow, head red, body orange,
// legs cyan).

import * as THREE from 'three';

const RING = 14;
const HIT_COLORS = { guard: [1, 0.85, 0.2], head: [1, 0.2, 0.2], body: [1, 0.55, 0.1], low: [0.2, 0.85, 1] };
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion(), _c = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _d = new THREE.Vector3(), _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3();

export class PhysicsDebugView {
  constructor(scene, phys) {
    this.phys = phys;
    this.visible = false;
    this.lineGeo = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ color: 0x40ff90, depthTest: false, transparent: true, opacity: 0.35 }));
    const maxH = 8000;
    this.hitPos = new Float32Array(maxH * 6);
    this.hitCol = new Float32Array(maxH * 6);
    this.hitGeo = new THREE.BufferGeometry();
    this.hitGeo.setAttribute('position', new THREE.BufferAttribute(this.hitPos, 3));
    this.hitGeo.setAttribute('color', new THREE.BufferAttribute(this.hitCol, 3));
    this.hits = new THREE.LineSegments(this.hitGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
    /** Fighters whose hitboxes are drawn (set by the game). */
    this.fighters = [];
    for (const o of [this.lines, this.hits]) { o.renderOrder = 999; o.frustumCulled = false; o.visible = false; scene.add(o); }
  }

  toggle() {
    this.visible = !this.visible;
    this.lines.visible = this.hits.visible = this.visible;
    return this.visible;
  }

  update() {
    if (!this.visible) return;
    const r = this.phys.world.debugRender();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.vertices), 3));
    this.lineGeo.computeBoundingSphere();
    this.updateHitboxes();
  }

  updateHitboxes() {
    const P = this.hitPos, C = this.hitCol;
    let i = 0;
    let col = HIT_COLORS.body;
    const seg = (a, b) => {
      if (i + 6 > P.length) return;
      P[i] = a.x; P[i + 1] = a.y; P[i + 2] = a.z; P[i + 3] = b.x; P[i + 4] = b.y; P[i + 5] = b.z;
      C[i] = C[i + 3] = col[0]; C[i + 1] = C[i + 4] = col[1]; C[i + 2] = C[i + 5] = col[2];
      i += 6;
    };
    const ring = (c, u, v, r) => {
      for (let k = 0; k < RING; k++) {
        const a0 = (k / RING) * Math.PI * 2, a1 = ((k + 1) / RING) * Math.PI * 2;
        _p0.copy(c).addScaledVector(u, Math.cos(a0) * r).addScaledVector(v, Math.sin(a0) * r);
        _p1.copy(c).addScaledVector(u, Math.cos(a1) * r).addScaledVector(v, Math.sin(a1) * r);
        seg(_p0, _p1);
      }
    };
    for (const f of this.fighters) {
      for (const info of f.hurt) {
        const c = info.collider;
        col = HIT_COLORS[info.region] || HIT_COLORS.body;
        const t = c.translation(), q = c.rotation();
        _c.set(t.x, t.y, t.z); _q.set(q.x, q.y, q.z, q.w);
        const r = c.radius();
        if (info.shape === 'ball') { ring(_c, X, Y, r); ring(_c, Y, Z, r); ring(_c, Z, X, r); continue; }
        const hh = c.halfHeight();
        _d.set(0, 1, 0).applyQuaternion(_q);
        _a.copy(_c).addScaledVector(_d, -hh); _b.copy(_c).addScaledVector(_d, hh);
        _u.set(1, 0, 0).applyQuaternion(_q); _v.set(0, 0, 1).applyQuaternion(_q);
        ring(_a, _u, _v, r); ring(_b, _u, _v, r);
        for (const [s, k] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          _p0.copy(_a).addScaledVector(_u, s * r).addScaledVector(_v, k * r);
          _p1.copy(_b).addScaledVector(_u, s * r).addScaledVector(_v, k * r);
          seg(_p0, _p1);
        }
        ring(_a, _d, _u, r); ring(_b, _d, _u, r);
      }
    }
    this.hitGeo.setDrawRange(0, i / 3);
    this.hitGeo.attributes.position.needsUpdate = true;
    this.hitGeo.attributes.color.needsUpdate = true;
  }
}
