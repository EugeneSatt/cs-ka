import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  BoxDef,
  ClientJoin,
  ClientMessage,
  GameMode,
  InputPayload,
  LobbyErrorMessage,
  MapData,
  ModelDef,
  PlacedModelSnapshot,
  PlayerMeta,
  PlayerSnapshot,
  RoomSummary,
  RoundState,
  ServerEvent,
  TrainingTargetSnapshot,
  Vec3,
} from '../../shared/src/types';
import {
  BUY_WINDOW,
  CROUCH_EYE_HEIGHT,
  EYE_HEIGHT,
  FFA_ROUND_TIME,
  FREEZE_TIME,
  GRENADE_CONFIG,
  GRENADE_POOL_CONFIG,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  ROUND_TIME,
  SMOKE_GRENADE_CONFIG,
  SWAP_ROUND,
  TICK_RATE,
  TOTAL_ROUNDS,
  WEAPON_CONFIG,
} from '../../shared/src/constants';
import type { MatchTeam, Side, WeaponSlot, WeaponType } from '../../shared/src/constants';
import { clamp } from '../../shared/src/math';
import { collidesAt, isOnGround, movePlayer, resolvePenetration } from '../../shared/src/physics';
import { directionFromYawPitch, rayIntersectAABB } from '../../shared/src/ray';

const WEAPON_MODEL_KEYS = ['ak-47', 'aug', 'awp', 'spas_12', 'beretta'];
const MODEL_DEFAULTS: Array<{ keys: string[]; box: { min: Vec3; max: Vec3 } }> = [
  { keys: ['arm_chair', 'armchair', 'office_creslo', 'chair'], box: { min: [-0.5, 0, -0.5], max: [0.5, 1.2, 0.5] } },
  { keys: ['divan', 'sofa'], box: { min: [-1.2, 0, -0.6], max: [1.2, 1.0, 0.6] } },
  { keys: ['desk'], box: { min: [-1.0, 0, -0.8], max: [1.0, 1.1, 0.8] } },
  { keys: ['table'], box: { min: [-1.2, 0, -1.2], max: [1.2, 1.0, 1.2] } },
  { keys: ['computer'], box: { min: [-0.35, 0, -0.35], max: [0.35, 0.7, 0.35] } },
  { keys: ['tablet'], box: { min: [-0.25, 0, -0.2], max: [0.25, 0.2, 0.2] } },
  { keys: ['wardrobe', 'stenka', 'bookshkaf', 'books_cabinet'], box: { min: [-0.8, 0, -0.35], max: [0.8, 2.0, 0.35] } },
  {
    keys: ['whiteboard', 'bulletin_board', 'cork_board', 'investigation_board'],
    box: { min: [-0.7, 0, -0.05], max: [0.7, 1.2, 0.05] },
  },
  { keys: ['lavabo', 'toilet'], box: { min: [-0.45, 0, -0.45], max: [0.45, 0.9, 0.45] } },
  { keys: ['retro_tv', 'tv'], box: { min: [-0.35, 0, -0.2], max: [0.35, 0.6, 0.2] } },
  { keys: ['alex_mini'], box: { min: [-0.4, 0, -0.4], max: [0.4, 0.7, 0.4] } },
  { keys: ['black_label'], box: { min: [-0.2, 0, -0.2], max: [0.2, 0.5, 0.2] } },
];
const FALLBACK_MODEL_BOX: { min: Vec3; max: Vec3 } = { min: [-0.5, 0, -0.5], max: [0.5, 0.8, 0.5] };
const MAX_FACE_LENGTH = 180_000;
const MAX_PLAYERS_PER_ROOM = 8;
const ROOM_COUNT = 4;
const ROOM_LIST_INTERVAL_MS = 1000;
const CLIENT_HEARTBEAT_TIMEOUT_MS = 15_000;
const CLIENT_HEARTBEAT_SWEEP_MS = 3_000;
const SHIT_E_PATH = '/shit_e.glb';
const SHIT_E_SCALE = 0.35;
const SHIT_E_Y_OFFSET = 0.372;
const SHIT_E_PLACE_COOLDOWN = 0.25;
const MAX_PLACED_SHIT_E = 64;
const FFA_SPAWN_JITTER = 3.2;
const FFA_SPAWN_ATTEMPTS = 18;
const FFA_SPAWN_SAMPLE_STEP = 6;
const FFA_SPAWN_EDGE_MARGIN = 1.1;
const FFA_SPAWN_MERGE_DIST_SQ = 4;
const FFA_SPAWN_MAX_Y = 0.5;
const TRAINING_ROOM_ID = 'training-room';
const TRAINING_ROOM_NAME = 'Training Room';
const TRAINING_TARGET_HP = 100;
const TRAINING_TARGET_RESPAWN_TIME = 1.1;
const TRAINING_TARGET_HEIGHT = 1.92;
const TRAINING_TARGET_HALF_SPAN = 0.34;
const TRAINING_TARGET_HALF_THICKNESS = 0.08;

function modelCollider(model: ModelDef): { min: Vec3; max: Vec3 } | null {
  if (model.collider) {
    return model.collider;
  }
  const name = model.path.toLowerCase();
  if (WEAPON_MODEL_KEYS.some((key) => name.includes(key))) {
    return null;
  }
  for (const entry of MODEL_DEFAULTS) {
    if (entry.keys.some((key) => name.includes(key))) {
      return entry.box;
    }
  }
  return FALLBACK_MODEL_BOX;
}

function buildModelHitboxes(map: MapData): BoxDef[] {
  if (!map.models) {
    return [];
  }
  const extra: BoxDef[] = [];
  map.models.forEach((model, index) => {
    const base = modelCollider(model);
    if (!base) {
      return;
    }
    const scale = model.scale ?? 1;
    const scaleVec: Vec3 = Array.isArray(scale) ? scale : [scale, scale, scale];
    const localMin: Vec3 = [
      base.min[0] * scaleVec[0],
      base.min[1] * scaleVec[1],
      base.min[2] * scaleVec[2],
    ];
    const localMax: Vec3 = [
      base.max[0] * scaleVec[0],
      base.max[1] * scaleVec[1],
      base.max[2] * scaleVec[2],
    ];
    const corners: Vec3[] = [
      [localMin[0], localMin[1], localMin[2]],
      [localMin[0], localMin[1], localMax[2]],
      [localMin[0], localMax[1], localMin[2]],
      [localMin[0], localMax[1], localMax[2]],
      [localMax[0], localMin[1], localMin[2]],
      [localMax[0], localMin[1], localMax[2]],
      [localMax[0], localMax[1], localMin[2]],
      [localMax[0], localMax[1], localMax[2]],
    ];
    const rot = model.rot ?? [0, 0, 0];
    const cosX = Math.cos(rot[0]);
    const sinX = Math.sin(rot[0]);
    const cosY = Math.cos(rot[1]);
    const sinY = Math.sin(rot[1]);
    const cosZ = Math.cos(rot[2]);
    const sinZ = Math.sin(rot[2]);

    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const corner of corners) {
      let x = corner[0];
      let y = corner[1];
      let z = corner[2];
      if (rot[0] !== 0) {
        const y1 = y * cosX - z * sinX;
        const z1 = y * sinX + z * cosX;
        y = y1;
        z = z1;
      }
      if (rot[1] !== 0) {
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        x = x1;
        z = z1;
      }
      if (rot[2] !== 0) {
        const x1 = x * cosZ - y * sinZ;
        const y1 = x * sinZ + y * cosZ;
        x = x1;
        y = y1;
      }
      x += model.pos[0];
      y += model.pos[1];
      z += model.pos[2];
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
      max[2] = Math.max(max[2], z);
    }
    extra.push({
      min,
      max,
      color: '#888888',
      type: 'collider_model',
      id: `model_${model.path}_${index}`,
    });
  });
  return extra;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const mapFile = process.env.MAP ?? 'arena.json';
const mapPath = resolve(__dirname, '../../shared/maps', mapFile);
const rawMap = JSON.parse(readFileSync(mapPath, 'utf8')) as MapData;
const mapData = rawMap;
void buildModelHitboxes;

function buildAxisSamples(min: number, max: number, step: number): number[] {
  if (max <= min) {
    return [(min + max) * 0.5];
  }
  if (max - min <= step * 1.2) {
    return [(min + max) * 0.5];
  }
  const values: number[] = [];
  for (let value = min; value <= max; value += step) {
    values.push(value);
  }
  if (values.length === 0) {
    values.push((min + max) * 0.5);
  } else {
    const last = values[values.length - 1];
    if (max - last > step * 0.35) {
      values.push(max);
    }
  }
  return values;
}

