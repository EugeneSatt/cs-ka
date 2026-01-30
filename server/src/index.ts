import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { MapData, ClientMessage, InputPayload, PlayerSnapshot, RoundState, ServerEvent, ModelDef, BoxDef, GameMode } from '../../shared/src/types';
import {
  BUY_WINDOW,
  CROUCH_EYE_HEIGHT,
  EYE_HEIGHT,
  FREEZE_TIME,
  FFA_ROUND_TIME,
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
import { movePlayer } from '../../shared/src/physics';
import { directionFromYawPitch, rayIntersectAABB } from '../../shared/src/ray';
import type { Vec3 } from '../../shared/src/types';

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
const FALLBACK_MODEL_BOX = { min: [-0.5, 0, -0.5], max: [0.5, 0.8, 0.5] };

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
const bulletBoxes = buildModelHitboxes(rawMap);

const PORT = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port: PORT });

const MAX_PLAYERS = 8;

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

const players = new Map<string, Player>();
const grenades: Grenade[] = [];
let nextPlayerId = 1;
const MAX_FACE_LENGTH = 180_000;
let nextGrenadeId = 1;

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
  if (gameMode === 'team') {
    return teamSizeConfig * 2;
  }
  return 2;
}

function readyToStart(): boolean {
  return players.size >= requiredPlayers();
}

function pickSpawn(side: Side | 'any'): Vec3 {
  const options = side === 'any' ? [...mapData.spawns.T, ...mapData.spawns.CT] : mapData.spawns[side];
  if (!options || options.length === 0) {
    return [0, 0.1, 0];
  }
  const spawn = options[Math.floor(Math.random() * options.length)];
  return [spawn[0], spawn[1], spawn[2]];
}

function inBuyWindow(): boolean {
  if (phase !== 'freeze' && phase !== 'live') {
    return false;
  }
  return roundElapsed() <= BUY_WINDOW;
}

function applyDefaultBuys() {
  if (!inBuyWindow()) {
    for (const player of players.values()) {
      if (player.buyLocked) {
        continue;
      }
      applyPrimary(player, 'rifle');
    }
  }
}

function spawnPlayer(player: Player) {
  const spawnSide: Side | 'any' = gameMode === 'ffa' ? 'any' : playerSide(player);
  player.pos = pickSpawn(spawnSide);
  player.vel = [0, 0, 0];
  player.hp = 100;
  player.alive = true;
  player.onGround = true;
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
  pendingEvents.push({
    type: 'round_draw',
    reason,
  });
  grenades.length = 0;
  round += 1;
  if (round > TOTAL_ROUNDS) {
    enterMatchOver();
    return;
  }
  phase = 'post';
  postLeft = 5;
}

