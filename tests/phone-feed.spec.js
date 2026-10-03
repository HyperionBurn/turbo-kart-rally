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

test('countdown numbers and item standings relay to phones, lobby carries rules', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'hostHello' }));
  const ctl = await connect();
  ctl.send(JSON.stringify({ type: 'join', name: 'FEEDTEST' }));
  const joined = await next(ctl, (m) => m.type === 'joined');
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

  host.close(); ctl.close();
});
