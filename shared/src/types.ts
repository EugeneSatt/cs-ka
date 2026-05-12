import type { MatchTeam, Side, WeaponSlot, WeaponType } from './constants';

export type Vec3 = [number, number, number];

export type BoxDef = {
  id?: string;
  min: Vec3;
  max: Vec3;
  color?: string;
  texture?: string;
  type?: string;
};

export type ModelDef = {
  path: string;
  pos: Vec3;
  rot?: Vec3;
  scale?: number | Vec3;
  collider?: {
    min: Vec3;
    max: Vec3;
  };
};

export type DecalDef = {
  id?: string;
  src: string;
  pos: Vec3;
  size: [number, number];
  normal?: Vec3;
  offset?: number;
  rotation?: number;
};

export type MapData = {
  name: string;
  boxes: BoxDef[];
  models?: ModelDef[];
  decals?: DecalDef[];
  spawns: {
    T: Vec3[];
    CT: Vec3[];
  };
};

export type GameMode = 'team' | 'ffa';

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
  face?: string;
  primary?: WeaponType;
  preferredSide?: Side;
  matchMode?: GameMode;
  teamSize?: number;
  roomId?: string;
};

export type ClientBuy = {
  type: 'buy';
  primary: WeaponType;
};

export type ClientInput = {
  type: 'input';
  input: InputPayload;
};

export type ClientLeave = {
  type: 'leave';
};

export type ClientPlaceShit = {
  type: 'place_shit';
};

export type ClientPing = {
  type: 'ping';
};

export type ClientMessage = ClientJoin | ClientInput | ClientBuy | ClientLeave | ClientPlaceShit | ClientPing;

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
  explosiveGrenades: number;
  grenades: number;
  smokeGrenades: number;
  lastSeq: number;
  crouching: boolean;
  kills: number;
  deaths: number;
};

export type PlayerMeta = {
  id: string;
  name: string;
  face?: string;
};

export type RoomSummary = {
  id: string;
  name: string;
  mode: GameMode;
  teamSize: number;
  phase: RoundState['phase'];
  playerCount: number;
  capacity: number;
  players: PlayerMeta[];
};

export type GrenadeSnapshot = {
  id: string;
  pos: Vec3;
  vel: Vec3;
  ownerId: string;
  kind: 'explosive' | 'acid' | 'smoke';
};

export type GrenadePoolSnapshot = {
  id: string;
  pos: Vec3;
  ownerId: string;
  radius: number;
  life: number;
};

export type SmokeCloudSnapshot = {
  id: string;
  pos: Vec3;
  radius: number;
  life: number;
};

export type PlacedModelSnapshot = {
  id: string;
  path: string;
  pos: Vec3;
  rot?: Vec3;
  scale?: number | Vec3;
};

export type TrainingTargetSnapshot = {
  id: string;
  pos: Vec3;
  yaw: number;
  hp: number;
  alive: boolean;
};

export type RoundState = {
  round: number;
  phase: 'waiting' | 'freeze' | 'live' | 'post' | 'match_over';
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
  mode: GameMode;
  teamSize: number;
  neededPlayers: number;
  presentPlayers: number;
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
      type: 'shot';
      shooterId: string;
      weapon: WeaponType | 'pistol';
      origin: Vec3;
      dir: Vec3;
      distance: number;
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
      kind: 'explosive' | 'acid' | 'smoke';
    };

export type ServerSnapshot = {
  type: 'snapshot';
  now: number;
  players: PlayerSnapshot[];
  trainingTargets: TrainingTargetSnapshot[];
  grenades: GrenadeSnapshot[];
  grenadePools: GrenadePoolSnapshot[];
  smokeClouds: SmokeCloudSnapshot[];
  placedModels: PlacedModelSnapshot[];
  events: ServerEvent[];
  round: RoundState;
};

export type WelcomeMessage = {
  type: 'welcome';
  id: string;
  roomId: string;
  map: MapData;
  tickRate: number;
  playersMeta?: PlayerMeta[];
};

export type PlayerMetaMessage = {
  type: 'player_meta';
  player: PlayerMeta;
};

export type RoomListMessage = {
  type: 'room_list';
  rooms: RoomSummary[];
};

export type LobbyErrorMessage = {
  type: 'lobby_error';
  message: string;
};

export type PongMessage = {
  type: 'pong';
};

export type ServerMessage =
  | WelcomeMessage
  | ServerSnapshot
  | PlayerMetaMessage
  | RoomListMessage
  | LobbyErrorMessage
  | PongMessage;
