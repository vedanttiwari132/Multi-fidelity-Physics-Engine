// Hair styles and facial hair, grown from the head itself: each style is a shell that follows
// the head mesh, lifted off it along its normals by a thickness that fades to nothing at the
// edges (so it meets the skin cleanly), plus a few extra pieces (a bun, spikes). Built in the
// head's own frame, so it rides on the head bone with the eyes and mouth.

import * as THREE from 'three';
import { toonMaterial, outlineMaterial } from './body.js';

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Where the hair grows: 1 on the scalp, fading out at the hairline (head-local metres: y up, z forward). */
function scalp(x, y, z, low = 0) {
  const line = 0.022 + 0.69 * z - low;               // high on the forehead, low at the nape
  const ears = 1 - ss(0.118, 0.135, Math.abs(x)) * (1 - ss(0.07, 0.1, y));   // (not over the ears)
  return ss(line, line + 0.025, y) * ears;
}

/** Thickness of each style at a point on the head (metres off the skin). */
const STYLES = {
  crop: (x, y, z) => 0.016 * scalp(x, y, z),
  mohawk: (x, y, z) => scalp(x, y, z) * (1 - ss(0.024, 0.042, Math.abs(x))) * (0.075 + 0.035 * ss(-0.1, 0.06, z)),
  afro: (x, y, z) => 0.062 * scalp(x, y, z, 0.035) * (0.75 + 0.25 * ss(-0.02, 0.12, y)),
  bun: (x, y, z) => 0.014 * scalp(x, y, z),
  spikes: (x, y, z) => 0.012 * scalp(x, y, z),
};

/** Where facial hair grows: below the nose, on the front and sides of the jaw, not over the lips. */
const MOUTH_Y = -0.045;
function jaw(x, y, z) {
  const front = ss(-0.03, 0.03, z);
  const line = -0.03 + 0.4 * Math.max(0, Math.abs(x) - 0.04) - 0.15 * Math.max(0, z - 0.1);   // low at the front, up to the sideburns
  const below = 1 - ss(line - 0.012, line + 0.008, y);                    // under the cheekbones
  const lips = 1 - (1 - ss(0.026, 0.036, Math.abs(x))) * (1 - ss(0.008, 0.016, Math.abs(y - MOUTH_Y)));
  return front * below * lips;
}
const BEARDS = {
  stubble: (x, y, z) => 0.0035 * jaw(x, y, z),
  full: (x, y, z) => jaw(x, y, z) * (0.012 + 0.012 * ss(-0.05, -0.12, y)),
  goatee: (x, y, z) => jaw(x, y, z) * (1 - ss(0.035, 0.05, Math.abs(x))) * (0.012 + 0.008 * ss(-0.06, -0.11, y)) * ss(-0.01, -0.035, y),
  moustache: (x, y, z) => 0.011 * (1 - ss(0.045, 0.06, Math.abs(x))) * ss(-0.042, -0.034, y) * (1 - ss(-0.016, -0.008, y)) * ss(0.06, 0.09, z),
};

