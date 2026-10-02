const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const host = await b.newPage({ viewport: { width: 640, height: 360 } });
  host.on('pageerror', e => console.log('PAGEERROR:', e.message));
  host.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
  await host.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await host.waitForTimeout(2500);
  await host.click('#btn-event');
  await host.waitForTimeout(500);
  await host.click('#ev-start');
  await host.waitForTimeout(300);
  await host.click('#ev-go');
  await host.waitForTimeout(2500);
  await host.evaluate(() => window.__game.simulateFor(5));
  console.log('phase:', await host.evaluate(() => window.__game.eventDebug().racePhase));
  const r = await host.evaluate(() => {
    const w = window.__game.world;
    w.race.laps = 1;
    w.karts.forEach(k => w.race.debugSetLap(k, 1));
    window.__game.simulateFor(120);
    return { phase: w.race.phase, ended: w.race.ended, laps: w.race.laps, kartT: w.karts.map(k => +k.trackT.toFixed(2)), fin: w.karts.map(k => k.finished) };
  });
  console.log(JSON.stringify(r));
  await host.waitForTimeout(1200);
  console.log('screen:', await host.evaluate(() => document.querySelector('.event-ui').dataset.screen));
  await b.close();
})();