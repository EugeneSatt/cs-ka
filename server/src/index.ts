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
  PlayerMeta,
  PlayerSnapshot,
  RoomSummary,
  RoundState,
  ServerEvent,
  Vec3,
} from '../../shared/src/types';
import {
  BUY_WINDOW,
  CROUCH_EYE_HEIGHT,
  EYE_HEIGHT,
  FFA_ROUND_TIME,
  FREEZE_TIME,
  GRENADE_CONFIG,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  ROUND_TIME,
  SWAP_ROUND,
  TICK_RATE,
  TOTAL_ROUNDS,
  WEAPON_CONFIG,
} from '../../shared/src/constants';
import type { MatchTeam, Side, WeaponSlot, WeaponType } from '../../shared/src/constants';
import { clamp } from '../../shared/src/math';
import { collidesAt, isOnGround, movePlayer, resolvePenetration } from '../../shared/src/physics';
import { directionFromYawPitch, rayIntersectAABB } from '../../shared/src/ray';

const WEAPON_MODEL_KEYS = ['ak-47', 'awp', 'spas_12', 'beretta'];
const MODEL_DEFAULTS: Array<{ keys: string[]; box: { min: Vec3; max: Vec3 } }> = [
  { keys: ['arm_chair', 'armchair', 'office_creslo', 'chair'], box: { min: [-0.5, 0, -0.5], max: [0.5, 1.2, 0.5] } },
  { keys: ['divan', 'sofa'], box: { min: [-1.2, 0, -0.6], max: [1.2, 1.0, 0.6] } },
  { keys: ['desk'], box: { min: [-1.0, 0, -0.8], max: [1.0, 1.1, 0.8] } },
  { keys: ['table'], box: { min: [-1.2, 0, -1.2], max: [1.2, 1.0, 1.2] } },
  { keys: ['computer'], box: { min: [-0.35, 0, -0.35], max: [0.35, 0.7, 0.35] } },
  { keys: ['tablet'], box: { min: [-0.25, 0, -0.2], max: [0.25, 0.2, 0.2] } },
  { keys: ['wardrobe', 'stenka', 'bookshkaf'], box: { min: [-0.8, 0, -0.35], max: [0.8, 2.0, 0.35] } },
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
const FFA_SPAWN_JITTER = 3.2;
const FFA_SPAWN_ATTEMPTS = 18;
const FFA_SPAWN_SAMPLE_STEP = 6;
const FFA_SPAWN_EDGE_MARGIN = 1.1;
const FFA_SPAWN_MERGE_DIST_SQ = 4;
const FFA_SPAWN_MAX_Y = 0.5;

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

const ffaSpawnAnchors = buildFfaSpawnAnchors(mapData);

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
  grenades: number;
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
};

