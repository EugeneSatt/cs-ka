/// <reference types="vite/client" />
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
import type { Side, WeaponSlot, WeaponType } from '../../shared/src/constants';
import {
  BUY_WINDOW,
  CROUCH_EYE_HEIGHT,
  EYE_HEIGHT,
  FREEZE_TIME,
  PLAYER_RADIUS,
  PLAYER_HEIGHT,
  ROUND_TIME,
  TOTAL_ROUNDS,
  WEAPON_CONFIG,
} from '../../shared/src/constants';
import { clamp, lerp, lerpAngle, vec3Lerp } from '../../shared/src/math';
import { isOnGround, movePlayer } from '../../shared/src/physics';
import editorMap from '../../shared/maps/arena.json';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const BASE_FOV = 75;
const SNIPER_SCOPE_FOV = 12;
const RIFLE_SCOPE_FOV = 60;

const menu = document.getElementById('menu') as HTMLDivElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const primarySelect = document.getElementById('primary') as HTMLSelectElement;
const editorButton = document.getElementById('editor') as HTMLButtonElement;
const sideSelect = document.getElementById('side') as HTMLSelectElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const teamSizeSelect = document.getElementById('team-size') as HTMLSelectElement;

const hudRound = document.getElementById('round') as HTMLDivElement;
const hudTimer = document.getElementById('timer') as HTMLDivElement;
const hudScore = document.getElementById('score') as HTMLDivElement;
const hudHp = document.getElementById('hp') as HTMLDivElement;
const hudAmmo = document.getElementById('ammo') as HTMLDivElement;
const hudGrenades = document.getElementById('grenades') as HTMLDivElement;
const hudStatus = document.getElementById('status') as HTMLDivElement;
const hudKda = document.getElementById('kda') as HTMLDivElement;
const buyMenu = document.getElementById('buy-menu') as HTMLDivElement;
const crosshair = document.getElementById('crosshair') as HTMLDivElement;
const scopeOverlay = document.createElement('div');
scopeOverlay.id = 'scope-overlay';
document.body.appendChild(scopeOverlay);

// Немного снижаем качество ради производительности: убираем full antialias и лимитируем DPR.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const MAX_DPR = 1.25;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0c1014);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map<string, THREE.Texture>();
const gltfLoader = new GLTFLoader();
const gltfCache = new Map<string, Promise<THREE.Group>>();

