// Turbo Kart Rally local event server: static hosting, controller/host WebSockets,
// room + session authority, reconnect tokens, diagnostics, fault injection.
//
// Multi-room (per-household isolation): every WebSocket is bound to exactly one
// room via hostHello/join/diagHello {room}. All later messages route via
// ws._roomId so no room field is needed elsewhere. Old clients that send no
// room info land in the shared default room 'PLAY' (today's global behavior).
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
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

// ---------------------------------------------------------------- rooms: identity
// 4 chars from ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no 0/O/1/I/L), case-insensitive.
// 'PLAY' is the legacy default room (grandfathered even though L is otherwise excluded).
const DEFAULT_ROOM = 'PLAY';
const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{4}$/i;
const MAX_ROOMS = 50;          // beyond this, evict oldest fully-empty room
const MAX_PERSIST_ROOMS = 20;  // session-state.json cap
function normalizeRoomCode(raw) {
  try {
    if (typeof raw !== 'string') return DEFAULT_ROOM;
    const up = raw.trim().toUpperCase();
    if (!up) return DEFAULT_ROOM;
    if (up === DEFAULT_ROOM) return DEFAULT_ROOM;
    if (ROOM_RE.test(up)) return up;
    return DEFAULT_ROOM;
  } catch { return DEFAULT_ROOM; }
}

// ---------------------------------------------------------------- utils
// The QR code is only as good as the address it encodes. Windows laptops routinely carry
// virtual adapters (WSL, Hyper-V, VirtualBox, VMware, Docker, VPNs) whose addresses phones
// can never reach, and os.networkInterfaces() order is arbitrary, so "the first IPv4" is a
// coin toss. Order: TKR_LAN_IP override > the interface that owns the default route (what
// the OS itself would use) > physical-looking adapters > everything else.
const LAN_IP_OVERRIDE = (() => {
  const i = process.argv.indexOf('--lan-ip');
  const v = (i > -1 && process.argv[i + 1]) || process.env.TKR_LAN_IP || '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : null;
})();
const VIRTUAL_IFACE = /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|vmnet|docker|br-|veth|tailscale|zerotier|wireguard|wg\d|tun|tap|utun|npcap|loopback|bluetooth|teredo|isatap/i;
const PHYSICAL_IFACE = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i;
let routeIp = null; // address of the default-route interface, refreshed in the background
function refreshRouteIp() {
  // UDP connect() sends no packet; it only asks the OS which local address would route out.
  try {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch {} });
    s.connect(53, '1.1.1.1', () => {
      try { const a = s.address().address; if (a && a !== '0.0.0.0' && !a.startsWith('127.')) routeIp = a; } catch {}
      try { s.close(); } catch {}
    });
  } catch {}
}
refreshRouteIp();
setInterval(refreshRouteIp, 15000).unref();
function lanIps() {
  const out = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  const score = (e) => {
    if (e.address === LAN_IP_OVERRIDE) return -100;
    if (e.address === routeIp) return -50;
    let s = 0;
    if (VIRTUAL_IFACE.test(e.name)) s += 40;
    if (PHYSICAL_IFACE.test(e.name)) s -= 10;
    if (/^169\.254\./.test(e.address)) s += 60; // link-local: no DHCP, nobody can reach it
    if (/^192\.168\./.test(e.address)) s -= 3; else if (/^10\./.test(e.address)) s -= 2; else if (/^172\./.test(e.address)) s -= 1;
    return s;
  };
  const ips = out.sort((a, b) => score(a) - score(b)).map((e) => e.address);
  if (LAN_IP_OVERRIDE && !ips.includes(LAN_IP_OVERRIDE)) ips.unshift(LAN_IP_OVERRIDE);
  return [...new Set(ips)];
}
function isPrivateIpv4(h) {
  return /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
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
function wsLive(ws) { try { return !!ws && ws.readyState === 1; } catch { return false; } }

// ---------------------------------------------------------------- session state (per-room)
const defaultSession = () => ({
  flow: 'lobby',            // lobby | select | settings | prerace | racing | results | leaderboard
  settings: { laps: 3, difficulty: 'normal', items: true, aiFill: 0, raceSpeed: 'normal', cameraMode: 'split', allowDupes: false },
  pointsTable: [10, 8, 6, 4, 2, 1],
  raceIndex: 0,
  scores: [],               // [{teamId, name, characterId, total, wins, podiums, previous}]
  raceHistory: [],
});
function loadPersistedByRoom() {
  const out = {};
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const okFlow = (v) => v && v.flow && ['lobby', 'settings', 'leaderboard'].includes(v.flow);
    if (s && typeof s === 'object' && s.rooms && typeof s.rooms === 'object') {
      for (const [k, v] of Object.entries(s.rooms)) {
        try {
          if (!okFlow(v)) continue;
          out[normalizeRoomCode(k)] = { ...defaultSession(), ...v };
        } catch {}
      }
    } else if (okFlow(s)) {
      // Migrate old bare-session files under the default room code.
      out[DEFAULT_ROOM] = { ...defaultSession(), ...s };
    }
  } catch {}
  return out;
}
const persistedByRoom = loadPersistedByRoom();
function persist() {
  try {
    const entries = [...rooms.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
    const obj = {};
    for (const [code, r] of entries.slice(0, MAX_PERSIST_ROOMS)) obj[code] = r.session;
    fs.writeFileSync(sessionFile, JSON.stringify({ rooms: obj }, null, 1));
  } catch {}
}

// ---------------------------------------------------------------- rooms
let nextSession = 1;
const TEAM_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#ab47bc', '#ff7043'];
const rooms = new Map(); // code -> room
// Wildcard diagnostics: diagHello WITHOUT any room subscribes here and receives
// lobby snapshots for ALL rooms (documented diagnostics convenience). diagHello
// WITH a (valid) room subscribes only to that room's diagSockets. Invalid room
// on diagHello falls back to the default room (scoped, not wildcard).
const allDiagSockets = new Set();
function makeSlot(i) {
  return {
    id: i, name: `Team ${i}`, colorIdx: (i - 1) % TEAM_COLORS.length,
    characterIdx: i - 1, ready: false, connected: false, ws: null,
    sessionId: 0, reconnectToken: null, ping: 0, p95: 0, jitter: 0,
    battery: null, ai: false, lastSeen: 0, tapSeq: 0, name: `Team ${i}`,
  };
}
function makeRoom(code) {
  const teams = [];
  for (let i = 1; i <= MAX_SLOTS; i++) teams.push(makeSlot(i));
  const room = {
    code, createdAt: Date.now(),
    teams,
    session: defaultSession(),
    spectators: new Set(), // extra phones connected as lobby/spectator (this room only)
    diagSockets: new Set(), // room-scoped diagnostics
    hostWs: null,
    faults: new Map(),     // Map<teamId(1..6)|'*', {delayMs, jitterMs, pause, expiresAt?}>
    lastInputAt: new Map(),// teamId -> Date.now() ms of last relayed binary input
    relayLog: [],
  };
  const p = persistedByRoom[code];
  if (p) room.session = p;
  return room;
}
function getRoom(raw) {
  const code = normalizeRoomCode(raw);
  let r = rooms.get(code);
  if (!r) {
    r = makeRoom(code);
    rooms.set(code, r);
    enforceRoomCap();
  }
  return r;
}
// Resolve the room for any post-bind message: bound sockets ALWAYS win (ignore
// m.room to prevent cross-room injection). Unbound senders fall back to m.room
// (validated) or the default room — this keeps old codeless clients working.
function roomOf(ws, m) {
  try {
    if (ws && typeof ws._roomId === 'string' && ws._roomId) return getRoom(ws._roomId);
    if (m && m.room != null) return getRoom(m.room);
  } catch {}
  return getRoom(DEFAULT_ROOM);
}
function hasLiveSocket(room) {
  if (wsLive(room.hostWs)) return true;
  for (const t of room.teams) if (t.ws && wsLive(t.ws)) return true;
  for (const s of room.spectators) if (wsLive(s)) return true;
  for (const d of room.diagSockets) if (wsLive(d)) return true;
  return false;
}
function isRoomFullyEmpty(room) {
  if (hasLiveSocket(room)) return false;
  for (const t of room.teams) if (t.connected) return false;
  return true;
}
function enforceRoomCap() {
  if (rooms.size <= MAX_ROOMS) return;
  const oldest = [...rooms.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of oldest) {
    if (rooms.size <= MAX_ROOMS) break;
    // Never evict a room with a connected socket.
    if (isRoomFullyEmpty(r)) rooms.delete(r.code);
  }
}
function roomClients(room) {
  const out = [];
  if (room.hostWs) out.push(room.hostWs);
  for (const t of room.teams) if (t.ws) out.push(t.ws);
  for (const s of room.spectators) out.push(s);
  for (const d of room.diagSockets) out.push(d);
  for (const d of allDiagSockets) out.push(d);
  return out;
}
// Detach a socket from its previous room before it binds to a new one, so a
// hostHello/join with a new code can never disturb the old room's slot state
// beyond a clean disconnect + that old room's own scoped broadcast.
function switchCleanup(ws, newCode) {
  try {
    const oldCode = (typeof ws._roomId === 'string' && ws._roomId) ? ws._roomId : null;
    if (!oldCode || oldCode === newCode) return;
    const old = rooms.get(oldCode);
    if (!old) return;
    if (old.hostWs === ws) {
      old.hostWs = null;
      if (!['lobby', 'leaderboard'].includes(old.session.flow)) { old.session.flow = 'lobby'; persist(); }
    }
    for (const t of old.teams) {
      if (t.ws === ws) {
        t.ws = null; t.connected = false; t.ready = false;
        if (!t.ai) t.reconnectDeadline = Date.now() + 15000;
      }
    }
    old.spectators.delete(ws);
    old.diagSockets.delete(ws);
    try { broadcastLobby(old); } catch {}
  } catch {}
}

function faultFor(buf, room) {
  const team = peekTeam(buf);
  for (const key of [team, '*']) {
    const f = room.faults.get(key);
    if (!f) continue;
    if (f.expiresAt && Date.now() > f.expiresAt) { room.faults.delete(key); continue; }
    return f;
  }
  return null;
}
// Sweeper clears expired durationMs faults; no new message types — just clear.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const [key, f] of room.faults) {
      if (f && f.expiresAt && now > f.expiresAt) room.faults.delete(key);
    }
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
/** Addresses phones should actually use — the LAN IP, never localhost.
 * When the host page itself arrives via a public origin (Render/cloud deploy),
 * the QR must encode that public origin (https, no internal port), because the
 * server's LAN interfaces are meaningless to phones on other networks. */
function isPublicHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '[::1]' || h === '::1') return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/\.local$|\.lan$|\.home$|\.internal$/.test(h)) return false;
  return true;
}
function netInfo(hostHeader) {
  let ips = lanIps();
  if (isPublicHost(hostHeader)) {
    const host = String(hostHeader).split(':')[0];
    return { port: activePort, ips, public: true, controllerUrl: `https://${host}/controller` };
  }
  // The operator opened the big screen on a LAN address: that exact address is the one
  // they chose (and it demonstrably reaches this server), so the QR leads with it.
  const hh = String(hostHeader || '').split(':')[0];
  if (!LAN_IP_OVERRIDE && isPrivateIpv4(hh)) ips = [hh, ...ips.filter((ip) => ip !== hh)];
  return { port: activePort, ips, public: false, controllerUrl: ips.length ? `http://${ips[0]}:${activePort}/controller` : null };
}
/** Rooms whose big screen is connected right now (LAN room discovery for code-less phones). */
function liveHostRooms() {
  const out = [];
  for (const room of rooms.values()) if (wsLive(room.hostWs)) out.push(room);
  return out;
}
/**
 * The room a code-less phone should join: the only open big screen, or, if a stale tab is
 * also open (mid-race, results, leaderboard), the only one sitting in its lobby/settings,
 * i.e. the one people are walking up to; among several, the most recently opened.
 */
function pickJoinRoom(live) {
  if (live.length <= 1) return live[0] || null;
  const accepting = live.filter((r) => r.session.flow === 'lobby' || r.session.flow === 'settings');
  const pool = accepting.length ? accepting : live;
  // tie-break: the most recently opened big screen (a forgotten tab is older)
  return pool.slice().sort((a, b) => (b.hostSince || 0) - (a.hostSince || 0))[0];
}
function spectatorCount(room) { let n = 0; for (const s of room.spectators) { try { if (s && s.readyState === 1) n++; } catch {} } return n; }
function lobbyState(room) {
  return { teams: room.teams.map(publicTeam), flow: room.session.flow, pointsTable: room.session.pointsTable, raceIndex: room.session.raceIndex, laps: room.session.settings.laps ?? 3, totalRaces: room.session.settings.raceCount || 3, spectatorCount: spectatorCount(room), hostOnline: wsLive(room.hostWs) };
}
function hostLobbyState(room) {
  const now = Date.now();
  return { teams: room.teams.map((t) => ({ ...publicTeam(t), lastInputAgeMs: room.lastInputAt.has(t.id) ? now - room.lastInputAt.get(t.id) : null })), flow: room.session.flow, pointsTable: room.session.pointsTable, raceIndex: room.session.raceIndex, laps: room.session.settings.laps ?? 3, totalRaces: room.session.settings.raceCount || 3, spectatorCount: spectatorCount(room), hostOnline: wsLive(room.hostWs) };
}
function broadcastLobby(roomOrCode) {
  const room = (roomOrCode && roomOrCode.code && roomOrCode.teams) ? roomOrCode : getRoom(roomOrCode && roomOrCode.code ? roomOrCode.code : roomOrCode);
  const state = { type: 'lobby', room: room.code, state: lobbyState(room) };
  for (const c of roomClients(room)) send(c, state);
  send(room.hostWs, { type: 'session', room: room.code, state: room.session });
}
function relayBinary(buf, from) {
  const room = roomOf(from, null);
  const f = faultFor(buf, room);
  if (f && f.pause) return; // simulate a stalled phone
  const delay = f ? f.delayMs + Math.random() * (f.jitterMs || 0) : 0;
  const go = () => {
    if (room.hostWs && room.hostWs.readyState === 1) sendBinary(room.hostWs, buf);
    room.relayLog.push({ team: peekTeam(buf), seq: peekSeq(buf), srvIn: perfNow() });
    const tid = peekTeam(buf);
    if (tid >= 1 && tid <= MAX_SLOTS) room.lastInputAt.set(tid, Date.now());
  };
  if (delay > 0) setTimeout(go, delay); else go();
}
function peekTeam(buf) { try { return new DataView(buf.buffer, buf.byteOffset).getUint16(2, true); } catch { return 0; } }
function peekSeq(buf) { try { return new DataView(buf.buffer, buf.byteOffset).getUint32(8, true); } catch { return 0; } }
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.relayLog.length && room.hostWs && room.hostWs.readyState === 1) {
      send(room.hostWs, { type: 'relayLog', room: room.code, rows: room.relayLog.splice(0, room.relayLog.length) });
    } else room.relayLog.length = 0;
  }
}, 500);