function buildFfaSpawnAnchors(map: MapData): SpawnAnchor[] {
  const anchors: SpawnAnchor[] = [];
  for (const box of map.boxes) {
    if (box.type !== 'floor') {
      continue;
    }
    if (box.max[1] > FFA_SPAWN_MAX_Y) {
      continue;
    }
    const width = box.max[0] - box.min[0];
    const depth = box.max[2] - box.min[2];
    if (width < PLAYER_RADIUS * 2 + 0.4 || depth < PLAYER_RADIUS * 2 + 0.4) {
      continue;
    }

    const margin = Math.min(FFA_SPAWN_EDGE_MARGIN, Math.max(0.55, Math.min(width, depth) * 0.18));
    const minX = box.min[0] + margin;
    const maxX = box.max[0] - margin;
    const minZ = box.min[2] + margin;
    const maxZ = box.max[2] - margin;
    const xs = buildAxisSamples(minX, maxX, FFA_SPAWN_SAMPLE_STEP);
    const zs = buildAxisSamples(minZ, maxZ, FFA_SPAWN_SAMPLE_STEP);
    for (const x of xs) {
      for (const z of zs) {
        const candidate = resolvePenetration([x, box.max[1], z], map);
        if (collidesAt(candidate, map)) {
          continue;
        }
        if (
          anchors.some(
            (anchor) =>
              Math.abs(anchor.level - candidate[1]) < 0.25 &&
              (anchor.pos[0] - candidate[0]) * (anchor.pos[0] - candidate[0]) +
                (anchor.pos[2] - candidate[2]) * (anchor.pos[2] - candidate[2]) <
                FFA_SPAWN_MERGE_DIST_SQ
          )
        ) {
          continue;
        }
        anchors.push({
          pos: candidate,
          level: box.max[1],
          sourceId: box.id,
        });
      }
    }
  }
  return anchors;
}

type TrainingTargetPlacement = {
  id: string;
  center: Vec3;
  plane: 'x' | 'z';
};

const TRAINING_TARGETS: TrainingTargetPlacement[] = [
  { id: 'west_supply', center: [-19.0, 0, 19.0], plane: 'z' },
  { id: 'west_corridor', center: [-11.2, 0, 4.4], plane: 'x' },
  { id: 'cosmetics', center: [2.1, 0, -0.2], plane: 'z' },
  { id: 'center_open', center: [8.0, 0, 20.8], plane: 'z' },
  { id: 'east_open', center: [21.8, 0, 16.4], plane: 'x' },
  { id: 'upper_mid', center: [3.8, 3.3, 15.7], plane: 'z' },
  { id: 'upper_west', center: [-17.8, 3.3, 20.8], plane: 'z' },
  { id: 'upper_east', center: [23.8, 3.3, 20.25], plane: 'z' },
];

function buildTrainingMap(baseMap: MapData): MapData {
  return {
    ...baseMap,
    name: `${baseMap.name} Training`,
  };
}

function yawForTrainingPlane(plane: 'x' | 'z'): number {
  return plane === 'x' ? Math.PI * 0.5 : 0;
}

const trainingMapData = buildTrainingMap(mapData);

type TrainingTarget = {
  id: string;
  pos: Vec3;
  yaw: number;
  plane: 'x' | 'z';
  hp: number;
  alive: boolean;
  respawnAt: number;
};

function buildTrainingTargets(placements: TrainingTargetPlacement[]): TrainingTarget[] {
  return placements.map((placement) => ({
    id: `training-${placement.id}`,
    pos: [...placement.center],
    yaw: yawForTrainingPlane(placement.plane),
    plane: placement.plane,
    hp: TRAINING_TARGET_HP,
    alive: true,
    respawnAt: Infinity,
  }));
}

const PORT = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port: PORT });

type Player = {
  id: string;
  ws: WebSocket;
  name: string;
  face?: string;
  matchTeam: MatchTeam;
  primary: WeaponType;
  preferredSide?: Side;
  weapon: WeaponSlot;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  onGround: boolean;
  ammoPrimary: number;
  ammoPistol: number;
  explosiveGrenades: number;
  grenades: number;
  smokeGrenades: number;
  lastSeq: number;
  inputQueue: InputPayload[];
  nextFireTime: number;
  reloadEndTime: number;
  reloading: WeaponSlot | null;
  pendingSpawn: boolean;
  crouching: boolean;
  buyLocked: boolean;
  buyChoice: WeaponType | null;
  kills: number;
  deaths: number;
  respawnAt: number;
  nextPlaceTime: number;
};

type Grenade = {
  id: string;
  pos: Vec3;
  vel: Vec3;
  ownerId: string;
  kind: 'explosive' | 'acid' | 'smoke';
  explodeAt: number;
};

type GrenadePool = {
  id: string;
  pos: Vec3;
  ownerId: string;
  createdAt: number;
  expireAt: number;
  nextDamageAt: number;
};

type SmokeCloud = {
  id: string;
  pos: Vec3;
  createdAt: number;
  expireAt: number;
};

type PlacedModel = PlacedModelSnapshot & {
  ownerId: string;
};

type SpawnAnchor = {
  pos: Vec3;
  level: number;
  sourceId?: string;
};

type ConnectionState = {
  ws: WebSocket;
  playerId: string | null;
  roomId: string | null;
  lastHeardAt: number;
};

type JoinResult =
  | { ok: true; player: Player }
  | { ok: false; error: string };

type RoomController = {
  id: string;
  name: string;
  join(ws: WebSocket, message: ClientJoin): JoinResult;
  handleInput(playerId: string, input: InputPayload): void;
  handleBuy(playerId: string, primary: WeaponType): void;
  handlePlaceShit(playerId: string): void;
  leave(playerId: string): void;
  tick(): void;
  getSummary(): RoomSummary;
  sendWelcome(player: Player): void;
  broadcastPlayerMeta(player: Player): void;
};

type RoomConfig = {
  map: MapData;
  fixedMode?: GameMode;
  minPlayers?: number;
  defaultTeamSize?: number;
  capacity?: number;
  trainingTargets?: TrainingTargetPlacement[];
  throwableLoadout?: {
    explosiveGrenades?: number;
    grenades?: number;
    smokeGrenades?: number;
  };
};

let nextPlayerId = 1;
let nextGrenadeId = 1;
const connections = new Set<ConnectionState>();

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
}

function sendLobbyError(ws: WebSocket, message: string) {
  const payload: LobbyErrorMessage = { type: 'lobby_error', message };
  sendJson(ws, payload);
}