scene.add(new THREE.HemisphereLight(0xffffff, 0x1c1f22, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 5);
scene.add(dirLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const inputState = {
  forward: 0,
  strafe: 0,
  jump: false,
  crouch: false,
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
let scopeHeld = false;
let scoped = false;
let matchOverTimeout: number | null = null;

const PITCH_LIMIT = 1.5;
const RECOIL_RETURN_SPEED = 14;
const RECOIL_MAX = 0.35;
const RECOIL_KICK: Record<'rifle' | 'sniper' | 'shotgun' | 'pistol', number> = {
  rifle: 0.03,
  sniper: 0.08,
  shotgun: 0.06,
  pistol: 0.02,
};

type WeaponViewConfig = {
  path: string;
  pos: Vec3;
  rot: Vec3;
  scale: number | Vec3;
};

const FIRST_PERSON_WEAPONS: Partial<Record<WeaponType, WeaponViewConfig>> = {
  rifle: {
    path: '/ak-47.glb',
    pos: [0.28, -0.28, -0.55],
    rot: [-0.05, Math.PI, 0],
    scale: 0.95,
  },
  sniper: {
    path: '/awp.glb',
    pos: [0.28, -0.32, -0.6],
    rot: [-0.02, Math.PI, 0],
    scale: 0.9,
  },
  shotgun: {
    path: '/spas_12.glb',
    pos: [0.3, -0.26, -0.55],
    rot: [-0.03, Math.PI, 0],
    scale: 0.9,
  },
};

let socket: WebSocket | null = null;
let clientId = '';
let mapData: MapData | null = null;
let mapGroup: THREE.Group | null = null;
let latestSnapshot: ServerSnapshot | null = null;
let serverTimeOffset = 0;
let inMatch = false;
let leavingMatch = false;
let cleanedUp = false;
let inEditor = false;

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
  crouching: false,
  kills: 0,
  deaths: 0,
};

const playerMeshes = new Map<string, THREE.Group>();
const grenadeMeshes = new Map<string, THREE.Mesh>();

const snapshotBuffer: Array<{ time: number; players: Map<string, PlayerSnapshot> }> = [];

const editorState = {
  pos: [0, 6, 0] as Vec3,
  vel: [0, 0, 0] as Vec3,
  yaw: 0,
  pitch: 0,
  speed: 10,
};

let buyOpen = false;
let crosshairHitTimeout: number | null = null;
let spectateId: string | null = null;
const viewWeaponGroup = new THREE.Group();
camera.add(viewWeaponGroup);
let viewWeaponType: WeaponType | null = null;
let viewWeaponRequest = 0;
let weaponBobPhase = 0;

type EditorSession = {
  active: boolean;
  pos: Vec3;
  yaw: number;
  pitch: number;
};

const EDITOR_STORAGE_KEY = 'csvert-editor-session';

function coerceMapData(data: unknown): MapData {
  return data as MapData;
}

let currentEditorMap: MapData = coerceMapData(editorMap);
let lastEditorPersist = 0;

type Tracer = { mesh: THREE.Line; expire: number };
const tracers: Tracer[] = [];
type PlayerModelConfig = { path: string; scale: number; yOffset?: number; rotY?: number };
const PLAYER_MODELS: Record<Side, PlayerModelConfig> = {
  T: { path: '/terr.glb', scale: 1.1, yOffset: 0, rotY: Math.PI },
  CT: { path: '/fbi.glb', scale: 1.1, yOffset: 0, rotY: Math.PI },
};

if (import.meta.hot) {
  import.meta.hot.accept('../../shared/maps/arena.json', (mod) => {
    if (mod?.default) {
      currentEditorMap = coerceMapData(mod.default);
      if (inEditor) {
        mapData = currentEditorMap;
        buildMap(currentEditorMap);
      }
    }
  });
}

function connect() {
  cleanedUp = false;
  leavingMatch = false;
  const primary = primarySelect.value as WeaponType;
  const matchMode = modeSelect.value as 'team' | 'ffa';
  const teamSize = Number(teamSizeSelect.value) || 4;
  const serverUrl = new URL(window.location.href).searchParams.get('server');
  const wsUrl = serverUrl ?? `ws://${window.location.hostname}:8080`;

  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    const join = { type: 'join', primary, preferredSide: sideSelect.value as Side, matchMode, teamSize };
    socket?.send(JSON.stringify(join));
  });

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data) as ServerMessage;
    if (msg.type === 'welcome') {
      clientId = msg.id;
      mapData = msg.map;
      buildMap(msg.map);
      inMatch = true;
      menu.style.display = 'none';
    }
    if (msg.type === 'snapshot') {
      handleSnapshot(msg);
    }
  });

  socket.addEventListener('close', () => {
    handleDisconnect(leavingMatch);
  });
}

joinButton.addEventListener('click', () => {
  if (!socket) {
    connect();
  }
});

editorButton.addEventListener('click', () => {
  enterEditor();
});

function refreshModeUI() {
  const isTeam = modeSelect.value === 'team';
  sideSelect.classList.toggle('hidden', !isTeam);
  teamSizeSelect.classList.toggle('hidden', !isTeam);
  (sideSelect.previousElementSibling as HTMLElement | null)?.classList.toggle('hidden', !isTeam);
  (teamSizeSelect.previousElementSibling as HTMLElement | null)?.classList.toggle('hidden', !isTeam);
}

modeSelect.addEventListener('change', () => {
  refreshModeUI();
});

buyMenu.querySelectorAll('button[data-primary]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const value = (btn as HTMLButtonElement).dataset.primary as WeaponType;
    chooseBuy(value);
  });
});

renderer.domElement.addEventListener('click', () => {
  if (buyOpen) {
    return;
  }
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
  if (inEditor) {
    editorState.yaw -= dx * sensitivity;
    editorState.pitch = clamp(editorState.pitch - dy * sensitivity, -PITCH_LIMIT, PITCH_LIMIT);
  } else {
    baseYaw -= dx * sensitivity;
    basePitch -= dy * sensitivity;
    basePitch = clamp(basePitch, -PITCH_LIMIT, PITCH_LIMIT);
  }
});

document.addEventListener('mousedown', (event) => {
  if (event.button === 0) {
    inputState.shoot = true;
  }
  if (event.button === 2) {
    scopeHeld = true;
  }
});