// Authoritative lobby heartbeat: the host page always converges on server truth even if a
// broadcast is missed (tab throttling, a reconnect race, or a dropped frame).
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.hostWs && room.hostWs.readyState === 1) {
      send(room.hostWs, { type: 'lobby', room: room.code, state: hostLobbyState(room) });
    }
  }
}, 1000);

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const qIdx = req.url.indexOf('?');
  const pathPart = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
  const queryPart = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';
  const u = decodeURIComponent(pathPart);
  let file;
  if (u === '/' ) file = 'index.html';
  else if (u === '/healthz') {
    const room = getRoom(DEFAULT_ROOM);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, flow: room.session.flow, teams: room.teams.filter((t) => t.connected).length }));
    return;
  }
  else if (u === '/debug/slots') {
    let roomParam = null;
    try { roomParam = new URLSearchParams(queryPart).get('room'); } catch {}
    const room = getRoom(roomParam);
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ room: room.code, flow: room.session.flow, raceIndex: room.session.raceIndex, scores: room.session.scores, slots: room.teams.map((t) => ({ id: t.id, name: t.name, connected: t.connected, sessionId: t.sessionId, token: t.reconnectToken, ai: t.ai })) }));
    return;
  }
  else if (u === '/api/rooms') {
    // LAN room discovery: a phone that arrived without ?room= (a bare /controller link, the
    // arcade hub's QR, a typed address) finds the big screen by itself. Disabled behind a
    // public hostname, where the room code is the household's only key.
    const isPublic = isPublicHost(req.headers.host);
    const live = isPublic ? [] : liveHostRooms().map((r) => ({ room: r.code, flow: r.session.flow, teams: r.teams.filter((t) => t.connected).length, since: r.hostSince || 0 }));
    const pick = isPublic ? null : pickJoinRoom(liveHostRooms());
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ discovery: !isPublic, rooms: live, pick: pick ? pick.code : null }));
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
  ws._roomId = null;
  ws._diagAll = false;
  try { ws._host = (req && req.headers && req.headers.host) || ''; } catch { ws._host = ''; }
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
    case 'diagHello': {
      const rawRoom = (m && m.room != null) ? m.room : null;
      const missing = rawRoom == null || (typeof rawRoom === 'string' && rawRoom.trim() === '');
      if (missing) {
        // Documented diagnostics convenience: no room => subscribe to ALL rooms.
        if (typeof ws._roomId === 'string' && ws._roomId) {
          const prev = rooms.get(ws._roomId);
          if (prev) prev.diagSockets.delete(ws);
        }
        ws._role = 'diag'; ws._diagAll = true; ws._roomId = null;
        allDiagSockets.add(ws);
        const def = getRoom(DEFAULT_ROOM);
        send(ws, { type: 'session', room: def.code, state: def.session, net: netInfo(ws._host) });
        // Current snapshot of every room so the diagnostics page has full state.
        for (const room of rooms.values()) send(ws, { type: 'lobby', room: room.code, state: lobbyState(room) });
      } else {
        const room = getRoom(rawRoom); // invalid => default room
        switchCleanup(ws, room.code);
        allDiagSockets.delete(ws);
        ws._role = 'diag'; ws._diagAll = false; ws._roomId = room.code;
        room.diagSockets.add(ws);
        send(ws, { type: 'session', room: room.code, state: room.session, net: netInfo(ws._host) });
        broadcastLobby(room);
      }
      break;
    }
    case 'hostHello': {
      const room = getRoom(m && m.room); // missing/invalid => default room
      switchCleanup(ws, room.code);
      allDiagSockets.delete(ws);
      room.diagSockets.delete(ws);
      ws._role = 'host'; ws._diagAll = false; ws._roomId = room.code;
      if (room.hostWs !== ws) room.hostSince = Date.now();
      room.hostWs = ws;
      send(ws, { type: 'session', room: room.code, state: room.session, net: netInfo(ws._host) });
      broadcastLobby(room);
      break;
    }
    case 'join': {
      // missing/invalid => default room, except that on a LAN a code-less phone goes to the
      // one room whose big screen is open (an old cached controller, a bare /controller link)
      let roomArg = m && m.room;
      const codeless = roomArg == null || (typeof roomArg === 'string' && roomArg.trim() === '');
      if (codeless && !isPublicHost(ws._host)) {
        const live = liveHostRooms();
        const pick = live.some((r) => r.code === DEFAULT_ROOM) ? null : pickJoinRoom(live);
        if (pick) roomArg = pick.code;
      }
      const room = getRoom(roomArg);
      switchCleanup(ws, room.code);
      allDiagSockets.delete(ws);
      room.diagSockets.delete(ws);
      ws._roomId = room.code; ws._diagAll = false;
      // phone wants a slot; may send reconnectToken to reclaim (in-room only)
      let t = null;
      if (m.token) t = room.teams.find((x) => x.reconnectToken === m.token) || null;
      if (!t) t = room.teams.find((x) => !x.connected) || null;
      if (!t) { room.spectators.add(ws); ws._role = 'spectator'; send(ws, { type: 'spectating', room: room.code }); broadcastLobby(room); return; }
      attach(ws, t, m, room);
      break;
    }
    case 'ping': send(ws, { type: 'pong', c: m.c, s: perfNow() }); break;
    case 'clientStats': {
      const room = roomOf(ws, m);
      const t = room.teams.find((x) => x.ws === ws);
      if (t) { t.ping = m.rtt || 0; t.p95 = m.p95 || 0; t.jitter = m.jitter || 0; t.battery = m.battery ?? t.battery; t.offset = typeof m.offset === 'number' ? m.offset : t.offset; broadcastLobby(room); }
      break;
    }
    case 'name': { const room = roomOf(ws, m); const t = room.teams.find((x) => x.ws === ws); if (t && typeof m.name === 'string') { t.name = m.name.slice(0, 16) || t.name; broadcastLobby(room); } break; }
    case 'select': { const room = roomOf(ws, m); const t = room.teams.find((x) => x.ws === ws); if (t && Number.isInteger(m.characterIdx)) {
      const taken = room.teams.some((x) => x !== t && x.connected && x.characterIdx === m.characterIdx);
      if (taken && !room.session.settings.allowDupes) { send(ws, { type: 'selectDenied', characterIdx: m.characterIdx }); break; }
      t.characterIdx = m.characterIdx; broadcastLobby(room); } break; }
    case 'ready': { const room = roomOf(ws, m); const t = room.teams.find((x) => x.ws === ws); if (t) { t.ready = !!m.ready; broadcastLobby(room); } break; }
    case 'battery': { const room = roomOf(ws, m); const t = room.teams.find((x) => x.ws === ws); if (t) { t.battery = m.level ?? t.battery; broadcastLobby(room); } break; }
    case 'hostAction': hostAction(m.action, m, roomOf(ws, m)); break;
    case 'hostSettings': { const room = roomOf(ws, m); room.session.settings = { ...room.session.settings, ...m.settings }; persist(); pushSession(room); broadcastLobby(room); break; }
    case 'hostFlow': { const room = roomOf(ws, m); room.session.flow = m.flow; persist(); pushSession(room); broadcastLobby(room); break; }
    case 'hostPoints': { const room = roomOf(ws, m); room.session.pointsTable = m.pointsTable || room.session.pointsTable; persist(); pushSession(room); broadcastLobby(room); break; }
    case 'hostStandings': {
      const room = roomOf(ws, m);
      for (const t of room.teams) if (t.ws) send(t.ws, { type: 'standings', rows: m.rows });
      break;
    }
    case 'hostCountdown': {
      const room = roomOf(ws, m);
      const n = m.n;
      for (const t of room.teams) if (t.ws) send(t.ws, { type: 'countdown', n });
      break;
    }
    case 'hostApplyResults': applyResults(m.results, roomOf(ws, m)); break;
    case 'hostResetSession': { const room = roomOf(ws, m); room.session = defaultSession(); persist(); pushSession(room); broadcastLobby(room); break; }
    case 'hostResetSlots': resetSlots(roomOf(ws, m)); break;
    case 'hostRemove': removeTeam(m.teamId, roomOf(ws, m)); break;
    case 'hostForceReady': { const room = roomOf(ws, m); const t = room.teams[m.teamId - 1]; if (t) { t.ready = true; broadcastLobby(room); } break; }
    case 'hostReplaceAI': { const room = roomOf(ws, m); const t = room.teams[m.teamId - 1]; if (t) { t.ai = true; t.ready = true; broadcastLobby(room); } break; }
    case 'fault': setFault(m.teamId, m.fault, roomOf(ws, m)); break;
    case 'resume': resumeTeam(m.teamId, roomOf(ws, m)); break;
  }
  } catch (err) {
    log(`handleJson error type=${m && m.type}: ${err && err.message}`);
  }
}

