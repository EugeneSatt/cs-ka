import * as THREE from 'three';
import type {
  GrenadeSnapshot,
  InputPayload,
  MapData,
  PlayerSnapshot,
  ServerMessage,
  ServerSnapshot,
  Vec3,
} from '../../shared/src/types';
import type { WeaponSlot, WeaponType } from '../../shared/src/constants';
import { EYE_HEIGHT, PLAYER_HEIGHT, WEAPON_CONFIG } from '../../shared/src/constants';
import { clamp, lerp, lerpAngle, vec3Lerp } from '../../shared/src/math';
import { isOnGround, movePlayer } from '../../shared/src/physics';

const menu = document.getElementById('menu') as HTMLDivElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const primarySelect = document.getElementById('primary') as HTMLSelectElement;

const hudRound = document.getElementById('round') as HTMLDivElement;
const hudTimer = document.getElementById('timer') as HTMLDivElement;
const hudScore = document.getElementById('score') as HTMLDivElement;
const hudHp = document.getElementById('hp') as HTMLDivElement;
const hudAmmo = document.getElementById('ammo') as HTMLDivElement;
const hudGrenades = document.getElementById('grenades') as HTMLDivElement;
const hudStatus = document.getElementById('status') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0c1014);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0xffffff, 0x1c1f22, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 5);
scene.add(dirLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const inputState = {
  forward: 0,
  strafe: 0,
  jump: false,
  shoot: false,
  reload: false,
  throwGrenade: false,
};

const pressedKeys = new Set<string>();
let currentWeapon: WeaponSlot = 'primary';
let pointerLocked = false;
let baseYaw = 0;
let basePitch = 0;
let recoilPitch = 0;
let lastRecoilTime = 0;

const PITCH_LIMIT = 1.5;
const RECOIL_RETURN_SPEED = 14;
const RECOIL_MAX = 0.35;
const RECOIL_KICK: Record<'rifle' | 'sniper' | 'shotgun' | 'pistol', number> = {
  rifle: 0.03,
  sniper: 0.08,
  shotgun: 0.06,
  pistol: 0.02,
};

let socket: WebSocket | null = null;
let clientId = '';
let mapData: MapData | null = null;
let latestSnapshot: ServerSnapshot | null = null;
let serverTimeOffset = 0;

const pendingInputs: InputPayload[] = [];
let inputSeq = 0;

const localState = {
  pos: [0, 0.1, 0] as Vec3,
  vel: [0, 0, 0] as Vec3,
  onGround: false,
  hp: 100,
  alive: false,
  weapon: 'primary' as WeaponSlot,
  primary: 'rifle' as WeaponType,
  ammo: { primary: 30, pistol: 12 },
  grenades: 1,
};

const playerMeshes = new Map<string, THREE.Group>();
const grenadeMeshes = new Map<string, THREE.Mesh>();

const snapshotBuffer: Array<{ time: number; players: Map<string, PlayerSnapshot> }> = [];

function connect() {
  const primary = primarySelect.value as WeaponType;
  const serverUrl = new URL(window.location.href).searchParams.get('server');
  const wsUrl = serverUrl ?? `ws://${window.location.hostname}:8080`;

  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    const join = { type: 'join', primary };
    socket?.send(JSON.stringify(join));
  });

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data) as ServerMessage;
    if (msg.type === 'welcome') {
      clientId = msg.id;
      mapData = msg.map;
      buildMap(msg.map);
      menu.style.display = 'none';
    }
    if (msg.type === 'snapshot') {
      handleSnapshot(msg);
    }
  });

  socket.addEventListener('close', () => {
    hudStatus.textContent = 'Disconnected.';
  });
}

joinButton.addEventListener('click', () => {
  if (!socket) {
    connect();
  }
});

renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});