/** A shell over the head template's head vertices: thickness(x, y, z) in head-local metres. */
function shell(template, center, thickness) {
  const P = template.geometry.getAttribute('position'), N = template.geometry.getAttribute('normal');
  const Z = template.geometry.getAttribute('aZone'), I = template.geometry.index.array;
  const map = new Int32Array(P.count).fill(-1), t = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) {
    if (Z.getX(i) < 1.6) continue;   // the head only
    t[i] = thickness(P.getX(i) - center[0], P.getY(i) - center[1], P.getZ(i) - center[2]);
  }
  const pos = [], idx = [];
  const vert = (i) => {
    if (map[i] < 0) {
      map[i] = pos.length / 3;
      const d = t[i] + 0.0015;   // (a hair above the skin, so it never flickers through)
      pos.push(P.getX(i) - center[0] + N.getX(i) * d, P.getY(i) - center[1] + N.getY(i) * d, P.getZ(i) - center[2] + N.getZ(i) * d);
    }
    return map[i];
  };
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k], b = I[k + 1], c = I[k + 2];
    if (t[a] > 2e-4 && t[b] > 2e-4 && t[c] > 2e-4) idx.push(vert(a), vert(b), vert(c));
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Up to `count` points spread over the top of the scalp, at least `gap` apart: [[position, normal]] (head-local). */
function scalpPoints(template, center, count, gap) {
  const P = template.geometry.getAttribute('position'), N = template.geometry.getAttribute('normal'), Z = template.geometry.getAttribute('aZone');
  const cand = [];
  for (let i = 0; i < P.count; i += 3) {
    if (Z.getX(i) < 1.6) continue;
    const x = P.getX(i) - center[0], y = P.getY(i) - center[1], z = P.getZ(i) - center[2];
    if (scalp(x, y, z) > 0.95 && y > 0.07) cand.push([new THREE.Vector3(x, y, z), new THREE.Vector3(N.getX(i), N.getY(i), N.getZ(i))]);
  }
  cand.sort((a, b) => b[0].y - a[0].y);   // from the crown down
  const out = [];
  for (const c of cand) {
    if (out.every((o) => o[0].distanceTo(c[0]) > gap)) out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

function addMesh(group, geo, color, outline = 0.004) {
  const m = new THREE.Mesh(geo, toonMaterial({ color }));
  m.castShadow = true;
  group.add(m);
  if (outline) group.add(new THREE.Mesh(geo, outlineMaterial(outline)));
  return m;
}

/**
 * The hair and facial hair for a look, as a group in head-local coordinates.
 * look: { hair, hairColor, beard, beardColor, skin }. center: the head joint (rest pose).
 */
export function buildHairGroup(template, center, look) {
  const group = new THREE.Group();
  const style = STYLES[look.hair];
  if (style) {
    const g = shell(template, center, style);
    if (g) addMesh(group, g, look.hairColor, look.hair === 'afro' || look.hair === 'mohawk' ? 0.005 : 0.003);
  }
  if (look.hair === 'bun') {   // a top knot sitting on the back of the crown (found on the head's own surface)
    const P = template.geometry.getAttribute('position'), N = template.geometry.getAttribute('normal'), Z = template.geometry.getAttribute('aZone');
    let best = -1e9, at = new THREE.Vector3(), nrm = new THREE.Vector3(0, 0.6, -0.8);
    for (let i = 0; i < P.count; i++) {
      if (Z.getX(i) < 1.6 || Math.abs(P.getX(i) - center[0]) > 0.01) continue;
      const y = P.getY(i) - center[1], z = P.getZ(i) - center[2], score = y * 0.8 - z;
      if (score > best) { best = score; at.set(P.getX(i) - center[0], y, z); nrm.set(N.getX(i), N.getY(i), N.getZ(i)); }
    }
    const bun = new THREE.SphereGeometry(1, 18, 12);
    bun.scale(0.05, 0.044, 0.05);
    const c = at.addScaledVector(nrm.normalize(), 0.045);
    bun.translate(c.x, c.y, c.z);
    addMesh(group, bun, look.hairColor, 0.004);
  }
  if (look.hair === 'spikes') {   // gelled spikes, standing out of the scalp all over the top
    const cone = new THREE.ConeGeometry(0.024, 0.075, 6);
    cone.translate(0, 0.03, 0);
    const up = new THREE.Vector3(0, 1, 0);
    for (const [p, n] of scalpPoints(template, center, 13, 0.05)) {
      const g = cone.clone();
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, n.clone().lerp(up, 0.35).normalize()));
      g.translate(p.x, p.y, p.z);
      addMesh(group, g, look.hairColor, 0.003);
    }
  }
  const beard = BEARDS[look.beard];
  if (beard) {
    const g = shell(template, center, beard);
    // stubble is a shadow, part skin
    const col = look.beard === 'stubble' ? new THREE.Color(look.beardColor).lerp(new THREE.Color(look.skin), 0.45).getHex() : look.beardColor;
    if (g) addMesh(group, g, col, look.beard === 'stubble' ? 0 : 0.003);
  }
  return group;
}

/** Whether the scalp itself is painted with hair colour (a buzz cut, and under every style but bald). */
export const paintsScalp = (hair) => hair !== 'bald';