function createRoom(id: string, name: string, config: RoomConfig): RoomController {
  const mapData = config.map;
  const ffaSpawnAnchors = buildFfaSpawnAnchors(mapData);
  const fixedMode = config.fixedMode;
  const requiredPlayerCount = Math.max(1, Math.floor(config.minPlayers ?? 2));
  const defaultTeamSize = clamp(Math.floor(config.defaultTeamSize ?? 4), 1, 4);
  const trainingTargets = buildTrainingTargets(config.trainingTargets ?? []);
  const throwableLoadout = {
    explosiveGrenades: Math.max(0, Math.floor(config.throwableLoadout?.explosiveGrenades ?? 1)),
    grenades: Math.max(0, Math.floor(config.throwableLoadout?.grenades ?? 1)),
    smokeGrenades: Math.max(0, Math.floor(config.throwableLoadout?.smokeGrenades ?? 1)),
  };
  const players = new Map<string, Player>();
  const grenades: Grenade[] = [];
  const grenadePools: GrenadePool[] = [];
  const smokeClouds: SmokeCloud[] = [];
  const placedModels: PlacedModel[] = [];

  let gameTime = 0;
  let round = 1;
  let phase: RoundState['phase'] = 'waiting';
  let freezeLeft = FREEZE_TIME;
  let timeLeft = ROUND_TIME;
  let postLeft = 0;
  const scores = { A: 0, B: 0 };
  let pendingEvents: ServerEvent[] = [];
  let matchOverAnnounced = false;
  let gameMode: GameMode = fixedMode ?? 'team';
  let teamSizeConfig = gameMode === 'team' ? defaultTeamSize : 4;

  function sideByTeam(currentRound: number): { A: Side; B: Side } {
    if (gameMode === 'ffa') {
      return { A: 'T', B: 'CT' };
    }
    if (currentRound < SWAP_ROUND) {
      return { A: 'T', B: 'CT' };
    }
    return { A: 'CT', B: 'T' };
  }

  function teamForSide(side: Side, currentRound: number): MatchTeam {
    const sides = sideByTeam(currentRound);
    return sides.A === side ? 'A' : 'B';
  }

  function roomCapacity(): number {
    return gameMode === 'ffa' ? MAX_PLAYERS_PER_ROOM : teamSizeConfig * 2;
  }

  function applyPrimary(player: Player, primary: WeaponType) {
    player.primary = primary;
    player.weapon = 'primary';
    player.ammoPrimary = WEAPON_CONFIG[primary].magSize;
    player.nextFireTime = 0;
    player.reloadEndTime = 0;
    player.reloading = null;
    player.buyLocked = true;
    player.buyChoice = primary;
  }

  function playerSide(player: Player): Side {
    const sides = sideByTeam(round);
    return player.matchTeam === 'A' ? sides.A : sides.B;
  }

  function roundElapsed(): number {
    if (phase === 'freeze') {
      return Math.max(0, FREEZE_TIME - freezeLeft);
    }
    if (phase === 'live') {
      const base = gameMode === 'team' ? FREEZE_TIME : 0;
      const duration = gameMode === 'team' ? ROUND_TIME : FFA_ROUND_TIME;
      return base + Math.max(0, duration - timeLeft);
    }
    const duration = gameMode === 'team' ? ROUND_TIME : FFA_ROUND_TIME;
    return (gameMode === 'team' ? FREEZE_TIME : 0) + duration;
  }

  function requiredPlayers(): number {
    return requiredPlayerCount;
  }

  function resetTrainingTargets() {
    for (const target of trainingTargets) {
      target.hp = TRAINING_TARGET_HP;
      target.alive = true;
      target.respawnAt = Infinity;
    }
  }

  function readyToStart(): boolean {
    if (players.size < requiredPlayers()) {
      return false;
    }
    if (gameMode === 'team') {
      return countSidePlayers('T') > 0 && countSidePlayers('CT') > 0;
    }
    return true;
  }

  function isSpawnFree(pos: Vec3, ignoreId?: string): boolean {
    for (const player of players.values()) {
      if (!player.alive || player.id === ignoreId) {
        continue;
      }
      const dx = player.pos[0] - pos[0];
      const dz = player.pos[2] - pos[2];
      if (dx * dx + dz * dz < 9) {
        return false;
      }
    }
    return true;
  }

  function stabilizeSpawn(pos: Vec3, ignoreId?: string): Vec3 | null {
    const resolved = resolvePenetration([pos[0], pos[1], pos[2]], mapData);
    if (collidesAt(resolved, mapData)) {
      return null;
    }
    if (!isSpawnFree(resolved, ignoreId)) {
      return null;
    }
    return resolved;
  }

  function tryPickSpawnCandidate(options: Vec3[], ignoreId?: string): Vec3 | null {
    if (!options.length) {
      return null;
    }
    for (let attempt = 0; attempt < FFA_SPAWN_ATTEMPTS; attempt += 1) {
      const base = options[Math.floor(Math.random() * options.length)];
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * FFA_SPAWN_JITTER;
      const candidate: Vec3 = [
        base[0] + Math.cos(angle) * radius,
        base[1],
        base[2] + Math.sin(angle) * radius,
      ];
      const resolved = stabilizeSpawn(candidate, ignoreId);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  function getFfaSpawnScore(pos: Vec3, ignoreId?: string): number {
    let nearest = Infinity;
    for (const player of players.values()) {
      if (!player.alive || player.id === ignoreId) {
        continue;
      }
      const dx = player.pos[0] - pos[0];
      const dy = player.pos[1] - pos[1];
      const dz = player.pos[2] - pos[2];
      const distSq = dx * dx + dz * dz + dy * dy * 1.8;
      if (distSq < nearest) {
        nearest = distSq;
      }
    }
    if (nearest === Infinity) {
      return Math.random();
    }
    return nearest + Math.random() * 0.01;
  }

  function pickBestFfaSpawn(ignoreId?: string): Vec3 | null {
    if (!ffaSpawnAnchors.length) {
      return null;
    }
    let best: Vec3 | null = null;
    let bestScore = -Infinity;
    for (const anchor of ffaSpawnAnchors) {
      const resolved = stabilizeSpawn(anchor.pos, ignoreId);
      if (!resolved) {
        continue;
      }
      const score = getFfaSpawnScore(resolved, ignoreId);
      if (score > bestScore) {
        bestScore = score;
        best = resolved;
      }
    }
    return best;
  }

  function pickSpawn(side: Side | 'any', ignoreId?: string): Vec3 {
    const baseOptions = side === 'any' ? [...mapData.spawns.T, ...mapData.spawns.CT] : mapData.spawns[side];
    if (side === 'any') {
      const bestAnchor = pickBestFfaSpawn(ignoreId);
      if (bestAnchor) {
        return bestAnchor;
      }
    }
    if (!baseOptions || baseOptions.length === 0) {
      return [0, 0.1, 0];
    }
    if (side === 'any') {
      const candidate = tryPickSpawnCandidate(baseOptions, ignoreId);
      if (candidate) {
        return candidate;
      }
    }
    const shuffled = [...baseOptions].sort(() => Math.random() - 0.5);
    for (const spawn of shuffled) {
      const candidate: Vec3 = [spawn[0], spawn[1], spawn[2]];
      const resolved = stabilizeSpawn(candidate, ignoreId);
      if (resolved) {
        return resolved;
      }
    }
    const expanded = tryPickSpawnCandidate(shuffled, ignoreId);
    if (expanded) {
      return expanded;
    }
    const fallback = shuffled[0];
    return resolvePenetration([fallback[0], fallback[1], fallback[2]], mapData);
  }

  function inBuyWindow(): boolean {
    if (phase !== 'freeze' && phase !== 'live') {
      return false;
    }
    if (gameMode === 'ffa') {
      return true;
    }
    return roundElapsed() <= BUY_WINDOW;
  }

  function applyDefaultBuys() {
    if (!inBuyWindow()) {
      for (const player of players.values()) {
        if (!player.buyLocked) {
          applyPrimary(player, 'rifle');
        }
      }
    }
  }

  function spawnPlayer(player: Player) {
    const spawnSide: Side | 'any' = gameMode === 'ffa' ? 'any' : playerSide(player);
    player.pos = pickSpawn(spawnSide, player.id);
    player.vel = [0, 0, 0];
    player.hp = 100;
    player.alive = true;
    player.onGround = isOnGround(player.pos, mapData);
    player.weapon = 'primary';
    player.ammoPrimary = WEAPON_CONFIG[player.primary].magSize;
    player.ammoPistol = WEAPON_CONFIG.pistol.magSize;
    player.explosiveGrenades = throwableLoadout.explosiveGrenades;
    player.grenades = throwableLoadout.grenades;
    player.smokeGrenades = throwableLoadout.smokeGrenades;
    player.nextFireTime = 0;
    player.reloadEndTime = 0;
    player.reloading = null;
    player.pendingSpawn = false;
    player.crouching = false;
    player.buyLocked = false;
    player.buyChoice = null;
    player.respawnAt = Infinity;
    player.nextPlaceTime = 0;
  }

  function startRound() {
    matchOverAnnounced = false;
    phase = gameMode === 'team' ? 'freeze' : 'live';
    freezeLeft = gameMode === 'team' ? FREEZE_TIME : 0;
    timeLeft = gameMode === 'team' ? ROUND_TIME : FFA_ROUND_TIME;
    postLeft = 0;
    grenades.length = 0;
    grenadePools.length = 0;
    smokeClouds.length = 0;
    placedModels.length = 0;
    resetTrainingTargets();

    const resetStats = round === 1;
    if (resetStats) {
      scores.A = 0;
      scores.B = 0;
    }
    for (const player of players.values()) {
      if (resetStats) {
        player.kills = 0;
        player.deaths = 0;
      }
      player.primary = 'rifle';
      spawnPlayer(player);
    }

    pendingEvents.push({
      type: 'round_start',
      round,
      sideByTeam: sideByTeam(round),
    });
  }

  function getKillLeaders(): Array<{ id: string; name: string; kills: number }> {
    let maxKills = -1;
    const leaders: Array<{ id: string; name: string; kills: number }> = [];
    for (const player of players.values()) {
      if (player.kills > maxKills) {
        maxKills = player.kills;
        leaders.length = 0;
        leaders.push({ id: player.id, name: player.name, kills: player.kills });
      } else if (player.kills === maxKills) {
        leaders.push({ id: player.id, name: player.name, kills: player.kills });
      }
    }
    return leaders;
  }

  function resetRoomState() {
    grenades.length = 0;
    grenadePools.length = 0;
    smokeClouds.length = 0;
    placedModels.length = 0;
    resetTrainingTargets();
    round = 1;
    phase = 'waiting';
    freezeLeft = FREEZE_TIME;
    timeLeft = ROUND_TIME;
    postLeft = 0;
    scores.A = 0;
    scores.B = 0;
    pendingEvents = [];
    matchOverAnnounced = false;
    gameMode = fixedMode ?? 'team';
    teamSizeConfig = gameMode === 'team' ? defaultTeamSize : 4;
    freezeLeft = gameMode === 'team' ? FREEZE_TIME : 0;
    timeLeft = gameMode === 'team' ? ROUND_TIME : FFA_ROUND_TIME;
  }

  function enterMatchOver() {
    if (matchOverAnnounced) {
      return;
    }
    matchOverAnnounced = true;
    phase = 'match_over';
    pendingEvents.push({
      type: 'match_over',
      reason: 'kills',
      winners: getKillLeaders(),
    });
    round = 1;
    freezeLeft = 0;
    timeLeft = 0;
    postLeft = 0;
    phase = 'waiting';
    grenades.length = 0;
    grenadePools.length = 0;
    smokeClouds.length = 0;
    placedModels.length = 0;
    for (const player of players.values()) {
      player.alive = false;
      player.pendingSpawn = false;
      player.respawnAt = Infinity;
      player.inputQueue.length = 0;
    }
  }

  function endRound(winnerSide: Side, reason: 'elimination' | 'time') {
    const winningTeam = teamForSide(winnerSide, round);
    scores[winningTeam] += 1;
    pendingEvents.push({
      type: 'round_end',
      winnerSide,
      winnerTeam: winningTeam,
      reason,
    });
    round += 1;
    if (round > TOTAL_ROUNDS) {
      enterMatchOver();
      return;
    }
    startRound();
  }

  function endRoundDraw(reason: 'time' | 'survivors') {
    pendingEvents.push({ type: 'round_draw', reason });
    grenades.length = 0;
    grenadePools.length = 0;
    smokeClouds.length = 0;
    placedModels.length = 0;
    round += 1;
    if (round > TOTAL_ROUNDS) {
      enterMatchOver();
      return;
    }
    phase = 'post';
    postLeft = 5;
  }

  function countAlive(side: Side): number {
    let count = 0;
    for (const player of players.values()) {
      if (player.alive && playerSide(player) === side) {
        count += 1;
      }
    }
    return count;
  }

  function countSidePlayers(side: Side): number {
    let count = 0;
    for (const player of players.values()) {
      if (playerSide(player) === side) {
        count += 1;
      }
    }
    return count;
  }

  function updateRound(dt: number) {
    if (phase === 'waiting') {
      if (readyToStart()) {
        startRound();
      }
      return;
    }
    if (phase === 'match_over') {
      return;
    }
    if (phase === 'post') {
      postLeft -= dt;
      if (postLeft <= 0) {
        startRound();
      }
      return;
    }
    if (phase === 'freeze') {
      freezeLeft -= dt;
      if (freezeLeft <= 0) {
        phase = 'live';
      }
      return;
    }

    timeLeft -= dt;
    if (timeLeft <= 0) {
      if (gameMode === 'team') {
        const aliveT = countAlive('T');
        const aliveCT = countAlive('CT');
        if (aliveT > 0 && aliveCT > 0) {
          endRoundDraw('time');
        } else if (aliveCT > 0) {
          endRound('CT', 'time');
        } else if (aliveT > 0) {
          endRound('T', 'time');
        } else {
          endRoundDraw('survivors');
        }
      } else {
        enterMatchOver();
      }
      return;
    }

    if (gameMode === 'team') {
      const aliveT = countAlive('T');
      const aliveCT = countAlive('CT');
      const presentT = countSidePlayers('T');
      const presentCT = countSidePlayers('CT');
      if (presentT > 0 && presentCT > 0) {
        if (aliveT === 0 && aliveCT > 0) {
          endRound('CT', 'elimination');
        } else if (aliveCT === 0 && aliveT > 0) {
          endRound('T', 'elimination');
        }
      }
    }
  }

  function updateReloads() {
    for (const player of players.values()) {
      if (!player.reloading || gameTime < player.reloadEndTime) {
        continue;
      }
      const slot = player.reloading;
      if (slot === 'primary') {
        player.ammoPrimary = WEAPON_CONFIG[player.primary].magSize;
      } else if (slot === 'pistol') {
        player.ammoPistol = WEAPON_CONFIG.pistol.magSize;
      }
      player.reloading = null;
    }
  }

  function grenadeCollides(pos: Vec3): boolean {
    const radius = 0.2;
    const min: Vec3 = [pos[0] - radius, pos[1] - radius, pos[2] - radius];
    const max: Vec3 = [pos[0] + radius, pos[1] + radius, pos[2] + radius];
    for (const box of mapData.boxes) {
      if (
        min[0] <= box.max[0] &&
        max[0] >= box.min[0] &&
        min[1] <= box.max[1] &&
        max[1] >= box.min[1] &&
        min[2] <= box.max[2] &&
        max[2] >= box.min[2]
      ) {
        return true;
      }
    }
    return false;
  }

  function grenadeOnGround(pos: Vec3): boolean {
    return grenadeCollides([pos[0], pos[1] - 0.06, pos[2]]);
  }

  function moveGrenadeAxis(pos: Vec3, vel: Vec3, axis: 0 | 1 | 2, dt: number): Vec3 {
    const next: Vec3 = [pos[0], pos[1], pos[2]];
    next[axis] += vel[axis] * dt;
    if (!grenadeCollides(next)) {
      return next;
    }
    vel[axis] = -vel[axis] * GRENADE_CONFIG.bounce;
    if (axis === 1) {
      vel[0] *= GRENADE_CONFIG.floorBounceCarry;
      vel[2] *= GRENADE_CONFIG.floorBounceCarry;
      if (Math.abs(vel[1]) < GRENADE_CONFIG.minBounceSpeed) {
        vel[1] = 0;
        vel[0] = 0;
        vel[2] = 0;
      }
      if (Math.hypot(vel[0], vel[2]) < GRENADE_CONFIG.stopSpeed) {
        vel[0] = 0;
        vel[2] = 0;
      }
    } else if (Math.abs(vel[axis]) < GRENADE_CONFIG.stopSpeed) {
      vel[axis] = 0;
    }
    return pos;
  }

  function moveGrenade(pos: Vec3, vel: Vec3, dt: number): { pos: Vec3; vel: Vec3 } {
    let next: Vec3 = [pos[0], pos[1], pos[2]];
    const maxSpeed = Math.max(Math.abs(vel[0]), Math.abs(vel[1]), Math.abs(vel[2]));
    const steps = Math.max(1, Math.min(6, Math.ceil((maxSpeed * dt) / 0.2)));
    const stepDt = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      next = moveGrenadeAxis(next, vel, 0, stepDt);
      next = moveGrenadeAxis(next, vel, 1, stepDt);
      next = moveGrenadeAxis(next, vel, 2, stepDt);
    }
    return { pos: next, vel };
  }

  function playerSideById(playerId: string): Side {
    const player = players.get(playerId);
    return player ? playerSide(player) : 'T';
  }

  function grenadeDamageDistance(player: Player, pos: Vec3): number {
    const height = player.crouching ? PLAYER_HEIGHT * 0.6 : PLAYER_HEIGHT;
    const closestX = clamp(pos[0], player.pos[0] - PLAYER_RADIUS, player.pos[0] + PLAYER_RADIUS);
    const closestY = clamp(pos[1], player.pos[1], player.pos[1] + height);
    const closestZ = clamp(pos[2], player.pos[2] - PLAYER_RADIUS, player.pos[2] + PLAYER_RADIUS);
    return Math.hypot(closestX - pos[0], closestY - pos[1], closestZ - pos[2]);
  }

  function projectGrenadePoolPos(pos: Vec3): Vec3 {
    let surfaceY = Number.NEGATIVE_INFINITY;
    for (const box of mapData.boxes) {
      if (pos[0] < box.min[0] || pos[0] > box.max[0] || pos[2] < box.min[2] || pos[2] > box.max[2]) {
        continue;
      }
      if (box.max[1] <= pos[1] + 0.25 && box.max[1] > surfaceY) {
        surfaceY = box.max[1];
      }
    }
    return [pos[0], (surfaceY === Number.NEGATIVE_INFINITY ? pos[1] : surfaceY) + 0.03, pos[2]];
  }

  function projectSmokeCloudPos(pos: Vec3): Vec3 {
    const floorY = findFloorYAt(pos[0], pos[2], pos[1] + 0.25);
    return [pos[0], floorY + 1.15, pos[2]];
  }

  function findFloorYAt(x: number, z: number, maxY: number): number {
    let surfaceY = Number.NEGATIVE_INFINITY;
    for (const box of mapData.boxes) {
      if (x < box.min[0] || x > box.max[0] || z < box.min[2] || z > box.max[2]) {
        continue;
      }
      if (box.max[1] <= maxY && box.max[1] > surfaceY) {
        surfaceY = box.max[1];
      }
    }
    return surfaceY === Number.NEGATIVE_INFINITY ? maxY : surfaceY;
  }

  function grenadePoolRadius(pool: GrenadePool): number {
    const spreadT = clamp((gameTime - pool.createdAt) / GRENADE_POOL_CONFIG.spreadTime, 0, 1);
    const easedSpread = 1 - (1 - spreadT) * (1 - spreadT);
    return GRENADE_POOL_CONFIG.maxRadius * easedSpread;
  }

  function smokeCloudRadius(cloud: SmokeCloud): number {
    const spreadT = clamp((gameTime - cloud.createdAt) / SMOKE_GRENADE_CONFIG.spreadTime, 0, 1);
    const easedSpread = 1 - (1 - spreadT) * (1 - spreadT);
    return SMOKE_GRENADE_CONFIG.maxRadius * easedSpread;
  }

  function grenadePoolDamageDistance(player: Player, pos: Vec3): number {
    if (Math.abs(player.pos[1] - pos[1]) > 0.45) {
      return Infinity;
    }
    const closestX = clamp(pos[0], player.pos[0] - PLAYER_RADIUS, player.pos[0] + PLAYER_RADIUS);
    const closestZ = clamp(pos[2], player.pos[2] - PLAYER_RADIUS, player.pos[2] + PLAYER_RADIUS);
    return Math.hypot(closestX - pos[0], closestZ - pos[2]);
  }

  function grenadeDamageDistanceToTarget(target: TrainingTarget, pos: Vec3): number {
    const halfX = target.plane === 'x' ? TRAINING_TARGET_HALF_THICKNESS : TRAINING_TARGET_HALF_SPAN;
    const halfZ = target.plane === 'x' ? TRAINING_TARGET_HALF_SPAN : TRAINING_TARGET_HALF_THICKNESS;
    const closestX = clamp(pos[0], target.pos[0] - halfX, target.pos[0] + halfX);
    const closestY = clamp(pos[1], target.pos[1], target.pos[1] + TRAINING_TARGET_HEIGHT);
    const closestZ = clamp(pos[2], target.pos[2] - halfZ, target.pos[2] + halfZ);
    return Math.hypot(closestX - pos[0], closestY - pos[1], closestZ - pos[2]);
  }

  function grenadePoolDamageDistanceToTarget(target: TrainingTarget, pos: Vec3): number {
    if (Math.abs(target.pos[1] - pos[1]) > 0.45) {
      return Infinity;
    }
    const halfX = target.plane === 'x' ? TRAINING_TARGET_HALF_THICKNESS : TRAINING_TARGET_HALF_SPAN;
    const halfZ = target.plane === 'x' ? TRAINING_TARGET_HALF_SPAN : TRAINING_TARGET_HALF_THICKNESS;
    const closestX = clamp(pos[0], target.pos[0] - halfX, target.pos[0] + halfX);
    const closestZ = clamp(pos[2], target.pos[2] - halfZ, target.pos[2] + halfZ);
    return Math.hypot(closestX - pos[0], closestZ - pos[2]);
  }

  function applyDamage(target: Player, attackerId: string, damage: number, weapon: WeaponSlot | WeaponType) {
    target.hp = Math.max(0, target.hp - damage);
    pendingEvents.push({
      type: 'hit',
      attackerId,
      victimId: target.id,
      damage,
      remainingHp: target.hp,
    });
    if (target.hp > 0) {
      return;
    }
    target.alive = false;
    target.deaths += 1;
    if (gameMode === 'ffa') {
      target.respawnAt = gameTime + 1.2;
    }
    const attacker = players.get(attackerId);
    if (attacker) {
      attacker.kills += 1;
    }
    pendingEvents.push({
      type: 'kill',
      attackerId,
      victimId: target.id,
      weapon,
    });
  }

  function applyTrainingTargetDamage(
    target: TrainingTarget,
    attackerId: string,
    damage: number,
    weapon: WeaponSlot | WeaponType
  ) {
    target.hp = Math.max(0, target.hp - damage);
    pendingEvents.push({
      type: 'hit',
      attackerId,
      victimId: target.id,
      damage,
      remainingHp: target.hp,
    });
    if (target.hp > 0) {
      return;
    }
    target.alive = false;
    target.respawnAt = gameTime + TRAINING_TARGET_RESPAWN_TIME;
    const attacker = players.get(attackerId);
    if (attacker) {
      attacker.kills += 1;
    }
    pendingEvents.push({
      type: 'kill',
      attackerId,
      victimId: target.id,
      weapon,
    });
  }

  function applyExplosiveGrenadeDamage(grenade: Grenade) {
    for (const player of players.values()) {
      if (!player.alive) {
        continue;
      }
      if (gameMode === 'team' && player.id !== grenade.ownerId && playerSide(player) === playerSideById(grenade.ownerId)) {
        continue;
      }
      const dist = grenadeDamageDistance(player, grenade.pos);
      if (dist > GRENADE_CONFIG.radius) {
        continue;
      }
      const damage = Math.max(0, Math.ceil(GRENADE_CONFIG.maxDamage * (1 - dist / GRENADE_CONFIG.radius)));
      if (damage > 0) {
        applyDamage(player, grenade.ownerId, damage, 'explosive');
      }
    }
    for (const target of trainingTargets) {
      if (!target.alive) {
        continue;
      }
      const dist = grenadeDamageDistanceToTarget(target, grenade.pos);
      if (dist > GRENADE_CONFIG.radius) {
        continue;
      }
      const damage = Math.max(0, Math.ceil(GRENADE_CONFIG.maxDamage * (1 - dist / GRENADE_CONFIG.radius)));
      if (damage > 0) {
        applyTrainingTargetDamage(target, grenade.ownerId, damage, 'explosive');
      }
    }
  }

  function explodeGrenade(grenade: Grenade) {
    pendingEvents.push({
      type: 'grenade_explode',
      pos: grenade.pos,
      ownerId: grenade.ownerId,
      kind: grenade.kind,
    });
    if (grenade.kind === 'smoke') {
      smokeClouds.push({
        id: `${grenade.id}-smoke`,
        pos: projectSmokeCloudPos(grenade.pos),
        createdAt: gameTime,
        expireAt: gameTime + SMOKE_GRENADE_CONFIG.duration,
      });
      return;
    }
    if (grenade.kind === 'explosive') {
      applyExplosiveGrenadeDamage(grenade);
      return;
    }
    grenadePools.push({
      id: `${grenade.id}-pool`,
      pos: projectGrenadePoolPos(grenade.pos),
      ownerId: grenade.ownerId,
      createdAt: gameTime,
      expireAt: gameTime + GRENADE_POOL_CONFIG.duration,
      nextDamageAt: gameTime + GRENADE_POOL_CONFIG.damageInterval * 0.5,
    });
  }

  function updateGrenadePools() {
    for (let i = grenadePools.length - 1; i >= 0; i -= 1) {
      const pool = grenadePools[i];
      if (gameTime >= pool.expireAt) {
        grenadePools.splice(i, 1);
        continue;
      }

      const radius = grenadePoolRadius(pool);
      if (radius <= 0.05 || gameTime + 1e-6 < pool.nextDamageAt) {
        continue;
      }

      while (gameTime + 1e-6 >= pool.nextDamageAt) {
        pool.nextDamageAt += GRENADE_POOL_CONFIG.damageInterval;
        for (const player of players.values()) {
          if (!player.alive) {
            continue;
          }
          if (
            gameMode === 'team' &&
            player.id !== pool.ownerId &&
            playerSide(player) === playerSideById(pool.ownerId)
          ) {
            continue;
          }
          const dist = grenadePoolDamageDistance(player, pool.pos);
          if (dist > radius) {
            continue;
          }
          const falloff = 1 - dist / radius;
          const damage = Math.max(1, Math.ceil(GRENADE_POOL_CONFIG.maxDamagePerTick * falloff));
          applyDamage(player, pool.ownerId, damage, 'grenade');
        }
        for (const target of trainingTargets) {
          if (!target.alive) {
            continue;
          }
          const dist = grenadePoolDamageDistanceToTarget(target, pool.pos);
          if (dist > radius) {
            continue;
          }
          const falloff = 1 - dist / radius;
          const damage = Math.max(1, Math.ceil(GRENADE_POOL_CONFIG.maxDamagePerTick * falloff));
          applyTrainingTargetDamage(target, pool.ownerId, damage, 'grenade');
        }
      }
    }
  }

  function updateSmokeClouds() {
    for (let i = smokeClouds.length - 1; i >= 0; i -= 1) {
      if (gameTime >= smokeClouds[i].expireAt) {
        smokeClouds.splice(i, 1);
      }
    }
  }

  function updateTrainingTargetRespawns() {
    for (const target of trainingTargets) {
      if (target.alive || gameTime < target.respawnAt) {
        continue;
      }
      target.hp = TRAINING_TARGET_HP;
      target.alive = true;
      target.respawnAt = Infinity;
    }
  }

  function updateGrenades(dt: number) {
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const grenade = grenades[i];
      grenade.vel[1] -= dt * GRENADE_CONFIG.gravity;
      if (grenadeOnGround(grenade.pos) && Math.abs(grenade.vel[1]) < GRENADE_CONFIG.minBounceSpeed) {
        grenade.vel[0] = 0;
        grenade.vel[1] = 0;
        grenade.vel[2] = 0;
      }
      const moved = moveGrenade(grenade.pos, grenade.vel, dt);
      grenade.pos = moved.pos;
      grenade.vel = moved.vel;
      if (gameTime >= grenade.explodeAt) {
        explodeGrenade(grenade);
        grenades.splice(i, 1);
      }
    }
  }

  function tryStartReload(player: Player) {
    if (player.reloading || player.weapon === 'explosive' || player.weapon === 'grenade' || player.weapon === 'smoke') {
      return;
    }
    const slot = player.weapon === 'primary' ? 'primary' : 'pistol';
    if (slot === 'primary') {
      const maxAmmo = WEAPON_CONFIG[player.primary].magSize;
      if (player.ammoPrimary >= maxAmmo) {
        return;
      }
      player.reloadEndTime = gameTime + WEAPON_CONFIG[player.primary].reloadTime;
      player.reloading = slot;
      return;
    }
    const maxAmmo = WEAPON_CONFIG.pistol.magSize;
    if (player.ammoPistol >= maxAmmo) {
      return;
    }
    player.reloadEndTime = gameTime + WEAPON_CONFIG.pistol.reloadTime;
    player.reloading = slot;
  }

  function tryThrowGrenade(player: Player) {
    let kind: Grenade['kind'] | null = null;
    if (player.weapon === 'explosive') {
      kind = 'explosive';
    } else if (player.weapon === 'grenade') {
      kind = 'acid';
    } else if (player.weapon === 'smoke') {
      kind = 'smoke';
    }
    if (!kind) {
      return;
    }
    const available =
      kind === 'explosive' ? player.explosiveGrenades : kind === 'smoke' ? player.smokeGrenades : player.grenades;
    if (available <= 0) {
      return;
    }
    const viewHeight = player.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
    const dir = directionFromYawPitch(player.yaw, player.pitch);
    const origin: Vec3 = [
      player.pos[0] + dir[0] * 0.45,
      player.pos[1] + viewHeight - 0.08 + dir[1] * 0.2,
      player.pos[2] + dir[2] * 0.45,
    ];
    const vel: Vec3 = [
      dir[0] * GRENADE_CONFIG.speed + player.vel[0] * GRENADE_CONFIG.carryFactor,
      dir[1] * GRENADE_CONFIG.speed + GRENADE_CONFIG.upBoost,
      dir[2] * GRENADE_CONFIG.speed + player.vel[2] * GRENADE_CONFIG.carryFactor,
    ];
    grenades.push({
      id: `g${nextGrenadeId++}`,
      pos: origin,
      vel,
      ownerId: player.id,
      kind,
      explodeAt: gameTime + (kind === 'smoke' ? SMOKE_GRENADE_CONFIG.fuseTime : GRENADE_CONFIG.fuseTime),
    });
    if (kind === 'explosive') {
      player.explosiveGrenades -= 1;
    } else if (kind === 'smoke') {
      player.smokeGrenades -= 1;
    } else {
      player.grenades -= 1;
    }
  }

  function tryBuy(player: Player, primary: WeaponType) {
    if (inBuyWindow()) {
      applyPrimary(player, primary);
    }
  }

  function handlePlaceShit(playerId: string) {
    const player = players.get(playerId);
    if (!player || !player.alive) {
      return;
    }
    if (phase !== 'live' && phase !== 'freeze') {
      return;
    }
    if (gameTime < player.nextPlaceTime) {
      return;
    }
    player.nextPlaceTime = gameTime + SHIT_E_PLACE_COOLDOWN;
    const floorY = findFloorYAt(player.pos[0], player.pos[2], player.pos[1] + 0.2);
    placedModels.push({
      id: `shit-${player.id}-${Math.floor(gameTime * 1000)}`,
      ownerId: player.id,
      path: SHIT_E_PATH,
      pos: [player.pos[0], floorY + SHIT_E_Y_OFFSET, player.pos[2]],
      rot: [0, player.yaw, 0],
      scale: SHIT_E_SCALE,
    });
    if (placedModels.length > MAX_PLACED_SHIT_E) {
      placedModels.splice(0, placedModels.length - MAX_PLACED_SHIT_E);
    }
  }

  function raycastMap(origin: Vec3, dir: Vec3, range: number): number {
    let closest = Infinity;
    const minDist = 0.02;
    for (const box of mapData.boxes) {
      const dist = rayIntersectAABB(origin, dir, box.min, box.max);
      if (dist !== null && dist > minDist && dist < closest) {
        closest = dist;
      }
    }
    return Math.min(closest, range);
  }

  function raycastPlayers(
    origin: Vec3,
    dir: Vec3,
    range: number,
    shooterId: string
  ): { player: Player; distance: number } | null {
    let closest: { player: Player; distance: number } | null = null;
    const shooter = players.get(shooterId);
    if (!shooter) {
      return null;
    }
    const shooterSide = playerSide(shooter);
    for (const player of players.values()) {
      if (!player.alive || player.id === shooterId) {
        continue;
      }
      if (gameMode === 'team' && playerSide(player) === shooterSide) {
        continue;
      }
      const height = player.crouching ? PLAYER_HEIGHT * 0.6 : PLAYER_HEIGHT;
      const min: Vec3 = [player.pos[0] - PLAYER_RADIUS, player.pos[1], player.pos[2] - PLAYER_RADIUS];
      const max: Vec3 = [player.pos[0] + PLAYER_RADIUS, player.pos[1] + height, player.pos[2] + PLAYER_RADIUS];
      const dist = rayIntersectAABB(origin, dir, min, max);
      if (dist === null || dist < 0 || dist > range) {
        continue;
      }
      if (!closest || dist < closest.distance) {
        closest = { player, distance: dist };
      }
    }
    return closest;
  }

  function raycastTrainingTargets(origin: Vec3, dir: Vec3, range: number): { target: TrainingTarget; distance: number } | null {
    let closest: { target: TrainingTarget; distance: number } | null = null;
    for (const target of trainingTargets) {
      if (!target.alive) {
        continue;
      }
      const halfX = target.plane === 'x' ? TRAINING_TARGET_HALF_THICKNESS : TRAINING_TARGET_HALF_SPAN;
      const halfZ = target.plane === 'x' ? TRAINING_TARGET_HALF_SPAN : TRAINING_TARGET_HALF_THICKNESS;
      const min: Vec3 = [target.pos[0] - halfX, target.pos[1], target.pos[2] - halfZ];
      const max: Vec3 = [target.pos[0] + halfX, target.pos[1] + TRAINING_TARGET_HEIGHT, target.pos[2] + halfZ];
      const dist = rayIntersectAABB(origin, dir, min, max);
      if (dist === null || dist < 0 || dist > range) {
        continue;
      }
      if (!closest || dist < closest.distance) {
        closest = { target, distance: dist };
      }
    }
    return closest;
  }

  function fireHitscan(
    player: Player,
    origin: Vec3,
    weaponType: WeaponType | 'pistol',
    spread: number,
    range: number,
    baseDamage: number
  ) {
    const yawSpread = (Math.random() * 2 - 1) * spread;
    const pitchSpread = (Math.random() * 2 - 1) * spread;
    const dir = directionFromYawPitch(player.yaw + yawSpread, player.pitch + pitchSpread);
    const muzzleOffset = 0.15;
    const muzzle: Vec3 = [
      origin[0] + dir[0] * muzzleOffset,
      origin[1] + dir[1] * muzzleOffset,
      origin[2] + dir[2] * muzzleOffset,
    ];
    const mapDist = raycastMap(muzzle, dir, range);
    const playerHit = raycastPlayers(muzzle, dir, range, player.id);
    const trainingTargetHit = raycastTrainingTargets(muzzle, dir, range);
    const hit =
      playerHit && trainingTargetHit
        ? playerHit.distance <= trainingTargetHit.distance
          ? { kind: 'player' as const, distance: playerHit.distance, player: playerHit.player }
          : { kind: 'training_target' as const, distance: trainingTargetHit.distance, target: trainingTargetHit.target }
        : playerHit
        ? { kind: 'player' as const, distance: playerHit.distance, player: playerHit.player }
        : trainingTargetHit
        ? { kind: 'training_target' as const, distance: trainingTargetHit.distance, target: trainingTargetHit.target }
        : null;
    const hitEps = 0.01;
    const travel = hit && hit.distance - hitEps < mapDist ? hit.distance : mapDist;
    pendingEvents.push({
      type: 'shot',
      shooterId: player.id,
      weapon: weaponType,
      origin: muzzle,
      dir,
      distance: Math.min(range, travel),
    });
    if (!hit || hit.distance - hitEps >= mapDist) {
      return;
    }
    const hitPoint: Vec3 = [
      muzzle[0] + dir[0] * hit.distance,
      muzzle[1] + dir[1] * hit.distance,
      muzzle[2] + dir[2] * hit.distance,
    ];
    const rel = hit.kind === 'player' ? hitPoint[1] - hit.player.pos[1] : hitPoint[1] - hit.target.pos[1];
    const targetHeight = hit.kind === 'player' ? PLAYER_HEIGHT : TRAINING_TARGET_HEIGHT;
    let multiplier = 1;
    if (rel > targetHeight * 0.75) {
      multiplier = weaponType === 'rifle' ? 3 : 1.5;
    } else if (rel < targetHeight * 0.35) {
      multiplier = 0.75;
    }
    const damage = Math.floor(baseDamage * multiplier);
    if (damage > 0) {
      if (hit.kind === 'player') {
        applyDamage(hit.player, player.id, damage, weaponType);
      } else {
        applyTrainingTargetDamage(hit.target, player.id, damage, weaponType);
      }
    }
  }

  function tryShoot(player: Player) {
    if (player.reloading || player.weapon === 'explosive' || player.weapon === 'grenade' || player.weapon === 'smoke') {
      return;
    }
    const now = gameTime;
    const weaponType = player.weapon === 'primary' ? player.primary : 'pistol';
    const config = WEAPON_CONFIG[weaponType];
    if (now < player.nextFireTime) {
      return;
    }
    if (weaponType === 'pistol') {
      if (player.ammoPistol <= 0) {
        return;
      }
      player.ammoPistol -= 1;
    } else {
      if (player.ammoPrimary <= 0) {
        return;
      }
      player.ammoPrimary -= 1;
    }
    player.nextFireTime = now + 1 / config.fireRate;

    const viewHeight = player.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
    const viewOrigin: Vec3 = [player.pos[0], player.pos[1] + viewHeight, player.pos[2]];
    const viewDir = directionFromYawPitch(player.yaw, player.pitch);
    const right: Vec3 = [Math.cos(player.yaw), 0, -Math.sin(player.yaw)];
    const centeredScopeAim = weaponType === 'sniper' || weaponType === 'aug';
    const muzzleForward = weaponType === 'sniper' ? 0.45 : weaponType === 'shotgun' ? 0.35 : 0.3;
    const sideOffset = centeredScopeAim ? 0 : weaponType === 'pistol' ? 0.08 : 0.12;
    // Keep scoped rifles centered on the optic while preserving the lower AK-47 muzzle line.
    const upOffset = centeredScopeAim ? 0 : weaponType === 'rifle' ? -0.02 : 0.03;
    const origin: Vec3 = [
      viewOrigin[0] + viewDir[0] * muzzleForward + right[0] * sideOffset,
      viewOrigin[1] + viewDir[1] * muzzleForward + upOffset,
      viewOrigin[2] + viewDir[2] * muzzleForward + right[2] * sideOffset,
    ];

    if (weaponType === 'shotgun') {
      for (let i = 0; i < (config.pellets ?? 8); i += 1) {
        fireHitscan(player, origin, weaponType, config.spread, config.range, config.baseDamage);
      }
      return;
    }

    fireHitscan(player, origin, weaponType, config.spread, config.range, config.baseDamage);
  }

  function processInputs() {
    for (const player of players.values()) {
      while (player.inputQueue.length > 0) {
        const input = player.inputQueue.shift();
        if (!input) {
          continue;
        }
        player.lastSeq = input.seq;
        player.yaw = input.yaw;
        player.pitch = clamp(input.pitch, -1.5, 1.5);
        player.weapon = input.weapon;
        if (!player.alive || phase !== 'live') {
          continue;
        }
        if (input.reload) {
          tryStartReload(player);
        }
        if (input.throwGrenade) {
          tryThrowGrenade(player);
        }
        const dt = clamp(input.dt, 0.001, 0.05);
        const moved = movePlayer(
          { pos: player.pos, vel: player.vel, onGround: player.onGround },
          {
            f: clamp(input.move.f, -1, 1),
            s: clamp(input.move.s, -1, 1),
            jump: input.jump,
            crouch: input.crouch,
          },
          player.yaw,
          dt,
          mapData
        );
        player.pos = moved.pos;
        player.vel = moved.vel;
        player.onGround = moved.onGround;
        player.crouching = input.crouch;
        if (input.shoot) {
          tryShoot(player);
        }
      }
    }
  }

  function processRespawns() {
    if (phase !== 'live' || gameMode !== 'ffa') {
      return;
    }
    for (const player of players.values()) {
      if (!player.alive && gameTime >= player.respawnAt) {
        spawnPlayer(player);
      }
    }
  }

  const overlapMoveSteps = 10;

  function movePlayerAxisSafely(player: Player, axis: 0 | 2, delta: number) {
    if (Math.abs(delta) <= 1e-4) {
      return;
    }
    const start = player.pos[axis];
    const startColliding = collidesAt(player.pos, mapData);
    const target: Vec3 = [player.pos[0], player.pos[1], player.pos[2]];
    target[axis] = start + delta;
    if (!collidesAt(target, mapData)) {
      player.pos[axis] = target[axis];
      return;
    }
    if (startColliding) {
      for (let step = 1; step <= overlapMoveSteps; step += 1) {
        target[axis] = start + delta * (step / overlapMoveSteps);
        if (!collidesAt(target, mapData)) {
          player.pos[axis] = target[axis];
          return;
        }
      }
      return;
    }
    for (let step = overlapMoveSteps - 1; step >= 1; step -= 1) {
      target[axis] = start + delta * (step / overlapMoveSteps);
      if (!collidesAt(target, mapData)) {
        player.pos[axis] = target[axis];
        return;
      }
    }
  }

  function translatePlayerSafely(player: Player, dx: number, dz: number, dirX: number, dirZ: number): number {
    const startX = player.pos[0];
    const startZ = player.pos[2];
    movePlayerAxisSafely(player, 0, dx);
    movePlayerAxisSafely(player, 2, dz);
    player.pos = resolvePenetration(player.pos, mapData);
    const movedX = player.pos[0] - startX;
    const movedZ = player.pos[2] - startZ;
    return Math.max(0, movedX * dirX + movedZ * dirZ);
  }

  function resolvePlayerOverlaps() {
    const playerList = Array.from(players.values()).filter((player) => player.alive);
    const minDist = PLAYER_RADIUS * 2;
    for (const player of playerList) {
      player.pos = resolvePenetration(player.pos, mapData);
    }
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < playerList.length; i += 1) {
        for (let j = i + 1; j < playerList.length; j += 1) {
          const a = playerList[i];
          const b = playerList[j];
          const dx = b.pos[0] - a.pos[0];
          const dz = b.pos[2] - a.pos[2];
          const distSq = dx * dx + dz * dz;

          let nx = 0;
          let nz = 0;
          let overlap = 0;

          if (distSq <= 1e-6) {
            const velDx = b.vel[0] - a.vel[0];
            const velDz = b.vel[2] - a.vel[2];
            const velLen = Math.hypot(velDx, velDz);
            if (velLen > 1e-4) {
              nx = velDx / velLen;
              nz = velDz / velLen;
            } else {
              nx = a.id < b.id ? -1 : 1;
              nz = 0;
            }
            overlap = minDist;
          } else {
            const dist = Math.sqrt(distSq);
            if (dist >= minDist) {
              continue;
            }
            nx = dx / dist;
            nz = dz / dist;
            overlap = minDist - dist;
          }

          const aDirX = -nx;
          const aDirZ = -nz;
          const bDirX = nx;
          const bDirZ = nz;
          const halfOverlap = overlap * 0.5;

          const movedA = translatePlayerSafely(a, aDirX * halfOverlap, aDirZ * halfOverlap, aDirX, aDirZ);
          const movedB = translatePlayerSafely(b, bDirX * halfOverlap, bDirZ * halfOverlap, bDirX, bDirZ);

          let remaining = overlap - movedA - movedB;
          if (remaining > 1e-4) {
            remaining -= translatePlayerSafely(a, aDirX * remaining, aDirZ * remaining, aDirX, aDirZ);
          }
          if (remaining > 1e-4) {
            translatePlayerSafely(b, bDirX * remaining, bDirZ * remaining, bDirX, bDirZ);
          }
        }
      }
    }
    for (const player of playerList) {
      player.pos = resolvePenetration(player.pos, mapData);
      player.onGround = isOnGround(player.pos, mapData);
    }
  }

  function buildSnapshots(): PlayerSnapshot[] {
    const sides = sideByTeam(round);
    const snapshots: PlayerSnapshot[] = [];
    for (const player of players.values()) {
      const side = player.matchTeam === 'A' ? sides.A : sides.B;
      snapshots.push({
        id: player.id,
        name: player.name,
        pos: player.pos,
        vel: player.vel,
        yaw: player.yaw,
        pitch: player.pitch,
        hp: player.hp,
        alive: player.alive,
        matchTeam: player.matchTeam,
        side,
        weapon: player.weapon,
        primary: player.primary,
        ammo: {
          primary: player.ammoPrimary,
          pistol: player.ammoPistol,
        },
        explosiveGrenades: player.explosiveGrenades,
        grenades: player.grenades,
        smokeGrenades: player.smokeGrenades,
        lastSeq: player.lastSeq,
        crouching: player.crouching,
        kills: player.kills,
        deaths: player.deaths,
      });
    }
    return snapshots;
  }

  function buildTrainingTargetSnapshots(): TrainingTargetSnapshot[] {
    return trainingTargets.map((target) => ({
      id: target.id,
      pos: target.pos,
      yaw: target.yaw,
      hp: target.hp,
      alive: target.alive,
    }));
  }

  function getPlayersMeta(): PlayerMeta[] {
    return Array.from(players.values()).map((player) => ({ id: player.id, name: player.name, face: player.face }));
  }

  function getSummary(): RoomSummary {
    return {
      id,
      name,
      mode: gameMode,
      teamSize: teamSizeConfig,
      phase,
      playerCount: players.size,
      capacity: roomCapacity(),
      players: Array.from(players.values()).map((player) => ({ id: player.id, name: player.name })),
    };
  }

  function sendWelcome(player: Player) {
    sendJson(player.ws, {
      type: 'welcome',
      id: player.id,
      roomId: id,
      map: mapData,
      tickRate: TICK_RATE,
      playersMeta: getPlayersMeta(),
    });
  }

  function broadcastPlayerMeta(player: Player) {
    const payload = {
      type: 'player_meta',
      player: { id: player.id, name: player.name, face: player.face },
    };
    for (const other of players.values()) {
      if (other.id !== player.id) {
        sendJson(other.ws, payload);
      }
    }
  }

  function join(ws: WebSocket, message: ClientJoin): JoinResult {
    if (players.size >= roomCapacity()) {
      return { ok: false, error: 'Room is full.' };
    }

    const requestedMode =
      fixedMode ?? (message.matchMode === 'ffa' || message.matchMode === 'team' ? message.matchMode : 'team');
    if (players.size === 0) {
      resetRoomState();
      gameMode = requestedMode;
      teamSizeConfig = gameMode === 'team' ? clamp(Math.floor(message.teamSize ?? defaultTeamSize), 1, 4) : 4;
    } else if (requestedMode !== gameMode) {
      return {
        ok: false,
        error: `Room is running ${gameMode === 'ffa' ? 'Free-for-all' : 'Teams'} mode.`,
      };
    }

    let matchTeam: MatchTeam = 'A';
    if (gameMode === 'team') {
      const teamCounts = { A: 0, B: 0 };
      for (const player of players.values()) {
        teamCounts[player.matchTeam] += 1;
      }
      const currentSides = sideByTeam(round);
      const preferredTeam: MatchTeam | null = message.preferredSide
        ? currentSides.A === message.preferredSide
          ? 'A'
          : 'B'
        : null;
      const pickTeam = (candidate: MatchTeam | null): MatchTeam => {
        if (candidate && teamCounts[candidate] < teamSizeConfig) {
          const other = candidate === 'A' ? 'B' : 'A';
          const diff = teamCounts[candidate] - teamCounts[other];
          if (diff <= 0) {
            return candidate;
          }
        }
        const fallback: MatchTeam = teamCounts.A <= teamCounts.B ? 'A' : 'B';
        if (teamCounts[fallback] < teamSizeConfig) {
          return fallback;
        }
        return fallback === 'A' ? 'B' : 'A';
      };
      matchTeam = pickTeam(preferredTeam);
      if (teamCounts[matchTeam] >= teamSizeConfig) {
        return { ok: false, error: 'Selected room team slots are full.' };
      }
    }

    const rawFace = typeof message.face === 'string' ? message.face.trim() : '';
    const face =
      rawFace && rawFace.startsWith('data:image/') && rawFace.length <= MAX_FACE_LENGTH ? rawFace : undefined;
    const primary = message.primary ?? 'rifle';
    const idValue = `p${nextPlayerId++}`;
    const player: Player = {
      id: idValue,
      ws,
      name: (message.name ?? idValue).slice(0, 16),
      face,
      matchTeam,
      primary,
      preferredSide: message.preferredSide,
      weapon: 'primary',
      pos: [0, 0.1, 0],
      vel: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      hp: 100,
      alive: false,
      onGround: true,
      ammoPrimary: WEAPON_CONFIG[primary].magSize,
      ammoPistol: WEAPON_CONFIG.pistol.magSize,
      explosiveGrenades: throwableLoadout.explosiveGrenades,
      grenades: throwableLoadout.grenades,
      smokeGrenades: throwableLoadout.smokeGrenades,
      lastSeq: 0,
      inputQueue: [],
      nextFireTime: 0,
      reloadEndTime: 0,
      reloading: null,
      pendingSpawn: false,
      crouching: false,
      buyLocked: false,
      buyChoice: null,
      kills: 0,
      deaths: 0,
      respawnAt: 0,
      nextPlaceTime: 0,
    };

    if (phase !== 'match_over') {
      spawnPlayer(player);
    }
    players.set(player.id, player);
    return { ok: true, player };
  }

  function handleInput(playerId: string, input: InputPayload) {
    const player = players.get(playerId);
    if (player) {
      player.inputQueue.push(input);
    }
  }

  function handleBuy(playerId: string, primary: WeaponType) {
    const player = players.get(playerId);
    if (player) {
      tryBuy(player, primary);
    }
  }

  function leave(playerId: string) {
    players.delete(playerId);
    if (players.size === 0) {
      resetRoomState();
    }
  }

  function tick() {
    const dt = 1 / TICK_RATE;
    gameTime += dt;
    updateRound(dt);
    updateReloads();
    updateGrenades(dt);
    processInputs();
    updateGrenadePools();
    updateSmokeClouds();
    updateTrainingTargetRespawns();
    processRespawns();
    resolvePlayerOverlaps();
    applyDefaultBuys();

    const roundState: RoundState = {
      round,
      phase,
      timeLeft: Math.max(0, timeLeft),
      freezeLeft: Math.max(0, freezeLeft),
      scores: { ...scores },
      sideByTeam: sideByTeam(round),
      postLeft: phase === 'post' ? Math.max(0, postLeft) : undefined,
      postReason: phase === 'post' ? 'draw' : undefined,
      mode: gameMode,
      teamSize: teamSizeConfig,
      neededPlayers: requiredPlayers(),
      presentPlayers: players.size,
    };

    const payload = JSON.stringify({
      type: 'snapshot',
      now: gameTime,
      players: buildSnapshots(),
      trainingTargets: buildTrainingTargetSnapshots(),
      grenades: grenades.map((grenade) => ({
        id: grenade.id,
        pos: grenade.pos,
        vel: grenade.vel,
        ownerId: grenade.ownerId,
        kind: grenade.kind,
      })),
      grenadePools: grenadePools.map((pool) => ({
        id: pool.id,
        pos: pool.pos,
        ownerId: pool.ownerId,
        radius: grenadePoolRadius(pool),
        life: Math.max(0, pool.expireAt - gameTime),
      })),
      smokeClouds: smokeClouds.map((cloud) => ({
        id: cloud.id,
        pos: cloud.pos,
        radius: smokeCloudRadius(cloud),
        life: Math.max(0, cloud.expireAt - gameTime),
      })),
      placedModels: placedModels.map((model) => ({
        id: model.id,
        path: model.path,
        pos: model.pos,
        rot: model.rot,
        scale: model.scale,
      })),
      events: pendingEvents,
      round: roundState,
    });
    pendingEvents = [];

    for (const player of players.values()) {
      sendJson(player.ws, payload);
    }
  }

  return {
    id,
    name,
    join,
    handleInput,
    handleBuy,
    handlePlaceShit,
    leave,
    tick,
    getSummary,
    sendWelcome,
    broadcastPlayerMeta,
  };
}

