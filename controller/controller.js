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
  pointsTable: [10, 8, 6, 4, 2, 1], raceIndex: 0, lastPlace: 0, lastLap: 1, itemHeld: null,
  totalLaps: null, totalRaces: null, finalLapShown: false,
  itemJustUsed: null, itemUsedAt: 0, lowBattWarned: false,
  lastBoard: null, finishJingleKey: null,
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
      const st = (m && m.state) || {};
      const prevFlow = state.flow;
      if (typeof st.flow === 'string') state.flow = st.flow;
      if (prevFlow !== state.flow) onFlowChange(prevFlow, state.flow);
      if (Array.isArray(st.pointsTable)) state.pointsTable = st.pointsTable;
      if (typeof st.raceIndex === 'number') state.raceIndex = st.raceIndex;
      else state.raceIndex = undefined;
      if (st.settings && typeof st.settings.laps === 'number') state.totalLaps = st.settings.laps;
      if (typeof st.laps === 'number' && st.laps > 0) state.totalLaps = st.laps;
      if (typeof st.totalRaces === 'number') state.totalRaces = st.totalRaces;
      else state.totalRaces = undefined;
      const teams = Array.isArray(st.teams) ? st.teams : [];
      const me = teams.find((t) => t && t.id === state.teamId);
      const readyCount = teams.filter((t) => t && t.connected && t.ready).length;
      const connectedCount = teams.filter((t) => t && t.connected).length;
      if (me) {
        state.charIdx = me.characterIdx;
        state.ready = me.ready;
        localStorage.setItem('tkr-name', me.name);
        $('team-name').textContent = me.name;
        renderChars(teams);
        updateNetPill(me);
        $('ready-btn').textContent = state.ready ? 'READY ✓' : 'READY';
        $('ready-btn').classList.toggle('ready', state.ready);
        $('ready-btn').setAttribute('aria-pressed', state.ready ? 'true' : 'false');
        if (state.ws && state.ws.readyState === 1) setConn('connected', `Connected · ${me.name}`);
        // lobby hint teaches the room state: how many are ready, whose move it is
        $('lobby-hint').textContent = state.ready
          ? (readyCount >= connectedCount && connectedCount > 0 ? 'You’re READY — waiting for the host to start.' : `You’re READY — ${readyCount}/${Math.max(connectedCount, 1)} ready. Nudge your friends!`)
          : (connectedCount <= 1 ? 'Pick your racer, press READY. Host starts the race.' : `${readyCount}/${connectedCount} ready — pick your racer and tap READY.`);
      }
      if (state.flow === 'prerace' || state.flow === 'racing' || state.flow === 'countdown') showView('race');
      else if (state.flow === 'results' || state.flow === 'leaderboard') { renderEnd(); showView('end'); }
      else showView('lobby');
      updateRaceLines();
      updateRocketHint();
      break;
    }
    case 'session': {
      // points table + race index so the results card matches the host's rules
      if (m.state) {
        if (Array.isArray(m.state.pointsTable)) state.pointsTable = m.state.pointsTable;
        if (typeof m.state.raceIndex === 'number') state.raceIndex = m.state.raceIndex;
        else if ('raceIndex' in m.state) state.raceIndex = undefined;
        if (m.state.settings && typeof m.state.settings.laps === 'number') state.totalLaps = m.state.settings.laps;
        if (typeof m.state.laps === 'number' && m.state.laps > 0) state.totalLaps = m.state.laps;
        if (typeof m.state.totalRaces === 'number') state.totalRaces = m.state.totalRaces;
        else if ('totalRaces' in m.state) state.totalRaces = undefined;
        if (m.state.settings && typeof m.state.settings.raceSpeed !== 'undefined') state.raceSpeed = m.state.settings.raceSpeed;
        updateRaceLines();
      }
      break;
    }
    case 'countdown': {
      // live numbers from the host (3-2-1), not just a static "…" overlay
      const n = m.n;
      if (n === 'GO' || n === 0) { flashCountdown('GO!', true); buzz([0, 80, 40, 80, 40, 120]); }
      else if (typeof n === 'number' && n > 0) { flashCountdown(String(n)); beep(440 + (3 - Math.min(n, 3)) * 110, 0.12); buzz(30); }
      break;
    }
    case 'standings': {
      const rows = Array.isArray(m.rows) ? m.rows : [];
      const me = rows.find((r) => r && r.teamId === state.teamId);
      if (me) {
        const place = +me.place || 0;
        const lap = +me.lap || 0;
        const dir = overtakeDir(state.lastPlace, place);
        const lapMsg = lapFlashText(state.lastLap, lap, state.totalLaps);
        if (place) state.lastPlace = place;
        if (lap) state.lastLap = lap;
        const ord = ordinal(place);
        $('race-pos').textContent = ord ? `${ord} · L${lap || state.lastLap}` : '';
        // Held item: the host is the source of truth. A same-item echo arriving
        // right after our optimistic clear is stale, so keep the pad cleared.
        const now = Date.now();
        let item = me.item || null;
        if (item && state.itemJustUsed && item === state.itemJustUsed && (now - state.itemUsedAt) < 1500) {
          item = null;
        } else {
          state.itemJustUsed = null;
        }
        setItemHeld(item);
        // Wrong-way: evaluate ONLY this fresh standings row (never stale state).
        updateWrongWay(me && me.wrong === true);
        // FINAL LAP: only when the host told us laps (state.totalLaps>1) and this
        // row is on the last lap. Once per race; never guess when laps unknown.
        const lapsKnown = (+state.totalLaps || 0) > 1;
        const isFinal = lapsKnown && lap === (+state.totalLaps) && lap > 1;
        if (isFinal && !state.finalLapShown) {
          state.finalLapShown = true;
          flashEvent('FINAL LAP!', 'lap final');
          buzz([0, 60, 40, 60, 40, 120]); beep(660, 0.1); setTimeout(() => beep(990, 0.14), 110);
        }
        // Lap flash wins the shared chip slot; otherwise show overtake / loss.
        else if (lapMsg) { flashEvent(lapMsg, 'lap'); buzz([0, 60, 40, 60, 40, 120]); beep(660, 0.1); setTimeout(() => beep(990, 0.14), 110); }
        else if (dir === 'up' && place) { flashEvent(`P${place} ▲`, 'up'); buzz([0, 40, 40, 80]); beep(880, 0.09); setTimeout(() => beep(1174, 0.12), 90); }
        else if (dir === 'down' && place) { flashEvent(`P${place} ▼`, 'down'); buzz(120); beep(220, 0.18, 'sawtooth', 0.05); }
      } else $('race-pos').textContent = '';
      if (!me) updateWrongWay(false);
      break;
    }
    case 'results': {
      // Optional mini standings board (server crew adds this; may never arrive).
      // Tolerant: missing/empty rows leave the personal end card untouched.
      try {
        const rows = Array.isArray(m.rows) ? m.rows : [];
        if (typeof m.raceIndex === 'number') state.raceIndex = m.raceIndex;
        const norm = rows
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            teamId: (typeof r.teamId === 'number') ? r.teamId : null,
            place: (+r.place || 0),
            name: (typeof r.name === 'string' && r.name) ? r.name : null,
            points: (typeof r.points === 'number' && Number.isFinite(r.points)) ? r.points : null,
          }))
          .sort((a, b) => ((a.place || 999) - (b.place || 999)))
          .slice(0, 6);
        state.lastBoard = norm;
        const mine = norm.find((r) => r.teamId !== null && r.teamId === state.teamId);
        if (mine && mine.place) state.lastPlace = mine.place;
        if (state.flow === 'results' || state.flow === 'leaderboard') {
          renderEnd();
          playFinishJingle(state.lastPlace);
        }
      } catch {}
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
  const chip = $('event-chip');
  if (chip) { clearTimeout(eventTimer); chip.className = ''; chip.hidden = true; }
  if (to === 'countdown' || to === 'prerace') state.finalLapShown = false;
  if (from === 'racing' && to !== 'racing') state.finalLapShown = false;
  if (to === 'countdown' || to === 'prerace' || to === 'racing') {
    // Fresh race: first sightings of place/lap must stay silent, and any stale
    // held-item display is dropped (standings will re-assert it).
    state.lastPlace = 0; state.lastLap = 1;
    state.itemJustUsed = null;
    state.lastBoard = null; state.finishJingleKey = null;
    const board = $('end-standings');
    if (board) { board.hidden = true; board.textContent = ''; }
    setItemHeld(null);
    updateWrongWay(false);
    maybeBattWarn();
  }
  const ov = $('countdown-overlay');
  ov.classList.remove('show', 'go');
  if (to === 'prerace') {
    holdWake();
    flashCountdown('GET READY…');
    // Prerace waits on the host: keep the interstitial up (cancel the
    // transient 1.1s hide) so players know they are connected.
    clearTimeout(cdTimer);
    ov.textContent = 'GET READY…';
    ov.classList.add('show');
    buzz([40, 60, 40]);
  } else if (to === 'countdown') {
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
    playFinishJingle(state.lastPlace);
  } else {
    if (to === 'lobby') releaseWake();
  }
  $('race-team').textContent = state.name || (state.teamId ? `TEAM ${state.teamId}` : '');
  updateRocketHint();
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
  try {
    const pts = state.pointsTable || [10, 8, 6, 4, 2, 1];
    const p = state.lastPlace || 0;
    const ord = ordinal(p);
    const placeEl = $('end-place'), detailEl = $('end-detail'), champEl = $('end-champ');
    if (placeEl) placeEl.textContent = ord || '—';
    if (detailEl) detailEl.textContent = ord ? `${state.name || ('Team ' + state.teamId)} · +${pts[p - 1] ?? 0} pts` : '';
    if (champEl) {
      if (p === 1) { champEl.textContent = '🏆 CHAMPION OF THE RACE'; champEl.hidden = false; }
      else { champEl.textContent = ''; champEl.hidden = true; }
    }
    renderBoard();
    updateRaceLines();
  } catch {}
}