document.addEventListener('mouseup', (event) => {
  if (event.button === 0) {
    inputState.shoot = false;
  }
  if (event.button === 2) {
    scopeHeld = false;
  }
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

document.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    if (inEditor) {
      exitEditor();
    } else {
      leaveMatch();
    }
    return;
  }

  if (event.code === 'KeyB') {
    if (!inEditor && canOpenBuy()) {
      toggleBuyMenu();
    }
    return;
  }

  if (buyOpen) {
    if (event.code === 'Digit1') {
      chooseBuy('rifle');
      return;
    }
    if (event.code === 'Digit2') {
      chooseBuy('sniper');
      return;
    }
    if (event.code === 'Digit3') {
      chooseBuy('shotgun');
      return;
    }
  }

  pressedKeys.add(event.code);

  if (event.code === 'Digit1') {
    currentWeapon = 'primary';
    scopeHeld = false;
  }
  if (event.code === 'Digit2') {
    currentWeapon = 'pistol';
    scopeHeld = false;
  }
  if (event.code === 'Digit3') {
    currentWeapon = 'grenade';
    scopeHeld = false;
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

function resetHud() {
  hudRound.textContent = 'Round -';
  hudTimer.textContent = '00:00';
  hudScore.textContent = 'A 0 - 0 B';
  hudHp.textContent = 'HP 100';
  hudAmmo.textContent = 'Ammo 0';
  hudGrenades.textContent = 'Grenade 0';
  if (hudKda) {
    hudKda.textContent = 'K/D 0/0';
  }
  buyMenu.classList.add('hidden');
  document.body.classList.remove('crosshair-hit');
  spectateId = null;
}

function clearMeshes() {
  for (const mesh of playerMeshes.values()) {
    scene.remove(mesh);
  }
  playerMeshes.clear();

  for (const mesh of grenadeMeshes.values()) {
    scene.remove(mesh);
  }
  grenadeMeshes.clear();

  if (mapGroup) {
    scene.remove(mapGroup);
    mapGroup = null;
  }
}

function resetEditorState() {
  editorState.pos = [0, 6, 0];
  editorState.vel = [0, 0, 0];
  editorState.yaw = 0;
  editorState.pitch = 0;
}

function saveEditorSession(session: EditorSession) {
  try {
    localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}

function loadEditorSession(): EditorSession | null {
  try {
    const raw = localStorage.getItem(EDITOR_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as EditorSession;
  } catch {
    return null;
  }
}

function restoreEditorSession() {
  const saved = loadEditorSession();
  if (saved?.active) {
    enterEditor(saved);
  } else {
    saveEditorSession({ active: false, pos: editorState.pos, yaw: editorState.yaw, pitch: editorState.pitch });
  }
}

function resetPlayState() {
  clearMeshes();
}

function flashCrosshairHit() {
  document.body.classList.add('crosshair-hit');
  if (crosshairHitTimeout !== null) {
    window.clearTimeout(crosshairHitTimeout);
  }
  crosshairHitTimeout = window.setTimeout(() => {
    document.body.classList.remove('crosshair-hit');
    crosshairHitTimeout = null;
  }, 180);
}

function updateSpectateTarget(playerMap: Map<string, PlayerSnapshot>) {
  if (localState.alive) {
    spectateId = null;
    return;
  }
  if (spectateId) {
    const target = playerMap.get(spectateId);
    if (target?.alive) {
      return;
    }
  }
  const alive = Array.from(playerMap.values()).filter((p) => p.alive && p.id !== clientId);
  spectateId = alive.length > 0 ? alive[0].id : null;
}

function getTexture(path: string): THREE.Texture {
  let tex = textureCache.get(path);
  if (!tex) {
    tex = textureLoader.load(path);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    textureCache.set(path, tex);
  }
  return tex;
}

function getModel(path: string): Promise<THREE.Group> {
  let promise = gltfCache.get(path);
  if (!promise) {
    promise = gltfLoader.loadAsync(path).then((gltf) => gltf.scene);
    gltfCache.set(path, promise);
  }
  return promise;
}

function setViewWeapon(type: WeaponType | null) {
  if (viewWeaponType === type) {
    return;
  }
  viewWeaponType = type;
  viewWeaponGroup.clear();
  if (!type) {
    return;
  }
  const config = FIRST_PERSON_WEAPONS[type];
  if (!config) {
    return;
  }
  const requestId = ++viewWeaponRequest;
  getModel(config.path)
    .then((prefab) => {
      if (viewWeaponType !== type || viewWeaponRequest !== requestId) {
        return;
      }
      const instance = prefab.clone(true);
      const box = new THREE.Box3().setFromObject(instance);
      const size = new THREE.Vector3();
      box.getSize(size);
      const targetHeight = 1;
      const baseScale = size.y > 0 ? targetHeight / size.y : 1;
      const scaleMul = typeof config.scale === 'number' ? config.scale : 1;
      instance.scale.setScalar(baseScale * scaleMul);
      instance.position.set(config.pos[0], config.pos[1], config.pos[2]);
      instance.rotation.set(config.rot[0], config.rot[1], config.rot[2]);
      instance.traverse((child) => {
        child.castShadow = false;
        child.receiveShadow = false;
      });
      viewWeaponGroup.add(instance);
    })
    .catch((err) => console.warn('Failed to load view weapon', config.path, err));
}

function roundElapsedSeconds(): number {
  if (!latestSnapshot) {
    return Infinity;
  }
  const state = latestSnapshot.round;
  if (state.phase === 'freeze') {
    return Math.max(0, FREEZE_TIME - state.freezeLeft);
  }
  if (state.phase === 'live') {
    return FREEZE_TIME + Math.max(0, ROUND_TIME - state.timeLeft);
  }
  return Infinity;
}

function canOpenBuy(): boolean {
  if (!latestSnapshot || inEditor) {
    return false;
  }
  if (!localState.alive) {
    return false;
  }
  if (latestSnapshot.round.phase === 'match_over' || latestSnapshot.round.phase === 'post') {
    return false;
  }
  return roundElapsedSeconds() <= BUY_WINDOW;
}

function toggleBuyMenu(forceClose = false) {
  if (forceClose || !canOpenBuy()) {
    buyOpen = false;
  } else {
    buyOpen = !buyOpen;
  }
  buyMenu.classList.toggle('hidden', !buyOpen);
}

function closeBuyMenu() {
  buyOpen = false;
  buyMenu.classList.add('hidden');
}

function sendBuy(primary: WeaponType) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !canOpenBuy()) {
    return;
  }
  socket.send(JSON.stringify({ type: 'buy', primary }));
  hudStatus.textContent = `Закуплено: ${primary}`;
}

function chooseBuy(primary: WeaponType) {
  sendBuy(primary);
  localState.primary = primary;
  localState.weapon = 'primary';
  localState.ammo.primary = WEAPON_CONFIG[primary].magSize;
  closeBuyMenu();
}

function resetLocalState() {
  clientId = '';
  mapData = null;
  latestSnapshot = null;
  serverTimeOffset = 0;
  snapshotBuffer.length = 0;
  pendingInputs.length = 0;
  pressedKeys.clear();

  inputState.forward = 0;
  inputState.strafe = 0;
  inputState.jump = false;
  inputState.shoot = false;
  inputState.reload = false;
  inputState.throwGrenade = false;

  localState.pos = [0, 0.1, 0];
  localState.vel = [0, 0, 0];
  localState.onGround = false;
  localState.hp = 100;
  localState.alive = false;
  localState.weapon = 'primary';
  localState.primary = primarySelect.value as WeaponType;
  localState.ammo.primary = WEAPON_CONFIG[localState.primary].magSize;
  localState.ammo.pistol = WEAPON_CONFIG.pistol.magSize;
  localState.grenades = 1;
  localState.crouching = false;
  localState.kills = 0;
  localState.deaths = 0;

  currentWeapon = 'primary';
  pointerLocked = false;
  baseYaw = 0;
  basePitch = 0;
  recoilPitch = 0;
  lastRecoilTime = 0;
  inputSeq = 0;
  document.exitPointerLock();
  buyOpen = false;
  scopeHeld = false;
  scoped = false;
  updateScope(true);
}

function handleDisconnect(userInitiated: boolean) {
  if (cleanedUp) {
    return;
  }
  if (matchOverTimeout !== null) {
    window.clearTimeout(matchOverTimeout);
    matchOverTimeout = null;
  }
  cleanedUp = true;
  inMatch = false;
  inEditor = false;
  socket = null;
  resetPlayState();
  resetLocalState();
  resetHud();
  hudStatus.textContent = userInitiated ? 'Returned to menu.' : 'Disconnected.';
  menu.style.display = 'flex';
  leavingMatch = false;
  closeBuyMenu();
}

function leaveMatch() {
  if (!inMatch && !socket) {
    menu.style.display = 'flex';
    return;
  }
  leavingMatch = true;
  socket?.close();
  handleDisconnect(true);
}

function enterEditor(saved?: EditorSession) {
  if (socket) {
    socket.close();
    handleDisconnect(true);
  }
  clearMeshes();
  inEditor = true;
  cleanedUp = false;
  closeBuyMenu();
  updateScope(true);
  if (saved) {
    editorState.pos = [...saved.pos];
    editorState.yaw = saved.yaw;
    editorState.pitch = saved.pitch;
  } else {
    resetEditorState();
  }
  hudStatus.textContent = 'Editor: WASD move, Space up, Shift/Ctrl down, Esc to exit.';
  menu.style.display = 'none';
  mapData = currentEditorMap;
  buildMap(mapData);
  saveEditorSession({
    active: true,
    pos: editorState.pos,
    yaw: editorState.yaw,
    pitch: editorState.pitch,
  });
}

function exitEditor() {
  inEditor = false;
  pointerLocked = false;
  document.exitPointerLock();
  resetEditorState();
  clearMeshes();
  mapData = null;
  resetHud();
  hudStatus.textContent = 'Editor closed.';
  menu.style.display = 'flex';
  saveEditorSession({ active: false, pos: editorState.pos, yaw: editorState.yaw, pitch: editorState.pitch });
  closeBuyMenu();
  updateScope(true);
}

resetHud();
refreshModeUI();
restoreEditorSession();

function buildMap(map: MapData) {
  if (mapGroup) {
    scene.remove(mapGroup);
  }
  const group = new THREE.Group();
  for (const box of map.boxes) {
    if (box.type === 'collider_model') {
      continue;
    }
    const size = new THREE.Vector3(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2]
    );
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const materialParams: THREE.MeshStandardMaterialParameters = { color: box.color ?? '#ffffff' };
    if (box.texture) {
      const baseTex = getTexture(box.texture);
      const tex = baseTex.clone();
      tex.repeat.set(Math.max(1, size.x / 4), Math.max(1, size.z / 4));
      materialParams.map = tex;
      materialParams.color = 0xffffff;
    }
    const material = new THREE.MeshStandardMaterial(materialParams);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      (box.min[0] + box.max[0]) * 0.5,
      (box.min[1] + box.max[1]) * 0.5,
      (box.min[2] + box.max[2]) * 0.5
    );
    group.add(mesh);
  }
  if (map.models) {
    for (const model of map.models) {
      getModel(model.path).then((prefab) => {
        if (mapGroup !== group) {
          return;
        }
        const instance = prefab.clone(true);
        instance.position.set(model.pos[0], model.pos[1], model.pos[2]);
        if (model.rot) {
          instance.rotation.set(model.rot[0], model.rot[1], model.rot[2]);
        }
        if (model.scale !== undefined) {
          if (typeof model.scale === 'number') {
            instance.scale.setScalar(model.scale);
          } else {
            instance.scale.set(model.scale[0], model.scale[1], model.scale[2]);
          }
        }
        group.add(instance);
      });
    }
  }
  scene.add(group);
  mapGroup = group;
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
    localState.crouching = me.crouching;
    localState.kills = me.kills ?? localState.kills;
    localState.deaths = me.deaths ?? localState.deaths;

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
  updateSpectateTarget(playerMap);

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
      const mesh = createPlayerMesh(player.side);
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
  const phase = snapshot.round.phase;
  const isFfa = snapshot.round.mode === 'ffa';
  const roundLabel =
    phase === 'waiting'
      ? `Waiting ${snapshot.round.presentPlayers}/${snapshot.round.neededPlayers}`
      : isFfa
      ? 'FFA'
      : `Round ${snapshot.round.round}/${TOTAL_ROUNDS}`;
  hudRound.textContent = `${roundLabel} (${phase})`;

  const phaseTime =
    phase === 'waiting'
      ? 0
      : phase === 'freeze'
      ? snapshot.round.freezeLeft
      : phase === 'post'
      ? snapshot.round.postLeft ?? 0
      : snapshot.round.timeLeft;
  const minutes = Math.max(0, Math.floor(phaseTime / 60));
  const seconds = Math.max(0, Math.floor(phaseTime % 60));
  hudTimer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  if (phase === 'waiting') {
    hudStatus.textContent = `Ожидание игроков ${snapshot.round.presentPlayers}/${snapshot.round.neededPlayers}`;
  }

  hudScore.textContent = isFfa
    ? `Players ${snapshot.round.presentPlayers}`
    : `A ${snapshot.round.scores.A} (${snapshot.round.sideByTeam.A}) - (${snapshot.round.sideByTeam.B}) ${snapshot.round.scores.B} B`;

  hudHp.textContent = `HP ${localState.hp}`;
  const ammoValue = localState.weapon === 'pistol' ? localState.ammo.pistol : localState.ammo.primary;
  hudAmmo.textContent = `Ammo ${ammoValue}`;
  hudGrenades.textContent = `Grenade ${localState.grenades}`;
  hudKda.textContent = `K/D ${localState.kills}/${localState.deaths}`;
  if (phase === 'post' && snapshot.round.postReason === 'draw') {
    hudStatus.textContent = 'Draw';
  }
}

