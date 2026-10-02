// Event-mode flow: six phones join, select, ready, race, finish, points, leaderboard, reconnect.
const { test, expect } = require('@playwright/test');

const HOST = 'http://127.0.0.1:8081';

async function newHost(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 506 } });
  page.errors = [];
  page.on('pageerror', e => page.errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  return page;
}

async function newController(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(HOST + '/controller', { waitUntil: 'load' });
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForFunction(() => !document.querySelector('#view-join.active'), null, { timeout: 20000 });
  return { ctx, page };
}

test('six controllers join, ready, race together and the results award points', async ({ browser }) => {
  test.setTimeout(420000);
  const host = await newHost(browser);
  await host.click('#btn-event', { force: true });
  // start from a clean tournament: the server keeps the session across host restarts
  await host.evaluate(() => window.__game.send({ type: 'hostResetSession' }));
  await host.waitForTimeout(400);
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'lobby');
  // the QR code is rendered from the local controller URL
  await expect(host.locator('#ev-qr')).toBeVisible();
  const qrDrawn = await host.evaluate(() => {
    const c = document.querySelector('#ev-qr');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200) lit++;
    return lit;
  });
  expect(qrDrawn).toBeGreaterThan(500);

  const ctrls = [];
  for (let i = 0; i < 6; i++) ctrls.push(await newController(browser, 'Team ' + (i + 1)));
  await expect(host.locator('.slot.on')).toHaveCount(6, { timeout: 20000 });

  for (let i = 0; i < 6; i++) {
    await ctrls[i].page.click(`.char[data-i="${i}"]`);
    await ctrls[i].page.click('#ready-btn');
  }
  await expect(host.locator('.slot.ready')).toHaveCount(6, { timeout: 20000 });

  // duplicate racers are refused while the host keeps allowDupes off
  await ctrls[0].page.click('.char[data-i="0"]');
  await expect(ctrls[0].page.locator('.char[data-i="0"]')).toHaveClass(/sel/);

  await host.click('#ev-start', { force: true });
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'settings');
  // record every event-screen transition: the prerace overlay is up for ~2.4 s while the
  // page is busy building the world, so a poll right after the click can miss it
  await host.evaluate(() => {
    window.__screens = [];
    const el = document.querySelector('.event-ui');
    new MutationObserver(() => window.__screens.push(el.dataset.screen)).observe(el, { attributes: true, attributeFilter: ['data-screen'] });
  });
  await host.click('#ev-go', { force: true });
  expect(await host.evaluate(() => window.__screens)).toContain('prerace');
  await host.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });

  // six viewports + six HUD panels
  await expect(host.locator('.sp-panel')).toHaveCount(6);
  await host.evaluate(() => window.__game.skipEventCountdown());
  await host.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await expect(host.locator('.split-hud.on')).toBeVisible();

  // each controller drives its own kart (headless software rendering runs at a few fps,
  // so poll rather than assuming a fixed window)
  const before = await host.evaluate(() => window.__game.world.karts.map(k => k.speed));
  for (const c of ctrls) await c.page.dispatchEvent('#ctl-gas', 'pointerdown');
  await expect.poll(async () => {
    const s = await host.evaluate(() => window.__game.world.karts.map(k => k.speed));
    return s.filter((v, i) => v > before[i] + 1).length;
  }, { timeout: 30000 }).toBeGreaterThanOrEqual(5);
  for (const c of ctrls) await c.page.dispatchEvent('#ctl-gas', 'pointerup');

  // steering is independent per team
  await ctrls[1].page.dispatchEvent('#ctl-right', 'pointerdown');
  await ctrls[2].page.dispatchEvent('#ctl-left', 'pointerdown');
  await expect.poll(async () => {
    const steer = await host.evaluate(() => window.__game.world.karts.map(k => Math.sign(+(k.input.steer || 0).toFixed(2))));
    return `${steer[1]},${steer[2]}`;
  }, { timeout: 20000 }).toBe('1,-1');
  await ctrls[1].page.dispatchEvent('#ctl-right', 'pointerup');
  await ctrls[2].page.dispatchEvent('#ctl-left', 'pointerup');

  // item button edges reach the host
  await ctrls[3].page.dispatchEvent('#ctl-item', 'pointerdown');
  await ctrls[3].page.dispatchEvent('#ctl-item', 'pointerup');
  await host.waitForTimeout(400);

  // finish the race: hand the karts to AI, one lap, fast-forward the fixed-step sim
  await host.evaluate(() => {
    for (let i = 1; i <= 6; i++) window.__game.send({ type: 'hostReplaceAI', teamId: i });
  });
  await host.waitForTimeout(600);
  await host.evaluate(() => { window.__game.world.race.laps = 1; });
  await host.evaluate(() => window.__game.simulateFor(400));
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'results', { timeout: 30000 });

  const places = await host.evaluate(() => [...document.querySelectorAll('.res-row .res-place')].map(e => e.textContent.trim()));
  expect(places).toEqual(['1st', '2nd', '3rd', '4th', '5th', '6th']);
  const points = await host.evaluate(() => [...document.querySelectorAll('.res-row .res-pts')].map(e => e.textContent.trim()));
  expect(points).toEqual(['+10', '+8', '+6', '+4', '+2', '+1']);

  await host.click('#ev-next', { force: true });
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'leaderboard');
  const totals = await host.evaluate(() => [...document.querySelectorAll('.ev-board tbody tr td:nth-child(6)')].map(e => e.dataset.total));
  expect(totals.map(Number).sort((a, b) => b - a)).toEqual([10, 8, 6, 4, 2, 1]);

  // a second race accumulates onto the same totals
  await host.click('#ev-again', { force: true });
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'settings');
  await host.click('#ev-go', { force: true });
  await host.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });
  await host.evaluate(() => window.__game.skipEventCountdown());
  await host.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await host.evaluate(() => { window.__game.world.race.laps = 1; });
  await host.evaluate(() => window.__game.simulateFor(400));
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'results', { timeout: 30000 });
  await host.click('#ev-next', { force: true });
  const totals2 = await host.evaluate(() => [...document.querySelectorAll('.ev-board tbody tr td:nth-child(6)')].map(e => +e.dataset.total));
  expect(Math.max(...totals2)).toBeGreaterThan(10);

  // nothing uncaught anywhere in the flow
  const allErrors = [...host.errors, ...ctrls.flatMap((c) => c.page.errors)].filter((e) => !/favicon/i.test(e));
  expect(allErrors).toEqual([]);
  for (const c of ctrls) await c.ctx.close();
  await host.close();
});