/** Mini standings board: top-6 rows from the cached `results` message.
 *  No-op (hidden, personal card untouched) when no board has arrived yet.
 *  Tolerant: empty rows, missing names/points render as "—", never throws. */
function renderBoard() {
  try {
    const el = $('end-standings');
    if (!el) return;
    const board = Array.isArray(state.lastBoard) ? state.lastBoard : null;
    if (!board || board.length === 0) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = '';
    const top = board.slice(0, 6);
    for (const r of top) {
      if (!r || typeof r !== 'object') continue;
      const row = document.createElement('div');
      const own = (r.teamId !== null && r.teamId !== undefined && r.teamId === state.teamId);
      row.className = 'end-row' + (own ? ' own' : '');
      if (own && state.color) {
        try { row.style.borderColor = state.color; } catch {}
      }
      const pEl = document.createElement('span');
      pEl.className = 'p';
      pEl.textContent = (r.place && ordinal(r.place)) ? ordinal(r.place) : '—';
      const nEl = document.createElement('span');
      nEl.className = 'n';
      nEl.textContent = (typeof r.name === 'string' && r.name) ? r.name : '—';
      const ptsEl = document.createElement('span');
      ptsEl.className = 'pts';
      ptsEl.textContent = (typeof r.points === 'number' && Number.isFinite(r.points)) ? `+${r.points}` : '—';
      row.append(pEl, nEl, ptsEl);
      el.appendChild(row);
    }
    el.hidden = false;
  } catch {}
}