function handleEvents(events: ServerSnapshot['events']) {
  for (const event of events) {
    if (event.type === 'round_end') {
      const me = latestSnapshot?.players.find((p) => p.id === clientId);
      if (me) {
        if (me.side === event.winnerSide) {
          hudStatus.textContent = 'Победа';
        } else {
          hudStatus.textContent = 'Поражение';
        }
      } else {
        hudStatus.textContent = `Round: ${event.winnerSide}`;
      }
    }
    if (event.type === 'round_start') {
      hudStatus.textContent = `Round ${event.round} start.`;
    }
    if (event.type === 'round_draw') {
      hudStatus.textContent = 'Ничья';
    }
    if (event.type === 'hit' && event.attackerId === clientId) {
      flashCrosshairHit();
    }
    if (event.type === 'kill' && event.attackerId === clientId) {
      flashCrosshairHit();
    }
    if (event.type === 'shot') {
      spawnTracer(event.origin, event.dir, event.distance);
    }
    if (event.type === 'match_over') {
      if (event.winners.length === 1) {
        const winner = event.winners[0];
        hudStatus.textContent = `Лучший: ${winner.name} (${winner.kills})`;
      } else if (event.winners.length > 1) {
        const label = event.winners.map((winner) => `${winner.name} (${winner.kills})`).join(', ');
        hudStatus.textContent = `Лучшие: ${label}`;
      } else {
        hudStatus.textContent = 'Матч завершен.';
      }
      if (matchOverTimeout !== null) {
        window.clearTimeout(matchOverTimeout);
      }
      matchOverTimeout = window.setTimeout(() => {
        if (!inEditor) {
          leaveMatch();
        }
      }, 3000);
    }
  }
}

