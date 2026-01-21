import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { MapData, ClientMessage, InputPayload, PlayerSnapshot, RoundState, ServerEvent } from '../../shared/src/types';
import { EYE_HEIGHT, GRENADE_CONFIG, PLAYER_HEIGHT, PLAYER_RADIUS, TICK_RATE, WEAPON_CONFIG } from '../../shared/src/constants';
import type { MatchTeam, Side, WeaponSlot, WeaponType } from '../../shared/src/constants';
import { clamp } from '../../shared/src/math';
import { movePlayer } from '../../shared/src/physics';
import { directionFromYawPitch, rayIntersectAABB } from '../../shared/src/ray';
import type { Vec3 } from '../../shared/src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mapFile = process.env.MAP ?? 'arena.json';
const mapPath = resolve(__dirname, '../../shared/maps', mapFile);
const mapData = JSON.parse(readFileSync(mapPath, 'utf8')) as MapData;

const PORT = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port: PORT });

const MAX_PLAYERS = 6;

type Player = {
  id: string;
  ws: WebSocket;
  name: string;
  matchTeam: MatchTeam;
  primary: WeaponType;
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
let nextGrenadeId = 1;

let gameTime = 0;
let round = 1;
let phase: RoundState['phase'] = 'freeze';
let freezeLeft = 10;
let timeLeft = 115;
const scores = { A: 0, B: 0 };
let pendingEvents: ServerEvent[] = [];

function sideByTeam(currentRound: number): { A: Side; B: Side } {
  if (currentRound <= 4) {
    return { A: 'T', B: 'CT' };
  }
  return { A: 'CT', B: 'T' };
}

function teamForSide(side: Side, currentRound: number): MatchTeam {
  const sides = sideByTeam(currentRound);
  return sides.A === side ? 'A' : 'B';
}

function playerSide(player: Player): Side {
  const sides = sideByTeam(round);
  return player.matchTeam === 'A' ? sides.A : sides.B;
}

function pickSpawn(side: Side): Vec3 {
  const options = mapData.spawns[side];
  if (!options || options.length === 0) {
    return [0, 0.1, 0];
  }
  const spawn = options[Math.floor(Math.random() * options.length)];
  return [spawn[0], spawn[1], spawn[2]];
}

function spawnPlayer(player: Player) {
  player.pos = pickSpawn(playerSide(player));
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
}

function startRound() {
  if (round > 8) {
    phase = 'match_over';
    return;
  }

  phase = 'freeze';
  freezeLeft = 10;
  timeLeft = 115;
  grenades.length = 0;

  for (const player of players.values()) {
    spawnPlayer(player);
  }

  pendingEvents.push({
    type: 'round_start',
    round,
    sideByTeam: sideByTeam(round),
  });
}

startRound();

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
  if (round > 8) {
    phase = 'match_over';
    return;
  }
  startRound();
}

function updateRound(dt: number) {
  if (phase === 'match_over') {
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
    endRound('CT', 'time');
    return;
  }

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
        { f: clamp(input.move.f, -1, 1), s: clamp(input.move.s, -1, 1), jump: input.jump },
        player.yaw,
        dt,
        mapData
      );
      player.pos = moved.pos;
      player.vel = moved.vel;
      player.onGround = moved.onGround;

      if (input.shoot) {
        tryShoot(player);
      }
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

  const origin: Vec3 = [player.pos[0], player.pos[1] + EYE_HEIGHT, player.pos[2]];

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

  const mapDist = raycastMap(origin, dir, range);
  const hit = raycastPlayers(origin, dir, range, player.id);

  const HIT_EPS = 0.01;
  if (!hit || hit.distance - HIT_EPS >= mapDist) {
    return;
  }

  const hitPoint: Vec3 = [
    origin[0] + dir[0] * hit.distance,
    origin[1] + dir[1] * hit.distance,
    origin[2] + dir[2] * hit.distance,
  ];
  const rel = hitPoint[1] - hit.player.pos[1];
  let multiplier = 1;
  if (rel > PLAYER_HEIGHT * 0.75) {
    multiplier = 3;
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
  for (const box of mapData.boxes) {
    const dist = rayIntersectAABB(origin, dir, box.min, box.max);
    if (dist !== null && dist >= 0 && dist < closest) {
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
    if (playerSide(player) === shooterSide) {
      continue;
    }

    const min: Vec3 = [
      player.pos[0] - PLAYER_RADIUS,
      player.pos[1],
      player.pos[2] - PLAYER_RADIUS,
    ];
    const max: Vec3 = [
      player.pos[0] + PLAYER_RADIUS,
      player.pos[1] + PLAYER_HEIGHT,
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

  const roundState: RoundState = {
    round,
    phase,
    timeLeft: Math.max(0, timeLeft),
    freezeLeft: Math.max(0, freezeLeft),
    scores: { ...scores },
    sideByTeam: sideByTeam(round),
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

      const teamCounts = { A: 0, B: 0 };
      for (const player of players.values()) {
        teamCounts[player.matchTeam] += 1;
      }

      let matchTeam: MatchTeam = teamCounts.A <= teamCounts.B ? 'A' : 'B';
      if (teamCounts[matchTeam] >= 3) {
        matchTeam = matchTeam === 'A' ? 'B' : 'A';
      }
      if (teamCounts[matchTeam] >= 3) {
        ws.close();
        return;
      }

      const id = `p${nextPlayerId++}`;
      playerId = id;
      const player: Player = {
        id,
        ws,
        name: message.name ?? id,
        matchTeam,
        primary: message.primary,
        weapon: 'primary',
        pos: [0, 0.1, 0],
        vel: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        hp: 100,
        alive: false,
        onGround: true,
        ammoPrimary: WEAPON_CONFIG[message.primary].magSize,
        ammoPistol: WEAPON_CONFIG.pistol.magSize,
        grenades: 1,
        lastSeq: 0,
        inputQueue: [],
        nextFireTime: 0,
        reloadEndTime: 0,
        reloading: null,
        pendingSpawn: false,
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
        })
      );

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
    }
  });

  ws.on('close', () => {
    if (playerId) {
      players.delete(playerId);
    }
  });
});

console.log(`Server running on ws://localhost:${PORT}`);
