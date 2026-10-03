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
  setConn('connecting', 'Connecting…');
  $('join-btn').disabled = true;
  const ws = state.ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    reconnectAttempts = 0;
    suppressReconnect = false;
    ws.send(JSON.stringify({ type: 'join', token: state.token, name: state.name }));
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    if (suppressReconnect) return;
    reconnectAttempts++;
    const delay = Math.min(5000, 800 * Math.pow(1.5, Math.min(reconnectAttempts, 5)));
    setConn('reconnecting', `Connection lost — retrying (${reconnectAttempts})…`, 'warn');
    $('join-btn').disabled = false;
    setTimeout(() => { if (!suppressReconnect) connect(); }, delay);
  };
  ws.onerror = () => {
    setConn('offline', 'Network error — check Wi-Fi, then RETRY.', 'err');
    try { ws.close(); } catch {}
  };
}
function send(o) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); }

// ---------------- connection status (one bar, every screen) ----------------
// States: idle | connecting | connected | reconnecting | offline.
// The bar is the only place connection truth lives, so a mid-race drop can never be silent.
const connBar = $('conn-bar'), connText = $('conn-text'), retryBtn = $('retry-btn');
function setConn(s, text, cls) {
  connBar.dataset.state = s;
  connText.textContent = text;
  const st = $('join-status');
  if (st && (s === 'reconnecting' || s === 'offline')) { st.textContent = text; st.className = 'status ' + (cls || 'warn'); }
  retryBtn.hidden = !(s === 'reconnecting' || s === 'offline');
}
retryBtn.addEventListener('click', () => {
  suppressReconnect = false; reconnectAttempts = 0;
  setConn('connecting', 'Reconnecting…');
  try { state.ws && state.ws.close(); } catch {}
  connect();
});

// Keep the phone awake while racing: a sleeping screen looks exactly like a dead controller.
let wakeLock = null;
async function holdWake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.flow === 'racing') holdWake();
});

// Phones get suspended by the OS: the socket can die without a close event, leaving a
// "connected but silent" controller. Watchdog: no pong for a while => force a reconnect.
// NOTE: lastPong is refreshed in the 'pong' handler below; without that this would kill
// healthy connections.
let lastPong = performance.now();
let reconnectAttempts = 0;
let suppressReconnect = false;
setInterval(() => {
  if (suppressReconnect) return;
  if (state.ws && state.ws.readyState === 1 && performance.now() - lastPong > 8000) {
    setConn('reconnecting', 'Connection stale — reconnecting…', 'warn');
    try { state.ws.close(); } catch {}
  }
}, 3000);

function onMessage(m) {
  switch (m.type) {
    case 'joined':
      state.teamId = m.teamId; state.sessionId = m.sessionId; state.token = m.token;
      state.color = m.color; state.flow = m.flow || 'lobby';
      localStorage.setItem('tkr-token', m.token);
      $('team-name').textContent = state.name || `Team ${m.teamId}`;
      $('team-color').style.background = m.color;
      $('join-btn').disabled = false;
      $('forget-btn').hidden = false;
      setConn('connected', `Connected · ${state.name || ('Team ' + m.teamId)}`);
      setStatus(`Joined as ${state.name || ('Team ' + m.teamId)}`, 'ok');
      showView('lobby');
      break;
    case 'spectating':
      setConn('connected', 'Connected · spectating (lobby full)');
      setStatus('Lobby full — spectating.', 'warn');
      break;
    case 'selectDenied': buzz(60); break;
    case 'removed': {
      // the host dropped this slot: forget the token and go back to the join screen
      state.token = null; state.teamId = 0; state.ready = false;
      localStorage.removeItem('tkr-token');
      suppressReconnect = true;
      releaseWake();
      try { state.ws.close(); } catch {}
      setConn('idle', 'Removed by host');
      $('forget-btn').hidden = true;
      showView('join');
      setStatus('The host removed your team — tap JOIN to re-enter.', 'warn');
      break;
    }
    case 'lobby': {
      const prevFlow = state.flow;
      state.flow = m.state.flow;
      if (prevFlow !== state.flow) onFlowChange(prevFlow, state.flow);
      const me = m.state.teams.find((t) => t.id === state.teamId);
      if (me) {
        state.charIdx = me.characterIdx;
        state.ready = me.ready;
        localStorage.setItem('tkr-name', me.name);
        $('team-name').textContent = me.name;
        renderChars(m.state.teams);
        updateNetPill(me);
        $('ready-btn').textContent = state.ready ? 'READY ✓' : 'READY';
        $('ready-btn').classList.toggle('ready', state.ready);
        $('ready-btn').setAttribute('aria-pressed', state.ready ? 'true' : 'false');
        if (state.ws && state.ws.readyState === 1) setConn('connected', `Connected · ${me.name}`);
      }
      if (m.state.flow === 'prerace' || m.state.flow === 'racing' || m.state.flow === 'countdown') showView('race');
      else if (m.state.flow === 'results' || m.state.flow === 'leaderboard') { renderEnd(); showView('end'); }
      else showView('lobby');
      break;
    }
    case 'standings': {
      const me = (m.rows || []).find((r) => r.teamId === state.teamId);
      if (me) {
        state.lastPlace = me.place; state.lastLap = me.lap;
        $('race-pos').textContent = `${['1st','2nd','3rd','4th','5th','6th'][me.place - 1] || ''} · L${me.lap}`;
      } else $('race-pos').textContent = '';
      break;
    }
    case 'pong': {
      const now = performance.now();
      lastPong = now;
      log.addRtt(now - m.c);
      clock.addSample(m.c, now, m.s);
      updateNetPill();
      break;
    }
  }
}

