// Load/stress harness: synthetic controllers against the local event server.
//   node scripts/stress.cjs --clients 6  --duration 30
//   node scripts/stress.cjs --clients 6  --duration 10 --frantic
//   node scripts/stress.cjs --clients 40 --duration 30
//   node scripts/stress.cjs --clients 2  --duration 5  --disconnect-at 3
const { WebSocket } = require('ws');
const http = require('http');
const debugJson = (path) => new Promise((res) => http.get(`http://${HOST}${path}`, (r) => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch { res(s); } }); }).on('error', () => res(null)));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a] = true;   // bare flag
  else { args[a] = next; i++; }
}
const CLIENTS = +(args.clients || 6);
const DURATION = +(args.duration || 30);
const FRANTIC = !!args.frantic;
const DISCONNECT_AT = args['disconnect-at'] ? +args['disconnect-at'] : null;
const HOST = args.host || '127.0.0.1:8081'; // the server's default port
const RATE = +(args.rate || 30);
// --as-host: the harness itself acts as the host page (no game page running)
// --client-only: a real host page is already connected, so only send controller traffic
const AS_HOST = !!args['as-host'] && !args['client-only'];
// --fault "delay:20,jitter:5" | "delay:100,jitter:20" | "pause:3" (applies to every team unless --team N)
const FAULT = args.fault && args.fault !== true ? args.fault : null;

function encodeInput({ teamId, sessionId, seq, timestamp, steer, throttle, brake, flags }) {
  const b = new Uint8Array(24); const v = new DataView(b.buffer);
  b[0] = 0x54; b[1] = 0x01;
  v.setUint16(2, teamId, true); v.setUint32(4, sessionId, true); v.setUint32(8, seq, true);
  v.setFloat64(12, timestamp, true);
  v.setInt8(20, Math.max(-127, Math.min(127, Math.round(steer * 127))));
  b[21] = Math.round(throttle * 255); b[22] = Math.round(brake * 255); b[23] = flags;
  return b;
}
const percentile = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