/** Pure race-feel helpers (kept side-effect free so they stay unit-testable). */
function ordinal(p) { return ['1st', '2nd', '3rd', '4th', '5th', '6th'][(+p || 0) - 1] || ''; }
/** Which way did we move? null on first sighting / no change / bad data. */
function overtakeDir(prev, next) {
  prev = +prev || 0; next = +next || 0;
  if (!prev || !next || prev === next) return null;
  return next < prev ? 'up' : 'down';
}
/** Lap banner text, or null when nothing worth flashing (incl. first sighting of lap 1). */
function lapFlashText(prevLap, newLap, totalLaps) {
  prevLap = +prevLap || 0; newLap = +newLap || 0;
  if (prevLap < 1 || !(newLap > prevLap)) return null;
  const t = +totalLaps || 0;
  return t > 0 ? `LAP ${newLap}/${t}!` : `LAP ${newLap}!`;
}
/** Thrown projectiles vs consumed boosts. */
function itemUseVerb(item) {
  return (item === 'banana' || item === 'green_shell' || item === 'red_shell' || item === 'blue_shell') ? 'THROWN!' : 'USED!';
}

// Brief overlay chip for overtake / lap / item feedback. It lives in its own slot
// below the HUD so it never fights the fullscreen countdown overlay.
let eventTimer = 0;
function flashEvent(text, kind) {
  const chip = $('event-chip');
  if (!chip) return;
  chip.textContent = text;
  chip.className = 'show' + (kind ? ' ' + kind : '');
  chip.hidden = false;
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => { chip.className = ''; chip.hidden = true; }, 1200);
}