function setStatus(text, cls) {
  const st = $('join-status');
  st.textContent = text;
  st.className = 'status' + (cls ? ' ' + cls : '');
}

/** Human-readable link quality: students don't think in milliseconds. */
function linkQuality() {
  const s = log.snapshot();
  const rtt = s.p50 || 0;
  if (!rtt) return { label: '…', cls: '' };
  if (rtt <= 30 && s.jitter <= 12) return { label: 'EXCELLENT', cls: 'good' };
  if (rtt <= 80) return { label: 'OK', cls: 'ok' };
  return { label: 'LAGGY', cls: 'bad' };
}

function updateNetPill(me) {
  const s = log.snapshot();
  const ms = Math.round(s.p50 || 0);
  $('ping').textContent = ms || '--';
  const q = linkQuality();
  $('ping-quality').textContent = q.label;
  $('net-pill').className = q.cls;
  $('conn-dot2').style.background = q.cls === 'good' ? '#43a047' : q.cls === 'ok' ? '#fdd835' : q.cls === 'bad' ? '#e53935' : '#666';
  const d = $('net-detail');
  if (d && !d.hidden) d.textContent = `ping ${ms}ms · p95 ${Math.round(s.p95 || 0)}ms · jitter ${Math.round(s.jitter || 0)}ms`;
}
$('net-pill').addEventListener('click', () => {
  const d = $('net-detail');
  d.hidden = !d.hidden;
  if (!d.hidden) updateNetPill();
});

// Flow transitions drive the countdown overlay, wake lock and haptics.
let cdTimer = 0;
function onFlowChange(from, to) {
  clearTimeout(cdTimer);
  const ov = $('countdown-overlay');
  ov.classList.remove('show', 'go');
  if (to === 'countdown' || to === 'prerace') {
    holdWake();
    flashCountdown('…');
    buzz([40, 60, 40]);
  } else if (to === 'racing') {
    holdWake();
    flashCountdown('GO!', true);
    buzz([0, 80, 40, 80, 40, 120]);
    cdTimer = setTimeout(() => ov.classList.remove('show', 'go'), 1200);
  } else if (to === 'results' || to === 'leaderboard') {
    releaseWake();
    if (state.lastPlace) buzz([0, 60, 60, 60, 60, 120]);
  } else {
    if (to === 'lobby') releaseWake();
  }
  $('race-team').textContent = state.name || (state.teamId ? `TEAM ${state.teamId}` : '');
}
function flashCountdown(text, go) {
  const ov = $('countdown-overlay');
  ov.textContent = text;
  ov.classList.toggle('go', !!go);
  ov.classList.remove('show'); void ov.offsetWidth; ov.classList.add('show');
  if (!go) { clearTimeout(cdTimer); cdTimer = setTimeout(() => ov.classList.remove('show'), 1100); }
}

/** Personal result card: your place and points, not just "check the projector". */
function renderEnd() {
  const pts = [10, 8, 6, 4, 2, 1];
  const p = state.lastPlace || 0;
  $('end-place').textContent = p ? ['1st','2nd','3rd','4th','5th','6th'][p - 1] : '—';
  $('end-detail').textContent = p ? `${state.name || ('Team ' + state.teamId)} · +${pts[p - 1] ?? 0} pts` : '';
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
$('forget-btn').hidden = !state.token;
autoResume();
function doJoin() {
  state.name = $('name-input').value.trim().slice(0, 14) || state.name;
  $('name-input').value = state.name;
  localStorage.setItem('tkr-name', state.name);
  setStatus('Joining…', '');
  setConn('connecting', 'Connecting…');
  suppressReconnect = false;
  reconnectAttempts = 0;
  $('join-btn').disabled = true;
  try { state.ws && state.ws.close(); } catch {}
  connect();
}
$('join-btn').addEventListener('click', doJoin);
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
$('forget-btn').addEventListener('click', () => {
  state.token = null; state.teamId = 0;
  localStorage.removeItem('tkr-token');
  $('forget-btn').hidden = true;
  setStatus('Saved slot forgotten — enter a name and JOIN for a fresh slot.', '');
});
window.addEventListener('online', () => {
  if (suppressReconnect) return;
  $('join-status').textContent = 'Back online — reconnecting…';
  try { state.ws && state.ws.close(); } catch {}
  connect();
});
document.addEventListener('visibilitychange', () => {
  state.suspended = document.hidden;
  if (!document.hidden && state.token && (!state.ws || state.ws.readyState !== 1)) {
    // returning from background: reclaim the slot immediately instead of waiting
    suppressReconnect = false;
    connect();
  }
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
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch {} }
$('pause-btn').addEventListener('click', (e) => {
  e.preventDefault();
  pauseEdge = true;
  if (state.flow === 'racing') sendInput();
  buzz(20);
  setStatus('Pause requested — the host decides.', '');
});
$('fs-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {}
});
$('end-lobby-btn').addEventListener('click', () => showView('lobby'));
function hex(c) { return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6); }

$('end-body').textContent = 'Race complete — check the projector for the leaderboard!';