function createPlayerMesh(side: Side): THREE.Group {
  const group = new THREE.Group();
  const hitbox = new THREE.Mesh(
    new THREE.BoxGeometry(PLAYER_RADIUS * 2, PLAYER_HEIGHT, PLAYER_RADIUS * 2),
    new THREE.MeshBasicMaterial({
      color: 0x00ff66,
      wireframe: true,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    })
  );
  hitbox.position.y = PLAYER_HEIGHT * 0.5;
  group.add(hitbox);

  const config = PLAYER_MODELS[side];
  getModel(config.path)
    .then((prefab) => {
      const instance = prefab.clone(true);
      const box = new THREE.Box3().setFromObject(instance);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scaleBase = size.y > 0 ? PLAYER_HEIGHT / size.y : 1;
      const finalScale = scaleBase * (config.scale ?? 1);
      instance.scale.setScalar(finalScale);
      const yOffset = -(box.min.y * finalScale) + (config.yOffset ?? 0);
      instance.position.set(0, yOffset, 0);
      instance.rotation.y = config.rotY ?? 0;
      instance.traverse((child) => {
        child.castShadow = true;
        child.receiveShadow = true;
      });
      group.add(instance);
      group.userData.model = instance;
    })
    .catch((err) => {
      console.warn('Failed to load player model', config.path, err);
    });
  return group;
}

