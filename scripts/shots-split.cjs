// Visual proof at a specific window size:  node scripts/shots-split.cjs 2048 1150
const { chromium } = require('playwright');
const w = +(process.argv[2] || 2048), h = +(process.argv[3] || 1150), dpr = +(process.argv[4] || 1);
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('http://127.0.0.1:8081/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event', { force: true });
  await page.waitForTimeout(600);
  await page.click('#ev-start', { force: true });
  await page.waitForTimeout(400);
  await page.click('#ev-go', { force: true });
  for (let i = 0; i < 240; i++) {
    const s = await page.evaluate(() => {
      const d = window.__game.eventDebug();
      if (d.state === 'prerace' || d.state === 'countdown') window.__game.skipEventCountdown();
      return d.state;
    });
    if (s === 'racing') break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.__game.simulateFor(10));
  await page.waitForTimeout(4000);
  const dbg = await page.evaluate(() => window.__game.viewportDebug());
  console.log('canvas css vs buffer:', JSON.stringify(dbg.mapping));
  console.log('viewport css rects   :', JSON.stringify(dbg.viewports.map((v) => [v.x, v.y, v.w, v.h])));
  await page.screenshot({ path: `C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\align-${w}x${h}-dpr${dpr}.png` });
  console.log('errors:', errs);
  await b.close();
})();