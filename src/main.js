// Turbo Kart Rally — bootstrap, renderer, post-processing, game state machine and main loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { bus } from './events.js';
import { CHARACTERS, RACE, PHYSICS } from './config.js';
import { rotatingTrackId, getTrackDef } from './tracks.js';
import { createHazards } from './hazards.js';
import { RaceManager } from './race.js';
import { HUD } from './hud.js';
import { Menu } from './menu.js';
import { AudioEngine } from './audio.js';
import { HostNetworkClient } from './multiplayer/network-client.js';
import { EventUI } from './event/event-ui.js';
import { SplitScreen, SCALE_TIERS } from './event/splitscreen.js';
import { SplitHUD } from './event/split-hud.js';
import { createNameTag, disposeNameTag, TAG_LAYER_BASE } from './event/nametags.js';

// ---------------------------------------------------------------------------------------------
// Error isolation: one failing subsystem must never freeze the loop. Log once per error type.
// ---------------------------------------------------------------------------------------------
const seenErrors = new Set();
function report(tag, err) {
  const key = tag + '|' + (err && err.message);
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  console.error(`[${tag}]`, err);
}
function safe(tag, fn) {
  try { return fn(); } catch (err) { report(tag, err); return undefined; }
}

// ---------------------------------------------------------------------------------------------
// Renderer / camera / post
// ---------------------------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas');
const uiRoot = document.getElementById('ui-root');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(0, 30, 60);

const fallbackScene = new THREE.Scene();
fallbackScene.background = new THREE.Color(0x2a6fdb);

const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
composer.setSize(window.innerWidth, window.innerHeight);
const renderPass = new RenderPass(fallbackScene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.32, 0.45, 0.88);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // in event mode the split renderer owns the pixel ratio + buffer size (quality tier)
  if (split) split._applyTier();
  else { renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(w, h, false); }
  composer.setSize(w, h);
  bloom.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ---------------------------------------------------------------------------------------------
// Modules from other agents are loaded dynamically so a broken file degrades instead of killing the game.
// ---------------------------------------------------------------------------------------------
const mods = {};
async function loadModules() {
  const specs = {
    track: './track.js', kart: './kart.js', ai: './ai.js', input: './input.js',
    items: './items.js', effects: './effects.js', models: './models.js', camera: './camera.js',
  };
  await Promise.all(Object.entries(specs).map(async ([k, p]) => {
    try { mods[k] = await import(p); } catch (e) { console.error(`[main] failed to load ${p}`, e); }
  }));
}

// ---- fallbacks -------------------------------------------------------------------------------
function fallbackKartModel(character) {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: character ? character.color : 0xff0000 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.4), mat);
  body.position.y = 0.5; body.castShadow = true; root.add(body);
  const anchors = {};
  for (const [n, x, y, z] of [['exhaustL', 0.4, 0.5, -1.3], ['exhaustR', -0.4, 0.5, -1.3], ['wheelRL', 0.8, 0.3, -0.8], ['wheelRR', -0.8, 0.3, -0.8],
    ['wheelFL', 0.8, 0.3, 0.8], ['wheelFR', -0.8, 0.3, 0.8], ['itemHold', 0, 0.6, -1.8]]) {
    const o = new THREE.Object3D(); o.position.set(x, y, z); root.add(o); anchors[n] = o;
  }
  return { root, anchors, animate() {}, setShrunk(s) { root.scale.setScalar(s); }, dispose() { body.geometry.dispose(); mat.dispose(); } };
}
function makeKartModel(character) {
  if (mods.models && mods.models.createKartModel) {
    try { return mods.models.createKartModel(character); } catch (e) { report('models.createKartModel', e); }
  }
  return fallbackKartModel(character);
}

class FallbackAI {
  constructor(kart, track) { this.kart = kart; this.track = track; }
  update() {
    const k = this.kart, tr = this.track;
    const p = tr.getPointAt(((k.trackT || 0) + 25 / (tr.length || 2000)) % 1);
    const dx = p.x - k.position.x, dz = p.z - k.position.z;
    const want = Math.atan2(dx, dz);
    let d = want - k.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
    k.input = { throttle: 1, brake: 0, steer: THREE.MathUtils.clamp(-d * 2, -1, 1), drift: false, item: !!k.item && Math.random() < 0.01, lookBack: false };
  }
}

class FallbackCamera {
  constructor(cam) { this.cam = cam; this.pos = new THREE.Vector3(); this.look = new THREE.Vector3(); }
  snap(k) { this._target(k, this.pos, this.look); this.cam.position.copy(this.pos); this.cam.lookAt(this.look); }
  _target(k, pos, look) {
    const h = k.heading || 0;
    pos.set(k.position.x - Math.sin(h) * 9, k.position.y + 4, k.position.z - Math.cos(h) * 9);
    look.set(k.position.x + Math.sin(h) * 4, k.position.y + 1.2, k.position.z + Math.cos(h) * 4);
  }
  update(dt, k) {
    const p = new THREE.Vector3(), l = new THREE.Vector3();
    this._target(k, p, l);
    const a = 1 - Math.exp(-dt * 6);
    this.pos.lerp(p, a); this.look.lerp(l, a);
    this.cam.position.copy(this.pos); this.cam.lookAt(this.look);
  }
}

// ---------------------------------------------------------------------------------------------
// UI + audio
// ---------------------------------------------------------------------------------------------
const audio = new AudioEngine();
const hud = new HUD(uiRoot);
const menu = new Menu(uiRoot, {
  onStart: (settings) => startRace(settings),
  onResume: () => resume(),
  onRestart: () => { menu.hideAll(); startRace(lastSettings); },
  onQuit: () => goToTitle(),
  onScreen: (s) => { if (mode === 'solo') setState(s === 'select' ? 'select' : 'title'); },
  onEvent: () => startEvent(),
});
let input = null;

// ---------------------------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------------------------
let state = 'boot';
let prevState = null;
let world = null;
let lastSettings = { characterIndex: 0, difficulty: 'normal', laps: RACE.laps };
let introTimer = 0;
let resultsShown = false;
let time = 0;
const clock = new THREE.Clock();
const NEUTRAL = Object.freeze({ throttle: 0, brake: 0, steer: 0, drift: false, item: false, lookBack: false });

function setState(s) {
  if (state === s) return;
  state = s;
  document.body.dataset.state = s;
  bus.emit('game:state', { state: s });
}

const RACE_STATES = new Set(['intro', 'countdown', 'racing', 'finished']);

// ---------------------------------------------------------------------------------------------
// World lifecycle
// ---------------------------------------------------------------------------------------------
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

function buildWorld({ mode, characterIndex = 0, difficulty = 'normal', laps = RACE.laps, track }) {
  if (!mods.track || !mods.track.createTrack) throw new Error('track.js unavailable');
  if (!mods.kart || !mods.kart.Kart) throw new Error('kart.js unavailable');
  const w = { mode, difficulty, laps, karts: [], ais: [], playerAI: null, player: null, scene: new THREE.Scene() };
  w.track = mods.track.createTrack(w.scene, renderer, mode === 'race' ? track : undefined);
  w.hazards = safe('hazards', () => createHazards(w.scene, w.track, getTrackDef(w.track.id).hazards)) || null;

  // roster: attract mode = every character in order (kart index == character index)
  let chars;
  if (mode === 'race') {
    const others = shuffle(CHARACTERS.filter((_, i) => i !== characterIndex));
    chars = [CHARACTERS[characterIndex], ...others];
  } else chars = CHARACTERS.slice();

  const { Kart } = mods.kart;
  for (let i = 0; i < RACE.racers; i++) {
    const character = chars[i % chars.length];
    const isPlayer = mode === 'race' && i === 0;
    const model = makeKartModel(character);
    const kart = new Kart({ scene: w.scene, track: w.track, character, isPlayer, index: i, model });
    w.karts.push(kart);
    if (isPlayer) w.player = kart;
  }

  // grid order: player mid-pack (slot 4 or 5), others shuffled
  const gridOrder = new Array(RACE.racers);
  const rest = shuffle(w.karts.filter((k) => k !== w.player));
  if (w.player) {
    const slot = 4 + ((Math.random() * 2) | 0);
    gridOrder[slot] = w.player;
  }
  for (let i = 0; i < gridOrder.length; i++) if (!gridOrder[i]) gridOrder[i] = rest.shift();

  w.race = new RaceManager({ track: w.track, karts: w.karts, player: w.player, laps, silent: mode !== 'race' });
  w.race.placeOnGrid(gridOrder);

  const AIClass = (mods.ai && mods.ai.AIDriver) || null;
  for (const k of w.karts) {
    if (k === w.player) continue;
    let ai = null;
    if (AIClass) ai = safe('ai.ctor', () => new AIClass(k, w.track, { difficulty: mode === 'race' ? difficulty : 'hard' }));
    w.ais.push(ai || new FallbackAI(k, w.track));
  }

  if (mods.items && mods.items.ItemSystem) w.items = safe('items.ctor', () => new mods.items.ItemSystem({ scene: w.scene, track: w.track, karts: w.karts }));
  if (mods.effects && mods.effects.Effects) w.effects = safe('effects.ctor', () => new mods.effects.Effects(w.scene, camera));
  w.chase = (mods.camera && mods.camera.ChaseCamera && safe('camera.ctor', () => new mods.camera.ChaseCamera(camera))) || new FallbackCamera(camera);
  w.ctx = { karts: w.karts, player: w.player || w.karts[0], itemSystem: w.items || null, time: 0 };
  if (w.player) safe('camera.snap', () => w.chase.snap(w.player));

  renderPass.scene = w.scene;
  return w;
}

function disposeWorld() {
  const w = world;
  world = null;
  renderPass.scene = fallbackScene;
  if (!w) return;
  safe('dispose.items', () => w.items && w.items.dispose && w.items.dispose());
  safe('dispose.hazards', () => w.hazards && w.hazards.dispose());
  safe('dispose.effects', () => w.effects && w.effects.dispose && w.effects.dispose());
  for (const k of w.karts) safe('dispose.tag', () => { disposeNameTag(k._tag); k._tag = null; });
  for (const k of w.karts) safe('dispose.kart', () => k.dispose && k.dispose());
  safe('dispose.track', () => w.track && w.track.dispose && w.track.dispose());
  safe('dispose.race', () => w.race && w.race.dispose());
  safe('dispose.ai', () => { for (const a of [...w.ais, w.playerAI]) a && a.dispose && a.dispose(); });
  safe('dispose.chase', () => w.chase && w.chase.dispose && w.chase.dispose());
  // sweep anything left in the scene graph
  safe('dispose.scene', () => {
    const seen = new Set();
    const dispTex = (m) => {
      for (const key in m) {
        const v = m[key];
        if (v && v.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
      }
    };
    w.scene.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) if (!seen.has(m)) { seen.add(m); dispTex(m); m.dispose(); }
      if (o.isLight && o.shadow && o.shadow.map) o.shadow.map.dispose();
    });
    if (w.scene.background && w.scene.background.isTexture) w.scene.background.dispose();
    if (w.scene.environment && w.scene.environment.isTexture) w.scene.environment.dispose();
    w.scene.clear();
  });
  renderer.renderLists.dispose();
}

// ---------------------------------------------------------------------------------------------
// Event mode (6-player party racer)
// ---------------------------------------------------------------------------------------------
let mode = 'solo';                 // 'solo' | 'event'
let eventPhase = null;             // 'lobby' | 'settings' | 'prerace' | 'countdown' | 'racing' | 'results' | 'leaderboard'
let netClient = null;
let split = null;
let splitHud = null;
let eventUI = null;
let eventSession = null;           // last server session state
let eventNet = null;               // LAN addresses reported by the server (for the QR code)
let eventLobby = null;             // last lobby state
const eventRadar = { physicsMs: 0, renderMs: 0, frames: 0, fpsT: 0, longFrames: 0, lastFps: 0, frameMsEma: 0, frameMsMax: 0 };
const eventProbe = { on: false, rows: [] };
function percentiles(a) {
  if (!a.length) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = a.slice().sort((x, y) => x - y);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
  return { p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1], mean: a.reduce((x, y) => x + y, 0) / a.length };
}
const netOffsets = new Map();      // teamId -> client clock offset vs server (reported by controller)

// ---- event room codes (six-player-party-racer room isolation) -------------------------------
// 4 chars from ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no I/L/O/0/1, avoids misreads on a projector).
let eventRoom = null;
const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{4}$/i;
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function normalizeRoom(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return ROOM_RE.test(s) ? s : null;
}
function roomFromUrl() {
  try { return normalizeRoom(new URLSearchParams(location.search).get('room')); }
  catch { return null; }
}
function generateRoom() {
  const alpha = ROOM_ALPHABET;
  let out = '';
  try {
    const buf = new Uint32Array(4);
    if (crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (let i = 0; i < 4; i++) buf[i] = (Math.random() * 0xffffffff) | 0;
    for (let i = 0; i < 4; i++) out += alpha[buf[i] % alpha.length];
  } catch {
    for (let i = 0; i < 4; i++) out += alpha[(Math.random() * alpha.length) | 0];
  }
  return out;
}
/** Resolve the host room: reuse ?room= when valid, else mint + replaceState into the URL. */
function ensureEventRoom() {
  const fromUrl = roomFromUrl();
  if (fromUrl) {
    eventRoom = fromUrl;
    try {
      // normalize the query spelling (?room=test -> ?room=TEST); no reload
      const u = new URL(location.href);
      if (u.searchParams.get('room') !== eventRoom) {
        u.searchParams.set('room', eventRoom);
        history.replaceState(null, '', u.toString());
      }
    } catch {}
    return eventRoom;
  }
  eventRoom = generateRoom();
  try {
    const u = new URL(location.href);
    u.searchParams.set('room', eventRoom);
    history.replaceState(null, '', u.toString());
  } catch {}
  return eventRoom;
}
/** Controller join URL for the QR: append ?room= (or &room=) unless already present. */
function roomJoinUrl(base) {
  if (!base || !eventRoom) return base;
  if (base.includes('room=')) return base;
  return base + (base.includes('?') ? '&' : '?') + 'room=' + eventRoom;
}
/** (Re)bind this socket to our room. The bare hostHello in network-client.js still goes
 *  out first (file owned by another crew); this room hello follows it on open (queued
 *  while down) and on every reconnect via net:connected. */
function sendRoomHello() {
  if (mode === 'event' && eventRoom && netClient) {
    try { netClient.send({ type: 'hostHello', room: eventRoom }); } catch {}
  }
}
/** Stamp roomCode + room join URL onto the live session state (tolerant: no new required fields). */
function paintRoomIntoSession() {
  if (!eventSession || !eventRoom) return;
  try {
    // tolerate a future server echoing the binding back as state.room
    const srvRoom = normalizeRoom(eventSession.room);
    if (srvRoom && srvRoom !== eventRoom) {
      eventRoom = srvRoom;
      try {
        const u = new URL(location.href);
        u.searchParams.set('room', eventRoom);
        history.replaceState(null, '', u.toString());
      } catch {}
    }
  } catch {}
  eventSession.roomCode = eventRoom;
  if (eventSession.controllerUrl) eventSession.controllerUrl = roomJoinUrl(eventSession.controllerUrl);
}
/** Fresh code on demand (lobby NEW CODE button): mint, restate URL, re-hello, repaint lobby. */
function regenerateEventRoom() {
  eventRoom = generateRoom();
  try {
    const u = new URL(location.href);
    u.searchParams.set('room', eventRoom);
    history.replaceState(null, '', u.toString());
  } catch {}
  sendRoomHello();
  paintRoomIntoSession();
  if (eventUI && typeof eventUI.setRoomCode === 'function') { try { eventUI.setRoomCode(eventRoom); } catch {} }
  else if (eventSession && eventUI) { try { eventUI.setSession(eventSession); } catch {} }
}

setInterval(() => {
  const w = world;
  if (mode !== 'event' || !w || w.mode !== 'event' || !netClient || state !== 'racing') return;
  const rows = w.karts.filter((k) => k.teamId > 0).map((k) => ({ teamId: k.teamId, place: k.place, lap: Math.min(k.lap || 1, w.race.laps), item: k.item || null, wrong: !!k._wrongWay })).sort((a, b) => a.place - b.place);
  netClient.send({ type: 'hostStandings', rows });
}, 500);

function startEvent() {
  mode = 'event';
  eventPhase = 'lobby';
  ensureEventRoom();
  menu.hideAll();
  hud.hide();
  document.body.dataset.state = 'event';
  if (!eventUI) eventUI = new EventUI(uiRoot, eventHandlers());
  if (!split) split = new SplitScreen(renderer, mods.camera && mods.camera.ChaseCamera);
  if (!splitHud) splitHud = new SplitHUD(uiRoot);
  if (!netClient) { netClient = new HostNetworkClient(); netClient.connect(); }
  sendRoomHello();
  setEventFlow('lobby');
  setSessionSettings();
  if (eventUI && typeof eventUI.setRoomCode === 'function') { try { eventUI.setRoomCode(eventRoom); } catch {} }
}

function endEvent() {
  mode = 'solo';
  eventPhase = null;
  // drop the in-memory room binding (and the flow's copy)
  eventRoom = null;
  if (eventSession) { try { delete eventSession.roomCode; } catch {} }
  // leave solo as solo: boot() re-enters event mode for ?event / ?room, so drop them (a
  // later EVENT MODE mints a fresh room and connected phones follow it automatically)
  try {
    const u = new URL(location.href);
    u.searchParams.delete('event'); u.searchParams.delete('room');
    history.replaceState(null, '', u.toString());
  } catch {}
  if (eventUI) {
    if (typeof eventUI.setRoomCode === 'function') { try { eventUI.setRoomCode(null); } catch {} }
    eventUI.hide();
  }
  if (splitHud) splitHud.hide();
  disposeWorld();
  goToTitle();
}

function eventHandlers() {
  return {
    goSettings: () => setEventFlow('settings'),
    goLobby: () => setEventFlow('lobby'),
    startRace: () => startEventRace(),
    backToTitle: () => endEvent(),
    showLeaderboard: () => setEventFlow('leaderboard'),
    nextRace: () => setEventFlow('settings'),
    resetTournament: () => { netClient && netClient.send({ type: 'hostResetSession' }); },
    newRoom: () => regenerateEventRoom(),
    endEvent,
    lobbyAction: (act, teamId) => {
      if (!netClient) return;
      if (act === 'ready') netClient.send({ type: 'hostForceReady', teamId });
      else if (act === 'ai') netClient.send({ type: 'hostReplaceAI', teamId });
      else if (act === 'remove') netClient.send({ type: 'hostRemove', teamId });
    },
    setSettings: (patch) => { if (netClient) netClient.send({ type: 'hostSettings', settings: patch }); },
    champion: () => {
      bus.emit('ev:champion', {});
      if (world && world.effects && world.karts[0]) {
        // confetti over the winning grid slot
        safe('effects.champion', () => {
          const k = world.karts[0];
          const p = k.position.clone(); p.y += 5;
          world.effects.burst('confetti', p, { kart: k });
          world.effects.burst('confetti', p, { kart: k });
        });
      }
    },
  };
}

function setEventFlow(flow) {
  eventPhase = flow;
  if (netClient) netClient.send({ type: 'hostFlow', flow });
  if (!eventUI) return;
  // the six driving HUDs only belong on screen while people are actually driving
  const driving = flow === 'countdown' || flow === 'racing';
  if (driving) splitHud.show(); else splitHud.hide();
  startLights.off();
  const banner = uiRoot.querySelector('.event-banner');
  if (banner && !driving) banner.classList.remove('show');
  if (flow === 'lobby') eventUI.show('lobby');
  else if (flow === 'settings') eventUI.show('settings');
  else if (flow === 'prerace') eventUI.show('prerace');
  else if (flow === 'results') eventUI.show('results');
  else if (flow === 'leaderboard') eventUI.show('leaderboard');
  else eventUI.hide();
}

function setSessionSettings() {
  if (eventSession) {
    eventSession.controllerUrl = eventNet && eventNet.controllerUrl ? eventNet.controllerUrl : `${location.origin}/controller`;
    eventSession.lanWarning = !(eventNet && eventNet.controllerUrl);
    paintRoomIntoSession();
    if (eventUI) eventUI.setSession(eventSession);
  }
}

bus.on('net:connected', () => { sendRoomHello(); });

bus.on('net:session', ({ state, net }) => {
  const prev = eventSession;
  eventSession = state;
  if (prev && prev.lastResults && !state.lastResults) state.lastResults = prev.lastResults;
  if (prev && prev.lastGained && !state.lastGained) state.lastGained = prev.lastGained;
  // phones must get the LAN address, never "localhost" (that would be the phone itself)
  eventNet = net || eventNet;
  state.controllerUrl = eventNet && eventNet.controllerUrl ? eventNet.controllerUrl : `${location.origin}/controller`;
  state.lanWarning = !(eventNet && eventNet.controllerUrl);
  state.altUrls = (eventNet && eventNet.ips || []).slice(1).map((ip) => `http://${ip}:${eventNet.port}/controller`);
  paintRoomIntoSession();
  if (eventUI) eventUI.setSession(state);
});
const prevSeen = new Map(); // teamId -> connection signature, for join/leave cues
bus.on('net:lobby', ({ state }) => {
  eventLobby = state;
  for (const t of state.teams) {
    const sig = t.connected ? `c${t.sessionId}` : `d${t.sessionId}`;
    const before = prevSeen.get(t.id);
    if (before && before.startsWith('c') && sig.startsWith('d')) bus.emit('ev:leave', { teamId: t.id });
    else if ((!before || before.startsWith('d')) && sig.startsWith('c')) bus.emit('ev:join', { teamId: t.id });
    if (before !== sig) prevSeen.set(t.id, sig);
    netOffsets.set(t.id, typeof t.offset === 'number' ? t.offset : 0);
    if (t.ready && before !== sig) bus.emit('ev:ready', { teamId: t.id, ready: true });
  }
  if (eventUI) eventUI.setLobby(state);
  syncDrivers();
});
bus.on('net:pause', ({ teamId } = {}) => {
  // a phone's pause button is a request, not a command: show it, ping audio, let the host decide
  if (mode !== 'event' || !world || world.mode !== 'event') return;
  if (eventPhase !== 'countdown' && eventPhase !== 'racing') return;
  bus.emit('ev:pauseRequest', { teamId: teamId || 0 });
  flashEventBanner(`${teamName(teamId || 0).toUpperCase()} WANTS PAUSE`, true);
});

/** Switch karts between network input and AI based on lobby state. */
function syncDrivers() {
  const w = world;
  if (!w || w.mode !== 'event' || !eventLobby) return;
  for (const t of eventLobby.teams) {
    const kart = w.karts.find((k) => k.teamId === t.id);
    if (!kart) continue;
    // A slot that was empty when the race started keeps its AI driver until a phone takes it
    // over. (This used to read `t.ai || (!t.connected && t.ai)`, which stripped the AI that
    // buildEventWorld gives empty slots on the first lobby update, leaving those karts parked
    // on the grid.) A phone that drops mid-race still coasts until the server hands its slot
    // to AI after the reconnect window.
    if (t.connected) kart._emptySlot = false;
    const wantAI = t.ai || (!!kart._emptySlot && !t.connected);
    if (wantAI && !kart._ai) {
      const AIClass = mods.ai && mods.ai.AIDriver;
      kart._ai = (AIClass && safe('ai.ctor', () => new AIClass(kart, w.track, { difficulty: w.difficulty }))) || new FallbackAI(kart, w.track);
      if (w.ais) w.ais.push(kart._ai);
    } else if (!wantAI && kart._ai) {
      const i = w.ais.indexOf(kart._ai);
      if (i >= 0) w.ais.splice(i, 1);
      kart._ai = null;
    }
  }
}

function startEventRace() {
  setEventFlow('prerace');
  setState('loading');
  setTimeout(() => {
    disposeWorld();
    try {
      world = buildEventWorld();
    } catch (e) { report('buildEventWorld', e); setEventFlow('lobby'); return; }
    eventUI.show('prerace');
    // one HUD panel per VIEW (max six); AI-fill karts have no viewport, and their extra
    // panels used to land on top of player 1's (they still show on everyone's minimap)
    splitHud.attach(world.karts.slice(0, 6), eventLobby ? eventLobby.teams : []);
    splitHud.show();
    split.attach(world.karts.slice(0, 6));
    audio.setGameplayActive(true);
    audio.stopMusic();
    setState('prerace');
    preraceStart = performance.now();
    preraceTimer = 2.4;
  }, 60);
}

let preraceTimer = 0;
let preraceStart = 0;
function buildEventWorld() {
  if (!mods.track || !mods.track.createTrack) throw new Error('track.js unavailable');
  if (!mods.kart || !mods.kart.Kart) throw new Error('kart.js unavailable');
  const settings = (eventSession && eventSession.settings) || {};
  const speedScale = { slow: 0.85, easy: 0.9, normal: 1, fast: 1.08 }[settings.raceSpeed || 'normal'] || 1;
  const w = { mode: 'event', difficulty: settings.difficulty || 'normal', laps: settings.laps || 3, karts: [], ais: [], player: null, scene: new THREE.Scene(), speedScale };
  // 'rotate' (the default) runs a different circuit each race of the championship
  const trackId = settings.track === 'rotate' || !settings.track
    ? rotatingTrackId((eventSession && eventSession.raceIndex) || 0) : settings.track;
  w.track = mods.track.createTrack(w.scene, renderer, trackId);
  w.hazards = safe('hazards', () => createHazards(w.scene, w.track, getTrackDef(w.track.id).hazards)) || null;
  const teams = eventLobby ? eventLobby.teams : [];
  const { Kart } = mods.kart;
  const racers = Math.min(6, Math.max(1, teams.length));
  for (let i = 0; i < racers; i++) {
    const t = teams[i] || { id: i + 1, characterIdx: i, connected: false, ai: true };
    const base = CHARACTERS[t.characterIdx % CHARACTERS.length];
    // team livery: the character keeps its hat/driver/stats, the chassis wears the team colour
    const character = t.color ? { ...base, color: hexToInt(t.color) } : base;
    const model = makeKartModel(character);
    const kart = new Kart({ scene: w.scene, track: w.track, character, isPlayer: false, index: i, model });
    kart.teamId = t.id;
    kart._teamIdRaw = t.id;
    kart.speedScale = speedScale;
    w.karts.push(kart);
  }
  // AI fill (beyond the six team karts)
  const aiFill = settings.aiFill | 0;
  for (let i = 0; i < aiFill; i++) {
    const character = CHARACTERS[(i + racers) % CHARACTERS.length];
    const model = makeKartModel(character);
    const kart = new Kart({ scene: w.scene, track: w.track, character, isPlayer: false, index: racers + i, model });
    kart.teamId = 0;
    kart.speedScale = speedScale;
    w.karts.push(kart);
    const AIClass = mods.ai && mods.ai.AIDriver;
    const ai = (AIClass && safe('ai.ctor', () => new AIClass(kart, w.track, { difficulty: w.difficulty }))) || new FallbackAI(kart, w.track);
    w.ais.push(ai);
  }
  // AIs for disconnected/AI teams
  for (let i = 0; i < racers; i++) {
    const t = teams[i];
    const kart = w.karts[i];
    if (t && (t.ai || !t.connected)) {
      if (!t.connected) kart._emptySlot = true;
      const AIClass = mods.ai && mods.ai.AIDriver;
      const ai = (AIClass && safe('ai.ctor', () => new AIClass(kart, w.track, { difficulty: w.difficulty }))) || new FallbackAI(kart, w.track);
      kart._ai = ai;
      w.ais.push(ai);
    }
  }
  // floating name tags: team name in team colour (CPU fill karts get their racer's name in grey)
  w.karts.forEach((kart, i) => {
    safe('nametag', () => {
      const t = kart.teamId > 0 ? teams.find((x) => x.id === kart.teamId) : null;
      const tag = createNameTag(t ? t.name : `CPU · ${kart.character.name}`, t ? t.color : '#9aa3b5');
      tag.layers.set(TAG_LAYER_BASE + i);
      kart.object3D.add(tag);
      kart._tag = tag;
    });
  });
  w.race = new RaceManager({ track: w.track, karts: w.karts, player: null, laps: w.laps, silent: false });
  const order = w.karts.slice();
  w.race.placeOnGrid(order);
  w.race.startCountdownPending = true;
  if (mods.items && mods.items.ItemSystem && settings.items !== false) w.items = safe('items.ctor', () => new mods.items.ItemSystem({ scene: w.scene, track: w.track, karts: w.karts }));
  if (mods.effects && mods.effects.Effects) w.effects = safe('effects.ctor', () => new mods.effects.Effects(w.scene, camera));
  w.ctx = { karts: w.karts, player: null, itemSystem: w.items || null, time: 0 };
  renderPass.scene = w.scene;
  return w;
}


function buildAttract() {
  disposeWorld();
  try {
    world = buildWorld({ mode: 'attract' });
    world.race.startImmediately();
    // stagger: let them drive for a few seconds instantly so the title shows a spread-out pack
    attractCam.targetIndex = 0; attractCam.switchT = 0;
    uiRoot.classList.remove('no-world');
  } catch (e) {
    report('attract', e);
    disposeWorld();
    uiRoot.classList.add('no-world');
  }
}

function goToTitle() {
  hud.hide(); hud.hideResults();
  audio.setPaused(false);
  audio.setGameplayActive(false);
  resultsShown = false;
  menu.showLoading('LOADING');
  setTimeout(() => {
    buildAttract();
    menu.showTitle();
    setState('title');
    audio.playMusic('menu');
  }, 30);
}

function startRace(settings) {
  lastSettings = { ...lastSettings, ...settings };
  hud.hide(); hud.hideResults();
  menu.showLoading('GET READY!');
  audio.setPaused(false);
  audio.stopMusic();
  setState('loading');
  setTimeout(() => {
    disposeWorld();
    try {
      world = buildWorld({ mode: 'race', ...lastSettings });
    } catch (e) {
      report('buildWorld', e);
      menu.showLoading('RACE FAILED TO LOAD — SEE CONSOLE');
      setTimeout(goToTitle, 2500);
      return;
    }
    resultsShown = false;
    introTimer = 0;
    seenErrors.clear();
    hud.reset({ player: world.player, track: world.track, laps: lastSettings.laps });
    hud.show();
    menu.hideAll();
    audio.setGameplayActive(true);
    uiRoot.classList.remove('no-world');
    setState('intro');
    showIntroCard();
  }, 40);
}

let introCard = null;
function showIntroCard() {
  if (!introCard) introCard = Object.assign(document.createElement('div'), { className: 'intro-card' });
  uiRoot.appendChild(introCard);
  const name = (world && world.track && world.track.name) || 'Grand Circuit';
  const d = { easy: '50cc', normal: '100cc', hard: '150cc' }[lastSettings.difficulty] || '';
  introCard.innerHTML = `<div class="ic-sub">${d} · ${lastSettings.laps} LAP${lastSettings.laps > 1 ? 'S' : ''}</div><div class="ic-name">${name}</div><div class="ic-skip">ENTER · SKIP</div>`;
  introCard.classList.remove('show'); void introCard.offsetWidth; introCard.classList.add('show');
}
function hideIntroCard() { if (introCard) introCard.classList.remove('show'); }

function beginCountdown() {
  if (state !== 'intro' || !world) return;
  hideIntroCard();
  world.race.startCountdown();
  setState('countdown');
  safe('camera.snap', () => world.chase.snap(world.player));
}

function pause() {
  if (!RACE_STATES.has(state) || resultsShown) return;
  prevState = state;
  setState('paused');
  menu.showPause();
  audio.setPaused(true);
}
function resume() {
  if (state !== 'paused') return;
  menu.hideAll();
  setState(prevState || 'racing');
  audio.setPaused(false);
  clock.getDelta();
}

bus.on('race:go', () => {
  if (mode === 'event' && world && world.mode === 'event' && (eventPhase === 'countdown' || eventPhase === 'racing')) {
    eventPhase = 'racing'; setState('racing'); audio.playMusic('race');
    // tell the server (and so every phone) the race is live: the session flow used to stay at
    // 'countdown' all race, so phones kept the rocket-start banner over their controls
    if (netClient) netClient.send({ type: 'hostFlow', flow: 'racing' });
    startLights.off();
    flashEventBanner('GO!');
    return;
  }
  if (state === 'countdown' || (state === 'paused' && prevState === 'countdown')) {
    if (state === 'paused') prevState = 'racing'; else setState('racing');
    audio.playMusic('race');
  }
});
bus.on('race:countdown', ({ n }) => {
  if (mode === 'event' && world && world.mode === 'event') {
    flashEventBanner(String(n)); startLights.set(6 - n);
    if (netClient) netClient.send({ type: 'hostCountdown', n });
  }
});
bus.on('race:end', (d) => {
  if (!world || world.mode !== 'event') return;
  const results = (d && d.results) || world.race.computeResults();
  finishEventRace(results);
});

function flashEventBanner(text, small) {
  let el = document.querySelector('.event-banner');
  if (!el) { el = document.createElement('div'); el.className = 'event-banner'; uiRoot.appendChild(el); }
  el.textContent = text;
  // inline sizing (not a stylesheet class) so leader flashes read as subordinate to GO/FINAL LAP
  el.style.fontSize = small ? '54px' : '';
  el.style.letterSpacing = small ? '4px' : '';
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
bus.on('race:leader', ({ kart, teamId } = {}) => {
  if (mode !== 'event' || !world || world.mode !== 'event' || eventPhase !== 'racing') return;
  const id = (kart && kart.teamId) || teamId || 0;
  if (!id) return;
  flashEventBanner(`NEW LEADER: ${teamName(id).toUpperCase()}!`, true);
});
bus.on('race:finalLap', () => {
  if (mode !== 'event' || !world || world.mode !== 'event' || eventPhase !== 'racing') return;
  flashEventBanner('FINAL LAP!');
});

// ---------------------------------------------------------------------------------------------
// Gamepad hot-plug UX + event rumble (solo mode only; latest effect wins by design).
// ---------------------------------------------------------------------------------------------
function padRumble(opts) { try { if (input) input.rumble(opts); } catch {} }
function soloPlayerKart(d) {
  return (world && world.mode === 'race' && world.player && d && d.kart === world.player) ? world.player : null;
}
bus.on('gamepad:connected', (d = {}) => {
  safe('pad.toast', () => hud.toast(d.label ? `${d.label} connected` : 'Controller connected'));
  try { audio.beep(740, 0.09, 'square', 0.1); } catch {}
});
bus.on('gamepad:disconnected', () => {
  safe('pad.toast', () => hud.toast('Controller disconnected — keyboard ready'));
});
bus.on('kart:hit', (d) => { if (soloPlayerKart(d)) padRumble({ strong: 0.9, weak: 0.7, duration: 300 }); });
bus.on('kart:miniTurbo', (d) => { if (soloPlayerKart(d)) padRumble({ strong: 0.35, weak: 0.6, duration: 160 + 60 * ((d && d.level) || 1) }); });
bus.on('kart:boost', (d) => { if (d && d.source !== 'miniTurbo' && soloPlayerKart(d)) padRumble({ strong: 0.5, weak: 0.5, duration: 220 }); });
bus.on('item:use', (d) => { if (soloPlayerKart(d)) padRumble({ strong: 0.3, weak: 0.3, duration: 120 }); });
bus.on('race:countdown', () => { if (world && world.mode === 'race') padRumble({ strong: 0.25, weak: 0.25, duration: 70 }); });
bus.on('race:go', () => { if (world && world.mode === 'race') padRumble({ strong: 0.5, weak: 0.5, duration: 180 }); });
bus.on('race:finish', (d) => { if (soloPlayerKart(d)) padRumble({ strong: 0.8, weak: 0.6, duration: 450 }); });

/** F1-style start lights for the event countdown (and a rocket start if you hold GAS). */
const startLights = { el: null, set(n) {
  if (!this.el) { this.el = document.createElement('div'); this.el.className = 'start-lights'; uiRoot.appendChild(this.el); }
  if (this.el.children.length !== 5) {
    this.el.innerHTML = '<div class="lights">' + Array.from({ length: 5 }, () => '<i></i>').join('') + '</div>';
  }
  const on = Math.max(0, Math.min(5, n));
  [...this.el.querySelectorAll('.lights i')].forEach((el, i) => el.classList.toggle('on', i < on));
  this.el.classList.toggle('on', true);
}, off() { if (this.el) this.el.classList.remove('on'); } };

function finishEventRace(results) {
  const rows = [];
  for (const r of results) {
    const teamId = r.kart.teamId || 0;
    rows.push({
      teamId, place: r.place,
      name: teamId ? (teamName(teamId)) : r.name,
      characterName: r.character ? r.character.name : r.name,
      color: teamColor(teamId),
      time: r.estimated ? 'EST' : `${Math.floor(r.time / 60)}:${(r.time % 60).toFixed(2).padStart(5, '0')}`,
    });
  }
  if (eventSession) {
    const t = { type: 'hostApplyResults', results: rows.filter((r) => r.teamId > 0).map((r) => ({ teamId: r.teamId, place: r.place })) };
    netClient && netClient.send(t);
    // optimistic local copy for instant display; server session will reconcile
    eventSession.lastResults = rows.slice(0, 8);
    eventSession.lastGained = {};
    const pts = eventSession.pointsTable || [10, 8, 6, 4, 2, 1];
    for (const r of rows) eventSession.lastGained[r.teamId] = pts[r.place - 1] ?? 0;
    for (const r of rows) {
      let s = eventSession.scores.find((x) => x.teamId === r.teamId);
      if (!s && r.teamId) { s = { teamId: r.teamId, name: r.name, characterId: 0, total: 0, wins: 0, podiums: 0, previous: 0 }; eventSession.scores.push(s); }
      if (s) { s.previous = s.total; s.total += eventSession.lastGained[r.teamId] || 0; if (r.place === 1) s.wins++; if (r.place <= 3) s.podiums++; }
    }
  }
  audio.playMusic('menu');
  eventPhase = 'results';
  setState('results');
  eventUI.setSession(eventSession || {});
  setEventFlow('results');
}
function teamName(id) { const t = (eventLobby && eventLobby.teams) || []; const f = t.find((x) => x.id === id); return f ? f.name : `Team ${id}`; }
function hexToInt(h) { return typeof h === 'string' ? parseInt(h.replace('#', ''), 16) || 0x888888 : (h || 0x888888); }
function teamColor(id) { const t = (eventLobby && eventLobby.teams) || []; const f = t.find((x) => x.id === id); return f ? f.color : '#888888'; }
bus.on('race:finish', (d) => {
  if (!world || !d || !d.kart || !d.kart.isPlayer) return;
  setState('finished');
  // hand the player's kart to an AI so it keeps cruising during the finish camera
  const AIClass = mods.ai && mods.ai.AIDriver;
  world.playerAI = (AIClass && safe('ai.player', () => new AIClass(world.player, world.track, { difficulty: 'easy' }))) || new FallbackAI(world.player, world.track);
});
bus.on('race:end', (d) => {
  if (!world || world.mode !== 'race') return;
  resultsShown = true;
  const results = (d && d.results) || world.race.computeResults();
  if (state === 'paused') resume();
  setTimeout(() => {
    if (!world || !resultsShown) return;
    audio.playMusic('menu');
    hud.showResults(results, {
      laps: world.race.laps,
      onRestart: () => startRace(lastSettings),
      onMenu: () => goToTitle(),
    });
  }, 200);
});

// ---------------------------------------------------------------------------------------------
// Keyboard (global)
// ---------------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) {
    const muted = audio.toggleMute();
    hud.toast(muted ? 'SOUND OFF' : 'SOUND ON');
    return;
  }
  if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat) {
    if (state === 'paused') { if (e.code === 'Escape' || e.code === 'KeyP') { bus.emit('ui:back'); resume(); } }
    else if (RACE_STATES.has(state)) pause();
    return;
  }
  if (state === 'intro' && (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && !e.repeat) {
    beginCountdown();
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) && state !== 'boot') e.preventDefault();
});
canvas.addEventListener('click', () => { if (state === 'intro') beginCountdown(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (state === 'racing' || state === 'countdown')) pause(); });

// ---------------------------------------------------------------------------------------------
// Attract-mode camera (title / select): cinematic orbit around a kart, or around the track centre
// ---------------------------------------------------------------------------------------------
const attractCam = {
  targetIndex: 0, switchT: 0, angle: 0,
  pos: new THREE.Vector3(0, 40, 80), look: new THREE.Vector3(), init: false,
  _p: new THREE.Vector3(), _l: new THREE.Vector3(),
};
function updateAttractCamera(dt) {
  const w = world;
  const ac = attractCam;
  ac.angle += dt * (state === 'select' ? 0.28 : 0.16);
  let target = null;
  if (w && w.karts.length) {
    if (state === 'select') target = w.karts[menu.charIndex] || w.karts[0];
    else {
      ac.switchT -= dt;
      if (ac.switchT <= 0) {
        ac.switchT = 9;
        const st = w.race.standings;
        const pick = st[(Math.random() * Math.min(4, st.length)) | 0];
        ac.targetIndex = w.karts.indexOf(pick);
      }
      target = w.karts[ac.targetIndex] || w.karts[0];
    }
  }
  if (target) {
    const close = state === 'select';
    const r = close ? 7.5 : 14 + Math.sin(ac.angle * 0.7) * 3;
    const h = target.heading || 0;
    const a = h + (close ? Math.PI * 0.75 + Math.sin(ac.angle) * 0.5 : ac.angle);
    ac._p.set(target.position.x + Math.sin(a) * r, target.position.y + (close ? 2.6 : 5 + Math.sin(ac.angle * 0.5) * 2), target.position.z + Math.cos(a) * r);
    ac._l.set(target.position.x, target.position.y + (close ? 1.1 : 1.5), target.position.z);
    // lead by velocity so the exponential smoothing below has no steady-state lag behind a moving kart
    const v = target.velocity;
    if (v) { const lead = 1 / 2.5; ac._p.addScaledVector(v, lead); ac._l.addScaledVector(v, lead); }
  } else {
    let cx = 0, cz = 0, span = 200;
    const mm = w && w.track && w.track.minimap && w.track.minimap.bounds;
    if (mm) { cx = (mm.minX + mm.maxX) / 2; cz = (mm.minZ + mm.maxZ) / 2; span = Math.max(mm.maxX - mm.minX, mm.maxZ - mm.minZ); }
    ac._p.set(cx + Math.cos(ac.angle) * span * 0.6, span * 0.3, cz + Math.sin(ac.angle) * span * 0.6);
    ac._l.set(cx, 0, cz);
  }
  const k = ac.init ? 1 - Math.exp(-dt * 2.5) : 1;
  ac.init = true;
  ac.pos.lerp(ac._p, k); ac.look.lerp(ac._l, k);
  camera.position.copy(ac.pos);
  camera.lookAt(ac.look);
  if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------------
let playerInput = null;
const debug = { autopilot: false };
function simulate(w, dt) {
  time += dt;
  w.ctx.time = time;
  const racing = w.mode === 'race';
  const eventRace = w.mode === 'event';
  const player = w.player;

  if (eventRace) {
    // human inputs from the network; stale sessions fall back to neutral
    const now = time;
    for (const kart of w.karts) {
      if (kart._ai || kart.teamId <= 0) continue;
      const t = eventLobby && eventLobby.teams.find((x) => x.id === kart.teamId);
      if (t && !t.connected) {
        // a phone that dropped: keep the kart alive for a moment (its last input stays
        // believable), then go neutral rather than holding the throttle forever
        if (!kart._lostAt) kart._lostAt = now;
        else if (now - kart._lostAt > 2) { kart.input = { ...NEUTRAL }; kart._lastNet = null; continue; }
      } else kart._lostAt = 0;
      const st = netClient && netClient.applyInput(kart.teamId, kart);
      kart._lastNet = st;
    }
  }

  // player input (always drain the controller so edge-triggered presses don't queue up)
  if (racing && player) {
    let raw = null;
    if (input) raw = safe('input.getInput', () => input.getInput());
    if (input) safe('input.pause', () => input.consumePressed && input.consumePressed('pause'));
    playerInput = raw || NEUTRAL;
    if (debug.autopilot && !w.playerAI && !player.controlsLocked) {
      const AIClass = mods.ai && mods.ai.AIDriver;
      w.playerAI = (AIClass && safe('ai.player', () => new AIClass(player, w.track, { difficulty: 'hard' }))) || new FallbackAI(player, w.track);
    }
    if ((player.finished || debug.autopilot) && w.playerAI) {
      safe('ai.player', () => w.playerAI.update(dt, w.ctx));
    } else if (player.controlsLocked) {
      player.input = { ...NEUTRAL };
    } else {
      player.input = raw || { ...NEUTRAL };
    }
  }

  for (let i = 0; i < w.ais.length; i++) {
    const ai = w.ais[i];
    try { ai.update(dt, w.ctx); } catch (e) { report('ai.update', e); }
  }
  for (let i = 0; i < w.karts.length; i++) {
    try { w.karts[i].update(dt); } catch (e) { report('kart.update', e); }
  }
  if (mods.kart && mods.kart.resolveKartCollisions) safe('resolveKartCollisions', () => mods.kart.resolveKartCollisions(w.karts));
  if (w.items) safe('items.update', () => w.items.update(dt, time));
  if (w.hazards) safe('hazards.update', () => w.hazards.update(dt, w.race && w.race.raceTime != null ? w.race.raceTime : time, w.karts));
  safe('race.update', () => w.race.update(dt));
  if (w.effects) safe('effects.update', () => w.effects.update(dt, w.karts));
  safe('track.update', () => w.track.update && w.track.update(dt, time));
  // keep the sun's shadow frustum centred on whatever the camera is following
  const focus = racing ? player : (w.karts[attractCam.targetIndex] || w.karts[0]);
  if (focus && w.track.setShadowFocus) safe('track.setShadowFocus', () => w.track.setShadowFocus(focus.position));

  if (racing && state === 'intro') {
    introTimer += dt;
    if (introTimer > 4.0) beginCountdown();
  }
}

const FIXED_DT = 1 / 60;
const MAX_STEPS = 4;
let acc = 0;
const perf = { lastT: performance.now() };

// ---------------------------------------------------------------------------------------------
// Render interpolation. Physics runs at a fixed 60 Hz but frames arrive at the display's
// rate (and never exactly 16.67 ms apart), so without this a frame sometimes gets 0 or 2
// physics steps and the karts judder against the smoothly damped chase cameras (worst on
// 120/144 Hz laptop panels). Each kart is drawn between its last two physics states, then
// its true state is restored before the next step, so the simulation itself never changes.
// ---------------------------------------------------------------------------------------------
const TELEPORT_DIST2 = 8 * 8; // respawns and grid placement snap instead of sliding
function lerpAngle(a, b, t) { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; }
function capturePrevPoses(w) {
  for (const k of w.karts) {
    if (!k._ipPrev) { k._ipPrev = new THREE.Vector3(); k._ipCur = new THREE.Vector3(); }
    k._ipPrev.copy(k.position);
    k._ipPrevHeading = k.heading;
    k._ipValid = true;
  }
}
function beginInterpolation(w, alpha) {
  if (!(alpha > 0 && alpha < 1)) return false;
  for (const k of w.karts) {
    k._ipApplied = false;
    if (!k._ipValid) continue;
    k._ipCur.copy(k.position);
    k._ipCurHeading = k.heading;
    if (k._ipPrev.distanceToSquared(k._ipCur) > TELEPORT_DIST2) continue;
    k.position.lerpVectors(k._ipPrev, k._ipCur, alpha);
    k.heading = lerpAngle(k._ipPrevHeading, k._ipCurHeading, alpha);
    k._ipApplied = true;
  }
  return true;
}
function endInterpolation(w) {
  for (const k of w.karts) {
    if (!k._ipApplied) continue;
    k.position.copy(k._ipCur);
    k.heading = k._ipCurHeading;
    k._ipApplied = false;
  }
}

function frame() {
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 1 / 30);
  safe('menu.update', () => menu.update(rawDt, resultsShown ? 'results' : state));

  const w = world;
  let interpolated = false;
  try {
    if (w) {
      const running = state !== 'paused' && state !== 'loading' && state !== 'boot';
      if (running) {
        const t0 = performance.now();
        acc += Math.min(rawDt, 1 / 10);
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS) {
          safe('interp.capture', () => capturePrevPoses(w));
          safe('simulate', () => simulate(w, FIXED_DT)); acc -= FIXED_DT; steps++;
        }
        if (steps === MAX_STEPS) acc = 0; // drop debt after a stall so we never spiral
        eventRadar.physicsMs = performance.now() - t0;
        interpolated = !!safe('interp.begin', () => beginInterpolation(w, acc / FIXED_DT));
      }
    }
    renderFrame(w, dt);
  } finally {
    if (interpolated) safe('interp.end', () => endInterpolation(w));
  }
}

function renderFrame(w, dt) {
  if (w) {
    if (w.mode === 'event') {
      // prerace countdown to race start
      if (state === 'prerace') {
        // wall-clock pacing so a slow display never stretches the presentation
        preraceTimer = 2.4 - (performance.now() - preraceStart) / 1000;
        updatePreraceCamera(dt);
        if (preraceTimer <= 0) {
          setEventFlow('countdown');
          eventPhase = 'countdown';
          setState('countdown');
          world.race.startCountdown();
        }
      } else if (state === 'countdown' || state === 'racing' || state === 'finished') {
        safe('split.update', () => split.update(dt, (k) => (state === 'countdown' ? 'countdown' : state === 'finished' ? 'finish' : 'race')));
        safe('splitHud.update', () => splitHud.update(dt, { karts: world.karts, race: world.race, itemSystem: world.items, track: world.track }));
      }
      safe('audio.update', () => audio.update(dt, { player: null, karts: w.karts, camera }));
      const broadcast = (eventSession && eventSession.settings && eventSession.settings.cameraMode === 'broadcast');
      safe('split.broadcastMode', () => split.setBroadcastMode(!!broadcast));
      if (splitHud.broadcast !== !!broadcast) {
        // follow the leader in broadcast mode so the single camera stays interesting
        if (broadcast) {
          const standings = world.race && world.race.standings ? world.race.standings : world.karts;
          const lead = standings.find((k) => k.teamId > 0) || world.karts[0];
          split.broadcastIndex = Math.max(0, world.karts.indexOf(lead));
        }
        splitHud.setBroadcast(!!broadcast, world.karts, world.race);
      }
      // shadow maps must be refreshed at most once per displayed frame even with six viewports
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      const rt0 = performance.now();
      try { split.render(w.scene, broadcast); } catch (e) { report('split.render', e); }
      eventRadar.renderMs = performance.now() - rt0;
      eventRadar.frames++;
      const ft = performance.now() - perf.lastT;
      perf.lastT = performance.now();
      if (ft > 33) eventRadar.longFrames++;
updateLatencyOverlay(ft);
      if (eventProbe.on) {
        eventProbe.rows.push({ ft: +ft.toFixed(2), physics: +eventRadar.physicsMs.toFixed(2), render: +eventRadar.renderMs.toFixed(2) });
        if (eventProbe.rows.length > 20000) eventProbe.rows.shift();
      }
safe('split.observeFrame', () => split.observeFrame(ft));
      return;
    }

    if (w.mode === 'race' && w.player) {
      if (state !== 'paused') {
        const mode = state === 'intro' ? 'intro' : state === 'countdown' ? 'countdown' : state === 'finished' ? 'finish' : 'race';
        const lookBack = !!(state === 'racing' && playerInput && playerInput.lookBack);
        safe('camera.update', () => w.chase.update(dt, w.player, { lookBack, mode }));
      }
      safe('hud.update', () => hud.update(dt, { player: w.player, karts: w.karts, race: w.race, itemSystem: w.items, track: w.track, time }));
    } else {
      updateAttractCamera(dt);
    }
    safe('audio.update', () => audio.update(dt, { player: w.player, karts: w.karts, camera }));
  } else {
    updateAttractCamera(dt);
    safe('audio.update', () => audio.update(dt, { camera }));
  }

  if (w && w.mode !== 'event') {
    try { composer.render(dt); } catch (e) { report('render', e); }
  } else if (!w) {
    try { composer.render(dt); } catch (e) { report('render', e); }
  }
}