type Grenade = {
  id: string;
  pos: Vec3;
  vel: Vec3;
  ownerId: string;
  explodeAt: number;
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
  leave(playerId: string): void;
  tick(): void;
  getSummary(): RoomSummary;
  sendWelcome(player: Player): void;
  broadcastPlayerMeta(player: Player): void;
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

function createRoom(id: string, name: string): RoomController {
  const players = new Map<string, Player>();
  const grenades: Grenade[] = [];

  let gameTime = 0;
  let round = 1;
  let phase: RoundState['phase'] = 'waiting';
  let freezeLeft = FREEZE_TIME;
  let timeLeft = ROUND_TIME;
  let postLeft = 0;
  const scores = { A: 0, B: 0 };
  let pendingEvents: ServerEvent[] = [];
  let matchOverAnnounced = false;
  let gameMode: GameMode = 'team';
  let teamSizeConfig = 4;

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
    return 2;
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
    player.grenades = 1;
    player.nextFireTime = 0;
    player.reloadEndTime = 0;
    player.reloading = null;
    player.pendingSpawn = false;
    player.crouching = false;
    player.buyLocked = false;
    player.buyChoice = null;
    player.respawnAt = Infinity;
  }

  function startRound() {
    matchOverAnnounced = false;
    phase = gameMode === 'team' ? 'freeze' : 'live';
    freezeLeft = gameMode === 'team' ? FREEZE_TIME : 0;
    timeLeft = gameMode === 'team' ? ROUND_TIME : FFA_ROUND_TIME;
    postLeft = 0;
    grenades.length = 0;

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
    round = 1;
    phase = 'waiting';
    freezeLeft = FREEZE_TIME;
    timeLeft = ROUND_TIME;
    postLeft = 0;
    scores.A = 0;
    scores.B = 0;
    pendingEvents = [];
    matchOverAnnounced = false;
    gameMode = 'team';
    teamSizeConfig = 4;
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

  function moveGrenadeAxis(pos: Vec3, vel: Vec3, axis: 0 | 1 | 2, dt: number): Vec3 {
    const next: Vec3 = [pos[0], pos[1], pos[2]];
    next[axis] += vel[axis] * dt;
    if (!grenadeCollides(next)) {
      return next;
    }
    vel[axis] = 0;
    return pos;
  }

  function moveGrenade(pos: Vec3, vel: Vec3, dt: number): { pos: Vec3; vel: Vec3 } {
    let next: Vec3 = [pos[0], pos[1], pos[2]];
    next = moveGrenadeAxis(next, vel, 0, dt);
    next = moveGrenadeAxis(next, vel, 1, dt);
    next = moveGrenadeAxis(next, vel, 2, dt);
    return { pos: next, vel };
  }

  function playerSideById(playerId: string): Side {
    const player = players.get(playerId);
    return player ? playerSide(player) : 'T';
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

  function explodeGrenade(grenade: Grenade) {
    pendingEvents.push({ type: 'grenade_explode', pos: grenade.pos, ownerId: grenade.ownerId });
    for (const player of players.values()) {
      if (!player.alive || player.id === grenade.ownerId) {
        continue;
      }
      if (gameMode === 'team' && playerSide(player) === playerSideById(grenade.ownerId)) {
        continue;
      }
      const center: Vec3 = [player.pos[0], player.pos[1] + PLAYER_HEIGHT * 0.5, player.pos[2]];
      const dist = Math.hypot(center[0] - grenade.pos[0], center[1] - grenade.pos[1], center[2] - grenade.pos[2]);
      if (dist > GRENADE_CONFIG.radius) {
        continue;
      }
      const damage = Math.max(0, Math.floor(GRENADE_CONFIG.maxDamage * (1 - dist / GRENADE_CONFIG.radius)));
      if (damage > 0) {
        applyDamage(player, grenade.ownerId, damage, 'grenade');
      }
    }
  }

  function updateGrenades(dt: number) {
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const grenade = grenades[i];
      grenade.vel[1] += dt * -20;
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
    if (player.reloading || player.weapon === 'grenade') {
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
    if (player.grenades <= 0) {
      return;
    }
    const origin: Vec3 = [player.pos[0], player.pos[1] + EYE_HEIGHT, player.pos[2]];
    const dir = directionFromYawPitch(player.yaw, player.pitch);
    const vel: Vec3 = [
      dir[0] * GRENADE_CONFIG.speed,
      dir[1] * GRENADE_CONFIG.speed + GRENADE_CONFIG.upBoost,
      dir[2] * GRENADE_CONFIG.speed,
    ];
    grenades.push({
      id: `g${nextGrenadeId++}`,
      pos: origin,
      vel,
      ownerId: player.id,
      explodeAt: gameTime + GRENADE_CONFIG.fuseTime,
    });
    player.grenades -= 1;
  }

  function tryBuy(player: Player, primary: WeaponType) {
    if (inBuyWindow()) {
      applyPrimary(player, primary);
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
    const hit = raycastPlayers(muzzle, dir, range, player.id);
    const hitEps = 0.01;
    const travel = hit && hit.distance - hitEps < mapDist ? hit.distance : mapDist;
    pendingEvents.push({
      type: 'shot',
      shooterId: player.id,
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
    const rel = hitPoint[1] - hit.player.pos[1];
    let multiplier = 1;
    if (rel > PLAYER_HEIGHT * 0.75) {
      multiplier = 1.5;
    } else if (rel < PLAYER_HEIGHT * 0.35) {
      multiplier = 0.75;
    }
    const damage = Math.floor(baseDamage * multiplier);
    if (damage > 0) {
      applyDamage(hit.player, player.id, damage, weaponType);
    }
  }

  function tryShoot(player: Player) {
    if (player.reloading || player.weapon === 'grenade') {
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
    const muzzleForward = weaponType === 'sniper' ? 0.45 : weaponType === 'shotgun' ? 0.35 : 0.3;
    const sideOffset = weaponType === 'pistol' ? 0.08 : 0.12;
    const upOffset = 0.03;
    const origin: Vec3 = [
      viewOrigin[0] + viewDir[0] * muzzleForward + right[0] * sideOffset,
      viewOrigin[1] + upOffset,
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
        grenades: player.grenades,
        lastSeq: player.lastSeq,
        crouching: player.crouching,
        kills: player.kills,
        deaths: player.deaths,
      });
    }
    return snapshots;
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

    const requestedMode = message.matchMode === 'ffa' || message.matchMode === 'team' ? message.matchMode : 'team';
    if (players.size === 0) {
      resetRoomState();
      gameMode = requestedMode;
      teamSizeConfig = gameMode === 'team' ? clamp(Math.floor(message.teamSize ?? 4), 1, 4) : 4;
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
      grenades: 1,
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
      grenades: grenades.map((grenade) => ({
        id: grenade.id,
        pos: grenade.pos,
        vel: grenade.vel,
        ownerId: grenade.ownerId,
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
    leave,
    tick,
    getSummary,
    sendWelcome,
    broadcastPlayerMeta,
  };
}

const rooms = Array.from({ length: ROOM_COUNT }, (_, index) => {
  const roomIndex = index + 1;
  return createRoom(`room-${roomIndex}`, `Room ${roomIndex}`);
});
const roomsById = new Map(rooms.map((room) => [room.id, room]));

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

wss.on('connection', (ws: WebSocket) => {
  const connection: ConnectionState = { ws, playerId: null, roomId: null };
  connections.add(connection);
  sendJson(ws, buildRoomListPayload());

  ws.on('message', (raw: RawData) => {
    let message: ClientMessage | null = null;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
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
    }
  });

  ws.on('close', () => {
    if (connection.roomId && connection.playerId) {
      roomsById.get(connection.roomId)?.leave(connection.playerId);
    }
    connections.delete(connection);
    broadcastRoomList();
  });
});

console.log(`Server running on ws://localhost:${PORT}`);
