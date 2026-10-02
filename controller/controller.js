// Phone controller: join, lobby/select/ready, race input pad, results.
import { CHARACTERS } from '/src/config.js';
import { encodeInput, FLAG_DRIFT, FLAG_LOOKBACK, FLAG_ITEM, FLAG_HOP, FLAG_PAUSE } from '/src/multiplayer/protocol.js';
import { ClockSync, LinkStats } from '/src/multiplayer/latency.js';

const $ = (id) => document.getElementById(id);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const state = {
  ws: null, token: localStorage.getItem('tkr-token') || null, teamId: 0, sessionId: 0,
  name: localStorage.getItem('tkr-name') || '', flow: 'lobby', ready: false,
  charIdx: 0, color: '#e53935', battery: null, suspended: false,
};
const log = new LinkStats();
const clock = new ClockSync();
let seq = 0;

// ---------------- networking
function connect() {
  const ws = state.ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', token: state.token, name: state.name }));
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    $('join-status').textContent = 'Connection lost — reconnecting…';
    setTimeout(connect, 800);
  };
}
function send(o) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); }

function onMessage(m) {
  switch (m.type) {
    case 'joined':
      state.teamId = m.teamId; state.sessionId = m.sessionId; state.token = m.token;
      state.color = m.color; state.flow = m.flow || 'lobby';
      localStorage.setItem('tkr-token', m.token);
      $('team-name').textContent = state.name || `Team ${m.teamId}`;
      $('team-color').style.background = m.color;
      showView('lobby');
      break;
    case 'spectating': $('join-status').textContent = 'Lobby full — spectating.'; break;
    case 'selectDenied': buzz(60); break;
    case 'lobby':
      state.flow = m.state.flow;
      const me = m.state.teams.find((t) => t.id === state.teamId);
      if (me) {
        state.charIdx = me.characterIdx;
        state.ready = me.ready;
        localStorage.setItem('tkr-name', me.name);
        $('team-name').textContent = me.name;
        $('ping').textContent = me.ping || '--';
        renderChars(m.state.teams);
        $('ready-btn').textContent = state.ready ? 'READY ✓' : 'READY';
        $('ready-btn').classList.toggle('ready', state.ready);
      }
      if (m.state.flow === 'prerace' || m.state.flow === 'racing' || m.state.flow === 'countdown') showView('race');
      else if (m.state.flow === 'results' || m.state.flow === 'leaderboard') showView('end');
      else showView('lobby');
      break;
    case 'standings': {
      const me = (m.rows || []).find((r) => r.teamId === state.teamId);
      $('race-pos').textContent = me ? `${['1st','2nd','3rd','4th','5th','6th'][me.place - 1] || ''} · L${me.lap}` : '';
      break;
    }
    case 'pong': {
      const now = performance.now();
      log.addRtt(now - m.c);
      clock.addSample(m.c, now, m.s);
      $('ping').textContent = Math.round(log.currentRtt);
      break;
    }
  }
}

// ping + stats reporting
setInterval(() => send({ type: 'ping', c: performance.now() }), 1000);
setInterval(() => {
  const s = log.snapshot();
  send({ type: 'clientStats', rtt: s.p50, p95: s.p95, jitter: s.jitter, battery: state.battery, offset: clock.offset });
}, 2000);
// battery
if (navigator.getBattery) navigator.getBattery().then((b) => {
  const up = () => { state.battery = Math.round(b.level * 100); };
  up(); b.addEventListener('levelchange', up);
}).catch(() => {});

// ---------------- views
const views = { join: $('view-join'), lobby: $('view-lobby'), race: $('view-race'), end: $('view-end') };
function showView(name) {
  for (const k of Object.keys(views)) views[k].classList.toggle('active', k === name);
}

// A phone that already owns a slot reclaims it automatically on reload: the same
// team, the same screen, no re-typing the name.
function autoResume() {
  if (!state.token) { showView('join'); return; }
  showView('join');
  $('join-status').textContent = 'Reclaiming your slot…';
  connect();
}

// ---------------- lobby
const charGrid = $('char-grid');
charGrid.innerHTML = CHARACTERS.map((c, i) => `<button class="char" data-i="${i}"><span class="dot" style="background:${hex(c.color)}"></span>${c.name}</button>`).join('');
charGrid.querySelectorAll('.char').forEach((el) => {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    send({ type: 'select', characterIdx: +el.dataset.i });
    buzz(10);
  });
});
function renderChars(teams) {
  const taken = new Set(teams.filter((t) => t.connected && t.id !== state.teamId).map((t) => t.characterIdx));
  charGrid.querySelectorAll('.char').forEach((el, i) => {
    el.classList.toggle('sel', i === state.charIdx);
    el.classList.toggle('taken', taken.has(i));
  });
}
$('ready-btn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  state.ready = !state.ready;
  send({ type: 'ready', ready: state.ready });
  buzz(state.ready ? 30 : 10);
});
$('name-input').value = state.name;
autoResume();
$('join-btn').addEventListener('click', () => {
  state.name = $('name-input').value.trim().slice(0, 14);
  localStorage.setItem('tkr-name', state.name);
  $('join-status').textContent = 'Joining…';
  connect();
});

// ---------------- race input pad
const btn = { left: false, right: false, gas: false, brake: false, drift: false, item: false, look: false };
let itemEdge = false, hopEdge = false, pauseEdge = false;
function bindPad(id, key) {
  const el = $(id);
  const on = (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch {} btn[key] = true; el.classList.add('on'); buzz(8); if (key === 'item') itemEdge = true; if (key === 'drift') hopEdge = true; };
  const off = (e) => { e.preventDefault(); btn[key] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('lostpointercapture', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindPad('ctl-left', 'left'); bindPad('ctl-right', 'right'); bindPad('ctl-gas', 'gas');
bindPad('ctl-brake', 'brake'); bindPad('ctl-drift', 'drift'); bindPad('ctl-item', 'item'); bindPad('ctl-look', 'look');

// send input at ~30 Hz; edges ride on the next packet immediately too
setInterval(() => {
  if (state.flow !== 'racing' && state.flow !== 'countdown') { itemEdge = hopEdge = pauseEdge = false; return; }
  sendInput();
}, 33);
function sendInput() {
  const steer = (btn.right ? 1 : 0) - (btn.left ? 1 : 0);
  const flags = (btn.drift ? FLAG_DRIFT : 0) | (btn.look ? FLAG_LOOKBACK : 0) | (itemEdge ? FLAG_ITEM : 0) | (hopEdge ? FLAG_HOP : 0) | (pauseEdge ? FLAG_PAUSE : 0);
  const packet = encodeInput({
    teamId: state.teamId, sessionId: state.sessionId, seq: seq++,
    timestamp: performance.now(), steer, throttle: btn.gas ? 1 : 0, brake: btn.brake ? 1 : 0, flags,
  });
  if (state.ws && state.ws.readyState === 1) state.ws.send(packet);
  log.addUpdate(seq);
  itemEdge = hopEdge = pauseEdge = false;
}
// immediate edge send (do not wait up to 33ms for the tick)
window.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (t && t.id === 'ctl-item') { itemEdge = true; if (state.flow === 'racing') sendInput(); }
  if (t && t.id === 'ctl-drift') { hopEdge = true; if (state.flow === 'racing') sendInput(); }
});
document.addEventListener('visibilitychange', () => { state.suspended = document.hidden; });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }
function hex(c) { return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6); }

$('end-body').textContent = 'Race complete — check the projector for the leaderboard!';