function attach(ws, t, m, room) {
  m = m || {};
  const isReclaim = !!(m.token && t.reconnectToken === m.token);
  if (t.ws && t.ws !== ws && wsLive(t.ws)) { try { t.ws._role = 'spectator'; room.spectators.add(t.ws); t.ws.send(JSON.stringify({type:'spectating', room: room.code})); } catch {} }
  t.ws = ws; ws._role = 'client'; ws._teamId = t.id;
  t.connected = true; t.sessionId = nextSession++; t.reconnectToken = m.token || Math.random().toString(36).slice(2, 10);
  t.ai = false; t.lastSeen = Date.now(); t.ready = false;
  // Token reclaim keeps its original name (no rename on the reclaim path).
  if (!isReclaim && typeof m.name === 'string' && m.name.trim()) {
    let desired = m.name.trim().slice(0, 16);
    const collides = room.teams.some((x) => x !== t && x.connected && typeof x.name === 'string' && x.name.toLowerCase() === desired.toLowerCase());
    if (collides) desired = (desired.slice(0, 13) + '(2)').slice(0, 16);
    if (desired) t.name = desired;
  }
  send(ws, { type: 'joined', room: room.code, teamId: t.id, sessionId: t.sessionId, token: t.reconnectToken, color: TEAM_COLORS[t.colorIdx % TEAM_COLORS.length], flow: room.session.flow });
  broadcastLobby(room);
}