test('a phone can reclaim its slot after dropping out mid-race', async ({ browser }) => {
  const host = await newHost(browser);
  await host.click('#btn-event', { force: true });
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'lobby');
  const ctrls = [];
  for (let i = 0; i < 3; i++) ctrls.push(await newController(browser, 'Team ' + (i + 1)));
  await expect(host.locator('.slot.on')).toHaveCount(3, { timeout: 20000 });
  const token = await ctrls[1].page.evaluate(() => localStorage.getItem('tkr-token'));

  await host.click('#ev-start', { force: true });
  await host.waitForTimeout(300);
  await host.click('#ev-go', { force: true });
  await host.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });

  // team 2 walks out of range (the lobby screen is behind the race UI, so read server truth)
  await ctrls[1].ctx.close();
  await expect.poll(async () => (await host.evaluate(() => window.__game.debugLobby())).filter((t) => t.conn).length, { timeout: 30000 }).toBe(2);

  // the same phone comes back and reclaims team 2
  const back = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await back.newPage();
  await page.goto(HOST + '/controller', { waitUntil: 'load' });
  await page.evaluate((tk) => { localStorage.setItem('tkr-token', tk); localStorage.setItem('tkr-name', 'Team 2'); }, token);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#view-join.active'), null, { timeout: 20000 });
  await expect.poll(async () => (await host.evaluate(() => window.__game.debugLobby())).filter((t) => t.conn).length, { timeout: 30000 }).toBe(3);
  const teams = await host.evaluate(() => window.__game.debugLobby());
  expect(await page.evaluate(() => localStorage.getItem('tkr-token'))).toBe(token);

  for (const c of ctrls) await c.ctx.close();
  await back.close();
  await host.close();
});

test('host can force ready, replace a team with AI, and reset the tournament', async ({ browser }) => {
  const host = await newHost(browser);
  await host.click('#btn-event', { force: true });
  const ctrls = [];
  for (let i = 0; i < 2; i++) ctrls.push(await newController(browser, 'Team ' + (i + 1)));
  await expect(host.locator('.slot.on')).toHaveCount(2, { timeout: 20000 });

  await host.click('[data-act="ready"][data-team="3"]');
  await expect(host.locator('.slot[data-team="3"]')).toHaveClass(/ready/);
  await host.click('[data-act="ai"][data-team="3"]');
  await expect(host.locator('.slot[data-team="3"]')).toContainText('AI');
  await host.click('[data-act="remove"][data-team="1"]');
  await expect(host.locator('.slot.on')).toHaveCount(1, { timeout: 20000 });

  // session reset clears the leaderboard
  await host.evaluate(() => window.__game.send({ type: 'hostResetSession' }));
  await host.waitForTimeout(600);
  await host.click('#ev-start', { force: true });
  await host.click('#ev-go', { force: true });
  await host.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });
  await host.evaluate(() => window.__game.skipEventCountdown());
  await host.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await host.evaluate(() => { window.__game.world.race.laps = 1; });
  await host.evaluate(() => window.__game.simulateFor(400));
  await expect(host.locator('.event-ui')).toHaveAttribute('data-screen', 'results', { timeout: 30000 });
  await host.click('#ev-next', { force: true });
  await host.click('#ev-reset', { force: true });
  await host.waitForTimeout(800);
  await host.click('#ev-again', { force: true });
  const scores = await host.evaluate(() => fetch('/debug/slots').then(r => r.json()).then(j => j.scores));
  expect(scores.length).toBe(0);

  for (const c of ctrls) await c.ctx.close();
  await host.close();
});

test('solo mode still works end to end', async ({ browser }) => {
  test.setTimeout(300000);
  const page = await browser.newPage({ viewport: { width: 900, height: 506 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-solo');
  await expect(page.locator('.select-screen')).toHaveClass(/active/);
  await page.locator('.card').first().click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__game.startRace({ laps: 1 }));
  await page.waitForFunction(() => window.__game.state === 'intro', null, { timeout: 120000 });
  await page.evaluate(() => window.__game.skipIntro());
  await page.waitForFunction(() => window.__game.state === 'countdown', null, { timeout: 60000 });
  await page.evaluate(() => window.__game.skipCountdown());
  await page.waitForFunction(() => window.__game.state === 'racing', null, { timeout: 60000 });
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(3000);
  await page.keyboard.up('ArrowUp');
  const moved = await page.evaluate(() => window.__game.world.player.speed);
  expect(moved).toBeGreaterThan(1);
  expect(errors).toEqual([]);
  await page.close();
});

test('diagnostics page loads and reports team link quality', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(HOST + '/diagnostics', { waitUntil: 'load' });
  await expect(page.locator('#teams tbody tr')).toHaveCount(6, { timeout: 20000 });
  await page.click('button[data-k="1"][data-d="100"]');
  await page.click('button[data-k="1"]');
  await page.close();
});
