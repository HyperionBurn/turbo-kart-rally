const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await p.goto('http://127.0.0.1:8081/', { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  console.log('state:', await p.evaluate(() => window.__game && window.__game.state));
  console.log('errors:', errs.slice(0,10));
  await p.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\baseline.png' });
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });

