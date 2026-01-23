import type { MatchTeam, Side, WeaponSlot, WeaponType } from './constants';

export type Vec3 = [number, number, number];

export type BoxDef = {
  id?: string;
  min: Vec3;
  max: Vec3;
  color?: string;
  texture?: string;
};

export type ModelDef = {
  path: string;
  pos: Vec3;
  rot?: Vec3;
  scale?: number | Vec3;
};

export type MapData = {
  name: string;
  boxes: BoxDef[];
  models?: ModelDef[];
  spawns: {
    T: Vec3[];
    CT: Vec3[];
  };
};

export type InputPayload = {
  seq: number;
  dt: number;
  move: { f: number; s: number };
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
  shoot: boolean;
  weapon: WeaponSlot;
  reload: boolean;
  throwGrenade: boolean;
};

export type ClientJoin = {
  type: 'join';
  name?: string;
  primary: WeaponType;
  preferredSide?: Side;
};

export type ClientBuy = {
  type: 'buy';
  primary: WeaponType;
};

export type ClientInput = {
  type: 'input';
  input: InputPayload;
};

export type ClientMessage = ClientJoin | ClientInput | ClientBuy;

export type PlayerSnapshot = {
  id: string;
  name: string;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  matchTeam: MatchTeam;
  side: Side;
  weapon: WeaponSlot;
  primary: WeaponType;
  ammo: {
    primary: number;
    pistol: number;
  };
  grenades: number;
  lastSeq: number;
  crouching: boolean;
};

export type GrenadeSnapshot = {
  id: string;
  pos: Vec3;
  vel: Vec3;
  ownerId: string;
};

export type RoundState = {
  round: number;
  phase: 'freeze' | 'live' | 'post' | 'match_over';
  timeLeft: number;
  freezeLeft: number;
  scores: {
    A: number;
    B: number;
  };
  sideByTeam: {
    A: Side;
    B: Side;
  };
  postLeft?: number;
  postReason?: 'draw';
};

export type ServerEvent =
  | {
      type: 'hit';
      attackerId: string;
      victimId: string;
      damage: number;
      remainingHp: number;
    }
  | {
      type: 'kill';
      attackerId: string;
      victimId: string;
      weapon: WeaponSlot | WeaponType;
    }
  | {
      type: 'round_end';
      winnerSide: Side;
      winnerTeam: MatchTeam;
      reason: 'elimination' | 'time';
    }
  | {
      type: 'round_draw';
      reason: 'time' | 'survivors';
    }
  | {
      type: 'round_start';
      round: number;
      sideByTeam: {
        A: Side;
        B: Side;
      };
    }
  | {
      type: 'match_over';
      reason: 'kills';
      winners: Array<{ id: string; name: string; kills: number }>;
    }
  | {
      type: 'grenade_explode';
      pos: Vec3;
      ownerId: string;
    };

export type ServerSnapshot = {
  type: 'snapshot';
  now: number;
  players: PlayerSnapshot[];
  grenades: GrenadeSnapshot[];
  events: ServerEvent[];
  round: RoundState;
};

export type WelcomeMessage = {
  type: 'welcome';
  id: string;
  map: MapData;
  tickRate: number;
};

export type ServerMessage = WelcomeMessage | ServerSnapshot;
