// Full event flow: 6 controllers -> lobby -> select -> settings -> race -> results -> points -> leaderboard -> next race.
const { chromium } = require('playwright');

const HOST = 'http://127.0.0.1:8081';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const watch = (p, tag) => {
    p.on('pageerror', e => errs.push(tag + ' PAGEERROR: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(tag + ': ' + m.text()); });
  };
  const host = await b.newPage({ viewport: { width: 900, height: 506 } });
  watch(host, 'host');
  await host.goto(HOST + '/', { waitUntil: 'load' });
  await host.waitForTimeout(2500);
  await host.click('#btn-event');
  await host.waitForTimeout(800);

  const controllers = [];
  for (let i = 0; i < 6; i++) {
    const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
    const p = await ctx.newPage();
    watch(p, 'c' + (i + 1));
    await p.goto(HOST + '/controller', { waitUntil: 'load' });
    await p.fill('#name-input', 'Team ' + (i + 1));
    await p.click('#join-btn');
    await p.waitForTimeout(400);
    controllers.push({ page: p, ctx });
  }
  await host.waitForTimeout(900);
  console.log('slots connected:', await host.evaluate(() => document.querySelectorAll('.slot.on').length));
  for (let i = 0; i < 6; i++) { await controllers[i].page.click(`.char[data-i="${i}"]`); await controllers[i].page.click('#ready-btn'); }
  await host.waitForTimeout(700);
  console.log('slots ready:', await host.evaluate(() => document.querySelectorAll('.slot.ready').length));

  await host.click('#ev-start');
  await host.waitForTimeout(400);
  await host.click('#ev-go');
  await host.waitForTimeout(3500);
  console.log('after start:', await host.evaluate(() => window.__game.eventDebug().state));

  // everyone holds gas + steer slightly
  for (const c of controllers) { await c.page.dispatchEvent('#ctl-gas', 'pointerdown'); }
  await host.waitForTimeout(1500);
  let speeds = await host.evaluate(() => window.__game.world.karts.map(k => +k.speed.toFixed(1)));
  console.log('speeds after gas:', JSON.stringify(speeds));

  // fast-forward the simulation (headless swiftshader only manages a few fps)
  await host.evaluate(() => window.__game.simulateFor(6));
  speeds = await host.evaluate(() => window.__game.world.karts.map(k => +k.speed.toFixed(1)));
  const ts = await host.evaluate(() => window.__game.world.karts.map(k => +k.trackT.toFixed(2)));
  console.log('speeds after sim:', JSON.stringify(speeds), 'trackT:', JSON.stringify(ts));
  await host.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\race1.png' });

  // hand every slot to AI (exercises the same takeover path the server uses for
// a disconnected phone) so the race can be fast-forwarded headlessly
  await host.evaluate(() => {
    for (let i = 1; i <= 6; i++) window.__game.send({ type: 'hostReplaceAI', teamId: i });
    window.__game.world.race.laps = 1;
  });
  await host.waitForTimeout(800);
  console.log('lobby ai flags:', JSON.stringify(await host.evaluate(() => window.__game.debugLobby ? window.__game.debugLobby() : 'n/a')));
  const simRes = await host.evaluate(() => {
    const before = window.__game.world.karts.map(k => +k.trackT.toFixed(3));
    const steps = window.__game.simulateFor(400);
    const w = window.__game.world;
    return { steps, before, errors: window.__game.errors(), phase: w.race.phase, ended: w.race.ended,
      fin: w.karts.map(k => k.finished), t: w.karts.map(k => +k.trackT.toFixed(2)),
      spd: w.karts.map(k => +k.speed.toFixed(1)), ai: w.karts.map(k => !!k._ai) };
  });
  console.log('race state:', JSON.stringify(simRes));
  await host.waitForTimeout(1500);
  console.log('state after race:', await host.evaluate(() => document.querySelector('.event-ui').dataset.screen));
  const results = await host.evaluate(() => (window.__game.eventDebug(), document.querySelector('.ev-results') ? document.querySelector('.ev-results').innerText.slice(0, 400) : 'none'));
  console.log('results:\n', results);
  await host.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\results1.png' });

  // leaderboard
  await host.click('#ev-next');
  await host.waitForTimeout(900);
  console.log('board:\n', await host.evaluate(() => document.querySelector('.ev-board') ? document.querySelector('.ev-board').innerText.slice(0, 500) : 'none'));
  await host.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\board1.png' });

  console.log('errors:', errs.slice(0, 15));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });