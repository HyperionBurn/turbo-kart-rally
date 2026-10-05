// Screenshot every event screen (big screen + phone) at a given size, for UI review.
//   node scripts/ui-shots.cjs --host http://127.0.0.1:8081 --w 1440 --h 810 --out <dir>
const { chromium } = require('playwright');
const WebSocket = require('ws');
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
const HOST = opt('host', 'http://127.0.0.1:8081'), W = +opt('w', 1440), H = +opt('h', 810), OUT = opt('out', '.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const host = await b.newPage({ viewport: { width: W, height: H } });
  const shot = async (p, name) => { await p.screenshot({ path: `${OUT}/${W}x${H}-${name}.png` }); };
  await host.goto(HOST + '/');
  await host.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await sleep(1500); await shot(host, '01-title');
  await host.click('#btn-event', { force: true });
  await host.waitForFunction(() => !!window.__game.eventRoom);
  const room = await host.evaluate(() => window.__game.eventRoom);
  await host.evaluate(() => window.__game.send({ type: 'hostResetSession' }));
  // one real phone page (for phone screenshots) + five socket phones
  const pctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const ph = await pctx.newPage();
  await ph.goto(`${HOST}/controller?room=${room}`); await sleep(800); await ph.screenshot({ path: `${OUT}/phone-01-join.png` });
  await ph.fill('#name-input', 'ROCKET RAYAN'); await ph.click('#join-btn');
  await ph.waitForSelector('#view-lobby.active'); await sleep(500); await ph.screenshot({ path: `${OUT}/phone-02-lobby.png` });
  const names = ['TURBO TOADS', 'DRIFT KINGS', 'BANANA SQUAD', 'THE FAST ONES', 'TEAM 6IX'];
  const socks = [];
  for (let i = 0; i < 5; i++) {
    const ws = new WebSocket(HOST.replace('http', 'ws') + '/ws'); socks.push(ws);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', room, name: names[i] }));
    await new Promise((r) => ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'joined') { ws.send(JSON.stringify({ type: 'select', characterIdx: i + 1 })); if (i < 3) ws.send(JSON.stringify({ type: 'ready', ready: true })); r(); } }));
  }
  await sleep(1200); await shot(host, '02-lobby-six');
  await ph.click('#ready-btn');
  await host.click('#ev-start', { force: true }); await sleep(800); await shot(host, '03-settings');
  await host.click('#ev-go', { force: true }); await sleep(900); await shot(host, '04-prerace');
  await host.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });
  await sleep(1500); await shot(host, '05-countdown');
  await ph.screenshot({ path: `${OUT}/phone-03-countdown.png` });
  await host.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await sleep(4000); await shot(host, '06-race');
  await ph.screenshot({ path: `${OUT}/phone-04-race.png` });
  await host.evaluate(() => window.__game.send({ type: 'hostSettings', settings: { cameraMode: 'broadcast' } }));
  await sleep(2000); await shot(host, '07-broadcast');
  await host.evaluate(() => { const w = window.__game.world; w.race.computeResults && 0; window.__game.bus.emit('race:end', { results: w.race.computeResults() }); });
  await sleep(2500); await shot(host, '08-results');
  await host.click('#ev-next', { force: true }); await sleep(2000); await shot(host, '09-leaderboard');
  await ph.screenshot({ path: `${OUT}/phone-05-end.png` });
  // portrait phone
  await ph.setViewportSize({ width: 390, height: 844 }); await sleep(600); await ph.screenshot({ path: `${OUT}/phone-06-end-portrait.png` });
  for (const s of socks) s.terminate();
  await b.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
