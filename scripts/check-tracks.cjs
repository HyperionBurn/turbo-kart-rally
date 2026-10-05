// Drivability check for every circuit in src/tracks.js: a solo race with the player on
// autopilot plus seven AI karts, simulated for 120 s per track. Prints laps completed,
// rescue (respawn) counts and page errors. Needs `npm start` running.
//   node scripts/check-tracks.cjs [--host http://127.0.0.1:8081] [--seconds 120]
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const HOST = opt('host', 'http://127.0.0.1:8081');
const SECONDS = +opt('seconds', 120);
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(HOST + '/');
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  const ids = await page.evaluate(() => import('/src/tracks.js').then((m) => m.TRACKS.map((t) => t.id)));
  let bad = 0;
  for (const id of ids) {
    await page.evaluate((track) => window.__game.startRace({ track, laps: 50, difficulty: 'hard' }), id);
    await page.waitForFunction(() => ['intro', 'countdown', 'racing'].includes(window.__game.state), null, { timeout: 60000 });
    const r = await page.evaluate((secs) => {
      const g = window.__game, w = g.world;
      const respawns = new Map();
      const off = g.bus.on('kart:respawn', (d) => respawns.set(d.kart, (respawns.get(d.kart) || 0) + 1));
      g.skipIntro(); g.skipCountdown(); g.debug.autopilot = true;
      g.simulateFor(secs);
      off && off();
      const laps = w.karts.map((k) => Math.max(0, (k.lap || 1) - 1));
      return { name: w.track.name, length: Math.round(w.track.length), laps, rescues: w.karts.map((k) => respawns.get(k) || 0), nan: w.karts.some((k) => !Number.isFinite(k.position.x)), errors: g.errors() };
    }, SECONDS);
    const minLaps = Math.min(...r.laps), totalRescues = r.rescues.reduce((a, c) => a + c, 0);
    const ok = minLaps >= 1 && !r.nan && r.errors.length === 0 && totalRescues <= r.laps.length * 2;
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(20)} ${r.length} m · laps in ${SECONDS}s per kart: ${r.laps.join(',')} · rescues: ${r.rescues.join(',')}${r.errors.length ? ' · errors: ' + r.errors.join(' | ') : ''}`);
  }
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  await b.close();
  process.exit(bad || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
