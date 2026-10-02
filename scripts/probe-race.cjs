const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const host = await b.newPage({ viewport: { width: 640, height: 360 } });
  host.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await host.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await host.waitForTimeout(2500);
  await host.click('#btn-event');
  await host.waitForTimeout(600);
  await host.click('#ev-start');
  await host.waitForTimeout(400);
  await host.click('#ev-go');
  for (let i = 0; i < 16; i++) {
    await host.waitForTimeout(1000);
    const s = await host.evaluate(() => ({ st: document.body.dataset.state, dbg: window.__game.eventDebug() }));
    console.log(i, s.st, JSON.stringify(s.dbg));
  }
  await host.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\race-probe.png' });
  await b.close();
})();