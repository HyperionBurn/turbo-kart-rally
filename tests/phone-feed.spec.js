// Phone live-feed relay: countdown numbers, standings (+item), and session rules
// reach controllers through the server. Pure WebSocket level — no rendering.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');

const WS = 'ws://127.0.0.1:8081/ws';
function connect() { return new Promise((res, rej) => {
  const ws = new WebSocket(WS);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
}); }
function next(ws, pred, timeout = 15000) { return new Promise((res, rej) => {
  const t = setTimeout(() => { ws.off('message', on); rej(new Error('timeout waiting for message')); }, timeout);
  function on(data, isBinary) {
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (pred(m)) { clearTimeout(t); ws.off('message', on); res(m); }
  }
  ws.on('message', on);
}); }
// Join with retries: parallel suites can briefly fill all six slots, in which case the
// server answers 'spectating'. Wait for a slot to free up instead of flaking.
async function joinSlot(name, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'join', name }));
    const m = await next(ws, (x) => x.type === 'joined' || x.type === 'spectating');
    if (m.type === 'joined') return { ws, joined: m };
    ws.close();
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('no free team slot after retries');
}

test('countdown numbers and item standings relay to phones, lobby carries rules', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'hostHello' }));
  const { ws: ctl, joined } = await joinSlot('FEEDTEST');
  try {
    expect(joined.teamId).toBeGreaterThanOrEqual(1);

  // lobby state carries the points table + race index (no separate session channel needed)
  const lobby = await next(ctl, (m) => m.type === 'lobby' && Array.isArray(m.state.pointsTable));
  expect(lobby.state.pointsTable).toEqual([10, 8, 6, 4, 2, 1]);
  expect(typeof lobby.state.raceIndex).toBe('number');

  // countdown numbers flow host -> all phones
  host.send(JSON.stringify({ type: 'hostCountdown', n: 3 }));
  const cd = await next(ctl, (m) => m.type === 'countdown');
  expect(cd.n).toBe(3);

  // standings incl. held item flow host -> phones untouched
  const rows = [{ teamId: joined.teamId, place: 2, lap: 1, item: 'mushroom' }];
  host.send(JSON.stringify({ type: 'hostStandings', rows }));
  const st = await next(ctl, (m) => m.type === 'standings');
  expect(st.rows).toEqual(rows);
  } finally { host.close(); ctl.close(); }
});

test('GO countdown relays to phones', async () => {
  const host = await connect();
  try {
    host.send(JSON.stringify({ type: 'hostHello' }));
    const { ws: ctl, joined } = await joinSlot('GOTEST');
    try {
      expect(joined.teamId).toBeGreaterThanOrEqual(1);
      host.send(JSON.stringify({ type: 'hostCountdown', n: 'GO' }));
      const cd = await next(ctl, (m) => m.type === 'countdown');
      expect(cd.n).toBe('GO');
    } finally { ctl.close(); }
  } finally { host.close(); }
});

test('standings rows without an item field pass through untouched', async () => {
  const host = await connect();
  try {
    host.send(JSON.stringify({ type: 'hostHello' }));
    const { ws: ctl, joined } = await joinSlot('NOITEM');
    try {
      // back-compat: older hosts omit the item field entirely
      const rows = [
        { teamId: joined.teamId, place: 1, lap: 3 },
        { teamId: 99, place: 2, lap: 3 },
      ];
      host.send(JSON.stringify({ type: 'hostStandings', rows }));
      const st = await next(ctl, (m) => m.type === 'standings');
      expect(st.rows).toEqual(rows);
      for (const r of st.rows) expect('item' in r).toBe(false);
    } finally { ctl.close(); }
  } finally { host.close(); }
});

test('reconnecting phone reclaims its slot with the same token', async () => {
  const c1 = await connect();
  c1.send(JSON.stringify({ type: 'join', name: 'REJOIN' }));
  const j1 = await next(c1, (m) => m.type === 'joined');
  expect(j1.token).toBeTruthy();
  await new Promise((res) => { c1.on('close', res); c1.close(); });
  // let the server process the close before reclaiming
  await new Promise((r) => setTimeout(r, 300));
  const c2 = await connect();
  try {
    c2.send(JSON.stringify({ type: 'join', token: j1.token, name: 'REJOIN' }));
    const j2 = await next(c2, (m) => m.type === 'joined');
    expect(j2.teamId).toBe(j1.teamId);
    expect(j2.sessionId).not.toBe(j1.sessionId);
  } finally { c2.close(); }
});
