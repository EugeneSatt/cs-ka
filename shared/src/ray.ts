import type { Vec3 } from './types';

export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return [
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    -Math.cos(yaw) * cosPitch,
  ];
}

export function rayIntersectAABB(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): number | null {
  const tMin = [0, 0, 0];
  const tMax = [0, 0, 0];

  for (let i = 0; i < 3; i += 1) {
    const d = dir[i];
    if (Math.abs(d) < 1e-8) {
      if (origin[i] < min[i] || origin[i] > max[i]) {
        return null;
      }
      tMin[i] = -Infinity;
      tMax[i] = Infinity;
    } else {
      const inv = 1 / d;
      let t1 = (min[i] - origin[i]) * inv;
      let t2 = (max[i] - origin[i]) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tMin[i] = t1;
      tMax[i] = t2;
    }
  }

  const entry = Math.max(tMin[0], tMin[1], tMin[2]);
  const exit = Math.min(tMax[0], tMax[1], tMax[2]);

  if (exit < 0 || entry > exit) {
    return null;
  }

  return entry >= 0 ? entry : exit;
}