document.addEventListener('mousemove', (event) => {
  if (!pointerLocked) {
    return;
  }
  const sensitivity = 0.0006;
  const maxDelta = 120;
  const dx = clamp(event.movementX, -maxDelta, maxDelta);
  const dy = clamp(event.movementY, -maxDelta, maxDelta);
  baseYaw -= dx * sensitivity;
  basePitch -= dy * sensitivity;
  basePitch = clamp(basePitch, -PITCH_LIMIT, PITCH_LIMIT);
});

document.addEventListener('mousedown', (event) => {
  if (event.button === 0) {
    inputState.shoot = true;
  }
});

document.addEventListener('mouseup', (event) => {
  if (event.button === 0) {
    inputState.shoot = false;
  }
});

document.addEventListener('keydown', (event) => {
  pressedKeys.add(event.code);

  if (event.code === 'Digit1') {
    currentWeapon = 'primary';
  }
  if (event.code === 'Digit2') {
    currentWeapon = 'pistol';
  }
  if (event.code === 'Digit3') {
    currentWeapon = 'grenade';
  }
  if (event.code === 'KeyR') {
    inputState.reload = true;
  }
  if (event.code === 'KeyG') {
    inputState.throwGrenade = true;
  }
});

document.addEventListener('keyup', (event) => {
  pressedKeys.delete(event.code);
});

function buildMap(map: MapData) {
  const group = new THREE.Group();
  for (const box of map.boxes) {
    const size = new THREE.Vector3(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2]
    );
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const material = new THREE.MeshStandardMaterial({ color: box.color ?? '#ffffff' });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      (box.min[0] + box.max[0]) * 0.5,
      (box.min[1] + box.max[1]) * 0.5,
      (box.min[2] + box.max[2]) * 0.5
    );
    group.add(mesh);
  }
  scene.add(group);
}

function handleSnapshot(snapshot: ServerSnapshot) {
  latestSnapshot = snapshot;

  const clientNow = performance.now() / 1000;
  const targetOffset = snapshot.now - clientNow;
  serverTimeOffset = serverTimeOffset === 0 ? targetOffset : serverTimeOffset * 0.9 + targetOffset * 0.1;

  const playerMap = new Map<string, PlayerSnapshot>();
  for (const player of snapshot.players) {
    playerMap.set(player.id, player);
  }

  snapshotBuffer.push({ time: snapshot.now, players: playerMap });
  if (snapshotBuffer.length > 30) {
    snapshotBuffer.shift();
  }

  const me = playerMap.get(clientId);
  if (me && mapData) {
    localState.hp = me.hp;
    localState.alive = me.alive;
    localState.weapon = me.weapon;
    localState.primary = me.primary;
    localState.ammo = { ...me.ammo };
    localState.grenades = me.grenades;

    localState.pos = [...me.pos];
    localState.vel = [...me.vel];
    localState.onGround = isOnGround(localState.pos, mapData);

    const lastSeq = me.lastSeq;
    while (pendingInputs.length > 0 && pendingInputs[0].seq <= lastSeq) {
      pendingInputs.shift();
    }
    for (const input of pendingInputs) {
      const moved = movePlayer(
        { pos: localState.pos, vel: localState.vel, onGround: localState.onGround },
        { f: input.move.f, s: input.move.s, jump: input.jump },
        input.yaw,
        input.dt,
        mapData
      );
      localState.pos = moved.pos;
      localState.vel = moved.vel;
      localState.onGround = moved.onGround;
    }
  }

  updatePlayerMeshes(snapshot.players);
  updateGrenadeMeshes(snapshot.grenades);
  updateHud(snapshot);
  handleEvents(snapshot.events);
}

function updatePlayerMeshes(players: PlayerSnapshot[]) {
  const seen = new Set<string>();
  for (const player of players) {
    seen.add(player.id);
    if (player.id === clientId) {
      continue;
    }
    if (!playerMeshes.has(player.id)) {
      const mesh = createPlayerMesh(player.side === 'T' ? 0xf39c4a : 0x4aa3f3);
      scene.add(mesh);
      playerMeshes.set(player.id, mesh);
    }
  }

  for (const [id, mesh] of playerMeshes.entries()) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      playerMeshes.delete(id);
    }
  }
}

