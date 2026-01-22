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
const FRICTION = 8;
const JUMP_SPEED = 7;
const STEP_HEIGHT = 0.6;

export function movePlayer(
  state: PhysicsState,
  move: MoveInput,
  yaw: number,
  dt: number,
  map: MapData
): PhysicsState {
  const crouching = !!move.crouch;
  const speedMul = crouching ? CROUCH_SPEED_MULT : 1;
  const pos: Vec3 = [state.pos[0], state.pos[1], state.pos[2]];
  const vel: Vec3 = [state.vel[0], state.vel[1], state.vel[2]];

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
    const accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const wishVel: Vec3 = [wish[0] * MAX_SPEED * speedMul, 0, wish[2] * MAX_SPEED * speedMul];
    vel[0] = approach(vel[0], wishVel[0], accel * dt);
    vel[2] = approach(vel[2], wishVel[2], accel * dt);
  } else if (state.onGround) {
    const drop = Math.max(0, 1 - FRICTION * dt);
    vel[0] *= drop;
    vel[2] *= drop;
  }

  const horiz = Math.hypot(vel[0], vel[2]);
  const maxSpeed = MAX_SPEED * speedMul;
  if (horiz > maxSpeed) {
    const scale = maxSpeed / horiz;
    vel[0] *= scale;
    vel[2] *= scale;
  }

  if (move.jump && state.onGround) {
    vel[1] = JUMP_SPEED;
  }

  vel[1] += GRAVITY * dt;

  const moved = moveWithCollisions(pos, vel, dt, map);
  const onGround = isOnGround(moved.pos, map);
  if (onGround && moved.vel[1] < 0) {
    moved.vel[1] = 0;
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

function moveWithCollisions(pos: Vec3, vel: Vec3, dt: number, map: MapData): { pos: Vec3; vel: Vec3 } {
  let next: Vec3 = [pos[0], pos[1], pos[2]];

  next = moveAxis(next, vel, 0, dt, map);
  next = moveAxis(next, vel, 1, dt, map);
  next = moveAxis(next, vel, 2, dt, map);

  return { pos: next, vel };
}

function moveAxis(pos: Vec3, vel: Vec3, axis: 0 | 1 | 2, dt: number, map: MapData): Vec3 {
  const next: Vec3 = [pos[0], pos[1], pos[2]];
  next[axis] += vel[axis] * dt;
  if (!collidesAt(next, map)) {
    return next;
  }

  if (axis !== 1 && vel[axis] !== 0) {
    const stepUpPos: Vec3 = [pos[0], pos[1] + STEP_HEIGHT, pos[2]];
    const stepNext: Vec3 = [next[0], next[1] + STEP_HEIGHT, next[2]];
    if (!collidesAt(stepUpPos, map) && !collidesAt(stepNext, map)) {
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
