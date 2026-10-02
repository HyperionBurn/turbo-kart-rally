// Reconnect drill: disconnect controller 3 mid-race, verify its slot goes AI,
// then reconnect with the stored token and verify the slot comes back to the same team.
const { chromium } = require('playwright');
const HOST = 'http://127.0.0.1:8080';

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
  await host.waitForTimeout(700);

  const ctrl = [];
  for (let i = 0; i < 6; i++) {
    const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
    const p = await ctx.newPage();
    watch(p, 'c' + (i + 1));
    await p.goto(HOST + '/controller', { waitUntil: 'load' });
    await p.fill('#name-input', 'Team ' + (i + 1));
    await p.click('#join-btn');
    await p.waitForTimeout(350);
    ctrl.push({ page: p, ctx });
  }
  await host.waitForTimeout(700);
  for (let i = 0; i < 6; i++) { await ctrl[i].page.click(`.char[data-i="${i}"]`); await ctrl[i].page.click('#ready-btn'); }
  const token3 = await ctrl[2].page.evaluate(() => localStorage.getItem('tkr-token'));
  console.log('team3 token:', token3);

  await host.click('#ev-start'); await host.waitForTimeout(300);
  await host.click('#ev-go'); await host.waitForTimeout(3000);
  console.log('racing:', await host.evaluate(() => window.__game.eventDebug().state));

  // hard-drop controller 3 (simulate walking out of wifi range)
  await ctrl[2].page.evaluate(() => { window.__netKill = true; try { window.navigator.sendBeacon && 0; } catch {} });
  await ctrl[2].page.evaluate(() => { const ws = window.__wsRef; if (ws) ws.close(); });
  await ctrl[2].ctx.close(); // kills the socket for real
  await host.waitForTimeout(1200);
  console.log('after kill:', JSON.stringify(await host.evaluate(() => window.__game.debugLobby())));

  // reconnect with the same token in a fresh context
  const ctx2 = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const p2 = await ctx2.newPage();
  watch(p2, 'c3b');
  await p2.goto(HOST + '/controller', { waitUntil: 'load' });
  await p2.evaluate((tk) => { localStorage.setItem('tkr-token', tk); localStorage.setItem('tkr-name', 'Team 3'); }, token3);
  await p2.reload({ waitUntil: 'load' });
  await p2.waitForFunction(() => document.querySelector('#view-join.active') === null, null, { timeout: 10000 });
  await p2.waitForTimeout(1200);
  console.log('reconnected view:', await p2.evaluate(() => document.querySelector('.view.active').id));
  await host.waitForTimeout(3000);
  const teams = await host.evaluate(() => window.__game.debugLobby());
  console.log('after reconnect (host view):', JSON.stringify(teams));
  const serverSlots = await new Promise((res) => require('http').get(HOST + '/debug/slots', (r) => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }));
  console.log('after reconnect (server):   ', serverSlots);
  const team3 = teams.find((t) => t.id === 3);
  console.log('team3 reclaimed:', team3 && team3.conn ? 'YES' : 'NO', 'sessionId', team3 && team3.sessionId);

  // the other five must be unaffected
  const others = teams.filter((t) => t.id !== 3);
  console.log('others connected:', others.filter((t) => t.conn).length, '/ 5');

  console.log('errors:', errs.slice(0, 10));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });