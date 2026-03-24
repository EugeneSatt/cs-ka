import type { MapData, Vec3 } from './types';
import { CROUCH_SPEED_MULT, GRAVITY, PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';

export type PhysicsState = {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
};

export type MoveInput = {
  f: number;
  s: number;
  jump: boolean;
  crouch?: boolean;
};

const MAX_SPEED = 6;
const GROUND_ACCEL = 20;
const AIR_ACCEL = 8;
const FRICTION = 24;
const STOP_SPEED = 0.05;
const JUMP_SPEED = 7;
const STEP_HEIGHT = 0.45;
const STEP_CHECK_EPS = 0.12;
const STEP_CHECK_MAX_RISE = 0.65;
const PENETRATION_RESOLVE_STEP = 0.05;
const PENETRATION_RESOLVE_MAX_DIST = PLAYER_RADIUS + STEP_HEIGHT + 0.35;
const PENETRATION_RESOLVE_DIRECTIONS = 16;
const PENETRATION_Y_OFFSETS = [0, STEP_HEIGHT * 0.5, STEP_HEIGHT, -0.15];

export function movePlayer(
  state: PhysicsState,
  move: MoveInput,
  yaw: number,
  dt: number,
  map: MapData
): PhysicsState {
  const crouching = !!move.crouch;
  const speedMul = crouching ? CROUCH_SPEED_MULT : 1;
  let pos: Vec3 = [state.pos[0], state.pos[1], state.pos[2]];
  const vel: Vec3 = [state.vel[0], state.vel[1], state.vel[2]];
  pos = resolvePenetration(pos, map);

  const hasInput = Math.abs(move.f) > 0.01 || Math.abs(move.s) > 0.01;

  if (hasInput) {
    const forward: Vec3 = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    let wish: Vec3 = [
      forward[0] * move.f + right[0] * move.s,
      0,
      forward[2] * move.f + right[2] * move.s,
    ];
    const len = Math.hypot(wish[0], wish[2]);
    if (len > 0) {
      wish = [wish[0] / len, 0, wish[2] / len];
    }
    const wishVel: Vec3 = [wish[0] * MAX_SPEED * speedMul, 0, wish[2] * MAX_SPEED * speedMul];
    vel[0] = wishVel[0];
    vel[2] = wishVel[2];
  } else {
    vel[0] = 0;
    vel[2] = 0;
  }

  // No inertia: velocity is already clamped to max speed.

  if (move.jump && state.onGround) {
    vel[1] = JUMP_SPEED;
  }

  vel[1] += GRAVITY * dt;

  const baseGround = state.onGround ? groundHeightAt(pos, map, pos[1]) : null;
  const moved = moveWithCollisions(pos, vel, dt, map, state.onGround, move.jump, baseGround);
  moved.pos = resolvePenetration(moved.pos, map);
  const snappedGround =
    !move.jump && moved.vel[1] <= 0 ? groundHeightAt(moved.pos, map, Math.max(pos[1], moved.pos[1])) : null;
  if (snappedGround !== null) {
    const delta = snappedGround - moved.pos[1];
    if (delta >= -STEP_HEIGHT - 0.08 && delta <= STEP_CHECK_MAX_RISE) {
      moved.pos[1] = snappedGround;
    }
  }

  const onGround = isOnGround(moved.pos, map);
  if (onGround && moved.vel[1] < 0) {
    moved.vel[1] = 0;
  }
  if (onGround && !move.jump) {
    const groundY = groundHeightAt(moved.pos, map, moved.pos[1]);
    if (groundY !== null) {
      const delta = groundY - moved.pos[1];
      if (Math.abs(delta) <= STEP_HEIGHT + 0.05) {
        moved.pos[1] = groundY;
      }
    }
  }

  return {
    pos: moved.pos,
    vel: moved.vel,
    onGround,
  };
}

export function isOnGround(pos: Vec3, map: MapData): boolean {
  const test: Vec3 = [pos[0], pos[1] - 0.05, pos[2]];
  return collidesAt(test, map);
}

export function collidesAt(pos: Vec3, map: MapData): boolean {
  const min: Vec3 = [pos[0] - PLAYER_RADIUS, pos[1], pos[2] - PLAYER_RADIUS];
  const max: Vec3 = [pos[0] + PLAYER_RADIUS, pos[1] + PLAYER_HEIGHT, pos[2] + PLAYER_RADIUS];
  for (const box of map.boxes) {
    if (aabbIntersects(min, max, box.min, box.max)) {
      return true;
    }
  }
  return false;
}

export function resolvePenetration(pos: Vec3, map: MapData): Vec3 {
  if (!collidesAt(pos, map)) {
    return pos;
  }

  for (const yOffset of PENETRATION_Y_OFFSETS) {
    const candidate: Vec3 = [pos[0], pos[1] + yOffset, pos[2]];
    if (!collidesAt(candidate, map)) {
      return candidate;
    }
  }

  const steps = Math.ceil(PENETRATION_RESOLVE_MAX_DIST / PENETRATION_RESOLVE_STEP);
  for (let step = 1; step <= steps; step += 1) {
    const radius = step * PENETRATION_RESOLVE_STEP;
    for (const yOffset of PENETRATION_Y_OFFSETS) {
      for (let dir = 0; dir < PENETRATION_RESOLVE_DIRECTIONS; dir += 1) {
        const angle = (dir / PENETRATION_RESOLVE_DIRECTIONS) * Math.PI * 2;
        const candidate: Vec3 = [
          pos[0] + Math.cos(angle) * radius,
          pos[1] + yOffset,
          pos[2] + Math.sin(angle) * radius,
        ];
        if (!collidesAt(candidate, map)) {
          return candidate;
        }
      }
    }
  }

  return pos;
}

function moveWithCollisions(
  pos: Vec3,
  vel: Vec3,
  dt: number,
  map: MapData,
  onGround: boolean,
  jumping: boolean,
  baseGround: number | null
): { pos: Vec3; vel: Vec3 } {
  let next: Vec3 = [pos[0], pos[1], pos[2]];

  next = moveAxis(next, vel, 0, dt, map, onGround, jumping, baseGround);
  next = moveAxis(next, vel, 1, dt, map, onGround, jumping, baseGround);
  next = moveAxis(next, vel, 2, dt, map, onGround, jumping, baseGround);

  return { pos: next, vel };
}

function moveAxis(
  pos: Vec3,
  vel: Vec3,
  axis: 0 | 1 | 2,
  dt: number,
  map: MapData,
  onGround: boolean,
  jumping: boolean,
  baseGround: number | null
): Vec3 {
  const next: Vec3 = [pos[0], pos[1], pos[2]];
  next[axis] += vel[axis] * dt;
  if (!collidesAt(next, map)) {
    return next;
  }

  if (STEP_HEIGHT > 0 && axis !== 1 && vel[axis] !== 0 && onGround && !jumping) {
    const nextGround = groundHeightAt(next, map, pos[1]);
    if (nextGround !== null) {
      const base = baseGround ?? pos[1];
      const rise = nextGround - base;
      if (rise > STEP_CHECK_EPS && rise <= STEP_CHECK_MAX_RISE) {
        const stepped: Vec3 = [next[0], nextGround, next[2]];
        if (!collidesAt(stepped, map)) {
          return stepped;
        }
      }
    }

    const stepUpPos: Vec3 = [pos[0], pos[1] + STEP_HEIGHT, pos[2]];
    const stepNext: Vec3 = [next[0], next[1] + STEP_HEIGHT, next[2]];
    if (!collidesAt(stepUpPos, map) && !collidesAt(stepNext, map)) {
      const stepGround = groundHeightAt(stepNext, map, pos[1] + STEP_HEIGHT);
      if (stepGround !== null) {
        const base = baseGround ?? pos[1];
        const rise = stepGround - base;
        if (rise > STEP_CHECK_MAX_RISE) {
          vel[axis] = 0;
          return pos;
        }
        const stepped: Vec3 = [stepNext[0], stepGround, stepNext[2]];
        if (!collidesAt(stepped, map)) {
          return stepped;
        }
      }
      return stepNext;
    }
  }

  vel[axis] = 0;
  return pos;
}

function aabbIntersects(aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): boolean {
  return (
    aMin[0] < bMax[0] &&
    aMax[0] > bMin[0] &&
    aMin[1] < bMax[1] &&
    aMax[1] > bMin[1] &&
    aMin[2] < bMax[2] &&
    aMax[2] > bMin[2]
  );
}

function approach(current: number, target: number, delta: number): number {
  if (current < target) {
    return Math.min(current + delta, target);
  }
  return Math.max(current - delta, target);
}

function groundHeightAt(pos: Vec3, map: MapData, referenceY: number): number | null {
  const minX = pos[0] - PLAYER_RADIUS;
  const maxX = pos[0] + PLAYER_RADIUS;
  const minZ = pos[2] - PLAYER_RADIUS;
  const maxZ = pos[2] + PLAYER_RADIUS;
  let best = -Infinity;
  for (const box of map.boxes) {
    if (box.type === 'collider_model') {
      continue;
    }
    if (maxX <= box.min[0] || minX >= box.max[0] || maxZ <= box.min[2] || minZ >= box.max[2]) {
      continue;
    }
    if (box.min[1] > referenceY + STEP_CHECK_MAX_RISE) {
      continue;
    }
    if (box.max[1] > best) {
      best = box.max[1];
    }
  }
  return best === -Infinity ? null : best;
}