(async () => {
  // --as-host lets the harness drive the event flow itself (no game page needed):
  // it joins, sets the flow to racing, then keeps the room alive for the duration.
  let hostWs = null;
  if (AS_HOST) {
    hostWs = new WebSocket(`ws://${HOST}/ws`);
    await new Promise((r) => { hostWs.on('open', r); hostWs.on('error', r); });
    hostWs.send(JSON.stringify({ type: 'hostHello' }));
    await new Promise((r) => setTimeout(r, 300));
    hostWs.send(JSON.stringify({ type: 'hostFlow', flow: 'racing' }));
    await new Promise((r) => setTimeout(r, 300));
  }
  const clients = [];
  const rtts = [];
  let sent = 0, spectating = 0;
  const t0 = Date.now();
  for (let i = 0; i < CLIENTS; i++) {
    const ws = new WebSocket(`ws://${HOST}/ws`);
    const c = { ws, seq: 0, teamId: 0, sessionId: 0, sent: 0, pingSent: new Map(), pings: 0 };
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name: `Bot ${i + 1}` })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'joined') { c.teamId = m.teamId; c.sessionId = m.sessionId; }
      else if (m.type === 'spectating') { spectating++; c.teamId = 0; }
      else if (m.type === 'pong') {
        const s = c.pingSent.get(m.c); if (s != null) { rtts.push(Date.now() - s); c.pingSent.delete(m.c); }
      } else if (m.type === 'lobby' && m.state.flow === 'racing') { c.flow = 'racing'; }
      else if (m.type === 'lobby') { c.flow = m.state.flow; }
    });
    clients.push(c);
    await new Promise((r) => { if (ws.readyState === 1) return r(); ws.on('open', r); ws.on('error', r); });
  }

  // input + ping loops
  const timers = [];
  const tStart = Date.now();
  if (AS_HOST) { hostWs.send(JSON.stringify({ type: 'hostFlow', flow: 'racing' })); await new Promise((r) => setTimeout(r, 400)); }
  for (const c of clients) {
    let last = 0;
    const iv = setInterval(() => {
      if (c.ws.readyState !== 1) return;
      const now = Date.now();
      const t = now / 1000;
      let steer = 0, throttle = 1, brake = 0, flags = 0;
      if (FRANTIC) {
        steer = Math.sin(t * 9 + c.teamId);
        throttle = Math.random() < 0.5 ? 1 : 0;
        brake = Math.random() < 0.2 ? 1 : 0;
        if (Math.random() < 0.35) flags |= 4;   // item
        if (Math.random() < 0.3) flags |= 1;    // drift
      } else {
        steer = Math.sin(t * 0.7 + c.teamId) * 0.35;
        if (Math.random() < 0.02) flags |= 4;
        if (Math.random() < 0.05) flags |= 1;
      }
      if (c.flow !== 'racing' && c.flow !== 'countdown') return;
      if (c.teamId === 0) return;
      c.sent++; sent++;
      const pkt = encodeInput({ teamId: c.teamId, sessionId: c.sessionId, seq: c.seq++, timestamp: performance.now(), steer, throttle, brake, flags });
      c.ws.send(pkt, { binary: true, compress: false });
      c.sent++; sent++;
    }, 1000 / RATE);
    timers.push(iv);
  }
  // Test D: synthetic bad wifi applied by the server to the relay path
  let faultIv = null;
  if (FAULT && AS_HOST) {
    const spec = FAULT.split(':');
    const kind = spec[0];
    const amount = +(String(spec[1] ?? 20).split(',')[0]);
    const jitter = +(String(spec[2] ?? 0).split(',')[0]);
    const targets = args.team ? [+args.team] : [1, 2, 3, 4, 5, 6];
    for (const t of targets) {
      const fault = kind === 'pause' ? { pause: true } : { delayMs: amount, jitterMs: jitter };
      hostWs.send(JSON.stringify({ type: 'fault', teamId: t, fault }));
    }
    console.log(`fault injected on team(s) ${targets.join(',')}: ${kind}:${amount}${jitter ? ' jitter ' + jitter : ''}`);
    if (kind === 'pause') {
      faultIv = setTimeout(() => { for (const t of targets) hostWs.send(JSON.stringify({ type: 'fault', teamId: t, fault: null })); }, amount * 1000);
    }
  }

  // pings
  const pingIv = setInterval(() => {
    for (const c of clients) {
      if (c.ws.readyState !== 1) continue;
      const now = Date.now(); c.pingSent.set(now, now); c.pings++;
      c.ws.send(JSON.stringify({ type: 'ping', c: now }));
    }
  }, 250);
  // disconnect / reconnect drill
  let recIv = null;
  if (DISCONNECT_AT != null) {
    setTimeout(() => {
      console.log('--- closing', Math.min(2, clients.length), 'controller(s) at', DISCONNECT_AT, 's');
      for (const c of clients.slice(0, 2)) { c.token = true; try { c.ws.close(); } catch {} }
    }, DISCONNECT_AT * 1000);
    recIv = setInterval(() => {
      for (const c of clients.slice(0, 2)) {
        if (c.ws.readyState === 3) {
          const nw = new WebSocket(`ws://${HOST}/ws`);
          nw.on('open', () => nw.send(JSON.stringify({ type: 'join' })));
          nw.on('message', (d, isB) => { if (isB) return; try { const m = JSON.parse(d.toString()); if (m.type === 'joined') { c.ws = nw; c.teamId = m.teamId; c.sessionId = m.sessionId; c.seq = 0; console.log('reconnected team', c.teamId); } } catch {} });
          c.ws = nw;
        }
      }
    }, 500);
  }

  await new Promise(r => setTimeout(r, DURATION * 1000));
  for (const t of timers) clearInterval(t); clearInterval(pingIv); if (recIv) clearInterval(recIv); if (faultIv) clearTimeout(faultIv);

  const seconds = (Date.now() - tStart) / 1000;
  const jitter = (() => { if (rtts.length < 2) return 0; let s = 0; for (let i = 1; i < rtts.length; i++) s += Math.abs(rtts[i] - rtts[i - 1]); return s / (rtts.length - 1); })();
  console.log('');
  console.log('=== stress summary ===');
  console.log(`clients:            ${CLIENTS} (${spectating} spectating: lobby full)`);
  console.log(`duration:           ${seconds.toFixed(1)} s`);
  console.log(`input rate:         ${(sent / seconds).toFixed(1)} packets/s total, ${(sent / seconds / Math.max(1, CLIENTS)).toFixed(1)} per client`);
  console.log(`RTT p50 / p95 / p99:${percentile(rtts, 50)} / ${percentile(rtts, 95)} / ${percentile(rtts, 99)} ms`);
  console.log(`jitter (mean |Δ|):  ${jitter.toFixed(2)} ms`);
  console.log(`ping samples:       ${rtts.length}`);
  console.log(`mode:               ${FRANTIC ? 'frantic' : 'normal'}${DISCONNECT_AT != null ? ` + disconnect at ${DISCONNECT_AT}s` : ''}`);
  console.log(`client flow:        ${clients.map((c) => c.flow).join(',')}`);
  console.log(`client teams:       ${clients.map((c) => c.teamId).join(',')}`);
  console.log(`server flow:        ${(await debugJson('/debug/slots'))?.flow}`);
  if (FAULT) console.log(`fault:              ${FAULT}`);
  // server responsiveness check
  await new Promise((res) => {
    const t = Date.now();
    http.get(`http://${HOST}/diagnostics`, (r) => { r.resume(); r.on('end', () => { console.log(`HTTP /diagnostics after load: ${r.statusCode} in ${Date.now() - t} ms`); res(); }); }).on('error', e => { console.log('http error', e.message); res(); });
  });
  for (const c of clients) { try { c.ws.close(); } catch {} }
  if (hostWs) { try { hostWs.send(JSON.stringify({ type: 'hostFlow', flow: 'lobby' })); hostWs.close(); } catch {} }
  process.exit(0);
})();