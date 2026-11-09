// Press V in game to see the physics: particles (points) and constraints (lines).

import * as THREE from 'three';

export class PhysicsDebugView {
  constructor(scene, world) {
    this.world = world;
    this.visible = false;
    const maxC = 2048, maxP = 1024;
    this.linePos = new Float32Array(maxC * 6);
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ color: 0x40ff90, depthTest: false, transparent: true, opacity: 0.85 }));
    this.pointPos = new Float32Array(maxP * 3);
    this.pointGeo = new THREE.BufferGeometry();
    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3));
    this.points = new THREE.Points(this.pointGeo, new THREE.PointsMaterial({ color: 0xffe040, size: 6, sizeAttenuation: false, depthTest: false }));
    for (const o of [this.lines, this.points]) { o.renderOrder = 999; o.frustumCulled = false; o.visible = false; scene.add(o); }
  }

  toggle() {
    this.visible = !this.visible;
    this.lines.visible = this.points.visible = this.visible;
    return this.visible;
  }

  update() {
    if (!this.visible) return;
    let i = 0;
    for (const c of this.world.constraints) {
      if (i >= this.linePos.length) break;
      const a = c.a.pos, b = c.b.pos;
      this.linePos[i++] = a.x; this.linePos[i++] = a.y; this.linePos[i++] = a.z;
      this.linePos[i++] = b.x; this.linePos[i++] = b.y; this.linePos[i++] = b.z;
    }
    this.lineGeo.setDrawRange(0, i / 3);
    this.lineGeo.attributes.position.needsUpdate = true;
    let j = 0;
    for (const p of this.world.particles) {
      if (j >= this.pointPos.length) break;
      this.pointPos[j++] = p.pos.x; this.pointPos[j++] = p.pos.y; this.pointPos[j++] = p.pos.z;
    }
    this.pointGeo.setDrawRange(0, j / 3);
    this.pointGeo.attributes.position.needsUpdate = true;
  }
}
