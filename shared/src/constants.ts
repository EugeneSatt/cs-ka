export const TICK_RATE = 30;

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;
export const CROUCH_EYE_HEIGHT = 1.0;

export const GRAVITY = -20;

export type WeaponType = 'rifle' | 'sniper' | 'shotgun';
export type WeaponSlot = 'primary' | 'pistol' | 'grenade';
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

export const WEAPON_CONFIG: Record<'rifle' | 'sniper' | 'shotgun' | 'pistol', WeaponConfig> = {
  rifle: {
    baseDamage: 30,
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
  speed: 16,
  upBoost: 2.5,
  radius: 5,
  maxDamage: 80,
};
