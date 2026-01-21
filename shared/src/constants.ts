export const TICK_RATE = 30;

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.6;

export const GRAVITY = -20;

export type WeaponType = 'rifle' | 'sniper' | 'shotgun';
export type WeaponSlot = 'primary' | 'pistol' | 'grenade';
export type Side = 'T' | 'CT';
export type MatchTeam = 'A' | 'B';

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
    baseDamage: 34,
    fireRate: 10,
    range: 80,
    magSize: 30,
    reloadTime: 1.8,
    spread: 0.01,
  },
  sniper: {
    baseDamage: 80,
    fireRate: 1.2,
    range: 120,
    magSize: 5,
    reloadTime: 2.4,
    spread: 0.002,
  },
  shotgun: {
    baseDamage: 10,
    fireRate: 1,
    range: 14,
    magSize: 8,
    reloadTime: 2.6,
    spread: 0.08,
    pellets: 8,
  },
  pistol: {
    baseDamage: 22,
    fireRate: 4,
    range: 50,
    magSize: 12,
    reloadTime: 1.4,
    spread: 0.02,
  },
};

export const GRENADE_CONFIG = {
  fuseTime: 2.2,
  speed: 12,
  upBoost: 4,
  radius: 5,
  maxDamage: 80,
};
