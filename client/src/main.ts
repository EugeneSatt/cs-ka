/// <reference types="vite/client" />
import * as THREE from 'three';
import type {
  GrenadeSnapshot,
  InputPayload,
  MapData,
  ModelDef,
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
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BASE_FOV = 75;
const SNIPER_SCOPE_FOV = 12;
const RIFLE_SCOPE_FOV = 60;

const colliderParam = new URL(window.location.href).searchParams.get('colliders')?.toLowerCase() ?? '';
const showColliderModels = colliderParam === '1' || colliderParam === 'true' || colliderParam === 'all';
const showAllColliders = colliderParam === 'all';

const menu = document.getElementById('menu') as HTMLDivElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const primarySelect = document.getElementById('primary') as HTMLSelectElement;
const editorButton = document.getElementById('editor') as HTMLButtonElement;
const sideSelect = document.getElementById('side') as HTMLSelectElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const teamSizeSelect = document.getElementById('team-size') as HTMLSelectElement;
const nameInput = document.getElementById('player-name') as HTMLInputElement;
const faceInput = document.getElementById('face-upload') as HTMLInputElement;
const facePreview = document.getElementById('face-preview') as HTMLImageElement | null;

const hudRound = document.getElementById('round') as HTMLDivElement;
const hudTimer = document.getElementById('timer') as HTMLDivElement;
const hudScore = document.getElementById('score') as HTMLDivElement;
const hudHp = document.getElementById('hp') as HTMLDivElement;
const hudAmmo = document.getElementById('ammo') as HTMLDivElement;
const hudGrenades = document.getElementById('grenades') as HTMLDivElement;
const hudStatus = document.getElementById('status') as HTMLDivElement;
const hudKda = document.getElementById('kda') as HTMLDivElement;
const hudFps = document.getElementById('fps') as HTMLDivElement | null;
const buyMenu = document.getElementById('buy-menu') as HTMLDivElement;
const crosshair = document.getElementById('crosshair') as HTMLDivElement;
const scopeOverlay = document.createElement('div');
scopeOverlay.id = 'scope-overlay';
document.body.appendChild(scopeOverlay);

// Reduce quality slightly for performance: disable full antialias and cap DPR.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const MAX_DPR = 1.25;
const MIN_DPR = 0.7;
const DPR_STEP = 0.1;
const LOW_FPS = 50;
const HIGH_FPS = 70;
const DPR_ADJUST_INTERVAL = 700;
const MAX_ANISOTROPY = 4;
const TEXTURE_REPEAT_SCALE = 4;
let baseDpr = Math.min(window.devicePixelRatio, MAX_DPR);
let dynamicDpr = baseDpr;
renderer.setPixelRatio(dynamicDpr);
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
const mapMaterialCache = new Map<string, THREE.MeshLambertMaterial>();
const mapGeometryCache = new Map<string, THREE.BoxGeometry>();
const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');
ktx2Loader.detectSupport(renderer);
gltfLoader.setKTX2Loader(ktx2Loader);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

scene.add(new THREE.HemisphereLight(0xffffff, 0x1c1f22, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 5);
scene.add(dirLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  baseDpr = Math.min(window.devicePixelRatio, MAX_DPR);
  dynamicDpr = Math.min(dynamicDpr, baseDpr);
  renderer.setPixelRatio(dynamicDpr);
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
let faceDataUrl: string | null = null;
const playerFaces = new Map<string, string | null>();
const faceTextureCache = new Map<string, THREE.Texture>();

const PITCH_LIMIT = 1.5;
const RECOIL_RETURN_SPEED = 14;
const RECOIL_MAX = 0.35;
const RECOIL_KICK: Record<'rifle' | 'sniper' | 'shotgun' | 'pistol', number> = {
  rifle: 0.03,
  sniper: 0,
  shotgun: 0.06,
  pistol: 0.02,
};

type WeaponViewConfig = {
  path: string;
  pos: Vec3;
  rot: Vec3;
  scale: number | Vec3;
};

type ViewWeaponType = WeaponType | 'pistol';
type HeldWeaponConfig = {
  path: string;
  pos: Vec3;
  rot: Vec3;
  scale: number | Vec3;
};

const FIRST_PERSON_WEAPONS: Partial<Record<ViewWeaponType, WeaponViewConfig>> = {
  rifle: {
    path: '/ak-47.glb',
    pos: [0.06, -0.22, -0.45],
    rot: [-0.05, Math.PI, 0],
    scale: 0.95,
  },
  pistol: {
    path: '/beretta.glb',
    pos: [0.05, -0.2, -0.4],
    rot: [-0.02, Math.PI, 0],
    scale: 0.55,
  },
  sniper: {
    path: '/awp.glb',
    pos: [0.05, -0.25, -0.5],
    rot: [-0.02, Math.PI, 0],
    scale: 0.9,
  },
  shotgun: {
    path: '/spas_12.glb',
    pos: [0.06, -0.22, -0.45],
    rot: [-0.03, Math.PI, 0],
    scale: 0.9,
  },
};

const HELD_WEAPONS: Partial<Record<ViewWeaponType, HeldWeaponConfig>> = {
  rifle: {
    path: '/ak-47.glb',
    pos: [0, 1.1, -0.35],
    rot: [0, Math.PI, 0],
    scale: 0.55,
  },
  pistol: {
    path: '/beretta.glb',
    pos: [0, 1.05, -0.28],
    rot: [0, Math.PI, 0],
    scale: 0.5,
  },
  sniper: {
    path: '/awp.glb',
    pos: [0, 1.12, -0.38],
    rot: [0, Math.PI, 0],
    scale: 0.6,
  },
  shotgun: {
    path: '/spas_12.glb',
    pos: [0, 1.1, -0.35],
    rot: [0, Math.PI, 0],
    scale: 0.58,
  },
};

let socket: WebSocket | null = null;
let clientId = '';
let mapData: MapData | null = null;
let mapGroup: THREE.Group | null = null;
let colliderGroup: THREE.Group | null = null;
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
const decorCullList: Array<{ object: THREE.Object3D; center: THREE.Vector3; radius: number }> = [];
const DECOR_CULL_DISTANCE = 55;
const DECOR_CULL_INTERVAL = 200;
let lastDecorCull = 0;

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
viewWeaponGroup.renderOrder = 100;
let viewWeaponType: ViewWeaponType | null = null;
let viewWeaponRequest = 0;
let weaponBobPhase = 0;

type EditorSession = {
  active: boolean;
  pos: Vec3;
  yaw: number;
  pitch: number;
};

const EDITOR_STORAGE_KEY = 'csvert-editor-session';
const NAME_STORAGE_KEY = 'csvert-player-name';
const FACE_STORAGE_KEY = 'csvert-player-face';

function coerceMapData(data: unknown): MapData {
  return data as MapData;
}

let currentEditorMap: MapData = coerceMapData(editorMap);
let lastEditorPersist = 0;

type Tracer = { mesh: THREE.Line; expire: number };
const tracers: Tracer[] = [];
type HumanoidParts = {
  head: THREE.Group;
  headMesh: THREE.Mesh;
  facePlane: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  weaponGroup: THREE.Group;
  weaponType: ViewWeaponType | null;
  weaponRequestId: number;
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
  const serverParam = new URL(window.location.href).searchParams.get('server');
  const envUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined;
  const wsUrl = serverParam ?? envUrl ?? `ws://${window.location.hostname}:8080`;

  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    const name = nameInput?.value.trim();
    const join = {
      type: 'join',
      name: name || undefined,
      face: faceDataUrl || undefined,
      primary,
      preferredSide: sideSelect.value as Side,
      matchMode,
      teamSize,
    };
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
      if (msg.playersMeta) {
        for (const meta of msg.playersMeta) {
          playerFaces.set(meta.id, meta.face ?? null);
        }
      }
    }
    if (msg.type === 'snapshot') {
      handleSnapshot(msg);
    }
    if (msg.type === 'player_meta') {
      playerFaces.set(msg.player.id, msg.player.face ?? null);
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

function setFaceDataUrl(url: string | null) {
  faceDataUrl = url;
  if (facePreview) {
    if (url) {
      facePreview.src = url;
      facePreview.classList.remove('hidden');
    } else {
      facePreview.removeAttribute('src');
      facePreview.classList.add('hidden');
    }
  }
  if (url) {
    localStorage.setItem(FACE_STORAGE_KEY, url);
  } else {
    localStorage.removeItem(FACE_STORAGE_KEY);
  }
}

function processFaceFile(file: File) {
  const size = 160;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    const scale = Math.max(size / img.width, size / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const dx = (size - drawW) * 0.5;
    const dy = (size - drawH) * 0.5;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, dx, dy, drawW, drawH);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    setFaceDataUrl(dataUrl);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

modeSelect.addEventListener('change', () => {
  refreshModeUI();
});

const storedName = localStorage.getItem(NAME_STORAGE_KEY);
if (storedName && nameInput) {
  nameInput.value = storedName;
}
if (nameInput) {
  nameInput.addEventListener('input', () => {
    localStorage.setItem(NAME_STORAGE_KEY, nameInput.value.trim());
  });
}
const storedFace = localStorage.getItem(FACE_STORAGE_KEY);
if (storedFace) {
  setFaceDataUrl(storedFace);
}
if (faceInput) {
  faceInput.addEventListener('change', () => {
    const file = faceInput.files?.[0];
    if (!file) {
      setFaceDataUrl(null);
      return;
    }
    processFaceFile(file);
  });
}

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
    if (currentWeapon === 'primary' && localState.primary === 'sniper') {
      scopeHeld = !scopeHeld;
    }
  }
});

document.addEventListener('mouseup', (event) => {
  if (event.button === 0) {
    inputState.shoot = false;
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
  if (hudFps) {
    hudFps.textContent = 'FPS 0';
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
  if (colliderGroup) {
    scene.remove(colliderGroup);
    colliderGroup = null;
  }
  decorCullList.length = 0;
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
    tex.repeat.set(1, 1);
    tex.anisotropy = Math.min(MAX_ANISOTROPY, renderer.capabilities.getMaxAnisotropy?.() ?? 1);
    textureCache.set(path, tex);
  }
  return tex;
}

function getMapMaterial(texturePath?: string, color?: string): THREE.MeshLambertMaterial {
  const key = texturePath ? `tex:${texturePath}` : `color:${color ?? '#ffffff'}`;
  let material = mapMaterialCache.get(key);
  if (!material) {
    const params: THREE.MeshLambertMaterialParameters = {
      color: texturePath ? 0xffffff : color ?? '#ffffff',
    };
    if (texturePath) {
      params.map = getTexture(texturePath);
    }
    material = new THREE.MeshLambertMaterial(params);
    mapMaterialCache.set(key, material);
  }
  return material;
}

function getBoxGeometry(size: THREE.Vector3, repeatU: number, repeatV: number): THREE.BoxGeometry {
  const key = `${size.x.toFixed(3)}|${size.y.toFixed(3)}|${size.z.toFixed(3)}|${repeatU.toFixed(3)}|${repeatV.toFixed(3)}`;
  let geometry = mapGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    if (repeatU !== 1 || repeatV !== 1) {
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setXY(i, uv.getX(i) * repeatU, uv.getY(i) * repeatV);
      }
      uv.needsUpdate = true;
    }
    mapGeometryCache.set(key, geometry);
  }
  return geometry;
}

function getModel(path: string): Promise<THREE.Group> {
  let promise = gltfCache.get(path);
  if (!promise) {
    promise = gltfLoader.loadAsync(path).then((gltf) => gltf.scene);
    gltfCache.set(path, promise);
  }
  return promise;
}

function getFaceTexture(url: string): THREE.Texture {
  let tex = faceTextureCache.get(url);
  if (!tex) {
    tex = textureLoader.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    faceTextureCache.set(url, tex);
  }
  return tex;
}

function applyFaceTexture(facePlane: THREE.Mesh, faceUrl: string | null | undefined) {
  const material = facePlane.material as THREE.MeshStandardMaterial;
  const nextMap = faceUrl ? getFaceTexture(faceUrl) : null;
  const nextOpacity = faceUrl ? 1 : 0;
  if (material.map !== nextMap || material.opacity !== nextOpacity) {
    material.map = nextMap;
    material.opacity = nextOpacity;
    material.needsUpdate = true;
  }
}

function createNameSprite(label: string): THREE.Sprite {
  const fontSize = 36;
  const paddingX = 14;
  const paddingY = 8;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const fallback = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff }));
    fallback.scale.set(1, 0.3, 1);
    return fallback;
  }
  ctx.font = `600 ${fontSize}px "Space Grotesk", sans-serif`;
  const textWidth = Math.max(10, ctx.measureText(label).width);
  canvas.width = Math.ceil(textWidth + paddingX * 2);
  canvas.height = fontSize + paddingY * 2;
  ctx.font = `600 ${fontSize}px "Space Grotesk", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(10, 12, 15, 0.72)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f6f7fb';
  ctx.fillText(label, paddingX, canvas.height * 0.5);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  const scale = 0.008;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  sprite.position.set(0, 2.05, 0);
  sprite.renderOrder = 150;
  sprite.frustumCulled = false;
  return sprite;
}

function updateNameSprite(mesh: THREE.Group, label: string) {
  const current = mesh.userData.nameLabel as string | undefined;
  if (current === label) {
    return;
  }
  const existing = mesh.userData.nameSprite as THREE.Sprite | undefined;
  if (existing) {
    mesh.remove(existing);
    const material = existing.material as THREE.SpriteMaterial;
    material.map?.dispose();
    material.dispose();
  }
  const sprite = createNameSprite(label);
  mesh.add(sprite);
  mesh.userData.nameSprite = sprite;
  mesh.userData.nameLabel = label;
  mesh.userData.nameSpriteBaseScale = sprite.scale.clone();
}

function getModelScaleVec(scale?: number | Vec3): THREE.Vector3 {
  if (scale === undefined) {
    return new THREE.Vector3(1, 1, 1);
  }
  if (typeof scale === 'number') {
    return new THREE.Vector3(scale, scale, scale);
  }
  return new THREE.Vector3(scale[0], scale[1], scale[2]);
}

function buildModelMatrix(model: ModelDef): THREE.Matrix4 {
  const pos = new THREE.Vector3(model.pos[0], model.pos[1], model.pos[2]);
  const rot = model.rot ? new THREE.Euler(model.rot[0], model.rot[1], model.rot[2]) : new THREE.Euler();
  const scale = getModelScaleVec(model.scale);
  const quat = new THREE.Quaternion().setFromEuler(rot);
  return new THREE.Matrix4().compose(pos, quat, scale);
}

function addDecorCullEntry(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  decorCullList.push({ object, center: sphere.center, radius: sphere.radius });
}

function getSingleMeshForInstancing(prefab: THREE.Group): THREE.Mesh | null {
  let mesh: THREE.Mesh | null = null;
  let valid = true;
  prefab.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
      valid = false;
      return;
    }
    if ((child as THREE.Mesh).isMesh) {
      if (mesh) {
        valid = false;
        return;
      }
      mesh = child as THREE.Mesh;
    }
  });
  if (
    !valid ||
    !mesh ||
    Array.isArray(mesh.material) ||
    (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0)
  ) {
    return null;
  }
  return mesh;
}

function setViewWeapon(type: ViewWeaponType | null) {
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
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const targetHeight = 1;
      const baseScale = size.y > 0 ? targetHeight / size.y : 1;
      const scaleVec = new THREE.Vector3();
      if (typeof config.scale === 'number') {
        scaleVec.setScalar(baseScale * config.scale);
      } else {
        scaleVec.set(
          baseScale * config.scale[0],
          baseScale * config.scale[1],
          baseScale * config.scale[2]
        );
      }
      instance.scale.copy(scaleVec);
      instance.position.set(
        config.pos[0] - center.x * scaleVec.x,
        config.pos[1] - center.y * scaleVec.y,
        config.pos[2] - center.z * scaleVec.z
      );
      instance.rotation.set(config.rot[0], config.rot[1], config.rot[2]);
      instance.updateMatrixWorld(true);
      const localBox = new THREE.Box3().setFromObject(instance);
      const inverse = new THREE.Matrix4().copy(instance.matrixWorld).invert();
      localBox.applyMatrix4(inverse);
      const hitSize = new THREE.Vector3();
      const hitCenter = new THREE.Vector3();
      localBox.getSize(hitSize);
      localBox.getCenter(hitCenter);
      const drawHitbox = hitSize.lengthSq() > 0;
      instance.traverse((child) => {
        child.castShadow = false;
        child.receiveShadow = false;
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.renderOrder = 100;
          mesh.frustumCulled = false;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            material.depthTest = false;
            material.depthWrite = false;
          }
        }
      });
      if (drawHitbox) {
        const hitGeo = new THREE.BoxGeometry(hitSize.x, hitSize.y, hitSize.z);
        const hitMat = new THREE.MeshBasicMaterial({
          color: 0x00ff66,
          wireframe: true,
          transparent: true,
          opacity: 0.45,
          depthTest: false,
          depthWrite: false,
        });
        const hitMesh = new THREE.Mesh(hitGeo, hitMat);
        hitMesh.position.copy(hitCenter);
        hitMesh.renderOrder = 101;
        hitMesh.frustumCulled = false;
        hitMesh.matrixAutoUpdate = false;
        hitMesh.updateMatrix();
        instance.add(hitMesh);
      }
      viewWeaponGroup.add(instance);
    })
    .catch((err) => console.warn('Failed to load view weapon', config.path, err));
}

function setHeldWeapon(parts: HumanoidParts, type: ViewWeaponType | null) {
  if (parts.weaponType === type) {
    return;
  }
  parts.weaponType = type;
  parts.weaponGroup.clear();
  if (!type) {
    return;
  }
  const config = HELD_WEAPONS[type];
  if (!config) {
    return;
  }
  const requestId = parts.weaponRequestId + 1;
  parts.weaponRequestId = requestId;
  getModel(config.path)
    .then((prefab) => {
      if (parts.weaponRequestId !== requestId || parts.weaponType !== type) {
        return;
      }
      const instance = prefab.clone(true);
      const box = new THREE.Box3().setFromObject(instance);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const targetHeight = 0.5;
      const baseScale = size.y > 0 ? targetHeight / size.y : 1;
      const scaleVec = new THREE.Vector3();
      if (typeof config.scale === 'number') {
        scaleVec.setScalar(baseScale * config.scale);
      } else {
        scaleVec.set(
          baseScale * config.scale[0],
          baseScale * config.scale[1],
          baseScale * config.scale[2]
        );
      }
      instance.scale.copy(scaleVec);
      instance.position.set(
        config.pos[0] - center.x * scaleVec.x,
        config.pos[1] - center.y * scaleVec.y,
        config.pos[2] - center.z * scaleVec.z
      );
      instance.rotation.set(config.rot[0], config.rot[1], config.rot[2]);
      parts.weaponGroup.add(instance);
    })
    .catch((err) => console.warn('Failed to load held weapon', config.path, err));
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
  hudStatus.textContent = `Purchased: ${primary}`;
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
  playerFaces.clear();

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
  if (colliderGroup) {
    scene.remove(colliderGroup);
  }
  decorCullList.length = 0;
  const group = new THREE.Group();
  const boxBuckets = new Map<
    string,
    {
      geometry: THREE.BoxGeometry;
      material: THREE.MeshLambertMaterial;
      positions: THREE.Vector3[];
    }
  >();
  for (const box of map.boxes) {
    if (box.type === 'collider_model') {
      continue;
    }
    const size = new THREE.Vector3(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2]
    );
    const repeatU = box.texture ? Math.max(1, size.x / TEXTURE_REPEAT_SCALE) : 1;
    const repeatV = box.texture ? Math.max(1, size.z / TEXTURE_REPEAT_SCALE) : 1;
    const geometry = getBoxGeometry(size, repeatU, repeatV);
    const materialKey = box.texture ? `tex:${box.texture}` : `color:${box.color ?? '#ffffff'}`;
    const key = `${size.x.toFixed(3)}|${size.y.toFixed(3)}|${size.z.toFixed(3)}|${repeatU.toFixed(3)}|${repeatV.toFixed(3)}|${materialKey}`;
    let bucket = boxBuckets.get(key);
    if (!bucket) {
      bucket = {
        geometry,
        material: getMapMaterial(box.texture, box.color),
        positions: [],
      };
      boxBuckets.set(key, bucket);
    }
    bucket.positions.push(
      new THREE.Vector3(
        (box.min[0] + box.max[0]) * 0.5,
        (box.min[1] + box.max[1]) * 0.5,
        (box.min[2] + box.max[2]) * 0.5
      )
    );
  }

  for (const bucket of boxBuckets.values()) {
    if (bucket.positions.length === 1) {
      const mesh = new THREE.Mesh(bucket.geometry, bucket.material);
      mesh.position.copy(bucket.positions[0]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      continue;
    }
    const instanced = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.positions.length);
    instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < bucket.positions.length; i += 1) {
      matrix.setPosition(bucket.positions[i]);
      instanced.setMatrixAt(i, matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  }

  if (map.models) {
    const modelGroups = new Map<string, ModelDef[]>();
    for (const model of map.models) {
      const list = modelGroups.get(model.path);
      if (list) {
        list.push(model);
      } else {
        modelGroups.set(model.path, [model]);
      }
    }

    for (const [path, models] of modelGroups.entries()) {
      getModel(path).then((prefab) => {
        if (mapGroup !== group) {
          return;
        }

        let instancedBuilt = false;
        if (models.length > 1) {
          const mesh = getSingleMeshForInstancing(prefab);
          if (mesh) {
            prefab.updateMatrixWorld(true);
            mesh.updateMatrixWorld(true);
            const baseMatrix = new THREE.Matrix4().copy(mesh.matrixWorld);
            const geometry = mesh.geometry;
            const material = mesh.material as THREE.Material;
            const instanced = new THREE.InstancedMesh(geometry, material, models.length);
            instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);

            if (!geometry.boundingSphere) {
              geometry.computeBoundingSphere();
            }
            const baseSphere = geometry.boundingSphere;
            const baseScale = new THREE.Vector3().setFromMatrixScale(baseMatrix);
            const baseRadius =
              baseSphere?.radius !== undefined
                ? baseSphere.radius * Math.max(baseScale.x, baseScale.y, baseScale.z)
                : 1;
            const baseCenter = baseSphere ? baseSphere.center.clone().applyMatrix4(baseMatrix) : new THREE.Vector3();

            const min = new THREE.Vector3(Infinity, Infinity, Infinity);
            const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
            const tempMatrix = new THREE.Matrix4();
            const tempCenter = new THREE.Vector3();

            for (let i = 0; i < models.length; i += 1) {
              const model = models[i];
              const modelMatrix = buildModelMatrix(model);
              tempMatrix.copy(modelMatrix).multiply(baseMatrix);
              instanced.setMatrixAt(i, tempMatrix);

              const scale = getModelScaleVec(model.scale);
              const radius = baseRadius * Math.max(scale.x, scale.y, scale.z);
              tempCenter.copy(baseCenter).applyMatrix4(modelMatrix);
              min.x = Math.min(min.x, tempCenter.x - radius);
              min.y = Math.min(min.y, tempCenter.y - radius);
              min.z = Math.min(min.z, tempCenter.z - radius);
              max.x = Math.max(max.x, tempCenter.x + radius);
              max.y = Math.max(max.y, tempCenter.y + radius);
              max.z = Math.max(max.z, tempCenter.z + radius);
            }

            instanced.instanceMatrix.needsUpdate = true;
            instanced.castShadow = false;
            instanced.receiveShadow = false;
            group.add(instanced);

            if (models.length > 0) {
              const center = new THREE.Vector3(
                (min.x + max.x) * 0.5,
                (min.y + max.y) * 0.5,
                (min.z + max.z) * 0.5
              );
              const radius = center.distanceTo(max);
              decorCullList.push({ object: instanced, center, radius });
            }

            instancedBuilt = true;
          }
        }

        if (!instancedBuilt) {
          for (const model of models) {
            const instance = prefab.clone(true);
            instance.position.set(model.pos[0], model.pos[1], model.pos[2]);
            if (model.rot) {
              instance.rotation.set(model.rot[0], model.rot[1], model.rot[2]);
            }
            const scale = getModelScaleVec(model.scale);
            instance.scale.copy(scale);
            instance.traverse((child) => {
              child.castShadow = false;
              child.receiveShadow = false;
              if ((child as THREE.Mesh).isMesh) {
                child.matrixAutoUpdate = false;
                child.updateMatrix();
              }
            });
            instance.matrixAutoUpdate = false;
            instance.updateMatrix();
            instance.updateMatrixWorld(true);
            group.add(instance);
            addDecorCullEntry(instance);
          }
        }
      });
    }
  }
  scene.add(group);
  mapGroup = group;

  if (showColliderModels) {
    const debugGroup = new THREE.Group();
    const boxes = showAllColliders ? map.boxes : map.boxes.filter((box) => box.type === 'collider_model');
    for (const box of boxes) {
      const size = new THREE.Vector3(
        box.max[0] - box.min[0],
        box.max[1] - box.min[1],
        box.max[2] - box.min[2]
      );
      const geometry = getBoxGeometry(size, 1, 1);
      const material = new THREE.MeshBasicMaterial({
        color: box.type === 'collider_model' ? 0xff4d4d : 0x00b0ff,
        wireframe: true,
        transparent: true,
        opacity: 0.45,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        (box.min[0] + box.max[0]) * 0.5,
        (box.min[1] + box.max[1]) * 0.5,
        (box.min[2] + box.max[2]) * 0.5
      );
      mesh.renderOrder = 200;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      debugGroup.add(mesh);
    }
    scene.add(debugGroup);
    colliderGroup = debugGroup;
  }
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
    const mesh = playerMeshes.get(player.id);
    if (mesh) {
      updateNameSprite(mesh, player.name);
      const parts = mesh.userData.parts as HumanoidParts | undefined;
      if (parts) {
        applyFaceTexture(parts.facePlane, playerFaces.get(player.id) ?? null);
      }
    }
  }

  for (const [id, mesh] of playerMeshes.entries()) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      const sprite = mesh.userData.nameSprite as THREE.Sprite | undefined;
      if (sprite) {
        const material = sprite.material as THREE.SpriteMaterial;
        material.map?.dispose();
        material.dispose();
      }
      playerMeshes.delete(id);
      playerFaces.delete(id);
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
    hudStatus.textContent = `Waiting for players ${snapshot.round.presentPlayers}/${snapshot.round.neededPlayers}`;
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
          hudStatus.textContent = 'Victory';
        } else {
          hudStatus.textContent = 'Defeat';
        }
      } else {
        hudStatus.textContent = `Round: ${event.winnerSide}`;
      }
    }
    if (event.type === 'round_start') {
      hudStatus.textContent = `Round ${event.round} start.`;
    }
    if (event.type === 'round_draw') {
      hudStatus.textContent = 'Draw';
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
        hudStatus.textContent = `Top: ${winner.name} (${winner.kills})`;
      } else if (event.winners.length > 1) {
        const label = event.winners.map((winner) => `${winner.name} (${winner.kills})`).join(', ');
        hudStatus.textContent = `Top: ${label}`;
      } else {
        hudStatus.textContent = 'Match over.';
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

  const bodyColor = side === 'T' ? 0xd2a15b : 0x6aa6ff;
  const limbColor = side === 'T' ? 0xa0773b : 0x3f6fbf;
  const headColor = 0xf2c9a0;

  const baseGeo = new THREE.SphereGeometry(1, 18, 12);
  const limbGeo = new THREE.SphereGeometry(1, 14, 10);
  const headGeo = new THREE.BoxGeometry(0.44, 0.48, 0.44);

  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.7, metalness: 0.1 });
  const limbMat = new THREE.MeshStandardMaterial({ color: limbColor, roughness: 0.8, metalness: 0.05 });
  const headMat = new THREE.MeshStandardMaterial({ color: headColor, roughness: 0.6, metalness: 0.05 });

  const torso = new THREE.Mesh(baseGeo, bodyMat);
  torso.scale.set(0.35, 0.5, 0.22);
  torso.position.set(0, 1.0, 0);
  group.add(torso);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.42, 0);
  const headMesh = new THREE.Mesh(headGeo, headMat);
  headMesh.position.set(0, 0.16, 0);
  headPivot.add(headMesh);
  const facePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.44, 0.48),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      roughness: 0.6,
      metalness: 0.05,
      depthWrite: false,
    })
  );
  facePlane.position.set(0, 0.16, -0.23);
  facePlane.rotation.y = Math.PI;
  facePlane.renderOrder = 120;
  facePlane.frustumCulled = false;
  headPivot.add(facePlane);
  group.add(headPivot);

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.38, 1.15, 0);
  const leftArm = new THREE.Mesh(limbGeo, limbMat);
  leftArm.scale.set(0.12, 0.35, 0.12);
  leftArm.position.set(0, -0.25, 0);
  leftArmPivot.add(leftArm);
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.38, 1.15, 0);
  const rightArm = new THREE.Mesh(limbGeo, limbMat);
  rightArm.scale.set(0.12, 0.35, 0.12);
  rightArm.position.set(0, -0.25, 0);
  rightArmPivot.add(rightArm);
  group.add(rightArmPivot);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.16, 0.55, 0);
  const leftLeg = new THREE.Mesh(limbGeo, limbMat);
  leftLeg.scale.set(0.14, 0.42, 0.14);
  leftLeg.position.set(0, -0.3, 0);
  leftLegPivot.add(leftLeg);
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.16, 0.55, 0);
  const rightLeg = new THREE.Mesh(limbGeo, limbMat);
  rightLeg.scale.set(0.14, 0.42, 0.14);
  rightLeg.position.set(0, -0.3, 0);
  rightLegPivot.add(rightLeg);
  group.add(rightLegPivot);

  const weaponGroup = new THREE.Group();
  group.add(weaponGroup);

  group.userData.parts = {
    head: headPivot,
    headMesh,
    facePlane,
    leftArm: leftArmPivot,
    rightArm: rightArmPivot,
    leftLeg: leftLegPivot,
    rightLeg: rightLegPivot,
    weaponGroup,
    weaponType: null,
    weaponRequestId: 0,
  } satisfies HumanoidParts;

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
  if (currentWeapon !== 'primary' || localState.primary !== 'sniper') {
    scopeHeld = false;
  }
  const allow =
    scopeHeld &&
    pointerLocked &&
    !inEditor &&
    localState.alive &&
    currentWeapon === 'primary' &&
    localState.primary === 'sniper' &&
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
  const nowSeconds = now / 1000;
  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  updateFps(now);

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
    updateDecorCulling(now);
    renderer.render(scene, camera);
    return;
  }

  updateInputState();
  updateRecoil(dt);
  applyRecoil(nowSeconds);
  sendInput(dt);

  const renderTime = nowSeconds + serverTimeOffset - 0.1;

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
  updateDecorCulling(now);
  const activeViewWeapon: ViewWeaponType | null =
    !inEditor && localState.alive
      ? currentWeapon === 'primary'
        ? localState.primary
        : currentWeapon === 'pistol'
        ? 'pistol'
        : null
      : null;
  const showWeapon = Boolean(activeViewWeapon && FIRST_PERSON_WEAPONS[activeViewWeapon]);
  viewWeaponGroup.visible = showWeapon;
  setViewWeapon(showWeapon ? activeViewWeapon : null);
  if (showWeapon) {
    viewWeaponGroup.position.set(0, 0, 0);
    viewWeaponGroup.rotation.set(0, 0, 0);
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
let fpsLastSample = lastFrameTime;
let fpsFrameCount = 0;
let lastDprAdjust = lastFrameTime;

function updateFps(nowMs: number) {
  fpsFrameCount += 1;
  const elapsed = nowMs - fpsLastSample;
  if (elapsed < 250) {
    return;
  }
  const fps = Math.round((fpsFrameCount * 1000) / elapsed);
  if (hudFps) {
    hudFps.textContent = `FPS ${fps}`;
  }
  fpsFrameCount = 0;
  fpsLastSample = nowMs;
  if (nowMs - lastDprAdjust >= DPR_ADJUST_INTERVAL) {
    let nextDpr = dynamicDpr;
    if (fps < LOW_FPS) {
      nextDpr = Math.max(MIN_DPR, dynamicDpr - DPR_STEP);
    } else if (fps > HIGH_FPS) {
      nextDpr = Math.min(baseDpr, dynamicDpr + DPR_STEP);
    }
    if (Math.abs(nextDpr - dynamicDpr) > 0.001) {
      dynamicDpr = nextDpr;
      renderer.setPixelRatio(dynamicDpr);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
    lastDprAdjust = nowMs;
  }
}

function updateDecorCulling(nowMs: number) {
  if (!decorCullList.length) {
    return;
  }
  if (nowMs - lastDecorCull < DECOR_CULL_INTERVAL) {
    return;
  }
  lastDecorCull = nowMs;
  const camPos = camera.position;
  for (const entry of decorCullList) {
    const maxDist = DECOR_CULL_DISTANCE + entry.radius;
    entry.object.visible = camPos.distanceToSquared(entry.center) <= maxDist * maxDist;
  }
}

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
    const parts = mesh.userData.parts as HumanoidParts | undefined;
    if (parts) {
      const speedFactor = Math.min(1, speed / 4);
      const swing = Math.sin(renderTime * 8 + id.charCodeAt(0)) * 0.9 * speedFactor;
      parts.leftLeg.rotation.x = swing;
      parts.rightLeg.rotation.x = -swing;
      const holdAngle = -1.05;
      parts.leftArm.rotation.x = holdAngle - swing * 0.25;
      parts.rightArm.rotation.x = holdAngle + swing * 0.25;
      parts.leftArm.rotation.z = 0.3;
      parts.rightArm.rotation.z = -0.3;
      const headPitch = clamp(sample.pitch, -0.7, 0.7);
      parts.head.rotation.x = headPitch;
      const heldType: ViewWeaponType | null =
        sample.weapon === 'primary'
          ? sample.primary
          : sample.weapon === 'pistol'
          ? 'pistol'
          : null;
      setHeldWeapon(parts, heldType);
      parts.weaponGroup.visible = Boolean(heldType);
    }
    const nameSprite = mesh.userData.nameSprite as THREE.Sprite | undefined;
    if (nameSprite) {
      nameSprite.position.y = sample.crouching ? 1.7 : 2.05;
      const baseScale = mesh.userData.nameSpriteBaseScale as THREE.Vector3 | undefined;
      if (baseScale) {
        nameSprite.scale.set(baseScale.x, baseScale.y / scaleY, baseScale.z);
      }
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
