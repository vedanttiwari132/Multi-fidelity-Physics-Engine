// Small geometry helpers for the animation layer. (The physics itself is Rapier: see sim.js
// and ragdoll.js.)

import * as THREE from 'three';

const _ikDir = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
/** Analytic two-bone IK: finds the middle joint (elbow/knee) between root and end. */
export function solveTwoBone(root, end, l1, l2, pole, out) {
  _ikDir.subVectors(end, root);
  const raw = _ikDir.length() || 1e-6;
  _ikDir.multiplyScalar(1 / raw);
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, raw));
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _ikPole.copy(pole).addScaledVector(_ikDir, -pole.dot(_ikDir));
  if (_ikPole.lengthSq() < 1e-8) _ikPole.set(0, -1, 0);
  _ikPole.normalize();
  return out.copy(root).addScaledVector(_ikDir, along).addScaledVector(_ikPole, h);
}
