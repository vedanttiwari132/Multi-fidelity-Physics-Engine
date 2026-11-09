// The ring, the ropes (Verlet chains you can knock the opponent into), lights and crowd.

import * as THREE from 'three';
import { Particle, DistanceConstraint, collideParticleSegment } from './physics.js';

const ROPE_LINE = 3.18;
const POST = 3.3;
const ROPE_HEIGHTS = [0.45, 0.82, 1.18];
const ROPE_NODES = 15;
const ROPE_R = 0.028;

export class Arena {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.time = 0;
    this.excitement = 0;
    this.buildLights();
    this.buildRing();
    this.buildRopes();
    this.buildCrowd();
  }

  buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x8090b0, 0x1a1410, 0.9));
    const key = new THREE.SpotLight(0xfff4e6, 9, 0, 0.62, 0.55, 0);
    key.position.set(0, 9, 0.5);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 4; key.shadow.camera.far = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    s.add(key, key.target);
    for (const [x, z, c] of [[6, 6, 0xffb070], [-6, -6, 0x80a8ff], [-6, 6, 0xffffff], [6, -6, 0xffffff]]) {
      const l = new THREE.SpotLight(c, 1.6, 0, 0.5, 0.6, 0);
      l.position.set(x, 7, z);
      l.target.position.set(0, 1, 0);
      s.add(l, l.target);
    }
    // dim light on the crowd
    const crowdLight = new THREE.PointLight(0x6070a0, 1.2, 0, 0);
    crowdLight.position.set(0, 10, 0);
    s.add(crowdLight);
  }

  buildRing() {
    const s = this.scene;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.1; floor.receiveShadow = true;
    s.add(floor);

    const apron = new THREE.Mesh(new THREE.BoxGeometry(7.8, 1.1, 7.8),
      new THREE.MeshStandardMaterial({ color: 0x14204a, roughness: 0.6, emissive: 0x050a20 }));
    apron.position.y = -0.551;
    apron.receiveShadow = true;
    s.add(apron);

    const canvas = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 7.6),
      new THREE.MeshStandardMaterial({ map: makeCanvasTexture(), roughness: 0.85 }));
    canvas.rotation.x = -Math.PI / 2; canvas.position.y = 0.001; canvas.receiveShadow = true;
    s.add(canvas);

    const postMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.8, roughness: 0.3 });
    const padMats = [0xc01818, 0xeeeeee, 0x1840c0, 0xeeeeee].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz], i) => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 12), postMat);
      post.position.set(sx * POST, 0.7, sz * POST); post.castShadow = true;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.95, 0.22), padMats[i]);
      pad.position.set(sx * (POST - 0.06), 0.82, sz * (POST - 0.06)); pad.rotation.y = Math.PI / 4; pad.castShadow = true;
      s.add(post, pad);
    });

    // lighting truss above the ring
    const truss = new THREE.Group();
    const tMat = new THREE.MeshStandardMaterial({ color: 0x222228, metalness: 0.6, roughness: 0.5 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 2.5 });
    for (const sz of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 0.2), tMat); bar.position.set(0, 0, sz * 4); truss.add(bar);
      const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 8), tMat); bar2.position.set(sz * 4, 0, 0); truss.add(bar2);
      for (let i = -3; i <= 3; i += 2) {
        const l1 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.35), lamp); l1.position.set(i, -0.15, sz * 4); truss.add(l1);
        const l2 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.35), lamp); l2.position.set(sz * 4, -0.15, i); truss.add(l2);
      }
    }
    truss.position.y = 7;
    s.add(truss);
  }

  buildRopes() {
    const w = this.world;
    this.ropes = [];
    const sides = [
      { axis: 'z', coord: -ROPE_LINE }, { axis: 'z', coord: ROPE_LINE },
      { axis: 'x', coord: -ROPE_LINE }, { axis: 'x', coord: ROPE_LINE },
    ];
    for (const side of sides) {
      for (const hgt of ROPE_HEIGHTS) {
        const parts = [];
        for (let i = 0; i < ROPE_NODES; i++) {
          const t = -POST + (2 * POST * i) / (ROPE_NODES - 1);
          const pos = side.axis === 'z' ? new THREE.Vector3(t, hgt, side.coord) : new THREE.Vector3(side.coord, hgt, t);
          const pinned = i === 0 || i === ROPE_NODES - 1;
          const p = new Particle(pos, { mass: pinned ? 0 : 0.5, radius: ROPE_R, gravityScale: 0.25, damping: 0.03, name: 'rope' });
          parts.push(w.addParticle(p));
        }
        const seg = (2 * POST) / (ROPE_NODES - 1);
        for (let i = 0; i < ROPE_NODES - 1; i++) {
          w.addConstraint(new DistanceConstraint(parts[i], parts[i + 1], { length: seg * 0.985, stiffness: 0.25 }));
        }
        this.ropes.push({ ...side, parts });
      }
    }
    const segCount = this.ropes.length * (ROPE_NODES - 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.45 });
    this.ropeMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(ROPE_R, ROPE_R, 1, 8), mat, segCount);
    this.ropeMesh.castShadow = true;
    this.ropeMesh.frustumCulled = false;
    // colour the middle rope of each side
    const red = new THREE.Color(0xc81818), white = new THREE.Color(0xeeeeee), blue = new THREE.Color(0x1a48c8);
    let idx = 0;
    this.ropes.forEach((r, ri) => {
      for (let i = 0; i < ROPE_NODES - 1; i++) this.ropeMesh.setColorAt(idx++, ri % 3 === 1 ? (ri < 6 ? red : blue) : white);
    });
    this.scene.add(this.ropeMesh);
  }

  /** Rope contacts for ragdoll particles, and the player's body pressing into ropes. */
  collideRopes(particles, player) {
    for (const rope of this.ropes) {
      const ax = rope.axis;
      for (const p of particles) {
        if (Math.abs(p.pos[ax] - rope.coord) > 0.45) continue;
        const parts = rope.parts;
        for (let i = 0; i < parts.length - 1; i++) collideParticleSegment(p, parts[i], parts[i + 1], ROPE_R);
      }
      if (Math.abs(player.pos[ax] - rope.coord) < 0.5) {
        for (const rp of rope.parts) {
          if (!rp.invMass || rp.pos.y > player.headBase.y + 0.1) continue;
          const dx = rp.pos.x - player.pos.x, dz = rp.pos.z - player.pos.z;
          const d = Math.hypot(dx, dz);
          const r = 0.32;
          if (d < r && d > 1e-6) { rp.pos.x += (dx / d) * (r - d); rp.pos.z += (dz / d) * (r - d); }
        }
      }
    }
    // Hard wall just outside the ropes so nothing ever escapes the ring
    for (const p of particles) {
      if (Math.abs(p.pos.x) > ROPE_LINE + 0.12) p.pos.x = Math.sign(p.pos.x) * (ROPE_LINE + 0.12);
      if (Math.abs(p.pos.z) > ROPE_LINE + 0.12) p.pos.z = Math.sign(p.pos.z) * (ROPE_LINE + 0.12);
    }
  }

  buildCrowd() {
    // stepped stands (lathe profile)
    const pts = [new THREE.Vector2(6.4, -1.1)];
    const rows = 9;
    this.seats = [];
    for (let r = 0; r < rows; r++) {
      const rad = 6.6 + r * 1.0;
      const y = -1.1 + 0.25 + r * 0.42;
      pts.push(new THREE.Vector2(rad - 0.5, y), new THREE.Vector2(rad + 0.5, y));
      const n = Math.floor((2 * Math.PI * rad) / 0.55);
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.12) continue;
        const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.02;
        this.seats.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, y, a, phase: Math.random() * 10, amp: 0.4 + Math.random() * 0.6 });
      }
    }
    pts.push(new THREE.Vector2(6.6 + rows, 4), new THREE.Vector2(30, 4));
    const stands = new THREE.Mesh(new THREE.LatheGeometry(pts, 72), new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.95, side: THREE.DoubleSide }));
    this.scene.add(stands);

    const n = this.seats.length;
    const bodyGeo = new THREE.CapsuleGeometry(0.2, 0.42, 3, 8);
    const headGeo = new THREE.SphereGeometry(0.12, 10, 8);
    const mat = new THREE.MeshLambertMaterial();
    this.crowdBodies = new THREE.InstancedMesh(bodyGeo, mat, n);
    this.crowdHeads = new THREE.InstancedMesh(headGeo, new THREE.MeshLambertMaterial(), n);
    const shirt = [0x2a3a6a, 0x6a2a2a, 0x3a3a3a, 0x5a5a20, 0x204a3a, 0x7a7a7a, 0x4a2a5a, 0x151515];
    const skin = [0x8a5a3a, 0xc08a6a, 0x5a3a2a, 0xd0a080];
    const c = new THREE.Color();
    this.seats.forEach((s, i) => {
      this.crowdBodies.setColorAt(i, c.setHex(shirt[(Math.random() * shirt.length) | 0]));
      this.crowdHeads.setColorAt(i, c.setHex(skin[(Math.random() * skin.length) | 0]));
    });
    this.scene.add(this.crowdBodies, this.crowdHeads);

    // camera flashes
    this.flashes = [];
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), flashMat);
      m.visible = false;
      this.scene.add(m);
      this.flashes.push({ m, t: 0 });
    }
    this.updateCrowd(0);
  }

  updateCrowd(dt) {
    this.time += dt;
    this.excitement = Math.max(0, this.excitement - dt * 0.25);
    const ex = Math.min(1, this.excitement);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    this.seats.forEach((s, i) => {
      const bob = Math.max(0, Math.sin(this.time * (3 + ex * 5) + s.phase)) * (0.02 + ex * 0.18) * s.amp;
      p.set(s.x, s.y + 0.41 + bob, s.z);
      m.compose(p, q, sc);
      this.crowdBodies.setMatrixAt(i, m);
      p.y += 0.42;
      m.compose(p, q, sc);
      this.crowdHeads.setMatrixAt(i, m);
    });
    this.crowdBodies.instanceMatrix.needsUpdate = true;
    this.crowdHeads.instanceMatrix.needsUpdate = true;

    for (const f of this.flashes) {
      f.t -= dt;
      f.m.visible = f.t > 0;
      if (f.t <= 0 && Math.random() < dt * (0.4 + ex * 12)) {
        const s = this.seats[(Math.random() * this.seats.length) | 0];
        f.m.position.set(s.x, s.y + 0.95, s.z);
        f.t = 0.06;
      }
    }
  }

  updateRopes() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const d = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let idx = 0;
    for (const r of this.ropes) {
      for (let i = 0; i < r.parts.length - 1; i++) {
        const a = r.parts[i].pos, b = r.parts[i + 1].pos;
        d.subVectors(b, a);
        const len = d.length();
        mid.addVectors(a, b).multiplyScalar(0.5);
        q.setFromUnitVectors(up, d.multiplyScalar(1 / len));
        sc.set(1, len + 0.01, 1);
        m.compose(mid, q, sc);
        this.ropeMesh.setMatrixAt(idx++, m);
      }
    }
    this.ropeMesh.instanceMatrix.needsUpdate = true;
  }
}

function makeCanvasTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#d6dae2';
  g.fillRect(0, 0, 1024, 1024);
  // subtle cloth noise
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`;
    g.fillRect(Math.random() * 1024, Math.random() * 1024, 2, 2);
  }
  g.strokeStyle = 'rgba(20,32,74,0.55)';
  g.lineWidth = 10;
  g.beginPath(); g.arc(512, 512, 170, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(20,32,74,0.6)';
  g.font = 'bold 64px Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('KNOCKOUT', 512, 500);
  g.font = 'bold 40px Arial, sans-serif';
  g.fillText('PHYSICS', 512, 555);
  g.font = 'italic 28px Georgia, serif';
  g.fillText('F = m a', 512, 600);
  // corner wear marks
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (const [x, y] of [[90, 90], [934, 90], [90, 934], [934, 934]]) { g.beginPath(); g.arc(x, y, 120, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
