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
  await host.waitForTimeout(2000);
  await host.evaluate(() => window.__game.simulateFor(5));
  const out = await host.evaluate(() => {
    const w = window.__game.world;
    const AIClass = window.__game.mods.ai.AIDriver;
    w.karts.forEach((k) => { if (!k._ai) { k._ai = new AIClass(k, w.track, { difficulty: 'hard' }); w.ais.push(k._ai); } });
    const rows = [];
    for (let i = 0; i < 8; i++) {
      window.__game.simulateFor(10);
      rows.push(w.karts.map((k) => +k.trackT.toFixed(2)).join(','));
    }
    return { rows, speed: w.karts.map(k => +k.speed.toFixed(1)), stall: w.karts.map(k => k.stallTimer || 0) };
  });
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})();