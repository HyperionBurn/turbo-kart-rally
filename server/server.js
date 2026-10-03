// Turbo Kart Rally local event server: static hosting, controller/host WebSockets,
// room + session authority, reconnect tokens, diagnostics, fault injection.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 && process.argv[i + 1] ? +process.argv[i + 1] : null;
})();
const PORT = +(process.env.PORT || argPort || 8081);
const PORT_ATTEMPTS = +(process.env.PORT_ATTEMPTS || 12); // 8081..8092 before giving up
const MAX_SLOTS = 6;
const sessionFile = path.join(ROOT, 'server', 'session-state.json');

// ---------------------------------------------------------------- utils
function lanIps() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
function sendBinary(ws, buf) { try { ws.send(buf, { binary: true, compress: false }); } catch {} }

// ---------------------------------------------------------------- session state
const defaultSession = () => ({
  flow: 'lobby',            // lobby | select | settings | prerace | racing | results | leaderboard
  settings: { laps: 3, difficulty: 'normal', items: true, aiFill: 0, raceSpeed: 'normal', cameraMode: 'split', allowDupes: false },
  pointsTable: [10, 8, 6, 4, 2, 1],
  raceIndex: 0,
  scores: [],               // [{teamId, name, characterId, total, wins, podiums, previous}]
  raceHistory: [],
});
let session = defaultSession();
try {
  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  // Only a persisted lobby/settings/leaderboard survives a restart: an in-flight race or
  // results screen is meaningless without the host page that produced it.
  if (s && s.flow && ['lobby', 'settings', 'leaderboard'].includes(s.flow)) session = { ...defaultSession(), ...s };
} catch {}
function persist() { try { fs.writeFileSync(sessionFile, JSON.stringify(session, null, 1)); } catch {} }

// ---------------------------------------------------------------- rooms
let nextSession = 1;
const TEAM_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#ab47bc', '#ff7043'];
const teams = []; // slot objects
for (let i = 1; i <= MAX_SLOTS; i++) {
  teams.push({
    id: i, name: `Team ${i}`, colorIdx: (i - 1) % TEAM_COLORS.length,
    characterIdx: i - 1, ready: false, connected: false, ws: null,
    sessionId: 0, reconnectToken: null, ping: 0, p95: 0, jitter: 0,
    battery: null, ai: false, lastSeen: 0, tapSeq: 0, name: `Team ${i}`,
  });
}
const spectators = new Set(); // extra phones connected as lobby/spectator
const diagSockets = new Set();
let hostWs = null;

// Map<teamId(1..6)|'*', {delayMs, jitterMs, pausedUntil}>
const faults = new Map();
function faultFor(buf) {
  const team = peekTeam(buf);
  for (const key of [team, '*']) {
    const f = faults.get(key);
    if (!f) continue;
    if (f.expiresAt && Date.now() > f.expiresAt) { faults.delete(key); continue; }
    return f;
  }
  return null;
}
// Sweeper clears expired durationMs faults; no new message types — just clear.
setInterval(() => {
  const now = Date.now();
  for (const [key, f] of faults) {
    if (f && f.expiresAt && now > f.expiresAt) faults.delete(key);
  }
}, 250);

