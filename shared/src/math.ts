import type { Vec3 } from './types';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vec3Length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vec3Normalize(a: Vec3): Vec3 {
  const len = vec3Length(a);
  if (len === 0) {
    return [0, 0, 0];
  }
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function vec3Lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpAngle(a: number, b: number, t: number): number {
  const tau = Math.PI * 2;
  let diff = (b - a) % tau;
  if (diff > Math.PI) {
    diff -= tau;
  } else if (diff < -Math.PI) {
    diff += tau;
  }
  return a + diff * t;
}