function spawnTracer(origin: Vec3, dir: Vec3, distance: number) {
  const start = new THREE.Vector3(origin[0], origin[1], origin[2]);
  const end = new THREE.Vector3(
    origin[0] + dir[0] * distance,
    origin[1] + dir[1] * distance,
    origin[2] + dir[2] * distance
  );
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2 });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  tracers.push({ mesh: line, expire: performance.now() + 200 });
}

function updateTracers(now: number) {
  for (let i = tracers.length - 1; i >= 0; i -= 1) {
    const tracer = tracers[i];
    if (now >= tracer.expire) {
      scene.remove(tracer.mesh);
      tracer.mesh.geometry.dispose();
      (tracer.mesh.material as THREE.Material).dispose();
      tracers.splice(i, 1);
    }
  }
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
  inputState.crouch =
    pressedKeys.has('ControlLeft') ||
    pressedKeys.has('ControlRight') ||
    pressedKeys.has('ShiftLeft') ||
    pressedKeys.has('ShiftRight');
}

function updateEditorMovement(dt: number) {
  let forward = 0;
  let strafe = 0;
  if (pressedKeys.has('KeyW')) {
    forward += 1;
  }
  if (pressedKeys.has('KeyS')) {
    forward -= 1;
  }
  if (pressedKeys.has('KeyD')) {
    strafe += 1;
  }
  if (pressedKeys.has('KeyA')) {
    strafe -= 1;
  }

  const up = pressedKeys.has('Space') || pressedKeys.has('KeyE') ? 1 : 0;
  const down =
    pressedKeys.has('ShiftLeft') ||
    pressedKeys.has('ShiftRight') ||
    pressedKeys.has('ControlLeft') ||
    pressedKeys.has('ControlRight') ||
    pressedKeys.has('KeyQ')
      ? 1
      : 0;

  const forwardVec: Vec3 = [-Math.sin(editorState.yaw), 0, -Math.cos(editorState.yaw)];
  const rightVec: Vec3 = [Math.cos(editorState.yaw), 0, -Math.sin(editorState.yaw)];
  const move: Vec3 = [
    forwardVec[0] * forward + rightVec[0] * strafe,
    up - down,
    forwardVec[2] * forward + rightVec[2] * strafe,
  ];

  const len = Math.hypot(move[0], move[1], move[2]);
  if (len > 0) {
    move[0] /= len;
    move[1] /= len;
    move[2] /= len;
  }

  const speed = editorState.speed;
  editorState.pos[0] += move[0] * speed * dt;
  editorState.pos[1] += move[1] * speed * dt;
  editorState.pos[2] += move[2] * speed * dt;
}