const rooms = Array.from({ length: ROOM_COUNT }, (_, index) => {
  const roomIndex = index + 1;
  return createRoom(`room-${roomIndex}`, `Room ${roomIndex}`, { map: mapData });
});
rooms.push(
  createRoom(TRAINING_ROOM_ID, TRAINING_ROOM_NAME, {
    map: trainingMapData,
    fixedMode: 'ffa',
    minPlayers: 1,
    trainingTargets: TRAINING_TARGETS,
    throwableLoadout: {
      explosiveGrenades: 5,
      grenades: 5,
      smokeGrenades: 5,
    },
  })
);
const roomsById = new Map(rooms.map((room) => [room.id, room]));

function cleanupConnection(connection: ConnectionState) {
  let roomChanged = false;
  if (connection.roomId && connection.playerId) {
    roomsById.get(connection.roomId)?.leave(connection.playerId);
    connection.playerId = null;
    connection.roomId = null;
    roomChanged = true;
  }
  if (connections.delete(connection) || roomChanged) {
    broadcastRoomList();
  }
}

function buildRoomListPayload() {
  return {
    type: 'room_list' as const,
    rooms: rooms.map((room) => room.getSummary()),
  };
}

function broadcastRoomList() {
  const payload = JSON.stringify(buildRoomListPayload());
  for (const connection of connections) {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(payload);
    }
  }
}