/** One-time, non-blocking low-battery note in the race HUD area. */
function maybeBattWarn() {
  if (state.lowBattWarned || state.battery == null) return;
  if (state.battery <= 15) {
    state.lowBattWarned = true;
    const w = $('batt-warn');
    if (w) w.hidden = false;
  }
}

/** Rocket-start hint: visible only during countdown/prerace; GAS pulses with it. */
function updateRocketHint() {
  const show = state.flow === 'countdown' || state.flow === 'prerace';
  const h = $('rocket-hint');
  if (h) h.hidden = !show;
  const gas = $('ctl-gas');
  if (gas) gas.classList.toggle('rocket', !!show);
}

/** Wrong-way banner: driven ONLY by the fresh standings row (wrong===true). */
let wrongWayOn = false;
function updateWrongWay(on) {
  const show = on === true;
  if (show && !wrongWayOn) {
    buzz([0, 120, 60, 120, 60, 200]);
    beep(220, 0.2, 'sawtooth', 0.06);
  }
  wrongWayOn = show;
  const b = $('wrongway-banner');
  if (b) b.hidden = !show;
}

/** Race context lines: "RACE x OF y" in lobby + results; hidden if either is unknown. */
function updateRaceLines() {
  const ri = state.raceIndex, tr = state.totalRaces;
  const ok = (typeof ri === 'number' && Number.isFinite(ri) && ri >= 0)
    && (typeof tr === 'number' && Number.isFinite(tr) && tr > 0);
  const txt = ok ? `RACE ${ri + 1} OF ${tr}` : '';
  const l1 = $('lobby-race-line');
  if (l1) { l1.textContent = txt; l1.hidden = !ok; }
  const l2 = $('end-race-line');
  if (l2) { l2.textContent = txt; l2.hidden = !ok; }
}

/** ITEM button mirrors what you're holding (the host tells us each 500 ms). */
function setItemHeld(item) {
  if (item === state.itemHeld) { syncItemHint(); return; }
  const had = state.itemHeld;
  state.itemHeld = item;
  const el = $('ctl-item');
  el.classList.toggle('has-item', !!item);
  el.textContent = item ? `ITEM: ${itemLabel(item)}` : 'ITEM';
  syncItemHint();
  if (item && !had) { buzz([0, 40, 40, 60]); beep(880, 0.09); setTimeout(() => beep(1174, 0.12), 90); }
}
/** Tiny "TAP TO USE ▲" caption under ITEM, visible only while an item is held. */
function syncItemHint() {
  const h = $('item-use-hint');
  if (h) h.hidden = !state.itemHeld;
}
function itemLabel(id) {
  return ({ mushroom: '🍄', triple_mushroom: '🍄×3', banana: '🍌', green_shell: '🟢', red_shell: '🔴', star: '⭐', lightning: '⚡', blue_shell: '🔵' })[id] || '●';
}

/** Tiny procedural beeper (countdown ticks, item pickup). Unlocked on first tap. */
let actx = null;
function hapticsOn() { try { return localStorage.getItem('tkr-haptics') !== '0'; } catch { return true; } }
function soundOn() { try { return localStorage.getItem('tkr-sound') !== '0'; } catch { return true; } }
function beep(freq = 660, dur = 0.1, type = 'square', vol = 0.06) {
  if (!soundOn()) return;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch {}
}
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, function unlock() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {}
}, { once: false, passive: true }));

/** Finish jingle on entering results/leaderboard (never overlaps countdown/GO:
 *  different flow entirely). Gated behind the sound toggle via beep().
 *  1st: rising champion arpeggio (4 notes); top-3: pleasant two-note;
 *  else: single neutral blip. Deduped per race+place so a `results`
 *  message arriving right after the flow change doesn't double-play. */
