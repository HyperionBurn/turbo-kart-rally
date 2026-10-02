// Manual screenshot pass: lobby, split race (6), broadcast, results, leaderboard.
//   node scripts/shots.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots-event');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const b = await chromium.launch();
  const host = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await host.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await host.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await host.click('#btn-event', { force: true });
  await host.evaluate(() => window.__game.send({ type: 'hostResetSession' }));
  await host.evaluate(() => window.__game.send({ type: 'hostSettings', settings: { cameraMode: 'split' } }));
  await host.waitForTimeout(800);
  await host.screenshot({ path: path.join(OUT, '01-lobby-empty.png') });

  for (let i = 0; i < 6; i++) {
    const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto('http://127.0.0.1:8080/controller', { waitUntil: 'load' });
    await p.waitForLoadState('load').catch(() => {});
    if (i === 0) { await p.screenshot({ path: path.join(OUT, '00-controller-join.png'), animations: 'disabled', caret: 'initial' }).catch(() => {}); }
    await p.fill('#name-input', ['CRIMSON', 'AZURE', 'JADE', 'GOLD', 'ORCHID', 'TANGERINE'][i]);
    await p.click('#join-btn');
    await p.waitForTimeout(400);
    await p.click(`.char[data-i="${i}"]`);
    await p.waitForTimeout(200);
    if (i === 0) { await p.screenshot({ path: path.join(OUT, '00b-controller-lobby.png') }).catch(() => {}); }
    await p.click('#ready-btn');
    await p.waitForTimeout(300);
    if (i === 0) { await p.screenshot({ path: path.join(OUT, '00c-controller-ready.png') }).catch(() => {}); }
  }
  await host.waitForTimeout(1000);
  await host.screenshot({ path: path.join(OUT, '02-lobby-six.png') });

  await host.click('#ev-start', { force: true });
  await host.waitForTimeout(600);
  await host.screenshot({ path: path.join(OUT, '03-settings.png') });
  await host.click('#ev-go', { force: true });
  await host.waitForTimeout(1200);
  await host.screenshot({ path: path.join(OUT, '04-prerace.png') });
  await host.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });
  await host.screenshot({ path: path.join(OUT, '05-start-lights.png') });
  await host.evaluate(() => window.__game.skipEventCountdown());
  await host.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  // drive everyone forward a little so the split screen shows motion
  await host.evaluate(() => window.__game.simulateFor(14));
  await host.waitForTimeout(1500);
  await host.screenshot({ path: path.join(OUT, '06-split-race.png') });
  await host.keyboard.press('F3');
  await host.waitForTimeout(1200);
  await host.screenshot({ path: path.join(OUT, '07-latency-overlay.png') });
  await host.keyboard.press('F3');

  await host.evaluate(() => { for (let i = 1; i <= 6; i++) window.__game.send({ type: 'hostReplaceAI', teamId: i }); });
  await host.waitForTimeout(600);
  await host.evaluate(() => { window.__game.world.race.laps = 1; });
  await host.evaluate(() => window.__game.simulateFor(400));
  await host.waitForTimeout(1200);
  await host.screenshot({ path: path.join(OUT, '08-results.png') });
  await host.click('#ev-next', { force: true });
  await host.waitForTimeout(1200);
  await host.screenshot({ path: path.join(OUT, '09-leaderboard.png') });

  // broadcast camera mode for the second race
  await host.click('#ev-again', { force: true });
  await host.waitForTimeout(400);
  await host.click('button[data-k="cameraMode"][data-v="broadcast"]', { force: true });
  await host.waitForTimeout(400);
  await host.click('#ev-go', { force: true });
  await host.waitForTimeout(1500);
  await host.evaluate(() => window.__game.skipEventCountdown());
  await host.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await host.evaluate(() => window.__game.simulateFor(12));
  await host.waitForTimeout(9000);
  await host.screenshot({ path: path.join(OUT, '10-broadcast.png') });

  await b.close();
  console.log('screenshots written to', OUT);
})();