function persistEditorSession(nowMs: number) {
  if (!inEditor) {
    return;
  }
  if (nowMs - lastEditorPersist < 200) {
    return;
  }
  lastEditorPersist = nowMs;
  saveEditorSession({
    active: true,
    pos: [...editorState.pos],
    yaw: editorState.yaw,
    pitch: editorState.pitch,
  });
}

function updateRecoil(dt: number) {
  const t = clamp(RECOIL_RETURN_SPEED * dt, 0, 1);
  recoilPitch = lerp(recoilPitch, 0, t);
}

function updateScope(forceOff = false) {
  if (forceOff) {
    scopeHeld = false;
  }
  const allow =
    scopeHeld &&
    pointerLocked &&
    !inEditor &&
    localState.alive &&
    currentWeapon === 'primary' &&
    latestSnapshot?.round.phase === 'live';
  let targetFov = BASE_FOV;
  if (allow) {
    targetFov = localState.primary === 'sniper' ? SNIPER_SCOPE_FOV : RIFLE_SCOPE_FOV;
  }
  if (Math.abs(camera.fov - targetFov) > 0.1) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }
  scoped = allow;
  scopeOverlay.classList.toggle('visible', scoped && localState.primary === 'sniper');
}

function applyRecoil(nowSeconds: number) {
  if (inEditor || !pointerLocked || !inputState.shoot) {
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
  if (inEditor) {
    inputState.reload = false;
    inputState.throwGrenade = false;
    return;
  }
  const phase = latestSnapshot?.round.phase;
  if (phase === 'post' || phase === 'match_over' || phase === 'waiting') {
    inputState.reload = false;
    inputState.throwGrenade = false;
    return;
  }
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
    crouch: inputState.crouch,
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
      { f: payload.move.f, s: payload.move.s, jump: payload.jump, crouch: payload.crouch },
      payload.yaw,
      payload.dt,
      mapData
    );
    localState.pos = moved.pos;
    localState.vel = moved.vel;
    localState.onGround = moved.onGround;
    localState.crouching = payload.crouch;
  }

  inputState.reload = false;
  inputState.throwGrenade = false;
}