function playFinishJingle(place) {
  try {
    if (!soundOn()) return false;
    const p = +place || 0;
    const key = `${(typeof state.raceIndex === 'number') ? state.raceIndex : '?'}:${p}`;
    if (state.finishJingleKey === key) return false;
    state.finishJingleKey = key;
    if (p === 1) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => setTimeout(() => beep(f, 0.14), i * 130));
    } else if (p === 2 || p === 3) {
      beep(659.25, 0.12);
      setTimeout(() => beep(880, 0.16), 140);
    } else {
      beep(440, 0.12);
    }
    return true;
  } catch { return false; }
}

// ping + stats reporting
setInterval(() => send({ type: 'ping', c: performance.now() }), 1000);
setInterval(() => {
  const s = log.snapshot();
  send({ type: 'clientStats', rtt: s.p50, p95: s.p95, jitter: s.jitter, battery: state.battery, offset: clock.offset });
}, 2000);
// battery
if (navigator.getBattery) navigator.getBattery().then((b) => {
  const up = () => { state.battery = Math.round(b.level * 100); maybeBattWarn(); };
  up(); b.addEventListener('levelchange', up); b.addEventListener('chargingchange', up);
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
// Compact per-card stat bars for speed/accel/handling. Tolerant: a missing or
// non-numeric stat hides that bar instead of crashing or rendering NaN.
function statNum(entry, key) {
  try {
    const s = entry && entry.stats;
    if (!s || typeof s !== 'object') return null;
    const raw = s[key];
    if (raw == null || raw === '') return null;
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    const v = +raw;
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.min(5, v));
  } catch { return null; }
}
function barRow(cls, label, val) {
  if (val == null) return '';
  const pct = Math.round((val / 5) * 100);
  return `<span class="bar ${cls}"><b>${label}</b><span class="track"><span class="fill" style="width:${pct}%"></span></span></span>`;
}
function cardBars(entry) {
  const parts = [
    barRow('spd', 'S', statNum(entry, 'speed')),
    barRow('acc', 'A', statNum(entry, 'accel')),
    barRow('han', 'H', statNum(entry, 'handling')),
  ].filter(Boolean).join('');
  return parts ? `<span class="bars">${parts}</span>` : '';
}
// One-line flavor tag derived purely client-side from the entry's best stat.
function charTag(entry) {
  const s = statNum(entry, 'speed'), a = statNum(entry, 'accel'), h = statNum(entry, 'handling');
  if (s == null && a == null && h == null) return 'ALL-ROUNDER';
  const vals = [s ?? -1, a ?? -1, h ?? -1];
  const mx = Math.max(...vals);
  const winners = vals.filter((v) => v === mx).length;
  if (winners !== 1) return 'ALL-ROUNDER';
  if (mx === s) return 'FASTEST ON STRAIGHTS';
  if (mx === h) return 'CORNER ARTIST';
  return 'QUICK OFF THE LINE';
}
function renderDetail() {
  try {
    const box = $('char-detail');
    if (!box) return;
    const entry = CHARACTERS[state.charIdx] || CHARACTERS[0];
    const dot = $('char-detail-dot'), nm = $('char-detail-name'),
      tag = $('char-detail-tag'), bars = $('char-detail-bars');
    if (dot) {
      try { dot.style.background = hex(entry.color); } catch {}
    }
    // Team-color ring: same source as the lobby chip (state.color from server).
    try { box.style.borderColor = state.color || '#2a3050'; } catch {}
    if (nm) nm.textContent = entry.name || `Racer ${state.charIdx + 1}`;
    if (tag) tag.textContent = charTag(entry);
    if (bars) {
      const html = [
        barRow('spd', 'S', statNum(entry, 'speed')),
        barRow('acc', 'A', statNum(entry, 'accel')),
        barRow('han', 'H', statNum(entry, 'handling')),
      ].filter(Boolean).join('');
      bars.innerHTML = html;
    }
  } catch {}
}
charGrid.innerHTML = CHARACTERS.map((c, i) => `<button class="char" data-i="${i}"><span class="dot" style="background:${hex(c.color)}"></span><span class="cname">${c.name}</span>${cardBars(c)}</button>`).join('');
renderDetail();
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
  renderDetail();
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

// Optimistic ITEM feedback: the tap feels instant (host standings confirm it).
// Held item => flash the verb + clear the pad at once; empty pad => dull buzz + shake.
$('ctl-item').addEventListener('pointerdown', () => {
  if (state.flow !== 'racing' && state.flow !== 'countdown') return;
  const held = state.itemHeld;
  if (held) {
    state.itemJustUsed = held; state.itemUsedAt = Date.now();
    setItemHeld(null);
    flashEvent(itemUseVerb(held), 'item');
    buzz(40); beep(740, 0.08);
  } else {
    flashEvent('NO ITEM', 'none');
    buzz(70);
    const el = $('ctl-item');
    if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 350); }
  }
});

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

