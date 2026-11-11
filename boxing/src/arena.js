// The octagon (an eight-sided fenced cage), lights and crowd.

import * as THREE from 'three';

/** Distance from the centre to the middle of each fence panel. */
export const OCT_APOTHEM = 3.6;
const OCT_CORNER = OCT_APOTHEM / Math.cos(Math.PI / 8);
const FENCE_H = 1.75;
// Outward normals of the 8 fence panels (a flat side faces each of +x, -x, +z, -z).
const NORMALS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);

/** Push a point back inside the octagon, keeping it `margin` away from the fence. Returns how far it was pushed. */
export function clampToOctagon(v, margin) {
  let pushed = 0;
  for (const [nx, nz] of NORMALS) {
    const d = v.x * nx + v.z * nz - (OCT_APOTHEM - margin);
    if (d > 0) { v.x -= nx * d; v.z -= nz * d; pushed = Math.max(pushed, d); }
  }
  return pushed;
}

export class Arena {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.time = 0;
    this.excitement = 0;
    this.buildLights();
    this.buildRing();
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

    // raised platform and the mat
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(OCT_CORNER + 0.45, OCT_CORNER + 0.55, 1.1, 8),
      new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.7 }));
    platform.rotation.y = Math.PI / 8;
    platform.position.y = -0.551;
    platform.receiveShadow = true;
    s.add(platform);
    const mat = new THREE.Mesh(new THREE.CircleGeometry(OCT_CORNER + 0.4, 8), new THREE.MeshStandardMaterial({ map: makeMatTexture(), roughness: 0.85 }));
    mat.rotation.x = -Math.PI / 2; mat.rotation.z = Math.PI / 8;
    mat.position.y = 0.001; mat.receiveShadow = true;
    s.add(mat);

    // fence: posts, chain-link panels, padded top rail and bottom skirt
    const postMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, metalness: 0.6, roughness: 0.4 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x101014, roughness: 0.6 });
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0x8a1018, roughness: 0.5 });
    const linkTex = makeChainLinkTexture();
    const side = 2 * OCT_APOTHEM * Math.tan(Math.PI / 8);
    linkTex.repeat.set(side * 7, FENCE_H * 7);
    const linkMat = new THREE.MeshStandardMaterial({ map: linkTex, alphaTest: 0.4, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.5 });
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, ca = Math.cos(a), sa = Math.sin(a);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(side, FENCE_H - 0.3), linkMat);
      panel.position.set(ca * (OCT_APOTHEM + 0.12), 0.3 + (FENCE_H - 0.3) / 2, sa * (OCT_APOTHEM + 0.12));
      panel.rotation.y = -a + Math.PI / 2;
      s.add(panel);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(side + 0.1, 0.16, 0.2), padMat);
      rail.position.set(ca * (OCT_APOTHEM + 0.12), FENCE_H, sa * (OCT_APOTHEM + 0.12));
      rail.rotation.y = -a + Math.PI / 2; rail.castShadow = true;
      s.add(rail);
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(side + 0.05, 0.3, 0.12), skirtMat);
      skirt.position.set(ca * (OCT_APOTHEM + 0.16), 0.15, sa * (OCT_APOTHEM + 0.16));
      skirt.rotation.y = -a + Math.PI / 2;
      s.add(skirt);
      const c = a + Math.PI / 8;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, FENCE_H + 0.1, 10), postMat);
      post.position.set(Math.cos(c) * (OCT_CORNER + 0.13), (FENCE_H + 0.1) / 2, Math.sin(c) * (OCT_CORNER + 0.13));
      post.castShadow = true;
      s.add(post);
    }

    // lighting truss above the cage
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

  /** The fence: keeps the opponent's body parts and the player inside the cage. */
  collideCage(particles, player) {
    let hit = 0;
    for (const p of particles) {
      const d = clampToOctagon(p.pos, p.radius);
      if (d > 0) hit = Math.max(hit, d);
    }
    clampToOctagon(player.pos, 0.35);
    return hit;
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

}

function makeMatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#e4e6ea';
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`;
    g.fillRect(Math.random() * 1024, Math.random() * 1024, 2, 2);
  }
  // centre octagon and logo
  g.strokeStyle = 'rgba(140,16,24,0.6)';
  g.lineWidth = 10;
  g.beginPath();
  for (let i = 0; i <= 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8;
    const x = 512 + Math.cos(a) * 190, y = 512 + Math.sin(a) * 190;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.stroke();
  g.fillStyle = 'rgba(20,20,26,0.75)';
  g.textAlign = 'center';
  g.font = 'bold 64px Arial, sans-serif';
  g.fillText('KNOCKOUT', 512, 500);
  g.font = 'bold 40px Arial, sans-serif';
  g.fillText('PHYSICS  MMA', 512, 555);
  g.font = 'italic 28px Georgia, serif';
  g.fillText('F = m a', 512, 600);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** One diamond of chain-link fence, tiled across each panel. */
function makeChainLinkTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = '#c8ccd4';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(32, 0); g.lineTo(64, 32); g.lineTo(32, 64); g.lineTo(0, 32); g.closePath();
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