function updateGrenadeMeshes(grenades: GrenadeSnapshot[]) {
  const seen = new Set<string>();
  for (const grenade of grenades) {
    seen.add(grenade.id);
    let mesh = grenadeMeshes.get(grenade.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x99aa00 })
      );
      scene.add(mesh);
      grenadeMeshes.set(grenade.id, mesh);
    }
    mesh.position.set(grenade.pos[0], grenade.pos[1], grenade.pos[2]);
  }

  for (const [id, mesh] of grenadeMeshes.entries()) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      grenadeMeshes.delete(id);
    }
  }
}

function updateHud(snapshot: ServerSnapshot) {
  hudRound.textContent = `Round ${snapshot.round.round}/8 (${snapshot.round.phase})`;

  const timeLeft = snapshot.round.phase === 'freeze' ? snapshot.round.freezeLeft : snapshot.round.timeLeft;
  const minutes = Math.max(0, Math.floor(timeLeft / 60));
  const seconds = Math.max(0, Math.floor(timeLeft % 60));
  hudTimer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  hudScore.textContent = `A ${snapshot.round.scores.A} (${snapshot.round.sideByTeam.A}) - (${snapshot.round.sideByTeam.B}) ${snapshot.round.scores.B} B`;

  hudHp.textContent = `HP ${localState.hp}`;
  const ammoValue = localState.weapon === 'pistol' ? localState.ammo.pistol : localState.ammo.primary;
  hudAmmo.textContent = `Ammo ${ammoValue}`;
  hudGrenades.textContent = `Grenade ${localState.grenades}`;
}

function handleEvents(events: ServerSnapshot['events']) {
  for (const event of events) {
    if (event.type === 'round_end') {
      hudStatus.textContent = `Round win: ${event.winnerSide} (${event.reason})`;
    }
    if (event.type === 'round_start') {
      hudStatus.textContent = `Round ${event.round} start.`;
    }
  }
}

function createPlayerMesh(color: number): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, PLAYER_HEIGHT * 0.75, 0.6),
    new THREE.MeshStandardMaterial({ color })
  );
  body.position.y = PLAYER_HEIGHT * 0.375;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2 })
  );
  head.position.y = PLAYER_HEIGHT * 0.85;
  group.add(body, head);
  return group;
}

function updateInputState() {
  inputState.forward = 0;
  inputState.strafe = 0;
  if (pressedKeys.has('KeyW')) {
    inputState.forward += 1;
  }
  if (pressedKeys.has('KeyS')) {
    inputState.forward -= 1;
  }
  if (pressedKeys.has('KeyD')) {
    inputState.strafe += 1;
  }
  if (pressedKeys.has('KeyA')) {
    inputState.strafe -= 1;
  }
  inputState.jump = pressedKeys.has('Space');
}

function updateRecoil(dt: number) {
  const t = clamp(RECOIL_RETURN_SPEED * dt, 0, 1);
  recoilPitch = lerp(recoilPitch, 0, t);
}

function applyRecoil(nowSeconds: number) {
  if (!pointerLocked || !inputState.shoot) {
    return;
  }
  if (!localState.alive || latestSnapshot?.round.phase !== 'live') {
    return;
  }
  if (currentWeapon === 'grenade') {
    return;
  }

  const weaponType = currentWeapon === 'primary' ? localState.primary : 'pistol';
  const config = WEAPON_CONFIG[weaponType];
  const cooldown = 1 / config.fireRate;
  if (nowSeconds - lastRecoilTime < cooldown) {
    return;
  }

  const ammo = weaponType === 'pistol' ? localState.ammo.pistol : localState.ammo.primary;
  if (ammo <= 0) {
    return;
  }

  recoilPitch = clamp(recoilPitch - RECOIL_KICK[weaponType], -RECOIL_MAX, 0);
  lastRecoilTime = nowSeconds;
}

