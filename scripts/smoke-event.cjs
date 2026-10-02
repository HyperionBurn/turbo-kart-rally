const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  console.log('state:', await p.evaluate(() => window.__game && window.__game.state));
  // click EVENT MODE
  await p.click('#btn-event').catch(e => console.log('event btn fail', e.message));
  await p.waitForTimeout(1500);
  const screen = await p.evaluate(() => document.querySelector('.event-ui')?.dataset.screen);
  console.log('event screen:', screen);
  console.log('errors:', errs.slice(0, 8));
  await p.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\event-lobby.png' });
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