function updatePreraceCamera(dt) {
  const w = world;
  if (!w || !w.track) return;
  const t = performance.now() / 1000;
  const sp = w.track.startPositions && w.track.startPositions[0];
  const cx = sp ? sp.position.x : 0, cz = sp ? sp.position.z : 0;
  const r = 16 + Math.sin(t * 0.5) * 3;
  camera.position.set(cx + Math.sin(t * 0.4) * r, 8 + Math.sin(t * 0.8) * 2, cz + Math.cos(t * 0.4) * r);
  camera.lookAt(cx, 1, cz);
  if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
  safe('render.prerace', () => {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
    renderer.render(w.scene, camera);
  });
}

// ---------------------------------------------------------------------------------------------
// Latency overlay (host hotkey F3)
// ---------------------------------------------------------------------------------------------
let latencyEl = null, latencyOn = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') { e.preventDefault(); latencyOn = !latencyOn; latencyEl && latencyEl.classList.toggle('on', latencyOn); }
});
function ensureLatencyEl() {
  if (latencyEl) return latencyEl;
  latencyEl = document.createElement('div');
  latencyEl.className = 'latency-overlay';
  uiRoot.appendChild(latencyEl);
  return latencyEl;
}
function updateLatencyOverlay(frameMs) {
  // FPS accounting runs whether or not the overlay is visible — the numbers are also
  // what the adaptive quality controller and the measurement harness rely on.
  const r = eventRadar;
  r.frameMsEma = r.frameMsEma ? r.frameMsEma + (frameMs - r.frameMsEma) * 0.12 : frameMs;
  r.lastFps = 1000 / Math.max(0.5, r.frameMsEma);
  r.lastFpsText = r.lastFps >= 10 ? String(Math.round(r.lastFps)) : r.lastFps.toFixed(1);
  if (!latencyOn) return;
  ensureLatencyEl().classList.add('on');
  const s = netClient ? netClient.aggregateStats() : null;
  const teams = (eventLobby && eventLobby.teams) || [];
  const rows = teams.map((t) => `<div class="lr"><span>P${t.id}</span><b class="${t.p95 <= 30 ? 'good' : t.p95 <= 60 ? 'warn' : 'bad'}">${t.ping || '--'}ms / p95 ${t.p95 || '--'} / j ${Math.round(t.jitter || 0)}</b></div>`).join('');
  // software input -> applied latency estimate for most recent packet per team
  let inLat = '--';
  const offs = netClient && netClient.clock ? netClient.clock.offset : 0;
  if (netClient) {
    let total = 0, n = 0;
    for (const [tid, st] of netClient.latest) {
      if (!st) continue;
      const clientOff = netOffsets.get(tid);
      if (typeof clientOff !== 'number') continue;
      const est = st.hostReceivedAt - (st.clientTimestamp + offs - clientOff);
      if (isFinite(est) && est >= 0 && est < 2000) { total += est; n++; }
    }
    if (n) inLat = `${Math.round(total / n)} ms`;
  }
  latencyEl.innerHTML = `
    <div class="lr"><span>FPS</span><b>${eventRadar.lastFpsText || eventRadar.lastFps}</b></div>
    <div class="lr"><span>frame</span><b>${frameMs.toFixed(1)} ms</b></div>
    <div class="lr"><span>physics</span><b>${eventRadar.physicsMs.toFixed(1)} ms</b></div>
    <div class="lr"><span>render</span><b>${eventRadar.renderMs.toFixed(1)} ms</b></div>
    <div class="lr"><span>long frames</span><b>${eventRadar.longFrames}</b></div>
    <div class="lr"><span>update rate</span><b>${s ? s.rate : '--'}/s</b></div>
    <div class="lr"><span>stale inputs</span><b>${s ? s.dropped : '--'}</b></div>
    <div class="lr"><span>input→applied</span><b>${inLat}</b></div>
    ${rows}`;
}


// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
async function boot() {
  document.body.dataset.state = 'boot';
  menu.showLoading('LOADING');
  requestAnimationFrame(frame);
  await loadModules();
  if (mods.input && mods.input.InputController) input = safe('input.ctor', () => new mods.input.InputController());
  if (mods.models && mods.models.createCharacterPortrait) {
    const fn = (c) => mods.models.createCharacterPortrait(c);
    safe('portraits', () => menu.setPortraitProvider(fn));
    hud.setPortraitProvider(fn);
  }
  buildAttract();
  menu.showTitle();
  setState('title');
  audio.playMusic('menu');
  // Straight to the QR lobby: the server prints http://localhost:8081/?event as the BIG SCREEN
  // link, and a big screen that already owns a room (?room=ABCD, written into the URL when the
  // lobby opens) comes back to that same lobby after a refresh instead of the title screen,
  // so connected phones find their big screen again.
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('event') || roomFromUrl()) startEvent();
  } catch (e) { report('boot.event', e); }
}
boot();

// ---------------------------------------------------------------------------------------------
// Debug / test hook
// ---------------------------------------------------------------------------------------------
window.__game = {
  get state() { return state; },
  get mode() { return mode; },
  get eventPhase() { return eventPhase; },
  eventDebug: () => ({
    mode, eventPhase, state, preraceTimer, worldMode: world && world.mode,
    splitCams: split ? split.cams.length : 0, racePhase: world && world.race && world.race.phase,
    physicsMs: +eventRadar.physicsMs.toFixed(1), renderMs: +eventRadar.renderMs.toFixed(1),
    fps: eventRadar.lastFps, longFrames: eventRadar.longFrames, tier: split && split.tierIndex,
    radar: { frames: eventRadar.frames, frameMsEma: +eventRadar.frameMsEma.toFixed(1) },
  }),
  /** Diagnostics probe used by the measurement harness (and by /diagnostics). */
  enableProbe() { eventProbe.on = true; eventProbe.rows.length = 0; return true; },
  probeData() {
    return {
      frames: eventProbe.rows.length,
      frameMs: percentiles(eventProbe.rows.map((r) => r.ft)),
      physicsMs: percentiles(eventProbe.rows.map((r) => r.physics)),
      renderMs: percentiles(eventProbe.rows.map((r) => r.render)),
    };
  },
  get world() { return world; },
  get eventRoom() { return eventRoom; },
  newRoom: () => regenerateEventRoom(),
  get mods() { return mods; },
  audio, hud, menu, renderer, camera, bus,
  startRace: (s = {}) => startRace({ ...lastSettings, ...s }),
  goToTitle,
  skipIntro: () => beginCountdown(),
  errors: () => [...seenErrors],
  /** Put the player on its final lap just behind the line; drive on to finish. */
  toFinalLap() {
    const w = world; if (!w || !w.player) return;
    w.race.debugSetLap(w.player, w.race.laps);
    if (w.race.laps > 1) bus.emit('race:finalLap', {});
  },
  /** Instantly finish the player's race in the current place. */
  finishPlayer() {
    const w = world; if (!w || !w.player) return;
    w.race.debugSetLap(w.player, w.race.laps + 1);
    w.race._finish(w.player);
  },
  /** Debug/test: send a raw control message to the local event server. */
  send: (msg) => netClient && netClient.send(msg),
  /** Debug/test: skip the event countdown and go straight to racing. */
  skipEventCountdown() {
    const w = world; if (!w || w.mode !== 'event' || !w.race) return false;
    w.race.countdownTime = 99;
    return true;
  },
  /** Debug/test: skip the solo countdown the same way. */
  skipCountdown() {
    const w = world; if (!w || !w.race) return false;
    w.race.countdownTime = 99;
    return true;
  },
  netStats: () => netClient && ({ stats: netClient.aggregateStats(), perTeam: Object.fromEntries([...netClient.teamStats].map(([id, s]) => [id, s.snapshot()])), clockOffset: netClient.clock.offset, connected: netClient.connected, lobbyPing: eventLobby && eventLobby.teams.map((t) => ({ id: t.id, ping: t.ping, p95: t.p95, jitter: t.jitter })) }),
  debugLobby: () => eventLobby && eventLobby.teams.map((t) => ({ id: t.id, ai: t.ai, conn: t.connected, sessionId: t.sessionId })),
  sessionSettings: () => (eventSession && eventSession.settings) || null,
  /** Debug/test: pin the adaptive render-scale tier. */
  setSplitTier(i) { if (split) { split.tierIndex = Math.max(0, Math.min(SCALE_TIERS.length - 1, i | 0)); split._applyTier(); } return split && split.tierIndex; },
  /**
 * Authoritative read-back: re-renders one split frame and reads each viewport straight out
 * of three.js (`getViewport` returns CSS pixels), so tests and field diagnosis compare the
 * real GL state — not our own arithmetic.
 */
  readViewport() {
    const w = world; if (!w || !split || !split.cams.length) return { mapping: null, viewports: [] };
    split.render(w.scene, (eventSession && eventSession.settings && eventSession.settings.cameraMode === 'broadcast') === true);
    const v = new THREE.Vector4();
    const canvasH = split.lastMapping ? split.lastMapping.cssH : window.innerHeight;
    const out = [];
    for (let i = 0; i < split.cams.length; i++) {
      renderer.getViewport(v);
      // re-render to leave the viewport set for this camera in place
      split.renderOne(i, w.scene);
      renderer.getViewport(v);
      out.push({ x: Math.round(v.x), y: Math.round(canvasH - (v.y + v.z)), w: Math.round(v.z), h: Math.round(v.w) });
    }
    return { mapping: split.lastMapping, viewports: out };
  },
  THREE,
  /** Debug/test: pin the adaptive render-scale tier. */
  viewportDebug: () => (split && split.lastViewports ? { mapping: split.lastMapping, viewports: split.lastViewports } : null),
  manualRender: () => {
    const w = world; if (!w || !split || !split.cams.length) return 'no-world';
    const r = renderer, size = new THREE.Vector2();
    r.getDrawingBufferSize(size);
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    r.setClearColor(0x102030, 1);
    r.clear();
    r.render(w.scene, split.cams[split.broadcastIndex].camera);
    return { w: size.x, h: size.y, calls: r.info.render.calls };
  },
  splitDebug: () => split && ({
    cams: split.cams.length, index: split.broadcastIndex, tier: split.tierIndex,
    broadcast: !!split.broadcastMode,
    cam0: split.cams[split.broadcastIndex] ? {
      pos: split.cams[split.broadcastIndex].camera.position.toArray().map((v) => +v.toFixed(1)),
      kart: split.cams[split.broadcastIndex].kart && split.cams[split.broadcastIndex].kart.position.toArray().map((v) => +v.toFixed(1)),
    } : null,
  }),
  /** Debug/test: advance the fixed-step simulation without waiting for frames. */
  simulateFor(seconds) {
    const w = world; if (!w) return 0;
    const steps = Math.min(20000, Math.round(seconds / FIXED_DT));
    for (let i = 0; i < steps; i++) { capturePrevPoses(w); simulate(w, FIXED_DT); }
    return steps;
  },
  PHYSICS,
  debug,
};