function enterMatchOver() {
  if (matchOverAnnounced) {
    return;
  }
  matchOverAnnounced = true;
  phase = 'match_over';
  const winners = getKillLeaders();
  pendingEvents.push({
    type: 'match_over',
    reason: 'kills',
    winners,
  });
  // reset to waiting for next match
  round = 1;
  scores.A = 0;
  scores.B = 0;
  freezeLeft = 0;
  timeLeft = 0;
  postLeft = 0;
  phase = 'waiting';
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

function countAlive(side: Side): number {
  let count = 0;
  for (const player of players.values()) {
    if (!player.alive) {
      continue;
    }
    if (playerSide(player) === side) {
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

function updateReloads() {
  for (const player of players.values()) {
    if (!player.reloading) {
      continue;
    }
    if (gameTime < player.reloadEndTime) {
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

function moveGrenade(pos: Vec3, vel: Vec3, dt: number): { pos: Vec3; vel: Vec3 } {
  let next: Vec3 = [pos[0], pos[1], pos[2]];
  next = moveGrenadeAxis(next, vel, 0, dt);
  next = moveGrenadeAxis(next, vel, 1, dt);
  next = moveGrenadeAxis(next, vel, 2, dt);
  return { pos: next, vel };
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

function explodeGrenade(grenade: Grenade) {
  pendingEvents.push({ type: 'grenade_explode', pos: grenade.pos, ownerId: grenade.ownerId });
  for (const player of players.values()) {
    if (!player.alive) {
      continue;
    }
    if (player.id === grenade.ownerId) {
      continue;
    }
    if (playerSide(player) === playerSideById(grenade.ownerId)) {
      continue;
    }
    const center: Vec3 = [
      player.pos[0],
      player.pos[1] + PLAYER_HEIGHT * 0.5,
      player.pos[2],
    ];
    const dist = Math.hypot(
      center[0] - grenade.pos[0],
      center[1] - grenade.pos[1],
      center[2] - grenade.pos[2]
    );
    if (dist > GRENADE_CONFIG.radius) {
      continue;
    }
    const damage = Math.max(0, Math.floor(GRENADE_CONFIG.maxDamage * (1 - dist / GRENADE_CONFIG.radius)));
    if (damage > 0) {
      applyDamage(player, grenade.ownerId, damage, 'grenade');
    }
  }
}

function playerSideById(id: string): Side {
  const player = players.get(id);
  if (!player) {
    return 'T';
  }
  return playerSide(player);
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
  if (target.hp <= 0) {
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
    if (player.alive) {
      continue;
    }
    if (gameTime >= player.respawnAt) {
      spawnPlayer(player);
    }
  }
}

function resolvePlayerOverlaps() {
  const playerList = Array.from(players.values()).filter((p) => p.alive);
  const minDist = PLAYER_RADIUS * 2;
  for (let i = 0; i < playerList.length; i += 1) {
    for (let j = i + 1; j < playerList.length; j += 1) {
      const a = playerList[i];
      const b = playerList[j];
      const dx = b.pos[0] - a.pos[0];
      const dz = b.pos[2] - a.pos[2];
      const distSq = dx * dx + dz * dz;
      if (distSq <= 1e-6) {
        const offset = minDist * 0.5;
        a.pos[0] -= offset;
        b.pos[0] += offset;
        continue;
      }
      const dist = Math.sqrt(distSq);
      if (dist >= minDist) {
        continue;
      }
      const overlap = (minDist - dist) * 0.5;
      const nx = dx / dist;
      const nz = dz / dist;
      a.pos[0] -= nx * overlap;
      a.pos[2] -= nz * overlap;
      b.pos[0] += nx * overlap;
      b.pos[2] += nz * overlap;
    }
  }
}

function tryStartReload(player: Player) {
  if (player.reloading) {
    return;
  }
  if (player.weapon === 'grenade') {
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
  } else {
    const maxAmmo = WEAPON_CONFIG.pistol.magSize;
    if (player.ammoPistol >= maxAmmo) {
      return;
    }
    player.reloadEndTime = gameTime + WEAPON_CONFIG.pistol.reloadTime;
    player.reloading = slot;
  }
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
  if (!inBuyWindow()) {
    return;
  }
  applyPrimary(player, primary);
}

function tryShoot(player: Player) {
  if (player.reloading) {
    return;
  }
  if (player.weapon === 'grenade') {
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

  const origin: Vec3 = [
    player.pos[0],
    player.pos[1] + (player.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT),
    player.pos[2],
  ];

  if (weaponType === 'shotgun') {
    for (let i = 0; i < (config.pellets ?? 8); i += 1) {
      fireHitscan(player, origin, weaponType, config.spread, config.range, config.baseDamage);
    }
    return;
  }

  fireHitscan(player, origin, weaponType, config.spread, config.range, config.baseDamage);
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

  const MUZZLE_OFFSET = 0.15;
  const muzzle: Vec3 = [
    origin[0] + dir[0] * MUZZLE_OFFSET,
    origin[1] + dir[1] * MUZZLE_OFFSET,
    origin[2] + dir[2] * MUZZLE_OFFSET,
  ];

  const mapDist = raycastMap(muzzle, dir, range);
  const hit = raycastPlayers(muzzle, dir, range, player.id);
  const HIT_EPS = 0.01;
  const travel = hit && hit.distance - HIT_EPS < mapDist ? hit.distance : mapDist;
  pendingEvents.push({
    type: 'shot',
    shooterId: player.id,
    origin: muzzle,
    dir,
    distance: Math.min(range, travel),
  });
  if (!hit || hit.distance - HIT_EPS >= mapDist) {
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
  if (damage <= 0) {
    return;
  }
  applyDamage(hit.player, player.id, damage, weaponType);
}

function raycastMap(origin: Vec3, dir: Vec3, range: number): number {
  let closest = Infinity;
  const MIN_DIST = 0.02;
  for (const box of mapData.boxes) {
    const dist = rayIntersectAABB(origin, dir, box.min, box.max);
    if (dist !== null && dist > MIN_DIST && dist < closest) {
      closest = dist;
    }
  }
  for (const box of bulletBoxes) {
    const dist = rayIntersectAABB(origin, dir, box.min, box.max);
    if (dist !== null && dist > MIN_DIST && dist < closest) {
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
    const min: Vec3 = [
      player.pos[0] - PLAYER_RADIUS,
      player.pos[1],
      player.pos[2] - PLAYER_RADIUS,
    ];
    const max: Vec3 = [
      player.pos[0] + PLAYER_RADIUS,
      player.pos[1] + height,
      player.pos[2] + PLAYER_RADIUS,
    ];

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

  const playersSnapshot = buildSnapshots();
  const grenadeSnapshot = grenades.map((grenade) => ({
    id: grenade.id,
    pos: grenade.pos,
    vel: grenade.vel,
    ownerId: grenade.ownerId,
  }));

  const events = pendingEvents;
  pendingEvents = [];

  const payload = {
    type: 'snapshot',
    now: gameTime,
    players: playersSnapshot,
    grenades: grenadeSnapshot,
    events,
    round: roundState,
  };

  const data = JSON.stringify(payload);
  for (const player of players.values()) {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  }
}

setInterval(tick, 1000 / TICK_RATE);

wss.on('connection', (ws: WebSocket) => {
  let playerId: string | null = null;

  ws.on('message', (raw: RawData) => {
    let message: ClientMessage | null = null;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    if (message.type === 'join') {
      if (players.size >= MAX_PLAYERS) {
        ws.close();
        return;
      }

      if (players.size === 0) {
        if (message.matchMode === 'ffa' || message.matchMode === 'team') {
          gameMode = message.matchMode;
        } else {
          gameMode = 'team';
        }
        if (gameMode === 'team' && message.teamSize) {
          teamSizeConfig = clamp(Math.floor(message.teamSize), 1, 4);
        }
      }

      if (gameMode === 'team' && message.teamSize) {
        teamSizeConfig = clamp(Math.floor(message.teamSize), 1, 4);
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
          ws.close();
          return;
        }
      }

      const id = `p${nextPlayerId++}`;
      playerId = id;
      const rawFace = typeof message.face === 'string' ? message.face.trim() : '';
      const face =
        rawFace && rawFace.startsWith('data:image/') && rawFace.length <= MAX_FACE_LENGTH ? rawFace : undefined;
      const player: Player = {
        id,
        ws,
        name: message.name ?? id,
        face,
        matchTeam,
        primary: 'rifle',
        preferredSide: message.preferredSide,
        weapon: 'primary',
        pos: [0, 0.1, 0],
        vel: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        hp: 100,
        alive: false,
        onGround: true,
        ammoPrimary: WEAPON_CONFIG.rifle.magSize,
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

      players.set(id, player);

      ws.send(
        JSON.stringify({
          type: 'welcome',
          id,
          map: mapData,
          tickRate: TICK_RATE,
          playersMeta: Array.from(players.values()).map((p) => ({ id: p.id, name: p.name, face: p.face })),
        })
      );

      const metaMessage = JSON.stringify({
        type: 'player_meta',
        player: { id: player.id, name: player.name, face: player.face },
      });
      for (const other of players.values()) {
        if (other.id !== player.id) {
          other.ws.send(metaMessage);
        }
      }

      return;
    }

    if (!playerId) {
      return;
    }

    const player = players.get(playerId);
    if (!player) {
      return;
    }

    if (message.type === 'input') {
      player.inputQueue.push(message.input);
      return;
    }

    if (message.type === 'buy') {
      tryBuy(player, message.primary);
    }
  });

  ws.on('close', () => {
    if (playerId) {
      players.delete(playerId);
    }
  });
});

console.log(`Server running on ws://localhost:${PORT}`);