function buzz(ms) { try { if (!hapticsOn()) return; navigator.vibrate && navigator.vibrate(ms); } catch {} }
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

// ---------------- first-time onboarding + preferences (lobby, in-flow) ----------------
function applyHand() {
  let hand = 'right';
  try { hand = localStorage.getItem('tkr-hand') || 'right'; } catch {}
  if (hand !== 'left') hand = 'right';
  const pad = document.querySelector('.pad');
  if (pad) pad.classList.toggle('lefty', hand === 'left');
  const l = $('hand-left'), r = $('hand-right');
  if (l && r) {
    l.classList.toggle('sel', hand === 'left');
    r.classList.toggle('sel', hand === 'right');
    l.setAttribute('aria-pressed', hand === 'left' ? 'true' : 'false');
    r.setAttribute('aria-pressed', hand === 'right' ? 'true' : 'false');
  }
  return hand;
}
function applyPrefToggles() {
  const h = $('haptics-toggle'), s = $('sound-toggle');
  const hon = hapticsOn(), son = soundOn();
  if (h) { h.setAttribute('aria-pressed', hon ? 'true' : 'false'); h.textContent = hon ? 'HAPTICS ON' : 'HAPTICS OFF'; }
  if (s) { s.setAttribute('aria-pressed', son ? 'true' : 'false'); s.textContent = son ? 'SOUND ON' : 'SOUND OFF'; }
}
function applyHowto() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('tkr-howto') === '1'; } catch {}
  const full = $('howto-full'), reopen = $('howto-reopen');
  if (full && reopen) {
    full.hidden = dismissed;
    reopen.hidden = !dismissed;
  }
}
(function initPrefs() {
  applyHand(); applyPrefToggles(); applyHowto();
  const hl = $('hand-left'), hr = $('hand-right');
  if (hl) hl.addEventListener('click', (e) => { e.preventDefault(); try { localStorage.setItem('tkr-hand', 'left'); } catch {} applyHand(); buzz(10); });
  if (hr) hr.addEventListener('click', (e) => { e.preventDefault(); try { localStorage.setItem('tkr-hand', 'right'); } catch {} applyHand(); buzz(10); });
  const h = $('haptics-toggle'), s = $('sound-toggle');
  if (h) h.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.setItem('tkr-haptics', hapticsOn() ? '0' : '1'); } catch {}
    applyPrefToggles(); buzz(20);
  });
  if (s) s.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.setItem('tkr-sound', soundOn() ? '0' : '1'); } catch {}
    applyPrefToggles(); beep(660, 0.08);
  });
  const gotit = $('howto-gotit'), reopen = $('howto-reopen');
  if (gotit) gotit.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.setItem('tkr-howto', '1'); } catch {}
    applyHowto(); buzz(10);
  });
  if (reopen) reopen.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.removeItem('tkr-howto'); } catch {}
    applyHowto(); buzz(10);
  });
})();

// Light-verification hook: lets a single test page dispatch synthetic inbound
// messages and call the pure helpers without touching the network.
window.__tkr = { state, onMessage, ordinal, overtakeDir, lapFlashText, itemUseVerb, flashEvent, renderEnd, renderBoard, playFinishJingle, setItemHeld, maybeBattWarn, buzz, beep, hapticsOn, soundOn, applyHand, applyHowto, applyPrefToggles, onFlowChange, updateRocketHint, updateWrongWay, updateRaceLines, syncItemHint, renderChars, renderDetail, charTag, statNum };