function getViewAngles(): { yaw: number; pitch: number } {
  return {
    yaw: baseYaw,
    pitch: clamp(basePitch + recoilPitch, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

function sendInput(dt: number) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !mapData) {
    inputState.reload = false;
    inputState.throwGrenade = false;
    return;
  }

  const view = getViewAngles();
  const payload: InputPayload = {
    seq: inputSeq++,
    dt: clamp(dt, 0.001, 0.05),
    move: { f: clamp(inputState.forward, -1, 1), s: clamp(inputState.strafe, -1, 1) },
    yaw: view.yaw,
    pitch: view.pitch,
    jump: inputState.jump,
    shoot: pointerLocked && inputState.shoot,
    weapon: currentWeapon,
    reload: inputState.reload,
    throwGrenade: inputState.throwGrenade,
  };

  socket.send(JSON.stringify({ type: 'input', input: payload }));
  pendingInputs.push(payload);

  if (mapData && localState.alive && latestSnapshot?.round.phase === 'live') {
    const moved = movePlayer(
      { pos: localState.pos, vel: localState.vel, onGround: localState.onGround },
      { f: payload.move.f, s: payload.move.s, jump: payload.jump },
      payload.yaw,
      payload.dt,
      mapData
    );
    localState.pos = moved.pos;
    localState.vel = moved.vel;
    localState.onGround = moved.onGround;
  }

  inputState.reload = false;
  inputState.throwGrenade = false;
}

function render() {
  requestAnimationFrame(render);
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  updateInputState();
  updateRecoil(dt);
  applyRecoil(now / 1000);
  sendInput(dt);

  const view = getViewAngles();
  camera.position.set(localState.pos[0], localState.pos[1] + EYE_HEIGHT, localState.pos[2]);
  camera.rotation.y = view.yaw;
  camera.rotation.x = view.pitch;

  updateRemotePlayers();
  renderer.render(scene, camera);
}

let lastFrameTime = performance.now();

function updateRemotePlayers() {
  if (!latestSnapshot) {
    return;
  }
  const renderTime = performance.now() / 1000 + serverTimeOffset - 0.1;

  for (const [id, mesh] of playerMeshes.entries()) {
    const sample = samplePlayer(id, renderTime);
    if (!sample) {
      mesh.visible = false;
      continue;
    }
    mesh.visible = sample.alive;
    mesh.position.set(sample.pos[0], sample.pos[1], sample.pos[2]);
    mesh.rotation.y = sample.yaw;
  }
}

function samplePlayer(id: string, renderTime: number): PlayerSnapshot | null {
  if (snapshotBuffer.length === 0) {
    return null;
  }

  let newerIndex = snapshotBuffer.findIndex((entry) => entry.time >= renderTime);
  if (newerIndex === -1) {
    newerIndex = snapshotBuffer.length - 1;
  }
  const olderIndex = Math.max(0, newerIndex - 1);
  const older = snapshotBuffer[olderIndex];
  const newer = snapshotBuffer[newerIndex];

  const olderPlayer = older.players.get(id);
  const newerPlayer = newer.players.get(id);
  if (!olderPlayer || !newerPlayer) {
    return newerPlayer ?? olderPlayer ?? null;
  }

  if (older.time === newer.time) {
    return newerPlayer;
  }

  const t = clamp((renderTime - older.time) / (newer.time - older.time), 0, 1);

  return {
    ...newerPlayer,
    pos: vec3Lerp(olderPlayer.pos, newerPlayer.pos, t),
    yaw: lerpAngle(olderPlayer.yaw, newerPlayer.yaw, t),
    pitch: lerpAngle(olderPlayer.pitch, newerPlayer.pitch, t),
  };
}

render();
