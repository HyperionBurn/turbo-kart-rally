// Browser-side network client used by the HOST browser.
import { bus } from '../events.js';
import { ClockSync, LinkStats } from './latency.js';
import { decodeInput } from './protocol.js';

export class HostNetworkClient {
  constructor({ url } = {}) {
    this.url = url || defaultWsUrl();
    this.ws = null;
    this.connected = false;
    this.sessionId = 0;
    // teamId -> latest input state (edge flags latched until consumed)
    this.latest = new Map();
    this.latchedEdges = new Map(); // teamId -> {item, hop, pause}
    this.handshakeOk = false;
    this.stats = new LinkStats();
    this.teamStats = new Map();   // per-team link statistics (sequences are per client)
    this.clock = new ClockSync();
    this.lastLobby = null;
    this.hostNowOffset = 0; // server - host estimate for timestamp translation
    this.reconnectTimer = 0;
    this.receiveLog = []; // recent {team, seq, srvIn, hostIn} rows for the overlay
    this.queue = [];      // control messages sent before the socket opened
    this._pingT = new Map();
    this.closed = false;
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';
      const ws = this.ws;
      ws.onopen = () => {
        this.connected = true;
        ws.send(JSON.stringify({ type: 'hostHello' }));
        // flush anything queued while the socket was down
        const q = this.queue.splice(0);
        for (const obj of q) try { ws.send(JSON.stringify(obj)); } catch {}
        bus.emit('net:connected', {});
      };
      ws.onclose = () => {
        this.connected = false;
        bus.emit('net:disconnected', {});
        if (!this.closed) setTimeout(() => this.connect(), 1000);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onmessage = (e) => this._onMessage(e);
    } catch (err) {
      bus.emit('net:error', { error: err });
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    }
  }

  _onMessage(e) {
    if (typeof e.data === 'string') {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      this._onJson(m);
    } else {
      const now = performance.now();
      const msg = decodeInput(e.data);
      if (!msg) return;
      const ts = this._teamStats(msg.teamId);
      ts.addUpdate(msg.seq);
      const prev = this.latest.get(msg.teamId);
      if (prev && msg.sessionId !== prev.sessionId) {
        // a phone that reconnected starts a new session with a fresh sequence counter:
        // adopt the newer session (and reset our baseline) instead of dropping its input
        if (msg.sessionId < prev.sessionId) return;
        this.latest.delete(msg.teamId);
        this.latchedEdges.delete(msg.teamId);
        ts.outOfOrder = 0; ts.dropped = 0; ts.lastSeq = -1;
      }
      const team = this.latest.get(msg.teamId);
      if (team && msg.seq < team.seq) { ts.dropped++; return; }
      const edges = { item: false, hop: false, pause: false };
      const f = msg.flags;
      if (f & 4) edges.item = true;
      if (f & 8) edges.hop = true;
      if (f & 16) edges.pause = true;
      const lat = this.latchedEdges.get(msg.teamId);
      if (lat) { edges.item = edges.item || lat.item; edges.hop = edges.hop || lat.hop; edges.pause = edges.pause || lat.pause; }
      this.latchedEdges.set(msg.teamId, edges);
      this.latest.set(msg.teamId, {
        steer: msg.steer, throttle: msg.throttle, brake: msg.brake,
        drift: !!(f & 1), lookBack: !!(f & 2),
        seq: msg.seq, clientTimestamp: msg.timestamp, hostReceivedAt: now, sessionId: msg.sessionId,
        offsetApplied: null,
      });
      this.receiveLog.push({ team: msg.teamId, seq: msg.seq, hostIn: now });
      if (this.receiveLog.length > 64) this.receiveLog.shift();
      bus.emit('net:input', { teamId: msg.teamId, seq: msg.seq });
    }
  }

  /** Per-team statistics — sequence numbers are per client, so they must not be mixed. */
  _teamStats(teamId) {
    let s = this.teamStats.get(teamId);
    if (!s) { s = new LinkStats(); this.teamStats.set(teamId, s); }
    return s;
  }

  /** Aggregate view used by the overlay and the measurement harness. */
  aggregateStats() {
    const teams = [...this.teamStats.values()];
    if (!teams.length) return this.stats.snapshot();
    let rate = 0, dropped = 0, ooo = 0, p95 = 0, p50 = 0, rtt = 0, jitter = 0;
    for (const s of teams) {
      rate += s.rate; dropped += s.dropped; ooo += s.outOfOrder;
      p95 = Math.max(p95, s.p95); p50 = Math.max(p50, s.p50);
      rtt += s.currentRtt; jitter += s.jitter;
    }
    return {
      rtt: rtt / teams.length, p50, p95, p99: p95,
      jitter: jitter / teams.length, rate: Math.round(rate),
      outOfOrder: ooo, dropped, disconnects: 0, reconnects: 0, teams: teams.length,
    };
  }

  _onJson(m) {
    switch (m.type) {
      case 'lobby':
        this.lastLobby = m.state;
        for (const t of m.state.teams) {
          const cur = this.latest.get(t.id);
          // keep the last known input for a slot the server just dropped (the kart keeps
          // its state until the reconnect deadline hands the slot to AI)
          if (cur && t.sessionId === 0) continue;
          if (cur && cur.sessionId !== t.sessionId) this.latest.delete(t.id);
        }
        bus.emit('net:lobby', { state: m.state });
        break;
      case 'pong': {
        const now = performance.now();
        const tSend = this._pingT.get(m.c) ?? now;
        this._pingT.delete(m.c);
        const rtt = now - tSend;
        this.stats.addRtt(rtt);
        this.clock.addSample(tSend, now, m.s);
        this.hostNowOffset = this.clock.offset; // server - ... actually peer(host) - server
        break;
      }
      case 'relayLog':
        bus.emit('net:relayLog', m.rows);
        break;
      case 'session':
        bus.emit('net:session', { state: m.state });
        break;
      case 'settings':
        bus.emit('net:settings', m.state);
        break;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return; }
    if (this.queue.length < 200) this.queue.push(obj);
  }

  /** Apply the newest valid input for a team to a kart; consumes latched edges. */
  applyInput(teamId, kart) {
    const st = this.latest.get(teamId);
    if (!st) { kart.input = NEUTRAL_INPUT(); return null; }
    const edges = this.latchedEdges.get(teamId) || { item: false, hop: false, pause: false };
    kart.input = {
      throttle: st.throttle, brake: st.brake, steer: st.steer, drift: st.drift,
      lookBack: st.lookBack, item: edges.item,
    };
    if (edges.hop) bus.emit('net:hop', { teamId });
    if (edges.pause) bus.emit('net:pause', { teamId });
    edges.item = edges.hop = edges.pause = false;
    return st;
  }

  ping() {
    const t = performance.now();
    this._pingT.set(t, t);
    if (this._pingT.size > 32) this._pingT.delete(this._pingT.keys().next().value);
    this.send({ type: 'ping', c: t });
  }

  dispose() { this.closed = true; try { this.ws && this.ws.close(); } catch {} }
}

let _neutral = null;
function NEUTRAL_INPUT() {
  if (!_neutral) _neutral = { throttle: 0, brake: 0, steer: 0, drift: false, item: false, lookBack: false };
  return { ..._neutral };
}

function defaultWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
