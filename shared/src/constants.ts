export const TICK_RATE = 30;

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;
export const CROUCH_EYE_HEIGHT = 1.0;

export const GRAVITY = -20;

export type WeaponType = 'rifle' | 'sniper' | 'shotgun' | 'aug';
export type WeaponSlot = 'primary' | 'pistol' | 'explosive' | 'grenade' | 'smoke';
export type Side = 'T' | 'CT';
export type MatchTeam = 'A' | 'B';
export type RoundPhase = 'waiting' | 'freeze' | 'live' | 'post' | 'match_over';

export const TOTAL_ROUNDS = 7;
export const SWAP_ROUND = 4;
export const FREEZE_TIME = 10;
export const ROUND_TIME = 115;
export const BUY_WINDOW = 10;
export const FFA_ROUND_TIME = 180;

export const CROUCH_SPEED_MULT = 0.55;

export type WeaponConfig = {
  baseDamage: number;
  fireRate: number;
  range: number;
  magSize: number;
  reloadTime: number;
  spread: number;
  pellets?: number;
};

export const WEAPON_CONFIG: Record<'rifle' | 'sniper' | 'shotgun' | 'aug' | 'pistol', WeaponConfig> = {
  rifle: {
    baseDamage: 17,
    fireRate: 10,
    range: 99999,
    magSize: 30,
    reloadTime: 1.8,
    spread: 0,
  },
  sniper: {
    baseDamage: 150,
    fireRate: 1.2,
    range: 99999,
    magSize: 5,
    reloadTime: 2.4,
    spread: 0,
  },
  shotgun: {
    baseDamage: 8,
    fireRate: 1,
    range: 99999,
    magSize: 8,
    reloadTime: 2.6,
    spread: 0.12,
    pellets: 8,
  },
  aug: {
    baseDamage: 32,
    fireRate: 9,
    range: 99999,
    magSize: 20,
    reloadTime: 2.5,
    spread: 0,
  },
  pistol: {
    baseDamage: 18,
    fireRate: 4,
    range: 99999,
    magSize: 12,
    reloadTime: 1.4,
    spread: 0,
  },
};

export const GRENADE_CONFIG = {
  fuseTime: 2.2,
  speed: 21,
  upBoost: 4.2,
  carryFactor: 0.4,
  gravity: 26,
  bounce: 0.52,
  floorBounceCarry: 0.18,
  minBounceSpeed: 1.4,
  stopSpeed: 0.6,
  radius: 5,
  maxDamage: 110,
};

export const GRENADE_POOL_CONFIG = {
  spreadTime: 0.85,
  duration: 4.5,
  maxRadius: 3.2,
  damageInterval: 0.25,
  maxDamagePerTick: 9,
};

export const SMOKE_GRENADE_CONFIG = {
  fuseTime: 1.8,
  spreadTime: 1,
  duration: 11,
  maxRadius: 4.4,
};
