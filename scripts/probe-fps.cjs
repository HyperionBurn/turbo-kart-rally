const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 506 } });
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__game && window.__game.state === 'title');
  await p.click('#btn-event'); await p.waitForTimeout(600);
  await p.click('#ev-start'); await p.waitForTimeout(300);
  await p.click('#ev-go'); await p.waitForTimeout(2000);
  await p.evaluate(() => window.__game.skipEventCountdown());
  await p.waitForTimeout(2000);
  const r = await p.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else res({ rafFps: n / ((performance.now() - t0) / 1000), radar: window.__game.eventDebug().radar, fps: window.__game.eventDebug().fps }); };
    requestAnimationFrame(tick);
  }));
  console.log(JSON.stringify(r));
  await b.close();
})();