/** Between-events fresh start WITHOUT dropping connected phones.
 * GUARD (six-player-party-racer): ignored while session.flow is racing/countdown/prerace —
 * a mid-race slot wipe would corrupt a live race (names/characterIdx/reconnect
 * tokens cleared mid-race would desync the host + phones). Log-and-ignore; lobby,
 * select, settings, results, leaderboard flows may still reset. ('countdown' is not
 * a current flow value but is guarded in case the host ever sets it.) */
function resetSlots(room) {
  if (['racing', 'countdown', 'prerace'].includes(room.session.flow)) {
    log(`resetSlots ignored during flow=${room.session.flow} room=${room.code}`);
    return;
  }
  for (const t of room.teams) {
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
  broadcastLobby(room);
}

function removeTeam(teamId, room) {
  const t = room.teams[teamId - 1];
  if (!t) return;
  if (t.ws) {
    const ws = t.ws;
    t.ws = null;
    // tell the phone it was removed so it does not silently grab the slot again
    try { ws.send(JSON.stringify({ type: 'removed' })); } catch {}
    setTimeout(() => { try { ws.close(); } catch {} }, 120);
  }
  t.connected = false; t.ready = false; t.name = `Team ${t.id}`; t.ai = false; t.reconnectToken = null;
  broadcastLobby(room);
}
function resumeTeam(teamId, room) { const t = room.teams[teamId - 1]; if (t) { t.ai = false; broadcastLobby(room); } }
function setFault(teamId, f, room) {
  const key = teamId === '*' || teamId == null ? '*' : Number(teamId);
  if (!f) { room.faults.delete(key); return; }
  const rec = { delayMs: f.delayMs || 0, jitterMs: f.jitterMs || 0, pause: !!f.pause };
  if (typeof f.durationMs === 'number' && f.durationMs > 0) rec.expiresAt = Date.now() + f.durationMs;
  room.faults.set(key, rec);
}
function onClose(ws) {
  allDiagSockets.delete(ws);
  const code = (typeof ws._roomId === 'string' && ws._roomId) ? ws._roomId : null;
  const room = code ? rooms.get(code) : null;
  if (!room) return; // wildcard diag or pre-bind socket: nothing room-scoped to clean
  log(`close role=${ws._role} team=${ws._teamId || '-'} room=${room.code} connected=${room.teams.filter((t) => t.connected).length}`);
  room.diagSockets.delete(ws);
  if (ws._role === 'host' && ws === room.hostWs) {
    room.hostWs = null;
    // the host page is the only thing that can drive the event flow; without it we return
    // to the lobby so phones land on the join/ready screen instead of a stale race view
    if (!['lobby', 'leaderboard'].includes(room.session.flow)) { room.session.flow = 'lobby'; persist(); }
    broadcastLobby(room);
  }
  if (ws._role === 'client' && ws._teamId) {
    const t = room.teams[ws._teamId - 1];
    if (t && t.ws === ws) { t.connected = false; t.ready = false; if (!t.ai) t.reconnectDeadline = Date.now() + 15000; broadcastLobby(room); }
  }
  room.spectators.delete(ws);
}

function hostAction(action, m, room) {
  if (action === 'startRace') { room.session.flow = 'racing'; persist(); pushSession(room); broadcastLobby(room); }
}
function pushSession(room) { send(room.hostWs, { type: 'session', room: room.code, state: room.session, net: room.hostWs ? netInfo(room.hostWs._host) : netInfo('') }); }
function applyResults(results, room) {
  // results: [{teamId, place}]
  // raceIndex semantics (six-player-party-racer): `finishedIndex` below is the
  // just-finished race's index, captured BEFORE the increment (== the
  // raceHistory entry's raceIndex). The broadcast `raceIndex` field carries this
  // pre-increment value so phones can match results to the race they just ran.
  const finishedIndex = room.session.raceIndex;
  const gained = {};
  for (const r of results) {
    const pts = room.session.pointsTable[r.place - 1] ?? 0;
    gained[r.teamId] = pts;
    let s = room.session.scores.find((x) => x.teamId === r.teamId);
    if (!s) { const t = room.teams[r.teamId - 1]; s = { teamId: r.teamId, name: t ? t.name : `Team ${r.teamId}`, characterId: t ? t.characterIdx : 0, total: 0, wins: 0, podiums: 0, previous: 0 }; room.session.scores.push(s); }
    s.previous = s.total;
    s.total += pts;
    if (r.place === 1) s.wins++;
    if (r.place <= 3) s.podiums++;
  }
  room.session.raceHistory.push({ raceIndex: room.session.raceIndex, results, gained });
  room.session.raceIndex++;
  room.session.flow = 'leaderboard';
  persist(); pushSession(room); broadcastLobby(room);
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
        const s = room.session.scores.find((x) => x.teamId === tid);
        const t = room.teams[tid - 1];
        const name = (s && s.name) || (t && t.name) || `Team ${tid}`;
        return { teamId: tid, place: r.place, name, points: gained[tid] ?? gained[r.teamId] ?? 0 };
      });
    const msg = { type: 'results', raceIndex: finishedIndex, rows };
    for (const t of room.teams) if (t.ws) send(t.ws, msg);
    for (const s of room.spectators) send(s, msg);
  } catch (err) { log(`results broadcast error: ${err && err.message}`); }
}

// keepalive + AI replacement timeout
setInterval(() => {
  for (const ws of wss.clients) {
    // a phone that walks out of range never sends 'close'; ping it so the socket dies promptly
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
    if (ws._lastAlive && Date.now() - ws._lastAlive > 20000) { try { ws.terminate(); } catch {} }
  }
  for (const room of rooms.values()) {
    let changed = false;
    for (const t of room.teams) {
      if (!t.connected && !t.ai && t.reconnectDeadline && Date.now() > t.reconnectDeadline) {
        t.ai = true; t.ready = true; t.reconnectDeadline = 0; changed = true;
      }
    }
    if (changed) broadcastLobby(room);
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
    // give the default-route probe a moment so the banner shows the address the QR will use
    setTimeout(() => {
      const ips = lanIps();
      console.log('');
      console.log('  Turbo Kart Rally — local event server');
      console.log('  --------------------------------------');
      console.log(`  BIG SCREEN:  http://localhost:${activePort}/?event   <- open this on the laptop (Chrome): the QR shows straight away, F11 for full screen`);
      if (ips.length) {
        console.log(`  PHONES:      http://${ips[0]}:${activePort}/controller   <- the QR code encodes this`);
        for (const ip of ips.slice(1)) console.log(`  (other):     http://${ip}:${activePort}/controller`);
      } else {
        console.log('  PHONES:      no network address found — connect the laptop to the Wi-Fi/hotspot, then restart');
      }
      console.log(`  Diagnostics: http://localhost:${activePort}/diagnostics`);
      if (LAN_IP_OVERRIDE) console.log(`  (QR address pinned by TKR_LAN_IP / --lan-ip = ${LAN_IP_OVERRIDE})`);
      console.log('');
    }, 150);
  });
}
listen(PORT, PORT_ATTEMPTS);
