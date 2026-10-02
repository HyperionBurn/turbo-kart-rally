const { chromium } = require('playwright');
const HOST = 'http://127.0.0.1:8080';
(async () => {
  const b = await chromium.launch();
  const mk = async (tag) => {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    p.on('console', m => console.log(tag + ':', m.type(), m.text().slice(0, 140)));
    p.on('pageerror', e => console.log(tag + 'ERR:', e.message));
    return { ctx, p };
  };
  const a = await mk('A');
  await a.p.goto(HOST + '/controller', { waitUntil: 'load' });
  await a.p.fill('#name-input', 'Probe');
  await a.p.click('#join-btn');
  await a.p.waitForTimeout(1000);
  const t1 = await a.p.evaluate(() => localStorage.getItem('tkr-token'));
  console.log('token1', t1, 'view', await a.p.evaluate(() => document.querySelector('.view.active').id));
  await a.ctx.close();

  // reclaim in a brand-new browser context (no shared storage)
  const c = await mk('B');
  await c.p.goto(HOST + '/controller', { waitUntil: 'load' });
  await c.p.evaluate((tk) => { localStorage.setItem('tkr-token', tk); localStorage.setItem('tkr-name', 'Probe'); }, t1);
  await c.p.reload({ waitUntil: 'load' });
  await c.p.waitForTimeout(2500);
  console.log('token2', await c.p.evaluate(() => localStorage.getItem('tkr-token')), 'view', await c.p.evaluate(() => document.querySelector('.view.active').id));
  await b.close();
})();