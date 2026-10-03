// Controller connection + mobile UX: join flow, persistent conn bar, portrait pad,
// host lobby start guard. Deliberately avoids starting a race (no SwiftShader load).
const { test, expect } = require('@playwright/test');
const HOST = 'http://127.0.0.1:8081';

async function newController(browser, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(HOST + '/controller', { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  return { ctx, page, errors };
}

test('join flow shows connection progress and lands in lobby', async ({ browser }) => {
  const { ctx, page, errors } = await newController(browser);
  // conn bar is present before anything connects
  await expect(page.locator('#conn-bar')).toBeVisible();
  expect(await page.locator('#conn-bar').getAttribute('data-state')).toBe('idle');
  await expect(page.locator('#retry-btn')).toBeHidden();

  await page.fill('#name-input', 'UX TEST');
  await page.click('#join-btn');
  // joining state is explicit (button disabled, status text)
  await expect(page.locator('#view-lobby.active')).toBeVisible({ timeout: 20000 });
  expect(await page.locator('#conn-bar').getAttribute('data-state')).toBe('connected');
  expect(await page.locator('#conn-text').textContent()).toContain('UX TEST');
  // lobby header shows quality wording, not just a number
  await expect(page.locator('#ping-quality')).toBeVisible();
  // reload: the saved slot is offered with a forget option on the join screen
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!localStorage.getItem('tkr-token'), null, { timeout: 15000 });
  expect(await page.evaluate(() => document.querySelector('#forget-btn').hidden)).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('portrait phone gets a usable stacked pad with big targets', async ({ browser }) => {
  const { ctx, page, errors } = await newController(browser, { width: 390, height: 844 });
  // all race controls exist with accessible names even before the race starts
  for (const id of ['#ctl-left', '#ctl-right', '#ctl-drift', '#ctl-item', '#ctl-look', '#ctl-gas', '#ctl-brake']) {
    await expect(page.locator(id)).toHaveAttribute('aria-label', /.+/);
  }
  // reveal the race view (CSS-only) to measure the portrait layout
  await page.evaluate(() => document.querySelector('#view-race').classList.add('active'));
  // primary targets are thumb-sized (>=56px in the smaller dimension)
  const sizes = await page.evaluate(() => [...document.querySelectorAll('.pad-btn')].map((b) => {
    const r = b.getBoundingClientRect();
    return Math.round(Math.min(r.width, r.height));
  }));
  expect(sizes.length).toBe(7);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(56);
  // header controls exist
  await expect(page.locator('#pause-btn')).toBeVisible();
  await expect(page.locator('#fs-btn')).toBeVisible();
  await expect(page.locator('#countdown-overlay')).toBeHidden();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('host lobby blocks START with zero teams and hints what to do', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event', { force: true });
  await expect(page.locator('.event-ui')).toHaveAttribute('data-screen', 'lobby', { timeout: 20000 });
  const start = page.locator('#ev-start');
  // with nobody connected the button explains itself instead of starting an empty race
  await expect(start).toBeDisabled({ timeout: 20000 });
  await expect(start).toContainText('WAITING FOR TEAMS');
  await expect(page.locator('.ev-progress')).toBeVisible();
  await page.close();
});

test('lobby hint reflects readiness and flips once ready', async ({ browser }) => {
  const { ctx, page, errors } = await newController(browser);
  await page.fill('#name-input', 'HINT TEST');
  await page.click('#join-btn');
  await expect(page.locator('#view-lobby.active')).toBeVisible({ timeout: 20000 });
  const hint = page.locator('#lobby-hint');
  await expect(hint).toBeVisible();
  // pre-ready: the hint teaches the room readiness state (mentions READY either way)
  await expect(hint).toContainText(/READY/i, { timeout: 15000 });
  const before = await hint.textContent();
  expect(before).not.toMatch(/you’re ready|you're ready/i);
  // ready up (controller listens on pointerdown; click dispatches it) and expect the flip
  await page.click('#ready-btn');
  await expect(hint).toContainText(/you’re ready|you're ready/i, { timeout: 15000 });
  const after = await hint.textContent();
  expect(after).not.toBe(before);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('end card slots exist and are empty before any race', async ({ browser }) => {
  const { ctx, page, errors } = await newController(browser);
  await expect(page.locator('#end-place')).toBeAttached();
  expect(await page.locator('#end-place').textContent()).toBe('');
  await expect(page.locator('#end-detail')).toBeAttached();
  expect(await page.locator('#end-detail').textContent()).toBe('');
  expect(errors).toEqual([]);
  await ctx.close();
});