function publicTeam(t) {
  return {
    id: t.id, name: t.name, color: TEAM_COLORS[t.colorIdx % TEAM_COLORS.length],
    characterIdx: t.characterIdx, ready: t.ready, connected: t.connected,
    sessionId: t.sessionId, ping: Math.round(t.ping), p95: Math.round(t.p95),
    jitter: Math.round(t.jitter), battery: t.battery, ai: t.ai, offset: t.offset || 0,
  };
}
function broadcast(fn) { for (const c of allClients()) fn(c); }
function allClients() { const out = []; if (hostWs) out.push(hostWs); for (const t of teams) if (t.ws) out.push(t.ws); for (const s of spectators) out.push(s); for (const d of diagSockets) out.push(d); return out; }
/** Addresses phones should actually use — the LAN IP, never localhost. */
function netInfo() {
  const ips = lanIps();
  return { port: activePort, ips, controllerUrl: ips.length ? `http://${ips[0]}:${activePort}/controller` : null };
}
function spectatorCount() { let n = 0; for (const s of spectators) { try { if (s && s.readyState === 1) n++; } catch {} } return n; }
function lobbyState() {
  return { teams: teams.map(publicTeam), flow: session.flow, pointsTable: session.pointsTable, raceIndex: session.raceIndex, laps: session.settings.laps ?? 3, totalRaces: session.settings.raceCount || 3, spectatorCount: spectatorCount() };
}
function hostLobbyState() {
  const now = Date.now();
  return { teams: teams.map((t) => ({ ...publicTeam(t), lastInputAgeMs: lastInputAt.has(t.id) ? now - lastInputAt.get(t.id) : null })), flow: session.flow, pointsTable: session.pointsTable, raceIndex: session.raceIndex, laps: session.settings.laps ?? 3, totalRaces: session.settings.raceCount || 3, spectatorCount: spectatorCount() };
}
function broadcastLobby() {
  const state = { type: 'lobby', state: lobbyState() };
  for (const c of allClients()) send(c, state);
  send(hostWs, { type: 'session', state: session });
}
function relayBinary(buf, from) {
  const f = faultFor(buf);
  if (f && f.pause) return; // simulate a stalled phone
  const delay = f ? f.delayMs + Math.random() * (f.jitterMs || 0) : 0;
  const go = () => {
    if (hostWs && hostWs.readyState === 1) sendBinary(hostWs, buf);
    relayLog.push({ team: peekTeam(buf), seq: peekSeq(buf), srvIn: perfNow() });
    const tid = peekTeam(buf);
    if (tid >= 1 && tid <= MAX_SLOTS) lastInputAt.set(tid, Date.now());
  };
  if (delay > 0) setTimeout(go, delay); else go();
}
function peekTeam(buf) { try { return new DataView(buf.buffer, buf.byteOffset).getUint16(2, true); } catch { return 0; } }
function peekSeq(buf) { try { return new DataView(buf.buffer, buf.byteOffset).getUint32(8, true); } catch { return 0; } }
const relayLog = [];
// teamId (1..6) -> Date.now() ms of the last relayed binary input packet; missing = never.
const lastInputAt = new Map();
setInterval(() => {
  if (relayLog.length && hostWs && hostWs.readyState === 1) {
    send(hostWs, { type: 'relayLog', rows: relayLog.splice(0, relayLog.length) });
  } else relayLog.length = 0;
}, 500);

