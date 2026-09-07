import * as THREE from 'three';

// Positive margins are outside the frame; negative margins put infrastructure just inside.
export function feederEntryPoint(curve: THREE.CubicBezierCurve3, camera: THREE.Camera, width: number, height: number, marginPixels = 24) {
  const outward = curve.getTangent(0).setY(0).normalize().negate();
  const hover = curve.v0.clone().add(new THREE.Vector3(0, .32, 0));
  const projected = hover.clone().project(camera);
  const direction = hover.add(outward).project(camera).sub(projected);
  // Start just outside the nearest screen edge, not at the far end of the hidden artery.
  const distances = (['x', 'y'] as const).map(axis => {
    const margin = marginPixels * 2 / Math.max(1, axis === 'x' ? width : height);
    const delta = direction[axis];
    return Math.abs(delta) < 1e-8 ? Infinity : ((Math.sign(delta) * (1 + margin)) - projected[axis]) / delta;
  }).filter(distance => distance > 0);
  const distance = Math.min(60, ...distances);
  return curve.v0.clone().addScaledVector(outward, distance);
}

// Extend only the visual approach; the original bridge, gate and HTTP deadline stay fixed.
export function feederApproach(curve: THREE.CubicBezierCurve3, gate: number, camera: THREE.Camera, width: number, height: number) {
  const start = feederEntryPoint(curve, camera, width, height);
  // De Casteljau subdivision preserves the exact original curve up to the gate.
  const a = curve.v0.clone().lerp(curve.v1, gate);
  const b = curve.v1.clone().lerp(curve.v2, gate);
  const c = curve.v2.clone().lerp(curve.v3, gate);
  const d = a.clone().lerp(b, gate);
  const end = d.clone().lerp(b.clone().lerp(c, gate), gate);
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(new THREE.LineCurve3(start, curve.v0.clone()));
  path.add(new THREE.CubicBezierCurve3(curve.v0.clone(), a, d, end));
  return path;
}