setInterval(() => {
  for (const room of rooms) {
    room.tick();
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  broadcastRoomList();
}, ROOM_LIST_INTERVAL_MS);

setInterval(() => {
  const now = Date.now();
  for (const connection of Array.from(connections)) {
    if (now - connection.lastHeardAt <= CLIENT_HEARTBEAT_TIMEOUT_MS) {
      continue;
    }
    cleanupConnection(connection);
    if (
      connection.ws.readyState === WebSocket.OPEN ||
      connection.ws.readyState === WebSocket.CONNECTING
    ) {
      connection.ws.terminate();
    }
  }
}, CLIENT_HEARTBEAT_SWEEP_MS);

wss.on('connection', (ws: WebSocket) => {
  const connection: ConnectionState = { ws, playerId: null, roomId: null, lastHeardAt: Date.now() };
  connections.add(connection);
  sendJson(ws, buildRoomListPayload());

  ws.on('message', (raw: RawData) => {
    let message: ClientMessage | null = null;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    connection.lastHeardAt = Date.now();

    if (message.type === 'ping') {
      sendJson(ws, { type: 'pong' });
      return;
    }

    if (message.type === 'join') {
      if (connection.playerId || connection.roomId) {
        sendLobbyError(ws, 'You are already in a room.');
        return;
      }
      const room = roomsById.get(message.roomId ?? rooms[0].id);
      if (!room) {
        sendLobbyError(ws, 'Room not found.');
        sendJson(ws, buildRoomListPayload());
        return;
      }
      const result = room.join(ws, message);
      if (!result.ok) {
        sendLobbyError(ws, result.error);
        sendJson(ws, buildRoomListPayload());
        return;
      }
      connection.playerId = result.player.id;
      connection.roomId = room.id;
      room.sendWelcome(result.player);
      room.broadcastPlayerMeta(result.player);
      broadcastRoomList();
      return;
    }

    if (message.type === 'leave') {
      if (connection.roomId && connection.playerId) {
        roomsById.get(connection.roomId)?.leave(connection.playerId);
        connection.playerId = null;
        connection.roomId = null;
        sendJson(ws, buildRoomListPayload());
        broadcastRoomList();
      }
      return;
    }

    if (!connection.roomId || !connection.playerId) {
      return;
    }
    const room = roomsById.get(connection.roomId);
    if (!room) {
      return;
    }

    if (message.type === 'input') {
      room.handleInput(connection.playerId, message.input);
      return;
    }

    if (message.type === 'buy') {
      room.handleBuy(connection.playerId, message.primary);
      return;
    }

    if (message.type === 'place_shit') {
      room.handlePlaceShit(connection.playerId);
    }
  });

  ws.on('close', () => {
    cleanupConnection(connection);
  });
});

console.log(`Server running on ws://localhost:${PORT}`);