function render() {
  requestAnimationFrame(render);
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  if (inEditor) {
    updateEditorMovement(dt);
    camera.position.set(editorState.pos[0], editorState.pos[1], editorState.pos[2]);
    camera.rotation.y = editorState.yaw;
    camera.rotation.x = editorState.pitch;
    if (camera.fov !== BASE_FOV) {
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();
    }
    persistEditorSession(now);
    renderer.render(scene, camera);
    return;
  }

  updateInputState();
  updateRecoil(dt);
  applyRecoil(now / 1000);
  sendInput(dt);

  const renderTime = performance.now() / 1000 + serverTimeOffset - 0.1;

  const view = getViewAngles();
  if (!localState.alive && spectateId) {
    const spectated = samplePlayer(spectateId, renderTime);
    if (spectated) {
      camera.position.set(spectated.pos[0], spectated.pos[1] + EYE_HEIGHT, spectated.pos[2]);
      camera.rotation.y = spectated.yaw;
      camera.rotation.x = spectated.pitch;
    }
  } else {
    const eyeHeight = localState.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
    camera.position.set(localState.pos[0], localState.pos[1] + eyeHeight, localState.pos[2]);
    camera.rotation.y = view.yaw;
    camera.rotation.x = view.pitch;
  }
  updateScope();
  const showWeapon =
    pointerLocked &&
    localState.alive &&
    currentWeapon === 'primary' &&
    Boolean(FIRST_PERSON_WEAPONS[localState.primary]) &&
    !inEditor;
  viewWeaponGroup.visible = showWeapon;
  setViewWeapon(showWeapon ? localState.primary : null);
  if (showWeapon) {
    const moveSpeed = Math.hypot(localState.vel[0], localState.vel[2]);
    weaponBobPhase += dt * Math.min(moveSpeed, 7) * 8;
    const bobX = Math.sin(weaponBobPhase) * 0.025;
    const bobY = Math.cos(weaponBobPhase * 0.5) * 0.02;
    viewWeaponGroup.position.set(bobX, bobY, 0);
    viewWeaponGroup.rotation.set(-Math.abs(Math.sin(weaponBobPhase)) * 0.03, 0, bobX * 0.8);
  } else {
    viewWeaponGroup.position.set(0, 0, 0);
    viewWeaponGroup.rotation.set(0, 0, 0);
  }
  if (buyOpen && !canOpenBuy()) {
    closeBuyMenu();
  }

  updateRemotePlayers(renderTime);
  updateTracers(now);
  renderer.render(scene, camera);
}

let lastFrameTime = performance.now();

function updateRemotePlayers(renderTime: number) {
  if (!latestSnapshot) {
    return;
  }

  for (const [id, mesh] of playerMeshes.entries()) {
    const sample = samplePlayer(id, renderTime);
    if (!sample) {
      mesh.visible = false;
      continue;
    }
    mesh.visible = sample.alive;
    const speed = Math.hypot(sample.vel[0], sample.vel[2]);
    const bob = Math.sin(renderTime * 8 + id.charCodeAt(0)) * (0.02 + 0.03 * Math.min(1, speed / 4));
    mesh.position.set(sample.pos[0], sample.pos[1] + bob, sample.pos[2]);
    const scaleY = sample.crouching ? 0.6 : 1;
    mesh.scale.set(1, scaleY, 1);
    mesh.rotation.y = sample.yaw;
    const model = mesh.userData.model as THREE.Object3D | undefined;
    if (model) {
      model.rotation.y = (PLAYER_MODELS[sample.side].rotY ?? 0) + sample.yaw;
      model.position.y = (PLAYER_MODELS[sample.side].yOffset ?? 0) + (sample.crouching ? -0.25 : 0);
      const walkTilt = Math.sin(renderTime * 10) * 0.05 * Math.min(1, speed / 4);
      model.rotation.x = walkTilt;
      model.rotation.z = -walkTilt * 0.4;
    }
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
