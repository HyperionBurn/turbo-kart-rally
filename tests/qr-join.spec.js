// Event-night join paths, end to end: the QR the big screen draws must decode with a strict
// (non-inverting) reader and lead a phone into the host's room; a phone with no code must
// still find the big screen; a mistyped code must never "join" somewhere invisible.
const { test, expect } = require('@playwright/test');
const jsQR = require('jsqr');

const HOST = 'http://127.0.0.1:8081';

async function openHostLobby(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event', { force: true });
  await expect(page.locator('.event-ui')).toHaveAttribute('data-screen', 'lobby', { timeout: 20000 });
  await page.waitForFunction(() => !!window.__game.eventRoom && document.querySelector('#ev-qr') && document.querySelector('#ev-qr').dataset.qr);
  return page;
}
async function phone(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  return { ctx, page };
}
/** Decode the QR exactly as drawn on the host canvas, refusing inverted codes. */
async function decodeHostQr(page) {
  const img = await page.evaluate(() => {
    const c = document.querySelector('#ev-qr');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
  const res = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h, { inversionAttempts: 'dontInvert' });
  return res ? res.data : null;
}
/** Phones on this machine reach the server on loopback; keep the QR's path + query. */
const viaLoopback = (url) => { const u = new URL(url); return `${HOST}${u.pathname}${u.search}`; };

test('host QR decodes without inversion and lands a phone in the host room', async ({ browser }) => {
  const host = await openHostLobby(browser);
  const room = await host.evaluate(() => window.__game.eventRoom);
  const decoded = await decodeHostQr(host);
  expect(decoded, 'strict (non-inverting) QR decode').toBeTruthy();
  expect(decoded).toMatch(new RegExp(`/controller\\?room=${room}$`));
  expect(decoded).not.toContain('localhost');
  expect(decoded).not.toContain('127.0.0.1');

  const p = await phone(browser, viaLoopback(decoded));
  try {
    // QR path: code already resolved, straight to the name step
    await expect(p.page.locator('#room-step')).toBeHidden();
    await p.page.fill('#name-input', 'QR TEAM');
    await p.page.click('#join-btn');
    await expect(p.page.locator('#view-lobby')).toHaveClass(/active/, { timeout: 15000 });
    await expect(host.locator('.slot.on')).toHaveCount(1, { timeout: 15000 });
    await expect(host.locator('.slot.on')).toContainText('QR TEAM');
    expect(p.page.errors).toEqual([]);
    expect(host.errors).toEqual([]);
  } finally {
    await p.ctx.close();
    await host.close();
  }
});

test('a phone with no room code finds the open big screen by itself', async ({ browser }) => {
  const host = await openHostLobby(browser);
  const room = await host.evaluate(() => window.__game.eventRoom);
  const p = await phone(browser, HOST + '/controller');
  try {
    await expect(p.page.locator('#join-status')).toContainText(`room ${room}`, { timeout: 10000 });
    await p.page.fill('#name-input', 'NO CODE');
    await p.page.click('#join-btn');
    await expect(p.page.locator('#view-lobby')).toHaveClass(/active/, { timeout: 15000 });
    await expect(host.locator('.slot.on')).toContainText('NO CODE', { timeout: 15000 });
    expect(await p.page.evaluate(() => window.__tkr.state.room)).toBe(room);
  } finally {
    await p.ctx.close();
    await host.close();
  }
});

test('a mistyped code is refused on the phone instead of joining an invisible room', async ({ browser }) => {
  const p = await phone(browser, HOST + '/controller?room=AB0D');
  try {
    // invalid ?room= shows code entry with an error, never joins blind
    await expect(p.page.locator('#room-step')).toBeVisible();
    await expect(p.page.locator('#room-status')).toContainText(/looks wrong|code/i);
    await p.page.fill('#room-input', 'AB0D');
    await p.page.click('#room-join-btn');
    await expect(p.page.locator('#room-status')).toContainText('never use 0, O, 1, I or L');
    expect(await p.page.evaluate(() => window.__tkr.state.room)).toBe(null);
  } finally {
    await p.ctx.close();
  }
});

test('a phone whose room has no big screen is told so', async ({ browser }) => {
  // a valid code nobody is hosting: the join works but the phone must say the screen is missing
  const p = await phone(browser, HOST + '/controller?room=ZZ9Z');
  try {
    await p.page.fill('#name-input', 'LONELY');
    await p.page.click('#join-btn');
    await expect(p.page.locator('#view-lobby')).toHaveClass(/active/, { timeout: 15000 });
    await expect(p.page.locator('#host-banner')).toBeVisible({ timeout: 8000 });
    await expect(p.page.locator('#host-banner')).toContainText('ZZ9Z');
  } finally {
    await p.ctx.close();
  }
});

test('room discovery stays off behind a public hostname', async ({ request }) => {
  const lan = await (await request.get(HOST + '/api/rooms')).json();
  expect(lan.discovery).toBe(true);
  const pub = await (await request.get(HOST + '/api/rooms', { headers: { Host: 'turbo-kart-rally.onrender.com' } })).json();
  expect(pub.discovery).toBe(false);
  expect(pub.rooms).toEqual([]);
});