// Authoritative lobby heartbeat: the host page always converges on server truth even if a
// broadcast is missed (tab throttling, a reconnect race, or a dropped frame).
setInterval(() => {
  if (hostWs && hostWs.readyState === 1) {
    send(hostWs, { type: 'lobby', state: hostLobbyState() });
  }
}, 1000);

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (u === '/' ) file = 'index.html';
  else if (u === '/debug/slots') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ flow: session.flow, raceIndex: session.raceIndex, scores: session.scores, slots: teams.map((t) => ({ id: t.id, name: t.name, connected: t.connected, sessionId: t.sessionId, token: t.reconnectToken, ai: t.ai })) }));
    return;
  }
  else if (u === '/controller' || u === '/controller/') file = 'controller/index.html';
  else if (u === '/diagnostics') file = 'diagnostics/index.html';
  else file = u.slice(1);
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false, clientTracking: true });
wss.on('connection', (ws, req) => {
  ws._role = null;
  try { ws._socket.setNoDelay(true); } catch {}
  ws.on('message', (data, isBinary) => {
    if (isBinary) { relayBinary(data, ws); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    handleJson(ws, m);
  });
  ws.on('close', () => onClose(ws));
  ws.on('pong', () => { ws._lastAlive = Date.now(); });
});

function handleJson(ws, m) {
  try {
  switch (m && m.type) {
    case 'diagHello': ws._role = 'diag'; diagSockets.add(ws);
      send(ws, { type: 'session', state: session, net: netInfo() }); broadcastLobby(); break;
    case 'hostHello': {
      ws._role = 'host'; hostWs = ws;
      send(ws, { type: 'session', state: session, net: netInfo() });
      broadcastLobby();
      break;
    }
    case 'join': {
      // phone wants a slot; may send reconnectToken to reclaim
      let t = null;
      if (m.token) t = teams.find((x) => x.reconnectToken === m.token) || null;
      if (!t) t = teams.find((x) => !x.connected) || null;
      if (!t) { spectators.add(ws); ws._role = 'spectator'; send(ws, { type: 'spectating' }); broadcastLobby(); return; }
      attach(ws, t, m);
      break;
    }
    case 'ping': send(ws, { type: 'pong', c: m.c, s: perfNow() }); break;
    case 'clientStats': {
      const t = teams.find((x) => x.ws === ws);
      if (t) { t.ping = m.rtt || 0; t.p95 = m.p95 || 0; t.jitter = m.jitter || 0; t.battery = m.battery ?? t.battery; t.offset = typeof m.offset === 'number' ? m.offset : t.offset; broadcastLobby(); }
      break;
    }
    case 'name': { const t = teams.find((x) => x.ws === ws); if (t && typeof m.name === 'string') { t.name = m.name.slice(0, 16) || t.name; broadcastLobby(); } break; }
    case 'select': { const t = teams.find((x) => x.ws === ws); if (t && Number.isInteger(m.characterIdx)) {
      const taken = teams.some((x) => x !== t && x.connected && x.characterIdx === m.characterIdx);
      if (taken && !session.settings.allowDupes) { send(ws, { type: 'selectDenied', characterIdx: m.characterIdx }); break; }
      t.characterIdx = m.characterIdx; broadcastLobby(); } break; }
    case 'ready': { const t = teams.find((x) => x.ws === ws); if (t) { t.ready = !!m.ready; broadcastLobby(); } break; }
    case 'battery': { const t = teams.find((x) => x.ws === ws); if (t) { t.battery = m.level ?? t.battery; broadcastLobby(); } break; }
    case 'hostAction': hostAction(m.action, m); break;
    case 'hostSettings': session.settings = { ...session.settings, ...m.settings }; persist(); pushSession(); broadcastLobby(); break;
    case 'hostFlow': session.flow = m.flow; persist(); pushSession(); broadcastLobby(); break;
    case 'hostPoints': session.pointsTable = m.pointsTable || session.pointsTable; persist(); pushSession(); broadcastLobby(); break;
    case 'hostStandings': {
      for (const t of teams) if (t.ws) send(t.ws, { type: 'standings', rows: m.rows });
      break;
    }
    case 'hostCountdown': {
      const n = m.n;
      for (const t of teams) if (t.ws) send(t.ws, { type: 'countdown', n });
      break;
    }
    case 'hostApplyResults': applyResults(m.results); break;
    case 'hostResetSession': session = defaultSession(); persist(); pushSession(); broadcastLobby(); break;
    case 'hostResetSlots': resetSlots(); break;
    case 'hostRemove': removeTeam(m.teamId); break;
    case 'hostForceReady': { const t = teams[m.teamId - 1]; if (t) { t.ready = true; broadcastLobby(); } break; }
    case 'hostReplaceAI': { const t = teams[m.teamId - 1]; if (t) { t.ai = true; t.ready = true; broadcastLobby(); } break; }
    case 'fault': setFault(m.teamId, m.fault); break;
    case 'resume': resumeTeam(m.teamId); break;
  }
  } catch (err) {
    log(`handleJson error type=${m && m.type}: ${err && err.message}`);
  }
}

function attach(ws, t, m) {
  const isReclaim = !!(m.token && t.reconnectToken === m.token);
  if (t.ws && t.ws !== ws && t.ws.readyState === 1) { try { t.ws._role = 'spectator'; spectators.add(t.ws); t.ws.send(JSON.stringify({type:'spectating'})); } catch {} }
  t.ws = ws; ws._role = 'client'; ws._teamId = t.id;
  t.connected = true; t.sessionId = nextSession++; t.reconnectToken = m.token || Math.random().toString(36).slice(2, 10);
  t.ai = false; t.lastSeen = Date.now(); t.ready = false;
  // Token reclaim keeps its original name (no rename on the reclaim path).
  if (!isReclaim && typeof m.name === 'string' && m.name.trim()) {
    let desired = m.name.trim().slice(0, 16);
    const collides = teams.some((x) => x !== t && x.connected && typeof x.name === 'string' && x.name.toLowerCase() === desired.toLowerCase());
    if (collides) desired = (desired.slice(0, 13) + '(2)').slice(0, 16);
    if (desired) t.name = desired;
  }
  send(ws, { type: 'joined', teamId: t.id, sessionId: t.sessionId, token: t.reconnectToken, color: TEAM_COLORS[t.colorIdx % TEAM_COLORS.length], flow: session.flow });
  broadcastLobby();
}

/** Between-events fresh start WITHOUT dropping connected phones.
 * GUARD (six-player-party-racer): ignored while session.flow is racing/countdown/prerace —
 * a mid-race slot wipe would corrupt a live race (names/characterIdx/reconnect
 * tokens cleared mid-race would desync the host + phones). Log-and-ignore; lobby,
 * select, settings, results, leaderboard flows may still reset. ('countdown' is not
 * a current flow value but is guarded in case the host ever sets it.) */
function resetSlots() {
  if (['racing', 'countdown', 'prerace'].includes(session.flow)) {
    log(`resetSlots ignored during flow=${session.flow}`);
    return;
  }
  for (const t of teams) {
    if (!t.connected) {
      t.name = `Team ${t.id}`;
      t.characterIdx = t.id - 1;
      t.ready = false;
      t.ai = false;
      t.reconnectToken = null;
      t.reconnectDeadline = 0;
    } else {
      t.ready = false;
    }
  }
  broadcastLobby();
}

function removeTeam(teamId) {
  const t = teams[teamId - 1];
  if (!t) return;
  if (t.ws) {
    const ws = t.ws;
    t.ws = null;
    // tell the phone it was removed so it does not silently grab the slot again
    try { ws.send(JSON.stringify({ type: 'removed' })); } catch {}
    setTimeout(() => { try { ws.close(); } catch {} }, 120);
  }
  t.connected = false; t.ready = false; t.name = `Team ${t.id}`; t.ai = false; t.reconnectToken = null;
  broadcastLobby();
}
function resumeTeam(teamId) { const t = teams[teamId - 1]; if (t) { t.ai = false; broadcastLobby(); } }
function setFault(teamId, f) {
  const key = teamId === '*' || teamId == null ? '*' : Number(teamId);
  if (!f) { faults.delete(key); return; }
  const rec = { delayMs: f.delayMs || 0, jitterMs: f.jitterMs || 0, pause: !!f.pause };
  if (typeof f.durationMs === 'number' && f.durationMs > 0) rec.expiresAt = Date.now() + f.durationMs;
  faults.set(key, rec);
}
function onClose(ws) {
  log(`close role=${ws._role} team=${ws._teamId || '-'} connected=${teams.filter((t) => t.connected).length}`);
  if (ws._role === 'host' && ws === hostWs) {
    hostWs = null;
    // the host page is the only thing that can drive the event flow; without it we return
    // to the lobby so phones land on the join/ready screen instead of a stale race view
    if (!['lobby', 'leaderboard'].includes(session.flow)) { session.flow = 'lobby'; persist(); }
    broadcastLobby();
  }
  diagSockets.delete(ws);
  if (ws._role === 'client' && ws._teamId) {
    const t = teams[ws._teamId - 1];
    if (t && t.ws === ws) { t.connected = false; t.ready = false; if (!t.ai) t.reconnectDeadline = Date.now() + 15000; broadcastLobby(); }
  }
  spectators.delete(ws);
}

function hostAction(action) {
  if (action === 'startRace') { session.flow = 'racing'; persist(); pushSession(); broadcastLobby(); }
}
function pushSession() { send(hostWs, { type: 'session', state: session, net: netInfo() }); }
function applyResults(results) {
  // results: [{teamId, place}]
  // raceIndex semantics (six-player-party-racer): `finishedIndex` below is the
  // just-finished race's index, captured BEFORE the increment (== the
  // raceHistory entry's raceIndex). The broadcast `raceIndex` field carries this
  // pre-increment value so phones can match results to the race they just ran.
  const finishedIndex = session.raceIndex;
  const gained = {};
  for (const r of results) {
    const pts = session.pointsTable[r.place - 1] ?? 0;
    gained[r.teamId] = pts;
    let s = session.scores.find((x) => x.teamId === r.teamId);
    if (!s) { const t = teams[r.teamId - 1]; s = { teamId: r.teamId, name: t ? t.name : `Team ${r.teamId}`, characterId: t ? t.characterIdx : 0, total: 0, wins: 0, podiums: 0, previous: 0 }; session.scores.push(s); }
    s.previous = s.total;
    s.total += pts;
    if (r.place === 1) s.wins++;
    if (r.place <= 3) s.podiums++;
  }
  session.raceHistory.push({ raceIndex: session.raceIndex, results, gained });
  session.raceIndex++;
  session.flow = 'leaderboard';
  persist(); pushSession(); broadcastLobby();
  // Phone results broadcast (ADD-ONLY, six-player-party-racer): best-effort push of
  // {type:'results', raceIndex: finishedIndex, rows:[{teamId, place, name, points}]}
  // to every connected team socket + spectators. Rows are data (disconnected slots
  // still contribute rows); delivery is best-effort (only live sockets get it).
  // teamId<=0 filler rows are excluded. Host flow above is untouched.
  try {
    const rows = (Array.isArray(results) ? results : [])
      .filter((r) => r && Number(r.teamId) > 0)
      .map((r) => {
        const tid = Number(r.teamId);
        const s = session.scores.find((x) => x.teamId === tid);
        const t = teams[tid - 1];
        const name = (s && s.name) || (t && t.name) || `Team ${tid}`;
        return { teamId: tid, place: r.place, name, points: gained[tid] ?? gained[r.teamId] ?? 0 };
      });
    const msg = { type: 'results', raceIndex: finishedIndex, rows };
    for (const t of teams) if (t.ws) send(t.ws, msg);
    for (const s of spectators) send(s, msg);
  } catch (err) { log(`results broadcast error: ${err && err.message}`); }
}

// keepalive + AI replacement timeout
setInterval(() => {
  for (const ws of wss.clients) {
    // a phone that walks out of range never sends 'close'; ping it so the socket dies promptly
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
    if (ws._lastAlive && Date.now() - ws._lastAlive > 20000) { try { ws.terminate(); } catch {} }
  }
  for (const t of teams) {
    if (!t.connected && !t.ai && t.reconnectDeadline && Date.now() > t.reconnectDeadline) {
      t.ai = true; t.ready = true; t.reconnectDeadline = 0; broadcastLobby();
    }
  }
}, 5000);

function perfNow() { return Number(process.hrtime.bigint() / 1000000n); }
const LOG = process.env.TKR_LOG || null;
function log(msg) {
  if (!LOG) return;
  try { require('fs').appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

let activePort = PORT;
/** Bind, walking to the next free port if something else already owns this one. */
function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`  ! port ${port} is already in use — trying ${port + 1}`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`  x cannot bind port ${port}: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    activePort = server.address().port;
    const ips = lanIps();
    console.log('');
    console.log('  Turbo Kart Rally — local event server');
    console.log('  --------------------------------------');
    console.log(`  HOST:        http://localhost:${activePort}`);
    for (const ip of ips) console.log(`  LAN:         http://${ip}:${activePort}`);
    console.log(`  Controllers: http://<LAN-IP>:${activePort}/controller`);
    console.log(`  Diagnostics: http://localhost:${activePort}/diagnostics`);
    console.log('');
  });
}
listen(PORT, PORT_ATTEMPTS);
